'use strict';

// The background run (every minute): reminders as pushes, notes that expire (Familie's Pinnwand), the trash after
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
const { t } = require('./text');

const TRASH_MS = 30 * 86400000;
const REMIND_LATE = 6 * 3600000; // a reminder missed by more than this (server off) is not sent any more

async function reminders(gc, ctx) {
  const cfg = await config.get(gc);
  const rows = await store.all(gc, `SELECT t.*, l.name AS list_name FROM tasks t INDEXED BY idx_tasks_remind JOIN lists l ON l.id = t.list_id AND l.deleted_at IS NULL
    WHERE t.remind_at IS NOT NULL AND t.reminded_at IS NULL AND t.done_at IS NULL AND t.deleted_at IS NULL AND t.remind_at <= ? ORDER BY t.remind_at LIMIT 100`, [ctx.now]);
  let sent = 0;
  for (const r of rows) {
    await store.run(gc, 'UPDATE tasks SET reminded_at = ? WHERE id = ?', [ctx.now, r.id]);
    if (ctx.now - r.remind_at > REMIND_LATE) continue;
    let who = r.assignee_id || r.created_by;
    const m = await store.one(gc, 'SELECT 1 AS x FROM list_members WHERE list_id = ? AND user_id = ?', [r.list_id, who]);
    if (!m) { const o = await store.one(gc, "SELECT user_id FROM list_members WHERE list_id = ? AND role = 'owner'", [r.list_id]); if (!o) continue; who = o.user_id; }
    const lang = cfg.notify_lang;
    const when = r.due_date ? (r.due_time ? `${r.due_date === ctx.today ? t(lang, 'w.today') : r.due_date} ${r.due_time}` : (r.due_date === ctx.today ? t(lang, 'w.today') : r.due_date)) : null;
    try {
      await gc.notify({
        topic: 'reminders', users: [who], title: r.title.slice(0, 120), body: [when ? t(lang, 'n.due', { when }) : null, r.list_name].filter(Boolean).join(' · ').slice(0, 1000),
        priority: r.important ? 'high' : 'normal', collapseKey: 'task:' + r.id, data: { notizen: { task: r.id } },
      });
      sent++;
    } catch (e) { gc.log.warn('reminder push failed', (e && e.code) || 'error'); }
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
  // notebooks and lists deleted for good: their member rows went with the delete; their own rows go when empty
  await store.run(gc, 'DELETE FROM notebooks WHERE deleted_at IS NOT NULL AND deleted_at < ? AND NOT EXISTS (SELECT 1 FROM notes WHERE notes.notebook_id = notebooks.id)', [before]);
  await store.run(gc, 'DELETE FROM lists WHERE deleted_at IS NOT NULL AND deleted_at < ? AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.list_id = lists.id)', [before]);
  await store.run(gc, 'DELETE FROM my_day WHERE user_id IN (SELECT DISTINCT user_id FROM my_day) AND day < ?', [tz.addDays(ctx.today, -7)]);
  return ts.length + ns.length;
}

async function tick(gc, ctx) {
  const out = {};
  const run = async (name, fn) => { try { out[name] = await fn(); } catch (e) { gc.log.warn('background part failed', name, (e && (e.code || e.message)) || 'error'); } };
  await run('reminders', () => reminders(gc, ctx));
  await run('expire', () => expire(gc, ctx));
  await run('bound', () => bound.flush(gc, ctx.now));
  await run('sources', () => sources.tick(gc, ctx));
  await run('mstodo', () => mstodo.tick(gc, ctx));
  if (!tick.lastPurge || ctx.now - tick.lastPurge > 3600000) { tick.lastPurge = ctx.now; await run('purge', () => purge(gc, ctx)); }
  events.now();
  return out;
}

module.exports = { tick, reminders, expire, purge };
