'use strict';

// The server's copy of the mail: what the sync engines (imap.js, graph.js) bring is written here — headers with the
// thread and the tab, bodies, attachments — and the senders become contacts. Everything an engine hands over is plain:
//
//   header = { uid?, remoteId?, messageId, inReplyTo, refs: [], conv?, date (ms), from: { name, email }, to, cc, bcc,
//              replyTo: [{ name, email }], subject, unread, flagged, answered, hasAtt, size, listId, precedence,
//              autoSubmitted, listUnsub: { url?, mail? } | null, inference ('focused'|'other'|null), snippet? }

const store = require('./store');
const classify = require('./classify');
const { clip, line, snippet, bytesOf, htmlText, parse } = require('./util');

const MSGID_RE = /^<?[^\s<>]{1,250}>?$/;
const FOLDERS_MAX = 1000;     // folders per account (imap.js, graph.js): more would stretch a sync of all folders too far
const hinted = new WeakMap(); // gc → Map account id → the last hint that folders stay out
const normId = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || !MSGID_RE.test(s)) return null;
  return s.startsWith('<') ? s : `<${s.replace(/>$/, '')}>`;
};
const addrList = (l) => (Array.isArray(l) ? l : []).map((p) => ({ name: clip(line(p && p.name), 120), email: String((p && (p.email || p.address)) || '').toLowerCase().slice(0, 254) }))
  .filter((p) => p.email).slice(0, 200);

/** The thread a new message joins (Graph's conversation, else Message-ID / In-Reply-To / References), or null. */
async function threadOf(gc, userId, accountId, h) {
  if (h.conv) {
    const r = await store.one(gc, 'SELECT thread_id FROM messages WHERE account_id = ? AND conv = ? AND thread_id IS NOT NULL LIMIT 1', [accountId, h.conv]);
    if (r) return r.thread_id;
  }
  const ids = [h.inReplyTo, ...(h.refs || [])].map(normId).filter(Boolean).slice(-20);
  if (ids.length) {
    const r = await store.one(gc, `SELECT thread_id FROM messages WHERE user_id = ? AND message_id IN (${store.marks(ids.length)}) AND thread_id IS NOT NULL LIMIT 1`, [userId, ...ids]);
    if (r) return r.thread_id;
  }
  const own = normId(h.messageId);
  if (own) {
    // an answer arrived before it (or the same mail in another folder)
    const r = await store.one(gc, 'SELECT thread_id FROM messages WHERE user_id = ? AND (in_reply_to = ? OR message_id = ?) AND thread_id IS NOT NULL LIMIT 1', [userId, own, own]);
    if (r) return r.thread_id;
  }
  return null;
}

/**
 * Write header `h` of folder `f` of account `a` → { id, created }. A new one gets its thread and, in a posteingang, its
 * tab (classify.js). `arrival`: it came in now (a push may follow); otherwise (the first sync, an older one) not.
 */
async function upsert(gc, a, f, h, { arrival = false, now = Date.now() } = {}) {
  const key = h.uid != null ? ['uid', h.uid] : ['remote_id', h.remoteId];
  const have = await store.one(gc, `SELECT id, unread, flagged, answered FROM messages WHERE folder_id = ? AND ${key[0]} = ?`, [f.id, key[1]]);
  if (have) {
    const u = h.unread ? 1 : 0; const fl = h.flagged ? 1 : 0; const an = h.answered ? 1 : 0;
    if (u !== have.unread || fl !== have.flagged || an !== have.answered) {
      await store.run(gc, 'UPDATE messages SET unread = ?, flagged = ?, answered = ? WHERE id = ?', [u, fl, an, have.id]);
    }
    return { id: have.id, created: false, changed: u !== have.unread || fl !== have.flagged || an !== have.answered };
  }
  const from = addrList([h.from])[0] || { name: '', email: '' };
  const msgId = normId(h.messageId);
  const inReplyTo = normId(h.inReplyTo);
  const refs = (h.refs || []).map(normId).filter(Boolean).slice(-30);
  let tab = 'relevant';
  let by = null;
  let aiPending = 0;
  if (f.role === 'inbox') {
    const t = await classify.byRules(gc, { userId: a.user_id, fromEmail: from.email, listId: h.listId, precedence: h.precedence, autoSubmitted: h.autoSubmitted, listUnsub: h.listUnsub, inReplyTo, inference: h.inference });
    tab = t.tab;
    by = t.by;
    aiPending = t.sure ? 0 : 1;
  }
  const thread = await threadOf(gc, a.user_id, a.id, { ...h, inReplyTo, refs, messageId: msgId });
  const date = Number.isFinite(h.date) && h.date > 0 ? h.date : now;
  const r = await store.run(gc, `INSERT INTO messages (user_id, account_id, folder_id, uid, remote_id, message_id, in_reply_to, refs, conv, thread_id, date,
      from_name, from_email, to_json, cc_json, bcc_json, reply_to_json, subject, snippet, unread, flagged, answered, has_att, size, tab, tab_by, list_id,
      bulk, unsub_json, ai_pending, notified, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    a.user_id, a.id, f.id, h.uid == null ? null : h.uid, h.remoteId == null ? null : String(h.remoteId), msgId, inReplyTo, refs.length ? refs.join(' ') : null,
    h.conv || null, thread, date, from.name, from.email, JSON.stringify(addrList(h.to)), JSON.stringify(addrList(h.cc)), JSON.stringify(addrList(h.bcc)),
    JSON.stringify(addrList(h.replyTo)), clip(line(h.subject || ''), 500), clip(line(h.snippet || ''), 160), h.unread ? 1 : 0, h.flagged ? 1 : 0,
    h.answered ? 1 : 0, h.hasAtt ? 1 : 0, Number(h.size) || 0, tab, by, h.listId ? clip(String(h.listId), 200) : null,
    h.listId || (h.precedence && /^(bulk|list)$/i.test(h.precedence)) ? 1 : 0, h.listUnsub ? JSON.stringify(h.listUnsub) : null, aiPending,
    arrival && f.role === 'inbox' && h.unread ? 0 : 1, now,
  ]);
  const id = Number(r.lastInsertRowid);
  if (thread == null) await store.run(gc, 'UPDATE messages SET thread_id = ? WHERE id = ?', [id, id]);
  // the sender of a received mail becomes a contact (for the suggestions while writing)
  if (f.role === 'inbox' && from.email) await contact(gc, a.user_id, from, 'received', date);
  return { id, created: true };
}

/** A contact of the person: 'sent' (the person wrote to them) or 'received'. */
async function contact(gc, userId, p, kind, at) {
  if (!p || !p.email) return;
  const col = kind === 'sent' ? 'sent' : 'received';
  await store.run(gc, `INSERT INTO contacts (user_id, email, name, ${col}, last_at) VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(user_id, email) DO UPDATE SET ${col} = ${col} + 1, last_at = MAX(last_at, excluded.last_at), name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE name END`,
  [userId, p.email.toLowerCase(), clip(line(p.name || ''), 120), at]);
}

/**
 * The body of message `id`: { html (sanitized, external pictures gc-img:<n>), text, images: [url], trackers } → bytes.
 * The snippet follows when it was empty.
 */
async function setBody(gc, id, b, now) {
  const html = b.html == null ? null : String(b.html);
  const text = b.text != null && String(b.text).trim() ? String(b.text) : (html ? htmlText(html) : '');
  const bytes = bytesOf(html) + bytesOf(text) + 256;
  await store.run(gc, `INSERT INTO bodies (message_id, html, text, images_json, trackers, bytes, at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET html = excluded.html, text = excluded.text, images_json = excluded.images_json, trackers = excluded.trackers,
    bytes = excluded.bytes, at = excluded.at, used_at = excluded.used_at`,
  [id, html, text, JSON.stringify(Array.isArray(b.images) ? b.images.slice(0, 500) : []), Number(b.trackers) || 0, bytes, now, now]);
  await store.run(gc, "UPDATE messages SET body_state = 'stored', snippet = CASE WHEN snippet = '' THEN ? ELSE snippet END WHERE id = ?", [snippet(text), id]);
  return bytes;
}

/**
 * The attachments of message `id` (from the parsed mail) — rows kept by part (their cached copy and where they went in
 * Drive stay). list: [{ partId?, remoteId?, filename, contentType, size, contentId, inline, checksum, mediaId? }]
 */
async function setAttachments(gc, id, list, now) {
  const have = await store.all(gc, 'SELECT * FROM attachments WHERE message_id = ?', [id]);
  const keyOf = (x) => String(x.partId != null ? x.partId : x.remoteId != null ? x.remoteId : x.part_id != null ? x.part_id : x.remote_id);
  const seen = new Set();
  for (const x of (Array.isArray(list) ? list : []).slice(0, 100)) {
    const k = keyOf(x);
    seen.add(k);
    const old = have.find((r) => keyOf(r) === k);
    const name = clip(line(x.filename || x.name || '') || 'Anhang', 200);
    const mime = String(x.contentType || x.mime || 'application/octet-stream').toLowerCase().split(';')[0].trim().slice(0, 120) || 'application/octet-stream';
    const cid = x.contentId ? String(x.contentId).replace(/^<|>$/g, '').slice(0, 250) : null;
    if (old) {
      await store.run(gc, 'UPDATE attachments SET name = ?, mime = ?, size = ?, inline = ?, cid = ?, checksum = COALESCE(?, checksum) WHERE id = ?',
        [name, mime, Number(x.size) || old.size || 0, x.inline ? 1 : 0, cid, x.checksum || null, old.id]);
      continue;
    }
    await store.run(gc, `INSERT INTO attachments (message_id, part_id, remote_id, name, mime, size, inline, cid, checksum, media_id, media_bytes, used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, x.partId != null ? String(x.partId) : null, x.remoteId != null ? String(x.remoteId) : null, name, mime,
      Number(x.size) || 0, x.inline ? 1 : 0, cid, x.checksum || null, x.mediaId || null, x.mediaId ? Number(x.size) || 0 : null, x.mediaId ? now : null]);
  }
  for (const r of have) if (!seen.has(keyOf(r)) && !r.saved_node) await dropAttachment(gc, r);
  const real = (Array.isArray(list) ? list : []).some((x) => !x.inline);
  await store.run(gc, 'UPDATE messages SET has_att = ? WHERE id = ?', [real ? 1 : 0, id]);
}

async function dropAttachment(gc, r) {
  if (r.media_id) { try { await gc.media.delete(r.media_id); } catch { /* gone */ } }
  await store.run(gc, 'DELETE FROM attachments WHERE id = ?', [r.id]);
  await store.run(gc, 'DELETE FROM filing WHERE attachment_id = ?', [r.id]);
}

/** Messages `ids` go (the server forgot them, or they left the retention): bodies, attachments and their copies too. */
async function remove(gc, ids) {
  for (const part of store.chunks(ids)) {
    const m = store.marks(part.length);
    for (const r of await store.all(gc, `SELECT id, media_id FROM attachments WHERE message_id IN (${m}) AND media_id IS NOT NULL`, part)) {
      try { await gc.media.delete(r.media_id); } catch { /* gone */ }
    }
    await store.run(gc, `DELETE FROM filing WHERE message_id IN (${m})`, part);
    await store.run(gc, `DELETE FROM attachments WHERE message_id IN (${m})`, part);
    await store.run(gc, `DELETE FROM bodies WHERE message_id IN (${m})`, part);
    await store.run(gc, `DELETE FROM ai_results WHERE message_id IN (${m})`, part);
    await store.run(gc, `DELETE FROM image_once WHERE message_id IN (${m})`, part);
    await store.run(gc, `DELETE FROM messages WHERE id IN (${m})`, part);
  }
}

/** The person's bytes on the server: bodies + cached attachments. */
async function usage(gc, userId) {
  const b = await store.one(gc, 'SELECT COALESCE(SUM(b.bytes), 0) AS n FROM bodies b JOIN messages m ON m.id = b.message_id WHERE m.user_id = ?', [userId]);
  const a = await store.one(gc, 'SELECT COALESCE(SUM(t.media_bytes), 0) AS n FROM attachments t JOIN messages m ON m.id = t.message_id WHERE m.user_id = ? AND t.media_id IS NOT NULL', [userId]);
  return Number(b.n) + Number(a.n);
}

/**
 * Over the quota: the oldest bodies and the least used attachment copies go (the headers stay) until 90 % are left.
 * → bytes freed.
 */
async function evict(gc, userId, quota, now) {
  let used = await usage(gc, userId);
  if (used <= quota) return 0;
  const target = Math.floor(quota * 0.9);
  let freed = 0;
  // attachment copies first, least used first
  const atts = await store.all(gc, `SELECT t.id, t.media_id, t.media_bytes FROM attachments t JOIN messages m ON m.id = t.message_id
    WHERE m.user_id = ? AND t.media_id IS NOT NULL ORDER BY COALESCE(t.used_at, 0) LIMIT 2000`, [userId]);
  for (const r of atts) {
    if (used - freed <= target) break;
    try { await gc.media.delete(r.media_id); } catch { /* gone */ }
    await store.run(gc, 'UPDATE attachments SET media_id = NULL, media_bytes = NULL WHERE id = ?', [r.id]);
    freed += Number(r.media_bytes) || 0;
  }
  if (used - freed > target) {
    const bodies = await store.all(gc, `SELECT b.message_id, b.bytes FROM bodies b JOIN messages m ON m.id = b.message_id WHERE m.user_id = ?
      ORDER BY m.date, b.used_at LIMIT 5000`, [userId]);
    const gone = [];
    for (const r of bodies) {
      if (used - freed <= target) break;
      gone.push(r.message_id);
      freed += Number(r.bytes) || 0;
    }
    for (const part of store.chunks(gone)) {
      await store.run(gc, `DELETE FROM bodies WHERE message_id IN (${store.marks(part.length)})`, part);
      await store.run(gc, `UPDATE messages SET body_state = 'evicted' WHERE id IN (${store.marks(part.length)})`, part);
    }
  }
  used -= freed;
  return freed;
}

/** A message row → the Summary of the API. */
function summary(r, extra = {}) {
  const to = parse(r.to_json, []);
  return {
    id: r.id, accountId: r.account_id, folderId: r.folder_id, threadId: r.thread_id || r.id, threadCount: r.thread_count || 1,
    from: { name: r.from_name || '', email: r.from_email || '' }, to: to.slice(0, 3).map((p) => ({ name: p.name || '', email: p.email })),
    subject: r.subject || '', snippet: r.snippet || '', date: r.date, unread: r.unread === 1, flagged: r.flagged === 1, answered: r.answered === 1,
    hasAttachments: r.has_att === 1, tab: r.tab === 'other' ? 'other' : 'relevant', savedToDrive: r.saved_count > 0,
    ai: r.ai_summary != null ? { summary: r.ai_summary } : null,
    // since 1.2.0: an invitation in this mail (the list shows „Einladung“)
    invite: ['request', 'cancel', 'reply', 'counter'].includes(r.invite) ? r.invite : null, ...extra,
  };
}

/**
 * A hint in the log that folders of an account stay out — `over` beyond FOLDERS_MAX ("n+": pages not asked for), `deep`
 * below the levels graph.js lists — when it changes, not every run. No error: the account syncs the folders it has.
 */
function folderHint(gc, accountId, kept, over, deep) {
  const parts = [];
  if (over) parts.push(`${over} beyond ${FOLDERS_MAX}`);
  if (deep) parts.push(`${deep} too deep`);
  const note = parts.length ? `${kept} kept, ${parts.join(', ')}` : '';
  if (!hinted.has(gc)) hinted.set(gc, new Map());
  const last = hinted.get(gc);
  if ((last.get(accountId) || '') === note) return;
  if (note) { last.set(accountId, note); gc.log.info('folders left out', accountId, note); } else last.delete(accountId);
}

module.exports = { FOLDERS_MAX, folderHint, upsert, contact, setBody, setAttachments, dropAttachment, remove, usage, evict, summary, normId, addrList, threadOf };
