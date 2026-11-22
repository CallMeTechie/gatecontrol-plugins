'use strict';

// zigbee2mqtt thermostats with preset, boost and window (1.19.0, GateControl gateway 1.47.0, capability
// z2m-thermostat-ext): on the server only for a gateway that names the capability and only what the device's caps name —
// boost with the device's own boost (instead of 30 °C), window_open counts like a window contact, the device's preset is
// shown; without the capability or the field everything stays as in 1.18.0. On the gateway (edge/heat.js) boost with the
// device when its exposes name boost_heating / boost with value_on / value_off — else 30 °C. All names are made up.

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
const texts = require('../server/texts.json');

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const T = (d, h, m = 0) => new Date(2026, 10, 23 + d, h, m).getTime();
const WD = [[0, 'night'], [360, 'comfort'], [480, 'eco'], [960, 'comfort'], [1350, 'night']];
const WEEK = [WD, WD, WD, WD, WD, WD, WD];
const TEMPS = { comfort: 21, eco: 18, night: 17, frost: 7 };
const KEY = 'mqtt.topic:zigbee2mqtt/#';
const IEEE = '0x00158d00000000d1';
const BASE = `zigbee2mqtt/${IEEE}`;
const EXT_CAPS = { setpoint: { min: 5, max: 30, step: 0.5 }, modes: ['off', 'heat', 'auto'], presets: ['manual', 'schedule', 'eco'], boost: true,
  boostTime: { min: 0, max: 3600, step: 1, unit: 's' }, windowDetection: true, windowOpen: true };
const EXT_VALUES = { temperature: 20.1, setpoint: 20, mode: 'heat', preset: 'manual', boost: false, boost_time: 300, window_detection: true, window_open: false };

describe('server/zigbee.js: preset, boost and window only from a gateway with z2m-thermostat-ext', () => {
  const dev = (o = {}) => ({ id: 'z2m:00158d00000000d1', gatewayId: 7, gateway: 'Pi Keller', ieee: '00:15:8d:00:00:00:00:d1', name: 'Heizung Arbeitszimmer', kind: 'climate',
    caps: EXT_CAPS, values: EXT_VALUES, online: true, ...o });

  it('the gateways that name it: capabilities or features', () => {
    const ids = zigbee.extGateways({ gateways: [{ id: 7, capabilities: ['radio', 'z2m-thermostat-ext'] }, { id: 8, features: ['z2m-thermostat-ext'] }, { id: 9, capabilities: ['radio'] }, { id: 'x', capabilities: ['z2m-thermostat-ext'] }, null] });
    assert.deepEqual([...ids].sort(), [7, 8]);
    assert.deepEqual([...zigbee.extGateways({})], []);
  });

  it('with the capability: boost, its length, presets and the window into the resource', () => {
    const r = zigbee.resourceOf(dev(), null, null, true);
    assert.equal(r.kind, 'thermostat');
    assert.deepEqual([r.caps.boost, r.caps.boost_time, r.caps.presets, r.caps.window_open], [true, { min: 0, max: 3600, step: 1, unit: 's' }, ['manual', 'schedule', 'eco'], true]);
    assert.deepEqual([r.state.boost, r.state.preset, r.state.window_open], [false, 'manual', false]);
    // only what the caps name: a device that only reads its window (no caps.windowOpen / windowDetection), no boost
    const r2 = zigbee.resourceOf(dev({ caps: { setpoint: EXT_CAPS.setpoint, modes: EXT_CAPS.modes }, values: { ...EXT_VALUES, window_open: true } }), null, null, true);
    assert.deepEqual([r2.caps.boost, r2.caps.window_open, r2.state.window_open, r2.state.boost, r2.state.preset], [undefined, undefined, undefined, undefined, 'manual']);
  });

  it('without the capability: exactly as in 1.18.0, even when the fields are there', () => {
    const plain = zigbee.resourceOf(dev({ caps: { setpoint: EXT_CAPS.setpoint, modes: EXT_CAPS.modes }, values: { temperature: 20.1, setpoint: 20, mode: 'heat' } }), null, null, false);
    assert.deepEqual(zigbee.resourceOf(dev(), null, null, false), plain);
    assert.deepEqual(zigbee.resourceOf(dev(), null, null), plain, 'the default is without');
  });

  it('the command for the heating: boost with its length in the unit of the device, back with the target', () => {
    const r = { id: 3, kind: 'thermostat', deconz_type: 'z2m', deconz_id: 'z2m:00158d00000000d1', capabilities: zigbee.resourceOf(dev(), null, null, true).caps, state: { reachable: true, setpoint: 20, mode: 'heat' } };
    heating._setClock(() => T(0, 9));
    try {
      const want = { kind: 'boost', until: T(0, 9, 30), minutes: 30 };
      assert.deepEqual(heating.commandFor(r, want, { kind: 'plan' }, true), { boost: true, boost_time: 1800 });
      const inMin = { ...r, capabilities: { ...r.capabilities, boost_time: { min: 1, max: 60, step: 1, unit: 'min' } } };
      assert.deepEqual(heating.commandFor(inMin, want, { kind: 'plan' }, true), { boost: true, boost_time: 30 });
      const noUnit = { ...r, capabilities: { ...r.capabilities, boost_time: { min: 1, max: 60, step: 1, unit: null } } };
      assert.deepEqual(heating.commandFor(noUnit, want, { kind: 'plan' }, true), { boost: true }, 'an unknown unit: the device keeps its own length');
      assert.deepEqual(heating.commandFor(r, { kind: 'plan', setpoint: 21 }, { kind: 'boost' }, true), { setpoint: 21, boost: false });
      assert.deepEqual(heating.commandFor(r, { kind: 'off', frost: 7 }, { kind: 'boost' }, true), { mode: 'off', boost: false });
      const old = { ...r, capabilities: zigbee.resourceOf(dev(), null, null, false).caps };
      assert.deepEqual(heating.commandFor(old, want, { kind: 'plan' }, true), { setpoint: 30 }, 'without: 30 °C');
    } finally { heating._setClock(null); }
  });
});

// ─── the server part with a mock host ───────────

let now = T(0, 7, 0);
const admin = (host, method, p, body) => host.request({ method, path: p, query: {}, body: body === undefined ? null : body, user: ADMIN });
const GWS = [{ id: 7, name: 'Pi Keller', state: 'running', version: '1.47.0' }];
const ZTRV = (o = {}) => ({ gatewayId: 7, gateway: 'Pi Keller', online: true, id: 'z2m:00158d00000000d1', ieee: '00:15:8d:00:00:00:00:d1', name: 'Heizung Arbeitszimmer', model: 'TS0601', vendor: 'Tuya',
  kind: 'climate', caps: EXT_CAPS, values: { ...EXT_VALUES }, seenAt: new Date().toISOString(), ...o });

async function withHouse({ ext = true } = {}, fn) {
  const radioSent = [];
  const z = { devices: [] };
  const optional = {};
  zigbee._mem.at = 0;
  radio._mem.at = 0;
  const call = async (gatewayId, method) => {
    if (method === 'info') return { version: '1.19.0', mqtt: 'ok', lan: ['192.168.1.23'], devices: 1, found: 0, heat: 1 };
    if (method === 'command') return { sent: 1 };
    if (method === 'runs') return { epoch: 'e1', runs: [], more: false };
    throw hostError('edge_error', `unknown_method: ${method}`);
  };
  const gateways = [{ id: 7, name: 'Pi Keller', ...(ext ? { capabilities: ['radio', 'z2m-thermostat-ext'] } : {}) }];
  const host = await createHost(DIR, { users: USERS, gatecontrol: '1.317.1', edge: { gateways: GWS, call, optional },
    radio: { sensors: () => [], zigbee: () => ({ gateways, devices: z.devices }), command: async (id, set) => { radioSent.push([id, set]); return { accepted: true }; } } });
  try {
    await host.start();
    const sync = async () => { zigbee._mem.at = 0; await zigbee.sync(host.gc, { force: true }); };
    const roomOf = async () => (await admin(host, 'GET', '/heating')).json.rooms.find((r) => r.name === 'Arbeit');
    z.devices = [ZTRV()];
    await sync();
    const id = (await host.gc.db.get('SELECT id FROM resources WHERE name = ?', ['Heizung Arbeitszimmer'])).row.id;
    assert.equal((await admin(host, 'PUT', `/resources/${id}`, { area: 'Arbeit' })).status, 200);
    const room = await roomOf();
    await admin(host, 'POST', '/heating/plans', { name: 'Arbeit', week: WEEK, rooms: [room.id] });
    await fn(host, { z, optional, sync, roomOf, radioSent, roomId: room.id, heat: (gw) => (host.edgeConfigs.get(gw) || {}).heat });
  } finally {
    await host.stop();
    await host.close();
  }
}

describe('the heating on the server with z2m-thermostat-ext (1.19.0)', () => {
  beforeEach(() => { now = T(0, 7, 0); heating._setClock(() => now); });
  after(() => heating._setClock(null));

  it('boost with the device\'s own boost and its length; the status says "Boost (Gerät)"; afterwards the target with boost off', () => withHouse({}, async (host, { z, sync, roomOf, radioSent, roomId }) => {
    assert.deepEqual(radioSent.splice(0), [['z2m:00158d00000000d1', { setpoint: 21 }]]);
    let r = await admin(host, 'POST', `/heating/rooms/${roomId}`, { action: 'boost', minutes: 30 });
    assert.deepEqual(radioSent.splice(0), [['z2m:00158d00000000d1', { boost: true, boost_time: 1800 }]]);
    assert.equal(r.json.room.boost.device, true);
    assert.match(r.json.room.status_text, /^Boost \(Gerät\) · noch 30 min, danach Komfort 21,0 °C/);
    assert.deepEqual(r.json.room.thermostats.map((x) => [x.device_boost, x.device_preset, x.window_open]), [[true, 'manual', false]]);
    z.devices[0].values = { ...z.devices[0].values, boost: true, setpoint: 20 };
    await sync();
    r = await admin(host, 'POST', `/heating/rooms/${roomId}`, { action: 'boost_stop' });
    assert.deepEqual(radioSent.splice(0), [['z2m:00158d00000000d1', { setpoint: 21, boost: false }]]);
    assert.equal(r.json.room.boost, null);
    assert.ok((await roomOf()).status_text.startsWith('Komfort'));
    // en: "Boost (device)"
    assert.equal(heating.statusText({ ...r.json.room, status: { kind: 'boost', until: T(0, 7, 30) }, boost: { device: true }, after: null, pending: 0 }, 'en', T(0, 7)), 'Boost (device) · 30 min left, then –');
  }));

  it('window_open of the thermostat counts like a contact: after the plan\'s minutes Frostschutz, closed again → the plan', () => withHouse({}, async (host, { z, sync, roomOf, radioSent }) => {
    radioSent.length = 0;
    z.devices[0].values = { ...z.devices[0].values, setpoint: 21, window_open: true };
    await sync();
    await heating.tick(host.gc);
    let room = await roomOf();
    assert.deepEqual([room.window.open, room.window.lowered, room.window.devices], [true, false, [{ id: room.thermostats[0].id, name: 'Heizung Arbeitszimmer', open: true, reachable: true }]]);
    assert.deepEqual(radioSent, [], 'not yet: 2 minutes without a plan setting');
    now = T(0, 7, 2);
    await heating.tick(host.gc);
    room = await roomOf();
    assert.deepEqual([room.status.kind, room.window.lowered], ['window', true]);
    assert.deepEqual(radioSent.splice(0), [['z2m:00158d00000000d1', { setpoint: 7 }]]);
    // the widget of the apps shows the window (as for a contact)
    assert.deepEqual(heating.widgetOf(room, 'de', now).readings.find((x) => x.id === 'window'), { id: 'window', label: 'Fenster', icon: heating.ICONS.window, value: 'offen', state: 'warn' });
    z.devices[0].values = { ...z.devices[0].values, setpoint: 7, window_open: false };
    await sync();
    now = T(0, 7, 3);
    await heating.tick(host.gc);
    assert.equal((await roomOf()).status.kind, 'plan');
    assert.deepEqual(radioSent.splice(0), [['z2m:00158d00000000d1', { setpoint: 21 }]]);
  }));

  it('a gateway without z2m-thermostat-ext: boost 30 °C, window_open ignored, no preset — as in 1.18.0', () => withHouse({ ext: false }, async (host, { z, sync, roomOf, radioSent, roomId }) => {
    radioSent.length = 0;
    const r = await admin(host, 'POST', `/heating/rooms/${roomId}`, { action: 'boost', minutes: 30 });
    assert.deepEqual(radioSent.splice(0), [['z2m:00158d00000000d1', { setpoint: 30 }]]);
    assert.match(r.json.room.status_text, /^Boost · noch 30 min/);
    assert.deepEqual(r.json.room.thermostats.map((x) => [x.device_boost, x.device_preset, x.window_open]), [[false, null, null]]);
    await admin(host, 'POST', `/heating/rooms/${roomId}`, { action: 'boost_stop' });
    radioSent.length = 0;
    z.devices[0].values = { ...z.devices[0].values, setpoint: 21, window_open: true };
    await sync();
    now = T(0, 7, 10);
    await heating.tick(host.gc);
    now = T(0, 7, 20);
    await heating.tick(host.gc);
    const room = await roomOf();
    assert.deepEqual([room.status.kind, room.window.open, room.window.devices], ['plan', false, []]);
    assert.deepEqual(radioSent, []);
  }));

  it('on the gateway: the server counts a boost as done once the device reports its boost (or 30 °C)', () => withHouse({}, async (host, { z, optional, sync, roomOf, roomId, heat }) => {
    z.devices[0].values = { ...z.devices[0].values, setpoint: 21 };
    await sync();
    optional[7] = [KEY];
    now = T(0, 7, 2);
    await heating.tick(host.gc);
    assert.equal((await roomOf()).runs_at.kind, 'gateway');
    await admin(host, 'POST', `/heating/rooms/${roomId}`, { action: 'boost', minutes: 15 });
    assert.deepEqual(heat(7).rooms[0].boost, { at: now, until: now + 15 * 60000, minutes: 15 });
    let room = await roomOf();
    assert.deepEqual([room.pending, room.boost.device], [1, true]);
    z.devices[0].values = { ...z.devices[0].values, boost: true };
    await sync();
    room = await roomOf();
    assert.equal(room.pending, 0);
  }));
});

// ─── the gateway (edge/heat.js, edge/index.js, commands, normalize) ───

describe('the gateway boosts with the device when its exposes name it', () => {
  const ZB = { prop: 'boost_heating', on: 'ON', off: 'OFF' };
  const ZTH = { base: BASE, ch: 'thermostat:0', fam: 'z2m', name: 'Heizung Arbeitszimmer', min: 5, max: 30, step: 0.5, modes: ['off', 'heat', 'auto'], boost: false };
  const ROOM = (o = {}) => ({ id: 5, th: [ZTH], temps: TEMPS, plan: 1, away: false, mode: 'plan', manual: null, hold: null, vac: null, ov: null, boost: null, win: null, ...o });

  it('commands: zigbee2mqtt/<name>/set with value_on / value_off of the property; nothing else', () => {
    const z = { base: BASE, family: 'z2m', ch: 'thermostat:0', op: 'boost' };
    const opts = { z2mTopic: () => 'Arbeitszimmer TRV' };
    assert.deepEqual(commands.messages({ ...z, value: true, prop: 'boost_heating', on: 'ON', off: 'OFF' }, opts), [{ topic: 'zigbee2mqtt/Arbeitszimmer TRV/set', payload: '{"boost_heating":"ON"}' }]);
    assert.deepEqual(commands.messages({ ...z, value: false, prop: 'boost', on: true, off: false }, opts), [{ topic: 'zigbee2mqtt/Arbeitszimmer TRV/set', payload: '{"boost":false}' }]);
    for (const bad of [{ ...z, value: true }, { ...z, value: 30, prop: 'boost', on: 'ON', off: 'OFF' }, { ...z, value: true, prop: 'window_open', on: 'ON', off: 'OFF' },
      { ...z, value: true, prop: 'boost', on: 'ON', off: 'ON' }, { ...z, value: true, prop: 'boost', on: { x: 1 }, off: 'OFF' }]) {
      assert.throws(() => commands.messages(bad, opts), (e) => e.code === 'bad_command', JSON.stringify(bad));
    }
  });

  it('normalize: the boost the device reports, with the values of its exposes', () => {
    const a = normalize.parseZ2m(BASE, Buffer.from(JSON.stringify({ occupied_heating_setpoint: 21, boost_heating: 'ON' })), { kind: 'thermostat', boost: ZB });
    assert.equal(a.patch.ch['thermostat:0'].boost, true);
    const b = normalize.parseZ2m(BASE, Buffer.from(JSON.stringify({ occupied_heating_setpoint: 21, boost_heating: 'OFF' })), { kind: 'thermostat', boost: ZB });
    assert.equal(b.patch.ch['thermostat:0'].boost, false);
    const c = normalize.parseZ2m(BASE, Buffer.from(JSON.stringify({ occupied_heating_setpoint: 21, boost_heating: 'ON' })), { kind: 'thermostat' });
    assert.equal(c.patch.ch['thermostat:0'].boost, undefined, 'without its exposes: nothing');
  });

  function rig(zb) {
    const w = { now: T(0, 7), devices: new Map(), sent: [] };
    const report = (c) => {
      const d = w.devices.get(BASE) || { base: BASE, online: true, seenAt: null, ch: {} };
      d.ch['thermostat:0'] = { ...(d.ch['thermostat:0'] || {}), ...c };
      d.seenAt = new Date(w.now).toISOString();
      w.devices.set(BASE, d);
    };
    report({ kind: 'z2m', target: 21, temp: 20, mode: 'heat', sp: 'occupied_heating_setpoint' });
    w.report = report;
    w.engine = heat.create({
      now: () => w.now, device: (base) => w.devices.get(base) || null, z2mTopic: () => 'Arbeitszimmer TRV', z2mBoost: () => zb,
      publish: async (list) => {
        for (const m of list) {
          w.sent.push([m.topic, m.payload]);
          const j = JSON.parse(m.payload);
          if ('occupied_heating_setpoint' in j) report({ target: j.occupied_heating_setpoint });
          if ('boost_heating' in j) report({ boost: j.boost_heating === 'ON' });
        }
      },
      save: () => {}, log: { warn: () => {}, info: () => {}, debug: () => {} },
    });
    w.at = async (ms) => { w.now = ms; for (const d of w.devices.values()) d.seenAt = new Date(ms).toISOString(); await w.engine.tick(); return w.sent.splice(0); };
    return w;
  }
  const SET = (j) => ['zigbee2mqtt/Arbeitszimmer TRV/set', JSON.stringify(j)];

  it('boost_heating with value_on / value_off: ON instead of 30 °C, afterwards OFF with the target; once each', async () => {
    const w = rig(ZB);
    w.engine.set({ v: 1, tz: TZ, plans: { 1: WEEK }, rooms: [ROOM({ boost: { at: T(0, 7), until: T(0, 7, 30), minutes: 30 } })] });
    assert.deepEqual(await w.at(T(0, 7)), [SET({ boost_heating: 'ON' })]);
    assert.deepEqual(await w.at(T(0, 7, 10)), []);
    assert.deepEqual(await w.at(T(0, 7, 30)), [SET({ boost_heating: 'OFF' }), SET({ occupied_heating_setpoint: 21 })]);
    assert.deepEqual(await w.at(T(0, 7, 40)), [], 'it reports both');
  });

  it('a boost already on (the server sent it before the hand-over) is not sent again; Aus after a boost ends it', async () => {
    const w = rig(ZB);
    w.report({ boost: true });
    w.engine.set({ v: 1, tz: TZ, plans: { 1: WEEK }, rooms: [ROOM({ boost: { at: T(0, 7), until: T(0, 7, 30), minutes: 30 } })] });
    assert.deepEqual(await w.at(T(0, 7)), []);
    w.engine.set({ v: 1, tz: TZ, plans: { 1: WEEK }, rooms: [ROOM({ mode: 'off' })] });
    assert.deepEqual(await w.at(T(0, 7, 5)), [SET({ boost_heating: 'OFF' }), SET({ system_mode: 'off' })]);
  });

  it('without a boost in its exposes: 30 °C as in 1.18.0', async () => {
    const w = rig(null);
    w.engine.set({ v: 1, tz: TZ, plans: { 1: WEEK }, rooms: [ROOM({ boost: { at: T(0, 7), until: T(0, 7, 30), minutes: 30 } })] });
    assert.deepEqual(await w.at(T(0, 7)), [SET({ occupied_heating_setpoint: 30 })]);
  });

  // the edge part reads the exposes from zigbee2mqtt/bridge/devices
  const ENTRY = path.join(__dirname, '..', 'edge', 'index.js');
  function loadPart() {
    delete require.cache[require.resolve(ENTRY)];
    const part = require(ENTRY);
    part._test.hooks.interfaces = () => ({});
    const listeners = [];
    const published = [];
    const subs = [];
    const state = { config: null };
    const store = new Map();
    const gc = Object.freeze({
      id: 'gatecontrol-smarthome', version: '1.19.0',
      handle: () => {}, emit: () => {}, config: () => state.config, onConfig: (fn) => listeners.push(fn),
      log: Object.freeze({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
      store: Object.freeze({ get: async (k) => (store.has(k) ? store.get(k) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }, delete: async (k) => { store.delete(k); } }),
      lan: Object.freeze({ http: Object.freeze({ request: async () => { throw Object.assign(new Error('x'), { code: 'net_error' }); } }), mdns: Object.freeze({ browse: async () => ({ stop: async () => {} }) }) }),
      mqtt: Object.freeze({
        subscribe: async (topic, fn) => { const s = { topic, fn, on: true }; subs.push(s); return { unsubscribe: async () => { s.on = false; } }; },
        publish: async (topic, payload) => { published.push([topic, String(payload)]); },
      }),
    });
    return {
      part, gc, published,
      configure(data) { state.config = data; for (const fn of listeners) fn(data, gc); },
      deliver(topic, payload) { for (const s of subs) if (s.on && topic.startsWith(s.topic.replace(/#$/, ''))) s.fn(topic, Buffer.from(JSON.stringify(payload)), { retain: false, qos: 0 }); },
    };
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const bridge = (boost) => [{ ieee_address: IEEE, friendly_name: 'Arbeitszimmer TRV', definition: { exposes: [{ type: 'climate', features: [{ property: 'occupied_heating_setpoint', access: 7 }, { property: 'local_temperature' }] }, ...boost] } }];

  for (const [name, exposes, want] of [
    ['boost_heating with value_on / value_off → its own boost', [{ type: 'binary', property: 'boost_heating', access: 7, value_on: 'ON', value_off: 'OFF' }], '{"boost_heating":"ON"}'],
    ['boost (no boost_heating) → its own boost', [{ type: 'binary', property: 'boost', access: 3, value_on: true, value_off: false }], '{"boost":true}'],
    ['without value_off → 30 °C', [{ type: 'binary', property: 'boost_heating', access: 7, value_on: 'ON' }], '{"occupied_heating_setpoint":30}'],
    ['only readable → 30 °C', [{ type: 'binary', property: 'boost_heating', access: 1, value_on: 'ON', value_off: 'OFF' }], '{"occupied_heating_setpoint":30}'],
  ]) {
    it(`the edge part: ${name}`, async () => {
      const e = loadPart();
      e.part.start(e.gc);
      try {
        await settle();
        const boost = { at: Date.now() - 60000, until: Date.now() + 30 * 60000, minutes: 30 };
        e.configure({ devices: [], rules: [], tz: TZ, z2m: [], heat: { v: 1, tz: TZ, plans: { 1: WEEK }, rooms: [ROOM({ boost })] } });
        await settle();
        e.deliver('zigbee2mqtt/bridge/devices', bridge(exposes));
        e.deliver('zigbee2mqtt/Arbeitszimmer TRV', { local_temperature: 20, occupied_heating_setpoint: 21, system_mode: 'heat' });
        await e.part._test.heatTick();
        assert.deepEqual(e.published.filter(([t]) => t.endsWith('/set')), [['zigbee2mqtt/Arbeitszimmer TRV/set', want]]);
      } finally { e.part.stop(e.gc); }
    });
  }
});

describe('1.19.0: texts', () => {
  it('the warning about a gateway that refuses zigbee2mqtt names the heating too (de / en)', () => {
    assert.match(texts.de['chain.z2m_unavailable'], /Heizung/);
    assert.match(texts.en['chain.z2m_unavailable'], /heating/);
    for (const k of ['heat.st.boost_device', 'heat.ui.ov_boost_device', 'heat.ui.device_preset', 'heat.ui.window_device_open']) {
      assert.ok(texts.de[k] && texts.en[k], k);
    }
  });
});
