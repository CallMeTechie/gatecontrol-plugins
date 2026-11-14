'use strict';

// 1.4.0: shopping lists in the hub (migrations/006_shopping_lists.sql; README "1.4.0").
//
// A shopping list is a list (server/lists.js: owner, members, roles, icon, list days) of the kind 'shopping'; its items
// are light rows with ids made by the device. Offline-first, the protocol Familie had:
//
//   GET  shopping[?since=<serverTime>]   every list the person sees and their items (not deleted) / with `since`: every
//                                        list still, the items changed since and tombstones (deleted: true, kept 30 days)
//   POST shopping/ops { ops: [...] }     ≤ 200 ops, applied in order, idempotent (the same id twice never duplicates),
//                                        last write wins by arrival → { applied, rejected: [{ index, code }], serverTime,
//                                        completed: [{ taskId, title, listId }] }
//   PUT  shopping/lists/<id>/family      { on } — share with the whole family (Familie told the hub who that is)
//   POST shopping/lists/<id>/going       „Ich gehe einkaufen“ and
//   POST shopping/lists/<id>/assign      „Kannst du einkaufen gehen?“ of a family list — handed to Familie (service
//                                        shopping_action), which sends the cards and pushes as before
//
// A list has two ids: `uid` (text, made by the device — `id` in this API, the same in Familie) and the list's number
// (`listId`: PATCH lists/<n>, PUT lists/<n>/members, DELETE lists/<n>, Task.attachedList.id).
//
// A task can carry one shopping list (tasks.attached_list). When the last open item of a list is ticked, every open
// task carrying it is completed (hooks.completeTask, set by server/api.js) — the other way round nothing happens.
//
// For Familie (the only owner plugin; server/services.js):
//   shopping_bind { members, parents, release? }   who the family is; family lists follow its members
//   shopping_put  { lists, items }                 rows of Familie's copy → here (written when they differ)
//   shopping_list { since?, cursor? }              every family list, the items changed since → Familie's copy
// What changes here in a family list is told to Familie with shopping_changed (a second later, else by the background
// run); what Familie wrote itself is not told back.

const store = require('./store');
const tz = require('./tz');
const clock = require('./clock');
const lists = require('./lists');
const people = require('./people');
const events = require('./events');
const { fail, posInt, line, parse, area: areaOf } = require('./util');

const FAMILIE = 'gatecontrol-familie';
const OWNERS = [FAMILIE];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const ISO_RE = /[zZ]$|[+-]\d{2}:?\d{2}$/;
const MAX_OPS = 200;
const TEXT_MAX = 120;
const QTY_MAX = 40;
const NAME_MAX = 40;
const LISTS_MAX = 200;
const FAMILY_LISTS_MAX = 100;
const TOMBSTONE_DAYS = 30;
const DAY = 86400000;
const HOUR = 3600000;
const ANSWER_MAX = 11000;
const TASKS_SHOWN = 5;

// „bei Lidl einkaufen“ → the list „Einkauf“: a fixed table of words, no guessing (README "1.4.0")
const WORDS = ['einkaufen', 'einkauf', 'einkäufe', 'besorgen', 'besorgung', 'besorgungen', 'shopping', 'groceries', 'grocery'];
const NAME_HINT = /^(?:einkauf|lebensmittel|shopping|grocer)/;

/** Hooks between modules: completeTask(gc, ctx, taskRow) → the task was completed (set by server/api.js). */
const hooks = { completeTask: null };
const state = { fam: null, timer: null, noTimer: false };

function reset() {
  if (state.timer) clearTimeout(state.timer);
  state.fam = null;
  state.timer = null;
}

/** The ISO time of ms in the hub's zone with its offset. */
function iso(ctx, ms) {
  if (ms == null) return null;
  const p = tz.parts(ms, ctx.tz);
  const off = Math.round(tz.offset(ms, ctx.tz) / 60000);
  const a = Math.abs(off);
  return `${tz.dateStr(p.y, p.m, p.d)}T${tz.pad(p.hh)}:${tz.pad(p.mm)}:${tz.pad(p.ss)}${off < 0 ? '-' : '+'}${tz.pad(Math.floor(a / 60))}:${tz.pad(a % 60)}`;
}
const serverTime = (ctx) => iso(ctx, Math.floor(ctx.now / 1000) * 1000);

const ints = (v) => [...new Set((Array.isArray(v) ? v : []).map(posInt).filter(Boolean))];

/** The family as Familie told it → { plugin, members: Set, parents: Set } | null. */
async function family(gc) {
  if (state.fam) return state.fam.v;
  const r = await store.one(gc, 'SELECT * FROM shop_family LIMIT 1');
  const v = r ? { plugin: r.plugin, members: new Set(ints(parse(r.members, []))), parents: new Set(ints(parse(r.parents, []))) } : null;
  state.fam = { v };
  return v;
}

/** Does the owner plugin offer `service` right now (asks nobody)? */
async function offered(gc, plugin, service) {
  try { return !!(gc.services && typeof gc.services.available === 'function' && (await gc.services.available(plugin, service)) === true); } catch { return false; }
}

/** me.shopping */
async function meInfo(gc, ctx) {
  const fam = await family(gc);
  return { family: { available: await offered(gc, FAMILIE, 'shopping_action'), bound: !!fam, parent: !!(fam && fam.parents.has(ctx.userId)) } };
}

const iconOf = (v) => (typeof v === 'string' && lists.ICONS.includes(v) ? v : null);
const canEdit = (l) => !!l.my_role && l.my_role !== 'read';
const canManage = (l, fam, userId) => l.my_role === 'owner' || (!!l.bound_plugin && !!fam && fam.parents.has(userId) && !!l.my_role);

/** The shopping lists `userId` sees (rows with the my_* columns of lists.access). */
function rowsOf(gc, userId) {
  return store.all(gc, `SELECT ${lists.LIST_COLS} FROM list_members m JOIN lists l ON l.id = m.list_id AND l.deleted_at IS NULL AND l.kind = 'shopping'
    WHERE m.user_id = ? ORDER BY m.position, l.id LIMIT 500`, [userId]);
}

/** The shopping list with the uid `uid` as `userId` sees it (null: none, deleted, no member). */
function byUid(gc, userId, uid) {
  if (typeof uid !== 'string' || !ID_RE.test(uid)) return null;
  return store.one(gc, `SELECT ${lists.LIST_COLS} FROM lists l JOIN list_members m ON m.list_id = l.id AND m.user_id = ?
    WHERE l.uid = ? AND l.deleted_at IS NULL AND l.kind = 'shopping'`, [userId, uid]);
}

/** Open and all items per list → Map(list id → { open, total }). */
async function counts(gc, listIds) {
  const out = new Map();
  for (const part of store.chunks(listIds)) {
    if (!part.length) continue;
    const rows = await store.all(gc, `SELECT list_id, COUNT(*) AS n, SUM(checked) AS c FROM shop_items INDEXED BY idx_shop_items_list
      WHERE list_id IN (${store.marks(part.length)}) AND deleted = 0 GROUP BY list_id`, part);
    for (const r of rows) out.set(r.list_id, { open: r.n - (r.c || 0), total: r.n });
  }
  return out;
}

/** The open items per list only (list days, „Mein Tag“) → Map(list id → n). */
async function openCounts(gc, listIds) {
  const out = new Map();
  for (const part of store.chunks(listIds)) {
    if (!part.length) continue;
    const rows = await store.all(gc, `SELECT list_id, COUNT(*) AS n FROM shop_items INDEXED BY idx_shop_items_open
      WHERE list_id IN (${store.marks(part.length)}) AND deleted = 0 AND checked = 0 GROUP BY list_id`, part);
    for (const r of rows) out.set(r.list_id, r.n);
  }
  return out;
}

/** The person's open tasks that carry one of these lists → Map(list id → [{ id, title }]). */
async function carriers(gc, userId, listIds) {
  const out = new Map();
  for (const part of store.chunks(listIds)) {
    if (!part.length) continue;
    const rows = await store.all(gc, `SELECT t.id, t.title, t.attached_list FROM tasks t INDEXED BY idx_tasks_attached
      JOIN list_members m ON m.list_id = t.list_id AND m.user_id = ? JOIN lists l ON l.id = t.list_id AND l.deleted_at IS NULL
      WHERE t.attached_list IN (${store.marks(part.length)}) AND t.done_at IS NULL AND t.deleted_at IS NULL AND t.parent_id IS NULL ORDER BY t.id`, [userId, ...part]);
    for (const r of rows) {
      if (!out.has(r.attached_list)) out.set(r.attached_list, []);
      if (out.get(r.attached_list).length < TASKS_SHOWN) out.get(r.attached_list).push({ id: r.id, title: r.title });
    }
  }
  return out;
}

async function extras(gc, ctx, rows) {
  const ids = rows.map((r) => r.id);
  return { counts: await counts(gc, ids), tasks: await carriers(gc, ctx.userId, ids), fam: await family(gc) };
}

/** What Familie knows of a family list ({ assignee, dueAt, going }) as shown now. */
function famOf(ctx, l) {
  const f = l.bound_plugin ? parse(l.fam_json, null) : null;
  const o = f && typeof f === 'object' ? f : {};
  const going = (Array.isArray(o.going) ? o.going : []).filter((g) => g && posInt(g.userId) && typeof g.at === 'string' && Date.parse(g.at) >= ctx.now - HOUR);
  return { assignee: o.assignee && typeof o.assignee === 'object' ? o.assignee : null, dueAt: typeof o.dueAt === 'string' ? o.dueAt : null, going };
}

/** A list row (with the my_* columns) → the API's shopping list. */
async function view(gc, ctx, l, x) {
  const ms = await lists.membersOf(gc, l.id);
  const others = [];
  for (const m of ms) if (m.user_id !== l.owner_id) others.push({ id: m.user_id, name: await people.name(gc, m.user_id), role: m.role === 'read' ? 'read' : 'write' });
  const c = x.counts.get(l.id) || { open: 0, total: 0 };
  const mask = l.days || 0;
  return {
    id: l.uid, listId: l.id, name: l.name, icon: l.icon || null, area: l.area, sort: l.my_position == null ? 0 : l.my_position,
    updatedAt: iso(ctx, l.updated_at), deleted: false, role: l.my_role || null, canEdit: canEdit(l), canManage: canManage(l, x.fam, ctx.userId),
    owner: { id: l.owner_id, name: await people.name(gc, l.owner_id) }, shared: ms.length > 1, members: others,
    family: !!l.bound_plugin, open: c.open, total: c.total, ...famOf(ctx, l), tasks: x.tasks.get(l.id) || [],
    days: lists.daysOf(mask), remind: l.remind || null, mydayOff: !!l.my_day_off, dayToday: !!(ctx.today && (mask & lists.bitOf(ctx.today))),
  };
}

const itemView = (ctx, r, uid) => ({
  id: r.id, listId: uid, text: r.text, qty: r.qty || null, checked: !!r.checked, checkedBy: r.checked_by == null ? null : r.checked_by,
  updatedAt: iso(ctx, r.updated_at), deleted: !!r.deleted,
});

const byCreated = (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** GET shopping[?since=] */
async function get(gc, ctx, q) {
  let from = null;
  if (q && q.since != null && q.since !== '') {
    const ms = typeof q.since === 'string' && ISO_RE.test(q.since) ? Date.parse(q.since) : NaN;
    if (!Number.isFinite(ms)) throw fail('invalid', { field: 'since' });
    // whole seconds: the serverTime handed out is floored, so >= never misses a change
    from = Math.floor(ms / 1000) * 1000;
  }
  const rows = await rowsOf(gc, ctx.userId);
  const x = await extras(gc, ctx, rows);
  const out = [];
  for (const l of rows) out.push(await view(gc, ctx, l, x));
  const uidOf = new Map(rows.map((l) => [l.id, l.uid]));
  let items = [];
  if (from == null) {
    for (const part of store.chunks(rows.map((l) => l.id))) {
      if (part.length) items.push(...await store.all(gc, `SELECT * FROM shop_items INDEXED BY idx_shop_items_list WHERE list_id IN (${store.marks(part.length)}) AND deleted = 0`, part));
    }
  } else {
    items = (await store.all(gc, 'SELECT * FROM shop_items INDEXED BY idx_shop_items_updated WHERE updated_at >= ? LIMIT 20000', [from])).filter((i) => uidOf.has(i.list_id));
    // lists deleted since: a tombstone for those who were members
    for (const l of await store.all(gc, "SELECT * FROM lists WHERE kind = 'shopping' AND deleted_at IS NOT NULL AND deleted_at >= ? LIMIT 200", [from])) {
      const t = parse(l.trash_json, null);
      const was = l.owner_id === ctx.userId || !!(t && Array.isArray(t.members) && t.members.some((m) => Array.isArray(m) && m[0] === ctx.userId));
      if (was) out.push({ id: l.uid, listId: l.id, name: l.name, icon: l.icon || null, area: l.area, updatedAt: iso(ctx, l.deleted_at), deleted: true });
    }
  }
  items.sort(byCreated);
  return { lists: out, items: items.map((i) => itemView(ctx, i, uidOf.get(i.list_id))), serverTime: serverTime(ctx) };
}

/** GET nav: the shopping lists of an area, short. */
async function nav(gc, ctx, area) {
  const rows = (await rowsOf(gc, ctx.userId)).filter((l) => l.area === area);
  const c = await counts(gc, rows.map((l) => l.id));
  const out = [];
  for (const l of rows) {
    const n = c.get(l.id) || { open: 0, total: 0 };
    const members = await store.one(gc, 'SELECT COUNT(*) AS n FROM list_members WHERE list_id = ?', [l.id]);
    out.push({ id: l.uid, listId: l.id, name: l.name, icon: l.icon || null, open: n.open, total: n.total, family: !!l.bound_plugin, shared: members.n > 1, role: l.my_role });
  }
  return out;
}

// ─── the list a task carries ─────────────────────

/** The shopping lists of `listIds` that `userId` is a member of → Map(list id → Task.attachedList). */
async function attachInfo(gc, userId, listIds) {
  const out = new Map();
  const ids = [...new Set(listIds.filter(Boolean))];
  if (!ids.length || !userId) return out;
  const rows = [];
  for (const part of store.chunks(ids)) {
    rows.push(...await store.all(gc, `SELECT l.id, l.uid, l.name, l.icon, l.bound_plugin FROM lists l JOIN list_members m ON m.list_id = l.id AND m.user_id = ?
      WHERE l.id IN (${store.marks(part.length)}) AND l.deleted_at IS NULL AND l.kind = 'shopping'`, [userId, ...part]));
  }
  const c = await counts(gc, rows.map((r) => r.id));
  for (const r of rows) {
    const n = c.get(r.id) || { open: 0, total: 0 };
    out.set(r.id, { id: r.id, uid: r.uid, name: r.name, icon: r.icon || null, open: n.open, total: n.total, done: n.total - n.open, family: !!r.bound_plugin });
  }
  return out;
}

/** attachedListId / attachedListUid of a task's body → the list's number (null: none); the person must be a member. */
async function attachArg(gc, userId, id, uid) {
  if (id === null || (id === undefined && uid === null)) return null;
  let l = null;
  if (id !== undefined) {
    const n = posInt(id);
    if (!n) throw fail('invalid', { field: 'attachedListId' });
    l = await store.one(gc, 'SELECT l.id, l.kind FROM lists l JOIN list_members m ON m.list_id = l.id AND m.user_id = ? WHERE l.id = ? AND l.deleted_at IS NULL', [userId, n]);
  } else {
    if (typeof uid !== 'string' || !ID_RE.test(uid)) throw fail('invalid', { field: 'attachedListUid' });
    l = await store.one(gc, 'SELECT l.id, l.kind FROM lists l JOIN list_members m ON m.list_id = l.id AND m.user_id = ? WHERE l.uid = ? AND l.deleted_at IS NULL', [userId, uid]);
  }
  if (!l) throw fail('not_found', { field: 'attachedListId' });
  if (l.kind !== 'shopping') throw fail('invalid', { field: 'attachedListId', reason: 'kind' });
  return l.id;
}

/** The first open items of a list as one line: „Milch, Brot, Äpfel, Butter …“ */
async function firstOpen(gc, listId, n = 4) {
  const rows = await store.all(gc, 'SELECT text FROM shop_items INDEXED BY idx_shop_items_list WHERE list_id = ? AND deleted = 0 AND checked = 0 ORDER BY created_at, id LIMIT ?', [listId, n + 1]);
  return rows.slice(0, n).map((r) => r.text).join(', ') + (rows.length > n ? ' …' : '');
}

const lower = (s) => String(s || '').normalize('NFKC').toLowerCase();
const tokens = (s) => lower(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * A line of the quick entry → the list to attach: { via: 'tag' | 'name' | 'word', word?, list, lists } | null. `parsed`
 * is what ui/quickparse.js made of it (the parser itself knows nothing of this).
 */
async function suggest(gc, ctx, text, parsed, area) {
  const a = areaOf(area);
  const rows = (await rowsOf(gc, ctx.userId)).filter((l) => l.area === a);
  if (!rows.length || typeof text !== 'string') return null;
  let via = null;
  let word = null;
  let cands = [];
  const tag = parsed && !parsed.list && parsed.listName ? lower(parsed.listName) : null;
  if (tag) { cands = rows.filter((l) => lower(l.name).startsWith(tag)); if (cands.length) via = 'tag'; }
  const toks = tokens(text);
  if (!via) {
    const hay = ` ${toks.join(' ')} `;
    cands = rows.filter((l) => { const n = tokens(l.name).join(' '); return n.length >= 3 && hay.includes(` ${n} `); });
    if (cands.length) via = 'name';
  }
  if (!via) {
    word = WORDS.find((w) => toks.includes(w)) || null;
    if (word) {
      cands = rows.filter((l) => NAME_HINT.test(lower(l.name)) || l.icon === 'cart');
      if (!cands.length) cands = rows;
      via = 'word';
    }
  }
  if (!via) return null;
  const info = await attachInfo(gc, ctx.userId, cands.map((l) => l.id));
  const out = cands.map((l) => info.get(l.id)).filter(Boolean).slice(0, 20);
  if (!out.length) return null;
  return { via, ...(via === 'word' ? { word } : {}), list: out.length === 1 ? out[0] : null, lists: out };
}

/**
 * The lists in `listIds` where a tick just happened: every one that is ticked off completely now completes the open
 * tasks carrying it → [{ taskId, title, listId (uid) }] — those `ctx.userId` may see.
 */
async function completeAttached(gc, ctx, listIds) {
  const out = [];
  if (!hooks.completeTask || !listIds.length) return out;
  const c = await counts(gc, listIds);
  for (const id of listIds) {
    const n = c.get(id);
    if (!n || !n.total || n.open) continue;
    const l = await store.one(gc, 'SELECT id, uid FROM lists WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!l) continue;
    const rows = await store.all(gc, `SELECT t.* FROM tasks t INDEXED BY idx_tasks_attached JOIN lists tl ON tl.id = t.list_id AND tl.deleted_at IS NULL
      WHERE t.attached_list = ? AND t.done_at IS NULL AND t.deleted_at IS NULL AND t.parent_id IS NULL ORDER BY t.id LIMIT 50`, [id]);
    for (const r of rows) {
      try {
        if (!(await hooks.completeTask(gc, ctx, r))) continue;
      } catch (e) {
        gc.log.warn('list done: task not completed', r.id, (e && (e.code || e.message)) || 'error');
        continue;
      }
      const mine = ctx.userId && await store.one(gc, 'SELECT 1 AS x FROM list_members WHERE list_id = ? AND user_id = ?', [r.list_id, ctx.userId]);
      if (mine) out.push({ taskId: r.id, title: r.title, listId: l.uid });
    }
  }
  return out;
}

// ─── ops ─────────────────────────────────────────

class OpError extends Error { constructor(code) { super(code); this.code = code; } }
const rej = (code) => new OpError(code);

const opId = (v) => { if (typeof v !== 'string' || !ID_RE.test(v)) throw rej('invalid'); return v; };
function opText(v, max, required) {
  if (v == null || v === '') { if (required) throw rej('invalid'); return null; }
  if (typeof v !== 'string') throw rej('invalid');
  const s = line(v, max + 1);
  if ((required && !s) || s.length > max) throw rej('invalid');
  return s || null;
}
function opIcon(v) {
  if (v == null || v === '') return null;
  if (!lists.ICONS.includes(v)) throw rej('invalid');
  return v;
}

const getItem = (gc, id) => store.one(gc, 'SELECT * FROM shop_items WHERE id = ?', [id]);
/** The list of an item as the person sees it (the batch remembers them). */
async function listOfItem(gc, ctx, st, listId) {
  if (!st.acc.has(listId)) {
    st.acc.set(listId, await store.one(gc, `SELECT ${lists.LIST_COLS} FROM lists l JOIN list_members m ON m.list_id = l.id AND m.user_id = ?
      WHERE l.id = ? AND l.deleted_at IS NULL AND l.kind = 'shopping'`, [ctx.userId, listId]));
  }
  return st.acc.get(listId);
}
function editable(l) { if (!l) throw rej('not_found'); if (!canEdit(l)) throw rej('forbidden'); return l; }
function manageable(l, st, ctx) { if (!l) throw rej('not_found'); if (!canManage(l, st.fam, ctx.userId)) throw rej('forbidden'); return l; }
const touch = (st, l) => { st.lists.add(l.id); if (l.bound_plugin) st.bound = true; };

/** Members of the family who are not in the list yet get in (write). */
async function addFamily(gc, listId, fam, now) {
  for (const u of fam.members) await store.run(gc, 'INSERT OR IGNORE INTO list_members (user_id, list_id, role, position, since) VALUES (?, ?, ?, ?, ?)', [u, listId, 'write', 500, now]);
}

/** A list goes to the trash like DELETE lists/<id> (POST lists/<id>/restore brings it back with its members). */
async function trash(gc, l, now) {
  const rows = await store.all(gc, 'SELECT user_id, role, group_id, position, myday_off, since FROM list_members WHERE list_id = ?', [l.id]);
  const t = { mode: 'delete', target: null, moved: [], members: rows.map((r) => [r.user_id, r.role, r.group_id || null, r.position, r.myday_off ? 1 : 0, r.since || null]) };
  await store.run(gc, 'UPDATE lists SET deleted_at = ?, updated_at = ?, trash_json = ? WHERE id = ?', [now, now, JSON.stringify(t), l.id]);
  await store.run(gc, 'DELETE FROM list_members WHERE list_id = ?', [l.id]);
  return rows.map((r) => r.user_id);
}

const OPS = {
  async list_add(gc, ctx, op, st) {
    const id = opId(op.id);
    const name = opText(op.name, NAME_MAX, true);
    const icon = opIcon(op.icon);
    if (op.family != null && typeof op.family !== 'boolean') throw rej('invalid');
    const have = await store.one(gc, 'SELECT id, owner_id FROM lists WHERE uid = ?', [id]);
    if (have) {
      // replayed: already there (or already deleted) — someone else's id is not ours to take
      if (have.owner_id === ctx.userId || await store.one(gc, 'SELECT 1 AS x FROM list_members WHERE list_id = ? AND user_id = ?', [have.id, ctx.userId])) return;
      throw rej('forbidden');
    }
    if (op.family && !(st.fam && st.fam.parents.has(ctx.userId))) throw rej('forbidden');
    const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM lists WHERE owner_id = ? AND deleted_at IS NULL', [ctx.userId]);
    if (n.n >= LISTS_MAX) throw rej('too_many');
    const r = await store.run(gc, "INSERT INTO lists (owner_id, area, name, icon, kind, uid, bound_plugin, created_at, updated_at) VALUES (?, ?, ?, ?, 'shopping', ?, ?, ?, ?)",
      [ctx.userId, areaOf(op.area), name, icon, id, op.family ? st.fam.plugin : null, ctx.now, ctx.now]);
    const lid = Number(r.lastInsertRowid);
    const pos = await store.one(gc, 'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM list_members WHERE user_id = ?', [ctx.userId]);
    await store.run(gc, 'INSERT INTO list_members (user_id, list_id, role, position, since) VALUES (?, ?, ?, ?, ?)', [ctx.userId, lid, 'owner', pos.p, ctx.now]);
    if (op.family) await addFamily(gc, lid, st.fam, ctx.now);
    st.lists.add(lid);
    st.nav = true;
    if (op.family) st.bound = true;
  },
  async list_rename(gc, ctx, op, st) {
    const id = opId(op.id);
    const name = opText(op.name, NAME_MAX, true);
    const icon = op.icon === undefined ? undefined : opIcon(op.icon);
    const l = manageable(await byUid(gc, ctx.userId, id), st, ctx);
    if (l.name === name && (icon === undefined || (l.icon || null) === icon)) return;
    await store.run(gc, 'UPDATE lists SET name = ?, icon = ?, updated_at = ? WHERE id = ?', [name, icon === undefined ? l.icon : icon, ctx.now, l.id]);
    st.acc.delete(l.id);
    st.nav = true;
    touch(st, l);
  },
  async list_delete(gc, ctx, op, st) {
    const id = opId(op.id);
    const any = await store.one(gc, "SELECT id, owner_id, deleted_at FROM lists WHERE uid = ? AND kind = 'shopping'", [id]);
    if (!any) throw rej('not_found');
    if (any.deleted_at) return;
    const l = manageable(await byUid(gc, ctx.userId, id), st, ctx);
    for (const u of await trash(gc, l, ctx.now)) st.users.add(u);
    st.acc.delete(l.id);
    st.nav = true;
    if (l.bound_plugin) st.bound = true;
  },
  async item_add(gc, ctx, op, st) {
    const id = opId(op.id);
    const listId = opId(op.listId);
    const text = opText(op.text, TEXT_MAX, true);
    const qty = opText(op.qty, QTY_MAX, false);
    const have = await getItem(gc, id);
    if (have) {
      // replayed (also when deleted meanwhile); an id of a list the person does not see is not theirs
      if (!(await listOfItem(gc, ctx, st, have.list_id))) throw rej('forbidden');
      return;
    }
    const l = editable(await byUid(gc, ctx.userId, listId));
    await store.run(gc, 'INSERT INTO shop_items (id, list_id, text, qty, checked, checked_by, created_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?, 0)',
      [id, l.id, text, qty, ctx.userId, ctx.now, ctx.now]);
    touch(st, l);
  },
  async item_edit(gc, ctx, op, st) {
    const id = opId(op.id);
    if (op.text === undefined && op.qty === undefined) throw rej('invalid');
    const text = op.text === undefined ? undefined : opText(op.text, TEXT_MAX, true);
    const qty = op.qty === undefined ? undefined : opText(op.qty, QTY_MAX, false);
    const it = await getItem(gc, id);
    const l = editable(it ? await listOfItem(gc, ctx, st, it.list_id) : null);
    if (it.deleted) throw rej('not_found');
    const next = { text: text === undefined ? it.text : text, qty: qty === undefined ? it.qty : qty };
    if (next.text === it.text && (next.qty || null) === (it.qty || null)) return;
    await store.run(gc, 'UPDATE shop_items SET text = ?, qty = ?, updated_at = ? WHERE id = ?', [next.text, next.qty, ctx.now, id]);
    touch(st, l);
  },
  async item_check(gc, ctx, op, st) {
    const id = opId(op.id);
    if (typeof op.checked !== 'boolean') throw rej('invalid');
    const it = await getItem(gc, id);
    const l = editable(it ? await listOfItem(gc, ctx, st, it.list_id) : null);
    if (it.deleted) throw rej('not_found');
    if (!!it.checked === op.checked) return;
    await store.run(gc, 'UPDATE shop_items SET checked = ?, checked_by = ?, updated_at = ? WHERE id = ?', [op.checked ? 1 : 0, op.checked ? ctx.userId : null, ctx.now, id]);
    if (op.checked) st.ticked.add(l.id);
    touch(st, l);
  },
  async item_delete(gc, ctx, op, st) {
    const id = opId(op.id);
    const it = await getItem(gc, id);
    const l = editable(it ? await listOfItem(gc, ctx, st, it.list_id) : null);
    if (it.deleted) return;
    await store.run(gc, 'UPDATE shop_items SET deleted = 1, updated_at = ? WHERE id = ?', [ctx.now, id]);
    touch(st, l);
  },
  async clear_checked(gc, ctx, op, st) {
    const l = editable(await byUid(gc, ctx.userId, opId(op.listId)));
    const r = await store.run(gc, 'UPDATE shop_items SET deleted = 1, updated_at = ? WHERE list_id = ? AND checked = 1 AND deleted = 0', [ctx.now, l.id]);
    if (r && r.changes) touch(st, l);
  },
};

/** What a batch of changes leaves to do after its commit: tell the people, tell Familie, complete tasks. */
async function after(gc, ctx, st) {
  for (const id of st.lists) for (const u of await lists.memberIds(gc, id)) st.users.add(u);
  if (st.users.size) {
    events.changed(gc, [...st.users], 'shopping');
    if (st.nav) events.changed(gc, [...st.users], 'lists');
  }
  if (st.bound && !st.quiet) await markDirty(gc);
  return completeAttached(gc, ctx, [...st.ticked]);
}

const batch = async (gc) => ({ lists: new Set(), users: new Set(), ticked: new Set(), acc: new Map(), fam: await family(gc), bound: false, nav: false, quiet: false });

/** POST shopping/ops */
async function applyOps(gc, ctx, body) {
  const ops = body && body.ops;
  if (!Array.isArray(ops) || ops.length > MAX_OPS) throw fail('invalid', { field: 'ops' });
  const st = await batch(gc);
  let applied = 0;
  const rejected = [];
  await store.tx(gc, async () => {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const fn = op && typeof op === 'object' && !Array.isArray(op) && typeof op.op === 'string' && Object.prototype.hasOwnProperty.call(OPS, op.op) ? OPS[op.op] : null;
      if (!fn) { rejected.push({ index: i, code: 'invalid' }); continue; }
      try {
        await fn(gc, ctx, op, st);
        applied++;
      } catch (e) {
        if (!(e instanceof OpError)) throw e;
        rejected.push({ index: i, code: e.code });
      }
    }
  });
  const completed = await after(gc, ctx, st);
  return { applied, rejected, serverTime: serverTime(ctx), completed };
}

// ─── the family ──────────────────────────────────

/** PUT shopping/lists/<uid>/family { on } */
async function setFamily(gc, ctx, uid, b) {
  const l = await byUid(gc, ctx.userId, uid);
  if (!l) throw fail('not_found');
  const fam = await family(gc);
  if (typeof b.on !== 'boolean') throw fail('invalid', { field: 'on' });
  if (!canManage(l, fam, ctx.userId)) throw fail('forbidden', { reason: 'owner' });
  if (b.on) {
    if (!fam) throw fail('unavailable');
    if (!fam.parents.has(ctx.userId)) throw fail('forbidden', { reason: 'parent' });
    const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM lists WHERE bound_plugin = ? AND deleted_at IS NULL', [fam.plugin]);
    if (!l.bound_plugin && n.n >= FAMILY_LISTS_MAX) throw fail('too_many');
  }
  const before = await lists.memberIds(gc, l.id);
  if (!!l.bound_plugin !== b.on) {
    await store.tx(gc, async () => {
      await store.run(gc, 'UPDATE lists SET bound_plugin = ?, fam_json = NULL, updated_at = ? WHERE id = ?', [b.on ? fam.plugin : null, ctx.now, l.id]);
      if (b.on) await addFamily(gc, l.id, fam, ctx.now);
      // off: the family leaves the list again (the owner and people shared with by hand stay)
      else if (fam) for (const u of fam.members) if (u !== l.owner_id) await store.run(gc, 'DELETE FROM list_members WHERE user_id = ? AND list_id = ?', [u, l.id]);
    });
    const users = [...new Set([...before, ...await lists.memberIds(gc, l.id)])];
    events.changed(gc, users, 'shopping');
    events.changed(gc, users, 'lists');
    await markDirty(gc);
  }
  const row = await byUid(gc, ctx.userId, uid);
  return { list: await view(gc, ctx, row, await extras(gc, ctx, [row])) };
}

/** POST shopping/lists/<uid>/going | assign — Familie does it (cards, pushes) and says what it knows of the list now. */
async function forward(gc, ctx, uid, action, body) {
  const l = await byUid(gc, ctx.userId, uid);
  if (!l) throw fail('not_found');
  if (!l.bound_plugin) throw fail('invalid', { field: 'family' });
  if (!(await offered(gc, l.bound_plugin, 'shopping_action'))) throw fail('unavailable');
  let res;
  try {
    res = await gc.services.call({ plugin: l.bound_plugin, service: 'shopping_action', userId: ctx.userId, payload: { v: 1, action, listId: uid, body: body && typeof body === 'object' ? body : {} } });
  } catch (e) {
    gc.log.warn('shopping action failed', action, (e && (e.code || e.message)) || 'error');
    throw fail('unavailable');
  }
  if (!res || res.ok !== true) {
    const code = res && typeof res.code === 'string' && /^[a-z_]{1,40}$/.test(res.code) ? res.code : 'failed';
    throw fail(code, { ...(res && res.field ? { field: String(res.field).slice(0, 40) } : {}), ...(res && Number.isSafeInteger(res.retryAfter) ? { retryAfter: res.retryAfter } : {}) });
  }
  if (res.family && typeof res.family === 'object') await setFam(gc, l, res.family, ctx.now);
  const row = await byUid(gc, ctx.userId, uid);
  return {
    list: row ? await view(gc, ctx, row, await extras(gc, ctx, [row])) : null,
    notified: res.notified === undefined ? null : res.notified, ...(res.chat !== undefined ? { chat: res.chat } : {}),
  };
}

/** What Familie knows of a list, in one form → the JSON kept in lists.fam_json (null: nothing). */
function famJson(f) {
  const o = f && typeof f === 'object' ? f : {};
  const a = o.assignee && typeof o.assignee === 'object' && posInt(o.assignee.userId) ? {
    userId: posInt(o.assignee.userId), by: posInt(o.assignee.by), at: typeof o.assignee.at === 'string' ? o.assignee.at.slice(0, 40) : null,
    state: ['open', 'taken', 'declined'].includes(o.assignee.state) ? o.assignee.state : 'open', notify: typeof o.assignee.notify === 'string' ? o.assignee.notify.slice(0, 20) : null,
  } : null;
  const going = (Array.isArray(o.going) ? o.going : []).filter((g) => g && posInt(g.userId) && typeof g.at === 'string').slice(0, 20).map((g) => ({ userId: posInt(g.userId), at: g.at.slice(0, 40) }));
  const dueAt = typeof o.dueAt === 'string' ? o.dueAt.slice(0, 40) : null;
  return a || dueAt || going.length ? JSON.stringify({ assignee: a, dueAt, going }) : null;
}

/** Keep what Familie knows of list `l` → whether it changed. */
async function setFam(gc, l, f, now) {
  const next = famJson(f);
  if ((l.fam_json || null) === next) return false;
  await store.run(gc, 'UPDATE lists SET fam_json = ?, updated_at = ? WHERE id = ?', [next, now, l.id]);
  events.changed(gc, await lists.memberIds(gc, l.id), 'shopping');
  return true;
}

// ─── services for Familie ────────────────────────

function owner(caller) { if (!OWNERS.includes(caller)) throw fail('forbidden'); return caller; }

/** shopping_bind { members: [userId…], parents: [userId…] } | { release: true } (no user) */
async function bind(gc, base, caller, p) {
  owner(caller);
  const before = await family(gc);
  if (p.release === true) {
    const rows = await store.all(gc, 'SELECT id FROM lists WHERE bound_plugin = ?', [caller]);
    await store.tx(gc, async () => {
      await store.run(gc, 'UPDATE lists SET bound_plugin = NULL, fam_json = NULL, updated_at = ? WHERE bound_plugin = ?', [base.now, caller]);
      await store.run(gc, 'DELETE FROM shop_family WHERE plugin = ?', [caller]);
    });
    state.fam = null;
    for (const r of rows) events.changed(gc, await lists.memberIds(gc, r.id), 'shopping');
    return { ok: true, released: rows.length };
  }
  const members = ints(p.members);
  const parents = ints(p.parents).filter((u) => members.includes(u));
  if (!members.length || members.length > 50 || !parents.length || (Array.isArray(p.members) && p.members.length !== members.length)) throw fail('invalid', { field: 'members' });
  const left = before ? [...before.members].filter((u) => !members.includes(u)) : [];
  const rows = await store.all(gc, 'SELECT id, owner_id FROM lists WHERE bound_plugin = ? AND deleted_at IS NULL', [caller]);
  const users = new Set([...members, ...left]);
  await store.tx(gc, async () => {
    await store.run(gc, `INSERT INTO shop_family (plugin, members, parents, at) VALUES (?, ?, ?, ?)
      ON CONFLICT(plugin) DO UPDATE SET members = excluded.members, parents = excluded.parents, at = excluded.at`, [caller, JSON.stringify(members), JSON.stringify(parents), base.now]);
    for (const l of rows) {
      // whoever left the family leaves its lists; a list of theirs goes on with the first parent
      if (left.includes(l.owner_id)) {
        await store.run(gc, 'UPDATE lists SET owner_id = ?, updated_at = ? WHERE id = ?', [parents[0], base.now, l.id]);
        await store.run(gc, "INSERT INTO list_members (user_id, list_id, role, position, since) VALUES (?, ?, 'owner', 500, ?) ON CONFLICT(user_id, list_id) DO UPDATE SET role = 'owner'", [parents[0], l.id, base.now]);
      }
      for (const u of left) {
        await store.run(gc, 'DELETE FROM list_members WHERE user_id = ? AND list_id = ?', [u, l.id]);
        await store.run(gc, 'UPDATE tasks SET assignee_id = NULL WHERE list_id = ? AND assignee_id = ?', [l.id, u]);
      }
      await addFamily(gc, l.id, { members }, base.now);
    }
  });
  state.fam = null;
  events.changed(gc, [...users], 'shopping');
  events.changed(gc, [...users], 'lists');
  return { ok: true, lists: rows.length };
}

/** The family of `caller`, or not_found (a hub that does not know it: Familie's lists are its own again). */
async function boundFamily(gc, caller) {
  owner(caller);
  const fam = await family(gc);
  if (!fam || fam.plugin !== caller) throw fail('not_found');
  return fam;
}

const member = (fam, v) => { const u = posInt(v); return u && fam.members.has(u) ? u : null; };

/**
 * shopping_put { lists: [{ id, name, icon?, sort?, deleted?, by?, assignee?, dueAt?, going? }], items: [{ id, listId,
 * text, qty?, checked, checkedBy?, deleted?, createdBy?, createdAt?, by? }] } (no user) — rows of Familie's copy. A row
 * is written when it differs from what is here (so a row sent again, or sent back, changes nothing).
 * → { ok, lists, items (written), rejected: [{ kind, id, code }], completed }
 */
async function put(gc, base, caller, p) {
  const fam = await boundFamily(gc, caller);
  const inL = Array.isArray(p.lists) ? p.lists : [];
  const inI = Array.isArray(p.items) ? p.items : [];
  if (inL.length > 100 || inI.length > 200) throw fail('invalid', { field: 'items' });
  const st = await batch(gc);
  st.quiet = true;
  const rejected = [];
  const first = [...fam.parents][0];
  let nl = 0;
  let ni = 0;
  let actor = null;
  await store.tx(gc, async () => {
    for (const x of inL) {
      const uid = x && typeof x.id === 'string' && ID_RE.test(x.id) ? x.id : null;
      const name = uid ? line(x.name, NAME_MAX) : '';
      if (!uid || !name) { rejected.push({ kind: 'list', id: x && typeof x.id === 'string' ? x.id.slice(0, 64) : null, code: 'invalid' }); continue; }
      const by = member(fam, x.by);
      const icon = iconOf(x.icon);
      const fj = famJson(x);
      let l = await store.one(gc, 'SELECT * FROM lists WHERE uid = ?', [uid]);
      if (!l) {
        if (x.deleted) continue;
        const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM lists WHERE bound_plugin = ? AND deleted_at IS NULL', [caller]);
        if (n.n >= FAMILY_LISTS_MAX) { rejected.push({ kind: 'list', id: uid, code: 'too_many' }); continue; }
        const own = by && fam.parents.has(by) ? by : first;
        const r = await store.run(gc, "INSERT INTO lists (owner_id, area, name, icon, kind, uid, bound_plugin, fam_json, created_at, updated_at) VALUES (?, 'private', ?, ?, 'shopping', ?, ?, ?, ?, ?)",
          [own, name, icon, uid, caller, fj, base.now, base.now]);
        const lid = Number(r.lastInsertRowid);
        const pos = 500 + (Number.isSafeInteger(x.sort) && x.sort >= 0 && x.sort < 10000 ? x.sort : 0);
        await store.run(gc, "INSERT INTO list_members (user_id, list_id, role, position, since) VALUES (?, ?, 'owner', ?, ?)", [own, lid, pos, base.now]);
        for (const u of fam.members) await store.run(gc, 'INSERT OR IGNORE INTO list_members (user_id, list_id, role, position, since) VALUES (?, ?, ?, ?, ?)', [u, lid, 'write', pos, base.now]);
        st.lists.add(lid);
        st.nav = true;
        nl++;
        continue;
      }
      if (l.kind !== 'shopping' || (l.bound_plugin && l.bound_plugin !== caller) || (!l.bound_plugin && !fam.members.has(l.owner_id))) { rejected.push({ kind: 'list', id: uid, code: 'forbidden' }); continue; }
      if (x.deleted) {
        if (l.deleted_at) continue;
        if (!l.bound_plugin) { rejected.push({ kind: 'list', id: uid, code: 'forbidden' }); continue; }
        for (const u of await trash(gc, l, base.now)) st.users.add(u);
        st.nav = true;
        nl++;
        continue;
      }
      let changed = false;
      if (l.deleted_at) {
        // deleted here, changed in Familie later: it is back, with the family
        await store.run(gc, 'UPDATE lists SET deleted_at = NULL, trash_json = NULL, updated_at = ? WHERE id = ?', [base.now, l.id]);
        await store.run(gc, "INSERT OR IGNORE INTO list_members (user_id, list_id, role, position, since) VALUES (?, ?, 'owner', 500, ?)", [l.owner_id, l.id, base.now]);
        changed = true;
      }
      if (!l.bound_plugin || l.deleted_at) { await addFamily(gc, l.id, fam, base.now); changed = true; }
      // an icon Familie has and the hub does not know leaves the hub's as it is
      const nextIcon = x.icon === undefined ? (l.icon || null) : (x.icon == null || x.icon === '' ? null : (icon || l.icon || null));
      if (changed || l.name !== name || (l.icon || null) !== nextIcon || (l.fam_json || null) !== fj) {
        await store.run(gc, 'UPDATE lists SET name = ?, icon = ?, bound_plugin = ?, fam_json = ?, updated_at = ? WHERE id = ?', [name, nextIcon, caller, fj, base.now, l.id]);
        if (changed || l.name !== name) st.nav = true;
        st.lists.add(l.id);
        nl++;
      }
    }
    const listOf = new Map();
    for (const x of inI) {
      const id = x && typeof x.id === 'string' && ID_RE.test(x.id) ? x.id : null;
      const uid = id && typeof x.listId === 'string' && ID_RE.test(x.listId) ? x.listId : null;
      const text = uid ? line(x.text, TEXT_MAX) : '';
      if (!uid || !text) { rejected.push({ kind: 'item', id: x && typeof x.id === 'string' ? x.id.slice(0, 64) : null, code: 'invalid' }); continue; }
      if (!listOf.has(uid)) listOf.set(uid, await store.one(gc, "SELECT id FROM lists WHERE uid = ? AND bound_plugin = ? AND deleted_at IS NULL AND kind = 'shopping'", [uid, caller]));
      const l = listOf.get(uid);
      if (!l) { rejected.push({ kind: 'item', id, code: 'not_found' }); continue; }
      const qty = line(x.qty, QTY_MAX) || null;
      const checked = x.checked === true ? 1 : 0;
      const checkedBy = checked ? posInt(x.checkedBy) : null;
      const deleted = x.deleted === true ? 1 : 0;
      const it = await getItem(gc, id);
      if (!it) {
        if (deleted) continue;
        const at = Number.isSafeInteger(x.createdAt) && x.createdAt > 0 && x.createdAt <= base.now ? x.createdAt : base.now;
        await store.run(gc, 'INSERT INTO shop_items (id, list_id, text, qty, checked, checked_by, created_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
          [id, l.id, text, qty, checked, checkedBy, posInt(x.createdBy), at, base.now]);
      } else {
        if (it.list_id !== l.id) { rejected.push({ kind: 'item', id, code: 'forbidden' }); continue; }
        if (it.text === text && (it.qty || null) === qty && it.checked === checked && it.deleted === deleted && (!checked || (it.checked_by || null) === checkedBy)) continue;
        await store.run(gc, 'UPDATE shop_items SET text = ?, qty = ?, checked = ?, checked_by = ?, deleted = ?, updated_at = ? WHERE id = ?', [text, qty, checked, checkedBy, deleted, base.now, id]);
        if (checked && !it.checked && !deleted) { st.ticked.add(l.id); actor = member(fam, x.by) || member(fam, x.checkedBy) || actor; }
      }
      if (checked && !it && !deleted) { st.ticked.add(l.id); actor = member(fam, x.by) || member(fam, x.checkedBy) || actor; }
      st.lists.add(l.id);
      ni++;
    }
  });
  const completed = await after(gc, { ...base, userId: actor || first }, st);
  return { ok: true, lists: nl, items: ni, rejected, completed: completed.map((c) => ({ taskId: c.taskId, listId: c.listId })) };
}

/**
 * shopping_list { since?: ms, cursor? } (no user) → { ok, lists: [every family list, in pages], items: [changed since,
 * tombstones too], cursor, now } — a family list Familie has and this does not list is gone here.
 */
async function listFor(gc, base, caller, p) {
  await boundFamily(gc, caller);
  const since = Number.isSafeInteger(p.since) && p.since > 0 ? p.since : 0;
  const cur = /^([LI])(\d{1,15})(?::(.{1,64}))?$/.exec(typeof p.cursor === 'string' ? p.cursor : 'L0');
  if (!cur) throw fail('invalid', { field: 'cursor' });
  const out = { ok: true, lists: [], items: [], cursor: null, now: base.now };
  let size = 200;
  if (cur[1] === 'L') {
    const rows = await store.all(gc, 'SELECT * FROM lists INDEXED BY idx_lists_bound WHERE bound_plugin = ? AND deleted_at IS NULL AND id > ? ORDER BY id LIMIT 40', [caller, Number(cur[2])]);
    for (const l of rows) {
      const pos = await store.one(gc, 'SELECT position FROM list_members WHERE list_id = ? AND user_id = ?', [l.id, l.owner_id]);
      const o = { id: l.uid, name: l.name, icon: l.icon || null, position: pos ? pos.position : 0, ownerId: l.owner_id, createdAt: l.created_at, updatedAt: l.updated_at };
      const s = JSON.stringify(o).length + 1;
      if (size + s > ANSWER_MAX) return out;
      size += s;
      out.lists.push(o);
      out.cursor = `L${l.id}`;
    }
    if (rows.length === 40) return out;
    out.cursor = null;
  }
  // the items since (>= since: Familie asks from the moment of its last pull), by (updated_at, id)
  const at = cur[1] === 'I' ? Number(cur[2]) : since;
  const from = cur[1] === 'I' && cur[3] ? cur[3] : '';
  const rows = await store.all(gc, `SELECT i.*, l.uid FROM shop_items i INDEXED BY idx_shop_items_updated JOIN lists l ON l.id = i.list_id AND l.bound_plugin = ? AND l.deleted_at IS NULL
    WHERE (i.updated_at, i.id) > (?, ?) ORDER BY i.updated_at, i.id LIMIT 80`, [caller, at, from]);
  let last = null;
  for (const i of rows) {
    const o = { id: i.id, listId: i.uid, text: i.text, qty: i.qty || null, checked: !!i.checked, checkedBy: i.checked_by || null, deleted: !!i.deleted, createdBy: i.created_by || null, createdAt: i.created_at, updatedAt: i.updated_at };
    const s = JSON.stringify(o).length + 1;
    if (size + s > ANSWER_MAX) break;
    size += s;
    out.items.push(o);
    last = i;
  }
  if (last && (out.items.length < rows.length || rows.length === 80)) out.cursor = `I${last.updated_at}:${last.id}`;
  return out;
}

// ─── telling Familie ─────────────────────────────

/** Something of a family list changed here: Familie is told in a second (else by the background run). */
async function markDirty(gc) {
  const r = await store.run(gc, 'UPDATE shop_family SET dirty = 1');
  if (!r || !r.changes) return;
  if (state.noTimer || state.timer) return;
  state.timer = setTimeout(() => { state.timer = null; tell(gc).catch(() => {}); }, 1000);
  if (typeof state.timer.unref === 'function') state.timer.unref();
}

/** shopping_changed to Familie when something waits → whether it was told. */
async function tell(gc) {
  const f = await store.one(gc, 'SELECT plugin FROM shop_family WHERE dirty = 1');
  if (!f || !(await offered(gc, f.plugin, 'shopping_changed'))) return false;
  await store.run(gc, 'UPDATE shop_family SET dirty = 0 WHERE plugin = ?', [f.plugin]);
  try {
    const res = await gc.services.call({ plugin: f.plugin, service: 'shopping_changed', payload: { v: 1, at: clock.now() } });
    if (res && res.ok === true) return true;
  } catch { /* told again by the next run */ }
  await store.run(gc, 'UPDATE shop_family SET dirty = 1 WHERE plugin = ?', [f.plugin]);
  return false;
}

/** A list changed through the list routes (PATCH / DELETE lists/<id>, members, restore): the people and Familie hear of it. */
async function listChanged(gc, l, users) {
  if (!l || l.kind !== 'shopping') return;
  events.changed(gc, users || await lists.memberIds(gc, l.id), 'shopping');
  if (l.bound_plugin) await markDirty(gc);
}

/** Background: tell Familie what waits; hourly: tombstones after 30 days, the items of lists that are gone for good. */
async function tick(gc, ctx) {
  const told = await tell(gc);
  if (!tick.lastPurge || ctx.now - tick.lastPurge > HOUR || ctx.now < tick.lastPurge) {
    tick.lastPurge = ctx.now;
    await store.run(gc, 'DELETE FROM shop_items WHERE deleted = 1 AND updated_at < ?', [ctx.now - TOMBSTONE_DAYS * DAY]);
  }
  return told;
}

/** Before a list in the trash is removed for good (server/housekeeping.js): its items go. */
function purgeLists(gc, before) {
  return store.run(gc, "DELETE FROM shop_items WHERE list_id IN (SELECT id FROM lists WHERE kind = 'shopping' AND deleted_at IS NOT NULL AND deleted_at < ?)", [before]);
}

function stop() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

module.exports = {
  FAMILIE, ID_RE, MAX_OPS, WORDS, hooks, state, reset, stop, family, meInfo, get, nav, view, byUid, counts, openCounts, attachInfo, attachArg, firstOpen, suggest,
  applyOps, setFamily, forward, bind, put, listFor, tell, tick, purgeLists, listChanged, markDirty, completeAttached,
};
