'use strict';

// Direct transfers in the home network (contract C, protocol v1). The plugin only brokers them: a transfer
// per receiving device with a one-time ticket (10 minutes) and a key (32 random bytes, AES-256-GCM in 1 MiB
// blocks, nonce = first 4 bytes of SHA-256(transferId) ‖ 8-byte block counter) — the bytes never pass the
// server. The listener accepts a transfer only with a ticket it learnt from the plugin (silent push or
// GET transfers/<id>); both ends report POST transfers/<id>/result { ok, bytes?, error? }.
//   ok              → the delivery is delivered via direct
//   failed/expired  → the server way: all files on the server → a push to the device (delivered via server);
//                     files still local → the delivery waits (pending, error direct_failed) and the sender is
//                     told { fallback: 'upload' }: it uploads them and calls POST sends/<id>/items.

const crypto = require('node:crypto');
const store = require('./store');
const deliver = require('./deliver');
const { fail, newId, iso, parseJson, DEVICE_RE } = require('./util');

const TICKET_MS = 10 * 60000;
const ERROR_RE = /^[a-z0-9_.-]{1,64}$/;

/** A new transfer row (inside the send's transaction) → the row. */
async function create(gc, { sendId, deliveryId, fromDevice, toDevice, mode, candidates }, now) {
  const row = {
    id: newId(), send_id: sendId, delivery_id: deliveryId, from_device: fromDevice, to_device: toDevice, mode, candidates,
    key: crypto.randomBytes(32).toString('base64'), ticket: crypto.randomBytes(32).toString('base64url'),
    created_at: now, expires_at: now + TICKET_MS, status: 'open',
  };
  await store.run(gc, `INSERT INTO transfers (id, send_id, delivery_id, from_device, to_device, mode, candidates, key, ticket, created_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`, [row.id, sendId, deliveryId, fromDevice, toDevice, mode, JSON.stringify(candidates), row.key, row.ticket, now, row.expires_at]);
  return row;
}

function rowOf(r) {
  return r ? { ...r, candidates: parseJson(r.candidates, []) } : null;
}

/** What the sender's answer lists per direct target. */
const directOut = (tr) => ({ deviceId: tr.to_device, transferId: tr.id, mode: tr.mode, candidates: tr.candidates, key: tr.key, ticket: tr.ticket, expiresAt: iso(tr.expires_at) });

/** The transfer and which end the requesting device is → { tr, side, send, delivery } (else not_found). */
async function locate(ctx, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id) || !ctx.deviceId) throw fail('not_found');
  const tr = rowOf(await store.one(ctx.gc, 'SELECT * FROM transfers WHERE id = ?', [id]));
  if (!tr) throw fail('not_found');
  const send = await store.one(ctx.gc, 'SELECT * FROM sends WHERE id = ?', [tr.send_id]);
  const delivery = await store.one(ctx.gc, 'SELECT * FROM deliveries WHERE id = ?', [tr.delivery_id]);
  if (!send || !delivery || send.user_id !== ctx.viewer) throw fail('not_found');
  let side = null;
  if (ctx.deviceId === tr.to_device) side = 'receiver';
  else if (ctx.deviceId === tr.from_device) side = 'sender';
  if (!side) throw fail('not_found');
  return { tr, side, send, delivery };
}

/** GET transfers/<id> (either end) → the transfer; the ticket and key only while it is open. */
async function get(ctx, id) {
  const { tr, side, send } = await locate(ctx, id);
  const items = await store.all(ctx.gc, 'SELECT idx, name, mime, bytes FROM items WHERE send_id = ? ORDER BY idx', [send.id]);
  const open = tr.status === 'open' && tr.expires_at > ctx.now;
  return {
    id: tr.id, sendId: send.id, side, mode: tr.mode, status: open ? 'open' : (tr.status === 'open' ? 'expired' : tr.status),
    fromDevice: tr.from_device, toDevice: tr.to_device, from: { userId: send.user_id, deviceId: send.device_id, deviceName: send.device_name || null },
    candidates: tr.candidates, key: open ? tr.key : null, ticket: open ? tr.ticket : null, expiresAt: iso(tr.expires_at),
    items: items.map((i) => ({ index: i.idx, name: i.name, bytes: i.bytes, mime: i.mime || null })),
  };
}

/**
 * The server way for a device delivery whose direct transfer did not work → 'server' (pushed) or 'upload' (files missing).
 * `senderName` for the push. Runs inside a transaction (the push after it: returned as a job).
 */
async function fallback(gc, send, delivery, now) {
  const items = await store.all(gc, 'SELECT * FROM items WHERE send_id = ? ORDER BY idx', [send.id]);
  if (send.purged) {
    await store.run(gc, "UPDATE deliveries SET status = 'expired', at = ? WHERE id = ?", [now, delivery.id]);
    return { way: null, job: null };
  }
  if (items.some((i) => !i.media_id)) {
    await store.run(gc, "UPDATE deliveries SET status = 'pending', via = NULL, error = 'direct_failed', at = ? WHERE id = ?", [now, delivery.id]);
    return { way: 'upload', job: null, missing: items.filter((i) => !i.media_id).map((i) => i.idx) };
  }
  await store.run(gc, "UPDATE deliveries SET status = 'delivered', via = 'server', error = 'direct_failed', at = ? WHERE id = ?", [now, delivery.id]);
  return { way: 'server', job: { send, items, delivery } };
}

/** Send the pushes of fallback jobs (after the commit). */
async function runJobs(gc, jobs, senderName) {
  for (const j of jobs) {
    if (!j) continue;
    const st = await deliver.deviceServer(gc, j.send, j.items, j.delivery, senderName);
    if (st.error) await store.run(gc, 'UPDATE deliveries SET error = ? WHERE id = ?', [st.error, j.delivery.id]);
  }
}

/** POST transfers/<id>/result { ok, bytes?, error? } → { transfer, delivery, fallback, missing? } */
async function result(ctx, id, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b || typeof b.ok !== 'boolean') throw fail('invalid');
  if (b.bytes != null && !(Number.isSafeInteger(b.bytes) && b.bytes >= 0)) throw fail('invalid');
  if (b.error != null && !(typeof b.error === 'string' && ERROR_RE.test(b.error))) throw fail('invalid');
  let job = null;
  const out = await store.tx(ctx.gc, async () => {
    const { tr, side, send, delivery } = await locate(ctx, id);
    const res = JSON.stringify({ ok: b.ok, bytes: b.bytes == null ? null : b.bytes, error: b.ok ? null : (b.error || 'failed'), at: ctx.now });
    await store.run(ctx.gc, `UPDATE transfers SET ${side === 'sender' ? 'sender_result' : 'receiver_result'} = ? WHERE id = ?`, [res, tr.id]);
    let way = null;
    let missing;
    const settled = ['delivered', 'opened'].includes(delivery.status);
    if (b.ok) {
      if (tr.status !== 'done') await store.run(ctx.gc, "UPDATE transfers SET status = 'done', done_at = ? WHERE id = ?", [ctx.now, tr.id]);
      if (!settled) await store.run(ctx.gc, "UPDATE deliveries SET status = 'delivered', via = 'direct', error = NULL, at = ? WHERE id = ?", [ctx.now, delivery.id]);
    } else if (tr.status === 'open') {
      await store.run(ctx.gc, "UPDATE transfers SET status = 'failed', done_at = ? WHERE id = ?", [ctx.now, tr.id]);
      if (!settled) {
        const f = await fallback(ctx.gc, send, delivery, ctx.now);
        way = f.way;
        job = f.job;
        missing = f.missing;
      }
    } else if (delivery.status === 'pending' && delivery.error === 'direct_failed') {
      way = 'upload';
      missing = (await store.all(ctx.gc, 'SELECT idx FROM items WHERE send_id = ? AND media_id IS NULL ORDER BY idx', [send.id])).map((r) => r.idx);
    }
    const tr2 = await store.one(ctx.gc, 'SELECT status FROM transfers WHERE id = ?', [tr.id]);
    const d2 = await store.one(ctx.gc, 'SELECT * FROM deliveries WHERE id = ?', [delivery.id]);
    return { transfer: { id: tr.id, status: tr2.status, side }, delivery: d2, fallback: way, ...(missing ? { missing } : {}) };
  });
  if (job) await runJobs(ctx.gc, [job], ctx.senderName);
  if (job) out.delivery = await store.one(ctx.gc, 'SELECT * FROM deliveries WHERE id = ?', [out.delivery.id]);
  return out;
}

/** Background: open transfers past their ticket's 10 minutes → expired, the server way for their deliveries → count. */
async function expire(gc, now, nameOf) {
  const rows = await store.all(gc, "SELECT * FROM transfers WHERE status = 'open' AND expires_at <= ? LIMIT 200", [now]);
  for (const r of rows) {
    let job = null;
    let send = null;
    await store.tx(gc, async () => {
      const cur = await store.one(gc, 'SELECT status FROM transfers WHERE id = ?', [r.id]);
      if (!cur || cur.status !== 'open') return;
      await store.run(gc, "UPDATE transfers SET status = 'expired', done_at = ? WHERE id = ?", [now, r.id]);
      send = await store.one(gc, 'SELECT * FROM sends WHERE id = ?', [r.send_id]);
      const delivery = await store.one(gc, 'SELECT * FROM deliveries WHERE id = ?', [r.delivery_id]);
      if (send && delivery && delivery.status === 'direct') job = (await fallback(gc, send, delivery, now)).job;
    });
    if (job) await runJobs(gc, [job], await nameOf(send.user_id));
  }
  return rows.length;
}

const isDevice = (v) => typeof v === 'string' && DEVICE_RE.test(v);

module.exports = { create, get, result, expire, fallback, runJobs, directOut, rowOf, isDevice, TICKET_MS };
