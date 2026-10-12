'use strict';

// Reminders: the pure transition logic (alerts.evaluate) and the whole path
// stored dates/events → gc.notify({ topic, … }) against the mock host —
// evening/morning waste reminders, calendar reminders, restart idempotence,
// quiet when switched off, the hourly budget.

const test = require('node:test');
const assert = require('node:assert/strict');
const alerts = require('../server/alerts');
const tz = require('../server/tz');
const manifest = require('../plugin.json');
const { withHost, asAdmin, ADMIN, ADA, BERLIN, day, utc, vcal, vevent } = require('./helpers');

const H = 3600000;
const MIN = 60000;
const CFG = { wasteEnabled: true, calendarEnabled: true };
const at = (date, hh, mm = 0) => tz.at(date, { hh, mm }, BERLIN);

function obs(key, due, expires, kind = 'waste') { return { key, kind, due, expires }; }

test('evaluate: due and not expired → once; first run only records; restart keeps the memo', () => {
  const T = at('2026-10-12', 18);
  const o = [obs('w:1:2026-10-13:e', T, at('2026-10-13', 0))];
  // first run (nothing stored yet) at 18:05: already due → recorded, not announced
  const first = alerts.evaluate(null, o, CFG, T + 5 * MIN);
  assert.deepEqual(first.events, []);
  assert.ok(first.memo.sent['w:1:2026-10-13:e']);
  // a normal run: before → nothing, at → once, after → not again
  const m0 = alerts.evaluate(null, [], CFG, T - H).memo;
  assert.deepEqual(alerts.evaluate(m0, o, CFG, T - MIN).events, []);
  const r1 = alerts.evaluate(m0, o, CFG, T);
  assert.deepEqual(r1.events.map((e) => e.key), ['w:1:2026-10-13:e']);
  // restart: the memo comes back from storage as JSON
  const stored = JSON.parse(JSON.stringify(r1.memo));
  assert.deepEqual(alerts.evaluate(stored, o, CFG, T + MIN).events, []);
  // downtime 17:00 → 19:30: the 18:00 reminder is not lost …
  assert.deepEqual(alerts.evaluate(m0, o, CFG, T + 90 * MIN).events.length, 1);
  // … unless it expired meanwhile (pickup day began)
  assert.deepEqual(alerts.evaluate(m0, o, CFG, at('2026-10-13', 0, 1)).events, []);
});

test('evaluate: quiet when an area is switched off; old entries are forgotten after a day', () => {
  const T = at('2026-10-12', 18);
  const m0 = alerts.evaluate(null, [], CFG, T - H).memo;
  const o = [obs('w:1', T, T + H), obs('c:1', T, T + H, 'calendar')];
  assert.deepEqual(alerts.evaluate(m0, o, { wasteEnabled: false, calendarEnabled: true }, T).events.map((e) => e.key), ['c:1']);
  assert.deepEqual(alerts.evaluate(m0, o, { wasteEnabled: true, calendarEnabled: false }, T).events.map((e) => e.key), ['w:1']);
  assert.deepEqual(alerts.evaluate(m0, o, { wasteEnabled: false, calendarEnabled: false }, T).events, []);
  const r = alerts.evaluate(m0, o, CFG, T);
  assert.equal(Object.keys(r.memo.sent).length, 2);
  assert.equal(Object.keys(alerts.evaluate(r.memo, [], CFG, T + H + 25 * H).memo.sent).length, 0);
  assert.equal(Object.keys(alerts.evaluate(r.memo, [], CFG, T + 2 * H).memo.sent).length, 2);
});

async function rulesPlan(host, extra = {}) {
  const r = await asAdmin(host, 'POST', '/plans', { name: 'Zuhause', source: 'rules', rules: [{ name: 'Restmüll', start: day(1), weeks: 2 }, { name: 'Gelber Sack', start: day(1), weeks: 4 }], ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.plan.id;
}

test('waste: "Morgen: …" the evening before, "Heute: …" in the morning, collapse key per plan and day, no repeat after a restart', () => withHost({}, async (host) => {
  const planId = await rulesPlan(host);
  const today = day(0); const tomorrow = day(1);
  await alerts.check(host.gc, { now: at(today, 17) }); // first run: records only
  assert.equal(host.notifications.length, 0);
  await alerts.check(host.gc, { now: at(today, 17, 59) });
  assert.equal(host.notifications.length, 0, 'not before 18:00');
  await alerts.check(host.gc, { now: at(today, 18, 0) + 30000 });
  assert.equal(host.notifications.length, 1);
  const n = host.notifications[0];
  assert.equal(n.topic, 'waste');
  assert.equal(n.title, 'Morgen: Restmüll, Gelber Sack');
  assert.match(n.body, /^Zuhause · /);
  assert.equal(n.priority, 'normal');
  assert.equal(n.users, null, 'no people list: the topic rule decides');
  assert.equal(n.collapseKey, `waste:${planId}:${tomorrow}`);
  assert.deepEqual(n.data.facts[0], { label: 'Abfuhr', value: 'Restmüll, Gelber Sack' });
  assert.equal(n.data.route, 'plg-gatecontrol-alltag');
  await alerts.check(host.gc, { now: at(today, 18, 5) });
  alerts.reset(); // "restart": a fresh notifier, state from gc.storage
  await alerts.check(host.gc, { now: at(today, 18, 10) });
  assert.equal(host.notifications.length, 1, 'no repeat');
  // morning reminder only when switched on
  await alerts.check(host.gc, { now: at(tomorrow, 6, 31) });
  assert.equal(host.notifications.length, 1);
  host.settings.waste_morning = true;
  host.settings.waste_morning_time = '06:45';
  await alerts.check(host.gc, { now: at(tomorrow, 6, 46) });
  assert.equal(host.notifications.length, 2);
  assert.equal(host.notifications[1].title, 'Heute: Restmüll, Gelber Sack');
  assert.equal(host.notifications[1].collapseKey, `waste:${planId}:${tomorrow}`, 'replaces the evening one');
  // English
  host.settings.notify_lang = 'en';
  host.settings.waste_evening_time = '19:30';
  const in15 = day(15); // the next Restmüll (every two weeks from tomorrow)
  await alerts.check(host.gc, { now: at(tz.addDays(in15, -1), 19, 31) });
  assert.equal(host.notifications[2].title, 'Tomorrow: Restmüll');
}));

test('waste: a plan for selected people goes only to them; switched off = quiet; hidden fractions are not announced', () => withHost({}, async (host) => {
  const planId = await rulesPlan(host, { users: [ADA.id] });
  const today = day(0);
  await alerts.check(host.gc, { now: at(today, 12) });
  host.settings.waste_enabled = false;
  await alerts.check(host.gc, { now: at(today, 18, 1) });
  assert.equal(host.notifications.length, 0, 'switched off');
  host.settings.waste_enabled = true;
  const st = await asAdmin(host, 'GET', '/status');
  const yellow = st.json.plans[0].fractions.find((f) => f.name === 'Gelber Sack');
  await asAdmin(host, 'PUT', `/plans/${planId}/fractions/${yellow.id}`, { hidden: true });
  await alerts.check(host.gc, { now: at(today, 18, 2) });
  assert.equal(host.notifications.length, 1);
  assert.deepEqual(host.notifications[0].users, [ADA.id]);
  assert.equal(host.notifications[0].title, 'Morgen: Restmüll');
  // limited to nobody: nobody (not the topic's subscribers)
  await asAdmin(host, 'PUT', `/plans/${planId}`, { users: [] });
  await alerts.check(host.gc, { now: at(day(14), 18, 1) });
  assert.equal(host.notifications.length, 1);
}));

function calServer(text) {
  return { web: () => ({ status: 200, body: text }) };
}

test('calendar: N minutes before a timed event, all-day events in the morning, only to the subscription\'s people', () => {
  const now0 = Date.now();
  const start = Math.ceil((now0 + 6 * H) / MIN) * MIN;
  const tomorrow = day(1);
  const text = vcal(
    vevent(['UID:t1', `DTSTART:${utc(start)}`, `DTEND:${utc(start + H)}`, 'SUMMARY:Zahnarzt', 'LOCATION:Praxis']),
    vevent(['UID:a1', `DTSTART;VALUE=DATE:${tomorrow.replace(/-/g, '')}`, 'SUMMARY:Geburtstag Oma']),
  );
  return withHost(calServer(text), async (host) => {
    const r = await asAdmin(host, 'POST', '/subscriptions', { name: 'Familie', source: 'url', url: 'https://calendar.google.com/calendar/ical/x/private-y/basic.ics', users: [ADA.id], reminder: '15' });
    assert.equal(r.json.result.events, 2);
    await alerts.check(host.gc, { now: now0 }); // first run
    await alerts.check(host.gc, { now: start - 16 * MIN });
    assert.equal(host.notifications.length, 0);
    await alerts.check(host.gc, { now: start - 15 * MIN });
    assert.equal(host.notifications.length, 1);
    const n = host.notifications[0];
    assert.equal(n.topic, 'calendar');
    assert.equal(n.title, 'Zahnarzt');
    assert.match(n.body, /^In 15 Minuten · \d\d:\d\d–\d\d:\d\d · Praxis$/);
    assert.deepEqual(n.users, [ADA.id]);
    assert.match(n.collapseKey, /^cal:\d+:[0-9a-f]{16}$/);
    assert.deepEqual(n.data.facts.map((f) => f.label), ['Kalender', 'Zeit', 'Ort']);
    await alerts.check(host.gc, { now: start - 10 * MIN });
    await alerts.check(host.gc, { now: start + 5 * MIN });
    assert.equal(host.notifications.length, 1, 'once');
    await alerts.check(host.gc, { now: at(tomorrow, 7, 1) });
    const allDay = host.notifications.find((x) => x.title === 'Geburtstag Oma');
    assert.ok(allDay, 'all-day event in the morning');
    assert.equal(allDay.body, 'Heute · ganztägig');
    // nobody assigned → nobody is reminded
    const sid = r.json.subscription.id;
    await asAdmin(host, 'PUT', `/subscriptions/${sid}`, { users: [] });
    const count = host.notifications.length;
    await alerts.check(host.gc, { now: at(day(1), 8) + 7 * 86400000 });
    assert.equal(host.notifications.length, count);
  });
});

test('calendar reminder settings: off / at the start; switched-off area is quiet', () => {
  const now0 = Date.now();
  const start = Math.ceil((now0 + 5 * H) / MIN) * MIN;
  const text = vcal(vevent(['UID:t1', `DTSTART:${utc(start)}`, 'SUMMARY:Call']));
  return withHost(calServer(text), async (host) => {
    const r = await asAdmin(host, 'POST', '/subscriptions', { name: 'Arbeit', source: 'url', url: 'https://outlook.office365.com/owa/calendar/a/b/calendar.ics', reminder: 'off' });
    await alerts.check(host.gc, { now: now0 });
    await alerts.check(host.gc, { now: start });
    assert.equal(host.notifications.length, 0, 'off');
    await asAdmin(host, 'PUT', `/subscriptions/${r.json.subscription.id}`, { reminder: 'start' });
    host.settings.calendar_enabled = false;
    await alerts.check(host.gc, { now: start + MIN });
    assert.equal(host.notifications.length, 0, 'area off');
    host.settings.calendar_enabled = true;
    await alerts.check(host.gc, { now: start + 2 * MIN });
    assert.equal(host.notifications.length, 1);
    assert.match(host.notifications[0].body, /^Jetzt · /);
    assert.deepEqual(host.notifications[0].users, [ADMIN.id], 'default: the administrator who added it');
  });
});

test('budget: a burst is capped by the notifier, the rest follows while still due', () => {
  const tomorrow = day(1);
  const text = vcal(...Array.from({ length: 24 }, (_, i) => vevent([`UID:b${i}`, `DTSTART;VALUE=DATE:${tomorrow.replace(/-/g, '')}`, `SUMMARY:Termin ${i + 1}`])));
  return withHost(calServer(text), async (host) => {
    await asAdmin(host, 'POST', '/subscriptions', { name: 'Viele', source: 'url', url: 'https://calendar.google.com/calendar/ical/x/private-y/basic.ics' });
    await alerts.check(host.gc, { now: at(day(0), 12) });
    await alerts.check(host.gc, { now: at(tomorrow, 7, 1) });
    assert.equal(host.notifications.length, 20, 'normal priority stops at 20 per hour');
    assert.ok(host.logs.some((l) => /hourly budget/.test(l.message)));
    await alerts.check(host.gc, { now: at(tomorrow, 7, 2) });
    assert.equal(host.notifications.length, 20, 'still throttled');
    alerts.reset(); // an hour later the notifier's window is free again (fresh notifier = empty window)
    await alerts.check(host.gc, { now: at(tomorrow, 8, 2) });
    assert.equal(host.notifications.length, 24, 'the held-back ones follow — none lost');
    assert.equal(new Set(host.notifications.map((n) => n.title)).size, 24, 'none twice');
  });
});

test('test reminder goes only to the requesting administrator; topics are declared', () => withHost({}, async (host) => {
  assert.deepEqual(manifest.notifyTopics.map((x) => x.id), ['waste', 'calendar']);
  const w = await asAdmin(host, 'POST', '/test/waste');
  assert.deepEqual(w.json, { ok: true, pushed: true, error: null });
  const c = await asAdmin(host, 'POST', '/test/calendar');
  assert.equal(c.json.ok, true);
  assert.deepEqual(host.notifications.map((n) => [n.topic, n.users, n.collapseKey]), [['waste', [ADMIN.id], 'test:waste'], ['calendar', [ADMIN.id], 'test:calendar']]);
  assert.match(host.notifications[0].title, /^Test – Morgen: /);
  assert.match(host.notifications[1].title, /^Test – /);
}));

test('the background run sends reminders and refreshes what is due', () => withHost({}, async (host) => {
  await rulesPlan(host);
  await host.tick();
  assert.ok(await host.gc.storage.get(alerts.STATE_KEY), 'reminder state stored');
}));
