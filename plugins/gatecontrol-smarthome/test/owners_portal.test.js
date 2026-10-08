'use strict';

// Owners and the portal tab "Zuhause": ported from GateControl
// tests/smarthome_owners.test.js, smarthome_owners_api.test.js and
// smarthome_portal_api.test.js (built-in Smart Home). Requests run with the
// requesting user's rights: a portal viewer sees and controls only what an
// administrator assigned to them and never reaches the admin API.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDeconz, withHost, asAdmin, asPortal, connected, ADA, BOB } = require('./helpers');

test('owners: set, validate before writing, replace atomically', () => withHost({ gateways: [fakeDeconz()] }, async (host) => {
  const { by } = await connected(host);
  const lamp = by('Stehlampe').id;
  let r = await asAdmin(host, 'PUT', `/resources/${lamp}/owners`, { userIds: [2, 3, 2, '3'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.owners, [{ id: 2, username: 'Ada' }, { id: 3, username: 'Bob' }]);
  r = await asAdmin(host, 'PUT', `/resources/${lamp}/owners`, { userIds: [2, 99] });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'SMARTHOME_OWNER_UNKNOWN_USER');
  assert.deepEqual((await host.gc.db.query('SELECT user_id FROM resource_owners ORDER BY user_id')).rows.map((x) => x.user_id), [2, 3], 'nothing written');
  r = await asAdmin(host, 'PUT', `/resources/${lamp}/owners`, { userIds: 'x' });
  assert.equal(r.json.code, 'SMARTHOME_USER_IDS_REQUIRED');
  r = await asAdmin(host, 'PUT', `/resources/${by('Wohnzimmer · Abend').id}/owners`, { userIds: [2] });
  assert.equal(r.json.code, 'SMARTHOME_NOT_ASSIGNABLE');
  r = await asAdmin(host, 'PUT', `/resources/${by('Smart Switch').id}/owners`, { userIds: [2] });
  assert.equal(r.json.code, 'SMARTHOME_NOT_ASSIGNABLE');
  r = await asAdmin(host, 'PUT', '/resources/9999/owners', { userIds: [] });
  assert.equal(r.status, 404);
  r = await asAdmin(host, 'PUT', `/resources/${lamp}/owners`, { userIds: [] });
  assert.deepEqual(r.json.owners, []);
}));

test('resource list shows owners; a scene shows its group\'s owners (inherited, read-only)', () => withHost({ gateways: [fakeDeconz()] }, async (host) => {
  const { by } = await connected(host);
  await asAdmin(host, 'PUT', `/resources/${by('Wohnzimmer').id}/owners`, { userIds: [2] });
  const res = (await asAdmin(host, 'GET', '/resources')).json.resources;
  assert.deepEqual(res.find((x) => x.name === 'Wohnzimmer').owners, [{ id: 2, username: 'Ada' }]);
  assert.deepEqual(res.find((x) => x.name === 'Wohnzimmer · Abend').owners, [{ id: 2, username: 'Ada' }]);
  assert.deepEqual(res.find((x) => x.name === 'Stehlampe').owners, []);
  const users = (await asAdmin(host, 'GET', '/users')).json.users;
  assert.deepEqual(users.map((u) => u.username), ['admin', 'Ada', 'Bob']);
}));

test('portal: only owned, enabled devices and sensors, redacted; switches stay out', () => withHost({ gateways: [fakeDeconz()] }, async (host) => {
  const { by } = await connected(host);
  for (const n of ['Stehlampe', 'Wohnzimmer', 'Temp', 'Fensterkontakt']) await asAdmin(host, 'PUT', `/resources/${by(n).id}/owners`, { userIds: [2] });
  await asAdmin(host, 'PUT', `/resources/${by('Poolpumpe').id}/owners`, { userIds: [3] });
  const r = await asPortal(host, ADA, 'GET', '/portal');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.devices.map((d) => d.name).sort(), ['Stehlampe', 'Wohnzimmer', 'Wohnzimmer · Abend']);
  assert.deepEqual(r.json.sensors.map((d) => d.name).sort(), ['Fensterkontakt', 'Temp']);
  const lamp = r.json.devices.find((d) => d.name === 'Stehlampe');
  assert.deepEqual(Object.keys(lamp).sort(), ['capabilities', 'id', 'kind', 'name', 'state']);
  assert.deepEqual(lamp.state, { on: true, reachable: true, bri: 100 });
  assert.deepEqual((await asPortal(host, BOB, 'GET', '/portal')).json.devices.map((d) => d.name), ['Poolpumpe']);
  assert.deepEqual((await asPortal(host, { id: 7, name: 'Eve', role: 'user' }, 'GET', '/portal')).json, { ok: true, devices: [], sensors: [] });
}));

test('portal: control needs ownership (scenes of an owned group included); sensors and bad patches refused', () => {
  const gw = fakeDeconz();
  return withHost({ gateways: [gw] }, async (host) => {
    const { by } = await connected(host);
    await asAdmin(host, 'PUT', `/resources/${by('Stehlampe').id}/owners`, { userIds: [2] });
    await asAdmin(host, 'PUT', `/resources/${by('Wohnzimmer').id}/owners`, { userIds: [2] });
    await asAdmin(host, 'PUT', `/resources/${by('Temp').id}/owners`, { userIds: [2] });
    let r = await asPortal(host, ADA, 'POST', `/portal/resources/${by('Stehlampe').id}/state`, { patch: { on: false, bri: 20, ct: 400 } });
    assert.equal(r.status, 200);
    assert.deepEqual(gw.calls.at(-1).body, { on: false, bri: 51 }, 'portal patch: on + bri only');
    r = await asPortal(host, ADA, 'POST', `/portal/resources/${by('Wohnzimmer · Abend').id}/state`, { patch: {} });
    assert.equal(r.status, 200);
    assert.equal(gw.calls.at(-1).path, '/api/KEY1234567/groups/8/scenes/2/recall');
    r = await asPortal(host, BOB, 'POST', `/portal/resources/${by('Stehlampe').id}/state`, { patch: { on: true } });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'SMARTHOME_NOT_OWNER');
    r = await asPortal(host, ADA, 'POST', `/portal/resources/${by('Temp').id}/state`, { patch: { on: true } });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'SMARTHOME_NOT_CONTROLLABLE');
    for (const patch of [{ on: 'yes' }, { bri: 101 }, { bri: '50' }]) {
      r = await asPortal(host, ADA, 'POST', `/portal/resources/${by('Stehlampe').id}/state`, { patch });
      assert.equal(r.json.code, 'SMARTHOME_INVALID_PATCH', JSON.stringify(patch));
    }
    r = await asPortal(host, ADA, 'POST', '/portal/resources/abc/state', { patch: {} });
    assert.equal(r.status, 404);
  });
});

test('a portal viewer never reaches the admin API, not even an administrator in the portal', () => withHost({ gateways: [fakeDeconz()] }, async (host) => {
  await connected(host);
  for (const [m, p] of [['GET', '/gateways'], ['GET', '/resources'], ['POST', '/gateways/1/sync'], ['PUT', '/resources/1/owners'], ['GET', '/rules']]) {
    const r = await asPortal(host, { id: 1, name: 'admin', role: 'admin' }, m, p, {});
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.json.code, 'FORBIDDEN');
  }
  const member = await host.request({ path: '/gateways', user: { id: 2, name: 'Ada', role: 'user' } });
  assert.equal(member.status, 403);
  assert.equal((await asAdmin(host, 'GET', '/nope')).status, 404);
}));

test('the portal tab is shown only to viewers with assigned devices', () => withHost({ gateways: [fakeDeconz()] }, async (host) => {
  const { by } = await connected(host);
  assert.equal(await host.portalVisible(ADA), false);
  await asAdmin(host, 'PUT', `/resources/${by('Temp').id}/owners`, { userIds: [2] });
  assert.equal(await host.portalVisible(ADA), true);
  assert.equal(await host.portalVisible(BOB), false);
}));

test('owners of users that no longer exist are not shown', () => withHost({ gateways: [fakeDeconz()] }, async (host) => {
  const { by } = await connected(host);
  await host.gc.db.run('INSERT INTO resource_owners (resource_id, user_id) VALUES (?, 42)', [by('Stehlampe').id]);
  const res = (await asAdmin(host, 'GET', '/resources')).json.resources;
  assert.deepEqual(res.find((x) => x.name === 'Stehlampe').owners, []);
}));

test('portal Start tiles and search: only the viewer\'s own devices and sensors, declarative', () => withHost({ gateways: [fakeDeconz()] }, async (host) => {
  const { by } = await connected(host);
  for (const n of ['Stehlampe', 'Wohnzimmer', 'Temp', 'Fensterkontakt']) await asAdmin(host, 'PUT', `/resources/${by(n).id}/owners`, { userIds: [2] });
  await asAdmin(host, 'PUT', `/resources/${by('Poolpumpe').id}/owners`, { userIds: [3] });
  const tiles = await host.portalTiles(ADA);
  assert.deepEqual(tiles.map((x) => [x.title, x.value, x.unit || null, x.state, x.section]).sort(), [
    ['Fensterkontakt', 'offen', null, 'warn', 'smarthome'],
    ['Stehlampe', 'An · 100 %', null, 'on', 'smarthome'],
    ['Temp', '21,5', '°C', null, 'smarthome'],
    ['Wohnzimmer', 'An', null, 'on', 'smarthome'],
  ]);
  assert.ok(tiles.every((x) => /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,600}$/.test(x.icon)), 'icons are SVG paths the host accepts');
  assert.ok(!tiles.some((x) => x.title === 'Wohnzimmer · Abend'), 'scenes are no tiles');
  assert.equal((await host.portalTiles(ADA, 'en')).find((x) => x.title === 'Temp').value, '21.5');
  assert.deepEqual((await host.portalTiles(BOB)).map((x) => x.title), ['Poolpumpe']);
  assert.deepEqual(await host.portalTiles({ id: 9, name: 'Eve', role: 'user' }), []);
  const hits = await host.portalSearch(ADA, 'wohn');
  assert.deepEqual(hits, [{ title: 'Wohnzimmer', subtitle: 'Gruppe', section: 'smarthome' }, { title: 'Wohnzimmer · Abend', subtitle: 'Szene', section: 'smarthome' }]);
  assert.deepEqual(await host.portalSearch(BOB, 'wohn'), [], 'never another person\'s devices');
  assert.deepEqual(await host.portalSearch(ADA, 'w'), []);
  assert.equal(await host.portalVisible(ADA, 'smarthome'), true);
}));
