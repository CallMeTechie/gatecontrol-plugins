'use strict';

// Admin pages (admin/*): devices with every setting, the permissions matrix,
// the sessions, the settings. Only an administrator in GateControl's admin UI
// gets here (server/index.js).

const config = require('./config');
const devices = require('./devices');
const rights = require('./rights');
const history = require('./history');
const connect = require('./connect');
const legacy = require('./legacy');
const hosts = require('./hosts');
const support = require('./support');
const log = require('./log');
const recordings = require('./recordings');
const homes = require('./homes');
const way = require('./way');
const keys = require('./keys');
const enroll = require('./enroll');
const { fail, fromHost, posInt, clip } = require('./util');

const v3 = (gc) => !!(gc.remote && gc.remote.version >= 3);
// 1.7: the new „Gerät hinzufügen“ — GateControl with gc.remote version 7 (candidates, scan, listenPort 'auto')
const v7 = (gc) => !!(gc.remote && gc.remote.version >= 7 && typeof gc.remote.candidates === 'function');
const SCAN_PORTS = [22, 3389, 5900, 23];

/**
 * 1.7: what the wizard offers (gc.remote.candidates, only for this administrator in this request) and the devices of
 * the plugin it is compared with. Nothing of it is stored.
 */
async function candidateList(gc, user, cfg) {
  if (!v7(gc)) return { available: false };
  let c;
  try { c = await gc.remote.candidates({ user: user.id }); } catch (e) { throw fromHost(e); }
  const known = (await devices.all(gc)).map((d) => ({
    id: d.id, name: d.name, protocol: d.protocol, kind: d.kind, platform: d.host ? d.host.platform : null,
    host: d.config.host || null, accessMode: d.config.access_mode, gatewayPeerId: d.config.gateway_peer_id || null, gatewayPoolId: d.config.gateway_pool_id || null,
  }));
  // 1.7.2: `homes` — the gateways of one failover pool as one home network, its devices once (server/homes.js)
  return { available: true, vpn: c.vpn || null, peers: c.peers || [], gateways: c.gateways || [], homes: homes.of(c), routes: c.routes || [], known, checkMinutes: cfg ? cfg.checkMinutes : null };
}

/** 1.7: a few ports of one target at once (gc.remote.scan): directly from the server or through its gateway. */
async function scanTarget(gc, b) {
  if (!v7(gc)) throw fail('offline');
  const host = typeof b.host === 'string' ? b.host.trim() : '';
  if (!host || host.length > 253 || !/^[A-Za-z0-9.:_-]+$/.test(host)) throw fail('invalid', { field: 'host' });
  const gw = posInt(b.gatewayPeerId);
  const ports = Array.isArray(b.ports) && b.ports.length ? b.ports.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535).slice(0, 8) : SCAN_PORTS;
  if (!ports.length) throw fail('invalid', { field: 'port' });
  try { return await gc.remote.scan({ id: 'scan', host, ...(gw ? { gateway: { peerId: gw } } : {}) }, ports); } catch (e) { throw fromHost(e); }
}

/** 1.7: wake a device of the network watch (its MAC stays in GateControl). */
async function wakeCandidate(gc, user, b) {
  if (!v7(gc)) throw fail('offline');
  const ref = typeof b.ref === 'string' && /^nw-[1-9][0-9]{0,15}$/.test(b.ref) ? b.ref : null;
  const gw = posInt(b.gatewayPeerId);
  const host = typeof b.host === 'string' ? b.host.trim() : '';
  if (!ref || !gw || !host) throw fail('invalid');
  try { return await gc.remote.wake({ id: 'wake', host, port: 9, gateway: { peerId: gw }, watch: ref }, { user: user.id }); } catch (e) { throw fromHost(e); }
}

/** 1.7: the way to an address after the rule of server/way.js (free text of the wizard). */
async function wayTo(gc, user, b) {
  if (!v7(gc)) throw fail('offline');
  const host = typeof b.host === 'string' ? clip(b.host, 253) : '';
  if (!host || !/^[A-Za-z0-9.:_-]+$/.test(host)) throw fail('invalid', { field: 'host' });
  let c;
  try { c = await gc.remote.candidates({ user: user.id }); } catch (e) { throw fromHost(e); }
  const w = way.derive(host, c, b.gatewayPeerId);
  return { way: w, access: way.accessOf(w, host, posInt(b.port)) };
}

/** 1.7: how a stored device is reached, for the editor (null without version 7). */
async function wayOfDevice(gc, user, d) {
  if (!v7(gc) || !user || d.kind === 'host') return null;
  try { return way.ofDevice(d, await gc.remote.candidates({ user: user.id })); } catch (e) { gc.log.debug('candidates failed', (e && e.code) || 'error'); return null; }
}

/** 1.2: the pinned SSH host key of a device (GateControl's, gc.remote.hostKeys) → { alg, sha256, source, pinnedAt } | null */
async function hostKeyOf(gc, d) {
  if (!v3(gc) || d.protocol !== 'ssh') return null;
  try {
    const p = ((await gc.remote.hostKeys.list()) || []).find((x) => x.targetId === 'dev-' + d.id);
    return p ? { alg: p.alg, sha256: p.sha256, source: p.source, pinnedAt: p.pinnedAt } : null;
  } catch { return null; }
}

/** Switch SSH devices between GateControl's terminal and Guacamole: { engine, ids? } (no ids: every SSH device). */
async function switchEngine(gc, user, b) {
  if (!v3(gc)) throw fail('offline');
  const engine = b.engine;
  if (engine !== 'term' && engine !== 'guac') throw fail('invalid', { field: 'engine' });
  const ids = Array.isArray(b.ids) ? b.ids.map(posInt).filter(Boolean) : null;
  if (b.ids != null && (!ids || !ids.length)) throw fail('invalid', { field: 'ids' });
  let n = 0;
  for (const d of await devices.all(gc)) {
    if (d.protocol !== 'ssh' || d.config.ssh_engine === engine || (ids && !ids.includes(d.id))) continue;
    d.config.ssh_engine = engine;
    await devices.write(gc, d);
    await log.write(gc, 'remote_ssh_engine_changed', { device: d, userId: user.id, details: { engine } });
    n++;
  }
  return { switched: n };
}

/** Gateways and failover pools for the gateway target (gc.remote.gateways, GateControl after 1.281.0). */
async function gateways(gc) {
  if (!gc.remote || typeof gc.remote.gateways !== 'function') return { available: false, gateways: [], pools: [] };
  try {
    const r = (await gc.remote.gateways()) || {};
    return { available: true, gateways: Array.isArray(r.gateways) ? r.gateways : [], pools: Array.isArray(r.pools) ? r.pools : [] };
  } catch (e) {
    gc.log.debug('gateway list failed', (e && e.code) || 'error');
    return { available: false, gateways: [], pools: [] };
  }
}

/** 1.8: the VPN of GateControl for the way of a device (version 7: subnet and peer addresses), else null. */
async function vpnNet(gc, user) {
  if (!v7(gc) || !user) return null;
  try {
    const c = await gc.remote.candidates({ user: user.id });
    return { subnet: c && c.vpn ? c.vpn.subnet : null, peers: new Set(((c && c.peers) || []).map((p) => p.address).filter(Boolean)) };
  } catch { return null; }
}

async function deviceList(gc, user) {
  const [list, lists, vault, active] = [await devices.all(gc), await devices.accessLists(gc), await devices.vaultInfo(gc), await history.activeCounts(gc)];
  const now = Date.now();
  const names = new Map();
  try { for (const u of (await gc.users.list()) || []) names.set(u.id, u.name); } catch { /* names stay empty */ }
  const net = await vpnNet(gc, user);
  return list.map((d) => {
    const v = { ...devices.adminView(d, lists.get(d.id), vault, now, net), activeSessions: active.get(d.id) || 0 };
    if (v.host) v.host.ownerName = names.get(v.host.owner) || null;
    if (v.lastAuthFailed && v.lastAuthFailed.userId) v.lastAuthFailed.userName = names.get(v.lastAuthFailed.userId) || null;
    if (v.key && v.key.installedBy) v.key.installedByName = names.get(v.key.installedBy) || null;
    return v;
  });
}

/** 1.8: what GateControl offers the page (gc.remote version 9: key set-up, closing tmux sessions, codes for the agent). */
function features(gc) {
  return { keySetup: keys.v9(gc), tmuxKill: connect.tmuxV9(gc), enroll: enroll.v9(gc), remote: gc.remote ? gc.remote.version : null };
}

/** 1.8: „Duplizieren“ — the settings of a device under a new name, without credentials, rights or listener port. */
async function duplicate(gc, user, id) {
  const d = await devices.need(gc, id);
  if (d.kind !== 'target') throw fail('invalid', { field: 'kind' });
  const config = {};
  for (const k of Object.keys(devices.FIELDS)) if (d.config[k] !== undefined) config[k] = d.config[k];
  config.gateway_listen_port = null;
  return devices.save(gc, null, { name: (d.name + ' (2)').slice(0, 100), protocol: d.protocol, enabled: d.enabled, config, access: { users: [user.id], groups: [] } });
}

async function one(gc, id, user) {
  const d = await devices.need(gc, id);
  const lists = await devices.accessLists(gc);
  const v = devices.adminView(d, lists.get(d.id), await devices.vaultInfo(gc), Date.now(), await vpnNet(gc, user));
  // 1.7: the way for the editor of one page (1.8: `way` is the word of the list, the details are `wayDetail`)
  if (user) v.wayDetail = await wayOfDevice(gc, user, d);
  if (v.key && v.key.installedBy) { try { const u = await gc.users.get(v.key.installedBy); v.key.installedByName = u ? u.name : null; } catch { /* no name */ } }
  // 1.2: the SSH terminal — the engine in use, tmux, the pinned host key, the public half of a key made in GateControl
  if (d.protocol === 'ssh') {
    const vault = d.credential ? (await devices.vaultInfo(gc)).get(d.credential) : null;
    v.ssh = { engine: devices.engineOf(d, gc), tmux: devices.tmuxOf(d), hostKey: await hostKeyOf(gc, d), publicKey: vault && vault.publicKey ? vault.publicKey : null,
      termTestedAt: d.config.term_tested_at || null, available: v3(gc),
      // 1.8: the line for authorized_keys (the copy way) and whether an own key is stored
      line: vault && vault.publicKey ? await keys.lineFor(gc, d, vault.publicKey) : null, ownKey: !!(vault && vault.has && vault.has.privateKey && !vault.publicKey) };
  }
  return v;
}

async function licence(gc) {
  try {
    if (gc.license && typeof gc.license.info === 'function') return await gc.license.info();
    if (gc.license && typeof gc.license.status === 'function') return await gc.license.status();
  } catch { /* unknown */ }
  return null;
}

async function route(req, gc, seg, cfg) {
  const m = String(req.method || 'GET').toUpperCase();
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const user = req.user;
  const what = seg[1];
  // 1.7: the wizard „Gerät hinzufügen“ (gc.remote version 7)
  if (what === 'candidates') {
    if (m === 'GET' && seg.length === 2) return candidateList(gc, user, cfg);
    if (m === 'POST' && seg.length === 3 && seg[2] === 'scan') return { scan: await scanTarget(gc, b) };
    if (m === 'POST' && seg.length === 3 && seg[2] === 'wake') return { wake: await wakeCandidate(gc, user, b) };
  }
  if (what === 'way' && m === 'POST' && seg.length === 2) return wayTo(gc, user, b);
  // 1.8: who is asking (the owner „Ich“ of a code for the agent)
  if (what === 'whoami' && m === 'GET' && seg.length === 2) return { user: { id: user.id, name: user.name || null } };
  // 1.8: codes for the Linux agent (gc.remote version 9, server/enroll.js)
  if (what === 'enroll') {
    if (m === 'GET' && seg.length === 2) return { enrollments: await enroll.list(gc), available: enroll.v9(gc) };
    if (m === 'POST' && seg.length === 2) return { enrollment: await enroll.create(gc, user, b) };
    if (seg.length === 3 && m === 'GET') return { enrollment: await enroll.get(gc, seg[2]) };
    if (seg.length === 3 && m === 'PUT') return { enrollment: await enroll.update(gc, seg[2], b) };
    if (seg.length === 3 && m === 'DELETE') return enroll.remove(gc, seg[2]);
    if (seg.length === 4 && m === 'POST' && (seg[3] === 'merge' || seg[3] === 'keep')) return { enrollment: await enroll.decide(gc, user, seg[2], seg[3]) };
  }
  if (what === 'devices') {
    if (m === 'GET' && seg.length === 2) return { devices: await deviceList(gc, user), ...(await gateways(gc)), wizard: v7(gc), features: features(gc) };
    if (m === 'POST' && seg.length === 2) {
      // 1.7: the wizard makes a device that only administrators see at first (access: 'admins' → this administrator;
      // administrators reach every device anyway)
      const body = b.access === 'admins' ? { ...b, access: { users: [user.id], groups: [] } } : b;
      return { device: await one(gc, await devices.save(gc, null, body), user) };
    }
    // 1.2: switch SSH devices to the terminal (or back) — one, some or all
    if (m === 'POST' && seg.length === 3 && seg[2] === 'ssh-engine') return { ...(await switchEngine(gc, user, b)), devices: await deviceList(gc, user) };
    if (m === 'POST' && seg.length === 3 && seg[2] === 'check') {
      // a PC is not checked: 3389 is closed between sessions, its app reports its state
      for (const d of (await devices.all(gc)).filter((x) => x.enabled && x.kind !== 'host')) await connect.probe(gc, d);
      return { devices: await deviceList(gc, user) };
    }
    const id = posInt(seg[2]);
    if (!id) throw fail('not_found');
    if (seg.length === 3) {
      if (m === 'GET') return { device: await one(gc, id, user) };
      if (m === 'PUT') return { device: await one(gc, await devices.save(gc, id, b), user) };
      if (m === 'DELETE') {
        const d = await devices.need(gc, id);
        if (d.kind === 'host') await hosts.retire(gc, d, support, 'deleted');
        return devices.remove(gc, id);
      }
    }
    // 1.8: the tmux sessions with their windows, closing them (the same calls as the portal, as an administrator)
    if (seg.length === 4 && seg[3] === 'tmux' && m === 'GET') return connect.tmuxSessions(gc, user, id, { admin: true, windows: true });
    if (seg.length === 5 && seg[3] === 'tmux' && m === 'POST' && seg[4] === 'kill') return connect.tmuxKill(gc, user, id, b, { admin: true });
    if (seg.length === 5 && seg[3] === 'tmux' && m === 'POST' && seg[4] === 'kill-detached') return connect.tmuxKillDetached(gc, user, id, b, { admin: true });
    // 1.8: „Schlüssel automatisch einrichten“ (server/keys.js)
    if (seg.length === 4 && m === 'DELETE' && seg[3] === 'key') return { ...(await keys.remove(gc, user, id)), device: await one(gc, id, user) };
    if (seg.length === 4 && m === 'POST') {
      if (seg[3] === 'hostkey-scan') return { hostKey: await keys.scan(gc, id) };
      if (seg[3] === 'install-key') return { result: await keys.install(gc, user, id, b), device: await one(gc, id, user) };
      if (seg[3] === 'test-key') return { result: await keys.test(gc, user, id), device: await one(gc, id, user) };
      if (seg[3] === 'duplicate') return { device: await one(gc, await duplicate(gc, user, id), user) };
      if (seg[3] === 'check') {
        const d = await devices.need(gc, id);
        if (d.kind === 'host') return { status: { online: d.status.online, responseTime: null, lastCheck: d.host.lastSeen ? new Date(d.host.lastSeen).toISOString() : null } };
        return { status: await connect.probe(gc, d) };
      }
      if (seg[3] === 'allow-open') { await hosts.setAllowOpen(gc, id, b.allowOpen); return { device: await one(gc, id) }; }
      if (seg[3] === 'wake') return { wake: await connect.wake(gc, user, id, { admin: true }) };
      if (seg[3] === 'connect') {
        const d = await devices.need(gc, id);
        // a PC: the administrator, too, needs the code — or the owner's "ohne Code"
        if (d.kind === 'host') return require('./api').connectHost(gc, user, d, req, { admin: true });
        // engine 'term': try GateControl's terminal on an SSH device that still uses Guacamole (before switching it)
        return { session: await connect.open(gc, user, id, cfg, { admin: true, mode: b.mode === 'view' ? 'view' : 'control', tmux: b.tmux, record: b.record, engine: b.engine === 'term' ? 'term' : undefined }) };
      }
      // 1.2: a new SSH key made in GateControl (the private one stays in the vault) → the public key for authorized_keys
      if (seg[3] === 'key') {
        if (!v3(gc)) throw fail('offline');
        const d = await devices.need(gc, id);
        if (d.protocol !== 'ssh' || d.kind === 'host') throw fail('invalid', { field: 'protocol' });
        const username = typeof b.username === 'string' && b.username.trim() ? b.username.trim().slice(0, 256) : undefined;
        let k;
        // 1.8: the comment of the key is gatecontrol:dev-<id> (GateControl with version 9 finds its own line by it)
        const comment = keys.v9(gc) ? { comment: 'gatecontrol:dev-' + d.id } : {};
        try { k = await gc.remote.vault.generate({ kind: 'ed25519', label: d.name.slice(0, 60), ...comment, ...(username ? { username } : {}), ...(d.credential ? { handle: d.credential } : {}) }); } catch (e) { throw fromHost(e); }
        if (d.credential !== k.handle) { d.credential = k.handle; d.credentialUnreadable = false; await devices.write(gc, d); }
        return { publicKey: k.publicKey, line: await keys.lineFor(gc, d, k.publicKey), device: await one(gc, id, user) };
      }
      if (seg[3] === 'rotated') { await devices.rotated(gc, id); return { device: await one(gc, id) }; }
      if (seg[3] === 'toggle') {
        const d = await devices.need(gc, id);
        return { device: await one(gc, await devices.save(gc, id, { enabled: !d.enabled })) };
      }
    }
    // 1.2: the pinned host key — reset after a planned change (the next connection asks again)
    if (seg.length === 4 && seg[3] === 'hostkey' && m === 'DELETE') {
      if (!v3(gc)) throw fail('offline');
      const d = await devices.need(gc, id);
      let r;
      try { r = await gc.remote.hostKeys.remove('dev-' + d.id); } catch (e) { throw fromHost(e); }
      if (r && r.removed) await log.write(gc, 'remote_host_key_reset', { device: d, userId: user.id });
      return { removed: !!(r && r.removed), device: await one(gc, id) };
    }
    if (seg.length === 4 && seg[3] === 'access' && m === 'PUT') {
      await devices.need(gc, id);
      await devices.setAccess(gc, id, { users: Array.isArray(b.users) ? b.users : [], groups: Array.isArray(b.groups) ? b.groups : [], ...(Array.isArray(b.tokens) ? { tokens: b.tokens } : {}) });
      return { device: await one(gc, id, user) };
    }
  }
  if (what === 'rights') {
    if (m === 'GET' && seg.length === 2) {
      const [mx, list, lists] = [await rights.matrix(gc), await devices.all(gc), await devices.accessLists(gc)];
      return { ...mx, devices: list.map((d) => ({ id: d.id, name: d.name, protocol: d.protocol, enabled: d.enabled, access: lists.get(d.id) || devices.emptyAccess() })) };
    }
    if (m === 'PUT' && seg.length === 4 && (seg[2] === 'user' || seg[2] === 'group')) return { rights: await rights.set(gc, seg[2], seg[3], b) };
    // the effective view of one person (what this person may do and reach)
    if (m === 'GET' && seg.length === 4 && seg[2] === 'user') {
      const u = await gc.users.get(posInt(seg[3]));
      if (!u) throw fail('not_found');
      const r = await rights.of(gc, u);
      const lists = await devices.accessLists(gc);
      const reach = [];
      for (const d of await devices.all(gc)) if (await rights.mayUse(gc, u, d, lists.get(d.id) || devices.emptyAccess(), { rights: r })) reach.push({ id: d.id, name: d.name, protocol: d.protocol });
      return { user: { id: u.id, name: u.name, role: u.role }, rights: r, devices: reach };
    }
  }
  if (what === 'sessions') {
    if (m === 'GET' && seg.length === 2) {
      const q = req.query || {};
      return { sessions: await history.list(gc, { deviceId: q.device, userId: q.user, status: q.status, before: q.before, limit: q.limit }), recordings: await recordingStatus(gc) };
    }
    if (m === 'GET' && seg.length === 3 && seg[2] === 'csv') return { csv: await history.csv(gc) };
    // the protocol of the sharing (filter "Freigaben")
    if (m === 'GET' && seg.length === 3 && seg[2] === 'shares') return { entries: await log.list(gc, { deviceId: (req.query || {}).device, before: (req.query || {}).before, limit: (req.query || {}).limit }) };
    if (m === 'POST' && seg.length === 4 && seg[3] === 'end') {
      const id = posInt(seg[2]);
      const rows = await history.list(gc, { limit: 200, status: 'active' });
      const s = rows.find((x) => x.id === id);
      if (!s || !s.hostSessionId) throw fail('not_found');
      try { return await gc.remote.end({ sessionId: s.hostSessionId }); } catch (e) { throw fromHost(e); }
    }
  }
  // 1.2: recordings — list, watch, delete
  if (what === 'recordings') {
    if (m === 'GET' && seg.length === 2) return { recordings: await recordings.list(gc, user, { deviceId: (req.query || {}).device, limit: (req.query || {}).limit }, { admin: true }), available: await recordingStatus(gc) };
    if (m === 'POST' && seg.length === 4 && seg[3] === 'play') return recordings.play(gc, user, seg[2], { admin: true });
    if (m === 'DELETE' && seg.length === 3) return recordings.remove(gc, user, seg[2]);
  }
  if (what === 'settings') {
    if (m === 'GET' && seg.length === 2) {
      return { settings: cfg, ranges: config.RANGES, license: await licence(gc), import: await legacy.lastImport(gc), remote: gc.remote ? gc.remote.version : null, recordings: await recordingStatus(gc) };
    }
    if (m === 'PUT' && seg.length === 2) return { settings: await config.save(gc, b) };
  }
  throw fail('not_found');
}

async function recordingStatus(gc) {
  try { return gc.remote ? await gc.remote.recordings.available() : { available: false, reason: 'not_yet' }; } catch { return { available: false, reason: 'not_yet' }; }
}

module.exports = { route, gateways, deviceList, candidateList, v7, features };
