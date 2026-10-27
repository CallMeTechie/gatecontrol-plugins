'use strict';

// Changes made directly on a NAS (an area in the readable form on a NAS): GateControl looks every 15 minutes and
// keeps a journal (gc.media.areas.changes) — added, changed, removed files with their paths — then calls the hook
// mediaChanged({ area }). Here the journal becomes the tree:
//   added    a file at its path (the folders on the way are made)
//   changed  the file at that path gets the new bytes; the old ones are a version when GateControl kept them
//   removed  the file is gone (it was deleted on the NAS): its node and versions go
// The journal is read from where it was left (table journal); the background run reads it too, in case a call of
// the hook was missed.

const store = require('./store');
const nodes = require('./nodes');

const NAS = { viewer: null, deviceId: 'nas' };

async function nodeOfMedia(gc, mediaId) {
  return mediaId ? store.one(gc, 'SELECT * FROM nodes WHERE media_id = ?', [mediaId]) : null;
}

/** The folder at `segs` below the root of `area` (made where missing) → its node. */
async function folders(gc, area, segs, ctx) {
  let cur = await nodes.row(gc, area.root_id);
  for (const s of segs) {
    let next = await nodes.taken(gc, area.id, cur.id, s);
    if (next && next.is_dir !== 1) return null;
    if (!next) {
      const by = ctx.viewer || null;
    const r = await store.run(gc, 'INSERT INTO nodes (area_id, parent_id, name, is_dir, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?, ?, ?)', [area.id, cur.id, s, ctx.now, by, ctx.now, by]);
      await nodes.log(gc, area.id, r.lastInsertRowid, 'create', ctx);
      next = await nodes.row(gc, r.lastInsertRowid);
    }
    cur = next;
  }
  return cur;
}

/** A file at c.path (the folders on the way made) → true when it became a node. Also for uploads through a link. */
async function added(gc, area, c, ctx) {
  if (await nodeOfMedia(gc, c.mediaId)) return false;
  const segs = String(c.path || '').split('/').filter(Boolean);
  const name = segs.pop();
  if (!name) return false;
  const parent = await folders(gc, area, segs, ctx);
  const info = await gc.media.info(c.mediaId);
  if (!parent || !info) return false;
  const there = await nodes.taken(gc, area.id, parent.id, name);
  // an empty file (no media object, since 1.5.0) is not on the NAS: a file put at its path is its new content
  if (there && there.is_dir === 0 && !there.media_id) { await replace(gc, area, there, c.mediaId, info, ctx, false); return true; }
  if (there) { gc.log.warn('a node has this name already', there.is_dir ? 'folder' : 'file'); return false; }
  const by = ctx.viewer || null;
  const r = await store.run(gc, `INSERT INTO nodes (area_id, parent_id, name, is_dir, media_id, size, sha256, mime, created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`, [area.id, parent.id, name, c.mediaId, info.bytes, info.sha256 || null, info.mime || null, ctx.now, by, ctx.now, by]);
  await nodes.log(gc, area.id, r.lastInsertRowid, 'create', ctx);
  return true;
}

async function changed(gc, area, c, ctx) {
  let n = await nodeOfMedia(gc, c.previous);
  if (!n) {
    // the old bytes were not kept (or not known): the node at that path
    const segs = String(c.path || '').split('/').filter(Boolean);
    const name = segs.pop();
    let cur = await nodes.row(gc, area.root_id);
    for (const s of segs) { cur = cur && await nodes.taken(gc, area.id, cur.id, s); }
    n = cur && name ? await nodes.taken(gc, area.id, cur.id, name) : null;
    if (n && n.is_dir === 1) n = null;
  }
  if (!n) return added(gc, area, c, ctx);
  const info = await gc.media.info(c.mediaId);
  if (!info) return;
  await replace(gc, area, n, c.mediaId, info, ctx, !!(c.previous && c.previous === n.media_id));
}

/** File `n` has new bytes `mediaId` (`keep`: its old ones are a version GateControl kept; an empty file's always are). */
async function replace(gc, area, n, mediaId, info, ctx, keep) {
  if (keep || !n.media_id) {
    await store.run(gc, 'INSERT INTO versions (node_id, rev, media_id, size, sha256, at, by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [n.id, n.rev, n.media_id || null, n.size, n.sha256, ctx.now, n.updated_by]);
  }
  await store.run(gc, 'UPDATE nodes SET media_id = ?, size = ?, sha256 = ?, mime = ?, rev = rev + 1, updated_at = ?, updated_by = NULL WHERE id = ?',
    [mediaId, info.bytes, info.sha256 || null, info.mime || n.mime, ctx.now, n.id]);
  await nodes.log(gc, area.id, n.id, 'update', ctx);
  // new content: a mark ("deleted on the device") ends
  await nodes.unmarkUp(gc, n.id, ctx, n.id);
}

async function removed(gc, area, c, ctx) {
  const v = await store.one(gc, 'SELECT * FROM versions WHERE media_id = ?', [c.mediaId]);
  if (v) { await store.run(gc, 'DELETE FROM versions WHERE id = ?', [v.id]); return; }
  const n = await nodeOfMedia(gc, c.mediaId);
  if (!n) return;
  const old = await store.all(gc, 'SELECT media_id FROM versions WHERE node_id = ?', [n.id]);
  for (const o of old) { try { await gc.media.delete(o.media_id); } catch { /* gone already */ } }
  await store.run(gc, 'DELETE FROM versions WHERE node_id = ?', [n.id]);
  await store.run(gc, 'DELETE FROM nodes WHERE id = ?', [n.id]);
  await nodes.log(gc, area.id, n.id, 'purge', ctx);
}

/** Read the journal of media area `mediaArea` → { applied, touched: Set of area ids }. Never call inside store.tx. */
async function area(gc, mediaArea, now = Date.now()) {
  const a = await store.one(gc, 'SELECT * FROM areas WHERE media_area = ?', [mediaArea]);
  const ctx = { ...NAS, now, touched: new Set() };
  if (!a || a.root_id == null) return { applied: 0, touched: ctx.touched };
  let applied = 0;
  for (let round = 0; round < 50; round++) {
    const j = await store.one(gc, 'SELECT seq FROM journal WHERE media_area = ?', [mediaArea]);
    const since = j ? j.seq : 0;
    const page = await gc.media.areas.changes(mediaArea, { since, limit: 500 });
    if (!page || !Array.isArray(page.changes) || !page.changes.length) break;
    await store.tx(gc, async () => {
      for (const c of page.changes) {
        if (c.type === 'added') await added(gc, a, c, ctx);
        else if (c.type === 'changed') await changed(gc, a, c, ctx);
        else if (c.type === 'removed') await removed(gc, a, c, ctx);
        applied++;
      }
      await store.run(gc, 'INSERT INTO journal (media_area, seq) VALUES (?, ?) ON CONFLICT (media_area) DO UPDATE SET seq = excluded.seq', [mediaArea, page.next]);
    });
    if (!page.more) break;
  }
  return { applied, touched: ctx.touched };
}

module.exports = { area, adopt: added };
