'use strict';

// 1.28.0 — „Meine Orte“ from GateControl's profile (gc.places version 1, permissions.places; GateControl ≥ 1.298.0).
// The apps' place picker (Ortsnachricht, Ankunft) offers the person's own profile places next to Familie's places, both
// through GET places; a place message or an arrival keeps the reference (`ref`) and a copy of the point as a fallback.
//
//   ref      'profile:<id>' (a place of the profile) | 'home' | 'place:<id>' (Familie's places, services places())
//   GET places → { places: [{ ref, source: 'profile' | 'familie', id, name, icon, lat, lon, radiusM, address, visibility,
//                lastUsedAt, usageCount }], sources: { profile, familie } } — sorted for the chips: most used here in the
//                last 90 days, then last used, then by name (the app adds the nearest itself; the server never knows
//                where the phone is)
//   usage    place_uses (one row per use: a place message saved, an arrival sent) for usageCount / lastUsedAt here;
//            gc.places.markUsed for one's own profile place; gc.places.reportUsage { kind: 'location_message', count:
//            all place messages of the plugin at that place } for „Genutzt von“
//   changes  the hook placesChanged { userId, ids, deleted } → placemsgs.placesChanged / arrival.placesChanged

const store = require('./store');
const log = require('./log');
const { fail, posInt, line, iso } = require('./util');

const REF_RE = /^(?:profile:[1-9][0-9]{0,15}|home|place:[1-9][0-9]{0,15})$/;
const PROFILE_RE = /^profile:([1-9][0-9]{0,15})$/;
const USES_DAYS = 90;
const DAY_MS = 86400000;
const LIST_MAX = 200;
const KIND_MESSAGE = 'location_message';

/** gc.places of GateControl ≥ 1.298.0 (only with permissions.places), else null. */
function api(gc) {
  const p = gc && gc.places;
  return p && Number(p.version) >= 1 && typeof p.resolve === 'function' && typeof p.list === 'function' ? p : null;
}

/** A ref of a request body → the ref or null (absent); anything else invalid. */
function cleanRef(v) {
  if (v == null) return null;
  if (typeof v !== 'string' || !REF_RE.test(v)) throw fail('invalid');
  return v;
}

/** 'profile:<id>' → id, else null. */
function profileId(ref) {
  const m = typeof ref === 'string' ? PROFILE_RE.exec(ref) : null;
  return m ? Number(m[1]) : null;
}

const sourceOf = (ref) => (ref == null ? null : (profileId(ref) ? 'profile' : 'familie'));

/** A Familie place id ('home', 'place:<id>', an old number) → its ref, or null. */
function familieRef(id) {
  if (typeof id === 'string' && REF_RE.test(id) && !profileId(id)) return id;
  if (typeof id === 'number' && posInt(id)) return `place:${id}`;
  return null;
}

/** GateControl's 'YYYY-MM-DD HH:MM:SS' (UTC) → ms, or null. */
function hostTime(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s)) return null;
  const ms = Date.parse(s.slice(0, 19).replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The profile place `ref` as the viewer may see it → place | null (unknown, deleted, not visible). Without gc.places:
 * undefined (an older GateControl — the caller keeps the app's copy). A refusal of the host → unavailable.
 */
async function resolve(gc, ref, userId) {
  const p = api(gc);
  if (!p) return undefined;
  try {
    const r = await p.resolve({ ref, userId });
    return r && typeof r === 'object' && Number.isFinite(r.lat) && Number.isFinite(r.lon) ? r : null;
  } catch (e) {
    if (e && (e.code === 'ERR_NOT_FOUND')) return null;
    if (e && e.code === 'ERR_INVALID') throw fail('invalid');
    await log.add(gc, 'service_refused', `places resolve: ${(e && e.code) || 'error'}`);
    throw fail('unavailable');
  }
}

/** One use of `ref` by the person (inside the caller's transaction). */
async function used(ctx, ref) {
  if (!ref) return;
  await store.run(ctx.gc, 'INSERT INTO place_uses (user_id, ref, used_at) VALUES (?, ?, ?)', [ctx.viewer, ref, ctx.now]);
}

/** After the commit: „zuletzt genutzt“ of one's own profile place (best effort, never throws). */
async function markUsed(gc, userId, ref) {
  const id = profileId(ref);
  const p = api(gc);
  if (!id || !p || typeof p.markUsed !== 'function') return;
  try { await p.markUsed({ userId, id }); } catch { /* somebody else's place, or gone */ }
}

/**
 * After the commit: „Genutzt von“ — the number of place messages of the whole plugin at each of these profile places
 * (gc.places counts per place, plugin and kind; absolute, 0 removes). Best effort, never throws.
 */
async function report(gc, userId, refs) {
  const p = api(gc);
  if (!p || typeof p.reportUsage !== 'function') return;
  for (const ref of [...new Set((refs || []).filter((r) => profileId(r)))]) {
    try {
      const row = await store.one(gc, 'SELECT COUNT(*) AS n FROM place_messages WHERE place_ref = ?', [ref]);
      await p.reportUsage({ userId, id: profileId(ref), kind: KIND_MESSAGE, count: row ? row.n : 0 });
    } catch { /* gone or not visible any more */ }
  }
}

/** Queue markUsed / report for after the commit (api.flush runs ctx.box.after). */
function afterSave(ctx, { used: usedRef = null, refs = [] } = {}) {
  const gc = ctx.gc;
  const userId = ctx.viewer;
  const list = [...new Set([usedRef, ...refs].filter((r) => profileId(r)))];
  if (!list.length) return;
  ctx.box.after.push(async () => {
    if (usedRef) await markUsed(gc, userId, usedRef);
    await report(gc, userId, list);
  });
}

function out(p, source, ref, uses) {
  const u = uses.get(ref) || { n: 0, last: null };
  const own = source === 'profile' ? hostTime(p.lastUsedAt) : null;
  const last = Math.max(u.last || 0, own || 0) || null;
  return {
    ref, source,
    id: source === 'profile' ? p.id : (typeof p.id === 'string' || typeof p.id === 'number' ? p.id : null),
    name: line(p.name) || null,
    icon: typeof p.icon === 'string' ? p.icon : (ref === 'home' ? 'home' : 'pin'),
    lat: p.lat, lon: p.lon, radiusM: Number.isFinite(p.radiusM) ? p.radiusM : null,
    address: source === 'profile' && typeof p.address === 'string' ? p.address : null,
    visibility: source === 'profile' ? p.visibility || null : null,
    lastUsedAt: iso(last), usageCount: u.n,
  };
}

/**
 * GET places → { places, sources } — the person's own profile places (gc.places) and Familie's places (service places,
 * when Familie offers it). A missing source is left out (sources says which answered); never `unavailable`.
 */
async function list(ctx) {
  const gc = ctx.gc;
  const familie = require('./familie');
  const rows = await store.all(gc, 'SELECT ref, COUNT(*) AS n, MAX(used_at) AS last FROM place_uses WHERE user_id = ? AND used_at >= ? GROUP BY ref',
    [ctx.viewer, ctx.now - USES_DAYS * DAY_MS]);
  const uses = new Map(rows.map((r) => [r.ref, { n: r.n, last: r.last }]));
  const all = [];
  const seen = new Set();
  const sources = { profile: false, familie: false };
  const p = api(gc);
  if (p) {
    try {
      const own = await p.list({ userId: ctx.viewer, owner: ctx.viewer });
      sources.profile = true;
      for (const x of Array.isArray(own) ? own : []) {
        if (!x || typeof x !== 'object' || !posInt(x.id) || !Number.isFinite(x.lat) || !Number.isFinite(x.lon)) continue;
        const ref = `profile:${x.id}`;
        if (seen.has(ref)) continue;
        seen.add(ref);
        all.push(out(x, 'profile', ref, uses));
      }
    } catch (e) { await log.add(gc, 'service_refused', `places list: ${(e && e.code) || 'error'}`); }
  }
  if (await familie.available(gc, 'places')) {
    try {
      const r = await familie.call(gc, 'places', { userId: ctx.viewer }, ctx.viewer, ctx.now);
      const fl = Array.isArray(r) ? r : (r && Array.isArray(r.places) ? r.places : []);
      sources.familie = true;
      for (const x of fl) {
        if (!x || typeof x !== 'object' || !Number.isFinite(x.lat) || !Number.isFinite(x.lon)) continue;
        // a Familie that also lists profile places (includeProfile) — those come from gc.places already
        const ref = x.source === 'profile' || profileId(x.ref) ? null : familieRef(x.id);
        if (!ref || seen.has(ref)) continue;
        seen.add(ref);
        all.push(out(x, 'familie', ref, uses));
      }
    } catch { /* familie.call logged it */ }
  }
  all.sort((a, b) => (b.usageCount - a.usageCount)
    || ((b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0) - (a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0))
    || String(a.name || '').localeCompare(String(b.name || ''), 'de'));
  return { places: all.slice(0, LIST_MAX), sources };
}

/** Uses older than 90 days go (the plugin's clean-up). */
async function tidy(gc, now = Date.now()) {
  await store.run(gc, 'DELETE FROM place_uses WHERE used_at < ?', [now - USES_DAYS * DAY_MS]);
}

/**
 * The hook placesChanged { userId, ids, deleted } (GateControl ≥ 1.298.0): place messages and live arrivals at these
 * profile places take the new point (or keep their copy, marked missing, when the place went or is not visible any
 * more). Events place_messages.changed / arrival.update, so the phones register their geofences again. Never throws.
 */
async function changed(gc, arg, makeCtx, flush) {
  const ids = Array.isArray(arg && arg.ids) ? [...new Set(arg.ids.filter((n) => posInt(n)))].slice(0, 100) : [];
  if (!ids.length) return { placeMessages: 0, arrivals: 0 };
  const refs = ids.map((id) => `profile:${id}`);
  const deleted = !!(arg && arg.deleted === true);
  const ctx = await makeCtx();
  const a = await require('./placemsgs').placesChanged(ctx, refs, deleted);
  const b = await require('./arrival').placesChanged(ctx, refs, deleted);
  await flush(ctx);
  return { placeMessages: a, arrivals: b };
}

module.exports = { api, cleanRef, profileId, sourceOf, familieRef, hostTime, resolve, used, markUsed, report, afterSave, list, tidy, changed, REF_RE, KIND_MESSAGE };
