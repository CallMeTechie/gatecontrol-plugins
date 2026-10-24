'use strict';

// The portal tab's end-to-end encryption (ui/crypto.js on the noble libraries in ui/vendor/noble.js) against EVERY
// fixed vector the apps check (test/fixtures/vault-vectors.json, a copy of gatecontrol-client-core's), a sealed box
// libsodium opened (fixtures/portal-seal.json), and the flows: seal, emergency access, a new password, a recovery.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadUi } = require('./load-ui');
const V = require('./fixtures/vault-vectors.json');
const SEAL = require('./fixtures/portal-seal.json');

const { VC, N } = loadUi();
const hex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const toHex = (b) => Buffer.from(b).toString('hex');
const unb64 = (s) => Buffer.from(s, 'base64url');
const KDF = () => ({ ...VC.newKdf(), m: 19456, t: 2 }); // the server's minimum: fast tests
const code = (c) => (e) => e && e.code === c;

test('vectors: master key (Argon2id), also from the same password in NFD', async () => {
  const m = V.masterKey;
  assert.equal(toHex(await VC.masterKey(m.password, m.kdf)), m.key);
  assert.notEqual(m.passwordNfd, m.password);
  assert.equal(toHex(await VC.masterKey(m.passwordNfd, m.kdf)), m.key);
  let seen = 0;
  await VC.masterKey(m.password, m.kdf, { onProgress: () => { seen++; } });
  assert.ok(seen > 0, 'progress for the page');
});

test('vectors: wrap, vault name, entry, recovery key, safety number', () => {
  const { wrap, name, item, recoveryKey } = V;
  assert.equal(VC.b64(VC.wrap(hex(wrap.key), hex(wrap.plaintext), wrap.ad, hex(wrap.nonce))), wrap.wrapped);
  assert.equal(toHex(VC.unwrap(hex(wrap.key), wrap.wrapped, wrap.ad)), wrap.plaintext);
  assert.equal(VC.encryptName(hex(name.key), name.vaultId, name.name, hex(name.nonce)), name.nameEnc);
  assert.equal(VC.decryptName(hex(name.key), name.vaultId, name.nameEnc), name.name);
  const at = { vaultId: item.vaultId, itemId: item.itemId, rev: item.rev };
  assert.equal(VC.encryptItemBytes(hex(item.key), at, VC.utf8(item.json), hex(item.nonce)), item.blob);
  assert.equal(VC.encryptItem(hex(item.key), at, JSON.parse(item.json), hex(item.nonce)), item.blob, 'JSON.stringify gives the same bytes');
  assert.deepEqual(VC.decryptItem(hex(item.key), { id: item.itemId, vaultId: item.vaultId, rev: item.rev, blob: item.blob }), JSON.parse(item.json));
  assert.equal(VC.formatRecoveryKey(hex(recoveryKey.key)), recoveryKey.text);
  assert.equal(toHex(VC.parseRecoveryKey(recoveryKey.text)), recoveryKey.key);
  assert.equal(VC.safetyNumber(hex(V.safetyNumber.publicKey)), V.safetyNumber.text);
  assert.equal(VC.safetyNumber(VC.b64(hex(V.safetyNumber.publicKey))), V.safetyNumber.text, 'from base64url too');
});

test('vectors: the seeded key pair, a sealed box from libsodium opens', () => {
  const s = V.sealed;
  const pair = VC.boxKeypair(hex(s.seed));
  assert.deepEqual([toHex(pair.publicKey), toHex(pair.secretKey)], [s.publicKey, s.secretKey]);
  assert.equal(toHex(VC.openSealed(s.sealed, hex(s.publicKey), hex(s.secretKey))), s.key);
  assert.throws(() => VC.openSealed(s.sealed, hex(s.publicKey), VC.randomBytes(32)), code('decrypt'));
});

test('vectors: the whole account body with the fixed random values', async () => {
  const a = V.account;
  const r = a.rnd;
  const rnd = { userKey: hex(r.userKey), recoveryKey: hex(r.recoveryKey), keySeed: hex(r.keySeed), personalId: r.personalId, personalKey: hex(r.personalKey), nonces: r.nonces.map(hex) };
  const acc = await VC.createAccount(a.password, a.personalName, { kdf: a.kdf, rnd });
  const { sealedKey, ...personal } = acc.body.personal;
  assert.deepEqual({ ...acc.body, personal }, a.body);
  assert.equal(acc.recoveryKey, a.recoveryKey);
  assert.equal(toHex(rnd.recoveryKey), r.recoveryKey, 'the caller\'s buffers stay as they were');
  assert.equal(unb64(sealedKey).length, 80);
  assert.equal(toHex(VC.openSealed(sealedKey, acc.keys.publicKey, acc.keys.secretKey)), r.personalKey);
  const keys = await VC.unlock({ ...a.body, rev: 1 }, a.password);
  assert.equal(toHex(keys.userKey), r.userKey);
  assert.equal(toHex(VC.unlockWithRecovery(a.body, a.recoveryKey).userKey), r.userKey);
  await assert.rejects(VC.unlock({ ...a.body, rev: 1 }, a.password + 'x'), code('decrypt'));
});

test('seal: a fixed ephemeral key gives the bytes libsodium opened; random seals open; 80 bytes for a key', () => {
  const eph = VC.boxKeypair(hex(SEAL.ephemeralSeed));
  assert.equal(toHex(eph.publicKey), SEAL.ephemeralPublicKey);
  assert.equal(VC.b64(VC.seal(hex(SEAL.key), hex(SEAL.recipientPublicKey), eph)), SEAL.sealed);
  const s = V.sealed;
  assert.equal(toHex(VC.openSealed(SEAL.sealed, hex(s.publicKey), hex(s.secretKey))), SEAL.key);
  const bob = VC.boxKeypair();
  const key = VC.newVaultKey();
  const a = VC.sealKey(key, bob.publicKey);
  const b = VC.sealKey(key, bob.publicKey);
  assert.notEqual(a, b, 'a fresh ephemeral key each time');
  assert.equal(unb64(a).length, 80);
  assert.deepEqual(VC.openSealed(a, bob.publicKey, bob.secretKey), key);
  const tampered = unb64(a);
  tampered[40] ^= 1;
  assert.throws(() => VC.openSealed(new Uint8Array(tampered), bob.publicKey, bob.secretKey), code('decrypt'));
  assert.throws(() => VC.openSealed(a, bob.publicKey, VC.boxKeypair().secretKey), code('decrypt'));
});

test('an independent check: X25519 of the seeded key pair from OpenSSL, the safety number by hand', () => {
  const sk = crypto.createHash('sha512').update(hex(V.sealed.seed)).digest().subarray(0, 32);
  const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), sk]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  assert.equal(pub.toString('hex'), toHex(VC.boxKeypair(hex(V.sealed.seed)).publicKey));
  const h = crypto.createHash('sha256').update('gcv1:fingerprint:').update(hex(V.safetyNumber.publicKey)).digest();
  const groups = Array.from({ length: 8 }, (_, i) => String(h.readUInt32BE(i * 4) % 100000).padStart(5, '0'));
  assert.equal(VC.safetyNumber(hex(V.safetyNumber.publicKey)), groups.join(' '));
  assert.equal(toHex(N.sha256(VC.utf8('abc'))), crypto.createHash('sha256').update('abc').digest('hex'));
});

test('flows: setup → unlock; wrong password; the server swapping fields is caught', async () => {
  const { body, keys, recoveryKey } = await VC.createAccount('Korrekt Pferd Batterie', 'Persönlich', { kdf: KDF() });
  assert.match(recoveryKey, /^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(unb64(body.userKeyPw).length, 73);
  assert.match(body.personal.id, /^[A-Za-z0-9_-]{22}$/);
  const k = await VC.unlock(body, 'Korrekt Pferd Batterie');
  assert.deepEqual([k.userKey, k.secretKey], [keys.userKey, keys.secretKey]);
  await assert.rejects(VC.unlock(body, 'Korrekt Pferd Batteri'), code('decrypt'));
  await assert.rejects(VC.unlock({ ...body, userKeyPw: body.userKeyRk }, 'Korrekt Pferd Batterie'), code('decrypt'));
  const other = await VC.createAccount('x', 'P', { kdf: KDF() });
  await assert.rejects(VC.unlock({ ...body, publicKey: other.body.publicKey }, 'Korrekt Pferd Batterie'), code('decrypt'));
  assert.equal(VC.decryptName(keys.personalKey, body.personal.id, body.personal.nameEnc), 'Persönlich');
  await assert.rejects(VC.masterKey('pw', { ...KDF(), m: 1024 }), code('invalid'));
  await assert.rejects(VC.masterKey('', KDF()), code('invalid'));
  assert.deepEqual([VC.newKdf().m, VC.newKdf().t, VC.newKdf().p], [65536, 3, 1], 'the apps\' default: 64 MiB, 3 passes');
});

test('flows: a new password keeps the user key; a recovery sets a new password and a new recovery key', async () => {
  const { body, keys, recoveryKey } = await VC.createAccount('alt', 'P', { kdf: KDF() });
  const account = { ...body, rev: 4 };
  const put = await VC.changePassword(account, keys, 'neu', { m: 19456, t: 2 });
  assert.equal(put.rev, 4);
  assert.notEqual(put.kdf.salt, body.kdf.salt);
  assert.equal(put.userKeyRk, undefined);
  assert.deepEqual((await VC.unlock({ ...account, ...put }, 'neu')).userKey, keys.userKey);
  await assert.rejects(VC.unlock({ ...account, ...put }, 'alt'), code('decrypt'));
  const loose = recoveryKey.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
  const k = VC.unlockWithRecovery(account, loose);
  const rec = await VC.recover(account, k, 'ganz neu', { m: 19456, t: 2 });
  assert.notEqual(rec.recoveryKey, recoveryKey);
  const after = { ...account, ...rec.body };
  assert.deepEqual((await VC.unlock(after, 'ganz neu')).userKey, keys.userKey);
  assert.deepEqual(VC.unlockWithRecovery(after, rec.recoveryKey).userKey, keys.userKey);
  assert.throws(() => VC.unlockWithRecovery(after, recoveryKey), code('decrypt'), 'the old recovery key is spent');
  const i = recoveryKey.search(/[A-Z2-9]/);
  const typo = recoveryKey.slice(0, i) + (recoveryKey[i] === 'A' ? 'B' : 'A') + recoveryKey.slice(i + 1);
  assert.throws(() => VC.parseRecoveryKey(typo), code('recovery_key'), 'the check bytes catch a typo');
  assert.throws(() => VC.parseRecoveryKey(recoveryKey.slice(5)), code('recovery_key'));
});

test('flows: emergency access opens the grantor\'s vaults for the trusted person only', async () => {
  const anna = await VC.createAccount('a', 'P', { kdf: KDF() });
  const marc = (await VC.createAccount('m', 'P', { kdf: KDF() })).keys;
  const access = { sealedKey: VC.sealForEmergency(anna.keys, marc.publicKey), grantor: { publicKey: anna.body.publicKey, privateKeyEnc: anna.body.privateKeyEnc } };
  const grantor = VC.openEmergency(access, marc);
  assert.deepEqual(grantor.secretKey, anna.keys.secretKey);
  assert.deepEqual(VC.vaultKeys({ keyRev: 1, sealedKey: anna.body.personal.sealedKey }, grantor)[1], anna.keys.personalKey);
  assert.throws(() => VC.openEmergency(access, anna.keys), code('decrypt'), 'only the trusted person');
});

test('entries: bound to vault, id and revision; padded to 256-byte blocks; 32 KiB at most; garbage → invalid', () => {
  const key = VC.newVaultKey();
  const vaultId = VC.newId();
  const id = VC.newId();
  const entry = { v: 1, type: 'login', title: 'Bank', fields: { username: 'anna', password: 'pa55' } };
  const blob = VC.encryptItem(key, { vaultId, itemId: id, rev: 2 }, entry);
  const item = { id, vaultId, rev: 2, blob };
  assert.deepEqual(VC.decryptItem(key, item), entry);
  for (const moved of [{ rev: 3 }, { rev: 1 }, { vaultId: VC.newId() }, { id: VC.newId() }]) {
    assert.throws(() => VC.decryptItem(key, { ...item, ...moved }), code('decrypt'), JSON.stringify(moved));
  }
  const short = VC.encryptItem(key, { vaultId, itemId: id, rev: 1 }, { v: 1, type: 'note', title: 'a' });
  const longer = VC.encryptItem(key, { vaultId, itemId: id, rev: 1 }, { v: 1, type: 'note', title: 'a'.repeat(150) });
  assert.equal(unb64(short).length, unb64(longer).length);
  assert.equal((unb64(short).length - 41) % 256, 0);
  assert.deepEqual(Array.from(VC.pad(new Uint8Array(256), 256).subarray(256, 258)), [0x80, 0], 'a full block gets one more (sodium_pad)');
  assert.throws(() => VC.encryptItem(key, { vaultId, itemId: id, rev: 1 }, { v: 1, type: 'note', fields: { text: 'x'.repeat(33000) } }), code('too_large'));
  assert.ok(unb64(VC.encryptItem(key, { vaultId, itemId: id, rev: 1 }, { v: 1, type: 'note', fields: { text: 'x'.repeat(32000) } })).length <= 32768);
  for (const bad of [{ v: 2, type: 'note' }, { v: 1, type: 'pdf' }, null]) assert.throws(() => VC.encryptItem(key, { vaultId, itemId: id, rev: 1 }, bad), code('invalid'));
  assert.throws(() => VC.encryptItem(key, { vaultId, itemId: id, rev: 0 }, entry), code('invalid'));
  assert.throws(() => VC.unwrap(VC.newVaultKey(), 'not base64!', 'x'), code('invalid'));
  assert.throws(() => VC.unwrap(VC.newVaultKey(), 'AAAA', 'x'), code('invalid'));
  const w = VC.b64(VC.wrap(VC.newVaultKey(), new Uint8Array(4), 'x'));
  assert.throws(() => VC.unwrap(VC.newVaultKey(), 'Ag' + w.slice(2), 'x'), code('invalid'), 'an unknown version');
});

test('base64url matches Node; wipe zeroes keys (also in Maps)', () => {
  for (let n = 0; n < 40; n++) {
    const b = crypto.randomBytes(n);
    const s = VC.b64(new Uint8Array(b));
    assert.equal(s, b.toString('base64url'));
    assert.deepEqual(Buffer.from(VC.unb64(s)), b);
  }
  const k = { userKey: VC.newVaultKey(), secretKey: VC.newVaultKey() };
  const m = new Map([[1, VC.newVaultKey()]]);
  VC.wipe(k, m);
  assert.ok(k.userKey.every((x) => x === 0) && k.secretKey.every((x) => x === 0) && m.get(1).every((x) => x === 0));
});

test('Argon2id yields to the page with a macrotask (the bundle\'s patch); more than 256 MiB is refused in the browser', async () => {
  // with noble's own microtask-only nextTick, no timer could run before Argon2id ends
  let ticks = 0;
  let done = false;
  const spin = () => { if (!done) { ticks++; setImmediate(spin); } };
  setImmediate(spin);
  await VC.masterKey('pw', KDF(), { onProgress: () => {} });
  done = true;
  assert.ok(ticks >= 3, `timers ran meanwhile (${ticks})`);
  assert.equal(VC.MAX_M_BROWSER, 262144);
  const t0 = Date.now();
  await assert.rejects(VC.masterKey('pw', { ...KDF(), m: 262145 }), code('kdf_too_large'));
  await assert.rejects(VC.unlock({ ...V.account.body, kdf: { ...V.account.body.kdf, m: 1048576 } }, 'x'), code('kdf_too_large'), 'a server cannot make the tab allocate 1 GiB');
  assert.ok(Date.now() - t0 < 500, 'refused before any work');
  const noble = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'ui', 'vendor', 'noble.js'), 'utf8');
  assert.match(noble, /MessageChannel/);
  assert.match(noble, /Patched: argon2idAsync yields with a macrotask/);
  assert.match(noble, /setTimeout\(\w+,0\)/);
});
