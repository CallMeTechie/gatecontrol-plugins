'use strict';

// Own tasks: create (also from a line in plain language, ui/quickparse.js), change, complete (repeat rules,
// ui/repeat.js; a task that carries a source item completes it there), sub tasks, „Mein Tag“, delete (30 days in the
// trash). Every change is in the search index and tells the list's members (events `changed` { what: ['tasks'] }).

const store = require('./store');
const tz = require('./tz');
const lists = require('./lists');
const people = require('./people');
const events = require('./events');
const fts = require('./fts');
const clientIds = require('./clientids');
const push = require('./push');
const pushprefs = require('./pushprefs');
const R = require('../ui/repeat');
const Q = require('../ui/quickparse');
const { t } = require('./text');
const { fail, posInt, line, text, isDate, isTime, parse, bool, same, stale } = require('./util');

const TITLE_MAX = 300;
const NOTE_MAX = 20000;
const SUBTASKS_MAX = 100;

/** ms of a due date (and time; all day: 23:59) in the hub's zone. */
function dueAt(ctx, date, time) {
  if (!date) return null;
  const tm = tz.parseTime(time || '23:59');
  return tz.at(date, tm, ctx.tz);
}

/** The ISO time of ms in the hub's zone with its offset (2026-11-09T09:00:00+01:00). */
function iso(ctx, ms) {
  if (ms == null) return null;
  const p = tz.parts(ms, ctx.tz);
  const off = Math.round(tz.offset(ms, ctx.tz) / 60000);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${tz.dateStr(p.y, p.m, p.d)}T${tz.pad(p.hh)}:${tz.pad(p.mm)}:${tz.pad(p.ss)}${sign}${tz.pad(Math.floor(a / 60))}:${tz.pad(a % 60)}`;
}

/** A reminder as given: an ISO time, { date, time } in the hub's zone, or null. */
function remindArg(ctx, v) {
  if (v === null) return null;
  if (typeof v === 'string') { const ms = Date.parse(v); if (!Number.isFinite(ms) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) throw fail('invalid', { field: 'remindAt' }); return ms; }
  if (v && typeof v === 'object' && isDate(v.date) && isTime(v.time)) return tz.at(v.date, tz.parseTime(v.time), ctx.tz);
  throw fail('invalid', { field: 'remindAt' });
}

function dueArg(v) {
  if (v === null) return { date: null, time: null };
  if (!v || typeof v !== 'object' || !isDate(v.date) || (v.time != null && !isTime(v.time))) throw fail('invalid', { field: 'due' });
  return { date: v.date, time: v.time || null };
}

/** A month or year rule keeps the day it started on (31st → 28th in February → 31st in March). */
function anchor(rule, date) {
  if (!rule || !date) return rule;
  if ((rule.type === 'monthly' || rule.type === 'yearly') && !rule.day) rule.day = Number(date.slice(8, 10));
  if (rule.type === 'yearly' && !rule.month) rule.month = Number(date.slice(5, 7));
  return rule;
}

function repeatArg(v) {
  if (v === null) return null;
  const r = R.normalize(v);
  if (!r) throw fail('invalid', { field: 'repeat' });
  return r;
}

/** A task row → the API's Task (without sub tasks; see get()). */
function view(ctx, r, extra = {}) {
  const repeat = parse(r.repeat_json, null);
  const overdue = !r.done_at && !!r.due_date && (r.due_time ? r.due_at < ctx.now : r.due_date < ctx.today);
  return {
    uid: 't:' + r.id, type: 'task', id: r.id, listId: r.list_id, parentId: r.parent_id || null, title: r.title,
    note: extra.full ? r.note : undefined, hasNote: !!(r.note && r.note.trim()),
    important: !!r.important, done: !!r.done_at, doneAt: r.done_at ? iso(ctx, r.done_at) : null,
    due: r.due_date ? { date: r.due_date, time: r.due_time || null } : null, overdue,
    remindAt: r.remind_at ? iso(ctx, r.remind_at) : null, repeat, repeatText: repeat ? R.describe(repeat, ctx.lang) : null,
    assignee: r.assignee_id ? { id: r.assignee_id, name: extra.names ? extra.names.get(r.assignee_id) || null : null } : null,
    myDay: extra.myDay ? extra.myDay.has(r.id) : false,
    progress: extra.progress && extra.progress.get(r.id) ? extra.progress.get(r.id) : null,
    attachments: extra.attachments ? extra.attachments.get(r.id) || 0 : undefined,
    source: r.src_plugin ? { plugin: r.src_plugin, id: r.src_id } : null,
    noteId: r.note_id || null, position: r.position,
    // 1.2.0: a member who may only look completes only what is assigned to them (README "Roles")
    canEdit: !extra.roles || extra.roles.get(r.list_id) !== 'read',
    canComplete: !extra.roles || extra.roles.get(r.list_id) !== 'read' || r.assignee_id === ctx.userId || (!!r.parent_id && !!extra.parentMine && extra.parentMine.has(r.parent_id)),
    updatedAt: r.updated_at,
  };
}

/** Sub task counts, „Mein Tag“ marks, names and attachment counts for a page of task rows. */
async function extras(gc, ctx, rows) {
  const ids = rows.map((r) => r.id);
  const progress = new Map();
  const myDay = new Set();
  const attachments = new Map();
  for (const part of store.chunks(ids)) {
    if (!part.length) continue;
    const m = store.marks(part.length);
    for (const p of await store.all(gc, `SELECT parent_id, COUNT(*) AS n, SUM(CASE WHEN done_at IS NULL THEN 0 ELSE 1 END) AS d FROM tasks INDEXED BY idx_tasks_parent
      WHERE parent_id IN (${m}) AND deleted_at IS NULL GROUP BY parent_id`, part)) progress.set(p.parent_id, { done: p.d || 0, total: p.n });
    for (const d of await store.all(gc, `SELECT task_id FROM my_day WHERE user_id = ? AND day = ? AND task_id IN (${m})`, [ctx.userId, ctx.today, ...part])) myDay.add(d.task_id);
    for (const a of await store.all(gc, `SELECT ref_id, COUNT(*) AS n FROM attachments WHERE kind = 'task' AND ref_id IN (${m}) GROUP BY ref_id`, part)) attachments.set(a.ref_id, a.n);
  }
  const names = new Map();
  for (const r of rows) if (r.assignee_id && !names.has(r.assignee_id)) names.set(r.assignee_id, await people.name(gc, r.assignee_id));
  // my role per list (read: canEdit false) and, for sub tasks of read lists, whether their task is mine
  const roles = new Map();
  for (const part of store.chunks([...new Set(rows.map((r) => r.list_id))])) {
    if (!part.length) continue;
    for (const m of await store.all(gc, `SELECT list_id, role FROM list_members WHERE user_id = ? AND list_id IN (${store.marks(part.length)})`, [ctx.userId, ...part])) roles.set(m.list_id, m.role);
  }
  const parentMine = new Set();
  const subs = [...new Set(rows.filter((r) => r.parent_id && roles.get(r.list_id) === 'read').map((r) => r.parent_id))];
  for (const part of store.chunks(subs)) {
    if (!part.length) continue;
    for (const p of await store.all(gc, `SELECT id FROM tasks WHERE id IN (${store.marks(part.length)}) AND assignee_id = ?`, [...part, ctx.userId])) parentMine.add(p.id);
  }
  return { progress, myDay, attachments, names, roles, parentMine };
}

async function views(gc, ctx, rows) {
  const x = await extras(gc, ctx, rows);
  return rows.map((r) => view(ctx, r, x));
}

/** The task `id` as `ctx.userId` may change it → the row with my_role (not_found otherwise). */
async function access(gc, ctx, id) {
  const tid = posInt(id);
  if (!tid) throw fail('not_found');
  const r = await store.one(gc, `SELECT t.*, m.role AS my_role FROM tasks t JOIN list_members m ON m.list_id = t.list_id AND m.user_id = ?
    JOIN lists l ON l.id = t.list_id AND l.deleted_at IS NULL WHERE t.id = ? AND t.deleted_at IS NULL`, [ctx.userId, tid]);
  if (!r) throw fail('not_found');
  return r;
}

/** May the person complete this task (row of access)? A read member: only what is assigned to them (or its sub tasks). */
async function mayComplete(gc, ctx, r) {
  if (r.my_role !== 'read') return true;
  if (r.assignee_id === ctx.userId) return true;
  if (!r.parent_id) return false;
  const p = await store.one(gc, 'SELECT assignee_id FROM tasks WHERE id = ?', [r.parent_id]);
  return !!(p && p.assignee_id === ctx.userId);
}
const readOnly = () => fail('forbidden', { reason: 'read_only' });

async function linkedTwoWay(gc, listId) {
  const l = await store.one(gc, 'SELECT id FROM ext_links WHERE list_id = ? AND two_way = 1', [listId]);
  return !!l;
}

async function assigneeArg(gc, listId, v) {
  if (v === null) return null;
  const u = posInt(v);
  if (!u) throw fail('invalid', { field: 'assigneeId' });
  const m = await store.one(gc, 'SELECT 1 AS x FROM list_members WHERE list_id = ? AND user_id = ?', [listId, u]);
  if (!m) throw fail('not_member', { field: 'assigneeId' });
  return u;
}

/** A line in plain language → the fields of a new task (ui/quickparse.js with the person's lists and people). */
async function fromText(gc, ctx, s, area) {
  const ls = (await lists.all(gc, ctx, area)).lists.filter((l) => l.canEdit);
  const ps = await people.pickable(gc, ctx.userId);
  const p = Q.parse(s, { today: ctx.today, now: ctx.time, lists: ls.map((l) => ({ id: l.id, name: l.name })), people: ps.map((u) => ({ id: u.id, name: u.name })) });
  return p;
}

/** A create sent again with the same clientId (clientids.js): the task as it is now, or 410 when it is gone. */
async function replay(gc, ctx, id, clientId) {
  let r;
  try { r = await access(gc, ctx, id); } catch (e) { if (e && e.code === 'not_found') throw clientIds.gone(clientId, id); throw e; }
  return { task: (await views(gc, ctx, [r]))[0], clientId, replayed: true };
}

/**
 * POST tasks { title | text, listId?, area?, note?, important?, due?: { date, time? } | null, remindAt?, repeat?,
 * assigneeId?, myDay?, parentId?, source?: { plugin, id }, clientId?, listClientId?, parentClientId? } → { task, parsed?, clientId? }
 */
async function create(gc, ctx, b0, opts = {}) {
  const cid = clientIds.arg(b0.clientId);
  if (cid) { const have = await clientIds.find(gc, ctx.userId, cid, 'task'); if (have) return replay(gc, ctx, have, cid); }
  const b = { ...b0 };
  // a list or a parent made offline as well, named by its clientId
  if (b.listId == null && b.listClientId != null) b.listId = await clientIds.resolve(gc, ctx, b.listClientId, 'list', 'listClientId');
  if (b.parentId == null && b.parentClientId != null) b.parentId = await clientIds.resolve(gc, ctx, b.parentClientId, 'task', 'parentClientId');
  let fields = { ...b };
  let parsed = null;
  if (typeof b.text === 'string' && !b.title) {
    parsed = await fromText(gc, ctx, b.text, b.area);
    fields = {
      ...b, title: parsed.title || line(b.text, TITLE_MAX), important: b.important || parsed.important,
      due: b.due !== undefined ? b.due : parsed.date ? { date: parsed.date, time: parsed.time } : undefined,
      remindAt: b.remindAt !== undefined ? b.remindAt : parsed.remind || undefined,
      repeat: b.repeat !== undefined ? b.repeat : parsed.repeat || undefined,
      listId: b.listId || (parsed.list ? parsed.list.id : undefined),
      assigneeId: b.assigneeId !== undefined ? b.assigneeId : parsed.assignee ? parsed.assignee.id : undefined,
    };
    if (!fields.listId && parsed.listName && b.createList === true) {
      const made = await lists.create(gc, ctx, { name: parsed.listName, area: b.area });
      fields.listId = made.list.id;
    }
  }
  const title = line(fields.title, TITLE_MAX);
  if (!title) throw fail('invalid', { field: 'title' });
  let parent = null;
  let listId;
  if (fields.parentId != null) {
    parent = await access(gc, ctx, fields.parentId);
    if (parent.my_role === 'read') throw readOnly();
    if (parent.parent_id) throw fail('invalid', { field: 'parentId' });
    const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND deleted_at IS NULL', [parent.id]);
    if (n.n >= SUBTASKS_MAX) throw fail('too_many');
    listId = parent.list_id;
  } else if (fields.listId != null) {
    listId = lists.writable(await lists.access(gc, ctx.userId, fields.listId)).id;
  } else {
    listId = await lists.ensureDefault(gc, ctx, fields.area);
  }
  const due = fields.due !== undefined && !parent ? dueArg(fields.due) : { date: null, time: null };
  const remindAt = fields.remindAt !== undefined && !parent ? remindArg(ctx, fields.remindAt) : null;
  const repeat = fields.repeat !== undefined && !parent ? repeatArg(fields.repeat) : null;
  if (repeat && !due.date) due.date = R.first(repeat, ctx.today);
  anchor(repeat, due.date);
  let assignee = null;
  if (fields.assigneeId !== undefined && fields.assigneeId !== null && !parent) {
    // a person written in the quick entry who is not in the list: the task stays unassigned
    try { assignee = await assigneeArg(gc, listId, fields.assigneeId); } catch (e) { if (!parsed || b.assigneeId !== undefined) throw e; }
  }
  const note = fields.note !== undefined ? text(fields.note, NOTE_MAX) : '';
  let src = null;
  if (fields.source && !parent) src = await opts.sourceOf(gc, ctx, fields.source);
  const twoWay = await linkedTwoWay(gc, listId);
  const made = await store.tx(gc, async () => {
    // the same create raced in meanwhile (two sends of an outbox): it made the task already
    if (cid) { const again = await clientIds.find(gc, ctx.userId, cid, 'task'); if (again) return { dup: again }; }
    const pos = parent
      ? await store.one(gc, 'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE parent_id = ? AND deleted_at IS NULL', [parent.id])
      : await store.one(gc, 'SELECT COALESCE(MIN(position), 0) - 1 AS p FROM tasks INDEXED BY idx_tasks_list WHERE list_id = ? AND done_at IS NULL AND deleted_at IS NULL AND parent_id IS NULL', [listId]);
    const r = await store.run(gc, `INSERT INTO tasks (list_id, parent_id, title, note, important, due_date, due_time, due_at, remind_at, repeat_json, assignee_id,
      position, src_plugin, src_id, note_id, ext_id, ext_at, ext_dirty, created_by, created_at, updated_at, done_at, done_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [listId, parent ? parent.id : null, title, note, fields.important ? 1 : 0, due.date, due.time, dueAt(ctx, due.date, due.time),
      remindAt, repeat ? JSON.stringify(repeat) : null, assignee, pos.p, src ? src.plugin : null, src ? src.id : null,
      posInt(fields.noteId) || null, opts.extId || null, opts.extAt || null, twoWay && !opts.extId ? 1 : 0, ctx.userId, opts.createdAt || ctx.now, ctx.now,
      opts.doneAt || null, opts.doneAt ? ctx.userId : null]);
    const tid = Number(r.lastInsertRowid);
    if (bool(fields.myDay) && !parent) await store.run(gc, 'INSERT OR IGNORE INTO my_day (user_id, day, task_id) VALUES (?, ?, ?)', [ctx.userId, ctx.today, tid]);
    await fts.setTask(gc, tid, title, note);
    await clientIds.claim(gc, ctx, cid, 'task', tid);
    return { id: tid };
  });
  if (made.dup) return replay(gc, ctx, made.dup, cid);
  const id = made.id;
  if (parent && twoWay) await store.run(gc, 'UPDATE tasks SET ext_dirty = 1 WHERE id = ? AND ext_id IS NOT NULL', [parent.id]);
  const members = await lists.memberIds(gc, listId);
  events.changed(gc, members, 'tasks');
  if (assignee && assignee !== ctx.userId) await notifyAssigned(gc, ctx, assignee, title, id);
  const row = await store.one(gc, 'SELECT * FROM tasks WHERE id = ?', [id]);
  return { task: (await views(gc, ctx, [row]))[0], ...(parsed ? { parsed } : {}), ...(cid ? { clientId: cid } : {}) };
}

async function notifyAssigned(gc, ctx, userId, title, id) {
  const l = await store.one(gc, 'SELECT l.id, l.area FROM tasks t JOIN lists l ON l.id = t.list_id WHERE t.id = ?', [id]);
  await pushprefs.send(gc, [userId], 'shared', { topic: 'shared', title: t(ctx.notifyLang, 'n.assigned_title', { name: ctx.userName || '' }), body: title,
    collapseKey: 'task:' + id, data: { notizen: push.assigned(id, l ? l.id : null, l ? l.area : null) } });
}

/** GET tasks/<id> → { task (with note, subtasks, attachments, list) } */
async function get(gc, ctx, id, opts = {}) {
  const r = await access(gc, ctx, id);
  const x = await extras(gc, ctx, [r]);
  const task = view(ctx, r, { ...x, full: true });
  const subs = await store.all(gc, 'SELECT * FROM tasks INDEXED BY idx_tasks_parent WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position, id', [r.id]);
  task.subtasks = subs.map((s) => ({ id: s.id, title: s.title, done: !!s.done_at }));
  const l = await lists.access(gc, ctx.userId, r.list_id);
  task.list = { id: l.id, name: l.name, area: l.area };
  task.attachmentList = opts.attachments ? await opts.attachments(gc, ctx, 'task', r.id) : [];
  if (r.src_plugin && opts.sourceItem) task.sourceItem = await opts.sourceItem(gc, ctx, r.src_plugin, r.src_id);
  return { task };
}

/** The fields PATCH tasks takes, each in one form to compare (norm) — a sub task has no date, reminder, repeat, person or list of its own. */
const FIELDS = ['title', 'note', 'important', 'due', 'remindAt', 'repeat', 'assigneeId', 'listId', 'position', 'myDay'];
const OWN = ['due', 'remindAt', 'repeat', 'assigneeId', 'listId', 'myDay'];

/**
 * PATCH tasks/<id> { title?, note?, important?, due?, remindAt?, repeat?, assigneeId?, listId?, position?, myDay?, base? }
 * — `base` (1.1.0): the values the device saw before it changed them; a field someone changed meanwhile to something
 * else → 409 conflict { fields, task }. Without `base` the change wins (as in 1.0). A field set to what it is already
 * is not written (a change sent twice does nothing the second time: no new reminder, no push, no event).
 */
async function update(gc, ctx, id, b) {
  const r = await access(gc, ctx, id);
  const sub = !!r.parent_id;
  const myDayNow = !!(await store.one(gc, 'SELECT 1 AS x FROM my_day WHERE user_id = ? AND day = ? AND task_id = ?', [ctx.userId, ctx.today, r.id]));
  const dueDate = (b.due && typeof b.due === 'object' && b.due.date) || r.due_date || ctx.today;
  const norm = (f, v) => {
    switch (f) {
      case 'title': { const x = line(v, TITLE_MAX); if (!x) throw fail('invalid', { field: 'title' }); return x; }
      case 'note': return text(v, NOTE_MAX);
      case 'important': return !!v;
      case 'due': return dueArg(v);
      case 'remindAt': return remindArg(ctx, v);
      case 'repeat': return v === null ? null : anchor(repeatArg(v), dueDate);
      case 'assigneeId': if (v === null) return null; if (!posInt(v)) throw fail('invalid', { field: 'assigneeId' }); return posInt(v);
      case 'listId': if (!posInt(v)) throw fail('not_found'); return posInt(v);
      case 'position': if (typeof v !== 'number' || !Number.isFinite(v)) throw fail('invalid', { field: 'position' }); return v;
      case 'myDay': return bool(v);
      default: return v;
    }
  };
  const now = {
    title: r.title, note: r.note, important: !!r.important, due: { date: r.due_date || null, time: r.due_time || null }, remindAt: r.remind_at || null,
    repeat: parse(r.repeat_json, null), assigneeId: r.assignee_id || null, listId: r.list_id, position: r.position, myDay: myDayNow,
  };
  const next = {};
  for (const f of FIELDS) if (b[f] !== undefined && !(sub && OWN.includes(f))) next[f] = norm(f, b[f]);
  const late = stale(b.base, now, next, norm);
  if (late.length) throw fail('conflict', { fields: late, task: (await views(gc, ctx, [r]))[0] });
  // only what changes is written
  for (const f of Object.keys(next)) if (same(next[f], now[f])) delete next[f];
  if (!Object.keys(next).length) return get(gc, ctx, r.id);
  // a member who may only look: only their own „Mein Tag“ mark
  if (r.my_role === 'read' && Object.keys(next).some((f) => f !== 'myDay')) throw readOnly();

  const set = [];
  const args = [];
  const put = (col, v) => { set.push(col + ' = ?'); args.push(v); };
  const title = next.title !== undefined ? next.title : r.title;
  const note = next.note !== undefined ? next.note : r.note;
  if (next.title !== undefined) put('title', title);
  if (next.note !== undefined) put('note', note);
  if (next.important !== undefined) put('important', next.important ? 1 : 0);
  let listId = r.list_id;
  if (next.listId !== undefined) {
    const l = await lists.access(gc, ctx.userId, next.listId);
    if (l.id !== r.list_id) { lists.writable(l); listId = l.id; put('list_id', l.id); }
  }
  if (next.due !== undefined) { put('due_date', next.due.date); put('due_time', next.due.time); put('due_at', dueAt(ctx, next.due.date, next.due.time)); }
  if (next.remindAt !== undefined) { put('remind_at', next.remindAt); put('reminded_at', null); }
  if (next.repeat !== undefined) put('repeat_json', next.repeat === null ? null : JSON.stringify(next.repeat));
  if (next.assigneeId !== undefined) put('assignee_id', next.assigneeId === null ? null : await assigneeArg(gc, listId, next.assigneeId));
  else if (!sub && listId !== r.list_id && r.assignee_id && !(await store.one(gc, 'SELECT 1 AS x FROM list_members WHERE list_id = ? AND user_id = ?', [listId, r.assignee_id]))) put('assignee_id', null);
  if (next.position !== undefined) put('position', next.position);
  const twoWay = await linkedTwoWay(gc, listId);
  const before = await lists.memberIds(gc, r.list_id);
  await store.tx(gc, async () => {
    if (set.length) await store.run(gc, `UPDATE tasks SET ${set.join(', ')}, updated_at = ?, ext_dirty = ? WHERE id = ?`, [...args, ctx.now, twoWay && set.length ? 1 : r.ext_dirty, r.id]);
    if (listId !== r.list_id) await store.run(gc, 'UPDATE tasks SET list_id = ?, updated_at = ? WHERE parent_id = ?', [listId, ctx.now, r.id]);
    if (sub && set.length && twoWay) await store.run(gc, 'UPDATE tasks SET ext_dirty = 1 WHERE id = ? AND ext_id IS NOT NULL', [r.parent_id]);
    if (next.myDay !== undefined) {
      if (next.myDay) await store.run(gc, 'INSERT OR IGNORE INTO my_day (user_id, day, task_id) VALUES (?, ?, ?)', [ctx.userId, ctx.today, r.id]);
      else await store.run(gc, 'DELETE FROM my_day WHERE user_id = ? AND task_id = ?', [ctx.userId, r.id]);
    }
    if (next.title !== undefined || next.note !== undefined) await fts.setTask(gc, r.id, title, note);
  });
  const after = listId !== r.list_id ? await lists.memberIds(gc, listId) : before;
  events.changed(gc, [...new Set([...before, ...after])], 'tasks');
  if (next.assigneeId && next.assigneeId !== ctx.userId) await notifyAssigned(gc, ctx, next.assigneeId, title, r.id);
  return get(gc, ctx, r.id);
}

/**
 * POST tasks/<id>/complete { done } → { task, next? } — a repeating task gets its next one (the same title, note,
 * list, person, sub tasks unticked; the reminder moved by as many days as the due date). A task that carries a source
 * item ticks it off in its plugin first (opts.completeSource); a refusal there leaves both as they were.
 */
async function complete(gc, ctx, id, b, opts = {}) {
  const r = await access(gc, ctx, id);
  const done = b && b.done !== undefined ? bool(b.done) : true;
  if (!(await mayComplete(gc, ctx, r))) throw readOnly();
  if (!!r.done_at === done) return get(gc, ctx, r.id, opts);
  if (r.src_plugin && !r.parent_id && opts.completeSource) await opts.completeSource(gc, ctx, r.src_plugin, r.src_id, done);
  const twoWay = await linkedTwoWay(gc, r.list_id);
  let nextId = null;
  await store.tx(gc, async () => {
    await store.run(gc, 'UPDATE tasks SET done_at = ?, done_by = ?, updated_at = ?, ext_dirty = ? WHERE id = ?', [done ? ctx.now : null, done ? ctx.userId : null, ctx.now, twoWay ? 1 : r.ext_dirty, r.id]);
    if (r.parent_id && twoWay) await store.run(gc, 'UPDATE tasks SET ext_dirty = 1 WHERE id = ? AND ext_id IS NOT NULL', [r.parent_id]);
    const rule = done && !r.parent_id ? parse(r.repeat_json, null) : null;
    if (rule) {
      const nextDate = R.next(rule, { due: r.due_date, done: ctx.today });
      if (nextDate) {
        const shift = r.due_date ? tz.diffDays(r.due_date, nextDate) : 0;
        const remind = r.remind_at ? r.remind_at + shift * 86400000 : null;
        const ins = await store.run(gc, `INSERT INTO tasks (list_id, title, note, important, due_date, due_time, due_at, remind_at, repeat_json, assignee_id, position,
          ext_dirty, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.list_id, r.title, r.note, r.important, nextDate, r.due_time, dueAt(ctx, nextDate, r.due_time), remind, r.repeat_json, r.assignee_id, r.position,
          twoWay ? 1 : 0, ctx.userId, ctx.now, ctx.now]);
        nextId = Number(ins.lastInsertRowid);
        await store.run(gc, `INSERT INTO tasks (list_id, parent_id, title, position, created_by, created_at, updated_at)
          SELECT list_id, ?, title, position, ?, ?, ? FROM tasks WHERE parent_id = ? AND deleted_at IS NULL`, [nextId, ctx.userId, ctx.now, ctx.now, r.id]);
        await fts.setTask(gc, nextId, r.title, r.note);
        // the repeat goes on with the new task; the done one keeps the rule only as history
        await store.run(gc, 'UPDATE tasks SET repeat_json = NULL WHERE id = ?', [r.id]);
      }
    }
  });
  events.changed(gc, await lists.memberIds(gc, r.list_id), 'tasks');
  const out = await get(gc, ctx, r.id, opts);
  if (nextId) out.next = (await get(gc, ctx, nextId, opts)).task;
  return out;
}

/**
 * DELETE tasks/<id> — into the trash (with its sub tasks); purged after 30 days (housekeeping.js). Already in the trash
 * (a delete sent twice, or its task deleted first): { ok, gone: true } for a member of its list.
 */
async function remove(gc, ctx, id) {
  let r;
  try { r = await access(gc, ctx, id); } catch (e) {
    const tid = posInt(id);
    const was = tid && await store.one(gc, `SELECT t.id FROM tasks t JOIN list_members m ON m.list_id = t.list_id AND m.user_id = ?
      LEFT JOIN tasks p ON p.id = t.parent_id WHERE t.id = ? AND (t.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL)`, [ctx.userId, tid]);
    if (was) return { ok: true, gone: true };
    throw e;
  }
  if (r.my_role === 'read') throw readOnly();
  const twoWay = await linkedTwoWay(gc, r.list_id);
  await store.tx(gc, async () => {
    await store.run(gc, 'UPDATE tasks SET deleted_at = ?, updated_at = ?, ext_dirty = ? WHERE id = ? OR parent_id = ?', [ctx.now, ctx.now, twoWay && r.ext_id && !r.parent_id ? 1 : 0, r.id, r.id]);
    if (r.parent_id && twoWay) await store.run(gc, 'UPDATE tasks SET ext_dirty = 1 WHERE id = ? AND ext_id IS NOT NULL', [r.parent_id]);
    await store.run(gc, 'DELETE FROM my_day WHERE task_id = ?', [r.id]);
    await fts.dropTask(gc, r.id);
  });
  events.changed(gc, await lists.memberIds(gc, r.list_id), 'tasks');
  return { ok: true };
}

/** The open task carrying source item (plugin, id) for this person, if any. */
async function carrying(gc, ctx, plugin, srcId) {
  return store.one(gc, `SELECT t.* FROM tasks t INDEXED BY idx_tasks_src JOIN list_members m ON m.list_id = t.list_id AND m.user_id = ?
    WHERE t.src_plugin = ? AND t.src_id = ? AND t.deleted_at IS NULL AND t.parent_id IS NULL LIMIT 1`, [ctx.userId, plugin, srcId]);
}

module.exports = { TITLE_MAX, NOTE_MAX, view, views, extras, access, mayComplete, create, get, update, complete, remove, dueAt, iso, carrying, fromText };
