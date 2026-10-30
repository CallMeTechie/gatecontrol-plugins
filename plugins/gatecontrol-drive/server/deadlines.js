'use strict';

// Deadlines of documents (since 1.8.0, part of `docAi`): the payment, cancellation and objection deadlines the AI found
// (insights.js) and a person's reminder of one — Drive's own notification (topic deadline) N days before the day.
//
//   GET    deadlines?from=&to=       → { deadlines: [{ id, kind, date, label, reminder, node }] } — of the files the
//                                      viewer reads, from (YYYY-MM-DD, default today) to (default from + 365 days),
//                                      by date, ≤ 500
//   POST   deadlines/<id>/remind     { daysBefore: 0…90 } → { deadline } — the viewer's reminder (read is enough)
//   DELETE deadlines/<id>/remind     → { deadline }
//   POST   deadlines/<id>/calendar   → { deadline } — into the family calendar (since 1.14.0, feature deadlineCalendar)
//
// A deadline: { id, kind: 'payment' | 'cancellation' | 'objection' | 'warranty' | 'renewal', date: 'YYYY-MM-DD', label,
// reminder: { at, daysBefore, sent } | null, calendar: { eventId, at } | null, foundAt } — the reminder and the calendar
// entry are the viewer's own. Since 1.14.0: warranty — the day a warranty ends; renewal — the last day to cancel before
// a contract renews (the label says when and how it renews). foundAt: when the AI found it (null: before 1.14.0).
// GET deadlines adds `doc` { kind, title, sender, amount, currency } — what the AI read in the file (null without).
// The reminder goes out at 07:00 UTC of the day minus daysBefore (already past: with the next background run); the
// person must still read the file then (else it is dropped quietly).
//
// The family calendar (since 1.14.0): GateControl's services (≥ 1.178.0, permissions.services
// "gatecontrol-familie:calendar_add" — the administrator confirms it with the update) — the Familie plugin enters an
// all-day date { userId, title (≤ 80, e.g. „Kfz-Versicherung kündigen“), startsAt: the day, allDay: true } for the
// viewer; Drive keeps { eventId, at } per person and deadline (doc_calendar) — a second call answers the same. Familie not
// there, not running, or it refuses (not a family member, its dates module off, it does not take Drive as a caller):
// 409 familie_unavailable { reason }. Per area (PATCH areas/<id> { deadlinesToCalendar }, default off) new deadlines go
// into the calendar on their own — for the person whose upload or "Erkennen" the recognition came from, else the
// owner of the area (my files, a child's folder), as long as they read the file (insights.js → auto()).
// Feature `deadlineCalendar` in GET me: while Familie's calendar_add is reachable (gc.services.available) — and not
// for REFUSED_MS after Familie refused Drive as a caller (`forbidden`: a Familie that takes calendar_add only from the
// Messenger), so the apps do not offer a button that cannot work; then it is tried again.

const store = require('./store');
const nodes = require('./nodes');
const address = require('./address');
const { t } = require('./text');
const { fail, posInt, nonNeg, iso, day } = require('./util');

const KINDS = ['payment', 'cancellation', 'objection', 'warranty', 'renewal'];
const FAMILIE = 'gatecontrol-familie';
const CALENDAR = 'calendar_add';
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

function view(d, rem, cal) {
  return {
    id: d.id, kind: d.kind, date: d.date, label: d.label || null,
    reminder: rem ? { at: iso(rem.at), daysBefore: rem.days_before, sent: rem.sent_at != null } : null,
    calendar: cal ? { eventId: cal.event_id == null ? null : cal.event_id, at: iso(cal.at) } : null,
    foundAt: iso(d.found_at),
  };
}

/** The viewer's calendar entries of deadlines `ids` → Map deadline id → row. */
async function calendarOf(gc, uid, ids) {
  const out = new Map();
  for (const part of store.chunks(ids)) {
    const rows = await store.all(gc, `SELECT * FROM doc_calendar WHERE user_id = ? AND deadline_id IN (${store.marks(part.length)})`, [uid, ...part]);
    for (const r of rows) out.set(r.deadline_id, r);
  }
  return out;
}

/** One deadline row as the viewer sees it. */
async function viewOne(ctx, d) {
  return view(d, (await remindersOf(ctx.gc, ctx.viewer, [d.id])).get(d.id), (await calendarOf(ctx.gc, ctx.viewer, [d.id])).get(d.id));
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
  return rows.map((r) => view(r, rem.get(r.id), cal.get(r.id)));
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
  const rows = await store.all(ctx.gc, `SELECT d.id AS dl_id, d.kind AS dl_kind, d.date AS dl_date, d.label AS dl_label, d.found_at AS dl_found, n.* FROM doc_deadlines d
    JOIN nodes n ON n.id = d.node_id WHERE n.area_id IN (${store.marks(ids.length)}) AND n.deleted_at IS NULL AND n.vault_id IS NULL AND d.date >= ? AND d.date <= ?
    ORDER BY d.date, d.id LIMIT ?`, [...ids, from, to, LIST_MAX]);
  const rem = await remindersOf(ctx.gc, ctx.viewer, rows.map((r) => r.dl_id));
  const cal = await calendarOf(ctx.gc, ctx.viewer, rows.map((r) => r.dl_id));
  const docs = await docsOf(ctx.gc, rows);
  const out = [];
  for (const r of rows) {
    const { dl_id: id, dl_kind: kind, dl_date: date, dl_label: label, dl_found: found, ...n } = r;
    out.push({ ...view({ id, kind, date, label, found_at: found }, rem.get(id), cal.get(id)), doc: docs.get(n.id) || null, node: nodes.view(n, { path: await nodes.pathOf(ctx.gc, n) }) });
  }
  return { deadlines: out };
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

// ─── the family calendar (since 1.14.0) ─────────

/** Can Drive reach Familie's calendar_add now (asks nobody)? */
async function calendarReachable(gc) {
  if (!gc.services || typeof gc.services.available !== 'function' || typeof gc.services.call !== 'function') return false;
  let on = false;
  try { on = (await gc.services.available(FAMILIE, CALENDAR)) === true; } catch { on = false; }
  if (!on) return false;
  let refused = null;
  try { refused = await gc.storage.get(REFUSED_KEY); } catch { refused = null; }
  return !(Number.isFinite(refused) && Date.now() - refused < REFUSED_MS);
}

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

/**
 * Deadline row `d` of file `node` into person `uid`'s family calendar (`lang`: the title's language) → the doc_calendar
 * row; already there: that row. Throws familie_unavailable.
 */
async function addToCalendar(gc, d, node, uid, lang, now, auto = false) {
  const have = await store.one(gc, 'SELECT * FROM doc_calendar WHERE deadline_id = ? AND user_id = ?', [d.id, uid]);
  if (have) return have;
  if (!(await calendarReachable(gc))) throw calendarFail('unavailable');
  const docs = await docsOf(gc, [node]);
  let res;
  try {
    res = await gc.services.call({
      plugin: FAMILIE, service: CALENDAR, userId: uid,
      payload: { userId: uid, title: calendarTitle(lang, d, node, docs.get(node.id)), startsAt: d.date, allDay: true },
    });
  } catch (e) {
    const code = e && e.code;
    throw calendarFail(code === 'ERR_RATE_LIMIT' ? 'rate_limited' : code === 'ERR_TIMEOUT' ? 'timeout' : 'unavailable');
  }
  if (!res || res.ok !== true) {
    const code = res && typeof res.code === 'string' ? res.code : 'failed';
    // a Familie that does not take Drive as a caller: the feature goes for a while
    if (code === 'forbidden') { try { await gc.storage.set(REFUSED_KEY, now); } catch { /* best effort */ } }
    throw calendarFail(code);
  }
  const eventId = Number.isSafeInteger(res.eventId) ? res.eventId : null;
  await store.run(gc, 'INSERT INTO doc_calendar (deadline_id, user_id, event_id, at, auto) VALUES (?, ?, ?, ?, ?) ON CONFLICT(deadline_id, user_id) DO NOTHING',
    [d.id, uid, eventId, now, auto ? 1 : 0]);
  return store.one(gc, 'SELECT * FROM doc_calendar WHERE deadline_id = ? AND user_id = ?', [d.id, uid]);
}

/** POST deadlines/<id>/calendar → { deadline } — the viewer's own entry in the family calendar (read is enough). */
async function calendar(ctx, id) {
  const { d, node } = await reach(ctx, id);
  await addToCalendar(ctx.gc, d, node, ctx.viewer, ctx.lang, ctx.now);
  return { deadline: await viewOne(ctx, d) };
}

/**
 * New deadlines `ids` of file `nodeId` into the family calendar of person `uid` (insights.js, an area with
 * deadlinesToCalendar on) — best effort, at most AUTO_MAX calls, quietly skipped when Familie is not there.
 * `asPerson(uid)` → their context (they must still read the file) or null. → how many went in.
 */
async function auto(gc, nodeId, ids, uid, asPerson, now) {
  if (!ids.length || uid == null || typeof asPerson !== 'function') return 0;
  if (!(await calendarReachable(gc))) return 0;
  const ctx = await asPerson(uid);
  const node = await nodes.row(gc, nodeId);
  if (!ctx || !node || node.deleted_at != null || node.vault_id || !(await ctx.visible()).some((v) => v.area.id === node.area_id)) return 0;
  let n = 0;
  for (const id of ids.slice(0, AUTO_MAX)) {
    const d = await store.one(gc, 'SELECT * FROM doc_deadlines WHERE id = ?', [id]);
    // a day that has passed is no date for the calendar
    if (!d || startOf(d.date) + DAY <= now) continue;
    try { await addToCalendar(gc, d, node, uid, ctx.lang, now, true); n++; } catch (e) { gc.log.warn('deadline into the calendar failed', (e && e.extra && e.extra.reason) || (e && e.code) || 'error'); break; }
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

module.exports = { KINDS, ofNode, replace, remind, unremind, list, due, calendar, calendarReachable, auto, calendarTitle, docsOf, viewOne, reach };
