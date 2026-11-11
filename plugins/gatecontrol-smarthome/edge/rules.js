'use strict';

// Logic chains for Shelly and Tasmota devices. deCONZ runs its rules itself (server/translate.js builds deCONZ
// objects); these devices have no such engine, so the chains of a GateControl gateway run HERE, in the edge part on
// that gateway — next to the broker, without a round trip to the server, and they keep running while the server
// is away (edge/index.js keeps the last list in gc.store).
//
//   create({ publish(messages), device(base), now(), setTimer(fn, ms), clearTimer(t), log, fired(id, at) })
//     .set({ rules, tz })   the server part's list (server/edgerules.js compiles the definitions); everything in
//                           it is checked again here. A rule that did not change keeps its state and its timer.
//     .onDevice(base)       a device's state changed (edge/index.js, after normalize.apply)
//     .stop()               every timer goes
//
// A rule: { id, triggers: [{ base, ch, field, op, value }], actions: [{ base, family, ch, op, value? }],
//           window: { from: 'HH:MM', to: 'HH:MM' } | null, delay: { minutes, mode: ignore | reset | cancel } | null }
//   trigger  ch 'switch:0' | 'light:0' | 'cover:0' | 'sensor'; field on (eq true|false) | power | pos |
//            temperature | humidity (lt | gt a number)
//   action   what edge/commands.js sends: { base, family, ch, op: on | off | bri | open | close | stop | pos, value }
//
// Like the deCONZ rules ("fires when one of the triggers occurs AND all others are in the given state"): a rule
// fires when the conjunction of its triggers BECOMES true. What is already the case when a rule arrives, when the
// edge part starts or when a device reports for the first time only sets the starting point — nothing fires for it.
// The time window is checked when the rule fires. With a delay the actions run <minutes> later: a new firing in
// that time is ignored (ignore), starts the time again (reset); with cancel the pending run is dropped as soon as
// the triggers no longer hold.

const commands = require('./commands');

const MAX_RULES = 64;
const MAX_PARTS = 20;
const CH_RE = /^(switch|light|cover):(\d{1,2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const FIELDS = {
  on: { ops: ['eq'], on: ['switch', 'light'] },
  power: { ops: ['lt', 'gt'], on: ['switch', 'light', 'cover'] },
  pos: { ops: ['lt', 'gt'], on: ['cover'] },
  temperature: { ops: ['lt', 'gt'], on: ['sensor'] },
  humidity: { ops: ['lt', 'gt'], on: ['sensor'] },
};
const MODES = ['ignore', 'reset', 'cancel'];

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function cleanTrigger(t) {
  if (!t || typeof t !== 'object' || typeof t.base !== 'string' || !commands.BASE_RE.test(t.base)) return null;
  const f = FIELDS[t.field];
  const type = t.ch === 'sensor' ? 'sensor' : ((CH_RE.exec(String(t.ch)) || [])[1] || null);
  if (!f || !type || !f.on.includes(type) || !f.ops.includes(t.op)) return null;
  const value = t.field === 'on' ? (typeof t.value === 'boolean' ? t.value : null) : finite(t.value);
  if (value == null) return null;
  return { base: t.base, ch: t.ch, field: t.field, op: t.op, value };
}

function cleanAction(a) {
  if (!a || typeof a !== 'object') return null;
  const c = { base: a.base, family: a.family, ch: a.ch, op: a.op };
  if (a.value !== undefined) c.value = a.value;
  try { commands.messages(c); } catch { return null; }
  return c;
}

/** One rule of the server's list → the checked rule, or null (a rule with a part we do not know never runs half). */
function cleanRule(r) {
  if (!r || typeof r !== 'object' || !Number.isSafeInteger(r.id) || r.id <= 0) return null;
  const tl = Array.isArray(r.triggers) ? r.triggers : [];
  const al = Array.isArray(r.actions) ? r.actions : [];
  if (!tl.length || !al.length || tl.length > MAX_PARTS || al.length > MAX_PARTS) return null;
  const triggers = tl.map(cleanTrigger);
  const actions = al.map(cleanAction);
  if (triggers.includes(null) || actions.includes(null)) return null;
  let window = null;
  if (r.window != null) {
    if (typeof r.window !== 'object' || !TIME_RE.test(r.window.from) || !TIME_RE.test(r.window.to)) return null;
    window = { from: r.window.from, to: r.window.to };
  }
  let delay = null;
  if (r.delay != null) {
    if (typeof r.delay !== 'object' || !Number.isInteger(r.delay.minutes) || r.delay.minutes < 1 || r.delay.minutes > 1440) return null;
    delay = { minutes: r.delay.minutes, mode: MODES.includes(r.delay.mode) ? r.delay.mode : 'ignore' };
  }
  return { id: r.id, triggers, actions, window, delay };
}

/** Does one trigger hold for the device as edge/normalize.js keeps it? true | false | null (not known yet). */
function holds(t, dev) {
  if (!dev) return null;
  const src = t.ch === 'sensor' ? dev.sensor : (dev.ch && dev.ch[t.ch]);
  if (!src) return null;
  const v = src[t.field];
  if (t.field === 'on') return typeof v === 'boolean' ? v === t.value : null;
  const n = finite(v);
  if (n == null) return null;
  return t.op === 'lt' ? n < t.value : n > t.value;
}

/** Minutes since midnight in `tz` (an IANA name; without one, or with one this Node does not know: local time). */
function minuteOfDay(ms, tz) {
  const d = new Date(ms);
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
      const h = Number((parts.find((p) => p.type === 'hour') || {}).value);
      const m = Number((parts.find((p) => p.type === 'minute') || {}).value);
      if (Number.isFinite(h) && Number.isFinite(m)) return (h % 24) * 60 + m;
    } catch { /* unknown zone → local time */ }
  }
  return d.getHours() * 60 + d.getMinutes();
}

/** from ≤ now < to; a window over midnight (22:00–06:00) wraps; from = to is the whole day. */
function inWindow(window, ms, tz) {
  if (!window) return true;
  const min = (s) => { const m = TIME_RE.exec(s); return Number(m[1]) * 60 + Number(m[2]); };
  const from = min(window.from);
  const to = min(window.to);
  const now = minuteOfDay(ms, tz);
  if (from === to) return true;
  return from < to ? (now >= from && now < to) : (now >= from || now < to);
}

function create(io) {
  const st = { rules: new Map(), tz: null }; // id → { def, key, sat: true | false | null, timer }
  const now = () => (io.now ? io.now() : Date.now());
  const setTimer = io.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
  const clearTimer = io.clearTimer || clearTimeout;

  function evaluate(def) {
    let unknown = false;
    for (const t of def.triggers) {
      const v = holds(t, io.device(t.base));
      if (v === false) return false;
      if (v == null) unknown = true;
    }
    return unknown ? null : true;
  }

  function drop(rt) {
    if (rt.timer != null) clearTimer(rt.timer);
    rt.timer = null;
  }

  function run(rt) {
    rt.timer = null;
    const list = [];
    for (const a of rt.def.actions) {
      // the family the device reports itself (a Gen1 ↔ Gen2 mix-up at set-up is corrected by its first message)
      const dev = io.device(a.base);
      try { list.push(...commands.messages({ ...a, family: (dev && dev.family) || a.family })); } catch { /* checked in cleanRule */ }
    }
    const at = new Date(now()).toISOString();
    Promise.resolve().then(() => io.publish(list)).then(() => {
      if (io.fired) io.fired(rt.def.id, at);
    }, (e) => {
      if (io.log) io.log.warn(`logic chain ${rt.def.id} could not switch (${(e && e.code) || 'error'})`);
    });
  }

  function fire(rt) {
    const def = rt.def;
    if (!inWindow(def.window, now(), st.tz)) return;
    if (!def.delay) { run(rt); return; }
    if (rt.timer != null) {
      if (def.delay.mode !== 'reset') return; // ignore; with cancel the pending run was dropped before
      drop(rt);
    }
    rt.timer = setTimer(() => run(rt), def.delay.minutes * 60000);
  }

  function step(rt) {
    const v = evaluate(rt.def);
    if (v == null) return;
    const before = rt.sat;
    rt.sat = v;
    if (v && before === false) fire(rt);
    else if (!v && before === true && rt.timer != null && rt.def.delay && rt.def.delay.mode === 'cancel') drop(rt);
  }

  return {
    set(cfg) {
      const c = cfg && typeof cfg === 'object' ? cfg : {};
      st.tz = typeof c.tz === 'string' && /^[A-Za-z0-9_+\-/]{1,64}$/.test(c.tz) ? c.tz : null;
      const next = new Map();
      for (const raw of (Array.isArray(c.rules) ? c.rules : []).slice(0, MAX_RULES)) {
        const def = cleanRule(raw);
        if (!def || next.has(def.id)) continue;
        const key = JSON.stringify(def);
        const old = st.rules.get(def.id);
        if (old && old.key === key) { next.set(def.id, old); continue; }
        next.set(def.id, { def, key, sat: evaluate(def), timer: null });
      }
      for (const [id, rt] of st.rules) if (next.get(id) !== rt) drop(rt);
      st.rules = next;
      return next.size;
    },
    onDevice(base) {
      for (const rt of st.rules.values()) if (rt.def.triggers.some((t) => t.base === base)) step(rt);
    },
    stop() {
      for (const rt of st.rules.values()) drop(rt);
      st.rules = new Map();
    },
    count: () => st.rules.size,
    pending: () => [...st.rules.values()].filter((rt) => rt.timer != null).map((rt) => rt.def.id),
  };
}

module.exports = { create, cleanRule, holds, inWindow, minuteOfDay, MAX_RULES };
