'use strict';

// Deadlines of documents (since 1.8.0, part of `docAi`): the payment, cancellation and objection deadlines the AI found
// (insights.js) and a person's reminder of one — Drive's own notification (topic deadline) N days before the day.
//
//   GET    deadlines?from=&to=       → { deadlines: [{ id, kind, date, label, reminder, node }] } — of the files the
//                                      viewer reads, from (YYYY-MM-DD, default today) to (default from + 365 days),
//                                      by date, ≤ 500
//   POST   deadlines/<id>/remind     { daysBefore: 0…90 } → { deadline } — the viewer's reminder (read is enough)
//   DELETE deadlines/<id>/remind     → { deadline }
//   POST   deadlines/<id>/calendar   { target? } → { deadline } — into a calendar (since 1.14.0 the family calendar,
//                                      feature deadlineCalendar; since 1.17.0 also a calendar of Mail, deadlineMailCalendar)
//   GET    deadlines/calendars       → { family: bool, mail: [{ id, name, account, color }] }   (since 1.17.0)
//   GET    deadlines/targets         → { targets: [{ areaId, label, target }] }                 (since 1.17.0)
//   PUT    deadlines/targets         { targets: [{ areaId, target }] } → the same
//
// A deadline: { id, kind: 'payment' | 'cancellation' | 'objection' | 'warranty' | 'renewal', date: 'YYYY-MM-DD', label,
// reminder: { at, daysBefore, sent } | null, calendar: { eventId, at, target: { kind, label } } | null, calendars: [the
// same], foundAt } — the reminder and the calendar entries are the viewer's own (`calendar`: the newest of `calendars`).
// Since 1.14.0: warranty — the day a warranty ends; renewal — the last day to cancel before a contract renews (the label
// says when and how it renews). foundAt: when the AI found it (null: before 1.14.0).
// GET deadlines adds `doc` { kind, title, sender, amount, currency } — what the AI read in the file (null without).
// The reminder goes out at 07:00 UTC of the day minus daysBefore (already past: with the next background run); the
// person must still read the file then (else it is dropped quietly).
//
// The family calendar (since 1.14.0): GateControl's services (≥ 1.178.0, permissions.services
// "gatecontrol-familie:calendar_add" — the administrator confirms it with the update) — the Familie plugin enters an
// all-day date { userId, title (≤ 80, e.g. „Kfz-Versicherung kündigen“), startsAt: the day, allDay: true } for the
// viewer. Familie not there, not running, or it refuses (not a family member, its dates module off, it does not take
// Drive as a caller): 409 familie_unavailable { reason }.
// A calendar of Mail (since 1.17.0, "gatecontrol-mail:calendar_list" and ":calendar_add", Mail ≥ 1.6.0): Outlook /
// Microsoft 365, CalDAV or GateControl's own calendars of the person — calendar_list gives those they can write to,
// calendar_add enters the all-day event { userId, calendarId, title, startsAt, allDay: true, note: the file name and
// „In Drive öffnen“ with the link, key: 'drive:deadline:<id>' } with the calendar's own all-day reminder (Drive adds
// none; its own notification stays). Mail not there or refusing: 409 mail_unavailable { reason }.
// A target: { kind: 'family' } | { kind: 'mail', calendarId, label } (label „<account> · <calendar>“, from calendar_list).
// Drive keeps { eventId, at, target } per person, deadline and target (doc_calendar) — a second call with the same
// target answers the same.
//
// New deadlines on their own (insights.js → auto()): for the person whose upload or "Erkennen" the recognition came
// from, else the owner of the area (my files, a child's folder), as long as they read the file — into that person's
// target for the area (deadline_targets: PATCH areas/<id> { deadlinesTarget }, PUT deadlines/targets; since 1.17.0).
// Without an own choice the area's switch holds (PATCH areas/<id> { deadlinesToCalendar }, 1.14.0, default off): on →
// the family calendar. Older apps keep working: the area views carry deadlinesToCalendar (true while a target is set).
// Feature `deadlineCalendar` in GET me: while Familie's calendar_add is reachable (gc.services.available) — and not
// for REFUSED_MS after Familie refused Drive as a caller (`forbidden`: a Familie that takes calendar_add only from the
// Messenger), so the apps do not offer a button that cannot work; then it is tried again. `deadlineMailCalendar` (since
// 1.17.0) the same for Mail's calendar_add.

const store = require('./store');
const nodes = require('./nodes');
const address = require('./address');
const { t } = require('./text');
const { fail, posInt, nonNeg, iso, day, line } = require('./util');

const KINDS = ['payment', 'cancellation', 'objection', 'warranty', 'renewal'];
const FAMILIE = 'gatecontrol-familie';
const CALENDAR = 'calendar_add';
// since 1.17.0: the calendars of Mail
const MAIL = 'gatecontrol-mail';
const MAIL_LIST = 'calendar_list';
const MAIL_ADD = 'calendar_add';
const MAIL_REFUSED_KEY = 'mail_calendar_refused';
const NOTE_MAX = 500;
const TARGETS_MAX = 50;
const CAL_ID_RE = /^[A-Za-z0-9:._-]{1,64}$/;
const TITLE_MAX = 80;
// new deadlines into the calendar on their own: at most this many service calls a background run (60 an hour for all)
const AUTO_MAX = 5;
// Familie refused Drive as a caller: the feature is off this long (gc.storage)
const REFUSED_KEY = 'familie_calendar_refused';
const REFUSED_MS = 6 * 3600000;
const DAY = 86400000;
const REMIND_HOUR_UTC = 7;
const DAYS_MAX = 90;
const LIST_MAX = 500;
const DUE_BATCH = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const startOf = (date) => Date.parse(date + 'T00:00:00Z');

/** A doc_calendar row → { eventId, at, target: { kind, label } }. */
function calView(c, lang) {
  return { eventId: c.event_id == null ? null : c.event_id, at: iso(c.at), target: { kind: c.kind, label: c.kind === 'mail' ? c.label || '' : t(lang, 'deadline.target.family') } };
}

function view(d, rem, cals, lang) {
  const list = (cals || []).map((c) => calView(c, lang));
  return {
    id: d.id, kind: d.kind, date: d.date, label: d.label || null,
    reminder: rem ? { at: iso(rem.at), daysBefore: rem.days_before, sent: rem.sent_at != null } : null,
    calendar: list.length ? list[list.length - 1] : null, calendars: list,
    foundAt: iso(d.found_at),
  };
}

/** The viewer's calendar entries of deadlines `ids` → Map deadline id → rows (oldest first). */
async function calendarOf(gc, uid, ids) {
  const out = new Map();
  for (const part of store.chunks(ids)) {
    const rows = await store.all(gc, `SELECT * FROM doc_calendar WHERE user_id = ? AND deadline_id IN (${store.marks(part.length)}) ORDER BY at, target`, [uid, ...part]);
    for (const r of rows) {
      if (!out.has(r.deadline_id)) out.set(r.deadline_id, []);
      out.get(r.deadline_id).push(r);
    }
  }
  return out;
}

/** One deadline row as the viewer sees it. */
async function viewOne(ctx, d) {
  return view(d, (await remindersOf(ctx.gc, ctx.viewer, [d.id])).get(d.id), (await calendarOf(ctx.gc, ctx.viewer, [d.id])).get(d.id), ctx.lang);
}

/** The viewer's reminders of deadlines `ids` → Map deadline id → row. */
async function remindersOf(gc, uid, ids) {
  const out = new Map();
  for (const part of store.chunks(ids)) {
    const rows = await store.all(gc, `SELECT * FROM doc_reminders WHERE user_id = ? AND deadline_id IN (${store.marks(part.length)})`, [uid, ...part]);
    for (const r of rows) out.set(r.deadline_id, r);
  }
  return out;
}

/** The deadlines of file `nodeId` as the viewer sees them (by date). */
async function ofNode(ctx, nodeId) {
  const rows = await store.all(ctx.gc, 'SELECT * FROM doc_deadlines WHERE node_id = ? ORDER BY date, id', [nodeId]);
  const rem = await remindersOf(ctx.gc, ctx.viewer, rows.map((r) => r.id));
  const cal = await calendarOf(ctx.gc, ctx.viewer, rows.map((r) => r.id));
  return rows.map((r) => view(r, rem.get(r.id), cal.get(r.id), ctx.lang));
}

/**
 * Inside a transaction: the deadlines of file `nodeId` become `list` ([{ kind, date, label }]); one of the same kind and
 * date keeps its row (and the reminders and calendar entries on it), the others go with theirs. → the ids of the new
 * ones (`now`: their found_at).
 */
async function replace(gc, nodeId, list, now = Date.now()) {
  const old = await store.all(gc, 'SELECT * FROM doc_deadlines WHERE node_id = ?', [nodeId]);
  const kept = new Set();
  const added = [];
  for (const x of list) {
    const hit = old.find((o) => o.kind === x.kind && o.date === x.date && !kept.has(o.id));
    if (hit) {
      kept.add(hit.id);
      if ((hit.label || null) !== (x.label || null)) await store.run(gc, 'UPDATE doc_deadlines SET label = ? WHERE id = ?', [x.label || null, hit.id]);
    } else {
      const r = await store.run(gc, 'INSERT INTO doc_deadlines (node_id, kind, date, label, found_at) VALUES (?, ?, ?, ?, ?)', [nodeId, x.kind, x.date, x.label || null, now]);
      added.push(Number(r.lastInsertRowid));
    }
  }
  for (const o of old) {
    if (kept.has(o.id)) continue;
    await store.run(gc, 'DELETE FROM doc_reminders WHERE deadline_id = ?', [o.id]);
    await store.run(gc, 'DELETE FROM doc_calendar WHERE deadline_id = ?', [o.id]);
    await store.run(gc, 'DELETE FROM doc_deadlines WHERE id = ?', [o.id]);
  }
  return added;
}

/** Deadline `id` of a file the viewer reads → { d, node }. */
async function reach(ctx, id) {
  const n = posInt(id);
  const d = n ? await store.one(ctx.gc, 'SELECT * FROM doc_deadlines WHERE id = ?', [n]) : null;
  if (!d) throw fail('not_found');
  const { node } = await nodes.reach(ctx, d.node_id);
  // a vault's file (since 1.9.0) has no deadlines; should one be left, it takes no reminder
  if (node.vault_id) throw fail('encrypted');
  return { d, node };
}

/** POST deadlines/<id>/remind { daysBefore } */
async function remind(ctx, id, body) {
  const { d } = await reach(ctx, id);
  const days = nonNeg(body && body.daysBefore);
  if (days == null || days > DAYS_MAX) throw fail('invalid', { field: 'daysBefore' });
  const start = startOf(d.date);
  if (!Number.isFinite(start) || start + DAY <= ctx.now) throw fail('invalid', { field: 'date' });
  const at = Math.max(ctx.now, start + REMIND_HOUR_UTC * 3600000 - days * DAY);
  await store.run(ctx.gc, `INSERT INTO doc_reminders (deadline_id, user_id, days_before, at, sent_at) VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(deadline_id, user_id) DO UPDATE SET days_before = excluded.days_before, at = excluded.at, sent_at = NULL`, [d.id, ctx.viewer, days, at]);
  return { deadline: await viewOne(ctx, d) };
}

/** DELETE deadlines/<id>/remind */
async function unremind(ctx, id) {
  const { d } = await reach(ctx, id);
  await store.run(ctx.gc, 'DELETE FROM doc_reminders WHERE deadline_id = ? AND user_id = ?', [d.id, ctx.viewer]);
  return { deadline: await viewOne(ctx, d) };
}

function dayArg(v, field, fallback) {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'string' || !DATE_RE.test(v) || !Number.isFinite(startOf(v))) throw fail('invalid', { field });
  return v;
}

/** GET deadlines?from=&to= */
async function list(ctx, q) {
  const from = dayArg(q && q.from, 'from', day(ctx.now));
  const to = dayArg(q && q.to, 'to', day(startOf(from) + 365 * DAY));
  if (to < from) throw fail('invalid', { field: 'to' });
  const ids = (await ctx.visible()).map((x) => x.area.id);
  if (!ids.length) return { deadlines: [] };
  const rows = await store.all(ctx.gc, `SELECT d.id AS dl_id, d.kind AS dl_kind, d.date AS dl_date, d.label AS dl_label, d.found_at AS dl_found, n.* ${FROM(ids.length)}
    ORDER BY d.date, d.id LIMIT ?`, [...ids, from, to, LIST_MAX]);
  return { deadlines: await views(ctx, rows) };
}

// the deadlines of live files outside a vault in the areas (n of them), from a day to a day
const FROM = (n) => `FROM doc_deadlines d JOIN nodes n ON n.id = d.node_id WHERE n.area_id IN (${store.marks(n)}) AND n.deleted_at IS NULL AND n.vault_id IS NULL
    AND d.date >= ? AND d.date <= ?`;

/**
 * The overview (since 1.18.0): the next `max` deadlines from today as GET deadlines answers them, and how many there are
 * (the range of GET deadlines without from / to) → { deadlines, total }.
 */
async function upcoming(ctx, max) {
  const from = day(ctx.now);
  const to = day(startOf(from) + 365 * DAY);
  const ids = (await ctx.visible()).map((x) => x.area.id);
  if (!ids.length) return { deadlines: [], total: 0 };
  const n = await store.one(ctx.gc, `SELECT COUNT(*) AS n ${FROM(ids.length)}`, [...ids, from, to]);
  if (!n || !n.n) return { deadlines: [], total: 0 };
  const rows = await store.all(ctx.gc, `SELECT d.id AS dl_id, d.kind AS dl_kind, d.date AS dl_date, d.label AS dl_label, d.found_at AS dl_found, n.* ${FROM(ids.length)}
    ORDER BY d.date, d.id LIMIT ?`, [...ids, from, to, max]);
  return { deadlines: await views(ctx, rows), total: n.n };
}

/** Deadline rows (with their node) → the deadlines as GET deadlines answers them. */
async function views(ctx, rows) {
  const rem = await remindersOf(ctx.gc, ctx.viewer, rows.map((r) => r.dl_id));
  const cal = await calendarOf(ctx.gc, ctx.viewer, rows.map((r) => r.dl_id));
  const docs = await docsOf(ctx.gc, rows);
  const out = [];
  for (const r of rows) {
    const { dl_id: id, dl_kind: kind, dl_date: date, dl_label: label, dl_found: found, ...n } = r;
    out.push({ ...view({ id, kind, date, label, found_at: found }, rem.get(id), cal.get(id), ctx.lang), doc: docs.get(n.id) || null, node: nodes.view(n, { path: await nodes.pathOf(ctx.gc, n) }) });
  }
  return out;
}

/** What the AI read in the files of `rows` (a ready insight of their current version) → Map node id → doc. */
async function docsOf(gc, rows) {
  const out = new Map();
  const revs = new Map(rows.map((r) => [r.id, r.rev]));
  for (const part of store.chunks([...revs.keys()])) {
    const got = await store.all(gc, `SELECT node_id, rev, kind, title, sender, amount, currency FROM doc_insights WHERE status = 'ready' AND node_id IN (${store.marks(part.length)})`, part);
    for (const x of got) {
      if (revs.get(x.node_id) !== x.rev) continue;
      out.set(x.node_id, { kind: x.kind, title: x.title || null, sender: x.sender || null, amount: x.amount == null ? null : x.amount, currency: x.currency || null });
    }
  }
  return out;
}

// ─── the calendars: Familie (since 1.14.0) and Mail (since 1.17.0) ───

/** Can Drive reach `plugin`'s `service` now (asks nobody) — and has it not refused Drive within REFUSED_MS? */
async function reachable(gc, plugin, service, refusedKey) {
  if (!gc.services || typeof gc.services.available !== 'function' || typeof gc.services.call !== 'function') return false;
  let on = false;
  try { on = (await gc.services.available(plugin, service)) === true; } catch { on = false; }
  if (!on) return false;
  let refused = null;
  try { refused = await gc.storage.get(refusedKey); } catch { refused = null; }
  return !(Number.isFinite(refused) && Date.now() - refused < REFUSED_MS);
}

/** Can Drive reach Familie's calendar_add now? */
const calendarReachable = (gc) => reachable(gc, FAMILIE, CALENDAR, REFUSED_KEY);
/** Can Drive reach Mail's calendar_add now (since 1.17.0)? */
const mailReachable = (gc) => reachable(gc, MAIL, MAIL_ADD, MAIL_REFUSED_KEY);

/** What the calendar entry is called: what to do, about what — ≤ 80 characters ("Kfz-Versicherung kündigen"). */
function calendarTitle(lang, d, node, doc) {
  const what = (d.label && d.label.trim()) || '';
  // the AI's label already says what to do (e.g. „Kfz-Versicherung kündigen“)
  let s = what;
  if (!s) {
    const about = (doc && (doc.sender || doc.title)) || String(node.name || '').replace(/\.[^.]{1,8}$/, '');
    s = t(lang, `deadline.cal.${d.kind}`, { what: about });
  }
  s = s.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > TITLE_MAX ? s.slice(0, TITLE_MAX - 1).trimEnd() + '…' : s;
}

/** Familie's refusal or the host's error → the reason of 409 familie_unavailable. */
function calendarFail(reason) {
  return fail('familie_unavailable', { reason });
}

const mailFail = (reason) => fail('mail_unavailable', { reason });

/** A host error of gc.services.call → the reason. */
const hostReason = (e) => {
  const code = e && e.code;
  return code === 'ERR_RATE_LIMIT' ? 'rate_limited' : code === 'ERR_TIMEOUT' ? 'timeout' : 'unavailable';
};

/** A refusal of Drive as a caller: that calendar's feature goes for a while. */
async function refused(gc, key, now) {
  try { await gc.storage.set(key, now); } catch { /* best effort */ }
}

/** The key of a target in doc_calendar: 'family' | 'mail:<calendarId>'. */
const targetKey = (x) => (x.kind === 'mail' ? `mail:${x.calendarId}` : 'family');

/**
 * A target as an app sends it → null | { kind: 'family' } | { kind: 'mail', calendarId } (not yet checked against Mail);
 * anything else → 400 invalid { field }.
 */
function targetArg(v, field) {
  if (v === null) return null;
  const bad = () => fail('invalid', { field });
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad();
  if (v.kind === 'family') return { kind: 'family' };
  if (v.kind !== 'mail') throw bad();
  const id = v.calendarId;
  if (!((Number.isSafeInteger(id) && id > 0) || (typeof id === 'string' && CAL_ID_RE.test(id)))) throw bad();
  return { kind: 'mail', calendarId: id };
}

/** The calendars of Mail person `uid` can write to (calendar_list). Throws mail_unavailable. */
async function mailCalendars(gc, uid, lang, now) {
  if (!(await mailReachable(gc))) throw mailFail('unavailable');
  let res;
  try {
    res = await gc.services.call({ plugin: MAIL, service: MAIL_LIST, userId: uid, payload: { userId: uid, lang } });
  } catch (e) { throw mailFail(hostReason(e)); }
  if (!res || res.ok !== true || !Array.isArray(res.calendars)) {
    const code = res && typeof res.code === 'string' ? res.code : 'failed';
    if (code === 'forbidden') await refused(gc, MAIL_REFUSED_KEY, now);
    throw mailFail((res && typeof res.reason === 'string' && res.reason) || code);
  }
  return res.calendars.filter((c) => c && (Number.isSafeInteger(c.id) || typeof c.id === 'string') && typeof c.name === 'string').map((c) => {
    const a = c.account && typeof c.account === 'object' ? c.account : {};
    return {
      id: c.id, name: line(c.name).slice(0, 120), color: typeof c.color === 'string' ? c.color : null,
      account: { id: a.id == null ? null : a.id, label: line(typeof a.label === 'string' ? a.label : '').slice(0, 80), kind: typeof a.kind === 'string' ? a.kind : null, email: typeof a.email === 'string' ? a.email : null },
    };
  });
}

/** The label of a Mail calendar: „Outlook.com · Kalender“ (≤ 120). */
const mailLabel = (c) => [c.account.label, c.name].filter(Boolean).join(' · ').slice(0, 120);

/**
 * A checked target (targetArg) → the target to keep: the family calendar while Familie is reachable, a calendar of Mail
 * the person can write to (with its label). Throws familie_unavailable / mail_unavailable.
 */
async function resolveTarget(gc, uid, lang, x, now) {
  if (x == null) return null;
  if (x.kind === 'family') {
    if (!(await calendarReachable(gc))) throw calendarFail('unavailable');
    return { kind: 'family' };
  }
  const c = (await mailCalendars(gc, uid, lang, now)).find((y) => String(y.id) === String(x.calendarId));
  if (!c) throw mailFail('not_found');
  return { kind: 'mail', calendarId: c.id, label: mailLabel(c) };
}

/** The note of an entry in a calendar of Mail: the file and „In Drive öffnen“ with its link (≤ 500). */
async function noteOf(gc, settings, node, lang, now) {
  let link = null;
  try { link = settings ? await address.linkOf(gc, settings, node.id, now) : null; } catch { link = null; }
  const name = String(node.name || '').replace(/[\0-\x1f\x7f]/g, ' ').slice(0, 200);
  const s = link ? `${name}\n${t(lang, 'deadline.cal.open')}: ${link}` : name;
  return s.slice(0, NOTE_MAX);
}

const rowOf = (gc, d, uid, key) => store.one(gc, 'SELECT * FROM doc_calendar WHERE deadline_id = ? AND user_id = ? AND target = ?', [d.id, uid, key]);

/**
 * Deadline row `d` of file `node` into person `uid`'s calendar `target` (default: the family calendar; `lang`: the
 * title's language; `settings`: the link in the note of a Mail calendar) → the doc_calendar row; already there: that
 * row. Throws familie_unavailable / mail_unavailable.
 */
async function addToCalendar(gc, d, node, uid, lang, now, auto = false, target = null, settings = null) {
  const x = target || { kind: 'family' };
  const key = targetKey(x);
  const have = await rowOf(gc, d, uid, key);
  if (have) return have;
  const isMail = x.kind === 'mail';
  const fails = isMail ? mailFail : calendarFail;
  if (!(await (isMail ? mailReachable(gc) : calendarReachable(gc)))) throw fails('unavailable');
  const docs = await docsOf(gc, [node]);
  const title = calendarTitle(lang, d, node, docs.get(node.id));
  const payload = isMail
    ? { userId: uid, calendarId: x.calendarId, title, startsAt: d.date, allDay: true, note: await noteOf(gc, settings, node, lang, now), key: `drive:deadline:${d.id}`, lang }
    : { userId: uid, title, startsAt: d.date, allDay: true };
  let res;
  try {
    res = await gc.services.call({ plugin: isMail ? MAIL : FAMILIE, service: isMail ? MAIL_ADD : CALENDAR, userId: uid, payload });
  } catch (e) { throw fails(hostReason(e)); }
  if (!res || res.ok !== true) {
    const code = res && typeof res.code === 'string' ? res.code : 'failed';
    // a calendar plugin that does not take Drive as a caller: the feature goes for a while
    if (code === 'forbidden') await refused(gc, isMail ? MAIL_REFUSED_KEY : REFUSED_KEY, now);
    throw fails((isMail && res && typeof res.reason === 'string' && res.reason) || code);
  }
  const eventId = Number.isSafeInteger(res.eventId) || (typeof res.eventId === 'string' && res.eventId.length <= 128) ? res.eventId : null;
  await store.run(gc, `INSERT INTO doc_calendar (deadline_id, user_id, target, kind, label, event_id, at, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(deadline_id, user_id, target) DO NOTHING`, [d.id, uid, key, x.kind, isMail ? x.label || null : null, eventId, now, auto ? 1 : 0]);
  return rowOf(gc, d, uid, key);
}

/**
 * POST deadlines/<id>/calendar { target? } → { deadline } — the viewer's own entry (read is enough): without a target in
 * the family calendar, with { kind: 'mail', calendarId } in that calendar of Mail.
 */
async function calendar(ctx, id, body) {
  const { d, node } = await reach(ctx, id);
  const b = body && typeof body === 'object' ? body : {};
  const x = b.target === undefined || b.target === null ? { kind: 'family' } : targetArg(b.target, 'target');
  // there already: no call to Mail at all
  if (!(await rowOf(ctx.gc, d, ctx.viewer, targetKey(x)))) {
    const target = await resolveTarget(ctx.gc, ctx.viewer, ctx.lang, x, ctx.now);
    await addToCalendar(ctx.gc, d, node, ctx.viewer, ctx.lang, ctx.now, false, target, ctx.settings);
  }
  return { deadline: await viewOne(ctx, d) };
}

/** GET deadlines/calendars → { family, mail } — what the apps offer as targets. */
async function calendars(ctx) {
  let mail = [];
  if (await mailReachable(ctx.gc)) {
    try { mail = (await mailCalendars(ctx.gc, ctx.viewer, ctx.lang, ctx.now)).map((c) => ({ id: c.id, name: c.name, account: c.account, color: c.color })); } catch { mail = []; }
  }
  return { family: await calendarReachable(ctx.gc), mail };
}

// ─── targets per person and area (since 1.17.0) ───

const parseTarget = (s) => {
  try {
    const v = JSON.parse(s);
    if (v && v.kind === 'family') return { kind: 'family' };
    if (v && v.kind === 'mail' && v.calendarId != null) return { kind: 'mail', calendarId: v.calendarId, label: typeof v.label === 'string' ? v.label : '' };
  } catch { /* none */ }
  return null;
};

/** The targets of person `uid` in areas `areaIds` → Map area id → target | null (an own choice, else the area's switch). */
async function targetsOf(gc, uid, areaIds) {
  const out = new Map(areaIds.map((id) => [id, null]));
  for (const part of store.chunks(areaIds)) {
    const m = store.marks(part.length);
    for (const r of await store.all(gc, `SELECT area_id, deadlines_to_calendar AS c FROM area_prefs WHERE area_id IN (${m})`, part)) {
      if (r.c === 1) out.set(r.area_id, { kind: 'family' });
    }
    for (const r of await store.all(gc, `SELECT area_id, target FROM deadline_targets WHERE user_id = ? AND area_id IN (${m})`, [uid, ...part])) out.set(r.area_id, parseTarget(r.target));
  }
  return out;
}

const targetOf = async (gc, uid, areaId) => (await targetsOf(gc, uid, [areaId])).get(areaId) || null;

/** Person `uid`'s own choice for area `areaId` (a resolved target or null = not at all). */
async function setTarget(gc, uid, areaId, target, now) {
  await store.run(gc, `INSERT INTO deadline_targets (user_id, area_id, target, at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, area_id) DO UPDATE SET target = excluded.target, at = excluded.at`, [uid, areaId, JSON.stringify(target), now]);
}

/** Person `uid`'s own choice for area `areaId` goes: the area's switch holds again. */
async function clearTarget(gc, uid, areaId) {
  await store.run(gc, 'DELETE FROM deadline_targets WHERE user_id = ? AND area_id = ?', [uid, areaId]);
}

/**
 * New deadlines `ids` of file `nodeId` into calendar `target` of person `uid` (insights.js — the target of that person
 * in the area) — best effort, at most AUTO_MAX calls, quietly skipped when the calendar's plugin is not there.
 * `asPerson(uid)` → their context (they must still read the file) or null. → how many went in.
 */
async function auto(gc, nodeId, ids, uid, asPerson, now, target = { kind: 'family' }) {
  if (!ids.length || uid == null || typeof asPerson !== 'function' || !target) return 0;
  if (!(await (target.kind === 'mail' ? mailReachable(gc) : calendarReachable(gc)))) return 0;
  const ctx = await asPerson(uid);
  const node = await nodes.row(gc, nodeId);
  if (!ctx || !node || node.deleted_at != null || node.vault_id || !(await ctx.visible()).some((v) => v.area.id === node.area_id)) return 0;
  let n = 0;
  for (const id of ids.slice(0, AUTO_MAX)) {
    const d = await store.one(gc, 'SELECT * FROM doc_deadlines WHERE id = ?', [id]);
    // a day that has passed is no date for the calendar
    if (!d || startOf(d.date) + DAY <= now) continue;
    try { await addToCalendar(gc, d, node, uid, ctx.lang, now, true, target, ctx.settings); n++; } catch (e) { gc.log.warn('deadline into the calendar failed', target.kind, (e && e.extra && e.extra.reason) || (e && e.code) || 'error'); break; }
  }
  return n;
}

/** "14.03.2026" / "2026-03-14" */
const dateText = (date, lang) => (lang === 'en' ? date : date.split('-').reverse().join('.'));

/**
 * The background run: reminders whose time came go out (topic deadline), at most DUE_BATCH a run. `asPerson(uid)` → the
 * person's context (index.js) or null (no seat, no licence, gone) — then, and when they no longer read the file, nothing
 * is sent. Each reminder goes once.
 */
async function due(gc, settings, now, asPerson) {
  if (typeof asPerson !== 'function') return 0;
  const rows = await store.all(gc, `SELECT r.deadline_id, r.user_id, r.days_before, d.node_id, d.kind, d.date, d.label FROM doc_reminders r
    JOIN doc_deadlines d ON d.id = r.deadline_id WHERE r.sent_at IS NULL AND r.at <= ? ORDER BY r.at LIMIT ?`, [now, DUE_BATCH]);
  let sent = 0;
  for (const r of rows) {
    await store.run(gc, 'UPDATE doc_reminders SET sent_at = ? WHERE deadline_id = ? AND user_id = ?', [now, r.deadline_id, r.user_id]);
    const n = await nodes.row(gc, r.node_id);
    if (!n || n.deleted_at != null) continue;
    const ctx = await asPerson(r.user_id);
    if (!ctx || !(await ctx.visible()).some((v) => v.area.id === n.area_id)) continue;
    const lang = ctx.lang;
    let link = null;
    try { link = await address.linkOf(gc, settings, n.id, now); } catch { link = null; }
    try {
      await gc.notify({
        topic: 'deadline', users: [r.user_id], collapseKey: `drive-deadline:${r.deadline_id}`,
        title: t(lang, `deadline.${r.kind}`, { date: dateText(r.date, lang) }),
        body: t(lang, 'deadline.body', { file: n.name, label: r.label || t(lang, `deadline.${r.kind}.short`) }),
        data: {
          drive: { node: n.id, area: n.area_id, deadline: r.deadline_id }, ...(link ? { link } : {}),
          actions: [{ id: 'open', type: 'open_portal', label: t(lang, 'notify.open'), target: address.nodePath(n.id) }],
        },
      });
      sent++;
    } catch (e) { gc.log.warn('deadline reminder failed', (e && e.code) || 'error'); }
  }
  return sent;
}

module.exports = {
  KINDS, ofNode, replace, remind, unremind, list, upcoming, due, calendar, calendars, calendarReachable, mailReachable, auto, calendarTitle, docsOf, viewOne, reach,
  targetArg, resolveTarget, targetsOf, targetOf, setTarget, clearTarget, TARGETS_MAX,
};
