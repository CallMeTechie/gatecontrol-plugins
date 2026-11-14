'use strict';

// The tasks and the place reminders in „Notizen & Aufgaben“ (1.24.0; gatecontrol-notizen ≥ 1.6.0) — built like the
// shopping lists' move (server/shopsync.js).
//
// Nothing moves by itself. A parent or the administrator looks at what would move (preview: „12 Aufgaben und 3
// Orts-Erinnerungen“) and presses the button (move): Familie tells the hub who the family is (tasks_bind — the hub
// makes the list „Familie“) and sends every task and every place reminder that can live there (tasks_put) — by their own
// ids, in parts, so a move done twice makes nothing twice and one that was cut short goes on where it stopped (the
// background run, or the button again). From then on the hub is where they live (mode 'hub'):
//
//   Familie → hub   a row changed in Familie (dirty, counted by server/hubmark.js) goes there right after its commit,
//                   else with the background run (tasks_put; the hub writes a row only when it differs)
//   hub → Familie   the hub calls tasks_changed, Familie pulls (tasks_list: every task Familie keeps a copy of, and what
//                   was ticked off there since — the stars Familie books) — at the latest every PULL_EVERY_MS. A row
//                   changed in Familie meanwhile is not overwritten: it goes to the hub next.
//
// Familie's own tables (tasks, task_done, places) stay the copy Familie shows — the app, the portal, the wall tablet,
// the cards in the chat, older apps — and stay where the stars are counted and settled. The hub reminds of the tasks it
// has; Familie reminds of none of them while the hub is there (no reminder twice) and of all of them when it is not.
//
// What a task of Familie is in the hub:
//   fixed, one person      a task assigned to that person        (several: one task per person — Familie's row is split
//                                                                 into one per person at the move, their done rows with it)
//   rotate                 turn 'rotate' with the people, assigned to whose turn it is
//   first                  turn 'first' with the people
//   daily / weekly / monthly   the hub's repeat rule; the current occurrence is its due date
//   a place reminder       a task at a place — its owner's own list, or a list only owner and target share; one that
//                          tells others („… ist angekommen“) is no task: it stays Familie's
//
// The way back: the hub away → changes wait and go when it is back; the hub removed → Familie works on with its copy
// (where() says home 'familie'), nothing is lost. A hub that does not know the family any more (a fresh hub: not_found)
// rolls back: mode 'local'. „Zurückholen“ (back) does the same on purpose after a last pull and tells the hub to let go:
// there the open tasks that came from Familie go to the trash (30 days), the list stays an ordinary shared list. What
// only the hub has — sub tasks, notes, attachments, a place on a family task, repeat rules Familie does not know — does
// not come back.

const store = require('./store');
const tz = require('./tz');
const tasks = require('./tasks');
const hubmark = require('./hubmark');
const { fail, validDate } = require('./util');

const HUB = 'gatecontrol-notizen';
const SERVICES = ['tasks_bind', 'tasks_put', 'tasks_list'];
const STATE_KEY = 'notizen_tasks';
const PULL_EVERY_MS = 5 * 60000;
const AVAILABLE_TTL_MS = 60000;
const CALLS_MAX = 60;
const PAGES_MAX = 40;
const PAYLOAD_MAX = 11000;
const PART_MAX = 25;
const TITLE_MAX = 80;
const UID_RE = /^([fph])([0-9]{1,15})$/;

const state = { st: null, hub: null, hubAt: 0, running: null, timer: null, noTimer: false, warned: new Set() };

function reset() {
  if (state.timer) clearTimeout(state.timer);
  Object.assign(state, { st: null, hub: null, hubAt: 0, running: null, timer: null, warned: new Set() });
  hubmark.reset();
}

const fresh = () => ({ mode: 'local', members: '', rev: 0, pulledAt: 0, pending: false, migratedAt: null, by: null, moved: null });

async function load(gc) {
  if (state.st) return state.st;
  let v = null;
  try { v = await gc.storage.get(STATE_KEY); } catch { v = null; }
  state.st = v && typeof v === 'object' && (v.mode === 'hub' || v.mode === 'local') ? { ...fresh(), ...v } : fresh();
  hubmark.state.on = state.st.mode === 'hub';
  return state.st;
}

async function save(gc) {
  hubmark.state.on = state.st.mode === 'hub';
  try { await gc.storage.set(STATE_KEY, state.st); } catch (e) { warn(gc, 'state', 'tasks: state not saved', (e && e.code) || 'error'); }
}

function warn(gc, key, ...a) {
  if (state.warned.has(key)) return;
  state.warned.add(key);
  try { gc.log.warn(...a); } catch { /* no log */ }
}

/** Are the hub's task services there (asks nobody; known answers kept a minute)? */
async function hubThere(gc, now = Date.now()) {
  if (state.hub != null && now - state.hubAt < AVAILABLE_TTL_MS && now >= state.hubAt) return state.hub;
  let on = false;
  if (gc.services && typeof gc.services.available === 'function' && typeof gc.services.call === 'function') {
    try {
      on = true;
      for (const s of SERVICES) if ((await gc.services.available(HUB, s)) !== true) { on = false; break; }
    } catch { on = false; }
  }
  state.hub = on;
  state.hubAt = now;
  hubmark.state.there = on && !!state.st && state.st.mode === 'hub';
  return on;
}

class HubError extends Error { constructor(code, field) { super(code); this.code = code; this.field = field || null; } }

async function call(gc, budget, service, payload) {
  if (budget.n >= CALLS_MAX) throw new HubError('budget');
  budget.n++;
  const res = await gc.services.call({ plugin: HUB, service, payload: { v: 1, ...payload } });
  if (!res || res.ok !== true) throw new HubError((res && res.code) || 'failed', res && res.field);
  return res;
}

const membersKey = (fam, cfg) => fam.list.map((m) => `${m.userId}${m.role === 'parent' ? 'p' : ''}`).sort().join(',') + (cfg.modules.stars ? '|s' : '');

async function bind(gc, fam, cfg, budget, moved) {
  await call(gc, budget, 'tasks_bind', {
    members: fam.list.map((m) => m.userId).slice(0, 50), parents: fam.list.filter((m) => m.role === 'parent').map((m) => m.userId).slice(0, 50),
    stars: !!(cfg.modules.tasks && cfg.modules.stars), ...(moved ? { moved } : {}),
  });
  state.st.members = membersKey(fam, cfg);
  await save(gc);
}

// ─── Familie → hub ───────────────────────────────

const uidOf = (r) => r.hub_uid || 'f' + r.id;

/** A repeat of Familie as the hub's rule (null: none). */
function ruleOf(t) {
  if (t.repeat === 'daily') return { type: 'daily', interval: 1 };
  if (t.repeat === 'weekly' && t.weekdays && t.weekdays.length) return { type: 'weekly', interval: 1, days: t.weekdays };
  if (t.repeat === 'monthly') return { type: 'monthly', interval: 1, day: tz.parseDate(t.anchor).d };
  return null;
}

/** A task row → what the hub gets (FT, gatecontrol-notizen server/famtasks.js). */
async function taskOut(gc, r, fam, cfg, now, today) {
  const uid = uidOf(r);
  if (r.gone_at) return { uid, kind: 'task', deleted: true };
  const t = tasks.rowToTask(r);
  const live = tasks.liveAssignees(t, fam);
  if (!live.length) return { uid, kind: 'task', deleted: true };
  const occ = tasks.currentOccurrence(t, today) || t.anchor;
  const done = (await tasks.doneRows(gc, [r.id])).filter((x) => x.occurrence === occ);
  let turn = null;
  let assignee = live[0];
  if (t.mode === 'rotate' && live.length > 1) { turn = 'rotate'; assignee = tasks.currentTurn(t, fam); } else if (t.mode === 'first' && live.length > 1) { turn = 'first'; assignee = null; }
  const mine = t.mode === 'fixed' ? done.filter((x) => x.user_id === assignee) : done;
  const last = mine.length ? mine[mine.length - 1] : null;
  // „Später“ pressed in Familie: the reminder of this occurrence comes again then
  const snooze = await store.one(gc, 'SELECT MAX(snooze_until) AS at FROM task_reminders WHERE task_id = ? AND occurrence = ?', [r.id, occ]);
  return {
    uid, kind: 'task', title: t.title, turn, people: live, assignee, due: { date: occ, time: t.dueTime || null }, repeat: ruleOf(t),
    stars: cfg.modules.stars ? t.stars : 0, remind: !!t.reminder, ...(snooze && snooze.at > now ? { remindAt: snooze.at } : {}),
    done: !!last, ...(last ? { doneBy: last.user_id, doneFor: last.user_id, doneAt: last.at } : {}),
    createdBy: t.createdBy || null, createdAt: t.createdAt,
  };
}

/** A place reminder row → what the hub gets (a reminder that tells others, or one that is gone: deleted there). */
function placeOut(r) {
  const uid = 'p' + r.id;
  if (r.gone_at || r.action_kind === 'tell') return { uid, kind: 'place', deleted: true };
  return {
    uid, kind: 'place', title: r.title, note: r.note || '', done: !r.active, createdBy: r.owner_id, createdAt: r.created_at,
    place: { owner: r.owner_id, target: r.target_user_id, lat: r.lat, lon: r.lon, radius: r.radius, trigger: r.trigger_on === 'exit' ? 'exit' : 'enter',
      consent: ['accepted', 'pending', 'declined'].includes(r.consent) ? r.consent : 'pending', listUid: r.action_kind === 'list' ? r.list_id || null : null },
  };
}

function parts(rows) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const r of rows) {
    const s = Buffer.byteLength(JSON.stringify(r.out), 'utf8') + 1;
    if (cur.length && (size + s > PAYLOAD_MAX || cur.length >= PART_MAX)) { out.push(cur); cur = []; size = 0; }
    cur.push(r);
    size += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Every row changed in Familie since it was last in step goes to the hub → { tasks, places } sent. */
async function pushChanges(gc, fam, cfg, now, budget) {
  const sent = { tasks: 0, places: 0 };
  const today = tz.localDate(now, cfg.tz);
  for (const kind of ['tasks', 'places']) {
    if (!cfg.modules[kind]) continue;
    for (let round = 0; round < 40; round++) {
      const rows = kind === 'tasks'
        ? await store.all(gc, 'SELECT * FROM tasks INDEXED BY idx_tasks_dirty WHERE dirty > 0 ORDER BY id LIMIT 100')
        : await store.all(gc, 'SELECT * FROM places INDEXED BY idx_places_dirty WHERE dirty > 0 AND in_hub = 1 ORDER BY id LIMIT 100');
      if (!rows.length) break;
      const list = [];
      for (const r of rows) list.push({ id: r.id, was: r.dirty, row: r, out: kind === 'tasks' ? await taskOut(gc, r, fam, cfg, now, today) : placeOut(r) });
      for (const part of parts(list)) {
        const res = await call(gc, budget, 'tasks_put', { tasks: part.map((x) => x.out) });
        for (const x of Array.isArray(res.rejected) ? res.rejected.slice(0, 5) : []) warn(gc, `rejected:${x && x.code}`, 'tasks: row rejected by Notizen & Aufgaben', x && x.uid, x && x.code);
        const refused = new Set((Array.isArray(res.rejected) ? res.rejected : []).map((x) => x && x.uid));
        // in step — unless it changed again meanwhile. A row the hub refused is not sent again, and stays Familie's own
        // (never „in step“: Familie reminds of it itself and no pull takes it away)
        await store.tx(gc, async () => {
          for (const x of part) {
            const no = refused.has(x.out.uid);
            if (kind === 'tasks') await store.run(gc, `UPDATE tasks SET ${no ? '' : 'synced_at = ?, '}dirty = MAX(0, dirty - ?) WHERE id = ?`, no ? [x.was, x.id] : [now, x.was, x.id]);
            // a reminder that tells others now (or that the hub refused) is Familie's own again
            else await store.run(gc, `UPDATE places SET ${no ? '' : 'synced_at = ?, '}dirty = MAX(0, dirty - ?)${no || (x.out.deleted && !x.row.gone_at) ? ', in_hub = 0' : ''} WHERE id = ?`, no ? [x.was, x.id] : [now, x.was, x.id]);
          }
        });
        sent[kind] += part.length;
      }
      if (rows.length < 100) break;
    }
  }
  return sent;
}

// ─── hub → Familie ───────────────────────────────

const text = (v, max) => String(v == null ? '' : v).replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && validDate(v);
const isTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/** The hub's repeat rule as Familie knows it → { repeat, weekdays } ('none' for what Familie cannot say). */
function repeatOf(rule) {
  const r = rule && typeof rule === 'object' ? rule : null;
  if (!r || (r.interval != null && r.interval !== 1)) return { repeat: 'none', weekdays: null };
  if (r.type === 'daily') return { repeat: 'daily', weekdays: null };
  if (r.type === 'weekly' && Array.isArray(r.days) && r.days.length && r.days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) return { repeat: 'weekly', weekdays: [...new Set(r.days)].sort() };
  if (r.type === 'monthly') return { repeat: 'monthly', weekdays: null };
  return { repeat: 'none', weekdays: null };
}

async function rowOf(gc, uid) {
  const m = UID_RE.exec(uid);
  if (!m) return null;
  if (m[1] === 'f') return store.one(gc, 'SELECT * FROM tasks WHERE id = ? AND hub_uid IS NULL', [Number(m[2])]);
  return store.one(gc, 'SELECT * FROM tasks INDEXED BY idx_tasks_hub_uid WHERE hub_uid = ?', [uid]);
}

/** A task of the hub onto Familie's copy → whether a row was written. */
async function applyTask(gc, fam, cfg, f, now) {
  const title = text(f.title, TITLE_MAX);
  if (!title) return false;
  const ids = (Array.isArray(f.people) ? f.people : []).filter((u) => fam.byId.has(u));
  const who = fam.byId.has(f.assignee) ? f.assignee : null;
  let mode = 'fixed';
  let assignees = who ? [who] : [];
  let turnUser = null;
  if (f.turn === 'rotate' && ids.length > 1) { mode = 'rotate'; assignees = ids; turnUser = ids.includes(who) ? who : ids[0]; }
  else if (f.turn === 'first' && ids.length > 1) { mode = 'first'; assignees = ids; }
  // nobody's in the hub: whoever is first, the whole family
  else if (!who) { mode = 'first'; assignees = fam.list.map((m) => m.userId).slice(0, 20); }
  if (!assignees.length) return false;
  const rp = repeatOf(f.repeat);
  const due = f.due && isDate(f.due.date) ? f.due : null;
  const dueTime = due && isTime(due.time) ? due.time : null;
  const row = await rowOf(gc, f.uid);
  if (!row) {
    if (f.uid[0] !== 'h') return false;
    const anchor = due ? due.date : tz.localDate(Number.isSafeInteger(f.createdAt) && f.createdAt > 0 ? f.createdAt : now, cfg.tz);
    const res = await store.run(gc, `INSERT INTO tasks (title, mode, assignees_json, turn_user, repeat, weekdays_json, due_time, due_date, stars, reminder, created_by, created_at, updated_at,
      hub_uid, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [title, mode, JSON.stringify(assignees), turnUser, rp.repeat, rp.weekdays ? JSON.stringify(rp.weekdays) : null, dueTime, anchor, cfg.modules.stars ? Math.min(10, f.stars || 0) : 0, f.remind ? 1 : 0,
      fam.byId.has(f.createdBy) ? f.createdBy : null, Number.isSafeInteger(f.createdAt) && f.createdAt > 0 ? f.createdAt : now, now, f.uid, now]);
    await ensureDone(gc, fam, cfg, { ...tasks.rowToTask({ id: Number(res.lastInsertRowid), title, mode, assignees_json: JSON.stringify(assignees), repeat: rp.repeat, due_date: anchor }) }, f);
    return true;
  }
  // changed in Familie after it was last in step: Familie's version goes to the hub next
  if (row.dirty > 0) return false;
  const t = tasks.rowToTask(row);
  // the day: a one-off task has the hub's; a repeating one keeps its series while the hub's day is part of it
  let anchor = t.anchor;
  if (due) {
    const probe = { ...t, repeat: rp.repeat, weekdays: rp.weekdays };
    if (rp.repeat === 'none' || due.date < t.anchor || !tasks.isOccurrence(probe, due.date)) anchor = due.date;
  }
  const stars = cfg.modules.stars ? Math.min(10, f.stars || 0) : t.stars;
  const same = t.title === title && t.mode === mode && JSON.stringify(t.assignees) === JSON.stringify(assignees) && (t.turnUser || null) === turnUser && t.repeat === rp.repeat
    && JSON.stringify(t.weekdays || null) === JSON.stringify(rp.weekdays) && (t.dueTime || null) === dueTime && t.anchor === anchor && t.stars === stars && t.reminder === !!f.remind && !row.gone_at;
  if (!same) {
    await store.run(gc, `UPDATE tasks SET title = ?, mode = ?, assignees_json = ?, turn_user = ?, repeat = ?, weekdays_json = ?, due_time = ?, due_date = ?, stars = ?, reminder = ?, gone_at = NULL,
      updated_at = ?, synced_at = ? WHERE id = ?`,
    [title, mode, JSON.stringify(assignees), turnUser, rp.repeat, rp.weekdays ? JSON.stringify(rp.weekdays) : null, dueTime, anchor, stars, f.remind ? 1 : 0, now, now, row.id]);
  } else if (!row.synced_at) await store.run(gc, 'UPDATE tasks SET synced_at = ? WHERE id = ?', [now, row.id]);
  const made = await ensureDone(gc, fam, cfg, { ...t, mode, assignees, repeat: rp.repeat, anchor }, f);
  return !same || made;
}

/** A one-off task the hub says is done has its done row here (the stars come with what was ticked off, booked()). */
async function ensureDone(gc, fam, cfg, t, f) {
  if (!f.done || t.repeat !== 'none') return false;
  const user = fam.byId.has(f.doneFor) ? f.doneFor : (t.assignees[0] || null);
  if (!user) return false;
  const have = await store.one(gc, 'SELECT 1 AS x FROM task_done WHERE task_id = ? AND occurrence = ?', [t.id, t.anchor]);
  if (have) return false;
  await store.run(gc, 'INSERT INTO task_done (task_id, occurrence, user_id, at, stars) VALUES (?, ?, ?, ?, 0) ON CONFLICT DO NOTHING', [t.id, t.anchor, user, Number.isSafeInteger(f.doneAt) && f.doneAt > 0 ? f.doneAt : Date.now()]);
  return true;
}

/** A place reminder as the hub has it (done there, the person's answer) onto Familie's row → whether it was written. */
async function applyPlace(gc, f, now) {
  const m = UID_RE.exec(f.uid);
  const row = m ? await store.one(gc, 'SELECT * FROM places WHERE id = ? AND in_hub = 1', [Number(m[2])]) : null;
  if (!row || row.dirty > 0 || row.gone_at) return false;
  const consent = ['accepted', 'pending', 'declined'].includes(f.consent) ? f.consent : row.consent;
  const active = f.done ? 0 : row.active;
  if (consent === row.consent && active === row.active) {
    if (!row.synced_at) await store.run(gc, 'UPDATE places SET synced_at = ? WHERE id = ?', [now, row.id]);
    return false;
  }
  await store.run(gc, 'UPDATE places SET consent = ?, active = ?, updated_at = ?, synced_at = ? WHERE id = ?', [consent, active, now, now, row.id]);
  return true;
}

/**
 * What was ticked off in the hub (or taken back there) → the done row here, with the stars of a child (module stars).
 * The same row twice writes nothing twice (the key is task, occurrence and person).
 */
async function booked(gc, fam, cfg, d) {
  if (!d || typeof d.uid !== 'string' || !fam.byId.has(d.userId)) return false;
  const row = await rowOf(gc, d.uid);
  if (!row) return false;
  const t = tasks.rowToTask(row);
  const at = Number.isSafeInteger(d.at) && d.at > 0 ? d.at : Date.now();
  let occ = t.anchor;
  if (t.repeat !== 'none') {
    const day = tz.localDate(at, cfg.tz);
    occ = isDate(d.dueDate) && tasks.isOccurrence(t, d.dueDate) ? d.dueDate : (tasks.nextOccurrence(t, day) || day);
  }
  if (d.undone) {
    const res = await store.run(gc, 'DELETE FROM task_done WHERE task_id = ? AND occurrence = ? AND user_id = ?', [row.id, occ, d.userId]);
    return !!(res && res.changes);
  }
  const m = fam.byId.get(d.userId);
  const stars = m.role === 'child' && cfg.modules.stars ? Math.max(0, Math.min(10, d.stars || 0)) : 0;
  // (the row may be there already without stars — the task said „done“ before this came)
  const have = await store.one(gc, 'SELECT stars FROM task_done WHERE task_id = ? AND occurrence = ? AND user_id = ?', [row.id, occ, d.userId]);
  if (have) {
    if (have.stars >= stars) return false;
    await store.run(gc, 'UPDATE task_done SET stars = ? WHERE task_id = ? AND occurrence = ? AND user_id = ?', [stars, row.id, occ, d.userId]);
    return true;
  }
  await store.run(gc, 'INSERT INTO task_done (task_id, occurrence, user_id, at, stars) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [row.id, occ, d.userId, at, stars]);
  return true;
}

/** tasks_list: every task Familie keeps a copy of, what was ticked off since → how many rows changed here. */
async function pull(gc, fam, cfg, now, budget) {
  const st = state.st;
  let n = 0;
  let cursor = null;
  let done = false;
  let ticked = [];
  let rev = st.rev || 0;
  let more = false;
  const seen = new Set();
  for (let page = 0; page < PAGES_MAX; page++) {
    const res = await call(gc, budget, 'tasks_list', { rev: st.rev || 0, ...(cursor ? { cursor } : {}) });
    if (page === 0) { ticked = Array.isArray(res.done) ? res.done : []; rev = Number.isSafeInteger(res.rev) ? res.rev : rev; more = res.more === true; }
    await store.tx(gc, async () => {
      for (const f of Array.isArray(res.tasks) ? res.tasks : []) {
        if (!f || typeof f.uid !== 'string' || !UID_RE.test(f.uid)) continue;
        seen.add(f.uid);
        if (f.uid[0] === 'p' ? (cfg.modules.places && await applyPlace(gc, f, now)) : (cfg.modules.tasks && await applyTask(gc, fam, cfg, f, now))) n++;
      }
    });
    cursor = typeof res.cursor === 'string' && res.cursor ? res.cursor : null;
    if (!cursor) { done = true; break; }
  }
  if (!done) return n;
  await store.tx(gc, async () => {
    // a task the hub no longer lists is gone there (deleted, moved to another list, done long ago)
    for (const r of await store.all(gc, 'SELECT id, hub_uid, dirty FROM tasks WHERE synced_at > 0 AND gone_at IS NULL')) {
      if (seen.has(uidOf(r)) || r.dirty > 0) continue;
      const fin = await store.one(gc, "SELECT 1 AS x FROM tasks t JOIN task_done d ON d.task_id = t.id AND d.occurrence = t.due_date WHERE t.id = ? AND t.repeat = 'none'", [r.id]);
      // a finished one-off task leaves with Familie's own retention (its stars stay)
      if (fin) continue;
      await store.run(gc, 'UPDATE tasks SET gone_at = ? WHERE id = ?', [now, r.id]);
      n++;
    }
    for (const r of await store.all(gc, 'SELECT id, dirty FROM places WHERE in_hub = 1 AND synced_at > 0 AND active = 1 AND gone_at IS NULL')) {
      if (seen.has('p' + r.id) || r.dirty > 0) continue;
      await store.run(gc, 'UPDATE places SET active = 0, updated_at = ?, synced_at = ? WHERE id = ?', [now, now, r.id]);
      n++;
    }
    for (const d of ticked) if (cfg.modules.tasks && await booked(gc, fam, cfg, d)) n++;
  });
  st.rev = rev;
  st.pulledAt = now;
  st.pending = more;
  await save(gc);
  return n;
}

/** The hub does not know the family any more (a fresh hub), or „Zurückholen“: the tasks are Familie's own again. */
async function toLocal(gc, why) {
  await store.tx(gc, async () => {
    await store.run(gc, 'UPDATE tasks SET synced_at = 0, dirty = 0 WHERE synced_at != 0 OR dirty != 0');
    await store.run(gc, 'UPDATE places SET in_hub = 0, synced_at = 0, dirty = 0 WHERE in_hub != 0 OR synced_at != 0 OR dirty != 0');
  });
  state.st = fresh();
  await save(gc);
  hubmark.state.there = false;
  gc.log.warn('tasks back in Familie', why);
}

/**
 * One run (the background run, after a change in Familie, after tasks_changed): push, pull. → what happened; never
 * throws. opts.pull: pull now.
 */
async function sync(gc, fam, cfg, now = Date.now(), opts = {}) {
  if (state.running) {
    await state.running.catch(() => {});
    if (!opts.pull) return { skipped: 'running' };
  }
  const run = (async () => {
    const st = await load(gc);
    if (st.mode !== 'hub') return { skipped: 'local' };
    if (!cfg.modules.tasks && !cfg.modules.places) return { skipped: 'module_off' };
    if (!(await hubThere(gc, now))) return { skipped: 'unavailable' };
    if (!fam.list.some((m) => m.role === 'parent')) return { skipped: 'no_family' };
    const budget = { n: 0 };
    try {
      if (st.members !== membersKey(fam, cfg)) await bind(gc, fam, cfg, budget);
      // a task for several, each for themselves, made meanwhile: one row per person
      if (cfg.modules.tasks) await split(gc, fam, now);
      const pushed = await pushChanges(gc, fam, cfg, now, budget);
      let pulled = 0;
      if (opts.pull || st.pending || now - st.pulledAt >= PULL_EVERY_MS || now < st.pulledAt) pulled = await pull(gc, fam, cfg, now, budget);
      return { pushed, pulled, calls: budget.n };
    } catch (e) {
      const code = (e && e.code) || 'error';
      if (e instanceof HubError && code === 'not_found' && state.st.mode === 'hub') {
        try { await toLocal(gc, 'hub_forgot'); } catch (x) { warn(gc, 'rollback', 'tasks rollback failed', (x && x.code) || 'error'); }
        return { rolledBack: true, calls: budget.n };
      }
      warn(gc, `sync:${code}`, 'tasks sync with Notizen & Aufgaben failed', code, e && e.field ? e.field : '');
      return { error: code, calls: budget.n };
    }
  })();
  state.running = run;
  try { return await run; } finally { if (state.running === run) state.running = null; }
}

// ─── the move ────────────────────────────────────

/**
 * A task for several people, each for themselves (mode fixed), becomes one row per person — the hub knows one person
 * per task. Their done rows and reminders go with them; the first person keeps the row (and its id). One transaction
 * per task → how many rows were made.
 */
async function split(gc, fam, now) {
  const rows = await store.all(gc, "SELECT * FROM tasks WHERE mode = 'fixed' AND gone_at IS NULL AND assignees_json LIKE '%,%'");
  let made = 0;
  for (const r of rows) {
    const t = tasks.rowToTask(r);
    const live = tasks.liveAssignees(t, fam);
    if (live.length < 2) continue;
    await store.tx(gc, async () => {
      for (const u of live.slice(1)) {
        const res = await store.run(gc, `INSERT INTO tasks (title, mode, assignees_json, turn_user, repeat, weekdays_json, due_time, due_date, stars, reminder, created_by, created_at, updated_at, source, conversation_id, dirty)
          VALUES (?, 'fixed', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [r.title, JSON.stringify([u]), r.repeat, r.weekdays_json, r.due_time, r.due_date, r.stars, r.reminder, r.created_by, r.created_at, now, r.source || null, r.conversation_id == null ? null : r.conversation_id]);
        const id = Number(res.lastInsertRowid);
        await store.run(gc, 'UPDATE task_done SET task_id = ? WHERE task_id = ? AND user_id = ?', [id, r.id, u]);
        await store.run(gc, 'UPDATE task_reminders SET task_id = ? WHERE task_id = ? AND user_id = ?', [id, r.id, u]);
        made++;
      }
      await store.run(gc, 'UPDATE tasks SET assignees_json = ?, updated_at = ?, dirty = dirty + 1 WHERE id = ?', [JSON.stringify([live[0]]), now, r.id]);
    });
  }
  return made;
}

/** Where the tasks live { home: 'familie' | 'notizen', since } (GET tasks, GET places, GET overview). */
async function where(gc) {
  const st = await load(gc);
  // moved, and the hub still there (a hub that went: the tasks are Familie's again for the apps)
  const there = st.mode === 'hub' && (await hubThere(gc));
  hubmark.state.there = there;
  return { home: there ? 'notizen' : 'familie', since: there && st.migratedAt ? new Date(st.migratedAt).toISOString().replace(/\.\d{3}Z$/, 'Z') : null };
}

/**
 * What would move, and where things stand:
 * { tasks, repeating, rotate, first, split (tasks for several, each for themselves: one per person afterwards), stars,
 *   places, placesOthers, placesTell, placesOff (stay in Familie), pending (rows that still wait for the hub), home,
 *   hub: { available }, moved, canMove, canBack }
 */
async function preview(gc, fam, cfg, now = Date.now()) {
  const st = await load(gc);
  const there = await hubThere(gc, now);
  const out = { tasks: 0, repeating: 0, rotate: 0, first: 0, split: 0, stars: 0, places: 0, placesOthers: 0, placesTell: 0, placesOff: 0, pending: 0 };
  if (cfg.modules.tasks) {
    for (const r of await store.all(gc, 'SELECT * FROM tasks WHERE gone_at IS NULL')) {
      const t = tasks.rowToTask(r);
      const live = tasks.liveAssignees(t, fam);
      if (!live.length) continue;
      const each = t.mode === 'fixed' ? live.length : 1;
      out.tasks += each;
      if (each > 1) out.split++;
      if (t.repeat !== 'none') out.repeating += each;
      if (t.mode === 'rotate' && live.length > 1) out.rotate++;
      if (t.mode === 'first' && live.length > 1) out.first++;
      if (cfg.modules.stars && t.stars > 0) out.stars += each;
      if (r.dirty > 0 && st.mode === 'hub') out.pending++;
    }
  }
  if (cfg.modules.places) {
    for (const r of await store.all(gc, 'SELECT owner_id, target_user_id, action_kind, active, in_hub, dirty FROM places WHERE gone_at IS NULL')) {
      if (r.action_kind === 'tell') out.placesTell++;
      else if (!r.active && !r.in_hub) out.placesOff++;
      else { out.places++; if (r.owner_id !== r.target_user_id) out.placesOthers++; }
      if (r.dirty > 0 && r.in_hub && st.mode === 'hub') out.pending++;
    }
  }
  return { ...out, home: await where(gc), hub: { available: there }, moved: st.mode === 'hub', canMove: there && (st.mode !== 'hub' || out.pending > 0), canBack: st.mode === 'hub',
    modules: { tasks: !!cfg.modules.tasks, places: !!cfg.modules.places } };
}

/**
 * The button „Umziehen“ (a parent, the administrator): bind, send everything in parts, pull →
 * { moved: { tasks, places }, pending, home }. Pressed again (or cut short before): it goes on — nothing twice.
 */
async function move(gc, fam, cfg, now, userId) {
  const err = (reason, extra) => fail('unavailable', { reason, ...(extra || {}) });
  if (!cfg.modules.tasks && !cfg.modules.places) throw fail('module_off');
  if (!fam.list.some((m) => m.role === 'parent')) throw err('no_parent');
  state.hub = null;
  if (!(await hubThere(gc, now))) throw err('hub');
  const st = await load(gc);
  const first = st.mode !== 'hub';
  const before = await preview(gc, fam, cfg, now);
  const moved = first ? { at: now, by: userId || null, tasks: before.tasks, places: before.places } : st.moved;
  const budget = { n: 0 };
  try {
    await bind(gc, fam, cfg, budget, moved || undefined);
  } catch (e) {
    warn(gc, 'move', 'tasks move failed', (e && e.code) || 'error');
    throw err('hub');
  }
  if (first) {
    // everything goes (again): what is there already is not made twice — the hub knows the ids. Two statements, one
    // transaction; the rows themselves go in parts afterwards (sync) and what is left goes with the next run.
    await store.tx(gc, async () => {
      await store.run(gc, 'UPDATE tasks SET synced_at = 0, dirty = 1 WHERE gone_at IS NULL');
      await store.run(gc, "UPDATE places SET in_hub = 1, synced_at = 0, dirty = 1 WHERE active = 1 AND action_kind != 'tell' AND gone_at IS NULL");
    });
    Object.assign(st, { mode: 'hub', rev: 0, pulledAt: 0, pending: false, migratedAt: now, by: userId || null, moved });
    await save(gc);
    hubmark.state.there = true;
  }
  const res = await sync(gc, fam, cfg, now, { pull: true });
  const after = await preview(gc, fam, cfg, now);
  if (res.rolledBack) throw err('hub');
  // cut short (the hub went away, too much for one run): the move stands and goes on by itself — and with the button
  if (res.error || res.skipped) throw err('hub', { pending: after.pending, moved: true });
  gc.log.info('tasks moved to Notizen & Aufgaben', moved ? moved.tasks : 0, moved ? moved.places : 0, after.pending);
  return { moved: { tasks: moved ? moved.tasks : 0, places: moved ? moved.places : 0 }, pending: after.pending, home: await where(gc) };
}

/** „Zurückholen“: Familie owns its tasks and place reminders again; the hub lets go. */
async function back(gc, fam, cfg, now) {
  const st = await load(gc);
  if (st.mode !== 'hub') return { home: await where(gc) };
  // what the hub has that Familie has not yet comes along first
  state.hub = null;
  if (await hubThere(gc, now)) {
    await sync(gc, fam, cfg, now, { pull: true });
    try { await call(gc, { n: 0 }, 'tasks_bind', { release: true }); } catch (e) { warn(gc, 'release', 'tasks release failed', (e && e.code) || 'error'); }
  }
  if (state.st.mode === 'hub') await toLocal(gc, 'back');
  return { home: await where(gc) };
}

/** After a change in Familie: to the hub in a second — only while the tasks live there. */
function soon(gc, loadFam) {
  if (state.noTimer || state.timer || !state.st || state.st.mode !== 'hub') return;
  state.timer = setTimeout(() => {
    state.timer = null;
    loadFam().then(({ fam, cfg }) => sync(gc, fam, cfg, Date.now(), { pull: state.st && state.st.pending })).catch(() => {});
  }, 1000);
  if (typeof state.timer.unref === 'function') state.timer.unref();
}

/** tasks_changed { v, at } from the hub (only the hub): pull soon. */
async function changed(gc, c, loadFam) {
  if (!c || c.caller !== HUB) return { ok: false, code: 'forbidden' };
  const st = await load(gc);
  if (st.mode !== 'hub') return { ok: true, ignored: true };
  st.pending = true;
  await save(gc);
  soon(gc, loadFam);
  return { ok: true };
}

function stop() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

module.exports = { HUB, SERVICES, STATE_KEY, PULL_EVERY_MS, state, reset, load, hubThere, sync, split, preview, move, back, soon, changed, where, stop, ruleOf, repeatOf };
