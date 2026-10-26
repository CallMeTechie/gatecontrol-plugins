'use strict';

// 1.4.0 — the Familie plugin's services the messenger uses (permissions.services), each feature-detected
// with gc.services.available (GateControl ≥ 1.178.0; on 1.177.x there is no way to ask, so none is used):
//   list_add        { userId, list: 'shopping' | <listId>, items (1–50, ≤ 120) } → { listId, listName, added, skipped, itemIds }   POST messages/:id/to-list
//   calendar_add    { userId, title ≤ 80, startsAt, endsAt?, allDay?, place? } → { eventId }   POST messages/:id/to-calendar
//   calendar_upsert { sourceRef 'messenger:<msgId>', title, startsAt, endsAt?, allDay?, place?, userIds? } / calendar_remove { sourceRef }   events with familyCalendar
//   places          { userId } → a bare array [{ id, name, lat, lon, radiusM }]   GET familie/places (event place, arrival destination)
//   family_roles    {} → { parents: [userId], children: [userId] }   (1.5.0) who approves requests ('parents'),
//                   who is a child (childrenMayRequest); Familie missing or refusing → null: requests fall back to 'rights'
// Dates: ISO with a time, or YYYY-MM-DD for all-day; place: the label (Familie keeps only that).
// A refusal of the host or of Familie answers `unavailable` (and is logged as service_refused, no content).

const log = require('./log');
const store = require('./store');
const seal = require('./seal');
const { fail } = require('./util');

const PLUGIN = 'gatecontrol-familie';
const SERVICES = ['list_add', 'calendar_add', 'calendar_upsert', 'calendar_remove', 'places', 'family_roles'];
const ROLES_CACHE_MS = 10 * 60000; // the messenger has 60 service calls per hour for everything
let rolesCache = null; // { at, value }

async function available(gc, service) {
  if (!gc || !gc.services || typeof gc.services.available !== 'function' || typeof gc.services.call !== 'function') return false;
  try { return (await gc.services.available(PLUGIN, service)) === true; } catch { return false; }
}

/** What Familie offers right now → { lists, calendar, places } (GET me integrations). */
async function offers(gc) {
  const [lists, calendar, places] = await Promise.all([available(gc, 'list_add'), available(gc, 'calendar_add'), available(gc, 'places')]);
  return { lists, calendar, places };
}

/** Call a Familie service → its answer; `unavailable` when it is missing, refused or answers ok: false. */
async function call(gc, service, payload, userId, now = Date.now()) {
  if (!(await available(gc, service))) throw fail('unavailable');
  let r;
  try {
    r = await gc.services.call({ plugin: PLUGIN, service, userId: userId == null ? undefined : userId, payload });
  } catch (e) {
    await log.add(gc, 'service_refused', `familie ${service}: ${(e && e.code) || 'error'}`, now);
    throw fail('unavailable');
  }
  if (r && typeof r === 'object' && r.ok === false) {
    await log.add(gc, 'service_refused', `familie ${service}: ${String(r.code || 'refused').slice(0, 40)}`, now);
    throw fail('unavailable');
  }
  return r;
}

/** Calendar sync of an event (after the commit, never throws) → true when Familie took it. */
async function calendar(gc, service, payload, now) {
  try { await call(gc, service, payload, null, now); return true; } catch { return false; }
}

/**
 * Familie's parents and children (service family_roles, cached 10 min) → { parents: [ids], children: [ids] } or null
 * when Familie does not offer it (not installed, older, refusing) — never throws. One call per 10 minutes at most.
 */
async function roles(gc, now = Date.now()) {
  if (rolesCache && now - rolesCache.at < ROLES_CACHE_MS && now >= rolesCache.at) return rolesCache.value;
  let value = null;
  try {
    const r = await call(gc, 'family_roles', {}, null, now);
    const ids = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => Number.isSafeInteger(x) && x > 0))] : null);
    const parents = r && ids(r.parents);
    const children = r && ids(r.children);
    if (parents && children) value = { parents, children };
  } catch { value = null; }
  rolesCache = { at: now, value };
  return value;
}

function reset() { rolesCache = null; }

/** ms → 'YYYY-MM-DD' in the server's time zone (Familie's all-day dates). */
function day(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 1.9.1: Familie (≥ 1.15.1) names a person's own notice channel („user:<id>“, send_message) „Familie-Hinweise“ — before,
// it was called „Familie“ like the family group and showed up twice in the chat list. Channels left with the old
// name are renamed once at start (Familie would do it only with its next message there).
const OLD_TITLES = { Familie: 'Familie-Hinweise', Family: 'Family notices' };

/** Rename Familie's notice channels still called „Familie“ / „Family“ → how many were renamed (never throws). */
async function renameNoticeChannels(gc) {
  let n = 0;
  try {
    const rows = await store.all(gc, "SELECT id, title_enc FROM conversations WHERE managed_by = ? AND managed_key LIKE 'user:%'", [PLUGIN]);
    for (const r of rows) {
      const title = seal.open(r.title_enc);
      if (typeof title !== 'string' || !Object.hasOwn(OLD_TITLES, title)) continue;
      await store.run(gc, 'UPDATE conversations SET title_enc = ? WHERE id = ?', [seal.seal(OLD_TITLES[title]), r.id]);
      n++;
    }
    if (n) gc.log.info('familie notice channels renamed', n);
  } catch (e) { gc.log.warn('renaming familie notice channels failed', (e && (e.code || e.message)) || 'error'); }
  return n;
}

module.exports = { available, offers, call, calendar, day, roles, reset, renameNoticeChannels, PLUGIN, SERVICES };
