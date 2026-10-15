'use strict';

// Small shared helpers: API errors, input checks, ISO times.

// API error code → HTTP status (README "API", table of codes)
const STATUS = {
  invalid: 400,
  ring_bad_code: 400,
  read_only: 403,
  forbidden: 403,
  no_right: 403,
  outside_window: 403,
  not_found: 404,
  no_image: 404,
  unsupported: 409,
  not_configured: 409,
  no_target: 409,
  nuki_auth: 409,
  ring_not_connected: 409,
  ring_login_failed: 409,
  too_many: 409,
  rate_limited: 429,
  too_soon: 429,
  ring_rate_limited: 429,
  lock_unreachable: 502,
  lock_failed: 502,
  nuki_error: 502,
  ring_error: 502,
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

/** A required single-line text of 1..max characters (else 'invalid'). */
function text(v, max) {
  const s = line(v);
  if (!s || s.length > max) throw fail('invalid');
  return s;
}

function bool(v) {
  if (typeof v !== 'boolean') throw fail('invalid');
  return v;
}

function intIn(v, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw fail('invalid');
  return v;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
function time(v) {
  if (typeof v !== 'string' || !TIME_RE.test(v)) throw fail('invalid');
  return v;
}

/** ms → "2026-10-14T12:00:00Z" (ISO-8601 UTC, whole seconds); null stays null. */
function iso(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  return new Date(Math.floor(Number(ms) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseJson(s, fallback) {
  if (typeof s !== 'string' || !s) return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
}

/** Cut a text to max characters (quick action titles, push texts). */
function clip(s, max) {
  const v = String(s == null ? '' : s).replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return v.length > max ? v.slice(0, max - 1).trimEnd() + '…' : v;
}

/** A sliding-window counter per key: hit(key, now) → true when allowed (and counted). */
function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return {
    hit(key, now = Date.now()) {
      const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (list.length >= limit) { hits.set(key, list); return false; }
      list.push(now);
      hits.set(key, list);
      if (hits.size > 5000) hits.clear();
      return true;
    },
    retryAfter(key, now = Date.now()) {
      const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
      return list.length < limit ? 0 : Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000));
    },
    reset() { hits.clear(); },
  };
}

module.exports = { STATUS, fail, isKnown, posInt, line, text, bool, intIn, time, iso, parseJson, clip, rateLimiter, TIME_RE };
