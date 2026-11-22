'use strict';

// Heizung (1.14.0, server/heating.js): weekly plans in the server part with a fake clock — switching points, missed
// ones caught up, the last target kept while commands fail, changes by hand until the next switching point, "Von
// Hand" / "Aus", "Heizung abwesend", holiday with preheating, boost (own and 30 °C), window open, deCONZ thermostats.
// All rooms, names and values are made up.

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asPortal, fakeDeconz, ADA } = require('./helpers');
const zigbee = require('../server/zigbee');
const radio = require('../server/radio');
const heating = require('../server/heating');

// Monday 23 November 2026 (local time of the server, as the plan) + d days, h:m
const T = (d, h, m = 0) => new Date(2026, 10, 23 + d, h, m).getTime();
let now = T(0, 7, 0);
beforeEach(() => { now = T(0, 7, 0); heating._setClock(() => now); });
after(() => heating._setClock(null));

const WD = [[0, 'night'], [360, 'comfort'], [480, 'eco'], [960, 'comfort'], [1350, 'night']];
const WE = [[0, 'night'], [450, 'comfort'], [1380, 'night']];
const WEEK = [WD, WD, WD, WD, WD, WE, WE];

const base = { gatewayId: 7, gateway: 'Pi Keller', online: true };
const TRV = (n, o = {}) => ({ ...base, id: `z2m:00158d00050505${String(n).padStart(2, '0')}`, ieee: `00:15:8d:00:05:05:05:${String(n).padStart(2, '0')}`, name: `Heizkörper ${n}`,
  model: 'SRTS-A01', vendor: 'Aqara', kind: 'climate', caps: { setpoint: { min: 5, max: 30, step: 0.5 }, modes: ['off', 'heat', 'auto'] },
  values: { temperature: 20.4, setpoint: 20, mode: 'heat', heating: false, valve: 30, battery: 80 }, seenAt: new Date().toISOString(), ...o });
const CONTACT = (o = {}) => ({ ...base, id: 'z2m:00158d0007070707', ieee: '00:15:8d:00:07:07:07:07', name: 'Fensterkontakt Terrasse', model: 'MCCGQ11LM', vendor: 'Aqara',
  kind: 'sensor', caps: {}, values: { window: false, battery: 90 }, seenAt: new Date().toISOString(), ...o });

/** A host with zigbee2mqtt devices (the list may change), commands recorded per device and taken over by the device. */
async function withTrvs(list, fn) {
  const sent = [];
  const st = { fail: null, devices: list };
  zigbee._mem.at = 0;
  radio._mem.at = 0;
  await withHost({ gateways: [], radio: {
    sensors: () => [],
    zigbee: () => ({ gateways: [{ id: 7, name: 'Pi Keller' }], devices: st.devices }),
    command: async (id, set) => {
      sent.push([id, set]);
      if (st.fail) throw Object.assign(new Error('x'), { code: st.fail });
      const d = st.devices.find((x) => x.id === id);
      if (d && 'setpoint' in set) d.values = { ...d.values, setpoint: set.setpoint };
      if (d && 'mode' in set) d.values = { ...d.values, mode: set.mode };
      return { accepted: true };
    },
  } }, async (host) => {
    await zigbee.sync(host.gc, { force: true });
    const res = (await host.gc.db.query("SELECT id, name FROM resources WHERE deconz_type = 'z2m' ORDER BY name")).rows;
    const by = (name) => res.find((r) => r.name === name).id;
    await fn(host, { sent, st, by, sync: () => zigbee.sync(host.gc, { force: true }), run: () => heating.tick(host.gc) });
  });
}

const area = (host, id, a) => asAdmin(host, 'PUT', `/resources/${id}`, { area: a });
const rooms = async (host) => (await asAdmin(host, 'GET', '/heating')).json.rooms;
const roomOf = async (host, name) => (await rooms(host)).find((r) => r.name === name);
const plan = (host, roomIds, extra = {}) => asAdmin(host, 'POST', '/heating/plans', { name: 'Familie Werktag', week: WEEK, rooms: roomIds, ...extra });
const sps = (sent) => sent.splice(0).map(([id, set]) => [id.slice(-2), set]);

describe('Heizung: the plan in the server part', () => {
  it('weeks: 15-minute grid, first section at 0, equal neighbours merged; switching points over midnight only on a change', () => {
    assert.deepEqual(heating.normalizeWeek(Array(7).fill([[0, 'eco'], ['06:00', 'comfort'], [480, 'comfort'], [600, 'night']]))[0], [[0, 'eco'], [360, 'comfort'], [600, 'night']]);
    for (const bad of [[[10, 'eco']], [[0, 'eco'], [370, 'comfort']], [[0, 'eco'], [0, 'night']], [[0, 'hot']], [], [[0, 'eco'], [1440, 'night']]]) {
      assert.throws(() => heating.normalizeWeek(Array(7).fill(bad)), (e) => e.code === 'SMARTHOME_HEAT_INVALID', JSON.stringify(bad));
    }
    assert.throws(() => heating.normalizeWeek([WD]), (e) => e.code === 'SMARTHOME_HEAT_INVALID');
    const w = heating.normalizeWeek(WEEK);
    assert.equal(heating.presetAt(w, T(0, 7, 59)), 'comfort');
    assert.equal(heating.presetAt(w, T(0, 8, 0)), 'eco');
    assert.equal(heating.presetAt(w, T(5, 7, 0)), 'night', 'Saturday');
    // Friday 22:30 night → Saturday 0:00 night: no switching point at midnight
    const ch = heating.changesOf(w, T(4, 23, 0)).filter((c) => c.at > T(4, 22, 0) && c.at < T(5, 12, 0));
    assert.deepEqual(ch.map((c) => [new Date(c.at).getDate(), new Date(c.at).getHours(), new Date(c.at).getMinutes(), c.preset]), [[27, 22, 30, 'night'], [28, 7, 30, 'comfort']]);
    assert.equal(heating.slotStart(w, T(5, 3, 0)), T(4, 22, 30));
  });

  it('what wins: Aus · Fenster · Boost · by hand · holiday · Von Hand · plan (with away) · kept target', () => {
    const plans = new Map([[1, { id: 1, week: heating.normalizeWeek(WEEK), presets: { comfort: 22 }, window: { on: true, min: 2 }, away: true }]]);
    const house = { presets: { eco: 17.5 }, away: false, vacation: null };
    const ctx = { plans, house };
    const room = { id: 4, plan_id: 1, mode: 'plan', presets: {}, hold: null, manual: null };
    const at = T(0, 7, 0);
    assert.deepEqual([heating.decide(room, ctx, at).kind, heating.decide(room, ctx, at).setpoint], ['plan', 22], 'the plan\'s own Komfort');
    assert.equal(heating.decide({ ...room, presets: { comfort: 23 } }, ctx, at).setpoint, 23, 'the room\'s own over the plan\'s');
    assert.deepEqual(heating.decide(room, { plans, house: { ...house, away: true } }, at).preset, 'eco', 'away: Komfort becomes Eco');
    assert.equal(heating.decide(room, { plans, house: { ...house, away: true } }, at).setpoint, 17.5);
    assert.equal(heating.decide({ ...room, mode: 'manual', manual: 19 }, ctx, at).setpoint, 19);
    const vac = { from: T(0, 0), to: T(2, 18), preheat_h: 4, preset: 'eco', rooms: { 4: 'frost' } };
    assert.deepEqual([heating.decide({ ...room, mode: 'manual', manual: 19 }, { plans, house: { ...house, vacation: vac } }, at).kind], ['vacation']);
    assert.equal(heating.decide(room, { plans, house: { ...house, vacation: vac } }, at).setpoint, 7);
    assert.equal(heating.decide(room, { plans, house: { ...house, vacation: vac } }, T(2, 14, 0)).kind, 'plan', 'preheating: 4 h before the return the plan again');
    const ov = { setpoint: 21.5, until: T(0, 8), at: T(0, 6, 50) };
    assert.equal(heating.decide({ ...room, override: ov }, { plans, house: { ...house, vacation: vac } }, at).kind, 'override');
    assert.equal(heating.decide({ ...room, override: ov }, ctx, T(0, 8)).kind, 'plan', 'until the next switching point');
    const boost = { until: T(0, 7, 30), minutes: 30, at: T(0, 7) };
    assert.equal(heating.decide({ ...room, override: ov, boost }, ctx, at).kind, 'boost');
    assert.equal(heating.decide({ ...room, boost, window: { since: T(0, 6), lowered: true } }, ctx, at).kind, 'window');
    assert.equal(heating.decide({ ...room, mode: 'off', window: { since: T(0, 6), lowered: true } }, ctx, at).kind, 'off');
    assert.deepEqual(heating.decide({ ...room, plan_id: null, hold: 20 }, ctx, at), { kind: 'hold', setpoint: 20, sig: 'hold:20' });
    assert.deepEqual(heating.decide({ ...room, plan_id: null }, ctx, at), { kind: 'none', sig: null });
  });

  it('switching points: each sent once to every thermostat of the room, a missed one caught up, a device\'s own change holds until the next', () => withTrvs([TRV(1), TRV(2), TRV(3)], async (host, { sent, by, run, sync }) => {
    await area(host, by('Heizkörper 1'), 'Wohnzimmer');
    await area(host, by('Heizkörper 2'), 'Wohnzimmer');
    // without a plan nothing is sent
    now = T(0, 7, 0);
    await run();
    assert.deepEqual(sent, []);
    const wz = await roomOf(host, 'Wohnzimmer');
    assert.equal(wz.thermostats.length, 2);
    assert.equal((await roomOf(host, 'Heizkörper 3')).thermostats.length, 1, 'without an area: a room of its own');
    const p = await plan(host, [wz.id]);
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.deepEqual(p.json.plan.rooms, [{ id: wz.id, name: 'Wohnzimmer' }]);
    assert.deepEqual(sps(sent), [['01', { setpoint: 21 }], ['02', { setpoint: 21 }]], 'saving sends what applies now');
    await sync();
    await run();
    assert.deepEqual(sent, [], 'once');
    now = T(0, 7, 59, 30);
    await run();
    assert.deepEqual(sent, []);
    now = T(0, 8, 0);
    await run();
    assert.deepEqual(sps(sent), [['01', { setpoint: 18 }], ['02', { setpoint: 18 }]], '08:00 Eco');
    // the server was away from 15:50 to 17:10: the switching point of 16:00 comes now
    now = T(0, 17, 10);
    await run();
    assert.deepEqual(sps(sent), [['01', { setpoint: 21 }], ['02', { setpoint: 21 }]]);
    // a device changed by itself: kept until the next switching point
    await run();
    now = T(0, 22, 29);
    await run();
    assert.deepEqual(sent, []);
    now = T(0, 22, 30);
    await run();
    assert.deepEqual(sps(sent), [['01', { setpoint: 17 }], ['02', { setpoint: 17 }]]);
    const v = await roomOf(host, 'Wohnzimmer');
    assert.deepEqual([v.status.kind, v.status.preset, v.setpoint, v.plan.name], ['plan', 'night', 17, 'Familie Werktag']);
    assert.deepEqual(v.next.preset, 'comfort');
    assert.equal(v.next.at, T(1, 6, 0), 'Tuesday 06:00');
    assert.deepEqual(v.today.map((s) => [s.from, s.to, s.preset]), [[0, 360, 'night'], [360, 480, 'comfort'], [480, 960, 'eco'], [960, 1350, 'comfort'], [1350, 1440, 'night']]);
  }));

  it('commands that fail: the thermostats keep the last target, tried again after 5 minutes; an unreachable one gets it when it is back', () => withTrvs([TRV(1), TRV(2)], async (host, { sent, st, by, run, sync }) => {
    await area(host, by('Heizkörper 1'), 'Bad');
    await area(host, by('Heizkörper 2'), 'Bad');
    now = T(0, 7, 0);
    const bad = await roomOf(host, 'Bad');
    st.fail = 'ERR_RADIO_GATEWAY';
    await plan(host, [bad.id]);
    assert.equal(sent.splice(0).length, 2, 'tried');
    let v = await roomOf(host, 'Bad');
    assert.equal(v.pending, 2, '"Wird übertragen"');
    now = T(0, 7, 3);
    await run();
    assert.deepEqual(sent, [], 'not every 30 s');
    st.fail = null;
    now = T(0, 7, 5);
    await run();
    assert.deepEqual(sps(sent), [['01', { setpoint: 21 }], ['02', { setpoint: 21 }]]);
    // a thermostat away (battery): the others get the switching point, it when it answers again
    st.devices[1].online = false;
    await sync();
    now = T(0, 8, 0);
    await run();
    assert.deepEqual(sps(sent), [['01', { setpoint: 18 }]]);
    v = await roomOf(host, 'Bad');
    assert.deepEqual([v.pending, v.reachable], [1, 'some']);
    st.devices[1].online = true;
    await sync();
    now = T(0, 8, 1);
    await run();
    assert.deepEqual(sps(sent), [['02', { setpoint: 18 }]]);
  }));

  it('by hand: until the next switching point (target or preset), "Zurück zum Plan"; Von Hand holds, Aus switches off and back', () => withTrvs([TRV(1)], async (host, { sent, by, run }) => {
    await area(host, by('Heizkörper 1'), 'Arbeitszimmer');
    await asAdmin(host, 'PUT', `/resources/${by('Heizkörper 1')}/owners`, { userIds: [ADA.id] });
    now = T(0, 9, 0);
    const az = await roomOf(host, 'Arbeitszimmer');
    await plan(host, [az.id]);
    sent.splice(0);
    let r = await asPortal(host, ADA, 'POST', `/portal/heating/rooms/${az.id}`, { action: 'setpoint', setpoint: 22 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(sps(sent), [['01', { setpoint: 22 }]], 'sent at once');
    assert.deepEqual([r.json.room.status.kind, r.json.room.status.setpoint, r.json.room.status.until, r.json.room.next.preset], ['override', 22, T(0, 16), 'comfort']);
    now = T(0, 15, 59);
    await run();
    assert.deepEqual(sent, []);
    now = T(0, 16, 0);
    await run();
    assert.deepEqual(sps(sent), [['01', { setpoint: 21 }]], 'the plan again');
    assert.equal((await roomOf(host, 'Arbeitszimmer')).status.kind, 'plan');
    // a preset by hand: Eco until 22:30
    r = await asPortal(host, ADA, 'POST', `/portal/heating/rooms/${az.id}`, { action: 'preset', preset: 'eco' });
    assert.deepEqual([r.json.room.status.kind, r.json.room.status.preset, r.json.room.status.until], ['override', 'eco', T(0, 22, 30)]);
    assert.deepEqual(sps(sent), [['01', { setpoint: 18 }]]);
    r = await asPortal(host, ADA, 'POST', `/portal/heating/rooms/${az.id}`, { action: 'resume' });
    assert.equal(r.json.room.status.kind, 'plan');
    assert.deepEqual(sps(sent), [['01', { setpoint: 21 }]]);
    // Betrieb: only administrators
    assert.equal((await asPortal(host, ADA, 'POST', `/portal/heating/rooms/${az.id}`, { action: 'mode', mode: 'manual' })).status, 403);
    r = await asAdmin(host, 'POST', `/heating/rooms/${az.id}`, { action: 'mode', mode: 'manual' });
    assert.deepEqual([r.json.room.mode, r.json.room.status.kind, r.json.room.status.setpoint], ['manual', 'manual', 21]);
    assert.deepEqual(sps(sent), [['01', { setpoint: 21 }]], 'what applied, now for good');
    await asPortal(host, ADA, 'POST', `/portal/heating/rooms/${az.id}`, { action: 'setpoint', setpoint: 20.5 });
    assert.deepEqual(sps(sent), [['01', { setpoint: 20.5 }]]);
    now = T(0, 22, 30);
    await run();
    assert.deepEqual(sent, [], 'Von Hand: no switching point');
    assert.equal((await asPortal(host, ADA, 'POST', `/portal/heating/rooms/${az.id}`, { action: 'resume' })).status, 403, 'only an administrator leaves Von Hand');
    r = await asAdmin(host, 'POST', `/heating/rooms/${az.id}`, { action: 'mode', mode: 'off' });
    assert.deepEqual(sps(sent), [['01', { mode: 'off' }]]);
    assert.equal(r.json.room.status.kind, 'off');
    assert.equal((await asPortal(host, ADA, 'POST', `/portal/heating/rooms/${az.id}`, { action: 'boost', minutes: 30 })).json.code, 'SMARTHOME_HEAT_OFF');
    r = await asAdmin(host, 'POST', `/heating/rooms/${az.id}`, { action: 'resume' });
    assert.deepEqual([r.json.room.mode, r.json.room.status.kind, r.json.room.status.preset], ['plan', 'plan', 'night']);
    assert.deepEqual(sps(sent), [['01', { mode: 'heat', setpoint: 17 }]], 'the mode it had before, and the plan\'s target');
    // "Plan heute aussetzen": the target of now until midnight
    r = await asAdmin(host, 'POST', `/heating/rooms/${az.id}`, { action: 'skip_today' });
    assert.deepEqual([r.json.room.status.kind, r.json.room.status.until], ['override', T(1, 0, 0)]);
  }));

  it('a room without a plan keeps its target; a change there holds for good', () => withTrvs([TRV(1)], async (host, { sent, by, run }) => {
    now = T(0, 9, 0);
    const r1 = await roomOf(host, 'Heizkörper 1');
    let r = await asAdmin(host, 'POST', `/heating/rooms/${r1.id}`, { action: 'setpoint', setpoint: 19.5 });
    assert.deepEqual([r.json.room.status.kind, r.json.room.status.setpoint], ['hold', 19.5]);
    assert.deepEqual(sps(sent), [['01', { setpoint: 19.5 }]]);
    now = T(3, 9, 0);
    await run();
    assert.deepEqual(sent, []);
    // deleting a plan: its rooms keep what they had
    await area(host, by('Heizkörper 1'), 'Gäste');
    const g = await roomOf(host, 'Gäste');
    const p = (await plan(host, [g.id])).json.plan;
    sps(sent);
    assert.equal((await asAdmin(host, 'DELETE', `/heating/plans/${p.id}`)).status, 200);
    r = await roomOf(host, 'Gäste');
    assert.deepEqual([r.plan, r.status.kind, r.status.setpoint], [null, 'hold', 18], 'Thursday 09:00 was Eco');
    assert.equal((await asAdmin(host, 'DELETE', `/heating/plans/${p.id}`)).status, 404);
  }));

  it('Heizung abwesend: Komfort becomes Eco where the plan allows it; back to the plan when switched off', () => withTrvs([TRV(1), TRV(2)], async (host, { sent, by }) => {
    await area(host, by('Heizkörper 1'), 'Wohnzimmer');
    await area(host, by('Heizkörper 2'), 'Bad');
    now = T(0, 17, 0);
    const wz = await roomOf(host, 'Wohnzimmer');
    const bad = await roomOf(host, 'Bad');
    await plan(host, [wz.id]);
    await asAdmin(host, 'POST', '/heating/plans', { name: 'Bad', week: WEEK, rooms: [bad.id], away: false, presets: { comfort: 23 } });
    sps(sent);
    let r = await asAdmin(host, 'PUT', '/heating/house', { away: true });
    assert.equal(r.json.house.away, true);
    assert.deepEqual(sps(sent), [['01', { setpoint: 18 }]], 'only the plan that allows it');
    const v = await roomOf(host, 'Wohnzimmer');
    assert.deepEqual([v.status.preset, v.status.away], ['eco', true]);
    r = await asAdmin(host, 'PUT', '/heating/house', { away: false });
    assert.deepEqual(sps(sent), [['01', { setpoint: 21 }]]);
    // the house's temperatures: every plan without its own gets them at once
    r = await asAdmin(host, 'PUT', '/heating/house', { presets: { comfort: 21.5, eco: 17, night: 16.5, frost: 6 } });
    assert.deepEqual(r.json.house.presets, { comfort: 21.5, eco: 17, night: 16.5, frost: 6 });
    assert.deepEqual(sps(sent), [['01', { setpoint: 21.5 }]], 'the bath has its own Komfort');
    assert.equal((await asAdmin(host, 'PUT', '/heating/house', { presets: { comfort: 31 } })).json.code, 'SMARTHOME_HEAT_INVALID');
    assert.equal((await asAdmin(host, 'PUT', '/heating/house', { away: 'yes' })).status, 400);
  }));

  it('holiday: a preset per room ahead of the plans, the plans again 4 h before the return, then gone', () => withTrvs([TRV(1), TRV(2)], async (host, { sent, by, run }) => {
    await area(host, by('Heizkörper 1'), 'Wohnzimmer');
    await area(host, by('Heizkörper 2'), 'Kinderzimmer');
    now = T(0, 9, 0);
    const wz = await roomOf(host, 'Wohnzimmer');
    const kz = await roomOf(host, 'Kinderzimmer');
    await plan(host, [wz.id, kz.id]);
    sps(sent);
    const iso = (ms) => new Date(ms).toISOString();
    assert.equal((await asAdmin(host, 'PUT', '/heating/vacation', { from: iso(T(0, 12)), to: iso(T(0, 10)) })).status, 400, 'to before from');
    assert.equal((await asAdmin(host, 'PUT', '/heating/vacation', { from: iso(T(0, 12)), to: iso(T(2, 21)), rooms: { [kz.id]: 'hot' } })).status, 400);
    const r = await asAdmin(host, 'PUT', '/heating/vacation', { from: iso(T(0, 12)), to: iso(T(2, 21)), rooms: { [kz.id]: 'frost' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.house.vacation.preheat_h, r.json.house.vacation.preset, r.json.house.vacation.resume_at], [4, 'eco', iso(T(2, 17))]);
    assert.deepEqual(sent, []);
    now = T(0, 12, 0);
    await run();
    assert.deepEqual(sps(sent), [['02', { setpoint: 7 }], ['01', { setpoint: 18 }]], 'Kinderzimmer Frostschutz, Wohnzimmer Eco');
    now = T(0, 16, 0);
    await run();
    assert.deepEqual(sent, [], 'the plan\'s 16:00 does not count');
    let v = await roomOf(host, 'Kinderzimmer');
    assert.deepEqual([v.status.kind, v.next.at, v.next.preset], ['vacation', T(2, 17), 'comfort']);
    // a change by hand during the holiday lasts until the plans start again
    await asAdmin(host, 'POST', `/heating/rooms/${wz.id}`, { action: 'setpoint', setpoint: 20 });
    v = await roomOf(host, 'Wohnzimmer');
    assert.deepEqual([v.status.kind, v.status.until], ['override', T(2, 17)]);
    sps(sent);
    now = T(2, 17, 0);
    await run();
    assert.deepEqual(sps(sent), [['02', { setpoint: 21 }], ['01', { setpoint: 21 }]], 'warm at the return (21:00)');
    now = T(2, 21, 0);
    await run();
    assert.equal((await asAdmin(host, 'GET', '/heating')).json.house.vacation, null, 'over');
    assert.equal((await asPortal(host, ADA, 'PUT', '/heating/vacation', {})).status, 403, 'the admin API: never a portal viewer');
  }));

  it('boost: 30 °C for 15 / 30 / 60 minutes without a boost of its own, then back to what applies', () => withTrvs([TRV(1)], async (host, { sent, by, run }) => {
    await area(host, by('Heizkörper 1'), 'Bad');
    now = T(0, 9, 0);
    const bad = await roomOf(host, 'Bad');
    await plan(host, [bad.id]);
    sps(sent);
    assert.equal((await asAdmin(host, 'POST', `/heating/rooms/${bad.id}`, { action: 'boost', minutes: 20 })).status, 400);
    let r = await asAdmin(host, 'POST', `/heating/rooms/${bad.id}`, { action: 'boost', minutes: 15 });
    assert.deepEqual([r.json.room.status.kind, r.json.room.boost.until, r.json.room.after.preset], ['boost', T(0, 9, 15), 'eco']);
    assert.deepEqual(sps(sent), [['01', { setpoint: 30 }]]);
    now = T(0, 9, 14);
    await run();
    assert.deepEqual(sent, []);
    now = T(0, 9, 15);
    await run();
    assert.deepEqual(sps(sent), [['01', { setpoint: 18 }]]);
    assert.equal((await roomOf(host, 'Bad')).boost, null);
    // stopped early
    await asAdmin(host, 'POST', `/heating/rooms/${bad.id}`, { action: 'boost', minutes: 60 });
    sps(sent);
    r = await asAdmin(host, 'POST', `/heating/rooms/${bad.id}`, { action: 'boost_stop' });
    assert.equal(r.json.room.status.kind, 'plan');
    assert.deepEqual(sps(sent), [['01', { setpoint: 18 }]]);
  }));

  it('a thermostat with a plan of its own (mode auto) is set to heat when the plan sends to it', () => withTrvs([TRV(1, { values: { temperature: 19, setpoint: 22, mode: 'auto' } })], async (host, { sent, by }) => {
    await area(host, by('Heizkörper 1'), 'Flur');
    now = T(0, 9, 0);
    const flur = await roomOf(host, 'Flur');
    assert.equal(flur.thermostats[0].own_schedule, true);
    const all = (await asAdmin(host, 'GET', '/heating')).json.all_rooms.find((x) => x.id === flur.id);
    assert.deepEqual(all.own_schedule, ['Heizkörper 1'], 'the editor names it');
    await plan(host, [flur.id]);
    assert.deepEqual(sps(sent), [['01', { setpoint: 18, mode: 'heat' }]]);
  }));

  it('window open: a contact of the room open longer than the plan says → Frostschutz; closed → what applies then', () => withTrvs([TRV(1), CONTACT()], async (host, { sent, st, by, run, sync }) => {
    await area(host, by('Heizkörper 1'), 'Schlafzimmer');
    await area(host, by('Fensterkontakt Terrasse'), 'Schlafzimmer');
    now = T(0, 18, 0);
    const sz = await roomOf(host, 'Schlafzimmer');
    await plan(host, [sz.id], { window: { on: true, min: 2 } });
    sps(sent);
    st.devices[1].values = { window: true, battery: 90 };
    await sync();
    await run();
    now = T(0, 18, 1, 30);
    await run();
    assert.deepEqual(sent, [], 'not before 2 minutes');
    now = T(0, 18, 2);
    await run();
    assert.deepEqual(sps(sent), [['01', { setpoint: 7 }]]);
    const v = await roomOf(host, 'Schlafzimmer');
    assert.deepEqual([v.status.kind, v.window.open, v.window.lowered, v.after.preset], ['window', true, true, 'comfort']);
    // a person cannot boost meanwhile: the window wins
    await asAdmin(host, 'POST', `/heating/rooms/${sz.id}`, { action: 'boost', minutes: 15 });
    assert.deepEqual(sent, []);
    await asAdmin(host, 'POST', `/heating/rooms/${sz.id}`, { action: 'boost_stop' });
    st.devices[1].values = { window: false, battery: 90 };
    await sync();
    now = T(0, 18, 10);
    await run();
    assert.deepEqual(sps(sent), [['01', { setpoint: 21 }]]);
    // switched off in the plan: the window does nothing
    await asAdmin(host, 'PUT', `/heating/plans/${(await roomOf(host, 'Schlafzimmer')).plan.id}`, { name: 'Schlafen', week: WEEK, rooms: [sz.id], window: { on: false } });
    sps(sent);
    st.devices[1].values = { window: true, battery: 90 };
    await sync();
    now = T(0, 18, 20);
    await run();
    now = T(0, 18, 30);
    await run();
    assert.deepEqual(sent, []);
    assert.equal((await asAdmin(host, 'PUT', `/heating/plans/${(await roomOf(host, 'Schlafzimmer')).plan.id}`, { name: 'x', week: WEEK, window: { min: 3 } })).status, 400, '1, 2 or 5 minutes');
  }));

  it('the background run of the plugin runs the plan; a run without changes writes nothing', () => withTrvs([TRV(1)], async (host, { sent, by }) => {
    await area(host, by('Heizkörper 1'), 'Wohnzimmer');
    now = T(0, 7, 0);
    const wz = await roomOf(host, 'Wohnzimmer');
    await plan(host, [wz.id]);
    sps(sent);
    now = T(0, 8, 0);
    zigbee._mem.at = 0;
    await host.tick();
    assert.deepEqual(sps(sent), [['01', { setpoint: 18 }]]);
    zigbee._mem.at = 0;
    await host.tick();
    host.resetDbWrites();
    zigbee._mem.at = 0;
    await host.tick();
    now = T(0, 8, 30);
    zigbee._mem.at = 0;
    await host.tick();
    assert.deepEqual(host.dbWrites, [], 'nothing changed: no write');
  }));
});

describe('Heizung: deCONZ thermostats', () => {
  const sensors = () => ({
    20: { name: 'Thermostat Küche', type: 'ZHAThermostat', uniqueid: '00:15:8d:00:aa:bb:cc:01-01-0201', state: { temperature: 1980, on: true, valve: 120, lowbattery: false, lastupdated: '2026-11-23T06:00:00' },
      config: { heatsetpoint: 2000, mode: 'heat', battery: 64, reachable: true, on: true, preset: 'auto' } },
    21: { name: 'Thermostat Flur', type: 'ZHAThermostat', uniqueid: '00:15:8d:00:aa:bb:cc:02-01-0201', state: { temperature: 1850, on: false },
      config: { heatsetpoint: 1800, battery: 40, reachable: true, schedule_on: true } },
    14: { name: 'Fenster Küche', type: 'ZHAOpenClose', uniqueid: 's1', state: { open: false } },
  });
  const { connected } = require('./helpers');

  it('ZHAThermostat: a thermostat (target, mode, valve, battery), set through its config — also by the plan, its own plan set to manual', () => {
    const gw = fakeDeconz({ sensors: sensors() });
    return withHost({ gateways: [gw] }, async (host) => {
      const { by, id } = await connected(host);
      const k = by('Thermostat Küche');
      assert.deepEqual([k.kind, k.capabilities.modes, k.capabilities.preset, k.capabilities.setpoint], ['thermostat', ['off', 'heat', 'auto'], true, { min: 5, max: 30, step: 0.5 }]);
      assert.deepEqual({ value: k.state.value, setpoint: k.state.setpoint, mode: k.state.mode, heating: k.state.heating, valve: k.state.valve, battery: k.state.battery, preset: k.state.preset },
        { value: 19.8, setpoint: 20, mode: 'heat', heating: true, valve: 47, battery: 64, preset: 'auto' }, 'valve 0–255 → %');
      const f = by('Thermostat Flur');
      assert.deepEqual([f.capabilities.modes, f.capabilities.schedule, f.state.schedule_on], [undefined, true, true]);
      gw.calls.length = 0;
      let r = await asAdmin(host, 'POST', `/resources/${k.id}/state`, { setpoint: 21.3, mode: 'off' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(gw.calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body]), [['/api/KEY1234567/sensors/20/config', { heatsetpoint: 2150, mode: 'off' }]]);
      assert.equal((await asAdmin(host, 'POST', `/resources/${k.id}/state`, { on: true })).json.code, 'SMARTHOME_INVALID_PATCH');
      // a room with the window contact of its area; the plan sets the thermostat's own plan to manual
      await area(host, k.id, 'Küche');
      await area(host, by('Fenster Küche').id, 'Küche');
      await area(host, f.id, 'Flur');
      now = T(0, 9, 0);
      const kitchen = await roomOf(host, 'Küche');
      assert.deepEqual(kitchen.window.contacts.map((c) => [c.name, c.open]), [['Fenster Küche', false]]);
      gw.calls.length = 0;
      await plan(host, [kitchen.id, (await roomOf(host, 'Flur')).id]);
      assert.deepEqual(gw.calls.filter((c) => c.method === 'PUT').map((c) => [c.path.split('/').slice(-2).join('/'), c.body]), [
        ['21/config', { heatsetpoint: 1800, schedule_on: false }],
        ['20/config', { heatsetpoint: 1800, preset: 'manual' }],
      ], 'Flur, Küche: the own plans off (a mode switched off on the device itself stays off)');
      // boost of its own (deCONZ preset), afterwards manual again
      await host.request({ method: 'POST', path: `/gateways/${id}/sync`, user: { id: 1, name: 'admin', role: 'admin' } });
      gw.calls.length = 0;
      r = await asAdmin(host, 'POST', `/heating/rooms/${kitchen.id}`, { action: 'boost', minutes: 30 });
      assert.deepEqual(gw.calls.filter((c) => c.method === 'PUT').map((c) => c.body), [{ preset: 'boost' }]);
      gw.calls.length = 0;
      await asAdmin(host, 'POST', `/heating/rooms/${kitchen.id}`, { action: 'boost_stop' });
      assert.deepEqual(gw.calls.filter((c) => c.method === 'PUT').map((c) => c.body), [{ heatsetpoint: 1800, preset: 'manual' }]);
    });
  });

  it('window open: the notification of the contact says "Fenster offen, Heizung heruntergeregelt"', () => {
    const gw = fakeDeconz({ sensors: sensors() });
    return withHost({ gateways: [gw], settings: { notify_window_min: 5 } }, async (host) => {
      const { by } = await connected(host);
      await area(host, by('Thermostat Küche').id, 'Küche');
      await area(host, by('Fenster Küche').id, 'Küche');
      await asAdmin(host, 'PUT', `/resources/${by('Fenster Küche').id}/owners`, { userIds: [ADA.id] });
      now = T(0, 9, 0);
      await plan(host, [(await roomOf(host, 'Küche')).id]);
      const alerts = require('../server/alerts');
      alerts.reset();
      const tick = async () => { host.plugin._state.lastSync = 0; await host.tick(); };
      await tick();
      gw.sensors[14].state.open = true;
      // the thermostat does not heat: before 1.14.0 no message on a gateway with thermostats
      gw.sensors[20].state.on = false;
      await tick();
      await heating.tick(host.gc);
      now = T(0, 9, 3);
      await heating.tick(host.gc);
      const v = await roomOf(host, 'Küche');
      assert.equal(v.status.kind, 'window');
      // the notification's minutes run on the real clock: the contact has been open for 6 minutes
      const state = await host.gc.storage.get(alerts.STATE_KEY);
      for (const g of Object.values(state.gateways)) for (const s of Object.values(g.sensors)) if (s.openSince) s.openSince -= 6 * 60000;
      await host.gc.storage.set(alerts.STATE_KEY, state);
      await tick();
      const n = host.notifications.filter((x) => x.topic === 'window_open');
      assert.equal(n.length, 1);
      assert.equal(n[0].title, 'Fenster offen, Heizung heruntergeregelt');
      assert.equal(n[0].body, 'Fenster Küche ist seit 6 Minuten offen');
    });
  });
});

describe('Heizung: the manifest', () => {
  it('no new edge capability (no confirmation on the gateways), version 1.14.0 or later, the page "Heizung"', () => {
    const manifest = require('../plugin.json');
    assert.deepEqual(manifest.edge.capabilities, { mdns: { services: ['_shelly._tcp', '_http._tcp'] }, http: { lan: true }, mqtt: { topics: ['shellies/#', 'tasmota/#'] } });
    const [maj, min] = manifest.version.split('.').map(Number);
    assert.ok(maj > 1 || (maj === 1 && min >= 14), manifest.version);
    assert.ok(manifest.ui.pages.some((p) => p.id === 'heating'));
    assert.equal(manifest.permissions.background.intervalSeconds, 30, 'the plan runs about every 30 s');
  });
});
