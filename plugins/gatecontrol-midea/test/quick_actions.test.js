'use strict';

// Quick actions of the GateControl apps (hooks quickActions / runQuickAction):
// power on/off per air conditioner of the viewer — the portal's owner scope,
// cached state only in the list, at most 16 — each with a widget (indoor
// temperature, status line, target temperature stepper, mode choice).

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeAc, fakeCloud, withHost, asAdmin, connectCloud, ADMIN, ADA, BOB } = require('./helpers');

const A = '153931628798542';
const B = '153931628798543';
// the list kicks background cloud refreshes (service.cachedState); let them land before the host closes
const settle = () => new Promise((r) => setTimeout(r, 300));
const direct = (host, user, id, lang = 'de', extra = {}) => host.plugin.runQuickAction({ user: { portal: true, loggedIn: true, app: true, ...user }, lang, id, ...extra }, host.gc);

const MODES = { de: { auto: 'Auto', cool: 'Kühlen', heat: 'Heizen', dry: 'Entfeuchten', fan: 'Lüften' }, en: { auto: 'Auto', cool: 'Cool', heat: 'Heat', dry: 'Dry', fan: 'Fan' } };
/** The widget as the host passes it on: value/status/state plus the two controls. */
function widget({ value = '–', status = null, state = null, target = 24, mode = 'auto', lang = 'de' } = {}) {
  return {
    value, unit: '°C', status, state,
    controls: [
      { id: 'target', kind: 'stepper', label: lang === 'en' ? 'Target' : 'Ziel', value: target, min: 16, max: 30, step: 0.5, unit: '°C' },
      { id: 'mode', kind: 'choice', label: lang === 'en' ? 'Mode' : 'Modus', value: mode, options: ['auto', 'cool', 'heat', 'dry', 'fan'].map((id) => ({ id, label: MODES[lang][id] })) },
    ],
  };
}

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
    assert.deepEqual(ada[0].widget, widget({ value: '23,5', status: 'Kühlen · Ziel 22 °C', state: 'on', target: 22, mode: 'cool' }), 'the widget from the cached state');
    assert.deepEqual(ada[1].widget, widget(), 'unknown state: dash, no status, default controls');
    const bob = await host.quickActions(BOB, 'en');
    assert.deepEqual(bob.map((x) => x.id), [`ac:${b}`]);
    assert.deepEqual(bob[0].widget, widget({ lang: 'en' }));
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
    assert.deepEqual(r, { status: 200, body: { ok: true, message: 'Wohnzimmer ausgeschaltet', state: 'off', widget: widget({ value: '23,5', status: 'Aus', state: 'off', target: 22, mode: 'cool' }) } });
    assert.equal(devA.state.power, false);
    assert.equal((await host.quickActions(ADA))[0].state, 'off', 'the list follows at once');
    r = await host.runQuickAction(ADA, `ac:${a}`, 'en');
    assert.deepEqual(r.body, { ok: true, message: 'Wohnzimmer switched on', state: 'on', widget: widget({ value: '23.5', status: 'Cool · Target 22 °C', state: 'on', target: 22, mode: 'cool', lang: 'en' }) });
    assert.equal(devA.state.power, true);
    // B: no cached state yet → read from the device first, then switched over
    r = await host.runQuickAction(ADA, `ac:${b}`);
    assert.deepEqual(r.body, { ok: true, message: 'Büro eingeschaltet', state: 'on', widget: widget({ value: '23,5', status: 'Kühlen · Ziel 24 °C', state: 'on', target: 24, mode: 'cool' }) });
    assert.equal(devB.state.power, true);
    await settle();
  });
});

test('runQuickAction with a control: target temperature and mode reach the device, the answer carries the new widget', () => {
  const { devA, cloud } = twoDevices();
  return withHost({ cloud }, async (host) => {
    const { a } = await setup(host, cloud);
    await asAdmin(host, 'PUT', `/devices/${a}/owners`, { user_ids: [ADA.id] });
    let r = await host.runQuickAction(ADA, `ac:${a}`, 'de', { control: 'target', value: 25.5 });
    assert.deepEqual(r, { status: 200, body: { ok: true, message: null, state: 'on', widget: widget({ value: '23,5', status: 'Kühlen · Ziel 25,5 °C', state: 'on', target: 25.5, mode: 'cool' }) } });
    assert.deepEqual([devA.state.targetTemp, devA.state.mode, devA.state.power], [25.5, 'cool', true], 'only the target changed');
    r = await host.runQuickAction(ADA, `ac:${a}`, 'en', { control: 'mode', value: 'heat' });
    assert.deepEqual(r.body, { ok: true, message: null, state: 'on', widget: widget({ value: '23.5', status: 'Heat · Target 25.5 °C', state: 'on', target: 25.5, mode: 'heat', lang: 'en' }) });
    assert.equal(devA.state.mode, 'heat');
    assert.deepEqual((await host.quickActions(ADA))[0].subtitle, 'Heizen · Ziel 25,5 °C', 'the list follows at once');
    // a control works while the device is off (it stays off), and a value off the half-degree grid is snapped
    devA.state.power = false;
    r = await host.runQuickAction(ADA, `ac:${a}`, 'de', { control: 'target', value: 19.3 });
    assert.deepEqual(r.body, { ok: true, message: null, state: 'off', widget: widget({ value: '23,5', status: 'Aus', state: 'off', target: 19.5, mode: 'heat' }) });
    assert.equal(devA.state.power, false);
    // the host checks control and value against the listed widget before the hook sees them
    for (const [control, value] of [['fan', 50], ['target', 31], ['target', '22'], ['mode', 'turbo'], ['mode', 2]]) {
      const bad = await host.runQuickAction(ADA, `ac:${a}`, 'de', { control, value });
      assert.equal(bad.status, 400, `${control} ${value}`);
    }
    // … and the hook checks again on its own
    for (const [control, value] of [['fan', 50], ['target', 15.5], ['target', 30.5], ['target', '22'], ['target', NaN], ['mode', 'turbo'], ['mode', null], [null, 22]]) {
      const out = await direct(host, ADA, `ac:${a}`, 'de', { control, value });
      assert.deepEqual(out, { ok: false, message: 'Diese Aktion gibt es nicht mehr.' }, `${control} ${value}`);
    }
    assert.deepEqual([devA.state.targetTemp, devA.state.mode], [19.5, 'heat'], 'nothing reached the device');
    assert.equal((await direct(host, BOB, `ac:${a}`, 'de', { control: 'target', value: 22 })).message, 'Dieses Gerät ist dir nicht zugewiesen');
    devA.down = true;
    r = await host.runQuickAction(ADA, `ac:${a}`, 'de', { control: 'target', value: 22 });
    assert.deepEqual(r.body, { ok: false, message: 'Gerät nicht erreichbar', state: null, widget: widget({ status: 'Offline', state: 'warn' }) });
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
    assert.deepEqual(r, { status: 200, body: { ok: false, message: 'Gerät nicht erreichbar', state: null, widget: widget({ status: 'Offline', state: 'warn' }) } });
    assert.deepEqual((await host.quickActions(ADA))[0].widget, widget({ status: 'Offline', state: 'warn' }), 'the list shows it offline too');
    await settle();
  });
});
