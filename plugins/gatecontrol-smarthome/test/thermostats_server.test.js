'use strict';

// Thermostate Stufe 2 (1.17.0), the server side: a Shelly TRV / BLU TRV report becomes a thermostat of the heating; a
// room whose thermostats all hang on one gateway runs its plan THERE — the server part sends them no command, it hands
// the gateway the room (gc.edge.configure { heat }) whenever something changes (plan, by hand, boost, window with its
// ttl, holiday, away); a room with thermostats elsewhere too stays on the server, which reaches the TRV through its
// gateway. edge.capabilities unchanged. All rooms, names and values are made up.

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHost, hostError } = require('../../../tools/testing/mock-host');
const { DIR, ADMIN, USERS } = require('./helpers');
const heating = require('../server/heating');
const zigbee = require('../server/zigbee');
const radio = require('../server/radio');

const T = (d, h, m = 0) => new Date(2026, 10, 23 + d, h, m).getTime();
let now = T(0, 7, 0);
beforeEach(() => { now = T(0, 7, 0); heating._setClock(() => now); });
after(() => heating._setClock(null));

const WD = [[0, 'night'], [360, 'comfort'], [480, 'eco'], [960, 'comfort'], [1350, 'night']];
const WEEK = [WD, WD, WD, WD, WD, WD, WD];
const GWS = [{ id: 7, name: 'Pi Keller', state: 'running', version: '1.46.0' }, { id: 8, name: 'Pi Dach', state: 'running', version: '1.46.0' }];

const admin = (host, method, p, body) => {
  const [pathOnly, qs] = String(p).split('?');
  return host.request({ method, path: pathOnly, query: Object.fromEntries(new URLSearchParams(qs || '')), body: body === undefined ? null : body, user: ADMIN });
};

const CONTACT = { gatewayId: 7, gateway: 'Pi Keller', online: true, id: 'z2m:00158d0007070707', ieee: '00:15:8d:00:07:07:07:07', name: 'Fenster Bad', model: 'MCCGQ11LM', vendor: 'Aqara',
  kind: 'sensor', caps: {}, values: { window: false, battery: 90 }, seenAt: new Date().toISOString() };

async function withTrvs(fn) {
  const calls = [];
  const z = { devices: [{ ...CONTACT, values: { ...CONTACT.values } }] };
  zigbee._mem.at = 0;
  radio._mem.at = 0;
  const call = async (gatewayId, method, params) => {
    calls.push({ gatewayId, method, params });
    if (method === 'info') return { version: '1.17.0', mqtt: 'ok', lan: ['192.168.1.23'], devices: 1, found: 0, heat: 1 };
    if (method === 'command') return { sent: 1 };
    if (method === 'runs') return { epoch: 'e1', runs: [], more: false };
    throw hostError('edge_error', `unknown_method: ${method}`);
  };
  const host = await createHost(DIR, { users: USERS, gatecontrol: '1.317.1', edge: { gateways: GWS, call },
    radio: { sensors: () => [], zigbee: () => ({ gateways: [{ id: 7, name: 'Pi Keller' }], devices: z.devices }), command: async () => ({ accepted: true }) } });
  try {
    await host.start();
    await zigbee.sync(host.gc, { force: true });
    const add = async (gw, name, area, family = 'shelly1') => {
      const r = await admin(host, 'POST', '/edge/devices', { gateway_id: gw, family, name, area });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      return (await host.gc.db.get('SELECT base FROM edge_devices WHERE id = ?', [r.json.device.id])).row.base;
    };
    const report = (gw, base, ch, o = {}) => host.edgeEvent(gw, 'states', { devices: [{ base, family: base.includes('blu') ? 'shelly2' : 'shelly1', online: true, seenAt: new Date().toISOString(),
      ch: { [ch]: { kind: base.includes('blu') ? 'blu' : 'gen1', temp: 20.2, target: 20, valve: 30, ...(base.includes('blu') ? { paired: true, rid: 200 } : { schedule: false, boost: 0 }), ...o } }, sensor: { battery: 80 }, info: {}, drop: [] }] });
    const rooms = async () => (await admin(host, 'GET', '/heating')).json.rooms;
    const roomOf = async (name) => (await rooms()).find((r) => r.name === name);
    const commands = () => calls.splice(0).filter((c) => c.method === 'command').map((c) => [c.gatewayId, c.params.base, c.params.op, c.params.value]);
    await fn(host, { calls, z, add, report, rooms, roomOf, commands, heat: (gw) => (host.edgeConfigs.get(gw) || {}).heat });
  } finally {
    await host.stop();
    await host.close();
  }
}

describe('Thermostate Stufe 2: Shelly TRV and BLU TRV, the plan on the gateway', () => {
  it('a Shelly TRV becomes a thermostat; its room runs on its gateway — the server sends it nothing, the gateway gets the room', () => withTrvs(async (host, { add, report, roomOf, commands, heat }) => {
    const base = await add(7, 'Heizung Bad', 'Bad');
    await report(7, base, 'thermostat:0', { schedule: true });
    const res = (await admin(host, 'GET', '/edge/devices?gateway_id=7')).json.devices[0].resources;
    assert.deepEqual(res.map((r) => [r.kind, r.name, r.area, r.capabilities.trv, r.capabilities.boost, r.capabilities.setpoint]), [['thermostat', 'Heizung Bad', 'Bad', 'gen1', true, { min: 5, max: 30, step: 0.5 }]]);
    assert.deepEqual([res[0].state.value, res[0].state.setpoint, res[0].state.valve, res[0].state.heating, res[0].state.battery, res[0].state.schedule_on], [20.2, 20, 30, true, 80, true]);
    let bad = await roomOf('Bad');
    assert.deepEqual(bad.runs_at, { kind: 'gateway', gateway_id: 7, name: 'Pi Keller' });
    assert.deepEqual(bad.thermostats.map((x) => [x.source, x.gateway, x.own_schedule, x.device_boost]), [['shelly', 'Pi Keller', true, true]]);
    const p = await admin(host, 'POST', '/heating/plans', { name: 'Bad', week: WEEK, rooms: [bad.id], presets: { comfort: 23 } });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.deepEqual(commands(), [], 'no command from the server');
    const h = heat(7);
    assert.equal(h.v, 1);
    assert.equal(typeof h.tz, 'string');
    assert.deepEqual(h.plans, { [p.json.plan.id]: WEEK });
    assert.deepEqual(h.rooms, [{ id: bad.id, th: [{ base, ch: 'thermostat:0', fam: 'shelly1', min: 5, max: 30, boost: true }], temps: { comfort: 23, eco: 18, night: 17, frost: 7 },
      plan: p.json.plan.id, away: false, mode: 'plan', manual: null, hold: null, vac: null, ov: null, boost: null, win: null }]);
    // the plan's background run: still nothing from the server
    await heating.tick(host.gc);
    now = T(0, 8);
    await heating.tick(host.gc);
    assert.deepEqual(commands(), []);
    bad = await roomOf('Bad');
    assert.deepEqual([bad.status.kind, bad.status.preset, bad.pending], ['plan', 'eco', 1], 'the TRV reports 20 °C, Eco is 18 °C: "wird übertragen" until it reports it');
    await report(7, base, 'thermostat:0', { target: 18 });
    assert.equal((await roomOf('Bad')).pending, 0);
    // by hand: to the gateway, until the next switching point
    const r = await admin(host, 'POST', `/heating/rooms/${bad.id}`, { action: 'setpoint', setpoint: 22 });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.room.status.kind, r.json.room.runs_at.kind], ['override', 'gateway']);
    assert.deepEqual(heat(7).rooms[0].ov, { at: T(0, 8), until: T(0, 16), setpoint: 22 });
    // boost (the TRV does it itself) and "Heizung abwesend", the holiday
    await admin(host, 'POST', `/heating/rooms/${bad.id}`, { action: 'boost', minutes: 30 });
    assert.deepEqual(heat(7).rooms[0].boost, { at: T(0, 8), until: T(0, 8, 30), minutes: 30 });
    await admin(host, 'PUT', '/heating/house', { away: true });
    assert.equal(heat(7).rooms[0].away, true);
    await admin(host, 'PUT', '/heating/vacation', { from: new Date(T(2, 0)).toISOString(), to: new Date(T(5, 18)).toISOString(), preheat_h: 4, rooms: { [bad.id]: 'frost' } });
    assert.deepEqual(heat(7).rooms[0].vac, { from: T(2, 0), end: T(5, 14), preset: 'frost' });
    assert.deepEqual(commands(), [], 'still nothing from the server');
    // the gateway comes back ($online): the same configuration again, the server sends nothing itself
    const before = JSON.stringify(heat(7));
    await host.edgeEvent(7, '$online', {});
    assert.equal(JSON.stringify(heat(7)), before);
    assert.deepEqual(commands(), []);
  }));

  it('window open: Frostschutz on the gateway with a ttl, renewed while it stays open; closed → gone', () => withTrvs(async (host, { add, report, roomOf, z, heat }) => {
    const base = await add(7, 'Heizung Bad', 'Bad');
    await report(7, base, 'thermostat:0');
    const contact = (await host.gc.db.get("SELECT id FROM resources WHERE deconz_type = 'z2m' AND name = 'Fenster Bad'")).row.id;
    await admin(host, 'PUT', `/resources/${contact}`, { area: 'Bad' });
    const bad = await roomOf('Bad');
    await admin(host, 'POST', '/heating/plans', { name: 'Bad', week: WEEK, rooms: [bad.id] });
    z.devices[0].values = { window: true, battery: 90 };
    await zigbee.sync(host.gc, { force: true });
    await heating.tick(host.gc);
    assert.equal(heat(7).rooms[0].win, null, 'not before 2 minutes');
    now = T(0, 7, 2);
    await heating.tick(host.gc);
    assert.deepEqual(heat(7).rooms[0].win, { since: T(0, 7), ttl: T(0, 9, 2) });
    now = T(0, 8, 1);
    await heating.tick(host.gc);
    assert.deepEqual(heat(7).rooms[0].win, { since: T(0, 7), ttl: T(0, 9, 2) }, 'more than an hour left');
    now = T(0, 8, 3);
    await heating.tick(host.gc);
    assert.deepEqual(heat(7).rooms[0].win, { since: T(0, 7), ttl: T(0, 10, 3) }, 'less than an hour left: renewed');
    assert.equal((await roomOf('Bad')).status.kind, 'window');
    z.devices[0].values = { window: false, battery: 90 };
    await zigbee.sync(host.gc, { force: true });
    now = T(0, 8, 2);
    await heating.tick(host.gc);
    assert.equal(heat(7).rooms[0].win, null);
  }));

  it('a room with thermostats on two gateways stays on the server — the TRVs get their commands through their gateways; a BLU TRV too', () => withTrvs(async (host, { add, report, roomOf, commands, heat }) => {
    const a = await add(7, 'Heizung Flur', 'Flur');
    const b = await add(8, 'BLU Gateway Flur', 'Flur', 'shelly2');
    await report(7, a, 'thermostat:0');
    await report(8, b, 'thermostat:0');
    const flur = await roomOf('Flur');
    assert.deepEqual(flur.runs_at, { kind: 'server' });
    assert.deepEqual(flur.thermostats.map((x) => [x.source, x.device_boost]).sort(), [['shelly', false], ['shelly', true]]);
    commands();
    await admin(host, 'POST', '/heating/plans', { name: 'Flur', week: WEEK, rooms: [flur.id] });
    assert.deepEqual(commands().sort(), [[7, a, 'setpoint', 21], [8, b, 'setpoint', 21]]);
    assert.equal((heat(7) || { rooms: [] }).rooms.length, 0);
    // boost: the Shelly TRV itself (its minutes), the BLU TRV 30 °C
    await admin(host, 'POST', `/heating/rooms/${flur.id}`, { action: 'boost', minutes: 15 });
    assert.deepEqual(commands().sort(), [[7, a, 'boost', 15], [8, b, 'setpoint', 30]]);
  }));

  it('a gateway whose last room left it gets an empty list', () => withTrvs(async (host, { add, report, roomOf, heat }) => {
    const a = await add(7, 'Heizung Gast', 'Gast');
    await report(7, a, 'thermostat:0');
    await heating.tick(host.gc); // a new room of the gateway: with the next run
    assert.deepEqual([heat(7).rooms.length, heat(7).rooms[0].plan, heat(7).rooms[0].hold], [1, null, null], 'no plan yet: nothing to run there');
    const gast = await roomOf('Gast');
    await admin(host, 'POST', `/heating/rooms/${gast.id}`, { action: 'setpoint', setpoint: 19 });
    assert.deepEqual([heat(7).rooms.length, heat(7).rooms[0].hold], [1, 19]);
    // a TRV of another gateway joins the room: it runs on the server now, the gateway gets an empty list
    const b = await add(8, 'Heizung Gast 2', 'Gast');
    await report(8, b, 'thermostat:0');
    await heating.tick(host.gc);
    assert.deepEqual(heat(7).rooms, []);
    assert.deepEqual((await roomOf('Gast')).runs_at, { kind: 'server' });
  }));

  it('the manifest: version 1.19.0, edge.capabilities unchanged (no update_pending), zigbee2mqtt/# still optional only', () => {
    const manifest = require('../plugin.json');
    assert.equal(manifest.version, '1.19.0');
    assert.deepEqual(manifest.edge.capabilities, { mdns: { services: ['_shelly._tcp', '_http._tcp'] }, http: { lan: true }, mqtt: { topics: ['shellies/#', 'tasmota/#'] } });
    assert.deepEqual(manifest.edge.optionalCapabilities, { mqtt: { topics: ['zigbee2mqtt/#'] } });
  });
});
