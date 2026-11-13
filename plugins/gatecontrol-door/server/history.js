'use strict';

// History (own table, kept 90 days) and pictures (table media, kept 1–30
// days, default 7). Every action — also a refused or failed one — is a row:
// who, via (app / portal / notification / automation / system / nuki /
// keypad), what, result and the reason code. Rings and motion carry the
// snapshot (media_id) while it is kept. Ring mode switches (kind 'mode') name
// their location (location_id) and the mode (action).

const store = require('./store');
const { iso } = require('./util');
const { HISTORY_DAYS } = require('./config');

const DAY = 86400000;
// 1.7.2: media keeps the picture (data) in the row and expires_at BEHIND it — a statement that takes expires_at from
// the row reads through the whole picture (its overflow pages) to get there. So no list reads it there: the expired
// pictures come from the index media_expires alone (a few, the clean-up runs every hour), and a picture is "kept"
// when its id is not among them. Only media() reads a row with expires_at — it wants the picture anyway.
const EXPIRED = 'SELECT id FROM media INDEXED BY media_expires WHERE expires_at <= ?';
// pictures deleted per clean-up statement: deleting one reads and frees its pages (a statement may take 15 s in
// GateControl, also on a slow disk); more of them (the retention was shortened) follow with the next background runs
const PURGE_BATCH = 100;
const KINDS = ['action', 'ding', 'motion', 'alert', 'nuki', 'mode'];

/** Insert a row; a row with an ext_id that exists already is skipped (→ null). → id */
async function add(gc, row) {
  const r = await store.run(gc, `INSERT OR IGNORE INTO history (at, kind, lock_id, camera_id, user_id, user_name, via, caller, action, result, reason, media_id, ext_id, location_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    row.at, row.kind, row.lockId || null, row.cameraId || null, row.userId || null, row.userName || null, row.via || null, row.caller || null,
    row.action || null, row.result || null, row.reason || null, row.mediaId || null, row.extId || null, row.locationId || null,
  ]);
  return r && r.changes ? r.lastInsertRowid : null;
}

async function setMedia(gc, historyId, mediaId) {
  await store.run(gc, 'UPDATE history SET media_id = ? WHERE id = ?', [mediaId, historyId]);
}

/** Store a picture (Buffer) → media id. */
async function addMedia(gc, cameraId, buf, mime, now, days) {
  const r = await store.run(gc, 'INSERT INTO media (camera_id, at, mime, size, data, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [
    cameraId || null, now, mime, buf.length, { b64: buf.toString('base64') }, now + days * DAY,
  ]);
  return r.lastInsertRowid;
}

/** A picture (not expired) → { id, cameraId, at, mime, size, data (base64) } or null. */
async function media(gc, id, now) {
  if (!id) return null;
  const m = await store.one(gc, 'SELECT id, camera_id, at, mime, size, data FROM media WHERE id = ? AND expires_at > ?', [id, now]);
  if (!m || !m.data || typeof m.data.b64 !== 'string') return null;
  return { id: m.id, cameraId: m.camera_id, at: m.at, mime: m.mime, size: m.size, data: m.data.b64 };
}

/** The newest picture of a camera (not expired) or null. */
async function latestMedia(gc, cameraId, now) {
  const m = await store.one(gc, `SELECT id FROM media WHERE camera_id = ? AND id NOT IN (${EXPIRED}) ORDER BY at DESC, id DESC LIMIT 1`, [cameraId, now]);
  return m ? media(gc, m.id, now) : null;
}

/** When the newest kept picture of each camera was taken → Map(camera id → at); from the indexes, no picture is read. */
async function lastMediaAt(gc, now) {
  const rows = await store.all(gc, `SELECT c.id AS camera_id,
    (SELECT m.at FROM media m WHERE m.camera_id = c.id AND m.id NOT IN (${EXPIRED}) ORDER BY m.at DESC LIMIT 1) AS at FROM cameras c`, [now]);
  return new Map(rows.filter((r) => r.at != null).map((r) => [r.camera_id, r.at]));
}

/** Media ids that exist (not expired) among `ids` → Set */
async function existingMedia(gc, ids, now) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Set();
  const rows = await store.all(gc, `SELECT id FROM media WHERE id IN (${store.marks(list.length)}) AND id NOT IN (${EXPIRED})`, [...list, now]);
  return new Set(rows.map((r) => r.id));
}

/**
 * Rows for a viewer, newest first: filter = { all: true } or { userId, lockIds (all events of these
 * locks), ringLockIds (rings and motion of cameras linked to these locks), ringCameraIds (1.5.0: rings
 * and motion of these cameras without a lock) }; cursor = the last id seen.
 */
async function list(gc, filter, { cursor = null, limit = 30, lockId = null, kind = null } = {}) {
  const where = [];
  const params = [];
  if (cursor) { where.push('h.id < ?'); params.push(cursor); }
  if (lockId) { where.push('h.lock_id = ?'); params.push(lockId); }
  if (kind && KINDS.includes(kind)) { where.push('h.kind = ?'); params.push(kind); }
  if (!filter.all) {
    const or = ['h.user_id = ?'];
    params.push(filter.userId);
    if (filter.lockIds && filter.lockIds.length) { or.push(`h.lock_id IN (${store.marks(filter.lockIds.length)})`); params.push(...filter.lockIds); }
    if (filter.ringLockIds && filter.ringLockIds.length) {
      or.push(`(h.kind IN ('ding','motion') AND h.camera_id IN (SELECT id FROM cameras WHERE lock_id IN (${store.marks(filter.ringLockIds.length)})))`);
      params.push(...filter.ringLockIds);
    }
    // 1.5.0: cameras without a lock the viewer was given (only while they have no lock)
    if (filter.ringCameraIds && filter.ringCameraIds.length) {
      or.push(`(h.kind IN ('ding','motion') AND h.camera_id IN (SELECT id FROM cameras WHERE lock_id IS NULL AND id IN (${store.marks(filter.ringCameraIds.length)})))`);
      params.push(...filter.ringCameraIds);
    }
    where.push('(' + or.join(' OR ') + ')');
  }
  const rows = await store.all(gc, `SELECT h.* FROM history h ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY h.id DESC LIMIT ?`, [...params, limit + 1]);
  const more = rows.length > limit;
  return { rows: rows.slice(0, limit), nextCursor: more ? rows[limit - 1].id : null };
}

async function one(gc, id) {
  return store.one(gc, 'SELECT * FROM history WHERE id = ?', [id]);
}

/** A row for the API (names from the given maps; reasonText from t). */
function view(row, { locks, cameras, locations, t, lang, mediaOk }) {
  const lock = row.lock_id ? locks.get(row.lock_id) : null;
  const cam = row.camera_id ? cameras.get(row.camera_id) : null;
  const loc = row.location_id && locations ? locations.get(row.location_id) : null;
  return {
    id: row.id, at: iso(row.at), kind: row.kind,
    lockId: row.lock_id || null, lockName: lock ? lock.name : null,
    cameraId: row.camera_id || null, cameraName: cam ? cam.name : null,
    locationId: row.location_id || null, locationName: loc ? loc.name : null,
    userId: row.user_id || null, userName: row.user_name || null,
    via: row.via || null, caller: row.caller || null, action: row.action || null, result: row.result || null,
    reason: row.reason || null, reasonText: row.reason ? t(lang, 'reason.' + row.reason) : null,
    hasImage: !!(row.media_id && mediaOk && mediaOk.has(row.media_id)),
  };
}

/**
 * Retention: pictures after `mediaDays`, history after 90 days. → { more }: pictures are left for the next run.
 * The pictures to delete are found in the indexes media_expires and media_at (migration 008) — one statement with
 * "expires_at <= ? OR at < ?" went through the table and read every picture, every hour (1.7.2).
 */
async function purge(gc, now, mediaDays) {
  const a = await store.run(gc, `DELETE FROM media WHERE id IN (${EXPIRED} ORDER BY expires_at LIMIT ?)`, [now, PURGE_BATCH]);
  const b = await store.run(gc, 'DELETE FROM media WHERE id IN (SELECT id FROM media INDEXED BY media_at WHERE at < ? ORDER BY at LIMIT ?)', [now - mediaDays * DAY, PURGE_BATCH]);
  await store.run(gc, 'DELETE FROM history WHERE at < ?', [now - HISTORY_DAYS * DAY]);
  await store.run(gc, "DELETE FROM auto_runs WHERE at < ? AND status <> 'pending'", [now - 7 * DAY]);
  return { more: [a, b].some((r) => r && r.changes >= PURGE_BATCH) };
}

module.exports = { add, setMedia, addMedia, media, latestMedia, lastMediaAt, existingMedia, list, one, view, purge, KINDS, PURGE_BATCH };
