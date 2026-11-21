'use strict';

// Logikketten Stufe 1 (1.11.0) — the part on the gateway: button presses in edge/normalize.js (events, not states),
// the version 2 engine of edge/rules.js (WENN · NUR WENN · DANN, waits, retrigger, clock, brakes, run records,
// Testlauf) and edge/index.js (the ring of runs, `runs` / `test` handlers, a Gen1 press is not counted twice).
// Simulated MQTT messages as the devices send them; a clock and timers the test moves.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const rules = require('../edge/rules');
const normalize = require('../edge/normalize');

const ENTRY = path.join(__dirname, '..', 'edge', 'index.js');
const T0 = Date.UTC(2026, 10, 18, 11, 0, 0); // Wednesday 12:00 in Europe/Berlin

function engine(o = {}) {
  const devices = new Map();
  const sent = [];
  const runs = new Map();
  const order = [];
  const fired = [];
  const timers = [];
  const logs = [];
  const clock = { now: o.now || T0 };
  const e = rules.create({
    device: (base) => devices.get(base) || null,
    publish: async (list) => { if (o.fail) throw Object.assign(new Error('off'), { code: 'mqtt_off' }); sent.push(...list.map((m) => [m.topic, m.payload])); },
    fired: (id, at) => fired.push([id, at]),
    record: (r) => { runs.set(r.u, r); order.push(r); },
    now: () => clock.now,
    setTimer: (fn, ms) => { const t = { fn, at: clock.now + ms, on: true }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.on = false; },
    log: { warn: (...a) => logs.push(a.join(' ')) },
  });
  const feed = (topic, payload) => {
    const r = normalize.parse(topic, Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)));
    if (!r) return null;
    if (!devices.has(r.base)) devices.set(r.base, normalize.newDevice(r.base, r.family));
    normalize.apply(devices.get(r.base), r.patch);
    e.onDevice(r.base);
    if (r.events) e.onEvent(r.base, r.events);
    return r;
  };
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const advance = async (ms) => {
    await settle(); // what is still on its way (a publish) sets its timers first
    const until = clock.now + ms;
    for (;;) {
      const due = timers.filter((x) => x.on && x.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock.now = Math.max(clock.now, due.at);
      due.on = false;
      due.fn();
      await settle();
    }
    clock.now = until;
    await settle();
  };
  return { e, devices, sent, runs, order, fired, timers, logs, clock, feed, settle, advance, list: () => [...runs.values()] };
}

const SW = (on, power) => ({ id: 0, output: on, ...(power === undefined ? {} : { apower: power }) });
const PRESS = (event, component = 'input:1') => ({ src: 'shellyplusi4-a1', method: 'NotifyEvent', params: { ts: 1, events: [{ component, id: 1, event, ts: 1 }] } });
const BTN = { k: 'btn', base: 'shellies/taster', input: 1, ev: 'single' };
const LAMP = (op, value) => ({ k: 'act', base: 'shellies/flur', family: 'shelly2', ch: 'light:0', op, ...(value === undefined ? {} : { value }) });
const WAIT = (s) => ({ k: 'wait', s });
const chain = (o) => ({ id: 1, v: 2, when: [BTN], cond: { mode: 'all', list: [] }, steps: [LAMP('on')], re: 'restart', ...o });
const LIGHT_STATE = (on, bri) => ['shellies/flur/status/light:0', { id: 0, output: on, brightness: bri }];

// ─── normalize: presses are events ───

test('normalize: Shelly Gen1 input_event, Gen2+ NotifyEvent and Tasmota Button actions are events — never a state', () => {
  const g1 = normalize.parse('shellies/taster1/input_event/0', Buffer.from(JSON.stringify({ event: 'SS', event_cnt: 7 })));
  assert.deepEqual(g1, { base: 'shellies/taster1', family: 'shelly1', patch: {}, events: [{ input: 0, ev: 'double', cnt: 7 }] });
  assert.deepEqual(normalize.parse('shellies/taster1/input_event/1', Buffer.from('{"event":"L","event_cnt":2}')).events, [{ input: 1, ev: 'long', cnt: 2 }]);
  assert.equal(normalize.parse('shellies/taster1/input_event/0', Buffer.from('{"event":"","event_cnt":0}')), null, 'no press yet (after a restart)');
  assert.equal(normalize.parse('shellies/taster1/input/0', Buffer.from('1')), null, 'the input state stays ignored');

  const g2 = normalize.parse('shellies/taster/events/rpc', Buffer.from(JSON.stringify({ method: 'NotifyEvent', params: { ts: 1, events: [
    { component: 'input:0', id: 0, event: 'single_push' }, { component: 'input:3', id: 3, event: 'triple_push' }, { component: 'input:2', id: 2, event: 'btn_down' }, { component: 'sys', event: 'ota_progress' },
  ] } })));
  assert.deepEqual(g2.events, [{ input: 0, ev: 'single' }, { input: 3, ev: 'triple' }]);
  assert.deepEqual(g2.patch, {});
  assert.equal(normalize.parse('shellies/taster/events/rpc', Buffer.from(JSON.stringify(PRESS('btn_up')))), null);

  const tas = normalize.parse('tasmota/schalter/stat/RESULT', Buffer.from(JSON.stringify({ Button2: { Action: 'HOLD' } })));
  assert.deepEqual(tas, { base: 'tasmota/schalter', family: 'tasmota', patch: {}, events: [{ input: 1, ev: 'long' }] });
  const both = normalize.parse('tasmota/schalter/stat/RESULT', Buffer.from(JSON.stringify({ POWER1: 'ON', Button1: { Action: 'SINGLE' } })));
  assert.deepEqual([both.patch.tasmota.power, both.events], [{ 1: true }, [{ input: 0, ev: 'single' }]]);
  assert.equal(normalize.parse('tasmota/schalter/stat/RESULT', Buffer.from(JSON.stringify({ Button1: { Action: 'CLEAR' } }))), null);

  const dev = normalize.newDevice('shellies/taster', 'shelly2');
  normalize.apply(dev, g2.patch);
  assert.deepEqual(normalize.snapshot(dev).ch, {}, 'a press changes no state');
});

// ─── the engine, version 2 ───

test('v2: a button press runs the steps in order — switch, wait, switch; the run record tells what happened', async () => {
  const x = engine();
  assert.equal(x.e.set({ rules: [chain({ steps: [LAMP('bri', 60), WAIT(180), LAMP('off')] })], tz: 'Europe/Berlin' }), 1);
  x.feed(...LIGHT_STATE(false, 10));
  x.feed('shellies/taster/events/rpc', PRESS('double_push'));
  await x.settle();
  assert.deepEqual(x.sent, [], 'another press');
  x.feed('shellies/taster/events/rpc', PRESS('single_push'));
  await x.settle();
  assert.equal(x.sent.length, 1);
  assert.deepEqual(JSON.parse(x.sent[0][1]).params, { id: 0, on: true, brightness: 60 });
  assert.equal(x.list()[0].res, 'running', 'a run that waits shows up as running');
  x.feed(...LIGHT_STATE(true, 60));
  await x.advance(179000);
  assert.equal(x.sent.length, 1);
  await x.advance(1000);
  assert.deepEqual(JSON.parse(x.sent[1][1]).params, { id: 0, on: false });
  x.feed(...LIGHT_STATE(false, 60));
  await x.settle();
  const run = x.list()[0];
  assert.equal(run.res, 'ok');
  assert.deepEqual(run.ev.map((e) => [e[1], e[2]]), [['trig', 0], ['cond', 'ok'], ['act', 0], ['wait', 1], ['ack', 0], ['waited', 1], ['act', 2], ['ack', 2]]);
  assert.equal(run.ev[5][0], 180000, 'ms since the start');
  assert.deepEqual([run.by, run.tr, run.r], ['event', 0, 1]);
  assert.ok(run.end);
  assert.deepEqual(x.fired.map((f) => f[0]), [1]);
});

test('v2 retrigger: restart starts from the first step; ignore lets the run go on; cancel stops once NUR WENN no longer holds', async () => {
  const steps = [LAMP('on'), WAIT(60), LAMP('off')];
  const r = engine();
  r.e.set({ rules: [chain({ steps, re: 'restart' })] });
  r.feed('shellies/taster/events/rpc', PRESS('single_push'));
  await r.advance(50000);
  r.feed('shellies/taster/events/rpc', PRESS('single_push'));
  await r.advance(50000);
  assert.equal(r.sent.length, 2, 'on, on again — no off yet: the wait started anew');
  await r.advance(10000);
  assert.equal(r.sent.length, 3);
  await r.advance(5000); // the record goes out once the devices answered (or did not)
  assert.equal(r.list().length, 1, 'one run, restarted');
  assert.ok(r.list()[0].ev.some((e) => e[1] === 'restart'));

  const i = engine();
  i.e.set({ rules: [chain({ steps, re: 'ignore' })] });
  i.feed('shellies/taster/events/rpc', PRESS('single_push'));
  await i.advance(50000);
  i.feed('shellies/taster/events/rpc', PRESS('single_push'));
  await i.advance(10000);
  assert.equal(i.sent.length, 2, 'on … off after 60 s, the second press changed nothing');

  const c = engine();
  const cond = { mode: 'all', list: [{ k: 'dev', base: 'shellies/tuer', ch: 'switch:0', field: 'on', op: 'eq', value: true }] };
  c.e.set({ rules: [chain({ steps, re: 'cancel', cond })] });
  c.feed('shellies/tuer/status/switch:0', SW(true));
  c.feed('shellies/taster/events/rpc', PRESS('single_push'));
  await c.advance(20000);
  c.feed('shellies/tuer/status/switch:0', SW(false));
  await c.advance(60000);
  assert.equal(c.sent.length, 1, 'the off step never came');
  assert.deepEqual([c.list()[0].res, c.list()[0].why], ['cancel', 'cond']);
});

test('v2 NUR WENN: all (UND) and one (ODER); time between, weekdays; unknown devices skip; a skip is recorded', async () => {
  const dev = { k: 'dev', base: 'shellies/wz', ch: 'switch:0', field: 'on', op: 'eq', value: false };
  const x = engine();
  x.e.set({ rules: [
    chain({ id: 1, cond: { mode: 'all', list: [dev, { k: 'time', from: '11:00', to: '13:00' }, { k: 'days', days: [1, 2, 3, 4, 5] }] } }),
    chain({ id: 2, cond: { mode: 'any', list: [dev, { k: 'days', days: [6, 7] }] } }),
  ], tz: 'Europe/Berlin' });
  x.feed(...LIGHT_STATE(true, 50)); // the lamp is on already: the command needs no confirmation
  x.feed('shellies/taster/events/rpc', PRESS('single_push'));
  await x.settle();
  assert.deepEqual(x.list().map((r) => [r.r, r.res, r.why]), [[1, 'skip', 'unknown'], [2, 'skip', 'unknown']], 'Wohnzimmer has not reported yet');
  x.feed('shellies/wz/status/switch:0', SW(true));
  x.feed('shellies/taster/events/rpc', PRESS('single_push'));
  await x.settle();
  assert.deepEqual(x.order.slice(2).map((r) => [r.r, r.res, r.why]), [[1, 'skip', 'cond:0'], [2, 'skip', 'cond:0']]);
  x.feed('shellies/wz/status/switch:0', SW(false));
  x.feed('shellies/taster/events/rpc', PRESS('single_push'));
  await x.settle();
  assert.deepEqual(x.order.slice(4).map((r) => [r.r, r.res]), [[1, 'ok'], [2, 'ok']]);
  assert.equal(x.sent.length, 2, 'both ran: Wednesday 12:00, Wohnzimmer off');
  // Saturday 12:00 local: chain 1 (Mo–Fr) skips at the weekday, chain 2 runs on the weekend alone
  const y = engine({ now: Date.UTC(2026, 10, 21, 11, 0, 0) });
  y.e.set({ rules: [chain({ id: 1, cond: { mode: 'all', list: [{ k: 'days', days: [1, 2, 3, 4, 5] }] } }), chain({ id: 2, cond: { mode: 'any', list: [dev, { k: 'days', days: [6, 7] }] } })], tz: 'Europe/Berlin' });
  y.feed(...LIGHT_STATE(true, 50));
  y.feed('shellies/wz/status/switch:0', SW(true));
  y.feed('shellies/taster/events/rpc', PRESS('single_push'));
  await y.settle();
  assert.deepEqual(y.list().map((r) => [r.r, r.res]), [[1, 'skip'], [2, 'ok']]);
});

test('v2 WENN: a state that BECOMES true, a value crossing a threshold, the clock of the house — and "wird wahr: A und B"', async () => {
  const x = engine();
  x.e.set({ rules: [
    chain({ id: 1, when: [{ k: 'dev', base: 'shellies/wm', ch: 'switch:0', field: 'power', op: 'lt', value: 5 }] }),
    chain({ id: 2, when: [{ k: 'time', at: '12:01' }] }),
    chain({ id: 3, when: [{ k: 'all', parts: [{ base: 'shellies/wm', ch: 'switch:0', field: 'on', op: 'eq', value: true }, { base: 'shellies/wm', ch: 'switch:0', field: 'power', op: 'gt', value: 1000 }] }] }),
  ], tz: 'Europe/Berlin' });
  x.feed(...LIGHT_STATE(true, 50));
  x.feed('shellies/wm/status/switch:0', SW(true, 1800));
  await x.settle();
  assert.equal(x.list().length, 0, 'the starting point');
  x.feed('shellies/wm/status/switch:0', SW(true, 3));
  await x.settle();
  assert.deepEqual(x.list().map((r) => r.r), [1], 'below 5 W');
  x.feed('shellies/wm/status/switch:0', SW(true, 2));
  await x.settle();
  assert.equal(x.list().length, 1, 'still below: no new run');
  x.feed('shellies/wm/status/switch:0', SW(true, 1500));
  await x.settle();
  assert.deepEqual(x.list().map((r) => r.r), [1, 3], 'on AND above 1000 W became true');
  await x.advance(61000);
  assert.deepEqual(x.list().map((r) => r.r), [1, 3, 2], '12:01 in Berlin');
  await x.advance(60000);
  assert.equal(x.list().filter((r) => r.r === 2).length, 1, 'once a day');
  await x.advance(24 * 3600 * 1000);
  assert.equal(x.list().filter((r) => r.r === 2).length, 2, 'the next day again');
});

test('brakes: own feedback is no trigger for 2 s; more than 10 runs a minute stop the chain; at most 60 commands a minute', async () => {
  // a chain that reacts to the lamp going off and switches it on: its own "on" report is not a new start
  const x = engine();
  x.e.set({ rules: [chain({ when: [{ k: 'dev', base: 'shellies/flur', ch: 'light:0', field: 'on', op: 'eq', value: true }], steps: [LAMP('off')] })] });
  x.feed(...LIGHT_STATE(false));
  x.feed(...LIGHT_STATE(true));
  await x.settle();
  assert.equal(x.sent.length, 1);
  x.feed(...LIGHT_STATE(false));       // its own command's report
  x.feed(...LIGHT_STATE(true));        // within 2 s: ignored
  await x.settle();
  assert.equal(x.sent.length, 1);
  x.clock.now += 2500;
  x.feed(...LIGHT_STATE(false));
  x.feed(...LIGHT_STATE(true));
  await x.settle();
  assert.equal(x.sent.length, 2, 'after 2 s it reacts again');

  const y = engine();
  y.e.set({ rules: [chain()] });
  for (let i = 0; i < 11; i++) { y.feed('shellies/taster/events/rpc', PRESS('single_push')); y.clock.now += 1000; await y.settle(); }
  assert.equal(y.sent.length, 10);
  const last = y.order[y.order.length - 1];
  assert.deepEqual([last.res, last.why], ['stopped', 'rate:11']);
  assert.deepEqual(y.e.stoppedList().map((s) => [s.id, s.reason, s.n]), [[1, 'rate', 11]]);
  y.clock.now += 120000;
  y.feed('shellies/taster/events/rpc', PRESS('single_push'));
  await y.settle();
  assert.equal(y.sent.length, 10, 'stopped stays stopped');
  assert.ok(y.logs.some((l) => /stopped/.test(l)));
  // the same list again keeps the stop; a changed chain starts fresh; the stop survives a restart (restoreStopped)
  y.e.set({ rules: [chain()] });
  assert.equal(y.e.stoppedList().length, 1);
  const z = engine();
  z.e.set({ rules: [chain()] });
  z.e.restoreStopped(y.e.stoppedList());
  assert.equal(z.e.stoppedList().length, 1);
  assert.throws(() => z.e.test({ id: 1 }, { run: true }), { code: 'stopped' });
  y.e.set({ rules: [chain({ steps: [LAMP('off')] })] });
  assert.equal(y.e.stoppedList().length, 0);

  // 63 commands in a minute (from several chains, running side by side): beyond 60 nothing is sent, those runs are "partial"
  const c = engine();
  const many = Array.from({ length: 7 }, (_, i) => chain({ id: i + 1, steps: Array.from({ length: 9 }, (__, j) => LAMP(j % 2 ? 'off' : 'on')) }));
  c.e.set({ rules: many });
  c.feed('shellies/taster/events/rpc', PRESS('single_push'));
  await c.settle();
  assert.equal(c.sent.length, 60);
  const partial = c.list().filter((r) => r.res === 'partial');
  assert.ok(partial.length >= 1 && partial.every((r) => r.why === 'limit' && r.ev.some((e) => e[1] === 'limit')));
  assert.equal(c.list().flatMap((r) => r.ev).filter((e) => e[1] === 'limit').length, 3);
  assert.ok(c.logs.some((l) => /60 commands/.test(l)));
});

test('confirmation: a device that does not report within 5 s makes the run "partial · antwortet nicht"; one already there needs none', async () => {
  const x = engine();
  x.e.set({ rules: [chain({ steps: [LAMP('on'), { k: 'act', base: 'shellies/keller', family: 'shelly2', ch: 'switch:0', op: 'on' }] })] });
  x.feed(...LIGHT_STATE(true, 50));
  x.feed('shellies/taster/events/rpc', PRESS('single_push'));
  await x.settle();
  assert.equal(x.list().length, 0, 'the record waits for the reports');
  await x.advance(5000);
  const run = x.list()[0];
  assert.deepEqual([run.res, run.why], ['partial', 'noack']);
  assert.deepEqual(run.ev.filter((e) => e[1] === 'ack' || e[1] === 'noack').map((e) => [e[1], e[2]]), [['ack', 0], ['noack', 1]]);
});

test('Testlauf: what each condition is now and what would happen; "Trotzdem ausführen" skips NUR WENN; a draft is only checked', async () => {
  const x = engine();
  const cond = { mode: 'all', list: [{ k: 'time', from: '11:00', to: '23:30' }, { k: 'dev', base: 'shellies/wz', ch: 'switch:0', field: 'on', op: 'eq', value: false }, { k: 'days', days: [6, 7] }] };
  x.e.set({ rules: [chain({ cond })], tz: 'Europe/Berlin' });
  x.feed(...LIGHT_STATE(true, 50));
  x.feed('shellies/wz/status/switch:0', SW(true));
  const t = x.e.test({ id: 1 });
  assert.deepEqual({ ...t, at: null }, { at: null, running: false, stopped: null, v: 2, clock: '12:00', day: 3, mode: 'all', result: 'skip', sun: null,
    checks: [{ ok: true, v: '12:00', range: ['11:00', '23:30'] }, { ok: false, v: true }, { ok: false, v: 3 }] });
  assert.deepEqual(x.sent, [], 'a test switches nothing');
  assert.deepEqual(x.e.test({ id: 1 }, { run: true }).started, true);
  await x.settle();
  assert.equal(x.sent.length, 1);
  assert.deepEqual([x.list()[0].by, x.list()[0].ev[0][1]], ['manual', 'manual']);
  // a draft (the editor, unsaved)
  const d = x.e.test({ rule: chain({ id: 99, cond: { mode: 'any', list: [cond.list[0]] } }) });
  assert.deepEqual([d.result, d.checks.length], ['run', 1]);
  assert.throws(() => x.e.test({ rule: { v: 2 } }), { code: 'bad_request' });
  assert.throws(() => x.e.test({ id: 5 }), { code: 'not_found' });
  assert.throws(() => x.e.test({ rule: chain() }, { run: true }), { code: 'bad_request' });
  // version 1 chains: their triggers and window
  x.e.set({ rules: [{ id: 7, triggers: [{ base: 'shellies/wz', ch: 'switch:0', field: 'on', op: 'eq', value: true }], actions: [{ base: 'shellies/flur', family: 'shelly2', ch: 'light:0', op: 'on' }], window: { from: '20:00', to: '06:00' }, delay: null }], tz: 'Europe/Berlin' });
  assert.deepEqual(x.e.test({ id: 7 }).checks, [{ ok: true, v: true }, { ok: false, v: '12:00' }]);
});

test('cleanRule: version 2 is checked part by part; anything unknown or out of range drops the whole chain', () => {
  const ok = chain({ cond: { mode: 'any', list: [{ k: 'days', days: [7, 1] }] }, steps: [LAMP('on'), WAIT(86400)] });
  assert.deepEqual(rules.cleanRule(ok).cond.list[0].days, [1, 7]);
  for (const bad of [
    chain({ when: [] }), chain({ when: [{ k: 'btn', base: 'shellies/x', input: 9, ev: 'single' }] }), chain({ when: [{ k: 'btn', base: 'shellies/x', input: 0, ev: 'quad' }] }),
    chain({ when: [{ k: 'time', at: '25:00' }] }), chain({ steps: [WAIT(10)] }), chain({ steps: [LAMP('on'), WAIT(86401)] }),
    chain({ steps: Array.from({ length: 21 }, () => LAMP('on')) }), chain({ cond: { mode: 'all', list: [{ k: 'days', days: [] }] } }),
    chain({ cond: { mode: 'all', list: [{ k: 'sun' }] } }), chain({ v: 3 }), chain({ steps: [{ k: 'act', base: 'shellies/x', family: 'shelly2', ch: 'light:0', op: 'bri', value: 0 }] }),
  ]) assert.equal(rules.cleanRule(bad), null, JSON.stringify(bad).slice(0, 120));
});

// ─── the edge part ───

function load({ stored = {} } = {}) {
  delete require.cache[require.resolve(ENTRY)];
  const part = require(ENTRY);
  const handlers = new Map();
  const listeners = [];
  const events = [];
  const published = [];
  const subs = [];
  const store = new Map(Object.entries(stored));
  const writes = [];
  const state = { config: null };
  const gc = Object.freeze({
    id: 'gatecontrol-smarthome', version: '1.11.0',
    handle: (m, fn) => handlers.set(m, fn),
    emit: (name, data) => events.push({ name, data: JSON.parse(JSON.stringify(data)) }),
    config: () => state.config,
    onConfig: (fn) => listeners.push(fn),
    log: Object.freeze({ info: () => {}, warn: () => {}, error: () => {} }),
    store: Object.freeze({
      get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
      set: async (k, v) => { writes.push(k); store.set(k, JSON.parse(JSON.stringify(v))); },
      delete: async (k) => { store.delete(k); },
    }),
    lan: Object.freeze({ http: Object.freeze({ request: async () => { throw Object.assign(new Error('x'), { code: 'net_error' }); } }), mdns: Object.freeze({ browse: async () => ({ stop: async () => {} }) }) }),
    mqtt: Object.freeze({
      subscribe: async (topic, fn) => { const s = { topic, fn, on: true }; subs.push(s); return { unsubscribe: async () => { s.on = false; } }; },
      publish: async (topic, payload) => { published.push([topic, String(payload)]); },
    }),
  });
  return {
    part, gc, events, published, store, writes,
    call: async (method, params) => handlers.get(method)(params === undefined ? null : params, gc),
    configure(data) { state.config = data; for (const fn of listeners) fn(data, gc); },
    deliver(topic, payload, retain = false) {
      for (const s of subs) if (s.on && topic.startsWith(s.topic.replace(/#$/, ''))) s.fn(topic, Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)), { retain, qos: 0 });
    },
  };
}
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const CONFIG = {
  devices: [{ base: 'shellies/taster1', family: 'shelly1' }, { base: 'shellies/flur', family: 'shelly2' }],
  rules: [{ id: 21, v: 2, when: [{ k: 'btn', base: 'shellies/taster1', input: 0, ev: 'single' }], cond: { mode: 'all', list: [] }, steps: [LAMP('on')], re: 'restart' }],
  tz: 'Europe/Berlin',
};

test('edge part: a press runs the chain once (Gen1 repeats the counter, retained is old); runs go out with the bundle and on request', async () => {
  const e = load();
  e.part.start(e.gc);
  try {
    await tick();
    e.configure(CONFIG);
    await tick();
    e.deliver('shellies/flur/status/light:0', { id: 0, output: true, brightness: 50 });
    e.published.length = 0;
    e.deliver('shellies/taster1/input_event/0', { event: 'S', event_cnt: 4 }, true);
    await tick();
    assert.deepEqual(e.published, [], 'a retained press is an old one');
    e.deliver('shellies/taster1/input_event/0', { event: 'S', event_cnt: 5 });
    e.deliver('shellies/taster1/input_event/0', { event: 'S', event_cnt: 5 });
    await tick();
    assert.equal(e.published.length, 1, 'the same counter twice: one press');
    e.deliver('shellies/taster1/input_event/0', { event: 'S', event_cnt: 6 });
    await tick();
    assert.equal(e.published.length, 2);
    e.part._test.flush();
    const sent = e.events.filter((x) => x.name === 'runs').flatMap((x) => x.data.runs);
    assert.equal(sent.length, 2);
    assert.ok(sent.every((r) => r.r === 21 && r.res === 'ok' && /^[0-9a-f]{12}:\d+$/.test(r.u)));
    const all = await e.call('runs', {});
    assert.equal(all.runs.length, 2);
    assert.deepEqual(await e.call('runs', { epoch: all.epoch, after: all.runs[1].s }), { epoch: all.epoch, runs: [], more: false });
    assert.equal((await e.call('runs', { epoch: 'other', after: 99 })).runs.length, 2, 'another epoch: everything');
    // Testlauf through the handler
    const t = await e.call('test', { id: 21 });
    assert.deepEqual([t.v, t.result, t.checks], [2, 'run', []]);
    await assert.rejects(() => e.call('test', { id: 'x' }), { code: 'bad_request' });
    // kept at most once a minute: written by saveRuns, not per run
    assert.ok(!e.writes.includes('runs'));
    await e.part._test.saveRuns();
    await e.part._test.saveRuns();
    assert.equal(e.writes.filter((k) => k === 'runs').length, 1, 'unchanged: not written again');
    const kept = e.store.get('runs');
    assert.equal(kept.list.length, 2);
    assert.ok(!JSON.stringify(kept).includes('pass'));
  } finally { e.part.stop(e.gc); }
});

test('edge part: after a restart the ring is there (a run cut off counts as cancelled) and a stopped chain stays stopped', async () => {
  const stopped = [{ id: 21, reason: 'rate', n: 12, at: '2026-11-18T10:00:00.000Z' }];
  const ring = { epoch: 'abc123', seq: 5, n: 3, list: [{ u: 'abc123:3', s: 5, r: 21, at: '2026-11-18T10:00:00.000Z', by: 'event', tr: 0, res: 'running', why: null, ev: [], end: null }], stopped };
  const e = load({ stored: { rules: { rules: CONFIG.rules, tz: 'Europe/Berlin' }, runs: ring } });
  e.part.start(e.gc);
  try {
    await tick();
    const r = await e.call('runs', {});
    assert.equal(r.epoch, 'abc123');
    assert.deepEqual([r.runs[0].res, r.runs[0].why, r.runs[0].s], ['cancel', 'restart', 6]);
    e.deliver('shellies/taster1/input_event/0', { event: 'S', event_cnt: 1 });
    await tick();
    assert.deepEqual(e.published.filter((p) => p[0] === 'shellies/flur/rpc'), [], 'stopped before the restart, stopped after it');
    // the server part switched it off (not in the list): the stop is forgotten; back in the list it runs
    e.configure({ ...CONFIG, rules: [] });
    e.configure(CONFIG);
    await tick();
    e.deliver('shellies/taster1/input_event/0', { event: 'S', event_cnt: 2 });
    await tick();
    assert.equal(e.published.filter((p) => p[0] === 'shellies/flur/rpc').length, 1);
  } finally { e.part.stop(e.gc); }
});

test('Einrichtungshilfe: Tasmota sets SetOption73 1 only on request (the buttons then report presses)', async () => {
  const devices = require('../edge/devices');
  const bodies = [];
  const http = { request: async (o) => { bodies.push(new URLSearchParams(Buffer.from(o.body || '').toString()).get('cmnd')); return { status: 200, headers: {}, body: Buffer.from('{}'), text: () => '{}', json: () => ({}) }; } };
  const o = { ip: '192.168.1.50', family: 'tasmota', host: '192.168.1.23', user: 'gatecontrol-smarthome-flur', pass: 'p4ssw0rd', prefix: 'flur' };
  await devices.setup(http, o);
  await devices.setup(http, { ...o, buttons: true });
  assert.doesNotMatch(bodies[0], /SetOption73/);
  assert.match(bodies[1], /^Backlog SetOption3 1; SetOption73 1; MqttHost 192\.168\.1\.23;/);
});
