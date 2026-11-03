'use strict';

// Deliveries that wait for GateControl's virus check (since 1.4.1): a hand-over to the Messenger, the NAS or Drive that
// only the running check holds back stays 'pending' with error 'scan_pending' (deliver.js) instead of failing.
//   hook mediaScanned   the result is in → the waiting deliveries of that file's sends are tried again (after the answer,
//                       bg.js): clean (or only marked) → delivered; quarantined, not checkable and blocked, deleted →
//                       failed with quarantined / scan_blocked (NAS and Drive save the other files);
//   background          a missed result: waiting deliveries are tried again every 5 minutes; 24 hours after the send
//                       they fail with scan_pending.

const store = require('./store');
const people = require('./people');
const deliver = require('./deliver');
const bg = require('./bg');

const RETRY_MS = 5 * 60000;
const MAX_MS = 24 * 3600000;
const BATCH = 20;

const failed = (error) => ({ status: 'failed', via: null, error, ref: null });

/** The NAS drop folder of a delivery's target path (the drop folder's path, or a folder below it) → its id or null. */
async function folderOf(gc, target, now) {
  let best = null;
  for (const f of await people.folders(gc, now)) {
    const base = f.path.replace(/\/+$/, '');
    if ((target === base || target.startsWith(base + '/')) && (!best || base.length > best.base.length)) best = { id: f.id, base };
  }
  return best ? best.id : null;
}

/** One waiting delivery tried again (it is still waiting) → its new status, or null. */
async function run(gc, id, now = Date.now()) {
  const d = await store.one(gc, "SELECT * FROM deliveries WHERE id = ? AND status = 'pending' AND error = ?", [id, deliver.SCAN_WAIT]);
  if (!d) return null;
  const send = await store.one(gc, 'SELECT * FROM sends WHERE id = ?', [d.send_id]);
  if (!send || send.purged) return null;
  // taken now: the background does not try it again within 5 minutes
  await store.run(gc, 'UPDATE deliveries SET at = ? WHERE id = ?', [now, id]);
  let st;
  if (now - send.created_at >= MAX_MS) st = failed(deliver.SCAN_WAIT);
  else {
    const users = await people.users(gc);
    const sender = users.get(send.user_id);
    const items = await store.all(gc, 'SELECT * FROM items WHERE send_id = ? ORDER BY idx', [send.id]);
    const ctx = { gc, viewer: send.user_id, user: sender || { id: send.user_id, name: null }, lang: await people.langOf(gc, send.user_id), now, users };
    if (!sender) st = failed('unavailable');
    else if (d.kind === 'person') st = await deliver.person(ctx, send, items, d, sender.name);
    else if (d.kind === 'drive') st = await deliver.drive(ctx, send, items, d);
    else if (d.kind === 'nas') {
      const folderId = await folderOf(gc, d.target, now);
      st = folderId ? await deliver.nas(ctx, send, items, d, folderId) : failed('not_found');
    } else st = failed('failed');
  }
  await store.run(gc, 'UPDATE deliveries SET status = ?, via = ?, error = ?, ref = ?, at = ?, handed = ?, gd_items = ?' + (st.label ? ', label = ?' : '') + ' WHERE id = ?',
    [st.status, st.via || null, st.error || null, st.ref || null, Date.now(), st.handed || 0, st.gd_items || 0, ...(st.label ? [st.label] : []), id]);
  return st.status;
}

/** The result for `mediaId` is in (hook mediaScanned): its sends' waiting deliveries are tried again after the answer. */
async function scanned(gc, mediaId) {
  const rows = await store.all(gc, "SELECT d.id FROM deliveries d JOIN items i ON i.send_id = d.send_id WHERE i.media_id = ? AND d.status = 'pending' AND d.error = ? ORDER BY d.id",
    [mediaId, deliver.SCAN_WAIT]);
  if (!rows.length) return 0;
  bg.queue(async () => { for (const r of rows) await run(gc, r.id); }, gc);
  return rows.length;
}

/** Background: waiting deliveries not tried for 5 minutes (a missed hook) — the oldest first. → how many were tried */
async function due(gc, now) {
  const rows = await store.all(gc, "SELECT d.id FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE d.status = 'pending' AND d.error = ? AND s.purged = 0 AND d.at <= ? ORDER BY d.at LIMIT ?",
    [deliver.SCAN_WAIT, now - RETRY_MS, BATCH]);
  if (!rows.length) return 0;
  await bg.queue(async () => { for (const r of rows) await run(gc, r.id, now); }, gc);
  return rows.length;
}

module.exports = { run, scanned, due, folderOf, RETRY_MS, MAX_MS };
