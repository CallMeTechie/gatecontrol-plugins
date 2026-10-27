'use strict';

// Small shared helpers: API errors (code → HTTP status), input checks, times.

const STATUS = {
  invalid: 400,
  login_required: 403,
  forbidden: 403,
  no_seat: 403,
  not_licensed: 403,
  not_found: 404,
  exists: 409,
  conflict: 409,
  not_empty: 409,
  upload_invalid: 409,
  seat_limit: 409,
  seat_kind: 409,
  in_use: 409,
  links_disabled: 403,
  no_unlimited: 403,
  no_public_url: 409,
  quota: 507,
  internal: 500,
};

/** An API error: throw fail('conflict', { current }). */
function fail(code, extra) {
  return Object.assign(new Error(code), { code, extra: extra || null });
}

const isKnown = (e) => !!(e && typeof e.code === 'string' && STATUS[e.code] && e.code !== 'internal');

/** A positive integer from a number or a decimal string, else null. */
const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** A non-negative integer (0 allowed) from a number or a decimal string, else null. */
const nonNeg = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/** Single-line text: control characters removed, whitespace collapsed; null when not a string. */
function line(v) {
  if (typeof v !== 'string') return null;
  return v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
}

// A name of a file or folder: what a NAS (SMB / Windows) and every app can hold — no path separators, no
// control characters, none of < > : " | ? * , not "." / "..", no trailing dot or space, ≤ 255 characters.
const NAME_BAD_RE = /[\0-\x1f\x7f<>:"/\\|?*]/;
const RESERVED = new Set(['.gcdrive']);

/** A checked node name, else fail('invalid'). */
function nodeName(v) {
  if (typeof v !== 'string') throw fail('invalid', { field: 'name' });
  const s = v.normalize('NFC').trim();
  if (!s || s === '.' || s === '..' || s.length > 255 || NAME_BAD_RE.test(s) || /[. ]$/.test(s) || RESERVED.has(s.toLowerCase())) {
    throw fail('invalid', { field: 'name' });
  }
  return s;
}

/** "Brief.pdf" → "Brief (2).pdf", "Fotos" → "Fotos (2)". */
function numbered(name, n) {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && name.length - dot <= 16) return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
  return `${name} (${n})`;
}

const MEDIA_RE = /^[0-9a-f]{32}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const DEVICE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** ms → ISO-8601 UTC; null stays null. */
function iso(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  return new Date(Number(ms)).toISOString();
}

/** YYYY-MM-DD (UTC) of ms. */
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Recognised text of a document: control characters except line breaks removed, at most TEXT_MAX characters; null when empty or not a string. */
const TEXT_MAX = 100000;
function docText(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t ? t.slice(0, TEXT_MAX) : null;
}

module.exports = { STATUS, fail, isKnown, posInt, nonNeg, line, nodeName, numbered, MEDIA_RE, SHA_RE, DEVICE_RE, iso, day, docText, TEXT_MAX };
