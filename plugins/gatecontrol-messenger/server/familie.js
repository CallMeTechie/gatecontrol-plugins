'use strict';

// 1.4.0 — the Familie plugin's services the messenger uses (permissions.services), each feature-detected
// with gc.services.available (GateControl ≥ 1.178.0; on 1.177.x there is no way to ask, so none is used):
//   list_add        { userId, list: 'shopping' | <listId>, items (1–50, ≤ 120) } → { listId, listName, added, skipped, itemIds }   POST messages/:id/to-list
//   calendar_add    { userId, title ≤ 80, startsAt, endsAt?, allDay?, place? } → { eventId }   POST messages/:id/to-calendar
//   calendar_upsert { sourceRef 'messenger:<msgId>', title, startsAt, endsAt?, allDay?, place?, userIds? } / calendar_remove { sourceRef }   events with familyCalendar
//   places          { userId } → a bare array [{ id, name, lat, lon, radiusM }]   GET familie/places (event place, arrival destination)
// Dates: ISO with a time, or YYYY-MM-DD for all-day; place: the label (Familie keeps only that).
// A refusal of the host or of Familie answers `unavailable` (and is logged as service_refused, no content).

const log = require('./log');
const { fail } = require('./util');

const PLUGIN = 'gatecontrol-familie';
const SERVICES = ['list_add', 'calendar_add', 'calendar_upsert', 'calendar_remove', 'places'];

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

/** ms → 'YYYY-MM-DD' in the server's time zone (Familie's all-day dates). */
function day(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { available, offers, call, calendar, day, PLUGIN, SERVICES };
