'use strict';

// Who may suspend the protection for whom, and for how long (entscheidungen: everybody for their own devices;
// administrators and parents also for others — parents only for members of their family, never for an
// administrator; "bis ich wieder einschalte" for users only when the administrator offers it; a longest duration;
// with "je Profil" the profile of the device decides for its owner).
//
// GateControl itself only keeps two rules (for all devices: an administrator; for an administrator's devices: an
// administrator or that person) — everything else is decided here, before gc.vpnDns.pause / resume is called.
//
// "Parent" is not a GateControl role: the Familie plugin mirrors the family as a person group of kind 'family' with
// the roles parent / child (gc.groups, permissions.groups: "read"). Without such a group there are no parents.

const DURATIONS = [5, 30, 60, 240];
const ADMIN_MAX_MINUTES = 7 * 24 * 60; // GateControl's own limit

const cache = { at: 0, fam: null };
const CACHE_MS = 30000;

/** The families: [{ id, name, parents: [userId], members: [userId] }] — read from GateControl's groups, cached 30 s. */
async function families(gc, now = Date.now()) {
  if (cache.fam && now - cache.at < CACHE_MS) return cache.fam;
  const out = [];
  try {
    if (gc.groups) {
      for (const g of (await gc.groups.list({ kind: 'family' })) || []) {
        if (g.archived) continue;
        const members = ((await gc.groups.members(g.id)) || []).filter((m) => m.enabled !== false);
        out.push({ id: g.id, name: g.name, parents: members.filter((m) => m.role === 'parent').map((m) => m.userId), members: members.map((m) => m.userId) });
      }
    }
  } catch (e) { gc.log.debug('family groups not read', (e && e.code) || 'error'); }
  cache.fam = out;
  cache.at = now;
  return out;
}

function reset() { cache.fam = null; cache.at = 0; }

/** Is `actorId` a parent in a family `userId` belongs to? (never oneself) */
const parentOf = (fam, actorId, userId) => actorId !== userId && fam.some((f) => f.parents.includes(actorId) && f.members.includes(userId));
/** The people a parent may decide for: the other members of their families. */
function familyOf(fam, actorId) {
  const out = new Set();
  for (const f of fam) if (f.parents.includes(actorId)) for (const u of f.members) if (u !== actorId) out.add(u);
  return [...out];
}
const isParent = (fam, userId) => fam.some((f) => f.parents.includes(userId) && f.members.length > 1);

/** The durations and the end a person may pick. */
function limits(actor, cfg) {
  if (actor.role === 'admin') return { durations: DURATIONS.slice(), maxMinutes: ADMIN_MAX_MINUTES, forever: true };
  return { durations: DURATIONS.filter((m) => m <= cfg.pause.maxMinutes), maxMinutes: cfg.pause.maxMinutes, forever: cfg.pause.forever === true };
}

/**
 * May `actor` ({ id, role }) suspend (or switch back on) for the target?
 *   target { scope: 'all' } | { scope: 'peer' | 'user', owner: { id, role } | null, profileIds: [the profiles of the devices it is about] }
 * → { ok: true, limits } | { ok: false, reason: 'admins_only' | 'profile' | 'admin_target' | 'not_yours' }
 */
function may(actor, target, cfg, fam) {
  if (actor.role === 'admin') return { ok: true, limits: limits(actor, cfg) };
  if (target.scope === 'all') return { ok: false, reason: 'admins_only' };
  const owner = target.owner;
  if (!owner) return { ok: false, reason: 'not_yours' };               // a device without a person: administrators only
  if (cfg.pause.who === 'admins') return { ok: false, reason: 'admins_only' };
  if (owner.id === actor.id) {
    if (cfg.pause.who === 'profile' && (target.profileIds || []).some((id) => cfg.pause.profiles[id] === false)) return { ok: false, reason: 'profile' };
    return { ok: true, limits: limits(actor, cfg) };
  }
  if (owner.role === 'admin') return { ok: false, reason: 'admin_target' };   // never for an administrator
  if (parentOf(fam, actor.id, owner.id)) return { ok: true, limits: limits(actor, cfg) };
  return { ok: false, reason: 'not_yours' };
}

/**
 * The end of a suspension from the request body: { minutes } | { forever: true } | { extend: minutes } (from the end of
 * the running one, else from now) → what gc.vpnDns.pause takes. Throws { code, extra } via `fail`.
 */
function endOf(body, lim, running, fail, now = Date.now()) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.forever === true) {
    if (!lim.forever) throw fail('forever_not_allowed');
    return { forever: true };
  }
  const int = (v) => (Number.isInteger(v) && v >= 1 && v <= ADMIN_MAX_MINUTES ? v : null);
  if (b.extend !== undefined) {
    const add = int(b.extend);
    if (!add) throw fail('invalid', { detail: 'extend' });
    if (running && running.openEnd) throw fail('invalid', { detail: 'extend' });
    const from = running && running.until ? Math.max(now, Date.parse(running.until)) : now;
    const until = from + add * 60000;
    if (until - now > lim.maxMinutes * 60000 + 1000) throw fail('too_long', { maxMinutes: lim.maxMinutes });
    return { until: new Date(until).toISOString() };
  }
  const minutes = int(b.minutes);
  if (!minutes) throw fail('invalid', { detail: 'minutes' });
  if (minutes > lim.maxMinutes) throw fail('too_long', { maxMinutes: lim.maxMinutes });
  return { minutes };
}

module.exports = { families, reset, parentOf, familyOf, isParent, limits, may, endOf, DURATIONS, ADMIN_MAX_MINUTES };
