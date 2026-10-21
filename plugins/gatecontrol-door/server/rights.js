'use strict';

// Rights per GateControl user and lock (admin page "Berechtigungen"):
//   none (no row) · view · lock (lock + unlock) · open (lock, unlock, unlatch / opener "Summer")
// plus per user an optional weekly time window for every action and the
// opt-in "Automatisch aufsperren bei Ankunft erlauben" (default off).
//
// plus per user and Ring location the right "Ring-Modus schalten" (Inaktiv /
// Zuhause / Abwesend — server/modes.js).
//
// 1.5.0: a camera follows the rights of the lock it is linked to (view or
// more); a camera without a lock has its own list of people who see it
// (camera_rights) — they see it in the apps and the portal, get its pushes and
// find its rings in the history.
//
// Administrators get no lock rights automatically: they set their own rights
// like anyone. The Ring mode is the exception — administrators may always
// switch it (it is a setting of the house, like the plugin's own settings). Kiosk devices and portal viewers recognised only by device trust
// may look (view) but never act. Every action is checked here again on the
// server, wherever it comes from (app, portal, notification, automation).

const store = require('./store');
const tz = require('./tz');
const { fail, parseJson, TIME_RE } = require('./util');

const LEVELS = Object.freeze({ view: 1, lock: 2, open: 3 });
const ACTIONS = Object.freeze(['lock', 'unlock', 'open']);
/** The right an action needs. */
const NEEDS = Object.freeze({ lock: 'lock', unlock: 'lock', open: 'open' });

const atLeast = (level, min) => !!level && (LEVELS[level] || 0) >= LEVELS[min];

/** May this viewer act at all (not just look)? Kiosk devices and device-trust portal viewers may not. */
function canAct(user) {
  if (!user || !Number.isSafeInteger(user.id)) return false;
  if (user.kiosk === true) return false;
  if (user.automation === true) return true;
  // 1.3.0: a person's tap in another plugin (the Messenger's chat card) — GateControl's interactive run
  if (user.interactive === true) return true;
  if (user.app === true) return user.loggedIn !== false;
  if (user.portal === true) return user.loggedIn === true;
  return false;
}

/** A time window from the admin page: { days: [1..7] (Monday = 1), from: 'HH:MM', to: 'HH:MM' } or null. */
function parseWindow(v) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw fail('invalid', { field: 'window' });
  const days = Array.isArray(v.days) ? [...new Set(v.days)] : null;
  if (!days || !days.length || !days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) throw fail('invalid', { field: 'window' });
  if (typeof v.from !== 'string' || !TIME_RE.test(v.from) || typeof v.to !== 'string' || !TIME_RE.test(v.to) || v.from === v.to) throw fail('invalid', { field: 'window' });
  return { days: days.sort((a, b) => a - b), from: v.from, to: v.to };
}

/**
 * Does the window allow `ms` (in zone `zone`)? from inclusive, to exclusive; a window over midnight
 * (22:00–06:00) belongs to the day it starts on. No window = always.
 */
function windowAllows(win, ms, zone) {
  if (!win) return true;
  const l = tz.local(ms, zone);
  const from = tz.minutesOf(win.from);
  const to = tz.minutesOf(win.to);
  if (from < to) return win.days.includes(l.wd) && l.minutes >= from && l.minutes < to;
  if (l.minutes >= from) return win.days.includes(l.wd);
  if (l.minutes < to) return win.days.includes(l.wd === 1 ? 7 : l.wd - 1);
  return false;
}

/**
 * Everything about rights in one read: { levels: Map(userId → Map(lockId → level)), prefs: Map(userId →
 * { autoUnlock, window }), modes: Map(userId → Set(locationId)) }
 */
async function load(gc) {
  const levels = new Map();
  for (const r of await store.all(gc, 'SELECT user_id, lock_id, level FROM rights')) {
    if (!levels.has(r.user_id)) levels.set(r.user_id, new Map());
    levels.get(r.user_id).set(r.lock_id, r.level);
  }
  const prefs = new Map();
  for (const p of await store.all(gc, 'SELECT user_id, auto_unlock, time_window FROM user_prefs')) {
    let win = null;
    try { win = parseWindow(parseJson(p.time_window, null)); } catch { win = null; }
    prefs.set(p.user_id, { autoUnlock: p.auto_unlock === 1, window: win });
  }
  const modes = new Map();
  for (const m of await store.all(gc, 'SELECT user_id, location_id FROM mode_rights')) {
    if (!modes.has(m.user_id)) modes.set(m.user_id, new Set());
    modes.get(m.user_id).add(m.location_id);
  }
  const cams = new Map();
  for (const c of await store.all(gc, 'SELECT user_id, camera_id FROM camera_rights')) {
    if (!cams.has(c.user_id)) cams.set(c.user_id, new Set());
    cams.get(c.user_id).add(c.camera_id);
  }
  return { levels, prefs, modes, cams };
}

/** Does this user see the camera (a cameras row)? Linked: a right on its lock; unlinked: its own list (1.5.0). */
function seesCamera(r, userId, cam) {
  if (!cam) return false;
  if (cam.lock_id) return !!levelOf(r, userId, cam.lock_id);
  const s = r.cams && r.cams.get(userId);
  return !!s && s.has(cam.id);
}

/** The people who see a camera → [userId] (they get its pushes). */
function cameraViewers(r, cam) {
  if (!cam) return [];
  if (cam.lock_id) return usersWith(r, cam.lock_id, 'view');
  const out = [];
  for (const [userId, s] of r.cams || []) if (s.has(cam.id)) out.push(userId);
  return out.sort((a, b) => a - b);
}

/** May this user switch the Ring mode of a location? Administrators always; others with the right. */
function mayMode(r, user, locationId) {
  if (!user || !Number.isSafeInteger(user.id)) return false;
  if (user.role === 'admin') return true;
  const s = r.modes && r.modes.get(user.id);
  return !!s && s.has(locationId);
}

function levelOf(r, userId, lockId) {
  const m = r.levels.get(userId);
  return (m && m.get(lockId)) || null;
}

function prefsOf(r, userId) {
  return r.prefs.get(userId) || { autoUnlock: false, window: null };
}

/** Users with at least `min` on a lock → [userId]. */
function usersWith(r, lockId, min) {
  const out = [];
  for (const [userId, m] of r.levels) if (atLeast(m.get(lockId), min)) out.push(userId);
  return out.sort((a, b) => a - b);
}

/** Has this user any right at all (portal tab, app tab)? 1.5.0: also a camera without a lock. */
function hasAny(r, userId) {
  const m = r.levels.get(userId);
  const c = r.cams && r.cams.get(userId);
  return (!!m && m.size > 0) || (!!c && c.size > 0);
}

module.exports = { LEVELS, ACTIONS, NEEDS, atLeast, canAct, parseWindow, windowAllows, load, levelOf, prefsOf, usersWith, hasAny, mayMode, seesCamera, cameraViewers };
