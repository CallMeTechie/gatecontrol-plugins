'use strict';

// Small shared helpers: API errors, input checks, times.

// API error code → HTTP status (README "API")
const STATUS = {
  invalid: 400,
  forbidden: 403,
  no_right: 403,
  unlicensed: 403,
  not_found: 404,
  disabled: 409,
  no_browser: 409,
  maintenance: 409,
  credential_unreadable: 409,
  credential_missing: 409,
  listener_required: 409,
  port_in_use: 409,
  limit: 429,
  rate_limited: 429,
  not_allowed: 422,
  unreachable: 502,
  wake_failed: 502,
  listener_failed: 502,
  offline: 503,
  internal: 500,
  // 1.1: Windows PCs of the app, codes, requests, the firewall per session
  no_device: 400,
  no_vpn: 409,
  no_share_right: 403,
  home_edition: 409,
  rdp_off: 409,
  code_required: 409,
  code_invalid: 422,
  code_locked: 429,
  request_waiting: 409,
  request_expired: 410,
  firewall_timeout: 504,
  firewall_failed: 502,
  // 1.2: SSH in GateControl's terminal, tmux, host keys, recordings
  host_key_mismatch: 409,
  host_key_unpinned: 409,
  tmux_unavailable: 409,
  credential_required: 409,
  auth_failed: 502,
  recording_required: 409,
  recording_unavailable: 409,
  recording_busy: 409,
  // 1.3: the screen of a phone (GateControl's relay, gc.remote version 4)
  screen_unavailable: 409,
  screen_off: 409,
  // 1.6: Linux devices of the agent
  ssh_off: 409,
  desktop_off: 409,
  host_key_invalid: 400,
  key_unavailable: 409,
  // 1.7: the new „Gerät hinzufügen“ (gc.remote version 7)
  gateway_offline: 409,
  // 1.8: the SSH key set up once with a password, closing tmux sessions, enrollment codes for the agent (gc.remote version 9)
  password_auth_off: 409,
  host_key_rejected: 409,
  sudo_password: 409,
  sudo_denied: 409,
  not_posix: 409,
  write_failed: 409,
  key_test_failed: 409,
  timeout: 504,
  tmux_gone: 404,
  tmux_changed: 409,
  user_disabled: 409,
  no_valid_scopes: 409,
  no_client_access: 409,
  own_key: 409,
  limit_reached: 409,
  enroll_unavailable: 409,
  key_missing: 409,
};

/** An API error: throw fail('limit', { max: 2 }). */
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

/** Text with line breaks kept (notes, schedules), other control characters removed. */
function multiline(v, max) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v) { const c = ch.codePointAt(0); if (c === 10) out += '\n'; else if (c === 13) continue; else out += c < 32 || c === 127 ? ' ' : ch; }
  return out.trim().slice(0, max);
}

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const bool = (v) => v === true || v === 1;

/** "2026-11-15 20:01:07" (SQLite datetime, UTC) or an ISO time → ms; null when it is none. */
function parseTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  const s = String(v).trim();
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  const ms = Date.parse(sqlite);
  return Number.isFinite(ms) ? ms : null;
}

/** gc.remote / host errors → this plugin's codes */
const HOST = {
  ERR_INVALID: 'invalid',
  ERR_NOT_FOUND: 'not_found',
  ERR_REMOTE_UNLICENSED: 'unlicensed',
  ERR_REMOTE_LIMIT: 'limit',
  ERR_REMOTE_LISTENER_REQUIRED: 'listener_required',
  ERR_REMOTE_CREDENTIAL_NOT_FOUND: 'credential_missing',
  ERR_REMOTE_CREDENTIAL_UNREADABLE: 'credential_unreadable',
  ERR_REMOTE_NOT_ALLOWED: 'not_allowed',
  ERR_REMOTE_UNREACHABLE: 'unreachable',
  ERR_REMOTE_RATE_LIMITED: 'rate_limited',
  ERR_REMOTE_WAKE_FAILED: 'wake_failed',
  ERR_REMOTE_PORT_IN_USE: 'port_in_use',
  ERR_REMOTE_LISTENER_FAILED: 'listener_failed',
  ERR_REMOTE_LISTENER_OFF: 'offline',
  // gc.remote version 3
  ERR_REMOTE_HOST_KEY_MISMATCH: 'host_key_mismatch',
  ERR_REMOTE_HOST_KEY_UNPINNED: 'host_key_unpinned',
  ERR_REMOTE_TMUX_UNAVAILABLE: 'tmux_unavailable',
  ERR_REMOTE_CREDENTIAL_REQUIRED: 'credential_required',
  ERR_REMOTE_AUTH_FAILED: 'auth_failed',
  ERR_REMOTE_KEY_UNREADABLE: 'credential_unreadable',
  ERR_REMOTE_TIMEOUT: 'unreachable',
  ERR_REMOTE_RECORDING_UNAVAILABLE: 'recording_unavailable',
  ERR_REMOTE_BUSY: 'recording_busy',
  // gc.remote version 7
  ERR_REMOTE_GATEWAY_OFFLINE: 'gateway_offline',
};

function fromHost(e, dflt = 'internal') {
  if (isKnown(e)) return e;
  let code = e && HOST[e.code];
  // 1.8: the codes of gc.remote version 9 (ERR_REMOTE_TMUX_GONE → tmux_gone, ERR_FORBIDDEN → forbidden, …)
  if (!code && e && typeof e.code === 'string') {
    const m = /^ERR_(?:REMOTE_)?([A-Z_]{2,40})$/.exec(e.code);
    const c = m ? m[1].toLowerCase() : null;
    if (c && STATUS[c] && c !== 'internal') code = c;
  }
  return fail(code || dflt, { message: e && e.message ? String(e.message).slice(0, 200) : null });
}

module.exports = { STATUS, fail, isKnown, posInt, clip, multiline, iso, bool, parseTime, fromHost };
