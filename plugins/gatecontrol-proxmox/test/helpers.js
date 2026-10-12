'use strict';

// Test helpers: the mock host (tools/testing/mock-host.js) with a fake
// Proxmox VE API behind the home target "pve" — answers in the documented
// shapes of PVE 8.x ({ data: … }, test/fixtures/pve8.json), the token checked
// on every request, control actions as tasks (UPID) that run for a few
// status calls, and switches for the error cases (HTTP status, network,
// certificate).

const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');

const DIR = path.join(__dirname, '..');
const ADMIN = { id: 1, name: 'admin', role: 'admin' };
const ADMIN2 = { id: 4, name: 'Grace', role: 'admin' };
const ADA = { id: 2, name: 'Ada', role: 'user' };
const USERS = [ADMIN, ADA, ADMIN2];
const TOKEN_ID = 'gatecontrol@pve!monitor';
const SECRET = '0f3c9a52-7d1e-4b6a-9e2f-5a8c1d3b7e90';

const fixture = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pve8.json'), 'utf8'));

/**
 * A fake Proxmox VE. pve.fail = (path, o) → { status } | Error | undefined lets a
 * test break single calls; pve.down = true / an Error breaks everything.
 */
function fakePve(opts = {}) {
  const fx = fixture();
  const pve = {
    fx,
    calls: [],
    down: false,
    fail: null,
    tokenId: opts.tokenId || TOKEN_ID,
    secret: opts.secret || SECRET,
    taskPolls: opts.taskPolls == null ? 1 : opts.taskPolls, // status calls a task stays "running"
    taskExit: opts.taskExit || 'OK',
    tasks: new Map(),     // upid → { polls, exit }
    seq: 0,
  };
  const ok = (data) => ({ status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' }, body: JSON.stringify({ data }) });
  const guest = (vmid) => fx.cluster_resources.find((r) => (r.type === 'qemu' || r.type === 'lxc') && r.vmid === vmid);

  pve.fetch = async (p, o = {}) => {
    pve.calls.push({ path: p, method: o.method || 'GET', headers: o.headers || {}, form: o.form });
    if (pve.down) throw pve.down instanceof Error ? pve.down : Object.assign(new Error('connect ECONNREFUSED 192.0.2.11:8006'), { code: 'ERR_NET' });
    if (pve.fail) {
      const f = pve.fail(p, o);
      if (f instanceof Error) throw f;
      if (f) return { status: f.status, headers: {}, body: f.body || '' };
    }
    const auth = (o.headers || {}).authorization;
    if (auth !== `PVEAPIToken=${pve.tokenId}=${pve.secret}`) return { status: 401, headers: {}, body: '' }; // "authentication failure"
    const u = new URL(p, 'https://pve.invalid');
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg[0] !== 'api2' || seg[1] !== 'json') return { status: 404, body: '' };
    const r = seg.slice(2).map(decodeURIComponent);
    const m = o.method || 'GET';
    if (m === 'GET' && r.join('/') === 'version') return ok(fx.version);
    if (m === 'GET' && r.join('/') === 'cluster/status') return ok(fx.cluster_status);
    if (m === 'GET' && r.join('/') === 'cluster/resources') {
      const type = u.searchParams.get('type');
      const list = type === 'vm' ? fx.cluster_resources.filter((x) => x.type === 'qemu' || x.type === 'lxc')
        : (type ? fx.cluster_resources.filter((x) => x.type === type) : fx.cluster_resources);
      return ok(list);
    }
    if (m === 'GET' && r.join('/') === 'cluster/ha/status/current') return ok(fx.ha_status);
    if (r[0] === 'nodes' && r.length >= 3) {
      const node = r[1];
      if (!fx.node_status[node]) return { status: 595, body: '' }; // no route to that node
      if (m === 'GET' && r[2] === 'status' && r.length === 3) return ok(fx.node_status[node]);
      if (m === 'GET' && r[2] === 'apt' && r[3] === 'update') return ok(fx.apt_update);
      if (m === 'GET' && r[2] === 'tasks' && r.length === 3) {
        const tf = u.searchParams.get('typefilter');
        return ok((fx.tasks[node] || []).filter((x) => !tf || x.type === tf).slice(0, Number(u.searchParams.get('limit')) || 50));
      }
      if (m === 'GET' && r[2] === 'tasks' && r[4] === 'status') {
        const t = pve.tasks.get(r[3]);
        if (!t) return { status: 500, body: '' }; // "no such task"
        if (t.polls > 0) { t.polls--; return ok({ upid: r[3], node, status: 'running', type: t.type, id: String(t.vmid), user: pve.tokenId, starttime: 1727112000, pid: 1234 }); }
        if (t.exit === 'OK' && t.apply) { t.apply(); t.apply = null; }
        return ok({ upid: r[3], node, status: 'stopped', exitstatus: t.exit, type: t.type, id: String(t.vmid), user: pve.tokenId, starttime: 1727112000, pid: 1234 });
      }
      if (m === 'POST' && (r[2] === 'qemu' || r[2] === 'lxc') && r[4] === 'status' && r.length === 6) {
        const vmid = Number(r[3]);
        const g = guest(vmid);
        if (!g || g.node !== node || g.type !== r[2]) return { status: 500, body: '' }; // "Configuration file … does not exist"
        const action = r[5];
        const type = (r[2] === 'qemu' ? 'qm' : 'vz') + action;
        const upid = `UPID:${node}:${(0x1000 + ++pve.seq).toString(16).toUpperCase().padStart(8, '0')}:01F4C2D1:66F1B000:${type}:${vmid}:${pve.tokenId}:`;
        const next = action === 'start' || action === 'reboot' ? 'running' : 'stopped';
        pve.tasks.set(upid, { polls: pve.taskPolls, exit: pve.taskExit, type, vmid, apply: () => { g.status = next; } });
        return ok(upid);
      }
    }
    return { status: 501, body: '' }; // "Method not implemented"
  };
  return pve;
}

/**
 * A host with an assigned "pve" target (or none: opts.targets = {}) and the household users.
 */
async function withHost(opts, fn) {
  const pve = opts.pve || fakePve(opts.pveOpts);
  const host = await createHost(DIR, {
    users: opts.users || USERS,
    settings: opts.settings || {},
    targets: opts.targets || { pve: [{ label: 'Proxmox (Route proxmox.home.example)', fetch: (p, o) => pve.fetch(p, o) }] },
    notifyFail: opts.notifyFail,
  });
  host.pve = pve;
  await host.start();
  try { return await fn(host, pve); } finally { await host.close(); }
}

const asAdmin = (host, method, p, body) => host.request({ method, path: p, body: body === undefined ? null : body, user: ADMIN });

/** Create a connection through the API and poll it once. */
async function addHost(host, extra = {}) {
  const r = await asAdmin(host, 'POST', '/hosts', { name: 'Homelab', target_index: 0, token_id: TOKEN_ID, token_secret: SECRET, ...extra });
  if (r.status !== 200) throw new Error('addHost: ' + JSON.stringify(r.json));
  const id = r.json.host.id;
  await asAdmin(host, 'POST', `/hosts/${id}/refresh`);
  return id;
}

module.exports = { DIR, ADMIN, ADMIN2, ADA, USERS, TOKEN_ID, SECRET, fixture, fakePve, withHost, asAdmin, addHost };
