'use strict';

// 2.2.4 — the brake on automatic logins to a maker's cloud. A login is what
// the maker tells the account's owner about ("someone signed in"), and too
// many of them lock an account — so no code path logs in on its own any
// more: every automatic login goes through a guard.
//
//   const guard = createGuard('cloud_guard', { onBlock });
//   const session = await guard.login(gc, () => …the login…, 'why');
//
// * One login at a time: parallel callers share the one in flight.
// * A failed login, or one that did not help (guard.failed), is followed by
//   a growing wait: 1 min → 5 → 15 → 60 min.
// * At most `perHour` (3) and `perDay` (6) automatic logins. The times are
//   kept in the plugin's storage, so a restart does not start over.
// * `sticky` guards (the accounts): once the day's logins are used up, or the
//   cloud wants something only a person can do (2FA, wrong password), the
//   guard is blocked — "connect again" — until a person signs in in the
//   settings (guard.manual) or a normal call works again (guard.ok). `onBlock`
//   is called once per block (the notification).
// * 429 (guard.rateLimited) pauses every call: 5 min → 15 → 60 min.
// * A normal call that worked (guard.ok) lifts wait, block and pause — the
//   count of logins per hour/day stays.
//
// A refused login throws { code: opts.code, reason: 'blocked'|'wait'|'hour'|'day', until }.

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULTS = {
  perHour: 3,
  perDay: 6,
  backoffMs: [60000, 300000, 900000, HOUR_MS],
  rateLimitMs: [300000, 900000, HOUR_MS],
  sticky: true,
  code: 'LOGIN_PAUSED',
};

/** Tests move the clock. */
const clock = { now: () => Date.now() };

const fresh = () => ({ logins: [], stage: 0, retryAt: 0, blocked: null, pauseUntil: 0, pauseStage: 0 });

function clean(v) {
  const st = fresh();
  if (!v || typeof v !== 'object' || Array.isArray(v)) return st;
  const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
  if (Array.isArray(v.logins)) st.logins = v.logins.filter((x) => Number.isFinite(x)).slice(-50);
  st.stage = Math.min(num(v.stage), 50);
  st.retryAt = num(v.retryAt);
  st.blocked = typeof v.blocked === 'string' && v.blocked ? v.blocked.slice(0, 20) : null;
  st.pauseUntil = num(v.pauseUntil);
  st.pauseStage = Math.min(num(v.pauseStage), 50);
  return st;
}

function createGuard(key, options = {}) {
  const o = { ...DEFAULTS, ...options };
  let mem = new WeakMap();       // gc → state (read once per start)
  let flights = new WeakMap();   // gc → the login in flight

  async function state(gc) {
    let st = mem.get(gc);
    if (!st) {
      let v = null;
      try { v = await gc.storage.get(key); } catch { v = null; }
      st = mem.get(gc) || clean(v);
      mem.set(gc, st);
    }
    return st;
  }

  async function save(gc, st) {
    try { await gc.storage.set(key, st); } catch (e) { gc.log.warn('login guard not saved', key, (e && e.code) || (e && e.message)); }
  }

  /** null = a login may happen now, else { reason, until }. */
  function refusal(st, now = clock.now()) {
    if (st.blocked) return { reason: 'blocked', until: 0 };
    if (now < st.retryAt) return { reason: 'wait', until: st.retryAt };
    const day = st.logins.filter((t) => now - t < DAY_MS);
    if (day.length >= o.perDay) return { reason: 'day', until: day[day.length - o.perDay] + DAY_MS };
    const hour = day.filter((t) => now - t < HOUR_MS);
    if (hour.length >= o.perHour) return { reason: 'hour', until: hour[hour.length - o.perHour] + HOUR_MS };
    return null;
  }

  async function block(gc, reason) {
    const st = await state(gc);
    if (st.blocked) return;
    st.blocked = reason;
    await save(gc, st);
    gc.log.warn(`login guard ${key}: automatic logins stopped (${reason}) until the account is connected again`);
    if (o.onBlock) {
      try { await o.onBlock(gc, reason); } catch (e) { gc.log.warn('login guard notice failed', (e && e.code) || (e && e.message)); }
    }
  }

  function refuse(no) {
    return Object.assign(new Error(`automatic login held back (${no.reason})`), { code: o.code, reason: no.reason, until: no.until });
  }

  /** The wait after a login that failed or did not help. */
  async function failed(gc) {
    const st = await state(gc);
    st.retryAt = clock.now() + o.backoffMs[Math.min(st.stage, o.backoffMs.length - 1)];
    st.stage += 1;
    await save(gc, st);
    return st.retryAt;
  }

  /**
   * One automatic login (`fn` logs in and stores what it got); parallel callers share it.
   * opts.fatal(e) → a reason when only a person can help (the guard blocks), opts.unsent(e) → true when
   * nothing reached the cloud (not counted).
   */
  function login(gc, fn, why = '', opts = {}) {
    const running = flights.get(gc);
    if (running) return running;
    const p = (async () => {
      const st = await state(gc);
      const now = clock.now();
      st.logins = st.logins.filter((t) => now - t < DAY_MS);
      const no = refusal(st, now);
      if (no) {
        if (no.reason === 'day' && o.sticky) await block(gc, 'limit');
        gc.log.debug(`login guard ${key}: no login (${no.reason})`, why);
        throw refuse(no);
      }
      st.logins.push(now);
      await save(gc, st);          // counted before the attempt: a crash never loses it
      gc.log.info(`login guard ${key}: logging in`, why, `(${st.logins.length} in 24 h)`);
      try {
        return await fn();
      } catch (e) {
        if (opts.unsent && opts.unsent(e)) { const i = st.logins.lastIndexOf(now); if (i >= 0) st.logins.splice(i, 1); }
        const until = await failed(gc);
        const reason = opts.fatal ? opts.fatal(e) : null;
        gc.log.warn(`login guard ${key}: login failed`, (e && e.code) || 'ERROR', reason ? `(${reason})` : `(next try in ${Math.round((until - clock.now()) / 60000)} min at the earliest)`);
        if (reason && o.sticky) await block(gc, reason);
        throw e;
      }
    })().finally(() => { if (flights.get(gc) === p) flights.delete(gc); });
    flights.set(gc, p);
    return p;
  }

  /** A normal call worked: no wait, no block, no pause (the login count stays). */
  async function ok(gc) {
    const st = mem.get(gc) || await state(gc);
    if (!st.stage && !st.retryAt && !st.blocked && !st.pauseUntil && !st.pauseStage) return;
    Object.assign(st, { stage: 0, retryAt: 0, blocked: null, pauseUntil: 0, pauseStage: 0 });
    await save(gc, st);
  }

  /** 429: every call waits (growing). → ms until then. */
  async function rateLimited(gc) {
    const st = await state(gc);
    const now = clock.now();
    if (now < st.pauseUntil) return st.pauseUntil - now;
    const ms = o.rateLimitMs[Math.min(st.pauseStage, o.rateLimitMs.length - 1)];
    st.pauseUntil = now + ms;
    st.pauseStage += 1;
    await save(gc, st);
    return ms;
  }

  /** ms the calls still wait after a 429 (0 = none). */
  async function paused(gc) {
    const st = mem.get(gc) || await state(gc);
    return Math.max(0, st.pauseUntil - clock.now());
  }

  /** A person signed in (or the account was removed): start over. */
  async function manual(gc) {
    const had = mem.get(gc) || await state(gc);
    const st = fresh();
    mem.set(gc, st);
    if (JSON.stringify(had) !== JSON.stringify(st)) await save(gc, st);
  }

  /** { blocked: reason|null, wait: reason|null, until } for the status. */
  async function view(gc) {
    const st = await state(gc);
    const no = refusal(st);
    return { blocked: st.blocked, wait: no && no.reason !== 'blocked' ? no.reason : null, until: no ? no.until : 0 };
  }

  /** Forget what is in memory (the storage stays): as after a restart. */
  function forget() { mem = new WeakMap(); flights = new WeakMap(); }

  return { key, login, failed, ok, block, rateLimited, paused, manual, view, state, refusal, forget, options: o };
}

module.exports = { createGuard, clock, HOUR_MS, DAY_MS, DEFAULTS };
