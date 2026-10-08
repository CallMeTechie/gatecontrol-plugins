'use strict';

// The portal view of the vehicles (port of GateControl's skodaPortal.js):
// owner-scoped and redacted. Read-only — the state comes from the plugin's
// database, which the poll writes; no cloud calls except the (cached)
// address lookup. Drops account and VIN; position (with address) and the
// departure timers only for a signed-in viewer (user.loggedIn), never for a
// viewer recognised by device trust alone.

const store = require('./store');
const geocode = require('./geocode');

function pick(obj, keys) {
  const out = {};
  if (obj && typeof obj === 'object') for (const k of keys) out[k] = obj[k] === undefined ? null : obj[k];
  return out;
}

async function redactState(gc, s, loggedIn) {
  if (!s) return null;
  let position = null;
  if (loggedIn && s.position && typeof s.position.lat === 'number' && typeof s.position.lon === 'number') {
    const address = await geocode.reverseGeocode(gc, s.position.lat, s.position.lon);
    position = { lat: s.position.lat, lon: s.position.lon, address };
  }
  // Explicit allowlist down to the leaf fields (not a spread): a field added
  // to the state later must never reach the portal unchecked.
  const h = s.health || {};
  return {
    capturedAt: s.capturedAt == null ? null : s.capturedAt,
    locked: s.locked == null ? null : s.locked,
    doorsOpen: s.doorsOpen == null ? null : s.doorsOpen,
    windowsOpen: s.windowsOpen == null ? null : s.windowsOpen,
    detail: pick(s.detail, ['bonnet', 'trunk', 'sunroof']),
    lightsOn: s.lightsOn == null ? null : s.lightsOn,
    soc: s.soc == null ? null : s.soc,
    rangeKm: s.rangeKm == null ? null : s.rangeKm,
    charging: pick(s.charging, ['state', 'powerKw', 'remainingMin', 'targetPercent', 'mode', 'cableConnected']),
    // departure times are a presence profile: same class as the position
    climate: {
      ...pick(s.climate, ['state', 'targetC', 'remainingMin', 'windowHeating']),
      timers: loggedIn && s.climate && Array.isArray(s.climate.timers)
        ? s.climate.timers.map((t) => pick(t, ['id', 'enabled', 'time', 'type', 'days']))
        : [],
    },
    position,
    health: { mileageKm: h.mileageKm == null ? null : h.mileageKm, warnings: Array.isArray(h.warnings) ? h.warnings.map(String) : [] },
    maintenance: pick(s.maintenance, ['dueInDays', 'dueInKm', 'partner']),
  };
}

/** The viewer's own vehicles for the portal; addresses resolved in parallel. */
async function vehiclesFor(gc, userId, { loggedIn = false, withState = true } = {}) {
  if (userId == null) return [];
  const owned = new Set(await store.vehiclesOwnedBy(gc, userId));
  if (!owned.size) return [];
  const list = (await store.listVehicles(gc)).filter((v) => owned.has(v.id));
  return Promise.all(list.map(async (v) => ({
    id: v.id, name: v.name, model: v.model, fetched_at: v.fetched_at, has_image: v.has_image,
    state: withState ? await redactState(gc, v.state, loggedIn) : null,
  })));
}

module.exports = { vehiclesFor, redactState };
