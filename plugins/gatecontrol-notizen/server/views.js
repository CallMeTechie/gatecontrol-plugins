'use strict';

// The screens of the tasks side (mockups Main, Listen, Windows): „Mein Tag“, Wichtig, Geplant, Mir zugewiesen, a list,
// a source — own tasks and the items of the other plugins in one shape (Task: tasks.view, Item: sources.view), in
// sections. And the counts of the menu (GET nav). Every query goes through an index (migrations/001_init.sql).

const store = require('./store');
const tz = require('./tz');
const tasks = require('./tasks');
const lists = require('./lists');
const sources = require('./sources');
const prefsMod = require('./prefs');
const { t } = require('./text');
const { fail, area: areaOf } = require('./util');

const MAX = 500;
const UPCOMING_DAYS = 14; // mockup Main: on Sunday the 8th „Demnächst“ shows Monday the 16th

const JOIN_LISTS = `FROM list_members m JOIN lists l ON l.id = m.list_id AND l.deleted_at IS NULL AND l.area = ?`;
const OPEN = 't.done_at IS NULL AND t.deleted_at IS NULL AND t.parent_id IS NULL';

function labels(lang) { return (plugin) => t(lang, 'src.' + plugin); }

/** Own open tasks due up to `until` (idx_tasks_due). */
function dueUntil(gc, ctx, area, until) {
  return store.all(gc, `SELECT t.* ${JOIN_LISTS} JOIN tasks t INDEXED BY idx_tasks_due ON t.list_id = m.list_id AND ${OPEN} AND t.due_date IS NOT NULL AND t.due_date <= ?
    WHERE m.user_id = ? ORDER BY t.due_date, t.due_time, t.position LIMIT ${MAX}`, [area, until, ctx.userId]);
}

function sortKey(x) {
  const d = x.show || x.due;
  return (d ? d.date + ' ' + (d.time || '99:99') : '9999') + ' ' + String(x.title).toLowerCase();
}
const byTime = (a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0);

async function srcItems(gc, ctx, prefs, area, opts = {}) {
  const lab = labels(ctx.lang);
  return (await sources.visible(gc, ctx, prefs, { area, ...opts })).map((x) => sources.view(ctx, x, prefs, lab));
}

function section(ctx, id, items, extra) {
  return { id, title: t(ctx.lang, 'v.' + id), count: items.length, items, ...(extra || {}) };
}

function startOfToday(ctx) { return tz.at(ctx.today, { hh: 0, mm: 0 }, ctx.tz); }

/** „Mein Tag“: Termine heute, Überfällig, Heute, Demnächst, Erledigt heute. */
async function myDay(gc, ctx, area) {
  const prefs = await prefsMod.get(gc, ctx.userId);
  const soon = tz.addDays(ctx.today, UPCOMING_DAYS);
  const due = await dueUntil(gc, ctx, area, soon);
  const picked = await store.all(gc, `SELECT t.* FROM my_day d JOIN tasks t ON t.id = d.task_id AND ${OPEN}
    JOIN lists l ON l.id = t.list_id AND l.deleted_at IS NULL AND l.area = ? JOIN list_members m ON m.list_id = t.list_id AND m.user_id = d.user_id
    WHERE d.user_id = ? AND d.day = ? LIMIT ${MAX}`, [area, ctx.userId, ctx.today]);
  const doneRows = await store.all(gc, `SELECT t.* ${JOIN_LISTS} JOIN tasks t INDEXED BY idx_tasks_done ON t.list_id = m.list_id AND t.done_at IS NOT NULL AND t.done_at >= ?
    AND t.deleted_at IS NULL AND t.parent_id IS NULL WHERE m.user_id = ? ORDER BY t.done_at DESC LIMIT 100`, [area, startOfToday(ctx), ctx.userId]);
  const seen = new Set();
  const rows = [];
  for (const r of [...due, ...picked, ...doneRows]) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
  const all = await tasks.views(gc, ctx, rows);
  const pickedIds = new Set(picked.map((r) => r.id));
  const out = { events: [], overdue: [], today: [], upcoming: [], done: [] };
  for (const x of all) {
    if (x.done) { out.done.push(x); continue; }
    if (x.overdue) out.overdue.push(x);
    else if ((x.due && x.due.date <= ctx.today) || pickedIds.has(x.id)) out.today.push(x);
    else out.upcoming.push(x);
  }
  const fam = prefs.sources['gatecontrol-familie'] || {};
  for (const x of await srcItems(gc, ctx, prefs, area)) {
    if (x.done) { if ((x.doneAt || 0) >= startOfToday(ctx)) out.done.push(x); continue; }
    if (!x.show) continue;
    if (x.meta && x.meta.type === 'shopping' && fam.shoppingInMyDay !== true) continue;
    if (x.kind === 'event' && x.show.date === ctx.today) out.events.push(x);
    else if (x.overdue) out.overdue.push(x);
    else if (x.show.date === ctx.today) out.today.push(x);
    else if (x.show.date <= soon && x.kind !== 'event') out.upcoming.push(x);
  }
  out.done = out.done.slice(0, 100);
  for (const k of Object.keys(out)) if (k !== 'today') out[k].sort(byTime);
  out.today.sort((a, b) => (a.due && a.due.time ? 0 : 1) - (b.due && b.due.time ? 0 : 1) || byTime(a, b) || (a.position || 0) - (b.position || 0));
  out.upcoming = out.upcoming.slice(0, 20);
  return {
    view: 'myday', title: t(ctx.lang, 'v.myday'), date: ctx.today,
    sections: [section(ctx, 'events', out.events), section(ctx, 'overdue', out.overdue), section(ctx, 'today', out.today),
      section(ctx, 'upcoming', out.upcoming), section(ctx, 'done', out.done, { collapsed: true })],
  };
}

async function important(gc, ctx, area) {
  const prefs = await prefsMod.get(gc, ctx.userId);
  const rows = await store.all(gc, `SELECT t.* ${JOIN_LISTS} JOIN tasks t INDEXED BY idx_tasks_important ON t.list_id = m.list_id AND t.important = 1 AND ${OPEN}
    WHERE m.user_id = ? ORDER BY t.due_date IS NULL, t.due_date, t.position LIMIT ${MAX}`, [area, ctx.userId]);
  const items = [...await tasks.views(gc, ctx, rows), ...(await srcItems(gc, ctx, prefs, area)).filter((x) => x.important && !x.done)];
  return { view: 'important', title: t(ctx.lang, 'v.important'), sections: [section(ctx, 'important', items)] };
}

async function planned(gc, ctx, area) {
  const prefs = await prefsMod.get(gc, ctx.userId);
  const rows = await dueUntil(gc, ctx, area, '9999-12-31');
  const items = [...await tasks.views(gc, ctx, rows), ...(await srcItems(gc, ctx, prefs, area)).filter((x) => x.show && !x.done)];
  const tomorrow = tz.addDays(ctx.today, 1);
  const week = tz.addDays(ctx.today, 7);
  const g = { overdue: [], today: [], tomorrow: [], week: [], later: [] };
  for (const x of items) {
    const d = (x.show || x.due).date;
    if (x.overdue) g.overdue.push(x);
    else if (d <= ctx.today) g.today.push(x);
    else if (d === tomorrow) g.tomorrow.push(x);
    else if (d <= week) g.week.push(x);
    else g.later.push(x);
  }
  return { view: 'planned', title: t(ctx.lang, 'v.planned'), sections: Object.keys(g).map((k) => section(ctx, k, g[k].sort(byTime))) };
}

async function assigned(gc, ctx, area) {
  const prefs = await prefsMod.get(gc, ctx.userId);
  const rows = await store.all(gc, `SELECT t.* FROM tasks t INDEXED BY idx_tasks_assignee JOIN lists l ON l.id = t.list_id AND l.deleted_at IS NULL AND l.area = ?
    JOIN list_members m ON m.list_id = t.list_id AND m.user_id = ? WHERE t.assignee_id = ? AND ${OPEN} ORDER BY t.due_date IS NULL, t.due_date, t.position LIMIT ${MAX}`, [area, ctx.userId, ctx.userId]);
  const items = [...await tasks.views(gc, ctx, rows), ...(await srcItems(gc, ctx, prefs, area)).filter((x) => !x.done && x.assignee && x.assignee.id === ctx.userId)];
  return { view: 'assigned', title: t(ctx.lang, 'v.assigned'), sections: [section(ctx, 'assigned', items.sort(byTime))] };
}

/** A list: its open tasks in their order, the done ones folded (the last 100). */
async function list(gc, ctx, id) {
  const l = await lists.access(gc, ctx.userId, id);
  const open = await store.all(gc, `SELECT * FROM tasks INDEXED BY idx_tasks_list WHERE list_id = ? AND done_at IS NULL AND deleted_at IS NULL AND parent_id IS NULL
    ORDER BY position, id LIMIT 2000`, [l.id]);
  const done = await store.all(gc, `SELECT * FROM tasks INDEXED BY idx_tasks_done WHERE list_id = ? AND done_at IS NOT NULL AND deleted_at IS NULL AND parent_id IS NULL
    ORDER BY done_at DESC LIMIT 100`, [l.id]);
  const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM tasks INDEXED BY idx_tasks_done WHERE list_id = ? AND done_at IS NOT NULL AND deleted_at IS NULL AND parent_id IS NULL', [l.id]);
  return {
    view: 'list', title: l.name, list: await lists.view(gc, l),
    sections: [section(ctx, 'open', await tasks.views(gc, ctx, open)), section(ctx, 'done', await tasks.views(gc, ctx, done), { collapsed: true, count: n.n })],
  };
}

/** A source: everything the person sees of it, by its groups (Mail accounts, children …). */
async function source(gc, ctx, plugin, area) {
  if (!sources.SOURCES.includes(plugin)) throw fail('not_found');
  const prefs = await prefsMod.get(gc, ctx.userId);
  const items = (await srcItems(gc, ctx, prefs, area, { plugin, withCarried: false })).filter((x) => !x.done).sort(byTime);
  const groups = new Map();
  for (const x of items) {
    const k = x.group ? x.group.id : '';
    if (!groups.has(k)) groups.set(k, { id: k ? 'g:' + k : 'all', title: x.group ? x.group.label : t(ctx.lang, 'src.' + plugin), count: 0, items: [] });
    const g = groups.get(k);
    g.items.push(x);
    g.count++;
  }
  return { view: 'source', title: t(ctx.lang, 'src.' + plugin), plugin, sections: [...groups.values()] };
}

/** GET views/<name>?area= */
async function get(gc, ctx, name, q) {
  const area = areaOf(q.area);
  if (name === 'myday') return myDay(gc, ctx, area);
  if (name === 'important') return important(gc, ctx, area);
  if (name === 'planned') return planned(gc, ctx, area);
  if (name === 'assigned') return assigned(gc, ctx, area);
  if (/^list:\d+$/.test(name)) return list(gc, ctx, name.slice(5));
  if (/^source:gatecontrol-[a-z]+$/.test(name)) return source(gc, ctx, name.slice(7), area);
  throw fail('not_found');
}

/** GET nav?area= — the counts of the menu. */
async function nav(gc, ctx, q, notesNav) {
  const area = areaOf(q.area);
  const prefs = await prefsMod.get(gc, ctx.userId);
  const md = await myDay(gc, ctx, area);
  const count = (v, ids) => v.sections.filter((s) => ids.includes(s.id)).reduce((n, s) => n + s.items.filter((x) => !x.done).length, 0);
  const imp = await store.one(gc, `SELECT COUNT(*) AS n ${JOIN_LISTS} JOIN tasks t INDEXED BY idx_tasks_important ON t.list_id = m.list_id AND t.important = 1 AND ${OPEN} WHERE m.user_id = ?`, [area, ctx.userId]);
  const pl = await store.one(gc, `SELECT COUNT(*) AS n ${JOIN_LISTS} JOIN tasks t INDEXED BY idx_tasks_due ON t.list_id = m.list_id AND ${OPEN} AND t.due_date IS NOT NULL WHERE m.user_id = ?`, [area, ctx.userId]);
  const as = await store.one(gc, `SELECT COUNT(*) AS n FROM tasks t INDEXED BY idx_tasks_assignee JOIN lists l ON l.id = t.list_id AND l.deleted_at IS NULL AND l.area = ?
    JOIN list_members m ON m.list_id = t.list_id AND m.user_id = ? WHERE t.assignee_id = ? AND ${OPEN}`, [area, ctx.userId, ctx.userId]);
  const src = await srcItems(gc, ctx, prefs, area);
  const open = src.filter((x) => !x.done);
  const bySource = {};
  for (const p of sources.SOURCES) bySource[p] = 0;
  for (const x of open) bySource[x.source.plugin]++;
  const status = await sources.status(gc, ctx);
  const ls = await lists.all(gc, ctx, area);
  return {
    area,
    smart: {
      myday: count(md, ['events', 'overdue', 'today']),
      important: imp.n + open.filter((x) => x.important).length,
      planned: pl.n + open.filter((x) => x.show).length,
      assigned: as.n + open.filter((x) => x.assignee && x.assignee.id === ctx.userId).length,
    },
    sources: status.filter((s) => s.enabled && s.available && !(prefs.sources[s.plugin] && prefs.sources[s.plugin].on === false))
      .map((s) => ({ plugin: s.plugin, label: t(ctx.lang, 'src.' + s.plugin), hint: t(ctx.lang, 'srch.' + s.plugin), open: bySource[s.plugin] })),
    lists: ls.lists, groups: ls.groups,
    notes: notesNav ? await notesNav(gc, ctx, area) : null,
  };
}

module.exports = { get, nav, myDay };
