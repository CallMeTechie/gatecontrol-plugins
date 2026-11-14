'use strict';

// 1.7.0: the reminders of Drive's deadlines ring from here („Aufgaben und Erinnerungen“, Stufe 5; README "1.7.0").
//
// The deadline stays at its file in Drive, and so does the person's reminder („3 Tage vorher“): Drive is the truth of
// both. What moves is who rings. While Drive's administrator chose „Notizen & Aufgaben“ there, Drive hands its open
// reminders over:
//
//   service deadline_reminders (caller gatecontrol-drive only)
//     { v: 1, reminders: [{ id: 'deadline:<id>', userId, at (ms), daysBefore, sent }] }   — ALL of them, each time (≤ 500)
//     → { ok: true, taken: n, rejected: ['<id>:<userId>', …] }
//
//   For each one the person gets a task that carries Drive's item of the deadline (Task.source, as POST items/<id>/carry
//   makes one): due on the day of the deadline, its reminder at Drive's time. From there on it is a task like any
//   other — the push with „Erledigt“ / „Später“, GET reminders for a device's own alarm, „Gestern offen geblieben“.
//   Ticking it off ticks the deadline off in Drive (todo_complete, as before); ticked off in Drive, the task is done.
//   What the list no longer names goes: the reminder was removed in Drive, the deadline or its file is gone, the person
//   no longer reads the file, Drive reminds itself again (an empty list). A task that is done stays as it is.
//   The person deleted the task here: no reminder for this deadline — until they set another one in Drive.
//   Rejected (Drive then reminds of it itself): the person does not see the item here (yet).
//
//   Before the first ring of a reminder the hub asks Drive (gatecontrol-drive:deadline_claim { v: 1, id, userId } →
//   { ok, send }): Drive's own record of „sent“ decides, so a reminder never comes from both. Drive not reachable just
//   then: asked again a little later, nothing rings unasked. „Später“ needs no second question.
//
// Without Drive's claim service (an older Drive, the permission not confirmed) the list is refused as a whole:
// { ok: false, code: 'unavailable' } — Drive goes on reminding itself. The other modules reach this one through
// `hooks` (api.js) — it requires none of them.

const store = require('./store');
const tz = require('./tz');
const config = require('./config');
const events = require('./events');
const { t } = require('./text');
const { posInt, parse } = require('./util');

const DRIVE = 'gatecontrol-drive';
const CLAIM = 'deadline_claim';
const ID_RE = /^deadline:\d{1,15}$/;
const MAX = 500;
const DAYS_MAX = 90;
const RETRY_MS = 5 * 60000;   // Drive did not answer the question: asked again after this
const KINDS = ['payment', 'cancellation', 'objection', 'warranty', 'renewal'];

// set by api.js: create(gc, ctx, fields) → task id · carrying(gc, ctx, extId) → task row | null · remove(gc, ctx, id)
const hooks = { create: null, carrying: null, remove: null };
const asked = new Map(); // 'ext|user|at' → when Drive failed to answer

function reset() { asked.clear(); }

/** May the hub ask Drive before it rings? */
async function claimable(gc) {
  try { return !!(gc.services && typeof gc.services.available === 'function' && typeof gc.services.call === 'function' && await gc.services.available(DRIVE, CLAIM)); } catch { return false; }
}

const itemOf = (gc, extId, userId) => store.one(gc, `SELECT i.* FROM src_items i JOIN src_item_users u ON u.item_id = i.id AND u.user_id = ?
  WHERE i.plugin = ? AND i.ext_id = ?`, [userId, DRIVE, extId]);

/** One entry of the list → { id, userId, at, daysBefore, sent } | null. */
function entry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const userId = posInt(raw.userId);
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || !userId) return null;
  if (!Number.isSafeInteger(raw.at) || raw.at <= 0) return null;
  const days = raw.daysBefore == null ? 0 : raw.daysBefore;
  if (!Number.isSafeInteger(days) || days < 0 || days > DAYS_MAX) return null;
  return { id: raw.id, userId, at: raw.at, daysBefore: days, sent: raw.sent === true };
}

/** The open task of link `l` (not deleted, still carrying the item) or null. */
async function taskOf(gc, l) {
  if (!l || !l.task_id) return null;
  const r = await store.one(gc, 'SELECT * FROM tasks WHERE id = ?', [l.task_id]);
  return r && !r.deleted_at ? r : null;
}

/** The task of a link goes (not one that is done: that is the person's record of it). */
async function drop(gc, base, l) {
  const r = await taskOf(gc, l);
  await store.run(gc, 'DELETE FROM drive_due WHERE ext_id = ? AND user_id = ?', [l.ext_id, l.user_id]);
  if (!r || r.done_at) return false;
  // a task the person had made of the item themselves stays theirs: it only loses the reminder that was Drive's
  if (!l.made) {
    if (r.remind_at === l.at && !r.reminded_at) await store.run(gc, 'UPDATE tasks SET remind_at = NULL, snoozed_at = NULL, updated_at = ? WHERE id = ?', [base.now, r.id]);
    return true;
  }
  try { await hooks.remove(gc, { ...base, userId: l.user_id, userName: '' }, r.id); } catch (e) { gc.log.warn('deadline task not removed', (e && (e.code || e.message)) || 'error'); return false; }
  return true;
}

/** The service deadline_reminders: Drive's whole list. */
async function put(gc, base, caller, payload) {
  if (caller !== DRIVE) return { ok: false, code: 'forbidden' };
  const p = payload || {};
  if (p.v !== 1 || !Array.isArray(p.reminders) || p.reminders.length > MAX) return { ok: false, code: 'invalid' };
  const cfg = await config.get(gc);
  if (!config.sourceOn(cfg, DRIVE)) return { ok: false, code: 'source_off' };
  // nothing to hand over (Drive reminds itself again): what is here goes, whatever Drive can or cannot answer
  if (p.reminders.length && !(await claimable(gc))) return { ok: false, code: 'unavailable', reason: 'claim' };
  const run = base.now;
  const rejected = [];
  const touched = new Set();
  const named = new Set();
  let taken = 0;
  for (const raw of p.reminders) {
    const e = entry(raw);
    if (!e) { if (raw && typeof raw.id === 'string' && ID_RE.test(raw.id) && posInt(raw.userId)) rejected.push(`${raw.id.slice(9)}:${posInt(raw.userId)}`); continue; }
    const key = `${e.id.slice(9)}:${e.userId}`;
    const item = await itemOf(gc, e.id, e.userId);
    if (!item) { rejected.push(key); continue; }
    const ctx = { ...base, userId: e.userId, userName: '' };
    const l = await store.one(gc, 'SELECT * FROM drive_due WHERE ext_id = ? AND user_id = ?', [e.id, e.userId]);
    const moved = !!l && (l.at !== e.at || l.days_before !== e.daysBefore);
    let task = await taskOf(gc, l);
    let made = l ? l.made : 1;
    // the person deleted the task here: this reminder is not wanted — another time set in Drive is a new one
    // (the link keeps pointing at the deleted task: a link without one — Drive had rung already, the deadline was ticked
    // off — is no such choice)
    const dismissed = !!l && l.task_id != null && !task && !moved;
    if (!task && !dismissed && !item.done) {
      // a task the person made of the item themselves (POST items/<id>/carry) carries the reminder too
      task = await hooks.carrying(gc, ctx, e.id);
      made = task ? 0 : 1;
      if (task && !e.sent && !task.done_at) {
        await store.run(gc, 'UPDATE tasks SET remind_at = ?, reminded_at = NULL, snoozed_at = NULL, missed_at = NULL, updated_at = ? WHERE id = ?', [e.at, run, task.id]);
      } else if (!task && !e.sent) {
        const id = await hooks.create(gc, ctx, { title: item.title, area: item.area, due: { date: item.due_date, time: null }, remindAt: new Date(e.at).toISOString(), source: { plugin: DRIVE, id: e.id } });
        task = { id };
      }
      touched.add(e.userId);
    } else if (task && moved && !task.done_at) {
      // another time in Drive: the reminder is that one, and it is asked for again
      await store.run(gc, `UPDATE tasks SET remind_at = ?, reminded_at = ${e.sent ? '?' : 'NULL'}, snoozed_at = NULL, missed_at = NULL, updated_at = ? WHERE id = ?`, e.sent ? [e.at, run, run, task.id] : [e.at, run, task.id]);
      touched.add(e.userId);
    }
    await store.run(gc, `INSERT INTO drive_due (ext_id, user_id, at, days_before, task_id, made, claimed_at, title, seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ext_id, user_id) DO UPDATE SET at = excluded.at, days_before = excluded.days_before, task_id = excluded.task_id, made = excluded.made, seen = excluded.seen,
        claimed_at = CASE WHEN ? THEN excluded.claimed_at ELSE claimed_at END`,
    [e.id, e.userId, e.at, e.daysBefore, task ? task.id : dismissed ? l.task_id : null, made ? 1 : 0, e.sent ? run : null, item.title, run, run, moved || !l ? 1 : 0]);
    named.add(`${e.id}|${e.userId}`);
    taken++;
  }
  // what this list does not name is no reminder of Drive's any more
  for (const l of await store.all(gc, 'SELECT * FROM drive_due')) {
    if (!named.has(`${l.ext_id}|${l.user_id}`) && await drop(gc, base, l)) touched.add(l.user_id);
  }
  if (touched.size) events.changed(gc, [...touched], 'tasks');
  return { ok: true, taken, rejected: rejected.slice(0, MAX) };
}

/** Drive's item `extId` is gone (sources.js, before the tasks carrying it are set free): its reminders go with it. */
async function itemGone(gc, base, extId) {
  const touched = [];
  for (const l of await store.all(gc, 'SELECT * FROM drive_due WHERE ext_id = ?', [extId])) if (await drop(gc, base, l)) touched.push(l.user_id);
  return touched;
}

/** Drive's item got another title (the AI read the file again): the tasks made of it follow, unless renamed here. */
async function itemRenamed(gc, extId, title, now) {
  for (const l of await store.all(gc, 'SELECT * FROM drive_due WHERE ext_id = ? AND task_id IS NOT NULL', [extId])) {
    if (l.title === title) continue;
    await store.run(gc, 'UPDATE tasks SET title = ?, updated_at = ? WHERE id = ? AND title = ? AND deleted_at IS NULL', [title, now, l.task_id, l.title || '']);
    await store.run(gc, 'UPDATE drive_due SET title = ? WHERE ext_id = ? AND user_id = ?', [title, extId, l.user_id]);
  }
}

/** Task rows → Map(task id → { link, item }) for those that carry a reminder of Drive (one question for a page). */
async function ofTasks(gc, rows) {
  const out = new Map();
  const ids = rows.filter((r) => r.src_plugin === DRIVE && !r.parent_id).map((r) => r.id);
  for (const part of store.chunks(ids)) {
    if (!part.length) continue;
    for (const x of await store.all(gc, `SELECT l.ext_id AS l_ext, l.user_id AS l_user, l.at AS l_at, l.days_before AS l_days, l.claimed_at AS l_claimed, l.task_id AS l_task, l.made AS l_made, i.*
      FROM drive_due l INDEXED BY idx_drive_due_task JOIN src_items i ON i.plugin = ? AND i.ext_id = l.ext_id WHERE l.task_id IN (${store.marks(part.length)})`, [DRIVE, ...part])) {
      out.set(x.l_task, { link: { ext_id: x.l_ext, user_id: x.l_user, at: x.l_at, days_before: x.l_days, claimed_at: x.l_claimed, task_id: x.l_task, made: x.l_made }, item: x });
    }
  }
  return out;
}

/** Task.deadline: { date, kind, file, daysBefore, open: { plugin, route } } — what the screens show beside the task. */
function view(d) {
  const meta = parse(d.item.meta_json, {}) || {};
  return {
    date: d.item.due_date || null, kind: KINDS.includes(meta.type) ? meta.type : null, file: d.item.subtitle || null,
    daysBefore: d.link.days_before, open: { plugin: DRIVE, route: d.item.open_route || '' },
  };
}

/** The portal path of the file (the button „Datei öffnen“ of the push) — null when the item names none. */
function portalPath(d) {
  const m = /^node\/(\d{1,15})$/.exec(d.item.open_route || '');
  return m ? `/portal?drive=${m[1]}#plg-${DRIVE}` : null;
}

/** „Frist in 3 Tagen: Kfz-Versicherung kündigen“ / „Kündigung bis 30.11.2026 · Versicherungsschein.pdf“, seen at `at`. */
function message(lang, d, title, at, zone) {
  const p = tz.parts(at, zone);
  const today = tz.dateStr(p.y, p.m, p.d);
  const date = d.item.due_date;
  const n = date ? tz.diffDays(today, date) : 0;
  const key = !date ? 'n.dl_day' : n < 0 ? 'n.dl_over' : n === 0 ? 'n.dl_today' : n === 1 ? 'n.dl_tomorrow' : 'n.dl_days';
  const meta = parse(d.item.meta_json, {}) || {};
  const kind = KINDS.includes(meta.type) ? t(lang, 'n.dl_k_' + meta.type) : t(lang, 'k.deadline');
  const day = date ? (lang === 'en' ? date : date.split('-').reverse().join('.')) : '';
  return {
    title: t(lang, key, { n, title }).slice(0, 120),
    body: [date ? t(lang, 'n.dl_until', { kind, date: day }) : kind, d.item.subtitle].filter(Boolean).join(' · ').slice(0, 300),
  };
}

/**
 * Before the first ring of task row `r` for `userId`: does Drive say „ring“? → 'send' | 'no' (Drive did, or will, or
 * the reminder is gone: nothing rings here) | 'wait' (Drive did not answer: asked again later, nothing is marked).
 */
async function claim(gc, d, now) {
  const l = d.link;
  if (l.claimed_at) return 'send';
  const key = `${l.ext_id}|${l.user_id}|${l.at}`;
  const last = asked.get(key);
  if (last && now - last < RETRY_MS) return 'wait';
  let res = null;
  try {
    res = await gc.services.call({ plugin: DRIVE, service: CLAIM, userId: l.user_id, payload: { v: 1, id: l.ext_id, userId: l.user_id } });
  } catch { res = null; }
  if (!res || res.ok !== true) {
    // Drive refuses for good (it does not know the service's caller, the deadline): nothing rings from here
    if (res && (res.code === 'forbidden' || res.code === 'not_found' || res.code === 'invalid')) { asked.delete(key); return 'no'; }
    if (asked.size > 2000) asked.clear();
    asked.set(key, now);
    return 'wait';
  }
  asked.delete(key);
  if (res.send !== true) return 'no';
  await store.run(gc, 'UPDATE drive_due SET claimed_at = ? WHERE ext_id = ? AND user_id = ?', [now, l.ext_id, l.user_id]);
  l.claimed_at = now;
  return 'send';
}

/** For GET me: does a reminder of Drive ring from here right now? */
async function active(gc) {
  return !!(await store.one(gc, 'SELECT 1 AS x FROM drive_due LIMIT 1'));
}

module.exports = { DRIVE, hooks, reset, put, itemGone, itemRenamed, ofTasks, view, portalPath, message, claim, claimable, active, RETRY_MS, MAX };
