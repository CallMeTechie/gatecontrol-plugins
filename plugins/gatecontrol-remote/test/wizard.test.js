'use strict';

// 1.7: the new „Gerät hinzufügen“ (gc.remote version 7): the list of the wizard (admin/candidates), a scan of one
// target, wake by the network watch, the way after the rule (server/way.js), the port on the server automatic, the
// browser on for new devices, only administrators at first, the hint for an old device with a LAN address under
// „Nur VPN“ — and the old form (no wizard) with an older GateControl.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, rdpDevice, ADMIN, MARC } = require('./helpers');
const way = require('../server/way');

const CAND = {
  peers: [
    { peerId: 30, name: 'nas', address: '10.8.0.30', dnsName: 'nas.vpn.example.test', twin: { gatewayPeerId: 7, ref: 'nw-2', address: '192.168.178.20' } },
    { peerId: 12, name: 'buero-pc', address: '10.8.0.12', app: 'windows' },
  ],
  gateways: [
    { peerId: 7, name: 'Zuhause', online: true, pool: { poolId: 3, name: 'Heim' }, subnets: ['192.168.178.0/24'], devices: [
      { ref: 'nw-1', name: 'wohnzimmer-pc', address: '192.168.178.34', vendor: 'Micro-Star', online: true, ports: [{ port: 3389, service: 'rdp' }], mac: '3C:7C:3F:12:9A:01' },
      { ref: 'nw-2', name: 'nas', address: '192.168.178.20', vendor: 'Synology', online: true, ports: [{ port: 22, service: 'ssh' }], mac: '00:11:32:AA:BB:01', twin: { peerId: 30, address: '10.8.0.30' } },
    ] },
    { peerId: 8, name: 'Ferienhaus', online: false, subnets: ['192.168.10.0/24'], devices: [] },
  ],
  routes: [{ routeId: 40, name: 'git-server', listenPort: 2222, protocol: 'ssh', target: { kind: 'peer', peerId: 30, name: 'nas', host: '10.8.0.30', port: 22 } }],
};

const v7 = (extra = {}) => setup({ remote: { v7: true, gateways: [{ peerId: 7, name: 'Zuhause', online: true }, { peerId: 8, name: 'Ferienhaus', online: false }], candidates: CAND, ...extra } });

test('the list of the wizard: only administrators, never a MAC, the devices of the plugin to compare', async () => {
  const { host, adminReq, req } = await v7();
  try {
    await adminReq('POST', 'devices', rdpDevice({ config: { host: '10.8.0.30' }, top: { name: 'nas' } }));
    const r = await adminReq('GET', 'candidates');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.available, true);
    assert.ok(!JSON.stringify(r).includes('3C:7C'), 'no MAC');
    assert.equal(r.gateways[0].devices[0].wake, true);
    assert.equal(r.known.length, 1);
    assert.equal(r.known[0].host, '10.8.0.30');
    assert.equal(r.checkMinutes, 5);
    assert.ok(host.remote.calls.filter((c) => c.op === 'candidates').every((c) => c.user === ADMIN.id), 'only for the administrator of the request');
    assert.equal((await req(MARC, 'GET', '/admin/candidates', null, { portal: false })).status, 403);
    assert.equal((await adminReq('GET', 'devices')).wizard, true);
  } finally { await host.close(); }
});

test('an older GateControl: no list, the old form', async () => {
  const { host, adminReq } = await setup();
  try {
    assert.equal((await adminReq('GET', 'candidates')).available, false);
    assert.equal((await adminReq('GET', 'devices')).wizard, false);
    assert.equal((await adminReq('POST', 'candidates/scan', { host: '10.8.0.30' })).code, 'offline');
    // a gateway device without a port on the server takes the port of the device as before
    const d = (await adminReq('POST', 'devices', rdpDevice({ config: { host: '192.168.1.30', access_mode: 'gateway', gateway_peer_id: 7 } }))).device;
    assert.equal(d.config.gateway_listen_port, 3389);
  } finally { await host.close(); }
});

test('scan of one target: directly or through its gateway; an offline gateway is said so', async () => {
  const { host, adminReq } = await v7({ scan: (t, ports) => ({ results: ports.filter((p) => p === 3389).map((p) => ({ port: p, open: true, responseTime: 18 })) }) });
  try {
    const r = await adminReq('POST', 'candidates/scan', { host: '192.168.178.34', gatewayPeerId: 7 });
    assert.equal(r.scan.via, 'gateway');
    assert.deepEqual(r.scan.results.map((x) => [x.port, x.open]), [[22, false], [3389, true], [5900, false], [23, false]]);
    assert.equal((await adminReq('POST', 'candidates/scan', { host: '192.168.10.15', gatewayPeerId: 8 })).code, 'gateway_offline');
    assert.equal((await adminReq('POST', 'candidates/scan', { host: 'a b' })).code, 'invalid');
    const ext = await adminReq('POST', 'candidates/scan', { host: '10.8.0.30', ports: [2222] });
    assert.equal(ext.scan.via, 'direct');
    assert.deepEqual(ext.scan.results.map((x) => x.port), [2222]);
  } finally { await host.close(); }
});

test('wake a device of the watch: GateControl takes the MAC', async () => {
  const { host, adminReq } = await v7();
  try {
    const r = await adminReq('POST', 'candidates/wake', { ref: 'nw-1', host: '192.168.178.34', gatewayPeerId: 7 });
    assert.equal(r.wake.sent, true, JSON.stringify(r));
    const call = host.remote.calls.find((c) => c.op === 'wake');
    assert.equal(call.target.mac, '3C:7C:3F:12:9A:01');
    assert.equal((await adminReq('POST', 'candidates/wake', { ref: 'aa', host: '192.168.178.34', gatewayPeerId: 7 })).code, 'invalid');
  } finally { await host.close(); }
});

test('the way: a peer, a home network (the pool), the server’s network, the internet', async () => {
  assert.equal(way.derive('10.8.0.30', CAND).kind, 'vpn');
  assert.equal(way.derive('nas.vpn.example.test', CAND).peer.peerId, 30);
  const g = way.derive('192.168.178.50', CAND);
  assert.deepEqual([g.kind, g.gateway.peerId, g.gateway.pool.poolId], ['gateway', 7, 3]);
  assert.deepEqual(way.accessOf(g, '192.168.178.50', 22), { access_mode: 'gateway', gateway_peer_id: null, gateway_pool_id: 3, external_hostname: null, external_port: null });
  assert.equal(way.derive('172.20.1.5', CAND).kind, 'server');
  const i = way.derive('ferien-nas.example.org', CAND);
  assert.equal(i.kind, 'internet');
  assert.deepEqual(way.accessOf(i, 'ferien-nas.example.org', 2222), { access_mode: 'both', gateway_peer_id: null, gateway_pool_id: null, gateway_listen_port: null, external_hostname: 'ferien-nas.example.org', external_port: 2222 });
  // two gateways with the same net: the choice of the list wins
  const twice = { gateways: [...CAND.gateways, { peerId: 9, name: 'Büro', online: true, subnets: ['192.168.178.0/24'], devices: [] }] };
  const t = way.derive('192.168.178.9', twice, 9);
  assert.deepEqual([t.gateway.peerId, t.choices.length], [9, 2]);
  assert.equal(way.inCidr('10.1.2.3', '10.0.0.0/8'), true);
  assert.equal(way.inCidr('11.1.2.3', '10.0.0.0/8'), false);
  const { host, adminReq } = await v7();
  try {
    const r = await adminReq('POST', 'way', { host: '192.168.178.34', port: 3389 });
    assert.deepEqual([r.way.kind, r.access.access_mode, r.access.gateway_pool_id], ['gateway', 'gateway', 3]);
  } finally { await host.close(); }
});

test('a new device from the wizard: port on the server automatic, browser on, administrators only', async () => {
  const { host, adminReq } = await v7();
  try {
    const r = await adminReq('POST', 'devices', { name: 'wohnzimmer-pc', protocol: 'rdp', access: 'admins',
      config: { host: '192.168.178.34', port: 3389, access_mode: 'gateway', gateway_pool_id: 3, gateway_listen_port: null }, credentials: { username: 'anna', password: 'geheim' } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const d = r.device;
    assert.equal(d.config.browser_enabled, true, 'a new device connects in the browser');
    assert.ok(d.config.gateway_listen_port >= 40000 && d.config.gateway_listen_port <= 40999, 'the port GateControl picked');
    assert.deepEqual(d.access.users, [ADMIN.id]);
    assert.equal(d.access.open, false);
    assert.equal(d.way.kind, 'gateway');
    // saved again: the port stays
    const again = (await adminReq('PUT', 'devices/' + d.id, { name: 'wohnzimmer' })).device;
    assert.equal(again.config.gateway_listen_port, d.config.gateway_listen_port);
    // the old form sends browser_enabled itself; an old device keeps its value
    const off = (await adminReq('POST', 'devices', rdpDevice({ config: { host: '10.8.0.44', browser_enabled: false } }))).device;
    assert.equal(off.config.browser_enabled, false);
  } finally { await host.close(); }
});

test('the editor: an old device with a LAN address under „Nur VPN“ gets the hint', async () => {
  const { host, adminReq } = await v7();
  try {
    const d = (await adminReq('POST', 'devices', rdpDevice({ config: { host: '192.168.178.34', access_mode: 'internal' } }))).device;
    assert.equal(d.way.kind, 'server');
    assert.deepEqual([d.way.hint.kind, d.way.hint.gateway.peerId], ['lan', 7]);
    const vpn = (await adminReq('POST', 'devices', rdpDevice({ config: { host: '10.8.0.30' }, top: { name: 'nas' } }))).device;
    assert.deepEqual([vpn.way.kind, vpn.way.peer.name, vpn.way.hint], ['vpn', 'nas', null]);
    const both = (await adminReq('POST', 'devices', rdpDevice({ config: { host: '10.8.0.30', access_mode: 'both', external_hostname: 'nas.example.org', external_port: 13389 } }))).device;
    assert.deepEqual([both.way.kind, both.way.external.host], ['vpn', 'nas.example.org']);
  } finally { await host.close(); }
});
