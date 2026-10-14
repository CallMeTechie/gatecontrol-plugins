'use strict';

// "Bin angekommen" and SOS: pushes to the parents (never the caller), SOS
// with priority critical (topic sos allows it), a repeat within 30 s is the
// same SOS, ack by a parent, retention, module switch.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, MIN, DAY, pushes } = require('./helpers');

test('arrival: to the parents with label and local time; at least 60 s apart', () => withFamily({}, async (host, { as, clock }) => {
  const r = await as(TIM)('POST', '/arrival', { label: 'Schule', lat: 52.5, lon: 13.4, accuracy: 25 });
  assert.equal(r.status, 200);
  assert.equal(r.json.notified, 2);
  const p = pushes(host, 'arrival');
  assert.deepEqual(p.map((x) => [x.topic, x.users.sort(), x.title, x.body]), [['arrival', [ANNA.id, MARC.id], 'Tim ist angekommen', 'Schule · 10:00']]);
  assert.deepEqual(p[0].data.familie, { type: 'arrival', userId: TIM.id, label: 'Schule', arrivalId: r.json.arrivalId });
  const again = await as(TIM)('POST', '/arrival', {});
  assert.deepEqual([again.status, again.json.code], [429, 'too_soon']);
  clock.add(MIN);
  await as(TIM)('POST', '/arrival', {});
  assert.equal(pushes(host, 'arrival')[1].body, '10:01');
  const fromParent = await as(ANNA)('POST', '/arrival', { label: 'Büro' });
  assert.equal(fromParent.json.notified, 1, 'the other parent only');
  assert.equal((await as(LENA)('POST', '/arrival', { label: 'x'.repeat(61) })).json.code, 'invalid');
  assert.equal((await as(LENA)('POST', '/arrival', { lat: 52.5 })).json.code, 'invalid', 'lat without lon');
  const ov = await as(MARC)('GET', '/overview');
  assert.deepEqual(ov.json.arrivals.map((a) => [a.userId, a.label]), [[ANNA.id, 'Büro'], [TIM.id, null]]);
}));

test('SOS: critical to every parent but the caller; a repeat within 30 s returns the same sosId; ack goes back', () => withFamily({}, async (host, { as, clock }) => {
  const s = await as(LENA)('POST', '/sos', { lat: 52.51, lon: 13.39, accuracy: 18.2, at: '2026-10-14T07:59:58Z' });
  assert.deepEqual([s.status, s.json.repeated, s.json.notified], [200, false, 2]);
  const id = s.json.sosId;
  const p = pushes(host, 'sos');
  assert.equal(p.length, 1);
  assert.deepEqual([p[0].topic, p[0].priority, p[0].collapseKey, p[0].title, p[0].body], ['sos', 'critical', `sos:${id}`, 'SOS von Lena', '10:00 · Position ±18 m']);
  assert.deepEqual(p[0].users.sort(), [ANNA.id, MARC.id]);
  assert.deepEqual(p[0].data.familie, { type: 'sos', sosId: id, userId: LENA.id, lat: 52.51, lon: 13.39, accuracy: 18.2 });
  clock.add(20 * 1000);
  const rep = await as(LENA)('POST', '/sos', { lat: 52.5101, lon: 13.3901, accuracy: 6 });
  assert.deepEqual(rep.json, { ok: true, sosId: id, repeated: true, notified: 0 });
  assert.equal(pushes(host, 'sos').length, 1, 'no second alarm');
  assert.equal((await as(ANNA)('GET', `/sos/${id}`)).json.sos.accuracy, 6, 'the better position is kept');
  clock.add(15 * 1000);
  const next = await as(LENA)('POST', '/sos', {});
  assert.notEqual(next.json.sosId, id, 'after 30 s: a new SOS');
  assert.equal(pushes(host, 'sos')[1].body, '10:00 · Position unbekannt');
  // ack
  assert.equal((await as(TIM)('POST', `/sos/${id}/ack`)).json.code, 'parents_only');
  const a = await as(MARC)('POST', `/sos/${id}/ack`);
  assert.deepEqual(a.json.sos.acks.map((x) => [x.userId, x.name]), [[MARC.id, 'Marc']]);
  const ack = pushes(host, 'sos_ack');
  assert.deepEqual(ack.map((x) => [x.users, x.title, x.priority, x.topic]), [[[LENA.id], 'Marc hat dein SOS gesehen', 'high', 'sos']]);
  await as(MARC)('POST', `/sos/${id}/ack`);
  assert.equal(pushes(host, 'sos_ack').length, 1, 'idempotent per parent');
  await as(ANNA)('POST', `/sos/${id}/ack`);
  assert.equal(pushes(host, 'sos_ack').length, 2);
  assert.equal((await as(LENA)('GET', `/sos/${id}`)).json.sos.acks.length, 2, 'the sender sees the acks');
  assert.equal((await as(TIM)('GET', `/sos/${id}`)).status, 404, 'a sibling does not');
  assert.equal((await as(ANNA)('GET', '/sos')).json.sos.length, 2);
  assert.equal((await as(TIM)('GET', '/sos')).json.sos.length, 0);
  assert.equal((await as(ANNA)('POST', '/sos/999/ack')).status, 404);
}));

test('SOS is never held back by the plugin\'s own hourly budget', () => withFamily({}, async (host, { as, clock }) => {
  await as(ANNA)('POST', '/shopping/ops', { ops: [{ op: 'list_add', id: 'list-0000-0001', name: 'A' }] });
  // use up the plugin budget for normal messages (80 of 110 per hour): "going" from many lists
  const ops = [];
  for (let i = 0; i < 85; i++) ops.push({ op: 'list_add', id: `list-going-${String(i).padStart(4, '0')}`, name: 'L' + i });
  await as(ANNA)('POST', '/shopping/ops', { ops });
  for (let i = 0; i < 85; i++) await as(ANNA)('POST', `/shopping/lists/list-going-${String(i).padStart(4, '0')}/going`);
  const going = pushes(host, 'shopping_going').length;
  assert.ok(going < 85, `budget holds normal messages back (${going})`);
  const s = await as(TIM)('POST', '/sos', {});
  assert.equal(s.status, 200);
  assert.equal(pushes(host, 'sos').length, 1, 'SOS still sent');
  clock.add(MIN);
}));

test('retention and module switch: coordinates 7 days, rows 90 days; module off → module_off', () => withFamily({}, async (host, { as, admin, clock }) => {
  const s = await as(TIM)('POST', '/sos', { lat: 1, lon: 2, accuracy: 3 });
  await as(TIM)('POST', '/arrival', { lat: 1, lon: 2 });
  clock.add(7 * DAY + MIN);
  await host.tick();
  const sos = (await as(ANNA)('GET', `/sos/${s.json.sosId}`)).json.sos;
  assert.deepEqual([sos.lat, sos.lon, sos.accuracy], [null, null, null]);
  const log = await admin('GET', 'log', null, { days: '30', kind: 'sos,arrival' });
  assert.deepEqual(log.json.entries.map((e) => [e.kind, e.position]), [['arrival', null], ['sos', null]]);
  clock.add(90 * DAY);
  await host.tick();
  assert.equal((await as(ANNA)('GET', `/sos/${s.json.sosId}`)).status, 404);
  await admin('PUT', 'modules', { arrival_sos: false });
  assert.equal((await as(TIM)('POST', '/sos', {})).json.code, 'module_off');
  assert.equal((await as(TIM)('POST', '/arrival', {})).json.code, 'module_off');
  assert.equal((await as(ANNA)('GET', '/overview')).json.arrivals, null);
}));
