'use strict';

// Presence of the apps for direct transfers: PUT presence { lan: [{ ip, prefix }], port?, listening } — the
// Android app and the Windows client report every 5 minutes and when the network changes. A report older
// than 15 minutes no longer counts (the device left, the app was closed).

const store = require('./store');
const net = require('./net');
const { fail, parseJson } = require('./util');

const FRESH_MS = 15 * 60000;
const REPORT_EVERY_S = 300;

/** PUT presence (the requesting app installation) → { at, everyS } */
async function put(ctx, body) {
  if (!ctx.deviceId) throw fail('no_device');
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) throw fail('invalid');
  const lan = net.cleanLan(b.lan);
  if (!lan) throw fail('invalid');
  if (typeof b.listening !== 'boolean') throw fail('invalid');
  let port = null;
  if (b.port != null) {
    if (!Number.isInteger(b.port) || b.port < 1024 || b.port > 65535) throw fail('invalid');
    port = b.port;
  }
  await store.run(ctx.gc, `INSERT INTO presence (device_id, user_id, lan, port, listening, at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET user_id = excluded.user_id, lan = excluded.lan, port = excluded.port, listening = excluded.listening, at = excluded.at`,
  [ctx.deviceId, ctx.viewer, JSON.stringify(lan), port, b.listening ? 1 : 0, ctx.now]);
  return { lan, port: port == null ? net.DEFAULT_PORT : port, listening: b.listening, everyS: REPORT_EVERY_S, freshS: FRESH_MS / 1000 };
}

/** The fresh presence of one of the person's devices → { deviceId, lan, port, listening, at } or null. */
async function get(gc, deviceId, userId, now) {
  if (!deviceId) return null;
  const r = await store.one(gc, 'SELECT * FROM presence WHERE device_id = ?', [deviceId]);
  if (!r || r.user_id !== userId || now - r.at > FRESH_MS) return null;
  return { deviceId: r.device_id, lan: parseJson(r.lan, []), port: r.port, listening: r.listening === 1, at: r.at };
}

/**
 * How the requesting device (`mine`, a presence or null) reaches `dev` (one of the same person's devices from
 * gc.devices.list) directly: { direct: true, mode: 'push' | 'pull', candidates } or { direct: false }.
 *   push — `dev` listens: the sender connects to it (candidates = dev's addresses in a shared network);
 *   pull — the sender listens: `dev` fetches from it (candidates = the sender's addresses).
 * Both need a fresh presence of both and `dev` online (it gets the transfer by a silent push).
 */
async function plan(gc, mine, dev, userId, now) {
  if (!mine || !dev || !dev.online) return { direct: false };
  const other = await get(gc, dev.id, userId, now);
  if (!other) return { direct: false };
  if (other.listening) {
    const c = net.candidates(mine, other);
    if (c.length) return { direct: true, mode: 'push', candidates: c };
  }
  if (mine.listening) {
    const c = net.candidates(other, mine);
    if (c.length) return { direct: true, mode: 'pull', candidates: c };
  }
  return { direct: false };
}

/** Background: presence rows older than a day go. */
async function cleanup(gc, now) {
  const r = await store.run(gc, 'DELETE FROM presence WHERE at < ?', [now - 86400000]);
  return r.changes;
}

module.exports = { put, get, plan, cleanup, FRESH_MS, REPORT_EVERY_S };
