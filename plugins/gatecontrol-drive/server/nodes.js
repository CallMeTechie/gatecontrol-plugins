'use strict';

// The tree of an area: folders and files, their paths, moves, the trash and the change log.
//
// A file's media sits in its area's media area at the file's path ("Fotos/2026/Strand.jpg") — on a NAS in the
// readable form that is the very file on the NAS. So a rename or a move of a folder moves every file below it
// (gc.media.move: on the NAS a rename, no bytes travel); a file in the trash leaves its path (gc.media.move path
// null — on the NAS it goes below .gcdrive/files) and gets it back on a restore.
//
// Every change writes a row of `changes` (op create | update | move | delete | restore | purge); devices read
// them with GET changes?since=<seq> and get a live event 'changed' (gc.events) to fetch them at once.

const store = require('./store');
const areas = require('./areas');
const wipes = require('./wipes');
const { fail, nodeName, numbered, iso } = require('./util');

const CHILDREN_MAX = 1000;
const SEARCH_MAX = 100;

async function row(gc, id) {
  return store.one(gc, 'SELECT * FROM nodes WHERE id = ?', [id]);
}

/** "Fotos/2026" of node `n` (the root: ''). */
async function pathOf(gc, n) {
  if (!n || n.parent_id == null) return '';
  const rows = await store.all(gc, `WITH RECURSIVE up(id, parent_id, name, depth) AS (
      SELECT id, parent_id, name, 0 FROM nodes WHERE id = ?
      UNION ALL SELECT p.id, p.parent_id, p.name, up.depth + 1 FROM nodes p JOIN up ON p.id = up.parent_id)
    SELECT name FROM up WHERE parent_id IS NOT NULL ORDER BY depth DESC`, [n.id]);
  return rows.map((r) => r.name).join('/');
}

/** Every node below `id` (not `id` itself), the trashed ones included. */
async function below(gc, id) {
  return store.all(gc, `WITH RECURSIVE down(id) AS (
      SELECT id FROM nodes WHERE parent_id = ?
      UNION ALL SELECT n.id FROM nodes n JOIN down ON n.parent_id = down.id)
    SELECT nodes.* FROM nodes JOIN down USING (id)`, [id]);
}

/** Relative paths of `rows` (below `top`, whose path is `base`) → Map id → path. */
function pathsBelow(top, base, rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map();
  const walk = (r) => {
    if (out.has(r.id)) return out.get(r.id);
    const parent = r.parent_id === top ? base : walk(byId.get(r.parent_id));
    const p = parent ? `${parent}/${r.name}` : r.name;
    out.set(r.id, p);
    return p;
  };
  for (const r of rows) walk(r);
  return out;
}

function view(n, extra) {
  return {
    id: n.id, areaId: n.area_id, parentId: n.parent_id, name: n.name, isDir: n.is_dir === 1,
    size: n.size, mime: n.mime || null, sha256: n.sha256 || null, mediaId: n.media_id || null,
    mtime: n.mtime == null ? null : iso(n.mtime), rev: n.rev,
    createdAt: iso(n.created_at), createdBy: n.created_by, updatedAt: iso(n.updated_at), updatedBy: n.updated_by,
    deleted: n.deleted_at != null, ...(n.deleted_at != null ? { deletedAt: iso(n.deleted_at), deletedBy: n.deleted_by } : {}),
    ...(extra || {}),
  };
}

async function log(gc, areaId, nodeId, op, ctx) {
  const r = await store.run(gc, 'INSERT INTO changes (area_id, node_id, op, at, by, device) VALUES (?, ?, ?, ?, ?, ?)',
    [areaId, nodeId, op, ctx.now, ctx.viewer || null, ctx.deviceId || null]);
  (ctx.touched || (ctx.touched = new Set())).add(areaId);
  return r.lastInsertRowid;
}

/** A live node the viewer may read (`need`: least role) → { node, area, role }. */
async function reach(ctx, id, need = 'read') {
  const n = Number.isSafeInteger(id) ? await row(ctx.gc, id) : null;
  if (!n || n.deleted_at != null) throw fail('not_found');
  const v = await areas.roleIn(ctx, n.area_id, need).catch((e) => { throw e.code === 'forbidden' ? e : fail('not_found'); });
  return { node: n, area: v.area, role: v.role, via: v.via };
}

/** A folder the viewer may write into. */
async function folderFor(ctx, id) {
  const r = await reach(ctx, id, 'write');
  if (r.node.is_dir !== 1) throw fail('invalid', { field: 'parentId' });
  if (r.area.archived_at != null) throw fail('forbidden');
  return r;
}

async function taken(gc, areaId, parentId, name, exceptId = 0) {
  return store.one(gc, `SELECT * FROM nodes WHERE area_id = ? AND parent_id = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL AND id <> ?`,
    [areaId, parentId, name, exceptId]);
}

/** `name`, or "name (2)", "name (3)", … — the first that is free in the folder. */
async function freeName(gc, areaId, parentId, name, exceptId = 0) {
  if (!await taken(gc, areaId, parentId, name, exceptId)) return name;
  for (let i = 2; i < 10000; i++) {
    const c = numbered(name, i);
    if (!await taken(gc, areaId, parentId, c, exceptId)) return c;
  }
  throw fail('exists');
}

const join = (a, b) => (a ? `${a}/${b}` : b);

// ─── Reading ────────────────────────────────────

/** GET nodes/<id> → the node, its path and the folders above it (crumbs). */
async function get(ctx, id) {
  const { node, area, role } = await reach(ctx, id);
  const crumbs = await store.all(ctx.gc, `WITH RECURSIVE up(id, parent_id, name, depth) AS (
      SELECT id, parent_id, name, 0 FROM nodes WHERE id = ?
      UNION ALL SELECT p.id, p.parent_id, p.name, up.depth + 1 FROM nodes p JOIN up ON p.id = up.parent_id)
    SELECT id, name FROM up WHERE depth > 0 ORDER BY depth DESC`, [node.id]);
  return view(node, { path: await pathOf(ctx.gc, node), role, crumbs: crumbs.map((c) => ({ id: c.id, name: c.name })) });
}

const SORTS = { name: 'name COLLATE NOCASE', mtime: 'COALESCE(mtime, updated_at)', size: 'size', updated: 'updated_at' };

/** GET nodes/<id>/children?sort=name|mtime|size|updated&order=asc|desc&offset=&limit= → { items, total, next } (folders first). */
async function children(ctx, id, q) {
  const { node, area, role, via } = await reach(ctx, id);
  if (node.is_dir !== 1) throw fail('invalid');
  const sort = SORTS[q && q.sort] || SORTS.name;
  const dir = q && q.order === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(CHILDREN_MAX, Math.max(1, Number(q && q.limit) || 200));
  const offset = Math.max(0, Number(q && q.offset) || 0);
  const rows = await store.all(ctx.gc, `SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL
    ORDER BY is_dir DESC, ${sort} ${dir}, id LIMIT ? OFFSET ?`, [node.id, limit + 1, offset]);
  const total = (await store.one(ctx.gc, 'SELECT COUNT(*) AS n FROM nodes WHERE parent_id = ? AND deleted_at IS NULL', [node.id])).n;
  if (via === 'parent') await ctx.noteChildView(area);
  return { items: rows.slice(0, limit).map((r) => view(r)), total, next: rows.length > limit ? offset + limit : null, role };
}

/** GET nodes/by-path?area=<id>&path=<a/b> → the node. */
async function byPath(ctx, areaId, p) {
  const v = await areas.roleIn(ctx, String(areaId || ''), 'read');
  let cur = await row(ctx.gc, v.area.root_id);
  const segs = typeof p === 'string' ? p.split('/').filter(Boolean) : [];
  for (const s of segs) {
    cur = await taken(ctx.gc, v.area.id, cur.id, s);
    if (!cur) throw fail('not_found');
  }
  return get(ctx, cur.id);
}

/**
 * GET search?q=&area= → files and folders whose name contains q (≥ 2 characters), then files whose recognised text
 * does (a scan: `match: 'text'` with a `snippet` around the first hit), in the areas the viewer reads.
 */
async function search(ctx, q, areaId) {
  const term = typeof q === 'string' ? q.trim() : '';
  if (term.length < 2 || term.length > 100) throw fail('invalid', { field: 'q' });
  const ids = (await ctx.visible()).map((x) => x.area.id).filter((id) => !areaId || id === areaId);
  if (!ids.length) return { items: [] };
  const like = '%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const rows = await store.all(ctx.gc, `SELECT * FROM nodes WHERE area_id IN (${store.marks(ids.length)}) AND parent_id IS NOT NULL
    AND deleted_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY is_dir DESC, updated_at DESC LIMIT ?`, [...ids, like, SEARCH_MAX]);
  const items = [];
  for (const r of rows) items.push(view(r, { path: await pathOf(ctx.gc, r), match: 'name' }));
  if (rows.length < SEARCH_MAX) {
    const seen = new Set(rows.map((r) => r.id));
    const hits = await store.all(ctx.gc, `SELECT n.*, t.text AS doc_text FROM doc_text t JOIN nodes n ON n.id = t.node_id
      WHERE n.area_id IN (${store.marks(ids.length)}) AND n.deleted_at IS NULL AND t.text LIKE ? ESCAPE '\\'
      ORDER BY n.updated_at DESC LIMIT ?`, [...ids, like, SEARCH_MAX]);
    for (const r of hits) {
      if (seen.has(r.id) || items.length >= SEARCH_MAX) continue;
      const { doc_text: text, ...n } = r;
      items.push(view(n, { path: await pathOf(ctx.gc, n), match: 'text', snippet: snippet(text, term) }));
    }
  }
  return { items };
}

/** About 120 characters of [text] around the first [term] (case-insensitive), on one line. */
function snippet(text, term) {
  const flat = String(text).replace(/\s+/g, ' ');
  const at = flat.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return flat.slice(0, 120);
  const from = Math.max(0, at - 50);
  const to = Math.min(flat.length, at + term.length + 70);
  return (from > 0 ? '…' : '') + flat.slice(from, to).trim() + (to < flat.length ? '…' : '');
}

// ─── Changing ───────────────────────────────────

/** POST nodes { parentId, name } → a new folder (a free name: "Neuer Ordner (2)" with { rename: true }). */
async function mkdir(ctx, body) {
  const parentId = Number(body && body.parentId);
  let name = nodeName(body && body.name);
  return store.tx(ctx.gc, async () => {
    const { node: parent } = await folderFor(ctx, parentId);
    if (await taken(ctx.gc, parent.area_id, parent.id, name)) {
      if (!body.rename) throw fail('exists');
      name = await freeName(ctx.gc, parent.area_id, parent.id, name);
    }
    const r = await store.run(ctx.gc, `INSERT INTO nodes (area_id, parent_id, name, is_dir, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)`, [parent.area_id, parent.id, name, ctx.now, ctx.viewer, ctx.now, ctx.viewer]);
    await log(ctx.gc, parent.area_id, r.lastInsertRowid, 'create', ctx);
    return view(await row(ctx.gc, r.lastInsertRowid));
  });
}

/**
 * Give the files of `top` (and below, when a folder) their paths in `area` again after a rename or a move —
 * gc.media.move each; on a failure the ones already moved go back. `paths`: Map file id → new path.
 */
async function moveMedia(gc, files, mediaArea, oldMediaArea, oldPaths) {
  const done = [];
  try {
    for (const f of files) {
      await gc.media.move(f.media_id, { path: f.path, ...(mediaArea !== oldMediaArea ? { area: mediaArea } : {}) });
      done.push(f);
    }
  } catch (e) {
    for (const f of done.reverse()) {
      try { await gc.media.move(f.media_id, { path: oldPaths.get(f.id), ...(mediaArea !== oldMediaArea ? { area: oldMediaArea } : {}) }); } catch { /* best effort */ }
    }
    if (e && e.code === 'ERR_MEDIA_QUOTA') throw fail('quota');
    if (e && e.code === 'ERR_CONFLICT') throw fail('exists');
    throw e;
  }
}

/** PATCH nodes/<id> { name?, parentId? } — rename and / or move (also into another area the viewer writes to). */
async function update(ctx, id, body) {
  const b = body && typeof body === 'object' ? body : {};
  const wantName = b.name != null ? nodeName(b.name) : null;
  const wantParent = b.parentId != null ? Number(b.parentId) : null;
  let moved = null;
  const out = await store.tx(ctx.gc, async () => {
    const { node, area } = await reach(ctx, Number(id), 'write');
    if (node.parent_id == null) throw fail('invalid');
    if (area.archived_at != null) throw fail('forbidden');
    const parent = wantParent != null && wantParent !== node.parent_id ? (await folderFor(ctx, wantParent)) : { node: await row(ctx.gc, node.parent_id), area };
    const name = wantName || node.name;
    if (parent.node.id === node.id) throw fail('invalid');
    if (node.is_dir === 1 && parent.node.area_id === node.area_id) {
      const under = await below(ctx.gc, node.id);
      if (under.some((r) => r.id === parent.node.id)) throw fail('invalid', { field: 'parentId' });
    }
    if (parent.node.id === node.parent_id && name === node.name) return view(node);
    if (await taken(ctx.gc, parent.node.area_id, parent.node.id, name, node.id)) throw fail('exists');
    const toArea = parent.area;
    const base = join(await pathOf(ctx.gc, parent.node), name);
    const oldBase = await pathOf(ctx.gc, node);
    // the files to move: the node itself, or every live file below the folder
    let files = [];
    const oldPaths = new Map();
    if (node.is_dir === 1) {
      const rows = await below(ctx.gc, node.id);
      // links of this folder and the folders below point at old paths now (links.js endFor)
      moved = [node.id, ...rows.filter((r) => r.is_dir === 1).map((r) => r.id)];
      const now = pathsBelow(node.id, base, rows);
      const before = pathsBelow(node.id, oldBase, rows);
      files = rows.filter((r) => r.is_dir === 0 && r.deleted_at == null && r.media_id).map((r) => ({ id: r.id, media_id: r.media_id, path: now.get(r.id) }));
      for (const f of files) oldPaths.set(f.id, before.get(f.id));
      if (toArea.id !== area.id) {
        // files below that are in the trash move with the folder (they stay without a path)
        const trashed = rows.filter((r) => r.is_dir === 0 && r.deleted_at != null && r.media_id);
        for (const r of trashed) await ctx.gc.media.move(r.media_id, { area: toArea.media_area, path: null });
      }
    } else if (node.media_id) {
      files = [{ id: node.id, media_id: node.media_id, path: base }];
      oldPaths.set(node.id, oldBase);
    }
    await moveMedia(ctx.gc, files, toArea.media_area, area.media_area, oldPaths);
    await store.run(ctx.gc, 'UPDATE nodes SET parent_id = ?, name = ?, area_id = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      [parent.node.id, name, toArea.id, ctx.now, ctx.viewer, node.id]);
    if (toArea.id !== area.id) {
      // older versions stay in the media area they were made in (a version only moves back to a path); a restore
      // brings one over (files.js restoreVersion)
      await store.run(ctx.gc, `UPDATE nodes SET area_id = ? WHERE id IN (WITH RECURSIVE down(id) AS (
          SELECT id FROM nodes WHERE parent_id = ? UNION ALL SELECT n.id FROM nodes n JOIN down ON n.parent_id = down.id) SELECT id FROM down)`,
      [toArea.id, node.id]);
      await log(ctx.gc, area.id, node.id, 'delete', ctx);
      await log(ctx.gc, toArea.id, node.id, 'create', ctx);
    } else {
      await log(ctx.gc, area.id, node.id, 'move', ctx);
    }
    return view(await row(ctx.gc, node.id));
  });
  if (moved) unlinkLater(ctx, 'folders', moved);
  return out;
}

/** Links to end once the change is committed (index.js after → links.endFor). */
function unlinkLater(ctx, kind, ids) {
  const u = ctx.unlink || (ctx.unlink = { folders: [], all: [] });
  u[kind].push(...ids);
}

/**
 * DELETE nodes/<id> → into the trash (the node and everything below it). `everywhere` (?everywhere=1, since 1.2.0):
 * also a wipe — every device of the viewer removes its local copies of the files (wipes.js) → + wipe { id, devices, files }.
 */
async function trash(ctx, id, everywhere = false) {
  let gone = null;
  const out = await store.tx(ctx.gc, async () => {
    const { node, area } = await reach(ctx, Number(id), 'write');
    if (node.parent_id == null) throw fail('invalid');
    if (area.archived_at != null) throw fail('forbidden');
    const rows = node.is_dir === 1 ? (await below(ctx.gc, node.id)).filter((r) => r.deleted_at == null) : [];
    const all = [node, ...rows];
    // the files leave their paths (free for new files; on a NAS below .gcdrive/files)
    const moved = [];
    try {
      for (const r of all) if (r.is_dir === 0 && r.media_id) { await ctx.gc.media.move(r.media_id, { path: null }); moved.push(r); }
    } catch (e) {
      const base = await pathOf(ctx.gc, node);
      const paths = node.is_dir === 1 ? pathsBelow(node.id, base, rows) : new Map([[node.id, base]]);
      for (const r of moved) { try { await ctx.gc.media.move(r.media_id, { path: paths.get(r.id) }); } catch { /* best effort */ } }
      throw e;
    }
    await store.run(ctx.gc, `UPDATE nodes SET deleted_at = ?, deleted_by = ?, trash_id = ? WHERE id IN (${store.marks(all.length)})`,
      [ctx.now, ctx.viewer, node.id, ...all.map((r) => r.id)]);
    await log(ctx.gc, area.id, node.id, 'delete', ctx);
    gone = all.map((r) => r.id);
    const wipe = everywhere ? await wipes.create(ctx, node, all.filter((r) => r.is_dir === 0)) : null;
    return { id: node.id, trashed: all.length, ...(wipe ? { wipe } : {}) };
  });
  unlinkLater(ctx, 'all', gone);
  return out;
}

/** GET trash?area= → what was deleted in the areas the viewer writes to (the deleted node, not each one below). */
async function trashList(ctx, areaId) {
  const ids = (await ctx.visible()).filter((x) => areas.can(x.role, 'write') && (!areaId || x.area.id === areaId)).map((x) => x.area.id);
  if (!ids.length) return { items: [] };
  const rows = await store.all(ctx.gc, `SELECT * FROM nodes WHERE area_id IN (${store.marks(ids.length)}) AND trash_id = id
    ORDER BY deleted_at DESC LIMIT 1000`, ids);
  const items = [];
  for (const r of rows) {
    const parent = await row(ctx.gc, r.parent_id);
    const size = r.is_dir === 1 ? (await store.one(ctx.gc, 'SELECT COALESCE(SUM(size), 0) AS s, COUNT(*) AS n FROM nodes WHERE trash_id = ? AND is_dir = 0', [r.id])) : null;
    items.push(view(r, { from: parent ? await pathOf(ctx.gc, parent) : '', ...(size ? { size: size.s, files: size.n } : {}) }));
  }
  return { items };
}

/** A trashed node the viewer may write to (`trash_id = id`). */
async function trashed(ctx, id) {
  const n = Number.isSafeInteger(id) ? await row(ctx.gc, id) : null;
  if (!n || n.trash_id !== n.id) throw fail('not_found');
  const v = await areas.roleIn(ctx, n.area_id, 'write');
  return { node: n, area: v.area };
}

/** POST trash/<id>/restore → back to its folder (or the area's top when that is gone), a free name. */
async function restore(ctx, id) {
  return store.tx(ctx.gc, async () => {
    const { node, area } = await trashed(ctx, Number(id));
    let parent = await row(ctx.gc, node.parent_id);
    if (!parent || parent.deleted_at != null) parent = await row(ctx.gc, area.root_id);
    const name = await freeName(ctx.gc, area.id, parent.id, node.name);
    const batch = await store.all(ctx.gc, 'SELECT * FROM nodes WHERE trash_id = ?', [node.id]);
    const base = join(await pathOf(ctx.gc, parent), name);
    const rows = batch.filter((r) => r.id !== node.id);
    const paths = node.is_dir === 1 ? pathsBelow(node.id, base, rows) : new Map();
    paths.set(node.id, base);
    const files = batch.filter((r) => r.is_dir === 0 && r.media_id).map((r) => ({ id: r.id, media_id: r.media_id, path: paths.get(r.id) }));
    await moveMedia(ctx.gc, files, area.media_area, area.media_area, new Map(files.map((f) => [f.id, null])));
    // the top node first, under its free name (names are unique among the live nodes of a folder)
    await store.run(ctx.gc, 'UPDATE nodes SET parent_id = ?, name = ?, updated_at = ?, updated_by = ?, deleted_at = NULL, deleted_by = NULL, trash_id = NULL WHERE id = ?',
      [parent.id, name, ctx.now, ctx.viewer, node.id]);
    await store.run(ctx.gc, 'UPDATE nodes SET deleted_at = NULL, deleted_by = NULL, trash_id = NULL WHERE trash_id = ?', [node.id]);
    await log(ctx.gc, area.id, node.id, 'restore', ctx);
    // "deleted on all devices" ends: devices that have not removed their copy yet keep it
    await wipes.cancel(ctx.gc, node.id);
    return view(await row(ctx.gc, node.id));
  });
}

/** Remove trashed batch `trashId` for good: the media of its files and their versions, the rows. → files removed */
async function purgeBatch(gc, trashId, ctx) {
  const batch = await store.all(gc, 'SELECT * FROM nodes WHERE trash_id = ?', [trashId]);
  if (!batch.length) return 0;
  const ids = batch.map((r) => r.id);
  const versions = await store.all(gc, `SELECT media_id FROM versions WHERE node_id IN (${store.marks(ids.length)})`, ids);
  for (const m of [...batch.filter((r) => r.media_id).map((r) => r.media_id), ...versions.map((v) => v.media_id)]) {
    try { await gc.media.delete(m); } catch (e) { gc.log.warn('purge: media delete failed', (e && e.code) || 'error'); }
  }
  await store.run(gc, `DELETE FROM versions WHERE node_id IN (${store.marks(ids.length)})`, ids);
  await store.run(gc, `DELETE FROM doc_text WHERE node_id IN (${store.marks(ids.length)})`, ids);
  await store.run(gc, `DELETE FROM nodes WHERE id IN (${store.marks(ids.length)})`, ids);
  const top = batch.find((r) => r.id === trashId) || batch[0];
  await log(gc, top.area_id, trashId, 'purge', ctx);
  return batch.filter((r) => r.is_dir === 0).length;
}

/** DELETE trash/<id> → gone for good. */
async function purge(ctx, id) {
  return store.tx(ctx.gc, async () => {
    const { node } = await trashed(ctx, Number(id));
    return { id: node.id, files: await purgeBatch(ctx.gc, node.id, ctx) };
  });
}

module.exports = { row, pathOf, below, pathsBelow, view, log, reach, folderFor, taken, freeName, join, get, children, byPath, search, mkdir, update, trash, trashList, restore, purge, purgeBatch, moveMedia };
