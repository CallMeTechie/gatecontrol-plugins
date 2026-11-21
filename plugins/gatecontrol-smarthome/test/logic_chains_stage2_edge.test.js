'use strict';

// Logikketten Stufe 2 (1.12.0) — the part on the gateway: sunrise / sunset (edge/sun.js), "seit X min" for triggers
// and conditions, "Andere Kette starten" (NUR WENN of the other chain, at most 4 deep), "Mitteilung senden" (an event
// for the server part), "Von Hand (App)" (a quick action: NUR WENN is checked) and the steps of the chains that run
// on the server (family 'res', io.act). The edge part needs no new capability (no zigbee2mqtt/# — see edgerules.js).
// A clock and timers the test moves; MQTT messages as devices send them.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const rules = require('../edge/rules');
const sun = require('../edge/sun');
const normalize = require('../edge/normalize');

const ENTRY = path.join(__dirname, '..', 'edge', 'index.js');
const T0 = Date.UTC(2026, 10, 18, 11, 0, 0); // Wednesday 12:00 in Europe/Berlin
const BERLIN = { lat: 52.52, lon: 13.4 };    // an example place (rounded as the plugin keeps it)
const TZ = 'Europe/Berlin';

function engine(o = {}) {
  const devices = new Map();
  const sent = [];
  const acted = [];
  const notes = [];
  const runs = new Map();
  const timers = [];
  const clock = { now: o.now || T0 };
  const e = rules.create({
    device: (base) => devices.get(base) || null,
    publish: async (list) => { sent.push(...list.map((m) => [m.topic, m.payload])); },
    record: (r) => { runs.set(r.u, r); },
    now: () => clock.now,
    setTimer: (fn, ms) => { const t = { fn, at: clock.now + ms, on: true }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.on = false; },
    notify: (n) => { notes.push(n); return true; },
    ...(o.act ? { act: async (s) => { acted.push(s); } } : {}),
    log: { warn: () => {} },
  });
  const feed = (topic, payload) => {
    const r = normalize.parse(topic, Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)));
    if (!devices.has(r.base)) devices.set(r.base, normalize.newDevice(r.base, r.family));
    normalize.apply(devices.get(r.base), r.patch);
    e.onDevice(r.base);
    if (r.events) e.onEvent(r.base, r.events);
  };
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  const advance = async (ms) => {
    await settle();
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
  return { e, devices, sent, acted, notes, runs, clock, feed, settle, advance, list: () => [...runs.values()] };
}

const BTN = { k: 'btn', base: 'shellies/taster', input: 1, ev: 'single' };
const PRESS = { src: 'shellyplusi4-a1', method: 'NotifyEvent', params: { ts: 1, events: [{ component: 'input:1', id: 1, event: 'single_push', ts: 1 }] } };
const LAMP = (op) => ({ k: 'act', base: 'shellies/flur', family: 'shelly2', ch: 'light:0', op });
const chain = (o) => ({ id: 1, v: 2, when: [BTN], cond: { mode: 'all', list: [] }, steps: [LAMP('on')], re: 'restart', ...o });
const lampOn = (x) => x.sent.filter(([t, p]) => t === 'shellies/flur/rpc' && JSON.parse(p).params.on === true).length;

// ─── the sun ───

test('sun: sunrise and sunset of a day at a place — within a few minutes of the published times; polar day and night', () => {
  const at = (ms) => new Date(ms).toLocaleTimeString('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const mins = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  const near = (ms, want) => assert.ok(Math.abs(mins(at(ms)) - mins(want)) <= 3, `${at(ms)} ≈ ${want}`);
  let t = sun.times('2026-06-21', BERLIN.lat, BERLIN.lon);
  near(t.rise, '04:43'); near(t.set, '21:33');
  t = sun.times('2026-12-21', BERLIN.lat, BERLIN.lon);
  near(t.rise, '08:15'); near(t.set, '15:54');
  assert.deepEqual(sun.times('2026-12-21', 78.2, 15.6), { rise: null, set: null });
  assert.equal(sun.polar('2026-12-21', 78.2, 15.6), 'night');
  assert.equal(sun.polar('2026-06-21', 78.2, 15.6), 'day');
  assert.deepEqual(sun.times('2026-13-01', 52, 13), { rise: null, set: null }, 'not a date');
  assert.deepEqual(sun.times('2026-06-21', 91, 13), { rise: null, set: null }, 'not a place');
});

test('WENN Sonnenuntergang + 30 min fires once that minute; without a place it never does', async () => {
  const x = engine();
  x.e.set({ rules: [chain({ when: [{ k: 'sun', ev: 'set', off: 30 }] })], tz: TZ, sun: BERLIN });
  const set = rules.sunMinute('set', 30, rules.clockOf(T0, TZ), BERLIN, TZ);
  assert.ok(set > 16 * 60 && set < 17 * 60 + 30, 'about half past four in November');
  await x.advance((set - 12 * 60 - 1) * 60000);
  assert.equal(lampOn(x), 0, 'a minute before');
  await x.advance(2 * 60000);
  assert.equal(lampOn(x), 1);
  await x.advance(10 * 60000);
  assert.equal(lampOn(x), 1, 'once a day');
  assert.equal(x.list()[0].tr, 0);
  const y = engine();
  y.e.set({ rules: [chain({ when: [{ k: 'sun', ev: 'set', off: 30 }] })], tz: TZ });
  await y.advance(10 * 3600000);
  assert.equal(lampOn(y), 0, 'no place: no sun');
});

test('NUR WENN "Sonnenuntergang–23:30": the window follows the sun; the Testlauf shows today\'s time; without a place it stays open', async () => {
  const cond = { mode: 'all', list: [{ k: 'time', from: { sun: 'set', off: 0 }, to: '23:30' }] };
  const x = engine();
  x.e.set({ rules: [chain({ cond })], tz: TZ, sun: BERLIN });
  x.feed('shellies/taster/events/rpc', PRESS);
  await x.settle();
  assert.equal(lampOn(x), 0, 'at noon: before sunset');
  assert.deepEqual([x.list()[0].res, x.list()[0].why], ['skip', 'cond:0']);
  const t = x.e.test({ id: 1 });
  assert.equal(t.checks[0].range[1], '23:30');
  assert.match(t.checks[0].range[0], /^16:\d\d$/);
  assert.deepEqual(Object.keys(t.sun), ['rise', 'set']);
  await x.advance(6 * 3600000); // 18:00
  x.feed('shellies/taster/events/rpc', PRESS);
  await x.settle();
  assert.equal(lampOn(x), 1, 'after sunset');
  const y = engine();
  y.e.set({ rules: [chain({ cond })], tz: TZ });
  y.feed('shellies/taster/events/rpc', PRESS);
  await y.settle();
  assert.deepEqual([y.list()[0].res, y.list()[0].why], ['skip', 'unknown']);
  assert.deepEqual(y.e.test({ id: 1 }).checks[0].range, [null, '23:30']);
});

// ─── "seit X min" ───

test('WENN "Waschmaschine unter 5 W seit 3 min": fires once it held that long — not when it rises again before', async () => {
  const x = engine();
  const when = [{ k: 'dev', base: 'shellies/wm', ch: 'switch:0', field: 'power', op: 'lt', value: 5, for: 3 }];
  x.e.set({ rules: [chain({ when })], tz: TZ });
  const power = (w) => x.feed('shellies/wm/status/switch:0', { id: 0, output: true, apower: w });
  power(1800);
  power(3);
  await x.advance(2 * 60000);
  assert.equal(lampOn(x), 0, 'two minutes');
  await x.advance(60000);
  assert.equal(lampOn(x), 1, 'three minutes');
  power(1500);
  power(2);
  await x.advance(60000);
  power(900); // the next programme step starts
  await x.advance(5 * 60000);
  assert.equal(lampOn(x), 1, 'it did not hold');
});

test('NUR WENN "Stehlampe ist aus seit 2 min": a press right after it went off is skipped, two minutes later it runs', async () => {
  const x = engine();
  const cond = { mode: 'all', list: [{ k: 'dev', base: 'shellies/wz', ch: 'switch:0', field: 'on', op: 'eq', value: false, for: 2 }] };
  x.e.set({ rules: [chain({ cond })], tz: TZ });
  x.feed('shellies/wz/status/switch:0', { id: 0, output: true });
  x.feed('shellies/wz/status/switch:0', { id: 0, output: false });
  x.feed('shellies/taster/events/rpc', PRESS);
  await x.settle();
  assert.equal(lampOn(x), 0);
  assert.equal(x.e.test({ id: 1 }).checks[0].ok, false);
  await x.advance(2 * 60000);
  assert.deepEqual(x.e.test({ id: 1 }).checks[0], { ok: true, v: false, since: 2 });
  x.feed('shellies/taster/events/rpc', PRESS);
  await x.settle();
  assert.equal(lampOn(x), 1);
});

// ─── other chains, notifications, from the apps ───

test('"Andere Kette starten": the other chain checks its NUR WENN, runs by "chain"; chains starting chains stop after 4', async () => {
  const x = engine();
  const two = { id: 2, v: 2, when: [{ k: 'man' }], cond: { mode: 'all', list: [{ k: 'dev', base: 'shellies/wz', ch: 'switch:0', field: 'on', op: 'eq', value: true }] }, steps: [LAMP('off')], re: 'restart' };
  x.e.set({ rules: [chain({ steps: [{ k: 'chain', id: 2 }] }), two], tz: TZ });
  x.feed('shellies/wz/status/switch:0', { id: 0, output: false });
  x.feed('shellies/taster/events/rpc', PRESS);
  await x.settle();
  let r2 = x.list().filter((r) => r.r === 2);
  assert.deepEqual([r2.length, r2[0].by, r2[0].res], [1, 'chain', 'skip'], 'its NUR WENN said no');
  assert.deepEqual(x.list().find((r) => r.r === 1).ev.map((e) => e[1]), ['trig', 'cond', 'chain']);
  x.feed('shellies/wz/status/switch:0', { id: 0, output: true });
  x.feed('shellies/taster/events/rpc', PRESS);
  await x.advance(6000); // the record goes out once the lamp answered (or 5 s later)
  r2 = x.list().filter((r) => r.r === 2 && r.res !== 'skip');
  assert.equal(r2.length, 1);
  assert.deepEqual(r2[0].ev.slice(0, 1).map((e) => e[1]), ['chain']);

  // 1 → 2 → 3 → 4 → 5 → 6: the fifth start is not made
  const y = engine();
  const link = (id) => ({ id, v: 2, when: [{ k: 'man' }], cond: { mode: 'all', list: [] }, steps: [id < 6 ? { k: 'chain', id: id + 1 } : LAMP('on')], re: 'restart' });
  y.e.set({ rules: [chain({ steps: [{ k: 'chain', id: 2 }] }), link(2), link(3), link(4), link(5), link(6)], tz: TZ });
  y.feed('shellies/taster/events/rpc', PRESS);
  await y.settle();
  assert.deepEqual(y.list().map((r) => r.r).sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(y.list().find((r) => r.r === 5).ev.map((e) => e[1]), ['chain', 'cond', 'chain', 'limit']);
  assert.equal(y.list().find((r) => r.r === 5).res, 'partial');
  // a chain never names itself
  assert.equal(rules.cleanRule(chain({ steps: [{ k: 'chain', id: 1 }] })), null);
});

test('"Mitteilung senden": the step hands { r, i, at, u } over (the server part sends it); without anybody to take it the step fails', async () => {
  const x = engine();
  x.e.set({ rules: [chain({ steps: [LAMP('on'), { k: 'note' }] })], tz: TZ });
  x.feed('shellies/taster/events/rpc', PRESS);
  await x.advance(6000);
  assert.equal(x.notes.length, 1);
  assert.deepEqual([x.notes[0].r, x.notes[0].i, x.notes[0].u], [1, 1, x.list()[0].u]);
  assert.ok(x.list()[0].ev.some((e) => e[1] === 'note' && e[2] === 1));
  // only a notification is a step too ("Wäsche fertig" with nothing else)
  assert.ok(rules.cleanRule(chain({ steps: [{ k: 'note' }] })));
  assert.equal(rules.cleanRule(chain({ steps: [{ k: 'wait', s: 60 }] })), null, 'a wait alone does nothing');
});

test('"Von Hand (App)": never by itself; from the apps NUR WENN is checked — "Trotzdem ausführen" still skips it', async () => {
  const x = engine();
  const cond = { mode: 'all', list: [{ k: 'dev', base: 'shellies/wz', ch: 'switch:0', field: 'on', op: 'eq', value: true }] };
  x.e.set({ rules: [chain({ when: [{ k: 'man' }], cond }), chain({ id: 2 })], tz: TZ });
  x.feed('shellies/wz/status/switch:0', { id: 0, output: false });
  let r = x.e.test({ id: 1 }, { run: true, by: 'app' });
  assert.deepEqual([r.started, r.result], [false, 'skip']);
  await x.settle();
  assert.equal(lampOn(x), 0);
  assert.equal(x.list()[0].by, 'app');
  x.feed('shellies/wz/status/switch:0', { id: 0, output: true });
  r = x.e.test({ id: 1 }, { run: true, by: 'app' });
  assert.deepEqual([r.started, r.result], [true, 'started']);
  await x.settle();
  assert.equal(lampOn(x), 1);
  assert.throws(() => x.e.test({ id: 2 }, { run: true, by: 'app' }), { code: 'not_manual' }, 'only a chain with "Von Hand (App)"');
  x.feed('shellies/wz/status/switch:0', { id: 0, output: false });
  assert.equal(x.e.test({ id: 1 }, { run: true }).started, true, '"Trotzdem ausführen"');
});

// ─── the server's resources ───

test('the chains that run on the server: resources res/<id>, switched by io.act (a scene too), never by MQTT', async () => {
  const x = engine({ act: true });
  const r = rules.cleanRule({ id: 3, v: 2, when: [{ k: 'dev', base: 'res/12', ch: 'sensor', field: 'open', op: 'eq', value: true }], cond: { mode: 'all', list: [] },
    steps: [{ k: 'act', base: 'res/40', family: 'res', ch: 'light:0', op: 'bri', value: 70 }, { k: 'act', base: 'res/41', family: 'res', ch: 'scene', op: 'scene' }], re: 'restart' });
  assert.ok(r);
  x.e.set({ rules: [r], tz: TZ });
  x.devices.set('res/12', { base: 'res/12', family: 'res', ch: {}, sensor: { open: false } });
  x.e.onDevice('res/12');
  x.devices.get('res/12').sensor.open = true;
  x.e.onDevice('res/12');
  await x.advance(6000);
  assert.deepEqual(x.acted.map((s) => [s.base, s.op]), [['res/40', 'bri'], ['res/41', 'scene']]);
  assert.deepEqual(x.sent, []);
  assert.equal(x.list()[0].res, 'partial', 'the lamp did not report back (its cached state did not change)');
  // what is no resource action is refused
  for (const bad of [{ base: 'res/40', family: 'res', ch: 'light:0', op: 'pos', value: 4 }, { base: 'res/x', family: 'res', ch: 'light:0', op: 'on' }, { base: 'res/41', family: 'res', ch: 'light:0', op: 'scene' }]) {
    assert.equal(rules.cleanRule({ ...r, steps: [{ k: 'act', ...bad }] }), null, JSON.stringify(bad));
  }
});

// ─── the edge part ───

function load() {
  delete require.cache[require.resolve(ENTRY)];
  const part = require(ENTRY);
  const handlers = new Map();
  const listeners = [];
  const events = [];
  const published = [];
  const subs = [];
  const warns = [];
  const state = { config: null };
  const gc = Object.freeze({
    id: 'gatecontrol-smarthome', version: '1.12.0',
    handle: (m, fn) => handlers.set(m, fn),
    emit: (name, data) => events.push({ name, data: JSON.parse(JSON.stringify(data)) }),
    config: () => state.config,
    onConfig: (fn) => listeners.push(fn),
    log: Object.freeze({ info: () => {}, warn: (...a) => warns.push(a.join(' ')), error: () => {} }),
    store: Object.freeze({ get: async () => null, set: async () => {}, delete: async () => {} }),
    lan: Object.freeze({ http: Object.freeze({ request: async () => { throw Object.assign(new Error('x'), { code: 'net_error' }); } }), mdns: Object.freeze({ browse: async () => ({ stop: async () => {} }) }) }),
    mqtt: Object.freeze({
      subscribe: async (topic, fn) => { const s = { topic, fn, on: true }; subs.push(s); return { unsubscribe: async () => { s.on = false; } }; },
      publish: async (topic, payload) => { published.push([topic, String(payload)]); },
    }),
  });
  return {
    part, gc, events, published, subs, warns, state,
    call: async (method, params) => handlers.get(method)(params === undefined ? null : params, gc),
    configure(data) { state.config = data; for (const fn of listeners) fn(data, gc); },
    deliver(topic, payload, retain = false) {
      for (const s of subs) if (s.on && topic.startsWith(s.topic.replace(/#$/, ''))) s.fn(topic, Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)), { retain, qos: 0 });
    },
  };
}
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const NOTE_RULE = { id: 31, v: 2, when: [{ k: 'btn', base: 'shellies/taster', input: 1, ev: 'single' }], cond: { mode: 'all', list: [] }, steps: [LAMP('on'), { k: 'note' }], re: 'restart' };
const CONFIG = { devices: [{ base: 'shellies/taster', family: 'shelly2' }, { base: 'shellies/flur', family: 'shelly2' }], tz: TZ, sun: BERLIN, rules: [NOTE_RULE] };

test('edge part: the same capabilities as 1.11 (shellies/#, tasmota/#); a note goes out as event `notify`; "Von Hand (App)" through the handler', async () => {
  const manifest = require('../plugin.json');
  assert.deepEqual(manifest.edge.capabilities.mqtt.topics, ['shellies/#', 'tasmota/#'], 'no new capability: no confirmation, no update_pending');
  const e = load();
  e.part.start(e.gc);
  try {
    await tick();
    assert.deepEqual(e.subs.map((s) => s.topic), ['shellies/#', 'tasmota/#']);
    e.configure(CONFIG);
    await tick();
    e.deliver('shellies/taster/events/rpc', PRESS);
    await tick();
    assert.equal(e.published.filter((p) => p[0] === 'shellies/flur/rpc').length, 1);
    e.part._test.flush();
    const notes = e.events.filter((x) => x.name === 'notify').flatMap((x) => x.data.notes);
    assert.deepEqual(notes.map((n) => [n.r, n.i]), [[31, 1]]);
    assert.equal((await e.call('info')).rules, 1);
    e.configure({ ...CONFIG, rules: [{ id: 40, v: 2, when: [{ k: 'man' }], cond: { mode: 'all', list: [] }, steps: [LAMP('on')], re: 'restart' }] });
    await tick();
    assert.deepEqual(await e.call('test', { id: 40, run: true, by: 'app' }).then((r) => [r.started, r.result]), [true, 'started']);
    await assert.rejects(() => e.call('test', { id: 99, run: true, by: 'app' }), { code: 'not_found' });
  } finally { e.part.stop(e.gc); }
});
