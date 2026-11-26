'use strict';

// "Videos umwandeln", step 1 (1.5.0): the list of films and episodes that do not play on every device — nothing is
// converted yet. Converting needs the service "umwandeln" on the gateway (Frage 92 a), which comes later; until then
// the page and the App API say `available: false` and offer no button that would pretend otherwise.
//
//   scan     GET /Items in pages (each answer < 5 MB) for every Jellyfin source, judged by convert-rules.js; only rows
//            with something to report are kept (conv_items). The first scan starts when an administrator opens the
//            page (or "Neu prüfen"); after that every 30 minutes only the changes (MinDateLastSaved) and once a day all
//            of it again (drops what is gone).
//   watch    every 60 s GET /Sessions while the list has rows: a playback Jellyfin converts slower than real time
//            marks the file "beim Abspielen gestockt" (with Jellyfin's TranscodeReasons) and moves it up the list.
//   status   App API v1/convert/status?items=… — for the later hint before playing.

const store = require('./store');
const jf = require('./jellyfin');
const sources = require('./sources');
const rights = require('./rights');
const rules = require('./convert-rules');
const { fail, str, json, iso } = require('./util');

const STATE_KEY = 'conv.scan';
const INCREMENTAL_MS = 30 * 60000;
const FULL_MS = 24 * 3600000;
const SINCE_OVERLAP_MS = 10 * 60000;
const PAGE = 200;
const PAGE_MIN = 25;
const MAX_PAGES = 1000;
const LIST_MAX = 2000;
const STATUS_IDS_MAX = 100;
// the decided night window (Frage 96 a) — only shown as "the night has room for …" until the queue exists
const WINDOW = { from: '01:00', to: '06:00', minutes: 300 };

const running = { p: null, full: false, startedAt: null };

const itemIdOf = (v) => {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/-/g, '') : '';
  return /^[0-9a-f]{32}$/.test(s) ? s : null;
};
const int = (v) => (Number.isSafeInteger(v) ? v : null);

async function loadState(gc) {
  const v = await gc.storage.get(STATE_KEY);
  return v && typeof v === 'object' ? v : {};
}

async function jellyfins(gc) {
  return (await sources.list(gc)).filter((s) => s.kind === 'jellyfin' && s.enabled);
}

/** Save one page of items: rows for what has something to report, none for the rest. */
async function savePage(gc, src, items, seq, now) {
  await store.tx(gc, async () => {
    for (const it of items) {
      const id = itemIdOf(it.Id);
      if (!id) continue;
      const j = rules.judgeItem(it);
      if (!j || !j.level) { await store.run(gc, 'DELETE FROM conv_items WHERE source_id = ? AND item_id = ?', [src.id, id]); continue; }
      const kind = it.Type === 'Episode' ? 'Episode' : 'Movie';
      await store.run(gc, `INSERT INTO conv_items (source_id, item_id, kind, name, series, season, episode, year, path, container, size, runtime, fps,
          level, reasons, devices, estimate, video, scan, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, item_id) DO UPDATE SET kind = excluded.kind, name = excluded.name, series = excluded.series, season = excluded.season,
          episode = excluded.episode, year = excluded.year, path = excluded.path, container = excluded.container, size = excluded.size,
          runtime = excluded.runtime, fps = excluded.fps, level = excluded.level, reasons = excluded.reasons, devices = excluded.devices,
          estimate = excluded.estimate, video = excluded.video, scan = excluded.scan, updated_at = excluded.updated_at`,
      [src.id, id, kind, str(it.Name, 200) || '?', kind === 'Episode' ? (str(it.SeriesName, 200) || null) : null,
        kind === 'Episode' ? int(it.ParentIndexNumber) : null, kind === 'Episode' ? int(it.IndexNumber) : null, int(it.ProductionYear),
        j.source.path, j.source.container, j.source.size == null ? null : Math.round(j.source.size), j.source.runtime, j.source.fps,
        j.level, JSON.stringify(j.reasons), JSON.stringify(j.devices), j.estimate ? JSON.stringify(j.estimate) : null, j.video, seq, now]);
    }
  });
}

/** All pages of one source (since: ISO time for changes only). A too large or failing page is asked again smaller. */
async function scanSource(gc, src, key, since, seq) {
  const index = src.config.targetIndex || 0;
  let start = 0;
  let limit = PAGE;
  let total = null;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    let page;
    try {
      page = await jf.itemsPage(gc, index, key, { start, limit, since });
    } catch (e) {
      // an answer over 5 MB (or a hiccup) ends as "network": the same page again with half as many items
      if (e && e.code === 'jellyfin_unreachable' && e.extra && e.extra.reason === 'network' && limit > PAGE_MIN) { limit = Math.max(PAGE_MIN, Math.floor(limit / 2)); pages--; continue; }
      throw e;
    }
    total = page.total;
    await savePage(gc, src, page.items, seq, Date.now());
    start += page.items.length;
    if (!page.items.length || (total != null && start >= total) || (total == null && page.items.length < limit)) break;
  }
  return { total: total == null ? start : total };
}

async function scan(gc, full) {
  const st = await loadState(gc);
  const seq = (Number.isSafeInteger(st.seq) ? st.seq : 0) + 1;
  const startedAt = Date.now();
  const prev = st.sources && typeof st.sources === 'object' ? st.sources : {};
  const per = {};
  const all = await jellyfins(gc);
  for (const src of all) {
    const old = prev[src.id] || {};
    const key = await sources.apiKey(gc, src);
    if (!key) { per[src.id] = { ...old, error: 'not_configured' }; continue; }
    const since = !full && old.at && old.fullAt ? new Date(old.at - SINCE_OVERLAP_MS).toISOString() : null;
    try {
      const r = await scanSource(gc, src, key, since, seq);
      if (!since) await store.run(gc, 'DELETE FROM conv_items WHERE source_id = ? AND scan <> ?', [src.id, seq]);
      per[src.id] = { at: startedAt, fullAt: since ? old.fullAt : startedAt, total: since ? (old.total || 0) : r.total, error: null };
    } catch (e) {
      per[src.id] = { ...old, error: (e && e.known && e.code) || 'internal' };
      if (!(e && e.known)) gc.log.warn('convert scan failed', src.id, (e && (e.code || e.message)) || 'error');
    }
  }
  // sources removed or switched off: their rows go
  const ids = all.map((s) => s.id);
  if (ids.length) await store.run(gc, `DELETE FROM conv_items WHERE source_id NOT IN (${store.marks(ids.length)})`, ids);
  else await store.run(gc, 'DELETE FROM conv_items');
  const next = { seq, at: startedAt, fullAt: full || !st.fullAt ? startedAt : st.fullAt, sources: per };
  await gc.storage.set(STATE_KEY, next);
  return next;
}

/** Start a scan unless one runs (the promise of the running one otherwise). */
function start(gc, { full = false } = {}) {
  if (running.p) return running.p;
  running.full = !!full;
  running.startedAt = Date.now();
  running.p = scan(gc, !!full)
    .catch((e) => { gc.log.warn('convert scan failed', (e && (e.code || e.message)) || 'error'); return null; })
    .finally(() => { running.p = null; running.startedAt = null; });
  return running.p;
}

/** "beim Abspielen gestockt": Jellyfin converts the video of a listed file slower than its frame rate. */
async function watch(gc, now) {
  const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM conv_items');
  if (!n || !n.n) return 0;
  let marked = 0;
  for (const src of await jellyfins(gc)) {
    const key = await sources.apiKey(gc, src);
    if (!key) continue;
    let list;
    try { list = await jf.sessions(gc, src.config.targetIndex || 0, key); } catch { continue; }
    for (const s of list) {
      const ti = s.TranscodingInfo;
      const np = s.NowPlayingItem;
      const id = np && itemIdOf(np.Id);
      if (!id || !ti || typeof ti !== 'object' || ti.IsVideoDirect !== false) continue;
      if (s.PlayState && s.PlayState.IsPaused === true) continue;
      const row = await store.one(gc, 'SELECT fps FROM conv_items WHERE source_id = ? AND item_id = ?', [src.id, id]);
      const rate = typeof ti.Framerate === 'number' && Number.isFinite(ti.Framerate) ? ti.Framerate : null;
      if (!row || !row.fps || rate == null || rate <= 0 || rate >= row.fps * 0.95) continue;
      await store.run(gc, 'UPDATE conv_items SET stalled_at = ?, stalled_reasons = ? WHERE source_id = ? AND item_id = ?',
        [now, JSON.stringify(rules.transcodeReasons(ti.TranscodeReasons)), src.id, id]);
      marked++;
    }
  }
  return marked;
}

/** Background (every 60 s): the next scan when due, the session watch. */
async function background(gc, now) {
  const st = await loadState(gc);
  if (st.at && !running.p) {
    if (now - (st.fullAt || 0) >= FULL_MS) start(gc, { full: true });
    else if (now - st.at >= INCREMENTAL_MS) start(gc, { full: false });
  }
  try { await watch(gc, now); } catch (e) { gc.log.debug('convert watch failed', (e && e.code) || 'error'); }
}

function rowView(r, names) {
  return {
    sourceId: r.source_id, source: names[r.source_id] || r.source_id, id: r.item_id, kind: r.kind, name: r.name, series: r.series,
    season: r.season, episode: r.episode, year: r.year, path: r.path, container: r.container, size: r.size, runtime: r.runtime,
    level: r.level, reasons: json(r.reasons, []), devices: json(r.devices, {}), estimate: json(r.estimate, null), video: r.video,
    stalled: r.stalled_at ? { at: iso(r.stalled_at), reasons: json(r.stalled_reasons, []) } : null,
  };
}

const ORDER = "CASE level WHEN 'convert' THEN 0 WHEN 'hint' THEN 1 ELSE 2 END, (stalled_at IS NULL), COALESCE(size, 0) DESC, item_id";

/** admin GET convert: the scan, the counts, the list (most important first). Starts the very first scan by itself. */
async function view(gc) {
  let st = await loadState(gc);
  const all = await sources.list(gc);
  const jfs = all.filter((s) => s.kind === 'jellyfin');
  if (!st.at && !running.p && jfs.some((s) => s.enabled)) start(gc, { full: true });
  st = await loadState(gc);
  const names = {};
  for (const s of jfs) names[s.id] = s.name;
  const counts = { convert: 0, hint: 0, info: 0, stalled: 0 };
  for (const r of await store.all(gc, 'SELECT level, COUNT(*) AS n, SUM(stalled_at IS NOT NULL) AS s FROM conv_items GROUP BY level')) {
    if (r.level in counts) counts[r.level] = r.n;
    counts.stalled += r.s || 0;
  }
  const rows = await store.all(gc, `SELECT * FROM conv_items ORDER BY ${ORDER} LIMIT ?`, [LIST_MAX]);
  const items = rows.map((r) => rowView(r, names));
  const totals = { minutes: 0, sizeBefore: 0, sizeAfter: 0, unknown: 0 };
  for (const r of await store.all(gc, "SELECT size, estimate FROM conv_items WHERE level = 'convert'")) {
    const e = json(r.estimate, null);
    if (!e || e.minutes == null || e.size == null) { totals.unknown++; continue; }
    totals.minutes += e.minutes;
    totals.sizeBefore += r.size || 0;
    totals.sizeAfter += e.size;
  }
  const per = st.sources || {};
  return {
    available: false,
    scan: {
      at: iso(st.at), fullAt: iso(st.fullAt), running: !!running.p, full: running.full,
      total: Object.values(per).reduce((n, x) => n + (x && Number.isSafeInteger(x.total) ? x.total : 0), 0),
      sources: jfs.map((s) => ({ id: s.id, name: s.name, enabled: s.enabled, at: iso(per[s.id] && per[s.id].at), total: per[s.id] ? per[s.id].total || 0 : null, error: (per[s.id] && per[s.id].error) || null })),
    },
    counts, totals, window: WINDOW, nas: 'apollo_lake',
    items, truncated: counts.convert + counts.hint + counts.info > items.length,
  };
}

/**
 * App API GET v1/convert/status?items=<id>,<id> (at most 100 Jellyfin item IDs): what the list knows about these files,
 * only from the Jellyfin sources the person sees. state is "none" until converting exists.
 */
async function status(gc, req, cfg) {
  const user = req.user;
  if (!(await rights.mediaOf(gc, user)).media) throw fail('no_access');
  const raw = req.query && typeof req.query.items === 'string' ? req.query.items.split(',') : [];
  if (raw.length > STATUS_IDS_MAX) throw fail('invalid', { field: 'items' });
  const ids = [];
  for (const x of raw) {
    const id = itemIdOf(x);
    if (!id) throw fail('invalid', { field: 'items' });
    if (!ids.includes(id)) ids.push(id);
  }
  const visible = (await rights.visibleSources(gc, user, await sources.list(gc), cfg)).filter((s) => s.kind === 'jellyfin').map((s) => s.id);
  const rows = ids.length && visible.length
    ? await store.all(gc, `SELECT source_id, item_id, level, reasons, devices, stalled_at FROM conv_items WHERE item_id IN (${store.marks(ids.length)}) AND source_id IN (${store.marks(visible.length)})`, [...ids, ...visible])
    : [];
  const items = ids.map((id) => {
    const r = rows.find((x) => x.item_id === id);
    if (!r) return { id, sourceId: null, level: null, reasons: [], devices: null, stalled: false, state: 'none' };
    return { id, sourceId: r.source_id, level: r.level, reasons: json(r.reasons, []).map((x) => x.code), devices: json(r.devices, null), stalled: !!r.stalled_at, state: 'none' };
  });
  return { v: 1, available: false, items };
}

async function route(req, gc, seg) {
  const m = String(req.method || 'GET').toUpperCase();
  const [, , x] = seg;
  if (!x && m === 'GET') return view(gc);
  if (x === 'scan' && m === 'POST') {
    start(gc, { full: true });
    return { scan: { running: true } };
  }
  throw fail('not_found');
}

module.exports = { route, view, status, start, scan, watch, background, itemIdOf, WINDOW, _running: running, STATE_KEY };
