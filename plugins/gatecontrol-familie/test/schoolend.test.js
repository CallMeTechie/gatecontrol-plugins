'use strict';

// 1.13.0 — an early end of school (service school_day_end of the Schule plugin, server/schoolend.js): only the
// Schule plugin may call it, strict payload, the module rides must be on (the holiday mode does not hold it),
// the pickup within ± 60 minutes of the planned end (the closest, the child's, not cancelled), pushes to the
// driver and the parents (else the parents only, setting school_early_end_notify), once per child, date and
// new end; the buttons (GateControl 1.181.0, test/gc181.js): „Auf … verschieben“ moves the ride (parents or the
// driver, logged), „Wer kann?“ asks like the rides module.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, MIN, pushes } = require('./helpers');
const { gc181 } = require('./gc181');

const SCHULE = 'gatecontrol-schule';
const TODAY = '2026-10-14';
const ev = (extra = {}) => ({ userId: LENA.id, date: TODAY, plannedEnd: '13:05', newEnd: '11:30', text: 'Lena hat am Mi 14.10. schon um 11:30 Schluss (statt 13:05)', ...extra });
const send = (host, events, caller = SCHULE) => host.callService('school_day_end', { caller, payload: { events } });
const endPushes = (host, from = 0) => pushes(host, 'school_end', from);
const ride = async (as, body) => (await as(ANNA)('POST', '/rides', { date: TODAY, title: 'Lena von der Schule', place: 'Gymnasium', childIds: [LENA.id], ...body })).json.ride;

test('school_day_end: only the Schule plugin; the payload is checked strictly; module rides', () => withFamily({}, async (host, { admin }) => {
  assert.deepEqual(await send(host, [ev()], 'gatecontrol-messenger'), { ok: false, code: 'forbidden' });
  assert.deepEqual(await send(host, [ev()], 'gatecontrol-other'), { ok: false, code: 'forbidden' });
  const invalid = { ok: false, code: 'invalid' };
  for (const bad of [
    { userId: String(LENA.id) }, { userId: 0 }, { date: '2026-02-30' }, { date: '14.10.2026' }, { plannedEnd: '13:5' }, { newEnd: '25:00' },
    { newEnd: '13:05' }, { newEnd: '13:30' }, { text: '' }, { text: 'x'.repeat(201) }, { text: 5 },
  ]) assert.deepEqual(await send(host, [ev(bad)]), invalid, JSON.stringify(bad));
  assert.deepEqual(await host.callService('school_day_end', { caller: SCHULE, payload: { events: 'x' } }), invalid);
  assert.deepEqual(await send(host, new Array(21).fill(ev())), invalid, 'at most 20');
  assert.deepEqual(await send(host, []), { ok: true, notified: 0, matched: 0 });
  // module rides off: nothing
  await admin('PUT', 'modules', { rides: false });
  assert.deepEqual(await send(host, [ev()]), { ok: true, notified: 0, matched: 0 });
  assert.equal(endPushes(host).length, 0);
}));

test('a pickup around the planned end: the driver and the parents; once per child, date and new end; tomorrow says so', () => withFamily({}, async (host, { as }) => {
  const r = await ride(as, { time: '13:05', driver: { userId: MARC.id } });
  const from = host.notifications.length;
  assert.deepEqual(await send(host, [ev()]), { ok: true, notified: 2, matched: 1 });
  const list = endPushes(host, from);
  assert.deepEqual(list.map((n) => [n.users, n.topic, n.priority, n.title, n.body]), [
    [[MARC.id], 'rides', 'high', 'Früher Schluss: Lena', 'Schule endet um 11:30 statt 13:05 – Abholung ist für 13:05 eingetragen.'],
    [[ANNA.id], 'rides', 'high', 'Früher Schluss: Lena', 'Schule endet um 11:30 statt 13:05 – Abholung ist für 13:05 eingetragen.'],
  ]);
  assert.deepEqual(list[0].data.familie, { type: 'school_end', childId: LENA.id, date: TODAY, plannedEnd: '13:05', newEnd: '11:30', rideId: r.id, rideTime: '13:05' });
  assert.equal(list[0].data.actions, undefined, 'no buttons on a GateControl without callbacks');
  assert.deepEqual(await send(host, [ev()]), { ok: true, notified: 0, matched: 0 }, 'once');
  assert.equal((await send(host, [ev({ newEnd: '10:35' })])).notified, 2, 'earlier still: again');
  // tomorrow, an occurrence of a series without a driver: the parents
  const s = (await as(ANNA)('POST', '/rides', { date: '2026-10-15', time: '12:30', title: 'Abholen', childIds: [LENA.id], repeat: { weekdays: [4] } })).json.ride;
  const f2 = host.notifications.length;
  assert.deepEqual(await send(host, [ev({ date: '2026-10-15', plannedEnd: '13:05', newEnd: '11:30' })]), { ok: true, notified: 2, matched: 1 });
  const t = endPushes(host, f2);
  assert.deepEqual(t.map((n) => [n.users, n.body]), [[[ANNA.id, MARC.id], 'Morgen: Schule endet um 11:30 statt 13:05 – Abholung ist für 12:30 eingetragen.']]);
  assert.equal(t[0].data.familie.rideId, s.id);
  // the log
  const rows = (await host.gc.db.query('SELECT child_id, date, new_end, ride_key, action FROM school_end_log ORDER BY id')).rows;
  assert.deepEqual(rows.map((x) => [x.child_id, x.date, x.new_end, x.ride_key, x.action]), [
    [LENA.id, TODAY, '11:30', r.id, 'notified'], [LENA.id, TODAY, '10:35', r.id, 'notified'], [LENA.id, '2026-10-15', '11:30', s.id, 'notified'],
  ]);
}));

test('matching: ± 60 minutes, the closest, the child\'s, not cancelled; none → the parents with the text (switchable)', () => withFamily({}, async (host, { as }) => {
  await ride(as, { time: '14:10' });                              // 65 minutes after
  await ride(as, { time: '13:00', childIds: [TIM.id] });          // Tim's
  const gone = await ride(as, { time: '13:05' });
  await as(ANNA)('DELETE', `/rides/${gone.id}`);                  // cancelled
  let from = host.notifications.length;
  assert.deepEqual(await send(host, [ev()]), { ok: true, notified: 2, matched: 0 });
  assert.deepEqual(endPushes(host, from).map((n) => [n.users, n.priority, n.title, n.body]), [
    [[ANNA.id, MARC.id], 'normal', 'Früher Schluss: Lena', 'Lena hat am Mi 14.10. schon um 11:30 Schluss (statt 13:05)'],
  ]);
  assert.equal(endPushes(host, from)[0].data.familie.rideId, undefined);
  const near = await ride(as, { time: '12:10' });                 // 55 minutes before
  await ride(as, { time: '13:50' });                              // 45 minutes after: closer
  from = host.notifications.length;
  assert.equal((await send(host, [ev({ newEnd: '10:35' })])).matched, 1);
  assert.equal(endPushes(host, from)[0].data.familie.rideTime, '13:50');
  assert.ok(near.id);
  // switched off: nothing without a pickup; a parent or an unknown user, a past date: ignored
  host.settings.school_early_end_notify = false;
  from = host.notifications.length;
  assert.deepEqual(await send(host, [ev({ userId: TIM.id, date: '2026-10-15' }), ev({ userId: ANNA.id, newEnd: '09:00' }), ev({ userId: 999 }), ev({ date: '2026-10-13', newEnd: '08:00' })]), { ok: true, notified: 0, matched: 0 });
  assert.equal(endPushes(host, from).length, 0);
}));

test('the holiday mode does not hold it', () => withFamily({}, async (host, { as }) => {
  assert.equal((await as(ANNA)('PUT', '/rules/vacation', { on: true })).status, 200);
  await ride(as, { time: '13:05' });
  assert.equal((await send(host, [ev()])).matched, 1);
  assert.equal(endPushes(host).length, 1);
}));

/** The service and the buttons with GateControl 1.181.0 (callbacks). */
async function withButtons(fn) {
  return withFamily({}, async (host, ctx) => {
    const g = gc181(host);
    const call = (events) => host.plugin.service({ name: 'school_day_end', caller: SCHULE, user: null, payload: { events } }, g.gc);
    return fn(host, ctx, g, call);
  });
}

const sentEnd = (g) => g.sent.filter((n) => n.data && n.data.familie && n.data.familie.type === 'school_end');
const ids = (n) => (n.data.actions || []).map((a) => [a.id, a.label]);

test('buttons: the driver gets „Auf 11:30 verschieben“ and „Wer kann?“, the parents „Wer kann?“ only while nobody drives', () => withButtons(async (host, { as }, g, call) => {
  await ride(as, { time: '13:05', driver: { userId: MARC.id } });
  assert.equal((await call([ev()])).notified, 2);
  let s = sentEnd(g);
  assert.deepEqual(s.map((n) => [n.users, ids(n)]), [
    [[MARC.id], [['move', 'Auf 11:30 verschieben'], ['ask', 'Wer kann?']]],
    [[ANNA.id], [['move', 'Auf 11:30 verschieben']]],
  ]);
  // nobody drives: one push to the parents with both
  await ride(as, { date: '2026-10-15', time: '13:05' });
  await call([ev({ date: '2026-10-15' })]);
  s = sentEnd(g).slice(2);
  assert.deepEqual(s.map((n) => [n.users, ids(n)]), [[[ANNA.id, MARC.id], [['move', 'Auf 11:30 verschieben'], ['ask', 'Wer kann?']]]]);
  // the pickup is already at the new end (or earlier): no move button
  await ride(as, { date: '2026-10-16', time: '12:10' });
  await call([ev({ date: '2026-10-16', plannedEnd: '12:25', newEnd: '12:10' })]);
  assert.deepEqual(ids(sentEnd(g)[3]), [['ask', 'Wer kann?']]);
}));

test('„Auf … verschieben“: parents or the driver; the time moves, the others hear it, it is logged; a changed ride is not moved', () => withButtons(async (host, { as }, g, call) => {
  const r = await ride(as, { time: '13:05', driver: { userId: MARC.id } });
  await call([ev()]);
  const n = sentEnd(g)[1];
  const press = (userId, action, data = n.data) => g.notifyAction({ userId, notificationId: 'n1', action, data });
  assert.deepEqual(await press(TIM.id, 'move'), { ok: false, error: 'forbidden' });
  assert.deepEqual(await press(LENA.id, 'move'), { ok: false, error: 'forbidden' });
  assert.deepEqual(await press(ANNA.id, 'nope'), { ok: false, error: 'unknown' });
  const before = host.notifications.length;
  assert.deepEqual(await press(ANNA.id, 'move'), { ok: true, state: 'moved' });
  assert.equal((await as(ANNA)('GET', `/rides/${r.id}`)).json.ride.time, '11:30');
  const moved = pushes(host, 'ride_moved', before);
  assert.deepEqual(moved.map((x) => [x.users, x.title, x.body]), [[[MARC.id], 'Anna hat die Abholung auf 11:30 verschoben', 'Lena von der Schule · Gymnasium']]);
  const log = (await host.gc.db.query("SELECT action, by_user, detail_json FROM school_end_log WHERE action = 'moved'")).rows;
  assert.deepEqual(log.map((x) => [x.action, x.by_user, JSON.parse(x.detail_json)]), [['moved', ANNA.id, { from: '13:05', to: '11:30' }]]);
  assert.deepEqual(await press(MARC.id, 'move'), { ok: true, state: 'moved', already: true }, 'already there');
  // someone changed the time meanwhile: not moved
  await as(ANNA)('PATCH', `/rides/${r.id}`, { time: '12:00' });
  assert.deepEqual(await press(MARC.id, 'move'), { ok: false, error: 'changed' });
  // the driver may; a series moves only that occurrence
  const s = (await as(ANNA)('POST', '/rides', { date: '2026-10-15', time: '13:05', title: 'Abholen', childIds: [LENA.id], driver: { userId: MARC.id }, repeat: { weekdays: [4] } })).json.ride;
  await call([ev({ date: '2026-10-15' })]);
  const d = sentEnd(g).find((x) => x.users.includes(MARC.id) && x.data.familie.date === '2026-10-15');
  assert.deepEqual(await g.notifyAction({ userId: MARC.id, notificationId: 'n2', action: 'move', data: d.data }), { ok: true, state: 'moved' });
  const occ = (await as(ANNA)('GET', '/rides', null, { from: '2026-10-15', to: '2026-10-22' })).json.rides.filter((x) => x.seriesId === s.seriesId);
  assert.deepEqual(occ.map((x) => [x.date, x.time]), [['2026-10-15', '11:30'], ['2026-10-22', '13:05']]);
  // a deleted ride, the module off
  await as(ANNA)('DELETE', `/rides/${r.id}`);
  assert.deepEqual(await press(ANNA.id, 'move'), { ok: false, error: 'cancelled' });
  host.settings.mod_rides = false;
  assert.deepEqual(await press(ANNA.id, 'move'), { ok: false, error: 'module_off' });
}));

test('„Wer kann?“: the rides module\'s request; pressed by the driver the driver is released first; a parent cannot while someone drives', () => withButtons(async (host, { as, clock }, g, call) => {
  const r = await ride(as, { time: '13:05', driver: { userId: MARC.id } });
  await call([ev()]);
  const [toDriver, toParents] = sentEnd(g);
  const press = (userId, n) => g.notifyAction({ userId, notificationId: 'n1', action: 'ask', data: n.data });
  assert.deepEqual(await press(ANNA.id, toParents), { ok: false, error: 'already_taken' });
  const before = host.notifications.length;
  assert.deepEqual(await press(MARC.id, toDriver), { ok: true, state: 'asked', notified: 1 });
  const view = (await as(ANNA)('GET', `/rides/${r.id}`)).json.ride;
  assert.deepEqual([view.status, view.driver], ['open', null]);
  assert.deepEqual(pushes(host, 'ride_released', before).map((x) => x.users), [[ANNA.id]]);
  assert.deepEqual(pushes(host, 'ride_ask', before).map((x) => [x.users, x.title]), [[[ANNA.id], 'Wer kann Lena um 13:05 abholen?']]);
  // again within 5 minutes: too soon (nothing happens)
  assert.deepEqual(await press(ANNA.id, toParents), { ok: false, error: 'too_soon' });
  clock.add(6 * MIN);
  assert.equal((await press(ANNA.id, toParents)).state, 'asked');
  const log = (await host.gc.db.query("SELECT by_user FROM school_end_log WHERE action = 'asked' ORDER BY id")).rows;
  assert.deepEqual(log.map((x) => x.by_user), [MARC.id, ANNA.id]);
  assert.deepEqual(await g.notifyAction({ userId: 999, notificationId: 'n1', action: 'ask', data: toParents.data }), { ok: false, error: 'not_member' });
}));
