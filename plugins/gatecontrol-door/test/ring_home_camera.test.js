'use strict';

// 1.9.0 — a Ring doorbell linked to a camera in the home network (admin page „Geräte“, homeCameraId): the doorbell
// and motion pushes carry the home camera's id and its live route (data.door.homeCameraId, data.door.live) — only for
// people who see that camera; GET /me and GET events/<id> too. Without a link the push is exactly as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withDoor, ringLogin, app, ANNA, MARC, LENA, SEC, MIN } = require('./helpers');

const GW = { id: 7, name: 'Gateway', online: true, supported: true, enabled: true, service: 'managed', storage: { free: 1.2e12, total: 4e12 }, hint: null };
const cams = () => ({ gateways: [GW], found: [], password: 'geheim', events: [] });

async function setup(ctx) {
  const { admin, lockId } = ctx;
  await ringLogin(ctx);
  const ringCams = (await admin('GET', 'status')).json.cameras;
  for (const c of ringCams) assert.equal((await admin('PATCH', `cameras/${c.id}`, { lockId })).status, 200);
  const bell = ringCams.find((c) => c.doorbell);
  const homeId = (await admin('POST', 'home/cameras', { gatewayId: 7, name: 'Haustür innen', host: '192.168.1.73', user: 'admin', password: 'geheim' })).json.camera.id;
  return { bell, homeId };
}

const ring = (cloud, id) => { cloud.ring.events = [{ ding_id_str: String(id), doorbot_id: 111, kind: 'ding', created_at: new Date().toISOString() }]; };

test('a linked home camera: in the ring\'s push for those who see it, in /me and the event; unlinked: as before', () => withDoor({ cameras: cams() }, async (host, ctx) => {
  const { admin, call, cloud, clock, lockId } = ctx;
  const { bell, homeId } = await setup(ctx);
  // the admin page offers the home cameras and checks the id
  const st = (await admin('GET', 'status')).json;
  assert.deepEqual(st.homeCameras, [{ id: homeId, name: 'Haustür innen' }]);
  assert.equal(st.cameras.find((c) => c.id === bell.id).homeCameraId, null);
  assert.equal((await admin('PATCH', `cameras/${bell.id}`, { homeCameraId: 'c0000000000000ff' })).json.field, 'homeCameraId');
  assert.equal((await admin('PATCH', `cameras/${bell.id}`, { homeCameraId: 5 })).status, 400);
  let r = await admin('PATCH', `cameras/${bell.id}`, { homeCameraId: homeId });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.camera.homeCameraId, homeId);
  // Anna (open) and Lena (view) see the home camera, Marc not
  for (const u of [ANNA, LENA]) assert.equal((await admin('PUT', `rights/${u.id}`, { homeCameraRights: { [homeId]: true } })).status, 200);

  host.notifications.length = 0;
  ring(cloud, 8001);
  clock.add(31 * SEC);
  await host.tick();
  const pushes = host.notifications.filter((n) => n.topic === 'doorbell');
  const live = { source: 'home', cameraId: homeId, path: `cameras/home/${homeId}/live` };
  const byUser = new Map(pushes.flatMap((p) => p.users.map((u) => [u, p])));
  assert.deepEqual([...byUser.keys()].sort(), [ANNA.id, MARC.id, LENA.id].sort(), 'everybody once');
  const eventId = byUser.get(ANNA.id).data.door.eventId;
  assert.deepEqual(byUser.get(ANNA.id).data.door, { type: 'ding', eventId, cameraId: bell.id, lockId, homeCameraId: homeId, live });
  assert.deepEqual(byUser.get(LENA.id).data.door, { type: 'ding', eventId, cameraId: bell.id, lockId, homeCameraId: homeId, live });
  assert.deepEqual(byUser.get(MARC.id).data.door, { type: 'ding', eventId, cameraId: bell.id, lockId }, 'Marc does not see the home camera');
  // the open action stays with who may open (Anna); the rest as before
  assert.equal(byUser.get(ANNA.id).data.actions[0].type, 'quick_action');
  assert.deepEqual(byUser.get(LENA.id).data.actions.map((a) => a.type), ['open_app_route']);
  assert.deepEqual(byUser.get(MARC.id).data.actions.map((a) => a.type), ['open_app_route']);
  // GET /me and the event
  const meCam = (u) => call(app(u), 'GET', '/me').then((x) => x.json.cameras.find((c) => c.id === bell.id));
  assert.deepEqual([(await meCam(LENA)).homeCameraId, (await meCam(LENA)).live], [homeId, live]);
  assert.deepEqual([(await meCam(MARC)).homeCameraId, (await meCam(MARC)).live], [undefined, undefined]);
  assert.equal((await call(app(LENA), 'GET', `/events/${eventId}`)).json.event.homeCameraId, homeId);
  assert.equal((await call(app(MARC), 'GET', `/events/${eventId}`)).json.event.homeCameraId, undefined);
  // the live route named there answers
  assert.equal((await call(app(LENA), 'GET', '/' + live.path)).json.live.mode, 'snapshot');

  // motion: the same fields for who opted in and sees the camera
  assert.equal((await call(app(LENA), 'PUT', `/cameras/${bell.id}/prefs`, { motion: true })).status, 200);
  host.notifications.length = 0;
  clock.add(10 * MIN);
  cloud.ring.active = [{ id_str: '8101', doorbot_id: 111, kind: 'motion', now: Date.now() / 1000, expires_in: 60 }];
  await host.tick();
  const m = host.notifications.filter((n) => n.topic === 'motion');
  assert.equal(m.length, 1);
  assert.deepEqual([m[0].users, m[0].data.door.homeCameraId, m[0].data.door.live], [[LENA.id], homeId, live]);

  // the home camera removed: the link goes with it; the push as before
  assert.equal((await admin('DELETE', `home/cameras/${homeId}`)).status, 200);
  assert.equal((await admin('GET', 'status')).json.cameras.find((c) => c.id === bell.id).homeCameraId, null);
  host.notifications.length = 0;
  clock.add(MIN);
  ring(cloud, 8002);
  clock.add(31 * SEC);
  await host.tick();
  for (const p of host.notifications.filter((n) => n.topic === 'doorbell')) assert.deepEqual(Object.keys(p.data.door).sort(), ['cameraId', 'eventId', 'lockId', 'type']);
}));

test('1.10.0: a doorbell without a link and exactly one home camera — the ring\'s push names that camera (TV without a setting)', () => withDoor({ cameras: cams() }, async (host, ctx) => {
  const { admin, call, cloud, clock, lockId } = ctx;
  const { bell, homeId } = await setup(ctx);
  assert.equal((await admin('GET', 'status')).json.cameras.find((c) => c.id === bell.id).homeCameraId, null, 'no link on the admin page');
  for (const u of [ANNA, LENA]) assert.equal((await admin('PUT', `rights/${u.id}`, { homeCameraRights: { [homeId]: true } })).status, 200);
  const live = { source: 'home', cameraId: homeId, path: `cameras/home/${homeId}/live` };
  host.notifications.length = 0;
  ring(cloud, 8201);
  clock.add(31 * SEC);
  await host.tick();
  const byUser = new Map(host.notifications.filter((n) => n.topic === 'doorbell').flatMap((p) => p.users.map((u) => [u, p])));
  const eventId = byUser.get(LENA.id).data.door.eventId;
  assert.deepEqual(byUser.get(LENA.id).data.door, { type: 'ding', eventId, cameraId: bell.id, lockId, homeCameraId: homeId, live });
  assert.deepEqual(byUser.get(MARC.id).data.door, { type: 'ding', eventId, cameraId: bell.id, lockId }, 'only for who sees the home camera');
  // GET /me and the event: the same camera; the Ring camera that is no doorbell gets none
  const me = (await call(app(LENA), 'GET', '/me')).json.cameras;
  assert.equal(me.find((c) => c.id === bell.id).homeCameraId, homeId);
  assert.equal(me.find((c) => !c.doorbell).homeCameraId, undefined);
  assert.equal((await call(app(LENA), 'GET', `/events/${eventId}`)).json.event.homeCameraId, homeId);
  // a second home camera: no guess any more — only a link decides
  const second = (await admin('POST', 'home/cameras', { gatewayId: 7, name: 'Garage', host: '192.168.1.74', user: 'admin', password: 'geheim' })).json.camera.id;
  assert.ok(second);
  host.notifications.length = 0;
  clock.add(MIN);
  ring(cloud, 8202);
  clock.add(31 * SEC);
  await host.tick();
  for (const p of host.notifications.filter((n) => n.topic === 'doorbell')) assert.deepEqual(Object.keys(p.data.door).sort(), ['cameraId', 'eventId', 'lockId', 'type']);
  assert.equal((await call(app(LENA), 'GET', '/me')).json.cameras.find((c) => c.id === bell.id).homeCameraId, undefined);
}));

test('homeOf: the link wins, else the only home camera for a doorbell', () => {
  const { homeOf } = require('../server/cameras');
  const one = new Set(['c00000000000000a']);
  const two = new Set(['c00000000000000a', 'c00000000000000b']);
  assert.equal(homeOf({ doorbell: 1, home_camera_id: null }, one), 'c00000000000000a');
  assert.equal(homeOf({ doorbell: 0, home_camera_id: null }, one), null);
  assert.equal(homeOf({ doorbell: 1, home_camera_id: null }, two), null);
  assert.equal(homeOf({ doorbell: 1, home_camera_id: 'c00000000000000b' }, two), 'c00000000000000b');
  assert.equal(homeOf({ doorbell: 1, home_camera_id: 'c00000000000000f' }, one), null, 'a stale link is no guess');
  assert.equal(homeOf({ doorbell: 1, home_camera_id: null }, new Set()), null);
});

test('unlinked again with null', () => withDoor({ cameras: cams() }, async (host, ctx) => {
  const { admin } = ctx;
  const { bell, homeId } = await setup(ctx);
  await admin('PATCH', `cameras/${bell.id}`, { homeCameraId: homeId });
  const r = await admin('PATCH', `cameras/${bell.id}`, { homeCameraId: null });
  assert.equal(r.json.camera.homeCameraId, null);
}));

test('without gc.cameras (an older GateControl): no home cameras to link, null still allowed', () => withDoor({}, async (host, ctx) => {
  await ringLogin(ctx);
  const st = (await ctx.admin('GET', 'status')).json;
  assert.deepEqual(st.homeCameras, []);
  const bell = st.cameras.find((c) => c.doorbell);
  assert.equal((await ctx.admin('PATCH', `cameras/${bell.id}`, { homeCameraId: 'c0000000000000aa' })).status, 400);
  assert.equal((await ctx.admin('PATCH', `cameras/${bell.id}`, { homeCameraId: null })).status, 200);
}));

test('the page „Geräte“ has the text of the new choice in both languages', () => {
  const texts = require('../server/texts.json');
  const all = JSON.stringify(texts);
  assert.ok(all.includes('Livebild beim Klingeln (Heimkamera)'));
  assert.ok(all.includes('Live picture on a ring (home camera)'));
});
