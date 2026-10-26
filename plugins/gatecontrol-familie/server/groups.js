'use strict';

// The family as a GateControl group (1.15.0, GateControl ≥ 1.200.0, plugin.json permissions.groups "manage",
// docs/plugins.md "Groups"):
//
//   gc.groups.ensure({ key: 'family', name: 'Familie' | 'Family' (the notification language), kind: 'family',
//                      members: [{ userId, role: 'parent' | 'child' }] })
//
// Parents are the group's parents, children its children; a wall tablet (role 'wall') is never a member. The
// group belongs to this plugin (source plugin:gatecontrol-familie): in GateControl (Benutzer › Gruppen, the
// portal's "Meine Gruppen") it is read-only, other plugins read it through gc.groups (e.g. the Messenger,
// access per group, notifications to the family). Familie stays the place where the family is edited.
//
// Kept in step: right after every member change on the admin pages (add, edit — a role change —, remove),
// on the first background run after a start, whenever what the group should hold (name, members, roles)
// differs from the last ensure — the background run compares every minute, which also follows accounts
// that were disabled, enabled again or deleted in GateControl (Familie counts enabled accounts only, like
// everywhere) — after a failed ensure every 15 minutes, and every 6 hours to heal. ensure is idempotent
// and sets the members exactly. Without any family member (and no group yet) nothing is created.
//
// A local group of the same name at the top level (names are unique per level) makes ensure fail with
// NAME_TAKEN; the group is then called „Familie (Plugin)“ / „Family (plugin)“.
//
// The hook groupsChanged: our group archived or deleted in GateControl → ensured again on the next
// background run (ensure restores an archived group of the plugin, a deleted one is created anew).
//
// An older GateControl (no gc.groups.ensure): nothing happens, nothing fails — the service family_roles
// (server/services.js) is what older callers use; it stays as it is during the transition.
//
// State (gc.storage 'core_group'): { groupId, name, hash, at, ok, error, members }.

const crypto = require('node:crypto');
const members = require('./members');

const KEY = 'family';
const STORE_KEY = 'core_group';
const NAME = { de: 'Familie', en: 'Family' };
const NAME_FALLBACK = { de: 'Familie (Plugin)', en: 'Family (plugin)' };
const HEAL_MS = 6 * 3600000;
const RETRY_MS = 15 * 60000;

// started: the first background run after a start ensures at once; running: one ensure at a time
const proc = { started: false, running: null };

/** Does this GateControl keep groups for plugins (≥ 1.200.0)? */
const available = (gc) => !!(gc && gc.groups && typeof gc.groups.ensure === 'function');

const lang = (cfg) => (cfg && cfg.lang === 'en' ? 'en' : 'de');

/** What the group should hold: parents → parent, children → child (never a wall tablet), sorted by id. */
function wanted(fam) {
  const list = [];
  for (const m of members.parents(fam)) list.push({ userId: m.userId, role: 'parent' });
  for (const m of members.children(fam)) list.push({ userId: m.userId, role: 'child' });
  return list.sort((a, b) => a.userId - b.userId);
}

const hashOf = (name, list) => crypto.createHash('sha256').update(JSON.stringify([name, list.map((m) => [m.userId, m.role])])).digest('hex').slice(0, 16);

async function loadState(gc) {
  let v = null;
  try { v = await gc.storage.get(STORE_KEY); } catch { /* no storage */ }
  const s = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  return {
    groupId: Number.isSafeInteger(s.groupId) ? s.groupId : null,
    name: typeof s.name === 'string' ? s.name : null,
    hash: typeof s.hash === 'string' ? s.hash : null,
    at: Number.isFinite(s.at) ? s.at : null,
    ok: s.ok === true,
    error: typeof s.error === 'string' ? s.error : null,
    members: Number.isSafeInteger(s.members) ? s.members : null,
  };
}

async function saveState(gc, s) {
  try { await gc.storage.set(STORE_KEY, s); } catch (e) { gc.log.warn('group state not saved', (e && e.code) || (e && e.message)); }
}

/** One ensure (with the fallback name on NAME_TAKEN) → the new state. */
async function ensureNow(gc, fam, cfg, now) {
  const s = await loadState(gc);
  const list = wanted(fam);
  const l = lang(cfg);
  const hash = hashOf(NAME[l], list);
  if (!list.length && s.groupId == null) return s;
  const once = (name) => gc.groups.ensure({ key: KEY, name, kind: 'family', members: list });
  let g;
  let name = NAME[l];
  try {
    try {
      g = await once(name);
    } catch (e) {
      if (!(e && e.code === 'ERR_INVALID' && /^NAME_TAKEN/.test(String(e.message || '')))) throw e;
      name = NAME_FALLBACK[l];
      g = await once(name);
    }
  } catch (e) {
    const code = (e && e.code) || 'error';
    if (s.ok || s.error !== code) gc.log.warn('family group not ensured', code, String((e && e.message) || '').slice(0, 120));
    const next = { ...s, hash, at: now, ok: false, error: code };
    await saveState(gc, next);
    return next;
  }
  if (g && (g.created || g.added || g.removed || g.changed)) gc.log.info('family group ensured', g.id, g.created ? 'created' : 'updated', g.added || 0, g.removed || 0, g.changed || 0);
  const next = { groupId: g && Number.isSafeInteger(g.id) ? g.id : s.groupId, name, hash, at: now, ok: true, error: null, members: list.length };
  await saveState(gc, next);
  return next;
}

/** Ensure the group now (serialised; never throws) → the state, or null on an older GateControl. */
async function sync(gc, fam, cfg, now = Date.now()) {
  if (!available(gc)) return null;
  while (proc.running) { try { await proc.running; } catch { /* the other run logged it */ } }
  const run = ensureNow(gc, fam, cfg, now).catch((e) => {
    gc.log.warn('family group sync failed', (e && (e.code || e.message)) || 'error');
    return null;
  });
  proc.running = run;
  try { return await run; } finally { if (proc.running === run) proc.running = null; }
}

/** Background (every minute): ensure when due — see the head of this file. */
async function tick(gc, fam, cfg, now) {
  if (!available(gc)) return null;
  const s = await loadState(gc);
  const hash = hashOf(NAME[lang(cfg)], wanted(fam));
  const due = !proc.started || s.hash !== hash || s.at == null || now - s.at >= (s.ok ? HEAL_MS : RETRY_MS);
  proc.started = true;
  return due ? sync(gc, fam, cfg, now) : s;
}

/** The hook groupsChanged: our group archived or deleted → ensured again by the next background run. */
async function changed(gc, changes) {
  if (!Array.isArray(changes) || !changes.length) return false;
  const s = await loadState(gc);
  if (s.groupId == null) return false;
  const gone = changes.some((c) => c && c.groupId === s.groupId && (c.type === 'group_archived' || c.type === 'group_deleted'));
  if (!gone) return false;
  const deleted = changes.some((c) => c && c.groupId === s.groupId && c.type === 'group_deleted');
  await saveState(gc, { ...s, groupId: deleted ? null : s.groupId, hash: null });
  return true;
}

/** What the admin pages show: { available, groupId, name, ok, error, at, members }. */
async function info(gc) {
  if (!available(gc)) return { available: false, groupId: null, name: null, ok: false, error: null, at: null, members: null };
  const s = await loadState(gc);
  return { available: true, groupId: s.groupId, name: s.name, ok: s.ok, error: s.error, at: s.at == null ? null : new Date(s.at).toISOString(), members: s.members };
}

function reset() { proc.started = false; proc.running = null; }

module.exports = { KEY, STORE_KEY, NAME, NAME_FALLBACK, HEAL_MS, RETRY_MS, available, wanted, sync, tick, changed, info, reset, loadState, _proc: proc };
