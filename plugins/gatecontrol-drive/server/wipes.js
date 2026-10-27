'use strict';

// "Löschen auf allen Geräten" (since 1.2.0). DELETE nodes/<id>?everywhere=1 puts the node into the trash like a plain
// delete and leaves a wipe for the person who deleted it: one entry per file (a folder: every live file below it,
// at most WIPE_FILES) — { nodeId, name, sha256, size, mime } — that each device of that person removes its local copy
// of (the original the photo backup left in the gallery, a downloaded or synced copy) when it is next online.
//
// Devices: every app request carries the asking device (user.device = the id of its device token; GateControl passes
// it only with permissions.devices). Drive records it per person with when it was last seen (table devices). The
// targets of a wipe are the person's devices seen in the last DEVICE_DAYS days when it is made (the deleting device
// too — it confirms like the others); each target gets a pending row per entry. A device reads its entries
// (GET wipes), removes its copies and confirms them (POST wipes/done { ids }); an entry every target confirmed goes,
// a wipe without entries goes. The live event 'wipes' tells the person's apps at once; GET me has the device's count.
//
// Restoring the node from the trash cancels its wipes (devices that already deleted their copy stay so); purging
// changes nothing. The background run removes wipes after EXPIRE_DAYS and the rows of devices GateControl no longer
// lists (their token was removed) once Drive has not seen them for GONE_DAYS.

const store = require('./store');
const { fail, posInt, iso } = require('./util');

const DAY = 86400000;
const DEVICE_DAYS = 180;
const EXPIRE_DAYS = 90;
const GONE_DAYS = 7;
const WIPE_FILES = 5000;
const LIST_MAX = 500;
const DONE_MAX = 1000;
const SEEN_EVERY_MS = 10 * 60000;
const CHUNK = 100;

/** An app request from `device` of `userId`: remember the device (a write at most every 10 minutes per device). */
async function seen(gc, userId, device, platform, now) {
  if (!device) return;
  const pf = typeof platform === 'string' && /^[a-z0-9]{1,16}$/.test(platform) ? platform : null;
  await store.run(gc, `INSERT INTO devices (user_id, device_id, platform, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id, device_id) DO UPDATE SET last_seen = excluded.last_seen, platform = COALESCE(excluded.platform, devices.platform)
    WHERE devices.last_seen <= excluded.last_seen - ?`, [userId, device, pf, now, now, SEEN_EVERY_MS]);
}

/** The person's devices that are targets of a new wipe (seen in the last DEVICE_DAYS days). */
async function deviceCount(gc, userId, now) {
  const r = await store.one(gc, 'SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND last_seen >= ?', [userId, now - DEVICE_DAYS * DAY]);
  return r ? r.n : 0;
}

/**
 * Inside nodes.trash's transaction: the wipe of `top` (just trashed) and `files` (its live file rows, `top` itself for
 * a file) for the viewer's devices → { id, devices, files } (id null: no device or no file, nothing to do).
 */
async function create(ctx, top, files) {
  const gc = ctx.gc;
  const since = ctx.now - DEVICE_DAYS * DAY;
  const devices = await deviceCount(gc, ctx.viewer, ctx.now);
  const list = files.filter((f) => f.is_dir === 0).sort((a, b) => a.id - b.id).slice(0, WIPE_FILES);
  if (!devices || !list.length) return { id: null, devices, files: list.length };
  const w = await store.run(gc, 'INSERT INTO wipes (user_id, trash_id, device, created_at) VALUES (?, ?, ?, ?)',
    [ctx.viewer, top.id, ctx.deviceId || null, ctx.now]);
  const id = Number(w.lastInsertRowid);
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    await store.run(gc, `INSERT INTO wipe_entries (wipe_id, node_id, name, sha256, size, mime) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
      part.flatMap((f) => [id, f.id, f.name, f.sha256 || null, f.size || 0, f.mime || null]));
  }
  await store.run(gc, `INSERT INTO wipe_pending (entry_id, device_id)
    SELECT e.id, d.device_id FROM wipe_entries e JOIN devices d ON d.user_id = ? AND d.last_seen >= ? WHERE e.wipe_id = ?`, [ctx.viewer, since, id]);
  ctx.wiped = { id, files: list.length };
  return { id, devices, files: list.length };
}

/** Entries without pending rows and wipes without entries go (`wipeIds`: only these wipes; null: all). */
async function tidy(gc, wipeIds) {
  if (wipeIds && !wipeIds.length) return;
  const only = wipeIds ? ` AND wipe_id IN (${store.marks(wipeIds.length)})` : '';
  await store.run(gc, `DELETE FROM wipe_entries WHERE NOT EXISTS (SELECT 1 FROM wipe_pending p WHERE p.entry_id = wipe_entries.id)${only}`, wipeIds || []);
  await store.run(gc, `DELETE FROM wipes WHERE NOT EXISTS (SELECT 1 FROM wipe_entries e WHERE e.wipe_id = wipes.id)${wipeIds ? ` AND id IN (${store.marks(wipeIds.length)})` : ''}`, wipeIds || []);
}

/** Remove wipes `ids` with their entries and pending rows. */
async function remove(gc, ids) {
  if (!ids.length) return;
  const m = store.marks(ids.length);
  await store.run(gc, `DELETE FROM wipe_pending WHERE entry_id IN (SELECT id FROM wipe_entries WHERE wipe_id IN (${m}))`, ids);
  await store.run(gc, `DELETE FROM wipe_entries WHERE wipe_id IN (${m})`, ids);
  await store.run(gc, `DELETE FROM wipes WHERE id IN (${m})`, ids);
}

/** Inside nodes.restore's transaction: the trashed node `trashId` came back — its wipes end. → wipes cancelled */
async function cancel(gc, trashId) {
  const ids = (await store.all(gc, 'SELECT id FROM wipes WHERE trash_id = ?', [trashId])).map((r) => r.id);
  await remove(gc, ids);
  return ids.length;
}

/** The entries device `device` of the viewer has yet to handle (count). */
async function pending(ctx) {
  if (!ctx.deviceId) return 0;
  const r = await store.one(ctx.gc, `SELECT COUNT(*) AS n FROM wipe_pending p JOIN wipe_entries e ON e.id = p.entry_id
    JOIN wipes w ON w.id = e.wipe_id WHERE p.device_id = ? AND w.user_id = ?`, [ctx.deviceId, ctx.viewer]);
  return r ? r.n : 0;
}

/** GET wipes → { wipes: [{ id, wipeId, nodeId, name, sha256, size, mime, createdAt }], more } (oldest first, ≤ 500). */
async function list(ctx) {
  if (!ctx.deviceId) return { wipes: [], more: false };
  const rows = await store.all(ctx.gc, `SELECT e.*, w.created_at FROM wipe_pending p JOIN wipe_entries e ON e.id = p.entry_id
    JOIN wipes w ON w.id = e.wipe_id WHERE p.device_id = ? AND w.user_id = ? ORDER BY e.id LIMIT ?`, [ctx.deviceId, ctx.viewer, LIST_MAX + 1]);
  return {
    wipes: rows.slice(0, LIST_MAX).map((r) => ({
      id: r.id, wipeId: r.wipe_id, nodeId: r.node_id, name: r.name, sha256: r.sha256 || null, size: r.size, mime: r.mime || null, createdAt: iso(r.created_at),
    })),
    more: rows.length > LIST_MAX,
  };
}

/** POST wipes/done { ids } — this device handled these entries (removed its copy or had none) → { done, wipes } */
async function done(ctx, body) {
  const raw = body && Array.isArray(body.ids) ? body.ids : null;
  if (!raw || raw.length > DONE_MAX) throw fail('invalid', { field: 'ids' });
  const ids = [...new Set(raw.map(posInt))];
  if (ids.some((x) => x == null)) throw fail('invalid', { field: 'ids' });
  if (!ctx.deviceId || !ids.length) return { done: 0, wipes: await pending(ctx) };
  const n = await store.tx(ctx.gc, async () => {
    const m = store.marks(ids.length);
    const mine = await store.all(ctx.gc, `SELECT DISTINCT e.wipe_id FROM wipe_entries e JOIN wipes w ON w.id = e.wipe_id
      WHERE e.id IN (${m}) AND w.user_id = ?`, [...ids, ctx.viewer]);
    if (!mine.length) return 0;
    const r = await store.run(ctx.gc, `DELETE FROM wipe_pending WHERE device_id = ? AND entry_id IN (${m})
      AND entry_id IN (SELECT e.id FROM wipe_entries e JOIN wipes w ON w.id = e.wipe_id WHERE w.user_id = ?)`, [ctx.deviceId, ...ids, ctx.viewer]);
    await tidy(ctx.gc, mine.map((x) => x.wipe_id));
    return (r && r.changes) || 0;
  });
  return { done: n, wipes: await pending(ctx) };
}

/** Background: wipes older than EXPIRE_DAYS go; devices GateControl no longer lists stop being waited for. */
async function housekeeping(gc, now) {
  const old = (await store.all(gc, 'SELECT id FROM wipes WHERE created_at < ? ORDER BY id LIMIT 1000', [now - EXPIRE_DAYS * DAY])).map((r) => r.id);
  if (old.length) await store.tx(gc, () => remove(gc, old));
  let dropped = 0;
  if (gc.devices && typeof gc.devices.list === 'function') {
    const users = await store.all(gc, `SELECT DISTINCT w.user_id FROM wipes w JOIN wipe_entries e ON e.wipe_id = w.id
      JOIN wipe_pending p ON p.entry_id = e.id`);
    for (const { user_id: uid } of users) {
      let listed;
      try { listed = await gc.devices.list({ userId: uid }); } catch { continue; } // unknown: wait (the wipe expires anyway)
      if (!Array.isArray(listed)) continue;
      const live = new Set(listed.map((d) => String(d && d.id)));
      const gone = (await store.all(gc, 'SELECT device_id FROM devices WHERE user_id = ? AND last_seen < ?', [uid, now - GONE_DAYS * DAY]))
        .map((r) => r.device_id).filter((d) => !live.has(d));
      if (!gone.length) continue;
      dropped += await store.tx(gc, async () => {
        const m = store.marks(gone.length);
        const r = await store.run(gc, `DELETE FROM wipe_pending WHERE device_id IN (${m})
          AND entry_id IN (SELECT e.id FROM wipe_entries e JOIN wipes w ON w.id = e.wipe_id WHERE w.user_id = ?)`, [...gone, uid]);
        await store.run(gc, `DELETE FROM devices WHERE user_id = ? AND device_id IN (${m})`, [uid, ...gone]);
        await tidy(gc, null);
        return (r && r.changes) || 0;
      });
    }
  }
  // devices not seen for a long time are no targets any more; their rows go
  await store.run(gc, 'DELETE FROM devices WHERE last_seen < ? AND device_id NOT IN (SELECT device_id FROM wipe_pending)', [now - DEVICE_DAYS * DAY]);
  return { expired: old.length, dropped };
}

/** After the answer: the live event 'wipes' to the person's apps (they fetch GET wipes). */
async function nudge(gc, ctx) {
  if (!ctx.wiped || typeof (gc.events && gc.events.emit) !== 'function') return;
  await gc.events.emit({ users: [ctx.viewer], type: 'wipes', data: { wipe: ctx.wiped.id, files: ctx.wiped.files } });
}

module.exports = { seen, deviceCount, create, cancel, pending, list, done, housekeeping, nudge, DEVICE_DAYS, EXPIRE_DAYS, WIPE_FILES, LIST_MAX, DONE_MAX };
