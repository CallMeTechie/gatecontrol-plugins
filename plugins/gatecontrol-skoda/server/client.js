'use strict';

// MySkoda API client (port of GateControl's src/services/skoda/skodaClient.js).
// Requests go through the host (fetchImpl = http.fetchFor(gc)); a 401 is
// answered with one token refresh, then the request is repeated.

const skodaAuth = require('./auth');
const { API_BASE } = skodaAuth;

class SkodaApiError extends Error {
  constructor(message, code, status) { super(message); this.name = 'SkodaApiError'; this.code = code; this.status = status; }
}

// Hosts serving compositeRenders images — the rule of the built-in
// integration (live-confirmed there): exactly iprenders.blob.core.windows.net,
// or any host under azureedge.net / skoda-auto.cz (the Škoda CDN hosts vary).
// Matches plugin.json permissions.network.internet (iprenders…:443,
// *.azureedge.net:443, *.skoda-auto.cz:443): a render URL on another host is
// skipped (no image) instead of widening the plugin's network permissions.
function renderHostAllowed(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'iprenders.blob.core.windows.net' || h.endsWith('.azureedge.net') || h.endsWith('.skoda-auto.cz');
}

/** Image type by its first bytes (PNG, JPEG, WebP) or null. */
function imageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

class SkodaClient {
  constructor({ getSession, saveSession, fetchImpl }) {
    this.getSession = getSession;
    this.saveSession = saveSession;
    this.fetchImpl = fetchImpl;
  }

  async _request(method, path, body, { retried = false } = {}) {
    const session = await this.getSession();
    if (!session || !session.accessToken) throw new SkodaApiError('no session', 'SKODA_UNAUTHORIZED', 401);
    const opts = { method, headers: { authorization: `Bearer ${session.accessToken}`, accept: 'application/json' } };
    if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await this.fetchImpl(`${API_BASE}${path}`, opts);
    if (res.status === 401 && !retried) {
      let tokens;
      try {
        tokens = await skodaAuth.refresh(session.refreshToken, { fetchImpl: this.fetchImpl });
      } catch (e) {
        if (e.code === 'SKODA_RATE_LIMITED') throw e; // account-level, abort as-is
        throw new SkodaApiError('token refresh failed', 'SKODA_UNAUTHORIZED', 401);
      }
      await this.saveSession(tokens);
      return this._request(method, path, body, { retried: true });
    }
    if (res.status === 401) throw new SkodaApiError('unauthorized', 'SKODA_UNAUTHORIZED', 401);
    if (res.status === 429) throw new SkodaApiError('rate limited', 'SKODA_RATE_LIMITED', 429);
    if (res.status >= 400) throw new SkodaApiError(`api error ${res.status} for ${path}`, 'SKODA_API_ERROR', res.status);
    return res;
  }

  async _get(path) {
    return (await this._request('GET', path)).json();
  }

  garage() { return this._get('/api/v2/garage?connectivityGenerations=MOD1&connectivityGenerations=MOD2&connectivityGenerations=MOD3&connectivityGenerations=MOD4'); }
  vehicleInfo(vin) { return this._get(`/api/v2/garage/vehicles/${encodeURIComponent(vin)}`); }
  vehicleStatus(vin) { return this._get(`/api/v2/vehicle-status/${encodeURIComponent(vin)}`); }
  drivingRange(vin) { return this._get(`/api/v2/vehicle-status/${encodeURIComponent(vin)}/driving-range`); }
  charging(vin) { return this._get(`/api/v1/charging/${encodeURIComponent(vin)}`); }
  airConditioning(vin) { return this._get(`/api/v2/air-conditioning/${encodeURIComponent(vin)}`); }
  position(vin) { return this._get(`/api/v1/maps/positions?vin=${encodeURIComponent(vin)}`); }
  health(vin) { return this._get(`/api/v1/vehicle-health-report/warning-lights/${encodeURIComponent(vin)}`); }
  maintenance(vin) { return this._get(`/api/v3/vehicle-maintenance/vehicles/${encodeURIComponent(vin)}`); }

  // Read-only enrichment, live-verified in the built-in integration.
  // software-version/update-status, charging/history and trip-statistics
  // returned 500/403 there — deliberately not wired up.
  vehicleInformation(vin) { return this._get(`/api/v1/vehicle-information/${encodeURIComponent(vin)}`); }
  equipment(vin) { return this._get(`/api/v1/vehicle-information/${encodeURIComponent(vin)}/equipment`); }
  connectionStatus(vin) { return this._get(`/api/v2/connection-status/${encodeURIComponent(vin)}/readiness`); }
  drivingScore(vin) { return this._get(`/api/v2/vehicle-status/${encodeURIComponent(vin)}/driving-score`); }

  /** The vehicle render: { bytes: Buffer, type } — public blob, never with the bearer token. */
  async renderImage(url) {
    // The url comes from the Skoda API response — never fetch it unvalidated,
    // and never send the access token to a CDN (token leak).
    let parsed;
    try { parsed = new URL(url); } catch { throw new SkodaApiError('invalid render url', 'SKODA_API_ERROR', 0); }
    if (parsed.protocol !== 'https:' || parsed.port !== '' || !renderHostAllowed(parsed.hostname)) {
      throw new SkodaApiError(`render url host not allowed: ${parsed.hostname}`, 'SKODA_RENDER_HOST', 0);
    }
    const res = await this.fetchImpl(parsed.toString(), { binary: true });
    if (res.status >= 400) throw new SkodaApiError(`image fetch failed ${res.status}`, 'SKODA_API_ERROR', res.status);
    const bytes = Buffer.from(await res.arrayBuffer());
    const type = imageType(bytes);
    if (!type) throw new SkodaApiError('render is not an image', 'SKODA_API_ERROR', 0);
    return { bytes, type };
  }

  async fetchFullState(vin) {
    const parts = {};
    const jobs = {
      status: () => this.vehicleStatus(vin),
      drivingRange: () => this.drivingRange(vin),
      charging: () => this.charging(vin),
      airConditioning: () => this.airConditioning(vin),
      position: () => this.position(vin),
      health: () => this.health(vin),
      maintenance: () => this.maintenance(vin),
    };
    for (const [key, job] of Object.entries(jobs)) {
      try { parts[key] = await job(); } catch (e) {
        if (e.code === 'SKODA_RATE_LIMITED' || e.code === 'SKODA_UNAUTHORIZED') throw e; // account-level, abort
        parts[key] = null;
      }
    }
    return { parts, state: normalizeVehicleState(parts) };
  }

  startAc(vin, temp) {
    return this._request('POST', `/api/v2/air-conditioning/${encodeURIComponent(vin)}/start`,
      { heaterSource: 'ELECTRIC', targetTemperature: { temperatureValue: Math.round(temp * 2) / 2, unitInCar: 'CELSIUS' } });
  }
  stopAc(vin) { return this._request('POST', `/api/v2/air-conditioning/${encodeURIComponent(vin)}/stop`); }
  setAcTemp(vin, temp) {
    return this._request('POST', `/api/v2/air-conditioning/${encodeURIComponent(vin)}/settings/target-temperature`,
      { temperatureValue: Math.round(temp * 2) / 2, unitInCar: 'CELSIUS' });
  }
  startWindowHeating(vin) { return this._request('POST', `/api/v2/air-conditioning/${encodeURIComponent(vin)}/start-window-heating`); }
  stopWindowHeating(vin) { return this._request('POST', `/api/v2/air-conditioning/${encodeURIComponent(vin)}/stop-window-heating`); }
  startCharging(vin) { return this._request('POST', `/api/v1/charging/${encodeURIComponent(vin)}/start`); }
  stopCharging(vin) { return this._request('POST', `/api/v1/charging/${encodeURIComponent(vin)}/stop`); }
  setChargeLimit(vin, pct) { return this._request('PUT', `/api/v1/charging/${encodeURIComponent(vin)}/set-charge-limit`, { targetSOCInPercent: pct }); }
  lock(vin, spin) { return this._request('POST', `/api/v1/vehicle-access/${encodeURIComponent(vin)}/lock`, { currentSpin: spin }); }
  unlock(vin, spin) { return this._request('POST', `/api/v1/vehicle-access/${encodeURIComponent(vin)}/unlock`, { currentSpin: spin }); }
  // Departure timers (MEB: climate timers). A single slot written leaves the
  // others untouched (live-verified in the built-in integration); write form
  // of python-myskoda set_ac_timer. The departure/timers endpoint of
  // vehicle-automatization answers 500 for these cars — not used.
  setAcTimer(vin, timer) { return this._request('POST', `/api/v2/air-conditioning/${encodeURIComponent(vin)}/timers`, { timers: [timer] }); }
}

const YES = (v) => (v == null ? null : String(v).toUpperCase() === 'YES');
const OPEN = (v) => (v == null ? null : String(v).toUpperCase() === 'OPEN');
const ON = (v) => (v == null ? null : String(v).toUpperCase() === 'ON');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function normalizeVehicleState({ status, drivingRange, charging, airConditioning, position, health, maintenance }) {
  const chStatus = charging && charging.status;
  const per = drivingRange && drivingRange.primaryEngineRange;
  const pos = position && Array.isArray(position.positions)
    ? position.positions.find((p) => p && p.type === 'VEHICLE') : null;
  const windowHeating = airConditioning && airConditioning.windowHeatingState;
  return {
    capturedAt: (status && status.carCapturedTimestamp) || (health && health.capturedAt) || null,
    locked: status ? YES(status.overall && status.overall.locked) : null,
    doorsOpen: status ? OPEN(status.overall && status.overall.doors) : null,
    windowsOpen: status ? OPEN(status.overall && status.overall.windows) : null,
    detail: {
      bonnet: (status && status.detail && status.detail.bonnet) || null,
      trunk: (status && status.detail && status.detail.trunk) || null,
      sunroof: (status && status.detail && status.detail.sunroof) || null,
    },
    lightsOn: status ? ON(status.overall && status.overall.lights) : null,
    soc: per ? num(per.currentSoCInPercent)
      : (chStatus && chStatus.battery ? num(chStatus.battery.stateOfChargeInPercent) : null),
    rangeKm: drivingRange ? num(drivingRange.totalRangeInKm) : null,
    charging: {
      state: (chStatus && chStatus.state) || null,
      powerKw: chStatus ? num(chStatus.chargePowerInKw) : null,
      remainingMin: chStatus ? num(chStatus.remainingTimeToFullyChargedInMinutes) : null,
      targetPercent: charging && charging.settings ? num(charging.settings.targetStateOfChargeInPercent) : null,
      mode: (charging && charging.settings && charging.settings.chargingCareMode) || null,
      cableConnected: charging && charging.plug && charging.plug.connectionState != null
        ? String(charging.plug.connectionState).toUpperCase() === 'CONNECTED' : null,
    },
    climate: {
      state: (airConditioning && airConditioning.state) || null,
      targetC: airConditioning && airConditioning.targetTemperature ? num(airConditioning.targetTemperature.temperatureValue) : null,
      remainingMin: (() => {
        if (!airConditioning) return null;
        const direct = num(airConditioning.remainingTimeToReachTargetTemperatureInMinutes);
        if (direct != null) return direct;
        const ts = Date.parse(airConditioning.estimatedDateTimeToReachTargetTemperature || '');
        return Number.isFinite(ts) ? Math.max(0, Math.round((ts - Date.now()) / 60000)) : null;
      })(),
      windowHeating: windowHeating ? (ON(windowHeating.front) || ON(windowHeating.rear)) : null,
      // departure timers come with every sync in the air-conditioning payload
      timers: (Array.isArray(airConditioning && airConditioning.timers) ? airConditioning.timers : [])
        .map((t) => ({
          id: num(t && t.id),
          enabled: t && t.enabled != null ? !!t.enabled : null,
          time: t && typeof t.time === 'string' ? t.time : null,
          type: (t && t.type) || null,
          days: Array.isArray(t && t.selectedDays) ? t.selectedDays.map(String) : [],
        }))
        .filter((t) => t.id != null),
    },
    position: pos && pos.gpsCoordinates
      ? { lat: num(pos.gpsCoordinates.latitude), lon: num(pos.gpsCoordinates.longitude) } : null,
    health: {
      mileageKm: health ? num(health.mileageInKm) : null,
      warnings: (health && Array.isArray(health.warningLights) ? health.warningLights : [])
        .map((w) => (typeof w === 'string' ? w : (w && (w.category || w.type)) || 'UNKNOWN')),
    },
    maintenance: {
      dueInDays: maintenance && maintenance.maintenanceReport ? num(maintenance.maintenanceReport.inspectionDueInDays) : null,
      dueInKm: maintenance && maintenance.maintenanceReport ? num(maintenance.maintenanceReport.inspectionDueInKm) : null,
      partner: (maintenance && maintenance.preferredServicePartner && maintenance.preferredServicePartner.name) || null,
    },
  };
}

module.exports = { SkodaClient, SkodaApiError, normalizeVehicleState, imageType, renderHostAllowed };
