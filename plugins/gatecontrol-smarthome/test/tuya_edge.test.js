'use strict';

// Tuya in the edge part (edge/index.js, since 1.21.0) with a `gc` shaped like the gateway's (gc.lan.tcp / gc.lan.udp,
// gc.gateway, gc.store) and the independent device of test/fixtures/tuya_device.js: the configuration with the keys,
// the state for the server part, commands without MQTT, the logic chains in both directions, the broadcasts and the
// scan, the list kept for a restart without the server.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tuyaDevice, broadcast } = require('./fixtures/tuya_device');

const ENTRY = path.join(__dirname, '..', 'edge', 'index.js');
const KEY = 'k3y-0f-the-test!';
const PLUG_ID = 'bf00test000plug0001';
const LAMP_ID = 'bf00test000lamp0001';
const PLUG = { k: 'plug', sw: [1], pw: 19, pws: 1 };
const LAMP = { k: 'light', l: { v: 2, sw: 20, mode: 21, bri: 22, temp: 23, col: 24, scene: 25, bmin: 10, bmax: 1000, tmax: 1000 } };

function load({ stored = {}, devices = new Map(), mqtt = true, udpDenied = false, tcpDenied = false } = {}) {
  delete require.cache[require.resolve(ENTRY)];
  const part = require(ENTRY);
  const handlers = new Map();
  const listeners = [];
  const events = [];
  const published = [];
  const subs = [];
  const udp = new Map();
  const sent = [];
  const warned = [];
  const store = new Map(Object.entries(stored));
  const state = { config: null };
  const gc = Object.freeze({
    id: 'gatecontrol-smarthome', version: '1.21.0',
    gateway: Object.freeze({ version: '1.49.0', features: ['edge-optional-lan'], limits: Object.freeze({ tcpConnections: 64, udpSockets: 16, udpDatagramBytes: 8192 }) }),
    handle: (m, fn) => handlers.set(m, fn),
    emit: (name, data) => events.push({ name, data: JSON.parse(JSON.stringify(data)) }),
    config: () => state.config,
    onConfig: (fn) => listeners.push(fn),
    log: Object.freeze({ info: () => {}, warn: (...a) => warned.push(a.join(' ')), error: () => {} }),
    store: Object.freeze({
      get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
      set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); },
      delete: async (k) => { store.delete(k); },
    }),
    lan: Object.freeze({
      http: Object.freeze({ request: async () => { throw Object.assign(new Error('x'), { code: 'net_error' }); } }),
      mdns: Object.freeze({ browse: async () => ({ stop: async () => {} }) }),
      tcp: Object.freeze({ connect: async (ip, port) => {
        assert.equal(port, 6668);
        if (tcpDenied) throw Object.assign(new Error('not granted'), { code: 'denied' });
        const d = devices.get(ip);
        if (!d) throw Object.assign(new Error('unreachable'), { code: 'net_error' });
        return d.connect();
      } }),
      udp: Object.freeze({
        bind: async (port, opts, fn) => {
          if (udpDenied) throw Object.assign(new Error('not granted'), { code: 'denied' });
          udp.set(port, fn);
          return { port, send: async (host, p, buf) => { sent.push({ from: port, host, port: p, buf }); }, close: () => udp.delete(port) };
        },
        send: async (host, p, buf) => { sent.push({ from: null, host, port: p, buf }); },
      }),
    }),
    mqtt: Object.freeze({
      subscribe: async (topic, fn) => {
        if (!mqtt) throw Object.assign(new Error('MQTT off'), { code: 'not_enabled' });
        const s = { topic, fn, on: true }; subs.push(s); return { unsubscribe: async () => { s.on = false; } };
      },
      publish: async (topic, payload) => { published.push([topic, String(payload)]); },
    }),
  });
  return {
    part, gc, events, published, store, udp, sent, warned,
    call: async (method, params) => handlers.get(method)(params === undefined ? null : params, gc),
    configure(data) { state.config = data; for (const fn of listeners) fn(data, gc); },
    deliver(topic, payload) {
      for (const s of subs) if (s.on && topic.startsWith(s.topic.replace(/#$/, ''))) s.fn(topic, Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)), { retain: false, qos: 0 });
    },
  };
}
const tick = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

const TUYA = [
  { id: PLUG_ID, key: KEY, hint: '192.168.1.41', ver: '3.3', p: PLUG },
  { id: LAMP_ID, key: KEY, ip: '192.168.1.55', ver: '3.5', p: LAMP },
];
const CONFIG = {
  devices: [{ base: `tuya/${PLUG_ID}`, family: 'tuya' }, { base: `tuya/${LAMP_ID}`, family: 'tuya' }, { base: 'shellies/flur', family: 'shelly2' }, { base: 'shellies/taster1', family: 'shelly1' }],
  rules: [
    // a press of a Shelly button switches the Tuya plug; the Tuya plug going on switches the Shelly light
    { id: 1, v: 2, when: [{ k: 'btn', base: 'shellies/taster1', input: 0, ev: 'single' }], cond: { mode: 'all', list: [] }, steps: [{ k: 'act', base: `tuya/${PLUG_ID}`, family: 'tuya', ch: 'switch:0', op: 'on' }], re: 'restart' },
    { id: 2, v: 2, when: [{ k: 'dev', base: `tuya/${PLUG_ID}`, ch: 'switch:0', field: 'power', op: 'gt', value: 100 }], cond: { mode: 'all', list: [] }, steps: [{ k: 'act', base: 'shellies/flur', family: 'shelly2', ch: 'light:0', op: 'on' }], re: 'restart' },
  ],
  tz: 'Europe/Berlin',
  tuya: TUYA,
};

function house() {
  const plug = tuyaDevice({ id: PLUG_ID, key: KEY, ver: '3.3', dps: { 1: false, 19: 0 } });
  const lamp = tuyaDevice({ id: LAMP_ID, key: KEY, ver: '3.5', dps: { 20: true, 21: 'white', 22: 1000, 23: 500, 24: '000003e803e8', 25: '' } });
  return { plug, lamp, devices: new Map([['192.168.1.41', plug], ['192.168.1.55', lamp]]) };
}

test('Tuya devices: connected from the configuration, their state for the server part, commands without the broker', async () => {
  const h = house();
  const e = load({ devices: h.devices, mqtt: false });
  e.part.start(e.gc);
  try {
    e.configure(CONFIG);
    await tick();
    e.part._test.flush();
    const states = e.events.filter((x) => x.name === 'states').flatMap((x) => x.data.devices);
    const plug = states.find((s) => s.base === `tuya/${PLUG_ID}`);
    assert.deepEqual([plug.family, plug.online, plug.ch['switch:0'], plug.info], ['tuya', true, { on: false, power: 0 }, { ip: '192.168.1.41', tuya: 'ok', ver: '3.3' }]);
    const lamp = states.find((s) => s.base === `tuya/${LAMP_ID}`);
    assert.deepEqual(lamp.ch['light:0'], { on: true, cm: 'ct', bri: 100, ct: Math.round(1e6 / 4600) });
    // a command: no MQTT needed (the broker of this gateway is off)
    assert.deepEqual(await e.call('command', { base: `tuya/${PLUG_ID}`, family: 'tuya', ch: 'switch:0', op: 'on' }), { sent: 1 });
    await e.call('command', { base: `tuya/${LAMP_ID}`, family: 'tuya', ch: 'light:0', op: 'color', value: { hue: 0, sat: 254 } });
    await e.call('command', { base: `tuya/${LAMP_ID}`, family: 'tuya', ch: 'light:0', op: 'scene', value: 'read' });
    await tick();
    assert.equal(h.plug.dps['1'], true);
    assert.equal(h.lamp.dps['21'], 'scene');
    assert.equal(h.lamp.dps['24'], '000003e803e8', 'the colour of 100 % red');
    await assert.rejects(e.call('command', { base: `tuya/${PLUG_ID}`, family: 'tuya', ch: 'light:0', op: 'on' }), (x) => x.code === 'bad_command');
    await assert.rejects(e.call('command', { base: 'shellies/flur', family: 'shelly2', ch: 'light:0', op: 'on' }), (x) => x.code === 'mqtt_off', 'Shelly still needs the broker');
    // the edge part keeps the list with the keys for a restart (gc.store `tuya`)
    assert.deepEqual(e.store.get('tuya').map((d) => [d.id, d.key, d.ip, d.hint]), [[PLUG_ID, KEY, null, '192.168.1.41'], [LAMP_ID, KEY, '192.168.1.55', null]]);
    const info = await e.call('info');
    assert.deepEqual(info.tuya, { devices: 2, max: 60, udp: 'ok' });
    assert.deepEqual((await e.call('tuya.status')).devices.map((d) => [d.id, d.link]), [[PLUG_ID, 'ok'], [LAMP_ID, 'ok']]);
  } finally { e.part.stop(); }
});

test('logic chains on the gateway: a Shelly press switches the Tuya plug, the plug drawing power switches a Shelly light', async () => {
  const h = house();
  const e = load({ devices: h.devices });
  e.part.start(e.gc);
  try {
    await tick();
    e.configure(CONFIG);
    await tick();
    e.deliver('shellies/taster1/input_event/0', { event: 'S', event_cnt: 1 });
    await tick();
    assert.equal(h.plug.dps['1'], true, 'chain 1 switched the plug over its TCP connection');
    e.published.length = 0;
    h.plug.push({ 19: 2500 }); // the washing machine starts: 250 W
    await tick();
    assert.deepEqual(e.published.map((p) => p[0]), ['shellies/flur/rpc'], 'chain 2 switched the Shelly light');
    e.part._test.flush();
    const fired = e.events.filter((x) => x.name === 'fired').flatMap((x) => x.data.rules.map((r) => r.id));
    assert.deepEqual(fired, [1, 2], 'both chains ran on the gateway');
    const runs = e.events.filter((x) => x.name === 'runs').flatMap((x) => x.data.runs);
    assert.deepEqual(runs.map((r) => [r.r, r.res]), [[1, 'ok']], 'chain 1 done (the plug reported "on"); chain 2 waits for the Shelly light to report');
  } finally { e.part.stop(); }
});

test('after a restart without the server: the stored list; broadcasts give a device without an address its address; the scan', async () => {
  const h = house();
  const first = load({ devices: h.devices });
  first.part.start(first.gc);
  first.configure({ ...CONFIG, tuya: [{ id: PLUG_ID, key: KEY, p: PLUG }] });
  await tick();
  first.part.stop();
  const stored = Object.fromEntries(first.store);
  assert.deepEqual(stored.tuya.map((d) => d.id), [PLUG_ID]);
  // the gateway restarts; the server is away (no configuration)
  const e = load({ devices: h.devices, stored });
  e.part.start(e.gc);
  try {
    await tick();
    assert.deepEqual((await e.call('tuya.status')).devices, [{ id: PLUG_ID, link: 'searching', ip: null, ver: null }]);
    assert.deepEqual([...e.udp.keys()].sort(), [6666, 6667, 7000], 'the broadcast ports are bound');
    e.udp.get(6667)(broadcast('3.3', { id: PLUG_ID, ip: '192.168.1.41' }), { address: '192.168.1.41', port: 6667 });
    await tick();
    assert.deepEqual((await e.call('tuya.status')).devices, [{ id: PLUG_ID, link: 'ok', ip: '192.168.1.41', ver: '3.3' }]);
    // the set-up's scan: a 3.5 device that answers the request to port 7000
    const alive = setInterval(() => {}, 50); // the edge part's own timer does not keep a test alive (unref)
    const scan = e.call('tuya.scan', { seconds: 1 }).finally(() => clearInterval(alive));
    await tick();
    const req = e.sent.find((x) => x.port === 7000 && x.host === '255.255.255.255');
    assert.ok(req, 'the request went out as a broadcast from the bound port 7000');
    e.udp.get(7000)(broadcast('3.5', { id: LAMP_ID, ip: '192.168.1.55' }), { address: '192.168.1.55', port: 7000 });
    const r = await scan;
    assert.equal(r.udp, 'ok');
    assert.deepEqual(r.found.map((f) => [f.id, f.ip, f.ver]).sort(), [[LAMP_ID, '192.168.1.55', '3.5'], [PLUG_ID, '192.168.1.41', '3.3']]);
  } finally { e.part.stop(); }
});

test('without the optional rights: UDP and TCP denied — the device says so, Shelly goes on, the scan says so', async () => {
  const e = load({ udpDenied: true, tcpDenied: true });
  e.part.start(e.gc);
  try {
    e.configure({ ...CONFIG, tuya: [{ id: PLUG_ID, key: KEY, ip: '192.168.1.41', p: PLUG }] });
    await tick();
    assert.equal((await e.call('tuya.status')).devices[0].link, 'denied');
    const r = await e.call('tuya.scan', { seconds: 1 });
    assert.deepEqual([r.udp, r.denied, r.found], ['denied', true, []]);
    assert.ok(e.warned.some((w) => /not granted yet/.test(w)));
    e.deliver('shellies/taster1/input_event/0', { event: 'S', event_cnt: 1 });
    await tick();
    await assert.rejects(e.call('command', { base: `tuya/${PLUG_ID}`, family: 'tuya', ch: 'switch:0', op: 'on' }), (x) => x.code === 'tuya_offline');
    assert.equal((await e.call('command', { base: 'shellies/flur', family: 'shelly2', ch: 'light:0', op: 'on' })).sent, 1);
  } finally { e.part.stop(); }
});
