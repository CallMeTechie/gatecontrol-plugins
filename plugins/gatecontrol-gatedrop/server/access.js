'use strict';

// Who may send to an app installation — set on the device itself (GET/PUT device):
//   self      only its owner (default; also without a row)
//   everyone  every account of this GateControl: the device appears in their GET targets (`peopleDevices`, with
//             its owner) and takes their sends like the owner's own — directly in the same Wi-Fi or through the server.
// Kiosk accounts never send (index.js) and their devices are never listed for others.

const store = require('./store');
const people = require('./people');
const { fail } = require('./util');

const MODES = ['self', 'everyone'];

/** The mode of `deviceId` as its owner `userId` set it → 'self' | 'everyone'. */
async function modeOf(gc, deviceId, userId) {
  if (!deviceId) return 'self';
  const r = await store.one(gc, 'SELECT user_id, mode FROM device_access WHERE device_id = ?', [deviceId]);
  return r && r.user_id === userId && r.mode === 'everyone' ? 'everyone' : 'self';
}

/** GET device → { id, receiveFrom } of the asking app installation. */
async function get(ctx) {
  if (!ctx.deviceId) throw fail('no_device');
  return { id: ctx.deviceId, receiveFrom: await modeOf(ctx.gc, ctx.deviceId, ctx.viewer) };
}

/** PUT device { receiveFrom: 'self' | 'everyone' } → { id, receiveFrom } */
async function put(ctx, body) {
  if (!ctx.deviceId) throw fail('no_device');
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b || !MODES.includes(b.receiveFrom)) throw fail('invalid');
  await store.run(ctx.gc, `INSERT INTO device_access (device_id, user_id, mode, at) VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET user_id = excluded.user_id, mode = excluded.mode, at = excluded.at`,
  [ctx.deviceId, ctx.viewer, b.receiveFrom, ctx.now]);
  return { id: ctx.deviceId, receiveFrom: b.receiveFrom };
}

/**
 * Other people's devices open for everyone, as `viewer` may send to them: still theirs (gc.devices.list), no web
 * client, their owner a known account and no kiosk device → [{ id, name, platform, online, …, owner: { id, name } }]
 */
async function openDevices(gc, viewer, users, kiosk) {
  const rows = await store.all(gc, "SELECT device_id, user_id FROM device_access WHERE mode = 'everyone' AND user_id != ? ORDER BY user_id, device_id", [viewer]);
  const byUser = new Map();
  for (const r of rows) {
    if (!users.has(r.user_id) || kiosk.has(r.user_id)) continue;
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, new Set());
    byUser.get(r.user_id).add(r.device_id);
  }
  const out = [];
  for (const [uid, ids] of byUser) {
    const u = users.get(uid);
    for (const d of await people.devicesOf(gc, uid)) {
      if (ids.has(d.id)) out.push({ ...d, owner: { id: uid, name: u.name || null } });
    }
  }
  return out.sort((a, b) => String(a.owner.name).localeCompare(String(b.owner.name), 'de') || String(a.name).localeCompare(String(b.name), 'de'));
}

/** Is `deviceId` someone else's device that was open for everyone and is closed now? (→ 'unavailable' instead of 'invalid') */
async function closedForOthers(gc, deviceId, viewer) {
  const r = await store.one(gc, 'SELECT user_id, mode FROM device_access WHERE device_id = ?', [deviceId]);
  return !!r && r.user_id !== viewer && r.mode !== 'everyone';
}

module.exports = { MODES, modeOf, get, put, openDevices, closedForOthers };
