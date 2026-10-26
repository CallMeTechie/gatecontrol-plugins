'use strict';

// Who may use Drive: an administrator switches people on, each as a 'family' or a 'business' person
// (concept "Lizenz mit Personen"). The licence says how many of each kind:
//   tier family    family people only      (seats.family = included + booked)
//   tier business  business people only    (seats.business)
//   tier combo     both, the included people shared (seats.total; family ≤ seats.family, business ≤ seats.business)
//   no tier        the licence names no people (lifetime, plan, an older licence server) — no limit
// At the limit nobody more is switched on; people already on keep working when the licence gets smaller (the
// overview says the licence is exceeded).

const store = require('./store');
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

async function list(gc) {
  return store.all(gc, 'SELECT * FROM seats ORDER BY enabled_at, user_id');
}

function counts(rows) {
  const c = { family: 0, business: 0, total: rows.length };
  for (const r of rows) c[r.kind]++;
  return c;
}

const over = (c, l) => (l.total != null && c.total > l.total) || (l.family != null && c.family > l.family) || (l.business != null && c.business > l.business);

/** { seats: [{ userId, name, kind, enabledAt }], counts, limits, exceeded, licence: { valid, tier } } */
async function summary(gc) {
  const [rows, lic, us] = await Promise.all([list(gc), people.licence(gc), people.users(gc)]);
  const c = counts(rows);
  const l = limits(lic);
  return {
    seats: rows.map((r) => ({ userId: r.user_id, name: (us.get(r.user_id) || {}).name || null, kind: r.kind, enabledAt: r.enabled_at, active: us.has(r.user_id) })),
    counts: c, limits: l, exceeded: over(c, l), licence: { valid: lic.valid, state: lic.state, tier: lic.tier, seats: lic.seats },
  };
}

/**
 * Switch a person on as `kind` (or another kind), or off (kind null — their files stay). → the seat or null.
 * Codes: invalid (unknown account, kind), seat_kind (the licence has no such people), seat_limit (it is full).
 */
async function set(gc, userId, kind, by, now) {
  const us = await people.users(gc);
  if (!us.has(userId)) throw fail('invalid', { field: 'userId' });
  if (kind == null) {
    await store.run(gc, 'DELETE FROM seats WHERE user_id = ?', [userId]);
    return null;
  }
  if (!KINDS.includes(kind)) throw fail('invalid', { field: 'kind' });
  const lic = await people.licence(gc);
  const l = limits(lic);
  if (!l.kinds.includes(kind)) throw fail('seat_kind', { tier: lic.tier });
  return store.tx(gc, async () => {
    const rows = (await list(gc)).filter((r) => r.user_id !== userId);
    const cur = await get(gc, userId);
    if (cur && cur.kind === kind) return cur;
    const c = counts([...rows, { kind }]);
    if ((l.total != null && c.total > l.total) || (l[kind] != null && c[kind] > l[kind])) throw fail('seat_limit', { limits: l, counts: counts(rows) });
    await store.run(gc, `INSERT INTO seats (user_id, kind, enabled_at, enabled_by) VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET kind = excluded.kind`, [userId, kind, now, by]);
    return get(gc, userId);
  });
}

module.exports = { KINDS, limits, get, list, summary, set };
