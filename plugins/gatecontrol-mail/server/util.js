'use strict';

// Small shared helpers: API errors (code → HTTP status), input checks, addresses, text.

const STATUS = {
  invalid: 400,
  login_required: 403,
  forbidden: 403,
  not_allowed: 403,
  // the licence's people (seats.js, like Drive)
  no_seat: 403,
  not_licensed: 403,
  seat_limit: 409,
  seat_kind: 409,
  limit: 403,
  not_found: 404,
  exists: 409,
  auth_failed: 409,
  imap_disabled: 409,
  unreachable: 409,
  tls: 409,
  ai_off: 409,
  ai_unavailable: 409,
  familie_unavailable: 409,
  drive_unavailable: 409,
  no_folder: 409,
  not_waiting: 409,
  microsoft_off: 409,
  attachments_unsupported: 409,
  images_off: 409,
  images_blocked: 403,
  links_disabled: 409,
  too_large: 413,
  rate_limited: 429,
  busy: 409,
  // calendars and contacts (1.2.0)
  feature_off: 403,
  read_only: 409,
  conflict: 409,
  consent_required: 409,
  dav_unavailable: 409,
  not_supported: 409,
  send_failed: 409,
  invitation_outdated: 409,
  invalid_ics: 400,
  invalid_vcard: 400,
  internal: 500,
};

/** An API error: throw fail('auth_failed', { hint }). */
function fail(code, extra) {
  return Object.assign(new Error(code), { code, extra: extra || null });
}

const isKnown = (e) => !!(e && typeof e.code === 'string' && STATUS[e.code] && e.code !== 'internal');

/** A positive integer from a number or a decimal string, else null. */
const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Single-line text: control characters removed, whitespace collapsed; '' when not a string. */
function line(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** `s` cut to `max` characters (with … when cut). */
function clip(s, max) {
  const t = String(s == null ? '' : s);
  return t.length > max ? t.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : t;
}

const EMAIL_RE = /^[^\s@<>()"',;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;

/** A mail address (lower case domain kept as written for the local part … all lower case is fine for mail) or null. */
function email(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length <= 254 && EMAIL_RE.test(s) ? s.toLowerCase() : null;
}

/** { name, address|email } | "Name <a@b>" | "a@b" → { name, email } or null. */
function person(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(v);
    const e = email(m ? m[2] : v);
    return e ? { name: m ? line(m[1]).slice(0, 120) : '', email: e } : null;
  }
  if (typeof v !== 'object') return null;
  const e = email(v.email != null ? v.email : v.address);
  return e ? { name: line(v.name || '').slice(0, 120), email: e } : null;
}

/** A list of people (≤ max) or throws invalid; `field` names it. */
function people(v, field, max = 100) {
  if (v == null || v === '') return [];
  const list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/[,;]/) : null);
  if (!list || list.length > max) throw fail('invalid', { field });
  const out = [];
  for (const x of list) {
    if (typeof x === 'string' && !x.trim()) continue;
    const p = person(x);
    if (!p) throw fail('invalid', { field });
    if (!out.some((o) => o.email === p.email)) out.push(p);
  }
  return out;
}

/** JSON of a column, or `dflt`. */
function parse(s, dflt) {
  if (s == null || s === '') return dflt;
  try { return JSON.parse(s); } catch { return dflt; }
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Plain text of (sanitized) HTML: blocks to line breaks, tags out, entities decoded. */
function htmlText(html) {
  return String(html == null ? '' : html)
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (all, e) => {
      if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; }
      return ENT[e.toLowerCase()] != null ? ENT[e.toLowerCase()] : all;
    })
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A short preview (≤ 160) of a text: quotes and signatures dropped, one line. */
function snippet(text) {
  const lines = String(text || '').split('\n').filter((l) => !/^\s*>/.test(l));
  const cut = lines.findIndex((l) => /^-- ?$/.test(l) || /^(Am|On) .{4,120}(schrieb|wrote).*:$/.test(l.trim()));
  return clip(line((cut >= 0 ? lines.slice(0, cut) : lines).join(' ')), 160);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Plain text → simple HTML paragraphs. */
function textHtml(text) {
  return String(text || '').split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const PALETTE = ['#F5B544', '#79B8FF', '#FF8080', '#46E0A0', '#B79CFF', '#FF9F5A', '#5FD4E8', '#E58FD0'];

const MONTH = 30 * 86400000;
const DAY = 86400000;

/** UTF-8 bytes of a string. */
const bytesOf = (s) => (s == null ? 0 : Buffer.byteLength(String(s), 'utf8'));

module.exports = {
  STATUS, fail, isKnown, posInt, line, clip, email, person, people, parse, htmlText, snippet, esc, textHtml, bytesOf,
  COLOR_RE, PALETTE, MONTH, DAY, EMAIL_RE,
};
