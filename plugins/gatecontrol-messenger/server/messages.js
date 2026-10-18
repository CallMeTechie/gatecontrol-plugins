'use strict';

// Messages: the view a member gets, sending (idempotent by clientId), editing
// and deleting within the administrator's window, reactions (one per person),
// read marks, search, the media of a conversation. Every function gets `ctx`
// = { gc, viewer (user id), now, users (Map), cfg, portal (frame viewer: signed
// media URLs), box (live.outbox: events/pushes sent after the commit) }.

const store = require('./store');
const seal = require('./seal');
const live = require('./live');
const people = require('./people');
const log = require('./log');
const { fail, posInt, multiline, optText, numIn, intIn, iso, parseIso } = require('./util');

const TEXT_MAX = 4000;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;
const SEARCH_SCAN = 2000;
const SEARCH_RESULTS = 50;
const THUMB_MAX = 64 * 1024;
// 1.3.0: the preview picture of a file message (video frame, first PDF page): these types only, ≤ 640 px a
// side — the side is the sender's promise (the plugin cannot read the bytes of an upload), checked by the host
// again when the preview becomes a push picture.
const FILE_THUMB_TYPES = ['image/webp', 'image/jpeg', 'image/png'];
const THUMB_MAX_SIDE = 640;
const VIDEO_MAX_MS = 24 * 3600 * 1000;
const VIDEO_MAX_SIDE = 16384;
const isVideo = (mime) => typeof mime === 'string' && /^video\//i.test(mime);
/** What the server supports beyond 1.0 (GET me features: clients check before sending these fields). */
const FEATURES = ['video_meta', 'file_thumbs'];
const URL_TTL_S = 6 * 3600;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const KINDS = ['text', 'image', 'voice', 'file', 'location', 'poll', 'event', 'arrival', 'action'];
// 1.4.0: kinds whose content is an object (poll, event, arrival, action — card only through the service)
const RICH = ['poll', 'event', 'arrival', 'action'];
const EDITABLE = ['text', 'image', 'file'];
const EMOJI_MAX = 16;
const RICH_VIEW = ['poll', 'event', 'arrival', 'action', 'card'];
const REPLY_PREVIEW = 200;

// ─── reading ────────────────────────────────────────────────────────────────

/** The text of a message row (undefined when it cannot be decrypted). */
function bodyOf(row) { return seal.open(row.body_enc); }
function metaOf(row) { const m = seal.openJson(row.meta_enc); return m === undefined ? undefined : (m || {}); }

/** May the member `me` see message row `m`? (not before joining; hidden rows are filtered by the queries) */
const visibleTo = (m, me) => m && m.conv_id === me.conv_id && m.id > me.joined_msg_id;

/** A signed URL for frames (null for the apps or when the host refuses). */
async function mediaUrl(ctx, id) {
  if (!ctx.portal || !id) return null;
  try { return await ctx.gc.media.url(id, { user: ctx.viewer, ttlS: URL_TTL_S }); } catch { return null; }
}

/**
 * Message rows → API objects for the viewer. `rc` = the conversation's receipts
 * ({ readUpTo, deliveredUpTo }) for the status of the viewer's own messages.
 */
async function views(ctx, me, rows, rc) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const reactions = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    for (const r of await store.all(ctx.gc, `SELECT msg_id, user_id, emoji FROM reactions WHERE msg_id IN (${store.marks(part.length)}) ORDER BY at, user_id`, part)) {
      if (!reactions.has(r.msg_id)) reactions.set(r.msg_id, []);
      reactions.get(r.msg_id).push(r);
    }
  }
  const replyIds = [...new Set(rows.map((r) => r.reply_to).filter(Boolean))];
  const replies = new Map();
  for (let i = 0; i < replyIds.length; i += 90) {
    const part = replyIds.slice(i, i + 90);
    for (const r of await store.all(ctx.gc, `SELECT * FROM messages WHERE id IN (${store.marks(part.length)})`, part)) replies.set(r.id, r);
  }
  const hiddenReplies = new Set();
  if (replyIds.length) {
    for (const r of await store.all(ctx.gc, `SELECT msg_id FROM hidden WHERE user_id = ? AND msg_id IN (${store.marks(Math.min(replyIds.length, 90))})`, [ctx.viewer, ...replyIds.slice(0, 90)])) hiddenReplies.add(r.msg_id);
  }
  const out = [];
  for (const r of rows) out.push(await view(ctx, me, r, rc, reactions.get(r.id) || [], replies, hiddenReplies));
  if (rows.some((r) => RICH_VIEW.includes(r.kind) && !r.deleted_at)) await require('./rich').decorate(ctx, rows, out);
  return out;
}

function reactionList(list) {
  const by = new Map();
  for (const x of list) {
    if (!by.has(x.emoji)) by.set(x.emoji, []);
    by.get(x.emoji).push(x.user_id);
  }
  return [...by.entries()].map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds }));
}

/** A short preview of a message for quotes: { id, senderId, kind, text, deleted, missing }. */
function quote(r, me, hidden, id) {
  if (!r || !visibleTo(r, me) || hidden.has(r.id)) return { id, senderId: null, kind: null, text: null, deleted: false, missing: true };
  if (r.deleted_at) return { id: r.id, senderId: r.sender_id, kind: r.kind, text: null, deleted: true, missing: false };
  const meta = metaOf(r) || {};
  let t = bodyOf(r);
  if (!t && r.kind === 'file') t = meta.fileName || null;
  if (!t && r.kind === 'location' && meta.location) t = meta.location.label || null;
  if (!t) t = require('./rich').summaryText(r.kind, meta);
  return { id: r.id, senderId: r.sender_id, kind: r.kind, text: typeof t === 'string' ? t.slice(0, REPLY_PREVIEW) : null, deleted: false, missing: false };
}

async function view(ctx, me, r, rc, reacts, replies, hiddenReplies) {
  const mine = r.sender_id != null && r.sender_id === ctx.viewer;
  const base = {
    id: r.id, conversationId: r.conv_id, senderId: r.sender_id, clientId: r.client_id || null, kind: r.kind,
    via: r.via || null, mine, createdAt: iso(r.created_at), editedAt: iso(r.edited_at), deletedAt: iso(r.deleted_at),
    expiresAt: iso(r.expires_at), deleted: !!r.deleted_at, undecryptable: false,
    text: null, replyTo: null, media: null, meta: null, location: null, system: null, reactions: [], status: null,
    thumbMediaId: null, video: null,
    // 1.4.0
    poll: null, event: null, arrival: null, action: null, card: null, replyStory: null,
  };
  if (mine && rc) {
    base.status = rc.readUpTo != null && r.id <= rc.readUpTo ? 'read' : (rc.deliveredUpTo != null && r.id <= rc.deliveredUpTo ? 'delivered' : 'sent');
  }
  if (r.deleted_at) return base;
  const text = bodyOf(r);
  const meta = metaOf(r);
  if (text === undefined || meta === undefined) {
    base.undecryptable = true;
    await log.add(ctx.gc, 'decrypt_failed', null, ctx.now);
  }
  base.text = typeof text === 'string' ? text : null;
  const m = meta || {};
  if (r.kind === 'system') {
    base.system = m.system && typeof m.system === 'object' ? m.system : { event: 'notice' };
  }
  if (r.kind === 'location' && m.location) base.location = m.location;
  const metaOut = {};
  for (const k of ['durationMs', 'waveform', 'w', 'h', 'fileName']) if (m[k] != null) metaOut[k] = m[k];
  base.meta = Object.keys(metaOut).length ? metaOut : null;
  base.thumbMediaId = r.thumb_media_id || null;
  if (r.kind === 'file' && m.video && typeof m.video === 'object') {
    const v = m.video;
    base.video = { durationMs: v.durationMs != null ? v.durationMs : null, width: v.width != null ? v.width : null, height: v.height != null ? v.height : null };
  }
  if (r.media_id) {
    const row = await store.one(ctx.gc, 'SELECT mime, bytes FROM media WHERE media_id = ?', [r.media_id]);
    base.media = {
      id: r.media_id, mime: row ? row.mime : null, bytes: row ? row.bytes : null, url: await mediaUrl(ctx, r.media_id),
      thumbId: r.thumb_media_id || null, thumbUrl: await mediaUrl(ctx, r.thumb_media_id),
    };
  }
  if (r.reply_to) base.replyTo = quote(replies.get(r.reply_to), me, hiddenReplies, r.reply_to);
  if (m.replyStory && typeof m.replyStory === 'object') base.replyStory = m.replyStory;
  base.reactions = reactionList(reacts);
  return base;
}

/** SQL condition for the messages a member sees (alias m): after joining, not hidden for them. */
const VISIBLE_SQL = 'm.conv_id = ? AND m.id > ? AND NOT EXISTS (SELECT 1 FROM hidden h WHERE h.msg_id = m.id AND h.user_id = ?)';
const visibleArgs = (me) => [me.conv_id, me.joined_msg_id, me.user_id];

/** The newest message the member sees, or null. */
async function lastVisible(gc, me) {
  return store.one(gc, `SELECT m.* FROM messages m WHERE ${VISIBLE_SQL} ORDER BY m.id DESC LIMIT 1`, visibleArgs(me));
}

/** Unread messages of a member: from others (and notices of plugins), not deleted, after last_read_id. */
async function unreadCount(gc, me) {
  const r = await store.one(gc, `SELECT COUNT(*) AS n FROM messages m WHERE ${VISIBLE_SQL} AND m.id > ? AND m.deleted_at IS NULL
    AND ((m.sender_id IS NOT NULL AND m.sender_id != ?) OR (m.sender_id IS NULL AND m.via IS NOT NULL))`, [...visibleArgs(me), me.last_read_id, me.user_id]);
  return r ? r.n : 0;
}

/**
 * GET conversations/:id/messages?before=|after=|changedSince=|around=&limit= → { messages (ascending), hasMore }
 * around (1.1.0): the message `around` and the messages before and after it — floor(limit / 2) older ones,
 * the rest from `around` on (the message itself when the member sees it) → also { hasMoreBefore, hasMoreAfter }.
 */
async function page(ctx, me, query, rc) {
  const q = query || {};
  const limit = q.limit == null || q.limit === '' ? PAGE_DEFAULT : posInt(String(q.limit));
  if (!limit || limit > PAGE_MAX) throw fail('invalid');
  const given = (k) => q[k] != null && q[k] !== '';
  const before = given('before') ? posInt(String(q.before)) : null;
  const after = given('after') ? posInt(String(q.after)) : null;
  const around = given('around') ? posInt(String(q.around)) : null;
  const changed = given('changedSince') ? parseIso(String(q.changedSince)) : null;
  if ((given('before') && !before) || (given('after') && !after) || (given('around') && !around) || (given('changedSince') && changed == null)) throw fail('invalid');
  if ([before, after, around, changed].filter((x) => x != null).length > 1) throw fail('invalid');
  let rows;
  if (around) {
    const nBefore = Math.floor(limit / 2);
    const nAfter = limit - nBefore;
    const older = nBefore ? await store.all(ctx.gc, `SELECT m.* FROM messages m WHERE ${VISIBLE_SQL} AND m.id < ? ORDER BY m.id DESC LIMIT ?`, [...visibleArgs(me), around, nBefore + 1]) : [];
    const newer = await store.all(ctx.gc, `SELECT m.* FROM messages m WHERE ${VISIBLE_SQL} AND m.id >= ? ORDER BY m.id ASC LIMIT ?`, [...visibleArgs(me), around, nAfter + 1]);
    const hasMoreBefore = nBefore ? older.length > nBefore
      : !!(await store.one(ctx.gc, `SELECT 1 AS x FROM messages m WHERE ${VISIBLE_SQL} AND m.id < ? LIMIT 1`, [...visibleArgs(me), around]));
    const hasMoreAfter = newer.length > nAfter;
    rows = [...older.slice(0, nBefore).reverse(), ...newer.slice(0, nAfter)];
    return { messages: await views(ctx, me, rows, rc), hasMore: hasMoreBefore || hasMoreAfter, hasMoreBefore, hasMoreAfter };
  }
  if (after) {
    rows = await store.all(ctx.gc, `SELECT m.* FROM messages m WHERE ${VISIBLE_SQL} AND m.id > ? ORDER BY m.id ASC LIMIT ?`, [...visibleArgs(me), after, limit + 1]);
    const hasMore = rows.length > limit;
    rows = rows.slice(0, limit);
    return { messages: await views(ctx, me, rows, rc), hasMore };
  }
  if (changed != null) {
    rows = await store.all(ctx.gc, `SELECT m.* FROM messages m WHERE ${VISIBLE_SQL} AND m.updated_at > ? ORDER BY m.updated_at ASC, m.id ASC LIMIT ?`, [...visibleArgs(me), changed, limit + 1]);
    const hasMore = rows.length > limit;
    rows = rows.slice(0, limit);
    return { messages: await views(ctx, me, rows, rc), hasMore };
  }
  rows = await store.all(ctx.gc, `SELECT m.* FROM messages m WHERE ${VISIBLE_SQL}${before ? ' AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ?`,
    [...visibleArgs(me), ...(before ? [before] : []), limit + 1]);
  const hasMore = rows.length > limit;
  rows = rows.slice(0, limit).reverse();
  return { messages: await views(ctx, me, rows, rc), hasMore };
}

/** A message the member may act on (visible, same rights as reading) or not_found. */
async function visibleMessage(ctx, me, id) {
  const r = await store.one(ctx.gc, 'SELECT * FROM messages WHERE id = ?', [id]);
  if (!r || !visibleTo(r, me)) throw fail('not_found');
  const h = await store.one(ctx.gc, 'SELECT 1 AS x FROM hidden WHERE msg_id = ? AND user_id = ?', [id, ctx.viewer]);
  if (h) throw fail('not_found');
  return r;
}

// ─── sending ────────────────────────────────────────────────────────────────

function cleanText(v, required) {
  if (v == null || v === '') { if (required) throw fail('invalid'); return null; }
  const s = multiline(v);
  if (s == null) throw fail('invalid');
  if (!s) { if (required) throw fail('invalid'); return null; }
  if (s.length > TEXT_MAX) throw fail('invalid');
  return s;
}

function cleanMeta(kind, v, cfg) {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw fail('invalid');
  const out = {};
  if (v.durationMs != null) {
    if (kind !== 'voice' && kind !== 'file') throw fail('invalid');
    out.durationMs = intIn(v.durationMs, 0, 24 * 3600 * 1000);
    if (kind === 'voice' && out.durationMs > cfg.maxVoiceS * 1000 + 1000) throw fail('invalid');
  }
  if (v.waveform != null) {
    if (kind !== 'voice' || !Array.isArray(v.waveform) || v.waveform.length > 64) throw fail('invalid');
    out.waveform = v.waveform.map((x) => intIn(x, 0, 255));
  }
  for (const k of ['w', 'h']) if (v[k] != null) { if (kind !== 'image') throw fail('invalid'); out[k] = intIn(v[k], 1, 20000); }
  if (v.fileName != null) out.fileName = optText(v.fileName, 200);
  if (out.fileName === null) delete out.fileName;
  return out;
}

function cleanLocation(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail('invalid');
  const loc = { lat: numIn(v.lat, -90, 90), lon: numIn(v.lon, -180, 180), label: optText(v.label, 200) };
  if (v.accuracy != null) loc.accuracy = Math.round(numIn(v.accuracy, 0, 100000));
  return loc;
}

/**
 * 1.3.0: `video` { durationMs, width, height } of a file message whose file is video/* — integers, each may be
 * left out (or null) when the sender does not know it; other keys are ignored. → the stored object or null.
 */
function cleanVideo(v, mime) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v) || !isVideo(mime)) throw fail('invalid');
  const out = {};
  if (v.durationMs != null) out.durationMs = intIn(v.durationMs, 0, VIDEO_MAX_MS);
  for (const k of ['width', 'height']) if (v[k] != null) out[k] = intIn(v[k], 1, VIDEO_MAX_SIDE);
  return Object.keys(out).length ? out : null;
}

const MIME_OF_KIND = { image: /^image\//, voice: /^audio\//, file: /./ };

/** Check an upload the sender wants to attach → its info; refuses others' files, used files and wrong types. */
async function checkMedia(ctx, id, kind, { thumb = false } = {}) {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw fail('invalid');
  let info = null;
  try { info = await ctx.gc.media.info(id); } catch { info = null; }
  if (!info || info.owner !== ctx.viewer) throw fail('media_invalid');
  if (thumb ? !/^image\//.test(info.mime) || info.bytes > THUMB_MAX : !MIME_OF_KIND[kind].test(info.mime)) throw fail('media_invalid');
  if (thumb && kind === 'file' && !FILE_THUMB_TYPES.includes(String(info.mime).toLowerCase())) throw fail('media_invalid');
  const used = await store.one(ctx.gc, 'SELECT 1 AS x FROM media WHERE media_id = ?', [id]);
  if (used) throw fail('media_in_use');
  return info;
}

/** Bind an upload to this plugin (gc.media.claim) and record it. */
async function bindMedia(ctx, info, { convId, msgId, role, kind }) {
  try {
    await ctx.gc.media.claim(info.mediaId);
  } catch (e) {
    await log.add(ctx.gc, 'media_claim_failed', (e && e.code) || null, ctx.now);
    throw fail('media_invalid');
  }
  await store.run(ctx.gc, 'INSERT INTO media (media_id, conv_id, msg_id, role, kind, mime, bytes, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [info.mediaId, convId, msgId, role, kind, info.mime, info.bytes, info.owner, ctx.now]);
}

/** Insert a message row (inside a transaction) → its id; moves the conversation forward. */
async function insert(ctx, conv, row) {
  const r = await store.run(ctx.gc, `INSERT INTO messages (conv_id, sender_id, client_id, kind, body_enc, reply_to, media_id, thumb_media_id, meta_enc, via, created_at, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [conv.id, row.senderId, row.clientId || null, row.kind, seal.seal(row.text), row.replyTo || null, row.mediaId || null,
    row.thumbId || null, seal.sealJson(row.meta), row.via || null, ctx.now, conv.disappearing_s > 0 ? ctx.now + conv.disappearing_s * 1000 : null, ctx.now]);
  const id = r.lastInsertRowid;
  await store.run(ctx.gc, 'UPDATE conversations SET last_msg_id = ?, updated_at = ? WHERE id = ?', [id, ctx.now, conv.id]);
  conv.last_msg_id = id;
  // 1.4.0: a new message (not a member change) brings an archived chat back for people with keepArchived off
  if (row.senderId != null || row.via) await unarchive(ctx, conv.id, row.senderId);
  return id;
}

/** Archived chats of the other members come back with a new message unless they keep them archived (prefs.chats.keepArchived). */
async function unarchive(ctx, convId, senderId) {
  const rows = await store.all(ctx.gc, 'SELECT user_id FROM members WHERE conv_id = ? AND archived = 1 AND left_at IS NULL', [convId]);
  const ids = rows.map((x) => x.user_id).filter((u) => u !== senderId);
  if (!ids.length) return;
  const prefs = await people.prefsOf(ctx.gc, ids);
  for (const u of ids) {
    if ((prefs.get(u) || {}).chats && prefs.get(u).chats.keepArchived === false) {
      await store.run(ctx.gc, 'UPDATE members SET archived = 0, updated_at = ? WHERE conv_id = ? AND user_id = ?', [ctx.now, convId, u]);
      if (ctx.box) live.queue(ctx.box, [u], 'conversation.update', { conversationId: convId, reason: 'archive' });
    }
  }
}

/** A system message (member changes, title, disappearing; notices of plugins with text). */
async function system(ctx, conv, event, extra, { text = null, via = null } = {}) {
  const id = await insert(ctx, conv, { senderId: null, kind: 'system', text, meta: { system: { event, ...(extra || {}) } }, via });
  return id;
}

/**
 * POST conversations/:id/messages. `members` = the active member rows.
 * → { message row, duplicate }
 */
async function send(ctx, conv, me, members, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) throw fail('invalid');
  if (typeof b.clientId !== 'string' || !CLIENT_ID_RE.test(b.clientId)) throw fail('invalid');
  const dup = await store.one(ctx.gc, 'SELECT * FROM messages WHERE conv_id = ? AND sender_id = ? AND client_id = ?', [conv.id, ctx.viewer, b.clientId]);
  if (dup) return { row: dup, duplicate: true };
  if (conv.readonly) throw fail('readonly');
  if (conv.kind === 'direct') {
    const peer = members.find((m) => m.user_id !== ctx.viewer);
    if (!peer || !ctx.users.has(peer.user_id)) throw fail('peer_unavailable');
    // 1.4.0: blocked either way — no direct messages
    if (await store.one(ctx.gc, 'SELECT 1 AS x FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)', [ctx.viewer, peer.user_id, peer.user_id, ctx.viewer])) throw fail('blocked');
  }
  const kind = b.kind == null ? 'text' : b.kind;
  if (!KINDS.includes(kind)) throw fail('invalid');
  const rich = RICH.includes(kind);
  if (rich && b.text != null) throw fail('invalid');
  const text = rich ? null : cleanText(b.text, kind === 'text');
  if (rich && b.meta != null) throw fail('invalid');
  const meta = rich ? {} : cleanMeta(kind, b.meta, ctx.cfg);
  let extra = null;
  if (rich) {
    extra = await require('./rich').prepare(ctx, conv, members, kind, b);
    Object.assign(meta, extra.meta);
  } else if (RICH.some((k) => b[k] != null)) throw fail('invalid');
  if (b.replyStory != null) meta.replyStory = await require('./status').replyRef(ctx, conv, members, b.replyStory);
  let replyTo = null;
  if (b.replyTo != null) {
    replyTo = posInt(b.replyTo);
    if (!replyTo) throw fail('invalid');
    const rr = await store.one(ctx.gc, 'SELECT * FROM messages WHERE id = ?', [replyTo]);
    if (!rr || !visibleTo(rr, me) || rr.deleted_at) throw fail('invalid');
  }
  let media = null;
  let thumb = null;
  if (kind === 'image' || kind === 'voice' || kind === 'file') {
    media = await checkMedia(ctx, b.mediaId, kind);
    if (b.thumbMediaId != null) {
      if (kind === 'voice' || b.thumbMediaId === b.mediaId) throw fail('invalid');
      thumb = await checkMedia(ctx, b.thumbMediaId, kind, { thumb: true });
    }
  } else if (b.mediaId != null || b.thumbMediaId != null) throw fail('invalid');
  if (b.video != null) {
    if (kind !== 'file') throw fail('invalid');
    const video = cleanVideo(b.video, media.mime);
    if (video) meta.video = video;
  }
  if (kind === 'location') meta.location = cleanLocation(b.location);
  else if (b.location != null) throw fail('invalid');
  const id = await insert(ctx, conv, { senderId: ctx.viewer, clientId: b.clientId, kind, text, replyTo, mediaId: media && media.mediaId, thumbId: thumb && thumb.mediaId, meta });
  if (media) await bindMedia(ctx, media, { convId: conv.id, msgId: id, role: 'file', kind });
  if (thumb) await bindMedia(ctx, thumb, { convId: conv.id, msgId: id, role: 'thumb', kind });
  if (extra) await extra.create(id);
  // one's own message: everything up to it is read
  await store.run(ctx.gc, 'UPDATE members SET last_read_id = MAX(last_read_id, ?), last_delivered_id = MAX(last_delivered_id, ?), updated_at = ? WHERE conv_id = ? AND user_id = ?', [id, id, ctx.now, conv.id, ctx.viewer]);
  live.clearTyping(conv.id, ctx.viewer, ctx.now);
  const row = await store.one(ctx.gc, 'SELECT * FROM messages WHERE id = ?', [id]);
  return { row, duplicate: false, text, meta };
}

/** The event message.new for the members. */
function queueNew(ctx, conv, members, row) {
  live.queue(ctx.box, members.map((m) => m.user_id), 'message.new', {
    conversationId: conv.id, messageId: row.id, senderId: row.sender_id, clientId: row.client_id || null, kind: row.kind, createdAt: iso(row.created_at),
  });
}

// ─── editing, deleting, reactions ───────────────────────────────────────────

function windowOk(ctx, row) {
  const w = ctx.cfg.editWindowMin;
  return w > 0 && ctx.now - row.created_at <= w * 60000;
}

/** PATCH messages/:id { text } */
async function edit(ctx, conv, me, members, id, body) {
  const row = await visibleMessage(ctx, me, id);
  if (row.sender_id !== ctx.viewer) throw fail('not_sender');
  if (row.deleted_at) throw fail('deleted');
  if (!EDITABLE.includes(row.kind)) throw fail('invalid');
  if (!windowOk(ctx, row)) throw fail('edit_window');
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) throw fail('invalid');
  const text = cleanText(b.text, row.kind === 'text');
  await store.run(ctx.gc, 'UPDATE messages SET body_enc = ?, edited_at = ?, updated_at = ? WHERE id = ?', [seal.seal(text), ctx.now, ctx.now, id]);
  await store.run(ctx.gc, 'UPDATE conversations SET updated_at = ? WHERE id = ?', [ctx.now, conv.id]);
  live.queue(ctx.box, members.map((m) => m.user_id), 'message.update', { conversationId: conv.id, messageId: id, editedAt: iso(ctx.now) });
  return store.one(ctx.gc, 'SELECT * FROM messages WHERE id = ?', [id]);
}

/** Mark the files of messages as orphaned (deleted from GateControl's store after the commit). */
async function orphanMedia(gc, msgIds) {
  for (let i = 0; i < msgIds.length; i += 90) {
    const part = msgIds.slice(i, i + 90);
    await store.run(gc, `UPDATE media SET orphan = 1, msg_id = NULL WHERE msg_id IN (${store.marks(part.length)})`, part);
  }
}

/** DELETE messages/:id?for=me|all */
async function remove(ctx, conv, me, members, id, scope) {
  const row = await visibleMessage(ctx, me, id);
  if (scope !== 'all') {
    await store.run(ctx.gc, 'INSERT OR IGNORE INTO hidden (msg_id, user_id) VALUES (?, ?)', [id, ctx.viewer]);
    await store.run(ctx.gc, 'UPDATE members SET updated_at = ? WHERE conv_id = ? AND user_id = ?', [ctx.now, conv.id, ctx.viewer]);
    live.queue(ctx.box, [ctx.viewer], 'message.delete', { conversationId: conv.id, messageIds: [id], reason: 'hidden' });
    return { forAll: false };
  }
  if (row.sender_id !== ctx.viewer) throw fail('not_sender');
  if (row.deleted_at) throw fail('deleted');
  if (!windowOk(ctx, row)) throw fail('edit_window');
  await store.run(ctx.gc, 'UPDATE messages SET deleted_at = ?, body_enc = NULL, meta_enc = NULL, media_id = NULL, thumb_media_id = NULL, reply_to = NULL, updated_at = ? WHERE id = ?', [ctx.now, ctx.now, id]);
  await store.run(ctx.gc, 'DELETE FROM reactions WHERE msg_id = ?', [id]);
  await orphanMedia(ctx.gc, [id]);
  await require('./rich').cleanup(ctx, [id]);
  await store.run(ctx.gc, 'UPDATE conversations SET updated_at = ? WHERE id = ?', [ctx.now, conv.id]);
  live.queue(ctx.box, members.map((m) => m.user_id), 'message.delete', { conversationId: conv.id, messageIds: [id], reason: 'deleted' });
  return { forAll: true };
}

/** An emoji (or a short emoji sequence): 1–16 UTF-16 units, no whitespace, no ASCII except keycaps (1️⃣, #️⃣). */
function cleanEmoji(v) {
  if (v === null) return null;
  if (typeof v !== 'string' || !v.length || v.length > EMOJI_MAX || /[\s\0-\x1f\x7f]/.test(v)) throw fail('invalid');
  if (/[\x20-\x7e]/.test(v.replace(/[#*0-9]\ufe0f?\u20e3/g, ''))) throw fail('invalid');
  return v;
}

/** PUT messages/:id/reaction { emoji | null } */
async function react(ctx, conv, me, members, id, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b || !Object.prototype.hasOwnProperty.call(b, 'emoji')) throw fail('invalid');
  const emoji = cleanEmoji(b.emoji);
  const row = await visibleMessage(ctx, me, id);
  if (row.deleted_at) throw fail('deleted');
  if (row.kind === 'system') throw fail('invalid');
  if (emoji == null) await store.run(ctx.gc, 'DELETE FROM reactions WHERE msg_id = ? AND user_id = ?', [id, ctx.viewer]);
  else await store.run(ctx.gc, 'INSERT INTO reactions (msg_id, user_id, emoji, at) VALUES (?, ?, ?, ?) ON CONFLICT(msg_id, user_id) DO UPDATE SET emoji = excluded.emoji, at = excluded.at', [id, ctx.viewer, emoji, ctx.now]);
  await store.run(ctx.gc, 'UPDATE messages SET updated_at = ? WHERE id = ?', [ctx.now, id]);
  const list = reactionList(await store.all(ctx.gc, 'SELECT user_id, emoji FROM reactions WHERE msg_id = ? ORDER BY at, user_id', [id]));
  live.queue(ctx.box, members.map((m) => m.user_id), 'reaction', { conversationId: conv.id, messageId: id, userId: ctx.viewer, emoji, reactions: list });
  // 1.4.0: a push to the author (notify.reactions, default on) — not for one's own messages, not for a removed reaction
  if (emoji && row.sender_id != null && row.sender_id !== ctx.viewer && members.some((m) => m.user_id === row.sender_id)) {
    const p = (await people.prefsOf(ctx.gc, [row.sender_id])).get(row.sender_id);
    if (p && p.notify && p.notify.reactions) {
      const q = quote(row, me, new Set(), id);
      ctx.box.pushes.push({ custom: { kind: 'reaction', conv, members, users: [row.sender_id], senderId: ctx.viewer, messageId: id, params: { emoji, preview: q.text || '' }, respectMute: true } });
    }
  }
  return list;
}

// ─── read marks ─────────────────────────────────────────────────────────────

/**
 * Receipts as `viewer` may see them (pure; conversations.receipts, the 'read' event): deliveredUpTo (the
 * lowest delivered mark of the other members with an account), readUpTo and receipts[] only when the
 * viewer shares read receipts — then over the other members who share them too (null / [] when nobody does).
 * `prefs` = people.prefsOf of the members, `users` = the enabled accounts (Map).
 */
function receiptsAs(viewer, members, prefs, users) {
  const others = members.filter((m) => m.user_id !== viewer && users.has(m.user_id));
  const mine = prefs.get(viewer) || {};
  const deliveredUpTo = others.length ? Math.min(...others.map((m) => m.last_delivered_id)) : null;
  if (!mine.readReceipts) return { readUpTo: null, deliveredUpTo, receipts: [] };
  const sharing = others.filter((m) => (prefs.get(m.user_id) || {}).readReceipts);
  return {
    readUpTo: sharing.length ? Math.min(...sharing.map((m) => m.last_read_id)) : null,
    deliveredUpTo,
    receipts: sharing.map((m) => ({ userId: m.user_id, lastReadId: m.last_read_id, lastDeliveredId: m.last_delivered_id })),
  };
}

/**
 * Queue the 'read' event after a member's marks moved: the member's own devices get
 * { …, self: true, unread }; the others get lastReadId only when both share read receipts
 * (else null) — lastDeliveredId always. 1.1.0: every recipient also gets readUpTo and
 * deliveredUpTo as GET conversations/:id would give them to that recipient now (recipients
 * with the same values share one event).
 */
async function queueRead(ctx, conv, members, me, { self = true } = {}) {
  // the members with the reader's new marks (the rows were read before the marks moved)
  const cur = members.map((m) => (m.user_id === me.user_id ? { ...m, last_read_id: me.last_read_id, last_delivered_id: me.last_delivered_id } : m));
  const ids = cur.map((m) => m.user_id);
  const prefs = await people.prefsOf(ctx.gc, ids);
  const mine = prefs.get(me.user_id) || {};
  const base = { conversationId: conv.id, userId: me.user_id, lastDeliveredId: me.last_delivered_id };
  const upTo = (u) => {
    const rc = receiptsAs(u, cur, prefs, ctx.users);
    return { readUpTo: rc.readUpTo, deliveredUpTo: rc.deliveredUpTo };
  };
  if (self) live.queue(ctx.box, [me.user_id], 'read', { ...base, lastReadId: me.last_read_id, self: true, unread: await unreadCount(ctx.gc, me), ...upTo(me.user_id) });
  const groups = new Map();
  for (const u of ids) {
    if (u === me.user_id) continue;
    const shared = !!(mine.readReceipts && (prefs.get(u) || {}).readReceipts);
    const data = { ...base, lastReadId: shared ? me.last_read_id : null, ...upTo(u) };
    const k = JSON.stringify(data);
    if (!groups.has(k)) groups.set(k, { users: [], data });
    groups.get(k).users.push(u);
  }
  for (const g of groups.values()) live.queue(ctx.box, g.users, 'read', g.data);
}

/** POST conversations/:id/read { upTo } → { lastReadId, unread } */
async function markRead(ctx, conv, me, members, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const upTo = posInt(b.upTo);
  if (!upTo) throw fail('invalid');
  const to = Math.min(upTo, conv.last_msg_id || 0);
  if (to > me.last_read_id) {
    me.last_read_id = to;
    me.last_delivered_id = Math.max(me.last_delivered_id, to);
    await store.run(ctx.gc, 'UPDATE members SET last_read_id = ?, last_delivered_id = ?, updated_at = ? WHERE conv_id = ? AND user_id = ?', [me.last_read_id, me.last_delivered_id, ctx.now, conv.id, ctx.viewer]);
    await queueRead(ctx, conv, members, me);
  }
  return { lastReadId: me.last_read_id, unread: await unreadCount(ctx.gc, me) };
}

/** The member's apps fetched messages up to `upTo`: delivered (the others learn it). */
async function markDelivered(ctx, conv, me, members, upTo) {
  const to = Math.min(upTo || 0, conv.last_msg_id || 0);
  if (to <= me.last_delivered_id) return;
  me.last_delivered_id = to;
  await store.run(ctx.gc, 'UPDATE members SET last_delivered_id = ? WHERE conv_id = ? AND user_id = ?', [to, conv.id, ctx.viewer]);
  await queueRead(ctx, conv, members, me, { self: false });
}

// ─── search, media of a conversation ───────────────────────────────────────

/** GET conversations/:id/search?q= — decrypted here, the newest 2000 messages at most. */
async function search(ctx, me, q, rc) {
  const needle = typeof q === 'string' ? q.trim().toLocaleLowerCase('de') : '';
  if (needle.length < 2 || needle.length > 100) throw fail('invalid');
  const rows = await store.all(ctx.gc, `SELECT m.* FROM messages m WHERE ${VISIBLE_SQL} AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT ?`, [...visibleArgs(me), SEARCH_SCAN + 1]);
  const truncated = rows.length > SEARCH_SCAN;
  const hits = [];
  for (const r of rows.slice(0, SEARCH_SCAN)) {
    const meta = metaOf(r) || {};
    const hay = [bodyOf(r), meta.fileName, meta.location && meta.location.label, require('./rich').summaryText(r.kind, meta)].filter((x) => typeof x === 'string').join('\n').toLocaleLowerCase('de');
    if (hay.includes(needle)) hits.push(r);
    if (hits.length >= SEARCH_RESULTS) break;
  }
  return { results: await views(ctx, me, hits, rc), scanned: Math.min(rows.length, SEARCH_SCAN), truncated };
}

const MEDIA_KINDS = ['image', 'voice', 'file', 'video'];
// 1.3.0: a video is a file message whose file is video/* (kind stays 'file' for older apps)
const VIDEO_SQL = "EXISTS (SELECT 1 FROM media x WHERE x.media_id = m.media_id AND x.mime LIKE 'video/%')";
const KIND_SQL = {
  image: "m.kind = 'image'",
  voice: "m.kind = 'voice'",
  file: `m.kind = 'file' AND NOT ${VIDEO_SQL}`,
  video: `m.kind = 'file' AND ${VIDEO_SQL}`,
  all: "m.kind IN ('image', 'voice', 'file')",
};

/**
 * GET conversations/:id/media?kind=image|voice|file|video|all&before=&limit= → { items (newest first), counts, hasMore }
 * 1.3.0: `video` = file messages with a video/* file; `file` = the other files; counts.video, counts.file without videos.
 */
async function mediaList(ctx, me, query, rc) {
  const q = query || {};
  const kind = q.kind == null || q.kind === '' || q.kind === 'all' ? null : String(q.kind);
  if (kind && !MEDIA_KINDS.includes(kind)) throw fail('invalid');
  const limit = q.limit == null || q.limit === '' ? 30 : posInt(String(q.limit));
  if (!limit || limit > PAGE_MAX) throw fail('invalid');
  const before = q.before == null || q.before === '' ? null : posInt(String(q.before));
  if (q.before != null && q.before !== '' && !before) throw fail('invalid');
  let rows = await store.all(ctx.gc, `SELECT m.* FROM messages m WHERE ${VISIBLE_SQL} AND m.deleted_at IS NULL AND m.media_id IS NOT NULL AND ${KIND_SQL[kind || 'all']}${before ? ' AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ?`,
    [...visibleArgs(me), ...(before ? [before] : []), limit + 1]);
  const hasMore = rows.length > limit;
  rows = rows.slice(0, limit);
  const counts = { image: 0, voice: 0, file: 0, video: 0 };
  for (const c of await store.all(ctx.gc, `SELECT CASE WHEN m.kind = 'file' AND ${VIDEO_SQL} THEN 'video' ELSE m.kind END AS kind, COUNT(*) AS n
    FROM messages m WHERE ${VISIBLE_SQL} AND m.deleted_at IS NULL AND m.media_id IS NOT NULL GROUP BY 1`, visibleArgs(me))) {
    if (c.kind in counts) counts[c.kind] = c.n;
  }
  return { items: await views(ctx, me, rows, rc), counts, hasMore };
}

module.exports = {
  views, page, send, queueNew, edit, remove, react, markRead, markDelivered, queueRead, receiptsAs, search, mediaList, system, insert, checkMedia, bindMedia,
  orphanMedia, lastVisible, unreadCount, bodyOf, metaOf, visibleMessage, cleanEmoji, cleanVideo, isVideo, cleanText, unarchive, TEXT_MAX, PAGE_MAX, THUMB_MAX, THUMB_MAX_SIDE,
  FILE_THUMB_TYPES, FEATURES, URL_TTL_S, KINDS, RICH, CLIENT_ID_RE, VISIBLE_SQL, visibleArgs,
};
