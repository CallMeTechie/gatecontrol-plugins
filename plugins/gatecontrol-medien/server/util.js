'use strict';

// Small helpers: errors with a code and an HTTP status, input cleaning, ids.

const crypto = require('node:crypto');

const STATUS = {
  invalid: 400, no_device: 400, forbidden: 403, no_access: 403, license_required: 403, not_found: 404,
  no_mapping: 409, quick_connect_off: 409, admin_user: 409, user_disabled: 409, not_configured: 409, device_mismatch: 409,
  conflict: 409, name_taken: 409, away_address_required: 422, code_invalid: 422, too_large: 413, rate_limited: 429,
  jellyfin_unreachable: 502, jellyfin_error: 502, key_invalid: 502, internal: 500,
};

/** An error the API answers as { ok: false, code } (`extra` lands in the answer, e.g. a field name). */
function fail(code, extra) {
  const e = new Error(code);
  e.code = code;
  e.known = true;
  if (extra) e.extra = extra;
  return e;
}
const isKnown = (e) => !!(e && e.known && Object.prototype.hasOwnProperty.call(STATUS, e.code));

/** A one-line text without control characters, at most `max` characters ('' for anything else). */
const str = (v, max = 200) => (typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const DEVICE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const deviceIdOf = (v) => {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
  return typeof s === 'string' && DEVICE_RE.test(s) ? s : null;
};
const SOURCE_RE = /^(jf|sh)-[1-9][0-9]{0,8}$/;
const sourceIdOf = (v) => (typeof v === 'string' && SOURCE_RE.test(v) ? v : null);

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** 20 characters [0-9A-Za-z] from a key and a text (stable). */
function b62(key, text, len = 20) {
  const h = crypto.createHmac('sha256', key).update(text).digest();
  let out = '';
  for (let i = 0; out.length < len; i++) out += B62[h[i % h.length] % 62];
  return out;
}

/** "http(s)://host[:port][/path]" without user info, query or fragment → normalised, else null. */
function httpUrl(v, { https = false } = {}) {
  const s = str(v, 300);
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && (https || u.protocol !== 'http:')) return null;
  if (u.username || u.password || u.search || u.hash || !u.hostname) return null;
  return (u.protocol + '//' + u.host + u.pathname).replace(/\/+$/, '');
}

/** "smb://host[:port]/share[/folder]" (also \\host\share) → normalised, else null. */
function smbUrl(v) {
  let s = str(v, 300);
  if (!s) return null;
  if (s.startsWith('\\\\')) s = 'smb://' + s.slice(2).replace(/\\/g, '/');
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'smb:' || u.username || u.password || u.search || u.hash || !u.hostname) return null;
  const p = u.pathname.replace(/\/+$/, '');
  if (!p || p === '/' || p.split('/').some((x, i) => i > 0 && (x === '' || x === '.' || x === '..'))) return null;
  const port = u.port && u.port !== '445' ? ':' + u.port : '';
  return 'smb://' + u.hostname.toLowerCase() + port + p;
}

/** The last folder of an address, lower case ("filme"). */
function folderOf(addr) {
  if (!addr) return null;
  try { const p = new URL(addr).pathname.split('/').filter(Boolean); return p.length ? decodeURIComponent(p[p.length - 1]).toLowerCase() : null; } catch { return null; }
}

/** SHA-256 of a certificate as 64 hex characters (colons and case ignored), else null. */
function sha256Hex(v) {
  const s = str(v, 200).replace(/[:\s]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

function json(v, fallback) {
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

module.exports = { STATUS, fail, isKnown, str, posInt, deviceIdOf, sourceIdOf, b62, httpUrl, smbUrl, folderOf, sha256Hex, iso, json };
