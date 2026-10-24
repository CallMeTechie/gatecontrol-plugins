'use strict';

// Emergency access: naming a trusted person, the request with its waiting time (push to the grantor), refusing,
// allowing early, the background release after the waiting time, read-only access only while granted; the admin page.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, fake, ADMIN, ANNA, MARC, LENA, OMA, HOUR } = require('./helpers');

async function trusted(c, waitHours = 48) {
  const anna = await c.setup(ANNA);
  await c.setup(MARC);
  const sealedKey = fake.sealed();
  const e = (await c.as(ANNA)('POST', 'emergency', { granteeId: MARC.id, waitHours, sealedKey })).json.emergency;
  return { anna, e, sealedKey };
}

test('naming a trusted person: someone with Vault, not oneself, sizes; renewing while ready; both sides see it', async () => {
  await withHost({}, async (host, c) => {
    const { e } = await trusted(c);
    assert.deepEqual([e.status, e.waitHours, e.grantee.name, e.grantor.name], ['ready', 48, 'Marc', 'Anna']);
    const post = (b) => c.as(ANNA)('POST', 'emergency', b);
    assert.equal((await post({ granteeId: OMA.id, waitHours: 48, sealedKey: fake.sealed() })).json.code, 'no_account');
    assert.equal((await post({ granteeId: ANNA.id, waitHours: 48, sealedKey: fake.sealed() })).json.code, 'invalid');
    assert.equal((await post({ granteeId: MARC.id, waitHours: 0, sealedKey: fake.sealed() })).json.code, 'invalid');
    assert.equal((await post({ granteeId: MARC.id, waitHours: 721, sealedKey: fake.sealed() })).json.code, 'invalid');
    assert.equal((await post({ granteeId: MARC.id, waitHours: 24, sealedKey: 'x' })).json.code, 'invalid');
    const again = (await post({ granteeId: MARC.id, waitHours: 24, sealedKey: fake.sealed() })).json.emergency;
    assert.deepEqual([again.id, again.waitHours], [e.id, 24], 'renewed, not a second one');
    assert.deepEqual((await c.as(ANNA)('GET', 'emergency')).json.granted.map((x) => x.id), [e.id]);
    assert.deepEqual((await c.as(MARC)('GET', 'emergency')).json.received.map((x) => x.id), [e.id]);
    assert.deepEqual((await c.as(LENA)('GET', 'emergency')).json, { ok: true, granted: [], received: [] });
    // nobody else can act on it
    for (const p of ['request', 'deny', 'approve']) assert.equal((await c.as(LENA)('POST', `emergency/${e.id}/${p}`)).json.code, 'not_found', p);
    assert.equal((await c.as(LENA)('DELETE', `emergency/${e.id}`)).json.code, 'not_found');
    assert.equal((await c.as(MARC)('GET', 'emergency/not-an-id/access')).json.code, 'not_found');
  });
});

test('request → push to the grantor; refuse → push to the trusted person; no access in between', async () => {
  await withHost({}, async (host, c) => {
    const { e } = await trusted(c);
    assert.equal((await c.as(ANNA)('POST', `emergency/${e.id}/request`)).json.code, 'not_found', 'only the trusted person asks');
    const r = (await c.as(MARC)('POST', `emergency/${e.id}/request`)).json.emergency;
    assert.equal(r.status, 'requested');
    assert.equal(Date.parse(r.releaseAt) - Date.parse(r.requestedAt), 48 * HOUR);
    assert.equal((await c.as(MARC)('POST', `emergency/${e.id}/request`)).json.code, 'conflict');
    const p = c.pushes();
    assert.deepEqual([p.length, p[0].topic, p[0].users[0]], [1, 'emergency', ANNA.id]);
    assert.match(p[0].body, /Marc.*48 Stunden/);
    assert.equal((await c.as(MARC)('GET', `emergency/${e.id}/access`)).json.code, 'not_found');
    assert.equal((await c.as(ANNA)('POST', 'emergency', { granteeId: MARC.id, waitHours: 1, sealedKey: fake.sealed() })).json.code, 'conflict', 'no renewing during a request');
    assert.equal((await c.as(ANNA)('POST', `emergency/${e.id}/deny`)).json.emergency.status, 'ready');
    assert.deepEqual(c.pushes().slice(1).map((x) => [x.users[0], x.title]), [[MARC.id, 'Notfallzugriff abgelehnt']]);
    assert.equal((await c.as(ANNA)('POST', `emergency/${e.id}/deny`)).json.code, 'conflict');
  });
});

test('the waiting time passes → granted (background, both told); read-only access to all the grantor\'s vaults', async () => {
  await withHost({}, async (host, c) => {
    const { anna, e, sealedKey } = await trusted(c, 24);
    const fam = fake.id();
    await c.as(ANNA)('POST', 'vaults', { id: fam, nameEnc: fake.name(), sealedKey: fake.sealed() });
    const i1 = await c.item(ANNA, anna.personalId, 1);
    const i2 = await c.item(ANNA, fam, 1);
    const tr = await c.item(ANNA, anna.personalId, 1);
    await c.as(ANNA)('POST', `items/${tr.id}/trash`);
    await c.as(MARC)('POST', `emergency/${e.id}/request`);
    c.clock.add(23 * HOUR);
    assert.equal((await host.tick()).released, 0);
    c.clock.add(HOUR);
    assert.equal((await host.tick()).released, 1);
    const pushes = c.pushes().filter((p) => p.title === 'Notfallzugriff freigegeben');
    assert.deepEqual(pushes.map((p) => p.users[0]).sort(), [ANNA.id, MARC.id].sort());
    const acc = (await c.as(MARC)('GET', `emergency/${e.id}/access`)).json;
    const a = (await c.as(ANNA)('GET', 'account')).json.account;
    assert.equal(acc.sealedKey, sealedKey);
    assert.deepEqual([acc.grantor.publicKey, acc.grantor.privateKeyEnc], [a.publicKey, a.privateKeyEnc]);
    assert.deepEqual(acc.vaults.map((v) => v.id).sort(), [anna.personalId, fam].sort());
    const its = (await c.as(MARC)('GET', `emergency/${e.id}/items`)).json;
    assert.deepEqual(its.items.map((x) => x.id).sort(), [i1.id, i2.id, tr.id].sort(), 'trash too, nothing purged');
    // read-only: Marc's own key material is not in those vaults
    assert.equal((await c.item(MARC, anna.personalId, 1)).code, 'not_found');
    // Anna takes it back
    await c.as(ANNA)('POST', `emergency/${e.id}/deny`);
    assert.equal((await c.as(MARC)('GET', `emergency/${e.id}/access`)).json.code, 'not_found');
  });
});

test('allow early; withdraw / decline; an account deleted takes its grants along', async () => {
  await withHost({}, async (host, c) => {
    const { e } = await trusted(c, 720);
    assert.equal((await c.as(ANNA)('POST', `emergency/${e.id}/approve`)).json.code, 'conflict', 'nothing requested');
    await c.as(MARC)('POST', `emergency/${e.id}/request`);
    assert.equal((await c.as(MARC)('POST', `emergency/${e.id}/approve`)).json.code, 'not_found', 'not the trusted person');
    assert.equal((await c.as(ANNA)('POST', `emergency/${e.id}/approve`)).json.emergency.status, 'granted');
    assert.equal((await c.as(MARC)('GET', `emergency/${e.id}/access`)).status, 200);
    assert.equal((await c.as(MARC)('DELETE', `emergency/${e.id}`)).json.removed, e.id, 'the trusted person can decline');
    assert.equal((await c.as(ANNA)('GET', 'emergency')).json.granted.length, 0);
    const again = (await c.as(ANNA)('POST', 'emergency', { granteeId: MARC.id, waitHours: 12, sealedKey: fake.sealed() })).json.emergency;
    await c.as(MARC)('POST', 'account/delete', { confirm: 'DELETE' });
    assert.equal((await c.as(ANNA)('GET', 'emergency')).json.granted.length, 0);
    assert.equal((await c.as(ANNA)('DELETE', `emergency/${again.id}`)).json.code, 'not_found');
  });
});

test('admin page: administrators only, counts and names — never key material or entries', async () => {
  await withHost({}, async (host, c) => {
    const { anna } = await trusted(c);
    await c.item(ANNA, anna.personalId, 1);
    const r = await host.request({ method: 'GET', path: 'admin/overview', user: ADMIN });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.counts, { accounts: 2, sharedVaults: 0, items: 1, trash: 0, emergency: 1, emergencyOpen: 0, wifiShares: { wall: 0, portal: 0 } });
    assert.deepEqual(r.json.accounts.map((a) => a.name), ['Anna', 'Marc']);
    const text = JSON.stringify(r.json);
    const acc = (await c.as(ANNA)('GET', 'account')).json.account;
    for (const secret of [acc.userKeyPw, acc.privateKeyEnc, acc.publicKey]) assert.equal(text.includes(secret), false);
    assert.equal((await host.request({ method: 'GET', path: 'admin/overview', user: { ...ANNA, role: 'user' } })).status, 403);
    assert.equal((await host.request({ method: 'GET', path: 'admin/overview', user: { ...ADMIN, portal: true, loggedIn: true } })).status, 403);
    const html = (await host.render({ page: 'overview', lang: 'de' })).html;
    assert.match(html, /Ende-zu-Ende verschlüsselt/);
    assert.doesNotMatch(html, /\{\{t:/);
  });
});
