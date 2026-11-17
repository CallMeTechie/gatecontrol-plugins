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
//
// 1.3 (stage 5): a phone (GateControl app for Android, "Bildschirm freigeben") registers the same way with
// { platform: 'android', name, appVersion, screen: { view, control }, shareMode? } — a device of the kind `host`, platform
// android, protocol `screen`, no VPN address needed (the phone reaches GateControl's relay itself). Codes, requests and
// "ohne Code" work as for a PC, but the phone always asks its person (and Android asks again); an allowed request gives
// the phone the sending side of a ticket of gc.remote.screen (server/support.js). POST host/screen/<id>/end: the phone
// ended a request before the picture ran (Android's question declined, stopped, failed).
//
// 1.4 (stage 6): screen.control of host/register and host/state says whether this app can carry input out (the GitHub
// build of the Android app with its accessibility service; the Google Play build only shows the screen). Only then may a
// helper ask for "Ansehen und steuern" — and the person at the phone decides for every request (server/support.js).
//
// 1.5 (stage 7): a PC has two switches in its app — "Remote Desktop erlauben" (rdp.offered; missing = on, apps before 1.5)
// and "Bildschirm teilen" (screen: { view, control }, GateControl's relay like a phone, also on Windows Home). One device
// per app installation: protocol `rdp` while Remote Desktop is offered (the screen besides it when shared), else `screen`.
// Windows Home with "Bildschirm teilen" is a device now (protocol screen); without it, home_edition as before.

// 1.6 (stage 4): a Linux computer registers through the agent gatecontrol-agent with
// { platform: 'linux', name, appVersion, os, ssh: { offered, user, port, tmux: { available, version }, hostKey: { alg, sha256 } },
//   desktop: { offered, kind, protocol, port, ready, session }, shareMode? } — a device of the kind `host`, platform linux, at its
// VPN address. Protocol `ssh` while SSH is shared (GateControl's terminal, tmux), else the desktop's rdp / vnc. The plugin makes
// one SSH key per device in GateControl's vault (gc.remote.vault.generate) and hands the public half to the agent, which puts it
// into the account's authorized_keys (valid only from the hub address); the host key the agent reports is pinned in GateControl
// (gc.remote.hostKeys.pin), so the first connection is checked too. Codes and requests as for a PC (kind ssh | desktop).

// 1.8 (gc.remote version 9): an administrator made the code on the admin page (server/enroll.js). With „Mit Agent verbinden“
// the ticket names a device made by hand: the agent's first host/register takes it over — same id, name, rights, history
// and tmux name; way and login change to the agent (adopt). Another host key than the one pinned for the old device: two
// devices for now, the administrator decides (enroll.decide).

const store = require('./store');
const devices = require('./devices');
const rights = require('./rights');
const log = require('./log');
const { fail, fromHost, clip, posInt, iso } = require('./util');

const EDITIONS = ['pro', 'enterprise', 'education', 'home'];
const RDP_PORT = 3389;
const DEVICE_RE = /^[1-9]\d{0,14}$/;
// 1.6: Linux
const LINUX_USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/;
const HOST_KEY_ALGS = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa'];
const SHA256_RE = /^[A-Za-z0-9+/]{43}$/;
const DESKTOP_KINDS = ['krdp', 'gnome-remote-desktop', 'wayvnc', 'xrdp', 'x11vnc'];
const OS_RE = /^[a-z0-9._-]{1,40}$/;

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
  // 1.6: a Linux device is ready with SSH or a listening desktop server
  if (devices.isLinux(d)) return devices.sshOffered(d) || (d.host.desktop && d.host.desktop.ready) ? 'ready' : 'desktop_off';
  // 1.5: a PC that only shares its screen (Windows Home, or Remote Desktop off in the app) is ready with it
  if (!devices.isPhone(d) && devices.screenOffered(d) && !devices.rdpOffered(d)) return 'ready';
  if (d.host.rdpAvailable === false) return 'home_edition';
  if (d.host.rdpEnabled === false) return 'rdp_off';
  return 'ready';
}

function hostAnswer(d) {
  return { deviceId: d.id, platform: d.host.platform, shareMode: d.host.shareMode, allowOpen: d.host.allowOpen, state: stateOf(d),
    // 1.5: what a PC offers now
    ...(d.host.platform === 'windows' ? { screen: { view: d.host.screenView, control: d.host.screenControl }, rdp: { offered: devices.rdpOffered(d) } } : {}) };
}

/** 1.6: the answer of host/register to the agent — the public half of GateControl's SSH key and where it is valid from. */
async function linuxAnswer(gc, d) {
  const a = hostAnswer(d);
  a.ssh = { offered: devices.sshOffered(d), user: d.host.sshUser, publicKey: null, from: null };
  if (a.ssh.offered && d.credential) {
    try { const v = await gc.remote.vault.info(d.credential); a.ssh.publicKey = (v && v.publicKey) || null; } catch { a.ssh.publicKey = null; }
    try { a.ssh.from = typeof gc.remote.hubAddress === 'function' ? await gc.remote.hubAddress() : null; } catch { a.ssh.from = null; }
  }
  a.desktop = d.host.desktop ? { offered: true, protocol: d.host.desktop.protocol, port: d.host.desktop.port } : { offered: false };
  return a;
}

/** 1.6: what a Linux agent reports → the columns (checked). */
function linuxOf(b) {
  const ssh = b.ssh && typeof b.ssh === 'object' ? b.ssh : {};
  const desk = b.desktop && typeof b.desktop === 'object' ? b.desktop : {};
  const offered = ssh.offered === true;
  if (offered && (typeof ssh.user !== 'string' || !LINUX_USER_RE.test(ssh.user) || ssh.user === 'root')) throw fail('invalid', { field: 'ssh.user' });
  if (ssh.port != null && Number(ssh.port) !== 22) throw fail('invalid', { field: 'ssh.port' });
  let hostKey = null;
  if (ssh.hostKey != null) {
    const k = ssh.hostKey;
    if (!k || typeof k !== 'object' || !HOST_KEY_ALGS.includes(k.alg) || typeof k.sha256 !== 'string' || !SHA256_RE.test(k.sha256)) throw fail('host_key_invalid');
    hostKey = { alg: k.alg, sha256: k.sha256 };
  }
  const tm = ssh.tmux && typeof ssh.tmux === 'object' && ssh.tmux.available === true ? (clip(ssh.tmux.version, 16) || '?') : null;
  let desktop = null;
  if (desk.offered === true) {
    if (!DESKTOP_KINDS.includes(desk.kind) || (desk.protocol !== 'rdp' && desk.protocol !== 'vnc')) throw fail('invalid', { field: 'desktop' });
    const port = Number(desk.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 22) throw fail('invalid', { field: 'desktop.port' });
    desktop = { kind: desk.kind, protocol: desk.protocol, port, ready: desk.ready === true };
  }
  const os = b.os && typeof b.os === 'object' && typeof b.os.id === 'string' && OS_RE.test(b.os.id) ? b.os.id : null;
  return { offered, user: offered ? ssh.user : null, hostKey, tmux: tm, desktop, os };
}

/** 1.6: pin the host key the agent reported in GateControl (the first time and when it changed). */
async function pinHostKey(gc, d, key, userId, now) {
  if (!key || !gc.remote.hostKeys) return;
  const before = d.host.hostKey;
  if (before && before.sha256 === key.sha256 && before.alg === key.alg) return;
  try {
    await gc.remote.hostKeys.pin({ targetId: 'dev-' + d.id, alg: key.alg, sha256: key.sha256 });
  } catch (e) { gc.log.warn('host key not pinned', (e && e.code) || 'error'); return; }
  await store.run(gc, 'UPDATE devices SET host_key_alg = ?, host_key_sha256 = ? WHERE id = ?', [key.alg, key.sha256, d.id]);
  if (before) await log.write(gc, 'remote_host_key_changed', { device: d, userId, details: { source: 'agent', alg: key.alg } }, now);
}

/** 1.6: GateControl's SSH key of a Linux device — made in the core's vault for a new device or a new account. */
async function sshKeyFor(gc, d, user, prevUser) {
  if (!gc.remote.vault || typeof gc.remote.vault.generate !== 'function') throw fail('key_unavailable');
  if (d.credential && prevUser === user) return d.credential;
  let k;
  try { k = await gc.remote.vault.generate({ kind: 'ed25519', label: d.name.slice(0, 60), username: user, ...(d.credential ? { handle: d.credential } : {}) }); } catch (e) { throw fromHost(e); }
  await store.run(gc, 'UPDATE devices SET credential = ?, credential_unreadable = 0 WHERE id = ?', [k.handle, d.id]);
  return k.handle;
}

/** host/register of a Linux device (1.6, the agent). */
async function registerLinux(gc, req, now = Date.now()) {
  const user = req.user;
  const dev = appDevice(req);
  const b = bodyOf(req);
  if (!dev.vpnIp) throw fail('no_vpn');
  const x = linuxOf(b);
  if (!x.offered && !x.desktop) throw fail('invalid', { field: 'ssh' });
  const name = clip(b.name, 100) || 'Linux';
  const shareMode = b.shareMode === 'open' ? 'open' : (b.shareMode === 'code' || b.shareMode == null ? null : undefined);
  if (shareMode === undefined) throw fail('invalid', { field: 'shareMode' });
  const protocol = x.offered ? 'ssh' : x.desktop.protocol;
  const port = x.offered ? 22 : x.desktop.port;
  let d = await byToken(gc, dev.id);
  if (d && d.host.platform !== 'linux') throw fail('invalid', { field: 'platform' });
  const first = !d || !d.host.registered;
  const cols = [x.offered ? 1 : 0, x.user, x.tmux, x.desktop ? x.desktop.kind : null, x.desktop ? x.desktop.protocol : null, x.desktop ? x.desktop.port : null,
    x.desktop && x.desktop.ready ? 1 : 0, x.os, clip(b.appVersion, 40) || null];
  await store.tx(gc, async () => {
    if (!d) {
      const id = await devices.nextId(gc);
      const config = { ...devices.DEFAULTS, host: dev.vpnIp, port, access_mode: 'internal', browser_enabled: true, health_check_enabled: false, credential_mode: 'full',
        ssh_engine: 'term', tmux_enabled: x.tmux != null };
      await store.run(gc, `INSERT INTO devices (id, name, protocol, enabled, source, config, kind, owner_user_id, token_device_id, platform, share_mode, allow_open, registered,
        last_seen, created_at, updated_at, ssh_offered, ssh_user, tmux_version, desktop_kind, desktop_protocol, desktop_port, desktop_ready, os_id, app_version)
        VALUES (?, ?, ?, 1, 'app', ?, 'host', ?, ?, 'linux', ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, protocol, JSON.stringify(config), user.id, dev.id, shareMode || 'code', now, now, now, ...cols]);
      await store.run(gc, "INSERT INTO device_access (device_id, kind, principal_id) VALUES (?, 'user', ?)", [id, user.id]);
      return;
    }
    if (d.host.owner !== user.id) {
      await store.run(gc, 'DELETE FROM device_access WHERE device_id = ?', [d.id]);
      await store.run(gc, "INSERT INTO device_access (device_id, kind, principal_id) VALUES (?, 'user', ?)", [d.id, user.id]);
      await store.run(gc, 'DELETE FROM codes WHERE device_id = ?', [d.id]);
    }
    const config = { ...d.config, host: dev.vpnIp, port, access_mode: 'internal', tmux_enabled: x.tmux != null };
    await store.run(gc, `UPDATE devices SET name = ?, protocol = ?, config = ?, owner_user_id = ?, share_mode = COALESCE(?, share_mode), registered = 1, last_seen = ?, updated_at = ?,
      ssh_offered = ?, ssh_user = ?, tmux_version = ?, desktop_kind = ?, desktop_protocol = ?, desktop_port = ?, desktop_ready = ?, os_id = ?, app_version = ? WHERE id = ?`,
    [d.host.owner === user.id ? d.name : name, protocol, JSON.stringify(config), user.id, shareMode, now, now, ...cols, d.id]);
  });
  const before = d;
  d = await byToken(gc, dev.id);
  // a share went off: what ran over it ends
  if (before && before.host.registered) {
    const support = require('./support');
    if (devices.sshOffered(before) && !x.offered) await support.endKind(gc, d, 'ssh', 'switched_off', now);
    if (before.host.desktop && !x.desktop) await support.endKind(gc, d, 'desktop', 'switched_off', now);
  }
  if (x.offered) {
    // the key of the device: a new one only for a new device or another account
    await sshKeyFor(gc, d, x.user, before ? before.host.sshUser : null);
    d = await byToken(gc, dev.id);
  }
  await pinHostKey(gc, d, x.hostKey, user.id, now);
  d = await byToken(gc, dev.id);
  if (d.host.shareMode === 'open' && !d.host.allowOpen) {
    await store.run(gc, "UPDATE devices SET share_mode = 'code' WHERE id = ?", [d.id]);
    d = await byToken(gc, dev.id);
  }
  // 1.8: the code of an administrator — „Mit Agent verbinden“ takes the device made by hand over
  if (!before) d = await afterEnroll(gc, d, dev, user, x, now);
  if (first) await log.write(gc, 'remote_host_registered', { device: d, userId: user.id, details: { platform: 'linux', ssh: x.offered, ...(x.desktop ? { desktop: x.desktop.kind } : {}) } }, now);
  await changed(gc, [d.id]);
  return { host: await linuxAnswer(gc, d), codeRequired: devices.connectMode(d) !== 'open' };
}

/** 1.8: the pinned host key of a device (GateControl's) → { alg, sha256 } | null */
async function pinnedOf(gc, d) {
  if (!gc.remote.hostKeys || typeof gc.remote.hostKeys.list !== 'function') return null;
  try {
    const p = ((await gc.remote.hostKeys.list()) || []).find((k) => k.targetId === 'dev-' + d.id);
    return p ? { alg: p.alg, sha256: p.sha256 } : null;
  } catch { return null; }
}

/** 1.8: a new Linux device of a ticket of the admin page → the device it is now (the old one when taken over). */
async function afterEnroll(gc, d, dev, user, x, now) {
  const enroll = require('./enroll');
  let en = null;
  try { en = await enroll.forToken(gc, dev.id, user.id, now); } catch (e) { gc.log.debug('enrollment lookup failed', (e && e.code) || 'error'); }
  if (!en) return d;
  const old = en.adopt_device_id ? await devices.get(gc, en.adopt_device_id) : null;
  if (!old || old.kind !== 'target') { await enroll.settle(gc, en.ticket, d.id, null, now); return d; }
  const pinned = await pinnedOf(gc, old);
  if (pinned && x.hostKey && (pinned.sha256 !== x.hostKey.sha256 || pinned.alg !== x.hostKey.alg)) {
    // another host key: not merged on its own (a reinstall, another computer with the same name, the wrong device)
    await enroll.settle(gc, en.ticket, d.id, { pinned, agent: { alg: x.hostKey.alg, sha256: x.hostKey.sha256 } }, now);
    return d;
  }
  await adopt(gc, old, d, user.id, now);
  await enroll.settle(gc, en.ticket, old.id, null, now);
  return devices.get(gc, old.id);
}

// the columns of a device of an app or the agent (migrations 002, 005–007)
const HOST_COLS = ['kind', 'owner_user_id', 'token_device_id', 'platform', 'edition', 'rdp_available', 'rdp_enabled', 'share_mode', 'allow_open', 'registered', 'last_seen',
  'os_user', 'app_version', 'screen_control', 'screen_view', 'rdp_offered', 'ssh_offered', 'ssh_user', 'tmux_version', 'host_key_alg', 'host_key_sha256',
  'desktop_kind', 'desktop_protocol', 'desktop_port', 'desktop_ready', 'os_id'];

/**
 * 1.8: the Linux device `fresh` of the agent takes the device `old` made by hand over: one device with the old id, name,
 * rights, history, tmux name and settings; the way (the agent's VPN address), the login (GateControl's key of the agent)
 * and the host key are the agent's. The old password goes from the vault, the old listener of a gateway goes; the old
 * settings stay in config.agent_previous.
 */
async function adopt(gc, old, fresh, userId, now = Date.now()) {
  const nr = await store.one(gc, 'SELECT * FROM devices WHERE id = ?', [fresh.id]);
  if (!nr) throw fail('not_found');
  const prev = { ...old.config };
  delete prev.agent_previous;
  const config = { ...old.config, host: fresh.config.host, port: fresh.config.port, access_mode: 'internal', external_hostname: null, external_port: null,
    gateway_peer_id: null, gateway_pool_id: null, gateway_listen_port: null, ssh_engine: 'term', tmux_enabled: !!fresh.config.tmux_enabled, health_check_enabled: false,
    agent_previous: { at: iso(now), by: userId || null, protocol: old.protocol, config: prev } };
  delete config.key;
  delete config.last_auth_failed;
  if (old.listener) { try { await gc.remote.listener.remove(old.listener); } catch (e) { gc.log.warn('listener not removed', (e && e.code) || 'error'); } }
  if (old.credential && old.credential !== fresh.credential) { try { await gc.remote.vault.remove(old.credential); } catch (e) { gc.log.debug('vault entry not removed', (e && e.code) || 'error'); } }
  const access = (await devices.accessLists(gc)).get(old.id) || devices.emptyAccess();
  await store.tx(gc, async () => {
    await store.run(gc, 'DELETE FROM device_access WHERE device_id = ?', [fresh.id]);
    await store.run(gc, 'DELETE FROM codes WHERE device_id = ?', [fresh.id]);
    await store.run(gc, 'DELETE FROM devices WHERE id = ?', [fresh.id]);
    await store.run(gc, `UPDATE devices SET ${HOST_COLS.map((k) => k + ' = ?').join(', ')}, protocol = ?, config = ?, credential = ?, credential_unreadable = 0, listener = NULL,
      listener_error = NULL, updated_at = ? WHERE id = ?`, [...HOST_COLS.map((k) => (nr[k] === undefined ? null : nr[k])), nr.protocol, JSON.stringify(config), nr.credential || null, now, old.id]);
    await store.run(gc, 'UPDATE sessions SET device_id = ? WHERE device_id = ?', [old.id, fresh.id]);
    // a device shared with some people: its new owner keeps seeing it
    if ((access.users.length || access.groups.length) && !access.users.includes(nr.owner_user_id)) {
      await store.run(gc, "INSERT OR IGNORE INTO device_access (device_id, kind, principal_id) VALUES (?, 'user', ?)", [old.id, nr.owner_user_id]);
    }
  });
  if (gc.remote.hostKeys) {
    const k = fresh.host && fresh.host.hostKey;
    if (k) { try { await gc.remote.hostKeys.pin({ targetId: 'dev-' + old.id, alg: k.alg, sha256: k.sha256 }); } catch (e) { gc.log.warn('host key not pinned', (e && e.code) || 'error'); } }
    try { await gc.remote.hostKeys.remove('dev-' + fresh.id); } catch { /* none */ }
  }
  const d = await devices.get(gc, old.id);
  await log.write(gc, 'remote_agent_adopted', { device: d, userId, details: { from: fresh.id, protocol: old.protocol } }, now);
  await changed(gc, [old.id, fresh.id]);
  return d;
}

function bodyOf(req) { return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}; }

/** host/register — create or update the PC (or, 1.3, the phone) of this app installation. */
async function register(gc, req, now = Date.now()) {
  const user = req.user;
  const dev = appDevice(req);
  const b = bodyOf(req);
  if (!(await rights.of(gc, user)).share) throw fail('no_share_right');
  if (b.platform === 'android') return registerPhone(gc, req, now);
  if (b.platform === 'linux') return registerLinux(gc, req, now);
  const edition = typeof b.edition === 'string' ? b.edition.toLowerCase() : '';
  if (!EDITIONS.includes(edition)) throw fail('invalid', { field: 'edition' });
  const rdp = b.rdp && typeof b.rdp === 'object' ? b.rdp : {};
  if (rdp.port != null && Number(rdp.port) !== RDP_PORT) throw fail('invalid', { field: 'rdp.port' });
  // 1.5: "Bildschirm teilen" (GateControl's relay) and whether "Remote Desktop erlauben" is on
  const scr = pcScreenOf(gc, b);
  let rdpOffered = rdp.offered !== false && rdp.available !== false;
  // Windows Home cannot offer Remote Desktop: without "Bildschirm teilen" no device, the app shows the hint
  if (edition === 'home') {
    if (!scr.view) throw fail(scr.asked ? 'screen_unavailable' : 'home_edition');
    rdpOffered = false;
  }
  if (!rdpOffered && !scr.view) throw fail(scr.asked ? 'screen_unavailable' : 'invalid', { field: 'screen' });
  // Remote Desktop needs the PC's VPN address; the screen goes out to GateControl's relay
  if (rdpOffered && !dev.vpnIp) throw fail('no_vpn');
  const protocol = rdpOffered ? 'rdp' : 'screen';
  const name = clip(b.name, 100) || 'Windows-PC';
  const shareMode = b.shareMode === 'open' ? 'open' : (b.shareMode === 'code' || b.shareMode == null ? null : undefined);
  if (shareMode === undefined) throw fail('invalid', { field: 'shareMode' });
  const fields = [rdp.available === false || edition === 'home' ? 0 : 1, rdp.enabled === true ? 1 : 0, clip(b.osUser, 100) || null, clip(b.appVersion, 40) || null];
  const screenCols = [scr.view ? 1 : 0, scr.control ? 1 : 0, rdpOffered ? 1 : 0];
  let d = await byToken(gc, dev.id);
  if (devices.isPhone(d)) throw fail('invalid', { field: 'platform' });
  const first = !d || !d.host.registered;
  await store.tx(gc, async () => {
    if (!d) {
      const id = await devices.nextId(gc);
      const config = { ...devices.DEFAULTS, host: dev.vpnIp || '', port: rdpOffered ? RDP_PORT : 0, access_mode: 'internal', browser_enabled: true, health_check_enabled: false, credential_mode: 'none' };
      await store.run(gc, `INSERT INTO devices (id, name, protocol, enabled, source, config, kind, owner_user_id, token_device_id, platform, edition,
        rdp_available, rdp_enabled, os_user, app_version, share_mode, allow_open, registered, last_seen, created_at, updated_at, screen_view, screen_control, rdp_offered)
        VALUES (?, ?, ?, 1, 'app', ?, 'host', ?, ?, 'windows', ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)`,
      [id, name, protocol, JSON.stringify(config), user.id, dev.id, edition, ...fields, shareMode || 'code', now, now, now, ...screenCols]);
      // a new PC: only its owner (and the administrators) see it until the owner shares it
      await store.run(gc, "INSERT INTO device_access (device_id, kind, principal_id) VALUES (?, 'user', ?)", [id, user.id]);
      return;
    }
    const config = { ...d.config, host: dev.vpnIp || d.config.host || '', port: rdpOffered ? RDP_PORT : (d.config.port || 0), access_mode: 'internal' };
    // the same app installation, another owner (a token is a person's): the PC starts over, private
    if (d.host.owner !== user.id) {
      await store.run(gc, 'DELETE FROM device_access WHERE device_id = ?', [d.id]);
      await store.run(gc, "INSERT INTO device_access (device_id, kind, principal_id) VALUES (?, 'user', ?)", [d.id, user.id]);
      await store.run(gc, 'DELETE FROM codes WHERE device_id = ?', [d.id]);
    }
    await store.run(gc, `UPDATE devices SET name = ?, protocol = ?, config = ?, owner_user_id = ?, edition = ?, rdp_available = ?, rdp_enabled = ?, os_user = ?, app_version = ?,
      share_mode = COALESCE(?, share_mode), registered = 1, last_seen = ?, updated_at = ?, screen_view = ?, screen_control = ?, rdp_offered = ? WHERE id = ?`,
    [d.host.owner === user.id ? d.name : name, protocol, JSON.stringify(config), user.id, edition, ...fields, shareMode, now, now, ...screenCols, d.id]);
  });
  // a switch went off: what ran over it ends (Remote Desktop: its rules; the screen: its relay)
  if (d && d.host.registered) {
    const support = require('./support');
    if (d.host.screenView && !scr.view) await support.endKind(gc, d, 'screen', 'switched_off', now);
    if (devices.rdpOffered(d) && !rdpOffered) await support.endKind(gc, d, 'rdp', 'switched_off', now);
  }
  d = await byToken(gc, dev.id);
  if (d.host.shareMode === 'open' && !d.host.allowOpen) {
    await store.run(gc, "UPDATE devices SET share_mode = 'code' WHERE id = ?", [d.id]);
    d = await byToken(gc, dev.id);
  }
  if (first) await log.write(gc, 'remote_host_registered', { device: d, userId: user.id, details: { edition, ...(scr.view ? { screen: true } : {}), ...(rdpOffered ? {} : { rdp: false }) } }, now);
  await changed(gc, [d.id]);
  return { host: hostAnswer(d), codeRequired: devices.connectMode(d) !== 'open' };
}

/**
 * 1.5: "Bildschirm teilen" of a PC → { view, control, asked } — only with GateControl's relay (gc.remote.screen); asked: the
 * app wanted it (without the relay the answer says so: screen_unavailable when nothing else is left).
 */
function pcScreenOf(gc, b) {
  const s = b && b.screen && typeof b.screen === 'object' ? b.screen : null;
  const asked = !!(s && s.view === true);
  const relay = !!(gc.remote && typeof gc.remote.screen === 'function');
  return { view: asked && relay, control: asked && relay && s.control === true, asked };
}

/**
 * host/register of a phone (1.3): "Bildschirm freigeben" is on. Needs GateControl's relay (gc.remote.screen,
 * version 4); nothing of the network of the phone is stored.
 */
async function registerPhone(gc, req, now = Date.now()) {
  const user = req.user;
  const dev = appDevice(req);
  const b = bodyOf(req);
  if (!gc.remote || typeof gc.remote.screen !== 'function') throw fail('screen_unavailable');
  const name = clip(b.name, 100) || 'Android';
  const shareMode = b.shareMode === 'open' ? 'open' : (b.shareMode === 'code' || b.shareMode == null ? null : undefined);
  if (shareMode === undefined) throw fail('invalid', { field: 'shareMode' });
  const appVersion = clip(b.appVersion, 40) || null;
  const control = screenControlOf(b);
  let d = await byToken(gc, dev.id);
  if (d && d.host.platform !== 'android') throw fail('invalid', { field: 'platform' });
  const first = !d || !d.host.registered;
  await store.tx(gc, async () => {
    if (!d) {
      const id = await devices.nextId(gc);
      const config = { ...devices.DEFAULTS, host: '', port: 0, access_mode: 'internal', browser_enabled: true, health_check_enabled: false, credential_mode: 'none' };
      await store.run(gc, `INSERT INTO devices (id, name, protocol, enabled, source, config, kind, owner_user_id, token_device_id, platform, edition,
        rdp_available, rdp_enabled, os_user, app_version, share_mode, allow_open, registered, last_seen, created_at, updated_at, screen_control)
        VALUES (?, ?, 'screen', 1, 'app', ?, 'host', ?, ?, 'android', NULL, NULL, NULL, NULL, ?, ?, 1, 1, ?, ?, ?, ?)`,
      [id, name, JSON.stringify(config), user.id, dev.id, appVersion, shareMode || 'code', now, now, now, control ? 1 : 0]);
      // a new phone: only its owner (and the administrators) see it until the owner shares it
      await store.run(gc, "INSERT INTO device_access (device_id, kind, principal_id) VALUES (?, 'user', ?)", [id, user.id]);
      return;
    }
    if (d.host.owner !== user.id) {
      await store.run(gc, 'DELETE FROM device_access WHERE device_id = ?', [d.id]);
      await store.run(gc, "INSERT INTO device_access (device_id, kind, principal_id) VALUES (?, 'user', ?)", [d.id, user.id]);
      await store.run(gc, 'DELETE FROM codes WHERE device_id = ?', [d.id]);
    }
    await store.run(gc, `UPDATE devices SET name = ?, owner_user_id = ?, app_version = ?, share_mode = COALESCE(?, share_mode), registered = 1, last_seen = ?,
      updated_at = ?, screen_control = ? WHERE id = ?`, [d.host.owner === user.id ? d.name : name, user.id, appVersion, shareMode, now, now, control ? 1 : 0, d.id]);
  });
  d = await byToken(gc, dev.id);
  if (d.host.shareMode === 'open' && !d.host.allowOpen) {
    await store.run(gc, "UPDATE devices SET share_mode = 'code' WHERE id = ?", [d.id]);
    d = await byToken(gc, dev.id);
  }
  if (first) await log.write(gc, 'remote_host_registered', { device: d, userId: user.id, details: { platform: 'android' } }, now);
  await changed(gc, [d.id]);
  return { host: hostAnswer(d), codeRequired: devices.connectMode(d) !== 'open' };
}

/** 1.4: { screen: { control: true } } — this app can carry input out (anything else: only watching). */
function screenControlOf(b) {
  return !!(b && b.screen && typeof b.screen === 'object' && b.screen.control === true);
}

/** host/state — the heartbeat → { shareMode, allowOpen, pending } */
async function heartbeat(gc, req, support, now = Date.now()) {
  const dev = appDevice(req);
  const d = await mine(gc, req.user, dev);
  if (!d.host.registered) throw fail('not_found');
  const b = bodyOf(req);
  if (devices.isLinux(d)) return heartbeatLinux(gc, req, d, dev, b, support, now);
  const rdpOn = b.rdp && typeof b.rdp === 'object' && typeof b.rdp.enabled === 'boolean' ? (b.rdp.enabled ? 1 : 0) : null;
  const osUser = b.osUser === undefined ? undefined : (clip(b.osUser, 100) || null);
  const wasOnline = d.host.online;
  // 1.4: a phone may say again whether its app can be controlled (an update from the Play build to the APK)
  const control = devices.isPhone(d) && b.screen && typeof b.screen === 'object' && typeof b.screen.control === 'boolean' ? (b.screen.control ? 1 : 0) : null;
  await store.run(gc, `UPDATE devices SET rdp_enabled = COALESCE(?, rdp_enabled), os_user = ${osUser === undefined ? 'os_user' : '?'}, last_seen = ?,
    config = ?, screen_control = COALESCE(?, screen_control) WHERE id = ?`, [rdpOn, ...(osUser === undefined ? [] : [osUser]), now,
    JSON.stringify(dev.vpnIp && !devices.isPhone(d) ? { ...d.config, host: dev.vpnIp } : d.config), control, d.id]);
  if (!wasOnline || (rdpOn != null && (rdpOn === 1) !== (d.host.rdpEnabled === true)) || (dev.vpnIp && !devices.isPhone(d) && dev.vpnIp !== d.config.host)
    || (control != null && (control === 1) !== d.host.screenControl)) await changed(gc, [d.id]);
  return { shareMode: d.host.shareMode, allowOpen: d.host.allowOpen, pending: await support.pendingFor(gc, d, now) };
}

/**
 * 1.6: the heartbeat of a Linux agent — tmux, the desktop server listening, the host key (pinned again when it changed),
 * the VPN address. Sharing more or less goes through host/register (the agent registers again).
 */
async function heartbeatLinux(gc, req, d, dev, b, support, now) {
  let x;
  try { x = linuxOf({ ...b, ssh: { ...(b.ssh || {}), offered: d.host.sshOffered, user: d.host.sshUser }, desktop: d.host.desktop ? { ...d.host.desktop, ...(b.desktop || {}), offered: true, kind: d.host.desktop.kind, protocol: d.host.desktop.protocol, port: d.host.desktop.port } : { offered: false } }); } catch (e) {
    if (e && e.code === 'host_key_invalid') throw e;
    x = null;
  }
  const tmux = x ? x.tmux : (d.host.tmuxVersion || null);
  const ready = x && x.desktop ? (x.desktop.ready ? 1 : 0) : (d.host.desktop && d.host.desktop.ready ? 1 : 0);
  const host = dev.vpnIp || d.config.host;
  await store.run(gc, 'UPDATE devices SET last_seen = ?, tmux_version = ?, desktop_ready = ?, config = ? WHERE id = ?',
    [now, tmux, ready, JSON.stringify({ ...d.config, host, tmux_enabled: tmux != null }), d.id]);
  if (x && x.hostKey) await pinHostKey(gc, d, x.hostKey, req.user.id, now);
  if (!d.host.online || (d.host.desktop && (ready === 1) !== d.host.desktop.ready) || host !== d.config.host || (tmux != null) !== d.host.tmux) await changed(gc, [d.id]);
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

module.exports = { adopt, pinnedOf, appDevice, byToken, mine, register, registerLinux, linuxOf, heartbeat, share, unregister, retire, access, setAllowOpen, changed, stateOf, EDITIONS, RDP_PORT };
