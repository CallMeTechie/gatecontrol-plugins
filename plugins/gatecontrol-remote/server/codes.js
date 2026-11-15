'use strict';

// The code a PC shows (stage 2): nine digits in three groups (482-913-075) from crypto.randomInt, bound to one PC,
// valid for at most 10 minutes and exactly once. Only an HMAC is stored (key: a secret of the plugin), never the
// digits. A new code replaces the old one; the app fetches a new one after every session and when one runs out.
//
// Guessing: 5 wrong codes in 10 minutes per person → 15 minutes pause (code_locked); 30 attempts per hour for the
// whole server (rate_limited); 10 wrong codes aimed at one PC (the portal names the PC) → its code is void and
// the PC is told to fetch a new one. Every attempt goes into the protocol.

const crypto = require('node:crypto');
const store = require('./store');
const log = require('./log');
const { fail } = require('./util');

const KEY = 'remote.code_key';
const TTL_MS = 10 * 60000;
const LIMITS = Object.freeze({ perUser: 5, perUserWindowMs: 10 * 60000, lockMs: 15 * 60000, perServerHour: 30, perDevice: 10 });

let keyCache = null;
function reset() { keyCache = null; }

async function key(gc) {
  if (keyCache) return keyCache;
  let k = null;
  try { k = await gc.settings.get(KEY); } catch { k = null; }
  if (typeof k !== 'string' || !/^[0-9a-f]{64}$/.test(k)) {
    k = crypto.randomBytes(32).toString('hex');
    await gc.settings.setSecret(KEY, k);
  }
  keyCache = k;
  return k;
}

const hmac = (k, digits) => crypto.createHmac('sha256', Buffer.from(k, 'hex')).update('gc-remote-code:' + digits).digest('hex');
const format = (digits) => digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6, 9);

/** "482 913 075", "482-913-075", "482913075" → '482913075' | null */
function digitsOf(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/[\s.-]/g, '');
  return /^\d{9}$/.test(s) ? s : null;
}

/** A new code for the PC → { code, expiresAt } (replaces the old one). */
async function issue(gc, deviceId, now = Date.now()) {
  const k = await key(gc);
  for (let i = 0; i < 5; i++) {
    const digits = String(crypto.randomInt(0, 1000000000)).padStart(9, '0');
    const h = hmac(k, digits);
    try {
      await store.tx(gc, async () => {
        await store.run(gc, 'DELETE FROM codes WHERE device_id = ?', [deviceId]);
        await store.run(gc, 'INSERT INTO codes (device_id, hmac, created_at, expires_at, used_at, failures) VALUES (?, ?, ?, ?, NULL, 0)', [deviceId, h, now, now + TTL_MS]);
      });
      return { code: format(digits), expiresAt: new Date(now + TTL_MS).toISOString() };
    } catch (e) {
      // the same HMAC as another PC's code (one in a billion): draw again
      if (!/UNIQUE/i.test(String(e && e.message))) throw e;
    }
  }
  throw fail('internal');
}

/** Is the person paused (5 wrong codes within 10 minutes, then 15 minutes)? */
async function locked(gc, userId, now) {
  const rows = await store.all(gc, 'SELECT at FROM code_attempts WHERE user_id = ? AND ok = 0 AND at > ? ORDER BY at DESC',
    [userId, now - LIMITS.lockMs - LIMITS.perUserWindowMs]);
  if (rows.length < LIMITS.perUser) return false;
  const last = rows[0].at;
  if (now - last >= LIMITS.lockMs) return false;
  return rows.filter((r) => r.at > last - LIMITS.perUserWindowMs).length >= LIMITS.perUser;
}

async function attempt(gc, userId, deviceId, ok, now) {
  await store.run(gc, 'INSERT INTO code_attempts (user_id, device_id, ok, at) VALUES (?, ?, ?, ?)', [userId, deviceId || null, ok ? 1 : 0, now]);
}

/**
 * Check a code a helper typed → the device id it opens, after the limits. `deviceId` (optional): the PC the helper
 * picked — then the code must be that PC's, and wrong codes count against it. `onVoid(deviceId)` when a PC's code
 * became void (10 wrong codes on it). Throws code_invalid / code_locked / rate_limited.
 */
async function check(gc, user, input, { deviceId = null, deviceOf, onVoid } = {}, now = Date.now()) {
  if (await locked(gc, user.id, now)) throw fail('code_locked');
  const hour = await store.one(gc, 'SELECT COUNT(*) AS n FROM code_attempts WHERE at > ?', [now - 3600000]);
  if (hour && hour.n >= LIMITS.perServerHour) throw fail('rate_limited');
  const digits = digitsOf(input);
  const row = digits ? await store.one(gc, 'SELECT * FROM codes WHERE hmac = ?', [hmac(await key(gc), digits)]) : null;
  const good = row && row.used_at == null && row.expires_at > now && (!deviceId || row.device_id === deviceId);
  if (!good) {
    await attempt(gc, user.id, deviceId, false, now);
    const dev = deviceId && deviceOf ? await deviceOf(deviceId) : null;
    await log.write(gc, 'remote_code_failed', { device: dev, userId: user.id }, now);
    if (deviceId) {
      const r = await store.run(gc, 'UPDATE codes SET failures = failures + 1 WHERE device_id = ? AND used_at IS NULL', [deviceId]);
      const c = r && r.changes ? await store.one(gc, 'SELECT failures FROM codes WHERE device_id = ?', [deviceId]) : null;
      if (c && c.failures >= LIMITS.perDevice) {
        await store.run(gc, 'DELETE FROM codes WHERE device_id = ?', [deviceId]);
        if (onVoid) await onVoid(deviceId);
      }
    }
    if (await locked(gc, user.id, now)) throw fail('code_locked');
    throw fail('code_invalid');
  }
  // used: exactly once
  const used = await store.run(gc, 'UPDATE codes SET used_at = ? WHERE device_id = ? AND hmac = ? AND used_at IS NULL', [now, row.device_id, row.hmac]);
  if (!used || !used.changes) { await attempt(gc, user.id, row.device_id, false, now); throw fail('code_invalid'); }
  await attempt(gc, user.id, row.device_id, true, now);
  return row.device_id;
}

/** Old attempts and used or run-out codes go (the background, hourly). */
async function purge(gc, now = Date.now()) {
  await store.run(gc, 'DELETE FROM code_attempts WHERE at < ?', [now - 86400000]);
  await store.run(gc, 'DELETE FROM codes WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)', [now - 3600000, now - 3600000]);
}

module.exports = { issue, check, purge, digitsOf, format, reset, LIMITS, TTL_MS, KEY, _hmac: hmac };
