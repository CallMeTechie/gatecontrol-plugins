'use strict';

// Who may use Vault, setting it up (keys + personal vault), a new master password / a recovery (compare-and-swap),
// deleting the account, the people directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, kiosk, fake, KDF, setupBody, ADMIN, ANNA, MARC, LENA, OMA, WALL } = require('./helpers');

test('who may use Vault: app and signed-in portal users — no kiosk device, no admin UI, no signed-out portal', async () => {
  await withHost({}, async (host, c) => {
    assert.equal((await c.as(ANNA)('GET', 'account')).json.account, null);
    assert.equal((await c.portal(ANNA)('GET', 'account')).status, 200);
    assert.equal((await c.portal(ANNA)('GET', 'portal/account')).status, 200, 'the same routes under portal/…');
    const out = await c.portal(ANNA, false)('GET', 'account');
    assert.deepEqual([out.status, out.json.code], [403, 'login_required']);
    assert.equal((await c.call(kiosk(WALL), 'GET', 'account')).json.code, 'forbidden');
    assert.equal((await c.call(ADMIN, 'GET', 'account')).json.code, 'forbidden', 'the admin UI is no person');
    assert.equal((await c.call({ id: 99, name: 'x', portal: true, loggedIn: true, app: true }, 'GET', 'account')).json.code, 'forbidden', 'not an account of GateControl');
    // once seen as a kiosk device, never a person (not even through the app)
    assert.equal((await c.as(WALL)('GET', 'account')).json.code, 'forbidden');
    assert.equal((await c.as(ANNA)('GET', 'nothing')).status, 404);
  });
});

test('set up: the account and the personal vault in one step; again → exists; nothing else before', async () => {
  await withHost({}, async (host, c) => {
    for (const p of ['sync', 'people', 'emergency']) {
      const r = await c.as(ANNA)('GET', p);
      if (p === 'emergency') continue; // the list is empty without an account
      assert.deepEqual([r.status, r.json.code], [404, 'no_account'], p);
    }
    const { body, personalId } = await c.setup(ANNA);
    const a = (await c.as(ANNA)('GET', 'account')).json.account;
    assert.deepEqual(a.kdf, body.kdf);
    assert.equal(a.userKeyPw, body.userKeyPw);
    assert.equal(a.userKeyRk, body.userKeyRk);
    assert.equal(a.publicKey, body.publicKey);
    assert.equal(a.privateKeyEnc, body.privateKeyEnc);
    assert.equal(a.rev, 1);
    const s = (await c.as(ANNA)('GET', 'sync')).json;
    assert.equal(s.vaults.length, 1);
    assert.deepEqual([s.vaults[0].id, s.vaults[0].kind, s.vaults[0].role, s.vaults[0].sealedKey, s.vaults[0].nameEnc, s.vaults[0].keyRev],
      [personalId, 'personal', 'manage', body.personal.sealedKey, body.personal.nameEnc, 1]);
    const again = await c.as(ANNA)('POST', 'account', setupBody());
    assert.deepEqual([again.status, again.json.code], [409, 'exists']);
    // the same vault id for someone else → exists
    const clash = setupBody();
    clash.personal.id = personalId;
    assert.equal((await c.as(MARC)('POST', 'account', clash)).json.code, 'exists');
    assert.equal((await c.as(MARC)('GET', 'account')).json.account, null, 'nothing half created');
  });
});

test('set up: only well-formed key material (sizes, base64url, Argon2id bounds)', async () => {
  await withHost({}, async (host, c) => {
    const bad = [
      (b) => { b.kdf.alg = 'pbkdf2'; },
      (b) => { b.kdf.m = 1024; },
      (b) => { b.kdf.t = 1; },
      (b) => { b.kdf.p = 0; },
      (b) => { b.kdf.p = 2; },
      (b) => { b.kdf.salt = fake.salt().slice(0, 10); },
      (b) => { b.publicKey = fake.wrapped(); },
      (b) => { b.userKeyPw = 'not base64!'; },
      (b) => { b.userKeyRk = 'AAAA'; },
      (b) => { b.privateKeyEnc = null; },
      (b) => { b.personal.id = 'short'; },
      (b) => { b.personal.id = '../../etc/passwd/xxxxxxxx'; },
      (b) => { b.personal.sealedKey = fake.publicKey(); },
      (b) => { b.personal.nameEnc = 'x'.repeat(2000); },
      (b) => { delete b.personal; },
    ];
    for (const [i, f] of bad.entries()) {
      const b = setupBody();
      f(b);
      const r = await c.as(ANNA)('POST', 'account', b);
      assert.deepEqual([r.status, r.json.code], [400, 'invalid'], `case ${i}`);
    }
    assert.equal((await c.as(ANNA)('GET', 'account')).json.account, null);
  });
});

test('a new master password / a recovery: compare-and-swap on rev; the recovery key only when sent', async () => {
  await withHost({}, async (host, c) => {
    const { body } = await c.setup(ANNA);
    const pw = { rev: 1, kdf: KDF(), userKeyPw: fake.wrapped() };
    const r1 = (await c.as(ANNA)('PUT', 'account', pw)).json.account;
    assert.deepEqual([r1.rev, r1.userKeyPw, r1.userKeyRk, r1.kdf.salt], [2, pw.userKeyPw, body.userKeyRk, pw.kdf.salt]);
    // a second device with the old state: conflict with the current account
    const stale = await c.as(ANNA)('PUT', 'account', { rev: 1, kdf: KDF(), userKeyPw: fake.wrapped() });
    assert.deepEqual([stale.status, stale.json.code, stale.json.account.rev], [409, 'conflict', 2]);
    // recovery: new password and new recovery key
    const rec = { rev: 2, kdf: KDF(), userKeyPw: fake.wrapped(), userKeyRk: fake.wrapped() };
    const r2 = (await c.as(ANNA)('PUT', 'account', rec)).json.account;
    assert.deepEqual([r2.rev, r2.userKeyRk], [3, rec.userKeyRk]);
    assert.equal((await c.as(ANNA)('PUT', 'account', { rev: 3, kdf: KDF(), userKeyPw: 'x' })).json.code, 'invalid');
    assert.equal((await c.as(MARC)('PUT', 'account', pw)).json.code, 'no_account');
    // the sync sends the account again once it changed
    const since = (await c.as(ANNA)('GET', 'sync')).json.seq;
    assert.equal((await c.as(ANNA)('GET', 'sync', null, { since })).json.account, null);
    await c.as(ANNA)('PUT', 'account', { rev: 3, kdf: KDF(), userKeyPw: fake.wrapped() });
    assert.equal((await c.as(ANNA)('GET', 'sync', null, { since })).json.account.rev, 4);
  });
});

test('the people directory: everyone but oneself and kiosk devices, a public key once they set up Vault', async () => {
  await withHost({}, async (host, c) => {
    await c.call(kiosk(WALL), 'GET', 'account');
    const { body } = await c.setup(MARC);
    await c.setup(ANNA);
    const list = (await c.as(ANNA)('GET', 'people')).json.people;
    assert.deepEqual(list.map((p) => p.id).sort(), [ADMIN.id, MARC.id, LENA.id, OMA.id].sort());
    assert.equal(list.find((p) => p.id === MARC.id).publicKey, body.publicKey);
    assert.equal(list.find((p) => p.id === OMA.id).publicKey, null);
  });
});

test('deleting the account: confirm required; personal vault and memberships go, a shared vault keeps a manager', async () => {
  await withHost({}, async (host, c) => {
    const anna = await c.setup(ANNA);
    await c.setup(MARC);
    await c.setup(LENA);
    const fam = fake.id();
    await c.as(ANNA)('POST', 'vaults', { id: fam, nameEnc: fake.name(), sealedKey: fake.sealed() });
    await c.as(ANNA)('POST', `vaults/${fam}/members`, { userId: MARC.id, role: 'write', sealedKey: fake.sealed() });
    await c.as(ANNA)('POST', `vaults/${fam}/members`, { userId: LENA.id, role: 'read', sealedKey: fake.sealed() });
    const solo = fake.id();
    await c.as(ANNA)('POST', 'vaults', { id: solo, nameEnc: fake.name(), sealedKey: fake.sealed() });
    await c.item(ANNA, anna.personalId, 1);
    await c.item(ANNA, fam, 1);
    assert.equal((await c.as(ANNA)('POST', 'account/delete', {})).json.code, 'invalid');
    assert.equal((await c.as(ANNA)('POST', 'account/delete', { confirm: 'DELETE' })).json.account, null);
    assert.equal((await c.as(ANNA)('GET', 'account')).json.account, null);
    const m = (await c.as(MARC)('GET', 'sync')).json;
    const v = m.vaults.find((x) => x.id === fam);
    assert.deepEqual(v.members.map((x) => [x.userId, x.role]), [[MARC.id, 'manage'], [LENA.id, 'read']], 'the longest-standing member manages it');
    assert.equal(v.needsRekey, true, 'Anna knew the key');
    assert.equal(m.items.filter((i) => i.vaultId === fam).length, 1, 'the shared entries stay');
    // the vault Anna was alone in and her personal vault are gone
    const ov = (await host.request({ method: 'GET', path: 'admin/overview', user: ADMIN })).json;
    assert.deepEqual([ov.counts.accounts, ov.counts.sharedVaults, ov.counts.items], [2, 1, 1]);
    // set up again: a fresh account
    await c.setup(ANNA);
    assert.equal((await c.as(ANNA)('GET', 'sync')).json.vaults.length, 1);
  });
});
