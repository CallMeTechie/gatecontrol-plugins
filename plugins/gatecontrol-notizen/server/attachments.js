'use strict';

// Pictures and files of notes and tasks: the person uploads with GC.upload / PUT …/media, then names the file here —
// the hub claims it (GateControl keeps it sealed at rest, on its media storage). In a Tresor the upload is the
// ciphertext (application/octet-stream) and the name a nameCipher. Shown through signed URLs (gc.media.url, 1 h).

const store = require('./store');
const config = require('./config');
const events = require('./events');
const notes = require('./notes');
const tasks = require('./tasks');
const fts = require('./fts');
const { fail, posInt, line, b64u, text } = require('./util');

const MAX_PER_REF = 200;

async function owner(gc, ctx, kind, refId) {
  if (kind === 'note') { const n = await notes.access(gc, ctx, refId); return { encrypted: !!n.nb_vault, row: n, members: await notes.memberIds(gc, n.notebook_id) }; }
  if (kind === 'task') { const tk = await tasks.access(gc, ctx, refId); return { encrypted: false, row: tk, members: (await store.all(gc, 'SELECT user_id FROM list_members WHERE list_id = ?', [tk.list_id])).map((m) => m.user_id) }; }
  throw fail('invalid', { field: 'kind' });
}
/** 1.2.0: a member who may only look (role read) adds, removes and changes nothing. */
function writable(o) { if (o.row.my_role === 'read') throw fail('forbidden', { reason: 'read_only' }); return o; }

async function url(gc, ctx, a) {
  try { return await gc.media.url(a.media_id, { user: ctx.userId, ttlS: 3600 }); } catch { return null; }
}

async function view(gc, ctx, a, withUrl = true) {
  return {
    id: a.id, kind: a.kind, refId: a.ref_id, name: a.encrypted ? null : a.name, nameCipher: a.name_cipher || null, mime: a.mime, bytes: a.bytes,
    encrypted: !!a.encrypted, hasText: !!a.ocr, url: withUrl ? await url(gc, ctx, a) : null, createdAt: a.created_at,
  };
}

/** The attachments of a note or task (the caller checked access). */
async function listOf(gc, ctx, kind, refId) {
  const rows = await store.all(gc, 'SELECT * FROM attachments WHERE kind = ? AND ref_id = ? ORDER BY id LIMIT ?', [kind, refId, MAX_PER_REF]);
  const out = [];
  for (const a of rows) out.push(await view(gc, ctx, a));
  return out;
}

async function counts(gc, noteId) {
  const r = await store.one(gc, "SELECT SUM(CASE WHEN mime LIKE 'image/%' THEN 1 ELSE 0 END) AS img, COUNT(*) AS n FROM attachments WHERE kind = 'note' AND ref_id = ?", [noteId]);
  await store.run(gc, 'UPDATE notes SET images = ?, files = ? WHERE id = ?', [r.img || 0, (r.n || 0) - (r.img || 0), noteId]);
}

/** POST attachments { kind: 'note'|'task', refId, mediaId, name | nameCipher } → { attachment } */
async function add(gc, ctx, b, opts = {}) {
  const kind = b.kind;
  const o = writable(await owner(gc, ctx, kind, b.refId));
  if (typeof b.mediaId !== 'string' || !/^[0-9a-f]{32}$/.test(b.mediaId)) throw fail('invalid', { field: 'mediaId' });
  const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM attachments WHERE kind = ? AND ref_id = ?', [kind, o.row.id]);
  if (n.n >= MAX_PER_REF) throw fail('too_many');
  let name = '';
  if (o.encrypted) { if (!b64u(b.nameCipher, 80, 1500)) throw fail('invalid', { field: 'nameCipher' }); }
  else { name = line(b.name, 200); if (!name) throw fail('invalid', { field: 'name' }); }
  const info = await gc.media.info(b.mediaId);
  if (!info || (info.owner != null && info.owner !== ctx.userId)) throw fail('invalid', { field: 'mediaId' });
  const cfg = await config.get(gc);
  if (info.bytes > cfg.attach_mb * 1048576) { if (!info.claimed) await gc.media.delete(b.mediaId).catch(() => {}); throw fail('too_large', { maxMB: cfg.attach_mb }); }
  if (cfg.quota_mb > 0) {
    const used = await store.one(gc, 'SELECT COALESCE(SUM(bytes), 0) AS b FROM attachments INDEXED BY idx_attachments_owner WHERE created_by = ?', [ctx.userId]);
    if (used.b + info.bytes > cfg.quota_mb * 1048576) throw fail('quota', { usedBytes: used.b, quotaMB: cfg.quota_mb });
  }
  await gc.media.claim(b.mediaId);
  const r = await store.run(gc, 'INSERT INTO attachments (kind, ref_id, media_id, name, name_cipher, mime, bytes, encrypted, ext_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [kind, o.row.id, b.mediaId, name, o.encrypted ? b.nameCipher : null, o.encrypted ? 'application/octet-stream' : (info.mime || 'application/octet-stream'), info.bytes, o.encrypted ? 1 : 0, opts.extId || null, ctx.userId, ctx.now]);
  const id = Number(r.lastInsertRowid);
  if (kind === 'note') { await counts(gc, o.row.id); if (o.row.nb_bound) await notes.markBound(gc, o.row.notebook_id, o.row.id, false, ctx.now); }
  if (!opts.quiet) events.changed(gc, o.members, kind === 'note' ? 'notes' : 'tasks');
  return { attachment: await view(gc, ctx, await store.one(gc, 'SELECT * FROM attachments WHERE id = ?', [id])) };
}

async function accessOne(gc, ctx, id) {
  const a = await store.one(gc, 'SELECT * FROM attachments WHERE id = ?', [posInt(id) || 0]);
  if (!a) throw fail('not_found');
  const o = await owner(gc, ctx, a.kind, a.ref_id);
  return { a, o };
}

/** GET attachments/<id> → { attachment } (a fresh URL) */
async function get(gc, ctx, id) { const { a } = await accessOne(gc, ctx, id); return { attachment: await view(gc, ctx, a) }; }

/** DELETE attachments/<id> */
async function remove(gc, ctx, id) {
  const { a, o } = await accessOne(gc, ctx, id);
  writable(o);
  await store.run(gc, 'DELETE FROM attachments WHERE id = ?', [a.id]);
  await gc.media.delete(a.media_id).catch(() => {});
  if (a.kind === 'note') { await counts(gc, a.ref_id); await reindexNote(gc, a.ref_id); }
  events.changed(gc, o.members, a.kind === 'note' ? 'notes' : 'tasks');
  return { ok: true };
}

/** PUT attachments/<id>/text { text } — recognised text of a picture a device made (on-device OCR) → searchable. */
async function setText(gc, ctx, id, b) {
  const { a, o } = await accessOne(gc, ctx, id);
  writable(o);
  if (a.encrypted) throw fail('encrypted');
  const s = b && b.text === null ? null : text(b && b.text, 100000);
  await store.run(gc, 'UPDATE attachments SET ocr = ? WHERE id = ?', [s || null, a.id]);
  if (a.kind === 'note') await reindexNote(gc, a.ref_id);
  events.changed(gc, o.members, 'notes');
  return { ok: true };
}

async function reindexNote(gc, noteId) {
  const n = await store.one(gc, 'SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL', [noteId]);
  if (!n || n.title_cipher) return;
  const tagRows = await store.all(gc, 'SELECT tag FROM note_tags WHERE note_id = ?', [noteId]);
  const ocr = (await store.all(gc, "SELECT ocr FROM attachments WHERE kind = 'note' AND ref_id = ? AND ocr IS NOT NULL", [noteId])).map((r) => r.ocr).join('\n');
  await fts.setNote(gc, noteId, n.title, require('../ui/notemd').plain(n.body), tagRows.map((r) => r.tag), ocr);
}

/** mediaAccess hook: may this viewer read the file? Whoever sees its note or task. */
async function mayRead(gc, ctx, mediaId) {
  const a = await store.one(gc, 'SELECT * FROM attachments INDEXED BY idx_attachments_media WHERE media_id = ?', [mediaId]);
  if (!a) return false;
  try { await owner(gc, ctx, a.kind, a.ref_id); return true; } catch { return false; }
}

/** Purge: the files of notes / tasks deleted for good. */
async function purgeOf(gc, kind, refId) {
  for (const a of await store.all(gc, 'SELECT id, media_id FROM attachments WHERE kind = ? AND ref_id = ?', [kind, refId])) {
    await gc.media.delete(a.media_id).catch(() => {});
    await store.run(gc, 'DELETE FROM attachments WHERE id = ?', [a.id]);
  }
}

module.exports = { add, get, remove, setText, listOf, mayRead, purgeOf, view };
