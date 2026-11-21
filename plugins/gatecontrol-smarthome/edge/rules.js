'use strict';

// Logic chains for Shelly and Tasmota devices. deCONZ runs its rules itself (server/translate.js builds deCONZ
// objects); these devices have no such engine, so the chains of a GateControl gateway run HERE, in the edge part on
// that gateway — next to the broker, without a round trip to the server, and they keep running while the server
// is away (edge/index.js keeps the last list in gc.store).
//
//   create({ publish(messages), device(base), now(), setTimer(fn, ms), clearTimer(t), log, fired(id, at),
//            record(run), runId() })
//     .set({ rules, tz })   the server part's list (server/edgerules.js compiles the definitions); everything in
//                           it is checked again here. A rule that did not change keeps its state and its timer.
//     .onDevice(base)       a device's state changed (edge/index.js, after normalize.apply)
//     .onEvent(base, evs)   a button was pressed (normalize.parse `events`: [{ input, ev }]) — an event, no state
//     .test(spec, { run })  what a chain would do now ({ id } of the list or { rule } — a draft), or run it by hand
//     .stoppedList() / .restoreStopped(list)   chains the brake stopped (kept by edge/index.js for a restart)
//     .stop()               every timer goes
//
// Two kinds of rules. Version 1 (1.10.0, unchanged):
//   { id, triggers: [{ base, ch, field, op, value }], actions: [{ base, family, ch, op, value? }],
//     window: { from: 'HH:MM', to: 'HH:MM' } | null, delay: { minutes, mode: ignore | reset | cancel } | null }
//   trigger  ch 'switch:0' | 'light:0' | 'cover:0' | 'sensor'; field on (eq true|false) | power | pos |
//            temperature | humidity (lt | gt a number)
//   action   what edge/commands.js sends: { base, family, ch, op: on | off | bri | open | close | stop | pos, value }
//   Like the deCONZ rules ("fires when one of the triggers occurs AND all others are in the given state"): a rule
//   fires when the conjunction of its triggers BECOMES true. What is already the case when a rule arrives, when the
//   edge part starts or when a device reports for the first time only sets the starting point — nothing fires for
//   it. The time window is checked when the rule fires. With a delay the actions run <minutes> later: a new firing
//   in that time is ignored (ignore), starts the time again (reset); with cancel the pending run is dropped as soon
//   as the triggers no longer hold.
//
// Version 2 (1.11.0) — WENN (events, one is enough) · NUR WENN (states, all or one) · DANN (steps in order):
//   { id, v: 2, when: [w], cond: { mode: 'all' | 'any', list: [c] }, steps: [s], re: 'restart' | 'ignore' | 'cancel' }
//   w  { k: 'dev', base, ch, field, op, value }   a state BECOMES true (goes on, rises above, …) — as version 1
//      { k: 'btn', base, input, ev }               a button: single | double | triple | long
//      { k: 'time', at: 'HH:MM' }                  the clock of the house (tz of the server part)
//      { k: 'all', parts: [{ base, ch, field, op, value }] }   "wird wahr: A und B" (a version 1 chain, edited)
//   c  { k: 'dev', base, ch, field, op, value } · { k: 'time', from, to } · { k: 'days', days: [1…7] } (1 = Monday)
//   s  { k: 'act', base, family, ch, op, value? } · { k: 'wait', s: 1…86400 }
//   re while a run is still going a new firing restarts it from the first step (restart), is ignored (ignore), or
//      is ignored and the run stops as soon as NUR WENN no longer holds (cancel).
//
// Brakes (both kinds): a chain that starts more than 10 times within a minute is stopped (a run record with result
// 'stopped', the server part switches it off and shows why); at most 60 commands a minute leave this gateway; a
// version 2 chain does not react to what it switched itself in the 2 s after the command (the device's report).
//
// A run record (record(run), edge/index.js keeps the last 200 and hands them to the server part):
//   { u, r, at, by: 'event' | 'manual', tr, res, why, ev: [[ms, code, x]], end }
//   res running | ok | skip | partial | cancel | stopped | error; ev codes trig, manual, cond, act, ack, noack, fail,
//   limit, wait, waited, restart, cancel, stop.

const commands = require('./commands');

const MAX_RULES = 64;
const MAX_PARTS = 20;
const MAX_STEPS = 20;
const MAX_WAIT_S = 86400;
const RUNS_PER_MIN = 10;
const CMDS_PER_MIN = 60;
const ECHO_MS = 2000;
const ACK_MS = 5000;
const MAX_EV = 40;
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
const RETRIGGER = ['restart', 'ignore', 'cancel'];
const BUTTON_EVENTS = ['single', 'double', 'triple', 'long'];
const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const keyOf = (x) => `${x.base}|${x.ch}`;

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

function cleanWhen(w) {
  if (!isObj(w)) return null;
  if (w.k === 'dev') { const t = cleanTrigger(w); return t && { k: 'dev', ...t }; }
  if (w.k === 'btn') {
    if (typeof w.base !== 'string' || !commands.BASE_RE.test(w.base) || !Number.isInteger(w.input) || w.input < 0 || w.input > 7 || !BUTTON_EVENTS.includes(w.ev)) return null;
    return { k: 'btn', base: w.base, input: w.input, ev: w.ev };
  }
  if (w.k === 'time') return TIME_RE.test(w.at) ? { k: 'time', at: w.at } : null;
  if (w.k === 'all') {
    const parts = Array.isArray(w.parts) && w.parts.length && w.parts.length <= MAX_PARTS ? w.parts.map(cleanTrigger) : [null];
    return parts.includes(null) ? null : { k: 'all', parts };
  }
  return null;
}

function cleanCond(c) {
  if (!isObj(c)) return null;
  if (c.k === 'dev') { const t = cleanTrigger(c); return t && { k: 'dev', ...t }; }
  if (c.k === 'time') return TIME_RE.test(c.from) && TIME_RE.test(c.to) ? { k: 'time', from: c.from, to: c.to } : null;
  if (c.k === 'days') {
    const days = Array.isArray(c.days) ? c.days : [];
    if (!days.length || days.length > 7 || !days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7) || new Set(days).size !== days.length) return null;
    return { k: 'days', days: [...days].sort((a, b) => a - b) };
  }
  return null;
}

function cleanStep(s) {
  if (!isObj(s)) return null;
  if (s.k === 'wait') return Number.isInteger(s.s) && s.s >= 1 && s.s <= MAX_WAIT_S ? { k: 'wait', s: s.s } : null;
  if (s.k === 'act') { const a = cleanAction({ base: s.base, family: s.family, ch: s.ch, op: s.op, ...(s.value !== undefined ? { value: s.value } : {}) }); return a && { k: 'act', ...a }; }
  return null;
}

function cleanRuleV2(r) {
  const wl = Array.isArray(r.when) ? r.when : [];
  const cl = isObj(r.cond) && Array.isArray(r.cond.list) ? r.cond.list : (r.cond == null ? [] : null);
  const sl = Array.isArray(r.steps) ? r.steps : [];
  if (!wl.length || wl.length > MAX_PARTS || !cl || cl.length > MAX_PARTS || !sl.length || sl.length > MAX_STEPS) return null;
  const when = wl.map(cleanWhen);
  const list = cl.map(cleanCond);
  const steps = sl.map(cleanStep);
  if (when.includes(null) || list.includes(null) || steps.includes(null) || !steps.some((s) => s.k === 'act')) return null;
  const mode = isObj(r.cond) && r.cond.mode === 'any' ? 'any' : 'all';
  return { id: r.id, v: 2, when, cond: { mode, list }, steps, re: RETRIGGER.includes(r.re) ? r.re : 'restart' };
}

/** One rule of the server's list → the checked rule, or null (a rule with a part we do not know never runs half). */
function cleanRule(r) {
  if (!r || typeof r !== 'object' || !Number.isSafeInteger(r.id) || r.id <= 0) return null;
  if (r.v === 2) return cleanRuleV2(r);
  if (r.v != null) return null; // a later version this edge part does not know
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

/** The value a trigger / condition looks at, as edge/normalize.js keeps the device (undefined: not known). */
function valueOf(t, dev) {
  if (!dev) return undefined;
  const src = t.ch === 'sensor' ? dev.sensor : (dev.ch && dev.ch[t.ch]);
  return src ? src[t.field] : undefined;
}

/** Does one trigger hold for the device as edge/normalize.js keeps it? true | false | null (not known yet). */
function holds(t, dev) {
  const v = valueOf(t, dev);
  if (t.field === 'on') return typeof v === 'boolean' ? v === t.value : null;
  const n = finite(v);
  if (n == null) return null;
  return t.op === 'lt' ? n < t.value : n > t.value;
}

/** Minutes since midnight, weekday (1 = Monday) and date in `tz` (an IANA name; without one or unknown: local). */
function clockOf(ms, tz) {
  const d = new Date(ms);
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
      const get = (type) => (parts.find((p) => p.type === type) || {}).value;
      const h = Number(get('hour'));
      const m = Number(get('minute'));
      const day = WEEKDAYS[get('weekday')];
      if (Number.isFinite(h) && Number.isFinite(m) && day) return { min: (h % 24) * 60 + m, day, date: `${get('year')}-${get('month')}-${get('day')}` };
    } catch { /* unknown zone → local time */ }
  }
  const pad = (n) => String(n).padStart(2, '0');
  return { min: d.getHours() * 60 + d.getMinutes(), day: d.getDay() === 0 ? 7 : d.getDay(), date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` };
}

function minuteOfDay(ms, tz) { return clockOf(ms, tz).min; }

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

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

/** Has the device reached what an action asked for? (the device's report after the command) */
function reached(s, dev, loose) {
  const src = dev && dev.ch && dev.ch[s.ch];
  if (!src) return false;
  if (s.op === 'on') return src.on === true;
  if (s.op === 'off') return src.on === false;
  if (s.op === 'bri') return src.on === true && finite(src.bri) != null && Math.abs(src.bri - s.value) <= (loose ? 2 : 0);
  if (s.op === 'stop') return loose ? src.moving == null : false;
  // a shutter: moving that way (it takes a while) or there
  if (s.op === 'open') return src.pos === 100 || (loose && src.moving === 'opening');
  if (s.op === 'close') return src.pos === 0 || (loose && src.moving === 'closing');
  if (s.op === 'pos') return src.pos === s.value || (loose && (src.moving === 'opening' || src.moving === 'closing'));
  return false;
}

function create(io) {
  const st = { rules: new Map(), tz: null, cmds: [], ticker: null, seq: 0, warned: new Set() }; // id → runtime
  const now = () => (io.now ? io.now() : Date.now());
  const setTimer = io.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
  const clearTimer = io.clearTimer || clearTimeout;
  const runId = io.runId || (() => `run:${++st.seq}`);
  const iso = (ms) => new Date(ms).toISOString();
  const warnOnce = (key, line) => { if (st.warned.has(key) || !io.log) return; st.warned.add(key); io.log.warn(line); };

  function emit(rec) { if (io.record) { try { io.record(JSON.parse(JSON.stringify(rec))); } catch { /* the record is information only */ } } }
  function newRecord(rt, ms, by, tr) { return { u: runId(), r: rt.def.id, at: iso(ms), by, tr: tr == null ? null : tr, res: 'running', why: null, ev: [], end: null }; }
  function ev(rec, ms, code, x) {
    if (rec.ev.length >= MAX_EV) return;
    rec.ev.push(x === undefined ? [Math.max(0, ms - Date.parse(rec.at)), code] : [Math.max(0, ms - Date.parse(rec.at)), code, x]);
  }

  /** At most 60 commands a minute leave this gateway (every chain together). */
  function mayCommand(ms) {
    st.cmds = st.cmds.filter((t) => ms - t < 60000);
    if (st.cmds.length >= CMDS_PER_MIN) { warnOnce('cmds', 'logic chains: more than 60 commands in a minute — further commands are dropped until it calms down'); return false; }
    st.cmds.push(ms);
    return true;
  }

  /** More than 10 starts within a minute: the chain stops (it probably switches itself or another chain back). */
  function brake(rt, ms) {
    rt.starts = rt.starts.filter((t) => ms - t < 60000);
    rt.starts.push(ms);
    return rt.starts.length > RUNS_PER_MIN;
  }

  function stopRule(rt, ms, by, tr) {
    const n = rt.starts.length;
    rt.stopped = { reason: 'rate', n, at: iso(ms) };
    if (io.log) io.log.warn(`logic chain ${rt.def.id} stopped: ${n} runs within a minute`);
    const run = rt.run;
    if (run) { drop(rt); finish(rt, run, ms, 'stopped', `rate:${n}`); return; }
    const rec = newRecord(rt, ms, by, tr);
    ev(rec, ms, 'stop', n);
    rec.res = 'stopped';
    rec.why = `rate:${n}`;
    rec.end = rec.at;
    emit(rec);
  }

  // ─── version 1 ───

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
    if (rt.run && rt.run.timer != null) clearTimer(rt.run.timer);
    if (rt.run) { rt.run.timer = null; rt.run.gen++; }
  }

  function run(rt, by = 'event') {
    rt.timer = null;
    const ms = now();
    const list = [];
    for (const a of rt.def.actions) {
      // the family the device reports itself (a Gen1 ↔ Gen2 mix-up at set-up is corrected by its first message)
      const dev = io.device(a.base);
      try { list.push(...commands.messages({ ...a, family: (dev && dev.family) || a.family })); } catch { /* checked in cleanRule */ }
    }
    const rec = newRecord(rt, ms, by, null);
    const allowed = list.filter(() => mayCommand(ms));
    const at = iso(ms);
    Promise.resolve().then(() => io.publish(allowed)).then(() => {
      if (io.fired) io.fired(rt.def.id, at);
      rec.ev.push([0, 'act', allowed.length]);
      rec.res = allowed.length < list.length ? 'partial' : 'ok';
      if (allowed.length < list.length) rec.why = 'limit';
      rec.end = iso(now());
      emit(rec);
    }, (e) => {
      if (io.log) io.log.warn(`logic chain ${rt.def.id} could not switch (${(e && e.code) || 'error'})`);
      rec.ev.push([0, 'fail', (e && typeof e.code === 'string' && e.code.slice(0, 16)) || 'error']);
      rec.res = 'error';
      rec.why = (e && typeof e.code === 'string' && e.code.slice(0, 32)) || 'error';
      rec.end = iso(now());
      emit(rec);
    });
  }

  function fire(rt) {
    const def = rt.def;
    if (rt.stopped) return;
    const ms = now();
    if (!inWindow(def.window, ms, st.tz)) return;
    if (def.delay && rt.timer != null && def.delay.mode !== 'reset') return; // ignore; with cancel the pending run was dropped before
    if (brake(rt, ms)) { drop(rt); stopRule(rt, ms, 'event', null); return; }
    if (!def.delay) { run(rt); return; }
    if (rt.timer != null) drop(rt);
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

  // ─── version 2 ───

  /** The conditions now: { ok: true | false | null, checks: [{ ok, v }] } (null: a device has not reported yet). */
  function conditions(def, ms) {
    const clock = clockOf(ms, st.tz);
    const checks = def.cond.list.map((c) => {
      if (c.k === 'time') return { ok: inWindow(c, ms, st.tz), v: hhmm(clock.min) };
      if (c.k === 'days') return { ok: c.days.includes(clock.day), v: clock.day };
      const dev = io.device(c.base);
      const v = valueOf(c, dev);
      return { ok: holds(c, dev), v: v === undefined ? null : v };
    });
    let ok;
    if (!checks.length) ok = true;
    else if (def.cond.mode === 'any') ok = checks.some((c) => c.ok === true) ? true : (checks.some((c) => c.ok == null) ? null : false);
    else ok = checks.some((c) => c.ok === false) ? false : (checks.some((c) => c.ok == null) ? null : true);
    return { ok, checks, clock };
  }

  function whenHolds(w) {
    if (w.k === 'dev') return holds(w, io.device(w.base));
    if (w.k === 'all') {
      let unknown = false;
      for (const p of w.parts) {
        const v = holds(p, io.device(p.base));
        if (v === false) return false;
        if (v == null) unknown = true;
      }
      return unknown ? null : true;
    }
    return null;
  }

  function finish(rt, run, ms, res, why) {
    if (rt.run === run) rt.run = null;
    run.done = true;
    if (run.timer != null) { clearTimer(run.timer); run.timer = null; }
    const rec = run.rec;
    const settle = () => {
      if (run.ackTimer != null) { clearTimer(run.ackTimer); run.ackTimer = null; }
      rt.acking = rt.acking.filter((x) => x !== run);
      run.settle = null;
      for (const a of run.acks.values()) { ev(rec, now(), 'noack', a.idx); if (res === 'ok') res = 'partial'; why = why || 'noack'; }
      run.acks.clear();
      rec.res = res;
      rec.why = why || null;
      rec.end = iso(now());
      emit(rec);
    };
    if (res === 'ok' && run.acks.size) {
      // the devices' reports for the last commands: a few seconds, then the record goes out
      run.settle = settle;
      rt.acking.push(run);
      run.ackTimer = setTimer(settle, ACK_MS);
      return;
    }
    run.acks.clear();
    settle();
  }

  async function advance(rt, run) {
    const gen = run.gen;
    const steps = rt.def.steps;
    while (run.step < steps.length) {
      if (run.gen !== gen || run.done) return;
      const idx = run.step;
      const s = steps[idx];
      if (s.k === 'wait') {
        ev(run.rec, now(), 'wait', idx);
        if (!run.announced) { run.announced = true; emit(run.rec); } // a run that waits shows up as running
        run.timer = setTimer(() => {
          run.timer = null;
          if (run.gen !== gen || run.done) return;
          const ms = now();
          ev(run.rec, ms, 'waited', idx);
          if (rt.def.re === 'cancel' && run.by !== 'manual' && conditions(rt.def, ms).ok !== true) { finish(rt, run, ms, 'cancel', 'cond'); return; }
          run.step = idx + 1;
          advance(rt, run);
        }, s.s * 1000);
        return;
      }
      run.step = idx + 1;
      const ms = now();
      if (!mayCommand(ms)) { ev(run.rec, ms, 'limit', idx); run.partial = 'limit'; continue; }
      const dev = io.device(s.base);
      let list = [];
      try { list = commands.messages({ ...s, family: (dev && dev.family) || s.family }); } catch { /* checked in cleanRule */ }
      rt.echo.set(keyOf(s), ms + ECHO_MS);
      ev(run.rec, ms, 'act', idx);
      if (reached(s, dev, false)) ev(run.rec, ms, 'ack', idx);
      else run.acks.set(keyOf(s), { idx, s, at: ms });
      try {
        await io.publish(list);
      } catch (e) {
        ev(run.rec, now(), 'fail', idx);
        run.acks.delete(keyOf(s));
        run.partial = run.partial || 'fail';
        if (io.log) io.log.warn(`logic chain ${rt.def.id} could not switch (${(e && e.code) || 'error'})`);
      }
    }
    if (run.gen !== gen || run.done) return;
    finish(rt, run, now(), run.partial ? 'partial' : 'ok', run.partial || null);
  }

  /** A trigger of a version 2 chain occurred (tr = its index), or the chain is run by hand (by 'manual'). */
  function fire2(rt, tr, by = 'event') {
    if (rt.stopped) return false;
    const def = rt.def;
    const ms = now();
    const running = rt.run;
    if (running && by === 'event' && def.re !== 'restart') return false;
    const c = by === 'manual' ? null : conditions(def, ms);
    if (c && c.ok !== true) {
      if (!running) {
        const rec = newRecord(rt, ms, by, tr);
        ev(rec, ms, 'trig', tr);
        const failed = c.checks.findIndex((x) => x.ok !== true);
        ev(rec, ms, 'cond', failed);
        rec.res = 'skip';
        rec.why = c.ok === null ? 'unknown' : `cond:${failed}`;
        rec.end = rec.at;
        emit(rec);
      }
      return false;
    }
    if (brake(rt, ms)) { stopRule(rt, ms, by, tr); return false; }
    if (io.fired) io.fired(def.id, iso(ms));
    if (running) {
      if (running.timer != null) clearTimer(running.timer);
      running.timer = null;
      running.gen++;
      running.step = 0;
      ev(running.rec, ms, 'restart', by === 'manual' ? 'manual' : tr);
      advance(rt, running);
      return true;
    }
    const run = { rec: newRecord(rt, ms, by, tr), by, step: 0, gen: 0, timer: null, acks: new Map(), ackTimer: null, partial: null, announced: false, done: false };
    ev(run.rec, ms, by === 'manual' ? 'manual' : 'trig', tr);
    if (c) ev(run.rec, ms, 'cond', 'ok');
    rt.run = run;
    advance(rt, run);
    return true;
  }

  /** cancel: a running chain whose NUR WENN no longer holds stops. */
  function checkCancel(rt) {
    const run = rt.run;
    if (!run || rt.def.re !== 'cancel' || run.by === 'manual') return;
    const ms = now();
    if (conditions(rt.def, ms).ok === false) { drop(rt); finish(rt, run, ms, 'cancel', 'cond'); }
  }

  function onDevice2(rt, base) {
    const def = rt.def;
    const ms = now();
    let first = null;
    def.when.forEach((w, i) => {
      if (w.k !== 'dev' && w.k !== 'all') return;
      const keys = w.k === 'dev' ? [w] : w.parts;
      if (!keys.some((p) => p.base === base)) return;
      const v = whenHolds(w);
      if (v == null) return;
      const before = rt.wsat[i];
      rt.wsat[i] = v;
      // its own report after a command of this chain (2 s) is no reason to start again
      const echo = keys.some((p) => (rt.echo.get(keyOf(p)) || 0) > ms);
      if (v && before === false && !echo && first == null) first = i;
    });
    if (first != null) fire2(rt, first);
    if (def.cond.list.some((c) => c.k === 'dev' && c.base === base)) checkCancel(rt);
    const run = rt.run || null;
    for (const r of [run, ...rt.acking].filter(Boolean)) ackFrom(r, base, ms);
  }

  function ackFrom(run, base, ms) {
    for (const [key, a] of [...run.acks]) {
      if (a.s.base !== base || !reached(a.s, io.device(base), true)) continue;
      run.acks.delete(key);
      ev(run.rec, ms, 'ack', a.idx);
    }
    if (run.done && run.settle && !run.acks.size) run.settle(); // every device answered: no need to wait longer
  }

  // ─── the clock (version 2: Uhrzeit triggers, cancel with time / weekday conditions) ───

  function needsClock() {
    for (const rt of st.rules.values()) {
      if (!rt.def.v) continue;
      if (rt.def.when.some((w) => w.k === 'time')) return true;
      if (rt.def.re === 'cancel' && rt.def.cond.list.some((c) => c.k !== 'dev')) return true;
    }
    return false;
  }

  function tick() {
    st.ticker = null;
    const ms = now();
    const clock = clockOf(ms, st.tz);
    const at = hhmm(clock.min);
    for (const rt of st.rules.values()) {
      if (!rt.def.v) continue;
      const i = rt.def.when.findIndex((w) => w.k === 'time' && w.at === at);
      const mark = `${clock.date} ${at}`;
      if (i >= 0 && rt.lastTime !== mark) { rt.lastTime = mark; fire2(rt, i); }
      checkCancel(rt);
    }
    schedule();
  }

  function schedule() {
    if (st.ticker != null) { clearTimer(st.ticker); st.ticker = null; }
    if (!needsClock()) return;
    const ms = now();
    st.ticker = setTimer(tick, 60000 - (ms % 60000) + 50);
  }

  function runtime(def, key) {
    const rt = { def, key, sat: null, timer: null, starts: [], stopped: null, run: null, acking: [], echo: new Map(), wsat: [], lastTime: null };
    if (def.v === 2) {
      rt.wsat = def.when.map((w) => whenHolds(w));
      // a clock trigger does not fire again for the minute it arrives in
      const clock = clockOf(now(), st.tz);
      rt.lastTime = `${clock.date} ${hhmm(clock.min)}`;
    } else rt.sat = evaluate(def);
    return rt;
  }

  function stopRuntime(rt) {
    drop(rt);
    if (rt.run) { rt.run.done = true; rt.run = null; }
    for (const r of rt.acking.splice(0)) if (r.ackTimer != null) { clearTimer(r.ackTimer); r.ackTimer = null; }
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
        next.set(def.id, runtime(def, key));
      }
      for (const [id, rt] of st.rules) if (next.get(id) !== rt) stopRuntime(rt);
      st.rules = next;
      schedule();
      return next.size;
    },
    onDevice(base) {
      for (const rt of st.rules.values()) {
        if (rt.def.v === 2) onDevice2(rt, base);
        else if (rt.def.triggers.some((t) => t.base === base)) { if (!rt.stopped) step(rt); else rt.sat = evaluate(rt.def); }
      }
    },
    onEvent(base, events) {
      const list = Array.isArray(events) ? events : [];
      for (const rt of st.rules.values()) {
        if (rt.def.v !== 2) continue;
        for (const e of list) {
          const i = rt.def.when.findIndex((w) => w.k === 'btn' && w.base === base && w.input === e.input && w.ev === e.ev);
          if (i >= 0) { fire2(rt, i); break; }
        }
      }
    },
    /** spec { id } (a chain of the list) or { rule } (a draft, checked only); run: start it by hand, NUR WENN skipped. */
    test(spec, opts = {}) {
      const ms = now();
      const s = spec && typeof spec === 'object' ? spec : {};
      let rt = Number.isSafeInteger(s.id) ? st.rules.get(s.id) : null;
      if (Number.isSafeInteger(s.id) && !rt) throw Object.assign(new Error('this logic chain is not on the gateway'), { code: 'not_found' });
      if (!rt) {
        const def = cleanRule({ ...(isObj(s.rule) ? s.rule : {}), id: 1 });
        if (!def) throw Object.assign(new Error('the logic chain is not valid'), { code: 'bad_request' });
        rt = runtime(def, '');
        if (opts.run) throw Object.assign(new Error('only a saved logic chain runs by hand'), { code: 'bad_request' });
      }
      if (opts.run) {
        if (rt.stopped) throw Object.assign(new Error('this logic chain was stopped'), { code: 'stopped' });
        if (rt.def.v === 2) fire2(rt, null, 'manual');
        else run(rt, 'manual');
        return { started: true, at: iso(ms) };
      }
      const def = rt.def;
      const out = { at: iso(ms), running: !!(rt.run || rt.timer != null), stopped: rt.stopped ? { ...rt.stopped } : null };
      if (def.v === 2) {
        const c = conditions(def, ms);
        return { ...out, v: 2, clock: hhmm(c.clock.min), day: c.clock.day, mode: def.cond.mode, checks: c.checks, result: c.ok === true ? 'run' : (c.ok === false ? 'skip' : 'unknown') };
      }
      // version 1: the states of the triggers and the time window
      const clock = clockOf(ms, st.tz);
      const checks = def.triggers.map((t) => { const dev = io.device(t.base); const v = valueOf(t, dev); return { ok: holds(t, dev), v: v === undefined ? null : v }; });
      if (def.window) checks.push({ ok: inWindow(def.window, ms, st.tz), v: hhmm(clock.min) });
      const ok = checks.some((x) => x.ok === false) ? false : (checks.some((x) => x.ok == null) ? null : true);
      return { ...out, v: 1, clock: hhmm(clock.min), day: clock.day, mode: 'all', checks, result: ok === true ? 'run' : (ok === false ? 'skip' : 'unknown') };
    },
    stoppedList() {
      return [...st.rules.values()].filter((rt) => rt.stopped).map((rt) => ({ id: rt.def.id, ...rt.stopped }));
    },
    restoreStopped(list) {
      for (const x of Array.isArray(list) ? list.slice(0, MAX_RULES) : []) {
        const rt = x && st.rules.get(x.id);
        if (rt && x.reason === 'rate') rt.stopped = { reason: 'rate', n: Number.isInteger(x.n) ? x.n : RUNS_PER_MIN + 1, at: typeof x.at === 'string' ? x.at : iso(now()) };
      }
    },
    stop() {
      for (const rt of st.rules.values()) stopRuntime(rt);
      if (st.ticker != null) clearTimer(st.ticker);
      st.ticker = null;
      st.rules = new Map();
    },
    count: () => st.rules.size,
    pending: () => [...st.rules.values()].filter((rt) => rt.timer != null || rt.run).map((rt) => rt.def.id),
  };
}

module.exports = { create, cleanRule, holds, inWindow, minuteOfDay, clockOf, MAX_RULES, MAX_STEPS, RUNS_PER_MIN, CMDS_PER_MIN, ECHO_MS };
