'use strict';

// Thermostate Stufe 2 (1.17.0), the gateway side: Shelly TRV (Gen1, shellies/<id>/info) and Shelly BLU TRV through a BLU
// Gateway Gen3 (component blutrv:200…) normalised; their commands; the heating plan on the gateway (edge/heat.js) — it
// switches by itself at the switching points, without the server, respects boost, window, by hand, holiday, away,
// sends nothing twice (also after a restart) and gives up after three unconfirmed tries. All rooms and names are made up.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const normalize = require('../edge/normalize');
const commands = require('../edge/commands');
const heat = require('../edge/heat');
const heating = require('../server/heating');

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
// Monday 23 November 2026 (local time, as the plan) + d days, h:m
const T = (d, h, m = 0) => new Date(2026, 10, 23 + d, h, m).getTime();
const WD = [[0, 'night'], [360, 'comfort'], [480, 'eco'], [960, 'comfort'], [1350, 'night']];
const WE = [[0, 'night'], [450, 'comfort'], [1380, 'night']];
const WEEK = [WD, WD, WD, WD, WD, WE, WE];
const TEMPS = { comfort: 21, eco: 18, night: 17, frost: 7 };

const TRV_INFO = (o = {}) => ({
  wifi_sta: { connected: true, ssid: 'Heimnetz', ip: '192.168.1.71', rssi: -60 }, mqtt: { connected: true }, mac: '60A423B1C2D3',
  thermostats: [{ pos: 35.4, target_t: { enabled: true, value: 21, value_op: 8, units: 'C' }, tmp: { value: 20.4, units: 'C', is_valid: true }, schedule: true, schedule_profile: 1, boost_minutes: 0, window_open: false, ...o }],
  calibrated: true, bat: { value: 87, voltage: 3.95 }, charger: false, fw_info: { device: 'shellytrv-60A423B1C2D3', fw: '20230803-114553/v2.2.1@5d4d42ab' },
});

describe('Shelly TRV and BLU TRV: what the gateway reads and sends', () => {
  it('Shelly TRV (Gen1): shellies/<id>/info → thermostat:0 with target, valve, own plan, boost, window, battery; other info is none of ours', () => {
    const r = normalize.parse('shellies/heizung-bad/info', JSON.stringify(TRV_INFO()));
    assert.deepEqual(r, { base: 'shellies/heizung-bad', family: 'shelly1', patch: {
      ch: { 'thermostat:0': { kind: 'gen1', temp: 20.4, target: 21, valve: 35, schedule: true, boost: 0, window: false, bat: 87 } },
      sensor: { battery: 87 }, info: { firmware: '20230803-114553/v2.2.1@5d4d42ab' } } });
    const invalid = normalize.parse('shellies/heizung-bad/info', JSON.stringify(TRV_INFO({ tmp: { value: 0, is_valid: false } })));
    assert.equal('temp' in invalid.patch.ch['thermostat:0'], false, 'no measured value while the device says it is invalid');
    assert.equal(normalize.parse('shellies/licht-flur/info', JSON.stringify({ relays: [{ ison: true }], mac: 'x' })), null, 'a Shelly 1 reports no thermostats there');
    assert.equal(normalize.parse('shellies/heizung-bad/info', 'kaputt'), null);
    const dev = normalize.newDevice('shellies/heizung-bad', 'shelly1');
    normalize.apply(dev, r.patch);
    normalize.apply(dev, normalize.parse('shellies/heizung-bad/info', JSON.stringify(TRV_INFO({ target_t: { value: 18 }, pos: 0 }))).patch);
    assert.deepEqual([dev.ch['thermostat:0'].target, dev.ch['thermostat:0'].valve], [18, 0]);
  });

  it('BLU TRV through a BLU Gateway Gen3: status/blutrv:200 and NotifyStatus → thermostat:<id − 200>', () => {
    const a = normalize.parse('shellies/blu-gateway/status/blutrv:200', JSON.stringify({ id: 200, target_C: 20.5, current_C: 19.8, pos: 40, rssi: -70, battery: 95, paired: true, rpc: true }));
    assert.deepEqual(a, { base: 'shellies/blu-gateway', family: 'shelly2', patch: { ch: { 'thermostat:0': { kind: 'blu', rid: 200, temp: 19.8, target: 20.5, valve: 40, bat: 95, paired: true } } } });
    const b = normalize.parse('shellies/blu-gateway/events/rpc', JSON.stringify({ src: 'shellyblugwg3-a1b2c3', method: 'NotifyStatus', params: { ts: 1, 'blutrv:201': { id: 201, current_C: 21.2 } } }));
    assert.deepEqual(b.patch.ch, { 'thermostat:1': { kind: 'blu', rid: 201, temp: 21.2 } });
    assert.equal(normalize.parse('shellies/blu-gateway/status/blutrv:20', JSON.stringify({ id: 20 })), null, 'only the component ids 200…');
  });

  it('commands: Gen1 target_t / boost_minutes / schedule, BLU TRV.SetTarget through BluTrv.Call; nothing else', () => {
    const g1 = { base: 'shellies/heizung-bad', family: 'shelly1', ch: 'thermostat:0' };
    assert.deepEqual(commands.messages({ ...g1, op: 'setpoint', value: 21.3 }), [{ topic: 'shellies/heizung-bad/thermostat/0/command/target_t', payload: '21.5' }]);
    assert.deepEqual(commands.messages({ ...g1, op: 'boost', value: 30 }), [{ topic: 'shellies/heizung-bad/thermostat/0/command/boost_minutes', payload: '30' }]);
    assert.deepEqual(commands.messages({ ...g1, op: 'boost', value: 0 }), [{ topic: 'shellies/heizung-bad/thermostat/0/command/boost_minutes', payload: '0' }]);
    assert.deepEqual(commands.messages({ ...g1, op: 'schedule_off' }), [{ topic: 'shellies/heizung-bad/thermostat/0/command/schedule', payload: '0' }]);
    const [m] = commands.messages({ base: 'shellies/blu-gateway', family: 'shelly2', ch: 'thermostat:1', op: 'setpoint', value: 19 });
    assert.equal(m.topic, 'shellies/blu-gateway/rpc');
    const j = JSON.parse(m.payload);
    assert.deepEqual([j.method, j.params, j.src], ['BluTrv.Call', { id: 201, method: 'TRV.SetTarget', params: { id: 0, target_C: 19 } }, 'shellies/blu-gateway/gc']);
    for (const bad of [{ ...g1, op: 'setpoint', value: 3 }, { ...g1, op: 'setpoint', value: 32 }, { ...g1, op: 'boost', value: 500 }, { ...g1, op: 'on' },
      { base: 'shellies/blu-gateway', family: 'shelly2', ch: 'thermostat:0', op: 'boost', value: 30 }, { base: 'tasmota/x', family: 'tasmota', ch: 'thermostat:0', op: 'setpoint', value: 20 }]) {
      assert.throws(() => commands.messages(bad), (e) => e.code === 'bad_command', JSON.stringify(bad));
    }
  });
});

// ─── the plan on the gateway (edge/heat.js) ─────

const TH1 = { base: 'shellies/heizung-bad', ch: 'thermostat:0', fam: 'shelly1', min: 5, max: 30, boost: true };
const BLU = { base: 'shellies/blu-gateway', ch: 'thermostat:0', fam: 'shelly2', min: 5, max: 30, boost: false };
const PLANS = { 1: WEEK, 2: Array.from({ length: 7 }, () => [[0, 'eco']]) };
const ROOM = (o = {}) => ({ id: 3, th: [TH1], temps: TEMPS, plan: 1, away: false, mode: 'plan', manual: null, hold: null, vac: null, ov: null, boost: null, win: null, ...o });

/** An engine with devices that take what they are sent (unless `deaf`), a fake clock and the store. */
function rig(rooms, o = {}) {
  const w = { now: o.now || T(0, 7), devices: new Map(), sent: [], saved: [], deaf: new Set(), silent: new Set(), fail: false };
  const report = (base, ch, c) => {
    const d = w.devices.get(base) || { base, online: true, seenAt: null, ch: {} };
    d.ch[ch] = { ...(d.ch[ch] || {}), ...c };
    d.seenAt = new Date(w.now).toISOString();
    w.devices.set(base, d);
  };
  w.report = report;
  report(TH1.base, TH1.ch, { kind: 'gen1', target: 20, temp: 20, schedule: false });
  report(BLU.base, BLU.ch, { kind: 'blu', target: 20, temp: 20, paired: true });
  w.engine = heat.create({
    now: () => w.now,
    device: (base) => w.devices.get(base) || null,
    publish: async (list) => {
      if (w.fail) throw Object.assign(new Error('off'), { code: 'mqtt_off' });
      for (const m of list) {
        w.sent.push([m.topic.replace(/^shellies\//, ''), m.payload]);
        const t = /^(shellies\/[^/]+)\/thermostat\/(\d)\/command\/target_t$/.exec(m.topic);
        if (t && !w.deaf.has(t[1])) report(t[1], `thermostat:${t[2]}`, { target: Number(m.payload) });
        if (m.topic.endsWith('/rpc')) {
          const j = JSON.parse(m.payload);
          const base = m.topic.slice(0, -4);
          if (!w.deaf.has(base)) report(base, `thermostat:${j.params.id - 200}`, { target: j.params.params.target_C });
        }
      }
    },
    save: (list) => w.saved.push(JSON.parse(JSON.stringify(list))),
    log: { warn: () => {}, info: () => {} },
  });
  w.engine.set({ v: 1, tz: TZ, plans: PLANS, rooms });
  w.take = () => w.sent.splice(0);
  // the devices report now and then (a silent one does not)
  w.at = async (ms) => {
    w.now = ms;
    for (const d of w.devices.values()) if (!w.silent.has(d.base)) d.seenAt = new Date(ms).toISOString();
    await w.engine.tick();
    return w.take();
  };
  return w;
}

describe('Heizung on the gateway (edge/heat.js)', () => {
  it('the plan switches by itself at the switching points — once each, nothing again while the same section applies', async () => {
    const w = rig([ROOM()]);
    assert.deepEqual(await w.at(T(0, 7)), [['heizung-bad/thermostat/0/command/target_t', '21']], 'Komfort 06:00–08:00');
    assert.deepEqual(await w.at(T(0, 7, 30)), [], 'confirmed by the device: nothing again');
    assert.deepEqual(await w.at(T(0, 8)), [['heizung-bad/thermostat/0/command/target_t', '18']]);
    assert.deepEqual(await w.at(T(0, 12)), []);
    assert.deepEqual(await w.at(T(0, 16)), [['heizung-bad/thermostat/0/command/target_t', '21']]);
    assert.deepEqual(await w.at(T(0, 22, 30)), [['heizung-bad/thermostat/0/command/target_t', '17']]);
    assert.deepEqual(await w.at(T(0, 22, 31)), [], 'the TRV reported it: done');
    // a person turns the knob at night: no switching point at midnight (night goes on) — not fought
    w.report(TH1.base, TH1.ch, { target: 19 });
    assert.deepEqual(await w.at(T(1, 0, 5)), []);
    assert.deepEqual(await w.at(T(1, 5, 59)), []);
    assert.deepEqual(await w.at(T(1, 6)), [['heizung-bad/thermostat/0/command/target_t', '21']], 'the next switching point');
    // Saturday: the weekend sections
    assert.deepEqual(await w.at(T(5, 7)), [['heizung-bad/thermostat/0/command/target_t', '17']], 'Friday 22:30 night still applies Saturday 07:00 — sent once since the last switching point was missed');
    assert.deepEqual(await w.at(T(5, 7, 30)), [['heizung-bad/thermostat/0/command/target_t', '21']]);
  });

  it('decides like the server part (same inputs, same kind and target) over a week in steps of 15 minutes', () => {
    const plans = new Map([[1, { id: 1, week: heating.normalizeWeek(WEEK), presets: {}, window: { on: true, min: 2 }, away: true }]]);
    for (const away of [false, true]) {
      const ctx = { plans, house: { presets: {}, away, vacation: null }, rooms: [] };
      const room = { id: 3, plan_id: 1, mode: 'plan', presets: {}, override: null, boost: null, window: null };
      const r = heat.clean({ tz: TZ, plans: PLANS, rooms: [ROOM({ away })] }).rooms[0];
      let sigServer = null;
      let sigEdge = null;
      for (let at = T(0, 0); at < T(7, 0); at += 15 * 60000) {
        const s = heating.decide(room, ctx, at);
        const e = heat.decide(r, at, TZ);
        assert.deepEqual([e.kind, e.setpoint], [s.kind, s.setpoint], new Date(at).toString());
        // a new signature exactly where the server part has one (a real switching point)
        assert.equal(e.sig !== sigEdge, s.sig !== sigServer, `switching point at ${new Date(at).toString()}`);
        sigServer = s.sig;
        sigEdge = e.sig;
      }
    }
  });

  it('by hand until its end, boost (the TRV itself, a BLU TRV 30 °C), window with its ttl, Aus, Von Hand, holiday, away', async () => {
    const short = (list) => list.map(([t, p]) => (t === 'blu-gateway/rpc' ? ['blu', JSON.parse(p).params.params.target_C] : [t.replace('heizung-bad/thermostat/0/command/', ''), p]));
    const room = ROOM({ th: [TH1, BLU], ov: { at: T(0, 9), until: T(0, 16), setpoint: 22.5 } });
    const w = rig([room], { now: T(0, 9) });
    assert.deepEqual(short(await w.at(T(0, 9))), [['target_t', '22.5'], ['blu', 22.5]], 'by hand');
    assert.deepEqual(short(await w.at(T(0, 15, 59))), []);
    assert.deepEqual(short(await w.at(T(0, 16))), [['target_t', '21'], ['blu', 21]], 'its end: the plan');
    // boost: the Shelly TRV does it itself (its minutes), the BLU TRV gets 30 °C; afterwards the plan, the TRV's boost ended
    w.engine.set({ tz: TZ, plans: PLANS, rooms: [{ ...room, ov: null, boost: { at: T(0, 17), until: T(0, 17, 30), minutes: 30 } }] });
    assert.deepEqual(short(await w.at(T(0, 17))), [['boost_minutes', '30'], ['blu', 30]]);
    assert.deepEqual(short(await w.at(T(0, 17, 10))), []);
    assert.deepEqual(short(await w.at(T(0, 17, 30))), [['boost_minutes', '0'], ['target_t', '21'], ['blu', 21]]);
    // window open: Frostschutz while ttl lasts — no news from the server (ttl passed): back to the plan
    w.engine.set({ tz: TZ, plans: PLANS, rooms: [{ ...room, ov: null, win: { since: T(0, 18), ttl: T(0, 20) } }] });
    assert.deepEqual(short(await w.at(T(0, 18, 1))), [['target_t', '7'], ['blu', 7]]);
    assert.deepEqual(short(await w.at(T(0, 19, 59))), []);
    assert.deepEqual(short(await w.at(T(0, 20))), [['target_t', '21'], ['blu', 21]], 'the ttl ended: the plan again');
    // Aus → Frostschutz; Von Hand holds over switching points
    w.engine.set({ tz: TZ, plans: PLANS, rooms: [{ ...room, ov: null, mode: 'off' }] });
    assert.deepEqual(short(await w.at(T(0, 21))), [['target_t', '7'], ['blu', 7]]);
    w.engine.set({ tz: TZ, plans: PLANS, rooms: [{ ...room, ov: null, mode: 'manual', manual: 20 }] });
    assert.deepEqual(short(await w.at(T(0, 21, 1))), [['target_t', '20'], ['blu', 20]]);
    assert.deepEqual(short(await w.at(T(0, 22, 30))), [], 'no switching point while Von Hand');
    // holiday: its preset until the return minus the preheating, then the plan (ahead of Von Hand)
    w.engine.set({ tz: TZ, plans: PLANS, rooms: [{ ...room, ov: null, mode: 'manual', manual: 20, vac: { from: T(1, 0), end: T(3, 12), preset: 'frost' } }] });
    assert.deepEqual(short(await w.at(T(1, 0))), [['target_t', '7'], ['blu', 7]]);
    assert.deepEqual(short(await w.at(T(3, 12))), [['target_t', '20'], ['blu', 20]], 'back to Von Hand');
    // away: Komfort becomes Eco
    w.engine.set({ tz: TZ, plans: PLANS, rooms: [{ ...room, ov: null, away: true }] });
    assert.deepEqual(short(await w.at(T(3, 16, 5))), [['target_t', '18'], ['blu', 18]]);
  });

  it('a TRV with its own plan: switched off when the plan sends; an absent TRV gets it once it reports; three tries, then it is left alone', async () => {
    const w = rig([ROOM()], { now: T(0, 7) });
    w.report(TH1.base, TH1.ch, { schedule: true });
    assert.deepEqual(await w.at(T(0, 7)), [['heizung-bad/thermostat/0/command/schedule', '0'], ['heizung-bad/thermostat/0/command/target_t', '21']]);
    // away: offline (LWT) → nothing; back → at once
    w.devices.get(TH1.base).online = false;
    assert.deepEqual(await w.at(T(0, 8)), []);
    w.devices.get(TH1.base).online = true;
    w.report(TH1.base, TH1.ch, { schedule: false });
    assert.deepEqual(await w.at(T(0, 8, 1)), [['heizung-bad/thermostat/0/command/target_t', '18']]);
    // a TRV that does not confirm: 5 minutes apart, three times, then left alone
    w.deaf.add(TH1.base);
    assert.deepEqual(await w.at(T(0, 16)), [['heizung-bad/thermostat/0/command/target_t', '21']]);
    assert.deepEqual(await w.at(T(0, 16, 4)), []);
    assert.deepEqual(await w.at(T(0, 16, 5)), [['heizung-bad/thermostat/0/command/target_t', '21']]);
    assert.deepEqual(await w.at(T(0, 16, 10)), [['heizung-bad/thermostat/0/command/target_t', '21']]);
    assert.deepEqual(await w.at(T(0, 16, 15)), []);
    assert.deepEqual(await w.at(T(0, 20)), [], 'given up until the next switching point');
    // the broker away: tried again after 5 minutes, no try counted
    w.deaf.clear();
    w.fail = true;
    assert.deepEqual(await w.at(T(0, 22, 30)), []);
    w.fail = false;
    assert.deepEqual(await w.at(T(0, 22, 31)), [], 'not before 5 minutes');
    assert.deepEqual(await w.at(T(0, 22, 35)), [['heizung-bad/thermostat/0/command/target_t', '17']]);
    // silent for more than 2 hours: waits
    w.silent.add(TH1.base);
    assert.deepEqual(await w.at(T(1, 6)), []);
  });

  it('a restart: what was applied comes back — nothing is sent twice; the server back with the same configuration: nothing either', async () => {
    const w = rig([ROOM()], { now: T(0, 7) });
    assert.equal((await w.at(T(0, 7))).length, 1);
    await w.at(T(0, 7, 1));
    const saved = w.saved[w.saved.length - 1];
    assert.equal(saved.length, 1);
    assert.match(saved[0].sig, /^plan:\d{4}-\d{2}-\d{2}:360:comfort:21$/);
    // a new engine (the gateway restarted) with the stored configuration and what was applied
    const w2 = rig([ROOM()], { now: T(0, 7, 10) });
    w2.engine.restore(saved);
    w2.report(TH1.base, TH1.ch, { target: 19 }); // a person turned the knob meanwhile
    assert.deepEqual(await w2.at(T(0, 7, 10)), [], 'the same section: not sent again');
    w2.engine.set({ v: 1, tz: TZ, plans: PLANS, rooms: [ROOM()] }); // the server part is back: the same configuration
    assert.deepEqual(await w2.at(T(0, 7, 20)), []);
    assert.deepEqual(await w2.at(T(0, 8)), [['heizung-bad/thermostat/0/command/target_t', '18']]);
    // a room the server part takes away is forgotten; bad entries are left out
    w2.engine.set({ v: 1, tz: TZ, plans: PLANS, rooms: [{ id: 'x' }, ROOM({ id: 4, th: [{ ...TH1, base: 'evil/../x' }] })] });
    assert.equal(w2.engine.count(), 0);
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
  const store = new Map(stored ? [['heat', stored]] : []);
  const state = { config: null };
  const gc = Object.freeze({
    id: 'gatecontrol-smarthome', version: '1.17.0',
    handle: (m, fn) => handlers.set(m, fn), emit: () => {}, config: () => state.config, onConfig: (fn) => listeners.push(fn),
    log: Object.freeze({ info: () => {}, warn: () => {}, error: () => {} }),
    store: Object.freeze({ get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }, delete: async (k) => { store.delete(k); } }),
    lan: Object.freeze({ http: Object.freeze({ request: async () => { throw Object.assign(new Error('x'), { code: 'net_error' }); } }), mdns: Object.freeze({ browse: async () => ({ stop: async () => {} }) }) }),
    mqtt: Object.freeze({
      subscribe: async (topic, fn) => { const s = { topic, fn, on: true }; subs.push(s); return { unsubscribe: async () => { s.on = false; } }; },
      publish: async (topic, payload) => { published.push([topic, String(payload)]); },
    }),
  });
  return {
    part, gc, published, store,
    call: async (m, p) => JSON.parse(JSON.stringify(await handlers.get(m)(p === undefined ? null : p, gc))),
    configure(data) { state.config = data; for (const fn of listeners) fn(data, gc); },
    deliver(topic, payload) { for (const s of subs) if (s.on && topic.startsWith(s.topic.replace(/#$/, ''))) s.fn(topic, Buffer.from(JSON.stringify(payload)), { retain: false, qos: 0 }); },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('the edge part runs the heating', () => {
  it('from the configuration; kept in gc.store — after a restart without the server it goes on; a configuration without heat keeps it', async () => {
    const room = ROOM({ plan: 2, ov: null });
    const e = loadPart();
    e.part.start(e.gc);
    try {
      await settle();
      e.configure({ devices: [{ base: 'shellies/heizung-bad', family: 'shelly1' }], rules: [], tz: TZ, heat: { v: 1, tz: TZ, plans: PLANS, rooms: [room] } });
      e.deliver('shellies/heizung-bad/info', TRV_INFO());
      await new Promise((r) => setTimeout(r, 1100)); // a report of one of the rooms' thermostats: looked at at once
      assert.deepEqual(e.published.filter(([t]) => t.includes('/thermostat/')), [['shellies/heizung-bad/thermostat/0/command/schedule', '0'], ['shellies/heizung-bad/thermostat/0/command/target_t', '18']]);
      assert.equal((await e.call('info')).heat, 1);
      assert.deepEqual((await e.call('heat')).rooms, [{ id: 3, kind: 'plan', setpoint: 18, sent: false }]);
      e.deliver('shellies/heizung-bad/info', TRV_INFO({ target_t: { value: 18 }, schedule: false }));
      await e.part._test.heatTick();
      assert.deepEqual((await e.call('heat')).rooms, [{ id: 3, kind: 'plan', setpoint: 18, sent: true }]);
      // an older server part (no heat in its configuration): the rooms stay
      e.configure({ devices: [{ base: 'shellies/heizung-bad', family: 'shelly1' }], rules: [] });
      assert.equal((await e.call('info')).heat, 1);
      await settle();
      const kept = e.store.get('heat');
      assert.equal(kept.cfg.rooms.length, 1);
      assert.equal(kept.applied[0].done.length, 1);
    } finally { e.part.stop(e.gc); }
    // the gateway restarts, the server is away: the stored plan runs, nothing is sent twice
    const e2 = loadPart({ stored: e.store.get('heat') });
    e2.part.start(e2.gc);
    try {
      await settle();
      assert.equal((await e2.call('info')).heat, 1);
      e2.deliver('shellies/heizung-bad/info', TRV_INFO({ target_t: { value: 18 }, schedule: false }));
      await e2.part._test.heatTick();
      assert.deepEqual(e2.published.filter(([t]) => t.includes('/thermostat/')), [], 'applied before the restart');
      // the server part takes the room away (heat with no rooms)
      e2.configure({ devices: [], rules: [], heat: { v: 1, tz: TZ, rooms: [] } });
      assert.equal((await e2.call('info')).heat, 0);
    } finally { e2.part.stop(e2.gc); }
  });
});

