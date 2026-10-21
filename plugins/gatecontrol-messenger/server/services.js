'use strict';

// Services for other plugins (plugin.json services.provides, GateControl ≥ 1.177.0
// gc.services.call → hook service({ name, caller, user, payload })):
//
//   send_message { conversation, text, title? }
//     conversation 'family'       — the caller's managed group with the key 'family' (sync_group); 1.4.0: for a
//                                   caller without one, the group "Familie" of gatecontrol-familie
//                  'group:<id>'   — a group the caller manages, or one the calling `user` is a member of
//                  'user:<id>'    — the caller's notice channel for that person (created on first use:
//                                   a group with only that person, read-only for them; `title` names it,
//                                   default "GateControl")
//                  'direct:<id>'  — 1.5.0: the direct chat between the calling `user` and that person (found or
//                                   created; needs `user`, never the user themselves, refused when either blocked
//                                   the other: forbidden). The message is a system message "via <plugin>" in it
//                                   (e.g. Familie's shopping request from the person who asks).
//     The message is a system message from "GateControl" (senderId null, via = caller) with the text,
//     pushed to the members like any message.
//     → { ok: true, conversationId, messageId }
//     1.1.0: `conversation` may be an array of 1…20 such targets (duplicates dropped) — one call, one
//     message per target, each in its own transaction (one refused target does not stop the others):
//     → { ok: true, sent, failed, results: [ { conversation, ok: true, conversationId, messageId }
//                                           | { conversation, ok: false, code } ] } (in the given order)
//
//   sync_group { key, title, userIds }
//     creates or updates the caller's managed group `key` ([a-z0-9_-]{1,32}): title and exactly these
//     members (enabled accounts; others are ignored and listed). Members cannot change the members,
//     the title or the picture of a managed group in the messenger, nor leave it.
//     → { ok: true, conversationId, created, added, removed, ignored }
//
//   release_group { key, delete?, adminIds? }   (1.1.0)
//     hands the caller's managed group `key` back:
//       delete false (default) — it becomes a normal group: members may leave, change the title and the
//                                picture; `adminIds` (members among them) become admins, else the member
//                                who joined first; a system message `released`; the key is free again
//                                (a later sync_group with it creates a new group)
//       delete true            — the group is deleted for everyone: its messages, files and picture are
//                                removed for good, the members get conversation.remove
//     → { ok: true, conversationId, released, deleted, admins }   not_found when the caller has no such group
//
//   1.4.0: send_message { …, card: { kind: 'doorbell' | 'notice', title, text?, imageBase64? (JPEG or WebP,
//     ≤ 300 KB — GateControl takes service payloads up to 512 KB from 1.180.0 on, 16 KB before), actions: ['<id>' (the
//     caller's, e.g. the door's '<lockId>:open') | '<plugin>/<id>'] (≤ 4, ids [A-Za-z0-9:._-]{1,64}),
//     link?: { label, route } } } → a message kind 'card' (senderId null, via the caller) with buttons that run
//     the action as the person pressing (README "Home actions and plugin cards"); `text` may be left out.
//
//   set_place_status { userId, place: string | null }   (1.4.0, from gatecontrol-familie only)
//     Familie's presence: shown in that person's status when the preset is auto_place → { ok, applied }
//
//   send_file { conversation: 'direct:<uid>' | 'family' | 'group:<id>', user (the sender, required), mediaIds: [≤ 20],
//     names?: [..], text? }   (1.8.0, for GateDrop; the files handed over with gc.media.handOver, GateControl ≥ 1.193.0)
//     → messages FROM `user` (not system messages), pushed like any message that person sends: one per file — kind
//     image (JPEG, PNG, WebP, GIF), voice (audio/*), file (everything else; a video/* file is a file message the apps
//     show as a video) with the name as meta.fileName; the text is the first file's caption (≤ 4000) or comes as text
//     messages before the files (no files, or longer: split at 4000, at most 5 parts). The sender must be a member
//     (direct chat: found or created, a block either way → blocked; 'family': the caller's managed group 'family',
//     else Familie's; group: a member, not read-only → readonly). Each file must be handed over for `user` (owner),
//     unused, at most HANDOVER_MAX_BYTES (2 GB — the messenger's own uploads stay at 25 MB) → else media_invalid,
//     media_in_use, file_too_large. → { ok: true, conversationId, messageIds }
//
// Refusals answer { ok: false, code } (invalid | not_found | forbidden; send_file also blocked, readonly,
// media_invalid, media_in_use, file_too_large) and are logged
// (Protokoll: service_refused, with the code — never the text).

const store = require('./store');
const seal = require('./seal');
const live = require('./live');
const log = require('./log');
const conversations = require('./conversations');
const messages = require('./messages');
const homeactions = require('./homeactions');
const status = require('./status');
const crypto = require('node:crypto');
const { fail, isKnown, posInt, text, optText, iso, multiline } = require('./util');

const KEY_RE = /^[a-z0-9_-]{1,32}$/;
const TARGETS_MAX = 20;
// 1.8.0 send_file: files handed over by another plugin (GateDrop) may be larger than the messenger's own uploads
const HANDOVER_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const FILES_MAX = 20;
const FILE_TEXT_MAX = 20000;
const TEXT_PARTS_MAX = 5;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

async function managed(gc, caller, key) {
  return store.one(gc, 'SELECT * FROM conversations WHERE managed_by = ? AND managed_key = ?', [caller, key]);
}

/** Resolve the target of send_message → conversation row (created for a notice channel). */
async function target(ctx, caller, user, payload) {
  const c = typeof payload.conversation === 'string' ? payload.conversation : '';
  if (c === 'family') {
    // the caller's own group 'family' — 1.4.0: else Familie's group "Familie" (e.g. the door's doorbell cards)
    const conv = (await managed(ctx.gc, caller, 'family')) || (await managed(ctx.gc, 'gatecontrol-familie', 'family'));
    if (!conv) throw fail('not_found');
    return conv;
  }
  let m = /^group:(\d{1,15})$/.exec(c);
  if (m) {
    const conv = await conversations.getConv(ctx.gc, posInt(m[1]));
    if (!conv || conv.kind !== 'group') throw fail('not_found');
    if (conv.managed_by === caller) return conv;
    if (user && !conv.readonly && await conversations.isMember(ctx.gc, conv.id, user.id)) return conv;
    throw fail('forbidden');
  }
  m = /^direct:(\d{1,15})$/.exec(c);
  if (m) return directConv(ctx, user, posInt(m[1]));
  m = /^user:(\d{1,15})$/.exec(c);
  if (m) {
    const uid = posInt(m[1]);
    if (!uid || !ctx.users.has(uid)) throw fail('invalid');
    const key = `user:${uid}`;
    const title = optText(payload.title, conversations.TITLE_MAX) || 'GateControl';
    let conv = await managed(ctx.gc, caller, key);
    if (!conv) {
      const r = await store.run(ctx.gc, "INSERT INTO conversations (kind, title_enc, managed_by, managed_key, readonly, created_at, updated_at) VALUES ('group', ?, ?, ?, 1, ?, ?)",
        [seal.seal(title), caller, key, ctx.now, ctx.now]);
      conv = await conversations.getConv(ctx.gc, r.lastInsertRowid);
      await conversations.addMember(ctx.gc, conv, uid, 'member', ctx.now);
      live.queue(ctx.box, [uid], 'conversation.update', { conversationId: conv.id, reason: 'created' });
    } else {
      if (conversations.titleOf(conv) !== title) {
        await store.run(ctx.gc, 'UPDATE conversations SET title_enc = ? WHERE id = ?', [seal.seal(title), conv.id]);
        conv.title_enc = seal.seal(title);
      }
      if (!await conversations.isMember(ctx.gc, conv.id, uid)) await conversations.addMember(ctx.gc, conv, uid, 'member', ctx.now);
    }
    return conv;
  }
  throw fail('invalid');
}

/** 1.5.0: target 'direct:<uid>' → the direct chat of `user` and uid (found or created, both members). */
async function directConv(ctx, user, uid) {
  if (!user || !ctx.users.has(user.id) || !uid || uid === user.id || !ctx.users.has(uid)) throw fail('invalid');
  if (await store.one(ctx.gc, 'SELECT 1 AS x FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)', [user.id, uid, uid, user.id])) throw fail('forbidden');
  const key = `${Math.min(user.id, uid)}:${Math.max(user.id, uid)}`;
  let conv = await store.one(ctx.gc, 'SELECT * FROM conversations WHERE direct_key = ?', [key]);
  const joined = [];
  if (!conv) {
    const r = await store.run(ctx.gc, "INSERT INTO conversations (kind, direct_key, created_by, created_at, updated_at) VALUES ('direct', ?, ?, ?, ?)", [key, user.id, ctx.now, ctx.now]);
    conv = await conversations.getConv(ctx.gc, r.lastInsertRowid);
  }
  for (const id of [user.id, uid]) {
    const mem = await store.one(ctx.gc, 'SELECT left_at FROM members WHERE conv_id = ? AND user_id = ?', [conv.id, id]);
    if (!mem || mem.left_at != null) { await conversations.addMember(ctx.gc, conv, id, 'member', ctx.now); joined.push(id); }
  }
  if (joined.length) live.queue(ctx.box, joined, 'conversation.update', { conversationId: conv.id, reason: 'created' });
  return conv;
}

/** The text of send_message: \r\n → \n, control characters removed, trimmed, 1…4000 characters. */
function noticeText(payload) {
  const body = typeof payload.text === 'string' ? payload.text.replace(/\r\n?/g, '\n').replace(/[\0-\x08\x0b-\x1f\x7f]/g, '').trim() : '';
  if (!body || body.length > messages.TEXT_MAX) throw fail('invalid');
  return body;
}

/** One message into one target → { conversationId, messageId } plus the push job for after the commit. */
async function sendTo(ctx, caller, user, payload, conversation, body) {
  const conv = await target(ctx, caller, user, { ...payload, conversation });
  if (payload.card != null) return sendCard(ctx, caller, conv, payload.card);
  const id = await messages.system(ctx, conv, 'notice', null, { text: body, via: caller });
  const members = await conversations.membersOf(ctx.gc, conv.id);
  const row = await store.one(ctx.gc, 'SELECT * FROM messages WHERE id = ?', [id]);
  messages.queueNew(ctx, conv, members, row);
  ctx.box.pushes.push({ conv, members, row, text: body, meta: null, title: conversations.titleOf(conv) });
  return { conversationId: conv.id, messageId: id };
}

/** 1.4.0: a plugin card into one conversation → { conversationId, messageId } */
async function sendCard(ctx, caller, conv, cardRaw) {
  const card = homeactions.cleanCard(caller, cardRaw);
  const meta = { card: card.meta };
  const id = await messages.insert(ctx, conv, { senderId: null, kind: 'card', text: card.text, meta, via: caller });
  await homeactions.createCard(ctx, conv, id, card);
  const members = await conversations.membersOf(ctx.gc, conv.id);
  const row = await store.one(ctx.gc, 'SELECT * FROM messages WHERE id = ?', [id]);
  messages.queueNew(ctx, conv, members, row);
  ctx.box.pushes.push({ conv, members, row, text: card.text, meta, title: conversations.titleOf(conv) });
  return { conversationId: conv.id, messageId: id };
}

/** 1.4.0: set_place_status (Familie's presence) → { applied } */
async function setPlaceStatus(ctx, caller, payload) {
  if (caller !== 'gatecontrol-familie') throw fail('forbidden');
  const uid = posInt(payload.userId);
  if (!uid || !ctx.users.has(uid)) throw fail('invalid');
  if (payload.place !== null && typeof payload.place !== 'string') throw fail('invalid');
  const place = payload.place === null ? null : optText(payload.place, 80);
  const r = await status.setPlace(ctx, uid, place);
  return { applied: r.applied };
}

/** send_message with one target (a string) → { conversationId, messageId } */
async function sendMessage(ctx, caller, user, payload) {
  return sendTo(ctx, caller, user, payload, payload.conversation, payload.card != null && payload.text == null ? null : noticeText(payload));
}

/**
 * send_message with several targets (1.1.0, `conversation` an array of 1…20 strings): each target in its
 * own transaction; a refused one is listed with its code (and logged), the others are sent.
 * → { sent, failed, results }
 */
async function sendMany(ctx, caller, user, payload) {
  const list = payload.conversation;
  if (!list.length || list.length > TARGETS_MAX || !list.every((c) => typeof c === 'string' && c.length <= 64)) throw fail('invalid');
  const body = payload.card != null && payload.text == null ? null : noticeText(payload);
  const results = [];
  for (const c of [...new Set(list)]) {
    const ev = ctx.box.events.length;
    const pu = ctx.box.pushes.length;
    try {
      const r = await store.tx(ctx.gc, () => sendTo(ctx, caller, user, payload, c, body));
      results.push({ conversation: c, ok: true, ...r });
    } catch (e) {
      // nothing of a rolled-back target goes out
      ctx.box.events.length = ev;
      ctx.box.pushes.length = pu;
      const code = isKnown(e) ? e.code : 'failed';
      if (!isKnown(e)) ctx.gc.log.warn('send_message target failed', (e && (e.code || e.message)) || 'error');
      await log.add(ctx.gc, 'service_refused', `send_message: ${code}`, ctx.now);
      results.push({ conversation: c, ok: false, code });
    }
  }
  const sent = results.filter((r) => r.ok).length;
  return { sent, failed: results.length - sent, results };
}

/** The message kind of a handed-over file by its type. */
function kindOf(mime) {
  const m = String(mime || '').toLowerCase();
  if (IMAGE_TYPES.includes(m)) return 'image';
  if (/^audio\//.test(m)) return 'voice';
  return 'file';
}

/** 1.8.0: send_file (GateDrop) → { conversationId, messageIds } — messages of `payload.user` (see the head of this file). */
async function sendFile(ctx, caller, callUser, p) {
  const uid = posInt(p.user);
  if (!uid || !ctx.users.has(uid) || (callUser && callUser.id !== uid)) throw fail('invalid');
  const ids = p.mediaIds == null ? [] : p.mediaIds;
  if (!Array.isArray(ids) || ids.length > FILES_MAX || !ids.every((x) => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x)) || new Set(ids).size !== ids.length) throw fail('invalid');
  const names = p.names == null ? [] : p.names;
  if (!Array.isArray(names) || names.length > ids.length || !names.every((n) => n == null || typeof n === 'string')) throw fail('invalid');
  if (p.text != null && typeof p.text !== 'string') throw fail('invalid');
  const body = p.text == null ? null : multiline(p.text) || null;
  if ((body && body.length > FILE_TEXT_MAX) || (!ids.length && !body)) throw fail('invalid');
  // the conversation, the sender a member of it
  const c = typeof p.conversation === 'string' ? p.conversation : '';
  let conv;
  let m = /^direct:(\d{1,15})$/.exec(c);
  if (m) conv = await directConv(ctx, { id: uid }, posInt(m[1]));
  else if (c === 'family') {
    conv = (await managed(ctx.gc, caller, 'family')) || (await managed(ctx.gc, 'gatecontrol-familie', 'family'));
    if (!conv) throw fail('not_found');
  } else if ((m = /^group:(\d{1,15})$/.exec(c))) {
    conv = await conversations.getConv(ctx.gc, posInt(m[1]));
    if (!conv || conv.kind !== 'group') throw fail('not_found');
  } else throw fail('invalid');
  const members = await conversations.membersOf(ctx.gc, conv.id);
  const me = members.find((x) => x.user_id === uid);
  if (!me) throw fail('forbidden');
  if (conv.readonly) throw fail('readonly');
  // every file first: handed over for this person, unused, not too large
  const files = [];
  for (let i = 0; i < ids.length; i++) {
    let info = null;
    try { info = await ctx.gc.media.info(ids[i]); } catch { info = null; }
    if (!info || info.owner !== uid) throw fail('media_invalid');
    if (info.bytes > HANDOVER_MAX_BYTES) throw fail('file_too_large');
    if (await store.one(ctx.gc, 'SELECT 1 AS x FROM media WHERE media_id = ?', [ids[i]])) throw fail('media_in_use');
    const name = typeof names[i] === 'string' ? optText(names[i].slice(0, 200), 200) : null;
    files.push({ id: ids[i], kind: kindOf(info.mime), name: name || info.name || null });
  }
  const parts = [];
  let caption = null;
  if (body && files.length && body.length <= messages.TEXT_MAX) caption = body;
  else if (body) {
    for (let i = 0; i < body.length; i += messages.TEXT_MAX) parts.push(body.slice(i, i + messages.TEXT_MAX));
    if (parts.length > TEXT_PARTS_MAX) throw fail('invalid');
  }
  // the messages as the person's own (messages.send: the same checks as the apps — blocks, read-only, the file's owner)
  const before = ctx.viewer;
  ctx.viewer = uid;
  const messageIds = [];
  try {
    const one = async (b) => {
      const r = await messages.send(ctx, conv, me, members, { clientId: 'gd-' + crypto.randomBytes(12).toString('hex'), ...b });
      messages.queueNew(ctx, conv, members, r.row);
      ctx.box.pushes.push({ conv, members, row: r.row, text: r.text, meta: r.meta, title: conversations.titleOf(conv) });
      messageIds.push(r.row.id);
    };
    for (const t of parts) await one({ kind: 'text', text: t });
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      await one({ kind: f.kind, mediaId: f.id, ...(i === 0 && caption ? { text: caption } : {}), ...(f.name ? { meta: { fileName: f.name } } : {}) });
    }
  } finally { ctx.viewer = before; }
  return { conversationId: conv.id, messageIds };
}

/** sync_group → { conversationId, created, added, removed, ignored } */
async function syncGroup(ctx, caller, payload) {
  const key = typeof payload.key === 'string' && KEY_RE.test(payload.key) ? payload.key : null;
  if (!key || key.startsWith('user:')) throw fail('invalid');
  const title = text(payload.title, conversations.TITLE_MAX);
  if (!Array.isArray(payload.userIds) || payload.userIds.length > conversations.GROUP_MAX) throw fail('invalid');
  const wanted = [];
  const ignored = [];
  for (const x of payload.userIds) {
    const id = posInt(x);
    if (!id) throw fail('invalid');
    if (!ctx.users.has(id)) { if (!ignored.includes(id)) ignored.push(id); continue; }
    if (!wanted.includes(id)) wanted.push(id);
  }
  let conv = await managed(ctx.gc, caller, key);
  let created = false;
  if (!conv) {
    const r = await store.run(ctx.gc, "INSERT INTO conversations (kind, title_enc, managed_by, managed_key, created_at, updated_at) VALUES ('group', ?, ?, ?, ?, ?)",
      [seal.seal(title), caller, key, ctx.now, ctx.now]);
    conv = await conversations.getConv(ctx.gc, r.lastInsertRowid);
    created = true;
  } else if (conversations.titleOf(conv) !== title) {
    await store.run(ctx.gc, 'UPDATE conversations SET title_enc = ?, updated_at = ? WHERE id = ?', [seal.seal(title), ctx.now, conv.id]);
    conv.title_enc = seal.seal(title);
    await messages.system(ctx, conv, 'title', { by: null, title });
  }
  const current = await conversations.membersOf(ctx.gc, conv.id);
  const added = wanted.filter((id) => !current.some((m) => m.user_id === id));
  const removed = current.map((m) => m.user_id).filter((id) => !wanted.includes(id));
  for (const id of added) await conversations.addMember(ctx.gc, conv, id, 'member', ctx.now);
  for (const id of removed) await conversations.dropMember(ctx.gc, conv.id, id, ctx.now);
  // the members see who made the group (they joined before this message)
  if (created) await messages.system(ctx, conv, 'created', { by: null, title });
  if (added.length && !created) await messages.system(ctx, conv, 'member_added', { by: null, userIds: added });
  if (removed.length) await messages.system(ctx, conv, 'member_removed', { by: null, userIds: removed });
  await store.run(ctx.gc, 'UPDATE conversations SET updated_at = ? WHERE id = ?', [ctx.now, conv.id]);
  const now = await conversations.membersOf(ctx.gc, conv.id);
  if (created || added.length || removed.length || conv.last_msg_id) {
    live.queue(ctx.box, now.map((m) => m.user_id), 'conversation.update', { conversationId: conv.id, reason: created ? 'created' : 'members' });
  }
  live.queue(ctx.box, removed, 'conversation.remove', { conversationId: conv.id });
  return { conversationId: conv.id, created, added, removed, ignored, at: iso(ctx.now) };
}

/** release_group (1.1.0) → { conversationId, released, deleted, admins } */
async function releaseGroup(ctx, caller, payload) {
  const key = typeof payload.key === 'string' && KEY_RE.test(payload.key) ? payload.key : null;
  if (!key) throw fail('invalid');
  if (payload.delete != null && typeof payload.delete !== 'boolean') throw fail('invalid');
  let adminIds = [];
  if (payload.adminIds != null) {
    if (!Array.isArray(payload.adminIds) || payload.adminIds.length > conversations.GROUP_MAX) throw fail('invalid');
    adminIds = payload.adminIds.map((x) => posInt(x));
    if (adminIds.some((x) => !x)) throw fail('invalid');
  }
  const conv = await managed(ctx.gc, caller, key);
  if (!conv) throw fail('not_found');
  const members = await conversations.membersOf(ctx.gc, conv.id);
  const ids = members.map((m) => m.user_id);
  if (payload.delete === true) {
    // everything of the group goes: messages (with reactions, "hidden" marks), files and picture
    // (deleted from GateControl's store by the background run); the members are out
    await store.run(ctx.gc, 'UPDATE media SET orphan = 1, msg_id = NULL WHERE conv_id = ?', [conv.id]);
    await store.run(ctx.gc, 'DELETE FROM reactions WHERE msg_id IN (SELECT id FROM messages WHERE conv_id = ?)', [conv.id]);
    await store.run(ctx.gc, 'DELETE FROM hidden WHERE msg_id IN (SELECT id FROM messages WHERE conv_id = ?)', [conv.id]);
    // 1.4.0: polls, events, arrivals, actions, reminders of these messages
    const gone = (await store.all(ctx.gc, 'SELECT id FROM messages WHERE conv_id = ?', [conv.id])).map((r) => r.id);
    await require('./rich').cleanup(ctx, gone);
    await store.run(ctx.gc, 'DELETE FROM messages WHERE conv_id = ?', [conv.id]);
    for (const id of ids) await conversations.dropMember(ctx.gc, conv.id, id, ctx.now);
    // the member rows stay (left): GET conversations?since= lists the chat under `removed`
    await store.run(ctx.gc, 'DELETE FROM conversations WHERE id = ?', [conv.id]);
    live.queue(ctx.box, ids, 'conversation.remove', { conversationId: conv.id });
    return { conversationId: conv.id, released: false, deleted: true, admins: [] };
  }
  await store.run(ctx.gc, 'UPDATE conversations SET managed_by = NULL, managed_key = NULL, updated_at = ? WHERE id = ?', [ctx.now, conv.id]);
  conv.managed_by = null;
  conv.managed_key = null;
  const admins = [...new Set(adminIds)].filter((id) => ids.includes(id));
  for (const id of admins) await store.run(ctx.gc, "UPDATE members SET role = 'admin', updated_at = ? WHERE conv_id = ? AND user_id = ?", [ctx.now, conv.id, id]);
  if (!admins.length && members.length) {
    // a group always keeps an admin: the member who joined first
    await store.run(ctx.gc, "UPDATE members SET role = 'admin', updated_at = ? WHERE conv_id = ? AND user_id = ?", [ctx.now, conv.id, members[0].user_id]);
    admins.push(members[0].user_id);
  }
  const msgId = await messages.system(ctx, conv, 'released', { by: null });
  live.queue(ctx.box, ids, 'conversation.update', { conversationId: conv.id, reason: 'released' });
  live.queue(ctx.box, ids, 'message.new', { conversationId: conv.id, messageId: msgId, senderId: null, clientId: null, kind: 'system', createdAt: iso(ctx.now) });
  return { conversationId: conv.id, released: true, deleted: false, admins };
}

/**
 * The hook: run one service in a transaction, then send events and pushes.
 * `run(ctxFactory)` is provided by index.js (context with users, settings, outbox).
 */
async function handle(ctx, { name, caller, user, payload }, flush) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const who = typeof caller === 'string' ? caller : '';
  try {
    if (!who) throw fail('invalid');
    let out;
    const u = user && Number.isSafeInteger(user.id) ? user : null;
    if (name === 'send_message' && Array.isArray(p.conversation)) out = await sendMany(ctx, who, u, p);
    else if (name === 'send_message') out = await store.tx(ctx.gc, () => sendMessage(ctx, who, u, p));
    else if (name === 'sync_group') out = await store.tx(ctx.gc, () => syncGroup(ctx, who, p));
    else if (name === 'release_group') out = await store.tx(ctx.gc, () => releaseGroup(ctx, who, p));
    else if (name === 'set_place_status') out = await store.tx(ctx.gc, () => setPlaceStatus(ctx, who, p));
    else if (name === 'send_file') out = await store.tx(ctx.gc, () => sendFile(ctx, who, u, p));
    else throw new Error('unknown service');
    await flush();
    return { ok: true, ...out };
  } catch (e) {
    if (!isKnown(e)) throw e;
    await log.add(ctx.gc, 'service_refused', `${name}: ${e.code}`, ctx.now);
    return { ok: false, code: e.code };
  }
}

module.exports = { handle, sendMessage, sendMany, syncGroup, releaseGroup, sendFile, KEY_RE, TARGETS_MAX, HANDOVER_MAX_BYTES };
