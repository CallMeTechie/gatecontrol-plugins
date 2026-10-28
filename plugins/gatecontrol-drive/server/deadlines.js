'use strict';

// Deadlines of documents (since 1.8.0, part of `docAi`): the payment, cancellation and objection deadlines the AI found
// (insights.js) and a person's reminder of one — Drive's own notification (topic deadline) N days before the day.
//
//   GET    deadlines?from=&to=       → { deadlines: [{ id, kind, date, label, reminder, node }] } — of the files the
//                                      viewer reads, from (YYYY-MM-DD, default today) to (default from + 365 days),
//                                      by date, ≤ 500
//   POST   deadlines/<id>/remind     { daysBefore: 0…90 } → { deadline } — the viewer's reminder (read is enough)
//   DELETE deadlines/<id>/remind     → { deadline }
//
// A deadline: { id, kind: 'payment' | 'cancellation' | 'objection', date: 'YYYY-MM-DD', label, reminder: { at, daysBefore,
// sent } | null } — the reminder is the viewer's own. It goes out at 07:00 UTC of the day minus daysBefore (already past:
// with the next background run); the person must still read the file then (else it is dropped quietly).
// The Familie plugin offers no reminder service another plugin may call (its calendar services answer only the
// Messenger), so Drive reminds on its own.

const store = require('./store');
const nodes = require('./nodes');
const address = require('./address');
const { t } = require('./text');
const { fail, posInt, nonNeg, iso, day } = require('./util');

const KINDS = ['payment', 'cancellation', 'objection'];
const DAY = 86400000;
const REMIND_HOUR_UTC = 7;
const DAYS_MAX = 90;
const LIST_MAX = 500;
const DUE_BATCH = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const startOf = (date) => Date.parse(date + 'T00:00:00Z');

function view(d, rem) {
  return {
    id: d.id, kind: d.kind, date: d.date, label: d.label || null,
    reminder: rem ? { at: iso(rem.at), daysBefore: rem.days_before, sent: rem.sent_at != null } : null,
  };
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
  return rows.map((r) => view(r, rem.get(r.id)));
}

/**
 * Inside a transaction: the deadlines of file `nodeId` become `list` ([{ kind, date, label }]); one of the same kind and
 * date keeps its row (and the reminders on it), the others go with their reminders.
 */
async function replace(gc, nodeId, list) {
  const old = await store.all(gc, 'SELECT * FROM doc_deadlines WHERE node_id = ?', [nodeId]);
  const kept = new Set();
  for (const x of list) {
    const hit = old.find((o) => o.kind === x.kind && o.date === x.date && !kept.has(o.id));
    if (hit) {
      kept.add(hit.id);
      if ((hit.label || null) !== (x.label || null)) await store.run(gc, 'UPDATE doc_deadlines SET label = ? WHERE id = ?', [x.label || null, hit.id]);
    } else {
      await store.run(gc, 'INSERT INTO doc_deadlines (node_id, kind, date, label) VALUES (?, ?, ?, ?)', [nodeId, x.kind, x.date, x.label || null]);
    }
  }
  for (const o of old) {
    if (kept.has(o.id)) continue;
    await store.run(gc, 'DELETE FROM doc_reminders WHERE deadline_id = ?', [o.id]);
    await store.run(gc, 'DELETE FROM doc_deadlines WHERE id = ?', [o.id]);
  }
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
  return { deadline: view(d, (await remindersOf(ctx.gc, ctx.viewer, [d.id])).get(d.id)) };
}

/** DELETE deadlines/<id>/remind */
async function unremind(ctx, id) {
  const { d } = await reach(ctx, id);
  await store.run(ctx.gc, 'DELETE FROM doc_reminders WHERE deadline_id = ? AND user_id = ?', [d.id, ctx.viewer]);
  return { deadline: view(d, null) };
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
  const rows = await store.all(ctx.gc, `SELECT d.id AS dl_id, d.kind AS dl_kind, d.date AS dl_date, d.label AS dl_label, n.* FROM doc_deadlines d
    JOIN nodes n ON n.id = d.node_id WHERE n.area_id IN (${store.marks(ids.length)}) AND n.deleted_at IS NULL AND n.vault_id IS NULL AND d.date >= ? AND d.date <= ?
    ORDER BY d.date, d.id LIMIT ?`, [...ids, from, to, LIST_MAX]);
  const rem = await remindersOf(ctx.gc, ctx.viewer, rows.map((r) => r.dl_id));
  const out = [];
  for (const r of rows) {
    const { dl_id: id, dl_kind: kind, dl_date: date, dl_label: label, ...n } = r;
    out.push({ ...view({ id, kind, date, label }, rem.get(id)), node: nodes.view(n, { path: await nodes.pathOf(ctx.gc, n) }) });
  }
  return { deadlines: out };
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

module.exports = { KINDS, ofNode, replace, remind, unremind, list, due };
