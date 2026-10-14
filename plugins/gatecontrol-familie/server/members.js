'use strict';

// Members and roles (table members). Only GateControl users (gc.users.list,
// enabled accounts) can be members; a member whose account is gone or
// disabled simply drops out of every list.
//
// Age is computed from the birthdate on the plugin's local date. A child of
// 18 or older counts as an adult for locating: never locatable, the admin
// page shows "volljährig – Ortung beendet", the API refuses (code 'adult').

const store = require('./store');
const tz = require('./tz');
const { fail, posInt, intIn, date } = require('./util');

const ROLES = ['parent', 'child'];
const LOCATE_MODES = ['confirm', 'auto', 'off'];
const COLORS = ['#0F766E', '#1E3A8A', '#8A3C08', '#5B21B6', '#B45309', '#BE185D', '#047857', '#4338CA', '#9F1239', '#0E7490'];
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const ADULT_AGE = 18;

/** Full years from birthdate to today (both YYYY-MM-DD); a 29 February birthday counts from 1 March in other years. */
function age(birthdate, today) {
  const b = tz.parseDate(birthdate);
  const t = tz.parseDate(today);
  if (!b || !t) return null;
  let a = t.y - b.y;
  if (t.m < b.m || (t.m === b.m && t.d < b.d)) a--;
  return a < 0 ? 0 : a;
}

async function usersById(gc) {
  const m = new Map();
  try {
    for (const u of await gc.users.list()) if (Number.isSafeInteger(u.id)) m.set(u.id, { id: u.id, name: String(u.name || ''), role: u.role });
  } catch { /* users unavailable */ }
  return m;
}

function rowToMember(r, u, today) {
  const a = r.birthdate ? age(r.birthdate, today) : null;
  return {
    userId: r.user_id,
    name: u.name,
    gcRole: u.role,
    role: r.role === 'child' ? 'child' : 'parent',
    birthdate: r.birthdate || null,
    age: a,
    adult: r.role === 'child' && a != null && a >= ADULT_AGE,
    locateMode: LOCATE_MODES.includes(r.locate_mode) ? r.locate_mode : 'confirm',
    starGoal: r.star_goal,
    color: COLOR_RE.test(r.color || '') ? r.color : COLORS[(r.user_id - 1) % COLORS.length],
    createdAt: r.created_at,
  };
}

/**
 * The family as of `today`: { users: Map(id → user), list: [member], byId: Map(id → member) }.
 */
async function load(gc, today) {
  const users = await usersById(gc);
  const rows = await store.all(gc, 'SELECT * FROM members ORDER BY CASE role WHEN \'parent\' THEN 0 ELSE 1 END, created_at, user_id');
  const list = rows.filter((r) => users.has(r.user_id)).map((r) => rowToMember(r, users.get(r.user_id), today));
  return { users, list, byId: new Map(list.map((m) => [m.userId, m])), today };
}

const parents = (fam) => fam.list.filter((m) => m.role === 'parent');
const children = (fam) => fam.list.filter((m) => m.role === 'child');

/** May this child be located right now (module, role, minor, mode)? → null or the refusal code. */
function locateRefusal(m, cfg) {
  if (!m || m.role !== 'child') return 'not_found';
  if (!cfg.modules.locate) return 'module_off';
  if (!m.birthdate || m.age == null || m.adult) return 'adult';
  if (m.locateMode === 'off') return 'locate_off';
  return null;
}

/** The effective locate mode of a member (null for parents; 'off' for adults). */
function effectiveMode(m) {
  if (m.role !== 'child') return null;
  return m.adult || !m.birthdate ? 'off' : m.locateMode;
}

/** GET me → me */
function meView(m) {
  return { userId: m.userId, name: m.name, role: m.role, age: m.role === 'child' ? m.age : null, locateMode: effectiveMode(m), color: m.color };
}

/** A member as `viewer` may see it (locate fields: children, for parents only). */
function memberView(viewer, m, cfg) {
  const v = { userId: m.userId, name: m.name, role: m.role, age: m.role === 'child' ? m.age : null, color: m.color };
  if (viewer.role === 'parent' && m.role === 'child') {
    v.locateMode = effectiveMode(m);
    v.locatable = locateRefusal(m, cfg) === null;
  }
  return v;
}

// ─── Admin ──────────────────────────────────────

function checkFields(body, existing, today) {
  const out = {};
  const role = body.role !== undefined ? body.role : (existing ? existing.role : undefined);
  if (!ROLES.includes(role)) throw fail('invalid');
  out.role = role;
  let birthdate = existing ? existing.birthdate : null;
  if (body.birthdate !== undefined) {
    if (body.birthdate === null || body.birthdate === '') birthdate = null;
    else {
      birthdate = date(body.birthdate);
      if (birthdate > today || birthdate < '1900-01-01') throw fail('invalid');
    }
  }
  if (role === 'child' && !birthdate) throw Object.assign(fail('invalid'), { field: 'birthdate' });
  out.birthdate = birthdate;
  if (body.locateMode !== undefined) {
    if (!LOCATE_MODES.includes(body.locateMode)) throw fail('invalid');
    out.locate_mode = body.locateMode;
  } else if (!existing) out.locate_mode = 'confirm';
  if (body.starGoal !== undefined) out.star_goal = intIn(body.starGoal, 1, 500);
  else if (!existing) out.star_goal = 20;
  if (body.color !== undefined) {
    if (body.color !== null && !COLOR_RE.test(String(body.color))) throw fail('invalid');
    out.color = body.color;
  }
  return out;
}

async function add(gc, fam, body, now) {
  const userId = posInt(body && body.userId);
  if (!userId || !fam.users.has(userId)) throw fail('not_found');
  if (await store.one(gc, 'SELECT user_id FROM members WHERE user_id = ?', [userId])) throw fail('invalid');
  const f = checkFields(body, null, fam.today);
  if (f.color === undefined) {
    const used = new Set(fam.list.map((m) => m.color));
    f.color = COLORS.find((c) => !used.has(c)) || COLORS[fam.list.length % COLORS.length];
  }
  await store.run(gc, 'INSERT INTO members (user_id, role, birthdate, locate_mode, star_goal, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, f.role, f.birthdate, f.locate_mode, f.star_goal, f.color, now]);
  return userId;
}

async function update(gc, fam, userId, body) {
  const row = await store.one(gc, 'SELECT * FROM members WHERE user_id = ?', [userId]);
  if (!row) throw fail('not_found');
  const f = checkFields(body || {}, { role: row.role, birthdate: row.birthdate }, fam.today);
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(f)) { sets.push(`${k} = ?`); params.push(v); }
  await store.run(gc, `UPDATE members SET ${sets.join(', ')} WHERE user_id = ?`, [...params, userId]);
  if (f.role === 'parent' || f.locate_mode === 'off') {
    // no longer locatable: an open request ends now
    await store.run(gc, "UPDATE locate_requests SET status = 'expired' WHERE child_id = ? AND status = 'pending'", [userId]);
  }
}

/** Remove a member: the person's place reminders go, open locate requests end; shared data (lists, dates) stays. */
async function remove(gc, userId) {
  const r = await store.run(gc, 'DELETE FROM members WHERE user_id = ?', [userId]);
  if (!r.changes) throw fail('not_found');
  await store.run(gc, 'DELETE FROM places WHERE owner_id = ? OR target_user_id = ?', [userId, userId]);
  await store.run(gc, "UPDATE locate_requests SET status = 'expired' WHERE (child_id = ? OR requested_by = ?) AND status = 'pending'", [userId, userId]);
}

module.exports = {
  ROLES, LOCATE_MODES, COLORS, ADULT_AGE, age, usersById, load, parents, children, locateRefusal, effectiveMode, meView, memberView, add, update, remove,
};
