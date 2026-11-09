'use strict';

// Small helpers: refusals with a code (the API answers them as { status, json: { ok: false, code, … } }), input checks.

const AREAS = ['private', 'work'];
const COLORS = ['none', 'yellow', 'green', 'blue', 'pink', 'grey', 'orange', 'purple', 'red', 'teal'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const STATUS = {
  invalid: 400, forbidden: 403, not_found: 404, conflict: 409, too_many: 409, encrypted: 409, quota: 507, not_member: 409,
  unavailable: 503, consent_required: 409, not_allowed: 403, busy: 429, too_large: 413, stale_key: 409,
  unknown_client_id: 409, gone: 410,
};

/** An Error the API turns into an answer: fail('invalid', { field: 'title' }). */
function fail(code, extra) {
  const e = new Error(code);
  e.code = code;
  e.extra = extra || null;
  e.known = true;
  return e;
}
const isKnown = (e) => !!(e && e.known);
const statusOf = (code) => STATUS[code] || 400;

const posInt = (v) => { const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v; return Number.isSafeInteger(n) && n > 0 ? n : null; };

/** One line of text: control characters out, white space folded, cut to `max`. */
function line(v, max = 200) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
/** A text with line breaks (notes): control characters except \n and \t out, cut to `max`. */
function text(v, max = 100000) {
  if (typeof v !== 'string') return '';
  return v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max);
}
function parse(s, dflt) { if (typeof s !== 'string' || !s) return dflt; try { return JSON.parse(s); } catch { return dflt; } }
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const isTime = (v) => typeof v === 'string' && TIME_RE.test(v);
const area = (v, dflt = 'private') => (AREAS.includes(v) ? v : dflt);
const color = (v) => (v == null || v === '' ? null : COLORS.includes(v) ? (v === 'none' ? null : v) : undefined);
const bool = (v) => v === true || v === 1 || v === 'true' || v === '1';
const B64U_RE = /^[A-Za-z0-9_-]+$/;
const b64u = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && B64U_RE.test(v);

/** A value in one canonical form (objects with sorted keys, undefined as null) to compare two of them. */
function canon(v) {
  if (v === undefined || v === null) return 'null';
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const same = (a, b) => canon(a) === canon(b);

/**
 * A change with `base` (1.1.0: the values the device saw before it changed them): the fields someone else changed
 * meanwhile to something else than this change — `now[f]` differs from `base[f]` and from `next[f]`. Every value in
 * the same form (`norm(field, value)`); a field missing from `base` is not checked (the change wins).
 */
function stale(base, now, next, norm) {
  if (base === undefined || base === null) return [];
  if (typeof base !== 'object' || Array.isArray(base)) throw fail('invalid', { field: 'base' });
  const out = [];
  for (const f of Object.keys(next)) {
    if (!Object.prototype.hasOwnProperty.call(base, f)) continue;
    let b;
    try { b = norm(f, base[f]); } catch { throw fail('invalid', { field: 'base' }); }
    if (!same(b, now[f]) && !same(next[f], now[f])) out.push(f);
  }
  return out;
}

module.exports = { canon, same, stale, AREAS, COLORS, fail, isKnown, statusOf, posInt, line, text, parse, isDate, isTime, area, color, bool, b64u };
