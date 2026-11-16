'use strict';

// Windows PCs that register themselves (stage 2, "Remote Desktop erlauben" in the GateControl app for Windows).
// The app calls the plugin's app API with its token: GateControl hands the owner as req.user and the app
// installation as req.user.device = { id, platform, vpnIp } (gc.remote version 2). A PC becomes a device of the
// kind `host`: owner = the person, reached at its VPN address on 3389, open to the owner and the administrators
// until the owner shares it (PUT host/access). Standard is "nur mit Code" — a helper redeems the code the PC
// shows and the person at the PC confirms (server/support.js); "Ohne Code für Berechtigte" (share mode `open`)
// lets people with the right and access connect directly, unless an administrator locked it for this PC.
//
//   POST   host/register   { name, edition, rdp: { available, enabled, port }, osUser, appVersion, shareMode? }
//   POST   host/state      { rdp: { enabled }, osUser, online }   the heartbeat (every 60 s and on every change)
//   PUT    host/share      { shareMode: 'code' | 'open' }
//   DELETE host            the switch is off: "abgemeldet", sessions end, the code is gone
//   POST   host/code       a new code (server/codes.js)
//   GET    host/access / PUT host/access { users, groups }   who may see the PC (people and groups only)
//   POST   host/requests/<id> { decision, mode? }   the answer to a helper's request (server/support.js)
//   GET    host/firewall / POST host/firewall        the firewall per session (server/support.js)

const store = require('./store');
const devices = require('./devices');
const rights = require('./rights');
const log = require('./log');
const { fail, clip, posInt } = require('./util');

const EDITIONS = ['pro', 'enterprise', 'education', 'home'];
const RDP_PORT = 3389;
const DEVICE_RE = /^[1-9]\d{0,14}$/;

/** The app installation of the request → { id, platform, vpnIp } (the app API only). */
function appDevice(req) {
  const u = req && req.user;
  const d = u && u.device;
  if (!u || u.app !== true || !d || typeof d.id !== 'string' || !DEVICE_RE.test(d.id)) throw fail('no_device');
  return { id: d.id, platform: d.platform || null, vpnIp: typeof d.vpnIp === 'string' && d.vpnIp ? d.vpnIp : null };
}

async function byToken(gc, tokenDeviceId) {
  return devices.fromRow(await store.one(gc, "SELECT * FROM devices WHERE kind = 'host' AND token_device_id = ?", [String(tokenDeviceId)]));
}

/** The PC of this app installation, registered by this person. */
async function mine(gc, user, dev) {
  const d = await byToken(gc, dev.id);
  if (!d || d.host.owner !== user.id) throw fail('not_found');
  return d;
}

/** "the device list changed" to the apps and portal tabs (only ids; who may see which device is checked when they load). */
async function changed(gc, ids) {
  if (!gc.events || typeof gc.events.emit !== 'function') return;
  try {
    const users = ((await gc.users.list()) || []).map((u) => u.id).slice(0, 500);
    if (users.length) await gc.events.emit({ users, type: 'devices', data: { changed: ids.slice(0, 50) } });
  } catch { /* nobody listens */ }
}

function stateOf(d) {
  if (!d.host.registered) return 'off';
  if (d.host.rdpAvailable === false) return 'home_edition';
  if (d.host.rdpEnabled === false) return 'rdp_off';
  return 'ready';
}

function hostAnswer(d) {
  return { deviceId: d.id, shareMode: d.host.shareMode, allowOpen: d.host.allowOpen, state: stateOf(d) };
}

function bodyOf(req) { return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}; }

/** host/register — create or update the PC of this app installation. */
async function register(gc, req, now = Date.now()) {
  const user = req.user;
  const dev = appDevice(req);
  const b = bodyOf(req);
  if (!(await rights.of(gc, user)).share) throw fail('no_share_right');
  const edition = typeof b.edition === 'string' ? b.edition.toLowerCase() : '';
  if (!EDITIONS.includes(edition)) throw fail('invalid', { field: 'edition' });
  // Windows Home cannot offer Remote Desktop: no device, the app shows "Bildschirm teilen"
  if (edition === 'home') throw fail('home_edition');
  const rdp = b.rdp && typeof b.rdp === 'object' ? b.rdp : {};
  if (rdp.port != null && Number(rdp.port) !== RDP_PORT) throw fail('invalid', { field: 'rdp.port' });
  if (!dev.vpnIp) throw fail('no_vpn');
  const name = clip(b.name, 100) || 'Windows-PC';
  const shareMode = b.shareMode === 'open' ? 'open' : (b.shareMode === 'code' || b.shareMode == null ? null : undefined);
  if (shareMode === undefined) throw fail('invalid', { field: 'shareMode' });
  const fields = [rdp.available === false ? 0 : 1, rdp.enabled === true ? 1 : 0, clip(b.osUser, 100) || null, clip(b.appVersion, 40) || null];
  let d = await byToken(gc, dev.id);
  const first = !d || !d.host.registered;
  await store.tx(gc, async () => {
    if (!d) {
      const id = await devices.nextId(gc);
      const config = { ...devices.DEFAULTS, host: dev.vpnIp, port: RDP_PORT, access_mode: 'internal', browser_enabled: true, health_check_enabled: false, credential_mode: 'none' };
      await store.run(gc, `INSERT INTO devices (id, name, protocol, enabled, source, config, kind, owner_user_id, token_device_id, platform, edition,
        rdp_available, rdp_enabled, os_user, app_version, share_mode, allow_open, registered, last_seen, created_at, updated_at)
        VALUES (?, ?, 'rdp', 1, 'app', ?, 'host', ?, ?, 'windows', ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
      [id, name, JSON.stringify(config), user.id, dev.id, edition, ...fields, shareMode || 'code', now, now, now]);
      // a new PC: only its owner (and the administrators) see it until the owner shares it
      await store.run(gc, "INSERT INTO device_access (device_id, kind, principal_id) VALUES (?, 'user', ?)", [id, user.id]);
      return;
    }
    const config = { ...d.config, host: dev.vpnIp, port: RDP_PORT, access_mode: 'internal' };
    // the same app installation, another owner (a token is a person's): the PC starts over, private
    if (d.host.owner !== user.id) {
      await store.run(gc, 'DELETE FROM device_access WHERE device_id = ?', [d.id]);
      await store.run(gc, "INSERT INTO device_access (device_id, kind, principal_id) VALUES (?, 'user', ?)", [d.id, user.id]);
      await store.run(gc, 'DELETE FROM codes WHERE device_id = ?', [d.id]);
    }
    await store.run(gc, `UPDATE devices SET name = ?, config = ?, owner_user_id = ?, edition = ?, rdp_available = ?, rdp_enabled = ?, os_user = ?, app_version = ?,
      share_mode = COALESCE(?, share_mode), registered = 1, last_seen = ?, updated_at = ? WHERE id = ?`,
    [d.host.owner === user.id ? d.name : name, JSON.stringify(config), user.id, edition, ...fields, shareMode, now, now, d.id]);
  });
  d = await byToken(gc, dev.id);
  if (d.host.shareMode === 'open' && !d.host.allowOpen) {
    await store.run(gc, "UPDATE devices SET share_mode = 'code' WHERE id = ?", [d.id]);
    d = await byToken(gc, dev.id);
  }
  if (first) await log.write(gc, 'remote_host_registered', { device: d, userId: user.id, details: { edition } }, now);
  await changed(gc, [d.id]);
  return { host: hostAnswer(d), codeRequired: devices.connectMode(d) !== 'open' };
}

/** host/state — the heartbeat → { shareMode, allowOpen, pending } */
async function heartbeat(gc, req, support, now = Date.now()) {
  const dev = appDevice(req);
  const d = await mine(gc, req.user, dev);
  if (!d.host.registered) throw fail('not_found');
  const b = bodyOf(req);
  const rdpOn = b.rdp && typeof b.rdp === 'object' && typeof b.rdp.enabled === 'boolean' ? (b.rdp.enabled ? 1 : 0) : null;
  const osUser = b.osUser === undefined ? undefined : (clip(b.osUser, 100) || null);
  const wasOnline = d.host.online;
  await store.run(gc, `UPDATE devices SET rdp_enabled = COALESCE(?, rdp_enabled), os_user = ${osUser === undefined ? 'os_user' : '?'}, last_seen = ?,
    config = ? WHERE id = ?`, [rdpOn, ...(osUser === undefined ? [] : [osUser]), now,
    JSON.stringify(dev.vpnIp ? { ...d.config, host: dev.vpnIp } : d.config), d.id]);
  if (!wasOnline || (rdpOn != null && (rdpOn === 1) !== (d.host.rdpEnabled === true)) || (dev.vpnIp && dev.vpnIp !== d.config.host)) await changed(gc, [d.id]);
  return { shareMode: d.host.shareMode, allowOpen: d.host.allowOpen, pending: await support.pendingFor(gc, d, now) };
}

/** host/share — "Ohne Code für Berechtigte" on or off. */
async function share(gc, req, now = Date.now()) {
  const dev = appDevice(req);
  const d = await mine(gc, req.user, dev);
  const mode = bodyOf(req).shareMode;
  if (mode !== 'code' && mode !== 'open') throw fail('invalid', { field: 'shareMode' });
  if (mode === 'open' && !d.host.allowOpen) throw fail('not_allowed');
  if (mode !== d.host.shareMode) {
    await store.run(gc, 'UPDATE devices SET share_mode = ?, updated_at = ? WHERE id = ?', [mode, now, d.id]);
    await log.write(gc, 'remote_share_changed', { device: d, userId: req.user.id, details: { shareMode: mode } }, now);
    await changed(gc, [d.id]);
  }
  return { shareMode: mode };
}

/** DELETE host — the switch is off: the PC stays in the list as "abgemeldet", its sessions end, its code goes. */
async function unregister(gc, req, support, now = Date.now()) {
  const dev = appDevice(req);
  const d = await mine(gc, req.user, dev);
  await retire(gc, d, support, 'switched_off', now);
  await log.write(gc, 'remote_host_removed', { device: d, userId: req.user.id }, now);
  await changed(gc, [d.id]);
  return { removed: true };
}

/** End everything of a PC (switched off, deleted by an administrator). */
async function retire(gc, d, support, reason, now = Date.now()) {
  await store.run(gc, "UPDATE devices SET registered = 0, share_mode = 'code', updated_at = ? WHERE id = ?", [now, d.id]);
  await store.run(gc, 'DELETE FROM codes WHERE device_id = ?', [d.id]);
  await support.endAll(gc, d, reason, now);
}

/** GET / PUT host/access — the owner decides who sees the PC (people and groups; never tokens). */
async function access(gc, req) {
  const dev = appDevice(req);
  const d = await mine(gc, req.user, dev);
  if (String(req.method || 'GET').toUpperCase() === 'PUT') {
    const b = bodyOf(req);
    if (!Array.isArray(b.users) || !Array.isArray(b.groups)) throw fail('invalid');
    const users = [];
    for (const id of [...new Set(b.users.map(posInt).filter(Boolean))].slice(0, 200)) {
      let u = null;
      try { u = await gc.users.get(id); } catch { u = null; }
      if (u) users.push(id);
    }
    if (!users.includes(req.user.id)) users.unshift(req.user.id);
    const groups = [...new Set(b.groups.map(posInt).filter(Boolean))].slice(0, 50);
    await store.tx(gc, async () => devices.setAccess(gc, d.id, { users, groups, tokens: [] }));
    await changed(gc, [d.id]);
  }
  const a = (await devices.accessLists(gc)).get(d.id) || devices.emptyAccess();
  return { access: { users: a.users, groups: a.groups } };
}

/** An administrator locks or allows "Ohne Code" for a PC (the admin page). */
async function setAllowOpen(gc, id, allow, now = Date.now()) {
  const d = await devices.need(gc, id);
  if (d.kind !== 'host') throw fail('invalid');
  if (typeof allow !== 'boolean') throw fail('invalid', { field: 'allowOpen' });
  await store.run(gc, `UPDATE devices SET allow_open = ?, share_mode = CASE WHEN ? = 0 THEN 'code' ELSE share_mode END, updated_at = ? WHERE id = ?`,
    [allow ? 1 : 0, allow ? 1 : 0, now, d.id]);
  if (!allow && d.host.shareMode === 'open') await log.write(gc, 'remote_share_changed', { device: d, details: { shareMode: 'code', by: 'admin' } }, now);
  await changed(gc, [d.id]);
}

module.exports = { appDevice, byToken, mine, register, heartbeat, share, unregister, retire, access, setAllowOpen, changed, stateOf, EDITIONS, RDP_PORT };
