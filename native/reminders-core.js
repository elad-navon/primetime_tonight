/* ===== תזכורות לשידורים – הלוגיקה הטהורה =====
   Used only by the Android app (native/app.js) and by the tests in android-app/tests/.
   No DOM, no plugin, no clock of its own: everything comes in as arguments, so every rule here
   can be checked in Node with real schedule data.

   A program, as this file sees it (built by native/app.js from fetchChannel's results):
     { id, title, desc, startMs, channelNum, channelName, dayKey }
   - id: yes's own id for this broadcast (item.id) - stable, and small enough to be the notification id.
   - dayKey: the schedule day it was fetched under ("2026-10-17"), used to know what a scan covered.

   A pending reminder, as the notification plugin reports it: { id, schedule:{at}, extra } where extra is
     { kind: 'manual'|'auto', rules: [ruleId...], channelNum, channelName, dayKey, startMs, title, at }. */

export const OFFSETS = [0, 5, 10, 15];
export const NOTIFICATION_CHANNEL = 'pt-reminders';
/* Android keeps at most ~500 alarms per app; automatic reminders stay well below that. */
export const MAX_AUTO = 60;

export const DEFAULT_SETTINGS = Object.freeze({ offset: 10, rules: [], skipReruns: true, liveOnly: false, dismissed: [] });

/* ----- settings (localStorage) ----- */
export const SETTINGS_KEY = 'pt-reminders-v1';

/** Settings from storage, with defaults for anything missing or broken - never throws. */
export function loadSettings(storage) {
  let raw = null;
  try {
    raw = JSON.parse(storage.getItem(SETTINGS_KEY) || 'null');
  } catch {
    raw = null;
  }
  const s = raw && typeof raw === 'object' ? raw : {};
  const rules = Array.isArray(s.rules)
    ? s.rules
        .filter((r) => r && typeof r.id === 'string' && typeof r.text === 'string' && r.text.trim())
        .map((r) => ({ id: r.id, text: r.text.trim() }))
    : [];
  return {
    offset: OFFSETS.includes(s.offset) ? s.offset : DEFAULT_SETTINGS.offset,
    rules,
    skipReruns: typeof s.skipReruns === 'boolean' ? s.skipReruns : DEFAULT_SETTINGS.skipReruns,
    liveOnly: typeof s.liveOnly === 'boolean' ? s.liveOnly : DEFAULT_SETTINGS.liveOnly,
    dismissed: Array.isArray(s.dismissed) ? s.dismissed.filter(Number.isInteger) : [],
  };
}

export function saveSettings(storage, settings) {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/* ----- matching ----- */

/* The schedule writes city names short: מכבי ת''א, ב"ש. A rule may use either form. */
const ALIASES = [
  ['תל אביב', 'ת"א'],
  ['באר שבע', 'ב"ש'],
  ['פתח תקווה', 'פ"ת'],
  ['ראשון לציון', 'ראשל"צ'],
  ['קריית שמונה', 'ק"ש'],
];

/** Lower case, every kind of Hebrew quote/gershayim as one ", single spaces. */
export function normalizeText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/''|׳׳|[״“”„]/g, '"')
    .replace(/[׳’‘`]/g, "'")
    .replace(/[֑-ׇ]/g, '') // niqqud and cantillation marks
    .replace(/[-–—]/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One rule ("מכבי תל אביב + כדורסל") as its terms; every term must appear. */
export function ruleTerms(text) {
  return String(text ?? '')
    .split('+')
    .map((t) => normalizeText(t))
    .filter(Boolean);
}

/** A term and the forms it may take in the schedule (an alias swapped in, either way). */
function termVariants(term) {
  const out = new Set([term]);
  for (const [long, short] of ALIASES) {
    const l = normalizeText(long);
    const s = normalizeText(short);
    for (const v of [...out]) {
      if (v.includes(l)) out.add(v.split(l).join(s));
      if (v.includes(s)) out.add(v.split(s).join(l));
    }
  }
  return [...out];
}

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The term as a whole word or phrase - "מכבי" is not found inside "מכביסטים" - allowing one Hebrew
    prefix letter in front (ו, ה, ב, ל, מ, ש, כ: "ולמכבי" is not, "למכבי" is). */
function containsTerm(haystack, term) {
  const rx = new RegExp(`(?:^|[^\\p{L}\\p{N}])[ובלמשהכ]?${escapeRx(term)}(?=$|[^\\p{L}\\p{N}])`, 'u');
  return rx.test(haystack);
}

export function matchesRule(program, ruleText) {
  const terms = ruleTerms(ruleText);
  if (!terms.length) return false;
  const text = normalizeText(`${program.title ?? ''} ${program.desc ?? ''}`);
  return terms.every((term) => termVariants(term).some((v) => containsTerm(text, v)));
}

/** A rerun, by the schedule's own wording ("שידור חוזר: ..."). */
export function isRerun(program) {
  return /^\s*שידור חוזר/.test(program.desc ?? '') || /שידור חוזר/.test(program.title ?? '');
}

/** A live broadcast, by the schedule's own wording ("ישיר! ..." / "שידור ישיר: ..."). Archive games
    (e.g. on ספורט 5 גולד) carry neither, nor the rerun mark. */
export function isLive(program) {
  return /^\s*ישיר!/.test(program.title ?? '') || /^\s*שידור ישיר/.test(program.desc ?? '');
}

/* ----- ids and times ----- */

const MAX_ID = 2 ** 31 - 1; // Android notification ids are 32-bit ints

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** yes's own broadcast id when there is one (stable across a time change), else a hash of the channel
    and start time. Always a positive 31-bit int. */
export function notificationId(program) {
  if (Number.isInteger(program.id) && program.id > 0 && program.id <= MAX_ID) return program.id;
  const h = fnv1a(`${program.channelNum}|${program.startMs}`) & MAX_ID;
  return h || 1;
}

export const validStart = (program) => Number.isFinite(program.startMs) && program.startMs > 0;

/** When to remind: `offset` minutes before the start. */
export const remindAt = (startMs, offset) => startMs - offset * 60_000;

/** The notification's text. timeLabel = the start time as the page shows it ("21:15"). */
export function reminderText({ title, channelName, offset, timeLabel }) {
  const when = offset === 0 ? 'מתחיל עכשיו' : `בעוד ${offset} דקות`;
  return { title: title || 'שידור', body: [channelName, timeLabel, when].filter(Boolean).join(' · ') };
}

/** The plugin's notification object for one program. */
export function buildNotification({ program, offset, kind, rules = [], exact, timeLabel, at }) {
  const whenMs = at ?? remindAt(program.startMs, offset);
  const { title, body } = reminderText({ title: program.title, channelName: program.channelName, offset, timeLabel });
  return {
    id: notificationId(program),
    title,
    body,
    channelId: NOTIFICATION_CHANNEL,
    schedule: { at: new Date(whenMs), allowWhileIdle: true },
    isExactNotification: !!exact,
    extra: {
      kind,
      rules,
      channelNum: program.channelNum,
      channelName: program.channelName,
      dayKey: program.dayKey,
      startMs: program.startMs,
      title: program.title,
      at: whenMs,
    },
  };
}

/** When a pending reminder fires (ms), from what the plugin reports. */
export function pendingAt(p) {
  const at = p?.extra?.at ?? (p?.schedule?.at ? new Date(p.schedule.at).getTime() : NaN);
  return Number.isFinite(at) ? at : NaN;
}

/* ----- the automatic-reminder plan ----- */

/**
 * What to schedule and cancel after a scan, for the automatic (keyword) reminders only.
 *
 * - programs: everything a scan fetched successfully; coverage: Set of "channelNum|dayKey" it fetched.
 * - A program matching one or more rules gets ONE reminder (its id), listing every rule that matched.
 * - A manual reminder is never touched, and keeps a program from getting an automatic one too.
 * - An automatic reminder is cancelled only when this scan proves it obsolete: none of its rules exists
 *   any more, or its channel and day were fetched and it no longer matches / is gone. A channel or day
 *   that failed to load proves nothing, so its reminders stay.
 * - Nothing in the past; a program the user dismissed is not scheduled again.
 */
export function planAutoReminders({ programs, coverage, settings, pending, now, exact, timeLabel }) {
  const rules = settings.rules;
  const ruleIds = new Set(rules.map((r) => r.id));
  const dismissed = new Set(settings.dismissed);
  const pendingById = new Map(pending.map((p) => [p.id, p]));

  const desired = new Map();
  for (const program of programs) {
    if (!validStart(program)) continue;
    if (settings.skipReruns && isRerun(program)) continue;
    if (settings.liveOnly && !isLive(program)) continue;
    const matched = rules.filter((r) => matchesRule(program, r.text)).map((r) => r.id);
    if (!matched.length) continue;
    const at = remindAt(program.startMs, settings.offset);
    if (at <= now) continue;
    const id = notificationId(program);
    if (dismissed.has(id)) continue;
    const prev = desired.get(id);
    if (!prev || prev.at > at) desired.set(id, { program, rules: matched, at });
  }

  const nearest = [...desired.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, MAX_AUTO);
  const keepIds = new Set(nearest.map(([id]) => id));

  const schedule = [];
  for (const [id, d] of nearest) {
    const existing = pendingById.get(id);
    if (existing?.extra?.kind === 'manual') continue;
    const same =
      existing?.extra?.kind === 'auto' &&
      pendingAt(existing) === d.at &&
      existing.extra.title === d.program.title &&
      sameSet(existing.extra.rules, d.rules);
    if (same) continue;
    schedule.push(
      buildNotification({
        program: d.program,
        offset: settings.offset,
        kind: 'auto',
        rules: d.rules,
        exact,
        timeLabel: timeLabel?.(d.program.startMs),
        at: d.at,
      }),
    );
  }

  const cancel = [];
  for (const p of pending) {
    if (p?.extra?.kind !== 'auto' || keepIds.has(p.id)) continue;
    const rulesAlive = (p.extra.rules ?? []).some((r) => ruleIds.has(r));
    const covered = coverage.has(`${p.extra.channelNum}|${p.extra.dayKey}`);
    if (!rulesAlive || covered || dismissed.has(p.id)) cancel.push(p.id);
  }

  return { schedule, cancel };
}

/** Manual reminders whose program moved: the same broadcast (same id) found at a new start time. */
export function planManualUpdates({ programs, pending, settings, now, exact, timeLabel }) {
  const byId = new Map(programs.filter(validStart).map((p) => [notificationId(p), p]));
  const schedule = [];
  for (const p of pending) {
    if (p?.extra?.kind !== 'manual') continue;
    const program = byId.get(p.id);
    if (!program || program.startMs === p.extra.startMs) continue;
    const at = Math.max(remindAt(program.startMs, settings.offset), now + 5_000);
    if (program.startMs <= now) continue;
    schedule.push(
      buildNotification({ program, offset: settings.offset, kind: 'manual', exact, timeLabel: timeLabel?.(program.startMs), at }),
    );
  }
  return schedule;
}

/** Every pending reminder again with a new offset (the setting changed). Past ones are left alone. */
export function planOffsetChange({ pending, offset, now, exact, timeLabel }) {
  const out = [];
  for (const p of pending) {
    const e = p?.extra;
    if (!e || !Number.isFinite(e.startMs) || e.startMs <= now) continue;
    const program = {
      id: p.id,
      title: e.title,
      startMs: e.startMs,
      channelNum: e.channelNum,
      channelName: e.channelName,
      dayKey: e.dayKey,
    };
    const at = Math.max(remindAt(e.startMs, offset), now + 5_000);
    out.push(
      buildNotification({ program, offset, kind: e.kind, rules: e.rules ?? [], exact, timeLabel: timeLabel?.(e.startMs), at }),
    );
  }
  return out;
}

function sameSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}
