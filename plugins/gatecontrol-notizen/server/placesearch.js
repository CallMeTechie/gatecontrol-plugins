'use strict';

// 1.5.0: the place search — „which Baumarkt is near?“. The phone never asks a map service itself: it asks THIS server
// with a coarse position, and the server asks a search service that speaks Nominatim's /search (OpenStreetMap data).
//
//   Off unless the administrator chose a service (setting place_search: 'off' | 'osm' | 'own'):
//     osm   the public service nominatim.openstreetmap.org — its usage policy applies
//           (https://operations.osmfoundation.org/policies/nominatim/): at most one request a second for the whole
//           installation, a User-Agent naming the application, results cached, no auto-complete, no systematic
//           queries, only what a person asked for. This module keeps to it: one request at a time with PAUSE_MS
//           between two starts, a cache, a limit per person, never a search per keystroke (README "Place search").
//     own   a Nominatim of one's own — the access target „places“ (plugin.json homeTargets, assigned by the
//           administrator under Zugriffsziele). The policy above does not apply there; the limits stay.
//
//   Privacy: the position is rounded HERE to two decimals (about 1.1 km north–south, 0.7 km east–west at 50° north)
//   before anything else happens with it — whatever the device sent. The search service gets a box around that cell
//   and the search word, never a name, a device or a user id. Nothing of it is written to the database or the log;
//   the cache lives in memory, keyed by word and cell — not by person.
//
//   A kind („Baumarkt“) is searched by its phrase and filtered by its map tags (placewords.KINDS); a name („Lidl“) as
//   it is; both in a box of STEPS_KM around the cell, the nearest first. An address is searched once, near the cell.
//   Distances are from the rounded position (a device knows better and may sort again); minutes are an estimate from
//   the distance: straight line × DETOUR at SPEED_KMH — no routing service is asked.

const clock = require('./clock');
const words = require('./placewords');
const { fail } = require('./util');

const OSM_HOST = 'nominatim.openstreetmap.org';
const POLICY_URL = 'https://operations.osmfoundation.org/policies/nominatim/';
const TARGET = 'places';
const ATTRIBUTION = '© OpenStreetMap';
const ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';
const DECIMALS = 2;            // the rounding of a position (≈ 1 km)
const WATCH_STEP = 0.05;       // the coarser cell of the places a phone watches (≈ 5 km): few searches while moving
const STEPS_KM = [4, 15];      // half the side of the box: first near, then the whole surroundings
const RADIUS_KM = 15;
const ENOUGH = 3;              // hits that make the wider box unnecessary
const LIMIT = 30;              // hits asked of the service per request
const RESULTS_MAX = 10;        // hits answered
const PAUSE_MS = 1100;         // between the starts of two requests (the public service: at most one a second)
const TIMEOUT_MS = 8000;
const QUEUE_MAX = 6;           // searches waiting for their turn; more → busy
const CACHE_MS = 7 * 86400000;
const CACHE_EMPTY_MS = 6 * 3600000;
const CACHE_MAX = 500;
const DOWN_MS = 60000;         // after a failure the service is left alone for this long
const PER_HOUR = 30;           // searches of one person that really go out (cached ones do not count)
const DETOUR = 1.3;
const SPEED_KMH = 30;

const state = { pauseMs: PAUSE_MS, chain: Promise.resolve(), waiting: 0, last: 0, downUntil: 0, cache: new Map(), people: new Map(), targetAt: 0, target: false, version: '0' };

function reset() {
  state.chain = Promise.resolve(); state.waiting = 0; state.last = 0; state.downUntil = 0; state.cache.clear(); state.people.clear(); state.targetAt = 0; state.target = false;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^-?\d{1,3}(?:\.\d+)?$/.test(v) ? Number(v) : NaN);
const validCoord = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const roundTo = (v, step) => Math.round(Math.round(v / step) * step * 1e6) / 1e6;

/** A position as a device sent it → the cell it lies in ({ lat, lon } rounded to DECIMALS) — or null. */
function cellOf(near, step) {
  if (!near || typeof near !== 'object') return null;
  const lat = num(near.lat);
  const lon = num(near.lon);
  if (!validCoord(lat, lon)) return null;
  const s = step || 10 ** -DECIMALS;
  return { lat: roundTo(lat, s), lon: roundTo(Math.max(-180, Math.min(180, lon)), s) };
}

/** Metres between two points (haversine). */
function distance(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h))));
}
/** Minutes by car, estimated from the straight line (README "Place search") — at least one. */
const minutes = (metres) => Math.max(1, Math.round((metres * DETOUR) / (SPEED_KMH * 1000 / 60)));

/** left,top,right,bottom of the box of `km` around a cell (Nominatim's viewbox). */
function boxOf(cell, km) {
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.max(0.1, Math.cos(cell.lat * Math.PI / 180)));
  const f = (v) => String(Math.round(v * 1000) / 1000);
  return [f(Math.max(-180, cell.lon - dLon)), f(Math.min(90, cell.lat + dLat)), f(Math.min(180, cell.lon + dLon)), f(Math.max(-90, cell.lat - dLat))].join(',');
}

/** The administrator's choice: 'off' | 'osm' | 'own'. */
const modeOf = (cfg) => (cfg && (cfg.place_search === 'osm' || cfg.place_search === 'own') ? cfg.place_search : 'off');

/** Is the access target „places“ assigned (asked once a minute)? */
async function targetAssigned(gc) {
  const now = clock.now();
  if (state.targetAt && now - state.targetAt < 60000 && now >= state.targetAt) return state.target;
  let ok = false;
  try {
    const t = gc.net && typeof gc.net.targets === 'function' ? (await gc.net.targets()).find((x) => x.id === TARGET) : null;
    ok = !!(t && Array.isArray(t.assigned) && t.assigned.length);
  } catch { ok = false; }
  state.targetAt = now; state.target = ok;
  return ok;
}

/** Can a search go out now? → 'on' | 'off' (the administrator's switch) | 'unavailable' (own service, no target assigned). */
async function availability(gc, cfg) {
  const mode = modeOf(cfg);
  if (mode === 'off') return 'off';
  if (mode === 'own' && !(await targetAssigned(gc))) return 'unavailable';
  return 'on';
}

const userAgent = () => `GateControl-Notizen/${state.version} (self-hosted task reminders, place search on request of a person; +https://github.com/CallMeTechie/gatecontrol)`;

/** One request to the service → the parsed JSON array (throws on anything else). */
async function ask(gc, mode, params, lang) {
  const qs = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', limit: String(LIMIT), 'accept-language': lang === 'en' ? 'en' : 'de', ...params }).toString();
  const opts = { method: 'GET', headers: { 'user-agent': userAgent(), accept: 'application/json' }, timeoutMs: TIMEOUT_MS };
  const res = mode === 'own' ? await gc.net.fetchTarget(TARGET, '/search?' + qs, opts) : await gc.http.fetch(`https://${OSM_HOST}/search?${qs}`, opts);
  if (!res || res.status !== 200 || typeof res.body !== 'string') throw new Error('status');
  const json = JSON.parse(res.body);
  if (!Array.isArray(json)) throw new Error('shape');
  return json;
}

/** One request at a time, PAUSE_MS between two starts; more than QUEUE_MAX waiting → busy. */
function queued(fn) {
  if (state.waiting >= QUEUE_MAX) throw fail('busy', { retryAfter: Math.ceil((state.waiting * Math.max(state.pauseMs, 1000)) / 1000) });
  state.waiting++;
  const run = async () => {
    try {
      const wait = state.last + state.pauseMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      state.last = Date.now();
      return await fn();
    } finally { state.waiting--; }
  };
  const p = state.chain.then(run, run);
  state.chain = p.catch(() => {});
  return p;
}

const TYPE = { node: 'N', way: 'W', relation: 'R' };
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** One hit of the service → { ref, name, address, lat, lon, tag } | null. */
function hitOf(x, fallback) {
  if (!x || typeof x !== 'object') return null;
  const lat = num(x.lat);
  const lon = num(x.lon);
  if (!validCoord(lat, lon)) return null;
  const a = x.address && typeof x.address === 'object' ? x.address : {};
  const street = [text(a.road || a.pedestrian || a.footway || a.square || '', 80), text(a.house_number || '', 12)].filter(Boolean).join(' ');
  const town = text(a.city || a.town || a.village || a.municipality || a.suburb || '', 60);
  const address = [street, town].filter(Boolean).join(', ') || text(x.display_name, 120);
  const id = TYPE[x.osm_type] && /^\d{1,18}$/.test(String(x.osm_id)) ? `osm:${TYPE[x.osm_type]}${x.osm_id}` : null;
  const name = text(x.name, 80) || fallback || street || text(x.display_name, 80);
  if (!name) return null;
  return { ref: id, name, address, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, tag: `${text(x.category, 30)}=${text(x.type, 40)}` };
}

function remember(key, hits) {
  if (state.cache.size >= CACHE_MAX) state.cache.delete(state.cache.keys().next().value);
  state.cache.set(key, { at: clock.now(), hits });
}
function cached(key) {
  const c = state.cache.get(key);
  if (!c) return null;
  const age = clock.now() - c.at;
  if (age < 0 || age > (c.hits.length ? CACHE_MS : CACHE_EMPTY_MS)) { state.cache.delete(key); return null; }
  return c.hits;
}

/** May this person send one more search to the service now? (counted per hour; throws busy) */
function spend(userId, dry) {
  const now = clock.now();
  const list = (state.people.get(userId) || []).filter((t) => now - t < 3600000 && t <= now);
  if (list.length >= PER_HOUR) throw fail('busy', { reason: 'limit', retryAfter: Math.max(1, Math.ceil((list[0] + 3600000 - now) / 1000)) });
  if (!dry) { list.push(now); state.people.set(userId, list); }
}

/**
 * The places for a key ('kind:diy' | 'name:lidl') or an address near a cell → the hits, the nearest first (each with
 * distanceM and minutes from the cell). o = { key?, address?, cell, lang, userId, cacheOnly? } — cacheOnly: null when
 * the answer is not in the cache (nothing goes out). Throws unavailable when the service fails.
 */
async function find(gc, cfg, o) {
  const mode = modeOf(cfg);
  if (mode === 'off') throw fail('module_off', { reason: 'admin' });
  const lang = o.lang === 'en' ? 'en' : 'de';
  const kind = o.key ? words.kindOf(o.key) : null;
  const q = o.address ? text(o.address, 120) : kind ? `[${kind.phrase}]` : text(String(o.key || '').slice(5), 40);
  if (!q || (!o.cell && !o.address)) throw fail('invalid', { field: o.cell ? 'q' : 'near' });
  const ck = `${mode}|${lang}|${o.address ? 'a' : 'k'}|${q.toLowerCase()}|${o.cell ? o.cell.lat + ',' + o.cell.lon : '-'}`;
  let hits = cached(ck);
  if (!hits) {
    if (o.cacheOnly) return null;
    if (mode === 'own' && !(await targetAssigned(gc))) throw fail('unavailable', { reason: 'service' });
    if (clock.now() < state.downUntil) throw fail('unavailable', { reason: 'service' });
    spend(o.userId, true);
    hits = await queued(async () => {
      // the same search asked twice at once: the second one finds the first one's answer
      const again = cached(ck);
      if (again) return again;
      spend(o.userId);
      const out = new Map();
      try {
        const steps = o.address ? [RADIUS_KM] : STEPS_KM;
        for (let i = 0; i < steps.length; i++) {
          if (i) { const wait = state.last + state.pauseMs - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); state.last = Date.now(); }
          const rows = await ask(gc, mode, { q, ...(o.cell ? { viewbox: boxOf(o.cell, steps[i]) } : {}), ...(o.address ? { limit: '5' } : { bounded: '1' }) }, lang);
          for (const x of rows) {
            const h = hitOf(x, kind ? words.labelOf(o.key, lang) : '');
            if (!h || (kind && !kind.tags.includes(h.tag))) continue;
            const k = h.ref || `${h.lat},${h.lon}`;
            if (!out.has(k)) out.set(k, h);
          }
          if (out.size >= ENOUGH) break;
        }
      } catch (e) {
        state.downUntil = clock.now() + DOWN_MS;
        // never the query or the position: only that it failed
        if (gc.log && gc.log.warn) gc.log.warn('place search failed', (e && e.code) || 'error');
        throw fail('unavailable', { reason: 'service' });
      }
      // branches of one name („Lidl“, „Lidl“) are told apart by their street: „Lidl Marktstraße“, „Lidl Bahnhofsplatz“
      const names = new Map();
      for (const h of out.values()) names.set(h.name, (names.get(h.name) || 0) + 1);
      for (const h of out.values()) {
        const street = h.address.split(',')[0].replace(/\s+\d+\s?[a-zA-Z]?(?:-\d+)?$/, '').trim();
        if (names.get(h.name) > 1 && street && street !== h.name && !h.name.includes(street)) h.name = `${h.name} ${street}`.slice(0, 80);
      }
      const list = [...out.values()].map((h) => { const d = o.cell ? distance(o.cell, h) : null; return { ...h, distanceM: d, minutes: d == null ? null : minutes(d) }; })
        .filter((h) => o.address || h.distanceM <= RADIUS_KM * 1500).sort((a, b) => (a.distanceM || 0) - (b.distanceM || 0)).slice(0, 40);
      remember(ck, list);
      return list;
    });
  }
  return hits;
}

module.exports = { find, cellOf, distance, minutes, boxOf, modeOf, availability, targetAssigned, hitOf, reset, state,
  OSM_HOST, POLICY_URL, TARGET, ATTRIBUTION, ATTRIBUTION_URL, RADIUS_KM, RESULTS_MAX, WATCH_STEP, PER_HOUR, PAUSE_MS, DECIMALS };
