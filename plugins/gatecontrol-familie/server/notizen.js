'use strict';

// Familie as a source of „Notizen & Aufgaben“ (1.19.0, gatecontrol-notizen; contract v1, server/todohub.js) — what the
// family has „zu tun“ (Pinnwand and Packlisten are no items: they live in the hub as notes, server/boardsync.js):
//
//   task      the current occurrence of a task (module tasks): mode fixed → one item per assignee 'task:<id>:<userId>'
//             (each one ticks it off), rotate / first → one item 'task:<id>' (whose turn it is / whoever is first);
//             users: the assignees and the parents; assignee: the child (fixed), whose turn it is (rotate), the only
//             assignee (first); meta.stars with the module stars; due: the occurrence's day (with its time); done:
//             ticked off for this occurrence (a one-off task done longer than a day ago is gone); group „Familie“.
//             Ticking it off is POST tasks/<id>/done (stars for a child, a parent ticks it off for the child) — undoing
//             is not possible in Familie (read_only).
//   list      a shopping list with something open (module shopping): 'list:<listId>', progress open / all, meta.type
//             'shopping', assignee: the person asked to do it, users: the family; only shown (canComplete false).
//   reminder  an open reminder of a rule of today (module rules): 'reminder:<rowId>' for its person, ticked off like
//             „Erledigt“ (POST rules/open/<ruleId>/done), done ones stay a day.
//
// Without the hub nothing is sent; nothing changes for Familie.

const store = require('./store');
const config = require('./config');
const members = require('./members');
const tz = require('./tz');
const tasks = require('./tasks');
const push = require('./push');
const reminders = require('./reminders');
const todohub = require('./todohub');
const shopsync = require('./shopsync');
const { posInt } = require('./util');

const PLUGIN = 'gatecontrol-familie';
const DAY = 86400000;
const LIST_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const TEXTS = { de: { family: 'Familie', task: 'Aufgabe', shopping: 'Einkaufsliste', reminder: 'Erinnerung' }, en: { family: 'Family', task: 'Task', shopping: 'Shopping list', reminder: 'Reminder' } };

const say = (cfg, k) => (TEXTS[cfg.lang] || TEXTS.de)[k];
const ids = (list) => [...new Set(list.filter((u) => Number.isSafeInteger(u) && u > 0))];

function dueOf(occ, time, cfg) {
  const t = time && tz.parseTime(time);
  if (!t) return occ;
  return todohub.isoIn(tz.at(occ, t, cfg.tz), cfg.tz);
}

async function taskItems(gc, fam, cfg, now, today) {
  const rows = await store.all(gc, 'SELECT * FROM tasks ORDER BY id');
  if (!rows.length) return [];
  const done = await store.all(gc, `SELECT task_id, occurrence, user_id, at FROM task_done WHERE task_id IN (${store.marks(rows.length)}) ORDER BY at`, rows.map((r) => r.id));
  const parents = members.parents(fam).map((m) => m.userId);
  const group = { id: 'family', label: say(cfg, 'family') };
  const out = [];
  for (const r of rows) {
    const v = (await tasks.one(gc, { fam, today, me: { userId: 0 } }, r.id));
    const occ = v.dueDate;
    if (!occ || !v.assignees.length) continue;
    const mine = done.filter((x) => x.task_id === r.id && x.occurrence === occ);
    const stale = (list) => list.length && now - list[list.length - 1].at >= DAY && r.repeat === 'none';
    const base = {
      kind: 'task', title: v.title, subtitle: say(cfg, 'task'), due: dueOf(occ, v.dueTime, cfg), area: 'private', important: false, canComplete: true,
      group, meta: cfg.modules.stars && v.stars > 0 ? { stars: v.stars } : null, open: { plugin: PLUGIN, route: `task/${r.id}` }, updatedAt: r.updated_at || 0,
    };
    if (v.mode === 'fixed') {
      for (const uid of v.assignees) {
        const own = mine.filter((x) => x.user_id === uid);
        if (stale(own)) continue;
        const m = fam.byId.get(uid);
        out.push({ ...base, id: `task:${r.id}:${uid}`, users: ids([uid, ...parents]), assignee: uid, assigneeName: m ? m.name : null, done: own.length > 0,
          updatedAt: Math.max(base.updatedAt, own.length ? own[own.length - 1].at : 0) });
      }
    } else {
      if (stale(mine)) continue;
      const who = v.mode === 'rotate' ? v.current : (v.assignees.length === 1 ? v.assignees[0] : null);
      const m = who ? fam.byId.get(who) : null;
      out.push({ ...base, id: `task:${r.id}`, users: ids([...v.assignees, ...parents]), assignee: who || null, assigneeName: m ? m.name : null, done: mine.length > 0,
        updatedAt: Math.max(base.updatedAt, mine.length ? mine[mine.length - 1].at : 0) });
    }
  }
  return out;
}

async function listItems(gc, fam, cfg) {
  const rows = await store.all(gc, `SELECT l.id, l.name, l.assignee_id, l.assign_state, l.updated_at,
    (SELECT COUNT(*) FROM shop_items i WHERE i.list_id = l.id AND i.deleted = 0 AND i.checked = 0) AS open,
    (SELECT COUNT(*) FROM shop_items i WHERE i.list_id = l.id AND i.deleted = 0) AS total
    FROM shop_lists l WHERE l.deleted = 0 ORDER BY l.sort, l.created_at`);
  const users = fam.list.map((m) => m.userId);
  const out = [];
  for (const l of rows) {
    if (!l.open || !LIST_ID_RE.test(l.id)) continue;
    const who = l.assignee_id != null && l.assign_state !== 'declined' && fam.byId.has(l.assignee_id) ? l.assignee_id : null;
    out.push({
      id: `list:${l.id}`, kind: 'list', title: l.name, subtitle: say(cfg, 'shopping'), area: 'private', users: ids(users),
      assignee: who, assigneeName: who ? fam.byId.get(who).name : null, important: false, done: false, canComplete: false,
      progress: { done: l.total - l.open, total: l.total }, group: { id: 'shopping', label: say(cfg, 'shopping') }, meta: { type: 'shopping' },
      open: { plugin: PLUGIN, route: `shopping/${l.id}` }, updatedAt: l.updated_at || 0,
    });
  }
  return out;
}

async function reminderItems(gc, fam, cfg, now, today) {
  const rows = await store.all(gc, `SELECT r.id, r.rule_id, r.user_id, r.state, r.updated_at, p.title AS rule_title, p.name AS rule_name FROM rule_reminders r
    JOIN presence_rules p ON p.id = r.rule_id WHERE r.day = ? AND (r.state IN ('open', 'snoozed') OR (r.state = 'done' AND r.updated_at > ?))`, [today, now - DAY]);
  const out = [];
  for (const x of rows) {
    if (!fam.byId.has(x.user_id)) continue;
    const title = x.rule_title || x.rule_name;
    if (!title) continue;
    out.push({
      id: `reminder:${x.id}`, kind: 'task', title, subtitle: say(cfg, 'reminder'), due: today, area: 'private', users: [x.user_id],
      important: false, done: x.state === 'done', canComplete: x.state !== 'done', group: { id: 'reminders', label: say(cfg, 'reminder') },
      meta: { type: 'reminder' }, open: { plugin: PLUGIN, route: `reminder/${x.rule_id}` }, updatedAt: x.updated_at || 0,
    });
  }
  return out;
}

/** Every item of the family (the modules that are on). */
async function collect(gc, now) {
  const cfg = await config.load(gc);
  const today = tz.localDate(now, cfg.tz);
  const fam = await members.load(gc, today);
  if (!fam.list.length) return [];
  const out = [];
  if (cfg.modules.tasks) out.push(...await taskItems(gc, fam, cfg, now, today));
  // 1.21.0: lists that moved to the hub are its own lists there — not shown a second time as items of Familie
  if (cfg.modules.shopping && (await shopsync.where(gc)).home !== 'notizen') out.push(...await listItems(gc, fam, cfg));
  if (cfg.modules.rules) out.push(...await reminderItems(gc, fam, cfg, now, today));
  return out;
}

/** Ticking off in the hub: what the same person may do in Familie. */
async function complete(gc, user, item, done, now) {
  const cfg = await config.load(gc);
  const today = tz.localDate(now, cfg.tz);
  const fam = await members.load(gc, today);
  const me = fam.byId.get(user.id);
  if (!me) return { ok: false, code: 'forbidden' };
  const parts = item.id.split(':');
  if (parts[0] === 'reminder') {
    if (!done) return { ok: false, code: 'read_only' };
    const row = await store.one(gc, 'SELECT rule_id, fire_key, user_id FROM rule_reminders WHERE id = ?', [posInt(parts[1]) || 0]);
    if (!row || row.user_id !== user.id) return { ok: false, code: 'forbidden' };
    await store.tx(gc, () => reminders.act(gc, now, user.id, row.rule_id, row.fire_key, 'done'));
    return { ok: true };
  }
  if (parts[0] !== 'task' || !cfg.modules.tasks) return { ok: false, code: 'read_only' };
  // Familie has no „not done“ for a task
  if (!done) return item.done ? { ok: false, code: 'read_only' } : { ok: true };
  const id = posInt(parts[1]);
  const body = {};
  const forUid = parts[2] ? posInt(parts[2]) : null;
  if (forUid && forUid !== user.id) {
    if (me.role !== 'parent') return { ok: false, code: 'forbidden' };
    body.userId = forUid;
  }
  const r = { cfg, now, today, fam, me, body, pushes: [] };
  try {
    await store.tx(gc, () => tasks.done(gc, r, id));
  } catch (e) {
    if (e && ['forbidden', 'parents_only', 'not_found', 'invalid'].includes(e.code)) return { ok: false, code: e.code === 'parents_only' ? 'forbidden' : e.code };
    throw e;
  }
  if (r.pushes.length) await push.flush(gc, r.pushes);
  return { ok: true };
}

const source = todohub.create({ plugin: PLUGIN, collect, complete, tx: (gc, fn) => store.tx(gc, fn), intervalMs: 60000 });

module.exports = { source, collect, complete };
