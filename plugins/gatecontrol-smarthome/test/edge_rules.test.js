'use strict';

// Logic chains for Shelly and Tasmota devices — the part on the gateway (edge/rules.js, wired in edge/index.js).
// The engine alone with a clock and timers of its own, then the whole edge part against simulated MQTT messages of a
// Shelly Gen2, a Shelly Gen1 H&T and a Tasmota plug (as the devices send them; there is no real device here): a
// message → the chain → the command on the broker, the `fired` event, and the list kept for a restart.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const rules = require('../edge/rules');
const normalize = require('../edge/normalize');

const ENTRY = path.join(__dirname, '..', 'edge', 'index.js');

/** The engine with devices fed like the broker would, a clock and timers the test moves. */
function engine(o = {}) {
  const devices = new Map();
  const sent = [];
  const fired = [];
  const timers = [];
  const clock = { now: o.now || Date.UTC(2026, 10, 11, 12, 0, 0) };
  const e = rules.create({
    device: (base) => devices.get(base) || null,
    publish: async (list) => { if (o.fail) throw Object.assign(new Error('off'), { code: 'mqtt_off' }); sent.push(...list.map((m) => [m.topic, m.payload])); },
    fired: (id, at) => fired.push([id, at]),
    now: () => clock.now,
    setTimer: (fn, ms) => { const t = { fn, at: clock.now + ms, on: true }; timers.push(t); return t; },
    clearTimer: (t) => { t.on = false; },
    log: { warn: (...a) => fired.push(['warn', a.join(' ')]) },
  });
  const feed = (topic, payload) => {
    const r = normalize.parse(topic, Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)));
    if (!r) return false;
    if (!devices.has(r.base)) devices.set(r.base, normalize.newDevice(r.base, r.family));
    normalize.apply(devices.get(r.base), r.patch);
    e.onDevice(r.base);
    return true;
  };
  /** Move the clock; due timers run. */
  const advance = async (ms) => {
    clock.now += ms;
    for (const t of timers.filter((x) => x.on && x.at <= clock.now)) { t.on = false; t.fn(); }
    await new Promise((r) => setImmediate(r));
  };
  const settle = () => new Promise((r) => setImmediate(r));
  return { e, devices, sent, fired, timers, clock, feed, advance, settle };
}

const SW = (on, power) => ({ id: 0, output: on, ...(power === undefined ? {} : { apower: power }) });
const PLUG_ON = { base: 'shellies/flur', ch: 'switch:0', field: 'on', op: 'eq', value: true };
const LAMP = (op, value) => ({ base: 'tasmota/lampe', family: 'tasmota', ch: 'switch:0', op, ...(value === undefined ? {} : { value }) });

test('a rule fires when its trigger BECOMES true — not for what already is, not again while it stays', async () => {
  const x = engine();
  x.feed('shellies/flur/status/switch:0', SW(true));
  assert.equal(x.e.set({ rules: [{ id: 1, triggers: [PLUG_ON], actions: [LAMP('on')] }] }), 1);
  await x.settle();
  assert.deepEqual(x.sent, [], 'on already when the rule arrives: the starting point, nothing fires');
  x.feed('shellies/flur/status/switch:0', SW(true));
  x.feed('shellies/flur/status/switch:0', SW(false));
  await x.settle();
  assert.deepEqual(x.sent, []);
  x.feed('shellies/flur/status/switch:0', SW(true));
  await x.settle();
  assert.deepEqual(x.sent, [['tasmota/lampe/cmnd/POWER1', 'ON']]);
  assert.deepEqual(x.fired.map((f) => f[0]), [1]);
  x.feed('shellies/flur/status/switch:0', SW(true, 40));
  x.feed('shellies/flur/events/rpc', { method: 'NotifyStatus', params: { 'switch:0': { apower: 41 } } });
  await x.settle();
  assert.equal(x.sent.length, 1, 'the same state again (a periodic report) does not fire again');
  x.feed('shellies/flur/status/switch:0', SW(false));
  x.feed('shellies/flur/status/switch:0', SW(true));
  await x.settle();
  assert.equal(x.sent.length, 2, 'off and on again: it fires again');
});

test('a device that reports for the first time only sets the starting point', async () => {
  const x = engine();
  x.e.set({ rules: [{ id: 1, triggers: [PLUG_ON], actions: [LAMP('on')] }] });
  x.feed('shellies/flur/status/switch:0', SW(true)); // the edge part just started, or the device was just added
  await x.settle();
  assert.deepEqual(x.sent, []);
  x.feed('shellies/flur/status/switch:0', SW(false));
  x.feed('shellies/flur/status/switch:0', SW(true));
  await x.settle();
  assert.equal(x.sent.length, 1);
});

test('several triggers: one occurs AND all others are in their state; thresholds of power, temperature and humidity', async () => {
  const x = engine();
  x.e.set({ rules: [
    // "washing machine done": on and below 5 W
    { id: 1, triggers: [PLUG_ON, { base: 'shellies/flur', ch: 'switch:0', field: 'power', op: 'lt', value: 5 }], actions: [LAMP('on')] },
    // "cellar damp": Shelly H&T (Gen1) above 70 % while the Tasmota fan is off
    { id: 2, triggers: [{ base: 'shellies/keller', ch: 'sensor', field: 'humidity', op: 'gt', value: 70 }, { base: 'tasmota/luefter', ch: 'switch:0', field: 'on', op: 'eq', value: false }],
      actions: [{ base: 'tasmota/luefter', family: 'tasmota', ch: 'switch:0', op: 'on' }] },
    // "frost": below 3 °C
    { id: 3, triggers: [{ base: 'shellies/keller', ch: 'sensor', field: 'temperature', op: 'lt', value: 3 }], actions: [LAMP('off')] },
  ] });
  x.feed('shellies/flur/status/switch:0', SW(true, 1800));
  x.feed('shellies/flur/events/rpc', { method: 'NotifyStatus', params: { 'switch:0': { apower: 3.2 } } });
  await x.settle();
  assert.deepEqual(x.sent, [['tasmota/lampe/cmnd/POWER1', 'ON']], 'power falls below the threshold while on');
  x.feed('shellies/flur/status/switch:0', SW(false, 0));
  x.feed('shellies/flur/status/switch:0', SW(false, 0));
  await x.settle();
  assert.equal(x.sent.length, 1, 'off: below 5 W alone is not enough');

  x.feed('shellies/keller/sensor/humidity', '64');
  x.feed('shellies/keller/sensor/temperature', '8.5');
  x.feed('tasmota/luefter/stat/POWER', 'OFF');
  x.feed('shellies/keller/sensor/humidity', '74.5');
  await x.settle();
  assert.deepEqual(x.sent[1], ['tasmota/luefter/cmnd/POWER1', 'ON']);
  x.feed('tasmota/luefter/stat/RESULT', { POWER: 'ON' }); // the fan reports on: the conjunction ends
  x.feed('shellies/keller/sensor/humidity', '78');
  await x.settle();
  assert.equal(x.sent.length, 2);
  x.feed('shellies/keller/sensor/temperature', '2.5');
  await x.settle();
  assert.deepEqual(x.sent[2], ['tasmota/lampe/cmnd/POWER1', 'OFF']);
  assert.deepEqual(x.fired.map((f) => f[0]), [1, 2, 3]);
});

test('actions: switch, dim and move — Shelly Gen2 by RPC, Gen1 and Tasmota by their topics; the family the device reports wins', async () => {
  const x = engine();
  x.e.set({ rules: [{ id: 5, triggers: [PLUG_ON], actions: [
    { base: 'shellies/rollo', family: 'shelly2', ch: 'cover:0', op: 'pos', value: 30 },
    { base: 'shellies/dimmer', family: 'shelly1', ch: 'light:0', op: 'bri', value: 40 },
    { base: 'tasmota/markise', family: 'tasmota', ch: 'cover:0', op: 'close' },
    { base: 'shellies/alt', family: 'shelly2', ch: 'switch:1', op: 'off' }, // set up as Gen2, reports as Gen1
  ] }] });
  x.feed('shellies/alt/relay/1', 'on');
  x.feed('shellies/flur/status/switch:0', SW(false));
  x.feed('shellies/flur/status/switch:0', SW(true));
  await x.settle();
  assert.equal(x.sent.length, 4);
  assert.equal(x.sent[0][0], 'shellies/rollo/rpc');
  assert.deepEqual({ method: JSON.parse(x.sent[0][1]).method, params: JSON.parse(x.sent[0][1]).params }, { method: 'Cover.GoToPosition', params: { id: 0, pos: 30 } });
  assert.deepEqual([x.sent[1][0], JSON.parse(x.sent[1][1])], ['shellies/dimmer/light/0/set', { turn: 'on', brightness: 40 }]);
  assert.deepEqual(x.sent[2], ['tasmota/markise/cmnd/ShutterClose1', '']);
  assert.deepEqual(x.sent[3], ['shellies/alt/relay/1/command', 'off']);
});

test('time window: in the clock of the house (tz), also over midnight; checked when the rule fires', async () => {
  // 12:00 UTC = 13:00 in Berlin (winter)
  const x = engine({ now: Date.UTC(2026, 10, 11, 12, 0, 0) });
  const rule = (window) => ({ id: 1, triggers: [PLUG_ON], actions: [LAMP('on')], window });
  const toggle = async () => { x.feed('shellies/flur/status/switch:0', SW(false)); x.feed('shellies/flur/status/switch:0', SW(true)); await x.settle(); };
  x.e.set({ tz: 'Europe/Berlin', rules: [rule({ from: '13:00', to: '14:00' })] });
  await toggle();
  assert.equal(x.sent.length, 1, '13:00 in Berlin is inside 13:00–14:00');
  x.e.set({ tz: 'UTC', rules: [rule({ from: '13:00', to: '14:00' })] });
  await toggle();
  assert.equal(x.sent.length, 1, '12:00 UTC is outside');
  x.e.set({ tz: 'Europe/Berlin', rules: [rule({ from: '22:00', to: '06:00' })] });
  await toggle();
  assert.equal(x.sent.length, 1, '13:00 is outside 22:00–06:00');
  x.clock.now = Date.UTC(2026, 10, 11, 22, 30, 0); // 23:30 in Berlin
  await toggle();
  assert.equal(x.sent.length, 2, '23:30 is inside the window over midnight');
  assert.equal(rules.inWindow({ from: '22:00', to: '06:00' }, Date.UTC(2026, 10, 12, 4, 59, 0), 'Europe/Berlin'), true, '05:59');
  assert.equal(rules.inWindow({ from: '22:00', to: '06:00' }, Date.UTC(2026, 10, 12, 5, 0, 0), 'Europe/Berlin'), false, '06:00 is out');
  assert.equal(rules.inWindow({ from: '08:00', to: '08:00' }, Date.UTC(2026, 10, 12, 5, 0, 0), 'UTC'), true, 'from = to: the whole day');
  assert.equal(typeof rules.minuteOfDay(Date.now(), 'Not/A_Zone'), 'number', 'an unknown zone falls back to local time');
});

test('delay: the actions run minutes later; a new firing is ignored, restarts the time, or the run is cancelled', async () => {
  const off = { ...PLUG_ON, value: false };
  const mk = (mode) => {
    const x = engine();
    x.e.set({ rules: [{ id: 9, triggers: [off], actions: [LAMP('off')], delay: { minutes: 5, mode } }] });
    x.feed('shellies/flur/status/switch:0', SW(true));
    return x;
  };
  const again = (x) => { x.feed('shellies/flur/status/switch:0', SW(true)); x.feed('shellies/flur/status/switch:0', SW(false)); };

  let x = mk('ignore');
  x.feed('shellies/flur/status/switch:0', SW(false));
  await x.advance(3 * 60000);
  assert.deepEqual(x.sent, [], 'not yet');
  assert.deepEqual(x.e.pending(), [9]);
  again(x); // fires again after 3 minutes: ignored, the first time counts
  await x.advance(2 * 60000);
  assert.deepEqual(x.sent, [['tasmota/lampe/cmnd/POWER1', 'OFF']]);
  assert.deepEqual(x.e.pending(), []);

  x = mk('reset');
  x.feed('shellies/flur/status/switch:0', SW(false));
  await x.advance(3 * 60000);
  again(x); // the five minutes start again
  await x.advance(2 * 60000);
  assert.deepEqual(x.sent, []);
  await x.advance(3 * 60000);
  assert.equal(x.sent.length, 1);

  x = mk('cancel');
  x.feed('shellies/flur/status/switch:0', SW(false));
  await x.advance(60000);
  x.feed('shellies/flur/status/switch:0', SW(true)); // switched on again: the pending run is dropped
  assert.deepEqual(x.e.pending(), []);
  await x.advance(10 * 60000);
  assert.deepEqual(x.sent, []);
  x.feed('shellies/flur/status/switch:0', SW(false));
  await x.advance(5 * 60000);
  assert.equal(x.sent.length, 1, 'off for five minutes: it runs');
});

test('the list: unchanged rules keep their state and timer, changed and removed ones lose it; bad rules never run', async () => {
  const x = engine();
  const r1 = { id: 1, triggers: [{ ...PLUG_ON, value: false }], actions: [LAMP('off')], delay: { minutes: 5, mode: 'ignore' } };
  x.e.set({ rules: [r1] });
  x.feed('shellies/flur/status/switch:0', SW(true));
  x.feed('shellies/flur/status/switch:0', SW(false));
  assert.deepEqual(x.e.pending(), [1]);
  x.e.set({ rules: [JSON.parse(JSON.stringify(r1)), { id: 2, triggers: [PLUG_ON], actions: [LAMP('on')] }] });
  assert.deepEqual(x.e.pending(), [1], 'the same rule again (the server part sends the list after every change): its timer runs on');
  x.e.set({ rules: [{ ...r1, delay: { minutes: 9, mode: 'ignore' } }] });
  assert.deepEqual(x.e.pending(), [], 'changed: the pending run goes');
  await x.advance(20 * 60000);
  assert.deepEqual(x.sent, []);

  const bad = [
    null, { id: 0, triggers: [PLUG_ON], actions: [LAMP('on')] }, { id: 3, triggers: [], actions: [LAMP('on')] }, { id: 3, triggers: [PLUG_ON], actions: [] },
    { id: 3, triggers: [{ ...PLUG_ON, base: 'zigbee2mqtt/x' }], actions: [LAMP('on')] },          // not a topic of ours
    { id: 3, triggers: [{ ...PLUG_ON, field: 'humidity', op: 'gt', value: 5 }], actions: [LAMP('on')] }, // a switch has no humidity
    { id: 3, triggers: [{ ...PLUG_ON, value: 'yes' }], actions: [LAMP('on')] },
    { id: 3, triggers: [PLUG_ON], actions: [LAMP('explode')] },
    { id: 3, triggers: [PLUG_ON], actions: [{ ...LAMP('on'), base: 'tasmota/a/cmnd/x' }] },
    { id: 3, triggers: [PLUG_ON], actions: [LAMP('on')], window: { from: '25:00', to: '06:00' } },
    { id: 3, triggers: [PLUG_ON], actions: [LAMP('on')], delay: { minutes: 0 } },
    { id: 3, triggers: [PLUG_ON, { nonsense: true }], actions: [LAMP('on')] },                   // one bad part: the whole rule is out
  ];
  for (const r of bad) assert.equal(rules.cleanRule(r), null, JSON.stringify(r));
  assert.equal(x.e.set({ rules: bad }), 0);
  assert.equal(x.e.set({ rules: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, triggers: [PLUG_ON], actions: [LAMP('on')] })) }), rules.MAX_RULES);
  assert.equal(x.e.set(null), 0);
  x.e.stop();
});

test('a broker that is off: the chain is not marked as run, a warning instead of a crash', async () => {
  const x = engine({ fail: true });
  x.e.set({ rules: [{ id: 1, triggers: [PLUG_ON], actions: [LAMP('on')] }] });
  x.feed('shellies/flur/status/switch:0', SW(false));
  x.feed('shellies/flur/status/switch:0', SW(true));
  await x.settle();
  assert.deepEqual(x.fired, [['warn', 'logic chain 1 could not switch (mqtt_off)']]);
});

// ─── the edge part (edge/index.js) with a fake gc and simulated MQTT ───

function load({ stored = null, mqttOff = false } = {}) {
  delete require.cache[require.resolve(ENTRY)];
  const part = require(ENTRY);
  const handlers = new Map();
  const listeners = [];
  const events = [];
  const logs = [];
  const published = [];
  const subs = [];
  const store = new Map(stored ? [['rules', stored]] : []);
  const storeWrites = [];
  const state = { config: null };
  const gc = Object.freeze({
    id: 'gatecontrol-smarthome', version: '1.10.0',
    handle: (m, fn) => handlers.set(m, fn),
    emit: (name, data) => events.push({ name, data: JSON.parse(JSON.stringify(data)) }),
    config: () => state.config,
    onConfig: (fn) => listeners.push(fn),
    log: Object.freeze({ info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) }),
    store: Object.freeze({
      get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
      set: async (k, v) => { storeWrites.push([k, JSON.parse(JSON.stringify(v))]); store.set(k, JSON.parse(JSON.stringify(v))); },
      delete: async (k) => { store.delete(k); },
    }),
    lan: Object.freeze({ http: Object.freeze({ request: async () => { throw Object.assign(new Error('x'), { code: 'net_error' }); } }), mdns: Object.freeze({ browse: async () => ({ stop: async () => {} }) }) }),
    mqtt: Object.freeze({
      subscribe: async (topic, fn) => {
        if (mqttOff) throw Object.assign(new Error('MQTT is not enabled on this gateway'), { code: 'not_enabled' });
        const s = { topic, fn, on: true };
        subs.push(s);
        return { unsubscribe: async () => { s.on = false; } };
      },
      publish: async (topic, payload) => { published.push([topic, String(payload)]); },
    }),
  });
  return {
    part, gc, events, logs, published, store, storeWrites,
    call: async (method, params) => handlers.get(method)(params === undefined ? null : params, gc),
    configure(data) { state.config = data; for (const fn of listeners) fn(data, gc); },
    deliver(topic, payload) {
      for (const s of subs) if (s.on && topic.startsWith(s.topic.replace(/#$/, ''))) s.fn(topic, Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)), { retain: false, qos: 0 });
    },
  };
}

const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const CONFIG = {
  devices: [{ base: 'shellies/flur', family: 'shelly2' }, { base: 'tasmota/lampe', family: 'tasmota' }, { base: 'shellies/keller', family: 'shelly1' }],
  rules: [
    { id: 11, triggers: [PLUG_ON], actions: [LAMP('on')], window: null, delay: null },
    { id: 12, triggers: [{ base: 'tasmota/lampe', ch: 'switch:0', field: 'power', op: 'gt', value: 100 }], actions: [{ base: 'shellies/flur', family: 'shelly2', ch: 'switch:0', op: 'off' }], window: null, delay: null },
  ],
  tz: 'Europe/Berlin',
};

test('edge part: a message of the broker runs the chain — the command goes out at once, `fired` with the next bundle', async () => {
  const e = load();
  e.part.start(e.gc);
  try {
    await tick();
    e.configure(CONFIG);
    await tick();
    assert.equal((await e.call('info')).rules, 2);
    e.published.length = 0;
    e.deliver('shellies/flur/status/switch:0', SW(false, 0));
    e.deliver('shellies/flur/status/switch:0', SW(true, 12));
    await tick();
    assert.deepEqual(e.published, [['tasmota/lampe/cmnd/POWER1', 'ON']], 'no round trip to the server');
    // Tasmota: tele/SENSOR with ENERGY — above 100 W switches the Shelly off by RPC
    e.deliver('tasmota/lampe/tele/SENSOR', { Time: '2026-11-11T12:00:00', ENERGY: { Power: 60, Today: 0.2 } });
    e.deliver('tasmota/lampe/tele/SENSOR', { Time: '2026-11-11T12:00:10', ENERGY: { Power: 140, Today: 0.2 } });
    await tick();
    assert.equal(e.published.length, 2);
    assert.equal(e.published[1][0], 'shellies/flur/rpc');
    assert.deepEqual(JSON.parse(e.published[1][1]).params, { id: 0, on: false });
    e.part._test.flush();
    const fired = e.events.filter((x) => x.name === 'fired');
    assert.equal(fired.length, 1);
    assert.deepEqual(fired[0].data.rules.map((r) => r.id), [11, 12]);
    assert.ok(Number.isFinite(Date.parse(fired[0].data.rules[0].at)));
    assert.ok(e.events.some((x) => x.name === 'states'), 'the states go to the server as before');
    e.part._test.flush();
    assert.equal(e.events.filter((x) => x.name === 'fired').length, 1, 'reported once');
    // the server part takes a rule away: it no longer runs
    e.configure({ ...CONFIG, rules: [CONFIG.rules[1]] });
    e.published.length = 0;
    e.deliver('shellies/flur/status/switch:0', SW(false, 0));
    e.deliver('shellies/flur/status/switch:0', SW(true, 12));
    await tick();
    assert.deepEqual(e.published, []);
  } finally { e.part.stop(e.gc); }
});

test('edge part: the list is kept for a restart (only when it changed) and runs before the server is back', async () => {
  const e = load();
  e.part.start(e.gc);
  await tick();
  e.configure(CONFIG);
  await tick();
  assert.equal(e.storeWrites.length, 1);
  assert.deepEqual(e.storeWrites[0], ['rules', { rules: CONFIG.rules, tz: 'Europe/Berlin' }]);
  assert.ok(!JSON.stringify(e.storeWrites).includes('pass'), 'rules only: no account, no password');
  e.configure(JSON.parse(JSON.stringify(CONFIG)));
  await tick();
  assert.equal(e.storeWrites.length, 1, 'the same list again is not written');
  const kept = e.store.get('rules');
  e.part.stop(e.gc);

  // the gateway restarts, the server is away: no configuration, the kept list runs
  const f = load({ stored: kept });
  f.part.start(f.gc);
  try {
    await tick();
    assert.equal((await f.call('info')).rules, 2);
    f.deliver('shellies/flur/status/switch:0', SW(false));
    f.deliver('shellies/flur/status/switch:0', SW(true));
    await tick();
    assert.deepEqual(f.published, [['tasmota/lampe/cmnd/POWER1', 'ON']]);
    assert.deepEqual(f.storeWrites, [], 'nothing written for a restart');
    // the server is back with a shorter list: that one counts and is kept
    f.configure({ devices: CONFIG.devices, rules: [], tz: 'Europe/Berlin' });
    await tick();
    assert.equal((await f.call('info')).rules, 0);
    assert.deepEqual(f.storeWrites, [['rules', { rules: [], tz: null }]]);
  } finally { f.part.stop(f.gc); }

  // an older server part sends no rules at all: none run, an empty store stays untouched
  const g = load();
  g.part.start(g.gc);
  try {
    await tick();
    g.configure({ devices: CONFIG.devices });
    await tick();
    assert.equal((await g.call('info')).rules, 0);
    assert.deepEqual(g.storeWrites, []);
  } finally { g.part.stop(g.gc); }
});

test('edge part: with the broker off nothing is heard and nothing is switched; the list is there for when MQTT comes on', async () => {
  const e = load({ mqttOff: true });
  e.part.start(e.gc);
  try {
    await tick();
    e.configure(CONFIG);
    await tick();
    assert.equal((await e.call('info')).mqtt, 'off');
    assert.equal((await e.call('info')).rules, 2);
    assert.deepEqual(e.published, []);
  } finally { e.part.stop(e.gc); }
});
