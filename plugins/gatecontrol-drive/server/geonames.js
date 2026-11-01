'use strict';

// Place names offline (since 1.16.0, feature `photoPlaces`): the populated places of GeoNames (cities1000, CC BY 4.0 —
// https://www.geonames.org) in server/places.txt.gz, built by test/build-places.js — no service, no network. Loaded on
// the first use (~170 000 places, ~10 MB in memory) with a grid of 0.25° for the nearest place.
//
//   lookup(lat, lon) → { city, district } — places { id, name, de, en, region, regionDe, country, lat, lon } or null:
//                      the nearest place within 50 km; a district (Ortsteil) of a city gives both, a city the nearest
//                      of its districts within 3 km
//   place(id)        → that place (by geonameid) or null
//   loaded()         → whether the data could be read (false: no names, the coordinates are kept anyway)

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const FILE = path.join(__dirname, 'places.txt.gz');
const CELL = 0.25;
const ROWS = 180 / CELL;
const COLS = 360 / CELL;
const NEAR_KM = 50;
const DISTRICT_KM = 3;
const KM_PER_DEG = 111.32;

let data = null;
let failed = false;

const cellOf = (lat, lon) => {
  const r = Math.min(ROWS - 1, Math.max(0, Math.floor((lat + 90) / CELL)));
  const c = ((Math.floor((lon + 180) / CELL) % COLS) + COLS) % COLS;
  return r * COLS + c;
};

function load() {
  if (data || failed) return data;
  try {
    const text = zlib.gunzipSync(fs.readFileSync(FILE)).toString('utf8');
    const lines = text.split('\n');
    if (lines[0] !== 'GN1') throw new Error('places: unknown format');
    let i = 1;
    const regions = [];
    for (; i < lines.length && lines[i] !== '--'; i++) {
      const [name, de] = lines[i].split('\t');
      regions.push({ name, de: de || null });
    }
    i++;
    const n = lines.length - i;
    const ids = new Int32Array(n);
    const lat = new Int32Array(n);
    const lon = new Int32Array(n);
    const region = new Int32Array(n);
    const parent = new Int32Array(n);
    const country = new Uint16Array(n);
    const countries = [];
    const ccIdx = new Map();
    // the names in one string: name, German name, English name of each place one after the other (offsets)
    const nameAt = new Int32Array(n + 1);
    const deAt = new Int32Array(n);
    const enAt = new Int32Array(n);
    const pool = [];
    let at = 0;
    let id = 0;
    let k = 0;
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (!l) continue;
      const c = l.split('\t');
      id += Number(c[0]);
      ids[k] = id;
      lat[k] = Number(c[1]);
      lon[k] = Number(c[2]);
      if (!ccIdx.has(c[3])) { ccIdx.set(c[3], countries.length); countries.push(c[3]); }
      country[k] = ccIdx.get(c[3]);
      region[k] = c[4] === '' ? -1 : Number(c[4]);
      parent[k] = c[5] === '' ? -1 : Number(c[5]);
      nameAt[k] = at;
      pool.push(c[6]);
      at += c[6].length;
      deAt[k] = at;
      pool.push(c[7] || '');
      at += (c[7] || '').length;
      enAt[k] = at;
      pool.push(c[8] || '');
      at += (c[8] || '').length;
      k++;
    }
    nameAt[k] = at;
    // the grid: the places sorted by cell, the cells used (sorted) with where their places start
    const cells = new Int32Array(k);
    for (let j = 0; j < k; j++) cells[j] = cellOf(lat[j] / 1e4, lon[j] / 1e4);
    const order = new Int32Array(k);
    for (let j = 0; j < k; j++) order[j] = j;
    order.sort((a, b) => cells[a] - cells[b]);
    let used = 0;
    for (let j = 0; j < k; j++) if (j === 0 || cells[order[j]] !== cells[order[j - 1]]) used++;
    const cellIds = new Int32Array(used);
    const cellAt = new Int32Array(used + 1);
    let u = 0;
    for (let j = 0; j < k; j++) {
      if (j === 0 || cells[order[j]] !== cells[order[j - 1]]) { cellIds[u] = cells[order[j]]; cellAt[u] = j; u++; }
    }
    cellAt[used] = k;
    data = { n: k, ids, lat, lon, region, parent, country, countries, pool: pool.join(''), nameAt, deAt, enAt, regions, order, cellIds, cellAt };
  } catch {
    failed = true;
    data = null;
  }
  return data;
}

/** Distance in km (equirectangular — exact enough below 100 km). */
function km(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  let dl = lon2 - lon1;
  if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
  const x = dl * r * Math.cos(((lat1 + lat2) / 2) * r);
  const y = (lat2 - lat1) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}

/** The index of `v` in the sorted `arr`, or -1. */
function search(arr, v) {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] === v) return m;
    if (arr[m] < v) lo = m + 1; else hi = m - 1;
  }
  return -1;
}

const text = (d, a, b) => (b > a ? d.pool.slice(a, b) : null);

/** Every place within `radius` km of (lat, lon) → fn(index, km) — the cells around it. */
function around(d, lat, lon, radius, fn) {
  const rr = Math.ceil(radius / (KM_PER_DEG * CELL));
  const cos = Math.max(0.05, Math.cos((Math.min(89, Math.abs(lat) + rr * CELL) * Math.PI) / 180));
  const rc = Math.min(COLS / 2, Math.ceil(radius / (KM_PER_DEG * CELL * cos)));
  const r0 = Math.floor((lat + 90) / CELL);
  const c0 = Math.floor((lon + 180) / CELL);
  for (let r = Math.max(0, r0 - rr); r <= Math.min(ROWS - 1, r0 + rr); r++) {
    for (let dc = -rc; dc <= rc; dc++) {
      const c = (((c0 + dc) % COLS) + COLS) % COLS;
      const s = search(d.cellIds, r * COLS + c);
      if (s < 0) continue;
      for (let j = d.cellAt[s]; j < d.cellAt[s + 1]; j++) {
        const x = d.order[j];
        const dist = km(lat, lon, d.lat[x] / 1e4, d.lon[x] / 1e4);
        if (dist <= radius) fn(x, dist);
      }
    }
  }
}

function view(d, x) {
  if (x < 0) return null;
  const r = d.region[x] >= 0 ? d.regions[d.region[x]] : null;
  return {
    id: d.ids[x], name: text(d, d.nameAt[x], d.deAt[x]), de: text(d, d.deAt[x], d.enAt[x]), en: text(d, d.enAt[x], d.nameAt[x + 1]), country: d.countries[d.country[x]],
    region: r ? r.name : null, regionDe: r ? r.de : null, lat: d.lat[x] / 1e4, lon: d.lon[x] / 1e4, parent: d.parent[x] >= 0 ? d.ids[d.parent[x]] : null,
  };
}

/** (lat, lon) → { city, district } (each a place or null). */
function lookup(lat, lon) {
  const d = load();
  if (!d) return { city: null, district: null };
  let best = -1;
  let bestKm = Infinity;
  // near first (cheap), then the full radius
  for (const radius of [5, NEAR_KM]) {
    around(d, lat, lon, radius, (x, dist) => { if (dist < bestKm) { bestKm = dist; best = x; } });
    if (best >= 0) break;
  }
  if (best < 0) return { city: null, district: null };
  if (d.parent[best] >= 0) return { city: view(d, d.parent[best]), district: view(d, best) };
  let dist = -1;
  let distKm = Infinity;
  around(d, lat, lon, DISTRICT_KM, (x, k) => { if (d.parent[x] === best && k < distKm) { distKm = k; dist = x; } });
  return { city: view(d, best), district: view(d, dist) };
}

/** A place by its geonameid, or null. */
function place(id) {
  const d = load();
  if (!d) return null;
  const x = search(d.ids, Number(id));
  return x < 0 ? null : view(d, x);
}

const loaded = () => !!load();

module.exports = { lookup, place, loaded, km, FILE };
