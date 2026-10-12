'use strict';

// The reminder of each waste plan (1.1.0): when it is due (lead 0–3 days at
// HH:MM, DST-correct, optionally also on the pickup day), the plans of 1.0.0
// on the plugin settings (migration 002), the late rule of evaluate() (a
// changed setting never repeats or floods), API validation, texts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const alerts = require('../server/alerts');
const config = require('../server/config');
const store = require('../server/store');
const format = require('../server/format');
const tz = require('../server/tz');
const texts = require('../server/texts.json');
const { withHost, asAdmin, BERLIN, day } = require('./helpers');

const H = 3600000;
const MIN = 60000;
const CFG = { wasteEnabled: true, calendarEnabled: true };
const at = (date, hh, mm = 0) => tz.at(date, { hh, mm }, BERLIN);
const iso = (ms) => new Date(ms).toISOString();
const DEF = config.fromSettings({});
const rem = (lead, time, extra = false, extraTime = '06:30') => ({ lead, time: tz.parseTime(time), extra, extraTime: tz.parseTime(extraTime) });
const sched = (date, r) => alerts.wasteSchedule(date, r, BERLIN).map((s) => [s.kind, iso(s.due), iso(s.expires)]);

// ─── when ───────────────────────────────────────

test('schedule: lead 0–3 days at HH:MM, until the pickup day begins (same day: until noon, at least 2 h)', () => {
  // an ordinary week (CEST, UTC+2): pickup Thu 2026-10-15
  assert.deepEqual(sched('2026-10-15', rem(1, '18:00')), [['e', '2026-10-14T16:00:00.000Z', '2026-10-14T22:00:00.000Z']]);
  assert.deepEqual(sched('2026-10-15', rem(2, '19:30')), [['e', '2026-10-13T17:30:00.000Z', '2026-10-14T22:00:00.000Z']]);
  assert.deepEqual(sched('2026-10-15', rem(3, '07:05')), [['e', '2026-10-12T05:05:00.000Z', '2026-10-14T22:00:00.000Z']]);
  assert.deepEqual(sched('2026-10-15', rem(0, '06:30')), [['e', '2026-10-15T04:30:00.000Z', '2026-10-15T10:00:00.000Z']]);
  assert.deepEqual(sched('2026-10-15', rem(0, '11:00')), [['e', '2026-10-15T09:00:00.000Z', '2026-10-15T11:00:00.000Z']], 'at least 2 h');
  // plus the pickup-day one; none at all
  assert.deepEqual(sched('2026-10-15', rem(1, '18:00', true, '06:45')), [['e', '2026-10-14T16:00:00.000Z', '2026-10-14T22:00:00.000Z'], ['m', '2026-10-15T04:45:00.000Z', '2026-10-15T10:00:00.000Z']]);
  assert.deepEqual(sched('2026-10-15', rem(null, '18:00', true, '06:45')), [['m', '2026-10-15T04:45:00.000Z', '2026-10-15T10:00:00.000Z']]);
  assert.deepEqual(sched('2026-10-15', rem(null, '18:00')), []);
});

test('schedule: DST change days keep the local wall clock (Europe/Berlin)', () => {
  // autumn: Sun 2026-10-25 03:00 CEST → 02:00 CET
  assert.deepEqual(sched('2026-10-26', rem(1, '18:00')), [['e', '2026-10-25T17:00:00.000Z', '2026-10-25T23:00:00.000Z']], 'due on the change day (CET)');
  assert.deepEqual(sched('2026-10-27', rem(2, '18:00')), [['e', '2026-10-25T17:00:00.000Z', '2026-10-26T23:00:00.000Z']]);
  assert.deepEqual(sched('2026-10-28', rem(3, '06:00')), [['e', '2026-10-25T05:00:00.000Z', '2026-10-27T23:00:00.000Z']]);
  assert.deepEqual(sched('2026-10-25', rem(1, '18:00')), [['e', '2026-10-24T16:00:00.000Z', '2026-10-24T22:00:00.000Z']], 'pickup on the change day (CEST evening before)');
  assert.deepEqual(sched('2026-10-25', rem(0, '06:30', true, '07:00')), [['e', '2026-10-25T05:30:00.000Z', '2026-10-25T11:00:00.000Z'], ['m', '2026-10-25T06:00:00.000Z', '2026-10-25T11:00:00.000Z']]);
  // spring: Sun 2026-03-29 02:00 CET → 03:00 CEST
  assert.deepEqual(sched('2026-03-31', rem(3, '18:00')), [['e', '2026-03-28T17:00:00.000Z', '2026-03-30T22:00:00.000Z']]);
  assert.deepEqual(sched('2026-03-30', rem(1, '18:00')), [['e', '2026-03-29T16:00:00.000Z', '2026-03-29T22:00:00.000Z']], 'due on the change day (CEST)');
  assert.deepEqual(sched('2026-03-29', rem(1, '18:00')), [['e', '2026-03-28T17:00:00.000Z', '2026-03-28T23:00:00.000Z']]);
  assert.deepEqual(sched('2026-03-29', rem(0, '02:30')), [['e', '2026-03-29T01:30:00.000Z', '2026-03-29T10:00:00.000Z']], 'in the gap: moved forward to 03:30');
  // the local times of all leads around both changes are exactly HH:MM
  for (const date of ['2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']) {
    for (const lead of [0, 1, 2, 3]) {
      const [s] = alerts.wasteSchedule(date, rem(lead, '18:15'), BERLIN);
      const p = tz.parts(s.due, BERLIN);
      assert.deepEqual([tz.localDate(s.due, BERLIN), p.hh, p.mm], [tz.addDays(date, -lead), 18, 15], `${date} lead ${lead}`);
    }
  }
});

test('reminderOf: no own setting (null) = the plugin settings; own fields win; "off"', () => {
  assert.deepEqual(alerts.reminderOf({ reminder: { lead: null, time: null, extra: null, extra_time: null } }, DEF),
    { lead: 1, time: { hh: 18, mm: 0 }, extra: false, extraTime: { hh: 6, mm: 30 }, custom: false });
  const cfg = config.fromSettings({ waste_evening_time: '19:15', waste_morning: true, waste_morning_time: '06:00' });
  assert.deepEqual(alerts.reminderOf({ reminder: null }, cfg), { lead: 1, time: { hh: 19, mm: 15 }, extra: true, extraTime: { hh: 6, mm: 0 }, custom: false });
  assert.deepEqual(alerts.reminderOf({ reminder: { lead: 3, time: '07:05', extra: false, extra_time: null } }, cfg),
    { lead: 3, time: { hh: 7, mm: 5 }, extra: false, extraTime: { hh: 6, mm: 0 }, custom: true });
  assert.equal(alerts.reminderOf({ reminder: { lead: 'off', time: null, extra: null, extra_time: null } }, cfg).lead, null);
  assert.equal(alerts.reminderOf({ reminder: { lead: 0 } }, cfg).lead, 0);
});

// ─── migration 002 ──────────────────────────────

test('migration 002: plans of 1.0.0 get NULL (= plugin settings); the columns round-trip', () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = path.join(__dirname, '..', 'migrations');
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(dir, '001_init.sql'), 'utf8'));
  db.prepare("INSERT INTO plans (name, source, rules_json) VALUES ('Zuhause', 'rules', '[]')").run();
  db.exec(fs.readFileSync(path.join(dir, '002_plan_reminder.sql'), 'utf8'));
  const row = db.prepare('SELECT * FROM plans').get();
  assert.deepEqual([row.remind_lead, row.remind_time, row.remind_extra, row.remind_extra_time], [null, null, null, null]);
  const r = store.reminderRow(row);
  assert.deepEqual(r, { lead: null, time: null, extra: null, extra_time: null });
  assert.equal(alerts.reminderOf({ reminder: r }, DEF).custom, false);
  for (const v of [{ lead: 'off', time: '18:00', extra: false, extra_time: null }, { lead: 0, time: '06:30', extra: true, extra_time: '05:15' }, { lead: 3, time: null, extra: null, extra_time: null }]) {
    db.prepare('UPDATE plans SET remind_lead = ?, remind_time = ?, remind_extra = ?, remind_extra_time = ?').run(...store.reminderCols(v));
    assert.deepEqual(store.reminderRow(db.prepare('SELECT * FROM plans').get()), v);
  }
  assert.deepEqual(store.reminderCols(null), [null, null, null, null]);
  db.close();
});

// ─── evaluate: changed settings, late ones, catch-up ───

const w = (plan, date, kind, due, expires) => ({ key: `w:${plan}:${date}:${kind}`, kind: 'waste', group: `w:${plan}`, date, due, expires });
const keys = (r) => r.events.map((e) => e.key);

test('evaluate: a changed setting does not repeat a reminder of the same day and kind, and sends no flood', () => {
  const T = at('2026-10-12', 18);
  const m0 = alerts.evaluate(null, [], CFG, T - H).memo;
  // 1 day before at 18:00: Tuesday's reminder goes out
  const r1 = alerts.evaluate(m0, [w(1, '2026-10-13', 'e', T, at('2026-10-13', 0))], CFG, T);
  assert.deepEqual(keys(r1), ['w:1:2026-10-13:e']);
  // 20:00: changed to 3 days before at 18:00 — Tue already sent, Wed and Thu are late: only the nearest
  const lead3 = [
    w(1, '2026-10-13', 'e', at('2026-10-10', 18), at('2026-10-13', 0)),
    w(1, '2026-10-15', 'e', at('2026-10-12', 18), at('2026-10-15', 0)),
    w(1, '2026-10-14', 'e', at('2026-10-11', 18), at('2026-10-14', 0)),
  ];
  const r2 = alerts.evaluate(r1.memo, lead3, CFG, at('2026-10-12', 20, 1));
  assert.deepEqual(keys(r2), ['w:1:2026-10-14:e'], 'one late reminder (the nearest pickup), not three');
  assert.ok(r2.memo.sent['w:1:2026-10-15:e'], 'the others are recorded');
  assert.deepEqual(keys(alerts.evaluate(r2.memo, lead3, CFG, at('2026-10-12', 20, 2))), []);
  // a later time for the same days: nothing again
  const later = lead3.map((o) => ({ ...o, due: o.due + 2 * H }));
  assert.deepEqual(keys(alerts.evaluate(r2.memo, later, CFG, at('2026-10-12', 20, 5))), []);
  // back to "on the day" for Tuesday: the main reminder of that day was sent already
  const r3 = alerts.evaluate(r2.memo, [w(1, '2026-10-13', 'e', at('2026-10-13', 6, 30), at('2026-10-13', 12))], CFG, at('2026-10-13', 6, 31));
  assert.deepEqual(keys(r3), []);
  // … the pickup-day one is another kind
  const r4 = alerts.evaluate(r3.memo, [w(1, '2026-10-13', 'm', at('2026-10-13', 6, 45), at('2026-10-13', 12))], CFG, at('2026-10-13', 6, 45));
  assert.deepEqual(keys(r4), ['w:1:2026-10-13:m']);
});

test('evaluate: late ones per plan; none when the plan sends a regular one; downtime and retries are not limited', () => {
  const T = at('2026-10-12', 18);
  const m0 = alerts.evaluate(null, [], CFG, T - H).memo; // last check 17:00
  const exp = at('2026-10-20', 0);
  // two plans, each with two late ones (due before the last check): one per plan, nearest date first, then the latest due
  const late = [w(1, '2026-10-15', 'e', T - 3 * H, exp), w(1, '2026-10-14', 'e', T - 4 * H, exp), w(1, '2026-10-14', 'm', T - 2 * H, exp), w(2, '2026-10-16', 'e', T - 5 * H, exp), w(2, '2026-10-17', 'e', T - 2 * H, exp)];
  assert.deepEqual(keys(alerts.evaluate(m0, late, CFG, T)).sort(), ['w:1:2026-10-14:m', 'w:2:2026-10-16:e']);
  // a regular one of the plan (due since the last check) wins; the late ones are recorded
  const r = alerts.evaluate(m0, [...late, w(1, '2026-10-13', 'e', T, exp)], CFG, T);
  assert.deepEqual(keys(r).sort(), ['w:1:2026-10-13:e', 'w:2:2026-10-16:e']);
  assert.ok(r.memo.sent['w:1:2026-10-15:e']);
  // downtime 17:00 → 19:30: everything that fell due meanwhile goes out (as in 1.0.0)
  const down = [w(1, '2026-10-13', 'e', T, exp), w(1, '2026-10-14', 'e', T + 30 * MIN, exp), w(1, '2026-10-13', 'm', T + H, exp)];
  assert.equal(alerts.evaluate(m0, down, CFG, T + 90 * MIN).events.length, 3);
  // held back by the budget (retry): not late
  const held = [w(1, '2026-10-13', 'e', T - 10 * MIN, exp), w(1, '2026-10-14', 'e', T - 5 * MIN, exp)];
  const prev = { v: 2, at: T, sent: {}, retry: { 'w:1:2026-10-13:e': exp, 'w:1:2026-10-14:e': exp } };
  const rr = alerts.evaluate(prev, held, CFG, T + MIN);
  assert.equal(rr.events.length, 2);
  assert.deepEqual(rr.memo.retry, {}, 'sent: no longer waiting');
  assert.equal(alerts.evaluate({ ...prev, retry: {} }, held, CFG, T + MIN).events.length, 1, 'without the retry mark both would be late');
  // calendar observations have no group: unchanged (a late one is sent)
  assert.deepEqual(keys(alerts.evaluate(m0, [{ key: 'c:1', kind: 'calendar', due: T - 2 * H, expires: T + H }, { key: 'c:2', kind: 'calendar', due: T - 3 * H, expires: T + H }], CFG, T)), ['c:1', 'c:2']);
  // a 1.0.0 state (v 1, no retry) is read as it is
  assert.deepEqual(keys(alerts.evaluate({ v: 1, at: T - MIN, sent: { 'w:1:2026-10-13:e': exp } }, down, CFG, T + H)), ['w:1:2026-10-14:e', 'w:1:2026-10-13:m']);
});

// ─── the whole path ─────────────────────────────

async function plan(host, rules, reminder) {
  const body = { name: 'Zuhause', source: 'rules', rules };
  if (reminder !== undefined) body.reminder = reminder;
  const r = await asAdmin(host, 'POST', '/plans', body);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.plan.id;
}

test('waste: the title fits the lead — Heute / Morgen / Übermorgen / Am <day>; English', () => withHost({}, async (host) => {
  const d3 = day(3);
  const id = await plan(host, [{ name: 'Papier', start: d3, weeks: 4 }], { lead: 3, time: '19:00', extra: true, extra_time: '06:15' });
  await alerts.check(host.gc, { now: at(day(0), 12) }); // first run
  await alerts.check(host.gc, { now: at(day(0), 18, 59) });
  assert.equal(host.notifications.length, 0);
  await alerts.check(host.gc, { now: at(day(0), 19) });
  assert.deepEqual(host.notifications.map((n) => n.title), [`Am ${format.dayShort(d3, 'de')}: Papier`]);
  assert.match(host.notifications[0].title, /^Am (Mo|Di|Mi|Do|Fr|Sa|So), \d\d\.\d\d\.: Papier$/);
  assert.equal(host.notifications[0].collapseKey, `waste:${id}:${d3}`);
  // 2 days before: another plan setting, the 3-day one is not repeated
  await asAdmin(host, 'PUT', `/plans/${id}`, { reminder: { lead: 2, time: '19:00' } });
  await alerts.check(host.gc, { now: at(day(1), 19, 0) + 20000 });
  assert.equal(host.notifications.length, 1, 'same day and kind: not again');
  // pickup day
  await alerts.check(host.gc, { now: at(d3, 6, 16) });
  assert.equal(host.notifications[1].title, 'Heute: Papier');
  // English, 2 and 1 day before, on the day
  host.settings.notify_lang = 'en';
  const d31 = tz.addDays(d3, 28);
  await alerts.check(host.gc, { now: at(tz.addDays(d31, -2), 19, 1) });
  assert.equal(host.notifications[2].title, 'Day after tomorrow: Papier');
  await asAdmin(host, 'PUT', `/plans/${id}`, { reminder: { lead: 1, extra: false } });
  const d59 = tz.addDays(d31, 28);
  await alerts.check(host.gc, { now: at(tz.addDays(d59, -1), 19, 1) });
  assert.equal(host.notifications[3].title, 'Tomorrow: Papier');
  await asAdmin(host, 'PUT', `/plans/${id}`, { reminder: { lead: 0, time: '07:00' } });
  const d87 = tz.addDays(d59, 28);
  await alerts.check(host.gc, { now: at(d87, 7, 0) });
  assert.equal(host.notifications[4].title, 'Today: Papier');
  await asAdmin(host, 'PUT', `/plans/${id}`, { reminder: { lead: 3 } });
  const d115 = tz.addDays(d87, 28);
  await alerts.check(host.gc, { now: at(tz.addDays(d115, -3), 7, 0) });
  assert.equal(host.notifications[5].title, `On ${format.dayShort(d115, 'en')}: Papier`);
  // "none": quiet
  await asAdmin(host, 'PUT', `/plans/${id}`, { reminder: { lead: 'off' } });
  const d143 = tz.addDays(d115, 28);
  for (const n of [3, 2, 1, 0]) await alerts.check(host.gc, { now: at(tz.addDays(d143, -n), 7, 0) });
  assert.equal(host.notifications.length, 6);
}));

test('waste: changing a plan right after its reminder neither repeats it nor floods; a restart repeats nothing', () => withHost({}, async (host) => {
  const id = await plan(host, [{ name: 'Restmüll', start: day(1), weeks: 1 }, { name: 'Papier', start: day(2), weeks: 1 }, { name: 'Bio', start: day(3), weeks: 1 }],
    { lead: 1, time: '18:00', extra: false, extra_time: '06:30' });
  await alerts.check(host.gc, { now: at(day(0), 12) });
  await alerts.check(host.gc, { now: at(day(0), 18) + 30000 });
  assert.deepEqual(host.notifications.map((n) => n.title), ['Morgen: Restmüll']);
  // 20:00: 3 days before — Papier (day 2) is late and goes out, Bio (day 3) only recorded, Restmüll not again
  await alerts.check(host.gc, { now: at(day(0), 19, 59) });
  await asAdmin(host, 'PUT', `/plans/${id}`, { reminder: { lead: 3 } });
  await alerts.check(host.gc, { now: at(day(0), 20, 1) });
  assert.deepEqual(host.notifications.map((n) => n.title), ['Morgen: Restmüll', 'Übermorgen: Papier']);
  alerts.reset(); // restart
  await alerts.check(host.gc, { now: at(day(0), 20, 2) });
  await asAdmin(host, 'PUT', `/plans/${id}`, { reminder: { time: '21:00' } });
  await alerts.check(host.gc, { now: at(day(0), 21, 1) });
  assert.equal(host.notifications.length, 2, 'a later time on the same day: nothing again');
  // on the day: the main reminder of Restmüll was sent; the pickup-day one is a reminder of its own
  await asAdmin(host, 'PUT', `/plans/${id}`, { reminder: { lead: 0, time: '06:30', extra: true, extra_time: '06:45' } });
  await alerts.check(host.gc, { now: at(day(1), 6, 31) });
  assert.equal(host.notifications.length, 2);
  await alerts.check(host.gc, { now: at(day(1), 6, 46) });
  assert.deepEqual(host.notifications.map((n) => n.title).slice(2), ['Heute: Restmüll']);
}));

test('waste: a plan without its own reminder follows the plugin settings (1.0.0 behaviour)', () => withHost({ settings: { waste_evening_time: '19:30', waste_morning: true, waste_morning_time: '06:00' } }, async (host) => {
  await plan(host, [{ name: 'Restmüll', start: day(1), weeks: 2 }]);
  const st = await asAdmin(host, 'GET', '/status');
  assert.deepEqual(st.json.plans[0].reminder, { lead: 1, time: '19:30', extra: true, extra_time: '06:00', custom: false });
  await alerts.check(host.gc, { now: at(day(0), 12) });
  await alerts.check(host.gc, { now: at(day(0), 19, 30) });
  await alerts.check(host.gc, { now: at(day(1), 6) });
  assert.deepEqual(host.notifications.map((n) => n.title), ['Morgen: Restmüll', 'Heute: Restmüll']);
  host.settings.waste_morning = false; // defaults change → the plan follows
  assert.deepEqual((await asAdmin(host, 'GET', '/status')).json.plans[0].reminder.extra, false);
}));

// ─── API ────────────────────────────────────────

test('API: the reminder of a plan is validated, stored, partly updated and reset', () => withHost({}, async (host) => {
  const rules = [{ name: 'Restmüll', start: day(1), weeks: 2 }];
  const bad = [{ lead: 4 }, { lead: -1 }, { lead: '1' }, { lead: 1.5 }, { lead: true }, { time: '24:00' }, { time: '18' }, { time: 1800 }, { time: '' }, { extra: 'yes' }, { extra: 1 }, { extra_time: '6:3' }, 'x', [1], 3];
  for (const reminder of bad) {
    const r = await asAdmin(host, 'POST', '/plans', { name: 'X', source: 'rules', rules, reminder });
    assert.equal(r.status, 400, JSON.stringify(reminder));
    assert.equal(r.json.code, 'REMINDER_INVALID');
    assert.match(r.json.error, /HH:MM/);
  }
  assert.equal((await asAdmin(host, 'GET', '/status')).json.plans.length, 0, 'nothing stored');
  const id = await plan(host, rules, { lead: 2, time: '7:05', extra: true, extra_time: '05:45' });
  const view = async () => (await asAdmin(host, 'GET', '/status')).json.plans.find((p) => p.id === id).reminder;
  assert.deepEqual(await view(), { lead: 2, time: '07:05', extra: true, extra_time: '05:45', custom: true });
  await asAdmin(host, 'PUT', `/plans/${id}`, { reminder: { lead: 'off' } });
  assert.deepEqual(await view(), { lead: 'off', time: '07:05', extra: true, extra_time: '05:45', custom: true }, 'fields left out keep their value');
  await asAdmin(host, 'PUT', `/plans/${id}`, { name: 'Anders' });
  assert.equal((await view()).lead, 'off', 'an update without reminder leaves it');
  await asAdmin(host, 'PUT', `/plans/${id}`, { reminder: { lead: 0, time: null } });
  assert.deepEqual(await view(), { lead: 0, time: '18:00', extra: true, extra_time: '05:45', custom: true }, 'null = the setting');
  const bad2 = await asAdmin(host, 'PUT', `/plans/${id}`, { reminder: { lead: 5 } });
  assert.equal(bad2.json.code, 'REMINDER_INVALID');
  await asAdmin(host, 'PUT', `/plans/${id}`, { reminder: null });
  assert.deepEqual(await view(), { lead: 1, time: '18:00', extra: false, extra_time: '06:30', custom: false });
  // the stored row
  const row = (await host.gc.db.get('SELECT remind_lead, remind_time, remind_extra, remind_extra_time FROM plans WHERE id = ?', [id])).row;
  assert.deepEqual({ ...row }, { remind_lead: null, remind_time: null, remind_extra: null, remind_extra_time: null });
  // "Test-Erinnerung senden" still works
  const t = await asAdmin(host, 'POST', '/test/waste');
  assert.equal(t.json.ok, true);
  assert.match(host.notifications.at(-1).title, /^Test – Morgen: Restmüll$/);
}));

test('texts: lead labels and reminder texts in de and en', () => {
  for (const l of ['de', 'en']) {
    for (const k of ['remind.off', 'remind.0', 'remind.1', 'remind.2', 'remind.3', 'plan.remind', 'plan.remind_line', 'plan.remind_at', 'plan.remind_extra', 'plan.remind_extra_short', 'error.reminder_invalid']) assert.ok(texts[l][k], `${l}: ${k}`);
    for (const k of ['waste.today', 'waste.tomorrow', 'waste.in2', 'waste.on']) assert.match(alerts.TEXTS[l][k], /\{\{list\}\}/);
  }
  assert.equal(texts.de['remind.1'], '1 Tag vorher');
  assert.equal(alerts.TEXTS.de['waste.in2'], 'Übermorgen: {{list}}');
  assert.equal(alerts.TEXTS.de['waste.on'], 'Am {{date}}: {{list}}');
  for (const k of ['title', 'eyebrow', 'subtitle']) assert.equal(texts.de[k], undefined, 'no own page header');
});
