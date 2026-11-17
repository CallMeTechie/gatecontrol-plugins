'use strict';

// 1.21.0 — persons (chats v2, part B; feature word chat_people, README "App-API", since 1.21.0). The chat with a
// GateControl account and the WhatsApp chat with the same human (later Signal, Telegram) show as ONE chat with a shared
// history, ordered by time — only in the view of the person who merged them; the other side sees nothing of it.
//
//   ways        a person has two or more ways, each a conversation: the direct chat inside GateControl ('gatecontrol')
//               and bridged direct chats ('whatsapp', …). Groups and channels are never merged. The messages stay in
//               their conversation: „Trennen“ shows a way as its own chat again and loses nothing.
//   list        with ?people=1 (a client that knows persons) GET conversations shows one entry per person — the view of
//               its lead conversation (the GateControl chat, else the first way) with the person's name and picture,
//               the unread messages of all ways and the newest message of any way, plus `person` { id, name, ways,
//               reply, … }; the other ways leave the list (`folded`).
//   reply       a message to the person goes over the way of the newest incoming message (a tie: GateControl; none:
//               GateControl) — never chosen in the composer. A bridged way that cannot send right now (bridge away,
//               logged out) gives way to GateControl. 1.27.0: „Nachrichten senden über“ in the chat info — replyPref
//               'gatecontrol' or a network ('whatsapp' …) holds that way while it can send; while it cannot, the chat
//               inside GateControl takes over (person.reply.fallback); 'auto' (the default) as before. An answer to a
//               message still goes back that message's way.
//   settings    mute, notifications and archive hold for the person: a change on one way is copied to the others.
//   pushes      name the person and the way: „Jenny Backes · über WhatsApp“.
//   suggestions GateControl recognises a bridged chat as an account (gc.bridges.matchAccounts, version 8 — the server
//               compares numbers, this plugin learns the pairing only, never a number): a card above the list, merged
//               only after the person's „Ja“; „Nicht jetzt“ hides it for 7 days, „Nicht mehr vorschlagen“ for good.
//               Names are never compared. (Mail's address book as a hint needs the e-mail address of the account —
//               plugins do not get it, so that hint is not built.)

const store = require('./store');
const seal = require('./seal');
const live = require('./live');
const people = require('./people');
const texts = require('./texts.json');
const { fail, posInt, iso } = require('./util');

const GC_WAY = 'gatecontrol';
const WAYS_MAX = 6;
const MATCH_EVERY_MS = 10 * 60000;
const LATER_MS = 7 * 86400000;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;
const SEARCH_RESULTS = 50;
const LABEL = { gatecontrol: 'GateControl', whatsapp: 'WhatsApp', signal: 'Signal', telegram: 'Telegram' };
// 1.27.0: the choice of „Nachrichten senden über“ (persons.reply_pref; NULL = auto)
const PREF_RE = /^[a-z]{2,20}$/;

// per host (gc): `${viewer}|${net}` → when matchAccounts was last asked
const askedBy = new WeakMap();
function askedOf(gc) {
  if (!askedBy.has(gc)) askedBy.set(gc, new Map());
  return askedBy.get(gc);
}

function t(lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

const wayOf = (conv) => (conv && conv.bridge_net) || GC_WAY;
const labelOf = (way) => LABEL[way] || way;

/** gc.bridges with matchAccounts (version ≥ 8), else null. */
function matchApi(gc) {
  const b = gc && gc.bridges;
  return b && Number(b.version) >= 8 && typeof b.matchAccounts === 'function' ? b : null;
}

/** Does this client know persons? (?people=1 next to ?bridged=1) */
const on = (ctx) => !!(ctx && ctx.people && ctx.bridged);

// ─── reading ───────────────────────────────────────────────────────────────

/** conv id → person id of the viewer's persons. */
async function wayMap(ctx) {
  const rows = await store.all(ctx.gc, 'SELECT conv_id, person_id FROM person_ways WHERE owner_id = ?', [ctx.viewer]);
  return new Map(rows.map((r) => [r.conv_id, r.person_id]));
}

async function personRow(ctx, id) {
  const pid = posInt(id);
  if (!pid) return null;
  return store.one(ctx.gc, 'SELECT * FROM persons WHERE id = ? AND owner_id = ?', [pid, ctx.viewer]);
}

async function needPerson(ctx, id) {
  const p = await personRow(ctx, id);
  if (!p) throw fail('not_found');
  return p;
}

async function personOf(ctx, convId) {
  const r = await store.one(ctx.gc, 'SELECT person_id FROM person_ways WHERE owner_id = ? AND conv_id = ?', [ctx.viewer, convId]);
  return r ? personRow(ctx, r.person_id) : null;
}

/** The ways of a person → [{ conv, me, members }] the viewer still is a member of (oldest way first). */
async function waysOf(ctx, p) {
  const conversations = require('./conversations');
  const out = [];
  for (const w of await store.all(ctx.gc, 'SELECT conv_id FROM person_ways WHERE person_id = ? AND owner_id = ? ORDER BY conv_id', [p.id, ctx.viewer])) {
    const conv = await conversations.getConv(ctx.gc, w.conv_id);
    if (!conv) continue;
    const me = await store.one(ctx.gc, 'SELECT * FROM members WHERE conv_id = ? AND user_id = ? AND left_at IS NULL', [conv.id, ctx.viewer]);
    if (!me) continue;
    out.push({ conv, me, members: await conversations.membersOf(ctx.gc, conv.id) });
  }
  return out;
}

/** The lead of the ways: the chat inside GateControl, else the oldest way. */
function leadOf(ways) {
  return ways.find((w) => !w.conv.bridge_net) || ways[0] || null;
}

/** The account at the other end of a direct chat inside GateControl (null: none). */
function peerOf(ctx, conv, members) {
  if (conv.bridge_net || conv.kind !== 'direct') return null;
  const m = members.find((x) => x.user_id !== ctx.viewer);
  return m ? m.user_id : null;
}

/**
 * May this conversation be a way of a person? → null, or why not: group | channel | not_direct (a notice channel, a
 * managed chat) — a chat with exactly one human only.
 */
function refusal(ctx, conv, members) {
  if (conv.kind !== 'direct') return 'group';
  if (conv.bridge_channel) return 'channel';
  if (conv.bridge_net) return conv.bridge_owner === ctx.viewer ? null : 'not_direct';
  if (conv.readonly || conv.managed_by) return 'not_direct';
  const peer = peerOf(ctx, conv, members);
  return peer && peer !== ctx.viewer ? null : 'not_direct';
}

/** The newest message the person got from the other side (not system) → { at, id } or null. */
async function lastIncoming(gc, me) {
  const r = await store.one(gc, `SELECT m.id, m.created_at FROM messages m WHERE m.conv_id = ? AND m.id > ? AND m.kind != 'system'
    AND ((m.sender_id IS NOT NULL AND m.sender_id != ?) OR (m.sender_id IS NULL AND m.ext_sender IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM hidden h WHERE h.msg_id = m.id AND h.user_id = ?) ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
  [me.conv_id, me.joined_msg_id, me.user_id, me.user_id]);
  return r ? { at: r.created_at, id: r.id } : null;
}

/**
 * The way an answer takes: the way of the newest incoming message (a tie: GateControl), none: GateControl, else the
 * lead. A bridged way that cannot send gives way to GateControl. 1.27.0: the person's replyPref (not 'auto') first —
 * while that way can send it is taken; while it cannot, the chat inside GateControl (→ fallback: true); a replyPref whose
 * way is gone counts as 'auto'. → { view, fallback } of that way, or null.
 */
async function replyWay(ctx, ways, views, pref = null) {
  const byId = new Map(views.map((v) => [v.id, v]));
  const gcWay = ways.find((w) => !w.conv.bridge_net);
  const sends = (w) => { const v = w ? byId.get(w.conv.id) : null; return !!(v && v.can && v.can.send); };
  if (pref && pref !== 'auto') {
    const want = ways.find((w) => wayOf(w.conv) === pref);
    if (want && sends(want)) return { view: byId.get(want.conv.id) || null, fallback: false };
    if (want && gcWay && gcWay !== want) return { view: byId.get(gcWay.conv.id) || null, fallback: true };
  }
  let best = null;
  for (const w of ways) {
    const li = await lastIncoming(ctx.gc, w.me);
    if (!li) continue;
    if (!best || li.at > best.li.at || (li.at === best.li.at && !w.conv.bridge_net && best.w.conv.bridge_net)) best = { w, li };
  }
  let pick = best ? best.w : (gcWay || leadOf(ways));
  if (pick && pick.conv.bridge_net && gcWay && !sends(pick)) pick = gcWay;
  const view = pick ? byId.get(pick.conv.id) || null : null;
  return view ? { view, fallback: false } : null;
}

/** The stored choice of a person → 'auto' | 'gatecontrol' | a network. */
const prefOf = (p) => (p && typeof p.reply_pref === 'string' && PREF_RE.test(p.reply_pref) ? p.reply_pref : 'auto');

/** The name and picture of a person: from the chosen way (the account by default), a missing picture from another way. */
function face(ctx, p, views, lead) {
  const acc = p.user_id != null ? ctx.users.get(p.user_id) : null;
  const src = p.name_from != null ? views.find((v) => v.id === p.name_from) : null;
  let name = null;
  if (src) name = src.title;
  else if (acc) name = acc.name;
  if (!name) name = (lead && lead.title) || (views[0] && views[0].title) || null;
  const pic = (v) => (v ? { avatarUrl: v.avatarUrl || null, avatarMediaId: v.avatarMediaId || null } : { avatarUrl: null, avatarMediaId: null });
  let picture = src ? pic(src) : (acc ? { avatarUrl: acc.avatarUrl || null, avatarMediaId: null } : pic(lead));
  if (!picture.avatarUrl && !picture.avatarMediaId) {
    const other = views.find((v) => v.avatarUrl || v.avatarMediaId);
    if (other) picture = pic(other);
    else if (acc && acc.avatarUrl) picture = { avatarUrl: acc.avatarUrl, avatarMediaId: null };
  }
  return { name, ...picture, nameFrom: src ? src.id : (acc ? 'account' : null) };
}

const newer = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  return a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id) ? a : b;
};

/**
 * The list entry of a person from the views of its ways: the lead's view with the person's name, picture, unread and
 * newest message, and `person`.
 */
async function entry(ctx, p, ways, views) {
  const lw = leadOf(ways);
  const lead = (lw && views.find((v) => v.id === lw.conv.id)) || views[0];
  const f = face(ctx, p, views, lead);
  const replyPref = prefOf(p);
  const rw = await replyWay(ctx, ways, views, replyPref);
  const reply = rw ? rw.view : null;
  const acc = p.user_id != null ? ctx.users.get(p.user_id) : null;
  const names = [];
  for (const n of [f.name, acc && acc.name, ...views.map((v) => v.title)]) if (n && !names.includes(n)) names.push(n);
  let last = null;
  for (const v of views) last = newer(last, v.lastMessage);
  const person = {
    id: p.id,
    name: f.name,
    nameFrom: f.nameFrom,
    userId: p.user_id != null ? p.user_id : null,
    conversationId: lead.id,
    names,
    // GateControl first, then the bridged ways (oldest first)
    ways: [...views].sort((a, b) => (a.bridge ? 1 : 0) - (b.bridge ? 1 : 0) || a.id - b.id).map((v) => ({
      way: v.bridge ? v.bridge.network : GC_WAY, label: v.bridge ? v.bridge.label : labelOf(GC_WAY), conversationId: v.id, title: v.title,
      avatarUrl: v.avatarUrl || null, avatarMediaId: v.avatarMediaId || null, unread: v.unread, muted: v.muted, archived: v.archived,
      lastMessageAt: v.lastMessage ? v.lastMessage.createdAt : null, bridge: v.bridge || null,
      can: { send: !!(v.can && v.can.send), sendReason: (v.can && v.can.sendReason) || null, react: v.can ? v.can.react !== false : true },
    })),
    reply: reply ? { way: reply.bridge ? reply.bridge.network : GC_WAY, label: reply.bridge ? reply.bridge.label : labelOf(GC_WAY), conversationId: reply.id, ...(rw.fallback ? { fallback: true } : {}) } : null,
    // 1.27.0: „Nachrichten senden über“ — 'auto' | 'gatecontrol' | a network (PUT persons/:id { replyPref })
    replyPref,
    createdAt: iso(p.created_at),
  };
  return {
    ...lead,
    title: f.name,
    avatarUrl: f.avatarUrl,
    avatarMediaId: f.avatarMediaId,
    unread: views.reduce((s, v) => s + (v.unread || 0), 0),
    lastMessage: last,
    archived: views.every((v) => v.archived),
    updatedAt: views.reduce((mx, v) => (v.updatedAt > mx ? v.updatedAt : mx), iso(p.updated_at)),
    person,
  };
}

/** The entry of one person, built now (GET persons/:id and the answers of changes). */
async function entryOf(ctx, p) {
  const conversations = require('./conversations');
  const ways = await waysOf(ctx, p);
  if (!ways.length) return null;
  const views = [];
  for (const w of ways) views.push(await conversations.view(ctx, w.conv, w.me, w.members));
  return entry(ctx, p, ways, views);
}

/**
 * GET conversations with ?people=1: the views of the ways of each person → one entry per person. → { list, folded }
 * (`folded`: the ways that left the list).
 */
async function fold(ctx, views, map) {
  if (!map || !map.size) return { list: views, folded: [] };
  const byPerson = new Map();
  for (const v of views) {
    const pid = map.get(v.id);
    if (!pid) continue;
    if (!byPerson.has(pid)) byPerson.set(pid, []);
    byPerson.get(pid).push(v);
  }
  if (!byPerson.size) return { list: views, folded: [] };
  const entries = new Map();
  const folded = [];
  for (const [pid, vs] of byPerson) {
    const p = await store.one(ctx.gc, 'SELECT * FROM persons WHERE id = ? AND owner_id = ?', [pid, ctx.viewer]);
    const ways = p ? await waysOf(ctx, p) : [];
    const have = vs.filter((v) => ways.some((w) => w.conv.id === v.id));
    if (!p || have.length < 1) continue;
    const e = await entry(ctx, p, ways.filter((w) => have.some((v) => v.id === w.conv.id)), have);
    entries.set(e.id, e);
    for (const v of have) if (v.id !== e.id) folded.push(v.id);
  }
  const list = [];
  for (const v of views) {
    if (folded.includes(v.id)) continue;
    list.push(entries.get(v.id) || v);
  }
  return { list, folded };
}

/** `person` on GET conversations/:id of any way (the app opens the person instead). */
async function personFor(ctx, convId) {
  if (!on(ctx)) return null;
  const p = await personOf(ctx, convId);
  if (!p) return null;
  const e = await entryOf(ctx, p);
  return e ? e.person : null;
}

// ─── merging, splitting ─────────────────────────────────────────────────────

/** Copy mute, notifications and archive of one way to the other ways of its person (after a change there). */
async function syncFrom(ctx, convId) {
  const p = await personOf(ctx, convId);
  if (!p) return;
  const src = await store.one(ctx.gc, 'SELECT * FROM members WHERE conv_id = ? AND user_id = ? AND left_at IS NULL', [convId, ctx.viewer]);
  if (!src) return;
  for (const w of await waysOf(ctx, p)) {
    if (w.conv.id === convId) continue;
    if (w.me.notify === src.notify && w.me.muted_until === src.muted_until && (w.me.archived || 0) === (src.archived || 0)) continue;
    await store.run(ctx.gc, 'UPDATE members SET notify = ?, muted_until = ?, archived = ?, updated_at = ? WHERE conv_id = ? AND user_id = ?',
      [src.notify, src.muted_until, src.archived || 0, ctx.now, w.conv.id, ctx.viewer]);
    live.queue(ctx.box, [ctx.viewer], 'conversation.update', { conversationId: w.conv.id, reason: 'settings' });
  }
}

function changed(ctx, convIds, personId) {
  for (const id of convIds) live.queue(ctx.box, [ctx.viewer], 'conversation.update', { conversationId: id, reason: 'person', personId: personId || null });
}

/** One of the viewer's conversations, checked as a way → { conv, members, peer }. */
async function wayCandidate(ctx, idRaw) {
  const conversations = require('./conversations');
  const id = posInt(idRaw);
  if (!id) throw fail('invalid');
  const x = await conversations.access(ctx, id);
  const why = refusal(ctx, x.conv, x.members);
  if (why) throw fail('cannot_merge', { reason: why });
  return { conv: x.conv, members: x.members, peer: peerOf(ctx, x.conv, x.members) };
}

/**
 * POST persons { conversationIds: [id, …], userId?, name?: 'account' | <conversation id> } → { conversation (the
 * person's entry), person } — merges those chats (and the chat with that account, made when there is none yet) into
 * one person; chats that belong to a person already bring it along. At most one account.
 */
async function merge(ctx, body) {
  const conversations = require('./conversations');
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b || !Array.isArray(b.conversationIds) || !b.conversationIds.length || b.conversationIds.length > WAYS_MAX) throw fail('invalid');
  const picked = [];
  for (const raw of b.conversationIds) {
    const c = await wayCandidate(ctx, raw);
    if (!picked.some((x) => x.conv.id === c.conv.id)) picked.push(c);
  }
  let userId = null;
  if (b.userId != null) {
    userId = posInt(b.userId);
    if (!userId || userId === ctx.viewer || !ctx.users.has(userId)) throw fail('invalid');
  }
  for (const c of picked) {
    if (c.peer == null) continue;
    if (userId != null && userId !== c.peer) throw fail('cannot_merge', { reason: 'two_accounts' });
    userId = c.peer;
  }
  // the persons these chats (and that account) belong to already
  const map = await wayMap(ctx);
  const pids = new Set(picked.map((c) => map.get(c.conv.id)).filter(Boolean));
  if (userId != null) {
    const pu = await store.one(ctx.gc, 'SELECT id FROM persons WHERE owner_id = ? AND user_id = ?', [ctx.viewer, userId]);
    if (pu) pids.add(pu.id);
  }
  const existing = [];
  for (const pid of pids) existing.push(await store.one(ctx.gc, 'SELECT * FROM persons WHERE id = ?', [pid]));
  for (const p of existing) {
    if (p.user_id != null && userId != null && p.user_id !== userId) throw fail('cannot_merge', { reason: 'two_accounts' });
    if (p.user_id != null) userId = p.user_id;
  }
  // the chat with the account: the one given, else the one that exists, else a new one (no message yet — the account
  // sees nothing of it until somebody writes)
  if (userId != null && !picked.some((c) => c.peer === userId)) {
    const r = await conversations.create(ctx, { kind: 'direct', userIds: [userId] });
    const members = await conversations.membersOf(ctx.gc, r.conv.id);
    if (!members.some((m) => m.user_id === ctx.viewer)) await conversations.addMember(ctx.gc, r.conv, ctx.viewer, 'member', ctx.now);
    picked.push({ conv: r.conv, members: await conversations.membersOf(ctx.gc, r.conv.id), peer: userId });
  }
  const all = new Set(picked.map((c) => c.conv.id));
  for (const p of existing) for (const w of await store.all(ctx.gc, 'SELECT conv_id FROM person_ways WHERE person_id = ?', [p.id])) all.add(w.conv_id);
  if (all.size < 2) throw fail('cannot_merge', { reason: 'one_way' });
  if (all.size > WAYS_MAX) throw fail('too_many');
  // the name: the account's (default) or a way's
  let nameFrom = existing.length ? existing[0].name_from : null;
  if (b.name !== undefined) {
    if (b.name === 'account' || b.name === null) nameFrom = null;
    else {
      const nid = posInt(b.name);
      if (!nid || !all.has(nid)) throw fail('invalid');
      nameFrom = nid;
    }
  }
  if (nameFrom == null && userId == null) nameFrom = Math.min(...all);
  // one person: the oldest of the existing ones keeps its id, the others are taken in
  existing.sort((x, y) => x.id - y.id);
  let pid;
  if (existing.length) {
    pid = existing[0].id;
    for (const p of existing.slice(1)) {
      await store.run(ctx.gc, 'UPDATE person_ways SET person_id = ? WHERE person_id = ?', [pid, p.id]);
      await store.run(ctx.gc, 'DELETE FROM persons WHERE id = ?', [p.id]);
    }
    await store.run(ctx.gc, 'UPDATE persons SET user_id = ?, name_from = ?, updated_at = ? WHERE id = ?', [userId, nameFrom, ctx.now, pid]);
  } else {
    const r = await store.run(ctx.gc, 'INSERT INTO persons (owner_id, user_id, name_from, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [ctx.viewer, userId, nameFrom, ctx.now, ctx.now]);
    pid = r.lastInsertRowid;
  }
  for (const id of all) {
    await store.run(ctx.gc, `INSERT INTO person_ways (owner_id, conv_id, person_id, added_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id, conv_id) DO UPDATE SET person_id = excluded.person_id`, [ctx.viewer, id, pid, ctx.now]);
  }
  const p = await store.one(ctx.gc, 'SELECT * FROM persons WHERE id = ?', [pid]);
  // mute, notifications, archive: as the lead has them
  const ways = await waysOf(ctx, p);
  const lead = leadOf(ways);
  if (lead) await syncFrom(ctx, lead.conv.id);
  // the suggestions of these pairs are answered
  if (userId != null) for (const id of all) await store.run(ctx.gc, 'DELETE FROM person_hints WHERE owner_id = ? AND conv_id = ? AND user_id = ?', [ctx.viewer, id, userId]);
  changed(ctx, [...all], pid);
  const e = await entryOf(ctx, p);
  return { conversation: e, person: e ? e.person : null };
}

/** PATCH persons/:id { name?, notify?, mutedUntil?, replyPref? } → { conversation, person } */
async function patch(ctx, idRaw, body) {
  const conversations = require('./conversations');
  const p = await needPerson(ctx, idRaw);
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) throw fail('invalid');
  for (const k of Object.keys(b)) if (!['name', 'notify', 'mutedUntil', 'replyPref', 'bridged', 'channels', 'people'].includes(k)) throw fail('invalid');
  const ways = await waysOf(ctx, p);
  // 1.27.0: „Nachrichten senden über“ — automatic, or one of the person's ways (bad_request: the person has no such way)
  if (b.replyPref !== undefined) {
    const v = b.replyPref === null ? 'auto' : b.replyPref;
    if (typeof v !== 'string' || !PREF_RE.test(v)) throw fail('invalid');
    if (v !== 'auto' && !ways.some((w) => wayOf(w.conv) === v)) throw fail('bad_request');
    await store.run(ctx.gc, 'UPDATE persons SET reply_pref = ?, updated_at = ? WHERE id = ?', [v === 'auto' ? null : v, ctx.now, p.id]);
    p.reply_pref = v === 'auto' ? null : v;
    changed(ctx, ways.map((w) => w.conv.id), p.id);
  }
  if (b.name !== undefined) {
    let nameFrom;
    if (b.name === 'account' || b.name === null) {
      if (p.user_id == null) throw fail('invalid');
      nameFrom = null;
    } else {
      const nid = posInt(b.name);
      if (!nid || !ways.some((w) => w.conv.id === nid)) throw fail('invalid');
      nameFrom = nid;
    }
    await store.run(ctx.gc, 'UPDATE persons SET name_from = ?, updated_at = ? WHERE id = ?', [nameFrom, ctx.now, p.id]);
    p.name_from = nameFrom;
    changed(ctx, ways.map((w) => w.conv.id), p.id);
  }
  if (b.notify !== undefined || b.mutedUntil !== undefined) {
    const lead = leadOf(ways);
    if (lead) {
      const x = await conversations.access(ctx, lead.conv.id);
      await conversations.patch(ctx, x.conv, x.me, x.members, { ...(b.notify !== undefined ? { notify: b.notify } : {}), ...(b.mutedUntil !== undefined ? { mutedUntil: b.mutedUntil } : {}) });
      await syncFrom(ctx, lead.conv.id);
    }
  }
  const e = await entryOf(ctx, p);
  return { conversation: e, person: e ? e.person : null };
}

/** POST persons/:id/archive { archived } → { conversation, person } — every way. */
async function archive(ctx, idRaw, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b || typeof b.archived !== 'boolean') throw fail('invalid');
  const p = await needPerson(ctx, idRaw);
  for (const w of await waysOf(ctx, p)) {
    await store.run(ctx.gc, 'UPDATE members SET archived = ?, updated_at = ? WHERE conv_id = ? AND user_id = ?', [b.archived ? 1 : 0, ctx.now, w.conv.id, ctx.viewer]);
    live.queue(ctx.box, [ctx.viewer], 'conversation.update', { conversationId: w.conv.id, reason: 'archive' });
  }
  const e = await entryOf(ctx, p);
  return { conversation: e, person: e ? e.person : null };
}

/** Never suggest these pairs again (after „Trennen“ or „Nicht mehr vorschlagen“). */
async function never(ctx, convId, userId, net) {
  await store.run(ctx.gc, `INSERT INTO person_hints (owner_id, conv_id, user_id, network, strength, via, state, until, seen_at) VALUES (?, ?, ?, ?, 'medium', 'manual', 'never', NULL, ?)
    ON CONFLICT(owner_id, conv_id, user_id) DO UPDATE SET state = 'never', until = NULL`, [ctx.viewer, convId, userId, net, ctx.now]);
}

/**
 * DELETE persons/:id/ways/:conversationId → { person (null: dissolved), conversations: [entries] } — „Trennen“: that way
 * is its own chat again (a person with one way left is dissolved); nothing is lost. DELETE persons/:id dissolves it.
 */
async function split(ctx, idRaw, convRaw) {
  const conversations = require('./conversations');
  const p = await needPerson(ctx, idRaw);
  const ways = await waysOf(ctx, p);
  const rows = await store.all(ctx.gc, 'SELECT conv_id FROM person_ways WHERE person_id = ?', [p.id]);
  let leave;
  if (convRaw === undefined) leave = rows.map((r) => r.conv_id);
  else {
    const cid = posInt(convRaw);
    if (!cid || !rows.some((r) => r.conv_id === cid)) throw fail('not_found');
    leave = [cid];
  }
  const rest = rows.map((r) => r.conv_id).filter((id) => !leave.includes(id));
  if (rest.length < 2) leave = rows.map((r) => r.conv_id);
  // the account and a bridged way that part are not suggested again
  if (p.user_id != null) {
    for (const id of leave) {
      const w = ways.find((x) => x.conv.id === id);
      if (w && w.conv.bridge_net) await never(ctx, id, p.user_id, w.conv.bridge_net);
    }
    if (rest.length < 2) for (const w of ways) if (w.conv.bridge_net) await never(ctx, w.conv.id, p.user_id, w.conv.bridge_net);
  }
  await store.run(ctx.gc, `DELETE FROM person_ways WHERE person_id = ? AND conv_id IN (${store.marks(leave.length)})`, [p.id, ...leave]);
  let person = null;
  if (rest.length < 2) await store.run(ctx.gc, 'DELETE FROM persons WHERE id = ?', [p.id]);
  else {
    if (p.name_from != null && leave.includes(p.name_from)) await store.run(ctx.gc, 'UPDATE persons SET name_from = ? WHERE id = ?', [p.user_id != null ? null : Math.min(...rest), p.id]);
    await store.run(ctx.gc, 'UPDATE persons SET updated_at = ? WHERE id = ?', [ctx.now, p.id]);
  }
  changed(ctx, rows.map((r) => r.conv_id), rest.length < 2 ? null : p.id);
  const out = [];
  if (rest.length >= 2) {
    const e = await entryOf(ctx, await store.one(ctx.gc, 'SELECT * FROM persons WHERE id = ?', [p.id]));
    if (e) { person = e.person; out.push(e); }
  }
  for (const id of leave) {
    try {
      const x = await conversations.access(ctx, id);
      out.push(await conversations.view(ctx, x.conv, x.me, x.members));
    } catch { /* no longer a member */ }
  }
  return { person, conversations: out };
}

// ─── the shared history ─────────────────────────────────────────────────────

/** The ways a request names (?way=gatecontrol | whatsapp …; all without). */
function wayFilter(ways, q) {
  const w = q && q.way != null && q.way !== '' ? String(q.way) : null;
  if (w && !/^[a-z]{2,20}$/.test(w)) throw fail('invalid');
  return w ? ways.filter((x) => wayOf(x.conv) === w) : ways;
}

/** A message of one of the ways, visible to the viewer → its row and way. */
async function cursorOf(ctx, ways, id) {
  const messages = require('./messages');
  const row = await store.one(ctx.gc, 'SELECT conv_id FROM messages WHERE id = ?', [id]);
  const w = row ? ways.find((x) => x.conv.id === row.conv_id) : null;
  if (!w) throw fail('not_found');
  return messages.visibleMessage(ctx, w.me, id);
}

const keyLess = (a, b) => a.created_at < b.created_at || (a.created_at === b.created_at && a.id < b.id);

/** Rows of all ways older (dir 'before') or newer (dir 'after', inclusive with `incl`) than a cursor row. */
async function slice(ctx, ways, cursor, dir, n, incl = false) {
  const messages = require('./messages');
  const rows = [];
  for (const w of ways) {
    const args = messages.visibleArgs(w.me);
    let sql = `SELECT m.* FROM messages m WHERE ${messages.VISIBLE_SQL}`;
    if (cursor && dir === 'before') { sql += ' AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))'; args.push(cursor.created_at, cursor.created_at, cursor.id); }
    if (cursor && dir === 'after') { sql += ` AND (m.created_at > ? OR (m.created_at = ? AND m.id ${incl ? '>=' : '>'} ?))`; args.push(cursor.created_at, cursor.created_at, cursor.id); }
    sql += dir === 'after' ? ' ORDER BY m.created_at ASC, m.id ASC LIMIT ?' : ' ORDER BY m.created_at DESC, m.id DESC LIMIT ?';
    args.push(n + 1);
    rows.push(...(await store.all(ctx.gc, sql, args)));
  }
  rows.sort((a, b) => (keyLess(a, b) ? -1 : keyLess(b, a) ? 1 : 0));
  if (dir === 'after') return { rows: rows.slice(0, n), more: rows.length > n };
  return { rows: rows.slice(Math.max(0, rows.length - n)), more: rows.length > n };
}

/** Message rows of several ways → their views (each with its way's receipts), in the order given. */
async function viewsOf(ctx, ways, rows) {
  const conversations = require('./conversations');
  const messages = require('./messages');
  const byConv = new Map();
  for (const r of rows) {
    if (!byConv.has(r.conv_id)) byConv.set(r.conv_id, []);
    byConv.get(r.conv_id).push(r);
  }
  const out = new Map();
  for (const [cid, list] of byConv) {
    const w = ways.find((x) => x.conv.id === cid);
    const rc = await conversations.receipts(ctx, w.conv, w.members);
    if (w.conv.bridge_net) Object.assign(rc, await require('./bridgechats').marksFor(ctx.gc, w.conv.id, (await people.prefsOf(ctx.gc, [ctx.viewer])).get(ctx.viewer)));
    const vs = await messages.views(ctx, w.me, list, rc);
    for (const v of vs) out.set(v.id, v);
  }
  return rows.map((r) => out.get(r.id)).filter(Boolean);
}

/** The read and delivered marks of each way (the ticks of one's own messages). */
async function marksOf(ctx, ways) {
  const conversations = require('./conversations');
  const out = [];
  for (const w of ways) {
    const rc = await conversations.receipts(ctx, w.conv, w.members);
    if (w.conv.bridge_net) Object.assign(rc, await require('./bridgechats').marksFor(ctx.gc, w.conv.id, (await people.prefsOf(ctx.gc, [ctx.viewer])).get(ctx.viewer)));
    out.push({ conversationId: w.conv.id, way: wayOf(w.conv), lastReadId: w.me.last_read_id, readUpTo: rc.readUpTo, deliveredUpTo: rc.deliveredUpTo });
  }
  return out;
}

/**
 * GET persons/:id/messages?before=|after=|around=|changedSince=&limit=&way= → { messages (ascending by time), hasMore,
 * ways: [{ conversationId, way, lastReadId, readUpTo, deliveredUpTo }] } — the messages of all ways (or of one: ?way=),
 * ordered by time; every message carries its `way`. Cursors are message ids of any way.
 */
async function page(ctx, idRaw, query) {
  const messages = require('./messages');
  const { parseIso } = require('./util');
  const p = await needPerson(ctx, idRaw);
  const all = await waysOf(ctx, p);
  const ways = wayFilter(all, query);
  const q = query || {};
  const limit = q.limit == null || q.limit === '' ? PAGE_DEFAULT : posInt(String(q.limit));
  if (!limit || limit > PAGE_MAX) throw fail('invalid');
  const given = (k) => q[k] != null && q[k] !== '';
  const ids = {};
  for (const k of ['before', 'after', 'around']) {
    if (!given(k)) continue;
    ids[k] = posInt(String(q[k]));
    if (!ids[k]) throw fail('invalid');
  }
  const changed = given('changedSince') ? parseIso(String(q.changedSince)) : null;
  if (given('changedSince') && changed == null) throw fail('invalid');
  if (Object.keys(ids).length + (changed != null ? 1 : 0) > 1) throw fail('invalid');
  let res;
  if (ids.around) {
    const cur = await cursorOf(ctx, all, ids.around);
    const nBefore = Math.floor(limit / 2);
    const older = await slice(ctx, ways, cur, 'before', Math.max(nBefore, 1));
    const newer = await slice(ctx, ways, cur, 'after', limit - nBefore, true);
    const before = nBefore ? older.rows : [];
    res = { rows: [...before, ...newer.rows], hasMore: older.more || newer.more || (!nBefore && older.rows.length > 0), hasMoreBefore: nBefore ? older.more : older.rows.length > 0, hasMoreAfter: newer.more };
  } else if (ids.after) {
    const cur = await cursorOf(ctx, all, ids.after);
    const s = await slice(ctx, ways, cur, 'after', limit);
    res = { rows: s.rows, hasMore: s.more };
  } else if (changed != null) {
    const rows = [];
    for (const w of ways) rows.push(...(await store.all(ctx.gc, `SELECT m.* FROM messages m WHERE ${messages.VISIBLE_SQL} AND m.updated_at > ? ORDER BY m.updated_at ASC, m.id ASC LIMIT ?`, [...messages.visibleArgs(w.me), changed, limit + 1])));
    rows.sort((a, b) => a.updated_at - b.updated_at || a.id - b.id);
    res = { rows: rows.slice(0, limit), hasMore: rows.length > limit };
  } else {
    const cur = ids.before ? await cursorOf(ctx, all, ids.before) : null;
    const s = await slice(ctx, ways, cur, 'before', limit);
    res = { rows: s.rows, hasMore: s.more };
  }
  const list = await viewsOf(ctx, ways, res.rows);
  // the apps got these messages: delivered, per way
  for (const w of ways) {
    const top = res.rows.filter((r) => r.conv_id === w.conv.id).reduce((mx, r) => Math.max(mx, r.id), 0);
    if (top) await messages.markDelivered(ctx, w.conv, w.me, w.members, top);
  }
  const out = { messages: list, hasMore: res.hasMore };
  if (res.hasMoreBefore !== undefined) Object.assign(out, { hasMoreBefore: res.hasMoreBefore, hasMoreAfter: res.hasMoreAfter });
  return { ...out, ways: await marksOf(ctx, all), serverTime: iso(ctx.now) };
}

/**
 * POST persons/:id/read { upTo? } → { unread, ways: [{ conversationId, lastReadId, unread }] } — every way read up to the
 * time of message `upTo` (without: everything). → also `bridged`: the bridged ways whose mark moved (read receipts go out
 * after the transaction).
 */
async function read(ctx, idRaw, body) {
  const messages = require('./messages');
  const p = await needPerson(ctx, idRaw);
  const ways = await waysOf(ctx, p);
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  let cur = null;
  if (b.upTo != null) {
    const id = posInt(b.upTo);
    if (!id) throw fail('invalid');
    cur = await cursorOf(ctx, ways, id);
  }
  const out = [];
  const bridged = [];
  let unread = 0;
  for (const w of ways) {
    let to = w.conv.last_msg_id || 0;
    if (cur) {
      const r = await store.one(ctx.gc, 'SELECT MAX(id) AS id FROM messages WHERE conv_id = ? AND (created_at < ? OR (created_at = ? AND id <= ?))', [w.conv.id, cur.created_at, cur.created_at, cur.id]);
      to = r && r.id ? r.id : 0;
    }
    let res = { lastReadId: w.me.last_read_id, unread: await messages.unreadCount(ctx.gc, w.me) };
    if (to > w.me.last_read_id) {
      res = await messages.markRead(ctx, w.conv, w.me, w.members, { upTo: to });
      if (w.conv.bridge_net) bridged.push({ conv: w.conv, lastReadId: res.lastReadId });
    }
    unread += res.unread;
    out.push({ conversationId: w.conv.id, way: wayOf(w.conv), lastReadId: res.lastReadId, unread: res.unread });
  }
  return { unread, ways: out, bridged };
}

/** GET persons/:id/search?q= → { results (newest first, each with its way), scanned, truncated } over all ways. */
async function search(ctx, idRaw, query) {
  const conversations = require('./conversations');
  const messages = require('./messages');
  const p = await needPerson(ctx, idRaw);
  const ways = wayFilter(await waysOf(ctx, p), query);
  const hits = [];
  let scanned = 0;
  let truncated = false;
  for (const w of ways) {
    const rc = await conversations.receipts(ctx, w.conv, w.members);
    const r = await messages.search(ctx, w.me, query && query.q, rc);
    hits.push(...r.results);
    scanned += r.scanned;
    truncated = truncated || r.truncated;
  }
  hits.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id));
  return { results: hits.slice(0, SEARCH_RESULTS), scanned, truncated };
}

/**
 * The way of POST persons/:id/messages → { way, label, conversationId }: an answer to a message (replyTo) goes back the
 * way of that message (while it can send), everything else the way of `person.reply`.
 */
async function sendWay(ctx, idRaw, body) {
  const p = await needPerson(ctx, idRaw);
  const e = await entryOf(ctx, p);
  if (!e || !e.person.reply) throw fail('not_found');
  const rid = body && typeof body === 'object' ? posInt(body.replyTo) : null;
  if (rid) {
    const row = await store.one(ctx.gc, 'SELECT conv_id FROM messages WHERE id = ?', [rid]);
    const w = row ? e.person.ways.find((x) => x.conversationId === row.conv_id) : null;
    if (w && w.can.send) return { way: w.way, label: w.label, conversationId: w.conversationId };
  }
  const r = e.person.reply;
  return { way: r.way, label: r.label, conversationId: r.conversationId };
}

// ─── suggestions ────────────────────────────────────────────────────────────

/** The viewer's bridged direct chat with a contact of the bridge (matchAccounts' contactId = sender.id), or null. */
async function chatOfContact(ctx, net, contactId, chats) {
  const r = await store.one(ctx.gc, `SELECT c.id FROM conversations c JOIN bridge_contacts bc ON bc.owner_id = c.bridge_owner AND bc.network = c.bridge_net AND bc.ref = ?
    WHERE c.bridge_owner = ? AND c.bridge_net = ? AND c.kind = 'direct' AND c.bridge_channel = 0 AND c.last_msg_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM messages m WHERE m.conv_id = c.id AND m.ext_sender = bc.id) ORDER BY c.id LIMIT 1`, [contactId, ctx.viewer, net]);
  if (r) return r.id;
  const chatRef = chats ? chats.get(contactId) : null;
  if (!chatRef) return null;
  const c = await store.one(ctx.gc, "SELECT id FROM conversations WHERE bridge_owner = ? AND bridge_net = ? AND bridge_ref = ? AND kind = 'direct' AND bridge_channel = 0 AND last_msg_id IS NOT NULL", [ctx.viewer, net, chatRef]);
  return c ? c.id : null;
}

/** Ask the server which bridged chats are accounts here (at most every 10 minutes per person and network). */
async function refreshHints(ctx) {
  const b = matchApi(ctx.gc);
  if (!b) return;
  const asked = askedOf(ctx.gc);
  const nets = await store.all(ctx.gc, "SELECT DISTINCT bridge_net AS n FROM conversations WHERE bridge_owner = ? AND bridge_net IS NOT NULL AND kind = 'direct' AND bridge_channel = 0 AND last_msg_id IS NOT NULL", [ctx.viewer]);
  for (const { n } of nets) {
    const k = `${ctx.viewer}|${n}`;
    if (ctx.now - (asked.get(k) || 0) < MATCH_EVERY_MS && ctx.now >= (asked.get(k) || 0)) continue;
    if (asked.size > 2000) asked.clear();
    asked.set(k, ctx.now);
    let matches;
    try {
      const r = await b.matchAccounts(ctx.viewer, n);
      matches = r && Array.isArray(r.matches) ? r.matches : [];
    } catch { continue; /* as last known */ }
    // the bridge's own chat references, for contacts that never wrote (contacts(), version 6)
    let chats = null;
    if (matches.length && typeof b.contacts === 'function') {
      try {
        const r = await b.contacts(ctx.viewer, n);
        chats = new Map((r && Array.isArray(r.contacts) ? r.contacts : []).filter((c) => c && c.contactId && c.chatId).map((c) => [c.contactId, c.chatId]));
      } catch { chats = null; }
    }
    const seen = new Set();
    for (const m of matches) {
      if (!m || typeof m.contactId !== 'string' || !Number.isSafeInteger(m.userId) || m.userId === ctx.viewer) continue;
      const strength = m.strength === 'strong' ? 'strong' : 'medium';
      // 1.23.0: the own linked login of any network (own_whatsapp, own_signal)
      const via = m.via === `own_${n}` ? m.via : 'profile_phone';
      const convId = await chatOfContact(ctx, n, m.contactId, chats);
      if (!convId) continue;
      seen.add(`${convId}|${m.userId}`);
      await store.run(ctx.gc, `INSERT INTO person_hints (owner_id, conv_id, user_id, network, strength, via, state, until, seen_at) VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, ?)
        ON CONFLICT(owner_id, conv_id, user_id) DO UPDATE SET strength = excluded.strength, via = CASE WHEN person_hints.state = 'never' THEN person_hints.via ELSE excluded.via END, seen_at = excluded.seen_at`,
      [ctx.viewer, convId, m.userId, n, strength, via, ctx.now]);
    }
    // the account withdrew its consent (or the number went): its open suggestions go; „nie“ stays
    for (const h of await store.all(ctx.gc, "SELECT conv_id, user_id FROM person_hints WHERE owner_id = ? AND network = ? AND state != 'never'", [ctx.viewer, n])) {
      if (!seen.has(`${h.conv_id}|${h.user_id}`)) await store.run(ctx.gc, 'DELETE FROM person_hints WHERE owner_id = ? AND conv_id = ? AND user_id = ?', [ctx.viewer, h.conv_id, h.user_id]);
    }
  }
}

function reasonText(ctx, h, account, contact) {
  const key = /^own_[a-z]+$/.test(String(h.via || '')) ? 'person.why_own' : (h.strength === 'strong' ? 'person.why_confirmed' : 'person.why_unconfirmed');
  return t(ctx.lang, key, { account, contact, network: labelOf(h.network) });
}

/**
 * GET persons/suggestions → { suggestions: [{ id, conversationId, userId, network, label, strength, via, contact: { name,
 * avatarUrl, avatarMediaId }, account: { name, avatarUrl, initials, colorHex }, text, reason }] } — strong first.
 */
async function suggestions(ctx) {
  const conversations = require('./conversations');
  await refreshHints(ctx);
  const map = await wayMap(ctx);
  const rows = await store.all(ctx.gc, "SELECT * FROM person_hints WHERE owner_id = ? AND (state = 'open' OR (state = 'later' AND until <= ?))", [ctx.viewer, ctx.now]);
  const out = [];
  for (const h of rows) {
    if (map.has(h.conv_id)) continue;
    const acc = ctx.users.get(h.user_id);
    if (!acc || h.user_id === ctx.viewer) continue;
    // the account is merged with another chat of this network already: no second suggestion for it
    let x;
    try { x = await conversations.access(ctx, h.conv_id); } catch { continue; }
    if (refusal(ctx, x.conv, x.members) || !x.conv.last_msg_id) continue;
    const v = await conversations.view(ctx, x.conv, x.me, x.members);
    out.push({
      id: `${h.conv_id}-${h.user_id}`, conversationId: h.conv_id, userId: h.user_id, network: h.network, label: labelOf(h.network), strength: h.strength, via: h.via,
      contact: { name: v.title, avatarUrl: v.avatarUrl || null, avatarMediaId: v.avatarMediaId || null },
      account: { name: acc.name, avatarUrl: acc.avatarUrl || null, initials: acc.initials || null, colorHex: acc.colorHex || null },
      text: t(ctx.lang, 'person.card', { contact: v.title, account: acc.name, network: labelOf(h.network) }),
      reason: reasonText(ctx, h, acc.name, v.title),
      lastMessageAt: v.lastMessage ? v.lastMessage.createdAt : null,
    });
  }
  out.sort((a, b) => (a.strength === b.strength ? ((b.lastMessageAt || '') < (a.lastMessageAt || '') ? -1 : 1) : (a.strength === 'strong' ? -1 : 1)));
  return { suggestions: out };
}

/** POST persons/suggestions/:id { action: 'later' | 'never' } → { ok } — „Nicht jetzt“ (7 days), „Nicht mehr vorschlagen“. */
async function answer(ctx, idRaw, body) {
  const m = /^(\d{1,15})-(\d{1,15})$/.exec(String(idRaw || ''));
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (!m || (b.action !== 'later' && b.action !== 'never')) throw fail('invalid');
  const h = await store.one(ctx.gc, 'SELECT * FROM person_hints WHERE owner_id = ? AND conv_id = ? AND user_id = ?', [ctx.viewer, Number(m[1]), Number(m[2])]);
  if (!h) throw fail('not_found');
  await store.run(ctx.gc, 'UPDATE person_hints SET state = ?, until = ? WHERE owner_id = ? AND conv_id = ? AND user_id = ?',
    [b.action, b.action === 'later' ? ctx.now + LATER_MS : null, ctx.viewer, h.conv_id, h.user_id]);
  return { suggestion: { id: `${h.conv_id}-${h.user_id}`, state: b.action, until: b.action === 'later' ? iso(ctx.now + LATER_MS) : null } };
}

/**
 * GET persons/candidates?conversationId= → { accounts: [{ userId, name, avatarUrl, initials, colorHex }], chats: [{
 * conversationId, title, network, label, avatarUrl, avatarMediaId, personId }] } — „Mit Person zusammenführen …“ in the
 * chat info: the accounts (when the chat's person has none yet) and the other chats with one person.
 */
async function candidates(ctx, query) {
  const conversations = require('./conversations');
  const c = await wayCandidate(ctx, query && query.conversationId);
  const map = await wayMap(ctx);
  const own = map.get(c.conv.id) || null;
  const p = own ? await store.one(ctx.gc, 'SELECT * FROM persons WHERE id = ?', [own]) : null;
  const hasAccount = c.peer != null || !!(p && p.user_id != null);
  const accounts = [];
  if (!hasAccount) {
    const taken = new Set((await store.all(ctx.gc, 'SELECT user_id FROM persons WHERE owner_id = ? AND user_id IS NOT NULL', [ctx.viewer])).map((r) => r.user_id));
    for (const x of await people.list(ctx.gc, ctx.viewer)) {
      const u = ctx.users.get(x.id);
      if (!u || x.id === ctx.viewer) continue;
      accounts.push({ userId: x.id, name: u.name, avatarUrl: u.avatarUrl || null, initials: u.initials || null, colorHex: u.colorHex || null, personId: taken.has(x.id) ? (await store.one(ctx.gc, 'SELECT id FROM persons WHERE owner_id = ? AND user_id = ?', [ctx.viewer, x.id])).id : null });
    }
  }
  const chats = [];
  for (const r of await store.all(ctx.gc, "SELECT c.id FROM conversations c JOIN members m ON m.conv_id = c.id AND m.user_id = ? AND m.left_at IS NULL WHERE c.bridge_owner = ? AND c.kind = 'direct' AND c.bridge_channel = 0 AND c.last_msg_id IS NOT NULL AND c.id != ? ORDER BY c.updated_at DESC LIMIT 200", [ctx.viewer, ctx.viewer, c.conv.id])) {
    const pid = map.get(r.id) || null;
    if (own && pid === own) continue;
    const x = await conversations.access(ctx, r.id);
    const v = await conversations.view(ctx, x.conv, x.me, x.members);
    chats.push({ conversationId: v.id, title: v.title, network: v.bridge.network, label: v.bridge.label, avatarUrl: v.avatarUrl || null, avatarMediaId: v.avatarMediaId || null, personId: pid });
  }
  return { accounts, chats };
}

/** Forget what belongs to a person who left (the plugin's clean-up): ways of conversations gone. */
async function tidy(gc) {
  await store.run(gc, 'DELETE FROM person_ways WHERE conv_id NOT IN (SELECT id FROM conversations)');
  await store.run(gc, 'DELETE FROM persons WHERE id NOT IN (SELECT DISTINCT person_id FROM person_ways)');
  await store.run(gc, 'DELETE FROM person_hints WHERE conv_id NOT IN (SELECT id FROM conversations)');
}

/** A push about a new message of a way: the person's name and the way, or null (no person). */
async function pushName(gc, userId, convId, users) {
  const r = await store.one(gc, 'SELECT p.* FROM person_ways w JOIN persons p ON p.id = w.person_id WHERE w.owner_id = ? AND w.conv_id = ?', [userId, convId]);
  if (!r) return null;
  let name = null;
  if (r.name_from != null) {
    const c = await store.one(gc, 'SELECT * FROM conversations WHERE id = ?', [r.name_from]);
    if (c && c.bridge_net) {
      const n = seal.open(c.title_enc);
      name = typeof n === 'string' ? require('./util').bridgeName(n, 120) : null;
    }
  }
  if (!name && r.user_id != null && users && users.get(r.user_id)) name = users.get(r.user_id).name;
  const lead = await store.one(gc, "SELECT w.conv_id FROM person_ways w JOIN conversations c ON c.id = w.conv_id WHERE w.person_id = ? ORDER BY CASE WHEN c.bridge_net IS NULL THEN 0 ELSE 1 END, w.conv_id LIMIT 1", [r.id]);
  return { personId: r.id, conversationId: lead ? lead.conv_id : convId, name };
}

module.exports = {
  GC_WAY, LABEL, on, matchApi, chatOfContact, wayOf, labelOf, wayMap, personOf, waysOf, leadOf, fold, entryOf, personFor, syncFrom, merge, patch, archive, split, page, read, search,
  sendWay, suggestions, answer, candidates, tidy, pushName, needPerson, prefOf, t,
  _reset: (gc) => askedOf(gc).clear(),
};
