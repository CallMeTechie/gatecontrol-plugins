'use strict';

// Where photos were taken (since 1.16.0, feature `photoPlaces`): the phones send the position from the EXIF data of a
// photo; Drive keeps it and names the place offline (geonames.js — GeoNames, no service). The pictures never leave
// the server for this.
//
//   POST uploads/commit { …, geo: { lat, lon } }   (files.js) WGS84, rounded to 6 decimals; not a position: 400 invalid
//                         { field: 'geo' }; without it the photo has no place. Dropped while the uploader's keepGeo is
//                         off. (0, 0) counts as none (cameras without a fix write it).
//   PUT nodes/<id>/geo { lat, lon } | { none: true }  → { node }   a place for a photo backed up before (write access,
//                         403 else); none: looked at, no position. keepGeo off: nothing is stored.
//   GET photos?unlocated=1   the photos without a place and not marked none, in areas one writes to (the phones fill
//                         them in); nothing while the viewer's keepGeo is off
//   items and nodes carry  geo: { lat, lon, place: { key, name, district, region, country } | null } | null and
//                         located (a place, or marked none). key: 'geonames:<id>' of the city (Stadt bzw. Gemeinde),
//                         stable; name, district and region German where GeoNames has it; country ISO-2.
//   GET photos/places?area=&folder=&camera=&class=&q=&person=   → { places: [{ key, name, region, country, count, lat,
//                         lon, from, to, cover }] } by count (≤ 500); cover: the newest photo item there
//   GET photos/map?bbox=<w,s,e,n>&zoom=<0..19>&…the same filters   → { clusters: [{ lat, lon, count, key | null, cover }] }
//                         — a grid per zoom level (cells of 64 px), at most 200 (a coarser grid while there would be
//                         more); key where a cluster is exactly one place
//   GET photos and photos/months  place=<key> (the city, or a district by its own key), bbox=<w,s,e,n>; with place
//                         districts=1 adds districts: [{ name, count }]
//   q=   (photos.js) also matches place names: city, district, region and country, German and English, without
//                         accents, a word or the start of one
//   DELETE photos/geo    → { deleted }   the places of every photo the viewer uploaded go (marked none: the phones do
//                         not fill them in again)

const store = require('./store');
const nodes = require('./nodes');
const geonames = require('./geonames');
const { fail, posInt, iso } = require('./util');

const KEY_RE = /^geonames:(\d{1,10})$/;
const PLACES_MAX = 500;
const CLUSTERS_MAX = 200;
const CELL_PX = 64;
const DISTRICTS_MAX = 50;
const SUGGEST_MAX = 5;

const fold = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').trim();
const like = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);

// country names in German and English (Node's ICU); without it the code alone
const countryNames = (() => {
  const make = (lang) => { try { return new Intl.DisplayNames([lang], { type: 'region' }); } catch { return null; } };
  const de = make('de');
  const en = make('en');
  return (cc) => {
    const out = [];
    for (const d of [de, en]) { try { const n = d && d.of(cc); if (n && n !== cc) out.push(n); } catch { /* unknown code */ } }
    return out;
  };
})();

/** The words of names for `search`: folded, each once, German umlauts also as ae / oe / ue. */
function searchText(names) {
  const words = new Set();
  for (const n of names) {
    if (!n) continue;
    const raw = String(n).toLowerCase();
    for (const w of fold(n).split(/[^a-z0-9]+/)) if (w) words.add(w);
    if (/[äöü]/.test(raw)) for (const w of raw.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/)) if (w) words.add(w);
  }
  return ` ${[...words].join(' ')} `;
}

/** A position of a body → { lat, lon } (6 decimals), null for (0, 0); else 400 invalid { field: 'geo' }. */
function geoArg(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail('invalid', { field: 'geo' });
  const num = (x) => (typeof x === 'number' ? x : (typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN));
  const lat = num(v.lat);
  const lon = num(v.lon != null ? v.lon : v.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw fail('invalid', { field: 'geo' });
  if (lat === 0 && lon === 0) return null;
  const r = (x) => Math.round(x * 1e6) / 1e6;
  return { lat: r(lat), lon: r(lon) };
}

/** Inside a transaction: the rows of geo_places for a lookup's places (made where missing). */
async function remember(gc, city, district) {
  const put = async (p, kind, parent, names) => {
    const region = p.regionDe || p.region || null;
    await store.run(gc, `INSERT INTO geo_places (id, kind, parent, name, region, country, lat, lon, search) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO NOTHING`, [p.id, kind, parent, p.de || p.name, region, p.country, p.lat, p.lon, searchText(names)]);
  };
  if (city) await put(city, 'city', null, [city.name, city.de, city.en, city.region, city.regionDe, city.country, ...countryNames(city.country)]);
  if (district) await put(district, 'district', city ? city.id : null, [district.name, district.de, district.en]);
}

/** Inside a transaction: node `id` was taken at `geo` ({ lat, lon }) → its place is named. */
async function setGeo(ctx, id, geo) {
  const { city, district } = geonames.lookup(geo.lat, geo.lon);
  await remember(ctx.gc, city, district);
  await store.run(ctx.gc, 'UPDATE nodes SET geo_lat = ?, geo_lon = ?, geo_place = ?, geo_district = ?, geo_none = NULL, geo_at = ? WHERE id = ?',
    [geo.lat, geo.lon, city ? city.id : null, district ? district.id : null, ctx.now, id]);
}

/** Inside a transaction: node `id` has no position (looked at). */
async function setNone(ctx, id) {
  await store.run(ctx.gc, 'UPDATE nodes SET geo_lat = NULL, geo_lon = NULL, geo_place = NULL, geo_district = NULL, geo_none = 1, geo_at = ? WHERE id = ?', [ctx.now, id]);
}

/** May a position of person `uid` be kept? (photos/settings keepGeo, work.js) */
async function keeps(ctx) {
  const s = await require('./work').stored(ctx.gc, ctx.viewer);
  return s.keepGeo !== false;
}

const isMedia = (n) => n.is_dir === 0 && /^(image|video)\//.test(String(n.mime || ''));

/** PUT nodes/<id>/geo { lat, lon } | { none: true } → { node } */
async function put(ctx, id, body) {
  const b = body && typeof body === 'object' ? body : {};
  const none = b.none === true;
  const geo = none ? null : geoArg(b);
  const n = posInt(id);
  if (!n) throw fail('not_found');
  const keep = await keeps(ctx);
  return store.tx(ctx.gc, async () => {
    const { node, area } = await nodes.reach(ctx, n, 'write');
    if (node.vault_id) throw fail('encrypted');
    if (area.archived_at != null) throw fail('forbidden');
    if (!isMedia(node)) throw fail('invalid', { field: 'id' });
    if (keep) {
      if (geo) await setGeo(ctx, node.id, geo); else await setNone(ctx, node.id);
    }
    return { node: nodes.view(await nodes.row(ctx.gc, node.id)) };
  });
}

/** The places of rows (geo_place / geo_district) → Map id → geo_places row. */
async function placeRows(gc, rows) {
  const ids = new Set();
  for (const r of rows) { if (r.geo_place != null) ids.add(r.geo_place); if (r.geo_district != null) ids.add(r.geo_district); }
  const out = new Map();
  for (const part of store.chunks([...ids])) {
    for (const p of await store.all(gc, `SELECT * FROM geo_places WHERE id IN (${store.marks(part.length)})`, part)) out.set(p.id, p);
  }
  return out;
}

const keyOf = (id) => `geonames:${id}`;

/** The place as answers carry it: { key, name, district, region, country } or null. */
function placeOf(r, places) {
  const c = r.geo_place != null ? places.get(r.geo_place) : null;
  if (!c) return null;
  const d = r.geo_district != null ? places.get(r.geo_district) : null;
  return { key: keyOf(c.id), name: c.name, district: d ? d.name : null, region: c.region || null, country: c.country };
}

/** geo and located of a node row (`places` from placeRows). */
function geoOf(r, places) {
  return {
    geo: r.geo_lat != null ? { lat: r.geo_lat, lon: r.geo_lon, place: placeOf(r, places) } : null,
    located: r.geo_lat != null || r.geo_none === 1,
  };
}

/** Every file node of an answer (previews.nodesOf) gets geo and located (in place). Never fails the request. */
async function attach(ctx, list) {
  const files = list.filter((n) => n && !n.isDir && !Object.prototype.hasOwnProperty.call(n, 'located'));
  if (!files.length) return;
  const ids = [...new Set(files.map((n) => n.id).filter((x) => Number.isSafeInteger(x)))];
  const rows = new Map();
  for (const part of store.chunks(ids)) {
    for (const r of await store.all(ctx.gc, `SELECT id, geo_lat, geo_lon, geo_place, geo_district, geo_none FROM nodes WHERE id IN (${store.marks(part.length)})`, part)) rows.set(r.id, r);
  }
  const places = await placeRows(ctx.gc, [...rows.values()]);
  for (const n of files) {
    const r = rows.get(n.id);
    Object.assign(n, r ? geoOf(r, places) : { geo: null, located: false });
  }
}

/** place=<key> → the geonameid, else 400 invalid { field: 'place' }. */
function keyArg(v) {
  const m = KEY_RE.exec(String(v == null ? '' : v).trim());
  if (!m) throw fail('invalid', { field: 'place' });
  return Number(m[1]);
}

/** bbox=<w,s,e,n> → { w, s, e, n } (w > e: across the date line), else 400 invalid { field: 'bbox' }. */
function bboxArg(v) {
  const p = String(v == null ? '' : v).split(',').map((x) => (x.trim() === '' ? NaN : Number(x)));
  if (p.length !== 4 || p.some((x) => !Number.isFinite(x))) throw fail('invalid', { field: 'bbox' });
  let [w, s, e, n] = p;
  if (s > n || s < -90 || n > 90) throw fail('invalid', { field: 'bbox' });
  if (e - w >= 360) { w = -180; e = 180; } else {
    const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
    w = wrap(w);
    e = wrap(e);
    if (e === -180 && p[2] > p[0]) e = 180;
  }
  return { w, s, e, n };
}

/** Scope `sc` narrowed by place= (its city or a district), bbox= and unlocated= → { where, args }. */
function narrow(sc, q, opts = {}) {
  let { where } = sc;
  const args = [...sc.args];
  if (q.place != null && q.place !== '') {
    const id = keyArg(q.place);
    where += ' AND (geo_place = ? OR geo_district = ?)';
    args.push(id, id);
  }
  if (q.bbox != null && q.bbox !== '') {
    const b = bboxArg(q.bbox);
    where += ` AND geo_lat IS NOT NULL AND geo_lat BETWEEN ? AND ? AND ${b.w <= b.e ? 'geo_lon BETWEEN ? AND ?' : '(geo_lon >= ? OR geo_lon <= ?)'}`;
    args.push(b.s, b.n, b.w, b.e);
  }
  if (opts.unlocated) where += ' AND geo_lat IS NULL AND geo_none IS NULL';
  return { where, args };
}

/** districts=1 with place=: the districts of the photos of `sc` → [{ name, count }] by count. */
async function districts(ctx, sc) {
  const rows = await store.all(ctx.gc, `SELECT g.name AS name, COUNT(*) AS n FROM nodes JOIN geo_places g ON g.id = nodes.geo_district
    WHERE nodes.id IN (SELECT id FROM nodes WHERE ${sc.where}) GROUP BY g.id ORDER BY n DESC, g.name LIMIT ?`, [...sc.args, DISTRICTS_MAX]);
  return rows.map((r) => ({ name: r.name, count: r.n }));
}

/**
 * The SQL of one search word for places: the photos whose city or district has a name with that word (or one starting
 * with it, 3 letters and more) → { sql, args, pattern }.
 */
function wordClause(word) {
  const w = fold(word).replace(/[^a-z0-9]+/g, ' ').trim();
  const pattern = w.length >= 3 ? `% ${like(w)}%` : `% ${like(w)} %`;
  return {
    sql: "(geo_place IN (SELECT id FROM geo_places WHERE search LIKE ? ESCAPE '\\') OR geo_district IN (SELECT id FROM geo_places WHERE search LIKE ? ESCAPE '\\'))",
    args: [pattern, pattern],
    pattern,
  };
}

/** The places a search found (its words' patterns) among the photos of `sc` → [{ key, name }] (≤ 5). */
async function marks(ctx, sc, patterns) {
  if (!patterns.length) return [];
  const out = [];
  for (const pattern of patterns) {
    const rows = await store.all(ctx.gc, `SELECT g.id, g.name, COUNT(*) AS n FROM nodes JOIN geo_places g ON g.id = nodes.geo_place OR g.id = nodes.geo_district
      WHERE nodes.id IN (SELECT id FROM nodes WHERE ${sc.where}) AND g.search LIKE ? ESCAPE '\\' GROUP BY g.id ORDER BY n DESC LIMIT ?`, [...sc.args, pattern, SUGGEST_MAX]);
    for (const r of rows) if (!out.some((x) => x.key === keyOf(r.id))) out.push({ key: keyOf(r.id), name: r.name });
  }
  return out.slice(0, SUGGEST_MAX);
}

const TAKEN = nodes.TAKEN;

/** GET photos/places → { places } — `sc` the photos of the filters (photos.js). */
async function list(ctx, sc) {
  if (!sc) return { places: [] };
  const rows = await store.all(ctx.gc, `SELECT * FROM (
      SELECT id, geo_place, COUNT(*) OVER (PARTITION BY geo_place) AS n, MIN(t) OVER (PARTITION BY geo_place) AS f, MAX(t) OVER (PARTITION BY geo_place) AS l,
        ROW_NUMBER() OVER (PARTITION BY geo_place ORDER BY t DESC, id DESC) AS rn
      FROM (SELECT id, geo_place, ${TAKEN} AS t FROM nodes WHERE ${sc.where} AND geo_place IS NOT NULL))
    WHERE rn = 1 ORDER BY n DESC, geo_place LIMIT ?`, [...sc.args, PLACES_MAX]);
  const places = await placeRows(ctx.gc, rows);
  const covers = await coverItems(ctx, rows.map((r) => r.id));
  return {
    places: rows.filter((r) => places.has(r.geo_place)).map((r) => {
      const p = places.get(r.geo_place);
      return { key: keyOf(p.id), name: p.name, region: p.region || null, country: p.country, count: r.n, lat: p.lat, lon: p.lon, from: iso(r.f), to: iso(r.l), cover: covers.get(r.id) || null };
    }),
  };
}

/**
 * The overview (since 1.18.0): the photos of `sc` with a place → { top: [≤ max { key, name, count }] by count, cluster:
 * { lat, lon, count } — at the place with the most photos, with the count of every photo with a place (the overview's
 * small map shows one bubble) —, total }; null: none has a place.
 */
async function summary(ctx, sc, max) {
  if (!sc) return null;
  const tot = await store.one(ctx.gc, `SELECT COUNT(*) AS n, AVG(geo_lat) AS lat, AVG(geo_lon) AS lon FROM nodes WHERE ${sc.where} AND geo_lat IS NOT NULL`, sc.args);
  if (!tot || !tot.n) return null;
  const rows = await store.all(ctx.gc, `SELECT geo_place, COUNT(*) AS n FROM nodes WHERE ${sc.where} AND geo_place IS NOT NULL GROUP BY geo_place ORDER BY n DESC, geo_place LIMIT ?`,
    [...sc.args, max]);
  const named = await placeRows(ctx.gc, rows);
  const top = rows.filter((r) => named.has(r.geo_place)).map((r) => ({ key: keyOf(r.geo_place), name: named.get(r.geo_place).name, count: r.n }));
  const at = rows.length && named.has(rows[0].geo_place) ? named.get(rows[0].geo_place) : null;
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  return { top, cluster: { lat: r6(at ? at.lat : tot.lat), lon: r6(at ? at.lon : tot.lon), count: tot.n }, total: tot.n };
}

/** Photo items of node ids → Map id → item. */
async function coverItems(ctx, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = [];
  for (const part of store.chunks(ids)) rows.push(...await store.all(ctx.gc, `SELECT * FROM nodes WHERE id IN (${store.marks(part.length)})`, part));
  const items = await require('./photos').itemsOf(ctx, rows);
  for (const it of items) out.set(it.id, it);
  return out;
}

/** zoom=0..19 → number, else 400 invalid { field: 'zoom' }. */
function zoomArg(v) {
  const z = Number(v);
  if (v == null || v === '' || !Number.isInteger(z) || z < 0 || z > 19) throw fail('invalid', { field: 'zoom' });
  return z;
}

/** GET photos/map?bbox=&zoom= → { clusters } — `sc` the photos of the filters, already narrowed to bbox. */
async function map(ctx, sc, q) {
  const zoom = zoomArg(q && q.zoom);
  if (q.bbox == null || q.bbox === '') throw fail('invalid', { field: 'bbox' });
  if (!sc) return { clusters: [] };
  const b = bboxArg(q.bbox);
  const lonx = b.w <= b.e ? 'geo_lon' : 'CASE WHEN geo_lon < ? THEN geo_lon + 360 ELSE geo_lon END';
  const lonArgs = b.w <= b.e ? [] : [b.w];
  let cell = (360 / 2 ** zoom) * (CELL_PX / 256);
  const inner = (c) => ({
    sql: `SELECT id, geo_lat, geo_place, lx, t, CAST((lx - ?) / ? AS INTEGER) AS cx, CAST((geo_lat - ?) / ? AS INTEGER) AS cy FROM (
      SELECT id, geo_lat, geo_place, ${lonx} AS lx, ${TAKEN} AS t FROM nodes WHERE ${sc.where} AND geo_lat IS NOT NULL)`,
    args: [b.w, c, b.s, c, ...lonArgs, ...sc.args],
  });
  // a coarser grid while there would be more clusters than CLUSTERS_MAX
  for (let i = 0; i < 8; i++) {
    const x = inner(cell);
    const r = await store.one(ctx.gc, `SELECT COUNT(*) AS n FROM (SELECT 1 FROM (${x.sql}) GROUP BY cx, cy)`, x.args);
    if (!r || r.n <= CLUSTERS_MAX) break;
    cell *= 2;
  }
  const x = inner(cell);
  const rows = await store.all(ctx.gc, `SELECT * FROM (
      SELECT id, COUNT(*) OVER w AS n, AVG(geo_lat) OVER w AS lat, AVG(lx) OVER w AS lon, MIN(geo_place) OVER w AS p1, MAX(geo_place) OVER w AS p2,
        COUNT(geo_place) OVER w AS np, ROW_NUMBER() OVER (PARTITION BY cx, cy ORDER BY t DESC, id DESC) AS rn
      FROM (${x.sql}) WINDOW w AS (PARTITION BY cx, cy))
    WHERE rn = 1 ORDER BY n DESC LIMIT ?`, [...x.args, CLUSTERS_MAX]);
  const covers = await coverItems(ctx, rows.map((r) => r.id));
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  return {
    clusters: rows.map((r) => ({
      lat: r6(r.lat), lon: r6(r.lon > 180 ? r.lon - 360 : r.lon), count: r.n,
      key: r.np === r.n && r.p1 != null && r.p1 === r.p2 ? keyOf(r.p1) : null, cover: covers.get(r.id) || null,
    })),
  };
}

/** GET photos/suggest: the places whose name starts with `text` among the photos of `sc` → [{ key, name, sub, count }]. */
async function suggest(ctx, sc, text) {
  const w = fold(text).replace(/[^a-z0-9]+/g, ' ').trim();
  if (!w || !sc) return [];
  const pattern = `% ${like(w)}%`;
  const rows = await store.all(ctx.gc, `SELECT g.id, g.kind, g.name, g.region, g.country, g.parent, COUNT(*) AS n FROM nodes JOIN geo_places g ON g.id = nodes.geo_place OR g.id = nodes.geo_district
    WHERE nodes.id IN (SELECT id FROM nodes WHERE ${sc.where}) AND g.search LIKE ? ESCAPE '\\' GROUP BY g.id ORDER BY n DESC, g.name LIMIT ?`, [...sc.args, pattern, SUGGEST_MAX]);
  const parents = await placeRows(ctx.gc, rows.filter((r) => r.parent != null).map((r) => ({ geo_place: r.parent })));
  const country = (cc) => { try { return new Intl.DisplayNames([ctx.lang === 'en' ? 'en' : 'de'], { type: 'region' }).of(cc) || cc; } catch { return cc; } };
  return rows.map((r) => ({
    key: keyOf(r.id), name: r.name,
    sub: r.kind === 'district' && parents.get(r.parent) ? parents.get(r.parent).name : [r.region, country(r.country)].filter(Boolean).join(', '),
    count: r.n,
  }));
}

/** DELETE photos/geo → { deleted } — the places of every photo the viewer uploaded (marked none). */
async function removeMine(ctx) {
  return store.tx(ctx.gc, async () => {
    const r = await store.run(ctx.gc, `UPDATE nodes SET geo_lat = NULL, geo_lon = NULL, geo_place = NULL, geo_district = NULL, geo_none = 1, geo_at = ?
      WHERE created_by = ? AND is_dir = 0 AND geo_lat IS NOT NULL`, [ctx.now, ctx.viewer]);
    return { deleted: (r && r.changes) || 0 };
  });
}

module.exports = {
  geoArg, setGeo, setNone, keeps, put, attach, geoOf, placeRows, placeOf, keyArg, bboxArg, narrow, districts, wordClause, marks, list, map, suggest,
  removeMine, searchText, fold, keyOf, coverItems, summary,
};
