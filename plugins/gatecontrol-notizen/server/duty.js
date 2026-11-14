'use strict';

// Whose task is it? — the person a reminder goes to, whose calendar holds its event and whose „Gestern offen geblieben“
// it is part of: the person it is assigned to, else the one who made it; when that person is no member of the list any
// more, the list's owner. And the small things reminders share: the tag of one reminder, a time moved by whole days.

const store = require('./store');
const tz = require('./tz');

/** The first choice without looking at the members (the list's member in nearly every case). */
const candidate = (r) => r.assignee_id || r.created_by || null;

/** Task rows → Map(task id → user id | null) — two questions for a page of tasks, however many. */
async function of(gc, rows) {
  const out = new Map();
  const lists = [...new Set(rows.map((r) => r.list_id))];
  const members = new Map(); // list id → Map(user id → role)
  for (const part of store.chunks(lists)) {
    if (!part.length) continue;
    for (const m of await store.all(gc, `SELECT list_id, user_id, role FROM list_members WHERE list_id IN (${store.marks(part.length)})`, part)) {
      if (!members.has(m.list_id)) members.set(m.list_id, new Map());
      members.get(m.list_id).set(m.user_id, m.role);
    }
  }
  for (const r of rows) {
    const ms = members.get(r.list_id) || new Map();
    const c = candidate(r);
    if (c && ms.has(c)) { out.set(r.id, c); continue; }
    const owner = [...ms].find(([, role]) => role === 'owner');
    out.set(r.id, owner ? owner[0] : null);
  }
  return out;
}

/** The person of one task row. */
async function one(gc, r) { return (await of(gc, [r])).get(r.id) || null; }

/** The tag of one reminder: a task and the moment it is due — the same on the push and for a device's own alarm. */
const tagOf = (r) => (r.remind_at ? `task:${r.id}:${r.remind_at}` : null);

/** Is the reminder of this row still to come (set, not sent, the task open)? */
const pending = (r) => !!r.remind_at && !r.reminded_at && !r.done_at && !r.deleted_at;

/** `ms` moved by `days` whole days on the wall clock of `zone` (09:00 stays 09:00 over a change of summer time). */
function shiftDays(ms, days, zone) {
  if (ms == null || !days) return ms;
  const p = tz.parts(ms, zone);
  return tz.at(tz.addDays(tz.dateStr(p.y, p.m, p.d), days), { hh: p.hh, mm: p.mm }, zone) + p.ss * 1000;
}

module.exports = { candidate, of, one, tagOf, pending, shiftDays };
