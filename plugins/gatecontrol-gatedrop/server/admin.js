'use strict';

// The admin page "Übersicht" (administrators in the admin UI only — index.js):
//   GET    admin/overview                storage (GateControl's media of this plugin; on the server picked up / not),
//                                        the last 7 days (arrived, waiting, failed, direct / server), the retention,
//                                        active links, whether public links are on, what the other plugins offer
//   GET    admin/sends?range=&filter=&q=&cursor=&limit=   the sends, a page at a time (newest first) with the counts of
//                                        the filters
//   DELETE admin/sends/<id>               remove a send's files from the server ("Vom Admin entfernt")
//   PUT    admin/retention               { afterDays, unpickedDays } (retention.js)
//   GET    admin/cleanup?olderDays=      what "Speicher freigeben" would remove; POST admin/cleanup { unpicked, picked }
// People and device names are shown (the administrator's decision) — never a file name, a MIME type, a text, a link,
// a note, a NAS path below the drop folder, a Drive folder, a link's title / URL or anything else of the content.

const store = require('./store');
const people = require('./people');
const retention = require('./retention');
const jobs = require('./jobs');
const bg = require('./bg');
const deliver = require('./deliver');
const { fail, posInt, iso } = require('./util');

const DAY = 86400000;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;
const RANGES = ['7d', '30d', 'server'];
const FILTERS = ['all', 'problems', 'waiting', 'direct', 'server', 'links'];
const CLEAN_DAYS = [1, 3, 7];
const REMOVE_CHUNK = 50;
const CLEAN_MAX = 20000; // sends per cleanup run at most

// ─── SQL pieces (alias s = sends) ───────────────────────────────────────────

const BYTES = '(SELECT COALESCE(SUM(i.bytes), 0) FROM items i WHERE i.send_id = s.id AND i.media_id IS NOT NULL)';
const LIVE = 's.purged = 0 AND s.removed_at IS NULL';
const ON_SERVER = `${LIVE} AND EXISTS (SELECT 1 FROM items i WHERE i.send_id = s.id AND i.media_id IS NOT NULL)`;
// a delivery that still waits for its pick-up
const OPEN = "d.kind != 'link' AND d.picked_at IS NULL AND d.status NOT IN ('failed', 'expired')";
const has = (cond) => `EXISTS (SELECT 1 FROM deliveries d WHERE d.send_id = s.id AND ${cond})`;
// every delivery directly from device to device (nothing of it through the server)
const DIRECT = `(${has('1')} AND NOT ${has("NOT (d.kind = 'device' AND d.via = 'direct')")})`;
const WAITING = `(${LIVE} AND ${has(OPEN)})`;
/** Problems: a failure; waiting for more than a day; expired without the pick-up (? = now - 1 day). */
const PROBLEMS = `(${has("d.status = 'failed'")} OR (${WAITING} AND s.created_at < ?)
  OR (s.purged = 1 AND s.removed_at IS NULL AND ${has("d.kind != 'link' AND d.picked_at IS NULL AND d.status != 'failed'")}))`;

/** A filter → [sql, params]. */
function filterSql(f, now) {
  if (f === 'problems') return [PROBLEMS, [now - DAY]];
  if (f === 'waiting') return [WAITING, []];
  if (f === 'direct') return [DIRECT, []];
  if (f === 'server') return [`NOT ${DIRECT}`, []];
  if (f === 'links') return [has("d.kind = 'link'"), []];
  return ['1', []];
}

/** LIKE pattern of a search text (\ escapes). */
const likeOf = (q) => `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;

/** Range and search → [sql, params]. */
function scopeSql(range, q, users, now) {
  const parts = [];
  const params = [];
  if (range === 'server') parts.push(`(${ON_SERVER})`);
  else { parts.push('s.created_at > ?'); params.push(now - (range === '30d' ? 30 : 7) * DAY); }
  if (q) {
    const needle = q.toLocaleLowerCase('de');
    const ids = JSON.stringify([...users.values()].filter((u) => String(u.name || '').toLocaleLowerCase('de').includes(needle)).map((u) => u.id));
    const like = likeOf(q);
    parts.push(`(s.user_id IN (SELECT value FROM json_each(?)) OR s.device_name LIKE ? ESCAPE '\\'
      OR ${has(`d.kind IN ('device', 'person') AND (d.user_id IN (SELECT value FROM json_each(?)) OR d.label LIKE ? ESCAPE '\\'
        OR (d.target = 'family' AND EXISTS (SELECT 1 FROM json_each(?) j WHERE d.members LIKE '%,' || j.value || ',%')))`)})`);
    params.push(ids, like, ids, like, ids);
  }
  return [parts.join(' AND '), params];
}

// ─── overview ───────────────────────────────────────────────────────────────

/** Files on the server by pick-up → { picked: { count, bytes }, unpicked: { count, bytes, oldestAt } }. */
async function held(gc) {
  const rows = await store.all(gc, `SELECT p, COUNT(*) AS n, SUM(b) AS bytes, MIN(c) AS oldest FROM (
      SELECT CASE WHEN s.picked_at IS NULL THEN 0 ELSE 1 END AS p, ${BYTES} AS b, s.created_at AS c FROM sends s WHERE ${LIVE}
    ) WHERE b > 0 GROUP BY p`);
  const of = (p) => rows.find((r) => r.p === p) || { n: 0, bytes: 0, oldest: null };
  const pk = of(1);
  const up = of(0);
  return { picked: { count: pk.n, bytes: Number(pk.bytes) || 0 }, unpicked: { count: up.n, bytes: Number(up.bytes) || 0, oldestAt: iso(up.oldest) } };
}

async function overview(gc, user, now) {
  let usage = null;
  try { usage = await gc.media.usage(); } catch { usage = null; }
  const links = await store.one(gc, 'SELECT COUNT(*) AS n FROM links WHERE revoked_at IS NULL AND expires_at > ?', [now]);
  const w = await store.one(gc, `SELECT COUNT(*) AS sends,
      SUM(CASE WHEN s.picked_at IS NOT NULL THEN 1 ELSE 0 END) AS arrived,
      SUM(CASE WHEN ${WAITING} THEN 1 ELSE 0 END) AS waiting,
      SUM(CASE WHEN ${has("d.status = 'failed'")} THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN ${DIRECT} THEN 1 ELSE 0 END) AS direct
    FROM sends s WHERE s.created_at > ?`, [now - 7 * DAY]);
  const r = await retention.get(gc);
  people.forgetLinks();
  const n = (v) => Number(v) || 0;
  return {
    storage: usage ? { bytes: usage.bytes, count: usage.count, quota: usage.quota, maxBytes: usage.maxBytes } : null,
    held: await held(gc),
    week: { sends: n(w && w.sends), arrived: n(w && w.arrived), waiting: n(w && w.waiting), failed: n(w && w.failed), direct: n(w && w.direct), server: n(w && w.sends) - n(w && w.direct) },
    retentionDays: r.unpickedDays,
    retention: retention.view(r),
    sends7d: n(w && w.sends),
    activeLinks: links ? links.n : 0,
    linksEnabled: await people.linksEnabled(gc, user.id, now),
    integrations: {
      messenger: await people.available(gc, people.MESSENGER, 'send_file'),
      nas: await people.available(gc, people.SYNOLOGY, 'save_file'),
      drive: await people.available(gc, people.DRIVE, 'save_file'),
      familie: await people.available(gc, people.FAMILIE, 'family_roles'),
    },
  };
}

// ─── the list ───────────────────────────────────────────────────────────────

function parseList(query) {
  const q = query || {};
  const range = q.range == null || q.range === '' ? '7d' : String(q.range);
  const filter = q.filter == null || q.filter === '' ? 'all' : String(q.filter);
  if (!RANGES.includes(range) || !FILTERS.includes(filter)) throw fail('invalid');
  const limit = q.limit == null || q.limit === '' ? PAGE_DEFAULT : posInt(String(q.limit));
  if (!limit || limit > PAGE_MAX) throw fail('invalid');
  let cursor = null;
  if (q.cursor != null && q.cursor !== '') {
    const m = /^(\d{1,15})_([0-9a-f]{24})$/.exec(String(q.cursor));
    if (!m) throw fail('invalid');
    cursor = { at: Number(m[1]), id: m[2] };
  }
  const search = q.q == null ? '' : String(q.q).replace(/[\0-\x1f\x7f]/g, ' ').trim();
  if (search.length > 60) throw fail('invalid');
  return { range, filter, limit, cursor, search };
}

/** The drop folder's own label for a NAS delivery's target (never the path below it) — or null. */
function nasLabel(folders, target) {
  let best = null;
  for (const f of folders) {
    const base = f.path.replace(/\/+$/, '');
    if ((target === base || target.startsWith(base + '/')) && (!best || base.length > best.base.length)) best = { base, label: f.label };
  }
  return best && best.label !== best.base ? best.label : null;
}

/** One recipient as the list shows it — names of people and devices, nothing of the content. */
function recipient(d, ctx) {
  const owner = d.user_id ? ctx.users.get(d.user_id) : null;
  if (d.kind === 'device') {
    const dev = (ctx.devices.get(d.user_id) || []).find((x) => x.id === d.target);
    return {
      kind: 'device', name: dev ? dev.name : String(d.label || '').replace(/ \([^)]*\)$/, '') || null, platform: dev ? dev.platform : null,
      owner: owner ? owner.name : null, online: dev ? dev.online : null, lastSeen: dev ? dev.lastSeen || null : null,
    };
  }
  if (d.kind === 'person' && d.target === 'family') return { kind: 'family', members: deliver.membersOf(d).length, messenger: !!(d.ref && d.ref.startsWith('chat:')) };
  if (d.kind === 'person') return { kind: 'person', name: owner ? owner.name : d.label || null, messenger: !!(d.ref && d.ref.startsWith('chat:')) };
  if (d.kind === 'nas') return { kind: 'nas', name: ctx.folders ? nasLabel(ctx.folders, d.target) : null };
  if (d.kind === 'drive') return { kind: 'drive' };
  const l = ctx.links.get(d.target);
  return { kind: 'link', pin: l ? l.pin === 1 : false, maxDownloads: l ? l.max_downloads : null };
}

/** How a delivery stands for the list → { d, weight, picked, state: picked | open | failed | expired | removed, how }. */
function unitOf(d, send, ctx) {
  let weight = 1;
  let picked = d.picked_at != null ? 1 : 0;
  if (d.kind === 'person' && d.target === 'family') {
    const members = deliver.membersOf(d);
    weight = Math.max(1, members.length);
    picked = d.picked_at != null ? weight : Math.min(weight, (ctx.pickups.get(d.id) || []).filter((u) => members.includes(u)).length);
  }
  let state;
  if (d.picked_at != null) state = 'picked';
  else if (d.error === 'removed') state = 'removed';
  else if (d.status === 'failed') state = 'failed';
  else if (d.status === 'expired' || send.purged) state = 'expired';
  else state = 'open';
  let how = 'picked';
  if (d.kind === 'device') how = d.via === 'direct' ? 'received' : 'picked';
  else if (d.kind === 'person') how = d.ref && d.ref.startsWith('chat:') && !d.gd_items ? 'chat' : 'opened';
  else if (d.kind === 'nas' || d.kind === 'drive') how = 'stored';
  return { d, weight, picked, state, how };
}

/** Names of the recipients still open (at most 3). */
function openNames(units, ctx) {
  const out = [];
  for (const u of units) {
    if (u.state !== 'open') continue;
    if (u.d.kind === 'person' && u.d.target === 'family') {
      const got = ctx.pickups.get(u.d.id) || [];
      for (const m of deliver.membersOf(u.d)) if (!got.includes(m)) out.push((ctx.users.get(m) || {}).name || null);
    } else out.push(recipient(u.d, ctx).name || null);
  }
  return out.filter(Boolean).slice(0, 3);
}

/** The way of a send: direct | server | fallback (direct failed, then the server) | mixed | link | null. */
function wayOf(dels) {
  if (!dels.length) return null;
  if (dels.every((d) => d.kind === 'link')) return 'link';
  const direct = dels.some((d) => d.kind === 'device' && d.via === 'direct');
  const other = dels.some((d) => !(d.kind === 'device' && d.via === 'direct'));
  if (dels.some((d) => d.kind === 'device' && d.error === 'direct_failed')) return 'fallback';
  if (direct && !other) return 'direct';
  return direct ? 'mixed' : 'server';
}

/** The state of a send of links only. */
function linkStatus(dels, ctx, now) {
  const ls = dels.map((d) => ctx.links.get(d.target)).filter(Boolean);
  const failed = dels.find((d) => d.status === 'failed');
  return {
    state: 'link', downloads: ls.reduce((a, l) => a + (l.downloads || 0), 0), active: ls.some((l) => !l.revoked_at && l.expires_at > now),
    expiresAt: iso(ls.length ? Math.max(...ls.map((l) => l.expires_at)) : null), error: failed && !ls.length ? failed.error || 'failed' : null,
  };
}

/** One send of the list. */
function row(s, ctx, now) {
  const dels = ctx.deliveries.get(s.id) || [];
  const items = ctx.items.get(s.id) || { n: 0, bytes: 0, held: 0, local: 0 };
  const from = ctx.users.get(s.user_id);
  const units = dels.filter((d) => d.kind !== 'link').map((d) => unitOf(d, s, ctx));
  const total = units.reduce((a, u) => a + u.weight, 0);
  const picked = units.reduce((a, u) => a + u.picked, 0);
  const open = units.some((u) => u.state === 'open');
  const failed = units.find((u) => u.state === 'failed');
  let status;
  if (s.removed_at) status = { state: 'removed', at: iso(s.removed_at) };
  else if (!units.length) status = linkStatus(dels, ctx, now);
  else if (total && picked === total) {
    const hows = [...new Set(units.map((u) => u.how))];
    status = { state: 'picked', how: hows.length === 1 ? hows[0] : 'picked', at: iso(s.picked_at || Math.max(...units.map((u) => u.d.picked_at || 0))) };
  } else if (open) {
    const pending = units.filter((u) => u.state === 'open').every((u) => u.d.status === 'pending' || u.d.status === 'direct');
    const one = units.length === 1 && units[0].d.kind === 'device' ? recipient(units[0].d, ctx) : null;
    status = {
      state: picked ? 'partial' : (pending ? 'pending' : 'waiting'), picked, total, since: iso(s.created_at), open: openNames(units, ctx),
      ...(one && one.online === false ? { offline: true, lastSeen: one.lastSeen } : {}),
      ...(units.some((u) => u.state === 'open' && u.d.error === 'scan_pending') ? { scan: true } : {}),
    };
  } else if (picked) status = { state: 'partial', picked, total, open: [], error: failed ? failed.d.error || 'failed' : null };
  else if (failed) status = { state: 'failed', error: failed.d.error || 'failed' };
  else status = { state: 'expired' };
  const problem = !!(failed || (open && !s.purged && !s.removed_at && s.created_at < now - DAY) || (s.purged && !s.removed_at && units.some((u) => u.state === 'expired')));
  let server;
  const never = items.n > 0 && items.local === items.n && !dels.some((d) => d.error === 'direct_failed');
  if (s.removed_at) server = { state: 'removed', at: iso(s.removed_at) };
  else if (!s.purged && items.held > 0) server = { state: 'held', bytes: items.held, until: iso(s.expires_at) };
  else if (!items.n) server = { state: 'none' };
  else if (never) server = { state: 'never' };
  else server = { state: s.picked_at ? 'after' : 'expired' };
  return {
    id: s.id, createdAt: iso(s.created_at),
    from: { userId: s.user_id, name: from ? from.name : null, device: s.device_name || null, portal: !s.device_id },
    to: dels.map((d) => recipient(d, ctx)),
    files: items.n, bytes: items.bytes,
    way: wayOf(dels), status, problem, server, canDelete: server.state === 'held',
  };
}

const IN_JSON = 'IN (SELECT value FROM json_each(?))';

/** What the rows of a page need, loaded per page (one parameter for every list: json_each). */
async function pageCtx(gc, rows, now) {
  const ids = JSON.stringify(rows.map((r) => r.id));
  const ctx = { users: await people.users(gc), deliveries: new Map(), items: new Map(), links: new Map(), pickups: new Map(), devices: new Map(), folders: null };
  for (const d of await store.all(gc, `SELECT id, send_id, kind, target, user_id, status, via, error, ref, label, members, gd_items, picked_at FROM deliveries WHERE send_id ${IN_JSON} ORDER BY id`, [ids])) {
    if (!ctx.deliveries.has(d.send_id)) ctx.deliveries.set(d.send_id, []);
    ctx.deliveries.get(d.send_id).push(d);
  }
  for (const i of await store.all(gc, `SELECT send_id, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(CASE WHEN media_id IS NOT NULL THEN bytes ELSE 0 END), 0) AS held,
      COALESCE(SUM(local), 0) AS local FROM items WHERE send_id ${IN_JSON} GROUP BY send_id`, [ids])) {
    ctx.items.set(i.send_id, { n: i.n, bytes: Number(i.bytes) || 0, held: Number(i.held) || 0, local: Number(i.local) || 0 });
  }
  for (const l of await store.all(gc, `SELECT token, send_id, pin, max_downloads, downloads, expires_at, revoked_at FROM links WHERE send_id ${IN_JSON}`, [ids])) ctx.links.set(l.token, l);
  for (const p of await store.all(gc, `SELECT p.delivery_id, p.user_id FROM pickups p JOIN deliveries d ON d.id = p.delivery_id WHERE d.send_id ${IN_JSON}`, [ids])) {
    if (!ctx.pickups.has(p.delivery_id)) ctx.pickups.set(p.delivery_id, []);
    ctx.pickups.get(p.delivery_id).push(p.user_id);
  }
  const all = [...ctx.deliveries.values()].flat();
  for (const uid of new Set(all.filter((d) => d.kind === 'device' && d.user_id).map((d) => d.user_id))) ctx.devices.set(uid, await people.devicesOf(gc, uid));
  if (all.some((d) => d.kind === 'nas')) ctx.folders = await people.folders(gc, now);
  return ctx;
}

/** GET admin/sends → { items, hasMore, cursor, counts: { all, problems, waiting, direct, server, links } } */
async function list(gc, query, now) {
  const p = parseList(query);
  const users = await people.users(gc);
  const [scope, scopeParams] = scopeSql(p.range, p.search, users, now);
  const c = await store.one(gc, `SELECT COUNT(*) AS n_all,
      SUM(CASE WHEN ${PROBLEMS} THEN 1 ELSE 0 END) AS n_problems,
      SUM(CASE WHEN ${WAITING} THEN 1 ELSE 0 END) AS n_waiting,
      SUM(CASE WHEN ${DIRECT} THEN 1 ELSE 0 END) AS n_direct,
      SUM(CASE WHEN ${has("d.kind = 'link'")} THEN 1 ELSE 0 END) AS n_links
    FROM sends s WHERE ${scope}`, [now - DAY, ...scopeParams]);
  const n = (v) => Number(v) || 0;
  const counts = { all: n(c.n_all), problems: n(c.n_problems), waiting: n(c.n_waiting), direct: n(c.n_direct), server: n(c.n_all) - n(c.n_direct), links: n(c.n_links) };
  const [fs, fp] = filterSql(p.filter, now);
  const cur = p.cursor ? ' AND (s.created_at < ? OR (s.created_at = ? AND s.id < ?))' : '';
  const rows = await store.all(gc, `SELECT s.id, s.user_id, s.device_id, s.device_name, s.created_at, s.expires_at, s.purged, s.picked_at, s.removed_at
      FROM sends s WHERE ${scope} AND ${fs}${cur} ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
  [...scopeParams, ...fp, ...(p.cursor ? [p.cursor.at, p.cursor.at, p.cursor.id] : []), p.limit + 1]);
  const hasMore = rows.length > p.limit;
  const page = rows.slice(0, p.limit);
  const ctx = page.length ? await pageCtx(gc, page, now) : null;
  const last = page[page.length - 1];
  return { items: page.map((s) => row(s, ctx, now)), hasMore, cursor: hasMore ? `${last.created_at}_${last.id}` : null, counts };
}

// ─── removing (cleanup, one send) ───────────────────────────────────────────

/**
 * Remove sends' files from the server: the sends become "removed" (removed_at, expires now — nobody reads a file any
 * more), deliveries not picked up end ('expired', error 'removed': recipients that did not pick it up get nothing of
 * it any more, the sender sees "Vom Admin entfernt"), open transfers end, links are revoked. The files themselves go in
 * the background (jobs.purgeFiles, 100 sends at a time). → { count, bytes }
 */
async function removeSends(gc, ids, now) {
  let count = 0;
  let bytes = 0;
  const tokens = [];
  for (let i = 0; i < ids.length; i += REMOVE_CHUNK) {
    const part = JSON.stringify(ids.slice(i, i + REMOVE_CHUNK));
    await store.tx(gc, async () => {
      const live = await store.all(gc, `SELECT s.id, ${BYTES} AS b FROM sends s WHERE s.id ${IN_JSON} AND ${LIVE}`, [part]);
      if (!live.length) return;
      const ok = JSON.stringify(live.map((r) => r.id));
      count += live.length;
      bytes += live.reduce((a, r) => a + (Number(r.b) || 0), 0);
      await store.run(gc, `UPDATE sends SET removed_at = ?, expires_at = ? WHERE id ${IN_JSON} AND purged = 0 AND removed_at IS NULL`, [now, now, ok]);
      await store.run(gc, `UPDATE deliveries SET status = 'expired', error = 'removed', at = ? WHERE send_id ${IN_JSON} AND picked_at IS NULL
        AND status IN ('pending', 'direct', 'waiting', 'delivered', 'opened')`, [now, ok]);
      await store.run(gc, `UPDATE transfers SET status = 'expired', key = NULL, ticket = NULL, done_at = ? WHERE send_id ${IN_JSON} AND status = 'open'`, [now, ok]);
      for (const l of await store.all(gc, `SELECT token FROM links WHERE send_id ${IN_JSON} AND revoked_at IS NULL`, [ok])) tokens.push(l.token);
      await store.run(gc, `UPDATE links SET revoked_at = ? WHERE send_id ${IN_JSON} AND revoked_at IS NULL`, [now, ok]);
    });
  }
  // the links end at GateControl too (after the commit; one that is gone already does not matter)
  for (const t of tokens) {
    try { if (gc.publicLinks) await gc.publicLinks.revoke(t); } catch (e) { gc.log.warn('link revoke failed', (e && e.code) || 'error'); }
  }
  // the files: in the background, a batch at a time, until none is due
  if (count) {
    bg.queue(async () => {
      for (let n = 0; n < 1000; n++) if (!(await jobs.purgeFiles(gc, Date.now()))) break;
    }, gc);
  }
  return { count, bytes };
}

/** The sends a cleanup removes → [sql, params] ('unpicked' older than `days`, or 'picked' without an active link). */
function cleanupSql(kind, days, now) {
  if (kind === 'unpicked') return [`${LIVE} AND s.picked_at IS NULL AND s.created_at <= ? AND ${BYTES} > 0`, [now - days * DAY]];
  return [`${LIVE} AND s.picked_at IS NOT NULL AND ${BYTES} > 0
    AND NOT EXISTS (SELECT 1 FROM links l WHERE l.send_id = s.id AND l.revoked_at IS NULL AND l.expires_at > ?)`, [now]];
}

function cleanDays(v, dflt) {
  if (v == null || v === '') return dflt;
  const n = typeof v === 'number' ? v : posInt(String(v));
  if (!CLEAN_DAYS.includes(n)) throw fail('invalid');
  return n;
}

/** GET admin/cleanup?olderDays=1|3|7 → { unpicked: { olderDays, count, bytes }, picked: { count, bytes }, olderDays: [1, 3, 7] } */
async function cleanupInfo(gc, query, now) {
  const days = cleanDays(query && query.olderDays, 3);
  const sum = async (kind) => {
    const [w, p] = cleanupSql(kind, days, now);
    const r = await store.one(gc, `SELECT COUNT(*) AS n, COALESCE(SUM(${BYTES}), 0) AS b FROM sends s WHERE ${w}`, p);
    return { count: r ? r.n : 0, bytes: r ? Number(r.b) || 0 : 0 };
  };
  return { unpicked: { olderDays: days, ...(await sum('unpicked')) }, picked: await sum('picked'), olderDays: [...CLEAN_DAYS] };
}

/** POST admin/cleanup { unpicked: 1|3|7|null, picked: true|false } → { removed, bytes } */
async function cleanup(gc, body, now) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b || (b.picked != null && typeof b.picked !== 'boolean')) throw fail('invalid');
  const days = b.unpicked == null || b.unpicked === false ? null : cleanDays(b.unpicked, null);
  if (days == null && b.picked !== true) throw fail('invalid');
  const ids = new Set();
  for (const kind of [...(days != null ? ['unpicked'] : []), ...(b.picked ? ['picked'] : [])]) {
    const [w, p] = cleanupSql(kind, days, now);
    let after = '';
    // the ids a page at a time (no list of thousands in one statement)
    for (;;) {
      const page = await store.all(gc, `SELECT s.id FROM sends s WHERE ${w} AND s.id > ? ORDER BY s.id LIMIT 500`, [...p, after]);
      for (const r of page) ids.add(r.id);
      if (page.length < 500 || ids.size >= CLEAN_MAX) break;
      after = page[page.length - 1].id;
    }
  }
  const r = await removeSends(gc, [...ids].slice(0, CLEAN_MAX), now);
  gc.log.info('gatedrop cleanup', r.count, 'sends');
  return { removed: r.count, bytes: r.bytes };
}

/** DELETE admin/sends/<id> → { removed: true, bytes } — a send with files on the server. */
async function removeOne(gc, id, now) {
  if (typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id)) throw fail('not_found');
  const s = await store.one(gc, `SELECT s.id, s.purged, s.removed_at, ${BYTES} AS b FROM sends s WHERE s.id = ?`, [id]);
  if (!s) throw fail('not_found');
  if (s.purged || s.removed_at || !(Number(s.b) > 0)) throw fail('gone');
  const r = await removeSends(gc, [id], now);
  gc.log.info('gatedrop send removed by an administrator');
  return { removed: r.count === 1, bytes: r.bytes };
}

module.exports = { overview, list, cleanupInfo, cleanup, removeOne, removeSends, RANGES, FILTERS, CLEAN_DAYS };
