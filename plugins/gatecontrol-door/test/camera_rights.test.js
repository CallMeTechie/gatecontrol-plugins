'use strict';

// 1.5.0 — a camera without a lock (at the letterbox, in the garden): before, nobody saw it and its
// rings reached nobody (the people came from the linked lock's rights). Now it has its own list of
// people (admin page "Berechtigungen" → cameraRights): they see it in the apps and the portal, get its
// pushes and find its rings in the history. And the diagnosis warns about what keeps a ring from
// reaching anybody: "Ring abfragen" switched off, a camera nobody sees.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withDoor, ringLogin, app, ANNA, MARC, LENA, GAST, SEC } = require('./helpers');

const ding = (id) => [{ ding_id_str: String(id), doorbot_id: 111, kind: 'ding', created_at: new Date().toISOString() }];

test('a camera without a lock: nobody before, then the people ticked for it — push, /me, history, event', () => withDoor({}, async (host, ctx) => {
  const { admin, call, cloud, clock } = ctx;
  await ringLogin(ctx);
  const cams = (await admin('GET', 'status')).json.cameras;
  const bell = cams.find((c) => c.doorbell);
  assert.equal(bell.lockId, null, 'not linked to a lock');
  let w = (await admin('GET', 'settings')).json.warnings;
  assert.deepEqual(w.map((x) => [x.code, x.camera, x.lock]), [['no_viewers', 'Garten', null], ['no_viewers', 'Klingel Haustür', null]]);
  assert.equal((await call(app(GAST), 'GET', '/me')).json.cameras.length, 0);
  // a ring nobody may see: in the history, no push
  host.notifications.length = 0;
  cloud.ring.events = ding(7101);
  clock.add(31 * SEC);
  await host.tick();
  assert.equal(host.notifications.filter((n) => n.topic === 'doorbell').length, 0);

  // Gast (no lock right at all) and Lena are ticked for the doorbell camera
  let r = await admin('PUT', `rights/${GAST.id}`, { cameraRights: { [bell.id]: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await admin('PUT', `rights/${LENA.id}`, { cameraRights: { [bell.id]: true } });
  assert.deepEqual(r.json.cameraRights, { [GAST.id]: [bell.id], [LENA.id]: [bell.id] });
  assert.equal((await admin('PUT', `rights/${GAST.id}`, { cameraRights: { 999: true } })).json.code, 'invalid');
  assert.equal((await admin('PUT', `rights/${GAST.id}`, { cameraRights: { [bell.id]: 'ja' } })).json.code, 'invalid');
  w = (await admin('GET', 'settings')).json.warnings;
  assert.deepEqual(w.map((x) => x.camera), ['Garten'], 'only the garden camera is seen by nobody now');

  const me = (await call(app(GAST), 'GET', '/me')).json;
  assert.deepEqual([me.locks.length, me.cameras.map((c) => [c.id, c.lockId])], [0, [[bell.id, null]]]);
  assert.ok(me.doorbell, 'the last ring for people who see a camera');
  assert.deepEqual((await call(app(ANNA), 'GET', '/me')).json.cameras, [], 'Anna was not ticked');

  host.notifications.length = 0;
  cloud.ring.events = ding(7102);
  clock.add(31 * SEC);
  await host.tick();
  const pushes = host.notifications.filter((n) => n.topic === 'doorbell');
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].users, [LENA.id, GAST.id].sort((a, b) => a - b));
  assert.equal(pushes[0].title, 'Es klingelt: Klingel Haustür');
  assert.deepEqual(pushes[0].data.actions.map((a) => a.type), ['open_app_route'], 'no lock: nothing to open');
  const eventId = pushes[0].data.door.eventId;
  assert.equal(pushes[0].data.door.lockId, null);
  // the event and the history: for the people ticked, not for others
  assert.equal((await call(app(GAST), 'GET', `/events/${eventId}`)).status, 200);
  assert.equal((await call(app(ANNA), 'GET', `/events/${eventId}`)).status, 404);
  const hist = (await call(app(GAST), 'GET', '/history')).json.items;
  assert.deepEqual(hist.filter((x) => x.kind === 'ding').length, 2, 'both rings of the camera (also the one before the right)');
  assert.equal((await call(app(GAST), 'GET', `/cameras/${bell.id}/snapshot`)).status, 200);

  // linked to a lock later: the lock's rights decide again (Gast has none there)
  assert.equal((await admin('PATCH', `cameras/${bell.id}`, { lockId: ctx.lockId })).status, 200);
  assert.deepEqual((await call(app(GAST), 'GET', '/me')).json.cameras, []);
  assert.equal((await call(app(GAST), 'GET', `/events/${eventId}`)).status, 404);
  assert.equal((await call(app(GAST), 'GET', '/history')).json.items.filter((x) => x.kind === 'ding').length, 0);
  // and ticked off again
  r = await admin('PUT', `rights/${GAST.id}`, { cameraRights: { [bell.id]: false } });
  assert.deepEqual(r.json.cameraRights[GAST.id] || [], []);
}));

test('diagnosis: "Ring abfragen" switched off while Ring is connected is a warning; without Ring no warnings', () => withDoor({}, async (host, ctx) => {
  const { admin } = ctx;
  assert.deepEqual((await admin('GET', 'settings')).json.warnings, [], 'Ring not connected: nothing to warn about');
  await ringLogin(ctx);
  const cams = (await admin('GET', 'status')).json.cameras;
  for (const c of cams) assert.equal((await admin('PATCH', `cameras/${c.id}`, { lockId: ctx.lockId })).status, 200);
  assert.deepEqual((await admin('GET', 'settings')).json.warnings, [], 'linked cameras, people with rights on the lock, polling on');
  const off = (await admin('PUT', 'settings', { ring: false })).json;
  assert.equal(off.config.ring, false);
  assert.deepEqual(off.warnings, [{ code: 'ring_off' }]);
  assert.deepEqual((await admin('PUT', 'settings', { ring: true })).json.warnings, []);
  // a lock nobody has a right on: its camera reaches nobody
  for (const u of [ANNA, MARC, LENA]) await admin('PUT', `rights/${u.id}`, { locks: { [ctx.lockId]: 'none' } });
  const w = (await admin('GET', 'settings')).json.warnings;
  assert.deepEqual(w.map((x) => [x.code, x.camera, x.lock]), [['no_viewers', 'Garten', 'Haustür'], ['no_viewers', 'Klingel Haustür', 'Haustür']]);
}));
