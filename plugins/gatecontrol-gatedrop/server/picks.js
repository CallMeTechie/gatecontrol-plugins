'use strict';

// Pick-ups (since 1.5.0, deliveries.picked_at, table pickups): only a real confirmation counts — 'delivered' alone (a push
// went out, the device was online) is "provided", not picked up.
//   device   the target device itself calls POST sends/<id>/opened (its receipt once everything is saved), or reports
//            POST transfers/<id>/result { ok: true } with every byte as the receiving end of a direct transfer
//   person   the person calls POST sends/<id>/opened (portal: the download, apps: received); 'family': every member
//            at sending did
//   nas, drive  saved by the Synology / Drive plugin (status 'delivered')
//   person via the Messenger  the message carries every file (gd_items 0): the Messenger has its own copies
//   link     never (a link keeps its own time; retention.js)

const store = require('./store');
const deliver = require('./deliver');

/** Does this new delivery state confirm the pick-up right away (a NAS / Drive save, a chat message with every file)? */
function onSave(kind, st) {
  if (!st || st.status !== 'delivered') return false;
  if (kind === 'nas' || kind === 'drive') return true;
  return kind === 'person' && typeof st.ref === 'string' && st.ref.startsWith('chat:') && !st.gd_items;
}

/** The pick-up of a device delivery (its target device confirmed). */
async function device(gc, deliveryId, now) {
  await store.run(gc, 'UPDATE deliveries SET picked_at = ? WHERE id = ? AND picked_at IS NULL', [now, deliveryId]);
}

/**
 * A person opened their person / 'family' delivery `d` → picked once every recipient did (a family: each member at
 * sending, as stored in `members`).
 */
async function person(gc, d, userId, now) {
  await store.run(gc, 'INSERT OR IGNORE INTO pickups (delivery_id, user_id, at) VALUES (?, ?, ?)', [d.id, userId, now]);
  if (d.picked_at != null) return;
  const want = d.target === 'family' ? deliver.membersOf(d) : [d.user_id];
  const have = new Set((await store.all(gc, 'SELECT user_id FROM pickups WHERE delivery_id = ?', [d.id])).map((r) => r.user_id));
  if (want.length && want.every((u) => have.has(u))) await store.run(gc, 'UPDATE deliveries SET picked_at = ? WHERE id = ? AND picked_at IS NULL', [now, d.id]);
}

module.exports = { onSave, device, person };
