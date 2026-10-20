'use strict';

// The logbook (Fahrtenbuch, 1.5.0): trips detected from the vehicle state the
// plugin polls anyway, classified as private / business / commute, exported
// as CSV and PDF.
//
// Detection (observe, after every sync of a vehicle): the vehicle's last
// parking spot is kept per VIN (trip_state: mileage, position, address, when
// it was last seen there). A sync without a position (MySkoda reports none
// while the vehicle moves) marks it as moving; the next sync with a position
// and a mileage at least 1 km higher records one trip — from the last spot to
// the new one, the mileage difference as its distance, departure = the last
// sync that still saw it parked (accurate to the poll interval), arrival =
// the time the vehicle reported its state (carCapturedTimestamp). Several
// stops between two syncs become one trip. The addresses come from the
// geocoder (OpenStreetMap, cached). A lower mileage resets the spot.
// 1.5.2: Škoda often reports the new position before the higher mileage. A
// sync that sees the vehicle parked clearly elsewhere (> 1 km) with the old
// mileage keeps the last spot as the start and remembers the arrival (time and
// place); the trip is recorded as soon as a sync reports the higher mileage,
// ending at that arrival. After two days without a higher mileage the arrival
// becomes the new spot. The mileage is the higher of the warning-light and
// the maintenance report.
// 1.5.3: addresses are Škoda's own address of the parking position (what the
// MySkoda app shows); OpenStreetMap only when Škoda gives none. Start and
// destination can be corrected by hand.
//
// A new trip gets the purpose of the setting `logbook_default` (none by
// default), the vehicle's only owner as driver, and — while it has no
// purpose — a push to the vehicle's owners (topic `trip`) with the buttons
// Privat / Geschäftlich / Arbeitsweg (callbacks → notifyAction).

const geocode = require('./geocode');
const notify = require('./notify');
const store = require('./store');
const { PdfDoc } = require('./pdf');
const texts = require('./texts.json');

const PURPOSES = Object.freeze(['private', 'business', 'commute']);
const MIN_KM = 1;
const MOVED_M = 300;          // a parked vehicle moved further than this (no mileage change): new spot
const ARRIVED_M = 1000;       // … further than this: it drove there, the higher mileage follows later
const ARRIVAL_WAIT_MS = 2 * 86400000;
const EXPORT_MONTHS_MAX = 24;
const EXPORT_ROWS_MAX = 3000;
const NOTE_MAX = 200;
const ADDRESS_MAX = 200;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function t(lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

function fail(code) { return Object.assign(new Error(code), { code }); }

// ─── Time zone (the server's: TZ of the plugin process, else Intl's) ──────

const FALLBACK_TZ = 'Europe/Berlin';
let tzCache = null;
function serverTz() {
  if (tzCache) return tzCache;
  const ok = (z) => { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; } };
  const env = typeof process !== 'undefined' && process.env ? process.env.TZ : null;
  let z = env && ok(env) ? env : null;
  if (!z) { try { z = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { z = null; } }
  tzCache = z && ok(z) ? z : FALLBACK_TZ;
  return tzCache;
}

const fmtCache = new Map();
/** Wall clock of `ms` in the server's zone → { y, m, d, hh, mm }. */
function parts(ms, tz = serverTz()) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    fmtCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), hh: Number(o.hour) % 24, mm: Number(o.minute) };
}

/** Wall clock in the server's zone → ms (DST gaps move forward). */
function toUtc(y, m, d, hh = 0, mm = 0, tz = serverTz()) {
  const local = Date.UTC(y, m - 1, d, hh, mm);
  const off = (ms) => { const p = parts(ms, tz); return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - Math.floor(ms / 60000) * 60000; };
  const a = local - off(local - 86400000);
  const b = local - off(local + 86400000);
  const okA = off(a) === off(local - 86400000);
  const okB = off(b) === off(local + 86400000);
  if (okA && okB) return Math.min(a, b);
  return okA ? a : (okB ? b : a);
}

const pad = (n) => String(n).padStart(2, '0');
const ymOf = (p) => `${p.y}-${pad(p.m)}`;

/** "YYYY-MM" → [startMs, endMs) of that month in the server's zone; null when malformed. */
function monthRange(ym) {
  const m = MONTH_RE.exec(String(ym || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return [toUtc(y, mo, 1), mo === 12 ? toUtc(y + 1, 1, 1) : toUtc(y, mo + 1, 1)];
}

function currentMonth(now = Date.now()) { return ymOf(parts(now)); }

function monthsBetween(a, b) {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma) + 1;
}

function fmtDate(ms, lang) {
  const p = parts(ms);
  return lang === 'en' ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : `${pad(p.d)}.${pad(p.m)}.${p.y}`;
}
function fmtTime(ms) { const p = parts(ms); return `${pad(p.hh)}:${pad(p.mm)}`; }
/** "YYYY-MM" → "Oktober 2026" / "October 2026". */
function monthName(ym, lang) {
  const [y, m] = String(ym).split('-').map(Number);
  try { return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' }); } catch { return ym; }
}
function fmtKm(v, lang) { return Number(v).toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { maximumFractionDigits: 0 }); }

// ─── Storage ────────────────────────────────────

const iso = (ms) => new Date(ms).toISOString();
const validCoord = (lat, lon) => typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)
  && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

function distanceM(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function rowToTrip(r) {
  if (!r) return null;
  return {
    id: r.id, vin: r.vin, startedAt: r.started_at, endedAt: r.ended_at,
    startKm: r.start_km, endKm: r.end_km, distanceKm: r.distance_km,
    startLat: r.start_lat, startLon: r.start_lon, startAddress: r.start_address || null,
    endLat: r.end_lat, endLon: r.end_lon, endAddress: r.end_address || null,
    purpose: PURPOSES.includes(r.purpose) ? r.purpose : null, note: r.note || '',
    driverUserId: r.driver_user_id == null ? null : Number(r.driver_user_id),
    source: r.source === 'manual' ? 'manual' : 'auto', editedAt: r.edited_at || null,
  };
}

async function getTrip(gc, id) {
  return rowToTrip((await gc.db.get('SELECT * FROM trips WHERE id = ?', [Number(id)])).row);
}

/** Trips of a VIN starting in [fromMs, toMs), oldest first. */
async function listTrips(gc, vin, fromMs, toMs, limit = EXPORT_ROWS_MAX + 1) {
  return (await gc.db.query('SELECT * FROM trips WHERE vin = ? AND started_at >= ? AND started_at < ? ORDER BY started_at, id LIMIT ?',
    [vin, iso(fromMs), iso(toMs), limit])).rows.map(rowToTrip);
}

async function lastTrip(gc, vin) {
  return rowToTrip((await gc.db.get('SELECT * FROM trips WHERE vin = ? ORDER BY ended_at DESC, id DESC LIMIT 1', [vin])).row);
}

async function hasTrips(gc, vin) {
  return Boolean((await gc.db.get('SELECT 1 AS x FROM trips WHERE vin = ? LIMIT 1', [vin])).row);
}

function summary(trips) {
  const s = { count: trips.length, total: 0, private: 0, business: 0, commute: 0, open: 0, openCount: 0 };
  for (const tr of trips) {
    const km = Number(tr.distanceKm) || 0;
    s.total += km;
    if (tr.purpose) s[tr.purpose] += km;
    else { s.open += km; s.openCount += 1; }
  }
  return s;
}

async function defaultPurpose(gc) {
  const v = await gc.settings.get('logbook_default');
  return PURPOSES.includes(v) ? v : null;
}

async function getSpot(gc, vin) {
  return (await gc.db.get('SELECT * FROM trip_state WHERE vin = ?', [vin])).row || null;
}

async function setSpot(gc, vin, s) {
  await gc.db.run(`INSERT INTO trip_state (vin, km, lat, lon, address, seen_at, moving_since, arrived_lat, arrived_lon, arrived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vin) DO UPDATE SET km = excluded.km, lat = excluded.lat, lon = excluded.lon, address = excluded.address,
      seen_at = excluded.seen_at, moving_since = excluded.moving_since, arrived_lat = excluded.arrived_lat,
      arrived_lon = excluded.arrived_lon, arrived_at = excluded.arrived_at`,
  [vin, s.km, s.lat, s.lon, s.address, s.seen_at, s.moving_since, s.arrived_lat ?? null, s.arrived_lon ?? null, s.arrived_at ?? null]);
}

/** For the logbook page: the last mileage, and since when a trip waits for the higher mileage. */
async function detection(gc, vin) {
  const s = await getSpot(gc, vin);
  return {
    km: s && s.km != null ? Number(s.km) : null,
    waitingSince: (s && s.arrived_at) || null,
    moving: Boolean(s && s.moving_since),
    // since when no parking position came (a vehicle that never reports one is never seen parked)
    noPositionSince: (s && s.moving_since) || null,
    parkedSeen: Boolean(s && s.lat != null),
  };
}

/** The vehicle is driving right now (a sync without a position since it was last seen parked). */
async function isMoving(gc, vin) {
  const s = await getSpot(gc, vin);
  return Boolean(s && s.moving_since);
}

// ─── Detection ──────────────────────────────────

/**
 * After a sync of one vehicle: record a trip when it parked again with a
 * higher mileage. → the new trip, or null. Never throws for a geocoder failure.
 * @param {{id:number, vin:string, name?:string, model?:string}} vehicle
 */
async function observe(gc, vehicle, state, now = Date.now()) {
  if (!vehicle || typeof vehicle.vin !== 'string' || !state) return null;
  const vin = vehicle.vin;
  const kmRaw = state.health && state.health.mileageKm;
  const km = typeof kmRaw === 'number' && Number.isFinite(kmRaw) && kmRaw >= 0 ? Math.round(kmRaw) : null;
  const pos = state.position && validCoord(state.position.lat, state.position.lon)
    ? { lat: state.position.lat, lon: state.position.lon, address: typeof state.position.address === 'string' && state.position.address ? state.position.address : null } : null;
  if (km == null) return null;
  const nowIso = iso(now);
  const spot = await getSpot(gc, vin);

  const captured = Date.parse(state.capturedAt || '');
  const capturedOk = Number.isFinite(captured) && captured <= now + 5 * 60000;

  if (!spot || spot.km == null || km < Number(spot.km)) {
    // first sight, or the mileage went down (another car with this VIN, a reset): start over here
    await setSpot(gc, vin, { km, lat: pos ? pos.lat : null, lon: pos ? pos.lon : null, address: null, seen_at: pos ? nowIso : null, moving_since: pos ? null : nowIso });
    return null;
  }
  if (!pos) {
    if (!spot.moving_since) await setSpot(gc, vin, { ...spot, moving_since: nowIso });
    return null;
  }
  const delta = km - Number(spot.km);
  const arrival = spot.arrived_at ? { lat: Number(spot.arrived_lat), lon: Number(spot.arrived_lon), at: spot.arrived_at } : null;
  if (delta < MIN_KM) {
    const far = spot.lat != null && distanceM({ lat: spot.lat, lon: spot.lon }, pos) > ARRIVED_M;
    const waitedOut = arrival && now - Date.parse(arrival.at) > ARRIVAL_WAIT_MS;
    if (far && !waitedOut) {
      // parked elsewhere, the higher mileage is not reported yet: keep the start, remember the arrival
      const same = arrival && distanceM(arrival, pos) <= MOVED_M;
      const lastSeen = Date.parse(spot.seen_at || spot.moving_since || '');
      const at = same ? arrival.at : iso(capturedOk && (!Number.isFinite(lastSeen) || captured > lastSeen) ? captured : now);
      await setSpot(gc, vin, { ...spot, moving_since: null, arrived_lat: pos.lat, arrived_lon: pos.lon, arrived_at: at });
      return null;
    }
    // still parked (or moved less than a kilometre): a new spot only when it is clearly elsewhere
    const moved = spot.lat == null || distanceM({ lat: spot.lat, lon: spot.lon }, pos) > MOVED_M;
    await setSpot(gc, vin, { km: Number(spot.km), lat: pos.lat, lon: pos.lon, address: pos.address || (moved ? null : spot.address), seen_at: nowIso, moving_since: null });
    return null;
  }

  // the higher mileage: the trip ends at the remembered arrival when the vehicle is still there
  const atArrival = arrival && distanceM(arrival, pos) <= MOVED_M;
  const lastSeen = Date.parse(spot.seen_at || spot.moving_since || '');
  let ended = atArrival ? Date.parse(arrival.at)
    : capturedOk && (!Number.isFinite(lastSeen) || captured > lastSeen) ? captured : now;
  let started = Number.isFinite(lastSeen) ? lastSeen : ended;
  if (started > ended) started = ended;
  ended = Math.max(ended, started);

  const startAddress = spot.address || (spot.lat != null ? await geocode.reverseGeocode(gc, Number(spot.lat), Number(spot.lon)).catch(() => null) : null);
  // Škoda's own address of the position first (the MySkoda app shows it), OpenStreetMap otherwise
  const endAddress = pos.address || await geocode.reverseGeocode(gc, pos.lat, pos.lon).catch(() => null);
  const owners = await store.ownerIdsOf(gc, vehicle.id).catch(() => []);
  const purpose = await defaultPurpose(gc);
  const r = await gc.db.run(`INSERT INTO trips (vin, started_at, ended_at, start_km, end_km, distance_km, start_lat, start_lon, start_address,
      end_lat, end_lon, end_address, purpose, driver_user_id, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto')`,
  [vin, iso(started), iso(ended), Number(spot.km), km, delta, spot.lat, spot.lon, startAddress, pos.lat, pos.lon, endAddress,
    purpose, owners.length === 1 ? owners[0] : null]);
  await setSpot(gc, vin, { km, lat: pos.lat, lon: pos.lon, address: endAddress, seen_at: nowIso, moving_since: null });
  const trip = await getTrip(gc, Number(r.lastInsertRowid));
  if (trip && !trip.purpose && owners.length) await notifyTrip(gc, vehicle, trip, owners).catch((e) => gc.log.warn('trip notification failed', e.code || e.message));
  return trip;
}

// ─── Changes ────────────────────────────────────

const cleanText = (v, max) => String(v == null ? '' : v).replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Change a trip: purpose ('private' | 'business' | 'commute' | null), note,
 * startAddress / endAddress (1.5.3: a wrong address corrected), driverUserId
 * (null = nobody). Only the given fields; marks it edited.
 */
async function updateTrip(gc, id, patch) {
  const trip = await getTrip(gc, id);
  if (!trip) throw fail('SKODA_TRIP_NOT_FOUND');
  const sets = [];
  const vals = [];
  if ('purpose' in patch) {
    if (patch.purpose !== null && !PURPOSES.includes(patch.purpose)) throw fail('SKODA_VALIDATION');
    sets.push('purpose = ?'); vals.push(patch.purpose);
  }
  if ('note' in patch) {
    if (patch.note !== null && typeof patch.note !== 'string') throw fail('SKODA_VALIDATION');
    sets.push('note = ?'); vals.push(cleanText(patch.note, NOTE_MAX) || null);
  }
  for (const [key, col] of [['startAddress', 'start_address'], ['endAddress', 'end_address']]) {
    if (!(key in patch)) continue;
    if (patch[key] !== null && typeof patch[key] !== 'string') throw fail('SKODA_VALIDATION');
    sets.push(`${col} = ?`); vals.push(cleanText(patch[key], ADDRESS_MAX) || null);
  }
  if ('driverUserId' in patch) {
    const d = patch.driverUserId;
    if (d !== null && !(Number.isSafeInteger(d) && d > 0)) throw fail('SKODA_VALIDATION');
    if (d !== null && !(await gc.users.list()).some((u) => u.id === d)) throw fail('SKODA_OWNER_UNKNOWN_USER');
    sets.push('driver_user_id = ?'); vals.push(d);
  }
  if (!sets.length) return trip;
  sets.push("updated_at = datetime('now')", "edited_at = datetime('now')");
  await gc.db.run(`UPDATE trips SET ${sets.join(', ')} WHERE id = ?`, [...vals, Number(id)]);
  return getTrip(gc, id);
}

/** A trip entered by hand (the vehicle had no connection, a trip before the logbook started). */
async function addManual(gc, vin, b) {
  const d = DATE_RE.exec(String(b.date || ''));
  const st = TIME_RE.exec(String(b.startTime || ''));
  const en = TIME_RE.exec(String(b.endTime || ''));
  const startKm = b.startKm;
  const endKm = b.endKm;
  if (!d || !st || !en || !Number.isSafeInteger(startKm) || !Number.isSafeInteger(endKm) || startKm < 0 || endKm <= startKm || endKm - startKm > 5000) throw fail('SKODA_VALIDATION');
  const y = Number(d[1]); const mo = Number(d[2]); const day = Number(d[3]);
  const check = new Date(Date.UTC(y, mo - 1, day));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== day) throw fail('SKODA_VALIDATION');
  const started = toUtc(y, mo, day, Number(st[1]), Number(st[2]));
  let ended = toUtc(y, mo, day, Number(en[1]), Number(en[2]));
  if (ended < started) ended += 86400000; // over midnight
  if (started > Date.now() + 86400000) throw fail('SKODA_VALIDATION');
  const purpose = b.purpose == null || b.purpose === '' ? null : b.purpose;
  if (purpose !== null && !PURPOSES.includes(purpose)) throw fail('SKODA_VALIDATION');
  const driver = b.driverUserId == null ? null : b.driverUserId;
  if (driver !== null && !(Number.isSafeInteger(driver) && (await gc.users.list()).some((u) => u.id === driver))) throw fail('SKODA_VALIDATION');
  const r = await gc.db.run(`INSERT INTO trips (vin, started_at, ended_at, start_km, end_km, distance_km, start_address, end_address, purpose, note, driver_user_id, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
  [vin, iso(started), iso(ended), startKm, endKm, endKm - startKm, cleanText(b.startAddress, ADDRESS_MAX) || null, cleanText(b.endAddress, ADDRESS_MAX) || null,
    purpose, cleanText(b.note, NOTE_MAX) || null, driver]);
  return getTrip(gc, Number(r.lastInsertRowid));
}

async function deleteTrip(gc, id) {
  if (!(await getTrip(gc, id))) throw fail('SKODA_TRIP_NOT_FOUND');
  await gc.db.run('DELETE FROM trips WHERE id = ?', [Number(id)]);
}

// ─── Views ──────────────────────────────────────

function tripView(tr, lang, users) {
  const s = Date.parse(tr.startedAt);
  const e = Date.parse(tr.endedAt);
  const p = parts(s);
  return {
    id: tr.id, date: `${p.y}-${pad(p.m)}-${pad(p.d)}`, dateLabel: fmtDate(s, lang), startTime: fmtTime(s), endTime: fmtTime(e),
    startKm: tr.startKm, endKm: tr.endKm, distanceKm: tr.distanceKm,
    startAddress: tr.startAddress, endAddress: tr.endAddress,
    purpose: tr.purpose, note: tr.note, source: tr.source, edited: Boolean(tr.editedAt),
    driver: tr.driverUserId != null && users.has(tr.driverUserId) ? users.get(tr.driverUserId) : null,
    driverUserId: tr.driverUserId,
  };
}

function purposeLabel(p, lang) { return p ? t(lang, 'logbook.purpose_' + p) : t(lang, 'logbook.purpose_open'); }

// ─── Exports ────────────────────────────────────

/** A CSV cell: quoted, a leading = + - @ neutralised (spreadsheet formulas). */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function exportRows(trips, lang, users) {
  return trips.map((tr) => {
    const v = tripView(tr, lang, users);
    return [v.dateLabel, v.startTime, v.endTime, v.startAddress || '', v.endAddress || '', v.startKm == null ? '' : v.startKm, v.endKm == null ? '' : v.endKm,
      v.distanceKm, purposeLabel(v.purpose, lang), v.note || '', v.driver ? v.driver.username : ''];
  });
}

function exportHeader(lang) {
  return ['date', 'start_time', 'end_time', 'from', 'to', 'km_start', 'km_end', 'distance', 'purpose', 'reason', 'driver'].map((k) => t(lang, 'logbook.col_' + k));
}

/** UTF-8 with BOM (Excel), ";" separated, CRLF. */
function toCsv(trips, lang, users) {
  const lines = [exportHeader(lang), ...exportRows(trips, lang, users)].map((r) => r.map(csvCell).join(';'));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function toPdf({ trips, lang, users, vehicle, from, to }) {
  const title = t(lang, 'logbook.pdf_title');
  const vname = [vehicle.name, vehicle.model && vehicle.model !== vehicle.name ? vehicle.model : null].filter(Boolean).join(' · ');
  const doc = new PdfDoc({ landscape: true, title: `${title} – ${vname}`, author: 'GateControl' });
  const M = 36;
  const cols = [
    { w: 54 }, { w: 64 }, { w: 140 }, { w: 140 }, { w: 50, right: true }, { w: 50, right: true }, { w: 34, right: true },
    { w: 62 }, { w: 112 }, { w: 64 },
  ];
  const head = exportHeader(lang);
  const header = [head[0], `${head[1]}–${head[2]}`, head[3], head[4], t(lang, 'logbook.pdf_km_start'), t(lang, 'logbook.pdf_km_end'), 'km', head[8], head[9], head[10]];
  const rows = exportRows(trips, lang, users).map((r) => [r[0], `${r[1]}–${r[2]}`, r[3], r[4], r[5] === '' ? '' : fmtKm(r[5], lang), r[6] === '' ? '' : fmtKm(r[6], lang), fmtKm(r[7], lang), r[8], r[9], r[10]]);
  const s = summary(trips);
  const SIZE = 7.5;
  const ROW = 13;
  const top = M + 52;
  const bottom = doc.h - M - 24;
  const perPage = Math.floor((bottom - top - ROW) / ROW);
  const pages = Math.max(1, Math.ceil((rows.length + 2) / perPage));
  const period = from === to ? monthName(from, lang) : `${monthName(from, lang)} – ${monthName(to, lang)}`;
  const created = `${fmtDate(Date.now(), lang)} ${fmtTime(Date.now())}`;
  let i = 0;
  for (let pg = 1; pg <= pages; pg++) {
    doc.page();
    doc.text(M, M + 14, `${title} – ${vname}`, { size: 14, bold: true });
    doc.text(M, M + 30, `${t(lang, 'logbook.pdf_vin')}: ${vehicle.vin} · ${t(lang, 'logbook.pdf_period')}: ${period}`, { size: 9, color: [0.35, 0.35, 0.35] });
    let y = top;
    doc.rect(M, y - 9, doc.w - 2 * M, ROW, [0.9, 0.92, 0.95]);
    let x = M;
    cols.forEach((c, k) => { doc.text(x + 2, y, doc.fit(header[k], c.w - 4, SIZE, true), { size: SIZE, bold: true, align: c.right ? 'right' : 'left', width: c.w - 4 }); x += c.w; });
    y += ROW;
    for (let n = 0; n < perPage && i < rows.length; n++, i++) {
      if (i % 2) doc.rect(M, y - 9, doc.w - 2 * M, ROW, [0.97, 0.97, 0.97]);
      x = M;
      cols.forEach((c, k) => { doc.text(x + 2, y, doc.fit(rows[i][k], c.w - 4, SIZE), { size: SIZE, align: c.right ? 'right' : 'left', width: c.w - 4 }); x += c.w; });
      y += ROW;
    }
    if (i >= rows.length && pg === pages) {
      y += 6;
      doc.line(M, y - 9, doc.w - M, y - 9, [0.7, 0.7, 0.7]);
      const line = [
        `${t(lang, 'logbook.sum_total')}: ${fmtKm(s.total, lang)} km (${s.count})`,
        `${t(lang, 'logbook.purpose_business')}: ${fmtKm(s.business, lang)} km`,
        `${t(lang, 'logbook.purpose_private')}: ${fmtKm(s.private, lang)} km`,
        `${t(lang, 'logbook.purpose_commute')}: ${fmtKm(s.commute, lang)} km`,
        `${t(lang, 'logbook.purpose_open')}: ${fmtKm(s.open, lang)} km`,
      ].join('   ·   ');
      doc.text(M, y + 4, line, { size: 9, bold: true });
    }
    doc.text(M, doc.h - M, t(lang, 'logbook.pdf_footer', { created }), { size: 7, color: [0.45, 0.45, 0.45] });
    doc.text(doc.w - M - 120, doc.h - M, t(lang, 'logbook.pdf_page', { n: pg, of: pages }), { size: 7, color: [0.45, 0.45, 0.45], align: 'right', width: 120 });
  }
  return doc.toBuffer();
}

/** File name part: letters, digits, - and _ only. */
function slug(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'vehicle'; }

/**
 * { name, type, encoding, data } of the export of `from`…`to` (months, inclusive).
 */
async function exportFile(gc, vehicle, { from, to, format, lang }) {
  const a = monthRange(from);
  const b = monthRange(to);
  if (!a || !b || a[0] > b[0] || monthsBetween(from, to) > EXPORT_MONTHS_MAX || !['csv', 'pdf'].includes(format)) throw fail('SKODA_VALIDATION');
  const trips = await listTrips(gc, vehicle.vin, a[0], b[1]);
  if (trips.length > EXPORT_ROWS_MAX) throw fail('SKODA_EXPORT_TOO_LARGE');
  const users = await usersMap(gc);
  const base = `${t(lang, 'logbook.file')}-${slug(vehicle.name || vehicle.model)}-${from === to ? from : `${from}_${to}`}`;
  if (format === 'csv') return { name: `${base}.csv`, type: 'text/csv', encoding: 'base64', data: Buffer.from(toCsv(trips, lang, users), 'utf8').toString('base64') };
  return { name: `${base}.pdf`, type: 'application/pdf', encoding: 'base64', data: toPdf({ trips, lang, users, vehicle, from, to }).toString('base64') };
}

async function usersMap(gc) {
  const m = new Map();
  try { for (const u of await gc.users.list()) m.set(u.id, { id: u.id, username: u.name }); } catch { /* users unavailable */ }
  return m;
}

// ─── Notification after a trip ──────────────────

let notifier = null;
function reset() { notifier = null; tzCache = null; fmtCache.clear(); }

async function notifyTrip(gc, vehicle, trip, owners) {
  const lang = (await gc.settings.get('notify_lang')) === 'en' ? 'en' : 'de';
  if (!notifier) notifier = notify.createNotifier(gc);
  const name = vehicle.name || vehicle.model || t(lang, 'portal.vehicle');
  const to = trip.endAddress ? ` → ${trip.endAddress.split(',')[0]}` : '';
  await notifier.send({
    topic: 'trip',
    title: t(lang, 'logbook.push_title', { name }),
    body: t(lang, 'logbook.push_body', { km: fmtKm(trip.distanceKm, lang), time: `${fmtTime(Date.parse(trip.startedAt))}–${fmtTime(Date.parse(trip.endedAt))}`, to }),
    priority: 'info',
    users: owners,
    collapseKey: `trip:${trip.id}`,
    data: {
      trip: { id: trip.id },
      actions: PURPOSES.map((p) => ({ type: 'callback', id: p, label: t(lang, 'logbook.purpose_' + p) })),
    },
  });
}

/** A button of that push was pressed: set the purpose (only an owner of the trip's vehicle). */
async function notifyAction(gc, { userId, action, data }) {
  if (!PURPOSES.includes(action) || !data || !data.trip || !Number.isSafeInteger(data.trip.id)) return;
  const trip = await getTrip(gc, data.trip.id);
  if (!trip) return;
  const v = (await store.listVehicles(gc)).find((x) => x.vin === trip.vin);
  if (!v || !(await store.isOwner(gc, v.id, userId))) return;
  await updateTrip(gc, trip.id, { purpose: action });
}

module.exports = {
  PURPOSES, MIN_KM, EXPORT_MONTHS_MAX, EXPORT_ROWS_MAX,
  t, serverTz, parts, toUtc, monthRange, currentMonth, fmtDate, fmtTime, fmtKm,
  observe, isMoving, detection, getTrip, listTrips, lastTrip, hasTrips, summary, updateTrip, addManual, deleteTrip,
  tripView, purposeLabel, toCsv, toPdf, exportFile, usersMap, notifyTrip, notifyAction, reset, csvCell,
};
