'use strict';

// 1.4.0 — who may see what of whom: the family (the members of Familie's managed group "family"),
// audiences ('all' | 'family' | 'custom' | 'nobody'), blocks and last seen / online.
//
//   family     = active members of the conversation managed by gatecontrol-familie with the key 'family';
//                without such a group (no Familie) 'family' means the same as 'all'.
//   blocks     = A blocked B: B cannot write to A in their direct chat (nor A to B — unblock first), and
//                neither sees the other's status, stories, last seen or online state. Groups are not affected.
//   last seen  = prefs.last_seen (every request of the person's apps / portal, written at most once a minute);
//                symmetric like read receipts: whoever hides theirs from someone sees nothing of that person.

const store = require('./store');
const people = require('./people');
const { iso } = require('./util');

const FAMILIE = 'gatecontrol-familie';
const ONLINE_MS = 150000; // a request within the last 2.5 min (written once a minute, active pings every 20 s)

/** Set of the family's user ids, or null when there is no Familie group. */
async function familyIds(gc) {
  const conv = await store.one(gc, "SELECT id FROM conversations WHERE managed_by = ? AND managed_key = 'family'", [FAMILIE]);
  if (!conv) return null;
  const rows = await store.all(gc, 'SELECT user_id FROM members WHERE conv_id = ? AND left_at IS NULL', [conv.id]);
  return new Set(rows.map((r) => r.user_id));
}

/** Every block as { by: Map userId → Set (blocked by them), of: Map userId → Set (who blocked them) }. */
async function blockMap(gc) {
  const by = new Map();
  const of = new Map();
  for (const r of await store.all(gc, 'SELECT user_id, blocked_id FROM blocks')) {
    if (!by.has(r.user_id)) by.set(r.user_id, new Set());
    by.get(r.user_id).add(r.blocked_id);
    if (!of.has(r.blocked_id)) of.set(r.blocked_id, new Set());
    of.get(r.blocked_id).add(r.user_id);
  }
  return { by, of };
}

/**
 * The social facts of one request (cached on ctx): family, blocks, everyone's prefs (privacy, last seen).
 * → { fam, blocks, prefs: Map, blocked(a, b), allows(setting, viewer, owner) }
 */
async function load(ctx) {
  if (ctx._social) return ctx._social;
  const gc = ctx.gc;
  const fam = await familyIds(gc);
  const blocks = await blockMap(gc);
  const ids = [...ctx.users.keys()];
  const prefs = await people.prefsOf(gc, ids);
  const s = {
    fam,
    blocks,
    prefs,
    /** Did either of the two block the other? */
    blocked(a, b) { return !!((blocks.by.get(a) && blocks.by.get(a).has(b)) || (blocks.by.get(b) && blocks.by.get(b).has(a))); },
    /** Did `a` block `b`? */
    hasBlocked(a, b) { return !!(blocks.by.get(a) && blocks.by.get(a).has(b)); },
    inFamily(u) { return !fam || fam.has(u); },
    /** May `viewer` see what `owner` shares with `setting` ('all' | 'family' | 'nobody')? */
    allows(setting, viewer, owner) {
      if (viewer === owner) return true;
      if (setting === 'all') return true;
      if (setting === 'family') return !fam || (fam.has(viewer) && fam.has(owner));
      return false;
    },
    /** An audience of a status / story: 'all' | 'family' | 'custom' with ids. */
    audience(visibility, userIds, viewer, owner) {
      if (viewer === owner) return true;
      if (s.blocked(viewer, owner)) return false;
      if (visibility === 'all') return true;
      if (visibility === 'family') return !fam || (fam.has(viewer) && fam.has(owner));
      if (visibility === 'custom') return Array.isArray(userIds) && userIds.includes(viewer);
      return false;
    },
  };
  ctx._social = s;
  return s;
}

/** { online, lastSeenAt } of `target` as `viewer` may see it (hidden → { online: false, lastSeenAt: null, hidden: true }). */
function presence(s, viewer, target, now) {
  const hidden = { online: false, lastSeenAt: null, hidden: true };
  if (viewer == null || target === viewer) return hidden;
  if (s.blocked(viewer, target)) return hidden;
  const pt = s.prefs.get(target);
  const pv = s.prefs.get(viewer);
  if (!pt || !pv) return hidden;
  if (!s.allows(pt.privacy.lastSeen, viewer, target) || !s.allows(pv.privacy.lastSeen, target, viewer)) return hidden;
  const at = pt.lastSeen || null;
  return { online: !!(at && now - at < ONLINE_MS && now >= at - 60000), lastSeenAt: iso(at), hidden: false };
}

/**
 * The accounts map as `viewer` sees it: avatarUrl null for people whose avatar privacy excludes the viewer.
 * Returns the same map when nothing is hidden.
 */
function maskUsers(s, users, viewer) {
  if (viewer == null) return users;
  let out = null;
  for (const [id, u] of users) {
    const p = s.prefs.get(id);
    if (!p || id === viewer || !u.avatarUrl) continue;
    if (s.allows(p.privacy.avatar, viewer, id) && !s.blocked(viewer, id)) continue;
    if (!out) out = new Map(users);
    out.set(id, { ...u, avatarUrl: null });
  }
  return out || users;
}

/** May `adder` add `target` to a group (privacy.groupAdd)? */
function mayAdd(s, adder, target) {
  if (adder === target) return true;
  const p = s.prefs.get(target);
  if (!p) return true;
  if (s.hasBlocked(target, adder)) return false;
  return s.allows(p.privacy.groupAdd, adder, target);
}

module.exports = { load, presence, maskUsers, mayAdd, familyIds, FAMILIE, ONLINE_MS };
