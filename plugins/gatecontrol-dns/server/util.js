'use strict';

// Small shared helpers: API errors, input checks, the host's error codes.

// API error code → HTTP status (README "App-API")
const STATUS = {
  invalid: 400,
  invalid_domain: 400,
  forbidden: 403,
  not_allowed: 403,
  forever_not_allowed: 403,
  too_long: 403,
  not_found: 404,
  name_taken: 409,
  limit: 409,
  log_off: 409,
  not_filtering: 409,
  not_paused: 409,
  off: 409,
  no_device: 409,
  unsupported: 501,
  unavailable: 503,
  internal: 500,
};

/** An API error: throw fail('not_allowed', { reason: 'profile' }). */
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

/** gc.vpnDns errors → this plugin's codes (the host's message names the field of an invalid input) */
const HOST = {
  ERR_INVALID: 'invalid', ERR_NOT_FOUND: 'not_found', ERR_FORBIDDEN: 'forbidden', ERR_NOT_PERSON: 'forbidden', ERR_NOT_ADMIN: 'forbidden',
  ERR_UNAVAILABLE: 'unavailable', ERR_LOG_OFF: 'log_off', ERR_NOT_FILTERING: 'not_filtering', ERR_VPN_DNS_DENIED: 'unsupported', ERR_UNKNOWN_API: 'unsupported',
};

function fromHost(e) {
  if (isKnown(e)) return e;
  const code = e && HOST[e.code];
  if (!code) return e;
  const msg = clip(String((e && e.message) || ''), 200);
  if (code === 'invalid') {
    if (/is no domain|no domain/.test(msg)) return fail('invalid_domain', { detail: msg });
    if (/a profile with this name exists/.test(msg)) return fail('name_taken', { detail: msg });
    return fail('invalid', { detail: msg });
  }
  return fail(code);
}

/** Run a gc.vpnDns call, turning the host's errors into API errors. */
async function host(fn) {
  try { return await fn(); } catch (e) { throw fromHost(e); }
}

/** "12,3" — one decimal; 0 for no queries */
const percent = (blocked, queries) => (queries > 0 ? Math.round((blocked / queries) * 1000) / 10 : 0);

module.exports = { STATUS, fail, isKnown, posInt, clip, fromHost, host, percent };
