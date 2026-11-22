'use strict';

// The heating plan on the gateway (since 1.17.0): the rooms whose thermostats all hang on this gateway (Shelly TRV,
// Shelly BLU TRV through a BLU Gateway Gen3). The server part (server/heating.js edgeConfig) sends what a room needs
// with the configuration (gc.edge.configure { heat }); from then on THIS engine alone sends the targets of these rooms
// — with the server and without it. The server part never sends to them itself, so a server that comes back sends
// nothing twice: it only hands over a new configuration, and what is already applied (the same signature) is not
// sent again.
// Since 1.18.0 also thermostats of the gateway's own zigbee2mqtt (fam 'z2m', base zigbee2mqtt/0x<IEEE address>, channel
// thermostat:0) — only while zigbee2mqtt/# (the optional capability) is confirmed for this gateway: the server part
// hands over such a room only then. Their target goes to zigbee2mqtt/<friendly name>/set with the setpoint the device
// reports (occupied_heating_setpoint or current_heating_setpoint), Aus as system_mode off where the device has it, its own
// plan (system_mode auto) is set to heat when the plan sends, boost is 30 °C (as for a BLU TRV).
// Since 1.19.0 a zigbee2mqtt thermostat whose exposes name a boost of its own (io.z2mBoost(base) → { prop, on, off }:
// a writable binary boost_heating, else boost, with value_on / value_off — edge/index.js boostOf) boosts with it:
// { <prop>: value_on } instead of 30 °C, afterwards { <prop>: value_off } with the target. Without it: 30 °C.
//
//   heat  { v: 1, tz, plans: { <plan id>: week }, rooms: [room] }   week: 7 × [[start minute, preset], …], Monday first
//   room  { id, th: [{ base, ch, fam, min, max, boost, (z2m:) name, step, modes }], temps: { comfort, eco, night, frost },
//           plan: <plan id> | null, away (Komfort → Eco), mode: plan | manual | off,
//           manual, hold, vac: { from, end, preset } | null (end: the return minus the preheating),
//           ov: { at, until, setpoint? , preset? } | null (by hand until the next switching point),
//           boost: { at, until, minutes } | null, win: { since, ttl } | null (window open: Frostschutz until ttl —
//           the server part renews ttl while the window stays open; without it the room goes back to its plan) }
//
// What wins, top first (as server/heating.js decide): Aus · Fenster offen · Boost · by hand · holiday · Von Hand ·
// plan (with away) · the kept target · nothing. The week runs in the time zone of the server part (tz).
//
// Per thermostat: a target is "done" once the device reports it (or after 3 tries 5 minutes apart — a person who
// turns the knob afterwards is not fought); a device that is away (offline, silent for 2 h, BLU not paired) gets it
// as soon as it reports again. What was applied is kept (gc.store via `save`), so a restart sends nothing again.

const commands = require('./commands');
const { clockOf } = require('./rules');

const PRESETS = ['comfort', 'eco', 'night', 'frost'];
const RETRY_MS = 5 * 60000;
const TRIES = 3;
const STALE_MS = 2 * 3600 * 1000;
const BOOST_SETPOINT = 30;
const MAX_ROOMS = 32;
const MAX_TH = 8;
const DAY_MIN = 1440;
const TZ_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;
const CH_RE = /^thermostat:\d{1,2}$/;
const Z2M_MODES = ['off', 'heat', 'auto'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ms = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const temp = (v) => { const n = num(v); return n != null && n >= 4 && n <= 31 ? Math.round(n * 2) / 2 : null; };

function cleanWeek(w) {
  if (!Array.isArray(w) || w.length !== 7) return null;
  const out = [];
  for (const day of w) {
    if (!Array.isArray(day) || !day.length || day.length > 24) return null;
    const list = [];
    for (const s of day) {
      if (!Array.isArray(s) || !Number.isInteger(s[0]) || s[0] < 0 || s[0] >= DAY_MIN || !PRESETS.includes(s[1])) return null;
      if (list.length ? s[0] <= list[list.length - 1][0] : s[0] !== 0) return null;
      list.push([s[0], s[1]]);
    }
    out.push(list);
  }
  return out;
}

function cleanRoom(r, weeks) {
  if (!isObj(r) || !Number.isSafeInteger(r.id) || r.id <= 0) return null;
  const th = [];
  for (const t of (Array.isArray(r.th) ? r.th : []).slice(0, MAX_TH)) {
    if (!isObj(t) || typeof t.base !== 'string' || !commands.BASE_RE.test(t.base) || typeof t.ch !== 'string' || !CH_RE.test(t.ch) || !['shelly1', 'shelly2', 'z2m'].includes(t.fam)) continue;
    if ((t.fam === 'z2m') !== commands.Z2M_RE.test(t.base) || (t.fam === 'z2m' && t.ch !== 'thermostat:0')) continue;
    const min = temp(t.min) == null ? 5 : temp(t.min);
    const max = temp(t.max) == null ? 30 : temp(t.max);
    const x = { base: t.base, ch: t.ch, fam: t.fam, min, max: Math.max(min, max), boost: t.boost === true && t.fam === 'shelly1' };
    if (t.fam === 'z2m') {
      x.name = typeof t.name === 'string' && t.name && t.name.length <= 128 ? t.name : null;
      x.step = num(t.step) != null && t.step >= 0.1 && t.step <= 5 ? t.step : 0.5;
      x.modes = Array.isArray(t.modes) ? Z2M_MODES.filter((m) => t.modes.includes(m)) : [];
    }
    th.push(x);
  }
  if (!th.length) return null;
  const temps = {};
  for (const p of PRESETS) temps[p] = temp(isObj(r.temps) ? r.temps[p] : null);
  if (PRESETS.some((p) => temps[p] == null)) return null;
  const ov = isObj(r.ov) && ms(r.ov.at) && ms(r.ov.until) && (PRESETS.includes(r.ov.preset) || temp(r.ov.setpoint) != null)
    ? { at: r.ov.at, until: r.ov.until, ...(PRESETS.includes(r.ov.preset) ? { preset: r.ov.preset } : { setpoint: temp(r.ov.setpoint) }) } : null;
  const boost = isObj(r.boost) && ms(r.boost.at) && ms(r.boost.until) ? { at: r.boost.at, until: r.boost.until } : null;
  const win = isObj(r.win) && ms(r.win.since) && ms(r.win.ttl) ? { since: r.win.since, ttl: r.win.ttl } : null;
  const vac = isObj(r.vac) && ms(r.vac.from) && ms(r.vac.end) && PRESETS.includes(r.vac.preset) ? { from: r.vac.from, end: r.vac.end, preset: r.vac.preset } : null;
  return {
    id: r.id, th, temps, week: r.plan != null && weeks.has(String(r.plan)) ? weeks.get(String(r.plan)) : null, away: r.away === true,
    mode: ['plan', 'manual', 'off'].includes(r.mode) ? r.mode : 'plan', manual: temp(r.manual), hold: temp(r.hold), vac, ov, boost, win,
  };
}

/** The configuration of the server part → { tz, rooms: [room] } (what does not fit is left out). */
function clean(cfg) {
  const c = isObj(cfg) ? cfg : {};
  const weeks = new Map();
  for (const [k, w] of Object.entries(isObj(c.plans) ? c.plans : {}).slice(0, 64)) { const x = cleanWeek(w); if (x && /^\d{1,10}$/.test(k)) weeks.set(k, x); }
  const rooms = [];
  for (const r of (Array.isArray(c.rooms) ? c.rooms : []).slice(0, MAX_ROOMS)) { const x = cleanRoom(r, weeks); if (x) rooms.push(x); }
  return { tz: typeof c.tz === 'string' && TZ_RE.test(c.tz) ? c.tz : null, rooms };
}

// ─── What a room should have (as server/heating.js decide) ───

function presetOf(day, min) {
  let p = day[0][1];
  for (const [s, pr] of day) if (s <= min) p = pr;
  return p;
}

/**
 * The preset of the plan now and where its section began (a key that changes only at a real switching point — midnight
 * with the same preset is none): { preset, slot }.
 */
function planAt(week, now, tz) {
  const c = clockOf(now, tz);
  const today = c.day - 1;
  const p = presetOf(week[today], c.min);
  const noon = now - (c.min - 720) * 60000; // within today, whatever the clocks do
  // back in time, section by section, while the preset stays: the last one seen is where it began
  let last = null;
  let changed = false;
  for (let k = 0; k < 8 && !changed; k++) {
    const day = week[(today - k + 70) % 7];
    const secs = (k === 0 ? day.filter((s) => s[0] <= c.min) : day).slice().reverse();
    for (const s of secs) {
      if (s[1] !== p) { changed = true; break; }
      last = { k, start: s[0] };
    }
  }
  const slot = changed && last ? `${clockOf(noon - last.k * 86400000, tz).date}:${last.start}` : null;
  return { preset: p, slot: slot || 'all' };
}

function decide(r, now, tz) {
  const T = r.temps;
  if (r.mode === 'off') return { kind: 'off', setpoint: T.frost, sig: 'off' };
  if (r.win && r.win.ttl > now) return { kind: 'window', setpoint: T.frost, sig: `window:${r.win.since}:${T.frost}` };
  if (r.boost && r.boost.until > now) return { kind: 'boost', until: r.boost.until, sig: `boost:${r.boost.at}` };
  if (r.ov && r.ov.until > now) {
    const sp = r.ov.preset ? T[r.ov.preset] : r.ov.setpoint;
    return { kind: 'override', setpoint: sp, sig: `override:${r.ov.at}:${sp}` };
  }
  if (r.vac && now >= r.vac.from && now < r.vac.end) return { kind: 'vacation', setpoint: T[r.vac.preset], sig: `vacation:${r.vac.from}:${r.vac.preset}:${T[r.vac.preset]}` };
  if (r.mode === 'manual' && r.manual != null) return { kind: 'manual', setpoint: r.manual, sig: `manual:${r.manual}` };
  if (r.week) {
    const at = planAt(r.week, now, tz);
    const p = r.away && at.preset === 'comfort' ? 'eco' : at.preset;
    return { kind: 'plan', preset: p, setpoint: T[p], sig: `plan:${at.slot}:${p}:${T[p]}` };
  }
  if (r.hold != null) return { kind: 'hold', setpoint: r.hold, sig: `hold:${r.hold}` };
  return { kind: 'none', sig: null };
}

/**
 * What one thermostat gets: { setpoint?, boost? (minutes, 0 = end), schedule_off? } — a zigbee2mqtt thermostat
 * { setpoint?, mode? (off | heat), prop (the setpoint it reports), boost? (true | false: its own boost, `zb`) }.
 * `zb`: the boost a zigbee2mqtt thermostat exposes ({ prop, on, off }) or null.
 */
function commandFor(t, want, prevKind, planned, rep, now, zb) {
  if (t.fam === 'z2m') return z2mCommand(t, want, prevKind, planned, rep || {}, zb || null);
  const clamp = (v) => Math.max(t.min, Math.min(t.max, v));
  const cmd = {};
  if (want.kind === 'boost') {
    if (t.boost) cmd.boost = Math.max(1, Math.min(120, Math.ceil((want.until - now) / 60000)));
    else cmd.setpoint = clamp(BOOST_SETPOINT);
  } else {
    cmd.setpoint = clamp(want.setpoint);
    if (prevKind === 'boost' && t.boost) cmd.boost = 0;
  }
  if (planned && t.fam === 'shelly1' && rep && rep.schedule === true) cmd.schedule_off = true;
  return cmd;
}

/** A zigbee2mqtt thermostat (as server/heating.js commandFor does it for one on the server). */
function z2mCommand(t, want, prevKind, planned, rep, zb) {
  const step = t.step || 0.5;
  const clamp = (v) => Math.round(Math.max(t.min, Math.min(t.max, Math.round(v / step) * step)) * 10) / 10;
  const cmd = { prop: rep.sp || null };
  if (zb) cmd.zb = zb;
  // its own boost ends with what comes after (since 1.19.0)
  if (zb && prevKind === 'boost' && want.kind !== 'boost') cmd.boost = false;
  if (want.kind === 'off' && t.modes.includes('off')) { cmd.mode = 'off'; return cmd; }
  if (want.kind === 'boost' && zb) cmd.boost = true;
  else cmd.setpoint = clamp(want.kind === 'boost' ? BOOST_SETPOINT : want.setpoint);
  // back from Aus (system_mode off): heating again; its own plan (auto) gives way to the plan
  if (prevKind === 'off' && rep.mode === 'off' && t.modes.includes('off')) cmd.mode = t.modes.includes('heat') ? 'heat' : (t.modes.find((m) => m !== 'off') || null);
  else if (planned && rep.mode === 'auto' && t.modes.includes('heat')) cmd.mode = 'heat';
  if (cmd.mode == null) delete cmd.mode;
  return cmd;
}

/** The MQTT messages of a command; `name` the zigbee2mqtt friendly name of a z2m thermostat. */
function messagesOf(t, cmd, name) {
  const out = [];
  if (t.fam === 'z2m') {
    const opts = { z2mTopic: () => name || t.name };
    const boost = (value) => out.push(...commands.messages({ base: t.base, family: 'z2m', ch: t.ch, op: 'boost', value, prop: cmd.zb.prop, on: cmd.zb.on, off: cmd.zb.off }, opts));
    if (cmd.boost === false && cmd.zb) boost(false);
    if (cmd.mode) out.push(...commands.messages({ base: t.base, family: 'z2m', ch: t.ch, op: 'mode', value: cmd.mode }, opts));
    if (cmd.setpoint != null) out.push(...commands.messages({ base: t.base, family: 'z2m', ch: t.ch, op: 'setpoint', value: cmd.setpoint, prop: cmd.prop }, opts));
    if (cmd.boost === true && cmd.zb) boost(true);
    return out;
  }
  const one = (op, value) => out.push(...commands.messages({ base: t.base, family: t.fam, ch: t.ch, op, ...(value === undefined ? {} : { value }) }));
  if (cmd.schedule_off) one('schedule_off');
  if (cmd.boost === 0) one('boost', 0);
  if (cmd.setpoint != null) one('setpoint', cmd.setpoint);
  if (cmd.boost > 0) one('boost', cmd.boost);
  return out;
}

const keyOf = (t) => `${t.base}|${t.ch}`;
const same = (a, b) => a != null && b != null && Math.abs(a - b) < 0.05;

/**
 * The engine: create({ device(base) → the edge part's record, publish(list) → Promise, save(applied), log, now?,
 * z2mTopic(base) → the friendly name of a zigbee2mqtt device (zigbee2mqtt/bridge/devices) }).
 *   set(cfg)        the server part's configuration (clean)
 *   restore(list)   what was applied before a restart ([{ id, sig, kind, prev, done: [key] }])
 *   tick()          every room: what applies now → the thermostats that do not have it yet → Promise
 *   onDevice(base)  a device reported: its room is looked at with the next tick (a sleeping TRV woke up)
 */
function create(io) {
  const now = io.now || (() => Date.now());
  const debug = (...a) => { if (io.log && typeof io.log.debug === 'function') io.log.debug(...a); };
  const st = { tz: null, rooms: [], applied: new Map(), busy: false, savedKey: null };

  function reachable(t) {
    const dev = io.device(t.base);
    if (!dev || dev.online === false) return null;
    const seen = dev.seenAt ? Date.parse(dev.seenAt) : NaN;
    if (!Number.isFinite(seen) || now() - seen > STALE_MS) return null;
    const c = (dev.ch && dev.ch[t.ch]) || null;
    if (!c || c.paired === false) return null;
    return c;
  }

  function persist() {
    const list = [...st.applied.entries()].map(([id, a]) => ({ id, sig: a.sig, kind: a.kind, prev: a.prev, done: [...a.done].sort() }));
    const key = JSON.stringify(list);
    if (key === st.savedKey) return;
    st.savedKey = key;
    if (io.save) io.save(list);
  }

  async function room(r, t0) {
    const want = decide(r, t0, st.tz);
    if (!want.sig) { st.applied.delete(r.id); return 0; }
    let ap = st.applied.get(r.id);
    if (!ap || ap.sig !== want.sig) {
      ap = { sig: want.sig, kind: want.kind, prev: ap ? ap.kind : null, done: new Set(), tries: new Map() };
      st.applied.set(r.id, ap);
    }
    const planned = !!r.week || (!!r.vac && t0 >= r.vac.from && t0 < r.vac.end);
    let waiting = 0;
    for (const t of r.th) {
      const k = keyOf(t);
      if (ap.done.has(k)) continue;
      const rep = reachable(t);
      if (!rep) { waiting++; continue; }
      const zb = t.fam === 'z2m' && io.z2mBoost ? io.z2mBoost(t.base) : null;
      const cmd = commandFor(t, want, ap.prev, planned, rep, t0, zb);
      const tr = ap.tries.get(k) || { n: 0, at: 0 };
      // the device has it (reported): done — also before anything was sent (nothing twice after a restart, nothing
      // twice when the server part hands a room over that it already sent to); a zigbee2mqtt boost of its own counts
      // once the device reports it (its end also when the device does not report its boost at all: the target decides)
      const zBoost = t.fam === 'z2m' && typeof cmd.boost === 'boolean';
      const has = (cmd.setpoint != null || cmd.mode != null || zBoost) && (cmd.setpoint == null || same(rep.target, cmd.setpoint)) && (cmd.mode == null || rep.mode === cmd.mode)
        && (cmd.boost == null || (zBoost && (rep.boost === cmd.boost || (cmd.boost === false && typeof rep.boost !== 'boolean'))));
      if (has && !cmd.schedule_off) { ap.done.add(k); continue; }
      // a zigbee2mqtt thermostat that did not report which setpoint it has yet: waits for its first report
      if (t.fam === 'z2m' && cmd.setpoint != null && !cmd.prop) { waiting++; continue; }
      if (tr.n >= TRIES) { ap.done.add(k); debug('heating: thermostat did not confirm its target', t.base, t.ch); continue; }
      if (tr.at && t0 - tr.at < RETRY_MS) { waiting++; continue; }
      try {
        await io.publish(messagesOf(t, cmd, t.fam === 'z2m' && io.z2mTopic ? io.z2mTopic(t.base) : null));
        ap.tries.set(k, { n: tr.n + 1, at: t0 });
        if (cmd.setpoint == null && cmd.mode == null) ap.done.add(k); // a boost of the device itself: nothing to compare
        else waiting++;
      } catch (e) {
        ap.tries.set(k, { n: tr.n, at: t0 });
        waiting++;
        debug('heating: command failed', t.base, (e && (e.code || e.message)) || e);
      }
    }
    return waiting;
  }

  return {
    set(cfg) {
      const c = clean(cfg);
      st.tz = c.tz;
      st.rooms = c.rooms;
      const ids = new Set(c.rooms.map((r) => r.id));
      for (const id of [...st.applied.keys()]) if (!ids.has(id)) st.applied.delete(id);
    },
    restore(list) {
      for (const a of (Array.isArray(list) ? list : []).slice(0, MAX_ROOMS)) {
        if (!isObj(a) || !Number.isSafeInteger(a.id) || typeof a.sig !== 'string' || a.sig.length > 120) continue;
        st.applied.set(a.id, { sig: a.sig, kind: typeof a.kind === 'string' ? a.kind : null, prev: typeof a.prev === 'string' ? a.prev : null,
          done: new Set((Array.isArray(a.done) ? a.done : []).filter((k) => typeof k === 'string').slice(0, MAX_TH)), tries: new Map() });
      }
      st.savedKey = null;
    },
    async tick() {
      if (st.busy) return 0;
      st.busy = true;
      let waiting = 0;
      try {
        const t0 = now();
        for (const r of st.rooms) {
          try { waiting += await room(r, t0); } catch (e) { io.log.warn('heating: room failed', r.id, (e && (e.code || e.message)) || e); }
        }
        persist();
      } finally { st.busy = false; }
      return waiting;
    },
    onDevice(base) { return st.rooms.some((r) => r.th.some((t) => t.base === base)); },
    /** The zigbee2mqtt thermostats of the rooms: [{ ieee, name }] (edge/index.js subscribes to zigbee2mqtt/# for them). */
    z2m() {
      const out = new Map();
      for (const r of st.rooms) for (const t of r.th) if (t.fam === 'z2m' && !out.has(t.base)) out.set(t.base, { ieee: t.base.slice('zigbee2mqtt/'.length), name: t.name });
      return [...out.values()];
    },
    count() { return st.rooms.length; },
    view() { const t0 = now(); return st.rooms.map((r) => { const w = decide(r, t0, st.tz); const a = st.applied.get(r.id); return { id: r.id, kind: w.kind, setpoint: w.setpoint == null ? null : w.setpoint, sent: !!a && a.sig === w.sig && a.done.size === r.th.length }; }); },
  };
}

module.exports = { create, clean, decide, planAt, commandFor, messagesOf, RETRY_MS, TRIES, STALE_MS };
