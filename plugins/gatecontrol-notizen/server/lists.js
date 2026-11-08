'use strict';

// Task lists and list groups. A list belongs to its owner; members (shared lists) see and change its tasks. Each
// person has a default list „Aufgaben“ per area, made the first time it is needed.

const store = require('./store');
const people = require('./people');
const events = require('./events');
const { t } = require('./text');
const { fail, posInt, line, area: areaOf, color: colorOf } = require('./util');

const MAX_LISTS = 500;
const MAX_MEMBERS = 50;

/** The list `id` as `userId` sees it → { list, role } (not_found when not a member). */
async function access(gc, userId, id) {
  const lid = posInt(id);
  if (!lid) throw fail('not_found');
  const r = await store.one(gc, `SELECT l.*, m.role AS my_role, m.group_id AS my_group, m.position AS my_position FROM list_members m
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
  return store.all(gc, 'SELECT user_id, role FROM list_members WHERE list_id = ? ORDER BY role DESC, user_id', [listId]);
}
async function memberIds(gc, listId) { return (await membersOf(gc, listId)).map((m) => m.user_id); }

async function view(gc, l, counts, members) {
  const ms = members || await membersOf(gc, l.id);
  const others = [];
  for (const m of ms) if (m.user_id !== l.owner_id) others.push({ id: m.user_id, name: await people.name(gc, m.user_id) });
  return {
    id: l.id, name: l.name, area: l.area, color: l.color || null, icon: l.icon || null, isDefault: !!l.is_default,
    owner: { id: l.owner_id, name: await people.name(gc, l.owner_id) }, role: l.my_role || null, groupId: l.my_group || null,
    position: l.my_position == null ? 0 : l.my_position, shared: ms.length > 1, members: others,
    open: counts ? counts.get(l.id) || 0 : undefined, ext: l.ext_kind ? { kind: l.ext_kind } : null,
  };
}

/** GET lists?area= → { lists, groups } */
async function all(gc, ctx, area) {
  const a = area ? areaOf(area) : null;
  await ensureDefault(gc, ctx, a || 'private');
  const rows = await store.all(gc, `SELECT l.*, m.role AS my_role, m.group_id AS my_group, m.position AS my_position FROM list_members m
    JOIN lists l ON l.id = m.list_id AND l.deleted_at IS NULL WHERE m.user_id = ?${a ? ' AND l.area = ?' : ''} ORDER BY l.is_default DESC, m.position, l.id LIMIT ${MAX_LISTS}`, a ? [ctx.userId, a] : [ctx.userId]);
  const counts = await openCounts(gc, rows.map((r) => r.id));
  const groups = await store.all(gc, `SELECT id, name, area, position FROM list_groups WHERE user_id = ?${a ? ' AND area = ?' : ''} ORDER BY position, id`, a ? [ctx.userId, a] : [ctx.userId]);
  const out = [];
  for (const r of rows) out.push(await view(gc, r, counts));
  return { lists: out, groups: groups.map((g) => ({ id: g.id, name: g.name, area: g.area, position: g.position })) };
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

/** POST lists { name, area, color?, groupId? } */
async function create(gc, ctx, b) {
  const a = areaOf(b.area);
  const name = nameArg(b.name);
  const c = colorOf(b.color);
  if (c === undefined) throw fail('invalid', { field: 'color' });
  const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM lists WHERE owner_id = ? AND deleted_at IS NULL', [ctx.userId]);
  if (n.n >= MAX_LISTS) throw fail('too_many');
  const group = await groupArg(gc, ctx, b.groupId, a);
  const id = await store.tx(gc, async () => {
    const r = await store.run(gc, 'INSERT INTO lists (owner_id, area, name, color, created_at, updated_at, ext_kind, ext_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [ctx.userId, a, name, c, ctx.now, ctx.now, b.extKind || null, b.extId || null]);
    const lid = Number(r.lastInsertRowid);
    const pos = await store.one(gc, 'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM list_members WHERE user_id = ?', [ctx.userId]);
    await store.run(gc, 'INSERT INTO list_members (user_id, list_id, role, group_id, position) VALUES (?, ?, ?, ?, ?)', [ctx.userId, lid, 'owner', group, pos.p]);
    return lid;
  });
  events.changed(gc, [ctx.userId], 'lists');
  return { list: await view(gc, await access(gc, ctx.userId, id)) };
}

/** PATCH lists/<id> { name?, color?, area? (owner), groupId?, position? (own) } */
async function update(gc, ctx, id, b) {
  const l = await access(gc, ctx.userId, id);
  const owner = l.my_role === 'owner';
  const set = [];
  const args = [];
  if (b.name !== undefined) { if (!owner) throw fail('forbidden'); set.push('name = ?'); args.push(nameArg(b.name)); }
  if (b.color !== undefined) { const c = colorOf(b.color); if (c === undefined) throw fail('invalid', { field: 'color' }); if (!owner) throw fail('forbidden'); set.push('color = ?'); args.push(c); }
  if (b.area !== undefined) {
    if (!owner || l.is_default) throw fail('forbidden');
    set.push('area = ?'); args.push(areaOf(b.area, null) || (() => { throw fail('invalid', { field: 'area' }); })());
  }
  await store.tx(gc, async () => {
    if (set.length) await store.run(gc, `UPDATE lists SET ${set.join(', ')}, updated_at = ? WHERE id = ?`, [...args, ctx.now, l.id]);
    if (b.groupId !== undefined) await store.run(gc, 'UPDATE list_members SET group_id = ? WHERE user_id = ? AND list_id = ?', [await groupArg(gc, ctx, b.groupId, b.area || l.area), ctx.userId, l.id]);
    if (b.position !== undefined) { if (typeof b.position !== 'number' || !Number.isFinite(b.position)) throw fail('invalid', { field: 'position' }); await store.run(gc, 'UPDATE list_members SET position = ? WHERE user_id = ? AND list_id = ?', [b.position, ctx.userId, l.id]); }
  });
  events.changed(gc, await memberIds(gc, l.id), 'lists');
  return { list: await view(gc, await access(gc, ctx.userId, l.id)) };
}

/** DELETE lists/<id> — the owner deletes it (with its tasks); a member leaves it. */
async function remove(gc, ctx, id) {
  const l = await access(gc, ctx.userId, id);
  const members = await memberIds(gc, l.id);
  if (l.my_role !== 'owner') {
    await store.run(gc, 'DELETE FROM list_members WHERE user_id = ? AND list_id = ?', [ctx.userId, l.id]);
    await store.run(gc, 'UPDATE tasks SET assignee_id = NULL WHERE list_id = ? AND assignee_id = ?', [l.id, ctx.userId]);
    events.changed(gc, members, 'lists');
    return { ok: true, left: true };
  }
  if (l.is_default) throw fail('forbidden', { reason: 'default' });
  await store.tx(gc, async () => {
    await store.run(gc, 'UPDATE lists SET deleted_at = ? WHERE id = ?', [ctx.now, l.id]);
    await store.run(gc, 'UPDATE tasks SET deleted_at = ?, ext_dirty = 0 WHERE list_id = ? AND deleted_at IS NULL', [ctx.now, l.id]);
    await store.run(gc, 'DELETE FROM list_members WHERE list_id = ?', [l.id]);
    await store.run(gc, 'DELETE FROM ext_links WHERE list_id = ?', [l.id]);
  });
  events.changed(gc, members, 'lists');
  return { ok: true };
}

/** PUT lists/<id>/members { members: [userId…] } — the owner shares the list (everyone writes). */
async function setMembers(gc, ctx, id, b) {
  const l = await access(gc, ctx.userId, id);
  if (l.my_role !== 'owner') throw fail('forbidden');
  if (!Array.isArray(b.members) || b.members.length > MAX_MEMBERS) throw fail('invalid', { field: 'members' });
  const want = [...new Set(b.members.map(posInt))].filter((x) => x && x !== ctx.userId);
  if (want.length !== b.members.filter((x) => posInt(x) !== ctx.userId).length) throw fail('invalid', { field: 'members' });
  const before = await memberIds(gc, l.id);
  for (const u of want) if (!before.includes(u) && !(await people.mayShare(gc, ctx.userId, u))) throw fail('forbidden', { userId: u });
  const added = want.filter((u) => !before.includes(u));
  const gone = before.filter((u) => u !== ctx.userId && !want.includes(u));
  await store.tx(gc, async () => {
    for (const u of added) await store.run(gc, 'INSERT OR IGNORE INTO list_members (user_id, list_id, role, position) VALUES (?, ?, ?, ?)', [u, l.id, 'write', 1000]);
    for (const u of gone) {
      await store.run(gc, 'DELETE FROM list_members WHERE user_id = ? AND list_id = ?', [u, l.id]);
      await store.run(gc, 'UPDATE tasks SET assignee_id = NULL WHERE list_id = ? AND assignee_id = ?', [l.id, u]);
    }
  });
  if (added.length) {
    await gc.notify({ topic: 'shared', title: t(ctx.notifyLang, 'n.shared_title', { name: ctx.userName || '' }), body: l.name, users: added,
      collapseKey: 'list:' + l.id, data: { notizen: { list: l.id } } }).catch(() => {});
  }
  events.changed(gc, [...new Set([...before, ...added])], 'lists');
  return { list: await view(gc, await access(gc, ctx.userId, l.id)) };
}

/** POST groups { name, area }, PATCH groups/<id> { name?, position? }, DELETE groups/<id> */
async function createGroup(gc, ctx, b) {
  const r = await store.run(gc, 'INSERT INTO list_groups (user_id, area, name, position, created_at) VALUES (?, ?, ?, ?, ?)', [ctx.userId, areaOf(b.area), nameArg(b.name), Number(b.position) || 0, ctx.now]);
  events.changed(gc, [ctx.userId], 'lists');
  return { group: { id: Number(r.lastInsertRowid), name: nameArg(b.name), area: areaOf(b.area) } };
}
async function updateGroup(gc, ctx, id, b) {
  const g = await store.one(gc, 'SELECT * FROM list_groups WHERE id = ? AND user_id = ?', [posInt(id), ctx.userId]);
  if (!g) throw fail('not_found');
  await store.run(gc, 'UPDATE list_groups SET name = ?, position = ? WHERE id = ?', [b.name !== undefined ? nameArg(b.name) : g.name, typeof b.position === 'number' ? b.position : g.position, g.id]);
  events.changed(gc, [ctx.userId], 'lists');
  return { ok: true };
}
async function removeGroup(gc, ctx, id) {
  const g = await store.one(gc, 'SELECT * FROM list_groups WHERE id = ? AND user_id = ?', [posInt(id), ctx.userId]);
  if (!g) throw fail('not_found');
  await store.run(gc, 'UPDATE list_members SET group_id = NULL WHERE user_id = ? AND group_id = ?', [ctx.userId, g.id]);
  await store.run(gc, 'DELETE FROM list_groups WHERE id = ?', [g.id]);
  events.changed(gc, [ctx.userId], 'lists');
  return { ok: true };
}

module.exports = { access, ids, ensureDefault, membersOf, memberIds, view, all, openCounts, create, update, remove, setMembers, createGroup, updateGroup, removeGroup };
