'use strict';

// Shared vaults: members and roles, a push to who gets one, leaving and removing (needsRekey, at least one manager),
// the key change in steps (rekey/start → entries with the new key → rekey/finish), the personal vault never shared.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, kiosk, fake, ANNA, MARC, LENA, OMA, WALL } = require('./helpers');

async function family(c) {
  const anna = await c.setup(ANNA);
  await c.setup(MARC);
  await c.setup(LENA);
  const fam = fake.id();
  const created = (await c.as(ANNA)('POST', 'vaults', { id: fam, nameEnc: fake.name(), sealedKey: fake.sealed() })).json.vault;
  assert.deepEqual([created.kind, created.role, created.keyRev], ['shared', 'manage', 1]);
  const marcKey = fake.sealed();
  await c.as(ANNA)('POST', `vaults/${fam}/members`, { userId: MARC.id, role: 'write', sealedKey: marcKey });
  await c.as(ANNA)('POST', `vaults/${fam}/members`, { userId: LENA.id, role: 'read', sealedKey: fake.sealed() });
  return { fam, anna, marcKey };
}

test('share: members get the vault with their own sealed key and a push; roles decide who may write', async () => {
  await withHost({}, async (host, c) => {
    const { fam, marcKey } = await family(c);
    const pushes = c.pushes();
    assert.deepEqual(pushes.map((p) => [p.topic, p.users[0]]), [['share', MARC.id], ['share', LENA.id]]);
    assert.match(pushes[0].body, /Anna/);
    assert.doesNotMatch(JSON.stringify(pushes), /nameEnc|sealed/i, 'no key material in pushes');
    const mv = (await c.as(MARC)('GET', 'sync')).json.vaults.find((v) => v.id === fam);
    assert.deepEqual([mv.role, mv.sealedKey], ['write', marcKey]);
    assert.deepEqual(mv.members.map((m) => [m.name, m.role]), [['Anna', 'manage'], ['Marc', 'write'], ['Lena', 'read']]);
    const it = await c.item(MARC, fam, 1);
    assert.equal(it.ok, true);
    assert.equal((await c.item(LENA, fam, 1)).code, 'forbidden', 'read only');
    assert.equal((await c.item(LENA, fam, 1, { id: it.id, baseRev: 1 })).code, 'forbidden');
    assert.equal((await c.as(LENA)('POST', `items/${it.id}/trash`)).json.code, 'forbidden');
    assert.equal((await c.as(LENA)('GET', 'sync')).json.items.filter((x) => x.id === it.id).length, 1, 'but can read');
    assert.equal((await c.as(LENA)('GET', `items/${it.id}/history`)).status, 200);
    // only a manager manages
    assert.equal((await c.as(MARC)('POST', `vaults/${fam}/members`, { userId: OMA.id, role: 'read', sealedKey: fake.sealed() })).json.code, 'forbidden');
    assert.equal((await c.as(MARC)('PUT', `vaults/${fam}`, { nameEnc: fake.name() })).json.code, 'forbidden');
    assert.equal((await c.as(MARC)('DELETE', `vaults/${fam}`)).json.code, 'forbidden');
  });
});

test('share: only with people who set up Vault, never a kiosk device, never twice, never the personal vault', async () => {
  await withHost({}, async (host, c) => {
    const { fam, anna } = await family(c);
    await c.call(kiosk(WALL), 'GET', 'account');
    const add = (uid, vault = fam) => c.as(ANNA)('POST', `vaults/${vault}/members`, { userId: uid, role: 'read', sealedKey: fake.sealed() });
    assert.equal((await add(OMA.id)).json.code, 'no_account');
    assert.equal((await add(WALL.id)).json.code, 'not_found');
    assert.equal((await add(99)).json.code, 'not_found');
    assert.equal((await add(MARC.id)).json.code, 'exists');
    await c.setup(OMA);
    assert.equal((await add(OMA.id, anna.personalId)).json.code, 'forbidden', 'the personal vault is never shared');
    assert.equal((await add(OMA.id)).status, 200);
    assert.equal((await c.as(ANNA)('POST', `vaults/${fam}/members`, { userId: OMA.id, role: 'owner', sealedKey: fake.sealed() })).json.code, 'invalid');
    assert.equal((await c.as(ANNA)('DELETE', `vaults/${anna.personalId}`)).json.code, 'forbidden');
  });
});

test('roles and leaving: at least one manager; leaving or removing marks needsRekey; the last one out deletes the vault', async () => {
  await withHost({}, async (host, c) => {
    const { fam } = await family(c);
    assert.equal((await c.as(ANNA)('PUT', `vaults/${fam}/members/${ANNA.id}`, { role: 'write' })).json.code, 'last_manager');
    assert.equal((await c.as(ANNA)('DELETE', `vaults/${fam}/members/${ANNA.id}`)).json.code, 'last_manager');
    assert.equal((await c.as(ANNA)('PUT', `vaults/${fam}/members/${MARC.id}`, { role: 'manage' })).json.vault.members.find((m) => m.userId === MARC.id).role, 'manage');
    // Lena leaves on her own
    assert.equal((await c.as(LENA)('DELETE', `vaults/${fam}/members/${LENA.id}`)).json.vault, null);
    assert.equal((await c.as(LENA)('GET', 'sync')).json.vaults.some((v) => v.id === fam), false);
    const it = await c.item(ANNA, fam, 1);
    assert.equal((await c.as(LENA)('GET', `items/${it.id}/history`)).json.code, 'not_found', 'gone with the membership');
    assert.equal((await c.as(ANNA)('GET', 'sync')).json.vaults.find((v) => v.id === fam).needsRekey, true);
    // a non-manager cannot remove someone else
    await c.as(ANNA)('PUT', `vaults/${fam}/members/${MARC.id}`, { role: 'write' });
    assert.equal((await c.as(MARC)('DELETE', `vaults/${fam}/members/${ANNA.id}`)).json.code, 'forbidden');
    // Anna removes Marc, then leaves as the last member: the vault is gone
    assert.equal((await c.as(ANNA)('DELETE', `vaults/${fam}/members/${MARC.id}`)).json.vault.members.length, 1);
    assert.equal((await c.as(ANNA)('DELETE', `vaults/${fam}/members/${ANNA.id}`)).json.vault, null);
    assert.equal((await c.as(ANNA)('GET', 'sync')).json.vaults.length, 1, 'only the personal vault');
    assert.equal((await c.item(ANNA, fam, 1, { id: it.id, baseRev: 1 })).code, 'not_found');
  });
});

test('key change: start (exactly the members), entries only with the new key, finish once all are re-encrypted', async () => {
  await withHost({}, async (host, c) => {
    const { fam } = await family(c);
    const a = await c.item(ANNA, fam, 1);
    await c.item(ANNA, fam, 1, { id: a.id, baseRev: 1 });
    const b = await c.item(MARC, fam, 1);
    const trashed = await c.item(MARC, fam, 1);
    await c.as(MARC)('POST', `items/${trashed.id}/trash`);
    const gone = await c.item(MARC, fam, 1);
    await c.as(MARC)('DELETE', `items/${gone.id}`);
    await c.as(LENA)('DELETE', `vaults/${fam}/members/${LENA.id}`);
    const keys = [{ userId: ANNA.id, sealedKey: fake.sealed() }, { userId: MARC.id, sealedKey: fake.sealed() }];
    const start = (body, u = ANNA) => c.as(u)('POST', `vaults/${fam}/rekey/start`, body);
    assert.equal((await start({ keyRev: 3, keys })).json.code, 'stale_key', 'the next generation only');
    assert.equal((await start({ keyRev: 2, keys: keys.slice(0, 1) })).json.code, 'invalid', 'every member');
    assert.equal((await start({ keyRev: 2, keys: [...keys, { userId: LENA.id, sealedKey: fake.sealed() }] })).json.code, 'invalid', 'not who left');
    assert.equal((await start({ keyRev: 2, keys }, MARC)).json.code, 'forbidden');
    const v = (await start({ keyRev: 2, keys })).json.vault;
    assert.deepEqual(v.pending, { keyRev: 2, sealedKey: keys[0].sealedKey });
    assert.equal((await c.as(MARC)('GET', 'sync')).json.vaults.find((x) => x.id === fam).pending.sealedKey, keys[1].sealedKey);
    assert.equal((await c.as(ANNA)('POST', `vaults/${fam}/members`, { userId: LENA.id, role: 'read', sealedKey: fake.sealed() })).json.code, 'rekeying');
    // during the change only the new key
    assert.equal((await c.item(MARC, fam, 1)).code, 'stale_key');
    assert.equal((await c.as(ANNA)('POST', `vaults/${fam}/rekey/finish`, { nameEnc: fake.name() })).json.code, 'rekeying');
    assert.equal((await c.item(ANNA, fam, 2, { id: a.id, baseRev: 2 })).ok, true);
    // repeating start is fine until an entry uses the new key — then not any more
    assert.equal((await start({ keyRev: 2, keys })).json.code, 'rekeying');
    const fin = await c.as(ANNA)('POST', `vaults/${fam}/rekey/finish`, { nameEnc: fake.name() });
    assert.deepEqual([fin.json.code, fin.json.left], ['rekeying', 2], 'b and the trashed entry are left; the purged one does not count');
    assert.equal((await c.item(MARC, fam, 2, { id: b.id, baseRev: 1 })).ok, true);
    assert.equal((await c.item(MARC, fam, 2, { id: trashed.id, baseRev: 1 })).ok, true);
    assert.equal((await c.as(ANNA)('PUT', `vaults/${fam}`, { nameEnc: fake.name() })).json.code, 'rekeying', 'finish names it');
    const done = (await c.as(ANNA)('POST', `vaults/${fam}/rekey/finish`, { nameEnc: fake.name() })).json.vault;
    assert.deepEqual([done.keyRev, done.pending, done.needsRekey, done.sealedKey], [2, null, false, keys[0].sealedKey]);
    assert.equal((await c.as(MARC)('GET', 'sync')).json.vaults.find((x) => x.id === fam).sealedKey, keys[1].sealedKey);
    assert.equal((await c.as(ANNA)('GET', `items/${a.id}/history`)).json.history.length, 0, 'the old versions were under the old key');
    assert.equal((await c.as(ANNA)('GET', 'sync')).json.items.find((x) => x.id === trashed.id).state, 'trash', 're-encrypting keeps the trash');
    assert.equal((await c.item(ANNA, fam, 1)).code, 'stale_key');
    assert.equal((await c.item(ANNA, fam, 2)).ok, true);
    assert.equal((await c.as(ANNA)('POST', `vaults/${fam}/members`, { userId: LENA.id, role: 'read', sealedKey: fake.sealed() })).status, 200);
  });
});

test('a shared vault: rename (manage), delete with all entries; limits', async () => {
  await withHost({}, async (host, c) => {
    const { fam } = await family(c);
    const it = await c.item(MARC, fam, 1);
    const name = fake.name();
    assert.equal((await c.as(ANNA)('PUT', `vaults/${fam}`, { nameEnc: name })).json.vault.nameEnc, name);
    assert.equal((await c.as(ANNA)('DELETE', `vaults/${fam}`)).json.removed, fam);
    assert.equal((await c.as(MARC)('GET', 'sync')).json.vaults.some((v) => v.id === fam), false);
    assert.equal((await c.item(MARC, fam, 1, { id: it.id, baseRev: 1 })).code, 'not_found');
    assert.equal((await c.as(ANNA)('POST', 'vaults', { id: fam, nameEnc: fake.name(), sealedKey: fake.sealed() })).status, 200, 'the id is free again');
    assert.equal((await c.as(OMA)('POST', 'vaults', { id: fake.id(), nameEnc: fake.name(), sealedKey: fake.sealed() })).json.code, 'no_account');
    for (let i = 1; i < 20; i++) await c.as(ANNA)('POST', 'vaults', { id: fake.id(), nameEnc: fake.name(), sealedKey: fake.sealed() });
    assert.equal((await c.as(ANNA)('POST', 'vaults', { id: fake.id(), nameEnc: fake.name(), sealedKey: fake.sealed() })).json.code, 'limit');
  });
});

test('key change and leaving: nobody leaves during a change; an account deleted during one → change again afterwards', async () => {
  await withHost({}, async (host, c) => {
    const { fam } = await family(c);
    await c.as(LENA)('DELETE', `vaults/${fam}/members/${LENA.id}`);
    const keys = [{ userId: ANNA.id, sealedKey: fake.sealed() }, { userId: MARC.id, sealedKey: fake.sealed() }];
    await c.as(ANNA)('POST', `vaults/${fam}/rekey/start`, { keyRev: 2, keys });
    assert.equal((await c.as(MARC)('DELETE', `vaults/${fam}/members/${MARC.id}`)).json.code, 'rekeying');
    assert.equal((await c.as(ANNA)('DELETE', `vaults/${fam}/members/${MARC.id}`)).json.code, 'rekeying');
    await c.as(MARC)('POST', 'account/delete', { confirm: 'DELETE' });
    const done = (await c.as(ANNA)('POST', `vaults/${fam}/rekey/finish`, { nameEnc: fake.name() })).json.vault;
    assert.deepEqual([done.keyRev, done.needsRekey, done.members.length], [2, true, 1], 'Marc knew the new key');
    // the next change clears it
    await c.as(ANNA)('POST', `vaults/${fam}/rekey/start`, { keyRev: 3, keys: [{ userId: ANNA.id, sealedKey: fake.sealed() }] });
    assert.equal((await c.as(ANNA)('POST', `vaults/${fam}/rekey/finish`, { nameEnc: fake.name() })).json.vault.needsRekey, false);
  });
});

