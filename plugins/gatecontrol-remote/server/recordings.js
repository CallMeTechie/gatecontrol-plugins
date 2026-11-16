'use strict';

// Recordings (1.2, gc.remote version 3): GateControl records a session when the plugin asks for it
// (connect.js decideRecording) and keeps the file encrypted on its drive; the plugin lists them,
// decides who may watch — administrators, and the owner of the device (a PC of the app) — and
// deletes them (by hand, and after `recordingDays`). Watching: gc.remote.recordings.stream(id,
// { user }) → a single-use ticket of GateControl's session page for exactly that person; every
// opened playback comes back as the event recording_viewed (history.onEvent → the protocol).

const devices = require('./devices');
const history = require('./history');
const log = require('./log');
const { fail, fromHost, posInt } = require('./util');

const ID_RE = /^rr_[0-9a-f]{32}$/;

function v3(gc) { return !!(gc.remote && gc.remote.version >= 3 && gc.remote.recordings && typeof gc.remote.recordings.list === 'function'); }

async function namesOf(gc) {
  const m = new Map();
  try { for (const u of (await gc.users.list()) || []) m.set(u.id, u.name); } catch { /* names stay empty */ }
  return m;
}

/** May this person watch recordings of this device? Administrators always; else the owner of a PC. */
function mayWatch(user, d, { admin = false } = {}) {
  if (admin || (user && user.role === 'admin')) return true;
  return !!(d && d.host && user && d.host.owner === user.id);
}

/**
 * The recordings → [{ id, deviceId, deviceName, userId, userName, protocol, format, status, startedAt, durationSeconds, bytes }]
 * o.deviceId, o.limit (≤ 200); a non-administrator sees the recordings of own devices only.
 */
async function list(gc, user, o = {}, { admin = false } = {}) {
  if (!v3(gc)) return [];
  const limit = Math.min(200, posInt(o.limit) || 100);
  const dev = o.deviceId == null || o.deviceId === '' ? null : posInt(o.deviceId);
  if (o.deviceId != null && o.deviceId !== '' && !dev) throw fail('invalid', { field: 'device' });
  let rows;
  try { rows = (await gc.remote.recordings.list({ ...(dev ? { targetId: 'dev-' + dev } : {}), limit: admin ? limit : 500 })) || []; } catch (e) { throw fromHost(e); }
  const all = new Map((await devices.all(gc)).map((d) => [d.id, d]));
  const names = await namesOf(gc);
  const out = [];
  for (const r of rows) {
    const id = history.devIdOf(r.targetId);
    const d = id ? all.get(id) : null;
    if (!mayWatch(user, d, { admin })) continue;
    out.push({ id: r.id, deviceId: id, deviceName: d ? d.name : null, userId: r.userId || null, userName: r.userId ? (names.get(r.userId) || null) : null,
      protocol: r.protocol || null, format: r.format || null, status: r.status || 'ready', startedAt: r.startedAt || r.createdAt || null,
      durationSeconds: r.durationSeconds == null ? null : r.durationSeconds, bytes: r.bytes || 0 });
    if (out.length >= limit) break;
  }
  return out;
}

async function rowOf(gc, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('not_found');
  let rows;
  try { rows = (await gc.remote.recordings.list({ limit: 500 })) || []; } catch (e) { throw fromHost(e); }
  const r = rows.find((x) => x.id === id);
  if (!r) throw fail('not_found');
  return r;
}

/** POST recordings/<id>/play → { ref, url, expiresAt, format } — for this person only (GC.openSession(ref) in the frame). */
async function play(gc, user, id, { admin = false } = {}) {
  if (!v3(gc)) throw fail('offline');
  const r = await rowOf(gc, id);
  const d = await devices.get(gc, history.devIdOf(r.targetId));
  if (!mayWatch(user, d, { admin })) throw fail('not_found');
  try {
    const s = await gc.remote.recordings.stream(r.id, { user: user.id });
    return { ref: s.ref, url: s.url, expiresAt: s.expiresAt, format: s.format || r.format };
  } catch (e) { throw fromHost(e); }
}

/** DELETE admin/recordings/<id> → { removed } (administrators; protocol remote_recording_deleted). */
async function remove(gc, user, id, reason = 'admin') {
  if (!v3(gc)) throw fail('offline');
  const r = await rowOf(gc, id);
  let out;
  try { out = await gc.remote.recordings.remove(r.id); } catch (e) { throw fromHost(e); }
  if (out && out.removed) {
    const d = await devices.get(gc, history.devIdOf(r.targetId));
    await log.write(gc, 'remote_recording_deleted', { device: d, userId: user ? user.id : null, details: { recording: r.id, reason } });
  }
  return { removed: !!(out && out.removed) };
}

/** Hourly: recordings older than `days` go (GateControl's own limit holds as well). */
async function purge(gc, days, now = Date.now()) {
  if (!v3(gc)) return 0;
  let rows;
  try { rows = (await gc.remote.recordings.list({ limit: 500 })) || []; } catch { return 0; }
  let n = 0;
  for (const r of rows) {
    const at = Date.parse(r.createdAt || r.startedAt || '');
    if (!Number.isFinite(at) || now - at < days * 86400000 || r.status === 'recording' || r.status === 'sealing') continue;
    try {
      const x = await gc.remote.recordings.remove(r.id);
      if (x && x.removed) {
        n++;
        await log.write(gc, 'remote_recording_deleted', { device: await devices.get(gc, history.devIdOf(r.targetId)), details: { recording: r.id, reason: 'retention' } }, now);
      }
    } catch (e) { gc.log.debug('recording not purged', (e && e.code) || 'error'); }
  }
  return n;
}

module.exports = { list, play, remove, purge, mayWatch, ID_RE };
