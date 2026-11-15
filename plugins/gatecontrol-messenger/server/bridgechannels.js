'use strict';

// 1.20.0 — channels, read-only groups, format and link previews of bridged chats (GateControl with gc.bridges version 7,
// feature-detected; README "App-API", since 1.20.0).
//
//   channels   a channel the person follows at the other messenger (chat.channel) is a bridged conversation with
//              bridge_channel = 1: created muted (members.notify 'none' — the bell turns pushes on per channel), never in
//              GET conversations for a client that knows channels (?channels=1) and so never in its „Ungelesen“ or badge —
//              such a client lists them with GET channels. A client that does not know channels gets them as before (a
//              read-only chat). Sending is refused (bridge_read_only, reason channel).
//   read only  a group where only admins write (chat.readOnly): stays among the chats, can.send false with
//              can.sendReason 'admins_only'.
//   format     `marks` of a text (bold, italic, strike, code, link — offsets into the text) and `preview` of a link
//              (url, title, description, site, picture) kept in the message's sealed meta; the picture is fetched over the
//              bridge like every file (gc.bridges.media.fetch, virus scan) — ext_preview 'wait' → previewRun.
//   reactions  in a channel only the person's own (the bridge passes on no counts). When the bridge refuses one (at once
//              or as a 'failed' status of the reaction), reacting in channels is switched off for that network and
//              remembered (settings key REACT_OFF) — until the bridge runs another version.

const store = require('./store');
const seal = require('./seal');
const live = require('./live');
const log = require('./log');
const scan = require('./scan');
const { iso } = require('./util');

const line = (v, max) => (typeof v === 'string' ? v.slice(0, max * 4).replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

const MARK_TYPES = ['bold', 'italic', 'strike', 'code', 'link'];
const MARKS_MAX = 500;
const URL_MAX = 2000;
const REF_RE = /^m[A-Za-z0-9_-]{40,700}$/;
const MIME_RE = /^[a-z][a-z0-9-]{0,30}\/[a-z0-9][a-z0-9.+_-]{0,99}$/;
const REACT_OFF = 'bridgeChannelReactOff';
const PREVIEW_RUN = 20;
const PREVIEW_TRIES = 5;

/** gc.bridges with channels (version ≥ 7), else null. */
function api(gc) {
  const b = require('./bridgechats').api(gc);
  return b && Number(b.version) >= 7 ? b : null;
}

const int = (v, max) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 && n <= max ? n : null; };

/** An http(s) address, or null. */
function httpUrl(v) {
  if (typeof v !== 'string' || !v || v.length > URL_MAX) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password ? u.href : null;
}

/**
 * An event's marks for a text that lost `lead` characters at its start and is `len` long → what is kept (sorted,
 * inside the text, links http(s) only), or null.
 */
function cleanMarks(marks, len, lead = 0) {
  if (!Array.isArray(marks) || !len) return null;
  const out = [];
  for (const m of marks.slice(0, MARKS_MAX)) {
    if (!m || typeof m !== 'object' || !MARK_TYPES.includes(m.type)) continue;
    const start = Math.max(0, Number(m.start) - lead);
    const end = Math.min(len, Number(m.end) - lead);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) continue;
    if (m.type === 'link') {
      const url = httpUrl(m.url);
      if (url) out.push({ type: 'link', start, end, url });
      continue;
    }
    out.push({ type: m.type, start, end });
  }
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  return out.length ? out : null;
}

/** An event's link preview → what is kept in the meta, or null. */
function cleanPreview(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const url = httpUrl(p.url);
  if (!url) return null;
  const out = { url, title: line(p.title, 300) || null, description: line(p.description, 1000) || null, site: line(p.site, 100) || null, image: null };
  const im = p.image && typeof p.image === 'object' ? p.image : null;
  if (im && REF_RE.test(String(im.ref || ''))) {
    out.image = { ref: im.ref, mime: typeof im.mime === 'string' && MIME_RE.test(im.mime) ? im.mime : null, w: int(im.w, 100000), h: int(im.h, 100000), size: int(im.size, 1e9) };
  }
  return out;
}

/**
 * The view of a message's format and preview (only for a bridged chat; messages.view has them null):
 * marks → [{ type, start, end, url? }] | null; preview → { url, title, description, site, image } | null, image:
 * { mediaId, url (the portal; the apps load it by its id), mime, w, h, state: 'loading' | 'failed' | null } | null.
 */
async function viewFields(ctx, row, meta) {
  const marks = Array.isArray(meta.marks) && meta.marks.length ? meta.marks : null;
  const p = meta.preview && typeof meta.preview === 'object' ? meta.preview : null;
  if (!p) return { marks, preview: null };
  let image = null;
  if (p.image) {
    const i = p.image;
    let mediaId = null;
    if (i.mediaId) {
      const m = await store.one(ctx.gc, 'SELECT scan_blocked, orphan FROM media WHERE media_id = ?', [i.mediaId]);
      mediaId = m && !m.scan_blocked && !m.orphan ? i.mediaId : null;
    }
    let url = null;
    if (mediaId && ctx.portal) { try { url = await ctx.gc.media.url(mediaId, { user: ctx.viewer, ttlS: 6 * 3600 }); } catch { url = null; } }
    image = { mediaId, url, mime: i.mime || null, w: i.w || null, h: i.h || null, state: row.ext_preview === 'wait' ? 'loading' : (mediaId ? null : (i.failed ? 'failed' : null)) };
  }
  return { marks, preview: { url: p.url, title: p.title || null, description: p.description || null, site: p.site || null, image } };
}

// ─── reactions in channels ──────────────────────────────────────────────────

async function readOff(gc) {
  const r = await store.one(gc, 'SELECT value FROM settings WHERE key = ?', [REACT_OFF]);
  try { const v = r ? JSON.parse(r.value) : null; return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

/** The bridge's version of a network as GateControl names it (status()), or null. */
function bridgeVersion(ctxOrHost, net) {
  const h = ctxOrHost && ctxOrHost.bridgeState && ctxOrHost.bridgeState.host;
  const n = h && Array.isArray(h.networks) ? h.networks.find((x) => x.id === net) : null;
  return n && typeof n.version === 'string' ? n.version : null;
}

/**
 * May the person react in channels of this network? 'own' (their own reaction; the others' WhatsApp shows only in its
 * app) or 'off' (the bridge refused one — until it runs another version).
 */
async function reactState(ctx, net) {
  const off = (await readOff(ctx.gc))[net];
  if (!off) return 'own';
  const v = bridgeVersion(ctx, net);
  return off.version && v && v !== off.version ? 'own' : 'off';
}

/** The bridge refused a reaction in a channel: reacting in channels of this network goes off (logged once). */
async function reactRefused(c, net, version = null) {
  const all = await readOff(c.gc);
  if (all[net]) return;
  let v = version;
  if (!v) { try { const st = await c.gc.bridges.status(); v = bridgeVersion({ bridgeState: { host: st } }, net); } catch { v = null; } }
  all[net] = { at: c.now, version: v || null };
  await store.run(c.gc, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [REACT_OFF, JSON.stringify(all)]);
  await log.add(c.gc, 'bridge_channel_react_off', net, c.now);
}

// ─── the page „Kanäle“ ──────────────────────────────────────────────────────

/** GET channels → { channels: [conversation views], unread, serverTime } — the viewer's channels, the newest first. */
async function list(ctx, query) {
  const conversations = require('./conversations');
  const out = await conversations.list({ ...ctx, channels: true }, query, { channels: true });
  return { channels: out.conversations, removed: out.removed, unread: out.conversations.reduce((n, c) => n + (c.unread || 0), 0), serverTime: out.serverTime };
}

/** { count, unread } of the viewer's channels with a post — GET conversations?channels=1 names it (the TV symbol, its dot). */
async function summary(ctx) {
  const messages = require('./messages');
  let count = 0;
  let unread = 0;
  for (const me of await store.all(ctx.gc, `SELECT m.* FROM members m JOIN conversations c ON c.id = m.conv_id
    WHERE m.user_id = ? AND m.left_at IS NULL AND c.bridge_channel = 1 AND c.last_msg_id IS NOT NULL`, [ctx.viewer])) {
    count++;
    unread += await messages.unreadCount(ctx.gc, me);
  }
  return { count, unread };
}

// ─── the pictures of link previews ──────────────────────────────────────────

const tries = new Map();

/** Fetch waiting preview pictures (after bridgemedia's run; one at a time). Never throws. → fetched */
async function previewRun(gc) {
  const b = require('./bridgemedia').api(gc);
  if (!b) return 0;
  const messages = require('./messages');
  const now = Date.now();
  const box = live.outbox();
  let n = 0;
  const rows = await store.all(gc, `SELECT m.*, c.bridge_owner, c.bridge_net FROM messages m JOIN conversations c ON c.id = m.conv_id
    WHERE m.ext_preview = 'wait' AND c.bridge_net IS NOT NULL ORDER BY m.id LIMIT ?`, [PREVIEW_RUN]);
  for (const row of rows) {
    const meta = messages.metaOf(row) || {};
    const im = meta.preview && meta.preview.image;
    const settle = async (mediaId, mime, bytes, sc) => {
      await store.tx(gc, async () => {
        const cur = await store.one(gc, 'SELECT * FROM messages WHERE id = ?', [row.id]);
        if (!cur || cur.ext_preview !== 'wait' || cur.deleted_at) { if (mediaId) { try { await gc.media.delete(mediaId); } catch { /* unclaimed: goes by itself */ } } return; }
        const m2 = messages.metaOf(cur) || {};
        if (m2.preview && m2.preview.image) {
          if (mediaId) {
            // into the sealed media area of the bridged chats, like every file of them (bridgemedia.js)
            const bm = require('./bridgemedia');
            if (await bm.ensureArea(gc)) await gc.media.claim(mediaId, { area: bm.AREA }); else await gc.media.claim(mediaId);
            await store.run(gc, `INSERT INTO media (media_id, conv_id, msg_id, role, kind, mime, bytes, owner_id, created_at, scan_state, scan_blocked, scan_finding)
              VALUES (?, ?, ?, 'thumb', 'image', ?, ?, NULL, ?, ?, ?, ?)`, [mediaId, cur.conv_id, cur.id, mime, bytes, now, ...scan.cols(sc)]);
            m2.preview.image = { ...m2.preview.image, mediaId };
          } else m2.preview.image = { ...m2.preview.image, failed: true };
        }
        await store.run(gc, 'UPDATE messages SET ext_preview = NULL, meta_enc = ?, updated_at = ? WHERE id = ?', [seal.sealJson(m2), now, cur.id]);
        live.queue(box, [row.bridge_owner], 'message.update', { conversationId: cur.conv_id, messageId: cur.id, editedAt: iso(now), media: true });
      });
    };
    if (!im || !REF_RE.test(String(im.ref || ''))) { await settle(null); continue; }
    let r;
    try { r = await b.media.fetch(row.bridge_owner, row.bridge_net, im.ref, { name: 'preview' }); } catch (e) {
      const final = ['ERR_MEDIA_TOO_LARGE', 'ERR_MEDIA_TYPE', 'ERR_MEDIA_EMPTY', 'ERR_MEDIA_INFECTED', 'ERR_MEDIA_QUOTA', 'ERR_INVALID'].includes(e && e.code)
        || (e && e.code === 'ERR_BRIDGE' && (e.reason === 'm_not_found' || e.reason === 'not_found'));
      const k = (tries.get(row.id) || 0) + 1;
      if (tries.size > 5000) tries.clear();
      tries.set(row.id, k);
      if (final || k >= PREVIEW_TRIES) { tries.delete(row.id); await settle(null); }
      // the bridge is away: the next pictures would fail the same way
      if (e && (e.code === 'ERR_BRIDGE_UNREACHABLE' || e.code === 'ERR_BRIDGES_UNAVAILABLE')) break;
      continue;
    }
    tries.delete(row.id);
    if (!/^image\//.test(String(r.mime || ''))) { try { await gc.media.delete(r.mediaId); } catch { /* goes by itself */ } await settle(null); continue; }
    await settle(r.mediaId, r.mime, r.bytes, scan.norm(r.scan));
    n++;
  }
  await live.flush(gc, box);
  return n;
}

module.exports = { api, cleanMarks, cleanPreview, viewFields, reactState, reactRefused, bridgeVersion, list, summary, previewRun, REACT_OFF, _reset: () => tries.clear() };
