'use strict';

// Small shared helpers: API errors (code → HTTP status), checks of the encrypted fields the apps send, ids, times.
//
// The server never decrypts anything, so it can only check shapes: base64url text whose decoded length fits the
// field (README "Kryptoformat"). That keeps garbage and oversized rows out without knowing a key.

const crypto = require('node:crypto');

const STATUS = {
  invalid: 400,
  login_required: 403,
  forbidden: 403,
  no_account: 404,
  not_found: 404,
  exists: 409,
  conflict: 409,
  stale_key: 409,
  rekeying: 409,
  last_manager: 409,
  limit: 409,
  rate_limited: 429,
  internal: 500,
};

/** An API error: throw fail('conflict', { current }). */
function fail(code, extra) {
  return Object.assign(new Error(code), { code, extra: extra || null });
}

const isKnown = (e) => !!(e && typeof e.code === 'string' && STATUS[e.code] && e.code !== 'internal');

const B64URL = /^[A-Za-z0-9_-]+$/;

/** Decoded byte length of base64url text without padding (null when it is none). */
function b64len(s) {
  if (typeof s !== 'string' || !s.length || !B64URL.test(s)) return null;
  const r = s.length % 4;
  if (r === 1) return null;
  return Math.floor(s.length / 4) * 3 + (r === 0 ? 0 : r - 1);
}

/**
 * Base64url text whose decoded length is within [min, max] bytes (exact when max omitted is min), else invalid.
 * Returns the text unchanged — the server stores what the app sent.
 */
function b64(v, min, max = min) {
  const n = b64len(v);
  if (n == null || n < min || n > max) throw fail('invalid');
  return v;
}

// Field sizes in bytes (decoded). Wrapped keys: 1 version byte + 24 nonce + 32 key + 16 tag = 73; with room to grow.
const SIZE = {
  salt: [16, 16],
  wrapped: [72, 200],        // a 32-byte key under XChaCha20-Poly1305 (+ version and nonce)
  publicKey: [32, 32],
  sealed: [80, 200],         // crypto_box_seal of a 32-byte key = 48 + 32
  name: [41, 1200],          // a vault name ≤ ~1 KB of text, encrypted
  blob: [41, 32768],         // one entry ≤ 32 KiB encrypted (an app request is ≤ 64 KB, README)
};

/** An id chosen by the app (vaults, entries): 16–40 of [A-Za-z0-9_-]. */
const ID_RE = /^[A-Za-z0-9_-]{16,40}$/;
function clientId(v) {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw fail('invalid');
  return v;
}

/** A positive integer from a number or a decimal string, else null. */
const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** A non-negative integer, else invalid. */
function nonNeg(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN);
  if (!Number.isSafeInteger(n) || n < 0) throw fail('invalid');
  return n;
}

/** Single-line text ≤ max characters (control characters removed) or null. */
function optLine(v, max) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw fail('invalid');
  const s = v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

const ROLES = ['read', 'write', 'manage'];
function role(v) {
  if (!ROLES.includes(v)) throw fail('invalid');
  return v;
}
const canWrite = (r) => r === 'write' || r === 'manage';

const newId = () => crypto.randomBytes(12).toString('hex');
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

module.exports = { STATUS, fail, isKnown, b64, b64len, SIZE, ID_RE, clientId, posInt, nonNeg, optLine, ROLES, role, canWrite, newId, iso };
