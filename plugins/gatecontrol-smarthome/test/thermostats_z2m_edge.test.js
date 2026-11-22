'use strict';

// zigbee2mqtt thermostats in the plan on the gateway (1.18.0): a room whose thermostats all hang on one gateway — Shelly /
// BLU TRV and / or zigbee2mqtt of that gateway — runs its plan there, but zigbee2mqtt only while the optional capability
// zigbee2mqtt/# is confirmed for the gateway (and the gateway does not refuse it); else the room stays on the server as
// before. On the gateway: zigbee2mqtt/<name>/set with the setpoint the device exposes, Aus as system_mode off, its own
// plan (auto) set to heat, boost 30 °C; a target the device already reports is not sent again (the hand-over from the
// server sends nothing twice). edge.capabilities and edge.optionalCapabilities unchanged. All names are made up.

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHost, hostError } = require('../../../tools/testing/mock-host');
const { DIR, ADMIN, USERS } = require('./helpers');
const normalize = require('../edge/normalize');
const commands = require('../edge/commands');
const heat = require('../edge/heat');
const heating = require('../server/heating');
const zigbee = require('../server/zigbee');
const radio = require('../server/radio');

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const T = (d, h, m = 0) => new Date(2026, 10, 23 + d, h, m).getTime();
const WD = [[0, 'night'], [360, 'comfort'], [480, 'eco'], [960, 'comfort'], [1350, 'night']];
const WEEK = [WD, WD, WD, WD, WD, WD, WD];
const TEMPS = { comfort: 21, eco: 18, night: 17, frost: 7 };
const KEY = 'mqtt.topic:zigbee2mqtt/#';
const IEEE = '0x00158d00000000c1';
const BASE = `zigbee2mqtt/${IEEE}`;

describe('zigbee2mqtt thermostats: what the gateway reads and sends', () => {
  it('a state message → thermostat:0 with the setpoint it exposes (else occupied, else current), mode, valve', () => {
    const msg = { local_temperature: 20.4, occupied_heating_setpoint: 21, current_heating_setpoint: 16, system_mode: 'heat', pi_heating_demand: 35.4, battery: 80 };
    const a = normalize.parseZ2m(BASE, Buffer.from(JSON.stringify(msg)), { kind: 'thermostat' });
    assert.deepEqual(a.patch.ch, { 'thermostat:0': { kind: 'z2m', target: 21, sp: 'occupied_heating_setpoint', temp: 20.4, mode: 'heat', valve: 35 } });
    assert.equal(a.patch.sensor.battery, 80);
    const b = normalize.parseZ2m(BASE, Buffer.from(JSON.stringify(msg)), { kind: 'thermostat', sp: 'current_heating_setpoint' });
    assert.deepEqual([b.patch.ch['thermostat:0'].target, b.patch.ch['thermostat:0'].sp], [16, 'current_heating_setpoint'], 'what the exposes say wins');
    const c = normalize.parseZ2m(BASE, Buffer.from(JSON.stringify({ current_heating_setpoint: 19.5, system_mode: 'auto' })), { kind: 'thermostat' });
    assert.deepEqual(c.patch.ch['thermostat:0'], { kind: 'z2m', target: 19.5, sp: 'current_heating_setpoint', mode: 'auto' });
    assert.equal(normalize.parseZ2m(BASE, Buffer.from(JSON.stringify({ linkquality: 80 })), { kind: 'thermostat' }), null);
  });

  it('commands: zigbee2mqtt/<name>/set with the setpoint property or system_mode; nothing else', () => {
    const z = { base: BASE, family: 'z2m', ch: 'thermostat:0' };
    const opts = { z2mTopic: () => 'Heizung Kinderzimmer' };
    assert.deepEqual(commands.messages({ ...z, op: 'setpoint', value: 21.5, prop: 'occupied_heating_setpoint' }, opts), [{ topic: 'zigbee2mqtt/Heizung Kinderzimmer/set', payload: '{"occupied_heating_setpoint":21.5}' }]);
    assert.deepEqual(commands.messages({ ...z, op: 'setpoint', value: 19, prop: 'current_heating_setpoint' }, opts), [{ topic: 'zigbee2mqtt/Heizung Kinderzimmer/set', payload: '{"current_heating_setpoint":19}' }]);
    assert.deepEqual(commands.messages({ ...z, op: 'mode', value: 'off' }, opts), [{ topic: 'zigbee2mqtt/Heizung Kinderzimmer/set', payload: '{"system_mode":"off"}' }]);
    for (const bad of [{ ...z, op: 'setpoint', value: 21 }, { ...z, op: 'setpoint', value: 21, prop: 'brightness' }, { ...z, op: 'setpoint', value: 40, prop: 'current_heating_setpoint' },
      { ...z, op: 'mode', value: 'cool' }, { ...z, op: 'boost', value: 30 }, { ...z, ch: 'thermostat:1', op: 'mode', value: 'heat' },
      { base: 'shellies/heizung-bad', family: 'shelly1', ch: 'thermostat:0', op: 'mode', value: 'off' }]) {
      assert.throws(() => commands.messages(bad, opts), (e) => e.code === 'bad_command', JSON.stringify(bad));
    }
  });
});

// ─── the plan on the gateway (edge/heat.js) ─────

const ZTH = { base: BASE, ch: 'thermostat:0', fam: 'z2m', name: 'Heizung Kinderzimmer', min: 5, max: 30, step: 0.5, modes: ['off', 'heat', 'auto'], boost: false };
const SHELLY = { base: 'shellies/heizung-kind', ch: 'thermostat:0', fam: 'shelly1', min: 5, max: 30, boost: true };
const ROOM = (o = {}) => ({ id: 5, th: [ZTH], temps: TEMPS, plan: 1, away: false, mode: 'plan', manual: null, hold: null, vac: null, ov: null, boost: null, win: null, ...o });

function rig(rooms, o = {}) {
  const w = { now: o.now || T(0, 7), devices: new Map(), sent: [], deaf: false };
  const report = (base, c) => {
    const d = w.devices.get(base) || { base, online: true, seenAt: null, ch: {} };
    d.ch['thermostat:0'] = { ...(d.ch['thermostat:0'] || {}), ...c };
    d.seenAt = new Date(w.now).toISOString();
    w.devices.set(base, d);
  };
  w.report = report;
  if (o.report !== false) report(BASE, { kind: 'z2m', target: 20, temp: 20, mode: 'heat', sp: 'occupied_heating_setpoint', ...(o.z || {}) });
  report(SHELLY.base, { kind: 'gen1', target: 20, temp: 20, schedule: false });
  w.engine = heat.create({
    now: () => w.now,
    device: (base) => w.devices.get(base) || null,
    z2mTopic: (base) => (base === BASE ? 'Kinderzimmer TRV' : null),
    publish: async (list) => {
      for (const m of list) {
        w.sent.push([m.topic, m.payload]);
        if (w.deaf) continue;
        const t = /^(shellies\/[^/]+)\/thermostat\/0\/command\/target_t$/.exec(m.topic);
        if (t) report(t[1], { target: Number(m.payload) });
        if (!m.topic.startsWith('zigbee2mqtt/')) continue;
        const j = JSON.parse(m.payload);
        if (j.system_mode) report(BASE, { mode: j.system_mode });
        for (const k of ['occupied_heating_setpoint', 'current_heating_setpoint']) if (k in j) report(BASE, { target: j[k] });
      }
    },
    save: () => {},
    log: { warn: () => {}, info: () => {}, debug: () => {} },
  });
  w.engine.set({ v: 1, tz: TZ, plans: { 1: WEEK }, rooms });
  w.at = async (ms) => {
    w.now = ms;
    for (const d of w.devices.values()) d.seenAt = new Date(ms).toISOString();
    await w.engine.tick();
    return w.sent.splice(0);
  };
  return w;
}
const SET = (j) => ['zigbee2mqtt/Kinderzimmer TRV/set', JSON.stringify(j)];

describe('zigbee2mqtt thermostats in the plan on the gateway (edge/heat.js)', () => {
  it('the plan switches by itself: the setpoint it reports, the name of zigbee2mqtt/bridge/devices, once each', async () => {
    const w = rig([ROOM()]);
    assert.deepEqual(await w.at(T(0, 7)), [SET({ occupied_heating_setpoint: 21 })]);
    assert.deepEqual(await w.at(T(0, 7, 30)), [], 'it reports 21: done');
    assert.deepEqual(await w.at(T(0, 8)), [SET({ occupied_heating_setpoint: 18 })]);
    assert.deepEqual(await w.at(T(0, 12)), []);
    assert.deepEqual(w.engine.z2m(), [{ ieee: IEEE, name: 'Heizung Kinderzimmer' }]);
  });

  it('Aus → system_mode off; back → heat and the target; its own plan (auto) gives way; boost 30 °C; a room with a Shelly TRV too', async () => {
    const w = rig([ROOM({ th: [ZTH, SHELLY], mode: 'off' })]);
    assert.deepEqual(await w.at(T(0, 7)), [SET({ system_mode: 'off' }), ['shellies/heizung-kind/thermostat/0/command/target_t', '7']]);
    assert.deepEqual(await w.at(T(0, 7, 10)), [], 'both report it');
    w.engine.set({ tz: TZ, plans: { 1: WEEK }, rooms: [ROOM({ th: [ZTH, SHELLY] })] });
    assert.deepEqual(await w.at(T(0, 7, 20)), [SET({ system_mode: 'heat' }), SET({ occupied_heating_setpoint: 21 }), ['shellies/heizung-kind/thermostat/0/command/target_t', '21']]);
    // a person switched its own plan on: at the next switching point it is set to heat
    w.report(BASE, { mode: 'auto' });
    assert.deepEqual(await w.at(T(0, 8)), [SET({ system_mode: 'heat' }), SET({ occupied_heating_setpoint: 18 }), ['shellies/heizung-kind/thermostat/0/command/target_t', '18']]);
    w.engine.set({ tz: TZ, plans: { 1: WEEK }, rooms: [ROOM({ th: [ZTH, SHELLY], boost: { at: T(0, 9), until: T(0, 9, 30), minutes: 30 } })] });
    assert.deepEqual(await w.at(T(0, 9)), [SET({ occupied_heating_setpoint: 30 }), ['shellies/heizung-kind/thermostat/0/command/boost_minutes', '30']]);
    assert.deepEqual(await w.at(T(0, 9, 30)), [SET({ occupied_heating_setpoint: 18 }), ['shellies/heizung-kind/thermostat/0/command/boost_minutes', '0'], ['shellies/heizung-kind/thermostat/0/command/target_t', '18']]);
  });

  it('a device without system_mode off: Aus is Frostschutz; a step of 1 °C is kept', async () => {
    const w = rig([ROOM({ th: [{ ...ZTH, modes: ['heat'], step: 1 }], mode: 'manual', manual: 20.5 })], { z: { sp: 'current_heating_setpoint' } });
    assert.deepEqual(await w.at(T(0, 7)), [SET({ current_heating_setpoint: 21 })]);
    w.engine.set({ tz: TZ, plans: { 1: WEEK }, rooms: [ROOM({ th: [{ ...ZTH, modes: ['heat'], step: 1 }], mode: 'off' })] });
    assert.deepEqual(await w.at(T(0, 7, 5)), [SET({ current_heating_setpoint: 7 })]);
  });

  it('the hand-over: a target the server already sent (the device reports it) is not sent again; no report yet → it waits; three tries', async () => {
    const w = rig([ROOM()], { z: { target: 21 } });
    assert.deepEqual(await w.at(T(0, 7)), [], 'Komfort 21 °C is there already');
    const w2 = rig([ROOM()], { report: false });
    assert.deepEqual(await w2.at(T(0, 7)), [], 'never reported: nothing to compare, no property — it waits');
    w2.report(BASE, { kind: 'z2m', target: 17, sp: 'occupied_heating_setpoint' });
    assert.deepEqual(await w2.at(T(0, 7, 1)), [SET({ occupied_heating_setpoint: 21 })]);
    w2.deaf = true;
    assert.deepEqual(await w2.at(T(0, 8)), [SET({ occupied_heating_setpoint: 18 })]);
    assert.deepEqual(await w2.at(T(0, 8, 5)), [SET({ occupied_heating_setpoint: 18 })]);
    assert.deepEqual(await w2.at(T(0, 8, 10)), [SET({ occupied_heating_setpoint: 18 })]);
    assert.deepEqual(await w2.at(T(0, 8, 15)), [], 'three tries, then it is left alone');
  });

  it('bad entries are left out: a zigbee2mqtt thermostat on another channel or with a Shelly base', () => {
    const c = heat.clean({ tz: TZ, plans: { 1: WEEK }, rooms: [ROOM({ th: [{ ...ZTH, ch: 'thermostat:1' }] }), ROOM({ id: 6, th: [{ ...ZTH, base: 'shellies/x' }] }), ROOM({ id: 7, th: [{ ...ZTH, modes: ['cool', 'off'] }] })] });
    assert.deepEqual(c.rooms.map((r) => [r.id, r.th[0].modes]), [[7, ['off']]]);
  });
});

// ─── the edge part (edge/index.js) with a fake gc ───

const ENTRY = path.join(__dirname, '..', 'edge', 'index.js');

function loadPart({ stored = null } = {}) {
  delete require.cache[require.resolve(ENTRY)];
  const part = require(ENTRY);
  part._test.hooks.interfaces = () => ({});
  const handlers = new Map();
  const listeners = [];
  const published = [];
  const subs = [];
  const emitted = [];
  const store = new Map(stored ? [['heat', stored]] : []);
  const state = { config: null };
  const gc = Object.freeze({
    id: 'gatecontrol-smarthome', version: '1.18.0',
    handle: (m, fn) => handlers.set(m, fn), emit: (name, data) => emitted.push([name, data]), config: () => state.config, onConfig: (fn) => listeners.push(fn),
    log: Object.freeze({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    store: Object.freeze({ get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }, delete: async (k) => { store.delete(k); } }),
    lan: Object.freeze({ http: Object.freeze({ request: async () => { throw Object.assign(new Error('x'), { code: 'net_error' }); } }), mdns: Object.freeze({ browse: async () => ({ stop: async () => {} }) }) }),
    mqtt: Object.freeze({
      subscribe: async (topic, fn) => { const s = { topic, fn, on: true }; subs.push(s); return { unsubscribe: async () => { s.on = false; } }; },
      publish: async (topic, payload) => { published.push([topic, String(payload)]); },
    }),
  });
  return {
    part, gc, published, store, subs, emitted,
    call: async (m, p) => JSON.parse(JSON.stringify(await handlers.get(m)(p === undefined ? null : p, gc))),
    configure(data) { state.config = data; for (const fn of listeners) fn(data, gc); },
    deliver(topic, payload) { for (const s of subs) if (s.on && topic.startsWith(s.topic.replace(/#$/, ''))) s.fn(topic, Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)), { retain: false, qos: 0 }); },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const BRIDGE = [{ ieee_address: IEEE, friendly_name: 'Kinderzimmer TRV', definition: { exposes: [{ type: 'climate', features: [{ property: 'current_heating_setpoint' }, { property: 'local_temperature' }, { property: 'system_mode', values: ['off', 'heat'] }] }] } }];

describe('the edge part runs zigbee2mqtt thermostats', () => {
  it('subscribes to zigbee2mqtt/# for them, names and setpoint from bridge/devices; offline waits; after a restart without the server it goes on', async () => {
    const room = ROOM({ plan: 2, th: [{ ...ZTH, name: 'Altname' }] });
    const cfg = { v: 1, tz: TZ, plans: { 2: Array.from({ length: 7 }, () => [[0, 'eco']]) }, rooms: [room] };
    const e = loadPart();
    e.part.start(e.gc);
    try {
      await settle();
      e.configure({ devices: [], rules: [], tz: TZ, z2m: [], heat: cfg });
      await settle();
      assert.ok(e.subs.some((s) => s.on && s.topic === 'zigbee2mqtt/#'), 'zigbee2mqtt/# for the heating alone');
      assert.deepEqual(e.emitted.filter(([n]) => n === 'z2m').pop(), ['z2m', { state: 'ok' }]);
      e.deliver('zigbee2mqtt/bridge/devices', BRIDGE);
      e.deliver('zigbee2mqtt/Kinderzimmer TRV', { local_temperature: 20, occupied_heating_setpoint: 4, current_heating_setpoint: 21, system_mode: 'heat' });
      await new Promise((r) => setTimeout(r, 1100));
      assert.deepEqual(e.published, [['zigbee2mqtt/Kinderzimmer TRV/set', '{"current_heating_setpoint":18}']], 'the exposed setpoint, the name of zigbee2mqtt');
      e.deliver('zigbee2mqtt/Kinderzimmer TRV', { local_temperature: 20, current_heating_setpoint: 18, system_mode: 'heat' });
      await e.part._test.heatTick();
      assert.deepEqual((await e.call('heat')).rooms, [{ id: 5, kind: 'plan', setpoint: 18, sent: true }]);
      // offline (availability): a new target waits until it is back
      e.configure({ devices: [], rules: [], tz: TZ, z2m: [], heat: { ...cfg, rooms: [{ ...room, mode: 'manual', manual: 20 }] } });
      e.deliver('zigbee2mqtt/Kinderzimmer TRV/availability', { state: 'offline' });
      e.published.length = 0;
      await e.part._test.heatTick();
      assert.deepEqual(e.published, []);
      e.deliver('zigbee2mqtt/Kinderzimmer TRV/availability', 'online');
      await e.part._test.heatTick();
      assert.deepEqual(e.published, [['zigbee2mqtt/Kinderzimmer TRV/set', '{"current_heating_setpoint":20}']]);
      e.deliver('zigbee2mqtt/Kinderzimmer TRV', { current_heating_setpoint: 20, system_mode: 'heat' });
      await e.part._test.heatTick();
      await settle();
    } finally { e.part.stop(e.gc); }
    const e2 = loadPart({ stored: e.store.get('heat') });
    e2.part.start(e2.gc);
    try {
      await settle();
      await settle();
      assert.ok(e2.subs.some((s) => s.on && s.topic === 'zigbee2mqtt/#'), 'from gc.store, without the server');
      e2.deliver('zigbee2mqtt/bridge/devices', BRIDGE);
      e2.deliver('zigbee2mqtt/Kinderzimmer TRV', { current_heating_setpoint: 20, system_mode: 'heat' });
      await e2.part._test.heatTick();
      assert.deepEqual(e2.published, [], 'applied before the restart');
      // the server part takes the room away: zigbee2mqtt/# is let go (no chain needs it)
      e2.configure({ devices: [], rules: [], z2m: [], heat: { v: 1, tz: TZ, rooms: [] } });
      await settle();
      assert.ok(!e2.subs.some((s) => s.on && s.topic === 'zigbee2mqtt/#'));
    } finally { e2.part.stop(e2.gc); }
  });
});

// ─── the server part ────────────────────────────

let now = T(0, 7, 0);

const admin = (host, method, p, body) => {
  const [pathOnly, qs] = String(p).split('?');
  return host.request({ method, path: pathOnly, query: Object.fromEntries(new URLSearchParams(qs || '')), body: body === undefined ? null : body, user: ADMIN });
};
const GWS = [{ id: 7, name: 'Pi Keller', state: 'running', version: '1.46.0' }, { id: 8, name: 'Pi Dach', state: 'running', version: '1.46.0' }];
const ZTRV = (hex, name, gw = 7, o = {}) => ({ gatewayId: gw, gateway: gw === 7 ? 'Pi Keller' : 'Pi Dach', online: true, id: `z2m:${hex}`, ieee: hex.match(/../g).join(':'), name, model: 'TS0601', vendor: 'Tuya',
  kind: 'climate', caps: { setpoint: { min: 5, max: 30, step: 0.5 }, modes: ['off', 'heat', 'auto'] }, values: { temperature: 20.1, setpoint: 20, mode: 'heat', battery: 70 }, seenAt: new Date().toISOString(), ...o });

async function withHouse(fn) {
  const calls = [];
  const radioSent = [];
  const z = { devices: [] };
  const optional = {};
  zigbee._mem.at = 0;
  radio._mem.at = 0;
  const call = async (gatewayId, method, params) => {
    calls.push({ gatewayId, method, params });
    if (method === 'info') return { version: '1.18.0', mqtt: 'ok', lan: ['192.168.1.23'], devices: 1, found: 0, heat: 1 };
    if (method === 'command') return { sent: 1 };
    if (method === 'runs') return { epoch: 'e1', runs: [], more: false };
    throw hostError('edge_error', `unknown_method: ${method}`);
  };
  const host = await createHost(DIR, { users: USERS, gatecontrol: '1.317.1', edge: { gateways: GWS, call, optional },
    radio: { sensors: () => [], zigbee: () => ({ gateways: [{ id: 7, name: 'Pi Keller' }, { id: 8, name: 'Pi Dach' }], devices: z.devices }), command: async (id, set) => { radioSent.push([id, set]); return { accepted: true }; } } });
  try {
    await host.start();
    const sync = async () => { zigbee._mem.at = 0; await zigbee.sync(host.gc, { force: true }); };
    const area = async (name, a) => {
      const id = (await host.gc.db.get('SELECT id FROM resources WHERE name = ?', [name])).row.id;
      assert.equal((await admin(host, 'PUT', `/resources/${id}`, { area: a })).status, 200);
    };
    const roomOf = async (name) => (await admin(host, 'GET', '/heating')).json.rooms.find((r) => r.name === name);
    const edgeCommands = () => calls.splice(0).filter((c) => c.method === 'command');
    await fn(host, { z, optional, sync, area, roomOf, radioSent, edgeCommands, heat: (gw) => (host.edgeConfigs.get(gw) || {}).heat });
  } finally {
    await host.stop();
    await host.close();
  }
}

describe('the server part hands zigbee2mqtt rooms to their gateway (1.18.0)', () => {
  beforeEach(() => { now = T(0, 7, 0); heating._setClock(() => now); });
  after(() => heating._setClock(null));

  it('not confirmed: the room stays on the server (commands through gc.radio); confirmed: on the gateway — handed over without a second command', () => withHouse(async (host, { z, optional, sync, area, roomOf, radioSent, edgeCommands, heat }) => {
    z.devices = [ZTRV('00158d00000000c1', 'Heizung Kind')];
    await sync();
    await area('Heizung Kind', 'Kind');
    let kind = await roomOf('Kind');
    assert.deepEqual(kind.runs_at, { kind: 'server' }, 'zigbee2mqtt/# not confirmed yet');
    await admin(host, 'POST', '/heating/plans', { name: 'Kind', week: WEEK, rooms: [kind.id] });
    assert.deepEqual(radioSent.splice(0), [['z2m:00158d00000000c1', { setpoint: 21 }]], 'the server sends, as before');
    assert.deepEqual(host.edgeRequests || [], [], 'nothing asked for');
    // the device reports it; an administrator confirms zigbee2mqtt/# for gateway 7 — asked again after a minute at most
    z.devices[0].values = { ...z.devices[0].values, setpoint: 21 };
    await sync();
    optional[7] = [KEY];
    await heating.tick(host.gc);
    assert.deepEqual((await roomOf('Kind')).runs_at, { kind: 'server' }, 'not before the next look');
    now = T(0, 7, 2);
    await heating.tick(host.gc);
    kind = await roomOf('Kind');
    assert.deepEqual(kind.runs_at, { kind: 'gateway', gateway_id: 7, name: 'Pi Keller' });
    assert.deepEqual(kind.thermostats.map((x) => [x.source, x.device_boost]), [['z2m', false]]);
    assert.equal(kind.pending, 0, 'the device reports 21 °C: nothing to send on the gateway either');
    assert.deepEqual(heat(7).rooms.map((r) => [r.id, r.th]), [[kind.id, [{ base: 'zigbee2mqtt/0x00158d00000000c1', ch: 'thermostat:0', fam: 'z2m', name: 'Heizung Kind', min: 5, max: 30, step: 0.5, modes: ['off', 'heat', 'auto'], boost: false }]]]);
    // from now on the server sends it nothing: the switching point, by hand, Aus
    now = T(0, 8);
    await heating.tick(host.gc);
    await admin(host, 'POST', `/heating/rooms/${kind.id}`, { action: 'setpoint', setpoint: 22 });
    await admin(host, 'POST', `/heating/rooms/${kind.id}`, { action: 'mode', mode: 'off' });
    assert.deepEqual(radioSent, [], 'no command from the server');
    assert.deepEqual(edgeCommands(), []);
    assert.equal(heat(7).rooms[0].mode, 'off');
    assert.equal((await roomOf('Kind')).pending, 1, 'Aus: system_mode off not reported yet');
    z.devices[0].values = { ...z.devices[0].values, mode: 'off' };
    await sync();
    assert.equal((await roomOf('Kind')).pending, 0);
    // taken back: the room is the server's again (after a minute), the gateway gets an empty list
    delete optional[7];
    now = T(0, 8, 2);
    await heating.tick(host.gc);
    assert.deepEqual((await roomOf('Kind')).runs_at, { kind: 'server' });
    assert.deepEqual(heat(7).rooms, []);
  }));

  it('a zigbee2mqtt thermostat and a Shelly TRV of the same gateway: on the gateway; with one of another gateway: the server; a gateway that refuses zigbee2mqtt/#: the server', () => withHouse(async (host, { z, optional, sync, area, roomOf, heat }) => {
    optional[7] = [KEY];
    optional[8] = [KEY];
    z.devices = [ZTRV('00158d00000000c1', 'Heizung Bad'), ZTRV('00158d00000000c2', 'Heizung Flur'), ZTRV('00158d00000000c3', 'Heizung Flur 2', 8)];
    await sync();
    const r = await admin(host, 'POST', '/edge/devices', { gateway_id: 7, family: 'shelly1', name: 'Heizung Bad 2', area: 'Bad' });
    const base = (await host.gc.db.get('SELECT base FROM edge_devices WHERE id = ?', [r.json.device.id])).row.base;
    await host.edgeEvent(7, 'states', { devices: [{ base, family: 'shelly1', online: true, seenAt: new Date().toISOString(), ch: { 'thermostat:0': { kind: 'gen1', temp: 20, target: 20, schedule: false, boost: 0 } }, sensor: {}, info: {}, drop: [] }] });
    await area('Heizung Bad', 'Bad');
    await area('Heizung Flur', 'Flur');
    await area('Heizung Flur 2', 'Flur');
    await heating.tick(host.gc);
    assert.deepEqual((await roomOf('Bad')).runs_at.kind, 'gateway');
    assert.deepEqual(heat(7).rooms[0].th.map((t) => t.fam).sort(), ['shelly1', 'z2m']);
    assert.deepEqual((await roomOf('Flur')).runs_at, { kind: 'server' }, 'two gateways');
    // gateway 7 refuses the topic (an older gateway): back to the server; its edge part restarts (updated): asked anew
    await host.edgeEvent(7, 'z2m', { state: 'denied' });
    await heating.tick(host.gc);
    assert.deepEqual((await roomOf('Bad')).runs_at, { kind: 'server' });
    assert.deepEqual(heat(7).rooms, []);
    await host.edgeEvent(7, '$started', {});
    await heating.tick(host.gc);
    assert.equal((await roomOf('Bad')).runs_at.kind, 'gateway');
  }));
});
