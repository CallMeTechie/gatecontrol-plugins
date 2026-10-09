'use strict';

// The vehicle render (1.0.1): stored as a BLOB, served in parts that each
// stay under the host's 1 MB per answer and join byte-identically (admin
// page, portal, the pages' own loader in ui/common.js); 1.0.0 rows with
// base64 text still served; renders up to 4 MB, also from the built-in
// data import; a missing image is fetched again on the next sync.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asPortal, connected, fetchImage, uiCommon, bigPng, PNG, ADMIN, ADA, BOB, VIN } = require('./helpers');
const store = require('../server/store');
const { MAX_IMAGE_BYTES } = require('../server/service');

const MB = 1024 * 1024;
const RENDER = 'https://iprenders.blob.core.windows.net/renders/car.png';
const portalUser = (u) => ({ ...u, portal: true, loggedIn: true });

async function owned(host, cloud) {
  const ids = await connected(host, cloud);
  await asAdmin(host, 'PUT', `/vehicles/${ids.vehicleId}/owners`, { user_ids: [ADA.id] });
  return ids;
}

test('a 2 MB render is stored as a BLOB and served in parts that join byte-identically (admin, portal, page loader)', () => withHost({}, async (host, cloud) => {
  cloud.render = bigPng(2 * MB);
  const { vehicleId } = await owned(host, cloud);
  const v = (await asAdmin(host, 'GET', '/')).json.vehicles[0];
  assert.equal(v.has_image, true);
  const row = (await host.gc.db.get('SELECT image IS NOT NULL AS blob, image_b64, length(image) AS n FROM vehicles WHERE id = ?', [vehicleId])).row;
  assert.deepEqual(row, { blob: 1, image_b64: null, n: 2 * MB });

  const admin = await fetchImage(host, ADMIN, `/vehicles/${vehicleId}/image`);
  assert.equal(admin.type, 'image/png');
  assert.equal(admin.parts, Math.ceil((2 * MB) / store.IMAGE_PART_BYTES));
  assert.ok(admin.parts > 1);
  assert.equal(admin.bytes.equals(cloud.render), true, 'byte-identical');
  const portal = await fetchImage(host, portalUser(ADA), `/portal/vehicles/${vehicleId}/image`);
  assert.equal(portal.bytes.equals(cloud.render), true);
  // every part but the last is a full 600 KiB slice (a multiple of 4 characters)
  const p0 = (await host.request({ method: 'GET', path: `/vehicles/${vehicleId}/image`, query: { part: '0' }, user: ADMIN })).json;
  assert.equal(p0.data.length, store.IMAGE_PART_CHARS);
  assert.equal(p0.data.length % 4, 0);
  assert.equal(p0.size, cloud.render.toString('base64').length);

  // the pages' loader (ui/common.js) through a bridge like GateControl's
  const want = 'data:image/png;base64,' + cloud.render.toString('base64');
  const ui = uiCommon(host, ADMIN);
  assert.equal(await ui.SK.loadImage(`vehicles/${vehicleId}/image`), want);
  assert.deepEqual(ui.calls, Array.from({ length: admin.parts }, (_, n) => `vehicles/${vehicleId}/image?part=${n}`), 'parts in turn');
  const pui = uiCommon(host, portalUser(ADA));
  assert.equal(await pui.SK.loadImage(`portal/vehicles/${vehicleId}/image`), want);
  // cached once per page view: a second card rebuild asks nothing
  const cache = {};
  const [a, b] = await Promise.all([pui.SK.cachedImage(cache, vehicleId, `portal/vehicles/${vehicleId}/image`), pui.SK.cachedImage(cache, vehicleId, `portal/vehicles/${vehicleId}/image`)]);
  assert.equal(a, want);
  assert.equal(b, want);
  const n = pui.calls.length;
  assert.equal(await pui.SK.cachedImage(cache, vehicleId, `portal/vehicles/${vehicleId}/image`), want);
  assert.equal(pui.calls.length, n);
  // another viewer's portal: not the owner
  await assert.rejects(fetchImage(host, portalUser(BOB), `/portal/vehicles/${vehicleId}/image`), { status: 403 });
  assert.equal(await uiCommon(host, portalUser(BOB)).SK.cachedImage({}, vehicleId, `portal/vehicles/${vehicleId}/image`), null);
}));

test('image part: a non-negative integer below parts; malformed → 400, out of range or no image → 404', () => withHost({}, async (host, cloud) => {
  cloud.render = bigPng(MB);
  const { vehicleId } = await owned(host, cloud);
  const get = (part, user = ADMIN, p = `/vehicles/${vehicleId}/image`) => host.request({ method: 'GET', path: p, query: part === undefined ? {} : { part }, user });
  const parts = (await get('0')).json.parts;
  assert.equal(parts, 3);
  assert.equal((await get(undefined)).json.part, 0, 'no part = part 0');
  assert.equal((await get(String(parts - 1))).status, 200);
  for (const bad of ['abc', '-1', '1.5', '01', '', ' 1', '1e2', '0x1']) {
    const r = await get(bad);
    assert.equal(r.status, 400, bad);
    assert.equal(r.json.code, 'SKODA_VALIDATION', bad);
  }
  for (const out of [String(parts), '999999']) {
    const r = await get(out);
    assert.equal(r.status, 404, out);
    assert.equal(r.json.code, 'NOT_FOUND', out);
  }
  assert.equal((await get('1', portalUser(ADA), `/portal/vehicles/${vehicleId}/image`)).status, 200);
  assert.equal((await get('abc', portalUser(ADA), `/portal/vehicles/${vehicleId}/image`)).status, 400);
  assert.equal((await get(String(parts), portalUser(ADA), `/portal/vehicles/${vehicleId}/image`)).status, 404);
  // the owner check comes first
  assert.equal((await get('0', portalUser(BOB), `/portal/vehicles/${vehicleId}/image`)).status, 403);
  assert.equal((await get('abc', portalUser(BOB), `/portal/vehicles/${vehicleId}/image`)).status, 403);
  // no image / unknown vehicle
  await host.gc.db.run('UPDATE vehicles SET image = NULL, image_b64 = NULL WHERE id = ?', [vehicleId]);
  assert.equal((await get('0')).status, 404);
  assert.equal((await get('0', ADMIN, '/vehicles/999/image')).status, 404);
}));

test('a 1.0.0 row (base64 text in image_b64) is still served in parts, kept on sync, replaced by a BLOB when the url changes', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId } = await connected(host, cloud);
  const old = bigPng(700 * 1024);
  // as stored by 1.0.0 (image_b64, string parameter under the host's 1 MB)
  await host.gc.db.run("UPDATE vehicles SET image = NULL, image_b64 = ?, image_type = 'image/png' WHERE id = ?", [old.toString('base64'), vehicleId]);
  assert.equal((await asAdmin(host, 'GET', '/')).json.vehicles[0].has_image, true);
  const got = await fetchImage(host, ADMIN, `/vehicles/${vehicleId}/image`);
  assert.equal(got.parts, 2);
  assert.equal(got.bytes.equals(old), true);
  assert.equal(await uiCommon(host, ADMIN).SK.loadImage(`vehicles/${vehicleId}/image`), 'data:image/png;base64,' + old.toString('base64'));
  // same url: not downloaded again, the old row stays
  const before = cloud.calls.length;
  await asAdmin(host, 'POST', `/accounts/${accountId}/sync`);
  assert.ok(!cloud.calls.slice(before).some((c) => c.url.includes('/renders/')));
  assert.equal((await fetchImage(host, ADMIN, `/vehicles/${vehicleId}/image`)).bytes.equals(old), true);
  // new url: stored as a BLOB, the text column cleared
  cloud.info.compositeRenders[0].layers[0].url = 'https://ip-xyz.azureedge.net/renders/new.png';
  await asAdmin(host, 'POST', `/accounts/${accountId}/sync`);
  const row = (await host.gc.db.get('SELECT image IS NOT NULL AS blob, image_b64, image_url FROM vehicles WHERE id = ?', [vehicleId])).row;
  assert.deepEqual(row, { blob: 1, image_b64: null, image_url: 'https://ip-xyz.azureedge.net/renders/new.png' });
  assert.equal((await fetchImage(host, ADMIN, `/vehicles/${vehicleId}/image`)).bytes.equals(PNG), true);
}));

test('sync: a vehicle without a stored image fetches it again even if the url did not change (images skipped by 1.0.0)', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId } = await connected(host, cloud);
  // 1.0.0 skipped renders over 700 KB: url known, no image
  await host.gc.db.run('UPDATE vehicles SET image = NULL, image_b64 = NULL, image_url = ? WHERE id = ?', [RENDER, vehicleId]);
  assert.equal((await asAdmin(host, 'GET', '/')).json.vehicles[0].has_image, false);
  cloud.render = bigPng(3 * MB);
  const before = cloud.calls.length;
  await asAdmin(host, 'POST', `/accounts/${accountId}/sync`);
  assert.equal(cloud.calls.slice(before).filter((c) => c.url === RENDER).length, 1);
  assert.equal((await asAdmin(host, 'GET', '/')).json.vehicles[0].has_image, true);
  assert.equal((await fetchImage(host, ADMIN, `/vehicles/${vehicleId}/image`)).bytes.equals(cloud.render), true);
}));

test('renders: up to 4 MB stored, a larger one skipped with a warning (sync goes on, fetched again on the next sync)', () => withHost({}, async (host, cloud) => {
  assert.equal(MAX_IMAGE_BYTES, 4 * MB);
  cloud.render = bigPng(4 * MB);
  const { accountId, vehicleId } = await connected(host, cloud);
  const got = await fetchImage(host, ADMIN, `/vehicles/${vehicleId}/image`);
  assert.equal(got.bytes.equals(cloud.render), true);
  assert.equal(got.parts, Math.ceil((4 * MB) / store.IMAGE_PART_BYTES));
  // a bigger render under a new url: skipped, the sync still succeeds
  cloud.render = bigPng(4 * MB + 1);
  cloud.info.compositeRenders[0].layers[0].url = 'https://iprenders.blob.core.windows.net/renders/huge.png';
  const s = await asAdmin(host, 'POST', `/accounts/${accountId}/sync`);
  assert.equal(s.json.result.ok, true);
  assert.ok(host.logs.some((l) => /vehicle render too large, skipped/.test(l.message)));
  assert.equal((await fetchImage(host, ADMIN, `/vehicles/${vehicleId}/image`)).parts, got.parts, 'the stored image stays');
  await asAdmin(host, 'POST', `/accounts/${accountId}/sync`);
  assert.equal(cloud.calls.filter((c) => c.url.endsWith('/huge.png')).length, 2, 'tried again on the next sync');
}));

test('import of the built-in data: a render over 1 MB is stored as a BLOB and served; one over 4 MB is dropped', () => withHost({}, async (host, cloud) => {
  const big = bigPng(1.5 * MB); // 2 MB of base64: more than one string parameter may hold
  const huge = bigPng(4 * MB + 3);
  const out = await host.legacyImport({
    schema: 1, dataset: 'skoda',
    accounts: [{ id: 3, email: 'ada@example.com', password: 'pw-secret-1', session: null, status: 'ok' }],
    vehicles: [
      { id: 7, account_id: 3, vin: VIN, name: 'Elroq', model: 'Elroq 85', state: { soc: 50 }, image: big.toString('base64'), image_url: RENDER },
      { id: 8, account_id: 3, vin: 'TMBTESTVIN000002', name: 'Enyaq', state: null, image: huge.toString('base64'), image_url: 'https://iprenders.blob.core.windows.net/renders/huge.png' },
    ],
    owners: [{ vehicle_id: 7, user_id: ADA.id }],
  });
  assert.deepEqual(out, { ok: true, counts: { accounts: 1, vehicles: 2, owners: 1 } });
  const st = (await asAdmin(host, 'GET', '/')).json;
  assert.deepEqual(st.vehicles.map((v) => [v.id, v.has_image]), [[7, true], [8, false]]);
  assert.deepEqual(st.vehicles[0].state, { soc: 50 });
  const row = (await host.gc.db.get('SELECT image IS NOT NULL AS blob, image_b64, image_type, image_url FROM vehicles WHERE id = 7')).row;
  assert.deepEqual(row, { blob: 1, image_b64: null, image_type: 'image/png', image_url: RENDER });
  assert.equal((await host.gc.db.get('SELECT image_url FROM vehicles WHERE id = 8')).row.image_url, null);
  assert.equal((await fetchImage(host, ADMIN, '/vehicles/7/image')).bytes.equals(big), true);
  assert.equal((await fetchImage(host, portalUser(ADA), '/portal/vehicles/7/image')).bytes.equals(big), true);
  // the dropped one comes back with the next sync (url unchanged)
  cloud.garage.vehicles.push({ vin: 'TMBTESTVIN000002', name: 'Enyaq', specification: { model: 'Enyaq' } });
  assert.equal((await asAdmin(host, 'POST', '/accounts/3/sync')).json.result.ok, true);
  assert.deepEqual((await asAdmin(host, 'GET', '/')).json.vehicles.map((v) => [v.id, v.has_image]), [[7, true], [8, true]]);
}));
