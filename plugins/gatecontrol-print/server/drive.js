'use strict';

// Scans into Drive (gatecontrol-drive services, plugin.json permissions.services):
// the PDF is handed over to Drive (gc.media.handOver — Drive lists our
// services, so it may take it) and filed with save_file for the person; the
// AI's suggestion (suggest_folder: name and folder) gets the first page as a
// picture, so Drive's AI can read it. Everything a person could not do in
// Drive themselves fails there (no seat, no write right).

const { fail } = require('./util');

const DRIVE = 'gatecontrol-drive';
const CODES = { not_found: 'not_found', forbidden: 'forbidden', no_seat: 'no_drive', not_licensed: 'no_drive', invalid: 'invalid', quota: 'too_large', upload_invalid: 'invalid', unavailable: 'no_drive', exists: 'invalid' };

const servicesOk = (gc) => !!(gc.services && typeof gc.services.call === 'function' && gc.media && typeof gc.media.handOver === 'function');

/** Is Drive there (installed, running, offering save_file)? */
async function available(gc) {
  if (!servicesOk(gc)) return false;
  if (typeof gc.services.available !== 'function') return true;
  try { return (await gc.services.available(DRIVE, 'save_file')) === true; } catch { return false; }
}

async function call(gc, userId, service, payload) {
  let r;
  try {
    r = await gc.services.call({ plugin: DRIVE, service, userId, payload });
  } catch (e) {
    throw fail('drive_failed', { reason: (e && e.code) || 'error' });
  }
  if (!r || r.ok !== true) throw fail(CODES[r && r.code] || 'drive_failed', { reason: (r && r.code) || 'failed' });
  return r;
}

async function handOver(gc, mediaId, userId) {
  try {
    return (await gc.media.handOver(mediaId, { toPlugin: DRIVE, user: userId })).mediaId;
  } catch (e) {
    if (e && e.code === 'ERR_MEDIA_TOO_LARGE') throw fail('too_large');
    throw fail('drive_failed', { reason: (e && e.code) || 'handover' });
  }
}

/** The AI's suggestion for a scan (first page as a picture) → { name, where, folderId } | null — never throws. */
async function suggest(gc, userId, firstPageMediaId, name) {
  try {
    const mediaId = await handOver(gc, firstPageMediaId, userId);
    const r = await call(gc, userId, 'suggest_folder', { mediaId, name });
    const s = r.suggestion;
    if (!s || !Number.isSafeInteger(s.folderId)) return null;
    let n = typeof s.name === 'string' && s.name.trim() ? s.name.trim() : name;
    n = n.replace(/\.(jpe?g|png)$/i, '');
    if (!/\.pdf$/i.test(n)) n += '.pdf';
    return { name: n.slice(0, 200), where: typeof s.where === 'string' ? s.where.slice(0, 200) : '', folderId: s.folderId };
  } catch (e) {
    gc.log.debug('drive suggestion failed', (e && e.code) || 'error');
    return null;
  }
}

/**
 * File the PDF: into the suggested folder (folderId) or `area` + `folder/name`. `text`: the recognised text of a
 * searchable PDF — Drive keeps it as the file's text for its search (save_file { text }, Drive 1.23.0; an older Drive
 * ignores it, the PDF itself stays searchable).
 * → { where, nodeId, name }
 */
async function save(gc, userId, pdfMediaId, { folderId = null, area, folder, name, lang, text = null }) {
  const mediaId = await handOver(gc, pdfMediaId, userId);
  const source = { plugin: 'gatecontrol-print', label: lang === 'en' ? 'Scanned with Print & Scan' : 'Gescannt mit Drucken & Scannen' };
  const extra = typeof text === 'string' && text.trim() ? { text: text.slice(0, 200000) } : {};
  const payload = Number.isSafeInteger(folderId)
    ? { mediaId, folderId, name, onConflict: 'rename', source, ...extra }
    : { mediaId, area, path: `${folder}/${name}`, onConflict: 'rename', source, ...extra };
  const r = await call(gc, userId, 'save_file', payload);
  return { where: r.where || '', nodeId: r.nodeId || null, name: r.name || name };
}

module.exports = { available, suggest, save, DRIVE };
