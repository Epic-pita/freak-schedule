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
const BUILD = 'p8';

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
  ['myShiftsContainer', 'weekBoardContainer', 'openSwapsContainer',
   'skillsContainer', 'fixedMatrixContainer', 'mgrContainer', 'mgrSubmit', 'mgrBuild', 'mgrStatus', 'mgrAssign', 'mgrCheck'].forEach(function (id) {
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
  var navMgrOut = document.getElementById('navManager');
  if (navMgrOut) navMgrOut.style.display = 'none';

  // ניקוי ה-DOM גם ביציאה, ולא רק בכניסה: בין השתיים יש חלון שבו מסך
  // הכניסה מוצג אבל התוכן של הקודם עדיין יושב מאחוריו.
  lastWeekBoard = null;   // יציאה (טלפון משותף): הלוח של הקודם לא מצויר שוב במעבר תצוגה (13/10)
  mgrResetState();
  ['myShiftsContainer', 'weekBoardContainer', 'openSwapsContainer',
   'skillsContainer', 'fixedMatrixContainer', 'mgrContainer', 'mgrSubmit', 'mgrBuild', 'mgrStatus', 'mgrAssign', 'mgrCheck'].forEach(function (id) {
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
  if (tabId === 'tabManager') loadManager();
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
function loadManager() {
  var box = document.getElementById('mgrContainer');
  if (!box) return;
  box.innerHTML = '<div class="loader">טוען את מסך המנהל...</div>';
  var gen = loginGen;
  api('mgrOverview').then(function (res) {
    if (gen !== loginGen) return;   // יצאו בינתיים (טלפון משותף) — לא מציירים את המסך של הקודם
    if (!res || !res.success) {
      // the cards above are from the previous answer — not left standing over an error (review 16/10)
      renderMgrSubmit(null); renderMgrStatus(null); renderMgrBuild(null);
      box.innerHTML = '<div class="empty-state">' + (res && res.transport ? 'כשל בתקשורת מול השרת' : 'שגיאה: ' + esc(res ? res.error : '')) + '</div>';
      return;
    }
    renderMgrSubmit(res.submitStatus);   // 16/10: who has submitted for next week
    renderMgrBuild(res);   // 16/10: build the week from the phone
    renderMgrStatus(res.board);   // 15/10: draft / published, and the publish button
    renderManager(box, res);
  });
  // 15/10, stage 2: the board for assigning (its own call, in parallel), and the week check on demand
  loadMgrBoard();
  renderMgrCheckButton();
}

function mgrEl(tag, cls, html) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

function renderManager(box, res) {
  box.innerHTML = '';
  var sw = res.swaps || {};
  var claimed = sw.claimed || [], open = sw.open || [];
  var sec = mgrEl('div', 'mgr-sec', '<h4>🔄 החלפות שממתינות לאישור (' + claimed.length + ')</h4>');
  if (sw.gateNote) sec.appendChild(mgrEl('p', 'mgr-note', '⚠️ כישורי המחליפים לא נבדקו: ' + esc(sw.gateNote)));
  if (!claimed.length) sec.appendChild(mgrEl('p', 'mgr-empty', 'אין בקשות שממתינות לאישור ✓'));
  claimed.forEach(function (s) {
    var card = mgrEl('div', 'card mgr-card',
      '<div class="mgr-row"><b>' + esc(s.date) + ' · ' + esc(s.shift) + '</b></div>' +
      '<div>מ-<b>' + esc(s.orig) + '</b> אל <b>' + esc(s.proposed) + '</b> (+' + esc(res.karmaBoost) + ' קארמה)</div>' +
      (s.skill ? '<div class="mgr-skill">' + esc(s.skill) + '</div>' : '') +
      '<div class="mgr-reason">סיבה: ' + esc(s.reason || 'לא צוינה') + '</div>');
    var acts = mgrEl('div', 'mgr-acts');
    var ok = mgrEl('button', 'btn btn-sm mgr-approve'); ok.type = 'button'; ok.textContent = '✓ אשר';
    ok.onclick = function () {
      openAppModal('אישור החלפה', s.date + ' · ' + s.shift + ': ' + s.proposed + ' במקום ' + s.orig + '. הלוח יתעדכן.', false, 'אשר', function () {
        mgrDecide('mgrApproveSwap', { swapId: s.id });
      });
    };
    var no = mgrEl('button', 'btn btn-secondary btn-sm mgr-reject'); no.type = 'button'; no.textContent = '✗ דחה';
    no.onclick = function () {
      openAppModal('דחיית החלפה', 'המשמרת נשארת אצל ' + s.orig + '. סיבה (לא חובה):', true, 'דחה', function (reason) {
        mgrDecide('mgrRejectSwap', { swapId: s.id, reason: typeof reason === 'string' ? reason : '' });
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
  var asec = mgrEl('div', 'mgr-sec', '<h4>📝 זמינות לשבוע ' + esc(av.week || '') + '</h4>');
  // 16/10: who has not submitted is said once, at the top (renderMgrSubmit — the hours-budget list); an older server — here as before
  if ((!res.submitStatus || res.submitStatus.error) && av.notSubmitted && av.notSubmitted.length) asec.appendChild(mgrEl('p', 'mgr-note', 'לא הגישו: ' + esc(av.notSubmitted.join(', '))));
  asec.appendChild(mgrEl('p', 'mgr-legend', '🔁 = מהאילוצים הקבועים שהעובד שמר באפליקציה (לא הגיש טופס לשבוע הזה)'));
  var stText = (av.statuses || []).map(function (k) {
    for (var i = 0; i < STATUS_STATES.length; i++) if (STATUS_STATES[i].key === k) return STATUS_STATES[i].text || k;
    return k;
  });
  var day = null, dayBox = null;
  (av.slots || []).forEach(function (sl) {
    if (sl.day !== day) {
      day = sl.day;
      dayBox = mgrEl('div', 'day-group', '<div class="day-head"><span>יום ' + esc(day) + '</span></div>');
      asec.appendChild(dayBox);
    }
    var lines = '';
    (sl.by || []).forEach(function (list, ix) {
      if (!list || !list.length) return;
      lines += '<div class="mgr-st">' + esc(stText[ix] || '') + ': ' + list.map(function (p) { return esc(p.name) + (p.fixed ? ' 🔁' : ''); }).join(', ') + '</div>';
    });
    dayBox.appendChild(mgrEl('div', 'mgr-slot', '<div class="mgr-slot-h"><b>' + esc(sl.shift) + '</b> <span>' + esc(sl.hours) + '</span></div>' +
      (lines || '<div class="mgr-st mgr-none">אף אחד עוד לא סימן</div>')));
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
}

function mgrDecide(action, params) {
  showToast('שולח לגיליון...', 'info');
  var gen = loginGen;
  api(action, params, { post: true }).then(function (res) {
    if (gen !== loginGen) return;
    if (res && res.success) showToast(res.message || 'בוצע ✓', 'success');
    else if (res && res.transport) showToast('לא התקבלה תשובה מהשרת. המסך נטען מחדש — לבדוק אם הבקשה עדיין ממתינה לפני שמנסים שוב.', 'error');
    else showToast('לא בוצע: ' + (res ? res.error : ''), 'error');
    loadManager();
  });
}

/* ==================================================================
   Manager screen, stage 2 (15/10): the publish card, assign from a list, the week check.
   Every write is one confirmed tap, and the server checks it again under its lock (mgrPublish_ / mgrAssign_ in
   20_ManagerApi.gs): the week the screen showed, the cell as the screen saw it, the list of the row. The code never
   picks anyone — the list shows what each person submitted, the manager taps. Every server text goes through esc().
   ================================================================== */
var mgrBoardData = null;   // the last mgrBoard answer (cleared on login and logout)
var mgrDay = '';           // the day chosen on the assign screen ("dd/MM")
var mgrPick = '';          // the row whose list is open (its label)

function mgrResetState() {
  mgrBoardData = null; mgrDay = ''; mgrPick = ''; weekTeamView = false; mgrLastBuild = null; mgrBuilding = '';
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
function renderMgrBuild(res) {
  var box = document.getElementById('mgrBuild');
  if (!box) return;
  box.innerHTML = '';
  if (mgrBuilding) {
    box.innerHTML = '<div class="card mgr-status"><div class="loader">בונה את שבוע ' + esc(isoShort(mgrBuilding)) +
      ' — יומנים, חוגים ותבניות. זה לוקח עד כמה דקות, לא לסגור את האפליקציה…</div></div>';
    return;
  }
  if (!res) return;
  var next = String(res.nextWeek == null ? '' : res.nextWeek), cur = String(res.currentWeek == null ? '' : res.currentWeek);
  var bs = res.board || {}, board = String(bs.week || ''), published = bs.state === 'published';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return;   // an older server: no build from the phone
  var stale = !!cur && (!board || board < cur);
  var mode = stale ? 'current' : (bs.state === 'draft' && board && board !== next ? 'draftFirst' : (board === next ? 'rebuild' : 'next'));
  var target = mode === 'current' ? cur : (mode === 'next' ? next : board);
  var T = isoShort(target), B = isoShort(board);
  var card = mgrEl('div', 'card mgr-status');
  var text = {
    next: 'השבוע הבא: ' + esc(isoShort(next)) + (B ? ' · בלוח עכשיו: ' + esc(B) : '') + '. הבנייה מושכת חגים, אירועים וחוגים, ושומרת גיבוי קודם.',
    current: (B ? 'בלוח עדיין שבוע ' + esc(B) + ', שכבר נגמר. ' : 'אין שבוע בלוח. ') + 'קודם בונים את השבוע הנוכחי (' + esc(T) + '), ואחרי שמפרסמים — את הבא.',
    draftFirst: 'שבוע ' + esc(B) + ' בלוח עוד לא פורסם — לפרסם אותו (בכרטיס הפרסום) לפני שבונים את ' + esc(isoShort(next)) + '. אפשר לבנות אותו מחדש:',
    rebuild: 'שבוע ' + esc(T) + ' כבר בלוח. בנייה מחדש שומרת את מה ששובץ ומעדכנת יומנים וחוגים.'
  }[mode];
  card.innerHTML = '<b>🔨 בניית השבוע</b><div>' + text + '</div>';
  var isRebuild = target === board;
  var b = mgrEl('button', 'btn btn-sm mgr-build'); b.type = 'button';
  b.textContent = isRebuild ? '🔨 בנה מחדש את ' + T : '🔨 בנה את שבוע ' + T;
  b.onclick = function () {
    var desc;
    if (isRebuild) {
      desc = (published ? 'שבוע ' + T + ' כבר פורסם — הבנייה מחדש נראית לצוות מיד. ' : 'שבוע ' + T + ' עדיין טיוטה — הצוות לא רואה אותו. ') +
        'מה ששובץ נשמר, חוץ מיום שנסגר או אירוע שבוטל (ההודעה אומרת מה ירד); היומנים, החוגים והתבניות מתעדכנים. לוקח עד כמה דקות.';
    } else {
      var st = res.submitStatus, miss = st && !st.error && !st.complete && st.missing ? st.missing.length : 0;
      desc = 'לבנות את שבוע ' + T + '? הוא נבנה כטיוטה — הצוות לא רואה אותו עד שתפרסם' +
        (stale ? ' (בינתיים הצוות רואה "בבנייה")' : (B ? ', וממשיך לראות את שבוע ' + B : '')) + '. ' +
        'עד הפרסום בקשות ההחלפה של הצוות נעצרות (החלפות — ביד)' + (target === next ? ', וגם מיילי ההגשות לשבוע הזה' : '') + '.' +
        (target === next && miss ? ' עוד לא הגישו: ' + miss + '.' : '') + ' לוקח עד כמה דקות.';
    }
    openAppModal(isRebuild ? 'בנייה מחדש' : 'בניית השבוע', desc, false, isRebuild ? 'בנה מחדש' : 'בנה', function () { mgrBuildRun(target, board); });
  };
  card.appendChild(b);
  if (mgrLastBuild) card.appendChild(mgrLastBuild);
  box.appendChild(card);
}

/** week = the week to build; expect = the board's week as this screen saw it (the server refuses if it changed meanwhile). */
function mgrBuildRun(week, expect) {
  if (mgrBuilding) return;   // one build at a time from this phone
  mgrBuilding = week;
  mgrLastBuild = null;
  renderMgrBuild(null);
  var gen = loginGen;
  api('mgrBuildWeek', { week: week, expect: expect }, { post: true, ms: 240000 }).then(function (r) {
    if (gen !== loginGen) return;   // logged out meanwhile (shared phone)
    mgrBuilding = '';
    var out = mgrEl('div', 'mgr-build-out');
    if (r && r.success) {
      var lines = String(r.message || '').split('\n').filter(function (l) { return l.trim(); });
      out.innerHTML = '<div class="mgr-ok">✅ ' + esc(lines[0] || 'נבנה') + '</div>' +
        (lines.length > 1 ? '<div class="mgr-legend">' + lines.slice(1).map(esc).join('<br>') + '</div>' : '');
      showToast('השבוע נבנה ✓', 'success');
    } else if (r && r.transport) {
      out.innerHTML = '<div class="mgr-note">לא התקבלה תשובה. ייתכן שהבנייה עוד רצה — לרענן בעוד כמה דקות ולבדוק איזה שבוע בלוח, לפני שבונים שוב.</div>';
    } else {
      out.innerHTML = '<div class="mgr-note">❌ לא נבנה: ' + esc(r ? r.error : '') +
        (r && r.midway ? '<br>אם הלוח בגיליון נראה ריק או חלקי — השבוע הקודם שמור בטאב "גיבוי …" האחרון.' : '') + '</div>';
    }
    mgrLastBuild = out;
    loadManager();   // the status, the board for assigning and this card again — with the answer under it
  });
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

function waImageShare() {
  var t = lastWeekBoard && lastWeekBoard.table, bd = (lastWeekBoard && lastWeekBoard.board) || {};
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
    box.appendChild(card);
    return;
  }
  card.innerHTML = '<b>📣 שבוע ' + esc(wk || '?') + ' — טיוטה</b>' +
    '<div>' + (board.broken ? '⚠️ מצב הפרסום לא נקרא. ' : '') + 'הצוות רואה ' +
    (see ? 'את שבוע ' + esc(see) : '"בבנייה"' + (board.staffEnded ? ' (השבוע הקודם הסתיים)' : '')) + '.</div>';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(board.week || ''))) {
    var b = mgrEl('button', 'btn btn-sm mgr-publish'); b.type = 'button'; b.textContent = '📣 פרסם לצוות';
    b.onclick = function () {
      openAppModal('פרסום השבוע', 'לפרסם לצוות את שבוע ' + wk + '? מהרגע הזה כולם רואים אותו באפליקציה' +
        (see ? ', ושבוע ' + see + ' יורד מהמסך.' : '.'), false, 'פרסם', function () {
        mgrDecide('mgrPublish', { week: board.week });
      });
    };
    card.appendChild(b);
  }
  box.appendChild(card);
}

/** The board for assigning — the live tab (the draft when there is one). */
function loadMgrBoard() {
  var box = document.getElementById('mgrAssign');
  if (!box) return;
  box.innerHTML = '<div class="loader">טוען את הלוח לשיבוץ...</div>';
  var gen = loginGen;
  api('mgrBoard').then(function (res) {
    if (gen !== loginGen) return;   // logged out meanwhile (shared phone)
    if (!res || !res.success) {
      mgrBoardData = null;
      box.innerHTML = '<div class="empty-state">' + (res && res.transport ? 'כשל בתקשורת מול השרת' : 'שגיאה: ' + esc(res ? res.error : '')) + '</div>';
      return;
    }
    mgrBoardData = res;
    renderMgrAssign();
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

function renderMgrAssign() {
  var box = document.getElementById('mgrAssign');
  var res = mgrBoardData;
  if (!box || !res) return;
  box.innerHTML = '';
  var sec = mgrEl('div', 'mgr-sec', '<h4>🧩 שיבוץ מרשימה' + (isoShort(res.week) ? ' — שבוע ' + esc(isoShort(res.week)) : '') +
    (res.state === 'draft' ? ' (טיוטה)' : ' (פורסם — גלוי לצוות)') + '</h4>');
  box.appendChild(sec);
  if (!res.days || !res.days.length) { sec.appendChild(mgrEl('p', 'mgr-empty', 'הלוח ריק — לבנות את השבוע מהגיליון.')); return; }
  if (res.gateNote) sec.appendChild(mgrEl('p', 'mgr-note', '⚠️ הכישורים לא נטענו — הרשימה לפי השיוך בלבד: ' + esc(res.gateNote)));
  if (res.availability && res.availability.error) sec.appendChild(mgrEl('p', 'mgr-note', '⚠️ הזמינות לא נטענה: ' + esc(res.availability.error)));
  if (res.suggestNote) sec.appendChild(mgrEl('p', 'mgr-legend', '💡 ' + esc(res.suggestNote)));
  var known = res.days.some(function (d) { return d.short === mgrDay; });
  if (!known) {
    var open = res.days.filter(function (d) { return !d.closed; })[0] || res.days[0];
    mgrDay = open.short;
    mgrPick = '';
  }
  var chips = mgrEl('div', 'mgr-days');
  res.days.forEach(function (d) {
    var c = mgrEl('button', 'mgr-chip' + (d.short === mgrDay ? ' on' : '') + (d.closed ? ' closed' : ''));
    c.type = 'button';
    c.textContent = d.name + ' ' + d.short + (d.closed ? ' · סגור' : '');
    c.onclick = function () { mgrDay = d.short; mgrPick = ''; renderMgrAssign(); };
    chips.appendChild(c);
  });
  sec.appendChild(chips);
  var di = -1;
  res.days.forEach(function (d, i) { if (d.short === mgrDay) di = i; });
  var day = res.days[di];
  if (res.absences && res.absences[day.short]) sec.appendChild(mgrEl('p', 'mgr-note', 'היעדרויות היום: ' + esc(res.absences[day.short])));
  if (day.closed) { sec.appendChild(mgrEl('p', 'mgr-empty', 'היום סגור.')); return; }
  var anySug = false;
  (res.rows || []).forEach(function (row) {
    var cell = (row.cells || [])[di] || { v: '', can: '' };
    var line = mgrEl('div', 'mgr-arow',
      '<div class="mgr-arow-h"><b>' + esc(row.kind === 'shift' && row.shift ? row.shift : row.label) + '</b>' +
      (row.kind === 'shift' ? ' <span>' + esc(row.label) + '</span>' : '') + '</div>' +
      '<div class="mgr-arow-v">' + (cell.v ? esc(cell.v) : '<span class="mgr-none">ריק</span>') + '</div>');
    // stage 3: suggestions under an empty shift cell only — a tap is the same confirm → write as the full list
    var sg = mgrSugOf(res, row, day);
    if (sg && row.kind === 'shift' && cell.can === 'add' && !cell.v) { line.appendChild(mgrSuggestChips(res, row, cell, day, sg)); anySug = true; }
    if (cell.can) {
      var b = mgrEl('button', 'btn btn-sm btn-secondary mgr-add'); b.type = 'button';
      b.textContent = cell.can === 'fill' ? '+ שבץ לאירוע' : (cell.v ? '+ הוסף עוד' : '+ שבץ');
      b.onclick = function () { mgrPick = mgrPick === row.label ? '' : row.label; renderMgrAssign(); };
      line.appendChild(b);
    } else if (cell.v) {
      line.appendChild(mgrEl('div', 'mgr-legend', 'שינוי בתא הזה — בגיליון.'));
    }
    if (mgrPick === row.label && cell.can) line.appendChild(mgrPickList(res, row, cell, day));
    sec.appendChild(line);
  });
  if (res.skipped && res.skipped.length) sec.appendChild(mgrEl('p', 'mgr-legend', 'שורות שמופיעות בלוח פעמיים — שיבוץ בהן בגיליון: ' + esc(res.skipped.join(' · '))));
  if (anySug) {
    sec.appendChild(mgrEl('p', 'mgr-legend', '💡 הצעה = מי שרוצה, אחר כך אם חייבים, אחר כך צוות החנות שלא סימן; מי שרחוק יותר מהיעד שלו קודם; ' +
      'רמה מלאה לפני מתלמד; קארמה; פחות משמרות השבוע. לא מוצעים: לא יכול / חופש, היעדרות, משמרת חופפת, חסר כישור. ' +
      'שום דבר לא נכתב בלי הקשה ואישור.'));
  }
}

/** The suggestions the server sent for this row and day ({top, skip}), or null (an older server sends none). */
function mgrSugOf(res, row, day) {
  var s = res && res.suggest && res.suggest[row.label + '|' + day.short];
  return s && typeof s === 'object' ? s : null;
}

/** Stage 3: up to three suggestions under an empty shift cell, each with its one-line reason. */
function mgrSuggestChips(res, row, cell, day, sg) {
  var wrap = mgrEl('div', 'mgr-sugg');
  var busy = (res.busy && res.busy[day.short]) || {};
  var ids = (res.candidates && res.candidates[row.label]) || [];
  // only people of the row's list, with a name — the server checks the list again when writing
  var top = (sg.top || []).filter(function (s) { return s && ids.indexOf(s.id) !== -1 && (res.people || {})[s.id]; }).slice(0, 3);
  if (!top.length) {
    wrap.appendChild(mgrEl('div', 'mgr-legend', '💡 אין הצעה — כל מי שברשימה לא יכול, בהיעדרות, במשמרת חופפת או חסר כישור (הסיבה ליד כל שם ב"+ שבץ").'));
    return wrap;
  }
  top.forEach(function (s) {
    var name = res.people[s.id];
    var b = mgrEl('button', 'mgr-sug' + (s.over ? ' over' : ''));
    b.type = 'button';
    b.innerHTML = '💡 <b>' + esc(name) + '</b>' + (s.over ? ' <span class="mgr-over">⚠️ מעבר לתקרה</span>' : '') +
      '<div class="mgr-why">' + esc(s.why || '') + '</div>';
    b.onclick = function () {
      mgrConfirmAssign(res, row, cell, day, { id: s.id, name: name, av: mgrAvailOf(res, day.name, row.shift, name), busy: busy[s.id] || [], over: !!s.over }, '');
    };
    wrap.appendChild(b);
  });
  return wrap;
}

/** The list for one cell: each candidate with what they submitted, and what they already have that day. */
function mgrPickList(res, row, cell, day) {
  var wrap = mgrEl('div', 'mgr-pick');
  var timeIn = null;
  if (row.kind === 'shift') {
    timeIn = document.createElement('input');
    timeIn.type = 'text'; timeIn.className = 'mgr-time'; timeIn.maxLength = 11;
    timeIn.placeholder = 'שעה (לא חובה): 09:30 או 16:00-22:00';
    wrap.appendChild(timeIn);
  }
  var ids = (res.candidates && res.candidates[row.label]) || [];
  var busy = (res.busy && res.busy[day.short]) || {};
  // stage 3: who is suggested (💡) and why the others are not — said beside each name
  var sg = mgrSugOf(res, row, day) || {};
  var sugOver = {};
  (sg.top || []).forEach(function (s) { if (s && s.id) sugOver[s.id] = !!s.over; });
  var skip = sg.skip && typeof sg.skip === 'object' ? sg.skip : {};
  // already in this very cell — not offered again (the server would refuse: "כבר משובץ בתא הזה")
  var list = ids.filter(function (id) { return (busy[id] || []).indexOf(row.label) === -1; }).map(function (id) {
    var name = (res.people || {})[id] || id;
    return { id: id, name: name, av: mgrAvailOf(res, day.name, row.shift, name), busy: busy[id] || [],
             sug: Object.prototype.hasOwnProperty.call(sugOver, id), over: !!sugOver[id],
             skip: Object.prototype.hasOwnProperty.call(skip, id) ? String(skip[id]) : '' };
  });
  // order: wants, if needed, did not mark, cannot, off — said next to each name; the manager still picks anyone
  var rank = function (p) { var ix = p.av ? p.av.ix : 9; return ix === 9 ? 2 : (ix >= 2 ? ix + 1 : ix); };
  list.sort(function (a, b) { return (rank(a) - rank(b)) || a.name.localeCompare(b.name, 'he'); });
  if (!list.length) wrap.appendChild(mgrEl('p', 'mgr-empty', 'אין ברשימה של השורה הזו אף אחד — לשבץ בגיליון.'));
  list.forEach(function (p) {
    var b = mgrEl('button', 'mgr-cand' + (p.av && p.av.ix >= 2 && p.av.ix < 9 ? ' warn' : ''));
    b.type = 'button';
    b.innerHTML = (p.sug ? '💡 ' : '') + '<b>' + esc(p.name) + '</b>' + (p.av ? ' <span>' + esc(p.av.text) + (p.av.fixed ? ' 🔁' : '') + '</span>' : '') +
      (p.over ? ' <span class="mgr-over">⚠️ מעבר לתקרה</span>' : '') +
      (p.busy.length ? '<div class="mgr-legend">כבר היום: ' + esc(p.busy.join(' · ')) + '</div>' : '') +
      (p.skip ? '<div class="mgr-legend">לא בהצעות: ' + esc(p.skip) + '</div>' : '');
    b.onclick = function () { mgrConfirmAssign(res, row, cell, day, p, timeIn ? String(timeIn.value || '').trim() : ''); };
    wrap.appendChild(b);
  });
  wrap.appendChild(mgrEl('p', 'mgr-legend', 'הרשימה לפי מה שכל אחד הגיש (🔁 = קבוע; 💡 = הצעה). הקוד לא כותב לבד — רק מי שהקשת עליו נכתב, אחרי אישור.'));
  return wrap;
}

function mgrConfirmAssign(res, row, cell, day, p, time) {
  if (time && !/^([01]\d|2[0-3]):[0-5]\d(-([01]\d|2[0-3]):[0-5]\d)?$/.test(time)) {
    showToast('שעה לא תקינה — HH:MM, או טווח HH:MM-HH:MM.', 'error');
    return;
  }
  var desc = 'לשבץ את ' + p.name + (time ? ' ' + time : '') + ' ב' + day.name + ' ' + day.short + ' · ' + (row.shift || row.label) + '?' +
    (cell.v ? (cell.can === 'fill' ? ' האירוע: ' + cell.v.replace(/\s*\[דרוש עובד\]$/, '') + '.' : ' בתא כבר: ' + cell.v + ' — ' + p.name + ' יתווסף, אף אחד לא יימחק.') : '') +
    (p.av && (p.av.ix === 2 || p.av.ix === 3) ? ' ⚠️ ' + p.name + ' סימן/ה: ' + p.av.text + '.' : '') +
    (p.busy.length ? ' כבר היום: ' + p.busy.join(', ') + '.' : '') +
    (p.over ? ' ⚠️ השעות האלה מעבירות את השבוע מעל תקרת השעות.' : '') +
    (res.state === 'draft' ? '' : ' הלוח פורסם — הצוות יראה מיד.');
  openAppModal('שיבוץ', desc, false, 'שבץ', function () {
    showToast('שולח לגיליון...', 'info');
    var gen = loginGen;
    api('mgrAssign', { week: res.week, day: day.short, label: row.label, expect: cell.v, empId: p.id, time: time }, { post: true }).then(function (r) {
      if (gen !== loginGen) return;
      if (r && r.success) { showToast(r.message || 'נכתב ✓', 'success'); mgrPick = ''; }
      else if (r && r.transport) showToast('לא התקבלה תשובה מהשרת. הלוח נטען מחדש — לבדוק אם השיבוץ נכתב לפני שמנסים שוב.', 'error');
      else showToast('לא נכתב: ' + (r ? r.error : ''), 'error');
      loadMgrBoard();
    });
  });
}

/** The week check on the phone — read only, with the settings typed in the sheet. */
function renderMgrCheckButton() {
  var box = document.getElementById('mgrCheck');
  if (!box) return;
  box.innerHTML = '';
  var sec = mgrEl('div', 'mgr-sec', '<h4>🔍 בדיקת השבוע</h4>');
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
  var sec = mgrEl('div', 'mgr-sec', '<h4>🔍 בדיקת השבוע' + (isoShort(r.week) ? ' — ' + esc(isoShort(r.week)) : '') + '</h4>');
  var b = r.budget || {};
  var gap = function (g) { return g > 0 ? g + ' שעות מעל ההקצאה' : (g < 0 ? (-g) + ' שעות מתחת להקצאה' : 'בדיוק ההקצאה'); };
  if (r.settingsNote) sec.appendChild(mgrEl('p', 'mgr-note', esc(r.settingsNote)));
  sec.appendChild(mgrEl('p', 'mgr-st', 'עובדים שעתיים: <b>' + esc(b.hourly) + '</b> שעות' +
    (b.valid ? ' — ' + esc(gap(b.gap)) + ' (הקצאה ' + esc(b.allowance) + ', תקרה ' + esc(b.cap) + ')' : '') +
    (b.managers ? ' · כולל מנהל שעתי: ' + esc(b.total) : '')));
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
  if ((r.notScheduled || []).length) list('הגישו ולא קיבלו משמרת', r.notScheduled, function (n) { return esc(n.name + ' (ביקש ' + n.target + ')' + (n.notes ? ' — ' + n.notes : '')); });
  if ((r.uncounted || []).length) list('תאים שלא נספרו', r.uncounted, function (u) { return esc(u.short + ' ' + u.label + ': ' + u.text + ' (' + u.why + ')'); });
  sec.appendChild(mgrEl('p', 'mgr-sub', 'אנשים'));
  (r.people || []).forEach(function (p) {
    if (!p.shifts && !p.submitted) return;
    sec.appendChild(mgrEl('div', 'mgr-line', '<b>' + esc(p.name) + '</b> — ' + esc(p.shifts) + ' משמרות, ' + esc(p.hours) + ' ש׳' +
      (p.target ? ' (יעד ' + esc(p.target) + ')' : '') + (p.manager ? ' · מנהל שעתי' : '') +
      ((p.fair || []).length ? ' · ' + esc(p.fair.join(' · ')) : '') + ((p.flags || []).length ? ' · ⚠️ ' + esc(p.flags.join(' · ')) : '')));
  });
  sec.appendChild(mgrEl('p', 'mgr-legend', 'קריאה בלבד: שום תא לא השתנה. התקציב לפי היעד והשעות מכספית שהוקלדו ב"בדיקת השבוע" בגיליון.'));
  var again = mgrEl('button', 'btn btn-sm btn-secondary mgr-run-check'); again.type = 'button'; again.textContent = '↻ בדיקה שוב';
  again.onclick = loadMgrCheck;
  sec.appendChild(again);
  box.appendChild(sec);
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
