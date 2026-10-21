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

const store = require('./store');
const untis = require('./untis');
const tz = require('./tz');
const views = require('./views');
const extras = require('./extras');
const notify = require('./notify');
const texts = require('./texts.json');

const MIN = 60000;
const DAY = 86400000;
const GAP_MS = 15 * MIN;
const KEEP_MS = 90 * DAY;
const NEW_MS = DAY;
const EXPIRE_MS = 3 * DAY;
const MAX_PUSH = 3;
const MAX_LINES = 6;
const TOPIC = 'messages';
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
    });
    if (out.length >= 300) break;
  }
  return out;
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
const isNew = (m, now) => m.status !== 'baseline' && now - m.detected_at < NEW_MS;

/** A stored message → the API shape. */
function messageView(m, studentIds, now) {
  const out = { id: apiId(m), accountId: m.account_id, studentIds: studentIds.slice(), subject: m.subject, preview: m.preview };
  if (m.body) out.body = m.body;
  out.sender = m.sender;
  out.sentAt = new Date(m.sent_at != null ? m.sent_at : m.detected_at).toISOString();
  out.hasAttachments = m.has_attachments;
  out.isNew = isNew(m, now);
  return out;
}

/** app/messages: the messages `user` may read of the last `days` days, newest first, ≤ `limit`. */
async function listFor(gc, user, days, now, limit = 100) {
  const boxes = await inboxesOf(gc, user);
  if (!boxes.length) return [];
  const byAcc = new Map(boxes.map((b) => [b.acc.id, b.studentIds]));
  const rows = await store.listMessages(gc, [...byAcc.keys()], now - days * DAY, limit);
  return rows.map((m) => messageView(m, byAcc.get(m.account_id) || [], now));
}

/**
 * The Schule page / portal: per student the messages of its account's inbox when `user` may read it
 * (Map studentId → [messageView], ≤ 20 of the last 30 days). Students whose inbox he may not read
 * are not in the map.
 */
async function forStudents(gc, user, students, now) {
  const out = new Map();
  const boxes = await inboxesOf(gc, user);
  if (!boxes.length) return out;
  for (const b of boxes) {
    if (!students.some((s) => s.account_id === b.acc.id)) continue;
    const mine = (await store.listMessages(gc, [b.acc.id], now - 30 * DAY, 20)).map((m) => messageView(m, b.studentIds, now));
    for (const s of students) if (s.account_id === b.acc.id) out.set(s.id, mine);
  }
  return out;
}

// ─── Pushes ─────────────────────────────────────

/** The push of one message → { title, body } */
function pushOf(m, lang) {
  const body = [m.sender, m.preview].filter(Boolean).join(': ') || t(lang, 'msg.push_open');
  return { title: t(lang, 'msg.push_title', { subject: m.subject || t(lang, 'msg.no_subject') }), body };
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
      const { title, body } = pushOf(m, cfg.lang);
      const r = await notifier.send({
        topic: TOPIC, title: oneLine(title, 120), body: clipText(body, 1000), priority: 'normal', users: to,
        collapseKey: `schule:msg:${aid}:${m.msg_id}`, ttl: 3 * 86400, data: { schule: { messageId: apiId(m), ...extra } },
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
  GAP_MS, KEEP_MS, NEW_MS, MAX_PUSH, TOPIC,
  stripHtml, decodeEntities, parseSent, messageRows, fetchAccount, isStudentAccount, canViewMessages, recipientsOf, inboxesOf,
  messageView, listFor, forStudents, pushOf, summaryOf, dispatch, apiId,
};
