'use strict';

// 1.22.0 — „Wer sieht dein Bild?“ lives in the user profile of GateControl (visibility.avatar: all | contacts | family |
// self) and counts everywhere there. GateControl hides a picture at the source (gc.users with a viewer); only the
// Messenger knows who chats with whom, so it asks for every picture (gc.users.list({ unmasked: true }), each with its
// avatarVisibility) and decides per reader itself:
//
//   all        everybody
//   contacts   the family and everybody who shares a chat or a group with the person (active membership)
//   family     the family — both in one GateControl group of the kind family (gc.groups), like the core
//   self       nobody (the initials)
//
// The person herself always sees her picture; a block hides it both ways (as before).
// On an older GateControl (no gc.users.setAvatarVisibility) everything stays in the Messenger: prefs.privacy.avatar
// (all | family | nobody) with the Messenger's family as before.
//
// Takeover (adoptAll, once per server): each person's old privacy.avatar goes to the profile (nobody → self, family →
// family) — GateControl takes it only while the person has chosen nothing there. Older apps that still write
// privacy.avatar are forwarded (forward).

const store = require('./store');

const LEVELS = ['all', 'contacts', 'family', 'self'];
const ADOPTED = 'avatar_profile_adopted';

/** Does this GateControl keep „Wer sieht dein Bild?“ in the profile? */
function inProfile(gc) {
  return !!(gc && gc.users && typeof gc.users.setAvatarVisibility === 'function' && typeof gc.users.adoptAvatarVisibility === 'function');
}

/** The Messenger's old value (all | family | nobody) → a level of the profile. */
function fromOld(v) { return v === 'nobody' ? 'self' : (v === 'family' ? 'family' : 'all'); }
/** A level of the profile → the old value for apps that know only all | family | nobody. */
function toOld(level) { return level === 'self' ? 'nobody' : (level === 'family' || level === 'contacts' ? 'family' : 'all'); }

/** The level of an account (its gc.users entry), or null when GateControl does not name one. */
function levelOf(u) { return u && LEVELS.includes(u.avatarVisibility) ? u.avatarVisibility : null; }

/**
 * The family as GateControl sees it: Map userId → Set(groupId) of the direct memberships in groups of the kind family
 * (gc.groups, permissions.groups "read"). null when gc.groups is not there.
 */
async function coreFamilies(gc) {
  if (!gc || !gc.groups || typeof gc.groups.list !== 'function' || typeof gc.groups.members !== 'function') return null;
  const out = new Map();
  const list = await gc.groups.list({ kind: 'family' });
  for (const g of Array.isArray(list) ? list : []) {
    if (!g || !Number.isSafeInteger(g.id) || g.archived) continue;
    const members = await gc.groups.members(g.id);
    for (const m of Array.isArray(members) ? members : []) {
      if (!m || !Number.isSafeInteger(m.userId) || m.direct === false) continue;
      if (!out.has(m.userId)) out.set(m.userId, new Set());
      out.get(m.userId).add(g.id);
    }
  }
  return out;
}

/** Do `a` and `b` share a family group (coreFamilies)? */
function sameFamily(fams, a, b) {
  if (!fams) return false;
  const fa = fams.get(a);
  const fb = fams.get(b);
  if (!fa || !fb) return false;
  for (const id of fa) if (fb.has(id)) return true;
  return false;
}

/** The people who share a chat or a group with `viewer` (both active members). */
async function partnersOf(gc, viewer) {
  const rows = await store.all(gc, `SELECT DISTINCT b.user_id AS id FROM members a JOIN members b ON b.conv_id = a.conv_id
    WHERE a.user_id = ? AND a.left_at IS NULL AND b.left_at IS NULL AND b.user_id <> a.user_id`, [viewer]);
  return new Set(rows.map((r) => r.id));
}

/**
 * May `viewer` see the picture of `owner` at `level`? ctx: { fams (coreFamilies), partner (boolean: they share a chat
 * or a group) }.
 */
function sees(level, viewer, owner, { fams, partner }) {
  if (viewer === owner) return true;
  if (level === 'all') return true;
  if (level === 'self') return false;
  if (sameFamily(fams, viewer, owner)) return true;
  return level === 'contacts' && !!partner;
}

/**
 * Once per server: each person's old privacy.avatar (family, nobody) to the profile. GateControl takes it only while the
 * person has chosen nothing there and only narrower than „Alle“. Marked done when no call failed.
 */
async function adoptAll(gc, extOf) {
  if (!inProfile(gc)) return { adopted: 0, skipped: true };
  const done = await store.one(gc, 'SELECT value FROM settings WHERE key = ?', [ADOPTED]);
  if (done) return { adopted: 0, skipped: true };
  const rows = await store.all(gc, 'SELECT user_id, ext FROM prefs');
  let adopted = 0;
  let failed = 0;
  for (const r of rows) {
    const old = extOf(r).privacy.avatar;
    if (old === 'all') continue;
    try {
      const res = await gc.users.adoptAvatarVisibility(r.user_id, fromOld(old));
      if (res && res.adopted) adopted++;
    } catch (e) {
      if (!(e && e.code === 'ERR_NOT_FOUND')) failed++;
    }
  }
  if (!failed) await store.run(gc, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [ADOPTED, JSON.stringify({ at: Date.now(), adopted })]);
  return { adopted, failed, skipped: false };
}

/**
 * The readers of a push (members of the conversation, so partners of `owner`) who may see the picture of `owner`
 * (entry: the gc.users entry with the unmasked avatarUrl) → Set of user ids. A block hides it both ways.
 */
async function pushReaders(gc, owner, entry, readers) {
  const out = new Set();
  if (!entry || !entry.avatarUrl || !readers.length) return out;
  const level = levelOf(entry);
  let ok;
  if (level) {
    const fams = require('./people').families();
    ok = (r) => sees(level, r, owner, { fams, partner: true });
  } else {
    // an older GateControl: the Messenger's own privacy.avatar as before
    const p = (await require('./people').prefsOf(gc, [owner])).get(owner);
    const old = p && p.privacy ? p.privacy.avatar : 'all';
    const fam = old === 'family' ? await require('./social').familyIds(gc) : null;
    ok = (r) => r === owner || old === 'all' || (old === 'family' && (!fam || (fam.has(r) && fam.has(owner))));
  }
  const blocked = new Set();
  for (const b of await store.all(gc, 'SELECT user_id, blocked_id FROM blocks WHERE user_id = ? OR blocked_id = ?', [owner, owner])) {
    blocked.add(b.user_id === owner ? b.blocked_id : b.user_id);
  }
  for (const r of readers) if (ok(r) && !blocked.has(r)) out.add(r);
  return out;
}

/** An older app wrote privacy.avatar: the person's own change goes to the profile (only during her request). → level */
async function forward(gc, userId, old) {
  const r = await gc.users.setAvatarVisibility(userId, fromOld(old));
  return r && LEVELS.includes(r.level) ? r.level : fromOld(old);
}

module.exports = { LEVELS, ADOPTED, inProfile, fromOld, toOld, levelOf, coreFamilies, sameFamily, partnersOf, sees, pushReaders, adoptAll, forward };
