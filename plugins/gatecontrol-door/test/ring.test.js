'use strict';

// Ring (unofficial API, faked): login wizard with 2FA (the password is never
// stored, only the newest refresh token), token rotation, hardware id once,
// devices, the event poll (dings/active + location events) with de-dup, the
// doorbell push with picture and "Tür öffnen" for people with `open`, motion
// opt-in and gap, back-off on 429, "Ring-Verbindung gestört" (one admin push
// per day), pictures for the app (base64, refresh rate limit).

const test = require('node:test');
const assert = require('node:assert/strict');
const ring = require('../server/ring');
const { withDoor, ringLogin, app, kiosk, ADMIN, ANNA, MARC, LENA, GAST, SEC, MIN, HOUR, jpeg } = require('./helpers');

async function linkCameras(admin, lockId) {
  const cams = (await admin('GET', 'status')).json.cameras;
  for (const c of cams) assert.equal((await admin('PATCH', `cameras/${c.id}`, { lockId })).status, 200);
  return cams;
}

test('login wizard: email + password → 2FA code → only the refresh token is stored; wrong code; never the password', () => withDoor({}, async (host, { admin, cloud }) => {
  assert.equal((await admin('POST', 'ring/login', { email: 'kein', password: 'x' })).json.code, 'invalid');
  assert.equal((await admin('POST', 'ring/login', { email: 'a@b.de', password: 'falsch' })).json.code, 'ring_login_failed');
  const s1 = (await admin('POST', 'ring/login', { email: 'a@b.de', password: 'geheim' })).json;
  assert.deepEqual(s1.ring, { connected: false, needsCode: true, tsvState: 'sms', phone: '+49******12' });
  const bad = await admin('POST', 'ring/login', { email: 'a@b.de', password: 'geheim', code: '000000' });
  assert.deepEqual([bad.status, bad.json.code], [400, 'ring_bad_code']);
  const ok = (await admin('POST', 'ring/login', { email: 'a@b.de', password: 'geheim', code: '123456' })).json;
  assert.deepEqual(ok.ring, { connected: true, devices: 2 });
  const oauth = cloud.calls.filter((c) => c.url === ring.OAUTH);
  assert.ok(oauth.every((c) => c.json.client_id === 'ring_official_android' && c.json.scope === 'client' && c.headers['2fa-support'] === 'true' && c.headers['user-agent'] === 'android:com.ringapp'));
  const hw = new Set(cloud.calls.map((c) => c.headers.hardware_id));
  assert.equal(hw.size, 1, 'one hardware id per installation');
  assert.match([...hw][0], /^[0-9a-f-]{36}$/);
  // stored: the refresh token as a secret and the hardware id — never the password or the e-mail
  assert.equal(host.settings[ring.SECRET], cloud.ring.validRt);
  assert.ok(host.secrets.has(ring.SECRET));
  const all = JSON.stringify(host.settings) + JSON.stringify([...host.kv]) + JSON.stringify(host.logs);
  assert.ok(!all.includes('geheim') && !all.includes('a@b.de'));
  const st = (await admin('GET', 'status')).json;
  assert.ok(!JSON.stringify(st).includes(cloud.ring.validRt), 'the token never reaches the page');
  assert.deepEqual([st.ring.connected, st.ring.state], [true, 'ok']);
  assert.deepEqual(st.cameras.map((c) => [c.name, c.doorbell, c.online, c.battery]), [['Garten', false, false, null], ['Klingel Haustür', true, true, 87]]);
  assert.deepEqual((await admin('POST', 'ring/logout')).json.ring, { connected: false });
  assert.equal(host.settings[ring.SECRET], undefined);
}));

test('token rotation: the newest refresh token is stored at once; refreshes run one at a time', () => withDoor({}, async (host, ctx) => {
  await ringLogin(ctx);
  const first = host.settings[ring.SECRET];
  ring.reset(); // a restart: no access token in memory
  await Promise.all([ring.devices(host.gc), ring.activeDings(host.gc), ring.devices(host.gc)]);
  assert.notEqual(host.settings[ring.SECRET], first);
  assert.equal(host.settings[ring.SECRET], ctx.cloud.ring.validRt, 'exactly the newest one');
  assert.equal(ctx.cloud.calls.filter((c) => c.url === ring.OAUTH && c.json.grant_type === 'refresh_token').length, 1, 'one refresh for three parallel requests');
  // an invalid refresh token → "login" state, the dead token is dropped, admins pushed once per day
  ctx.cloud.ring.validRt = 'other';
  ring.reset();
  await host.tick();
  const st = (await ctx.admin('GET', 'status')).json.ring;
  assert.deepEqual([st.connected, st.state, st.broken], [false, 'login', true]);
  const n = host.notifications.filter((x) => x.title === 'Ring-Verbindung gestört');
  assert.deepEqual(n.map((x) => x.users), [[ADMIN.id]]);
  assert.equal((await ctx.call(app(ANNA), 'GET', '/me')).json.ring.broken, true);
  // Nuki keeps working
  assert.equal((await ctx.call(app(ANNA), 'POST', `/locks/${ctx.lockId}/unlock`)).status, 200);
}));

test('a ring: one history row with the picture, push "doorbell" (high) to viewers; "Tür öffnen" (device auth) only for `open`; de-dup across both polls', () => withDoor({}, async (host, ctx) => {
  const { admin, call, cloud, lockId, clock } = ctx;
  await ringLogin(ctx);
  const cams = await linkCameras(admin, lockId);
  const bell = cams.find((c) => c.doorbell);
  await admin('PUT', `rights/${MARC.id}`, { cameras: { [bell.id]: { ding: false } } });
  host.notifications.length = 0;
  cloud.ring.active = [{ id: 7001, id_str: '7001', doorbot_id: 111, kind: 'ding', state: 'ringing', now: Date.now() / 1000, expires_in: 60 }];
  await host.tick();
  await host.tick();
  cloud.ring.events = [{ ding_id_str: '7001', doorbot_id: 111, kind: 'ding', created_at: new Date().toISOString() }];
  clock.add(31 * SEC);
  await host.tick();
  const pushes = host.notifications.filter((n) => n.topic === 'doorbell');
  assert.equal(pushes.length, 2, 'one push per group, once');
  const [open, others] = pushes;
  assert.deepEqual([open.users, others.users], [[ANNA.id], [LENA.id]], 'Marc switched the doorbell push off for this camera');
  assert.equal(open.title, 'Es klingelt: Haustür');
  assert.equal(open.priority, 'high');
  assert.equal(open.collapseKey, `ring:${bell.id}`);
  assert.deepEqual(open.image, { mime: 'image/jpeg', size: jpeg().length, width: 640, height: 360 });
  assert.match(open.imageUrl, /^\/notify-media\/[A-Za-z0-9_-]{22,}\.jpg$/);
  assert.deepEqual(open.data.actions[0], { type: 'quick_action', label: 'Tür öffnen', plugin: 'gatecontrol-door', id: `${lockId}:open`, confirm: true, auth: 'device' });
  assert.equal(open.data.actions[1].type, 'open_app_route');
  assert.deepEqual(others.data.actions.map((a) => a.type), ['open_app_route']);
  const eventId = open.data.door.eventId;
  assert.deepEqual(open.data.door, { type: 'ding', eventId, cameraId: bell.id, lockId });
  // the event for "Ansehen": the picture as base64
  const ev = (await call(app(LENA), 'GET', `/events/${eventId}`)).json.event;
  assert.equal(ev.kind, 'ding');
  assert.equal(Buffer.from(ev.image.data, 'base64').equals(jpeg()), true);
  assert.equal(ev.lock.right, 'view');
  assert.equal((await call(app(GAST), 'GET', `/events/${eventId}`)).status, 404);
  const rows = (await admin('GET', 'history', null, { kind: 'ding' })).json.items;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hasImage, true);
  // the quick action from the push runs through the normal checks (via notification)
  assert.equal((await host.runQuickAction(ANNA, `${lockId}:open`, 'de', { via: 'notification' })).body.ok, true);
  assert.equal((await host.runQuickAction(LENA, `${lockId}:open`, 'de', { via: 'notification' })).status, 404);
}));

test('motion: only who opted in per camera (topic motion), at most one per camera per 5 min; old events are ignored', () => withDoor({}, async (host, ctx) => {
  const { admin, call, cloud, lockId, clock } = ctx;
  await ringLogin(ctx);
  const cams = await linkCameras(admin, lockId);
  const bell = cams.find((c) => c.doorbell);
  assert.deepEqual((await call(app(LENA), 'PUT', `/cameras/${bell.id}/prefs`, { motion: true })).json.prefs, { ding: true, motion: true });
  assert.equal((await call(kiosk(LENA), 'PUT', `/cameras/${bell.id}/prefs`, { motion: false })).json.code, 'read_only');
  host.notifications.length = 0;
  const ev = (id, ago = 0) => ({ id_str: String(id), doorbot_id: 111, kind: 'motion', now: (Date.now() - ago) / 1000, expires_in: 60 });
  cloud.ring.active = [ev(1), ev(0, 10 * MIN)];
  await host.tick();
  clock.add(MIN);
  cloud.ring.active = [ev(2)];
  await host.tick();
  clock.add(5 * MIN);
  cloud.ring.active = [ev(3)];
  await host.tick();
  const m = host.notifications.filter((n) => n.topic === 'motion');
  assert.deepEqual(m.map((n) => n.users), [[LENA.id], [LENA.id]]);
  assert.equal(m[0].title, 'Bewegung: Klingel Haustür');
  assert.equal((await admin('GET', 'history', null, { kind: 'motion' })).json.items.length, 3, 'every new motion in the history, the 10-min-old one not');
}));

test('429: back-off for Retry-After; errors back off and recover; snapshot API with refresh rate limit', () => withDoor({}, async (host, ctx) => {
  const { admin, call, cloud, lockId, clock } = ctx;
  await ringLogin(ctx);
  const cams = await linkCameras(admin, lockId);
  const bell = cams.find((c) => c.doorbell);
  cloud.ring.status429 = true;
  await host.tick();
  const n = cloud.calls.length;
  clock.add(60 * SEC);
  await host.tick();
  assert.equal(cloud.calls.length, n, 'waits for Retry-After (120 s)');
  cloud.ring.status429 = false;
  clock.add(61 * SEC);
  await host.tick();
  assert.ok(cloud.calls.length > n);
  assert.equal((await admin('GET', 'status')).json.ring.state, 'ok');
  // pictures for the app: JSON with base64; refresh=1 at most once per camera per 15 s
  const s = (await call(app(LENA), 'GET', `/cameras/${bell.id}/snapshot`)).json.snapshot;
  assert.deepEqual([s.cameraId, s.mime, s.size], [bell.id, 'image/jpeg', jpeg().length]);
  const r1 = await call(app(LENA), 'GET', `/cameras/${bell.id}/snapshot`, null, { refresh: '1' });
  assert.equal(r1.status, 200);
  const r2 = await call(app(ANNA), 'GET', `/cameras/${bell.id}/snapshot`, null, { refresh: '1' });
  assert.deepEqual([r2.status, r2.json.code], [429, 'too_soon']);
  assert.ok(r2.json.retryAfter > 0);
  clock.add(16 * SEC);
  assert.equal((await call(app(ANNA), 'GET', `/cameras/${bell.id}/snapshot`, null, { refresh: '1' })).status, 200);
  assert.equal((await call(app(GAST), 'GET', `/cameras/${bell.id}/snapshot`)).status, 404, 'no right on the linked lock');
  // a picture over 300 KB is never used
  cloud.ring.snapshot = jpeg(640, 360, 310 * 1024);
  clock.add(16 * SEC);
  const big = (await call(app(ANNA), 'GET', `/cameras/${bell.id}/snapshot`, null, { refresh: '1' })).json.snapshot;
  assert.ok(big.size < 300 * 1024, 'falls back to the stored one');
  // pictures expire with the retention (default 7 days)
  clock.add(8 * 24 * HOUR);
  await host.tick();
  cloud.ring.snapshot = null;
  assert.equal((await call(app(ANNA), 'GET', `/cameras/${bell.id}/snapshot`)).json.code, 'no_image');
}));
