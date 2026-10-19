'use strict';

// Dreo heaters and air conditioners (Raumklima): the Dreo account, adding
// devices, the live state over the account's WebSocket, commands, the portal
// and the quick actions — against a fake Dreo cloud (helpers.fakeDreo).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fakeDreo, withHost, asAdmin, asPortal, ADA, BOB } = require('./helpers');
const dreoservice = require('../server/dreoservice');
const { DreoLink } = require('../server/dreo');
const model = require('../server/dreomodel');

const settle = () => new Promise((r) => setTimeout(r, 30));

/** Connect the fake Dreo account and add its heater (and air conditioner) for Ada. */
async function setup(host, dreo, { ac = false } = {}) {
  const r = await asAdmin(host, 'POST', '/dreo/connect', { email: dreo.email, password: dreo.password });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const heater = (await asAdmin(host, 'POST', '/devices', { transport: 'dreo', sn: 'HSH009S-1' })).json.device;
  await asAdmin(host, 'PUT', `/devices/${heater.id}/owners`, { user_ids: [ADA.id] });
  let air = null;
  if (ac) {
    air = (await asAdmin(host, 'POST', '/devices', { transport: 'dreo', sn: 'HAC006S-1', name: 'Klima oben' })).json.device;
    await asAdmin(host, 'PUT', `/devices/${air.id}/owners`, { user_ids: [ADA.id] });
  }
  return { heater, air };
}

/** Commands in tests need no 3 s waits for an acknowledgement that never comes. */
function quickAcks() {
  const orig = dreoservice.newLink;
  dreoservice.newLink = (gc) => new DreoLink({ open: (url) => gc.http.websocket(url, {}), ackMs: 40 });
  return () => { dreoservice.newLink = orig; };
}

test('the account: login at the account’s region, only the password’s MD5 is kept', () => {
  const dreo = fakeDreo({ region: 'NA' });
  return withHost({ dreo }, async (host) => {
    const bad = await asAdmin(host, 'POST', '/dreo/connect', { email: dreo.email, password: 'wrong' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'DREO_LOGIN_FAILED');
    const r = await asAdmin(host, 'POST', '/dreo/connect', { email: dreo.email, password: dreo.password });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.dreo.email, r.json.dreo.region, r.json.dreo.configured, r.json.dreo.supported], [dreo.email, 'NA', true, true]);
    const stored = JSON.stringify({ kv: [...host.kv.entries()], settings: host.settings });
    assert.ok(!stored.includes(dreo.password), 'never the plain password');
    const status = (await asAdmin(host, 'GET', '/dreo')).json.dreo;
    assert.ok(!('passwordMd5' in status) && !('token' in status), 'neither hash nor token leave the plugin');
  });
});

test('the device list: heaters and air conditioners can be added, other Dreo devices not', () => {
  const dreo = fakeDreo();
  return withHost({ dreo }, async (host) => {
    const before = await asAdmin(host, 'GET', '/dreo/devices');
    assert.equal(before.json.code, 'DREO_NOT_CONFIGURED');
    await asAdmin(host, 'POST', '/dreo/connect', { email: dreo.email, password: dreo.password });
    const list = (await asAdmin(host, 'GET', '/dreo/devices')).json.devices;
    assert.deepEqual(list.map((d) => [d.sn, d.model, d.kind]), [['HSH009S-1', 'DR-HSH009S', 'heater'], ['HAC006S-1', 'DR-HAC006S', 'ac'], ['HTF001S-1', 'DR-HTF001S', null]]);
    const fan = await asAdmin(host, 'POST', '/devices', { transport: 'dreo', sn: 'HTF001S-1' });
    assert.equal(fan.status, 400);
    assert.equal(fan.json.code, 'DREO_UNSUPPORTED');
    const add = await asAdmin(host, 'POST', '/devices', { transport: 'dreo', sn: 'HSH009S-1' });
    assert.deepEqual([add.json.device.name, add.json.device.vendor, add.json.device.kind, add.json.device.model], ['Bad', 'dreo', 'heater', 'DR-HSH009S']);
    assert.equal((await asAdmin(host, 'POST', '/devices', { transport: 'dreo', sn: 'HSH009S-1' })).json.code, 'MIDEA_DEVICE_EXISTS');
    assert.equal((await asAdmin(host, 'POST', '/devices', { transport: 'dreo', sn: 'nope' })).json.code, 'MIDEA_NOT_IN_CLOUD');
    const devices = (await asAdmin(host, 'GET', '/devices')).json.devices;
    assert.deepEqual(devices[0].caps.modes.map((m) => m.id), ['heat1', 'heat2', 'heat3', 'eco', 'fan']);
  });
});

test('heater state: °F → °C, heat level, swing angle, switches; live reports without polling', () => {
  const dreo = fakeDreo();
  return withHost({ dreo }, async (host) => {
    const { heater } = await setup(host, dreo);
    const st = (await asAdmin(host, 'GET', `/devices/${heater.id}/state`)).json.state;
    assert.deepEqual(st, { power: true, mode: 'heat2', targetTemp: 22, indoorTemp: 20, swing: '60', heating: true, childLock: false, sound: false });
    await settle();
    assert.equal(dreo.sockets.length, 1, 'one WebSocket for the account');
    assert.match(dreo.sockets[0].url, /^wss:\/\/wsb-eu\.dreo-tech\.com\/websocket\?accessToken=TOKEN-1&timestamp=\d+$/);
    const reads = dreo.stateReads;
    dreo.push('HSH009S-1', { poweron: false, temperature: 64 });
    await settle();
    const after = (await asAdmin(host, 'GET', `/devices/${heater.id}/state`)).json.state;
    assert.deepEqual([after.power, after.indoorTemp], [false, 17.8]);
    assert.equal(dreo.stateReads, reads, 'the report came over the socket — no REST read');
    dreo.offline('HSH009S-1');
    await settle();
    assert.deepEqual((await asAdmin(host, 'GET', `/devices/${heater.id}/state`)).json.state, { offline: true });
  });
});

test('heater commands: mode, target, swing and switches become the Dreo keys; anything else is refused', () => {
  const dreo = fakeDreo();
  return withHost({ dreo }, async (host) => {
    const { heater } = await setup(host, dreo);
    const set = (patch) => asAdmin(host, 'POST', `/devices/${heater.id}/state`, { patch });
    let r = await set({ mode: 'eco', targetTemp: 21 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(dreo.commands.pop(), { sn: 'HSH009S-1', params: { mode: 'eco', ecolevel: 70 } });
    assert.deepEqual([r.json.state.mode, r.json.state.targetTemp], ['eco', 21]);
    r = await set({ swing: 'off', childLock: true, sound: true });
    assert.deepEqual(dreo.commands.pop().params, { oscon: false, childlockon: true, muteon: false });
    r = await set({ swing: '120' });
    assert.deepEqual(dreo.commands.pop().params, { oscon: true, oscangle: 120 });
    r = await set({ power: false });
    assert.deepEqual(dreo.commands.pop().params, { poweron: false });
    r = await set({ mode: 'heat3' });
    assert.deepEqual(dreo.commands.pop().params, { mode: 'hotair', htalevel: 3, poweron: true }, 'a mode turns the heater on');
    assert.deepEqual([r.json.state.power, r.json.state.mode], [true, 'heat3']);
    for (const bad of [{ mode: 'heat9' }, { mode: 'cool' }, { turbo: true }, { targetTemp: 40 }, { swing: 'left' }, { window: true }, { power: 'on' }, []]) {
      const no = await set(bad);
      assert.equal(no.status, 400, JSON.stringify(bad));
      assert.equal(no.json.code, 'MIDEA_INVALID_PATCH');
    }
    assert.equal(dreo.commands.length, 0, 'nothing refused was sent');
  });
});

test('air conditioner: modes, the remote’s °C table, fan levels', () => {
  const dreo = fakeDreo();
  return withHost({ dreo }, async (host) => {
    const { air } = await setup(host, dreo, { ac: true });
    const st = (await asAdmin(host, 'GET', `/devices/${air.id}/state`)).json.state;
    assert.deepEqual(st, { power: false, mode: 'cool', targetTemp: 24, indoorTemp: 26.1, fanLevel: 'auto', swing: 'off', humidity: 55 });
    const r = await asAdmin(host, 'POST', `/devices/${air.id}/state`, { patch: { mode: 'dry', targetTemp: 18, fanLevel: 'high', swing: 'on' } });
    assert.equal(r.status, 200);
    assert.deepEqual(dreo.commands.pop().params, { mode: 2, poweron: true, templevel: 65, windlevel: 3, oscmode: 2 });
    assert.deepEqual([r.json.state.mode, r.json.state.targetTemp, r.json.state.fanLevel, r.json.state.swing], ['dry', 18, 'high', 'on']);
  });
});

test('no acknowledgement: the 24-hour remote lock hint; a rejection is reported', () => {
  const dreo = fakeDreo();
  const restore = quickAcks();
  return withHost({ dreo }, async (host) => {
    const { heater } = await setup(host, dreo);
    dreo.silent = true;
    let r = await asAdmin(host, 'POST', `/devices/${heater.id}/state`, { patch: { power: false } });
    assert.equal(r.status, 502);
    assert.equal(r.json.code, 'DREO_NO_REPLY');
    assert.match(r.json.error, /WLAN-Taste/);
    assert.equal(dreo.commands.length, 3, 'two retries');
    dreo.silent = false;
    dreo.reject = 500003;
    r = await asAdmin(host, 'POST', `/devices/${heater.id}/state`, { patch: { power: false } });
    assert.equal(r.json.code, 'DREO_REJECTED');
    assert.match(r.json.detail, /500003/);
  }).finally(restore);
});

test('an expired token: one new login (REST and WebSocket)', () => {
  const dreo = fakeDreo();
  return withHost({ dreo }, async (host) => {
    const { heater } = await setup(host, dreo);
    dreo.tokens.clear();
    dreoservice.reset();
    const st = (await asAdmin(host, 'GET', `/devices/${heater.id}/state`)).json.state;
    assert.equal(st.mode, 'heat2');
    const r = await asAdmin(host, 'POST', `/devices/${heater.id}/state`, { patch: { power: false } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(dreo.logins, 2);
  });
});

test('GateControl without WebSockets: Dreo is refused clearly, Midea is untouched', () => {
  const dreo = fakeDreo();
  return withHost({ dreo, websocket: false }, async (host) => {
    const r = await asAdmin(host, 'POST', '/dreo/connect', { email: dreo.email, password: dreo.password });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'DREO_NEEDS_UPDATE');
    assert.equal((await asAdmin(host, 'GET', '/dreo')).json.dreo.supported, false);
    assert.equal((await asAdmin(host, 'GET', '/status')).status, 200);
  });
});

test('portal, quick actions and widget of a Dreo heater (owner scope)', () => {
  const dreo = fakeDreo();
  return withHost({ dreo }, async (host) => {
    const { heater } = await setup(host, dreo);
    const mine = (await asPortal(host, ADA, 'GET', '/portal')).json.devices;
    assert.deepEqual([mine[0].vendor, mine[0].kind, mine[0].caps.swing.options.map((o) => o.id)], ['dreo', 'heater', ['off', 'osc', '60', '90', '120']]);
    assert.ok(!JSON.stringify(mine).includes('HSH009S-1'), 'no serial number in the portal');
    assert.deepEqual((await asPortal(host, BOB, 'GET', '/portal')).json.devices, []);
    assert.equal((await asPortal(host, BOB, 'POST', `/portal/devices/${heater.id}/state`, { patch: { power: false } })).status, 403);
    const p = await asPortal(host, ADA, 'POST', `/portal/devices/${heater.id}/state`, { patch: { mode: 'fan' } });
    assert.equal(p.status, 200);
    assert.deepEqual(dreo.commands.pop().params, { mode: 'coolair' });

    const qa = await host.quickActions(ADA);
    assert.equal(qa.length, 1);
    assert.deepEqual([qa[0].subtitle, qa[0].state], ['Lüften', 'on']);
    const ctl = qa[0].widget.controls;
    assert.deepEqual(ctl.map((c) => c.id), ['target', 'mode']);
    assert.deepEqual([ctl[0].min, ctl[0].max, ctl[0].step], [5, 35, 1]);
    assert.deepEqual(ctl[1].options.map((o) => o.id), ['heat1', 'heat2', 'heat3', 'eco', 'fan']);
    const run = await host.runQuickAction(ADA, qa[0].id, 'de', { control: 'mode', value: 'eco' });
    assert.equal(run.body.ok, true, JSON.stringify(run));
    assert.deepEqual(dreo.commands.pop().params, { mode: 'eco' });
    assert.match(run.body.widget.status, /^Eco \(Thermostat\) · Ziel 22 °C$/);
    const off = await host.runQuickAction(ADA, qa[0].id, 'de', { state: 'off' });
    assert.equal(off.body.state, 'off');
    assert.deepEqual(dreo.commands.pop().params, { poweron: false });
  });
});

test('notifications: a Dreo device that goes offline is reported like a Midea one', () => {
  const dreo = fakeDreo();
  return withHost({ dreo }, async (host) => {
    const { heater } = await setup(host, dreo);
    await host.tick();
    await settle();
    const obs = await dreoservice.tick(host.gc, [{ ...heater, enabled: true }]);
    assert.deepEqual(obs.map((o) => [o.device.id, o.online]), [[heater.id, true]]);
    dreo.offline('HSH009S-1');
    await settle();
    const down = await dreoservice.tick(host.gc, [{ ...heater, enabled: true }]);
    assert.deepEqual(down.map((o) => o.online), [false]);
  });
});

test('mapping: combo heater and oscmode firmware', () => {
  const t = (lang, k, p) => k + (p ? JSON.stringify(p) : '');
  const combo = { poweron: true, mode: 1, htamode: 2, htalevel: 4, ecolevel: 68, oscmode: 3 };
  assert.deepEqual(model.normalize('heater', 'DR-HSH016S', combo), { power: true, mode: 'eco', targetTemp: 20, indoorTemp: null, swing: '90' });
  const caps = model.capsOf('heater', 'DR-HSH016S', combo, t, 'de');
  assert.equal(caps.modes.length, 7, 'five heat levels + eco + fan');
  assert.deepEqual(model.toParams('heater', 'DR-HSH016S', combo, { mode: 'heat5', swing: 'off' }, caps), { mode: 1, htamode: 1, htalevel: 5, oscmode: 0 });
  assert.deepEqual(model.toParams('heater', 'DR-HSH016S', combo, { mode: 'fan' }, caps), { mode: 2 });
  assert.equal(model.kindOf('WH719S'), 'heater');
  assert.equal(model.kindOf('DR-HAP003S'), null);
});

test('mapping: a device that reports °C gets °C back', () => {
  const t = (lang, k) => k;
  const raw = { poweron: true, mode: 'eco', ecolevel: 21, temperature: 19 };
  const caps = model.capsOf('heater', 'DR-HSH009S', raw, t, 'de');
  assert.deepEqual(model.normalize('heater', 'DR-HSH009S', raw), { power: true, mode: 'eco', targetTemp: 21, indoorTemp: 19, swing: null });
  assert.deepEqual(model.toParams('heater', 'DR-HSH009S', raw, { targetTemp: 23 }, caps), { ecolevel: 23 });
  assert.deepEqual(model.toParams('heater', 'DR-HSH009S', { ...raw, ecolevel: 70 }, { targetTemp: 23 }, caps), { ecolevel: 73 });
});
