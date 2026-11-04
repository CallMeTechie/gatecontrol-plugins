'use strict';

// Direct transfers in the home network (contract C, protocol v1). The plugin only brokers them: a transfer
// per receiving device with a one-time ticket (10 minutes) and a key (32 random bytes, AES-256-GCM in 1 MiB
// blocks, nonce = first 4 bytes of SHA-256(transferId) ‖ 8-byte block counter) — the bytes never pass the
// server. The listener accepts a transfer only with a ticket it learnt from the plugin (silent push or
// GET transfers/<id>); both ends report POST transfers/<id>/result { ok, bytes?, error? }.
//   ok              → the delivery is delivered via direct
//   (done, failed or expired: key and ticket are removed from the database)
// Since 1.5.0 the receiving end decides: its ok with `bytes` below the files' size is no success ('incomplete' →
// the server way, also after the other end's ok), its ok with every byte (or without bytes, older apps) is the
// pick-up (deliveries.picked_at). The sender's ok alone makes the delivery 'delivered' (as before) but not picked up;
// a failure reported after it by either end still takes the server way while the receiver has not confirmed.
//   failed/expired  → the server way: all files on the server → a push to the device (delivered via server);
//                     files still local → the delivery waits (pending, error direct_failed) and the sender is
//                     told { fallback: 'upload' }: it uploads them and calls POST sends/<id>/items.

const crypto = require('node:crypto');
const store = require('./store');
const deliver = require('./deliver');
const retention = require('./retention');
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
  if (!send || !delivery) throw fail('not_found');
  // the sender's device, or the receiving device of its owner (oneself, or another person whose device is open)
  let side = null;
  if (ctx.deviceId === tr.to_device && (delivery.user_id || send.user_id) === ctx.viewer) side = 'receiver';
  else if (ctx.deviceId === tr.from_device && send.user_id === ctx.viewer) side = 'sender';
  if (!side) throw fail('not_found');
  return { tr, side, send, delivery };
}

/** What the other end of the transfer reported (POST …/result) → { ok, error } or null (nothing yet). */
function peerOf(tr, side) {
  const r = parseJson(side === 'sender' ? tr.receiver_result : tr.sender_result, null);
  if (!r || typeof r !== 'object' || typeof r.ok !== 'boolean') return null;
  return { ok: r.ok, error: r.ok ? null : (typeof r.error === 'string' && ERROR_RE.test(r.error) ? r.error : 'failed') };
}

/**
 * GET transfers/<id> (either end) → the transfer; the ticket and key only while it is open. `peer` (1.2.1): what the
 * other end reported — a device that waits for it (the sender offering for pull, the receiver waiting for a push)
 * polls this and takes the server way as soon as the other end gave up, instead of waiting for its own timeout.
 */
async function get(ctx, id) {
  const { tr, side, send } = await locate(ctx, id);
  const items = await store.all(ctx.gc, 'SELECT idx, name, mime, bytes FROM items WHERE send_id = ? ORDER BY idx', [send.id]);
  const open = tr.status === 'open' && tr.expires_at > ctx.now;
  return {
    id: tr.id, sendId: send.id, side, mode: tr.mode, status: open ? 'open' : (tr.status === 'open' ? 'expired' : tr.status),
    fromDevice: tr.from_device, toDevice: tr.to_device,
    from: { userId: send.user_id, name: ctx.users && ctx.users.get(send.user_id) ? ctx.users.get(send.user_id).name : null, deviceId: send.device_id, deviceName: send.device_name || null, own: send.user_id === ctx.viewer },
    candidates: tr.candidates, key: open ? tr.key : null, ticket: open ? tr.ticket : null, expiresAt: iso(tr.expires_at),
    peer: peerOf(tr, side),
    items: items.map((i) => ({ index: i.idx, name: i.name, bytes: i.bytes, mime: i.mime || null })),
  };
}

/**
 * The server way for a device delivery whose direct transfer did not work → 'server' (pushed) or 'upload' (files missing).
 * `senderName` for the push. Runs inside a transaction (the push after it: returned as a job).
 */
async function fallback(gc, send, delivery, now) {
  const items = await store.all(gc, 'SELECT * FROM items WHERE send_id = ? ORDER BY idx', [send.id]);
  if (send.purged || send.removed_at) {
    await store.run(gc, "UPDATE deliveries SET status = 'expired', error = ?, at = ? WHERE id = ?", [send.removed_at ? 'removed' : delivery.error, now, delivery.id]);
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

/** The size of a send's files (what a receiver's `bytes` must reach). */
async function sizeOf(gc, sendId) {
  const r = await store.one(gc, 'SELECT COALESCE(SUM(bytes), 0) AS n FROM items WHERE send_id = ?', [sendId]);
  return r ? Number(r.n) || 0 : 0;
}

/** POST transfers/<id>/result { ok, bytes?, error? } → { transfer, delivery, fallback, missing? } */
async function result(ctx, id, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b || typeof b.ok !== 'boolean') throw fail('invalid');
  if (b.bytes != null && !(Number.isSafeInteger(b.bytes) && b.bytes >= 0)) throw fail('invalid');
  if (b.error != null && !(typeof b.error === 'string' && ERROR_RE.test(b.error))) throw fail('invalid');
  let job = null;
  let sendId = null;
  const out = await store.tx(ctx.gc, async () => {
    const { tr, side, send, delivery } = await locate(ctx, id);
    sendId = send.id;
    // the receiver's ok with fewer bytes than the files have: not everything arrived (since 1.5.0) — a failure
    let ok = b.ok;
    let error = b.ok ? null : (b.error || 'failed');
    if (ok && side === 'receiver' && b.bytes != null && b.bytes < await sizeOf(ctx.gc, send.id)) { ok = false; error = 'incomplete'; }
    const res = JSON.stringify({ ok, bytes: b.bytes == null ? null : b.bytes, error, at: ctx.now });
    await store.run(ctx.gc, `UPDATE transfers SET ${side === 'sender' ? 'sender_result' : 'receiver_result'} = ? WHERE id = ?`, [res, tr.id]);
    let way = null;
    let missing;
    // picked up (the receiving device confirmed), opened, or already on the server way: nothing changes the way any more
    const confirmed = delivery.picked_at != null || delivery.status === 'opened';
    const directNow = delivery.status === 'direct' || (delivery.status === 'delivered' && delivery.via === 'direct');
    if (ok) {
      if (tr.status !== 'done') await store.run(ctx.gc, "UPDATE transfers SET status = 'done', key = NULL, ticket = NULL, done_at = ? WHERE id = ?", [ctx.now, tr.id]);
      // the sender's ok does not undo the server way the receiver's failure started
      const recvFailed = side === 'sender' && peerOf(tr, 'sender') && !peerOf(tr, 'sender').ok;
      if ((delivery.status === 'direct' || delivery.status === 'pending') && !recvFailed) {
        await store.run(ctx.gc, "UPDATE deliveries SET status = 'delivered', via = 'direct', error = NULL, at = ? WHERE id = ?", [ctx.now, delivery.id]);
      }
      // the receiving device has every file: the pick-up
      if (side === 'receiver' && !confirmed && !send.removed_at) await store.run(ctx.gc, 'UPDATE deliveries SET picked_at = ? WHERE id = ? AND picked_at IS NULL', [ctx.now, delivery.id]);
    } else if (!confirmed && directNow) {
      if (tr.status === 'open' || tr.status === 'done') await store.run(ctx.gc, "UPDATE transfers SET status = 'failed', key = NULL, ticket = NULL, done_at = ? WHERE id = ?", [ctx.now, tr.id]);
      const f = await fallback(ctx.gc, send, delivery, ctx.now);
      way = f.way;
      job = f.job;
      missing = f.missing;
    } else if (tr.status === 'open') {
      await store.run(ctx.gc, "UPDATE transfers SET status = 'failed', key = NULL, ticket = NULL, done_at = ? WHERE id = ?", [ctx.now, tr.id]);
    }
    if (!ok && delivery.status === 'pending' && delivery.error === 'direct_failed') {
      way = 'upload';
      missing = (await store.all(ctx.gc, 'SELECT idx FROM items WHERE send_id = ? AND media_id IS NULL ORDER BY idx', [send.id])).map((r) => r.idx);
    }
    const tr2 = await store.one(ctx.gc, 'SELECT status FROM transfers WHERE id = ?', [tr.id]);
    const d2 = await store.one(ctx.gc, 'SELECT * FROM deliveries WHERE id = ?', [delivery.id]);
    return { transfer: { id: tr.id, status: tr2.status, side }, delivery: d2, fallback: way, ...(missing ? { missing } : {}) };
  });
  if (job) await runJobs(ctx.gc, [job], ctx.senderName);
  if (job) out.delivery = await store.one(ctx.gc, 'SELECT * FROM deliveries WHERE id = ?', [out.delivery.id]);
  await retention.touch(ctx.gc, sendId);
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
      await store.run(gc, "UPDATE transfers SET status = 'expired', key = NULL, ticket = NULL, done_at = ? WHERE id = ?", [now, r.id]);
      send = await store.one(gc, 'SELECT * FROM sends WHERE id = ?', [r.send_id]);
      const delivery = await store.one(gc, 'SELECT * FROM deliveries WHERE id = ?', [r.delivery_id]);
      if (send && delivery && delivery.status === 'direct') job = (await fallback(gc, send, delivery, now)).job;
    });
    if (job) await runJobs(gc, [job], await nameOf(send.user_id));
    if (send) await retention.touch(gc, send.id);
  }
  return rows.length;
}

const isDevice = (v) => typeof v === 'string' && DEVICE_RE.test(v);

module.exports = { create, get, result, expire, fallback, runJobs, directOut, rowOf, isDevice, TICKET_MS };
