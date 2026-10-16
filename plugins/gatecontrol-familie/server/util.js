'use strict';

// Small shared helpers: API errors, input checks, ISO times.

// API error code → HTTP status (docs: the "codes" table in CHANGELOG / B3)
const STATUS = {
  invalid: 400,
  state_required: 400,
  login_required: 403,
  forbidden: 403,
  not_member: 403,
  module_off: 403,
  parents_only: 403,
  read_only: 403,
  not_found: 404,
  adult: 409,
  locate_off: 409,
  not_pending: 409,
  too_many_places: 409,
  already_taken: 409,
  cancelled: 409,
  not_enough_stars: 409,
  no_star_rate: 409,
  no_consent: 409,
  too_many: 409,
  too_soon: 429,
  daily_limit: 429,
  internal: 500,
};

/** An API error: throw fail('too_soon', { retryAfter: 42 }). */
function fail(code, extra) {
  return Object.assign(new Error(code), { code, extra: extra || null });
}

const isKnown = (e) => !!(e && typeof e.code === 'string' && STATUS[e.code] && e.code !== 'internal');

const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Single-line text: control characters removed, whitespace collapsed; null when not a string. */
function line(v) {
  if (typeof v !== 'string') return null;
  return v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Multi-line text (notes): control characters except \n removed. */
function multiline(v) {
  if (typeof v !== 'string') return null;
  return v.replace(/\r\n?/g, '\n').replace(/[\0-\x09\x0b-\x1f\x7f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** A required single-line text of 1..max characters (else 'invalid'). */
function text(v, max) {
  const s = line(v);
  if (!s || s.length > max) throw fail('invalid');
  return s;
}

/** An optional single-line text (null/'' → null), at most max characters. */
function optText(v, max) {
  if (v == null) return null;
  const s = line(v);
  if (s == null || s.length > max) throw fail('invalid');
  return s || null;
}

function bool(v) {
  if (typeof v !== 'boolean') throw fail('invalid');
  return v;
}

function intIn(v, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw fail('invalid');
  return v;
}

function numIn(v, min, max) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw fail('invalid');
  return v;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
function time(v) {
  if (v == null) return null;
  if (typeof v !== 'string' || !TIME_RE.test(v)) throw fail('invalid');
  return v;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function validDate(s) {
  const m = DATE_RE.exec(String(s || ''));
  if (!m) return false;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3];
}
function date(v) {
  if (typeof v !== 'string' || !validDate(v)) throw fail('invalid');
  return v;
}

/** ms → "2026-10-14T12:00:00Z" (ISO-8601 UTC, whole seconds); null stays null. */
function iso(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  return new Date(Math.floor(Number(ms) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** ISO-8601 string → ms (null when invalid). */
function parseIso(v) {
  if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** A position from a request body: { lat, lon, accuracy } (all optional together); invalid → 'invalid'. */
function position(body, { required = false } = {}) {
  const has = body && (body.lat != null || body.lon != null);
  if (!has) {
    if (required) throw fail('invalid');
    return { lat: null, lon: null, accuracy: null };
  }
  const lat = numIn(body.lat, -90, 90);
  const lon = numIn(body.lon, -180, 180);
  const accuracy = body.accuracy == null ? null : Math.round(numIn(body.accuracy, 0, 100000) * 10) / 10;
  return { lat, lon, accuracy };
}

/** A list of user ids (unique, positive integers), at most `max`. */
function userIds(v, max = 50) {
  if (!Array.isArray(v) || v.length > max) throw fail('invalid');
  const out = [];
  for (const x of v) {
    const id = posInt(x);
    if (!id) throw fail('invalid');
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function parseJson(s, fallback) {
  if (typeof s !== 'string' || !s) return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
}

module.exports = {
  STATUS, fail, isKnown, posInt, line, multiline, text, optText, bool, intIn, numIn, time, date, validDate, iso, parseIso, position, userIds, parseJson, TIME_RE,
};
