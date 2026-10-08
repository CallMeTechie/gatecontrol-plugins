'use strict';

// On-demand, read-only enrichment for the vehicle cards (port of GateControl's
// src/services/skoda/skodaDetails.js): model data, equipment, connection,
// driving score. Fetched lazily (on card expand), not part of the poll; under
// the account lock; concurrent expands share one round trip; 5 min cache.

const store = require('./store');
const service = require('./service');

const TTL_MS = 5 * 60 * 1000;
const cache = new Map();    // vehicleId -> { at, value?, errCode? }
const inflight = new Map(); // vehicleId -> Promise<full admin form>

function err(message, code) { return Object.assign(new Error(message), { code }); }
function maskVin(vin) { return vin && vin.length >= 4 ? '***' + vin.slice(-4) : null; }
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (Number.isFinite(Number(v)) && v !== null && v !== '' && typeof v !== 'boolean' ? Number(v) : null));
const text = (v) => (v == null || v === '' ? null : String(v).slice(0, 200));

// A single endpoint failure → null, account-level errors abort the whole call
async function tryPart(job) {
  try { return await job(); } catch (e) {
    if (e.code === 'SKODA_RATE_LIMITED' || e.code === 'SKODA_UNAUTHORIZED') throw e;
    return null;
  }
}

function normMeta(info, vin) {
  const spec = (info && info.vehicleSpecification) || null;
  if (!spec) return { model: null, title: null, modelYear: null, manufacturingDate: null, body: null, trimLevel: null, powerKw: null, batteryKwh: null, maxChargingKw: null, vin: vin || null };
  return {
    model: text(spec.model),
    title: text(spec.title),
    modelYear: text(spec.modelYear),
    manufacturingDate: text(spec.manufacturingDate),
    body: text(spec.body),
    trimLevel: text(spec.trimLevel),
    powerKw: num(spec.engine && spec.engine.powerInKW),
    batteryKwh: num(spec.battery && spec.battery.capacityInKWh),
    maxChargingKw: num(spec.maxChargingPowerInKW),
    vin: vin || null,
  };
}

function normEquipment(equip) {
  const list = equip && Array.isArray(equip.equipment) ? equip.equipment : [];
  return list.map((e) => e && e.name).filter(Boolean).map((s) => String(s).slice(0, 100)).slice(0, 40);
}

function normConnection(conn) {
  if (!conn) return null;
  return {
    online: conn.unreachable != null ? !conn.unreachable : null,
    ignitionOn: conn.ignitionOn != null ? !!conn.ignitionOn : null,
    inMotion: conn.inMotion != null ? !!conn.inMotion : null,
  };
}

function normScore(score) {
  if (!score) return null;
  const pick = (p) => (p && p.main != null ? num(p.main) : null);
  const weekly = pick(score.weeklyScore), monthly = pick(score.monthlyScore);
  if (weekly == null && monthly == null) return null;
  return { weekly, monthly, lastCalculationDate: text(score.lastCalculationDate) };
}

// Always fetch/cache the full ADMIN form (full VIN); callers get the portal form via serve().
async function fetchDetails(gc, vehicleId) {
  const v = await store.getVehicle(gc, vehicleId);
  if (!v || !v.vin) throw err('vehicle not found', 'SKODA_VEHICLE_NOT_FOUND');
  if (!(await store.getSession(gc, v.account_id))) throw err('account has no active session — re-sync/re-login required', 'SKODA_NO_SESSION');
  return service.withAccountLock(v.account_id, async () => {
    const c = service.clientFor(gc, v.account_id);
    const info = await tryPart(() => c.vehicleInformation(v.vin));
    const equip = await tryPart(() => c.equipment(v.vin));
    const conn = await tryPart(() => c.connectionStatus(v.vin));
    const score = await tryPart(() => c.drivingScore(v.vin));
    return { meta: normMeta(info, v.vin), equipment: normEquipment(equip), connection: normConnection(conn), drivingScore: normScore(score) };
  });
}

/** Portal form: masked VIN. A clone — never a live cache reference. */
function redactForPortal(full) {
  if (!full) return full;
  const meta = full.meta ? { ...full.meta, vin: maskVin(full.meta.vin) } : null;
  return { ...full, meta, equipment: Array.isArray(full.equipment) ? full.equipment.slice() : [] };
}

function serve(full, forAdmin) { return forAdmin ? JSON.parse(JSON.stringify(full)) : redactForPortal(full); }

async function getDetails(gc, vehicleId, { forAdmin = false } = {}) {
  const hit = cache.get(vehicleId);
  if (hit && Date.now() - hit.at < TTL_MS) {
    if (hit.errCode) throw err('rate limited', hit.errCode);
    return serve(hit.value, forAdmin);
  }
  if (inflight.has(vehicleId)) return serve(await inflight.get(vehicleId), forAdmin);
  const p = fetchDetails(gc, vehicleId)
    .then((value) => { cache.set(vehicleId, { at: Date.now(), value }); return value; })
    .catch((e) => {
      if (e.code === 'SKODA_RATE_LIMITED') cache.set(vehicleId, { at: Date.now(), errCode: e.code });
      throw e;
    })
    .finally(() => { inflight.delete(vehicleId); });
  inflight.set(vehicleId, p);
  return serve(await p, forAdmin);
}

function reset() { cache.clear(); inflight.clear(); }

module.exports = { getDetails, maskVin, reset };
