'use strict';

// 1.4.0 — polls (message kind 'poll', README "Polls"). Question and options are kept in the message's
// encrypted meta; the table polls holds what the votes and the background run need (multi, anonymous,
// allowAdd, closesAt, closed, last nudge), poll_votes one row per (person, option).
//   vote     { optionIds: [] } replaces the caller's votes (empty = withdraw; one option unless multi)
//   options  { text } adds an option (allowAdd, ≤ 12 options, not twice)
//   close    the creator or a group admin; also the background run at closesAt → system message poll_closed
//   nudge    the creator: a push to the members who have not voted (at most once an hour)
// Every change → event poll.update { conversationId, messageId, updatedAt } to the members.

const store = require('./store');
const seal = require('./seal');
const live = require('./live');
const messages = require('./messages');
const { fail, posInt, text, optText, bool, iso, parseIso, parseJson } = require('./util');

const QUESTION_MAX = 200;
const OPTION_MAX = 80;
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 12;
const NUDGE_EVERY_MS = 3600000;

/** Check `poll` of a send body → the stored definition. */
function clean(ctx, v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail('invalid');
  const question = text(v.question, QUESTION_MAX);
  if (!Array.isArray(v.options) || v.options.length < OPTIONS_MIN || v.options.length > OPTIONS_MAX) throw fail('invalid');
  const options = [];
  for (const o of v.options) {
    const t = text(typeof o === 'object' && o ? o.text : o, OPTION_MAX);
    if (options.some((x) => x.text.toLowerCase() === t.toLowerCase())) throw fail('invalid');
    options.push({ id: 'o' + (options.length + 1), text: t, addedBy: null });
  }
  const flag = (k) => (v[k] == null ? false : bool(v[k]));
  let closesAt = null;
  if (v.closesAt != null) {
    closesAt = parseIso(v.closesAt);
    if (closesAt == null || closesAt <= ctx.now || closesAt > ctx.now + 366 * 86400000) throw fail('invalid');
  }
  return { question, options, multi: flag('multi'), anonymous: flag('anonymous'), allowAdd: flag('allowAdd'), closesAt };
}

/** After the message row exists (inside the send transaction). */
async function create(ctx, conv, msgId, p) {
  await store.run(ctx.gc, 'INSERT INTO polls (msg_id, conv_id, creator_id, multi, anonymous, allow_add, closes_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [msgId, conv.id, ctx.viewer, p.multi ? 1 : 0, p.anonymous ? 1 : 0, p.allowAdd ? 1 : 0, p.closesAt]);
}

const isClosed = (row, now) => row.closed_at != null || (row.closes_at != null && row.closes_at <= now);

/** The poll objects of these message rows (kind poll) for the viewer → Map msgId → poll. */
async function decorate(ctx, rows) {
  const out = new Map();
  for (const r of rows) {
    const def = (messages.metaOf(r) || {}).poll;
    const row = await store.one(ctx.gc, 'SELECT * FROM polls WHERE msg_id = ?', [r.id]);
    if (!def || !row) continue;
    const votes = await store.all(ctx.gc, 'SELECT user_id, option_id FROM poll_votes WHERE msg_id = ? ORDER BY at, user_id', [r.id]);
    const mc = await store.one(ctx.gc, 'SELECT COUNT(*) AS n FROM members WHERE conv_id = ? AND left_at IS NULL', [r.conv_id]);
    const voters = new Set(votes.map((v) => v.user_id));
    out.set(r.id, {
      question: def.question,
      options: def.options.map((o) => {
        const vs = votes.filter((v) => v.option_id === o.id).map((v) => v.user_id);
        const x = { id: o.id, text: o.text, count: vs.length, addedBy: o.addedBy || null };
        if (!row.anonymous) x.voters = vs;
        return x;
      }),
      multi: !!row.multi, anonymous: !!row.anonymous, allowAdd: !!row.allow_add,
      closesAt: iso(row.closes_at), closed: isClosed(row, ctx.now), closedAt: iso(row.closed_at != null ? row.closed_at : (isClosed(row, ctx.now) ? row.closes_at : null)),
      voterCount: voters.size, memberCount: mc ? mc.n : 0, creatorId: row.creator_id,
      myVotes: votes.filter((v) => v.user_id === ctx.viewer).map((v) => v.option_id),
    });
  }
  return out;
}

async function load(ctx, x, idRaw) {
  const id = posInt(idRaw);
  if (!id) throw fail('not_found');
  const msg = await messages.visibleMessage(ctx, x.me, id);
  if (msg.kind !== 'poll' || msg.deleted_at) throw fail(msg.deleted_at ? 'deleted' : 'invalid');
  const row = await store.one(ctx.gc, 'SELECT * FROM polls WHERE msg_id = ?', [id]);
  if (!row) throw fail('invalid');
  return { msg, row, def: (messages.metaOf(msg) || {}).poll };
}

async function touched(ctx, x, id) {
  await store.run(ctx.gc, 'UPDATE messages SET updated_at = ? WHERE id = ?', [ctx.now, id]);
  await store.run(ctx.gc, 'UPDATE conversations SET updated_at = ? WHERE id = ?', [ctx.now, x.conv.id]);
  live.queue(ctx.box, x.members.map((m) => m.user_id), 'poll.update', { conversationId: x.conv.id, messageId: id, updatedAt: iso(ctx.now) });
}

/** POST messages/:id/vote { optionIds } */
async function vote(ctx, x, idRaw, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b || !Array.isArray(b.optionIds) || b.optionIds.length > OPTIONS_MAX) throw fail('invalid');
  const { msg, row, def } = await load(ctx, x, idRaw);
  if (isClosed(row, ctx.now)) throw fail('closed');
  const ids = [...new Set(b.optionIds)];
  if (!ids.every((o) => typeof o === 'string' && def.options.some((d) => d.id === o))) throw fail('invalid');
  if (!row.multi && ids.length > 1) throw fail('invalid');
  await store.run(ctx.gc, 'DELETE FROM poll_votes WHERE msg_id = ? AND user_id = ?', [msg.id, ctx.viewer]);
  for (const o of ids) await store.run(ctx.gc, 'INSERT INTO poll_votes (msg_id, user_id, option_id, at) VALUES (?, ?, ?, ?)', [msg.id, ctx.viewer, o, ctx.now]);
  await touched(ctx, x, msg.id);
  return msg.id;
}

/** POST messages/:id/options { text } */
async function addOption(ctx, x, idRaw, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) throw fail('invalid');
  const t = text(b.text, OPTION_MAX);
  const { msg, row, def } = await load(ctx, x, idRaw);
  if (isClosed(row, ctx.now)) throw fail('closed');
  if (!row.allow_add) throw fail('not_allowed');
  if (def.options.length >= OPTIONS_MAX) throw fail('too_many');
  if (def.options.some((o) => o.text.toLowerCase() === t.toLowerCase())) throw fail('invalid');
  const next = Math.max(...def.options.map((o) => Number(String(o.id).slice(1)) || 0)) + 1;
  const meta = messages.metaOf(msg) || {};
  meta.poll = { ...def, options: [...def.options, { id: 'o' + next, text: t, addedBy: ctx.viewer }] };
  await store.run(ctx.gc, 'UPDATE messages SET meta_enc = ? WHERE id = ?', [seal.sealJson(meta), msg.id]);
  await touched(ctx, x, msg.id);
  return msg.id;
}

/** The winners of a poll (most votes; none without votes). */
async function winners(gc, msgId, def) {
  const counts = new Map();
  for (const v of await store.all(gc, 'SELECT option_id, COUNT(*) AS n FROM poll_votes WHERE msg_id = ? GROUP BY option_id', [msgId])) counts.set(v.option_id, v.n);
  const top = Math.max(0, ...counts.values());
  if (!top) return { winners: [], votes: 0 };
  return { winners: def.options.filter((o) => counts.get(o.id) === top).map((o) => o.text), votes: top };
}

/** Close a poll (inside a transaction) and post poll_closed. `conv` the conversation row. */
async function closeNow(ctx, conv, msg, row, def, by) {
  await store.run(ctx.gc, 'UPDATE polls SET closed_at = ? WHERE msg_id = ?', [ctx.now, msg.id]);
  const w = await winners(ctx.gc, msg.id, def);
  const sysId = await messages.system(ctx, conv, 'poll_closed', { by, messageId: msg.id, question: def.question, winner: w.winners.length === 1 ? w.winners[0] : null, winners: w.winners, votes: w.votes });
  await store.run(ctx.gc, 'UPDATE messages SET updated_at = ? WHERE id = ?', [ctx.now, msg.id]);
  const members = await store.all(ctx.gc, 'SELECT user_id FROM members WHERE conv_id = ? AND left_at IS NULL', [conv.id]);
  const ids = members.map((m) => m.user_id);
  live.queue(ctx.box, ids, 'poll.update', { conversationId: conv.id, messageId: msg.id, updatedAt: iso(ctx.now) });
  live.queue(ctx.box, ids, 'message.new', { conversationId: conv.id, messageId: sysId, senderId: null, clientId: null, kind: 'system', createdAt: iso(ctx.now) });
}

/** POST messages/:id/close (creator or group admin) */
async function close(ctx, x, idRaw) {
  const { msg, row, def } = await load(ctx, x, idRaw);
  if (row.creator_id !== ctx.viewer && x.me.role !== 'admin') throw fail('not_allowed');
  if (row.closed_at != null) throw fail('closed');
  await closeNow(ctx, x.conv, msg, row, def, ctx.viewer);
  return msg.id;
}

/** POST messages/:id/nudge (creator, once an hour) → the push job for after the commit; { nudged } */
async function nudge(ctx, x, idRaw) {
  const { msg, row, def } = await load(ctx, x, idRaw);
  if (row.creator_id !== ctx.viewer) throw fail('not_allowed');
  if (isClosed(row, ctx.now)) throw fail('closed');
  if (row.nudged_at != null && ctx.now - row.nudged_at < NUDGE_EVERY_MS) throw fail('rate_limited');
  const voted = new Set((await store.all(ctx.gc, 'SELECT DISTINCT user_id FROM poll_votes WHERE msg_id = ?', [msg.id])).map((r) => r.user_id));
  const to = x.members.map((m) => m.user_id).filter((u) => u !== ctx.viewer && !voted.has(u) && ctx.users.has(u));
  await store.run(ctx.gc, 'UPDATE polls SET nudged_at = ? WHERE msg_id = ?', [ctx.now, msg.id]);
  if (to.length) {
    ctx.box.pushes.push({ custom: { kind: 'poll_nudge', conv: x.conv, members: x.members, users: to, senderId: ctx.viewer, messageId: msg.id, params: { question: def.question }, respectMute: true } });
  }
  return { messageId: msg.id, nudged: to.length };
}

/** Background: polls past closesAt → closed with poll_closed. */
async function closeDue(ctx) {
  const rows = await store.all(ctx.gc, 'SELECT * FROM polls WHERE closed_at IS NULL AND closes_at IS NOT NULL AND closes_at <= ? LIMIT 100', [ctx.now]);
  let n = 0;
  for (const row of rows) {
    const msg = await store.one(ctx.gc, 'SELECT * FROM messages WHERE id = ?', [row.msg_id]);
    const conv = msg ? await store.one(ctx.gc, 'SELECT * FROM conversations WHERE id = ?', [msg.conv_id]) : null;
    const def = msg ? (messages.metaOf(msg) || {}).poll : null;
    if (!msg || !conv || !def || msg.deleted_at) { await store.run(ctx.gc, 'UPDATE polls SET closed_at = ? WHERE msg_id = ?', [ctx.now, row.msg_id]); continue; }
    await closeNow(ctx, conv, msg, row, def, null);
    n++;
  }
  return n;
}

module.exports = { clean, create, decorate, vote, addOption, close, nudge, closeDue, winners, QUESTION_MAX, OPTION_MAX, OPTIONS_MAX, parseJson, optText };
