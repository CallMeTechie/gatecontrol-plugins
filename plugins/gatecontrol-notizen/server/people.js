'use strict';

// People: names for the lists, who one may share with (setting „Listen und Notizbücher teilen mit“), cached briefly.

const config = require('./config');

const TTL = 60000;
let users = { at: 0, list: [] };
const peerCache = new Map(); // userId → { at, set }

async function list(gc) {
  if (Date.now() - users.at < TTL) return users.list;
  let l = [];
  try { l = (await gc.users.list()) || []; } catch { l = []; }
  users = { at: Date.now(), list: l.map((u) => ({ id: u.id, name: u.name, role: u.role, avatarUrl: u.avatarUrl || null, colorHex: u.colorHex || null, initials: u.initials || null })) };
  return users.list;
}

async function get(gc, id) { return (await list(gc)).find((u) => u.id === id) || null; }
async function name(gc, id) { const u = await get(gc, id); return u ? u.name : null; }

/** The people `userId` shares a GateControl group with (family, team …). */
async function peers(gc, userId) {
  const have = peerCache.get(userId);
  if (have && Date.now() - have.at < TTL) return have.set;
  const set = new Set();
  try {
    const groups = gc.groups && typeof gc.groups.list === 'function' ? await gc.groups.list({ userId, includeInherited: true }) : [];
    for (const g of (groups || []).slice(0, 50)) {
      const ms = await gc.groups.members(g.id, { nested: true });
      for (const m of ms || []) if (m.enabled !== false && m.userId !== userId) set.add(m.userId);
    }
  } catch { /* no groups */ }
  peerCache.set(userId, { at: Date.now(), set });
  return set;
}

/** May `userId` share a list or notebook with `otherId`? */
async function mayShare(gc, userId, otherId) {
  const c = await config.get(gc);
  if (c.sharing === 'off' || userId === otherId) return false;
  if (!(await get(gc, otherId))) return false;
  if (c.sharing === 'all') return true;
  return (await peers(gc, userId)).has(otherId);
}

/** The people `userId` may pick (assign, share). */
async function pickable(gc, userId) {
  const c = await config.get(gc);
  const all = await list(gc);
  if (c.sharing === 'off') return all.filter((u) => u.id === userId);
  if (c.sharing === 'all') return all;
  const p = await peers(gc, userId);
  return all.filter((u) => u.id === userId || p.has(u.id));
}

function reset() { users = { at: 0, list: [] }; peerCache.clear(); }

module.exports = { list, get, name, peers, mayShare, pickable, reset };
