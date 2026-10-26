'use strict';

// Conversations: direct chats (one per pair of accounts) and groups
// (creator = admin; admins add/remove members and change roles, every member
// changes title, picture and disappearing messages, leaves). Groups kept by
// another plugin (`managed_by`, services sync_group / send_message) cannot be
// changed here except mute, notifications and disappearing messages; a
// plugin's notice channel (`readonly`) takes no messages from its members.
// 1.6.0: `listPinned` (Familie's group, shown under "Angeheftet") and `notice` { source, label } (the notice
// channels of the chat sink, server/notices.js) in the conversation view.
//
// A non-member never learns that a conversation exists: every route answers
// 404 not_found for a conversation the viewer is not an active member of.

const store = require('./store');
const seal = require('./seal');
const live = require('./live');
const people = require('./people');
const messages = require('./messages');
const config = require('./config');
const social = require('./social');
const { fail, posInt, text, userIds, iso, parseIso } = require('./util');

const GROUP_MAX = 256;
const TITLE_MAX = 80;

async function getConv(gc, id) {
  return store.one(gc, 'SELECT * FROM conversations WHERE id = ?', [id]);
}

/** Active member rows of a conversation. */
async function membersOf(gc, convId) {
  return store.all(gc, 'SELECT * FROM members WHERE conv_id = ? AND left_at IS NULL ORDER BY joined_at, user_id', [convId]);
}

/** The conversation and the viewer's member row, or not_found. */
async function access(ctx, idRaw) {
  const id = posInt(idRaw);
  if (!id) throw fail('not_found');
  const conv = await getConv(ctx.gc, id);
  if (!conv) throw fail('not_found');
  const me = await store.one(ctx.gc, 'SELECT * FROM members WHERE conv_id = ? AND user_id = ? AND left_at IS NULL', [id, ctx.viewer]);
  if (!me) throw fail('not_found');
  return { conv, me, members: await membersOf(ctx.gc, id) };
}

/** May `userId` read conversation `convId`? (media access, services) */
async function isMember(gc, convId, userId) {
  return !!(await store.one(gc, 'SELECT 1 AS x FROM members WHERE conv_id = ? AND user_id = ? AND left_at IS NULL', [convId, userId]));
}

function titleOf(conv) {
  const t = seal.open(conv.title_enc);
  return typeof t === 'string' ? t : null;
}

const FAMILIE = 'gatecontrol-familie';

/** 1.6.0: { source, label } of a notice channel (deliverNotice, server/notices.js), else null. */
function noticeOf(conv) {
  const source = require('./notices').sourceOfKey(conv);
  return source ? { source, label: titleOf(conv) } : null;
}

const mutedNow = (m, now) => m.notify === 'none' || (m.muted_until != null && m.muted_until > now);

/**
 * Receipts as the viewer may see them: deliveredUpTo (the lowest delivered mark of the other members
 * with an account), readUpTo and receipts[] only when the viewer shares read receipts — then over the
 * other members who share them too (null / [] when nobody does).
 */
async function receipts(ctx, conv, members) {
  const prefs = await people.prefsOf(ctx.gc, members.map((m) => m.user_id));
  return messages.receiptsAs(ctx.viewer, members, prefs, ctx.users);
}

/** The conversation as the viewer sees it. */
async function view(ctx, conv, me, members) {
  const isGroup = conv.kind === 'group';
  const peerRow = isGroup ? null : members.find((m) => m.user_id !== ctx.viewer) || null;
  const peerId = peerRow ? peerRow.user_id : null;
  const peer = peerId ? people.face(peerId, ctx.users) : null;
  const rc = await receipts(ctx, conv, members);
  const last = await messages.lastVisible(ctx.gc, me);
  const prefs = await people.prefsOf(ctx.gc, [ctx.viewer]);
  const viewerTyping = (prefs.get(ctx.viewer) || {}).typing !== false;
  const isAdmin = me.role === 'admin';
  const managed = conv.managed_by || null;
  // 1.4.0: last seen / online, blocks, pinned messages, the next event
  const soc = await social.load(ctx);
  const withPresence = (f) => { const p = social.presence(soc, ctx.viewer, f.userId, ctx.now); return { ...f, online: p.online, lastSeenAt: p.lastSeenAt }; };
  const iBlocked = !!(peerId && soc.hasBlocked(ctx.viewer, peerId));
  let avatarUrl = null;
  if (isGroup && conv.avatar_media_id && ctx.portal) {
    try { avatarUrl = await ctx.gc.media.url(conv.avatar_media_id, { user: ctx.viewer, ttlS: messages.URL_TTL_S }); } catch { avatarUrl = null; }
  } else if (peer) avatarUrl = peer.avatarUrl;
  return {
    id: conv.id,
    kind: conv.kind,
    title: isGroup ? titleOf(conv) : (peer && peer.name),
    peer: peer ? { ...withPresence(peer), blocked: iBlocked } : null,
    avatarUrl,
    avatarMediaId: isGroup ? conv.avatar_media_id || null : null,
    managedBy: managed,
    readonly: !!conv.readonly,
    // 1.6.0: Familie's group is pinned in the list (under "GateControl"); a notice channel of the chat sink names its source
    listPinned: managed === FAMILIE && conv.managed_key === 'family',
    notice: noticeOf(conv),
    // 1.9.0: the chat of a GateControl group (server/groupchats.js) → that group's id, else null
    coreGroupId: managed === 'gatecontrol-messenger' && /^group:\d{1,15}$/.test(conv.managed_key || '') ? Number(conv.managed_key.slice(6)) : null,
    disappearingS: conv.disappearing_s,
    createdBy: conv.created_by,
    createdAt: iso(conv.created_at),
    updatedAt: iso(Math.max(conv.updated_at, me.updated_at || 0)),
    lastMessageId: conv.last_msg_id || null,
    members: members.map((m) => ({ ...withPresence(people.face(m.user_id, ctx.users)), role: m.role, joinedAt: iso(m.joined_at) })),
    me: { role: me.role, mutedUntil: iso(me.muted_until), notify: me.notify, lastReadId: me.last_read_id, lastDeliveredId: me.last_delivered_id },
    muted: mutedNow(me, ctx.now),
    unread: await messages.unreadCount(ctx.gc, me),
    lastMessage: last ? (await messages.views(ctx, me, [last], rc))[0] : null,
    typing: viewerTyping ? live.typingIn(conv.id, ctx.now).filter((u) => u !== ctx.viewer && members.some((m) => m.user_id === u)) : [],
    readUpTo: rc.readUpTo,
    deliveredUpTo: rc.deliveredUpTo,
    receipts: rc.receipts,
    archived: !!me.archived,
    pinned: await require('./tools').pinnedFor(ctx, conv, me),
    nextEvent: await require('./eventmsg').nextEvent(ctx, me),
    can: {
      send: !conv.readonly && (isGroup || !!(peer && !peer.gone && !iBlocked)),
      pin: !conv.readonly && (!managed || isAdmin),
      editInfo: isGroup && !managed && !conv.readonly,
      manageMembers: isGroup && !managed && !conv.readonly && isAdmin,
      leave: isGroup && !managed,
      setDisappearing: !conv.readonly && (ctx.cfg.allowDisappearing || conv.disappearing_s > 0),
    },
  };
}

/** GET conversations?since=<ISO> → { conversations, removed, serverTime } */
async function list(ctx, query) {
  const q = query || {};
  const since = q.since == null || q.since === '' ? null : parseIso(String(q.since));
  if (q.since != null && q.since !== '' && since == null) throw fail('invalid');
  const mine = await store.all(ctx.gc, 'SELECT * FROM members WHERE user_id = ? AND left_at IS NULL', [ctx.viewer]);
  const out = [];
  for (const me of mine) {
    const conv = await getConv(ctx.gc, me.conv_id);
    if (!conv) continue;
    // a direct chat without a message is shown to the person who opened it only
    if (conv.kind === 'direct' && !conv.last_msg_id && conv.created_by !== ctx.viewer) continue;
    if (since != null && conv.updated_at <= since && (me.updated_at || 0) <= since && me.joined_at <= since) continue;
    const members = await membersOf(ctx.gc, conv.id);
    out.push({ conv, me, members });
  }
  const views = [];
  for (const x of out) views.push(await view(ctx, x.conv, x.me, x.members));
  views.sort((a, b) => {
    const ta = a.lastMessage ? a.lastMessage.createdAt : a.createdAt;
    const tb = b.lastMessage ? b.lastMessage.createdAt : b.createdAt;
    return ta < tb ? 1 : ta > tb ? -1 : b.id - a.id;
  });
  const removed = since == null ? [] : (await store.all(ctx.gc, 'SELECT conv_id FROM members WHERE user_id = ? AND left_at IS NOT NULL AND left_at > ?', [ctx.viewer, since])).map((r) => r.conv_id);
  // the apps got the newest message of each conversation: delivered
  for (const x of out) if (x.conv.last_msg_id) await messages.markDelivered(ctx, x.conv, x.me, x.members, x.conv.last_msg_id);
  return { conversations: views, removed, serverTime: iso(ctx.now) };
}

/** Enabled accounts among `ids` (others → invalid). */
function checkUsers(ctx, ids) {
  for (const id of ids) if (!ctx.users.has(id)) throw fail('invalid');
  return ids;
}

async function addMember(gc, conv, userId, role, now) {
  const old = await store.one(gc, 'SELECT * FROM members WHERE conv_id = ? AND user_id = ?', [conv.id, userId]);
  const at = conv.last_msg_id || 0;
  if (old) {
    await store.run(gc, 'UPDATE members SET left_at = NULL, role = ?, joined_at = ?, joined_msg_id = ?, last_read_id = ?, last_delivered_id = ?, muted_until = NULL, notify = ?, updated_at = ? WHERE conv_id = ? AND user_id = ?',
      [role, now, at, at, at, 'all', now, conv.id, userId]);
  } else {
    await store.run(gc, 'INSERT INTO members (conv_id, user_id, role, joined_at, joined_msg_id, last_read_id, last_delivered_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [conv.id, userId, role, now, at, at, at, now]);
  }
}

async function dropMember(gc, convId, userId, now) {
  await store.run(gc, 'UPDATE members SET left_at = ?, updated_at = ? WHERE conv_id = ? AND user_id = ? AND left_at IS NULL', [now, now, convId, userId]);
  live.setActive(userId, convId, false);
  live.clearTyping(convId, userId, now);
}

/** A group (not managed) without an admin: the member who joined first becomes one. */
async function ensureAdmin(gc, conv) {
  if (conv.kind !== 'group' || conv.managed_by) return;
  const ms = await membersOf(gc, conv.id);
  if (!ms.length || ms.some((m) => m.role === 'admin')) return;
  await store.run(gc, "UPDATE members SET role = 'admin' WHERE conv_id = ? AND user_id = ?", [conv.id, ms[0].user_id]);
}

/** A new group picture: an image the viewer uploaded → bound to the conversation; the old one orphaned. */
async function setAvatar(ctx, conv, mediaId) {
  if (conv.avatar_media_id) await store.run(ctx.gc, 'UPDATE media SET orphan = 1 WHERE media_id = ?', [conv.avatar_media_id]);
  let id = null;
  if (mediaId != null) {
    const info = await messages.checkMedia(ctx, mediaId, 'image');
    await messages.bindMedia(ctx, info, { convId: conv.id, msgId: null, role: 'avatar', kind: 'avatar' });
    id = info.mediaId;
  }
  await store.run(ctx.gc, 'UPDATE conversations SET avatar_media_id = ?, updated_at = ? WHERE id = ?', [id, ctx.now, conv.id]);
  conv.avatar_media_id = id;
}

/** POST conversations { kind, userIds, title?, avatarMediaId? } → { conversation, created } */
async function create(ctx, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) throw fail('invalid');
  let others = userIds(b.userIds, GROUP_MAX - 1).filter((id) => id !== ctx.viewer);
  checkUsers(ctx, others);
  // 1.4.0: the creator's default for disappearing messages (when the administrator allows them)
  const myPrefs = (await people.prefsOf(ctx.gc, [ctx.viewer])).get(ctx.viewer);
  const dis = ctx.cfg.allowDisappearing ? myPrefs.privacy.defaultDisappearingS : 0;
  if (b.kind === 'direct') {
    if (others.length !== 1 || b.title != null || b.avatarMediaId != null) throw fail('invalid');
    const peer = others[0];
    const key = `${Math.min(ctx.viewer, peer)}:${Math.max(ctx.viewer, peer)}`;
    const old = await store.one(ctx.gc, 'SELECT * FROM conversations WHERE direct_key = ?', [key]);
    if (old) return { conv: old, created: false };
    const r = await store.run(ctx.gc, "INSERT INTO conversations (kind, direct_key, created_by, created_at, updated_at, disappearing_s) VALUES ('direct', ?, ?, ?, ?, ?)", [key, ctx.viewer, ctx.now, ctx.now, dis]);
    const conv = await getConv(ctx.gc, r.lastInsertRowid);
    await addMember(ctx.gc, conv, ctx.viewer, 'member', ctx.now);
    await addMember(ctx.gc, conv, peer, 'member', ctx.now);
    return { conv, created: true };
  }
  if (b.kind !== 'group' || !others.length) throw fail('invalid');
  const title = text(b.title, TITLE_MAX);
  // 1.4.0: people whose privacy.groupAdd excludes the creator are left out (listed in `skipped`)
  const soc = await social.load(ctx);
  const skipped = others.filter((id) => !social.mayAdd(soc, ctx.viewer, id));
  others = others.filter((id) => !skipped.includes(id));
  if (!others.length) throw fail('not_allowed');
  ctx.skipped = skipped;
  const r = await store.run(ctx.gc, "INSERT INTO conversations (kind, title_enc, created_by, created_at, updated_at, disappearing_s) VALUES ('group', ?, ?, ?, ?, ?)", [seal.seal(title), ctx.viewer, ctx.now, ctx.now, dis]);
  const conv = await getConv(ctx.gc, r.lastInsertRowid);
  await addMember(ctx.gc, conv, ctx.viewer, 'admin', ctx.now);
  for (const id of others) await addMember(ctx.gc, conv, id, 'member', ctx.now);
  if (b.avatarMediaId != null) await setAvatar(ctx, conv, b.avatarMediaId);
  await messages.system(ctx, conv, 'created', { by: ctx.viewer, title });
  const members = await membersOf(ctx.gc, conv.id);
  live.queue(ctx.box, members.map((m) => m.user_id), 'conversation.update', { conversationId: conv.id, reason: 'created' });
  return { conv: await getConv(ctx.gc, conv.id), created: true };
}

/**
 * PATCH conversations/:id { title?, avatarMediaId?, disappearingS?, mutedUntil?, notify?, add?, remove?, role? }
 * → the conversation row after the change.
 */
async function patch(ctx, conv, me, members, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) throw fail('invalid');
  const isGroup = conv.kind === 'group';
  const isAdmin = me.role === 'admin';
  const reasons = new Set();
  const removedUsers = [];
  const lastBefore = conv.last_msg_id || 0;
  // ── settings of the viewer only ──
  if (b.mutedUntil !== undefined || b.notify !== undefined) {
    let mutedUntil = me.muted_until;
    if (b.mutedUntil !== undefined) {
      if (b.mutedUntil === null) mutedUntil = null;
      else { mutedUntil = parseIso(b.mutedUntil); if (mutedUntil == null) throw fail('invalid'); if (mutedUntil <= ctx.now) mutedUntil = null; }
    }
    let notify = me.notify;
    if (b.notify !== undefined) { if (b.notify !== 'all' && b.notify !== 'none') throw fail('invalid'); notify = b.notify; }
    await store.run(ctx.gc, 'UPDATE members SET muted_until = ?, notify = ?, updated_at = ? WHERE conv_id = ? AND user_id = ?', [mutedUntil, notify, ctx.now, conv.id, ctx.viewer]);
    live.queue(ctx.box, [ctx.viewer], 'conversation.update', { conversationId: conv.id, reason: 'settings' });
  }
  const shared = ['title', 'avatarMediaId', 'disappearingS', 'add', 'remove', 'role'].filter((k) => b[k] !== undefined);
  if (!shared.length) return getConv(ctx.gc, conv.id);
  if (conv.readonly) throw fail('readonly');
  // ── disappearing messages (every member, direct chats too) ──
  if (b.disappearingS !== undefined) {
    const s = b.disappearingS;
    if (!config.DISAPPEARING_S.includes(s)) throw fail('invalid');
    if (s > 0 && !ctx.cfg.allowDisappearing) throw fail('disappearing_off');
    if (s !== conv.disappearing_s) {
      await store.run(ctx.gc, 'UPDATE conversations SET disappearing_s = ?, updated_at = ? WHERE id = ?', [s, ctx.now, conv.id]);
      conv.disappearing_s = s;
      await messages.system(ctx, conv, 'disappearing', { by: ctx.viewer, seconds: s });
      reasons.add('disappearing');
    }
  }
  const info = ['title', 'avatarMediaId', 'add', 'remove', 'role'].filter((k) => b[k] !== undefined);
  if (info.length) {
    if (!isGroup) throw fail('invalid');
    if (conv.managed_by) throw fail('managed');
  }
  if (b.title !== undefined) {
    const title = text(b.title, TITLE_MAX);
    if (title !== titleOf(conv)) {
      await store.run(ctx.gc, 'UPDATE conversations SET title_enc = ?, updated_at = ? WHERE id = ?', [seal.seal(title), ctx.now, conv.id]);
      conv.title_enc = seal.seal(title);
      await messages.system(ctx, conv, 'title', { by: ctx.viewer, title });
      reasons.add('title');
    }
  }
  if (b.avatarMediaId !== undefined) {
    await setAvatar(ctx, conv, b.avatarMediaId);
    await messages.system(ctx, conv, 'avatar', { by: ctx.viewer });
    reasons.add('avatar');
  }
  if (b.add !== undefined) {
    if (!isAdmin) throw fail('not_admin');
    let ids = checkUsers(ctx, userIds(b.add, GROUP_MAX)).filter((id) => !members.some((m) => m.user_id === id));
    const soc = await social.load(ctx);
    ctx.skipped = ids.filter((id) => !social.mayAdd(soc, ctx.viewer, id));
    ids = ids.filter((id) => !ctx.skipped.includes(id));
    if (members.length + ids.length > GROUP_MAX) throw fail('too_many');
    for (const id of ids) await addMember(ctx.gc, conv, id, 'member', ctx.now);
    if (ids.length) {
      await messages.system(ctx, conv, 'member_added', { by: ctx.viewer, userIds: ids });
      reasons.add('members');
    }
  }
  if (b.remove !== undefined) {
    const ids = userIds(b.remove, GROUP_MAX).filter((id) => members.some((m) => m.user_id === id));
    const others = ids.filter((id) => id !== ctx.viewer);
    if (others.length && !isAdmin) throw fail('not_admin');
    for (const id of others) { await dropMember(ctx.gc, conv.id, id, ctx.now); removedUsers.push(id); }
    if (others.length) await messages.system(ctx, conv, 'member_removed', { by: ctx.viewer, userIds: others });
    if (ids.includes(ctx.viewer)) {
      await dropMember(ctx.gc, conv.id, ctx.viewer, ctx.now);
      removedUsers.push(ctx.viewer);
      await messages.system(ctx, conv, 'member_left', { userId: ctx.viewer });
    }
    if (removedUsers.length) reasons.add('members');
  }
  if (b.role !== undefined) {
    if (!isAdmin) throw fail('not_admin');
    const r = b.role;
    const uid = r && typeof r === 'object' ? posInt(r.userId) : null;
    if (!uid || (r.role !== 'admin' && r.role !== 'member')) throw fail('invalid');
    const cur = await membersOf(ctx.gc, conv.id);
    if (!cur.some((m) => m.user_id === uid)) throw fail('invalid');
    if (r.role === 'member' && !cur.some((m) => m.role === 'admin' && m.user_id !== uid)) throw fail('invalid');
    await store.run(ctx.gc, 'UPDATE members SET role = ?, updated_at = ? WHERE conv_id = ? AND user_id = ?', [r.role, ctx.now, conv.id, uid]);
    reasons.add('members');
  }
  await ensureAdmin(ctx.gc, conv);
  await store.run(ctx.gc, 'UPDATE conversations SET updated_at = ? WHERE id = ?', [ctx.now, conv.id]);
  const now = await membersOf(ctx.gc, conv.id);
  if (reasons.size) {
    const ids = now.map((m) => m.user_id);
    live.queue(ctx.box, ids, 'conversation.update', { conversationId: conv.id, reason: [...reasons].join(',') });
    // the members see the system message(s) as new messages
    if ((conv.last_msg_id || 0) > lastBefore) live.queue(ctx.box, ids, 'message.new', { conversationId: conv.id, messageId: conv.last_msg_id, senderId: null, clientId: null, kind: 'system', createdAt: iso(ctx.now) });
  }
  live.queue(ctx.box, removedUsers, 'conversation.remove', { conversationId: conv.id });
  return getConv(ctx.gc, conv.id);
}

/** POST conversations/:id/typing { stop? } → { until } (null: not shown, e.g. the viewer switched "typing" off) */
async function typing(ctx, conv, me, members, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const prefs = await people.prefsOf(ctx.gc, members.map((m) => m.user_id));
  const others = members.map((m) => m.user_id).filter((u) => u !== ctx.viewer && (prefs.get(u) || {}).typing);
  if (b.stop === true) {
    if (live.clearTyping(conv.id, ctx.viewer, ctx.now)) live.queue(ctx.box, others, 'typing', { conversationId: conv.id, userId: ctx.viewer, until: null });
    return { until: null };
  }
  if (conv.readonly || !(prefs.get(ctx.viewer) || {}).typing) return { until: null };
  const t = live.setTyping(conv.id, ctx.viewer, ctx.now);
  if (t.emit) live.queue(ctx.box, others, 'typing', { conversationId: conv.id, userId: ctx.viewer, until: iso(t.until) });
  return { until: iso(t.until) };
}

/** POST conversations/:id/active { active? } → { until } — the conversation is open on one of the viewer's devices. */
function active(ctx, conv, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (b.active !== undefined && typeof b.active !== 'boolean') throw fail('invalid');
  return { until: iso(live.setActive(ctx.viewer, conv.id, b.active !== false, ctx.now)) };
}

module.exports = {
  getConv, membersOf, access, isMember, titleOf, noticeOf, view, list, create, patch, typing, active, receipts, addMember, dropMember, mutedNow, checkUsers, GROUP_MAX, TITLE_MAX,
};
