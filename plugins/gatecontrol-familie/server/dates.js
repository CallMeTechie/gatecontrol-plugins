'use strict';

// Dates and birthdays.
//
//   GET    dates?from=YYYY-MM-DD&to=YYYY-MM-DD   occurrences (max 400 days; default today + 60)
//   POST   dates            PATCH dates/<id>     DELETE dates/<id>     (every member)
//
// A yearly event repeats on its month and day (29 February → 28 February in
// other years) from its own date on. Member birthdays (members.birthdate)
// are virtual yearly birthday events with the id "member:<userId>",
// read-only here (the admin page edits the birthdate). Reminders (tick):
// remindDays 0–14 before an occurrence, from 08:00 local on that day, once
// per occurrence, to the event's members (everyone when none) — a member's
// birthday goes to everyone else, on the day.

const store = require('./store');
const tz = require('./tz');
const push = require('./push');
const format = require('./format');
const { fail, text, multiline, bool, intIn, time, date, userIds, parseJson, posInt } = require('./util');

const TITLE_MAX = 80;
const NOTE_MAX = 500;
const MAX_RANGE_DAYS = 400;
const DEFAULT_RANGE_DAYS = 60;
const MAX_SPAN_DAYS = 60;
const REMIND_AT = { hh: 8, mm: 0 };
const MEMBER_BIRTHDAY_REMIND = 0;

function rowToEvent(r) {
  return {
    id: r.id, title: r.title, date: r.date, time: r.time || null, endDate: r.end_date || null, allDay: !!r.all_day,
    repeat: r.repeat === 'yearly' ? 'yearly' : 'none', memberIds: parseJson(r.member_ids_json, []), kind: r.kind === 'birthday' ? 'birthday' : 'event',
    remindDays: r.remind_days == null ? null : r.remind_days, note: r.note || '', createdBy: r.created_by, readOnly: false,
  };
}

function memberBirthdays(fam) {
  return fam.list.filter((m) => m.birthdate).map((m) => ({
    id: `member:${m.userId}`, title: m.name, date: m.birthdate, time: null, endDate: null, allDay: true, repeat: 'yearly',
    memberIds: [m.userId], kind: 'birthday', remindDays: MEMBER_BIRTHDAY_REMIND, note: '', createdBy: null, readOnly: true, memberId: m.userId,
  }));
}

function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

/** The yearly occurrence of `base` (YYYY-MM-DD) in year y (29 Feb → 28 Feb when y is no leap year). */
function inYear(base, y) {
  const p = tz.parseDate(base);
  const d = p.m === 2 && p.d === 29 && !isLeap(y) ? 28 : p.d;
  return tz.dateStr(y, p.m, d);
}

/** Occurrences of one event overlapping [from, to] → [{ date, endDate }] */
function occurrences(ev, from, to) {
  const span = ev.endDate && ev.endDate > ev.date ? tz.diffDays(ev.date, ev.endDate) : 0;
  const out = [];
  const add = (d) => {
    const end = span ? tz.addDays(d, span) : null;
    if (d <= to && (end || d) >= from) out.push({ date: d, endDate: end });
  };
  if (ev.repeat !== 'yearly') { add(ev.date); return out; }
  const y0 = Math.max(tz.parseDate(from).y - 1, tz.parseDate(ev.date).y);
  const y1 = tz.parseDate(to).y;
  for (let y = y0; y <= y1; y++) {
    const d = inYear(ev.date, y);
    if (d >= ev.date) add(d);
  }
  return out;
}

function occurrenceView(ev, o) {
  const v = {
    id: ev.id, title: ev.title, date: o.date, time: ev.allDay ? null : ev.time, endDate: o.endDate, allDay: ev.allDay, repeat: ev.repeat,
    memberIds: ev.memberIds, kind: ev.kind, remindDays: ev.remindDays, note: ev.note,
    // additions: the stored date (birth date for birthdays), the age turned, read-only for member birthdays
    baseDate: ev.date, years: ev.kind === 'birthday' && ev.repeat === 'yearly' ? tz.parseDate(o.date).y - tz.parseDate(ev.date).y : null,
    readOnly: ev.readOnly, createdBy: ev.createdBy,
  };
  return v;
}

function sortKey(v) { return `${v.date} ${v.allDay ? '00' : '01'} ${v.time || ''} ${v.title.toLowerCase()}`; }

async function allEvents(gc, fam) {
  const stored = (await store.all(gc, 'SELECT * FROM events ORDER BY id')).map(rowToEvent);
  return [...stored.map((e) => ({ ...e, memberIds: e.memberIds.filter((id) => fam.byId.has(id)) })), ...memberBirthdays(fam)];
}

/** Expanded occurrences between from and to (inclusive), sorted. */
async function between(gc, fam, from, to) {
  const out = [];
  for (const ev of await allEvents(gc, fam)) for (const o of occurrences(ev, from, to)) out.push(occurrenceView(ev, o));
  out.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  return out;
}

/** GET dates */
async function get(gc, r) {
  const q = r.query || {};
  const from = q.from != null && q.from !== '' ? date(String(q.from)) : r.today;
  const to = q.to != null && q.to !== '' ? date(String(q.to)) : tz.addDays(from, DEFAULT_RANGE_DAYS);
  if (to < from || tz.diffDays(from, to) > MAX_RANGE_DAYS) throw fail('invalid');
  return { from, to, events: await between(gc, r.fam, from, to) };
}

/** Overview: the next 14 days. */
async function next(gc, r) {
  return (await between(gc, r.fam, r.today, tz.addDays(r.today, 14))).slice(0, 20);
}

function fields(body, existing, fam) {
  const b = body || {};
  const cur = existing || {};
  const out = {};
  out.title = b.title !== undefined || !existing ? text(b.title, TITLE_MAX) : cur.title;
  out.date = b.date !== undefined || !existing ? date(b.date) : cur.date;
  out.kind = b.kind !== undefined ? b.kind : (cur.kind || 'event');
  if (!['event', 'birthday'].includes(out.kind)) throw fail('invalid');
  out.time = b.time !== undefined ? time(b.time) : (existing ? cur.time : null);
  out.allDay = b.allDay !== undefined ? bool(b.allDay) : (existing && b.time === undefined ? cur.allDay : out.time == null);
  if (out.allDay) out.time = null;
  out.endDate = b.endDate !== undefined ? (b.endDate == null || b.endDate === '' ? null : date(b.endDate)) : (existing ? cur.endDate : null);
  if (out.endDate && (out.endDate < out.date || tz.diffDays(out.date, out.endDate) > MAX_SPAN_DAYS)) throw fail('invalid');
  if (out.endDate === out.date) out.endDate = null;
  out.repeat = b.repeat !== undefined ? b.repeat : (cur.repeat || (out.kind === 'birthday' ? 'yearly' : 'none'));
  if (!['none', 'yearly'].includes(out.repeat)) throw fail('invalid');
  out.memberIds = b.memberIds !== undefined ? userIds(b.memberIds, 50) : (cur.memberIds || []);
  if (out.memberIds.some((id) => !fam.byId.has(id))) throw fail('invalid');
  out.remindDays = b.remindDays !== undefined ? (b.remindDays === null ? null : intIn(b.remindDays, 0, 14)) : (existing ? cur.remindDays : null);
  if (b.note !== undefined) {
    const n = b.note == null ? '' : multiline(b.note);
    if (n == null || n.length > NOTE_MAX) throw fail('invalid');
    out.note = n;
  } else out.note = existing ? cur.note : '';
  return out;
}

const COLS = 'title = ?, date = ?, time = ?, end_date = ?, all_day = ?, repeat = ?, member_ids_json = ?, kind = ?, remind_days = ?, note = ?';
const vals = (f) => [f.title, f.date, f.time, f.endDate, f.allDay ? 1 : 0, f.repeat, JSON.stringify(f.memberIds), f.kind, f.remindDays, f.note];

async function getOne(gc, fam, id) {
  const r = await store.one(gc, 'SELECT * FROM events WHERE id = ?', [id]);
  if (!r) return null;
  const e = rowToEvent(r);
  return { ...e, memberIds: e.memberIds.filter((x) => fam.byId.has(x)) };
}

const plain = (e) => occurrenceView(e, { date: e.date, endDate: e.endDate });

async function create(gc, r) {
  const f = fields(r.body, null, r.fam);
  const res = await store.run(gc, `INSERT INTO events (title, date, time, end_date, all_day, repeat, member_ids_json, kind, remind_days, note, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [...vals(f), r.me.userId, r.now, r.now]);
  return plain(await getOne(gc, r.fam, res.lastInsertRowid));
}

/** "member:<id>" → read_only; anything else not an id → not_found. */
function eventId(raw) {
  if (typeof raw === 'string' && /^member:\d+$/.test(raw)) throw fail('read_only');
  const id = posInt(raw);
  if (!id) throw fail('not_found');
  return id;
}

async function update(gc, r, raw) {
  const id = eventId(raw);
  const e = await getOne(gc, r.fam, id);
  if (!e) throw fail('not_found');
  const f = fields(r.body, e, r.fam);
  await store.run(gc, `UPDATE events SET ${COLS}, updated_at = ? WHERE id = ?`, [...vals(f), r.now, id]);
  return plain(await getOne(gc, r.fam, id));
}

async function remove(gc, raw) {
  const id = eventId(raw);
  const res = await store.run(gc, 'DELETE FROM events WHERE id = ?', [id]);
  if (!res.changes) throw fail('not_found');
  await store.run(gc, 'DELETE FROM event_reminders WHERE event_key = ?', [String(id)]);
}

/** Background: reminders from 08:00 local. Collects pushes. */
async function remind(gc, fam, cfg, now, pushes) {
  const today = tz.localDate(now, cfg.tz);
  if (now < tz.at(today, REMIND_AT, cfg.tz)) return;
  const lang = cfg.lang;
  for (const ev of await allEvents(gc, fam)) {
    if (ev.remindDays == null) continue;
    const target = tz.addDays(today, ev.remindDays);
    const occ = occurrences(ev, target, target).find((o) => o.date === target);
    if (!occ) continue;
    const key = String(ev.id);
    if (await store.one(gc, 'SELECT 1 AS x FROM event_reminders WHERE event_key = ? AND occurrence = ?', [key, occ.date])) continue;
    await store.run(gc, 'INSERT INTO event_reminders (event_key, occurrence, sent_at) VALUES (?, ?, ?)', [key, occ.date, now]);
    let users;
    if (ev.memberId) users = fam.list.filter((m) => m.userId !== ev.memberId).map((m) => m.userId);
    else users = ev.memberIds.length ? ev.memberIds : fam.list.map((m) => m.userId);
    if (!users.length) continue;
    const n = ev.remindDays;
    let title;
    if (ev.kind === 'birthday') {
      const years = ev.repeat === 'yearly' ? tz.parseDate(occ.date).y - tz.parseDate(ev.date).y : null;
      const when = n === 0 ? 'today' : (n === 1 ? 'tomorrow' : 'in');
      title = push.t(lang, `date.birthday_${when}${years ? '_age' : ''}`, { name: ev.title, age: years, n });
    } else {
      title = push.t(lang, n === 0 ? 'date.today' : (n === 1 ? 'date.tomorrow' : 'date.in'), { title: ev.title, n });
    }
    const body = [format.dayShort(occ.date, lang), ev.allDay || !ev.time ? push.t(lang, 'date.allday') : ev.time].join(' · ')
      + (ev.note ? ` · ${ev.note.split('\n')[0].slice(0, 120)}` : '');
    pushes.push({
      topic: 'dates', users, priority: 'normal', collapseKey: `date:${key}:${occ.date}`, ttl: 24 * 3600,
      title, body, data: { familie: { type: 'date', eventId: ev.id, date: occ.date } },
    });
  }
}

async function purge(gc, cfg, now) {
  const today = tz.localDate(now, cfg.tz);
  await store.run(gc, 'DELETE FROM event_reminders WHERE occurrence < ?', [tz.addDays(today, -30)]);
}

module.exports = { inYear, occurrences, between, get, next, create, update, remove, remind, purge, memberBirthdays, MAX_RANGE_DAYS };
