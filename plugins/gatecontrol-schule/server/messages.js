'use strict';

// School messages (1.4.0): the WebUntis inbox of each account (server/untis.js inbox(): a JWT from
// api/token/new, then api/rest/view/v1/messages with "Authorization: Bearer"), read only — nothing is
// ever marked as read in WebUntis, no message is opened there (no detail call).
//
//   fetch      in the account's cycle (same session, after the timetable), at most every 15 minutes per
//              account; optional like homework / exams: 401/403 → 'no_right', 404 → 'unsupported' (asked
//              again after a day), another error after 6 hours, 'network' in the next cycle
//              (accounts.extras_json.messages { code, until }). Never stops or fails the cycle.
//   store      table messages (account, WebUntis id): subject, preview and — only when the list gives
//              the text — body, all HTML stripped to plain text (stripHtml); the sender; when it was sent.
//              The account's first good fetch is the baseline (no pushes); later new ones are 'pending' —
//              1.4.1: unless sent more than a day before they were found (stored, no push).
//              Kept 90 days (messages sent earlier are never added — they would come back as "new").
//   who        an administrator; the recipients of the account's students; the student himself when
//              the account is his own student account (he linked it in his profile, or he is the
//              student mapped to it). NOT a child through his parents' inbox. Kiosk devices: never.
//   push       topic 'messages' („Nachrichten der Schule“): one push per new message („Schule: <subject>“,
//              sender and preview), at most 3 per account and cycle, the rest in one summary push; to the
//              people above except administrators who are not one of them; quiet hours hold them (sent
//              when they end); a message not sent within 3 days expires.
//   API        GET app/messages?days=30 (1…90) → { ok, messages: [{ id, accountId, studentIds, subject,
//              preview, body?, sender, sentAt, hasAttachments, isNew }] } newest first, ≤ 100.
//   1.5.0      without WebUntis: the full text and the attachments of every message (WebUntis' detail call,
//              once per message, ≤ 10 per cycle, newest first; a failure is tried again after 1, 2, 4 … hours,
//              5 times); the attachments of new messages are fetched into GateControl's media store in the
//              cycle (gc.media.fetch, GateControl ≥ 1.190.0, ≤ 25 MB each), others when somebody opens them;
//              "new" is per person (message_reads: opened in an app or on a page; unread, not older than 14
//              days, not a baseline message); a read confirmation the sender asks for is sent only when a
//              person taps "Lesen bestätigen" (the one write to WebUntis). API: messages gain fullText,
//              attachments [{ id, name, size, mime }] (pages: also `url` once fetched), read, confirmation
//              { confirmedAt, by } | null; POST …/messages/<id>/read | confirm | attachments/<attId>.
//   1.7.0      POST …/messages/<id>/attachments/<attId>/drive — the attachment into Drive (server/drive.js).

const store = require('./store');
const untis = require('./untis');
const tz = require('./tz');
const views = require('./views');
const extras = require('./extras');
const notify = require('./notify');
const texts = require('./texts.json');

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const GAP_MS = 15 * MIN;
const KEEP_MS = 90 * DAY;
const NEW_MS = 14 * DAY; // 1.5.0: unread and found within 14 days (was: found within a day)
// 1.5.0: details and attachments
const DETAIL_PER_CYCLE = 10;
const DETAIL_TRIES = 5;
const BODY_MAX = 20000;
const MAX_ATTACHMENTS = 20;
const ATT_MAX_BYTES = 25 * 1024 * 1024;
const PREFETCH_PER_CYCLE = 3;
const PREFETCH_DAYS = 7 * DAY;
const ATT_TRIES = 2;
const ATT_ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const EXPIRE_MS = 3 * DAY;
const MAX_PUSH = 3;
const MAX_LINES = 6;
const TOPIC = 'messages';
// 1.5.1: the card of a message push (GateControl ≥ 1.191.0): the whole text up to 4000, the link to the plugin's app route
const CARD_TEXT_MAX = 4000;
const ROUTE = 'plg-gatecontrol-schule';
const ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;

const t = (lang, key, params) => notify.fmt(texts, lang, key, params);
const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

// ─── Plain text ─────────────────────────────────

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', euro: '€', eacute: 'é', egrave: 'è', agrave: 'à',
  bdquo: '„', ldquo: '“', rdquo: '”', sbquo: '‚', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»', copy: '©', reg: '®', deg: '°',
};

function decodeEntities(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z]{2,8});/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

/** Cut to `max` characters with "…". */
function clipText(s, max) {
  return s.length > max ? s.slice(0, Math.max(1, max - 1)).trimEnd() + '…' : s;
}

/**
 * HTML (or text) → plain text: scripts, styles and comments dropped with their content, line breaks
 * for <br>, paragraphs and list items ("• "), every other tag removed, entities decoded, control
 * characters and runs of blanks cleaned. The result is text only — the pages and apps put it in as
 * text, never as HTML. Not a string → ''.
 */
function stripHtml(v, max = 5000) {
  if (typeof v !== 'string' || !v) return '';
  let s = v.slice(0, 200000).replace(/[\x01\x02]/g, '');
  s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  s = s.replace(/<(script|style|head|title|template|iframe|object|svg|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // block boundaries: \x01 a line break, \x02 a paragraph — a run of them counts once
  s = s.replace(/<li\b[^>]*>/gi, '\x01• ');
  s = s.replace(/<\/?(?:p|h[1-6]|blockquote|pre|table)\b[^>]*>/gi, '\x02');
  s = s.replace(/<\/?(?:div|ul|ol|li|tr|section|article|header|footer)\b[^>]*>/gi, '\x01');
  s = s.replace(/[\x01\x02](?:[ \t\r\n]*[\x01\x02])*/g, (m) => (m.includes('\x02') ? '\n\n' : '\n'));
  s = s.replace(/<\/?[A-Za-z][^>]*>/g, '');
  s = s.replace(/<![^>]*>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, '\n').replace(/[\0-\x08\x0b-\x1f\x7f\u200b\u2028\u2029]/g, ' ').replace(/[ \t\u00a0]+/g, ' ');
  s = s.split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return clipText(s, max);
}

/** Plain text in one line. */
const oneLine = (s, max) => clipText(String(s || '').replace(/\s+/g, ' ').trim(), max);

/**
 * When a message was sent → ms (null when unknown): an ISO time with a zone as it is; a local time
 * ("2026-10-20T08:15[:00]") in the school's time zone; ms or s since 1970.
 */
function parseSent(v, cfg) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v > 1e11 ? Math.round(v) : Math.round(v * 1000);
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(v.trim());
  if (!m || !tz.parseDate(`${m[1]}-${m[2]}-${m[3]}`) || Number(m[4]) > 23 || Number(m[5]) > 59) return null;
  if (m[7]) {
    const zone = m[7].toUpperCase() === 'Z' ? 'Z' : m[7].replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${zone}`);
    return Number.isFinite(ms) ? ms : null;
  }
  return tz.toUtc({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), hh: Number(m[4]), mm: Number(m[5]), ss: Number(m[6] || 0) }, cfg.tz);
}

/**
 * The inbox answer → rows { msg_id, subject, preview, body, sender, sent_at, has_attachments } (≤ 300,
 * each id once; items without a usable id are left out).
 */
function messageRows(raw, cfg) {
  const out = [];
  const seen = new Set();
  // 1.5.0: a message of the list "to be confirmed" asks for a read confirmation (wherever else it is listed)
  const confirm = new Set(list(raw).filter((m) => m.list === 'readConfirmationMessages' && m.id != null).map((m) => String(m.id).trim()));
  for (const m of list(raw)) {
    const id = m.id == null ? '' : String(m.id).trim();
    if (!ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const snd = m.sender && typeof m.sender === 'object' ? (m.sender.displayName || m.sender.name || '') : (typeof m.sender === 'string' ? m.sender : m.senderName);
    const src = [m.content, m.body, m.text, m.contentHtml].find((x) => typeof x === 'string' && x.trim());
    const body = src ? stripHtml(src, 5000) || null : null;
    const preview = oneLine(stripHtml(typeof m.contentPreview === 'string' ? m.contentPreview : (typeof m.preview === 'string' ? m.preview : ''), 1000), 300);
    out.push({
      msg_id: id,
      subject: oneLine(stripHtml(typeof m.subject === 'string' ? m.subject : '', 1000), 200),
      preview: preview || (body ? oneLine(body, 300) : ''),
      body,
      sender: oneLine(stripHtml(typeof snd === 'string' ? snd : '', 400), 80),
      sent_at: parseSent(m.sentDateTime != null ? m.sentDateTime : (m.sentDate != null ? m.sentDate : m.sent), cfg),
      has_attachments: m.hasAttachments === true || (Array.isArray(m.attachments) && m.attachments.length > 0),
      confirm: confirm.has(id),
    });
    if (out.length >= 300) break;
  }
  return out;
}

// ─── Details and attachments (1.5.0) ───────────

const MIME_BY_EXT = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', rtf: 'application/rtf', txt: 'text/plain', csv: 'text/csv',
  zip: 'application/zip', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', mov: 'video/quicktime',
};
const FALLBACK_MIME = 'application/octet-stream';

/** The type of an attachment by its file name (the storage often answers application/octet-stream). */
function mimeOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return (m && MIME_BY_EXT[m[1].toLowerCase()]) || FALLBACK_MIME;
}

/** A file name as shown: no path, no control characters, ≤ 200 characters. */
function fileName(v, fallback) {
  const s = (typeof v === 'string' ? v : '').replace(/[\0-\x1f\x7f]/g, '').split(/[\\/]/).pop().trim();
  return clipText(s, 200) || fallback;
}

/**
 * The detail answer → { body (the full text, null when it has none), attachments: [{ id, name, size, mime }] }
 * (storageAttachments, else attachments; ≤ 20, each id once).
 */
function detailOf(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const src = [r.content, r.contentHtml, r.body, r.text].find((x) => typeof x === 'string' && x.trim());
  const body = src ? stripHtml(src, BODY_MAX) || null : null;
  const atts = [];
  const seen = new Set();
  for (const a of [...list(r.storageAttachments), ...list(r.attachments)]) {
    const id = a.id == null ? '' : String(a.id).trim();
    if (!ATT_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = fileName(a.name || a.fileName || a.filename, `Anhang-${atts.length + 1}`);
    const size = [a.size, a.fileSize, a.length].map(Number).find((n) => Number.isSafeInteger(n) && n >= 0);
    atts.push({ id, name, size: size == null ? null : size, mime: mimeOf(name) });
    if (atts.length >= MAX_ATTACHMENTS) break;
  }
  return { body, attachments: atts };
}

const canFetchMedia = (gc) => !!(gc.media && typeof gc.media.fetch === 'function');

/**
 * The details of the account's messages still without them (≤ 10 per cycle, newest first). Stops at a
 * network error or the deadline; another failure → that message again after 1, 2, 4 … hours (5 times).
 */
async function fetchDetails(gc, client, acc, now, deadline) {
  let done = 0;
  for (const m of await store.messagesWithoutDetail(gc, acc.id, now, DETAIL_TRIES, DETAIL_PER_CYCLE)) {
    if (Date.now() > deadline) break;
    try {
      const d = detailOf(await client.message(m.msg_id));
      await store.setMessageDetail(gc, m, d, now);
      done += 1;
    } catch (e) {
      const code = untis.codeOf(e);
      if (code === 'network') break;
      await store.detailFailed(gc, m, now + HOUR * 2 ** Math.min(m.detail_tries, 6));
      gc.log.info('message detail not fetched', acc.id, code);
      if (code === 'no_right' || code === 'unsupported') break;
    }
  }
  return done;
}

/**
 * One attachment into GateControl's media store (gc.media.fetch, claimed) → the attachment with its
 * mediaId (and the real type and size). Throws { code: 'too_large' | 'type' | 'failed' | 'network' | … }.
 */
async function fetchAttachment(gc, client, att) {
  const link = await client.attachmentUrl(att.id);
  let r;
  try {
    r = await gc.media.fetch(link.url, { headers: link.headers, mime: att.mime || mimeOf(att.name), name: att.name, maxBytes: ATT_MAX_BYTES, timeoutMs: 30000 });
  } catch (e) {
    const c = e && e.code;
    if (c === 'ERR_MEDIA_TOO_LARGE') throw Object.assign(new Error('too_large'), { code: 'too_large' });
    if (c === 'ERR_MEDIA_TYPE') throw Object.assign(new Error('type'), { code: 'type' });
    if (c === 'ERR_MEDIA_QUOTA') throw Object.assign(new Error('quota'), { code: 'quota' });
    if (c === 'ERR_NET_DENIED') {
      // the storage is not in plugin.json's network list: say where it is (the host only, never the link)
      let host = '';
      try { host = new URL(link.url).hostname; } catch { /* none */ }
      gc.log.warn('attachment storage not allowed', host);
    }
    throw Object.assign(new Error('failed'), { code: c === 'ERR_TIMEOUT' || c === 'ERR_NET' ? 'network' : 'failed' });
  }
  await gc.media.claim(r.mediaId);
  return { ...att, mediaId: r.mediaId, mime: r.mime || att.mime, size: Number.isSafeInteger(r.bytes) ? r.bytes : att.size };
}

/** New messages' attachments fetched in the cycle (≤ 3 per cycle, found within 7 days, not baseline). */
async function prefetchAttachments(gc, client, acc, now, deadline) {
  if (!canFetchMedia(gc)) return 0;
  let n = 0;
  const recent = await store.listMessages(gc, [acc.id], now - KEEP_MS, 100);
  for (const m of recent) {
    if (m.status === 'baseline' || now - m.detected_at > PREFETCH_DAYS || !m.attachments.length) continue;
    let changed = false;
    const atts = m.attachments.slice();
    for (let i = 0; i < atts.length && n < PREFETCH_PER_CYCLE; i++) {
      const a = atts[i];
      if (a.mediaId || (a.tries || 0) >= ATT_TRIES || (a.size != null && a.size > ATT_MAX_BYTES)) continue;
      if (Date.now() > deadline) return n;
      n += 1;
      try {
        atts[i] = await fetchAttachment(gc, client, a);
      } catch (e) {
        atts[i] = { ...a, tries: (a.tries || 0) + 1 };
        if (e && e.code === 'network') { await store.setAttachments(gc, m, atts); return n; }
      }
      changed = true;
    }
    if (changed) await store.setAttachments(gc, m, atts);
    if (n >= PREFETCH_PER_CYCLE) break;
  }
  return n;
}

// ─── Fetch ──────────────────────────────────────

/** An optional endpoint failed: left alone like homework / exams ('network': tried in the next cycle). */
function pause(gc, state, kind, e, accId, now) {
  const code = untis.codeOf(e);
  if (code !== 'network') state[kind] = { code, until: now + extras.skipFor(code) };
  gc.log.info(`${kind} not fetched`, accId, code);
}

/**
 * The inbox of one account's cycle (≤ every 15 minutes); stores it. Never throws. `state` = the
 * account's extras state (changed in place and returned). fetched: the students fetched this cycle.
 */
async function fetchAccount(gc, client, acc, fetched, state, cfg, now, deadline = Infinity) {
  try {
    if (!fetched.length || Date.now() > deadline) return state;
    if (state.messages && Number(state.messages.until) > now) return state;
    if (acc.messages_at != null && now - acc.messages_at < GAP_MS) return state;
    try {
      const rows = messageRows(await client.inbox(), cfg);
      const baseline = acc.messages_at == null;
      // 1.4.1: a message first seen but sent more than a day ago is not news (no push) — e.g. the older
      // messages to be confirmed, read since 1.4.1
      const added = await store.upsertMessages(gc, acc.id, rows, now, { baseline, oldest: now - KEEP_MS, quietBefore: now - DAY });
      await store.updateAccount(gc, acc.id, { messages_at: now });
      delete state.messages;
      if (added) gc.log.info('messages found', acc.id, added, baseline ? 'baseline' : 'new');
      // 1.5.0: the full text and the attachments (optional: a failure never pauses the inbox)
      try {
        await fetchDetails(gc, client, acc, now, deadline);
        await prefetchAttachments(gc, client, acc, now, deadline);
      } catch (e) { gc.log.info('message details failed', acc.id, untis.codeOf(e)); }
    } catch (e) { pause(gc, state, 'messages', e, acc.id, now); }
  } catch (e) {
    gc.log.warn('messages failed', acc.id, (e && (e.code || e.message)) || 'error');
  }
  return state;
}

// ─── Who ────────────────────────────────────────

const liveOf = (acc, students) => students.filter((s) => s.account_id === acc.id && s.enabled && !s.missing);

/** Is the account the student's own (a student account, not a parent's)? */
function isStudentAccount(acc, live) {
  if (acc.person_type === 5) return true;
  return acc.person_type == null && live.length === 1 && acc.person_id != null && live[0].person_id === acc.person_id;
}

/**
 * May `user` read the inbox of `acc`? (students: all students, or the account's.) An administrator;
 * a recipient of one of its (enabled) students; the student himself on his own student account —
 * never a child through the parents' inbox, never a kiosk device or a viewer known by device trust only.
 */
function canViewMessages(acc, students, user) {
  if (!acc || !user || !Number.isInteger(user.id) || user.loggedIn === false || user.kiosk === true) return false;
  const live = liveOf(acc, students);
  if (!live.length) return false;
  if (user.role === 'admin') return true;
  if (live.some((s) => s.recipients.includes(user.id))) return true;
  return isStudentAccount(acc, live) && (acc.owner_user_id === user.id || live.some((s) => s.user_id === user.id));
}

/** Who gets the pushes of an account's messages (existing users): the recipients, on a student account the student. */
function recipientsOf(acc, live, users) {
  const ids = [];
  for (const s of live) ids.push(...s.recipients);
  if (isStudentAccount(acc, live)) {
    for (const s of live) ids.push(s.user_id);
    ids.push(acc.owner_user_id);
  }
  return [...new Set(ids.filter((id) => id != null && users.has(id)))];
}

/** The inboxes `user` may read → [{ acc, studentIds }] (studentIds: the account's students the viewer sees; all of them when none). */
async function inboxesOf(gc, user) {
  const all = await store.listStudents(gc);
  const out = [];
  for (const acc of await store.listAccounts(gc)) {
    if (!canViewMessages(acc, all, user)) continue;
    const live = liveOf(acc, all);
    const seen = live.filter((s) => views.canView(s, user)).map((s) => s.id);
    out.push({ acc, studentIds: seen.length ? seen : live.map((s) => s.id) });
  }
  return out;
}

// ─── API ────────────────────────────────────────

const apiId = (m) => `${m.account_id}-${m.msg_id}`;
/** 1.5.0: new for a person = not opened by him, found within 14 days, not a baseline message. */
const isNew = (m, now, read = false) => !read && m.status !== 'baseline' && now - m.detected_at < NEW_MS;

/** "3-12345" → { accountId, msgId } (null when malformed). */
function parseApiId(v) {
  const x = /^(\d{1,10})-([A-Za-z0-9_.-]{1,40})$/.exec(String(v || ''));
  return x ? { accountId: Number(x[1]), msgId: x[2] } : null;
}

/**
 * A stored message → the API shape. ctx (1.5.0): { read: Set of api ids the viewer opened, names: Map
 * user id → display name, urls: Map mediaId → frame URL (pages only) }.
 */
function messageView(m, studentIds, now, ctx = {}) {
  const id = apiId(m);
  const read = !!(ctx.read && ctx.read.has(id));
  const out = { id, accountId: m.account_id, studentIds: studentIds.slice(), subject: m.subject, preview: m.preview };
  if (m.body) out.body = m.body;
  out.sender = m.sender;
  out.sentAt = new Date(m.sent_at != null ? m.sent_at : m.detected_at).toISOString();
  out.hasAttachments = m.has_attachments || m.attachments.length > 0;
  out.isNew = isNew(m, now, read);
  // 1.5.0
  out.fullText = m.full_text && !!m.body;
  out.attachments = m.attachments.map((a) => {
    const v = { id: a.id, name: a.name, size: a.size == null ? null : a.size, mime: a.mime || null };
    if (a.mediaId && ctx.urls && ctx.urls.has(a.mediaId)) v.url = ctx.urls.get(a.mediaId);
    return v;
  });
  out.read = read;
  out.confirmation = m.confirm_required
    ? { confirmedAt: m.confirmed_at != null ? new Date(m.confirmed_at).toISOString() : null, by: (m.confirmed_by != null && ctx.names && ctx.names.get(m.confirmed_by)) || null }
    : null;
  return out;
}

/** The display names of the users who confirmed some of `rows` → Map id → name. */
async function namesFor(gc, rows) {
  const out = new Map();
  if (!rows.some((m) => m.confirmed_by != null)) return out;
  try { for (const u of await gc.users.list()) out.set(u.id, (typeof u.name === 'string' && u.name) || u.displayName || u.username || null); } catch { /* none */ }
  return out;
}

/** 1.5.0: frame URLs of the fetched attachments (pages only; ≤ 1 h) → Map mediaId → URL. */
async function urlsFor(gc, user, rows) {
  const out = new Map();
  if (!gc.media || typeof gc.media.url !== 'function') return out;
  for (const m of rows) {
    for (const a of m.attachments) {
      if (!a.mediaId || out.has(a.mediaId)) continue;
      try { out.set(a.mediaId, await gc.media.url(a.mediaId, { user: user.id, ttlS: 3600 })); } catch { /* deleted */ }
    }
  }
  return out;
}

/** The view context of `rows` for `user` (urls: pages). */
async function contextFor(gc, user, rows, { urls = false } = {}) {
  return { read: await store.readSet(gc, user.id, rows), names: await namesFor(gc, rows), urls: urls ? await urlsFor(gc, user, rows) : null };
}

/** app/messages: the messages `user` may read of the last `days` days, newest first, ≤ `limit`. */
async function listFor(gc, user, days, now, limit = 100) {
  const boxes = await inboxesOf(gc, user);
  if (!boxes.length) return [];
  const byAcc = new Map(boxes.map((b) => [b.acc.id, b.studentIds]));
  const rows = await store.listMessages(gc, [...byAcc.keys()], now - days * DAY, limit);
  const ctx = await contextFor(gc, user, rows);
  return rows.map((m) => messageView(m, byAcc.get(m.account_id) || [], now, ctx));
}

/**
 * The Schule page / portal: per student the messages of its account's inbox when `user` may read it
 * (Map studentId → [messageView], ≤ 20 of the last 30 days). Students whose inbox he may not read
 * are not in the map.
 */
async function forStudents(gc, user, students, now, opts = {}) {
  const out = new Map();
  const boxes = await inboxesOf(gc, user);
  if (!boxes.length) return out;
  for (const b of boxes) {
    if (!students.some((s) => s.account_id === b.acc.id)) continue;
    const rows = await store.listMessages(gc, [b.acc.id], now - 30 * DAY, 20);
    const ctx = await contextFor(gc, user, rows, { urls: !!opts.urls });
    const mine = rows.map((m) => messageView(m, b.studentIds, now, ctx));
    for (const s of students) if (s.account_id === b.acc.id) out.set(s.id, mine);
  }
  return out;
}

// ─── Actions (1.5.0) ────────────────────────────

const actionError = (code) => Object.assign(new Error(code), { code });

/** The message `id` (API id) when `user` may read it → { m, acc, studentIds }; SCHULE_MESSAGE_NOT_FOUND otherwise. */
async function accessible(gc, user, id) {
  const p = parseApiId(id);
  if (!p) throw actionError('SCHULE_MESSAGE_NOT_FOUND');
  const box = (await inboxesOf(gc, user)).find((b) => b.acc.id === p.accountId);
  const m = box ? await store.getMessage(gc, p.accountId, p.msgId) : null;
  if (!m) throw actionError('SCHULE_MESSAGE_NOT_FOUND');
  return { m, acc: box.acc, studentIds: box.studentIds };
}

/** The message as `user` sees it now (after an action). */
async function viewOne(gc, user, accountId, msgId, studentIds, now, opts = {}) {
  const m = await store.getMessage(gc, accountId, msgId);
  return messageView(m, studentIds, now, await contextFor(gc, user, [m], opts));
}

// One WebUntis session at a time per account for the actions (logins in a row could lock the account).
const locks = new Map();
function withAccount(accId, fn) {
  const prev = locks.get(accId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(accId, tail);
  tail.then(() => { if (locks.get(accId) === tail) locks.delete(accId); });
  return run;
}

/** A WebUntis session of `acc` for `fn(client)` (login → fn → logout); SCHULE_UNTIS_UNAVAILABLE when no login. */
async function withSession(gc, acc, fn, now) {
  return withAccount(acc.id, async () => {
    const cred = await store.getCred(gc, acc);
    if (!cred) throw actionError('SCHULE_UNTIS_UNAVAILABLE');
    let client = null;
    try {
      client = untis.createClient(gc, acc);
      try { await client.login(cred, now); } catch (e) {
        gc.log.info('webuntis login for a message action failed', acc.id, untis.codeOf(e));
        throw actionError('SCHULE_UNTIS_UNAVAILABLE');
      }
      return await fn(client);
    } finally {
      if (client && client.loggedIn) await client.logout();
    }
  });
}

/** POST …/messages/<id>/read → the message (opened by `user`). */
async function markRead(gc, user, id, now, opts = {}) {
  const { m, studentIds } = await accessible(gc, user, id);
  await store.markRead(gc, m, user.id, now);
  return viewOne(gc, user, m.account_id, m.msg_id, studentIds, now, opts);
}

/** POST …/messages/<id>/confirm → the message after the read confirmation went to the school. */
async function confirm(gc, user, id, now, opts = {}) {
  const { m, acc, studentIds } = await accessible(gc, user, id);
  if (!m.confirm_required) throw actionError('SCHULE_CONFIRM_NOT_REQUIRED');
  if (m.confirmed_at == null) {
    const at = await withSession(gc, acc, async (client) => {
      try { return await client.confirmRead(m.msg_id); } catch (e) {
        const code = untis.codeOf(e);
        gc.log.warn('read confirmation failed', acc.id, code);
        throw actionError(code === 'network' ? 'SCHULE_UNTIS_UNAVAILABLE' : 'SCHULE_CONFIRM_FAILED');
      }
    }, now);
    await store.setConfirmed(gc, m, at || now, user.id);
    gc.log.info('read confirmation sent', acc.id);
  }
  await store.markRead(gc, m, user.id, now);
  return viewOne(gc, user, m.account_id, m.msg_id, studentIds, now, opts);
}

/**
 * POST …/messages/<id>/attachments/<attId> → { mediaId, name, mime, bytes } (fetched now unless it is
 * in the media store already); pages also get `url`.
 */
async function attachment(gc, user, id, attId, now, opts = {}) {
  const { m, acc } = await accessible(gc, user, id);
  const idx = m.attachments.findIndex((a) => a.id === String(attId || ''));
  if (idx < 0) throw actionError('SCHULE_ATTACHMENT_NOT_FOUND');
  if (!canFetchMedia(gc)) throw actionError('SCHULE_GATECONTROL_TOO_OLD');
  let att = m.attachments[idx];
  let info = null;
  if (att.mediaId) { try { info = await gc.media.info(att.mediaId); } catch { info = null; } }
  if (!info) {
    if (att.size != null && att.size > ATT_MAX_BYTES) throw actionError('SCHULE_ATTACHMENT_TOO_LARGE');
    att = await withSession(gc, acc, async (client) => {
      try { return await fetchAttachment(gc, client, { ...att, mediaId: undefined }); } catch (e) {
        const c = e && e.code;
        throw actionError(c === 'too_large' ? 'SCHULE_ATTACHMENT_TOO_LARGE' : c === 'type' ? 'SCHULE_ATTACHMENT_TYPE'
          : c === 'network' ? 'SCHULE_UNTIS_UNAVAILABLE' : 'SCHULE_ATTACHMENT_FAILED');
      }
    }, now);
    const fresh = await store.getMessage(gc, m.account_id, m.msg_id);
    const list2 = (fresh || m).attachments.map((a) => (a.id === att.id ? att : a));
    await store.setAttachments(gc, m, list2);
    try { info = await gc.media.info(att.mediaId); } catch { info = null; }
  }
  const out = { mediaId: att.mediaId, name: att.name, mime: (info && info.mime) || att.mime || FALLBACK_MIME, bytes: info && Number.isSafeInteger(info.bytes) ? info.bytes : att.size };
  if (opts.urls && gc.media.url) out.url = await gc.media.url(att.mediaId, { user: user.id, ttlS: 3600 });
  return out;
}

/** The media hook: may `user` read the media file `mediaId` (an attachment of a message he may read)? */
async function mayReadMedia(gc, user, mediaId) {
  if (!user || !Number.isInteger(user.id)) return false;
  const m = await store.messageOfMedia(gc, mediaId);
  if (!m) return false;
  return (await inboxesOf(gc, user)).some((b) => b.acc.id === m.account_id);
}

// ─── Pushes ─────────────────────────────────────

/**
 * The push of one message → { title, body, card }. 1.5.1: `card` (GateControl ≥ 1.191.0; older hosts ignore it) is
 * what a chat shows when the person routed the topic into a chat (Messenger 1.6.0): the sender and the whole text
 * (≤ 4000) and the link "Ganze Nachricht lesen" to the plugin's app route (the push data carries the message id).
 */
function pushOf(m, lang) {
  // 1.5.0: from the full text once the detail is there (the cycle fetches it before the push)
  const text = m.full_text && m.body ? oneLine(m.body, 300) : m.preview;
  const body = [m.sender, text].filter(Boolean).join(': ') || t(lang, 'msg.push_open');
  const full = (m.full_text && m.body) || m.preview || '';
  const cardText = [m.sender ? t(lang, 'msg.card_from', { sender: m.sender }) : null, full].filter(Boolean).join('\n\n');
  // GateControl needs a text in a card: without one (nothing fetched yet, no sender) the push goes without a card
  const card = cardText ? { text: clipText(cardText, CARD_TEXT_MAX), link: { label: t(lang, 'msg.card_link'), route: ROUTE } } : null;
  return { title: t(lang, 'msg.push_title', { subject: m.subject || t(lang, 'msg.no_subject') }), body, card };
}

/** The summary push of further messages → { title, body } */
function summaryOf(rest, lang) {
  const lines = rest.slice(0, MAX_LINES).map((m) => [m.sender, m.subject || t(lang, 'msg.no_subject')].filter(Boolean).join(': '));
  if (rest.length > MAX_LINES) lines.push(t(lang, 'push.more', { n: rest.length - MAX_LINES }));
  return { title: t(lang, rest.length === 1 ? 'msg.push_more_one' : 'msg.push_more', { n: rest.length }), body: lines.join('\n') };
}

const throttled = (r) => r.error === 'THROTTLED' || r.error === 'ERR_RATE_LIMIT';

/**
 * Send (or hold) the new messages. → { sent, held, expired }
 */
async function dispatch(gc, notifier, cfg, now, quiet) {
  const open = await store.messagesWithStatus(gc, quiet ? ['pending'] : ['pending', 'held']);
  if (!open.length) return { sent: 0, held: 0, expired: 0 };
  if (quiet) {
    await store.setMessageStatus(gc, open, 'held');
    return { sent: 0, held: open.length, expired: 0 };
  }
  const users = new Set();
  try { for (const u of await gc.users.list()) users.add(u.id); } catch { /* none */ }
  const accounts = new Map((await store.listAccounts(gc)).map((a) => [a.id, a]));
  const students = await store.listStudents(gc);
  const byAcc = new Map();
  for (const m of open) {
    if (!byAcc.has(m.account_id)) byAcc.set(m.account_id, []);
    byAcc.get(m.account_id).push(m);
  }
  let sent = 0;
  let expired = 0;
  for (const [aid, msgs] of byAcc) {
    const acc = accounts.get(aid);
    const live = acc ? liveOf(acc, students) : [];
    const stale = msgs.filter((m) => !acc || !live.length || now - m.detected_at > EXPIRE_MS);
    if (stale.length) { await store.setMessageStatus(gc, stale, 'expired'); expired += stale.length; }
    const fresh = msgs.filter((m) => !stale.includes(m));
    if (!fresh.length) continue;
    const to = recipientsOf(acc, live, users);
    if (!to.length) { await store.setMessageStatus(gc, fresh, 'no_recipients'); continue; }
    const extra = live.length === 1 ? { studentId: live[0].id } : {};
    let stop = false;
    for (const m of fresh.slice(0, MAX_PUSH)) {
      const { title, body, card } = pushOf(m, cfg.lang);
      const r = await notifier.send({
        topic: TOPIC, title: oneLine(title, 120), body: clipText(body, 1000), priority: 'normal', users: to,
        collapseKey: `schule:msg:${aid}:${m.msg_id}`, ttl: 3 * 86400, data: { schule: { messageId: apiId(m), ...extra } }, card,
      });
      if (r.sent) { await store.setMessageStatus(gc, [m], 'sent', now); sent += 1; } else if (throttled(r)) { stop = true; break; } else await store.setMessageStatus(gc, [m], 'failed');
    }
    const rest = fresh.slice(MAX_PUSH);
    if (stop || !rest.length) continue;
    const { title, body } = summaryOf(rest, cfg.lang);
    const r = await notifier.send({
      topic: TOPIC, title: oneLine(title, 120), body: clipText(body, 1000), priority: 'normal', users: to,
      collapseKey: `schule:msg:${aid}:more`, ttl: 3 * 86400, data: { schule: { messageId: apiId(rest[rest.length - 1]), ...extra } },
    });
    if (r.sent) { await store.setMessageStatus(gc, rest, 'sent', now); sent += 1; } else if (!throttled(r)) await store.setMessageStatus(gc, rest, 'failed');
  }
  return { sent, held: 0, expired };
}

module.exports = {
  GAP_MS, KEEP_MS, NEW_MS, MAX_PUSH, TOPIC, ATT_MAX_BYTES, ATT_TRIES,
  stripHtml, decodeEntities, parseSent, messageRows, fetchAccount, isStudentAccount, canViewMessages, recipientsOf, inboxesOf,
  messageView, listFor, forStudents, pushOf, summaryOf, dispatch, apiId,
  detailOf, mimeOf, fileName, parseApiId, markRead, confirm, attachment, mayReadMedia, accessible,
};
