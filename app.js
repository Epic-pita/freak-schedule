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
const BUILD = 'p12';

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
      mgrOvData = null;
      renderMgrSubmit(null); renderMgrStatus(null); renderMgrBuild(null); renderMgrStrip();
      box.innerHTML = '<div class="empty-state">' + (res && res.transport ? 'כשל בתקשורת מול השרת' : 'שגיאה: ' + esc(res ? res.error : '')) + '</div>';
      return;
    }
    mgrOvData = res;
    renderMgrSubmit(res.submitStatus);   // 16/10: who has submitted for next week
    renderMgrBuild(res);   // 16/10: build the week from the phone
    renderMgrStatus(res.board);   // 15/10: draft / published, and the publish button
    renderMgrStrip();   // 16/10: the strip at the top — week, who submitted, the one next step
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
var MGR_DOW = { 'ראשון': 'א', 'שני': 'ב', 'שלישי': 'ג', 'רביעי': 'ד', 'חמישי': 'ה', 'שישי': 'ו' };   // the board's day name -> the recurring store's letter (no Saturday)

function mgrTypeDraftNew() { return { name: '', from: '', to: '', days: MGR_DAYS6.slice(), location: 'חנות' }; }

function mgrResetState() {
  mgrBoardData = null; mgrOvData = null; mgrPending = {}; mgrPendingWeek = ''; mgrSaving = false;
  mgrPickCtx = null; mgrPickTime = ''; mgrAddOpen = false; mgrAdding = false; mgrBoardSeq++; mgrPickRepeat = false;
  weekTeamView = false; mgrLastBuild = null; mgrBuilding = '';
  mgrDayCtx = null; mgrDayDraft = { text: '', title: '', from: '', to: '', staff: true }; mgrDayBusy = false; mgrEvWait = { week: '', items: [] };
  mgrTool = null; mgrToolBusy = false; mgrToolErr = ''; mgrRowDraft = { name: '', from: '', to: '' };
  mgrTypes = null; mgrTypesState = ''; mgrTypesChanged = false; mgrTypeFormOpen = false; mgrTypeDraft = null;
  renderMgrDay();
  renderMgrTool();
  closeAppModal();   // a confirm opened by the previous manager must not stay on screen
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

/** The confirm window of a build (the card's button and the strip's button open the same one). */
function mgrAskBuild(pl) {
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
  openAppModal(pl.isRebuild ? 'בנייה מחדש' : 'בניית השבוע', desc, false, pl.isRebuild ? 'בנה מחדש' : 'בנה', function () { mgrBuildRun(pl.target, pl.board); });
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
  if (!pl) return;
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
}

/** Opens one of the folded sections of the manager tab (a build answer, a build in progress). */
function mgrOpenFold(id) {
  var d = document.getElementById(id);
  if (d) d.open = true;
}

/** week = the week to build; expect = the board's week as this screen saw it (the server refuses if it changed meanwhile). */
function mgrBuildRun(week, expect) {
  if (mgrBuilding) return;   // one build at a time from this phone
  mgrBuilding = week;
  var evSent = mgrEvSeq;   // events added after this point were not seen by this build
  mgrLastBuild = null;
  renderMgrBuild(null);
  var gen = loginGen;
  api('mgrBuildWeek', { week: week, expect: expect }, { post: true, ms: 240000 }).then(function (r) {
    if (gen !== loginGen) return;   // logged out meanwhile (shared phone)
    mgrBuilding = '';
    var out = mgrEl('div', 'mgr-build-out');
    if (r && r.success) {
      if (mgrEvWait.week === String(week)) {   // the rebuild picked up the events added before it was sent; later ones keep waiting
        var still = mgrEvWait.items.filter(function (e) { return e.n > evSent; });
        mgrEvWait = still.length ? { week: mgrEvWait.week, items: still } : { week: '', items: [] };
      }
      var lines = String(r.message || '').split('\n').filter(function (l) { return l.trim(); });
      // 16/10: the first line and every warning stay in view; the rest is folded under "details (N)"
      // only pure information lines (ℹ️ / 🎓) are folded; everything else (warnings, errors, who sees which week) stays in view
      var isInfo = function (l) { return /^\s*(ℹ️|ℹ|🎓)/.test(l); };
      var warns = lines.slice(1).filter(function (l) { return !isInfo(l); });
      var rest = lines.slice(1).filter(isInfo);
      out.innerHTML = '<div class="mgr-ok">✅ ' + esc(lines[0] || 'נבנה') + '</div>' +
        (warns.length ? '<div class="mgr-legend mgr-warns">' + warns.map(esc).join('<br>') + '</div>' : '') +
        (rest.length ? '<details class="mgr-more"><summary>פרטים (' + rest.length + ')</summary><div class="mgr-legend">' + rest.map(esc).join('<br>') + '</div></details>' : '');
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
    b.onclick = function () { mgrAskPublish(board); };
    card.appendChild(b);
  }
  box.appendChild(card);
}

/** The confirm window of publishing (the card's button and the strip's button open the same one). */
function mgrAskPublish(board) {
  var wk = isoShort(board.week), see = isoShort(board.staffSee);
  openAppModal('פרסום השבוע', 'לפרסם לצוות את שבוע ' + wk + '? מהרגע הזה כולם רואים אותו באפליקציה' +
    (see ? ', ושבוע ' + see + ' יורד מהמסך.' : '.'), false, 'פרסם', function () {
    mgrDecide('mgrPublish', { week: board.week });
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
    go = mgrEl('button', 'btn btn-sm mgr-go'); go.type = 'button'; go.textContent = '📣 פרסם לצוות';
    go.onclick = function () { mgrAskPublish(bs); };
  } else if (pl && (pl.mode === 'next' || pl.mode === 'current')) {
    go = mgrEl('button', 'btn btn-sm mgr-go'); go.type = 'button'; go.textContent = '🔨 בנה את שבוע ' + pl.T;
    go.onclick = function () { mgrAskBuild(pl); };
  }
  if (go) strip.appendChild(go);
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
  if (!mgrBoardData) box.innerHTML = '<div class="loader">טוען את הלוח...</div>';
  var gen = loginGen, seq = ++mgrBoardSeq;
  api('mgrBoard').then(function (res) {
    if (gen !== loginGen || seq !== mgrBoardSeq) return;   // logged out meanwhile (shared phone), or a newer answer is coming
    if (!res || !res.success) {
      mgrBoardData = null;
      mgrPickCtx = null;
      renderMgrPicker();
      box.innerHTML = '<div class="empty-state">' + (res && res.transport ? 'כשל בתקשורת מול השרת' : 'שגיאה: ' + esc(res ? res.error : '')) + '</div>';
      renderMgrSaveBar();
      if (mgrTool) renderMgrTool();   // stage 6: the tools sheet needs the board — it closes
      return;
    }
    mgrSyncPending(res);
    mgrBoardData = res;
    renderMgrAssign();
    renderMgrPicker();
    renderMgrSaveBar();
    mgrDayCheckLanded();
    if (mgrDayCtx) renderMgrDay();   // closes itself when its day is gone / closed / the week changed
    if (mgrTool) renderMgrTool();    // stage 6: closes itself when its row is gone / the board is not the one it was opened on
  });
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
    if (!lines.length && !day.closed) h = '<span class="mgr-addnote">＋ הוסף</span>';
    var td = mgrEl('td', 'mgr-cell mgr-info ' + (day.closed ? 'off closed' : 'tap'), h);
    if (!day.closed) td.onclick = function () { mgrOpenDay(day.short); };
    tr.appendChild(td);
  });
  return tr;
}

function mgrDayReset() { mgrDayDraft = { text: '', title: '', from: '', to: '', staff: true }; }

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
    b.onclick = function () { if (mgrDayBusy) return; mgrDayCtx.mode = m[0]; renderMgrDay(); };
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
    go = mgrEl('button', 'btn btn-sm mgr-day-go'); go.type = 'button'; go.textContent = mgrDayBusy ? 'שומר…' : 'הוסף הערה';
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
    go = mgrEl('button', 'btn btn-sm mgr-day-go'); go.type = 'button'; go.textContent = mgrDayBusy ? 'שומר…' : (ctx.doubt ? 'הוסף שוב (ייתכן שכבר נוסף)' : 'הוסף אירוע');
    go.onclick = mgrDayEventRun;
    sheet.appendChild(go);
    sheet.appendChild(hint);
  }
  if (go) go.disabled = mgrDayBusy;
  box.appendChild(sheet);
}

/** After an answer that did not say "added": say why (a timeout may have landed — check before trying again). */
function mgrDayFailed(r, what) {
  if (r && r.transport) showToast('לא התקבלה תשובה מהשרת. ייתכן ש' + what + ' נוסף — לבדוק (↻ רענון) לפני שמנסים שוב.', 'error');
  else showToast('לא נוסף: ' + (r ? r.error : ''), 'error');
  renderMgrDay();
}

function mgrDayNoteRun() {
  if (mgrDayBusy || !mgrDayCtx || !mgrBoardData) return;
  var text = mgrFold(mgrDayDraft.text), res = mgrBoardData, short = mgrDayCtx.short, week = String(res.week || '');
  if (text.length < 1 || text.length > 120) { showToast('ההערה צריכה להיות בין תו אחד ל-120 תווים.', 'error'); return; }
  var ctx = mgrDayCtx, expectSent = mgrInfoOf(res, short);
  mgrDayBusy = true;
  mgrBoardSeq++;   // a reload started before this write must not land after it
  renderMgrDay();
  var gen = loginGen;
  api('mgrDayNote', { week: week, day: short, expect: expectSent, text: text }, { post: true, ms: 60000 }).then(function (r) {
    if (gen !== loginGen) return;
    mgrDayBusy = false;
    if (r && r.success) {
      mgrDaySetInfo(week, short, r.value);
      showToast('ההערה נוספה ✓', 'success');
      if (mgrDayCtx === ctx) { mgrDayCtx = null; mgrDayReset(); }   // only the dialog that sent it; another day's dialog stays
      renderMgrDay();
    } else {
      mgrDayCheck = r && r.transport && mgrDayCtx === ctx ? { ctx: ctx, short: short, expect: expectSent, text: text } : null;
      mgrDayFailed(r, 'ההערה');
      loadMgrBoard();   // the cell may have changed meanwhile ("התא השתנה") — the next try compares with the current one
    }
  });
}

/** Writes the cell text the server answered into the board on screen (only when it is still the same week) and redraws the table. */
function mgrDaySetInfo(week, short, value) {
  if (!mgrBoardData || String(mgrBoardData.week || '') !== week || !mgrHasInfo(mgrBoardData)) { loadMgrBoard(); return; }
  mgrBoardSeq++;   // a reload still in flight is older than this write
  mgrBoardData.info[short] = String(value == null ? '' : value);
  renderMgrAssign();
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
  mgrBoardSeq++;   // a reload started before this write must not land after it
  renderMgrDay();
  var gen = loginGen;
  api('mgrAddEvent', { week: week, day: short, title: title, from: from, to: to, staff: staff }, { post: true, ms: 60000 }).then(function (r) {
    if (gen !== loginGen) return;
    mgrDayBusy = false;
    if (r && r.success) {
      if (r.note) {   // not a calendar event: written as a day note
        mgrDaySetInfo(week, short, r.value);
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
    } else {
      mgrDayFailed(r, 'האירוע');
    }
  });
}

/* ---- the picker (a bottom sheet) ---- */
function mgrOpenPicker(label, short) {
  mgrPickCtx = { label: label, day: short }; mgrPickTime = ''; mgrAddOpen = false; mgrPickRepeat = false;
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
    var kindSel = mgrEl('select', 'mgr-addp-kind', '<option value="trainee">מתלמד</option><option value="staff">איש צוות</option><option value="instructor">מנחה</option>');
    var go = mgrEl('button', 'btn btn-sm mgr-addp-go'); go.type = 'button'; go.textContent = 'הוסף';
    go.onclick = function () { mgrAddPersonRun(nameIn.value, kindSel.value); };
    var no = mgrEl('button', 'btn btn-secondary btn-sm'); no.type = 'button'; no.textContent = 'ביטול';
    no.onclick = function () { mgrAddOpen = false; renderMgrPicker(); };
    add.appendChild(nameIn); add.appendChild(kindSel);
    var acts = mgrEl('div', 'mgr-acts'); acts.appendChild(go); acts.appendChild(no);
    add.appendChild(acts);
  }
  sheet.appendChild(add);
  box.appendChild(sheet);
}

function mgrAddPersonRun(name, kind) {
  name = mgrFold(name);
  if (mgrAdding) return;
  if (name.length < 2 || name.length > 40) { showToast('השם צריך להיות בין 2 ל-40 תווים.', 'error'); return; }
  if (kind !== 'trainee' && kind !== 'instructor' && kind !== 'staff') kind = 'trainee';
  mgrAdding = true;
  showToast('מוסיף...', 'info');
  var gen = loginGen;
  api('mgrAddPerson', { name: name, kind: kind }, { post: true }).then(function (r) {
    if (gen !== loginGen) return;
    mgrAdding = false;
    if (r && r.success) {
      showToast('נוסף: ' + (r.name || name) + (kind === 'trainee' ? ' (מתלמד — מופיע בשורות ההתלמדות)' : ''), 'success');
      mgrAddOpen = false;
      loadMgrBoard();   // the list gets the new person; the marks stay
    } else if (r && r.transport) {
      showToast('לא התקבלה תשובה מהשרת. לבדוק אם האדם נוסף (↻ רענון) לפני שמנסים שוב.', 'error');
    } else {
      showToast('לא נוסף: ' + (r ? r.error : ''), 'error');
    }
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
  sv.textContent = mgrSaving ? 'שומר…' : (n === 1 ? '💾 שמור שינוי אחד' : '💾 שמור ' + n + ' שינויים');
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
        mgrBoardSeq++;   // an older reload still in flight must not overwrite this newer board
        mgrSyncPending(nb);
        mgrBoardData = nb;
        if (Array.isArray(r.recurring)) mgrBoardData.recurring = r.recurring;   // stage 6: the fixed people after this batch
        if (r.recurNote) mgrBoardData.recurNote = String(r.recurNote);   // stays above the table until the board is read again
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
  var go = mgrEl('button', 'btn btn-sm mgr-day-go mgr-row-go'); go.type = 'button'; go.textContent = mgrToolBusy ? 'מוסיף…' : 'הוסף שורה';
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
  mgrToolBusy = true; mgrToolErr = '';
  renderMgrTool();
  var gen = loginGen;
  api('mgrAddRow', params, { post: true, ms: 60000 }).then(function (r) {
    if (gen !== loginGen) return;
    mgrToolBusy = false;
    if (r && r.success) {
      showToast('השורה נוספה: ' + (r.label || name) + ' ✓', 'success');
      mgrTool = null; mgrToolErr = ''; mgrRowDraft = { name: '', from: '', to: '' };
      renderMgrTool();
      loadMgrBoard();   // ONE reload: the new row is on the board
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
    var cb = mgrEl('button', 'btn btn-secondary btn-sm mgr-rec-cancel'); cb.type = 'button'; cb.textContent = 'בטל'; cb.disabled = mgrToolBusy;
    cb.onclick = function () { mgrRecurringCancel(rc); };
    line.appendChild(cb);
    sheet.appendChild(line);
  });
  if (recs.length) sheet.appendChild(mgrEl('div', 'mgr-legend', 'ביטול קבוע לא נוגע בתאים שכבר בלוח.'));
  var er = mgrToolErrEl();
  if (er) sheet.appendChild(er);
  var ok = mgrRowRemovable(row);
  var rm = mgrEl('button', 'btn btn-secondary mgr-row-remove'); rm.type = 'button'; rm.textContent = '🗑 להסיר את השורה';
  rm.disabled = !ok || mgrToolBusy;
  rm.onclick = function () { if (!mgrRowRemovable(row)) return; mgrRowRemoveAsk(row.label); };   // a disabled button never fires, but the rule stays here too
  sheet.appendChild(rm);
  sheet.appendChild(mgrEl('div', 'mgr-legend mgr-row-rmhint', ok ? 'הסרת שורה מוחקת גם את האנשים הקבועים שלה.' : 'אפשר להסיר רק שורה ריקה — בלי שיבוצים בלוח ובלי סימונים שעוד לא נשמרו.'));
}

function mgrRecurringCancel(rc) {
  if (mgrToolBusy) return;
  mgrToolBusy = true; mgrToolErr = '';
  renderMgrTool();
  var gen = loginGen;
  api('mgrRecurringRemove', { label: rc.label, dow: rc.dow, empId: rc.empId }, { post: true, ms: 60000 }).then(function (r) {
    if (gen !== loginGen) return;
    mgrToolBusy = false;
    if (r && r.success) {
      showToast('הקבוע בוטל ✓', 'success');
      if (mgrBoardData && Array.isArray(r.recurring)) {
        mgrBoardSeq++;   // a reload still in flight is older than this write
        mgrBoardData.recurring = r.recurring;
        renderMgrAssign();
        renderMgrTool();
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
  mgrToolBusy = true; mgrToolErr = '';
  renderMgrTool();
  var gen = loginGen;
  api('mgrRemoveRow', { week: String(mgrBoardData.week || ''), label: label }, { post: true, ms: 60000 }).then(function (r) {
    if (gen !== loginGen) return;
    mgrToolBusy = false;
    if (r && r.success) {
      var n = Number(r.droppedRecurring) || 0;
      showToast('השורה הוסרה ✓' + (n ? ' · בוטלו ' + n + ' קבועים' : ''), 'success');
      mgrTool = null; mgrToolErr = '';
      renderMgrTool();
      loadMgrBoard();   // ONE reload: the row is gone from the board
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
  return ds.length === 6 && MGR_DAYS6.every(function (x) { return ds.indexOf(x) !== -1; }) ? 'כל הימים' : ds.join(' ');
}

function mgrToolTypes(sheet) {
  if (!mgrTypeDraft) mgrTypeDraft = mgrTypeDraftNew();
  sheet.appendChild(mgrEl('div', 'mgr-legend', 'סוג שכבוי לא נבנה בלוח. אפשר להדליק אותו שוב בכל זמן.'));
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
        '<small><bdi>' + esc(t.from) + '–' + esc(t.to) + '</bdi> · ' + esc(mgrTypeDays(t)) + (t.location ? ' · ' + esc(t.location) : '') + '</small></div>');
      var sw = mgrEl('button', 'mgr-sw ' + (t.active ? 'on' : 'off')); sw.type = 'button';
      sw.textContent = t.active ? 'פעיל' : 'כבוי';
      sw.setAttribute('aria-pressed', t.active ? 'true' : 'false');
      sw.disabled = mgrToolBusy;
      sw.onclick = function () { mgrTypeSwitch(t); };
      line.appendChild(sw);
      sheet.appendChild(line);
    });
    mgrToolTypeForm(sheet);
  }
}

function mgrTypeSwitch(t) {
  if (mgrToolBusy) return;
  mgrToolBusy = true; mgrToolErr = '';
  renderMgrTool();
  var gen = loginGen;
  api('mgrShiftTypeSet', { id: t.id, active: !t.active }, { post: true, ms: 60000 }).then(function (r) {
    if (gen !== loginGen) return;
    mgrToolBusy = false;
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
  var loc = mgrEl('select', 'mgr-tin mgr-type-loc', '<option value="חנות">חנות</option><option value="משרד">משרד</option><option value="מועדון">מועדון</option>');
  loc.value = d.location;
  loc.onchange = function () { d.location = loc.value; };
  f.appendChild(loc);
  var acts = mgrEl('div', 'mgr-acts');
  var go = mgrEl('button', 'btn btn-sm mgr-type-add'); go.type = 'button'; go.textContent = mgrToolBusy ? 'מוסיף…' : 'הוסף סוג'; go.disabled = mgrToolBusy;
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
  else if (['חנות', 'משרד', 'מועדון'].indexOf(d.location) === -1) bad = 'לבחור מיקום.';
  if (bad) { mgrToolFail(bad); return; }
  mgrToolBusy = true; mgrToolErr = '';
  renderMgrTool();
  var gen = loginGen;
  api('mgrShiftTypeAdd', { name: name, from: from, to: to, days: days, location: d.location }, { post: true, ms: 60000 }).then(function (r) {
    if (gen !== loginGen) return;
    mgrToolBusy = false;
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
