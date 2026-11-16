'use strict';

// 1.25.0 — the contacts' WhatsApp status updates in the status row (GateControl with gc.bridges version 12,
// feature-detected; README "App-API", since 1.25.0).
//
//   in      the bridge keeps the status updates of the person's WhatsApp contacts in a room of its own (chat.status).
//           Its conversation (conversations.bridge_status = 1) is a bridged conversation with the person as its one
//           member like any other — but never a chat: it is not listed, not searched, not counted, opened by no route
//           (conversations.access answers not_found), muted, and a status update in it causes no push and no
//           message.new (bridgechats.apply → filed()). The messages stay: they are the status updates of their senders.
//   24 h    WhatsApp sends nothing when a status runs out: each is filed with expires_at = its time + 24 h and goes for
//           good, with its file, like a disappearing message (jobs.expire). A status the contact deletes goes at once
//           (a redaction → tombstone). One older than 24 h when it arrives is not filed at all.
//   feed    GET status/feed → `bridged`: one entry per contact who has status updates, beside `items` (the accounts —
//           older clients read only those and never see a WhatsApp status). Sorted with the accounts by the client:
//           unseen first, then the newest.
//   seen    POST status/bridged/:id/seen marks one status as watched HERE (ext_seen; the ring turns grey) — always.
//           WhatsApp learns it (the contact sees the person under „Gesehen von“) only when the person turned
//           privacy.bridgedStatusSeen on (default off) and shares read receipts (readReceipts), and only for a status
//           before which every status still here in the room was watched too: the bridge marks everything in the room
//           up to the message it is told, for every sender (mautrix-whatsapp HandleMatrixReadReceipt) — so it is told
//           the newest status of the longest watched run (bridge_status_reported keeps how far it went). Never
//           automatically, never from the chat list (bridgechats.readOut skips the room).
//   answer  POST status/bridged/:id/reply { text } | { emoji } → a normal message into the WhatsApp direct chat with
//           that contact (the bridge carries no answer across rooms and refuses reactions on a status:
//           ErrBroadcastReactionUnsupported). An emoji goes as the text „❤️ auf deinen Status“. The direct chat:
//           the one with this contact (persons.chatOfContact), else the bridge's contact list (contacts(): the same
//           contactId) — opened by its reference when there is no chat yet. Without either: no_chat.

const store = require('./store');
const seal = require('./seal');
const live = require('./live');
const people = require('./people');
const texts = require('./texts.json');
const { fail, posInt, iso } = require('./util');

const TTL_MS = 24 * 3600 * 1000;
const CONTACTS_MAX = 100;   // contacts in the feed
const PER_CONTACT_MAX = 30; // status updates per contact
const NETWORKS = ['whatsapp'];
const CONTACT_RE = /^c[A-Za-z0-9_-]{21}$/;

function t(lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

/** gc.bridges with status rooms (version ≥ 12), else null. */
function api(gc) {
  const b = gc && gc.bridges;
  return b && Number(b.version) >= 12 && typeof b.read === 'function' ? b : null;
}

/** Is this the conversation of a room of status updates? */
const isStatus = (conv) => !!(conv && conv.bridge_status);

/** GET me: features.bridge_status — GateControl has status rooms and the viewer linked WhatsApp (or has such a room). */
async function feature(ctx) {
  if (!api(ctx.gc) || ctx.viewer == null) return false;
  return !!(await store.one(ctx.gc, "SELECT 1 AS x FROM bridge_links WHERE user_id = ? AND network = 'whatsapp' LIMIT 1", [ctx.viewer])
    || await store.one(ctx.gc, 'SELECT 1 AS x FROM conversations WHERE bridge_owner = ? AND bridge_status = 1 LIMIT 1', [ctx.viewer]));
}

/**
 * bridgechats.apply, a new message in a room of status updates — filed, then: runs out 24 h after it was posted, read
 * already (counts nowhere), no push, no message.new; the person's status row learns it (story.bridged).
 */
async function filed(c, conv, ev, msgId, at) {
  await store.run(c.gc, 'UPDATE messages SET expires_at = ? WHERE id = ?', [at + TTL_MS, msgId]);
  await store.run(c.gc, 'UPDATE members SET last_read_id = MAX(last_read_id, ?), last_delivered_id = MAX(last_delivered_id, ?), updated_at = ? WHERE conv_id = ? AND user_id = ?', [msgId, msgId, c.now, conv.id, ev.userId]);
  changed(c.box, ev.userId, conv.id, msgId, 'new');
}

/** Tell the person's apps that their status row changed (older apps do not know the event). */
function changed(box, userId, convId, msgId, action) {
  if (box) live.queue(box, [userId], 'story.bridged', { network: 'whatsapp', storyId: msgId, action });
}

/** Too old to file (a status that ran out already)? */
const tooOld = (at, now) => at <= now - TTL_MS;

// ─── the feed ───────────────────────────────────────────────────────────────

async function mediaUrl(ctx, id) {
  if (!ctx.portal || !id) return null;
  try { return await ctx.gc.media.url(id, { user: ctx.viewer, ttlS: 6 * 3600 }); } catch { return null; }
}

/** One status message → the API object, or null (its file is still on its way). */
async function storyOf(ctx, r) {
  const messages = require('./messages');
  const meta = messages.metaOf(r) || {};
  const bm = meta.bridge || null;
  if (r.ext_media === 'wait' || r.ext_media === 'ask') return null;
  const text = messages.bodyOf(r);
  let kind = 'text';
  let video = null;
  if (r.media_id && r.kind === 'image') kind = 'image';
  else if (r.media_id && meta.video) { kind = 'video'; video = { durationMs: meta.video.durationMs || null, width: meta.video.width || null, height: meta.video.height || null }; }
  else if (r.media_id || bm) kind = 'unsupported';
  if (kind === 'text' && !(typeof text === 'string' && text.trim())) return null;
  const mediaId = kind === 'image' || kind === 'video' ? r.media_id : null;
  const thumb = mediaId && r.thumb_media_id ? r.thumb_media_id : null;
  return {
    id: r.id, kind, text: typeof text === 'string' && text ? text : null,
    mediaId, thumbMediaId: thumb, video, url: await mediaUrl(ctx, mediaId), thumbUrl: await mediaUrl(ctx, thumb),
    createdAt: iso(r.created_at), expiresAt: iso(r.expires_at || r.created_at + TTL_MS), seen: r.ext_seen != null,
  };
}

/** GET status/feed → bridged: [{ network, contact: { id, name, avatarMediaId, avatarUrl }, chatId, stories, unseen }] */
async function feed(ctx) {
  if (!api(ctx.gc) || ctx.viewer == null) return [];
  const bridges = require('./bridges');
  const bridgechats = require('./bridgechats');
  // 1.25.1: the status room an older version kept as a chat (bridgechats.catchUpStatus — hourly until done)
  await bridgechats.catchUpStatus(ctx);
  const bridgemedia = require('./bridgemedia');
  const persons = require('./persons');
  const convs = await store.all(ctx.gc, 'SELECT * FROM conversations WHERE bridge_owner = ? AND bridge_status = 1 AND bridge_closed = 0', [ctx.viewer]);
  const out = [];
  for (const conv of convs) {
    if (!NETWORKS.includes(conv.bridge_net)) continue;
    // a child whose parents did not (or no longer) allow the service sees nothing of it
    if (!(await bridges.allowed(ctx.gc, ctx.viewer, conv.bridge_net, ctx.now)).allowed) continue;
    const rows = await store.all(ctx.gc, `SELECT * FROM messages WHERE conv_id = ? AND deleted_at IS NULL AND ext_sender IS NOT NULL AND kind != 'system'
      AND created_at > ? ORDER BY created_at ASC, id ASC LIMIT 3000`, [conv.id, ctx.now - TTL_MS]);
    const by = new Map();
    for (const r of rows) {
      if (r.expires_at != null && r.expires_at <= ctx.now) continue;
      if (!by.has(r.ext_sender)) by.set(r.ext_sender, []);
      by.get(r.ext_sender).push(r);
    }
    for (const [contactId, list] of by) {
      const k = await store.one(ctx.gc, 'SELECT * FROM bridge_contacts WHERE id = ? AND owner_id = ?', [contactId, ctx.viewer]);
      if (!k) continue;
      const stories = [];
      for (const r of list.slice(-PER_CONTACT_MAX)) { const s = await storyOf(ctx, r); if (s) stories.push(s); }
      if (!stories.length) continue;
      const chatId = await persons.chatOfContact(ctx, conv.bridge_net, k.ref, null);
      // the name as in the chat list: the address book's for the direct chat, else the bridge's, else neutral
      let name = null;
      if (chatId) { const dm = await store.one(ctx.gc, 'SELECT * FROM conversations WHERE id = ?', [chatId]); if (dm) name = await bridgechats.titleFor(ctx, dm); }
      if (!name) { const n = seal.open(k.name_enc); name = typeof n === 'string' && n ? n : bridgechats.titleLabel(ctx, conv.bridge_net); }
      const pic = await bridgemedia.pictureOf(ctx.gc, k.avatar_media_id);
      out.push({
        network: conv.bridge_net,
        contact: { id: contactId, name, avatarMediaId: pic, avatarUrl: await mediaUrl(ctx, pic) },
        chatId: chatId || null,
        // an answer goes to the direct chat — found now, or by the bridge's contacts when it is sent
        canReply: !!chatId || !!require('./contactchat').api(ctx.gc),
        stories,
        unseen: stories.some((s) => !s.seen),
      });
      if (out.length >= CONTACTS_MAX) break;
    }
    // the contact's picture is fetched once somebody sees their status (as for their messages)
    await bridgemedia.wantContacts(ctx, await store.all(ctx.gc, `SELECT id, name_enc, avatar_ref, avatar_got, avatar_media_id, avatar_want FROM bridge_contacts WHERE id IN (${store.marks(Math.max(1, by.size))})`, by.size ? [...by.keys()] : [0]));
    if (out.length >= CONTACTS_MAX) break;
  }
  const newest = (x) => x.stories[x.stories.length - 1].createdAt;
  out.sort((a, b) => (a.unseen !== b.unseen ? (a.unseen ? -1 : 1) : (newest(a) < newest(b) ? 1 : newest(a) > newest(b) ? -1 : a.contact.id - b.contact.id)));
  return out;
}

// ─── watched, seen ──────────────────────────────────────────────────────────

/** A status of the viewer's rooms of status updates (not deleted, not run out) → { row, conv }, or not_found. */
async function statusOf(ctx, idRaw) {
  const id = posInt(idRaw);
  if (!id || !api(ctx.gc)) throw fail('not_found');
  const row = await store.one(ctx.gc, `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conv_id
    WHERE m.id = ? AND c.bridge_owner = ? AND c.bridge_status = 1 AND m.deleted_at IS NULL AND m.ext_sender IS NOT NULL AND m.created_at > ?`, [id, ctx.viewer, ctx.now - TTL_MS]);
  if (!row || (row.expires_at != null && row.expires_at <= ctx.now)) throw fail('not_found');
  const conv = await store.one(ctx.gc, 'SELECT * FROM conversations WHERE id = ?', [row.conv_id]);
  if (!(await require('./bridges').allowed(ctx.gc, ctx.viewer, conv.bridge_net, ctx.now)).allowed) throw fail('not_found');
  return { row, conv };
}

/**
 * The newest status the bridge may be told as read: the end of the longest run of watched status updates after the
 * last one told (bridge_status_reported) — a status nobody watched stops it. → the row, or null.
 */
async function reportable(gc, conv) {
  const rows = await store.all(gc, `SELECT id, created_at, ext_event, ext_seen FROM messages WHERE conv_id = ? AND deleted_at IS NULL AND ext_sender IS NOT NULL
    AND ext_event IS NOT NULL AND created_at > ? ORDER BY created_at ASC, id ASC LIMIT 3000`, [conv.id, conv.bridge_status_reported || 0]);
  let last = null;
  for (const r of rows) {
    if (r.ext_seen == null) break;
    last = r;
  }
  return last;
}

/**
 * POST status/bridged/:id/seen → { seen: true, reported } — watched here; WhatsApp is told only on the person's own
 * switch (privacy.bridgedStatusSeen) with read receipts on, for the watched run (reportable). Inside the person's
 * changing request (gc.bridges.read needs it).
 */
async function seen(ctx, idRaw) {
  const { row, conv } = await statusOf(ctx, idRaw);
  if (row.ext_seen == null) {
    await store.tx(ctx.gc, () => store.run(ctx.gc, 'UPDATE messages SET ext_seen = ? WHERE id = ? AND ext_seen IS NULL', [ctx.now, row.id]));
    changed(ctx.box, ctx.viewer, conv.id, row.id, 'seen');
  }
  const prefs = (await people.prefsOf(ctx.gc, [ctx.viewer])).get(ctx.viewer) || {};
  if (!prefs.privacy || prefs.privacy.bridgedStatusSeen !== true || prefs.readReceipts === false) return { seen: true, reported: false };
  const b = api(ctx.gc);
  const fresh = await store.one(ctx.gc, 'SELECT * FROM conversations WHERE id = ?', [conv.id]);
  const upTo = b && !fresh.bridge_closed ? await reportable(ctx.gc, fresh) : null;
  if (!upTo) return { seen: true, reported: false };
  try { await b.read(ctx.viewer, fresh.bridge_net, fresh.bridge_ref, upTo.ext_event, { status: true }); } catch { return { seen: true, reported: false }; }
  await store.tx(ctx.gc, () => store.run(ctx.gc, 'UPDATE conversations SET bridge_status_reported = MAX(bridge_status_reported, ?) WHERE id = ?', [upTo.created_at, conv.id]));
  return { seen: true, reported: true };
}

// ─── the answer ─────────────────────────────────────────────────────────────

/** The conversation id of the viewer's direct chat with this contact — found, or opened by the bridge's contacts. */
async function directChat(ctx, net, contact) {
  const persons = require('./persons');
  const id = await persons.chatOfContact(ctx, net, contact.ref, null);
  if (id) return id;
  const cc = require('./contactchat');
  const b = cc.api(ctx.gc);
  if (!b || !CONTACT_RE.test(String(contact.ref || ''))) return null;
  let list = [];
  try { const r = await b.contacts(ctx.viewer, net, {}); list = r && Array.isArray(r.contacts) ? r.contacts : []; } catch { list = []; }
  const hit = list.find((x) => x && x.contactId === contact.ref);
  if (!hit) return null;
  if (typeof hit.chatId === 'string' && hit.chatId) {
    const c = await store.one(ctx.gc, "SELECT id FROM conversations WHERE bridge_owner = ? AND bridge_net = ? AND bridge_ref = ? AND kind = 'direct' AND bridge_closed = 0 AND bridge_status = 0", [ctx.viewer, net, hit.chatId]);
    if (c) return c.id;
  }
  if (typeof hit.ref !== 'string') return null;
  const made = await require('./bridges').chatByRef(ctx, net, hit.ref);
  return made && made.conversation ? made.conversation.id : null;
}

/**
 * A text into a bridged direct chat as POST conversations/:id/messages does it (checked, stored, handed to the bridge)
 * → the message as the viewer sees it.
 */
async function sendTo(ctx, convId, body) {
  const conversations = require('./conversations');
  const messages = require('./messages');
  const bridgechats = require('./bridgechats');
  const was = ctx.bridged;
  ctx.bridged = true;
  try {
    const pre = await conversations.access(ctx, convId);
    bridgechats.writable(pre.conv);
    await bridgechats.checkBody(ctx, body);
    await bridgechats.gate(ctx, pre.conv);
    ctx.bridgeOut = pre.conv.id;
    const stored = await store.tx(ctx.gc, async () => {
      const x = await conversations.access(ctx, convId);
      const before = x.conv.last_msg_id || 0;
      const r = await messages.send(ctx, x.conv, x.me, x.members, body);
      if (!r.duplicate) {
        messages.queueNew(ctx, x.conv, x.members, r.row);
        if (x.me.last_read_id < before) await messages.queueRead(ctx, x.conv, x.members, { ...x.me, last_read_id: r.row.id, last_delivered_id: r.row.id });
      }
      return r;
    });
    const row = await bridgechats.sendOut(ctx, pre.conv, stored);
    const x = await conversations.access(ctx, convId);
    const rc = await conversations.receipts(ctx, x.conv, x.members);
    if (!stored.duplicate) live.queue(ctx.box, [ctx.viewer], 'message.update', { conversationId: x.conv.id, messageId: row.id, editedAt: iso(ctx.now), status: row.ext_state === 'failed' ? 'failed' : 'sent' });
    return (await messages.views(ctx, x.me, [row], rc))[0];
  } finally {
    ctx.bridged = was;
    delete ctx.bridgeOut;
  }
}

/**
 * POST status/bridged/:id/reply { text, clientId? } | { emoji, clientId? } → { message, conversationId } — a normal
 * message into the WhatsApp direct chat with the status's sender (an emoji as „❤️ auf deinen Status“).
 */
async function reply(ctx, idRaw, body, send = (id, msg) => sendTo(ctx, id, msg)) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const messages = require('./messages');
  let text;
  let emoji = null;
  if (b.emoji != null) {
    emoji = messages.cleanEmoji(b.emoji);
    if (!emoji || b.text != null) throw fail('invalid');
    text = t(ctx.lang, 'bridgestatus.reaction', { emoji });
  } else {
    text = typeof b.text === 'string' ? b.text.replace(/\r\n?/g, '\n').trim() : '';
    if (!text || text.length > messages.TEXT_MAX) throw fail('invalid');
  }
  const { row, conv } = await statusOf(ctx, idRaw);
  const contact = await store.one(ctx.gc, 'SELECT * FROM bridge_contacts WHERE id = ? AND owner_id = ?', [row.ext_sender, ctx.viewer]);
  if (!contact) throw fail('not_found');
  const chatId = await directChat(ctx, conv.bridge_net, contact);
  if (!chatId) throw fail('not_found', { reason: 'no_chat' });
  const clientId = typeof b.clientId === 'string' && messages.CLIENT_ID_RE.test(b.clientId) ? b.clientId : `st-${row.id}-${ctx.now}`;
  // the reaction stays noted on the status (shown as „gesendet“ in the viewer); watched too
  await store.tx(ctx.gc, () => store.run(ctx.gc, 'UPDATE messages SET ext_seen = COALESCE(ext_seen, ?) WHERE id = ?', [ctx.now, row.id]));
  const message = await send(chatId, { clientId, kind: 'text', text });
  return { message, conversationId: chatId, ...(emoji ? { emoji } : {}) };
}

module.exports = { api, isStatus, feature, filed, changed, tooOld, feed, seen, reply, reportable, statusOf, TTL_MS, CONTACTS_MAX, PER_CONTACT_MAX };
