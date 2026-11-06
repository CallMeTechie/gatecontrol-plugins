'use strict';

// Small shared helpers: API errors, input checks, ISO times.

// API error code → HTTP status (README "API")
const STATUS = {
  invalid: 400,
  forbidden: 403,
  no_right: 403,
  not_found: 404,
  limit: 409,
  format: 409,
  busy: 409,
  no_drive: 409,
  no_pages: 409,
  scan_running: 409,
  cert_changed: 409,
  too_large: 413,
  offline: 502,
  print_failed: 502,
  drive_failed: 502,
  internal: 500,
};

/** An API error: throw fail('limit', { left: 3 }). */
function fail(code, extra) {
  return Object.assign(new Error(code), { code, extra: extra || null });
}

const isKnown = (e) => !!(e && typeof e.code === 'string' && STATUS[e.code] && e.code !== 'internal');

const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Single-line text without control characters, at most `max` characters; '' for a non-string. */
function clip(v, max) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v) { const c = ch.codePointAt(0); out += c < 32 || c === 127 ? ' ' : ch; }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const bool = (v) => v === true || v === 1;

/** gc.print / host errors → this plugin's codes */
const HOST = {
  ERR_PRINT_FORMAT: 'format', ERR_PRINT_TOO_LARGE: 'too_large', ERR_PRINT_OFFLINE: 'offline', ERR_PRINT_BUSY: 'busy',
  ERR_NOT_FOUND: 'not_found', ERR_INVALID: 'invalid', ERR_PRINT_CERT_CHANGED: 'cert_changed', ERR_MEDIA_QUOTA: 'too_large',
};
function fromHost(e, dflt = 'print_failed') {
  if (isKnown(e)) return e;
  const code = e && HOST[e.code];
  return fail(code || dflt, { message: e && e.message ? String(e.message).slice(0, 200) : null });
}

/** "2026-11-06" local date of a time */
function day(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Start of the local day of a time (ms) */
function dayStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

module.exports = { STATUS, fail, isKnown, posInt, clip, iso, bool, fromHost, day, dayStart };
