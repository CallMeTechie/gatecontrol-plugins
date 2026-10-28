'use strict';

// The photo frame on the wall tablet (since 1.7.0): albums with `frame: true` (albums.js) as a slide show on a kiosk
// device — a browser GateControl keeps signed in as a kiosk account (paired by an administrator; the Familie plugin's
// wall tablet is one). The frame is the portal section "Fotorahmen" in GateControl's tab "Zuhause"
// (ui.portal.sections, `section=frame`), shown to kiosk devices only — `portalVisible` answers it for them, the
// rest of Drive stays closed to them (index.js: a kiosk viewer reaches `GET frame` and nothing else).
//
//   GET frame   (kiosk devices only) → { on, ready, seconds, order, items: [{ url, takenAt }] }
//
//   on      the setting frame_on, the kiosk account allowed (frame_accounts: names or ids; empty: every kiosk device)
//           and Drive licensed
//   ready   GateControl hands out preview-only URLs (≥ 1.210.0: gc.media.previews(…, { previewOnly: true })) —
//           without them no picture is shown at all: a kiosk device gets the large preview (fits 1280 × 1280 px, no
//           metadata, no location), never the file itself
//   items   the pictures (not videos) of every frame album, each once, ≤ 1000 — only what the person who switched the
//           album on reads now and while they still may switch it (albums.js mayFrame); no names, no folders.
//           `takenAt` lets the frame show the month. URLs valid 2 h, the frame asks again every 30 minutes.
//   seconds frame_seconds (5 … 3600), order frame_order: 'random' | 'date' (newest first)

const store = require('./store');
const nodes = require('./nodes');
const photos = require('./photos');
const albums = require('./albums');
const previews = require('./previews');
const { iso } = require('./util');

const ITEMS_MAX = 1000;
const URL_TTL_S = 7200;

/** The frame's settings from all plugin settings. */
function settingsOf(all) {
  const n = Number(all.frame_seconds);
  return {
    on: all.frame_on !== false && all.frame_on !== 'false',
    seconds: Number.isFinite(n) ? Math.min(3600, Math.max(5, Math.round(n))) : 20,
    order: all.frame_order === 'date' ? 'date' : 'random',
    accounts: typeof all.frame_accounts === 'string' ? all.frame_accounts.split(/[,;\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean) : [],
  };
}

/** May kiosk account `user` (with its name from the users) show the frame? */
function allowed(s, user, users) {
  if (!s.on) return false;
  if (!s.accounts.length) return true;
  const u = users.get(user.id);
  const name = String((u && u.name) || user.name || '').toLowerCase();
  return s.accounts.includes(String(user.id)) || (!!name && s.accounts.includes(name));
}

/** Is there an album on the frame at all? (portalVisible — cheap) */
async function any(gc) {
  return !!(await store.one(gc, 'SELECT id FROM albums WHERE frame = 1 LIMIT 1'));
}

/**
 * GET frame for kiosk viewer `user`. `asPerson(uid)` → the context of the person who switched an album on (their
 * rights now), or null (no seat, no licence, gone).
 */
async function show(gc, user, { settings, users, licensed, asPerson }) {
  const s = settingsOf(settings);
  const base = { on: false, ready: true, seconds: s.seconds, order: s.order, items: [] };
  if (!licensed || !allowed(s, user, users)) return base;
  const rows = await store.all(gc, 'SELECT * FROM albums WHERE frame = 1 AND frame_by IS NOT NULL ORDER BY id');
  const people = new Map();
  const seen = new Set();
  const picked = [];
  for (const a of rows) {
    if (!people.has(a.frame_by)) {
      let p = null;
      try { p = await asPerson(a.frame_by); } catch { p = null; }
      people.set(a.frame_by, p);
    }
    const p = people.get(a.frame_by);
    if (!p || !(await albums.mayFrame(p, a))) continue;
    const ids = (await p.visible()).map((x) => x.area.id);
    if (!ids.length) continue;
    const list = await store.all(gc, `SELECT id, media_id, taken_at, mtime, created_at FROM nodes WHERE id IN (SELECT node_id FROM album_items WHERE album_id = ?)
      AND area_id IN (${store.marks(ids.length)}) AND ${photos.MEDIA} AND mime LIKE 'image/%' AND media_id IS NOT NULL
      ORDER BY ${nodes.TAKEN} DESC, id DESC LIMIT ?`, [a.id, ...ids, ITEMS_MAX]);
    for (const n of list) if (!seen.has(n.id)) { seen.add(n.id); picked.push(n); }
  }
  const out = { ...base, on: true };
  if (!picked.length) return out;
  const { map, ready } = await previews.urls({ gc, viewer: user.id, app: false }, picked.map((n) => n.media_id), { user: user.id, ttlS: URL_TTL_S, previewOnly: true });
  if (!ready) return { ...out, ready: false };
  let items = picked.filter((n) => map.get(n.media_id)).map((n) => ({ url: map.get(n.media_id).largeUrl, takenAt: iso(nodes.takenOf(n)), t: nodes.takenOf(n) }));
  if (s.order === 'date') items.sort((x, y) => y.t - x.t);
  else items = shuffle(items);
  return { ...out, items: items.slice(0, ITEMS_MAX).map(({ url, takenAt }) => ({ url, takenAt })) };
}

/** A shuffled copy (Fisher–Yates). */
function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { show, any, allowed, settingsOf };
