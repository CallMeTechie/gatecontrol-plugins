'use strict';

// The background run (every minute): reminders as pushes, the morning hint „Gestern offen geblieben“ and the tasks'
// events in Mail's calendar (1.3.0), notes that expire (Familie's Pinnwand), the trash after
// 30 days, old „Mein Tag“ marks, notes_changed to Familie, the sources' reconciliation, the To Do import and sync.

const store = require('./store');
const tz = require('./tz');
const config = require('./config');
const events = require('./events');
const fts = require('./fts');
const notes = require('./notes');
const attachments = require('./attachments');
const sources = require('./sources');
const bound = require('./bound');
const mstodo = require('./mstodo');
const clientIds = require('./clientids');
const prefs = require('./prefs');
const { t } = require('./text');
const push = require('./push');
const pushprefs = require('./pushprefs');
const lists = require('./lists');
const remind = require('./remind');
const yesterday = require('./yesterday');
const calsync = require('./calsync');
const shopping = require('./shopping');
const places = require('./places');

const TRASH_MS = 30 * 86400000;
const REMIND_LATE = 6 * 3600000; // the push of a list day missed by more than this (server off) is not sent any more

/** The reminders that are due as pushes with buttons — late ones too, up to 24 hours (1.3.0: server/remind.js). */
const reminders = (gc, ctx) => remind.tick(gc, ctx);

/**
 * 1.2.0: the push in the morning of a list day (topic listday, „Heute ist Einkaufstag“) — once per list and day at its
 * time `remind`, to every member who has the card (not mydayOff, prefs.myday.listdays) and wants the push
 * (prefs.notify.listday); only when something is open. Missed by more than REMIND_LATE (server off): not sent.
 */
async function listDays(gc, ctx) {
  const cfg = await config.get(gc);
  const bit = lists.bitOf(ctx.today);
  const rows = await store.all(gc, `SELECT * FROM lists INDEXED BY idx_lists_remind WHERE remind IS NOT NULL AND days != 0 AND deleted_at IS NULL AND remind <= ?
    AND (days & ?) != 0 AND (reminded_day IS NULL OR reminded_day != ?) LIMIT 100`, [ctx.time, bit, ctx.today]);
  let sent = 0;
  for (const l of rows) {
    await store.run(gc, 'UPDATE lists SET reminded_day = ? WHERE id = ?', [ctx.today, l.id]);
    const at = tz.at(ctx.today, tz.parseTime(l.remind), ctx.tz);
    if (ctx.now - at > REMIND_LATE) continue;
    const open = (await lists.openCounts(gc, [l.id])).get(l.id) || 0;
    if (!open) continue;
    const members = (await store.all(gc, 'SELECT user_id FROM list_members WHERE list_id = ? AND myday_off = 0', [l.id])).map((m) => m.user_id);
    const users = [];
    for (const u of members) if ((await prefs.get(gc, u)).myday.listdays !== false) users.push(u);
    if (!users.length) continue;
    const lang = cfg.notify_lang;
    if (await pushprefs.send(gc, users, 'listday', {
      topic: 'listday', title: l.icon === 'cart' ? t(lang, 'v.listday_cart') : t(lang, 'n.listday_title', { name: l.name }).slice(0, 120),
      body: t(lang, open === 1 ? 'n.listday_body_one' : 'n.listday_body', { name: l.name, n: open }).slice(0, 1000),
      collapseKey: 'listday:' + l.id, data: { notizen: push.listDay(l, ctx.today) },
    })) sent++;
  }
  return sent;
}

async function expire(gc, ctx) {
  const rows = await store.all(gc, `SELECT n.*, b.bound_plugin AS nb_bound FROM notes n INDEXED BY idx_notes_expires JOIN notebooks b ON b.id = n.notebook_id
    WHERE n.expires_at IS NOT NULL AND n.expires_at <= ? AND n.deleted_at IS NULL LIMIT 200`, [ctx.now]);
  for (const r of rows) await notes.remove(gc, { ...ctx, userId: null }, r.id, { row: r });
  return rows.length;
}

async function purge(gc, ctx) {
  const before = ctx.now - TRASH_MS;
  const ts = await store.all(gc, 'SELECT id FROM tasks INDEXED BY idx_tasks_trash WHERE deleted_at IS NOT NULL AND deleted_at < ? AND ext_dirty = 0 LIMIT 500', [before]);
  for (const r of ts) {
    await attachments.purgeOf(gc, 'task', r.id);
    await store.run(gc, 'DELETE FROM my_day WHERE task_id = ?', [r.id]);
    await fts.dropTask(gc, r.id);
    await store.run(gc, 'DELETE FROM tasks WHERE id = ?', [r.id]);
  }
  const ns = await store.all(gc, 'SELECT id FROM notes INDEXED BY idx_notes_trash WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT 500', [before]);
  for (const r of ns) {
    await attachments.purgeOf(gc, 'note', r.id);
    await fts.dropNote(gc, r.id);
    await store.run(gc, 'DELETE FROM notes WHERE id = ?', [r.id]);
  }
  // notebooks and lists deleted for good: their member rows went with the delete; their own rows go when empty.
  // "Empty" is asked of two indexes each (1.2.1, migrations/004_trash_indexes.sql): the rows still there, and the rest
  // (in the trash; sub-tasks) — one question without them read every note or task, once per notebook or list
  await store.run(gc, `DELETE FROM notebooks WHERE deleted_at IS NOT NULL AND deleted_at < ?
    AND NOT EXISTS (SELECT 1 FROM notes INDEXED BY idx_notes_nb WHERE notes.notebook_id = notebooks.id AND notes.deleted_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM notes INDEXED BY idx_notes_gone WHERE notes.notebook_id = notebooks.id AND notes.deleted_at IS NOT NULL)`, [before]);
  // 1.4.0: the items of shopping lists that leave the trash
  await shopping.purgeLists(gc, before);
  await store.run(gc, `DELETE FROM lists WHERE deleted_at IS NOT NULL AND deleted_at < ?
    AND NOT EXISTS (SELECT 1 FROM tasks INDEXED BY idx_tasks_list WHERE tasks.list_id = lists.id AND tasks.deleted_at IS NULL AND tasks.parent_id IS NULL)
    AND NOT EXISTS (SELECT 1 FROM tasks INDEXED BY idx_tasks_rest WHERE tasks.list_id = lists.id AND (tasks.deleted_at IS NOT NULL OR tasks.parent_id IS NOT NULL))`, [before]);
  await store.run(gc, 'DELETE FROM my_day WHERE user_id IN (SELECT DISTINCT user_id FROM my_day) AND day < ?', [tz.addDays(ctx.today, -7)]);
  await clientIds.purge(gc, ctx.now);
  // 1.5.0: places no task and no choice needs any more
  await places.purge(gc, ctx.now);
  return ts.length + ns.length;
}

async function tick(gc, ctx) {
  const out = {};
  const run = async (name, fn) => { try { out[name] = await fn(); } catch (e) { gc.log.warn('background part failed', name, (e && (e.code || e.message)) || 'error'); } };
  await run('reminders', () => reminders(gc, ctx));
  await run('listdays', () => listDays(gc, ctx));
  await run('yesterday', () => yesterday.tick(gc, ctx));
  await run('calendar', () => calsync.tick(gc, ctx));
  await run('expire', () => expire(gc, ctx));
  await run('bound', () => bound.flush(gc, ctx.now));
  await run('shopping', () => shopping.tick(gc, ctx));
  await run('sources', () => sources.tick(gc, ctx));
  await run('mstodo', () => mstodo.tick(gc, ctx));
  if (!tick.lastPurge || ctx.now - tick.lastPurge > 3600000) { tick.lastPurge = ctx.now; await run('purge', () => purge(gc, ctx)); }
  events.now();
  return out;
}

module.exports = { tick, reminders, listDays, expire, purge };
