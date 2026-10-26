'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, OMA, BOB, DAY } = require('./helpers');

test('seats: kinds and limits of the licence; people already on stay on when it shrinks', async () => {
  await withHost({ license: { tier: 'family', seats: { included: 2, family: 1 } }, seats: {} }, async (host, c) => {
    assert.equal((await c.admin('PUT', `admin/seats/${ANNA.id}`, { kind: 'family' })).status, 200);
    assert.equal((await c.admin('PUT', `admin/seats/${MARC.id}`, { kind: 'family' })).status, 200);
    const biz = await c.admin('PUT', `admin/seats/${BOB.id}`, { kind: 'business' });
    assert.equal(biz.status, 409);
    assert.equal(biz.json.code, 'seat_kind');
    const r = await c.admin('PUT', `admin/seats/${LENA.id}`, { kind: 'family' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.summary.counts, { family: 3, business: 0, total: 3 });
    const full = await c.admin('PUT', `admin/seats/${OMA.id}`, { kind: 'family' });
    assert.equal(full.status, 409);
    assert.equal(full.json.code, 'seat_limit');
    // the same person again: no change, no limit
    assert.equal((await c.admin('PUT', `admin/seats/${LENA.id}`, { kind: 'family' })).status, 200);
    // more people booked: refresh
    host.license.seats = { included: 2, family: 2 };
    const ref = await c.admin('POST', 'admin/license/refresh');
    assert.equal(ref.status, 200);
    assert.equal(host.licenseRefreshes.length, 1);
    assert.equal(ref.json.summary.limits.family, 4);
    assert.equal((await c.admin('PUT', `admin/seats/${OMA.id}`, { kind: 'family' })).status, 200);
    // fewer seats: everybody keeps working, the overview says exceeded
    host.license.seats = { included: 2, family: 0 };
    const o = await c.admin('GET', 'admin/overview');
    assert.equal(o.json.overview.exceeded, true);
    assert.equal((await c.as(OMA)('GET', 'areas')).status, 200);
    // switched off: GET me says so, the files stay
    const mine = await c.area(MARC, 'mine');
    await c.put(MARC, mine.rootId, 'a.txt', 'x');
    assert.equal((await c.admin('PUT', `admin/seats/${MARC.id}`, { kind: null })).status, 200);
    assert.equal((await c.as(MARC)('GET', 'me')).json.me.seat, null);
    assert.equal((await c.as(MARC)('GET', `nodes/${mine.rootId}`)).json.code, 'no_seat');
    assert.equal((await c.admin('PUT', `admin/seats/${MARC.id}`, { kind: 'family' })).status, 409); // full again
    // bad input
    assert.equal((await c.admin('PUT', 'admin/seats/999', { kind: 'family' })).status, 400);
    assert.equal((await c.admin('PUT', `admin/seats/${OMA.id}`, { kind: 'gold' })).status, 400);
  });
});

test('a licence without tier (lifetime, an older licence server): no limit', async () => {
  await withHost({ license: { tier: null }, seats: {} }, async (host, c) => {
    for (const u of [ANNA, MARC, LENA, OMA]) assert.equal((await c.admin('PUT', `admin/seats/${u.id}`, { kind: 'family' })).status, 200);
    assert.equal((await c.admin('PUT', `admin/seats/${BOB.id}`, { kind: 'business' })).status, 200);
    const o = await c.admin('GET', 'admin/overview');
    assert.equal(o.json.overview.limits.total, null);
    assert.equal(o.json.overview.exceeded, false);
  });
});

test('no valid licence: not_licensed, GET me still answers', async () => {
  await withHost({}, async (host, c) => {
    host.license.licensed = false;
    host.license.state = 'expired';
    const me = await c.as(ANNA)('GET', 'me');
    assert.equal(me.status, 200);
    assert.equal(me.json.licence.valid, false);
    assert.deepEqual(me.json.areas, []);
    const r = await c.as(ANNA)('GET', 'areas');
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'not_licensed');
    assert.equal((await c.admin('PUT', `admin/seats/${OMA.id}`, { kind: 'family' })).json.code, 'seat_kind');
  });
});

test('background: the trash and old versions go after their days', async () => {
  await withHost({ settings: { trash_days: 7, versions_days: 3 } }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const keep = await c.put(ANNA, mine.rootId, 'Notiz.txt', 'v1');
    await c.put(ANNA, mine.rootId, 'Notiz.txt', 'v2', { baseRev: 1 });
    const gone = await c.put(ANNA, mine.rootId, 'Weg.txt', 'x');
    await a('DELETE', `nodes/${gone.json.node.id}`);
    c.clock.add(2 * DAY);
    let t = await host.tick();
    assert.deepEqual([t.purged, t.versions], [0, 0]);
    c.clock.add(2 * DAY);
    t = await host.tick();
    assert.deepEqual([t.purged, t.versions], [0, 1]);
    assert.equal((await a('GET', `nodes/${keep.json.node.id}/versions`)).json.versions.length, 0);
    c.clock.add(4 * DAY);
    t = await host.tick();
    assert.equal(t.purged, 1);
    assert.equal((await a('GET', 'trash')).json.items.length, 0);
    // the live file stays
    assert.equal((await a('GET', `nodes/${keep.json.node.id}`)).status, 200);
  });
});
