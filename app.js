/**
 * FREAK TLV — פורטל העובדים לסידור העבודה · PWA
 *
 * הקוד של הלקוח הוא זה שישב בבלוק הסקריפט של generateStaffAppHtml_ (06_StaffApp.gs),
 * ככתבו, עם שני שינויים בלבד:
 *   1. הגשר של Apps Script (script.run) → api(action, params, {post}) מול פריסה שמחזירה JSON.
 *   2. INITIAL_DATA אינו מוטבע בדף אלא נטען מ-api('init') ב-boot (סוף הקובץ).
 * הכניסה היא בקישור אישי ?k=<מפתח>; המפתח נשמר ב-localStorage ויורד מהכתובת.
 */

// ראשון בבלוק: אם הגענו לכאן, הסקריפט נטען ורץ. אחרת האזהרה נשארת על המסך.
(function () { var w = document.getElementById('jsNotLoaded'); if (w) w.style.display = 'none'; })();

/* ==================================================================
   CONFIG — the two lines you edit at a release (BUILD together with CACHE in sw.js)
   ================================================================== */
const API_URL = 'https://script.google.com/macros/s/AKfycbyBpSBlk-Z8R3cU4g9ADhW1JxRz0RG1c6CqEiOBTVD0_Ud27UWEE3s9tEoDpmeFMJznuw/exec';
const BUILD = 'p2';

/* ==================================================================
   The key (personal link)
   ?k=… on the address → kept in localStorage, then removed from the address bar
   (history.replaceState) so a screenshot or a shared tab does not leak it.
   Without ?k the stored key is used; without any key, init comes back with no "me"
   and the page shows what it always showed in that case.
   ================================================================== */
const KEY_STORE = 'freak_schedule_key';
var KEY = '';
(function readKey() {
  try {
    var fromUrl = new URLSearchParams(window.location.search).get('k');
    if (fromUrl) {
      KEY = fromUrl;
      try { window.localStorage.setItem(KEY_STORE, fromUrl); } catch (e) {}
      try { window.history.replaceState(null, '', './'); } catch (e) {}
    } else {
      try { KEY = window.localStorage.getItem(KEY_STORE) || ''; } catch (e) {}
    }
  } catch (e) {}
})();

/* ==================================================================
   Transport (same shape as the POS)
   POST goes out as text/plain deliberately: application/json triggers a CORS
   preflight OPTIONS, which Apps Script cannot answer. The body is still JSON.
   Every request carries a fuse (AbortController): zombie wifi — connected, no
   internet — hangs a fetch for 30-60 s before the OS gives up.
   ================================================================== */
const MSG_TIMEOUT = 'לא התקבלה תשובה מהשרת. אם שלחת בקשה, לבדוק בעוד רגע אם היא נרשמה לפני שליחה חוזרת.';
const MSG_OFFLINE = 'אין חיבור לשרת: ';

function fetchT(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
}

// The identity sent as k: the personal key, or — when someone entered from the
// name list (no personal link) — the employee id. Both are exactly what the old
// client passed to the server as empCode (AppState.currentUserId).
function identityKey() {
  return (typeof AppState !== 'undefined' && AppState && AppState.currentUserId) || KEY || '';
}

function queryString(params) {
  let out = '';
  Object.keys(params || {}).forEach(function (name) {
    const v = params[name];
    if (v === undefined || v === null) return;
    out += '&' + encodeURIComponent(name) + '=' +
      encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v));
  });
  return out;
}

// GET. Fuse 12 s, then two more tries at 20 s and 30 s on a timeout or a network
// error (Apps Script cold starts in 1-5 s; measured on the POS: 20-110 s now and then).
// Reads are repeat-safe, so retrying is free.
async function apiGet(action, params, ms) {
  const fuses = [ms || 12000, 20000, 30000];
  const url = API_URL + '?action=' + encodeURIComponent(action) +
    '&k=' + encodeURIComponent(identityKey()) + queryString(params);
  for (let i = 0; i < fuses.length; i++) {
    try {
      const res = await fetchT(url, {}, fuses[i]);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      const retriable = (e && e.name === 'AbortError') || (e instanceof TypeError);
      if (!retriable || i === fuses.length - 1) throw e;
    }
  }
}

// POST. Fuse 30 s, NO automatic retry: a write that timed out may well have
// landed, and the message tells the person to check before sending again.
async function apiPost(action, body, ms) {
  const res = await fetchT(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, k: identityKey(), ...body })
  }, ms || 30000);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// Always resolves. Success → the server's JSON as is (the same object the old
// Apps Script bridge's success handler received, plus ms). Any failure →
// { success:false, transport:true, error:<Hebrew> } so a call site can keep the
// text its old withFailureHandler showed.
function api(action, params, opts) {
  const p = (opts && opts.post) ? apiPost(action, params || {}, opts.ms)
                                : apiGet(action, params || {}, opts && opts.ms);
  return p.then(function (res) { return res; }, function (e) {
    const timeout = !!(e && e.name === 'AbortError');
    return {
      success: false,
      transport: true,
      error: timeout ? MSG_TIMEOUT : (MSG_OFFLINE + ((e && e.message) || String(e)))
    };
  });
}

/* ==================================================================
   The portal client — from here on the script block of generateStaffAppHtml_,
   unchanged except the 8 call sites (api instead of the script.run bridge) and
   INITIAL_DATA, which boot() fills.
   ================================================================== */
// נתוני הפתיחה. בגרסת Apps Script השרת הטביע אותם בתוך הדף; כאן הם מגיעים
// מ-api('init') בעת הטעינה (ראה boot בסוף הקובץ) וממלאים את אותו המשתנה.
var INITIAL_DATA = {};

var SafeStorage = {
  mem: {},
  set: function(k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch(e) { this.mem[k] = v; } },
  get: function(k) { try { var val = window.localStorage.getItem(k); return val ? JSON.parse(val) : (this.mem[k] || null); } catch(e) { return this.mem[k] || null; } },
  remove: function(k) { try { window.localStorage.removeItem(k); } catch(e) {} delete this.mem[k]; }
};

var AppState = {
  currentUser: null,
  currentUserId: null,
  isManager: false,
  openSwapsCount: INITIAL_DATA.openSwapsCount || 0,
  nextSundayStr: INITIAL_DATA.nextSundayStr || ''
};

var DAYS = INITIAL_DATA.days || [];
var SHIFT_TEMPLATES = INITIAL_DATA.shiftTemplates || [];
var STATUS_STATES = INITIAL_DATA.availability || [];
var KARMA_BOOST = INITIAL_DATA.karmaBoost || 0;

// ברירת המחדל היא "טרם נבחר" ולא "רוצה ויכול": עובד שלוחץ שלח בלי לגעת
// בכלום היה מצהיר קודם על זמינות מלאה ל-18 משמרות.
var UNSET = -1;

function shiftLabel(tpl) { return tpl.label + ' (' + tpl.from + '-' + tpl.to + ')'; }
function isFriday(day) { return day === 'שישי'; }
function shiftsForDay(day) {
  return SHIFT_TEMPLATES.filter(function(t) { return !(isFriday(day) && t.friClosed); });
}

// מבנה נתוני זמינות מקומי
var matrixData = {};
// אילוצים קבועים (10/10): אותה מטריצה, בלוק משלה; הכפתורים נשמרים כדי שהקבוע ימלא מראש את השבועי
var fixedData = {};
var matrixPills = {};
var fixedPills = {};
var fixedCarry = [];   // אילוצים קבועים שהשרת החזיר והטופס לא מציג (יום או משמרת שאינם בו) — חוזרים בשמירה כמו שהם
var loginGen = 0;      // עולה בכל כניסה ויציאה: תשובה מאוחרת של השרת אחרי "התנתק" לא נכתבת לטופס (ביקורת 10/10)

function showToast(msg, type) {
  var t = document.getElementById('toastNotification');
  t.textContent = msg;
  t.style.background = (type === 'error' ? 'var(--danger)' : 'var(--success)');
  t.style.display = 'block';
  setTimeout(function() { t.style.display = 'none'; }, (msg && String(msg).length > 60) ? 9000 : 4500);
}

var modalCallback = null;
function openAppModal(title, desc, showInput, confirmText, callback) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalDesc').textContent = desc;
  var inputContainer = document.getElementById('modalInputContainer');
  var inputField = document.getElementById('modalInput');
  
  if (showInput) { inputContainer.style.display = 'block'; inputField.value = ''; } 
  else { inputContainer.style.display = 'none'; }

  var confirmBtn = document.getElementById('modalBtnConfirm');
  confirmBtn.textContent = confirmText || 'אישור';
  modalCallback = callback;

  confirmBtn.onclick = function() {
    var val = showInput ? inputField.value : true;
    // חובה לתפוס את הקולבק לפני הסגירה: closeAppModal מאפס את
    // modalCallback, והשורה הבאה בדקה את אותו משתנה שזה עתה אופס.
    // התוצאה: כל לחיצת אישור בפורטל הייתה no-op — בקשת החלפה ולקיחת
    // משמרת לא עשו דבר, בלי שגיאה ובלי הודעה. מאז הגרסה הראשונה.
    var cb = modalCallback;
    closeAppModal();
    if (cb) cb(val);
  };

  document.getElementById('portalModal').style.display = 'flex';
}

function closeAppModal() {
  document.getElementById('portalModal').style.display = 'none';
  modalCallback = null;
}

// בריחה מ-HTML. כל ערך שמגיע מהגיליון או מעובד אחר עובר כאן לפני
// שהוא נכנס ל-innerHTML: שמות עובדים, סיבות החלפה, כותרות אירועים
// מיומני Google, והערות שהוקלדו בפורטל האנונימי.
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function empById(id) {
  var list = INITIAL_DATA.employees || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

function doLogin() {
  var select = document.getElementById('userSelect');
  var empId = select.value;
  var valMsg = document.getElementById('loginValidationMsg');

  if (!empId || !empById(empId)) {
    valMsg.style.display = 'block';
    select.style.borderColor = 'var(--danger)';
    return;
  }

  valMsg.style.display = 'none';
  select.style.borderColor = 'var(--border)';
  SafeStorage.set('freak_emp_id', empId);
  performLogin(empId);
}

function performLogin(empId, me) {
  // קישור אישי: המזהה לשרת הוא המפתח, והשרת מוצא ממנו את העובד (06/10)
  var emp = me ? { id: me.key, name: me.name } : empById(empId);
  if (!emp) return;
  loginGen++;
  var btnOut = document.getElementById('btnLogout');
  // גם בקישור אישי יש יציאה: טלפון משותף בחנות — הקישור האחרון שנפתח היה נשאר מחובר לכולם (ביקורת ה-PWA 10)
  if (btnOut) { btnOut.style.display = ''; btnOut.textContent = me ? 'התנתק מהמכשיר הזה' : 'החלף משתמש / התנתק'; }

  var userName = emp.name;
  AppState.currentUserId = emp.id;
  AppState.currentUser = userName;
  AppState.isManager = (INITIAL_DATA.managers && INITIAL_DATA.managers.indexOf(userName) !== -1);

  var pill = document.getElementById('userHeaderPill');
  pill.textContent = (AppState.isManager ? '👑 ' : '') + userName;
  pill.style.display = 'block';

  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('mainScreen').style.display = 'block';

  // כותרת תאריך לשבוע הבא באילוצים
  if (AppState.nextSundayStr) {
    document.getElementById('weekDatesSubtitle').textContent = 'שבוע החל מיום ראשון: ' + AppState.nextSundayStr;
  }

  // איפוס כל מה ששייך למשתמש הקודם.
  //
  // בחנות מחליפים מכשיר. עד כאן doLogout ניקה רק את ה-AppState ואת
  // המפתח ב-localStorage, ולא נגע בשלושת שדות הטופס: עובד שנכנס אחרי
  // מישהו אחר שלח את **ההערות, בקשת ההדרכה והיעד השבועי של הקודם**
  // אל תוך הגיליון, בלי שום סימן על המסך.
  // האיפוס כאן ולא ב-doLogout, כי הוא מכסה גם רענון עמוד עם מזהה שמור.
  var tIn = document.getElementById('targetShiftsInput');
  if (tIn) tIn.value = '3';
  var cIn = document.getElementById('constraintComments');
  if (cIn) cIn.value = '';
  var fIn = document.getElementById('fixedNote');
  if (fIn) fIn.value = '';
  setFixedStatusText('');

  ['myShiftsContainer', 'weekBoardContainer', 'openSwapsContainer',
   'skillsContainer', 'fixedMatrixContainer'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });
  var sPill = document.getElementById('skillsPill');
  if (sPill) sPill.style.display = 'none';

  // בניית מטריצת אילוצים
  renderConstraintsMatrix();
  // האילוצים הקבועים של העובד הזה — ממלאים מראש את השבועי (10/10)
  loadMyFixed();

  // חזרה לטאב הראשון. בלי זה המסך חוזר עם הטאב של הקודם פתוח ועם
  // ה-DOM שלו בתוכו — כולל שורות המסומנות "המשמרות שלך" בלוח השבועי,
  // שהן של המשתמש הקודם. אין טעינה מחדש, אין שגיאה, ונראה תקין לגמרי.
  switchTab('tabMyShifts');

  updateSwapsBadge();
  loadMyShifts();
  loadOpenSwaps();
}

function doLogout() {
  // בקישור אישי: המפתח יורד מהמכשיר, והמסך חוזר להודעת הקישור עם הדבקה (טלפון משותף)
  var hadKey = !!KEY;
  try { window.localStorage.removeItem(KEY_STORE); } catch (e) {}
  KEY = '';
  SafeStorage.remove('freak_emp_id');
  SafeStorage.remove('freak_user');
  loginGen++;        // תשובה מאוחרת של השרת מהכניסה הקודמת לא נכתבת לטופס (ביקורת 10/10)
  fixedCarry = [];
  AppState.currentUser = null;
  AppState.currentUserId = null;
  AppState.isManager = false;

  // ניקוי ה-DOM גם ביציאה, ולא רק בכניסה: בין השתיים יש חלון שבו מסך
  // הכניסה מוצג אבל התוכן של הקודם עדיין יושב מאחוריו.
  ['myShiftsContainer', 'weekBoardContainer', 'openSwapsContainer',
   'skillsContainer', 'fixedMatrixContainer'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });
  var tOut = document.getElementById('targetShiftsInput');
  if (tOut) tOut.value = '3';
  var cOut = document.getElementById('constraintComments');
  if (cOut) cOut.value = '';
  var fOut = document.getElementById('fixedNote');
  if (fOut) fOut.value = '';
  setFixedStatusText('');

  document.getElementById('userHeaderPill').style.display = 'none';
  document.getElementById('mainScreen').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'block';
  document.getElementById('userSelect').value = '';
  if (hadKey || INITIAL_DATA.linksOnly) showLinksOnlyNotice(false);
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(function(el) { el.style.display = 'none'; });
  document.querySelectorAll('.nav-item').forEach(function(el) { el.classList.remove('active'); });

  document.getElementById(tabId).style.display = 'block';
  var activeNav = document.querySelector('[data-tab="' + tabId + '"]');
  if (activeNav) activeNav.classList.add('active');

  if (tabId === 'tabSwaps') loadOpenSwaps();
  if (tabId === 'tabWeek') loadWeekBoard();
  if (tabId === 'tabSkills') loadMySkills();
}

function updateSwapsBadge() {
  var badge = document.getElementById('swapsBadge');
  if (AppState.openSwapsCount > 0) {
    badge.textContent = AppState.openSwapsCount;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

/* טעינת המשמרות */
function loadMyShifts() {
  var container = document.getElementById('myShiftsContainer');
  container.innerHTML = '<div class="loader">טוען משמרות עדכניות...</div>';

  api('myShifts')
    .then(function(res) {
      // כשל תקשורת (היה withFailureHandler): api() אינו נופל, הוא מחזיר transport:true
      if (res && res.success === false && res.transport) {
        container.innerHTML = '<div class="empty-state">כשל בתקשורת מול השרת</div>';
        return;
      }
      if (!res || !res.success) {
        container.innerHTML = '<div class="empty-state">שגיאה בטעינת משמרות: ' + esc(res ? res.error : '') + '</div>';
        return;
      }

      var karmaPill = document.getElementById('karmaPill');
      karmaPill.textContent = '💎 ' + (res.karma || 0) + ' קארמה';
      karmaPill.style.display = 'inline-block';

      if (!res.shifts || res.shifts.length === 0) {
        // אזהרת התאים הדו-משמעיים ישבה **מתחת** ל-return הזה, ולכן היא
        // לא הופיעה בדיוק במקרה שבו היא היחידה שיש: עובד שכל התאים שלו
        // בלוח מכילים שם פרטי בלבד קיבל "שמך אינו משובץ", לא הגיע
        // למשמרת, והעקבה היחידה הייתה שורת לוג שאיש לא קורא.
        if (res.ambiguousCount > 0) {
          container.innerHTML =
            '<div class="card" style="border-color:#78350f">' +
              '<div class="card-title" style="margin-bottom:6px;">לא הצלחנו לשייך אליך משמרות</div>' +
              '<div class="card-desc">' + res.ambiguousCount + ' תאים בלוח מכילים שם פרטי בלבד, או שם ששייך ליותר מעובד אחד, ' +
              'ולכן לא שויכו אליך בוודאות. <b>אל תניח שאינך משובץ</b> — פנה לכריס לבדיקה.</div>' +
            '</div>';
        } else {
          container.innerHTML =
            '<div class="card">' +
              '<div class="card-title" style="margin-bottom:6px;">אין משמרות רשומות עבורך השבוע</div>' +
              '<div class="card-desc">שמך אינו משובץ כרגע בתאי הסידור הפעילים, או שטרם הופעל סנכרון שבועי.</div>' +
            '</div>';
        }
        return;
      }

      // קיבוץ לפי יום: כל המשמרות של ראשון מופיעות תחת "ראשון".
      // השרת מחזיר אותן כבר ממוינות לפי סדר העמודות והשורות בלוח.
      container.innerHTML = '';
      var order = [];
      var byDay = {};
      res.shifts.forEach(function(sh) {
        if (!byDay[sh.day]) { byDay[sh.day] = []; order.push(sh.day); }
        byDay[sh.day].push(sh);
      });

      order.forEach(function(day) {
        var list = byDay[day];
        var box = document.createElement('div');
        box.className = 'day-group';
        box.innerHTML = '<div class="day-head"><span>' + esc(day) + '</span>' +
                        '<span class="cnt">' + list.length +
                        (list.length === 1 ? ' משמרת' : ' משמרות') + '</span></div>';

        list.forEach(function(sh) {
          var card = document.createElement('div');
          card.className = 'card';
          card.innerHTML =
            '<div class="card-header">' +
              '<span class="card-title">' + esc(sh.shiftType) + '</span>' +
            '</div>' +
            '<div class="card-desc">' + esc(sh.details) + '</div>';

          if (sh.skillGapText) {
            // חוסר כישור אינו מסתיר את המשמרת ואינו מבטל אותה. העובד
            // רואה מה חסר, ומבקש הכשרה מכאן — אותו מסלול כמו בטאב הכישורים.
            var gapRow = document.createElement('div');
            gapRow.className = 'card-desc skill-gap';
            gapRow.style.cssText = 'margin-top:8px;color:#8A6D00';
            gapRow.textContent = sh.skillGapText;
            card.appendChild(gapRow);
            (sh.skillGaps || []).forEach(function(gap) {
              if (gap.trainingStatus) {
                var st = document.createElement('div');
                st.className = 'skill-gap-status';
                st.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:4px';
                st.textContent = gap.name + ' - בקשת הכשרה: ' + gap.trainingStatus;
                card.appendChild(st);
                return;
              }
              var btnTrain = document.createElement('button');
              btnTrain.type = 'button';
              btnTrain.className = 'btn btn-sm btn-secondary btn-train';
              btnTrain.style.marginTop = '8px';
              btnTrain.textContent = 'בקש הכשרה: ' + gap.name + ' 🎓';
              btnTrain.onclick = function() { triggerTrainingRequest(gap); };
              card.appendChild(btnTrain);
            });
          }

          if (sh.swappable) {
            var btnSwap = document.createElement('button');
            btnSwap.type = 'button';
            btnSwap.className = 'btn btn-sm btn-secondary';
            btnSwap.style.marginTop = '10px';
            btnSwap.textContent = 'בקש החלפה למשמרת זו 🔄';
            btnSwap.onclick = function() { triggerShiftSwapPrompt(sh); };
            card.appendChild(btnSwap);
          } else if (sh.kind === 'chug') {
            // כפתור שמחזיר שגיאה בכל לחיצה גרוע מכפתור שאינו קיים
            var noteC = document.createElement('div');
            noteC.style.cssText = 'margin-top:8px;font-size:12px;color:var(--muted)';
            noteC.textContent = 'חוג קבוע — החלפה מתואמת מול מערך החוגים.';
            card.appendChild(noteC);
          }
          box.appendChild(card);
        });

        container.appendChild(box);
      });

      if (res.ambiguousCount > 0) {
        var note = document.createElement('div');
        note.className = 'card';
        note.style.borderColor = '#78350f';
        note.innerHTML = '<div class="card-desc">⚠️ ' + res.ambiguousCount +
          ' תאים בלוח מכילים שם פרטי בלבד, או שם ששייך ליותר מעובד אחד, ולכן לא שויכו אליך בוודאות. ' +
          'אם חסרה לך משמרת — פנה לכריס.</div>';
        container.appendChild(note);
      }
    });
}

/* הלוח השבועי המלא — מסודר לפי ימים, לא כטבלה בת 7 עמודות */
function loadWeekBoard() {
  var container = document.getElementById('weekBoardContainer');
  container.innerHTML = '<div class="loader">טוען לוח...</div>';

  api('weekBoard')
    .then(function(res) {
      // כשל תקשורת (היה withFailureHandler): api() אינו נופל, הוא מחזיר transport:true
      if (res && res.success === false && res.transport) {
        container.innerHTML = '<div class="empty-state">כשל בתקשורת מול השרת</div>';
        return;
      }
      if (!res || !res.success) {
        container.innerHTML = '<div class="empty-state">שגיאה: ' + esc(res ? res.error : '') + '</div>';
        return;
      }
      if (!res.days || res.days.length === 0) {
        container.innerHTML = '<div class="empty-state">הלוח השבועי טרם נבנה.</div>';
        return;
      }

      container.innerHTML = '';
      res.days.forEach(function(day) {
        var box = document.createElement('div');
        box.className = 'day-group';

        var head = '<div class="day-head"><span>' + esc(day.header) + '</span>';
        if (day.closed) {
          head += '<span class="cnt day-closed">סגור</span>';
        } else {
          head += '<span class="cnt">' + day.entries.length + ' פעילויות</span>';
        }
        head += '</div>';
        box.innerHTML = head;

        if (day.entries.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'wk-row';
          empty.innerHTML = '<span class="wk-lbl">אין פעילות רשומה</span>';
          box.appendChild(empty);
        }

        day.entries.forEach(function(e) {
          var row = document.createElement('div');
          row.className = 'wk-row' + (e.isMine ? ' mine' : '') + (e.unstaffed ? ' open' : '');
          row.innerHTML =
            '<span class="wk-lbl">' + esc(e.label) + '</span>' +
            '<span class="wk-val">' + esc(e.value) + '</span>';
          box.appendChild(row);
        });

        container.appendChild(box);
      });
    });
}

/* בניית מטריצת זמינות (4 מצבים) — אותו בלוק לטופס השבועי ולאילוצים הקבועים (10/10) */
function renderMatrixInto(containerId, data, pills, cycleFn) {
  var container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  Object.keys(data).forEach(function (k) { delete data[k]; });
  Object.keys(pills).forEach(function (k) { delete pills[k]; });

  DAYS.forEach(function(day) {
    data[day] = {};
    pills[day] = {};
    var dayBox = document.createElement('div');
    dayBox.className = 'day-block';
    dayBox.innerHTML = '<div class="day-title"><span>יום ' + esc(day) + '</span></div>';

    shiftsForDay(day).forEach(function(tpl) {
      data[day][tpl.key] = UNSET;

      var row = document.createElement('div');
      row.className = 'shift-row';

      var title = document.createElement('div');
      title.className = 'shift-name';
      title.textContent = shiftLabel(tpl);

      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'status-pill';
      pill.textContent = 'טרם נבחר — הקש';
      pill.style.opacity = '0.55';
      pills[day][tpl.key] = pill;

      pill.onclick = (function(d, k, p) {
        return function() { cycleFn(d, k, p); };
      })(day, tpl.key, pill);

      row.appendChild(title);
      row.appendChild(pill);
      dayBox.appendChild(row);
    });

    container.appendChild(dayBox);
  });
}

function renderConstraintsMatrix() { renderMatrixInto('constraintsMatrixContainer', matrixData, matrixPills, cycleShiftStatus); }
function renderFixedMatrix() { renderMatrixInto('fixedMatrixContainer', fixedData, fixedPills, cycleFixedStatus); }

function setPillState(pill, idx) {
  if (!pill) return;
  var st = STATUS_STATES[idx];
  if (!st) return;
  pill.className = 'status-pill ' + st.cls;
  pill.textContent = st.text;
  pill.style.opacity = '1';
}

function cycleShiftStatus(day, tplKey, pillElement) {
  var curIdx = matrixData[day][tplKey];
  var nextIdx = (curIdx === UNSET) ? 0 : (curIdx + 1) % STATUS_STATES.length;
  matrixData[day][tplKey] = nextIdx;
  setPillState(pillElement, nextIdx);
}

function cycleFixedStatus(day, tplKey, pillElement) {
  var curIdx = fixedData[day][tplKey];
  var nextIdx = (curIdx === UNSET) ? 0 : (curIdx + 1) % STATUS_STATES.length;
  fixedData[day][tplKey] = nextIdx;
  setPillState(pillElement, nextIdx);
}

/* אילוצים קבועים (10/10): נשמרים בטאב עובדים דרך השרת (myFixed / fixedConstraints), וממלאים מראש את השבועי */
function templateKeyForLabel(label) {
  var list = (INITIAL_DATA && INITIAL_DATA.shiftTemplates) || [];
  for (var i = 0; i < list.length; i++) if (list[i].label === label) return list[i].key;
  return '';
}
function statusIndexOf(statusKey) {
  for (var i = 0; i < STATUS_STATES.length; i++) if (STATUS_STATES[i].key === statusKey) return i;
  return -1;
}
// הקבוע ממלא רק משבצת שהעובד עוד לא נגע בה השבוע — מה שסומן ידנית נשאר
function applyFixedToWeekly() {
  DAYS.forEach(function (day) {
    if (!fixedData[day] || !matrixData[day]) return;
    Object.keys(fixedData[day]).forEach(function (key) {
      var idx = fixedData[day][key];
      if (idx === UNSET || !(key in matrixData[day]) || matrixData[day][key] !== UNSET) return;
      matrixData[day][key] = idx;
      setPillState(matrixPills[day] && matrixPills[day][key], idx);
    });
  });
}
function setFixedStatusText(text) {
  var el = document.getElementById('fixedStatus');
  if (el) el.textContent = text || '';
}
function loadMyFixed() {
  renderFixedMatrix();
  fixedCarry = [];
  var noteEl = document.getElementById('fixedNote');
  if (noteEl) noteEl.value = '';
  setFixedStatusText('טוען אילוצים קבועים...');
  var gen = loginGen;
  api('myFixed')
    .then(function (res) {
      if (gen !== loginGen) return;   // בינתיים יצאו (טלפון משותף) — לא כותבים את ההערה של הקודם לטופס
      if (!res || !res.success) { setFixedStatusText('האילוצים הקבועים לא נטענו: ' + (res && res.error ? res.error : '')); return; }
      (res.entries || []).forEach(function (e) {
        var key = templateKeyForLabel(e.shiftName), idx = statusIndexOf(e.status);
        if (!fixedData[e.day] || !(key in fixedData[e.day]) || idx < 0) { fixedCarry.push(e); return; }
        fixedData[e.day][key] = idx;
        setPillState(fixedPills[e.day] && fixedPills[e.day][key], idx);
      });
      if (noteEl) noteEl.value = res.note || '';
      applyFixedToWeekly();
      var n = (res.entries || []).length, hidden = fixedCarry.length + (res.unreadable || 0);
      setFixedStatusText((n ? 'יש לך ' + n + ' אילוצים קבועים — הם מולאו מראש בטופס למעלה.' : 'אין אילוצים קבועים שמורים.') +
        (hidden ? ' ' + hidden + ' שורות שאינן בטופס נשמרות כמו שהן.' : ''));
    });
}
function doSaveFixed() {
  var entries = [];
  DAYS.forEach(function (day) {
    shiftsForDay(day).forEach(function (tpl) {
      var idx = fixedData[day] ? fixedData[day][tpl.key] : UNSET;
      if (idx === UNSET || idx === undefined) return;
      entries.push({ day: day, shiftName: tpl.label, status: STATUS_STATES[idx].key });
    });
  });
  entries = entries.concat(fixedCarry);   // מה שהטופס לא מציג חוזר כמו שהוא — שמירה אינה מוחקת אותו
  var noteEl = document.getElementById('fixedNote');
  var btn = document.getElementById('btnSaveFixed');
  if (btn) btn.disabled = true;
  api('fixedConstraints', { entries: entries, note: noteEl ? noteEl.value : '' }, { post: true })
    .then(function (res) {
      if (btn) btn.disabled = false;
      if (res && res.success) {
        showToast('האילוצים הקבועים נשמרו (' + res.count + ') ✓', 'success');
        setFixedStatusText(res.count ? 'יש לך ' + res.count + ' אילוצים קבועים.' : 'אין אילוצים קבועים שמורים.');
        applyFixedToWeekly();
      } else {
        showToast('האילוצים הקבועים לא נשמרו: ' + (res ? res.error : ''), 'error');
      }
    });
}

function doSubmitConstraintsV2() {
  var targetShifts = document.getElementById('targetShiftsInput').value;
  var comments = document.getElementById('constraintComments').value;

  // רק משמרות שהעובד נגע בהן נשלחות. משמרת שלא נבחרה = לא הוגשה,
  // וזה שונה מ"רוצה ויכול".
  var entries = [];
  var untouched = 0;
  DAYS.forEach(function(day) {
    shiftsForDay(day).forEach(function(tpl) {
      var stateIdx = matrixData[day][tpl.key];
      if (stateIdx === UNSET) { untouched++; return; }
      entries.push({
        day: day,
        templateKey: tpl.key,
        shiftName: tpl.label,
        status: STATUS_STATES[stateIdx].key
      });
    });
  });

  if (entries.length === 0) {
    showToast('לא סימנת אף משמרת. הקש על הכפתור שליד כל משמרת כדי לבחור זמינות.', 'error');
    return;
  }

  var btn = document.getElementById('btnSubmitConstraints');
  btn.disabled = true;
  btn.textContent = 'שולח 10 עמודות לגיליון...';

  var payload = {
    empCode: AppState.currentUserId,
    weekStartDate: AppState.nextSundayStr,
    targetShifts: Number(targetShifts),
    entries: entries,
    generalNotes: comments
  };

  api('constraints', { payload: payload }, { post: true })
    .then(function(res) {
      // כשל תקשורת (היה withFailureHandler): api() אינו נופל, הוא מחזיר transport:true
      if (res && res.success === false && res.transport) {
        btn.disabled = false;
        btn.textContent = 'שלח אילוצים למערכת (10 עמודות)';
        showToast('כשל תקשורת מול הגיליון. ' + res.error, 'error');
        return;
      }
      btn.disabled = false;
      btn.textContent = 'שלח אילוצים למערכת (10 עמודות)';
      if (res && res.success) {
        showToast('נקלטו ' + res.count + ' משמרות' +
          (untouched ? ' (' + untouched + ' לא סומנו)' : '') + ' ✓', 'success');
      } else {
        showToast('שגיאה בשמירה: ' + (res ? res.error : ''), 'error');
      }
    });
}

/* הכישורים שלי */
function loadMySkills() {
  var container = document.getElementById('skillsContainer');
  container.innerHTML = '<div class="loader">טוען כישורים...</div>';

  api('mySkills')
    .then(function(res) {
      // כשל תקשורת (היה withFailureHandler): api() אינו נופל, הוא מחזיר transport:true
      if (res && res.success === false && res.transport) {
        container.innerHTML = '<div class="empty-state">כשל בתקשורת מול השרת</div>';
        return;
      }
      if (!res || !res.success) {
        container.innerHTML = '<div class="empty-state">' +
          esc(res ? res.error : 'שגיאה בטעינת כישורים') + '</div>';
        return;
      }

      var pill = document.getElementById('skillsPill');
      pill.textContent = '🎓 ' + res.qualifiedCount + ' מתוך ' + res.totalCount;
      pill.style.display = 'inline-block';

      container.innerHTML = '';
      var byCat = {};
      var catOrder = [];
      res.skills.forEach(function(sk) {
        if (!byCat[sk.category]) { byCat[sk.category] = []; catOrder.push(sk.category); }
        byCat[sk.category].push(sk);
      });

      catOrder.forEach(function(cat) {
        var box = document.createElement('div');
        box.className = 'day-box';
        box.innerHTML = '<div class="day-head"><span>' + esc(cat) + '</span></div>';

        byCat[cat].forEach(function(sk) {
          var card = document.createElement('div');
          card.className = 'card';
          if (!sk.qualified) card.style.borderColor = 'var(--border)';

          var head = '<div class="row">' +
            '<span class="card-title">' + esc(sk.name) + '</span>' +
            '<span class="card-tag">' + esc(sk.levelLabel) + '</span></div>';

          var body;
          if (sk.qualified) {
            body = '<div class="card-desc">✓ מוסמך' +
              (sk.canTrainOthers ? ' · יכול להכשיר אחרים' : '') +
              (sk.certDate ? ' · הוסמך ' + esc(sk.certDate) : '') +
              (sk.certBy ? ' על ידי ' + esc(sk.certBy) : '') + '</div>';
          } else {
            body = '<div class="card-desc">נדרשת רמה: ' + esc(sk.needLabel) +
              '. לא תשובץ לזה אוטומטית' +
              (sk.trainers.length ? ' · יכולים להכשיר: ' + esc(sk.trainers.join(', '))
                                  : ' · אין כרגע מי שיכשיר') + '</div>';
          }
          card.innerHTML = head + body;

          if (!sk.qualified) {
            if (sk.trainingStatus) {
              var st = document.createElement('div');
              st.style.cssText = 'margin-top:8px;font-size:12px;color:var(--muted)';
              st.textContent = 'בקשת הכשרה: ' + sk.trainingStatus;
              card.appendChild(st);
            } else {
              var btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'btn btn-sm btn-secondary';
              btn.style.marginTop = '10px';
              btn.textContent = 'בקש הכשרה 🎓';
              btn.onclick = function() { triggerTrainingRequest(sk); };
              card.appendChild(btn);
            }
          }
          box.appendChild(card);
        });
        container.appendChild(box);
      });
    });
}

function triggerTrainingRequest(sk) {
  openAppModal(
    'בקשת הכשרה',
    // אסור לכתוב כאן רצף לוכסן-הפוך-n, גם לא בהערה: כל הבלוק הזה יושב בתוך
    // תבנית (backtick) של generateStaffAppHtml_, והתבנית הופכת אותו לשורה חדשה אמיתית בתוך
    // המחרוזת — SyntaxError שהשתיק את כל הפורטל מ-@27 עד @40 (15/09).
    'בקשת הכשרה ל"' + sk.name + '" לרמה: ' + sk.needLabel + '. ' +
    (sk.trainers.length ? 'מי שיכול להכשיר: ' + sk.trainers.join(', ')
                        : 'אין כרגע עובד מוסמך להכשיר — הבקשה תגיע לכריס.') +
    ' אפשר להוסיף הערה:',
    true,
    // חמישה פרמטרים: הקולבק הוא החמישי. הגרסה הקודמת העבירה אותו רביעי
    // (במקום טקסט הכפתור), ולכן לחיצת האישור הייתה no-op — בקשת הכשרה
    // מהפורטל מעולם לא נשלחה. נתפס על ידי בדיקת הלקוח של G-2.
    'שלח בקשה',
    function(note) {
      api('requestTraining', { skillId: sk.id, wantLevel: sk.need, reason: note }, { post: true })
        .then(function(res) {
          // כשל תקשורת (היה withFailureHandler): api() אינו נופל, הוא מחזיר transport:true
          if (res && res.success === false && res.transport) {
            showToast('כשל בתקשורת מול השרת. ' + res.error, 'error');
            return;
          }
          if (res && res.success) {
            showToast('בקשת ההכשרה נשלחה ✓', 'success');
            loadMySkills();
          } else {
            showToast('שגיאה: ' + (res ? res.error : ''), 'error');
          }
        });
    }
  );
}

/* לוח החלפות */
function loadOpenSwaps() {
  var container = document.getElementById('openSwapsContainer');
  container.innerHTML = '<div class="loader">טוען לוח החלפות...</div>';

  api('openSwaps')
    .then(function(res) {
      // כשל תקשורת (היה withFailureHandler): api() אינו נופל, הוא מחזיר transport:true
      if (res && res.success === false && res.transport) {
        container.innerHTML = '<div class="empty-state">כשל בתקשורת</div>';
        return;
      }
      if (!res || !res.success) {
        container.innerHTML = '<div class="empty-state">שגיאה: ' + esc(res ? res.error : '') + '</div>';
        return;
      }

      AppState.openSwapsCount = res.swaps.length;
      updateSwapsBadge();

      if (res.swaps.length === 0) {
        container.innerHTML = '<div class="card"><div class="empty-state">אין כרגע בקשות החלפה פתוחות.</div></div>';
        return;
      }

      container.innerHTML = '';
      res.swaps.forEach(function(sw) {
        var isMySwap = (sw.requester === AppState.currentUser);
        var card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = 
          '<div class="card-header">' +
            '<span class="card-title">' + esc(sw.shiftDate) + ' · ' + esc(sw.shiftType) + '</span>' +
            '<span class="card-tag">מאת: ' + esc(sw.requester) + '</span>' +
          '</div>' +
          '<div class="card-desc">סיבה: ' + esc(sw.notes || 'ללא פירוט') + '</div>';

        if (isMySwap) {
          var myNote = document.createElement('div');
          myNote.style.fontSize = '12px'; myNote.style.color = 'var(--text-muted)';
          myNote.textContent = 'זוהי בקשה שפתחת בעצמך';
          card.appendChild(myNote);
        } else {
          if (sw.skillGap) {
            // חוסר כישור אינו מסתיר ואינו חוסם. העובד רואה לפני שהוא לוחץ,
            // והמנהל רואה את אותו דבר בדיאלוג האישור.
            var gapNote = document.createElement('div');
            gapNote.className = 'card-desc skill-gap';
            gapNote.style.color = '#8A6D00';
            gapNote.textContent = sw.skillGap + ' - אפשר לקחת, המנהל יראה את זה באישור';
            card.appendChild(gapNote);
          }
          var btnTake = document.createElement('button');
          btnTake.className = 'btn btn-sm';
          btnTake.textContent = 'אני אקח את המשמרת (+' + KARMA_BOOST + ' 💎)';
          btnTake.onclick = function() { triggerTakeSwapConfirm(sw.swapId); };
          card.appendChild(btnTake);
        }

        container.appendChild(card);
      });
    });
}

function triggerTakeSwapConfirm(swapId) {
  openAppModal(
    'אישור לקיחת משמרת',
    'האם לאשר לקיחת משמרת זו? לאחר אישורך הבקשה תועבר לאישור כריס/ערן ותזכה אותך ב-' + KARMA_BOOST + ' נקודות קארמה.',
    false,
    'אני לוקח',
    function() {
      api('takeSwap', { swapId: swapId }, { post: true })
        .then(function(res) {
          // כשל תקשורת (היה withFailureHandler): api() אינו נופל, הוא מחזיר transport:true
          if (res && res.success === false && res.transport) {
            showToast('כשל: ' + res.error, 'error');
            return;
          }
          if (res && res.success) {
            showToast('המשמרת שוריינה עבורך וממתינה לאישור סופי!', 'success');
            loadOpenSwaps();
          } else {
            showToast('שגיאה: ' + (res ? res.error : ''), 'error');
          }
        });
    }
  );
}

function triggerShiftSwapPrompt(shift) {
  openAppModal(
    'בקשת החלפה',
    'הזן סיבה להחלפת המשמרת ביום ' + shift.day + ' (' + shift.shiftType + '):',
    true,
    'פרסם בלוח',
    function(reason) {
      if (!reason || reason.trim() === '') {
        showToast('לא צוינה סיבה, הבקשה בוטלה', 'error');
        return;
      }

      api('requestSwap', { shiftDetails: shift, reason: reason }, { post: true })
        .then(function(res) {
          // כשל תקשורת (היה withFailureHandler): api() אינו נופל, הוא מחזיר transport:true
          if (res && res.success === false && res.transport) {
            showToast('כשל תקשורת: ' + res.error, 'error');
            return;
          }
          if (res && res.success) {
            // השרת מחזיר gridMarked, והצד הזה התעלם ממנו והודיע תמיד
            // שהלוח סומן. בקשה שנרשמה אך לא סומנה בלוח היא מצב אמיתי
            // (התא השתנה, היום נסגר) — והעובד היה יוצא מכאן בטוח
            // שהמשמרת שלו מסומנת להחלפה בלוח שכולם רואים.
            if (res.gridMarked === false) {
              showToast('הבקשה נרשמה, אך הלוח לא סומן — יש לוודא מול כריס', 'error');
            } else {
              showToast('בקשת ההחלפה פורסמה בלוח!', 'success');
            }
            AppState.openSwapsCount++;
            updateSwapsBadge();
          } else {
            showToast('שגיאה: ' + (res ? res.error : ''), 'error');
          }
        });
    }
  );
}

function showLinksOnlyNotice(invalid) {
  // הסלקט והתווית שלו יורדים, ההודעה נשארת. הסתרת הקבוצה כולה (עד 09/10) הסתירה גם את ההודעה —
  // הקישור הכללי הציג רק כותרת, בלי "הכניסה דרך הקישור האישי" (נמדד בהעברה ל-PWA).
  var sel = document.getElementById('userSelect');
  if (sel) sel.style.display = 'none';
  var lab = document.querySelector('label[for="userSelect"]');
  if (lab) lab.style.display = 'none';
  var btn = document.getElementById('btnLogin');
  if (btn) btn.style.display = 'none';
  var msg = document.getElementById('loginValidationMsg');
  msg.textContent = invalid ? '⚠️ הקישור הזה אינו תקף — בקש מהמנהל קישור חדש, והדבק אותו כאן.'
                            : '🔗 הכניסה לפורטל היא דרך הקישור האישי שקיבלת מהמנהל. אפשר להדביק אותו כאן:';
  msg.style.display = 'block';
  // אייפון: אפליקציה שנוספה למסך הבית נפתחת באחסון נפרד, בלי המפתח שנשמר בדפדפן. הדבקת הקישור פעם אחת
  // שומרת אותו גם שם (ביקורת ה-PWA, 09/10).
  var box = document.getElementById('pasteBox');
  if (box) box.style.display = 'block';
}

/** המפתח מתוך קישור שהודבק, או המפתח לבד (32 תווים הקסדצימליים). ריק = לא נמצא. **טהורה.** */
function keyFromPastedText(text) {
  var s = String(text == null ? '' : text).trim();
  var m = /[?&]k=([0-9a-fA-F]{32})(?![0-9a-fA-F])/.exec(s) || /^([0-9a-fA-F]{32})$/.exec(s);
  return m ? m[1].toLowerCase() : '';
}

function loginFromPastedLink() {
  var field = document.getElementById('pasteLink');
  var k = keyFromPastedText(field ? field.value : '');
  var msg = document.getElementById('loginValidationMsg');
  if (!k) {
    if (msg) { msg.textContent = '⚠️ זה לא נראה כמו הקישור האישי. צריך להדביק את הקישור המלא שקיבלת מהמנהל.'; msg.style.display = 'block'; }
    return;
  }
  try { window.localStorage.setItem(KEY_STORE, k); } catch (e) {}
  window.location.href = './?k=' + encodeURIComponent(k);
}

function autoLoginCheck() {
  // קישור אישי — נכנסים ישר; קישור כללי כשיש קישורים אישיים — הודעה במקום רשימת שמות (06/10)
  var me = INITIAL_DATA.me;
  if (me && me.key) { performLogin(null, me); return; }
  if (me && me.invalid) {
    // מפתח שבוטל לא נשאר במכשיר: בפתיחה הבאה בלי ?k= מוצגת ההודעה הרגילה, לא "אינו תקף" לנצח
    try { window.localStorage.removeItem(KEY_STORE); } catch (e) {}
    KEY = '';
  }
  if (INITIAL_DATA.linksOnly || (me && me.invalid)) { showLinksOnlyNotice(!!(me && me.invalid)); return; }
  var savedId = SafeStorage.get('freak_emp_id');
  if (savedId && empById(savedId)) {
    document.getElementById('userSelect').value = savedId;
    performLogin(savedId);
  }
}

/* ==================================================================
   Boot — what the server-rendered page had for free: the data, the name list,
   then the old autoLoginCheck. Until init arrives the login card shows
   "מתחבר לשרת..." and the button is disabled.
   ================================================================== */
// The name list, built exactly as generateStaffAppHtml_ built employeeOptions.
function fillEmployeeOptions(data) {
  var sel = document.getElementById('userSelect');
  if (!sel) return;
  var html = '<option value="">-- בחר שם עובד מהרשימה --</option>';
  if (data.error) {
    html = '<option value="">⚠️ שגיאה: ' + esc(data.error) + '</option>';
  } else if (data.employees && data.employees.length > 0) {
    data.employees.forEach(function(emp) {
      html += '<option value="' + esc(emp.id) + '">' + esc(emp.name) + '</option>';
    });
  }
  sel.innerHTML = html;
}

function hideNameLogin() {
  ['userSelect', 'btnLogin'].forEach(function (id) { var el = document.getElementById(id); if (el) el.style.display = 'none'; });
  var lab = document.querySelector('label[for="userSelect"]');
  if (lab) lab.style.display = 'none';
}

/** init נכשל: הודעה ברורה וכפתור "נסה שוב" — לא רשימת שמות עם שגיאה בתוכה (ביקורת ה-PWA 3). */
function showInitFailure(data) {
  var loader = document.getElementById('initLoader');
  if (loader) loader.style.display = 'none';
  hideNameLogin();
  var msg = document.getElementById('loginValidationMsg');
  if (msg) {
    msg.textContent = '⚠️ ' + ((data && data.transport) ? 'לא התקבלה תשובה מהשרת.' : ((data && data.error) || 'השרת החזיר שגיאה.')) +
                      ' לבדוק את החיבור לאינטרנט ולנסות שוב.';
    msg.style.display = 'block';
  }
  var rb = document.getElementById('btnRetryInit');
  if (rb) rb.style.display = '';
}

function retryInit() {
  var rb = document.getElementById('btnRetryInit');
  if (rb) rb.style.display = 'none';
  var msg = document.getElementById('loginValidationMsg');
  if (msg) msg.style.display = 'none';
  var loader = document.getElementById('initLoader');
  if (loader) loader.style.display = '';
  boot();
}

function boot() {
  var loader = document.getElementById('initLoader');
  var btn = document.getElementById('btnLogin');
  if (btn) btn.disabled = true;
  // עם מפתח, רשימת השמות לא רלוונטית — לא מהבהבת עד שהתשובה מגיעה (ביקורת ה-PWA 14)
  if (KEY) hideNameLogin();
  api('init').then(function(data) {
    if (!data || data.success === false) { showInitFailure(data); return; }
    INITIAL_DATA = data;
    AppState.openSwapsCount = INITIAL_DATA.openSwapsCount || 0;
    AppState.nextSundayStr = INITIAL_DATA.nextSundayStr || '';
    DAYS = INITIAL_DATA.days || [];
    SHIFT_TEMPLATES = INITIAL_DATA.shiftTemplates || [];
    STATUS_STATES = INITIAL_DATA.availability || [];
    KARMA_BOOST = INITIAL_DATA.karmaBoost || 0;
    fillEmployeeOptions(INITIAL_DATA);
    if (loader) loader.style.display = 'none';
    if (btn) btn.disabled = false;
    autoLoginCheck();
  });
}
boot();
