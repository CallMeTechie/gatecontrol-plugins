'use strict';

// GateControl 1.231.0 for the mock host (tools/testing/mock-host.js): gc.homeNetwork.internet — "Internet zu Hause"
// (src/services/homeInternet.js, hostApi.js internetCall, the child bootstrap's makeHomeNetwork; docs/plugins.md
// "Internet at home"). Opt-in: opts.gatecontrol ≥ '1.231.0' or opts.homeInternet; only a plugin with
// permissions.homeInternet: true has gc.homeNetwork.internet (an older GateControl ignores the key).
//
//   createHost(dir, { homeInternet: { people: { <userId>: { devices: 2, profile: { id, name, gateway },
//     nextSchedule: { from, to, block: 'all' | 'categories', categories, active } } } } })
//
// A person without an entry (or with devices 0) is not filtered: { profile: null, nextSchedule: null, devices: 0,
// filtered: false } — pause / extend still work (like the host: they change nothing yet). Like the host:
//   status(userId)            any time → { userId, profile, paused, extended (ISO | null), nextSchedule, devices, filtered }
//   pause(userId, until)      until = ISO time or whole minutes ≥ 1, at most 7 days ahead → status
//   resume(userId)            ends a pause (an extension stays) → status
//   extend(userId, minutes)   from the end of a running extension (else now) + minutes, ≤ 24 h ahead; 0 ends it → status
// pause / resume / extend only inside a changing host.request (POST/PUT/PATCH/DELETE) of a signed-in person (loggedIn not
// false, no kiosk, no automation) — those people are the actors — else ERR_NOT_PERSON; an unknown or disabled user /
// wrong times ERR_INVALID; without the permission ERR_HOME_INTERNET_DENIED. GateControl does not check who may decide
// for whom (the plugin does). host.homeInternet = { state: Map userId → { pause, extend } (ms), log: [{ op, userId,
// until (ISO | null), minutes?, actors: [userId] }] } — the activity log; host.homeInternetSet(userId, { pause, extend,
// devices, profile, nextSchedule }) changes what GateControl knows (e.g. a pause set elsewhere).

const MINUTE = 60000;
const MAX_PAUSE_MS = 7 * 24 * 60 * MINUTE;
const MAX_EXTEND_MS = 24 * 60 * MINUTE;

function install({ opts, perms, atLeast, enabledUser, hostError, personCtx }) {
  const o = opts.homeInternet && typeof opts.homeInternet === 'object' ? opts.homeInternet : null;
  const host = !!o || atLeast(231);
  if (host && perms.homeInternet != null && typeof perms.homeInternet !== 'boolean') throw hostError('ERR_INVALID', 'plugin.json: permissions.homeInternet: invalid');
  const on = host && perms.homeInternet === true;
  const people = new Map(Object.entries((o && o.people) || {}).map(([k, v]) => [Number(k), { ...v }]));
  const state = new Map();
  const log = [];
  const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

  const need = () => { if (perms.homeInternet !== true) throw hostError('ERR_HOME_INTERNET_DENIED', 'this plugin has no homeInternet permission'); };
  const user = (uid) => {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw hostError('ERR_INVALID', 'invalid user id');
    if (!enabledUser(uid)) throw hostError('ERR_INVALID', 'unknown or disabled person');
    return uid;
  };
  /** personContext.writers: the people with a changing request to this plugin in flight */
  const actors = () => {
    const out = [...personCtx.entries()].filter(([, e]) => e.write > 0).map(([uid]) => uid).sort((a, b) => a - b);
    if (!out.length) throw hostError('ERR_NOT_PERSON', 'only inside a changing request (POST/PUT/PATCH/DELETE) of a signed-in person');
    return out;
  };
  const current = (uid, now) => {
    const s = state.get(uid) || {};
    return { pause: s.pause > now ? s.pause : null, extend: s.extend > now ? s.extend : null };
  };
  const set = (uid, kind, until) => { const s = state.get(uid) || { pause: null, extend: null }; s[kind] = until; state.set(uid, s); };
  function status(uid, now = Date.now()) {
    const cur = current(uid, now);
    const p = people.get(uid) || {};
    const devices = Number.isInteger(p.devices) && p.devices > 0 ? p.devices : 0;
    const filtered = devices > 0;
    return {
      userId: uid, profile: filtered && p.profile ? { ...p.profile } : null, paused: iso(cur.pause), extended: iso(cur.extend),
      nextSchedule: filtered && p.profile && p.nextSchedule ? { ...p.nextSchedule } : null, devices, filtered,
    };
  }
  function untilFrom(value, now, max) {
    let until;
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value < 1) throw hostError('ERR_INVALID', 'minutes: a whole number ≥ 1');
      until = now + value * MINUTE;
    } else if (typeof value === 'string') {
      until = Date.parse(value);
      if (!Number.isFinite(until)) throw hostError('ERR_INVALID', 'until: an ISO time');
    } else throw hostError('ERR_INVALID', 'until: an ISO time or minutes');
    if (until <= now) throw hostError('ERR_INVALID', 'until lies in the past');
    if (until - now > max) throw hostError('ERR_INVALID', `at most ${Math.round(max / MINUTE)} minutes ahead`);
    return until;
  }

  const api = {
    'homeNetwork.internet.status': async ({ userId }) => { need(); return status(user(userId)); },
    'homeNetwork.internet.pause': async ({ userId, until }) => {
      need();
      const uid = user(userId);
      const who = actors();
      const now = Date.now();
      const at = untilFrom(until, now, MAX_PAUSE_MS);
      set(uid, 'pause', at);
      log.push({ op: 'pause', userId: uid, until: iso(at), actors: who });
      return status(uid, now);
    },
    'homeNetwork.internet.resume': async ({ userId }) => {
      need();
      const uid = user(userId);
      const who = actors();
      const now = Date.now();
      const had = current(uid, now).pause;
      set(uid, 'pause', null);
      if (had) log.push({ op: 'resume', userId: uid, until: null, actors: who });
      return status(uid, now);
    },
    'homeNetwork.internet.extend': async ({ userId, minutes }) => {
      need();
      const uid = user(userId);
      const who = actors();
      if (!Number.isInteger(minutes) || minutes < 0) throw hostError('ERR_INVALID', 'minutes: a whole number ≥ 0');
      const now = Date.now();
      const cur = current(uid, now).extend;
      if (minutes === 0) {
        set(uid, 'extend', null);
        if (cur) log.push({ op: 'extend', userId: uid, until: null, minutes: 0, actors: who });
        return status(uid, now);
      }
      const at = Math.max(now, cur || 0) + minutes * MINUTE;
      if (at - now > MAX_EXTEND_MS) throw hostError('ERR_INVALID', 'at most 24 hours ahead');
      set(uid, 'extend', at);
      log.push({ op: 'extend', userId: uid, until: iso(at), minutes, actors: who });
      return status(uid, now);
    },
  };

  /** gc.homeNetwork.internet (the child bootstrap's shape) */
  const gcPart = (call) => Object.freeze({
    status: (userId) => call('homeNetwork.internet.status', { userId }),
    pause: (userId, until) => call('homeNetwork.internet.pause', { userId, until }),
    resume: (userId) => call('homeNetwork.internet.resume', { userId }),
    extend: (userId, minutes) => call('homeNetwork.internet.extend', { userId, minutes }),
  });

  /** host.homeInternetSet(userId, { pause, extend (ms | ISO | null), devices, profile, nextSchedule }) */
  function hostSet(userId, x = {}) {
    const ms = (v) => (v == null ? null : (typeof v === 'string' ? Date.parse(v) : v));
    if ('pause' in x) set(userId, 'pause', ms(x.pause));
    if ('extend' in x) set(userId, 'extend', ms(x.extend));
    const p = people.get(userId) || {};
    for (const k of ['devices', 'profile', 'nextSchedule']) if (k in x) p[k] = x[k];
    people.set(userId, p);
  }

  return { on, api, gcPart, state: { state, log, people }, hostSet };
}

module.exports = { install, MAX_PAUSE_MS, MAX_EXTEND_MS };
