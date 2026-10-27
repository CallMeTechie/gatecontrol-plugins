'use strict';

// Files: an upload becomes a file of a folder (commit), the content (a signed media URL), versions.
//
// Uploading is GateControl's media upload of the apps and the portal (PUT …/plugins/gatecontrol-drive/media,
// resumable, with a SHA-256 digest) — it answers a mediaId, unclaimed and owned by the uploader. POST
// uploads/commit { mediaId, parentId, name, baseRev?, mtime?, onConflict? } makes it a file:
//   a new name                 → a new file (claimed into the area at its path)
//   the name of a file, baseRev = its rev, or onConflict 'version'
//                              → a new version of that file: the old bytes become a version (gc.media.version)
//   the name of a file otherwise → 409 conflict { current } — the device keeps its copy as
//                                  "Name (Konflikt …)" or sends again with onConflict 'rename' (a free name)
// POST uploads/check { parentId, name, sha256, size } says first whether the very same file is there already.

const store = require('./store');
const nodes = require('./nodes');
const { fail, nodeName, MEDIA_RE, SHA_RE, iso, nonNeg, docText } = require('./util');

const URL_TTL_S = 3600;

function mediaFail(e) {
  if (e && e.code === 'ERR_MEDIA_QUOTA') return fail('quota');
  if (e && e.code === 'ERR_CONFLICT') return fail('conflict');
  return e;
}

/** The viewer's own fresh upload → its media info, else upload_invalid. */
async function freshUpload(ctx, mediaId) {
  if (typeof mediaId !== 'string' || !MEDIA_RE.test(mediaId)) throw fail('invalid', { field: 'mediaId' });
  const info = await ctx.gc.media.info(mediaId);
  if (!info || info.claimed || info.owner !== ctx.viewer || info.area) throw fail('upload_invalid');
  return info;
}

/** Older versions over the limit (count) of node `id` go → count removed. */
async function trimVersions(gc, id, max) {
  const extra = await store.all(gc, 'SELECT * FROM versions WHERE node_id = ? ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?', [id, max]);
  for (const v of extra) {
    try { await gc.media.delete(v.media_id); } catch (e) { gc.log.warn('version delete failed', (e && e.code) || 'error'); }
    await store.run(gc, 'DELETE FROM versions WHERE id = ?', [v.id]);
  }
  return extra.length;
}

/** Keep the current bytes of file `n` as a version (gc.media.version + a versions row). */
async function keepVersion(ctx, n) {
  await ctx.gc.media.version(n.media_id);
  await store.run(ctx.gc, 'INSERT INTO versions (node_id, rev, media_id, size, sha256, at, by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [n.id, n.rev, n.media_id, n.size, n.sha256, ctx.now, n.updated_by]);
}

/** POST uploads/commit → { node, created }. */
async function commit(ctx, body) {
  const b = body && typeof body === 'object' ? body : {};
  const info = await freshUpload(ctx, b.mediaId);
  let name = nodeName(b.name);
  const mtime = b.mtime == null ? null : (Number.isSafeInteger(Number(b.mtime)) ? Number(b.mtime) : Date.parse(b.mtime));
  if (b.mtime != null && !Number.isFinite(mtime)) throw fail('invalid', { field: 'mtime' });
  const baseRev = b.baseRev == null ? null : nonNeg(b.baseRev);
  const onConflict = b.onConflict == null ? null : String(b.onConflict);
  if (onConflict && onConflict !== 'rename' && onConflict !== 'version') throw fail('invalid', { field: 'onConflict' });
  if (b.text != null && typeof b.text !== 'string') throw fail('invalid', { field: 'text' });
  const text = docText(b.text);
  return store.tx(ctx.gc, async () => {
    const { node: parent, area } = await nodes.folderFor(ctx, Number(b.parentId));
    let existing = await nodes.taken(ctx.gc, area.id, parent.id, name);
    if (existing && (existing.is_dir === 1 || !((baseRev != null && baseRev === existing.rev) || onConflict === 'version'))) {
      if (onConflict !== 'rename') throw fail(existing.is_dir === 1 ? 'exists' : 'conflict', { current: nodes.view(existing) });
      name = await nodes.freeName(ctx.gc, area.id, parent.id, name);
      existing = null;
    }
    const p = nodes.join(await nodes.pathOf(ctx.gc, parent), name);
    if (existing) {
      if (existing.media_id) await keepVersion(ctx, existing);
      try {
        await ctx.gc.media.claim(info.mediaId, { area: area.media_area, path: p });
      } catch (e) {
        // the old bytes take their path again
        if (existing.media_id) { try { await ctx.gc.media.move(existing.media_id, { path: p }); } catch { /* best effort */ } }
        throw mediaFail(e);
      }
      await store.run(ctx.gc, `UPDATE nodes SET media_id = ?, size = ?, sha256 = ?, mime = ?, mtime = ?, rev = rev + 1, updated_at = ?, updated_by = ?
        WHERE id = ?`, [info.mediaId, info.bytes, info.sha256 || null, info.mime || null, mtime, ctx.now, ctx.viewer, existing.id]);
      await nodes.log(ctx.gc, area.id, existing.id, 'update', ctx);
      await setText(ctx, existing.id, text);
      await trimVersions(ctx.gc, existing.id, ctx.settings.versionsMax);
      return { node: nodes.view(await nodes.row(ctx.gc, existing.id)), created: false };
    }
    try {
      await ctx.gc.media.claim(info.mediaId, { area: area.media_area, path: p });
    } catch (e) { throw mediaFail(e); }
    const r = await store.run(ctx.gc, `INSERT INTO nodes (area_id, parent_id, name, is_dir, media_id, size, sha256, mime, mtime, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [area.id, parent.id, name, info.mediaId, info.bytes, info.sha256 || null, info.mime || null, mtime, ctx.now, ctx.viewer, ctx.now, ctx.viewer]);
    await nodes.log(ctx.gc, area.id, r.lastInsertRowid, 'create', ctx);
    await setText(ctx, r.lastInsertRowid, text);
    return { node: nodes.view(await nodes.row(ctx.gc, r.lastInsertRowid)), created: true };
  });
}

/** The recognised text of the file [id] (a new content without one drops the old: it belonged to other bytes). */
async function setText(ctx, id, text) {
  if (text) await store.run(ctx.gc, 'INSERT INTO doc_text (node_id, text, at) VALUES (?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET text = excluded.text, at = excluded.at', [id, text, ctx.now]);
  else await store.run(ctx.gc, 'DELETE FROM doc_text WHERE node_id = ?', [id]);
}

/** POST uploads/check { parentId, name, sha256, size } → { exists, same, node } — "same": no need to upload. */
async function check(ctx, body) {
  const b = body && typeof body === 'object' ? body : {};
  const name = nodeName(b.name);
  const sha = b.sha256 == null ? null : String(b.sha256).toLowerCase();
  if (sha != null && !SHA_RE.test(sha)) throw fail('invalid', { field: 'sha256' });
  const { node: parent, area } = await nodes.folderFor(ctx, Number(b.parentId));
  const n = await nodes.taken(ctx.gc, area.id, parent.id, name);
  if (!n) return { exists: false, same: false, node: null };
  const same = n.is_dir === 0 && sha != null && n.sha256 === sha && (b.size == null || Number(b.size) === n.size);
  return { exists: true, same, node: nodes.view(n) };
}

/** GET nodes/<id>/content → { url, name, mime, size, mediaId } — the URL is signed for the viewer, 1 h. */
async function content(ctx, id) {
  const { node, area, via } = await nodes.reach(ctx, Number(id));
  if (node.is_dir === 1 || !node.media_id) throw fail('invalid');
  if (via === 'parent') await ctx.noteChildView(area);
  const url = await ctx.gc.media.url(node.media_id, { user: ctx.viewer, ttlS: URL_TTL_S });
  return { url, name: node.name, mime: node.mime, size: node.size, mediaId: node.media_id };
}

function versionView(v) {
  return { id: v.id, rev: v.rev, size: v.size, sha256: v.sha256 || null, at: iso(v.at), by: v.by };
}

/** GET nodes/<id>/versions → { current, versions } newest first. */
async function versions(ctx, id) {
  const { node } = await nodes.reach(ctx, Number(id));
  if (node.is_dir === 1) throw fail('invalid');
  const rows = await store.all(ctx.gc, 'SELECT * FROM versions WHERE node_id = ? ORDER BY at DESC, id DESC', [node.id]);
  return { current: nodes.view(node), versions: rows.map(versionView) };
}

async function versionOf(ctx, id, vid) {
  const v = Number.isSafeInteger(vid) ? await store.one(ctx.gc, 'SELECT * FROM versions WHERE id = ? AND node_id = ?', [vid, id]) : null;
  if (!v) throw fail('not_found');
  return v;
}

/** GET nodes/<id>/versions/<vid>/content → { url, … } of an older version. */
async function versionContent(ctx, id, vid) {
  const { node, area, via } = await nodes.reach(ctx, Number(id));
  const v = await versionOf(ctx, node.id, Number(vid));
  if (via === 'parent') await ctx.noteChildView(area);
  const url = await ctx.gc.media.url(v.media_id, { user: ctx.viewer, ttlS: URL_TTL_S });
  return { url, name: node.name, mime: node.mime, size: v.size, mediaId: v.media_id, rev: v.rev };
}

/** POST nodes/<id>/versions/<vid>/restore → the version is the file again; the current bytes become a version. */
async function restoreVersion(ctx, id, vid) {
  return store.tx(ctx.gc, async () => {
    const { node, area } = await nodes.reach(ctx, Number(id), 'write');
    if (area.archived_at != null) throw fail('forbidden');
    const v = await versionOf(ctx, node.id, Number(vid));
    const p = await nodes.pathOf(ctx.gc, node);
    const info = await ctx.gc.media.info(v.media_id);
    if (!info) throw fail('not_found');
    if (node.media_id) await keepVersion(ctx, node);
    try {
      await ctx.gc.media.move(v.media_id, { path: p, ...(info.area !== area.media_area ? { area: area.media_area } : {}) });
    } catch (e) {
      if (node.media_id) { try { await ctx.gc.media.move(node.media_id, { path: p }); } catch { /* best effort */ } }
      throw mediaFail(e);
    }
    await store.run(ctx.gc, 'DELETE FROM versions WHERE id = ?', [v.id]);
    await store.run(ctx.gc, 'UPDATE nodes SET media_id = ?, size = ?, sha256 = ?, rev = rev + 1, updated_at = ?, updated_by = ? WHERE id = ?',
      [v.media_id, v.size, v.sha256, ctx.now, ctx.viewer, node.id]);
    await nodes.log(ctx.gc, area.id, node.id, 'update', ctx);
    await setText(ctx, node.id, null);
    return nodes.view(await nodes.row(ctx.gc, node.id));
  });
}

/** DELETE nodes/<id>/versions/<vid> → an older version gone. */
async function deleteVersion(ctx, id, vid) {
  return store.tx(ctx.gc, async () => {
    const { node } = await nodes.reach(ctx, Number(id), 'write');
    const v = await versionOf(ctx, node.id, Number(vid));
    try { await ctx.gc.media.delete(v.media_id); } catch (e) { ctx.gc.log.warn('version delete failed', (e && e.code) || 'error'); }
    await store.run(ctx.gc, 'DELETE FROM versions WHERE id = ?', [v.id]);
    return { id: v.id };
  });
}

module.exports = { commit, check, content, versions, versionContent, restoreVersion, deleteVersion, trimVersions, URL_TTL_S };
