'use strict';

// Accounts, sync, polling (ported from GateControl's tests/skoda_sync.test.js,
// skoda_accounts.test.js, skoda_api.test.js, skoda_spin.test.js): the admin
// API of the plugin against the fake Škoda cloud.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asPortal, connected, fakeSkoda, VIN, PNG, ADA } = require('./helpers');

test('accounts: create (validated), list without secrets, secrets as encrypted settings', () => withHost({}, async (host, cloud) => {
  for (const bad of [{ email: 'not-an-email', password: 'x' }, { email: 'a@b.c' }, { email: 'a@b..c', password: 'x' }, { email: 'a b@c.de', password: 'x' }]) {
    const r = await asAdmin(host, 'POST', '/accounts', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.json.code, 'SKODA_VALIDATION');
  }
  const r = await asAdmin(host, 'POST', '/accounts', { email: ' ada@example.com ', password: cloud.password });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.json.account).sort(), ['email', 'has_credentials', 'has_spin', 'id', 'next_retry_at', 'status', 'status_detail', 'updated_at']);
  assert.equal(r.json.account.email, 'ada@example.com');
  assert.equal(r.json.account.has_credentials, true);
  assert.equal((await asAdmin(host, 'POST', '/accounts', { email: 'ada@example.com', password: 'x' })).json.code, 'SKODA_ACCOUNT_EXISTS');
  const id = r.json.account.id;
  assert.ok(host.secrets.has(`acc.${id}.password`));
  assert.equal(await host.gc.settings.get(`acc.${id}.password`), cloud.password);
  const list = await asAdmin(host, 'GET', '/');
  assert.ok(!JSON.stringify(list.json).includes(cloud.password), 'never in an answer');
  const rows = JSON.stringify((await host.gc.db.query('SELECT * FROM accounts')).rows);
  assert.ok(!rows.includes(cloud.password), 'never in the database');
  // S-PIN: 4-10 digits, secret
  assert.equal((await asAdmin(host, 'PUT', `/accounts/${id}/spin`, { spin: '12' })).json.code, 'SKODA_VALIDATION');
  assert.equal((await asAdmin(host, 'PUT', `/accounts/${id}/spin`, { spin: '1234' })).status, 200);
  assert.equal((await asAdmin(host, 'PUT', '/accounts/99/spin', { spin: '1234' })).status, 404);
  assert.equal((await asAdmin(host, 'GET', '/')).json.accounts[0].has_spin, true);
  assert.ok(host.secrets.has(`acc.${id}.spin`));
}));

test('sync: login, vehicle with normalised state and render image; session tokens are secrets', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId } = await connected(host, cloud);
  const st = (await asAdmin(host, 'GET', '/')).json;
  assert.equal(st.accounts[0].status, 'ok');
  const v = st.vehicles[0];
  assert.deepEqual([v.vin, v.name, v.model, v.has_image], [VIN, 'Elroq', 'Elroq', true]);
  assert.equal(v.state.soc, 74);
  assert.ok(v.fetched_at);
  assert.equal(st.poll_interval_min, 15);
  assert.ok(st.lastSyncAt);
  const img = await asAdmin(host, 'GET', `/vehicles/${vehicleId}/image`);
  assert.deepEqual(img.json, { ok: true, type: 'image/png', part: 0, parts: 1, size: PNG.toString('base64').length, data: PNG.toString('base64') });
  assert.equal(await host.gc.settings.get(`acc.${accountId}.access`), 'AT1');
  assert.equal(await host.gc.settings.get(`acc.${accountId}.refresh`), 'RT1');
  assert.ok(!host.logs.some((l) => /AT1|RT1|pw-secret/.test(l.message)), 'nothing secret in the log');
  // a second sync reuses the session and the image (no new login, no new download)
  const before = cloud.calls.length;
  await asAdmin(host, 'POST', `/accounts/${accountId}/sync`);
  assert.equal(cloud.logins, 1);
  assert.ok(!cloud.calls.slice(before).some((c) => c.url.includes('iprenders')));
  assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM vehicles')).row.n, 1);
}));

test('an expired access token is refreshed once (single-use refresh token kept in sync)', () => withHost({}, async (host, cloud) => {
  const { accountId } = await connected(host, cloud);
  cloud.issue(); // the cloud rotated the tokens: the stored AT1 is no longer valid
  cloud.refresh = 'RT1'; // … but the stored refresh token still is
  await asAdmin(host, 'POST', `/accounts/${accountId}/sync`);
  assert.equal(cloud.refreshes, 1);
  assert.equal(await host.gc.settings.get(`acc.${accountId}.refresh`), cloud.refresh);
  assert.equal((await asAdmin(host, 'GET', '/')).json.accounts[0].status, 'ok');
}));

test('wrong password → login_failed (skipped by the poll); a new password resets the status', () => withHost({}, async (host, cloud) => {
  const r = await asAdmin(host, 'POST', '/accounts', { email: cloud.email, password: 'wrong' });
  const id = r.json.account.id;
  const s = await asAdmin(host, 'POST', `/accounts/${id}/sync`);
  assert.equal(s.json.result.ok, false);
  let acc = (await asAdmin(host, 'GET', '/')).json.accounts[0];
  assert.equal(acc.status, 'login_failed');
  assert.match(acc.status_detail, /^SKODA_LOGIN_FAILED/);
  const calls = cloud.calls.length;
  assert.equal(await host.tick(), undefined);
  assert.equal(cloud.calls.length, calls, 'the poll leaves a login_failed account alone');
  assert.equal((await asAdmin(host, 'PUT', `/accounts/${id}`, { password: cloud.password })).status, 200);
  acc = (await asAdmin(host, 'GET', '/')).json.accounts[0];
  assert.equal(acc.status, 'ok');
  assert.equal((await asAdmin(host, 'POST', `/accounts/${id}/sync`)).json.result.ok, true);
}));

test('429: rate_limited with 60 min backoff, doubling, capped at 240; skipped until next_retry_at', () => withHost({}, async (host, cloud) => {
  const { accountId } = await connected(host, cloud);
  const service = require('../server/service');
  cloud.fail['/api/v2/garage'] = 429;
  const backoff = async () => (await host.gc.db.get('SELECT backoff_min, status, next_retry_at FROM accounts WHERE id = ?', [accountId])).row;
  await asAdmin(host, 'POST', `/accounts/${accountId}/sync`);
  assert.deepEqual([(await backoff()).status, (await backoff()).backoff_min], ['rate_limited', 60]);
  assert.ok(new Date((await backoff()).next_retry_at) > new Date());
  await service.syncAll(host.gc, { ignoreRetryAt: true });
  assert.equal((await backoff()).backoff_min, 120);
  await service.syncAll(host.gc, { ignoreRetryAt: true });
  await service.syncAll(host.gc, { ignoreRetryAt: true });
  assert.equal((await backoff()).backoff_min, 240);
  const calls = cloud.calls.length;
  await service.syncAll(host.gc);
  assert.equal(cloud.calls.length, calls, 'skipped before next_retry_at');
  delete cloud.fail['/api/v2/garage'];
  await host.gc.db.run("UPDATE accounts SET next_retry_at = '2000-01-01T00:00:00Z'");
  await service.syncAll(host.gc);
  assert.deepEqual([(await backoff()).status, (await backoff()).backoff_min], ['ok', 0]);
}));

test('refresh: 5 minute cooldown; unknown vehicle 404', () => withHost({}, async (host, cloud) => {
  const { vehicleId } = await connected(host, cloud);
  assert.equal((await asAdmin(host, 'POST', `/vehicles/${vehicleId}/refresh`)).status, 200);
  const again = await asAdmin(host, 'POST', `/vehicles/${vehicleId}/refresh`);
  assert.equal(again.status, 429);
  assert.equal(again.json.code, 'SKODA_REFRESH_COOLDOWN');
  assert.equal((await asAdmin(host, 'POST', '/vehicles/999/refresh')).status, 404);
}));

test('concurrent syncs of one account are serialised (account lock)', () => withHost({}, async (host, cloud) => {
  const { accountId } = await connected(host, cloud);
  cloud.delayMs = 5;
  cloud.maxInFlight = 0;
  await Promise.all([asAdmin(host, 'POST', `/accounts/${accountId}/sync`), asAdmin(host, 'POST', `/accounts/${accountId}/sync`)]);
  assert.equal(cloud.maxInFlight, 1);
}));

test('a vehicle missing from a later garage keeps its data', () => withHost({}, async (host, cloud) => {
  const { accountId } = await connected(host, cloud);
  cloud.garage = { vehicles: [] };
  await asAdmin(host, 'POST', `/accounts/${accountId}/sync`);
  const v = (await asAdmin(host, 'GET', '/')).json.vehicles[0];
  assert.equal(v.vin, VIN);
  assert.ok(v.state);
}));

test('a render on a host outside plugin.json is skipped, the sync still succeeds', () => withHost({}, async (host, cloud) => {
  cloud.info.compositeRenders[0].layers[0].url = 'https://evil.example/render.png';
  const { vehicleId } = await connected(host, cloud);
  assert.equal((await asAdmin(host, 'GET', '/')).json.vehicles[0].has_image, false);
  assert.equal((await asAdmin(host, 'GET', `/vehicles/${vehicleId}/image`)).status, 404);
  assert.ok(!cloud.calls.some((c) => c.url.includes('evil.example')));
}));

test('remove account: vehicles, owners and secrets go too', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId } = await connected(host, cloud);
  await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '1234' });
  await asAdmin(host, 'PUT', `/vehicles/${vehicleId}/owners`, { user_ids: [2] });
  assert.equal((await asAdmin(host, 'DELETE', `/accounts/${accountId}`)).status, 200);
  assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM vehicles')).row.n, 0);
  assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM vehicle_owners')).row.n, 0);
  for (const k of ['password', 'spin', 'access', 'refresh']) assert.equal(await host.gc.settings.get(`acc.${accountId}.${k}`), null, k);
  assert.equal((await asAdmin(host, 'DELETE', `/accounts/${accountId}`)).status, 404);
}));

test('poll interval: setting 5–1440 minutes (default 15); tick polls once per interval', () => withHost({}, async (host, cloud) => {
  await connected(host, cloud);
  assert.equal((await asAdmin(host, 'PUT', '/settings', { poll_interval_min: 4 })).status, 400);
  assert.equal((await asAdmin(host, 'PUT', '/settings', { poll_interval_min: 1441 })).status, 400);
  assert.equal((await asAdmin(host, 'PUT', '/settings', { poll_interval_min: 30 })).status, 200);
  assert.equal(host.settings.interval, 30);
  assert.equal((await asAdmin(host, 'GET', '/')).json.poll_interval_min, 30);
  const garageCalls = () => cloud.calls.filter((c) => /\/api\/v2\/garage\?/.test(c.url)).length;
  const n = garageCalls();
  await host.tick();
  assert.equal(garageCalls(), n + 1, 'first tick polls');
  await host.tick();
  assert.equal(garageCalls(), n + 1, 'within the interval: nothing');
  require('../server/service').state.lastPoll = Date.now() - 31 * 60000;
  await host.tick();
  assert.equal(garageCalls(), n + 2);
}));

test('the admin API refuses portal viewers and non-admins', () => withHost({}, async (host) => {
  assert.equal((await asPortal(host, ADA, 'GET', '/')).status, 403);
  assert.equal((await host.request({ method: 'GET', path: '/', user: ADA })).status, 403);
  assert.equal((await host.request({ method: 'POST', path: '/accounts', user: { ...ADA, role: 'user' }, body: {} })).status, 403);
  assert.equal((await asPortal(host, { id: 1, name: 'admin', role: 'admin' }, 'GET', '/users')).status, 403, 'an admin in the portal is a portal viewer');
}));

test('owners: validated before writing, unknown users refused', () => withHost({}, async (host, cloud) => {
  const { vehicleId } = await connected(host, cloud);
  let r = await asAdmin(host, 'PUT', `/vehicles/${vehicleId}/owners`, { user_ids: [2, 3, 2, '3'] });
  assert.deepEqual(r.json.owners, [{ id: 2, username: 'Ada' }, { id: 3, username: 'Bob' }]);
  r = await asAdmin(host, 'PUT', `/vehicles/${vehicleId}/owners`, { user_ids: [2, 99] });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'SKODA_OWNER_UNKNOWN_USER');
  assert.deepEqual((await host.gc.db.query('SELECT user_id FROM vehicle_owners ORDER BY user_id')).rows.map((x) => x.user_id), [2, 3], 'nothing written');
  assert.equal((await asAdmin(host, 'PUT', `/vehicles/${vehicleId}/owners`, { user_ids: 'x' })).json.code, 'SKODA_VALIDATION');
  assert.equal((await asAdmin(host, 'PUT', '/vehicles/999/owners', { user_ids: [] })).status, 404);
  assert.deepEqual((await asAdmin(host, 'GET', '/')).json.vehicles[0].owners, [{ id: 2, username: 'Ada' }, { id: 3, username: 'Bob' }]);
  assert.deepEqual((await asAdmin(host, 'GET', '/users')).json.users.map((u) => u.username), ['admin', 'Ada', 'Bob']);
}));

test('a cloud outage marks the account, nothing crashes', () => withHost({ cloud: fakeSkoda() }, async (host, cloud) => {
  const { accountId } = await connected(host, cloud);
  cloud.fail['/api/v2/garage?'] = 503;
  const r = await asAdmin(host, 'POST', `/accounts/${accountId}/sync`);
  assert.equal(r.json.result.ok, false);
  assert.equal((await asAdmin(host, 'GET', '/')).json.accounts[0].status, 'error');
}));
