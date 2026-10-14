'use strict';

// Rides (Abholen & Fahrten): weekly series expanded on read with overrides
// of single occurrences, one-off rides, children asking for themselves,
// take / release / decline / driver / ask with their rules and pushes, the
// driver's reminder and the open-ride push once per occurrence.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, MIN, DAY, pushes, birth } = require('./helpers');
const rides = require('../server/rides');

// T0 = Wednesday 2026-10-14 10:00 Berlin (08:00Z)
const TRAINING = { title: 'Tim vom Training abholen', place: 'Sporthalle Nord', childIds: [TIM.id] };
const ridePushes = (host, from = 0) => host.notifications.slice(from).filter((n) => n.topic === 'rides');

test('series dates: weekly on weekdays from the start, up to the end date', () => {
  const s = { date: '2026-10-14', endDate: '2026-10-28', weekdays: [1, 3] };
  assert.deepEqual(rides.seriesDates(s, '2026-10-01', '2026-12-31'), ['2026-10-14', '2026-10-19', '2026-10-21', '2026-10-26', '2026-10-28']);
  assert.deepEqual(rides.seriesDates({ ...s, endDate: null }, '2026-10-20', '2026-10-27'), ['2026-10-21', '2026-10-26']);
  assert.equal(rides.inSeries(s, '2026-10-19'), true);
  assert.equal(rides.inSeries(s, '2026-10-20'), false, 'a Tuesday');
  assert.equal(rides.inSeries(s, '2026-11-02'), false, 'after the end');
  assert.equal(rides.inSeries(s, '2026-10-12'), false, 'before the start');
});

test('a weekly series: expanded on read; one occurrence changed is an override, the series edit keeps it', () => withFamily({}, async (host, { as }) => {
  const r = await as(ANNA)('POST', '/rides', { date: '2026-10-14', time: '16:00', ...TRAINING, lat: 50.94, lon: 6.96, repeat: { weekdays: [1, 3], endDate: '2026-11-02' } });
  assert.equal(r.status, 200);
  const first = r.json.ride;
  const sid = first.seriesId;
  assert.ok(Number.isInteger(sid));
  assert.deepEqual(first, {
    id: `${sid}:2026-10-14`, seriesId: sid, date: '2026-10-14', time: '16:00', title: TRAINING.title, place: 'Sporthalle Nord', lat: 50.94, lon: 6.96,
    childIds: [TIM.id], status: 'open', driver: null, requestedBy: { userId: ANNA.id, name: 'Anna' }, declined: [], askedAt: null, remindMinutes: 20, note: '',
    startAt: '2026-10-14T14:00:00Z', repeat: { weekdays: [1, 3], startDate: '2026-10-14', endDate: '2026-11-02' },
  });
  assert.equal(r.json.notified, 0, 'parents do not ask by default');
  const all = (await as(TIM)('GET', '/rides', null, { from: '2026-10-01', to: '2026-11-30' })).json.rides;
  assert.deepEqual(all.map((x) => x.date), ['2026-10-14', '2026-10-19', '2026-10-21', '2026-10-26', '2026-10-28', '2026-11-02']);
  const week = await as(TIM)('GET', '/rides');
  assert.deepEqual([week.json.from, week.json.to, week.json.rides.map((x) => x.id)], ['2026-10-14', '2026-10-21', [`${sid}:2026-10-14`, `${sid}:2026-10-19`, `${sid}:2026-10-21`]]);
  assert.equal((await as(TIM)('GET', '/rides', null, { from: '2026-10-01', to: '2026-12-03' })).json.code, 'invalid', 'at most 62 days');
  assert.equal((await as(TIM)('GET', '/rides', null, { from: '2026-10-10', to: '2026-10-01' })).json.code, 'invalid');

  // one occurrence: take, time — only that date
  assert.equal((await as(MARC)('POST', `/rides/${sid}:2026-10-19/take`)).json.ride.driver.name, 'Marc');
  const moved = await as(ANNA)('PATCH', `/rides/${sid}:2026-10-21`, { time: '17:00', note: 'Halle B' });
  assert.deepEqual([moved.json.ride.time, moved.json.ride.note, moved.json.ride.startAt], ['17:00', 'Halle B', '2026-10-21T15:00:00Z']);
  assert.equal((await as(ANNA)('PATCH', `/rides/${sid}:2026-10-21`, { date: '2026-10-22' })).json.code, 'invalid', 'an occurrence keeps its date');
  let list = (await as(ANNA)('GET', '/rides', null, { from: '2026-10-14', to: '2026-10-28' })).json.rides;
  assert.deepEqual(list.map((x) => [x.date, x.time, x.status, x.driver && x.driver.name]), [
    ['2026-10-14', '16:00', 'open', null], ['2026-10-19', '16:00', 'taken', 'Marc'], ['2026-10-21', '17:00', 'open', null],
    ['2026-10-26', '16:00', 'open', null], ['2026-10-28', '16:00', 'open', null],
  ]);
  // the whole series: new title and default driver; the overrides stay
  const ser = await as(ANNA)('PATCH', `/rides/${sid}:2026-10-26`, { title: 'Tim abholen', driver: { label: 'Familie Weber' } }, { series: '1' });
  assert.deepEqual([ser.json.ride.id, ser.json.ride.title, ser.json.ride.driver], [`${sid}:2026-10-26`, 'Tim abholen', { label: 'Familie Weber' }]);
  list = (await as(ANNA)('GET', '/rides', null, { from: '2026-10-14', to: '2026-10-28' })).json.rides;
  assert.deepEqual(list.map((x) => [x.date, x.title, x.time, x.status, x.driver]), [
    ['2026-10-14', 'Tim abholen', '16:00', 'taken', { label: 'Familie Weber' }],
    ['2026-10-19', 'Tim abholen', '16:00', 'taken', { userId: MARC.id, name: 'Marc' }],
    ['2026-10-21', 'Tim abholen', '17:00', 'taken', { label: 'Familie Weber' }],
    ['2026-10-26', 'Tim abholen', '16:00', 'taken', { label: 'Familie Weber' }],
    ['2026-10-28', 'Tim abholen', '16:00', 'taken', { label: 'Familie Weber' }],
  ]);
  // the plain series id is the series as well
  assert.equal((await as(ANNA)('PATCH', `/rides/${sid}`, { driver: null })).json.ride.status, 'open');
  assert.equal((await as(ANNA)('PATCH', `/rides/${sid}`, { repeat: { weekdays: [] } })).json.code, 'invalid');
  // delete one occurrence = cancelled; it can be restored
  const del = await as(ANNA)('DELETE', `/rides/${sid}:2026-10-26`);
  assert.equal(del.json.ride.status, 'cancelled');
  assert.equal((await as(ANNA)('GET', `/rides/${sid}:2026-10-26`)).json.ride.status, 'cancelled');
  assert.equal((await as(ANNA)('PATCH', `/rides/${sid}:2026-10-26`, { status: 'open' })).json.ride.status, 'open');
  assert.equal((await as(ANNA)('PATCH', `/rides/${sid}:2026-10-26`, { status: 'taken' })).json.code, 'invalid');
  // not an occurrence
  for (const bad of [`${sid}:2026-10-20`, `${sid}:2026-11-09`, `${sid}:2026-10-12`, '999', 'x']) assert.equal((await as(ANNA)('GET', `/rides/${bad}`)).status, 404, bad);
  assert.equal((await as(ANNA)('GET', `/rides/${sid}`)).status, 404, 'a series id alone is no occurrence');
  // children change nothing of a series
  assert.equal((await as(TIM)('PATCH', `/rides/${sid}:2026-10-26`, { time: '18:00' })).json.code, 'parents_only');
  assert.equal((await as(TIM)('DELETE', `/rides/${sid}:2026-10-26`)).json.code, 'parents_only');
  // the whole series goes
  assert.deepEqual((await as(ANNA)('DELETE', `/rides/${sid}:2026-10-19`, null, { series: '1' })).json.removed, 'series');
  assert.equal((await as(ANNA)('GET', '/rides')).json.rides.length, 0);
}));

test('validation and children: "Bitte abholen" only for themselves, without a driver or a series, asking right away', () => withFamily({}, async (host, { as }) => {
  const base = { date: '2026-10-14', time: '16:00', title: 'x' };
  for (const bad of [
    { ...base, time: '25:00' }, { ...base, time: null }, { ...base, date: '2026-10-13' }, { ...base, date: '2026-02-30' }, { ...base, title: '' }, { ...base, title: 'x'.repeat(81) },
    { ...base, place: 'x'.repeat(81) }, { ...base, note: 'x'.repeat(201) }, { ...base, remindMinutes: 121 }, { ...base, remindMinutes: -1 },
    { ...base, childIds: [99] }, { ...base, childIds: 'Tim' }, { ...base, driver: { userId: TIM.id } }, { ...base, driver: { label: '' } }, { ...base, driver: { label: 'x'.repeat(61) } },
    { ...base, driver: {} }, { ...base, lat: 50 }, { ...base, lat: 91, lon: 6 }, { ...base, repeat: { weekdays: [8] } }, { ...base, repeat: { weekdays: [1], endDate: '2026-10-01' } },
    { ...base, ask: 'yes' },
  ]) {
    assert.equal((await as(ANNA)('POST', '/rides', bad)).json.code, 'invalid', JSON.stringify(bad));
  }
  const ok = await as(ANNA)('POST', '/rides', { ...base, place: '', childIds: [], driver: { userId: MARC.id }, remindMinutes: 0 });
  assert.deepEqual([ok.json.ride.status, ok.json.ride.place, ok.json.ride.childIds, ok.json.ride.remindMinutes, ok.json.ride.seriesId, ok.json.ride.repeat], ['taken', '', [], 0, null, null]);
  assert.equal(typeof ok.json.ride.id, 'string');

  // a child: only for itself
  for (const [body, what] of [[{ driver: { userId: ANNA.id } }, 'driver'], [{ childIds: [LENA.id] }, 'someone else'], [{ childIds: [TIM.id, LENA.id] }, 'two'], [{ repeat: { weekdays: [1] } }, 'series']]) {
    assert.equal((await as(TIM)('POST', '/rides', { ...base, ...body })).json.code, 'parents_only', what);
  }
  const from = host.notifications.length;
  const kid = await as(TIM)('POST', '/rides', { date: '2026-10-14', time: '16:00', title: 'Bitte abholen', place: 'Schule' });
  assert.equal(kid.status, 200);
  const k = kid.json.ride;
  assert.deepEqual([k.childIds, k.requestedBy, k.status, k.askedAt, kid.json.notified], [[TIM.id], { userId: TIM.id, name: 'Tim' }, 'open', '2026-10-14T08:00:00Z', 2]);
  const p = ridePushes(host, from);
  assert.deepEqual(p.map((x) => [x.users.sort(), x.title, x.body, x.priority, x.collapseKey, x.data.familie]), [
    [[ANNA.id, MARC.id], 'Wer kann Tim um 16:00 abholen?', 'Schule', 'high', `ride:${k.id}`, { type: 'ride_ask', rideId: k.id, date: '2026-10-14' }],
  ]);
  const quiet = await as(TIM)('POST', '/rides', { ...base, title: 'Kino', ask: false });
  assert.deepEqual([quiet.json.notified, quiet.json.ride.askedAt], [0, null]);
  // the one who asked may cancel its own ride; another child may not
  assert.equal((await as(LENA)('DELETE', `/rides/${k.id}`)).json.code, 'parents_only');
  assert.equal((await as(TIM)('DELETE', `/rides/${k.id}`)).json.ride.status, 'cancelled');
  assert.equal((await as(TIM)('GET', `/rides/${k.id}`)).json.ride.status, 'cancelled', 'kept (cancelled) until the retention');
  assert.equal((await as(ANNA)('PATCH', `/rides/${k.id}`, { status: 'open', date: '2026-10-15' })).json.ride.date, '2026-10-15', 'a one-off ride may move');
  // children neither take nor decline nor set drivers
  assert.equal((await as(LENA)('POST', `/rides/${quiet.json.ride.id}/take`)).json.code, 'parents_only');
  assert.equal((await as(LENA)('POST', `/rides/${quiet.json.ride.id}/decline`)).json.code, 'parents_only');
  assert.equal((await as(LENA)('POST', `/rides/${quiet.json.ride.id}/driver`, { label: 'Bus' })).json.code, 'parents_only');
}));

test('take / release / decline / driver / ask: rules and pushes', () => withFamily({}, async (host, { as, admin, clock }) => {
  const id = (await as(ANNA)('POST', '/rides', { date: '2026-10-14', time: '16:00', ...TRAINING })).json.ride.id;
  let from = host.notifications.length;
  // take → Anna (who asked) and Tim hear it
  const t = await as(MARC)('POST', `/rides/${id}/take`);
  assert.deepEqual([t.json.ride.status, t.json.ride.driver, t.json.already], ['taken', { userId: MARC.id, name: 'Marc' }, false]);
  assert.deepEqual(ridePushes(host, from).map((x) => [x.users.sort(), x.title, x.body, x.data.familie.type]), [
    [[ANNA.id, TIM.id], 'Marc holt Tim ab', 'heute 16:00 · Sporthalle Nord', 'ride_taken'],
  ]);
  assert.equal((await as(MARC)('POST', `/rides/${id}/take`)).json.already, true, 'idempotent');
  const other = await as(ANNA)('POST', `/rides/${id}/take`);
  assert.deepEqual([other.status, other.json.code, other.json.driver], [409, 'already_taken', { userId: MARC.id, name: 'Marc' }]);
  assert.equal((await as(TIM)('POST', `/rides/${id}/ask`)).json.code, 'already_taken', 'no asking for a taken ride');
  // release: only the driver; the parents (and who asked) hear it
  assert.equal((await as(ANNA)('POST', `/rides/${id}/release`)).json.code, 'forbidden');
  from = host.notifications.length;
  assert.equal((await as(MARC)('POST', `/rides/${id}/release`)).json.ride.status, 'open');
  assert.deepEqual(ridePushes(host, from).map((x) => [x.users, x.title, x.data.familie.type]), [[[ANNA.id], 'Marc kann Tim doch nicht abholen', 'ride_released']]);

  // ask: every member, the parents who have not declined, not the caller; 5 minutes apart
  from = host.notifications.length;
  const a = await as(TIM)('POST', `/rides/${id}/ask`);
  assert.equal(a.json.notified, 2);
  assert.deepEqual(ridePushes(host, from).map((x) => [x.users.sort(), x.title, x.body, x.collapseKey, x.data.familie]), [
    [[ANNA.id, MARC.id], 'Wer kann Tim um 16:00 abholen?', 'Sporthalle Nord', `ride:${id}`, { type: 'ride_ask', rideId: id, date: '2026-10-14' }],
  ]);
  const soon = await as(LENA)('POST', `/rides/${id}/ask`);
  assert.deepEqual([soon.status, soon.json.code, soon.json.retryAfter], [429, 'too_soon', 300]);
  clock.add(5 * MIN);
  // decline: Marc can't; Anna asked, so Marc was the only one who could → "Niemand kann Tim abholen" to Anna
  from = host.notifications.length;
  const d = await as(MARC)('POST', `/rides/${id}/decline`);
  assert.deepEqual([d.json.ride.declined, d.json.unassigned], [[{ userId: MARC.id, name: 'Marc' }], true]);
  assert.deepEqual(ridePushes(host, from).map((x) => [x.users, x.title, x.data.familie.type]), [[[ANNA.id], 'Niemand kann Tim abholen', 'ride_unassigned']]);
  assert.equal((await as(MARC)('POST', `/rides/${id}/decline`)).json.unassigned, false, 'once');
  from = host.notifications.length;
  assert.equal((await as(TIM)('POST', `/rides/${id}/ask`)).json.notified, 1, 'Marc declined: only Anna is asked');
  assert.deepEqual(ridePushes(host, from)[0].users, [ANNA.id]);
  // taking clears the own "kann nicht"
  assert.deepEqual((await as(MARC)('POST', `/rides/${id}/take`)).json.ride.declined, []);
  // the driver declining = releasing
  from = host.notifications.length;
  const dd = await as(MARC)('POST', `/rides/${id}/decline`);
  assert.deepEqual([dd.json.ride.status, dd.json.ride.declined.map((x) => x.userId)], ['open', [MARC.id]]);
  assert.deepEqual(ridePushes(host, from).map((x) => x.data.familie.type), ['ride_released', 'ride_unassigned']);

  // a child asked: everyone who could is a parent; both must decline
  const kid = (await as(TIM)('POST', '/rides', { date: '2026-10-15', time: '07:30', title: 'Zur Schule', ask: false })).json.ride.id;
  assert.equal((await as(ANNA)('POST', `/rides/${kid}/decline`)).json.unassigned, false);
  from = host.notifications.length;
  assert.equal((await as(MARC)('POST', `/rides/${kid}/decline`)).json.unassigned, true);
  assert.deepEqual(ridePushes(host, from).map((x) => [x.users, x.title, x.body]), [[[TIM.id], 'Niemand kann Tim abholen', 'morgen 07:30']]);

  // driver (parents): a member, a free text, cleared
  from = host.notifications.length;
  const w = await as(ANNA)('POST', `/rides/${id}/driver`, { label: 'Familie Weber' });
  assert.deepEqual([w.json.ride.status, w.json.ride.driver], ['taken', { label: 'Familie Weber' }]);
  assert.deepEqual(ridePushes(host, from).map((x) => [x.users, x.title]), [[[TIM.id], 'Familie Weber holt Tim ab']]);
  from = host.notifications.length;
  assert.deepEqual((await as(ANNA)('POST', `/rides/${id}/driver`, { userId: MARC.id })).json.ride.driver, { userId: MARC.id, name: 'Marc' });
  assert.deepEqual(ridePushes(host, from).map((x) => [x.users.sort(), x.title]), [[[MARC.id, TIM.id], 'Marc holt Tim ab']], 'the assigned driver hears it too');
  assert.equal((await as(ANNA)('POST', `/rides/${id}/driver`, { clear: true })).json.ride.status, 'open');
  assert.equal((await as(ANNA)('POST', `/rides/${id}/driver`, { userId: LENA.id })).json.code, 'invalid', 'a child of 12 does not drive');
  assert.equal((await as(ANNA)('POST', `/rides/${id}/driver`, {})).json.code, 'invalid');

  // an adult child may drive
  await admin('PATCH', 'members/' + LENA.id, { birthdate: birth(18) });
  assert.equal((await as(LENA)('POST', `/rides/${id}/take`)).json.ride.driver.name, 'Lena');

  // a cancelled ride: nothing to take or ask
  await as(ANNA)('PATCH', `/rides/${id}`, { status: 'cancelled' });
  for (const action of ['take', 'decline', 'ask']) assert.equal((await as(MARC)('POST', `/rides/${id}/${action}`)).json.code, 'cancelled', action);
  assert.equal((await as(ANNA)('POST', `/rides/${id}/driver`, { label: 'Bus' })).json.code, 'cancelled');
  for (const n of host.notifications) assert.ok(n.ttl >= 60 && n.ttl <= 30 * 86400);
}));

test('overview: the next 24 hours (at most 5) and the open rides of the week', () => withFamily({}, async (host, { as }) => {
  for (const [d, time, driver] of [['2026-10-14', '09:00', null], ['2026-10-14', '16:00', null], ['2026-10-15', '07:30', { userId: MARC.id }], ['2026-10-15', '12:00', null], ['2026-10-18', '10:00', null]]) {
    await as(ANNA)('POST', '/rides', { date: d, time, title: `Fahrt ${d} ${time}`, childIds: [TIM.id], driver });
  }
  const ov = (await as(TIM)('GET', '/overview')).json.rides;
  assert.deepEqual(ov.next.map((x) => [x.date, x.time, x.status]), [['2026-10-14', '16:00', 'open'], ['2026-10-15', '07:30', 'taken']], 'from now, 24 hours');
  assert.equal(ov.open, 3, '16:00 today, 12:00 tomorrow, Sunday (09:00 today is past)');
}));

test('tick: the driver\'s reminder and the open ride 60 minutes before — once per occurrence', () => withFamily({}, async (host, { as, clock, admin }) => {
  const at = (hh, mm) => Date.UTC(2026, 9, 14, hh - 2, mm); // Berlin (UTC+2) on T0's day
  const a = (await as(ANNA)('POST', '/rides', { date: '2026-10-14', time: '12:00', title: 'Lena zum Klavier', place: 'Musikschule', childIds: [LENA.id], driver: { userId: MARC.id }, remindMinutes: 30 })).json.ride;
  const b = (await as(ANNA)('POST', '/rides', { date: '2026-10-14', time: '11:30', ...TRAINING })).json.ride;
  const s = (await as(ANNA)('POST', '/rides', { date: '2026-10-14', time: '18:00', title: 'Schwimmen', childIds: [TIM.id], driver: { userId: ANNA.id }, repeat: { weekdays: [3, 4] } })).json.ride;
  await host.tick();
  assert.equal(ridePushes(host).length, 0, '10:00: nothing yet');
  clock.set(at(10, 31));
  await host.tick();
  await host.tick();
  let p = ridePushes(host);
  assert.deepEqual(p.map((x) => [x.users.sort(), x.title, x.body, x.data.familie]), [
    [[ANNA.id, MARC.id], 'Noch offen: Tim vom Training abholen 11:30', '11:30 · Sporthalle Nord', { type: 'ride_open', rideId: b.id, date: '2026-10-14' }],
  ]);
  clock.set(at(11, 31));
  await host.tick();
  await host.tick();
  p = ridePushes(host);
  assert.deepEqual(p.slice(1).map((x) => [x.users, x.title, x.body, x.priority, x.data.familie]), [
    [[MARC.id], 'Gleich: Lena zum Klavier', '12:00 · Musikschule', 'high', { type: 'ride_reminder', rideId: a.id, date: '2026-10-14' }],
  ]);
  // past the start: nothing; the series reminds its driver on each occurrence
  clock.set(at(17, 41));
  await host.tick();
  await host.tick();
  p = ridePushes(host);
  assert.deepEqual(p.slice(2).map((x) => [x.users, x.data.familie.type, x.data.familie.rideId]), [[[ANNA.id], 'ride_reminder', s.id]]);
  clock.set(at(17, 41) + DAY);
  await host.tick();
  p = ridePushes(host);
  assert.deepEqual(p.slice(3).map((x) => [x.data.familie.type, x.data.familie.rideId]), [['ride_reminder', `${s.seriesId}:2026-10-15`]]);
  // a cancelled occurrence and a switched-off module stay quiet
  await as(ANNA)('DELETE', `/rides/${s.seriesId}:2026-10-21`);
  clock.set(at(17, 41) + 7 * DAY);
  await host.tick();
  assert.equal(ridePushes(host).length, 4, 'cancelled');
  await admin('PUT', 'modules', { rides: false });
  clock.set(at(17, 41) + 8 * DAY);
  await host.tick();
  assert.equal(ridePushes(host).length, 4, 'module off');
  assert.equal(pushes(host, 'ride_open').length, 1);
}));

test('a recent ask holds the open-ride push back for 15 minutes', () => withFamily({}, async (host, { as, clock }) => {
  const b = (await as(TIM)('POST', '/rides', { date: '2026-10-14', time: '10:40', title: 'Bitte abholen' })).json.ride;
  assert.equal(pushes(host, 'ride_ask').length, 1);
  await host.tick();
  assert.equal(pushes(host, 'ride_open').length, 0, 'just asked');
  clock.add(15 * MIN);
  await host.tick();
  assert.deepEqual(pushes(host, 'ride_open').map((x) => x.data.familie.rideId), [b.id]);
}));
