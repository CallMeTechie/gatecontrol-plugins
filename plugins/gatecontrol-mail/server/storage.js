'use strict';

// Speicherorte (1.5.0): the copies of received attachments lie in GateControl's media area `attachments` (plugin.json
// media.areas, docs/plugins.md "Media areas"). The administrator decides in GateControl where it lies — Einstellungen ›
// Plugins › Mail › Übersicht, section „Speicherorte“: this server, or a storage target (a NAS over SMB or WebDAV, S3,
// OneDrive, Google Drive — set up under Einstellungen › Plugins › Speicher). Mail never picks a place, keeps no files
// of its own and moves nothing itself: GateControl moves the files of the area in the background.
//
// On this server (no area) stay what is small and used all the time, or must work while a target is down: account
// pictures, inline pictures of mails (cid), the files of drafts and the outbox, the raw copy of a sent mail for
// „Gesendet“ (gone right after). Bodies, calendars, contacts and their photos lie in the plugin's database anyway.
//
// The files have no path: on a NAS in the readable form they lie below `.gcdrive/files/` — GateControl takes no changes
// from there (a file deleted there is gone: gc.media.info answers null and the attachment loads again). Files of 1.4 and older (claimed without an area — GateControl gives
// them none: such a file stays on this server) are put into the area once, a batch per background run
// (gc.media.claim(id, { area })); they move with the area like the new ones.
//
// Every new file arrives on this server first. With media.areas GateControl refuses one when this server is full
// (`server_full`, 507 on an upload) or when a target fails and the files waiting for it fill the cache
// (`storage_unavailable`, 503). gc.media.fetch (Microsoft) answers the code itself, gc.mail (IMAP) an ERR_INVALID with
// the code as its message. Then the prefetch of attachments pauses and tries again later — the sync never waits for
// it; a person asking for an attachment gets 409 `storage_unavailable` / `server_full` (the API's 5xx mean "offline").

const store = require('./store');
const { fail } = require('./util');

const AREA = 'attachments';
const LABEL = 'Anhänge';
const BATCH = 200;                  // files of 1.4 put into the area per run
const ENSURE_RETRY_MS = 60000;
const PAUSE_MS = { storage_unavailable: 5 * 60000, server_full: 15 * 60000 };
const DONE_KEY = 'area_attachments';  // gc.storage: { upto: the last attachment id handled, done }

let areaOk = null;     // true | false (no areas on this host) | null (not asked yet / failed: ask again after ENSURE_RETRY_MS)
let ensureAt = 0;
let pausedUntil = 0;
let pauseCode = null;

function reset() {
  areaOk = null; ensureAt = 0; pausedUntil = 0; pauseCode = null;
}

const hasAreas = (gc) => !!(gc.media && gc.media.areas && typeof gc.media.areas.ensure === 'function');

/** The area exists (created on first use) → true; false without areas or while GateControl refuses it. */
async function ensure(gc, now = Date.now()) {
  if (areaOk !== null) return areaOk;
  if (!hasAreas(gc)) { areaOk = false; return false; }
  if (now - ensureAt < ENSURE_RETRY_MS) return false;
  ensureAt = now;
  try {
    await gc.media.areas.ensure(AREA, { label: LABEL });
    areaOk = true;
  } catch (e) {
    // no media.areas in plugin.json: never; anything else: again in a minute
    if (e && e.code === 'ERR_MEDIA_DENIED') areaOk = false;
    gc.log.warn('area failed', (e && e.code) || 'error');
    return false;
  }
  return true;
}

/** GateControl's refusal of a new file for want of room → 'storage_unavailable' | 'server_full', else null. */
function refusal(e) {
  if (!e) return null;
  const code = String(e.code || '');
  const msg = String(e.message || '');
  for (const c of ['storage_unavailable', 'server_full']) {
    // gc.media.fetch: the code itself; gc.mail: ERR_INVALID with the code; gc.media.copy: ERR_BUSY / ERR_MEDIA_QUOTA
    if (code === c || (msg === c && ['ERR_INVALID', 'ERR_BUSY', 'ERR_MEDIA_QUOTA'].includes(code))) return c;
  }
  return null;
}

/** Pause the prefetch of attachments after refusal `code`. */
function pause(code, now = Date.now()) {
  pausedUntil = Math.max(pausedUntil, now + (PAUSE_MS[code] || PAUSE_MS.storage_unavailable));
  pauseCode = code;
}

/** Is the prefetch paused (GateControl had no room for a new file a moment ago)? */
const paused = (now = Date.now()) => now < pausedUntil;

/**
 * Error `e` of storing a file: GateControl's refusal for want of room → the API's error (and the prefetch pauses),
 * else null.
 */
function failed(e, now = Date.now()) {
  const code = refusal(e);
  if (!code) return null;
  pause(code, now);
  return fail(code, { retryAfter: Math.round((PAUSE_MS[code] || PAUSE_MS.storage_unavailable) / 1000) });
}

/**
 * Keep the downloaded copy of attachment row `t`: in the area (inline pictures on this server). The area full (its
 * quota, set by the administrator) → the copy goes again, 409 server_full.
 */
async function claim(gc, mediaId, t) {
  if (t && t.inline) return gc.media.claim(mediaId);
  if (!(await ensure(gc))) return gc.media.claim(mediaId);
  try {
    return await gc.media.claim(mediaId, { area: AREA });
  } catch (e) {
    if (e && e.code === 'ERR_MEDIA_QUOTA') {
      try { await gc.media.delete(mediaId); } catch { /* gone */ }
      pause('server_full');
      throw fail('server_full', { reason: 'area_full', retryAfter: PAUSE_MS.server_full / 1000 });
    }
    if (e && e.code === 'ERR_INVALID' && /area/.test(String(e.message || ''))) {
      // the area went missing (a restore without it): ask again next time, keep the copy here meanwhile
      areaOk = null;
      return gc.media.claim(mediaId);
    }
    throw e;
  }
}

/**
 * Files of 1.4 and older into the area (a batch per run; inline pictures stay). → files handled. A full area stops the
 * batch (the next run tries again), a file GateControl no longer knows is skipped (the row loads it again when needed).
 */
async function adopt(gc, now = Date.now()) {
  if (!(await ensure(gc, now))) return 0;
  let st;
  try { st = await gc.storage.get(DONE_KEY); } catch { st = null; }
  if (st && st.done) return 0;
  const upto = st && Number.isSafeInteger(st.upto) ? st.upto : 0;
  const rows = await store.all(gc, 'SELECT id, media_id FROM attachments WHERE id > ? AND media_id IS NOT NULL AND inline = 0 ORDER BY id LIMIT ?', [upto, BATCH]);
  let last = upto;
  let n = 0;
  for (const r of rows) {
    try {
      await gc.media.claim(r.media_id, { area: AREA });
    } catch (e) {
      if (e && e.code === 'ERR_MEDIA_QUOTA') break;
      if (!(e && e.code === 'ERR_INVALID')) { gc.log.warn('area move failed', (e && e.code) || 'error'); break; }
    }
    last = r.id;
    n++;
  }
  const done = rows.length < BATCH && last === (rows.length ? rows[rows.length - 1].id : upto);
  if (last !== upto || done) await gc.storage.set(DONE_KEY, { upto: last, done });
  if (done) gc.log.info('attachments in their area', last);
  return n;
}

/**
 * Before sending: may the draft's files `mediaIds` be read? A file kept only on a storage target that fails cannot go
 * out now — the outbox tries again (409 storage_unavailable) instead of failing the account.
 */
async function readable(gc, mediaIds) {
  if (!mediaIds.length || !(await ensure(gc))) return true;
  let area;
  try { area = await gc.media.areas.info(AREA); } catch { return true; }
  if (!area || area.state !== 'unreachable') return true;
  for (const id of mediaIds) {
    let info;
    try { info = await gc.media.info(id); } catch { info = null; }
    if (info && info.area === AREA && info.stored === 'target') return false;
  }
  return true;
}

/** For the admin page: where the attachments lie → { area, label, target: { kind, label }, state, bytes, count, form } | null. */
async function view(gc) {
  if (!(await ensure(gc))) return null;
  let i;
  try { i = await gc.media.areas.info(AREA); } catch { i = null; }
  if (!i) return null;
  const target = i.target || { kind: 'server', label: null };
  return {
    area: AREA, label: i.label || LABEL, target: { kind: target.kind || 'server', label: target.label || null }, state: i.state || 'ok',
    bytes: Number(i.bytes) || 0, count: Number(i.count) || 0, form: i.form || null,
    ...(paused() ? { paused: pauseCode } : {}),
  };
}

module.exports = { AREA, LABEL, reset, ensure, refusal, failed, paused, pause, claim, adopt, readable, view };
