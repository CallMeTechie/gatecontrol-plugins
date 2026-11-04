'use strict';

// Background (permissions.background, every 60 s):
//   * direct transfers whose ticket expired (10 min) without a result → the server way (transfers.expire);
//   * retention: once a send's expires_at passed its files are deleted from GateControl's media (gc.media.delete), waiting
//     deliveries become expired; the rows (history) stay 30 days, then go. expires_at follows the administrator's
//     setting since 1.5.0 (retention.js: after the pick-up / not picked up, default 7 days after sending as before);
//     a send an administrator removed (admin.js) expires at once;
//   * presence older than a day;
//   * since 1.4.1: deliveries waiting for GateControl's virus check (a missed hook mediaScanned) tried again every
//     5 minutes, failed with scan_pending 24 hours after the send (retry.js).

const store = require('./store');
const transfers = require('./transfers');
const presence = require('./presence');
const people = require('./people');
const retry = require('./retry');

const ROWS_MS = 30 * 86400000;
const BATCH = 100;
const state = { ticking: false };

async function purgeFiles(gc, now) {
  const due = await store.all(gc, 'SELECT * FROM sends WHERE purged = 0 AND expires_at <= ? ORDER BY expires_at LIMIT ?', [now, BATCH]);
  for (const s of due) {
    const items = await store.all(gc, 'SELECT media_id FROM items WHERE send_id = ? AND media_id IS NOT NULL', [s.id]);
    for (const i of items) {
      try { await gc.media.delete(i.media_id); } catch (e) { gc.log.warn('media delete failed', (e && e.code) || 'error'); }
    }
    await store.tx(gc, async () => {
      await store.run(gc, 'UPDATE items SET media_id = NULL WHERE send_id = ?', [s.id]);
      await store.run(gc, "UPDATE deliveries SET status = 'expired', at = ? WHERE send_id = ? AND status IN ('pending', 'direct')", [now, s.id]);
      await store.run(gc, "UPDATE deliveries SET status = 'expired', at = ? WHERE send_id = ? AND kind = 'link' AND status = 'delivered'", [now, s.id]);
      await store.run(gc, "UPDATE transfers SET status = 'expired', key = NULL, ticket = NULL, done_at = ? WHERE send_id = ? AND status = 'open'", [now, s.id]);
      await store.run(gc, 'UPDATE sends SET purged = 1 WHERE id = ?', [s.id]);
    });
  }
  return due.length;
}

async function purgeRows(gc, now) {
  const old = await store.all(gc, 'SELECT id FROM sends WHERE purged = 1 AND created_at <= ? LIMIT ?', [now - ROWS_MS, BATCH]);
  if (!old.length) return 0;
  await store.tx(gc, async () => {
    for (const s of old) {
      await store.run(gc, 'DELETE FROM pickups WHERE delivery_id IN (SELECT id FROM deliveries WHERE send_id = ?)', [s.id]);
      for (const tbl of ['items', 'deliveries', 'transfers', 'links']) await store.run(gc, `DELETE FROM ${tbl} WHERE send_id = ?`, [s.id]);
      await store.run(gc, 'DELETE FROM sends WHERE id = ?', [s.id]);
    }
  });
  return old.length;
}

async function tick(gc, now = Date.now()) {
  if (state.ticking) return null;
  state.ticking = true;
  try {
    const names = await people.users(gc);
    const out = {
      transfers: await transfers.expire(gc, now, async (uid) => (names.get(uid) || {}).name || null),
      purged: await purgeFiles(gc, now),
      removed: await purgeRows(gc, now),
      presence: await presence.cleanup(gc, now),
      scanRetried: await retry.due(gc, now),
    };
    return out;
  } finally { state.ticking = false; }
}

module.exports = { tick, purgeFiles, purgeRows, ROWS_MS, state };
