'use strict';

// Services for other plugins (plugin.json services.provides, GateControl ≥ 1.177.0
// gc.services.call → hook service({ name, caller, user, payload })):
//
//   send_message { conversation, text, title? }
//     conversation 'family'       — the caller's managed group with the key 'family' (sync_group)
//                  'group:<id>'   — a group the caller manages, or one the calling `user` is a member of
//                  'user:<id>'    — the caller's notice channel for that person (created on first use:
//                                   a group with only that person, read-only for them; `title` names it,
//                                   default "GateControl")
//     The message is a system message from "GateControl" (senderId null, via = caller) with the text,
//     pushed to the members like any message.
//     → { ok: true, conversationId, messageId }
//
//   sync_group { key, title, userIds }
//     creates or updates the caller's managed group `key` ([a-z0-9_-]{1,32}): title and exactly these
//     members (enabled accounts; others are ignored and listed). Members cannot change the members,
//     the title or the picture of a managed group in the messenger, nor leave it.
//     → { ok: true, conversationId, created, added, removed, ignored }
//
// Refusals answer { ok: false, code } (invalid | not_found | forbidden) and are logged
// (Protokoll: service_refused, with the code — never the text).

const store = require('./store');
const seal = require('./seal');
const live = require('./live');
const log = require('./log');
const conversations = require('./conversations');
const messages = require('./messages');
const { fail, isKnown, posInt, text, optText, iso } = require('./util');

const KEY_RE = /^[a-z0-9_-]{1,32}$/;

async function managed(gc, caller, key) {
  return store.one(gc, 'SELECT * FROM conversations WHERE managed_by = ? AND managed_key = ?', [caller, key]);
}

/** Resolve the target of send_message → conversation row (created for a notice channel). */
async function target(ctx, caller, user, payload) {
  const c = typeof payload.conversation === 'string' ? payload.conversation : '';
  if (c === 'family') {
    const conv = await managed(ctx.gc, caller, 'family');
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

/** send_message → { conversationId, messageId } plus the push job for after the commit. */
async function sendMessage(ctx, caller, user, payload) {
  const body = typeof payload.text === 'string' ? payload.text.replace(/\r\n?/g, '\n').replace(/[\0-\x08\x0b-\x1f\x7f]/g, '').trim() : '';
  if (!body || body.length > messages.TEXT_MAX) throw fail('invalid');
  const conv = await target(ctx, caller, user, payload);
  const id = await messages.system(ctx, conv, 'notice', null, { text: body, via: caller });
  const members = await conversations.membersOf(ctx.gc, conv.id);
  const row = await store.one(ctx.gc, 'SELECT * FROM messages WHERE id = ?', [id]);
  messages.queueNew(ctx, conv, members, row);
  ctx.box.pushes.push({ conv, members, row, text: body, meta: null, title: conversations.titleOf(conv) });
  return { conversationId: conv.id, messageId: id };
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
    if (name === 'send_message') out = await store.tx(ctx.gc, () => sendMessage(ctx, who, user && Number.isSafeInteger(user.id) ? user : null, p));
    else if (name === 'sync_group') out = await store.tx(ctx.gc, () => syncGroup(ctx, who, p));
    else throw new Error('unknown service');
    await flush();
    return { ok: true, ...out };
  } catch (e) {
    if (!isKnown(e)) throw e;
    await log.add(ctx.gc, 'service_refused', `${name}: ${e.code}`, ctx.now);
    return { ok: false, code: e.code };
  }
}

module.exports = { handle, sendMessage, syncGroup, KEY_RE };
