'use strict';

// Attachments into Drive and files from Drive (Drive ≥ 1.15.0 services — gc.services, the file handed over with
// gc.media.handOver): a suggestion where an attachment goes (suggest_folder: the person's rule or learned folder for the
// sender, Drive's AI, the kind of document), saving it there with its origin ("Aus Mail von …", a jump back to the mail)
// and "Immer für diesen Absender" (learn), saving all of a mail, "Zum Ablegen" for accounts that file on their own
// (attachments 'auto': only reason rule / learned or a confidence ≥ 0.9, never duplicates, inline pictures < 30 KB or
// .ics), and Drive files as a copy (give_file) or a link (share_link) in a mail.
// GateControl allows a plugin 60 service calls an hour (until Drive declares maxPerHour, GateControl ≥ 1.216.0): the
// background run spends at most PER_TICK and pauses after a refusal.

const store = require('./store');
const engine = require('./engine');
const config = require('./config');
const storage = require('./storage');
const { t } = require('./text');
const { fail, parse } = require('./util');

const DRIVE = 'gatecontrol-drive';
const HAND_TTL = 23 * 3600000;
const SEAT_TTL = 5 * 60000;
const PER_TICK = 6;
const SMALL_INLINE = 30 * 1024;
const PAUSE_MS = 10 * 60000;

const seats = new Map(); // user → { at, ok }
let pausedUntil = 0;

const servicesOk = (gc) => !!(gc.services && typeof gc.services.call === 'function');

async function available(gc) {
  if (!servicesOk(gc)) return false;
  if (typeof gc.services.available !== 'function') return true;
  try { return (await gc.services.available(DRIVE, 'save_file')) === true; } catch { return false; }
}

const CODES = { not_found: 'not_found', forbidden: 'forbidden', no_seat: 'forbidden', not_licensed: 'drive_unavailable', links_disabled: 'links_disabled',
  no_public_url: 'links_disabled', encrypted: 'forbidden', too_large: 'too_large', invalid: 'invalid', quota: 'too_large', upload_invalid: 'invalid', unavailable: 'drive_unavailable', exists: 'invalid' };

/** A Drive service for person `userId` → its answer (ok) or throws the API code. */
async function call(gc, userId, service, payload) {
  if (!servicesOk(gc)) throw fail('drive_unavailable');
  let r;
  try {
    r = await gc.services.call({ plugin: DRIVE, service, userId, payload });
  } catch (e) {
    const code = e && e.code;
    if (code === 'ERR_RATE_LIMIT') { pausedUntil = Date.now() + PAUSE_MS; throw fail('rate_limited'); }
    throw fail('drive_unavailable', { reason: code || 'error' });
  }
  if (!r || r.ok !== true) throw fail(CODES[r && r.code] || 'drive_unavailable', { reason: (r && r.code) || 'failed' });
  return r;
}

/** Does person `userId` have Drive (a seat)? (GET me features.drive; cached a few minutes) */
async function hasSeat(gc, userId) {
  const c = seats.get(userId);
  if (c && Date.now() - c.at < SEAT_TTL) return c.ok;
  let ok = false;
  if (await available(gc)) {
    try { await call(gc, userId, 'list_areas', {}); ok = true; } catch (e) { ok = e.code === 'rate_limited' ? !!(c && c.ok) : false; }
  }
  seats.set(userId, { at: Date.now(), ok });
  return ok;
}

/** The attachment's copy handed over to Drive (unclaimed there, 24 h; handed again when older). → Drive's media id */
async function handed(gc, userId, m, tt) {
  if (tt.drive_media && tt.drive_media_at && Date.now() - tt.drive_media_at < HAND_TTL) return tt.drive_media;
  const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [m.account_id]);
  const mine = await engine.attachment(gc, a, m, tt);
  let got;
  try {
    got = await gc.media.handOver(mine.mediaId, { toPlugin: DRIVE, user: userId });
  } catch (e) {
    if (e && e.code === 'ERR_MEDIA_TOO_LARGE') throw fail('too_large');
    if (e && e.code === 'ERR_RATE_LIMIT') throw fail('rate_limited');
    throw fail('drive_unavailable', { reason: (e && e.code) || 'handover' });
  }
  await store.run(gc, 'UPDATE attachments SET drive_media = ?, drive_media_at = ? WHERE id = ?', [got.mediaId, Date.now(), tt.id]);
  return got.mediaId;
}

const suggestionOf = (s) => (s && typeof s === 'object' && Number.isSafeInteger(s.folderId) ? {
  folderId: s.folderId, areaId: s.areaId, path: s.path || '', where: s.where || '', name: s.name || '', confidence: Number(s.confidence) || 0, reason: s.reason,
} : null);

/** suggest_folder for attachment `tt` of row `m` → { suggestion, duplicate } (kept with the attachment). */
async function suggestFor(gc, userId, m, tt) {
  const mediaId = await handed(gc, userId, m, tt);
  const r = await call(gc, userId, 'suggest_folder', {
    mediaId, name: tt.name, from: { name: m.from_name || '', address: m.from_email || '' }, subject: m.subject || '', date: m.date,
  });
  const suggestion = suggestionOf(r.suggestion);
  const duplicate = r.sha256Exists === true;
  await store.run(gc, 'UPDATE attachments SET suggestion_json = ?, duplicate = ? WHERE id = ?', [suggestion ? JSON.stringify(suggestion) : null, duplicate ? 1 : 0, tt.id]);
  return { suggestion, duplicate };
}

async function rowOf(gc, userId, messageId, attId) {
  const m = await store.one(gc, 'SELECT * FROM messages WHERE id = ? AND user_id = ?', [Number(messageId), userId]);
  const tt = m ? await store.one(gc, 'SELECT * FROM attachments WHERE id = ? AND message_id = ?', [Number(attId), m.id]) : null;
  if (!tt) throw fail('not_found');
  return { m, tt };
}

/** POST messages/<id>/attachments/<aid>/drive/suggest → { suggestion, duplicate } */
async function suggest(gc, userId, messageId, attId) {
  const { m, tt } = await rowOf(gc, userId, messageId, attId);
  return suggestFor(gc, userId, m, tt);
}

const sourceLabel = (lang, m) => t(lang, 'drive.source', {
  from: m.from_name || m.from_email || '?', date: new Date(m.date).toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Berlin' }),
});

/** Save attachment `tt` → savedTo { nodeId, where }. */
async function saveFor(gc, userId, lang, m, tt, o = {}) {
  let folderId = o.folderId != null ? Number(o.folderId) : null;
  if (folderId != null && !(Number.isSafeInteger(folderId) && folderId > 0)) throw fail('invalid', { field: 'folderId' });
  if (folderId == null) {
    const s = parse(tt.suggestion_json, null) || (await suggestFor(gc, userId, m, await store.one(gc, 'SELECT * FROM attachments WHERE id = ?', [tt.id]))).suggestion;
    if (!s) throw fail('no_folder');
    folderId = s.folderId;
    if (o.name == null && s.name) o = { ...o, name: s.name };
  }
  const fresh = await store.one(gc, 'SELECT * FROM attachments WHERE id = ?', [tt.id]);
  const mediaId = await handed(gc, userId, m, fresh);
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 255) : tt.name;
  const r = await call(gc, userId, 'save_file', {
    mediaId, folderId, name, onConflict: 'rename', lang,
    source: { plugin: 'gatecontrol-mail', label: sourceLabel(lang, m).slice(0, 120), ref: String(m.id) },
    ...(m.from_email ? { learn: { from: m.from_email, ...(o.remember === true ? { always: true } : {}) } } : {}),
  });
  const savedTo = { nodeId: r.nodeId, where: r.where || '' };
  await store.run(gc, 'UPDATE attachments SET saved_node = ?, saved_where = ?, drive_media = NULL, drive_media_at = NULL WHERE id = ?', [savedTo.nodeId, savedTo.where, tt.id]);
  await store.run(gc, 'DELETE FROM filing WHERE attachment_id = ?', [tt.id]);
  return savedTo;
}

/** POST messages/<id>/attachments/<aid>/drive/save { folderId?, name?, remember? } → { savedTo } */
async function save(gc, userId, lang, messageId, attId, b) {
  const { m, tt } = await rowOf(gc, userId, messageId, attId);
  return { savedTo: await saveFor(gc, userId, lang, m, tt, b && typeof b === 'object' ? b : {}) };
}

/** Attachments worth filing (not small inline pictures, not invitations). */
const worth = (tt) => !(tt.inline === 1 && /^image\//.test(tt.mime) && tt.size < SMALL_INLINE) && !/\.ics$/i.test(tt.name) && tt.mime !== 'text/calendar' && !(tt.inline === 1 && tt.cid);

/** POST messages/<id>/drive/save-all → { saved, failed } */
async function saveAll(gc, userId, lang, messageId) {
  const m = await store.one(gc, 'SELECT * FROM messages WHERE id = ? AND user_id = ?', [Number(messageId), userId]);
  if (!m) throw fail('not_found');
  const saved = [];
  const failed = [];
  for (const tt of await store.all(gc, 'SELECT * FROM attachments WHERE message_id = ? AND saved_node IS NULL ORDER BY id', [m.id])) {
    if (!worth(tt)) continue;
    try { saved.push({ attachmentId: tt.id, savedTo: await saveFor(gc, userId, lang, m, tt) }); } catch (e) { failed.push({ attachmentId: tt.id, code: (e && e.code) || 'failed' }); if (e && e.code === 'rate_limited') break; }
  }
  return { saved, failed };
}

/** GET filing → { items } */
async function filing(gc, userId) {
  const rows = await store.all(gc, `SELECT f.id, f.message_id, f.attachment_id, t.name, t.suggestion_json, m.from_name, m.from_email, m.date FROM filing f
    JOIN attachments t ON t.id = f.attachment_id JOIN messages m ON m.id = f.message_id WHERE f.user_id = ? ORDER BY m.date DESC LIMIT 200`, [userId]);
  return { items: rows.map((r) => ({ id: r.id, messageId: r.message_id, attachmentId: r.attachment_id, name: r.name, from: { name: r.from_name || '', email: r.from_email || '' }, date: r.date, suggestion: parse(r.suggestion_json, null) })) };
}

async function filingRow(gc, userId, id) {
  const r = Number.isSafeInteger(Number(id)) ? await store.one(gc, 'SELECT * FROM filing WHERE id = ? AND user_id = ?', [Number(id), userId]) : null;
  if (!r) throw fail('not_found');
  return r;
}

/** POST filing/<id>/confirm { folderId?, name? } → { savedTo } */
async function confirm(gc, userId, lang, id, b) {
  const r = await filingRow(gc, userId, id);
  return save(gc, userId, lang, r.message_id, r.attachment_id, b);
}

/** POST filing/<id>/dismiss → { ok } */
async function dismiss(gc, userId, id) {
  const r = await filingRow(gc, userId, id);
  await store.run(gc, 'DELETE FROM filing WHERE id = ?', [r.id]);
  return { ok: true };
}

/**
 * The background run: new mail with attachments of accounts with attachments 'suggest' (a suggestion is ready when the
 * mail is opened) or 'auto' (filed on its own when Drive is sure, else "Zum Ablegen") — PER_TICK service calls at most.
 */
async function tick(gc, now) {
  // since 1.5.0 also not while GateControl has no room for the copies of attachments (storage.js)
  if (now < pausedUntil || storage.paused(now) || !(await available(gc))) return 0;
  const cfg = await config.get(gc);
  const rows = await store.all(gc, `SELECT m.*, a.attachments AS mode, a.kind AS acc_kind FROM messages m JOIN accounts a ON a.id = m.account_id JOIN folders f ON f.id = m.folder_id
    WHERE m.filed = 0 AND m.has_att = 1 AND m.body_state = 'stored' AND f.role = 'inbox' AND a.attachments <> 'off' ORDER BY m.date DESC LIMIT 10`);
  let calls = 0;
  let full = false;
  for (const m of rows) {
    if (calls >= PER_TICK || Date.now() < pausedUntil) break;
    const auto = m.mode === 'auto' && cfg.ai.autoFile;
    if (!(await hasSeat(gc, m.user_id))) { await store.run(gc, 'UPDATE messages SET filed = 1 WHERE id = ?', [m.id]); continue; }
    let done = true;
    for (const tt of await store.all(gc, 'SELECT * FROM attachments WHERE message_id = ? AND saved_node IS NULL', [m.id])) {
      if (!worth(tt) || (tt.suggestion_json && !auto)) continue;
      if (calls >= PER_TICK) { done = false; break; }
      try {
        const s = tt.suggestion_json ? { suggestion: parse(tt.suggestion_json, null), duplicate: tt.duplicate === 1 } : await suggestFor(gc, m.user_id, m, tt);
        calls++;
        if (!auto || s.duplicate) continue;
        const sure = s.suggestion && (s.suggestion.reason === 'rule' || s.suggestion.reason === 'learned' || s.suggestion.confidence >= 0.9);
        if (sure) { await saveFor(gc, m.user_id, 'de', m, await store.one(gc, 'SELECT * FROM attachments WHERE id = ?', [tt.id])); calls++; }
        else await store.run(gc, 'INSERT INTO filing (user_id, message_id, attachment_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(attachment_id) DO NOTHING', [m.user_id, m.id, tt.id, now]);
      } catch (e) {
        if (e && e.code === 'rate_limited') { done = false; break; }
        if (e && (e.code === 'unreachable' || e.code === 'busy')) { done = false; break; }
        // since 1.5.0: no room for the attachment's copy at GateControl (storage.js) — this run ends, the mail comes again
        if (e && (e.code === 'storage_unavailable' || e.code === 'server_full')) { done = false; full = true; break; }
      }
    }
    if (done) await store.run(gc, 'UPDATE messages SET filed = 1 WHERE id = ?', [m.id]);
    if (full) break;
  }
  return calls;
}

/** A Drive file as a copy for a mail (give_file) → { mediaId (this plugin's, unclaimed), name, mime, size } */
async function giveFile(gc, userId, nodeId) {
  const r = await call(gc, userId, 'give_file', { nodeId });
  return { mediaId: r.mediaId, name: r.name, mime: r.mime || 'application/octet-stream', size: Number(r.size) || 0 };
}

/** A link to a Drive file (share_link) → { url, expiresAt } */
async function shareLink(gc, userId, nodeId, days, password) {
  const d = Number.isInteger(days) && days >= 1 && days <= 90 ? days : 14;
  const r = await call(gc, userId, 'share_link', { nodeId, expiresDays: d, ...(password ? { password: String(password) } : {}) });
  return { url: r.url, expiresAt: r.expiresAt || null };
}

/** GET drive/areas → { areas } (list_areas: where the person may save). */
async function areas(gc, userId) {
  const r = await call(gc, userId, 'list_areas', {});
  return { areas: (r.areas || []).map((a) => ({ id: a.id, kind: a.kind, label: a.label, writable: a.writable === true })) };
}

/** GET drive/browse?area=&folder=&dirs=1 → Drive's browse (the pickers of the portal). */
async function browse(gc, userId, q) {
  const folderId = q.folder != null && q.folder !== '' ? Number(q.folder) : null;
  if (folderId != null && !(Number.isSafeInteger(folderId) && folderId > 0)) throw fail('invalid', { field: 'folder' });
  const r = await call(gc, userId, 'browse', { ...(folderId ? { folderId } : {}), ...(q.area ? { area: String(q.area).slice(0, 80) } : {}), dirs: q.dirs === '1' });
  return { folder: r.folder, items: r.items || [], next: r.next == null ? null : r.next };
}

function reset() { seats.clear(); pausedUntil = 0; }

module.exports = { reset, areas, browse, available, hasSeat, suggest, save, saveAll, filing, confirm, dismiss, tick, giveFile, shareLink, worth, DRIVE };
