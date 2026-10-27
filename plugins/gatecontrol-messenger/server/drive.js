'use strict';

// 1.10.0 — "In Drive speichern": the file of a message the viewer reads goes into their Drive (plugin gatecontrol-drive
// ≥ 1.4.0, service save_file; permissions.services "gatecontrol-drive:save_file" — the hand-over needs it too):
//   POST messages/:id/to-drive { folderId? }  → { saved: { nodeId, name, where } }
// The file is handed over first (gc.media.handOver: a copy for Drive, the chat keeps its own), then save_file runs for
// the viewer: into the folder they picked in an app (folderId, Drive's own API) or Meine Dateien › Messenger › <name>
// (renamed "Foto (2).jpg" when the name is taken). Drive checks the seat, the licence and the write access itself.
// GET me integrations.drive: Drive offers save_file right now (gc.services.available, GateControl ≥ 1.178.0).

const log = require('./log');
const messages = require('./messages');
const store = require('./store');
const { fail, posInt } = require('./util');

const PLUGIN = 'gatecontrol-drive';
const SERVICE = 'save_file';
const FOLDER = 'Messenger';
// per person — the messenger has 60 service calls an hour in all (Familie included)
const PER_HOUR = 20;
const HOUR = 3600000;
// Drive's answers passed on as they are (README "App-API" 1.10.0)
const DRIVE_CODES = ['invalid', 'forbidden', 'not_found', 'no_seat', 'not_licensed', 'quota', 'upload_invalid', 'exists'];
const NAME_BAD_RE = /[\0-\x1f\x7f<>:"/\\|?*]/g;
const NAME_MAX = 200;
const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/webm': 'webm',
  'video/mp4': 'mp4', 'application/pdf': 'pdf', 'application/zip': 'zip', 'text/plain': 'txt', 'text/csv': 'csv',
  'text/calendar': 'ics', 'text/vcard': 'vcf',
};
const WORD = {
  de: { image: 'Foto', voice: 'Sprachnachricht', file: 'Datei' },
  en: { image: 'Photo', voice: 'Voice message', file: 'File' },
};

let recent = new Map(); // viewer → [ms of the saves in the last hour]

function reset() { recent = new Map(); }

/** Would a save reach Drive right now? (never throws) */
async function available(gc) {
  if (!gc || !gc.services || typeof gc.services.available !== 'function' || typeof gc.services.call !== 'function') return false;
  if (!gc.media || typeof gc.media.handOver !== 'function') return false;
  try { return (await gc.services.available(PLUGIN, SERVICE)) === true; } catch { return false; }
}

/** A name Drive takes: no path or control characters, no dot or space at the end, ≤ 200 characters; else null. */
function cleanName(v) {
  if (typeof v !== 'string') return null;
  let s = v.normalize('NFC').replace(NAME_BAD_RE, '_').replace(/\s+/g, ' ').trim();
  if (s.length > NAME_MAX) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : '';
    s = s.slice(0, NAME_MAX - ext.length).trim() + ext;
  }
  s = s.replace(/[. ]+$/, '');
  return s && s !== '.' && s !== '..' && s.toLowerCase() !== '.gcdrive' ? s : null;
}

/** The file's name: the sender's file name, else "Foto 2026-10-17 12-00.jpg" (sent at, server time zone). */
function nameOf(ctx, row, mime) {
  const meta = messages.metaOf(row) || {};
  const given = cleanName(meta.fileName);
  if (given) return given;
  const d = new Date(row.created_at);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
  const words = WORD[ctx.lang === 'en' ? 'en' : 'de'];
  const ext = EXT[String(mime || '').toLowerCase()];
  return `${words[row.kind] || words.file} ${stamp}${ext ? '.' + ext : ''}`;
}

/** A host refusal (handOver, services.call) → the API code. */
function hostCode(e) {
  const c = e && e.code;
  if (c === 'ERR_RATE_LIMIT') return 'rate_limited';
  if (c === 'ERR_MEDIA_QUOTA') return 'quota';
  if (c === 'ERR_MEDIA_TYPE' || c === 'ERR_MEDIA_TOO_LARGE') return 'upload_invalid';
  return 'drive_unavailable';
}

/**
 * POST messages/:id/to-drive — `x` the viewer's access to the message's conversation (conversations.access).
 * → { saved: { nodeId, name, where } }
 */
async function save(ctx, x, id, body) {
  const gc = ctx.gc;
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  let folderId = null;
  if (b.folderId != null) {
    folderId = posInt(b.folderId);
    if (!folderId) throw fail('invalid');
  }
  // the same rule as downloading the file (mediaAccess): a message the viewer sees, not deleted, with its file
  const row = await messages.visibleMessage(ctx, x.me, id);
  if (row.deleted_at || !row.media_id || !['image', 'voice', 'file'].includes(row.kind)) throw fail('not_found');
  const m = await store.one(gc, 'SELECT mime, orphan FROM media WHERE media_id = ?', [row.media_id]);
  if (!m || m.orphan) throw fail('not_found');
  if (!(await available(gc))) throw fail('drive_unavailable');
  const now = ctx.now;
  const mine = (recent.get(ctx.viewer) || []).filter((t) => t > now - HOUR && t <= now);
  if (mine.length >= PER_HOUR) throw fail('rate_limited');
  mine.push(now);
  recent.set(ctx.viewer, mine);

  const name = nameOf(ctx, row, m.mime);
  let h;
  try {
    h = await gc.media.handOver(row.media_id, { toPlugin: PLUGIN, user: ctx.viewer });
  } catch (e) {
    const code = e && e.code === 'ERR_INVALID' ? 'not_found' : hostCode(e);
    if (code === 'drive_unavailable' || code === 'rate_limited') await log.add(gc, 'service_refused', `drive handOver: ${(e && e.code) || 'error'}`, now);
    throw fail(code);
  }
  const payload = folderId ? { mediaId: h.mediaId, folderId, name, onConflict: 'rename', lang: ctx.lang }
    : { mediaId: h.mediaId, area: 'mine', path: `${FOLDER}/${name}`, onConflict: 'rename', lang: ctx.lang };
  let r;
  try {
    r = await gc.services.call({ plugin: PLUGIN, service: SERVICE, userId: ctx.viewer, payload });
  } catch (e) {
    await log.add(gc, 'service_refused', `drive ${SERVICE}: ${(e && e.code) || 'error'}`, now);
    throw fail(hostCode(e));
  }
  if (!r || typeof r !== 'object' || r.ok !== true) {
    const code = r && typeof r.code === 'string' && DRIVE_CODES.includes(r.code) ? r.code : 'drive_unavailable';
    if (code === 'drive_unavailable') await log.add(gc, 'service_refused', `drive ${SERVICE}: ${String((r && r.code) || 'refused').slice(0, 40)}`, now);
    throw fail(code);
  }
  return {
    saved: {
      nodeId: r.nodeId == null ? null : r.nodeId,
      name: typeof r.name === 'string' ? r.name : name,
      where: typeof r.where === 'string' ? r.where : null,
    },
  };
}

module.exports = { save, available, reset, nameOf, cleanName, PLUGIN, SERVICE, PER_HOUR };
