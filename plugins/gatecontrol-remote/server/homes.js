'use strict';

// 1.7.2: the home networks of „Gerät hinzufügen“ — the gateways of gc.remote.candidates (version 7) grouped by their
// failover pool. Gateways of one pool see the same network: one section for the pool, its devices merged over all
// of its gateways, each device once. A gateway without a pool stays a section of its own, as before.
//
//   home = { id: 'pool-<poolId>' | 'gw-<peerId>', pool: { poolId, name } | null, name, peerId (an online gateway of
//            it, else the first), online (any), onlineCount, total, offlineSince (none online: the latest),
//            members: [{ peerId, name, online, offlineSince }], subnets, watch, devices }
//   device = { ref, refs, name, address, vendor, online, lastSeen, ports, portsAt, wake, twin,
//              via: [{ peerId, ref, online (the gateway's), wake }] }   — `ref` is the one of the best entry
//
// One device: the same address in the same subnet of the pool (no subnet reported: the same address). Its ports are
// the union, name and vendor come from the best entry (a gateway online, the device online, a name, a vendor, the
// latest sighting). Nothing is stored.

const { inCidr } = require('./way');

function time(s) {
  const t = Date.parse(s || '');
  return Number.isFinite(t) ? t : 0;
}
function later(a, b) { return time(a) >= time(b) ? (a || b || null) : b; }

/** The rank of one entry of a device: higher is better. */
function rank(e) {
  return (e.gwOnline ? 16 : 0) + (e.d.online ? 8 : 0) + (e.d.name ? 4 : 0) + (e.d.vendor ? 2 : 0) + (Array.isArray(e.d.ports) ? 1 : 0);
}

/** The union of the ports of several entries (null when none of them knows its ports). */
function unionPorts(list) {
  const known = list.filter((e) => Array.isArray(e.d.ports));
  if (!known.length) return null;
  const out = new Map();
  for (const e of known) {
    for (const p of e.d.ports) {
      if (!p || !Number.isInteger(p.port)) continue;
      const had = out.get(p.port);
      if (!had || (!had.service && p.service)) out.set(p.port, { port: p.port, service: p.service || null });
    }
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
}

/** One device out of its entries on several gateways of a home. */
function mergeDevice(entries) {
  const sorted = entries.slice().sort((a, b) => rank(b) - rank(a) || time(b.d.lastSeen) - time(a.d.lastSeen));
  const best = sorted[0].d;
  const pick = (k) => { const hit = sorted.find((e) => e.d[k]); return hit ? hit.d[k] : null; };
  return {
    ref: best.ref,
    refs: sorted.map((e) => e.d.ref),
    name: best.name || pick('name'),
    address: best.address,
    vendor: best.vendor || pick('vendor'),
    online: sorted.some((e) => e.gwOnline && e.d.online),
    lastSeen: sorted.reduce((m, e) => later(m, e.d.lastSeen), null),
    ports: unionPorts(sorted),
    portsAt: sorted.reduce((m, e) => later(m, e.d.portsAt), null),
    wake: sorted.some((e) => !!e.d.wake),
    twin: pick('twin'),
    via: sorted.map((e) => ({ peerId: e.g.peerId, ref: e.d.ref, online: e.gwOnline, wake: !!e.d.wake })),
  };
}

/** The gateways of the candidates → the home networks (pools merged), in the order of their first gateway. */
function of(cand) {
  const gws = cand && Array.isArray(cand.gateways) ? cand.gateways : [];
  const byKey = new Map();
  for (const g of gws) {
    const poolId = g.pool && Number.isSafeInteger(Number(g.pool.poolId)) ? Number(g.pool.poolId) : null;
    const key = poolId != null ? 'pool-' + poolId : 'gw-' + g.peerId;
    if (!byKey.has(key)) byKey.set(key, { key, pool: poolId != null ? { poolId, name: g.pool.name || null } : null, gws: [] });
    byKey.get(key).gws.push(g);
  }
  const out = [];
  for (const h of byKey.values()) {
    const members = h.gws.map((g) => ({ peerId: g.peerId, name: g.name, online: !!g.online, offlineSince: g.online ? null : (g.offlineSince || null) }));
    const on = members.filter((m) => m.online);
    const subnets = [...new Set(h.gws.flatMap((g) => (Array.isArray(g.subnets) ? g.subnets : [])))];
    const watches = h.gws.map((g) => g.watch).filter(Boolean);
    // the same address in the same subnet of the home = one device
    const groups = new Map();
    for (const g of h.gws) {
      for (const d of (g.devices || [])) {
        if (!d || !d.address) continue;
        const net = subnets.find((s) => inCidr(d.address, s)) || '';
        const k = net + '|' + d.address;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push({ g, d, gwOnline: !!g.online });
      }
    }
    out.push({
      id: h.key,
      pool: h.pool,
      name: h.pool && h.pool.name && h.gws.length > 1 ? h.pool.name : h.gws[0].name, // a pool of one gateway: its name
      peerId: (on[0] || members[0]).peerId,
      online: on.length > 0,
      onlineCount: on.length,
      total: members.length,
      offlineSince: on.length ? null : members.reduce((m, x) => later(m, x.offlineSince), null),
      members,
      subnets,
      watch: watches.length ? { enabled: watches.some((w) => w.enabled), portscan: watches.some((w) => w.portscan), scannedAt: watches.reduce((m, w) => later(m, w.scannedAt), null) } : null,
      devices: [...groups.values()].map(mergeDevice),
    });
  }
  return out;
}

module.exports = { of, mergeDevice, unionPorts };
