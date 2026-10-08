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
const COMMANDS = {
  ac_start: { needsSpin: false, validate: reqTemp, run: (c, vin, a) => c.startAc(vin, a.temp) },
  ac_stop: { needsSpin: false, validate: none, run: (c, vin) => c.stopAc(vin) },
  ac_temp: { needsSpin: false, validate: reqTemp, run: (c, vin, a) => c.setAcTemp(vin, a.temp) },
  window_heat_start: { needsSpin: false, validate: none, run: (c, vin) => c.startWindowHeating(vin) },
  window_heat_stop: { needsSpin: false, validate: none, run: (c, vin) => c.stopWindowHeating(vin) },
  charge_start: { needsSpin: false, validate: none, run: (c, vin) => c.startCharging(vin) },
  charge_stop: { needsSpin: false, validate: none, run: (c, vin) => c.stopCharging(vin) },
  charge_limit: {
    needsSpin: false,
    validate: (a) => { const l = num(a && a.limit); if (!CHARGE_STEPS.includes(l)) throw err('limit not allowed', 'SKODA_VALIDATION'); return { limit: l }; },
    run: (c, vin, a) => c.setChargeLimit(vin, a.limit),
  },
  lock: { needsSpin: true, validate: none, run: (c, vin, a, spin) => c.lock(vin, spin) },
  unlock: { needsSpin: true, validate: none, run: (c, vin, a, spin) => c.unlock(vin, spin) },
  timer_set: { needsSpin: false, validate: reqTimer, run: setTimer },
};

// ponytail: grows one entry per account ever touched; fine at household scale, per process.
const lockAttempts = new Map(); // accountId -> [timestamps]
function checkLockRate(accountId) {
  const now = Date.now();
  const arr = (lockAttempts.get(accountId) || []).filter((t) => now - t < LOCK_WINDOW_MS);
  if (arr.length >= LOCK_LIMIT) throw err('too many lock/unlock attempts', 'SKODA_COMMAND_RATE_LIMIT');
  arr.push(now);
  lockAttempts.set(accountId, arr);
}

/**
 * Run a command on a vehicle (callers check ownership / admin rights first).
 * @returns {Promise<{ok:true, refresh:Promise}>} refresh = the 30 s post-command sync (best effort)
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

  let spin = null;
  if (cmd.needsSpin) {
    spin = await store.getSpin(gc, accountId);
    if (!spin) throw err('S-PIN not set for this account', 'SKODA_SPIN_REQUIRED');
    checkLockRate(accountId); // counted BEFORE the cloud call — a wrong PIN counts too
  }

  await service.withAccountLock(accountId, async () => {
    await cmd.run(service.clientFor(gc, accountId), v.vin, normArgs, spin);
  });

  // command-triggered refresh in its own 30 s window (never blocks the answer)
  const refresh = service.refreshVehicle(gc, vehicleId, { afterCommand: true }).catch(() => { /* best effort; the next poll catches up */ });
  return { ok: true, refresh };
}

function reset() { lockAttempts.clear(); }

module.exports = { COMMANDS, WEEKDAYS, runCommand, reset };
