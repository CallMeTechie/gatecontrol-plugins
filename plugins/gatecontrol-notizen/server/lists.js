'use strict';

// Task lists and list groups. A list belongs to its owner; members (shared lists) see and change its tasks. Each
// person has a default list „Aufgaben“ per area, made the first time it is needed.

const store = require('./store');
const people = require('./people');
const events = require('./events');
const clientIds = require('./clientids');
const push = require('./push');
const pushprefs = require('./pushprefs');
const { t } = require('./text');
const tz = require('./tz');
const { fail, posInt, line, area: areaOf, color: colorOf, isTime, same, stale } = require('./util');

const MAX_LISTS = 500;
const MAX_MEMBERS = 50;

const ICONS = ['list', 'cart', 'home', 'tool', 'gift', 'plane', 'heart', 'work'];
const ROLES = ['read', 'write'];
const TRASH_MS = 30 * 86400000;

/** ISO weekday (1 = Monday … 7 = Sunday) of "YYYY-MM-DD". */
const isoDay = (date) => tz.weekday(date) || 7;
/** [1..7] ↔ bits (bit 0 = Monday). */
const daysOf = (mask) => [1, 2, 3, 4, 5, 6, 7].filter((d) => mask & (1 << (d - 1)));
function maskOf(v) {
  if (!Array.isArray(v) || v.length > 7) throw fail('invalid', { field: 'days' });
  let m = 0;
  for (const d of v) { if (!Number.isInteger(d) || d < 1 || d > 7) throw fail('invalid', { field: 'days' }); m |= 1 << (d - 1); }
  return m;
}
const bitOf = (date) => 1 << (isoDay(date) - 1);
function iconArg(v) { if (v == null || v === '') return null; if (!ICONS.includes(v)) throw fail('invalid', { field: 'icon' }); return v; }
function remindArg(v) { if (v == null || v === '') return null; if (!isTime(v)) throw fail('invalid', { field: 'remind' }); return v; }

/** A member who may only look (role read) cannot change the list's tasks. */
function writable(l) { if (l.my_role === 'read') throw fail('forbidden', { reason: 'read_only' }); return l; }
function ownerOnly(l) { if (l.my_role !== 'owner') throw fail('forbidden', { reason: 'owner' }); return l; }

/** The list `id` as `userId` sees it → { list, role } (not_found when not a member). */
async function access(gc, userId, id) {
  const lid = posInt(id);
  if (!lid) throw fail('not_found');
  const r = await store.one(gc, `SELECT l.*, m.role AS my_role, m.group_id AS my_group, m.position AS my_position, m.myday_off AS my_day_off FROM list_members m
    JOIN lists l ON l.id = m.list_id AND l.deleted_at IS NULL WHERE m.user_id = ? AND m.list_id = ?`, [userId, lid]);
  if (!r) throw fail('not_found');
  return r;
}

/** The ids of the lists `userId` sees in an area (null: both). */
async function ids(gc, userId, area) {
  const rows = await store.all(gc, `SELECT l.id FROM list_members m JOIN lists l ON l.id = m.list_id AND l.deleted_at IS NULL
    WHERE m.user_id = ?${area ? ' AND l.area = ?' : ''}`, area ? [userId, area] : [userId]);
  return rows.map((r) => r.id);
}

/** The person's default list of an area, made when missing. */
async function ensureDefault(gc, ctx, area) {
  const a = areaOf(area);
  const have = await store.one(gc, 'SELECT id FROM lists WHERE owner_id = ? AND area = ? AND is_default = 1 AND deleted_at IS NULL', [ctx.userId, a]);
  if (have) return have.id;
  return store.tx(gc, async () => {
    const again = await store.one(gc, 'SELECT id FROM lists WHERE owner_id = ? AND area = ? AND is_default = 1 AND deleted_at IS NULL', [ctx.userId, a]);
    if (again) return again.id;
    const now = ctx.now;
    const r = await store.run(gc, 'INSERT INTO lists (owner_id, area, name, is_default, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)', [ctx.userId, a, t(ctx.lang, 's.default_list'), now, now]);
    const id = Number(r.lastInsertRowid);
    await store.run(gc, 'INSERT INTO list_members (user_id, list_id, role, position) VALUES (?, ?, ?, ?)', [ctx.userId, id, 'owner', -1]);
    return id;
  });
}

async function membersOf(gc, listId) {
  return store.all(gc, "SELECT user_id, role, since FROM list_members WHERE list_id = ? ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, user_id", [listId]);
}
async function memberIds(gc, listId) { return (await membersOf(gc, listId)).map((m) => m.user_id); }

/** A list row (with the my_* columns of access) → the API's List. */
async function view(gc, ctx, l, counts, members) {
  const ms = members || await membersOf(gc, l.id);
  const others = [];
  for (const m of ms) if (m.user_id !== l.owner_id) others.push({ id: m.user_id, name: await people.name(gc, m.user_id), role: m.role === 'read' ? 'read' : 'write', since: m.since || null });
  const mask = l.days || 0;
  return {
    id: l.id, name: l.name, area: l.area, color: l.color || null, icon: l.icon || null, isDefault: !!l.is_default,
    owner: { id: l.owner_id, name: await people.name(gc, l.owner_id) }, role: l.my_role || null, canEdit: !!l.my_role && l.my_role !== 'read',
    groupId: l.my_group || null, position: l.my_position == null ? 0 : l.my_position, shared: ms.length > 1, members: others,
    open: counts ? counts.get(l.id) || 0 : undefined, ext: l.ext_kind ? { kind: l.ext_kind } : null,
    days: daysOf(mask), remind: l.remind || null, mydayOff: !!l.my_day_off, dayToday: !!(ctx && ctx.today && (mask & bitOf(ctx.today))),
  };
}

const LIST_COLS = 'l.*, m.role AS my_role, m.group_id AS my_group, m.position AS my_position, m.myday_off AS my_day_off';

/** GET lists?area= → { lists, groups } */
async function all(gc, ctx, area) {
  const a = area ? areaOf(area) : null;
  await ensureDefault(gc, ctx, a || 'private');
  const rows = await store.all(gc, `SELECT ${LIST_COLS} FROM list_members m
    JOIN lists l ON l.id = m.list_id AND l.deleted_at IS NULL WHERE m.user_id = ?${a ? ' AND l.area = ?' : ''} ORDER BY l.is_default DESC, m.position, l.id LIMIT ${MAX_LISTS}`, a ? [ctx.userId, a] : [ctx.userId]);
  const counts = await openCounts(gc, rows.map((r) => r.id));
  const groups = await store.all(gc, `SELECT id, name, area, position FROM list_groups WHERE user_id = ?${a ? ' AND area = ?' : ''} ORDER BY position, id`, a ? [ctx.userId, a] : [ctx.userId]);
  const out = [];
  for (const r of rows) out.push(await view(gc, ctx, r, counts));
  const inGroup = new Map();
  for (const r of rows) if (r.my_group) inGroup.set(r.my_group, (inGroup.get(r.my_group) || 0) + (counts.get(r.id) || 0));
  return { lists: out, groups: groups.map((g) => ({ id: g.id, name: g.name, area: g.area, position: g.position, open: inGroup.get(g.id) || 0 })) };
}

/** Open top-level tasks per list (idx_tasks_list). */
async function openCounts(gc, listIds) {
  const m = new Map();
  for (const part of store.chunks(listIds)) {
    if (!part.length) continue;
    const rows = await store.all(gc, `SELECT list_id, COUNT(*) AS n FROM tasks INDEXED BY idx_tasks_list WHERE list_id IN (${store.marks(part.length)})
      AND done_at IS NULL AND deleted_at IS NULL AND parent_id IS NULL GROUP BY list_id`, part);
    for (const r of rows) m.set(r.list_id, r.n);
  }
  return m;
}

function nameArg(v) { const n = line(v, 80); if (!n) throw fail('invalid', { field: 'name' }); return n; }

async function groupArg(gc, ctx, v, area) {
  if (v == null) return null;
  const g = posInt(v) ? await store.one(gc, 'SELECT id, area FROM list_groups WHERE id = ? AND user_id = ?', [posInt(v), ctx.userId]) : null;
  if (!g || g.area !== area) throw fail('invalid', { field: 'groupId' });
  return g.id;
}

/** A create sent again with the same clientId: the list as it is now, or 410 when it is gone (deleted, left). */
async function replay(gc, ctx, id, clientId) {
  let l;
  try { l = await access(gc, ctx.userId, id); } catch (e) { if (e && e.code === 'not_found') throw clientIds.gone(clientId, id); throw e; }
  return { list: await view(gc, ctx, l), clientId, replayed: true };
}

/** POST lists { name, area, color?, icon?, groupId?, clientId? } → { list, clientId? } */
async function create(gc, ctx, b) {
  const cid = clientIds.arg(b.clientId);
  if (cid) { const have = await clientIds.find(gc, ctx.userId, cid, 'list'); if (have) return replay(gc, ctx, have, cid); }
  const a = areaOf(b.area);
  const name = nameArg(b.name);
  const c = colorOf(b.color);
  if (c === undefined) throw fail('invalid', { field: 'color' });
  const icon = iconArg(b.icon);
  const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM lists WHERE owner_id = ? AND deleted_at IS NULL', [ctx.userId]);
  if (n.n >= MAX_LISTS) throw fail('too_many');
  const group = await groupArg(gc, ctx, b.groupId, a);
  const made = await store.tx(gc, async () => {
    if (cid) { const again = await clientIds.find(gc, ctx.userId, cid, 'list'); if (again) return { dup: again }; }
    const r = await store.run(gc, 'INSERT INTO lists (owner_id, area, name, color, icon, created_at, updated_at, ext_kind, ext_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [ctx.userId, a, name, c, icon, ctx.now, ctx.now, b.extKind || null, b.extId || null]);
    const lid = Number(r.lastInsertRowid);
    const pos = await store.one(gc, 'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM list_members WHERE user_id = ?', [ctx.userId]);
    await store.run(gc, 'INSERT INTO list_members (user_id, list_id, role, group_id, position, since) VALUES (?, ?, ?, ?, ?, ?)', [ctx.userId, lid, 'owner', group, pos.p, ctx.now]);
    await clientIds.claim(gc, ctx, cid, 'list', lid);
    return { id: lid };
  });
  if (made.dup) return replay(gc, ctx, made.dup, cid);
  events.changed(gc, [ctx.userId], 'lists');
  return { list: await view(gc, ctx, await access(gc, ctx.userId, made.id)), ...(cid ? { clientId: cid } : {}) };
}

/** The fields of PATCH lists only the owner sets, each in one form to compare. */
const OWNER_FIELDS = ['name', 'color', 'icon', 'days', 'remind'];
function normField(f, v) {
  switch (f) {
    case 'name': return nameArg(v);
    case 'color': { const c = colorOf(v); if (c === undefined) throw fail('invalid', { field: 'color' }); return c; }
    case 'icon': return iconArg(v);
    case 'days': return daysOf(maskOf(v));
    case 'remind': return remindArg(v);
    default: return v;
  }
}

/**
 * PATCH lists/<id> { name?, color?, icon?, days?, remind?, area? (owner), groupId?, position?, mydayOff? (own), base? } —
 * `base` as in PATCH tasks: a field of the owner changed meanwhile by someone else → 409 conflict { fields, list }; a
 * value as it is already is not written.
 */
async function update(gc, ctx, id, b0) {
  const l = await access(gc, ctx.userId, id);
  const owner = l.my_role === 'owner';
  const now = { name: l.name, color: l.color || null, icon: l.icon || null, days: daysOf(l.days || 0), remind: l.remind || null };
  const next = {};
  for (const f of OWNER_FIELDS) if (b0[f] !== undefined) next[f] = normField(f, b0[f]);
  const late = stale(b0.base, now, next, normField);
  if (late.length) throw fail('conflict', { fields: late, list: await view(gc, ctx, l) });
  for (const f of Object.keys(next)) if (same(next[f], now[f])) delete next[f];
  const set = [];
  const args = [];
  if (Object.keys(next).length) ownerOnly(l);
  if (next.name !== undefined) { set.push('name = ?'); args.push(next.name); }
  if (next.color !== undefined) { set.push('color = ?'); args.push(next.color); }
  if (next.icon !== undefined) { set.push('icon = ?'); args.push(next.icon); }
  if (next.days !== undefined) { set.push('days = ?'); args.push(maskOf(next.days)); }
  if (next.remind !== undefined) { set.push('remind = ?'); args.push(next.remind); }
  if (b0.area !== undefined && areaOf(b0.area, null) !== l.area) {
    if (!owner) throw fail('forbidden', { reason: 'owner' });
    if (l.is_default) throw fail('forbidden', { reason: 'default' });
    set.push('area = ?'); args.push(areaOf(b0.area, null) || (() => { throw fail('invalid', { field: 'area' }); })());
  }
  const area = set.includes('area = ?') ? areaOf(b0.area) : l.area;
  const group = b0.groupId !== undefined ? await groupArg(gc, ctx, b0.groupId, area) : undefined;
  if (b0.position !== undefined && (typeof b0.position !== 'number' || !Number.isFinite(b0.position))) throw fail('invalid', { field: 'position' });
  await store.tx(gc, async () => {
    if (set.length) await store.run(gc, `UPDATE lists SET ${set.join(', ')}, updated_at = ? WHERE id = ?`, [...args, ctx.now, l.id]);
    if (group !== undefined) await store.run(gc, 'UPDATE list_members SET group_id = ? WHERE user_id = ? AND list_id = ?', [group, ctx.userId, l.id]);
    if (b0.position !== undefined) await store.run(gc, 'UPDATE list_members SET position = ? WHERE user_id = ? AND list_id = ?', [b0.position, ctx.userId, l.id]);
    if (b0.mydayOff !== undefined) await store.run(gc, 'UPDATE list_members SET myday_off = ? WHERE user_id = ? AND list_id = ?', [b0.mydayOff ? 1 : 0, ctx.userId, l.id]);
  });
  events.changed(gc, set.length ? await memberIds(gc, l.id) : [ctx.userId], 'lists');
  return { list: await view(gc, ctx, await access(gc, ctx.userId, l.id)) };
}

/** GET lists/<id>/usage — what a delete would touch (the question before it). */
async function usage(gc, ctx, id) {
  const l = await access(gc, ctx.userId, id);
  const n = await store.one(gc, `SELECT SUM(CASE WHEN done_at IS NULL THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN done_at IS NULL THEN 0 ELSE 1 END) AS done
    FROM tasks INDEXED BY idx_tasks_list WHERE list_id = ? AND deleted_at IS NULL AND parent_id IS NULL`, [l.id]);
  const members = [];
  for (const m of await membersOf(gc, l.id)) if (m.user_id !== l.owner_id) members.push({ id: m.user_id, name: await people.name(gc, m.user_id), role: m.role });
  let target = null;
  if (l.my_role === 'owner' && !l.is_default) {
    const d = await store.one(gc, 'SELECT id, name FROM lists WHERE owner_id = ? AND area = ? AND is_default = 1 AND deleted_at IS NULL', [ctx.userId, l.area]);
    target = d ? { id: d.id, name: d.name } : { id: null, name: t(ctx.lang, 's.default_list') };
  }
  return { open: (n && n.open) || 0, done: (n && n.done) || 0, members, isDefault: !!l.is_default, canDelete: l.my_role === 'owner' && !l.is_default, target };
}

/**
 * DELETE lists/<id>?tasks=move|delete — the owner deletes it: `move` puts the open tasks into the default list of the
 * area (the done ones go to the trash), `delete` (and no parameter, as in 1.1) puts all of them into the trash. A member
 * leaves it. Deleted already by its owner: { ok, gone }. POST lists/<id>/restore undoes it within 30 days.
 */
async function remove(gc, ctx, id, q = {}) {
  let l;
  try { l = await access(gc, ctx.userId, id); } catch (e) {
    if (posInt(id) && await store.one(gc, 'SELECT id FROM lists WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL', [posInt(id), ctx.userId])) return { ok: true, gone: true };
    throw e;
  }
  const members = await memberIds(gc, l.id);
  if (l.my_role !== 'owner') {
    await store.run(gc, 'DELETE FROM list_members WHERE user_id = ? AND list_id = ?', [ctx.userId, l.id]);
    await store.run(gc, 'UPDATE tasks SET assignee_id = NULL WHERE list_id = ? AND assignee_id = ?', [l.id, ctx.userId]);
    events.changed(gc, members, 'lists');
    return { ok: true, left: true };
  }
  if (l.is_default) throw fail('forbidden', { reason: 'default' });
  const mode = q.tasks == null || q.tasks === '' ? 'delete' : q.tasks;
  if (!['move', 'delete'].includes(mode)) throw fail('invalid', { field: 'tasks' });
  const target = mode === 'move' ? await ensureDefault(gc, ctx, l.area) : null;
  const targetMembers = target ? new Set(await memberIds(gc, target)) : null;
  const rows = await store.all(gc, 'SELECT user_id, role, group_id, position, myday_off, since FROM list_members WHERE list_id = ?', [l.id]);
  let moved = [];
  const out = await store.tx(gc, async () => {
    if (target) {
      const open = await store.all(gc, 'SELECT id, assignee_id FROM tasks INDEXED BY idx_tasks_list WHERE list_id = ? AND done_at IS NULL AND deleted_at IS NULL AND parent_id IS NULL', [l.id]);
      moved = open.map((r) => [r.id, r.assignee_id || null]);
      for (const part of store.chunks(open.map((r) => r.id))) {
        if (!part.length) continue;
        const m = store.marks(part.length);
        await store.run(gc, `UPDATE tasks SET list_id = ?, updated_at = ?, ext_dirty = 0 WHERE id IN (${m}) OR (parent_id IN (${m}) AND deleted_at IS NULL)`, [target, ctx.now, ...part, ...part]);
      }
      for (const [tid, who] of moved) if (who && !targetMembers.has(who)) await store.run(gc, 'UPDATE tasks SET assignee_id = NULL WHERE id = ?', [tid]);
    }
    const gone = await store.run(gc, 'UPDATE tasks SET deleted_at = ?, ext_dirty = 0 WHERE list_id = ? AND deleted_at IS NULL', [ctx.now, l.id]);
    const trash = { mode, target, moved, members: rows.map((r) => [r.user_id, r.role, r.group_id || null, r.position, r.myday_off ? 1 : 0, r.since || null]) };
    await store.run(gc, 'UPDATE lists SET deleted_at = ?, trash_json = ? WHERE id = ?', [ctx.now, JSON.stringify(trash), l.id]);
    await store.run(gc, 'DELETE FROM list_members WHERE list_id = ?', [l.id]);
    await store.run(gc, 'DELETE FROM ext_links WHERE list_id = ?', [l.id]);
    return { removed: Number((gone && gone.changes) || 0) };
  });
  const removed = await store.one(gc, 'SELECT COUNT(*) AS n FROM tasks WHERE list_id = ? AND deleted_at = ? AND parent_id IS NULL', [l.id, ctx.now]);
  events.changed(gc, members, 'lists');
  if (target) events.changed(gc, [...targetMembers], 'tasks');
  const td = target ? await store.one(gc, 'SELECT id, name FROM lists WHERE id = ?', [target]) : null;
  return { ok: true, deleted: true, moved: moved.length, removed: removed ? removed.n : out.removed, target: td ? { id: td.id, name: td.name } : null, restoreUntil: ctx.now + TRASH_MS };
}

/** POST lists/<id>/restore — „Rückgängig“: the owner gets a deleted list back (members, roles, tasks) while it is in the trash. */
async function restore(gc, ctx, id) {
  const lid = posInt(id);
  const l = lid && await store.one(gc, 'SELECT * FROM lists WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL', [lid, ctx.userId]);
  if (!l || ctx.now - l.deleted_at > TRASH_MS) throw fail('not_found');
  let trash = null;
  try { trash = l.trash_json ? JSON.parse(l.trash_json) : null; } catch { trash = null; }
  const members = trash && Array.isArray(trash.members) && trash.members.length ? trash.members : [[ctx.userId, 'owner', null, 1000, 0, null]];
  if (!members.some((m) => m[0] === ctx.userId)) members.push([ctx.userId, 'owner', null, 1000, 0, null]);
  const target = trash && posInt(trash.target);
  await store.tx(gc, async () => {
    await store.run(gc, 'UPDATE lists SET deleted_at = NULL, trash_json = NULL, updated_at = ? WHERE id = ?', [ctx.now, l.id]);
    await store.run(gc, 'UPDATE tasks SET deleted_at = NULL WHERE list_id = ? AND deleted_at = ?', [l.id, l.deleted_at]);
    if (target && Array.isArray(trash.moved)) {
      for (const [tid, who] of trash.moved) {
        if (!posInt(tid)) continue;
        const r = await store.run(gc, 'UPDATE tasks SET list_id = ?, assignee_id = COALESCE(assignee_id, ?), updated_at = ? WHERE id = ? AND list_id = ? AND deleted_at IS NULL', [l.id, posInt(who), ctx.now, tid, target]);
        if (r && r.changes) await store.run(gc, 'UPDATE tasks SET list_id = ? WHERE parent_id = ? AND list_id = ?', [l.id, tid, target]);
      }
    }
    for (const m of members) {
      const [uid, role, group, position, off, since] = m;
      if (!posInt(uid)) continue;
      const g = posInt(group) && await store.one(gc, 'SELECT id FROM list_groups WHERE id = ? AND user_id = ? AND area = ?', [group, uid, l.area]);
      await store.run(gc, 'INSERT OR IGNORE INTO list_members (user_id, list_id, role, group_id, position, myday_off, since) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uid, l.id, uid === ctx.userId ? 'owner' : role === 'read' ? 'read' : 'write', g ? g.id : null, typeof position === 'number' ? position : 1000, off ? 1 : 0, since || null]);
    }
  });
  const ms = await memberIds(gc, l.id);
  events.changed(gc, ms, 'lists');
  events.changed(gc, ms, 'tasks');
  return { list: await view(gc, ctx, await access(gc, ctx.userId, l.id)) };
}

/**
 * The wanted members of PUT …/members: [userId…] (1.1: new ones write, the others keep their role) or [{ id, role }…]
 * (1.2.0), mixed too → Map(userId → role | null). The owner is left out.
 */
function wantedMembers(v, ownerId) {
  if (!Array.isArray(v) || v.length > MAX_MEMBERS) throw fail('invalid', { field: 'members' });
  const out = new Map();
  for (const x of v) {
    const obj = x && typeof x === 'object';
    const u = posInt(obj ? x.id : x);
    if (!u) throw fail('invalid', { field: 'members' });
    if (u === ownerId) continue;
    let role = null;
    if (obj && x.role !== undefined && x.role !== null) { if (!ROLES.includes(x.role)) throw fail('invalid', { field: 'role' }); role = x.role; }
    out.set(u, role);
  }
  return out;
}

/** PUT lists/<id>/members { members: [userId | { id, role }…] } — the owner shares the list (roles read | write). */
async function setMembers(gc, ctx, id, b) {
  const l = ownerOnly(await access(gc, ctx.userId, id));
  const want = wantedMembers(b.members, ctx.userId);
  const before = new Map((await membersOf(gc, l.id)).map((m) => [m.user_id, m.role]));
  for (const u of want.keys()) if (!before.has(u) && !(await people.mayShare(gc, ctx.userId, u))) throw fail('forbidden', { userId: u });
  const added = [...want.keys()].filter((u) => !before.has(u));
  const gone = [...before.keys()].filter((u) => u !== ctx.userId && !want.has(u));
  const changedRole = [...want.entries()].filter(([u, r]) => before.has(u) && r && before.get(u) !== r && before.get(u) !== 'owner');
  await store.tx(gc, async () => {
    for (const u of added) await store.run(gc, 'INSERT OR IGNORE INTO list_members (user_id, list_id, role, position, since) VALUES (?, ?, ?, ?, ?)', [u, l.id, want.get(u) || 'write', 1000, ctx.now]);
    for (const [u, r] of changedRole) await store.run(gc, 'UPDATE list_members SET role = ? WHERE user_id = ? AND list_id = ?', [r, u, l.id]);
    for (const u of gone) {
      await store.run(gc, 'DELETE FROM list_members WHERE user_id = ? AND list_id = ?', [u, l.id]);
      await store.run(gc, 'UPDATE tasks SET assignee_id = NULL WHERE list_id = ? AND assignee_id = ?', [l.id, u]);
    }
  });
  if (added.length) {
    await pushprefs.send(gc, added, 'shared', { topic: 'shared', title: t(ctx.notifyLang, 'n.shared_title', { name: ctx.userName || '' }), body: l.name,
      collapseKey: 'list:' + l.id, data: { notizen: push.sharedList(l) } });
  }
  events.changed(gc, [...new Set([...before.keys(), ...added])], 'lists');
  return { list: await view(gc, ctx, await access(gc, ctx.userId, l.id)) };
}

/** POST groups { name, area, lists?: [listId…] }, PATCH groups/<id> { name?, position? }, DELETE groups/<id> (the lists stay) */
async function createGroup(gc, ctx, b) {
  const cid = clientIds.arg(b.clientId);
  const groupOf = async (gid) => {
    const g = await store.one(gc, 'SELECT * FROM list_groups WHERE id = ? AND user_id = ?', [gid, ctx.userId]);
    if (!g) throw clientIds.gone(cid, gid);
    return { group: { id: g.id, name: g.name, area: g.area, position: g.position }, clientId: cid, replayed: true };
  };
  if (cid) { const have = await clientIds.find(gc, ctx.userId, cid, 'group'); if (have) return groupOf(have); }
  const name = nameArg(b.name);
  const area = areaOf(b.area);
  const put = [];
  if (b.lists !== undefined) {
    if (!Array.isArray(b.lists) || b.lists.length > MAX_LISTS) throw fail('invalid', { field: 'lists' });
    for (const x of b.lists) {
      let l;
      try { l = await access(gc, ctx.userId, x); } catch { throw fail('invalid', { field: 'lists' }); }
      if (l.area !== area) throw fail('invalid', { field: 'lists' });
      put.push(l.id);
    }
  }
  const position = typeof b.position === 'number' && Number.isFinite(b.position) ? b.position : 0;
  const made = await store.tx(gc, async () => {
    if (cid) { const again = await clientIds.find(gc, ctx.userId, cid, 'group'); if (again) return { dup: again }; }
    const r = await store.run(gc, 'INSERT INTO list_groups (user_id, area, name, position, created_at) VALUES (?, ?, ?, ?, ?)', [ctx.userId, area, name, position, ctx.now]);
    const gid = Number(r.lastInsertRowid);
    for (const lid of put) await store.run(gc, 'UPDATE list_members SET group_id = ? WHERE user_id = ? AND list_id = ?', [gid, ctx.userId, lid]);
    await clientIds.claim(gc, ctx, cid, 'group', gid);
    return { id: gid };
  });
  if (made.dup) return groupOf(made.dup);
  events.changed(gc, [ctx.userId], 'lists');
  return { group: { id: made.id, name, area, position }, ...(cid ? { clientId: cid } : {}) };
}
async function updateGroup(gc, ctx, id, b) {
  const g = await store.one(gc, 'SELECT * FROM list_groups WHERE id = ? AND user_id = ?', [posInt(id), ctx.userId]);
  if (!g) throw fail('not_found');
  const name = b.name !== undefined ? nameArg(b.name) : g.name;
  const position = typeof b.position === 'number' && Number.isFinite(b.position) ? b.position : g.position;
  await store.run(gc, 'UPDATE list_groups SET name = ?, position = ? WHERE id = ?', [name, position, g.id]);
  events.changed(gc, [ctx.userId], 'lists');
  return { ok: true, group: { id: g.id, name, area: g.area, position } };
}
async function removeGroup(gc, ctx, id) {
  const g = await store.one(gc, 'SELECT * FROM list_groups WHERE id = ? AND user_id = ?', [posInt(id), ctx.userId]);
  if (!g) throw fail('not_found');
  await store.run(gc, 'UPDATE list_members SET group_id = NULL WHERE user_id = ? AND group_id = ?', [ctx.userId, g.id]);
  await store.run(gc, 'DELETE FROM list_groups WHERE id = ?', [g.id]);
  events.changed(gc, [ctx.userId], 'lists');
  return { ok: true };
}

module.exports = {
  ICONS, ROLES, TRASH_MS, isoDay, bitOf, daysOf, access, ids, ensureDefault, membersOf, memberIds, view, all, openCounts, create, update, usage, remove, restore,
  setMembers, wantedMembers, writable, ownerOnly, createGroup, updateGroup, removeGroup, LIST_COLS,
};
