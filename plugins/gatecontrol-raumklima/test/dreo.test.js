'use strict';

// Dreo heaters and air conditioners (Raumklima): the Dreo account, adding
// devices, the live state over the account's WebSocket, commands, the portal
// and the quick actions — against a fake Dreo cloud (helpers.fakeDreo).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fakeDreo, withHost, asAdmin, asPortal, connectDreo, lineOf, ADA, BOB } = require('./helpers');
const { md5 } = require('../server/dreo');
const dreoservice = require('../server/dreoservice');
const { DreoLink } = require('../server/dreo');
const model = require('../server/dreomodel');

const settle = () => new Promise((r) => setTimeout(r, 30));

/** Connect the fake Dreo account (its heater — and air conditioner — appear by themselves, 2.1.0) and give them to Ada. */
async function setup(host, dreo, { ac = false } = {}) {
  if (!ac) dreo.devices = dreo.devices.filter((x) => x.sn !== 'HAC006S-1');
  const lines = await connectDreo(host, dreo);
  assert.equal(lineOf(lines, 'dreo').tone, 'ok', JSON.stringify(lines));
  const all = (await asAdmin(host, 'GET', '/devices')).json.devices;
  const bySn = (sn) => all.find((d) => d.device_sn === 'dreo-' + sn) || null;
  const heater = bySn('HSH009S-1');
  await asAdmin(host, 'PUT', `/devices/${heater.id}/owners`, { user_ids: [ADA.id] });
  const air = ac ? bySn('HAC006S-1') : null;
  if (air) await asAdmin(host, 'PUT', `/devices/${air.id}/owners`, { user_ids: [ADA.id] });
  return { heater, air };
}

/** Commands in tests need no 3 s waits for an acknowledgement that never comes. */
function quickAcks() {
  const orig = dreoservice.newLink;
  dreoservice.newLink = (gc) => new DreoLink({ open: (url) => gc.http.websocket(url, {}), ackMs: 40 });
  return () => { dreoservice.newLink = orig; };
}

test('the account on the settings page: login at the account’s region, only the password’s MD5 is kept', () => {
  const dreo = fakeDreo({ region: 'NA' });
  return withHost({ dreo }, async (host) => {
    const bad = lineOf(await connectDreo(host, dreo, 'wrong'), 'dreo');
    assert.equal(bad.tone, 'error');
    const lines = await connectDreo(host, dreo);
    assert.equal(lineOf(lines, 'dreo').tone, 'ok');
    assert.match(lineOf(lines, 'dreo').text, /Region US/);
    assert.equal(host.settings['dreo.password'], md5(dreo.password), 'the plain password is replaced by its MD5');
    const r = await asAdmin(host, 'GET', '/dreo');
    assert.deepEqual([r.json.dreo.email, r.json.dreo.region, r.json.dreo.configured, r.json.dreo.supported], [dreo.email, 'NA', true, true]);
    // the account removed from the settings: the token is gone
    await host.saveSettings({ 'dreo.email': '' });
    assert.equal(lineOf(await host.settingsStatus(), 'dreo').tone, 'info');
    assert.equal(await host.gc.settings.get('dreo.token'), null);
    await connectDreo(host, dreo);
    const stored = JSON.stringify({ kv: [...host.kv.entries()], settings: host.settings });
    assert.ok(!stored.includes(dreo.password), 'never the plain password');
    const status = (await asAdmin(host, 'GET', '/dreo')).json.dreo;
    assert.ok(!('passwordMd5' in status) && !('token' in status), 'neither hash nor token leave the plugin');
  });
});

test('the device list: the account’s heaters and air conditioners appear by themselves, other Dreo devices not', () => {
  const dreo = fakeDreo();
  return withHost({ dreo }, async (host) => {
    const before = await asAdmin(host, 'GET', '/dreo/devices');
    assert.equal(before.json.code, 'DREO_NOT_CONFIGURED');
    const lines = await connectDreo(host, dreo);
    const list = (await asAdmin(host, 'GET', '/dreo/devices')).json.devices;
    assert.deepEqual(list.map((d) => [d.sn, d.model, d.kind]), [['HSH009S-1', 'DR-HSH009S', 'heater'], ['HAC006S-1', 'DR-HAC006S', 'ac'], ['HTF001S-1', 'DR-HTF001S', null]]);
    // 2.1.0: saving the account added the heater and the air conditioner (names and models of the Dreo app)
    let devices = (await asAdmin(host, 'GET', '/devices')).json.devices;
    assert.deepEqual(devices.map((d) => [d.device_sn, d.name, d.vendor, d.kind, d.model]),
      [['dreo-HSH009S-1', 'Bad', 'dreo', 'heater', 'DR-HSH009S'], ['dreo-HAC006S-1', 'Schlafzimmer', 'dreo', 'ac', 'DR-HAC006S']]);
    assert.deepEqual(devices[0].caps.modes.map((m) => m.id), ['heat1', 'heat2', 'heat3', 'eco', 'fan']);
    // the settings say what the account holds
    const found = lines.filter((l) => l.group === 'dreo').map((l) => l.text).join(' | ');
    assert.match(found, /Bad \(DR-HSH009S\), Schlafzimmer \(DR-HAC006S\)/);
    assert.match(found, /nicht unterstützt: DR-HTF001S/);
    // by hand: the fan is refused, an added one is refused twice, an unknown one is not in the account
    const fan = await asAdmin(host, 'POST', '/devices', { transport: 'dreo', sn: 'HTF001S-1' });
    assert.deepEqual([fan.status, fan.json.code], [400, 'DREO_UNSUPPORTED']);
    assert.equal((await asAdmin(host, 'POST', '/devices', { transport: 'dreo', sn: 'HSH009S-1' })).json.code, 'MIDEA_DEVICE_EXISTS');
    assert.equal((await asAdmin(host, 'POST', '/devices', { transport: 'dreo', sn: 'nope' })).json.code, 'MIDEA_NOT_IN_CLOUD');
    // removed by hand: it does not come back with the next look into the account …
    await asAdmin(host, 'DELETE', `/devices/${devices[1].id}`);
    await host.saveSettings({ 'dreo.email': dreo.email });
    await require('../server/dreoimport').run(host.gc);
    devices = (await asAdmin(host, 'GET', '/devices')).json.devices;
    assert.deepEqual(devices.map((d) => d.device_sn), ['dreo-HSH009S-1']);
    // … until it is added again by hand
    const again = await asAdmin(host, 'POST', '/devices', { transport: 'dreo', sn: 'HAC006S-1' });
    assert.equal(again.json.device.name, 'Schlafzimmer');
    // a device added later in the Dreo app appears with the hourly look (background)
    dreo.devices.push({ sn: 'HSH034S-1', deviceName: 'Wohnzimmer', model: 'DR-HSH034S', productName: 'Heater' });
    await host.tick();
    assert.equal((await asAdmin(host, 'GET', '/devices')).json.devices.length, 2, 'not before the hour is over');
    const imp = require('../server/dreoimport');
    await imp.maybe(host.gc, Date.now() + imp.EVERY_MS + 1000);
    assert.deepEqual((await asAdmin(host, 'GET', '/devices')).json.devices.map((d) => d.name).sort(), ['Bad', 'Schlafzimmer', 'Wohnzimmer']);
  });
});

test('an empty Dreo account: the settings and the add dialog say so', () => {
  const dreo = fakeDreo({ devices: [] });
  return withHost({ dreo }, async (host) => {
    const lines = await connectDreo(host, dreo);
    const dl = lines.filter((l) => l.group === 'dreo');
    assert.equal(dl[0].tone, 'ok');
    assert.deepEqual([dl[1].tone, /kein Gerät/.test(dl[1].text)], ['warn', true], JSON.stringify(dl));
    assert.deepEqual((await asAdmin(host, 'GET', '/devices')).json.devices, []);
    const ui = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'ui', 'admin.js'), 'utf8');
    assert.ok(ui.includes("!dreoDevices.length ? T('add.dreo_empty')"), 'the dialog does not claim "all added" for an empty account');
  });
});

test('an account connected before 2.1.0: the first background run adds its devices', () => {
  const dreo = fakeDreo();
  return withHost({ dreo }, async (host) => {
    await connectDreo(host, dreo);
    // as if 2.0.x had connected it: no devices, no look into the account yet
    for (const d of (await asAdmin(host, 'GET', '/devices')).json.devices) await host.gc.db.run('DELETE FROM devices WHERE id = ?', [d.id]);
    await host.gc.storage.delete('dreo_found');
    await host.gc.storage.delete('dreo_dismissed');
    await host.tick();
    assert.deepEqual((await asAdmin(host, 'GET', '/devices')).json.devices.map((d) => d.device_sn), ['dreo-HSH009S-1', 'dreo-HAC006S-1']);
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
    const l = lineOf(await connectDreo(host, dreo), 'dreo');
    assert.equal(l.tone, 'warn');
    assert.match(l.text, /1\.184\.0/);
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

test('2.1.1: an empty v2 device list — the devices come from the home’s rooms (newer Dreo app)', () => {
  const heater = { sn: 'HSH034S-9', deviceName: 'Wohnzimmer', model: 'DR-HSH034S', productName: 'Heater' };
  const dreo = fakeDreo({ devices: [], rooms: [{ roomName: 'Wohnzimmer', devices: [heater] }, { roomName: 'Flur', deviceList: [] }] });
  return withHost({ dreo }, async (host) => {
    const lines = await connectDreo(host, dreo);
    const devices = (await asAdmin(host, 'GET', '/devices')).json.devices;
    assert.deepEqual(devices.map((d) => [d.device_sn, d.name, d.model]), [['dreo-HSH034S-9', 'Wohnzimmer', 'DR-HSH034S']]);
    assert.match(lines.filter((l) => l.group === 'dreo').map((l) => l.text).join(' | '), /Wohnzimmer \(DR-HSH034S\)/);
  });
});

test('2.1.1: an account that lives in the other region without the login saying so — found there, the account moves', () => {
  const dreo = fakeDreo({ region: 'NA', silentRegion: true });
  return withHost({ dreo }, async (host) => {
    await connectDreo(host, dreo);
    // saving the account: the login stays in EU (nothing says otherwise), nothing there — then NA has the devices
    const devices = (await asAdmin(host, 'GET', '/devices')).json.devices;
    assert.deepEqual(devices.map((d) => d.device_sn), ['dreo-HSH009S-1', 'dreo-HAC006S-1']);
    assert.equal((await host.gc.storage.get('dreo')).region, 'NA', 'the account moved to its region');
    const st = (await asAdmin(host, 'GET', `/devices/${devices[0].id}/state`));
    assert.equal(st.status, 200, JSON.stringify(st.json));
  });
});

test('2.1.1: really nothing in the account — the status line says which regions and lists were asked', () => {
  const dreo = fakeDreo({ devices: [], rooms: [] , silentRegion: true });
  return withHost({ dreo }, async (host) => {
    const lines = await connectDreo(host, dreo);
    const text = lines.filter((l) => l.group === 'dreo').map((l) => l.text).join(' | ');
    assert.match(text, /kein Gerät/);
    assert.match(text, /kein Gerät \(geprüft – EU: Geräteliste 0, Räume 0 · US: Geräteliste 0, Räume 0 · Open-API EU: Geräte 0\)/);
    assert.match(text, /Apple\/Google/);
  });
});

test('collectDevices: flat lists, rooms, homes with rooms; nothing else', () => {
  const { collectDevices } = require('../server/dreo');
  const h = (sn) => ({ sn, deviceName: sn, model: 'DR-HSH009S' });
  assert.deepEqual(collectDevices({ list: [h('A1')] }).map((d) => d.sn), ['A1']);
  assert.deepEqual(collectDevices({ list: [{ roomName: 'x', devices: [h('B1'), h('B2')] }] }).map((d) => d.sn), ['B1', 'B2']);
  assert.deepEqual(collectDevices({ list: [{ rooms: [{ deviceList: [{ deviceSn: 'C1', model: 'WH719S' }] }] }] }).map((d) => d.sn), ['C1']);
  assert.deepEqual(collectDevices([h('D1')]).map((d) => d.sn), ['D1']);
  assert.deepEqual(collectDevices({ list: [{ sn: 'no model' }, { sn: 'E1' }, null, 7] }), []);
  assert.deepEqual(collectDevices(null), []);
});

test('2.1.1: an empty look of 2.1.0 is redone right after the update', () => {
  const heater = { sn: 'HSH034S-9', deviceName: 'Wohnzimmer', model: 'DR-HSH034S', productName: 'Heater' };
  const dreo = fakeDreo({ devices: [], rooms: [{ roomName: 'Wohnzimmer', devices: [heater] }] });
  return withHost({ dreo }, async (host) => {
    await connectDreo(host, dreo);
    for (const d of (await asAdmin(host, 'GET', '/devices')).json.devices) await host.gc.db.run('DELETE FROM devices WHERE id = ?', [d.id]);
    await host.gc.storage.set('dreo_found', { at: Date.now(), devices: [], error: null });   // what 2.1.0 kept
    await host.tick();
    assert.deepEqual((await asAdmin(host, 'GET', '/devices')).json.devices.map((d) => d.device_sn), ['dreo-HSH034S-9']);
  });
});

test('2.2.0: a heater only Dreo’s Open API lists — found, read and switched over it (no socket)', () => {
  const wall = { sn: 'WALL-1', deviceName: 'Heizlüfter', model: 'DR-HSH040S' };
  const dreo = fakeDreo({ devices: [], rooms: [], openDevices: [wall], states: {
    'WALL-1': { poweron: false, connected: true, mode: 'hotair', htalevel: 1, ecolevel: 72, temperature: 64 },
  } });
  return withHost({ dreo }, async (host) => {
    const lines = await connectDreo(host, dreo);
    assert.match(lines.filter((l) => l.group === 'dreo').map((l) => l.text).join(' | '), /Heizlüfter \(DR-HSH040S\)/);
    const devices = (await asAdmin(host, 'GET', '/devices')).json.devices;
    assert.deepEqual(devices.map((d) => [d.device_sn, d.name, d.kind]), [['dreo-WALL-1', 'Heizlüfter', 'heater']]);
    const st = await asAdmin(host, 'GET', `/devices/${devices[0].id}/state`);
    assert.deepEqual([st.status, st.json.state.power, st.json.state.indoorTemp], [200, false, 17.8], JSON.stringify(st.json));
    const on = await asAdmin(host, 'POST', `/devices/${devices[0].id}/state`, { power: true });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.deepEqual(dreo.openCommands.at(-1), { devicesn: 'WALL-1', desired: { power_switch: true } });
    assert.equal(dreo.states['WALL-1'].poweron, true);
    assert.equal(dreo.sockets.length, 0, 'no WebSocket for Open API devices');
    await host.tick();
    assert.equal(dreo.sockets.length, 0);
  });
});

test('2.2.0: the status line names the Open API when nothing is anywhere', () => {
  const dreo = fakeDreo({ devices: [], rooms: [] });
  return withHost({ dreo }, async (host) => {
    const text = (await connectDreo(host, dreo)).filter((l) => l.group === 'dreo').map((l) => l.text).join(' | ');
    assert.match(text, /Open-API EU: Geräte 0/);
  });
});
