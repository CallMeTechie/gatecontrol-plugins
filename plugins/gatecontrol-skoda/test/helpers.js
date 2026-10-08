'use strict';

// Test helpers: the mock host (tools/testing/mock-host.js) with a fake Škoda
// cloud behind gc.http.fetch — VW identity login (cookies, redirects, PKCE
// code exchange), the MySkoda API (single-use refresh tokens, 401/429), the
// render CDN and Nominatim. Shapes follow GateControl's
// tests/fixtures/skoda (python-myskoda reference models).

const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');

const DIR = path.join(__dirname, '..');
const IDENT = 'https://identity.vwgroup.io';
const API = 'https://mysmob.api.connect.skoda-auto.cz';
const CLIENT = '7f045eee-7003-4379-9968-9355ed2adb06@apps_vw-dilab_com';
const VIN = 'TMBTESTVIN000001';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-render-image')]);

const ADMIN = { id: 1, name: 'admin', role: 'admin' };
const ADA = { id: 2, name: 'Ada', role: 'user' };
const BOB = { id: 3, name: 'Bob', role: 'user' };
const USERS = [ADMIN, ADA, BOB];

const emailPage = `<!DOCTYPE html><html><head><title>Login</title></head><body>
<script>
window._IDK = {
  baseUrl: 'https://identity.vwgroup.io',
  csrf_token: 'csrf-123',
  templateModel: {"clientLegalEntityModel":{"clientId":"${CLIENT}"},"template":"loginAuthenticate","hmac":"hmac-abc","relayState":"relay-xyz","postAction":"login/identifier","identifierUrl":"login/identifier","error":null},
  userSession: {}
};
</script>
</body></html>`;
const passwordPage = emailPage.replace('hmac-abc', 'hmac-def').replace('"postAction":"login/identifier"', '"postAction":"login/authenticate"');

const fx = {
  garage: { vehicles: [{ vin: VIN, name: 'Elroq', title: 'Škoda Elroq', specification: { model: 'Elroq', modelYear: '2025' } }] },
  info: { vin: VIN, compositeRenders: [{ layers: [{ url: 'https://iprenders.blob.core.windows.net/renders/car.png', viewPoint: 'EXTERIOR_FRONT' }] }] },
  status: { carCapturedTimestamp: '2026-07-22T08:00:00Z', overall: { locked: 'YES', doors: 'CLOSED', windows: 'CLOSED', lights: 'OFF' }, detail: { bonnet: 'CLOSED', trunk: 'CLOSED', sunroof: 'UNSUPPORTED' } },
  drivingRange: { carType: 'ELECTRIC', totalRangeInKm: 310, primaryEngineRange: { engineType: 'ELECTRIC', currentSoCInPercent: 74, remainingRangeInKm: 310 } },
  charging: {
    status: { state: 'CHARGING', chargePowerInKw: 10.5, remainingTimeToFullyChargedInMinutes: 95, battery: { stateOfChargeInPercent: 74 } },
    settings: { targetStateOfChargeInPercent: 80, chargingCareMode: 'ACTIVATED' }, plug: { connectionState: 'CONNECTED' },
  },
  airConditioning: {
    state: 'OFF', targetTemperature: { temperatureValue: 22, unitInCar: 'CELSIUS' }, windowHeatingState: { front: 'OFF', rear: 'OFF' },
    timers: [
      { id: 1, enabled: true, time: '07:30', type: 'RECURRING', selectedDays: ['MONDAY', 'TUESDAY'] },
      { id: 2, enabled: false, time: '18:00', type: 'ONE_OFF', selectedDays: [] },
    ],
  },
  positions: { positions: [{ type: 'VEHICLE', gpsCoordinates: { latitude: 51.0, longitude: 7.0 } }], errors: [] },
  health: { capturedAt: '2026-07-22T08:00:00Z', mileageInKm: 5210, warningLights: [] },
  maintenance: { maintenanceReport: { inspectionDueInDays: 210, inspectionDueInKm: 24790 }, preferredServicePartner: { name: 'Autohaus Test GmbH' } },
  vehicleInformation: { vehicleSpecification: { model: 'Elroq', title: 'Škoda Elroq 85', modelYear: '2025', body: 'SUV', trimLevel: 'Sportline', engine: { powerInKW: 210 }, battery: { capacityInKWh: 77 }, maxChargingPowerInKW: 175 } },
  equipment: { equipment: [{ name: 'Wärmepumpe' }, { name: 'Matrix-LED' }] },
  readiness: { unreachable: false, ignitionOn: false, inMotion: false },
  drivingScore: { weeklyScore: { main: 81 }, monthlyScore: { main: 78 }, lastCalculationDate: '2026-07-21' },
  nominatim: { address: { road: 'Hauptstraße', house_number: '5', postcode: '50667', city: 'Köln' }, display_name: 'Hauptstraße 5, Köln' },
};

/**
 * A fake Škoda cloud. cloud.fetch is the mock host's internet handler.
 * Knobs: password, terms, fail (path part → status), renderUrl, timers.
 */
function fakeSkoda(opts = {}) {
  const cloud = {
    email: opts.email || 'ada@example.com',
    password: opts.password || 'pw-secret-1',
    terms: false,
    n: 0,
    access: null,
    refresh: null,
    fail: {},            // url part → HTTP status
    calls: [],
    commands: [],
    logins: 0,
    refreshes: 0,
    info: JSON.parse(JSON.stringify(fx.info)),
    ac: JSON.parse(JSON.stringify(fx.airConditioning)),
    garage: JSON.parse(JSON.stringify(fx.garage)),
    delayMs: 0,
    inFlight: 0,
    maxInFlight: 0,
  };
  const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const html = (body) => ({ status: 200, headers: { 'content-type': 'text/html' }, body });
  const redirect = (location, cookies) => ({ status: 302, headers: cookies ? { location, 'set-cookie': cookies } : { location }, body: '' });
  function issue() {
    cloud.n += 1;
    cloud.access = 'AT' + cloud.n;
    cloud.refresh = 'RT' + cloud.n;
    return { accessToken: cloud.access, refreshToken: cloud.refresh, idToken: 'IDT' + cloud.n };
  }
  cloud.issue = issue;

  cloud.fetch = async (url, o = {}) => {
    const method = (o.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(o.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    cloud.calls.push({ url, method, body: o.body, headers, binary: !!o.binary });
    const failKey = Object.keys(cloud.fail).find((k) => url.includes(k));
    if (failKey) return json({}, cloud.fail[failKey]);

    // VW identity
    if (url.startsWith(IDENT + '/oidc/v1/authorize')) return redirect(`${IDENT}/signin-service/v1/${CLIENT}/login?relayState=relay-xyz`, ['SESSION=s1; Path=/; Secure; HttpOnly']);
    if (url.startsWith(`${IDENT}/signin-service/v1/${CLIENT}/login?`)) return html(emailPage);
    if (url === `${IDENT}/signin-service/v1/${CLIENT}/login/identifier`) {
      if (!String(headers.cookie || '').includes('SESSION=s1')) return html('<html>no session</html>');
      return html(passwordPage);
    }
    if (url === `${IDENT}/signin-service/v1/${CLIENT}/login/authenticate`) {
      const form = new URLSearchParams(o.body || '');
      if (cloud.terms) return redirect(`${IDENT}/signin-service/v1/terms-and-conditions?x=1`);
      if (form.get('email') !== cloud.email || form.get('password') !== cloud.password || form.get('hmac') !== 'hmac-def') return html(passwordPage);
      return redirect(`${IDENT}/oidc/v1/oauth/sso?x=1`);
    }
    if (url.startsWith(IDENT + '/oidc/v1/oauth/sso')) return redirect('myskoda://redirect/login/?code=THECODE');
    if (url.startsWith(API + '/api/v1/authentication/exchange-authorization-code')) {
      const b = JSON.parse(o.body || '{}');
      if (b.code !== 'THECODE' || !b.verifier) return json({}, 400);
      cloud.logins += 1;
      return json(issue());
    }
    if (url.startsWith(API + '/api/v1/authentication/refresh-token')) {
      const b = JSON.parse(o.body || '{}');
      if (!cloud.refresh || b.token !== cloud.refresh) return json({}, 401); // single-use
      cloud.refreshes += 1;
      return json(issue());
    }

    // render CDN and Nominatim
    if (url.startsWith('https://iprenders.blob.core.windows.net/')) {
      if (headers.authorization) return json({}, 400); // never with the token
      return o.binary ? { status: 200, headers: { 'content-type': 'image/png' }, bodyBase64: PNG.toString('base64') } : { status: 200, headers: {}, body: PNG.toString('latin1') };
    }
    if (url.startsWith('https://nominatim.openstreetmap.org/reverse?')) return json(fx.nominatim);

    // MySkoda API (bearer)
    if (!url.startsWith(API)) return json({}, 404);
    if (headers.authorization !== 'Bearer ' + cloud.access) return json({}, 401);
    cloud.inFlight += 1;
    cloud.maxInFlight = Math.max(cloud.maxInFlight, cloud.inFlight);
    try {
      if (cloud.delayMs) await new Promise((r) => setTimeout(r, cloud.delayMs));
      const p = url.slice(API.length);
      if (method !== 'GET') {
        cloud.commands.push({ method, path: p, body: o.body ? JSON.parse(o.body) : null });
        if (p.endsWith('/timers')) {
          const t = JSON.parse(o.body).timers[0];
          const slot = cloud.ac.timers.find((x) => x.id === t.id);
          if (slot) Object.assign(slot, t);
        }
        return { status: 202, headers: {}, body: '' };
      }
      if (p.startsWith('/api/v2/garage/vehicles/')) return json(cloud.info);
      if (p.startsWith('/api/v2/garage')) return json(cloud.garage);
      if (p.endsWith('/driving-range')) return json(fx.drivingRange);
      if (p.endsWith('/driving-score')) return json(fx.drivingScore);
      if (p.startsWith('/api/v2/vehicle-status/')) return json(fx.status);
      if (p.startsWith('/api/v1/charging/')) return json(fx.charging);
      if (p.startsWith('/api/v2/air-conditioning/')) return json(cloud.ac);
      if (p.startsWith('/api/v1/maps/positions')) return json(fx.positions);
      if (p.startsWith('/api/v1/vehicle-health-report/warning-lights/')) return json(fx.health);
      if (p.startsWith('/api/v3/vehicle-maintenance/vehicles/')) return json(fx.maintenance);
      if (p.endsWith('/equipment')) return json(fx.equipment);
      if (p.startsWith('/api/v1/vehicle-information/')) return json(fx.vehicleInformation);
      if (p.endsWith('/readiness')) return json(fx.readiness);
      return json({}, 404);
    } finally {
      cloud.inFlight -= 1;
    }
  };
  return cloud;
}

/** Mock host with the fake cloud behind gc.http.fetch. */
async function withHost(o, fn) {
  const cloud = o.cloud || fakeSkoda();
  const host = await createHost(DIR, { users: o.users || USERS, settings: o.settings, license: o.license, fetch: cloud.fetch });
  try {
    await host.start();
    await fn(host, cloud);
  } finally {
    await host.stop();
    await host.close();
  }
}

/** Requests as an administrator / a portal viewer (loggedIn: signed in, not only device trust). */
const asAdmin = (host, method, p, body) => host.request({ method, path: p, body: body === undefined ? null : body, user: ADMIN });
const asPortal = (host, user, method, p, body, loggedIn = true) => host.request({ method, path: p, body: body === undefined ? null : body, user: { ...user, portal: true, loggedIn } });

/** Add the cloud's account, sync it; returns { accountId, vehicleId }. */
async function connected(host, cloud) {
  const r = await asAdmin(host, 'POST', '/accounts', { email: cloud.email, password: cloud.password });
  if (r.status !== 201) throw new Error('account failed: ' + JSON.stringify(r.json));
  const s = await asAdmin(host, 'POST', `/accounts/${r.json.account.id}/sync`);
  if (!s.json.result || !s.json.result.ok) throw new Error('sync failed: ' + JSON.stringify(s.json));
  const st = await asAdmin(host, 'GET', '/');
  return { accountId: r.json.account.id, vehicleId: st.json.vehicles[0].id };
}

module.exports = { DIR, IDENT, API, CLIENT, VIN, PNG, ADMIN, ADA, BOB, USERS, emailPage, passwordPage, fx, fakeSkoda, withHost, asAdmin, asPortal, connected };
