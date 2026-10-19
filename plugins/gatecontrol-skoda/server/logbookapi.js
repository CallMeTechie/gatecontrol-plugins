'use strict';

// The logbook's API (1.5.0) — the admin page "Fahrtenbuch" (every vehicle)
// and the portal section "Fahrtenbuch" (the viewer's own vehicles):
//
//   GET    logbook?vehicle=<id>&month=YYYY-MM     trips of that month, sums, vehicles
//   PUT    logbook/trips/<id>                     { purpose?, note?, driverUserId? (admin) }
//   POST   logbook/trips                          a trip entered by hand (admin)
//   DELETE logbook/trips/<id>                     (admin)
//   GET    logbook/export?vehicle=&from=YYYY-MM&to=YYYY-MM&format=csv|pdf
//          → { file: { name, type, encoding: 'base64', data } } (the frame saves it with GC.saveFile)
//
// In the portal the same under portal/logbook…, only for the viewer's own
// vehicles; changes only after a real login (user.loggedIn).

const store = require('./store');
const logbook = require('./logbook');

function fail(code) { return Object.assign(new Error(code), { code }); }

const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** The vehicles this viewer may see in the logbook (admin: all). */
async function vehiclesFor(gc, user, admin) {
  const all = await store.listVehicles(gc);
  if (admin) return all;
  const own = new Set(await store.vehiclesOwnedBy(gc, user.id));
  return all.filter((v) => own.has(v.id));
}

const vehicleView = (v) => ({ id: v.id, name: v.name || null, model: v.model || null, vin: v.vin });

async function tripAllowed(gc, trip, vehicles) {
  return trip && vehicles.some((v) => v.vin === trip.vin);
}

/**
 * @param {string[]} seg  the path after "logbook" (portal: after "portal/logbook")
 * @param {{admin:boolean}} opts
 */
async function route(req, gc, seg, { admin }) {
  const m = req.method;
  const user = req.user;
  const lang = req.lang;
  const q = req.query || {};
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const vehicles = await vehiclesFor(gc, user, admin);
  const canEdit = admin || user.loggedIn === true;

  if (!seg.length && m === 'GET') {
    const month = q.month == null || q.month === '' ? logbook.currentMonth() : String(q.month);
    const range = logbook.monthRange(month);
    if (!range) throw fail('SKODA_VALIDATION');
    const wanted = q.vehicle == null || q.vehicle === '' ? null : posInt(q.vehicle);
    if (q.vehicle != null && q.vehicle !== '' && !wanted) throw fail('SKODA_VALIDATION');
    const v = wanted ? vehicles.find((x) => x.id === wanted) : vehicles[0];
    if (wanted && !v) throw fail(admin ? 'SKODA_VEHICLE_NOT_FOUND' : 'SKODA_NOT_OWNER');
    const users = await logbook.usersMap(gc);
    const trips = v ? await logbook.listTrips(gc, v.vin, range[0], range[1], logbook.EXPORT_ROWS_MAX) : [];
    return { json: {
      ok: true, month, currentMonth: logbook.currentMonth(), vehicles: vehicles.map(vehicleView), vehicleId: v ? v.id : null,
      trips: trips.map((tr) => logbook.tripView(tr, lang, users)).reverse(), // newest first on screen
      summary: logbook.summary(trips), moving: v ? await logbook.isMoving(gc, v.vin) : false,
      canEdit, admin, users: admin ? [...users.values()] : [],
    } };
  }

  if (seg[0] === 'export' && seg.length === 1 && m === 'GET') {
    const v = vehicles.find((x) => x.id === posInt(q.vehicle));
    if (!v) throw fail(admin ? 'SKODA_VEHICLE_NOT_FOUND' : 'SKODA_NOT_OWNER');
    const from = String(q.from || '');
    const to = String(q.to || from);
    const file = await logbook.exportFile(gc, v, { from, to, format: String(q.format || ''), lang });
    return { json: { ok: true, file } };
  }

  if (seg[0] !== 'trips') throw fail('NOT_FOUND');

  if (seg.length === 1 && m === 'POST') {
    if (!admin) throw fail('FORBIDDEN');
    const v = vehicles.find((x) => x.id === posInt(body.vehicleId));
    if (!v) throw fail('SKODA_VEHICLE_NOT_FOUND');
    const trip = await logbook.addManual(gc, v.vin, body);
    return { status: 201, json: { ok: true, trip: logbook.tripView(trip, lang, await logbook.usersMap(gc)) } };
  }

  const id = posInt(seg[1]);
  if (!id || seg.length !== 2) throw fail('NOT_FOUND');
  const trip = await logbook.getTrip(gc, id);
  if (!(await tripAllowed(gc, trip, vehicles))) throw fail('SKODA_TRIP_NOT_FOUND');

  if (m === 'PUT') {
    if (!canEdit) throw fail('LOGIN_REQUIRED');
    const patch = {};
    if ('purpose' in body) patch.purpose = body.purpose === '' ? null : body.purpose;
    if ('note' in body) patch.note = body.note;
    if (admin && 'driverUserId' in body) patch.driverUserId = body.driverUserId;
    const out = await logbook.updateTrip(gc, id, patch);
    return { json: { ok: true, trip: logbook.tripView(out, lang, await logbook.usersMap(gc)) } };
  }
  if (m === 'DELETE') {
    if (!admin) throw fail('FORBIDDEN');
    await logbook.deleteTrip(gc, id);
    return { json: { ok: true } };
  }
  throw fail('NOT_FOUND');
}

module.exports = { route, vehiclesFor };
