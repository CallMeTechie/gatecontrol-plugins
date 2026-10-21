'use strict';

// Same-network detection for direct transfers (contract C): the apps report their LAN addresses
// (PUT presence { lan: [{ ip, prefix }], port, listening }); two devices may talk directly when one
// of the requesting device's addresses and one of the other device's lie in the same private IPv4
// network (the shorter of both prefixes). Only private ranges (10/8, 172.16/12, 192.168/16) count —
// the listener never answers on other networks.

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const DEFAULT_PORT = 47731;

/** '192.168.1.20' → 32-bit unsigned integer, or null. */
function ipv4(s) {
  const m = IPV4_RE.exec(String(s || ''));
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((x) => x > 255) || m.slice(1).some((x) => x.length > 1 && x[0] === '0')) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

const mask = (prefix) => (prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

/** Is this address in a private IPv4 range (RFC 1918)? */
function isPrivate(n) {
  return (n >>> 24) === 10 || (n >>> 20) === (0xac1 /* 172.16/12 */) || (n >>> 16) === 0xc0a8;
}

/** A reported address list → [{ ip, prefix }] (valid IPv4 only, prefix 8…30, at most 8, duplicates dropped); null when not a list. */
function cleanLan(v) {
  if (!Array.isArray(v) || v.length > 16) return null;
  const out = [];
  for (const x of v) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
    const n = ipv4(x.ip);
    const prefix = x.prefix;
    if (n == null || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) continue; // IPv6 and the like: ignored
    if (out.some((y) => y.ip === x.ip)) continue;
    if (out.length < 8) out.push({ ip: x.ip, prefix });
  }
  return out;
}

/** The addresses of `b` reachable from one of `a` (same private network) → [{ ip, prefix }]. */
function reachable(a, b) {
  const out = [];
  for (const y of b || []) {
    const ny = ipv4(y.ip);
    if (ny == null || !isPrivate(ny)) continue;
    for (const x of a || []) {
      const nx = ipv4(x.ip);
      if (nx == null || !isPrivate(nx) || nx === ny) continue;
      const m = mask(Math.min(x.prefix, y.prefix));
      if (((nx & m) >>> 0) === ((ny & m) >>> 0)) { out.push(y); break; }
    }
  }
  return out;
}

/** 'ip:port' candidates of the listener `to` as seen from `from` (presence rows) → list (≤ 4). */
function candidates(from, to) {
  const port = Number.isInteger(to.port) && to.port >= 1024 && to.port <= 65535 ? to.port : DEFAULT_PORT;
  return reachable(from.lan, to.lan).slice(0, 4).map((x) => `${x.ip}:${port}`);
}

module.exports = { ipv4, isPrivate, cleanLan, reachable, candidates, DEFAULT_PORT };
