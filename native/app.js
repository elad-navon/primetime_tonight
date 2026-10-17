/* ===== תזכורות לשידורים – רק בתוך אפליקציית האנדרואיד =====
   index.html loads this module only when it runs inside the Android app (Capacitor.isNativePlatform()),
   so the website in a browser never shows bells or reminder settings and never loads Capacitor.

   - A bell next to every program that hasn't started: one tap schedules a reminder, another cancels it.
   - Keyword rules ("מכבי תל אביב + כדורסל"): the next seven days of every channel are scanned when the
     app opens and whenever it comes back to the screen, and every matching broadcast gets a reminder.
     Nothing scans while the app is closed - reminders already scheduled still fire then.
   - The notification plugin is the record of what is scheduled (getPending); settings live in localStorage.
   The rules themselves (ids, matching, what to schedule or cancel) are in reminders-core.js. */
import { LocalNotifications } from './vendor/capacitor.js';
import * as core from './reminders-core.js';

const app = window.ptApp;
const SCAN_EVERY_MS = 20 * 60_000;
const SCAN_DAYS = 7;
const PARALLEL = 6;

let settings = core.loadSettings(window.localStorage);
let pending = []; // our reminders the plugin says are scheduled
let permission = 'prompt'; // notifications: granted / denied / prompt
let exact = false; // exact alarms allowed (always true before Android 12)
let lastScan = null; // { at, found, failed, total }
let scanning = null;

const timeLabel = (ms) => app.hhmm(new Date(ms));
const dayTimeLabel = (ms) =>
  new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(ms),
  );
const save = () => core.saveSettings(window.localStorage, settings);
const pendingIds = () => new Set(pending.map((p) => p.id));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function toProgram(p, ch, dayKey) {
  return {
    id: p.id,
    title: p.title,
    desc: p.desc,
    startMs: p.start instanceof Date ? p.start.getTime() : NaN,
    channelNum: ch.num,
    channelName: ch.name,
    dayKey,
  };
}

/* ----- the plugin ----- */

async function refreshStatus() {
  try {
    permission = (await LocalNotifications.checkPermissions()).display;
  } catch {
    permission = 'denied';
  }
  try {
    exact = (await LocalNotifications.checkExactNotificationSetting()).exact_alarm === 'granted';
  } catch {
    exact = false;
  }
}

async function refreshPending() {
  try {
    const { notifications } = await LocalNotifications.getPending();
    pending = (notifications || []).filter((n) => n.extra && (n.extra.kind === 'manual' || n.extra.kind === 'auto'));
  } catch {
    /* keep what we had */
  }
  updateToolbarCount();
}

/** Asks for permission when it hasn't been decided; false (with an explanation) when notifications are off. */
async function ensurePermission() {
  await refreshStatus();
  if (permission === 'prompt' || permission === 'prompt-with-rationale') {
    try {
      permission = (await LocalNotifications.requestPermissions()).display;
    } catch {
      permission = 'denied';
    }
  }
  if (permission !== 'granted') {
    toast('ההתראות של האפליקציה כבויות, אז התזכורת לא תגיע. אפשר להפעיל אותן בהגדרות של אנדרואיד: אפליקציות › פריים טיים › התראות.');
    return false;
  }
  return true;
}

/** Replaces notifications with the same ids, then schedules. Returns false on failure. */
async function apply({ schedule = [], cancel = [] }) {
  const replace = schedule.map((n) => n.id).filter((id) => pendingIds().has(id));
  const ids = [...new Set([...cancel, ...replace])];
  try {
    if (ids.length) await LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) });
    if (schedule.length) {
      // Exact only when Android allows it - asking for exact without permission would open the settings screen.
      const list = schedule.map((n) => ({ ...n, isExactNotification: exact }));
      await LocalNotifications.schedule({ notifications: list });
    }
    return true;
  } catch (e) {
    toast(`לא הצלחתי לתזמן תזכורת: ${e?.message || e}`);
    return false;
  } finally {
    await refreshPending();
  }
}

/* ----- bells ----- */

const BELL = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6v3.6L4.4 15.6A1 1 0 0 0 5.3 17h13.4a1 1 0 0 0 .9-1.4L18 12.6V9a6 6 0 0 0-6-6zm-2.4 15a2.5 2.5 0 0 0 4.8 0z" fill="currentColor"/></svg>`;

function decorate() {
  const now = Date.now();
  const ids = pendingIds();
  // div only: the page also puts "show" on its "קרא עוד" buttons, which carry the same data-k.
  for (const el of document.querySelectorAll('div.hero[data-k], div.show[data-k], div.row[data-k]')) {
    const found = app.programByKey(el.dataset.k);
    const old = el.querySelector(':scope .pt-bell');
    if (!found || !(found.p.start > now)) {
      old?.remove();
      continue;
    }
    const on = ids.has(core.notificationId(toProgram(found.p, found.ch, app.selectedDayKey())));
    const btn = old ?? document.createElement('button');
    btn.type = 'button';
    btn.className = `pt-bell${on ? ' on' : ''}`;
    btn.dataset.k = el.dataset.k;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', on ? 'ביטול התזכורת' : 'תזכורת לפני השידור');
    btn.innerHTML = BELL;
    if (!old) (el.querySelector('.t-row') ?? el).appendChild(btn);
  }
}

async function toggleBell(k) {
  const found = app.programByKey(k);
  if (!found) return;
  const program = toProgram(found.p, found.ch, app.selectedDayKey());
  const id = core.notificationId(program);
  const existing = pending.find((p) => p.id === id);
  if (existing) {
    if (existing.extra.kind === 'auto') {
      settings.dismissed = [...new Set([...settings.dismissed, id])].slice(-300);
      save();
    }
    await apply({ cancel: [id] });
    toast('התזכורת בוטלה');
  } else {
    const now = Date.now();
    if (!(program.startMs > now)) return toast('השידור כבר התחיל');
    if (!(await ensurePermission())) return;
    settings.dismissed = settings.dismissed.filter((d) => d !== id);
    save();
    const at = Math.max(core.remindAt(program.startMs, settings.offset), now + 5_000);
    const n = core.buildNotification({ program, offset: settings.offset, kind: 'manual', exact, timeLabel: timeLabel(program.startMs), at });
    if (await apply({ schedule: [n] })) toast(`תזכורת נקבעה: ${program.title} · ${dayTimeLabel(at)}${exact ? '' : ' (בערך)'}`);
  }
  decorate();
  renderDialog();
}

/* ----- keyword scan ----- */

let rescan = false;
async function scan({ force = false } = {}) {
  if (scanning) {
    // A scan is under way with the settings it started with: a forced one (a rule just changed) runs
    // again right after it.
    if (force) rescan = true;
    return scanning;
  }
  if (!force && lastScan && Date.now() - lastScan.at < SCAN_EVERY_MS) return;
  scanning = (async () => {
    const today = app.ilParts(new Date());
    const jobs = [];
    for (let i = 0; i < SCAN_DAYS; i++) {
      const o = app.shiftDay(today, i);
      for (const ch of app.channels) jobs.push({ ch, dateStr: `${o.y}-${o.mo}-${o.d}`, dayKey: app.dayKey(o) });
    }
    const programs = [];
    const coverage = new Set();
    let failed = 0;
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        try {
          const shows = await app.fetchChannel(job.ch, job.dateStr);
          for (const p of shows) programs.push(toProgram(p, job.ch, job.dayKey));
          coverage.add(`${job.ch.num}|${job.dayKey}`);
        } catch {
          failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));

    await refreshStatus();
    await refreshPending();
    const now = Date.now();
    const plan = core.planAutoReminders({ programs, coverage, settings, pending, now, exact, timeLabel });
    const moved = core.planManualUpdates({ programs, pending, settings, now, exact, timeLabel });
    // Without permission nothing new can be shown; cancelling obsolete ones is still right.
    const schedule = permission === 'granted' ? [...plan.schedule, ...moved] : [];
    if (schedule.length || plan.cancel.length) await apply({ schedule, cancel: plan.cancel });
    const autoCount = pending.filter((p) => p.extra.kind === 'auto').length;
    lastScan = { at: Date.now(), found: autoCount, failed, total: jobs.length };
    decorate();
    renderDialog();
  })().finally(() => {
    scanning = null;
    if (rescan) {
      rescan = false;
      scan({ force: true });
    }
  });
  return scanning;
}

/* ----- settings dialog ----- */

function injectUi() {
  const style = document.createElement('style');
  style.textContent = `
    .pt-bell{margin-inline-start:auto;flex:0 0 auto;width:36px;height:36px;border-radius:50%;border:1px solid var(--line);
      background:rgba(0,0,0,.35);color:var(--dim);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
    .pt-bell.on{color:#0a0d16;background:#ffd166;border-color:#ffd166}
    .row .pt-bell{width:30px;height:30px}
    .t-row{display:flex;align-items:center;gap:8px}
    #ptRemindersBtn .n{display:inline-block;min-width:18px;margin-inline-start:6px;padding:0 5px;border-radius:9px;background:#ffd166;color:#0a0d16;font-size:12px;font-weight:700}
    #ptRemindersBtn .n[hidden],.pt-toast[hidden]{display:none}
    #ptDlg{width:min(560px,94vw);max-height:88vh;border:1px solid var(--line);border-radius:18px;background:var(--bg2);color:var(--txt);padding:0}
    #ptDlg::backdrop{background:rgba(0,0,0,.6)}
    #ptDlg .in{padding:18px 18px 8px;overflow:auto;max-height:calc(88vh - 60px)}
    #ptDlg h2{margin:0 0 12px;font-size:20px}
    #ptDlg h3{margin:18px 0 8px;font-size:15px;color:var(--dim)}
    #ptDlg .line{display:flex;align-items:center;gap:10px;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);font-size:14px}
    #ptDlg .hint{font-size:12px;color:var(--dimmer);line-height:1.6;margin:6px 0}
    #ptDlg button,#ptDlg select,#ptDlg input[type=text]{font:inherit;color:var(--txt);background:var(--card-hi);border:1px solid var(--line);border-radius:10px;min-height:40px;padding:0 12px}
    #ptDlg input[type=text]{flex:1;min-width:0}
    #ptDlg .ok{color:var(--ok)} #ptDlg .bad{color:var(--live)}
    #ptDlg .x{min-width:40px;padding:0}
    #ptDlg .foot{display:flex;justify-content:flex-end;padding:10px 18px 14px;border-top:1px solid var(--line)}
    .pt-toast{position:fixed;inset-inline:12px;bottom:18px;z-index:99;background:#1b2240;border:1px solid var(--line);color:var(--txt);
      padding:12px 16px;border-radius:14px;font-size:14px;line-height:1.5;box-shadow:0 10px 30px rgba(0,0,0,.5)}`;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.className = 'ghost';
  btn.id = 'ptRemindersBtn';
  btn.type = 'button';
  btn.innerHTML = 'תזכורות<span class="n" hidden></span>';
  btn.addEventListener('click', openDialog);
  const refresh = document.getElementById('refresh');
  refresh?.parentNode.insertBefore(btn, refresh);

  const dlg = document.createElement('dialog');
  dlg.id = 'ptDlg';
  dlg.setAttribute('dir', 'rtl');
  document.body.appendChild(dlg);
  dlg.addEventListener('click', onDialogClick);
  dlg.addEventListener('change', onDialogChange);
  dlg.addEventListener('submit', (e) => e.preventDefault());

  // Bells: our own handler, before the page's own click handlers see the click.
  document.addEventListener(
    'click',
    (e) => {
      const bell = e.target.closest?.('.pt-bell');
      if (!bell) return;
      e.preventDefault();
      e.stopPropagation();
      toggleBell(bell.dataset.k);
    },
    true,
  );
}

function updateToolbarCount() {
  const n = document.querySelector('#ptRemindersBtn .n');
  if (!n) return;
  n.textContent = String(pending.length);
  n.hidden = pending.length === 0;
}

async function openDialog() {
  await refreshStatus();
  await refreshPending();
  renderDialog();
  document.getElementById('ptDlg').showModal();
}

function renderDialog() {
  const dlg = document.getElementById('ptDlg');
  if (!dlg) return;
  // A scan can finish while a rule is being typed: keep the text and the cursor across the redraw.
  const typing = document.getElementById('ptRuleText');
  const kept = typing && { value: typing.value, focused: document.activeElement === typing, pos: typing.selectionStart };
  renderDialogHtml(dlg);
  if (kept) {
    const input = document.getElementById('ptRuleText');
    input.value = kept.value;
    if (kept.focused) {
      input.focus();
      input.setSelectionRange(kept.pos, kept.pos);
    }
  }
}

function renderDialogHtml(dlg) {
  const list = [...pending].sort((a, b) => core.pendingAt(a) - core.pendingAt(b));
  const ruleName = (id) => settings.rules.find((r) => r.id === id)?.text ?? 'כלל שנמחק';
  dlg.innerHTML = `<div class="in">
    <h2>תזכורות לשידורים</h2>

    <div class="line"><span>התראות</span>${
      permission === 'granted'
        ? '<span class="ok">מאושרות</span>'
        : '<span class="bad">כבויות</span><button type="button" data-act="perm">להפעיל</button>'
    }</div>
    <div class="line"><span>תזמון מדויק</span>${
      exact
        ? '<span class="ok">פעיל</span>'
        : '<span class="bad">לא פעיל</span><button type="button" data-act="exact">לאפשר</button>'
    }</div>
    ${exact ? '' : '<p class="hint">בלי תזמון מדויק, אנדרואיד עלולה לשלוח את התזכורת באיחור של כמה דקות. "לאפשר" פותח את ההגדרה "התראות ותזכורות" של האפליקציה.</p>'}

    <h3>מתי להזכיר</h3>
    <div class="line"><span>לפני כל שידור</span>
      <select data-act="offset">${core.OFFSETS.map(
        (o) => `<option value="${o}"${o === settings.offset ? ' selected' : ''}>${o === 0 ? 'בתחילת השידור' : `${o} דקות לפני`}</option>`,
      ).join('')}</select></div>

    <h3>תזכורות אוטומטיות לפי מילים</h3>
    <form class="line" data-act="add-form"><input type="text" id="ptRuleText" placeholder="למשל: מכבי תל אביב + כדורסל" autocomplete="off">
      <button type="button" data-act="add">הוספה</button></form>
    <p class="hint">כל שידור שהשם או התיאור שלו כוללים את המילים מקבל תזכורת. "+" מחבר כמה מילים שכולן חייבות להופיע. "תל אביב" מוצא גם ת"א.</p>
    ${settings.rules
      .map((r) => `<div class="line"><span>${esc(r.text)}</span><button type="button" class="x" data-act="del-rule" data-id="${esc(r.id)}" aria-label="מחיקת הכלל">×</button></div>`)
      .join('')}
    <div class="line"><label><input type="checkbox" data-act="reruns"${settings.skipReruns ? ' checked' : ''}> בלי שידורים חוזרים</label></div>
    <div class="line"><label><input type="checkbox" data-act="live"${settings.liveOnly ? ' checked' : ''}> רק שידורים ישירים</label></div>
    <p class="hint">החיפוש רץ כשהאפליקציה נפתחת וכשחוזרים אליה, על השבוע הקרוב. כשהיא סגורה לא נמצאים שידורים חדשים, אבל תזכורות שכבר נקבעו מגיעות.${
      lastScan ? ` חיפוש אחרון: ${timeLabel(lastScan.at)}${lastScan.failed ? `, ${lastScan.failed} מתוך ${lastScan.total} לא נטענו` : ''}.` : ''
    }</p>
    <div class="line"><span>${scanning ? 'מחפש…' : ''}</span><button type="button" data-act="scan">לחפש עכשיו</button></div>

    <h3>מתוזמנות (${list.length})</h3>
    ${
      list
        .map((p) => {
          const e = p.extra;
          const kind = e.kind === 'manual' ? 'ידנית' : `אוטומטית: ${esc((e.rules || []).map(ruleName).join(', '))}`;
          return `<div class="line"><span>${esc(e.title)}<br><small style="color:var(--dim)">${esc(e.channelName)} · ${dayTimeLabel(e.startMs)} · ${kind}</small></span>
          <button type="button" class="x" data-act="cancel" data-id="${p.id}" aria-label="ביטול התזכורת">×</button></div>`;
        })
        .join('') || '<p class="hint">אין תזכורות. הפעמון ליד כל שידור קובע תזכורת.</p>'
    }

    <h3>בדיקה</h3>
    <div class="line"><span>תזכורת לדוגמה בעוד דקה</span><button type="button" data-act="test">לשלוח</button></div>
  </div>
  <div class="foot"><button type="button" data-act="close">סגירה</button></div>`;
}

async function onDialogClick(e) {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'close') return document.getElementById('ptDlg').close();
  if (act === 'perm') {
    await ensurePermission();
  } else if (act === 'exact') {
    try {
      await LocalNotifications.changeExactNotificationSetting();
    } catch {
      /* not available */
    }
    await refreshStatus();
    if (exact) await apply({ schedule: core.planOffsetChange({ pending, offset: settings.offset, now: Date.now(), exact, timeLabel }) });
  } else if (act === 'add') {
    const input = document.getElementById('ptRuleText');
    const text = input.value.trim();
    if (!text) return;
    if (!core.ruleTerms(text).length) return;
    if (!(await ensurePermission())) return;
    settings.rules = [...settings.rules, { id: `r${Date.now().toString(36)}`, text }];
    save();
    renderDialog();
    await scan({ force: true });
  } else if (act === 'del-rule') {
    settings.rules = settings.rules.filter((r) => r.id !== b.dataset.id);
    save();
    renderDialog();
    await scan({ force: true });
  } else if (act === 'cancel') {
    const id = Number(b.dataset.id);
    const p = pending.find((x) => x.id === id);
    if (p?.extra.kind === 'auto') {
      settings.dismissed = [...new Set([...settings.dismissed, id])].slice(-300);
      save();
    }
    await apply({ cancel: [id] });
    decorate();
  } else if (act === 'scan') {
    renderDialog();
    await scan({ force: true });
  } else if (act === 'test') {
    if (!(await ensurePermission())) return;
    const at = Date.now() + 60_000;
    try {
      await LocalNotifications.schedule({
        notifications: [
          {
            id: 1,
            title: 'בדיקת תזכורת',
            body: 'אם ההודעה הזאת הגיעה, התזכורות עובדות.',
            channelId: core.NOTIFICATION_CHANNEL,
            schedule: { at: new Date(at), allowWhileIdle: true },
            isExactNotification: exact,
            extra: { kind: 'test' },
          },
        ],
      });
      toast(`תזכורת בדיקה תגיע ב־${timeLabel(at)}${exact ? '' : ' (בערך)'}. אפשר לסגור את האפליקציה.`);
    } catch (err) {
      toast(`הבדיקה נכשלה: ${err?.message || err}`);
    }
  }
  renderDialog();
}

async function onDialogChange(e) {
  const el = e.target;
  if (el.dataset.act === 'offset') {
    const offset = Number(el.value);
    if (!core.OFFSETS.includes(offset)) return;
    settings.offset = offset;
    save();
    await apply({ schedule: core.planOffsetChange({ pending, offset, now: Date.now(), exact, timeLabel }) });
    renderDialog();
  } else if (el.dataset.act === 'reruns' || el.dataset.act === 'live') {
    if (el.dataset.act === 'reruns') settings.skipReruns = el.checked;
    else settings.liveOnly = el.checked;
    save();
    await scan({ force: true });
  }
}

/* ----- messages ----- */

let toastTimer = 0;
function toast(text) {
  let t = document.querySelector('.pt-toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'pt-toast';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}

/* ----- start ----- */

async function start() {
  injectUi();
  try {
    await LocalNotifications.createChannel({
      id: core.NOTIFICATION_CHANNEL,
      name: 'תזכורות לשידורים',
      description: 'תזכורת לפני שתוכנית מתחילה',
      importance: 4,
      visibility: 1,
      vibration: true,
    });
  } catch {
    /* older Android: no channels */
  }
  // Tapping a reminder opens the app: say which broadcast it was, and bring its channel into view when it's today's.
  LocalNotifications.addListener('localNotificationActionPerformed', ({ notification }) => {
    const e = notification?.extra;
    if (!e?.title) return;
    toast(`${e.title} · ${e.channelName} · ${dayTimeLabel(e.startMs)}`);
    if (e.dayKey === app.selectedDayKey()) document.querySelector(`.card[data-ch="${e.channelNum}"]`)?.scrollIntoView({ block: 'center' });
  });
  await refreshStatus();
  await refreshPending();
  decorate();
  window.addEventListener('pt:rendered', decorate);
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    await refreshPending();
    decorate();
    scan();
  });
  scan({ force: true });
}

start();
