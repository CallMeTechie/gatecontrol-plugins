'use strict';

// The plugin's own settings — what GateControl's DNS protection (gc.vpnDns) does not keep: who may suspend the
// protection in the apps and for how long, who sees the query log, the notices. One JSON value under the plugin key
// 'dns.config' (gc.settings.set keeps undeclared keys of the plugin's own); 'dns.state' holds what the background
// run remembers (the week of the last report).

const { fail } = require('./util');

const KEY = 'dns.config';
const STATE_KEY = 'dns.state';
const MAX_MINUTES = [5, 30, 60, 240];
const DEFAULTS = Object.freeze({
  setupDone: false,          // the set-up dialog was finished or put off ("Später")
  pause: Object.freeze({
    who: 'all',              // who may suspend in the apps: 'admins' | 'all' | 'profile' (per profile, see `profiles`)
    maxMinutes: 60,          // the longest duration for users (5 | 30 | 60 | 240)
    forever: false,          // "Bis ich wieder einschalte" also for users
    profiles: Object.freeze({}), // profile id → false: members of this profile may not suspend (only with who 'profile')
  }),
  logView: 'admins',         // who sees the query log: 'admins' | 'own' (users see their own devices in the portal)
  // outage: administrators; outageUsers: also the people whose VPN devices are filtered ("Filter ausgefallen")
  notify: Object.freeze({ outage: true, outageUsers: false, weekly: false }),
});
const ID_RE = /^[a-z0-9_-]{1,32}$/;

function normalise(v) {
  const r = v && typeof v === 'object' ? v : {};
  const p = r.pause && typeof r.pause === 'object' ? r.pause : {};
  const n = r.notify && typeof r.notify === 'object' ? r.notify : {};
  const profiles = {};
  if (p.profiles && typeof p.profiles === 'object') for (const [id, on] of Object.entries(p.profiles)) if (ID_RE.test(id) && on === false) profiles[id] = false;
  return {
    setupDone: r.setupDone === true,
    pause: {
      who: ['admins', 'all', 'profile'].includes(p.who) ? p.who : DEFAULTS.pause.who,
      maxMinutes: MAX_MINUTES.includes(p.maxMinutes) ? p.maxMinutes : DEFAULTS.pause.maxMinutes,
      forever: p.forever === true,
      profiles,
    },
    logView: r.logView === 'own' ? 'own' : 'admins',
    notify: { outage: n.outage !== false, outageUsers: n.outageUsers === true, weekly: n.weekly === true },
  };
}

async function read(gc, key) {
  let v = null;
  try { v = await gc.settings.get(key); } catch { v = null; }
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  return v;
}

const load = async (gc) => normalise(await read(gc, KEY));

/** A change from the settings page: only known keys, each checked. */
async function save(gc, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail('invalid');
  const next = await load(gc);
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'setupDone') { if (typeof v !== 'boolean') throw fail('invalid', { detail: k }); next.setupDone = v; } else if (k === 'logView') {
      if (v !== 'admins' && v !== 'own') throw fail('invalid', { detail: k });
      next.logView = v;
    } else if (k === 'pause') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail('invalid', { detail: k });
      for (const [f, x] of Object.entries(v)) {
        if (f === 'who') { if (!['admins', 'all', 'profile'].includes(x)) throw fail('invalid', { detail: 'pause.who' }); next.pause.who = x; } else if (f === 'maxMinutes') {
          if (!MAX_MINUTES.includes(x)) throw fail('invalid', { detail: 'pause.maxMinutes' });
          next.pause.maxMinutes = x;
        } else if (f === 'forever') { if (typeof x !== 'boolean') throw fail('invalid', { detail: 'pause.forever' }); next.pause.forever = x; } else if (f === 'profiles') {
          if (!x || typeof x !== 'object' || Array.isArray(x)) throw fail('invalid', { detail: 'pause.profiles' });
          for (const [id, on] of Object.entries(x)) {
            if (!ID_RE.test(id) || typeof on !== 'boolean') throw fail('invalid', { detail: 'pause.profiles' });
            if (on) delete next.pause.profiles[id]; else next.pause.profiles[id] = false;
          }
        } else throw fail('invalid', { detail: 'pause.' + f });
      }
    } else if (k === 'notify') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail('invalid', { detail: k });
      for (const [f, x] of Object.entries(v)) {
        if (!['outage', 'outageUsers', 'weekly'].includes(f) || typeof x !== 'boolean') throw fail('invalid', { detail: 'notify.' + f });
        next.notify[f] = x;
      }
    } else throw fail('invalid', { detail: k });
  }
  await gc.settings.set(KEY, next);
  return next;
}

/** Forget the switches of profiles that are gone. */
async function prune(gc, profileIds) {
  const cur = await load(gc);
  const gone = Object.keys(cur.pause.profiles).filter((id) => !profileIds.includes(id));
  if (!gone.length) return cur;
  for (const id of gone) delete cur.pause.profiles[id];
  await gc.settings.set(KEY, cur);
  return cur;
}

async function loadState(gc) {
  const v = await read(gc, STATE_KEY);
  return v && typeof v === 'object' ? v : {};
}
const saveState = (gc, s) => gc.settings.set(STATE_KEY, s);

module.exports = { load, save, prune, normalise, loadState, saveState, DEFAULTS, KEY, STATE_KEY, MAX_MINUTES };
