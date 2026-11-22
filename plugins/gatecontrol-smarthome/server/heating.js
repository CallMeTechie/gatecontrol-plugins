'use strict';

// Heizung (since 1.14.0, the approved draft "Thermostate"): rooms, four fixed presets, weekly plans, boost, window open,
// holiday and "Heizung abwesend" — for the thermostats of zigbee2mqtt (gc.radio) and deCONZ (ZHAThermostat). Everything
// runs in the server part: the plugin's background run (about every 30 s) works out what each room should have now and
// sends it to its thermostats when that changed. Thermostats keep the last target while the server is away; a switching
// point that passed meanwhile is caught up with the next run (the target of "now" is sent).
//
//   room       the area ("Bereich") of its thermostats; a thermostat without one is a room of its own. One target for
//              all thermostats of a room. Window contacts (sensors open / closed) of the same area belong to it.
//   presets    comfort | eco | night | frost — temperatures of the house (heat_house), a plan or a room may have its own.
//   plan       seven days of sections (only presets, 15-minute grid); one plan per room.
//   by hand    a target or a preset set by a person holds until the next switching point; "Betrieb: Von Hand" holds
//              for good, "Aus" switches the room off (mode off where a thermostat has it, else Frostschutz).
//   boost      15 / 30 / 60 minutes: a thermostat that can do it itself (deCONZ preset "boost", zigbee2mqtt boost when
//              the gateway reports it) does, any other gets 30 °C; afterwards back to what applies then.
//   window     a contact of the room open longer than 1 / 2 / 5 minutes (the plan's setting, 2 without a plan) →
//              Frostschutz; closed again → back to what applies then.
//   holiday    for the whole house: from – return, a preset per room (default Eco), the plans again `preheat_h` hours
//              before the return. Ahead of the plans and of "Von Hand".
//   away       "Heizung abwesend" (a toggle of the apps that the rules of Familie may switch): Komfort becomes Eco in
//              the rooms of every plan that allows it.
//
// What wins, top first: Aus · Fenster offen · Boost · by hand (until the next switching point) · holiday · Von Hand ·
// plan (with away) · the kept target of a room without a plan · nothing.
//
// A thermostat with a plan of its own (zigbee2mqtt / deCONZ mode "auto", deCONZ preset "auto", deCONZ schedule_on) is
// set to "manual" when the plan sends to it, so two plans do not work against each other; its plan stays in the device.
//
// Since 1.17.0 the plan runs on a GateControl gateway for a room whose thermostats all hang on that gateway (Shelly TRV,
// Shelly BLU TRV through a BLU Gateway Gen3; at most 8 per room, 24 rooms per gateway): `room.edge` = the gateway. Who
// sends: for such a room ONLY the gateway (edge/heat.js) — with the server and without it; this part never sends to
// its thermostats, it hands the gateway what the room needs (edgeConfig: the plan with its temperatures, holiday,
// "Heizung abwesend", Aus / Von Hand, by hand, boost, window, the time zone) with the configuration
// (server/edge.js configureGateway) whenever that changes (pushEdge). A server that comes back sends nothing twice. A
// lowered window reaches the gateway with `ttl` (2 h, renewed while it stays open): a gateway that no longer hears
// the server goes back to the plan then. Every other room (zigbee2mqtt, deCONZ, a TRV together with them or with
// thermostats of another gateway) runs here as before; a Shelly / BLU TRV in it gets its commands through its gateway.
//
// Since 1.18.0 zigbee2mqtt thermostats count for that too — the zigbee2mqtt of a GateControl gateway (capabilities.
// gateway_id), but only while the optional capability zigbee2mqtt/# is confirmed for that gateway (gc.edge.capabilities,
// as the chains of 1.15.0; looked at at most once a minute) and the gateway does not refuse it (event `z2m` denied —
// an older gateway): a room whose thermostats are all Shelly / BLU TRV and / or zigbee2mqtt thermostats of the same
// gateway runs there (same limits). Without the confirmation, with deCONZ or with another gateway the room stays here.
// edge.capabilities do not change; nothing is asked for (zigbee2mqtt/# is asked for by the chains only). The hand-over
// is the one of 1.17.0: from the moment the room is the gateway's this part sends nothing to it, the gateway sends only
// what a thermostat does not report yet — a target the server already sent is not sent again.

const store = require('./store');
const battery = require('./battery');
const texts = require('./texts.json');
const { codeError } = require('./deconz');

const PRESETS = Object.freeze(['comfort', 'eco', 'night', 'frost']);
const HOUSE_DEFAULT = Object.freeze({ comfort: 21, eco: 18, night: 17, frost: 7 });
const SP_MIN = 5;
const SP_MAX = 30;
const BOOST_MINUTES = Object.freeze([15, 30, 60]);
const BOOST_SETPOINT = 30;
const WINDOW_MINUTES = Object.freeze([1, 2, 5]);
const WINDOW_DEFAULT = 2;
const PREHEAT_DEFAULT = 4;
const PREHEAT_MAX = 24;
const VACATION_MAX_DAYS = 366;
const RETRY_MS = 5 * 60000;
const DAY_MIN = 1440;
const GRID = 15;
const SECTIONS_MAX = 12;
const MODES = Object.freeze(['plan', 'manual', 'off']);
const NAME_MAX = 40;
const PLANS_MAX = 50;
const HOUR = 3600000;
const WINDOW_TTL = 2 * HOUR;        // a lowered window on a gateway: valid for so long without news from the server
const WINDOW_RENEW = HOUR;          // … and renewed when less is left
const EDGE_ROOMS_MAX = 24;          // rooms per gateway (edge/heat.js takes 32; the configuration stays small)
const EDGE_TH_MAX = 8;              // thermostats per room on a gateway
const EDGE_RETRY_MS = 5 * 60000;    // a configuration the gateway did not take: tried again (and with $online)
const Z2M_CHECK_MS = 60000;         // whether zigbee2mqtt/# is confirmed for a gateway: asked at most so often
const Z2M_EDGE_MODES = Object.freeze(['off', 'heat', 'auto']);

// the clock of the plan (tests replace it: _setClock)
let clock = () => Date.now();
// thermostat → when a command that failed may be tried again (memory only: a restart tries at once)
const retryAt = new Map();

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (v) => Math.round(v * 10) / 10;
const half = (v) => Math.round(v * 2) / 2;

function t(lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

function parse(s) {
  if (typeof s !== 'string' || !s) return null;
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

const invalid = (detail) => Object.assign(codeError('SMARTHOME_HEAT_INVALID'), { detail });

// ─── Presets and plans (pure) ───────────────────

/** A temperature of a preset: 5–30 °C in half degrees, else null. */
function temp(v) {
  const n = typeof v === 'string' && /^\d{1,2}([.,]\d)?$/.test(v) ? Number(v.replace(',', '.')) : finite(v);
  if (n == null || n < SP_MIN || n > SP_MAX) return null;
  return half(n);
}

/** Own temperatures { comfort?, eco?, night?, frost? } — only valid ones; `strict` throws on an invalid one. */
function presetsOf(raw, strict) {
  const out = {};
  if (raw == null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) { if (strict) throw invalid('presets'); return out; }
  for (const p of PRESETS) {
    if (raw[p] == null || raw[p] === '') continue;
    const v = temp(raw[p]);
    if (v == null) { if (strict) throw invalid('preset_' + p); continue; }
    out[p] = v;
  }
  return out;
}

/** A day of a plan → [[start minute, preset], …] (first at 0, ascending, 15-minute grid, equal neighbours merged). */
function normalizeDay(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > SECTIONS_MAX * 2) throw invalid('day');
  const out = [];
  for (const s of raw) {
    let start;
    let preset;
    if (Array.isArray(s)) [start, preset] = s;
    else if (s && typeof s === 'object') ({ from: start, preset } = s);
    if (typeof start === 'string' && /^\d{2}:\d{2}$/.test(start)) start = Number(start.slice(0, 2)) * 60 + Number(start.slice(3));
    if (!Number.isInteger(start) || start < 0 || start >= DAY_MIN || start % GRID !== 0 || !PRESETS.includes(preset)) throw invalid('section');
    if (out.length && start <= out[out.length - 1][0]) throw invalid('order');
    if (!out.length && start !== 0) throw invalid('start');
    if (out.length && out[out.length - 1][1] === preset) continue;
    out.push([start, preset]);
  }
  if (out.length > SECTIONS_MAX) throw invalid('sections');
  return out;
}

/** A week: seven days, Monday first. */
function normalizeWeek(raw) {
  if (!Array.isArray(raw) || raw.length !== 7) throw invalid('week');
  return raw.map(normalizeDay);
}

/** Monday = 0 … Sunday = 6 (local time of the server, as the plan). */
const dow = (d) => (d.getDay() + 6) % 7;
const minuteOf = (d) => d.getHours() * 60 + d.getMinutes();

/** The preset of a plan at a time. */
function presetAt(week, at) {
  const d = new Date(at);
  const day = week[dow(d)];
  const m = minuteOf(d);
  let p = day[0][1];
  for (const [s, pr] of day) if (s <= m) p = pr;
  return p;
}

/** The sections of one day of a plan: [{ from, to (minutes), preset }]. */
function sectionsOf(week, day) {
  const list = week[day] || [];
  return list.map(([s, p], i) => ({ from: s, to: i + 1 < list.length ? list[i + 1][0] : DAY_MIN, preset: p }));
}

/**
 * The real switching points of a plan around a time (where the preset changes; midnight with the same preset is
 * none): [{ at (ms), preset }] over the eight days before and after.
 */
function changesOf(week, at) {
  const d = new Date(at);
  const out = [];
  let prev = null;
  for (let k = -8; k <= 8; k++) {
    const base = new Date(d.getFullYear(), d.getMonth(), d.getDate() + k);
    for (const [s, p] of week[dow(base)]) {
      if (p === prev) continue;
      out.push({ at: new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, s).getTime(), preset: p });
      prev = p;
    }
  }
  return out;
}

/** When the section of the plan that applies at `at` began (−1: the plan has one preset only). */
function slotStart(week, at) {
  let start = -1;
  for (const c of changesOf(week, at)) if (c.at <= at) start = c.at;
  return start;
}

// ─── Holiday ─────────────────────────────────────

function vacationOf(raw) {
  const v = raw && typeof raw === 'object' ? raw : null;
  if (!v) return null;
  const from = Date.parse(v.from);
  const to = Date.parse(v.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const h = finite(v.preheat_h);
  const rooms = {};
  for (const [k, p] of Object.entries(v.rooms && typeof v.rooms === 'object' ? v.rooms : {})) if (/^[1-9]\d{0,9}$/.test(k) && PRESETS.includes(p)) rooms[k] = p;
  return { from, to, preheat_h: h != null && h >= 0 && h <= PREHEAT_MAX ? h : PREHEAT_DEFAULT, preset: PRESETS.includes(v.preset) ? v.preset : 'eco', rooms };
}

/** The end of the holiday's own targets (the return minus the preheating). */
const vacationEnd = (vac) => vac.to - vac.preheat_h * HOUR;
const vacationActive = (vac, at) => !!vac && at >= vac.from && at < vacationEnd(vac);

// ─── What a room should have (pure) ──────────────

/** The temperatures of a room: the house's, the plan's, the room's own over it. */
function presetTemps(room, plan, house) {
  return { ...HOUSE_DEFAULT, ...(house.presets || {}), ...((plan && plan.presets) || {}), ...(room.presets || {}) };
}

const planOf = (room, ctx) => (room.plan_id && ctx.plans.get(room.plan_id)) || null;

/** What applies in a room at `at` without anything by hand, boost or window: { kind, preset?, setpoint?, away? }. */
function baseAt(room, ctx, at) {
  const plan = planOf(room, ctx);
  const temps = presetTemps(room, plan, ctx.house);
  const vac = ctx.house.vacation;
  if (vacationActive(vac, at)) {
    const p = vac.rooms[String(room.id)] || vac.preset;
    return { kind: 'vacation', preset: p, setpoint: temps[p] };
  }
  if (room.mode === 'manual' && room.manual != null) return { kind: 'manual', setpoint: room.manual };
  if (plan) {
    let p = presetAt(plan.week, at);
    const away = !!ctx.house.away && plan.away && p === 'comfort';
    if (away) p = 'eco';
    return { kind: 'plan', preset: p, setpoint: temps[p], away };
  }
  if (room.hold != null) return { kind: 'hold', setpoint: room.hold };
  return { kind: 'none' };
}

const sameBase = (a, b) => a.kind === b.kind && a.preset === b.preset && a.setpoint === b.setpoint;

/** The next switching point of a room after `at` (the plan, the holiday's start or its end): { at, … base } or null. */
function nextChange(room, ctx, at) {
  const plan = planOf(room, ctx);
  const vac = ctx.house.vacation;
  const cands = [];
  if (plan && room.mode !== 'manual') for (const c of changesOf(plan.week, at)) cands.push(c.at);
  if (vac) cands.push(vac.from, vacationEnd(vac));
  const now = baseAt(room, ctx, at);
  for (const c of [...new Set(cands)].filter((x) => x > at).sort((a, b) => a - b)) {
    const b = baseAt(room, ctx, c);
    if (!sameBase(b, now)) return { at: c, ...b };
  }
  return null;
}

const active = (x, at) => !!x && (x.until == null || x.until > at);

/**
 * What a room should have now: { kind, preset?, setpoint?, until?, sig } — sig names it (what was sent last is
 * compared with it; a new switching point with the same preset is a new one, too). kind none: nothing to send.
 */
function decide(room, ctx, at) {
  if (room.mode === 'off') return { kind: 'off', sig: 'off' };
  const plan = planOf(room, ctx);
  const temps = presetTemps(room, plan, ctx.house);
  if (room.window && room.window.lowered) return { kind: 'window', preset: 'frost', setpoint: temps.frost, sig: `window:${room.window.since}:${temps.frost}` };
  if (active(room.boost, at)) return { kind: 'boost', until: room.boost.until, minutes: room.boost.minutes, sig: `boost:${room.boost.at}` };
  if (active(room.override, at)) {
    const o = room.override;
    const sp = o.preset ? temps[o.preset] : o.setpoint;
    return { kind: 'override', preset: o.preset || null, setpoint: sp, until: o.until, sig: `override:${o.at}:${sp}` };
  }
  const b = baseAt(room, ctx, at);
  if (b.kind === 'vacation') return { ...b, sig: `vacation:${ctx.house.vacation.from}:${b.preset}:${b.setpoint}` };
  if (b.kind === 'manual') return { ...b, sig: `manual:${b.setpoint}` };
  if (b.kind === 'plan') return { ...b, sig: `plan:${slotStart(plan.week, at)}:${b.preset}:${b.setpoint}` };
  if (b.kind === 'hold') return { ...b, sig: `hold:${b.setpoint}` };
  return { kind: 'none', sig: null };
}

/** The timeline of today (00:00–24:00) without anything by hand: [{ from, to (minutes), kind, preset?, setpoint? }]. */
function todayOf(room, ctx, at) {
  const d = new Date(at);
  const day0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const day1 = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  const plan = planOf(room, ctx);
  const cuts = new Set([day0, day1]);
  if (plan && room.mode !== 'manual') for (const c of changesOf(plan.week, at)) if (c.at > day0 && c.at < day1) cuts.add(c.at);
  const vac = ctx.house.vacation;
  if (vac) for (const c of [vac.from, vacationEnd(vac)]) if (c > day0 && c < day1) cuts.add(c);
  const list = [...cuts].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < list.length; i++) {
    const b = baseAt(room, ctx, list[i]);
    const from = Math.round((list[i] - day0) / 60000);
    const to = Math.round((list[i + 1] - day0) / 60000);
    const last = out[out.length - 1];
    if (last && sameBase(last, b)) { last.to = to; continue; }
    out.push({ from, to, kind: b.kind, preset: b.preset || null, setpoint: b.setpoint == null ? null : b.setpoint });
  }
  return out;
}

// ─── Thermostats (what a command looks like) ─────

const limitsOf = (r) => {
  const s = (r.capabilities && r.capabilities.setpoint) || {};
  const min = finite(s.min) == null ? SP_MIN : s.min;
  const max = finite(s.max) == null ? SP_MAX : s.max;
  return { min, max, step: finite(s.step) || 0.5 };
};
const isDeconz = (r) => r.deconz_type === 'sensors';
const isEdge = (r) => r.deconz_type === 'edge';
const isZ2m = (r) => r.deconz_type === 'z2m';
const Z2M_HEX_RE = /^z2m:([0-9a-f]{16})$/;
/** The thermostat does boost itself: deCONZ with a preset (Tuya and others), zigbee2mqtt when the gateway reports it. */
const deviceBoost = (r) => !!(r.capabilities && (isDeconz(r) ? r.capabilities.preset === true : r.capabilities.boost === true));
/** The thermostat runs a plan of its own. */
function ownSchedule(r) {
  const st = r.state || {};
  const modes = (r.capabilities && r.capabilities.modes) || [];
  if (st.mode === 'auto' && modes.includes('heat')) return true;
  if (isDeconz(r) && (st.preset === 'auto' || st.schedule_on === true)) return true;
  if (isEdge(r) && st.schedule_on === true) return true; // Shelly TRV: its own plan is on
  return false;
}

/** The command for one thermostat: { setpoint?, mode?, preset?, boost?, schedule_on? } (empty: nothing to send). */
function commandFor(r, want, prev, planned) {
  const caps = r.capabilities || {};
  const st = r.state || {};
  const modes = Array.isArray(caps.modes) ? caps.modes : [];
  const lim = limitsOf(r);
  const clamp = (v) => Math.max(lim.min, Math.min(lim.max, v));
  const cmd = {};
  if (want.kind === 'off') {
    if (modes.includes('off')) cmd.mode = 'off';
    else cmd.setpoint = clamp(want.frost);
    return cmd;
  }
  if (prev.kind === 'off' && modes.includes('off')) {
    const before = prev.modes && prev.modes[String(r.id)];
    cmd.mode = before && before !== 'off' && modes.includes(before) ? before : (modes.includes('heat') ? 'heat' : modes.find((m) => m !== 'off'));
  }
  if (want.kind === 'boost') {
    if (deviceBoost(r)) {
      if (isDeconz(r)) cmd.preset = 'boost';
      else cmd.boost = true;
      if (isEdge(r)) cmd.boost_minutes = Math.max(1, Math.ceil(((want.until || 0) - clock()) / 60000));
    } else cmd.setpoint = clamp(BOOST_SETPOINT);
  } else {
    cmd.setpoint = clamp(want.setpoint);
    if (prev.kind === 'boost' && deviceBoost(r)) { if (isDeconz(r)) cmd.preset = 'manual'; else cmd.boost = false; }
  }
  if (planned && ownSchedule(r)) {
    if (isDeconz(r) && st.preset === 'auto' && !cmd.preset) cmd.preset = 'manual';
    if ((isDeconz(r) || isEdge(r)) && st.schedule_on === true) cmd.schedule_on = false;
    if (st.mode === 'auto' && modes.includes('heat') && !cmd.mode) cmd.mode = 'heat';
  }
  if (cmd.mode == null) delete cmd.mode;
  return cmd;
}

// ─── Database ───────────────────────────────────

const roomKeyOf = (r) => (r.area ? `a:${r.area}` : `t:${r.id}`);

function rowToPlan(row) {
  let week = null;
  try { week = normalizeWeek(parse(row.week_json)); } catch { week = Array.from({ length: 7 }, () => [[0, 'eco']]); }
  return {
    id: row.id, name: row.name, week, presets: presetsOf(parse(row.presets_json)),
    window: { on: row.window_on !== 0, min: WINDOW_MINUTES.includes(row.window_min) ? row.window_min : WINDOW_DEFAULT }, away: row.away !== 0,
  };
}

function rowToRoom(row) {
  const num = (v) => (v == null ? null : Number(v));
  return {
    id: row.id, key: row.room_key, plan_id: row.plan_id || null, mode: MODES.includes(row.mode) ? row.mode : 'plan',
    presets: presetsOf(parse(row.presets_json)), max_setpoint: num(row.max_setpoint), hold: num(row.hold), manual: num(row.manual),
    override: parse(row.override_json), boost: parse(row.boost_json), window: parse(row.window_json), applied: parse(row.applied_json) || {},
  };
}

async function houseOf(gc) {
  const row = (await gc.db.get('SELECT * FROM heat_house WHERE id = 1')).row || {};
  return { presets: presetsOf(parse(row.presets_json)), away: row.away === 1, vacation: vacationOf(parse(row.vacation_json)) };
}

async function plansOf(gc) {
  return new Map((await gc.db.query('SELECT * FROM heat_plans ORDER BY name, id')).rows.map((r) => { const p = rowToPlan(r); return [p.id, p]; }));
}

/**
 * Everything the plan needs, read once: { house, plans, rooms } — the rooms with their thermostats, window contacts
 * and a humidity value of the area. A room seen for the first time gets its row here.
 */
async function load(gc) {
  const all = (await store.listResources(gc)).filter((r) => r.enabled);
  const thermos = all.filter((r) => r.kind === 'thermostat');
  const byKey = new Map();
  for (const r of thermos) {
    const k = roomKeyOf(r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  let rows = (await gc.db.query('SELECT * FROM heat_rooms')).rows;
  const known = new Set(rows.map((r) => r.room_key));
  const missing = [...byKey.keys()].filter((k) => !known.has(k));
  if (missing.length) {
    for (const k of missing) await gc.db.run('INSERT OR IGNORE INTO heat_rooms (room_key) VALUES (?)', [k]);
    rows = (await gc.db.query('SELECT * FROM heat_rooms')).rows;
  }
  const rooms = [];
  for (const row of rows) {
    const list = byKey.get(row.room_key);
    if (!list) continue;
    const room = rowToRoom(row);
    const area = row.room_key.startsWith('a:') ? row.room_key.slice(2) : null;
    room.area = area;
    room.name = area || list[0].name || '';
    room.thermostats = list.sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.id - b.id);
    room.contacts = area ? all.filter((r) => r.kind === 'sensor' && r.area === area && r.state && r.state.type === 'open') : [];
    const hum = area ? all.find((r) => r.kind === 'sensor' && r.area === area && r.state && (r.state.type === 'humidity' || (r.state.type === 'temperature' && r.state.humidity != null)) && r.state.reachable !== false) : null;
    room.humidity = hum ? finite(Number(hum.state.type === 'humidity' ? hum.state.value : hum.state.humidity)) : null;
    room.edge = edgeGatewayOf(room.thermostats);
    rooms.push(room);
  }
  // zigbee2mqtt on the gateway only while zigbee2mqtt/# is confirmed there (else the room stays here, as before 1.18.0)
  for (const room of rooms) {
    if (room.edge && room.thermostats.some(isZ2m) && !(await z2mOn(gc, room.edge))) room.edge = null;
  }
  rooms.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  // at most 24 rooms per gateway run there (in the order of the rooms' ids); the others stay here
  const perGw = new Map();
  for (const room of [...rooms].sort((a, b) => a.id - b.id)) {
    if (!room.edge) continue;
    const n = (perGw.get(room.edge) || 0) + 1;
    perGw.set(room.edge, n);
    if (n > EDGE_ROOMS_MAX) room.edge = null;
  }
  return { house: await houseOf(gc), plans: await plansOf(gc), rooms };
}

/**
 * The gateway a room's plan runs on: every thermostat a Shelly / BLU TRV or (since 1.18.0) a zigbee2mqtt thermostat of
 * the same gateway (at most 8), else null. Whether zigbee2mqtt/# is confirmed there is load's business (z2mOn).
 */
function edgeGatewayOf(list) {
  if (!list.length || list.length > EDGE_TH_MAX) return null;
  let gw = null;
  for (const r of list) {
    const z2m = isZ2m(r) && Z2M_HEX_RE.test(String(r.deconz_id || ''));
    const id = (isEdge(r) || z2m) && r.capabilities ? Number(r.capabilities.gateway_id) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0 || (gw != null && gw !== id)) return null;
    gw = id;
  }
  return gw;
}

// gateway id → { on, at }: zigbee2mqtt/# confirmed there (memory only; asked again after Z2M_CHECK_MS)
const z2mSeen = new Map();

/**
 * May zigbee2mqtt thermostats of this gateway run there? The edge part runs there (GateControl with optional
 * capabilities), an administrator confirmed zigbee2mqtt/# for it, and the gateway did not refuse the topic.
 */
async function z2mOn(gc, gw) {
  const edgerules = require('./edgerules');
  if (!require('./edge').available(gc) || !edgerules.z2mHost(gc)) return false;
  const m = edgerules._z2mMem.get(Number(gw));
  if (m && m.edge === 'denied') return false;
  const now = clock();
  const seen = z2mSeen.get(Number(gw));
  if (seen && now - seen.at < Z2M_CHECK_MS) return seen.on;
  const on = await edgerules.z2mApproved(gc, gw);
  z2mSeen.set(Number(gw), { on, at: now });
  return on;
}

async function saveRoom(gc, id, patch) {
  const cols = { plan_id: 'plan_id', mode: 'mode', max_setpoint: 'max_setpoint', hold: 'hold', manual: 'manual' };
  const jsonCols = { presets: 'presets_json', override: 'override_json', boost: 'boost_json', window: 'window_json', applied: 'applied_json' };
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (cols[k]) { sets.push(`${cols[k]} = ?`); vals.push(v == null ? null : v); } else if (jsonCols[k]) { sets.push(`${jsonCols[k]} = ?`); vals.push(v == null ? null : JSON.stringify(v)); }
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  await gc.db.run(`UPDATE heat_rooms SET ${sets.join(', ')} WHERE id = ?`, [...vals, Number(id)]);
}

// ─── The plan's run ─────────────────────────────

// one run or change at a time (the background run and a person's change never interleave)
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

/** The window of a room now: what changed is written (a contact opened, the time passed, closed again). */
async function windowStep(gc, room, ctx, now) {
  const plan = planOf(room, ctx);
  const cfg = plan ? plan.window : { on: true, min: WINDOW_DEFAULT };
  const open = cfg.on && room.mode !== 'off' && room.contacts.some((c) => c.state.value === true && c.state.reachable !== false);
  const w = room.window || null;
  if (!open) {
    if (w) { room.window = null; await saveRoom(gc, room.id, { window: null }); }
    return;
  }
  if (!w) {
    room.window = { since: now, lowered: false };
    await saveRoom(gc, room.id, { window: room.window });
    return;
  }
  if (!w.lowered && now - w.since >= cfg.min * 60000) {
    room.window = { ...w, lowered: true, ttl: now + WINDOW_TTL };
    await saveRoom(gc, room.id, { window: room.window });
  } else if (w.lowered && (!(w.ttl > 0) || w.ttl - now < WINDOW_RENEW)) {
    // still open: the gateway of the room hears so (its window ends by itself when the server stays away)
    room.window = { ...w, ttl: now + WINDOW_TTL };
    await saveRoom(gc, room.id, { window: room.window });
  }
}

/** Send what a room should have to its thermostats that did not get it yet. → number of thermostats still waiting. */
async function applyRoom(gc, room, ctx, now) {
  const want = decide(room, ctx, now);
  if (!want.sig) return 0;
  // the room's gateway sends (edge/heat.js), never this part: nothing twice, nothing that contradicts it
  if (room.edge) return edgePending(room, ctx, want);
  if (want.kind === 'off') want.frost = presetTemps(room, planOf(room, ctx), ctx.house).frost;
  const ap = room.applied || {};
  const same = ap.sig === want.sig;
  const prev = same ? (ap.prev || {}) : { kind: ap.kind || null, modes: ap.modes || null };
  const done = new Set(same ? (ap.done || []) : []);
  const modes = want.kind === 'off' ? { ...((same && ap.modes) || {}) } : (ap.modes || null);
  const planned = !!(room.plan_id && ctx.plans.get(room.plan_id)) || vacationActive(ctx.house.vacation, now);
  const service = require('./service');
  let waiting = 0;
  for (const r of room.thermostats) {
    if (done.has(r.id)) continue;
    const key = `${room.id}:${r.id}`;
    if (r.state && r.state.reachable === false) { waiting++; continue; }
    if ((retryAt.get(key) || 0) > now) { waiting++; continue; }
    const cmd = commandFor(r, want, prev, planned);
    if (want.kind === 'off' && !(String(r.id) in modes) && r.state && r.state.mode) modes[String(r.id)] = r.state.mode;
    if (!Object.keys(cmd).length) { done.add(r.id); continue; }
    try {
      await service.setResourceState(gc, r.id, cmd);
      done.add(r.id);
      retryAt.delete(key);
    } catch (e) {
      waiting++;
      retryAt.set(key, now + RETRY_MS);
      gc.log.debug('heating: command failed', r.id, (e && (e.code || e.message)) || e);
    }
  }
  const next = { sig: want.sig, kind: want.kind, done: [...done].sort((a, b) => a - b), prev };
  if (modes && Object.keys(modes).length) next.modes = modes;
  if (JSON.stringify(next) !== JSON.stringify(ap)) {
    room.applied = next;
    await saveRoom(gc, room.id, { applied: next });
  }
  return waiting;
}

/** What ended meanwhile (a change by hand at its switching point, a boost, a holiday that is over) is cleared. */
async function expire(gc, room, ctx, now) {
  const patch = {};
  if (room.override && room.override.until != null && room.override.until <= now) { room.override = null; patch.override = null; }
  if (room.boost && room.boost.until <= now) { room.boost = null; patch.boost = null; }
  if (Object.keys(patch).length) await saveRoom(gc, room.id, patch);
}

/** A room on a gateway: how many of its thermostats do not report what applies yet (unreachable ones included). */
function edgePending(room, ctx, want) {
  if (!want.sig) return 0;
  const frost = presetTemps(room, planOf(room, ctx), ctx.house).frost;
  let n = 0;
  for (const r of room.thermostats) {
    const st = r.state || {};
    if (st.reachable === false) { n++; continue; }
    if (want.kind === 'boost' && isEdge(r) && deviceBoost(r)) continue;
    // a zigbee2mqtt thermostat with system_mode off: Aus is that mode (edge/heat.js)
    if (want.kind === 'off' && isZ2m(r) && ((r.capabilities && r.capabilities.modes) || []).includes('off')) { if (st.mode !== 'off') n++; continue; }
    const lim = limitsOf(r);
    const exp = Math.max(lim.min, Math.min(lim.max, want.kind === 'boost' ? BOOST_SETPOINT : (want.kind === 'off' ? frost : want.setpoint)));
    if (!(finite(st.setpoint) != null && Math.abs(st.setpoint - exp) < 0.05)) n++;
  }
  return n;
}

function timeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

/**
 * What the gateway `gw` runs for its rooms (edge/heat.js): { v, tz, plans: { <id>: week }, rooms } — every week once,
 * only stable values (no "now").
 */
async function edgeConfigFrom(gc, ctx, gw) {
  const devs = new Map((await require('./edgestore').listDevices(gc, gw)).map((d) => [d.id, d]));
  const vac = ctx.house.vacation;
  const rooms = [];
  const plans = {};
  for (const room of ctx.rooms.filter((r) => r.edge === gw).sort((a, b) => a.id - b.id)) {
    const plan = planOf(room, ctx);
    const th = [];
    for (const r of room.thermostats) {
      const lim = limitsOf(r);
      if (isZ2m(r)) {
        // zigbee2mqtt of this gateway: its friendly name (the edge part prefers zigbee2mqtt/bridge/devices), its limits
        // and the modes the plan uses; boost is 30 °C there
        const m = Z2M_HEX_RE.exec(String(r.deconz_id || ''));
        if (!m) continue;
        const modes = Array.isArray(r.capabilities.modes) ? Z2M_EDGE_MODES.filter((x) => r.capabilities.modes.includes(x)) : [];
        th.push({ base: `zigbee2mqtt/0x${m[1]}`, ch: 'thermostat:0', fam: 'z2m', name: r.capabilities.named ? null : (r.name || null), min: lim.min, max: lim.max, step: lim.step, modes, boost: false });
        continue;
      }
      const d = devs.get(Number(r.edge_device_id));
      if (!d) continue;
      th.push({ base: d.base, ch: r.capabilities.ch, fam: d.family, min: lim.min, max: lim.max, boost: deviceBoost(r) });
    }
    if (!th.length) continue;
    const o = room.override;
    if (plan) plans[String(plan.id)] = plan.week;
    rooms.push({
      id: room.id, th, temps: presetTemps(room, plan, ctx.house), plan: plan ? plan.id : null, away: !!(ctx.house.away && plan && plan.away),
      mode: room.mode, manual: room.manual, hold: room.hold,
      vac: vac ? { from: vac.from, end: vacationEnd(vac), preset: vac.rooms[String(room.id)] || vac.preset } : null,
      ov: o && o.until != null ? { at: o.at, until: o.until, ...(o.preset ? { preset: o.preset } : { setpoint: o.setpoint }) } : null,
      boost: room.boost ? { at: room.boost.at, until: room.boost.until, minutes: room.boost.minutes } : null,
      win: room.window && room.window.lowered && room.window.ttl ? { since: room.window.since, ttl: room.window.ttl } : null,
    });
  }
  return { v: 1, tz: timeZone(), plans, rooms };
}

// gateway id → what it got last (JSON) / when a configuration it did not take was tried (memory only: after a start
// of the plugin every gateway with rooms gets it once)
const edgeSent = new Map();
const edgeTried = new Map();
let edgeStarted = false; // the first run after a start looks at every gateway with devices once (a room may have left)

/** server/edge.js configureGateway: the heating part of a gateway's configuration → { cfg, key }. */
async function edgeConfig(gc, gw) {
  const cfg = await edgeConfigFrom(gc, await load(gc), Number(gw));
  return { cfg, key: JSON.stringify(cfg) };
}

function noteSent(gw, key) { edgeSent.set(Number(gw), key); edgeTried.delete(Number(gw)); }
function resetEdge() { edgeSent.clear(); edgeTried.clear(); edgeStarted = false; z2mSeen.clear(); }

/** Every gateway whose rooms changed gets its configuration again (also one whose last room left it). */
async function pushEdge(gc, ctx) {
  const edge = require('./edge');
  if (!edge.available(gc)) return;
  const gws = new Set(ctx.rooms.map((r) => r.edge).filter(Boolean));
  for (const [gw, key] of edgeSent) if (key && JSON.parse(key).rooms.length) gws.add(gw);
  if (!edgeStarted) {
    edgeStarted = true;
    for (const d of await require('./edgestore').listDevices(gc)) gws.add(Number(d.gateway_id));
  }
  const now = clock();
  for (const gw of gws) {
    const key = JSON.stringify(await edgeConfigFrom(gc, ctx, gw));
    if (edgeSent.get(gw) === key) continue;
    const tried = edgeTried.get(gw);
    if (tried && tried.key === key && now - tried.at < EDGE_RETRY_MS) continue;
    edgeTried.set(gw, { key, at: now });
    await edge.configureGateway(gc, gw);
  }
}

/** The background run: every room — window, what ended, then send what changed. */
function tick(gc) {
  return serial(async () => {
    const now = clock();
    const ctx = await load(gc);
    if (ctx.house.vacation && ctx.house.vacation.to <= now) {
      await gc.db.run("UPDATE heat_house SET vacation_json = NULL, updated_at = datetime('now') WHERE id = 1");
      ctx.house.vacation = null;
    }
    for (const room of ctx.rooms) {
      try {
        await windowStep(gc, room, ctx, now);
        await expire(gc, room, ctx, now);
        await applyRoom(gc, room, ctx, now);
      } catch (e) {
        gc.log.warn('heating: room failed', room.id, (e && (e.code || e.message)) || e);
      }
    }
    await pushEdge(gc, ctx).catch((e) => gc.log.warn('heating: gateway configuration failed', (e && (e.code || e.message)) || e));
    return ctx.rooms.length;
  });
}

// ─── Views ──────────────────────────────────────

function mean(list) {
  const v = list.filter((x) => x != null);
  return v.length ? round1(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

/** The limits of a room's target: what every thermostat takes (and for an assigned person the room's upper limit). */
function roomLimits(room, viewer) {
  let min = SP_MIN;
  let max = SP_MAX;
  let step = 0.5;
  for (const r of room.thermostats) {
    const l = limitsOf(r);
    min = Math.max(min, l.min);
    max = Math.min(max, l.max);
    step = Math.max(step, l.step);
  }
  if (!(max > min)) max = min + step;
  const capped = !isAdmin(viewer) && room.max_setpoint != null;
  if (capped) max = Math.max(min + step, Math.min(max, room.max_setpoint));
  return { min, max, step, capped };
}

const isAdmin = (viewer) => !!viewer && viewer.role === 'admin';

/** The view of a room (pages, portal, apps). `viewer`: who asks (the limits of an assigned person). */
function roomView(room, ctx, now, viewer, lowAt) {
  const plan = planOf(room, ctx);
  const temps = presetTemps(room, plan, ctx.house);
  const want = decide(room, ctx, now);
  const ths = room.thermostats.map((r) => {
    const st = r.state || {};
    return {
      id: r.id, name: r.name || '', source: isDeconz(r) ? 'deconz' : (isEdge(r) ? 'shelly' : 'z2m'),
      gateway: isEdge(r) ? ((ctx.edgeNames && ctx.edgeNames.get(Number(r.capabilities && r.capabilities.gateway_id))) || null) : ((r.capabilities && r.capabilities.gateway) || null),
      value: finite(st.value), setpoint: finite(st.setpoint), valve: finite(st.valve), heating: st.heating === true, mode: st.mode || null,
      reachable: st.reachable !== false, lastupdated: st.lastupdated || null, battery: finite(st.battery), lowbattery: st.lowbattery === true,
      battery_level: battery.levelOf(st, lowAt), own_schedule: ownSchedule(r), device_boost: room.edge && isZ2m(r) ? false : deviceBoost(r),
    };
  });
  const reach = ths.filter((x) => x.reachable);
  const lim = roomLimits(room, viewer);
  const devSetpoint = mean(reach.map((x) => x.setpoint));
  const shown = want.kind === 'boost' ? null : (want.setpoint != null ? want.setpoint : devSetpoint);
  const ap = room.applied || {};
  const pending = room.edge ? edgePending(room, ctx, want)
    : (want.sig && ap.sig === want.sig ? room.thermostats.filter((r) => !(ap.done || []).includes(r.id)).length : (want.sig ? room.thermostats.length : 0));
  const next = nextChange(room, ctx, want.kind === 'boost' ? want.until : now);
  const after = want.kind === 'boost' || want.kind === 'window' ? (() => { const r2 = { ...room, boost: null, window: null }; const w = decide(r2, ctx, want.kind === 'boost' ? want.until : now); return w.kind === 'none' ? null : { kind: w.kind, preset: w.preset || null, setpoint: w.setpoint == null ? null : w.setpoint }; })() : null;
  const batts = ths.filter((x) => x.battery != null || x.lowbattery);
  const low = batts.sort((a, b) => (a.battery == null ? -1 : a.battery) - (b.battery == null ? -1 : b.battery))[0] || null;
  const valves = reach.map((x) => x.valve).filter((x) => x != null);
  const d = new Date(now);
  return {
    id: room.id, name: room.name, area: room.area, plan: plan ? { id: plan.id, name: plan.name } : null, mode: room.mode,
    presets: temps, own_presets: room.presets || {}, max_setpoint: room.max_setpoint,
    // no thermostat answers: what they reported last
    actual: reach.length ? mean(reach.map((x) => x.value)) : mean(ths.map((x) => x.value)), actual_count: reach.filter((x) => x.value != null).length,
    setpoint: shown, device_setpoint: devSetpoint, last_setpoint: mean(ths.map((x) => x.setpoint)), limits: lim,
    heating: reach.some((x) => x.heating), valve: valves.length ? Math.max(...valves) : null, humidity: room.humidity,
    battery: low ? { pct: low.battery, level: low.battery_level, flag: low.lowbattery } : null,
    reachable: reach.length === ths.length ? 'all' : (reach.length ? 'some' : 'none'),
    last_seen: ths.map((x) => x.lastupdated).filter(Boolean).sort().pop() || null,
    status: { kind: want.kind, preset: want.preset || null, setpoint: want.setpoint == null ? null : want.setpoint, until: want.until == null ? null : want.until, away: !!want.away },
    next: next ? { at: next.at, kind: next.kind, preset: next.preset || null, setpoint: next.setpoint == null ? null : next.setpoint } : null,
    after,
    boost: want.kind === 'boost' ? { until: want.until, minutes: want.minutes } : null,
    boost_allowed: isAdmin(viewer) || room.max_setpoint == null,
    window: { contacts: room.contacts.map((c) => ({ id: c.id, name: c.name || '', open: c.state.value === true, reachable: c.state.reachable !== false })),
      open: room.contacts.some((c) => c.state.value === true), since: room.window ? room.window.since : null, lowered: !!(room.window && room.window.lowered),
      on: plan ? plan.window.on : true, minutes: plan ? plan.window.min : WINDOW_DEFAULT },
    today: todayOf(room, ctx, now), now_min: minuteOf(d) + d.getSeconds() / 60,
    thermostats: ths, pending,
    // where the plan runs (since 1.17.0): on the room's gateway — also while the server is away — or here
    runs_at: room.edge ? { kind: 'gateway', gateway_id: room.edge, name: (ctx.edgeNames && ctx.edgeNames.get(room.edge)) || null } : { kind: 'server' },
  };
}

function planView(plan, ctx, now) {
  const d = new Date(now);
  return {
    id: plan.id, name: plan.name, week: plan.week, presets: plan.presets, window: plan.window, away: plan.away,
    rooms: ctx.rooms.filter((r) => r.plan_id === plan.id).map((r) => ({ id: r.id, name: r.name })),
    today: sectionsOf(plan.week, dow(d)),
  };
}

function houseView(ctx) {
  const v = ctx.house.vacation;
  return {
    presets: { ...HOUSE_DEFAULT, ...ctx.house.presets }, away: ctx.house.away,
    vacation: v ? { from: new Date(v.from).toISOString(), to: new Date(v.to).toISOString(), preheat_h: v.preheat_h, preset: v.preset, rooms: v.rooms,
      active: vacationActive(v, clock()), resume_at: new Date(vacationEnd(v)).toISOString() } : null,
  };
}

/** Who may see / change a room: an administrator (admin API) every room, a portal viewer those with a thermostat of theirs. */
async function roomsFor(gc, ctx, viewer) {
  if (viewer && viewer.all) return ctx.rooms;
  if (!viewer || !Number.isInteger(viewer.id)) return [];
  const own = new Set(await store.resourcesOwnedBy(gc, viewer.id));
  return ctx.rooms.filter((r) => r.thermostats.some((x) => own.has(x.id)));
}

/** The names of the gateways the plans of rooms run on (ctx.edgeNames), for the pages. */
async function edgeNames(gc, ctx) {
  ctx.edgeNames = new Map();
  if (!ctx.rooms.some((r) => r.edge) || !gc.edge) return;
  try { for (const g of await gc.edge.gateways()) ctx.edgeNames.set(Number(g.id), g.name || null); } catch { /* names only */ }
}

async function lowAtOf(gc) {
  try { return require('./alerts').configOf(await gc.settings.all()).batteryLow; } catch { return 15; }
}

/**
 * The whole picture for a page: { house, rooms, plans, now, admin } (the portal: only the viewer's rooms, no plans);
 * each room with its status line (`status_text`, as the apps show it) in `lang`.
 */
async function overview(gc, viewer, lang) {
  const now = clock();
  const ctx = await load(gc);
  await edgeNames(gc, ctx);
  const lowAt = await lowAtOf(gc);
  const rooms = await roomsFor(gc, ctx, viewer);
  const out = { house: houseView(ctx), rooms: rooms.map((r) => { const v = roomView(r, ctx, now, viewer, lowAt); v.status_text = statusText(v, lang, now); return v; }), now, admin: isAdmin(viewer) };
  if (viewer && viewer.all) {
    out.plans = [...ctx.plans.values()].map((p) => planView(p, ctx, now));
    out.all_rooms = ctx.rooms.map((r) => ({ id: r.id, name: r.name, thermostats: r.thermostats.length, plan_id: r.plan_id, own_schedule: r.thermostats.filter(ownSchedule).map((x) => x.name || '') }));
  } else {
    // the portal: the plan's name and today's sections, never other rooms
    out.plans = [];
  }
  return out;
}

// ─── Changes ────────────────────────────────────

/** The next switching point of a room now (what a change by hand lasts until), or null (it holds for good). */
function untilOf(room, ctx, now) {
  const n = nextChange({ ...room, override: null }, ctx, now);
  return n ? n.at : null;
}

/**
 * A change in one room: { action, … } — setpoint { setpoint }, preset { preset }, boost { minutes }, boost_stop,
 * resume ("Zurück zum Plan"), mode { mode } and skip_today ("Plan heute aussetzen"; both administrators only).
 * viewer: { id, role, all? } — all: the admin API (every room). → the room's view afterwards.
 */
function act(gc, roomId, body, viewer) {
  return serial(async () => {
    const now = clock();
    const ctx = await load(gc);
    const rooms = await roomsFor(gc, ctx, viewer);
    const room = rooms.find((r) => r.id === Number(roomId));
    if (!room) throw codeError(ctx.rooms.some((r) => r.id === Number(roomId)) ? 'SMARTHOME_NOT_OWNER' : 'SMARTHOME_HEAT_ROOM_NOT_FOUND');
    const b = body && typeof body === 'object' ? body : {};
    const admin = isAdmin(viewer);
    const plan = planOf(room, ctx);
    const temps = presetTemps(room, plan, ctx.house);
    const lim = roomLimits(room, viewer);
    const patch = {};
    const until = untilOf(room, ctx, now);
    // a change by hand: until the next switching point; without one (no plan, no holiday) it is the room's target
    const byHand = (sp, preset) => {
      patch.boost = null;
      if (room.mode === 'manual') { patch.manual = sp; patch.override = null; return; }
      if (until == null) { patch.hold = sp; patch.override = null; return; }
      patch.override = preset ? { preset, until, at: now } : { setpoint: sp, until, at: now };
    };
    switch (b.action) {
      case 'setpoint': {
        const v = finite(b.setpoint);
        if (v == null) throw invalid('setpoint');
        if (v > lim.max || v < lim.min) throw codeError(lim.capped && v > lim.max ? 'SMARTHOME_HEAT_LIMIT' : 'SMARTHOME_HEAT_INVALID');
        byHand(Math.max(lim.min, Math.min(lim.max, round1(Math.round(v / lim.step) * lim.step))), null);
        break;
      }
      case 'preset': {
        if (!PRESETS.includes(b.preset)) throw invalid('preset');
        byHand(temps[b.preset], room.mode === 'manual' || until == null ? null : b.preset);
        break;
      }
      case 'boost': {
        const m = Number(b.minutes);
        if (!BOOST_MINUTES.includes(m)) throw invalid('minutes');
        if (!(admin || room.max_setpoint == null)) throw codeError('SMARTHOME_HEAT_LIMIT');
        if (room.mode === 'off') throw codeError('SMARTHOME_HEAT_OFF');
        patch.boost = { until: now + m * 60000, minutes: m, at: now };
        break;
      }
      case 'boost_stop': patch.boost = null; break;
      case 'resume':
        patch.override = null;
        patch.boost = null;
        if (room.mode !== 'plan' && admin) patch.mode = 'plan';
        else if (room.mode === 'manual') throw codeError('FORBIDDEN');
        break;
      case 'mode': {
        if (!admin) throw codeError('FORBIDDEN');
        if (!MODES.includes(b.mode)) throw invalid('mode');
        patch.mode = b.mode;
        patch.override = null;
        if (b.mode !== 'plan') patch.boost = null;
        if (b.mode === 'manual') {
          const cur = decide(room, ctx, now);
          const sp = cur.setpoint != null ? cur.setpoint : (mean(room.thermostats.map((r) => finite((r.state || {}).setpoint))) || temps.comfort);
          patch.manual = Math.max(lim.min, Math.min(lim.max, sp));
        }
        break;
      }
      case 'skip_today': {
        if (!admin) throw codeError('FORBIDDEN');
        if (!plan) throw invalid('no_plan');
        const cur = decide(room, ctx, now);
        const d = new Date(now);
        const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
        patch.override = { setpoint: cur.setpoint != null ? cur.setpoint : temps.eco, until: midnight, at: now };
        patch.boost = null;
        break;
      }
      default: throw invalid('action');
    }
    Object.assign(room, patch);
    await saveRoom(gc, room.id, patch);
    // sent at once — a thermostat that is away or asleep gets it with one of the next runs
    await windowStep(gc, room, ctx, now);
    await applyRoom(gc, room, ctx, now);
    await pushEdge(gc, ctx).catch(() => null);
    await edgeNames(gc, ctx);
    const v = roomView(room, ctx, now, viewer, await lowAtOf(gc));
    v.status_text = statusText(v, viewer && viewer.lang, now);
    return v;
  });
}

/** Administrators: a room's own temperatures and the upper limit for assigned persons. */
function setRoom(gc, roomId, body) {
  return serial(async () => {
    const ctx = await load(gc);
    const room = ctx.rooms.find((r) => r.id === Number(roomId));
    if (!room) throw codeError('SMARTHOME_HEAT_ROOM_NOT_FOUND');
    const b = body && typeof body === 'object' ? body : {};
    const patch = {};
    if ('presets' in b) patch.presets = presetsOf(b.presets, true);
    if ('max_setpoint' in b) {
      if (b.max_setpoint === null || b.max_setpoint === '') patch.max_setpoint = null;
      else { const v = temp(b.max_setpoint); if (v == null) throw invalid('max_setpoint'); patch.max_setpoint = v; }
    }
    if (!Object.keys(patch).length) throw invalid('nothing');
    Object.assign(room, patch);
    await saveRoom(gc, room.id, patch);
    await applyRoom(gc, room, ctx, clock());
    await pushEdge(gc, ctx).catch(() => null);
    return { id: room.id, presets: room.presets, max_setpoint: room.max_setpoint };
  });
}

/** Administrators: the house's temperatures and "Heizung abwesend". → houseView */
function setHouse(gc, body) {
  return serial(async () => {
    const b = body && typeof body === 'object' ? body : {};
    const sets = [];
    const vals = [];
    if ('presets' in b) {
      const p = presetsOf(b.presets, true);
      sets.push('presets_json = ?');
      vals.push(JSON.stringify(p));
    }
    if ('away' in b) {
      if (typeof b.away !== 'boolean') throw invalid('away');
      sets.push('away = ?');
      vals.push(b.away ? 1 : 0);
    }
    if (!sets.length) throw invalid('nothing');
    await gc.db.run(`UPDATE heat_house SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = 1`, vals);
    const ctx = await load(gc);
    const now = clock();
    for (const room of ctx.rooms) await applyRoom(gc, room, ctx, now).catch(() => 0);
    await pushEdge(gc, ctx).catch(() => null);
    return houseView(ctx);
  });
}

/** "Heizung abwesend" now (the toggle of the apps). */
async function awayOf(gc) {
  const row = (await gc.db.get('SELECT away FROM heat_house WHERE id = 1')).row;
  return !!(row && row.away === 1);
}

/** Administrators: the holiday { from, to, preheat_h?, preset?, rooms? } or null (none). */
function setVacation(gc, body) {
  return serial(async () => {
    let json = null;
    if (body != null) {
      const b = typeof body === 'object' ? body : {};
      const from = Date.parse(b.from);
      const to = Date.parse(b.to);
      const now = clock();
      if (!Number.isFinite(from) || !Number.isFinite(to)) throw invalid('dates');
      if (to <= from || to <= now || to - from > VACATION_MAX_DAYS * 24 * HOUR) throw invalid('range');
      const h = b.preheat_h == null ? PREHEAT_DEFAULT : finite(Number(b.preheat_h));
      if (h == null || h < 0 || h > PREHEAT_MAX) throw invalid('preheat');
      if (b.preset != null && !PRESETS.includes(b.preset)) throw invalid('preset');
      const ctx = await load(gc);
      const ids = new Set(ctx.rooms.map((r) => String(r.id)));
      const rooms = {};
      for (const [k, p] of Object.entries(b.rooms && typeof b.rooms === 'object' && !Array.isArray(b.rooms) ? b.rooms : {})) {
        if (!ids.has(String(k))) continue;
        if (!PRESETS.includes(p)) throw invalid('room_preset');
        rooms[String(k)] = p;
      }
      json = JSON.stringify({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), preheat_h: h, preset: b.preset || 'eco', rooms });
    }
    await gc.db.run("UPDATE heat_house SET vacation_json = ?, updated_at = datetime('now') WHERE id = 1", [json]);
    const ctx = await load(gc);
    const now = clock();
    for (const room of ctx.rooms) await applyRoom(gc, room, ctx, now).catch(() => 0);
    await pushEdge(gc, ctx).catch(() => null);
    return houseView(ctx);
  });
}

function cleanName(v) {
  return typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '';
}

/**
 * Administrators: a plan { name, week, presets?, window?: { on, min }, away?, rooms?: [room ids] } — new (id null) or
 * changed. A room chosen here leaves its plan before. → the plan's view
 */
function savePlan(gc, id, body) {
  return serial(async () => {
    const b = body && typeof body === 'object' ? body : {};
    const name = cleanName(b.name);
    if (!name) throw invalid('name');
    const week = normalizeWeek(b.week);
    const presets = presetsOf(b.presets, true);
    const w = b.window && typeof b.window === 'object' ? b.window : {};
    const winOn = w.on !== false;
    const winMin = w.min == null ? WINDOW_DEFAULT : Number(w.min);
    if (!WINDOW_MINUTES.includes(winMin)) throw invalid('window_min');
    const away = b.away !== false;
    let ctx = await load(gc);
    let pid = id == null ? null : Number(id);
    if (pid != null && !ctx.plans.has(pid)) throw codeError('SMARTHOME_HEAT_PLAN_NOT_FOUND');
    const vals = [name, JSON.stringify(week), JSON.stringify(presets), winOn ? 1 : 0, winMin, away ? 1 : 0];
    if (pid == null) {
      if (ctx.plans.size >= PLANS_MAX) throw invalid('too_many');
      const r = await gc.db.run('INSERT INTO heat_plans (name, week_json, presets_json, window_on, window_min, away) VALUES (?, ?, ?, ?, ?, ?)', vals);
      pid = Number(r.lastInsertRowid);
    } else {
      await gc.db.run("UPDATE heat_plans SET name = ?, week_json = ?, presets_json = ?, window_on = ?, window_min = ?, away = ?, updated_at = datetime('now') WHERE id = ?", [...vals, pid]);
    }
    if (Array.isArray(b.rooms)) {
      const want = new Set(b.rooms.map(Number).filter((n) => ctx.rooms.some((r) => r.id === n)));
      for (const r of ctx.rooms) {
        if (want.has(r.id) && r.plan_id !== pid) await saveRoom(gc, r.id, { plan_id: pid, override: null });
        else if (!want.has(r.id) && r.plan_id === pid) await saveRoom(gc, r.id, { plan_id: null, override: null });
      }
    }
    ctx = await load(gc);
    const now = clock();
    for (const room of ctx.rooms) if (room.plan_id === pid) await applyRoom(gc, room, ctx, now).catch(() => 0);
    await pushEdge(gc, ctx).catch(() => null);
    return planView(ctx.plans.get(pid), ctx, now);
  });
}

function deletePlan(gc, id) {
  return serial(async () => {
    const pid = Number(id);
    const before = await load(gc);
    if (!before.plans.has(pid)) throw codeError('SMARTHOME_HEAT_PLAN_NOT_FOUND');
    const now = clock();
    // its rooms keep the target they have now ("kein Plan")
    for (const room of before.rooms.filter((r) => r.plan_id === pid)) {
      const sp = decide(room, before, now).setpoint;
      await saveRoom(gc, room.id, { plan_id: null, override: null, hold: sp == null ? null : sp });
    }
    await gc.db.run('UPDATE heat_rooms SET plan_id = NULL WHERE plan_id = ?', [pid]);
    await gc.db.run('DELETE FROM heat_plans WHERE id = ?', [pid]);
    await pushEdge(gc, await load(gc)).catch(() => null);
    return { ok: true };
  });
}

/** The window contacts of rooms the plan turned down now: Set of 'gateway id:deCONZ id' (the notification's text). */
async function loweredContacts(gc) {
  const out = new Set();
  try {
    const ctx = await load(gc);
    for (const room of ctx.rooms) {
      if (!(room.window && room.window.lowered)) continue;
      for (const c of room.contacts) if (c.deconz_type === 'sensors') out.add(`${c.gateway_id}:${c.deconz_id}`);
    }
  } catch { /* no rooms yet */ }
  return out;
}

// ─── Quick actions of the apps (the host's widget contract) ──

const ICONS = {
  thermo: 'M10 13V5a2 2 0 1 1 4 0v8a4 4 0 1 1-4 0zM12 9v6',
  flame: 'M12 22c4 0 7-2.7 7-7 0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-3 3-5 5.5-5 8 0 4.3 3 7 7 7z',
  window: 'M4 3h16v18H4zM12 3v18M4 12h16',
  drop: 'M12 2.7l5.7 5.6a8 8 0 1 1-11.4 0z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  leaf: 'M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10zM2 21c0-3 1.9-5.4 5.1-6',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  snow: 'M12 2v20M4.9 7l14.2 10M4.9 17L19.1 7M9 4l3 2 3-2M9 20l3-2 3 2',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM12 7v5l3 2',
  away: 'M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1zM16 3l5 5',
  back: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  off: 'M12 3v9M6.3 7.3a8 8 0 1 0 11.4 0',
};
const PRESET_ICONS = { comfort: ICONS.sun, eco: ICONS.leaf, night: ICONS.moon, frost: ICONS.snow };
const QA_HEAT_MAX = 8; // of the 16 quick actions of the plugin: at most 8 for the heating

function clip(v, max) {
  let s = String(v == null ? '' : v).replace(/[\0-\x1f\x7f]/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max).replace(/[\ud800-\udbff]$/, '').trimEnd();
  return s;
}

const num = (v, lang) => Number(v).toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function when(ms, now, lang) {
  const d = new Date(ms);
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return hhmm(ms);
  const date = lang === 'en' ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
  return `${date} ${hhmm(ms)}`;
}
const presetName = (p, lang) => t(lang, 'heat.preset.' + p);
const thenText = (x, lang) => (x ? (x.preset ? `${presetName(x.preset, lang)} ${num(x.setpoint, lang)} °C` : (x.setpoint != null ? `${num(x.setpoint, lang)} °C` : '')) : '');

/** The status line of a room (≤ 60 characters): what applies, until when, what comes after. */
function statusText(v, lang, now) {
  const s = v.status;
  if (v.reachable === 'none') {
    const age = v.last_seen ? battery.ageText(v.last_seen, now, lang) : null;
    const last = v.last_setpoint != null ? `${num(v.last_setpoint, lang)} °C` : '–';
    return clip(age ? t(lang, 'heat.st.unreachable_ago', { last, ago: age }) : t(lang, 'heat.st.unreachable', { last }), 60);
  }
  const next = v.next ? t(lang, 'heat.st.then', { at: when(v.next.at, now, lang), what: thenText(v.next, lang) }) : '';
  let out;
  switch (s.kind) {
    case 'off': out = t(lang, 'heat.st.off'); break;
    case 'window': out = t(lang, 'heat.st.window', { then: v.after ? thenText(v.after, lang) : '–' }); break;
    case 'boost': out = t(lang, 'heat.st.boost', { min: Math.max(1, Math.ceil((s.until - now) / 60000)), then: v.after ? thenText(v.after, lang) : '–' }); break;
    case 'override': out = (s.preset ? presetName(s.preset, lang) + ' · ' : '') + t(lang, 'heat.st.by_hand', { sp: num(s.setpoint, lang) }) + (next ? ' ' + next : ''); break;
    case 'vacation': out = t(lang, 'heat.st.vacation', { what: thenText(s, lang), at: v.next ? when(v.next.at, now, lang) : '–' }); break;
    case 'manual': out = t(lang, 'heat.st.manual', { sp: num(s.setpoint, lang) }); break;
    case 'plan': out = presetName(s.preset, lang) + (s.away ? ' · ' + t(lang, 'heat.st.away') : ' · ' + t(lang, 'heat.st.plan')) + (next ? ' ' + next : ''); break;
    case 'hold': out = t(lang, 'heat.st.hold', { sp: num(s.setpoint, lang) }); break;
    default: out = t(lang, 'heat.st.none');
  }
  if (v.pending && s.kind !== 'none') out = t(lang, 'heat.st.sending') + ' · ' + out;
  return clip(out, 60);
}

/**
 * The preset the choice shows: the one that applies, else null (GateControl ≥ 1.317.1: no option active — boost, a
 * target by hand, window open, off; the status line says what applies).
 */
function choiceOf(v, lang, disabled) {
  const options = PRESETS.map((p) => ({ id: p, label: clip(t(lang, 'heat.preset_short.' + p), 20), icon: PRESET_ICONS[p] }));
  const s = v.status;
  const value = s.preset && PRESETS.includes(s.preset) && s.kind !== 'window' ? s.preset : null;
  return { id: 'preset', kind: 'choice', label: clip(t(lang, 'heat.preset'), 20), value, options, ...(disabled ? { disabled: true } : {}) };
}

// The colours of the presets on the day bar (one each, readable on light and dark cards: at least 3:1 against both).
const SEGMENT_COLORS = Object.freeze({ comfort: '#ea580c', eco: '#16a36a', night: '#5b7cf5', frost: '#2b93b5', setpoint: '#8b6be8' });
const SEGMENTS_MAX = 12; // the host's limit

/**
 * The day bar of a room (GateControl ≥ 1.317.1, display only): today's plan (roomView.today) in hours, a segment per
 * preset or target (by hand, hold), nothing where nothing applies; more than 12 → the shortest neighbours merge (the
 * longer one names the result). null without a segment.
 */
function timelineOf(v, lang) {
  const today = Array.isArray(v.today) ? v.today : [];
  if (!today.length) return null;
  const end = today[today.length - 1].to / 60; // 24 (23 / 25 on the days the clocks change)
  let segs = [];
  for (const x of today) {
    if (x.preset && PRESETS.includes(x.preset)) segs.push({ from: x.from / 60, to: x.to / 60, color: SEGMENT_COLORS[x.preset], label: clip(presetName(x.preset, lang), 20) });
    else if (x.setpoint != null) segs.push({ from: x.from / 60, to: x.to / 60, color: SEGMENT_COLORS.setpoint, label: clip(`${num(x.setpoint, lang)} °C`, 20) });
  }
  segs = segs.filter((x) => x.from < x.to);
  while (segs.length > SEGMENTS_MAX) {
    let best = -1;
    for (let i = 0; i + 1 < segs.length; i++) {
      if (segs[i].to !== segs[i + 1].from) continue;
      if (best < 0 || segs[i + 1].to - segs[i].from < segs[best + 1].to - segs[best].from) best = i;
    }
    if (best < 0) { // only gaps between them: the shortest goes
      let k = 0;
      segs.forEach((x, i) => { if (x.to - x.from < segs[k].to - segs[k].from) k = i; });
      segs.splice(k, 1);
      continue;
    }
    const [a, b] = [segs[best], segs[best + 1]];
    const keep = b.to - b.from > a.to - a.from ? b : a;
    segs.splice(best, 2, { from: a.from, to: b.to, color: keep.color, label: keep.label });
  }
  if (!segs.length) return null;
  const now = Number.isFinite(v.now_min) ? Math.max(0, Math.min(end, v.now_min / 60)) : null;
  return { from: 0, to: end, ...(now == null ? {} : { now }), segments: segs };
}

/** The widget of a room's card. */
function widgetOf(v, lang, now) {
  const st = v.status;
  const w = {
    label: clip(t(lang, 'heat.actual'), 24), value: v.actual == null ? null : v.actual, unit: v.actual == null ? null : '°C',
    status: statusText(v, lang, now), state: null, power: false, readings: [], controls: [],
  };
  if (v.reachable === 'none' || (st.kind === 'window')) w.state = 'warn';
  else if (st.kind === 'off') w.state = 'off';
  else if (v.heating || st.kind === 'boost') w.state = 'on';
  if (v.valve != null) w.badge = { icon: ICONS.flame, value: Math.round(v.valve), unit: '%', label: clip(t(lang, 'heat.valve'), 20), state: null };
  if (v.window.contacts.length) w.readings.push({ id: 'window', label: clip(t(lang, 'heat.window'), 20), icon: ICONS.window, value: clip(t(lang, v.window.open ? 'heat.window_open' : 'heat.window_closed'), 16), state: v.window.open ? 'warn' : 'good' });
  if (v.humidity != null) w.readings.push({ id: 'humidity', label: clip(t(lang, 'heat.humidity'), 20), icon: ICONS.drop, value: Math.round(v.humidity), unit: '%' });
  if (v.battery && (v.battery.pct != null || v.battery.flag)) {
    const r = { id: 'battery', label: clip(t(lang, 'heat.battery'), 20), icon: battery.OUTLINE, state: v.battery.level === 'good' ? null : v.battery.level };
    if (v.battery.pct != null) { r.value = v.battery.pct; r.unit = '%'; } else r.value = clip(t(lang, 'heat.battery_low'), 16);
    w.readings.push(r);
  }
  // locked (GateControl ≥ 1.317.1: shown greyed out, the host refuses runs) while no thermostat answers, the window
  // turned the room down or the room is off — the status line says why
  const locked = v.reachable === 'none' || st.kind === 'window' || st.kind === 'off';
  const lim = v.limits;
  const cur = v.setpoint != null ? v.setpoint : (v.device_setpoint != null ? v.device_setpoint : lim.min);
  w.controls.push({ id: 'sp', kind: 'stepper', label: clip(t(lang, 'heat.target'), 20), value: Math.max(lim.min, Math.min(lim.max, cur)), min: lim.min, max: lim.max, step: 0.5, unit: '°C', ...(locked ? { disabled: true } : {}) });
  w.controls.push(choiceOf(v, lang, locked));
  const tl = st.kind === 'off' ? null : timelineOf(v, lang); // off: no plan applies today
  if (tl) w.timeline = tl;
  return w;
}

/** The quick actions of a viewer's rooms: a card per room, Boost / Zurück zum Plan beside it; "Heizung abwesend". */
async function quickActions(gc, user, lang) {
  if (!user || !Number.isInteger(user.id) || user.loggedIn === false) return [];
  const now = clock();
  const ctx = await load(gc);
  const out = [];
  if (isAdmin(user) && ctx.rooms.length) {
    out.push({ id: 'heat:away', title: clip(t(lang, 'heat.away'), 40), subtitle: clip(t(lang, ctx.house.away ? 'heat.away_on_sub' : 'heat.away_off_sub'), 60), icon: ICONS.away, kind: 'toggle',
      state: ctx.house.away ? 'on' : 'off', verbs: { on: clip(t(lang, 'heat.away_verb_on'), 20), off: clip(t(lang, 'heat.away_verb_off'), 20) }, targets: true,
      device: { id: 'heat:house', title: clip(t(lang, 'heat.title'), 40), icon: ICONS.thermo } });
  }
  const lowAt = await lowAtOf(gc);
  for (const room of (await roomsFor(gc, ctx, user))) {
    const v = roomView(room, ctx, now, user, lowAt);
    const device = { id: `heat:${room.id}`, title: clip(room.name, 40) || clip(t(lang, 'heat.room'), 40), icon: ICONS.thermo };
    const card = { id: `heat:${room.id}`, title: device.title, subtitle: clip(statusText(v, lang, now), 60), icon: ICONS.thermo, kind: 'button', device, widget: widgetOf(v, lang, now) };
    const more = [];
    const usable = v.reachable !== 'none' && v.status.kind !== 'off' && v.status.kind !== 'window';
    if (usable && v.status.kind === 'boost') more.push({ id: `heat:${room.id}:boost`, title: clip(t(lang, 'heat.boost_stop'), 40), subtitle: device.title, icon: ICONS.flame, kind: 'button', device });
    else if (usable && v.boost_allowed) more.push({ id: `heat:${room.id}:boost`, title: clip(t(lang, 'heat.boost_n', { min: 30 }), 40), subtitle: device.title, icon: ICONS.flame, kind: 'button', device });
    if (usable && (v.status.kind === 'override' || v.status.kind === 'boost' || (v.status.kind === 'manual' && isAdmin(user))) && (v.plan || v.status.kind === 'manual')) {
      more.push({ id: `heat:${room.id}:plan`, title: clip(t(lang, 'heat.resume'), 40), subtitle: device.title, icon: ICONS.back, kind: 'button', device });
    }
    if (out.length + 1 + more.length > QA_HEAT_MAX) break;
    out.push(card, ...more);
  }
  return out;
}

const QA_RE = /^heat:([1-9][0-9]{0,9})(?::(boost|plan))?$/;

/** Run one of them (the host passed an id listed for this viewer; checked here again). → { ok, message, widget?, state? } */
async function runQuickAction(gc, user, lang, id, control, value, target) {
  if (!user || !Number.isInteger(user.id) || user.loggedIn === false) return { ok: false, message: t(lang, 'qa.unknown') };
  const now = () => clock();
  if (id === 'heat:away') {
    if (!isAdmin(user) || control !== undefined) return { ok: false, message: t(lang, 'qa.unknown') };
    const on = target === 'on' || target === 'off' ? target === 'on' : !(await awayOf(gc));
    await setHouse(gc, { away: on });
    return { ok: true, message: clip(t(lang, on ? 'heat.away_done_on' : 'heat.away_done_off'), 120), state: on ? 'on' : 'off' };
  }
  const m = QA_RE.exec(String(id || ''));
  if (!m || target !== undefined) return { ok: false, message: t(lang, 'qa.unknown') };
  const roomId = Number(m[1]);
  const viewer = { id: user.id, role: user.role };
  let body = null;
  let message = null;
  if (m[2] === 'boost') {
    if (control !== undefined) return { ok: false, message: t(lang, 'qa.unknown') };
    const cur = (await overview(gc, viewer)).rooms.find((r) => r.id === roomId);
    if (!cur) return { ok: false, message: t(lang, 'qa.unknown') };
    body = cur.status.kind === 'boost' ? { action: 'boost_stop' } : { action: 'boost', minutes: 30 };
    message = t(lang, body.action === 'boost' ? 'heat.boost_done' : 'heat.boost_stopped', { name: clip(cur.name, 40) });
  } else if (m[2] === 'plan') {
    if (control !== undefined) return { ok: false, message: t(lang, 'qa.unknown') };
    body = { action: 'resume' };
  } else if (control === 'sp') {
    // half degrees as the stepper steps (no whole numbers: 21.5 °C stays 21.5 °C)
    const v = typeof value === 'number' && Number.isFinite(value) ? half(value) : NaN;
    if (!Number.isFinite(v)) return { ok: false, message: t(lang, 'qa.unknown') };
    body = { action: 'setpoint', setpoint: v };
  } else if (control === 'preset') {
    if (!PRESETS.includes(value)) return { ok: false, message: t(lang, 'qa.unknown') };
    body = { action: 'preset', preset: value };
  } else if (control !== undefined) return { ok: false, message: t(lang, 'qa.unknown') };
  try {
    const v = body ? await act(gc, roomId, body, viewer) : (await overview(gc, viewer)).rooms.find((r) => r.id === roomId);
    if (!v) return { ok: false, message: t(lang, 'qa.unknown') };
    if (m[2] === 'plan') message = t(lang, 'heat.resumed', { name: clip(v.name, 40) });
    return { ok: true, message: message ? clip(message, 120) : null, widget: widgetOf(v, lang, now()) };
  } catch (e) {
    const code = e && e.code;
    const key = { SMARTHOME_HEAT_LIMIT: 'error.heat_limit', SMARTHOME_NOT_OWNER: 'error.not_owner', FORBIDDEN: 'error.forbidden', SMARTHOME_HEAT_OFF: 'error.heat_off' }[code] || 'qa.unknown';
    if (!['SMARTHOME_HEAT_LIMIT', 'SMARTHOME_NOT_OWNER', 'FORBIDDEN', 'SMARTHOME_HEAT_OFF', 'SMARTHOME_HEAT_INVALID', 'SMARTHOME_HEAT_ROOM_NOT_FOUND'].includes(code)) gc.log.warn('heating quick action failed', id, code || (e && e.message));
    const cur = (await overview(gc, viewer).catch(() => ({ rooms: [] }))).rooms.find((r) => r.id === roomId);
    return { ok: false, message: t(lang, key), ...(cur ? { widget: widgetOf(cur, lang, now()) } : {}) };
  }
}

function _setClock(fn) { clock = typeof fn === 'function' ? fn : () => Date.now(); retryAt.clear(); edgeSent.clear(); edgeTried.clear(); z2mSeen.clear(); }

module.exports = {
  PRESETS, HOUSE_DEFAULT, BOOST_MINUTES, BOOST_SETPOINT, WINDOW_MINUTES, PREHEAT_DEFAULT, ICONS,
  normalizeWeek, presetAt, sectionsOf, changesOf, slotStart, baseAt, decide, nextChange, todayOf, commandFor, ownSchedule, deviceBoost,
  edgeConfig, noteSent, pushEdge, resetEdge, edgeGatewayOf, WINDOW_TTL,
  load, tick, overview, act, setRoom, setHouse, setVacation, savePlan, deletePlan, loweredContacts, awayOf,
  quickActions, runQuickAction, statusText, widgetOf, timelineOf, SEGMENT_COLORS, roomKeyOf, _setClock, now: () => clock(),
};
