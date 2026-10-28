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
//
// Empty files (since 1.5.0): GateControl's media upload takes no empty body (411), so an empty file has no media object —
// POST uploads/commit { parentId, name, size: 0 } without a mediaId makes it (media_id null, size 0, sha256 of no bytes).
// Its content is an empty data: URL ({ empty: true }); its versions are rows without media.
//
// Ransomware protection (since 1.6.0, guard.js): commit { entropy } — the device's hint how random the bytes are (0–8
// bits per byte, optional) — is kept with the file (nodes.entropy); every new file and every new version of an app
// request is a row of the guard's journal.
//
// When a picture was taken (since 1.7.0): commit { takenAt } — ISO-8601 or ms since the epoch (else 400 invalid, field
// takenAt); a time more than a day ahead or before 1900 is ignored (stored as null). Without it the node's takenAt is
// its mtime, else when it came. A new version keeps the takenAt of the file unless it sends one. Every content keeps
// since when it was the file's (nodes.content_at, versions.since) — the time travel (timetravel.js) knows which
// version was the file's at a time.

const store = require('./store');
const nodes = require('./nodes');
const guard = require('./guard');
const { fail, nodeName, MEDIA_RE, SHA_RE, EMPTY_SHA, iso, nonNeg, docText, msArg } = require('./util');

const URL_TTL_S = 3600;
const DAY = 86400000;
const TAKEN_MIN = Date.UTC(1900, 0, 1);

/** commit { takenAt } → ms or null (absent, more than a day ahead, before 1900); not a time → 400 invalid. */
function takenArg(v, now) {
  if (v == null || v === '') return null;
  const ms = msArg(v);
  if (!Number.isFinite(ms)) throw fail('invalid', { field: 'takenAt' });
  return ms > now + DAY || ms < TAKEN_MIN ? null : ms;
}

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

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/;

/** commit { size: 0 } (or { empty: true }) without a mediaId: an empty file. A sha256 sent with it must be that of no bytes. */
function isEmpty(b) {
  if (b.mediaId != null) return false;
  if (!(b.size === 0 || b.size === '0' || b.empty === true)) return false;
  if (b.sha256 != null && String(b.sha256).toLowerCase() !== EMPTY_SHA) throw fail('invalid', { field: 'sha256' });
  return true;
}

/** The type the device names for an empty file (there are no bytes GateControl could look at), else null. */
const mimeArg = (v) => (typeof v === 'string' && MIME_RE.test(v.toLowerCase()) ? v.toLowerCase() : null);

/** The content of an empty file or version: an empty data: URL — nothing to download. */
const emptyContent = (name, mime) => ({ url: `data:${mime || 'application/octet-stream'};base64,`, name, mime: mime || null, size: 0, mediaId: null, empty: true });

/**
 * Older versions over the limit (count) of node `id` go → count removed. A version an incident of the ransomware
 * protection may still bring back (guard.js) stays.
 */
async function trimVersions(gc, id, max) {
  // a version a time travel made (its undo needs it — hold_until) is neither counted nor removed
  const extra = await store.all(gc, 'SELECT * FROM versions WHERE node_id = ? AND (hold_until IS NULL OR hold_until < ?) ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?', [id, Date.now(), max]);
  const kept = new Set((await store.all(gc, `SELECT l.version_id FROM guard_log l JOIN guard_incidents i ON i.id = l.incident_id
    WHERE l.node_id = ? AND l.version_id IS NOT NULL AND i.state <> 'undone'`, [id])).map((r) => r.version_id));
  const drop = extra.filter((v) => !kept.has(v.id));
  for (const v of drop) {
    if (v.media_id) { try { await gc.media.delete(v.media_id); } catch (e) { gc.log.warn('version delete failed', (e && e.code) || 'error'); } }
    await store.run(gc, 'DELETE FROM versions WHERE id = ?', [v.id]);
  }
  return drop.length;
}

/**
 * Keep the current bytes of file `n` as a version (gc.media.version + a versions row; an empty file: the row alone) → its
 * id. `since`: since when they were the file's (null before 1.7.0 — the first content: since the file came); `holdUntil`:
 * a time travel's version, kept until then.
 */
async function keepVersion(ctx, n, holdUntil = null) {
  if (n.media_id) await ctx.gc.media.version(n.media_id);
  const since = n.content_at != null ? n.content_at : (n.rev === 1 ? n.created_at : null);
  const r = await store.run(ctx.gc, 'INSERT INTO versions (node_id, rev, media_id, size, sha256, at, by, since, hold_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [n.id, n.rev, n.media_id || null, n.media_id ? n.size : 0, n.media_id ? n.sha256 : (n.sha256 || EMPTY_SHA), ctx.now, n.updated_by, since, holdUntil]);
  return Number(r.lastInsertRowid);
}

/** POST uploads/commit → { node, created }. */
async function commit(ctx, body) {
  const b = body && typeof body === 'object' ? body : {};
  const empty = isEmpty(b);
  const info = empty ? { mediaId: null, bytes: 0, sha256: EMPTY_SHA, mime: mimeArg(b.mime) } : await freshUpload(ctx, b.mediaId);
  let name = nodeName(b.name);
  const mtime = b.mtime == null ? null : (Number.isSafeInteger(Number(b.mtime)) ? Number(b.mtime) : Date.parse(b.mtime));
  if (b.mtime != null && !Number.isFinite(mtime)) throw fail('invalid', { field: 'mtime' });
  const baseRev = b.baseRev == null ? null : nonNeg(b.baseRev);
  const onConflict = b.onConflict == null ? null : String(b.onConflict);
  if (onConflict && onConflict !== 'rename' && onConflict !== 'version') throw fail('invalid', { field: 'onConflict' });
  if (b.text != null && typeof b.text !== 'string') throw fail('invalid', { field: 'text' });
  const text = docText(b.text);
  const entropy = guard.entropyArg(b.entropy);
  const taken = takenArg(b.takenAt, ctx.now);
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
      const versionId = await keepVersion(ctx, existing);
      if (info.mediaId) {
        try {
          await ctx.gc.media.claim(info.mediaId, { area: area.media_area, path: p });
        } catch (e) {
          // the old bytes take their path again
          if (existing.media_id) { try { await ctx.gc.media.move(existing.media_id, { path: p }); } catch { /* best effort */ } }
          throw mediaFail(e);
        }
      }
      await store.run(ctx.gc, `UPDATE nodes SET media_id = ?, size = ?, sha256 = ?, mime = ?, mtime = ?, rev = rev + 1, updated_at = ?, updated_by = ?, entropy = ?,
        taken_at = COALESCE(?, taken_at), content_at = ? WHERE id = ?`, [info.mediaId, info.bytes, info.sha256 || null, (empty ? info.mime || existing.mime : info.mime) || null, mtime, ctx.now, ctx.viewer, entropy,
        taken, ctx.now, existing.id]);
      await nodes.log(ctx.gc, area.id, existing.id, 'update', ctx);
      await guard.note(ctx, { op: 'overwrite', node: existing, name, versionId, entropy, entropyBefore: existing.entropy });
      // new content: a mark of the file ("deleted on the device") ends, and those of the folders above it
      await nodes.unmarkUp(ctx.gc, existing.id, ctx, existing.id);
      await setText(ctx, existing.id, text);
      await trimVersions(ctx.gc, existing.id, ctx.settings.versionsMax);
      noteInsight(ctx, existing.id);
      return { node: nodes.view(await nodes.row(ctx.gc, existing.id)), created: false };
    }
    if (info.mediaId) {
      try {
        await ctx.gc.media.claim(info.mediaId, { area: area.media_area, path: p });
      } catch (e) { throw mediaFail(e); }
    }
    await nodes.unmarkUp(ctx.gc, parent.id, ctx);
    const r = await store.run(ctx.gc, `INSERT INTO nodes (area_id, parent_id, name, is_dir, media_id, size, sha256, mime, mtime, created_at, created_by, updated_at, updated_by, entropy, taken_at, content_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [area.id, parent.id, name, info.mediaId, info.bytes, info.sha256 || null, info.mime || null, mtime, ctx.now, ctx.viewer, ctx.now, ctx.viewer, entropy, taken, ctx.now]);
    await nodes.log(ctx.gc, area.id, r.lastInsertRowid, 'create', ctx);
    await guard.note(ctx, { op: 'create', node: await nodes.row(ctx.gc, r.lastInsertRowid), name, entropy });
    await setText(ctx, r.lastInsertRowid, text);
    noteInsight(ctx, Number(r.lastInsertRowid));
    return { node: nodes.view(await nodes.row(ctx.gc, r.lastInsertRowid)), created: true };
  });
}

/** A new file or version: AI for documents may look at it after the request (insights.js consider, since 1.8.0). */
function noteInsight(ctx, id) {
  (ctx.insightIds || (ctx.insightIds = new Set())).add(id);
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
  // an empty file is the same as an empty one, also without a sha256
  const same = n.is_dir === 0 && ((sha != null && n.sha256 === sha && (b.size == null || Number(b.size) === n.size))
    || (sha == null && b.size != null && Number(b.size) === 0 && n.size === 0 && !n.media_id));
  return { exists: true, same, node: nodes.view(n) };
}

/** GET nodes/<id>/content → { url, name, mime, size, mediaId } — the URL is signed for the viewer, 1 h. */
async function content(ctx, id) {
  const { node, area, via } = await nodes.reach(ctx, Number(id));
  if (node.is_dir === 1 || (!node.media_id && node.size !== 0)) throw fail('invalid');
  if (via === 'parent') await ctx.noteChildView(area);
  if (!node.media_id) return emptyContent(node.name, node.mime);
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
  if (!v.media_id) return { ...emptyContent(node.name, node.mime), rev: v.rev };
  const url = await ctx.gc.media.url(v.media_id, { user: ctx.viewer, ttlS: URL_TTL_S });
  return { url, name: node.name, mime: node.mime, size: v.size, mediaId: v.media_id, rev: v.rev };
}

/**
 * POST nodes/<id>/versions/<vid>/restore → the version is the file again; the current bytes become a version
 * (`holdUntil`: a time travel's — kept until then for its undo).
 */
async function restoreVersion(ctx, id, vid, holdUntil = null) {
  return store.tx(ctx.gc, async () => {
    const { node, area } = await nodes.reach(ctx, Number(id), 'write');
    if (area.archived_at != null) throw fail('forbidden');
    const v = await versionOf(ctx, node.id, Number(vid));
    const p = await nodes.pathOf(ctx.gc, node);
    // a version of an empty file has no media
    const info = v.media_id ? await ctx.gc.media.info(v.media_id) : null;
    if (v.media_id && !info) throw fail('not_found');
    await keepVersion(ctx, node, holdUntil);
    if (v.media_id) {
      try {
        await ctx.gc.media.move(v.media_id, { path: p, ...(info.area !== area.media_area ? { area: area.media_area } : {}) });
      } catch (e) {
        if (node.media_id) { try { await ctx.gc.media.move(node.media_id, { path: p }); } catch { /* best effort */ } }
        throw mediaFail(e);
      }
    }
    await store.run(ctx.gc, 'DELETE FROM versions WHERE id = ?', [v.id]);
    await store.run(ctx.gc, 'UPDATE nodes SET media_id = ?, size = ?, sha256 = ?, rev = rev + 1, updated_at = ?, updated_by = ?, entropy = NULL, content_at = ? WHERE id = ?',
      [v.media_id || null, v.media_id ? v.size : 0, v.media_id ? v.sha256 : EMPTY_SHA, ctx.now, ctx.viewer, ctx.now, node.id]);
    await nodes.log(ctx.gc, area.id, node.id, 'update', ctx);
    await nodes.unmarkUp(ctx.gc, node.id, ctx, node.id);
    await setText(ctx, node.id, null);
    return nodes.view(await nodes.row(ctx.gc, node.id));
  });
}

/** DELETE nodes/<id>/versions/<vid> → an older version gone. */
async function deleteVersion(ctx, id, vid) {
  return store.tx(ctx.gc, async () => {
    const { node } = await nodes.reach(ctx, Number(id), 'write');
    const v = await versionOf(ctx, node.id, Number(vid));
    if (v.media_id) { try { await ctx.gc.media.delete(v.media_id); } catch (e) { ctx.gc.log.warn('version delete failed', (e && e.code) || 'error'); } }
    await store.run(ctx.gc, 'DELETE FROM versions WHERE id = ?', [v.id]);
    return { id: v.id };
  });
}

module.exports = { commit, check, content, versions, versionContent, restoreVersion, deleteVersion, trimVersions, takenArg, URL_TTL_S };
