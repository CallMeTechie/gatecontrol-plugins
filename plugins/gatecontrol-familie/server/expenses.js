'use strict';

// Household book — "Haushaltsbuch" (module expenses, default off; parents only,
// children get 403 parents_only). Bookkeeping only: integer cents (EUR),
// nothing is ever paid or transferred — "Erledigt" just records the month.
//
//   GET    expenses?month=YYYY-MM       (default: this month) → { month, expenses, totals: { all, shared,
//                                       byCategory }, settlement, transfers, balances, settled, settledAt, settledBy }
//   POST   expenses                     { cents > 0, category, paidBy (a parent, default me), date (default today),
//                                         note ≤ 80, shared (default true), listId? }
//   PATCH  expenses/<id>   DELETE expenses/<id>
//   POST   expenses/settle   { month }  marks the month settled (record only)
//   POST   expenses/unsettle { month }  (addition) takes it back
//
// Settlement: the shared expenses of the month paid by current parents are
// split equally among the parents (cents that do not divide go to the first
// parents in member order, one each); every parent's balance = paid − share.
// transfers = the fewest payments that even it out (equal opposite amounts
// first, then largest debtor to largest creditor) — with 2 parents at most
// one. settlement = that transfer when there is exactly one, else null.
// A change to an expense of a settled month reopens the month.

const store = require('./store');
const members = require('./members');
const { fail, posInt, optText, bool, intIn, date, iso, parseJson } = require('./util');

const CATEGORIES = ['food', 'kids', 'household', 'leisure', 'mobility', 'other'];
const NOTE_MAX = 80;
const MAX_CENTS = 10000000;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const view = (x) => ({
  id: x.id, cents: x.cents, category: CATEGORIES.includes(x.category) ? x.category : 'other', paidBy: x.paid_by, date: x.date, note: x.note || '',
  shared: !!x.shared, listId: x.list_id || null, createdBy: x.created_by == null ? null : x.created_by, createdAt: iso(x.created_at),
});

function month(v, today) {
  if (v == null || v === '') return today.slice(0, 7);
  if (typeof v !== 'string' || !MONTH_RE.test(v)) throw fail('invalid', { field: 'month' });
  return v;
}

/**
 * Split shared expenses among `parentIds` → { balances: [{ userId, paidCents, shareCents, balanceCents }], transfers }.
 * Pure (tests).
 */
function settle(parentIds, expenses) {
  const ids = [...parentIds];
  if (ids.length < 2) return { balances: ids.map((id) => ({ userId: id, paidCents: 0, shareCents: 0, balanceCents: 0 })), transfers: [] };
  const paid = new Map(ids.map((id) => [id, 0]));
  for (const e of expenses) if (e.shared && paid.has(e.paidBy)) paid.set(e.paidBy, paid.get(e.paidBy) + e.cents);
  const total = [...paid.values()].reduce((a, b) => a + b, 0);
  const base = Math.floor(total / ids.length);
  const rem = total - base * ids.length;
  const balances = ids.map((id, i) => {
    const share = base + (i < rem ? 1 : 0);
    return { userId: id, paidCents: paid.get(id), shareCents: share, balanceCents: paid.get(id) - share };
  });
  const open = balances.map((b) => ({ id: b.userId, v: b.balanceCents })).filter((b) => b.v !== 0);
  const transfers = [];
  // equal and opposite amounts settle in one payment each
  for (const d of open) {
    if (d.v >= 0) continue;
    const c = open.find((x) => x.v === -d.v);
    if (c) { transfers.push({ from: d.id, to: c.id, cents: c.v }); c.v = 0; d.v = 0; }
  }
  for (;;) {
    const debt = open.filter((x) => x.v < 0).sort((a, b) => a.v - b.v)[0];
    const cred = open.filter((x) => x.v > 0).sort((a, b) => b.v - a.v)[0];
    if (!debt || !cred) break;
    const cents = Math.min(-debt.v, cred.v);
    transfers.push({ from: debt.id, to: cred.id, cents });
    debt.v += cents;
    cred.v -= cents;
  }
  return { balances, transfers };
}

async function monthView(gc, r, m) {
  const rows = await store.all(gc, 'SELECT * FROM expenses WHERE date >= ? AND date <= ? ORDER BY date DESC, id DESC', [`${m}-01`, `${m}-31`]);
  const list = rows.map(view);
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  let all = 0;
  let shared = 0;
  for (const e of list) { all += e.cents; byCategory[e.category] += e.cents; if (e.shared) shared += e.cents; }
  const s = settle(members.parents(r.fam).map((p) => p.userId), list);
  const done = await store.one(gc, 'SELECT * FROM expense_settlements WHERE month = ?', [m]);
  return {
    month: m, expenses: list, totals: { all, shared, byCategory },
    settlement: s.transfers.length === 1 ? s.transfers[0] : null, transfers: s.transfers, balances: s.balances,
    settled: !!done, settledAt: done ? iso(done.settled_at) : null, settledBy: done ? done.settled_by : null,
    settledTransfers: done ? parseJson(done.transfers_json, []) : null,
  };
}

/** GET expenses?month= */
async function get(gc, r) {
  return monthView(gc, r, month((r.query || {}).month, r.today));
}

function parentId(r, v) {
  const id = posInt(v);
  const m = id ? r.fam.byId.get(id) : null;
  if (!m || m.role !== 'parent') throw fail('invalid', { field: 'paidBy' });
  return id;
}

function fields(r, b, cur) {
  const f = {
    cents: b.cents !== undefined || !cur ? intIn(b.cents, 1, MAX_CENTS) : cur.cents,
    category: b.category !== undefined || !cur ? (CATEGORIES.includes(b.category) ? b.category : null) : cur.category,
    paid_by: b.paidBy !== undefined ? parentId(r, b.paidBy) : (cur ? cur.paid_by : r.me.userId),
    date: b.date !== undefined ? date(b.date) : (cur ? cur.date : r.today),
    note: b.note !== undefined ? (optText(b.note, NOTE_MAX) || '') : (cur ? cur.note : ''),
    shared: b.shared !== undefined ? (bool(b.shared) ? 1 : 0) : (cur ? cur.shared : 1),
    list_id: b.listId !== undefined ? (b.listId == null || b.listId === '' ? null : optText(b.listId, 64)) : (cur ? cur.list_id : null),
  };
  if (!f.category) throw fail('invalid', { field: 'category' });
  return f;
}

/** A change reopens the months it touches. */
async function reopen(gc, ...dates) {
  for (const d of new Set(dates.filter(Boolean).map((x) => x.slice(0, 7)))) await store.run(gc, 'DELETE FROM expense_settlements WHERE month = ?', [d]);
}

async function create(gc, r) {
  const f = fields(r, r.body || {}, null);
  const res = await store.run(gc, `INSERT INTO expenses (cents, category, paid_by, date, note, shared, list_id, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [f.cents, f.category, f.paid_by, f.date, f.note, f.shared, f.list_id, r.me.userId, r.now, r.now]);
  await reopen(gc, f.date);
  return { expense: view(await store.one(gc, 'SELECT * FROM expenses WHERE id = ?', [res.lastInsertRowid])) };
}

async function getRow(gc, raw) {
  const id = posInt(raw);
  const row = id ? await store.one(gc, 'SELECT * FROM expenses WHERE id = ?', [id]) : null;
  if (!row) throw fail('not_found');
  return row;
}

async function update(gc, r, raw) {
  const row = await getRow(gc, raw);
  const f = fields(r, r.body || {}, row);
  await store.run(gc, 'UPDATE expenses SET cents = ?, category = ?, paid_by = ?, date = ?, note = ?, shared = ?, list_id = ?, updated_at = ? WHERE id = ?',
    [f.cents, f.category, f.paid_by, f.date, f.note, f.shared, f.list_id, r.now, row.id]);
  await reopen(gc, row.date, f.date);
  return { expense: view(await store.one(gc, 'SELECT * FROM expenses WHERE id = ?', [row.id])) };
}

async function remove(gc, r, raw) {
  const row = await getRow(gc, raw);
  await store.run(gc, 'DELETE FROM expenses WHERE id = ?', [row.id]);
  await reopen(gc, row.date);
  return {};
}

/** POST expenses/settle { month } — record only. */
async function markSettled(gc, r) {
  const m = month((r.body || {}).month, r.today);
  const cur = await monthView(gc, r, m);
  if (!cur.settled) {
    await store.run(gc, 'INSERT INTO expense_settlements (month, transfers_json, settled_at, settled_by) VALUES (?, ?, ?, ?)',
      [m, JSON.stringify(cur.transfers), r.now, r.me.userId]);
  }
  return monthView(gc, r, m);
}

/** POST expenses/unsettle { month } */
async function unsettle(gc, r) {
  const m = month((r.body || {}).month, r.today);
  await store.run(gc, 'DELETE FROM expense_settlements WHERE month = ?', [m]);
  return monthView(gc, r, m);
}

/** Overview (parents): this month's total and whether it is settled. */
async function overview(gc, r) {
  if (r.me.role !== 'parent') return null;
  const v = await monthView(gc, r, r.today.slice(0, 7));
  return { month: v.month, totalCents: v.totals.all, sharedCents: v.totals.shared, settlement: v.settlement, settled: v.settled };
}

module.exports = { CATEGORIES, settle, get, create, update, remove, markSettled, unsettle, overview };
