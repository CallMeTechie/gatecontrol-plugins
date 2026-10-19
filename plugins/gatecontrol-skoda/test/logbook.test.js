'use strict';

// The logbook (Fahrtenbuch, 1.5.0): trips detected from mileage and parking
// position, the push with Privat / Geschäftlich / Arbeitsweg, the API of the
// admin page and the portal (owner scope, sign-in for changes), the quick
// action with its widget, the export as CSV and PDF, the PDF writer.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const H = require('./helpers');
const { fakeSkoda, withHost, connected, fx, ADMIN, ADA, BOB } = H;
const { PdfDoc, encode } = require('../server/pdf');
const logbook = require('../server/logbook');

const GC = '1.186.0';

/** A request as the host makes it: path and query string split. */
function req(host, user, method, p, body) {
  const [path, qs] = String(p).split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  return host.request({ method, path, query, body: body === undefined ? null : body, user });
}
const asAdmin = (host, method, p, body) => req(host, ADMIN, method, p, body);
const asPortal = (host, user, method, p, body, loggedIn = true) => req(host, { ...user, portal: true, loggedIn }, method, p, body);
const MONTH = logbook.currentMonth();

/** Run fn with fx.positions / fx.health changed, restored afterwards. */
async function withState({ lat, lon, km, moving = false, captured }, fn) {
  const saved = { positions: fx.positions, health: fx.health, status: fx.status };
  fx.positions = moving ? { positions: [], errors: [{ type: 'VEHICLE_IN_MOTION' }] }
    : { positions: [{ type: 'VEHICLE', gpsCoordinates: { latitude: lat, longitude: lon } }], errors: [] };
  fx.health = { ...fx.health, mileageInKm: km };
  if (captured) fx.status = { ...fx.status, carCapturedTimestamp: captured };
  try { return await fn(); } finally { Object.assign(fx, saved); }
}

const sync = (host, accountId) => asAdmin(host, 'POST', `/accounts/${accountId}/sync`);

/** Connect, give the vehicle to Ada, drive 22 km (parked → moving → parked elsewhere). */
async function oneTrip(host, cloud, { owners = [ADA.id] } = {}) {
  const ids = await connected(host, cloud); // parked at 51.0/7.0 with 5210 km
  await asAdmin(host, 'PUT', `/vehicles/${ids.vehicleId}/owners`, { user_ids: owners });
  await withState({ moving: true, km: 5215 }, () => sync(host, ids.accountId));
  await withState({ lat: 51.1, lon: 7.1, km: 5232 }, () => sync(host, ids.accountId));
  return ids;
}

test('a trip: from the last parking spot to the new one, the mileage difference, addresses; moving shows as such', () => {
  const cloud = fakeSkoda();
  return withHost({ cloud, gatecontrol: GC }, async (host) => {
    const ids = await connected(host, cloud);
    await asAdmin(host, 'PUT', `/vehicles/${ids.vehicleId}/owners`, { user_ids: [ADA.id] });
    let r = await asAdmin(host, 'GET', '/logbook');
    assert.deepEqual([r.json.trips.length, r.json.moving, r.json.vehicleId, r.json.month], [0, false, ids.vehicleId, MONTH]);
    // parked again at the same spot with the same mileage: nothing
    await sync(host, ids.accountId);
    await withState({ moving: true, km: 5215 }, () => sync(host, ids.accountId));
    r = await asAdmin(host, 'GET', '/logbook');
    assert.equal(r.json.moving, true);
    await withState({ lat: 51.1, lon: 7.1, km: 5232 }, () => sync(host, ids.accountId));
    r = await asAdmin(host, 'GET', '/logbook');
    assert.equal(r.json.moving, false);
    assert.equal(r.json.trips.length, 1);
    const tr = r.json.trips[0];
    assert.deepEqual([tr.startKm, tr.endKm, tr.distanceKm, tr.purpose, tr.source, tr.driver && tr.driver.id], [5210, 5232, 22, null, 'auto', ADA.id]);
    assert.equal(tr.startAddress, 'Hauptstraße 5, 50667 Köln');
    assert.match(tr.startTime, /^\d\d:\d\d$/);
    assert.deepEqual(r.json.summary, { count: 1, total: 22, private: 0, business: 0, commute: 0, open: 22, openCount: 1 });
    // a lower mileage (another car, a reset) starts over without a trip; less than 1 km neither
    await withState({ lat: 51.2, lon: 7.2, km: 100 }, () => sync(host, ids.accountId));
    await withState({ lat: 51.21, lon: 7.21, km: 100 }, () => sync(host, ids.accountId));
    assert.equal((await asAdmin(host, 'GET', '/logbook')).json.trips.length, 1);
  });
});

test('the push after a trip: Privat / Geschäftlich / Arbeitsweg to the owners; a button sets the purpose (owners only)', () => {
  const cloud = fakeSkoda();
  return withHost({ cloud, gatecontrol: GC }, async (host) => {
    await oneTrip(host, cloud);
    const push = host.notifications.find((n) => n.topic === 'trip');
    assert.ok(push, JSON.stringify(host.notifications));
    assert.deepEqual(push.users, [ADA.id]);
    assert.match(push.title, /Elroq: Fahrt erfasst/);
    assert.match(push.body, /^22 km, \d\d:\d\d–\d\d:\d\d → Hauptstraße 5 – privat oder geschäftlich\?$/);
    assert.deepEqual(push.data.actions.map((a) => [a.type, a.id, a.label]), [['callback', 'private', 'Privat'], ['callback', 'business', 'Geschäftlich'], ['callback', 'commute', 'Arbeitsweg']]);
    const tripId = push.data.trip.id;
    await host.notifyAction({ userId: BOB.id, action: 'business', data: { trip: { id: tripId } } });
    assert.equal((await logbook.getTrip(host.gc, tripId)).purpose, null, 'not Bob\'s vehicle');
    await host.notifyAction({ userId: ADA.id, action: 'nonsense', data: { trip: { id: tripId } } });
    await host.notifyAction({ userId: ADA.id, action: 'business', data: { trip: { id: tripId } } });
    assert.equal((await logbook.getTrip(host.gc, tripId)).purpose, 'business');
  });
});

test('a default purpose (setting): new trips get it and nobody is asked', () => {
  const cloud = fakeSkoda();
  return withHost({ cloud, gatecontrol: GC, settings: { logbook_default: 'business' } }, async (host) => {
    await oneTrip(host, cloud);
    assert.equal(host.notifications.filter((n) => n.topic === 'trip').length, 0);
    assert.equal((await asAdmin(host, 'GET', '/logbook')).json.trips[0].purpose, 'business');
  });
});

test('admin API: purpose, note, driver, a trip by hand, delete; invalid input refused', () => {
  const cloud = fakeSkoda();
  return withHost({ cloud, gatecontrol: GC }, async (host) => {
    const { vehicleId } = await oneTrip(host, cloud);
    const id = (await asAdmin(host, 'GET', '/logbook')).json.trips[0].id;
    let r = await asAdmin(host, 'PUT', `/logbook/trips/${id}`, { purpose: 'business', note: '  Kunde\nMüller GmbH ', driverUserId: BOB.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.trip.purpose, r.json.trip.note, r.json.trip.driver.id, r.json.trip.edited], ['business', 'Kunde Müller GmbH', BOB.id, true]);
    for (const bad of [{ purpose: 'holiday' }, { driverUserId: 999 }, { driverUserId: 'x' }, { note: 5 }]) {
      assert.notEqual((await asAdmin(host, 'PUT', `/logbook/trips/${id}`, bad)).status, 200, JSON.stringify(bad));
    }
    assert.equal((await asAdmin(host, 'PUT', '/logbook/trips/999', { purpose: 'private' })).json.code, 'SKODA_TRIP_NOT_FOUND');
    const day = `${MONTH}-01`;
    r = await asAdmin(host, 'POST', '/logbook/trips', { vehicleId, date: day, startTime: '08:00', endTime: '08:40', startKm: 5100, endKm: 5140, startAddress: 'Büro', endAddress: 'Kunde', purpose: 'business', note: 'Termin' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.deepEqual([r.json.trip.distanceKm, r.json.trip.source, r.json.trip.startTime, r.json.trip.endTime], [40, 'manual', '08:00', '08:40']);
    for (const bad of [{ endKm: 5000 }, { date: '2026-02-30' }, { startTime: '25:00' }, { purpose: 'x' }, { endKm: 99999 }]) {
      const b = { vehicleId, date: day, startTime: '08:00', endTime: '08:40', startKm: 5100, endKm: 5140, ...bad };
      assert.equal((await asAdmin(host, 'POST', '/logbook/trips', b)).status, 400, JSON.stringify(bad));
    }
    const list = (await asAdmin(host, 'GET', `/logbook?vehicle=${vehicleId}&month=${MONTH}`)).json;
    assert.equal(list.trips.length, 2);
    assert.deepEqual([list.summary.business, list.summary.total], [62, 62]);
    assert.ok(list.users.some((u) => u.id === BOB.id), 'the admin page gets the users for the driver');
    assert.equal((await asAdmin(host, 'DELETE', `/logbook/trips/${r.json.trip.id}`)).status, 200);
    assert.equal((await asAdmin(host, 'GET', '/logbook')).json.trips.length, 1);
    assert.equal((await asAdmin(host, 'GET', '/logbook?month=2026-13')).status, 400);
  });
});

test('portal: the owner sees and classifies their own trips (signed in), others see nothing', () => {
  const cloud = fakeSkoda();
  return withHost({ cloud, gatecontrol: GC }, async (host) => {
    const { vehicleId } = await oneTrip(host, cloud);
    let r = await asPortal(host, ADA, 'GET', '/portal/logbook');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.trips.length, r.json.canEdit, r.json.admin, r.json.users], [1, true, false, []]);
    const id = r.json.trips[0].id;
    assert.equal((await asPortal(host, ADA, 'PUT', `/portal/logbook/trips/${id}`, { purpose: 'commute', driverUserId: BOB.id })).status, 200);
    const t1 = await logbook.getTrip(host.gc, id);
    assert.deepEqual([t1.purpose, t1.driverUserId], ['commute', ADA.id], 'the portal cannot change the driver');
    assert.equal((await asPortal(host, ADA, 'PUT', `/portal/logbook/trips/${id}`, { purpose: 'private' }, false)).json.code, 'LOGIN_REQUIRED');
    assert.equal((await asPortal(host, ADA, 'GET', '/portal/logbook', undefined, false)).json.canEdit, false);
    assert.equal((await asPortal(host, ADA, 'POST', '/portal/logbook/trips', { vehicleId })).status, 403);
    assert.equal((await asPortal(host, ADA, 'DELETE', `/portal/logbook/trips/${id}`)).status, 403);
    // Bob owns nothing
    r = await asPortal(host, BOB, 'GET', '/portal/logbook');
    assert.deepEqual([r.json.vehicles, r.json.trips], [[], []]);
    assert.equal((await asPortal(host, BOB, 'GET', `/portal/logbook?vehicle=${vehicleId}`)).json.code, 'SKODA_NOT_OWNER');
    assert.equal((await asPortal(host, BOB, 'PUT', `/portal/logbook/trips/${id}`, { purpose: 'private' })).json.code, 'SKODA_TRIP_NOT_FOUND');
    assert.equal((await asPortal(host, BOB, 'GET', `/portal/logbook/export?vehicle=${vehicleId}&from=${MONTH}&format=csv`)).json.code, 'SKODA_NOT_OWNER');
  });
});

test('quick action: the last trip business/private, the widget with the month and a choice; not for rules', () => {
  const cloud = fakeSkoda();
  return withHost({ cloud, gatecontrol: GC }, async (host) => {
    const { vehicleId } = await connected(host, cloud);
    await asAdmin(host, 'PUT', `/vehicles/${vehicleId}/owners`, { user_ids: [ADA.id] });
    // before the first trip: offered (its widget can be placed), a tap only says how trips get in
    const first = (await host.quickActions(ADA)).find((a) => a.id === `logbook:${vehicleId}`);
    assert.deepEqual([first.kind, first.state, first.subtitle, first.widget.value, first.widget.controls.length], ['toggle', null, 'Noch keine Fahrt erfasst', 0, 0]);
    assert.match(first.widget.status, /^Noch keine Fahrt/);
    const none = await host.runQuickAction(ADA, `logbook:${vehicleId}`);
    assert.deepEqual([none.body.ok, none.body.widget.value], [false, 0]);
    assert.match(none.body.message, /automatisch/);
    await withState({ moving: true, km: 5215 }, () => sync(host, 1));
    await withState({ lat: 51.1, lon: 7.1, km: 5232 }, () => sync(host, 1));
    const qa = (await host.quickActions(ADA)).find((a) => a.id === `logbook:${vehicleId}`);
    assert.ok(qa);
    assert.deepEqual([qa.kind, qa.state, qa.device.id, qa.widget.value, qa.widget.unit, qa.widget.state], ['toggle', null, `lb:${vehicleId}`, 22, 'km', 'warn']);
    assert.match(qa.subtitle, /^Letzte Fahrt: 22 km · Offen$/);
    assert.deepEqual(qa.widget.controls[0].options.map((o) => o.id), ['open', 'private', 'business', 'commute']);
    assert.equal(qa.widget.controls[0].value, 'open');
    assert.ok(qa.widget.readings.some((x) => x.id === 'open' && x.value === '1'));
    let r = await host.runQuickAction(ADA, `logbook:${vehicleId}`, 'de', { control: 'purpose', value: 'commute' });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.match(r.body.message, /Arbeitsweg/);
    assert.equal(r.body.widget.controls[0].value, 'commute');
    r = await host.runQuickAction(ADA, `logbook:${vehicleId}`);   // a tap: → business
    assert.deepEqual([r.body.ok, r.body.state], [true, 'on']);
    r = await host.runQuickAction(ADA, `logbook:${vehicleId}`);   // again: → private
    assert.deepEqual([r.body.ok, r.body.state], [true, 'off']);
    const auto = await host.quickActions({ ...ADA, automation: true });
    assert.ok(!auto.some((a) => a.id.startsWith('logbook:')), 'rules of other plugins do not classify trips');
    assert.equal((await host.runQuickAction(BOB, `logbook:${vehicleId}`)).status, 404);
  });
});

test('export: CSV (BOM, ";", formulas neutralised) and PDF (pages, sums); range checked', () => {
  const cloud = fakeSkoda();
  return withHost({ cloud, gatecontrol: GC }, async (host) => {
    const { vehicleId } = await oneTrip(host, cloud);
    const id = (await asAdmin(host, 'GET', '/logbook')).json.trips[0].id;
    await asAdmin(host, 'PUT', `/logbook/trips/${id}`, { purpose: 'business', note: '=HYPERLINK("x")' });
    let r = await asAdmin(host, 'GET', `/logbook/export?vehicle=${vehicleId}&from=${MONTH}&to=${MONTH}&format=csv`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.file.type, 'text/csv');
    assert.equal(r.json.file.name, `Fahrtenbuch-Elroq-${MONTH}.csv`);
    const csv = Buffer.from(r.json.file.data, 'base64').toString('utf8');
    assert.ok(csv.startsWith('\ufeff"Datum";"Abfahrt";"Ankunft";"Start";"Ziel"'));
    assert.match(csv, /"Hauptstraße 5, 50667 Köln";"5210";"5232";"22";"Geschäftlich";"'=HYPERLINK\(""x""\)";"Ada"\r\n$/);
    r = await asAdmin(host, 'GET', `/logbook/export?vehicle=${vehicleId}&from=${MONTH}&format=pdf`);
    assert.equal(r.json.file.type, 'application/pdf');
    const pdf = Buffer.from(r.json.file.data, 'base64');
    assert.equal(pdf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
    assert.match(pdf.toString('latin1'), /\/Count 1 >>/);
    const streams = [...pdf.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'));
    const text = streams.join('\n');
    assert.match(text, /\(Fahrtenbuch \\226 Elroq\)/);
    assert.match(text, /Gesch\\344ftlich: 22 km/);
    for (const q of [`from=2026-01&to=2028-12&format=csv`, `from=${MONTH}&format=xls`, `from=bad&format=csv`]) {
      assert.equal((await asAdmin(host, 'GET', `/logbook/export?vehicle=${vehicleId}&${q}`)).status, 400, q);
    }
  });
});

test('PDF writer: WinAnsi text, cutting with …, several pages', () => {
  assert.deepEqual(encode('Äö ß €–…☃'), [0xc4, 0xf6, 0x20, 0xdf, 0x20, 0x80, 0x96, 0x85, 0x3f]);
  const doc = new PdfDoc({ landscape: true, title: 'T' });
  assert.ok(doc.width('Hallo', 10) > 20 && doc.width('Hallo', 10) < 30);
  const cut = doc.fit('Hauptstraße 5, 50667 Köln, Deutschland', 60, 8);
  assert.ok(cut.endsWith('…') && doc.width(cut, 8) <= 60);
  assert.equal(doc.fit('kurz', 60, 8), 'kurz');
  doc.page(); doc.text(10, 10, 'Seite 1 (a\\b)'); doc.page(); doc.rect(0, 0, 10, 10, [0.5, 0.5, 0.5]);
  const buf = doc.toBuffer().toString('latin1');
  assert.match(buf, /\/Count 2 >>/);
  assert.match(buf, /%%EOF\n$/);
  const xref = Number(/startxref\n(\d+)/.exec(buf)[1]);
  assert.equal(buf.slice(xref, xref + 4), 'xref', 'the xref offset points at the table');
});
