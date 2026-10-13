'use strict';

// Quick actions of the GateControl apps (hooks quickActions / runQuickAction):
// power on/off per air conditioner of the viewer — the portal's owner scope,
// cached state only in the list, at most 16.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeAc, fakeCloud, withHost, asAdmin, connectCloud, ADMIN, ADA, BOB } = require('./helpers');

const A = '153931628798542';
const B = '153931628798543';
// the list kicks background cloud refreshes (service.cachedState); let them land before the host closes
const settle = () => new Promise((r) => setTimeout(r, 300));
const direct = (host, user, id, lang = 'de') => host.plugin.runQuickAction({ user: { portal: true, loggedIn: true, app: true, ...user }, lang, id }, host.gc);

function twoDevices() {
  const devA = fakeAc({ power: true, mode: 'cool', targetTemp: 22 });
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

test('quick actions: a power toggle per own air conditioner, state from the cache only', () => {
  const { cloud } = twoDevices();
  return withHost({ cloud }, async (host) => {
    const { a, b } = await setup(host, cloud);
    await asAdmin(host, 'PUT', `/devices/${a}/owners`, { user_ids: [ADA.id] });
    await asAdmin(host, 'PUT', `/devices/${b}/owners`, { user_ids: [ADA.id, BOB.id] });
    await asAdmin(host, 'GET', `/devices/${a}/state`); // A has a cached state, B none yet
    const calls = cloud.calls.length;
    const ada = await host.quickActions(ADA);
    assert.equal(cloud.calls.length, calls, 'no cloud call inside the hook');
    assert.deepEqual(ada.map((x) => [x.id, x.title, x.subtitle, x.kind, x.state]), [
      [`ac:${a}`, 'Wohnzimmer', 'Kühlen · Ziel 22 °C', 'toggle', 'on'],
      [`ac:${b}`, 'Büro', 'Klimaanlage', 'toggle', null],
    ]);
    assert.ok(ada.every((x) => /^M/.test(x.icon) && x.confirm === false));
    assert.deepEqual((await host.quickActions(BOB, 'en')).map((x) => x.id), [`ac:${b}`]);
    assert.deepEqual(await host.quickActions(ADMIN), [], 'only what is assigned, like in the portal');
    assert.deepEqual(await host.quickActions({ ...ADA, loggedIn: false }), []);
    await asAdmin(host, 'PUT', `/devices/${b}`, { enabled: false });
    assert.deepEqual((await host.quickActions(ADA)).map((x) => x.id), [`ac:${a}`], 'a disabled device is no action');
    await settle();
  });
});

test('quick actions: at most 16, long names cut to 40', () => {
  const devices = {};
  const appliances = [];
  for (let i = 0; i < 18; i++) {
    const id = String(153931628798600 + i);
    devices[id] = fakeAc();
    appliances.push({ id, sn: `SN-${i}`, name: `AC ${i}`, type: '0xAC', onlineStatus: '1' });
  }
  const cloud = fakeCloud({ devices, appliances });
  return withHost({ cloud }, async (host) => {
    await connectCloud(host, cloud);
    for (const [i, x] of appliances.entries()) {
      const name = i === 0 ? 'Klimaanlage im Schlafzimmer ganz oben unter dem Dach' : x.name;
      const id = (await asAdmin(host, 'POST', '/devices', { transport: 'cloud', cloud_appliance_id: x.id, name })).json.device.id;
      await asAdmin(host, 'PUT', `/devices/${id}/owners`, { user_ids: [ADA.id] });
    }
    const list = await host.quickActions(ADA); // the mock host throws on more than 16 or a title over 40
    assert.equal(list.length, 16);
    assert.equal(list[0].title, 'Klimaanlage im Schlafzimmer ganz oben un');
    await settle();
  });
});

test('runQuickAction: switches over and reports the device\'s answer', () => {
  const { devA, devB, cloud } = twoDevices();
  return withHost({ cloud }, async (host) => {
    const { a, b } = await setup(host, cloud);
    await asAdmin(host, 'PUT', `/devices/${a}/owners`, { user_ids: [ADA.id] });
    await asAdmin(host, 'PUT', `/devices/${b}/owners`, { user_ids: [ADA.id] });
    await asAdmin(host, 'GET', `/devices/${a}/state`);
    let r = await host.runQuickAction(ADA, `ac:${a}`);
    assert.deepEqual(r, { status: 200, body: { ok: true, message: 'Wohnzimmer ausgeschaltet', state: 'off' } });
    assert.equal(devA.state.power, false);
    assert.equal((await host.quickActions(ADA))[0].state, 'off', 'the list follows at once');
    r = await host.runQuickAction(ADA, `ac:${a}`, 'en');
    assert.deepEqual(r.body, { ok: true, message: 'Wohnzimmer switched on', state: 'on' });
    assert.equal(devA.state.power, true);
    // B: no cached state yet → read from the device first, then switched over
    r = await host.runQuickAction(ADA, `ac:${b}`);
    assert.deepEqual(r.body, { ok: true, message: 'Büro eingeschaltet', state: 'on' });
    assert.equal(devB.state.power, true);
    await settle();
  });
});

test('runQuickAction: unknown ids and other people\'s devices change nothing; offline is a failed action', () => {
  const { devA, devB, cloud } = twoDevices();
  return withHost({ cloud }, async (host) => {
    const { a, b } = await setup(host, cloud);
    await asAdmin(host, 'PUT', `/devices/${a}/owners`, { user_ids: [ADA.id] });
    await asAdmin(host, 'PUT', `/devices/${b}/owners`, { user_ids: [BOB.id] });
    for (const id of [`ac:${b}`, 'ac:999', 'light:1', '']) assert.equal((await host.runQuickAction(ADA, id)).status, 404, id);
    for (const [user, id] of [[ADA, `ac:${b}`], [ADA, 'ac:0'], [ADA, 'x'], [{ ...BOB, loggedIn: false }, `ac:${b}`]]) {
      const out = await direct(host, user, id);
      assert.equal(out.ok, false, `${user.name} ${id}`);
      assert.equal(typeof out.message, 'string');
    }
    assert.equal((await direct(host, ADA, `ac:${b}`)).message, 'Dieses Gerät ist dir nicht zugewiesen');
    assert.equal(devB.state.power, false, 'Bob\'s device untouched');
    devA.down = true;
    const r = await host.runQuickAction(ADA, `ac:${a}`);
    assert.deepEqual(r, { status: 200, body: { ok: false, message: 'Gerät nicht erreichbar', state: null } });
    await settle();
  });
});
