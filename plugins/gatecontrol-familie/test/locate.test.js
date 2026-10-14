'use strict';

// Locating children: who may ask (parents, module on, child < 18, mode not
// off), the pushes (auto / confirm to the child; result, decline, fail,
// expiry to the requester), the limits (one open request, 60 s apart, 30
// per local day), the transparency list, the expiry and the retention
// (coordinates 7 days, rows 90 days).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, MIN, DAY, pushes } = require('./helpers');

const FIX = { lat: 52.520008, lon: 13.404954, accuracy: 12.4, at: '2026-10-14T07:59:50Z', battery: 81 };

test('auto: push to the child only; the answer comes back to the requester', () => withFamily({}, async (host, { as }) => {
  const r = await as(ANNA)('POST', `/locate/${TIM.id}`);
  assert.equal(r.status, 200);
  const q = r.json.request;
  assert.deepEqual(
    { childId: q.childId, requestedBy: q.requestedBy, mode: q.mode, status: q.status, createdAt: q.createdAt, expiresAt: q.expiresAt, lat: q.lat },
    { childId: TIM.id, requestedBy: ANNA.id, mode: 'auto', status: 'pending', createdAt: '2026-10-14T08:00:00Z', expiresAt: '2026-10-14T08:10:00Z', lat: null },
  );
  const req = pushes(host, 'locate_request');
  assert.equal(req.length, 1);
  assert.deepEqual(req[0].users, [TIM.id]);
  assert.deepEqual([req[0].topic, req[0].priority, req[0].collapseKey], ['locate', 'high', `locate:${q.id}`]);
  assert.equal(req[0].title, 'Anna hat deinen Standort abgefragt');
  assert.equal(req[0].body, 'Dein Standort wird an Anna gesendet.');
  assert.deepEqual(req[0].data.familie, { type: 'locate_request', requestId: q.id, mode: 'auto', from: 'Anna' });
  assert.equal(req[0].data.route, 'plg-gatecontrol-familie');

  assert.equal((await as(LENA)('POST', `/locate/requests/${q.id}/answer`, FIX)).status, 404, 'only the child of the request');
  assert.equal((await as(TIM)('POST', `/locate/requests/${q.id}/answer`, { ...FIX, lat: 91 })).json.code, 'invalid');
  const a = await as(TIM)('POST', `/locate/requests/${q.id}/answer`, FIX);
  assert.deepEqual([a.json.request.status, a.json.request.lat, a.json.request.lon, a.json.request.accuracy, a.json.request.at, a.json.request.battery, a.json.request.answeredAt],
    ['answered', 52.520008, 13.404954, 12.4, '2026-10-14T07:59:50Z', 81, '2026-10-14T08:00:00Z']);
  const res = pushes(host, 'locate_result');
  assert.deepEqual(res.map((p) => [p.users, p.title, p.body]), [[[ANNA.id], 'Tim: Standort empfangen', 'Genauigkeit ±12 m']]);
  assert.deepEqual(res[0].data.familie, { type: 'locate_result', requestId: q.id, childId: TIM.id });
  assert.equal((await as(TIM)('POST', `/locate/requests/${q.id}/answer`, FIX)).json.code, 'not_pending', 'once');
  // the other parent sees it, the child too (transparency), a sibling not
  assert.equal((await as(MARC)('GET', `/locate/requests/${q.id}`)).json.request.lat, 52.520008);
  assert.equal((await as(TIM)('GET', `/locate/requests/${q.id}`)).json.request.requestedByName, 'Anna');
  assert.equal((await as(LENA)('GET', `/locate/requests/${q.id}`)).status, 404);
  const ov = await as(ANNA)('GET', '/overview');
  assert.deepEqual(ov.json.locate.last, [{ childId: TIM.id, status: 'answered', at: '2026-10-14T08:00:00Z', requestId: q.id }]);
}));

test('confirm: the child declines or the phone fails; readable pushes to the requester', () => withFamily({}, async (host, { as, clock }) => {
  const r = await as(MARC)('POST', `/locate/${LENA.id}`);
  const req = pushes(host, 'locate_request')[0];
  assert.equal(req.title, 'Marc möchte wissen, wo du bist');
  assert.equal(req.body, 'Tippe, um deinen Standort zu senden.');
  assert.equal(req.data.familie.mode, 'confirm');
  assert.equal((await as(LENA)('POST', `/locate/requests/${r.json.request.id}/decline`, { reason: 'bored' })).json.code, 'invalid');
  const d = await as(LENA)('POST', `/locate/requests/${r.json.request.id}/decline`, { reason: 'busy' });
  assert.deepEqual([d.json.request.status, d.json.request.reason], ['declined', 'busy']);
  const dp = pushes(host, 'locate_declined');
  assert.deepEqual(dp.map((p) => [p.users, p.title, p.body]), [[[MARC.id], 'Lena hat die Standortanfrage abgelehnt', 'Gerade beschäftigt.']]);
  clock.add(MIN);
  const r2 = await as(MARC)('POST', `/locate/${LENA.id}`);
  assert.equal((await as(LENA)('POST', `/locate/requests/${r2.json.request.id}/fail`, { code: 'gps_broken' })).json.code, 'invalid');
  const f = await as(LENA)('POST', `/locate/requests/${r2.json.request.id}/fail`, { code: 'location_off' });
  assert.deepEqual([f.json.request.status, f.json.request.reason], ['failed', 'location_off']);
  assert.deepEqual(pushes(host, 'locate_failed').map((p) => [p.title, p.body]), [['Lena: Standort nicht verfügbar', 'Die Standortermittlung ist auf diesem Handy ausgeschaltet.']]);
}));

test('who may: parents only, module on, a child, under 18, mode not off', () => withFamily({}, async (host, { as, admin }) => {
  assert.deepEqual([(await as(LENA)('POST', `/locate/${TIM.id}`)).status, (await as(LENA)('POST', `/locate/${TIM.id}`)).json.code], [403, 'parents_only']);
  assert.equal((await as(ANNA)('POST', `/locate/${MARC.id}`)).json.code, 'not_found', 'not a child');
  assert.equal((await as(ANNA)('POST', '/locate/99')).json.code, 'not_found');
  await admin('PATCH', 'members/' + TIM.id, { locateMode: 'off' });
  assert.deepEqual([(await as(ANNA)('POST', `/locate/${TIM.id}`)).status, (await as(ANNA)('POST', `/locate/${TIM.id}`)).json.code], [409, 'locate_off']);
  await admin('PATCH', 'members/' + LENA.id, { birthdate: '2008-01-01' });
  assert.equal((await as(ANNA)('POST', `/locate/${LENA.id}`)).json.code, 'adult');
  await admin('PUT', 'modules', { locate: false });
  const off = await as(ANNA)('POST', `/locate/${TIM.id}`);
  assert.deepEqual([off.status, off.json.code], [403, 'module_off']);
  assert.equal((await as(TIM)('GET', '/locate/requests')).json.code, 'module_off');
  assert.equal((await as(ANNA)('GET', '/overview')).json.locate, null);
  assert.equal(pushes(host).length, 0);
}));

test('limits: one open request per child, 60 s apart, 30 per child and local day', () => withFamily({}, async (host, { as, clock }) => {
  const r = await as(ANNA)('POST', `/locate/${TIM.id}`);
  const open = await as(MARC)('POST', `/locate/${TIM.id}`);
  assert.deepEqual([open.status, open.json.code, open.json.requestId, open.json.retryAfter], [429, 'too_soon', r.json.request.id, 600]);
  assert.equal((await as(ANNA)('POST', `/locate/${LENA.id}`)).status, 200, 'another child');
  await as(TIM)('POST', `/locate/requests/${r.json.request.id}/answer`, FIX);
  clock.add(30 * 1000);
  const gap = await as(ANNA)('POST', `/locate/${TIM.id}`);
  assert.deepEqual([gap.status, gap.json.code, gap.json.retryAfter], [429, 'too_soon', 30]);
  clock.add(30 * 1000);
  let n = 1;
  for (; n < 30; n++) {
    const x = await as(ANNA)('POST', `/locate/${TIM.id}`);
    assert.equal(x.status, 200, `request ${n + 1}`);
    await as(TIM)('POST', `/locate/requests/${x.json.request.id}/fail`, { code: 'timeout' });
    clock.add(MIN);
  }
  const lim = await as(ANNA)('POST', `/locate/${TIM.id}`);
  assert.deepEqual([lim.status, lim.json.code], [429, 'daily_limit']);
  // the next local day (Berlin midnight)
  clock.set(Date.UTC(2026, 9, 14, 22, 0, 1));
  assert.equal((await as(ANNA)('POST', `/locate/${TIM.id}`)).status, 200);
}));

test('expiry: pending past 10 minutes → expired (tick) with a push; the child cannot answer it any more', () => withFamily({}, async (host, { as, clock }) => {
  const r = await as(ANNA)('POST', `/locate/${LENA.id}`);
  clock.add(9 * MIN);
  await host.tick();
  assert.equal(pushes(host, 'locate_expired').length, 0);
  clock.add(MIN);
  assert.equal((await as(ANNA)('GET', `/locate/requests/${r.json.request.id}`)).json.request.status, 'expired', 'reads as expired before the tick');
  assert.equal((await as(LENA)('POST', `/locate/requests/${r.json.request.id}/answer`, FIX)).json.code, 'not_pending');
  await host.tick();
  const e = pushes(host, 'locate_expired');
  assert.deepEqual(e.map((p) => [p.users, p.title, p.body]), [[[ANNA.id], 'Keine Antwort von Lenas Handy', 'Die Standortanfrage ist nach 10 Minuten abgelaufen.']]);
  await host.tick();
  assert.equal(pushes(host, 'locate_expired').length, 1);
  assert.equal((await as(ANNA)('POST', `/locate/${LENA.id}`)).status, 200, 'a new request is possible');
}));

test('transparency: a child sees only its own requests; parents see every child', () => withFamily({}, async (host, { as, clock }) => {
  await as(ANNA)('POST', `/locate/${TIM.id}`);
  await as(MARC)('POST', `/locate/${LENA.id}`);
  clock.add(MIN);
  const tim = await as(TIM)('GET', '/locate/requests');
  assert.deepEqual(tim.json.requests.map((x) => [x.childId, x.requestedByName]), [[TIM.id, 'Anna']]);
  assert.equal((await as(TIM)('GET', '/locate/requests', null, { childId: String(LENA.id) })).json.code, 'forbidden');
  const all = await as(ANNA)('GET', '/locate/requests');
  assert.deepEqual(all.json.requests.map((x) => x.childId).sort(), [LENA.id, TIM.id]);
  assert.deepEqual((await as(ANNA)('GET', '/locate/requests', null, { childId: String(LENA.id), limit: '1' })).json.requests.map((x) => x.childId), [LENA.id]);
  assert.equal((await as(ANNA)('GET', '/locate/requests', null, { limit: '500' })).json.code, 'invalid');
}));

test('retention: coordinates deleted 7 days after the answer, the row (log) 90 days', () => withFamily({}, async (host, { as, admin, clock }) => {
  const r = await as(ANNA)('POST', `/locate/${TIM.id}`);
  await as(TIM)('POST', `/locate/requests/${r.json.request.id}/answer`, FIX);
  const id = r.json.request.id;
  let log = await admin('GET', 'log', null, { days: '7' });
  assert.deepEqual(log.json.positions.map((p) => [p.childId, p.lat]), [[TIM.id, 52.520008]]);
  assert.deepEqual(log.json.entries[0].position, { lat: 52.520008, lon: 13.404954, accuracy: 12.4 });
  clock.add(7 * DAY - MIN);
  await host.tick();
  assert.equal((await as(ANNA)('GET', `/locate/requests/${id}`)).json.request.lat, 52.520008);
  clock.add(2 * MIN + 3600000);
  await host.tick();
  const purged = (await as(ANNA)('GET', `/locate/requests/${id}`)).json.request;
  assert.deepEqual([purged.status, purged.lat, purged.lon, purged.accuracy, purged.battery, purged.purged], ['answered', null, null, null, null, true]);
  const raw = await host.gc.db.get('SELECT lat, lon, accuracy, battery FROM locate_requests WHERE id = ?', [id]);
  assert.deepEqual(raw.row, { lat: null, lon: null, accuracy: null, battery: null }, 'gone from the database');
  log = await admin('GET', 'log', null, { days: '30' });
  assert.deepEqual([log.json.entries[0].status, log.json.entries[0].position, log.json.positions], ['answered', null, []]);
  clock.add(83 * DAY);
  await host.tick();
  assert.equal((await as(ANNA)('GET', `/locate/requests/${id}`)).status, 404, 'row gone after 90 days');
}));
