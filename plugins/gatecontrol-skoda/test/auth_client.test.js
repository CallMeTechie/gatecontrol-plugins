'use strict';

// MySkoda login and API client through the host (ported from GateControl's
// tests/skoda_auth.test.js, skoda_http.test.js, skoda_client*.test.js):
// every request goes through gc.http.fetch, which allows only the hosts of
// plugin.json and never follows a redirect itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const auth = require('../server/auth');
const { SkodaClient, normalizeVehicleState, imageType, renderHostAllowed } = require('../server/client');
const { fetchFor, CookieJar, responseOf } = require('../server/http');
const { createHost, internetAllowed } = require('../../../tools/testing/mock-host');
const { DIR, emailPage, fakeSkoda, fx, PNG, VIN } = require('./helpers');

async function hostWith(cloud) {
  return createHost(DIR, { fetch: cloud.fetch });
}

test('plugin.json allows exactly the Škoda, render and geocoding hosts (HTTPS)', () => {
  const list = require('../plugin.json').permissions.network.internet;
  for (const ok of ['https://identity.vwgroup.io/oidc/v1/authorize', 'https://mysmob.api.connect.skoda-auto.cz/api/v2/garage',
    'https://iprenders.blob.core.windows.net/r/1.png', 'https://ip-modcwp.azureedge.net/r.png', 'https://ip-xyz.azureedge.net/r.png',
    'https://render.skoda-auto.cz/r.png', 'https://nominatim.openstreetmap.org/reverse']) {
    assert.equal(internetAllowed(list, ok), true, ok);
  }
  for (const bad of ['https://evil.blob.core.windows.net/x', 'https://azureedge.net/x', 'https://skoda-auto.cz/', 'https://identity.vwgroup.io:8443/',
    'https://ip-xyz.azureedge.net:8443/x', 'https://azureedge.net.evil.example/x', 'http://169.254.169.254/latest', 'https://example.com/']) {
    assert.equal(internetAllowed(list, bad), false, bad);
  }
  const m = require('../plugin.json');
  assert.equal(m.gatecontrol, '>=1.151.0');
  assert.deepEqual(m.license, { required: true });
  assert.equal(m.permissions.network.homeTargets, undefined, 'a cloud integration needs no home network');
});

test('generatePkce: base64url verifier and matching S256 challenge', () => {
  const { verifier, challenge } = auth.generatePkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
});

test('parseIdk / parseFragment', () => {
  const idk = auth.parseIdk(emailPage);
  assert.equal(idk.csrfToken, 'csrf-123');
  assert.equal(idk.templateModel.hmac, 'hmac-abc');
  assert.equal(idk.templateModel.relayState, 'relay-xyz');
  assert.throws(() => auth.parseIdk('<html>maintenance</html>'), (e) => e.code === 'SKODA_AUTH_FLOW_CHANGED');
  assert.equal(auth.parseFragment('myskoda://redirect/login/#code=THECODE&id_token=IDT').code, 'THECODE');
  assert.equal(auth.parseFragment('myskoda://redirect/login/?state=x&code=QCODE').code, 'QCODE');
});

test('http adapter: header lookup, set-cookie list, binary body; cookie jar per host', async () => {
  const r = responseOf({ status: 302, headers: { location: '/next', 'set-cookie': ['A=1; Path=/', 'B=2'] }, body: '' });
  assert.equal(r.headers.get('Location'), '/next');
  assert.deepEqual(r.headers.getSetCookie(), ['A=1; Path=/', 'B=2']);
  const jar = new CookieJar();
  jar.storeFrom(r, 'https://identity.vwgroup.io/a');
  assert.equal(jar.headerFor('https://identity.vwgroup.io/b'), 'A=1; B=2');
  assert.equal(jar.headerFor('https://mysmob.api.connect.skoda-auto.cz/'), null, 'cookies stay with their host');
  const bin = responseOf({ status: 200, headers: {}, bodyBase64: PNG.toString('base64') });
  assert.equal(Buffer.from(await bin.arrayBuffer()).equals(PNG), true);
});

test('login walks the full flow through the host (cookies, redirects, code exchange)', async () => {
  const cloud = fakeSkoda();
  const host = await hostWith(cloud);
  try {
    const tokens = await auth.login(cloud.email, cloud.password, { fetchImpl: fetchFor(host.gc) });
    assert.deepEqual(tokens, { accessToken: 'AT1', refreshToken: 'RT1' });
    const authorize = cloud.calls.find((c) => c.url.includes('/oidc/v1/authorize'));
    assert.match(authorize.url, /response_type=code(&|$)/);
    assert.match(authorize.url, /code_challenge_method=s256/);
    assert.match(authorize.url, /prompt=login/);
    const identifier = cloud.calls.find((c) => c.url.endsWith('/login/identifier'));
    assert.match(identifier.body, /email=ada%40example.com/);
    assert.match(identifier.body, /hmac=hmac-abc/);
    assert.match(identifier.headers.cookie, /SESSION=s1/);
    const authPost = cloud.calls.find((c) => c.url.endsWith('/login/authenticate'));
    assert.match(authPost.body, /hmac=hmac-def/);
    const exchange = cloud.calls.find((c) => c.url.includes('exchange-authorization-code'));
    assert.equal(JSON.parse(exchange.body).redirectUri, auth.REDIRECT_URI);
    assert.ok(!cloud.calls.some((c) => c.url.startsWith('myskoda://')), 'the app scheme is never requested');
    assert.ok(host.fetches.every((f) => /^https:\/\/(identity\.vwgroup\.io|mysmob\.api\.connect\.skoda-auto\.cz)\//.test(f.url)));
  } finally { await host.close(); }
});

test('login: wrong password → SKODA_LOGIN_FAILED; terms → SKODA_TERMS_REQUIRED', async () => {
  const cloud = fakeSkoda();
  const host = await hostWith(cloud);
  try {
    await assert.rejects(auth.login(cloud.email, 'wrong', { fetchImpl: fetchFor(host.gc) }), (e) => e.code === 'SKODA_LOGIN_FAILED');
    cloud.terms = true;
    await assert.rejects(auth.login(cloud.email, cloud.password, { fetchImpl: fetchFor(host.gc) }), (e) => e.code === 'SKODA_TERMS_REQUIRED');
  } finally { await host.close(); }
});

test('refresh: new tokens; 429 → SKODA_RATE_LIMITED', async () => {
  const cloud = fakeSkoda();
  const host = await hostWith(cloud);
  try {
    cloud.issue();
    const tokens = await auth.refresh('RT1', { fetchImpl: fetchFor(host.gc) });
    assert.deepEqual(tokens, { accessToken: 'AT2', refreshToken: 'RT2' });
    cloud.fail['refresh-token'] = 429;
    await assert.rejects(auth.refresh('RT2', { fetchImpl: fetchFor(host.gc) }), (e) => e.code === 'SKODA_RATE_LIMITED');
  } finally { await host.close(); }
});

test('client: a 401 refreshes once and repeats; a failing refresh is SKODA_UNAUTHORIZED', async () => {
  const cloud = fakeSkoda();
  const host = await hostWith(cloud);
  try {
    cloud.issue(); // AT1/RT1
    let session = { accessToken: 'stale', refreshToken: 'RT1' };
    const saved = [];
    const client = new SkodaClient({ getSession: async () => session, saveSession: async (t) => { saved.push(t); session = t; }, fetchImpl: fetchFor(host.gc) });
    const garage = await client.garage();
    assert.equal(garage.vehicles[0].vin, VIN);
    assert.deepEqual(saved, [{ accessToken: 'AT2', refreshToken: 'RT2' }]);
    session = { accessToken: 'stale', refreshToken: 'used-up' };
    await assert.rejects(client.garage(), (e) => e.code === 'SKODA_UNAUTHORIZED');
    session = { accessToken: cloud.access, refreshToken: cloud.refresh };
    cloud.fail['/api/v2/garage'] = 429;
    await assert.rejects(client.garage(), (e) => e.code === 'SKODA_RATE_LIMITED');
  } finally { await host.close(); }
});

test('client: render image only from the render hosts, without the token; type sniffed', async () => {
  const cloud = fakeSkoda();
  const host = await hostWith(cloud);
  try {
    cloud.issue();
    const client = new SkodaClient({ getSession: async () => ({ accessToken: cloud.access, refreshToken: cloud.refresh }), saveSession: async () => {}, fetchImpl: fetchFor(host.gc) });
    const img = await client.renderImage('https://iprenders.blob.core.windows.net/renders/car.png');
    assert.equal(img.type, 'image/png');
    assert.equal(img.bytes.equals(PNG), true);
    const call = cloud.calls.at(-1);
    assert.equal(call.headers.authorization, undefined, 'no bearer token to the CDN');
    assert.equal(call.binary, true);
    // the built-in rule: iprenders exactly, any host under azureedge.net / skoda-auto.cz — HTTPS, default port
    const other = await client.renderImage('https://ip-xyz.azureedge.net/renders/car.png');
    assert.equal(other.bytes.equals(PNG), true);
    assert.equal(cloud.calls.at(-1).url, 'https://ip-xyz.azureedge.net/renders/car.png');
    assert.equal(cloud.calls.at(-1).headers.authorization, undefined, 'no bearer token to the CDN');
    const n = cloud.calls.length;
    for (const bad of ['http://iprenders.blob.core.windows.net/x.png', 'http://ip-xyz.azureedge.net/x.png', 'https://evil.example/x.png',
      'https://evil.blob.core.windows.net/x.png', 'https://azureedge.net/x.png', 'https://azureedge.net.evil.example/x.png',
      'https://evilazureedge.net/x.png', 'https://ip-xyz.azureedge.net:8443/x.png', 'not a url']) {
      await assert.rejects(client.renderImage(bad), (e) => ['SKODA_API_ERROR', 'SKODA_RENDER_HOST'].includes(e.code), bad);
    }
    assert.equal(cloud.calls.length, n, 'a refused render url is never fetched');
    for (const h of ['iprenders.blob.core.windows.net', 'ip-modcwp.azureedge.net', 'ip-xyz.azureedge.net', 'a.b.azureedge.net', 'render.skoda-auto.cz']) assert.equal(renderHostAllowed(h), true, h);
    for (const h of ['evil.example', 'x.iprenders.blob.core.windows.net', 'azureedge.net', 'skoda-auto.cz', 'evilazureedge.net', 'azureedge.net.evil.example', '']) assert.equal(renderHostAllowed(h), false, h);
    assert.equal(imageType(Buffer.from('GIF89a-not-allowed')), null);
  } finally { await host.close(); }
});

test('fetchFullState: one failing endpoint → null part; account-level errors abort', async () => {
  const cloud = fakeSkoda();
  const host = await hostWith(cloud);
  try {
    cloud.issue();
    const client = new SkodaClient({ getSession: async () => ({ accessToken: cloud.access, refreshToken: cloud.refresh }), saveSession: async () => {}, fetchImpl: fetchFor(host.gc) });
    cloud.fail['/api/v1/maps/positions'] = 500;
    const { state } = await client.fetchFullState(VIN);
    assert.equal(state.position, null);
    assert.equal(state.soc, 74);
    cloud.fail['/api/v1/charging/'] = 429;
    await assert.rejects(client.fetchFullState(VIN), (e) => e.code === 'SKODA_RATE_LIMITED');
  } finally { await host.close(); }
});

test('normalizeVehicleState maps the MySkoda payloads', () => {
  const s = normalizeVehicleState({ status: fx.status, drivingRange: fx.drivingRange, charging: fx.charging, airConditioning: fx.airConditioning, position: fx.positions, health: fx.health, maintenance: fx.maintenance });
  assert.equal(s.locked, true);
  assert.equal(s.doorsOpen, false);
  assert.equal(s.soc, 74);
  assert.equal(s.rangeKm, 310);
  assert.deepEqual(s.charging, { state: 'CHARGING', powerKw: 10.5, remainingMin: 95, targetPercent: 80, mode: 'ACTIVATED', cableConnected: true });
  assert.equal(s.climate.targetC, 22);
  assert.equal(s.climate.windowHeating, false);
  assert.deepEqual(s.climate.timers[0], { id: 1, enabled: true, time: '07:30', type: 'RECURRING', days: ['MONDAY', 'TUESDAY'] });
  assert.deepEqual(s.position, { lat: 51, lon: 7 });
  assert.equal(s.health.mileageKm, 5210);
  assert.deepEqual(s.maintenance, { dueInDays: 210, dueInKm: 24790, partner: 'Autohaus Test GmbH' });
  const empty = normalizeVehicleState({});
  assert.equal(empty.locked, null);
  assert.deepEqual(empty.climate.timers, []);
});
