/**
 * FREAK סידור עבודה — service worker (same strategy as the shop's POS).
 *
 * The shell is cached, so the portal opens with the radio off and comes up at
 * once on a slow connection; the data itself always comes from the API.
 *
 * STRATEGY — two rules, and the split matters:
 *
 *   HTML        → NETWORK FIRST, 3.5 s fuse. If there is signal the newest copy
 *                 wins, always; the cache is the offline fallback. The fuse
 *                 exists because zombie wifi — connected, no internet — hangs a
 *                 fetch for 30 s+ before the OS gives up, which reads as "the
 *                 app won't open".
 *
 *   everything  → CACHE FIRST. app.js, the guide pages, the manifest and the
 *   else           icons change only at a release, and a release bumps CACHE:
 *                 the new worker re-downloads the whole shell and the old cache
 *                 is deleted on activate. That is why BUILD (app.js) and CACHE
 *                 (here) are bumped together — without a new CACHE name a phone
 *                 keeps serving its cached app.js.
 *
 * Requests to other origins (the Apps Script API) are never intercepted.
 */
const CACHE = 'freak-schedule-p15';

const SHELL = [
  './',
  './index.html',
  './app.js?v=p15',   // ?v= = BUILD: כתובת חדשה לכל גרסה (13/10)
  './quickstart.html',
  './guide.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // cache:'reload' forces past the HTTP cache. GitHub Pages serves assets
      // with a max-age, so a plain add() can install a copy that's already old.
      .then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

// Cache Storage is per ORIGIN, not per app: the shop's POS lives on the same origin (epic-pita.github.io/freak-pos/)
// and keeps its offline shell in 'freak-pos-…'. Until 13/10 this deleted every cache that was not ours, so each
// schedule release wiped the POS's offline copy on any phone that has both — measured in a clean browser context.
// Only our own old versions go.
const CACHE_PREFIX = 'freak-schedule-';
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Never touch the API. A stale shell is survivable; a stale answer about a
  // shift swap or a constraints form is not.
  if (url.origin !== self.location.origin) return;

  const isHTML = e.request.mode === 'navigate'
              || url.pathname.endsWith('.html')
              || url.pathname.endsWith('/');

  if (isHTML) {
    e.respondWith((async () => {
      // המפתח האישי מגיע בכתובת (?k=…): הניווט נשמר במטמון בלי מחרוזת החיפוש, כדי שהמפתח לא יישאר
      // ב-Cache Storage אחרי ש-app.js ניקה אותו משורת הכתובת (ביקורת ה-PWA, 09/10)
      const shellKey = new Request(url.origin + url.pathname);
      const fetched = fetch(e.request).then(res => {
        // Cache only clean, direct 200s. A captive portal answering 200 for
        // our URL, or a 404 from a broken deploy, must never overwrite the
        // known-good shell — offline would then boot into the portal page.
        if (res.ok && !res.redirected) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(shellKey, copy));
        }
        return res;
      });

      // Race the network against a short fuse. If the fuse wins, serve cache;
      // the fetch keeps running and still refreshes the cache for next open.
      const winner = await Promise.race([
        fetched.catch(() => null),
        new Promise(r => setTimeout(() => r(null), 3500))
      ]);
      if (winner) return winner;

      const cached = await caches.match(shellKey) || await caches.match('./index.html');
      // Nothing cached (first-ever visit on a slow link): the network, however
      // long it takes, is all there is.
      return cached || fetched;
    })());
    return;
  }

  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }))
  );
});
