'use strict';

// 1.6.0: the family's tasks in the hub (migrations/008_family_tasks.sql; README "1.6.0").
//
// Nothing moves by itself. After the move (a button on Familie's settings page) the family's tasks live here, in ONE
// list „Familie“ whose members are the family (lists.fam_tasks; Familie tells who that is and who the parents are —
// tasks_bind). Familie keeps a copy for its own pages, the wall tablet, the cards in the chat and older apps; the stars
// are counted and settled there:
//
//   tasks_bind { members, parents, stars, name?, moved? } | { release: true }   the family and its list
//   tasks_put  { tasks: [FT] }      rows of Familie's copy → here, by their uid (written when they differ; a row sent
//                                   again changes nothing, nothing is made twice)
//   tasks_list { rev?, cursor? }    every task Familie keeps a copy of, and what was ticked off here (or taken back)
//                                   since `rev` — the stars Familie books
// What changes here is told to Familie with tasks_changed (a second later, else by the background run); what Familie
// wrote itself is not told back.
//
// FT — a task as the two plugins tell it each other:
//   { uid, kind: 'task' | 'place', title, note?, turn: null | 'rotate' | 'first', people: [userId], assignee: userId | null,
//     due: { date, time } | null, repeat: rule | null, stars, remind, remindAt?, done, doneBy, doneFor, doneAt, deleted,
//     createdBy, createdAt, place?: { lat, lon, radius, trigger, consent, owner, target, listUid } }
//   uid: 'f<n>' a task of Familie, 'p<n>' a place reminder of Familie, 'h<n>' a task made here.
//
// In the family list (rules(), used by server/tasks.js): parents change everything and tick off for a child; a child
// ticks off what is its own to do, makes tasks of its own, does not change or delete a task a parent made and gives no
// stars. A place reminder of Familie is no task of the family list: it lives in its owner's own list, or — set for
// someone else — in a list the two share, and nobody else sees it.

const store = require('./store');
const clock = require('./clock');
const lists = require('./lists');
const people = require('./people');
const events = require('./events');
const fts = require('./fts');
const calsync = require('./calsync');
const R = require('../ui/repeat');
const { t } = require('./text');
const { fail, posInt, line, text, parse, isDate, isTime } = require('./util');

const FAMILIE = 'gatecontrol-familie';
const OWNERS = [FAMILIE];
const UID_RE = /^[fph][0-9]{1,15}$/;
const TURNS = ['rotate', 'first'];
const TITLE_MAX = 300;
const NOTE_MAX = 2000;
const PUT_MAX = 50;
const ANSWER_MAX = 11000;
const DONE_KEEP_MS = 5 * 86400000;   // a done task is listed this long (Familie keeps its own copy of one 7 days)
const LEDGER_KEEP_MS = 60 * 86400000;
const STARS_MAX = 10;

/** Hooks between modules (set by server/api.js): complete(gc, ctx, id, body) ticks a task off like POST tasks/<id>/complete. */
const hooks = { complete: null, placeSync: null };
const state = { fam: null, timer: null, noTimer: false };

function reset() {
  if (state.timer) clearTimeout(state.timer);
  state.fam = null;
  state.timer = null;
}

const ints = (v) => [...new Set((Array.isArray(v) ? v : []).map(posInt).filter(Boolean))];

/** The family as Familie told it → { plugin, members: Set, parents: Set, listId, stars, moved } | null. */
async function family(gc) {
  if (state.fam) return state.fam.v;
  const r = await store.one(gc, 'SELECT * FROM task_family LIMIT 1');
  const v = r ? { plugin: r.plugin, members: new Set(ints(parse(r.members, []))), parents: new Set(ints(parse(r.parents, []))), listId: r.list_id || null, stars: !!r.stars, moved: parse(r.moved, null) } : null;
  state.fam = { v };
  return v;
}

async function offered(gc, service) {
  try { return !!(gc.services && typeof gc.services.available === 'function' && (await gc.services.available(FAMILIE, service)) === true); } catch { return false; }
}

/** me.familyTasks */
async function meInfo(gc, ctx) {
  const fam = await family(gc);
  const mine = !!(fam && fam.members.has(ctx.userId));
  let seen = true;
  if (mine && fam.moved && fam.moved.at) {
    const s = await store.one(gc, 'SELECT at FROM fam_seen WHERE user_id = ?', [ctx.userId]);
    seen = !!(s && s.at >= fam.moved.at);
  }
  return {
    available: await offered(gc, 'tasks_changed'), bound: mine, listId: mine ? fam.listId : null, parent: !!(mine && fam.parents.has(ctx.userId)), stars: !!(mine && fam.stars), starsMax: STARS_MAX,
    // „Umzug abgeschlossen“: what came from Familie, shown once per person (POST family/seen)
    moved: mine && fam.moved && fam.moved.at ? { at: new Date(fam.moved.at).toISOString().replace(/\.\d{3}Z$/, 'Z'), tasks: fam.moved.tasks || 0, places: fam.moved.places || 0, seen } : null,
  };
}

/** POST family/seen — the note about the move was read. */
async function seen(gc, ctx) {
  await store.run(gc, 'INSERT INTO fam_seen (user_id, at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET at = excluded.at', [ctx.userId, ctx.now]);
  return { ok: true };
}

// ─── the rules of the family list (server/tasks.js) ───

/**
 * What the family list means for `userId` and task row `r` → null (no family list: the list's own roles decide) |
 * { parent, protected (made by a parent: a child does not change it), mine (theirs to tick off) }.
 */
function rules(fam, userId, r) {
  if (!fam || !fam.listId || r.list_id !== fam.listId) return null;
  const parent = fam.parents.has(userId);
  const ppl = ints(parse(r.people_json, []));
  const mine = r.turn === 'first' ? ppl.includes(userId) : (!r.assignee_id || r.assignee_id === userId);
  return { parent, protected: !parent && fam.parents.has(r.created_by), mine: parent || mine };
}

const isFamilyList = (fam, listId) => !!(fam && fam.listId && fam.listId === listId);

// ─── what was ticked off here ────────────────────

async function nextRev(gc) {
  const r = await store.one(gc, 'SELECT COALESCE(MAX(rev), 0) + 1 AS n FROM fam_done');
  return r.n;
}

/**
 * A task of the family list was ticked off here (or opened again) — inside the transaction of the change. Familie
 * fetches the row and books the stars. `r` is the task's row before the change; `credit` for whom.
 */
async function booked(gc, ctx, fam, r, done, credit) {
  if (!isFamilyList(fam, r.list_id) || r.parent_id) return false;
  if (done) {
    const uid = r.fam_uid || 'h' + r.id;
    if (!r.fam_uid) await store.run(gc, 'UPDATE tasks SET fam_uid = ? WHERE id = ? AND fam_uid IS NULL', [uid, r.id]);
    await store.run(gc, 'INSERT INTO fam_done (uid, task_id, user_id, by_id, due_date, stars, at, undone, rev) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
      [uid, r.id, credit || ctx.userId, ctx.userId, r.due_date || null, r.stars || 0, ctx.now, await nextRev(gc)]);
    return true;
  }
  const last = await store.one(gc, 'SELECT seq FROM fam_done INDEXED BY idx_fam_done_task WHERE task_id = ? AND undone = 0 ORDER BY seq DESC LIMIT 1', [r.id]);
  if (!last) return false;
  await store.run(gc, 'UPDATE fam_done SET undone = 1, rev = ? WHERE seq = ?', [await nextRev(gc), last.seq]);
  return true;
}

// ─── telling Familie ─────────────────────────────

/** Something Familie keeps a copy of changed here: it is told in a second (else by the background run). */
async function markDirty(gc) {
  const r = await store.run(gc, 'UPDATE task_family SET dirty = 1');
  if (!r || !r.changes) return;
  if (state.noTimer || state.timer) return;
  state.timer = setTimeout(() => { state.timer = null; tell(gc).catch(() => {}); }, 1000);
  if (typeof state.timer.unref === 'function') state.timer.unref();
}

/** A task changed through the hub's own routes: Familie hears of it when it keeps a copy (family list, a place reminder). */
async function changed(gc, r) {
  if (!r) return;
  const fam = await family(gc);
  if (!fam) return;
  if (isFamilyList(fam, r.list_id) || r.fam_uid) await markDirty(gc);
}

/** tasks_changed to Familie when something waits → whether it was told. */
async function tell(gc) {
  const f = await store.one(gc, 'SELECT plugin FROM task_family WHERE dirty = 1');
  if (!f || !(await offered(gc, 'tasks_changed'))) return false;
  await store.run(gc, 'UPDATE task_family SET dirty = 0 WHERE plugin = ?', [f.plugin]);
  try {
    const res = await gc.services.call({ plugin: f.plugin, service: 'tasks_changed', payload: { v: 1, at: clock.now() } });
    if (res && res.ok === true) return true;
  } catch { /* told again by the next run */ }
  await store.run(gc, 'UPDATE task_family SET dirty = 1 WHERE plugin = ?', [f.plugin]);
  return false;
}

/** Background: tell Familie what waits; old rows of what was ticked off go. */
async function tick(gc, ctx) {
  const told = await tell(gc);
  if (!tick.lastPurge || ctx.now - tick.lastPurge > 3600000 || ctx.now < tick.lastPurge) {
    tick.lastPurge = ctx.now;
    await store.run(gc, 'DELETE FROM fam_done WHERE at < ?', [ctx.now - LEDGER_KEEP_MS]);
  }
  return told;
}

// ─── services for Familie ────────────────────────

function owner(caller) { if (!OWNERS.includes(caller)) throw fail('forbidden'); return caller; }
const RELEASED = (plugin) => 'released:' + plugin;

async function setMembers(gc, listId, members, parents, left, now) {
  const l = await store.one(gc, 'SELECT owner_id FROM lists WHERE id = ?', [listId]);
  if (!l) return;
  // whoever left the family leaves its list; the list goes on with the first parent
  if (!members.includes(l.owner_id)) {
    await store.run(gc, 'UPDATE lists SET owner_id = ?, updated_at = ? WHERE id = ?', [parents[0], now, listId]);
    await store.run(gc, "UPDATE list_members SET role = 'write' WHERE list_id = ? AND role = 'owner'", [listId]);
    await store.run(gc, "INSERT INTO list_members (user_id, list_id, role, position, since) VALUES (?, ?, 'owner', 400, ?) ON CONFLICT(user_id, list_id) DO UPDATE SET role = 'owner'", [parents[0], listId, now]);
  }
  for (const u of left) {
    await store.run(gc, 'DELETE FROM list_members WHERE user_id = ? AND list_id = ?', [u, listId]);
    await store.run(gc, 'UPDATE tasks SET assignee_id = NULL WHERE list_id = ? AND assignee_id = ?', [listId, u]);
  }
  if (left.length) await lists.passTurns(gc, listId);
  for (const u of members) await store.run(gc, "INSERT OR IGNORE INTO list_members (user_id, list_id, role, position, since) VALUES (?, ?, 'write', 400, ?)", [u, listId, now]);
}

/** tasks_bind { members, parents, stars?, name?, moved? } | { release: true } (no user) → { ok, listId } */
async function bind(gc, base, caller, p) {
  owner(caller);
  const before = await family(gc);
  if (p.release === true) {
    let trashed = 0;
    await store.tx(gc, async () => {
      // Familie owns its tasks again and reminds of them itself: the open ones it keeps a copy of go to the trash here
      // (30 days — nothing rings twice, nothing is lost); a few statements, however many tasks
      if (before && before.listId) {
        const r = await store.run(gc, "UPDATE tasks SET deleted_at = ?, updated_at = ?, cal_dirty = CASE WHEN cal_event_id IS NOT NULL THEN 1 ELSE cal_dirty END WHERE fam_uid IS NOT NULL AND done_at IS NULL AND deleted_at IS NULL AND parent_id IS NULL AND (list_id = ? OR fam_uid LIKE 'p%')",
          [base.now, base.now, before.listId]);
        trashed = (r && r.changes) || 0;
        await store.run(gc, 'UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL AND parent_id IN (SELECT id FROM tasks WHERE fam_uid IS NOT NULL AND deleted_at = ?)', [base.now, base.now, base.now]);
        await store.run(gc, 'DELETE FROM tasks_fts WHERE rowid IN (SELECT id FROM tasks WHERE deleted_at = ? AND (fam_uid IS NOT NULL OR parent_id IS NOT NULL))', [base.now]);
        await store.run(gc, 'DELETE FROM my_day WHERE task_id IN (SELECT id FROM tasks WHERE deleted_at = ? AND fam_uid IS NOT NULL)', [base.now]);
      }
      // the list stays what it is — an ordinary shared list of the people who were the family
      await store.run(gc, 'UPDATE lists SET fam_tasks = ?, updated_at = ? WHERE fam_tasks = ?', [RELEASED(caller), base.now, caller]);
      await store.run(gc, 'DELETE FROM task_family WHERE plugin = ?', [caller]);
    });
    state.fam = null;
    if (before) { for (const what of ['lists', 'tasks', 'places']) events.changed(gc, [...before.members], what); }
    return { ok: true, released: !!before, trashed };
  }
  const members = ints(p.members);
  const parents = ints(p.parents).filter((u) => members.includes(u));
  if (!members.length || members.length > 50 || !parents.length || (Array.isArray(p.members) && p.members.length !== members.length)) throw fail('invalid', { field: 'members' });
  const left = before ? [...before.members].filter((u) => !members.includes(u)) : [];
  const moved = p.moved && typeof p.moved === 'object' && Number.isSafeInteger(p.moved.at) && p.moved.at > 0
    ? { at: p.moved.at, by: posInt(p.moved.by), tasks: Math.max(0, Math.min(100000, Number(p.moved.tasks) || 0)), places: Math.max(0, Math.min(100000, Number(p.moved.places) || 0)) } : (before ? before.moved : null);
  const lang = base.notifyLang === 'en' ? 'en' : 'de';
  const name = line(p.name, 80) || t(lang, 'fam.list');
  const listId = await store.tx(gc, async () => {
    // the family's list: the one it has, the one it had before „Zurückholen“, else a new one
    let l = await store.one(gc, 'SELECT id FROM lists WHERE fam_tasks = ? AND deleted_at IS NULL', [caller]);
    if (!l) {
      l = await store.one(gc, 'SELECT id FROM lists WHERE fam_tasks = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [RELEASED(caller)]);
      if (l) await store.run(gc, 'UPDATE lists SET fam_tasks = ?, updated_at = ? WHERE id = ?', [caller, base.now, l.id]);
    }
    let id = l ? l.id : null;
    if (!id) {
      const r = await store.run(gc, "INSERT INTO lists (owner_id, area, name, icon, kind, fam_tasks, created_at, updated_at) VALUES (?, 'private', ?, 'home', 'tasks', ?, ?, ?)", [parents[0], name, caller, base.now, base.now]);
      id = Number(r.lastInsertRowid);
      await store.run(gc, "INSERT INTO list_members (user_id, list_id, role, position, since) VALUES (?, ?, 'owner', 400, ?)", [parents[0], id, base.now]);
    }
    await setMembers(gc, id, members, parents, left, base.now);
    await store.run(gc, `INSERT INTO task_family (plugin, members, parents, list_id, stars, moved, at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plugin) DO UPDATE SET members = excluded.members, parents = excluded.parents, list_id = excluded.list_id, stars = excluded.stars, moved = excluded.moved, at = excluded.at`,
    [caller, JSON.stringify(members), JSON.stringify(parents), id, p.stars === true ? 1 : 0, moved ? JSON.stringify(moved) : null, base.now]);
    return id;
  });
  state.fam = null;
  const users = [...new Set([...members, ...left])];
  events.changed(gc, users, 'lists');
  events.changed(gc, users, 'tasks');
  await calsync.touchList(gc, listId);
  return { ok: true, listId };
}

/** The family of `caller`, or not_found (a hub that does not know it: Familie's tasks are its own again). */
async function boundFamily(gc, caller) {
  owner(caller);
  const fam = await family(gc);
  if (!fam || fam.plugin !== caller || !fam.listId) throw fail('not_found');
  return fam;
}

const member = (fam, v) => { const u = posInt(v); return u && fam.members.has(u) ? u : null; };

function dueOf(v) {
  if (!v || typeof v !== 'object' || !isDate(v.date)) return { date: null, time: null };
  return { date: v.date, time: isTime(v.time) ? v.time : null };
}

function dueAt(base, date, time) {
  if (!date) return null;
  const tz = require('./tz');
  return tz.at(date, tz.parseTime(time || '23:59'), base.tz);
}

/** The reminder of a task of Familie: at its time, else 08:00 — as Familie reminded. */
function remindOf(base, f, due) {
  if (f.remind === false || !due.date) return null;
  if (Number.isSafeInteger(f.remindAt) && f.remindAt > base.now) return f.remindAt;
  const tz = require('./tz');
  return tz.at(due.date, tz.parseTime(due.time || '08:00'), base.tz);
}

/** The list a place reminder of Familie lives in: its owner's own, or the one owner and target share (made when missing). */
async function placeList(gc, base, ownerId, target) {
  if (ownerId === target) return lists.ensureDefault(gc, { userId: ownerId, lang: base.notifyLang, now: base.now }, 'private');
  const uid = `fam-pair-${Math.min(ownerId, target)}-${Math.max(ownerId, target)}`;
  const have = await store.one(gc, "SELECT id FROM lists WHERE uid = ? AND kind = 'tasks' AND deleted_at IS NULL", [uid]);
  if (have) return have.id;
  const a = (await people.name(gc, Math.min(ownerId, target))) || '';
  const b = (await people.name(gc, Math.max(ownerId, target))) || '';
  const name = line(t(base.notifyLang, 'fam.pair_list', { a: a.split(/\s+/)[0], b: b.split(/\s+/)[0] }), 80);
  const r = await store.run(gc, "INSERT INTO lists (owner_id, area, name, icon, kind, uid, created_at, updated_at) VALUES (?, 'private', ?, 'home', 'tasks', ?, ?, ?)", [ownerId, name, uid, base.now, base.now]);
  const id = Number(r.lastInsertRowid);
  await store.run(gc, "INSERT INTO list_members (user_id, list_id, role, position, since) VALUES (?, ?, 'owner', 450, ?)", [ownerId, id, base.now]);
  await store.run(gc, "INSERT INTO list_members (user_id, list_id, role, position, since) VALUES (?, ?, 'write', 450, ?)", [target, id, base.now]);
  events.changed(gc, [ownerId, target], 'lists');
  return id;
}

/** One FT in the form to write → { …fields } or a code. */
async function fields(gc, base, fam, f) {
  if (!f || typeof f !== 'object' || typeof f.uid !== 'string' || !UID_RE.test(f.uid) || f.uid[0] === 'h' && f.kind === 'place') return 'invalid';
  const kind = f.kind === 'place' ? 'place' : 'task';
  if ((kind === 'place') !== (f.uid[0] === 'p')) return 'invalid';
  const title = line(f.title, TITLE_MAX);
  if (!title && f.deleted !== true) return 'invalid';
  const due = dueOf(f.due);
  let repeat = null;
  if (f.repeat != null) { repeat = R.normalize(f.repeat); if (!repeat) return 'invalid'; if (!due.date) return 'invalid'; }
  const out = { uid: f.uid, kind, title, note: text(typeof f.note === 'string' ? f.note : '', NOTE_MAX), due, repeat, deleted: f.deleted === true, done: f.done === true,
    doneBy: member(fam, f.doneBy), doneFor: member(fam, f.doneFor), doneAt: Number.isSafeInteger(f.doneAt) && f.doneAt > 0 ? Math.min(f.doneAt, base.now) : base.now,
    createdBy: member(fam, f.createdBy) || [...fam.parents][0], createdAt: Number.isSafeInteger(f.createdAt) && f.createdAt > 0 ? Math.min(f.createdAt, base.now) : base.now,
    stars: Number.isSafeInteger(f.stars) && f.stars > 0 ? Math.min(f.stars, STARS_MAX) : 0, remindAt: null, turn: null, people: null, assignee: null, place: null };
  if (kind === 'task') {
    const ppl = ints(f.people).filter((u) => fam.members.has(u)).slice(0, 20);
    out.turn = TURNS.includes(f.turn) && ppl.length > 1 ? f.turn : null;
    out.people = out.turn ? ppl : null;
    const a = member(fam, f.assignee);
    out.assignee = out.turn === 'first' ? null : out.turn === 'rotate' ? (ppl.includes(a) ? a : ppl[0]) : (a || (ppl.length === 1 ? ppl[0] : null));
    out.remindAt = remindOf(base, f, due);
    out.snoozed = Number.isSafeInteger(f.remindAt) && f.remindAt > base.now;
    out.listId = fam.listId;
  } else {
    const pl = f.place && typeof f.place === 'object' ? f.place : null;
    const own = pl && member(fam, pl.owner);
    const target = pl && member(fam, pl.target);
    if (!out.deleted && (!pl || !own || !target || !Number.isFinite(pl.lat) || !Number.isFinite(pl.lon) || Math.abs(pl.lat) > 90 || Math.abs(pl.lon) > 180)) return 'invalid';
    if (pl && own && target) {
      out.place = { owner: own, target, lat: Math.round(pl.lat * 1e6) / 1e6, lon: Math.round(pl.lon * 1e6) / 1e6, radius: Math.max(50, Math.min(2000, Math.round(Number(pl.radius)) || 150)),
        trigger: pl.trigger === 'exit' ? 'exit' : 'enter', consent: ['accepted', 'pending', 'declined'].includes(pl.consent) ? pl.consent : 'pending', listUid: typeof pl.listUid === 'string' ? pl.listUid : null };
      out.createdBy = own;
      out.assignee = target === own ? null : target;
    }
  }
  return out;
}

/** The place row of a reminder (its owner's, not one of „Meine Orte“) → its id. */
async function placeRow(gc, base, cur, x) {
  const p = x.place;
  const name = line(t(base.notifyLang, 'fam.place_name', { title: x.title }), 80);
  const was = cur && cur.place_id ? await store.one(gc, 'SELECT * FROM places WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [cur.place_id, p.owner]) : null;
  // 1.8.0: the copy of a place of the profile follows the profile, not Familie — another point is a row of its own
  const have = was && was.profile_id && (was.lat !== p.lat || was.lon !== p.lon || was.radius !== p.radius) ? null : was;
  if (have) {
    if (have.lat !== p.lat || have.lon !== p.lon || have.radius !== p.radius || (!have.named && have.name !== name)) {
      await store.run(gc, 'UPDATE places SET lat = ?, lon = ?, radius = ?, name = ?, updated_at = ? WHERE id = ?', [p.lat, p.lon, p.radius, have.named ? have.name : name, base.now, have.id]);
    }
    return have.id;
  }
  const r = await store.run(gc, 'INSERT INTO places (user_id, name, address, lat, lon, radius, named, ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)', [p.owner, name, '', p.lat, p.lon, p.radius, base.now, base.now]);
  return Number(r.lastInsertRowid);
}

const same = (a, b) => JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b);

/**
 * tasks_put { tasks: [FT] } (no user) — rows of Familie's copy. A row is written when it differs from what is here.
 * → { ok, written, rejected: [{ uid, code }], tasks: [{ uid, id }] }
 */
async function put(gc, base, caller, p) {
  const fam = await boundFamily(gc, caller);
  const rows = Array.isArray(p.tasks) ? p.tasks : [];
  if (rows.length > PUT_MAX) throw fail('invalid', { field: 'tasks' });
  const rejected = [];
  const out = [];
  const users = new Set();
  const cal = [];
  const finish = [];
  let written = 0;
  let placed = false;
  for (const f of rows) {
    const x = await fields(gc, base, fam, f);
    if (typeof x === 'string') { rejected.push({ uid: f && typeof f.uid === 'string' ? f.uid.slice(0, 20) : null, code: x }); continue; }
    // the open task of this uid, else the last one that was (done, or in the trash)
    let cur = await store.one(gc, 'SELECT * FROM tasks INDEXED BY idx_tasks_fam WHERE fam_uid = ? AND done_at IS NULL AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [x.uid]);
    let last = cur || await store.one(gc, 'SELECT * FROM tasks INDEXED BY idx_tasks_fam WHERE fam_uid = ? ORDER BY id DESC LIMIT 1', [x.uid]);
    // in the trash here (after „Zurückholen“, or deleted here while Familie changed it): it is back, as Familie has it
    if (!cur && last && last.deleted_at && !last.done_at && !x.deleted) {
      await store.tx(gc, async () => {
        await store.run(gc, 'UPDATE tasks SET deleted_at = NULL, updated_at = ? WHERE id = ?', [base.now, last.id]);
        await fts.setTask(gc, last.id, last.title, last.note);
      });
      cur = { ...last, deleted_at: null };
      for (const u of await lists.memberIds(gc, cur.list_id)) users.add(u);
      if (cur.place_json) placed = true;
      cal.push(cur.id);
      written++;
    }
    // a place reminder switched on again in Familie after it was done here: a new task
    if (!cur && last && x.kind === 'place' && last.done_at && !x.done && !x.deleted) last = null;
    if (x.deleted) {
      if (cur) {
        await store.tx(gc, async () => {
          await store.run(gc, 'UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?', [base.now, base.now, cur.id]);
          await store.run(gc, 'UPDATE tasks INDEXED BY idx_tasks_parent SET deleted_at = ?, updated_at = ? WHERE parent_id = ? AND deleted_at IS NULL', [base.now, base.now, cur.id]);
          await store.run(gc, 'DELETE FROM my_day WHERE task_id = ?', [cur.id]);
          await fts.dropTask(gc, cur.id);
        });
        for (const u of await lists.memberIds(gc, cur.list_id)) users.add(u);
        if (cur.cal_event_id) cal.push(cur.id);
        if (cur.place_json) placed = true;
        written++;
      }
      continue;
    }
    const listId = x.kind === 'place' ? await placeList(gc, base, x.place.owner, x.place.target) : x.listId;
    let attached = null;
    if (x.place && x.place.listUid) {
      const l = await store.one(gc, "SELECT l.id FROM lists l JOIN list_members m ON m.list_id = l.id AND m.user_id = ? WHERE l.uid = ? AND l.kind = 'shopping' AND l.deleted_at IS NULL", [x.place.target, x.place.listUid]);
      attached = l ? l.id : null;
    }
    if (!last) {
      // new here. A repeating task whose occurrence is done already starts with its next one.
      let due = x.due;
      let doneAt = x.done ? x.doneAt : null;
      if (x.done && x.repeat) {
        const nd = R.next(x.repeat, { due: x.due.date, done: base.today });
        if (nd) { due = { date: nd, time: x.due.time }; doneAt = null; }
      }
      const remindAt = doneAt ? null : (due.date === x.due.date ? x.remindAt : remindOf(base, { remind: x.remindAt != null }, due));
      const id = await store.tx(gc, async () => {
        const placeId = x.place ? await placeRow(gc, base, null, x) : null;
        const pj = x.place ? JSON.stringify({ key: null, label: null, any: false, trigger: x.place.trigger, by: x.place.owner, who: x.place.target, consent: x.place.owner === x.place.target ? 'accepted' : x.place.consent }) : null;
        const pos = await store.one(gc, 'SELECT COALESCE(MIN(position), 0) - 1 AS p FROM tasks INDEXED BY idx_tasks_list WHERE list_id = ? AND done_at IS NULL AND deleted_at IS NULL AND parent_id IS NULL', [listId]);
        // a reminder that is over already (Familie sent it) does not ring again — but stays, so the next occurrence has one
        const r = await store.run(gc, `INSERT INTO tasks (list_id, title, note, due_date, due_time, due_at, remind_at, reminded_at, repeat_json, assignee_id, position, created_by, created_at, updated_at,
          done_at, done_by, credit_id, turn, people_json, stars, fam_uid, attached_list, place_id, place_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [listId, x.title, x.note, due.date, due.time, dueAt(base, due.date, due.time), remindAt || null, remindAt && remindAt <= base.now ? base.now : null, x.repeat && !doneAt ? JSON.stringify(x.repeat) : null, x.assignee, pos.p,
          x.createdBy, x.createdAt, base.now, doneAt, doneAt ? (x.doneBy || x.doneFor || x.createdBy) : null, doneAt ? (x.doneFor || x.doneBy || null) : null,
          x.turn, x.people ? JSON.stringify(x.people) : null, x.stars, x.uid, attached, placeId, pj]);
        const tid = Number(r.lastInsertRowid);
        await fts.setTask(gc, tid, x.title, x.note);
        return tid;
      });
      out.push({ uid: x.uid, id });
      for (const u of await lists.memberIds(gc, listId)) users.add(u);
      if (due.time && !doneAt) cal.push(id);
      if (x.place) placed = true;
      written++;
      continue;
    }
    out.push({ uid: x.uid, id: last.id });
    // done here already (or in the trash): the hub's state stands — Familie fetches it
    if (!cur) continue;
    const set = [];
    const args = [];
    const putCol = (col, v) => { set.push(col + ' = ?'); args.push(v); };
    if (cur.title !== x.title) putCol('title', x.title);
    if (x.kind === 'place' && (cur.note || '') !== x.note) putCol('note', x.note);
    const curRepeat = parse(cur.repeat_json, null);
    if (!same(curRepeat, x.repeat)) putCol('repeat_json', x.repeat ? JSON.stringify(x.repeat) : null);
    const dateMoves = !x.done && (cur.due_date || null) !== x.due.date;
    if (dateMoves || (cur.due_time || null) !== x.due.time) {
      const d = dateMoves ? x.due.date : cur.due_date;
      if (dateMoves) putCol('due_date', d);
      putCol('due_time', x.due.time);
      putCol('due_at', dueAt(base, d, x.due.time));
      if (!x.done && x.kind === 'task') { putCol('remind_at', x.remindAt || null); putCol('reminded_at', x.remindAt && x.remindAt <= base.now ? base.now : null); putCol('snoozed_at', null); }
    } else if (x.kind === 'task' && !x.done) {
      // „Später“ pressed in Familie, or the reminder switched off there
      if (x.snoozed && cur.remind_at !== x.remindAt) { putCol('remind_at', x.remindAt); putCol('reminded_at', null); putCol('snoozed_at', base.now); }
      else if (x.remindAt == null && cur.remind_at && !cur.reminded_at) putCol('remind_at', null);
    }
    if (x.kind === 'task') {
      // nobody's here is „wer zuerst, die ganze Familie“ in Familie's copy: that copy coming back makes no turn of it
      const plain = !cur.turn && !cur.assignee_id && x.turn === 'first' && x.people.length >= fam.members.size;
      if (plain) { x.turn = null; x.people = null; }
      if ((cur.turn || null) !== x.turn) putCol('turn', x.turn);
      if (!same(parse(cur.people_json, null), x.people)) putCol('people_json', x.people ? JSON.stringify(x.people) : null);
      // ticked off in Familie: its turn went on there already — the person of this occurrence stays
      if (!x.done && (cur.assignee_id || null) !== x.assignee) putCol('assignee_id', x.assignee);
      if ((cur.stars || 0) !== x.stars) putCol('stars', x.stars);
    } else {
      const j = parse(cur.place_json, null) || {};
      const nj = { key: null, label: null, any: false, trigger: x.place.trigger, by: x.place.owner, who: x.place.target, consent: x.place.owner === x.place.target ? 'accepted' : x.place.consent };
      const pid = await placeRow(gc, base, cur, x);
      if (pid !== cur.place_id) putCol('place_id', pid);
      if (!same({ trigger: j.trigger, by: j.by, who: j.who, consent: j.consent }, { trigger: nj.trigger, by: nj.by, who: nj.who, consent: nj.consent })) { putCol('place_json', JSON.stringify(nj)); placed = true; }
      if ((cur.assignee_id || null) !== x.assignee) putCol('assignee_id', x.assignee);
      if ((cur.attached_list || null) !== attached && x.place.listUid) putCol('attached_list', attached);
      if (cur.list_id !== listId) putCol('list_id', listId);
    }
    if (set.length) {
      await store.tx(gc, async () => {
        await store.run(gc, `UPDATE tasks SET ${set.join(', ')}, updated_at = ? WHERE id = ?`, [...args, base.now, cur.id]);
        if (cur.title !== x.title) await fts.setTask(gc, cur.id, x.title, x.kind === 'place' ? x.note : cur.note);
      });
      for (const u of await lists.memberIds(gc, cur.list_id)) users.add(u);
      if (cur.list_id !== listId) for (const u of await lists.memberIds(gc, listId)) users.add(u);
      cal.push(cur.id);
      written++;
    }
    // ticked off in Familie — unless the hub is past that occurrence already
    if (x.done && (!cur.due_date || !x.due.date || cur.due_date <= x.due.date)) finish.push({ id: cur.id, x });
  }
  for (const d of finish) {
    const by = d.x.doneBy || d.x.doneFor || d.x.createdBy;
    try {
      await hooks.complete(gc, { ...base, userId: by, userName: (await people.name(gc, by)) || '' }, d.id, { done: true, userId: d.x.doneFor || by },
        { fam: { quiet: true, at: d.x.doneAt, next: d.x.kind === 'task' && d.x.turn === 'rotate' ? d.x.assignee : undefined } });
      written++;
    } catch (e) {
      rejected.push({ uid: d.x.uid, code: (e && e.code) || 'failed' });
    }
  }
  if (cal.length) await calsync.touch(gc, cal);
  if (users.size) events.changed(gc, [...users], 'tasks');
  if (placed && users.size) events.changed(gc, [...users], 'places');
  return { ok: true, written, rejected: rejected.slice(0, 50), tasks: out };
}

/** A task row → the FT Familie keeps its copy from. */
function wire(r, fam) {
  const ppl = ints(parse(r.people_json, [])).filter((u) => fam.members.has(u));
  const j = r.fam_uid[0] === 'p' ? parse(r.place_json, null) : null;
  return {
    uid: r.fam_uid, id: r.id, kind: r.fam_uid[0] === 'p' ? 'place' : 'task', title: r.title.slice(0, 120), turn: TURNS.includes(r.turn) && ppl.length > 1 ? r.turn : null, people: ppl,
    assignee: r.assignee_id && fam.members.has(r.assignee_id) ? r.assignee_id : null, due: r.due_date ? { date: r.due_date, time: r.due_time || null } : null, repeat: parse(r.repeat_json, null),
    stars: r.stars || 0, remind: !!r.remind_at, done: !!r.done_at, doneFor: r.done_at ? (r.credit_id || r.done_by || null) : null, doneAt: r.done_at || null,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, ...(j ? { consent: j.consent || 'accepted' } : {}),
  };
}

/**
 * tasks_list { rev?, cursor? } (no user) → { ok, tasks: [FT], done: [{ seq, rev, uid, userId, by, dueDate, stars, at,
 * undone }], cursor, rev, now } — every task Familie keeps a copy of (the open ones, the done ones of the last week; a
 * uid that is missing is gone here) in pages, and with the first page what was ticked off here since `rev`.
 */
async function listFor(gc, base, caller, p) {
  const fam = await boundFamily(gc, caller);
  const out = { ok: true, tasks: [], done: [], cursor: null, rev: 0, now: base.now };
  let size = 200;
  const from = typeof p.cursor === 'string' && /^\d{1,15}$/.test(p.cursor) ? Number(p.cursor) : 0;
  if (!from) {
    // a task made here in the family list gets its uid the first time Familie asks (a done one got it when it was ticked
    // off; the done one of a repeating task handed its uid on to the next)
    await store.run(gc, "UPDATE tasks SET fam_uid = 'h' || id WHERE list_id = ? AND fam_uid IS NULL AND parent_id IS NULL AND deleted_at IS NULL AND done_at IS NULL", [fam.listId]);
    const since = Number.isSafeInteger(p.rev) && p.rev >= 0 ? p.rev : 0;
    const rows = await store.all(gc, 'SELECT * FROM fam_done INDEXED BY idx_fam_done_rev WHERE rev > ? ORDER BY rev LIMIT 60', [since]);
    out.done = rows.map((d) => ({ seq: d.seq, rev: d.rev, uid: d.uid, userId: d.user_id, by: d.by_id, dueDate: d.due_date || null, stars: d.stars || 0, at: d.at, undone: !!d.undone }));
    out.rev = rows.length ? rows[rows.length - 1].rev : since;
    out.more = rows.length === 60;
    size += JSON.stringify(out.done).length;
  }
  const rows = await store.all(gc, `SELECT * FROM tasks INDEXED BY idx_tasks_fam WHERE fam_uid IS NOT NULL AND id > ? AND deleted_at IS NULL AND parent_id IS NULL
    AND (done_at IS NULL OR done_at > ?) AND (list_id = ? OR fam_uid LIKE 'p%') ORDER BY id LIMIT 80`, [from, base.now - DONE_KEEP_MS, fam.listId]);
  let last = null;
  for (const r of rows) {
    const w = wire(r, fam);
    const s = JSON.stringify(w).length + 1;
    if (out.tasks.length && size + s > ANSWER_MAX) break;
    out.tasks.push(w);
    size += s;
    last = r;
  }
  if (last && (out.tasks.length < rows.length || rows.length === 80)) out.cursor = String(last.id);
  return out;
}

module.exports = { FAMILIE, TURNS, STARS_MAX, hooks, state, reset, family, meInfo, seen, rules, isFamilyList, booked, changed, markDirty, tell, tick, bind, put, listFor, wire };
