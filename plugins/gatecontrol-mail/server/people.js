'use strict';

// People as GateControl knows them, and the licence (like Drive's people.js):
//   users      gc.users.list() — enabled accounts
//   familyOf   is a person in a GateControl family group (gc.groups, permissions.groups 'read')? — the default kind of
//              their seat on a licence with both kinds
//   licence    gc.license.info() (GateControl ≥ 1.206.0): tier ('family' | 'business' | 'combo') and seats { total,
//              family, business, included }; an older host answers only gc.license.status() → no tier (no counting)

async function users(gc) {
  let list = [];
  try { list = await gc.users.list(); } catch { list = []; }
  return new Map((Array.isArray(list) ? list : []).map((u) => [u.id, u]));
}

/** Is `userId` a member of a family group? (no groups API or no permission: false) */
async function inFamily(gc, userId) {
  if (!gc.groups || typeof gc.groups.list !== 'function') return false;
  try {
    const list = await gc.groups.list({ userId, kind: 'family', includeInherited: true });
    return (Array.isArray(list) ? list : []).some((g) => g && g.kind === 'family' && !g.archived);
  } catch { return false; }
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

module.exports = { users, inFamily, licence };
