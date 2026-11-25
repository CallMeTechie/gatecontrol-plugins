'use strict';

// Who may do what.
//
// The right "Medien" (the media area in the apps) for a person or a group — like the rights of Fernzugriff: a
// person's own row decides; without one the person has it when one of their groups (GateControl groups, subgroups
// count) has it; else the default: administrators yes, everybody else no.
//
// Which sources a person sees (only with the right "Medien"): a person's own row in source_access decides ("ja" /
// "nein"). A source in list mode (config.accessMode 'list', "Personen oder Gruppen wählen …") is for the people and the
// members of the groups listed with "ja" only. Otherwise (mode 'all') it is open to everybody with the right, except
// groups listed with "nein" and — for NAS shares — children (role "child" in a family group, the family of the plugin
// Familie) unless the setting children_shares is on.

const store = require('./store');
const { fail, posInt } = require('./util');

const CACHE_MS = 30000;
let cache = new Map();
function reset() { cache = new Map(); }

/** The person's groups (with the ones above) and whether they are a child of a family → { ids, child, parent } */
async function groupsOf(gc, userId, now = Date.now()) {
  const c = cache.get(userId);
  if (c && now - c.at < CACHE_MS) return c.v;
  let list = [];
  try {
    if (gc.groups && typeof gc.groups.list === 'function') list = (await gc.groups.list({ userId, includeInherited: true })) || [];
  } catch (e) { gc.log.debug('groups unavailable', (e && e.code) || 'error'); }
  const fam = list.filter((g) => g && g.kind === 'family' && g.direct !== false);
  const v = { ids: list.map((g) => g.id).filter(Number.isSafeInteger), child: fam.some((g) => g.role === 'child'), parent: fam.some((g) => g.role === 'parent') };
  cache.set(userId, { at: now, v });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return v;
}

const val = (v) => (v == null ? null : v === 1 || v === true);

/** The right "Medien" → { media, source: 'person'|'group'|'default' } */
async function mediaOf(gc, user) {
  if (!user || !Number.isSafeInteger(user.id)) return { media: false, source: 'default' };
  const own = await store.one(gc, "SELECT media FROM rights WHERE kind = 'user' AND principal_id = ?", [user.id]);
  if (own && own.media != null) return { media: val(own.media), source: 'person' };
  const g = await groupsOf(gc, user.id);
  if (g.ids.length) {
    const rows = await store.all(gc, `SELECT media FROM rights WHERE kind = 'group' AND principal_id IN (${store.marks(g.ids.length)})`, g.ids);
    if (rows.some((r) => val(r.media) === true)) return { media: true, source: 'group' };
    if (rows.some((r) => val(r.media) === false)) return { media: false, source: 'group' };
  }
  return { media: user.role === 'admin', source: 'default' };
}

/** May the person see this source (the right "Medien" not included)? → { allowed, source: 'person'|'group'|'default'|'child' } */
async function sourceAccess(gc, user, src, cfg) {
  if (!user || !src) return { allowed: false, source: 'default' };
  const rows = await store.all(gc, 'SELECT kind, principal_id, allow FROM source_access WHERE source_id = ?', [src.id]);
  const g = await groupsOf(gc, user.id);
  const own = rows.find((r) => r.kind === 'user' && r.principal_id === user.id);
  if (own) return { allowed: own.allow === 1, source: 'person' };
  const mine = rows.filter((r) => r.kind === 'group' && g.ids.includes(r.principal_id));
  if (src.config && src.config.accessMode === 'list') {
    // "Personen oder Gruppen wählen …": only the people and groups on the list (a group "nein" never beats a group "ja")
    return mine.some((r) => r.allow === 1) ? { allowed: true, source: 'group' } : { allowed: false, source: 'group' };
  }
  if (mine.some((r) => r.allow === 0)) return { allowed: false, source: 'group' };
  if (src.kind === 'share' && g.child && !(cfg && cfg.childrenShares)) return { allowed: false, source: 'child' };
  return { allowed: true, source: 'default' };
}

/** The sources a person sees now (enabled ones only; [] without the right "Medien"). */
async function visibleSources(gc, user, sources, cfg) {
  const m = await mediaOf(gc, user);
  if (!m.media) return [];
  const out = [];
  for (const s of sources) if (s.enabled && (await sourceAccess(gc, user, s, cfg)).allowed) out.push(s);
  return out;
}

/** Set the right "Medien" of a person or group: true | false | null (not set here). */
async function setMedia(gc, kind, id, value, now = Date.now()) {
  if (kind !== 'user' && kind !== 'group') throw fail('invalid', { field: 'kind' });
  const pid = posInt(id);
  if (!pid) throw fail('invalid');
  if (value !== null && typeof value !== 'boolean') throw fail('invalid', { field: 'media' });
  if (kind === 'user') { if (!(await gc.users.get(pid))) throw fail('not_found'); } else if (gc.groups && typeof gc.groups.get === 'function') { if (!(await gc.groups.get(pid))) throw fail('not_found'); }
  if (value === null) await store.run(gc, 'DELETE FROM rights WHERE kind = ? AND principal_id = ?', [kind, pid]);
  else await store.run(gc, `INSERT INTO rights (kind, principal_id, media, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(kind, principal_id) DO UPDATE SET media = excluded.media, updated_at = excluded.updated_at`, [kind, pid, value ? 1 : 0, now]);
  reset();
}

/** The rows of a source: { users: [{ id, allow }], groups: [{ id, allow }] } */
async function accessList(gc, sourceId) {
  const rows = await store.all(gc, 'SELECT kind, principal_id, allow FROM source_access WHERE source_id = ? ORDER BY kind, principal_id', [sourceId]);
  return {
    users: rows.filter((r) => r.kind === 'user').map((r) => ({ id: r.principal_id, allow: r.allow === 1 })),
    groups: rows.filter((r) => r.kind === 'group').map((r) => ({ id: r.principal_id, allow: r.allow === 1 })),
  };
}

/** Replace the rows: { mode: 'all' } clears them; else users / groups as [{ id, allow }] (allow default true). */
async function setAccess(gc, sourceId, body) {
  const b = body && typeof body === 'object' ? body : {};
  const clean = (list, kind) => {
    if (list == null) return [];
    if (!Array.isArray(list) || list.length > 500) throw fail('invalid', { field: kind });
    return list.map((x) => {
      const o = typeof x === 'object' && x ? x : { id: x };
      const id = posInt(o.id);
      if (!id) throw fail('invalid', { field: kind });
      return { id, allow: o.allow !== false };
    });
  };
  const users = b.mode === 'all' ? [] : clean(b.users, 'users');
  const groups = b.mode === 'all' ? [] : clean(b.groups, 'groups');
  await store.tx(gc, async () => {
    await store.run(gc, 'DELETE FROM source_access WHERE source_id = ?', [sourceId]);
    for (const u of users) await store.run(gc, "INSERT OR REPLACE INTO source_access (source_id, kind, principal_id, allow) VALUES (?, 'user', ?, ?)", [sourceId, u.id, u.allow ? 1 : 0]);
    for (const g of groups) await store.run(gc, "INSERT OR REPLACE INTO source_access (source_id, kind, principal_id, allow) VALUES (?, 'group', ?, ?)", [sourceId, g.id, g.allow ? 1 : 0]);
  });
  reset();
  return accessList(gc, sourceId);
}

/** One person's switch for one source (the people tab's check box): allow true/false, or null = back to the default. */
async function setPersonAccess(gc, sourceId, userId, allow) {
  const pid = posInt(userId);
  if (!pid) throw fail('invalid');
  if (allow === null) await store.run(gc, "DELETE FROM source_access WHERE source_id = ? AND kind = 'user' AND principal_id = ?", [sourceId, pid]);
  else if (typeof allow === 'boolean') {
    await store.run(gc, "INSERT OR REPLACE INTO source_access (source_id, kind, principal_id, allow) VALUES (?, 'user', ?, ?)", [sourceId, pid, allow ? 1 : 0]);
  } else throw fail('invalid', { field: 'allow' });
  reset();
}

module.exports = { mediaOf, sourceAccess, visibleSources, setMedia, accessList, setAccess, setPersonAccess, groupsOf, reset };
