'use strict';

// Members and roles (table members). Only GateControl users (gc.users.list,
// enabled accounts) can be members; a member whose account is gone or
// disabled simply drops out of every list.
//
// Age is computed from the birthdate on the plugin's local date. A child of
// 18 or older counts as an adult for locating: never locatable, the admin
// page shows "volljährig – Ortung beendet", the API refuses (code 'adult').
// From 14 we recommend "Kind bestätigt": the admin pages show a hint for a
// child of 14+ on "Automatisch", and on the 14th birthday the parents get a
// push (ageHints, tick) — the mode never changes by itself.
//
// Role 'wall' (1.1.0): a GateControl account for a fixed tablet (e.g.
// "Küche"). It is no family member anywhere — not in fam.list / fam.byId,
// so it gets no pushes and is never an assignee, driver or locatable — but
// it is in fam.walls and fam.all (admin page); see server/wall.js.

const store = require('./store');
const tz = require('./tz');
const push = require('./push');
const notices = require('./notices');
const { fail, posInt, intIn, date } = require('./util');

const ROLES = ['parent', 'child', 'wall'];
const LOCATE_MODES = ['confirm', 'auto', 'off'];
const COLORS = ['#0F766E', '#1E3A8A', '#8A3C08', '#5B21B6', '#B45309', '#BE185D', '#047857', '#4338CA', '#9F1239', '#0E7490'];
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const ADULT_AGE = 18;
const CONFIRM_AGE = 14;
const AGE_HINT_AT = { hh: 9, mm: 0 };

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
  const a = r.birthdate && r.role !== 'wall' ? age(r.birthdate, today) : null;
  return {
    userId: r.user_id,
    name: u.name,
    gcRole: u.role,
    role: ROLES.includes(r.role) ? r.role : 'parent',
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
 * The family as of `today`: { users: Map(id → user), list: [member], byId: Map(id → member),
 * walls: Map(id → wall member), all: [member + wall] }. Wall tablets are not in list / byId.
 */
async function load(gc, today) {
  const users = await usersById(gc);
  const rows = await store.all(gc, 'SELECT * FROM members ORDER BY CASE role WHEN \'parent\' THEN 0 WHEN \'child\' THEN 1 ELSE 2 END, created_at, user_id');
  const all = rows.filter((r) => users.has(r.user_id)).map((r) => rowToMember(r, users.get(r.user_id), today));
  const list = all.filter((m) => m.role !== 'wall');
  const walls = all.filter((m) => m.role === 'wall');
  return { users, list, byId: new Map(list.map((m) => [m.userId, m])), walls: new Map(walls.map((m) => [m.userId, m])), all, today };
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

/** A child of 14+ (not yet adult) whose phone answers locate requests automatically: we recommend "Kind bestätigt". */
function ageHint(m) {
  return !!(m && m.role === 'child' && !m.adult && m.age != null && m.age >= CONFIRM_AGE && m.locateMode === 'auto');
}

/** May this member drive (take a ride)? Parents and adult children. */
function canDrive(m) {
  return !!(m && (m.role === 'parent' || (m.role === 'child' && m.adult)));
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
  if (role === 'wall') {
    // a wall tablet has no birthday, no locating and no stars
    out.birthdate = null;
    if (!existing) { out.locate_mode = 'confirm'; out.star_goal = 20; }
    if (body.color !== undefined) {
      if (body.color !== null && !COLOR_RE.test(String(body.color))) throw fail('invalid');
      out.color = body.color;
    }
    return out;
  }
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
  if (f.role === 'parent' || f.role === 'wall' || f.locate_mode === 'off') {
    // no longer locatable: an open request ends now
    await store.run(gc, "UPDATE locate_requests SET status = 'expired' WHERE child_id = ? AND status = 'pending'", [userId]);
  }
  if (f.role === 'wall') {
    // a wall tablet has no place reminders of its own
    await store.run(gc, 'DELETE FROM places WHERE owner_id = ? OR target_user_id = ?', [userId, userId]);
  }
}

/**
 * Remove a member: the person's place reminders and emergency card go, open
 * locate requests end; shared data (lists, dates, rides) stays.
 */
async function remove(gc, userId) {
  const r = await store.run(gc, 'DELETE FROM members WHERE user_id = ?', [userId]);
  if (!r.changes) throw fail('not_found');
  await store.run(gc, 'DELETE FROM places WHERE owner_id = ? OR target_user_id = ?', [userId, userId]);
  await store.run(gc, 'DELETE FROM emergency_cards WHERE user_id = ?', [userId]);
  await store.run(gc, "UPDATE locate_requests SET status = 'expired' WHERE (child_id = ? OR requested_by = ?) AND status = 'pending'", [userId, userId]);
}

/**
 * Background (from 09:00 local): on a child's 14th birthday, if its phone
 * still answers automatically, the parents get a hint — once. The mode is
 * never changed by itself. Collects pushes.
 */
async function ageHints(gc, fam, cfg, now, pushes) {
  const today = tz.localDate(now, cfg.tz);
  if (now < tz.at(today, AGE_HINT_AT, cfg.tz)) return;
  const yesterday = tz.addDays(today, -1);
  const to = parents(fam).map((m) => m.userId);
  for (const m of children(fam)) {
    if (!m.birthdate || m.locateMode !== 'auto') continue;
    if (age(m.birthdate, today) !== CONFIRM_AGE || age(m.birthdate, yesterday) !== CONFIRM_AGE - 1) continue;
    if (!(await notices.once(gc, `age14:${m.userId}:${today}`, now))) continue;
    if (!to.length) continue;
    pushes.push({
      topic: 'locate', users: to, priority: 'normal', collapseKey: `agehint:${m.userId}`, ttl: 24 * 3600,
      title: push.t(cfg.lang, 'locate.age_hint', { name: m.name }), body: push.t(cfg.lang, 'locate.age_hint_body', { name: m.name }),
      data: { familie: { type: 'locate_age_hint', childId: m.userId } },
    });
  }
}

module.exports = {
  ROLES, LOCATE_MODES, COLORS, ADULT_AGE, CONFIRM_AGE, age, usersById, load, parents, children, locateRefusal, effectiveMode, ageHint, canDrive,
  meView, memberView, add, update, remove, ageHints,
};
