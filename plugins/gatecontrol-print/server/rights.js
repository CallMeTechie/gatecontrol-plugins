'use strict';

// Who may print and scan (admin page "Berechtigungen"). Administrators may
// always everything. Everybody else follows a row in `rights` once an
// administrator changed it, otherwise the defaults: children of the family
// (GateControl's family group, role "child" — gc.groups, feature-detected)
// print in black and white, at most 20 pages a day, and scan; everyone else
// prints and scans without a limit.

const store = require('./store');
const { fail, bool } = require('./util');

const CHILD_DEFAULT = Object.freeze({ print: true, scan: true, pagesPerDay: 20, bwOnly: true });
const ADULT_DEFAULT = Object.freeze({ print: true, scan: true, pagesPerDay: 0, bwOnly: false });
const ALL = Object.freeze({ print: true, scan: true, pagesPerDay: 0, bwOnly: false });
const CACHE_MS = 60000;
let kids = { at: 0, set: new Set() };

/** The children of the family groups (role child) — empty without gc.groups. */
async function children(gc, now = Date.now()) {
  if (now - kids.at < CACHE_MS) return kids.set;
  const set = new Set();
  try {
    if (gc.groups && typeof gc.groups.list === 'function') {
      for (const g of (await gc.groups.list({ kind: 'family' })) || []) {
        for (const m of (await gc.groups.members(g.id)) || []) if (m && m.role === 'child' && Number.isSafeInteger(m.userId)) set.add(m.userId);
      }
    }
  } catch (e) { gc.log.debug('family groups unavailable', (e && e.code) || 'error'); }
  kids = { at: now, set };
  return set;
}

function reset() { kids = { at: 0, set: new Set() }; }

const fromRow = (r) => ({ print: bool(r.can_print), scan: bool(r.can_scan), pagesPerDay: r.pages_per_day || 0, bwOnly: bool(r.bw_only) });

/** Effective rights of a person → { print, scan, pagesPerDay, bwOnly, source: 'admin'|'custom'|'child'|'default' } */
async function of(gc, user) {
  if (!user || !Number.isSafeInteger(user.id)) return { print: false, scan: false, pagesPerDay: 0, bwOnly: false, source: 'none' };
  if (user.role === 'admin') return { ...ALL, source: 'admin' };
  const r = await store.one(gc, 'SELECT * FROM rights WHERE user_id = ?', [user.id]);
  if (r) return { ...fromRow(r), source: 'custom' };
  const isChild = (await children(gc)).has(user.id);
  return { ...(isChild ? CHILD_DEFAULT : ADULT_DEFAULT), source: isChild ? 'child' : 'default' };
}

/** Everybody with their rights (admin page) */
async function list(gc) {
  const users = (await gc.users.list()) || [];
  const rows = new Map((await store.all(gc, 'SELECT * FROM rights')).map((r) => [r.user_id, r]));
  const kidsSet = await children(gc);
  return users.map((u) => {
    const r = rows.get(u.id);
    const eff = u.role === 'admin' ? { ...ALL, source: 'admin' } : (r ? { ...fromRow(r), source: 'custom' } : { ...(kidsSet.has(u.id) ? CHILD_DEFAULT : ADULT_DEFAULT), source: kidsSet.has(u.id) ? 'child' : 'default' });
    return { id: u.id, name: u.name, role: u.role, child: kidsSet.has(u.id), color: u.colorHex || null, initials: u.initials || null, ...eff };
  });
}

/** Set a person's rights ({ print, scan, pagesPerDay, bwOnly }); `reset: true` back to the defaults. */
async function set(gc, userId, b, now = Date.now()) {
  const u = await gc.users.get(userId);
  if (!u) throw fail('not_found');
  if (u.role === 'admin') throw fail('invalid', { field: 'admin' });
  if (b && b.reset === true) { await store.run(gc, 'DELETE FROM rights WHERE user_id = ?', [u.id]); return of(gc, u); }
  const cur = await of(gc, u);
  const next = { ...cur };
  for (const k of ['print', 'scan', 'bwOnly']) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== 'boolean') throw fail('invalid', { field: k });
    next[k] = b[k];
  }
  if (b.pagesPerDay !== undefined) {
    if (!Number.isInteger(b.pagesPerDay) || b.pagesPerDay < 0 || b.pagesPerDay > 1000) throw fail('invalid', { field: 'pagesPerDay' });
    next.pagesPerDay = b.pagesPerDay;
  }
  await store.run(gc, `INSERT INTO rights (user_id, can_print, can_scan, pages_per_day, bw_only, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET can_print = excluded.can_print, can_scan = excluded.can_scan, pages_per_day = excluded.pages_per_day, bw_only = excluded.bw_only, updated_at = excluded.updated_at`,
  [u.id, next.print ? 1 : 0, next.scan ? 1 : 0, next.pagesPerDay, next.bwOnly ? 1 : 0, now]);
  return of(gc, u);
}

module.exports = { of, list, set, children, reset, CHILD_DEFAULT, ADULT_DEFAULT };
