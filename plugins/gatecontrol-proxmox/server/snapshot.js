'use strict';

// The status of one Proxmox VE connection, normalised from the API answers
// (pure; numbers as numbers, unknown fields dropped, lists capped):
//
//   { at, version: { version, release } | null,
//     cluster: { name, quorate, nodes } | null          (null: a single node without a cluster)
//     nodes:    [{ name, online, ip, cpu, maxcpu, mem, maxmem, disk, maxdisk, uptime,
//                  load: [1, 5, 15] | null, swap: { used, total } | null, rootfs: { used, total } | null,
//                  kversion, pveversion, cpuModel, error, updates: n | null, updatesError }]
//     guests:   [{ vmid, type: qemu|lxc, node, name, status, cpu, maxcpu, mem, maxmem, disk, maxdisk,
//                  uptime, template, tags, lock, hastate }]
//     storages: [{ id, storage, node, nodes, type, content, shared, status, used, total }]
//     backups:  [{ upid, node, vmid, starttime, endtime, status, ok, user }]   newest first
//     ha:       { quorum, master, services, errors } | { error } | null }
//
// Sources (PVE 8.x): /version, /cluster/status, /cluster/resources,
// /nodes/{node}/status, /nodes/{node}/tasks?typefilter=vzdump,
// /cluster/ha/status/current, /nodes/{node}/apt/update.

const MAX_GUESTS = 1500;
const MAX_STORAGES = 300;
const MAX_BACKUPS = 40;

const num = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) ? n : null;
};
const str = (v, max = 120) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, max) : null);
const pair = (o, usedKey = 'used', totalKey = 'total') => {
  if (!o || typeof o !== 'object') return null;
  const used = num(o[usedKey]);
  const total = num(o[totalKey]);
  return used == null || total == null ? null : { used, total };
};

/** "pve-manager/8.2.4/faa83925c9641325" → "8.2.4" */
function managerVersion(s) {
  const m = /pve-manager\/([0-9][0-9A-Za-z.~+-]*)/.exec(String(s || ''));
  return m ? m[1] : null;
}

/** A vzdump task → finished-ok? "OK" and "WARNINGS: n" are no failure. */
function taskOk(status) {
  const s = String(status || '');
  return s === 'OK' || /^WARNINGS?:/i.test(s);
}

/** The guest of a vzdump task: its id field (empty for a job over several guests). */
function taskGuest(t) {
  const id = num(t && t.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function cluster(statusList) {
  const c = (statusList || []).find((x) => x && x.type === 'cluster');
  if (!c) return null;
  return { name: str(c.name, 64), quorate: c.quorate == null ? null : Number(c.quorate) === 1, nodes: num(c.nodes) };
}

function node(res, st, info) {
  const s = info && info.data && typeof info.data === 'object' ? info.data : null;
  const load = s && Array.isArray(s.loadavg) ? s.loadavg.slice(0, 3).map(num) : null;
  return {
    name: str(res.node || res.name, 64),
    online: res.status === 'online' || (st ? Number(st.online) === 1 && res.status !== 'offline' : false),
    ip: st && st.ip ? str(st.ip, 64) : null,
    cpu: num(s && s.cpu != null ? s.cpu : res.cpu),
    maxcpu: num(res.maxcpu != null ? res.maxcpu : s && s.cpuinfo && s.cpuinfo.cpus),
    mem: num(s && s.memory ? s.memory.used : res.mem),
    maxmem: num(s && s.memory ? s.memory.total : res.maxmem),
    disk: num(res.disk),
    maxdisk: num(res.maxdisk),
    uptime: num(s && s.uptime != null ? s.uptime : res.uptime),
    load: load && load.every((x) => x != null) ? load : null,
    swap: s ? pair(s.swap) : null,
    rootfs: s ? pair(s.rootfs) : null,
    kversion: s ? str(s.kversion, 160) : null,
    pveversion: s ? managerVersion(s.pveversion) : null,
    cpuModel: s && s.cpuinfo ? str(s.cpuinfo.model, 120) : null,
    error: info && info.error ? String(info.error) : null,
    updates: null,
    updatesError: null,
  };
}

function guest(r) {
  return {
    vmid: num(r.vmid),
    type: r.type,
    node: str(r.node, 64),
    name: str(r.name, 120) || '',
    status: str(r.status, 32) || 'unknown',
    cpu: num(r.cpu),
    maxcpu: num(r.maxcpu),
    mem: num(r.mem),
    maxmem: num(r.maxmem),
    disk: num(r.disk),
    maxdisk: num(r.maxdisk),
    uptime: num(r.uptime),
    template: Number(r.template) === 1,
    tags: str(r.tags, 200) ? str(r.tags, 200).split(/[;, ]+/).filter(Boolean).slice(0, 10) : [],
    lock: str(r.lock, 32),
    hastate: str(r.hastate, 32),
  };
}

function storages(list) {
  const out = new Map();
  for (const r of list) {
    const shared = Number(r.shared) === 1;
    const name = str(r.storage, 64);
    if (!name) continue;
    const id = shared ? `storage/${name}` : `storage/${str(r.node, 64)}/${name}`;
    const cur = out.get(id);
    if (cur) { if (!cur.nodes.includes(r.node)) cur.nodes.push(str(r.node, 64)); continue; }
    out.set(id, {
      id, storage: name, node: shared ? null : str(r.node, 64), nodes: [str(r.node, 64)], type: str(r.plugintype, 32),
      content: str(r.content, 120), shared, status: str(r.status, 32) || 'unknown', used: num(r.disk), total: num(r.maxdisk),
    });
  }
  return [...out.values()].slice(0, MAX_STORAGES);
}

function ha(info) {
  if (!info) return null;
  if (info.error) return { error: String(info.error) };
  const list = Array.isArray(info.data) ? info.data : [];
  if (!list.length) return null;
  const q = list.find((x) => x && x.type === 'quorum');
  const m = list.find((x) => x && x.type === 'master');
  const services = list.filter((x) => x && x.type === 'service');
  const errors = services.filter((x) => /error|fence|recovery/i.test(String(x.state || x.status || ''))).map((x) => str(x.sid || x.id, 64)).slice(0, 20);
  return { quorum: q ? str(q.status, 32) : null, master: m ? str(m.node, 64) : null, services: services.length, errors };
}

/**
 * @param {object} raw  { version, clusterStatus, resources, nodeStatus: { node: { data | error } },
 *                        tasks: { node: { data | error } }, ha: { data | error } | null,
 *                        updates: { node: { count, error } } | null }
 * @param {number} at   ms
 */
function normalize(raw, at) {
  const resources = Array.isArray(raw.resources) ? raw.resources.filter((r) => r && typeof r === 'object') : [];
  const status = Array.isArray(raw.clusterStatus) ? raw.clusterStatus.filter((r) => r && typeof r === 'object') : [];
  const stByName = new Map(status.filter((x) => x.type === 'node').map((x) => [x.name, x]));
  const nodeRes = resources.filter((r) => r.type === 'node');
  // a node of /cluster/status the resources do not list (no Sys.Audit on it): shown from the status
  for (const [name, st] of stByName) if (!nodeRes.some((r) => r.node === name)) nodeRes.push({ type: 'node', node: name, status: Number(st.online) === 1 ? 'online' : 'offline' });
  const nodes = nodeRes.map((r) => {
    const n = node(r, stByName.get(r.node), (raw.nodeStatus || {})[r.node]);
    const u = raw.updates ? raw.updates[r.node] : null;
    if (u) { n.updates = u.count == null ? null : u.count; n.updatesError = u.error || null; }
    return n;
  }).filter((n) => n.name).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

  const guests = resources.filter((r) => (r.type === 'qemu' || r.type === 'lxc') && Number.isInteger(num(r.vmid)))
    .map(guest).sort((a, b) => a.vmid - b.vmid).slice(0, MAX_GUESTS);

  const backups = [];
  for (const [n, info] of Object.entries(raw.tasks || {})) {
    if (!info || !Array.isArray(info.data)) continue;
    for (const t of info.data) {
      if (!t || t.type !== 'vzdump' || typeof t.upid !== 'string' || t.endtime == null || t.status == null) continue; // finished ones only
      backups.push({
        upid: t.upid.slice(0, 400), node: str(t.node, 64) || n, vmid: taskGuest(t), starttime: num(t.starttime), endtime: num(t.endtime),
        status: str(t.status, 200), ok: taskOk(t.status), user: str(t.user, 120),
      });
    }
  }
  backups.sort((a, b) => (b.starttime || 0) - (a.starttime || 0));

  const v = raw.version && typeof raw.version === 'object' ? raw.version : null;
  return {
    at,
    version: v && v.version ? { version: str(v.version, 32), release: str(v.release, 32) } : null,
    cluster: cluster(status),
    nodes,
    guests,
    storages: storages(resources.filter((r) => r.type === 'storage')),
    backups: backups.slice(0, MAX_BACKUPS),
    ha: ha(raw.ha),
  };
}

/** Percent 0–100 (one decimal) of used/total, null when unknown. */
function pct(used, total) {
  const u = num(used);
  const t = num(total);
  return u == null || !t ? null : Math.round((u / t) * 1000) / 10;
}

module.exports = { normalize, managerVersion, taskOk, pct, num, MAX_GUESTS, MAX_BACKUPS };
