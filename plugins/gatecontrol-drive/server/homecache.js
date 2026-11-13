'use strict';

// The home cache (Zwischenspeicher im Heimnetz, since 1.20.0): GateControl ≥ 1.231.0 keeps files on the home gateways
// (Gateways › Zwischenspeicher, docs/plugins.md "Home cache"); an app in the home network loads them from there at LAN
// speed. Drive offers its own media (permissions.homeCache, gc.homeCache) — never another plugin's file:
//   drive   what people opened in the last 30 days (recent_opens: the apps, the PC, the portal — not a PC's sync) and
//           everything someone made "offline verfügbar" (offline_pins: a file, or a folder with what is below it)
//   photos  pictures and videos taken in the last 90 days (the originals)
//   vault   files of a vault the same way as drive (fetched in 30 days — cache_uses — or offline): ciphertext only, the
//           server never had anything else; GateControl keeps vault files only where an administrator switched it on
// Each offer carries the people who may see the file now (`userIds`: the readers of its area — areas.readers, seats,
// family roles, team members and groups, parents of a child while they may look in), at most 256 (those who opened or
// pinned it first). A gateway keeps a file only where one of them has devices; the hint goes only to one of them.
// Priority: offline 90 > opened in 7 days 70 > in 30 days 60 > photo of 30 days 40 > of 90 days 30. The same content
// in several files is one offer (GateControl keys its stock by sha256): its people united, the highest priority.
//
// The background run (every minute, jobs.js → tick) brings the stock in line — every 15 minutes (the gateways fetch
// their list as often) or the next minute after a change of "offline verfügbar", seats, team folders or the setting
// child_parents_view: offers what is new or changed (people, priority, kind, the file it comes from), withdraws what
// is gone (deleted, in the trash, held back by the virus scan, older than its time, nobody may see it any more, an
// archived team folder). At most LIMITS.calls (250) host calls a run, yielding in between; the rest the next minute. Idempotent:
// an unchanged offer is not sent again (table home_cache). Without a valid licence nothing changes.
//
// GET nodes/<id>/content of an app adds `lan: { url, sha256, tlsSha256, exp }` when GateControl has a hint for this
// request (gc.homeCache.lanHint with req — the app is in the home network of a gateway that holds the file, the person
// is one of the offer's people). The app loads `url` pinning `tlsSha256`, checks `sha256` and falls back to the normal
// download. Only for files Drive offered (no host call otherwise); never for the portal (a browser cannot pin).
// An older GateControl (no gc.homeCache) or one where the administrator did not confirm the permission: nothing of
// this — no `lan`, no offers; "offline verfügbar" is kept all the same and counts once the host has it.
//
// Previews (since 1.24.0, GateControl ≥ 1.249.0: gc.homeCache.previews): GateControl's preview pictures go to the stock
// as well, so the photo and file grids of the apps load at home from the gateway (a small preview is some 10–40 KB):
//   small   of every picture or video Drive offers (above) and of the newest PREVIEW_PHOTOS (8000) photos and videos of
//           any age (the photo grid scrolls back years) — priority 95, the first a gateway takes
//   large   of the pictures and videos offered with a priority of a photo of 30 days or more (offline, opened, new
//           photos) — priority 45 (the viewer)
// one offer per content and size (key 'ps:<key>' / 'pl:<key>', table home_cache.preview), the people as for the file.
// Only what GateControl has a preview of (gc.media.previews); one not made yet is made by GateControl and offered at a
// later run (ERR_PREVIEW_PENDING). Every node of an app's answer with an offered preview gets `preview.lan` /
// `preview.largeLan` (photo items: `previewLan` / `largeLan`) when GateControl has a hint for this request — one
// gc.homeCache.lanHints call per answer; the app loads it like a file's hint and falls back to the preview URL.
// An older GateControl: no previews in the stock, no hints for them (its offer would take the file instead).

const store = require('./store');
const areas = require('./areas');
const people = require('./people');
const nodes = require('./nodes');
const { fail, iso } = require('./util');

const DAY = 86400000;
const RECENT_DAYS = 30;
const PHOTO_DAYS = 90;
const RUN_MS = 15 * 60000;
// host calls (offer + withdraw) a run — the rest the next minute; a test may lower it
const LIMITS = { calls: 250 };
const YIELD_EVERY = 20;
const OFFERS_MAX = 5000;
const PHOTOS_MAX = 4000;
const PIN_FILES_MAX = 2000;
const CAND_MAX = 20000;
const PINS_MAX = 500;
const USES_KEEP = 200;
const USERS_MAX = 256;
const PRIO = { pin: 90, recent7: 70, recent: 60, photo30: 40, photo: 30, previewSmall: 95, previewLarge: 45 };
// previews (1.24.0): the newest photos and videos whose small preview goes to the stock, all previews together at most
const PREVIEW_PHOTOS = 8000;
const PREVIEWS_MAX = 12000;
const HINTS_BATCH = 500;
const PREVIEW_KEY = { small: 'ps:', large: 'pl:' };
const KINDS = new Set(['drive', 'photos', 'vault']);
const SHA_RE = /^[0-9a-f]{64}$/;
const MEDIA_SQL = "(mime LIKE 'image/%' OR mime LIKE 'video/%')";
// a file that can be offered: current content with media, not in the trash
const FILE_SQL = 'is_dir = 0 AND deleted_at IS NULL AND media_id IS NOT NULL AND size > 0';
// what the stock asks of a node (1.29.1; before: every column of up to 12 000 rows every run, which GateControl copies
// out of its database worker in one go)
const COLS = ['id', 'area_id', 'is_dir', 'media_id', 'size', 'sha256', 'mime', 'vault_id', 'taken_at', 'mtime', 'created_at', 'content_at', 'updated_at'];
const cols = (alias) => COLS.map((c) => (alias ? `${alias}.${c}` : c)).join(', ');
// rows of home_cache one INSERT writes (10 values each; GateControl takes 100 parameters a statement)
const WRITE_ROWS = 9;

// What only this process knows (1.29.1 — the fewer writes the better on a slow disk): per GateControl handle
// { again: the next run comes in a minute (the last one had more to do or failed), at: the last run }. After a restart
// of the plugin the stored state counts (home_cache_state.at): the run then comes within RUN_MS at the latest.
const memory = new WeakMap();
const mem = (gc) => { let m = memory.get(gc); if (!m) memory.set(gc, m = { again: false, at: null }); return m; };

/** Is GateControl's home cache there for Drive (GateControl ≥ 1.231.0, permissions.homeCache confirmed)? */
function available(gc) {
  const h = gc && gc.homeCache;
  return !!(h && typeof h.offer === 'function' && typeof h.withdraw === 'function' && typeof h.lanHint === 'function');
}

async function meta(gc, key) {
  const r = await store.one(gc, 'SELECT value FROM meta WHERE key = ?', [key]);
  return r ? r.value : null;
}

/** Only a changed value is written (1.27.1: the dirty mark was written again with every change of a file). */
async function setMeta(gc, key, value) {
  if ((await meta(gc, key)) === String(value)) return { changes: 0 };
  return store.run(gc, 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
}

/** Does GateControl take previews in the home cache (≥ 1.249.0: gc.homeCache.previews, lanHints, gc.media.previews)? */
function previewsAvailable(gc) {
  return available(gc) && gc.homeCache.previews === true && typeof gc.homeCache.lanHints === 'function'
    && !!gc.media && typeof gc.media.previews === 'function';
}

/** Something that changes the stock happened (offline, seats, team folders, settings): the next run comes at once. */
async function touch(gc) {
  try { await setMeta(gc, 'home_cache_dirty', '1'); } catch (e) { gc.log.warn('home cache mark failed', (e && e.code) || 'error'); }
}

// ─── "Offline verfügbar" (feature `offline`) ─────────────────────

/** GET offline → { items: [node + offlineAt] } — what I keep offline and still may read (newest first). */
async function pins(ctx) {
  const rows = await store.all(ctx.gc, `SELECT n.*, p.at AS offline_at FROM offline_pins p JOIN nodes n ON n.id = p.node_id
    WHERE p.user_id = ? AND n.deleted_at IS NULL ORDER BY p.at DESC, p.node_id DESC`, [ctx.viewer]);
  const vis = new Set((await ctx.visible()).map((v) => v.area.id));
  return { items: rows.filter((r) => vis.has(r.area_id)).map((r) => nodes.view(r, { offline: true, offlineAt: iso(r.offline_at) })) };
}

/** PUT nodes/<id>/offline → { node } — a file or a folder I may read, at most PINS_MAX a person. */
async function pin(ctx, id) {
  const { node } = await nodes.reach(ctx, id);
  const have = await store.one(ctx.gc, 'SELECT at FROM offline_pins WHERE user_id = ? AND node_id = ?', [ctx.viewer, node.id]);
  if (!have) {
    const n = await store.one(ctx.gc, 'SELECT COUNT(*) AS n FROM offline_pins WHERE user_id = ?', [ctx.viewer]);
    if (n.n >= PINS_MAX) throw fail('invalid', { field: 'offline', max: PINS_MAX });
    await store.run(ctx.gc, 'INSERT INTO offline_pins (user_id, node_id, at) VALUES (?, ?, ?)', [ctx.viewer, node.id, ctx.now]);
    await touch(ctx.gc);
  }
  return { node: nodes.view(node, { offline: true, offlineAt: iso(have ? have.at : ctx.now) }) };
}

/** DELETE nodes/<id>/offline → { id, offline: false } — also for a node I no longer may read or that is gone. */
async function unpin(ctx, id) {
  const r = await store.run(ctx.gc, 'DELETE FROM offline_pins WHERE user_id = ? AND node_id = ?', [ctx.viewer, id]);
  if (r && r.changes) await touch(ctx.gc);
  return { id, offline: false, removed: !!(r && r.changes) };
}

/**
 * A file of a vault fetched by the viewer (GET nodes/<id>/content): kept for the home cache, like recent_opens for the
 * rest — not what a PC fetches for a folder it syncs (`synced`: overview.js). Best effort.
 */
async function noteUse(ctx, n, synced) {
  try {
    if (!n || n.is_dir === 1 || !n.vault_id || !n.media_id) return false;
    if (await synced(n)) return false;
    await store.run(ctx.gc, `INSERT INTO cache_uses (user_id, node_id, at) VALUES (?, ?, ?)
      ON CONFLICT(user_id, node_id) DO UPDATE SET at = excluded.at`, [ctx.viewer, n.id, ctx.now]);
    await store.run(ctx.gc, `DELETE FROM cache_uses WHERE user_id = ? AND node_id NOT IN (
      SELECT node_id FROM cache_uses WHERE user_id = ? ORDER BY at DESC LIMIT ?)`, [ctx.viewer, ctx.viewer, USES_KEEP]);
    return true;
  } catch (e) {
    ctx.gc.log.warn('home cache use failed', (e && e.code) || 'error');
    return false;
  }
}

// ─── The hint for an app in the home network ─────────────────────

/** A hint of GateControl as the apps get it, else null. */
function hintOf(h) {
  if (!h || typeof h !== 'object') return null;
  const sha = typeof h.sha256 === 'string' ? h.sha256.toLowerCase() : '';
  if (typeof h.url !== 'string' || !/^https:\/\//.test(h.url) || !SHA_RE.test(sha) || typeof h.tlsSha256 !== 'string' || !h.tlsSha256 || !Number.isFinite(h.exp)) return null;
  return { url: h.url, sha256: sha, tlsSha256: h.tlsSha256, exp: h.exp };
}

/**
 * `lan` for node row `n` in app request `req` → { url, sha256, tlsSha256, exp } | null. Never fails the request; asks
 * GateControl only for content Drive offered.
 */
async function lanOf(ctx, req, n) {
  try {
    if (!ctx.app || !n || !n.media_id || !available(ctx.gc) || !req || typeof req.homeRef !== 'string') return null;
    const own = await store.one(ctx.gc, 'SELECT 1 AS x FROM home_cache WHERE offered = 1 AND preview IS NULL AND (media_id = ? OR (sha256 IS NOT NULL AND sha256 = ?))', [n.media_id, String(n.sha256 || '').toLowerCase()]);
    if (!own) return null;
    return hintOf(await ctx.gc.homeCache.lanHint({ mediaId: n.media_id }, req));
  } catch (e) {
    ctx.gc.log.warn('home cache hint failed', (e && e.code) || 'error');
    return null;
  }
}

/**
 * The hints of the previews in an app's answer (1.24.0): every file node with a preview (`preview: { url, largeUrl }`)
 * gets `preview.lan` / `preview.largeLan`, every photo item (`previewUrl`) `previewLan` / `largeLan` — only for previews
 * Drive offered and GateControl has a hint for in this request (the app at home, the gateway holds it, the person one of
 * the offer's people). In place, one host call per 500 previews; never fails the answer.
 */
async function attachLan(ctx, req, body, nodeList) {
  try {
    if (!ctx.app || !body || !req || typeof req.homeRef !== 'string' || !previewsAvailable(ctx.gc)) return body;
    const targets = []; // { mediaId, sha, set(size, hint) }
    for (const n of nodeList || []) {
      if (n && n.mediaId && n.preview && typeof n.preview === 'object') {
        targets.push({ mediaId: n.mediaId, sha: n.sha256, set: (size, h) => { n.preview[size === 'small' ? 'lan' : 'largeLan'] = h; } });
      }
    }
    if (Array.isArray(body.items)) {
      for (const it of body.items) {
        if (it && it.mediaId && typeof it.previewUrl === 'string' && typeof it.isDir !== 'boolean') {
          targets.push({ mediaId: it.mediaId, sha: it.sha256, set: (size, h) => { it[size === 'small' ? 'previewLan' : 'largeLan'] = h; } });
        }
      }
    }
    if (!targets.length) return body;
    // the offered previews of these files: by their content (the same picture in two files is one offer) or media id
    const keyOf = (t) => (t.sha && SHA_RE.test(String(t.sha).toLowerCase()) ? String(t.sha).toLowerCase() : `m:${t.mediaId}`);
    const keys = [];
    for (const t of targets) for (const p of Object.values(PREVIEW_KEY)) keys.push(p + keyOf(t));
    const rows = [];
    const mediaIds = [...new Set(targets.map((t) => t.mediaId))];
    for (const part of store.chunks([...new Set(keys)])) {
      rows.push(...await store.all(ctx.gc, `SELECT key, media_id, preview FROM home_cache WHERE offered = 1 AND preview IS NOT NULL AND key IN (${store.marks(part.length)})`, part));
    }
    for (const part of store.chunks(mediaIds)) {
      rows.push(...await store.all(ctx.gc, `SELECT key, media_id, preview FROM home_cache WHERE offered = 1 AND preview IS NOT NULL AND media_id IN (${store.marks(part.length)})`, part));
    }
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const byMedia = new Map(rows.map((r) => [`${r.preview}:${r.media_id}`, r]));
    const asks = []; // { t, size, mediaId }
    for (const t of targets) {
      for (const [size, p] of Object.entries(PREVIEW_KEY)) {
        const r = byKey.get(p + keyOf(t)) || byMedia.get(`${size}:${t.mediaId}`);
        if (r) asks.push({ t, size, mediaId: r.media_id });
      }
    }
    for (let i = 0; i < asks.length; i += HINTS_BATCH) {
      const part = asks.slice(i, i + HINTS_BATCH);
      const got = await ctx.gc.homeCache.lanHints(part.map((x) => ({ mediaId: x.mediaId, preview: x.size })), req);
      part.forEach((x, j) => { const h = hintOf(Array.isArray(got) ? got[j] : null); if (h) x.t.set(x.size, h); });
    }
  } catch (e) {
    ctx.gc.log.warn('home cache preview hints failed', (e && e.code) || 'error');
  }
  return body;
}

// ─── What should be in the stock ─────────────────────────────────

const takenOf = (n) => (n.taken_at != null ? n.taken_at : (n.mtime != null ? n.mtime : n.created_at));

async function rowsByIds(gc, ids) {
  const out = [];
  for (const part of store.chunks([...new Set(ids)])) {
    out.push(...await store.all(gc, `SELECT ${cols()} FROM nodes WHERE id IN (${store.marks(part.length)}) AND ${FILE_SQL}`, part));
  }
  return out;
}

/** The files below folder `id` (not in the trash), at most `max`. */
function filesBelow(gc, id, max) {
  return store.all(gc, `WITH RECURSIVE d(id) AS (
      SELECT id FROM nodes WHERE parent_id = ? AND deleted_at IS NULL
      UNION ALL SELECT n.id FROM nodes n JOIN d ON n.parent_id = d.id WHERE n.deleted_at IS NULL)
    SELECT ${cols('n')} FROM nodes n JOIN d ON n.id = d.id WHERE n.${FILE_SQL.replace(/ AND /g, ' AND n.')} LIMIT ?`, [id, max]);
}

/**
 * The stock as it should be → Map key → { key, mediaIds: [..], kind, priority, users: [ids] } (≤ OFFERS_MAX, the
 * highest priorities); the people of an area: areas.readers, as they may see it now.
 */
async function wanted(gc, now, settings, { previews = false } = {}) {
  const blocked = new Set((await store.all(gc, 'SELECT media_id FROM media_scan WHERE blocked = 1')).map((r) => r.media_id));
  const areaRows = new Map((await store.all(gc, 'SELECT * FROM areas')).map((a) => [a.id, a]));
  const readersOf = new Map();
  const readers = async (areaId) => {
    if (readersOf.has(areaId)) return readersOf.get(areaId);
    const a = areaRows.get(areaId);
    let set = new Set();
    if (a && a.archived_at == null) {
      try { set = new Set(await areas.readers(gc, a, settings)); } catch (e) { gc.log.warn('home cache readers failed', (e && e.code) || 'error'); set = null; }
    }
    readersOf.set(areaId, set);
    return set;
  };
  const cand = new Map(); // node id → { n, prio, kind, involved: Set }
  const add = async (n, prio, kind, who) => {
    if (blocked.has(n.media_id)) return;
    const rs = await readers(n.area_id);
    if (rs === null) throw fail('internal');
    if (!rs.size || (who != null && !rs.has(who))) return;
    const k = n.vault_id ? 'vault' : kind;
    const c = cand.get(n.id) || { n, prio: 0, kind: k, involved: new Set() };
    if (prio > c.prio) { c.prio = prio; c.kind = k; }
    if (who != null) c.involved.add(who);
    cand.set(n.id, c);
  };
  // offline: files and what is below folders
  const pinRows = await store.all(gc, `SELECT p.user_id, ${cols('n')} FROM offline_pins p JOIN nodes n ON n.id = p.node_id WHERE n.deleted_at IS NULL ORDER BY p.at DESC`);
  for (const p of pinRows) {
    if (cand.size >= CAND_MAX) break;
    const list = p.is_dir === 1 ? await filesBelow(gc, p.id, PIN_FILES_MAX) : (p.media_id && p.size > 0 ? [p] : []);
    for (const n of list) await add(n, PRIO.pin, 'drive', p.user_id);
  }
  // opened (and vault files fetched) in the last 30 days
  const since = now - RECENT_DAYS * DAY;
  const opens = await store.all(gc, `SELECT user_id, node_id, at FROM recent_opens WHERE at >= ?
    UNION ALL SELECT user_id, node_id, at FROM cache_uses WHERE at >= ?`, [since, since]);
  const byId = new Map((await rowsByIds(gc, opens.map((r) => r.node_id))).map((n) => [n.id, n]));
  for (const r of opens) {
    if (cand.size >= CAND_MAX) break;
    const n = byId.get(r.node_id);
    if (n) await add(n, now - r.at <= 7 * DAY ? PRIO.recent7 : PRIO.recent, 'drive', r.user_id);
  }
  // photos of the last 90 days (not a vault's), newest first. With previews the newest PREVIEW_PHOTOS photos are read
  // for the grid anyway (below): the photos of 90 days are the first of them (1.29.1: one statement, not two)
  const PHOTO_SQL = `SELECT ${cols()} FROM nodes WHERE is_dir = 0 AND deleted_at IS NULL AND vault_id IS NULL AND ${MEDIA_SQL} AND media_id IS NOT NULL AND size > 0`;
  const grid = previews ? await store.all(gc, `${PHOTO_SQL} ORDER BY COALESCE(taken_at, mtime, created_at) DESC LIMIT ?`, [PREVIEW_PHOTOS]) : null;
  const photos = grid && PREVIEW_PHOTOS >= PHOTOS_MAX ? grid.filter((n) => takenOf(n) >= now - PHOTO_DAYS * DAY).slice(0, PHOTOS_MAX)
    : await store.all(gc, `${PHOTO_SQL} AND COALESCE(taken_at, mtime, created_at) >= ? ORDER BY COALESCE(taken_at, mtime, created_at) DESC LIMIT ?`, [now - PHOTO_DAYS * DAY, PHOTOS_MAX]);
  for (const n of photos) await add(n, now - takenOf(n) <= 30 * DAY ? PRIO.photo30 : PRIO.photo, 'photos', null);

  // one offer per content: its people united, the highest priority (and its kind)
  const groups = new Map();
  for (const c of cand.values()) {
    const key = c.n.sha256 && SHA_RE.test(String(c.n.sha256).toLowerCase()) ? String(c.n.sha256).toLowerCase() : `m:${c.n.media_id}`;
    const g = groups.get(key) || { key, mediaIds: [], kind: c.kind, priority: 0, involved: new Set(), readers: new Set(), recent: 0 };
    g.mediaIds.push(c.n.media_id);
    if (c.prio > g.priority) { g.priority = c.prio; g.kind = c.kind; }
    for (const u of c.involved) g.involved.add(u);
    for (const u of readersOf.get(c.n.area_id) || []) g.readers.add(u);
    g.recent = Math.max(g.recent, c.n.content_at || c.n.updated_at || 0);
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((a, b) => b.priority - a.priority || b.recent - a.recent || (a.key < b.key ? -1 : 1)).slice(0, OFFERS_MAX);
  const usersOf = (g) => {
    // the people who opened or pinned it first, then the others — at most 256
    const first = [...g.involved].filter((u) => g.readers.has(u)).sort((a, b) => a - b);
    const rest = [...g.readers].filter((u) => !g.involved.has(u)).sort((a, b) => a - b);
    return [...first, ...rest].slice(0, USERS_MAX).sort((a, b) => a - b);
  };
  const out = new Map();
  for (const g of list) {
    out.set(g.key, { key: g.key, mediaIds: g.mediaIds.sort(), kind: g.kind, priority: g.priority, users: usersOf(g), preview: null });
  }
  if (!previews) return out;

  // previews (1.24.0): small ones of the pictures and videos offered and of the newest photos, large ones of the
  // pictures and videos offered with the priority of a new photo or more
  const isMedia = (n) => /^(image|video)\//.test(String(n.mime || '')) && !n.vault_id;
  const pv = new Map(); // key → group as above (+ large)
  const addPreview = (key, n, kind, involved, large, recent) => {
    const g = pv.get(key) || { key, mediaIds: [], kind, involved: new Set(), readers: new Set(), large: false, recent: 0 };
    if (!g.mediaIds.includes(n.media_id)) g.mediaIds.push(n.media_id);
    // a file someone keeps or opened (drive) before a photo of the grid (photos)
    if (kind === 'drive') g.kind = 'drive';
    for (const u of involved) g.involved.add(u);
    for (const u of readersOf.get(n.area_id) || []) g.readers.add(u);
    g.large = g.large || large;
    g.recent = Math.max(g.recent, recent || 0);
    pv.set(key, g);
  };
  const contentKey = (n) => (n.sha256 && SHA_RE.test(String(n.sha256).toLowerCase()) ? String(n.sha256).toLowerCase() : `m:${n.media_id}`);
  for (const c of cand.values()) {
    const key = contentKey(c.n);
    if (!out.has(key) || !isMedia(c.n)) continue;
    addPreview(key, c.n, c.kind, c.involved, c.prio >= PRIO.photo30, takenOf(c.n));
  }
  for (const n of grid) {
    if (blocked.has(n.media_id)) continue;
    const rs = await readers(n.area_id);
    if (rs === null) throw fail('internal');
    if (!rs.size) continue;
    addPreview(contentKey(n), n, 'photos', [], false, takenOf(n));
  }
  const entries = [];
  for (const g of [...pv.values()].sort((a, b) => b.recent - a.recent || (a.key < b.key ? -1 : 1))) {
    const users = usersOf(g);
    const mediaIds = g.mediaIds.sort();
    entries.push({ key: PREVIEW_KEY.small + g.key, mediaIds, kind: g.kind, priority: PRIO.previewSmall, users, preview: 'small' });
    if (g.large) entries.push({ key: PREVIEW_KEY.large + g.key, mediaIds, kind: g.kind, priority: PRIO.previewLarge, users, preview: 'large' });
  }
  // the small ones first (newest first), then the large ones — at most PREVIEWS_MAX
  entries.sort((a, b) => (a.preview === b.preview ? 0 : (a.preview === 'small' ? -1 : 1)));
  for (const e of entries.slice(0, PREVIEWS_MAX)) out.set(e.key, e);
  return out;
}

// ─── The run ─────────────────────────────────────────────────────

const pause = () => new Promise((resolve) => setImmediate(resolve));
// errors of one file: the next file goes on (GateControl's media is gone, the file has no sha256 …)
const ONE_FILE = new Set(['ERR_NOT_FOUND', 'ERR_INVALID']);

async function state(gc) {
  try { const st = JSON.parse((await meta(gc, 'home_cache_state')) || 'null'); return st && typeof st === 'object' ? st : null; } catch { return null; }
}

/**
 * Is a run due (every RUN_MS; at once when marked dirty or the last run had more to do or failed)? The last run: what
 * this process knows, after a restart home_cache_state.at (1.29.1; the key home_cache_at of older versions is no
 * longer written — one write a run less).
 */
async function due(gc, now) {
  const m = mem(gc);
  if (m.again || (await meta(gc, 'home_cache_dirty')) === '1') return true;
  if (m.at == null) { const st = await state(gc); m.at = st && Number.isFinite(st.at) ? st.at : NaN; }
  return !(Number.isFinite(m.at) && now >= m.at && now - m.at < RUN_MS);
}

/**
 * The state of the last run for the administrator (summary). A run that failed like the one before it writes it again
 * only after RUN_MS — not every minute while GateControl cannot be reached.
 */
async function saveState(gc, now, extra) {
  const n = await store.one(gc, 'SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM home_cache WHERE offered = 1 AND preview IS NULL');
  const next = { at: now, files: n.n, bytes: n.bytes, ...extra };
  if (next.error) {
    const st = await state(gc);
    if (st && st.error === next.error && st.files === next.files && st.bytes === next.bytes && Number.isFinite(st.at) && now >= st.at && now - st.at < RUN_MS) return;
  }
  await setMeta(gc, 'home_cache_state', JSON.stringify(next));
}

const HC_SQL = `INSERT INTO home_cache (key, media_id, sha256, size, kind, priority, users, offered, at, preview) VALUES %s
  ON CONFLICT(key) DO UPDATE SET media_id = excluded.media_id, sha256 = excluded.sha256, size = excluded.size, kind = excluded.kind,
    priority = excluded.priority, users = excluded.users, offered = excluded.offered, at = excluded.at, preview = excluded.preview`;

/**
 * What a run changed in home_cache — rows gone (`gone`: keys) and rows offered (`rows`: their ten values each) — in one
 * transaction, several rows a statement (1.29.1; before: one write per file, up to 250 a run). In the order they
 * happened: a key that went and came back in the same run is there.
 */
async function writeStock(gc, pending) {
  const list = pending.splice(0);
  if (!list.length) return;
  await store.tx(gc, async () => {
    let i = 0;
    while (i < list.length) {
      const kind = list[i].gone ? 'gone' : 'row';
      const part = [];
      const max = kind === 'gone' ? store.CHUNK : WRITE_ROWS;
      while (i < list.length && part.length < max && (list[i].gone ? 'gone' : 'row') === kind) part.push(list[i++]);
      if (kind === 'gone') await store.run(gc, `DELETE FROM home_cache WHERE key IN (${store.marks(part.length)})`, part.map((x) => x.gone));
      else await store.run(gc, HC_SQL.replace('%s', part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')), part.flatMap((x) => x.row));
    }
  });
}

/**
 * The background run (jobs.js, every minute): the stock in line with what should be in it → { offered, withdrawn,
 * unchanged, more } | { skipped }. Never throws.
 */
async function tick(gc, now = Date.now(), settings = null) {
  if (!available(gc)) return { skipped: 'unavailable' };
  const m = mem(gc);
  // what the run changed in home_cache, written together (writeStock) — also what a run that fails had done by then
  const pending = [];
  try {
    if (!(await due(gc, now))) return { skipped: 'not_due' };
    if (!(await people.licence(gc)).valid) return { skipped: 'not_licensed' };
    // the marks of offline and uses that went too old (uses: 30 days)
    await store.run(gc, 'DELETE FROM cache_uses WHERE at < ?', [now - RECENT_DAYS * DAY]);
    // dirty off before the work: a change during the run marks it again
    await setMeta(gc, 'home_cache_dirty', '0');
    m.again = false;
    const withPreviews = previewsAvailable(gc);
    const want = await wanted(gc, now, settings || await areas.settingsOf(gc), { previews: withPreviews });
    const have = new Map((await store.all(gc, 'SELECT * FROM home_cache')).map((r) => [r.key, r]));
    const H = gc.homeCache;
    // a GateControl without previews (again): its offer and withdraw know no `preview` — rows of previews go here only
    if (!withPreviews) {
      for (const [key, r] of have) {
        if (!r.preview) continue;
        pending.push({ gone: key });
        have.delete(key);
      }
    }
    // previews: only of files GateControl has one of (or makes one of) — asked for what is new or changed
    const previewOk = new Set();
    if (withPreviews) {
      const ids = new Set();
      for (const w of want.values()) {
        if (!w.preview) continue;
        const r = have.get(w.key);
        if (r && w.mediaIds.includes(r.media_id) && r.kind === w.kind && r.priority === w.priority && r.users === JSON.stringify(w.users)) continue;
        for (const id of w.mediaIds) ids.add(id);
      }
      const list = [...ids];
      for (let i = 0; i < list.length; i += 1000) {
        const states = await gc.media.previews(list.slice(i, i + 1000), {});
        for (const [id, st] of Object.entries(states || {})) if (st) previewOk.add(id);
      }
    }
    let calls = 0;
    let more = false;
    const out = { offered: 0, withdrawn: 0, unchanged: 0, failed: 0 };
    const step = async () => { calls++; if (calls % YIELD_EVERY === 0) await pause(); };
    // first what has to go (deleted, nobody may see it any more, too old …)
    for (const [key, r] of have) {
      if (want.has(key)) continue;
      if (calls >= LIMITS.calls) { more = true; break; }
      await step();
      try { await (r.preview ? H.withdraw(r.media_id, { preview: r.preview }) : H.withdraw(r.media_id)); } catch (e) {
        if (!ONE_FILE.has(e && e.code)) throw e;
      }
      pending.push({ gone: key });
      out.withdrawn++;
    }
    // then what is new or changed, the highest priority first
    for (const w of want.values()) {
      const r = have.get(w.key);
      const users = JSON.stringify(w.users);
      // the file it comes from: the one offered before while it is still one of them (a preview: one GateControl has)
      const from = w.preview ? w.mediaIds.filter((id) => previewOk.has(id) || (r && r.media_id === id)) : w.mediaIds;
      const mediaId = r && from.includes(r.media_id) ? r.media_id : from[0];
      if (r && r.media_id === mediaId && r.kind === w.kind && r.priority === w.priority && r.users === users) { out.unchanged++; continue; }
      // no preview of it (a document, a video without the device's picture): not offered, asked again at a later run
      if (!mediaId) continue;
      if (calls >= LIMITS.calls) { more = true; break; }
      if (!KINDS.has(w.kind)) continue;
      await step();
      let got;
      try {
        got = await H.offer({ mediaId, kind: w.kind, userIds: w.users, priority: w.priority, ...(w.preview ? { preview: w.preview } : {}) });
      } catch (e) {
        // GateControl makes the preview now: offered at a later run
        if (w.preview && e && e.code === 'ERR_PREVIEW_PENDING') { out.pending = (out.pending || 0) + 1; continue; }
        if (!ONE_FILE.has(e && e.code)) throw e;
        out.failed++;
        // a stale row of this content goes; GateControl drops the offer of a deleted file itself
        if (r) {
          try { await (r.preview ? H.withdraw(r.media_id, { preview: r.preview }) : H.withdraw(r.media_id)); } catch { /* best effort */ }
          pending.push({ gone: w.key });
        }
        continue;
      }
      const sha = got && typeof got.sha256 === 'string' && SHA_RE.test(got.sha256.toLowerCase()) ? got.sha256.toLowerCase() : null;
      const size = got && Number.isSafeInteger(got.size) ? got.size : 0;
      pending.push({ row: [w.key, mediaId, sha, size, w.kind, w.priority, users, got && got.offered === false ? 0 : 1, now, w.preview || null] });
      out.offered++;
    }
    await writeStock(gc, pending);
    // more to do: again in a minute (this process remembers it — no write)
    m.again = more;
    m.at = now;
    await saveState(gc, now, { error: null });
    return { ...out, more };
  } catch (e) {
    gc.log.warn('home cache run failed', (e && e.code) || 'error');
    // again in a minute
    m.again = true;
    try { await writeStock(gc, pending); await saveState(gc, now, { error: (e && e.code) || 'error' }); } catch { /* nothing */ }
    return { error: (e && e.code) || 'error' };
  }
}

// ─── For administrators ──────────────────────────────────────────

/**
 * { available, files, bytes, previews, previewBytes, lastRunAt, error } — files: what Drive offers the gateways now;
 * previews (1.24.0): its previews among them (GateControl ≥ 1.249.0).
 */
async function summary(gc) {
  if (!available(gc)) return { available: false, files: 0, bytes: 0, previews: 0, previewBytes: 0, lastRunAt: null, error: null };
  const st = await state(gc);
  const n = await store.one(gc, 'SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM home_cache WHERE offered = 1 AND preview IS NULL');
  const p = await store.one(gc, 'SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM home_cache WHERE offered = 1 AND preview IS NOT NULL');
  return { available: true, files: n.n, bytes: n.bytes, previews: p.n, previewBytes: p.bytes, lastRunAt: st && st.at ? iso(st.at) : null, error: (st && st.error) || null };
}

/** "4,2 GB" / "4.2 GB" */
function size(bytes, lang) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(bytes) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = i === 0 ? String(Math.round(v)) : v.toFixed(v < 10 ? 1 : 0);
  return `${lang === 'en' ? s : s.replace('.', ',')} ${units[i]}`;
}

/** The status line below Drive's settings (hook settingsStatus) — only while GateControl has the home cache. */
async function status(gc, lang, t) {
  if (!available(gc)) return [];
  const s = await summary(gc);
  return [{ group: null, tone: s.error ? 'warn' : 'info', text: t(lang, s.error ? 'home_cache.status_error' : 'home_cache.status', { n: s.files, size: size(s.bytes, lang) }) }];
}

module.exports = { available, previewsAvailable, touch, pins, pin, unpin, noteUse, lanOf, attachLan, wanted, tick, summary, status, size, PRIO, PINS_MAX, RUN_MS, LIMITS, PREVIEW_PHOTOS, PREVIEWS_MAX };
