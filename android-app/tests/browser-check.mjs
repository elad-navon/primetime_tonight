// Browser regression check for the website (the repository root), with Playwright and the real schedule
// data in tests/fixtures/yes-schedule.json served in place of the yes API, at a fixed time.
//
//   npm run test:browser
//
// 1. A normal browser: the page loads and lists the channels exactly as before; no bell, no reminder
//    settings, and nothing under native/ is even requested.
// 2. The same page with a stand-in for the Android app (window.Capacitor + a fake notification plugin in
//    place of native/vendor/capacitor.js): bells appear on programs that haven't started, a tap schedules
//    and a second tap cancels, a keyword rule schedules the matching broadcasts, and reopening the app
//    schedules nothing twice.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL('./fixtures/yes-schedule.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-10-17T12:00:00Z'); // a Saturday, 15:00 in Israel - the fixture's day

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // The Android stand-in: the fake plugin in place of the bundled one (see FAKE_PLUGIN).
  if (pathname === '/native/vendor/capacitor.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' }).end(FAKE_PLUGIN);
    return;
  }
  const path = normalize(join(ROOT, pathname));
  const file = path.endsWith('\\') || path.endsWith('/') ? join(path, 'index.html') : path;
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

/** The yes API, answered from the fixture (an empty day for anything it doesn't hold). */
async function routeSchedule(page) {
  await page.route('https://svc.yes.co.il/**', (route) => {
    const url = new URL(route.request().url());
    const key = `${url.pathname.split('/').pop()} ${url.searchParams.get('date')}`;
    const body = fixture.responses[key] ?? { items: [] };
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
}

/** Stand-in for the bundled plugin: keeps "scheduled" notifications in localStorage, like the real one keeps them across launches. */
const FAKE_PLUGIN = `
const KEY = 'fake-ln';
const load = () => JSON.parse(localStorage.getItem(KEY) || '{}');
const store = (m) => localStorage.setItem(KEY, JSON.stringify(m));
window.__ln = { scheduleCalls: 0, scheduled: () => Object.values(load()) };
export const Capacitor = { isNativePlatform: () => true };
export const LocalNotifications = {
  checkPermissions: async () => ({ display: 'granted' }),
  requestPermissions: async () => ({ display: 'granted' }),
  checkExactNotificationSetting: async () => ({ exact_alarm: 'granted' }),
  changeExactNotificationSetting: async () => ({ exact_alarm: 'granted' }),
  createChannel: async () => {},
  addListener: async () => ({ remove() {} }),
  getPending: async () => ({ notifications: Object.values(load()).map((n) => ({ id: n.id, title: n.title, body: n.body, schedule: n.schedule, extra: n.extra })) }),
  schedule: async ({ notifications }) => {
    window.__ln.scheduleCalls += notifications.length;
    const m = load();
    for (const n of notifications) m[n.id] = JSON.parse(JSON.stringify(n));
    store(m);
    return { notifications: notifications.map((n) => ({ id: n.id })) };
  },
  cancel: async ({ notifications }) => { const m = load(); for (const n of notifications) delete m[n.id]; store(m); },
};`;

const browser = await chromium.launch();
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (e) {
    failures++;
    console.log(`✖ ${name}\n  ${e.message.split('\n').join('\n  ')}`);
  }
}

async function openPage({ native }) {
  const context = await browser.newContext({ locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
  const page = await context.newPage();
  const errors = [];
  const nativeRequests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('request', (r) => r.url().includes('/native/') && nativeRequests.push(r.url()));
  await page.clock.setFixedTime(NOW);
  await routeSchedule(page);
  await page.route('**/sw.js', (route) => route.fulfill({ status: 404, body: '' })); // no service worker in tests
  if (native) {
    await page.addInitScript(() => {
      window.Capacitor = { isNativePlatform: () => true };
    });
  }
  await page.goto(base);
  await page.waitForSelector('#prime .card');
  return { page, context, errors, nativeRequests };
}

await check('desktop browser: the schedule shows as before, with no reminder UI', async () => {
  const { page, context, errors, nativeRequests } = await openPage({ native: false });
  assert.equal(await page.locator('#prime .card').count(), 9, 'a card per channel');
  assert.ok((await page.locator('#prime .hero').count()) >= 2, 'the fixture channels show programs');
  assert.ok((await page.locator('#rest .row').count()) > 0, 'the rest-of-the-day list');
  await page.click('.chip[data-filter="sport"]');
  assert.equal(await page.locator('#prime .card').count(), 6, 'the sport filter still works');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.pt-bell').count(), 0, 'no bells');
  assert.equal(await page.locator('#ptRemindersBtn').count(), 0, 'no reminders button');
  assert.deepEqual(nativeRequests, [], 'nothing under native/ is loaded');
  assert.deepEqual(errors, [], 'no errors');
  await context.close();
});

await check('Android app: bells, tap to set and tap to cancel', async () => {
  const { page, context, errors } = await openPage({ native: true });
  await page.waitForSelector('.pt-bell');
  const bells = page.locator('.pt-bell');
  assert.ok((await bells.count()) > 0);
  // Only programs that haven't started have a bell.
  const pastHasBell = await page.$$eval('.show.done', (els) => els.some((el) => el.querySelector('.pt-bell')));
  assert.equal(pastHasBell, false, 'no bell on a finished program');
  const first = bells.first();
  const k = await first.getAttribute('data-k');
  await first.click();
  await page.waitForSelector(`.pt-bell.on[data-k="${k}"]`);
  let scheduled = await page.evaluate(() => window.__ln.scheduled());
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].extra.kind, 'manual');
  assert.equal(scheduled[0].extra.at, scheduled[0].extra.startMs - 10 * 60_000, 'default: 10 minutes before');
  // The same program has a bell in its card and in the rest-of-the-day list; both show the same state.
  assert.equal(await page.locator(`.pt-bell[data-k="${k}"]:not(.on)`).count(), 0, 'every bell of that program is on');
  assert.equal(await page.locator('button.read-more .pt-bell').count(), 0, 'no bell inside "קרא עוד"');
  await page.locator(`.pt-bell[data-k="${k}"]`).first().click();
  await page.waitForSelector(`.pt-bell:not(.on)[data-k="${k}"]`);
  scheduled = await page.evaluate(() => window.__ln.scheduled());
  assert.equal(scheduled.length, 0, 'second tap cancels');
  assert.deepEqual(errors, []);
  await context.close();
});

await check('Android app: a keyword rule schedules its broadcasts once, also after reopening', async () => {
  const { page, context, errors } = await openPage({ native: true });
  await page.click('#ptRemindersBtn');
  await page.fill('#ptRuleText', 'מכבי תל אביב + כדורסל');
  await page.click('#ptDlg button[data-act="add"]');
  await page.waitForFunction(() => window.__ln.scheduled().length === 1);
  const [n] = await page.evaluate(() => window.__ln.scheduled());
  assert.equal(n.id, 105110711, 'the Maccabi basketball game only');
  assert.equal(n.extra.kind, 'auto');
  assert.match(n.body, /ספורט 5 · 20:40 · בעוד 10 דקות/);

  // Reopen the app: the scan runs again and schedules nothing new.
  await page.reload();
  await page.waitForSelector('.pt-bell');
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({ list: window.__ln.scheduled(), calls: window.__ln.scheduleCalls }));
  assert.equal(after.list.length, 1, 'still one reminder');
  assert.equal(after.calls, 0, 'nothing scheduled again');

  // Delete the rule: its reminder goes.
  await page.click('#ptRemindersBtn');
  await page.click('#ptDlg button[data-act="del-rule"]');
  await page.waitForFunction(() => window.__ln.scheduled().length === 0);
  assert.deepEqual(errors, []);
  await context.close();
});

await browser.close();
server.close();
if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall browser checks passed');
