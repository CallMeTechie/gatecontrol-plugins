'use strict';

// Ring location modes — what the Ring app calls Modi: Inaktiv / Zuhause /
// Abwesend (API: disarmed / home / away). Which cameras record and notify in
// which mode is set up in the Ring app; this plugin only shows and switches
// the mode (server/ring.js has the endpoints and where they come from).
//
//   locations   devices/v1/locations with the device sync (every 10 min, after
//               a login, "Geräte aktualisieren"): name, number of cameras,
//               Ring Alarm base station yes/no (ring_devices base_stations)
//   mode        read every minute for each location that can switch (cameras,
//               no alarm); after a switch the answer of Ring is stored at once
//   switching   only when: the person may (rights.mayMode — administrators
//               always, others with "Ring-Modus schalten" for that location) ·
//               may act at all (no kiosk / device-trust viewer) · the location
//               supports it (no Ring Alarm — never switched here —, modes on in
//               the Ring app, not read-only) · the person's time window · at
//               most 10 switches per minute per person and per location
//   history     every attempt naming an existing location (kind 'mode', action
//               = the mode, via app / notification / automation / portal / admin)
//
// A failed read never touches the doorbell poll: its own back-off (1 min …
// 15 min, 429 → Retry-After), the error code is kept per location.

const store = require('./store');
const ring = require('./ring');
const rights = require('./rights');
const history = require('./history');
const { fail, rateLimiter, clip, iso } = require('./util');

const MODES = ring.MODES;
const POLL_EVERY_MS = 60000;
const BACKOFF_MIN_MS = 60000;
const BACKOFF_MAX_MS = 15 * 60000;
const MAX_LOCATIONS = 8;
const PER_MINUTE = 10;

// 24×24 stroke icons like the Ring app: a shield with an x / a person / a running person
const SHIELD = 'M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6z';
const ICONS = Object.freeze({
  device: SHIELD,
  disarmed: `${SHIELD}M9.5 9.5l5 5M14.5 9.5l-5 5`,
  home: `${SHIELD}M10.4 9.8a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0M8.8 16c.6-1.8 1.8-2.8 3.2-2.8s2.6 1 3.2 2.8`,
  away: `${SHIELD}M12.9 7.9a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0M13.2 10.4l-1.5 3.1 2 1.3-.7 2.7M13.2 10.4l2 1.5 1.4-.3M13.2 10.4l-2.3.5-.9 1.5M11.7 13.5l-1.3 1.7H8.7`,
});
// widget / tile colour of a mode
const TONE = Object.freeze({ disarmed: 'off', home: 'good', away: 'good' });

const mem = { lastPoll: 0, backoffUntil: 0, failures: 0 };
const userLimiter = rateLimiter(PER_MINUTE, 60000);
const locLimiter = rateLimiter(PER_MINUTE, 60000);
function reset() {
  mem.lastPoll = 0; mem.backoffUntil = 0; mem.failures = 0;
  userLimiter.reset(); locLimiter.reset();
}

async function all(gc) {
  return store.all(gc, 'SELECT * FROM ring_locations ORDER BY present DESC, alarm, name, location_id');
}

async function get(gc, id) {
  if (typeof id !== 'string' || !ring.LOCATION_RE.test(id)) return null;
  return store.one(gc, 'SELECT * FROM ring_locations WHERE location_id = ?', [id]);
}

/** Why a location's mode cannot be switched now, or null: gone | alarm | no_cameras | unknown | error | disabled | read_only */
function why(row) {
  if (!row || !row.present) return 'gone';
  if (row.alarm) return 'alarm';
  if (!row.cameras) return 'no_cameras';
  if (row.mode == null) return row.error ? 'error' : 'unknown';
  if (!MODES.includes(row.mode)) return 'disabled';
  if (row.read_only) return 'read_only';
  return null;
}

const supported = (row) => why(row) === null;
/** The mode is read for these: present, cameras there, no Ring Alarm. */
const readable = (row) => !!row && row.present === 1 && row.alarm === 0 && row.cameras > 0;

async function saveMode(gc, id, m, now) {
  await store.tx(gc, () => store.run(gc, 'UPDATE ring_locations SET mode = ?, read_only = ?, mode_at = ?, checked_at = ?, error = NULL WHERE location_id = ?',
    [m.mode, m.readOnly ? 1 : 0, m.at, now, id]));
}

function backoff(e, now) {
  if (e && e.code === 'ring_rate_limited') {
    mem.backoffUntil = now + Math.max(60, (e.extra && e.extra.retryAfter) || 60) * 1000;
    return;
  }
  mem.failures = Math.min(mem.failures + 1, 10);
  mem.backoffUntil = now + Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (mem.failures - 1));
}

/**
 * Read the mode of every readable location (force: now, else at most every minute and not while
 * backing off). Errors are kept per location and never thrown.
 */
async function refresh(gc, now, { force = false } = {}) {
  if (!force && (now - mem.lastPoll < POLL_EVERY_MS || now < mem.backoffUntil)) return;
  mem.lastPoll = now;
  for (const row of (await all(gc)).filter(readable)) {
    try {
      await saveMode(gc, row.location_id, await ring.getMode(gc, row.location_id), now);
      mem.failures = 0;
    } catch (e) {
      const code = (e && e.code) || 'ring_mode_failed';
      gc.log.debug('ring mode read failed', code, (e && e.extra && e.extra.httpStatus) || '');
      try { await store.tx(gc, () => store.run(gc, 'UPDATE ring_locations SET error = ? WHERE location_id = ?', [code, row.location_id])); } catch { /* best effort */ }
      backoff(e, now);
      if (['ring_login_failed', 'ring_not_connected', 'ring_rate_limited'].includes(code)) return;
    }
  }
}

/**
 * The locations of the account (with the device sync): inv = ring.inventory() (devices for the camera
 * count, alarmLocations). Locations no longer listed stay with present = 0 (rights are kept). Then the
 * modes are read at once.
 */
async function syncLocations(gc, inv, now) {
  const list = (await ring.locations(gc)).slice(0, MAX_LOCATIONS);
  const cams = new Map();
  for (const d of inv.devices) if (d.locationId) cams.set(d.locationId, (cams.get(d.locationId) || 0) + 1);
  const alarm = new Set(inv.alarmLocations);
  await store.tx(gc, async () => {
    await store.run(gc, 'UPDATE ring_locations SET present = 0');
    for (const l of list) {
      await store.run(gc, `INSERT INTO ring_locations (location_id, name, cameras, alarm, present, updated_at) VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(location_id) DO UPDATE SET name = excluded.name, cameras = excluded.cameras, alarm = excluded.alarm, present = 1, updated_at = excluded.updated_at`,
      [l.locationId, l.name || l.locationId, cams.get(l.locationId) || 0, alarm.has(l.locationId) ? 1 : 0, now]);
    }
  });
  await refresh(gc, now, { force: true });
  return list.length;
}

/** Background: the mode poll (blocked = the doorbell poll is backing off). */
async function tick(gc, cfg, now, blocked) {
  if (!cfg.ring || blocked) return;
  if (!(await ring.hasToken(gc))) return;
  await refresh(gc, now);
}

const ERRORS = new Set(['ring_mode_refused', 'ring_mode_failed', 'ring_mode_unreachable', 'ring_login_failed', 'ring_not_connected', 'ring_rate_limited']);

/**
 * Switch location `id` to `mode` for `user`.
 *   ctx = { cfg, t, lang, now, via: 'app'|'portal'|'notification'|'automation'|'admin', caller, adminPage }
 *   adminPage: the plugin's admin page (an administrator in GateControl's admin UI) — no viewer checks.
 * → { ok: true, message: 'Ring: Zuhause', location } — throws fail(code) after writing the history.
 */
async function perform(gc, ctx, user, id, mode) {
  const { cfg, t, now } = ctx;
  const lang = ctx.lang === 'en' ? 'en' : 'de';
  const automation = !!(user && user.automation === true);
  const via = automation ? 'automation' : (ctx.via || 'app');
  let row = await get(gc, id);
  if (!row || !row.present) throw fail('not_found');
  if (!MODES.includes(mode)) throw fail('invalid');
  const r = await rights.load(gc);
  const record = (result, reason) => store.tx(gc, () => history.add(gc, {
    at: now, kind: 'mode', locationId: id, userId: user.id, userName: user.name || null, via,
    caller: automation ? ctx.caller || user.via || null : null, action: mode, result, reason,
  }));
  const refuse = async (code, extra) => {
    await record('refused', code);
    throw fail(code, extra);
  };
  const unsupported = async (w) => {
    if (w === 'alarm') await refuse('mode_alarm');
    if (w === 'no_cameras' || w === 'disabled' || w === 'gone') await refuse('mode_disabled');
    if (w === 'read_only') await refuse('mode_read_only');
  };

  if (!rights.mayMode(r, user, id)) await refuse('no_right');
  if (!ctx.adminPage && !rights.canAct(user)) await refuse('read_only');
  await unsupported(why(row));
  if (!ctx.adminPage && !rights.windowAllows(rights.prefsOf(r, user.id).window, now, cfg.timezone)) await refuse('outside_window');
  const uKey = `u:${user.id}`;
  const lKey = `l:${id}`;
  const ra = Math.max(userLimiter.retryAfter(uKey, now), locLimiter.retryAfter(lKey, now));
  if (ra > 0) await refuse('rate_limited', { retryAfter: ra });
  userLimiter.hit(uKey, now);
  locLimiter.hit(lKey, now);
  if (!(await ring.hasToken(gc))) await refuse('ring_not_connected');

  const failed = async (e) => {
    const code = e && ERRORS.has(e.code) ? e.code : 'ring_mode_failed';
    await record('failed', code);
    gc.log.warn('ring mode switch failed', mode, code, (e && e.extra && e.extra.httpStatus) || '');
    throw fail(code, e && e.extra ? e.extra : null);
  };
  // never read yet (or the last read failed): ask Ring first — it may say modes are off or read-only
  if (row.mode == null) {
    try { await saveMode(gc, id, await ring.getMode(gc, id), now); } catch (e) { await failed(e); }
    row = await get(gc, id);
    await unsupported(why(row));
  }
  let m;
  try { m = await ring.setMode(gc, id, mode); } catch (e) { await failed(e); }
  await saveMode(gc, id, m, now);
  if (m.mode !== mode) {
    await record('failed', 'ring_mode_mismatch');
    gc.log.warn('ring mode switch not taken', mode, m.mode);
    throw fail('ring_mode_mismatch', { mode: m.mode });
  }
  await record('ok', null);
  return { ok: true, message: clip(t(lang, 'mode.done', { mode: t(lang, 'mode.' + mode) }), 120), location: await get(gc, id) };
}

/** The name of a mode in the viewer's language (unknown values as they are). */
function modeName(t, lang, mode) {
  if (mode == null) return t(lang, 'mode.unknown');
  return ['disarmed', 'home', 'away', 'disabled', 'unset'].includes(mode) ? t(lang, 'mode.' + mode) : String(mode);
}

/** A location for a person (portal, app API). */
function view(row, { user, r, cfg, now }) {
  let blocked = null;
  if (!rights.canAct(user)) blocked = 'read_only';
  else if (!rights.windowAllows(rights.prefsOf(r, user.id).window, now, cfg.timezone)) blocked = 'outside_window';
  return {
    id: row.location_id, name: row.name, mode: MODES.includes(row.mode) ? row.mode : null, modes: [...MODES],
    blocked, modeAt: iso(row.mode_at), checkedAt: iso(row.checked_at),
  };
}

/** A location for the admin page (also the ones that cannot switch, with the reason). */
function adminView(row) {
  return {
    id: row.location_id, name: row.name, mode: row.mode || null, supported: supported(row), why: why(row),
    cameras: row.cameras, alarm: row.alarm === 1, readOnly: row.read_only === 1, error: row.error || null,
    present: row.present === 1, modeAt: iso(row.mode_at), checkedAt: iso(row.checked_at),
  };
}

/** The locations a person may switch (supported ones only). */
async function forUser(gc, user, r) {
  if (!user || !Number.isSafeInteger(user.id)) return [];
  return (await all(gc)).filter((row) => supported(row) && rights.mayMode(r, user, row.location_id));
}

const QA_RE = /^mode_(disarmed|home|away):([0-9A-Za-z_-]{1,48})$/;
const CARRIER = 'disarmed';

/** The widget of a location (carried by its "Inaktiv" button): the mode and a choice to switch it. */
function widgetOf(t, lang, row) {
  return {
    label: t(lang, 'mode.widget_label'), value: modeName(t, lang, row.mode), state: TONE[row.mode] || null, power: false,
    controls: [{ id: 'mode', kind: 'choice', label: t(lang, 'mode.control'), value: row.mode, options: MODES.map((m) => ({ id: m, label: t(lang, 'mode.' + m), icon: ICONS[m] })) }],
  };
}

/** The three quick-action buttons of a location (device ring:<id>; "Inaktiv" carries the widget). */
function quickActions(t, lang, row) {
  const device = { id: `ring:${row.location_id}`, title: clip(row.name, 40) || t(lang, 'mode.device'), subtitle: t(lang, 'mode.widget_label'), icon: ICONS.device };
  const subtitle = clip(t(lang, 'mode.current', { mode: modeName(t, lang, row.mode) }), 60);
  return MODES.map((m) => ({
    id: `mode_${m}:${row.location_id}`, title: t(lang, 'mode.' + m), subtitle, icon: ICONS[m], kind: 'button', confirm: false, device,
    ...(m === CARRIER ? { widget: widgetOf(t, lang, row) } : {}),
  }));
}

module.exports = {
  MODES, ICONS, TONE, QA_RE, CARRIER, POLL_EVERY_MS, PER_MINUTE,
  reset, all, get, why, supported, readable, refresh, syncLocations, tick, perform, modeName, view, adminView, forUser, widgetOf, quickActions,
  _mem: mem,
};
