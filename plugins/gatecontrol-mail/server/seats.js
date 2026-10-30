'use strict';

// Who counts against the licence (like Drive, concept "Lizenz mit Personen"): a person the administrator allows
// (config.allowed) uses Mail on a seat of their kind — 'family' or 'business'. The licence says how many of each kind:
//   tier family    family people only      (seats.family = included + booked)
//   tier business  business people only    (seats.business)
//   tier combo     both, the included people shared (seats.total; family ≤ seats.family, business ≤ seats.business)
//   no tier        the licence names no people (lifetime, plan, an older licence server) — no limit
// Unlike Drive nobody has to be switched on first: a person gets a seat the first time they use Mail, while there is
// room (the kind: the only one of the licence, else 'family' for a member of a family group, 'business' otherwise).
// The administrator can change the kind or switch a person off ('none' — never given again on its own). Seats of people
// who are no longer allowed or whose account is gone do not count. At the limit nobody more gets one (403 no_seat);
// people with a seat keep working when the licence gets smaller (the settings page says the licence is exceeded).

const store = require('./store');
const config = require('./config');
const people = require('./people');
const { fail } = require('./util');

const KINDS = ['family', 'business'];

/** What the licence allows: { kinds: [...], family, business, total } — null = no limit. */
function limits(lic) {
  if (!lic || !lic.valid) return { kinds: [], family: 0, business: 0, total: 0 };
  if (!lic.tier) return { kinds: KINDS.slice(), family: null, business: null, total: null };
  const kinds = lic.tier === 'family' ? ['family'] : (lic.tier === 'business' ? ['business'] : KINDS.slice());
  const s = lic.seats || { total: 0, family: 0, business: 0 };
  return { kinds, family: kinds.includes('family') ? s.family : 0, business: kinds.includes('business') ? s.business : 0, total: s.total };
}

async function get(gc, userId) {
  return store.one(gc, 'SELECT * FROM seats WHERE user_id = ?', [userId]);
}

/** The seats that count: kind family/business, the account enabled, the person still allowed. */
async function counting(gc, cfg, us) {
  const rows = await store.all(gc, "SELECT * FROM seats WHERE kind IN ('family', 'business') ORDER BY enabled_at, user_id");
  const out = [];
  for (const r of rows) if (us.has(r.user_id) && (await config.allowed(gc, cfg, r.user_id))) out.push(r);
  return out;
}

function counts(rows) {
  const c = { family: 0, business: 0, total: rows.length };
  for (const r of rows) c[r.kind]++;
  return c;
}

const fits = (c, l, kind) => (l.total == null || c.total + 1 <= l.total) && (l[kind] == null || c[kind] + 1 <= l[kind]);
const over = (c, l) => (l.total != null && c.total > l.total) || (l.family != null && c.family > l.family) || (l.business != null && c.business > l.business);

/** The kind a person gets on first use. */
async function defaultKind(gc, l, userId) {
  if (l.kinds.length === 1) return l.kinds[0];
  return (await people.inFamily(gc, userId)) ? 'family' : 'business';
}

/**
 * The seat of `userId` for a request (allowed already checked): { licence, seat } — seat null when the licence is not
 * valid, the person is switched off, or there is no room for them. Gives a seat on first use while there is room.
 */
async function access(gc, cfg, userId, now) {
  const lic = await people.licence(gc);
  if (!lic.valid) return { licence: lic, seat: null };
  const cur = await get(gc, userId);
  if (cur) return { licence: lic, seat: cur.kind === 'none' ? null : cur };
  const l = limits(lic);
  const kind = await defaultKind(gc, l, userId);
  return store.tx(gc, async () => {
    const again = await get(gc, userId);
    if (again) return { licence: lic, seat: again.kind === 'none' ? null : again };
    const c = counts(await counting(gc, cfg, await people.users(gc)));
    if (!fits(c, l, kind)) return { licence: lic, seat: null };
    await store.run(gc, 'INSERT INTO seats (user_id, kind, enabled_at, enabled_by) VALUES (?, ?, ?, NULL)', [userId, kind, now]);
    return { licence: lic, seat: await get(gc, userId) };
  });
}

/** Throws not_licensed / no_seat unless `userId` may use Mail now → the seat. */
async function need(gc, cfg, userId, now) {
  const a = await access(gc, cfg, userId, now);
  if (!a.licence.valid) throw fail('not_licensed');
  if (!a.seat) throw fail('no_seat');
  return a;
}

/**
 * For the settings page: { licence: { valid, state, tier, seats }, limits, counts, exceeded,
 *   people: [{ userId, name, allowed, seat: 'family'|'business'|'none'|null, auto }] } — every enabled account.
 */
async function summary(gc, cfg) {
  const [lic, us] = await Promise.all([people.licence(gc), people.users(gc)]);
  const rows = new Map((await store.all(gc, 'SELECT * FROM seats')).map((r) => [r.user_id, r]));
  const c = counts(await counting(gc, cfg, us));
  const l = limits(lic);
  const list = [];
  for (const u of us.values()) {
    const r = rows.get(u.id);
    list.push({ userId: u.id, name: u.name || null, allowed: await config.allowed(gc, cfg, u.id), seat: r ? r.kind : null, auto: !!(r && r.enabled_by == null) });
  }
  list.sort((x, y) => String(x.name || '').localeCompare(String(y.name || '')));
  return { licence: { valid: lic.valid, state: lic.state, tier: lic.tier, seats: lic.seats }, limits: l, counts: c, exceeded: over(c, l), people: list };
}

/**
 * The administrator gives `userId` a seat of `kind`, changes it, or switches the person off (kind null → 'none').
 * Codes: invalid (unknown account, kind), seat_kind (the licence has no such people), seat_limit (it is full).
 */
async function set(gc, cfg, userId, kind, by, now) {
  const us = await people.users(gc);
  if (!us.has(userId)) throw fail('invalid', { field: 'userId' });
  if (kind == null || kind === 'none') {
    await store.run(gc, `INSERT INTO seats (user_id, kind, enabled_at, enabled_by) VALUES (?, 'none', ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET kind = 'none', enabled_by = excluded.enabled_by`, [userId, now, by]);
    return null;
  }
  if (!KINDS.includes(kind)) throw fail('invalid', { field: 'kind' });
  const lic = await people.licence(gc);
  const l = limits(lic);
  if (!l.kinds.includes(kind)) throw fail('seat_kind', { tier: lic.tier });
  return store.tx(gc, async () => {
    const cur = await get(gc, userId);
    if (cur && cur.kind === kind) return cur;
    const c = counts((await counting(gc, cfg, us)).filter((r) => r.user_id !== userId));
    if (!fits(c, l, kind)) throw fail('seat_limit', { limits: l, counts: c });
    await store.run(gc, `INSERT INTO seats (user_id, kind, enabled_at, enabled_by) VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET kind = excluded.kind, enabled_by = excluded.enabled_by`, [userId, kind, now, by]);
    return get(gc, userId);
  });
}

/** For the background run: { all: true } without a valid licence, else { users: Set } of the people switched off. */
async function idle(gc) {
  const lic = await people.licence(gc);
  if (!lic.valid) return { all: true, users: new Set() };
  return { all: false, users: new Set((await store.all(gc, "SELECT user_id FROM seats WHERE kind = 'none'")).map((r) => r.user_id)) };
}

module.exports = { KINDS, limits, get, access, need, summary, set, idle };
