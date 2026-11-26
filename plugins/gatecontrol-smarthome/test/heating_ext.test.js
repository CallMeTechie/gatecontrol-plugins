'use strict';

// Heizung 1.20.0: a room keeps its plan when its area is renamed, "Feiertage wie Sonntag" (holidays computed here, also
// on the gateway), the Versatz per thermostat, the boost target as a setting, window contacts the gateway hears itself
// (GateControl gateway with radio-contacts, gatecontrol/contacts/#). All rooms, names and values are made up.

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHost, hostError } = require('../../../tools/testing/mock-host');
const { DIR, ADMIN, USERS } = require('./helpers');
const holidays = require('../server/holidays');
const heating = require('../server/heating');
const zigbee = require('../server/zigbee');
const radio = require('../server/radio');
const heat = require('../edge/heat');
const commands = require('../edge/commands');
const normalize = require('../edge/normalize');

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
// Monday 23 November 2026 (local time) + d days, h:m
const T = (d, h, m = 0) => new Date(2026, 10, 23 + d, h, m).getTime();
const WD = [[0, 'night'], [360, 'comfort'], [480, 'eco'], [960, 'comfort'], [1350, 'night']];
const SU = [[0, 'night'], [540, 'comfort'], [1380, 'night']];
const WEEK = [WD, WD, WD, WD, WD, WD, SU];
const TEMPS = { comfort: 21, eco: 18, night: 17, frost: 7 };

describe('holidays (server/holidays.js)', () => {
  it('Easter and the holidays of the states', () => {
    assert.deepEqual(holidays.easter(2026), { month: 4, day: 5 });
    assert.deepEqual(holidays.easter(2027), { month: 3, day: 28 });
    assert.deepEqual(holidays.easter(2024), { month: 3, day: 31 });
    assert.deepEqual(holidays.easter(2038), { month: 4, day: 25 });
    const de = holidays.holidaysOf(2026, 'DE').map((h) => h.date);
    assert.deepEqual(de, ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-14', '2026-05-25', '2026-10-03', '2026-12-25', '2026-12-26']);
    const by = holidays.holidaysOf(2026, 'BY').map((h) => h.date);
    for (const d of ['2026-01-06', '2026-06-04', '2026-08-15', '2026-11-01']) assert.ok(by.includes(d), d);
    assert.ok(!by.includes('2026-10-31'));
    assert.ok(holidays.holidaysOf(2026, 'SN').some((h) => h.date === '2026-11-18' && h.key === 'repentance'), 'Buß- und Bettag');
    assert.ok(holidays.holidaysOf(2026, 'BE').some((h) => h.date === '2026-03-08'));
    assert.ok(!holidays.holidaysOf(2018, 'BE').some((h) => h.date === '2018-03-08'), 'Frauentag in Berlin from 2019');
    assert.ok(holidays.holidaysOf(2026, 'TH').some((h) => h.date === '2026-09-20'));
    assert.ok(holidays.holidaysOf(2026, 'NI').some((h) => h.date === '2026-10-31'));
    assert.deepEqual(holidays.holidaysOf(2026, 'XX'), holidays.holidaysOf(2026, 'DE'), 'unknown: the holidays of all states');
  });

  it('the state of a location; the setting', () => {
    assert.equal(holidays.regionAt({ lat: 48.14, lon: 11.58 }), 'BY');
    assert.equal(holidays.regionAt({ lat: 53.56, lon: 10.0 }), 'HH');
    assert.equal(holidays.regionAt({ lat: 50.94, lon: 6.96 }), 'NW');
    assert.equal(holidays.regionAt({ lat: 51.05, lon: 13.74 }), 'SN');
    assert.equal(holidays.regionAt({ lat: 48.86, lon: 2.35 }), null, 'outside Germany');
    assert.equal(holidays.regionAt(null), null);
    assert.deepEqual(holidays.resolve('auto', { lat: 48.14, lon: 11.58 }), { region: 'BY', auto: true });
    assert.deepEqual(holidays.resolve(undefined, null), { region: 'DE', auto: true });
    assert.deepEqual(holidays.resolve('SH', { lat: 48.14, lon: 11.58 }), { region: 'SH', auto: false });
    assert.deepEqual(holidays.resolve('nonsense', null), { region: 'DE', auto: true });
    const ds = holidays.datesOf('DE', 2026, 2);
    assert.ok(ds.includes('2026-12-25') && ds.includes('2027-01-01') && ds.every((d, i) => i === 0 || d > ds[i - 1]));
  });
});

describe('Feiertage wie Sonntag: the plan', () => {
  // Friday 25 December 2026, 07:00: a weekday says Komfort, Sunday says Nacht (until 09:00)
  const XMAS = new Date(2026, 11, 25, 7, 0).getTime();
  const hol = new Set(['2026-12-25']);
  it('the server part: a holiday runs the Sunday of a plan with the switch, not of one without', () => {
    const room = { id: 1, plan_id: 1, mode: 'plan', presets: {}, thermostats: [] };
    const ctx = (on) => ({ plans: new Map([[1, { id: 1, week: WEEK, presets: {}, window: { on: true, min: 2 }, away: true, holidays: on }]]), house: { presets: {}, away: false, vacation: null }, holidays: hol });
    assert.equal(heating.decide(room, ctx(true), XMAS).preset, 'night');
    assert.equal(heating.decide(room, ctx(false), XMAS).preset, 'comfort');
    assert.equal(heating.decide(room, ctx(true), XMAS + 2 * 3600000).preset, 'comfort', 'Sunday 09:00 Komfort');
    assert.equal(heating.dayOf(new Date(XMAS), hol), 6);
    assert.equal(heating.dayOf(new Date(XMAS), null), 4);
  });

  it('the gateway: the dates go with the configuration, a room with hol runs the Sunday', () => {
    const room = (o) => ({ id: 3, th: [{ base: 'shellies/heizung-bad', ch: 'thermostat:0', fam: 'shelly1' }], temps: TEMPS, plan: 1, mode: 'plan', ...o });
    const c = heat.clean({ v: 1, tz: TZ, plans: { 1: WEEK }, rooms: [room({ hol: true }), { ...room({}), id: 4 }], hol: ['2026-12-25', 'kaputt'] });
    assert.deepEqual([...c.hol], ['2026-12-25']);
    assert.equal(heat.decide(c.rooms[0], XMAS, c.tz, c.hol).preset, 'night');
    assert.equal(heat.decide(c.rooms[1], XMAS, c.tz, c.hol).preset, 'comfort');
    // the slot of the section: the day after keeps a switching point at its own start (Sunday night → Saturday 06:00)
    assert.notEqual(heat.planAt(WEEK, XMAS, TZ, hol).slot, heat.planAt(WEEK, XMAS, TZ, null).slot);
  });
});

// ─── the gateway: Versatz, boost target, its own window contacts ───

const TH1 = { base: 'shellies/heizung-bad', ch: 'thermostat:0', fam: 'shelly1', min: 5, max: 30, boost: false };
const ZTH = { base: 'zigbee2mqtt/0x00158d0001010101', ch: 'thermostat:0', fam: 'z2m', name: 'Kinderzimmer TRV', min: 5, max: 30, step: 0.5, modes: ['off', 'heat'] };
const ROOM = (o = {}) => ({ id: 3, th: [TH1], temps: TEMPS, plan: 2, away: false, mode: 'plan', manual: null, hold: null, vac: null, ov: null, boost: null, win: null, ...o });
const ECO = { 2: Array.from({ length: 7 }, () => [[0, 'eco']]) };

function rig(cfg, o = {}) {
  const w = { now: o.now || T(0, 7), devices: new Map(), sent: [], contacts: new Map(), cal: new Map() };
  const report = (base, ch, c) => {
    const d = w.devices.get(base) || { base, online: true, seenAt: null, ch: {} };
    d.ch[ch] = { ...(d.ch[ch] || {}), ...c };
    d.seenAt = new Date(w.now).toISOString();
    w.devices.set(base, d);
  };
  w.report = report;
  report(TH1.base, TH1.ch, { kind: 'gen1', target: 20, temp: 20, schedule: false });
  report(ZTH.base, ZTH.ch, { kind: 'z2m', target: 20, temp: 20, sp: 'current_heating_setpoint', mode: 'heat' });
  w.engine = heat.create({
    now: () => w.now,
    device: (base) => w.devices.get(base) || null,
    publish: async (list) => {
      for (const m of list) {
        w.sent.push([m.topic, m.payload]);
        const g1 = /^(shellies\/[^/]+)\/thermostat\/0\/command\/target_t$/.exec(m.topic);
        if (g1) report(g1[1], 'thermostat:0', { target: Number(m.payload) });
        if (m.topic === 'zigbee2mqtt/Kinderzimmer TRV/set') {
          const j = JSON.parse(m.payload);
          if ('current_heating_setpoint' in j) report(ZTH.base, ZTH.ch, { target: j.current_heating_setpoint });
          if ('local_temperature_calibration' in j && !o.deafCal) report(ZTH.base, ZTH.ch, { cal: j.local_temperature_calibration });
        }
      }
    },
    save: () => {},
    z2mTopic: () => 'Kinderzimmer TRV',
    z2mCal: (base) => w.cal.get(base) || null,
    contact: (id) => w.contacts.get(id) || null,
    log: { warn: () => {}, info: () => {} },
  });
  w.engine.set({ v: 1, tz: TZ, plans: ECO, ...cfg });
  w.at = async (ms) => {
    w.now = ms;
    for (const d of w.devices.values()) d.seenAt = new Date(ms).toISOString();
    await w.engine.tick();
    return w.sent.splice(0);
  };
  return w;
}

describe('the gateway (edge/heat.js): Versatz, boost target, window contacts', () => {
  it('Versatz: a Shelly TRV gets target − offset; the boost target of the setting', async () => {
    const w = rig({ rooms: [ROOM({ th: [{ ...TH1, off: -1.5 }] })] });
    assert.deepEqual(await w.at(T(0, 7)), [['shellies/heizung-bad/thermostat/0/command/target_t', '19.5']], 'Eco 18 °C with −1.5: the TRV measures 1.5 °C too much');
    w.engine.set({ v: 1, tz: TZ, plans: ECO, bt: 24, rooms: [ROOM({ boost: { at: T(0, 7, 1), until: T(0, 7, 31) } })] });
    assert.deepEqual(await w.at(T(0, 7, 2)), [['shellies/heizung-bad/thermostat/0/command/target_t', '24']], 'boost 24 °C instead of 30');
    assert.equal(heat.clean({ bt: 35 }).bt, 30);
    assert.equal(heat.clean({ th: [] }).bt, 30);
    assert.equal(heat.clean({ rooms: [ROOM({ th: [{ ...TH1, off: 7 }] })] }).rooms[0].th[0].off, 0, 'out of range: none');
  });

  it('Versatz on a zigbee2mqtt thermostat with its own calibration: set in the device, then the target unchanged', async () => {
    const w = rig({ rooms: [ROOM({ th: [{ ...ZTH, off: -1, cal: true }] })] });
    w.cal.set(ZTH.base, { min: -5, max: 5, step: 0.1 });
    const first = await w.at(T(0, 7));
    assert.deepEqual(first, [['zigbee2mqtt/Kinderzimmer TRV/set', '{"local_temperature_calibration":-1}'], ['zigbee2mqtt/Kinderzimmer TRV/set', '{"current_heating_setpoint":19}']],
      'calibration first; the target still with the offset until the device reports it');
    assert.deepEqual(await w.at(T(0, 12)), [['zigbee2mqtt/Kinderzimmer TRV/set', '{"current_heating_setpoint":18}']], 'it measures right now: Eco 18 °C as it is');
    assert.deepEqual(await w.at(T(0, 12, 30)), []);
    // without calibration in its exposes: target − offset
    const w2 = rig({ rooms: [ROOM({ th: [{ ...ZTH, off: -1, cal: true }] })] });
    assert.deepEqual(await w2.at(T(0, 7)), [['zigbee2mqtt/Kinderzimmer TRV/set', '{"current_heating_setpoint":19}']]);
    assert.throws(() => commands.messages({ base: TH1.base, family: 'shelly1', ch: 'thermostat:0', op: 'calibration', value: 1 }), (e) => e.code === 'bad_command');
    assert.throws(() => commands.messages({ base: ZTH.base, family: 'z2m', ch: 'thermostat:0', op: 'calibration', value: 20 }, { z2mTopic: () => 'x' }), (e) => e.code === 'bad_command');
    const r = normalize.parseZ2m(ZTH.base, JSON.stringify({ local_temperature: 20.5, local_temperature_calibration: -1, current_heating_setpoint: 18 }), { kind: 'thermostat', sp: 'current_heating_setpoint' });
    assert.equal(r.patch.ch['thermostat:0'].cal, -1);
  });

  it('a window contact the gateway hears itself: open longer than the wait → Frostschutz without the server; closed → back', async () => {
    const id = 'ble-a4c138001122';
    const w = rig({ rooms: [ROOM({ ct: [id, 'nonsense'], wm: 2 })] });
    assert.deepEqual(w.engine.contacts(), [id]);
    assert.deepEqual(await w.at(T(0, 7)), [['shellies/heizung-bad/thermostat/0/command/target_t', '18']]);
    w.contacts.set(id, { open: true, since: T(0, 7, 1), seen: T(0, 7, 1) });
    assert.deepEqual(await w.at(T(0, 7, 2)), [], 'the wait (2 min) has not passed');
    assert.deepEqual(await w.at(T(0, 7, 3)), [['shellies/heizung-bad/thermostat/0/command/target_t', '7']], 'lowered');
    assert.equal(w.engine.view()[0].kind, 'window');
    w.contacts.set(id, { open: false, since: T(0, 7, 10), seen: T(0, 7, 10) });
    assert.deepEqual(await w.at(T(0, 7, 11)), [['shellies/heizung-bad/thermostat/0/command/target_t', '18']], 'closed: back to Eco');
    // open, but its last report is older than 2 h: no longer counts
    w.contacts.set(id, { open: true, since: T(0, 8), seen: T(0, 8) });
    assert.deepEqual(await w.at(T(0, 8, 5)), [['shellies/heizung-bad/thermostat/0/command/target_t', '7']]);
    assert.deepEqual(await w.at(T(0, 10, 1)), [['shellies/heizung-bad/thermostat/0/command/target_t', '18']], '2 h without news: back to the plan');
    // offline (zigbee2mqtt availability): does not count
    w.contacts.set('z2m-00158d0002020202', { open: true, since: T(0, 10), seen: T(0, 10, 30), online: false });
    w.engine.set({ v: 1, tz: TZ, plans: ECO, rooms: [ROOM({ ct: ['z2m-00158d0002020202'], wm: 1 })] });
    assert.deepEqual(await w.at(T(0, 10, 31)), []);
  });
});

// ─── the edge part (edge/index.js) with a fake gc ───

const ENTRY = path.join(__dirname, '..', 'edge', 'index.js');

function loadPart({ deny = false } = {}) {
  delete require.cache[require.resolve(ENTRY)];
  const part = require(ENTRY);
  part._test.hooks.interfaces = () => ({});
  const listeners = [];
  const published = [];
  const subs = [];
  const emitted = [];
  const state = { config: null };
  const gc = Object.freeze({
    id: 'gatecontrol-smarthome', version: '1.20.0',
    handle: () => {}, emit: (name, data) => emitted.push([name, data]), config: () => state.config, onConfig: (fn) => listeners.push(fn),
    log: Object.freeze({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    store: Object.freeze({ get: async () => null, set: async () => {}, delete: async () => {} }),
    lan: Object.freeze({ http: Object.freeze({ request: async () => { throw Object.assign(new Error('x'), { code: 'net_error' }); } }), mdns: Object.freeze({ browse: async () => ({ stop: async () => {} }) }) }),
    mqtt: Object.freeze({
      subscribe: async (topic, fn) => {
        if (deny && topic === 'gatecontrol/contacts/#') throw Object.assign(new Error('no'), { code: 'denied' });
        const s = { topic, fn, on: true }; subs.push(s); return { unsubscribe: async () => { s.on = false; } };
      },
      publish: async (topic, payload) => { published.push([topic, String(payload)]); },
    }),
  });
  return {
    part, gc, published, subs, emitted,
    configure(data) { state.config = data; for (const fn of listeners) fn(data, gc); },
    deliver(topic, payload) { for (const s of subs) if (s.on && topic.startsWith(s.topic.replace(/#$/, '').replace(/\/$/, ''))) s.fn(topic, Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)), { retain: true, qos: 0 }); },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('the edge part: gatecontrol/contacts/# and the calibration report', () => {
  it('subscribes only while a room lists contacts; `contacts` none → ok once the gateway feed is there; a contact makes the room look', async () => {
    const e = loadPart();
    e.part.start(e.gc);
    try {
      await settle();
      e.configure({ devices: [], rules: [], tz: TZ, z2m: [], heat: { v: 1, tz: TZ, plans: ECO, rooms: [ROOM()] } });
      await settle();
      assert.ok(!e.subs.some((s) => s.topic === 'gatecontrol/contacts/#'), 'no contacts: no subscription');
      e.configure({ devices: [], rules: [], tz: TZ, z2m: [], heat: { v: 1, tz: TZ, plans: ECO, rooms: [ROOM({ ct: ['ble-a4c138001122'], wm: 1 })] } });
      await settle();
      assert.ok(e.subs.some((s) => s.on && s.topic === 'gatecontrol/contacts/#'));
      assert.deepEqual(e.emitted.filter(([n]) => n === 'contacts').pop(), ['contacts', { state: 'none' }], 'subscribed, no feed yet (an older gateway)');
      e.deliver('gatecontrol/contacts', { v: 1, feature: 'radio-contacts', sources: ['ble', 'z2m'] });
      assert.deepEqual(e.emitted.filter(([n]) => n === 'contacts').pop(), ['contacts', { state: 'ok' }]);
      const now = Date.now();
      e.deliver('gatecontrol/contacts/ble-a4c138001122', { open: true, since: now - 5 * 60000, seen: now });
      e.deliver('gatecontrol/contacts/ble-a4c138001122/x', { open: true, since: 1, seen: 1 });
      e.deliver('gatecontrol/contacts/ble-zz', 'kaputt');
      assert.deepEqual(e.part._test.st.contacts.get('ble-a4c138001122'), { open: true, since: now - 5 * 60000, seen: now });
      assert.equal(e.part._test.st.contacts.size, 1);
      e.deliver('gatecontrol/contacts/ble-a4c138001122', '');
      assert.equal(e.part._test.st.contacts.size, 0, 'an empty retained message clears it');
      // the server part takes the contacts away: let go
      e.configure({ devices: [], rules: [], tz: TZ, z2m: [], heat: { v: 1, tz: TZ, plans: ECO, rooms: [ROOM()] } });
      await settle();
      assert.ok(!e.subs.some((s) => s.on && s.topic === 'gatecontrol/contacts/#'));
    } finally { e.part.stop(e.gc); }
  });

  it('not granted (optional capability not confirmed): `denied`, the rest goes on', async () => {
    const e = loadPart({ deny: true });
    e.part.start(e.gc);
    try {
      await settle();
      e.configure({ devices: [], rules: [], tz: TZ, z2m: [], heat: { v: 1, tz: TZ, plans: ECO, rooms: [ROOM({ ct: ['ble-a4c138001122'] })] } });
      await settle();
      assert.deepEqual(e.emitted.filter(([n]) => n === 'contacts').pop(), ['contacts', { state: 'denied' }]);
      assert.ok(e.subs.some((s) => s.on && s.topic === 'shellies/#'));
    } finally { e.part.stop(e.gc); }
  });

  it('a calibrated zigbee2mqtt thermostat: its calibration from bridge/devices and its report → event `cal`', async () => {
    const e = loadPart();
    e.part.start(e.gc);
    try {
      await settle();
      e.configure({ devices: [], rules: [], tz: TZ, z2m: [], heat: { v: 1, tz: TZ, plans: ECO, rooms: [ROOM({ th: [{ ...ZTH, off: -1, cal: true }] })] } });
      await settle();
      e.deliver('zigbee2mqtt/bridge/devices', [{ ieee_address: '0x00158d0001010101', friendly_name: 'Kinderzimmer TRV', definition: { exposes: [{ type: 'climate', features: [{ property: 'current_heating_setpoint' }] },
        { type: 'numeric', property: 'local_temperature_calibration', access: 7, value_min: -12.8, value_max: 12.7, value_step: 0.1 }] } }]);
      assert.deepEqual(e.part._test.st.z2mCal.get('0x00158d0001010101'), { min: -10, max: 10, step: 0.1 });
      e.deliver('zigbee2mqtt/Kinderzimmer TRV', { local_temperature: 20, current_heating_setpoint: 18, local_temperature_calibration: -1 });
      e.part._test.flush();
      assert.deepEqual(e.emitted.filter(([n]) => n === 'cal').pop(), ['cal', { list: [{ base: ZTH.base, v: -1 }] }]);
      const n = e.emitted.length;
      e.part._test.flush();
      assert.equal(e.emitted.filter(([x]) => x === 'cal').length, e.emitted.slice(0, n).filter(([x]) => x === 'cal').length, 'only when it changes');
    } finally { e.part.stop(e.gc); }
  });
});

// ─── the server part ────────────────────────────

let now = T(0, 7, 0);
beforeEach(() => { now = T(0, 7, 0); heating._setClock(() => now); });
after(() => heating._setClock(null));

const admin = (host, method, p, body) => {
  const [pathOnly, qs] = String(p).split('?');
  return host.request({ method, path: pathOnly, query: Object.fromEntries(new URLSearchParams(qs || '')), body: body === undefined ? null : body, user: ADMIN });
};
const GWS = [{ id: 7, name: 'Pi Keller', state: 'running', version: '1.48.0' }, { id: 8, name: 'Pi Dach', state: 'running', version: '1.48.0' }];
const CONTACT = { gatewayId: 7, gateway: 'Pi Keller', online: true, id: 'z2m:00158d0007070707', ieee: '00:15:8d:00:07:07:07:07', name: 'Fenster Bad', model: 'MCCGQ11LM', vendor: 'Aqara',
  kind: 'sensor', caps: {}, values: { opening: false, battery: 90 }, seenAt: new Date().toISOString() };
const PLAN = [WD, WD, WD, WD, WD, WD, WD];

async function withHouse(fn, { settings = {}, optional = {} } = {}) {
  const calls = [];
  const z = { devices: [{ ...CONTACT, values: { ...CONTACT.values } }] };
  zigbee._mem.at = 0;
  radio._mem.at = 0;
  const call = async (gatewayId, method, params) => {
    calls.push({ gatewayId, method, params });
    if (method === 'info') return { version: '1.20.0', mqtt: 'ok', lan: ['192.168.1.23'], devices: 1, found: 0, heat: 1 };
    if (method === 'command') return { sent: 1 };
    if (method === 'runs') return { epoch: 'e1', runs: [], more: false };
    throw hostError('edge_error', `unknown_method: ${method}`);
  };
  const host = await createHost(DIR, { users: USERS, gatecontrol: '1.317.1', settings, edge: { gateways: GWS, call, optional },
    radio: { sensors: () => [], zigbee: () => ({ gateways: [{ id: 7, name: 'Pi Keller' }], devices: z.devices }), command: async () => ({ accepted: true }) } });
  try {
    await host.start();
    await zigbee.sync(host.gc, { force: true });
    const add = async (gw, name, area) => {
      const r = await admin(host, 'POST', '/edge/devices', { gateway_id: gw, family: 'shelly1', name, area });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const base = (await host.gc.db.get('SELECT base FROM edge_devices WHERE id = ?', [r.json.device.id])).row.base;
      return { id: r.json.device.id, base };
    };
    const report = (gw, base, o = {}) => host.edgeEvent(gw, 'states', { devices: [{ base, family: 'shelly1', online: true, seenAt: new Date().toISOString(),
      ch: { 'thermostat:0': { kind: 'gen1', temp: 20.2, target: 20, valve: 30, schedule: false, boost: 0, ...o } }, sensor: { battery: 80 }, info: {}, drop: [] }] });
    const rooms = async () => (await admin(host, 'GET', '/heating')).json;
    const roomOf = async (name) => (await rooms()).rooms.find((r) => r.name === name);
    const commands = () => calls.splice(0).filter((c) => c.method === 'command').map((c) => [c.gatewayId, c.params.base, c.params.op, c.params.value]);
    await fn(host, { calls, z, add, report, rooms, roomOf, commands, heat: (gw) => (host.edgeConfigs.get(gw) || {}).heat });
  } finally {
    await host.stop();
    await host.close();
  }
}

describe('the server part: rename, Versatz, boost, holidays, contacts', () => {
  it('renaming the area keeps the room: plan, Betrieb, id — also when its thermostats move one by one', () => withHouse(async (host, { add, report, roomOf }) => {
    const a = await add(7, 'Heizung Bad 1', 'Bad');
    const b = await add(8, 'Heizung Bad 2', 'Bad');
    await report(7, a.base);
    await report(8, b.base);
    await heating.tick(host.gc);
    const bad = await roomOf('Bad');
    const p = await admin(host, 'POST', '/heating/plans', { name: 'Bad', week: PLAN, rooms: [bad.id] });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    // one after the other: the first thermostat goes to „Badezimmer“, a new room appears there meanwhile
    assert.equal((await admin(host, 'PUT', `/edge/devices/${a.id}`, { area: 'Badezimmer' })).status, 200);
    await heating.tick(host.gc);
    assert.equal((await roomOf('Badezimmer')).plan, null, 'meanwhile a room of its own');
    assert.equal((await roomOf('Bad')).plan.id, p.json.plan.id);
    assert.equal((await admin(host, 'PUT', `/edge/devices/${b.id}`, { area: 'Badezimmer' })).status, 200);
    await heating.tick(host.gc);
    const moved = await roomOf('Badezimmer');
    assert.equal(moved.id, bad.id, 'the same room');
    assert.equal(moved.plan.id, p.json.plan.id, 'with its plan');
    assert.equal(moved.thermostats.length, 2);
    assert.equal(await roomOf('Bad'), undefined);
    // both at once
    assert.equal((await admin(host, 'PUT', `/edge/devices/${a.id}`, { area: 'Wohnbereich' })).status, 200);
    assert.equal((await admin(host, 'PUT', `/edge/devices/${b.id}`, { area: 'Wohnbereich' })).status, 200);
    await heating.tick(host.gc);
    assert.equal((await roomOf('Wohnbereich')).plan.id, p.json.plan.id, 'renamed at once: the room follows');
    assert.equal((await roomOf('Wohnbereich')).id, bad.id);
  }));

  it('a thermostat without an area (a room of its own) that gets one keeps its plan', () => withHouse(async (host, { add, report, roomOf }) => {
    const a = await add(7, 'Heizung Kind', null);
    await report(7, a.base);
    await heating.tick(host.gc);
    const own = await roomOf('Heizung Kind');
    const p = await admin(host, 'POST', '/heating/plans', { name: 'Kind', week: PLAN, rooms: [own.id] });
    await admin(host, 'PUT', `/edge/devices/${a.id}`, { area: 'Kinderzimmer' });
    await heating.tick(host.gc);
    const room = await roomOf('Kinderzimmer');
    assert.deepEqual([room.id, room.plan.id], [own.id, p.json.plan.id]);
  }));

  it('a room set up meanwhile is kept (the newer choice wins)', () => withHouse(async (host, { add, report, roomOf }) => {
    const a = await add(7, 'Heizung Flur 1', 'Flur');
    const b = await add(8, 'Heizung Flur 2', 'Flur');
    await report(7, a.base);
    await report(8, b.base);
    await heating.tick(host.gc);
    const p1 = await admin(host, 'POST', '/heating/plans', { name: 'Flur', week: PLAN, rooms: [(await roomOf('Flur')).id] });
    await admin(host, 'PUT', `/edge/devices/${a.id}`, { area: 'Diele' });
    await heating.tick(host.gc);
    const p2 = await admin(host, 'POST', '/heating/plans', { name: 'Diele', week: PLAN, rooms: [(await roomOf('Diele')).id] });
    await admin(host, 'PUT', `/edge/devices/${b.id}`, { area: 'Diele' });
    await heating.tick(host.gc);
    assert.equal((await roomOf('Diele')).plan.id, p2.json.plan.id);
    assert.notEqual(p1.json.plan.id, p2.json.plan.id);
  }));

  it('Versatz per thermostat: shown with it, the server sends target − offset; checked', () => withHouse(async (host, { add, report, roomOf, commands }) => {
    const a = await add(7, 'Heizung Gast 1', 'Gast');
    const b = await add(8, 'Heizung Gast 2', 'Gast'); // two gateways: the room runs on the server
    await report(7, a.base, { temp: 22 });
    await report(8, b.base);
    await heating.tick(host.gc);
    const room = await roomOf('Gast');
    assert.deepEqual(room.runs_at, { kind: 'server' });
    const th = room.thermostats.find((x) => x.name === 'Heizung Gast 1');
    assert.equal((await admin(host, 'PUT', `/heating/rooms/${room.id}`, { offsets: { [th.id]: 7 } })).status, 400);
    assert.equal((await admin(host, 'PUT', `/heating/rooms/${room.id}`, { offsets: { [th.id]: 0.3 } })).status, 400);
    assert.equal((await admin(host, 'PUT', `/heating/rooms/${room.id}`, { offsets: { 999: 1 } })).status, 400);
    commands();
    const r = await admin(host, 'PUT', `/heating/rooms/${room.id}`, { offsets: { [th.id]: -1.5 } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await admin(host, 'POST', `/heating/rooms/${room.id}`, { action: 'setpoint', setpoint: 21 });
    const sent = commands().filter((c) => c[2] === 'setpoint');
    assert.deepEqual(sent.find((c) => c[1] === a.base), [7, a.base, 'setpoint', 22.5], 'measures 1.5 °C too much → 22.5');
    assert.deepEqual(sent.find((c) => c[1] === b.base), [8, b.base, 'setpoint', 21]);
    const after = (await roomOf('Gast')).thermostats.find((x) => x.id === th.id);
    assert.equal(after.offset, -1.5);
    assert.equal(after.value, 20.5, 'shown corrected');
    // null removes it
    assert.equal((await admin(host, 'PUT', `/heating/rooms/${room.id}`, { offsets: { [th.id]: null } })).status, 200);
    assert.equal((await roomOf('Gast')).thermostats.find((x) => x.id === th.id).offset, 0);
  }));

  it('the boost target of the setting; holidays and the Versatz go to the gateway', () => withHouse(async (host, { add, report, roomOf, heat }) => {
    const a = await add(7, 'Heizung Bad', 'Bad');
    await report(7, a.base);
    await heating.tick(host.gc);
    const room = await roomOf('Bad');
    const p = await admin(host, 'POST', '/heating/plans', { name: 'Bad', week: PLAN, rooms: [room.id], holidays: false });
    assert.equal(p.json.plan.holidays, false);
    await admin(host, 'PUT', `/heating/rooms/${room.id}`, { offsets: { [room.thermostats[0].id]: 1 } });
    await heating.tick(host.gc);
    const h = heat(7);
    assert.equal(h.bt, 24);
    assert.equal(h.rooms[0].th[0].off, 1);
    assert.equal(h.rooms[0].hol, undefined, 'the plan does without holidays');
    assert.equal(h.hol, undefined);
    await admin(host, 'PUT', `/heating/plans/${p.json.plan.id}`, { name: 'Bad', week: PLAN, rooms: [room.id] });
    await heating.tick(host.gc);
    assert.equal(heat(7).rooms[0].hol, true);
    assert.ok(heat(7).hol.includes('2026-12-25'));
    const all = await admin(host, 'GET', '/heating');
    assert.deepEqual(all.json.holidays, { region: 'DE', auto: true, today: false });
    assert.equal(all.json.boost_setpoint, 24);
    assert.equal((await roomOf('Bad')).boost_setpoint, 24);
  }, { settings: { heat_boost: 24 } }));

  it('window contacts the gateway hears: with the optional capability `ct` goes along; with its feed no `win` from the server', () => withHouse(async (host, { z, add, report, roomOf, heat }) => {
    const a = await add(7, 'Heizung Bad', 'Bad');
    await report(7, a.base);
    await zigbee.sync(host.gc, { force: true });
    const contact = (await host.gc.db.get("SELECT id FROM resources WHERE deconz_type = 'z2m'")).row;
    assert.equal((await admin(host, 'PUT', `/resources/${contact.id}`, { area: 'Bad' })).status, 200);
    await heating.tick(host.gc);
    const room = await roomOf('Bad');
    assert.equal(room.window.contacts.length, 1);
    assert.deepEqual(heat(7).rooms[0].ct, ['z2m-00158d0007070707']);
    assert.equal(heat(7).rooms[0].wm, 2);
    assert.equal(heating.contactIdOf({ deconz_type: 'ble', deconz_id: 'ble:a4c138001122', capabilities: { gateway_id: 7 } }, 7), 'ble-a4c138001122');
    assert.equal(heating.contactIdOf({ deconz_type: 'ble', deconz_id: 'ble:a4c138001122', capabilities: { gateway_id: 8 } }, 7), null, 'another gateway');
    // the window opens: the server lowers and tells the gateway (win) while the gateway's feed is not confirmed
    await host.edgeEvent(7, 'contacts', { state: 'none' });
    z.devices[0].values.opening = true;
    await zigbee.sync(host.gc, { force: true });
    await heating.tick(host.gc);
    now = T(0, 7, 3);
    await heating.tick(host.gc);
    assert.equal((await roomOf('Bad')).status.kind, 'window');
    assert.ok(heat(7).rooms[0].win, 'without the feed: as before');
    await host.edgeEvent(7, 'contacts', { state: 'ok' });
    await heating.tick(host.gc);
    assert.equal(heat(7).rooms[0].win, null, 'the gateway decides itself');
    assert.deepEqual(heat(7).rooms[0].ct, ['z2m-00158d0007070707']);
  }, { optional: { 7: ['mqtt.topic:gatecontrol/contacts/#'] } }));

  it('without the optional capability: no `ct`, the server asks for it once', () => withHouse(async (host, { add, report, heat }) => {
    const a = await add(7, 'Heizung Bad', 'Bad');
    await report(7, a.base);
    const contact = (await host.gc.db.get("SELECT id FROM resources WHERE deconz_type = 'z2m'")).row;
    await admin(host, 'PUT', `/resources/${contact.id}`, { area: 'Bad' });
    await heating.tick(host.gc);
    assert.equal(heat(7).rooms[0].ct, undefined);
    const c = await host.gc.edge.capabilities(7);
    assert.deepEqual(c.requested, ['mqtt.topic:gatecontrol/contacts/#']);
  }));
});
