/**
 * FREAK TLV — the schedule app · the "📋 משימות" tab (S-TSK v1, 20/10/2026)
 *
 * Chris, 19/10 ("תבנה (מומלץ)"): whoever opens and whoever closes ticks on the phone what was done; the shift summary is written here
 * instead of the form; every task gets a person and a time; managers see on one screen what opened, what closed and what is still
 * open. The server is 29_Tasks.gs (GET tasksMe / mgrTasks, POST taskTick / taskSummary / taskAdd / taskSet — 18_StaffApi.gs).
 *
 * Loaded after app.js (index.html), and uses its api(), esc(), openAppModal(), showToast(), clockTapId(), clockOwner(), clockNowText(),
 * AppState and loginGen. app.js calls tasksOpen() when the tab opens, tasksReset() + tskQLoad() + tasksPrefetch() at a login, and
 * tskQWaitingCount() before a logout — each behind a typeof check, so the app works without this file.
 *
 * Rules kept here:
 * - A press is written to the phone's storage BEFORE it is sent (freak_tasks_queue, per person — an identity hash, never the key), and
 *   leaves the phone only when the server recorded it (or says it already did: the same tap id is answered once), or when the server
 *   refused it for good — then it is said on the tab with the server's words until "✕ הבנתי". Nothing is deleted at logout.
 * - "Try again" and "no answer" keep the press: it goes again by itself (every minute while the app is open, and when the network comes
 *   back), with the same tap id. One press at a time, in the order pressed.
 * - A task marked done waits 5 seconds on the phone ("ביטול" sends nothing — as in the count app).
 * - What reaches the screen goes through esc(); nothing typed is ever put inside an onclick (only ids the server's own patterns allow).
 * - Every localStorage access is inside try/catch (iron rule 5); no alert / confirm / prompt (iron rule 4).
 * - The system sends nothing to WhatsApp: "📤 לשלוח לקבוצה" opens the phone's share sheet with the text; the person sends it.
 */

var TSK_Q_KEY = 'freak_tasks_queue';
var TSK_RESEND_MS = 60000;    // a press that waits is sent again this often while the app is open
var TSK_HOLD_MS = 5000;       // a task marked done waits this long: "ביטול" within it sends nothing
var TSK_ANSWERED = 100;       // the tap ids answered lately, kept in the store (another window's copy never comes back)
var TSK_STALE_MS = 60000;     // opening the tab reads again when the last answer is older than this
var TSK_LIST = { OPEN: 'פתיחה', CLOSE: 'סגירה' };
var TSK_ST = { DONE: 'בוצע', NOT_DONE: 'לא בוצע', NOT_NEEDED: 'לא צריך', CANCELLED: 'בוטל', OPEN: 'פתוחה' };
var TSK_CARD_RE = /^[A-Z]{2,4}-\d{2,3}$/;
var TSK_TASK_RE = /^TSK-\d{14}-[0-9a-f]{4}$/;
var TSK_KEY_RE = /^[a-z]{1,12}$/;
var TSK_EMP_RE = /^EMP-\d{3}$/;

var tskData = null;       // the last tasksMe answer (memory only)
var tskAt = 0;            // when it came (Date.now())
var tskState = '';        // '' | 'loading' | 'error'
var tskErr = '';
var tskSeq = 0;           // only the latest read is drawn
var tskQ = [];            // this person's presses the server has not answered, in order: {tapId, action, params, label, deviceAt, holdUntil, wait, tries, why}
var tskRefused = [];      // presses refused for good: {tapId, label, error}
var tskSending = '';      // the tap id on its way ('' = none)
var tskMsg = null;        // {ok, text} — the last answer's words
var tskFold = {};         // which folds are open: opening, closing, add, team, mgr
var tskPick = '';         // the card whose "not done" reasons are open: "<list>|<id>"
var tskDraft = tskDraftNew();
var tskMgrData = null, tskMgrState = '', tskMgrErr = '', tskMgrSeq = 0;
var tskResendT = 0;       // the resend timer (0 = off)
var tskHoldT = 0;         // the timer of a held press

function tskDraftNew() {
  return { notes: {}, add: { text: '', to: 'next', due: 'none', time: '' },
           sum: { calls: '', inc: [], note: '', open: [{ text: '', to: 'next' }] } };
}
function tskEl(id) { return document.getElementById(id); }
function tskList(a) { return Array.isArray(a) ? a.filter(function (x) { return x && typeof x === 'object'; }) : []; }
function tskStr(v) { return String(v == null ? '' : v); }
function tskN(v) { return Number(v) || 0; }

/* ---- the queue on the phone ---- */
function tskStoreRead() {
  var o = null;
  try { var raw = window.localStorage.getItem(TSK_Q_KEY); o = raw ? JSON.parse(raw) : null; } catch (e) { o = null; }
  if (!o || typeof o !== 'object' || o.v !== 1) o = { v: 1, byOwner: {}, refused: {}, answered: [] };
  if (!o.byOwner || typeof o.byOwner !== 'object') o.byOwner = {};
  if (!o.refused || typeof o.refused !== 'object') o.refused = {};
  if (!Array.isArray(o.answered)) o.answered = [];
  return o;
}
function tskStoreWrite(o) {
  try {
    var raw = JSON.stringify(o);
    window.localStorage.setItem(TSK_Q_KEY, raw);
    return window.localStorage.getItem(TSK_Q_KEY) === raw;
  } catch (e) { return false; }
}
/** A stored press as the queue keeps it, or null. */
function tskQItem(it) {
  if (!it || typeof it !== 'object' || !/^[A-Za-z0-9-]{8,40}$/.test(tskStr(it.tapId))) return null;
  if (['taskTick', 'taskSummary', 'taskAdd', 'taskSet'].indexOf(it.action) === -1 || !it.params || typeof it.params !== 'object') return null;
  return { tapId: it.tapId, action: it.action, params: it.params, label: tskStr(it.label).slice(0, 140), deviceAt: tskStr(it.deviceAt),
           holdUntil: Number(it.holdUntil) || 0, wait: !!it.wait, tries: Number(it.tries) || 0, why: tskStr(it.why) };
}
/**
 * Write this person's queue: the store is read again and merged by tap id (memory ∪ stored, minus what was answered), so two windows
 * of the app never erase each other's presses. Returns false when the phone's storage did not keep it (said on the tab).
 */
var tskNoStore = false;
function tskQSave(answeredId, refusedItem, dropId) {
  var owner = typeof clockOwner === 'function' ? clockOwner() : '';
  if (!owner) return false;
  var o = tskStoreRead();
  if (answeredId) { o.answered.push(answeredId); o.answered = o.answered.slice(-TSK_ANSWERED); }
  var gone = {};
  o.answered.forEach(function (id) { gone[id] = true; });
  if (dropId) gone[dropId] = true;
  var merged = [], seen = {};
  tskQ.concat(tskList(o.byOwner[owner]).map(tskQItem).filter(Boolean)).forEach(function (it) {
    if (gone[it.tapId] || seen[it.tapId]) return;
    seen[it.tapId] = true;
    merged.push(it);
  });
  // the order pressed: memory first (this window's order), then what only the store had
  tskQ = merged;
  if (merged.length) o.byOwner[owner] = merged; else delete o.byOwner[owner];
  var ref = tskRefused.concat(tskList(o.refused[owner]));
  if (refusedItem) ref.push(refusedItem);
  var refSeen = {};
  // review SF5 / N3: the lines of this window and of the store, merged by tap id (a storage that refuses writes never makes one vanish);
  // a tap id that is not of our own pattern is dropped (it would reach an onclick)
  tskRefused = ref.filter(function (r) {
    if (!r || !/^[A-Za-z0-9-]{8,40}$/.test(tskStr(r.tapId)) || refSeen[r.tapId] || tskGone[r.tapId]) return false;
    refSeen[r.tapId] = true; return true;
  }).slice(-20);
  if (tskRefused.length) o.refused[owner] = tskRefused; else delete o.refused[owner];
  tskNoStore = !tskStoreWrite(o);
  return !tskNoStore;
}
/** At a login: this person's stored presses and refusals come back; they are sent at once. */
function tskQLoad() {
  var owner = typeof clockOwner === 'function' ? clockOwner() : '';
  var o = tskStoreRead();
  tskQ = owner ? tskList(o.byOwner[owner]).map(tskQItem).filter(Boolean) : [];
  tskRefused = owner ? tskList(o.refused[owner]).filter(function (r) { return /^[A-Za-z0-9-]{8,40}$/.test(tskStr(r.tapId)); }) : [];
  if (tskQ.length) { tskQ.forEach(function (it) { it.why = 'net'; }); tskSendNext(); }
}
/** The presses of this person still on the phone (for the logout warning). */
function tskQWaitingCount() { return tskQ.length; }
/** Review SF5: did the phone's storage refuse the last write? Then the presses are NOT kept after a logout (the warning says so). */
function tskQLost() { return tskNoStore; }

/** A press: kept on the phone first, drawn at once, then sent. hold: wait TSK_HOLD_MS before sending (the task's undo). */
function tskPress(action, params, label, hold) {
  var it = { tapId: typeof clockTapId === 'function' ? clockTapId() : String(Date.now()) + 'tsk0000', action: action, params: params,
             label: tskStr(label).slice(0, 140), deviceAt: typeof clockNowText === 'function' ? clockNowText() : '',
             holdUntil: hold ? Date.now() + TSK_HOLD_MS : 0, wait: false, tries: 0, why: '' };
  tskQ.push(it);
  tskQSave();
  tskMsg = null;
  tasksRender();
  tskSendNext();
  return it.tapId;
}
/** "ביטול" of a held press: it never left the phone, so it is simply removed. */
function tskUndo(tapId) {
  var it = tskQ.filter(function (x) { return x.tapId === tapId; })[0];
  if (!it || tskSending === tapId || !(it.holdUntil > Date.now())) return false;
  tskQ = tskQ.filter(function (x) { return x.tapId !== tapId; });
  tskQSave(tapId);   // review N2: kept among the answered ids — another window of the phone drops its copy too
  tskMsg = { ok: true, text: 'בוטל — לא נשלח כלום' };
  tasksRender();
  return true;
}
/** "✕ הבנתי" on a refused press. */
var tskGone = {};   // the refusal lines dismissed in this window (merged copies never bring them back)
function tskDismiss(tapId) {
  tskGone[tapId] = true;
  tskRefused = tskRefused.filter(function (r) { return r.tapId !== tapId; });
  var owner = typeof clockOwner === 'function' ? clockOwner() : '';
  var o = tskStoreRead();
  if (owner) { if (tskRefused.length) o.refused[owner] = tskRefused; else delete o.refused[owner]; tskStoreWrite(o); }
  tasksRender();
}

/** Send the first press that may go now — one at a time, in order. */
function tskSendNext() {
  if (tskSending) return;
  var now = Date.now(), it = tskQ[0];
  if (!it) { tskTimers(); return; }
  if (it.holdUntil > now) {
    if (!tskHoldT) tskHoldT = setTimeout(function () { tskHoldT = 0; tskSendNext(); }, it.holdUntil - now + 20);
    return;
  }
  if (it.wait && it.nextAt && it.nextAt > now) { tskTimers(); return; }
  var gen = loginGen;
  tskSending = it.tapId;
  var body = {};
  Object.keys(it.params).forEach(function (k) { body[k] = it.params[k]; });
  body.tapId = it.tapId;
  body.deviceAt = it.deviceAt;
  api(it.action, body, { post: true }).then(function (res) {
    if (gen !== loginGen) return;   // a logout in the meantime: the press stays stored, under its person
    tskSending = '';
    tskAnswer(it, res || {});
  });
}
function tskAnswer(it, res) {
  if (res.success) {
    tskQ = tskQ.filter(function (x) { return x.tapId !== it.tapId; });
    tskQSave(it.tapId);
    if (res.lists) { tskData = res; tskAt = Date.now(); }
    tskMsg = { ok: true, text: tskStr(res.message) || '✓ נשמר' };
    tasksRender();
    tskSendNext();
    return;
  }
  // review SF6: an action this server does not know is not a refusal of the press — the server is older than this phone (an undo of a
  // release): the press waits on the phone until the server that knows it is back
  var unknown = /^פעולה לא מוכרת/.test(tskStr(res.error));
  if (res.transport || res.retry || unknown) {
    it.wait = true;
    it.tries++;
    it.why = res.transport ? 'net' : 'retry';
    it.nextAt = Date.now() + TSK_RESEND_MS;
    tskQSave();
    tskMsg = { ok: false, text: res.transport ? '⏳ אין קליטה — הסימון שמור בטלפון ויישלח לבד'
                               : unknown ? '⏳ השרת עוד לא מכיר את המשימות — הסימון שמור בטלפון ויישלח כשיחזור'
                               : '⏳ ' + tskStr(res.error) + ' — יישלח שוב בעוד דקה' };
    tasksRender();
    tskTimers();
    return;
  }
  // refused for good: off the queue, said with the server's words until "✕ הבנתי"
  tskQ = tskQ.filter(function (x) { return x.tapId !== it.tapId; });
  var back = tskDraftBack(it);   // review SF7: what was typed in a refused summary / task goes back into its form
  tskQSave(it.tapId, { tapId: it.tapId, label: it.label + (back ? ' · מה שהוקלד חזר לטופס' : ''), error: tskStr(res.error).slice(0, 200) });
  tskMsg = null;
  tasksRender();
  tskSendNext();
}
/**
 * Review SF7: a summary or a new task the server refused for good is typed text that was never recorded — it goes back into its form
 * (only when that form is empty: nothing typed since is written over), so it can be fixed and sent again. Returns true when it did.
 */
function tskDraftBack(it) {
  var p = it.params || {};
  if (it.action === 'taskSummary') {
    var s = tskDraft.sum;
    if (s.calls || s.note || s.inc.length || s.open.some(function (x) { return tskStr(x.text).trim(); })) return false;
    var open = tskList(p.open).map(function (x) { return { text: tskStr(x.text), to: tskStr(x.to) || 'next' }; });
    tskDraft.sum = { calls: tskStr(p.calls), inc: Array.isArray(p.incidents) ? p.incidents.slice() : [], note: tskStr(p.note),
                     open: open.length ? open : [{ text: '', to: 'next' }] };
    tskFold.closing = true;
    return true;
  }
  if (it.action === 'taskAdd') {
    if (tskStr(tskDraft.add.text).trim()) return false;
    tskDraft.add = { text: tskStr(p.text), to: tskStr(p.to) || 'next', due: 'none', time: '' };
    tskFold.add = true;
    return true;
  }
  return false;
}
/** The resend timer runs only while something waits. */
function tskTimers() {
  var waiting = tskQ.some(function (x) { return x.wait; });
  if (waiting && !tskResendT) tskResendT = setInterval(function () { tskQ.forEach(function (x) { x.nextAt = 0; }); tskSendNext(); }, TSK_RESEND_MS);
  if (!waiting && tskResendT) { clearInterval(tskResendT); tskResendT = 0; }
}
try { window.addEventListener('online', function () { tskQ.forEach(function (x) { x.nextAt = 0; }); tskSendNext(); }); } catch (e) {}

/* ---- reading ---- */
function tasksReset() {
  tskData = null; tskAt = 0; tskState = ''; tskErr = ''; tskSeq++; tskQ = []; tskRefused = []; tskSending = ''; tskMsg = null;
  tskFold = {}; tskPick = ''; tskDraft = tskDraftNew(); tskMgrData = null; tskMgrState = ''; tskMgrErr = ''; tskMgrSeq++; tskGone = {};
  if (tskResendT) { clearInterval(tskResendT); tskResendT = 0; }
  if (tskHoldT) { clearTimeout(tskHoldT); tskHoldT = 0; }
  ['tskHead', 'tskQueue', 'tskMine', 'tskOpening', 'tskClosing', 'tskAdd', 'tskTeam', 'tskMgr'].forEach(function (id) { var el = tskEl(id); if (el) el.innerHTML = ''; });
  tskBadge();
}
/** The tab opened: draw what is known at once, read again when it is older than a minute. */
function tasksOpen() {
  tasksRender();
  if (!tskData || Date.now() - tskAt > TSK_STALE_MS) tasksLoad();
  tskSendNext();
}
/** Right after a login: the screen is read in the background (the badge on the tab). */
function tasksPrefetch() { tasksLoad(); }
function tasksLoad() {
  var seq = ++tskSeq, gen = loginGen;
  tskState = 'loading';
  tasksRender();
  api('tasksMe').then(function (res) {
    if (seq !== tskSeq || gen !== loginGen) return;
    if (res && res.success) { tskData = res; tskAt = Date.now(); tskState = ''; tskErr = ''; }
    else { tskState = 'error'; tskErr = res && res.transport ? 'אין חיבור לשרת — מה שמסומן נשמר בטלפון' : tskStr(res && res.error) || 'שגיאה בטעינה'; }
    tasksRender();
  });
}

/* ---- presses ---- */
function tskDay() { return tskData ? tskStr(tskData.today) : ''; }
function tskCardOf(list, id) {
  var l = tskData && tskData.lists ? (list === TSK_LIST.OPEN ? tskData.lists.opening : tskData.lists.closing) : null;
  return l ? tskList(l.cards).filter(function (c) { return c.id === id; })[0] || null : null;
}
/** ✓ on a card (found: what the walk-round found, among the card's choices). */
function tskTick(list, id, state, reason, found) {
  if (!tskData || !TSK_CARD_RE.test(tskStr(id)) || (list !== TSK_LIST.OPEN && list !== TSK_LIST.CLOSE)) return;
  var card = tskCardOf(list, id);
  var p = { day: tskDay(), list: list, cardId: id, state: state };
  var note = tskStr(tskDraft.notes[list + '|' + id]).trim();
  if (state === TSK_ST.NOT_DONE) { p.reason = reason; if (note) p.note = note; }
  if (found) p.found = found;
  tskPick = '';
  tskPress('taskTick', p, (state === TSK_ST.DONE ? '✓ ' : '✗ ') + (card ? card.text : id) + (found ? ' · נמצא: ' + found : ''));
}
/** ✗ on a card: the reasons open under it (one more tap sends). */
function tskNotDone(list, id) {
  tskPick = tskPick === list + '|' + id ? '' : list + '|' + id;
  tasksRender();
}
function tskNote(list, id, v) { tskDraft.notes[list + '|' + id] = tskStr(v).slice(0, 80); }
/** A reason chip: "other" needs a few words first (the server checks too). */
function tskReason(list, id, key) {
  var chip = tskList(tskData && tskData.reasons).filter(function (c) { return c.key === key; })[0];
  if (!chip) return;
  if (chip.note && tskStr(tskDraft.notes[list + '|' + id]).trim().length < 2) {
    tskMsg = { ok: false, text: 'ב"אחר" צריך לכתוב במילה או שתיים למה' };
    tasksRender();
    return;
  }
  tskTick(list, id, TSK_ST.NOT_DONE, key);
}
/** A task: done (held 5 s — "ביטול"), not needed, cancelled (a confirm first). */
function tskTaskSet(id, state) {
  if (!TSK_TASK_RE.test(tskStr(id))) return;
  var t = tskTaskOf(id);
  var label = (state === TSK_ST.DONE ? '✓ ' : '· ') + state + ': ' + (t ? t.text : '');
  if (state === TSK_ST.CANCELLED) {
    openAppModal('לבטל את המשימה?', (t ? t.text + '\n' : '') + 'המשימה תיסגר לכולם, ויירשם שביטלת אותה.', false, 'לבטל', function () {
      tskPress('taskSet', { taskId: id, state: state }, label);
    });
    return;
  }
  tskPress('taskSet', { taskId: id, state: state }, label, state === TSK_ST.DONE);
}
function tskTaskOf(id) {
  if (!tskData || !tskData.tasks) return null;
  var all = tskList(tskData.tasks.mine).concat(tskList(tskData.tasks.team), tskList(tskData.tasks.opening), tskList(tskData.tasks.closing));
  return all.filter(function (t) { return t.id === id; })[0] || null;
}
/** The drafts: what is typed survives every redraw. */
function tskDraftSet(path, v) {
  var p = tskStr(path).split('.');
  if (p[0] === 'add' && ['text', 'to', 'due', 'time'].indexOf(p[1]) !== -1) tskDraft.add[p[1]] = tskStr(v).slice(0, 120);
  else if (p[0] === 'sum' && (p[1] === 'calls' || p[1] === 'note')) tskDraft.sum[p[1]] = tskStr(v).slice(0, p[1] === 'note' ? 80 : 3);
  else if (p[0] === 'open' && /^\d$/.test(p[1]) && tskDraft.sum.open[+p[1]] && (p[2] === 'text' || p[2] === 'to')) tskDraft.sum.open[+p[1]][p[2]] = tskStr(v).slice(0, 120);
}
function tskCalls(d) {
  var n = parseInt(tskDraft.sum.calls, 10);
  n = (isNaN(n) ? 0 : n) + d;
  tskDraft.sum.calls = String(Math.max(0, Math.min(999, n)));
  tasksRender();
}
function tskInc(key) {
  if (!TSK_KEY_RE.test(tskStr(key))) return;
  var inc = tskDraft.sum.inc;
  if (key === 'none') tskDraft.sum.inc = inc.indexOf('none') !== -1 ? [] : ['none'];
  else {
    inc = inc.filter(function (k) { return k !== 'none'; });
    tskDraft.sum.inc = inc.indexOf(key) !== -1 ? inc.filter(function (k) { return k !== key; }) : inc.concat([key]);
  }
  tasksRender();
}
function tskOpenLine() {
  if (tskDraft.sum.open.length < 8) tskDraft.sum.open.push({ text: '', to: 'next' });
  tasksRender();
}
/** 💾 the summary: checked on the phone first (the server checks again), then one press. */
function tskSaveSummary() {
  var s = tskDraft.sum, err = '';
  if (!/^\d{1,3}$/.test(tskStr(s.calls).trim())) err = 'כמה שיחות גבייה — מספר (0 אם לא היו)';
  else if (!s.inc.length) err = 'לסמן אם היה אירוע חריג (או "לא היה")';
  if (err) { tskMsg = { ok: false, text: err }; tasksRender(); return; }
  var open = s.open.filter(function (x) { return tskStr(x.text).trim().length >= 2; })
    .map(function (x) { return { text: tskStr(x.text).trim(), to: x.to === 'opener' || TSK_EMP_RE.test(tskStr(x.to)) ? x.to : 'next' }; });
  var p = { day: tskDay(), calls: tskStr(s.calls).trim(), incidents: s.inc.slice(), note: tskStr(s.note).trim(), open: open };
  tskDraft.sum = { calls: '', inc: [], note: '', open: [{ text: '', to: 'next' }] };
  tskPress('taskSummary', p, '📝 סיכום משמרת' + (open.length ? ' + ' + open.length + ' משימות' : ''));
}
/** ＋ a new task. */
function tskAddTask() {
  var a = tskDraft.add, text = tskStr(a.text).trim();
  if (text.length < 2) { tskMsg = { ok: false, text: 'לכתוב מה המשימה' }; tasksRender(); return; }
  var to = a.to === 'opener' || a.to === 'next' || TSK_EMP_RE.test(tskStr(a.to)) ? a.to : 'next';
  var due = '';
  if (a.due === 'today' || a.due === 'tomorrow') {
    due = a.due === 'today' ? tskDay() : tskNextDay(tskDay());
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(tskStr(a.time))) due += ' ' + a.time;
  }
  tskDraft.add = { text: '', to: a.to, due: a.due, time: '' };
  tskPress('taskAdd', { text: text, to: to, due: due }, '＋ ' + text);
}
function tskNextDay(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tskStr(iso));
  if (!m) return '';
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}
function tskFoldSet(name, open) { tskFold[name] = !!open; if (name === 'mgr' && open && !tskMgrData && tskMgrState !== 'loading') tskMgrLoad(); }

/* ---- the share text (the person sends it; the system sends nothing) ---- */
function tskShareText() {
  if (!tskData) return '';
  var d = tskData, s = d.summary, out = ['סיכום משמרת · ' + tskStr(d.todayLabel) + (s && s.by ? ' · ' + s.by : '')];
  if (s) {
    out.push('שיחות גבייה: ' + tskStr(s.calls));
    out.push('אירוע חריג: ' + (Array.isArray(s.incidents) ? s.incidents.join(', ') : ''));
    if (s.note) out.push('הערה: ' + s.note);
  }
  var cl = d.lists && d.lists.closing ? d.lists.closing : { cards: [], done: 0, total: 0 };
  out.push('רשימת סגירה: ' + tskN(cl.done) + ' מתוך ' + tskN(cl.total));
  tskList(cl.cards).forEach(function (c) { if (c.state === TSK_ST.NOT_DONE) out.push('לא בוצע: ' + c.text + (c.reason ? ' (' + c.reason + ')' : '')); });
  // the open lines of this work day's summaries (the task's day is its summary's day — also after midnight)
  tskList(d.tasks && d.tasks.team).forEach(function (t) { if (t.fromSummary && t.day === d.today) out.push('נשאר פתוח: ' + t.text + ' → ' + t.toLabel); });
  return out.join('\n');
}
function tskShare() {
  var text = tskShareText();
  if (!text) return;
  try {
    if (navigator.share) { navigator.share({ text: text }).catch(function () {}); return; }
  } catch (e) {}
  try { window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener'); } catch (e2) {}
}

/* ---- the managers' fold ---- */
function tskMgrLoad() {
  var seq = ++tskMgrSeq, gen = loginGen;
  tskMgrState = 'loading';
  tasksRender();
  api('mgrTasks').then(function (res) {
    if (seq !== tskMgrSeq || gen !== loginGen) return;
    if (res && res.success) { tskMgrData = res; tskMgrState = ''; tskMgrErr = ''; }
    else { tskMgrState = 'error'; tskMgrErr = res && res.transport ? 'אין חיבור לשרת' : tskStr(res && res.error) || 'שגיאה'; }
    tasksRender();
  });
}

/* ---- drawing ---- */
/** The nav badge: my open tasks + the cards left on my list today. */
function tskBadge() {
  var b = tskEl('tasksBadge');
  if (!b) return;
  var n = 0;
  if (tskData) {
    n += tskList(tskData.tasks && tskData.tasks.mine).filter(function (t) { return t.state === TSK_ST.OPEN; }).length;
    if (tskData.roles && tskData.roles.opening && tskData.lists) n += tskData.lists.opening.left || 0;
    if (tskData.roles && tskData.roles.closing && tskData.lists) n += tskData.lists.closing.left || 0;
  }
  b.textContent = n ? String(n) : '';
  b.style.display = n ? 'inline-block' : 'none';
}
/** A section is drawn unless the person is typing in it (the typed text and the cursor stay). */
function tskPut(id, html) {
  var el = tskEl(id);
  if (!el) return;
  var a = document.activeElement;
  if (a && a !== document.body && typeof el.contains === 'function' && el.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(tskStr(a.tagName))) return;
  el.innerHTML = html;
}
/** The pending press of a card / a task (drawn over the server's state until answered). */
function tskPendingOf(kind, list, id) {
  var hit = null;
  tskQ.forEach(function (it) {
    if (kind === 'card' && it.action === 'taskTick' && it.params.list === list && it.params.cardId === id && it.params.day === tskDay()) hit = it;
    if (kind === 'task' && it.action === 'taskSet' && it.params.taskId === id) hit = it;
  });
  return hit;
}
function tasksRender() {
  tskBadge();
  if (!tskEl('tskHead')) return;
  var d = tskData;
  // the head: the day, the roles, today's events, the sources not read, the last words
  var h = '<div class="tsk-h"><span>📋 ' + esc(d ? d.todayLabel : 'משימות') + '</span>' +
          '<button class="btn btn-action tsk-reload" type="button" onclick="tasksLoad()" aria-label="רענון">' + (tskState === 'loading' ? '⏳' : '↻') + '</button></div>';
  if (!d) {
    h += tskState === 'error' ? '<div class="tsk-err">' + esc(tskErr) + '</div>' : '<div class="loader">טוען משימות...</div>';
  } else {
    var r = d.roles || {};
    h += '<div class="tsk-role">' + (r.opening && r.closing ? 'בסידור היום: פתיחה וגם סגירה (שישי — משמרת הבוקר סוגרת)'
         : r.opening ? 'בסידור היום: פתיחה ☀️' : r.closing ? 'בסידור היום: סגירה 🌙'
         : 'היום אין לך פתיחה או סגירה בסידור — אפשר לסמן בשתי הרשימות') + '</div>';
    if (tskList([]).concat(d.events || []).length) h += '<div class="tsk-ev">📅 היום: ' + esc((d.events || []).join(' · ')) + '</div>';
    if (tskState === 'error') h += '<div class="tsk-err">' + esc(tskErr) + '</div>';
    (d.notes || []).forEach(function (n) { h += '<div class="tsk-note">⚠️ ' + esc(n) + '</div>'; });
  }
  if (tskMsg) h += '<div class="tsk-msg ' + (tskMsg.ok ? 'ok' : 'no') + '">' + esc(tskMsg.text) + '</div>';
  tskPut('tskHead', h);
  tskPut('tskQueue', tskQueueHtml());
  if (!d) { ['tskMine', 'tskOpening', 'tskClosing', 'tskAdd', 'tskTeam', 'tskMgr'].forEach(function (id) { tskPut(id, ''); }); return; }
  tskPut('tskMine', tskMineHtml(d));
  var r2 = d.roles || {};
  var hm = tskStr(d.now).slice(11, 16);
  var openFirst = r2.opening || (!r2.closing && hm < '16:00');
  if (tskFold.opening === undefined) tskFold.opening = !!openFirst;
  if (tskFold.closing === undefined) tskFold.closing = !!r2.closing || (!r2.opening && hm >= '16:00');
  tskPut('tskOpening', tskListHtml(d, TSK_LIST.OPEN));
  tskPut('tskClosing', tskListHtml(d, TSK_LIST.CLOSE) );
  tskPut('tskAdd', tskAddHtml(d));
  tskPut('tskTeam', tskTeamHtml(d) + tskGivenHtml(d));
  tskPut('tskMgr', d.isManager ? tskMgrHtml() : '');
}
function tskQueueHtml() {
  var h = '';
  tskQ.forEach(function (it) {
    var held = it.holdUntil > Date.now() && tskSending !== it.tapId;
    h += '<div class="tsk-q">' + (held ? '' : '⏳ ') + esc(it.label) +
         (held ? ' <button class="btn btn-action tsk-undo" type="button" onclick="tskUndo(\'' + it.tapId + '\')">↩︎ ביטול</button>'
               : it.wait ? ' · ' + (it.why === 'retry' ? 'יישלח שוב בעוד דקה' : 'ממתין לקליטה — שמור בטלפון') : ' · נשלח…') + '</div>';
  });
  if (tskNoStore && tskQ.length) h += '<div class="tsk-q no">⚠️ הטלפון לא שומר את הסימון — לא לסגור את האפליקציה עד שהוא נשלח</div>';
  tskRefused.forEach(function (r) {
    h += '<div class="tsk-q no">⚠️ לא נרשם: ' + esc(r.label) + ' — ' + esc(r.error) +
         ' <button class="btn btn-action" type="button" onclick="tskDismiss(\'' + r.tapId + '\')">✕ הבנתי</button></div>';
  });
  return h;
}
function tskTaskHtml(t, opt) {
  opt = opt || {};
  var pend = tskPendingOf('task', '', t.id), closed = t.state !== TSK_ST.OPEN;
  var h = '<div class="tsk-task' + (closed ? ' closed' : '') + (t.overdue ? ' late' : '') + '">' +
          '<div class="tsk-task-t">' + esc(t.text) + '</div>' +
          '<div class="tsk-task-s">' + (opt.showTo ? 'ל' + esc(t.toLabel) + ' · ' : '') + 'מאת ' + esc(t.by) +
          (t.dueLabel ? ' · ' + esc(t.dueLabel) : '') + (t.overdue ? ' · <b>באיחור</b>' : '') + '</div>';
  if (closed) h += '<div class="tsk-task-s">' + esc(t.state) + (t.stateBy ? ' · ' + esc(t.stateBy) : '') + (t.stateAt ? ' · ' + esc(t.stateAt) : '') + '</div>';
  else if (pend) h += '<div class="tsk-task-s">⏳ ' + esc(pend.params.state) + '…</div>';
  else if (TSK_TASK_RE.test(tskStr(t.id))) {
    var b = '';
    if (t.canDone) b += '<button class="btn tsk-yes" type="button" onclick="tskTaskSet(\'' + t.id + '\',\'' + TSK_ST.DONE + '\')">✓ בוצע</button>';
    if (t.canNotNeeded) b += '<button class="btn btn-action" type="button" onclick="tskTaskSet(\'' + t.id + '\',\'' + TSK_ST.NOT_NEEDED + '\')">לא צריך</button>';
    if (t.canCancel && opt.cancel) b += '<button class="btn btn-action" type="button" onclick="tskTaskSet(\'' + t.id + '\',\'' + TSK_ST.CANCELLED + '\')">בטל</button>';
    if (b) h += '<div class="tsk-acts">' + b + '</div>';
  }
  return h + '</div>';
}
function tskMineHtml(d) {
  var mine = tskList(d.tasks && d.tasks.mine);
  var h = '<div class="tsk-sec-h">המשימות שלי</div>';
  if (!mine.length) return h + '<div class="mgr-empty">אין משימות בשבילך כרגע</div>';
  mine.forEach(function (t) { h += tskTaskHtml(t, { cancel: true }); });
  return h;
}
function tskCardHtml(d, list, c, n) {
  var pend = tskPendingOf('card', list, c.id);
  var state = pend ? pend.params.state : c.state;
  var cls = state === TSK_ST.DONE ? ' done' : state === TSK_ST.NOT_DONE ? ' notdone' : '';
  var h = '<div class="tsk-card' + cls + (pend ? ' pend' : '') + '"><div class="tsk-card-t">' + n + '. ' + esc(c.text) + '</div>';
  if (pend) h += '<div class="tsk-card-s">⏳ ' + esc(state) + ' · נשמר בטלפון, נשלח…</div>';
  else if (c.state) h += '<div class="tsk-card-s">' + (c.state === TSK_ST.DONE ? '✓ ' : '✗ ') + esc(c.state) + (c.reason ? ' · ' + esc(c.reason) : '') +
                         (c.note ? ' · ' + esc(c.note) : '') + ' · ' + esc(c.by) + ' ' + esc(c.at) + '</div>';
  if (TSK_CARD_RE.test(tskStr(c.id)) && !c.retired) {
    h += '<div class="tsk-acts"><button class="btn tsk-yes" type="button" onclick="tskTick(\'' + list + '\',\'' + c.id + '\',\'' + TSK_ST.DONE + '\')">✓ בוצע</button>' +
         '<button class="btn tsk-no" type="button" onclick="tskNotDone(\'' + list + '\',\'' + c.id + '\')">✗ לא בוצע</button></div>';
    if (tskPick === list + '|' + c.id) {
      h += '<div class="tsk-why"><div class="tsk-why-h">למה לא בוצע?</div><div class="tsk-chips">';
      tskList(d.reasons).forEach(function (rc) {
        if (!TSK_KEY_RE.test(tskStr(rc.key))) return;
        h += '<button class="mgr-chip" type="button" onclick="tskReason(\'' + list + '\',\'' + c.id + '\',\'' + rc.key + '\')">' + esc(rc.label) + '</button>';
      });
      h += '</div><input type="text" maxlength="80" placeholder="הערה קצרה (לא חובה; ב&quot;אחר&quot; — חובה)" value="' + esc(tskDraft.notes[list + '|' + c.id] || '') +
           '" oninput="tskNote(\'' + list + '\',\'' + c.id + '\', this.value)"></div>';
    }
    if ((c.choices || []).length && state === TSK_ST.DONE) {
      h += '<div class="tsk-found">נמצא משהו? ';
      c.choices.forEach(function (ch, i) {
        h += '<button class="mgr-chip" type="button" onclick="tskTick(\'' + list + '\',\'' + c.id + '\',\'' + TSK_ST.DONE + '\',\'\',tskChoice(\'' + list + '\',\'' + c.id + '\',' + i + '))">' + esc(ch) + '</button>';
      });
      h += '</div>';
    }
  }
  // card 7 of the opening: the tasks given to whoever opens; card 9: last evening's summary and today's events
  if (list === TSK_LIST.OPEN && c.id === 'OPN-07') {
    var forOpen = tskList(d.tasks && d.tasks.opening);
    h += forOpen.length ? '<div class="tsk-inline">' + forOpen.map(function (t) { return tskTaskHtml(t); }).join('') + '</div>'
                        : '<div class="tsk-card-s">אין משימות למי שפותח היום</div>';
  }
  if (list === TSK_LIST.OPEN && c.id === 'OPN-09') {
    var ls = d.lastSummary;
    h += '<div class="tsk-card-s">' + (ls ? 'מהסגירה האחרונה (' + esc(ls.by) + ' ' + esc(ls.at) + '): ' + esc((ls.incidents || []).join(', ')) +
         (ls.note ? ' · ' + esc(ls.note) : '') : 'אין סיכום מהסגירה האחרונה באפליקציה') + '</div>';
  }
  return h + '</div>';
}
/** The choice of a card by its place (the text itself never goes inside an onclick). */
function tskChoice(list, id, i) {
  var c = tskCardOf(list, id);
  return c && c.choices ? tskStr(c.choices[i]) : '';
}
function tskListHtml(d, list) {
  var l = list === TSK_LIST.OPEN ? d.lists.opening : d.lists.closing, key = list === TSK_LIST.OPEN ? 'opening' : 'closing';
  var cards = tskList(l.cards);
  var done = cards.filter(function (c) { var p = tskPendingOf('card', list, c.id); return (p ? p.params.state : c.state) === TSK_ST.DONE; }).length;
  var h = '<details class="mgr-fold tsk-list"' + (tskFold[key] ? ' open' : '') + ' ontoggle="tskFoldSet(\'' + key + '\', this.open)">' +
          '<summary>' + (list === TSK_LIST.OPEN ? '☀️ רשימת פתיחה' : '🌙 רשימת סגירה') + ' · ' + done + '/' + cards.length + '</summary>';
  if (list === TSK_LIST.CLOSE) {
    var forClose = tskList(d.tasks && d.tasks.closing);
    if (forClose.length) h += '<div class="tsk-sec-h">משימות למי שסוגר היום</div>' + forClose.map(function (t) { return tskTaskHtml(t); }).join('');
  }
  cards.forEach(function (c, i) { h += tskCardHtml(d, list, c, i + 1); });
  if (list === TSK_LIST.CLOSE) h += tskSummaryHtml(d);
  return h + '</details>';
}
function tskToOptions(d, sel) {
  var h = '<option value="next"' + (sel === 'next' ? ' selected' : '') + '>המשמרת הבאה (' + esc(d.nextShift) + ')</option>' +
          '<option value="opener"' + (sel === 'opener' ? ' selected' : '') + '>' + esc(d.openerNext) + '</option>';
  tskList(d.people).forEach(function (p) {
    if (!TSK_EMP_RE.test(tskStr(p.id))) return;
    h += '<option value="' + p.id + '"' + (sel === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
  });
  return h;
}
function tskSummaryHtml(d) {
  var s = d.summary, sd = tskDraft.sum;
  var pend = tskQ.some(function (it) { return it.action === 'taskSummary' && it.params.day === tskDay(); });
  var h = '<div class="card tsk-sum"><div class="tsk-sec-h">📝 סיכום משמרת</div>';
  if (pend) h += '<div class="tsk-card-s">⏳ הסיכום נשמר בטלפון ונשלח…</div>';
  if (s) {
    h += '<div class="tsk-ok">✓ נשמר ' + esc(s.at) + ' · ' + esc(s.by) + ' · שיחות גבייה: ' + esc(s.calls) + ' · ' + esc((s.incidents || []).join(', ')) +
         (s.note ? ' · ' + esc(s.note) : '') + '</div>' +
         '<button class="btn tsk-share" type="button" onclick="tskShare()">📤 לשלוח לקבוצה</button>' +
         '<div class="tsk-card-s">שמירה נוספת למטה מתקנת את הסיכום (האחרון קובע). המשימות שכבר נפתחו ממנו נשארות — לא לכתוב אותן שוב.</div>';
  }
  h += '<label>כמה שיחות גבייה עשית?</label><div class="tsk-num">' +
       '<button class="btn btn-action" type="button" onclick="tskCalls(-1)">−</button>' +
       '<input type="number" inputmode="numeric" min="0" max="999" value="' + esc(sd.calls) + '" oninput="tskDraftSet(\'sum.calls\', this.value)">' +
       '<button class="btn btn-action" type="button" onclick="tskCalls(1)">＋</button></div>';
  h += '<label>היה אירוע חריג?</label><div class="tsk-chips">';
  tskList(d.incidents).forEach(function (c) {
    if (!TSK_KEY_RE.test(tskStr(c.key))) return;
    h += '<button class="mgr-chip' + (sd.inc.indexOf(c.key) !== -1 ? ' on' : '') + '" type="button" onclick="tskInc(\'' + c.key + '\')">' + esc(c.label) + '</button>';
  });
  h += '</div><label>הערה קצרה — בלי שמות של לקוחות</label><input type="text" maxlength="80" value="' + esc(sd.note) + '" oninput="tskDraftSet(\'sum.note\', this.value)">';
  h += '<label>מה נשאר פתוח? כל שורה תהיה משימה</label>';
  sd.open.forEach(function (o, i) {
    h += '<div class="tsk-open"><input type="text" maxlength="120" placeholder="מה נשאר" value="' + esc(o.text) + '" oninput="tskDraftSet(\'open.' + i + '.text\', this.value)">' +
         '<select onchange="tskDraftSet(\'open.' + i + '.to\', this.value)">' + tskToOptions(d, o.to) + '</select></div>';
  });
  if (sd.open.length < 8) h += '<button class="link-btn" type="button" onclick="tskOpenLine()">＋ עוד שורה</button>';
  h += '<button class="btn" type="button" onclick="tskSaveSummary()">💾 שמור סיכום</button>';
  return h + '</div>';
}
function tskAddHtml(d) {
  var a = tskDraft.add;
  var h = '<details class="mgr-fold"' + (tskFold.add ? ' open' : '') + ' ontoggle="tskFoldSet(\'add\', this.open)"><summary>＋ משימה חדשה</summary>' +
          '<label>מה צריך לעשות?</label><input type="text" maxlength="120" value="' + esc(a.text) + '" oninput="tskDraftSet(\'add.text\', this.value)">' +
          '<label>למי?</label><select onchange="tskDraftSet(\'add.to\', this.value)">' + tskToOptions(d, a.to) + '</select>' +
          '<label>עד מתי?</label><div class="tsk-chips">';
  [['today', 'היום'], ['tomorrow', 'מחר'], ['none', 'בלי תאריך']].forEach(function (x) {
    h += '<button class="mgr-chip' + (a.due === x[0] ? ' on' : '') + '" type="button" onclick="tskDraftSet(\'add.due\',\'' + x[0] + '\');tasksRender()">' + x[1] + '</button>';
  });
  h += '</div>' + (a.due === 'none' ? '' : '<label>שעה (לא חובה)</label><input type="time" value="' + esc(a.time) + '" oninput="tskDraftSet(\'add.time\', this.value)">') +
       '<button class="btn" type="button" onclick="tskAddTask()">שלח משימה</button>' +
       '<div class="tsk-card-s">כולם רואים מי נתן את המשימה; מי שנתן אותה, או מנהל/ת, יכולים לבטל.</div></details>';
  return h;
}
function tskTeamHtml(d) {
  var team = tskList(d.tasks && d.tasks.team);
  var h = '<details class="mgr-fold"' + (tskFold.team ? ' open' : '') + ' ontoggle="tskFoldSet(\'team\', this.open)"><summary>📋 כל המשימות הפתוחות · ' +
          (d.tasks ? Number(d.tasks.teamCount) || 0 : 0) + '</summary>';
  if (!team.length) h += '<div class="mgr-empty">אין משימות פתוחות</div>';
  team.forEach(function (t) { h += tskTaskHtml(t, { showTo: true, cancel: true }); });
  return h + '</details>';
}
/** Review SF8: the tasks I gave — open, and closed in the last week with how (done / not needed / cancelled) and by whom. */
function tskGivenHtml(d) {
  var given = tskList(d.tasks && d.tasks.given);
  if (!given.length) return '';
  var h = '<details class="mgr-fold"' + (tskFold.given ? ' open' : '') + ' ontoggle="tskFoldSet(\'given\', this.open)"><summary>📤 משימות שנתתי · ' +
          given.length + '</summary>';
  given.forEach(function (t) { h += tskTaskHtml(t, { showTo: true, cancel: true }); });
  return h + '</details>';
}
function tskMgrHtml() {
  var h = '<details class="mgr-fold"' + (tskFold.mgr ? ' open' : '') + ' ontoggle="tskFoldSet(\'mgr\', this.open)"><summary>🛠 מסך מנהלים — היום ו-7 ימים</summary>';
  h += '<button class="btn btn-action" type="button" onclick="tskMgrLoad()">' + (tskMgrState === 'loading' ? '⏳ טוען…' : '↻ רענון') + '</button>';
  if (tskMgrState === 'error') h += '<div class="tsk-err">' + esc(tskMgrErr) + '</div>';
  var m = tskMgrData;
  if (!m) return h + '</details>';
  (m.notes || []).forEach(function (n) { h += '<div class="tsk-note">⚠️ ' + esc(n) + '</div>'; });
  tskList(m.days).forEach(function (x) {
    var cls = x.red ? ' red' : x.empty ? ' empty' : x.waiting ? ' wait' : ' ok';
    var sum = x.summary ? '📝 ' + esc(x.summary.at) + ' · ' + esc(x.summary.by) : x.red ? '🔴 בלי סיכום' : x.waiting ? '⏳ עוד אין סיכום (אדום מ-' + esc(m.redAt) + ')' :
              x.saturday ? 'שבת' : x.empty ? 'אין סימונים' : '';
    h += '<div class="tsk-day' + cls + '"><div class="tsk-day-h"><b>' + esc(x.label) + '</b> · ' + sum + '</div>' +
         '<div class="tsk-card-s">☀️ פתיחה ' + tskN(x.opening.done) + '/' + tskN(x.opening.total) + (x.opening.by.length ? ' · ' + esc(x.opening.by.join(', ')) + ' ' + esc(x.opening.first) : '') +
         ' · 🌙 סגירה ' + tskN(x.closing.done) + '/' + tskN(x.closing.total) + (x.closing.by.length ? ' · ' + esc(x.closing.by.join(', ')) + ' ' + esc(x.closing.last) : '') + '</div>';
    tskList(x.opening.marks).concat(tskList(x.closing.marks)).forEach(function (k) {
      h += '<div class="tsk-mark">' + (k.state === TSK_ST.NOT_DONE ? '✗ ' : '⚠️ ') + esc(k.text) + ' · ' + esc(k.reason) + (k.note ? ' · ' + esc(k.note) : '') + ' · ' + esc(k.by) + '</div>';
    });
    if (x.summary) h += '<div class="tsk-mark">שיחות גבייה: ' + esc(x.summary.calls) + ' · ' + esc((x.summary.incidents || []).join(', ')) + (x.summary.note ? ' · ' + esc(x.summary.note) : '') + '</div>';
    h += '</div>';
  });
  var off = tskList(m.wavedOff);
  if (off.length) {
    h += '<div class="tsk-sec-h">נסגרו בלי ביצוע השבוע · ' + off.length + '</div>';
    off.forEach(function (t) {
      h += '<div class="tsk-mark">' + esc(t.text) + ' · ל' + esc(t.toLabel) + ' · מאת ' + esc(t.by) + ' · ' + esc(t.state) + ' · ' + esc(t.stateBy) +
           ' ' + esc(t.stateAt) + (t.stateNote ? ' · ' + esc(t.stateNote) : '') + '</div>';
    });
  }
  h += '<div class="tsk-sec-h">משימות פתוחות לפי אדם · ' + tskN(m.openCount) + '</div>';
  if (!tskList(m.openByPerson).length) h += '<div class="mgr-empty">אין משימות פתוחות</div>';
  tskList(m.openByPerson).forEach(function (g) {
    h += '<div class="mgr-sub">' + esc(g.label) + '</div>';
    tskList(g.items).forEach(function (t) {
      h += '<div class="tsk-mark' + (t.overdue ? ' late' : '') + '">' + esc(t.text) + ' · מאת ' + esc(t.by) + (t.dueLabel ? ' · ' + esc(t.dueLabel) : '') + (t.overdue ? ' · <b>באיחור</b>' : '') + '</div>';
    });
  });
  return h + '</details>';
}
