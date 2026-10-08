'use strict';

// Owners and the portal section "Klimaanlage" in "Zuhause": a viewer only
// sees and controls the air conditioners assigned to them (portalVisible,
// list, state, control, Start tiles, search); the patch is whitelisted.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeAc, fakeCloud, withHost, asAdmin, asPortal, connectCloud, ADA, BOB } = require('./helpers');

const A = '153931628798542';
const B = '153931628798543';

function twoDevices() {
  const devA = fakeAc({ power: true, mode: 'cool', targetTemp: 22, indoorTemp: 25.5 });
  const devB = fakeAc();
  const cloud = fakeCloud({
    devices: { [A]: devA, [B]: devB },
    appliances: [{ id: A, sn: 'SN-A', name: 'Wohnzimmer', type: '0xAC', onlineStatus: '1' }, { id: B, sn: 'SN-B', name: 'Büro', type: '0xAC', onlineStatus: '1' }],
  });
  return { devA, devB, cloud };
}

async function setup(host, cloud) {
  await connectCloud(host, cloud);
  const a = (await asAdmin(host, 'POST', '/devices', { transport: 'cloud', cloud_appliance_id: A, name: 'Wohnzimmer' })).json.device.id;
  const b = (await asAdmin(host, 'POST', '/devices', { transport: 'cloud', cloud_appliance_id: B, name: 'Büro' })).json.device.id;
  return { a, b };
}

test('owners: validated before writing, replaced as a set, shown with names', () => {
  const { cloud } = twoDevices();
  return withHost({ cloud }, async (host) => {
    const { a } = await setup(host, cloud);
    assert.equal((await asAdmin(host, 'PUT', `/devices/${a}/owners`, { user_ids: 'x' })).json.code, 'MIDEA_USER_IDS_REQUIRED');
    assert.equal((await asAdmin(host, 'PUT', `/devices/${a}/owners`, { user_ids: [2, 99] })).json.code, 'MIDEA_OWNER_UNKNOWN_USER');
    assert.equal((await asAdmin(host, 'PUT', '/devices/999/owners', { user_ids: [2] })).json.code, 'MIDEA_DEVICE_NOT_FOUND');
    const r = await asAdmin(host, 'PUT', `/devices/${a}/owners`, { user_ids: [2, '3', 2, 0, null] });
    assert.deepEqual(r.json.owners, [{ id: 2, username: 'Ada', role: 'user' }, { id: 3, username: 'Bob', role: 'user' }]);
    await asAdmin(host, 'PUT', `/devices/${a}/owners`, { user_ids: [2] });
    const list = (await asAdmin(host, 'GET', '/devices')).json.devices;
    assert.deepEqual(list.find((d) => d.id === a).owners.map((o) => o.username), ['Ada']);
    // removing a device removes its owners
    await asAdmin(host, 'DELETE', `/devices/${a}`);
    assert.equal(await host.portalVisible(ADA, 'midea'), false);
  });
});

test('portal: only the viewer\'s own devices, portal-safe fields only', () => {
  const { cloud } = twoDevices();
  return withHost({ cloud }, async (host) => {
    const { a, b } = await setup(host, cloud);
    await asAdmin(host, 'PUT', `/devices/${a}/owners`, { user_ids: [ADA.id] });
    assert.equal(await host.portalVisible(ADA, 'midea'), true);
    assert.equal(await host.portalVisible(BOB, 'midea'), false);
    const mine = (await asPortal(host, ADA, 'GET', '/portal')).json.devices;
    assert.deepEqual(mine.map((d) => [d.id, d.name, d.transport]), [[a, 'Wohnzimmer', 'cloud']]);
    assert.deepEqual(Object.keys(mine[0]).sort(), ['id', 'name', 'state', 'transport'], 'no cloud ids, targets or keys');
    assert.equal(mine[0].state.indoorTemp, 25.5);
    assert.deepEqual((await asPortal(host, BOB, 'GET', '/portal')).json.devices, []);
    assert.equal((await asPortal(host, ADA, 'GET', `/portal/devices/${b}/state`)).status, 403);
    assert.equal((await asPortal(host, ADA, 'GET', `/portal/devices/${a}/state`)).json.state.targetTemp, 22);
    // the admin API stays closed to the viewer
    assert.equal((await asPortal(host, ADA, 'GET', '/devices')).status, 403);
  });
});

test('portal control: owner only, whitelisted patch, offline reported', () => {
  const { devA, cloud } = twoDevices();
  return withHost({ cloud }, async (host) => {
    const { a, b } = await setup(host, cloud);
    await asAdmin(host, 'PUT', `/devices/${a}/owners`, { user_ids: [ADA.id] });
    const ok = await asPortal(host, ADA, 'POST', `/portal/devices/${a}/state`, { patch: { targetTemp: 19, mode: 'heat', fanSpeed: 40 } });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.json.state.targetTemp, ok.json.state.mode, ok.json.state.fanSpeed], [19, 'heat', 40]);
    assert.deepEqual([devA.state.targetTemp, devA.state.mode], [19, 'heat']);
    assert.equal((await asPortal(host, ADA, 'POST', `/portal/devices/${b}/state`, { patch: { power: true } })).status, 403);
    for (const patch of [{}, { power: 'on' }, { targetTemp: 40 }, { targetTemp: true }, { mode: 'turbo' }, { fanSpeed: 55 }, { swingV: true }, null]) {
      const r = await asPortal(host, ADA, 'POST', `/portal/devices/${a}/state`, { patch });
      assert.equal(r.status, 400, JSON.stringify(patch));
      assert.equal(r.json.code, 'MIDEA_INVALID_PATCH');
    }
    devA.down = true;
    const off = await asPortal(host, ADA, 'POST', `/portal/devices/${a}/state`, { patch: { power: false } });
    assert.deepEqual([off.status, off.json.code], [502, 'MIDEA_OFFLINE']);
  });
});

test('Start tiles and search: own devices, cached state only', () => {
  const { cloud } = twoDevices();
  return withHost({ cloud }, async (host) => {
    const { a, b } = await setup(host, cloud);
    await asAdmin(host, 'PUT', `/devices/${a}/owners`, { user_ids: [ADA.id] });
    await asAdmin(host, 'PUT', `/devices/${b}/owners`, { user_ids: [ADA.id] });
    await asAdmin(host, 'GET', `/devices/${a}/state`); // A has a cached state, B none yet
    const calls = cloud.calls.length;
    const tiles = await host.portalTiles(ADA);
    assert.deepEqual(tiles.map((t) => [t.section, t.title, t.value, t.state]), [
      ['midea', 'Wohnzimmer', 'Kühlen · Ziel 22 °C', 'on'],
      ['midea', 'Büro', '–', null],
    ]);
    assert.match(tiles[0].icon, /^M/);
    assert.equal((await host.portalTiles(ADA, 'en'))[0].value, 'Cool · Target 22 °C');
    assert.deepEqual(await host.portalTiles(BOB), []);
    const hits = await host.portalSearch(ADA, 'wohn');
    assert.deepEqual(hits.map((h) => [h.title, h.section]), [['Wohnzimmer', 'midea']]);
    assert.deepEqual(await host.portalSearch(BOB, 'wohn'), []);
    assert.deepEqual(await host.portalSearch(ADA, 'w'), []);
    // the tile of B kicked one background refresh (no cloud call inside the hook's answer)
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(cloud.calls.length > calls);
    assert.equal((await host.portalTiles(ADA))[1].state, 'off', 'B has a cached state now');
  });
});
