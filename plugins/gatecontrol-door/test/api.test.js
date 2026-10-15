'use strict';

// API shapes for the app (README "App API"), history visibility, the admin
// API (only administrators on the admin pages; secrets never sent back;
// validation), retention, the pages and the portal tab render.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withDoor, ringLogin, app, portal, ADMIN, ANNA, MARC, LENA, GAST, BRIDGE_TOKEN, MIN, HOUR } = require('./helpers');

test('GET me: exactly the documented shape', () => withDoor({}, async (host, { call, lockId }) => {
  const me = (await call(app(MARC), 'GET', '/me')).json;
  assert.deepEqual(Object.keys(me).sort(), ['cameras', 'locks', 'me', 'ok', 'ring', 'serverTime']);
  assert.deepEqual(me.me, { userId: MARC.id, name: 'Marc', canAct: true, autoUnlock: false, window: null, windowOpen: true });
  assert.deepEqual(me.locks[0], {
    id: lockId, name: 'Haustür', type: 'smartlock', right: 'lock', actions: ['lock', 'unlock'], blocked: null, confirm: ['unlock'], doorSensor: true,
    state: { lock: 'locked', door: 'closed', batteryCritical: false, batteryPercent: 80, batteryCharging: false, reachable: true, updatedAt: '2026-10-14T08:00:00Z' },
  });
  assert.deepEqual(me.locks[1].actions, [], 'Marc may only view the opener');
  assert.deepEqual(me.ring, { connected: false, broken: false });
  const r = await call(app(MARC), 'POST', `/locks/${lockId}/unlock`);
  assert.deepEqual(Object.keys(r.json).sort(), ['lock', 'message', 'ok']);
  assert.equal(r.json.message, 'Haustür aufgesperrt');
  assert.equal(r.json.lock.state.lock, 'unlocked');
  assert.equal((await call(app(MARC), 'POST', `/locks/${lockId}/explode`)).status, 404);
  assert.equal((await call(app(MARC), 'GET', '/nothing')).status, 404);
  assert.deepEqual((await call(app(MARC), 'GET', '/me', null, {})).json.locks.length, 2);
  const en = await host.request({ method: 'POST', path: `/locks/${lockId}/open`, user: app(MARC), lang: 'en' });
  assert.deepEqual([en.json.code, en.json.error], ['no_right', 'You do not have the right to do this.']);
}));

test('history: own events; everything of locks with `open`; rings of viewable cameras; admins all; cursor paging', () => withDoor({}, async (host, ctx) => {
  const { call, lockId, cloud, admin } = ctx;
  await call(app(MARC), 'POST', `/locks/${lockId}/unlock`);
  await call(app(MARC), 'POST', `/locks/${lockId}/lock`);
  await call(app(LENA), 'POST', `/locks/${lockId}/unlock`); // refused
  await ringLogin(ctx);
  const cams = (await admin('GET', 'status')).json.cameras;
  await admin('PATCH', `cameras/${cams.find((c) => c.doorbell).id}`, { lockId });
  cloud.ring.active = [{ id_str: '9', doorbot_id: 111, kind: 'ding', now: Date.now() / 1000 }];
  await host.tick();
  const of = async (u) => (await call(app(u), 'GET', '/history')).json.items.map((x) => `${x.kind}:${x.userName || '-'}:${x.result}`);
  assert.deepEqual(await of(ANNA), ['ding:-:ok', 'action:Lena:refused', 'action:Marc:ok', 'action:Marc:ok']);
  assert.deepEqual(await of(MARC), ['ding:-:ok', 'action:Marc:ok', 'action:Marc:ok']);
  assert.deepEqual(await of(LENA), ['ding:-:ok', 'action:Lena:refused']);
  assert.deepEqual(await of(GAST), []);
  assert.equal((await call(portal(ADMIN), 'GET', '/history')).json.items.length, 4);
  const p1 = (await call(app(ANNA), 'GET', '/history', null, { limit: '2' })).json;
  assert.equal(p1.items.length, 2);
  const p2 = (await call(app(ANNA), 'GET', '/history', null, { limit: '2', cursor: String(p1.nextCursor) })).json;
  assert.deepEqual([p2.items.length, p2.nextCursor], [2, null]);
  assert.equal((await call(app(ANNA), 'GET', '/history', null, { limit: '500' })).json.code, 'invalid');
  const item = p1.items[1];
  assert.deepEqual(Object.keys(item).sort(), ['action', 'at', 'caller', 'cameraId', 'cameraName', 'hasImage', 'id', 'kind', 'lockId', 'lockName', 'reason', 'reasonText', 'result', 'userId', 'userName', 'via']);
  assert.deepEqual([item.reason, item.reasonText], ['no_right', 'keine Berechtigung']);
}));

test('admin API: administrators on the admin pages only; secrets never returned; validation', () => withDoor({}, async (host, { call, admin, lockId }) => {
  for (const u of [app(ADMIN), portal(ADMIN), { ...ANNA }, app(ANNA)]) assert.equal((await call(u, 'GET', '/admin/status')).status, 403);
  const st = (await admin('GET', 'status')).json;
  assert.ok(!JSON.stringify(st).includes(BRIDGE_TOKEN));
  assert.deepEqual(st.bridges, [{ id: 1, name: 'Flur', targetIndex: 0, targetLabel: 'Bridge Flur', hasToken: true }]);
  assert.deepEqual(st.targets, [{ index: 0, label: 'Bridge Flur' }]);
  assert.equal((await admin('POST', 'bridges', { name: 'X', targetIndex: 3, token: 'abcdef' })).json.code, 'no_target');
  assert.equal((await admin('POST', 'bridges', { name: 'X', targetIndex: 0, token: 'a b' })).json.code, 'invalid');
  assert.equal((await admin('DELETE', 'bridges/1')).status, 409, 'still in use');
  assert.deepEqual((await admin('GET', 'bridges/1/devices')).json.devices.map((d) => [d.nukiId, d.type]), [['1001', 'smartlock'], ['2002', 'opener']]);
  for (const bad of [{ name: '', source: 'bridge', bridgeId: 1, nukiId: '1', deviceType: 0, actions: ['lock'] },
    { name: 'A', source: 'cloud', nukiId: '1', deviceType: 0, actions: ['lock'] }, { name: 'A', source: 'bridge', bridgeId: 9, nukiId: '1', deviceType: 0, actions: ['lock'] },
    { name: 'A', source: 'bridge', bridgeId: 1, nukiId: 'x', deviceType: 0, actions: ['lock'] }, { name: 'A', source: 'bridge', bridgeId: 1, nukiId: '1', deviceType: 1, actions: ['lock'] },
    { name: 'A', source: 'bridge', bridgeId: 1, nukiId: '1', deviceType: 2, actions: ['lock'] }, { name: 'A', source: 'bridge', bridgeId: 1, nukiId: '1', deviceType: 0, actions: [] },
    { name: 'A', source: 'bridge', bridgeId: 1, nukiId: '1', deviceType: 0, actions: ['lock'], nightCheck: '25:00' }]) {
    assert.equal((await admin('POST', 'locks', bad)).json.code, 'invalid', JSON.stringify(bad));
  }
  assert.equal((await admin('PUT', `rights/${ANNA.id}`, { locks: { [lockId]: 'admin' } })).json.code, 'invalid');
  assert.equal((await admin('PUT', 'rights/99', { locks: {} })).status, 404);
  assert.equal((await admin('PUT', 'settings', { mediaDays: 31 })).json.code, 'invalid');
  assert.equal((await admin('PUT', 'settings', { timezone: 'Mars/Base' })).json.code, 'invalid');
  assert.equal((await admin('PUT', 'settings', { mediaDays: 3, notifyLang: 'en' })).json.config.mediaDays, 3);
  // new bridge token: stored, never shown
  await admin('PATCH', 'bridges/1', { token: 'NEWtoken99' });
  assert.equal(host.settings['bridge.1.token'], 'NEWtoken99');
  assert.ok(host.secrets.has('bridge.1.token'));
  // deleting a lock removes its rights and its state
  assert.equal((await admin('DELETE', `locks/${lockId}`)).status, 200);
  assert.deepEqual((await call(app(ANNA), 'GET', '/me')).json.locks.map((l) => l.name), ['Hoftor']);
  assert.equal((await admin('GET', 'rights')).json.rights[ANNA.id][lockId], undefined);
}));

test('retention: history after 90 days, pictures after the configured days', () => withDoor({}, async (host, { call, lockId, clock }) => {
  await call(app(ANNA), 'POST', `/locks/${lockId}/lock`);
  clock.add(89 * 24 * HOUR);
  await host.tick();
  assert.equal((await call(app(ANNA), 'GET', '/history')).json.items.length, 1);
  clock.add(2 * 24 * HOUR);
  await host.tick();
  assert.equal((await call(app(ANNA), 'GET', '/history')).json.items.length, 0);
  void MIN;
}));

test('pages and portal tab render (DE/EN); no secrets in the HTML', () => withDoor({}, async (host) => {
  for (const page of ['devices', 'rights', 'history', 'settings']) {
    const de = (await host.render({ page })).html;
    assert.match(de, /<script>window\.DOOR_CTX=/);
    assert.ok(!de.includes(BRIDGE_TOKEN));
    assert.ok(!/\{\{t:/.test(de), page);
  }
  assert.match((await host.render({ page: 'devices' })).html, /inoffiziell, ohne Gewähr/);
  assert.match((await host.render({ page: 'devices', lang: 'en' })).html, /unofficial, no warranty/);
  assert.match((await host.render({ view: 'portal', user: portal(ANNA) })).html, /Schlösser/);
  const tiles = await host.portalTiles(ANNA);
  assert.deepEqual(tiles.map((t) => [t.title, t.value, t.state]), [['Haustür', 'Zugesperrt', 'good'], ['Hoftor', 'Bereit', 'off']]);
  assert.deepEqual(await host.portalTiles(GAST), []);
}));
