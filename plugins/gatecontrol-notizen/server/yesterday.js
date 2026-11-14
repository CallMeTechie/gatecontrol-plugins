'use strict';

// 1.3.0: „Gestern offen geblieben“ — what a person left open yesterday, as a card at the top of „Mein Tag“ and as one
// push in the morning.
//
//   What counts (own tasks, no sub tasks, open): due yesterday and the person's (duty.js); put into „Mein Tag“ by the
//   person yesterday (unless it is due today or in „Mein Tag“ again); a reminder that could not be sent any more
//   (tasks.missed_at). Items of the other plugins are not part of it.
//
//   GET yesterday?area= → { day, title, count, items: [Task], moveOptions }   (also `yesterday` of GET views/myday)
//   POST tasks/<id>/move { to: 'today' | 'tomorrow' | 'weekend' | 'YYYY-MM-DD' } → { task }
//   POST yesterday { action: 'done' | 'today' | 'move', to?, ids?, area? } → { changed, failed, yesterday }
//
//   The push (topic reminders, data.notizen { kind: 'yesterday', day, count, taskIds }): once a day at the person's time
//   (prefs.yesterdayAt, 07:30), only with something open and unless prefs.notify.yesterday is off; missed by more than
//   LATE_MAX (the server was off) it is not sent that day. Buttons: „Erledigt“ (one task: a callback that ticks it off;
//   several: opens the app, which asks once), „Heute“ (callback: all of them to today), „Verschieben“ (opens the app).

const store = require('./store');
const tz = require('./tz');
const config = require('./config');
const prefs = require('./prefs');
const tasks = require('./tasks');
const lists = require('./lists');
const duty = require('./duty');
const events = require('./events');
const calsync = require('./calsync');
const pushprefs = require('./pushprefs');
const { t } = require('./text');
const { fail, posInt, isDate, area: areaOf } = require('./util');

const LATE_MAX = 6 * 3600000;  // as the push of a list day: later than this the morning is over
const PLAN_MS = 15 * 60000;    // how often the background run asks who has something open
const IDS_MAX = 20;
const LINES = 5;
const ROUTE = 'plg-gatecontrol-notizen';
const OPEN = 't.done_at IS NULL AND t.deleted_at IS NULL AND t.parent_id IS NULL';

/** The open task rows of „Gestern offen geblieben“ of `userId` (with list_name, list_area), oldest reason first. */
async function rows(gc, userId, today, area) {
  const y = tz.addDays(today, -1);
  const a = area ? ' AND l.area = ?' : '';
  const args = (...x) => (area ? [...x, area] : x);
  const cols = 't.*, l.name AS list_name, l.area AS list_area';
  const due = await store.all(gc, `SELECT ${cols} FROM list_members m JOIN lists l ON l.id = m.list_id AND l.deleted_at IS NULL
    JOIN tasks t INDEXED BY idx_tasks_due ON t.list_id = m.list_id AND ${OPEN} AND t.due_date = ? WHERE m.user_id = ?${a} LIMIT 200`, args(y, userId));
  const missed = await store.all(gc, `SELECT ${cols} FROM tasks t INDEXED BY idx_tasks_missed JOIN list_members m ON m.list_id = t.list_id AND m.user_id = ?
    JOIN lists l ON l.id = t.list_id AND l.deleted_at IS NULL WHERE t.missed_at IS NOT NULL AND ${OPEN}${a} ORDER BY t.remind_at, t.id LIMIT 200`, args(userId));
  const who = await duty.of(gc, [...due, ...missed]);
  const picked = await store.all(gc, `SELECT ${cols} FROM my_day d JOIN tasks t ON t.id = d.task_id AND ${OPEN} JOIN lists l ON l.id = t.list_id AND l.deleted_at IS NULL
    JOIN list_members m ON m.list_id = t.list_id AND m.user_id = d.user_id WHERE d.user_id = ? AND d.day = ?${a}
    AND (t.due_date IS NULL OR t.due_date != ?) AND NOT EXISTS (SELECT 1 FROM my_day n WHERE n.user_id = d.user_id AND n.day = ? AND n.task_id = d.task_id)
    ORDER BY t.id LIMIT 200`, area ? [userId, y, area, today, today] : [userId, y, today, today]);
  const seen = new Set();
  const out = [];
  // what was due yesterday by its time (without one first), then in the order it was written
  due.sort((x, y) => (x.due_time || '').localeCompare(y.due_time || '') || x.id - y.id);
  for (const r of [...due.filter((x) => who.get(x.id) === userId), ...missed.filter((x) => who.get(x.id) === userId), ...picked]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/** The coming Saturday (on a Saturday: the Sunday). */
function weekend(today) {
  const wd = tz.weekday(today);
  return tz.addDays(today, wd === 6 ? 1 : (6 - wd + 7) % 7 || 7);
}

/** A target of „Verschieben“ → the date (invalid: before today or no date). */
function targetDate(ctx, to) {
  if (to === 'today') return ctx.today;
  if (to === 'tomorrow') return tz.addDays(ctx.today, 1);
  if (to === 'weekend') return weekend(ctx.today);
  if (isDate(to) && to >= ctx.today) return to;
  throw fail('invalid', { field: 'to' });
}

/** GET yesterday?area= → { day, title, count, items, moveOptions } */
async function get(gc, ctx, q = {}) {
  const area = q.area == null || q.area === '' ? null : areaOf(q.area);
  const list = await rows(gc, ctx.userId, ctx.today, area);
  return {
    day: tz.addDays(ctx.today, -1), title: t(ctx.lang, 'v.yesterday'), count: list.length, items: await tasks.views(gc, ctx, list),
    moveOptions: [{ to: 'tomorrow', date: tz.addDays(ctx.today, 1), label: t(ctx.lang, 'y.tomorrow') }, { to: 'weekend', date: weekend(ctx.today), label: t(ctx.lang, 'y.weekend') }],
  };
}

/**
 * Move row `r` (of tasks.access) to `date`: the due date goes there (the time stays), the reminder moves by as many days
 * — and does not ring again when that is over already. A task without a due date (only in „Mein Tag“ yesterday), or
 * with one still to come: `today` puts it into „Mein Tag“ of today; another day becomes its due date → whether anything changed.
 */
async function moveRow(gc, ctx, r, date) {
  if (r.my_role === 'read') throw tasks.readOnly();
  if (r.parent_id) throw fail('invalid', { field: 'id' });
  const marks = await store.run(gc, 'DELETE FROM my_day WHERE user_id = ? AND task_id = ? AND day < ?', [ctx.userId, r.id, ctx.today]);
  let changed = !!(marks && marks.changes);
  if (date === ctx.today && (!r.due_date || r.due_date > ctx.today)) {
    const ins = await store.run(gc, 'INSERT OR IGNORE INTO my_day (user_id, day, task_id) VALUES (?, ?, ?)', [ctx.userId, ctx.today, r.id]);
    changed = changed || !!(ins && ins.changes);
    if (r.missed_at) { await store.run(gc, 'UPDATE tasks SET missed_at = NULL WHERE id = ?', [r.id]); changed = true; }
  } else if (r.due_date !== date) {
    const days = r.due_date ? tz.diffDays(r.due_date, date) : 0;
    // a snoozed reminder goes back to the task's own time on the new day
    const base = r.remind_at && r.snoozed_at && r.due_at && r.due_time ? r.due_at : r.remind_at;
    const remind = base && r.due_date ? duty.shiftDays(base, days, ctx.tz) : r.remind_at;
    const twoWay = await tasks.linkedTwoWay(gc, r.list_id);
    await store.run(gc, `UPDATE tasks SET due_date = ?, due_at = ?, remind_at = ?, reminded_at = ?, snoozed_at = NULL, missed_at = NULL, updated_at = ?, ext_dirty = ? WHERE id = ?`,
      [date, tasks.dueAt(ctx, date, r.due_time), remind, remind == null ? null : remind <= ctx.now ? ctx.now : null, ctx.now, twoWay ? 1 : r.ext_dirty, r.id]);
    changed = true;
  } else if (r.missed_at) {
    await store.run(gc, 'UPDATE tasks SET missed_at = NULL WHERE id = ?', [r.id]);
    changed = true;
  }
  if (changed) events.changed(gc, await lists.memberIds(gc, r.list_id), 'tasks');
  return changed;
}

/** POST tasks/<id>/move { to } → { task } */
async function move(gc, ctx, id, b, opts) {
  const date = targetDate(ctx, b.to);
  const r = await tasks.access(gc, ctx, id);
  if (await moveRow(gc, ctx, r, date)) await calsync.now(gc, ctx, r.id);
  return tasks.get(gc, ctx, r.id, opts);
}

/** One action on some tasks of the card → { changed, failed: [{ id, code }] } (ids: only those that are part of it). */
async function act(gc, ctx, action, to, ids, opts) {
  const date = action === 'done' ? null : targetDate(ctx, action === 'today' ? 'today' : to);
  const mine = await rows(gc, ctx.userId, ctx.today, null);
  const want = ids ? new Set(ids) : null;
  let changed = 0;
  const failed = [];
  const moved = [];
  for (const row of mine) {
    if (want && !want.has(row.id)) continue;
    try {
      const r = await tasks.access(gc, ctx, row.id);
      if (action === 'done') {
        if (!(await tasks.mayComplete(gc, ctx, r))) throw tasks.readOnly();
        await tasks.complete(gc, ctx, r.id, { done: true }, opts);
        changed++;
      } else if (await moveRow(gc, ctx, r, date)) { changed++; moved.push(r.id); }
    } catch (e) {
      if (!(e && e.known)) throw e;
      failed.push({ id: row.id, code: e.code });
    }
  }
  if (moved.length) await calsync.now(gc, ctx, moved);
  return { changed, failed };
}

/** POST yesterday { action, to?, ids?, area? } → { changed, failed, yesterday } */
async function post(gc, ctx, b, opts) {
  if (!['done', 'today', 'move'].includes(b.action)) throw fail('invalid', { field: 'action' });
  let ids = null;
  if (b.ids !== undefined) {
    if (!Array.isArray(b.ids) || b.ids.length > 500 || !b.ids.every((x) => posInt(x))) throw fail('invalid', { field: 'ids' });
    ids = b.ids.map((x) => posInt(x));
  }
  const r = await act(gc, ctx, b.action, b.to, ids, opts);
  return { ...r, yesterday: await get(gc, ctx, { area: b.area }) };
}

/** A button of the morning push (hook notifyAction; ctx: the person who pressed it). */
async function onAction(gc, ctx, action, d, opts) {
  if (action !== 'done' && action !== 'today') return { ok: false, code: 'invalid' };
  const ids = Array.isArray(d && d.taskIds) ? d.taskIds.map((x) => posInt(x)).filter(Boolean).slice(0, IDS_MAX) : [];
  if (!ids.length) return { ok: false, code: 'invalid' };
  // „Erledigt“ as a callback is the push of one task; with several the app asks first (POST yesterday)
  if (action === 'done' && ids.length !== 1) return { ok: false, code: 'invalid' };
  return { ok: true, ...(await act(gc, ctx, action, 'today', ids, opts)) };
}

// ─── the push in the morning ────────────────────

let plan = null; // { day, at, users: Map(userId → { time, push }), done: Set(userId) }

function reset() { plan = null; }

/** Who may have something open from yesterday, with their time (asked every PLAN_MS; the marks of today from the table). */
async function build(gc, ctx) {
  const y = tz.addDays(ctx.today, -1);
  const cand = new Set();
  const due = await store.all(gc, `SELECT t.id, t.list_id, t.assignee_id, t.created_by FROM tasks t INDEXED BY idx_tasks_dueday WHERE t.due_date = ? AND ${OPEN} LIMIT 5000`, [y]);
  const missed = await store.all(gc, `SELECT t.id, t.list_id, t.assignee_id, t.created_by FROM tasks t INDEXED BY idx_tasks_missed WHERE t.missed_at IS NOT NULL AND ${OPEN} LIMIT 5000`);
  for (const u of (await duty.of(gc, [...due, ...missed])).values()) if (u) cand.add(u);
  for (const r of await store.all(gc, 'SELECT DISTINCT user_id FROM my_day INDEXED BY idx_my_day_day WHERE day = ?', [y])) cand.add(r.user_id);
  const users = new Map();
  for (const u of cand) {
    const p = await prefs.get(gc, u);
    users.set(u, { time: p.yesterdayAt, push: p.notify.yesterday !== false });
  }
  const done = new Set();
  for (const part of store.chunks([...cand])) {
    if (!part.length) continue;
    for (const r of await store.all(gc, `SELECT user_id FROM yesterday_sent WHERE day = ? AND user_id IN (${store.marks(part.length)})`, [ctx.today, ...part])) done.add(r.user_id);
  }
  return { day: ctx.today, at: ctx.now, users, done };
}

/** The message of the push for these rows. */
function message(lang, list, day) {
  const n = list.length;
  const lines = list.slice(0, LINES).map((r) => `${r.title.slice(0, 80)} · ${r.list_name}`);
  if (n > LINES) lines.push(t(lang, 'n.y_more', { n: n - LINES }));
  const open = (id, label) => ({ type: 'open_app_route', id, label, target: ROUTE });
  const cb = (id, label) => ({ type: 'callback', id, label });
  return {
    topic: 'reminders', title: (n === 1 ? t(lang, 'v.yesterday') : t(lang, 'n.y_title', { n })).slice(0, 120), body: lines.join('\n').slice(0, 1000), priority: 'normal', collapseKey: 'yesterday',
    data: {
      notizen: { kind: 'yesterday', day, count: n, taskIds: list.slice(0, IDS_MAX).map((r) => r.id), area: null },
      actions: [n === 1 ? cb('done', t(lang, 'n.b_done')) : open('done_ask', t(lang, 'n.b_done')), cb('today', t(lang, 'n.b_today')), open('move', t(lang, 'n.b_move'))],
    },
  };
}

/** The background run: the morning hint of everybody whose time has come → how many went out. */
async function tick(gc, ctx) {
  if (!plan || plan.day !== ctx.today || ctx.now - plan.at > PLAN_MS || ctx.now < plan.at) plan = await build(gc, ctx);
  const cfg = await config.get(gc);
  let sent = 0;
  for (const [u, p] of plan.users) {
    if (plan.done.has(u) || ctx.time < p.time) continue;
    plan.done.add(u);
    await store.run(gc, 'INSERT INTO yesterday_sent (user_id, day, at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET day = excluded.day, at = excluded.at', [u, ctx.today, ctx.now]);
    if (!p.push || ctx.now - tz.at(ctx.today, tz.parseTime(p.time), ctx.tz) > LATE_MAX) continue;
    const list = await rows(gc, u, ctx.today, null);
    if (!list.length) continue;
    if (await pushprefs.send(gc, [u], 'yesterday', message(cfg.notify_lang, list, tz.addDays(ctx.today, -1)))) sent++;
  }
  return sent;
}

module.exports = { LATE_MAX, rows, get, move, moveRow, post, act, onAction, tick, reset, weekend, targetDate, message };
