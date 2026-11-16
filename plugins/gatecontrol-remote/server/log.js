'use strict';

// The protocol of the sharing (stage 2): codes, requests, "Ohne Code", the firewall per session — since 1.2 also
// the viewings and deletions of recordings, changed or reset SSH host keys and the switch of SSH devices to the
// terminal. The admin page
// Sitzungen shows it under the filter "Freigaben"; the person at a PC sees the entries of their own PCs in the
// profile section. Never a code, never a person's address.

const store = require('./store');
const { iso, posInt } = require('./util');

const TYPES = ['remote_code_redeemed', 'remote_code_failed', 'remote_share_changed', 'remote_request_allowed', 'remote_request_denied',
  'remote_request_expired', 'remote_firewall_open', 'remote_firewall_close', 'remote_host_registered', 'remote_host_removed',
  // 1.2: recordings and SSH host keys
  'remote_recording_viewed', 'remote_recording_deleted', 'remote_host_key_changed', 'remote_host_key_reset', 'remote_ssh_engine_changed',
  // 1.3: the screen of a phone
  'remote_screen_started', 'remote_screen_ended'];

/** One entry: write(gc, 'remote_code_redeemed', { device, userId, details }) — best-effort, never throws. */
async function write(gc, type, { device = null, userId = null, details = null } = {}, now = Date.now()) {
  if (!TYPES.includes(type)) return;
  try {
    await store.run(gc, 'INSERT INTO share_log (at, type, device_id, device_name, owner_user_id, user_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [now, type, device ? device.id : null, device ? String(device.name || '').slice(0, 120) : null, device && device.host ? device.host.owner : null,
        userId || null, details ? JSON.stringify(details).slice(0, 1000) : null]);
  } catch (e) { gc.log.debug('share log not written', (e && e.code) || 'error'); }
}

function parse(s) { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch { return null; } }

/** The newest entries: { ownerUserId?, deviceId?, before?, limit ≤ 200 } → [{ id, at, type, deviceId, deviceName, userId, userName, details }] */
async function list(gc, o = {}) {
  const where = [];
  const p = [];
  if (posInt(o.ownerUserId)) { where.push('owner_user_id = ?'); p.push(posInt(o.ownerUserId)); }
  if (posInt(o.deviceId)) { where.push('device_id = ?'); p.push(posInt(o.deviceId)); }
  if (posInt(o.before)) { where.push('id < ?'); p.push(posInt(o.before)); }
  const limit = Math.min(200, posInt(o.limit) || 100);
  const rows = await store.all(gc, `SELECT * FROM share_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`, p);
  const names = new Map();
  try { for (const u of (await gc.users.list()) || []) names.set(u.id, u.name); } catch { /* names stay empty */ }
  return rows.map((r) => ({ id: r.id, at: iso(r.at), type: r.type, deviceId: r.device_id, deviceName: r.device_name, userId: r.user_id,
    userName: r.user_id ? (names.get(r.user_id) || null) : null, details: parse(r.details) }));
}

async function purge(gc, days, now = Date.now()) {
  const r = await store.run(gc, 'DELETE FROM share_log WHERE at < ?', [now - days * 86400000]);
  return (r && r.changes) || 0;
}

module.exports = { write, list, purge, TYPES };
