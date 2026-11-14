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
const duty = require('./duty');
const calsync = require('./calsync');
const shopping = require('./shopping');
const places = require('./places');
const famtasks = require('./famtasks');
const prefs = require('./prefs');
const R = require('../ui/repeat');
const Q = require('../ui/quickparse');
const TW = require('../ui/turnwords');
const { t } = require('./text');
const { fail, posInt, line, text, isDate, isTime, parse, bool, same, stale } = require('./util');

const TITLE_MAX = 300;
const NOTE_MAX = 20000;
const SUBTASKS_MAX = 100;
const PEOPLE_MAX = 20;
const ROUTE = 'plg-gatecontrol-notizen';

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
    // 1.3.0: the reminder still to come ({ tag, at, atMs, mine: this person gets its push, snoozed }), „Später“ pressed,
    // a reminder that could not be sent any more, the event in Mail's calendar (calsync.view)
    reminder: duty.pending(r) ? { tag: duty.tagOf(r), at: iso(ctx, r.remind_at), atMs: r.remind_at, mine: turnOf(r, extra) === 'first' ? peopleOf(r, extra).includes(ctx.userId) : (extra.duty ? extra.duty.get(r.id) : duty.candidate(r)) === ctx.userId, snoozed: !!r.snoozed_at } : null,
    snoozed: !!r.snoozed_at && duty.pending(r), missedReminder: !!r.missed_at && !r.done_at,
    calendar: calsync.view(ctx, r),
    // 1.4.0: the shopping list the task carries ({ id, uid, name, icon, open, total, done, family }; null: none, or the
    // person is no member of that list)
    attachedList: (r.attached_list && extra.attached && extra.attached.get(r.attached_list)) || null,
    // 1.5.0: the place the task hangs on (server/places.js: { mode, id, name, address, lat, lon, radius, trigger, key,
    // label, consent, watch, … }; null: none)
    place: r.place_json ? places.taskView(ctx, r, extra.places) : null,
    assignee: r.assignee_id ? { id: r.assignee_id, name: extra.names ? extra.names.get(r.assignee_id) || null : null } : null,
    // 1.6.0: whose turn — turn 'rotate' (one at a time: `assignee` is who is on, the next one after it is ticked off) |
    // 'first' (it goes to everybody of `people`, the first one ticks it off for all) | null; people [{ id, name }];
    // stars (0: none — only in the family list, counted by Familie); doneBy: for whom it was ticked off; family: a
    // task of the family list
    turn: turnOf(r, extra), people: peopleOf(r, extra).map((u) => ({ id: u, name: extra.names ? extra.names.get(u) || null : null })),
    stars: r.stars || 0, doneBy: r.done_at && (r.credit_id || r.done_by) ? { id: r.credit_id || r.done_by, name: extra.names ? extra.names.get(r.credit_id || r.done_by) || null : null } : null,
    family: famtasks.isFamilyList(extra.fam, r.list_id),
    myDay: extra.myDay ? extra.myDay.has(r.id) : false,
    progress: extra.progress && extra.progress.get(r.id) ? extra.progress.get(r.id) : null,
    attachments: extra.attachments ? extra.attachments.get(r.id) || 0 : undefined,
    source: r.src_plugin ? { plugin: r.src_plugin, id: r.src_id } : null,
    noteId: r.note_id || null, position: r.position,
    // 1.2.0: a member who may only look completes only what is assigned to them (README "Roles")
    // 1.6.0: in the family list a child does not change a task a parent made and ticks off what is its own to do
    canEdit: (!extra.roles || extra.roles.get(r.list_id) !== 'read') && !(famRules(ctx, r, extra) || {}).protected,
    canComplete: famRules(ctx, r, extra) ? famRules(ctx, r, extra).mine
      : (!extra.roles || extra.roles.get(r.list_id) !== 'read' || r.assignee_id === ctx.userId || (!!r.parent_id && !!extra.parentMine && extra.parentMine.has(r.parent_id))),
    updatedAt: r.updated_at,
  };
}

/** The people of a turn who are (still) members of the list, in their order. */
function peopleOf(r, extra) {
  if (!r.turn) return [];
  const all = [...new Set((parse(r.people_json, []) || []).filter((u) => Number.isSafeInteger(u) && u > 0))];
  const ms = extra && extra.members ? extra.members.get(r.list_id) : null;
  return ms ? all.filter((u) => ms.has(u)) : all;
}
/** A turn needs two people who are there: else the task is an ordinary one. */
const turnOf = (r, extra) => (famtasks.TURNS.includes(r.turn) && peopleOf(r, extra).length > 1 ? r.turn : null);
/** The family list's rules for this row (a sub task: those of its task) — null outside the family list. */
function famRules(ctx, r, extra) {
  if (!extra || !extra.fam) return null;
  const base = r.parent_id ? (extra.parents ? extra.parents.get(r.parent_id) : null) : r;
  return base ? famtasks.rules(extra.fam, ctx.userId, base) : null;
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
  // 1.6.0: the family (its list, the parents), the members of the lists of tasks with a turn, the tasks of sub tasks
  const fam = await famtasks.family(gc);
  const members = new Map();
  for (const part of store.chunks([...new Set(rows.filter((r) => r.turn).map((r) => r.list_id))])) {
    if (!part.length) continue;
    for (const m of await store.all(gc, `SELECT list_id, user_id FROM list_members WHERE list_id IN (${store.marks(part.length)})`, part)) {
      if (!members.has(m.list_id)) members.set(m.list_id, new Set());
      members.get(m.list_id).add(m.user_id);
    }
  }
  const parents = new Map();
  if (fam && fam.listId) {
    for (const part of store.chunks([...new Set(rows.filter((r) => r.parent_id && r.list_id === fam.listId).map((r) => r.parent_id))])) {
      if (!part.length) continue;
      for (const p of await store.all(gc, `SELECT * FROM tasks WHERE id IN (${store.marks(part.length)})`, part)) parents.set(p.id, p);
    }
  }
  const names = new Map();
  const named = async (u) => { if (u && !names.has(u)) names.set(u, await people.name(gc, u)); };
  for (const r of rows) {
    await named(r.assignee_id);
    if (r.turn) for (const u of peopleOf(r, { members })) await named(u);
    if (r.done_at) await named(r.credit_id || r.done_by);
  }
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
  // whose reminder: only asked for the tasks that have one to come
  const due = rows.filter(duty.pending);
  return { progress, myDay, attachments, names, roles, parentMine, fam, members, parents, duty: due.length ? await duty.of(gc, due) : new Map(),
    attached: await shopping.attachInfo(gc, ctx.userId, rows.map((r) => r.attached_list)), places: await places.ofTasks(gc, rows) };
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
  // 1.6.0: the family list — a child ticks off what is its own to do, a parent everything
  const fam = await famtasks.family(gc);
  if (fam && fam.listId === r.list_id) {
    const base = r.parent_id ? await store.one(gc, 'SELECT * FROM tasks WHERE id = ?', [r.parent_id]) : r;
    const fr = base ? famtasks.rules(fam, ctx.userId, base) : null;
    if (fr) return fr.mine;
  }
  if (r.my_role !== 'read') return true;
  if (r.assignee_id === ctx.userId) return true;
  if (!r.parent_id) return false;
  const p = await store.one(gc, 'SELECT assignee_id FROM tasks WHERE id = ?', [r.parent_id]);
  return !!(p && p.assignee_id === ctx.userId);
}
const readOnly = () => fail('forbidden', { reason: 'read_only' });
const parentsOnly = () => fail('forbidden', { reason: 'parents_only' });

/**
 * 1.6.0: turn, people and the person of a task as they can be together in list `listId` → { turn, people, assignee }.
 * rotate: `assignee` is one of the people (else the first one); first: nobody is assigned. `lenient` (the task changed
 * its list, a person left): what does not fit any more is dropped instead of refused.
 */
async function turnArgs(gc, listId, turn, ppl, assignee, lenient) {
  if (turn != null && !famtasks.TURNS.includes(turn)) throw fail('invalid', { field: 'turn' });
  if (!turn) return { turn: null, people: null, assignee: assignee || null };
  if (!Array.isArray(ppl)) throw fail('invalid', { field: 'people' });
  const ids = [...new Set(ppl.map(posInt))];
  if (ids.some((u) => !u) || ids.length > PEOPLE_MAX) throw fail('invalid', { field: 'people' });
  const ms = new Set(await lists.memberIds(gc, listId));
  const live = ids.filter((u) => ms.has(u));
  if (live.length !== ids.length && !lenient) throw fail('not_member', { field: 'people' });
  if (live.length < 2) { if (lenient) return { turn: null, people: null, assignee: assignee && ms.has(assignee) ? assignee : null }; throw fail('invalid', { field: 'people' }); }
  return { turn, people: live, assignee: turn === 'first' ? null : (live.includes(assignee) ? assignee : live[0]) };
}

/** `stars` of POST / PATCH tasks: 0–10, only in the family list and only from a parent. */
function starsArg(v, fam, listId, userId) {
  const n = v == null ? 0 : v;
  if (!Number.isSafeInteger(n) || n < 0 || n > famtasks.STARS_MAX) throw fail('invalid', { field: 'stars' });
  if (!n) return 0;
  if (!famtasks.isFamilyList(fam, listId)) throw fail('invalid', { field: 'stars', reason: 'family' });
  if (!fam.parents.has(userId)) throw parentsOnly();
  return n;
}

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
async function fromText(gc, ctx, s, area, listId) {
  const ls = (await lists.all(gc, ctx, area)).lists.filter((l) => l.canEdit);
  const ps = await people.pickable(gc, ctx.userId);
  const p = Q.parse(s, { today: ctx.today, now: ctx.time, lists: ls.map((l) => ({ id: l.id, name: l.name })), people: ps.map((u) => ({ id: u.id, name: u.name })) });
  // 1.6.0: further people, „reihum“ / „wer zuerst“, „2 Sterne“ (ui/turnwords.js — the parser itself is untouched)
  const fam = await famtasks.family(gc);
  const tw = TW.apply(p, { people: ps.map((u) => ({ id: u.id, name: u.name })), stars: !!(fam && fam.stars && fam.parents.has(ctx.userId) && fam.listId && (posInt(listId) || (p.list && p.list.id)) === fam.listId) });
  p.title = tw.title;
  p.people = tw.people;
  p.turn = tw.turn;
  p.stars = tw.stars;
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
 * 1.4.0: attachedListId | attachedListUid — the shopping list the task carries; with `text` and attach: 'auto' the list
 * the line names is attached when exactly one fits (→ `attach` as in POST parse).
 * 1.5.0: place — the place the task hangs on (server/places.js); with `text` and place: 'auto' the place the line names
 * is taken when it is decided (one of „Meine Orte“, the remembered one of a kind) → `place` as in POST parse. A task
 * made from `text` with a place gets the title without the place's words („beim Baumarkt Schrauben kaufen“ →
 * „Schrauben kaufen“).
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
  let attach = null;
  let placeHint = null;
  let placeArg = b.place !== undefined && b.place !== 'auto' ? b.place : undefined;
  if (b.place !== undefined && b.place !== null && b.place !== 'auto' && (typeof b.place !== 'object' || Array.isArray(b.place))) throw fail('invalid', { field: 'place' });
  if (typeof b.text === 'string' && !b.title) {
    parsed = await fromText(gc, ctx, b.text, b.area, b.listId);
    fields = {
      ...b, title: parsed.title || line(b.text, TITLE_MAX), important: b.important || parsed.important,
      due: b.due !== undefined ? b.due : parsed.date ? { date: parsed.date, time: parsed.time } : undefined,
      remindAt: b.remindAt !== undefined ? b.remindAt : parsed.remind || undefined,
      repeat: b.repeat !== undefined ? b.repeat : parsed.repeat || undefined,
      listId: b.listId || (parsed.list ? parsed.list.id : undefined),
      assigneeId: b.assigneeId !== undefined ? b.assigneeId : parsed.assignee ? parsed.assignee.id : undefined,
      // 1.6.0: „reihum“ / „wer zuerst“ with the people the line names, „2 Sterne“
      turn: b.turn !== undefined ? b.turn : parsed.turn || undefined,
      people: b.people !== undefined ? b.people : parsed.turn && parsed.people ? parsed.people.map((u) => u.id) : undefined,
      stars: b.stars !== undefined ? b.stars : parsed.stars || undefined,
    };
    // 1.4.0: „#einkauf“ may name a shopping list — then it is no task list to be made
    const hint = b.attach === 'auto' || (!fields.listId && parsed.listName) ? await shopping.suggest(gc, ctx, b.text, parsed, b.area) : null;
    if (hint && b.attach === 'auto') attach = hint;
    if (!fields.listId && parsed.listName && b.createList === true && !(hint && hint.via === 'tag')) {
      const made = await lists.create(gc, ctx, { name: parsed.listName, area: b.area });
      fields.listId = made.list.id;
    }
    // 1.5.0: the place the line names — taken when asked for ('auto', and decided) or given; its words leave the title
    if (b.place !== undefined && b.place !== null && !b.parentId) {
      const hint = await places.suggest(gc, ctx, parsed);
      if (b.place === 'auto') { placeHint = hint; placeArg = places.argOf(hint) || undefined; }
      if (hint && placeArg && hint.title) fields.title = hint.title;
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
    listId = lists.writable(lists.taskList(await lists.access(gc, ctx.userId, fields.listId))).id;
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
  // 1.6.0: whose turn, stars; in the family list a child adds nothing to a task a parent made
  const fam = await famtasks.family(gc);
  if (parent) { const fr = famtasks.rules(fam, ctx.userId, parent); if (fr && fr.protected) throw parentsOnly(); }
  let turn = { turn: null, people: null, assignee };
  if (!parent && fields.turn != null) {
    // what a line said and does not fit (a person who is not in the list) leaves an ordinary task
    try { turn = await turnArgs(gc, listId, fields.turn, fields.people, assignee, false); assignee = turn.assignee; } catch (e) { if (!parsed || b.turn !== undefined || b.people !== undefined) throw e; }
  }
  let stars = 0;
  if (!parent && fields.stars != null) { try { stars = starsArg(fields.stars, fam, listId, ctx.userId); } catch (e) { if (!parsed || b.stars !== undefined) throw e; } }
  const note = fields.note !== undefined ? text(fields.note, NOTE_MAX) : '';
  let attached = null;
  if (!parent) {
    if (b.attachedListId !== undefined || b.attachedListUid !== undefined) attached = await shopping.attachArg(gc, ctx.userId, b.attachedListId, b.attachedListUid);
    else if (attach && attach.list) attached = attach.list.id;
  }
  const place = !parent && placeArg ? await places.argFor(gc, ctx, null, placeArg) : null;
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
      position, src_plugin, src_id, note_id, ext_id, ext_at, ext_dirty, created_by, created_at, updated_at, done_at, done_by, attached_list, place_id, place_json,
      turn, people_json, stars) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [listId, parent ? parent.id : null, title, note, fields.important ? 1 : 0, due.date, due.time, dueAt(ctx, due.date, due.time),
      remindAt, repeat ? JSON.stringify(repeat) : null, assignee, pos.p, src ? src.plugin : null, src ? src.id : null,
      posInt(fields.noteId) || null, opts.extId || null, opts.extAt || null, twoWay && !opts.extId ? 1 : 0, ctx.userId, opts.createdAt || ctx.now, ctx.now,
      opts.doneAt || null, opts.doneAt ? ctx.userId : null, attached, place && place.change ? place.change.placeId : null, place && place.change ? JSON.stringify(place.change.json) : null,
      turn.turn, turn.people ? JSON.stringify(turn.people) : null, stars]);
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
  if (place && place.change) { await places.picked(gc, ctx, place.pick); await places.sync(gc, ctx, id); events.changed(gc, members, 'places'); }
  if (assignee && assignee !== ctx.userId) await notifyAssigned(gc, ctx, assignee, title, id);
  // 1.6.0: „wer zuerst“ goes to everybody; Familie hears of a task of the family list
  if (turn.turn === 'first') for (const u of turn.people) if (u !== ctx.userId) await notifyAssigned(gc, ctx, u, title, id);
  await famtasks.changed(gc, { list_id: listId });
  // 1.3.0: its event in Mail's calendar — at once; a task that comes in by an import waits for the background run
  if (due.time && !opts.doneAt) await (opts.extId ? calsync.touch(gc, id) : calsync.now(gc, ctx, id));
  const row = await store.one(gc, 'SELECT * FROM tasks WHERE id = ?', [id]);
  return { task: (await views(gc, ctx, [row]))[0], ...(parsed ? { parsed } : {}), ...(attach ? { attach } : {}), ...(placeHint ? { place: placeHint } : {}), ...(cid ? { clientId: cid } : {}) };
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
const FIELDS = ['title', 'note', 'important', 'due', 'remindAt', 'repeat', 'assigneeId', 'listId', 'position', 'myDay', 'attachedListId', 'turn', 'people', 'stars'];
const OWN = ['due', 'remindAt', 'repeat', 'assigneeId', 'listId', 'myDay', 'attachedListId', 'turn', 'people', 'stars'];

/**
 * PATCH tasks/<id> { title?, note?, important?, due?, remindAt?, repeat?, assigneeId?, listId?, position?, myDay?,
 * attachedListId? (1.4.0; or attachedListUid), place? (1.5.0, server/places.js — not part of `base`: the last change
 * of the place wins), base? }
 * — `base` (1.1.0): the values the device saw before it changed them; a field someone changed meanwhile to something
 * else → 409 conflict { fields, task }. Without `base` the change wins (as in 1.0). A field set to what it is already
 * is not written (a change sent twice does nothing the second time: no new reminder, no push, no event).
 */
async function update(gc, ctx, id, b0) {
  const r = await access(gc, ctx, id);
  let b = b0;
  // 1.4.0: the list named by the id its device gave it
  if (b0.attachedListId === undefined && b0.attachedListUid !== undefined) b = { ...b0, attachedListId: await shopping.attachArg(gc, ctx.userId, undefined, b0.attachedListUid) };
  const sub = !!r.parent_id;
  // 1.5.0: the place (looked up before anything is written: an unknown place refuses the whole change)
  const place = b0.place !== undefined && !sub ? await places.argFor(gc, ctx, r, b0.place) : null;
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
      case 'attachedListId': if (v === null) return null; if (!posInt(v)) throw fail('invalid', { field: 'attachedListId' }); return posInt(v);
      case 'turn': if (v === null) return null; if (!famtasks.TURNS.includes(v)) throw fail('invalid', { field: 'turn' }); return v;
      case 'people': { if (v === null) return []; if (!Array.isArray(v) || v.length > PEOPLE_MAX || v.some((u) => !posInt(u))) throw fail('invalid', { field: 'people' }); return [...new Set(v.map(posInt))]; }
      case 'stars': if (v === null) return 0; if (!Number.isSafeInteger(v) || v < 0 || v > famtasks.STARS_MAX) throw fail('invalid', { field: 'stars' }); return v;
      default: return v;
    }
  };
  const now = {
    title: r.title, note: r.note, important: !!r.important, due: { date: r.due_date || null, time: r.due_time || null }, remindAt: r.remind_at || null,
    repeat: parse(r.repeat_json, null), assigneeId: r.assignee_id || null, listId: r.list_id, position: r.position, myDay: myDayNow,
    attachedListId: r.attached_list || null, turn: r.turn || null, people: r.turn ? (parse(r.people_json, []) || []) : [], stars: r.stars || 0,
  };
  const next = {};
  for (const f of FIELDS) if (b[f] !== undefined && !(sub && OWN.includes(f))) next[f] = norm(f, b[f]);
  const late = stale(b.base, now, next, norm);
  if (late.length) throw fail('conflict', { fields: late, task: (await views(gc, ctx, [r]))[0] });
  // only what changes is written
  for (const f of Object.keys(next)) if (same(next[f], now[f])) delete next[f];
  const placed = !!(place && place.change);
  if (!Object.keys(next).length && !placed) { if (place && place.pick && place.pick.fav) await places.picked(gc, ctx, place.pick); return get(gc, ctx, r.id); }
  // a member who may only look: only their own „Mein Tag“ mark
  if (r.my_role === 'read' && (placed || Object.keys(next).some((f) => f !== 'myDay'))) throw readOnly();
  // 1.6.0: the family list — a child does not change a task a parent made (a sub task: its task) and gives no stars
  const fam = await famtasks.family(gc);
  const famBase = sub ? await store.one(gc, 'SELECT * FROM tasks WHERE id = ?', [r.parent_id]) : r;
  const fr = famBase ? famtasks.rules(fam, ctx.userId, famBase) : null;
  if (fr && fr.protected && (placed || Object.keys(next).some((f) => f !== 'myDay'))) throw parentsOnly();

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
    if (l.id !== r.list_id) { lists.writable(lists.taskList(l)); listId = l.id; put('list_id', l.id); }
  }
  if (next.due !== undefined) { put('due_date', next.due.date); put('due_time', next.due.time); put('due_at', dueAt(ctx, next.due.date, next.due.time)); }
  if (next.remindAt !== undefined) { put('remind_at', next.remindAt); put('reminded_at', null); if (r.snoozed_at) put('snoozed_at', null); }
  // a new date or reminder decides a task of „Gestern offen geblieben“ whose reminder got lost
  if ((next.due !== undefined || next.remindAt !== undefined) && r.missed_at) put('missed_at', null);
  if (next.repeat !== undefined) put('repeat_json', next.repeat === null ? null : JSON.stringify(next.repeat));
  let assignee = r.assignee_id || null;
  if (next.assigneeId !== undefined) assignee = next.assigneeId === null ? null : await assigneeArg(gc, listId, next.assigneeId);
  else if (!sub && listId !== r.list_id && r.assignee_id && !(await store.one(gc, 'SELECT 1 AS x FROM list_members WHERE list_id = ? AND user_id = ?', [listId, r.assignee_id]))) assignee = null;
  // 1.6.0: whose turn — turn, people and the person fit together (another list: what does not fit there is dropped)
  if (!sub && (next.turn !== undefined || next.people !== undefined || (r.turn && (next.assigneeId !== undefined || listId !== r.list_id)))) {
    const want = next.turn !== undefined ? next.turn : r.turn || null;
    const tn = await turnArgs(gc, listId, want, next.people !== undefined ? next.people : parse(r.people_json, []), assignee, next.turn === undefined && next.people === undefined);
    if ((r.turn || null) !== tn.turn) put('turn', tn.turn);
    if (!same(r.turn ? parse(r.people_json, []) : null, tn.people)) put('people_json', tn.people ? JSON.stringify(tn.people) : null);
    assignee = tn.assignee;
  }
  if (assignee !== (r.assignee_id || null)) put('assignee_id', assignee);
  if (!sub && (next.stars !== undefined || (listId !== r.list_id && r.stars))) {
    const n = next.stars !== undefined ? starsArg(next.stars, fam, listId, ctx.userId) : (famtasks.isFamilyList(fam, listId) ? r.stars : 0);
    if (n !== (r.stars || 0)) put('stars', n);
  }
  if (next.position !== undefined) put('position', next.position);
  if (next.attachedListId !== undefined) put('attached_list', next.attachedListId === null ? null : await shopping.attachArg(gc, ctx.userId, next.attachedListId));
  if (placed) { put('place_id', place.change.placeId); put('place_json', place.change.json ? JSON.stringify(place.change.json) : null); if (place.change.fresh) put('place_state', null); }
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
  // 1.6.0: Familie hears of a task it keeps a copy of (the family list before or after, a place reminder)
  if (set.length) { await famtasks.changed(gc, r); if (listId !== r.list_id) await famtasks.changed(gc, { list_id: listId }); }
  // 1.5.0: whose phone watches the place follows the task (another person, another list); the phones fetch their places again
  if (placed) await places.picked(gc, ctx, place.pick);
  if (placed || (r.place_json && set.length)) { await places.sync(gc, ctx, r.id); events.changed(gc, [...new Set([...before, ...after])], 'places'); if (placed) await famtasks.changed(gc, r); }
  if (!sub && (next.title !== undefined || next.due !== undefined || set.some((c) => c.startsWith('assignee_id') || c.startsWith('list_id')))) await calsync.now(gc, ctx, r.id);
  return get(gc, ctx, r.id);
}

/**
 * POST tasks/<id>/complete { done, userId? } → { task, next? } — a repeating task gets its next one (the same title,
 * note, list, person, sub tasks unticked; the reminder moved by as many days as the due date). A task that carries a
 * source item ticks it off in its plugin first (opts.completeSource); a refusal there leaves both as they were.
 * 1.6.0: turn 'rotate' — the next task belongs to the next person; turn 'first' — the others' reminder is replaced
 * by „Erledigt von …“. In the family list: `userId` — a parent ticks it off for that member (without it: for the person
 * whose task it is); what was ticked off is written down for Familie (the stars), the parents get „… hat … erledigt“
 * with „Noch nicht fertig“ (done: false takes it back, and the stars with it).
 * opts.fam (server/famtasks.js: ticked off in Familie) { quiet, at, next }: nothing is told back, no push.
 */
async function complete(gc, ctx, id, b, opts = {}) {
  const r = await access(gc, ctx, id);
  const done = b && b.done !== undefined ? bool(b.done) : true;
  const from = opts.fam || null;
  if (!from && !(await mayComplete(gc, ctx, r))) throw readOnly();
  if (!!r.done_at === done) return get(gc, ctx, r.id, opts);
  const fam = await famtasks.family(gc);
  const fr = r.parent_id ? null : famtasks.rules(fam, ctx.userId, r);
  // for whom: the person themselves; a parent for the child whose task it is, or the member they name
  let credit = ctx.userId;
  if (done && fr) {
    const want = b && b.userId != null ? posInt(b.userId) : null;
    if (b && b.userId != null && (!want || !fam.members.has(want))) throw fail('invalid', { field: 'userId' });
    if (want && want !== ctx.userId) { if (!fr.parent && !from) throw parentsOnly(); credit = want; }
    else if (!want && fr.parent && r.assignee_id && r.assignee_id !== ctx.userId && r.turn !== 'first' && fam.members.has(r.assignee_id)) credit = r.assignee_id;
  }
  if (r.src_plugin && !r.parent_id && opts.completeSource) await opts.completeSource(gc, ctx, r.src_plugin, r.src_id, done);
  const twoWay = await linkedTwoWay(gc, r.list_id);
  const at = from && from.at ? from.at : ctx.now;
  // whose turn is next (the people who are still members, in their order)
  const members = r.turn ? new Map([[r.list_id, new Set(await lists.memberIds(gc, r.list_id))]]) : null;
  const live = peopleOf(r, { members });
  let nextAssignee = r.assignee_id || null;
  if (r.turn === 'rotate' && live.length > 1) nextAssignee = live[(live.indexOf(r.assignee_id) + 1) % live.length];
  if (from && from.next !== undefined && from.next) nextAssignee = from.next;
  let nextId = null;
  let told = false;
  await store.tx(gc, async () => {
    await store.run(gc, 'UPDATE tasks SET done_at = ?, done_by = ?, credit_id = ?, updated_at = ?, ext_dirty = ?, missed_at = NULL WHERE id = ?',
      [done ? at : null, done ? ctx.userId : null, done && credit !== ctx.userId ? credit : null, ctx.now, twoWay ? 1 : r.ext_dirty, r.id]);
    if (r.parent_id && twoWay) await store.run(gc, 'UPDATE tasks SET ext_dirty = 1 WHERE id = ? AND ext_id IS NOT NULL', [r.parent_id]);
    // 1.6.0: written down for Familie (not what Familie itself reported)
    if (!from) told = await famtasks.booked(gc, ctx, fam, r, done, credit);
    const uid = r.fam_uid || (told && done ? 'h' + r.id : null);
    const rule = done && !r.parent_id ? parse(r.repeat_json, null) : null;
    if (rule) {
      const nextDate = R.next(rule, { due: r.due_date, done: ctx.today });
      if (nextDate) {
        const shift = r.due_date ? tz.diffDays(r.due_date, nextDate) : 0;
        // 1.3.0: by days on the wall clock (09:00 stays 09:00 over a change of summer time); a snoozed reminder
        // goes back to the task's own time
        const base = r.remind_at && r.snoozed_at && r.due_at && r.due_time ? r.due_at : r.remind_at;
        const remind = base ? duty.shiftDays(base, shift, ctx.tz) : null;
        const ins = await store.run(gc, `INSERT INTO tasks (list_id, title, note, important, due_date, due_time, due_at, remind_at, repeat_json, assignee_id, position,
          ext_dirty, created_by, created_at, updated_at, attached_list, place_id, place_json, turn, people_json, stars, fam_uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.list_id, r.title, r.note, r.important, nextDate, r.due_time, dueAt(ctx, nextDate, r.due_time), remind, r.repeat_json, nextAssignee, r.position,
          twoWay ? 1 : 0, r.turn || fr ? r.created_by : ctx.userId, ctx.now, ctx.now, r.attached_list || null, r.place_id || null, r.place_json || null, r.turn || null, r.people_json || null, r.stars || 0, uid]);
        nextId = Number(ins.lastInsertRowid);
        await store.run(gc, `INSERT INTO tasks (list_id, parent_id, title, position, created_by, created_at, updated_at)
          SELECT list_id, ?, title, position, ?, ?, ? FROM tasks WHERE parent_id = ? AND deleted_at IS NULL`, [nextId, ctx.userId, ctx.now, ctx.now, r.id]);
        await fts.setTask(gc, nextId, r.title, r.note);
        // the repeat goes on with the new task; the done one keeps the rule only as history (and Familie's copy follows the new one)
        await store.run(gc, 'UPDATE tasks SET repeat_json = NULL, fam_uid = NULL WHERE id = ?', [r.id]);
      }
    }
  });
  const memberIds = await lists.memberIds(gc, r.list_id);
  events.changed(gc, memberIds, 'tasks');
  // 1.5.0: a task with a place done (or open again): the phones drop (or take up) its places
  if (r.place_json) events.changed(gc, memberIds, 'places');
  // 1.6.0: the place of the next task is watched by the phone of the person whose turn it is now
  if (nextId && r.place_json && nextAssignee !== (r.assignee_id || null)) await places.sync(gc, ctx, nextId);
  if (!r.parent_id) await calsync.now(gc, ctx, [r.id, nextId]);
  if (!from && !r.parent_id) {
    if (told || r.fam_uid) await famtasks.markDirty(gc);
    if (done) await afterDone(gc, ctx, r, { fam, fr, credit, live });
  }
  const out = await get(gc, ctx, r.id, opts);
  if (nextId) out.next = (await get(gc, ctx, nextId, opts)).task;
  return out;
}

/** The pushes after a task was ticked off: „Erledigt von …“ for the others of „wer zuerst“, the parents' feedback. */
async function afterDone(gc, ctx, r, x) {
  const lang = ctx.notifyLang;
  const l = await store.one(gc, 'SELECT id, name, area FROM lists WHERE id = ?', [r.list_id]);
  const who = (await people.name(gc, x.credit)) || ctx.userName || '';
  if (r.turn === 'first' && r.reminded_at) {
    const others = x.live.filter((u) => u !== ctx.userId && u !== x.credit);
    if (others.length) {
      await pushprefs.send(gc, others, 'reminders', { topic: 'reminders', title: r.title.slice(0, 120), body: t(lang, 'n.first_done', { name: who }), collapseKey: 'task:' + r.id,
        data: { notizen: { kind: 'reminder_done', taskId: r.id, listId: r.list_id, area: l ? l.area : null, task: r.id, userId: x.credit } } });
    }
  }
  // a child ticked off (or it was ticked off for a child): the parents hear of it — each as they chose (prefs.feedback)
  if (!x.fr || x.fam.parents.has(x.credit)) return;
  const stars = x.fam.stars && r.stars > 0 ? r.stars : 0;
  const to = [];
  for (const u of x.fam.parents) {
    if (u === ctx.userId) continue;
    const p = await prefs.get(gc, u);
    if (p.feedback === 'off' || (p.feedback === 'stars' && !stars)) continue;
    to.push(u);
  }
  if (!to.length) return;
  const first = stars ? t(lang, stars === 1 ? 'n.stars_one' : 'n.stars_n', { n: stars }) : null;
  await pushprefs.send(gc, to, 'shared', {
    topic: 'shared', title: t(lang, 'n.done_title', { name: who, title: r.title.slice(0, 80) }).slice(0, 120), body: [first, l ? l.name : null].filter(Boolean).join(' · ').slice(0, 300),
    collapseKey: 'done:' + r.id,
    data: { notizen: { kind: 'done_feedback', taskId: r.id, listId: r.list_id, area: l ? l.area : null, task: r.id, userId: x.credit, stars },
      actions: [{ type: 'open_app_route', id: 'open', label: t(lang, 'n.b_view'), target: ROUTE }, { type: 'callback', id: 'not_done', label: t(lang, 'n.b_not_done') }] },
  });
}

/**
 * The button „Noch nicht fertig“ of the parents' feedback (hook notifyAction; ctx is the parent who pressed it): the task
 * is open again, the stars are taken back, the person who ticked it off hears of it.
 */
async function feedbackAction(gc, ctx, action, d, opts) {
  if (action !== 'not_done') return { ok: false, code: 'invalid' };
  const id = posInt(d && d.taskId);
  if (!id) return { ok: false, code: 'invalid' };
  let r;
  try { r = await access(gc, ctx, id); } catch { return { ok: false, code: 'not_found' }; }
  const fr = famtasks.rules(await famtasks.family(gc), ctx.userId, r);
  if (!fr || !fr.parent) return { ok: false, code: 'forbidden' };
  if (!r.done_at) return { ok: true, undone: false };
  const who = r.credit_id || r.done_by;
  await complete(gc, ctx, r.id, { done: false }, opts);
  if (who && who !== ctx.userId) {
    const l = await store.one(gc, 'SELECT id, area FROM lists WHERE id = ?', [r.list_id]);
    await pushprefs.send(gc, [who], 'shared', { topic: 'shared', title: t(ctx.notifyLang, 'n.undone_title', { name: ctx.userName || '' }).slice(0, 120), body: r.title.slice(0, 200),
      collapseKey: 'done:' + r.id, data: { notizen: push.assigned(r.id, l ? l.id : null, l ? l.area : null) } });
  }
  return { ok: true, undone: true };
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
  // 1.6.0: the family list — a child does not delete a task a parent made
  const fam = await famtasks.family(gc);
  const famBase = r.parent_id ? await store.one(gc, 'SELECT * FROM tasks WHERE id = ?', [r.parent_id]) : r;
  const fr = famBase ? famtasks.rules(fam, ctx.userId, famBase) : null;
  if (fr && fr.protected) throw parentsOnly();
  const twoWay = await linkedTwoWay(gc, r.list_id);
  await store.tx(gc, async () => {
    // two statements (1.3.0): „id = ? OR parent_id = ?“ read every task — the sub tasks have an index of their own
    const dirty = twoWay && r.ext_id && !r.parent_id ? 1 : 0;
    await store.run(gc, 'UPDATE tasks SET deleted_at = ?, updated_at = ?, ext_dirty = ? WHERE id = ?', [ctx.now, ctx.now, dirty, r.id]);
    await store.run(gc, 'UPDATE tasks INDEXED BY idx_tasks_parent SET deleted_at = ?, updated_at = ?, ext_dirty = ? WHERE parent_id = ? AND deleted_at IS NULL', [ctx.now, ctx.now, dirty, r.id]);
    if (r.parent_id && twoWay) await store.run(gc, 'UPDATE tasks SET ext_dirty = 1 WHERE id = ? AND ext_id IS NOT NULL', [r.parent_id]);
    await store.run(gc, 'DELETE FROM my_day WHERE task_id = ?', [r.id]);
    await fts.dropTask(gc, r.id);
  });
  events.changed(gc, await lists.memberIds(gc, r.list_id), 'tasks');
  if (r.place_json) events.changed(gc, await lists.memberIds(gc, r.list_id), 'places');
  if (!r.parent_id && r.cal_event_id) await calsync.now(gc, ctx, r.id);
  if (!r.parent_id) await famtasks.changed(gc, r);
  return { ok: true };
}

/** The open task carrying source item (plugin, id) for this person, if any. */
async function carrying(gc, ctx, plugin, srcId) {
  return store.one(gc, `SELECT t.* FROM tasks t INDEXED BY idx_tasks_src JOIN list_members m ON m.list_id = t.list_id AND m.user_id = ?
    WHERE t.src_plugin = ? AND t.src_id = ? AND t.deleted_at IS NULL AND t.parent_id IS NULL LIMIT 1`, [ctx.userId, plugin, srcId]);
}

module.exports = { TITLE_MAX, NOTE_MAX, view, views, extras, access, mayComplete, readOnly, linkedTwoWay, create, get, update, complete, remove, dueAt, iso, carrying, fromText, feedbackAction, peopleOf, turnOf };
