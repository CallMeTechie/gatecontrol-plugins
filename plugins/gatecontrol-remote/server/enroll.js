'use strict';

// 1.8: a set-up code for the Linux agent from the admin page (gc.remote version 9, gc.remote.enrollment). An administrator
// makes a code for a person (default: themselves) in „Gerät hinzufügen › Linux-Gerät mit Agent“ or — „Mit Agent verbinden“ —
// for a device made by hand that the agent then takes over (`adopt_device_id`). The page shows the code, the command for
// the device and the live state in four steps:
//
//   created     the plugin made the ticket (gc.remote.enrollment.create)
//   redeemed    the agent redeemed the code (enrollment.status → redeemed, peer and VPN address)
//   vpn         the first WireGuard handshake of the peer (handshakeAt)
//   registered  host/register of the agent's token reached the plugin (server/hosts.js registerLinux)
//
//   POST   admin/enroll            { ownerId, name, ssh: { user, tmux, install } | null, desktop, open, adoptDeviceId?, replaces? }
//                                  → { enrollment } (replaces: „Neuer Code“ — the old ticket is revoked)
//   GET    admin/enroll            { enrollments } — the codes not registered yet (placeholders of the list, 24 hours)
//   GET    admin/enroll/<ticket>   { enrollment } with the live state
//   PUT    admin/enroll/<ticket>   { name?, ssh?, desktop?, open? } — the options of the command (the code stays)
//   DELETE admin/enroll/<ticket>   the code is revoked, the placeholder goes
//   POST   admin/enroll/<ticket>/merge | keep   another host key than the pinned one: merge anyway or keep two devices
//
// Without version 9 the page shows the way through „Benutzer › Gerät hinzufügen“ (Weg A) instead.

const store = require('./store');
const devices = require('./devices');
const rights = require('./rights');
const log = require('./log');
const { fail, fromHost, clip, posInt, iso } = require('./util');

const TICKET_RE = /^[A-Za-z0-9_-]{8,80}$/;
const LINUX_USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/;
const KEEP_MS = 24 * 3600000;          // a placeholder that was not registered goes after 24 hours
const NO_HANDSHAKE_MS = 120000;        // redeemed, but no handshake after 2 minutes: the hint
const OPEN = ['waiting', 'redeemed'];

const v9 = (gc) => !!(gc.remote && gc.remote.version >= 9 && gc.remote.enrollment && typeof gc.remote.enrollment.create === 'function');

function parse(s, fb) { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : fb; } catch { return fb; } }

/** The options of the command, checked → { ssh: { user, tmux, install } | null, desktop, open } */
function optionsOf(b, before) {
  const x = b && typeof b === 'object' ? b : {};
  const o = before ? { ...before } : { ssh: null, desktop: false, open: false };
  if (x.ssh !== undefined) {
    if (x.ssh === null || x.ssh === false) o.ssh = null;
    else {
      if (typeof x.ssh !== 'object') throw fail('invalid', { field: 'ssh' });
      const user = typeof x.ssh.user === 'string' ? x.ssh.user.trim() : '';
      if (user === 'root') throw fail('invalid', { field: 'ssh.user', reason: 'root' });
      if (!LINUX_USER_RE.test(user)) throw fail('invalid', { field: 'ssh.user' });
      o.ssh = { user, tmux: x.ssh.tmux !== false, install: x.ssh.install === true && x.ssh.tmux !== false };
    }
  }
  if (x.desktop !== undefined) o.desktop = x.desktop === true;
  if (x.open !== undefined) o.open = x.open === true;
  if (!o.ssh && !o.desktop) throw fail('invalid', { field: 'ssh' });
  return o;
}

/** A word for the shell: plain when it is safe, else in single quotes. */
function shq(s) {
  const v = String(s == null ? '' : s);
  return /^[A-Za-z0-9._:/@%+=,-]+$/.test(v) ? v : "'" + v.replace(/'/g, "'\\''") + "'";
}

/** The command for the Linux device (one line per step; the agent 1.0 takes them as they are). */
function command(url, code, name, o) {
  const lines = ['sudo gatecontrol-agent enroll ' + shq(url || 'https://<server>') + ' ' + shq(code || '<code>') + ' --name ' + shq(name)];
  if (o.ssh) lines.push('sudo gatecontrol-agent share ssh --as ' + shq(o.ssh.user) + (o.ssh.tmux ? ' --tmux' : '') + (o.ssh.install ? ' --install-tmux' : ''));
  if (o.desktop) lines.push('sudo gatecontrol-agent share desktop');
  if (o.open) lines.push('sudo gatecontrol-agent share open');
  return lines.join('\n');
}

async function row(gc, ticket) {
  if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) throw fail('not_found');
  const r = await store.one(gc, 'SELECT * FROM enrollments WHERE ticket = ?', [ticket]);
  if (!r) throw fail('not_found');
  return r;
}

async function nameOf(gc, id) {
  try { const u = await gc.users.get(id); return u ? u.name : null; } catch { return null; }
}

/** The live state from GateControl and the plugin → the row as stored now. */
async function refresh(gc, r, now = Date.now()) {
  if (!OPEN.includes(r.state)) return r;
  const set = {};
  let st = null;
  try { st = await gc.remote.enrollment.status(r.ticket); } catch (e) { gc.log.debug('enrollment status failed', (e && e.code) || 'error'); }
  if (st && typeof st === 'object') {
    if (st.state === 'expired' || st.state === 'revoked') set.state = st.state;
    if (st.state === 'redeemed' && r.state === 'waiting') { set.state = 'redeemed'; set.redeemed_at = now; }
    if (st.tokenDeviceId != null && /^[1-9]\d{0,14}$/.test(String(st.tokenDeviceId))) set.token_device_id = String(st.tokenDeviceId);
    if (st.peerName) set.peer_name = clip(st.peerName, 100);
    if (st.vpnIp && /^[0-9a-fA-F.:]{3,45}$/.test(st.vpnIp)) set.vpn_ip = st.vpnIp;
    const hs = Date.parse(st.handshakeAt || '');
    if (Number.isFinite(hs)) set.handshake_at = hs;
  }
  if ((set.state || r.state) === 'waiting' && now > r.expires_at) set.state = 'expired';
  // the agent registered already (host/register before the page asked)
  const token = set.token_device_id || r.token_device_id;
  if (token && (set.state || r.state) === 'redeemed') {
    const d = await store.one(gc, "SELECT id, registered FROM devices WHERE kind = 'host' AND token_device_id = ?", [token]);
    if (d && d.registered) { set.state = 'registered'; set.device_id = r.device_id || d.id; }
  }
  if (set.state && set.state !== 'waiting') set.code = null;
  const keys = Object.keys(set).filter((k) => set[k] !== r[k]);
  if (!keys.length) return r;
  set.updated_at = now;
  const ks = Object.keys(set);
  await store.run(gc, `UPDATE enrollments SET ${ks.map((k) => k + ' = ?').join(', ')} WHERE ticket = ?`, [...ks.map((k) => set[k]), r.ticket]);
  return { ...r, ...set };
}

/** What a hint says when it hangs (4e of the draft). */
async function hintOf(gc, r, now) {
  if (r.state === 'redeemed' && !r.handshake_at && r.redeemed_at && now - r.redeemed_at > NO_HANDSHAKE_MS) return 'no_handshake';
  if (r.state === 'redeemed' && r.handshake_at) {
    let owner = null;
    try { owner = await gc.users.get(r.owner_user_id); } catch { owner = null; }
    if (owner && owner.role !== 'admin' && !(await rights.of(gc, owner)).share) return 'no_share_right';
    if (now - r.handshake_at > 30000) return 'no_share';
  }
  return null;
}

/** The device the agent registered as, for step 3 „Fertig“. */
async function deviceOf(gc, id) {
  const d = id ? await devices.get(gc, id) : null;
  if (!d) return null;
  const h = d.host || {};
  return { id: d.id, name: d.name, vpnIp: d.config.host || null, shareMode: devices.connectMode(d), ssh: h.sshOffered ? { user: h.sshUser, tmux: h.tmuxVersion || null } : null,
    hostKey: h.hostKey || null, desktop: h.desktop ? { protocol: h.desktop.protocol, kind: h.desktop.kind } : null, os: h.osId || null, appVersion: h.appVersion || null, registeredAt: iso(d.updatedAt) };
}

async function view(gc, r, now = Date.now()) {
  const o = parse(r.options, { ssh: null, desktop: false, open: false });
  const waiting = r.state === 'waiting' && now <= r.expires_at;
  return {
    ticket: r.ticket, state: r.state, name: r.name, ownerId: r.owner_user_id, ownerName: await nameOf(gc, r.owner_user_id), options: o,
    adoptDeviceId: r.adopt_device_id || null, createdAt: iso(r.created_at), createdBy: r.created_by, createdByName: await nameOf(gc, r.created_by),
    expiresAt: iso(r.expires_at), code: waiting ? r.code : null, url: r.url || null, command: waiting ? command(r.url, r.code, r.name, o) : null,
    steps: { created: iso(r.created_at), redeemed: r.redeemed_at ? iso(r.redeemed_at) : (r.token_device_id ? iso(r.updated_at) : null), vpn: r.handshake_at ? iso(r.handshake_at) : null,
      registered: r.state === 'registered' ? iso(r.updated_at) : null },
    peerName: r.peer_name || null, vpnIp: r.vpn_ip || null, deviceId: r.device_id || null,
    conflict: r.state === 'conflict' ? parse(r.conflict, null) : null, hint: await hintOf(gc, r, now),
    device: r.state === 'registered' || r.state === 'conflict' ? await deviceOf(gc, r.device_id) : null,
  };
}

/** POST admin/enroll */
async function create(gc, user, b, now = Date.now()) {
  if (!v9(gc)) throw fail('enroll_unavailable');
  const x = b && typeof b === 'object' ? b : {};
  const ownerId = x.ownerId == null ? user.id : posInt(x.ownerId);
  if (!ownerId) throw fail('invalid', { field: 'ownerId' });
  let owner = null;
  try { owner = await gc.users.get(ownerId); } catch { owner = null; }
  if (!owner) throw fail('invalid', { field: 'ownerId' });
  const name = clip(x.name, 100);
  if (!name) throw fail('invalid', { field: 'name' });
  const o = optionsOf(x);
  let adopt = null;
  if (x.adoptDeviceId != null) {
    adopt = await devices.need(gc, x.adoptDeviceId);
    if (adopt.kind !== 'target') throw fail('invalid', { field: 'adoptDeviceId' });
  }
  if (x.replaces != null) await remove(gc, String(x.replaces));
  let c;
  try { c = await gc.remote.enrollment.create({ actorId: user.id, userId: ownerId, name }); } catch (e) { throw fromHost(e); }
  if (!c || typeof c.ticket !== 'string' || !TICKET_RE.test(c.ticket) || typeof c.code !== 'string') throw fail('internal');
  const exp = Date.parse(c.expiresAt || '') || now + 600000;
  const url = typeof c.url === 'string' && /^https?:\/\/[^\s'"]{1,200}$/.test(c.url) ? c.url.replace(/\/+$/, '') : null;
  await store.run(gc, `INSERT INTO enrollments (ticket, owner_user_id, name, options, adopt_device_id, created_by, created_at, expires_at, code, url, state, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`, [c.ticket, ownerId, name, JSON.stringify(o), adopt ? adopt.id : null, user.id, now, exp, clip(c.code, 40), url, now]);
  await log.write(gc, 'remote_enroll_created', { device: adopt, userId: user.id, details: { owner: ownerId, name, adopt: !!adopt } }, now);
  return view(gc, await row(gc, c.ticket), now);
}

/** GET admin/enroll — the placeholders: codes of the last 24 hours that did not lead to a device yet. */
async function list(gc, now = Date.now()) {
  if (!v9(gc)) return [];
  const rows = await store.all(gc, "SELECT * FROM enrollments WHERE state NOT IN ('registered', 'revoked') AND created_at > ? ORDER BY created_at DESC LIMIT 50", [now - KEEP_MS]);
  const out = [];
  for (const r of rows) {
    const x = await refresh(gc, r, now);
    if (x.state !== 'registered' && x.state !== 'revoked') out.push(await view(gc, x, now));
  }
  return out;
}

async function get(gc, ticket, now = Date.now()) {
  return view(gc, await refresh(gc, await row(gc, ticket), now), now);
}

/** PUT admin/enroll/<ticket> — the options of the command; the code stays. */
async function update(gc, ticket, b, now = Date.now()) {
  const r = await row(gc, ticket);
  const x = b && typeof b === 'object' ? b : {};
  const o = optionsOf(x, parse(r.options, { ssh: null, desktop: false, open: false }));
  const name = x.name !== undefined ? clip(x.name, 100) : r.name;
  if (!name) throw fail('invalid', { field: 'name' });
  await store.run(gc, 'UPDATE enrollments SET options = ?, name = ?, updated_at = ? WHERE ticket = ?', [JSON.stringify(o), name, now, r.ticket]);
  return get(gc, r.ticket, now);
}

/** DELETE admin/enroll/<ticket> — revoked at GateControl while it can still be redeemed. */
async function remove(gc, ticket) {
  const r = await row(gc, ticket);
  if (OPEN.includes(r.state) && v9(gc)) {
    try { await gc.remote.enrollment.revoke(r.ticket); } catch (e) { gc.log.debug('enrollment revoke failed', (e && e.code) || 'error'); }
  }
  await store.run(gc, 'DELETE FROM enrollments WHERE ticket = ?', [r.ticket]);
  return { removed: true };
}

/**
 * host/register of a Linux agent: the ticket of its token (the token of the code). Tickets whose token is not known yet
 * are asked at GateControl (the agent registers right after redeeming, before the page asked).
 */
async function forToken(gc, tokenDeviceId, userId, now = Date.now()) {
  if (!v9(gc)) return null;
  let r = await store.one(gc, 'SELECT * FROM enrollments WHERE token_device_id = ? ORDER BY created_at DESC LIMIT 1', [String(tokenDeviceId)]);
  if (!r) {
    const open = await store.all(gc, "SELECT * FROM enrollments WHERE state IN ('waiting', 'redeemed') AND token_device_id IS NULL AND owner_user_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 10", [userId, now - KEEP_MS]);
    for (const x of open) {
      const y = await refresh(gc, x, now);
      if (y.token_device_id === String(tokenDeviceId)) { r = y; break; }
    }
  }
  if (!r || r.owner_user_id !== userId) return null;
  return r;
}

/** The agent registered as device `deviceId` (registered, or conflict with the host keys). */
async function settle(gc, ticket, deviceId, conflict, now = Date.now()) {
  await store.run(gc, 'UPDATE enrollments SET state = ?, device_id = ?, conflict = ?, code = NULL, updated_at = ? WHERE ticket = ?',
    [conflict ? 'conflict' : 'registered', deviceId, conflict ? JSON.stringify(conflict) : null, now, ticket]);
}

/** POST admin/enroll/<ticket>/merge | keep — the administrator decides after another host key. */
async function decide(gc, user, ticket, what, now = Date.now()) {
  const r = await row(gc, ticket);
  if (r.state !== 'conflict' || !r.device_id || !r.adopt_device_id) throw fail('invalid', { field: 'state' });
  if (what === 'keep') {
    await store.run(gc, "UPDATE enrollments SET state = 'registered', updated_at = ? WHERE ticket = ?", [now, r.ticket]);
    return get(gc, r.ticket, now);
  }
  const hosts = require('./hosts');
  const fresh = await devices.get(gc, r.device_id);
  const old = await devices.get(gc, r.adopt_device_id);
  if (!fresh || !old || old.kind !== 'target') throw fail('not_found');
  await hosts.adopt(gc, old, fresh, user.id, now);
  await store.run(gc, "UPDATE enrollments SET state = 'registered', device_id = ?, conflict = NULL, updated_at = ? WHERE ticket = ?", [old.id, now, r.ticket]);
  return get(gc, r.ticket, now);
}

/** Background: placeholders older than 24 hours go, revoked ones at once; codes of expired tickets are cleared. */
async function sweep(gc, now = Date.now()) {
  await store.run(gc, "DELETE FROM enrollments WHERE created_at < ? OR state = 'revoked'", [now - KEEP_MS]);
  await store.run(gc, "UPDATE enrollments SET state = 'expired', code = NULL, updated_at = ? WHERE state = 'waiting' AND expires_at < ?", [now, now]);
}

module.exports = { v9, optionsOf, command, shq, create, list, get, update, remove, forToken, settle, decide, sweep, refresh };
