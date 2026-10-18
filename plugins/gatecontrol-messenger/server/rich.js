'use strict';

// 1.4.0 — the message kinds beyond 1.3 in one place for messages.js: checks when sending (poll, event,
// arrival, action), the objects of a message view (poll, event, arrival, action, card), short texts for
// quotes / search / pushes, and the clean-up when messages go (deleted for everyone, disappearing,
// retention, a deleted managed group).

const store = require('./store');
const people = require('./people');
const polls = require('./polls');
const eventmsg = require('./eventmsg');
const arrival = require('./arrival');
const homeactions = require('./homeactions');
const { fail } = require('./util');

const KINDS = ['poll', 'event', 'arrival', 'action'];
const VIEW_KINDS = ['poll', 'event', 'arrival', 'action', 'card'];

/** Check the kind's object of a send body → { meta, create(msgId) } (inside the send transaction). */
async function prepare(ctx, conv, members, kind, b) {
  for (const k of KINDS) if (k !== kind && b[k] != null) throw fail('invalid');
  if (kind === 'poll') {
    const p = polls.clean(ctx, b.poll);
    return { meta: { poll: p }, create: (id) => polls.create(ctx, conv, id, p) };
  }
  if (kind === 'event') {
    const prefs = (await people.prefsOf(ctx.gc, [ctx.viewer])).get(ctx.viewer);
    const e = eventmsg.clean(ctx, b.event, prefs.notify.eventReminderMin);
    return { meta: { event: e.meta }, create: (id) => eventmsg.create(ctx, conv, id, e) };
  }
  if (kind === 'arrival') {
    const a = arrival.clean(b.arrival);
    return { meta: { arrival: a }, create: (id) => arrival.create(ctx, conv, id, a) };
  }
  if (kind === 'action') {
    const a = await homeactions.clean(ctx, conv, members, b.action);
    return { meta: { action: a.meta }, create: (id) => homeactions.create(ctx, conv, id, a) };
  }
  throw fail('invalid');
}

/** Add poll / event / arrival / action / card to the views `outs` (same order as `rows`). */
async function decorate(ctx, rows, outs) {
  const want = (k) => rows.filter((r, i) => r.kind === k && !r.deleted_at && outs[i]);
  const put = (map, key) => { rows.forEach((r, i) => { if (map.has(r.id) && outs[i]) outs[i][key] = map.get(r.id); }); };
  const p = want('poll');
  if (p.length) put(await polls.decorate(ctx, p), 'poll');
  const e = want('event');
  if (e.length) put(await eventmsg.decorate(ctx, e), 'event');
  const a = want('arrival');
  if (a.length) put(await arrival.decorate(ctx, a), 'arrival');
  const h = [...want('action'), ...want('card')];
  if (h.length) {
    const map = await homeactions.decorate(ctx, h);
    rows.forEach((r, i) => {
      const v = map.get(r.id);
      if (!v || !outs[i]) return;
      if (v.action) outs[i].action = v.action;
      if (v.card) outs[i].card = v.card;
    });
  }
}

/** A short text of a rich message (quotes, search, pushes, export): question, title, destination, label. */
function summaryText(kind, meta) {
  const m = meta || {};
  if (kind === 'poll' && m.poll) return m.poll.question;
  if (kind === 'event' && m.event) return m.event.title;
  if (kind === 'arrival' && m.arrival) return m.arrival.dest && m.arrival.dest.label;
  if (kind === 'action' && m.action) return m.action.label;
  if (kind === 'card' && m.card) return m.card.title;
  return null;
}

/**
 * Messages that go for good or become tombstones (inside a transaction): their poll / event / arrival /
 * action rows, reminders and pins. `ctx` = { gc, now, box? } (box: Familie calendar entries are removed after the commit).
 */
async function cleanup(ctx, ids) {
  if (!ids.length) return;
  const gc = ctx.gc;
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const marks = store.marks(part.length);
    await store.run(gc, `DELETE FROM polls WHERE msg_id IN (${marks})`, part);
    await store.run(gc, `DELETE FROM poll_votes WHERE msg_id IN (${marks})`, part);
    await store.run(gc, `DELETE FROM arrivals WHERE msg_id IN (${marks})`, part);
    await store.run(gc, `DELETE FROM reminders WHERE msg_id IN (${marks})`, part);
  }
  await eventmsg.cleanup(ctx, ids);
  await homeactions.cleanup(gc, ids);
  // pins: drop the ids from the conversations that pinned them
  const convs = await store.all(gc, 'SELECT id, pins FROM conversations WHERE pins IS NOT NULL');
  for (const c of convs) {
    let list;
    try { list = JSON.parse(c.pins); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    const next = list.filter((x) => !ids.includes(x));
    if (next.length !== list.length) await store.run(gc, 'UPDATE conversations SET pins = ? WHERE id = ?', [next.length ? JSON.stringify(next) : null, c.id]);
  }
}

module.exports = { prepare, decorate, summaryText, cleanup, KINDS, VIEW_KINDS };
