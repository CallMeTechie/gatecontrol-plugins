'use strict';

// Pocket money — "Taschengeld" (module allowance, default off). Bookkeeping
// only: integer cents (EUR); nothing is ever paid, charged or transferred.
//
//   GET  allowance                              parents: every child's account; a child: its own
//   POST allowance/<childId>/bookings           parents: { cents, note, kind: 'manual'|'spend' }
//   DELETE allowance/<childId>/bookings/<id>    parents: a manual / spend booking (addition)
//   PUT  allowance/<childId>/rule               parents: { amountCents, interval, weekday | dayOfMonth,
//                                               active, starRate: { stars, cents } | null } (partial)
//   POST allowance/<childId>/convert            the child itself: { stars } → a pending request
//   POST allowance/requests/<id>/approve        parents → booking 'stars'
//   POST allowance/requests/<id>/decline        parents
//
// An account: { childId, name, balanceCents, rule, starRate, nextPayout,
// nextPayoutAt, stars: { earned, converted, pending, convertible }, bookings
// (last 50, newest first), requests (pending and the last 10 decided) }.
//
// Payout (tick): on the payout day from 07:00 local the amount is booked once
// per period (unique (child, period) — 'w:<date>' / 'm:<YYYY-MM>'); a period
// missed while the server was down is caught up (only the latest one, never
// one from before the rule was switched on or rescheduled). The child gets
// "Dein Taschengeld ist da: 5,00 €" (topic allowance).
//
// Stars: convertible = stars earned (task_done.stars + carried, the stars of
// task rows removed by the retention) − stars converted − stars in pending
// requests. The weekly star counter of the tasks is not touched. A request
// must be a multiple of the star rate's stars.

const store = require('./store');
const tz = require('./tz');
const push = require('./push');
const members = require('./members');
const { fail, posInt, optText, bool, intIn, iso } = require('./util');

const KINDS = ['allowance', 'manual', 'stars', 'spend'];
const INTERVALS = ['weekly', 'monthly'];
const PAYOUT_AT = { hh: 7, mm: 0 };
const NOTE_MAX = 80;
const MAX_CENTS = 1000000;         // 10.000 € per booking
const MAX_AMOUNT = 100000;         // 1.000 € per payout
const BOOKINGS_SHOWN = 50;
const DECIDED_SHOWN = 10;
const DEFAULT_RULE = Object.freeze({ amountCents: 0, interval: 'weekly', weekday: 6, dayOfMonth: null, active: false });

const isoWd = (d) => ((tz.weekday(d) + 6) % 7) + 1;

/** 500 → "5,00 €" / "€5.00" */
function euro(cents, lang) {
  const n = Number(cents) || 0;
  const abs = Math.abs(n);
  const s = `${Math.floor(abs / 100)}${lang === 'en' ? '.' : ','}${String(abs % 100).padStart(2, '0')}`;
  const sign = n < 0 ? '−' : '';
  return lang === 'en' ? `${sign}€${s}` : `${sign}${s} €`;
}

function ruleOf(row) {
  if (!row) return { rule: { ...DEFAULT_RULE }, starRate: null, activeSince: null };
  const weekly = row.interval !== 'monthly';
  return {
    rule: {
      amountCents: row.amount_cents, interval: weekly ? 'weekly' : 'monthly',
      weekday: weekly ? (row.weekday || DEFAULT_RULE.weekday) : null, dayOfMonth: weekly ? null : (row.day_of_month || 1), active: !!row.active,
    },
    starRate: row.star_stars && row.star_cents ? { stars: row.star_stars, cents: row.star_cents } : null,
    activeSince: row.active_since,
  };
}

const ruleRow = (gc, childId) => store.one(gc, 'SELECT * FROM allowance_rules WHERE child_id = ?', [childId]);

function isPayoutDay(rule, d) {
  if (rule.interval === 'monthly') return tz.parseDate(d).d === rule.dayOfMonth;
  return isoWd(d) === rule.weekday;
}

/** The latest payout date on or before `d`. */
function payoutOnOrBefore(rule, d) {
  if (rule.interval === 'monthly') {
    const p = tz.parseDate(d);
    if (p.d >= rule.dayOfMonth) return tz.dateStr(p.y, p.m, rule.dayOfMonth);
    const m = p.m === 1 ? 12 : p.m - 1;
    return tz.dateStr(p.m === 1 ? p.y - 1 : p.y, m, rule.dayOfMonth);
  }
  return tz.addDays(d, -((isoWd(d) - rule.weekday + 7) % 7));
}

/** The first payout date after `d`. */
function payoutAfter(rule, d) {
  if (rule.interval === 'monthly') {
    const p = tz.parseDate(d);
    if (p.d < rule.dayOfMonth) return tz.dateStr(p.y, p.m, rule.dayOfMonth);
    return tz.dateStr(p.m === 12 ? p.y + 1 : p.y, p.m === 12 ? 1 : p.m + 1, rule.dayOfMonth);
  }
  const n = (rule.weekday - isoWd(d) + 7) % 7;
  return tz.addDays(d, n === 0 ? 7 : n);
}

const periodKey = (rule, d) => (rule.interval === 'monthly' ? `m:${d.slice(0, 7)}` : `w:${d}`);

/** The next payout date (today while today's payout is still to come), null when the rule is off. */
async function nextPayout(gc, childId, r, rule) {
  if (!rule.active || rule.amountCents <= 0) return null;
  if (isPayoutDay(rule, r.today)) {
    const booked = await store.one(gc, 'SELECT id FROM allowance_bookings WHERE child_id = ? AND period = ?', [childId, periodKey(rule, r.today)]);
    if (!booked) return r.today;
  }
  return payoutAfter(rule, r.today);
}

// ─── stars ──────────────────────────────────────

async function starsOf(gc, childId) {
  const acc = await store.one(gc, 'SELECT carried, converted FROM star_accounts WHERE user_id = ?', [childId]);
  const done = await store.one(gc, 'SELECT COALESCE(SUM(stars), 0) AS n FROM task_done WHERE user_id = ? AND stars > 0', [childId]);
  const pend = await store.one(gc, "SELECT COALESCE(SUM(stars), 0) AS n FROM allowance_requests WHERE child_id = ? AND status = 'pending'", [childId]);
  const earned = (acc ? acc.carried : 0) + done.n;
  const converted = acc ? acc.converted : 0;
  return { earned, converted, pending: pend.n, convertible: Math.max(0, earned - converted - pend.n) };
}

/** Retention of task_done (tasks.purge): keep the stars of the rows that go. Inside a transaction. */
async function carryStars(gc, before) {
  const rows = await store.all(gc, 'SELECT user_id, SUM(stars) AS n FROM task_done WHERE at < ? AND stars > 0 GROUP BY user_id', [before]);
  for (const x of rows) {
    await store.run(gc, `INSERT INTO star_accounts (user_id, carried, converted) VALUES (?, ?, 0)
      ON CONFLICT(user_id) DO UPDATE SET carried = carried + excluded.carried`, [x.user_id, x.n]);
  }
}

// ─── views ──────────────────────────────────────

const bookingView = (b) => ({ id: b.id, childId: b.child_id, cents: b.cents, kind: KINDS.includes(b.kind) ? b.kind : 'manual', note: b.note || '', at: iso(b.at), by: b.by_user == null ? null : b.by_user });
const requestView = (q) => ({
  id: q.id, childId: q.child_id, stars: q.stars, cents: q.cents, status: q.status, createdAt: iso(q.created_at), decidedAt: iso(q.decided_at), decidedBy: q.decided_by == null ? null : q.decided_by,
});

async function balance(gc, childId) {
  return (await store.one(gc, 'SELECT COALESCE(SUM(cents), 0) AS n FROM allowance_bookings WHERE child_id = ?', [childId])).n;
}

async function account(gc, r, m) {
  const { rule, starRate } = ruleOf(await ruleRow(gc, m.userId));
  const next = await nextPayout(gc, m.userId, r, rule);
  const bookings = await store.all(gc, 'SELECT * FROM allowance_bookings WHERE child_id = ? ORDER BY at DESC, id DESC LIMIT ?', [m.userId, BOOKINGS_SHOWN]);
  const pending = await store.all(gc, "SELECT * FROM allowance_requests WHERE child_id = ? AND status = 'pending' ORDER BY created_at, id", [m.userId]);
  const decided = await store.all(gc, "SELECT * FROM allowance_requests WHERE child_id = ? AND status != 'pending' ORDER BY decided_at DESC, id DESC LIMIT ?", [m.userId, DECIDED_SHOWN]);
  return {
    childId: m.userId, name: m.name, balanceCents: await balance(gc, m.userId), rule, starRate,
    nextPayout: next, nextPayoutAt: next ? iso(tz.at(next, PAYOUT_AT, r.cfg.tz)) : null,
    stars: await starsOf(gc, m.userId),
    bookings: bookings.map(bookingView), requests: [...pending, ...decided].map(requestView),
  };
}

/** The children the caller may see: parents all, a child itself. */
function visibleChildren(r) {
  if (r.me.role === 'parent') return members.children(r.fam);
  return r.me.role === 'child' ? [r.me] : [];
}

/** GET allowance */
async function get(gc, r) {
  const out = [];
  for (const m of visibleChildren(r)) out.push(await account(gc, r, m));
  return { accounts: out, currency: 'EUR' };
}

function childOf(r, raw) {
  const id = posInt(raw);
  const m = id ? r.fam.byId.get(id) : null;
  if (!m || m.role !== 'child') throw fail('not_found');
  return m;
}

const parentsOnly = (r) => { if (r.me.role !== 'parent') throw fail('parents_only'); };

/** POST allowance/<childId>/bookings (parents) */
async function book(gc, r, raw) {
  parentsOnly(r);
  const m = childOf(r, raw);
  const b = r.body || {};
  const kind = b.kind == null ? 'manual' : b.kind;
  if (kind !== 'manual' && kind !== 'spend') throw fail('invalid');
  const cents = intIn(b.cents, -MAX_CENTS, MAX_CENTS);
  if (cents === 0) throw fail('invalid');
  const note = optText(b.note, NOTE_MAX) || '';
  // a spend is always negative, whatever sign the caller used
  const value = kind === 'spend' ? -Math.abs(cents) : cents;
  const res = await store.run(gc, 'INSERT INTO allowance_bookings (child_id, cents, kind, note, period, at, by_user) VALUES (?, ?, ?, ?, NULL, ?, ?)',
    [m.userId, value, kind, note, r.now, r.me.userId]);
  const row = await store.one(gc, 'SELECT * FROM allowance_bookings WHERE id = ?', [res.lastInsertRowid]);
  return { booking: bookingView(row), balanceCents: await balance(gc, m.userId) };
}

/** DELETE allowance/<childId>/bookings/<id> (parents; manual and spend bookings only) */
async function unbook(gc, r, raw, rawId) {
  parentsOnly(r);
  const m = childOf(r, raw);
  const id = posInt(rawId);
  const row = id ? await store.one(gc, 'SELECT * FROM allowance_bookings WHERE id = ? AND child_id = ?', [id, m.userId]) : null;
  if (!row) throw fail('not_found');
  if (row.kind !== 'manual' && row.kind !== 'spend') throw fail('forbidden');
  await store.run(gc, 'DELETE FROM allowance_bookings WHERE id = ?', [id]);
  return { balanceCents: await balance(gc, m.userId) };
}

/** PUT allowance/<childId>/rule (parents; fields not given stay) */
async function putRule(gc, r, raw) {
  parentsOnly(r);
  const m = childOf(r, raw);
  const b = r.body || {};
  const row = await ruleRow(gc, m.userId);
  const cur = ruleOf(row);
  const next = { ...cur.rule };
  if (b.amountCents !== undefined) next.amountCents = intIn(b.amountCents, 0, MAX_AMOUNT);
  if (b.interval !== undefined) {
    if (!INTERVALS.includes(b.interval)) throw fail('invalid');
    next.interval = b.interval;
  }
  if (next.interval === 'weekly') {
    next.weekday = b.weekday != null ? intIn(b.weekday, 1, 7) : (next.weekday || DEFAULT_RULE.weekday);
    next.dayOfMonth = null;
  } else {
    next.dayOfMonth = b.dayOfMonth != null ? intIn(b.dayOfMonth, 1, 28) : (next.dayOfMonth || 1);
    next.weekday = null;
  }
  if (b.active !== undefined) next.active = bool(b.active);
  let starRate = cur.starRate;
  if (b.starRate !== undefined) {
    if (b.starRate === null) starRate = null;
    else if (typeof b.starRate !== 'object' || Array.isArray(b.starRate)) throw fail('invalid');
    else starRate = { stars: intIn(b.starRate.stars, 1, 1000), cents: intIn(b.starRate.cents, 1, 10000) };
  }
  // switched on or rescheduled: periods before now are never paid (no surprise payout)
  const rescheduled = !cur.rule.active || next.interval !== cur.rule.interval || next.weekday !== cur.rule.weekday || next.dayOfMonth !== cur.rule.dayOfMonth;
  const activeSince = next.active ? (rescheduled || cur.activeSince == null ? r.now : cur.activeSince) : null;
  await store.run(gc, `INSERT INTO allowance_rules (child_id, amount_cents, interval, weekday, day_of_month, active, active_since, star_stars, star_cents, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(child_id) DO UPDATE SET amount_cents = excluded.amount_cents, interval = excluded.interval, weekday = excluded.weekday, day_of_month = excluded.day_of_month,
      active = excluded.active, active_since = excluded.active_since, star_stars = excluded.star_stars, star_cents = excluded.star_cents, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  [m.userId, next.amountCents, next.interval, next.weekday, next.dayOfMonth, next.active ? 1 : 0, activeSince, starRate ? starRate.stars : null, starRate ? starRate.cents : null, r.now, r.me.userId]);
  return { account: await account(gc, r, m) };
}

/** POST allowance/<childId>/convert { stars } — the child itself asks; the parents decide. */
async function convert(gc, r, raw) {
  const m = childOf(r, raw);
  if (r.me.userId !== m.userId) throw fail('forbidden');
  const { starRate } = ruleOf(await ruleRow(gc, m.userId));
  if (!starRate) throw fail('no_star_rate');
  const stars = intIn((r.body || {}).stars, 1, 100000);
  if (stars % starRate.stars !== 0) throw fail('invalid', { field: 'stars', multipleOf: starRate.stars });
  const s = await starsOf(gc, m.userId);
  if (stars > s.convertible) throw fail('not_enough_stars', { available: s.convertible });
  const cents = (stars / starRate.stars) * starRate.cents;
  const res = await store.run(gc, "INSERT INTO allowance_requests (child_id, stars, cents, status, created_at) VALUES (?, ?, ?, 'pending', ?)", [m.userId, stars, cents, r.now]);
  const id = res.lastInsertRowid;
  const lang = r.cfg.lang;
  r.pushes.push({
    topic: 'allowance', users: members.parents(r.fam).map((p) => p.userId), priority: 'normal', collapseKey: `allowance:req:${id}`, ttl: 7 * 86400,
    title: push.t(lang, 'allowance.convert', { name: m.name, stars, money: euro(cents, lang) }), body: push.t(lang, 'allowance.convert_body'),
    data: { familie: { type: 'allowance_convert', requestId: id, childId: m.userId, stars, cents } },
  });
  return { request: requestView(await store.one(gc, 'SELECT * FROM allowance_requests WHERE id = ?', [id])), stars: await starsOf(gc, m.userId) };
}

/** POST allowance/requests/<id>/approve | decline (parents) */
async function decide(gc, r, rawId, approve) {
  parentsOnly(r);
  const id = posInt(rawId);
  const q = id ? await store.one(gc, 'SELECT * FROM allowance_requests WHERE id = ?', [id]) : null;
  if (!q || !r.fam.byId.has(q.child_id)) throw fail('not_found');
  if (q.status !== 'pending') throw fail('not_pending', { status: q.status });
  let bookingId = null;
  if (approve) {
    const res = await store.run(gc, "INSERT INTO allowance_bookings (child_id, cents, kind, note, period, at, by_user) VALUES (?, ?, 'stars', ?, NULL, ?, ?)",
      [q.child_id, q.cents, `${q.stars} ★`, r.now, r.me.userId]);
    bookingId = res.lastInsertRowid;
    await store.run(gc, `INSERT INTO star_accounts (user_id, carried, converted) VALUES (?, 0, ?)
      ON CONFLICT(user_id) DO UPDATE SET converted = converted + excluded.converted`, [q.child_id, q.stars]);
  }
  const status = approve ? 'approved' : 'declined';
  await store.run(gc, 'UPDATE allowance_requests SET status = ?, decided_at = ?, decided_by = ?, booking_id = ? WHERE id = ?', [status, r.now, r.me.userId, bookingId, id]);
  const lang = r.cfg.lang;
  r.pushes.push({
    topic: 'allowance', users: [q.child_id].filter((u) => u !== r.me.userId), priority: 'normal', collapseKey: `allowance:req:${id}`, ttl: 7 * 86400,
    title: push.t(lang, approve ? 'allowance.approved' : 'allowance.declined', { stars: q.stars, money: euro(q.cents, lang), name: r.me.name }),
    data: { familie: { type: 'allowance_decided', requestId: id, childId: q.child_id, status, cents: approve ? q.cents : 0 } },
  });
  // the other parents' notification is replaced (same collapse key) — nothing more to do
  const row = await store.one(gc, 'SELECT * FROM allowance_requests WHERE id = ?', [id]);
  return { request: requestView(row), balanceCents: await balance(gc, q.child_id) };
}

/** Overview: a child its balance, parents the sum (null when nobody to show). */
async function overview(gc, r) {
  if (r.me.role === 'child') {
    const { rule } = ruleOf(await ruleRow(gc, r.me.userId));
    const s = await starsOf(gc, r.me.userId);
    return {
      balanceCents: await balance(gc, r.me.userId), nextPayout: await nextPayout(gc, r.me.userId, r, rule), amountCents: rule.active ? rule.amountCents : 0,
      convertibleStars: s.convertible, pendingRequests: (await store.one(gc, "SELECT COUNT(*) AS n FROM allowance_requests WHERE child_id = ? AND status = 'pending'", [r.me.userId])).n,
    };
  }
  if (r.me.role !== 'parent') return null;
  const kids = members.children(r.fam);
  const list = [];
  for (const k of kids) list.push({ childId: k.userId, balanceCents: await balance(gc, k.userId) });
  const ids = kids.map((k) => k.userId);
  const pending = ids.length ? (await store.one(gc, `SELECT COUNT(*) AS n FROM allowance_requests WHERE status = 'pending' AND child_id IN (${store.marks(ids.length)})`, ids)).n : 0;
  return { sumCents: list.reduce((a, x) => a + x.balanceCents, 0), children: list, pendingRequests: pending };
}

/** Background: book the due payouts (from 07:00 on the payout day), once per period. Collects pushes. */
async function payout(gc, fam, cfg, now, pushes) {
  const today = tz.localDate(now, cfg.tz);
  const rows = await store.all(gc, 'SELECT * FROM allowance_rules WHERE active = 1 AND amount_cents > 0');
  for (const row of rows) {
    const m = fam.byId.get(row.child_id);
    if (!m || m.role !== 'child') continue;
    const { rule, activeSince } = ruleOf(row);
    let d = payoutOnOrBefore(rule, today);
    if (now < tz.at(d, PAYOUT_AT, cfg.tz)) d = payoutOnOrBefore(rule, tz.addDays(d, -1));
    const due = tz.at(d, PAYOUT_AT, cfg.tz);
    if (activeSince != null && due < activeSince) continue;
    const res = await store.run(gc, "INSERT OR IGNORE INTO allowance_bookings (child_id, cents, kind, note, period, at, by_user) VALUES (?, ?, 'allowance', '', ?, ?, NULL)",
      [m.userId, rule.amountCents, periodKey(rule, d), now]);
    if (!res.changes) continue;
    pushes.push({
      topic: 'allowance', users: [m.userId], priority: 'normal', collapseKey: `allowance:paid:${m.userId}`, ttl: 2 * 86400,
      title: push.t(cfg.lang, 'allowance.paid', { money: euro(rule.amountCents, cfg.lang) }),
      data: { familie: { type: 'allowance_paid', childId: m.userId, bookingId: res.lastInsertRowid, cents: rule.amountCents } },
    });
  }
}

module.exports = {
  KINDS, PAYOUT_AT, euro, ruleOf, isPayoutDay, payoutOnOrBefore, payoutAfter, periodKey, starsOf, carryStars,
  get, book, unbook, putRule, convert, decide, overview, payout,
};
