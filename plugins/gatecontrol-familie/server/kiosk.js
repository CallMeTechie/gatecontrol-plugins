'use strict';

// Kiosk login for the wall tablet (1.1.1, GateControl ≥ 1.165.0,
// permissions.kiosk).
//
// Exactly the members with the role 'wall' are this plugin's kiosk users
// (gc.kiosk.allow / gc.kiosk.list): an administrator then pairs the tablet
// in GateControl (user › "Kiosk-Gerät koppeln", a code or QR code, 90 days,
// extended by every use, portal only). When the role changes away from
// 'wall' or the member is removed, the plugin withdraws it and every paired
// device of that account stops working at its next request. On start the
// list is reconciled with the members table.
//
// The host refuses administrators and disabled accounts (ERR_INVALID); such
// a wall member stays a member — it simply cannot be paired. A failed call
// never fails the admin change: it is logged, the next start repairs it.

const store = require('./store');
const members = require('./members');

const available = (gc) => !!(gc.kiosk && typeof gc.kiosk.allow === 'function' && typeof gc.kiosk.list === 'function');

/** gc.kiosk.allow(userId, allowed); true when the host accepted it. */
async function allow(gc, userId, allowed) {
  if (!available(gc)) return false;
  try {
    await gc.kiosk.allow(userId, allowed === true);
    return true;
  } catch (e) {
    gc.log.warn('kiosk allow failed', userId, allowed === true, (e && e.code) || (e && e.message) || 'error');
    return false;
  }
}

/** After an admin change of a member's role: from / to 'wall' (null = no member). */
async function roleChanged(gc, userId, from, to) {
  if (from === to) return;
  if (to === 'wall') await allow(gc, userId, true);
  else if (from === 'wall') await allow(gc, userId, false);
}

/**
 * Start: allow exactly the current wall members (enabled, non-admin accounts),
 * withdraw everyone else this plugin had allowed. → { allowed: [id], removed: [id] }
 */
async function reconcile(gc, today) {
  if (!available(gc)) return { allowed: [], removed: [] };
  const fam = await members.load(gc, today);
  const want = new Set([...fam.walls.values()].filter((m) => m.gcRole !== 'admin').map((m) => m.userId));
  let listed;
  try {
    listed = new Set(((await gc.kiosk.list()) || []).filter((id) => Number.isSafeInteger(id)));
  } catch (e) {
    gc.log.warn('kiosk list failed', (e && e.code) || (e && e.message) || 'error');
    return { allowed: [], removed: [] };
  }
  const out = { allowed: [], removed: [] };
  for (const id of want) if (!listed.has(id) && (await allow(gc, id, true))) out.allowed.push(id);
  for (const id of listed) if (!want.has(id) && (await allow(gc, id, false))) out.removed.push(id);
  return out;
}

/** The role of a member row right now (null = no member). */
async function roleOf(gc, userId) {
  const row = await store.one(gc, 'SELECT role FROM members WHERE user_id = ?', [userId]);
  return row ? row.role : null;
}

module.exports = { allow, roleChanged, reconcile, roleOf };
