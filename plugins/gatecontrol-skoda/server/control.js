'use strict';

// Remote commands (port of GateControl's src/services/skoda/skodaControl.js):
// climate, window heating, charging, charge limit, lock/unlock (S-PIN) and
// departure timers. Run under the account lock like the sync.

const store = require('./store');
const service = require('./service');

const TEMP_MIN = 15.5, TEMP_MAX = 30;
const CHARGE_STEPS = [50, 60, 70, 80, 90, 100];
const LOCK_LIMIT = 5, LOCK_WINDOW_MS = 15 * 60 * 1000;
const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function err(message, code) { return Object.assign(new Error(message), { code }); }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : NaN; }

function reqTemp(a) {
  const t = num(a && a.temp);
  if (!Number.isFinite(t) || t < TEMP_MIN || t > TEMP_MAX) throw err('temp out of range', 'SKODA_VALIDATION');
  return { temp: t };
}

function reqTimer(a) {
  const id = num(a && a.id); // typeof-based: "1" or true do not pass
  if (!Number.isInteger(id) || id <= 0) throw err('timer id invalid', 'SKODA_VALIDATION');
  if (typeof (a && a.enabled) !== 'boolean') throw err('enabled must be a boolean', 'SKODA_VALIDATION');
  if (typeof (a && a.time) !== 'string' || !TIME_RE.test(a.time)) throw err('time must be HH:MM', 'SKODA_VALIDATION');
  if (!Array.isArray(a && a.days) || !a.days.length || a.days.length > WEEKDAYS.length) throw err('one to seven weekdays required', 'SKODA_VALIDATION');
  const days = [...new Set(a.days)];
  // value allowlist, not an object key — '__proto__' fails here
  if (days.some((d) => !WEEKDAYS.includes(d))) throw err('unknown weekday', 'SKODA_VALIDATION');
  days.sort((x, y) => WEEKDAYS.indexOf(x) - WEEKDAYS.indexOf(y));
  return { id, enabled: a.enabled, time: a.time, days };
}

// A fresh read instead of the cached state: `type` must never come from the
// request (a client could switch a timer to ONE_OFF), and a state up to one
// poll interval old would silently undo a change made in the Škoda app.
async function setTimer(c, vin, a) {
  const ac = await c.airConditioning(vin);
  const found = (ac && Array.isArray(ac.timers) ? ac.timers : []).find((t) => t && t.id === a.id);
  if (!found) throw err('timer slot not found', 'SKODA_TIMER_NOT_FOUND');
  // ONE_OFF slots stay untouched — the behaviour of selectedDays there is unknown
  if (found.type !== 'RECURRING') throw err('timer is not recurring', 'SKODA_TIMER_READONLY');
  return c.setAcTimer(vin, { id: a.id, enabled: a.enabled, time: a.time, type: found.type, selectedDays: a.days });
}

const none = () => ({});
// expects: [kind, state] the vehicle should report once it applied the command (see expectedState)
const COMMANDS = {
  ac_start: { needsSpin: false, validate: reqTemp, run: (c, vin, a) => c.startAc(vin, a.temp), expects: ['climate', 'on'] },
  ac_stop: { needsSpin: false, validate: none, run: (c, vin) => c.stopAc(vin), expects: ['climate', 'off'] },
  ac_temp: { needsSpin: false, validate: reqTemp, run: (c, vin, a) => c.setAcTemp(vin, a.temp) },
  window_heat_start: { needsSpin: false, validate: none, run: (c, vin) => c.startWindowHeating(vin), expects: ['windowheat', 'on'] },
  window_heat_stop: { needsSpin: false, validate: none, run: (c, vin) => c.stopWindowHeating(vin), expects: ['windowheat', 'off'] },
  charge_start: { needsSpin: false, validate: none, run: (c, vin) => c.startCharging(vin), expects: ['charging', 'on'] },
  charge_stop: { needsSpin: false, validate: none, run: (c, vin) => c.stopCharging(vin), expects: ['charging', 'off'] },
  charge_limit: {
    needsSpin: false,
    validate: (a) => { const l = num(a && a.limit); if (!CHARGE_STEPS.includes(l)) throw err('limit not allowed', 'SKODA_VALIDATION'); return { limit: l }; },
    run: (c, vin, a) => c.setChargeLimit(vin, a.limit),
  },
  lock: { needsSpin: true, validate: none, run: (c, vin, a, spin) => c.lock(vin, spin), expects: ['lock', 'on'] },
  unlock: { needsSpin: true, validate: none, run: (c, vin, a, spin) => c.unlock(vin, spin), expects: ['lock', 'off'] },
  timer_set: { needsSpin: false, validate: reqTimer, run: setTimer },
};

// ─── Expected state after a command ─────────────
// The cloud accepts a command at once, but the vehicle needs about 20–60 s to
// apply it and report the new state — a sync right away still reads the old
// one. So for EXPECT_MS after a successful command the apps show the state the
// vehicle should report (kind: climate | charging | windowheat | lock; 'on' /
// 'off', lock: on = locked) instead of the reported one. The entry goes as
// soon as the reported state equals it, or when it expires. Memory only
// (a restart forgets it); reset() clears it.
const EXPECT_MS = 3 * 60 * 1000;
const expected = new Map(); // `${vehicleId}:${kind}` -> { state, until }

/** The state to show for a vehicle's toggle: the expected one while it is unexpired and differs from `reported`, else `reported`. */
function expectedState(vehicleId, kind, reported) {
  const key = `${vehicleId}:${kind}`;
  const e = expected.get(key);
  if (!e) return reported;
  if (Date.now() >= e.until || e.state === reported) { expected.delete(key); return reported; }
  return e.state;
}

// ─── Post-command refresh ────────────────────────
// The sync after a command waits until the vehicle has most likely applied it
// (see above). Several commands in a row share one refresh, REFRESH_DELAY_MS
// after the last; the cooldown of service.refreshVehicle applies as before.
const REFRESH_DELAY_MS = 45 * 1000;
let refreshDelayMs = REFRESH_DELAY_MS;
const pendingRefresh = new Map(); // vehicleId -> { timer, promise, resolve }

/** Schedules (or postpones) the vehicle's post-command refresh → a promise of its result (undefined when skipped or failed). */
function scheduleRefresh(gc, vehicleId) {
  let p = pendingRefresh.get(vehicleId);
  if (p) clearTimeout(p.timer);
  else {
    p = {};
    p.promise = new Promise((resolve) => { p.resolve = resolve; });
    pendingRefresh.set(vehicleId, p);
  }
  const entry = p;
  entry.timer = setTimeout(() => {
    pendingRefresh.delete(vehicleId);
    service.refreshVehicle(gc, vehicleId, { afterCommand: true })
      .catch(() => { /* best effort (cooldown, cloud error); the next poll catches up */ })
      .then(entry.resolve);
  }, refreshDelayMs);
  entry.timer.unref?.();
  return entry.promise;
}

/** Tests: the delay of the post-command refresh in ms (null: the default 45 s). */
function _setRefreshDelayForTest(ms) { refreshDelayMs = ms == null ? REFRESH_DELAY_MS : ms; }

// ponytail: grows one entry per account ever touched; fine at household scale, per process.
const lockAttempts = new Map(); // accountId -> [timestamps]
function checkLockRate(accountId) {
  const now = Date.now();
  const arr = (lockAttempts.get(accountId) || []).filter((t) => now - t < LOCK_WINDOW_MS);
  if (arr.length >= LOCK_LIMIT) throw err('too many lock/unlock attempts', 'SKODA_COMMAND_RATE_LIMIT');
  arr.push(now);
  lockAttempts.set(accountId, arr);
}

// ─── Refused S-PIN ──────────────────────────────
// Škoda locks the S-PIN for 24 hours after a few wrong tries. So once the
// cloud refuses a lock/unlock (HTTP 4xx except 401 = session, 429 = rate
// limit, which have their own codes) the stored S-PIN is marked as rejected
// (store.markSpinRejected) and never sent again until a new one is saved.

/** Did the Škoda cloud refuse the command itself (a wrong S-PIN, among others)? */
function spinRefused(e) {
  return Boolean(e) && e.code === 'SKODA_API_ERROR' && Number.isInteger(e.status)
    && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429;
}

/** The account's S-PIN, when one is stored and Škoda has not refused it. */
async function usableSpin(gc, accountId) {
  const spin = await store.getSpin(gc, accountId);
  if (!spin) throw err('S-PIN not set for this account', 'SKODA_SPIN_REQUIRED');
  if (await store.isSpinRejected(gc, accountId)) throw err('Škoda refused the stored S-PIN — re-enter it', 'SKODA_SPIN_REJECTED');
  return spin;
}

/**
 * Run a command on a vehicle (callers check ownership / admin rights first).
 * @returns {Promise<{ok:true, refresh:Promise}>} refresh = the delayed post-command sync (best effort, never rejects)
 */
async function runCommand(gc, vehicleId, action, args) {
  // hasOwnProperty guard: no prototype key (constructor/…) as an action
  const cmd = typeof action === 'string' && Object.prototype.hasOwnProperty.call(COMMANDS, action) ? COMMANDS[action] : null;
  if (!cmd) throw err(`unknown command ${String(action).slice(0, 40)}`, 'SKODA_UNKNOWN_COMMAND');
  const normArgs = cmd.validate(args && typeof args === 'object' ? args : {});

  const v = await store.getVehicle(gc, vehicleId);
  if (!v || !v.vin) throw err('vehicle not found', 'SKODA_VEHICLE_NOT_FOUND');
  const accountId = v.account_id;

  // Without an active session (new account before its first sync, or after
  // login_failed/error): a typed 409 instead of an untyped error.
  if (!(await store.getAccount(gc, accountId)) || !(await store.getSession(gc, accountId))) {
    throw err('account has no active session — re-sync/re-login required', 'SKODA_NO_SESSION');
  }

  if (cmd.needsSpin) {
    await usableSpin(gc, accountId); // a refused S-PIN fails here, before it counts as an attempt
    checkLockRate(accountId); // counted BEFORE the cloud call — a wrong PIN counts too
  }

  await service.withAccountLock(accountId, async () => {
    // read again under the lock: a command queued behind one whose S-PIN Škoda just refused sends nothing
    const spin = cmd.needsSpin ? await usableSpin(gc, accountId) : null;
    try {
      await cmd.run(service.clientFor(gc, accountId), v.vin, normArgs, spin);
    } catch (e) {
      if (spin && spinRefused(e) && (await store.markSpinRejected(gc, accountId, spin))) {
        e.spinRejected = true;
        gc.log.warn('Škoda refused the stored S-PIN — no lock/unlock until it is re-entered', `account ${accountId}`, `HTTP ${e.status}`);
      }
      throw e;
    }
  });

  if (cmd.expects) expected.set(`${vehicleId}:${cmd.expects[0]}`, { state: cmd.expects[1], until: Date.now() + EXPECT_MS });
  // command-triggered refresh once the vehicle has applied it, in its own 30 s window (never blocks the answer)
  const refresh = scheduleRefresh(gc, vehicleId);
  return { ok: true, refresh };
}

function reset() {
  lockAttempts.clear();
  expected.clear();
  for (const p of pendingRefresh.values()) { clearTimeout(p.timer); p.resolve(); }
  pendingRefresh.clear();
}

module.exports = { COMMANDS, WEEKDAYS, EXPECT_MS, REFRESH_DELAY_MS, runCommand, expectedState, reset, _setRefreshDelayForTest };
