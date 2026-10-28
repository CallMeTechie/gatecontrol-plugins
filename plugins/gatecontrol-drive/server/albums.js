'use strict';

// Albums (since 1.7.0): an album belongs to an area (default: the person's own files) and points at pictures and
// videos — it copies nothing. Whoever reads the area sees the album; whoever writes in it may change it. An item the
// viewer cannot read (another area) or that is in the trash is left out of what they see (and of `count`).
//
//   GET    albums                        → { albums: [album] }
//   POST   albums { name, areaId? }      → { album }
//   PATCH  albums/<id> { name?, coverId?, frame? }  → { album }
//   DELETE albums/<id>                   → { ok } — the photos stay
//   GET    albums/<id>?before=&limit=    → { album, items, next } (like GET photos)
//   POST   albums/<id>/items { ids }     → { album } — ≤ 500, pictures and videos the person reads
//   DELETE albums/<id>/items { ids }     → { album } (or ?ids=1,2,3)
// An album: { id, name, areaId, count, coverId, frame, updatedAt, canEdit, canFrame, coverUrl, createdBy }. coverId: the
// cover chosen (one of its items), else the newest item; coverUrl: its small preview for the viewer.
//
// The photo frame (frame.js): `frame` may be switched (on and off) by whoever may change the album — not by a child
// of a family, never in a child's folder, and in a family's area only by a parent of that family or an administrator.

const store = require('./store');
const nodes = require('./nodes');
const areas = require('./areas');
const photos = require('./photos');
const previews = require('./previews');
const { fail, iso, line, posInt } = require('./util');

const IDS_MAX = 500;
const NAME_MAX = 100;

function nameArg(v) {
  const s = line(v);
  if (!s || s.length > NAME_MAX) throw fail('invalid', { field: 'name' });
  return s;
}

/** The ids of a body { ids } (or a query ids=1,2,3) → [positive ints], ≤ 500. */
function idsArg(body, q) {
  let list = body && Array.isArray(body.ids) ? body.ids : null;
  if (!list && q && typeof q.ids === 'string') list = q.ids.split(',').filter(Boolean);
  if (!Array.isArray(list) || !list.length || list.length > IDS_MAX) throw fail('invalid', { field: 'ids' });
  const out = list.map((x) => posInt(x));
  if (out.some((x) => !x)) throw fail('invalid', { field: 'ids' });
  return [...new Set(out)];
}

/** Is the person a child of a family? */
async function isChild(ctx) {
  return (await ctx.families()).some((f) => f.children.has(ctx.viewer));
}

/** May the viewer change album `a` (write in its area, not archived)? → the visible area entry, else null. */
async function editable(ctx, a) {
  const v = (await ctx.visible()).find((x) => x.area.id === a.area_id);
  return v && areas.can(v.role, 'write') && v.area.archived_at == null ? v : null;
}

/** May the viewer switch the photo frame of album `a`? */
async function mayFrame(ctx, a) {
  const v = await editable(ctx, a);
  if (!v || v.area.kind === 'child' || await isChild(ctx)) return false;
  if (v.area.kind !== 'family') return true;
  if (ctx.user && ctx.user.role === 'admin') return true;
  const f = (await ctx.families()).find((x) => x.id === v.area.group_id);
  return !!(f && f.parents.has(ctx.viewer));
}

/** An album the viewer reads (its area is visible) → its row, else not_found. */
async function readable(ctx, id) {
  const n = posInt(id);
  const a = n ? await store.one(ctx.gc, 'SELECT * FROM albums WHERE id = ?', [n]) : null;
  if (!a || !(await ctx.visible()).some((x) => x.area.id === a.area_id)) throw fail('not_found');
  return a;
}

/** The items of album `a` the viewer sees: `where` for photos.page and its args. */
async function itemsWhere(ctx, a) {
  const ids = (await ctx.visible()).map((x) => x.area.id);
  return { where: `id IN (SELECT node_id FROM album_items WHERE album_id = ?) AND area_id IN (${store.marks(ids.length)}) AND ${photos.MEDIA}`, args: [a.id, ...ids] };
}

/** Albums `rows` as the viewer sees them. */
async function views(ctx, rows) {
  if (!rows.length) return [];
  const out = [];
  const covers = [];
  for (const a of rows) {
    const w = await itemsWhere(ctx, a);
    const count = (await store.one(ctx.gc, `SELECT COUNT(*) AS n FROM nodes WHERE ${w.where}`, w.args)).n;
    let cover = null;
    if (a.cover_id != null) cover = await store.one(ctx.gc, `SELECT * FROM nodes WHERE id = ? AND ${w.where}`, [a.cover_id, ...w.args]);
    if (!cover) cover = await store.one(ctx.gc, `SELECT * FROM nodes WHERE ${w.where} ORDER BY ${nodes.TAKEN} DESC, id DESC LIMIT 1`, w.args);
    const canEdit = !!(await editable(ctx, a));
    out.push({
      id: a.id, name: a.name, areaId: a.area_id, count, coverId: cover ? cover.id : null, frame: a.frame === 1, updatedAt: iso(a.updated_at),
      canEdit, canFrame: canEdit && await mayFrame(ctx, a), coverUrl: null, createdBy: a.created_by == null ? null : a.created_by,
    });
    covers.push(cover ? cover.media_id : null);
  }
  const { map } = await previews.urls(ctx, covers.filter(Boolean));
  out.forEach((v, i) => { const p = covers[i] ? map.get(covers[i]) : null; v.coverUrl = p ? p.url : null; });
  return out;
}

async function one(ctx, id) {
  const a = await store.one(ctx.gc, 'SELECT * FROM albums WHERE id = ?', [id]);
  return (await views(ctx, [a]))[0];
}

/** GET albums → the albums of the areas the viewer reads (newest change first). */
async function list(ctx) {
  const ids = (await ctx.visible()).map((x) => x.area.id);
  if (!ids.length) return { albums: [] };
  const rows = await store.all(ctx.gc, `SELECT * FROM albums WHERE area_id IN (${store.marks(ids.length)}) ORDER BY updated_at DESC, id DESC`, ids);
  return { albums: await views(ctx, rows) };
}

/** POST albums { name, areaId? } */
async function create(ctx, body) {
  const b = body && typeof body === 'object' ? body : {};
  const name = nameArg(b.name);
  const areaId = b.areaId == null || b.areaId === '' ? areas.idOf.mine(ctx.viewer) : String(b.areaId);
  const v = (await ctx.visible()).find((x) => x.area.id === areaId);
  if (!v) throw fail('not_found', { field: 'areaId' });
  if (!areas.can(v.role, 'write') || v.area.archived_at != null) throw fail('forbidden');
  const r = await store.run(ctx.gc, 'INSERT INTO albums (area_id, name, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)',
    [areaId, name, ctx.now, ctx.viewer, ctx.now, ctx.viewer]);
  return { album: await one(ctx, Number(r.lastInsertRowid)) };
}

/** An album the viewer may change → its row (forbidden when they only read it). */
async function changeable(ctx, id) {
  const a = await readable(ctx, id);
  if (!(await editable(ctx, a))) throw fail('forbidden');
  return a;
}

/** PATCH albums/<id> { name?, coverId?, frame? } */
async function update(ctx, id, body) {
  const b = body && typeof body === 'object' ? body : {};
  const a = await changeable(ctx, id);
  const set = {};
  if (b.name !== undefined) set.name = nameArg(b.name);
  if (b.coverId !== undefined) {
    if (b.coverId === null) set.cover_id = null;
    else {
      const c = posInt(b.coverId);
      const w = await itemsWhere(ctx, a);
      if (!c || !await store.one(ctx.gc, `SELECT id FROM nodes WHERE id = ? AND ${w.where}`, [c, ...w.args])) throw fail('invalid', { field: 'coverId' });
      set.cover_id = c;
    }
  }
  if (b.frame !== undefined) {
    if (typeof b.frame !== 'boolean') throw fail('invalid', { field: 'frame' });
    if (b.frame !== (a.frame === 1)) {
      if (!await mayFrame(ctx, a)) throw fail('forbidden', { field: 'frame' });
      set.frame = b.frame ? 1 : 0;
      set.frame_by = b.frame ? ctx.viewer : null;
    }
  }
  const keys = Object.keys(set);
  if (keys.length) {
    await store.run(ctx.gc, `UPDATE albums SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ?, updated_by = ? WHERE id = ?`,
      [...keys.map((k) => set[k]), ctx.now, ctx.viewer, a.id]);
  }
  return { album: await one(ctx, a.id) };
}

/** DELETE albums/<id> → the album goes, its photos stay. */
async function remove(ctx, id) {
  const a = await changeable(ctx, id);
  await store.tx(ctx.gc, async () => {
    await store.run(ctx.gc, 'DELETE FROM album_items WHERE album_id = ?', [a.id]);
    await store.run(ctx.gc, 'DELETE FROM albums WHERE id = ?', [a.id]);
  });
  return { id: a.id };
}

/** GET albums/<id>?before=&limit= → { album, items, next } */
async function get(ctx, id, q) {
  const a = await readable(ctx, id);
  const limit = photos.limitArg(q && q.limit);
  const before = photos.beforeArg(q && q.before);
  const w = await itemsWhere(ctx, a);
  const r = await photos.page(ctx.gc, w.where, w.args, before, limit);
  await photos.noteViews(ctx, r.rows);
  return { album: await one(ctx, a.id), items: await photos.itemsOf(ctx, r.rows), next: r.next };
}

/** POST albums/<id>/items { ids } — pictures and videos the viewer reads, else 400 invalid { field: 'ids', ids }. */
async function addItems(ctx, id, body) {
  const a = await changeable(ctx, id);
  const ids = idsArg(body, null);
  const vis = new Set((await ctx.visible()).map((x) => x.area.id));
  const rows = [];
  for (const part of store.chunks(ids)) rows.push(...await store.all(ctx.gc, `SELECT * FROM nodes WHERE id IN (${store.marks(part.length)})`, part));
  const ok = new Set(rows.filter((n) => photos.isMedia(n) && vis.has(n.area_id)).map((n) => n.id));
  const bad = ids.filter((x) => !ok.has(x));
  if (bad.length) throw fail('invalid', { field: 'ids', ids: bad.slice(0, 50) });
  await store.tx(ctx.gc, async () => {
    for (const n of ids) await store.run(ctx.gc, 'INSERT OR IGNORE INTO album_items (album_id, node_id, added_at, added_by) VALUES (?, ?, ?, ?)', [a.id, n, ctx.now, ctx.viewer]);
    await store.run(ctx.gc, 'UPDATE albums SET updated_at = ?, updated_by = ? WHERE id = ?', [ctx.now, ctx.viewer, a.id]);
  });
  return { album: await one(ctx, a.id) };
}

/** DELETE albums/<id>/items { ids } — out of the album (the photos stay). */
async function removeItems(ctx, id, body, q) {
  const a = await changeable(ctx, id);
  const ids = idsArg(body, q);
  await store.tx(ctx.gc, async () => {
    for (const part of store.chunks(ids)) await store.run(ctx.gc, `DELETE FROM album_items WHERE album_id = ? AND node_id IN (${store.marks(part.length)})`, [a.id, ...part]);
    if (a.cover_id != null && ids.includes(a.cover_id)) await store.run(ctx.gc, 'UPDATE albums SET cover_id = NULL WHERE id = ?', [a.id]);
    await store.run(ctx.gc, 'UPDATE albums SET updated_at = ?, updated_by = ? WHERE id = ?', [ctx.now, ctx.viewer, a.id]);
  });
  return { album: await one(ctx, a.id) };
}

module.exports = { list, create, update, remove, get, addItems, removeItems, mayFrame, isChild, IDS_MAX };
