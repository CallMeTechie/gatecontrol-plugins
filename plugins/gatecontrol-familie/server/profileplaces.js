'use strict';

// 1.30.0 — „Meine Orte“ from GateControl's profile (gc.places version 1, permissions.places; GateControl ≥ 1.298.0).
// A place of a person's profile can be the place of a place reminder (server/places.js) and — when its owner shows it
// to the family (visibility family or all) — the place of a rule (server/ruleplaces.js, a linked rule place). Familie
// keeps the reference 'profile:<id>' and a copy of the point (what the phones watch); the hook placesChanged
// { userId, ids, deleted } moves the copies along, a place that went or is not visible any more keeps its copy
// (missing). „Genutzt von“: gc.places.reportUsage with the kinds reminder and rule (Familie's totals per place).

const store = require('./store');
const { fail, posInt, line } = require('./util');

const REF_RE = /^profile:([1-9][0-9]{0,15})$/;
const KIND_REMINDER = 'reminder';
const KIND_RULE = 'rule';
const FAMILY = ['family', 'all'];

/** gc.places of GateControl ≥ 1.298.0 (only with permissions.places), else null. */
function api(gc) {
  const p = gc && gc.places;
  return p && Number(p.version) >= 1 && typeof p.resolve === 'function' && typeof p.list === 'function' ? p : null;
}

/** 'profile:<id>' → id, else null. */
function idOf(ref) {
  const m = typeof ref === 'string' ? REF_RE.exec(ref) : null;
  return m ? Number(m[1]) : null;
}

const isRef = (v) => idOf(v) != null;

/** A ref of a body: null / undefined → null, 'profile:<id>' → it, anything else invalid { field }. */
function cleanRef(v, field = 'ref') {
  if (v == null) return null;
  if (!isRef(v)) throw fail('invalid', { field });
  return v;
}

/**
 * The profile place as `userId` may see it → place | null (unknown, deleted, not visible). No gc.places (an older
 * GateControl, the permission missing) → unavailable; a refusal → unavailable.
 */
async function resolve(gc, ref, userId) {
  const p = api(gc);
  if (!p) throw fail('unavailable');
  try {
    const r = await p.resolve({ ref, userId });
    return r && typeof r === 'object' && Number.isFinite(r.lat) && Number.isFinite(r.lon) ? r : null;
  } catch (e) {
    if (e && e.code === 'ERR_NOT_FOUND') return null;
    if (e && e.code === 'ERR_INVALID') throw fail('invalid', { field: 'ref' });
    throw fail('unavailable');
  }
}

/** „zuletzt genutzt“ of one's own profile place (best effort, never throws). */
async function markUsed(gc, userId, ref) {
  const p = api(gc);
  const id = idOf(ref);
  if (!p || !id || typeof p.markUsed !== 'function') return;
  try { await p.markUsed({ userId, id }); } catch { /* somebody else's place, or gone */ }
}

/** How many reminders / rules of Familie use the profile place `ref` (the absolute count of reportUsage). */
async function counts(gc, ref) {
  const rem = await store.one(gc, 'SELECT COUNT(*) AS n FROM places WHERE place_ref = ? AND gone_at IS NULL', [ref]);
  const rule = await store.one(gc, 'SELECT COUNT(*) AS n FROM presence_rules r JOIN rule_places p ON p.id = r.place_id WHERE p.profile_ref = ?', [ref]);
  return { [KIND_REMINDER]: rem ? rem.n : 0, [KIND_RULE]: rule ? rule.n : 0 };
}

/** „Genutzt von“: Familie's totals at these profile places, reported as `userId` (best effort, never throws). */
async function report(gc, userId, refs) {
  const p = api(gc);
  if (!p || typeof p.reportUsage !== 'function' || !userId) return;
  for (const ref of [...new Set((refs || []).filter(isRef))]) {
    let c;
    try { c = await counts(gc, ref); } catch { continue; }
    for (const kind of [KIND_REMINDER, KIND_RULE]) {
      try { await p.reportUsage({ userId, id: idOf(ref), kind, count: c[kind] }); } catch { /* gone or not visible */ }
    }
  }
}

/**
 * The profile places `userId` may choose for the family: visible to them, owned by a member of the family and shown to
 * the family (visibility family or all; one's own too). → [{ ref, id, name, icon, lat, lon, radiusM, ownerId, ownerName,
 * own }] — [] without gc.places or when the host refuses.
 */
async function forFamily(gc, fam, userId, { all = false } = {}) {
  const p = api(gc);
  if (!p || !userId) return [];
  let list;
  try { list = await p.list({ userId }); } catch { return []; }
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || !posInt(x.id) || !Number.isFinite(x.lat) || !Number.isFinite(x.lon)) continue;
    const owner = posInt(x.ownerId) || userId;
    if (!all && !FAMILY.includes(x.visibility)) continue;
    if (owner !== userId && !fam.byId.has(owner)) continue;
    out.push({
      ref: `profile:${x.id}`, id: x.id, name: line(x.name) || `#${x.id}`, icon: typeof x.icon === 'string' ? x.icon : 'pin',
      lat: x.lat, lon: x.lon, radiusM: Number.isFinite(x.radiusM) ? x.radiusM : null, visibility: x.visibility || null,
      ownerId: owner, ownerName: owner === userId ? null : (x.ownerName || (fam.byId.get(owner) || {}).name || null), own: owner === userId,
    });
  }
  return out;
}

/**
 * The hook placesChanged { userId, ids, deleted } (GateControl ≥ 1.298.0): place reminders and linked rule places at
 * these profile places take the new point (or keep their copy, missing). → { reminders, rulePlaces }. Never throws.
 */
async function changed(gc, arg) {
  const ids = Array.isArray(arg && arg.ids) ? [...new Set(arg.ids.filter((n) => posInt(n)))].slice(0, 100) : [];
  if (!ids.length) return { reminders: 0, rulePlaces: 0 };
  const refs = ids.map((id) => `profile:${id}`);
  const deleted = !!(arg && arg.deleted === true);
  const now = Date.now();
  let reminders = 0;
  let rulePlaces = 0;
  try { reminders = await require('./places').placesChanged(gc, refs, deleted, now); } catch (e) { gc.log.warn('placesChanged reminders failed', (e && (e.code || e.message)) || 'error'); }
  try { rulePlaces = await require('./ruleplaces').placesChanged(gc, refs, deleted, now); } catch (e) { gc.log.warn('placesChanged rule places failed', (e && (e.code || e.message)) || 'error'); }
  return { reminders, rulePlaces };
}

module.exports = { api, idOf, isRef, cleanRef, resolve, markUsed, counts, report, forFamily, changed, REF_RE, KIND_REMINDER, KIND_RULE, FAMILY };
