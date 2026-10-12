'use strict';

// Background polling of the Proxmox VE connections.
//
// Per connection and run (every poll_interval seconds, default 60):
//   GET /cluster/resources                                      (required: a failure = the connection failed)
//   GET /version, /cluster/status                               (optional: version; cluster name, quorum, node
//                                                                addresses — /cluster/status needs Sys.Audit on /)
//   GET /nodes/{node}/status, /nodes/{node}/tasks?typefilter=vzdump&limit=20   per online node, in parallel
//                                                               (a failing node keeps its error, the rest goes on)
//   GET /cluster/ha/status/current                              (optional; 403 = no HA view)
//   GET /nodes/{node}/apt/update                                (only with show_updates, every 6 hours)
// The result replaces the stored snapshot (last good status). A failure keeps
// the last good snapshot, counts the error and backs off: the interval doubles
// per error up to 5 minutes (or the interval, when that is longer).

const store = require('./store');
const snapshot = require('./snapshot');
const { createClient, codeError } = require('./pve');

const UPDATES_EVERY_MS = 6 * 3600000;
const MAX_BACKOFF_MS = 300000;
const locks = new Map(); // host id → promise (one poll per connection at a time)

/** Delay before the next poll after `errors` failures in a row. */
function backoffMs(pollSec, errors) {
  const base = pollSec * 1000;
  if (!errors) return base;
  return Math.max(base, Math.min(base * 2 ** (errors - 1), MAX_BACKOFF_MS));
}

async function clientFor(gc, host, opts = {}) {
  if (host.target_index == null) throw codeError('PVE_NO_TARGET');
  const secret = opts.secret != null ? opts.secret : await store.secretOf(gc, host.id);
  if (!secret) throw codeError('PVE_NO_SECRET');
  return createClient(gc, { index: host.target_index, tokenId: opts.tokenId || host.token_id, secret, timeoutMs: opts.timeoutMs || 10000 });
}

const settle = (p) => p.then((data) => ({ data }), (e) => ({ error: (e && e.code) || 'PVE_UNREACHABLE' }));

/** Everything of one connection → snapshot (throws when the connection failed). */
async function fetchSnapshot(gc, client, cfg, prev, now) {
  // /cluster/resources is required (it lists what the token may see); /cluster/status needs
  // Sys.Audit on / and only adds the cluster name, quorum and node addresses
  const [version, statusR, resources] = await Promise.all([settle(client.version()), settle(client.clusterStatus()), client.resources()]);
  const clusterStatus = statusR.data || [];
  const nodeNames = resources.filter((r) => r && r.type === 'node').map((r) => ({ name: r.node, online: r.status === 'online' }));
  for (const st of clusterStatus) {
    if (st && st.type === 'node' && !nodeNames.some((n) => n.name === st.name)) nodeNames.push({ name: st.name, online: Number(st.online) === 1 });
  }
  const online = nodeNames.filter((n) => n.online && typeof n.name === 'string');
  const nodeStatus = {};
  const tasks = {};
  await Promise.all(online.map(async (n) => {
    const [st, tk] = await Promise.all([settle(client.nodeStatus(n.name)), settle(client.nodeTasks(n.name, { typefilter: 'vzdump', limit: 20 }))]);
    nodeStatus[n.name] = st;
    tasks[n.name] = tk;
  }));
  const ha = await settle(client.haStatus());

  let updates = null;
  let updatesAt = prev && Number.isFinite(prev.updatesAt) ? prev.updatesAt : 0;
  if (cfg.showUpdates) {
    updates = {};
    if (now - updatesAt >= UPDATES_EVERY_MS) {
      updatesAt = now;
      await Promise.all(online.map(async (n) => {
        const r = await settle(client.aptUpdates(n.name));
        updates[n.name] = r.error ? { count: null, error: r.error } : { count: r.data.length, error: null };
      }));
    } else {
      for (const n of (prev && prev.nodes) || []) if (n.updates != null || n.updatesError) updates[n.name] = { count: n.updates, error: n.updatesError };
    }
  }

  const snap = snapshot.normalize({
    version: version.data || (prev && prev.version) || null,
    clusterStatus, resources, nodeStatus, tasks,
    ha: ha.error === 'PVE_FORBIDDEN' || ha.error === 'PVE_NOT_FOUND' ? null : ha,
    updates,
  }, now);
  if (cfg.showUpdates) snap.updatesAt = updatesAt;
  return snap;
}

/**
 * Poll one connection now and store the outcome.
 * → { host, ok, snapshot, error }   (snapshot: the new one, or the last good one on error)
 */
function pollHost(gc, host, cfg, { now = Date.now(), timeoutMs = 10000 } = {}) {
  const run = async () => {
    const prev = await store.snapshotOf(gc, host.id);
    try {
      const client = await clientFor(gc, host, { timeoutMs });
      const snap = await fetchSnapshot(gc, client, cfg, prev, now);
      await store.saveSnapshot(gc, host.id, snap);
      const h = await store.updateHost(gc, host.id, {
        status: 'ok', last_error: null, error_count: 0, last_attempt_at: now, last_success_at: now, next_poll_at: now + backoffMs(cfg.pollSec, 0),
        pve_version: snap.version ? snap.version.version : host.pve_version, cluster_name: snap.cluster ? snap.cluster.name : null,
      });
      return { host: h || host, ok: true, snapshot: snap, error: null };
    } catch (e) {
      const code = (e && e.code) || 'PVE_UNREACHABLE';
      const errors = (host.error_count || 0) + 1;
      const h = await store.updateHost(gc, host.id, { status: 'error', last_error: code, error_count: errors, last_attempt_at: now, next_poll_at: now + backoffMs(cfg.pollSec, errors) });
      if (errors === 1 || errors % 10 === 0) gc.log.warn('proxmox poll failed', `host ${host.id}`, code, `(${errors}x)`);
      return { host: h || host, ok: false, snapshot: prev, error: code };
    }
  };
  const key = host.id;
  const p = (locks.get(key) || Promise.resolve()).then(run, run);
  locks.set(key, p.catch(() => {}));
  return p;
}

/** The connections that are due (enabled, next_poll_at reached), polled one after another until the deadline. */
async function pollDue(gc, cfg, now, deadline) {
  const out = [];
  for (const h of await store.listHosts(gc)) {
    if (!h.enabled || h.next_poll_at > now) continue;
    if (Date.now() > deadline) break;
    out.push(await pollHost(gc, h, cfg, { now }));
  }
  return out;
}

/** "Verbindung testen": the given (or stored) token against the given target, nothing stored. */
async function testConnection(gc, { target_index, token_id, secret }) {
  const client = createClient(gc, { index: target_index, tokenId: token_id, secret, timeoutMs: 8000 });
  const [version, statusR, resources] = await Promise.all([client.version(), settle(client.clusterStatus()), client.resources('node')]);
  const status = statusR.data || [];
  const c = status.find((x) => x && x.type === 'cluster');
  const names = new Set();
  for (const x of status) if (x && x.type === 'node' && x.name) names.add(String(x.name));
  for (const x of resources) if (x && x.type === 'node' && x.node) names.add(String(x.node));
  return {
    version: version && version.version ? String(version.version).slice(0, 32) : null,
    release: version && version.release ? String(version.release).slice(0, 32) : null,
    cluster: c ? String(c.name || '').slice(0, 64) : null,
    quorate: c ? Number(c.quorate) === 1 : null,
    nodes: [...names].sort().slice(0, 64),
  };
}

module.exports = { pollHost, pollDue, fetchSnapshot, testConnection, clientFor, backoffMs, UPDATES_EVERY_MS, MAX_BACKOFF_MS };
