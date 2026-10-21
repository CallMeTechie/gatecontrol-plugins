'use strict';

// Background (permissions.background, every 60 s):
//   * disappearing messages: rows past expires_at are deleted for good (with reactions, "hidden" marks
//     and their files) → event message.delete { reason: 'expired' } to the members;
//   * retention (hourly): messages older than the administrator's retention → reason 'retention';
//   * files of deleted messages / replaced group pictures (media.orphan) are deleted from GateControl's
//     media store (retried until it works);
//   * the admin log keeps 30 days.
//   1.4.0: expired statuses and stories (with their files), polls past closesAt, event reminders and
//   departure hints, live arrivals after 3 h, open action requests after 24 h and ended grants, due
//   "remind me" pushes, the daily story digest (hourly check), and the poll / event / arrival / action rows
//   of purged messages.
//   1.6.0: the idempotency rows of delivered notifications (notices) after 7 days.

const store = require('./store');
const live = require('./live');
const log = require('./log');
const config = require('./config');
const messages = require('./messages');
const conversations = require('./conversations');
const people = require('./people');
const status = require('./status');
const polls = require('./polls');
const eventmsg = require('./eventmsg');
const arrival = require('./arrival');
const homeactions = require('./homeactions');
const tools = require('./tools');
const rich = require('./rich');
const push = require('./push');

const BATCH = 500;
const HOUR = 3600000;
const state = { lastHourly: 0, ticking: false };

/** Delete message rows for good (inside a transaction) and queue the events. */
async function purge(gc, rows, reason, box, now = Date.now()) {
  if (!rows.length) return 0;
  const byConv = new Map();
  for (const r of rows) {
    if (!byConv.has(r.conv_id)) byConv.set(r.conv_id, []);
    byConv.get(r.conv_id).push(r.id);
  }
  const ids = rows.map((r) => r.id);
  await messages.orphanMedia(gc, ids);
  await rich.cleanup({ gc, now, box }, ids);
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const marks = store.marks(part.length);
    await store.run(gc, `DELETE FROM reactions WHERE msg_id IN (${marks})`, part);
    await store.run(gc, `DELETE FROM hidden WHERE msg_id IN (${marks})`, part);
    await store.run(gc, `DELETE FROM messages WHERE id IN (${marks})`, part);
  }
  for (const [convId, list] of byConv) {
    await store.run(gc, 'UPDATE conversations SET updated_at = ? WHERE id = ?', [now, convId]);
    const members = await conversations.membersOf(gc, convId);
    live.queue(box, members.map((m) => m.user_id), 'message.delete', { conversationId: convId, messageIds: list, reason });
  }
  return ids.length;
}

async function expire(gc, now, box) {
  const rows = await store.all(gc, 'SELECT id, conv_id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?', [now, BATCH]);
  return purge(gc, rows, 'expired', box, now);
}

async function retention(gc, now, box) {
  const cfg = await config.load(gc);
  if (!cfg.retentionDays) return 0;
  const rows = await store.all(gc, 'SELECT id, conv_id FROM messages WHERE created_at < ? ORDER BY id LIMIT ?', [now - cfg.retentionDays * 86400000, BATCH * 2]);
  return purge(gc, rows, 'retention', box, now);
}

/** Delete orphaned files from GateControl's media store → number deleted. */
async function cleanMedia(gc, now) {
  const rows = await store.all(gc, 'SELECT media_id FROM media WHERE orphan = 1 LIMIT 200');
  let n = 0;
  for (const r of rows) {
    try {
      await gc.media.delete(r.media_id);
      await store.run(gc, 'DELETE FROM media WHERE media_id = ?', [r.media_id]);
      n++;
    } catch (e) {
      await log.add(gc, 'media_delete_failed', (e && e.code) || null, now);
    }
  }
  return n;
}

async function tick(gc, now = Date.now()) {
  if (state.ticking) return null;
  state.ticking = true;
  const box = live.outbox();
  const out = { expired: 0, retention: 0, media: 0, statuses: 0, stories: 0, polls: 0, events: 0, arrivals: 0, actions: 0, reminders: 0, digest: 0 };
  let ctx = null;
  const step = async (name, fn) => {
    try { return await fn(); } catch (e) {
      gc.log.warn('background step failed', name, (e && (e.code || e.message)) || 'error');
      await log.add(gc, 'job_failed', name, now);
      return 0;
    }
  };
  // a step in its own transaction: nothing it queued goes out when it was rolled back
  const txStep = (name, fn) => {
    const ev = box.events.length;
    const pu = box.pushes.length;
    const af = box.after.length;
    return step(name, () => store.tx(gc, fn).catch((e) => { box.events.length = ev; box.pushes.length = pu; box.after.length = af; throw e; }));
  };
  try {
    ctx = { gc, now, viewer: null, users: await people.users(gc, now), cfg: await config.load(gc), portal: false, box };
    out.expired = await step('expire', () => store.tx(gc, () => expire(gc, now, box)));
    const st = await txStep('status', () => status.expire(ctx));
    if (st) { out.statuses = st.statuses; out.stories = st.stories; }
    out.polls = await txStep('polls', () => polls.closeDue(ctx));
    out.events = await txStep('events', () => eventmsg.due(ctx));
    out.arrivals = await txStep('arrivals', () => arrival.autoStop(ctx));
    out.actions = await txStep('actions', () => homeactions.expire(ctx));
    out.reminders = await txStep('reminders', () => tools.dueReminders(ctx));
    if (now - state.lastHourly >= HOUR) {
      state.lastHourly = now;
      out.retention = await step('retention', () => store.tx(gc, () => retention(gc, now, box)));
      await step('log', () => log.purge(gc, now));
      await step('notices', () => require('./notices').purge(gc, now));
      const list = await txStep('digest', () => status.digest(ctx));
      if (Array.isArray(list) && list.length) { out.digest = list.length; await step('digest_push', () => push.digest(gc, list, now)); }
    }
    await live.flush(gc, box);
    const jobs = box.pushes;
    box.pushes = [];
    for (const j of jobs) await step('push', () => push.send(gc, j, ctx.users, now));
    const after = box.after;
    box.after = [];
    for (const fn of after) await step('after', fn);
    if (box.events.length) await live.flush(gc, box);
    out.media = await step('media', () => cleanMedia(gc, now));
  } finally {
    state.ticking = false;
  }
  return out;
}

function reset() { state.lastHourly = 0; state.ticking = false; }

module.exports = { tick, purge, expire, retention, cleanMedia, reset, state };
