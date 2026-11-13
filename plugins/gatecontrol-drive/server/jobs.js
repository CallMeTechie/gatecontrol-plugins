'use strict';

// The background run (permissions.background, every minute since 1.8.0 — the housekeeping below every 5 minutes; meta
// housekeeping_at keeps its time over a restart, written at most once an hour since 1.29.1):
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
// Every run (since 1.8.0): AI for documents works off its queue (insights.js), the reminders of deadlines whose time came
// go out (deadlines.js), the imports from cloud drives go on (imports.js) — the last two as their person (o.asPerson);
// since 1.14.0 new deadlines of an area with deadlinesToCalendar go into the family calendar as their person too.
// Every run (since 1.11.0): a vault folder outside the top folder of its area goes there (vault.js toRoots).
// Every run (since 1.12.0): jobs of several at once a restart interrupted go on, copies nobody brings bytes for end, old
// jobs go (ops.js).
// Every 15 minutes, the next minute after a change (since 1.20.0): the offers to GateControl's home cache (homecache.js).

const store = require('./store');
const scan = require('./scan');
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
const insights = require('./insights');
const deadlines = require('./deadlines');
const imports = require('./imports');
const vault = require('./vault');
const ops = require('./ops');
const homecache = require('./homecache');

const DAY = 86400000;
const BATCH = 200;
const HOUSEKEEPING_MS = 290000;
// how often the time of the housekeeping is written down for the next start of the plugin (1.29.1)
const HOUSEKEEPING_NOTE_MS = 3600000;
let running = false;
// per GateControl handle { last: the last housekeeping, noted: what meta housekeeping_at says }
const kept = new WeakMap();

const within = (at, now, ms) => Number.isFinite(at) && now >= at && now - at < ms;

/**
 * Is the housekeeping due (5 minutes after the last one; a clock set back counts as due)? Notes this run — in this
 * process; in the database (meta housekeeping_at, read at the start of the plugin) at most once an hour since 1.29.1:
 * the note was a write every 5 minutes, day and night, and on a slow disk the plugin's most frequent slow statement.
 * A restart of the plugin within that hour runs the housekeeping once more at once — it never runs less often.
 */
async function housekeepingDue(gc, now) {
  let k = kept.get(gc);
  if (!k) {
    const r = await store.one(gc, "SELECT value FROM meta WHERE key = 'housekeeping_at'");
    const last = r ? Number(r.value) : NaN;
    kept.set(gc, k = { last, noted: last });
  }
  if (within(k.last, now, HOUSEKEEPING_MS)) return false;
  k.last = now;
  if (!within(k.noted, now, HOUSEKEEPING_NOTE_MS)) {
    await store.run(gc, "INSERT INTO meta (key, value) VALUES ('housekeeping_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(now)]);
    k.noted = now;
  }
  return true;
}

async function tick(gc, now = Date.now(), o = {}) {
  if (running) return { skipped: true };
  running = true;
  try {
    const settings = await areas.settingsOf(gc);
    const out = (await housekeepingDue(gc, now)) ? await housekeeping(gc, settings, now) : { housekeeping: false };
    try {
      const touched = await vault.toRoots(gc, now);
      if (touched.size) await changes.announce(gc, touched, settings);
    } catch (e) { gc.log.warn('vaults to the top folder failed', (e && e.code) || 'error'); }
    try { out.insights = await insights.tick(gc, settings, now, o.asPerson); } catch (e) { gc.log.warn('document recognition failed', (e && e.code) || 'error'); }
    try { out.reminders = await deadlines.due(gc, settings, now, o.asPerson); } catch (e) { gc.log.warn('deadline reminders failed', (e && e.code) || 'error'); }
    try { out.imports = await imports.tick(gc, settings, now, o.asPerson); } catch (e) { gc.log.warn('imports failed', (e && e.code) || 'error'); }
    try { out.ops = await ops.tick(gc, now, o.ops); } catch (e) { gc.log.warn('jobs failed', (e && e.code) || 'error'); }
    // the home cache of the gateways (1.20.0, homecache.js — every 15 minutes or after a change; never throws)
    out.homeCache = await homecache.tick(gc, now, settings);
    return out;
  } finally {
    running = false;
  }
}

/** The housekeeping (every 5 minutes). */
async function housekeeping(gc, settings, now) {
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
  // the virus scan (since 1.19.0): files still being checked asked again, rows of files that are gone forgotten
  try { await scan.housekeeping(gc, ctx); } catch (e) { gc.log.warn('scan housekeeping failed', (e && e.code) || 'error'); }
  await changes.announce(gc, ctx.touched, settings);
  return { purged, versions: old.length, synced, wipesExpired: wiped.expired, wipesDropped: wiped.dropped, markedTrashed: marked.trashed, incidentsRemoved: incidents };
}

module.exports = { tick, HOUSEKEEPING_NOTE_MS };
