'use strict';

// The overview of the storage (since 1.7.0):
//
//   GET storage[?all=1]   → { total: { bytes, files, versionsBytes, trashBytes }, limit: { maxBytes } | null,
//                             areas: [{ id, label, kind, bytes, files, versionsBytes, trashBytes, quota, canPrune }],
//                             people: [{ user, name, bytes, files }], largest: [file], duplicates: [group], all }
//     without all: the areas the person reads; all=1 (administrators): every area, and `people` (who uploaded how much,
//     by the live files' creator) — else [] .
//     largest     the 20 largest files: { id, name, size, areaId, parentId, path, updatedAt, canDelete }
//     duplicates  the 20 groups wasting the most space — the same sha256 and size, empty files not counted:
//                 { sha256, size, count, wasted, items: [{ id, name, areaId, parentId, path, updatedAt, canDelete }] }
//                 (≤ 50 items a group, the oldest first); canDelete: the viewer may put it into the trash
//   POST storage/versions/prune { areaId, keep }  → { removed, freedBytes, more }
//     older versions of every file of the area beyond the newest `keep` (0 … 500) go — administrators and managers of
//     the area. Versions the ransomware protection or a time travel still needs stay. ≤ 2000 a call (more: call again).
// Cleaning up is the ordinary DELETE nodes/<id> (into the trash).

const store = require('./store');
const nodes = require('./nodes');
const areas = require('./areas');
const { fail, iso } = require('./util');

const TOP = 20;
const GROUP_ITEMS = 50;
const PRUNE_MAX = 2000;

const isAdmin = (ctx) => !!(ctx.user && ctx.user.role === 'admin');

/** `area_id IN (…)` of the areas `ids`, or every area (`all`: no list — the host takes ≤ 100 parameters). */
const inAreas = (ids, all, col = 'area_id') => (all ? { sql: '1 = 1', args: [] } : { sql: `${col} IN (${store.marks(ids.length)})`, args: ids });

/** Sums of the areas `ids` (every area: `all`) → Map area id → { bytes, files, versionsBytes, trashBytes }. */
async function sums(gc, ids, all = false) {
  const out = new Map(ids.map((id) => [id, { bytes: 0, files: 0, versionsBytes: 0, trashBytes: 0 }]));
  if (!ids.length) return out;
  const f = inAreas(ids, all);
  for (const r of await store.all(gc, `SELECT area_id, SUM(CASE WHEN deleted_at IS NULL THEN size ELSE 0 END) AS b, SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS f,
      SUM(CASE WHEN deleted_at IS NOT NULL THEN size ELSE 0 END) AS t FROM nodes WHERE is_dir = 0 AND ${f.sql} GROUP BY area_id`, f.args)) {
    if (out.has(r.area_id)) Object.assign(out.get(r.area_id), { bytes: r.b || 0, files: r.f || 0, trashBytes: r.t || 0 });
  }
  const v = inAreas(ids, all, 'n.area_id');
  for (const r of await store.all(gc, `SELECT n.area_id, SUM(v.size) AS s FROM versions v JOIN nodes n ON n.id = v.node_id WHERE ${v.sql} GROUP BY n.area_id`, v.args)) {
    if (out.has(r.area_id)) out.get(r.area_id).versionsBytes = r.s || 0;
  }
  return out;
}

/** The overview for the viewer (all: an administrator's view of every area). */
async function overview(ctx, q) {
  const all = ['1', 'true', 'yes'].includes(String((q && q.all) || '').toLowerCase()) && isAdmin(ctx);
  const vis = ctx.seat ? await ctx.visible() : [];
  const byId = new Map(vis.map((v) => [v.area.id, v]));
  const rows = all ? await store.all(ctx.gc, 'SELECT * FROM areas ORDER BY kind, label') : vis.map((v) => v.area);
  const ids = rows.map((a) => a.id);
  const s = await sums(ctx.gc, ids, all);
  const writes = (areaId) => { const v = byId.get(areaId); return !!(v && areas.can(v.role, 'write') && v.area.archived_at == null); };
  const total = { bytes: 0, files: 0, versionsBytes: 0, trashBytes: 0 };
  const out = {
    total, limit: null, all,
    areas: rows.map((a) => {
      const x = s.get(a.id);
      for (const k of Object.keys(total)) total[k] += x[k];
      const v = byId.get(a.id);
      return {
        id: a.id, label: v ? ctx.areaLabel(a) : a.label, kind: a.kind, ...x, quota: a.quota_bytes || null,
        canPrune: isAdmin(ctx) || !!(v && v.role === 'manage'),
      };
    }),
    people: [], largest: [], duplicates: [],
  };
  try { const u = await ctx.gc.media.usage(); out.limit = u && u.maxBytes != null ? { maxBytes: u.maxBytes } : null; } catch { out.limit = null; }
  if (!ids.length) return out;
  const f = inAreas(ids, all);
  const live = `is_dir = 0 AND deleted_at IS NULL AND ${f.sql}`;
  const args = f.args;
  if (all) {
    const rowsP = await store.all(ctx.gc, `SELECT created_by AS u, SUM(size) AS b, COUNT(*) AS f FROM nodes WHERE ${live} AND created_by IS NOT NULL GROUP BY created_by ORDER BY b DESC`, args);
    out.people = rowsP.map((r) => ({ user: r.u, name: (ctx.users.get(r.u) || {}).name || null, bytes: r.b || 0, files: r.f }));
  }
  const itemOf = async (n) => ({ id: n.id, name: n.name, size: n.size, areaId: n.area_id, parentId: n.parent_id, path: await nodes.pathOf(ctx.gc, n), updatedAt: iso(n.updated_at), canDelete: writes(n.area_id) });
  for (const n of await store.all(ctx.gc, `SELECT * FROM nodes WHERE ${live} ORDER BY size DESC, id LIMIT ?`, [...args, TOP])) out.largest.push(await itemOf(n));
  const groups = await store.all(ctx.gc, `SELECT sha256, size, COUNT(*) AS c FROM nodes WHERE ${live} AND size > 0 AND sha256 IS NOT NULL
    GROUP BY sha256, size HAVING c > 1 ORDER BY size * (c - 1) DESC, sha256 LIMIT ?`, [...args, TOP]);
  for (const g of groups) {
    const list = await store.all(ctx.gc, `SELECT * FROM nodes WHERE ${live} AND sha256 = ? AND size = ? ORDER BY created_at, id LIMIT ?`, [...args, g.sha256, g.size, GROUP_ITEMS]);
    const items = [];
    for (const n of list) items.push(await itemOf(n));
    out.duplicates.push({ sha256: g.sha256, size: g.size, count: g.c, wasted: g.size * (g.c - 1), items });
  }
  return out;
}

/** POST storage/versions/prune { areaId, keep } */
async function prune(ctx, body) {
  const b = body && typeof body === 'object' ? body : {};
  const keep = b.keep;
  if (!Number.isSafeInteger(keep) || keep < 0 || keep > 500) throw fail('invalid', { field: 'keep' });
  const a = typeof b.areaId === 'string' ? await areas.row(ctx.gc, b.areaId) : null;
  if (!a) throw fail('not_found', { field: 'areaId' });
  if (!isAdmin(ctx)) {
    const v = ctx.seat ? (await ctx.visible()).find((x) => x.area.id === a.id) : null;
    if (!v) throw fail('not_found', { field: 'areaId' });
    if (v.role !== 'manage') throw fail('forbidden');
  }
  const rows = await store.all(ctx.gc, `SELECT id, media_id, size FROM (
      SELECT v.*, ROW_NUMBER() OVER (PARTITION BY v.node_id ORDER BY v.at DESC, v.id DESC) AS rn FROM versions v JOIN nodes n ON n.id = v.node_id
      WHERE n.area_id = ? AND (v.hold_until IS NULL OR v.hold_until < ?)
        AND v.id NOT IN (SELECT l.version_id FROM guard_log l JOIN guard_incidents i ON i.id = l.incident_id WHERE l.version_id IS NOT NULL AND i.state <> 'undone'))
    WHERE rn > ? ORDER BY id LIMIT ?`, [a.id, ctx.now, keep, PRUNE_MAX + 1]);
  const drop = rows.slice(0, PRUNE_MAX);
  let freed = 0;
  for (const v of drop) {
    if (v.media_id) { try { await ctx.gc.media.delete(v.media_id); } catch (e) { ctx.gc.log.warn('version delete failed', (e && e.code) || 'error'); } }
    await store.run(ctx.gc, 'DELETE FROM versions WHERE id = ?', [v.id]);
    freed += v.size || 0;
  }
  return { removed: drop.length, freedBytes: freed, more: rows.length > PRUNE_MAX };
}

/** For the admin overview: the sums of every area and what duplicates waste. */
async function summary(gc) {
  const rows = await store.all(gc, 'SELECT id FROM areas');
  const s = await sums(gc, rows.map((r) => r.id), true);
  const total = { bytes: 0, files: 0, versionsBytes: 0, trashBytes: 0 };
  for (const x of s.values()) for (const k of Object.keys(total)) total[k] += x[k];
  const d = await store.one(gc, `SELECT COUNT(*) AS g, COALESCE(SUM(w), 0) AS w FROM (SELECT size * (COUNT(*) - 1) AS w FROM nodes
    WHERE is_dir = 0 AND deleted_at IS NULL AND size > 0 AND sha256 IS NOT NULL GROUP BY sha256, size HAVING COUNT(*) > 1)`);
  return { ...total, duplicates: { groups: d ? d.g : 0, wastedBytes: d ? d.w : 0 } };
}

module.exports = { overview, prune, summary, sums };
