'use strict';

// 1.7.2: the gateways of one failover pool in „Gerät hinzufügen“ — one home network, each device once (the same
// address in the same subnet), the ports merged, name and vendor of the best entry; the target goes through the pool,
// scan and wake through an online gateway of it. A gateway without a pool stays a section of its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setup, ADMIN } = require('./helpers');
const homes = require('../server/homes');
const way = require('../server/way');

const POOL = { poolId: 5, name: 'Mitte' };
const AN_HOUR = new Date(Date.now() - 3600e3).toISOString();
const NOW = new Date().toISOString();

const CAND = {
  peers: [{ peerId: 40, name: 'werkbank', address: '10.8.0.40', dnsName: null, twin: { gatewayPeerId: 22, ref: 'nw-22', address: '192.168.77.20' } }],
  gateways: [
    { peerId: 21, name: 'Gateway Ost', online: true, pool: POOL, subnets: ['192.168.77.0/24'], devices: [
      { ref: 'nw-11', name: null, address: '192.168.77.10', vendor: null, online: true, lastSeen: AN_HOUR, ports: [{ port: 22, service: 'ssh' }], mac: '02:00:00:00:77:10', wake: true },
      { ref: 'nw-12', name: 'drucker', address: '192.168.77.30', vendor: 'Beispiel GmbH', online: false, lastSeen: AN_HOUR, ports: null },
      { ref: 'nw-21', name: 'werkbank', address: '192.168.77.20', vendor: null, online: true, lastSeen: AN_HOUR, ports: [{ port: 3389, service: null }] },
    ] },
    { peerId: 22, name: 'Gateway West', online: true, pool: POOL, subnets: ['192.168.77.0/24'], devices: [
      { ref: 'nw-31', name: 'server-a', address: '192.168.77.10', vendor: 'Muster AG', online: true, lastSeen: NOW, ports: [{ port: 3389, service: 'rdp' }, { port: 22, service: null }] },
      { ref: 'nw-22', name: 'werkbank', address: '192.168.77.20', vendor: 'Muster AG', online: true, lastSeen: NOW, ports: [{ port: 3389, service: 'rdp' }], twin: { peerId: 40, address: '10.8.0.40' } },
      { ref: 'nw-33', name: 'nur-west', address: '192.168.77.44', vendor: null, online: true, lastSeen: NOW, ports: [{ port: 5900, service: 'vnc' }], mac: '02:00:00:00:77:44', wake: true },
    ] },
    { peerId: 23, name: 'Gartenhaus', online: false, offlineSince: AN_HOUR, subnets: ['192.168.88.0/24'], devices: [
      { ref: 'nw-41', name: 'kamera', address: '192.168.88.5', vendor: null, online: false, lastSeen: AN_HOUR, ports: [{ port: 22, service: 'ssh' }] },
    ] },
  ],
  routes: [],
};

test('the gateways of one pool are one home network, each device once', () => {
  const list = homes.of(CAND);
  assert.deepEqual(list.map((h) => h.id), ['pool-5', 'gw-23']);
  const h = list[0];
  assert.deepEqual([h.name, h.pool.poolId, h.total, h.onlineCount, h.online, h.offlineSince], ['Mitte', 5, 2, 2, true, null]);
  assert.deepEqual(h.members.map((m) => m.name), ['Gateway Ost', 'Gateway West']);
  assert.deepEqual(h.subnets, ['192.168.77.0/24']);
  // 3 + 3 entries, two addresses on both gateways → 4 devices
  assert.deepEqual(h.devices.map((d) => d.address), ['192.168.77.10', '192.168.77.30', '192.168.77.20', '192.168.77.44']);
  const a = h.devices[0];
  // name and vendor of the best entry (a name, a vendor, seen last), the ports of both, the service where one knows it
  assert.deepEqual([a.name, a.vendor, a.ref], ['server-a', 'Muster AG', 'nw-31']);
  assert.deepEqual(a.ports, [{ port: 22, service: 'ssh' }, { port: 3389, service: 'rdp' }]);
  assert.deepEqual(a.refs.sort(), ['nw-11', 'nw-31']);
  assert.deepEqual(a.via.map((v) => [v.peerId, v.ref, v.online, v.wake]).sort(), [[21, 'nw-11', true, true], [22, 'nw-31', true, false]]);
  assert.equal(a.wake, true, 'the MAC one gateway knows wakes the device');
  // a device only one gateway sees stays, the twin of the VPN device is kept
  assert.deepEqual(h.devices[1].ports, null);
  assert.deepEqual(h.devices[2].twin, { peerId: 40, address: '10.8.0.40' });
  assert.deepEqual(h.devices[3].via.map((v) => v.peerId), [22]);
});

test('one gateway of the pool offline: „1 von 2“, its devices from the other, the pool online', () => {
  const c = JSON.parse(JSON.stringify(CAND));
  c.gateways[0].online = false;
  c.gateways[0].offlineSince = AN_HOUR;
  const h = homes.of(c)[0];
  assert.deepEqual([h.online, h.onlineCount, h.total, h.peerId], [true, 1, 2, 22]);
  // the entry of the online gateway is the best one
  assert.equal(h.devices[0].ref, 'nw-31');
  // both offline: offline since the later one
  c.gateways[1].online = false;
  c.gateways[1].offlineSince = NOW;
  const off = homes.of(c)[0];
  assert.deepEqual([off.online, off.onlineCount, off.offlineSince], [false, 0, NOW]);
});

test('the same address in another subnet of the pool is another device', () => {
  const c = { gateways: [
    { peerId: 1, name: 'Gateway Eins', online: true, pool: POOL, subnets: ['192.168.1.0/24', '10.20.0.0/16'], devices: [{ ref: 'nw-1', address: '192.168.1.9', ports: [] }] },
    { peerId: 2, name: 'Gateway Zwei', online: true, pool: POOL, subnets: ['192.168.1.0/24'], devices: [{ ref: 'nw-2', address: '192.168.1.9', ports: [] }, { ref: 'nw-3', address: '10.20.1.9', ports: [] }] },
  ] };
  const h = homes.of(c)[0];
  assert.deepEqual(h.devices.map((d) => [d.address, d.refs.length]), [['192.168.1.9', 2], ['10.20.1.9', 1]]);
});

test('gateways without a pool stay sections of their own, unchanged', () => {
  const c = { gateways: [
    { peerId: 1, name: 'Gateway Eins', online: true, subnets: ['192.168.1.0/24'], devices: [{ ref: 'nw-1', name: 'a', address: '192.168.1.9', vendor: 'Muster AG', online: true, lastSeen: NOW, ports: [{ port: 22, service: 'ssh' }], wake: true }] },
    { peerId: 2, name: 'Gateway Zwei', online: true, subnets: ['192.168.1.0/24'], devices: [{ ref: 'nw-2', name: 'b', address: '192.168.1.9', vendor: null, online: true, lastSeen: NOW, ports: [] }] },
  ] };
  const list = homes.of(c);
  assert.deepEqual(list.map((h) => [h.id, h.name, h.pool, h.total, h.devices.length]), [['gw-1', 'Gateway Eins', null, 1, 1], ['gw-2', 'Gateway Zwei', null, 1, 1]]);
  const d = list[0].devices[0];
  assert.deepEqual([d.ref, d.name, d.address, d.vendor, d.online, d.wake], ['nw-1', 'a', '192.168.1.9', 'Muster AG', true, true]);
  assert.deepEqual(d.ports, [{ port: 22, service: 'ssh' }]);
  // a pool of one gateway: the gateway's section and name, the target still the pool
  const one = homes.of({ gateways: [{ ...c.gateways[0], pool: POOL }] })[0];
  assert.deepEqual([one.id, one.name, one.pool.poolId, one.total], ['pool-5', 'Gateway Eins', 5, 1]);
  // free text: two gateways of their own with the same net stay a choice
  assert.equal(way.derive('192.168.1.50', c).choices.length, 2);
});

test('the way into a pool: one choice, the target the pool, an online gateway of it', () => {
  const c = JSON.parse(JSON.stringify(CAND));
  c.gateways[0].online = false;
  const w = way.derive('192.168.77.99', c);
  assert.deepEqual([w.kind, w.choices.length, w.gateway.peerId, w.gateway.pool.poolId], ['gateway', 0, 22, 5]);
  assert.deepEqual(way.accessOf(w, '192.168.77.99', 22), { access_mode: 'gateway', gateway_peer_id: null, gateway_pool_id: 5, external_hostname: null, external_port: null });
  // the one asked for is kept to its pool
  assert.equal(way.derive('192.168.77.99', c, 21).gateway.pool.poolId, 5);
  // a pool and a gateway of its own in the same net: two choices
  c.gateways.push({ peerId: 24, name: 'Gateway Nord', online: true, subnets: ['192.168.77.0/24'], devices: [] });
  assert.deepEqual(way.derive('192.168.77.99', c).choices.map((g) => g.peerId), [22, 24]);
});

const gwSetup = (extra = {}) => setup({ remote: { v7: true, gateways: [{ peerId: 21, name: 'Gateway Ost', online: true }, { peerId: 22, name: 'Gateway West', online: true }, { peerId: 23, name: 'Gartenhaus', online: false }],
  pools: [POOL], candidates: CAND, ...extra } });

test('the list of the wizard carries the home networks; a device of the pool goes through the pool', async () => {
  const { host, adminReq } = await gwSetup();
  try {
    const c = await adminReq('GET', 'candidates');
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.equal(c.gateways.length, 3, 'the gateways as GateControl lists them stay');
    assert.deepEqual(c.homes.map((h) => [h.id, h.devices.length]), [['pool-5', 4], ['gw-23', 1]]);
    assert.ok(!JSON.stringify(c.homes).includes('02:00:00'), 'no MAC');
    // what the wizard sends for a device of the pool: the pool, the port on the server automatic
    const r = await adminReq('POST', 'devices', { name: 'server-a', protocol: 'rdp', access: 'admins',
      config: { host: '192.168.77.10', port: 3389, access_mode: 'gateway', gateway_pool_id: 5, gateway_listen_port: null } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.device.config.gateway_pool_id, r.device.config.gateway_peer_id], [5, null]);
    const l = [...host.remote.listeners.values()].find((x) => x.lanHost === '192.168.77.10');
    assert.deepEqual(l.gateway, { poolId: 5 }, 'the listener goes to the pool (failover), not to one gateway');
    assert.equal(r.device.way.kind, 'gateway');
    assert.equal(r.device.way.pool.poolId, 5);
    // compared with the list again: known in the pool's section
    const again = await adminReq('GET', 'candidates');
    assert.deepEqual(again.known.map((k) => [k.host, k.gatewayPoolId]), [['192.168.77.10', 5]]);
    // free text into the pool's net: the pool, no choice between its gateways
    const ext = await adminReq('POST', 'way', { host: '192.168.77.99', port: 22 });
    assert.deepEqual([ext.way.choices.length, ext.access.gateway_pool_id], [0, 5]);
    // scan and wake through a gateway of the pool, the ref of that gateway
    const s = await adminReq('POST', 'candidates/scan', { host: '192.168.77.10', gatewayPeerId: 22 });
    assert.equal(s.scan.via, 'gateway');
    const wk = await adminReq('POST', 'candidates/wake', { ref: 'nw-11', host: '192.168.77.10', gatewayPeerId: 21 });
    assert.equal(wk.wake.sent, true, JSON.stringify(wk));
  } finally { await host.close(); }
});

// The list of step 1 as the frame builds it (ui/wizard.js in a VM, the DOM helpers stubbed).
function wizardModel() {
  const sandbox = { window: {}, document: {} };
  sandbox.window.RM = { T: (k, p) => k + (p ? ' ' + JSON.stringify(p) : ''), el: (tag, a, kids) => ({ tag, a, kids }), when: (x) => String(x) };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'wizard.js'), 'utf8'), sandbox);
  const plain = (x) => JSON.parse(JSON.stringify(x)); // out of the VM's realm
  const W = sandbox.window.RMW;
  return { model: (c) => plain(W.model(c)), viaOf: (h, d, w) => plain(W.viaOf(h, d, w)) };
}

test('the wizard: one section per pool with its state, each device once, scan and wake through an online gateway', () => {
  const W = wizardModel();
  const c = { ...CAND, homes: homes.of(CAND), known: [] };
  const groups = W.model(c);
  const titles = groups.map((g) => g.title);
  assert.deepEqual(titles.filter((t) => /grp_(pool|gateway)/.test(t)), ['wz.grp_pool {"name":"Mitte"}', 'wz.grp_gateway {"name":"Gartenhaus"}']);
  const pool = groups.find((g) => g.id === 'hpool-5');
  assert.deepEqual(pool.state.a.text, 'wz.pool_online_all {"n":2,"total":2}');
  const rows = pool.rows.concat(pool.more);
  assert.deepEqual(rows.map((r) => r.address).sort(), ['192.168.77.10', '192.168.77.20', '192.168.77.30', '192.168.77.44']);
  const a = rows.find((r) => r.address === '192.168.77.10');
  assert.deepEqual(Object.keys(a.protos).sort(), ['rdp', 'ssh'], 'the ports of both gateways');
  // the VPN device with its twin in the pool
  const vpnRow = groups.find((g) => g.id === 'vpn').rows[0];
  assert.equal(vpnRow.twin.gw.id, 'pool-5');
  assert.equal(vpnRow.twin.dev.address, '192.168.77.20');
  // one gateway down: „1 von 2 online“, scan through the other one, wake through the one that knows the MAC
  const half = JSON.parse(JSON.stringify(CAND));
  half.gateways[0].online = false;
  const h = homes.of(half)[0];
  const g2 = W.model({ ...half, homes: homes.of(half), known: [] }).find((g) => g.id === 'hpool-5');
  assert.equal(g2.state.a.text, 'wz.pool_online_some {"n":1,"total":2}');
  const dev = h.devices.find((d) => d.address === '192.168.77.10');
  assert.deepEqual(W.viaOf(h, dev, false), { peerId: 22, ref: 'nw-31' });
  assert.deepEqual(W.viaOf(h, dev, true), { peerId: 21, ref: 'nw-11' }, 'only Gateway Ost knows the MAC');
  assert.deepEqual(W.viaOf(homes.of(CAND)[0], dev, true), { peerId: 21, ref: 'nw-11' });
  // a known device of the pool is marked in the pool's section
  const known = W.model({ ...CAND, homes: homes.of(CAND), known: [{ id: 'd1', kind: 'device', host: '192.168.77.44', accessMode: 'gateway', gatewayPeerId: null, gatewayPoolId: 5 }] });
  assert.ok(known.find((g) => g.id === 'hpool-5').rows.find((r) => r.address === '192.168.77.44').knownDev);
});
