'use strict';

// The background run (permissions.background, every 5 minutes):
//   * the trash: what was deleted more than trash_days ago goes for good (files and their versions);
//   * versions older than versions_days go;
//   * the NAS journals are read (in case a call of the hook mediaChanged was missed);
//   * the notes "… hat deinen Ordner angesehen" older than a week are forgotten;
//   * "delete on all devices": wipes older than 90 days go, devices GateControl no longer lists stop being waited for
//     (wipes.js, since 1.2.0);
//   * marked nodes ("deleted on the device, goes on …") whose time came go into the trash (marks.js, since 1.5.0);
//   * the ransomware protection's journal is kept short, closed incidents go after 30 days (guard.js, since 1.6.0) —
//     a version an incident may still bring back is not removed for its age;
//   * the public address for direct links is looked up when Drive does not know it yet (address.js, since 1.6.0);
//   * a version a time travel made stays until its hold ends (timetravel.js, since 1.7.0).

const store = require('./store');
const nodes = require('./nodes');
const areas = require('./areas');
const sync = require('./sync');
const changes = require('./changes');
const links = require('./links');
const backup = require('./backup');
const wipes = require('./wipes');
const marks = require('./marks');
const guard = require('./guard');
const address = require('./address');

const DAY = 86400000;
const BATCH = 200;
let running = false;

async function tick(gc, now = Date.now()) {
  if (running) return { skipped: true };
  running = true;
  try {
    const settings = await areas.settingsOf(gc);
    const ctx = { viewer: null, deviceId: null, now, touched: new Set() };
    // marked nodes first (what goes into the trash now is purged after trash_days like any other)
    let marked = { trashed: 0, touched: new Set() };
    try { marked = await marks.due(gc, now); } catch (e) { gc.log.warn('marked deletes failed', (e && e.code) || 'error'); }
    for (const id of marked.touched) ctx.touched.add(id);
    let purged = 0;
    const due = await store.all(gc, 'SELECT id FROM nodes WHERE trash_id = id AND deleted_at < ? ORDER BY deleted_at LIMIT ?', [now - settings.trashDays * DAY, BATCH]);
    for (const d of due) purged += await store.tx(gc, () => nodes.purgeBatch(gc, d.id, ctx));
    const old = await store.all(gc, `SELECT * FROM versions WHERE at < ? AND (hold_until IS NULL OR hold_until < ?) AND id NOT IN (SELECT l.version_id FROM guard_log l JOIN guard_incidents i ON i.id = l.incident_id
      WHERE l.version_id IS NOT NULL AND i.state <> 'undone')
      ORDER BY at LIMIT ?`, [now - settings.versionsDays * DAY, now, BATCH]);
    for (const v of old) {
      if (v.media_id) { try { await gc.media.delete(v.media_id); } catch (e) { gc.log.warn('version delete failed', (e && e.code) || 'error'); } }
      await store.run(gc, 'DELETE FROM versions WHERE id = ?', [v.id]);
    }
    let synced = 0;
    for (const a of await store.all(gc, 'SELECT media_area FROM areas')) {
      try {
        const r = await sync.area(gc, a.media_area, now);
        synced += r.applied;
        for (const id of r.touched) ctx.touched.add(id);
      } catch (e) { gc.log.warn('nas journal failed', (e && e.code) || 'error'); }
    }
    // uploads through links the hook did not bring; rows of links GateControl has forgotten
    try { for (const id of await links.catchUp(gc, now)) ctx.touched.add(id); } catch (e) { gc.log.warn('link uploads failed', (e && e.code) || 'error'); }
    try { await links.forget(gc); } catch (e) { gc.log.warn('link rows failed', (e && e.code) || 'error'); }
    try { await backup.weekly(gc, settings.backupHint, now); } catch (e) { gc.log.warn('backup hint failed', (e && e.code) || 'error'); }
    let wiped = { expired: 0, dropped: 0 };
    try { wiped = await wipes.housekeeping(gc, now); } catch (e) { gc.log.warn('wipes failed', (e && e.code) || 'error'); }
    await store.run(gc, 'DELETE FROM child_views WHERE day < ?', [new Date(now - 7 * DAY).toISOString().slice(0, 10)]);
    let incidents = 0;
    try { incidents = await guard.housekeeping(gc, settings, now); } catch (e) { gc.log.warn('guard housekeeping failed', (e && e.code) || 'error'); }
    try { await address.origin(gc, settings, now); } catch (e) { gc.log.warn('address failed', (e && e.code) || 'error'); }
    await changes.announce(gc, ctx.touched, settings);
    return { purged, versions: old.length, synced, wipesExpired: wiped.expired, wipesDropped: wiped.dropped, markedTrashed: marked.trashed, incidentsRemoved: incidents };
  } finally {
    running = false;
  }
}

module.exports = { tick };
