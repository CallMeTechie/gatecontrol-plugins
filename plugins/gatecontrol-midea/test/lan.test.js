'use strict';

// Air conditioners in the home network: the LAN protocol (V2 and V3 with the
// token/key handshake) over the home target "ac", adding a device through an
// assigned target, the connection test, the background poll and the local
// discovery (localDiscovery) — all without any network of the plugin's own.

const test = require('node:test');
const assert = require('node:assert/strict');
const ac = require('../server/ac');
const lan = require('../server/lan');
const { fakeAc, fakeSocket, discoveryAnswer, fakeCloud, withHost, asAdmin, connectCloud, stateFrame } = require('./helpers');

const TOKEN = 'a1'.repeat(64);
const KEY = 'b2'.repeat(32);
const DEVICE_ID = '151732605161920';

test('ac frames: a state answer parses back to the state', () => {
  const st = { power: true, mode: 'heat', targetTemp: 21.5, fanSpeed: 102, swingV: true, swingH: false, turbo: false, eco: true, indoorTemp: 19, outdoorTemp: 4.5 };
  assert.deepEqual(ac.parseState(stateFrame(st)), st);
  const set = ac.buildSet({ ...st, targetTemp: 16 });
  assert.equal(set[0], 0xaa);
  assert.equal(set[9], 0x02, 'a control frame');
});

test('LanDevice V2 and V3 (handshake) read and write through the injected transport', async () => {
  for (const version of [2, 3]) {
    const dev = fakeAc({ power: false, targetTemp: 22 });
    const conn = { version, deviceId: DEVICE_ID, token: TOKEN, key: KEY };
    const d = new lan.LanDevice({ connect: async () => fakeSocket(dev, conn), deviceId: DEVICE_ID, protocolVersion: version, token: TOKEN, key: KEY, timeoutMs: 2000 });
    const st = await d.getState();
    assert.equal(st.power, false);
    assert.equal(st.targetTemp, 22);
    const after = await d.setState({ power: true, targetTemp: 25, mode: 'cool', fanSpeed: 40 });
    assert.deepEqual([after.power, after.targetTemp, after.mode, after.fanSpeed], [true, 25, 'cool', 40]);
    assert.deepEqual(dev.frames, [0x03, 0x03, 0x02, 0x03], `read, read, write, confirm (v${version})`);
  }
});

test('LanDevice V3 refuses to start without token/key; a wrong token times out cleanly', async () => {
  assert.throws(() => new lan.LanDevice({ connect: async () => null, deviceId: DEVICE_ID, protocolVersion: 3 }), /token and key/);
  const dev = fakeAc();
  const d = new lan.LanDevice({ connect: async () => fakeSocket(dev, { version: 3, token: 'ff'.repeat(64), key: KEY }), deviceId: DEVICE_ID, protocolVersion: 3, token: TOKEN, key: KEY, timeoutMs: 300 });
  await assert.rejects(d.getState(), /closed|timeout/);
});

test('discovery answers: V2/V3 air conditioners are parsed, other device types and garbage dropped', () => {
  const found = lan.parseAnswers([
    { address: '192.168.1.60', port: 6445, data: discoveryAnswer({ version: 3 }) },
    { address: '192.168.1.61', port: 6445, data: discoveryAnswer({ version: 2, deviceId: '1001', ip: '10.0.0.9' }) },
    { address: '192.168.1.62', port: 6445, data: discoveryAnswer({ deviceId: '1002', type: 'a1' }) },
    { address: '192.168.1.63', port: 6445, data: Buffer.from('nonsense') },
  ]);
  assert.deepEqual(found.map((f) => [f.address, f.deviceId, f.version, f.port]), [['192.168.1.60', DEVICE_ID, 3, 6444], ['192.168.1.61', '1001', 2, 6444]]);
  assert.equal(found[1].ip, '10.0.0.9', 'what the device claims');
  assert.equal(found[1].address, '192.168.1.61', 'where the answer came from');
});

test('local discovery goes through gc.net.discover on the declared ports', () => {
  let asked = null;
  const discover = async (data, o) => { asked = { data, o }; return [{ address: '192.168.1.60', port: 6445, data: discoveryAnswer() }]; };
  return withHost({ discover }, async (host) => {
    const r = await asAdmin(host, 'POST', '/discover');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.devices.map((d) => [d.address, d.deviceId]), [['192.168.1.60', DEVICE_ID]]);
    assert.deepEqual(asked.o.ports, [6445, 20086]);
    assert.ok(asked.data.equals(lan.DISCOVERY_MSG));
  });
});

test('a V2 device on an assigned target: add, control, test, poll, edit, remove', () => {
  const dev = fakeAc({ power: false });
  return withHost({ lan: [{ dev, version: 2, deviceId: '1001', answer: discoveryAnswer({ version: 2, deviceId: '1001' }) }] }, async (host) => {
    const targets = (await asAdmin(host, 'GET', '/targets')).json.targets;
    assert.deepEqual(targets, [{ index: 0, label: '192.168.1.60' }]);
    assert.equal((await asAdmin(host, 'POST', '/devices', { target_index: 5 })).json.code, 'MIDEA_NO_TARGET');
    const add = await asAdmin(host, 'POST', '/devices', { target_index: 0, name: 'Büro' });
    assert.equal(add.status, 200, JSON.stringify(add.json));
    assert.deepEqual([add.json.device.name, add.json.device.device_sn, add.json.device.device_id, add.json.device.protocol_version, add.json.device.target_index],
      ['Büro', 'lan-1001', '1001', 2, 0]);
    const id = add.json.device.id;
    assert.equal((await asAdmin(host, 'POST', '/devices', { target_index: 0 })).json.code, 'MIDEA_DEVICE_EXISTS');

    const list = (await asAdmin(host, 'GET', '/devices')).json.devices;
    assert.equal(list[0].target_label, '192.168.1.60');
    const set = await asAdmin(host, 'POST', `/devices/${id}/state`, { patch: { power: true, targetTemp: 26, swingV: true } });
    assert.equal(set.status, 200);
    assert.deepEqual([set.json.state.power, set.json.state.targetTemp, set.json.state.swingV], [true, 26, true]);
    assert.equal(dev.state.targetTemp, 26);
    assert.equal((await asAdmin(host, 'POST', `/devices/${id}/state`, { patch: { targetTemp: 40 } })).status, 400);
    assert.equal((await asAdmin(host, 'POST', `/devices/${id}/state`, { patch: { mode: 'boost' } })).status, 400);

    const t = await asAdmin(host, 'POST', `/devices/${id}/test`);
    assert.equal(t.status, 200);
    assert.equal(t.json.version, 2);

    dev.state.indoorTemp = 20;
    await host.tick();
    const status = (await asAdmin(host, 'GET', '/status')).json;
    assert.ok(status.lastPollAt);
    assert.equal(status.devices[0].state.indoorTemp, 20, 'the background run polled it');

    dev.down = true;
    assert.deepEqual((await asAdmin(host, 'GET', `/devices/${id}/state`)).json.state, { offline: true });
    const tf = await asAdmin(host, 'POST', `/devices/${id}/test`);
    assert.equal(tf.status, 502);
    assert.equal(tf.json.code, 'ERR_NET');
    dev.down = false;

    const ed = await asAdmin(host, 'PUT', `/devices/${id}`, { name: 'Arbeitszimmer', enabled: false, target_index: null });
    assert.deepEqual([ed.json.device.name, ed.json.device.enabled, ed.json.device.target_index], ['Arbeitszimmer', false, null]);
    assert.equal((await asAdmin(host, 'POST', `/devices/${id}/test`)).json.code, 'MIDEA_NO_TARGET');
    assert.deepEqual((await asAdmin(host, 'DELETE', `/devices/${id}`)).json, { ok: true });
    assert.deepEqual((await asAdmin(host, 'GET', '/devices')).json.devices, []);
  });
});

test('a V3 device: the keys come from the cloud account before anything is stored, as secrets', () => {
  const dev = fakeAc();
  const cloud = fakeCloud({ appliances: [{ id: DEVICE_ID, sn: 'SN-V3', name: 'Schlafzimmer', type: '0xAC', onlineStatus: '1' }], tokens: { [DEVICE_ID]: { token: TOKEN, key: KEY } } });
  const conn = { dev, version: 3, deviceId: DEVICE_ID, token: TOKEN, key: KEY, answer: discoveryAnswer({ version: 3 }) };
  return withHost({ cloud, lan: [conn] }, async (host) => {
    // without the cloud account a V3 device cannot get its keys — nothing is stored
    const no = await asAdmin(host, 'POST', '/devices', { target_index: 0 });
    assert.equal(no.json.code, 'MIDEA_CLOUD_NOT_CONFIGURED');
    assert.deepEqual((await asAdmin(host, 'GET', '/devices')).json.devices, []);

    await connectCloud(host, cloud);
    const wrong = await asAdmin(host, 'POST', '/devices', { target_index: 0, sn: 'SN-OTHER' });
    assert.equal(wrong.json.code, 'MIDEA_NOT_IN_CLOUD');
    const add = await asAdmin(host, 'POST', '/devices', { target_index: 0, sn: 'SN-V3' });
    assert.equal(add.status, 200, JSON.stringify(add.json));
    assert.deepEqual([add.json.device.name, add.json.device.protocol_version, add.json.device.has_credentials], ['Schlafzimmer', 3, true]);
    const id = add.json.device.id;
    assert.ok(host.secrets.has(`dev.${id}.token`) && host.secrets.has(`dev.${id}.key`));
    assert.ok(!JSON.stringify((await asAdmin(host, 'GET', '/devices')).json).includes(KEY), 'keys never leave the plugin');
    const st = await asAdmin(host, 'POST', `/devices/${id}/state`, { patch: { power: true, mode: 'dry' } });
    assert.deepEqual([st.json.state.power, st.json.state.mode], [true, 'dry']);
    // removing the device removes its keys
    await asAdmin(host, 'DELETE', `/devices/${id}`);
    assert.ok(!host.secrets.has(`dev.${id}.token`) && !host.secrets.has(`dev.${id}.key`));
  });
});
