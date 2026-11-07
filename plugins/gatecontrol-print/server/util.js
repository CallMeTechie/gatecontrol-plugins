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
  damaged: 409,
  printer_format: 409,
  gateway_update: 409,
  convert_off: 409,
  office_off: 409,
  office_missing: 409,
  ocr_unavailable: 409,
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
  ERR_PRINT_OCR_UNAVAILABLE: 'ocr_unavailable',
};
/**
 * Why GateControl cannot print a file (ERR_PRINT_FORMAT, `e.reason` since GateControl 1.243.0) → this plugin's code:
 * format (not a PDF or picture), damaged, printer_format (the printer takes no PDF and the gateway cannot convert for
 * it), gateway_update (… the gateway is too old to convert), convert_off (… converting is off on that gateway);
 * since GateControl 1.246.0 for office files: office_off („Office-Dateien drucken“ is off on the printer's gateway),
 * office_missing (on, but the gateway's service office does not run yet).
 */
const FORMAT_REASONS = { file_type: 'format', damaged: 'damaged', printer: 'printer_format', gateway_update: 'gateway_update', convert_off: 'convert_off', office_off: 'office_off', office_missing: 'office_missing' };
function formatCode(e) {
  if (e && typeof e.reason === 'string' && FORMAT_REASONS[e.reason]) return FORMAT_REASONS[e.reason];
  // an older GateControl names no reason – its message says which case it is
  const m = String((e && e.message) || '');
  if (/takes no PDF|neither JPEG nor PDF/.test(m)) return 'gateway_update';
  if (/not a (readable )?PDF|cannot be read/.test(m)) return 'damaged';
  return 'format';
}

function fromHost(e, dflt = 'print_failed') {
  if (isKnown(e)) return e;
  const code = e && e.code === 'ERR_PRINT_FORMAT' ? formatCode(e) : (e && HOST[e.code]);
  return fail(code || dflt, { message: e && e.message ? String(e.message).slice(0, 200) : null });
}

/** "2026-11-06" local date of a time */
function day(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Start of the local day of a time (ms) */
function dayStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

module.exports = { STATUS, fail, isKnown, posInt, clip, iso, bool, fromHost, formatCode, day, dayStart };
