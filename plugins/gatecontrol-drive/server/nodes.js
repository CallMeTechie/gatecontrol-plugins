'use strict';

// The tree of an area: folders and files, their paths, moves, the trash and the change log.
//
// A file's media sits in its area's media area at the file's path ("Fotos/2026/Strand.jpg") — on a NAS in the
// readable form that is the very file on the NAS. So a rename or a move of a folder moves every file below it
// (gc.media.move: on the NAS a rename, no bytes travel); a file in the trash leaves its path (gc.media.move path
// null — on the NAS it goes below .gcdrive/files) and gets it back on a restore.
//
// Every change writes a row of `changes` (op create | update | move | delete | restore | purge, since 1.5.0 also
// mark | unmark — marks.js); devices read them with GET changes?since=<seq> and get a live event 'changed'
// (gc.events) to fetch them at once.
//
// A mark (since 1.5.0, marks.js): "deleted on the device, goes into the trash on …" (delete_at). New content ends it —
// a new version of the file, a restored version, a rename or a move, and anything new in a marked folder (unmarkUp).
//
// Renames, moves and deletes of an app request are rows of the ransomware protection's journal (guard.js, since 1.6.0).
//
// The history (since 1.7.0, table node_log — the time travel, timetravel.js): before each rename or move the name,
// folder and area the node had (op 'move'), before each restore from the trash where each node of the batch was and
// since when it was in the trash (op 'restore'). A node's `takenAt` (since 1.7.0): when the picture was taken
// (uploads/commit { takenAt }), else its mtime, else when it came.

const store = require('./store');
const areas = require('./areas');
const wipes = require('./wipes');
const guard = require('./guard');
const { fail, nodeName, numbered, iso } = require('./util');

// vault.js needs this module; it is loaded when first used (vault folders, since 1.9.0)
const vaults = () => require('./vault');
// the work folder and the review marks (since 1.13.0) — the same
const work = () => require('./work');

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

/** ms of a file's takenAt: taken_at, else mtime, else created_at (TAKEN in SQL). */
const takenOf = (n) => (n.taken_at != null ? n.taken_at : n.mtime != null ? n.mtime : n.created_at);
const TAKEN = 'COALESCE(taken_at, mtime, created_at)';

function view(n, extra) {
  return {
    id: n.id, areaId: n.area_id, parentId: n.parent_id, name: n.name, isDir: n.is_dir === 1,
    size: n.size, mime: n.mime || null, sha256: n.sha256 || null, mediaId: n.media_id || null,
    mtime: n.mtime == null ? null : iso(n.mtime), rev: n.rev,
    // when the picture was taken (since 1.7.0): uploads/commit { takenAt }, else mtime, else when it came; folders null
    takenAt: n.is_dir === 1 ? null : iso(takenOf(n)),
    createdAt: iso(n.created_at), createdBy: n.created_by, updatedAt: iso(n.updated_at), updatedBy: n.updated_by,
    deleted: n.deleted_at != null, ...(n.deleted_at != null ? { deletedAt: iso(n.deleted_at), deletedBy: n.deleted_by } : {}),
    // the mark (since 1.5.0): only while there is one
    ...(n.delete_at != null && n.deleted_at == null ? { deleteAt: iso(n.delete_at), deletedOnDevice: n.delete_device_name || null, deleteMarkedBy: n.delete_by == null ? null : n.delete_by } : {}),
    // a node of a vault (since 1.9.0, vault.js): `name` is opaque, the device decrypts nameCipher; files carry their
    // content's key version (the content's header says it too)
    ...(n.vault_id ? { encrypted: true, vaultId: n.vault_id, nameCipher: n.name_cipher || null, keyVersion: n.key_version == null ? null : n.key_version } : {}),
    // the review mark of a photo (since 1.13.0, work.js): only while there is one
    ...(n.review_at != null && n.is_dir === 0 ? { review: { hint: n.review_hint == null ? null : n.review_hint } } : {}),
    ...(extra || {}),
  };
}

async function log(gc, areaId, nodeId, op, ctx) {
  const r = await store.run(gc, 'INSERT INTO changes (area_id, node_id, op, at, by, device) VALUES (?, ?, ?, ?, ?, ?)',
    [areaId, nodeId, op, ctx.now, ctx.viewer || null, ctx.deviceId || null]);
  (ctx.touched || (ctx.touched = new Set())).add(areaId);
  return r.lastInsertRowid;
}

const UNMARKED = 'delete_at = NULL, delete_by = NULL, delete_device = NULL, delete_device_name = NULL';

/**
 * The marks of node `id` and of the folders above it end (it got new content, or something new is in the folder).
 * Each one cleared gets 'unmark' in the change log — except `quiet` (a node whose change is logged anyway). → count
 */
async function unmarkUp(gc, id, ctx, quiet = null) {
  const rows = await store.all(gc, `WITH RECURSIVE up(id, parent_id) AS (
      SELECT id, parent_id FROM nodes WHERE id = ?
      UNION ALL SELECT p.id, p.parent_id FROM nodes p JOIN up ON p.id = up.parent_id)
    SELECT n.id, n.area_id FROM nodes n JOIN up ON n.id = up.id WHERE n.delete_at IS NOT NULL`, [id]);
  if (!rows.length) return 0;
  await store.run(gc, `UPDATE nodes SET ${UNMARKED} WHERE id IN (${store.marks(rows.length)})`, rows.map((r) => r.id));
  for (const r of rows) if (r.id !== quiet) await log(gc, r.area_id, r.id, 'unmark', ctx);
  return rows.length;
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

/** Inside a transaction: a new folder `name` in `parentId` (the name must be free) → its row. */
async function insertFolder(ctx, areaId, parentId, name) {
  const r = await store.run(ctx.gc, `INSERT INTO nodes (area_id, parent_id, name, is_dir, created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?)`, [areaId, parentId, name, ctx.now, ctx.viewer, ctx.now, ctx.viewer]);
  await log(ctx.gc, areaId, r.lastInsertRowid, 'create', ctx);
  return row(ctx.gc, r.lastInsertRowid);
}

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

/** A query switch: 1, true, yes. */
const on = (v) => ['1', 'true', 'yes'].includes(String(v == null ? '' : v).toLowerCase());

/**
 * GET nodes/<id>/children?sort=name|mtime|size|updated&order=asc|desc&offset=&limit= → { items, total, next } (folders
 * first). Since 1.11.0 (feature vaultsApart) without the vault folders of a folder outside a vault (they are in the menu
 * only) — `vaults=1` lists them as before; inside a vault everything. `dirs=1`: only the folders, by name, each with
 * `hasDirs` (live folders below it, vault folders not counted) — the folder tree of the menu.
 */
async function children(ctx, id, q) {
  const { node, area, role, via } = await reach(ctx, id);
  if (node.is_dir !== 1) throw fail('invalid');
  const dirs = on(q && q.dirs);
  const sort = dirs ? SORTS.name : SORTS[q && q.sort] || SORTS.name;
  const dir = q && q.order === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(CHILDREN_MAX, Math.max(1, Number(q && q.limit) || 200));
  const offset = Math.max(0, Number(q && q.offset) || 0);
  // the vault folders of a folder outside a vault: the nodes of a vault right below it
  const vaultsToo = !!node.vault_id || on(q && q.vaults);
  const where = `parent_id = ? AND deleted_at IS NULL${vaultsToo ? '' : ' AND vault_id IS NULL'}${dirs ? ' AND is_dir = 1' : ''}`;
  const sub = vaultsToo ? '' : ' AND (c.vault_id IS NULL OR nodes.vault_id IS NOT NULL)';
  const hasDirs = dirs ? `, EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = nodes.id AND c.is_dir = 1 AND c.deleted_at IS NULL${sub}) AS has_dirs` : '';
  const rows = await store.all(ctx.gc, `SELECT *${hasDirs} FROM nodes WHERE ${where}
    ORDER BY is_dir DESC, ${sort} ${dir}, id LIMIT ? OFFSET ?`, [node.id, limit + 1, offset]);
  const total = (await store.one(ctx.gc, `SELECT COUNT(*) AS n FROM nodes WHERE ${where}`, [node.id])).n;
  if (via === 'parent') await ctx.noteChildView(area);
  const items = rows.slice(0, limit).map(({ has_dirs: h, ...r }) => view(r, dirs ? { hasDirs: !!h } : null));
  return { items, total, next: rows.length > limit ? offset + limit : null, role };
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
    AND deleted_at IS NULL AND vault_id IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY is_dir DESC, updated_at DESC LIMIT ?`, [...ids, like, SEARCH_MAX]);
  const items = [];
  for (const r of rows) items.push(view(r, { path: await pathOf(ctx.gc, r), match: 'name' }));
  if (rows.length < SEARCH_MAX) {
    const seen = new Set(rows.map((r) => r.id));
    const hits = await store.all(ctx.gc, `SELECT n.*, t.text AS doc_text FROM doc_text t JOIN nodes n ON n.id = t.node_id
      WHERE n.area_id IN (${store.marks(ids.length)}) AND n.deleted_at IS NULL AND n.vault_id IS NULL AND t.text LIKE ? ESCAPE '\\'
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

/**
 * POST nodes { parentId, name } → a new folder (a free name: "Neuer Ordner (2)" with { rename: true }). In a vault
 * (since 1.9.0): { parentId, encrypted: true, nameCipher, keyVersion } — the name is opaque.
 */
async function mkdir(ctx, body) {
  const b = body && typeof body === 'object' ? body : {};
  const parentId = Number(b.parentId);
  return store.tx(ctx.gc, async () => {
    const { node: parent } = await folderFor(ctx, parentId);
    const enc = await vaults().forNewNode(ctx, parent, { ...b, name: null });
    if (enc) {
      await unmarkUp(ctx.gc, parent.id, ctx);
      const r = await store.run(ctx.gc, `INSERT INTO nodes (area_id, parent_id, name, is_dir, created_at, created_by, updated_at, updated_by, vault_id, name_cipher, key_version)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`, [parent.area_id, parent.id, enc.name, ctx.now, ctx.viewer, ctx.now, ctx.viewer, enc.vaultId, enc.nameCipher, enc.keyVersion]);
      await log(ctx.gc, parent.area_id, r.lastInsertRowid, 'create', ctx);
      return view(await row(ctx.gc, r.lastInsertRowid));
    }
    let name = nodeName(b.name);
    if (await taken(ctx.gc, parent.area_id, parent.id, name)) {
      if (!b.rename) throw fail('exists');
      name = await freeName(ctx.gc, parent.area_id, parent.id, name);
    }
    await unmarkUp(ctx.gc, parent.id, ctx);
    return view(await insertFolder(ctx, parent.area_id, parent.id, name));
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

/**
 * PATCH nodes/<id> { name?, parentId? } — rename and / or move (also into another area the viewer writes to). A node of
 * a vault (since 1.9.0): { nameCipher?, parentId? } — its opaque name stays; it moves only within its vault, the vault's
 * folder not at all (since 1.11.0; it stays in the top folder of its area); nothing moves into or out of a vault.
 */
async function update(ctx, id, body, opts = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const wantParent = b.parentId != null ? Number(b.parentId) : null;
  let moved = null;
  const out = await store.tx(ctx.gc, async () => {
    const { node, area } = await reach(ctx, Number(id), 'write');
    if (node.parent_id == null) throw fail('invalid');
    if (area.archived_at != null) throw fail('forbidden');
    const parent = wantParent != null && wantParent !== node.parent_id ? (await folderFor(ctx, wantParent)) : { node: await row(ctx.gc, node.parent_id), area };
    let cipher = null;
    if (node.vault_id) {
      if (b.name != null && b.name !== node.name) throw fail('invalid', { field: 'name' });
      const v = await vaults().row(ctx.gc, node.vault_id);
      const root = v && v.node_id === node.id;
      // the vault's folder stays in the top folder of its area (since 1.11.0 — the vaults are in the menu)
      if (root ? parent.node.id !== node.parent_id : parent.node.vault_id !== node.vault_id) throw fail('invalid', { field: 'parentId' });
      if (b.nameCipher != null) {
        cipher = vaults().nameCipherArg(b.nameCipher);
        // a new name under the current key; the time travel (opts.anyKey) brings back one of an older key
        const kv = vaults().nameVersion(cipher);
        if (!v || (opts.anyKey ? kv > v.key_version : kv !== v.key_version)) throw fail('conflict', { reason: 'stale_key', keyVersion: v ? v.key_version : null });
        if (cipher === node.name_cipher) cipher = null;
      }
    } else if (b.nameCipher != null || parent.node.vault_id) throw fail('invalid', { field: b.nameCipher != null ? 'nameCipher' : 'parentId' });
    const name = node.vault_id ? node.name : (b.name != null ? nodeName(b.name) : node.name);
    if (parent.node.id === node.id) throw fail('invalid');
    if (node.is_dir === 1 && parent.node.area_id === node.area_id) {
      const under = await below(ctx.gc, node.id);
      if (under.some((r) => r.id === parent.node.id)) throw fail('invalid', { field: 'parentId' });
    }
    if (parent.node.id === node.parent_id && name === node.name && !cipher) return view(node);
    if (await taken(ctx.gc, parent.node.area_id, parent.node.id, name, node.id)) throw fail('exists');
    if (parent.node.id === node.parent_id && name === node.name) {
      // a vault node's new encrypted name: no path changes (its opaque name stays)
      await store.run(ctx.gc, "INSERT INTO node_log (node_id, at, op, area_id, parent_id, name, name_cipher) VALUES (?, ?, 'move', ?, ?, ?, ?)",
        [node.id, ctx.now, node.area_id, node.parent_id, node.name, node.name_cipher || null]);
      await store.run(ctx.gc, `UPDATE nodes SET name_cipher = ?, updated_at = ?, updated_by = ?, ${UNMARKED} WHERE id = ?`, [cipher, ctx.now, ctx.viewer, node.id]);
      await unmarkUp(ctx.gc, node.parent_id, ctx);
      await log(ctx.gc, area.id, node.id, 'move', ctx);
      const now = await row(ctx.gc, node.id);
      await guard.note(ctx, { op: 'rename', node: now, name, oldName: node.name, parentId: node.parent_id });
      return view(now);
    }
    const toArea = parent.area;
    const base = join(await pathOf(ctx.gc, parent.node), name);
    const oldBase = await pathOf(ctx.gc, node);
    // the files to move: the node itself, or every live file below the folder
    let files = [];
    const oldPaths = new Map();
    if (node.is_dir === 1) {
      const rows = await below(ctx.gc, node.id);
      // a vault stays in its area (its people are the area's)
      if (toArea.id !== area.id && rows.some((r) => r.vault_id)) throw fail('invalid', { field: 'parentId' });
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
    // the history: where it was (the time travel brings it back — timetravel.js)
    await store.run(ctx.gc, "INSERT INTO node_log (node_id, at, op, area_id, parent_id, name, name_cipher) VALUES (?, ?, 'move', ?, ?, ?, ?)",
      [node.id, ctx.now, node.area_id, node.parent_id, node.name, node.name_cipher || null]);
    await store.run(ctx.gc, `UPDATE nodes SET parent_id = ?, name = ?, name_cipher = COALESCE(?, name_cipher), area_id = ?, updated_at = ?, updated_by = ?, ${UNMARKED} WHERE id = ?`,
      [parent.node.id, name, cipher, toArea.id, ctx.now, ctx.viewer, node.id]);
    // a renamed or moved node is in use: its mark ends, and so do those of the folder it is in now
    await unmarkUp(ctx.gc, parent.node.id, ctx);
    if (toArea.id !== area.id) {
      // older versions stay in the media area they were made in (a version only moves back to a path); a restore
      // brings one over (files.js restoreVersion)
      await store.run(ctx.gc, `UPDATE nodes SET area_id = ? WHERE id IN (WITH RECURSIVE down(id) AS (
          SELECT id FROM nodes WHERE parent_id = ? UNION ALL SELECT n.id FROM nodes n JOIN down ON n.parent_id = down.id) SELECT id FROM down)`,
      [toArea.id, node.id]);
    }
    // into or out of the mover's work folder: the review marks end (since 1.13.0, work.js)
    if (parent.node.id !== node.parent_id) await work().moved(ctx, node, node.parent_id, parent.node.id);
    if (toArea.id !== area.id) {
      await log(ctx.gc, area.id, node.id, 'delete', ctx);
      await log(ctx.gc, toArea.id, node.id, 'create', ctx);
    } else {
      await log(ctx.gc, area.id, node.id, 'move', ctx);
    }
    const now = await row(ctx.gc, node.id);
    await guard.note(ctx, { op: 'rename', node: now, name, oldName: node.name, parentId: node.parent_id });
    return view(now);
  });
  if (moved) unlinkLater(ctx, 'folders', moved);
  return out;
}

/**
 * Inside a transaction: vault folder `node` of `area` into the area's top folder (since 1.11.0, vault.js toRoots) — the
 * files below get their new paths, the history and the change log a move (the live event follows with ctx.touched).
 * Its opaque name stays (a new one only should another node of the top folder have it). The encryption knows nothing of
 * the folder a vault is in (README "Tresor-Ordner – Kryptografie"): names and contents stay as they are.
 */
async function vaultToRoot(ctx, node, area) {
  const root = await row(ctx.gc, area.root_id);
  if (!root || node.parent_id === root.id) return false;
  let name = node.name;
  while (await taken(ctx.gc, area.id, root.id, name, node.id)) name = vaults().opaqueName();
  const rows = await below(ctx.gc, node.id);
  const now = pathsBelow(node.id, name, rows);
  const before = pathsBelow(node.id, await pathOf(ctx.gc, node), rows);
  const files = rows.filter((r) => r.is_dir === 0 && r.deleted_at == null && r.media_id).map((r) => ({ id: r.id, media_id: r.media_id, path: now.get(r.id) }));
  await moveMedia(ctx.gc, files, area.media_area, area.media_area, new Map(files.map((f) => [f.id, before.get(f.id)])));
  await store.run(ctx.gc, "INSERT INTO node_log (node_id, at, op, area_id, parent_id, name, name_cipher) VALUES (?, ?, 'move', ?, ?, ?, ?)",
    [node.id, ctx.now, node.area_id, node.parent_id, node.name, node.name_cipher || null]);
  await store.run(ctx.gc, 'UPDATE nodes SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?', [root.id, name, ctx.now, node.id]);
  await log(ctx.gc, area.id, node.id, 'move', ctx);
  return true;
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
    const all = await trashRows(ctx, node, area);
    gone = all.map((r) => r.id);
    await guard.note(ctx, { op: 'delete', node, name: node.name });
    const wipe = everywhere ? await wipes.create(ctx, node, all.filter((r) => r.is_dir === 0)) : null;
    return { id: node.id, trashed: all.length, ...(wipe ? { wipe } : {}) };
  });
  unlinkLater(ctx, 'all', gone);
  return out;
}

/**
 * Inside a transaction: live node `node` of `area` (not the root) and everything live below it into the trash — the
 * files leave their paths, one 'delete' in the change log, marks end → the rows trashed. Also the background run's
 * delete of a marked node (marks.js).
 */
async function trashRows(ctx, node, area) {
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
  // (in parts: the host takes at most 100 parameters a statement)
  for (const part of store.chunks(all.map((r) => r.id))) {
    await store.run(ctx.gc, `UPDATE nodes SET deleted_at = ?, deleted_by = ?, trash_id = ?, ${UNMARKED} WHERE id IN (${store.marks(part.length)})`,
      [ctx.now, ctx.viewer || null, node.id, ...part]);
  }
  await log(ctx.gc, area.id, node.id, 'delete', ctx);
  return all;
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
    // a vault's folder (since 1.11.0): back into the top folder of its area, wherever it was
    const vaultTop = node.vault_id ? await vaults().row(ctx.gc, node.vault_id) : null;
    if (vaultTop && vaultTop.node_id === node.id) parent = await row(ctx.gc, area.root_id);
    if (!parent || parent.deleted_at != null) {
      // a node of a vault goes back into its vault (the vault's folder first, when that is in the trash too)
      const v = node.vault_id ? await vaults().row(ctx.gc, node.vault_id) : null;
      if (v && v.node_id !== node.id) {
        parent = await row(ctx.gc, v.node_id);
        if (!parent || parent.deleted_at != null) throw fail('conflict', { reason: 'vault_trashed', nodeId: v.node_id });
      } else parent = await row(ctx.gc, area.root_id);
    }
    const name = await freeName(ctx.gc, area.id, parent.id, node.name);
    const batch = await store.all(ctx.gc, 'SELECT * FROM nodes WHERE trash_id = ?', [node.id]);
    const base = join(await pathOf(ctx.gc, parent), name);
    const rows = batch.filter((r) => r.id !== node.id);
    const paths = node.is_dir === 1 ? pathsBelow(node.id, base, rows) : new Map();
    paths.set(node.id, base);
    const files = batch.filter((r) => r.is_dir === 0 && r.media_id).map((r) => ({ id: r.id, media_id: r.media_id, path: paths.get(r.id) }));
    await moveMedia(ctx.gc, files, area.media_area, area.media_area, new Map(files.map((f) => [f.id, null])));
    // the history: each node of the batch was in the trash since … (the time travel puts it back — timetravel.js)
    await store.run(ctx.gc, `INSERT INTO node_log (node_id, at, op, area_id, parent_id, name, deleted_since, name_cipher)
      SELECT id, ?, 'restore', area_id, parent_id, name, deleted_at, name_cipher FROM nodes WHERE trash_id = ?`, [ctx.now, node.id]);
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
  // versions of an empty file have no media (since 1.5.0); the ids in parts (≤ 100 parameters a statement)
  const versions = await store.all(gc, 'SELECT v.media_id FROM versions v JOIN nodes n ON n.id = v.node_id WHERE n.trash_id = ? AND v.media_id IS NOT NULL', [trashId]);
  for (const m of [...batch.filter((r) => r.media_id).map((r) => r.media_id), ...versions.map((v) => v.media_id)]) {
    try { await gc.media.delete(m); } catch (e) { gc.log.warn('purge: media delete failed', (e && e.code) || 'error'); }
  }
  for (const part of store.chunks(ids)) {
    const m = store.marks(part.length);
    await store.run(gc, `DELETE FROM versions WHERE node_id IN (${m})`, part);
    await store.run(gc, `DELETE FROM doc_text WHERE node_id IN (${m})`, part);
  }
  await forget(gc, ids);
  for (const part of store.chunks(ids)) await store.run(gc, `DELETE FROM nodes WHERE id IN (${store.marks(part.length)})`, part);
  const top = batch.find((r) => r.id === trashId) || batch[0];
  await log(gc, top.area_id, trashId, 'purge', ctx);
  return batch.filter((r) => r.is_dir === 0).length;
}

/** Nodes `ids` go for good: their history, their places in albums (since 1.7.0), their insights and deadlines (1.8.0), a
 * vault's keys, office locks (1.9.0), calendar entries of deadlines and image labels (1.14.0), sources and filing rules
 * (1.15.0), faces (1.16.0 — the place goes with the row). */
async function forget(gc, ids) {
  await vaults().forget(gc, ids);
  await require('./faces').forget(gc, ids);
  for (const part of store.chunks(ids)) {
    const m = store.marks(part.length);
    await store.run(gc, `DELETE FROM node_log WHERE node_id IN (${m})`, part);
    await store.run(gc, `DELETE FROM office_locks WHERE node_id IN (${m})`, part);
    await store.run(gc, `DELETE FROM album_items WHERE node_id IN (${m})`, part);
    await store.run(gc, `UPDATE albums SET cover_id = NULL WHERE cover_id IN (${m})`, part);
    // AI for documents (since 1.8.0): the suggestion, the deadlines and their reminders
    await store.run(gc, `DELETE FROM doc_insights WHERE node_id IN (${m})`, part);
    await store.run(gc, `DELETE FROM doc_reminders WHERE deadline_id IN (SELECT id FROM doc_deadlines WHERE node_id IN (${m}))`, part);
    // since 1.14.0: the calendar entries of its deadlines (Familie keeps its dates), its image labels
    await store.run(gc, `DELETE FROM doc_calendar WHERE deadline_id IN (SELECT id FROM doc_deadlines WHERE node_id IN (${m}))`, part);
    await store.run(gc, `DELETE FROM node_labels WHERE node_id IN (${m})`, part);
    await store.run(gc, `DELETE FROM doc_deadlines WHERE node_id IN (${m})`, part);
    // since 1.15.0: where a file came from (Mail), and the senders whose files went to a folder that is gone
    await store.run(gc, `DELETE FROM node_sources WHERE node_id IN (${m})`, part);
    await store.run(gc, `DELETE FROM filing_rules WHERE folder_id IN (${m})`, part);
    // since 1.18.0: "Zuletzt geöffnet"
    await store.run(gc, `DELETE FROM recent_opens WHERE node_id IN (${m})`, part);
  }
}

/** DELETE trash/<id> → gone for good. */
async function purge(ctx, id) {
  return store.tx(ctx.gc, async () => {
    const { node } = await trashed(ctx, Number(id));
    return { id: node.id, files: await purgeBatch(ctx.gc, node.id, ctx) };
  });
}

module.exports = {
  row, pathOf, below, pathsBelow, view, takenOf, TAKEN, forget, log, reach, folderFor, taken, freeName, join, insertFolder, unmarkUp, UNMARKED, get, children, byPath, search,
  mkdir, update, vaultToRoot, trash, trashRows, unlinkLater, trashList, restore, purge, purgeBatch, moveMedia,
};
