'use strict';

// People and families as GateControl knows them, and the licence.
//
//   users      gc.users.list() — enabled accounts
//   families   GateControl groups of kind 'family' (gc.groups, permissions.groups 'read'; the Familie plugin keeps
//              its family there): parents and children by their group role
//   groupsOf   every group a person is in (inherited ones too) — for team folders shared with a group
//   licence    gc.license.info() (GateControl ≥ 1.206.0): tier ('family' | 'business' | 'combo') and seats;
//              an older host answers only gc.license.status() → no tier

async function users(gc) {
  const list = await gc.users.list();
  return new Map((Array.isArray(list) ? list : []).map((u) => [u.id, u]));
}

const hasGroups = (gc) => !!(gc.groups && typeof gc.groups.list === 'function');

/** [{ id, name, parents: Set, children: Set, members: Set }] of the family groups (not archived). */
async function families(gc) {
  if (!hasGroups(gc)) return [];
  let list;
  try { list = await gc.groups.list({ kind: 'family' }); } catch (e) { if (e && e.code === 'ERR_GROUPS_DENIED') return []; throw e; }
  const out = [];
  for (const g of Array.isArray(list) ? list : []) {
    if (!g || g.archived) continue;
    const members = await gc.groups.members(g.id, {});
    const f = { id: g.id, name: g.name, parents: new Set(), children: new Set(), members: new Set() };
    for (const m of Array.isArray(members) ? members : []) {
      if (m.enabled === false) continue;
      f.members.add(m.userId);
      if (m.role === 'parent') f.parents.add(m.userId);
      else if (m.role === 'child') f.children.add(m.userId);
    }
    out.push(f);
  }
  return out;
}

/** Ids of the groups `userId` is in, the groups above them included. */
async function groupsOf(gc, userId) {
  if (!hasGroups(gc)) return new Set();
  try {
    const list = await gc.groups.list({ userId, includeInherited: true });
    return new Set((Array.isArray(list) ? list : []).map((g) => g.id));
  } catch (e) {
    if (e && e.code === 'ERR_GROUPS_DENIED') return new Set();
    throw e;
  }
}

/** Members of group `id` (subgroups included), enabled ones only → Set of user ids. */
async function groupMembers(gc, id) {
  if (!hasGroups(gc)) return new Set();
  try {
    const list = await gc.groups.members(id, { nested: true });
    return new Set((Array.isArray(list) ? list : []).filter((m) => m.enabled !== false).map((m) => m.userId));
  } catch { return new Set(); }
}

/** { valid, state, tier, seats } of this plugin's licence. */
async function licence(gc) {
  if (gc.license && typeof gc.license.info === 'function') {
    const i = await gc.license.info();
    return { valid: i.valid === true, state: i.state || null, tier: i.tier || null, seats: i.seats || null, expiresAt: i.expiresAt || null };
  }
  const s = gc.license && typeof gc.license.status === 'function' ? await gc.license.status() : { licensed: true, state: 'valid' };
  return { valid: s.licensed !== false, state: s.state || null, tier: null, seats: null, expiresAt: s.expiresAt || null };
}

module.exports = { users, families, groupsOf, groupMembers, licence };
