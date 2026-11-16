'use strict';

// 1.7: how GateControl reaches a device — the rule of the new „Gerät hinzufügen“ (one place for the wizard
// and the editor; the stored data keep access_mode, gateway_peer_id, … so the apps see what they saw before):
//
//   1. the address of a VPN device (a peer)          → vpn       access_mode internal, no listener
//   2. in the LAN subnets of a home gateway          → gateway   access_mode gateway, the pool of the gateway when
//                                                                 it is in one, the port on the server automatic
//                                                                 (several gateways with this net: `choices`; the
//                                                                 gateways of one pool are one choice, 1.7.2)
//   3. else: a private address (the server's LAN)    → server    access_mode internal
//            a public address or a name               → internet  access_mode both: the browser goes through the
//                                                                 server, the apps connect directly (no relay)
//
// `cand` is the answer of gc.remote.candidates (version 7): { vpn, peers, gateways, routes }. Nothing is stored.

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** '192.168.178.34' → number | null */
function ip4(s) {
  const m = IPV4_RE.exec(String(s || '').trim());
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

/** Does an IPv4 address lie in a CIDR ('192.168.178.0/24')? */
function inCidr(ip, cidr) {
  const [base, bitsRaw] = String(cidr || '').split('/');
  const a = ip4(ip);
  const b = ip4(base);
  const bits = Number(bitsRaw);
  if (a == null || b == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/** A private / shared IPv4 (10/8, 172.16/12, 192.168/16, 100.64/10) or a unique local / link IPv6. */
function isPrivate(host) {
  const a = ip4(host);
  if (a != null) {
    const o1 = a >>> 24;
    const o2 = (a >>> 16) & 255;
    return o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168) || (o1 === 100 && o2 >= 64 && o2 <= 127);
  }
  const h = String(host || '').toLowerCase();
  return /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith('fe80:');
}

function gatewayView(g) {
  return { peerId: g.peerId, name: g.name, online: g.online !== false, offlineSince: g.offlineSince || null, pool: g.pool || null };
}

/** The settings a way stands for (what is stored; nothing else changes). */
function accessOf(w, host, port) {
  if (w.kind === 'gateway' && w.gateway) {
    return { access_mode: 'gateway', gateway_peer_id: w.gateway.pool ? null : w.gateway.peerId, gateway_pool_id: w.gateway.pool ? w.gateway.pool.poolId : null, external_hostname: null, external_port: null };
  }
  if (w.kind === 'internet') return { access_mode: 'both', gateway_peer_id: null, gateway_pool_id: null, gateway_listen_port: null, external_hostname: host, external_port: port || null };
  return { access_mode: 'internal', gateway_peer_id: null, gateway_pool_id: null, gateway_listen_port: null, external_hostname: null, external_port: null };
}

/**
 * The way to `host` → { kind: vpn | gateway | server | internet, peer, gateway, choices, twin }
 * `pick` (a gateway peerId) decides between several gateways with the same net.
 */
function derive(host, cand, pick) {
  const h = String(host || '').trim();
  const c = cand || {};
  const peers = Array.isArray(c.peers) ? c.peers : [];
  const gws = Array.isArray(c.gateways) ? c.gateways : [];
  const lower = h.toLowerCase();
  const peer = peers.find((p) => p.address === h || (p.dnsName && p.dnsName.toLowerCase() === lower)) || null;
  if (peer) return { kind: 'vpn', peer: { peerId: peer.peerId, name: peer.name, address: peer.address, dnsName: peer.dnsName || null, app: peer.app || null }, gateway: null, choices: [], twin: peer.twin || null };
  const hits = ip4(h) != null ? gws.filter((g) => (g.subnets || []).some((s) => inCidr(h, s))) : [];
  if (hits.length) {
    // 1.7.2: the gateways of one failover pool are one choice (the target goes through the pool) — an online one of it
    const seen = new Map();
    for (const g of hits) {
      const k = g.pool && g.pool.poolId != null ? 'pool-' + g.pool.poolId : 'gw-' + g.peerId;
      const had = seen.get(k);
      if (!had || (had.online === false && g.online !== false)) seen.set(k, g);
    }
    const one = [...seen.values()];
    const asked = hits.find((g) => g.peerId === Number(pick)) || null;
    const chosen = asked ? (asked.pool ? one.find((g) => g.pool && g.pool.poolId === asked.pool.poolId) : asked) : one[0];
    return { kind: 'gateway', peer: null, gateway: gatewayView(chosen), choices: one.length > 1 ? one.map(gatewayView) : [], twin: null };
  }
  if (ip4(h) != null || h.includes(':')) return { kind: isPrivate(h) ? 'server' : 'internet', peer: null, gateway: null, choices: [], twin: null };
  // a name: one of the VPN zone that is no peer stays inside, any other one goes out through the server
  const zone = c.vpn && c.vpn.zone ? String(c.vpn.zone).toLowerCase() : null;
  if (zone && lower.endsWith('.' + zone)) return { kind: 'server', peer: null, gateway: null, choices: [], twin: null };
  return { kind: 'internet', peer: null, gateway: null, choices: [], twin: null };
}

/**
 * How a stored device is shown (no data migration — only read from what is stored):
 *   internal + a peer's address  → vpn        internal + a gateway's net → server with hint 'lan'
 *   internal + other             → server / internet (a public address)    gateway / pool → gateway
 *   external                     → internet   both → by its host, the apps over external_hostname
 */
function ofDevice(d, cand) {
  const c = d.config;
  const gws = (cand && Array.isArray(cand.gateways)) ? cand.gateways : [];
  if (c.access_mode === 'gateway') {
    const g = c.gateway_peer_id ? gws.find((x) => x.peerId === c.gateway_peer_id) : gws.find((x) => x.pool && x.pool.poolId === c.gateway_pool_id);
    const pool = c.gateway_pool_id ? (g && g.pool ? g.pool : { poolId: c.gateway_pool_id, name: null }) : null;
    return { kind: 'gateway', gateway: g ? gatewayView(g) : (c.gateway_peer_id ? { peerId: c.gateway_peer_id, name: null, online: null, pool: null } : null), pool, listenPort: c.gateway_listen_port || null, hint: null };
  }
  if (c.access_mode === 'external') return { kind: 'internet', external: { host: c.external_hostname, port: c.external_port || c.port }, hint: null };
  const w = derive(c.host, cand);
  const out = { kind: w.kind === 'gateway' ? 'server' : w.kind, peer: w.peer, hint: null };
  if (w.kind === 'gateway') out.hint = { kind: 'lan', gateway: w.gateway, choices: w.choices };
  if (c.access_mode === 'both') out.external = { host: c.external_hostname, port: c.external_port || c.port };
  return out;
}

module.exports = { derive, ofDevice, accessOf, inCidr, isPrivate, ip4 };
