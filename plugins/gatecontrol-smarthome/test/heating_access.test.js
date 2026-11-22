'use strict';

// Heizung (1.14.0): who may do what (administrators every room, plans, presets of the house, holiday; assigned persons
// in their rooms the target within the room's upper limit, a preset and boost) and the quick actions of the apps (a
// card per room: actual value, target stepper in half degrees, presets as a choice without a selection while no
// preset applies (1.16.0), today's plan as a day bar, valve / window / battery, controls locked while the window is
// open or no thermostat answers, Boost and "Zurück zum Plan" beside it, the toggle "Heizung abwesend").
// All rooms, names and values are made up.

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asPortal, ADMIN, ADA, BOB } = require('./helpers');
const zigbee = require('../server/zigbee');
const radio = require('../server/radio');
const heating = require('../server/heating');

const T = (d, h, m = 0) => new Date(2026, 10, 23 + d, h, m).getTime();
let now = T(0, 7, 0);
beforeEach(() => { now = T(0, 7, 0); heating._setClock(() => now); });
after(() => heating._setClock(null));

const WD = [[0, 'night'], [360, 'comfort'], [480, 'eco'], [960, 'comfort'], [1350, 'night']];
const WEEK = [WD, WD, WD, WD, WD, WD, WD];
const base = { gatewayId: 7, gateway: 'Pi Keller', online: true };
const TRV = (n, o = {}) => ({ ...base, id: `z2m:00158d00050505${String(n).padStart(2, '0')}`, ieee: `00:15:8d:00:05:05:05:${String(n).padStart(2, '0')}`, name: `Heizkörper ${n}`,
  model: 'SRTS-A01', vendor: 'Aqara', kind: 'climate', caps: { setpoint: { min: 5, max: 30, step: 0.5 }, modes: ['off', 'heat'] },
  values: { temperature: 20.5, setpoint: 20, mode: 'heat', heating: true, valve: 40, battery: 80 }, seenAt: new Date().toISOString(), ...o });
const CONTACT = (o = {}) => ({ ...base, id: 'z2m:00158d0007070707', ieee: '00:15:8d:00:07:07:07:07', name: 'Fensterkontakt Terrasse', model: 'MCCGQ11LM', vendor: 'Aqara',
  kind: 'sensor', caps: {}, values: { window: false }, seenAt: new Date().toISOString(), ...o });

async function withRooms(list, fn) {
  const sent = [];
  const st = { devices: list };
  zigbee._mem.at = 0;
  radio._mem.at = 0;
  await withHost({ gateways: [], radio: {
    sensors: () => [],
    zigbee: () => ({ gateways: [{ id: 7, name: 'Pi Keller' }], devices: st.devices }),
    command: async (id, set) => { sent.push([id.slice(-2), set]); return { accepted: true }; },
  } }, async (host) => {
    await zigbee.sync(host.gc, { force: true });
    const res = (await host.gc.db.query("SELECT id, name FROM resources WHERE deconz_type = 'z2m' ORDER BY name")).rows;
    const by = (name) => res.find((r) => r.name === name).id;
    const set = async (name, area, owners) => {
      await asAdmin(host, 'PUT', `/resources/${by(name)}`, { area });
      if (owners) await asAdmin(host, 'PUT', `/resources/${by(name)}/owners`, { userIds: owners });
    };
    await fn(host, { sent, st, by, set, sync: () => zigbee.sync(host.gc, { force: true }) });
  });
}

const roomId = async (host, name) => (await asAdmin(host, 'GET', '/heating')).json.rooms.find((r) => r.name === name).id;

describe('Heizung: who may do what', () => {
  it('portal: only the rooms with a thermostat of the viewer (all thermostats of such a room), no plans, no other rooms', () => withRooms([TRV(1), TRV(2), TRV(3)], async (host, { set, sent }) => {
    await set('Heizkörper 1', 'Wohnzimmer', [ADA.id]);
    await set('Heizkörper 2', 'Wohnzimmer');
    await set('Heizkörper 3', 'Bad', [BOB.id]);
    const wz = await roomId(host, 'Wohnzimmer');
    const bad = await roomId(host, 'Bad');
    await asAdmin(host, 'POST', '/heating/plans', { name: 'Familie Werktag', week: WEEK, rooms: [wz, bad] });
    sent.splice(0);
    const ada = (await asPortal(host, ADA, 'GET', '/portal/heating')).json;
    assert.deepEqual(ada.rooms.map((r) => [r.name, r.thermostats.length, r.plan.name]), [['Wohnzimmer', 2, 'Familie Werktag']]);
    assert.deepEqual(ada.plans, []);
    assert.equal(ada.all_rooms, undefined);
    assert.deepEqual((await asPortal(host, { id: 9, name: 'Eve', role: 'user' }, 'GET', '/portal/heating')).json.rooms, []);
    // one target for the whole room
    let r = await asPortal(host, ADA, 'POST', `/portal/heating/rooms/${wz}`, { action: 'setpoint', setpoint: 21.5 });
    assert.equal(r.status, 200);
    assert.deepEqual(sent.splice(0), [['01', { setpoint: 21.5 }], ['02', { setpoint: 21.5 }]]);
    r = await asPortal(host, ADA, 'POST', `/portal/heating/rooms/${bad}`, { action: 'setpoint', setpoint: 21 });
    assert.deepEqual([r.status, r.json.code], [403, 'SMARTHOME_NOT_OWNER']);
    assert.equal((await asPortal(host, ADA, 'POST', '/portal/heating/rooms/999', { action: 'setpoint', setpoint: 21 })).status, 404);
    for (const bad2 of [{ action: 'setpoint', setpoint: '21' }, { action: 'setpoint', setpoint: 31 }, { action: 'preset', preset: 'party' }, { action: 'boost', minutes: 45 }, { action: 'dance' }]) {
      assert.equal((await asPortal(host, ADA, 'POST', `/portal/heating/rooms/${wz}`, bad2)).status, 400, JSON.stringify(bad2));
    }
    // plans, the house, the holiday, a room's settings: administrators only
    for (const [m, p] of [['GET', '/heating'], ['PUT', '/heating/house'], ['POST', '/heating/plans'], ['PUT', `/heating/rooms/${wz}`]]) {
      assert.equal((await asPortal(host, ADA, m, p, {})).status, 403, `${m} ${p}`);
    }
    const adm = (await asAdmin(host, 'GET', '/heating')).json;
    assert.deepEqual(adm.rooms.map((x) => x.name), ['Bad', 'Wohnzimmer']);
    assert.deepEqual(adm.plans.map((p) => [p.name, p.rooms.map((x) => x.name)]), [['Familie Werktag', ['Bad', 'Wohnzimmer']]]);
  }));

  it('the upper limit of a room: assigned persons stay below it (stepper.max of the apps too), no boost there; administrators are free', () => withRooms([TRV(1)], async (host, { set, sent }) => {
    await set('Heizkörper 1', 'Kinderzimmer', [ADA.id, ADMIN.id]);
    const kz = await roomId(host, 'Kinderzimmer');
    assert.equal((await asAdmin(host, 'PUT', `/heating/rooms/${kz}`, { max_setpoint: 40 })).status, 400);
    let r = await asAdmin(host, 'PUT', `/heating/rooms/${kz}`, { max_setpoint: 22, presets: { comfort: 20 } });
    assert.deepEqual(r.json.room, { id: kz, presets: { comfort: 20 }, max_setpoint: 22 });
    r = await asPortal(host, ADA, 'POST', `/portal/heating/rooms/${kz}`, { action: 'setpoint', setpoint: 22.5 });
    assert.deepEqual([r.status, r.json.code], [403, 'SMARTHOME_HEAT_LIMIT']);
    assert.equal((await asPortal(host, ADA, 'POST', `/portal/heating/rooms/${kz}`, { action: 'setpoint', setpoint: 22 })).status, 200);
    assert.equal((await asPortal(host, ADA, 'POST', `/portal/heating/rooms/${kz}`, { action: 'boost', minutes: 15 })).json.code, 'SMARTHOME_HEAT_LIMIT');
    assert.equal((await asPortal(host, ADA, 'POST', `/portal/heating/rooms/${kz}`, { action: 'preset', preset: 'comfort' })).json.room.status.setpoint, 20, 'the room\'s own Komfort');
    assert.equal((await asAdmin(host, 'POST', `/heating/rooms/${kz}`, { action: 'setpoint', setpoint: 25 })).status, 200);
    const adaQa = await host.quickActions(ADA);
    const admQa = await host.quickActions(ADMIN);
    const sp = (list) => list.find((a) => a.id === `heat:${kz}`).widget.controls.find((c) => c.id === 'sp');
    assert.deepEqual([sp(adaQa).max, sp(adaQa).value], [22, 22], 'the room has 25 °C now: the stepper shows its upper limit');
    assert.equal(sp(admQa).max, 30);
    assert.ok(!adaQa.some((a) => a.id === `heat:${kz}:boost`), 'no boost button below a limit');
    assert.ok(admQa.some((a) => a.id === `heat:${kz}:boost`));
    r = await host.runQuickAction(ADA, `heat:${kz}`, 'de', { control: 'sp', value: 23 });
    assert.equal(r.status, 400, 'above stepper.max: the host refuses it already');
    assert.equal((await asAdmin(host, 'PUT', `/heating/rooms/${kz}`, { max_setpoint: null })).json.room.max_setpoint, null);
    assert.ok(sent.length > 0);
  }));
});

describe('Heizung: quick actions of the apps', () => {
  it('a card per room: actual value, target stepper in half degrees (no rounding), presets, valve and battery; Boost beside it', () => withRooms([TRV(1), TRV(2, { values: { temperature: 20.7, setpoint: 20, mode: 'heat', heating: false, valve: 35, battery: 64 } })], async (host, { set, sent }) => {
    await set('Heizkörper 1', 'Wohnzimmer', [ADA.id]);
    await set('Heizkörper 2', 'Wohnzimmer');
    const wz = await roomId(host, 'Wohnzimmer');
    await asAdmin(host, 'POST', '/heating/plans', { name: 'Familie Werktag', week: WEEK, rooms: [wz] });
    sent.splice(0);
    let qa = await host.quickActions(ADA);
    assert.deepEqual(qa.map((a) => [a.id, a.kind, a.title, a.device.id]), [[`heat:${wz}`, 'button', 'Wohnzimmer', `heat:${wz}`], [`heat:${wz}:boost`, 'button', 'Boost 30 min', `heat:${wz}`]]);
    const w = qa[0].widget;
    assert.deepEqual([w.label, w.value, w.unit, w.state, w.power], ['Ist', 20.6, '°C', 'on', false]);
    assert.equal(w.status, 'Komfort · nach Plan bis 08:00, dann Eco 18,0 °C');
    assert.deepEqual([w.badge.value, w.badge.unit, w.badge.label], [40, '%', 'Ventil']);
    assert.deepEqual(w.readings.map((x) => [x.id, x.value, x.unit]), [['battery', 64, '%']]);
    assert.deepEqual(w.controls[0], { id: 'sp', kind: 'stepper', label: 'Soll', value: 21, min: 5, max: 30, step: 0.5, unit: '°C', disabled: false });
    assert.deepEqual([w.controls[1].kind, w.controls[1].value, w.controls[1].disabled, w.controls[1].options.map((o) => o.label)], ['choice', 'comfort', false, ['Komfort', 'Eco', 'Nacht', 'Frost']]);
    // the day bar: today's plan in hours, a colour per preset, now 07:00
    const C = heating.SEGMENT_COLORS;
    assert.deepEqual(w.timeline, { from: 0, to: 24, now: 7, segments: [
      { from: 0, to: 6, tone: null, color: C.night, label: 'Nacht' }, { from: 6, to: 8, tone: null, color: C.comfort, label: 'Komfort' },
      { from: 8, to: 16, tone: null, color: C.eco, label: 'Eco' }, { from: 16, to: 22.5, tone: null, color: C.comfort, label: 'Komfort' },
      { from: 22.5, to: 24, tone: null, color: C.night, label: 'Nacht' },
    ] });
    // 21.5 °C stays 21.5 °C
    let r = await host.runQuickAction(ADA, `heat:${wz}`, 'de', { control: 'sp', value: 21.5 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(sent.splice(0), [['01', { setpoint: 21.5 }], ['02', { setpoint: 21.5 }]]);
    assert.equal(r.body.widget.status, 'Von Hand 21,5 °C bis 08:00, dann Eco 18,0 °C');
    // no preset applies: no option is active (no extra option any more), the status line says what applies
    const choice = r.body.widget.controls[1];
    assert.deepEqual([choice.value, choice.disabled, choice.options.map((o) => o.id)], [null, false, ['comfort', 'eco', 'night', 'frost']]);
    assert.equal(r.body.widget.timeline.segments.length, 5, 'the bar shows the plan, not what is set by hand');
    qa = await host.quickActions(ADA);
    assert.ok(qa.some((a) => a.id === `heat:${wz}:plan` && a.title === 'Zurück zum Plan'));
    r = await host.runQuickAction(ADA, `heat:${wz}`, 'de', { control: 'preset', value: 'manual' });
    assert.deepEqual([r.status, r.body.error, sent.length], [400, 'invalid_value', 0], 'the old extra option is gone');
    assert.deepEqual(await heating.runQuickAction(host.gc, { ...ADA, portal: true, loggedIn: true }, 'de', `heat:${wz}`, 'preset', 'boost'), { ok: false, message: 'Diese Aktion gibt es nicht mehr.' });
    r = await host.runQuickAction(ADA, `heat:${wz}`, 'de', { control: 'preset', value: 'eco' });
    assert.deepEqual(sent.splice(0), [['01', { setpoint: 18 }], ['02', { setpoint: 18 }]]);
    assert.equal(r.body.widget.controls[1].value, 'eco');
    assert.equal(r.body.widget.status, 'Eco · Von Hand 18,0 °C bis 08:00, dann Eco 18,0 °C');
    r = await host.runQuickAction(ADA, `heat:${wz}:plan`);
    assert.deepEqual([r.body.message, r.body.widget.controls[1].value], ['Wohnzimmer: wieder nach Plan', 'comfort']);
    sent.splice(0);
    // boost: the card says so, no preset is active, the button ends it
    r = await host.runQuickAction(ADA, `heat:${wz}:boost`);
    assert.equal(r.body.message, 'Wohnzimmer: Boost läuft');
    assert.deepEqual(sent.splice(0), [['01', { setpoint: 30 }], ['02', { setpoint: 30 }]]);
    qa = await host.quickActions(ADA);
    const card = qa.find((a) => a.id === `heat:${wz}`).widget;
    assert.equal(card.status, 'Boost · noch 30 min, danach Komfort 21,0 °C');
    assert.deepEqual([card.controls[1].value, card.controls[1].options.length], [null, 4]);
    assert.equal(qa.find((a) => a.id === `heat:${wz}:boost`).title, 'Boost beenden');
    now = T(0, 7, 12);
    assert.equal((await host.quickActions(ADA)).find((a) => a.id === `heat:${wz}`).widget.status, 'Boost · noch 18 min, danach Komfort 21,0 °C');
    await host.runQuickAction(ADA, `heat:${wz}:boost`);
    assert.deepEqual(sent.splice(0), [['01', { setpoint: 21 }], ['02', { setpoint: 21 }]]);
    // a tap on the card answers with it as it is now
    r = await host.runQuickAction(ADA, `heat:${wz}`);
    assert.deepEqual([r.status, r.body.ok, r.body.widget.value], [200, true, 20.6]);
    assert.equal((await host.runQuickAction(BOB, `heat:${wz}`)).status, 404, 'not listed for Bob');
    assert.deepEqual(await heating.runQuickAction(host.gc, { ...BOB, portal: true, loggedIn: true }, 'de', `heat:${wz}`, 'sp', 21), { ok: false, message: 'Dieses Gerät gehört dir nicht.' });
  }));

  it('window open or no thermostat answering: the controls are locked (disabled), the card says why', () => withRooms([TRV(1), CONTACT()], async (host, { set, st, sync, sent }) => {
    await set('Heizkörper 1', 'Schlafzimmer', [ADA.id]);
    await set('Fensterkontakt Terrasse', 'Schlafzimmer');
    const sz = await roomId(host, 'Schlafzimmer');
    await asAdmin(host, 'POST', '/heating/plans', { name: 'Schlafen', week: WEEK, rooms: [sz] });
    st.devices[1].values = { window: true };
    await sync();
    await heating.tick(host.gc);
    now = T(0, 7, 2);
    await heating.tick(host.gc);
    let qa = await host.quickActions(ADA);
    let w = qa.find((a) => a.id === `heat:${sz}`).widget;
    assert.deepEqual([w.state, w.status], ['warn', 'Fenster offen: Frostschutz, danach Komfort 21,0 °C']);
    assert.deepEqual(w.controls.map((c) => [c.id, c.disabled, c.value]), [['sp', true, 7], ['preset', true, null]], 'greyed out, not left away; Frost by the window is no preset choice');
    sent.splice(0);
    let r = await host.runQuickAction(ADA, `heat:${sz}`, 'de', { control: 'sp', value: 21 });
    assert.deepEqual([r.status, r.body.error, sent.length], [409, 'control_disabled', 0], 'the host refuses it');
    r = await host.runQuickAction(ADA, `heat:${sz}`, 'de', { control: 'preset', value: 'comfort' });
    assert.deepEqual([r.status, r.body.error], [409, 'control_disabled']);
    assert.equal(w.timeline.segments.length, 5, 'the day bar stays');
    assert.deepEqual(w.readings.find((x) => x.id === 'window'), { id: 'window', label: 'Fenster', value: 'offen', unit: null, icon: heating.ICONS.window, state: 'warn' });
    assert.deepEqual(qa.map((a) => a.id), [`heat:${sz}`], 'no boost, no plan button');
    st.devices[1].values = { window: false };
    st.devices[0].online = false;
    await sync();
    now = T(0, 7, 5);
    await heating.tick(host.gc);
    qa = await host.quickActions(ADA, 'en');
    w = qa[0].widget;
    assert.deepEqual([w.state, w.controls.map((c) => c.disabled)], ['warn', [true, true]]);
    assert.match(w.status, /^Unreachable · last 20\.0 °C/, "what the thermostat reported last");
  }));

  it('"Heizung abwesend": a toggle for administrators with target states — the rules of Familie switch it with state', () => withRooms([TRV(1)], async (host, { set, sent }) => {
    await set('Heizkörper 1', 'Wohnzimmer', [ADA.id]);
    const wz = await roomId(host, 'Wohnzimmer');
    await asAdmin(host, 'POST', '/heating/plans', { name: 'Familie Werktag', week: WEEK, rooms: [wz] });
    sent.splice(0);
    assert.ok(!(await host.quickActions(ADA)).some((a) => a.id === 'heat:away'));
    const away = (await host.quickActions(ADMIN)).find((a) => a.id === 'heat:away');
    assert.deepEqual([away.kind, away.state, away.targets, away.verbs, away.title], ['toggle', 'off', true, { on: 'Abwesend', off: 'Zu Hause' }, 'Heizung abwesend']);
    let r = await host.runQuickAction(ADMIN, 'heat:away', 'de', { automation: true, via: 'gatecontrol-family', state: 'on' });
    assert.deepEqual([r.status, r.body.state, r.body.message], [200, 'on', 'Heizung abwesend: Komfort wird zu Eco']);
    assert.deepEqual(sent.splice(0), [['01', { setpoint: 18 }]]);
    r = await host.runQuickAction(ADMIN, 'heat:away', 'de', { automation: true, via: 'gatecontrol-family', state: 'on' });
    assert.deepEqual([r.body.state, sent.length], ['on', 0], 'already there: nothing sent again');
    assert.equal((await host.quickActions(ADA)).find((a) => a.id === `heat:${wz}`).widget.status, 'Eco · abwesend bis 22:30, dann Nacht 17,0 °C');
    r = await host.runQuickAction(ADMIN, 'heat:away', 'de', { state: 'off' });
    assert.deepEqual([r.body.state, sent.splice(0)], ['off', [['01', { setpoint: 21 }]]]);
    r = await host.runQuickAction(ADMIN, 'heat:away');
    assert.equal(r.body.state, 'on', 'a plain run switches over');
    assert.equal((await heating.runQuickAction(host.gc, { ...ADA, portal: true, loggedIn: true }, 'de', 'heat:away')).ok, false);
  }));
});

describe('Heizung: the day bar of the card (timelineOf)', () => {
  const P = ['comfort', 'eco', 'night', 'frost'];
  const C = heating.SEGMENT_COLORS;
  it('a segment per preset or target, gaps where nothing applies, colours as #rrggbb, now in hours', () => {
    const tl = heating.timelineOf({ now_min: 450, today: [
      { from: 0, to: 360, kind: 'plan', preset: 'night' }, { from: 360, to: 600, kind: 'none', preset: null, setpoint: null },
      { from: 600, to: 1440, kind: 'manual', preset: null, setpoint: 19.5 },
    ] }, 'de');
    assert.deepEqual(tl, { from: 0, to: 24, now: 7.5, segments: [{ from: 0, to: 6, color: C.night, label: 'Nacht' }, { from: 10, to: 24, color: C.setpoint, label: '19,5 °C' }] });
    for (const c of Object.values(C)) assert.match(c, /^#[0-9a-f]{6}$/);
    assert.equal(heating.timelineOf({ now_min: 0, today: [{ from: 0, to: 1440, kind: 'none' }] }, 'de'), null, 'nothing applies: no bar');
    assert.equal(heating.timelineOf({ today: [] }, 'de'), null);
    assert.equal(heating.timelineOf({ now_min: 1500, today: [{ from: 0, to: 1500, kind: 'plan', preset: 'eco' }] }, 'en').to, 25, 'the day the clocks go back');
  });

  it('more than 12 segments: the shortest neighbours merge, the bar stays whole and in order', () => {
    // 16 segments: 15 of 90 minutes and the shortest pairs at the start (30 minutes each)
    const today = [];
    let at = 0;
    for (let i = 0; i < 16; i++) { const len = i < 2 ? 30 : (i === 15 ? 1440 - at : 90); today.push({ from: at, to: at + len, kind: 'plan', preset: P[i % 4] }); at += len; }
    const tl = heating.timelineOf({ now_min: 0, today }, 'en');
    assert.equal(tl.segments.length, 12);
    let end = 0;
    for (const x of tl.segments) { assert.equal(x.from, end); assert.ok(x.from < x.to); end = x.to; }
    assert.equal(end, 24);
    // 0–0:30 and 0:30–1:00 first (one hour), then that hour with 1:00–2:30 (shorter than two of 90 minutes): Night names it
    assert.deepEqual(tl.segments[0], { from: 0, to: 2.5, color: C.night, label: 'Night' }, 'the shortest neighbours became one');
  });
});
