// The reminder logic (../../native/reminders-core.js) against real yes schedule data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadSettings,
  saveSettings,
  SETTINGS_KEY,
  matchesRule,
  isRerun,
  isLive,
  normalizeText,
  notificationId,
  remindAt,
  reminderText,
  buildNotification,
  planAutoReminders,
  planManualUpdates,
  planOffsetChange,
  MAX_AUTO,
} from '../../native/reminders-core.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/yes-schedule.json', import.meta.url), 'utf8'));
const CHANNEL_NAMES = { PT26: ['ספורט 5', 55], CH34: ['קשת 12', 12] };

/** The fixture as the app turns it into programs (native/app.js does the same from fetchChannel). */
function programsFrom(keys = Object.keys(fixture.responses)) {
  const out = [];
  for (const key of keys) {
    const [chId, dayKey] = key.split(' ');
    const [channelName, channelNum] = CHANNEL_NAMES[chId];
    for (const it of fixture.responses[key].items) {
      out.push({
        id: it.id,
        title: it.title,
        desc: it.description,
        startMs: new Date(it.starts).getTime(),
        channelNum,
        channelName,
        dayKey,
      });
    }
  }
  return out;
}
const coverageOf = (keys) =>
  new Set(keys.map((k) => `${CHANNEL_NAMES[k.split(' ')[0]][1]}|${k.split(' ')[1]}`));

const ALL = programsFrom();
const KEYS = Object.keys(fixture.responses);
const MACCABI_BASKET = ALL.find((p) => p.id === 105110711); // ישיר! מ. ת''א - אל. קריית אתא (כדורסל)
const MACCABI_FOOTBALL = ALL.find((p) => p.id === 105110747); // ישיר! בית''ר י-ם - מ. ת''א (כדורגל)
const NOW = Date.parse('2026-10-17T12:00:00Z');
const settings = (over = {}) => ({ offset: 10, rules: [], skipReruns: true, liveOnly: false, dismissed: [], ...over });
const rule = (id, text) => ({ id, text });
/** What the plugin would report back for scheduled notifications. */
const asPending = (notifications) => notifications.map((n) => ({ id: n.id, schedule: n.schedule, extra: n.extra }));

test('fixture is the real API shape', () => {
  assert.ok(MACCABI_BASKET && MACCABI_FOOTBALL);
  for (const key of KEYS) {
    for (const it of fixture.responses[key].items) {
      assert.deepEqual(Object.keys(it).sort(), ['channelId', 'description', 'ends', 'id', 'imageUrl', 'programId', 'starts', 'title'].sort());
    }
  }
});

test('Hebrew matching: the full name finds the short form, quotes of every kind', () => {
  assert.equal(matchesRule(MACCABI_BASKET, 'מכבי תל אביב'), true, 'full name in the description');
  assert.equal(matchesRule(MACCABI_FOOTBALL, 'מכבי תל אביב'), true, "מכבי ת''א in the description");
  assert.equal(matchesRule({ title: 'מכבי ת״א נגד הפועל' }, 'מכבי תל אביב'), true, 'gershayim');
  assert.equal(matchesRule({ title: 'מכבי ת"א נגד הפועל' }, 'מכבי ת"א'), true);
  assert.equal(matchesRule({ title: 'הפועל ת"א נגד בני יהודה' }, 'מכבי תל אביב'), false, 'another Tel Aviv team');
  assert.equal(matchesRule({ title: 'MACCABI Tel Aviv' }, 'maccabi tel aviv'), true, 'case-insensitive for Latin');
});

test('a term + another term: both must appear (basketball, not football)', () => {
  const r = 'מכבי תל אביב + כדורסל';
  assert.equal(matchesRule(MACCABI_BASKET, r), true);
  assert.equal(matchesRule(MACCABI_FOOTBALL, r), false);
  const matched = ALL.filter((p) => matchesRule(p, r)).map((p) => p.id);
  assert.deepEqual(matched, [105110711]);
});

test('whole words only, with a Hebrew prefix letter allowed', () => {
  assert.equal(matchesRule({ title: 'אוהדי מכביסטים' }, 'מכבי'), false);
  assert.equal(matchesRule({ title: 'הכנה למכבי תל אביב' }, 'מכבי תל אביב'), true, 'ל prefix');
  assert.equal(matchesRule({ title: 'anything' }, '   '), false, 'an empty rule matches nothing');
  assert.equal(normalizeText("ת''א  –  ב״ש"), 'ת"א - ב"ש');
});

test('reruns are recognised from the schedule wording', () => {
  const rerun = ALL.find((p) => p.id === 105110739);
  assert.equal(isRerun(rerun), true);
  assert.equal(isRerun(MACCABI_BASKET), false);
});

test('notification id: yes id when valid, else a stable positive 31-bit hash', () => {
  assert.equal(notificationId(MACCABI_BASKET), 105110711);
  const noId = { channelNum: 55, startMs: Date.parse('2026-10-18T17:40:00Z') };
  const a = notificationId(noId);
  assert.equal(a, notificationId({ ...noId }), 'same inputs, same id');
  assert.ok(Number.isInteger(a) && a > 0 && a < 2 ** 31);
  assert.notEqual(a, notificationId({ ...noId, startMs: noId.startMs + 60_000 }), 'another time, another id');
  assert.ok(notificationId({ id: 2 ** 40, channelNum: 55, startMs: 1 }) < 2 ** 31, 'too-big id falls back to the hash');
  assert.ok(notificationId({ id: -3, channelNum: 55, startMs: 1 }) > 0);
});

test('reminder time and text', () => {
  const start = Date.parse('2026-10-18T17:40:00Z');
  assert.equal(remindAt(start, 10), start - 600_000);
  assert.equal(remindAt(start, 0), start);
  assert.deepEqual(reminderText({ title: 'מ. ת"א - אל. קריית אתא', channelName: 'ספורט 5', offset: 10, timeLabel: '20:40' }), {
    title: 'מ. ת"א - אל. קריית אתא',
    body: 'ספורט 5 · 20:40 · בעוד 10 דקות',
  });
  assert.equal(reminderText({ title: 'x', channelName: 'ספורט 5', offset: 0 }).body, 'ספורט 5 · מתחיל עכשיו');
});

test('settings: defaults for missing or corrupted storage, round trip', () => {
  const store = (v) => ({ getItem: () => v, setItem() {} });
  assert.deepEqual(loadSettings(store(null)), { offset: 10, rules: [], skipReruns: true, liveOnly: false, dismissed: [] });
  assert.deepEqual(loadSettings(store('{not json')), loadSettings(store(null)));
  const odd = loadSettings(store(JSON.stringify({ offset: 7, rules: [{ id: 'a', text: ' x ' }, { text: 'no id' }, null], skipReruns: 'yes' })));
  assert.deepEqual(odd, { offset: 10, rules: [{ id: 'a', text: 'x' }], skipReruns: true, liveOnly: false, dismissed: [] });
  const mem = {};
  const real = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => (mem[k] = v) };
  saveSettings(real, { offset: 5, rules: [rule('r1', 'מכבי')], skipReruns: false, liveOnly: true, dismissed: [3] });
  assert.ok(mem[SETTINGS_KEY]);
  assert.deepEqual(loadSettings(real), { offset: 5, rules: [rule('r1', 'מכבי')], skipReruns: false, liveOnly: true, dismissed: [3] });
  assert.equal(saveSettings({ setItem() { throw new Error('full'); } }, {}), false, 'a storage failure is not a crash');
});

test('auto plan: one reminder per matching future program, reruns skipped, past ignored', () => {
  const s = settings({ rules: [rule('r1', 'מכבי תל אביב')] });
  const { schedule, cancel } = planAutoReminders({ programs: ALL, coverage: coverageOf(KEYS), settings: s, pending: [], now: NOW, exact: true });
  const ids = schedule.map((n) => n.id).sort();
  // At 12:00Z: the youth-league game (16:00Z), the basketball game and the football game are all ahead.
  assert.deepEqual(ids, [105055600, 105110711, 105110747].sort());
  assert.equal(cancel.length, 0);
  const n = schedule.find((x) => x.id === 105110711);
  assert.equal(n.schedule.at.getTime(), MACCABI_BASKET.startMs - 600_000);
  assert.deepEqual(n.extra.rules, ['r1']);
  assert.equal(n.extra.kind, 'auto');
  assert.equal(n.isExactNotification, true);

  const later = planAutoReminders({ programs: ALL, coverage: coverageOf(KEYS), settings: s, pending: [], now: Date.parse('2026-10-18T18:00:00Z') });
  assert.deepEqual(later.schedule.map((x) => x.id), [105110747], 'started programs are skipped');

  const withReruns = planAutoReminders({
    programs: ALL,
    coverage: coverageOf(KEYS),
    settings: settings({ rules: [rule('r1', 'בני סכנין')], skipReruns: false }),
    pending: [],
    now: NOW,
  });
  assert.ok(withReruns.schedule.length >= 1, 'reruns count when the setting allows them');
  const skip = planAutoReminders({ programs: ALL, coverage: coverageOf(KEYS), settings: settings({ rules: [rule('r1', 'בני סכנין')] }), pending: [], now: NOW });
  assert.equal(skip.schedule.length, 0, 'the Sakhnin games here are all reruns');
});

test('auto plan: invalid or missing dates are skipped safely', () => {
  const bad = [
    { ...MACCABI_BASKET, id: 1, startMs: NaN },
    { ...MACCABI_BASKET, id: 2, startMs: undefined },
    { ...MACCABI_BASKET, id: 3, startMs: 0 },
  ];
  const { schedule } = planAutoReminders({ programs: bad, coverage: new Set(), settings: settings({ rules: [rule('r', 'מכבי')] }), pending: [], now: NOW });
  assert.deepEqual(schedule, []);
});

test('auto plan: running the same scan again schedules nothing new (no duplicates)', () => {
  const s = settings({ rules: [rule('r1', 'מכבי תל אביב')] });
  const first = planAutoReminders({ programs: ALL, coverage: coverageOf(KEYS), settings: s, pending: [], now: NOW, exact: true });
  const again = planAutoReminders({ programs: ALL, coverage: coverageOf(KEYS), settings: s, pending: asPending(first.schedule), now: NOW, exact: true });
  assert.deepEqual(again, { schedule: [], cancel: [] });
});

test('auto plan: several rules matching one program make one reminder listing both', () => {
  const s = settings({ rules: [rule('a', 'מכבי תל אביב'), rule('b', 'קריית אתא')] });
  const { schedule } = planAutoReminders({ programs: [MACCABI_BASKET], coverage: coverageOf(KEYS), settings: s, pending: [], now: NOW });
  assert.equal(schedule.length, 1);
  assert.deepEqual(schedule[0].extra.rules.sort(), ['a', 'b']);
});

test('auto plan: a changed start time moves the reminder (same id)', () => {
  const s = settings({ rules: [rule('r1', 'מכבי תל אביב + כדורסל')] });
  const first = planAutoReminders({ programs: [MACCABI_BASKET], coverage: coverageOf(KEYS), settings: s, pending: [], now: NOW });
  const moved = { ...MACCABI_BASKET, startMs: MACCABI_BASKET.startMs + 30 * 60_000 };
  const next = planAutoReminders({ programs: [moved], coverage: coverageOf(KEYS), settings: s, pending: asPending(first.schedule), now: NOW });
  assert.equal(next.schedule.length, 1);
  assert.equal(next.schedule[0].id, MACCABI_BASKET.id);
  assert.equal(next.schedule[0].schedule.at.getTime(), moved.startMs - 600_000);
  assert.deepEqual(next.cancel, []);
});

test('auto plan: a moved program WITHOUT a yes id leaves no stale reminder behind', () => {
  const s = settings({ rules: [rule('r1', 'מכבי תל אביב + כדורסל')] });
  const noId = { ...MACCABI_BASKET, id: undefined };
  const first = planAutoReminders({ programs: [noId], coverage: coverageOf(KEYS), settings: s, pending: [], now: NOW });
  const moved = { ...noId, startMs: noId.startMs + 30 * 60_000 };
  const next = planAutoReminders({ programs: [moved], coverage: coverageOf(KEYS), settings: s, pending: asPending(first.schedule), now: NOW });
  assert.equal(next.schedule.length, 1);
  assert.notEqual(next.schedule[0].id, first.schedule[0].id);
  assert.deepEqual(next.cancel, [first.schedule[0].id]);
});

test('auto plan: obsolete automatic reminders are cancelled, manual ones never', () => {
  const s = settings({ rules: [rule('r1', 'מכבי תל אביב')] });
  const first = planAutoReminders({ programs: ALL, coverage: coverageOf(KEYS), settings: s, pending: [], now: NOW });
  const manual = buildNotification({ program: ALL.find((p) => p.id === 105110709), offset: 10, kind: 'manual' });
  const pending = [...asPending(first.schedule), ...asPending([manual])];

  // The rule is deleted: every automatic reminder goes, the manual one stays.
  const noRules = planAutoReminders({ programs: ALL, coverage: coverageOf(KEYS), settings: settings(), pending, now: NOW });
  assert.deepEqual(noRules.cancel.sort(), first.schedule.map((n) => n.id).sort());
  assert.ok(!noRules.cancel.includes(manual.id));

  // A manual reminder on a matching program keeps it from getting an automatic one too.
  const manualOnMatch = buildNotification({ program: MACCABI_BASKET, offset: 10, kind: 'manual' });
  const plan = planAutoReminders({ programs: ALL, coverage: coverageOf(KEYS), settings: s, pending: asPending([manualOnMatch]), now: NOW });
  assert.ok(!plan.schedule.some((n) => n.id === MACCABI_BASKET.id));
  assert.ok(!plan.cancel.includes(MACCABI_BASKET.id));
});

test('auto plan: a failed scan of a channel/day proves nothing - its reminders stay', () => {
  const s = settings({ rules: [rule('r1', 'מכבי תל אביב')] });
  const first = planAutoReminders({ programs: ALL, coverage: coverageOf(KEYS), settings: s, pending: [], now: NOW });
  // Next scan: Sport 5 failed for 18 and 19 October (no programs, no coverage for them).
  const okKeys = KEYS.filter((k) => !/PT26 2026-10-1[89]/.test(k));
  const partial = planAutoReminders({ programs: programsFrom(okKeys), coverage: coverageOf(okKeys), settings: s, pending: asPending(first.schedule), now: NOW });
  assert.ok(!partial.cancel.includes(105110711) && !partial.cancel.includes(105110747));
  // Everything failed: nothing is cancelled at all.
  const none = planAutoReminders({ programs: [], coverage: new Set(), settings: s, pending: asPending(first.schedule), now: NOW });
  assert.deepEqual(none.cancel, []);
  // The day loaded fine and the program is gone: now it is cancelled.
  const gone = programsFrom(KEYS).filter((p) => p.id !== 105110711);
  const proven = planAutoReminders({ programs: gone, coverage: coverageOf(KEYS), settings: s, pending: asPending(first.schedule), now: NOW });
  assert.deepEqual(proven.cancel, [105110711]);
});

test('auto plan: dismissed reminders are not scheduled again', () => {
  const s = settings({ rules: [rule('r1', 'מכבי תל אביב + כדורסל')], dismissed: [105110711] });
  const { schedule } = planAutoReminders({ programs: ALL, coverage: coverageOf(KEYS), settings: s, pending: [], now: NOW });
  assert.deepEqual(schedule, []);
});

test('auto plan: at most MAX_AUTO reminders, the nearest ones', () => {
  const many = Array.from({ length: MAX_AUTO + 20 }, (_, i) => ({
    id: 1000 + i,
    title: 'מכבי תל אביב',
    desc: '',
    startMs: NOW + (i + 1) * 3_600_000,
    channelNum: 55,
    channelName: 'ספורט 5',
    dayKey: 'd',
  }));
  const { schedule } = planAutoReminders({ programs: many, coverage: new Set(['55|d']), settings: settings({ rules: [rule('r', 'מכבי')] }), pending: [], now: NOW });
  assert.equal(schedule.length, MAX_AUTO);
  assert.equal(Math.max(...schedule.map((n) => n.id)), 1000 + MAX_AUTO - 1);
});

test('manual reminders follow their program to a new time', () => {
  const manual = buildNotification({ program: MACCABI_BASKET, offset: 10, kind: 'manual' });
  const moved = { ...MACCABI_BASKET, startMs: MACCABI_BASKET.startMs + 15 * 60_000 };
  const s = settings();
  assert.deepEqual(planManualUpdates({ programs: [MACCABI_BASKET], pending: asPending([manual]), settings: s, now: NOW }), [], 'unchanged');
  const out = planManualUpdates({ programs: [moved], pending: asPending([manual]), settings: s, now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, manual.id);
  assert.equal(out[0].extra.kind, 'manual');
  assert.equal(out[0].extra.startMs, moved.startMs);
  assert.deepEqual(planManualUpdates({ programs: [], pending: asPending([manual]), settings: s, now: NOW }), [], 'not found: left alone');
});

test('changing the offset reschedules what is pending, past ones untouched', () => {
  const future = buildNotification({ program: MACCABI_BASKET, offset: 10, kind: 'manual' });
  const past = buildNotification({ program: { ...MACCABI_FOOTBALL, startMs: NOW - 60_000 }, offset: 10, kind: 'auto', rules: ['r'] });
  const out = planOffsetChange({ pending: asPending([future, past]), offset: 15, now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].schedule.at.getTime(), MACCABI_BASKET.startMs - 15 * 60_000);
  assert.equal(out[0].extra.kind, 'manual');
});

test('live only: archive and studio-less broadcasts are left out', () => {
  assert.equal(isLive(MACCABI_BASKET), true, 'ישיר! in the title');
  assert.equal(isLive({ title: 'מ. ת"א - ה. י-ם, 1997', desc: 'כדורסל. מכבי תל אביב נגד הפועל ירושלים, גמר 1997.' }), false, 'archive game');
  const archive = { ...MACCABI_BASKET, id: 7, title: 'מ. ת"א - ה. י-ם, 1997', desc: 'כדורסל. מכבי תל אביב נגד הפועל ירושלים.' };
  const s = (liveOnly) => settings({ rules: [rule('r', 'מכבי תל אביב + כדורסל')], liveOnly });
  const ids = (liveOnly) => planAutoReminders({ programs: [MACCABI_BASKET, archive], coverage: coverageOf(KEYS), settings: s(liveOnly), pending: [], now: NOW }).schedule.map((n) => n.id).sort();
  assert.deepEqual(ids(false), [7, MACCABI_BASKET.id].sort());
  assert.deepEqual(ids(true), [MACCABI_BASKET.id]);
});
