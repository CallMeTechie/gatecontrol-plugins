'use strict';

// The background run (permissions.background, every 5 minutes):
//   * the trash: what was deleted more than trash_days ago goes for good (files and their versions);
//   * versions older than versions_days go;
//   * the NAS journals are read (in case a call of the hook mediaChanged was missed);
//   * the notes "… hat deinen Ordner angesehen" older than a week are forgotten.

const store = require('./store');
const nodes = require('./nodes');
const areas = require('./areas');
const sync = require('./sync');
const changes = require('./changes');

const DAY = 86400000;
const BATCH = 200;
let running = false;

async function tick(gc, now = Date.now()) {
  if (running) return { skipped: true };
  running = true;
  try {
    const settings = await areas.settingsOf(gc);
    const ctx = { viewer: null, deviceId: null, now, touched: new Set() };
    let purged = 0;
    const due = await store.all(gc, 'SELECT id FROM nodes WHERE trash_id = id AND deleted_at < ? ORDER BY deleted_at LIMIT ?', [now - settings.trashDays * DAY, BATCH]);
    for (const d of due) purged += await store.tx(gc, () => nodes.purgeBatch(gc, d.id, ctx));
    const old = await store.all(gc, 'SELECT * FROM versions WHERE at < ? ORDER BY at LIMIT ?', [now - settings.versionsDays * DAY, BATCH]);
    for (const v of old) {
      try { await gc.media.delete(v.media_id); } catch (e) { gc.log.warn('version delete failed', (e && e.code) || 'error'); }
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
    await store.run(gc, 'DELETE FROM child_views WHERE day < ?', [new Date(now - 7 * DAY).toISOString().slice(0, 10)]);
    await changes.announce(gc, ctx.touched, settings);
    return { purged, versions: old.length, synced };
  } finally {
    running = false;
  }
}

module.exports = { tick };
