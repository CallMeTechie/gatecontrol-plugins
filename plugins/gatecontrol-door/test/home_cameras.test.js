'use strict';

// 1.6.0 — Kameras im Heimnetz through gc.cameras (tools/testing/mock-cameras.js): an older GateControl
// without it (a note, nothing breaks), adding a camera (wrong password, public address, the password
// never comes back), recordings per camera, who sees it (column "sieht"), the person API (live only
// through the VPN, a snapshot every 10 s otherwise, clips of the day) and the push with a snapshot for
// people (at most once per camera every 5 minutes, "Niemand ist zu Hause").

const test = require('node:test');
const assert = require('node:assert/strict');
const { withDoor, app, portal, kiosk, ANNA, LENA, GAST, MIN } = require('./helpers');

const GW = { id: 7, name: 'DS918 Gateway', online: true, supported: true, enabled: true, service: 'managed', storage: { free: 1.2e12, total: 4e12 }, hint: null };
const FOUND = [{ gatewayId: 7, gateway: 'DS918 Gateway', host: '192.168.1.73', port: 8000, path: '/onvif/device_service', manufacturer: 'Reolink', model: 'E1 Zoom', name: 'Reolink E1' }];
const cams = () => ({ gateways: [GW], found: FOUND, password: 'geheim', events: [] });

test('an older GateControl without gc.cameras: the section says what it needs, the rest works', () => withDoor({}, async (host, ctx) => {
  const r = await ctx.admin('GET', 'home');
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.supported, r.json.minGatecontrol], [false, '1.240.0']);
  assert.equal((await ctx.admin('POST', 'home/discover', {})).json.code, 'cam_needs_gc');
  const p = await ctx.call(app(ANNA), 'GET', '/cameras/home');
  assert.deepEqual([p.json.supported, p.json.cameras], [false, []]);
  assert.equal((await ctx.call(app(ANNA), 'GET', '/me')).status, 200, 'the door part as before');
  const html = (await host.render({ page: 'devices' })).html;
  assert.match(html, /dr-hc-needs/);
}));

test('add a camera: search, wrong password, public address, stored without the password, recordings', () => withDoor({ cameras: cams() }, async (host, ctx) => {
  const { admin } = ctx;
  let v = (await admin('GET', 'home')).json;
  assert.deepEqual([v.supported, v.available, v.cameras.length], [true, true, 0]);
  const f = (await admin('POST', 'home/discover', {})).json.found;
  assert.deepEqual(f.map((x) => [x.host, x.cameraId]), [['192.168.1.73', null]]);
  assert.equal((await admin('POST', 'home/cameras', { gatewayId: 7, name: 'Kinderzimmer', host: '192.168.1.73', user: 'admin', password: 'falsch' })).json.code, 'cam_auth');
  assert.equal((await admin('POST', 'home/cameras', { gatewayId: 7, name: 'X', host: '8.8.8.8', user: 'admin', password: 'geheim' })).json.code, 'cam_not_allowed');
  assert.equal((await admin('POST', 'home/cameras', { gatewayId: 7, name: 'X', rtspUrl: 'http://x' })).json.code, 'invalid');
  const r = await admin('POST', 'home/cameras', { gatewayId: 7, name: 'Einfahrt', host: '192.168.1.73', onvifPort: 8000, user: 'admin', password: 'geheim', settings: { record: 'away', retentionDays: 7 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.snapshot.mime, 'image/jpeg');
  assert.equal(JSON.stringify(r.json).includes('geheim'), false);
  const id = r.json.camera.id;
  assert.equal(r.json.camera.settings.record, 'away');
  assert.equal(r.json.camera.push, true);
  assert.match(r.json.camera.snapshotUrl, /^\/camera-media\//);
  assert.equal(host.cameras.passwords.get(id), 'geheim', 'the password went to GateControl only');
  v = (await admin('GET', 'home')).json;
  assert.equal(JSON.stringify(v).includes('geheim'), false);
  assert.deepEqual(v.cameras.map((c) => c.name), ['Einfahrt']);
  // Aufnahmen: 14/7/30 days only, record modes checked, push switch kept by the plugin
  assert.equal((await admin('PATCH', 'home/cameras/' + id, { settings: { retentionDays: 3 } })).json.code, 'invalid');
  assert.equal((await admin('PATCH', 'home/cameras/' + id, { settings: { record: 'immer' } })).json.code, 'invalid');
  const u = await admin('PATCH', 'home/cameras/' + id, { settings: { record: 'motion', retentionDays: 30 }, push: false });
  assert.deepEqual([u.json.camera.settings.record, u.json.camera.settings.retentionDays, u.json.camera.push], ['motion', 30, false]);
  assert.equal((await admin('PATCH', 'home/cameras/cnope', {})).json.code, 'not_found');
  assert.equal((await admin('DELETE', 'home/cameras/' + id)).status, 200);
  assert.equal((await admin('GET', 'home')).json.cameras.length, 0);
}));

test('who sees it, live only through the VPN, clips of the day, the push for people', () => withDoor({ cameras: cams() }, async (host, ctx) => {
  const { admin, call, clock } = ctx;
  const id = (await admin('POST', 'home/cameras', { gatewayId: 7, name: 'Einfahrt', host: '192.168.1.73', user: 'admin', password: 'geheim' })).json.camera.id;
  // nobody sees it yet
  assert.equal((await call(app(GAST), 'GET', '/cameras/home/' + id + '/live')).json.code, 'not_found');
  assert.equal(await host.portalVisible(portal(GAST)), false);
  let r = await admin('PUT', `rights/${GAST.id}`, { homeCameraRights: { [id]: true } });
  assert.deepEqual(r.json.homeCameraRights, { [GAST.id]: [id] });
  assert.deepEqual(r.json.homeCameras.map((c) => c.id), [id]);
  assert.equal((await admin('PUT', `rights/${GAST.id}`, { homeCameraRights: { cnope: true } })).json.code, 'invalid');
  assert.equal(await host.portalVisible(portal(GAST)), true, 'the portal tab for a person who only sees a home camera');
  const list = (await call(app(GAST), 'GET', '/cameras/home')).json;
  assert.deepEqual(list.cameras.map((c) => [c.id, c.host]), [[id, undefined]], 'no address for the people');
  assert.deepEqual((await call(app(ANNA), 'GET', '/cameras/home')).json.cameras, []);
  let live = (await call(app(GAST), 'GET', '/cameras/home/' + id + '/live')).json.live;
  assert.deepEqual([live.mode, live.every, live.reason], ['snapshot', 10, 'vpn_required']);
  live = (await call(app(GAST), 'GET', '/cameras/home/' + id + '/live', null, {}, { vpn: true })).json.live;
  assert.equal(live.mode, 'live');
  assert.match(live.hls, /index\.m3u8$/);
  const still = (await call(app(GAST), 'GET', '/cameras/home/' + id + '/still')).json.still;
  assert.equal(still.mime, 'image/jpeg');

  // events: today's clips; the push for a person (Lena does not see the camera)
  const now = Date.now();
  host.cameras.events.push({ id: 'e0000000000000a1', cameraId: id, camera: 'Einfahrt', kind: 'person', kinds: ['person'], startedAt: new Date(now - 10 * MIN).toISOString(), endedAt: null, nobodyHome: true, clip: { ms: 24000, bytes: 9e6 } });
  host.cameras.events.push({ id: 'e0000000000000a2', cameraId: id, camera: 'Einfahrt', kind: 'vehicle', kinds: ['vehicle'], startedAt: new Date(now - 26 * 3600000).toISOString(), endedAt: null, nobodyHome: false, clip: { ms: 11000, bytes: 3e6 } });
  const clips = (await call(app(GAST), 'GET', '/cameras/home/' + id + '/clips')).json;
  assert.deepEqual(clips.clips.map((c) => [c.kind, c.ms]), [['person', 24000]], 'only today');
  assert.match(clips.clips[0].clipUrl, /clip\.mp4$/);
  host.notifications.length = 0;
  const ev = { id: 'e0000000000000b1', cameraId: id, camera: 'Einfahrt', gatewayId: 7, kind: 'person', kinds: ['person'], phase: 'start', at: new Date().toISOString(), nobodyHome: true, clip: null };
  await host.cameraEvent(ev);
  let pushes = host.notifications.filter((n) => n.topic === 'kamera');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, 'Person an der Einfahrt');
  assert.match(pushes[0].body, /^Niemand ist zu Hause · \d\d:\d\d$/);
  assert.deepEqual(pushes[0].users, [GAST.id]);
  assert.equal(pushes[0].image && pushes[0].image.mime, 'image/jpeg');
  // within 5 minutes: no second push; a vehicle or the end: none at all
  await host.cameraEvent({ ...ev, id: 'e0000000000000b2' });
  await host.cameraEvent({ ...ev, id: 'e0000000000000b3', kind: 'vehicle', kinds: ['vehicle'] });
  assert.equal(host.notifications.filter((n) => n.topic === 'kamera').length, 1);
  clock.add(6 * MIN);
  await host.cameraEvent({ ...ev, id: 'e0000000000000b4', nobodyHome: false });
  pushes = host.notifications.filter((n) => n.topic === 'kamera');
  assert.equal(pushes.length, 2);
  assert.match(pushes[1].body, /^\d\d:\d\d$/);
  // push switched off for the camera
  await admin('PATCH', 'home/cameras/' + id, { push: false });
  clock.add(6 * MIN);
  await host.cameraEvent({ ...ev, id: 'e0000000000000b5' });
  assert.equal(host.notifications.filter((n) => n.topic === 'kamera').length, 2);
  void LENA;
}));

test('the pages: devices with the camera section, portal with the camera view, rights with the column', () => withDoor({ cameras: cams() }, async (host) => {
  const dev = (await host.render({ page: 'devices' })).html;
  for (const id of ['dr-hc-card', 'dr-hc-form', 'dr-hc-rec', 'dr-hc-today', 'DOOR_HOME']) assert.match(dev, new RegExp(id));
  assert.match(dev, /Verbinden und testen/);
  assert.match(dev, /höchstens einmal pro Kamera alle 5 Minuten/);
  const p = (await host.render({ view: 'portal', page: 'portal' })).html;
  for (const id of ['dr-pc-chips', 'dr-pc-still', 'dr-pc-full', 'dr-pc-sound', 'dr-pc-clips']) assert.match(p, new RegExp(id));
  assert.match(p, /alle 10 Sekunden ein neues Standbild/);
  const en = (await host.render({ page: 'devices', lang: 'en' })).html;
  assert.match(en, /Connect and test/);
}));

// ─── 1.7.0 ──────────────────────────────────────────────────────────────

test('1.7.0 the camera list: resolution and sound for the apps; no address or certificate choice for people', () => withDoor({ cameras: cams() }, async (host, ctx) => {
  const { admin, call } = ctx;
  const id = (await admin('POST', 'home/cameras', { gatewayId: 7, name: 'Einfahrt', host: '192.168.1.73', user: 'admin', password: 'geheim' })).json.camera.id;
  await admin('PUT', `rights/${GAST.id}`, { homeCameraRights: { [id]: true } });
  let c = (await call(app(GAST), 'GET', '/cameras/home')).json.cameras[0];
  assert.deepEqual([c.width, c.height, c.hasAudio, c.audio], [2560, 1440, true, false], 'sound off by default');
  assert.deepEqual([c.host, c.https, c.tlsInsecure], [undefined, undefined, undefined]);
  assert.deepEqual(c.prefs, { push: true });
  await admin('PATCH', 'home/cameras/' + id, { settings: { audio: true } });
  c = (await call(app(GAST), 'GET', '/cameras/home')).json.cameras[0];
  assert.equal(c.audio, true);
  host.cameras.cameras.find((x) => x.id === id).hasAudio = false;
  c = (await call(app(GAST), 'GET', '/cameras/home')).json.cameras[0];
  assert.deepEqual([c.audio, c.hasAudio], [false, false], 'sound switched on, but the stream has none: no "Ton"');
  delete host.cameras.cameras.find((x) => x.id === id).hasAudio;
  host.cameras.cameras.find((x) => x.id === id).width = 'x';
  c = (await call(app(GAST), 'GET', '/cameras/home')).json.cameras[0];
  assert.deepEqual([c.width, c.hasAudio, c.audio], [null, null, true], 'an older GateControl: unknown, the switch decides');
}));

test('1.7.0 HTTPS cameras: the certificate is checked, "Zertifikat nicht prüfen" only on the administrator\'s choice', () => withDoor({ cameras: { ...cams(), tlsHosts: ['192.168.1.80'] } }, async (host, ctx) => {
  const { admin } = ctx;
  const base = { gatewayId: 7, name: 'Hof', host: '192.168.1.80', onvifTls: true, user: 'admin', password: 'geheim' };
  assert.equal((await admin('POST', 'home/test', base)).json.code, 'cam_tls');
  const add = host.cameras.calls.filter((x) => x.name === 'test').pop();
  assert.equal(add.args.opts.tlsInsecure, undefined, 'never on its own');
  assert.equal((await admin('POST', 'home/cameras', base)).json.code, 'cam_tls');
  const r = await admin('POST', 'home/cameras', { ...base, tlsInsecure: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.camera.https, r.json.camera.tlsInsecure], [true, true]);
  const u = await admin('PATCH', 'home/cameras/' + r.json.camera.id, { tlsInsecure: false });
  assert.equal(u.json.camera.tlsInsecure, false);
  const dev = (await host.render({ page: 'devices' })).html;
  for (const id of ['dr-hc-tls', 'dr-hc-tlsins', 'dr-hc-tlsask', 'dr-hc-rtls']) assert.match(dev, new RegExp('id="' + id + '"'));
  assert.match(dev, /Zertifikat nicht prüfen/);
}));

test('1.7.0 each person switches the push off for a camera; the push carries "Ansehen"', () => withDoor({ cameras: cams() }, async (host, ctx) => {
  const { admin, call, clock } = ctx;
  const id = (await admin('POST', 'home/cameras', { gatewayId: 7, name: 'Einfahrt', host: '192.168.1.73', user: 'admin', password: 'geheim' })).json.camera.id;
  await admin('PUT', `rights/${GAST.id}`, { homeCameraRights: { [id]: true } });
  await admin('PUT', `rights/${LENA.id}`, { homeCameraRights: { [id]: true } });
  // only cameras one sees; read-only devices may not; push must be given
  assert.equal((await call(app(ANNA), 'PUT', '/cameras/home/' + id + '/prefs', { push: false })).json.code, 'not_found');
  assert.equal((await call(app(GAST), 'PUT', '/cameras/home/' + id + '/prefs', {})).json.code, 'invalid');
  assert.equal((await call(kiosk(GAST), 'PUT', '/cameras/home/' + id + '/prefs', { push: false })).json.code, 'read_only');
  const r = await call(app(GAST), 'PUT', '/cameras/home/' + id + '/prefs', { push: false });
  assert.deepEqual(r.json.prefs, { push: false });
  assert.deepEqual((await call(app(GAST), 'GET', '/cameras/home')).json.cameras[0].prefs, { push: false });
  assert.deepEqual((await call(app(LENA), 'GET', '/cameras/home')).json.cameras[0].prefs, { push: true }, 'only for that person');

  host.notifications.length = 0;
  const ev = { id: 'e0000000000000c1', cameraId: id, camera: 'Einfahrt', gatewayId: 7, kind: 'person', kinds: ['person'], phase: 'start', at: new Date().toISOString(), nobodyHome: false, clip: null };
  await host.cameraEvent(ev);
  let pushes = host.notifications.filter((n) => n.topic === 'kamera');
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].users, [LENA.id], 'Gast switched it off');
  assert.deepEqual(pushes[0].data.door, { type: 'home_camera_event', cameraId: id, eventId: 'e0000000000000c1' });
  assert.deepEqual(pushes[0].data.actions, [{ id: 'open', type: 'open_app_route', label: 'Ansehen', target: 'plg-gatecontrol-door' }]);
  // everybody off → no push, and the 5-minute slot is not used up
  await call(app(LENA), 'PUT', '/cameras/home/' + id + '/prefs', { push: false });
  clock.add(6 * MIN);
  await host.cameraEvent({ ...ev, id: 'e0000000000000c2' });
  assert.equal(host.notifications.filter((n) => n.topic === 'kamera').length, 1);
  await call(app(GAST), 'PUT', '/cameras/home/' + id + '/prefs', { push: true });
  await host.cameraEvent({ ...ev, id: 'e0000000000000c3' });
  pushes = host.notifications.filter((n) => n.topic === 'kamera');
  assert.deepEqual(pushes.map((p) => p.users), [[LENA.id], [GAST.id]]);
  // the camera goes (its prefs with it)
  assert.equal((await admin('DELETE', 'home/cameras/' + id)).status, 200);
  assert.equal((await call(app(GAST), 'PUT', '/cameras/home/' + id + '/prefs', { push: true })).json.code, 'not_found');
  // the portal: own push switch and GateControl's player
  const p = (await host.render({ view: 'portal', page: 'portal' })).html;
  assert.match(p, /id="dr-pc-mypush-in"/);
  assert.match(p, /Push bei Personen an mich/);
  assert.match(p, /<script src="\/plugins\/_shared\/camera-player\/camera-player\.js"><\/script>/);
  assert.doesNotMatch((await host.render({ page: 'rights' })).html, /camera-player/, 'only where the live picture is');
}));
