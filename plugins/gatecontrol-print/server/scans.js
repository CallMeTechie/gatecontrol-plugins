'use strict';

// Scanning from the phone: a scan session collects the pages of one or more
// scans ("Weitere Seite"), shows small previews, asks Drive's AI for a name
// and a folder ("Mit KI benennen und einsortieren") and files one PDF in
// Drive. The pages are GateControl media of this plugin (unclaimed — they go
// by themselves after 24 h); the session row keeps only their ids.

const crypto = require('node:crypto');
const store = require('./store');
const rights = require('./rights');
const drive = require('./drive');
const { fail, fromHost, clip, iso, day } = require('./util');

const MAX_PAGES = 100;
const SESSION_RE = /^sc_[A-Za-z0-9_-]{8,40}$/;

const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

async function own(gc, user, id) {
  if (typeof id !== 'string' || !SESSION_RE.test(id)) throw fail('not_found');
  const r = await store.one(gc, 'SELECT * FROM scans WHERE id = ? AND user_id = ?', [id, user.id]);
  if (!r) throw fail('not_found');
  return r;
}

/** The default name: "2026-11-06 Scan 09-40.pdf" */
function defaultName(now, lang) {
  const d = new Date(now);
  return `${day(now)} ${lang === 'en' ? 'Scan' : 'Scan'} ${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}.pdf`;
}

function view(r, extra = {}) {
  const pages = json(r.pages, []);
  return {
    id: r.id, device: r.device_name, deviceId: r.device_id, state: r.state, scanning: !!r.host_scan, error: r.error || null,
    pages: pages.map((p, i) => ({ n: i + 1, thumb: p.thumb || null })), suggestion: json(r.suggestion, null),
    savedName: r.saved_name || null, savedWhere: r.saved_where || null, at: iso(r.created_at), ...extra,
  };
}

/**
 * POST scan { deviceId, source: platen|feeder, mode: document|photo, session? } — a new session, or another
 * scan into an open one ("Weitere Seite").
 */
async function start(gc, user, b, now = Date.now()) {
  const r = await rights.of(gc, user);
  if (!r.scan) throw fail('no_right');
  let row = null;
  if (b.session != null) {
    row = await own(gc, user, b.session);
    if (row.state !== 'open') throw fail('invalid', { field: 'session' });
    if (row.host_scan) throw fail('scan_running');
    if (json(row.pages, []).length >= MAX_PAGES) throw fail('invalid', { field: 'pages' });
  }
  const deviceId = row ? row.device_id : b.deviceId;
  if (typeof deviceId !== 'string') throw fail('invalid', { field: 'deviceId' });
  const list = (await gc.print.devices()) || [];
  const d = list.find((x) => x.id === deviceId);
  if (!d || !d.scanner) throw fail('not_found');
  const source = b.source === 'feeder' || b.source === 'platen' ? b.source : undefined;
  const mode = b.mode === 'photo' ? 'photo' : 'document';
  let s;
  try { s = await gc.print.scan({ deviceId: d.id, user: user.id, ...(source ? { source } : {}), mode }); } catch (e) { throw fromHost(e); }
  if (row) {
    await store.run(gc, 'UPDATE scans SET host_scan = ?, error = NULL, updated_at = ? WHERE id = ?', [s.scanId, now, row.id]);
  } else {
    const id = 'sc_' + crypto.randomBytes(12).toString('base64url');
    await store.run(gc, `INSERT INTO scans (id, user_id, device_id, device_name, host_scan, pages, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', 'open', ?, ?)`,
      [id, user.id, d.id, clip(d.name, 120), s.scanId, now, now]);
    row = { id };
  }
  return { scan: view(await store.one(gc, 'SELECT * FROM scans WHERE id = ?', [row.id])) };
}

/** GET scan/<id> — takes over the pages of the running scan; the scan's end clears host_scan. */
async function status(gc, user, id, now = Date.now()) {
  let row = await own(gc, user, id);
  if (row.host_scan) {
    let s;
    try { s = await gc.print.scanStatus(row.host_scan); } catch (e) {
      if (e && e.code === 'ERR_NOT_FOUND') s = { state: 'failed', error: 'scan_failed', pages: [] };
      else throw fromHost(e);
    }
    const pages = json(row.pages, []);
    const known = new Set(pages.map((p) => p.mediaId));
    let added = 0;
    for (const p of s.pages || []) {
      if (known.has(p.mediaId) || pages.length >= MAX_PAGES) continue;
      added++;
      pages.push({ mediaId: p.mediaId, thumb: typeof p.thumb === 'string' && p.thumb.length <= 70000 ? p.thumb : null });
      known.add(p.mediaId);
    }
    const done = s.state !== 'scanning';
    const error = s.state === 'failed' ? (s.error || 'scan_failed') : null;
    await store.run(gc, 'UPDATE scans SET pages = ?, host_scan = ?, error = ?, suggestion = CASE WHEN ? THEN NULL ELSE suggestion END, updated_at = ? WHERE id = ?',
      [JSON.stringify(pages), done ? null : row.host_scan, error, added ? 1 : 0, now, row.id]);
    row = await store.one(gc, 'SELECT * FROM scans WHERE id = ?', [row.id]);
  }
  return { scan: view(row) };
}

/** POST scan/<id>/suggest — the AI's name and folder (Drive), cached in the session. */
async function suggest(gc, user, id, cfg, lang, now = Date.now()) {
  const row = await own(gc, user, id);
  const pages = json(row.pages, []);
  if (!pages.length) throw fail('no_pages');
  const cached = json(row.suggestion, null);
  if (cached) return { suggestion: cached };
  if (!cfg.aiFile || !await drive.available(gc)) return { suggestion: null };
  const s = await drive.suggest(gc, user.id, pages[0].mediaId, defaultName(row.created_at, lang).replace(/\.pdf$/, '.jpg'));
  if (s) await store.run(gc, 'UPDATE scans SET suggestion = ?, updated_at = ? WHERE id = ?', [JSON.stringify(s), now, row.id]);
  return { suggestion: s };
}

/** POST scan/<id>/save { name?, useSuggestion? } — one PDF of the pages into Drive. → { scan } */
async function save(gc, user, id, b, cfg, lang, now = Date.now()) {
  const row = await own(gc, user, id);
  if (row.state !== 'open') throw fail('invalid', { field: 'state' });
  if (row.host_scan) throw fail('scan_running');
  const pages = json(row.pages, []);
  if (!pages.length) throw fail('no_pages');
  if (!await drive.available(gc)) throw fail('no_drive');
  const sug = b.useSuggestion === false ? null : json(row.suggestion, null);
  let name = clip(b.name, 200) || (sug && sug.name) || defaultName(row.created_at, lang);
  name = name.replace(/[/\\]/g, '-');
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  let doc;
  try { doc = await gc.print.pdf({ pages: pages.map((p) => p.mediaId), user: user.id, name }); } catch (e) { throw fromHost(e, 'drive_failed'); }
  const saved = await drive.save(gc, user.id, doc.mediaId, { folderId: sug ? sug.folderId : null, area: cfg.driveArea, folder: cfg.folder, name, lang });
  await store.run(gc, "UPDATE scans SET state = 'saved', saved_name = ?, saved_where = ?, updated_at = ? WHERE id = ?", [saved.name, saved.where, now, row.id]);
  return { scan: view(await store.one(gc, 'SELECT * FROM scans WHERE id = ?', [row.id])) };
}

/** POST scan/<id>/discard — the session ends (a running scan is stopped). */
async function discard(gc, user, id, now = Date.now()) {
  const row = await own(gc, user, id);
  if (row.host_scan) { try { await gc.print.cancelScan(row.host_scan); } catch { /* ends by itself */ } }
  await store.run(gc, "UPDATE scans SET state = 'discarded', host_scan = NULL, updated_at = ? WHERE id = ?", [now, row.id]);
  return { discarded: true };
}

/** POST scan/<id>/remove-page { n } — drop one page of an open session */
async function removePage(gc, user, id, n, now = Date.now()) {
  const row = await own(gc, user, id);
  if (row.state !== 'open') throw fail('invalid');
  const pages = json(row.pages, []);
  const i = Number(n) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= pages.length) throw fail('invalid', { field: 'n' });
  pages.splice(i, 1);
  await store.run(gc, 'UPDATE scans SET pages = ?, suggestion = NULL, updated_at = ? WHERE id = ?', [JSON.stringify(pages), now, row.id]);
  return { scan: view(await store.one(gc, 'SELECT * FROM scans WHERE id = ?', [row.id])) };
}

/** The history's scans (admin: everybody) */
async function list(gc, { userId = null, limit = 50 } = {}) {
  const rows = userId == null
    ? await store.all(gc, "SELECT * FROM scans WHERE state != 'discarded' ORDER BY created_at DESC LIMIT ?", [limit])
    : await store.all(gc, "SELECT * FROM scans WHERE user_id = ? AND state != 'discarded' ORDER BY created_at DESC LIMIT ?", [userId, limit]);
  return rows.map((r) => ({ kind: 'scan', id: r.id, user: r.user_id, device: r.device_name, state: r.state, pages: json(r.pages, []).length,
    name: r.saved_name || null, where: r.saved_where || null, error: r.error || null, at: iso(r.created_at) }));
}

async function purge(gc, days, now = Date.now()) {
  await store.run(gc, 'DELETE FROM scans WHERE updated_at < ?', [now - days * 86400000]);
  // open sessions older than a day: their pages are gone (GateControl drops unclaimed media after 24 h)
  await store.run(gc, "UPDATE scans SET state = 'discarded', host_scan = NULL WHERE state = 'open' AND updated_at < ?", [now - 86400000]);
}

module.exports = { start, status, suggest, save, discard, removePage, list, purge, defaultName };
