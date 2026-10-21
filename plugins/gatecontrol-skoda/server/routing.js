'use strict';

// The way of a trip on the map (1.6.0). Škoda reports only where a vehicle
// parks, never the way it drove: the plugin asks OpenStreetMap's routing
// service of FOSSGIS (routing.openstreetmap.de, plugin.json) once per trip for
// the road between start and end and keeps it with the trip (migration 006).
// The apps and the pages say "computed" next to it.
//
//   kind 'road' — the computed road, simplified to ≤ 150 points
//   kind 'line' — only the straight line: the odometer says much more than the
//                 road (a detour, stops on the way), the road is much longer
//                 than the odometer (a wrong snap), or no road was found
//
// One request at a time, at most a few per background tick, a pause between
// them and a User-Agent (the service's usage policy). A failed request (network,
// 5xx, 429) is tried again later — up to MAX_TRIES times, waiting longer each
// time; then the trip keeps no way (the map shows its start and end only).

const ROUTING_HOST = 'routing.openstreetmap.de';
const USER_AGENT = 'GateControl/1.0 (self-hosted vehicle logbook; +https://github.com/CallMeTechie/gatecontrol)';
const REQUEST_TIMEOUT_MS = 10000;
const PER_TICK = 3;
const PAUSE_MS = 1100;
const MAX_TRIES = 5;
const RETRY_BASE_MS = 10 * 60 * 1000;
const STORE_POINTS_MAX = 150;
// the odometer may say more than the road (traffic, a wrong turn) — beyond this it is no longer the same way
const DETOUR_FACTOR = 1.5;
const DETOUR_SLACK_KM = 3;

let pauseMs = PAUSE_MS;
let running = false;

const validCoord = (lat, lon) => typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)
  && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const round5 = (v) => Math.round(v * 1e5) / 1e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Perpendicular distance of p from the segment a–b in degrees (good enough for simplifying a road). */
function segDist(p, a, b) {
  const dx = b[1] - a[1];
  const dy = b[0] - a[0];
  if (!dx && !dy) return Math.hypot(p[1] - a[1], p[0] - a[0]);
  const t = Math.max(0, Math.min(1, ((p[1] - a[1]) * dx + (p[0] - a[0]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[1] - (a[1] + t * dx), p[0] - (a[0] + t * dy));
}

/** Ramer–Douglas–Peucker with tolerance eps (degrees), iterative. */
function rdp(points, eps) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(points[k], points[i], points[j]);
      if (d > best) { best = d; at = k; }
    }
    if (best > eps && at > 0) { keep[at] = 1; stack.push([i, at], [at, j]); }
  }
  return points.filter((_, k) => keep[k]);
}

/** At most max points: simplified with a growing tolerance (≈ 5 m first), start and end kept. */
function thin(points, max) {
  if (!Array.isArray(points) || points.length <= max) return points;
  let eps = 0.00005;
  let out = rdp(points, eps);
  while (out.length > max && eps < 1) { eps *= 2; out = rdp(points, eps); }
  return out.length > max ? [points[0], points[points.length - 1]] : out;
}

/** The GeoJSON coordinates of OSRM ([lon, lat]) → [[lat, lon], …] rounded, or null. */
function pointsOf(coords) {
  if (!Array.isArray(coords) || coords.length < 2 || coords.length > 100000) return null;
  const out = [];
  for (const c of coords) {
    if (!Array.isArray(c) || !validCoord(c[1], c[0])) return null;
    out.push([round5(c[1]), round5(c[0])]);
  }
  return out;
}

/**
 * What to keep for a trip from the routing answer.
 * @returns {{kind:'road'|'line', km:number|null, points:number[][]}}
 */
function classify(trip, route) {
  const line = [[round5(trip.startLat), round5(trip.startLon)], [round5(trip.endLat), round5(trip.endLon)]];
  if (!route) return { kind: 'line', km: null, points: line };
  const km = Math.round(route.distanceM / 100) / 10;
  const driven = Number(trip.distanceKm);
  if (Number.isFinite(driven) && driven > 0) {
    if (driven > km * DETOUR_FACTOR + DETOUR_SLACK_KM) return { kind: 'line', km, points: line };
    if (km > driven * DETOUR_FACTOR + DETOUR_SLACK_KM) return { kind: 'line', km, points: line };
  }
  return { kind: 'road', km, points: thin(route.points, STORE_POINTS_MAX) };
}

/**
 * Ask the routing service for the road from a to b.
 * @returns {Promise<{distanceM:number, points:number[][]}|null>} null = no road (answered, nothing found)
 * @throws on network trouble, 429 and 5xx (try again later)
 */
async function fetchRoute(gc, a, b) {
  const url = `https://${ROUTING_HOST}/routed-car/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?`
    + new URLSearchParams({ overview: 'full', geometries: 'geojson', alternatives: 'false', steps: 'false' }).toString();
  const res = await gc.http.fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, timeoutMs: REQUEST_TIMEOUT_MS });
  if (!res || res.status === 429 || res.status >= 500) throw Object.assign(new Error('routing unavailable'), { status: res && res.status });
  let json = null;
  try { json = JSON.parse(typeof res.body === 'string' ? res.body : ''); } catch { json = null; }
  // 400 NoRoute / InvalidQuery and an answer without a route: nothing to draw but the straight line
  const r = json && json.code === 'Ok' && Array.isArray(json.routes) ? json.routes[0] : null;
  const points = r && r.geometry ? pointsOf(r.geometry.coordinates) : null;
  if (!r || !points || !(Number(r.distance) >= 0)) return null;
  return { distanceM: Number(r.distance), points };
}

async function save(gc, id, out) {
  await gc.db.run("UPDATE trips SET route = ?, route_kind = ?, route_km = ?, route_at = datetime('now') WHERE id = ?",
    [JSON.stringify(out.points), out.kind, out.km, id]);
}

/** Trips that still need a way: with start and end, not tried too often, the last try long enough ago. */
async function pending(gc, now, limit) {
  const rows = (await gc.db.query(
    'SELECT id, vin, distance_km, start_lat, start_lon, end_lat, end_lon, route_tries, route_at FROM trips '
    + 'WHERE route_kind IS NULL AND start_lat IS NOT NULL AND start_lon IS NOT NULL AND end_lat IS NOT NULL AND end_lon IS NOT NULL '
    + 'AND route_tries < ? ORDER BY id DESC LIMIT ?', [MAX_TRIES, limit * 4])).rows;
  return rows.filter((r) => {
    if (!r.route_tries || !r.route_at) return true;
    const at = Date.parse(String(r.route_at).replace(' ', 'T') + 'Z');
    return !Number.isFinite(at) || now - at >= RETRY_BASE_MS * 2 ** (r.route_tries - 1);
  }).slice(0, limit).map((r) => ({
    id: r.id, distanceKm: r.distance_km, startLat: r.start_lat, startLon: r.start_lon, endLat: r.end_lat, endLon: r.end_lon,
  }));
}

/**
 * Background (tick): the way of up to PER_TICK trips, newest first. Never throws.
 * @returns {Promise<number>} how many trips got a way
 */
async function fillRoutes(gc, now = Date.now()) {
  if (running) return 0;
  running = true;
  let done = 0;
  try {
    const trips = await pending(gc, now, PER_TICK);
    for (let i = 0; i < trips.length; i++) {
      const tr = trips[i];
      if (i) await sleep(pauseMs);
      if (!validCoord(tr.startLat, tr.startLon) || !validCoord(tr.endLat, tr.endLon)) {
        await gc.db.run("UPDATE trips SET route_tries = ?, route_at = datetime('now') WHERE id = ?", [MAX_TRIES, tr.id]);
        continue;
      }
      try {
        const route = await fetchRoute(gc, { lat: tr.startLat, lon: tr.startLon }, { lat: tr.endLat, lon: tr.endLon });
        await save(gc, tr.id, classify(tr, route));
        done++;
      } catch (e) {
        await gc.db.run("UPDATE trips SET route_tries = route_tries + 1, route_at = datetime('now') WHERE id = ?", [tr.id]);
        gc.log.warn('routing failed', tr.id, (e && e.status) || (e && e.code) || 'error');
        break; // the service is unhappy: no more requests this tick
      }
    }
  } catch (e) {
    gc.log.warn('routing tick failed', (e && e.code) || (e && e.message) || 'error');
  } finally {
    running = false;
  }
  return done;
}

/** The stored way of a trip row for the pages and apps, thinned to max points; null without one. */
function viewOf(row, max) {
  if (!row || (row.route_kind !== 'road' && row.route_kind !== 'line')) return null;
  let points = null;
  try { points = JSON.parse(row.route); } catch { points = null; }
  if (!Array.isArray(points) || points.length < 2) return null;
  const km = row.route_km == null ? null : Number(row.route_km);
  return { kind: row.route_kind, km: Number.isFinite(km) ? km : null, points: thin(points, Math.max(2, max)) };
}

function reset() { running = false; }

module.exports = {
  ROUTING_HOST, MAX_TRIES, STORE_POINTS_MAX,
  fillRoutes, fetchRoute, classify, thin, rdp, pointsOf, viewOf, reset,
  _setPauseForTest(ms) { pauseMs = ms == null ? PAUSE_MS : ms; },
};
