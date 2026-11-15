'use strict';

// 1.15.0 — files and pictures over a bridge (GateControl with gc.bridges version ≥ 4, feature-detected).
//
//   in    a contact's picture, video, voice message, file or sticker arrives as a placeholder that carries GateControl's
//         reference of the file (meta.bridge.ref, sealed like every meta; never an address of the bridge) and
//         messages.ext_media = 'wait'. This file fetches it afterwards — outside the transaction that filed the event,
//         one file after the other (the server's disk is slow) — with gc.bridges.media.fetch into the plugin's media:
//         GateControl streams it from the bridge, checks size and type like an own upload and runs its virus scan.
//         The message then becomes a normal picture / voice message / file (`media.scan` as for every file, later
//         results with the hook mediaScanned); the live event message.update { media: true } tells the person. A file
//         that cannot come keeps its placeholder with a reason: too_large, type, infected, quota, gone (the bridge lost
//         it) or unavailable (tried for days). A location has no file: its placeholder carries `geo`.
//   out   a picture, video, voice message or file of the person goes out only when GateControl's scan let it through,
//         and only in a type the bridge takes (OUT_TYPES, read from mautrix-whatsapp's pkg/connector/capabilities.go);
//         bridgechats.deliver hands it over as gc.bridges.send(…, { media }).
//   pictures  the picture of a chat (conversations.bridge_avatar → avatar_media_id) is fetched when it changes; a
//         contact's (bridge_contacts.avatar_ref) only once somebody sees one of their messages (avatar_want).
//         1.19.1: a picture that cannot come for now is tried again later (PICTURE_WAIT_MS …), never given up for good.
//
// No file is held twice in the plugin: it lies in GateControl's media store only, the plugin keeps its id.
//
// 1.17.0: the files of bridged chats (and the pictures of their chats and contacts) go into the media area AREA
// (plugin.json media.areas) — the administrator chooses where it lives under Einstellungen › Plugins › Messenger ›
// Speicherorte, the same storage targets Drive uses (a folder, a NAS over SMB / WebDAV, S3), and moves it there with
// one click. The area is sealed: other people's files are never readable files on a NAS. A file of the history waits
// until the person asks for it (ext_media 'ask', placeholder state 'on_request', POST messages/:id/fetch).

const store = require('./store');
const seal = require('./seal');
const live = require('./live');
const log = require('./log');
const scan = require('./scan');
const { iso } = require('./util');

const REF_RE = /^m[A-Za-z0-9_-]{40,700}$/;
const FILE_KINDS = ['image', 'video', 'audio', 'voice', 'file', 'sticker'];
const REASONS = ['too_large', 'type', 'infected', 'quota', 'gone', 'unavailable'];
const TRIES = 6;
const WAIT_MAX_MS = 3 * 86400000;
// 1.19.0: a file the host refuses for another reason than "the bridge is away" (a homeserver answer it does not read,
// a host call that timed out, …): a few runs, then the placeholder says so — never „wird geladen …“ for days
const FILE_TRIES = 5;
// the bridge or the scanner is away for now: wait (up to WAIT_MAX_MS), the next files would fail the same way
const TRANSIENT = ['ERR_BRIDGE_UNREACHABLE', 'ERR_BRIDGES_UNAVAILABLE', 'ERR_BUSY', 'ERR_RATE_LIMIT'];
// a placeholder that failed with one of these keeps its reference: „Erneut versuchen“ (POST messages/:id/fetch)
const RETRY_REASONS = ['unavailable'];
const WARN_MS = 3600000;
const warned = new Map(); // code|reason → last warning (one line per hour and kind of failure)
const RUN_FILES = 20;
const RUN_PICTURES = 10;
// 1.19.1: a picture that cannot come for now (the bridge away, an answer the host does not take — as before GateControl
// 1.278.1, when the homeserver answered without Content-Length) is tried again later, the wait doubling from
// PICTURE_WAIT_MS up to PICTURE_WAIT_MAX_MS — never given up for good. Only a final answer ends it (reasonOf).
const PICTURE_WAIT_MS = 5 * 60000;
const PICTURE_WAIT_MAX_MS = 6 * 3600000;
const PICTURE_SCAN = 200;
const pictureWait = new Map(); // `c<id>` / `k<id>` → not before (ms)
let picturesRepaired = false;
// what mautrix-whatsapp takes from GateControl (pkg/connector/capabilities.go; from-matrix.go reuploadFileToWhatsApp):
// pictures jpeg (png and webp converted), videos mp4, sound ogg (taken as Opus) / mp4 / aac / mpeg — no webm —, files of any type
const OUT_TYPES = { image: ['image/jpeg', 'image/png', 'image/webp'], voice: ['audio/ogg', 'audio/mp4', 'audio/aac', 'audio/mpeg'], video: ['video/mp4'] };
const SUPPORTS = ['image', 'video', 'voice', 'file'];
// 1.17.0: the media area of the bridged chats' files
const AREA = 'bruecken';
const AREA_LABEL = 'Medien und Anhänge aus Chats über andere Messenger';
let areaReady = false;
let areaFailedAt = 0;

/** Make the area once (GateControl with media areas); → true when files go into it. Never throws. */
async function ensureArea(gc) {
  if (areaReady) return true;
  const a = gc && gc.media && gc.media.areas;
  if (!a || typeof a.ensure !== 'function' || Date.now() - areaFailedAt < 3600000) return false;
  try { await a.ensure(AREA, { label: AREA_LABEL, sealed: true }); areaReady = true; } catch (e) {
    areaFailedAt = Date.now();
    gc.log.warn('media area not made', (e && (e.code || e.message)) || 'error');
  }
  return areaReady;
}
/** Keep a fetched file — in the area when there is one. */
async function claimFile(gc, mediaId) {
  if (await ensureArea(gc)) {
    try { await gc.media.claim(mediaId, { area: AREA }); return; } catch (e) { gc.log.warn('file not put into the area', (e && (e.code || e.message)) || 'error'); }
  }
  await gc.media.claim(mediaId);
}
/** The area for the admin card: { target, bytes, count, state, moving } or null. */
async function areaInfo(gc) {
  if (!(await ensureArea(gc))) return null;
  try {
    const i = await gc.media.areas.info(AREA);
    if (!i) return null;
    return { label: i.label, target: i.target ? { kind: i.target.kind, label: i.target.label || null } : { kind: 'server', label: null },
      bytes: i.bytes || 0, count: i.count || 0, state: i.state || 'ok', moving: i.moving ? { done: i.moving.done, total: i.moving.total } : null, encrypted: i.encrypted !== false };
  } catch { return null; }
}

/** gc.bridges with files (version ≥ 4), else null. */
function api(gc) {
  const b = require('./bridgechats').api(gc);
  return b && Number(b.version) >= 4 && b.media && typeof b.media.fetch === 'function' ? b : null;
}

/** gc.bridges with a new chat by number (version ≥ 4), else null. */
function newChatApi(gc) {
  const b = api(gc);
  return b && typeof b.resolve === 'function' && typeof b.createDm === 'function' ? b : null;
}

const int = (v, max) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 && n <= max ? n : null; };

/**
 * What a placeholder keeps of an event's `media` (in the message's sealed meta): kind and name as in 1.14.0, the
 * reference and what GateControl knows of the file, a location's geo. → meta.bridge
 */
function placeholderOf(m, kinds) {
  const kind = kinds.includes(m.kind) ? m.kind : 'file';
  const name = typeof m.name === 'string' ? m.name.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || null : null;
  const out = { placeholder: kind, name };
  if (kind === 'location' && m.geo && typeof m.geo === 'object') {
    const lat = Number(m.geo.lat);
    const lon = Number(m.geo.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) out.geo = { lat, lon };
  }
  if (FILE_KINDS.includes(kind) && REF_RE.test(String(m.ref || ''))) {
    out.ref = m.ref;
    out.mime = typeof m.mime === 'string' && /^[a-z][a-z0-9-]{0,30}\/[a-z0-9][a-z0-9.+_-]{0,99}$/.test(m.mime) ? m.mime : null;
    out.size = int(m.size, 1e13);
    out.w = int(m.w, 100000);
    out.h = int(m.h, 100000);
    out.durationMs = int(m.durationMs, 864e5);
    if (Array.isArray(m.waveform) && m.waveform.length) {
      // GateControl's voice messages carry at most 64 values 0…255; the bridge's 0…1024
      const w = m.waveform.slice(0, 64).map((x) => Math.max(0, Math.min(1024, Math.round(Number(x) || 0))));
      const k = Math.max(...w) > 255 ? 4 : 1;
      out.waveform = w.map((x) => Math.min(255, Math.round(x / k)));
    }
  }
  return out;
}

/** May the person ask for this file again (a failed placeholder that kept its reference)? */
const retriable = (bm, row) => !row.ext_media && RETRY_REASONS.includes(bm.reason) && REF_RE.test(String(bm.ref || ''));

/**
 * The view of a placeholder: { kind, name, state: 'loading' | 'on_request' | 'failed' | null, reason, retry?, geo? } —
 * null state: nothing to fetch; `retry` (1.19.0, only with state 'failed'): true → POST messages/:id/fetch asks for it
 * again („Erneut versuchen“).
 */
function placeholderView(bm, row) {
  const v = { kind: bm.placeholder, name: typeof bm.name === 'string' ? bm.name : null, state: null, reason: null };
  if (bm.geo) v.geo = bm.geo;
  if (row.ext_media === 'wait') v.state = 'loading';
  // 1.17.0: a file of the history — fetched when the person asks for it
  else if (row.ext_media === 'ask') v.state = 'on_request';
  else if (REASONS.includes(bm.reason)) { v.state = 'failed'; v.reason = bm.reason; v.retry = retriable(bm, row); }
  return v;
}

// ─── in ─────────────────────────────────────────────────────────────────────

/** The kind of a GateControl message for a fetched file. */
function kindOf(ph, mime) {
  if ((ph === 'image' || ph === 'sticker') && /^image\//.test(mime)) return 'image';
  if (ph === 'voice' && /^audio\//.test(mime)) return 'voice';
  return 'file';
}

/** A refusal of gc.bridges.media.fetch → a final reason, or null (try again later). */
function reasonOf(e) {
  switch (e && e.code) {
    case 'ERR_MEDIA_TOO_LARGE': return 'too_large';
    case 'ERR_MEDIA_TYPE': case 'ERR_MEDIA_EMPTY': return 'type';
    case 'ERR_MEDIA_INFECTED': return 'infected';
    case 'ERR_MEDIA_QUOTA': return 'quota';
    case 'ERR_INVALID': return 'gone';
    case 'ERR_BRIDGE': return e.reason === 'm_not_found' || e.reason === 'not_found' ? 'gone' : null;
    default: return null;
  }
}

const tries = new Map(); // what failed for now: `m<id>` / `c<id>` / `k<id>` → count

/** A refusal of the host, once an hour per kind in the plugin's log: code and reason only, never a reference or a name. */
function warnOnce(gc, what, e) {
  const code = String((e && e.code) || (e && /timed out/.test(String(e.message)) ? 'timeout' : 'error')).replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
  const reason = e && typeof e.reason === 'string' ? e.reason.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) : '';
  const k = `${what}|${code}|${reason}`;
  const now = Date.now();
  if (now - (warned.get(k) || 0) < WARN_MS) return;
  if (warned.size > 200) warned.clear();
  warned.set(k, now);
  gc.log.warn(what, reason ? `${code} ${reason}` : code);
}

function again(key) {
  const n = (tries.get(key) || 0) + 1;
  if (tries.size > 5000) tries.clear();
  tries.set(key, n);
  return n;
}

async function deleteFile(gc, mediaId) { try { await gc.media.delete(mediaId); } catch { /* unclaimed files go after 24 h anyway */ } }

/** The file of one waiting message. */
async function fetchFile(gc, b, row, box, maxBytes, now) {
  const messages = require('./messages');
  const meta = messages.metaOf(row) || {};
  const bm = meta.bridge && typeof meta.bridge === 'object' ? meta.bridge : {};
  const settle = async (reason, code = null) => {
    await store.tx(gc, async () => {
      const cur = await store.one(gc, 'SELECT * FROM messages WHERE id = ?', [row.id]);
      if (!cur || cur.ext_media !== 'wait') return;
      const m2 = messages.metaOf(cur) || {};
      // 1.19.0: a reason worth another try keeps what is needed for it (the reference and what was known of the file)
      if (m2.bridge) m2.bridge = RETRY_REASONS.includes(reason) && m2.bridge.ref ? { ...m2.bridge, reason } : { placeholder: m2.bridge.placeholder, name: m2.bridge.name || null, reason };
      await store.run(gc, 'UPDATE messages SET ext_media = NULL, meta_enc = ?, updated_at = ? WHERE id = ?', [seal.sealJson(m2), now, row.id]);
      live.queue(box, [row.bridge_owner], 'message.update', { conversationId: row.conv_id, messageId: row.id, editedAt: iso(now), media: true });
    });
    await log.add(gc, 'bridge_media_failed', code ? `${reason} ${code}` : reason, now);
  };
  if (!REF_RE.test(String(bm.ref || ''))) return settle('gone');
  // larger than the plugin takes: not even asked for
  if (maxBytes && bm.size && bm.size > maxBytes) return settle('too_large');
  let r;
  try {
    r = await b.media.fetch(row.bridge_owner, row.bridge_net, bm.ref, { name: bm.name || null });
  } catch (e) {
    warnOnce(gc, 'bridge file not fetched', e);
    const reason = reasonOf(e);
    if (reason) { tries.delete('m' + row.id); return settle(reason); }
    if (TRANSIENT.includes(e && e.code)) {
      // the bridge is away or busy: later — given up only after days
      if (now - Math.max(row.created_at, row.ext_asked_at || 0) > WAIT_MAX_MS) return settle('unavailable');
      return 'later';
    }
    // 1.19.0: anything else is tried a few times, then said — and the next files are tried meanwhile
    if (again('m' + row.id) >= FILE_TRIES) {
      tries.delete('m' + row.id);
      return settle('unavailable', String((e && e.code) || 'error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) + (e && typeof e.reason === 'string' ? `/${e.reason.replace(/[^A-Za-z0-9_]/g, '').slice(0, 30)}` : ''));
    }
    return 'failed';
  }
  tries.delete('m' + row.id);
  const sc = scan.norm(r.scan);
  const kind = kindOf(bm.placeholder, String(r.mime || ''));
  await store.tx(gc, async () => {
    const cur = await store.one(gc, 'SELECT * FROM messages WHERE id = ?', [row.id]);
    if (!cur || cur.ext_media !== 'wait' || cur.deleted_at) { await deleteFile(gc, r.mediaId); return; }
    await claimFile(gc, r.mediaId);
    await store.run(gc, `INSERT INTO media (media_id, conv_id, msg_id, role, kind, mime, bytes, owner_id, created_at, scan_state, scan_blocked, scan_finding)
      VALUES (?, ?, ?, 'file', ?, ?, ?, NULL, ?, ?, ?, ?)`, [r.mediaId, cur.conv_id, cur.id, kind, r.mime, r.bytes, now, ...scan.cols(sc)]);
    const m2 = messages.metaOf(cur) || {};
    const b2 = m2.bridge || bm;
    delete m2.bridge;
    if (kind === 'image') { if (b2.w && b2.h) { m2.w = b2.w; m2.h = b2.h; } }
    else if (kind === 'voice') { if (b2.durationMs) m2.durationMs = b2.durationMs; if (b2.waveform) m2.waveform = b2.waveform; }
    else {
      m2.fileName = (r.name || b2.name || 'file').slice(0, 200);
      if (/^video\//.test(String(r.mime))) m2.video = { durationMs: b2.durationMs || null, width: b2.w || null, height: b2.h || null };
      else if (b2.durationMs) m2.durationMs = b2.durationMs;
    }
    await store.run(gc, 'UPDATE messages SET kind = ?, media_id = ?, meta_enc = ?, ext_media = NULL, updated_at = ? WHERE id = ?', [kind, r.mediaId, seal.sealJson(m2), now, cur.id]);
    await store.run(gc, 'UPDATE conversations SET updated_at = ? WHERE id = ?', [now, cur.conv_id]);
    live.queue(box, [row.bridge_owner], 'message.update', { conversationId: cur.conv_id, messageId: cur.id, editedAt: iso(now), media: true, ...(sc ? { scan: sc } : {}) });
  });
  return true;
}

/** A picture (of a chat or a contact) → { mediaId, scan } or { final: true } (none) / null (try again). */
async function fetchPicture(gc, b, userId, net, ref, key, now) {
  let r;
  try { r = await b.media.fetch(userId, net, ref, { name: 'avatar' }); } catch (e) {
    warnOnce(gc, 'bridge picture not fetched', e);
    const reason = reasonOf(e);
    if (reason) { tries.delete(key); pictureWait.delete(key); await log.add(gc, 'bridge_picture_failed', reason, now); return { final: true }; }
    // 1.19.1: for now only — later again (until 1.19.0 it was given up after a few runs and never asked for again)
    const n = again(key);
    if (pictureWait.size > 5000) pictureWait.clear();
    pictureWait.set(key, now + Math.min(PICTURE_WAIT_MS * 2 ** Math.min(n - 1, 12), PICTURE_WAIT_MAX_MS));
    if (n === TRIES) await log.add(gc, 'bridge_picture_failed', 'unavailable', now);
    return null;
  }
  tries.delete(key);
  pictureWait.delete(key);
  if (!/^image\//.test(String(r.mime || ''))) { await deleteFile(gc, r.mediaId); return { final: true }; }
  return { mediaId: r.mediaId, mime: r.mime, bytes: r.bytes, scan: scan.norm(r.scan) };
}

async function chatPicture(gc, b, conv, box, now) {
  const ref = conv.bridge_avatar;
  const p = await fetchPicture(gc, b, conv.bridge_owner, conv.bridge_net, ref, 'c' + conv.id, now);
  if (!p) return;
  await store.tx(gc, async () => {
    const cur = await store.one(gc, 'SELECT * FROM conversations WHERE id = ?', [conv.id]);
    if (!cur || cur.bridge_avatar !== ref) { if (p.mediaId) await deleteFile(gc, p.mediaId); return; }
    if (!p.mediaId) { await store.run(gc, 'UPDATE conversations SET bridge_avatar_got = ? WHERE id = ?', [ref, conv.id]); return; }
    await claimFile(gc, p.mediaId);
    if (cur.avatar_media_id) await store.run(gc, 'UPDATE media SET orphan = 1 WHERE media_id = ?', [cur.avatar_media_id]);
    await store.run(gc, `INSERT INTO media (media_id, conv_id, msg_id, role, kind, mime, bytes, owner_id, created_at, scan_state, scan_blocked, scan_finding)
      VALUES (?, ?, NULL, 'avatar', 'avatar', ?, ?, ?, ?, ?, ?, ?)`, [p.mediaId, conv.id, p.mime, p.bytes, conv.bridge_owner, now, ...scan.cols(p.scan)]);
    await store.run(gc, 'UPDATE conversations SET avatar_media_id = ?, bridge_avatar_got = ?, updated_at = ? WHERE id = ?', [p.mediaId, ref, now, conv.id]);
    if (cur.last_msg_id) live.queue(box, [conv.bridge_owner], 'conversation.update', { conversationId: conv.id, reason: 'avatar' });
  });
}

async function contactPicture(gc, b, k, now) {
  const ref = k.avatar_ref;
  const p = await fetchPicture(gc, b, k.owner_id, k.network, ref, 'k' + k.id, now);
  if (!p) return;
  await store.tx(gc, async () => {
    const cur = await store.one(gc, 'SELECT * FROM bridge_contacts WHERE id = ?', [k.id]);
    if (!cur || cur.avatar_ref !== ref) { if (p.mediaId) await deleteFile(gc, p.mediaId); return; }
    if (!p.mediaId) { await store.run(gc, 'UPDATE bridge_contacts SET avatar_got = ? WHERE id = ?', [ref, k.id]); return; }
    await claimFile(gc, p.mediaId);
    if (cur.avatar_media_id) await store.run(gc, 'UPDATE media SET orphan = 1 WHERE media_id = ?', [cur.avatar_media_id]);
    // a contact's picture belongs to no chat (conv_id 0): only the person whose contact it is sees it (index.js mediaAccess)
    await store.run(gc, `INSERT INTO media (media_id, conv_id, msg_id, role, kind, mime, bytes, owner_id, created_at, scan_state, scan_blocked, scan_finding)
      VALUES (?, 0, NULL, 'avatar', 'avatar', ?, ?, ?, ?, ?, ?, ?)`, [p.mediaId, p.mime, p.bytes, k.owner_id, now, ...scan.cols(p.scan)]);
    await store.run(gc, 'UPDATE bridge_contacts SET avatar_media_id = ?, avatar_got = ? WHERE id = ?', [p.mediaId, ref, k.id]);
  });
}

/** One run: waiting files first (oldest first), then pictures. → { files, pictures } */
async function runOnce(gc) {
  const b = api(gc);
  if (!b) return { files: 0, pictures: 0 };
  const now = Date.now();
  const box = live.outbox();
  let maxBytes = null;
  try { const u = await gc.media.usage(); maxBytes = u && Number.isSafeInteger(u.maxBytes) ? u.maxBytes : null; } catch { maxBytes = null; }
  let files = 0;
  const rows = await store.all(gc, `SELECT m.*, c.bridge_owner, c.bridge_net FROM messages m JOIN conversations c ON c.id = m.conv_id
    WHERE m.ext_media = 'wait' AND c.bridge_net IS NOT NULL ORDER BY m.id LIMIT ?`, [RUN_FILES]);
  for (const row of rows) {
    let r = null;
    try { r = await fetchFile(gc, b, row, box, maxBytes, now); } catch (e) { gc.log.warn('bridge file failed', (e && (e.code || e.message)) || 'error'); }
    // the bridge does not answer: not asked for every other file now
    if (r === 'later') break;
    if (r === true) files++;
  }
  let pictures = 0;
  // 1.19.1: once per start, pictures noted as done without a file are asked for again — up to 1.19.0 a picture was
  // given up for good after a few failed runs (with GateControl before 1.278.1 every one: the homeserver answered
  // chunked), and a final answer may not be final any more (the file is back, the type is taken now)
  if (!picturesRepaired) {
    picturesRepaired = true;
    await store.tx(gc, async () => {
      await store.run(gc, `UPDATE conversations SET bridge_avatar_got = NULL WHERE bridge_net IS NOT NULL AND bridge_avatar IS NOT NULL
        AND bridge_avatar_got = bridge_avatar AND avatar_media_id IS NULL`);
      await store.run(gc, 'UPDATE bridge_contacts SET avatar_got = NULL WHERE avatar_ref IS NOT NULL AND avatar_got = avatar_ref AND avatar_media_id IS NULL');
    });
  }
  const due = (key) => !(pictureWait.get(key) > now);
  const convs = (await store.all(gc, `SELECT * FROM conversations WHERE bridge_net IS NOT NULL AND bridge_avatar IS NOT NULL
    AND (bridge_avatar_got IS NULL OR bridge_avatar_got <> bridge_avatar) LIMIT ?`, [PICTURE_SCAN])).filter((conv) => due('c' + conv.id));
  for (const conv of convs.slice(0, RUN_PICTURES)) {
    try { await chatPicture(gc, b, conv, box, now); pictures++; } catch (e) { gc.log.warn('bridge picture failed', (e && (e.code || e.message)) || 'error'); }
  }
  const contacts = (await store.all(gc, `SELECT * FROM bridge_contacts WHERE avatar_want = 1 AND avatar_ref IS NOT NULL
    AND (avatar_got IS NULL OR avatar_got <> avatar_ref) LIMIT ?`, [PICTURE_SCAN])).filter((k) => due('k' + k.id));
  for (const k of contacts.slice(0, RUN_PICTURES)) {
    try { await contactPicture(gc, b, k, now); pictures++; } catch (e) { gc.log.warn('bridge picture failed', (e && (e.code || e.message)) || 'error'); }
  }
  await live.flush(gc, box);
  return { files, pictures };
}

let running = null;
let more = false;

/** Fetch what waits — one run at a time; a call while one runs asks for another round. Never throws. */
function kick(gc) {
  if (!api(gc)) return Promise.resolve({ files: 0, pictures: 0 });
  if (running) { more = true; return running; }
  running = (async () => {
    let last = { files: 0, pictures: 0 };
    do {
      more = false;
      try { last = await runOnce(gc); } catch (e) { gc.log.warn('bridge files failed', (e && (e.code || e.message)) || 'error'); }
    } while (more);
    return last;
  })().finally(() => { running = null; });
  return running;
}

/**
 * 1.17.0: POST messages/:id/fetch — the person asks for a file of the history (1.19.0: or again for one that failed
 * with a reason worth another try). → true when it is on its way
 * (fetched by the next run, kick); false when there is nothing to ask for. Inside a transaction.
 */
async function ask(ctx, conv, row) {
  if (!conv.bridge_net || conv.bridge_owner !== ctx.viewer || row.deleted_at) return false;
  // 1.19.0: also a file that failed with a reason worth another try („Erneut versuchen“)
  const bm = (require('./messages').metaOf(row) || {}).bridge || {};
  if (row.ext_media !== 'ask' && !retriable(bm, row)) return false;
  tries.delete('m' + row.id);
  await store.run(ctx.gc, "UPDATE messages SET ext_media = 'wait', ext_asked_at = ?, updated_at = ? WHERE id = ?", [ctx.now, ctx.now, row.id]);
  live.queue(ctx.box, [ctx.viewer], 'message.update', { conversationId: conv.id, messageId: row.id, editedAt: iso(ctx.now), media: true });
  return true;
}

// ─── pictures that change, files that go ────────────────────────────────────

/** An event's chat.avatar (undefined: the event does not know it) → the conversation follows. Inside the filing transaction. */
async function chatAvatar(c, conv, ref) {
  if (ref === undefined || conv.bridge_avatar === (ref || null)) return;
  if (ref !== null && !REF_RE.test(String(ref))) return;
  if (ref === null && conv.avatar_media_id) {
    await store.run(c.gc, 'UPDATE media SET orphan = 1 WHERE media_id = ?', [conv.avatar_media_id]);
    await store.run(c.gc, 'UPDATE conversations SET bridge_avatar = NULL, bridge_avatar_got = NULL, avatar_media_id = NULL, updated_at = ? WHERE id = ?', [c.now, conv.id]);
    if (conv.last_msg_id) live.queue(c.box, [conv.bridge_owner], 'conversation.update', { conversationId: conv.id, reason: 'avatar' });
  } else {
    await store.run(c.gc, 'UPDATE conversations SET bridge_avatar = ? WHERE id = ?', [ref, conv.id]);
  }
  conv.bridge_avatar = ref;
  c.mediaWork = true;
}

/** A contact's picture (sender.avatar / contact.avatar) → the contact row follows. */
async function contactAvatar(c, row, ref) {
  if (ref === undefined || (row.avatar_ref || null) === (ref || null)) return;
  if (ref !== null && !REF_RE.test(String(ref))) return;
  if (ref === null && row.avatar_media_id) await store.run(c.gc, 'UPDATE media SET orphan = 1 WHERE media_id = ?', [row.avatar_media_id]);
  await store.run(c.gc, `UPDATE bridge_contacts SET avatar_ref = ?, avatar_got = CASE WHEN ? IS NULL THEN NULL ELSE avatar_got END,
    avatar_media_id = CASE WHEN ? IS NULL THEN NULL ELSE avatar_media_id END WHERE id = ?`, [ref, ref, ref, row.id]);
  if (ref && row.avatar_want) c.mediaWork = true;
}

/** Views of messages showed contacts whose picture is not fetched yet: from now on they are wanted. */
async function wantContacts(ctx, rows) {
  const ids = rows.filter((k) => k.avatar_ref && !k.avatar_want && k.avatar_got !== k.avatar_ref).map((k) => k.id);
  if (!ids.length || !api(ctx.gc)) return;
  await store.run(ctx.gc, `UPDATE bridge_contacts SET avatar_want = 1 WHERE id IN (${store.marks(ids.length)})`, ids);
  ctx.bridgeMediaWork = true;
}

/** A picture's media id as a view may show it: not held back by the virus scan. */
async function pictureOf(gc, mediaId) {
  if (!mediaId) return null;
  const m = await store.one(gc, 'SELECT scan_blocked, orphan FROM media WHERE media_id = ?', [mediaId]);
  return m && !m.scan_blocked && !m.orphan ? mediaId : null;
}

// ─── out ────────────────────────────────────────────────────────────────────

/** The kind towards the bridge of a GateControl message with a file: image | video | voice | file. */
function outKind(kind, mime) {
  if (kind === 'image') return 'image';
  if (kind === 'voice') return 'voice';
  return /^video\//.test(String(mime || '')) ? 'video' : 'file';
}

/** May this file go out over the bridge? → null, or the refusal's reason (the kind whose types it misses). */
function outRefusal(kind, mime) {
  const k = outKind(kind, mime);
  const list = OUT_TYPES[k];
  return !list || list.includes(String(mime || '').split(';')[0].trim().toLowerCase()) ? null : k;
}

/** What gc.bridges.send gets for a message with a file (row: the message, file: its media row). */
function outMedia(row, file) {
  const messages = require('./messages');
  const meta = messages.metaOf(row) || {};
  const kind = outKind(row.kind, file.mime);
  const out = { mediaId: row.media_id, kind };
  if (kind === 'image') { if (meta.w && meta.h) { out.w = meta.w; out.h = meta.h; } }
  else if (kind === 'voice') { if (meta.durationMs) out.durationMs = meta.durationMs; if (Array.isArray(meta.waveform)) out.waveform = meta.waveform; }
  else {
    if (meta.fileName) out.name = meta.fileName;
    const v = meta.video && typeof meta.video === 'object' ? meta.video : null;
    if (v) { if (v.durationMs) out.durationMs = v.durationMs; if (v.width && v.height) { out.w = v.width; out.h = v.height; } }
  }
  return out;
}

module.exports = {
  api, newChatApi, placeholderOf, placeholderView, kick, runOnce, chatAvatar, contactAvatar, wantContacts, pictureOf, ask, ensureArea, areaInfo, AREA,
  outKind, outRefusal, outMedia, OUT_TYPES, SUPPORTS, REF_RE, REASONS, FILE_KINDS, FILE_TRIES, RETRY_REASONS,
  _reset: () => { tries.clear(); warned.clear(); pictureWait.clear(); picturesRepaired = false; running = null; more = false; areaReady = false; areaFailedAt = 0; },
};
