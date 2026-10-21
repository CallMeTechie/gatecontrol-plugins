'use strict';

// Small shared helpers: API errors (code → HTTP status), input checks, ISO times.

const STATUS = {
  invalid: 400,
  login_required: 403,
  forbidden: 403,
  not_admin: 403,
  not_sender: 403,
  managed: 403,
  readonly: 403,
  edit_window: 403,
  disappearing_off: 403,
  // 1.4.0
  blocked: 403,
  not_allowed: 403,
  feature_off: 403,
  not_found: 404,
  peer_unavailable: 409,
  deleted: 409,
  media_invalid: 409,
  media_in_use: 409,
  // 1.8.0 send_file: a handed-over file over 2 GB
  file_too_large: 409,
  too_many: 409,
  // 1.4.0
  closed: 409,
  no_approver: 409,
  unavailable: 409,
  action_failed: 409,
  // 1.6.0: the page "Wo Mitteilungen erscheinen" (portal/notify-routes, GateControl's gc.notify.routes)
  family_not_allowed: 403,
  locked: 409,
  no_sink: 409,
  routes_off: 409,
  rate_limited: 429,
  internal: 500,
};

/** An API error: throw fail('edit_window'). */
function fail(code, extra) {
  return Object.assign(new Error(code), { code, extra: extra || null });
}

const isKnown = (e) => !!(e && typeof e.code === 'string' && STATUS[e.code] && e.code !== 'internal');

/** A positive integer from a number or a decimal string (path segments, query), else null. */
const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Single-line text: control characters removed, whitespace collapsed; null when not a string. */
function line(v) {
  if (typeof v !== 'string') return null;
  return v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Message text: \r\n → \n, other control characters removed, at most 3 empty lines in a row, trimmed. */
function multiline(v) {
  if (typeof v !== 'string') return null;
  return v.replace(/\r\n?/g, '\n').replace(/[\0-\x08\x0b-\x1f\x7f]/g, '').replace(/\n{4,}/g, '\n\n\n').trim();
}

/** A required single-line text of 1..max characters. */
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

/** ms → ISO-8601 UTC with milliseconds; null stays null. */
function iso(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  return new Date(Number(ms)).toISOString();
}

/** ISO-8601 string → ms (null when invalid). */
function parseIso(v) {
  if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** A list of user ids (unique, positive integers), at most `max`. */
function userIds(v, max) {
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

module.exports = { STATUS, fail, isKnown, posInt, line, multiline, text, optText, bool, intIn, numIn, iso, parseIso, userIds, parseJson };
