'use strict';

// Printing for a person: rights (print at all, black and white only, pages
// per day — server-side, before every gc.print.submit), the history (the
// host's jobs mirrored into `jobs`), "Druck fertig / fehlgeschlagen".

const store = require('./store');
const rights = require('./rights');
const { fail, fromHost, clip, iso, dayStart } = require('./util');

const OPEN = ['queued', 'sending', 'printing', 'waiting'];
const COUNTED = ['queued', 'sending', 'printing', 'waiting', 'done'];
const state = { since: 0 };

function reset() { state.since = 0; }

/** Pages printed (or on the way) today by a person (pages × copies). */
async function pagesToday(gc, userId, now = Date.now()) {
  const r = await store.one(gc, `SELECT COALESCE(SUM(pages * copies), 0) AS n FROM jobs WHERE user_id = ? AND created_at >= ? AND state IN (${store.marks(COUNTED.length)})`,
    [userId, dayStart(now), ...COUNTED]);
  return (r && r.n) || 0;
}

/** What a person may still print today: null = no limit */
async function left(gc, user, r, now = Date.now()) {
  if (!r.pagesPerDay) return null;
  return Math.max(0, r.pagesPerDay - await pagesToday(gc, user.id, now));
}

async function deviceOf(gc, deviceId, kind) {
  const list = (await gc.print.devices()) || [];
  const d = list.find((x) => x.id === deviceId);
  if (!d || !d[kind]) throw fail('not_found');
  return d;
}

async function insert(gc, job, d, via, now) {
  await store.run(gc, `INSERT OR REPLACE INTO jobs (id, user_id, device_id, device_name, name, pages, copies, color, duplex, media, source, via, state, error, message, notified, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  [job.id, job.user, d.id, clip(d.name, 120), clip(job.name, 200) || 'GateControl', job.pages || 1, job.copies || 1, job.color ? 1 : 0, job.duplex ? 1 : 0,
    job.media || null, job.source || null, via, job.state, job.error || null, job.message || null, now, now]);
}

const MEDIA_RE = /^[a-z0-9]+_[a-z0-9.-]+_[0-9.]+x[0-9.]+(mm|in)$/;
const SOURCE_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** Paper and tray of a print call: only what the printer names (GateControl ≥ 1.247.0, printer.media), else nothing. */
function mediaOf(b, p) {
  const m = (p && p.media) || { sizes: [], sources: [] };
  const out = {};
  if (b.media != null && b.media !== '') {
    if (typeof b.media !== 'string' || !MEDIA_RE.test(b.media) || !(m.sizes || []).includes(b.media)) throw fail('invalid', { field: 'media' });
    out.media = b.media;
  }
  if (b.source != null && b.source !== '') {
    if (typeof b.source !== 'string' || !SOURCE_RE.test(b.source) || !(m.sources || []).includes(b.source)) throw fail('invalid', { field: 'source' });
    out.source = b.source;
  }
  return out;
}

/**
 * Print a file of the plugin (the person's upload): POST print { deviceId, mediaId, copies, color, duplex, name,
 * media?, source? }. PDF files, pictures, plain text and — where the printer's gateway converts them — office files.
 * → { job, pagesLeft }
 */
async function print(gc, user, b, { via = 'portal', now = Date.now() } = {}) {
  const r = await rights.of(gc, user);
  if (!r.print) throw fail('no_right');
  if (typeof b.mediaId !== 'string' || typeof b.deviceId !== 'string') throw fail('invalid');
  const d = await deviceOf(gc, b.deviceId, 'printer');
  const copies = b.copies == null ? 1 : Number(b.copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > 99) throw fail('invalid', { field: 'copies' });
  const color = b.color === true && !r.bwOnly;
  const paper = mediaOf(b, d.printer);
  // the page limit: count before sending (PDF pages × copies; an office file: the pages it names, else 1 — the gateway
  // reports the real count after converting and the background takes it over)
  const rest = await left(gc, user, r, now);
  if (rest != null) {
    let pages;
    try { pages = (await gc.print.pages({ mediaId: b.mediaId })).pages; } catch (e) { throw fromHost(e); }
    if (pages * copies > rest) throw fail('limit', { left: rest, pages: pages * copies });
  }
  let job;
  try {
    job = await gc.print.submit({ deviceId: d.id, mediaId: b.mediaId, user: user.id, copies, color, duplex: b.duplex === true, name: clip(b.name, 200) || undefined, ...paper });
  } catch (e) { throw fromHost(e); }
  await insert(gc, job, d, via, now);
  return { job: await view(gc, await store.one(gc, 'SELECT * FROM jobs WHERE id = ?', [job.id])), pagesLeft: rest == null ? null : Math.max(0, rest - job.pages * job.copies) };
}

/** Admin "Testseite" */
async function testPage(gc, user, deviceId, now = Date.now()) {
  const d = await deviceOf(gc, deviceId, 'printer');
  let job;
  try { job = await gc.print.testPage({ deviceId: d.id, user: user.id }); } catch (e) { throw fromHost(e); }
  await insert(gc, job, d, 'admin', now);
  return { job: await view(gc, await store.one(gc, 'SELECT * FROM jobs WHERE id = ?', [job.id])) };
}

async function cancel(gc, user, id) {
  const row = await store.one(gc, 'SELECT * FROM jobs WHERE id = ?', [String(id)]);
  if (!row || (row.user_id !== user.id && user.role !== 'admin')) throw fail('not_found');
  let r;
  try { r = await gc.print.cancel(row.id); } catch (e) { throw fromHost(e); }
  if (r.canceled) await store.run(gc, "UPDATE jobs SET state = 'canceled', updated_at = ? WHERE id = ?", [Date.now(), row.id]);
  return { canceled: !!r.canceled };
}

const names = new Map();
async function nameOf(gc, id) {
  if (names.has(id)) return names.get(id);
  let n = '';
  try { const u = await gc.users.get(id); n = (u && u.name) || ''; } catch { n = ''; }
  names.set(id, n);
  return n;
}

async function view(gc, r) {
  if (!r) return null;
  return {
    kind: 'print', id: r.id, user: r.user_id, userName: await nameOf(gc, r.user_id), device: r.device_name, deviceId: r.device_id, name: r.name,
    pages: r.pages, copies: r.copies, color: r.color === 1, duplex: r.duplex === 1, media: r.media || null, source: r.source || null, via: r.via, state: r.state, error: r.error || null,
    message: r.message || null, at: iso(r.created_at), updatedAt: iso(r.updated_at), open: OPEN.includes(r.state),
  };
}

/** The history (admin: everybody; a person: own) */
async function list(gc, { userId = null, limit = 50 } = {}) {
  const rows = userId == null
    ? await store.all(gc, 'SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?', [limit])
    : await store.all(gc, 'SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
  const out = [];
  for (const r of rows) out.push(await view(gc, r));
  return out;
}

/**
 * Background: the host's job states into the history; a finished or failed job
 * from the portal notifies its person once (notifyTopics print_done / print_failed).
 */
async function sync(gc, cfg, t, now = Date.now()) {
  let list;
  try { list = (await gc.print.jobs({ since: state.since ? state.since - 60000 : 0, limit: 500 })) || []; } catch (e) {
    gc.log.debug('job sync failed', (e && e.code) || 'error');
    return 0;
  }
  let changed = 0;
  for (const j of list) {
    const row = await store.one(gc, 'SELECT * FROM jobs WHERE id = ?', [j.id]);
    if (!row) continue;
    const pages = Number.isInteger(j.pages) && j.pages > 0 ? j.pages : row.pages;
    if (row.state !== j.state || (row.error || null) !== (j.error || null) || (row.message || null) !== (j.message || null) || row.pages !== pages) {
      await store.run(gc, 'UPDATE jobs SET state = ?, error = ?, message = ?, pages = ?, updated_at = ? WHERE id = ?', [j.state, j.error || null, j.message || null, pages, now, row.id]);
      changed++;
    }
    const final = j.state === 'done' || j.state === 'failed' || j.state === 'expired';
    if (final && !row.notified && cfg.notify && row.via !== 'admin') {
      await store.run(gc, 'UPDATE jobs SET notified = 1 WHERE id = ?', [row.id]);
      await notify(gc, t, row, j);
    }
    const at = Date.parse(j.updatedAt);
    if (Number.isFinite(at) && at > state.since) state.since = at;
  }
  return changed;
}

async function notify(gc, t, row, j) {
  if (typeof gc.notify !== 'function') return;
  let lang = 'de';
  try { const u = await gc.users.get(row.user_id); lang = u && u.lang === 'en' ? 'en' : 'de'; } catch { lang = 'de'; }
  const ok = j.state === 'done';
  const reason = ok ? '' : t(lang, 'jerr.' + (j.error || (j.state === 'expired' ? 'expired' : 'failed')));
  try {
    await gc.notify({
      topic: ok ? 'print_done' : 'print_failed',
      title: t(lang, ok ? 'notify.done_title' : 'notify.failed_title'),
      body: t(lang, ok ? 'notify.done_body' : 'notify.failed_body', { name: row.name, device: row.device_name, reason }).slice(0, 300),
      priority: ok ? 'info' : 'normal',
      users: [row.user_id],
      collapseKey: 'print-' + row.id,
    });
  } catch (e) { gc.log.debug('print notice not sent', (e && e.code) || 'error'); }
}

/**
 * GET jobs/<id> — one job of the person (an administrator: any), fresh from GateControl (gc.print.job): the apps follow
 * a job with it (the print service on the phone shows its real state). → { job }
 */
async function one(gc, user, id, now = Date.now()) {
  const row = await store.one(gc, 'SELECT * FROM jobs WHERE id = ?', [String(id)]);
  if (!row || (row.user_id !== user.id && user.role !== 'admin')) throw fail('not_found');
  if (OPEN.includes(row.state) && typeof gc.print.job === 'function') {
    let j = null;
    try { j = await gc.print.job(row.id); } catch (e) {
      if (!(e && e.code === 'ERR_NOT_FOUND')) gc.log.debug('job refresh failed', (e && e.code) || 'error');
    }
    if (j) {
      const pages = Number.isInteger(j.pages) && j.pages > 0 ? j.pages : row.pages;
      await store.run(gc, 'UPDATE jobs SET state = ?, error = ?, message = ?, pages = ?, updated_at = ? WHERE id = ?', [j.state, j.error || null, j.message || null, pages, now, row.id]);
    }
  }
  return { job: await view(gc, await store.one(gc, 'SELECT * FROM jobs WHERE id = ?', [row.id])) };
}

async function purge(gc, days, now = Date.now()) {
  await store.run(gc, `DELETE FROM jobs WHERE created_at < ? AND state NOT IN (${store.marks(OPEN.length)})`, [now - days * 86400000, ...OPEN]);
}

module.exports = { print, testPage, cancel, list, one, sync, purge, pagesToday, left, reset, view, mediaOf, OPEN };
