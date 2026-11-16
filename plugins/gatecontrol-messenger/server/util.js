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
  // 1.10.0 "In Drive speichern" (POST messages/:id/to-drive): Drive's own answers, and Drive not there
  no_seat: 403,
  not_licensed: 403,
  quota: 409,
  upload_invalid: 409,
  exists: 409,
  drive_unavailable: 409,
  // 1.11.0: GateControl's virus scan (scan.js) — malware found, still being checked, held back
  infected: 422,
  scan_pending: 423,
  quarantined: 423,
  scan_blocked: 423,
  // 1.12.0: bridges to other messengers (bridges.js) — switched off / not offered, the bridge does not answer,
  // a step GateControl cannot offer, the bridge refused; a child without the parents' yes; the notes not confirmed
  bridge_off: 409,
  bridge_unreachable: 503,
  bridge_unsupported: 409,
  bridge_failed: 502,
  bridge_locked: 403,
  consent_required: 409,
  // 1.14.0: a bridged chat whose account is not linked (any more) — the history stays, sending needs a new link
  bridge_unlinked: 409,
  // 1.14.0: only text crosses a bridge for now (no files, no rich kinds, no changes to title or members)
  bridge_text_only: 409,
  // 1.20.0: a channel or a group where only admins write takes no message (reason: channel | admins_only), reacting in
  // channels is off after the bridge refused it (reason: reactions_off)
  bridge_read_only: 409,
  // 1.15.0: a file in a type the bridge does not take (reason: image | voice | video); a phone number without + and
  // country code (POST bridges/:network/resolve, …/chats)
  bridge_media_type: 409,
  invalid_number: 400,
  // 1.16.0: a new chat by number — the service signed the person out; a child without the parents' second switch
  bridge_logged_out: 409,
  child_new_chat_off: 403,
  // 1.18.0: „Neuer Chat“ with contacts — a WhatsApp contact's reference ran out (reload the list); Mail's address book is
  // not there (not installed, contacts off, no place)
  contact_expired: 409,
  mail_missing: 409,
  // 1.21.0: persons — these chats cannot be one person (reason: group | channel | not_direct | two_accounts | one_way)
  cannot_merge: 409,
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

/**
 * 1.19.0: a name a bridge gave a chat or a contact → the name, or null. mautrix-whatsapp names a contact it knows no
 * name of by the phone number („+49… (WA)“, also redacted with „∙“); GateControl (names.js) drops that since the
 * first real test — this is the same check for what older servers delivered and what is stored already.
 */
const NUMBER_RE = /^[\s+()\-./\u2219\u2022·0-9]+$/;
// 1.25.2: a public WhatsApp name of only punctuation („.“, „-“, „…“ — people set it to show no name) is no name either
const MARKS_RE = /^[\p{P}\p{Z}\p{Cf}~^`+=|<>]+$/u;
function bridgeName(v, max = 120) {
  let n = typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max * 2) : '';
  if (n.endsWith(' (WA)')) n = n.slice(0, -5).trim();
  const digits = (n.match(/[0-9]/g) || []).length;
  if (!n || MARKS_RE.test(n) || (NUMBER_RE.test(n) && (digits >= 5 || (digits >= 1 && /[\u2219\u2022]/.test(n)))) || n.toLowerCase() === 'unknown user') return null;
  return n.slice(0, max);
}

module.exports = { STATUS, fail, isKnown, posInt, line, multiline, text, optText, bool, intIn, numIn, iso, parseIso, userIds, parseJson, bridgeName };
