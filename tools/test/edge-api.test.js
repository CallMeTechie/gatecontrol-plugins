'use strict';

// The mock host's mirror of GateControl 1.228.0 gc.edge (src/services/edge/index.js, the child bootstrap's makeEdge):
// only plugins with an `edge` section, the gateways and the edge part's answers from opts.edge, the host's checks and
// error codes, host.edgeEvent for the edge part's events.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost, hostError } = require('../testing/mock-host');

const EDGE = { entry: 'edge/index.js', memoryMb: 32, capabilities: {} };

/** A plugin folder with plugin.json `manifest` and server/index.js `code` → { dir, done } */
function plugin(manifest, code = 'module.exports = {};') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-plugin-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'edge-test', name: 'E', version: '1.0.0', entry: 'server/index.js', ...manifest }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), code);
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('gc.edge: only with plugin.json edge, from GateControl 1.228.0 or with opts.edge', async () => {
  const p = plugin({ edge: EDGE });
  const none = plugin({});
  try {
    for (const [dir, o, has] of [[p.dir, {}, false], [p.dir, { gatecontrol: '1.228.0' }, true], [p.dir, { edge: {} }, true], [none.dir, { gatecontrol: '1.228.0', edge: {} }, false]]) {
      const h = await createHost(dir, o);
      assert.equal(!!h.gc.edge, has, JSON.stringify(o));
      await h.close();
    }
  } finally { p.done(); none.done(); }
});

test('gc.edge: gateways, call and configure with the host\'s checks and codes', async () => {
  const p = plugin({ edge: EDGE });
  const gateways = [
    { id: 1, name: 'Keller', state: 'running', version: '1.20.0' },
    { id: 2, name: 'Garten', state: 'offline' },
    { id: 3, name: 'Büro', state: 'disabled' },
  ];
  const h = await createHost(p.dir, {
    edge: {
      gateways,
      call: async (gatewayId, method, params, o) => {
        if (method === 'slow') throw hostError('timeout', 'the gateway did not answer in time');
        if (method === 'big') return 'x'.repeat(70 * 1024);
        return { gatewayId, method, params, timeoutMs: o.timeoutMs };
      },
    },
  });
  try {
    assert.deepEqual(await h.gc.edge.gateways(), [
      { id: 1, name: 'Keller', state: 'running', online: true, version: '1.20.0' },
      { id: 2, name: 'Garten', state: 'offline', online: false, version: '1.20.0' },
      { id: 3, name: 'Büro', state: 'disabled', online: true, version: '1.20.0' },
    ]);
    assert.deepEqual(await h.gc.edge.call(1, 'greet', { name: 'Ada' }, { timeoutMs: 99999 }), { gatewayId: 1, method: 'greet', params: { name: 'Ada' }, timeoutMs: 30000 });
    assert.deepEqual(h.edgeCalls, [{ gatewayId: 1, method: 'greet', params: { name: 'Ada' }, timeoutMs: 30000 }]);
    const code = (c) => (e) => e.code === c;
    await assert.rejects(h.gc.edge.call(2, 'greet', {}), code('gateway_offline'));
    await assert.rejects(h.gc.edge.call(3, 'greet', {}), code('not_enabled'));
    await assert.rejects(h.gc.edge.call(9, 'greet', {}), code('not_enabled'));
    await assert.rejects(h.gc.edge.call(0, 'greet', {}), code('ERR_INVALID'));
    await assert.rejects(h.gc.edge.call(1, 'no spaces', {}), code('ERR_INVALID'));
    await assert.rejects(h.gc.edge.call(1, 'slow', {}), code('timeout'));
    await assert.rejects(h.gc.edge.call(1, 'big', {}), code('too_large'));
    await assert.rejects(h.gc.edge.call(1, 'greet', { blob: 'x'.repeat(65 * 1024) }), code('too_large'));

    assert.deepEqual(await h.gc.edge.configure(1, { greeting: 'Moin' }), { sent: true });
    assert.deepEqual(h.edgeConfigs.get(1), { greeting: 'Moin' });
    await assert.rejects(h.gc.edge.configure(2, {}), code('gateway_offline'));
    await assert.rejects(h.gc.edge.configure(1, { blob: 'x'.repeat(49 * 1024) }), code('ERR_INVALID'));
    // the test may change the gateways at any time
    gateways[1].online = true;
    gateways[1].state = 'running';
    assert.deepEqual(await h.gc.edge.configure(2, null), { sent: true });
  } finally { await h.close(); p.done(); }
});

test('gc.edge: without opts.edge.call a call fails like a gateway without the edge part', async () => {
  const p = plugin({ edge: EDGE });
  const h = await createHost(p.dir, { edge: { gateways: [{ id: 4 }] } });
  try {
    await assert.rejects(h.gc.edge.call(4, 'greet', {}), (e) => e.code === 'edge_error' && /^not_running: /.test(e.message));
  } finally { await h.close(); p.done(); }
});

test('gc.edge.on: events after the handlers ran, \'*\' not for built-in ones, a failing handler is logged, off()', async () => {
  const p = plugin({ edge: EDGE });
  const h = await createHost(p.dir, { gatecontrol: '1.228.0' });
  try {
    const got = [];
    const off = h.gc.edge.on('heartbeat', async (ev) => { await new Promise((r) => setImmediate(r)); got.push(['heartbeat', ev]); });
    h.gc.edge.on('*', (ev) => { got.push(['*', ev.name]); });
    h.gc.edge.on('$started', (ev) => { got.push(['$started', ev.gatewayId, ev.seq]); });
    h.gc.edge.on('boom', () => { throw new Error('on purpose'); });
    assert.throws(() => h.gc.edge.on('bad name', () => {}), TypeError);
    assert.throws(() => h.gc.edge.on('x', null), TypeError);

    assert.deepEqual(await h.edgeEvent(1, 'heartbeat', { uptimeS: 5 }, { at: '2026-11-05T10:00:00.000Z', seq: 7 }), { handled: 2 });
    assert.deepEqual(got.shift(), ['heartbeat', { gatewayId: 1, name: 'heartbeat', data: { uptimeS: 5 }, at: '2026-11-05T10:00:00.000Z', seq: 7 }]);
    assert.deepEqual(got.shift(), ['*', 'heartbeat']);
    assert.deepEqual(await h.edgeEvent(1, '$started', { version: '1.0.0' }), { handled: 1 });
    assert.deepEqual(got.shift(), ['$started', 1, null]);
    assert.deepEqual(await h.edgeEvent(1, 'boom', null), { handled: 2 });
    assert.ok(h.logs.some((l) => l.level === 'error' && l.message.startsWith('gc.edge.on(boom) handler failed: on purpose')));
    off();
    got.length = 0;
    assert.deepEqual(await h.edgeEvent(2, 'heartbeat', {}), { handled: 1 });
    assert.deepEqual(got, [['*', 'heartbeat']]);
  } finally { await h.close(); p.done(); }
});

test('gc.mqtt.accounts: only with edge mqtt topics; topics below them, name rules, list without password, remove', async () => {
  const p = plugin({ edge: { ...EDGE, capabilities: { mqtt: { topics: ['shellies/#', 'tasmota/#'] } } } });
  const noTopics = plugin({ edge: EDGE });
  const h = await createHost(p.dir, { edge: { gateways: [{ id: 1, state: 'running' }, { id: 2, state: 'offline' }, { id: 3, state: 'disabled' }] } });
  const code = (c) => (e) => e.code === c;
  try {
    const n = await createHost(noTopics.dir, { edge: { gateways: [{ id: 1 }] } });
    assert.equal(n.gc.mqtt, undefined, 'no gc.mqtt without mqtt topics');
    await n.close();
    const a = await h.gc.mqtt.accounts.create(1, { name: 'Licht-Flur', label: 'Licht Flur', topics: [{ topic: 'shellies/licht-flur/#', access: 'readwrite' }] });
    assert.equal(a.username, 'edge-test-licht-flur');
    assert.match(a.password, /^[A-Za-z0-9_-]{24}$/);
    assert.deepEqual(a.acl, [{ access: 'readwrite', topic: 'shellies/licht-flur/#' }]);
    assert.equal(a.label, 'Licht Flur');
    const b = await h.gc.mqtt.accounts.create(2, { topics: ['tasmota/flur/#'] });
    assert.match(b.username, /^edge-test-[0-9a-f]{8}$/, 'a random name; an offline gateway is fine');
    await assert.rejects(h.gc.mqtt.accounts.create(1, { name: 'licht-flur', topics: ['shellies/licht-flur/#'] }), code('ERR_INVALID'));
    await assert.rejects(h.gc.mqtt.accounts.create(1, { name: 'x', topics: ['devices/x/#'] }), code('denied'));
    await assert.rejects(h.gc.mqtt.accounts.create(1, { name: 'x', topics: [] }), code('ERR_INVALID'));
    await assert.rejects(h.gc.mqtt.accounts.create(1, { name: 'x', topics: ['#'] }), code('ERR_INVALID'));
    await assert.rejects(h.gc.mqtt.accounts.create(1, { name: '-bad', topics: ['shellies/x/#'] }), code('ERR_INVALID'));
    await assert.rejects(h.gc.mqtt.accounts.create(1, { name: 'x'.repeat(25), topics: ['shellies/x/#'] }), code('ERR_INVALID'));
    await assert.rejects(h.gc.mqtt.accounts.create(3, { name: 'x', topics: ['shellies/x/#'] }), code('not_enabled'));
    const list = await h.gc.mqtt.accounts.list(1);
    assert.deepEqual(list.map((x) => [x.username, x.pluginId, x.locked, 'password' in x]), [['edge-test-licht-flur', 'edge-test', false, false]]);
    assert.equal(h.mqttAccounts.get(1).get('edge-test-licht-flur').password, a.password);
    assert.equal(await h.gc.mqtt.accounts.remove(1, 'edge-test-licht-flur'), true);
    assert.equal(await h.gc.mqtt.accounts.remove(1, 'edge-test-licht-flur'), false);
  } finally { await h.close(); p.done(); noTopics.done(); }
});
