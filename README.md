# FREAK סידור עבודה — פורטל העובדים (PWA)

The staff portal of the work-schedule sheet, as a static app the team installs on their phones. Same build as the shop's POS: a page, a service worker, an Apps Script backend.

| Part | Where | Notes |
|---|---|---|
| Portal (PWA) | `index.html` (page + CSS), `app.js` (client), `sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png` → GitHub Pages | Built from `main` of the public repo. **A push to `main` is a release to the team's phones.** Bump `BUILD` in `app.js` and `CACHE` in `sw.js` together: `index.html` is network-first, everything else (including `app.js`) is cache-first, so the new cache name is what delivers a new `app.js`. |
| Staff guide | `quickstart.html` (one page) + `guide.html` (full, with the managers' part at the end) | Linked from the login card and from the bottom of the main screen. Rendered once from `staffGuideHtml_` in `17_Guide.gs` (2026-10-09), with the links pointed at these local pages and a "חזרה לפורטל" link at the top; edited here from now on. |
| Backend | The Apps Script project of the work-schedule sheet (`06_StaffApp.gs` and friends — not in this repo) | The live address is a **versioned deployment**: `API_URL` at the top of `app.js`. After `clasp push`, redeploy that deployment (Deploy → Manage deployments → New version); HEAD alone changes nothing the phones see. |
| Tests | in the private parent folder: `tools/test_portal_client.js` (the client against a fake DOM and a fake transport), `tools/check_dialogs.js` blocks 4 and 7, and `tools/mutate_gate.js` (mutations on `app.js`); `pwa/tools/smoke.py` (git-ignored) drives the folder in a browser against a mocked API | The client logic is the old portal script as it was. `quickstart.html` and `guide.html` were rendered once from `17_Guide.gs` on 2026-10-09 and are edited here from now on. |

The sheet's address and the script's id stay out of this repo — it is public. The deployment URL in `app.js` is public by design.

## Who enters

Everyone enters through a **personal link** `…/?k=<key>` the manager sends in private. `app.js` stores the key in `localStorage` (`freak_schedule_key`), removes it from the address bar (`history.replaceState`), and sends it as `k` on every request. Without a key the app still loads `init` and shows what the portal always showed in that case: the name list (before personal links existed) or the links-only notice. A key that the server rejects shows "הקישור הזה אינו תקף" and is dropped from the device. **iPhone:** an app added to the home screen opens with its own storage, so the first open there shows the notice with a paste field — pasting the personal link once stores the key in the app. "התנתק מהמכשיר הזה" clears the key (shared phones).

## API (Apps Script, JSON)

Every reply is the object the old Apps Script bridge (`script.run`) success handler received (`success` + the data) plus `ms` (server time). Errors come as `{success:false, error}`. The client never throws on transport: a timeout or a network error becomes `{success:false, transport:true, error:<Hebrew>}` and the screen shows the same text it showed before.

`GET API_URL?action=<action>&k=<key>` — fuse 12 s, then two more tries at 20 s and 30 s on a timeout or a network error (reads are repeat-safe):

| action | returns |
|---|---|
| `init` | what the server used to embed in the page: `employees`, `days`, `shiftTemplates`, `availability`, `karmaBoost`, `managers`, `openSwapsCount`, `nextSundayStr`, `me` (when `k` is valid), `linksOnly` |
| `myShifts` | the person's shifts this week (`shifts`, `karma`, `ambiguousCount`) |
| `myFixed` | the person's fixed constraints (`entries`, `note`, `unreadable`) (2026-10-10) |
| `weekBoard` | the whole week by day (`days[]`) |
| `mySkills` | skills and training requests (`skills`, `qualifiedCount`, `totalCount`) |
| `openSwaps` | open swap requests (`swaps[]`) |

`POST API_URL`, body `text/plain;charset=utf-8` holding JSON `{action, k, …}` — fuse 30 s, **no automatic retry** (a write that timed out may have landed; the app tells the person to check before sending again):

| action | body fields |
|---|---|
| `constraints` | `payload` = `{empCode, weekStartDate, targetShifts, entries[], generalNotes}` (the constraints form as before) |
| `fixedConstraints` | `entries[]` = `{day, shiftName, status}` (the fixed, every-week constraints), `note` — replaces the person's saved set (2026-10-10) |
| `requestTraining` | `skillId`, `wantLevel`, `reason` |
| `requestSwap` | `shiftDetails` (the shift object from `myShifts`), `reason` |
| `takeSwap` | `swapId` |

`text/plain` on purpose: `application/json` triggers a CORS preflight (OPTIONS) that Apps Script cannot answer.

## History

- 2026-10-10 p2: fixed (every-week) constraints on the constraints tab — loaded at login, pre-fill untouched cells of the weekly form, saved with `fixedConstraints`, cleared at logout.
- 2026-10-09 p1: portal moved off Apps Script HtmlService to this PWA. The client logic is the script block of `generateStaffAppHtml_` as it was; only the transport (`api()` instead of the `script.run` bridge) and the start-up (data from `init` instead of embedded in the page) changed.
