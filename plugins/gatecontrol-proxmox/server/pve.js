'use strict';

// Proxmox VE API client (PVE 8.x, https://pve.proxmox.com/pve-docs/api-viewer/).
//
// The plugin has no network of its own: every request goes through the host
// to an administrator-assigned assignment of the home target "pve"
// (gc.net.fetchTarget('pve', '/api2/json/…', { index })). Authentication is an
// API token: `Authorization: PVEAPIToken=USER@REALM!TOKENID=SECRET` — no
// ticket, no CSRFPreventionToken (only ticket logins need one). Every answer
// of the API is `{ "data": … }`; errors come as HTTP status (401 bad token,
// 403 missing privilege, 500 failure, 595 another cluster node not reachable).
//
// Certificates: the host makes the HTTPS connection with Node's default
// verification (public CAs, host name) and offers no option to relax it or
// to pin a fingerprint. Proxmox's own self-signed certificate on :8006 is
// therefore refused on a direct assignment (peer / address with https) —
// reported as PVE_TLS. Working setups (CHANGELOG 1.0.0, "Einrichtung" on the
// page): a
// GateControl HTTP route via a Home Gateway with "Backend HTTPS" (the gateway
// speaks HTTPS to the LAN target and accepts the self-signed certificate,
// optionally pinned by its SHA-256 fingerprint on the route), or a
// certificate from a public CA on the Proxmox node (ACME) assigned by its
// DNS name.
//
// Errors carry a code and the HTTP status only — never a response body, never
// the token.

const TARGET = 'pve';
const BASE = '/api2/json';

const TOKEN_ID_RE = /^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9._-]{1,64}![A-Za-z][A-Za-z0-9._-]{1,63}$/;
const SECRET_RE = /^[A-Za-z0-9-]{8,128}$/;
const NODE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$/;
const UPID_RE = /^UPID:[A-Za-z0-9.-]{1,64}:[0-9A-Fa-f]{8}:[0-9A-Fa-f]{8,16}:[0-9A-Fa-f]{8}:[A-Za-z0-9_-]{1,40}:[^\s:]{0,64}:[^\s:]{1,200}:$/;
const TYPES = ['qemu', 'lxc'];
const ACTIONS = ['start', 'shutdown', 'stop', 'reboot'];

function codeError(code, status) {
  return Object.assign(new Error(status ? `${code} (HTTP ${status})` : code), { code, status: status || null });
}

const validTokenId = (v) => typeof v === 'string' && TOKEN_ID_RE.test(v);
const validSecret = (v) => typeof v === 'string' && SECRET_RE.test(v);
const validNode = (v) => typeof v === 'string' && NODE_RE.test(v);
const validVmid = (v) => Number.isInteger(v) && v >= 100 && v <= 999999999;
const validUpid = (v) => typeof v === 'string' && v.length <= 400 && UPID_RE.test(v);

/** The node a task runs on (2nd field of the UPID). */
function upidNode(upid) {
  return validUpid(upid) ? upid.split(':')[1] : null;
}

/** "PVEAPIToken=USER@REALM!TOKENID=SECRET" */
function authHeader(tokenId, secret) {
  return `PVEAPIToken=${tokenId}=${secret}`;
}

// Messages of TLS failures in Node (the host passes the error message on).
const TLS_RE = /certificate|self[- ]signed|altnames|unable to verify|UNABLE_TO|DEPTH_ZERO|CERT_|ERR_TLS|SSL|tls/i;

/** An error of gc.net.fetchTarget → our code. */
function netError(e) {
  const msg = String((e && e.message) || '');
  if (e && e.code === 'ERR_NET_DENIED') {
    if (/no target assigned|not assigned|declares no target|not declared|unassigned/i.test(msg)) return codeError('PVE_NO_TARGET');
    return codeError('PVE_TARGET_DENIED');
  }
  if (TLS_RE.test(msg)) return codeError('PVE_TLS');
  if (/timeout|timed out/i.test(msg)) return codeError('PVE_TIMEOUT');
  return codeError('PVE_UNREACHABLE');
}

/** A non-2xx answer → our code. */
function statusError(status) {
  if (status >= 300 && status < 400) return codeError('PVE_HTTPS_REQUIRED', status); // pveproxy redirects plain HTTP to HTTPS
  if (status === 400) return codeError('PVE_BAD_REQUEST', status);
  if (status === 401) return codeError('PVE_AUTH', status);
  if (status === 403) return codeError('PVE_FORBIDDEN', status);
  if (status === 404 || status === 501) return codeError('PVE_NOT_FOUND', status);
  if (status === 595) return codeError('PVE_NODE_DOWN', status); // pveproxy could not reach the node the call is for
  if (status === 502 || status === 503 || status === 504) return codeError('PVE_GATEWAY', status); // a proxy (GateControl gateway) in between
  if (status >= 500) return codeError('PVE_SERVER', status);
  return codeError('PVE_HTTP', status);
}

/**
 * @param {object} gc  host API
 * @param {{ index: number, tokenId: string, secret: string, timeoutMs?: number }} o
 */
function createClient(gc, { index, tokenId, secret, timeoutMs = 10000 } = {}) {
  if (!Number.isInteger(index) || index < 0) throw codeError('PVE_NO_TARGET');
  if (!validTokenId(tokenId)) throw codeError('TOKEN_ID_INVALID');
  if (!validSecret(secret)) throw codeError('PVE_NO_SECRET');
  const headers = { authorization: authHeader(tokenId, secret), accept: 'application/json' };

  async function call(method, path, { query, form } = {}) {
    let p = BASE + path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v != null) qs.append(k, String(v));
      const s = qs.toString();
      if (s) p += '?' + s;
    }
    let res;
    try {
      res = await gc.net.fetchTarget(TARGET, p, { index, method, headers, ...(form ? { form } : {}), timeoutMs, redirect: 'manual' });
    } catch (e) {
      throw netError(e);
    }
    if (!res || typeof res.status !== 'number') throw codeError('PVE_BAD_RESPONSE');
    if (res.status < 200 || res.status >= 300) throw statusError(res.status);
    let body;
    try { body = JSON.parse(res.body || ''); } catch { throw codeError('PVE_BAD_RESPONSE', res.status); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('data' in body)) throw codeError('PVE_BAD_RESPONSE', res.status);
    return body.data;
  }

  const node = (n) => {
    if (!validNode(n)) throw codeError('PVE_BAD_RESPONSE');
    return encodeURIComponent(n);
  };
  const list = (v) => (Array.isArray(v) ? v : []);

  return {
    // GET /version → { version: '8.2.4', release: '8.2', repoid }
    version: () => call('GET', '/version'),
    // GET /cluster/status → [{ type: 'cluster', name, quorate, nodes }, { type: 'node', name, online, ip, local, nodeid }]
    clusterStatus: () => call('GET', '/cluster/status').then(list),
    // GET /cluster/resources → [{ id, type: node|qemu|lxc|storage|sdn|pool, node, vmid, name, status, cpu, maxcpu, mem, maxmem, disk, maxdisk, uptime, … }]
    resources: (type) => call('GET', '/cluster/resources', { query: type ? { type } : null }).then(list),
    // GET /nodes/{node}/status → { cpu, cpuinfo, loadavg, memory, swap, rootfs, uptime, kversion, pveversion, … }
    nodeStatus: (n) => call('GET', `/nodes/${node(n)}/status`),
    // GET /nodes/{node}/tasks?typefilter=vzdump&limit=N → finished tasks [{ upid, type, id, user, starttime, endtime, status }]
    nodeTasks: (n, { typefilter = 'vzdump', limit = 20 } = {}) => call('GET', `/nodes/${node(n)}/tasks`, { query: { typefilter, limit } }).then(list),
    // GET /cluster/ha/status/current → [{ id: 'quorum'|'master'|'lrm:…'|'service:…', type, status, node, state, sid }]
    haStatus: () => call('GET', '/cluster/ha/status/current').then(list),
    // GET /nodes/{node}/apt/update → [{ Package, Version, OldVersion, … }] (read-only list; Proxmox asks Sys.Modify)
    aptUpdates: (n) => call('GET', `/nodes/${node(n)}/apt/update`).then(list),
    // POST /nodes/{node}/{qemu|lxc}/{vmid}/status/{start|shutdown|stop|reboot} → UPID (string)
    async guestAction(n, type, vmid, action) {
      if (!TYPES.includes(type) || !validVmid(vmid) || !ACTIONS.includes(action)) throw codeError('INVALID');
      const upid = await call('POST', `/nodes/${node(n)}/${type}/${vmid}/status/${action}`, { form: {} });
      if (!validUpid(upid)) throw codeError('PVE_BAD_RESPONSE');
      return upid;
    },
    // GET /nodes/{node}/tasks/{upid}/status → { status: 'running'|'stopped', exitstatus: 'OK'|<error> }
    async taskStatus(n, upid) {
      if (!validUpid(upid)) throw codeError('INVALID');
      return call('GET', `/nodes/${node(n)}/tasks/${encodeURIComponent(upid)}/status`);
    },
  };
}

module.exports = {
  createClient, authHeader, netError, statusError, codeError, upidNode,
  validTokenId, validSecret, validNode, validVmid, validUpid,
  TARGET, BASE, TYPES, ACTIONS,
};
