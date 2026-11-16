'use strict';

// 1.14.0 — chats over a bridge to another messenger (WhatsApp first; GateControl with gc.bridges version ≥ 3,
// feature-detected). bridges.js links an account; this file carries the messages.
//
//   in    GateControl hands over neutral events (gc.bridges.events.pull, woken by the hook bridgeEvents and, as a
//         net, by the background run): a chat, a message, an edit, a deletion, a reaction, the bridge's word on a
//         sent message, a contact's new name. Each is filed into the chats of the person it belongs to and then
//         acknowledged (events.ack) — GateControl forgets it. The bridge's id of a message is unique per chat, so
//         an event that arrives twice changes nothing; what arrives before its message waits (bridge_pending).
//   out   a text, an edit, a deletion, a reaction, "read" and "typing …" go out through gc.bridges as the person —
//         GateControl lets that happen only while this very person has a changing request in flight. There is no
//         queue: a message the bridge did not take shows why and can be sent again.
//
// A bridged chat is a conversation with ONE member, the linked person (migrations/007). Nobody else — no
// administrator, no other member of the family — has a member row, so nobody else can read it, gets an event or a
// push about it. The people on the other side are that person's contacts (bridge_contacts), never accounts.
//
// What does not cross: files of any kind (1.15.0 with GateControl's gc.bridges version 4: pictures, videos, voice
// messages and files do — bridgemedia.js; before that a line "Bild – folgt" with the file's name, nothing is swallowed),
// GateControl's own message kinds (polls, events, live arrival, home actions, cards, locations), disappearing messages,
// changes to members or title.
//
// 1.17.0 (GateControl with gc.bridges version 5): older messages — events with `history: true` (bridgehistory.js) are
// filed like the others, but without a push, as read, without a live event per message (one conversation.update
// { reason: 'history' } per chat), and a file in them waits until the person asks for it (ext_media 'ask').
//
// 1.20.0 (GateControl with gc.bridges version 7): channels, groups where only admins write, format and link previews —
// bridgechannels.js says how.
//
// 1.23.0 (GateControl with gc.bridges version 10): Signal. A chat's disappearing messages (chat.timer) become the
// conversation's disappearingS — shown, not changeable here, and nothing runs out here (the bridge deletes them; the
// timer counts from reading on); the bridge's notice about a change becomes the system line „disappearing“; a view-once
// picture (message.viewOnce) the placeholder 'view_once' — „Einmal-Ansicht. Öffne sie in Signal.“, never the file.
//
// 1.24.0 (GateControl with gc.bridges version 11): Telegram. chat.bot → the conversation's bridge.bot („Bot“), chat.members
// → bridge.members (a group of LARGE_GROUP and more is created muted); a Telegram channel is a channel like WhatsApp's; a
// child sees Telegram's channels only with the parents' „Telegram-Kanäle“ (bridges.channelsAllowed — events of such a
// channel are dropped, the list leaves it out); message.tooLarge (the file did not even reach GateControl) → a file
// placeholder that failed with the reason too_large („Zu groß, öffne es in Telegram“); message.buttons → bridge.buttons
// (the hint „Diese Nachricht hat Knöpfe. Öffne sie in Telegram.“).
//
// 1.25.0 (GateControl with gc.bridges version 12): the room of the contacts' WhatsApp status updates (chat.status) is
// no chat — bridgestatus.js says how its messages become status updates in the status row (never listed, never pushed,
// gone after 24 h; "seen" to WhatsApp only on the person's own switch, never from here).
//
// Clients that do not know bridged chats never see one: every route answers 404 for a bridged conversation unless
// the request says ?bridged=1 (or `bridged: true` in its body — the buttons of a push; README "App-API", since 1.14.0).

const crypto = require('node:crypto');
const store = require('./store');
const seal = require('./seal');
const live = require('./live');
const log = require('./log');
const people = require('./people');
const texts = require('./texts.json');
const bridgemedia = require('./bridgemedia');
const bridgechannels = require('./bridgechannels');
const bridgestatus = require('./bridgestatus');
const scan = require('./scan');
const { fail, iso, bridgeName } = require('./util');

const NETWORKS = ['whatsapp', 'signal', 'telegram'];
const LABEL = { whatsapp: 'WhatsApp', signal: 'Signal', telegram: 'Telegram' };
// 1.24.0: a Telegram group of this many members and more is created muted (its bell turns pushes on)
const LARGE_GROUP = 200;
// 1.23.0: the longest timer a bridged chat carries (a year)
const TIMER_MAX_S = 366 * 86400;
const REF_RE = /^r[A-Za-z0-9_-]{20}$/;
const CONTACT_RE = /^c[A-Za-z0-9_-]{21}$/;
const EVENT_RE = /^\$[A-Za-z0-9._=/+-]{1,128}(:[a-z0-9.-]{1,64})?$/;
const REASON_RE = /^[a-z][a-z0-9_]{0,39}$/;
const NAME_MAX = 120;
const TEXT_MAX = 4000;
const PENDING_MS = 86400000;
const LINK_CHECK_MS = 5 * 60000;
const SUPPORTS = ['text', 'reply', 'reaction', 'edit', 'delete', 'read', 'typing'];
const PLACEHOLDERS = ['image', 'video', 'audio', 'voice', 'file', 'sticker', 'location', 'unsupported', 'view_once'];

const via = (net) => `bridge:${net}`;
const isBridged = (conv) => !!(conv && conv.bridge_net);

/** gc.bridges with the message part (version ≥ 3), else null. */
function api(gc) {
  const b = gc && gc.bridges;
  return b && Number(b.version) >= 3 && b.events && typeof b.events.pull === 'function' && typeof b.send === 'function' ? b : null;
}

function t(lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

const body = (v) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\0-\x08\x0b-\x1f\x7f]/g, '').slice(0, 16000) : '');

/** GateControl's refusals → this API's codes. */
function mapped(e) {
  const reason = e && typeof e.reason === 'string' && REASON_RE.test(e.reason) ? e.reason : null;
  switch (e && e.code) {
    case 'ERR_BRIDGES_UNAVAILABLE': return fail('bridge_off', { reason });
    case 'ERR_BRIDGE_UNREACHABLE': return fail('bridge_unreachable', { reason });
    case 'ERR_BRIDGE': return fail('bridge_failed', { reason });
    case 'ERR_INVALID': return fail('invalid');
    case 'ERR_NOT_PERSON': case 'ERR_BRIDGES_DENIED': return fail('forbidden');
    default: return e;
  }
}
const reasonOf = (e) => (e && typeof e.reason === 'string' && REASON_RE.test(e.reason) ? e.reason : (e && e.code === 'ERR_BRIDGE_UNREACHABLE' ? 'unreachable' : 'bridge_error'));

// ─── state of a person's link (what the conversation view shows) ───────────

/**
 * The state of the bridge for one person and network, without asking the bridge:
 *   ok | off (not offered / switched off) | unreachable (does not run) | logged_out (the service dropped the linked
 *   device) | unlinked (no link) | locked (a child without the parents' yes)
 * `cache` (per request): { host, links: Map }.
 */
async function stateFor(ctx, userId, net) {
  const c = ctx.bridgeState || (ctx.bridgeState = { host: null, links: new Map(), allowed: new Map() });
  if (!c.host) {
    let s = null;
    try { s = api(ctx.gc) ? await ctx.gc.bridges.status() : null; } catch { s = null; }
    c.host = s && typeof s === 'object' ? s : { available: false };
  }
  const n = c.host.available && c.host.enabled ? (c.host.networks || []).find((x) => x.id === net) : null;
  if (!n || !n.enabled) return 'off';
  const k = `${userId}:${net}`;
  if (!c.allowed.has(k)) c.allowed.set(k, (await require('./bridges').allowed(ctx.gc, userId, net, ctx.now)).allowed);
  if (!c.allowed.get(k)) return 'locked';
  if (n.state !== 'running') return 'unreachable';
  if (!c.links.has(k)) c.links.set(k, await store.all(ctx.gc, 'SELECT state FROM bridge_links WHERE user_id = ? AND network = ?', [userId, net]));
  const rows = c.links.get(k);
  if (!rows.length) return 'unlinked';
  return rows.some((r) => r.state !== 'logged_out') ? 'ok' : 'logged_out';
}

const linkChecked = new Map(); // `${userId}:${net}` → when the bridge was last asked for this person's logins

/** Ask the bridge for the viewer's logins now and then (their own request is in flight), so "abgemeldet" is noticed. */
async function refreshLinks(ctx) {
  const b = api(ctx.gc);
  if (!b || ctx.viewer == null) return;
  const nets = await store.all(ctx.gc, 'SELECT DISTINCT bridge_net AS n FROM conversations WHERE bridge_owner = ? AND bridge_net IS NOT NULL', [ctx.viewer]);
  for (const { n } of nets) {
    const k = `${ctx.viewer}:${n}`;
    if (ctx.now - (linkChecked.get(k) || 0) < LINK_CHECK_MS) continue;
    if (linkChecked.size > 2000) linkChecked.clear();
    linkChecked.set(k, ctx.now);
    try { await require('./bridges').refresh(ctx, n); } catch { /* as last seen */ }
  }
  // 1.25.1: a status room an older version kept as a chat
  await catchUpStatus(ctx);
}

// ─── what a conversation and a message say about the bridge ────────────────

/** `bridge` of a conversation view (null for a normal chat). */
async function convInfo(ctx, conv) {
  if (!isBridged(conv)) return null;
  const state = await stateFor(ctx, conv.bridge_owner, conv.bridge_net);
  // 1.15.0: files cross (GateControl with gc.bridges version 4) — `mediaTypes` names what the bridge takes per kind
  const media = !!bridgemedia.api(ctx.gc);
  return {
    network: conv.bridge_net, label: LABEL[conv.bridge_net] || conv.bridge_net, state, closed: !!conv.bridge_closed,
    // 1.20.0: a channel (only the channel writes; reactions: the person's own — 'own' — or none after the bridge refused
    // one — 'off'), a chat the person may not write into (a channel, a group where only admins write)
    channel: !!conv.bridge_channel, readOnly: !!(conv.bridge_read_only || conv.bridge_channel),
    ...(conv.bridge_channel ? { reactions: await bridgechannels.reactState(ctx, conv.bridge_net) } : {}),
    // 1.24.0: a chat with a Telegram bot; the member count of a group as the service reports it
    ...(conv.bridge_bot ? { bot: true } : {}),
    ...(Number.isSafeInteger(conv.bridge_members) && conv.bridge_members > 0 && conv.kind === 'group' ? { members: conv.bridge_members } : {}),
    supports: media ? SUPPORTS.concat(bridgemedia.SUPPORTS) : SUPPORTS,
    ...(media ? { mediaTypes: { image: bridgemedia.OUT_TYPES.image, video: bridgemedia.OUT_TYPES.video, voice: bridgemedia.OUT_TYPES.voice, file: null } } : {}),
  };
}

/** The highest ids of the person's own messages the other side has got / read (null when none). */
async function marks(gc, convId) {
  const r = await store.one(gc, "SELECT MAX(CASE WHEN ext_state = 'read' THEN id END) AS r, MAX(CASE WHEN ext_state IN ('read', 'delivered') THEN id END) AS d FROM messages WHERE conv_id = ? AND ext_state IS NOT NULL", [convId]);
  return { readUpTo: (r && r.r) || null, deliveredUpTo: (r && r.d) || null };
}

const STATUS_OUT = { pending: 'sending', sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };

/**
 * Message views of a bridged chat get `bridge`: { sender: { contactId, name } | null, state, reason, placeholder }
 * — and the reactions of contacts. `rows` and `out` are parallel (messages.views).
 */
async function decorate(ctx, rows, out) {
  const idx = [];
  rows.forEach((r, i) => { if (r.ext_sender != null || r.ext_state != null || r.ext_event != null || (r.via && String(r.via).startsWith('bridge:'))) idx.push(i); });
  if (!idx.length) return;
  const contactIds = [...new Set(idx.map((i) => rows[i].ext_sender).filter((x) => x != null))];
  const reacts = new Map();
  const ids = idx.map((i) => rows[i].id);
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    for (const r of await store.all(ctx.gc, `SELECT msg_id, contact_id, emoji FROM bridge_reactions WHERE msg_id IN (${store.marks(part.length)}) ORDER BY at, contact_id`, part)) {
      if (!reacts.has(r.msg_id)) reacts.set(r.msg_id, []);
      reacts.get(r.msg_id).push(r);
      if (!contactIds.includes(r.contact_id)) contactIds.push(r.contact_id);
    }
  }
  // quoted messages of contacts
  for (const i of idx) if (out[i].replyTo && out[i].replyTo.contactId != null && !contactIds.includes(out[i].replyTo.contactId)) contactIds.push(out[i].replyTo.contactId);
  const names = new Map();
  const pics = new Map();
  const seen = [];
  for (let i = 0; i < contactIds.length; i += 90) {
    const part = contactIds.slice(i, i + 90);
    for (const c of await store.all(ctx.gc, `SELECT id, name_enc, avatar_ref, avatar_got, avatar_media_id, avatar_want FROM bridge_contacts WHERE id IN (${store.marks(part.length)})`, part)) {
      const n = seal.open(c.name_enc);
      names.set(c.id, typeof n === 'string' && n ? n : null);
      // 1.15.0: the contact's picture, once fetched (a contact's picture is fetched once somebody sees their messages)
      pics.set(c.id, await bridgemedia.pictureOf(ctx.gc, c.avatar_media_id));
      seen.push(c);
    }
  }
  await bridgemedia.wantContacts(ctx, seen);
  // 1.20.0: the posts of a channel (no contact wrote them: the channel did)
  const convIds = [...new Set(idx.map((i) => rows[i].conv_id))];
  const channels = new Set((await store.all(ctx.gc, `SELECT id FROM conversations WHERE bridge_channel = 1 AND id IN (${store.marks(convIds.length)})`, convIds)).map((x) => x.id));
  for (const i of idx) {
    const r = rows[i];
    const o = out[i];
    const meta = (!r.deleted_at && require('./messages').metaOf(r)) || {};
    // 1.15.0: state 'loading' (the file is on its way), 'failed' with a reason, null (nothing to fetch); geo of a location
    const ph = meta.bridge && PLACEHOLDERS.includes(meta.bridge.placeholder) ? bridgemedia.placeholderView(meta.bridge, r) : null;
    const pic = r.ext_sender != null ? pics.get(r.ext_sender) || null : null;
    o.bridge = {
      sender: r.ext_sender != null ? { contactId: r.ext_sender, name: names.get(r.ext_sender) || null, avatarMediaId: pic, avatarUrl: pic && ctx.portal ? await avatarUrl(ctx, pic) : null } : null,
      // written in the messenger's own app (the person's phone), not here
      remote: r.sender_id != null && r.client_id == null,
      state: r.ext_state || null,
      reason: r.ext_reason || null,
      placeholder: ph,
      // 1.20.0: written by the channel (a post of a channel)
      channel: channels.has(r.conv_id) && r.sender_id == null && r.ext_sender == null,
      // 1.24.0: a bot's message had buttons the bridge could not carry
      ...(meta.bridge && meta.bridge.buttons === true ? { buttons: true } : {}),
    };
    // 1.20.0: the format of the text and the link preview (bridgechannels.viewFields)
    if (!r.deleted_at) Object.assign(o, await bridgechannels.viewFields(ctx, r, meta));
    if (r.sender_id != null && r.ext_state && !r.deleted_at) o.status = STATUS_OUT[r.ext_state] || o.status;
    if (o.replyTo && o.replyTo.contactId != null) o.replyTo.senderName = names.get(o.replyTo.contactId) || null;
    const list = reacts.get(r.id) || [];
    if (list.length) {
      const by = new Map(o.reactions.map((x) => [x.emoji, { ...x, contactIds: [] }]));
      for (const x of list) {
        if (!by.has(x.emoji)) by.set(x.emoji, { emoji: x.emoji, count: 0, userIds: [], contactIds: [] });
        const e = by.get(x.emoji);
        e.count += 1;
        e.contactIds.push(x.contact_id);
      }
      o.reactions = [...by.values()];
    }
  }
}

/** A signed URL of a picture for frames (the portal), null for the apps (they load it by its media id). */
async function avatarUrl(ctx, mediaId) {
  try { return await ctx.gc.media.url(mediaId, { user: ctx.viewer, ttlS: 6 * 3600 }); } catch { return null; }
}

// ─── in: the events of the bridges ──────────────────────────────────────────

async function convOf(gc, userId, net, ref) {
  return store.one(gc, 'SELECT * FROM conversations WHERE bridge_owner = ? AND bridge_net = ? AND bridge_ref = ?', [userId, net, ref]);
}

/**
 * 1.25.0: a chat „WhatsApp Status Broadcast“ known from before turns out to be the status room: it leaves the list
 * (muted, read, its messages run out 24 h after they were posted — older ones go at once). From an event that says
 * chat.status, and since 1.25.1 from catchUpStatus (the event went to an older version). → the conversation
 */
async function toStatusRoom(c, conv) {
  const u = conv.bridge_owner;
  await store.run(c.gc, "UPDATE members SET notify = 'none', last_read_id = MAX(last_read_id, ?), updated_at = ? WHERE conv_id = ? AND user_id = ?", [conv.last_msg_id || 0, c.now, conv.id, u]);
  await store.run(c.gc, 'UPDATE messages SET expires_at = MIN(COALESCE(expires_at, created_at + ?), created_at + ?) WHERE conv_id = ?', [bridgestatus.TTL_MS, bridgestatus.TTL_MS, conv.id]);
  await store.run(c.gc, 'UPDATE conversations SET bridge_status = 1, updated_at = ? WHERE id = ?', [c.now, conv.id]);
  live.queue(c.box, [u], 'conversation.update', { conversationId: conv.id, reason: 'bridge' });
  bridgestatus.changed(c.box, u, conv.id, null, 'new');
  return store.one(c.gc, 'SELECT * FROM conversations WHERE id = ?', [conv.id]);
}

/** The conversation of a chat (made when it is first heard of; listed only once it has a message). */
async function ensureConv(c, ev) {
  const chat = ev.chat && typeof ev.chat === 'object' ? ev.chat : {};
  if (!REF_RE.test(String(chat.id || ''))) return null;
  const kind = chat.kind === 'group' ? 'group' : 'direct';
  // 1.19.0: never a phone number as a name (util.bridgeName)
  const name = bridgeName(chat.name, NAME_MAX);
  // 1.20.0 (gc.bridges version 7): a channel, a chat the person may not write into — only when the event knows it
  const channel = typeof chat.channel === 'boolean' ? (chat.channel ? 1 : 0) : null;
  const readOnly = typeof chat.readOnly === 'boolean' ? (chat.readOnly ? 1 : 0) : null;
  // 1.24.0 (gc.bridges version 11): a chat with a bot, the member count — only when the event knows them
  const bot = chat.bot === true ? 1 : (chat.bot === false ? 0 : null);
  const members = Number.isSafeInteger(chat.members) && chat.members > 0 && chat.members <= 10000000 ? chat.members : null;
  const large = kind === 'group' && members != null && members >= LARGE_GROUP;
  // 1.25.0 (gc.bridges version 12): the room of the WhatsApp status updates — only when the event says so
  const status = chat.status === true ? 1 : null;
  let conv = await convOf(c.gc, ev.userId, ev.network, chat.id);
  if (!conv) {
    const r = await store.run(c.gc, 'INSERT INTO conversations (kind, title_enc, created_by, created_at, updated_at, bridge_net, bridge_ref, bridge_owner, bridge_channel, bridge_read_only, bridge_bot, bridge_members, bridge_status) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [kind, name ? seal.seal(name) : null, c.now, c.now, ev.network, chat.id, ev.userId, channel || 0, readOnly || 0, bot || 0, members, status || 0]);
    conv = await store.one(c.gc, 'SELECT * FROM conversations WHERE id = ?', [r.lastInsertRowid]);
    // a channel is muted from the start (its bell turns pushes on); 1.24.0: a large group too; 1.25.0: the status room
    await store.run(c.gc, "INSERT INTO members (conv_id, user_id, role, joined_at, joined_msg_id, last_read_id, last_delivered_id, updated_at, notify) VALUES (?, ?, 'member', ?, 0, 0, 0, ?, ?)", [conv.id, ev.userId, c.now, c.now, channel || large || status ? 'none' : 'all']);
    await bridgemedia.chatAvatar(c, conv, chat.avatar);
    return conv;
  }
  if (status && !conv.bridge_status) conv = await toStatusRoom(c, conv);
  if ((bot != null && bot !== conv.bridge_bot) || (members != null && members !== conv.bridge_members)) {
    // a group that turns out large before anything was said in it: muted as if it were new
    if (large && !conv.last_msg_id && !(conv.bridge_members >= LARGE_GROUP)) await store.run(c.gc, "UPDATE members SET notify = 'none', updated_at = ? WHERE conv_id = ? AND user_id = ?", [c.now, conv.id, ev.userId]);
    await store.run(c.gc, 'UPDATE conversations SET bridge_bot = ?, bridge_members = ?, updated_at = ? WHERE id = ?', [bot != null ? bot : conv.bridge_bot, members != null ? members : conv.bridge_members, c.now, conv.id]);
    conv = await store.one(c.gc, 'SELECT * FROM conversations WHERE id = ?', [conv.id]);
    if (conv.last_msg_id) live.queue(c.box, [ev.userId], 'conversation.update', { conversationId: conv.id, reason: 'bridge' });
  }
  if ((channel != null && channel !== conv.bridge_channel) || (readOnly != null && readOnly !== conv.bridge_read_only)) {
    // a chat known before 1.20.0 turns out to be a channel: it goes muted to the page „Kanäle“ (once)
    if (channel === 1 && !conv.bridge_channel) await store.run(c.gc, "UPDATE members SET notify = 'none', updated_at = ? WHERE conv_id = ? AND user_id = ?", [c.now, conv.id, ev.userId]);
    await store.run(c.gc, 'UPDATE conversations SET bridge_channel = ?, bridge_read_only = ?, updated_at = ? WHERE id = ?', [channel != null ? channel : conv.bridge_channel, readOnly != null ? readOnly : conv.bridge_read_only, c.now, conv.id]);
    conv = await store.one(c.gc, 'SELECT * FROM conversations WHERE id = ?', [conv.id]);
    if (conv.last_msg_id) live.queue(c.box, [ev.userId], 'conversation.update', { conversationId: conv.id, reason: 'bridge' });
  }
  // 1.23.0: the chat's disappearing messages (only when the event knows them: chat.timer object or null)
  if (chat.timer !== undefined) {
    const t = chat.timer && typeof chat.timer === 'object' ? Number(chat.timer.seconds) : 0;
    const secs = Number.isSafeInteger(t) && t > 0 ? Math.min(t, TIMER_MAX_S) : 0;
    if (secs !== (conv.disappearing_s || 0)) {
      await store.run(c.gc, 'UPDATE conversations SET disappearing_s = ?, updated_at = ? WHERE id = ?', [secs, c.now, conv.id]);
      conv = await store.one(c.gc, 'SELECT * FROM conversations WHERE id = ?', [conv.id]);
      if (conv.last_msg_id) live.queue(c.box, [ev.userId], 'conversation.update', { conversationId: conv.id, reason: 'bridge' });
    }
  }
  // 1.15.0: the chat's picture (a reference; fetched afterwards, bridgemedia.js)
  await bridgemedia.chatAvatar(c, conv, chat.avatar);
  const old = seal.open(conv.title_enc);
  // a stored name that is a number (delivered before 1.19.0) goes even when no better one comes
  const stale = typeof old === 'string' && bridgeName(old, NAME_MAX) !== old;
  if ((name && name !== old) || kind !== conv.kind || (stale && !name)) {
    await store.run(c.gc, 'UPDATE conversations SET title_enc = ?, kind = ?, updated_at = ? WHERE id = ?', [name ? seal.seal(name) : (stale ? null : conv.title_enc), kind, c.now, conv.id]);
    conv = await store.one(c.gc, 'SELECT * FROM conversations WHERE id = ?', [conv.id]);
    if (conv.last_msg_id) live.queue(c.box, [ev.userId], 'conversation.update', { conversationId: conv.id, reason: 'title' });
  }
  return conv;
}

async function ensureContact(c, ev, who) {
  if (!who || !CONTACT_RE.test(String(who.id || ''))) return null;
  const name = bridgeName(who.name, NAME_MAX);
  const old = await store.one(c.gc, 'SELECT * FROM bridge_contacts WHERE owner_id = ? AND network = ? AND ref = ?', [ev.userId, ev.network, who.id]);
  const avatar = who.avatar === null || bridgemedia.REF_RE.test(String(who.avatar || '')) ? who.avatar : undefined;
  if (!old) {
    const r = await store.run(c.gc, 'INSERT INTO bridge_contacts (owner_id, network, ref, name_enc, updated_at, avatar_ref) VALUES (?, ?, ?, ?, ?, ?)', [ev.userId, ev.network, who.id, name ? seal.seal(name) : null, c.now, avatar || null]);
    return r.lastInsertRowid;
  }
  const had = seal.open(old.name_enc);
  if (name && name !== had) await store.run(c.gc, 'UPDATE bridge_contacts SET name_enc = ?, updated_at = ? WHERE id = ?', [seal.seal(name), c.now, old.id]);
  else if (!name && typeof had === 'string' && bridgeName(had, NAME_MAX) !== had) await store.run(c.gc, 'UPDATE bridge_contacts SET name_enc = NULL, updated_at = ? WHERE id = ?', [c.now, old.id]);
  // 1.15.0: the contact's picture
  await bridgemedia.contactAvatar(c, old, avatar);
  return old.id;
}

const msgByEvent = (gc, convId, eventId) => store.one(gc, 'SELECT * FROM messages WHERE conv_id = ? AND ext_event = ?', [convId, eventId]);

async function park(c, conv, target, ev) {
  await store.run(c.gc, 'INSERT INTO bridge_pending (conv_id, target, data_enc, at) VALUES (?, ?, ?, ?)', [conv.id, target, seal.sealJson(ev), c.now]);
}

/** What waited for this message: applied in the order it arrived. */
async function unpark(c, conv, eventId) {
  const rows = await store.all(c.gc, 'SELECT * FROM bridge_pending WHERE conv_id = ? AND target = ? ORDER BY id', [conv.id, eventId]);
  if (!rows.length) return;
  await store.run(c.gc, 'DELETE FROM bridge_pending WHERE conv_id = ? AND target = ?', [conv.id, eventId]);
  for (const r of rows) {
    const ev = seal.openJson(r.data_enc);
    if (ev && typeof ev === 'object') await apply(c, ev, { parked: true });
  }
}

/** 1.24.0: is this event of a Telegram channel a child may not see (without the parents' „Telegram-Kanäle“)? */
async function channelHidden(c, ev) {
  if (ev.network !== 'telegram') return false;
  const chat = ev.chat && typeof ev.chat === 'object' ? ev.chat : {};
  let channel = chat.channel === true;
  if (typeof chat.channel !== 'boolean' && REF_RE.test(String(chat.id || ''))) {
    const conv = await convOf(c.gc, ev.userId, ev.network, chat.id);
    channel = !!(conv && conv.bridge_channel);
  }
  return channel && !(await require('./bridges').channelsAllowed(c.gc, ev.userId, ev.network, c.now));
}

/** One neutral event → the person's chats. Runs inside a transaction; events and pushes go to c.box. */
async function apply(c, ev, { parked = false } = {}) {
  if (!ev || typeof ev !== 'object' || !NETWORKS.includes(ev.network) || !c.users.has(ev.userId)) return;
  // a child whose parents did not (or no longer) allow the service gets nothing from it
  if (!(await require('./bridges').allowed(c.gc, ev.userId, ev.network, c.now)).allowed) { c.dropped = (c.dropped || 0) + 1; return; }
  // 1.24.0: a Telegram channel of a child without „Telegram-Kanäle“ — nothing of it (the chat's kind is in the event or known)
  if (await channelHidden(c, ev)) { c.dropped = (c.dropped || 0) + 1; return; }
  const at = Number.isFinite(Number(ev.at)) && Number(ev.at) > 0 ? Math.min(Number(ev.at), c.now) : c.now;
  const users = [ev.userId];
  // 1.17.0: older messages (bridgehistory.js) — no push, read already, one live event per chat
  const hist = ev.history === true || c.history === true;

  if (ev.type === 'chat') {
    const conv = await ensureConv(c, ev);
    if (conv && ev.closed === true && !conv.bridge_closed) {
      await store.run(c.gc, 'UPDATE conversations SET bridge_closed = 1, updated_at = ? WHERE id = ?', [c.now, conv.id]);
      if (conv.last_msg_id) live.queue(c.box, users, 'conversation.update', { conversationId: conv.id, reason: 'bridge' });
    } else if (conv && ev.closed !== true && conv.bridge_closed) {
      await store.run(c.gc, 'UPDATE conversations SET bridge_closed = 0, updated_at = ? WHERE id = ?', [c.now, conv.id]);
      if (conv.last_msg_id) live.queue(c.box, users, 'conversation.update', { conversationId: conv.id, reason: 'bridge' });
    }
    return;
  }
  if (ev.type === 'contact') {
    await ensureContact(c, ev, ev.contact);
    return;
  }
  const conv = await ensureConv(c, ev);
  if (!conv) return;
  const sender = ev.sender && typeof ev.sender === 'object' ? ev.sender : {};
  const me = await store.one(c.gc, 'SELECT * FROM members WHERE conv_id = ? AND user_id = ?', [conv.id, ev.userId]);
  if (!me) return;
  const messages = require('./messages');

  if (ev.type === 'message') {
    if (!EVENT_RE.test(String(ev.id || '')) || (await msgByEvent(c.gc, conv.id, ev.id))) return;
    // 1.25.0: a status that ran out already is not filed (nothing would show it)
    if (bridgestatus.isStatus(conv) && (bridgestatus.tooOld(at, c.now) || sender.self || sender.system)) return;
    const contactId = sender.self || sender.system ? null : await ensureContact(c, ev, sender);
    if (!sender.self && !sender.system && contactId == null) return;
    // 1.20.0: a channel's post (sender.channel) — written by the channel, only in a channel
    const byChannel = sender.channel === true && !!conv.bridge_channel;
    const raw = body(ev.text).slice(0, TEXT_MAX);
    let text = raw.trim() || null;
    const meta = {};
    let kind = 'text';
    // 1.23.0: the bridge's word that the chat's timer changed → the messenger's own line („Nachrichten verschwinden nach …“)
    const timer = ev.kind === 'notice' && ev.action && typeof ev.action === 'object' && ev.action.type === 'timer' ? ev.action : null;
    if (timer) {
      const t = Number(timer.seconds);
      kind = 'system';
      meta.system = { event: 'disappearing', by: null, seconds: Number.isSafeInteger(t) && t > 0 ? Math.min(t, TIMER_MAX_S) : 0, network: ev.network };
      text = null;
    } else if (sender.system && !byChannel) { kind = 'system'; meta.system = { event: 'bridge_notice', network: ev.network }; }
    else if (ev.viewOnce === true) { meta.bridge = { placeholder: 'view_once', name: null }; text = null; }
    // 1.24.0: a file too large to reach GateControl at all — a file placeholder that failed („Zu groß, öffne es in …“)
    else if (ev.tooLarge === true) { meta.bridge = { placeholder: 'file', name: null, reason: 'too_large' }; text = null; }
    else if (ev.kind === 'media') {
      // 1.15.0: the file's reference and details too — fetched afterwards into the media of this plugin (bridgemedia.js)
      meta.bridge = bridgemedia.placeholderOf(ev.media && typeof ev.media === 'object' ? ev.media : {}, PLACEHOLDERS);
    } else if (ev.kind !== 'text' && ev.kind !== 'notice') { meta.bridge = { placeholder: 'unsupported', name: null }; text = null; }
    // 1.20.0: the format of the text, the link preview (its picture is fetched afterwards, bridgechannels.previewRun)
    if (text && kind !== 'system') {
      const mk = bridgechannels.cleanMarks(ev.marks, text.length, raw.length - raw.trimStart().length);
      if (mk) meta.marks = mk;
    }
    const preview = kind === 'text' ? bridgechannels.cleanPreview(ev.preview) : null;
    if (preview) meta.preview = preview;
    // 1.24.0: a bot's message had buttons (the bridge cannot carry them)
    if (ev.buttons === true && kind !== 'system') meta.bridge = { ...(meta.bridge || {}), buttons: true };
    let replyTo = null;
    if (EVENT_RE.test(String(ev.replyTo || ''))) { const q = await msgByEvent(c.gc, conv.id, ev.replyTo); replyTo = q && !q.deleted_at ? q.id : null; }
    const cx = { ...c, now: at };
    const before = hist && conv.last_msg_id ? await store.one(c.gc, 'SELECT id, created_at FROM messages WHERE id = ?', [conv.last_msg_id]) : null;
    const id = await messages.insert(cx, conv, { senderId: sender.self ? ev.userId : null, kind, text, replyTo, meta, via: via(ev.network) });
    const file = !!(meta.bridge && meta.bridge.ref && bridgemedia.api(c.gc));
    // a file of the history only when the person asks for it (bridgehistory.js says why)
    const extMedia = file ? (hist ? 'ask' : 'wait') : null;
    const extPreview = preview && preview.image && bridgemedia.api(c.gc) ? 'wait' : null;
    await store.run(c.gc, 'UPDATE messages SET ext_sender = ?, ext_event = ?, ext_state = ?, ext_media = ?, ext_preview = ? WHERE id = ?', [contactId, ev.id, sender.self ? 'sent' : null, extMedia, extPreview, id]);
    if (extMedia === 'wait' || extPreview) c.mediaWork = true;
    // 1.25.0: a status update — no chat message (bridgestatus.filed: 24 h, read, no push, story.bridged)
    if (bridgestatus.isStatus(conv)) {
      await bridgestatus.filed(c, conv, ev, id, at);
      await unpark(c, conv, ev.id);
      return;
    }
    if (sender.self || hist) await store.run(c.gc, 'UPDATE members SET last_read_id = MAX(last_read_id, ?), last_delivered_id = MAX(last_delivered_id, ?), updated_at = ? WHERE conv_id = ? AND user_id = ?', [id, id, c.now, conv.id, ev.userId]);
    if (hist) {
      // changed now (the apps fetch messages?changedSince= and conversations?since= by it), shown at its own time; a
      // newer message the chat had already stays its last one
      await store.run(c.gc, 'UPDATE messages SET updated_at = ? WHERE id = ?', [c.now, id]);
      const last = before && before.created_at > at ? before.id : id;
      await store.run(c.gc, 'UPDATE conversations SET last_msg_id = ?, updated_at = ? WHERE id = ?', [last, c.now, conv.id]);
      conv.last_msg_id = last;
      if (!c.historyConvs) c.historyConvs = new Set();
      if (!c.historyConvs.has(conv.id)) {
        c.historyConvs.add(conv.id);
        live.queue(c.box, users, 'conversation.update', { conversationId: conv.id, reason: 'history' });
      }
      c.historyFiled = (c.historyFiled || 0) + 1;
      await unpark(c, conv, ev.id);
      return;
    }
    const row = await store.one(c.gc, 'SELECT * FROM messages WHERE id = ?', [id]);
    live.queue(c.box, users, 'message.new', { conversationId: conv.id, messageId: id, senderId: row.sender_id, clientId: null, kind: row.kind, createdAt: iso(row.created_at), bridge: ev.network });
    if (!sender.self && !parked) c.box.pushes.push({ bridged: { conv, me, row, text, meta, senderName: byChannel ? null : (sender.system ? LABEL[ev.network] : bridgeName(sender.name, NAME_MAX)), contactId, title: seal.open(conv.title_enc) || null } });
    await unpark(c, conv, ev.id);
    return;
  }

  if (ev.type === 'status') {
    if (!EVENT_RE.test(String(ev.target || ''))) return;
    // 1.20.0: the bridge's word on one of the person's reactions — a refusal takes it back here; in a channel reacting
    // goes off for this network (bridgechannels.reactRefused)
    const ownReact = await store.one(c.gc, 'SELECT r.msg_id FROM reactions r JOIN messages m ON m.id = r.msg_id WHERE r.ext_event = ? AND m.conv_id = ?', [ev.target, conv.id]);
    if (ownReact) {
      if (ev.status !== 'failed') return;
      await store.run(c.gc, 'DELETE FROM reactions WHERE ext_event = ? AND msg_id = ?', [ev.target, ownReact.msg_id]);
      if (conv.bridge_channel) await bridgechannels.reactRefused(c, conv.bridge_net);
      await reactionChanged(c, conv, ownReact.msg_id, users);
      if (conv.bridge_channel) live.queue(c.box, users, 'conversation.update', { conversationId: conv.id, reason: 'bridge' });
      return;
    }
    const m = await msgByEvent(c.gc, conv.id, ev.target);
    if (!m) { if (!parked) await park(c, conv, ev.target, ev); return; }
    if (m.sender_id == null || m.deleted_at) return;
    const rank = { pending: 0, failed: 0, sent: 1, delivered: 2, read: 3 };
    let state = m.ext_state;
    let reason = m.ext_reason;
    if (ev.status === 'failed') { if ((rank[m.ext_state] || 0) < 2) { state = 'failed'; reason = REASON_RE.test(String(ev.reason || '')) ? ev.reason : 'bridge_error'; } }
    else if ((ev.status === 'sent' || ev.status === 'delivered') && rank[ev.status] > (rank[m.ext_state] || 0)) { state = ev.status; reason = null; }
    else if (ev.status === 'sent' && m.ext_state === 'failed') { state = 'sent'; reason = null; }
    if (state === m.ext_state && reason === m.ext_reason) return;
    await store.run(c.gc, 'UPDATE messages SET ext_state = ?, ext_reason = ?, updated_at = ? WHERE id = ?', [state, reason, c.now, m.id]);
    live.queue(c.box, users, 'message.update', { conversationId: conv.id, messageId: m.id, editedAt: iso(c.now), status: STATUS_OUT[state] });
    return;
  }

  // 1.25.0: a status is neither changed nor reacted to; the bridge's word on a message there does not exist
  if (bridgestatus.isStatus(conv) && ev.type !== 'redact') return;

  if (ev.type === 'edit') {
    if (!EVENT_RE.test(String(ev.target || ''))) return;
    const m = await msgByEvent(c.gc, conv.id, ev.target);
    if (!m) { if (!parked) await park(c, conv, ev.target, ev); return; }
    // only the one who wrote it changes it
    const mine = sender.self === true && m.sender_id === ev.userId;
    // 1.20.0: a channel changes its own posts
    const chan = sender.channel === true && !!conv.bridge_channel && m.sender_id == null && m.ext_sender == null;
    const theirs = !sender.self && !chan && m.ext_sender != null && m.ext_sender === await ensureContact(c, ev, sender);
    if (m.deleted_at || m.kind !== 'text' || !(mine || theirs || chan)) return;
    const raw = body(ev.text).slice(0, TEXT_MAX);
    const text = raw.trim();
    // 1.20.0: the new text with its format (and a new preview, when the bridge sends one)
    const meta = messages.metaOf(m) || {};
    const mk = bridgechannels.cleanMarks(ev.marks, text.length, raw.length - raw.trimStart().length);
    const pv = bridgechannels.cleanPreview(ev.preview);
    const before = JSON.stringify([meta.marks || null, meta.preview ? meta.preview.url : null]);
    if (mk) meta.marks = mk; else delete meta.marks;
    if (pv && (!meta.preview || meta.preview.url !== pv.url)) meta.preview = pv;
    const changedMeta = before !== JSON.stringify([meta.marks || null, meta.preview ? meta.preview.url : null]);
    if (!text || (text === messages.bodyOf(m) && !changedMeta)) return;
    const extPreview = changedMeta && pv && meta.preview === pv && pv.image && bridgemedia.api(c.gc) ? 'wait' : m.ext_preview;
    await store.run(c.gc, 'UPDATE messages SET body_enc = ?, meta_enc = ?, ext_preview = ?, edited_at = ?, updated_at = ? WHERE id = ?', [seal.seal(text), seal.sealJson(meta), extPreview || null, at, c.now, m.id]);
    if (extPreview === 'wait') c.mediaWork = true;
    await store.run(c.gc, 'UPDATE conversations SET updated_at = ? WHERE id = ?', [c.now, conv.id]);
    live.queue(c.box, users, 'message.update', { conversationId: conv.id, messageId: m.id, editedAt: iso(at) });
    return;
  }

  if (ev.type === 'reaction') {
    if (!EVENT_RE.test(String(ev.target || '')) || !EVENT_RE.test(String(ev.id || ''))) return;
    let emoji;
    try { emoji = messages.cleanEmoji(typeof ev.emoji === 'string' ? ev.emoji : ''); } catch { return; }
    const m = await msgByEvent(c.gc, conv.id, ev.target);
    if (!m) { if (!parked) await park(c, conv, ev.target, ev); return; }
    if (m.deleted_at) return;
    if (sender.self) {
      await store.run(c.gc, 'INSERT INTO reactions (msg_id, user_id, emoji, at, ext_event) VALUES (?, ?, ?, ?, ?) ON CONFLICT(msg_id, user_id) DO UPDATE SET emoji = excluded.emoji, at = excluded.at, ext_event = excluded.ext_event', [m.id, ev.userId, emoji, at, ev.id]);
    } else {
      const contactId = await ensureContact(c, ev, sender);
      if (contactId == null) return;
      await store.run(c.gc, 'INSERT INTO bridge_reactions (msg_id, contact_id, emoji, ext_event, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(msg_id, contact_id) DO UPDATE SET emoji = excluded.emoji, ext_event = excluded.ext_event, at = excluded.at', [m.id, contactId, emoji, ev.id, at]);
    }
    await reactionChanged(c, conv, m.id, users);
    return;
  }

  if (ev.type === 'redact') {
    if (!EVENT_RE.test(String(ev.target || ''))) return;
    // a reaction taken back
    const br = await store.one(c.gc, 'SELECT r.msg_id FROM bridge_reactions r JOIN messages m ON m.id = r.msg_id WHERE r.ext_event = ? AND m.conv_id = ?', [ev.target, conv.id]);
    if (br) {
      await store.run(c.gc, 'DELETE FROM bridge_reactions WHERE ext_event = ? AND msg_id = ?', [ev.target, br.msg_id]);
      await reactionChanged(c, conv, br.msg_id, users);
      return;
    }
    const own = await store.one(c.gc, 'SELECT r.msg_id FROM reactions r JOIN messages m ON m.id = r.msg_id WHERE r.ext_event = ? AND m.conv_id = ?', [ev.target, conv.id]);
    if (own) {
      await store.run(c.gc, 'DELETE FROM reactions WHERE ext_event = ? AND msg_id = ?', [ev.target, own.msg_id]);
      await reactionChanged(c, conv, own.msg_id, users);
      return;
    }
    const m = await msgByEvent(c.gc, conv.id, ev.target);
    if (!m) { if (!parked) await park(c, conv, ev.target, ev); return; }
    if (m.deleted_at) return;
    await tombstone(c, conv, m.id, users);
    // 1.25.0: the contact deleted a status — gone from the status row at once
    if (bridgestatus.isStatus(conv)) bridgestatus.changed(c.box, ev.userId, conv.id, m.id, 'remove');
  }
}

async function reactionChanged(c, conv, msgId, users) {
  await store.run(c.gc, 'UPDATE messages SET updated_at = ? WHERE id = ?', [c.now, msgId]);
  live.queue(c.box, users, 'message.update', { conversationId: conv.id, messageId: msgId, editedAt: iso(c.now), reactions: true });
}

/** Deleted for everyone: the row stays as a tombstone, like a message deleted in GateControl. */
async function tombstone(c, conv, msgId, users) {
  await store.run(c.gc, 'UPDATE messages SET deleted_at = ?, body_enc = NULL, meta_enc = NULL, media_id = NULL, thumb_media_id = NULL, reply_to = NULL, ext_media = NULL, updated_at = ? WHERE id = ?', [c.now, c.now, msgId]);
  // 1.15.0: a file it brought goes with it
  await require('./messages').orphanMedia(c.gc, [msgId]);
  await store.run(c.gc, 'DELETE FROM reactions WHERE msg_id = ?', [msgId]);
  await store.run(c.gc, 'DELETE FROM bridge_reactions WHERE msg_id = ?', [msgId]);
  await store.run(c.gc, 'UPDATE conversations SET updated_at = ? WHERE id = ?', [c.now, conv.id]);
  live.queue(c.box, users, 'message.delete', { conversationId: conv.id, messageIds: [msgId], reason: 'deleted' });
}

/** "typing …" and read receipts of the other side: live only, and a read mark on the person's own messages. */
async function applyEphemeral(c, ev) {
  if (!ev || typeof ev !== 'object' || !NETWORKS.includes(ev.network) || !c.users.has(ev.userId)) return;
  const chat = ev.chat && typeof ev.chat === 'object' ? ev.chat : {};
  if (!REF_RE.test(String(chat.id || ''))) return;
  const conv = await convOf(c.gc, ev.userId, ev.network, chat.id);
  // 1.25.0: nobody types or reads in the status room (and nothing of it is a chat)
  if (!conv || !conv.last_msg_id || bridgestatus.isStatus(conv)) return;
  const prefs = (await people.prefsOf(c.gc, [ev.userId])).get(ev.userId) || {};
  if (ev.type === 'typing') {
    if (prefs.typing === false) return;
    const refs = (Array.isArray(ev.contacts) ? ev.contacts : []).filter((x) => CONTACT_RE.test(String(x))).slice(0, 20);
    const list = [];
    for (const ref of refs) {
      const k = await store.one(c.gc, 'SELECT id, name_enc FROM bridge_contacts WHERE owner_id = ? AND network = ? AND ref = ?', [ev.userId, ev.network, ref]);
      if (k) list.push({ contactId: k.id, name: seal.open(k.name_enc) || null });
    }
    live.queue(c.box, [ev.userId], 'typing', { conversationId: conv.id, userId: null, contacts: list, until: list.length ? iso(c.now + live.TYPING_MS) : null });
    return;
  }
  if (ev.type === 'receipt' && EVENT_RE.test(String(ev.upTo || ''))) {
    const m = await msgByEvent(c.gc, conv.id, ev.upTo);
    if (!m) return;
    const reader = ev.reader && typeof ev.reader === 'object' ? ev.reader : {};
    if (reader.self) {
      // read in the messenger's own app: read here too
      const me = await store.one(c.gc, 'SELECT * FROM members WHERE conv_id = ? AND user_id = ?', [conv.id, ev.userId]);
      if (me && m.id > me.last_read_id) {
        await store.run(c.gc, 'UPDATE members SET last_read_id = ?, last_delivered_id = MAX(last_delivered_id, ?), updated_at = ? WHERE conv_id = ? AND user_id = ?', [m.id, m.id, c.now, conv.id, ev.userId]);
        const me2 = { ...me, last_read_id: m.id, last_delivered_id: Math.max(me.last_delivered_id, m.id) };
        live.queue(c.box, [ev.userId], 'read', { conversationId: conv.id, userId: ev.userId, lastReadId: m.id, lastDeliveredId: me2.last_delivered_id, self: true, unread: await require('./messages').unreadCount(c.gc, me2), ...(await marks(c.gc, conv.id)) });
      }
      return;
    }
    // the other side read up to here (shown only to people who share read receipts themselves)
    const r = await store.run(c.gc, "UPDATE messages SET ext_state = 'read', updated_at = ? WHERE conv_id = ? AND sender_id = ? AND id <= ? AND ext_state IN ('sent', 'delivered') AND deleted_at IS NULL", [c.now, conv.id, ev.userId, m.id]);
    if (r && r.changes) live.queue(c.box, [ev.userId], 'read', { conversationId: conv.id, userId: null, lastReadId: prefs.readReceipts === false ? null : m.id, lastDeliveredId: m.id, ...(await marksFor(c.gc, conv.id, prefs)) });
  }
}

/** marks() as the person may see them: no "read" for somebody who does not share read receipts. */
async function marksFor(gc, convId, prefs) {
  const mk = await marks(gc, convId);
  return prefs && prefs.readReceipts === false ? { readUpTo: null, deliveredUpTo: mk.deliveredUpTo } : mk;
}

let pumping = Promise.resolve();

/**
 * Fetch what the bridges delivered, file it, acknowledge it. One run at a time; never throws.
 * `make()` → a fresh context { gc, now, users, box, … } (index.js), `flush(ctx)` sends its events and pushes.
 */
function pump(gc, make, flush, ephemeral) {
  const run = pumping.then(() => pumpNow(gc, make, flush, ephemeral)).catch((e) => { gc.log.warn('bridge events failed', (e && (e.code || e.message)) || 'error'); return { filed: 0 }; });
  pumping = run;
  return run;
}

async function pumpNow(gc, make, flush, ephemeral) {
  const b = api(gc);
  if (!b) return { filed: 0 };
  let filed = 0;
  let media = false;
  for (let round = 0; round < 50; round++) {
    const r = await b.events.pull({ after: 0, limit: 100 });
    const list = r && Array.isArray(r.events) ? r.events : [];
    if (!list.length) break;
    const ctx = await make();
    let last = 0;
    await store.tx(gc, async () => {
      for (const ev of list) {
        if (!Number.isSafeInteger(ev.seq)) continue;
        try { await apply(ctx, ev); }
        catch (e) { await log.add(gc, 'bridge_event_failed', String((e && (e.code || e.message)) || 'error').slice(0, 60), ctx.now); }
        last = Math.max(last, ev.seq);
      }
    });
    if (ctx.dropped) await log.add(gc, 'bridge_event_locked', `dropped ${ctx.dropped}`, ctx.now);
    if (ctx.mediaWork) media = true;
    filed += list.length;
    // filed and committed: now GateControl may forget them (a crash before this line files them again — once, by their id)
    if (last) await b.events.ack(last);
    await flush(ctx);
    if (!r.more || !last) break;
  }
  if (Array.isArray(ephemeral) && ephemeral.length) {
    const ctx = await make();
    await store.tx(gc, async () => { for (const ev of ephemeral.slice(0, 200)) { try { await applyEphemeral(ctx, ev); } catch { /* live only */ } } });
    await flush(ctx);
  }
  // 1.15.0: files and pictures to fetch — after the events are filed and acknowledged, not waited for here
  if (media) bridgemedia.kick(gc);
  return { filed, media };
}

/** Background: what waited a day for its message is dropped. */
async function sweep(gc, now) {
  await store.run(gc, 'DELETE FROM bridge_pending WHERE at < ?', [now - PENDING_MS]);
}

// ─── pushes ─────────────────────────────────────────────────────────────────

/** The push of a contact's message: to the one person the chat belongs to — like a normal chat's, never to anybody else. */
async function push(gc, job, users, now) {
  const { conv, me, row } = job;
  const u = conv.bridge_owner;
  if (!users.has(u) || me.notify === 'none' || (me.muted_until != null && me.muted_until > now) || live.isActive(u, conv.id, now)) return [];
  if ((await require('./status').dndUsers(gc, now)).has(u)) return [];
  const p = (await people.prefsOf(gc, [u])).get(u) || {};
  const lang = p.lang === 'en' ? 'en' : 'de';
  const net = LABEL[conv.bridge_net] || conv.bridge_net;
  // 1.19.0: a contact without a name (never its number) → „WhatsApp-Kontakt“
  let name = job.senderName || bridgeName(job.title, NAME_MAX) || titleLabel({ lang }, conv.bridge_net, conv.kind === 'group');
  // 1.21.0: a way of a person — „Jenny Backes · über WhatsApp“ (persons.js)
  const person = conv.kind === 'direct' && !conv.bridge_channel ? await require('./persons').pushName(gc, u, conv.id, users) : null;
  if (person && person.name) name = person.name;
  // 1.20.0: a channel's post (only when the person turned the channel's bell on) — „<Kanal> · Kanal über WhatsApp“
  const chan = !!conv.bridge_channel;
  const ph = job.meta && job.meta.bridge ? job.meta.bridge.placeholder : null;
  let text = typeof job.text === 'string' ? job.text : '';
  if (ph) text = [t(lang, 'bridgechat.placeholder.' + ph), text].filter(Boolean).join(': ');
  text = text.replace(/\s+/g, ' ').trim();
  const n = {
    topic: 'message',
    title: chan ? t(lang, 'bridgechat.push_channel', { name, network: net })
      : (person && p.preview ? t(lang, 'person.push_title', { name, way: net })
        : (p.preview ? t(lang, 'bridgechat.push_title', { name, network: net }) : t(lang, 'bridgechat.push_neutral', { name, network: net }))),
    body: p.preview ? (text.length > 1000 ? text.slice(0, 999) + '…' : text) : '',
    users: [u],
    priority: 'normal',
    conversation: { id: String(conv.id), title: conv.kind === 'group' ? (job.title || null) : null, isGroup: conv.kind === 'group' },
    sender: { id: job.contactId != null ? `ext-${job.contactId}` : (chan ? `channel-${conv.id}` : 'gatecontrol'), name, avatarUrl: null },
    data: { messageId: row.id, conversationId: conv.id, bridge: conv.bridge_net, ...(chan ? { channel: true } : {}), ...(person ? { person: { id: person.personId, conversationId: person.conversationId } } : {}), actions: [
      // `bridged` in the body: the buttons of a push work in every app, also one that does not list bridged chats; no
      // answer into a channel or a group where only admins write
      ...(chan || conv.bridge_read_only ? [] : [{ type: 'reply', label: t(lang, 'push.reply'), path: `conversations/${conv.id}/messages`, body: { bridged: true } }]),
      { type: 'mark_read', label: t(lang, 'push.mark_read'), path: `conversations/${conv.id}/read`, body: { upTo: row.id, bridged: true } },
    ] },
  };
  try {
    const res = await gc.notify(n);
    if (res && Array.isArray(res.skipped) && res.skipped.length) await log.add(gc, 'push_rate_limit', `skipped ${res.skipped.length}`, now);
    return [{ users: [u], preview: !!p.preview, lang }];
  } catch (e) {
    await log.add(gc, e && e.code === 'ERR_RATE_LIMIT' ? 'push_rate_limit' : 'push_failed', e && e.code === 'ERR_RATE_LIMIT' ? null : ((e && e.code) || 'error'), now);
    return [];
  }
}

// ─── out: the person writes ─────────────────────────────────────────────────

/** Everything that must hold before something goes out. → gc.bridges */
async function gate(ctx, conv) {
  const b = api(ctx.gc);
  if (!b) throw fail('bridge_off', { reason: 'no_host' });
  const st = await stateFor(ctx, conv.bridge_owner, conv.bridge_net);
  if (st === 'locked') throw fail('bridge_locked');
  if (st === 'off') throw fail('bridge_off', { reason: 'off' });
  if (st === 'unreachable') throw fail('bridge_unreachable', { reason: 'not_running' });
  if (st === 'logged_out' || st === 'unlinked') throw fail('bridge_unlinked', { reason: st });
  if (conv.bridge_closed) throw fail('bridge_failed', { reason: 'chat_closed' });
  return b;
}

/** 1.20.0: nothing is written into a channel or a group where only admins write (before anything is stored). */
function writable(conv) {
  if (conv.bridge_channel) throw fail('bridge_read_only', { reason: 'channel' });
  if (conv.bridge_read_only) throw fail('bridge_read_only', { reason: 'admins_only' });
}

/**
 * What a bridged chat takes: a text, maybe as an answer — and since 1.15.0 (gc.bridges version 4) a picture, voice
 * message or file (a video is a file), with a caption: only one the virus scan has finished with (scan_pending
 * otherwise; infected / blocked files are refused by messages.send as everywhere), in a type the bridge takes
 * (bridge_media_type, reason = the kind). Everything else is refused before anything is stored.
 */
async function checkBody(ctx, b) {
  const x = b && typeof b === 'object' && !Array.isArray(b) ? b : null;
  if (!x) throw fail('invalid');
  const kind = x.kind == null ? 'text' : x.kind;
  for (const k of ['location', 'poll', 'event', 'arrival', 'action', 'replyStory']) if (x[k] != null) throw fail('bridge_text_only', { reason: 'kind' });
  if (kind === 'text') {
    for (const k of ['mediaId', 'thumbMediaId', 'video', 'meta']) if (x[k] != null) throw fail('bridge_text_only', { reason: 'kind' });
    return;
  }
  if (!['image', 'voice', 'file'].includes(kind) || !bridgemedia.api(ctx.gc)) throw fail('bridge_text_only', { reason: 'kind' });
  if (typeof x.mediaId !== 'string' || !/^[0-9a-f]{32}$/.test(x.mediaId)) throw fail('invalid');
  let info = null;
  try { info = await ctx.gc.media.info(x.mediaId); } catch { info = null; }
  // anything else about the file (whose it is, used already, its kind) messages.send checks as for every chat
  if (!info) return;
  const sc = scan.norm(info.scan);
  if (sc && sc.state === 'pending') throw fail('scan_pending');
  const no = bridgemedia.outRefusal(kind, info.mime);
  if (no) throw fail('bridge_media_type', { reason: no });
}

// The id a step is sent under: a message's own (so sending it again sends it once), a fresh one for every edit,
// deletion or reaction (each is a step of its own).
const txnOf = (row, step) => `gc-${row.id}-${step ? step + crypto.randomBytes(6).toString('hex') : (row.client_id || 'x')}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 96);

/** Hand a stored message to the bridge and note what became of it. → the row afterwards */
async function deliver(ctx, b, conv, row) {
  let ext = null;
  let reason = null;
  const text = require('./messages').bodyOf(row);
  let replyTo = null;
  if (row.reply_to) { const q = await store.one(ctx.gc, 'SELECT ext_event FROM messages WHERE id = ?', [row.reply_to]); replyTo = q && q.ext_event ? q.ext_event : null; }
  // 1.15.0: a message with a file — the caption is its text
  let media = null;
  if (row.media_id) {
    const f = await store.one(ctx.gc, 'SELECT mime FROM media WHERE media_id = ?', [row.media_id]);
    media = bridgemedia.outMedia(row, f || {});
  }
  try {
    const r = await b.send(ctx.viewer, conv.bridge_net, conv.bridge_ref, { txnId: txnOf(row), ...(media ? { media, ...(text ? { text } : {}) } : { text }), ...(replyTo ? { replyTo } : {}) });
    ext = r && EVENT_RE.test(String(r.id || '')) ? r.id : null;
    if (!ext) reason = 'bad_answer';
  } catch (e) {
    reason = reasonOf(e);
    if (e && e.code === 'ERR_NOT_PERSON') throw mapped(e);
  }
  await store.tx(ctx.gc, async () => {
    if (ext) {
      // the bridge's word may have arrived before this line: it waits in bridge_pending and is applied now
      await store.run(ctx.gc, "UPDATE messages SET ext_event = ?, ext_state = CASE WHEN ext_state IN ('pending', 'failed') OR ext_state IS NULL THEN 'sent' ELSE ext_state END, ext_reason = NULL, updated_at = ? WHERE id = ?", [ext, ctx.now, row.id]);
      await unpark(ctx, conv, ext);
    } else {
      await store.run(ctx.gc, "UPDATE messages SET ext_state = 'failed', ext_reason = ?, updated_at = ? WHERE id = ?", [reason, ctx.now, row.id]);
    }
  });
  if (!ext) await log.add(ctx.gc, 'bridge_send_failed', reason, ctx.now);
  return store.one(ctx.gc, 'SELECT * FROM messages WHERE id = ?', [row.id]);
}

/** POST conversations/:id/messages for a bridged chat. `stored` = messages.send's result, committed. → the row afterwards */
async function sendOut(ctx, conv, stored) {
  if (stored.duplicate) return stored.row;
  const b = api(ctx.gc);
  return deliver(ctx, b, conv, stored.row);
}

/** POST messages/:id/resend — a message that did not go out, again (the same id at the bridge: sent once). */
async function resend(ctx, conv, row) {
  if (row.sender_id !== ctx.viewer) throw fail('not_sender');
  if (row.deleted_at) throw fail('deleted');
  if (row.ext_state !== 'failed' && row.ext_state !== 'pending') throw fail('invalid');
  const b = await gate(ctx, conv);
  await store.tx(ctx.gc, () => store.run(ctx.gc, "UPDATE messages SET ext_state = 'pending', ext_reason = NULL, updated_at = ? WHERE id = ?", [ctx.now, row.id]));
  return deliver(ctx, b, conv, row);
}

/** Before PATCH messages/:id: the edit goes to the other side first; only then the text changes here. */
async function editOut(ctx, conv, row, text) {
  if (!row.ext_event || row.kind !== 'text') throw fail('bridge_text_only', { reason: 'edit' });
  const b = await gate(ctx, conv);
  try { await b.send(ctx.viewer, conv.bridge_net, conv.bridge_ref, { txnId: txnOf(row, 'e'), text, edit: row.ext_event }); } catch (e) { throw mapped(e); }
}

/** Before DELETE messages/:id?for=all. A message that never went out is simply removed here. */
async function deleteOut(ctx, conv, row) {
  if (!row.ext_event) return;
  const b = await gate(ctx, conv);
  try { await b.redact(ctx.viewer, conv.bridge_net, conv.bridge_ref, { txnId: txnOf(row, 'd'), target: row.ext_event }); } catch (e) { throw mapped(e); }
}

/** Before PUT messages/:id/reaction: take the old one back, set the new one. → the bridge's id of the new reaction (null: none) */
async function reactOut(ctx, conv, row, emoji) {
  if (!row.ext_event) throw fail('bridge_text_only', { reason: 'reaction' });
  const b = await gate(ctx, conv);
  // 1.20.0: in a channel only while the bridge took reactions there (bridgechannels.reactState)
  if (conv.bridge_channel && (await bridgechannels.reactState(ctx, conv.bridge_net)) === 'off') throw fail('bridge_read_only', { reason: 'reactions_off' });
  const old = await store.one(ctx.gc, 'SELECT ext_event FROM reactions WHERE msg_id = ? AND user_id = ?', [row.id, ctx.viewer]);
  try {
    if (old && old.ext_event) await b.redact(ctx.viewer, conv.bridge_net, conv.bridge_ref, { txnId: txnOf(row, 'u'), target: old.ext_event });
    if (emoji == null) return null;
    const r = await b.react(ctx.viewer, conv.bridge_net, conv.bridge_ref, { txnId: txnOf(row, 'r'), target: row.ext_event, emoji });
    return r && EVENT_RE.test(String(r.id || '')) ? r.id : null;
  } catch (e) {
    // the bridge refused a reaction in a channel: no more reactions in channels of this network
    if (conv.bridge_channel && e && e.code === 'ERR_BRIDGE') await store.tx(ctx.gc, () => bridgechannels.reactRefused(ctx, conv.bridge_net, bridgechannels.bridgeVersion(ctx, conv.bridge_net)));
    throw mapped(e);
  }
}

/** After POST conversations/:id/read: tell the other side (only for people who share read receipts). Best effort. */
async function readOut(ctx, conv, upTo) {
  const b = api(ctx.gc);
  // 1.25.0: never from the room of the status updates — "seen" there only on the person's own switch (bridgestatus.seen)
  if (!b || conv.bridge_closed || bridgestatus.isStatus(conv)) return;
  const prefs = (await people.prefsOf(ctx.gc, [ctx.viewer])).get(ctx.viewer) || {};
  if (prefs.readReceipts === false) return;
  const m = await store.one(ctx.gc, 'SELECT ext_event FROM messages WHERE conv_id = ? AND id <= ? AND ext_sender IS NOT NULL AND ext_event IS NOT NULL ORDER BY id DESC LIMIT 1', [conv.id, upTo]);
  if (!m) return;
  try { await b.read(ctx.viewer, conv.bridge_net, conv.bridge_ref, m.ext_event); } catch { /* the mark here stands */ }
}

/** POST conversations/:id/typing of a bridged chat. Best effort, at most every few seconds. */
async function typingOut(ctx, conv, bodyIn) {
  const b = api(ctx.gc);
  const stop = !!(bodyIn && bodyIn.stop === true);
  const prefs = (await people.prefsOf(ctx.gc, [ctx.viewer])).get(ctx.viewer) || {};
  if (!b || conv.bridge_closed || conv.bridge_channel || conv.bridge_read_only || prefs.typing === false) return { until: null };
  if (stop) {
    if (live.clearTyping(conv.id, ctx.viewer, ctx.now)) { try { await b.typing(ctx.viewer, conv.bridge_net, conv.bridge_ref, false); } catch { /* live only */ } }
    return { until: null };
  }
  const tt = live.setTyping(conv.id, ctx.viewer, ctx.now);
  if (tt.emit) { try { await b.typing(ctx.viewer, conv.bridge_net, conv.bridge_ref, true); } catch { /* live only */ } }
  return { until: iso(tt.until) };
}

/** 1.15.0: the conversation of a chat a person just opened by number (bridges.js newChat). Inside a transaction. */
async function openChat(ctx, net, chat) {
  return ensureConv({ gc: ctx.gc, now: ctx.now, box: ctx.box }, { userId: ctx.viewer, network: net, chat });
}

/**
 * 1.19.0: names stored before — a chat or contact named by its phone number („+49… (WA)“) — are put right once per
 * start: the suffix goes, a number becomes no name (the view then shows the address book's name or a neutral label).
 * → { chats, contacts } changed. Never throws.
 */
let namesFixed = false;
async function fixNames(gc) {
  if (namesFixed) return { chats: 0, contacts: 0 };
  const out = { chats: 0, contacts: 0 };
  try {
    const now = Date.now();
    for (const r of await store.all(gc, 'SELECT id, title_enc, bridge_owner, last_msg_id FROM conversations WHERE bridge_net IS NOT NULL AND title_enc IS NOT NULL')) {
      const old = seal.open(r.title_enc);
      if (typeof old !== 'string') continue;
      const n = bridgeName(old, NAME_MAX);
      if (n === old) continue;
      await store.run(gc, 'UPDATE conversations SET title_enc = ?, updated_at = ? WHERE id = ?', [n ? seal.seal(n) : null, now, r.id]);
      out.chats++;
      if (r.last_msg_id) {
        const box = live.outbox();
        live.queue(box, [r.bridge_owner], 'conversation.update', { conversationId: r.id, reason: 'title' });
        await live.flush(gc, box);
      }
    }
    for (const r of await store.all(gc, 'SELECT id, name_enc FROM bridge_contacts WHERE name_enc IS NOT NULL')) {
      const old = seal.open(r.name_enc);
      if (typeof old !== 'string') continue;
      const n = bridgeName(old, NAME_MAX);
      if (n === old) continue;
      await store.run(gc, 'UPDATE bridge_contacts SET name_enc = ?, updated_at = ? WHERE id = ?', [n ? seal.seal(n) : null, now, r.id]);
      out.contacts++;
    }
    namesFixed = true;
    if (out.chats || out.contacts) await log.add(gc, 'bridge_names_fixed', `chats ${out.chats}, contacts ${out.contacts}`, now);
  } catch (e) { gc.log.warn('bridge names not fixed', (e && (e.code || e.message)) || 'error'); }
  return out;
}

/** 1.19.0: the title of a bridged chat as the viewer sees it — address book, the bridge's name, a neutral label. */
async function titleFor(ctx, conv) {
  const own = conv.kind === 'direct' ? await require('./contactchat').bookNameOf(ctx, conv) : null;
  if (own) return own;
  const stored = seal.open(conv.title_enc);
  const n = typeof stored === 'string' ? bridgeName(stored, NAME_MAX) : null;
  if (n) return n;
  return titleLabel(ctx, conv.bridge_net, conv.kind === 'group');
}

/** „WhatsApp-Kontakt“ / „WhatsApp-Gruppe“ — a chat or contact without a name. */
function titleLabel(ctx, net, group = false) {
  return t(ctx && ctx.lang === 'en' ? 'en' : 'de', group ? 'bridgechat.unknown_group' : 'bridgechat.unknown_contact', { network: LABEL[net] || net });
}

/** Has this person a bridged chat with a message? (GET me: features.bridge_chats) */
async function hasChats(gc, userId) {
  return !!(await store.one(gc, 'SELECT 1 AS x FROM conversations WHERE bridge_owner = ? AND bridge_net IS NOT NULL AND bridge_status = 0 AND last_msg_id IS NOT NULL LIMIT 1', [userId]));
}

/**
 * 1.25.1: the status room whose event went to an older version. GateControl (gc.bridges version 12) looks at every
 * WhatsApp room once more after its update (events.refreshRooms) and says chat.status ONCE — when the server is updated
 * first, Messenger 1.24.x still runs, ignores it, and nothing says it again until a contact posts a new status. So, in
 * a request of the person (gc.bridges.chats is asked only then: GET conversations with ?bridged=1 through
 * refreshLinks, GET status/feed), at most hourly per person until done: the person's chats at the bridge (status: true
 * names the status room), and a conversation of such a room that is still a chat becomes the status room
 * (toStatusRoom). Only with version 12, a WhatsApp link and WhatsApp conversations that are no status room. Done once
 * the bridge named the person's chats (an empty list or an error: the bridges are away — again in an hour) → settings
 * `bridge_status_catchup:<id>`, never again: every event says chat.status itself from then on. → changed (null: not
 * looked). Never throws.
 */
const CATCHUP_KEY = 'bridge_status_catchup:';
const CATCHUP_EVERY_MS = 3600 * 1000;
const catchUpAt = new Map(); // person → when last looked (this process)
async function catchUpStatus(ctx) {
  const gc = ctx.gc;
  const b = gc && gc.bridges;
  const u = ctx.viewer;
  if (!b || Number(b.version) < 12 || typeof b.chats !== 'function' || u == null) return null;
  const now = ctx.now || Date.now();
  if (now - (catchUpAt.get(u) || 0) < CATCHUP_EVERY_MS) return null;
  if (catchUpAt.size > 2000) catchUpAt.clear();
  catchUpAt.set(u, now);
  try {
    if (await store.one(gc, 'SELECT 1 AS x FROM settings WHERE key = ?', [CATCHUP_KEY + u])) return null;
    if (!await store.one(gc, "SELECT 1 AS x FROM bridge_links WHERE user_id = ? AND network = 'whatsapp' LIMIT 1", [u])) return null;
    if (!await store.one(gc, "SELECT 1 AS x FROM conversations WHERE bridge_owner = ? AND bridge_net = 'whatsapp' AND bridge_status = 0 LIMIT 1", [u])) return null;
    let list;
    try { list = await b.chats(u, 'whatsapp'); } catch { return null; }
    if (!Array.isArray(list) || !list.length) return null;
    let changed = 0;
    const box = live.outbox();
    for (const ch of list) {
      if (!ch || ch.status !== true || !REF_RE.test(String(ch.id || ''))) continue;
      const conv = await convOf(gc, u, 'whatsapp', ch.id);
      if (!conv || conv.bridge_status) continue;
      await toStatusRoom({ gc, now, box }, conv);
      changed++;
    }
    await store.run(gc, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [CATCHUP_KEY + u, JSON.stringify({ at: now, changed })]);
    await live.flush(gc, box);
    if (changed) await log.add(gc, 'bridge_status_caught_up', `rooms ${changed}`, now);
    return changed;
  } catch (e) { gc.log.warn('bridge status not caught up', (e && (e.code || e.message)) || 'error'); return null; }
}

module.exports = {
  api, isBridged, via, convInfo, marks, marksFor, decorate, apply, applyEphemeral, pump, sweep, push, gate, writable, checkBody, sendOut, resend, editOut, deleteOut, reactOut, readOut, typingOut,
  refreshLinks, stateFor, hasChats, openChat, mapped, fixNames, catchUpStatus, toStatusRoom, titleFor, titleLabel, NETWORKS, LABEL, SUPPORTS, PLACEHOLDERS, LARGE_GROUP,
  _reset: () => { linkChecked.clear(); pumping = Promise.resolve(); namesFixed = false; catchUpAt.clear(); },
};
