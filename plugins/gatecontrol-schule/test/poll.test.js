'use strict';

// Polling (server/poll.js): the window (Mon–Sat 05:30–20:00 every poll_minutes, otherwise
// hourly), one login per account and cycle with logout also after errors, error codes on the
// account with back-off, settings, diagnostics and the settings' fallbacks.

const test = require('node:test');
const assert = require('node:assert/strict');
const poll = require('../server/poll');
const config = require('../server/config');
const { withHost, asAdmin, setupParent, tickAt, at, T0 } = require('./helpers');

const MIN = 60000;
const HOUR = 60 * MIN;
const cfg = config.fromSettings({});
const account = async (host) => (await asAdmin(host, 'GET', '/status')).json.accounts[0];

test('window: Mon–Sat 05:30–20:00 in the plugin zone', () => {
  assert.equal(poll.inWindow(at('2026-10-20T06:00:00Z'), cfg), true, 'Tue 08:00');
  assert.equal(poll.inWindow(at('2026-10-20T03:29:00Z'), cfg), false, 'Tue 05:29');
  assert.equal(poll.inWindow(at('2026-10-20T03:30:00Z'), cfg), true, 'Tue 05:30');
  assert.equal(poll.inWindow(at('2026-10-20T18:00:00Z'), cfg), false, 'Tue 20:00');
  assert.equal(poll.inWindow(at('2026-10-24T08:00:00Z'), cfg), true, 'Sat 10:00');
  assert.equal(poll.inWindow(at('2026-10-25T09:00:00Z'), cfg), false, 'Sun 10:00 (CET)');
});

test('next fetch: poll_minutes in the window, hourly outside, at the latest when it opens', () => {
  assert.equal(poll.nextFetch(T0, cfg), T0 + 15 * MIN);
  assert.equal(poll.nextFetch(T0, config.fromSettings({ poll_minutes: 30 })), T0 + 30 * MIN);
  const evening = at('2026-10-20T19:00:00Z'); // 21:00
  assert.equal(poll.nextFetch(evening, cfg), evening + HOUR);
  const early = at('2026-10-21T03:00:00Z'); // Wed 05:00 → 05:30
  assert.equal(poll.nextFetch(early, cfg), at('2026-10-21T03:30:00Z'));
  const sat = at('2026-10-24T18:30:00Z'); // Sat 20:30: hourly over Sunday
  assert.equal(poll.nextFetch(sat, cfg), sat + HOUR);
  // Sunday night 05:00 → hourly, Monday 05:30 at the latest
  assert.equal(poll.nextFetch(at('2026-10-26T04:00:00Z'), cfg), at('2026-10-26T04:30:00Z'));
});

test('back-off: network / failed 5 … 120 min, auth / no_right 1 … 24 h', () => {
  assert.deepEqual([1, 2, 3, 6, 9].map((n) => poll.backoff('network', n, cfg) / MIN), [5, 10, 20, 120, 120]);
  assert.deepEqual([1, 2, 3, 6].map((n) => poll.backoff('failed', n, cfg) / MIN), [5, 10, 20, 120]);
  assert.deepEqual([1, 2, 3, 5, 6, 12].map((n) => poll.backoff('auth', n, cfg) / HOUR), [1, 2, 4, 16, 24, 24]);
  assert.equal(poll.backoff('no_right', 1, cfg), HOUR);
});

test('range: Monday of this week … Sunday of next week', () => {
  assert.deepEqual(poll.rangeOf(T0, cfg), { from: '2026-10-19', to: '2026-11-01' });
  assert.deepEqual(poll.rangeOf(at('2026-10-25T10:00:00Z'), cfg), { from: '2026-10-19', to: '2026-11-01' }, 'Sunday: today + 7');
});

test('a cycle: one login, logout; only due accounts; timegrid and holidays once a day', () => withHost({}, async (host, untis) => {
  await setupParent(host);
  untis.state.calls.length = 0;
  await tickAt(host, T0 + 5 * MIN);
  assert.deepEqual(untis.state.calls, [], 'not due');
  await tickAt(host, T0 + 15 * MIN);
  assert.deepEqual(untis.state.calls, ['getUserData2017', 'app/config', 'getTimetable', 'getTimetable', 'homeworks', 'exams', 'exams', 'logout'], 'same day: no timegrid / holidays');
  assert.deepEqual([untis.state.logins.length, untis.state.logouts], [2, 2]);
  assert.equal(untis.state.sessions.size, 0);
  untis.state.calls.length = 0;
  await tickAt(host, at('2026-10-21T04:00:00Z')); // next day 06:00
  assert.deepEqual(untis.state.calls, ['getUserData2017', 'app/config', 'getTimegridUnits', 'getHolidays', 'getTimetable', 'getTimetable', 'homeworks', 'exams', 'exams', 'logout']);
  // every call after the login carried the session and the school
  assert.ok(untis.state.cookies.every((c) => /^JSESSIONID=S\d+x[0-9a-f]+; schoolname=_/.test(c)));
}));

test('errors: code and readable text on the account, back-off, logout after a failed cycle', () => withHost({}, async (host, untis) => {
  await setupParent(host);
  untis.state.down = true;
  await tickAt(host, T0 + 15 * MIN);
  let a = await account(host);
  assert.deepEqual([a.status, a.last_error, a.error_count], ['error', 'network', 1]);
  assert.match(a.error_text, /nicht erreichbar/);
  assert.equal(a.next_fetch_at, T0 + 20 * MIN);
  assert.equal(a.last_success_at, T0, 'the last good fetch stays');
  await tickAt(host, T0 + 20 * MIN);
  a = await account(host);
  assert.deepEqual([a.error_count, a.next_fetch_at], [2, T0 + 30 * MIN]);
  // WebUntis is back, but the key was revoked: auth, an hour of back-off
  untis.state.down = false;
  untis.state.secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  await tickAt(host, T0 + 30 * MIN);
  a = await account(host);
  assert.deepEqual([a.last_error, a.error_count, a.next_fetch_at], ['auth', 3, T0 + 30 * MIN + 4 * HOUR]);
  assert.match(a.error_text, /Anmeldung abgelehnt/);
  // a failure after the login still logs out
  untis.state.secret = 'JBSWY3DPEHPK3PXP';
  untis.state.noRight = new Set([101, 102]);
  const r = await asAdmin(host, 'POST', '/accounts/1/refresh');
  assert.deepEqual([r.json.result.ok, r.json.result.code], [false, 'no_right']);
  assert.equal(untis.state.sessions.size, 0, 'logged out');
  a = await account(host);
  assert.equal(a.last_error, 'no_right');
  // all good again: the error is gone
  untis.state.noRight = new Set();
  await asAdmin(host, 'POST', '/accounts/1/refresh');
  a = await account(host);
  assert.deepEqual([a.status, a.last_error, a.error_count], ['ok', null, 0]);
  assert.ok(!JSON.stringify(host.logs).match(/JBSWY3DPEHPK3PXP|JSESSIONID|S\dx/), 'no secret or session in the log');
  assert.ok(host.logs.some((l) => /webuntis fetch failed/.test(l.message) && /network/.test(l.message)));
}));

test('a missing credential is an auth error (never a login without one)', () => withHost({}, async (host, untis) => {
  await setupParent(host);
  await host.gc.settings.setSecret('acct.1.secret', null);
  untis.state.calls.length = 0;
  await tickAt(host, T0 + 15 * MIN);
  assert.deepEqual(untis.state.calls, []);
  assert.equal((await account(host)).last_error, 'auth');
}));

test('settings: fallbacks and problems, quiet hours, a shorter interval applies at once', () => withHost({}, async (host) => {
  const c = config.fromSettings({ timezone: 'Mars/Base', poll_minutes: 2, notify_days: 9, quiet_from: '25:00', quiet_to: '06:00', notify_lang: 'en' });
  assert.deepEqual(c.problems, ['timezone', 'poll_minutes', 'notify_days', 'quiet']);
  assert.deepEqual([c.tz, c.pollMinutes, c.notifyDays, config.hhmm(c.quiet.from), c.lang], ['Europe/Berlin', 15, 2, '21:00', 'en']);
  assert.equal(config.fromSettings({ quiet_from: '', quiet_to: '' }).quiet, null);
  // 1.2.0: the evening reminder — default 18:00, empty = none, invalid = 18:00 with a problem
  assert.equal(config.hhmm(config.fromSettings({}).reminder), '18:00');
  assert.equal(config.fromSettings({ reminder_time: '' }).reminder, null);
  const bad = config.fromSettings({ reminder_time: '18 Uhr' });
  assert.deepEqual([bad.problems, config.hhmm(bad.reminder)], [['reminder_time'], '18:00']);
  assert.equal(config.fromSettings({ poll_minutes: '30' }).pollMinutes, 30);
  const q = config.fromSettings({});
  assert.equal(config.inQuiet(q, at('2026-10-20T19:30:00Z')), true, '21:30');
  assert.equal(config.inQuiet(q, at('2026-10-21T03:59:00Z')), true, '05:59');
  assert.equal(config.inQuiet(q, at('2026-10-21T04:00:00Z')), false, '06:00');
  const day = config.fromSettings({ quiet_from: '12:00', quiet_to: '13:00' });
  assert.equal(config.inQuiet(day, at('2026-10-21T10:30:00Z')), true, '12:30');
  assert.equal(config.inQuiet(day, at('2026-10-21T11:00:00Z')), false, '13:00');
  // status shows the config; a shorter interval moves the next fetch forward
  await setupParent(host);
  const st = (await asAdmin(host, 'GET', '/status')).json.config;
  assert.deepEqual(st, { timezone: 'Europe/Berlin', notify_lang: 'de', poll_minutes: 15, notify_days: 2, quiet_from: '21:00', quiet_to: '06:00', problems: [], reminder_time: '18:00' });
  await host.saveSettings({ poll_minutes: 5 });
  assert.equal((await account(host)).next_fetch_at, T0 + 5 * MIN);
}));

test('diagnostics: lessons stored and last change per student', () => withHost({}, async (host, untis) => {
  await setupParent(host);
  untis.state.timetable[101].find((l) => l.date === 20261020 && l.startTime === 1140).code = 'cancelled';
  await tickAt(host, T0 + 15 * MIN);
  const a = await account(host);
  const lena = a.students.find((s) => s.person_id === 101);
  const max = a.students.find((s) => s.person_id === 102);
  assert.deepEqual([lena.lesson_count, lena.last_change_at, lena.last_fetch_at], [44, T0 + 15 * MIN, T0 + 15 * MIN]);
  assert.deepEqual([max.lesson_count, max.last_change_at], [44, null]);
  assert.equal(a.last_success_at, T0 + 15 * MIN);
  assert.equal(a.next_fetch_at, T0 + 30 * MIN);
}));
