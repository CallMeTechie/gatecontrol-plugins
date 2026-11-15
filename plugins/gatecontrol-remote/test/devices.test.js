'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, rdpDevice, MARC } = require('./helpers');

test('a device is made with every setting, the credentials go into the vault and never come back', async () => {
  const { host, adminReq } = await setup();
  try {
    const r = await adminReq('POST', 'devices', { ...rdpDevice({ config: { domain: 'FIRMA', redirect_drives: true, color_depth: 16 } }), credentials: { username: 'tom', password: 'geheim' } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const d = r.device;
    assert.ok(d.id >= 100000, 'own devices start at 100000');
    assert.equal(d.config.redirect_drives, true);
    assert.equal(d.config.color_depth, 16);
    assert.deepEqual(d.credential.has, { username: true, password: true, domain: true, privateKey: false, passphrase: false });
    assert.equal(JSON.stringify(r).includes('geheim'), false);
    const v = [...host.remote.vault.values()][0];
    assert.equal(v.secret.password, 'geheim');
    assert.equal(v.secret.domain, 'FIRMA');
    // empty credentials keep, '' clears
    const r2 = await adminReq('PUT', 'devices/' + d.id, { name: 'Büro-PC 2', credentials: { password: '' } });
    assert.equal(r2.device.name, 'Büro-PC 2');
    assert.equal(r2.device.credential.has.password, false);
    assert.equal(r2.device.credential.has.username, true);
    const list = await adminReq('GET', 'devices');
    assert.equal(list.devices.length, 1);
    assert.equal(list.available, true);
    assert.equal(list.gateways[0].name, 'DS218 Gateway');
  } finally { await host.close(); }
});

test('wrong values are refused with the field', async () => {
  const { host, adminReq } = await setup();
  try {
    assert.equal((await adminReq('POST', 'devices', rdpDevice({ config: { port: 70000 } }))).field, 'port');
    assert.equal((await adminReq('POST', 'devices', rdpDevice({ config: { wol_enabled: true } }))).field, 'wol_mac_address');
    assert.equal((await adminReq('POST', 'devices', rdpDevice({ config: { access_mode: 'gateway' } }))).field, 'gateway_peer_id');
    assert.equal((await adminReq('POST', 'devices', rdpDevice({ config: { maintenance_enabled: true, maintenance_schedule: 'morgens' } }))).field, 'maintenance_schedule');
    assert.equal((await adminReq('POST', 'devices', rdpDevice({ config: { unknown_key: 1 } }))).field, 'unknown_key');
    assert.equal((await adminReq('POST', 'devices', { ...rdpDevice(), protocol: 'ssh', config: { host: '10.8.0.9', wol_enabled: true, wol_mac_address: 'AA:BB:CC:DD:EE:FF' } })).field, 'wol_enabled');
    const ok = await adminReq('POST', 'devices', { name: 'Pi', protocol: 'ssh', config: { host: '10.8.0.9' } });
    assert.equal(ok.device.config.port, 22, 'the default port of the protocol');
  } finally { await host.close(); }
});

test('a gateway device gets a listener, deleting it removes listener and vault entry', async () => {
  const { host, adminReq } = await setup();
  try {
    const r = await adminReq('POST', 'devices', { ...rdpDevice({ config: { host: '192.168.1.30', access_mode: 'gateway', gateway_peer_id: 7, gateway_listen_port: 23389 } }), credentials: { username: 'x', password: 'y' } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const key = 'dev-' + r.device.id;
    assert.equal(r.device.listener, key);
    assert.equal(host.remote.listeners.get(key).listenPort, 23389);
    // a second device on the same port
    const clash = await adminReq('POST', 'devices', rdpDevice({ config: { host: '192.168.1.31', access_mode: 'gateway', gateway_peer_id: 7, gateway_listen_port: 23389 } }));
    assert.equal(clash.code, 'port_in_use');
    // an unknown gateway
    assert.equal((await adminReq('POST', 'devices', rdpDevice({ config: { host: '192.168.1.32', access_mode: 'gateway', gateway_peer_id: 99, gateway_listen_port: 23390 } }))).code, 'not_found');
    // back to internal: the listener goes
    const back = await adminReq('PUT', 'devices/' + r.device.id, { config: { access_mode: 'internal', host: '10.8.0.30' } });
    assert.equal(back.device.listener, null);
    assert.equal(host.remote.listeners.has(key), false);
    await adminReq('DELETE', 'devices/' + r.device.id);
    assert.equal(host.remote.vault.size, 0);
    assert.equal((await adminReq('GET', 'devices')).devices.length, 0);
  } finally { await host.close(); }
});

test('check, wake and switch a device off on the admin page; only administrators get there', async () => {
  const { host, adminReq, req } = await setup({ remote: { probe: () => ({ online: false, responseTime: null }) } });
  try {
    const d = (await adminReq('POST', 'devices', rdpDevice({ config: { wol_enabled: true, wol_mac_address: 'aa-bb-cc-dd-ee-ff' } }))).device;
    assert.equal(d.config.wol_mac_address, 'AA:BB:CC:DD:EE:FF');
    const c = await adminReq('POST', 'devices/' + d.id + '/check');
    assert.equal(c.status.online, false);
    const w = await adminReq('POST', 'devices/' + d.id + '/wake');
    assert.equal(w.wake.sent, true);
    assert.equal((await adminReq('POST', 'devices/' + d.id + '/wake')).code, 'rate_limited');
    const off = await adminReq('POST', 'devices/' + d.id + '/toggle');
    assert.equal(off.device.enabled, false);
    const marc = await req(MARC, 'GET', '/admin/devices', null, { portal: false });
    assert.equal(marc.status, 403);
  } finally { await host.close(); }
});

test('the background checks the devices and keeps the history short', async () => {
  const { host, adminReq } = await setup({ remote: { probe: (t) => ({ online: t.host === '10.8.0.44', responseTime: 3 }) } });
  try {
    await adminReq('POST', 'devices', rdpDevice());
    await adminReq('POST', 'devices', rdpDevice({ config: { host: '10.8.0.45' }, top: { name: 'Zweiter' } }));
    await host.tick();
    const list = (await adminReq('GET', 'devices')).devices;
    assert.equal(list.find((x) => x.name === 'Büro-PC').status.online, true);
    assert.equal(list.find((x) => x.name === 'Zweiter').status.online, false);
  } finally { await host.close(); }
});
