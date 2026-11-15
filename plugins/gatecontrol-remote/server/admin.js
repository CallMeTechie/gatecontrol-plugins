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
const { fail, fromHost, posInt } = require('./util');

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

async function deviceList(gc) {
  const [list, lists, vault, active] = [await devices.all(gc), await devices.accessLists(gc), await devices.vaultInfo(gc), await history.activeCounts(gc)];
  const now = Date.now();
  const names = new Map();
  try { for (const u of (await gc.users.list()) || []) names.set(u.id, u.name); } catch { /* names stay empty */ }
  return list.map((d) => {
    const v = { ...devices.adminView(d, lists.get(d.id), vault, now), activeSessions: active.get(d.id) || 0 };
    if (v.host) v.host.ownerName = names.get(v.host.owner) || null;
    return v;
  });
}

async function one(gc, id) {
  const d = await devices.need(gc, id);
  const lists = await devices.accessLists(gc);
  return devices.adminView(d, lists.get(d.id), await devices.vaultInfo(gc));
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
  if (what === 'devices') {
    if (m === 'GET' && seg.length === 2) return { devices: await deviceList(gc), ...(await gateways(gc)) };
    if (m === 'POST' && seg.length === 2) return { device: await one(gc, await devices.save(gc, null, b)) };
    if (m === 'POST' && seg.length === 3 && seg[2] === 'check') {
      // a PC is not checked: 3389 is closed between sessions, its app reports its state
      for (const d of (await devices.all(gc)).filter((x) => x.enabled && x.kind !== 'host')) await connect.probe(gc, d);
      return { devices: await deviceList(gc) };
    }
    const id = posInt(seg[2]);
    if (!id) throw fail('not_found');
    if (seg.length === 3) {
      if (m === 'GET') return { device: await one(gc, id) };
      if (m === 'PUT') return { device: await one(gc, await devices.save(gc, id, b)) };
      if (m === 'DELETE') {
        const d = await devices.need(gc, id);
        if (d.kind === 'host') await hosts.retire(gc, d, support, 'deleted');
        return devices.remove(gc, id);
      }
    }
    if (seg.length === 4 && m === 'POST') {
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
        return { session: await connect.open(gc, user, id, cfg, { admin: true, mode: b.mode === 'view' ? 'view' : 'control' }) };
      }
      if (seg[3] === 'rotated') { await devices.rotated(gc, id); return { device: await one(gc, id) }; }
      if (seg[3] === 'toggle') {
        const d = await devices.need(gc, id);
        return { device: await one(gc, await devices.save(gc, id, { enabled: !d.enabled })) };
      }
    }
    if (seg.length === 4 && seg[3] === 'access' && m === 'PUT') {
      await devices.need(gc, id);
      await devices.setAccess(gc, id, { users: Array.isArray(b.users) ? b.users : [], groups: Array.isArray(b.groups) ? b.groups : [], ...(Array.isArray(b.tokens) ? { tokens: b.tokens } : {}) });
      return { device: await one(gc, id) };
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
      return { sessions: await history.list(gc, { deviceId: q.device, userId: q.user, status: q.status, before: q.before, limit: q.limit }), recordings: await recordings(gc) };
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
  if (what === 'settings') {
    if (m === 'GET' && seg.length === 2) {
      return { settings: cfg, ranges: config.RANGES, license: await licence(gc), import: await legacy.lastImport(gc), remote: gc.remote ? gc.remote.version : null, recordings: await recordings(gc) };
    }
    if (m === 'PUT' && seg.length === 2) return { settings: await config.save(gc, b) };
  }
  throw fail('not_found');
}

async function recordings(gc) {
  try { return gc.remote ? await gc.remote.recordings.available() : { available: false, reason: 'not_yet' }; } catch { return { available: false, reason: 'not_yet' }; }
}

module.exports = { route, gateways, deviceList };
