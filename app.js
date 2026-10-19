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
   CONFIG — what you edit at a release: BUILD here, CACHE in sw.js, and ?v= on app.js in index.html and in
   the SHELL list of sw.js — all four the same (test_portal_client checks). The ?v= makes a new app.js a new
   address, so the Pages CDN cannot serve an old app.js next to a new sw.js (seen 10/10 with p2).
   ================================================================== */
const API_URL = 'https://script.google.com/macros/s/AKfycbyBpSBlk-Z8R3cU4g9ADhW1JxRz0RG1c6CqEiOBTVD0_Ud27UWEE3s9tEoDpmeFMJznuw/exec';
const BUILD = 'p17';

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
var weeklyTouched = {};   // יום|משמרת שהעובד נגע בהם בטופס השבועי — הקבוע לא ממלא אותם שוב, גם אחרי ביטול (13/10)
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
var MODAL_INPUT_PH = 'פרט כאן...';   // the shared field's own hint, as in index.html (every open puts it back)
function openAppModal(title, desc, showInput, confirmText, callback) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalDesc').textContent = desc;
  var inputContainer = document.getElementById('modalInputContainer');
  var inputField = document.getElementById('modalInput');
  // stage 9: the field is shared — a caller that needs an address (the folder paste) sets its own direction and hint AFTER this
  inputField.dir = ''; inputField.placeholder = MODAL_INPUT_PH; inputField.inputMode = '';

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
  // מהשרת כשיש קישור אישי (me.isManager — אותה בדיקה כמו בכל פעולת מנהל); אחרת — הרשימה הישנה, לתצוגה בלבד
  AppState.isManager = (me && typeof me.isManager === 'boolean') ? me.isManager
    : !!(INITIAL_DATA.managers && INITIAL_DATA.managers.indexOf(userName) !== -1);
  // לשונית הניהול (13/10) — רק למנהל. זו תצוגה בלבד: כל קריאה של המסך נבדקת בשרת מול המפתח (mgrRequireManager_)
  var navMgr = document.getElementById('navManager');
  if (navMgr) navMgr.style.display = AppState.isManager ? '' : 'none';

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

  lastWeekBoard = null;   // כניסה: לוח של משתמש קודם לא נשאר בזיכרון (13/10)
  mgrResetState();        // 15/10: the assign screen and the team-view switch belong to the previous user
  ['myShiftsContainer', 'weekBoardContainer', 'openSwapsContainer', 'mgrStaff', 'mgrStaffSheet', 'mgrClock', 'mgrClockSheet', 'clockCard', 'clockHours', 'clockSheet',
   'skillsContainer', 'fixedMatrixContainer', 'mgrContainer', 'mgrStrip', 'mgrSubmit', 'mgrBuild', 'mgrStatus', 'mgrAssign', 'mgrSaveBar', 'mgrPicker', 'mgrCheck'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });
  var sPill = document.getElementById('skillsPill');
  if (sPill) sPill.style.display = 'none';

  // בניית מטריצת אילוצים
  renderConstraintsMatrix();
  syncSettingsUi();
  // האילוצים הקבועים של העובד הזה — ממלאים מראש את השבועי (10/10)
  loadMyFixed();

  // חזרה לטאב הראשון. בלי זה המסך חוזר עם הטאב של הקודם פתוח ועם
  // ה-DOM שלו בתוכו — כולל שורות המסומנות "המשמרות שלך" בלוח השבועי,
  // שהן של המשתמש הקודם. אין טעינה מחדש, אין שגיאה, ונראה תקין לגמרי.
  switchTab('tabMyShifts');

  updateSwapsBadge();
  // stage 10: the clock card — this person's taps that did not get an answer come back from the phone's storage, then the state is read
  clockReset();
  clockQLoad();
  loadClock();
  loadMyShifts();
  loadOpenSwaps();
  if (AppState.isManager) mgrPrefetch();   // stage 7: the manager's two big answers are fetched while the first tab is read
}

function doLogout(sure) {
  // stage 10: a clock tap the server has not answered is said before a logout (the app's own modal, iron rule 4) — from the store read
  // again NOW (OQ-1: another window's taps too). Nothing is deleted (FIX_ROUND2): the stored taps stay this person's, and go at their next
  // login on this phone; only what the phone could not store (OQ-2 / OQ-4) is lost, and the warning says so
  var qWait = sure === true ? [] : clockQWaiting();
  if (qWait.length) {
    var lost = clockQNoStore || qWait.length > CLOCK_Q_PER_OWNER;
    openAppModal('⏳ לחיצה שלא נשלחה', 'יש לחיצה שלא נשלחה לשעון הנוכחות (' + clockQText(qWait) + ').\nאם מתנתקים עכשיו היא לא נשלחת: היא נשארת שמורה בטלפון הזה, ' +
      'ותישלח כשנכנסים שוב מהקישור האישי בטלפון הזה.' + (lost ? ' ⚠️ הטלפון לא שמר את כל הלחיצות — מה שלא נשמר יאבד, ואז לבקש תיקון ב"🧾 השעות שלי".' : ''),
      false, 'להתנתק בכל זאת', function () { doLogout(true); });
    return;
  }
  mgrForgetStored();   // stage 7: the stored screen and the unsent build plan carry the key in their names - they go before the key does
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
  clockReset();   // stage 10: the card, the timers and the queue in memory leave with the person — their stored taps stay theirs (FIX_ROUND2)
  var navMgrOut = document.getElementById('navManager');
  if (navMgrOut) navMgrOut.style.display = 'none';

  // ניקוי ה-DOM גם ביציאה, ולא רק בכניסה: בין השתיים יש חלון שבו מסך
  // הכניסה מוצג אבל התוכן של הקודם עדיין יושב מאחוריו.
  lastWeekBoard = null;   // יציאה (טלפון משותף): הלוח של הקודם לא מצויר שוב במעבר תצוגה (13/10)
  mgrResetState();
  ['myShiftsContainer', 'weekBoardContainer', 'openSwapsContainer', 'mgrStaff', 'mgrStaffSheet', 'mgrClock', 'mgrClockSheet', 'clockCard', 'clockHours', 'clockSheet',
   'skillsContainer', 'fixedMatrixContainer', 'mgrContainer', 'mgrStrip', 'mgrSubmit', 'mgrBuild', 'mgrStatus', 'mgrAssign', 'mgrSaveBar', 'mgrPicker', 'mgrCheck'].forEach(function (id) {
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
  if (tabId === 'tabManager') openManagerTab();   // stage 7: the last answers at once, the fresh ones behind them
  clockTimersSync();   // stage 10: the clock's minutes tick only while "המשמרות שלי" is in view
  if (tabId === 'tabMyShifts') clockTickRun();
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

      // Draft / published (15/10): while the next week is a draft the server answers with the published week, or "in progress"
      var boardNote = boardNoticeHtml(res.board, 'shifts');
      if (res.board && res.board.shown === 'none') { container.innerHTML = boardNote; return; }

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
          container.innerHTML = boardNote +
            '<div class="card">' +
              '<div class="card-title" style="margin-bottom:6px;">אין משמרות רשומות עבורך השבוע</div>' +
              '<div class="card-desc">שמך אינו משובץ כרגע בתאי הסידור הפעילים, או שטרם הופעל סנכרון שבועי.</div>' +
            '</div>';
        }
        return;
      }

      // קיבוץ לפי יום: כל המשמרות של ראשון מופיעות תחת "ראשון".
      // השרת מחזיר אותן כבר ממוינות לפי סדר העמודות והשורות בלוח.
      container.innerHTML = boardNote;
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
  var gen = loginGen;

  // 15/10: a manager may ask for what the team sees while the next week is a draft (the server decides who is a manager)
  api('weekBoard', weekTeamView ? { view: 'staff' } : {})
    .then(function(res) {
      // תשובה מאוחרת אחרי יציאה / כניסה של אחר (טלפון משותף) — לא מציירים את הלוח של הקודם ולא שומרים אותו (ביקורת p4)
      if (gen !== loginGen) return;
      // כשל תקשורת (היה withFailureHandler): api() אינו נופל, הוא מחזיר transport:true
      if (res && res.success === false && res.transport) {
        lastWeekBoard = null;   // מעבר תצוגה לא מחליף את הודעת השגיאה בלוח ישן
        container.innerHTML = '<div class="empty-state">כשל בתקשורת מול השרת</div>';
        return;
      }
      if (!res || !res.success) {
        lastWeekBoard = null;
        container.innerHTML = '<div class="empty-state">שגיאה: ' + esc(res ? res.error : '') + '</div>';
        return;
      }
      if (!res.days || res.days.length === 0) {
        lastWeekBoard = null;
        container.innerHTML = (res.board && res.board.shown === 'none') ? boardNoticeHtml(res.board, 'week')
          : '<div class="empty-state">הלוח השבועי טרם נבנה.</div>';
        return;
      }
      lastWeekBoard = res;
      renderWeekBoard(res);
    });
}

/* ==================================================================
   Draft / published (15/10). The server says what is shown (res.board: draft, shown "live" | "copy" | "none", week,
   nextWeek, ended, managerView, isManager); the screen only says it in words. Dates are checked before they are shown.
   ================================================================== */
var weekTeamView = false;   // a manager looking at what the team sees (weekly board); reset on login and logout

function isoShort(iso) {
  var s = String(iso == null ? '' : iso);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(8, 10) + '/' + s.slice(5, 7) : '';
}

function boardNoticeHtml(board, where) {
  if (!board || !board.draft) return '';
  if (board.shown === 'none') {
    return '<div class="card board-note"><div class="card-title" style="margin-bottom:6px;">🛠 הסידור לשבוע הבא בבנייה</div>' +
      '<div class="card-desc">' + (board.ended ? 'השבוע הקודם הסתיים. ' : '') + 'הסידור יופיע כאן אחרי שהמנהל יפרסם אותו.</div>' +
      // a manager looking at the team's view must be able to get back to the draft (review 15/10, finding 5)
      (board.isManager && where === 'week' ? '<button class="link-btn" type="button" onclick="mgrToggleTeamView()">🛠 חזרה לטיוטה</button>' : '') +
      '</div>';
  }
  if (board.managerView) {
    return '<div class="board-note mgr">🛠 טיוטה' + (isoShort(board.week) ? ' של שבוע ' + isoShort(board.week) : '') +
      ' — הצוות עוד לא רואה אותה. <button class="link-btn" type="button" onclick="mgrToggleTeamView()">👀 מה הצוות רואה</button></div>';
  }
  var w = isoShort(board.week);
  return '<div class="board-note">📌 מוצג השבוע שפורסם' + (w ? ' (' + w + ')' : '') + '. הסידור לשבוע הבא בבנייה' +
    (where === 'shifts' ? ' — בקשות החלפה בינתיים דרך המנהל.' : '.') +
    (board.isManager && where === 'week' ? ' <button class="link-btn" type="button" onclick="mgrToggleTeamView()">🛠 חזרה לטיוטה</button>' : '') + '</div>';
}

function mgrToggleTeamView() {
  weekTeamView = !weekTeamView;
  loadWeekBoard();
}

/* ==================================================================
   מסך המנהל (13/10, שלב 1): בקשות החלפה לאישור, והזמינות לשבוע הבא לכל יום ומשמרת. הלשונית מוצגת רק למנהל, אבל
   זו תצוגה: כל קריאה נבדקת בשרת מול המפתח (mgrRequireManager_ ב-20_ManagerApi.gs). כל טקסט מהשרת עובר esc().
   ================================================================== */
/* ------------------------------------------------------------------
   Stage 7 (17/10): the manager tab without the wait. Every request to the server costs 2-9 s of Google's own time, so:
   the two big answers (mgrOverview, mgrBoard) are fetched as soon as a manager is in (mgrPrefetch) and kept in memory and in
   localStorage (this week only, under the user's key); opening the tab draws what is kept AT ONCE with a small chip, and the
   fresh answers replace it (the unsaved marks stay: mgrSyncPending). A tab opened while the requests are on the way does not
   ask again. loadManager() is the forced reload (the ↻ button, after an action).
   ------------------------------------------------------------------ */
function loadManager() {
  var first = !mgrOpened;
  if (first) mgrOpenMemory();
  loadMgrOverview();
  loadMgrBoard();   // 15/10, stage 2: the board for assigning (its own call, in parallel)
  if (first) renderMgrCheckButton();
}

/** The manager tab was tapped: draw what is kept, ask for the fresh answers unless they are already on the way, offer the week check. */
function openManagerTab() {
  mgrOpenMemory();
  if (!mgrOvFlight) loadMgrOverview();
  if (!mgrBoardFlight) loadMgrBoard();
  renderMgrCheckButton();
  mgrStaffHook();   // stage 9: the fold "👥 צוות" asks for the staff cards on its first open, never before
  mgrClockHook();   // stage 10: the same for the fold "⏱ נוכחות"
}

/** Right after a manager is in: both answers are asked for, nothing is drawn until the tab is opened. */
function mgrPrefetch() {
  if (!mgrOvFlight) loadMgrOverview();
  if (!mgrBoardFlight) loadMgrBoard();
}

/** Marks the tab as opened and draws from memory; a stored copy of this week stands in for an answer that has not come yet. */
function mgrOpenMemory() {
  mgrOpened = true;
  if (!mgrOvData || !mgrBoardData) {
    var c = mgrCacheLoad();
    if (c) {
      if (!mgrOvData && c.ov && c.ov.success) { mgrOvData = c.ov; mgrOvCached = true; }
      if (!mgrBoardData && c.board && Array.isArray(c.board.days)) { mgrBoardData = c.board; mgrBoardCached = true; }
    }
  }
  mgrDrawAll();
}

function mgrDrawAll() {
  var box = document.getElementById('mgrContainer'), abox = document.getElementById('mgrAssign');
  if (mgrOvData) mgrDrawOverview(mgrOvData);
  else if (box) box.innerHTML = '<div class="loader">טוען את מסך המנהל...</div>';
  if (mgrBoardData) mgrDrawBoard();
  else if (abox) abox.innerHTML = '<div class="loader">טוען את הלוח...</div>';
  renderMgrFresh();
}

function mgrDrawOverview(res) {
  var box = document.getElementById('mgrContainer');
  renderMgrSubmit(res.submitStatus);   // 16/10: who has submitted for next week
  renderMgrBuild(res);   // 16/10: build the week from the phone
  renderMgrStatus(res.board);   // 15/10: draft / published, and the publish button
  renderMgrStrip();   // 16/10: the strip at the top — week, who submitted, the one next step
  if (box) renderManager(box, res);
}

function mgrDrawBoard() {
  renderMgrAssign();
  renderMgrPicker();
  renderMgrSaveBar();
  mgrDayCheckLanded();
  if (mgrDayCtx) renderMgrDay();   // closes itself when its day is gone / closed / the week changed
  if (mgrTool) renderMgrTool();    // stage 6: closes itself when its row is gone / the board is not the one it was opened on
}

function loadMgrOverview() {
  var gen = loginGen, seq = ++mgrOvSeq;
  mgrOvFlight = seq; mgrStaleFail = false;
  renderMgrFresh();
  api('mgrOverview').then(function (res) {
    if (gen !== loginGen || seq !== mgrOvSeq) return;   // יצאו בינתיים (טלפון משותף) — לא מציירים את המסך של הקודם; or a newer answer is coming
    mgrOvFlight = 0;
    var box = document.getElementById('mgrContainer');
    if (!res || !res.success) {
      if (res && res.transport && mgrOvData && mgrOvCached) {   // no answer, and the screen shows the stored copy: it stays, with a chip to try again (a live answer does not - review 16/10)
        mgrStaleFail = true;
        if (mgrOpened) mgrDrawOverview(mgrOvData);   // the same data, drawn again: a button that shows the hourglass is back
        renderMgrFresh();
        return;
      }
      // the cards above are from the previous answer — not left standing over an error (review 16/10)
      mgrOvData = null; mgrOvCached = false;
      if (res && !res.transport) SafeStorage.remove(MGR_CACHE_KEY + identityKey());   // the server said no: the stored copy is not shown again
      if (mgrOpened) {
        renderMgrSubmit(null); renderMgrStatus(null); renderMgrBuild(null); renderMgrStrip();
        if (box) box.innerHTML = '<div class="empty-state">' + (res && res.transport ? 'כשל בתקשורת מול השרת' : 'שגיאה: ' + esc(res ? res.error : '')) + '</div>';
      }
      renderMgrFresh();
      return;
    }
    mgrOvData = res; mgrOvCached = false;
    Object.keys(mgrDecideBusy).forEach(function (k) { if (mgrDecideBusy[k].done) delete mgrDecideBusy[k]; });   // answered decisions are in this answer
    mgrCacheSave();
    if (mgrOpened) mgrDrawOverview(res);
    renderMgrFresh();
  });
}

/** The Sunday on or before a date, "yyyy-MM-dd" (local): a stored copy of the screen is good for the week it was saved in. */
function mgrSundayOf(d) {
  var s = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
  return s.getFullYear() + '-' + (s.getMonth() < 9 ? '0' : '') + (s.getMonth() + 1) + '-' + (s.getDate() < 10 ? '0' : '') + s.getDate();
}

function mgrCacheSave() {
  var id = identityKey();
  if (!id || (!mgrOvData && !mgrBoardData)) return;
  // the fetched-ahead answers land one by one, before the stored copy was ever loaded into memory: the half that memory does not
  // have yet stays as it is in storage (this week's copy only), it is not overwritten with nothing
  var old = mgrOvData && mgrBoardData ? null : mgrCacheLoad();
  var ov = mgrOvData || (old && old.ov) || null;
  var b = mgrBoardData ? Object.assign({}, mgrBoardData) : ((old && old.board) || null);
  if (b) delete b.recurNote;   // that note belongs to the last save only
  SafeStorage.set(MGR_CACHE_KEY + id, { sun: mgrSundayOf(new Date()), ov: ov, board: b });
}

/** The stored copy, or null: none, from another week (dropped), or unreadable. */
function mgrCacheLoad() {
  var id = identityKey();
  if (!id) return null;
  var c = SafeStorage.get(MGR_CACHE_KEY + id);
  if (!c || typeof c !== 'object' || c.sun !== mgrSundayOf(new Date())) { SafeStorage.remove(MGR_CACHE_KEY + id); return null; }
  return c;
}

/** Logout: the stored screen and the unsent plan carry the personal key in their names, so they leave with it. */
function mgrForgetStored() {
  var id = identityKey();
  if (!id) return;
  SafeStorage.remove(MGR_CACHE_KEY + id);
  SafeStorage.remove(MGR_PLAN_KEY + id);
}

/** The small chip at the top: "updating" while a request is on the way and old data is on screen; "not updated" + retry after a request with no answer. */
function renderMgrFresh() {
  var el = document.getElementById('mgrFresh');
  if (!el) return;
  var busy = !!(mgrOvFlight || mgrBoardFlight);
  var shown = mgrOpened && !!(mgrOvData || mgrBoardData) && (busy || mgrStaleFail);
  el.innerHTML = '';
  el.style.display = shown ? '' : 'none';
  if (!shown) return;
  if (busy) {
    el.appendChild(mgrEl('span', 'mgr-fresh mgr-fresh-busy', '⏳ מתעדכן…'));
  } else {
    var b = mgrEl('button', 'mgr-fresh mgr-fresh-stale'); b.type = 'button'; b.textContent = '⚠️ לא התעדכן — מוצג מה שנטען קודם. לנסות שוב ↻';
    b.onclick = loadManager;
    el.appendChild(b);
  }
}

function mgrEl(tag, cls, html) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

function renderManager(box, res) {
  var wasOpen = Array.prototype.map.call(box.children || [], function (d) { return !!d.open; });   // stage 7: a redraw under a hand that opened the availability fold keeps it open
  box.innerHTML = '';
  var sw = res.swaps || {};
  var claimed = sw.claimed || [], open = sw.open || [];
  // 16/10: both sections are folded by default; the swaps open by themselves when a request waits
  var sec = mgrEl('details', 'mgr-fold');
  sec.appendChild(mgrEl('summary', '', '🔄 החלפות' + (claimed.length ? ' (' + claimed.length + ' ממתינות)' : '')));
  sec.open = claimed.length > 0;
  if (sw.gateNote) sec.appendChild(mgrEl('p', 'mgr-note', '⚠️ כישורי המחליפים לא נבדקו: ' + esc(sw.gateNote)));
  if (!claimed.length) sec.appendChild(mgrEl('p', 'mgr-empty', 'אין בקשות שממתינות לאישור ✓'));
  claimed.forEach(function (s) {
    var card = mgrEl('div', 'card mgr-card',
      '<div class="mgr-row"><b>' + esc(s.date) + ' · ' + esc(s.shift) + '</b></div>' +
      '<div>מ-<b>' + esc(s.orig) + '</b> אל <b>' + esc(s.proposed) + '</b> (+' + esc(res.karmaBoost) + ' קארמה)</div>' +
      (s.skill ? '<div class="mgr-skill">' + esc(s.skill) + '</div>' : '') +
      '<div class="mgr-reason">סיבה: ' + esc(s.reason || 'לא צוינה') + '</div>');
    var acts = mgrEl('div', 'mgr-acts');
    var ok = mgrEl('button', 'btn btn-sm mgr-approve'); ok.type = 'button'; mgrDecideSet(ok, 'swap:' + s.id, 'mgrApproveSwap', '✓ אשר');
    ok.onclick = function () {
      openAppModal('אישור החלפה', s.date + ' · ' + s.shift + ': ' + s.proposed + ' במקום ' + s.orig + '. הלוח יתעדכן.', false, 'אשר', function () {
        mgrDecide('mgrApproveSwap', { swapId: s.id }, ok);
      });
    };
    var no = mgrEl('button', 'btn btn-secondary btn-sm mgr-reject'); no.type = 'button'; mgrDecideSet(no, 'swap:' + s.id, 'mgrRejectSwap', '✗ דחה');
    no.onclick = function () {
      openAppModal('דחיית החלפה', 'המשמרת נשארת אצל ' + s.orig + '. סיבה (לא חובה):', true, 'דחה', function (reason) {
        mgrDecide('mgrRejectSwap', { swapId: s.id, reason: typeof reason === 'string' ? reason : '' }, no);
      });
    };
    acts.appendChild(ok); acts.appendChild(no); card.appendChild(acts);
    sec.appendChild(card);
  });
  if (open.length) {
    sec.appendChild(mgrEl('p', 'mgr-sub', 'פתוחות — עוד אין מחליף (' + open.length + '):'));
    open.forEach(function (s) {
      sec.appendChild(mgrEl('div', 'mgr-line', esc(s.date) + ' · ' + esc(s.shift) + ' — ' + esc(s.orig) + (s.reason ? ' (' + esc(s.reason) + ')' : '')));
    });
  }
  if (sw.stranded || sw.expired) {
    sec.appendChild(mgrEl('p', 'mgr-note', '⚠️ ' + esc((sw.stranded || 0) + (sw.expired || 0)) +
      ' בקשות שצריך לטפל בהן בגיליון (תפריט ← "אישור בקשות החלפה").'));
  }
  box.appendChild(sec);

  var av = res.availability || {};
  var asec = mgrEl('details', 'mgr-fold');
  asec.appendChild(mgrEl('summary', '', '📝 זמינות לשבוע ' + esc(av.week || '')));
  // 16/10: who has not submitted is said once, at the top (renderMgrSubmit — the hours-budget list); an older server — here as before
  if ((!res.submitStatus || res.submitStatus.error) && av.notSubmitted && av.notSubmitted.length) asec.appendChild(mgrEl('p', 'mgr-note', 'לא הגישו: ' + esc(av.notSubmitted.join(', '))));
  asec.appendChild(mgrEl('p', 'mgr-legend', '🔁 = מהאילוצים הקבועים שהעובד שמר באפליקציה (לא הגיש טופס לשבוע הזה) · מי שסימן "לא יכול" לא מופיע כאן — רואים אותו ליד השם ברשימת השיבוץ'));
  var stText = (av.statuses || []).map(function (k) {
    for (var i = 0; i < STATUS_STATES.length; i++) if (STATUS_STATES[i].key === k) return STATUS_STATES[i].text || k;
    return k;
  });
  // Chris 16/10: only who CAN work stands out (wants / if needed). "לא יכול" is not shown here; a day off is a small grey note —
  // once under the day when the person is off in every shift of that day, else under the shift.
  var AV_CANT = 'לא יכול', AV_OFF = 'חופש/מחלה';
  var offIx = (av.statuses || []).indexOf(AV_OFF);
  var namesOf = function (list) { return list.map(function (p) { return esc(p.name) + (p.fixed ? ' 🔁' : ''); }).join(', '); };
  var offIn = function (sl) { return offIx === -1 ? [] : (((sl.by || [])[offIx]) || []); };
  var dayOrder = [], byDay = {};
  (av.slots || []).forEach(function (sl) {
    if (!byDay[sl.day]) { byDay[sl.day] = []; dayOrder.push(sl.day); }
    byDay[sl.day].push(sl);
  });
  dayOrder.forEach(function (dayName) {
    var slots = byDay[dayName];
    var allOff = offIn(slots[0]).filter(function (p) {
      return slots.every(function (sl) { return offIn(sl).some(function (q) { return q.name === p.name; }); });
    });
    var dayOff = {};
    allOff.forEach(function (p) { dayOff[p.name] = true; });
    var dayBox = mgrEl('div', 'day-group', '<div class="day-head"><span>יום ' + esc(dayName) + '</span></div>' +
      (allOff.length ? '<div class="mgr-off">חופש / מחלה: ' + namesOf(allOff) + '</div>' : ''));
    asec.appendChild(dayBox);
    slots.forEach(function (sl) {
      var lines = '', off = [];
      (sl.by || []).forEach(function (list, ix) {
        if (!list || !list.length) return;
        var key = (av.statuses || [])[ix];
        if (key === AV_CANT) return;
        if (key === AV_OFF) { off = list.filter(function (p) { return !dayOff[p.name]; }); return; }
        lines += '<div class="mgr-st">' + esc(stText[ix] || '') + ': ' + namesOf(list) + '</div>';
      });
      dayBox.appendChild(mgrEl('div', 'mgr-slot', '<div class="mgr-slot-h"><b>' + esc(sl.shift) + '</b> <span>' + esc(sl.hours) + '</span></div>' +
        (lines || '<div class="mgr-st mgr-none">אין מי שסימן שיכול</div>') +
        (off.length ? '<div class="mgr-off">חופש / מחלה: ' + namesOf(off) + '</div>' : '')));
    });
  });
  var ppl = (av.people || []).filter(function (p) { return p.target || p.notes || p.fixedNote; });
  if (ppl.length) {
    asec.appendChild(mgrEl('p', 'mgr-sub', 'יעדים והערות:'));
    ppl.forEach(function (p) {
      asec.appendChild(mgrEl('div', 'mgr-line', '<b>' + esc(p.name) + '</b>' + (p.target ? ' — ' + esc(p.target) + ' משמרות' : '') +
        (p.notes ? ' · ' + esc(p.notes) : '') + (p.fixedNote ? ' · 🔁 ' + esc(p.fixedNote) : '')));
    });
  }
  box.appendChild(asec);
  // the swaps fold (first) opens by its own rule; the availability fold (second) stays as the hand left it
  if (wasOpen[1] && box.children && box.children[1]) box.children[1].open = true;
}

/** What a decision is about: one swap request (approve and reject share it), or one week's publishing (the card's button and the strip's share it). */
function mgrDecideKey(action, params) {
  return action === 'mgrPublish' ? 'publish:' + String((params && params.week) || '') : 'swap:' + String((params && params.swapId) || '');
}

/** A decision button as it must look now: the hourglass on the one whose request is on the way, and every button of the same subject disabled. */
function mgrDecideSet(btn, key, action, text) {
  var st = mgrDecideBusy[key];
  btn.disabled = !!st;
  btn.textContent = st && st.action === action ? MGR_BUSY : text;
}

/** The cards with decision buttons (status, strip, swaps) drawn again from the data on screen - after the state of a decision changed. */
function mgrRedrawDecisions() {
  if (!mgrOpened || !mgrOvData) return;
  var box = document.getElementById('mgrContainer');
  renderMgrStatus(mgrOvData.board);
  renderMgrStrip();
  if (box) renderManager(box, mgrOvData);
}

/**
 * btn = the button that was tapped. The decision is kept in mgrDecideBusy, so the cards that a fresh answer redraws (a refresh is always on its way
 * right after the tab opens) draw the button as the hourglass too, and a second tap cannot send it twice. A success keeps the buttons that way
 * until the overview read after it replaces the cards; a refusal gives them back.
 */
function mgrDecide(action, params, btn) {
  var key = mgrDecideKey(action, params);
  if (mgrDecideBusy[key]) return;   // already on its way
  showToast('שולח לגיליון...', 'info');
  var gen = loginGen, was = btn ? btn.textContent : '', st = { action: action, done: false };
  mgrDecideBusy[key] = st;
  if (btn) { btn.disabled = true; btn.textContent = MGR_BUSY; }
  mgrRedrawDecisions();   // the other buttons of the same subject (the publish card AND the strip) show it too
  api(action, params, { post: true }).then(function (res) {
    if (gen !== loginGen) return;
    if (res && res.success) st.done = true;
    else {
      if (mgrDecideBusy[key] === st) delete mgrDecideBusy[key];
      if (btn) { btn.disabled = false; btn.textContent = was; }
      mgrRedrawDecisions();   // the buttons that a fresh answer drew meanwhile come back too
    }
    if (res && res.success) showToast(res.message || 'בוצע ✓', 'success');
    else if (res && res.transport) showToast('לא התקבלה תשובה מהשרת. המסך נטען מחדש — לבדוק אם הבקשה עדיין ממתינה לפני שמנסים שוב.', 'error');
    else showToast('לא בוצע: ' + (res ? res.error : ''), 'error');
    loadManager();
    if (action === 'mgrPublish' && res && res.success) mgrShowHours();   // 17/10: the hours of the week just published, without a tap
  });
}

/**
 * 17/10 (Chris, after his first publish: "איפה הסיכום שעות? איך אני מפרסם תמונה לצוות לקבוצת וואטסאפ?"): the two things a
 * manager does once a week is published — on the strip at the top (always in sight) and on the published card.
 */
function mgrPubActs() {
  var acts = mgrEl('div', 'mgr-pub-acts');
  var wa = mgrEl('button', 'btn btn-sm btn-secondary mgr-wa'); wa.type = 'button'; wa.textContent = '📸 תמונה לקבוצת הוואטסאפ';
  wa.onclick = function () { mgrShareWeekImage(wa); };
  var hr = mgrEl('button', 'btn btn-sm btn-secondary mgr-hours'); hr.type = 'button'; hr.textContent = '⏱ סיכום שעות';
  hr.onclick = mgrShowHours;
  acts.appendChild(wa); acts.appendChild(hr);
  return acts;
}

/** The week check ("⏱ סיכום שעות"): open its fold, run it (one GET), bring it into view. */
function mgrShowHours() {
  var box = document.getElementById('mgrCheck');
  if (!box) return;
  var fold = box.parentNode && box.parentNode.tagName === 'DETAILS' ? box.parentNode : null;
  if (fold) fold.open = true;
  loadMgrCheck();
  try { (fold || box).scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
}

/**
 * The WhatsApp image from the manager tab (17/10): what the TEAM sees (weekBoard, view "staff"), read fresh, then the same picture
 * and share window as the weekly board tab (waImageShare). One request at a time; the button shows ⏳ meanwhile.
 */
var mgrImgBusy = false;
function mgrShareWeekImage(btn) {
  if (mgrImgBusy) return;
  mgrImgBusy = true;
  var was = btn ? btn.textContent : '', gen = loginGen;
  if (btn) { btn.disabled = true; btn.textContent = MGR_BUSY; }
  api('weekBoard', { view: 'staff' }).then(function (res) {
    mgrImgBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = was; }
    if (gen !== loginGen) return;   // logged out meanwhile (shared phone)
    if (!res || !res.success || !res.table || !res.table.html) {
      showToast(res && res.transport ? 'כשל בתקשורת מול השרת — לנסות שוב.' : 'אין טבלה לתמונה' + (res && res.error ? ': ' + res.error : '') + '.', 'error');
      return;
    }
    waImageShare(res);
  });
}

/* ==================================================================
   Manager screen, stage 2 (15/10): the publish card, assign from a list, the week check.
   Every write is one confirmed save, and the server checks it again under its lock (mgrPublish_ / mgrAssignBatch_ in
   20_ManagerApi.gs): the week the screen showed, the cell as the screen saw it, the list of the row. The code never
   picks anyone — the list shows what each person submitted, the manager taps. Every server text goes through esc().
   ================================================================== */
var mgrBoardData = null;   // the last mgrBoard answer (cleared on login and logout)
var mgrOvData = null;      // the last mgrOverview answer — the strip at the top reads it
var mgrPending = {};       // "label|dd/MM" -> {label, day, title, expect, ops:[{op, empId, name, time}], reason, changed}; nothing is sent until "save"
var mgrPendingWeek = '';   // the board week the pending changes were marked on (a different week on reload drops them)
var mgrSaving = false;     // one save at a time (no automatic retry — it may have landed)
var mgrPickCtx = null;     // the open picker: {label, day}
var mgrPickTime = '';      // the optional "other hours" typed in the picker
var mgrAddOpen = false;    // the "new person" form of the picker is open
var mgrAdding = false;     // a new person is being added right now
var mgrAddDraft = { name: '', kind: 'trainee' };   // what is typed in the new-person form of the picker (survives a redraw: a fresh board answer redraws the picker)
var mgrBoardSeq = 0;       // only the latest mgrBoard answer is drawn
var mgrDayCtx = null;      // the open day dialog: {short, mode: 'menu'|'note'|'event'}
var mgrDayDraft = { text: '', title: '', from: '', to: '', staff: true };   // what is typed in the day dialog (survives a redraw)
var mgrDayBusy = false;    // a note / event is being sent (no second one, no automatic retry — it may have landed)
var mgrEvWait = { week: '', items: [] };   // events added with "needs a shop worker": they reach the board on the next rebuild
var mgrEvSeq = 0;          // numbers the waiting events, so a build sent earlier only clears the ones added before it
var mgrDayCheck = null;    // a note whose answer never came: after the next reload, close the dialog if the line is there
var mgrPickRepeat = false; // stage 6: the "every week" box of the picker (custom rows only)
// stage 6 (17/10): the tools sheet — which day for a note, a new row, the shift types, the actions of one custom row
var mgrTool = null;        // the open sheet: {mode: 'day'|'newrow'|'types'|'row', label}
var mgrToolBusy = false;   // a request of the sheet is running (one at a time, no automatic retry — it may have landed)
var mgrToolErr = '';       // the server's last refusal, printed inside the sheet
var mgrRowDraft = { name: '', from: '', to: '' };   // the new-row form (survives a redraw)
var mgrTypes = null;       // the last mgrShiftTypes answer's types (null = not loaded yet)
var mgrTypesState = '';    // '' | 'loading' | 'error'
var mgrTypesChanged = false;   // a type was switched or added in this sheet: the board follows the next build
var mgrTypeFormOpen = false;
var mgrTypeDraft = null;   // the new-type form (see mgrTypeDraftNew)
var MGR_DAYS6 = ['א', 'ב', 'ג', 'ד', 'ה', 'ו'];
// stage 8 (17/10): where a shift type happens — the server's MGR_TYPE_LOCATIONS_ ("חיצוני" = outside the store, e.g. a camp or an outside role-playing event)
var MGR_TYPE_LOCATIONS = ['חנות', 'משרד', 'מועדון', 'חיצוני'];
var MGR_TYPE_EXT = 'חיצוני';
// stage 8: the chugim (classes) kept fresh from their file - the switch (mgrChugAuto), "refresh now" (mgrChugRefresh) and what it answered
var mgrChugBusy = '';      // '' | 'auto' | 'refresh': the request on its way (one at a time; both buttons are disabled, the tapped one shows the hourglass)
var mgrChugResult = null;  // the last "refresh now" answer: {ok, changed:[text], clashes:[text], notes:[text], check:'ok'|'skipped'|'failed'|'', error}; cleared on login and logout
var MGR_DOW = { 'ראשון': 'א', 'שני': 'ב', 'שלישי': 'ג', 'רביעי': 'ד', 'חמישי': 'ה', 'שישי': 'ו' };   // the board's day name -> the recurring store's letter (no Saturday)

// stage 7 (17/10): fewer waits (the kept screen, the fetch ahead, a write that answers with the board) and the week's events asked BEFORE the build
var MGR_CACHE_KEY = 'freak_mgr_';      // + the user's key: the last mgrOverview / mgrBoard answers (this week only)
var MGR_PLAN_KEY = 'freak_mgrplan_';   // + the user's key: the unsent build plan, per week (events, notes, who needs staff)
var MGR_BUSY = '⏳';                    // what a button shows while its request is on the way (it is disabled too)
var mgrOvSeq = 0;          // only the latest mgrOverview answer is drawn
var mgrOvFlight = 0;       // the seq of the mgrOverview request on its way (0 = none): a tab opened meanwhile does not ask again
var mgrBoardFlight = 0;    // the same for mgrBoard
var mgrDecideBusy = {};     // decisions on their way or just answered: 'swap:ID' / 'publish:WEEK' -> {action, done}; every button redraw reads it (a fresh answer must not bring the button back enabled)
var mgrBoardDropped = false;   // a write dropped a board refresh that was on its way: until a board is drawn or asked for again, the table may still be the stored copy
var mgrOpened = false;     // the manager tab was opened since the login; before that the fetched-ahead answers are only kept, not drawn
var mgrStaleFail = false;  // the last refresh got no answer: the stored copy stays on screen, with a chip to try again
var mgrOvCached = false;   // mgrOvData is the stored copy of the last visit (no fresh answer has replaced it yet)
var mgrBoardCached = false;   // the same for mgrBoardData
var mgrInfoSaving = null;  // a day note on its way: {week, short, text} - shown in its cell in grey
var mgrDayErr = '';        // the server's refusal of the open day dialog, printed in red inside it
var mgrToolBusyOn = '';    // which control of the tools sheet was pressed (it shows the hourglass)
var mgrBs = null;          // the open "week's events" sheet: {pl, week, state: 'loading'|'ready'|'error', data, err, form: null|{day, kind}}
var mgrBsPlan = null;      // the plan of the next build: {week, overrides: {key: bool}, events: [{n, day, title, from, to, staff}], notes: [{n, day, text}]}
var mgrBsDraft = { title: '', from: '', to: '', staff: true, text: '' };   // what is typed in the sheet's inline form (survives a redraw)
var mgrBsSeq = 0;          // only the latest mgrWeekEvents answer is drawn
var mgrBsN = 0;            // numbers the plan's new items
var mgrBsScroll = 0;       // the sheet's scroll position, kept over a redraw
var mgrBsFocus = false;    // an inline form was just opened: its first field comes into view and gets the cursor (the keyboard opens where the typing is)
var mgrBsFocusEl = null;   // that field, once the redraw has made it

function mgrTypeDraftNew() { return { name: '', from: '', to: '', days: MGR_DAYS6.slice(), location: 'חנות' }; }

/** A write (or a newer answer) makes a board reload that is still on its way old: its answer is not drawn, and it no longer counts as "on the way". */
function mgrBoardInvalidate() { if (mgrBoardFlight) mgrBoardDropped = true; mgrBoardSeq++; mgrBoardFlight = 0; renderMgrFresh(); }

/** After a write whose answer had no board: a refresh that the write dropped is asked for again (ONE request), so the table never stays as the stored copy without the chip. */
function mgrBoardRefreshIfDropped() { if (mgrBoardDropped && !mgrBoardFlight) loadMgrBoard(); }

function mgrResetState() {
  mgrBoardData = null; mgrOvData = null; mgrPending = {}; mgrPendingWeek = ''; mgrSaving = false;
  mgrPickCtx = null; mgrPickTime = ''; mgrAddOpen = false; mgrAdding = false; mgrAddDraftReset(); mgrBoardSeq++; mgrPickRepeat = false;
  mgrOvSeq++; mgrOvFlight = 0; mgrBoardFlight = 0; mgrBoardDropped = false; mgrDecideBusy = {}; mgrOpened = false; mgrStaleFail = false; mgrOvCached = false; mgrBoardCached = false; mgrInfoSaving = null; mgrDayErr = ''; mgrToolBusyOn = '';
  mgrBs = null; mgrBsPlan = null; mgrBsSeq++; mgrBsScroll = 0; mgrBsDraft = { title: '', from: '', to: '', staff: true, text: '' };
  weekTeamView = false; mgrLastBuild = null; mgrBuilding = '';
  mgrDayCtx = null; mgrDayDraft = { text: '', title: '', from: '', to: '', staff: true }; mgrDayBusy = false; mgrEvWait = { week: '', items: [] };
  mgrTool = null; mgrToolBusy = false; mgrToolErr = ''; mgrRowDraft = { name: '', from: '', to: '' };
  mgrTypes = null; mgrTypesState = ''; mgrTypesChanged = false; mgrTypeFormOpen = false; mgrTypeDraft = null;
  mgrChugBusy = ''; mgrChugResult = null;
  renderMgrDay();
  renderMgrTool();
  renderMgrBuildSheet();
  renderMgrFresh();
  closeAppModal();   // a confirm opened by the previous manager must not stay on screen
  mgrStaffReset();   // stage 9: the staff cards, the person's sheet and the fold belong to the previous user
  mgrClockReset();   // stage 10: the same for the attendance fold and its person sheet
  renderMgrSaveBar(); renderMgrPicker();   // the bar and the sheet are position:fixed — emptying them is not enough, they must be hidden
}

/* ==================================================================
   Build the week from the phone (16/10). The same builder as the sheet's menu item (calendars, chugim, templates, the
   draft switch, a backup first) — the server allows next week, a rebuild of the week on the board, or the running week when
   the board holds one that is over; only for a manager's key, and checked again inside the builder's lock. A long fuse
   (4 minutes), one build at a time, and no automatic retry (it may have landed).
   ================================================================== */
var mgrLastBuild = null;   // the last build's answer, shown under the card until the next load (cleared on login and logout)
var mgrBuilding = '';       // the week being built right now — no second build while one runs (review 16/10, finding 3)

/**
 * The build card. What it offers (the server checks the same — mgrBuildWeekProblem_):
 * - a draft on the board that is not over yet and is not next week → publish it first; only a rebuild of it (finding 1);
 * - the board holds a week that is over (nobody built the running week) → build the running week first (finding 6);
 * - next week on the board → rebuild it; otherwise → build next week.
 */
function mgrBuildPlan(res) {
  if (!res) return null;
  var next = String(res.nextWeek == null ? '' : res.nextWeek), cur = String(res.currentWeek == null ? '' : res.currentWeek);
  var bs = res.board || {}, board = String(bs.week || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return null;   // an older server: no build from the phone
  var stale = !!cur && (!board || board < cur);
  var mode = stale ? 'current' : (bs.state === 'draft' && board && board !== next ? 'draftFirst' : (board === next ? 'rebuild' : 'next'));
  var target = mode === 'current' ? cur : (mode === 'next' ? next : board);
  return { res: res, next: next, cur: cur, board: board, published: bs.state === 'published', stale: stale, mode: mode, target: target,
           T: isoShort(target), B: isoShort(board), isRebuild: target === board };
}

/**
 * The build button (the card's, the strip's, the tools sheet's). Stage 7: first the sheet "אירועי השבוע" - the events of the week
 * from the calendars, who needs staff, what to add - and only its button goes on to the confirm and the build.
 */
function mgrAskBuild(pl) {
  if (mgrBuilding) { showToast('בנייה רצה עכשיו — לחכות שתסתיים.', 'error'); return; }
  mgrOpenBuildSheet(pl);
}

/** The confirm window of a build; plan = what the sheet collected (null = none), sum = its one-line summary. */
function mgrAskBuildConfirm(pl, plan, sum) {
  var res = pl.res, T = pl.T, B = pl.B, desc;
  if (pl.isRebuild) {
    desc = (pl.published ? 'שבוע ' + T + ' כבר פורסם — הבנייה מחדש נראית לצוות מיד. ' : 'שבוע ' + T + ' עדיין טיוטה — הצוות לא רואה אותו. ') +
      'מה ששובץ נשמר, חוץ מיום שנסגר או אירוע שבוטל (ההודעה אומרת מה ירד); היומנים, החוגים והתבניות מתעדכנים. לוקח עד כמה דקות.';
  } else {
    var st = res.submitStatus, miss = st && !st.error && !st.complete && st.missing ? st.missing.length : 0;
    desc = 'לבנות את שבוע ' + T + '? הוא נבנה כטיוטה — הצוות לא רואה אותו עד שתפרסם' +
      (pl.stale ? ' (בינתיים הצוות רואה "בבנייה")' : (B ? ', וממשיך לראות את שבוע ' + B : '')) + '. ' +
      'עד הפרסום בקשות ההחלפה של הצוות נעצרות (החלפות — ביד)' + (pl.target === pl.next ? ', וגם מיילי ההגשות לשבוע הזה' : '') + '.' +
      (pl.target === pl.next && miss ? ' עוד לא הגישו: ' + miss + '.' : '') + ' לוקח עד כמה דקות.';
  }
  if (plan && sum) desc += '\n\nנשלח יחד עם הבנייה: ' + sum + '.';
  openAppModal(pl.isRebuild ? 'בנייה מחדש' : 'בניית השבוע', desc, false, pl.isRebuild ? 'בנה מחדש' : 'בנה', function () {
    closeMgrBuildSheet();
    mgrBuildRun(pl.target, pl.board, plan);
  });
}

function renderMgrBuild(res) {
  var box = document.getElementById('mgrBuild');
  if (!box) return;
  box.innerHTML = '';
  if (mgrBuilding) {
    box.innerHTML = '<div class="card mgr-status"><div class="loader">בונה את שבוע ' + esc(isoShort(mgrBuilding)) +
      ' — יומנים, חוגים ותבניות. זה לוקח עד כמה דקות, לא לסגור את האפליקציה…</div></div>';
    mgrOpenFold('mgrDetBuild');
    return;
  }
  if (!res) return;
  var pl = mgrBuildPlan(res);
  if (!pl) {   // an older server without the build route: the chug switch (stage 8) still shows when the server has it
    var c0 = mgrChugCard(res);
    if (c0) box.appendChild(c0);
    return;
  }
  var T = pl.T, B = pl.B;
  var card = mgrEl('div', 'card mgr-status');
  var text = {
    next: 'השבוע הבא: ' + esc(isoShort(pl.next)) + (B ? ' · בלוח עכשיו: ' + esc(B) : '') + '. הבנייה מושכת חגים, אירועים וחוגים, ושומרת גיבוי קודם.',
    current: (B ? 'בלוח עדיין שבוע ' + esc(B) + ', שכבר נגמר. ' : 'אין שבוע בלוח. ') + 'קודם בונים את השבוע הנוכחי (' + esc(T) + '), ואחרי שמפרסמים — את הבא.',
    draftFirst: 'שבוע ' + esc(B) + ' בלוח עוד לא פורסם — לפרסם אותו (בכרטיס הפרסום) לפני שבונים את ' + esc(isoShort(pl.next)) + '. אפשר לבנות אותו מחדש:',
    rebuild: 'שבוע ' + esc(T) + ' כבר בלוח. בנייה מחדש שומרת את מה ששובץ ומעדכנת יומנים וחוגים.'
  }[pl.mode];
  card.innerHTML = '<b>🔨 בניית השבוע</b><div>' + text + '</div>';
  var b = mgrEl('button', 'btn btn-sm mgr-build'); b.type = 'button';
  b.textContent = pl.isRebuild ? '🔨 בנה מחדש את ' + T : '🔨 בנה את שבוע ' + T;
  b.onclick = function () { mgrAskBuild(pl); };
  card.appendChild(b);
  if (mgrLastBuild) { card.appendChild(mgrLastBuild); mgrOpenFold('mgrDetBuild'); }   // the answer of a build is not left folded
  box.appendChild(card);
  var cc = mgrChugCard(res);   // stage 8: the chugim switch and "refresh now"
  if (cc) box.appendChild(cc);
}

/** Opens one of the folded sections of the manager tab (a build answer, a build in progress). */
function mgrOpenFold(id) {
  var d = document.getElementById(id);
  if (d) d.open = true;
}

/** week = the week to build; expect = the board's week as this screen saw it (the server refuses if it changed meanwhile); plan = the sheet's plan (null = none). */
function mgrBuildRun(week, expect, plan) {
  if (mgrBuilding) return;   // one build at a time from this phone
  mgrBuilding = week;
  var evSent = mgrEvSeq;   // events added after this point were not seen by this build
  mgrLastBuild = null;
  renderMgrBuild(null);
  var gen = loginGen;
  var body = { week: week, expect: expect };
  if (plan) body.plan = plan;   // stage 7: events, notes and who-needs-staff go in the SAME request as the build; without a plan the request is as it always was
  api('mgrBuildWeek', body, { post: true, ms: 240000 }).then(function (r) {
    if (gen !== loginGen) return;   // logged out meanwhile (shared phone)
    mgrBuilding = '';
    var out = mgrEl('div', 'mgr-build-out');
    var failedN = 0;
    if (r && r.success) {
      if (mgrEvWait.week === String(week)) {   // the rebuild picked up the events added before it was sent; later ones keep waiting
        var still = mgrEvWait.items.filter(function (e) { return e.n > evSent; });
        mgrEvWait = still.length ? { week: mgrEvWait.week, items: still } : { week: '', items: [] };
      }
      if (plan) mgrPlanClear(week);   // the build took the plan (what it could not take is listed below): it is not kept for a second build
      var lines = String(r.message || '').split('\n').filter(function (l) { return l.trim(); });
      // 16/10: the first line and every warning stay in view; the rest is folded under "details (N)"
      // only pure information lines (ℹ️ / 🎓) are folded; everything else (warnings, errors, who sees which week) stays in view
      var isInfo = function (l) { return /^\s*(ℹ️|ℹ|🎓)/.test(l); };
      var warns = lines.slice(1).filter(function (l) { return !isInfo(l); });
      var rest = lines.slice(1).filter(isInfo);
      out.innerHTML = '<div class="mgr-ok">✅ ' + esc(lines[0] || 'נבנה') + '</div>' +
        (warns.length ? '<div class="mgr-legend mgr-warns">' + warns.map(esc).join('<br>') + '</div>' : '') +
        (rest.length ? '<details class="mgr-more"><summary>פרטים (' + rest.length + ')</summary><div class="mgr-legend">' + rest.map(esc).join('<br>') + '</div></details>' : '');
      // stage 7: what the build did with the plan - and every item it could not take, in red with the reason (nothing typed is dropped silently)
      var pr = r.planResult && typeof r.planResult === 'object' ? r.planResult : null;
      if (pr) {
        var took = mgrCountsText(Number(pr.events) || 0, Number(pr.notes) || 0, Number(pr.overrides) || 0);
        if (took) out.appendChild(mgrEl('div', 'mgr-legend mgr-plan-res', '📅 מהרשימה נכנסו: ' + esc(took)));
        (Array.isArray(pr.failed) ? pr.failed : []).forEach(function (f) {
          failedN++;
          out.appendChild(mgrEl('div', 'mgr-note mgr-plan-fail', '❌ ' + esc(f && f.what != null ? f.what : '') + (f && f.why ? ' — ' + esc(f.why) : '')));
        });
      }
      showToast(failedN ? 'השבוע נבנה, אבל ' + failedN + (failedN === 1 ? ' פריט' : ' פריטים') + ' מהרשימה לא נכנסו — הפירוט בכרטיס הבנייה' : 'השבוע נבנה ✓', failedN ? 'error' : 'success');
    } else if (r && r.transport) {
      out.innerHTML = '<div class="mgr-note">לא התקבלה תשובה. ייתכן שהבנייה עוד רצה — לרענן בעוד כמה דקות ולבדוק איזה שבוע בלוח, לפני שבונים שוב.' +
        (plan ? ' מה שרשמת ברשימת האירועים נשמר במכשיר.' : '') + '</div>';
    } else {
      out.innerHTML = '<div class="mgr-note">❌ לא נבנה: ' + esc(r ? r.error : '') +
        (r && r.midway ? '<br>אם הלוח בגיליון נראה ריק או חלקי — השבוע הקודם שמור בטאב "גיבוי …" האחרון.' : '') +
        (plan ? '<br>מה שרשמת ברשימת האירועים נשמר במכשיר — אפשר לנסות שוב.' : '') + '</div>';
    }
    mgrLastBuild = out;
    // stage 7: a successful build answers with the new board - drawn at once; only the overview (status, strip, cards) is read again
    if (r && r.success && mgrBoardFromAnswer(r)) loadMgrOverview();
    else loadManager();   // the status, the board for assigning and this card again — with the answer under it
  });
}

/* ==================================================================
   Stage 7 (17/10): the week's events, asked BEFORE the build. A full-screen sheet opens from every build button: ONE request
   (mgrWeekEvents) lists, per day, the events the builder will see (same calendars, same filing) and whether each one needs a
   shop worker; the manager flips the ones that are wrong and adds what is missing (an event, a note). Nothing is sent until
   "build": then ONE request carries the build and the plan (mgrBuildWeek {week, expect, plan}), and the server checks all of it
   before it writes anything. The plan lives in memory and in localStorage, per week, so nothing typed is lost if the app closes.
   Every value from the server goes through esc(); the plan is checked here with the same rules as the server (one wrong item
   would refuse the whole build).
   ================================================================== */
var MGR_PLAN_MAX_OV = 60, MGR_PLAN_MAX_EV = 30, MGR_PLAN_MAX_NOTE = 30;
var MGR_KIND_LABEL = { oneshot: 'וואן-שוט', community: 'ערב קהילה' };
var MGR_OV_KEY_RE = /^\d{4}-\d{2}-\d{2}\|/;

function mgrPlanNew(week) { return { week: week, overrides: {}, events: [], notes: [] }; }
function mgrPlanEmpty(p) { return !p || (!Object.keys(p.overrides).length && !p.events.length && !p.notes.length); }

/** Why an event cannot go in (the server's own rules, so that a wrong item is stopped here and not by a refusal of the whole build), or "". */
function mgrEventProblem(title, from, to) {
  var T = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (title.length < 2 || title.length > 80) return 'שם האירוע צריך להיות בין 2 ל-80 תווים.';
  if (/[\[\]]/.test(title)) return 'בשם האירוע אי אפשר סוגריים מרובעים.';
  if (/^[=+\-@]/.test(title)) return 'שם האירוע לא יכול להתחיל ב-' + title.charAt(0) + '.';
  if ((from && !T.test(from)) || (to && !T.test(to))) return 'שעה לא תקינה — למשל 18:00.';
  if (to && !from) return 'שעת סיום אפשר רק יחד עם שעת התחלה.';
  if (to && to <= from) return 'שעת הסיום צריכה להיות אחרי שעת ההתחלה.';
  return '';
}
/**
 * An event that NEEDS a store worker must be one the builder gives a worker row (the server's calendarTitleKind_ = "worker"): a release, a
 * "learning Yu-Gi-Oh" evening, a one-shot and a community evening are only notes. The server refuses the WHOLE build for such an item, so the
 * phone says it when the item is added. The words are the server's; if the server's rule changes, only a too-lenient phone is harmless
 * (the server still refuses with its reason), a too-strict one is not - keep the two in step.
 */
function mgrWorkerKindProblem(title) {
  var t = String(title == null ? '' : title).toLowerCase();
  if ((t.indexOf('release') !== -1 || t.indexOf('השקה') !== -1) && t.indexOf('טורניר') === -1 && t.indexOf('prerelease') === -1 && t.indexOf('mamo') === -1) {
    return 'השקה נכנסת ללוח כשורת מידע ולא כשורה לעובד — לרשום אותה כהערה ליום (בלי לסמן שצריך עובד חנות).';
  }
  if (t.indexOf('לימוד יוגיהו') !== -1) return 'אירוע כזה לא נכנס ללוח בכלל — אין צורך לרשום אותו.';
  if (/one[\s-]?shot|וואן[\s-]?שוט/.test(t) || t.indexOf('נטראנר') !== -1) return 'וואן שוט וערב קהילה לא מקבלים עובד חנות בלוח — לרשום כהערה ליום (בלי לסמן שצריך עובד חנות).';
  return '';
}
function mgrNoteProblem(text) { return text.length < 1 || text.length > 120 ? 'ההערה צריכה להיות בין תו אחד ל-120 תווים.' : ''; }

/** A plan read back from storage: anything that is not the exact shape is dropped, so a damaged copy cannot make the server refuse a build. */
function mgrPlanClean(raw, week) {
  var p = mgrPlanNew(week);
  if (!raw || typeof raw !== 'object') return p;
  var ov = raw.overrides && typeof raw.overrides === 'object' && !Array.isArray(raw.overrides) ? raw.overrides : {};
  Object.keys(ov).forEach(function (k) {
    if (typeof ov[k] === 'boolean' && k.length <= 200 && MGR_OV_KEY_RE.test(k) && Object.keys(p.overrides).length < MGR_PLAN_MAX_OV) p.overrides[k] = ov[k];
  });
  (Array.isArray(raw.events) ? raw.events : []).forEach(function (e) {
    if (!e || typeof e !== 'object' || p.events.length >= MGR_PLAN_MAX_EV) return;
    var day = String(e.day == null ? '' : e.day), title = mgrFold(e.title), from = String(e.from == null ? '' : e.from).trim(), to = String(e.to == null ? '' : e.to).trim();
    if (/^\d{2}\/\d{2}$/.test(day) && !mgrEventProblem(title, from, to)) p.events.push({ n: ++mgrBsN, day: day, title: title, from: from, to: to, staff: e.staff !== false });
  });
  (Array.isArray(raw.notes) ? raw.notes : []).forEach(function (n) {
    if (!n || typeof n !== 'object' || p.notes.length >= MGR_PLAN_MAX_NOTE) return;
    var day = String(n.day == null ? '' : n.day), text = mgrFold(n.text);
    if (/^\d{2}\/\d{2}$/.test(day) && !mgrNoteProblem(text)) p.notes.push({ n: ++mgrBsN, day: day, text: text });
  });
  return p;
}

function mgrPlanLoad(week) {
  var id = identityKey(), all = id ? SafeStorage.get(MGR_PLAN_KEY + id) : null;
  return mgrPlanClean(all && typeof all === 'object' && !Array.isArray(all) ? all[week] : null, week);
}

/** Writes the open plan (an empty one removes its entry); at most four weeks are kept. */
function mgrPlanSave() {
  var p = mgrBsPlan, id = identityKey();
  if (!p || !id) return;
  var all = SafeStorage.get(MGR_PLAN_KEY + id);
  if (!all || typeof all !== 'object' || Array.isArray(all)) all = {};
  if (mgrPlanEmpty(p)) delete all[p.week]; else all[p.week] = { overrides: p.overrides, events: p.events, notes: p.notes };
  var weeks = Object.keys(all).sort();
  while (weeks.length > 4) delete all[weeks.shift()];
  if (weeks.length) SafeStorage.set(MGR_PLAN_KEY + id, all); else SafeStorage.remove(MGR_PLAN_KEY + id);
}

/** The build took the plan: it goes from memory and from storage. */
function mgrPlanClear(week) {
  if (mgrBsPlan && mgrBsPlan.week === week) mgrBsPlan = mgrPlanNew(week);
  var id = identityKey();
  if (!id) return;
  var all = SafeStorage.get(MGR_PLAN_KEY + id);
  if (!all || typeof all !== 'object' || Array.isArray(all)) return;
  delete all[week];
  if (Object.keys(all).length) SafeStorage.set(MGR_PLAN_KEY + id, all); else SafeStorage.remove(MGR_PLAN_KEY + id);
}

/** What goes to the server: {overrides:[{key, staff}], events:[{day, title, from, to, staff}], notes:[{day, text}]}, or null when there is nothing. */
function mgrPlanPayload(p) {
  if (mgrPlanEmpty(p)) return null;
  return {
    overrides: Object.keys(p.overrides).map(function (k) { return { key: k, staff: p.overrides[k] }; }),
    events: p.events.map(function (e) { return { day: e.day, title: e.title, from: e.from, to: e.to, staff: !!e.staff }; }),
    notes: p.notes.map(function (n) { return { day: n.day, text: n.text }; })
  };
}

function mgrCountsText(ne, nn, no) {
  var parts = [];
  if (ne) parts.push(ne === 1 ? '1 אירוע חדש' : ne + ' אירועים חדשים');
  if (nn) parts.push(nn === 1 ? '1 הערה' : nn + ' הערות');
  if (no) parts.push(no === 1 ? '1 שינוי צוות' : no + ' שינויי צוות');
  return parts.join(' · ');
}
function mgrPlanSummary(p) { return p ? mgrCountsText(p.events.length, p.notes.length, Object.keys(p.overrides).length) : ''; }

function mgrBsDraftReset() { mgrBsDraft = { title: '', from: '', to: '', staff: true, text: '' }; }

/** The server's warnings about the list (a calendar it could not read, an override store it ignored...): the non-empty texts, at most 8. */
function mgrBsWarnings(bs) {
  var w = bs && bs.data && Array.isArray(bs.data.warnings) ? bs.data.warnings : [];
  return w.map(function (x) { return mgrFold(x); }).filter(function (x) { return x; }).slice(0, 8);
}

/** The chugim file's own warnings (stage 8): a file not read, an hour or day it has in a format that cannot be read, chugs that fit no row. Apart from the calendars'. At most 8. */
function mgrBsChugWarnings(bs) {
  var w = bs && bs.data && Array.isArray(bs.data.chugWarnings) ? bs.data.chugWarnings : [];
  return w.map(function (x) { return mgrFold(x); }).filter(function (x) { return x; }).slice(0, 8);
}

/** "dd/MM" of the Sunday of the week and of its Friday. */
function mgrBsDates(bs) {
  var a = isoShort(bs.week), m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(bs.week));
  if (!m || !a) return a;
  var f = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 5));
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return a + '–' + pad(f.getUTCDate()) + '/' + pad(f.getUTCMonth() + 1);
}

function mgrOpenBuildSheet(pl) {
  mgrBs = { pl: pl, week: pl.target, state: 'loading', data: null, err: '', form: null };
  mgrBsPlan = mgrPlanLoad(pl.target);
  mgrBsDraftReset();
  mgrBsScroll = 0;
  mgrBsLoad();
}

function closeMgrBuildSheet() {
  mgrBsSeq++;   // an answer still on its way is not drawn
  mgrBs = null;   // the plan stays: in memory and in storage, until a build takes it
  renderMgrBuildSheet();
}

/** The ONE request of the sheet. The skeleton is on screen before it is sent. */
function mgrBsLoad() {
  var bs = mgrBs;
  if (!bs) return;
  var seq = ++mgrBsSeq, gen = loginGen;
  bs.state = 'loading'; bs.err = '';
  renderMgrBuildSheet();
  api('mgrWeekEvents', { week: bs.week }, { ms: 45000 }).then(function (r) {
    if (gen !== loginGen || seq !== mgrBsSeq || mgrBs !== bs) return;   // logged out, closed, or a newer ask
    if (r && r.success && Array.isArray(r.days)) { bs.data = r; bs.state = 'ready'; mgrBsPrune(r); }
    else { bs.state = 'error'; bs.err = r && r.transport ? 'לא התקבלה תשובה מהשרת.' : (r && r.error ? String(r.error) : 'השרת לא החזיר את האירועים.'); }
    renderMgrBuildSheet();
  });
}

/** A stored "who needs staff" change is dropped when its event is no longer in the list, or the list already says the same. */
function mgrBsPrune(r) {
  var p = mgrBsPlan, seen = Object.create(null), changed = false;
  (r.days || []).forEach(function (d) {
    (d && d.events || []).forEach(function (e) { if (e && e.key != null) seen[String(e.key)] = !!e.staff; });
  });
  Object.keys(p.overrides).forEach(function (k) {
    if (!(k in seen) || seen[k] === p.overrides[k]) { delete p.overrides[k]; changed = true; }
  });
  if (changed) mgrPlanSave();
}

function mgrBsSetStaff(ev, v) {
  var p = mgrBsPlan, key = String(ev.key == null ? '' : ev.key), has = Object.prototype.hasOwnProperty.call(p.overrides, key);
  if (v === !!ev.staff) delete p.overrides[key];   // back to what the calendar said: no change to send
  else if (!has && Object.keys(p.overrides).length >= MGR_PLAN_MAX_OV) { showToast('יותר מדי שינויי צוות בבנייה אחת (עד ' + MGR_PLAN_MAX_OV + ').', 'error'); return; }
  else p.overrides[key] = v;
  mgrPlanSave();
  renderMgrBuildSheet();
}

function mgrBsAddEvent(day) {
  var d = mgrBsDraft, p = mgrBsPlan;
  var title = mgrFold(d.title), from = String(d.from || '').trim(), to = String(d.to || '').trim();
  var bad = mgrEventProblem(title, from, to);
  if (!bad && d.staff) bad = mgrWorkerKindProblem(title);   // a worker row for a one-shot / release: the server would refuse the whole build
  if (!bad && p.events.length >= MGR_PLAN_MAX_EV) bad = 'יותר מדי אירועים חדשים בבנייה אחת (עד ' + MGR_PLAN_MAX_EV + ').';
  if (!bad && p.events.some(function (e) { return e.day === day && e.title === title && e.from === from && e.to === to; })) bad = 'האירוע הזה כבר ברשימה.';
  if (bad) { showToast(bad, 'error'); return; }
  p.events.push({ n: ++mgrBsN, day: day, title: title, from: from, to: to, staff: !!d.staff });
  mgrBsDraftReset();
  if (mgrBs) mgrBs.form = null;
  mgrPlanSave();
  renderMgrBuildSheet();
}

function mgrBsAddNote(day) {
  var p = mgrBsPlan, text = mgrFold(mgrBsDraft.text);
  var bad = mgrNoteProblem(text);
  if (!bad && p.notes.length >= MGR_PLAN_MAX_NOTE) bad = 'יותר מדי הערות בבנייה אחת (עד ' + MGR_PLAN_MAX_NOTE + ').';
  if (!bad && p.notes.some(function (n) { return n.day === day && n.text === text; })) bad = 'ההערה הזאת כבר ברשימה.';
  if (bad) { showToast(bad, 'error'); return; }
  p.notes.push({ n: ++mgrBsN, day: day, text: text });
  mgrBsDraftReset();
  if (mgrBs) mgrBs.form = null;
  mgrPlanSave();
  renderMgrBuildSheet();
}

/** The sheet's build button: text still waiting in the open form is not left behind - then the same confirm as always, with the plan. */
function mgrBsBuild() {
  var bs = mgrBs;
  if (!bs || bs.state !== 'ready') return;
  if (mgrBuilding) { showToast('בנייה רצה עכשיו — לחכות שתסתיים.', 'error'); return; }
  if (bs.form && (mgrFold(mgrBsDraft.title) || mgrFold(mgrBsDraft.text))) {
    showToast('יש טקסט בטופס שעוד לא נוסף לרשימה — ללחוץ "הוסף", או "ביטול".', 'error');
    return;
  }
  mgrAskBuildConfirm(bs.pl, mgrPlanPayload(mgrBsPlan), mgrPlanSummary(mgrBsPlan));
}

function mgrBsInput(cls, ph, max, type, key) {
  var el = document.createElement('input');
  el.type = type || 'text'; el.className = 'mgr-bs-in ' + cls; el.maxLength = max; el.placeholder = ph; el.value = mgrBsDraft[key];
  el.oninput = function () { mgrBsDraft[key] = el.value; };
  return el;
}

function mgrBsFormEl(day) {
  var f = mgrBs.form, d = mgrBsDraft;
  var el = mgrEl('div', 'mgr-bs-form');
  var acts = mgrEl('div', 'mgr-bs-formacts');
  var go = mgrEl('button', 'btn mgr-bs-formgo'); go.type = 'button';
  var no = mgrEl('button', 'btn btn-secondary mgr-bs-formno'); no.type = 'button'; no.textContent = 'ביטול';
  no.onclick = function () { mgrBsDraftReset(); if (mgrBs) mgrBs.form = null; renderMgrBuildSheet(); };
  if (f.kind === 'event') {
    var tin = mgrBsInput('mgr-bs-title-in', 'שם האירוע', 80, 'text', 'title');
    if (mgrBsFocus) mgrBsFocusEl = tin;
    el.appendChild(tin);
    var tm = mgrEl('div', 'mgr-bs-times');
    tm.appendChild(mgrEl('label', 'mgr-day-lbl', 'מ-'));
    tm.appendChild(mgrBsInput('mgr-bs-from', 'HH:MM', 5, 'time', 'from'));
    tm.appendChild(mgrEl('label', 'mgr-day-lbl', 'עד'));
    tm.appendChild(mgrBsInput('mgr-bs-to', 'HH:MM', 5, 'time', 'to'));
    el.appendChild(tm);
    var lab = mgrEl('label', 'mgr-bs-chk');
    var cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'mgr-bs-staff'; cb.checked = !!d.staff;
    var hint = mgrEl('div', 'mgr-legend mgr-bs-hint');
    var setHint = function () { hint.textContent = d.staff ? 'האירוע נשמר ביומן האירועים הידניים, ובלוח יהיה לו מקום לשבץ עובד חנות.' : 'בלי עובד חנות - האירוע נרשם כהערה ליום.'; };
    cb.onchange = function () { d.staff = !!cb.checked; setHint(); };
    lab.appendChild(cb);
    lab.appendChild(mgrEl('span', 'mgr-bs-chk-t', ' צריך עובד חנות'));
    el.appendChild(lab);
    setHint();
    el.appendChild(hint);
    go.textContent = 'הוסף אירוע';
    go.onclick = function () { mgrBsAddEvent(day); };
  } else {
    var nin = mgrBsInput('mgr-bs-text-in', 'שורה אחת לצוות, עד 120 תווים', 120, 'text', 'text');
    if (mgrBsFocus) mgrBsFocusEl = nin;
    el.appendChild(nin);
    go.textContent = 'הוסף הערה';
    go.onclick = function () { mgrBsAddNote(day); };
  }
  acts.appendChild(go); acts.appendChild(no);
  el.appendChild(acts);
  return el;
}

/** One calendar event of the list: title, time, who leads it (one-shot), and the big two-state switch. */
function mgrBsEventEl(ev) {
  var p = mgrBsPlan, key = String(ev.key == null ? '' : ev.key);
  var over = Object.prototype.hasOwnProperty.call(p.overrides, key);
  var eff = over ? p.overrides[key] : !!ev.staff;
  var kind = MGR_KIND_LABEL[ev.kind] || '';
  var el = mgrEl('div', 'mgr-bs-ev' + (over ? ' changed' : ''));
  el.appendChild(mgrEl('div', 'mgr-bs-evt', '<b>' + esc(ev.title) + '</b>' + (ev.time ? ' <bdi class="mgr-bs-time">' + esc(ev.time) + '</bdi>' : '') +
    (kind ? ' <span class="mgr-bs-kind">' + esc(kind) + '</span>' : '') + (ev.manual ? ' <span class="mgr-bs-kind">נוסף מהאפליקציה</span>' : '')));
  if (ev.kind === 'oneshot') el.appendChild(mgrEl('div', 'mgr-legend mgr-bs-fac', ev.facilitator ? 'מנחה: ' + esc(ev.facilitator) : 'אין מנחה'));
  var tg = mgrEl('div', 'mgr-bs-tg');
  [[true, '👥 צריך צוות', 'mgr-ev-yes'], [false, 'בלי צוות', 'mgr-ev-no']].forEach(function (o) {
    var b = mgrEl('button', 'mgr-bs-tgb ' + o[2] + (eff === o[0] ? ' on' : '')); b.type = 'button'; b.textContent = o[1];
    b.setAttribute('aria-pressed', eff === o[0] ? 'true' : 'false');
    b.onclick = function () { mgrBsSetStaff(ev, o[0]); };
    tg.appendChild(b);
  });
  el.appendChild(tg);
  return el;
}

function mgrBsUndoBtn(fn) {
  var x = mgrEl('button', 'mgr-bs-undo'); x.type = 'button'; x.textContent = '✕'; x.setAttribute('aria-label', 'בטל');
  x.onclick = fn;
  return x;
}

/** The clash lines of one day: the day's own list and the answer's list filtered by the day ("dd/MM"); a string or {text}; each text once. */
function mgrBsDayClashes(data, d) {
  var out = [], seen = Object.create(null);
  var add = function (x) { var t = mgrChugLine(x); if (t && !seen[t]) { seen[t] = true; out.push(t); } };
  (Array.isArray(d.clashes) ? d.clashes : []).forEach(add);
  (data && Array.isArray(data.clashes) ? data.clashes : []).forEach(function (x) { if (x && typeof x === 'object' && String(x.day) === String(d.short)) add(x); });
  return out;
}

function mgrBsDayEl(d) {
  var bs = mgrBs, p = mgrBsPlan, closed = !!d.closed, short = String(d.short == null ? '' : d.short);
  var card = mgrEl('div', 'card mgr-bs-day' + (closed ? ' closed' : ''));
  card.appendChild(mgrEl('div', 'mgr-bs-dayh', '<b>' + esc((d.name || '') + ' ' + short) + '</b>' + (closed ? ' <span>סגור' + (d.closedWhy ? ' — ' + esc(d.closedWhy) : '') + '</span>' : '')));
  if (closed) return card;   // nothing to ask on a closed day
  // stage 8: a chug in the store at the time of a store event - said BEFORE the build, at the top of the day, in the warning style
  mgrBsDayClashes(bs.data, d).forEach(function (t) { card.appendChild(mgrEl('div', 'mgr-note mgr-bs-clash', '⚠️ ' + esc(t))); });
  (Array.isArray(d.releases) ? d.releases : []).forEach(function (rl) {
    var t = rl && typeof rl === 'object' ? (rl.title || rl.text || rl.name || '') : rl;
    if (String(t == null ? '' : t).trim()) card.appendChild(mgrEl('div', 'mgr-legend mgr-bs-rel', '🎉 ' + esc(t)));
  });
  if (d.absences) card.appendChild(mgrEl('div', 'mgr-legend mgr-bs-abs', '🏖 נעדרים: ' + esc(d.absences)));
  String(d.note == null ? '' : d.note).split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l; }).forEach(function (l) {
    card.appendChild(mgrEl('div', 'mgr-legend mgr-bs-note', '📌 ' + esc(l)));
  });
  var evs = Array.isArray(d.events) ? d.events : [];
  // while the server says something was not read, an empty day is not "no events": it may be a calendar that was not read (a manual copy of it would be doubled later)
  if (!evs.length) card.appendChild(mgrEl('div', 'mgr-legend mgr-bs-none', mgrBsWarnings(bs).length ? 'לא ידוע אם יש אירועים ביום הזה — ראו את האזהרה למעלה.' : 'אין אירועים ביומנים ביום הזה.'));
  evs.forEach(function (ev) { if (ev) card.appendChild(mgrBsEventEl(ev)); });
  var chs = (Array.isArray(d.chugs) ? d.chugs : []).filter(function (c) { return c && typeof c === 'object'; });
  if (chs.length) {   // stage 8: the chugim file's classes of this day (the same read the build uses), small, under the events
    var cbox = mgrEl('div', 'mgr-bs-chugs');
    cbox.appendChild(mgrEl('div', 'mgr-legend mgr-bs-chugh', 'חוגים ביום הזה (מקובץ החוגים):'));
    chs.forEach(function (c) {
      cbox.appendChild(mgrEl('div', 'mgr-legend mgr-bs-chug', '🎓 ' + esc(c.room) + (c.from ? ' <bdi>' + esc(c.from) + (c.to ? '–' + esc(c.to) : '') + '</bdi>' : '') + (c.who ? ' · ' + esc(c.who) : '')));
    });
    card.appendChild(cbox);
  }
  p.events.filter(function (e) { return e.day === short; }).forEach(function (e) {
    var line = mgrEl('div', 'mgr-bs-new mgr-bs-newev', '<span>＋ <b>' + esc(e.title) + '</b>' + (e.from ? ' <bdi>' + esc(e.from + (e.to ? '–' + e.to : '')) + '</bdi>' : '') +
      ' · ' + (e.staff ? '👥 צריך צוות' : 'בלי צוות (הערה ליום)') + '</span>');
    line.appendChild(mgrBsUndoBtn(function () { p.events = p.events.filter(function (x) { return x.n !== e.n; }); mgrPlanSave(); renderMgrBuildSheet(); }));
    card.appendChild(line);
  });
  p.notes.filter(function (n) { return n.day === short; }).forEach(function (n) {
    var line = mgrEl('div', 'mgr-bs-new mgr-bs-newnote', '<span>📝 ' + esc(n.text) + '</span>');
    line.appendChild(mgrBsUndoBtn(function () { p.notes = p.notes.filter(function (x) { return x.n !== n.n; }); mgrPlanSave(); renderMgrBuildSheet(); }));
    card.appendChild(line);
  });
  var acts = mgrEl('div', 'mgr-bs-acts');
  [['event', '+ אירוע', 'mgr-bs-addev'], ['note', '+ הערה', 'mgr-bs-addnote']].forEach(function (m) {
    var open = !!(bs.form && bs.form.day === short && bs.form.kind === m[0]);
    var b = mgrEl('button', 'btn btn-secondary mgr-bs-add ' + m[2] + (open ? ' on' : '')); b.type = 'button'; b.textContent = m[1];
    b.onclick = function () { mgrBsDraftReset(); bs.form = open ? null : { day: short, kind: m[0] }; mgrBsFocus = !open; renderMgrBuildSheet(); };
    acts.appendChild(b);
  });
  card.appendChild(acts);
  if (bs.form && bs.form.day === short) card.appendChild(mgrBsFormEl(short));
  return card;
}

/** The whole sheet: the skeleton while the one request is on its way, the days when it is back, the error with a way on if it failed. */
function renderMgrBuildSheet() {
  var box = document.getElementById('mgrBuildSheet');
  if (!box) return;
  var bs = mgrBs;
  box.innerHTML = '';
  if (!bs) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  var pl = bs.pl;
  var head = mgrEl('div', 'mgr-bs-head');
  head.appendChild(mgrEl('b', 'mgr-bs-titlet', 'אירועי השבוע · ' + esc(mgrBsDates(bs))));
  var xb = mgrEl('button', 'mgr-x mgr-bs-x'); xb.type = 'button'; xb.textContent = '✕'; xb.setAttribute('aria-label', 'סגור'); xb.onclick = closeMgrBuildSheet;
  head.appendChild(xb);
  box.appendChild(head);
  var body = mgrEl('div', 'mgr-bs-body');
  body.appendChild(mgrEl('div', 'mgr-legend mgr-bs-intro', 'אלה האירועים שהבנייה תראה בכל יום. לכל אחד — צריך עובד חנות או לא. מוסיפים מה שחסר, ורק אחר כך בונים.'));
  if (bs.state === 'loading') {
    for (var i = 0; i < 6; i++) body.appendChild(mgrEl('div', 'mgr-skel'));
  } else if (bs.state === 'error') {
    var er = mgrEl('div', 'card mgr-bs-err', '<div class="mgr-note">⚠️ האירועים לא נטענו: ' + esc(bs.err) + '</div>');
    var rt = mgrEl('button', 'btn mgr-bs-retry'); rt.type = 'button'; rt.textContent = '↻ נסה שוב';
    rt.onclick = mgrBsLoad;
    er.appendChild(rt);
    var nob = mgrEl('button', 'btn btn-secondary mgr-bs-nolist'); nob.type = 'button'; nob.textContent = 'לבנות בלי לראות את האירועים';
    nob.onclick = function () { mgrAskBuildConfirm(pl, null, ''); };
    er.appendChild(nob);
    body.appendChild(er);
  } else {
    var warns = mgrBsWarnings(bs);
    if (warns.length) {
      body.appendChild(mgrEl('div', 'card mgr-note mgr-bs-warn', '<b>⚠️ הרשימה עלולה להיות חלקית:</b><br>' + warns.map(esc).join('<br>') +
        '<br>לפני שמוסיפים אירוע ידנית — לוודא שהוא באמת חסר ביומן.'));
    }
    var cw = mgrBsChugWarnings(bs);
    if (cw.length) {   // about the chugim file, not the calendars: it does not turn an empty day into "unknown"
      body.appendChild(mgrEl('div', 'card mgr-note mgr-bs-chugwarn', '<b>⚠️ החוגים:</b><br>' + cw.map(esc).join('<br>') +
        '<br>החוגים שמוצגים בימים עלולים להיות חלקיים.'));
    }
    (bs.data.days || []).forEach(function (d) { if (d) body.appendChild(mgrBsDayEl(d)); });
  }
  body.onscroll = function () { mgrBsScroll = body.scrollTop; };
  box.appendChild(body);
  var bar = mgrEl('div', 'mgr-bs-bar');
  var sum = mgrPlanSummary(mgrBsPlan);
  bar.appendChild(mgrEl('div', 'mgr-bs-sum', sum ? esc(sum) : 'בלי שינויים — בונים לפי מה שביומנים'));
  var go = mgrEl('button', 'btn mgr-bs-go'); go.type = 'button'; go.textContent = pl.isRebuild ? '🔨 בנה מחדש' : '🔨 בנה את השבוע';
  go.disabled = bs.state !== 'ready';
  go.onclick = mgrBsBuild;
  bar.appendChild(go);
  box.appendChild(bar);
  body.scrollTop = mgrBsScroll;
  if (mgrBsFocus && mgrBsFocusEl) {   // after the scroll position is restored, so that the form is the thing in view
    try { if (mgrBsFocusEl.scrollIntoView) mgrBsFocusEl.scrollIntoView({ block: 'center' }); if (mgrBsFocusEl.focus) mgrBsFocusEl.focus(); } catch (e) { /* a browser without it: the form is still there */ }
  }
  mgrBsFocus = false; mgrBsFocusEl = null;
}

/* ==================================================================
   The WhatsApp image from the phone (16/10): the table as the team sees it in the WhatsApp group — the same table the
   sheet's dialog photographs (whatsAppTableHtml_), with the title, rendered by html2canvas (the dialog's file and hash),
   then the phone's share sheet (or a download). The manager's own highlight is taken off: this is a picture for everyone.
   ================================================================== */
var H2C_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
var H2C_SRI = 'sha512-BNaRQnYJYiPSqHHDb58B0yaPfCu+Wgds8Gp/gU33kqBtgNS4tSPHuGibyoeqMV/TJlSKda6FXzoEyYGjTe+vXA==';
var h2cLoading = null;

function loadHtml2canvas() {
  if (typeof window.html2canvas === 'function') return Promise.resolve(window.html2canvas);
  if (h2cLoading) return h2cLoading;
  h2cLoading = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = H2C_URL; s.integrity = H2C_SRI; s.crossOrigin = 'anonymous'; s.referrerPolicy = 'no-referrer';
    s.onload = function () { typeof window.html2canvas === 'function' ? resolve(window.html2canvas) : reject(new Error('no html2canvas')); };
    s.onerror = function () { h2cLoading = null; reject(new Error('load failed')); };
    document.body.appendChild(s);
  });
  return h2cLoading;
}

/** The node to photograph: the title and the (allow-listed) table, without the viewer's own highlight. */
function waCaptureNode(tableHtml) {
  var node = document.createElement('div');
  node.className = 'wa-capture';
  node.innerHTML = '<h2>FREAK TLV — סידור עבודה שבועי 🎲</h2>' + sanitizeTableHtml(tableHtml).replace(/ class="([^"]*)"/g, function (m, c) {
    var keep = c.split(/\s+/).filter(function (x) { return x && x !== 'me' && x !== 'mine'; });
    return keep.length ? ' class="' + keep.join(' ') + '"' : '';
  });
  return node;
}

function waImageShare(src) {
  var wb = src || lastWeekBoard;
  var t = wb && wb.table, bd = (wb && wb.board) || {};
  if (!t || !t.html) { showToast('אין טבלה להצגה — לפתוח את תצוגת הטבלה ולנסות שוב.', 'error'); return; }
  // what the manager sees on the board right now: the draft (not published yet) or what the team sees
  var draft = !!(bd.draft && bd.managerView);
  showToast('מכין תמונה…', 'info');
  var gen = loginGen;
  var node = waCaptureNode(t.imageHtml || t.html);   // imageHtml: the server's table with nobody's highlight (managers)
  document.body.appendChild(node);
  loadHtml2canvas().then(function (h2c) {
    return h2c(node, { scale: 2, backgroundColor: '#ffffff' });
  }).then(function (canvas) {
    node.remove();
    canvas.toBlob(function (blob) {
      if (gen !== loginGen) return;   // logged out while it was drawing (shared phone) — not offered to the next person
      if (!blob) { showToast('התמונה לא נוצרה — לצלם מסך מהטבלה.', 'error'); return; }
      // The share sheet needs a fresh tap: after loading the library and drawing, the first tap's permission has
      // expired (iPhone refuses the share silently). So the share runs from the confirm button of this window.
      openAppModal('תמונה לוואטסאפ', draft ? '⚠️ זו הטיוטה — הצוות עוד לא רואה את השבוע הזה באפליקציה. לשתף בכל זאת?'
                                             : 'התמונה מוכנה — לשתף אותה לקבוצה?', false, '📤 שתף', function () { waShareBlob(blob); });
    }, 'image/png');
  }).catch(function () {
    node.remove();
    showToast('ספריית התמונה לא נטענה (אין רשת?) — לנסות שוב, או לצלם מסך מהטבלה.', 'error');
  });
}

/** The phone's share sheet with the picture; where files cannot be shared (a computer) — a download. */
function waShareBlob(blob) {
  var file = typeof File === 'function' ? new File([blob], 'FREAK_Schedule.png', { type: 'image/png' }) : null;
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: 'סידור עבודה' }).catch(function (e) {
      if (!e || e.name !== 'AbortError') waDownloadBlob(blob);   // refused (not cancelled by the user) — download instead
    });
    return;
  }
  waDownloadBlob(blob);
}

function waDownloadBlob(blob) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'FREAK_Schedule.png';
  document.body.appendChild(a); a.click(); a.remove();
  showToast('התמונה ירדה — לשלוח אותה בקבוצה.', 'success');
}

/** 16/10: who has submitted constraints for next week — the same status the evening email sends (22_SubmitAlert.gs). */
function renderMgrSubmit(s) {
  var box = document.getElementById('mgrSubmit');
  if (!box) return;
  box.innerHTML = '';
  if (!s) return;   // an older server
  if (s.error) { box.appendChild(mgrEl('p', 'mgr-note', '⚠️ מצב ההגשות לא נקרא: ' + esc(s.error))); return; }
  var wk = String(s.week == null ? '' : s.week).slice(0, 5);
  var sub = s.submitted || [], miss = s.missing || [], absent = s.absent || [];
  var card = mgrEl('div', 'card mgr-status ' + (s.complete ? 'live' : 'draft'));
  card.innerHTML = s.complete
    ? '<b>✅ כולם הגישו לשבוע ' + esc(wk) + ' — אפשר לבנות</b>'
    : '<b>📬 הגשות לשבוע ' + esc(wk) + ': ' + esc(sub.length) + ' מתוך ' + esc(s.required) + '</b>' +
      (miss.length ? '<div>חסרים: ' + esc(miss.map(function (m) { return m.name; }).join(', ')) + '</div>' : '');
  if (sub.length) card.appendChild(mgrEl('div', 'mgr-legend', 'הגישו: ' + esc(sub.map(function (x) { return x.name + (x.fixed ? ' 🔁' : ''); }).join(', '))));
  if (!s.required) card.appendChild(mgrEl('div', 'mgr-note', '⚠️ לא נמצא אף אחד שצריך להגיש — לבדוק בטאב עובדים את העמודה "נספר בתקציב השעות".'));
  if (absent.length) card.appendChild(mgrEl('div', 'mgr-legend', 'בהיעדרות כל השבוע, לא נדרשים: ' + esc(absent.join(', '))));
  if ((s.extra || []).length) card.appendChild(mgrEl('div', 'mgr-legend', 'הגישו גם (לא בתקציב השעות): ' + esc(s.extra.map(function (x) { return x.name; }).join(', '))));
  if ((s.unknown || []).length) card.appendChild(mgrEl('div', 'mgr-note', '⚠️ הגשה בשם שאינו בטאב עובדים: ' + esc(s.unknown.join(', '))));
  if ((s.badFlags || []).length) card.appendChild(mgrEl('div', 'mgr-note', '⚠️ ערך לא מוכר בעמודה "נספר בתקציב השעות": ' + esc(s.badFlags.join(', ')) + ' — כן / לא / מנהל שעתי'));
  if (!s.absencesChecked) card.appendChild(mgrEl('div', 'mgr-legend', 'היומן עוד לא נקרא היום — מי שנעדר כל השבוע עדיין ברשימת החסרים.'));
  // who has to submit, and what 🔁 means — said on the card (Chris 16/10: instructors in the list, 🔁 not understood)
  card.appendChild(mgrEl('div', 'mgr-legend', 'מי צריך להגיש: מי שנספר בתקציב השעות (טאב עובדים, העמודה "נספר בתקציב השעות"; ריק = לפי השיוך — מי ששיוך המטרות שלו כולל "חנות"). ' +
    'מי שלא מגיש (מנחה, למשל) — "לא" בעמודה. 🔁 = לא הגיש לשבוע הזה, אבל שמר אילוצים קבועים באפליקציה — הם נחשבים הגשה.'));
  card.appendChild(mgrEl('div', 'mgr-legend', s.alertsOn ? '📧 התראות במייל פועלות' : '📧 התראות במייל כבויות — מפעילים מהתפריט בגיליון'));
  box.appendChild(card);
}

/** The publish card: what the team sees now, and the button when the board is a draft. */
function renderMgrStatus(board) {
  var box = document.getElementById('mgrStatus');
  if (!box) return;
  box.innerHTML = '';
  if (!board) return;
  if (board.error) { box.appendChild(mgrEl('p', 'mgr-note', '⚠️ מצב הפרסום לא נקרא: ' + esc(board.error))); return; }
  var wk = isoShort(board.week), see = isoShort(board.staffSee);
  var card = mgrEl('div', 'card mgr-status ' + (board.state === 'draft' ? 'draft' : 'live'));
  if (board.state !== 'draft') {
    card.innerHTML = '<b>✅ שבוע ' + esc(wk || '') + ' פורסם</b> — הצוות רואה אותו, ושינויים בלוח גלויים מיד.' +
      (board.at ? '<div class="mgr-legend">פורסם ' + esc(board.at) + (board.by ? ' · ' + esc(board.by) : '') + '</div>' : '');
    card.appendChild(mgrPubActs());
    box.appendChild(card);
    return;
  }
  card.innerHTML = '<b>📣 שבוע ' + esc(wk || '?') + ' — טיוטה</b>' +
    '<div>' + (board.broken ? '⚠️ מצב הפרסום לא נקרא. ' : '') + 'הצוות רואה ' +
    (see ? 'את שבוע ' + esc(see) : '"בבנייה"' + (board.staffEnded ? ' (השבוע הקודם הסתיים)' : '')) + '.</div>';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(board.week || ''))) {
    var b = mgrEl('button', 'btn btn-sm mgr-publish'); b.type = 'button'; mgrDecideSet(b, 'publish:' + board.week, 'mgrPublish', '📣 פרסם לצוות');
    b.onclick = function () { mgrAskPublish(board, b); };
    card.appendChild(b);
  }
  box.appendChild(card);
}

/** The confirm window of publishing (the card's button and the strip's button open the same one). */
function mgrAskPublish(board, btn) {
  var wk = isoShort(board.week), see = isoShort(board.staffSee);
  openAppModal('פרסום השבוע', 'לפרסם לצוות את שבוע ' + wk + '? מהרגע הזה כולם רואים אותו באפליקציה' +
    (see ? ', ושבוע ' + see + ' יורד מהמסך.' : '.'), false, 'פרסם', function () {
    mgrDecide('mgrPublish', { week: board.week }, btn);
  });
}

/** The strip at the top (16/10): the week and its state, who submitted, swaps waiting — and the ONE button for the next step. */
function renderMgrStrip() {
  var box = document.getElementById('mgrStrip');
  if (!box) return;
  box.innerHTML = '';
  var res = mgrOvData;
  if (!res) return;
  var bs = res.board || {};
  var wk = bs.error ? '' : isoShort(bs.week);
  var strip = mgrEl('div', 'mgr-strip');
  strip.appendChild(mgrEl('b', 'mgr-strip-wk', wk ? 'שבוע ' + esc(wk) + ' · ' + (bs.state === 'draft' ? 'טיוטה' : 'פורסם') : 'אין שבוע בלוח'));
  var s = res.submitStatus;
  if (s && !s.error && s.required) {
    strip.appendChild(mgrEl('span', 'mgr-pill' + (s.complete ? ' ok' : ''), '📬 ' + esc((s.submitted || []).length) + '/' + esc(s.required) + ' הגישו'));
  }
  var claimed = ((res.swaps || {}).claimed || []).length;
  if (claimed) strip.appendChild(mgrEl('span', 'mgr-pill warn', '🔄 ' + esc(claimed) + ' החלפות'));
  var pl = mgrBuildPlan(res);
  var go = null;
  if (mgrBuilding) {
    strip.appendChild(mgrEl('span', 'mgr-pill', '⏳ בונה…'));
  } else if (pl && pl.isRebuild && mgrEvWaitCount(pl.board) > 0) {
    // an event was added for the board's week: it reaches the board only on a rebuild, so that is the next step
    go = mgrEl('button', 'btn btn-sm mgr-go'); go.type = 'button'; go.textContent = '🔨 בנה מחדש כדי שהאירוע יופיע';
    go.onclick = function () { mgrAskBuild(pl); };
  } else if (bs.state === 'draft' && /^\d{4}-\d{2}-\d{2}$/.test(String(bs.week || ''))) {
    go = mgrEl('button', 'btn btn-sm mgr-go'); go.type = 'button'; mgrDecideSet(go, 'publish:' + bs.week, 'mgrPublish', '📣 פרסם לצוות');
    go.onclick = function () { mgrAskPublish(bs, go); };
  } else if (pl && (pl.mode === 'next' || pl.mode === 'current')) {
    go = mgrEl('button', 'btn btn-sm mgr-go'); go.type = 'button'; go.textContent = '🔨 בנה את שבוע ' + pl.T;
    go.onclick = function () { mgrAskBuild(pl); };
  }
  if (go) strip.appendChild(go);
  if (wk && bs.state !== 'draft') strip.appendChild(mgrPubActs());   // 17/10: the WhatsApp image and the hours, in sight once published
  box.appendChild(strip);
}

/* ------------------------------------------------------------------
   The week at a glance (16/10): rows = the board's shift and event rows, columns = days. A tap on a cell opens a picker
   (no server call); a tap on a name only MARKS the change (mgrPending). One sticky bar saves everything at once —
   one confirm, one POST (mgrAssignBatch), one reload of the board. The code never picks anyone: only what was tapped
   is sent, and the server checks every cell again under its lock (the week, the cell as seen, the row's list).
   ------------------------------------------------------------------ */
var MGR_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(-([01]\d|2[0-3]):[0-5]\d)?$/;

function mgrKey(label, short) { return label + '|' + short; }
function mgrFold(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

/** The board for assigning — the live tab (the draft when there is one). Reloads keep the grid on screen until the answer. */
function loadMgrBoard() {
  var box = document.getElementById('mgrAssign');
  if (!box) return;
  if (!mgrBoardData && mgrOpened) box.innerHTML = '<div class="loader">טוען את הלוח...</div>';
  var gen = loginGen, seq = ++mgrBoardSeq;
  mgrBoardFlight = seq; mgrBoardDropped = false; mgrStaleFail = false;
  renderMgrFresh();
  api('mgrBoard').then(function (res) {
    if (gen !== loginGen || seq !== mgrBoardSeq) return;   // logged out meanwhile (shared phone), or a newer answer is coming
    mgrBoardFlight = 0;
    if (!res || !res.success) {
      if (res && res.transport && mgrBoardData && mgrBoardCached) { mgrStaleFail = true; renderMgrFresh(); return; }   // no answer, and the table is the stored copy: it stays, with a chip to try again
      mgrBoardData = null; mgrBoardCached = false;
      mgrPickCtx = null;
      if (res && !res.transport) SafeStorage.remove(MGR_CACHE_KEY + identityKey());
      if (mgrOpened) {
        renderMgrPicker();
        box.innerHTML = '<div class="empty-state">' + (res && res.transport ? 'כשל בתקשורת מול השרת' : 'שגיאה: ' + esc(res ? res.error : '')) + '</div>';
        renderMgrSaveBar();
        if (mgrTool) renderMgrTool();   // stage 6: the tools sheet needs the board — it closes
      }
      renderMgrFresh();
      return;
    }
    mgrSyncPending(res);
    mgrBoardData = res; mgrBoardCached = false;
    mgrCacheSave();
    if (mgrOpened) mgrDrawBoard();
    renderMgrFresh();
  });
}

/**
 * Stage 7: a write answers with the board (the same object mgrBoard returns), so the phone draws it and sends no second request.
 * Returns false when the answer has none (an older server) - the caller then falls back to loadMgrBoard().
 */
function mgrBoardFromAnswer(r) {
  var nb = r && r.success && r.board && typeof r.board === 'object' && r.board.success !== false && Array.isArray(r.board.days) ? r.board : null;
  if (!nb) return false;
  mgrBoardInvalidate();   // an older reload still in flight must not overwrite this newer board
  mgrBoardDropped = false;   // this board stands in its place
  mgrSyncPending(nb);
  mgrBoardData = nb; mgrBoardCached = false;
  mgrCacheSave();
  mgrDrawBoard();
  return true;
}

/** A note that timed out: when the reload shows the cell changed and ending with that line, it did land - close the dialog so a second tap cannot add it twice. */
function mgrDayCheckLanded() {
  var c = mgrDayCheck;
  mgrDayCheck = null;
  if (!c || mgrDayCtx !== c.ctx || !mgrBoardData || !mgrHasInfo(mgrBoardData)) return;
  var now = mgrInfoOf(mgrBoardData, c.short), lines = now.split('\n');
  if (now !== c.expect && lines[lines.length - 1].trim() === c.text) {
    mgrDayCtx = null; mgrDayReset();
    renderMgrDay();
    showToast('ההערה כן נוספה ✓', 'success');
  }
}

function mgrFindCell(res, label, short) {
  var di = -1, row = null;
  (res.days || []).forEach(function (d, i) { if (d.short === short) di = i; });
  (res.rows || []).forEach(function (r) { if (r.label === label) row = r; });
  return row && di >= 0 ? (row.cells || [])[di] || null : null;
}

/** After a reload: another week drops the marks; a cell that changed meanwhile is flagged and re-based (the server checks again). */
function mgrSyncPending(res) {
  var keys = Object.keys(mgrPending);
  if (!keys.length) { mgrPendingWeek = ''; return; }
  if (mgrPendingWeek && String(res.week || '') !== mgrPendingWeek) {
    mgrPending = {}; mgrPendingWeek = '';
    closeAppModal();   // a save confirm opened for the dropped marks is stale
    showToast('הלוח עבר לשבוע אחר — השינויים שסומנו בוטלו.', 'error');
    return;
  }
  keys.forEach(function (k) {
    var p = mgrPending[k], cell = mgrFindCell(res, p.label, p.day);
    if (cell && cell.v !== p.expect) { p.expect = cell.v; p.changed = true; p.reason = ''; }
  });
}

/** What a person submitted for this day and shift: {cls, text} (from the availability of the board's week). */
function mgrAvailOf(res, dayName, shift, name) {
  var av = res.availability;
  if (!av || !av.slots || !shift) return null;
  for (var i = 0; i < av.slots.length; i++) {
    var sl = av.slots[i];
    if (sl.day !== dayName || sl.shift !== shift) continue;
    for (var j = 0; j < (sl.by || []).length; j++) {
      var list = sl.by[j] || [];
      for (var k = 0; k < list.length; k++) {
        if (list[k].name === name) return { ix: j, text: STATUS_SHORT[(av.statuses || [])[j]] || (av.statuses || [])[j] || '', fixed: !!list[k].fixed };
      }
    }
  }
  return { ix: 9, text: 'לא סימן', fixed: false };
}

/** The suggestions the server sent for this row and day ({top, skip}), or null (an older server sends none). */
function mgrSugOf(res, row, day) {
  var s = res && res.suggest && res.suggest[row.label + '|' + day.short];
  return s && typeof s === 'object' ? s : null;
}

/** Short row title for the first column: the shift's name and its hours (the hours are the end of the row label). */
function mgrRowTitle(row) {
  var m = /(\d{2}:\d{2}-\d{2}:\d{2})\s*$/.exec(row.label || '');
  var shift = row.kind === 'shift', custom = row.kind === 'custom';
  var name = shift && row.shift ? row.shift : String(row.label || '');
  // a row the manager added: its label is the title; the hours at its end are shown apart, not twice
  if (custom && m) { var rest = String(row.label).slice(0, m.index).trim(); if (rest) name = rest; }
  // the row of a shift type that was switched off keeps its place on the board until the next build: shown, with a word on why it is dead
  return { name: name, hours: (shift || custom) && m ? m[1] : '', note: row.kind === 'shiftOff' ? 'סוג משמרת כבוי' : '' };
}

/** A row that takes several people, each with an optional time, and lets a person be taken out: a shift row or a row the manager added. */
function mgrMulti(row) { return row.kind === 'shift' || row.kind === 'custom'; }

/** The kinds of row the phone writes into. Any other kind (a shift type switched off: "shiftOff") is drawn, never tapped, fixed or removed. */
function mgrAssignableRow(row) { return row.kind === 'shift' || row.kind === 'event' || row.kind === 'custom'; }

/** The recurring store's weekday letter of a board day ("חמישי" -> "ה"); '' for Saturday or anything else (no fixed person there). */
function mgrDowOf(day) {
  var n = String((day && day.name) || '').replace(/^יום\s+/, '').trim();
  return Object.prototype.hasOwnProperty.call(MGR_DOW, n) ? MGR_DOW[n] : '';
}

/** The weekday name of a recurring store letter ("ה" -> "חמישי"). */
function mgrDowName(letter) {
  var name = '';
  Object.keys(MGR_DOW).forEach(function (k) { if (MGR_DOW[k] === letter) name = k; });
  return name || String(letter || '');
}

/** The fixed people the server sent for one row and weekday: [{label, dow, empId, name}] (an older server sends none). */
function mgrRecurringOf(res, label, dow) {
  if (!res || !Array.isArray(res.recurring) || !dow) return [];
  return res.recurring.filter(function (r) { return r && r.label === label && r.dow === dow; });
}

/** The id of the one person whose full name starts a part of a cell (an event's "title: name" — the name after the colon); else ''. */
function mgrIdOfPart(res, row, text) {
  var t = mgrFold(text);
  if (row.kind === 'event') { var ix = t.lastIndexOf(': '); if (ix !== -1) t = t.slice(ix + 2); }
  var best = '', bestLen = 0, tie = false;
  Object.keys(res.people || {}).forEach(function (id) {
    var n = mgrFold(res.people[id]);
    if (!n || t.indexOf(n) !== 0) return;
    // after the full name only the end, a bracket or a time may follow — a further word means a different (longer) name
    var tail = t.slice(n.length);
    if (tail && !/^\s*[(\[]/.test(tail) && !/^\s+\d{1,2}:\d{2}/.test(tail)) return;
    if (n.length > bestLen) { best = id; bestLen = n.length; tie = false; } else if (n.length === bestLen) tie = true;
  });
  return tie ? '' : best;
}

/** Bracket-aware split on '|' and ',' at depth 0 (the server's cell grammar); a separator inside a bracket stays in the part. */
function mgrSplitCell(t) {
  var out = [], cur = '', depth = 0;
  for (var i = 0; i < t.length; i++) {
    var c = t.charAt(i);
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && depth > 0) depth--;
    if (depth === 0 && (c === '|' || c === ',')) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

/** The parts of a cell text (" | " between people): [{text, id}] — id is '' when the person cannot be told for sure (a short name, a note). */
function mgrCellParts(res, row, text) {
  var t = String(text == null ? '' : text).trim();
  if (!t) return [];
  return mgrSplitCell(t).map(function (x) { x = x.trim(); return { text: x, id: x ? mgrIdOfPart(res, row, x) : '' }; })
    .filter(function (pt) { return pt.text; });
}

function mgrCellEl(res, row, day, cell) {
  var key = mgrKey(row.label, day.short), pend = mgrPending[key];
  var by = (res.by && res.by[key]) || {};
  var tap = !day.closed && mgrAssignableRow(row) && (cell.can === 'add' || cell.can === 'fill');
  var gone = {}, adds = [];
  if (pend) pend.ops.forEach(function (o) { if (o.op === 'remove') gone[o.empId] = true; else adds.push(o); });
  var h = '';
  if (cell.can === 'fill' && !day.closed) {
    h += '<span class="mgr-evt">' + esc(String(cell.v).replace(/\s*\[דרוש עובד\]$/, '')) + '</span>';
  } else if (row.kind === 'event' || day.closed) {
    h += cell.v && !day.closed ? '<span class="mgr-txt">' + esc(cell.v) + '</span>' : '';
  } else {
    mgrCellParts(res, row, cell.v).forEach(function (pt) {
      var ini = pt.id && by[pt.id] ? String(by[pt.id]).trim().charAt(0) : '';   // who placed this person (the first letter of the manager's name)
      h += '<span class="mgr-chp' + (pt.id && gone[pt.id] ? ' rm' : '') + '">' + esc(pt.text) + (ini ? '<i>' + esc(ini) + '</i>' : '') + '</span>';
    });
  }
  adds.forEach(function (o) { h += '<span class="mgr-chp add">+ ' + esc(o.name) + (o.time ? ' ' + esc(o.time) : '') + (o.repeat ? ' 📅' : '') + '</span>'; });
  if (row.kind === 'custom' && !day.closed && mgrRecurringOf(res, row.label, mgrDowOf(day)).length) h += '<span class="mgr-rec">📅</span>';   // a person is fixed here every week
  if (tap && !adds.length) {
    h += '<span class="mgr-plus">+</span>';
    if (!cell.v && row.kind === 'shift') {   // the top suggestion, faint — a hint, never written by itself
      var sg = mgrSugOf(res, row, day), ids = (res.candidates && res.candidates[row.label]) || [];
      var top = sg && (sg.top || []).filter(function (s) { return s && ids.indexOf(s.id) !== -1 && (res.people || {})[s.id]; })[0];
      if (top) h += '<span class="mgr-hint">' + esc(String(res.people[top.id]).split(' ')[0]) + '</span>';
    }
  }
  if (pend && pend.reason) h += '<span class="mgr-mark">⚠️</span>';
  else if (pend && pend.changed) h += '<span class="mgr-mark">↻</span>';
  var td = mgrEl('td', 'mgr-cell ' + (tap ? 'tap' : 'off') + (day.closed ? ' closed' : '') + (pend ? ' pend' : '') + (pend && pend.reason ? ' bad' : ''), h);
  if (tap) td.onclick = function () { mgrOpenPicker(row.label, day.short); };
  return td;
}

function renderMgrAssign() {
  var box = document.getElementById('mgrAssign');
  var res = mgrBoardData;
  if (!box || !res) return;
  var oldWrap = typeof box.querySelector === 'function' ? box.querySelector('.mgr-scroll') : null;
  var keepLeft = oldWrap ? oldWrap.scrollLeft : 0;   // stage 7: a fresh answer replaces the table under the manager's finger - the sideways position stays
  box.innerHTML = '';
  if (!res.days || !res.days.length) { box.appendChild(mgrEl('p', 'mgr-empty', 'הלוח ריק — לבנות את השבוע.')); return; }
  if (res.gateNote) box.appendChild(mgrEl('p', 'mgr-note', '⚠️ הכישורים לא נטענו — הרשימה לפי השיוך בלבד: ' + esc(res.gateNote)));
  if (res.availability && res.availability.error) box.appendChild(mgrEl('p', 'mgr-note', '⚠️ הזמינות לא נטענה: ' + esc(res.availability.error)));
  if (res.byNote) box.appendChild(mgrEl('p', 'mgr-note', '⚠️ מי שיבץ לא נקרא: ' + esc(res.byNote)));
  if (res.suggestNote) box.appendChild(mgrEl('p', 'mgr-legend', '💡 ' + esc(res.suggestNote)));
  if (res.recurNote) box.appendChild(mgrEl('p', 'mgr-note mgr-recur-note', '⚠️ ' + esc(res.recurNote)));   // the last save: cells written, the fixed person not
  box.appendChild(mgrToolbarEl(res));   // stage 6: a note or an event, a new row, the shift types — in plain sight above the table
  var wrap = mgrEl('div', 'mgr-scroll');
  var tbl = mgrEl('table', 'mgr-grid');
  var head = mgrEl('tr');
  head.appendChild(mgrEl('th', 'mgr-rowh mgr-corner', ''));
  res.days.forEach(function (d) {
    head.appendChild(mgrEl('th', 'mgr-dayh' + (d.closed ? ' closed' : ''), '<span>' + esc(d.name) + '</span><small>' + esc(d.short) + (d.closed ? ' · סגור' : '') + '</small>'));
  });
  tbl.appendChild(head);
  if (mgrHasInfo(res)) tbl.appendChild(mgrInfoRowEl(res));   // "📌 הערות ואירועים": the day notes (an older server sends no info — no row)
  (res.rows || []).forEach(function (row) {
    if (mgrRowHidden(row)) return;   // an event row with nothing in it all week: nothing to do there
    var tr = mgrEl('tr');
    var rt = mgrRowTitle(row), custom = row.kind === 'custom';
    var th = mgrEl('th', 'mgr-rowh' + (custom ? ' tap' : ''), '<b>' + esc(rt.name) + (custom ? ' ✎' : '') + '</b>' + (rt.hours ? '<small>' + esc(rt.hours) + '</small>' : '') + (rt.note ? '<small class="mgr-off-note">' + esc(rt.note) + '</small>' : ''));
    if (custom) th.onclick = function () { mgrOpenTool('row', row.label); };   // its fixed people and removing it
    tr.appendChild(th);
    res.days.forEach(function (day, di) { tr.appendChild(mgrCellEl(res, row, day, (row.cells || [])[di] || { v: '', can: '' })); });
    tbl.appendChild(tr);
  });
  var anyAbs = res.days.some(function (d) { return res.absences && res.absences[d.short]; });
  if (anyAbs) {   // who is away, as the board's own absences row says — information, not tappable
    var ar = mgrEl('tr', 'mgr-abs');
    ar.appendChild(mgrEl('th', 'mgr-rowh', '<b>🏖 נעדרים</b>'));
    res.days.forEach(function (d) { ar.appendChild(mgrEl('td', 'mgr-cell off', '<span class="mgr-txt">' + esc((res.absences && res.absences[d.short]) || '') + '</span>')); });
    tbl.appendChild(ar);
  }
  wrap.appendChild(tbl);
  box.appendChild(wrap);
  if (keepLeft) wrap.scrollLeft = keepLeft;
  var nWait = mgrEvWaitCount(res.week);
  if (nWait) {
    box.appendChild(mgrEl('p', 'mgr-legend mgr-evwait', '📅 ' + (nWait === 1 ? 'אירוע אחד מחכה' : nWait + ' אירועים מחכים') + ' לבנייה מחדש כדי להופיע בלוח: ' +
      esc(mgrEvWait.items.map(function (e) { return e.day + ' ' + e.title; }).join(' · '))));
  }
  if (res.skipped && res.skipped.length) box.appendChild(mgrEl('p', 'mgr-legend', 'שורות שמופיעות בלוח פעמיים — שיבוץ בהן בגיליון: ' + esc(res.skipped.join(' · '))));
}

/** An event row ("אירועים / תגבור NN") whose cells are ALL empty for the whole week, with nothing marked on it, is left out of the table. */
function mgrRowHidden(row) {
  if (row.kind !== 'event') return false;
  if ((row.cells || []).some(function (c) { return c && String(c.v == null ? '' : c.v).trim(); })) return false;
  return !Object.keys(mgrPending).some(function (k) { return mgrPending[k].label === row.label && mgrPending[k].ops.length; });
}

/* ---- the day row "📌 הערות ואירועים" (stage 5, renamed in stage 6): day notes and events that are not in any calendar ---- */
function mgrHasInfo(res) { return !!(res && res.info && typeof res.info === 'object'); }

function mgrInfoOf(res, short) {
  return mgrHasInfo(res) && res.info[short] != null ? String(res.info[short]) : '';
}

function mgrEvWaitCount(week) { return mgrEvWait.week && mgrEvWait.week === String(week == null ? '' : week) ? mgrEvWait.items.length : 0; }

function mgrInfoRowEl(res) {
  var tr = mgrEl('tr', 'mgr-info-row');
  tr.appendChild(mgrEl('th', 'mgr-rowh', '<b>📌 הערות ואירועים</b>'));
  res.days.forEach(function (day) {
    var lines = mgrInfoOf(res, day.short).split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l; });
    var h = lines.map(function (l) { return '<span class="mgr-info-line">' + esc(l) + '</span>'; }).join('');
    var sv = mgrInfoSaving && mgrInfoSaving.short === day.short && String(res.week || '') === mgrInfoSaving.week ? mgrInfoSaving : null;
    if (sv) h += '<span class="mgr-info-line saving">' + esc(sv.text) + ' · שומר…</span>';   // stage 7: at once, in grey; normal when the server has it
    if (!lines.length && !sv && !day.closed) h = '<span class="mgr-addnote">＋ הוסף</span>';
    var td = mgrEl('td', 'mgr-cell mgr-info ' + (day.closed ? 'off closed' : 'tap'), h);
    if (!day.closed) td.onclick = function () { mgrOpenDay(day.short); };
    tr.appendChild(td);
  });
  return tr;
}

function mgrDayReset() { mgrDayDraft = { text: '', title: '', from: '', to: '', staff: true }; mgrDayErr = ''; }

function mgrOpenDay(short) {
  if (mgrDayBusy) { showToast('עוד שומרים את מה שנשלח — לחכות רגע.', 'error'); return; }   // the answer of the earlier request is still on its way
  mgrDayCtx = { short: short, mode: 'menu' };
  mgrDayReset();
  renderMgrDay();
}

function closeMgrDay() {
  mgrDayCtx = null;
  renderMgrDay();
}

/** The small dialog of one day: what is written there, and the two choices — a note or an event. */
function renderMgrDay() {
  var box = document.getElementById('mgrDaySheet');
  if (!box) return;
  var res = mgrBoardData, ctx = mgrDayCtx, day = null;
  if (ctx && res && mgrHasInfo(res)) (res.days || []).forEach(function (d) { if (d.short === ctx.short) day = d; });
  box.innerHTML = '';
  if (!ctx || !day || day.closed) { mgrDayCtx = null; box.style.display = 'none'; return; }
  box.style.display = 'flex';
  box.onclick = function (e) { if (e && e.target === box && !mgrDayBusy) closeMgrDay(); };
  var sheet = mgrEl('div', 'mgr-sheet');
  var head = mgrEl('div', 'mgr-sheet-h', '<b>📌 ' + esc(day.name + ' ' + day.short) + '</b>');
  var xb = mgrEl('button', 'mgr-x'); xb.type = 'button'; xb.textContent = '✕'; xb.onclick = function () { if (!mgrDayBusy) closeMgrDay(); };
  head.appendChild(xb);
  sheet.appendChild(head);
  var lines = mgrInfoOf(res, day.short).split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l; });
  var cur = mgrEl('div', 'mgr-cur');
  if (lines.length) lines.forEach(function (l) { cur.appendChild(mgrEl('div', 'mgr-curp', '<span>' + esc(l) + '</span>')); });
  else cur.appendChild(mgrEl('div', 'mgr-legend', 'אין עדיין הערות ליום הזה.'));
  sheet.appendChild(cur);
  var acts = mgrEl('div', 'mgr-acts');
  [['note', '📝 הערה'], ['event', '📅 אירוע']].forEach(function (m) {
    var b = mgrEl('button', 'btn btn-sm mgr-day-' + m[0] + (ctx.mode === m[0] ? '' : ' btn-secondary')); b.type = 'button'; b.textContent = m[1];
    b.onclick = function () { if (mgrDayBusy) return; mgrDayCtx.mode = m[0]; mgrDayErr = ''; renderMgrDay(); };
    acts.appendChild(b);
  });
  sheet.appendChild(acts);
  var input = function (cls, ph, max, key, type) {
    var el = document.createElement('input');
    el.type = type || 'text'; el.className = 'mgr-day-in ' + cls; el.maxLength = max; el.placeholder = ph; el.value = mgrDayDraft[key];
    el.oninput = function () { mgrDayDraft[key] = el.value; };
    return el;
  };
  var go = null;
  if (ctx.mode === 'note') {
    sheet.appendChild(input('mgr-day-text', 'שורה אחת, עד 120 תווים', 120, 'text'));
    go = mgrEl('button', 'btn btn-sm mgr-day-go'); go.type = 'button'; go.textContent = mgrDayBusy ? MGR_BUSY : 'הוסף הערה';
    go.onclick = mgrDayNoteRun;
    sheet.appendChild(go);
    sheet.appendChild(mgrEl('div', 'mgr-legend', 'ההערה נוספת לשורה של היום הזה בלוח. להסרה או לעריכה — בגיליון.'));
  } else if (ctx.mode === 'event') {
    sheet.appendChild(input('mgr-day-title', 'שם האירוע', 80, 'title'));
    var tm = mgrEl('div', 'mgr-day-times');
    tm.appendChild(mgrEl('label', 'mgr-day-lbl', 'מ-'));
    tm.appendChild(input('mgr-day-from', 'HH:MM', 5, 'from', 'time'));
    tm.appendChild(mgrEl('label', 'mgr-day-lbl', 'עד'));
    tm.appendChild(input('mgr-day-to', 'HH:MM', 5, 'to', 'time'));
    sheet.appendChild(tm);
    var lab = mgrEl('label', 'mgr-day-chk');
    var cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'mgr-day-staff'; cb.checked = !!mgrDayDraft.staff;
    var hint = mgrEl('div', 'mgr-legend mgr-day-hint');
    var setHint = function () {
      hint.textContent = mgrDayDraft.staff ? 'האירוע נשמר ביומן האירועים הידניים, ויופיע בלוח אחרי בנייה מחדש — עם שורה לשיבוץ עובד.'
                                           : 'לא נכנס ליומן — נרשם כהערה בשורת היום.';
    };
    cb.onchange = function () { mgrDayDraft.staff = !!cb.checked; setHint(); };
    lab.appendChild(cb);
    lab.appendChild(mgrEl('span', 'mgr-day-chk-t', ' צריך עובד חנות'));
    sheet.appendChild(lab);
    setHint();
    go = mgrEl('button', 'btn btn-sm mgr-day-go'); go.type = 'button'; go.textContent = mgrDayBusy ? MGR_BUSY : (ctx.doubt ? 'הוסף שוב (ייתכן שכבר נוסף)' : 'הוסף אירוע');
    go.onclick = mgrDayEventRun;
    sheet.appendChild(go);
    sheet.appendChild(hint);
  }
  if (go) go.disabled = mgrDayBusy;
  if (mgrDayErr) sheet.appendChild(mgrEl('div', 'mgr-note mgr-day-err', '⚠️ ' + esc(mgrDayErr)));
  box.appendChild(sheet);
}

/** After an answer that did not say "added": say why (a timeout may have landed — check before trying again). */
function mgrDayFailed(r, what) {
  if (r && r.transport) mgrDayErr = 'לא התקבלה תשובה מהשרת. ייתכן ש' + what + ' נוסף — לבדוק (↻ רענון) לפני שמנסים שוב.';
  else mgrDayErr = 'לא נוסף: ' + (r ? r.error : '');
  showToast(mgrDayErr, 'error');   // and the same words stay in red inside the dialog
  renderMgrDay();
}

function mgrDayNoteRun() {
  if (mgrDayBusy || !mgrDayCtx || !mgrBoardData) return;
  var text = mgrFold(mgrDayDraft.text), res = mgrBoardData, short = mgrDayCtx.short, week = String(res.week || '');
  if (text.length < 1 || text.length > 120) { showToast('ההערה צריכה להיות בין תו אחד ל-120 תווים.', 'error'); return; }
  var expectSent = mgrInfoOf(res, short);
  mgrDayBusy = true;
  mgrBoardInvalidate();   // a reload started before this write must not land after it
  // stage 7: no waiting - the dialog closes at once and the line stands in its cell in grey ("שומר…") until the answer comes;
  // the typed text stays in mgrDayDraft, so a refusal brings the dialog back with it (nothing typed is lost)
  mgrInfoSaving = { week: week, short: short, text: text };
  mgrDayCtx = null;
  renderMgrDay();
  renderMgrAssign();
  var gen = loginGen;
  api('mgrDayNote', { week: week, day: short, expect: expectSent, text: text }, { post: true, ms: 60000 }).then(function (r) {
    if (gen !== loginGen) return;
    mgrDayBusy = false;
    mgrInfoSaving = null;
    if (r && r.success) {
      mgrDayReset();
      if (!mgrBoardFromAnswer(r)) mgrDaySetInfo(week, short, r.value);   // the board of the answer, else the cell text it gave
      showToast('ההערה נוספה ✓', 'success');
    } else {
      mgrDayCtx = { short: short, mode: 'note' };   // the dialog is back with the text, and the reason in red
      mgrDayCheck = r && r.transport ? { ctx: mgrDayCtx, short: short, expect: expectSent, text: text } : null;
      renderMgrAssign();
      mgrDayFailed(r, 'ההערה');
      loadMgrBoard();   // the cell may have changed meanwhile ("התא השתנה") — the next try compares with the current one
    }
  });
}

/** Writes the cell text the server answered into the board on screen (only when it is still the same week) and redraws the table. */
function mgrDaySetInfo(week, short, value) {
  if (!mgrBoardData || String(mgrBoardData.week || '') !== week || !mgrHasInfo(mgrBoardData)) { loadMgrBoard(); return; }
  mgrBoardInvalidate();   // a reload still in flight is older than this write
  mgrBoardData.info[short] = String(value == null ? '' : value);
  mgrCacheSave();
  renderMgrAssign();
  mgrBoardRefreshIfDropped();   // the table may be the stored copy: the dropped refresh is asked for again
}

function mgrDayEventRun(sure) {
  if (mgrDayBusy || !mgrDayCtx || !mgrBoardData) return;
  var d = mgrDayDraft, title = mgrFold(d.title), from = String(d.from || '').trim(), to = String(d.to || '').trim();
  var res = mgrBoardData, short = mgrDayCtx.short, week = String(res.week || ''), T = /^([01]\d|2[0-3]):[0-5]\d$/;
  var bad = '';
  if (title.length < 2 || title.length > 80) bad = 'שם האירוע צריך להיות בין 2 ל-80 תווים.';
  else if (/[\[\]]/.test(title)) bad = 'בשם האירוע אי אפשר סוגריים מרובעים.';
  else if ((from && !T.test(from)) || (to && !T.test(to))) bad = 'שעה לא תקינה — למשל 18:00.';
  else if (to && !from) bad = 'שעת סיום אפשר רק יחד עם שעת התחלה.';
  else if (to && to <= from) bad = 'שעת הסיום צריכה להיות אחרי שעת ההתחלה.';
  if (bad) { showToast(bad, 'error'); return; }
  var staff = !!d.staff, ctx = mgrDayCtx;
  if (ctx.doubt && sure !== true) {   // the last try got no answer: it may have landed, and the board cannot show an event before a rebuild
    openAppModal('להוסיף שוב?', 'התשובה מהשרת לא הגיעה, וייתכן שהאירוע כבר נוסף. אי אפשר לראות את זה בלוח לפני בנייה מחדש — כדאי לבדוק ביומן האירועים הידניים. להוסיף שוב בכל זאת?', false, 'הוסף שוב', function () {
      if (mgrDayCtx === ctx) mgrDayEventRun(true);
    });
    return;
  }
  mgrDayBusy = true;
  if (!staff) mgrBoardInvalidate();   // a note is written to the board: a reload started before it must not land after it. A calendar event does not touch the board - a refresh on its way is left alone
  mgrDayErr = '';
  renderMgrDay();
  var gen = loginGen;
  api('mgrAddEvent', { week: week, day: short, title: title, from: from, to: to, staff: staff }, { post: true, ms: 60000 }).then(function (r) {
    if (gen !== loginGen) return;
    mgrDayBusy = false;
    if (r && r.success) {
      if (r.note) {   // not a calendar event: written as a day note
        if (!mgrBoardFromAnswer(r)) mgrDaySetInfo(week, short, r.value);
        showToast('נרשם כהערה ליום ✓', 'success');
      } else {
        if (mgrEvWait.week !== week) mgrEvWait = { week: week, items: [] };
        mgrEvWait.items.push({ day: short, title: title, n: ++mgrEvSeq });
        showToast('האירוע נוסף ✓ — כדי שיופיע בלוח צריך לבנות את השבוע מחדש (הכפתור למעלה).', 'success');
        renderMgrAssign();
        renderMgrStrip();
      }
      if (mgrDayCtx === ctx) { mgrDayCtx = null; mgrDayReset(); }   // only the dialog that sent it; another day's dialog stays
      renderMgrDay();
    } else if (r && r.transport) {
      if (mgrDayCtx === ctx) ctx.doubt = true;
      showToast('לא התקבלה תשובה מהשרת. ייתכן שהאירוע נוסף — אי אפשר לראות את זה בלוח לפני בנייה מחדש, אז כדאי לבדוק ביומן האירועים הידניים לפני שמנסים שוב.', 'error');
      renderMgrDay();
      mgrBoardRefreshIfDropped();   // a note that got no answer may have landed: the board is read again
    } else {
      mgrDayFailed(r, 'האירוע');
      mgrBoardRefreshIfDropped();
    }
  });
}

/* ---- the picker (a bottom sheet) ---- */
function mgrAddDraftReset() { mgrAddDraft = { name: '', kind: 'trainee' }; }

function mgrOpenPicker(label, short) {
  mgrPickCtx = { label: label, day: short }; mgrPickTime = ''; mgrAddOpen = false; mgrPickRepeat = false; mgrAddDraftReset();
  renderMgrPicker();
}

function closeMgrPicker() {
  mgrPickCtx = null; mgrAddOpen = false;
  renderMgrPicker();
}

function mgrPickBtn(p, dim) {
  var b = mgrEl('button', 'mgr-cand' + (dim ? ' dim' : '') + (p.sug ? ' sug' : ''));
  b.type = 'button';
  var why = [];
  if (p.sug) { if (p.sug.why) why.push(String(p.sug.why)); if (p.sug.over) why.push('⚠️ מעבר לתקרה'); }
  else {
    if (p.av && p.av.ix < 9) why.push(p.av.text + (p.av.fixed ? ' 🔁' : ''));
    if (p.skip) why.push('לא בהצעות: ' + p.skip);
  }
  if (p.busy.length) why.push('כבר היום: ' + p.busy.join(' · '));
  b.innerHTML = (p.sug ? '💡 ' : '') + '<b>' + esc(p.name) + '</b>' + (p.trainee ? ' <span class="mgr-tr">(מתלמד)</span>' : '') +
    (why.length ? '<div class="mgr-why">' + why.map(esc).join(' · ') + '</div>' : '');
  return b;
}

function renderMgrPicker() {
  var box = document.getElementById('mgrPicker');
  if (!box) return;
  var res = mgrBoardData, ctx = mgrPickCtx, row = null, day = null, cell = null;
  if (ctx && res) {
    var di = -1;
    (res.rows || []).forEach(function (r) { if (r.label === ctx.label) row = r; });
    (res.days || []).forEach(function (d, i) { if (d.short === ctx.day) di = i; });
    day = di >= 0 ? res.days[di] : null;
    cell = row && di >= 0 ? (row.cells || [])[di] || null : null;
  }
  box.innerHTML = '';
  if (!row || !day || !cell || day.closed || (cell.can !== 'add' && cell.can !== 'fill')) { mgrPickCtx = null; box.style.display = 'none'; return; }
  box.style.display = 'flex';
  box.onclick = function (e) { if (e && e.target === box) closeMgrPicker(); };   // a tap outside the sheet closes it
  var isShift = mgrMulti(row), isCustom = row.kind === 'custom';   // a row the manager added behaves like a shift row (several people, hours, removal)
  var key = mgrKey(row.label, day.short), pend = mgrPending[key] || { ops: [] };
  var sheet = mgrEl('div', 'mgr-sheet');
  var head = mgrEl('div', 'mgr-sheet-h', '<b>' + esc(day.name + ' ' + day.short + ' · ' + mgrRowTitle(row).name) + '</b>');
  var xb = mgrEl('button', 'mgr-x'); xb.type = 'button'; xb.textContent = '✕'; xb.onclick = closeMgrPicker;
  head.appendChild(xb);
  sheet.appendChild(head);

  // who is in the cell now (✕ marks a removal — shift rows only) and what is already marked for it
  var parts = isShift ? mgrCellParts(res, row, cell.v) : [];
  var cur = mgrEl('div', 'mgr-cur');
  if (!isShift) cur.appendChild(mgrEl('div', 'mgr-legend', 'האירוע: ' + esc(String(cell.v).replace(/\s*\[דרוש עובד\]$/, ''))));
  parts.forEach(function (pt) {
    var removed = !!pt.id && pend.ops.some(function (o) { return o.op === 'remove' && o.empId === pt.id; });
    var line = mgrEl('div', 'mgr-curp' + (removed ? ' rm' : ''), '<span>' + esc(pt.text) + '</span>');
    if (pt.id) {
      var rb = mgrEl('button', 'mgr-x'); rb.type = 'button'; rb.textContent = removed ? '↩' : '✕';
      rb.onclick = function () { mgrToggleRemove(row, day, cell, pt); };
      line.appendChild(rb);
    } else {
      line.appendChild(mgrEl('small', 'mgr-legend', 'להוציא — בגיליון'));
    }
    cur.appendChild(line);
  });
  pend.ops.forEach(function (o) {
    if (o.op !== 'add') return;
    var line = mgrEl('div', 'mgr-curp add', '<span>+ ' + esc(o.name) + (o.time ? ' ' + esc(o.time) : '') + (o.repeat ? ' 📅' : '') + '</span>');
    var ub = mgrEl('button', 'mgr-x'); ub.type = 'button'; ub.textContent = '✕';
    ub.onclick = function () { mgrUndoAdd(key, o.empId); };
    line.appendChild(ub);
    cur.appendChild(line);
  });
  if (cur.children.length) sheet.appendChild(cur);

  var timeIn = null;
  if (isShift) {
    timeIn = document.createElement('input');
    timeIn.type = 'text'; timeIn.className = 'mgr-time'; timeIn.maxLength = 11;
    timeIn.placeholder = 'שעה אחרת (לא חובה): 09:30 או 16:00-22:00';
    timeIn.value = mgrPickTime;
    timeIn.oninput = function () { mgrPickTime = timeIn.value; };
    sheet.appendChild(timeIn);
  }
  // stage 6: a person fixed to this row on this weekday, every week (a row the manager added only; never on Saturday — the store has no such day)
  var repeatCb = null, dow = mgrDowOf(day);
  if (isCustom && dow) {
    var rl = mgrEl('label', 'mgr-day-chk mgr-repeat-l');
    repeatCb = document.createElement('input');
    repeatCb.type = 'checkbox'; repeatCb.className = 'mgr-repeat'; repeatCb.checked = !!mgrPickRepeat;
    repeatCb.onchange = function () { mgrPickRepeat = !!repeatCb.checked; };
    rl.appendChild(repeatCb);
    rl.appendChild(mgrEl('span', 'mgr-day-chk-t', ' 📅 כל שבוע ב' + esc(day.name)));
    sheet.appendChild(rl);
    sheet.appendChild(mgrEl('div', 'mgr-legend', 'מי שתבחרו עכשיו ייכנס לשורה הזו בכל שבוע שנבנה, ביום הזה — רק לתא ריק. אפשר לבטל בהקשה על שם השורה.'));
  }

  // the candidates of the row, in the order the manager needs them: suggestions, wants, if needed, did not mark — then the ones
  // that cannot / are off / already busy that day (greyed, but still tappable: the manager decides)
  var ids = (res.candidates && res.candidates[row.label]) || [];
  var busy = (res.busy && res.busy[day.short]) || {};
  var sg = mgrSugOf(res, row, day) || {};
  var sugBy = {}, sugOrder = [];
  (sg.top || []).forEach(function (s) { if (s && s.id) { sugBy[s.id] = s; sugOrder.push(s.id); } });
  var skip = sg.skip && typeof sg.skip === 'object' ? sg.skip : {};
  var here = {};
  parts.forEach(function (pt) { if (pt.id) here[pt.id] = true; });
  pend.ops.forEach(function (o) { if (o.op === 'add') here[o.empId] = true; });
  var trainee = {};
  (res.trainees || []).forEach(function (id) { trainee[id] = true; });
  var G = { sug: [], want: [], maybe: [], none: [], dim: [] };
  ids.forEach(function (id) {
    var name = (res.people || {})[id];
    if (!name || here[id] || (busy[id] || []).indexOf(row.label) !== -1) return;   // already in this very cell
    var av = mgrAvailOf(res, day.name, row.shift, name);
    var p = { id: id, name: name, av: av, busy: (busy[id] || []).filter(function (l) { return l !== row.label; }), sug: sugBy[id] || null,
              skip: Object.prototype.hasOwnProperty.call(skip, id) ? String(skip[id]) : '', trainee: !!trainee[id] };
    var ix = av ? av.ix : 9;
    if (p.sug) G.sug.push(p);
    else if (ix === 2 || ix === 3 || p.busy.length) G.dim.push(p);
    else if (ix === 0) G.want.push(p);
    else if (ix === 1) G.maybe.push(p);
    else G.none.push(p);
  });
  var byName = function (a, b) { return a.name.localeCompare(b.name, 'he'); };
  G.sug.sort(function (a, b) { return sugOrder.indexOf(a.id) - sugOrder.indexOf(b.id); });
  ['want', 'maybe', 'none', 'dim'].forEach(function (g) { G[g].sort(byName); });
  var total = 0;
  [['sug', '💡 הצעות'], ['want', '🟢 רוצים ויכולים'], ['maybe', '🟡 אם חייבים'], ['none', row.kind === 'shift' ? 'לא סימנו' : 'עובדים'],
   ['dim', 'לא מתאימים (אפשר בכל זאת)']].forEach(function (g) {
    if (!G[g[0]].length) return;
    sheet.appendChild(mgrEl('div', 'mgr-gh', esc(g[1])));
    G[g[0]].forEach(function (p) {
      var b = mgrPickBtn(p, g[0] === 'dim');
      b.onclick = function () { mgrPendAdd(row, day, cell, p, timeIn ? timeIn.value : '', repeatCb ? repeatCb.checked : false); };
      sheet.appendChild(b);
      total++;
    });
  });
  if (!total) sheet.appendChild(mgrEl('p', 'mgr-empty', 'אין ברשימה של השורה הזו אף אחד פנוי — אפשר להוסיף אדם חדש.'));

  // a new person (a first-week trainee has no user yet): the name and the kind, saved in the staff tab by the server
  var add = mgrEl('div', 'mgr-addp');
  if (!mgrAddOpen) {
    var ob = mgrEl('button', 'btn btn-secondary btn-sm mgr-addp-open'); ob.type = 'button'; ob.textContent = '+ אדם חדש';
    ob.onclick = function () { mgrAddOpen = true; renderMgrPicker(); };
    add.appendChild(ob);
  } else {
    var nameIn = document.createElement('input');
    nameIn.type = 'text'; nameIn.className = 'mgr-addp-name'; nameIn.maxLength = 40; nameIn.placeholder = 'שם (כמו שרוצים לראות בלוח)';
    nameIn.value = mgrAddDraft.name;
    nameIn.oninput = function () { mgrAddDraft.name = nameIn.value; };
    var kindSel = mgrEl('select', 'mgr-addp-kind', '<option value="trainee">מתלמד</option><option value="staff">איש צוות</option><option value="instructor">מנחה</option>');
    kindSel.value = mgrAddDraft.kind;
    kindSel.onchange = function () { mgrAddDraft.kind = kindSel.value; };
    var go = mgrEl('button', 'btn btn-sm mgr-addp-go'); go.type = 'button';
    go.textContent = mgrAdding ? MGR_BUSY : 'הוסף';   // a request on its way: a redraw keeps the hourglass
    go.disabled = mgrAdding;
    go.onclick = function () { mgrAddDraft.name = nameIn.value; mgrAddDraft.kind = kindSel.value; mgrAddPersonRun(nameIn.value, kindSel.value, go); };   // the draft is what the field holds at the tap, whatever fired before
    var no = mgrEl('button', 'btn btn-secondary btn-sm'); no.type = 'button'; no.textContent = 'ביטול';
    no.onclick = function () { mgrAddOpen = false; mgrAddDraftReset(); renderMgrPicker(); };
    add.appendChild(nameIn); add.appendChild(kindSel);
    var acts = mgrEl('div', 'mgr-acts'); acts.appendChild(go); acts.appendChild(no);
    add.appendChild(acts);
  }
  sheet.appendChild(add);
  box.appendChild(sheet);
}

function mgrAddPersonRun(name, kind, btn) {
  name = mgrFold(name);
  if (mgrAdding) return;
  if (name.length < 2 || name.length > 40) { showToast('השם צריך להיות בין 2 ל-40 תווים.', 'error'); return; }
  if (kind !== 'trainee' && kind !== 'instructor' && kind !== 'staff') kind = 'trainee';
  mgrAdding = true;
  var was = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = MGR_BUSY; }   // the typed name stays: the picker is not redrawn
  showToast('מוסיף...', 'info');
  var gen = loginGen;
  api('mgrAddPerson', { name: name, kind: kind }, { post: true }).then(function (r) {
    if (gen !== loginGen) return;
    mgrAdding = false;
    if (btn && !(r && r.success)) { btn.disabled = false; btn.textContent = was; }
    if (r && r.success) {
      showToast('נוסף: ' + (r.name || name) + (kind === 'trainee' ? ' (מתלמד — מופיע בשורות ההתלמדות)' : ''), 'success');
      mgrAddOpen = false; mgrAddDraftReset();
      loadMgrBoard();   // the list gets the new person; the marks stay
    } else if (r && r.transport) {
      showToast('לא התקבלה תשובה מהשרת. לבדוק אם האדם נוסף (↻ רענון) לפני שמנסים שוב.', 'error');
    } else {
      showToast('לא נוסף: ' + (r ? r.error : ''), 'error');
    }
    renderMgrPicker();   // the form as it is now: no hourglass (a redraw during the request drew it), closed after a success; the typed text comes back from the draft
  });
}

/* ---- the marks (nothing is sent) ---- */
function mgrPendEntry(row, day, cell) {
  var key = mgrKey(row.label, day.short);
  if (!mgrPending[key]) {
    mgrPending[key] = { label: row.label, day: day.short, dow: mgrDowOf(day), title: day.name + ' ' + day.short + ' · ' + mgrRowTitle(row).name, expect: cell.v, ops: [], reason: '', changed: false };
    if (!mgrPendingWeek) mgrPendingWeek = String((mgrBoardData && mgrBoardData.week) || '');
  }
  return mgrPending[key];
}

function mgrPendPrune(key) {
  if (mgrPending[key] && !mgrPending[key].ops.length) delete mgrPending[key];
  if (!Object.keys(mgrPending).length) mgrPendingWeek = '';
}

function mgrPendRefresh() {
  renderMgrAssign();
  renderMgrPicker();
  renderMgrSaveBar();
}

function mgrPendAdd(row, day, cell, p, time, repeat) {
  time = String(time == null ? '' : time).trim();
  if (time && !MGR_TIME_RE.test(time)) { showToast('שעה לא תקינה — למשל 09:30 או 16:00-22:00.', 'error'); return; }
  var pe = mgrPendEntry(row, day, cell);
  if (!mgrMulti(row)) pe.ops = pe.ops.filter(function (o) { return o.op !== 'add'; });   // an event takes one person: the new pick replaces the mark
  else if (pe.ops.length >= 8) { showToast('אפשר לסמן עד 8 שינויים בתא אחד.', 'error'); mgrPendPrune(mgrKey(row.label, day.short)); return; }
  // "every week" only on a row the manager added, and only on a weekday the store knows (the server refuses it anywhere else)
  var rep = !!repeat && row.kind === 'custom' && !!mgrDowOf(day);
  if (!pe.ops.some(function (o) { return o.op === 'add' && o.empId === p.id; })) pe.ops.push({ op: 'add', empId: p.id, name: p.name, time: time, repeat: rep });
  pe.reason = '';
  mgrPickCtx = null; mgrAddOpen = false; mgrPickTime = ''; mgrPickRepeat = false;
  mgrPendRefresh();
}

function mgrToggleRemove(row, day, cell, pt) {
  if (!mgrMulti(row) || !pt.id) return;   // removal is for shift rows and rows the manager added; an event is changed in the sheet
  var key = mgrKey(row.label, day.short);
  var pe = mgrPendEntry(row, day, cell);
  var ix = -1;
  pe.ops.forEach(function (o, i) { if (o.op === 'remove' && o.empId === pt.id) ix = i; });
  if (ix >= 0) pe.ops.splice(ix, 1);
  else if (pe.ops.length >= 8) showToast('אפשר לסמן עד 8 שינויים בתא אחד.', 'error');
  else pe.ops.push({ op: 'remove', empId: pt.id, name: String((mgrBoardData.people || {})[pt.id] || pt.text), time: '' });
  pe.reason = '';
  mgrPendPrune(key);
  mgrPendRefresh();
}

function mgrUndoAdd(key, empId) {
  var pe = mgrPending[key];
  if (!pe) return;
  pe.ops = pe.ops.filter(function (o) { return !(o.op === 'add' && o.empId === empId); });
  mgrPendPrune(key);
  mgrPendRefresh();
}

function mgrPendCount() {
  var n = 0;
  Object.keys(mgrPending).forEach(function (k) { n += mgrPending[k].ops.length; });
  return n;
}

/** The sticky bar above the bottom nav: save N changes / cancel all — and the reasons of cells the server refused. */
function renderMgrSaveBar() {
  var box = document.getElementById('mgrSaveBar');
  if (!box) return;
  box.innerHTML = '';
  var n = mgrPendCount();
  if (!n) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  var row = mgrEl('div', 'mgr-savebar-row');
  var sv = mgrEl('button', 'btn btn-sm mgr-save'); sv.type = 'button';
  sv.textContent = mgrSaving ? MGR_BUSY + ' שומר…' : (n === 1 ? '💾 שמור שינוי אחד' : '💾 שמור ' + n + ' שינויים');
  sv.disabled = mgrSaving;
  sv.onclick = mgrSavePending;
  var cn = mgrEl('button', 'btn btn-secondary btn-sm mgr-cancel'); cn.type = 'button'; cn.textContent = 'בטל הכל';
  cn.onclick = function () {
    openAppModal('ביטול השינויים', 'לבטל את כל מה שסימנת ועוד לא נשמר?', false, 'בטל הכל', function () {
      mgrPending = {}; mgrPendingWeek = '';
      mgrPendRefresh();
    });
  };
  row.appendChild(sv); row.appendChild(cn);
  box.appendChild(row);
  Object.keys(mgrPending).forEach(function (k) {
    var p = mgrPending[k];
    if (p.reason) box.appendChild(mgrEl('div', 'mgr-bar-err', '⚠️ ' + esc(p.title) + ': ' + esc(p.reason)));
  });
}

/** One confirm listing every change, then one POST for the whole week. Cells the server refused stay marked, with its reason. */
function mgrSavePending() {
  if (mgrSaving) return;
  var keys = Object.keys(mgrPending).filter(function (k) { return mgrPending[k].ops.length; });
  if (!keys.length) return;
  var more = keys.length > 60 ? keys.length - 60 : 0;
  keys = keys.slice(0, 60);   // the server takes up to 60 cells in one request; the rest stay marked for the next save
  var lines = [], nOps = 0;
  keys.forEach(function (k) {
    var p = mgrPending[k];
    p.ops.forEach(function (o) {
      nOps++;
      lines.push(p.title + ': ' + (o.op === 'add' ? '+ ' : '− ') + o.name + (o.op === 'add' && o.time ? ' ' + o.time : '') +
        (o.op === 'add' && o.repeat ? ' (📅 כל שבוע ב' + mgrDowName(p.dow) + ')' : '') + (p.changed ? ' (התא השתנה מאז שסימנת)' : ''));
    });
  });
  if (more) lines.push('עוד ' + more + ' תאים יישארו מסומנים לשמירה הבאה.');
  var published = mgrBoardData && mgrBoardData.state !== 'draft';
  if (published) lines.push('הלוח פורסם — הצוות יראה את השינויים מיד.');
  // the items are built NOW, from exactly what the confirm lists, and sentOps remembers which marks they cover
  var items = [], sentOps = {}, wk = mgrPendingWeek, gen0 = loginGen;
  keys.forEach(function (k) {
    var p = mgrPending[k];
    sentOps[k] = p.ops.slice();
    items.push({ day: p.day, label: p.label, expect: p.expect,
                 ops: p.ops.map(function (o) {
                   if (o.op !== 'add') return { op: 'remove', empId: o.empId };
                   var it = { op: 'add', empId: o.empId, time: o.time || '' };
                   if (o.repeat) it.repeat = true;   // only a marked "every week" on a row the manager added (mgrPendAdd)
                   return it;
                 }) });
  });
  openAppModal(nOps === 1 ? 'שמירת שינוי' : 'שמירת ' + nOps + ' שינויים', lines.join('\n'), false, 'שמור', function () {
    if (mgrSaving) return;
    if (gen0 !== loginGen || wk !== mgrPendingWeek) return;   // logged out / another week since the confirm opened
    mgrSaving = true;
    renderMgrSaveBar();
    showToast('שומר...', 'info');
    var gen = loginGen;
    api('mgrAssignBatch', { week: wk, items: items }, { post: true, ms: 60000 }).then(function (r) {
      if (gen !== loginGen) return;
      mgrSaving = false;
      if (r && r.success) {
        var bad = 0;
        (r.results || []).forEach(function (it) {
          var k = mgrKey(it.label, it.day), p = mgrPending[k];
          if (!p) return;
          if (it.ok) {
            // remove only the marks that were sent; marks added while the save was in flight stay (re-based on the new text)
            var sent = sentOps[k] || [];
            p.ops = p.ops.filter(function (o) { return sent.indexOf(o) === -1; });
            if (p.ops.length) { p.expect = String(it.value == null ? '' : it.value); p.reason = ''; p.changed = false; } else delete mgrPending[k];
          } else { p.reason = String(it.error || 'לא נשמר'); bad++; }
        });
        if (!Object.keys(mgrPending).length) mgrPendingWeek = '';
        var w = r.written != null ? r.written : items.length - bad;
        // the cells were written but the fixed person ("every week") was not saved: the server says so in recurNote — said, never hidden
        var recurNote = r.recurNote ? String(r.recurNote) : '';
        showToast('נשמרו ' + w + (bad ? ' · ' + bad + ' לא נשמרו — הסיבה בשורה למטה' : '') + (recurNote ? ' · ' + recurNote : ''), bad || recurNote ? 'error' : 'success');
      } else if (r && r.transport) {
        showToast('לא התקבלה תשובה מהשרת. ייתכן שנשמר — לרענן ולבדוק לפני ששומרים שוב.', 'error');
      } else {
        showToast('לא נשמר: ' + (r ? r.error : ''), 'error');
      }
      // the server answers a saved batch with the fresh board (stage 5): draw it, no reload; an older server sends none — ONE reload
      var nb = r && r.success && r.board && typeof r.board === 'object' && r.board.success !== false && Array.isArray(r.board.days) ? r.board : null;
      if (nb) {
        mgrBoardInvalidate();   // an older reload still in flight must not overwrite this newer board
        mgrBoardDropped = false;   // this board stands in its place
        mgrSyncPending(nb);
        mgrBoardData = nb; mgrBoardCached = false;   // a live board now, not the stored copy
        if (Array.isArray(r.recurring)) mgrBoardData.recurring = r.recurring;   // stage 6: the fixed people after this batch
        if (r.recurNote) mgrBoardData.recurNote = String(r.recurNote);   // stays above the table until the board is read again
        mgrCacheSave();
        mgrPendRefresh();
        if (mgrDayCtx) renderMgrDay();
        if (mgrTool) renderMgrTool();
      } else {
        mgrPendRefresh();
        loadMgrBoard();   // ONE reload of the board (not the whole page)
      }
    });
  });
}

/* ==================================================================
   Stage 6 (17/10): the tools above the week table — a note or an event (which day first), a new row, the shift types, and the
   actions of one row the manager added (its fixed people, removing it). One sheet (#mgrToolSheet) and one request at a time
   (mgrToolBusy); no automatic retry — a write that got no answer may have landed, so the board / list is read again to show the
   truth. Every value printed into HTML goes through esc(); the server's refusals are shown as it says them.
   ================================================================== */
var mgrTypesSeq = 0;   // only the latest mgrShiftTypes answer is drawn

/** The three buttons above the table (≥44px tall, they wrap on a narrow phone). The note button needs the day row (an older server sends none). */
function mgrToolbarEl(res) {
  var bar = mgrEl('div', 'mgr-tools');
  var mk = function (cls, text, fn) {
    var b = mgrEl('button', 'btn btn-secondary mgr-tool ' + cls); b.type = 'button'; b.textContent = text; b.onclick = fn;
    bar.appendChild(b);
  };
  if (mgrHasInfo(res)) mk('mgr-tool-note', '📌 הערה או אירוע', function () { mgrOpenTool('day'); });
  mk('mgr-tool-row', '➕ שורה חדשה', function () { mgrOpenTool('newrow'); });
  mk('mgr-tool-types', '⚙️ סוגי משמרות', function () { mgrOpenTool('types'); });
  return bar;
}

function mgrOpenTool(mode, label) {
  if (mgrToolBusy) { showToast('עוד שומרים את מה שנשלח — לחכות רגע.', 'error'); return; }
  mgrTool = { mode: mode, label: label || '' };
  mgrToolErr = '';
  if (mode === 'newrow') mgrRowDraft = { name: '', from: '', to: '' };
  if (mode === 'types') { mgrTypeFormOpen = false; mgrTypeDraft = mgrTypeDraftNew(); mgrTypesChanged = false; loadMgrTypes(); }
  renderMgrTool();
}

function closeMgrTool() {
  if (mgrToolBusy) return;
  mgrTool = null; mgrToolErr = '';
  renderMgrTool();
}

/** A failure (a refusal on the phone or the server's own words): said in the sheet and in a toast. */
function mgrToolFail(msg) {
  mgrToolErr = String(msg == null ? '' : msg);
  showToast(mgrToolErr, 'error');
  renderMgrTool();
}

function mgrToolInput(cls, ph, max, type, getv, setv) {
  var el = document.createElement('input');
  el.type = type || 'text'; el.className = 'mgr-tin ' + cls; el.maxLength = max; el.placeholder = ph; el.value = getv();
  el.oninput = function () { setv(el.value); };
  return el;
}

function renderMgrTool() {
  var box = document.getElementById('mgrToolSheet');
  if (!box) return;
  var res = mgrBoardData, ctx = mgrTool, row = null;
  if (ctx && ctx.mode === 'row' && res) (res.rows || []).forEach(function (r) { if (r.label === ctx.label && r.kind === 'custom') row = r; });
  box.innerHTML = '';
  var ready = !!ctx && (ctx.mode === 'types' || (!!res && !!(res.days || []).length && (ctx.mode !== 'row' || !!row)));
  if (!ready) { mgrTool = null; box.style.display = 'none'; return; }   // the row is gone / the board is not there: the sheet closes
  box.style.display = 'flex';
  box.onclick = function (e) { if (e && e.target === box) closeMgrTool(); };
  var sheet = mgrEl('div', 'mgr-sheet mgr-toolsheet');
  var title = ctx.mode === 'day' ? '📌 איזה יום?' : ctx.mode === 'newrow' ? '➕ שורה חדשה' : ctx.mode === 'types' ? '⚙️ סוגי משמרות' : '🧩 ' + mgrRowTitle(row).name;
  var head = mgrEl('div', 'mgr-sheet-h', '<b>' + esc(title) + '</b>');
  var xb = mgrEl('button', 'mgr-x'); xb.type = 'button'; xb.textContent = '✕'; xb.onclick = closeMgrTool;
  head.appendChild(xb);
  sheet.appendChild(head);
  if (ctx.mode === 'day') mgrToolDay(sheet, res);
  else if (ctx.mode === 'newrow') mgrToolNewRow(sheet);
  else if (ctx.mode === 'types') mgrToolTypes(sheet);
  else mgrToolRow(sheet, res, row);
  box.appendChild(sheet);
}

function mgrToolErrEl() {
  return mgrToolErr ? mgrEl('div', 'mgr-note mgr-tool-err', '⚠️ ' + esc(mgrToolErr)) : null;
}

/* ---- a note or an event: first the day, then the existing day dialog ---- */
function mgrToolDay(sheet, res) {
  sheet.appendChild(mgrEl('div', 'mgr-legend', 'בוחרים יום, ואז כותבים הערה לצוות או מוסיפים אירוע.'));
  var chips = mgrEl('div', 'mgr-days');
  res.days.forEach(function (d) {
    var c = mgrEl('button', 'mgr-chip mgr-tool-chip mgr-pick-day' + (d.closed ? ' closed' : '')); c.type = 'button';
    c.textContent = d.name + ' ' + d.short + (d.closed ? ' · סגור' : '');
    c.disabled = !!d.closed;
    c.onclick = function () { if (d.closed) return; closeMgrTool(); mgrOpenDay(d.short); };
    chips.appendChild(c);
  });
  sheet.appendChild(chips);
}

/* ---- a new row of the board ---- */
function mgrToolNewRow(sheet) {
  var d = mgrRowDraft;
  sheet.appendChild(mgrToolInput('mgr-row-name', 'שם השורה', 30, 'text', function () { return d.name; }, function (v) { d.name = v; }));
  var tm = mgrEl('div', 'mgr-day-times');
  tm.appendChild(mgrEl('label', 'mgr-day-lbl', 'מ-'));
  tm.appendChild(mgrToolInput('mgr-row-from', 'HH:MM', 5, 'time', function () { return d.from; }, function (v) { d.from = v; }));
  tm.appendChild(mgrEl('label', 'mgr-day-lbl', 'עד'));
  tm.appendChild(mgrToolInput('mgr-row-to', 'HH:MM', 5, 'time', function () { return d.to; }, function (v) { d.to = v; }));
  sheet.appendChild(tm);
  sheet.appendChild(mgrEl('div', 'mgr-legend', 'שעות — לא חובה. אם ממלאים, הן נכתבות בסוף שם השורה.'));
  sheet.appendChild(mgrEl('div', 'mgr-legend mgr-row-hint', 'למשל: וואן שוט 02, אירוע 03. השורה נשארת גם בשבועות הבאים עד שמסירים אותה.'));
  var er = mgrToolErrEl();
  if (er) sheet.appendChild(er);
  var go = mgrEl('button', 'btn btn-sm mgr-day-go mgr-row-go'); go.type = 'button'; go.textContent = mgrToolBusy ? MGR_BUSY : 'הוסף שורה';
  go.disabled = mgrToolBusy;
  go.onclick = mgrAddRowRun;
  sheet.appendChild(go);
}

function mgrAddRowRun() {
  if (mgrToolBusy || !mgrBoardData) return;
  var d = mgrRowDraft, name = mgrFold(d.name), from = String(d.from || '').trim(), to = String(d.to || '').trim();
  var T = /^([01]\d|2[0-3]):[0-5]\d$/, bad = '';
  if (name.length < 2 || name.length > 30) bad = 'שם השורה צריך להיות בין 2 ל-30 תווים.';
  else if (name.indexOf('|') !== -1) bad = 'בשם השורה אי אפשר את התו |.';
  else if (!!from !== !!to) bad = 'שעות — או שתיהן, או אף אחת.';
  else if (from && (!T.test(from) || !T.test(to))) bad = 'שעה לא תקינה — למשל 18:00.';
  else if (from && to <= from) bad = 'שעת הסיום צריכה להיות אחרי שעת ההתחלה.';
  if (bad) { mgrToolFail(bad); return; }
  var params = { week: String(mgrBoardData.week || ''), name: name };
  if (from) { params.from = from; params.to = to; }
  mgrToolBusy = true; mgrToolBusyOn = 'newrow'; mgrToolErr = '';
  renderMgrTool();
  var gen = loginGen;
  api('mgrAddRow', params, { post: true, ms: 60000 }).then(function (r) {
    if (gen !== loginGen) return;
    mgrToolBusy = false; mgrToolBusyOn = '';
    if (r && r.success) {
      showToast('השורה נוספה: ' + (r.label || name) + ' ✓', 'success');
      mgrTool = null; mgrToolErr = ''; mgrRowDraft = { name: '', from: '', to: '' };
      renderMgrTool();
      if (!mgrBoardFromAnswer(r)) loadMgrBoard();   // stage 7: the answer carries the board; an older server: ONE reload
    } else if (r && r.transport) {
      mgrToolFail('לא התקבלה תשובה מהשרת. ייתכן שהשורה נוספה — לבדוק בטבלה לפני שמנסים שוב.');
      loadMgrBoard();
    } else {
      mgrToolFail('לא נוספה: ' + (r ? r.error : ''));
    }
  });
}

/* ---- one row the manager added: its fixed people, and removing it ---- */
function mgrRowPendingOn(label) {
  return Object.keys(mgrPending).some(function (k) { return mgrPending[k].label === label && mgrPending[k].ops.length; });
}

/** A row can go only when every cell of it is empty and nothing is marked on it (the server checks the cells again under its lock). */
function mgrRowRemovable(row) {
  if ((row.cells || []).some(function (c) { return c && String(c.v == null ? '' : c.v).trim(); })) return false;
  return !mgrRowPendingOn(row.label);
}

function mgrToolRow(sheet, res, row) {
  var recs = (Array.isArray(res.recurring) ? res.recurring : []).filter(function (r) { return r && r.label === row.label; });
  sheet.appendChild(mgrEl('div', 'mgr-sub', 'אנשים קבועים בשורה'));
  if (!recs.length) {
    sheet.appendChild(mgrEl('div', 'mgr-legend mgr-rec-none', 'אין אף אחד קבוע בשורה הזו. כדי לקבע — בוחרים תא בשורה ומסמנים "📅 כל שבוע".'));
  }
  recs.forEach(function (rc) {
    var line = mgrEl('div', 'mgr-curp mgr-rec-line', '<span>📅 ' + esc(rc.name || rc.empId) + ' כל ' + esc(mgrDowName(rc.dow)) + '</span>');
    var cb = mgrEl('button', 'btn btn-secondary btn-sm mgr-rec-cancel'); cb.type = 'button'; cb.disabled = mgrToolBusy;
    cb.textContent = mgrToolBusyOn === 'rec:' + rc.empId + ':' + rc.dow ? MGR_BUSY : 'בטל';
    cb.onclick = function () { mgrRecurringCancel(rc); };
    line.appendChild(cb);
    sheet.appendChild(line);
  });
  if (recs.length) sheet.appendChild(mgrEl('div', 'mgr-legend', 'ביטול קבוע לא נוגע בתאים שכבר בלוח.'));
  var er = mgrToolErrEl();
  if (er) sheet.appendChild(er);
  var ok = mgrRowRemovable(row);
  var rm = mgrEl('button', 'btn btn-secondary mgr-row-remove'); rm.type = 'button'; rm.textContent = mgrToolBusyOn === 'rm' ? MGR_BUSY : '🗑 להסיר את השורה';
  rm.disabled = !ok || mgrToolBusy;
  rm.onclick = function () { if (!mgrRowRemovable(row)) return; mgrRowRemoveAsk(row.label); };   // a disabled button never fires, but the rule stays here too
  sheet.appendChild(rm);
  sheet.appendChild(mgrEl('div', 'mgr-legend mgr-row-rmhint', ok ? 'הסרת שורה מוחקת גם את האנשים הקבועים שלה.' : 'אפשר להסיר רק שורה ריקה — בלי שיבוצים בלוח ובלי סימונים שעוד לא נשמרו.'));
}

function mgrRecurringCancel(rc) {
  if (mgrToolBusy) return;
  mgrToolBusy = true; mgrToolBusyOn = 'rec:' + rc.empId + ':' + rc.dow; mgrToolErr = '';
  renderMgrTool();
  var gen = loginGen;
  api('mgrRecurringRemove', { label: rc.label, dow: rc.dow, empId: rc.empId }, { post: true, ms: 60000 }).then(function (r) {
    if (gen !== loginGen) return;
    mgrToolBusy = false; mgrToolBusyOn = '';
    if (r && r.success) {
      showToast('הקבוע בוטל ✓', 'success');
      if (r.board && typeof r.board === 'object' && Array.isArray(r.recurring)) r.board.recurring = r.recurring;   // the fixed people after this cancel
      if (mgrBoardFromAnswer(r)) {
        renderMgrTool();
      } else if (mgrBoardData && Array.isArray(r.recurring)) {
        mgrBoardInvalidate();   // a reload still in flight is older than this write
        mgrBoardData.recurring = r.recurring;
        renderMgrAssign();
        renderMgrTool();
        mgrBoardRefreshIfDropped();
      } else {
        renderMgrTool();
        loadMgrBoard();
      }
    } else if (r && r.transport) {
      mgrToolFail('לא התקבלה תשובה מהשרת. ייתכן שהקבוע בוטל — לבדוק לפני שמנסים שוב.');
      loadMgrBoard();
    } else {
      mgrToolFail('לא בוטל: ' + (r ? r.error : ''));
    }
  });
}

function mgrRowRemoveAsk(label) {
  if (mgrToolBusy) return;
  openAppModal('הסרת שורה', 'להסיר מהלוח את השורה "' + label + '"? אין בה שיבוצים. גם האנשים הקבועים שלה יימחקו, ואי אפשר לבטל.', false, 'הסר', function () { mgrRowRemoveRun(label); });
}

function mgrRowRemoveRun(label) {
  if (mgrToolBusy || !mgrBoardData) return;
  var row = null;
  (mgrBoardData.rows || []).forEach(function (r) { if (r.label === label && r.kind === 'custom') row = r; });
  if (!row || !mgrRowRemovable(row)) { mgrToolFail('בשורה יש עכשיו שיבוצים או סימונים — להוציא אותם קודם.'); return; }   // the confirm was open a while
  mgrToolBusy = true; mgrToolBusyOn = 'rm'; mgrToolErr = '';
  renderMgrTool();
  var gen = loginGen;
  api('mgrRemoveRow', { week: String(mgrBoardData.week || ''), label: label }, { post: true, ms: 60000 }).then(function (r) {
    if (gen !== loginGen) return;
    mgrToolBusy = false; mgrToolBusyOn = '';
    if (r && r.success) {
      var n = Number(r.droppedRecurring) || 0;
      showToast('השורה הוסרה ✓' + (n ? ' · בוטלו ' + n + ' קבועים' : ''), 'success');
      mgrTool = null; mgrToolErr = '';
      renderMgrTool();
      if (!mgrBoardFromAnswer(r)) loadMgrBoard();   // stage 7: the answer carries the board; an older server: ONE reload
    } else if (r && r.transport) {
      mgrToolFail('לא התקבלה תשובה מהשרת. ייתכן שהשורה הוסרה — לבדוק בטבלה לפני שמנסים שוב.');
      loadMgrBoard();
    } else {
      mgrToolFail('לא הוסרה: ' + (r ? r.error : ''));
    }
  });
}

/* ---- shift types: on / off, and a new one ---- */
function loadMgrTypes() {
  var gen = loginGen, seq = ++mgrTypesSeq;
  mgrTypesState = 'loading'; mgrTypes = null;
  api('mgrShiftTypes').then(function (r) {
    if (gen !== loginGen || seq !== mgrTypesSeq) return;
    if (r && r.success && Array.isArray(r.types)) { mgrTypes = r.types; mgrTypesState = ''; mgrToolErr = ''; }
    else { mgrTypesState = 'error'; mgrToolErr = r && r.transport ? 'כשל בתקשורת מול השרת' : 'שגיאה: ' + String(r && r.error ? r.error : ''); }
    if (mgrTool && mgrTool.mode === 'types') renderMgrTool();
  });
}

function mgrTypeDays(t) {
  var ds = String(t.days == null ? '' : t.days).split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
  if (ds.length === 6 && MGR_DAYS6.every(function (x) { return ds.indexOf(x) !== -1; })) return 'כל הימים';
  // stage 8: three or more days in a row read as a range ("א–ה"), like the rest of the sheet's one-line summary
  var ix = ds.map(function (x) { return MGR_DAYS6.indexOf(x); }).sort(function (a, b) { return a - b; });
  if (ix.length >= 3 && ix.every(function (v, i) { return v !== -1 && (i === 0 || v === ix[i - 1] + 1); })) return MGR_DAYS6[ix[0]] + '–' + MGR_DAYS6[ix[ix.length - 1]];
  return ds.join(' ');
}

function mgrToolTypes(sheet) {
  if (!mgrTypeDraft) mgrTypeDraft = mgrTypeDraftNew();
  sheet.appendChild(mgrEl('div', 'mgr-legend', 'סוג שכבוי לא נבנה בלוח. אפשר להדליק אותו שוב בכל זמן.'));
  // stage 8: a one-off event outside the store is not a shift type - it is an event of the week (with "needs staff")
  sheet.appendChild(mgrEl('div', 'mgr-legend mgr-type-evhint', 'אירוע חד-פעמי מחוץ לחנות (למשל אירוע משחקי תפקידים) הוא לא סוג משמרת: מוסיפים אותו ב"אירועי השבוע" (🔨 בנייה ← "+ אירוע", עם "צריך צוות"). סוג משמרת הוא משמרת שחוזרת, כמו קייטנה. שעות במועדון או בחוץ לא נספרות בתקציב שעות החנות.'));
  if (mgrTypesChanged) {
    var chg = mgrEl('div', 'mgr-note mgr-types-note', 'השינוי ייכנס ללוח בבנייה הבאה');
    var bb = mgrEl('button', 'btn btn-sm mgr-types-build'); bb.type = 'button'; bb.textContent = '🔨 בנה מחדש עכשיו';
    bb.disabled = mgrToolBusy;
    bb.onclick = mgrToolBuild;
    chg.appendChild(bb);
    sheet.appendChild(chg);
  }
  var er = mgrToolErrEl();
  if (er) sheet.appendChild(er);
  if (mgrTypesState === 'loading') {
    sheet.appendChild(mgrEl('div', 'loader', 'טוען את סוגי המשמרות...'));
  } else if (!mgrTypes) {
    var rt = mgrEl('button', 'btn btn-secondary btn-sm mgr-types-retry'); rt.type = 'button'; rt.textContent = '↻ נסה שוב';
    rt.onclick = function () { mgrToolErr = ''; loadMgrTypes(); renderMgrTool(); };
    sheet.appendChild(rt);
  } else {
    if (!mgrTypes.length) sheet.appendChild(mgrEl('div', 'mgr-empty', 'אין עדיין סוגי משמרות בטאב "תבניות משמרת".'));
    mgrTypes.forEach(function (t) {
      var line = mgrEl('div', 'mgr-type' + (t.active ? '' : ' off'),
        '<div class="mgr-type-t"><b>' + esc(t.name) + '</b>' + (t.training ? ' <span class="mgr-tr">התלמדות</span>' : '') +
        '<small><bdi>' + esc(t.from) + '–' + esc(t.to) + '</bdi> · ' + esc(mgrTypeDays(t)) + (t.location ? ' · <span class="mgr-type-where">' + esc(t.location) + '</span>' : '') + '</small></div>');
      var sw = mgrEl('button', 'mgr-sw ' + (t.active ? 'on' : 'off')); sw.type = 'button';
      sw.textContent = mgrToolBusyOn === 'sw:' + t.id ? MGR_BUSY : (t.active ? 'פעיל' : 'כבוי');
      sw.setAttribute('aria-pressed', t.active ? 'true' : 'false');
      sw.disabled = mgrToolBusy;
      sw.onclick = function () { mgrTypeSwitch(t); };
      line.appendChild(sw);
      sheet.appendChild(line);
    });
    mgrToolTypeForm(sheet);
  }
  var cc = mgrChugCard(mgrOvData);   // stage 8: the chugim switch and "refresh now" live here too
  if (cc) sheet.appendChild(cc);
}

function mgrTypeSwitch(t) {
  if (mgrToolBusy) return;
  mgrToolBusy = true; mgrToolBusyOn = 'sw:' + t.id; mgrToolErr = '';
  renderMgrTool();
  var gen = loginGen;
  api('mgrShiftTypeSet', { id: t.id, active: !t.active }, { post: true, ms: 60000 }).then(function (r) {
    if (gen !== loginGen) return;
    mgrToolBusy = false; mgrToolBusyOn = '';
    if (r && r.success && Array.isArray(r.types)) {
      mgrTypes = r.types; mgrTypesChanged = true; mgrToolErr = '';
      renderMgrTool();
    } else if (r && r.transport) {
      mgrToolFail('לא התקבלה תשובה מהשרת. ייתכן שהשינוי נשמר — הרשימה נטענת מחדש.');
      loadMgrTypes();
    } else {
      mgrToolFail(r && r.error ? r.error : 'לא נשמר');
    }
  });
}

function mgrToolTypeForm(sheet) {
  var d = mgrTypeDraft;
  if (!mgrTypeFormOpen) {
    var ob = mgrEl('button', 'btn btn-secondary mgr-type-open'); ob.type = 'button'; ob.textContent = '+ סוג משמרת חדש'; ob.disabled = mgrToolBusy;
    ob.onclick = function () { mgrTypeFormOpen = true; renderMgrTool(); };
    sheet.appendChild(ob);
    return;
  }
  var f = mgrEl('div', 'mgr-type-form');
  f.appendChild(mgrEl('div', 'mgr-sub', 'סוג משמרת חדש'));
  f.appendChild(mgrToolInput('mgr-type-name', 'שם (בלי המילה "משמרת")', 24, 'text', function () { return d.name; }, function (v) { d.name = v; }));
  var tm = mgrEl('div', 'mgr-day-times');
  tm.appendChild(mgrEl('label', 'mgr-day-lbl', 'מ-'));
  tm.appendChild(mgrToolInput('mgr-type-from', 'HH:MM', 5, 'time', function () { return d.from; }, function (v) { d.from = v; }));
  tm.appendChild(mgrEl('label', 'mgr-day-lbl', 'עד'));
  tm.appendChild(mgrToolInput('mgr-type-to', 'HH:MM', 5, 'time', function () { return d.to; }, function (v) { d.to = v; }));
  f.appendChild(tm);
  var days = mgrEl('div', 'mgr-days mgr-type-days');
  MGR_DAYS6.forEach(function (letter) {
    var on = d.days.indexOf(letter) !== -1;
    var c = mgrEl('button', 'mgr-chip mgr-tool-chip mgr-type-day' + (on ? ' on' : '')); c.type = 'button'; c.textContent = letter;
    c.setAttribute('aria-pressed', on ? 'true' : 'false');
    c.onclick = function () {
      d.days = on ? d.days.filter(function (x) { return x !== letter; }) : d.days.concat([letter]);
      renderMgrTool();
    };
    days.appendChild(c);
  });
  f.appendChild(days);
  var loc = mgrEl('select', 'mgr-tin mgr-type-loc', MGR_TYPE_LOCATIONS.map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + '</option>'; }).join(''));
  loc.value = d.location;
  var lochint = mgrEl('div', 'mgr-legend mgr-type-lochint');
  var setLocHint = function () { lochint.textContent = d.location === MGR_TYPE_EXT ? 'חיצוני = משמרת קבועה מחוץ לחנות (למשל קייטנה). אירוע חד-פעמי — דרך "אירועי השבוע".' : ''; };
  loc.onchange = function () { d.location = loc.value; setLocHint(); };
  f.appendChild(loc);
  setLocHint();
  f.appendChild(lochint);
  var acts = mgrEl('div', 'mgr-acts');
  var go = mgrEl('button', 'btn btn-sm mgr-type-add'); go.type = 'button'; go.textContent = mgrToolBusy ? MGR_BUSY : 'הוסף סוג'; go.disabled = mgrToolBusy;
  go.onclick = mgrTypeAddRun;
  var no = mgrEl('button', 'btn btn-secondary btn-sm mgr-type-cancel'); no.type = 'button'; no.textContent = 'ביטול';
  no.onclick = function () { if (mgrToolBusy) return; mgrTypeFormOpen = false; renderMgrTool(); };
  acts.appendChild(go); acts.appendChild(no);
  f.appendChild(acts);
  sheet.appendChild(f);
}

function mgrTypeAddRun() {
  if (mgrToolBusy || !mgrTypeDraft) return;
  var d = mgrTypeDraft, name = mgrFold(d.name), from = String(d.from || '').trim(), to = String(d.to || '').trim();
  var T = /^([01]\d|2[0-3]):[0-5]\d$/, bad = '';
  var days = MGR_DAYS6.filter(function (x) { return d.days.indexOf(x) !== -1; });
  if (name.length < 2 || name.length > 24) bad = 'שם הסוג צריך להיות בין 2 ל-24 תווים.';
  else if (name.indexOf('|') !== -1) bad = 'בשם הסוג אי אפשר את התו |.';
  else if (name.indexOf('משמרת ') === 0) bad = 'בלי המילה "משמרת" בתחילת השם — היא מתווספת לבד.';
  else if (!T.test(from) || !T.test(to)) bad = 'שעת התחלה ושעת סיום — למשל 09:30.';
  else if (to <= from) bad = 'שעת הסיום צריכה להיות אחרי שעת ההתחלה.';
  else if (!days.length) bad = 'לבחור לפחות יום אחד.';
  else if (MGR_TYPE_LOCATIONS.indexOf(d.location) === -1) bad = 'לבחור מיקום.';
  if (bad) { mgrToolFail(bad); return; }
  mgrToolBusy = true; mgrToolErr = '';
  renderMgrTool();
  var gen = loginGen;
  api('mgrShiftTypeAdd', { name: name, from: from, to: to, days: days, location: d.location }, { post: true, ms: 60000 }).then(function (r) {
    if (gen !== loginGen) return;
    mgrToolBusy = false; mgrToolBusyOn = '';
    if (r && r.success && Array.isArray(r.types)) {
      mgrTypes = r.types; mgrTypesChanged = true; mgrToolErr = '';
      mgrTypeFormOpen = false; mgrTypeDraft = mgrTypeDraftNew();
      showToast('נוסף סוג משמרת: ' + name + ' ✓', 'success');
      renderMgrTool();
    } else if (r && r.transport) {
      mgrToolFail('לא התקבלה תשובה מהשרת. ייתכן שהסוג נוסף — הרשימה נטענת מחדש.');
      loadMgrTypes();
    } else {
      mgrToolFail('לא נוסף: ' + (r ? r.error : ''));
    }
  });
}

/* ==================================================================
   Stage 8 (17/10): the chugim kept fresh. The board's chug rows come from the chugim file on every build; between builds nothing
   refreshed them. Now: a switch (a daily trigger on the server, mgrChugAuto {on} -> {success, on}; its state is mgrOverview.chugAuto) and
   "refresh now" (mgrChugRefresh -> {success, changed:[…], clashes:[…], board}). Both POST, one request at a time, no automatic retry.
   The block sits in the build area and in the shift-types sheet; every server text goes through esc().
   ================================================================== */
var MGR_CHUG_LINES = 10;   // how many lines of a list are printed; the rest is counted

/** One line of a server list — a string, or an object with a text — on one line; '' when there is nothing to print. */
function mgrChugLine(x) {
  if (x && typeof x === 'object') x = x.text;
  return mgrFold(x);
}
function mgrChugLines(a) { return (Array.isArray(a) ? a : []).map(mgrChugLine).filter(function (x) { return x; }); }

/** The block (null while the overview does not say: an older server has no switch). */
function mgrChugCard(res) {
  if (!res || typeof res.chugAuto !== 'boolean') return null;
  var on = res.chugAuto, busy = !!mgrChugBusy;
  var unknown = !!res.chugAutoError;   // the server could not ask the project's triggers: the state is NOT "off", it is not known
  var card = mgrEl('div', 'card mgr-status mgr-chug');
  card.appendChild(mgrEl('b', 'mgr-chug-h', '🌅 חוגים מהקובץ'));
  card.appendChild(mgrEl('div', 'mgr-legend mgr-chug-info', 'החוגים בלוח באים מקובץ החוגים, בכל בנייה. כשהמתג דלוק הם מתעדכנים גם כל בוקר, בלי לבנות מחדש — רק שורות החוגים משתנות, שום דבר אחר בלוח.'));
  var row = mgrEl('div', 'mgr-chug-row');
  row.appendChild(mgrEl('span', 'mgr-chug-t', 'חוגים מתעדכנים מהקובץ כל בוקר'));
  var sw = mgrEl('button', 'mgr-sw mgr-chug-sw ' + (unknown ? 'unknown' : (on ? 'on' : 'off'))); sw.type = 'button';
  sw.textContent = mgrChugBusy === 'auto' ? MGR_BUSY : (unknown ? 'לא ידוע' : (on ? 'פעיל' : 'כבוי'));
  sw.setAttribute('aria-pressed', unknown ? 'mixed' : (on ? 'true' : 'false'));
  sw.disabled = busy || unknown;   // not knowing which way it is, a tap would be a guess
  sw.onclick = function () { if (unknown) return; mgrChugAutoRun(!on); };   // the button is disabled too; a tap that gets through must not guess a direction
  row.appendChild(sw);
  card.appendChild(row);
  if (unknown) card.appendChild(mgrEl('div', 'mgr-note mgr-chug-unk', '⚠️ לא ידוע אם העדכון האוטומטי דלוק' + (mgrFold(res.chugAutoError) ? ': ' + esc(mgrFold(res.chugAutoError)) : '') + ' — ↻ לרענן את המסך ולנסות שוב.'));
  var rf = mgrEl('button', 'btn btn-sm btn-secondary mgr-chug-refresh'); rf.type = 'button';
  rf.textContent = mgrChugBusy === 'refresh' ? MGR_BUSY : '🔄 רענן חוגים עכשיו';
  rf.disabled = busy;
  rf.onclick = mgrChugRefreshRun;
  card.appendChild(rf);
  var out = mgrChugResultEl();
  if (out) card.appendChild(out);
  return card;
}

/** What the last "refresh now" answered: what changed, the clashes it found (warning style), or its refusal. */
function mgrChugResultEl() {
  var r = mgrChugResult;
  if (!r) return null;
  var el = mgrEl('div', 'mgr-build-out mgr-chug-out');
  if (!r.ok) { el.appendChild(mgrEl('div', 'mgr-note mgr-chug-err', '⚠️ ' + esc(r.error))); return el; }
  var n = r.changed.length;
  // "already match" is a fact only when the board was looked at: with the board skipped nothing was compared
  if (n) el.appendChild(mgrEl('div', 'mgr-ok mgr-chug-head', '✅ עודכנו ' + n + (n === 1 ? ' תא חוג' : ' תאי חוגים') + ' בלוח'));
  else if (r.check === 'skipped') el.appendChild(mgrEl('div', 'mgr-note mgr-chug-head mgr-chug-nothing', 'ℹ️ הלוח לא נבדק ולא שונה בו דבר — ראו את ההערות'));
  else el.appendChild(mgrEl('div', 'mgr-ok mgr-chug-head', '✅ החוגים בלוח כבר תואמים לקובץ'));
  var lines = function (arr, cls) {
    arr.slice(0, MGR_CHUG_LINES).forEach(function (t) { el.appendChild(mgrEl('div', cls, esc(t))); });
    if (arr.length > MGR_CHUG_LINES) el.appendChild(mgrEl('div', cls + ' mgr-chug-more', 'ועוד ' + (arr.length - MGR_CHUG_LINES) + '…'));
  };
  lines(r.changed, 'mgr-legend mgr-chug-line');
  lines(r.notes || [], 'mgr-legend mgr-chug-note');   // what the server skipped or could not read (it sends notes, not a message)
  if (r.clashes.length) {
    el.appendChild(mgrEl('div', 'mgr-note mgr-chug-clash-h', '⚠️ התנגשויות בשבוע (' + r.clashes.length + '):'));
    lines(r.clashes, 'mgr-note mgr-chug-clash');
  } else if (r.check === 'ok') {
    el.appendChild(mgrEl('div', 'mgr-legend mgr-chug-noclash', 'אין התנגשויות בין חוגים לאירועים ✓'));
  } else {
    // "no clashes" is only said when the server says it looked: a skipped board, a failed check, or no word at all is "not known"
    el.appendChild(mgrEl('div', 'mgr-note mgr-chug-noclash mgr-chug-unknown', r.check === 'skipped' ? 'התנגשויות לא נבדקו — הלוח לא רוענן.' :
      (r.check === 'failed' ? 'בדיקת ההתנגשויות לא הצליחה — לא ידוע אם יש התנגשויות.' : 'לא ידוע אם יש התנגשויות — השרת לא אישר שהבדיקה רצה.')));
  }
  return el;
}

/** The build card and the open shift-types sheet drawn again from the state (the hourglass, the result). */
function mgrChugRedraw() {
  if (mgrOpened && mgrOvData) renderMgrBuild(mgrOvData);
  if (mgrTool && mgrTool.mode === 'types') renderMgrTool();
}

/** The switch: ONE POST with the state it should have (so a repeat is harmless); the server's answer says what it is now. */
function mgrChugAutoRun(next) {
  if (mgrChugBusy) return;
  mgrChugBusy = 'auto';
  mgrChugRedraw();
  var gen = loginGen;
  api('mgrChugAuto', { on: !!next }, { post: true, ms: 60000 }).then(function (r) {
    if (gen !== loginGen) return;
    mgrChugBusy = '';
    if (r && r.success) {
      var on = typeof r.on === 'boolean' ? r.on : !!next;
      if (mgrOvData) { mgrOvData.chugAuto = on; delete mgrOvData.chugAutoError; mgrCacheSave(); }   // the server's answer says what it is now: no longer "unknown"
      showToast(on ? 'החוגים יתעדכנו מהקובץ כל בוקר ✓' : 'העדכון האוטומטי של החוגים כבוי ✓', 'success');
    } else if (r && r.transport) {
      showToast('לא התקבלה תשובה מהשרת. ייתכן שהשינוי נשמר — המצב נטען מחדש.', 'error');
      loadMgrOverview();
    } else {
      showToast('לא עודכן: ' + (r && r.error ? r.error : ''), 'error');
    }
    mgrChugRedraw();
  });
}

/** "Refresh now": ONE POST. The answer carries the board (drawn at once); without it, a change means ONE board reload. */
function mgrChugRefreshRun() {
  if (mgrChugBusy) return;
  if (mgrBuilding) { showToast('בנייה רצה עכשיו — לחכות שתסתיים.', 'error'); return; }
  mgrChugBusy = 'refresh'; mgrChugResult = null;
  mgrChugRedraw();
  var gen = loginGen;
  api('mgrChugRefresh', {}, { post: true, ms: 120000 }).then(function (r) {
    if (gen !== loginGen) return;
    mgrChugBusy = '';
    if (r && r.success) {
      var changed = mgrChugLines(r.changed);
      var check = r.clashCheck === 'ok' || r.clashCheck === 'skipped' || r.clashCheck === 'failed' ? r.clashCheck : '';
      mgrChugResult = { ok: true, changed: changed, clashes: mgrChugLines(r.clashes), notes: mgrChugLines(r.notes), check: check };
      if (changed.length) showToast('החוגים עודכנו מהקובץ ✓', 'success');
      else if (check === 'skipped') showToast('לא עודכן דבר בלוח — ראו את ההערות', 'error');
      else showToast('החוגים כבר תואמים לקובץ ✓', 'success');
      if (!mgrBoardFromAnswer(r) && changed.length) loadMgrBoard();
    } else if (r && r.transport) {
      mgrChugResult = { ok: false, error: 'לא התקבלה תשובה מהשרת. ייתכן שהחוגים כן עודכנו — לבדוק בטבלה לפני שמנסים שוב.' };
      showToast(mgrChugResult.error, 'error');
      loadMgrBoard();
    } else {
      mgrChugResult = { ok: false, error: 'לא עודכן: ' + (r && r.error ? r.error : '') };
      showToast(mgrChugResult.error, 'error');
    }
    mgrOpenFold('mgrDetBuild');   // the result is not left folded
    mgrChugRedraw();
  });
}

/** "Build again now" — the same confirm and the same build as the card's button (mgrAskBuild), never a path of its own. */
function mgrToolBuild() {
  if (mgrToolBusy) return;
  if (mgrBuilding) { showToast('בנייה רצה עכשיו — לחכות שתסתיים.', 'error'); return; }
  var pl = mgrBuildPlan(mgrOvData);
  if (!pl) { showToast('אין עדיין נתוני בנייה — ↻ רענון ונסו שוב.', 'error'); return; }
  mgrTool = null; mgrToolErr = '';
  renderMgrTool();
  mgrAskBuild(pl);
}

/** The week check on the phone — read only, with the settings typed in the sheet. */
function renderMgrCheckButton() {
  var box = document.getElementById('mgrCheck');
  if (!box) return;
  box.innerHTML = '';
  var sec = mgrEl('div', 'mgr-sec');   // the title is the summary of the section it sits in (index.html)
  var b = mgrEl('button', 'btn btn-sm btn-secondary mgr-run-check'); b.type = 'button'; b.textContent = 'הרץ בדיקה על הלוח שבגיליון';
  b.onclick = loadMgrCheck;
  sec.appendChild(b);
  box.appendChild(sec);
}

function loadMgrCheck() {
  var box = document.getElementById('mgrCheck');
  if (!box) return;
  box.innerHTML = '<div class="loader">בודק את השבוע...</div>';
  var gen = loginGen;
  api('mgrWeekCheck').then(function (res) {
    if (gen !== loginGen) return;
    if (!res || !res.success) {
      renderMgrCheckButton();
      box.appendChild(mgrEl('div', 'empty-state', res && res.transport ? 'כשל בתקשורת מול השרת' : 'שגיאה: ' + esc(res ? res.error : '')));
      return;
    }
    renderMgrCheck(box, res);
  });
}

function renderMgrCheck(box, r) {
  box.innerHTML = '';
  var sec = mgrEl('div', 'mgr-sec', '<h4>' + (isoShort(r.week) ? 'שבוע ' + esc(isoShort(r.week)) : 'בדיקת השבוע') + '</h4>');
  var b = r.budget || {};
  var gap = function (g) { return g > 0 ? g + ' שעות מעל ההקצאה' : (g < 0 ? (-g) + ' שעות מתחת להקצאה' : 'בדיוק ההקצאה'); };
  if (r.settingsNote) sec.appendChild(mgrEl('p', 'mgr-note', esc(r.settingsNote)));
  sec.appendChild(mgrEl('p', 'mgr-st', 'עובדים שעתיים: <b>' + esc(b.hourly) + '</b> שעות' +
    (b.valid ? ' — ' + esc(gap(b.gap)) + ' (הקצאה ' + esc(b.allowance) + ', תקרה ' + esc(b.cap) + ')' : '') +
    (b.managers ? ' · כולל מנהל שעתי: ' + esc(b.total) : '')));
  // stage 8 (review): camp / outside-event shifts are not store hours - kept out of the budget above, and shown here so nothing disappears
  if (b.offStore > 0) sec.appendChild(mgrEl('p', 'mgr-legend mgr-offstore', 'שעות מחוץ לחנות (קייטנה / חיצוני): ' + esc(b.offStore) + ' · לא נספרות בתקציב'));
  // stage 10: where the month-to-date came from (Caspit's feed / the clock / the number typed), and the new clock's line (information only)
  if (b.sourceText) sec.appendChild(mgrEl('p', 'mgr-legend mgr-budget-src', esc(b.sourceText)));
  if (b.clockLine) sec.appendChild(mgrEl('p', 'mgr-legend mgr-budget-clock', esc(b.clockLine)));
  var list = function (title, items, fmt, cls) {
    sec.appendChild(mgrEl('p', 'mgr-sub', esc(title) + ' (' + items.length + ')'));
    if (!items.length) { sec.appendChild(mgrEl('div', 'mgr-line mgr-none', 'אין ✓')); return; }
    items.forEach(function (x) { sec.appendChild(mgrEl('div', 'mgr-line' + (cls ? ' ' + cls(x) : ''), fmt(x))); });
  };
  list('התנגשויות', r.conflicts || [], function (c) {
    var what = c.kind === 'weekly' ? 'הגיש "' + c.status + '"' : c.kind === 'fixed' ? 'אילוץ קבוע: "' + c.status + '"' :
               c.kind === 'soft' ? 'הגיש "' + c.status + '"' : 'רשום כנעדר: ' + c.status;
    return '<b>' + esc(c.name) + '</b> — ' + esc(c.day + ' ' + c.short + ' ' + c.shift) + ': ' + esc(what);
  }, function (c) { return c.kind === 'soft' ? 'soft' : 'hard'; });
  list('משמרות ריקות', r.empty || [], function (e) { return esc(e.day + ' ' + e.short + ' — ' + e.label); });
  list('אירועים בלי עובד', r.demand || [], function (e) { return esc(e.day + ' ' + e.short + ' — ' + e.title); });
  // stage 8: a chug in the store at the time of a store event, one person in two places — read from the board (a server without it sends none)
  var tcl = Array.isArray(r.timeClashes) ? r.timeClashes : (Array.isArray(r.clashes) ? r.clashes : null);
  if (tcl) list('התנגשויות בזמן', tcl, function (c) { return (c && c.kind === 'person' ? '👤 ' : '🚪 ') + esc(mgrChugLine(c)); }, function (c) { return 'mgr-clash mgr-clash-' + (c && c.kind === 'person' ? 'person' : 'room'); });
  if ((r.notScheduled || []).length) list('הגישו ולא קיבלו משמרת', r.notScheduled, function (n) { return esc(n.name + ' (ביקש ' + n.target + ')' + (n.notes ? ' — ' + n.notes : '')); });
  if ((r.uncounted || []).length) list('תאים שלא נספרו', r.uncounted, function (u) { return esc(u.short + ' ' + u.label + ': ' + u.text + ' (' + u.why + ')'); });
  sec.appendChild(mgrEl('p', 'mgr-sub', 'אנשים'));
  (r.people || []).forEach(function (p) {
    if (!p.shifts && !p.submitted) return;
    sec.appendChild(mgrEl('div', 'mgr-line', '<b>' + esc(p.name) + '</b> — ' + esc(p.shifts) + ' משמרות, ' + esc(p.hours) + ' ש׳' +
      (p.target ? ' (יעד ' + esc(p.target) + ')' : '') + (p.manager ? ' · מנהל שעתי' : '') +
      ((p.fair || []).length ? ' · ' + esc(p.fair.join(' · ')) : '') + ((p.flags || []).length ? ' · ⚠️ ' + esc(p.flags.join(' · ')) : '')));
  });
  sec.appendChild(mgrEl('p', 'mgr-legend', 'קריאה בלבד: שום תא לא השתנה.' + (!b.source || b.source === 'typed' ? ' התקציב לפי היעד והשעות מכספית שהוקלדו ב"בדיקת השבוע" בגיליון.' : '')));
  var again = mgrEl('button', 'btn btn-sm btn-secondary mgr-run-check'); again.type = 'button'; again.textContent = '↻ בדיקה שוב';
  again.onclick = loadMgrCheck;
  sec.appendChild(again);
  box.appendChild(sec);
}

/* ==================================================================
   Stage 9 (18/10): the staff card — the fold "👥 צוות". ONE read (mgrStaffCards: the staff tab, the 101 forms, the chugim file and
   the payslip summary) on the first open of the fold after a login, and on ↻. Never fetched ahead (each outside file costs Google
   seconds) and never stored on the phone: it carries the 101 status and the payroll filing of people. Memory only, cleared on login
   and logout. The writes — link a folder (mgrStaffLinkFolder), a chugim name as an alias (mgrStaffAddAlias), a person from a 101
   form (mgrStaffAddFrom101), a chugim-only instructor (the existing mgrAddPerson) — are ONE POST each, one at a time, with no
   automatic retry (it may have landed); the server checks everything again under its lock and answers with fresh cards.
   Every server text goes through esc(); an href is set only after its address was checked.
   ================================================================== */
var mgrStaff = null;          // the last mgrStaffCards answer (memory only)
var mgrStaffState = '';       // '' | 'loading' | 'error'
var mgrStaffErr = '';         // the last failed read, said at the top of the fold
var mgrStaffWriteErr = '';    // the last failed write (the server's words), said in the fold and in the open sheet
var mgrStaffSeq = 0;          // only the latest read is drawn
var mgrStaffLoaded = false;   // the fold asked once since the login: opening it again does not ask again (↻ does)
var mgrStaffBusy = '';        // the tag of the write on its way ('' = none): its button shows the hourglass, every write button is disabled
var mgrStaffFilter = 'all';   // 'all' | 'open' | 'store' | 'dnd' | 'left'
var mgrStaffIds = null;       // the list narrowed by a line of "לטיפול": {key, text, ids}
var mgrStaffCtx = null;       // the open sheet: {mode: 'person'|'dnd', id} or {mode: 'add'|'alias', key}
var mgrStaffKind = 'staff';   // what is chosen in the "add from a 101 form" sheet (survives a redraw)
var mgrStaffSheetScroll = 0;  // the sheet's scroll position, kept over a redraw (a write redraws it: the ⏳ stays where the finger was)
var mgrStaffSheetCtx = null;  // the context the sheet was drawn for last: a new one (another person, a picker, its card again) starts at the top
// the server's own rule for a pasted folder link; an href to open a folder is set only for an address of this shape
var MGR_DRIVE_FOLDER_RE = /^https:\/\/drive\.google\.com\/drive\/(u\/\d+\/)?folders\/([A-Za-z0-9_-]{20,})(\?.*)?$/;
var MGR_DRIVE_OPEN_RE = /^https:\/\/drive\.google\.com\/drive\/(u\/\d+\/)?folders\/[A-Za-z0-9_-]{20,}(\?[A-Za-z0-9_=&%.-]*)?$/;
var MGR_FORM_URL_RE = /^https:\/\/(script\.google\.com|docs\.google\.com|forms\.gle)\/\S*$/;
var MGR_STAFF_KINDS = [['staff', 'צוות חנות', 'סטטוס פעיל, חנות בלבד'], ['instructor', 'מנחה', 'סטטוס פעיל, חוגים בלבד'],
  ['both', 'חנות + הנחיה', 'סטטוס פעיל, חנות + חוגים — משמרות בחנות וגם קבוצות בחוגים'], ['trainee', 'מתלמד', 'סטטוס מתלמד — משבצים אותו בשורות ההתלמדות']];
var MGR_STAFF_NO_ANSWER = 'לא התקבלה תשובה מהשרת. ייתכן שנשמר — הרשימה נטענת מחדש, לבדוק לפני שמנסים שוב.';
// the same note once the reload after it came back (the list on screen is the truth now), or did not
var MGR_STAFF_RELOADED = 'לא התקבלה תשובה מהשרת. ייתכן שנשמר — הרשימה נטענה מחדש: לבדוק בה לפני שמנסים שוב.';
var MGR_STAFF_NOT_RELOADED = 'לא התקבלה תשובה מהשרת. ייתכן שנשמר — גם הרשימה לא נטענה: ↻ ולבדוק לפני שמנסים שוב.';
var MGR_DRIVE_PH = 'https://drive.google.com/drive/folders/…';   // the paste field's hint (in the field, left to right — never in a Hebrew line)
var MGR_STAFF_SRC = { onboarding: 'טופסי 101 לא נקראו', dnd: 'קובץ החוגים לא נקרא', feed: 'סיכום התלושים לא נקרא' };
var MGR_STAFF_JOINS = [['club', 'מועדון'], ['companion', 'MTG Companion'], ['dmApp', 'אפ׳ מנחים'], ['guild', 'שולחן עגול']];
var MGR_STAFF_WA = 'שלום, זה הקישור לטופס הקליטה של פריק (טופס 101 והסכם עבודה): ';
var MGR_STAFF_ICON = { f101New: '📄', f101Link: '🔗', dndNoStaff: '🎲', statusMismatch: '⚠️', noFolder: '📁', no101: '📄', police: '🚓' };   // leads each line of "לטיפול"

/** Login / logout: the cards, the sheet and the fold belong to the previous user. The fold is closed, so the next open asks again. */
function mgrStaffReset() {
  mgrStaff = null; mgrStaffState = ''; mgrStaffErr = ''; mgrStaffWriteErr = ''; mgrStaffSeq++; mgrStaffLoaded = false; mgrStaffBusy = '';
  mgrStaffFilter = 'all'; mgrStaffIds = null; mgrStaffCtx = null; mgrStaffKind = 'staff';
  var det = document.getElementById('mgrDetStaff');
  if (det) det.open = false;
  renderMgrStaff();
  renderMgrStaffSheet();   // the sheet is position:fixed — emptying it is not enough, it must be hidden
}

/** The fold asks for the cards on its first open after a login (details.ontoggle); later opens show what is in memory. */
function mgrStaffHook() {
  var det = document.getElementById('mgrDetStaff');
  if (!det) return;
  det.ontoggle = function () { if (det.open && !mgrStaffLoaded) loadMgrStaff(); };
}

function loadMgrStaff() {
  if (mgrStaffBusy) return;   // a write is on its way: its answer brings the cards (or asks for them)
  var gen = loginGen, seq = ++mgrStaffSeq;
  mgrStaffLoaded = true; mgrStaffState = 'loading';
  renderMgrStaff();
  api('mgrStaffCards', {}, { ms: 45000 }).then(function (r) {
    if (gen !== loginGen || seq !== mgrStaffSeq) return;   // logged out meanwhile (shared phone), or a newer answer is coming
    if (r && r.success && Array.isArray(r.people)) {
      mgrStaff = r; mgrStaffState = ''; mgrStaffErr = '';
      if (mgrStaffWriteErr === MGR_STAFF_NO_ANSWER) mgrStaffWriteErr = MGR_STAFF_RELOADED;   // the reload after a write with no answer is done
    } else if (r && r.transport && mgrStaff) {   // no answer: what is on screen stays, and says so
      mgrStaffState = 'error'; mgrStaffErr = 'לא התקבלה תשובה מהשרת — מוצג מה שנטען קודם. ↻ לנסות שוב.';
    } else {   // the server said no (or no answer and nothing to show): nothing of an older answer stays on screen
      mgrStaff = null; mgrStaffState = 'error';
      mgrStaffErr = r && r.transport ? 'כשל בתקשורת מול השרת — ↻ לנסות שוב.' : 'שגיאה: ' + String(r && r.error ? r.error : 'תשובה לא תקינה מהשרת');
    }
    if (mgrStaffWriteErr === MGR_STAFF_NO_ANSWER && mgrStaffState === 'error') mgrStaffWriteErr = MGR_STAFF_NOT_RELOADED;   // nor did its reload
    renderMgrStaff();
    renderMgrStaffSheet();
  });
}

/* ---- small helpers ---- */
function mgrStaffPeople() { return mgrStaff && Array.isArray(mgrStaff.people) ? mgrStaff.people.filter(function (p) { return p && typeof p === 'object'; }) : []; }
function mgrStaffPerson(id) { var hit = null; mgrStaffPeople().forEach(function (p) { if (!hit && p.id === id) hit = p; }); return hit; }
function mgrStaffTodo() { return mgrStaff && Array.isArray(mgrStaff.todo) ? mgrStaff.todo.filter(function (t) { return t && typeof t === 'object'; }) : []; }
function mgrStaffTodoOf(key, kind) { var hit = null; mgrStaffTodo().forEach(function (t) { if (!hit && t.key === key && (!kind || t.kind === kind)) hit = t; }); return hit; }
function mgrStaffSources() { return mgrStaff && Array.isArray(mgrStaff.sources) ? mgrStaff.sources.filter(function (s) { return s && typeof s === 'object'; }) : []; }
/** false when the server says this source could not be read: its part of every card is not known (never "missing"). */
function mgrStaffSrcOk(key) { return !mgrStaffSources().some(function (s) { return s.key === key && s.ok === false; }); }
function mgrStaffAllRead() { return !mgrStaffSources().some(function (s) { return s.ok === false; }); }
function mgrStaffLeft(p) { return String(p.status || '') === 'עזב'; }
function mgrStaffStore(p) { return /חנות/.test(String(p.group || '') + ' ' + String(p.role || '')); }
function mgrStaffDnd(p) { return !!p.dnd || /חוגים/.test(String(p.group || '')); }
function mgrStaffOpenN(p) { var n = Number(p.open); return isFinite(n) && n > 0 ? n : 0; }
/** The server's "a 101 form of this person was found" (no folder linked yet, so the form's details are not on the card): {folderRef, why, date} or null. */
function mgrStaffSug(id) {
  var all = mgrStaff && mgrStaff.suggest && typeof mgrStaff.suggest === 'object' ? mgrStaff.suggest : null;
  var s = all && Object.prototype.hasOwnProperty.call(all, id) ? all[id] : null;
  return s && typeof s === 'object' && s.folderRef ? s : null;
}
/** The first new-101-form line the server hints to this person ("💡 אולי זה …", by name / email / phone), or null (fix round 2, N5). */
function mgrStaffF101HintOf(id) {
  var hit = null;
  mgrStaffTodo().forEach(function (t) { if (!hit && t.kind === 'f101New' && t.suggestEmp && t.suggestEmp === id) hit = t; });
  return hit;
}
/** "🔗 קשר לשם מהחוגים" only where it can be right: an instructor's card, or a card the server hints a free chugim name to. */
function mgrStaffMayDnd(p) {
  if (/מנחה|חוגים|הדרכה/.test(String(p.role || '') + ' ' + String(p.group || ''))) return true;
  return mgrStaffTodo().some(function (t) { return t.kind === 'dndNoStaff' && t.suggestEmp === p.id; });
}
/** "2026-09" -> "09/26" ('' for anything else). */
function mgrStaffMonth(ym) { var m = /^(\d{4})-(\d{2})$/.exec(String(ym == null ? '' : ym)); return m ? m[2] + '/' + m[1].slice(2) : ''; }
function mgrStaffNum(n) { var v = Number(n); return isFinite(v) ? String(Math.round(v * 100) / 100) : '0'; }
/** A server line, escaped, with its times and dates kept left-to-right inside the Hebrew line. */
function mgrStaffBidi(s) { return esc(s).replace(/\d{1,2}:\d{2}(?:[-–]\d{1,2}:\d{2})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/g, '<bdi>$&</bdi>'); }

/** A write button: its own class (tests find it), disabled while any write runs, the hourglass while ITS write runs. */
function mgrStaffBtn(cls, text, tag, fn) {
  var b = mgrEl('button', cls); b.type = 'button';
  b.disabled = !!mgrStaffBusy;
  b.textContent = tag && mgrStaffBusy === tag ? MGR_BUSY : text;
  b.onclick = function () { if (mgrStaffBusy) return; fn(); };
  return b;
}

/** "📲 שלח קישור לטופס 101": WhatsApp with the form's address and no number (the manager picks the chat). null without a form address. */
function mgrStaffWaEl() {
  var u = String(mgrStaff && mgrStaff.form101Url ? mgrStaff.form101Url : '');
  if (!MGR_FORM_URL_RE.test(u)) return null;
  var a = mgrEl('a', 'btn btn-secondary btn-sm mgr-staff-a mgr-staff-wa');
  a.href = 'https://wa.me/?text=' + encodeURIComponent(MGR_STAFF_WA + u);
  a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.textContent = '📲 שלח קישור לטופס 101';
  return a;
}

/* ---- the fold ---- */
function renderMgrStaff() {
  var box = document.getElementById('mgrStaff');
  if (!box) return;
  box.innerHTML = '';
  var d = mgrStaff, loading = mgrStaffState === 'loading';
  var top = mgrEl('div', 'mgr-staff-top');
  top.appendChild(mgrEl('span', 'mgr-legend mgr-staff-asof', d && d.asOf ? 'נכון ל-<bdi>' + esc(d.asOf) + '</bdi>' : (loading ? 'טוען את כרטיסי הצוות…' : '')));
  var rl = mgrEl('button', 'btn btn-sm btn-secondary mgr-staff-reload'); rl.type = 'button';
  rl.textContent = loading ? MGR_BUSY : '↻';
  rl.setAttribute('aria-label', 'טען שוב את כרטיסי הצוות');
  rl.disabled = loading || !!mgrStaffBusy;
  rl.onclick = function () { if (mgrStaffState === 'loading' || mgrStaffBusy) return; loadMgrStaff(); };
  top.appendChild(rl);
  box.appendChild(top);
  if (mgrStaffErr) box.appendChild(mgrEl('div', 'mgr-note mgr-staff-err', '⚠️ ' + esc(mgrStaffErr)));
  if (mgrStaffWriteErr) box.appendChild(mgrEl('div', 'mgr-note mgr-staff-werr', '⚠️ ' + esc(mgrStaffWriteErr)));
  if (!d) {
    if (loading) for (var i = 0; i < 4; i++) box.appendChild(mgrEl('div', 'mgr-skel mgr-staff-skel'));
    return;
  }
  // rule 8ז: a source that could not be read is said, its part of every card is "not known"
  mgrStaffSources().forEach(function (s) {
    var key = String(s.key || '');
    if (s.ok === false) box.appendChild(mgrEl('div', 'mgr-note mgr-staff-src', '⚠️ ' + esc(mgrFold(s.text) || (Object.prototype.hasOwnProperty.call(MGR_STAFF_SRC, key) ? MGR_STAFF_SRC[key] : 'מקור לא נקרא: ' + key)) + ' — החלק הזה בכרטיסים לא ידוע.'));
    else if (s.warn === true && mgrFold(s.text)) box.appendChild(mgrEl('div', 'mgr-note mgr-staff-srcwarn', '⚠️ ' + esc(s.text)));   // read, but old: the data is shown
    else if (mgrFold(s.text)) box.appendChild(mgrEl('div', 'mgr-legend mgr-staff-srcinfo', 'ℹ️ ' + esc(s.text)));
  });

  var todo = mgrStaffTodo();
  box.appendChild(mgrEl('div', 'mgr-sub mgr-staff-todo-h', '📋 לטיפול (' + todo.length + ')'));
  if (!todo.length) box.appendChild(mgrEl('div', 'mgr-line mgr-none mgr-staff-none', mgrStaffAllRead() ? 'אין מה לטפל ✓' : 'אין מה לטפל ממה שנקרא — חלק מהמקורות לא נקראו (למעלה).'));
  todo.forEach(function (t) { box.appendChild(mgrStaffTodoEl(t)); });

  var people = mgrStaffPeople();
  if (mgrStaffIds) {   // a fresh answer: the narrowed list follows its line, or goes when the line is gone
    var tt = mgrStaffTodoOf(mgrStaffIds.key);
    mgrStaffIds = tt && Array.isArray(tt.empIds) ? { key: tt.key, text: String(tt.text || ''), ids: tt.empIds, scroll: !!mgrStaffIds.scroll } : null;
  }
  var nLeft = people.filter(mgrStaffLeft).length;
  if (mgrStaffFilter === 'left' && !nLeft) mgrStaffFilter = 'all';
  box.appendChild(mgrStaffChipsEl(people, nLeft));
  if (mgrStaffIds) {
    var fl = mgrEl('div', 'mgr-staff-idsf', '<span>🔎 ' + mgrStaffBidi(mgrStaffIds.text) + '</span>');
    var fx = mgrEl('button', 'btn btn-sm btn-secondary mgr-staff-idsx'); fx.type = 'button'; fx.textContent = '✕ הצג הכל';
    fx.onclick = function () { mgrStaffIds = null; renderMgrStaff(); };
    fl.appendChild(fx);
    box.appendChild(fl);
  }
  var shown = mgrStaffShown(people);
  var lh = mgrEl('div', 'mgr-sub mgr-staff-list-h', '👥 הצוות (' + shown.length + ')');
  box.appendChild(lh);
  var c = d.counts && typeof d.counts === 'object' ? d.counts : null;
  box.appendChild(mgrEl('div', 'mgr-legend mgr-staff-key', (c && typeof c.active === 'number' ? c.active + ' פעילים · ' : '') + '📄 טופס 101 · 📁 תיקייה בדרייב · 🎲 קבוצות פעילות בחוגים · 💰 התלוש האחרון · ⚠️ לטיפול'));
  if (!shown.length) box.appendChild(mgrEl('div', 'mgr-line mgr-none mgr-staff-empty', 'אין אף אחד בסינון הזה'));
  shown.forEach(function (p) { box.appendChild(mgrStaffRowEl(p)); });
  if (mgrStaffIds && mgrStaffIds.scroll) { mgrStaffIds.scroll = false; try { lh.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {} }
}

/** Who is in the list now: a line of "לטיפול" narrows it to its people; otherwise the chip (those who left only under "עזבו"). */
function mgrStaffShown(people) {
  if (mgrStaffIds) return people.filter(function (p) { return mgrStaffIds.ids.indexOf(p.id) !== -1; });
  var f = mgrStaffFilter;
  if (f === 'left') return people.filter(mgrStaffLeft);
  return people.filter(function (p) {
    if (mgrStaffLeft(p)) return false;
    return f === 'open' ? mgrStaffOpenN(p) > 0 : f === 'store' ? mgrStaffStore(p) : f === 'dnd' ? mgrStaffDnd(p) : true;
  });
}

function mgrStaffChipsEl(people, nLeft) {
  var row = mgrEl('div', 'mgr-days mgr-staff-chips');
  var cur = people.filter(function (p) { return !mgrStaffLeft(p); });
  var defs = [['all', 'הכל', cur.length], ['open', 'פתוח', cur.filter(function (p) { return mgrStaffOpenN(p) > 0; }).length],
              ['store', 'חנות', cur.filter(mgrStaffStore).length], ['dnd', 'מנחים', cur.filter(mgrStaffDnd).length]];
  if (nLeft) defs.push(['left', 'עזבו', nLeft]);
  defs.forEach(function (f) {
    var on = !mgrStaffIds && mgrStaffFilter === f[0];
    var b = mgrEl('button', 'mgr-chip mgr-staff-chip mgr-staff-f-' + f[0] + (on ? ' on' : '')); b.type = 'button';
    b.textContent = f[1] + ' (' + f[2] + ')';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.onclick = function () { mgrStaffFilter = f[0]; mgrStaffIds = null; renderMgrStaff(); };
    row.appendChild(b);
  });
  return row;
}

function mgrStaffBadges(p) {
  var out = [];
  var add = function (cls, html) { out.push('<em class="mgr-staff-b ' + cls + '">' + html + '</em>'); };
  if (!mgrStaffSrcOk('onboarding')) add('unk', '📄 101 ?');
  else if (!p.f101 && mgrStaffSug(p.id)) add('info', '📄 101 💡');   // found, its details come with the folder link (never "✗ missing")
  else add(p.f101 ? 'ok' : 'no', '📄 101 ' + (p.f101 ? '✓' : '✗'));
  var linked = !!(p.folder && p.folder.linked);
  add(linked ? 'ok' : 'no', '📁 ' + (linked ? '✓' : '✗'));
  if (p.dnd) add('info', '🎲 ' + (Array.isArray(p.dnd.groups) ? p.dnd.groups.length : 0));
  var m = p.pay ? mgrStaffMonth(p.pay.lastPayslip) : '';
  if (m) add('info', '💰 <bdi>' + m + '</bdi>');
  var n = mgrStaffOpenN(p);
  if (n) add('warn', '⚠️ ' + n);
  return out.join('');
}

function mgrStaffRowEl(p) {
  var st = String(p.status || '');
  var b = mgrEl('button', 'mgr-cand mgr-staff-row' + (mgrStaffOpenN(p) ? ' warn' : '') + (mgrStaffLeft(p) ? ' dim' : '')); b.type = 'button';
  b.innerHTML = '<div class="mgr-staff-rowh"><b>' + esc(p.name) + '</b>' + (st && st !== 'פעיל' ? ' <em class="mgr-staff-st">' + esc(st) + '</em>' : '') + '</div>' +
    '<div class="mgr-staff-badges">' + mgrStaffBadges(p) + '</div>';
  b.onclick = function () { mgrStaffOpen({ mode: 'person', id: p.id }); };
  return b;
}

/** One line of "לטיפול" with what can be done about it (the server says what; the phone never decides who is who). */
function mgrStaffTodoEl(t) {
  var kind = String(t.kind || ''), key = String(t.key || '');
  if (kind === 'noFolder' || kind === 'no101' || kind === 'police') {   // a count: a tap narrows the list to its people
    var w = mgrEl('div', 'mgr-staff-todo mgr-staff-todo-agg');
    var on = !!mgrStaffIds && mgrStaffIds.key === key;
    var b = mgrEl('button', 'mgr-cand mgr-staff-agg' + (on ? ' on' : ''), '<div class="mgr-staff-aggt">' + MGR_STAFF_ICON[kind] + ' ' + mgrStaffBidi(t.text) + '</div><b>' + (on ? '✕' : '‹') + '</b>'); b.type = 'button';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.onclick = function () {
      mgrStaffIds = on ? null : { key: key, text: String(t.text || ''), ids: Array.isArray(t.empIds) ? t.empIds : [], scroll: true };
      renderMgrStaff();
    };
    w.appendChild(b);
    if (kind === 'no101') { var wa = mgrStaffWaEl(); if (wa) w.appendChild(wa); }
    return w;
  }
  var icon = Object.prototype.hasOwnProperty.call(MGR_STAFF_ICON, kind) ? MGR_STAFF_ICON[kind] + ' ' : '';
  var line = mgrEl('div', 'mgr-staff-todo' + (kind === 'statusMismatch' ? ' mgr-staff-info' : ''), '<span class="mgr-staff-todo-t">' + icon + mgrStaffBidi(t.text) + '</span>');
  var acts = mgrEl('div', 'mgr-acts');
  if (kind === 'f101New') {
    // the server thinks the form may be of someone already on the staff: linking it to that row comes first, a new row second
    var fp = t.suggestEmp ? mgrStaffPerson(t.suggestEmp) : null;
    if (fp) {
      line.appendChild(mgrEl('span', 'mgr-staff-hint', '💡 אולי זה ' + esc(fp.name) + (t.suggestWhy ? ' (לפי ' + esc(t.suggestWhy) + ')' : '')));
      acts.appendChild(mgrStaffF101IsBtn(t, fp));
    }
    acts.appendChild(mgrStaffBtn('btn btn-sm mgr-staff-add' + (fp ? ' btn-secondary' : ''), '+ הוסף לצוות', '', function () {
      var hint = String(t.kindHint || '');
      mgrStaffKind = MGR_STAFF_KINDS.some(function (k) { return k[0] === hint; }) ? hint : 'staff';
      mgrStaffOpen({ mode: 'add', key: key });
    }));
  } else if (kind === 'f101Link') {
    acts.appendChild(mgrStaffBtn('btn btn-sm mgr-staff-link', '🔗 קשר', 'link:' + key, function () {
      var p = mgrStaffPerson(t.empId), nm = p ? String(p.name || '') : String(t.name || '');
      openAppModal('🔗 קישור תיקייה מטופס 101', nm + ': לקשר את התיקייה מטופס 101 שנמצא?\nהקישור נכתב בעמודת התיקייה בטאב עובדים — רק לתא ריק; שינוי רק בגיליון.', false, 'קשר', function () {
        mgrStaffRun('link:' + key, 'mgrStaffLinkFolder', { empId: String(t.empId || ''), name: nm, ref: String(t.ref || '') }, 'התיקייה קושרה ✓');
      });
    }));
  } else if (kind === 'dndNoStaff') {
    var sp = t.suggestEmp ? mgrStaffPerson(t.suggestEmp) : null;
    if (sp) line.appendChild(mgrEl('span', 'mgr-staff-hint', '💡 אולי ' + esc(sp.name) + (t.suggestWhy ? ' (לפי ' + esc(t.suggestWhy) + ')' : '')));
    acts.appendChild(mgrStaffBtn('btn btn-sm mgr-staff-alias', '🔗 זה עובד קיים', '', function () { mgrStaffOpen({ mode: 'alias', key: key }); }));
    acts.appendChild(mgrStaffBtn('btn btn-sm btn-secondary mgr-staff-addi', '+ הוסף כמנחה', 'addi:' + key, function () {
      var dn = String(t.dndName || '');
      openAppModal('+ מנחה חדש', 'להוסיף את ' + dn + ' לטאב עובדים כמנחה (סטטוס פעיל, חוגים בלבד)?\nשום שורה קיימת לא משתנה. הקישור האישי — אחר כך מהגיליון.', false, 'הוסף', function () {
        mgrStaffRun('addi:' + key, 'mgrAddPerson', { name: dn, kind: 'instructor' }, 'נוסף לצוות: ' + dn);
      });
    }));
  }
  if (acts.children.length) line.appendChild(acts);   // statusMismatch: a fact to fix in the chugim system, no button here
  return line;
}

/**
 * "🔗 זה <name>": a new 101 form is of someone already on the staff — its folder goes on that row, no new row (the server checks
 * again). label: the person's own card says "🔗 זה הוא" (the same write; the to-do line, the add sheet and the card share its ⏳).
 */
function mgrStaffF101IsBtn(t, fp, label) {
  var key = String(t.key || '');
  return mgrStaffBtn('btn btn-sm ' + (label ? 'mgr-staff-f101card' : 'mgr-staff-f101is'), label || '🔗 זה ' + String(fp.name || ''), 'f101is:' + key, function () {
    openAppModal('🔗 טופס 101 של עובד קיים', 'הטופס של ' + String(t.name || '') + ' — זה ' + String(fp.name || '') + ' שכבר בצוות?\nהתיקייה מהטופס תחובר לכרטיס שלו, ולא תתווסף שורה חדשה. אם כבר מקושרת לו תיקייה — היא לא תשתנה (שינוי רק בגיליון).', false, 'קשר', function () {
      mgrStaffRun('f101is:' + key, 'mgrStaffLinkFolder', { empId: String(fp.id || ''), name: String(fp.name || ''), ref: String(t.ref || '') }, 'התיקייה קושרה ✓');
    });
  });
}

/* ---- the sheet (a bottom sheet over the tab) ---- */
function mgrStaffOpen(ctx) {
  mgrStaffCtx = ctx; mgrStaffWriteErr = '';
  renderMgrStaffSheet();
  renderMgrStaff();
}

function closeMgrStaffSheet() {
  mgrStaffCtx = null; mgrStaffWriteErr = '';
  renderMgrStaffSheet();
  renderMgrStaff();
}

function renderMgrStaffSheet() {
  var box = document.getElementById('mgrStaffSheet');
  if (!box) return;
  box.innerHTML = '';
  var ctx = mgrStaffCtx, p = null, t = null;
  if (ctx && mgrStaff) {
    if (ctx.mode === 'person' || ctx.mode === 'dnd') p = mgrStaffPerson(ctx.id);
    else if (ctx.mode === 'add') t = mgrStaffTodoOf(ctx.key, 'f101New');
    else if (ctx.mode === 'alias') t = mgrStaffTodoOf(ctx.key, 'dndNoStaff');
  }
  if (!p && !t) { mgrStaffCtx = null; box.style.display = 'none'; return; }   // gone from a fresh answer, or logged out: the sheet closes
  if (ctx !== mgrStaffSheetCtx) mgrStaffSheetScroll = 0;   // a sheet that is not the one drawn last starts at its top
  mgrStaffSheetCtx = ctx;
  box.style.display = 'flex';
  box.onclick = function (e) { if (e && e.target === box) closeMgrStaffSheet(); };   // a tap outside the sheet closes it
  var sheet = mgrEl('div', 'mgr-sheet mgr-staffsheet');
  sheet.onscroll = function () { mgrStaffSheetScroll = sheet.scrollTop; };
  var title = ctx.mode === 'person' ? '👤 ' + esc(p.name) : ctx.mode === 'dnd' ? '🔗 ' + esc(p.name) + ' — איזה שם בחוגים?' :
    ctx.mode === 'add' ? '+ הוסף לצוות: ' + esc(t.name) : '🔗 ' + esc(t.dndName) + ' — מי זה בצוות?';
  var head = mgrEl('div', 'mgr-sheet-h', '<b>' + title + '</b>');
  var xb = mgrEl('button', 'mgr-x mgr-staff-x'); xb.type = 'button'; xb.textContent = '✕'; xb.setAttribute('aria-label', 'סגור');
  xb.onclick = closeMgrStaffSheet;
  head.appendChild(xb);
  sheet.appendChild(head);
  if (mgrStaffWriteErr) sheet.appendChild(mgrEl('div', 'mgr-note mgr-staff-serr', '⚠️ ' + esc(mgrStaffWriteErr)));
  if (ctx.mode === 'person') mgrStaffPersonEl(sheet, p);
  else if (ctx.mode === 'dnd') mgrStaffDndPickEl(sheet, p);
  else if (ctx.mode === 'add') mgrStaffAddEl(sheet, t);
  else mgrStaffAliasEl(sheet, t);
  box.appendChild(sheet);
  sheet.scrollTop = mgrStaffSheetScroll;   // a redraw (a write on its way, its answer, a chip) keeps the place: the ⏳ stays in view
}

function mgrStaffSec(sheet, title, cls) {
  var s = mgrEl('div', 'mgr-staff-sec ' + cls);
  s.appendChild(mgrEl('div', 'mgr-sub', title));
  sheet.appendChild(s);
  return s;
}

/** A fact of the card: ok true → ✓ (green), false → ✗ (red); html is already escaped. */
function mgrStaffFact(sec, ok, html, cls) {
  sec.appendChild(mgrEl('div', 'mgr-staff-fact ' + (ok ? 'ok' : 'no') + (cls ? ' ' + cls : ''), (ok ? '✓ ' : '✗ ') + html));
}

function mgrStaffPersonEl(sheet, p) {
  var st = String(p.status || '');
  sheet.appendChild(mgrEl('div', 'mgr-legend mgr-staff-meta', [p.id, p.role, p.group].filter(function (x) { return mgrFold(x); }).map(esc).join(' · ') +
    (st && st !== 'פעיל' ? ' <em class="mgr-staff-st">' + esc(st) + '</em>' : '')));

  // 📄 the 101 form
  var s1 = mgrStaffSec(sheet, '📄 טופס 101', 'mgr-staff-s101');
  var f = p.f101, sg1 = mgrStaffSug(p.id);
  var iss = (Array.isArray(p.issues) ? p.issues : []).filter(function (x) { return x && typeof x === 'object'; });
  if (!mgrStaffSrcOk('onboarding')) s1.appendChild(mgrEl('div', 'mgr-legend mgr-staff-unk', 'לא ידוע — טופסי 101 לא נקראו.'));
  else if (!f || typeof f !== 'object') {
    // a form found for a row with no folder: its details come with the folder link (below) — never "✗ not found" beside "💡 found"
    var nt = sg1 ? null : mgrStaffF101HintOf(p.id);
    if (sg1) s1.appendChild(mgrEl('div', 'mgr-legend mgr-staff-f101-sug', '💡 נמצא טופס 101 שלו — הפרטים יופיעו אחרי קישור התיקייה'));
    else if (nt) {
      // fix round 2 (N5): a NEW form the to-do list hints to this person ("💡 אולי זה …") — said here too, with the same link
      s1.appendChild(mgrEl('div', 'mgr-legend mgr-staff-f101-maybe', '💡 ייתכן שטופס 101 חדש שייך לו: ' + esc(nt.name)));
      s1.appendChild(mgrStaffF101IsBtn(nt, p, '🔗 זה הוא'));
    }
    else mgrStaffFact(s1, false, 'לא נמצא טופס 101 במערכת', 'mgr-staff-f101-none');
  } else {
    mgrStaffFact(s1, true, 'הוגש ב-<bdi>' + esc(f.date) + '</bdi>' + (f.old ? ' <em class="mgr-staff-st">בטופס הישן</em>' : ''), 'mgr-staff-f101-date');
    mgrStaffFact(s1, !!f.contract, f.contract ? 'הסכם עבודה חתום' : 'אין הסכם עבודה חתום', 'mgr-staff-contract');
    if (f.withMinors) {
      // the power of attorney is a fact of the form; what the police status means is the server's to say (its issue, in the list below)
      mgrStaffFact(s1, !!f.police, 'עובד/ת עם קטינים — ייפוי כוח למשטרה ' + (f.police ? 'נחתם' : 'לא נחתם'), 'mgr-staff-police');
      var ps = mgrFold(f.policeStatus), pi = iss.some(function (x) { return x.code === 'police'; });
      if (!pi && ps && ps !== '-') s1.appendChild(mgrEl('div', 'mgr-legend mgr-staff-policest', 'אישור משטרה: ' + esc(ps)));   // e.g. "התקבל"
    }
    if (f.minor) mgrStaffFact(s1, !!f.minorAnnex, 'קטין/ה — נספח קטין ' + (f.minorAnnex ? 'חתום' : 'חסר'), 'mgr-staff-minor');
    if (mgrFold(f.start)) s1.appendChild(mgrEl('div', 'mgr-legend mgr-staff-start', 'תחילת עבודה: <bdi>' + esc(f.start) + '</bdi>'));
    if (mgrFold(f.team)) s1.appendChild(mgrEl('div', 'mgr-legend mgr-staff-team', 'צוות בטופס: ' + esc(f.team)));
    var j = f.joins && typeof f.joins === 'object' ? f.joins : {};
    var chips = MGR_STAFF_JOINS.filter(function (x) { return typeof j[x[0]] === 'boolean'; }).map(function (x) {
      return '<em class="mgr-staff-j' + (j[x[0]] ? ' on' : '') + '">' + (j[x[0]] ? '✓ ' : '✗ ') + esc(x[1]) + '</em>';
    });
    if (chips.length) s1.appendChild(mgrEl('div', 'mgr-legend mgr-staff-joins', 'הצטרפות: ' + chips.join('')));
  }

  // 📁 the folder
  var s2 = mgrStaffSec(sheet, '📁 תיקייה', 'mgr-staff-sfolder');
  var fo = p.folder && typeof p.folder === 'object' ? p.folder : {};
  var url = String(fo.url == null ? '' : fo.url);
  if (fo.linked) {
    mgrStaffFact(s2, true, 'מקושרת תיקייה אישית בדרייב', 'mgr-staff-linked');
    if (MGR_DRIVE_OPEN_RE.test(url)) {   // never an href that is not a Drive folder
      var a = mgrEl('a', 'btn btn-secondary mgr-staff-a mgr-staff-open');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = '📁 פתח את התיקייה';
      s2.appendChild(a);
    }
  } else {
    mgrStaffFact(s2, false, 'אין תיקייה מקושרת', 'mgr-staff-nofolder');
    var sg = sg1;
    if (sg && sg.folderRef) {
      s2.appendChild(mgrEl('div', 'mgr-legend mgr-staff-sugwhy', '💡 נמצא טופס 101 שלו' + (sg.why ? ' (לפי ' + esc(sg.why) + (sg.date ? ', <bdi>' + esc(sg.date) + '</bdi>' : '') + ')' : '')));
      s2.appendChild(mgrStaffBtn('btn mgr-staff-sug', '🔗 קשר את התיקייה מטופס 101', 'sug:' + p.id, function () {
        openAppModal('🔗 קישור תיקייה מטופס 101', p.name + ': לקשר את התיקייה מטופס 101 שנמצא' + (sg.why ? ' (לפי ' + sg.why + ')' : '') + '?\nהקישור נכתב בעמודת התיקייה בטאב עובדים — רק לתא ריק.', false, 'קשר', function () {
          mgrStaffRun('sug:' + p.id, 'mgrStaffLinkFolder', { empId: p.id, name: String(p.name || ''), ref: String(sg.folderRef) }, 'התיקייה קושרה ✓');
        });
      }));
    }
    s2.appendChild(mgrStaffBtn('btn btn-secondary mgr-staff-paste', '📋 הדבק קישור לתיקייה', 'paste:' + p.id, function () { mgrStaffPasteAsk(p); }));
  }

  // 🎲 the chugim
  var s3 = mgrStaffSec(sheet, '🎲 חוגים', 'mgr-staff-sdnd');
  var dn = p.dnd;
  if (!mgrStaffSrcOk('dnd')) s3.appendChild(mgrEl('div', 'mgr-legend mgr-staff-unk', 'לא ידוע — קובץ החוגים לא נקרא.'));
  else if (!dn || typeof dn !== 'object') {
    s3.appendChild(mgrEl('div', 'mgr-legend mgr-staff-nodnd', 'לא מופיע/ה ברשימת המנחים בחוגים.'));
    if (mgrStaffFreeDnd().length && mgrStaffMayDnd(p)) s3.appendChild(mgrStaffBtn('btn btn-secondary mgr-staff-dndlink', '🔗 קשר לשם מהחוגים', '', function () { mgrStaffOpen({ mode: 'dnd', id: p.id }); }));
  } else {
    s3.appendChild(mgrEl('div', 'mgr-staff-fact mgr-staff-dndname', '<b>' + esc(dn.name) + '</b>' + (dn.how === 'alias' ? ' <em class="mgr-staff-st">שם חלופי</em>' : '') +
      ' · ' + (dn.active ? 'פעיל/ה בחוגים' : 'לא פעיל/ה בחוגים')));
    var groups = Array.isArray(dn.groups) ? dn.groups : [], forming = Array.isArray(dn.forming) ? dn.forming : [];
    s3.appendChild(mgrEl('div', 'mgr-legend', groups.length ? 'קבוצות פעילות (' + groups.length + '):' : 'אין קבוצות פעילות'));
    groups.forEach(function (g) { s3.appendChild(mgrEl('div', 'mgr-staff-grp', mgrStaffBidi(g))); });
    if (forming.length) {
      s3.appendChild(mgrEl('div', 'mgr-legend', 'בהקמה (' + forming.length + '):'));
      forming.forEach(function (g) { s3.appendChild(mgrEl('div', 'mgr-staff-grp mgr-staff-forming', mgrStaffBidi(g))); });
    }
    s3.appendChild(mgrStaffHoursEl(dn.hours, dn.prev));
    [[dn.hours, 'החודש'], [dn.prev, 'בחודש הקודם']].forEach(function (x) {
      var n = x[0] && typeof x[0] === 'object' ? Number(x[0].toFix) || 0 : 0;
      if (n > 0) s3.appendChild(mgrEl('div', 'mgr-note mgr-staff-tofix', '⚠️ ' + (n === 1 ? 'רישום שעות אחד' : n + ' רישומי שעות') + ' לתיקון ' + x[1] + ' (יציאה שנשכחה) — בקובץ החוגים'));
    });
  }

  // 💰 payslips and hours reports (month-close's summary of the person's folder)
  var s4 = mgrStaffSec(sheet, '💰 תלושים ושעות', 'mgr-staff-spay');
  var pay = p.pay, asOf = mgrStaff ? mgrFold(mgrStaff.feedAsOf) : '';
  if (!mgrStaffSrcOk('feed')) s4.appendChild(mgrEl('div', 'mgr-legend mgr-staff-unk', 'לא ידוע — סיכום התלושים לא נקרא.'));
  else if (!pay || typeof pay !== 'object') {
    s4.appendChild(mgrEl('div', 'mgr-legend mgr-staff-nopay', !asOf ? 'סיכום התלושים עוד לא מחובר.' : (fo.linked ? 'אין עדיין תלושים או דוחות שעות בתיקייה.' : 'בלי תיקייה מקושרת אין סיכום תלושים.')));
  } else {
    var lp = mgrStaffMonth(pay.lastPayslip), lh = mgrStaffMonth(pay.lastHours);
    s4.appendChild(mgrEl('div', 'mgr-staff-fact mgr-staff-lastpay', lp ? 'תלוש אחרון: <bdi>' + lp + '</bdi>' : 'עוד אין תלוש בתיקייה'));
    s4.appendChild(mgrEl('div', 'mgr-staff-fact mgr-staff-lasthrs', lh ? 'דוח שעות אחרון: <bdi>' + lh + '</bdi>' : 'עוד אין דוח שעות בתיקייה'));
    s4.appendChild(mgrEl('div', 'mgr-legend mgr-staff-year', 'השנה: ' + mgrStaffNum(pay.payslipsInYear) + ' תלושים · ' + mgrStaffNum(pay.hoursInYear) + ' דוחות שעות' +
      (asOf ? ' · נכון ל-<bdi>' + esc(asOf) + '</bdi>' : '')));
  }

  // ⚠️ what to handle for this person: the warnings (counted, like the ⚠️ badge — the server's "open"), then what is only to know (muted ℹ️)
  var nWarn = iss.filter(function (x) { return x.level === 'warn'; }).length;
  var s5 = mgrStaffSec(sheet, '⚠️ לטיפול (' + nWarn + ')', 'mgr-staff-siss');
  if (!nWarn) s5.appendChild(mgrEl('div', 'mgr-line mgr-none mgr-staff-issnone', mgrStaffAllRead() ? 'אין מה לטפל ✓' : 'אין מה לטפל ממה שנקרא'));
  iss.filter(function (x) { return x.level === 'warn'; }).concat(iss.filter(function (x) { return x.level !== 'warn'; })).forEach(function (x) {
    s5.appendChild(mgrEl('div', 'mgr-line mgr-staff-iss' + (x.level === 'warn' ? ' soft' : ' mgr-staff-issinfo'), (x.level === 'warn' ? '⚠️ ' : 'ℹ️ ') + mgrStaffBidi(x.text)));
  });
  var wa = mgrStaffWaEl();
  if (wa) sheet.appendChild(wa);
}

/** This month and the month before, from the chugim hours log (2 decimals on the server). */
function mgrStaffHoursEl(h, prev) {
  var cur = h && typeof h === 'object' ? h : {}, pr = prev && typeof prev === 'object' ? prev : {};
  var m = mgrStaff ? mgrStaffMonth(mgrStaff.month) : '', pm = mgrStaff ? mgrStaffMonth(mgrStaff.prevMonth) : '';
  var rows = [['חוגים', 'chug'], ['אירועים', 'event'], ['אחר', 'other'], ['סה״כ שעות', 'total'], ['ימים', 'days']];
  var html = '<tr><th></th><th>החודש' + (m ? ' <bdi>' + m + '</bdi>' : '') + '</th><th>חודש קודם' + (pm ? ' <bdi>' + pm + '</bdi>' : '') + '</th></tr>' +
    rows.map(function (r) {
      var b = r[1] === 'total';
      return '<tr><td>' + (b ? '<b>' + r[0] + '</b>' : r[0]) + '</td><td>' + mgrStaffNum(cur[r[1]]) + '</td><td>' + mgrStaffNum(pr[r[1]]) + '</td></tr>';
    }).join('');
  return mgrEl('table', 'mgr-staff-hrs', html);
}

/** The chugim names that no staff row has (the server says who owns each). */
function mgrStaffFreeDnd() {
  var list = mgrStaff && Array.isArray(mgrStaff.dndInstructors) ? mgrStaff.dndInstructors : [];
  return list.filter(function (x) { return x && typeof x === 'object' && mgrFold(x.name) && !x.empId; })
    .sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'he'); });
}

/** "📋 הדבק קישור לתיקייה": the address is checked on the phone with the server's own rule, and again by the server. */
function mgrStaffPasteAsk(p) {
  // no address inside the Hebrew lines (a right-to-left line draws its last "/" in front of "https"); the field shows it, left to right
  openAppModal('📋 קישור לתיקייה', 'התיקייה של ' + p.name + ' בדרייב: להעתיק את הקישור של התיקייה מהדפדפן ולהדביק כאן.\nאם כבר מקושרת לו תיקייה — היא לא תשתנה (שינוי רק בגיליון).', true, 'קשר', function (v) {
    var url = String(v == null ? '' : v).trim();
    if (!MGR_DRIVE_FOLDER_RE.test(url)) {
      mgrStaffWriteErr = 'זה לא קישור לתיקייה בדרייב (אולי לקובץ?) — לפתוח את התיקייה בדרייב, להעתיק את הקישור שלה מהדפדפן ולהדביק כאן.';
      mgrStaffSheetScroll = 0;   // the line that says why is at the top of the sheet
      showToast(mgrStaffWriteErr, 'error');
      renderMgrStaffSheet(); renderMgrStaff();
      return;
    }
    mgrStaffRun('paste:' + p.id, 'mgrStaffLinkFolder', { empId: p.id, name: String(p.name || ''), url: url }, 'התיקייה קושרה ✓');
  });
  var inp = document.getElementById('modalInput');   // an address: left to right, a hint of its shape, the keyboard for addresses (the next modal resets them)
  if (inp) { inp.dir = 'ltr'; inp.placeholder = MGR_DRIVE_PH; inp.inputMode = 'url'; }
}

/** "+ הוסף לצוות" from a new 101 form: the name, what the person is (the form's team preselected), one tap. */
function mgrStaffAddEl(sheet, t) {
  sheet.appendChild(mgrEl('div', 'mgr-legend mgr-staff-addline', mgrStaffBidi(t.text)));
  sheet.appendChild(mgrEl('div', 'mgr-sub', 'מה התפקיד?'));
  var kinds = mgrEl('div', 'mgr-staff-kinds');
  var desc = '';
  MGR_STAFF_KINDS.forEach(function (k) {
    var on = mgrStaffKind === k[0];
    if (on) desc = k[2];
    var c = mgrEl('button', 'mgr-chip mgr-staff-kind mgr-staff-kind-' + k[0] + (on ? ' on' : '')); c.type = 'button'; c.textContent = k[1];
    c.setAttribute('aria-pressed', on ? 'true' : 'false');
    c.onclick = function () { mgrStaffKind = k[0]; renderMgrStaffSheet(); };
    kinds.appendChild(c);
  });
  sheet.appendChild(kinds);
  if (desc) sheet.appendChild(mgrEl('div', 'mgr-legend mgr-staff-kinddesc', esc(desc)));
  var fp = t.suggestEmp ? mgrStaffPerson(t.suggestEmp) : null;   // the server thinks the form may be of someone already on the staff
  if (fp) {
    sheet.appendChild(mgrEl('div', 'mgr-note mgr-staff-addwarn', '💡 ייתכן שזה ' + esc(fp.name) + ' שכבר בצוות' + (t.suggestWhy ? ' (לפי ' + esc(t.suggestWhy) + ')' : '') +
      ' — אם כן, לא להוסיף שורה חדשה: לקשר אליו את הטופס.'));
    sheet.appendChild(mgrStaffF101IsBtn(t, fp));
  }
  sheet.appendChild(mgrEl('div', 'mgr-legend', 'שורה חדשה בטאב עובדים, עם הטלפון, המייל והתיקייה מהטופס. שום שורה קיימת לא משתנה. הקישור האישי — אחר כך מהגיליון.'));
  sheet.appendChild(mgrStaffBtn('btn mgr-staff-addgo', 'הוסף', 'add:' + t.key, function () {
    var kind = MGR_STAFF_KINDS.some(function (k) { return k[0] === mgrStaffKind; }) ? mgrStaffKind : 'staff';
    mgrStaffRun('add:' + t.key, 'mgrStaffAddFrom101', { ref: String(t.ref || ''), kind: kind }, 'נוסף לצוות: ' + String(t.name || ''));
  }));
}

/** "🔗 זה עובד קיים": which staff row a chugim name is — the server's suggestion first, then the active, the paused, those who left. */
function mgrStaffAliasEl(sheet, t) {
  var dn = String(t.dndName || '');
  sheet.appendChild(mgrEl('div', 'mgr-legend', 'בוחרים את העובד. ' + esc(dn) + ' נוסף לשמות החלופיים שלו בטאב עובדים, וכך הקבוצות והשעות מהחוגים מתחברות לכרטיס שלו. שום שם קיים לא משתנה.'));
  var people = mgrStaffPeople(), sug = t.suggestEmp ? mgrStaffPerson(t.suggestEmp) : null;
  var byName = function (a, b) { return String(a.name).localeCompare(String(b.name), 'he'); };
  var G = [['💡 הצעה', sug ? [sug] : []],
           ['פעילים', people.filter(function (p) { return p !== sug && (p.status === 'פעיל' || p.status === 'מתלמד'); }).sort(byName)],
           ['בהפסקה ואחר', people.filter(function (p) { return p !== sug && p.status !== 'פעיל' && p.status !== 'מתלמד' && !mgrStaffLeft(p); }).sort(byName)],
           ['עזבו', people.filter(function (p) { return p !== sug && mgrStaffLeft(p); }).sort(byName)]];
  G.forEach(function (g) {
    if (!g[1].length) return;
    sheet.appendChild(mgrEl('div', 'mgr-gh', esc(g[0])));
    g[1].forEach(function (p) {
      var why = p === sug && t.suggestWhy ? 'לפי ' + String(t.suggestWhy) : (p.dnd && p.dnd.name ? 'בחוגים: ' + String(p.dnd.name) : '');
      var b = mgrStaffBtn('mgr-cand mgr-staff-pick' + (p === sug ? ' sug' : '') + (mgrStaffLeft(p) ? ' dim' : ''), '', 'alias:' + t.key + ':' + p.id, function () {
        openAppModal('🔗 שם מהחוגים', dn + ' בחוגים = ' + p.name + ' (' + p.id + ')?\nהשם יתווסף לשמות החלופיים בטאב עובדים. שום שם קיים לא משתנה.', false, 'קשר', function () {
          mgrStaffRun('alias:' + t.key + ':' + p.id, 'mgrStaffAddAlias', { empId: p.id, name: String(p.name || ''), dndName: dn }, 'השם מהחוגים קושר ל-' + p.name + ' ✓');
        });
      });
      if (mgrStaffBusy !== 'alias:' + t.key + ':' + p.id) {
        b.innerHTML = (p === sug ? '💡 ' : '') + '<b>' + esc(p.name) + '</b>' + (p.status && p.status !== 'פעיל' ? ' <em class="mgr-staff-st">' + esc(p.status) + '</em>' : '') +
          (why ? '<div class="mgr-why">' + esc(why) + '</div>' : '');
      }
      sheet.appendChild(b);
    });
  });
}

/** From a card with no chugim name: which free chugim name is this person (the server's list; never a guess of the phone). */
function mgrStaffDndPickEl(sheet, p) {
  var free = mgrStaffFreeDnd();
  sheet.appendChild(mgrEl('div', 'mgr-legend', 'השמות בקובץ החוגים שאינם של אף עובד. השם שנבחר נוסף לשמות החלופיים של ' + esc(p.name) + ' בטאב עובדים.'));
  if (!free.length) sheet.appendChild(mgrEl('div', 'mgr-line mgr-none', 'כל השמות בקובץ החוגים כבר מקושרים לעובדים.'));
  free.forEach(function (x) {
    var name = mgrFold(x.name), n = Number(x.groups) || 0, tag = 'dnd:' + p.id + ':' + name;
    var b = mgrStaffBtn('mgr-cand mgr-staff-pick mgr-staff-dndpick', '', tag, function () {
      openAppModal('🔗 שם מהחוגים', name + ' בחוגים = ' + p.name + ' (' + p.id + ')?\nהשם יתווסף לשמות החלופיים בטאב עובדים. שום שם קיים לא משתנה.', false, 'קשר', function () {
        mgrStaffRun(tag, 'mgrStaffAddAlias', { empId: p.id, name: String(p.name || ''), dndName: name }, 'השם מהחוגים קושר ל-' + p.name + ' ✓');
      });
    });
    if (mgrStaffBusy !== tag) b.innerHTML = '<b>' + esc(name) + '</b><div class="mgr-why">' + (n ? n + ' קבוצות פעילות' : 'בלי קבוצות פעילות') + '</div>';
    sheet.appendChild(b);
  });
}

/**
 * ONE POST, one at a time, no automatic retry (it may have landed). Success: the server's message, and the cards drawn again from
 * its answer (else ONE read). No answer: say so and read the truth again. A refusal: the server's words, as they are.
 */
function mgrStaffRun(tag, action, params, okText) {
  if (mgrStaffBusy) return;
  mgrStaffBusy = tag; mgrStaffWriteErr = '';
  var ctxAt = mgrStaffCtx, gen = loginGen;
  renderMgrStaff(); renderMgrStaffSheet();
  api(action, params, { post: true, ms: 60000 }).then(function (r) {
    if (gen !== loginGen) return;   // logged out meanwhile (shared phone)
    mgrStaffBusy = '';
    if (r && r.success) {
      showToast(r.message || okText, 'success');
      // a picker that did its job closes (a chugim-name picker goes back to its card); a person's card stays open, drawn fresh
      if (ctxAt && mgrStaffCtx === ctxAt && ctxAt.mode !== 'person') mgrStaffCtx = ctxAt.mode === 'dnd' ? { mode: 'person', id: ctxAt.id } : null;
      if (action === 'mgrStaffAddFrom101' || action === 'mgrAddPerson') loadMgrBoard();   // the week table's people list gets the new person
      if (r.cards && typeof r.cards === 'object' && r.cards.success !== false && Array.isArray(r.cards.people)) {
        mgrStaffSeq++;   // a read still on its way is older than this write
        mgrStaff = r.cards; mgrStaffState = ''; mgrStaffErr = '';
        renderMgrStaff(); renderMgrStaffSheet();
      } else {
        loadMgrStaff();
        renderMgrStaffSheet();
      }
    } else if (r && r.transport) {
      mgrStaffWriteErr = MGR_STAFF_NO_ANSWER; mgrStaffSheetScroll = 0;   // the note is at the top of the sheet
      showToast(MGR_STAFF_NO_ANSWER, 'error');
      loadMgrStaff();
      renderMgrStaffSheet();
    } else {
      mgrStaffWriteErr = String(r && r.error ? r.error : 'לא נשמר.');
      mgrStaffSheetScroll = 0;   // the server's words are at the top of the sheet
      showToast(mgrStaffWriteErr, 'error');
      renderMgrStaff(); renderMgrStaffSheet();
    }
  });
}

/* ==================================================================
   Stage 10 (18/10): the attendance clock — "⏱ שעון נוכחות" at the top of "המשמרות שלי". In / out / switch with a purpose for
   every hour, side by side with Caspit (Caspit stays the clock for pay until the owner decides). Every tap has a tapId that the
   server dedups on: the tap is put in freak_clock_queue BEFORE it is sent and leaves it only when the server answers (taken or
   refused). No answer: it stays, with the phone's minute (deviceAt), and goes out again — the same tapId — on the next clockMe
   load, on "online" and every minute while the app is open. The queue is the only clock data the phone stores: the person's
   hours (clockMe) and the manager's screen (mgrClock) live in memory only. Every server text goes through esc().
   Round 2 (19/10): the queue is kept per person (B1 — another person's taps are never sent under this key and never removed: they
   go out when that person logs in here again); an exit names the pair the card showed (B3); "try again" from the server is told
   apart from no network (B5). FIX_ROUND2 (19/10): THE PHONE NEVER DELETES A TAP THE SERVER DID NOT RECORD — a tap leaves the store
   only when the server recorded it (or says the same tap / exit is already recorded), or when the person dismissed it on the
   "לא נרשמה" card that shows the action, the pressed minute and the server's reason (a final refusal goes there, never silently;
   nothing is deleted at logout). Every resend says the pressed minute and why it waited (R1); a "try again" that lasts an hour stops
   and asks (R3); every write of the store merges it again by tap id (two windows, OQ-1); no cap removes anyone's taps (OQ-2); a write
   the phone's storage refuses is said (OQ-4); the store is under a new key, so a p16 window never erases it (OQ-5).
   ================================================================== */
var CLOCK_QUEUE_KEY = 'freak_clock_queue2';   // OQ-5: p17's store — p16 (or a rollback to it) reads only the old key, and cannot erase this one
var CLOCK_QUEUE_OLD = 'freak_clock_queue';    // p16's store ({owner, items}): read, merged into the new key, removed only after that was written and read back
// the report groups in the server's fixed order (CFG.CLOCK.GROUPS) — only to sort what the server sends
var CLOCK_GROUPS = ['משמרת חנות', 'חוגים', 'אירועים', 'וואן-שוטים', 'קייטנה ומחוץ לחנות', 'התלמדות והדרכה', 'גרפיקה', 'מלאי', 'ניהול', 'אחר'];
var CLOCK_CHOICE_GROUPS = [['plan', 'היום אצלך'], ['shifts', 'משמרות'], ['chugs', 'חוגים'], ['events', 'אירועים'], ['extras', 'עוד']];
var CLOCK_FIX_KINDS = [['end', 'שעת יציאה'], ['start', 'שעת כניסה'], ['purpose', 'ייעוד'], ['void', 'לא עבדתי — בטל']];
// a request's kind as the server may name it (the clockFix kinds, or the record's own word)
var CLOCK_KIND_LABEL = { end: 'שעת יציאה', start: 'שעת כניסה', purpose: 'ייעוד', 'void': 'ביטול', add: 'משמרת שנשכחה',
  'תיקון': 'תיקון', 'ביטול': 'ביטול', 'הוספה': 'משמרת שנשכחה', 'כניסה': 'כניסה', 'יציאה': 'יציאה', 'אישור': 'אישור', 'דחייה': 'דחייה' };
var CLOCK_TICK_MS = 20000;      // the minutes of an open pair are drawn again this often (only while the page and the tab are in view)
var CLOCK_RESEND_MS = 60000;    // a tap that waits for the network is sent again this often while the app is open
var CLOCK_LATE_MIN = 10;        // the server takes the phone's minute of a late tap only up to this many minutes back (spec §4)
var CLOCK_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
var CLOCK_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var CLOCK_NO_ANSWER = 'לא התקבלה תשובה מהשרת. ייתכן שנשלח — אפשר לשלוח שוב: זו אותה בקשה, והיא לא תירשם פעמיים.';
var CLOCK_Q_PER_OWNER = 20;     // one person's taps stored on this phone (the oldest): a later one stays in memory only, said — never stored over the others (OQ-2)
var CLOCK_Q_ANSWERED = 100;     // the tap ids answered lately, kept in the store: another window's copy of an answered tap never comes back (OQ-1)
var CLOCK_RETRY_MAX = 60;       // automatic sends of one tap answered "try again" (about an hour): then it waits for "↻ שלח שוב", and so do the taps behind it (R3)
var CLOCK_SEND_FUSE_MS = 35000; // a send of a tap is "on its way" this long (the POST's fuse, 30 s, and a margin): another window neither sends it nor calls it one that waited (round 4, Q2)
var CLOCK_DST_TEXT = 'לילה של מעבר שעון — לבדוק מול כספית';   // managers only: a pair of the night the clocks go back (the server's flag dst)

var clockData = null;      // the last clockMe answer (memory only)
var clockState = '';       // '' | 'loading' | 'error'
var clockErr = '';         // the last failed read, said on the card
var clockSeq = 0;          // only the latest clockMe answer is drawn
var clockQ = [];           // this person's taps the server has not answered, in order (their part of the store): {tapId, action, params, deviceAt, label, tries, why, wait, retries, msg, stuck, seq, sendingAt}
                           //   why: '' (pressed with nothing ahead, sent as it is) | 'net' | 'retry' — sent with deviceAt on every later send (R1); wait: why it waits now
                           //   (the card); retries: "try again" answers to automatic sends; msg: the server's words of the last one; stuck: no more automatic sends (R3);
                           //   seq: its place in the person's queue, given when pressed (Q1 — never the wall time, which goes back); sendingAt: Date.now() of a send on its way (Q2)
var clockQMem = null;      // the store as this window last wrote it, when the phone's storage refused that write (OQ-4): the newest copy is then here
var clockQNoStore = false; // the last write of the store did not reach the phone's storage (OQ-4): the card says not to close the app
var clockLanded = [];      // taps the server took: drawn over clockData until a clockMe asked after them comes back ({item, seq})
var clockSending = '';     // the tapId on its way ('' = none): one tap at a time — a double tap sends once
var clockMsg = null;       // the last answer's words on the card {ok, text}; a refusal stays until the next tap
var clockSheet = null;     // the open sheet: {mode: 'pick'|'switch'|'fix'|'add', pairId}
var clockNoteFor = '';     // the choice ("אחר") whose note field is open in the sheet
var clockNoteFocus = null; // that field, right after it opened: it comes into view with the cursor (the keyboard opens where the typing is)
var clockDraft = null;     // what is typed in the sheet and on the stale card (survives a redraw), see clockDraftNew
var clockFixBusy = '';     // the correction on its way: 'stale:<pairId>' | 'fix:<pairId>' | 'add' (one at a time, no automatic retry)
var clockFixErr = null;    // {at: the tag above, text}: a refusal (the server's words, or the phone's own check), said where it was sent from
var clockFixTap = null;    // {key, id}: the tapId of a correction that got no answer — the same correction again goes with it (the server dedups)
var clockFixSent = {};     // pairId -> true: a correction of the pair was taken; until clockMe says "pending" it shows as sent
var clockTickT = 0;        // the minutes timer (0 = off)
var clockResendT = 0;      // the resend timer (0 = off)
var clockSkew = 0;         // the server's wall clock minus the phone's, ms (from clockMe.now): an open pair's minutes count on the server's time
var clockElapsedEl = null; // the span with the open pair's minutes (the tick changes only its text)

function clockDraftNew() {
  return { stale: {}, tap: { note: '' }, fix: clockFormDraft(), add: clockFormDraft() };
}
/** One form's typed text: the kind chip, a time, the picked choice ("purpose|ref"), its note, the reason, and the add's date and hours. */
function clockFormDraft() { return { kind: 'end', time: '', pick: '', note: '', reason: '', date: '', from: '', to: '' }; }
clockDraft = clockDraftNew();

/* ---- time: every wall time is "yyyy-MM-dd HH:mm" (Israel); a difference reads both sides the same way ---- */
function clockPad(n) { return (n < 10 ? '0' : '') + n; }
/** The phone's minute, "yyyy-MM-dd HH:mm". */
function clockNowText() {
  var d = new Date();
  return d.getFullYear() + '-' + clockPad(d.getMonth() + 1) + '-' + clockPad(d.getDate()) + ' ' + clockPad(d.getHours()) + ':' + clockPad(d.getMinutes());
}
/** "yyyy-MM-dd[ HH:mm[:ss]]" -> that wall time as UTC ms (NaN for anything else). */
function clockMs(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(s == null ? '' : s).trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : NaN;
}
/** The phone's wall time now, as clockMs reads one. */
function clockPhoneMs() {
  var d = new Date();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
}
function clockTextOf(ms) {
  var d = new Date(ms);
  return d.getUTCFullYear() + '-' + clockPad(d.getUTCMonth() + 1) + '-' + clockPad(d.getUTCDate()) + ' ' + clockPad(d.getUTCHours()) + ':' + clockPad(d.getUTCMinutes());
}
/** A pair's moment: a full "yyyy-MM-dd HH:mm" as it is, a bare "HH:mm" on the pair's date. */
function clockAt(p, field) {
  var v = String(p && p[field] != null ? p[field] : '').trim();
  return CLOCK_TIME_RE.test(v) && CLOCK_DATE_RE.test(String(p.date || '')) ? p.date + ' ' + v : v;
}
function clockHM(s) { var m = /(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(s == null ? '' : s).trim()); return m ? m[1] + ':' + m[2] : ''; }
function clockDM(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s == null ? '' : s).trim()); return m ? m[3] + '/' + m[2] : ''; }
/** A server moment as "dd/MM HH:mm" (escaped as it is when it is not one). */
function clockWhen(s) { return isNaN(clockMs(s)) ? esc(s) : clockDM(s) + ' ' + clockHM(s); }
/** "2026-10" -> "10/2026". */
function clockYM(ym) { var m = /^(\d{4})-(\d{2})$/.exec(String(ym == null ? '' : ym)); return m ? m[2] + '/' + m[1] : ''; }
function clockDur(min) { var n = Math.max(0, Math.floor(Number(min) || 0)); return Math.floor(n / 60) + ':' + clockPad(n % 60); }
function clockNum(n) { return n == null || n === '' || !isFinite(Number(n)) ? '—' : mgrStaffNum(n); }
/** The server's now (its wall time), from the phone's clock and the skew of the last answer. */
function clockServerMs() { return clockPhoneMs() + clockSkew; }
/** hm after the start: the same day, or the next one when hm is not after the start's time (a shift past midnight). '' if not a time. */
function clockEndAfter(start, hm) {
  var s = clockMs(start);
  if (!CLOCK_TIME_RE.test(hm) || isNaN(s)) return '';
  var e = clockMs(String(start).slice(0, 10) + ' ' + hm);
  if (e <= s) e += 86400000;
  return clockTextOf(e);
}
function clockList(a) { return Array.isArray(a) ? a.filter(function (x) { return x && typeof x === 'object'; }) : []; }
function clockFlag(p, f) { return !!p && Array.isArray(p.flags) && p.flags.indexOf(f) !== -1; }
function clockKey(c) { return String(c && c.purpose != null ? c.purpose : '') + '|' + String(c && c.ref != null ? c.ref : ''); }
/** "אחר" (extra key other) asks for a note of 2–80 characters. */
function clockNeedsNote(c) { return /(^|:)other$/.test(String(c && c.purpose != null ? c.purpose : '')); }
/** A choice's words: its label and its hours ("סגירה 16:00–22:00"), escaped. */
function clockChoiceHtml(c) {
  return esc(c.label) + (c.from && c.to ? ' <bdi>' + esc(c.from) + '–' + esc(c.to) + '</bdi>' : '');
}

/** A new tap id: a uuid where the browser has one, else 32 random hex digits (the server takes up to 40 of [A-Za-z0-9-]). */
function clockTapId() {
  try { if (window.crypto && typeof window.crypto.randomUUID === 'function') return String(window.crypto.randomUUID()); } catch (e) {}
  var s = '';
  for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/* ---- the queue ---- */
/** Whose queue it is: a short hash of the identity, so the stored queue never holds the personal key itself. */
function clockOwner() {
  var s = String(identityKey() || ''), h = 2166136261;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return s ? 'o' + h.toString(16) : '';
}

/** The phone's copy of a key: the object, or null (none, broken, or the storage cannot be read — every access in try/catch, iron rule 5). */
function clockStoreGet(key) {
  try { var raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function clockStoreRaw(key) {
  try { return window.localStorage.getItem(key); } catch (e) { return null; }
}

/** A send started at sendingAt (Date.now()) is still on its way — within the POST's fuse and a margin (Q2). */
function clockQOnWay(sendingAt) {
  var t = Number(sendingAt) || 0;
  return t > 0 && Math.abs(Date.now() - t) < CLOCK_SEND_FUSE_MS;
}

/**
 * A stored tap as the queue keeps it, or null (a bad tap id, an unknown action). A stored tap was pressed earlier and waited: it says so —
 * unless another window of this phone is sending it right now (sendingAt within the fuse, round 4, Q2): then it is as that window pressed
 * it, and nobody calls it one that waited for the network (the server would flag a live tap "📶 נשלח בלי רשת"). seq: its place (Q1).
 */
function clockQItem(it) {
  if (!it || typeof it !== 'object' || !/^[A-Za-z0-9-]{1,40}$/.test(String(it.tapId || '')) || (it.action !== 'clockIn' && it.action !== 'clockOut') ||
      !it.params || typeof it.params !== 'object') return null;
  var onWay = clockQOnWay(it.sendingAt);
  // stored and not answered: it waited — for the network, or for the app to open again (p16: no why); on its way elsewhere: as it is
  var why = it.why === 'retry' ? 'retry' : (onWay && it.why !== 'net' ? '' : 'net');
  var wait = it.wait === 'retry' ? 'retry' : (onWay && it.wait !== 'net' ? '' : 'net');
  return { tapId: String(it.tapId), action: it.action, params: Object.assign({}, it.params, { tapId: String(it.tapId) }), deviceAt: String(it.deviceAt || ''),
           label: String(it.label || ''), tries: Number(it.tries) || 0, why: why, wait: wait, retries: Number(it.retries) || 0,
           msg: String(it.msg || ''), stuck: it.stuck === true, seq: Math.max(0, Math.floor(Number(it.seq) || 0)), sendingAt: onWay ? Number(it.sendingAt) : 0 };
}

/** A refused tap of the "לא נרשמה" list, or null: {tapId, action, deviceAt, label, error}. */
function clockQRefusedItem(x) {
  if (!x || typeof x !== 'object' || !/^[A-Za-z0-9-]{1,40}$/.test(String(x.tapId || '')) || (x.action !== 'clockIn' && x.action !== 'clockOut')) return null;
  return { tapId: String(x.tapId), action: x.action, deviceAt: String(x.deviceAt || ''), label: String(x.label || ''), error: String(x.error || '') };
}

/**
 * The store: {v: 2, byOwner: {owner: [taps]}, refused: {owner: ["לא נרשמה" items]}, answered: [tap ids], dismissed: [tap ids]} — the
 * taps of every person who used this phone, each kept until the server records it, or answers it for good (then on that person's "לא
 * נרשמה" list until they dismiss it: its tap id goes to dismissed, the last CLOCK_Q_ANSWERED — round 4, Q3). Every copy there is is merged by tap id: the phone's storage, this window's copy of a write the storage refused (OQ-4 —
 * so a later write never puts a stale read over another window's taps), and p16's old key ({owner, items}, or a v2 object an earlier
 * build wrote there — OQ-5; oldRaw = its text as read). Another person's taps are kept as they are — never removed.
 */
function clockQStore() {
  var copies = [clockStoreGet(CLOCK_QUEUE_KEY), clockQMem], old = clockStoreGet(CLOCK_QUEUE_OLD);
  var st = { byOwner: {}, refused: {}, answered: [], dismissed: [], oldRaw: clockStoreRaw(CLOCK_QUEUE_OLD) }, done = {}, gone = {};
  copies.concat([old]).forEach(function (q) {
    if (q && typeof q === 'object' && q.v === 2 && Array.isArray(q.answered)) q.answered.forEach(function (id) { if (typeof id === 'string' && !done[id]) { done[id] = true; st.answered.push(id); } });
    // round 4 (Q3): "✕ הבנתי" leaves a tombstone, merged from every copy like answered — a copy written before the dismissal never brings the line back
    if (q && typeof q === 'object' && q.v === 2 && Array.isArray(q.dismissed)) q.dismissed.forEach(function (id) { if (typeof id === 'string' && !gone[id]) { gone[id] = true; st.dismissed.push(id); } });
  });
  var add = function (into, o, items) {
    if (!o || typeof o !== 'string' || !Array.isArray(items)) return;
    var have = {};
    (into[o] || []).forEach(function (x) { if (x && x.tapId) have[x.tapId] = true; });
    var more = items.filter(function (x) { return x && typeof x === 'object' && x.tapId && !have[x.tapId] && (into === st.refused ? !gone[x.tapId] : !done[x.tapId]); });
    if (more.length) into[o] = (into[o] || []).concat(more);
  };
  copies.concat([old]).forEach(function (q) {
    if (!q || typeof q !== 'object') return;
    if (q.v === 2) {
      if (q.byOwner && typeof q.byOwner === 'object') Object.keys(q.byOwner).forEach(function (o) { add(st.byOwner, o, q.byOwner[o]); });
      if (q.refused && typeof q.refused === 'object') Object.keys(q.refused).forEach(function (o) { add(st.refused, o, q.refused[o]); });
    } else add(st.byOwner, q.owner, q.items);
  });
  return st;
}

/**
 * The store into the phone's storage, read back. true: it is there — and only then p16's old key is removed (when it is still what was
 * merged: a p16 window that wrote it meanwhile is merged next time). false: the storage refused it (full, blocked) — kept in memory
 * (clockQMem) and said on the card (OQ-4).
 */
function clockQPut(st) {
  var obj = { v: 2, byOwner: st.byOwner, refused: st.refused, answered: st.answered.slice(-CLOCK_Q_ANSWERED), dismissed: (st.dismissed || []).slice(-CLOCK_Q_ANSWERED) },
      text = JSON.stringify(obj), ok = false;
  try { window.localStorage.setItem(CLOCK_QUEUE_KEY, text); ok = window.localStorage.getItem(CLOCK_QUEUE_KEY) === text; } catch (e) { ok = false; }
  clockQMem = ok ? null : obj;
  clockQNoStore = !ok;
  if (ok && st.oldRaw !== null && clockStoreRaw(CLOCK_QUEUE_OLD) === st.oldRaw) { try { window.localStorage.removeItem(CLOCK_QUEUE_OLD); } catch (e2) {} }
  return ok;
}

/**
 * This person's taps not answered: the ones in memory and the stored ones (another window's), by tap id, minus the ones answered in
 * any window, in the order they were pressed — by seq, the number each tap got when it was pressed (round 4, Q1: never by deviceAt, a
 * wall time that goes back on the night the clocks go back and whenever the phone's clock is set back; memory keeps its order, a
 * stored tap goes to its number, p16's taps — no number — first, in their stored order). st = clockQStore. A copy taken from another
 * window while that window was sending it, whose send is over with no word from there, waited for the network after all (Q2).
 */
function clockQMerged(st, me) {
  var done = {}, seen = {}, list = [];
  st.answered.forEach(function (id) { done[id] = true; });
  var take = function (it) { if (it && !done[it.tapId] && !seen[it.tapId]) { seen[it.tapId] = true; list.push(it); } };
  clockQ.forEach(function (it) {
    if (it && it.sendingAt && clockSending !== it.tapId && !clockQOnWay(it.sendingAt)) {
      it.sendingAt = 0;
      if (!it.why) it.why = 'net';
      if (!it.wait) it.wait = 'net';
    }
    take(it);
  });
  (st.byOwner[me] || []).map(clockQItem).forEach(take);
  return list.map(function (it, i) { return { it: it, i: i }; }).sort(function (a, b) {
    var x = Number(a.it.seq) || 0, y = Number(b.it.seq) || 0;   // p16's taps have none (0): first, in their stored order
    return x !== y ? x - y : a.i - b.i;
  }).map(function (x) { return x.it; });
}

/** The number of a new tap (Q1): one more than the highest of list — this person's taps that wait, merged (clockQMerged). */
function clockQNextSeq(list) {
  var top = 0;
  (list || []).forEach(function (it) { if (it && it.seq > top) top = it.seq; });
  return top + 1;
}

/**
 * Every write of the queue (OQ-1, 19/10): the store is read again first and this person's part merged (clockQMerged) — so two windows
 * of this phone never erase each other's taps, and memory takes the other window's. change(st, me) edits the store first (an answer, a
 * refused tap, a dismissal). At most CLOCK_Q_PER_OWNER of this person's taps are stored — the oldest; a later one waits in memory only,
 * said on the card (OQ-2). Another person's part is never touched. true when the phone's storage holds it (clockQPut).
 */
function clockQSave(change) {
  var me = clockOwner();
  if (!me) return true;
  var st = clockQStore();
  if (change) change(st, me);
  clockQ = clockQMerged(st, me);
  var keep = clockQ.slice(0, CLOCK_Q_PER_OWNER);
  if (keep.length) st.byOwner[me] = keep; else delete st.byOwner[me];
  if (st.refused[me] && !st.refused[me].length) delete st.refused[me];
  return clockQPut(st);
}

/** This person's "לא נרשמה" list (the store, read now). */
function clockQRefused() {
  var me = clockOwner();
  return me ? (clockQStore().refused[me] || []).map(clockQRefusedItem).filter(function (x) { return x; }) : [];
}

/**
 * "✕ הבנתי" on a "לא נרשמה" line: the person dismissed it — the only way a tap the server did not record leaves the phone. A tombstone
 * (dismissed) goes with it (round 4, Q3): while the phone's storage refuses writes, its older copy still holds the line, and the merge
 * would draw it again; the next write that reaches the storage carries the tombstone there.
 */
function clockQDismiss(tapId) {
  clockQSave(function (st, me) {
    st.refused[me] = (st.refused[me] || []).filter(function (x) { return !x || x.tapId !== tapId; });
    st.dismissed = (st.dismissed || []).filter(function (x) { return x !== tapId; }).concat([tapId]);
  });
  renderClock();
}

/**
 * At login: this person's stored taps (p16's old key too) come back and go out. Another person's are never sent under this key and
 * never removed — they wait, unseen, until that person logs in on this phone again (B1).
 */
function clockQLoad() {
  clockQ = [];
  clockQNoStore = false;
  clockQSave();
}

/** This person's taps not answered, from the store read again NOW and memory (OQ-1: the logout warning never misses another window's). */
function clockQWaiting() {
  var me = clockOwner();
  return me ? clockQMerged(clockQStore(), me) : clockQ.slice();
}

/** The words of the taps not sent yet, for the logout warning ("כניסה · סגירה 16:02, יציאה 22:00"). */
function clockQText(list) {
  return (list || clockQ).map(function (it) { return (it.action === 'clockIn' ? 'כניסה' + (it.label ? ' · ' + it.label : '') : 'יציאה') + ' ' + clockHM(it.deviceAt); }).join(', ');
}

/**
 * A tap: in the queue (stored) first, then sent. One tap on its way at a time — a second tap meanwhile (a double tap) sends nothing.
 * A tap made while others wait goes behind them, so the server gets them in the order they were pressed — and it waits as the first
 * of them does: it says when it was pressed, and why (R1). A 21st of this person is not stored over the others: it waits in memory,
 * said (OQ-2); a write the phone's storage refuses is said, and the tap goes at once all the same (OQ-4).
 */
function clockTap(action, params, label) {
  if (clockSending || !AppState.currentUserId) return;
  // what waits now in every window of this phone (Q1): the new tap goes behind it, numbered after it, and waits as its first tap does
  var me = clockOwner(), ahead = me ? clockQMerged(clockQStore(), me) : clockQ;
  var id = clockTapId(), head = ahead[0], seq = clockQNextSeq(ahead);
  var why = !head ? '' : (head.wait === 'net' ? 'net' : 'retry');
  clockQ.push({ tapId: id, action: action, params: Object.assign({}, params, { tapId: id }), deviceAt: clockTextOf(clockServerMs()), label: String(label || ''),
                tries: 0, why: why, wait: why, retries: 0, msg: '', stuck: false, seq: seq, sendingAt: 0 });
  clockMsg = null; clockSheet = null; clockNoteFor = '';
  clockQSave();
  renderClockSheet();
  clockFlush();
}

/**
 * Sends the first tap of the queue (manual: the tap id "↻ שלח שוב" was pressed for). Recorded: it leaves the queue. Refused for good:
 * it leaves the queue for the "לא נרשמה" list, with the server's reason — never silently. No answer, or "try again": it stays, and goes
 * again; after CLOCK_RETRY_MAX "try again" answers it stops going by itself, and the taps behind it wait for it (R3).
 */
function clockFlush(manual) {
  if (clockSending || !clockQ.length || !AppState.currentUserId) return;
  clockQSave();   // OQ-1: the store first — a tap another window got answered is not sent again from here
  if (!clockQ.length) { renderClock(); return; }
  var it = clockQ[0], gen = loginGen;
  if (it.stuck && manual !== it.tapId) return;   // R3: it waits for "↻ שלח שוב" — and so does every tap behind it (an entry lands before its exit)
  if (clockQOnWay(it.sendingAt)) { renderClock(); return; }   // Q2: another window of this phone is sending it now — its answer decides, not a second send from here
  var body = Object.assign({}, it.params);
  // R1 (19/10): a tap that waited — for the network, for the app to open again, or for the server's "try again" — says when it was
  // pressed and why it waited, on EVERY send: the server keeps the pressed minute (up to 10 minutes back, else in the reason) and marks
  // the pair "📶 נשלח בלי רשת" only after a network wait. Only a tap sent as it is pressed, with nothing ahead of it, says neither
  if (it.why) { body.deviceAt = it.deviceAt; body.why = it.why; }
  it.tries++;
  it.sendingAt = Date.now();   // Q2: on its way — stored, so another window neither sends it again nor takes it for one that waited
  clockSending = it.tapId;
  clockQSave();
  renderClock();
  api(it.action, body, { post: true }).then(function (r) {
    if (gen !== loginGen) return;   // logged out meanwhile (shared phone): the tap stays stored as that person's, and goes again at their login
    clockSending = '';
    it.sendingAt = 0;
    if (!r || r.transport) {   // no answer (it may have landed): it stays, and the same tapId goes again (the server answers it once)
      it.wait = 'net';
      it.why = 'net';
      clockQSave();
      renderClock();
      return;
    }
    if (r.retry) {   // a refusal that passes by itself (the same minute, a busy server, the night the clocks go back): it stays, sent again in a minute
      it.wait = 'retry';
      if (it.why !== 'net') it.why = 'retry';
      it.msg = String(r.error || 'השרת עסוק');
      if (manual !== it.tapId) it.retries = (Number(it.retries) || 0) + 1;
      if (it.retries > CLOCK_RETRY_MAX) it.stuck = true;   // about an hour of "try again": it stops going by itself and asks (R3)
      clockQSave();
      renderClock();
      return;
    }
    // answered for good: the tap leaves the queue — recorded, or onto the "לא נרשמה" list with the server's reason (the principle)
    var refused = !r.success, why = String(r.error || 'הלחיצה לא נרשמה.');
    clockQ = clockQ.filter(function (x) { return x.tapId !== it.tapId; });
    clockQSave(function (st, me) {
      st.answered = st.answered.filter(function (x) { return x !== it.tapId; }).concat([it.tapId]);
      if (!refused) return;
      st.refused[me] = (st.refused[me] || []).filter(function (x) { return !x || x.tapId !== it.tapId; })
        .concat([{ tapId: it.tapId, action: it.action, deviceAt: it.deviceAt, label: it.label, error: why }]);
    });
    if (r.success) {
      if (it.action === 'clockIn' && r.pairId) it.pairId = String(r.pairId);   // the pair it opened: "⏹ יציאה" names it until clockMe comes back
      clockLanded.push({ item: it, seq: clockSeq });
      clockMsg = r.message ? { ok: true, text: String(r.message) } : null;
    } else {
      // a final refusal of an exit (its pair is a missing exit): the red card of that pair starts with the minute the exit was pressed
      if (it.action === 'clockOut' && it.params.pairId) clockStaleTime(String(it.params.pairId), it.deviceAt);
      clockMsg = null;   // said once: on its "לא נרשמה" line, with the action and the pressed minute
    }
    if (clockQ.length) clockFlush();
    else loadClock();
  });
}

/* ---- the read ---- */
function loadClock() {
  if (!AppState.currentUserId) return;
  var gen = loginGen, seq = ++clockSeq;
  clockState = 'loading';
  api('clockMe').then(function (r) {
    if (gen !== loginGen || seq !== clockSeq) return;   // logged out meanwhile, or a newer answer is coming
    if (r && r.success) {
      clockData = r; clockState = ''; clockErr = '';
      var sk = clockMs(r.nowStamp || r.now) - clockPhoneMs();
      clockSkew = isFinite(sk) ? sk : 0;   // a phone set to the wrong time still counts the minutes right
      clockLanded = clockLanded.filter(function (x) { return x.seq >= seq; });   // this answer already holds the taps taken before it was asked
      Object.keys(clockFixSent).forEach(function (id) { delete clockFixSent[id]; });   // and the corrections, as "pending"
    } else if (r && r.transport && clockData) {   // no answer: what is on screen stays, and says so
      clockState = 'error'; clockErr = 'לא התקבלה תשובה מהשרת — מוצג מה שנטען קודם.';
    } else {
      clockData = null; clockState = 'error';
      clockErr = r && r.transport ? 'כשל בתקשורת מול השרת — ↻ לנסות שוב.' : 'שגיאה: ' + String(r && r.error ? r.error : 'תשובה לא תקינה מהשרת');
    }
    renderClock(); renderClockHours(); renderClockSheet();
  });
  renderClock();
  clockFlush();   // a tap that waited for the network goes out with the read
}

/** Login / logout: the card, the hours, the sheet and the timers belong to the previous user (the stored queue is the caller's business). */
function clockReset() {
  clockData = null; clockState = ''; clockErr = ''; clockSeq++; clockQ = []; clockQNoStore = false; clockLanded = []; clockSending = ''; clockMsg = null;
  clockSheet = null; clockNoteFor = ''; clockDraft = clockDraftNew(); clockFixBusy = ''; clockFixErr = null; clockFixTap = null; clockFixSent = {}; clockSkew = 0;
  var fold = document.getElementById('clockDetHours');
  if (fold) fold.open = false;   // the next person opens "🧾 השעות שלי" for himself
  renderClock(); renderClockHours(); renderClockSheet();
}

/* ---- the state on the card ---- */
/** The server's state, then every tap it took since (until clockMe says so), then every tap not answered: {open, stale, last}. */
function clockView() {
  var d = clockData || {}, stale = clockList(d.stale), open = d.open && typeof d.open === 'object' ? d.open : null;
  if (open && clockFlag(open, 'stale')) {   // an open pair older than 16 hours is not "at work": it is a missing exit
    if (!stale.some(function (p) { return p.pairId && p.pairId === open.pairId; })) stale = stale.concat([open]);
    open = null;
  }
  var v = { open: open, stale: stale, last: null };
  clockLanded.map(function (x) { return x.item; }).concat(clockQ).forEach(function (it) {
    v.last = it;
    v.open = it.action === 'clockIn' ? { label: it.label, start: it.deviceAt, purpose: it.params.purpose, ref: it.params.ref, pairId: String(it.pairId || ''), local: it } : null;
  });
  return v;
}

/**
 * Why the queue waits (B5; R3 — from its FIRST tap: the taps behind it wait for it, whatever they waited for before): 'stuck' — "try
 * again" for an hour, it waits for "↻ שלח שוב"; 'net' — no answer (the network); 'retry' — "try again", it goes again in a minute; '' — on
 * its way, or nothing waits.
 */
function clockQWhy() {
  var h = clockQ[0];
  if (!h || clockSending === h.tapId) return '';
  if (h.stuck) return 'stuck';
  return h.wait === 'retry' ? 'retry' : (h.wait ? 'net' : '');
}

/** The mark of a tap the phone draws: ⏳ on its way / behind another, "ממתין לרשת" after no answer, "יישלח שוב בעוד דקה" after a retry, ✓ taken. */
function clockTapMark(it) {
  if (clockQ.indexOf(it) === -1) return '<span class="clock-ok">✓</span>';
  var why = clockSending === it.tapId ? '' : clockQWhy();
  return '<span class="clock-wait">' + (why === 'net' ? '⏳ ממתין לרשת' : why === 'retry' ? '⏳ יישלח שוב בעוד דקה' : why === 'stuck' ? '⏳ עוד לא נשלחה' : '⏳') + '</span>';
}

/** The server's words of a retry as the card says them: no ⏳ of its own (the card has one), no full stop at the end. */
function clockRetryWords(msg) {
  return String(msg || 'השרת עסוק').replace(/^\s*⏳\s*/, '').replace(/[.\s]+$/, '');
}

/** The minute an exit of this pair was pressed, into its red card's time field — only when nothing is typed there, and only when the field can say it. */
function clockStaleTime(pairId, deviceAt) {
  var p = clockList(clockData && clockData.stale).concat(clockData && clockData.open ? [clockData.open] : []).filter(function (x) { return x.pairId === pairId; })[0];
  var hm = clockHM(deviceAt), dr = clockDraft.stale[pairId] || { time: '', reason: '' };
  // the field is HH:MM after the entry (the same day or the next): a minute it would read as another day is left out
  if (!p || dr.time || !CLOCK_TIME_RE.test(hm) || clockEndAfter(clockAt(p, 'start'), hm) !== String(deviceAt).slice(0, 16)) return;
  dr.time = hm;
  clockDraft.stale[pairId] = dr;
}

/** The open pair's minutes ("1:23"): a tap of this phone counts from the phone's minute, the server's pair from the server's time. */
function clockElapsedText(open) {
  if (!open) return '';
  var s = clockMs(clockAt(open, 'start'));
  if (isNaN(s)) return '';
  return clockDur((clockServerMs() - s) / 60000);   // a tap of this phone has its minute on the server's clock too (clockTap)
}

function clockBtn(cls, html, fn) {
  var b = mgrEl('button', cls, html); b.type = 'button';
  b.disabled = !!clockSending;
  b.onclick = function () { if (clockSending) return; fn(); };
  return b;
}

/** A choice from the card or the sheet: "אחר" first asks for its note (in the sheet); every other one is ONE tap. */
function clockChoose(c) {
  if (clockNeedsNote(c)) {
    if (!clockSheet || (clockSheet.mode !== 'pick' && clockSheet.mode !== 'switch')) clockSheet = { mode: 'pick', pairId: '' };
    clockNoteFor = clockKey(c);
    clockNoteFocus = true;
    renderClockSheet();
    return;
  }
  clockTap('clockIn', { purpose: String(c.purpose), ref: String(c.ref == null ? '' : c.ref), note: '' }, String(c.label || ''));
}

function renderClock() {
  var box = document.getElementById('clockCard');
  if (!box) return;
  box.innerHTML = '';
  clockElapsedEl = null;
  if (!AppState.currentUserId) { clockTimersSync(); return; }
  var d = clockData, v = clockView();
  v.stale.forEach(function (p) { box.appendChild(clockStaleEl(p)); });
  var card = mgrEl('div', 'card clock-card' + (v.open ? ' clock-on' : ''));
  var head = mgrEl('div', 'clock-h', '<b>⏱ שעון נוכחות</b>');
  var rl = mgrEl('button', 'btn btn-sm btn-secondary clock-reload'); rl.type = 'button';
  rl.textContent = clockState === 'loading' ? MGR_BUSY : '↻';
  rl.setAttribute('aria-label', 'טען שוב את השעון');
  rl.disabled = clockState === 'loading';
  rl.onclick = function () { if (clockState !== 'loading') loadClock(); };
  head.appendChild(rl);
  card.appendChild(head);
  if (clockErr) card.appendChild(mgrEl('div', 'mgr-note clock-err', '⚠️ ' + esc(clockErr)));
  if (!d && !v.last) {   // nothing to draw from yet
    if (clockState === 'loading') card.appendChild(mgrEl('div', 'mgr-skel clock-skel'));
    box.appendChild(card);
    clockTimersSync();
    return;
  }
  if (v.open) {
    var o = v.open, st = clockAt(o, 'start');
    var line = mgrEl('div', 'clock-now', '🟢 בעבודה · <b>' + esc(o.label) + '</b> · מ-<bdi>' + clockHM(st) + '</bdi> · ');
    clockElapsedEl = mgrEl('bdi', 'clock-elapsed');
    clockElapsedEl.textContent = clockElapsedText(o);
    line.appendChild(clockElapsedEl);
    if (o.local) line.appendChild(mgrEl('span', 'clock-mark', ' ' + clockTapMark(o.local)));
    card.appendChild(line);
    var acts = mgrEl('div', 'clock-acts');
    // the pair on the card (the server's, or the one a tap of this phone opened): only that one is closed (B3) — none while not known yet
    acts.appendChild(clockBtn('btn clock-out', '⏹ יציאה', function () { clockTap('clockOut', o.pairId ? { pairId: String(o.pairId) } : {}, ''); }));
    acts.appendChild(clockBtn('btn btn-secondary clock-switch', '🔁 עברתי ל…', function () { clockOpenSheet('switch'); }));
    card.appendChild(acts);
  } else {
    if (v.last && v.last.action === 'clockOut') card.appendChild(mgrEl('div', 'clock-now clock-left', '⏹ יציאה ב-<bdi>' + clockHM(v.last.deviceAt) + '</bdi> ' + clockTapMark(v.last)));
    var plan = clockList(d && d.plan).filter(function (c) { return c.purpose; });
    if (plan.length) {
      card.appendChild(mgrEl('div', 'mgr-sub clock-plan-h', 'היום אצלך:'));
      plan.forEach(function (c) { card.appendChild(clockBtn('btn clock-go clock-plan', '▶ כניסה · ' + clockChoiceHtml(c), function () { clockChoose(c); })); });
      card.appendChild(clockBtn('btn btn-secondary clock-other', '▶ משהו אחר…', function () { clockOpenSheet('pick'); }));
    } else {
      card.appendChild(clockBtn('btn clock-go clock-any', '▶ כניסה…', function () { clockOpenSheet('pick'); }));
    }
  }
  if (clockMsg) card.appendChild(mgrEl('div', 'clock-msg ' + (clockMsg.ok ? 'ok' : 'no'), (clockMsg.ok ? '' : '⚠️ ') + esc(clockMsg.text)));
  // the principle (FIX_ROUND2): a tap the server refused for good is said with what it was and when it was pressed, until the person dismisses it
  clockQRefused().forEach(function (x) {
    var line = mgrEl('div', 'mgr-note clock-refused', '⚠️ לא נרשמה: ' + (x.action === 'clockIn' ? 'כניסה' + (x.label ? ' (' + esc(x.label) + ')' : '') : 'יציאה') +
      ' שנלחצה ב-<bdi>' + clockWhen(x.deviceAt) + '</bdi> — ' + esc(x.error.replace(/[.\s]+$/, '')) + '. אפשר לבקש תיקון ב׳🧾 השעות שלי׳. ');
    var ok = mgrEl('button', 'btn btn-sm btn-secondary clock-refused-ok', '✕ הבנתי'); ok.type = 'button';
    ok.onclick = function () { clockQDismiss(x.tapId); };
    line.appendChild(ok);
    card.appendChild(line);
  });
  clockQueueEl(card);
  box.appendChild(card);
  clockTimersSync();
}

/**
 * ONE line for the queue — why it waits, from its first tap (B5 / R3), the server's words of a retry once (R4), and the taps behind it
 * once; above it what the phone could not keep: a write its storage refused (OQ-4), taps beyond the CLOCK_Q_PER_OWNER stored (OQ-2).
 */
function clockQueueEl(card) {
  var n = clockQ.length, why = clockQWhy(), h = clockQ[0];
  if (!n) return;
  if (clockQNoStore) card.appendChild(mgrEl('div', 'mgr-note clock-nostore', '⚠️ הטלפון לא שומר את הלחיצה — לא לסגור את האפליקציה עד שהיא נשלחת'));
  else if (n > CLOCK_Q_PER_OWNER) card.appendChild(mgrEl('div', 'mgr-note clock-nostore', '⚠️ יש כבר ' + CLOCK_Q_PER_OWNER + ' לחיצות שמחכות — ' +
    (n - CLOCK_Q_PER_OWNER === 1 ? 'האחרונה לא נשמרת' : 'האחרונות (' + (n - CLOCK_Q_PER_OWNER) + ') לא נשמרות') + ' בטלפון: לא לסגור את האפליקציה עד שהן נשלחות.'));
  var behind = n > 1 && why !== 'net' ? ' ' + (n === 2 ? 'עוד לחיצה אחת מחכה אחריה, ותישלח אחריה.' : 'עוד ' + (n - 1) + ' לחיצות מחכות אחריה, ויישלחו אחריה לפי הסדר.') : '';
  if (why === 'stuck') {
    var st = mgrEl('div', 'mgr-note clock-queue clock-stuck', '⚠️ הלחיצה עדיין לא נשלחה: ' + esc(clockRetryWords(h.msg)) + ' — לנסות שוב.' + behind + ' ');
    st.appendChild(clockBtn('btn btn-sm clock-resend', '↻ שלח שוב', function () { if (clockQ[0]) clockFlush(clockQ[0].tapId); }));
    card.appendChild(st);
  } else if (why === 'net') {
    var t0 = clockMs(h.deviceAt), late = !isNaN(t0) && clockServerMs() - t0 > CLOCK_LATE_MIN * 60000;
    card.appendChild(mgrEl('div', 'mgr-note clock-queue', '⏳ ממתין לרשת — ' + (n === 1 ? 'הלחיצה תישלח' : n + ' לחיצות יישלחו') + ' כשהרשת תחזור.' +
      (late ? ' עברו יותר מ-10 דקות מהלחיצה, אז תירשם שעת השליחה — אחר כך לבקש תיקון ב"🧾 השעות שלי".' : '')));
  } else if (why === 'retry') {   // the server said "try again" (B5): the network is fine, and it goes again by itself — its words once (R4)
    var words = clockRetryWords(h.msg);
    if (clockQNoStore) words = words.replace(/\s*הלחיצה נשמרת בטלפון ותישלח לבד$/, '');   // OQ-4: never "kept on the phone" when it is not
    var kept = /נשמרת בטלפון/.test(words) ? '.' : (clockQNoStore ? ' — הלחיצה תישלח שוב בעוד דקה.' : ' — הלחיצה שמורה בטלפון ותישלח שוב בעוד דקה.');
    card.appendChild(mgrEl('div', 'mgr-note clock-queue clock-retry', '⏳ ' + esc(words) + kept + behind));
  }
}

/* ---- a missing exit: the red card, never in the way of a new entry ---- */
function clockStaleEl(p) {
  var st = clockAt(p, 'start'), id = String(p.pairId || ''), tag = 'stale:' + id;
  var c = mgrEl('div', 'card clock-stale');
  c.appendChild(mgrEl('div', 'clock-stale-h', '⚠️ לא נרשמה יציאה · <bdi>' + clockDM(st) + '</bdi> · ' + esc(p.label) + ' · נכנסת <bdi>' + clockHM(st) + '</bdi>'));
  if (p.pending || clockFixSent[id] || clockFlag(p, 'pending')) { c.appendChild(mgrEl('div', 'clock-msg ok clock-sent', '⏳ נשלח לאישור')); return c; }
  if (p.locked === true) { c.appendChild(mgrEl('div', 'mgr-legend clock-locked', 'אי אפשר כבר לתקן את החודש הזה מהטלפון — לפנות למנהל.')); return c; }
  var dr = clockDraft.stale[id] || (clockDraft.stale[id] = { time: '', reason: '' });
  var row = mgrEl('div', 'mgr-day-times');
  row.appendChild(mgrEl('label', 'mgr-day-lbl', 'מתי יצאת?'));
  row.appendChild(mgrToolInput('clock-stale-time', 'HH:MM', 5, 'time', function () { return dr.time; }, function (x) { dr.time = x; }));
  c.appendChild(row);
  c.appendChild(mgrToolInput('clock-stale-reason', 'סיבה (למשל: שכחתי לסמן יציאה)', 200, 'text', function () { return dr.reason; }, function (x) { dr.reason = x; }));
  if (clockFixErr && clockFixErr.at === tag) c.appendChild(mgrEl('div', 'mgr-note clock-fix-err', '⚠️ ' + esc(clockFixErr.text)));
  var go = mgrEl('button', 'btn btn-sm clock-stale-go'); go.type = 'button';
  go.textContent = clockFixBusy === tag ? MGR_BUSY : 'שלח לאישור';
  go.disabled = !!clockFixBusy;
  go.onclick = function () {
    if (clockFixBusy) return;
    var b = clockFixBody({ kind: 'end', time: dr.time, reason: dr.reason }, p, null);
    if (b.err) { clockFixFail(tag, b.err); return; }
    clockFixRun(tag, b.body);
  };
  c.appendChild(go);
  return c;
}

/* ---- the corrections (shared with the manager's person sheet: the same checks, the same body) ---- */
/** The reason of a correction: 3–200 characters, or the words that say why not. */
function clockReasonProblem(r) { return r.length < 3 || r.length > 200 ? 'צריך סיבה של 3 עד 200 תווים.' : ''; }
function clockNoteProblem(c, note) { return clockNeedsNote(c) && (note.length < 2 || note.length > 80) ? 'ל"אחר" צריך לכתוב על מה — 2 עד 80 תווים.' : ''; }
/** A choice of the lists by its key, or null. */
function clockChoiceOf(choices, key) {
  var ch = choices && typeof choices === 'object' ? choices : {}, hit = null;
  CLOCK_CHOICE_GROUPS.forEach(function (g) { clockList(ch[g[0]]).forEach(function (c) { if (!hit && c.purpose && clockKey(c) === key) hit = c; }); });
  return hit;
}

/** A correction of a pair (end / start / purpose / void) from a form's draft: {body} or {err}. The server checks it all again. */
function clockFixBody(dr, p, choices) {
  var kind = String(dr.kind || ''), reason = mgrFold(dr.reason), st = clockAt(p, 'start'), en = clockAt(p, 'end');
  var body = { kind: kind, pairId: String(p.pairId || '') };
  if (kind === 'end' || kind === 'start') {
    var hm = String(dr.time || '').trim();
    if (!CLOCK_TIME_RE.test(hm)) return { err: kind === 'end' ? 'צריך את שעת היציאה.' : 'צריך את שעת הכניסה.' };
    var at = kind === 'end' ? clockEndAfter(st, hm) : String(st).slice(0, 10) + ' ' + hm;
    if (!at || isNaN(clockMs(at))) return { err: 'לא ברור מתי המשמרת התחילה — לפנות למנהל.' };
    if (clockMs(at) > clockServerMs() + 5 * 60000) return { err: 'השעה הזו עוד לא הגיעה.' };
    if (kind === 'start' && en && !(clockMs(at) < clockMs(en))) return { err: 'שעת הכניסה צריכה להיות לפני היציאה (' + clockHM(en) + ').' };
    body[kind] = at;
  } else if (kind === 'purpose') {
    var c = clockChoiceOf(choices, dr.pick);
    if (!c) return { err: 'לבחור את הייעוד הנכון.' };
    var note = mgrFold(dr.note), np = clockNoteProblem(c, note);
    if (np) return { err: np };
    body.purpose = String(c.purpose); body.ref = String(c.ref == null ? '' : c.ref); body.note = clockNeedsNote(c) ? note : '';
  } else if (kind !== 'void') {
    return { err: 'לבחור מה לתקן.' };
  }
  var rp = clockReasonProblem(reason);
  if (rp) return { err: rp };
  body.reason = reason;
  return { body: body };
}

/** A forgotten shift (kind add) from a form's draft: the date inside the window [from, to], the hours, the purpose, the reason. */
function clockAddBody(dr, win, choices) {
  var date = String(dr.date || '').trim(), from = String(dr.from || '').trim(), to = String(dr.to || '').trim();
  if (!CLOCK_DATE_RE.test(date)) return { err: 'צריך תאריך.' };
  if ((win.from && date < win.from) || (win.to && date > win.to)) return { err: 'אפשר להוסיף רק מ-' + clockDM(win.from) + ' עד ' + clockDM(win.to) + '.' };
  if (!CLOCK_TIME_RE.test(from) || !CLOCK_TIME_RE.test(to)) return { err: 'צריך שעת כניסה ושעת יציאה.' };
  var start = date + ' ' + from, end = clockEndAfter(start, to);
  if (clockMs(end) > clockServerMs() + 5 * 60000) return { err: 'שעת היציאה עוד לא הגיעה.' };
  var c = clockChoiceOf(choices, dr.pick);
  if (!c) return { err: 'לבחור על מה עבדת.' };
  var note = mgrFold(dr.note), np = clockNoteProblem(c, note);
  if (np) return { err: np };
  var reason = mgrFold(dr.reason), rp = clockReasonProblem(reason);
  if (rp) return { err: rp };
  return { body: { kind: 'add', date: date, start: start, end: end, purpose: String(c.purpose), ref: String(c.ref == null ? '' : c.ref),
                   note: clockNeedsNote(c) ? note : '', reason: reason } };
}

/** A correction answered "try again" (nothing written, nothing kept): the server's words, and "send again" only when they do not say it (N2). */
function clockAgainWords(msg) {
  var m = String(msg || 'השרת עסוק');
  return /שוב/.test(m) ? m : m + ' — אפשר לשלוח שוב.';
}

function clockFixFail(tag, text) {
  clockFixErr = { at: tag, text: String(text) };
  showToast(clockFixErr.text, 'error');
  renderClock(); renderClockSheet();
}

/** ONE clockFix POST, one at a time. Taken: the server's words, and the state read again. No answer: said — the same correction again keeps its tapId. */
function clockFixRun(tag, body) {
  if (clockFixBusy || !AppState.currentUserId) return;
  var gen = loginGen, key = tag + '|' + JSON.stringify(body);
  if (!clockFixTap || clockFixTap.key !== key) clockFixTap = { key: key, id: clockTapId() };
  clockFixBusy = tag; clockFixErr = null;
  renderClock(); renderClockSheet();
  api('clockFix', Object.assign({}, body, { tapId: clockFixTap.id }), { post: true }).then(function (r) {
    if (gen !== loginGen) return;   // logged out meanwhile (shared phone)
    clockFixBusy = '';
    if (r && r.success) {
      clockFixTap = null;
      if (body.pairId) { clockFixSent[body.pairId] = true; delete clockDraft.stale[body.pairId]; }
      if (clockSheet && (clockSheet.mode === 'fix' || clockSheet.mode === 'add')) clockSheet = null;
      if (tag === 'add') clockDraft.add = clockFormDraft(); else if (tag.indexOf('fix:') === 0) clockDraft.fix = clockFormDraft();
      showToast(r.message || 'נשלח לאישור ✓', 'success');
      loadClock();
    } else if (r && r.transport) {
      clockFixErr = { at: tag, text: CLOCK_NO_ANSWER };
      showToast(CLOCK_NO_ANSWER, 'error');
    } else if (r && r.retry) {   // the server said "try again" (nothing was written): the same correction again keeps its tapId
      clockFixErr = { at: tag, text: clockAgainWords(r.error) };
      showToast(clockFixErr.text, 'error');
    } else {
      clockFixTap = null;
      clockFixErr = { at: tag, text: String(r && r.error ? r.error : 'לא נשלח.') };
      showToast(clockFixErr.text, 'error');
    }
    renderClock(); renderClockHours(); renderClockSheet();
  });
}

/* ---- 🧾 השעות שלי ---- */
function clockPairById(id) {
  var hit = null;
  [clockData && clockData.month, clockData && clockData.prevMonth].forEach(function (m) {
    clockList(m && m.pairs).forEach(function (p) { if (!hit && id && p.pairId === id) hit = p; });
  });
  return hit;
}

/** A pair can be corrected by its person: in the editable window, not void, no request of it waiting (one at a time — the server's rule). */
function clockEditable(p) {
  var from = clockData && clockData.editable && clockData.editable.from ? String(clockData.editable.from) : '';
  var day = String(p.date || clockAt(p, 'start')).slice(0, 10);
  return !!p.pairId && p.status !== 'void' && p.status !== 'pending-add' && !p.pending && !clockFixSent[p.pairId] && !(from && day < from);
}

/** What a waiting request asks for ("יציאה 22:00"), escaped. */
function clockPendText(pd) {
  var k = String(pd.kind || ''), bits = [];
  if (pd.start) bits.push('כניסה <bdi>' + clockHM(pd.start) + '</bdi>');
  if (pd.end) bits.push('יציאה <bdi>' + clockHM(pd.end) + '</bdi>');
  if (pd.label) bits.push(esc(pd.label));
  if (k === 'void' || k === 'ביטול') bits.push('ביטול');
  return bits.join(' · ') || esc(CLOCK_KIND_LABEL[k] || k);
}

/** The marks of a pair: ⏳ waiting, ✏️ corrected, ⚠️ missing exit / long, ✖ cancelled or rejected (with the reason); forMgr: + the night the clocks go back. */
function clockMarks(p, current, forMgr) {
  var out = [], add = function (cls, html) { out.push('<em class="clock-mk ' + cls + '">' + html + '</em>'); };
  if (p.status === 'void') add('no', '✖ בוטל');
  if (p.status === 'pending-add') add('wait', '⏳ ממתין לאישור');
  if (p.pending && typeof p.pending === 'object') add('wait', '⏳ ממתין: ' + clockPendText(p.pending));
  else if (clockFixSent[p.pairId]) add('wait', '⏳ נשלח לאישור');
  if (p.rejected && typeof p.rejected === 'object') add('no', '✖ נדחה' + (p.rejected.reason ? ': ' + esc(p.rejected.reason) : ''));
  if (clockFlag(p, 'edited')) add('ed', '✏️ תוקן');
  if (clockFlag(p, 'stale') || (p.status === 'open' && !current)) add('warn', '⚠️ חסרה יציאה');
  if (clockFlag(p, 'long')) add('warn', '⚠️ יותר מ-12 שעות');
  if (clockFlag(p, 'late-sent')) add('info', '📶 נשלח בלי רשת');
  if (forMgr && clockFlag(p, 'dst')) add('warn', '⚠️ ' + CLOCK_DST_TEXT);   // A3: the managers check it against Caspit; the person sees nothing new
  return out.join('');
}

function clockPairEl(p, current, fixable, onFix, forMgr) {
  var st = clockAt(p, 'start'), en = clockAt(p, 'end');
  var row = mgrEl('div', 'clock-pair' + (p.status === 'void' ? ' void' : ''));
  var hrs = p.status === 'closed' ? ' · <b>' + clockNum(p.hours) + '</b> ש׳' : '';
  row.appendChild(mgrEl('div', 'clock-pair-t', '<bdi>' + clockDM(p.date || st) + '</bdi> · ' + esc(p.label) + ' · <bdi>' + clockHM(st) + '–' + (en ? clockHM(en) : '…') + '</bdi>' + hrs));
  var mk = clockMarks(p, current, forMgr);
  if (mk) row.appendChild(mgrEl('div', 'clock-marks', mk));
  if (fixable) {
    var b = mgrEl('button', 'btn btn-sm btn-secondary clock-fix'); b.type = 'button'; b.textContent = '✏️ תיקון';
    b.onclick = onFix;
    row.appendChild(b);
  }
  return row;
}

/** The hours by group (the server's fixed order first), a table of two columns. */
function clockGroupsEl(byGroup) {
  var bg = byGroup && typeof byGroup === 'object' ? byGroup : {};
  var keys = CLOCK_GROUPS.filter(function (g) { return Number(bg[g]) > 0; })
    .concat(Object.keys(bg).filter(function (g) { return CLOCK_GROUPS.indexOf(g) === -1 && Number(bg[g]) > 0; }));
  if (!keys.length) return null;
  var t = mgrEl('table', 'mgr-staff-hrs clock-groups');
  keys.forEach(function (g) { t.appendChild(mgrEl('tr', '', '<td>' + esc(g) + '</td><td><bdi>' + clockNum(bg[g]) + '</bdi></td>')); });
  return t;
}

function clockMonthEl(box, m, title) {
  if (!m || typeof m !== 'object') return;
  var ym = clockYM(m.ym), openId = clockData && clockData.open ? clockData.open.pairId : '';
  box.appendChild(mgrEl('div', 'mgr-sub clock-month-h', esc(title) + (ym ? ' · <bdi>' + ym + '</bdi>' : '') + ' · סה״כ <b><bdi>' + clockNum(m.total) + '</bdi></b> שעות'));
  var g = clockGroupsEl(m.byGroup);
  if (g) box.appendChild(g);
  var pairs = clockList(m.pairs);
  if (!pairs.length) box.appendChild(mgrEl('div', 'mgr-line mgr-none', 'אין עדיין רישומים בחודש הזה.'));
  pairs.forEach(function (p) {
    box.appendChild(clockPairEl(p, !!openId && p.pairId === openId, clockEditable(p), function () { clockOpenSheet('fix', p.pairId); }));
  });
}

function renderClockHours() {
  var box = document.getElementById('clockHours');
  if (!box) return;
  box.innerHTML = '';
  if (!AppState.currentUserId) return;
  var d = clockData;
  if (!d) { box.appendChild(mgrEl('div', 'mgr-legend', clockState === 'loading' ? 'טוען…' : 'השעות לא נטענו — ↻ בכרטיס השעון.')); return; }
  clockMonthEl(box, d.month, 'החודש');
  var add = mgrEl('button', 'btn btn-secondary clock-add'); add.type = 'button'; add.textContent = '＋ שכחתי לסמן משמרת';
  add.onclick = function () { clockOpenSheet('add'); };
  box.appendChild(add);
  if (d.prevMonth && typeof d.prevMonth === 'object') clockMonthEl(box, d.prevMonth, 'החודש הקודם');
  box.appendChild(mgrEl('div', 'mgr-legend clock-pilot', 'כל תיקון נשלח למנהל לאישור, והרישום המקורי נשמר. השעון רץ לצד כספית — התשלום עדיין לפי כספית.'));
}

/* ---- the sheet: what to clock in for, a switch, a correction, a forgotten shift ---- */
function clockOpenSheet(mode, pairId) {
  clockSheet = { mode: mode, pairId: pairId || '' };
  clockNoteFor = ''; clockFixErr = null;
  if (mode === 'fix') clockDraft.fix = clockFormDraft();
  if (mode === 'add') { clockDraft.add = clockFormDraft(); clockDraft.add.date = clockData && clockData.today ? String(clockData.today) : clockNowText().slice(0, 10); }
  renderClockSheet();
}

function closeClockSheet() {
  clockSheet = null; clockNoteFor = '';
  renderClockSheet();
}

/**
 * The choices by group (plan, shifts, chugs, events, extras), each once. o.skip(c) leaves one out (the current one on a switch),
 * o.sel = the key picked in a form, o.noteFor = the key whose note field is open, o.dr = the draft the note is typed into,
 * o.onPick(c), o.noteGo = the button under the note (a tap) or null (a form), o.disabled.
 */
function clockChoicesEl(parent, choices, o) {
  var ch = choices && typeof choices === 'object' ? choices : {}, seen = {}, n = 0;
  CLOCK_CHOICE_GROUPS.forEach(function (g) {
    var items = clockList(ch[g[0]]).filter(function (c) {
      var k = clockKey(c);
      if (!c.purpose || seen[k] || (o.skip && o.skip(c))) return false;
      seen[k] = 1;
      return true;
    });
    if (!items.length) return;
    parent.appendChild(mgrEl('div', 'mgr-gh', esc(g[1])));
    items.forEach(function (c) {
      n++;
      var k = clockKey(c);
      var b = mgrEl('button', 'mgr-cand clock-choice' + (o.sel === k ? ' sug' : ''), '<b>' + (o.sel === k ? '✓ ' : '') + clockChoiceHtml(c) + '</b>' +
        (c.group && c.group !== c.label ? '<div class="mgr-why">' + esc(c.group) + '</div>' : '')); b.type = 'button';
      b.disabled = !!o.disabled;
      b.onclick = function () { if (o.disabled) return; o.onPick(c); };
      parent.appendChild(b);
      if (o.noteFor === k) {
        var dr = o.dr, inp = mgrToolInput('clock-note', 'על מה? (2–80 תווים)', 80, 'text', function () { return dr.note; }, function (x) { dr.note = x; });
        parent.appendChild(inp);
        if (clockNoteFocus === true && o.noteGo) clockNoteFocus = inp;
        if (o.noteGo) parent.appendChild(o.noteGo(c));
      }
    });
  });
  if (!n) parent.appendChild(mgrEl('div', 'mgr-line mgr-none clock-nochoice', 'הבחירות עוד לא נטענו — ↻ בכרטיס השעון.'));
}

/** The kind chips, the value, the reason — the correction form of a pair (the person's sheet and the manager's person sheet). */
function clockFixFormEl(parent, dr, p, choices, busy, err, onGo, redraw) {
  var st = clockAt(p, 'start'), en = clockAt(p, 'end');
  parent.appendChild(mgrEl('div', 'mgr-legend clock-fix-now', 'עכשיו: ' + esc(p.label) + ' · <bdi>' + clockHM(st) + '–' + (en ? clockHM(en) : '…') + '</bdi>'));
  var kinds = mgrEl('div', 'mgr-days clock-kinds');
  CLOCK_FIX_KINDS.forEach(function (k) {
    var on = dr.kind === k[0];
    var c = mgrEl('button', 'mgr-chip mgr-tool-chip clock-kind clock-kind-' + k[0] + (on ? ' on' : '')); c.type = 'button'; c.textContent = k[1];
    c.setAttribute('aria-pressed', on ? 'true' : 'false');
    c.onclick = function () { dr.kind = k[0]; redraw(); };
    kinds.appendChild(c);
  });
  parent.appendChild(kinds);
  if (dr.kind === 'end' || dr.kind === 'start') {
    var row = mgrEl('div', 'mgr-day-times');
    row.appendChild(mgrEl('label', 'mgr-day-lbl', dr.kind === 'end' ? 'יצאתי ב-' : 'נכנסתי ב-'));
    row.appendChild(mgrToolInput('clock-fix-time', 'HH:MM', 5, 'time', function () { return dr.time; }, function (x) { dr.time = x; }));
    parent.appendChild(row);
  } else if (dr.kind === 'purpose') {
    clockChoicesEl(parent, choices, { sel: dr.pick, noteFor: clockNeedsNote(clockChoiceOf(choices, dr.pick)) ? dr.pick : '', dr: dr, noteGo: null,
      onPick: function (c) { dr.pick = clockKey(c); redraw(); } });
  } else if (dr.kind === 'void') {
    parent.appendChild(mgrEl('div', 'mgr-legend clock-void-note', 'המשמרת תיספר כ-0 שעות אחרי אישור. הרישום עצמו נשאר.'));
  }
  clockReasonEl(parent, dr);
  clockGoEl(parent, busy, err, onGo);
}

/** The forgotten-shift form: date (inside the window), from, to, what it was, the reason. */
function clockAddFormEl(parent, dr, win, choices, busy, err, onGo, redraw) {
  parent.appendChild(mgrEl('div', 'mgr-legend clock-add-win', 'אפשר להוסיף מ-<bdi>' + clockDM(win.from) + '</bdi> עד <bdi>' + clockDM(win.to) + '</bdi>.'));
  var dt = mgrToolInput('clock-add-date', '', 10, 'date', function () { return dr.date; }, function (x) { dr.date = x; });
  if (win.from) dt.min = win.from;
  if (win.to) dt.max = win.to;
  parent.appendChild(dt);
  var row = mgrEl('div', 'mgr-day-times');
  row.appendChild(mgrEl('label', 'mgr-day-lbl', 'מ-'));
  row.appendChild(mgrToolInput('clock-add-from', 'HH:MM', 5, 'time', function () { return dr.from; }, function (x) { dr.from = x; }));
  row.appendChild(mgrEl('label', 'mgr-day-lbl', 'עד'));
  row.appendChild(mgrToolInput('clock-add-to', 'HH:MM', 5, 'time', function () { return dr.to; }, function (x) { dr.to = x; }));
  parent.appendChild(row);
  parent.appendChild(mgrEl('div', 'mgr-sub', 'על מה?'));
  clockChoicesEl(parent, choices, { sel: dr.pick, noteFor: clockNeedsNote(clockChoiceOf(choices, dr.pick)) ? dr.pick : '', dr: dr, noteGo: null,
    onPick: function (c) { dr.pick = clockKey(c); redraw(); } });
  clockReasonEl(parent, dr);
  clockGoEl(parent, busy, err, onGo);
}

function clockReasonEl(parent, dr) {
  parent.appendChild(mgrToolInput('clock-reason', 'סיבה (3–200 תווים)', 200, 'text', function () { return dr.reason; }, function (x) { dr.reason = x; }));
}

/** busy: 'mine' (this form's request is on its way: the hourglass) | 'other' (another one is) | ''. */
function clockGoEl(parent, busy, err, onGo) {
  if (err) parent.appendChild(mgrEl('div', 'mgr-note clock-fix-err', '⚠️ ' + esc(err)));
  var go = mgrEl('button', 'btn clock-fix-go'); go.type = 'button';
  go.textContent = busy === 'mine' ? MGR_BUSY : 'שלח לאישור';
  go.disabled = !!busy;
  go.onclick = function () { if (!go.disabled) onGo(); };
  parent.appendChild(go);
}

/** The editable window of the person: from the server's editable.from to today. */
function clockWindow() {
  var d = clockData || {};
  return { from: d.editable && d.editable.from ? String(d.editable.from) : '', to: d.today ? String(d.today) : clockNowText().slice(0, 10) };
}

function renderClockSheet() {
  var box = document.getElementById('clockSheet');
  if (!box) return;
  box.innerHTML = '';
  var ctx = clockSheet, pair = ctx && ctx.mode === 'fix' ? clockPairById(ctx.pairId) : null;
  if (!ctx || !AppState.currentUserId || (ctx.mode === 'fix' && (!pair || (!clockEditable(pair) && clockFixBusy !== 'fix:' + ctx.pairId)))) {
    clockSheet = null; box.style.display = 'none'; return;   // gone from a fresh answer, taken, or logged out: the sheet closes
  }
  box.style.display = 'flex';
  box.onclick = function (e) { if (e && e.target === box) closeClockSheet(); };   // a tap outside the sheet closes it
  var sheet = mgrEl('div', 'mgr-sheet clock-sheet');
  var title = ctx.mode === 'pick' ? '▶ כניסה — על מה?' : ctx.mode === 'switch' ? '🔁 עברתי ל…' : ctx.mode === 'add' ? '＋ שכחתי לסמן משמרת' :
    '✏️ תיקון · <bdi>' + clockDM(pair.date || clockAt(pair, 'start')) + '</bdi> · ' + esc(pair.label);
  var head = mgrEl('div', 'mgr-sheet-h', '<b>' + title + '</b>');
  var xb = mgrEl('button', 'mgr-x clock-x'); xb.type = 'button'; xb.textContent = '✕'; xb.setAttribute('aria-label', 'סגור');
  xb.onclick = closeClockSheet;
  head.appendChild(xb);
  sheet.appendChild(head);
  var choices = clockData && clockData.choices;
  var anyDay = clockData && (clockData.choicesAny || clockData.choices);   // a correction / a forgotten shift: any day of the window
  if (ctx.mode === 'pick' || ctx.mode === 'switch') {
    var cur = ctx.mode === 'switch' ? clockView().open : null;
    clockChoicesEl(sheet, choices, {
      skip: cur ? function (c) { return cur.purpose ? clockKey(c) === clockKey(cur) : String(c.label) === String(cur.label); } : null,
      sel: '', noteFor: clockNoteFor, dr: clockDraft.tap, disabled: !!clockSending,
      onPick: function (c) { clockChoose(c); },
      noteGo: function (c) {
        return clockBtn('btn clock-note-go', '▶ כניסה', function () {
          var note = mgrFold(clockDraft.tap.note), np = clockNoteProblem(c, note);
          if (np) { showToast(np, 'error'); return; }
          clockTap('clockIn', { purpose: String(c.purpose), ref: String(c.ref == null ? '' : c.ref), note: note }, String(c.label || '') + ' · ' + note);
        });
      }
    });
    if (ctx.mode === 'switch') sheet.appendChild(mgrEl('div', 'mgr-legend', 'לחיצה אחת: היציאה ממה שעכשיו והכניסה לחדש נרשמות באותה דקה.'));
  } else if (ctx.mode === 'fix') {
    var tag = 'fix:' + ctx.pairId;
    clockFixFormEl(sheet, clockDraft.fix, pair, anyDay, clockFixBusy === tag ? 'mine' : clockFixBusy ? 'other' : '', clockFixErr && clockFixErr.at === tag ? clockFixErr.text : '', function () {
      var b = clockFixBody(clockDraft.fix, pair, anyDay);
      if (b.err) { clockFixFail(tag, b.err); return; }
      clockFixRun(tag, b.body);
    }, renderClockSheet);
  } else {
    clockAddFormEl(sheet, clockDraft.add, clockWindow(), anyDay, clockFixBusy === 'add' ? 'mine' : clockFixBusy ? 'other' : '', clockFixErr && clockFixErr.at === 'add' ? clockFixErr.text : '', function () {
      var b = clockAddBody(clockDraft.add, clockWindow(), anyDay);
      if (b.err) { clockFixFail('add', b.err); return; }
      clockFixRun('add', b.body);
    }, renderClockSheet);
  }
  box.appendChild(sheet);
  if (clockNoteFocus && clockNoteFocus !== true) { var f = clockNoteFocus; try { f.scrollIntoView({ block: 'center' }); f.focus(); } catch (e) {} }
  clockNoteFocus = null;
}

/* ---- the timers: the minutes tick only while they can be seen; the resend runs while a tap waits ---- */
function clockTimersSync() {
  var on = !!AppState.currentUserId, tab = document.getElementById('tabMyShifts');
  var tick = on && !document.hidden && !(tab && tab.style.display === 'none') && !!clockView().open;
  if (tick && !clockTickT) clockTickT = setInterval(clockTickRun, CLOCK_TICK_MS);
  else if (!tick && clockTickT) { clearInterval(clockTickT); clockTickT = 0; }
  var resend = on && clockQ.length > 0 && !clockQ[0].stuck;   // R3: a tap that waits for "↻ שלח שוב" is not sent by the timer
  if (resend && !clockResendT) clockResendT = setInterval(clockFlush, CLOCK_RESEND_MS);
  else if (!resend && clockResendT) { clearInterval(clockResendT); clockResendT = 0; }
}

function clockTickRun() {
  if (clockElapsedEl) clockElapsedEl.textContent = clockElapsedText(clockView().open);
}

window.addEventListener('online', function () { clockFlush(); });
document.addEventListener('visibilitychange', function () {
  clockTimersSync();
  if (!document.hidden) { clockTickRun(); clockFlush(); }
});

/* ==================================================================
   Stage 10: the manager's fold "⏱ נוכחות" — who is at work now, who forgot to leave (all people), the correction requests, and
   the month: every person's hours by group beside Caspit and the chugim (DND). Asked on the fold's first open after a login
   (never fetched ahead) and kept in memory only — other people's hours never go to the phone's storage. A tap on a person opens
   that person's sheet (mgrClockPerson): the pairs with their history, the days against Caspit and DND, and the actions (fix,
   cancel, add, in / out for them). One write at a time, no automatic retry (it may have landed: the screen is read again).
   ================================================================== */
var mgrClk = null;           // the last mgrClock answer (memory only)
var mgrClkState = '';        // '' | 'loading' | 'error'
var mgrClkErr = '';          // the last failed read, said at the top of the fold
var mgrClkWriteErr = '';     // the last failed write (the server's words), said in the fold and in the open sheet
var mgrClkSeq = 0;           // only the latest read is drawn
var mgrClkLoaded = false;    // the fold asked once since the login: opening it again does not ask again (↻ does)
var mgrClkBusy = '';         // the tag of the write on its way ('' = none): its button shows the hourglass, every write button is disabled
var mgrClkInline = null;     // the form open in the fold: {kind: 'close'|'reject', id}
var mgrClkCtx = null;        // the open sheet: {mode: 'person', empId, name, ym} or {mode: 'people'}
var mgrClkP = null;          // the last mgrClockPerson answer of the open sheet
var mgrClkPState = '';       // '' | 'loading' | 'error'
var mgrClkPErr = '';
var mgrClkPSeq = 0;
var mgrClkForm = null;       // the form open in the person sheet: {kind: 'fix'|'add'|'in'|'out', pairId}
var mgrClkDraft = null;      // what is typed in the fold's and the sheet's forms (survives a redraw)
var mgrClkTap = null;        // {key, id}: the tapId of a correction that got no answer (the same correction again goes with it)
var mgrClkSheetScroll = 0;   // the sheet's scroll position, kept over a redraw
var MGR_CLK_TEST = 'EMP-999';   // the test row: clocks like anyone, listed apart
var MGR_CLK_FEED_OLD_H = 36;    // a Caspit feed older than this is said to be old
var MGR_CLK_DIFF = 0.5;         // a difference of at least this many hours is marked
var MGR_CLK_NO_ANSWER = 'לא התקבלה תשובה מהשרת. ייתכן שנשמר — המסך נטען מחדש: לבדוק בו לפני שמנסים שוב.';

function mgrClkDraftNew() { return { inline: { time: '', reason: '' }, form: clockFormDraft() }; }
mgrClkDraft = mgrClkDraftNew();

/** Login / logout: the screen, the sheet and the fold belong to the previous user. The fold is closed, so the next open asks again. */
function mgrClockReset() {
  mgrClk = null; mgrClkState = ''; mgrClkErr = ''; mgrClkWriteErr = ''; mgrClkSeq++; mgrClkLoaded = false; mgrClkBusy = '';
  mgrClkInline = null; mgrClkCtx = null; mgrClkP = null; mgrClkPState = ''; mgrClkPErr = ''; mgrClkPSeq++; mgrClkForm = null;
  mgrClkDraft = mgrClkDraftNew(); mgrClkTap = null;
  var fold = document.getElementById('mgrDetClock');
  if (fold) fold.open = false;   // closed: the next manager's first open asks again
  renderMgrClock();
  renderMgrClockSheet();   // the sheet is position:fixed — emptying it is not enough, it must be hidden
}

/** The fold asks on its first open after a login (details.ontoggle); later opens show what is in memory. */
function mgrClockHook() {
  var det = document.getElementById('mgrDetClock');
  if (!det) return;
  det.ontoggle = function () { if (det.open && !mgrClkLoaded) loadMgrClock(); };
}

function loadMgrClock() {
  if (mgrClkBusy) return;   // a write is on its way: its answer asks again
  var gen = loginGen, seq = ++mgrClkSeq;
  mgrClkLoaded = true; mgrClkState = 'loading';
  renderMgrClock();
  api('mgrClock', {}, { ms: 45000 }).then(function (r) {
    if (gen !== loginGen || seq !== mgrClkSeq) return;   // logged out meanwhile (shared phone), or a newer answer is coming
    if (r && r.success) {
      mgrClk = r; mgrClkState = ''; mgrClkErr = '';
      if (mgrClkWriteErr === MGR_CLK_NO_ANSWER) mgrClkWriteErr = '';   // the screen after a write with no answer is the truth now
    } else if (r && r.transport && mgrClk) {   // no answer: what is on screen stays, and says so
      mgrClkState = 'error'; mgrClkErr = 'לא התקבלה תשובה מהשרת — מוצג מה שנטען קודם. ↻ לנסות שוב.';
    } else {   // the server said no (or no answer and nothing to show): nothing of an older answer stays on screen
      mgrClk = null; mgrClkState = 'error';
      mgrClkErr = r && r.transport ? 'כשל בתקשורת מול השרת — ↻ לנסות שוב.' : 'שגיאה: ' + String(r && r.error ? r.error : 'תשובה לא תקינה מהשרת');
    }
    renderMgrClock();
    renderMgrClockSheet();
  });
}

function loadMgrClockPerson() {
  var ctx = mgrClkCtx;
  if (!ctx || ctx.mode !== 'person') return;
  var gen = loginGen, seq = ++mgrClkPSeq;
  mgrClkPState = 'loading';
  renderMgrClockSheet();
  api('mgrClockPerson', { empId: ctx.empId, ym: ctx.ym }, { ms: 45000 }).then(function (r) {
    if (gen !== loginGen || seq !== mgrClkPSeq || mgrClkCtx !== ctx) return;
    if (r && r.success) { mgrClkP = r; mgrClkPState = ''; mgrClkPErr = ''; }
    else if (r && r.transport && mgrClkP) { mgrClkPState = 'error'; mgrClkPErr = 'לא התקבלה תשובה מהשרת — מוצג מה שנטען קודם.'; }
    else {
      mgrClkP = null; mgrClkPState = 'error';
      mgrClkPErr = r && r.transport ? 'כשל בתקשורת מול השרת.' : 'שגיאה: ' + String(r && r.error ? r.error : 'תשובה לא תקינה מהשרת');
    }
    renderMgrClockSheet();
  });
}

/* ---- small helpers ---- */
/** A write button: its own class (tests find it), disabled while any write runs, the hourglass while ITS write runs. */
function mgrClkBtn(cls, text, tag, fn) {
  var b = mgrEl('button', cls); b.type = 'button';
  b.disabled = !!mgrClkBusy;
  b.textContent = tag && mgrClkBusy === tag ? MGR_BUSY : text;
  b.onclick = function () { if (mgrClkBusy) return; fn(); };
  return b;
}
function mgrClkSec(box, title, cls) {
  var s = mgrEl('div', 'mgr-clk-sec ' + cls);
  s.appendChild(mgrEl('div', 'mgr-sub', title));
  box.appendChild(s);
  return s;
}
/** A request's side ("כניסה 16:00 · יציאה 22:00 · סגירה"), escaped; '—' when it says nothing. */
function mgrClkSide(x) {
  if (!x || typeof x !== 'object') return '—';
  var bits = [];
  if (x.start) bits.push('כניסה <bdi>' + clockDM(x.start) + (clockDM(x.start) ? ' ' : '') + clockHM(x.start) + '</bdi>');
  if (x.end) bits.push('יציאה <bdi>' + clockHM(x.end) + '</bdi>');
  if (x.label) bits.push(esc(x.label));
  return bits.join(' · ') || '—';
}
/** Clock minus Caspit, signed, or '' when there is no Caspit figure. */
function mgrClkDiff(total, caspit) {
  var t = Number(total), c = Number(caspit);
  if (caspit == null || caspit === '' || !isFinite(t) || !isFinite(c)) return '';
  var d = Math.round((t - c) * 100) / 100;
  return (d > 0 ? '+' : d < 0 ? '−' : '') + mgrStaffNum(Math.abs(d));
}
function mgrClkDndTotal(x) { return x && typeof x === 'object' ? x.total : x; }

/* ---- the fold ---- */
function renderMgrClock() {
  var box = document.getElementById('mgrClock');
  if (!box) return;
  box.innerHTML = '';
  var d = mgrClk, loading = mgrClkState === 'loading';
  var top = mgrEl('div', 'mgr-staff-top');
  top.appendChild(mgrEl('span', 'mgr-legend mgr-staff-asof mgr-clk-asof', d && d.now ? 'נכון ל-<bdi>' + clockWhen(d.now) + '</bdi>' : (loading ? 'טוען את הנוכחות…' : '')));
  var rl = mgrEl('button', 'btn btn-sm btn-secondary mgr-staff-reload mgr-clk-reload'); rl.type = 'button';
  rl.textContent = loading ? MGR_BUSY : '↻';
  rl.setAttribute('aria-label', 'טען שוב את הנוכחות');
  rl.disabled = loading || !!mgrClkBusy;
  rl.onclick = function () { if (mgrClkState === 'loading' || mgrClkBusy) return; loadMgrClock(); };
  top.appendChild(rl);
  box.appendChild(top);
  if (mgrClkErr) box.appendChild(mgrEl('div', 'mgr-note mgr-clk-err', '⚠️ ' + esc(mgrClkErr)));
  if (mgrClkWriteErr) box.appendChild(mgrEl('div', 'mgr-note mgr-clk-werr', '⚠️ ' + esc(mgrClkWriteErr)));
  if (!d) {
    if (loading) for (var i = 0; i < 3; i++) box.appendChild(mgrEl('div', 'mgr-skel mgr-staff-skel'));
    return;
  }
  box.appendChild(mgrEl('div', 'mgr-legend mgr-clk-pilot', 'השעון רץ לצד כספית ולצד החוגים: משווה ואומר כל הפרש. התשלום עדיין לפי כספית, עד החלטת הבעלים.'));
  mgrClkFeedEl(box, d);
  (Array.isArray(d.notes) ? d.notes : []).filter(function (n) { return mgrFold(n); }).forEach(function (n) { box.appendChild(mgrEl('div', 'mgr-legend mgr-clk-note', 'ℹ️ ' + esc(n))); });

  var inNow = clockList(d.inNow), s1 = mgrClkSec(box, '🟢 עכשיו בעבודה (' + inNow.length + ')', 'mgr-clk-in');
  if (!inNow.length) s1.appendChild(mgrEl('div', 'mgr-line mgr-none', 'אף אחד לא סימן כניסה.'));
  inNow.forEach(function (x) {
    var b = mgrEl('button', 'mgr-cand mgr-clk-inrow', '<b>' + esc(x.name) + '</b> · ' + esc(x.label) + ' · מ-<bdi>' + clockHM(x.start) + '</bdi> · <bdi>' + clockDur(x.minutes) + '</bdi>' +
      (x.dst === true ? ' · ⚠️ ' + CLOCK_DST_TEXT : '')); b.type = 'button';
    b.onclick = function () { mgrClockOpen({ mode: 'person', empId: String(x.empId || ''), name: String(x.name || ''), ym: mgrClkYm(d.month) }); };
    s1.appendChild(b);
  });

  var stale = clockList(d.stale), s2 = mgrClkSec(box, '⚠️ חסרה יציאה (' + stale.length + ')', 'mgr-clk-stale');
  if (!stale.length) s2.appendChild(mgrEl('div', 'mgr-line mgr-none', 'אין ✓'));
  stale.forEach(function (p) { s2.appendChild(mgrClkStaleEl(p)); });

  var reqs = clockList(d.requests), s3 = mgrClkSec(box, '✏️ בקשות תיקון (' + reqs.length + ')', 'mgr-clk-reqs');
  if (!reqs.length) s3.appendChild(mgrEl('div', 'mgr-line mgr-none', 'אין בקשות ✓'));
  reqs.forEach(function (q) { s3.appendChild(mgrClkReqEl(q)); });

  if (d.month && typeof d.month === 'object') box.appendChild(mgrClkMonthEl(d.month, '📊 החודש'));
  if (d.prevMonth && typeof d.prevMonth === 'object') box.appendChild(mgrClkMonthEl(d.prevMonth, '📊 החודש הקודם'));
  if (clockList(d.people).length) {
    var pb = mgrEl('button', 'btn btn-secondary mgr-clk-for'); pb.type = 'button'; pb.textContent = '👤 פעולה בשם עובד…';
    pb.onclick = function () { mgrClockOpen({ mode: 'people' }); };
    box.appendChild(pb);
  }
}

function mgrClkYm(m) { return m && typeof m === 'object' && m.ym ? String(m.ym) : ''; }

/** The Caspit feed: how old, which Caspit names are nobody's (rule 8ז: a feed that is not there is said, never shown as zero). */
function mgrClkFeedEl(box, d) {
  var f = d.caspitFeed;
  if (!f || typeof f !== 'object') { box.appendChild(mgrEl('div', 'mgr-note mgr-clk-feed none', 'ℹ️ שעות מכספית עוד לא מחוברות — עמודות כספית ריקות.')); return; }
  if (f.ok === false) { box.appendChild(mgrEl('div', 'mgr-note mgr-clk-feed bad', '⚠️ שעות מכספית לא נקראו — עמודות כספית לא ידועות.')); return; }
  var age = (clockMs(d.now) - clockMs(f.at || f.asOf)) / 3600000, old = f.fresh === false || (isFinite(age) && age > MGR_CLK_FEED_OLD_H);
  box.appendChild(mgrEl('div', (old ? 'mgr-note' : 'mgr-legend') + ' mgr-clk-feed' + (old ? ' old' : ''), (old ? '⚠️ ' : '') + 'כספית: נכון ל-<bdi>' + clockWhen(f.asOf) + '</bdi>' +
    (isFinite(age) && age >= 0 ? ' (לפני <bdi>' + Math.round(age) + '</bdi> שעות)' : '')));
  var un = Array.isArray(f.unmatched) ? f.unmatched.filter(function (n) { return mgrFold(n); }) : [];
  if (un.length) box.appendChild(mgrEl('div', 'mgr-note mgr-clk-unmatched', '⚠️ שמות בכספית שלא זוהו (' + un.length + '): ' + un.map(esc).join(', ') + ' — השעות שלהם לא בטבלה.'));
}

/** A missing exit of anyone: "סגור ב…" opens a time and a reason under it (a correction written for the person, approved at once). */
function mgrClkStaleEl(p) {
  var st = clockAt(p, 'start'), id = String(p.pairId || ''), tag = 'close:' + id;
  var w = mgrEl('div', 'mgr-clk-row');
  w.appendChild(mgrEl('div', 'mgr-clk-rowt', '<b>' + esc(p.name) + '</b> · <bdi>' + clockDM(st) + '</bdi> · ' + esc(p.label) + ' · נכנס <bdi>' + clockHM(st) + '</bdi>'));
  if (p.dst === true) w.appendChild(mgrEl('div', 'mgr-legend mgr-clk-dst', '⚠️ ' + CLOCK_DST_TEXT));
  if (p.pending && typeof p.pending === 'object') { w.appendChild(mgrEl('div', 'mgr-legend mgr-clk-stale-pend', '⏳ בקשה ממתינה: ' + clockPendText(p.pending) + ' — לאשר / לדחות בבקשות התיקון למטה.')); return w; }
  if (p.locked === true) { w.appendChild(mgrEl('div', 'mgr-legend mgr-clk-stale-locked', 'מחוץ לחלון התיקון — לא נסגר מכאן (נשאר לסגירת החודש).')); return w; }
  var on = !!mgrClkInline && mgrClkInline.kind === 'close' && mgrClkInline.id === id;
  if (!on) {
    w.appendChild(mgrClkBtn('btn btn-sm btn-secondary mgr-clk-close', 'סגור ב…', '', function () { mgrClkInlineOpen('close', id); }));
    return w;
  }
  var dr = mgrClkDraft.inline, row = mgrEl('div', 'mgr-day-times');
  row.appendChild(mgrEl('label', 'mgr-day-lbl', 'יצא ב-'));
  row.appendChild(mgrToolInput('mgr-clk-time', 'HH:MM', 5, 'time', function () { return dr.time; }, function (x) { dr.time = x; }));
  w.appendChild(row);
  w.appendChild(mgrToolInput('mgr-clk-reason', 'סיבה (3–200 תווים)', 200, 'text', function () { return dr.reason; }, function (x) { dr.reason = x; }));
  var acts = mgrEl('div', 'mgr-acts');
  acts.appendChild(mgrClkBtn('btn btn-sm mgr-clk-close-go', 'סגור', tag, function () {
    var b = clockFixBody({ kind: 'end', time: dr.time, reason: dr.reason }, p, null);
    if (b.err) { mgrClkFail(b.err); return; }
    mgrClkRun(tag, 'mgrClockFix', Object.assign({ empId: String(p.empId || '') }, b.body), 'היציאה נרשמה ✓');
  }));
  acts.appendChild(mgrClkBtn('btn btn-sm btn-secondary mgr-clk-cancel', 'ביטול', '', function () { mgrClkInline = null; renderMgrClock(); }));
  w.appendChild(acts);
  return w;
}

/** A correction request: before → after, the reason; approve (one confirm) or reject (a reason). The manager's own: another manager decides. */
function mgrClkReqEl(q) {
  var id = String(q.reqId || ''), k = String(q.kind || '');
  var w = mgrEl('div', 'mgr-clk-row mgr-clk-req');
  w.appendChild(mgrEl('div', 'mgr-clk-rowt', '<b>' + esc(q.name) + '</b> · ' + esc(CLOCK_KIND_LABEL[k] || k) + (q.at ? ' · <bdi>' + clockWhen(q.at) + '</bdi>' : '')));
  w.appendChild(mgrEl('div', 'mgr-legend mgr-clk-ba', 'לפני: ' + mgrClkSide(q.before) + '<br>אחרי: ' + mgrClkSide(q.after)));
  if (mgrFold(q.reason)) w.appendChild(mgrEl('div', 'mgr-legend mgr-clk-why', 'סיבה: ' + esc(q.reason)));
  if (q.own === true) { w.appendChild(mgrEl('div', 'mgr-legend mgr-clk-own', 'שלך — מנהל אחר מאשר')); return w; }
  var on = !!mgrClkInline && mgrClkInline.kind === 'reject' && mgrClkInline.id === id;
  var acts = mgrEl('div', 'mgr-acts');
  if (!on) {
    acts.appendChild(mgrClkBtn('btn btn-sm mgr-clk-ok', '✓ אשר', 'ok:' + id, function () {
      openAppModal('✓ אישור בקשה', String(q.name || '') + ' — ' + (CLOCK_KIND_LABEL[k] || k) + '.\nלאשר? הרישום המקורי נשמר, והתיקון נרשם בשמך.', false, 'אשר', function () {
        mgrClkRun('ok:' + id, 'mgrClockDecide', { reqId: id, approve: true, reason: '' }, 'אושר ✓');
      });
    }));
    acts.appendChild(mgrClkBtn('btn btn-sm btn-secondary mgr-clk-no', '✖ דחה', '', function () { mgrClkInlineOpen('reject', id); }));
    w.appendChild(acts);
    return w;
  }
  var dr = mgrClkDraft.inline;
  w.appendChild(mgrToolInput('mgr-clk-reason', 'למה לדחות? (3–200 תווים)', 200, 'text', function () { return dr.reason; }, function (x) { dr.reason = x; }));
  acts.appendChild(mgrClkBtn('btn btn-sm mgr-clk-no-go', 'דחה', 'no:' + id, function () {
    var reason = mgrFold(dr.reason), rp = clockReasonProblem(reason);
    if (rp) { mgrClkFail(rp); return; }
    mgrClkRun('no:' + id, 'mgrClockDecide', { reqId: id, approve: false, reason: reason }, 'נדחה');
  }));
  acts.appendChild(mgrClkBtn('btn btn-sm btn-secondary mgr-clk-cancel', 'ביטול', '', function () { mgrClkInline = null; renderMgrClock(); }));
  w.appendChild(acts);
  return w;
}

function mgrClkInlineOpen(kind, id) {
  mgrClkInline = { kind: kind, id: id };
  mgrClkDraft.inline = { time: '', reason: '' };
  mgrClkWriteErr = '';
  renderMgrClock();
}

/** The month: a person per row × the groups that have hours, the clock's total, Caspit, the difference, DND. Sideways scroll inside the fold. */
function mgrClkMonthEl(m, title) {
  var w = mgrEl('div', 'mgr-clk-month');
  var ym = clockYM(m.ym), people = clockList(m.people), totals = m.totals && typeof m.totals === 'object' ? m.totals : {};
  var tbg = totals.byGroup && typeof totals.byGroup === 'object' ? totals.byGroup : {};
  var groups = (Array.isArray(m.groups) ? m.groups : CLOCK_GROUPS).filter(function (g) {
    return Number(tbg[g]) > 0 || people.some(function (p) { return p.byGroup && Number(p.byGroup[g]) > 0; });
  });
  w.appendChild(mgrEl('div', 'mgr-sub mgr-clk-month-h', esc(title) + (ym ? ' · <bdi>' + ym + '</bdi>' : '')));
  var real = people.filter(function (p) { return p.empId !== MGR_CLK_TEST; }), test = people.filter(function (p) { return p.empId === MGR_CLK_TEST; });
  if (!real.length) w.appendChild(mgrEl('div', 'mgr-line mgr-none', 'אין עדיין שעות בשעון בחודש הזה.'));
  else w.appendChild(mgrClkTableEl(real, groups, totals, m));
  if (test.length) {
    w.appendChild(mgrEl('div', 'mgr-gh mgr-clk-test-h', '🧪 בדיקה — לא חלק מהצוות'));
    w.appendChild(mgrClkTableEl(test, groups, null, m));
  }
  var dstP = people.filter(function (p) { return Number(p.dst) > 0; });   // A3: pairs of the night the clocks go back, per person
  if (dstP.length) w.appendChild(mgrEl('div', 'mgr-note mgr-clk-dstnote', '⚠️ ' + CLOCK_DST_TEXT + ': ' +
    dstP.map(function (p) { return esc(p.name) + ' (<bdi>' + Number(p.dst) + '</bdi>)'; }).join(', ') + '.'));
  w.appendChild(mgrEl('div', 'mgr-legend mgr-clk-key', 'הפרש = השעון פחות כספית (מסומן מ-' + MGR_CLK_DIFF + ' שעה). 🟢 בעבודה עכשיו · ⏳ בקשה ממתינה. הקשה על שם — הפירוט והפעולות.'));
  return w;
}

function mgrClkTableEl(rows, groups, totals, m) {
  var sc = mgrEl('div', 'mgr-clk-scroll');
  var t = mgrEl('table', 'mgr-clk-table');
  var h = mgrEl('tr');
  ['שם'].concat(groups).concat(['סה״כ', 'כספית', 'הפרש', 'DND']).forEach(function (x) { h.appendChild(mgrEl('th', '', esc(x))); });
  t.appendChild(h);
  rows.forEach(function (p) {
    var tr = mgrEl('tr', 'mgr-clk-tr');
    var td = mgrEl('td', 'mgr-clk-name');
    var b = mgrEl('button', 'mgr-clk-pbtn', esc(p.name) + (p.open ? ' 🟢' : '') + (Number(p.pending) > 0 ? ' ⏳' : '') + (Number(p.dst) > 0 ? ' ⚠️' : '')); b.type = 'button';
    b.onclick = function () { mgrClockOpen({ mode: 'person', empId: String(p.empId || ''), name: String(p.name || ''), ym: mgrClkYm(m) }); };
    td.appendChild(b);
    tr.appendChild(td);
    var bg = p.byGroup && typeof p.byGroup === 'object' ? p.byGroup : {};
    groups.forEach(function (g) { tr.appendChild(mgrEl('td', '', Number(bg[g]) > 0 ? clockNum(bg[g]) : '')); });
    var cas = p.caspit && typeof p.caspit === 'object' ? p.caspit.hours : null;
    mgrClkNumCells(tr, p.total, cas, mgrClkDndTotal(p.dnd));
    t.appendChild(tr);
  });
  if (totals) {
    var tt = mgrEl('tr', 'mgr-clk-total');
    tt.appendChild(mgrEl('td', '', '<b>סה״כ</b>'));
    var tbg = totals.byGroup && typeof totals.byGroup === 'object' ? totals.byGroup : {};
    groups.forEach(function (g) { tt.appendChild(mgrEl('td', '', '<b>' + clockNum(tbg[g]) + '</b>')); });
    mgrClkNumCells(tt, totals.total, totals.caspit, mgrClkDndTotal(totals.dnd));
    t.appendChild(tt);
  }
  sc.appendChild(t);
  return sc;
}

function mgrClkNumCells(tr, total, caspit, dnd) {
  var df = mgrClkDiff(total, caspit), big = !!df && Math.abs(Number(total) - Number(caspit)) >= MGR_CLK_DIFF;
  tr.appendChild(mgrEl('td', 'mgr-clk-tot', '<b>' + clockNum(total) + '</b>'));
  tr.appendChild(mgrEl('td', 'mgr-clk-cas', caspit == null ? '—' : clockNum(caspit)));
  tr.appendChild(mgrEl('td', 'mgr-clk-diff' + (big ? ' big' : ''), df ? '<bdi>' + df + '</bdi>' : '—'));
  tr.appendChild(mgrEl('td', 'mgr-clk-dnd', dnd == null ? '—' : clockNum(dnd)));
}

/* ---- the sheet: a person (or the list of people, for one with no hours yet) ---- */
function mgrClockOpen(ctx) {
  mgrClkCtx = ctx; mgrClkWriteErr = ''; mgrClkForm = null; mgrClkP = null; mgrClkPState = ''; mgrClkPErr = ''; mgrClkPSeq++;
  mgrClkSheetScroll = 0;
  renderMgrClockSheet();
  if (ctx.mode === 'person') loadMgrClockPerson();
}

function closeMgrClockSheet() {
  mgrClkCtx = null; mgrClkForm = null; mgrClkP = null; mgrClkPSeq++; mgrClkWriteErr = '';
  renderMgrClockSheet();
}

function renderMgrClockSheet() {
  var box = document.getElementById('mgrClockSheet');
  if (!box) return;
  box.innerHTML = '';
  var ctx = mgrClkCtx;
  if (!ctx || !mgrClk) { mgrClkCtx = null; box.style.display = 'none'; return; }   // logged out, or the screen is gone: the sheet closes
  box.style.display = 'flex';
  box.onclick = function (e) { if (e && e.target === box) closeMgrClockSheet(); };   // a tap outside the sheet closes it
  var sheet = mgrEl('div', 'mgr-sheet mgr-staffsheet mgr-clksheet');
  sheet.onscroll = function () { mgrClkSheetScroll = sheet.scrollTop; };
  var ym = ctx.mode === 'person' ? clockYM(ctx.ym) : '';
  var head = mgrEl('div', 'mgr-sheet-h', '<b>' + (ctx.mode === 'people' ? '👤 פעולה בשם עובד' : '👤 ' + esc(ctx.name || (mgrClkP && mgrClkP.name) || ctx.empId) + (ym ? ' · <bdi>' + ym + '</bdi>' : '')) + '</b>');
  var xb = mgrEl('button', 'mgr-x mgr-clk-x'); xb.type = 'button'; xb.textContent = '✕'; xb.setAttribute('aria-label', 'סגור');
  xb.onclick = closeMgrClockSheet;
  head.appendChild(xb);
  sheet.appendChild(head);
  if (mgrClkWriteErr) sheet.appendChild(mgrEl('div', 'mgr-note mgr-clk-serr', '⚠️ ' + esc(mgrClkWriteErr)));
  if (ctx.mode === 'people') mgrClkPeopleEl(sheet);
  else mgrClkPersonEl(sheet, ctx);
  box.appendChild(sheet);
  sheet.scrollTop = mgrClkSheetScroll;
}

/** Everyone active (the server's list), for a tap or a shift for someone who has no hours yet this month. */
function mgrClkPeopleEl(sheet) {
  sheet.appendChild(mgrEl('div', 'mgr-legend', 'לעובד ששכח את הטלפון: בוחרים אותו, ואז כניסה / יציאה בשמו או משמרת שנשכחה — עם סיבה.'));
  clockList(mgrClk.people).forEach(function (p) {
    var b = mgrEl('button', 'mgr-cand mgr-clk-pick', '<b>' + esc(p.name) + '</b>' + (p.empId === MGR_CLK_TEST ? ' <em class="mgr-staff-st">בדיקה</em>' : '')); b.type = 'button';
    b.onclick = function () { mgrClockOpen({ mode: 'person', empId: String(p.empId || ''), name: String(p.name || ''), ym: mgrClkYm(mgrClk.month) }); };
    sheet.appendChild(b);
  });
}

/** The person's open pair right now (from the person's answer, else from "עכשיו בעבודה"). */
function mgrClkIsIn(empId) {
  if (mgrClkP && clockList(mgrClkP.pairs).some(function (p) { return p.status === 'open' && !clockFlag(p, 'stale'); })) return true;
  return clockList(mgrClk && mgrClk.inNow).some(function (x) { return x.empId === empId; });
}

/** The window a manager may add a shift in for this month: its first day (or the server's window) to today. */
function mgrClkWindow(ym) {
  var today = clockData && clockData.today ? String(clockData.today) : clockTextOf(clockServerMs()).slice(0, 10);
  var first = /^\d{4}-\d{2}$/.test(String(ym || '')) ? ym + '-01' : today.slice(0, 8) + '01';
  var last = /^\d{4}-\d{2}$/.test(String(ym || '')) ? clockTextOf(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).slice(0, 10) : today;
  return { from: first, to: last < today ? last : today };
}

function mgrClkPersonEl(sheet, ctx) {
  var empId = ctx.empId, P = mgrClkP, form = mgrClkForm, dr = mgrClkDraft.form;
  var acts = mgrEl('div', 'mgr-acts mgr-clk-acts');
  var opener = function (kind, pairId) { return function () { mgrClkForm = { kind: kind, pairId: pairId || '' }; mgrClkDraft.form = clockFormDraft(); mgrClkWriteErr = ''; renderMgrClockSheet(); }; };
  acts.appendChild(mgrClkBtn('btn btn-sm mgr-clk-in-btn', '▶ כניסה בשמו', '', opener('in')));
  if (mgrClkIsIn(empId)) acts.appendChild(mgrClkBtn('btn btn-sm btn-secondary mgr-clk-out-btn', '⏹ יציאה בשמו', '', opener('out')));
  acts.appendChild(mgrClkBtn('btn btn-sm btn-secondary mgr-clk-add-btn', '＋ משמרת שנשכחה', '', opener('add')));
  sheet.appendChild(acts);

  if (form) mgrClkFormEl(sheet, ctx, form, dr);

  if (mgrClkPErr) sheet.appendChild(mgrEl('div', 'mgr-note mgr-clk-perr', '⚠️ ' + esc(mgrClkPErr)));
  if (!P) {
    if (mgrClkPState === 'loading') for (var i = 0; i < 2; i++) sheet.appendChild(mgrEl('div', 'mgr-skel mgr-staff-skel'));
    return;
  }
  var pairs = clockList(P.pairs), s1 = mgrStaffSec(sheet, '⏱ המשמרות (' + pairs.length + ')', 'mgr-clk-spairs');
  if (!pairs.length) s1.appendChild(mgrEl('div', 'mgr-line mgr-none', 'אין רישומים בחודש הזה.'));
  pairs.forEach(function (p) {
    var row = clockPairEl(p, p.status === 'open' && !clockFlag(p, 'stale'), false, null, true);
    if (p.status !== 'void' && p.status !== 'pending-add' && !p.pending) {   // one request per pair at a time (the server's rule)
      var pa = mgrEl('div', 'mgr-acts');
      pa.appendChild(mgrClkBtn('btn btn-sm btn-secondary mgr-clk-fix', '✏️ תקן', '', opener('fix', p.pairId)));
      row.appendChild(pa);
    }
    var hist = clockList(p.history);
    if (hist.length) {
      var hd = mgrEl('details', 'mgr-more mgr-clk-hist');
      hd.appendChild(mgrEl('summary', '', 'היסטוריה (' + hist.length + ')'));
      hist.forEach(function (h) { hd.appendChild(mgrEl('div', 'mgr-legend mgr-clk-h', mgrClkHistText(h))); });
      row.appendChild(hd);
    }
    s1.appendChild(row);
    if (form && form.kind === 'fix' && form.pairId === p.pairId) mgrClkFormEl(s1, ctx, form, dr, p);
  });

  var days = clockList(P.days), s2 = mgrStaffSec(sheet, '📅 לפי יום — שעון מול כספית וחוגים', 'mgr-clk-sdays');
  if (!days.length) { s2.appendChild(mgrEl('div', 'mgr-line mgr-none', 'אין ימים להשוות.')); return; }
  var sc = mgrEl('div', 'mgr-clk-scroll'), t = mgrEl('table', 'mgr-clk-table mgr-clk-days');
  t.appendChild(mgrEl('tr', '', '<th>יום</th><th>שעון</th><th>כספית</th><th>DND</th><th>הפרש</th>'));
  days.forEach(function (x) {
    var casH = x.caspitHours != null && x.caspitHours !== '' && isFinite(Number(x.caspitHours)) ? Number(x.caspitHours) : null;   // null: no feed of the month
    var cp = clockList(x.caspit).map(function (c) { return '<bdi>' + clockHM(c.tin) + '–' + clockHM(c.tout) + '</bdi>'; }).join('<br>');
    var df = x.diff != null && x.diff !== '' ? mgrClkDiff(x.diff, 0) : mgrClkDiff(x.clock, casH);
    var big = df && Math.abs(parseFloat(df.replace('−', '-'))) >= MGR_CLK_DIFF;
    t.appendChild(mgrEl('tr', 'mgr-clk-day' + (big ? ' big' : ''), '<td><bdi>' + clockDM(x.date) + '</bdi></td><td>' + clockNum(x.clock) + '</td><td>' +
      (casH !== null ? clockNum(casH) + (cp ? '<div class="mgr-why">' + cp + '</div>' : '') : '—') + '</td><td>' + clockNum(mgrClkDndTotal(x.dnd)) + '</td><td class="mgr-clk-diff' +
      (big ? ' big' : '') + '">' + (df ? '<bdi>' + df + '</bdi>' : '—') + '</td>'));
  });
  sc.appendChild(t);
  s2.appendChild(sc);
}

/** A record of a pair's history: when, what, the values, who, the state, the reason — all escaped. */
function mgrClkHistText(h) {
  var k = String(h.kind || ''), bits = ['<bdi>' + clockWhen(h.at) + '</bdi>', esc(CLOCK_KIND_LABEL[k] || k)];
  if (h.start) bits.push('כניסה <bdi>' + clockHM(h.start) + '</bdi>');
  if (h.end) bits.push('יציאה <bdi>' + clockHM(h.end) + '</bdi>');
  if (h.label) bits.push(esc(h.label));
  if (h.by) bits.push('על ידי ' + esc(h.byName || h.by));
  if (h.status) bits.push(esc(h.status));
  return bits.join(' · ') + (h.reason ? ' — ' + esc(h.reason) : '');
}

/** The open form of the person sheet: in / out for them, a forgotten shift, a correction of a pair. */
function mgrClkFormEl(parent, ctx, form, dr, pair) {
  var empId = ctx.empId, box = mgrEl('div', 'mgr-clk-form');
  var P = mgrClkP && mgrClkP.empId === empId ? mgrClkP : null;   // the person's own lists (what the server checks), never the manager's
  var choices = P ? (form.kind === 'in' ? P.choices : (P.choicesAny || P.choices)) : null;
  var tag = form.kind + ':' + empId + ':' + (form.pairId || '');
  var busy = mgrClkBusy === tag ? 'mine' : mgrClkBusy ? 'other' : '';
  if (form.kind === 'fix') {
    if (!pair) return;
    clockFixFormEl(box, dr, pair, choices, busy, '', function () {
      var b = clockFixBody(dr, pair, choices);
      if (b.err) { mgrClkFail(b.err); return; }
      mgrClkRun(tag, 'mgrClockFix', Object.assign({ empId: empId }, b.body), 'נרשם ✓');
    }, renderMgrClockSheet);
  } else if (form.kind === 'add') {
    var win = mgrClkWindow(ctx.ym);
    clockAddFormEl(box, dr, win, choices, busy, '', function () {
      var b = clockAddBody(dr, win, choices);
      if (b.err) { mgrClkFail(b.err); return; }
      mgrClkRun(tag, 'mgrClockFix', Object.assign({ empId: empId }, b.body), 'נרשם ✓');
    }, renderMgrClockSheet);
  } else if (form.kind === 'in') {
    box.appendChild(mgrEl('div', 'mgr-sub', '▶ כניסה בשמו עכשיו — על מה?'));
    clockChoicesEl(box, choices, { sel: dr.pick, noteFor: clockNeedsNote(clockChoiceOf(choices, dr.pick)) ? dr.pick : '', dr: dr, noteGo: null,
      onPick: function (c) { dr.pick = clockKey(c); renderMgrClockSheet(); } });
    clockReasonEl(box, dr);
    clockGoEl(box, busy, '', function () {
      var c = clockChoiceOf(choices, dr.pick);
      if (!c) { mgrClkFail('לבחור על מה הוא עובד.'); return; }
      var note = mgrFold(dr.note), np = clockNoteProblem(c, note), reason = mgrFold(dr.reason), rp = clockReasonProblem(reason);
      if (np || rp) { mgrClkFail(np || rp); return; }
      mgrClkRun(tag, 'mgrClockFor', { empId: empId, op: 'in', purpose: String(c.purpose), ref: String(c.ref == null ? '' : c.ref), note: clockNeedsNote(c) ? note : '', reason: reason }, 'הכניסה נרשמה ✓');
    });
  } else {
    box.appendChild(mgrEl('div', 'mgr-sub', '⏹ יציאה בשמו עכשיו'));
    clockReasonEl(box, dr);
    clockGoEl(box, busy, '', function () {
      var reason = mgrFold(dr.reason), rp = clockReasonProblem(reason);
      if (rp) { mgrClkFail(rp); return; }
      mgrClkRun(tag, 'mgrClockFor', { empId: empId, op: 'out', reason: reason }, 'היציאה נרשמה ✓');
    });
  }
  var cx = mgrEl('button', 'btn btn-sm btn-secondary mgr-clk-cancel'); cx.type = 'button'; cx.textContent = 'ביטול';
  cx.onclick = function () { mgrClkForm = null; renderMgrClockSheet(); };
  box.appendChild(cx);
  parent.appendChild(box);
}

/** A refusal on the phone (or the server's words): in the fold, in the open sheet and in a toast. */
function mgrClkFail(msg) {
  mgrClkWriteErr = String(msg == null ? '' : msg);
  mgrClkSheetScroll = 0;   // the line that says why is at the top of the sheet
  showToast(mgrClkWriteErr, 'error');
  renderMgrClock(); renderMgrClockSheet();
}

/**
 * ONE POST, one at a time, no automatic retry. Taken: the server's words, and the screen (and the open person) read again. No answer:
 * said, and read again — a correction (mgrClockFix) sent again unchanged keeps its tapId, so the server writes it once.
 */
function mgrClkRun(tag, action, body, okText) {
  if (mgrClkBusy) return;
  var gen = loginGen, b = body;
  if (action === 'mgrClockFix') {
    var key = JSON.stringify(body);
    if (!mgrClkTap || mgrClkTap.key !== key) mgrClkTap = { key: key, id: clockTapId() };
    b = Object.assign({}, body, { tapId: mgrClkTap.id });
  }
  mgrClkBusy = tag; mgrClkWriteErr = '';
  renderMgrClock(); renderMgrClockSheet();
  api(action, b, { post: true, ms: 60000 }).then(function (r) {
    if (gen !== loginGen) return;   // logged out meanwhile (shared phone)
    mgrClkBusy = '';
    if (r && r.success) {
      mgrClkTap = null; mgrClkInline = null; mgrClkForm = null; mgrClkDraft = mgrClkDraftNew();
      showToast(r.message || okText, 'success');
    } else if (r && r.transport) {
      mgrClkWriteErr = MGR_CLK_NO_ANSWER; mgrClkSheetScroll = 0;
      showToast(MGR_CLK_NO_ANSWER, 'error');
    } else if (r && r.retry) {   // the server said "try again" (nothing was written): the same correction again keeps its tapId
      mgrClkWriteErr = clockAgainWords(r.error); mgrClkSheetScroll = 0;
      showToast(mgrClkWriteErr, 'error');
      renderMgrClock(); renderMgrClockSheet();
      return;
    } else {
      mgrClkTap = null;
      mgrClkWriteErr = String(r && r.error ? r.error : 'לא נשמר.'); mgrClkSheetScroll = 0;
      showToast(mgrClkWriteErr, 'error');
      renderMgrClock(); renderMgrClockSheet();
      return;
    }
    loadMgrClock();
    loadMgrClockPerson();
  });
}

/* שכבה שנייה (13/10, סקירת האבטחה של p4): ה-HTML של הטבלה נבנה ומוברח בשרת, אבל המסך לא סומך על זה לבד. נשאר רק מה
   שהטבלה צריכה — table / tr / th / td / span / br, המחלקות td-name / closed / mine / p / me, ו-style שהוא בדיוק
   background:#rrggbb. כל תגית אחרת נופלת (הטקסט שלה נשאר טקסט), כל מאפיין אחר נופל, ו-< או > בטקסט מוברחים. */
var WK_TAGS = { table: 1, tr: 1, th: 1, td: 1, span: 1, br: 1 };
var WK_CLASSES = { 'td-name': 1, closed: 1, mine: 1, p: 1, me: 1 };
function sanitizeTableHtml(html) {
  var s = String(html == null ? '' : html);
  var out = '', last = 0, m;
  var re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^<>]*)>/g;
  var text = function (t) { return t.replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  while ((m = re.exec(s))) {
    out += text(s.slice(last, m.index));
    last = re.lastIndex;
    var tag = m[2].toLowerCase();
    if (!WK_TAGS[tag]) continue;
    if (m[1]) { if (tag !== 'br') out += '</' + tag + '>'; continue; }
    var attrs = '';
    var cm = /(?:^|\s)class="([^"]*)"/.exec(m[3]);
    if (cm) {
      var cls = cm[1].split(/\s+/).filter(function (c) { return WK_CLASSES[c] === 1; });
      if (cls.length) attrs += ' class="' + cls.join(' ') + '"';
    }
    var sm = /(?:^|\s)style="background:(#[0-9a-fA-F]{6})"/.exec(m[3]);
    if (sm) attrs += ' style="background:' + sm[1] + '"';
    out += '<' + tag + attrs + '>';
  }
  return out + text(s.slice(last));
}

/* מצייר את התשובה של weekBoard בתצוגה שנבחרה בטלפון (13/10) */
function renderWeekBoard(res) {
  var container = document.getElementById('weekBoardContainer');
  if (!container) return;
  syncSettingsUi();
  var t = res.table;
  if (weekView() === 'table' && t && t.html) {
    // ה-HTML נבנה ומוברח בשרת (whatsAppTableHtml_ — check_dialogs בלוק 2); השמות שהוסתרו — מוברחים כאן
    container.innerHTML = boardNoticeHtml(res.board, 'week') + '<div class="wk-paper">' + sanitizeTableHtml(t.html) + '</div>' +
      ((t.hidden && t.hidden.length) ? '<p class="wk-hidden">לא מוצגות — ריקות כל השבוע: ' + esc(t.hidden.join(' · ')) + '</p>' : '') +
      // 16/10: the WhatsApp image from the phone — managers only (the server says who is a manager)
      (res.board && res.board.isManager ? '<button class="btn btn-sm btn-secondary wa-share" type="button" onclick="waImageShare()">📸 תמונה לוואטסאפ</button>' : '');
    return;
  }
  renderWeekList(container, res, weekView() === 'table');
}

function renderWeekList(container, res, tableMissing) {
      container.innerHTML = boardNoticeHtml(res.board, 'week') + (tableMissing
        ? '<div class="empty-state">הטבלה לא נטענה' + (res.table && res.table.error ? ' (' + esc(res.table.error) + ')' : '') + ' — מוצג לפי ימים.</div>' : '');
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
}

/* ==================================================================
   הגדרות (13/10, הצוות אחרי שבוע ראשון): איך מסמנים זמינות.
   "tap"  — הכפתור ליד המשמרת מחליף מצב בכל הקשה (מה שהיה).
   "grid" — טבלה: עמודה לכל מצב, הקשה אחת על העיגול; הקשה נוספת על אותו עיגול מבטלת.
   העדפה של המכשיר (localStorage) — לא נתון של הסידור, ולא נמחקת ביציאה. ההגשה עצמה זהה בשני המצבים.
   ================================================================== */
var MARK_MODE_STORE = 'freak_mark_mode';
function markMode() { return SafeStorage.get(MARK_MODE_STORE) === 'grid' ? 'grid' : 'tap'; }
function setMarkMode(mode) {
  SafeStorage.set(MARK_MODE_STORE, mode === 'grid' ? 'grid' : 'tap');
  // מצייר מחדש את שתי המטריצות — מה שכבר סומן נשאר (keep)
  renderConstraintsMatrix(true);
  renderFixedMatrix(true);
  syncSettingsUi();
}
function syncSettingsUi() {
  var grid = markMode() === 'grid';
  var t = document.getElementById('optMarkTap'), g = document.getElementById('optMarkGrid');
  if (t) { if (grid) t.classList.remove('on'); else t.classList.add('on'); }
  if (g) { if (grid) g.classList.add('on'); else g.classList.remove('on'); }
  var table = weekView() === 'table';
  ['optWeekTable', 'weekViewTable'].forEach(function (id) { var e = document.getElementById(id); if (e) { if (table) e.classList.add('on'); else e.classList.remove('on'); } });
  ['optWeekList', 'weekViewList'].forEach(function (id) { var e = document.getElementById(id); if (e) { if (table) e.classList.remove('on'); else e.classList.add('on'); } });
  var h = document.getElementById('markHint');
  if (h) h.textContent = grid ? 'סמנו עיגול אחד בכל משמרת (הקשה נוספת על אותו עיגול מבטלת):'
                              : 'הקישו על הכפתור ליד כל משמרת — כל הקשה מחליפה מצב:';
}
/* תצוגת הלוח השבועי (13/10): "list" — לפי ימים (מה שהיה); "table" — הטבלה של תמונת הוואטסאפ, שהשרת בונה (res.table.html,
   מוברחת שם), עם התגיות שלך מסומנות. העדפה של הטלפון, כמו שיטת הסימון. */
var WEEK_VIEW_STORE = 'freak_week_view';
var lastWeekBoard = null;   // התשובה האחרונה — המעבר בין התצוגות בלי לחכות לשרת; נמחקת ביציאה
function weekView() { return SafeStorage.get(WEEK_VIEW_STORE) === 'table' ? 'table' : 'list'; }
function setWeekView(v) {
  SafeStorage.set(WEEK_VIEW_STORE, v === 'table' ? 'table' : 'list');
  syncSettingsUi();
  if (lastWeekBoard) renderWeekBoard(lastWeekBoard);
}

function openSettings() {
  syncSettingsUi();
  var o = document.getElementById('settingsOverlay');
  if (o) o.style.display = 'flex';
}
function closeSettings() {
  var o = document.getElementById('settingsOverlay');
  if (o) o.style.display = 'none';
}
// כותרת עמודה קצרה בטבלה (רוחב טלפון); מצב שאינו מוכר — הטקסט מהשרת כמו שהוא
var STATUS_SHORT = { 'רוצה ויכול': '🟢 רוצה', 'אם חייבים אז כן': '🟡 אם חייבים', 'לא יכול': '🔴 לא יכול', 'חופש/מחלה': '⚪ חופש' };
function statusShort(st) { return STATUS_SHORT[st.key] || st.text || st.label || st.key; }
// הקשה בטבלה: בוחרת מצב, או מבטלת כשמקישים שוב על המסומן
function pickStatus(data, day, key, idx, el) {
  if (data === matrixData) weeklyTouched[day + '|' + key] = true;
  data[day][key] = (data[day][key] === idx) ? UNSET : idx;
  setPillState(el, data[day][key]);
}

/* בניית מטריצת זמינות (4 מצבים) — אותו בלוק לטופס השבועי ולאילוצים הקבועים (10/10).
   keep (13/10) — לצייר מחדש בלי לאבד את מה שסומן (החלפת שיטת הסימון בהגדרות). */
function renderMatrixInto(containerId, data, pills, cycleFn, keep) {
  var container = document.getElementById(containerId);
  if (!container) return;
  var old = {};
  if (keep) Object.keys(data).forEach(function (d) { old[d] = data[d]; });
  container.innerHTML = '';
  Object.keys(data).forEach(function (k) { delete data[k]; });
  Object.keys(pills).forEach(function (k) { delete pills[k]; });
  var grid = markMode() === 'grid';

  DAYS.forEach(function(day) {
    data[day] = {};
    pills[day] = {};
    var dayBox = document.createElement('div');
    dayBox.className = 'day-block';
    dayBox.innerHTML = '<div class="day-title"><span>יום ' + esc(day) + '</span></div>';
    var cols = 'minmax(0,1fr) repeat(' + STATUS_STATES.length + ', 46px)';
    if (grid) {
      var head = document.createElement('div');
      head.className = 'grid-row grid-head';
      head.style.gridTemplateColumns = cols;
      head.innerHTML = '<span class="grid-lbl"></span>' + STATUS_STATES.map(function (st) {
        return '<span class="grid-col">' + esc(statusShort(st)) + '</span>';
      }).join('');
      dayBox.appendChild(head);
    }

    shiftsForDay(day).forEach(function(tpl) {
      data[day][tpl.key] = UNSET;

      if (grid) {
        var grow = document.createElement('div');
        grow.className = 'grid-row';
        grow.style.gridTemplateColumns = cols;
        var lbl = document.createElement('span');
        lbl.className = 'grid-lbl';
        // השם, והשעות בשורה משלהן — "בוקר (09:30-16:00)" נשבר בטלפון ל"בוקר (-09:30" / "(16:00" (כיווניות)
        lbl.innerHTML = esc(tpl.label) + (tpl.from ? '<span class="grid-time"><bdi>' + esc(tpl.from + '–' + tpl.to) + '</bdi></span>' : '');
        grow.appendChild(lbl);
        grow.dots = [];
        STATUS_STATES.forEach(function (st, i) {
          var dot = document.createElement('button');
          dot.type = 'button';
          dot.className = 'grid-dot ' + (st.cls || '');
          dot.setAttribute('aria-label', shiftLabel(tpl) + ' — ' + (st.text || st.key));
          dot.setAttribute('aria-pressed', 'false');
          dot.onclick = (function (d, k, ix, r) {
            return function () { pickStatus(data, d, k, ix, r); };
          })(day, tpl.key, i, grow);
          grow.appendChild(dot);
          grow.dots.push(dot);
        });
        pills[day][tpl.key] = grow;
        dayBox.appendChild(grow);
        return;
      }

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

  // מה שסומן לפני הציור מחדש חוזר — רק משבצת שעדיין בטופס
  Object.keys(old).forEach(function (d) {
    if (!data[d]) return;
    Object.keys(old[d]).forEach(function (k) {
      if (!(k in data[d]) || old[d][k] === UNSET) return;
      data[d][k] = old[d][k];
      setPillState(pills[d][k], old[d][k]);
    });
  });
}

function renderConstraintsMatrix(keep) { if (!keep) weeklyTouched = {}; renderMatrixInto('constraintsMatrixContainer', matrixData, matrixPills, cycleShiftStatus, keep); }
function renderFixedMatrix(keep) { renderMatrixInto('fixedMatrixContainer', fixedData, fixedPills, cycleFixedStatus, keep); }

function setPillState(pill, idx) {
  if (!pill) return;
  if (pill.dots) {
    // מצב טבלה: העיגול של המצב מסומן, השאר לא (UNSET — אף אחד)
    pill.dots.forEach(function (d, i) {
      if (i === idx) d.classList.add('on'); else d.classList.remove('on');
      d.setAttribute('aria-pressed', i === idx ? 'true' : 'false');
    });
    return;
  }
  var st = STATUS_STATES[idx];
  if (!st) return;
  pill.className = 'status-pill ' + st.cls;
  pill.textContent = st.text;
  pill.style.opacity = '1';
}

function cycleShiftStatus(day, tplKey, pillElement) {
  weeklyTouched[day + '|' + tplKey] = true;
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
      // ביקורת 13/10 (R6): משבצת שהעובד ביטל בטבלה היא UNSET — אבל הוא נגע בה, ולכן הקבוע לא ממלא אותה שוב
      if (idx === UNSET || !(key in matrixData[day]) || matrixData[day][key] !== UNSET || weeklyTouched[day + '|' + key]) return;
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
    showToast('לא סימנת אף משמרת. סמנו זמינות ליד כל משמרת (שיטת הסימון — ⚙️ הגדרות).', 'error');
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
