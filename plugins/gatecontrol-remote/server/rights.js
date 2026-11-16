'use strict';

// Who may do what (admin page "Berechtigungen", profile section "Fernzugriff").
//
// Four rights, each for a person or a group:
//   rdp      "Remote Desktops nutzen"   RDP and VNC to the devices the person may reach
//   ssh      "SSH nutzen"               SSH and Telnet
//   support  "Support-Codes einlösen"   prepared for the code sharing of later versions
//   share    "Eigene Geräte freigeben"  prepared for the sharing switches of the apps
// A person's own row decides; without one the person has a right when one of
// their groups (GateControl groups, subgroups count) has it; else the default
// (rdp, ssh, support off — share on). Administrators always have every right
// and reach every device.
//
// 1.2: the recording of a person or group (column recording: off | optional | always,
// NULL = not set here): the own row decides, else the strictest of the groups. Together
// with the device's setting the stricter one holds (policyFor) — "always" only with the
// hint before the start (GateControl's session page, the apps).
//
// Which devices: a device without an access list is open to everybody with
// the right (the rule of the former Remote Desktops); with people or groups
// listed only to them; with only API tokens listed (old apps) only to those
// tokens. The right is checked again on every connect.

const store = require('./store');
const { fail, posInt } = require('./util');

const KEYS = ['rdp', 'ssh', 'support', 'share'];
const REC = ['off', 'optional', 'always'];
const recRank = (v) => REC.indexOf(v);
/** The stricter of two recording settings (null = none). */
function stricter(a, b) {
  if (recRank(a) < 0) return recRank(b) < 0 ? null : b;
  if (recRank(b) < 0) return a;
  return recRank(a) >= recRank(b) ? a : b;
}
const DEFAULTS = Object.freeze({ rdp: false, ssh: false, support: false, share: true });
const ALL = Object.freeze({ rdp: true, ssh: true, support: true, share: true });
const CACHE_MS = 30000;
let groupCache = new Map();

function reset() { groupCache = new Map(); }

/** The groups of a person (with the ones above their subgroups) — [] without gc.groups. */
async function groupsOf(gc, userId, now = Date.now()) {
  const c = groupCache.get(userId);
  if (c && now - c.at < CACHE_MS) return c.ids;
  let ids = [];
  try {
    if (gc.groups && typeof gc.groups.list === 'function') ids = ((await gc.groups.list({ userId, includeInherited: true })) || []).map((g) => g.id).filter(Number.isSafeInteger);
  } catch (e) { gc.log.debug('groups unavailable', (e && e.code) || 'error'); }
  groupCache.set(userId, { at: now, ids });
  if (groupCache.size > 2000) groupCache.delete(groupCache.keys().next().value);
  return ids;
}

const rowValue = (v) => (v == null ? null : v === 1 || v === true);

/** Effective rights → { rdp, ssh, support, share, source: { key: 'admin'|'person'|'group'|'default' } } */
async function of(gc, user) {
  if (!user || !Number.isSafeInteger(user.id)) return { rdp: false, ssh: false, support: false, share: false, recording: null, source: {} };
  if (user.role === 'admin') return { ...ALL, recording: null, source: { ...Object.fromEntries(KEYS.map((k) => [k, 'admin'])), recording: 'admin' } };
  const own = await store.one(gc, "SELECT * FROM rights WHERE kind = 'user' AND principal_id = ?", [user.id]);
  const groups = await groupsOf(gc, user.id);
  const rows = groups.length
    ? await store.all(gc, `SELECT * FROM rights WHERE kind = 'group' AND principal_id IN (${store.marks(groups.length)})`, groups)
    : [];
  const out = { source: {} };
  for (const k of KEYS) {
    const mine = own ? rowValue(own[k]) : null;
    if (mine != null) { out[k] = mine; out.source[k] = 'person'; continue; }
    if (rows.some((r) => rowValue(r[k]) === true)) { out[k] = true; out.source[k] = 'group'; continue; }
    out[k] = DEFAULTS[k];
    out.source[k] = 'default';
  }
  const ownRec = own && recRank(own.recording) >= 0 ? own.recording : null;
  if (ownRec) { out.recording = ownRec; out.source.recording = 'person'; } else {
    let g = null;
    for (const r of rows) g = stricter(g, recRank(r.recording) >= 0 ? r.recording : null);
    out.recording = g;
    out.source.recording = g ? 'group' : 'default';
  }
  return out;
}

/** The recording of a session of this person on this device: the stricter of the device's and the person's → off | optional | always */
async function policyFor(gc, user, device, o = {}) {
  const r = o.rights || await of(gc, user);
  return stricter(device && device.config ? device.config.recording : null, r.recording) || 'off';
}

/** The right a protocol needs. */
const rightFor = (protocol) => (protocol === 'ssh' || protocol === 'telnet' ? 'ssh' : 'rdp');

/**
 * May this person (or this API token of an old app) reach the device by its access list?
 * `access` = { users, groups, tokens }; `o.tokenId` for the old app API.
 */
async function canReach(gc, user, access, o = {}) {
  if (user && user.role === 'admin') return true;
  const a = access || { users: [], groups: [], tokens: [] };
  if (a.users.length || a.groups.length) {
    if (!user || !Number.isSafeInteger(user.id)) return false;
    if (a.users.includes(user.id)) return true;
    if (!a.groups.length) return false;
    const mine = await groupsOf(gc, user.id);
    return a.groups.some((g) => mine.includes(g));
  }
  if (a.tokens.length) return o.tokenId != null && a.tokens.includes(Number(o.tokenId));
  return true;
}

/**
 * May the person connect to the device now (the right of its protocol, the access list)?
 * A token without a person (old apps): only devices that list that very token.
 */
async function mayUse(gc, user, device, access, o = {}) {
  if (!device || !device.enabled) return false;
  const a = access || { users: [], groups: [], tokens: [] };
  if (!user || !Number.isSafeInteger(user.id)) return o.tokenId != null && !a.users.length && !a.groups.length && a.tokens.includes(Number(o.tokenId));
  const r = o.rights || await of(gc, user);
  if (!r[rightFor(device.protocol)]) return false;
  return canReach(gc, user, a, o);
}

/** Every person and group with their rows (the matrix of the admin page). */
async function matrix(gc) {
  const users = (await gc.users.list()) || [];
  let groups = [];
  try { if (gc.groups && typeof gc.groups.list === 'function') groups = (await gc.groups.list()) || []; } catch { groups = []; }
  const rows = await store.all(gc, 'SELECT * FROM rights');
  const pick = (kind, id) => {
    const r = rows.find((x) => x.kind === kind && x.principal_id === id);
    return { ...Object.fromEntries(KEYS.map((k) => [k, r ? rowValue(r[k]) : null])), recording: r && recRank(r.recording) >= 0 ? r.recording : null };
  };
  const people = [];
  for (const u of users) {
    const eff = await of(gc, u);
    people.push({ id: u.id, name: u.name, role: u.role, color: u.colorHex || null, initials: u.initials || null, avatarUrl: u.avatarUrl || null,
      set: pick('user', u.id), effective: { ...Object.fromEntries(KEYS.map((k) => [k, eff[k]])), recording: eff.recording }, source: eff.source, groups: await groupsOf(gc, u.id) });
  }
  return {
    people,
    groups: groups.filter((g) => !g.archived).map((g) => ({ id: g.id, name: g.name, path: g.path || g.name, kind: g.kind || null, set: pick('group', g.id) })),
    defaults: DEFAULTS,
  };
}

/** Set rights of a person or group: { rdp: true|false|null, … } (null = not set here). */
async function set(gc, kind, id, b, now = Date.now()) {
  if (kind !== 'user' && kind !== 'group') throw fail('invalid', { field: 'kind' });
  const pid = posInt(id);
  if (!pid) throw fail('invalid');
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw fail('invalid');
  if (kind === 'user') {
    const u = await gc.users.get(pid);
    if (!u) throw fail('not_found');
    if (u.role === 'admin') throw fail('invalid', { field: 'admin' });
  } else if (gc.groups && typeof gc.groups.get === 'function') {
    const g = await gc.groups.get(pid);
    if (!g) throw fail('not_found');
  }
  const cur = await store.one(gc, 'SELECT * FROM rights WHERE kind = ? AND principal_id = ?', [kind, pid]);
  const next = Object.fromEntries(KEYS.map((k) => [k, cur ? cur[k] : null]));
  next.recording = cur && recRank(cur.recording) >= 0 ? cur.recording : null;
  for (const [k, v] of Object.entries(b)) {
    if (k === 'recording') {
      if (v !== null && !REC.includes(v)) throw fail('invalid', { field: k });
      next.recording = v;
      continue;
    }
    if (!KEYS.includes(k)) throw fail('invalid', { field: k });
    if (v !== null && typeof v !== 'boolean') throw fail('invalid', { field: k });
    next[k] = v == null ? null : (v ? 1 : 0);
  }
  if (KEYS.every((k) => next[k] == null) && next.recording == null) await store.run(gc, 'DELETE FROM rights WHERE kind = ? AND principal_id = ?', [kind, pid]);
  else {
    await store.run(gc, `INSERT INTO rights (kind, principal_id, rdp, ssh, support, share, recording, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, principal_id) DO UPDATE SET rdp = excluded.rdp, ssh = excluded.ssh, support = excluded.support, share = excluded.share, recording = excluded.recording, updated_at = excluded.updated_at`,
    [kind, pid, next.rdp, next.ssh, next.support, next.share, next.recording, now]);
  }
  reset();
  return { ...Object.fromEntries(KEYS.map((k) => [k, rowValue(next[k])])), recording: next.recording };
}

/** The take-over: grant a right to a person unless an administrator already decided it (never takes one away). */
async function grant(gc, userId, key, now = Date.now()) {
  if (!KEYS.includes(key)) return;
  await store.run(gc, `INSERT INTO rights (kind, principal_id, ${key}, updated_at) VALUES ('user', ?, 1, ?)
    ON CONFLICT(kind, principal_id) DO UPDATE SET ${key} = COALESCE(rights.${key}, 1), updated_at = excluded.updated_at`, [userId, now]);
}

module.exports = { KEYS, REC, DEFAULTS, of, rightFor, canReach, mayUse, matrix, set, grant, groupsOf, reset, policyFor, stricter };
