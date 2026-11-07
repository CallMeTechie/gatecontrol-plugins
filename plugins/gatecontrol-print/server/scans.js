'use strict';

// Scanning from the phone: a scan session collects the pages of one or more
// scans ("Weitere Seite"), shows small previews, asks Drive's AI for a name
// and a folder ("Mit KI benennen und einsortieren") and files one PDF in
// Drive. The pages are GateControl media of this plugin (unclaimed — they go
// by themselves after 24 h); the session row keeps only their ids.
//
// "Durchsuchbares PDF" (since 1.1.0, GateControl ≥ 1.246.0 with a gateway that
// has „Texterkennung“ on): save starts gc.print.ocr — the session waits in
// state 'ocr' until the gateway made the searchable PDF and its text, then it
// goes to Drive with the text (Drive's search). Fails the text recognition
// (too long, gateway off), the plain PDF is filed and the session says so.

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
  const o = typeof r.ocr === 'string' ? r.ocr : null;
  return {
    id: r.id, device: r.device_name, deviceId: r.device_id, state: r.state, scanning: !!r.host_scan, error: r.error || null,
    pages: pages.map((p, i) => ({ n: i + 1, thumb: p.thumb || null })), suggestion: json(r.suggestion, null),
    savedName: r.saved_name || null, savedWhere: r.saved_where || null, at: iso(r.created_at),
    // searchable PDF: true (saved with its text), false (asked, but saved without — ocrError says why), null (not asked)
    searchable: o === 'searchable' ? true : (o && o.startsWith('failed') ? false : null),
    ocrError: o && o.startsWith('failed:') ? o.slice(7) : null,
    ...extra,
  };
}

/** The text recognition of a session in state 'ocr' → { page, pages } (null when none). */
async function ocrProgress(gc, r) {
  if (r.state !== 'ocr' || !r.ocr_id || !gc.print || typeof gc.print.ocrStatus !== 'function') return null;
  try { const s = await gc.print.ocrStatus(r.ocr_id); return { page: s.page || 0, pages: s.pages || json(r.pages, []).length, state: s.state }; } catch { return null; }
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

/** GET scan/<id> — takes over the pages of the running scan; the scan's end clears host_scan; a searchable PDF goes on. */
async function status(gc, user, id, now = Date.now()) {
  let row = await own(gc, user, id);
  if (row.state === 'ocr') {
    await advance(gc, row, null, now);
    row = await store.one(gc, 'SELECT * FROM scans WHERE id = ?', [row.id]);
    const progress = await ocrProgress(gc, row);
    return { scan: view(row, progress ? { ocr: { page: progress.page, pages: progress.pages } } : {}) };
  }
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

/**
 * POST scan/<id>/save { name?, useSuggestion?, searchable? } — one PDF of the pages into Drive. With `searchable`
 * (and a gateway with „Texterkennung“): the text recognition starts and the session waits in state 'ocr' (GET
 * scan/<id> and the background carry it on). → { scan }
 */
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
  const opts = { name, folderId: sug ? sug.folderId : null, lang };
  if (b.searchable === true) {
    let started = null;
    let why = 'ocr_unavailable';
    if (typeof gc.print.ocr === 'function') {
      try { started = await gc.print.ocr({ pages: pages.map((p) => p.mediaId), user: user.id, name, deviceId: row.device_id, dpi: 300 }); } catch (e) {
        why = e && e.code === 'ERR_PRINT_BUSY' ? 'busy' : 'ocr_unavailable';
        gc.log.debug('text recognition not started', (e && e.code) || 'error');
      }
    }
    if (started && started.ocrId) {
      await store.run(gc, "UPDATE scans SET state = 'ocr', ocr_id = ?, ocr = NULL, save_opts = ?, updated_at = ? WHERE id = ?", [started.ocrId, JSON.stringify(opts), now, row.id]);
      const r2 = await store.one(gc, 'SELECT * FROM scans WHERE id = ?', [row.id]);
      return { scan: view(r2, { ocr: { page: 0, pages: pages.length } }) };
    }
    // no gateway can read the text right now: the plain PDF, and the session says why
    await plain(gc, { ...row, user_id: user.id }, opts, cfg, now, 'failed:' + why);
    return { scan: view(await store.one(gc, 'SELECT * FROM scans WHERE id = ?', [row.id])) };
  }
  await plain(gc, { ...row, user_id: user.id }, opts, cfg, now, null);
  return { scan: view(await store.one(gc, 'SELECT * FROM scans WHERE id = ?', [row.id])) };
}

/** The plain PDF of the pages into Drive (ocr: what to note — null, or failed:<reason> when a searchable one was asked). */
async function plain(gc, row, opts, cfg, now, ocr) {
  const pages = json(row.pages, []);
  let doc;
  try { doc = await gc.print.pdf({ pages: pages.map((p) => p.mediaId), user: row.user_id, name: opts.name }); } catch (e) { throw fromHost(e, 'drive_failed'); }
  const saved = await drive.save(gc, row.user_id, doc.mediaId, { folderId: opts.folderId, area: cfg.driveArea, folder: cfg.folder, name: opts.name, lang: opts.lang });
  await store.run(gc, "UPDATE scans SET state = 'saved', saved_name = ?, saved_where = ?, ocr = ?, ocr_id = NULL, updated_at = ? WHERE id = ?", [saved.name, saved.where, ocr, now, row.id]);
}

/**
 * A session in state 'ocr': the text recognition done → the searchable PDF with its text into Drive; failed, canceled
 * or gone → the plain PDF (ocr 'failed:<reason>'); still running → nothing. cfg: the plugin settings (null: load them).
 * Never throws for the recognition itself; Drive errors leave the session in 'ocr' for the next try.
 */
async function advance(gc, row, cfg, now = Date.now()) {
  if (row.state !== 'ocr' || !row.ocr_id) return false;
  const c = cfg || await require('./config').load(gc);
  const opts = json(row.save_opts, null) || { name: defaultName(row.created_at, 'de'), folderId: null, lang: 'de' };
  let s = null;
  try { s = await gc.print.ocrStatus(row.ocr_id); } catch (e) {
    s = { state: 'failed', error: e && e.code === 'ERR_NOT_FOUND' ? 'ocr_gone' : 'ocr_failed' };
  }
  if (s.state === 'queued' || s.state === 'running') {
    // a stuck one ends after an hour at the latest (GateControl gives up much earlier)
    if (now - row.updated_at < 3600000) return false;
    s = { state: 'failed', error: 'timeout' };
  }
  try {
    if (s.state === 'done' && s.mediaId) {
      const saved = await drive.save(gc, row.user_id, s.mediaId, { folderId: opts.folderId, area: c.driveArea, folder: c.folder, name: opts.name, lang: opts.lang, text: s.text || '' });
      await store.run(gc, "UPDATE scans SET state = 'saved', saved_name = ?, saved_where = ?, ocr = 'searchable', ocr_id = NULL, updated_at = ? WHERE id = ?", [saved.name, saved.where, now, row.id]);
    } else {
      await plain(gc, row, opts, c, now, 'failed:' + String(s.error || s.state || 'failed').replace(/[^a-z_]/g, '').slice(0, 30));
    }
  } catch (e) {
    gc.log.warn('searchable scan not filed', (e && e.code) || 'error');
    await store.run(gc, 'UPDATE scans SET error = ? WHERE id = ?', [(e && e.code) || 'drive_failed', row.id]);
    return false;
  }
  return true;
}

/** Background: carry on the sessions waiting for their text (a few per run). */
async function advanceAll(gc, cfg, now = Date.now()) {
  const rows = await store.all(gc, "SELECT * FROM scans WHERE state = 'ocr' ORDER BY updated_at LIMIT 5");
  let n = 0;
  for (const r of rows) if (await advance(gc, r, cfg, now)) n++;
  return n;
}

/** POST scan/<id>/discard — the session ends (a running scan is stopped). */
async function discard(gc, user, id, now = Date.now()) {
  const row = await own(gc, user, id);
  if (row.host_scan) { try { await gc.print.cancelScan(row.host_scan); } catch { /* ends by itself */ } }
  if (row.ocr_id && typeof gc.print.cancelOcr === 'function') { try { await gc.print.cancelOcr(row.ocr_id); } catch { /* ends by itself */ } }
  await store.run(gc, "UPDATE scans SET state = 'discarded', host_scan = NULL, ocr_id = NULL, updated_at = ? WHERE id = ?", [now, row.id]);
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
    name: r.saved_name || null, where: r.saved_where || null, error: r.error || null, at: iso(r.created_at), searchable: r.ocr === 'searchable' }));
}

async function purge(gc, days, now = Date.now()) {
  await store.run(gc, 'DELETE FROM scans WHERE updated_at < ?', [now - days * 86400000]);
  // open sessions older than a day: their pages are gone (GateControl drops unclaimed media after 24 h)
  await store.run(gc, "UPDATE scans SET state = 'discarded', host_scan = NULL WHERE state = 'open' AND updated_at < ?", [now - 86400000]);
}

module.exports = { start, status, suggest, save, discard, removePage, list, purge, defaultName, advance, advanceAll };
