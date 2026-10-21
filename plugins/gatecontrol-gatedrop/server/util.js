'use strict';

// Small shared helpers: API errors (code → HTTP status), input checks, ids, times.

const crypto = require('node:crypto');

const STATUS = {
  invalid: 400,
  login_required: 403,
  forbidden: 403,
  not_found: 404,
  gone: 410,
  upload_required: 409,
  links_disabled: 409,
  no_public_url: 409,
  unavailable: 409,
  media_invalid: 409,
  media_in_use: 409,
  no_device: 409,
  closed: 409,
  rate_limited: 429,
  internal: 500,
};

/** An API error: throw fail('upload_required'). */
function fail(code, extra) {
  return Object.assign(new Error(code), { code, extra: extra || null });
}

const isKnown = (e) => !!(e && typeof e.code === 'string' && STATUS[e.code] && e.code !== 'internal');

/** A positive integer from a number or a decimal string, else null. */
const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Single-line text: control characters removed, whitespace collapsed; null when not a string. */
function line(v) {
  if (typeof v !== 'string') return null;
  return v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Multi-line text: \r\n → \n, other control characters removed, trimmed; null when not a string. */
function multiline(v) {
  if (typeof v !== 'string') return null;
  return v.replace(/\r\n?/g, '\n').replace(/[\0-\x08\x0b-\x1f\x7f]/g, '').trim();
}

/** An optional single-line text (null/'' → null), at most max characters, else invalid. */
function optLine(v, max) {
  if (v == null || v === '') return null;
  const s = line(v);
  if (s == null || s.length > max) throw fail('invalid');
  return s || null;
}

/** An optional multi-line text, at most max characters, else invalid. */
function optText(v, max) {
  if (v == null || v === '') return null;
  const s = multiline(v);
  if (s == null || s.length > max) throw fail('invalid');
  return s || null;
}

/** A file name as shown and stored: no path, no control characters, ≤ 200 characters (the extension kept). */
function fileName(v) {
  let s = typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]/g, '').split(/[\\/]/).pop().trim() : '';
  s = s.replace(/^\.+/, '').trim();
  if (s.length > 200) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : '';
    s = s.slice(0, 200 - ext.length) + ext;
  }
  return s || null;
}

/** An http(s) URL of at most 2048 characters, else invalid. */
function url(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > 2048) throw fail('invalid');
  let u;
  try { u = new URL(v.trim()); } catch { throw fail('invalid'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw fail('invalid');
  return u.toString();
}

/** A new id: 24 hex characters (12 random bytes). */
const newId = () => crypto.randomBytes(12).toString('hex');
const ID_RE = /^[0-9a-f]{24}$/;
const MEDIA_RE = /^[0-9a-f]{32}$/;
const DEVICE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** ms → ISO-8601 UTC; null stays null. */
function iso(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  return new Date(Number(ms)).toISOString();
}

function parseJson(s, fallback) {
  if (typeof s !== 'string' || !s) return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
}

module.exports = { STATUS, fail, isKnown, posInt, line, multiline, optLine, optText, fileName, url, newId, iso, parseJson, ID_RE, MEDIA_RE, DEVICE_RE };
