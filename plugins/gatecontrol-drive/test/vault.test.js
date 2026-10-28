'use strict';

// Vault folders (1.9.0, vault.js, ui/vaultcrypto.js): the format (RFC 9180 vector, the frozen vectors, a second
// implementation with Node's crypto as Android and Windows build it), the server's API (create, devices, approve,
// recovery, rotation when someone leaves), what a vault refuses (plain uploads, links, search, previews, albums,
// moves across its border) — and that the server never holds a name, a content or a key it could read.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const VC = require('../ui/vaultcrypto');
const vectors = require('./vault-vectors.json');
const { compute, contentBytes } = require('./vault-vectors');
const { withHost, ANNA, MARC, LENA } = require('./helpers');

const concat = (parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));

// ── the format ──────────────────────────────────────────

test('HPKE: the RFC 9180 vector A.1.1 (DHKEM(X25519), HKDF-SHA256, AES-128-GCM) — seal and open', async () => {
  const eph = await VC.keyFromSeed(VC.unhex('52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736'));
  assert.equal(VC.hex(eph.publicRaw), '37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431');
  const rcpt = await VC.keyFromSeed(VC.unhex('4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8'));
  const info = VC.unhex('4f6465206f6e2061204772656369616e2055726e');
  const aad = VC.unhex('436f756e742d30');
  const pt = VC.unhex('4265617574792069732074727574682c20747275746820626561757479');
  const sealed = await VC.hpkeSeal(rcpt.publicRaw, info, aad, pt, { aeadId: 1, ephemeral: eph });
  assert.equal(VC.hex(sealed.subarray(32)), 'f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a');
  assert.equal(VC.hex(await VC.hpkeOpen(rcpt.privateKey, rcpt.publicRaw, info, aad, sealed, { aeadId: 1 })), VC.hex(pt));
});

test('the frozen vectors (test/vault-vectors.json) still come out bit for bit', async () => {
  assert.deepEqual(await compute(), vectors);
  // the recovery key in the Vault plugin's format (its vector of the same 32 bytes)
  assert.equal(vectors.recovery.text, 'R30W-5GY4-RQ3C-FJ69-SB5W-SKEE-SZ8D-3MPK-TKAX-DNYR-V7DD-QQ6X-VVFJ-63ZJ');
  assert.equal(VC.hex(VC.parseRecoveryKey('r30w 5gy4 rq3c fj69 sb5w skee sz8d 3mpk tkax dnyr v7dd qq6x vvfj 63zj')), vectors.input.recoveryKey);
  assert.equal(VC.hex(VC.parseRecoveryKey(vectors.recovery.text.replace(/0/g, 'O').replace(/1/g, 'l'))), vectors.input.recoveryKey);
  assert.throws(() => VC.parseRecoveryKey(vectors.recovery.text.replace('R30W', 'R30X')), (e) => e.code === 'recovery_key');
});

// A second implementation of README "Tresor-Ordner – Kryptografie" with Node's crypto only — what the apps build.
function node() {
  const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), len));
  const x25519Priv = (raw) => crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]), format: 'der', type: 'pkcs8' });
  const x25519Pub = (raw) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), raw]), format: 'der', type: 'spki' });
  const gcmOpen = (key, nonce, aad, data) => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(aad);
    d.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  };
  const L = (s) => Buffer.from(s);
  const i2osp = (n, w) => { const b = Buffer.alloc(w); b.writeUIntBE(n, 0, w); return b; };
  const extract = (salt, ikm) => crypto.createHmac('sha256', salt.length ? salt : Buffer.alloc(32)).update(ikm).digest();
  const expand = (prk, info, len) => crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
  const KEM = Buffer.concat([L('KEM'), i2osp(0x20, 2)]);
  const HPKE = Buffer.concat([L('HPKE'), i2osp(0x20, 2), i2osp(1, 2), i2osp(2, 2)]);
  const lx = (suite, salt, label, ikm) => extract(salt, Buffer.concat([L('HPKE-v1'), suite, L(label), ikm]));
  const le = (suite, prk, label, info, len) => expand(prk, Buffer.concat([i2osp(len, 2), L('HPKE-v1'), suite, L(label), info]), len);
  return {
    /** wrap (0x01 ‖ enc ‖ ct) → TK, with the recipient's raw private and public key */
    unwrap(wrap, privRaw, pubRaw, vaultId, kv) {
      const b = Buffer.from(wrap, 'base64url');
      assert.equal(b[0], 1);
      const enc = b.subarray(1, 33);
      const dh = crypto.diffieHellman({ privateKey: x25519Priv(privRaw), publicKey: x25519Pub(enc) });
      const shared = le(KEM, lx(KEM, Buffer.alloc(0), 'eae_prk', dh), 'shared_secret', Buffer.concat([enc, pubRaw]), 32);
      const ctx = Buffer.concat([Buffer.from([0]), lx(HPKE, Buffer.alloc(0), 'psk_id_hash', Buffer.alloc(0)), lx(HPKE, Buffer.alloc(0), 'info_hash', L(`gcdrive-v1:tk:${vaultId}:${kv}`))]);
      const secret = lx(HPKE, shared, 'secret', Buffer.alloc(0));
      return gcmOpen(le(HPKE, secret, 'key', ctx, 32), le(HPKE, secret, 'base_nonce', ctx, 12), Buffer.alloc(0), b.subarray(33));
    },
    name(cipher, tk, vaultId) {
      const b = Buffer.from(cipher, 'base64url');
      const p = gcmOpen(hkdf(tk, Buffer.alloc(0), `gcdrive-v1:name:${vaultId}`, 32), b.subarray(5, 17), b.subarray(0, 5), b.subarray(17));
      let i = p.length - 1;
      while (p[i] === 0) i--;
      assert.equal(p[i], 0x80);
      return p.subarray(0, i).toString('utf8');
    },
    content(data, tk, vaultId) {
      const head = data.subarray(0, 29);
      assert.equal(head.subarray(0, 5).toString('latin1'), 'GCDV\x01');
      const cs = head.readUInt32BE(9);
      const key = hkdf(tk, head.subarray(13, 29), `gcdrive-v1:content:${vaultId}`, 32);
      const out = [];
      const step = cs + 16;
      const n = Math.ceil((data.length - 29) / step);
      for (let i = 0; i < n; i++) {
        const nonce = Buffer.concat([Buffer.alloc(8), i2osp(i, 4)]);
        out.push(gcmOpen(key, nonce, Buffer.concat([head, i2osp(i, 4), Buffer.from([i === n - 1 ? 1 : 0])]), data.subarray(29 + i * step, Math.min(data.length, 29 + (i + 1) * step))));
      }
      return Buffer.concat(out);
    },
    recoveryAuth(key) { return hkdf(key, Buffer.alloc(0), 'gcdrive-v1:recovery-auth', 32).toString('base64url'); },
    recoveryPub(key) {
      const seed = hkdf(key, Buffer.alloc(0), 'gcdrive-v1:recovery', 32);
      return crypto.createPublicKey(x25519Priv(seed)).export({ format: 'der', type: 'spki' }).subarray(12);
    },
  };
}

test('a second implementation with Node\'s crypto reads the vectors (wrap, name, content, recovery key)', () => {
  const N = node();
  const tk = N.unwrap(vectors.wrap, Buffer.from(vectors.input.deviceSeed, 'hex'), Buffer.from(vectors.device.publicKey, 'base64url'), vectors.input.vaultId, 1);
  assert.equal(tk.toString('hex'), vectors.input.vaultKey);
  assert.equal(N.name(vectors.nameCipher, tk, vectors.input.vaultId), vectors.input.name);
  assert.deepEqual(N.content(Buffer.from(vectors.content.base64url, 'base64url'), tk, vectors.input.vaultId), Buffer.from(contentBytes()));
  assert.equal(N.recoveryPub(Buffer.from(vectors.input.recoveryKey, 'hex')).toString('base64url'), vectors.recovery.publicKey);
  assert.equal(N.recoveryAuth(Buffer.from(vectors.input.recoveryKey, 'hex')), vectors.recovery.auth);
  const id = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('gcdrive-v1:device:'), Buffer.from(vectors.device.publicKey, 'base64url')])).digest().subarray(0, 16).toString('base64url');
  assert.equal(id, vectors.device.deviceId);
});

test('content: chunks, an exact multiple, an empty file; tampering, reordering, cutting and another vault are refused', async () => {
  const tk = VC.newVaultKey();
  const vid = VC.newVaultId();
  const keys = new Map([[3, tk]]);
  const read = (buf) => (a, b) => Promise.resolve(buf.subarray(a, b + 1));
  for (const size of [0, 1, 1023, 1024, 2048, 5000]) {
    const pt = crypto.randomBytes(size);
    const ct = concat(await VC.encryptContent(tk, vid, 3, new Uint8Array(pt), { chunkSize: 1024 }));
    assert.equal(ct.length, VC.cipherSize(size, 1024), `size ${size}`);
    assert.deepEqual(concat(await VC.decryptContent(keys, vid, read(ct), ct.length, { window: 2100 })), pt, `size ${size}`);
  }
  const pt = crypto.randomBytes(3000);
  const ct = concat(await VC.encryptContent(tk, vid, 3, new Uint8Array(pt), { chunkSize: 1024 }));
  const bad = Buffer.from(ct); bad[100] ^= 1;
  await assert.rejects(VC.decryptContent(keys, vid, read(bad), bad.length), (e) => e.code === 'decrypt');
  const step = 1024 + 16;
  const swapped = Buffer.concat([ct.subarray(0, 29), ct.subarray(29 + step, 29 + 2 * step), ct.subarray(29, 29 + step), ct.subarray(29 + 2 * step)]);
  await assert.rejects(VC.decryptContent(keys, vid, read(swapped), swapped.length), (e) => e.code === 'decrypt');
  const cut = ct.subarray(0, 29 + 2 * step);
  await assert.rejects(VC.decryptContent(keys, vid, read(cut), cut.length), (e) => e.code === 'decrypt', 'the last chunk is marked');
  await assert.rejects(VC.decryptContent(keys, VC.newVaultId(), read(ct), ct.length), (e) => e.code === 'decrypt');
  await assert.rejects(VC.decryptContent(new Map([[1, tk]]), vid, read(ct), ct.length), (e) => e.code === 'decrypt', 'no key of that version');
});

test('names: padded to 32 bytes, bound to the vault, the key version in the header', async () => {
  const tk = VC.newVaultKey();
  const vid = VC.newVaultId();
  const short = await VC.encryptName(tk, vid, 2, 'a');
  const long = await VC.encryptName(tk, vid, 2, 'a'.repeat(31));
  assert.equal(VC.unb64u(short).length, VC.unb64u(long).length, 'the length hides the name');
  assert.equal(VC.nameVersion(short), 2);
  assert.equal(await VC.decryptName(new Map([[2, tk]]), vid, short), 'a');
  await assert.rejects(VC.decryptName(new Map([[2, tk]]), VC.newVaultId(), short), (e) => e.code === 'decrypt');
  assert.equal(await VC.decryptName({ 2: tk }, vid, await VC.encryptName(tk, vid, 2, 'Café.txt')), 'Café.txt', 'NFC');
});

// ── a client in Node (what the portal and the apps do) ──

async function deviceOf() {
  const kp = await VC.generateDeviceKey();
  const raw = await VC.exportPublic(kp.publicKey);
  return { privateKey: kp.privateKey, publicRaw: raw, publicKey: VC.b64u(raw), id: await VC.deviceId(raw) };
}

/** Make a vault in `parentId` as `who` with device `dev` → { id, tk, rec, node } */
async function makeVault(call, parentId, dev, name = 'Steuer') {
  const id = VC.newVaultId();
  const tk = VC.newVaultKey();
  const rec = VC.newRecoveryKey();
  const rk = await VC.recoveryKeyPair(rec.key);
  const r = await call('POST', 'vaults', {
    id, parentId, nameCipher: await VC.encryptName(tk, id, 1, name), recoveryPub: VC.b64u(rk.publicRaw), recoveryAuth: await VC.recoveryAuth(rec.key), recoveryWrap: await VC.wrapKey(tk, rk.publicRaw, id, 1),
    device: { publicKey: dev.publicKey, name: 'Laptop', platform: 'windows' }, wrap: await VC.wrapKey(tk, dev.publicRaw, id, 1),
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { id, tk, rec, node: r.json.node, vault: r.json.vault };
}

async function putEncrypted(c, user, v, parentId, name, data, extra = {}) {
  const kv = extra.keyVersion || 1;
  const tk = extra.tk || v.tk;
  const parts = await VC.encryptContent(tk, v.id, kv, new Uint8Array(Buffer.from(data)));
  const mediaId = await c.upload(user, concat(parts), 'application/octet-stream');
  return c.as(user)('POST', 'uploads/commit', { mediaId, parentId, encrypted: true, nameCipher: await VC.encryptName(tk, v.id, kv, name), keyVersion: kv, ...extra.body });
}

test('a vault: made, a file in it, read back by the device; the server keeps only what it cannot read', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const dev = await deviceOf();
    const v = await makeVault(a, mine.rootId, dev, 'Steuer 2025');
    assert.equal(v.node.encrypted, true);
    assert.match(v.node.name, /^[0-9a-f]{32}$/, 'the folder\'s name is opaque');
    assert.equal(v.vault.keyVersion, 1);
    assert.deepEqual(v.vault.myDevices.map((d) => d.state), ['approved']);
    // a sub folder and a file
    const sub = await a('POST', 'nodes', { parentId: v.node.id, encrypted: true, nameCipher: await VC.encryptName(v.tk, v.id, 1, 'Belege'), keyVersion: 1 });
    assert.equal(sub.status, 200, JSON.stringify(sub.json));
    const SECRET = 'Kontoauszug mit IBAN DE02 1203 0000 0000 2020 51 – streng geheim';
    const up = await putEncrypted(c, ANNA, v, sub.json.node.id, 'Kontoauszug Oktober.pdf', SECRET, { body: { text: SECRET, takenAt: Date.now(), entropy: 7.9 } });
    assert.equal(up.status, 200, JSON.stringify(up.json));
    const file = up.json.node;
    assert.equal(file.encrypted, true);
    assert.equal(file.mime, 'application/octet-stream');
    assert.equal(file.keyVersion, 1);
    assert.equal(file.preview, null);
    // the device: its keys, the names, the content
    const k = await a('GET', `vaults/${v.id}/keys`, null, { deviceId: dev.id });
    assert.equal(k.json.state, 'approved');
    const tk = await VC.unwrapKey(k.json.keys[0].wrap, dev.privateKey, dev.publicRaw, v.id, 1);
    assert.equal(VC.hex(tk), VC.hex(v.tk));
    const list = await a('GET', `nodes/${sub.json.node.id}/children`);
    assert.equal(await VC.decryptName(new Map([[1, tk]]), v.id, list.json.items[0].nameCipher), 'Kontoauszug Oktober.pdf');
    const ct = host.media.get(file.mediaId).data;
    const pt = concat(await VC.decryptContent(new Map([[1, tk]]), v.id, (x, y) => Promise.resolve(ct.subarray(x, y + 1)), ct.length));
    assert.equal(pt.toString('utf8'), SECRET);
    // a new version (the opaque name of the file, onConflict version)
    const v2 = await putEncrypted(c, ANNA, v, sub.json.node.id, 'Kontoauszug Oktober.pdf', 'Fassung 2', { body: { name: file.name, onConflict: 'version' } });
    assert.equal(v2.status, 200, JSON.stringify(v2.json));
    assert.equal(v2.json.node.id, file.id);
    assert.equal(v2.json.node.rev, 2);
    // nothing readable is anywhere on the server: rows, kv, media, pushes, events, logs
    const tables = (await host.gc.db.query("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => r.name);
    let dump = '';
    for (const t of tables) dump += JSON.stringify((await host.gc.db.query(`SELECT * FROM "${t}"`)).rows);
    dump += JSON.stringify([...host.kv.entries()]) + JSON.stringify(host.notifications) + JSON.stringify(host.events) + JSON.stringify(host.logs);
    const blobs = [...host.media.values()].map((m) => Buffer.from(m.data));
    const needles = ['Steuer 2025', 'Belege', 'Kontoauszug', 'IBAN', 'Fassung 2', VC.hex(v.tk), VC.b64u(v.tk), Buffer.from(v.tk).toString('base64'), v.rec.text, VC.hex(v.rec.key), VC.b64u(v.rec.key), await VC.recoveryAuth(v.rec.key)];
    for (const n of needles) {
      assert.equal(dump.includes(n), false, `the server holds "${n}"`);
      for (const b of blobs) assert.equal(b.includes(Buffer.from(n)), false, `a media file holds "${n}"`);
    }
    for (const b of blobs) assert.equal(b.includes(Buffer.from(v.tk)), false, 'a media file holds the key');
  });
});

test('a vault refuses what would leak: plain uploads, links, search, albums, the border; stale keys', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const dev = await deviceOf();
    // a folder link of the folder the vault goes into ends (it would list the vault's ciphertext)
    const link = await a('POST', 'links', { nodeId: mine.rootId, mode: 'view' });
    assert.equal(link.status, 200, JSON.stringify(link.json));
    const v = await makeVault(a, mine.rootId, dev);
    const ended = (await a('GET', 'links')).json.links.find((l) => l.token === link.json.link.token);
    assert.equal(ended.endedWhy, 'vault');
    assert.equal(host.publicLinks.get(link.json.link.token).revoked, true);
    const plain = await c.put(ANNA, v.node.id, 'klartext.txt', 'hallo');
    assert.equal(plain.status, 400, 'a plain upload into a vault');
    assert.equal(plain.json.field, 'encrypted');
    const outside = await putEncrypted(c, ANNA, v, mine.rootId, 'x', 'y');
    assert.equal(outside.status, 400, 'encrypted outside a vault');
    const stale = await putEncrypted(c, ANNA, v, v.node.id, 'x', 'y', { keyVersion: 2 });
    assert.equal(stale.status, 409, 'a key version that is not the current one');
    assert.equal(stale.json.reason, 'stale_key');
    assert.equal(stale.json.keyVersion, 1);
    const mediaId = await c.upload(ANNA, 'cipher', 'application/octet-stream');
    assert.equal((await a('POST', 'uploads/commit', { mediaId, parentId: v.node.id, encrypted: true, nameCipher: await VC.encryptName(v.tk, v.id, 1, 'a'), keyVersion: 1, name: 'Klartext.pdf' })).status, 400, 'a name that is not opaque');
    assert.equal((await a('POST', 'uploads/commit', { mediaId, parentId: v.node.id, encrypted: true, keyVersion: 1 })).status, 400, 'no nameCipher');
    assert.equal((await a('POST', 'uploads/commit', { mediaId, parentId: v.node.id, encrypted: true, nameCipher: 'AAAA', keyVersion: 1 })).status, 400);
    assert.equal((await a('POST', 'nodes', { parentId: v.node.id, name: 'Ordner' })).status, 400, 'a plain folder in a vault');
    assert.equal((await a('POST', 'vaults', { id: VC.newVaultId(), parentId: v.node.id })).status, 400);
    const f = (await putEncrypted(c, ANNA, v, v.node.id, 'Brief.pdf', 'Inhalt')).json.node;
    // links: the file, the vault, a folder holding the vault
    for (const id of [f.id, v.node.id, mine.rootId]) {
      const l = await a('POST', 'links', { nodeId: id, mode: 'download' });
      assert.equal(l.status, 409, `link of ${id}`);
      assert.equal(l.json.code, 'encrypted');
    }
    // search: never (the names are opaque anyway)
    assert.deepEqual((await a('GET', 'search', null, { q: f.name.slice(0, 6) })).json.items, []);
    // albums: no
    const al = await a('POST', 'albums', { areaId: mine.id, name: 'X' });
    if (al.status === 200) assert.equal((await a('POST', `albums/${al.json.album.id}/items`, { ids: [f.id] })).status, 400);
    // the border: nothing moves in or out; renames by nameCipher only
    const plainFile = (await c.put(ANNA, mine.rootId, 'a.txt', 'x')).json.node;
    assert.equal((await a('PATCH', `nodes/${plainFile.id}`, { parentId: v.node.id })).status, 400);
    assert.equal((await a('PATCH', `nodes/${f.id}`, { parentId: mine.rootId })).status, 400);
    assert.equal((await a('PATCH', `nodes/${f.id}`, { name: 'Klar.pdf' })).status, 400);
    assert.equal((await a('PATCH', `nodes/${plainFile.id}`, { nameCipher: await VC.encryptName(v.tk, v.id, 1, 'b') })).status, 400);
    const ren = await a('PATCH', `nodes/${f.id}`, { nameCipher: await VC.encryptName(v.tk, v.id, 1, 'Neu.pdf') });
    assert.equal(ren.status, 200, JSON.stringify(ren.json));
    assert.equal(ren.json.node.name, f.name);
    assert.equal(await VC.decryptName({ 1: v.tk }, v.id, ren.json.node.nameCipher), 'Neu.pdf');
    // the trash: a file whose folder is gone comes back into the vault; the vault's folder may go and come back
    const sub = (await a('POST', 'nodes', { parentId: v.node.id, encrypted: true, nameCipher: await VC.encryptName(v.tk, v.id, 1, 'Sub'), keyVersion: 1 })).json.node;
    const g = (await putEncrypted(c, ANNA, v, sub.id, 'g', 'g')).json.node;
    await a('DELETE', `nodes/${g.id}`);
    await a('DELETE', `nodes/${sub.id}`);
    await a('DELETE', `trash/${sub.id}`);
    const back = await a('POST', `trash/${g.id}/restore`);
    assert.equal(back.json.node.parentId, v.node.id);
    // the vault's folder moves within its area, never to another
    const fam = await c.area(ANNA, 'family');
    assert.equal((await a('PATCH', `nodes/${v.node.id}`, { parentId: fam.rootId })).status, 400);
    // purged for good: its keys go
    await a('DELETE', `nodes/${v.node.id}`);
    assert.deepEqual((await a('GET', 'vaults')).json.vaults, []);
    await a('DELETE', `trash/${v.node.id}`);
    assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM vault_wraps')).rows[0].n, 0);
    assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM vaults')).rows[0].n, 0);
  });
});

test('devices: a new one asks (push), an approved one approves after the safety number; the recovery key opens it too', async () => {
  await withHost({}, async (host, c) => {
    const laptop = await deviceOf();
    const phone = await deviceOf();
    const tablet = await deviceOf();
    const fam = await c.area(ANNA, 'family');
    const v = await makeVault(c.as(ANNA), fam.rootId, laptop, 'Familie');
    // Marc (the family) asks with his phone
    const m = c.as(MARC);
    assert.equal((await m('GET', `vaults/${v.id}/keys`, null, { deviceId: phone.id })).status, 404);
    const ask = await m('POST', `vaults/${v.id}/devices`, { publicKey: phone.publicKey, name: 'Pixel', platform: 'android' });
    assert.equal(ask.status, 200, JSON.stringify(ask.json));
    assert.equal(ask.json.device.state, 'pending');
    assert.equal(ask.json.device.deviceId, phone.id, 'the server computes the same device id');
    const push = c.pushes().filter((p) => p.topic === 'vault');
    assert.deepEqual(push.map((p) => p.users), [[ANNA.id]], 'the people with an approved device');
    assert.equal(JSON.stringify(push).includes(phone.publicKey), false);
    assert.equal((await m('GET', `vaults/${v.id}/keys`, null, { deviceId: phone.id })).json.state, 'pending');
    // Marc cannot approve his own device without an approved one — only with the recovery key's proof
    const self = await m('POST', `vaults/${v.id}/devices/${phone.id}/approve`, { wrap: await VC.wrapKey(v.tk, phone.publicRaw, v.id, 1) });
    assert.equal(self.status, 403);
    const fake = await m('POST', `vaults/${v.id}/devices/${phone.id}/approve`, { wrap: await VC.wrapKey(v.tk, phone.publicRaw, v.id, 1), via: 'recovery', recoveryAuth: VC.b64u(VC.random(32)) });
    assert.equal(fake.status, 403, 'a wrong proof');
    assert.equal(fake.json.reason, 'recovery_auth');
    // Anna: the list with the public key, the safety number, approve
    const a = c.as(ANNA);
    const devs = (await a('GET', `vaults/${v.id}/devices`)).json.devices;
    assert.equal(devs.find((d) => d.deviceId === phone.id).publicKey, phone.publicKey);
    assert.equal(await VC.safetyNumber(VC.unb64u(phone.publicKey)), await VC.safetyNumber(phone.publicRaw));
    // Lena (a child of the family) has no device in the vault: she cannot approve Marc's tablet
    const t = await m('POST', `vaults/${v.id}/devices`, { publicKey: tablet.publicKey, name: 'Tablet' });
    assert.equal(t.json.device.state, 'pending');
    assert.equal((await c.as(LENA)('POST', `vaults/${v.id}/devices/${tablet.id}/approve`, { wrap: await VC.wrapKey(v.tk, tablet.publicRaw, v.id, 1) })).status, 403);
    const ok = await a('POST', `vaults/${v.id}/devices/${tablet.id}/approve`, { wraps: [{ keyVersion: 1, wrap: await VC.wrapKey(v.tk, tablet.publicRaw, v.id, 1) }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const k = await m('GET', `vaults/${v.id}/keys`, null, { deviceId: tablet.id });
    assert.equal(VC.hex(await VC.unwrapKey(k.json.keys[0].wrap, tablet.privateKey, tablet.publicRaw, v.id, 1)), VC.hex(v.tk));
    // only one's own devices' wraps
    assert.equal((await a('GET', `vaults/${v.id}/keys`, null, { deviceId: tablet.id })).status, 404);
    // a wrap of the wrong shape, a version that does not exist
    assert.equal((await a('POST', `vaults/${v.id}/devices/${tablet.id}/approve`, { wrap: 'AQ' })).status, 400);
    assert.equal((await a('POST', `vaults/${v.id}/devices/${tablet.id}/approve`, { wraps: [{ keyVersion: 2, wrap: await VC.wrapKey(v.tk, tablet.publicRaw, v.id, 2) }] })).status, 400);
    // the recovery key: a fresh device of Lena opens the vault with it and approves itself
    const lenaDev = await deviceOf();
    const l = c.as(LENA);
    const r = await l('GET', `vaults/${v.id}/recovery`);
    const rk = await VC.recoveryKeyPair(VC.parseRecoveryKey(v.rec.text));
    assert.equal(VC.b64u(rk.publicRaw), r.json.recoveryPub);
    const tk = await VC.unwrapKey(r.json.keys[0].wrap, rk.privateKey, rk.publicRaw, v.id, 1);
    await l('POST', `vaults/${v.id}/devices`, { publicKey: lenaDev.publicKey, name: 'Lenas Handy' });
    const proof = await VC.recoveryAuth(VC.parseRecoveryKey(v.rec.text));
    const viaRec = await l('POST', `vaults/${v.id}/devices/${lenaDev.id}/approve`, { wraps: [{ keyVersion: 1, wrap: await VC.wrapKey(tk, lenaDev.publicRaw, v.id, 1) }], via: 'recovery', recoveryAuth: proof });
    assert.equal(viaRec.status, 200, JSON.stringify(viaRec.json));
    assert.equal(viaRec.json.device.via, 'recovery');
    // the proof opens only one's own device
    const other = await deviceOf();
    await m('POST', `vaults/${v.id}/devices`, { publicKey: other.publicKey });
    assert.equal((await c.as(LENA)('POST', `vaults/${v.id}/devices/${other.id}/approve`, { wrap: await VC.wrapKey(tk, other.publicRaw, v.id, 1), via: 'recovery', recoveryAuth: proof })).status, 403);
    // declined: the request is gone with its wraps
    const extra = await deviceOf();
    await m('POST', `vaults/${v.id}/devices`, { publicKey: extra.publicKey });
    assert.equal((await a('DELETE', `vaults/${v.id}/devices/${extra.id}`)).json.device.state, 'revoked');
    // Oma (no family) sees no vault
    assert.equal((await c.as({ id: 5, name: 'Oma', role: 'user' })('GET', `vaults/${v.id}`)).status, 403);
  });
});

test('someone loses the area: their devices are revoked, the vault asks for a new key; old files stay readable', async () => {
  await withHost({}, async (host, c) => {
    const lenaDev = await deviceOf();
    const annaDev = await deviceOf();
    const child = await c.area(LENA, 'child');
    const l = c.as(LENA);
    const a = c.as(ANNA);
    const v = await makeVault(l, child.rootId, lenaDev, 'Tagebuch');
    // a parent may look in (child_parents_view): Anna asks, Lena approves
    await a('POST', `vaults/${v.id}/devices`, { publicKey: annaDev.publicKey, name: 'Annas Laptop' });
    await l('POST', `vaults/${v.id}/devices/${annaDev.id}/approve`, { wrap: await VC.wrapKey(v.tk, annaDev.publicRaw, v.id, 1) });
    const old = (await putEncrypted(c, LENA, v, v.node.id, 'alt.txt', 'alter Eintrag')).json.node;
    assert.equal((await a('GET', `vaults/${v.id}/keys`, null, { deviceId: annaDev.id })).json.state, 'approved');
    // the administrator switches the parents' view off: Anna no longer reads the area
    host.settings.child_parents_view = false;
    const seen = (await l('GET', `vaults/${v.id}`)).json.vault;
    assert.equal(seen.needsRotation, true);
    const devs = (await l('GET', `vaults/${v.id}/devices`)).json.devices;
    assert.equal(devs.find((d) => d.deviceId === annaDev.id).state, 'revoked');
    assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM vault_wraps WHERE device_id = ?', [annaDev.id])).rows[0].n, 0, 'her wraps are gone');
    assert.equal((await a('GET', `vaults/${v.id}/keys`, null, { deviceId: annaDev.id })).status, 404);
    // rotation: exactly the approved devices, the next version
    const tk2 = VC.newVaultKey();
    const short = await l('POST', `vaults/${v.id}/rotate`, { keyVersion: 2, wraps: [], recoveryWrap: await VC.wrapKey(tk2, VC.unb64u(seen.recoveryPub), v.id, 2) });
    assert.equal(short.status, 409);
    assert.deepEqual(short.json.devices, [lenaDev.id]);
    assert.equal((await l('POST', `vaults/${v.id}/rotate`, { keyVersion: 3, wraps: [] })).status, 409);
    const rot = await l('POST', `vaults/${v.id}/rotate`, { keyVersion: 2, wraps: [{ deviceId: lenaDev.id, wrap: await VC.wrapKey(tk2, lenaDev.publicRaw, v.id, 2) }], recoveryWrap: await VC.wrapKey(tk2, VC.unb64u(seen.recoveryPub), v.id, 2) });
    assert.equal(rot.status, 200, JSON.stringify(rot.json));
    assert.equal(rot.json.vault.keyVersion, 2);
    assert.equal(rot.json.vault.needsRotation, false);
    // new files need the new key; the old one is refused
    assert.equal((await putEncrypted(c, LENA, v, v.node.id, 'neu.txt', 'x')).status, 409);
    const neu = await putEncrypted(c, LENA, v, v.node.id, 'neu.txt', 'neuer Eintrag', { keyVersion: 2, tk: tk2 });
    assert.equal(neu.status, 200, JSON.stringify(neu.json));
    // Lena's device has both keys: the old file stays readable
    const k = (await l('GET', `vaults/${v.id}/keys`, null, { deviceId: lenaDev.id })).json;
    assert.deepEqual(k.keys.map((x) => x.keyVersion), [1, 2]);
    const keys = new Map();
    for (const x of k.keys) keys.set(x.keyVersion, await VC.unwrapKey(x.wrap, lenaDev.privateKey, lenaDev.publicRaw, v.id, x.keyVersion));
    const ct = host.media.get(old.mediaId).data;
    assert.equal(concat(await VC.decryptContent(keys, v.id, (x, y) => Promise.resolve(ct.subarray(x, y + 1)), ct.length)).toString(), 'alter Eintrag');
    // the recovery key opens both versions
    const r = (await l('GET', `vaults/${v.id}/recovery`)).json;
    assert.deepEqual(r.keys.map((x) => x.keyVersion), [1, 2]);
  });
});

test('rotation after the recovery key\'s holder left needs a new recovery key for every version', async () => {
  await withHost({}, async (host, c) => {
    const annaDev = await deviceOf();
    const lenaDev = await deviceOf();
    const child = await c.area(LENA, 'child');
    // Anna (a parent) makes a vault in Lena's folder? No — a parent only reads it. Lena makes it, Anna holds nothing.
    const l = c.as(LENA);
    const v = await makeVault(l, child.rootId, lenaDev);
    const a = c.as(ANNA);
    await a('POST', `vaults/${v.id}/devices`, { publicKey: annaDev.publicKey });
    await l('POST', `vaults/${v.id}/devices/${annaDev.id}/approve`, { wrap: await VC.wrapKey(v.tk, annaDev.publicRaw, v.id, 1) });
    // a new recovery key made by Anna (she becomes its holder), then she loses the area
    const rec = VC.newRecoveryKey();
    const rk = await VC.recoveryKeyPair(rec.key);
    const set = await a('PUT', `vaults/${v.id}/recovery`, { pub: VC.b64u(rk.publicRaw), auth: await VC.recoveryAuth(rec.key), wraps: [{ keyVersion: 1, wrap: await VC.wrapKey(v.tk, rk.publicRaw, v.id, 1) }] });
    assert.equal(set.status, 403, 'a reading parent may not (write needed)');
    host.settings.child_parents_view = false;
    // the holder is Lena (she made it): a plain rotation works; simulate a holder who left
    await host.gc.db.run('UPDATE vaults SET recovery_by = ? WHERE id = ?', [ANNA.id, v.id]);
    const tk2 = VC.newVaultKey();
    const body = { keyVersion: 2, wraps: [{ deviceId: lenaDev.id, wrap: await VC.wrapKey(tk2, lenaDev.publicRaw, v.id, 2) }], recoveryWrap: await VC.wrapKey(tk2, VC.unb64u((await l('GET', `vaults/${v.id}`)).json.vault.recoveryPub), v.id, 2) };
    const r1 = await l('POST', `vaults/${v.id}/rotate`, body);
    assert.equal(r1.status, 409);
    assert.equal(r1.json.reason, 'recovery_required');
    const rec2 = VC.newRecoveryKey();
    const rk2 = await VC.recoveryKeyPair(rec2.key);
    delete body.recoveryWrap;
    body.recovery = { pub: VC.b64u(rk2.publicRaw), auth: await VC.recoveryAuth(rec2.key), wraps: [{ keyVersion: 1, wrap: await VC.wrapKey(v.tk, rk2.publicRaw, v.id, 1) }, { keyVersion: 2, wrap: await VC.wrapKey(tk2, rk2.publicRaw, v.id, 2) }] };
    const r2 = await l('POST', `vaults/${v.id}/rotate`, body);
    assert.equal(r2.status, 200, JSON.stringify(r2.json));
    assert.equal(r2.json.vault.recoveryHolder, LENA.id);
    assert.equal(r2.json.vault.recoveryPub, VC.b64u(rk2.publicRaw));
  });
});

test('the time travel brings an encrypted name back', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const dev = await deviceOf();
    const v = await makeVault(a, mine.rootId, dev);
    const f = (await putEncrypted(c, ANNA, v, v.node.id, 'Erst.pdf', 'x')).json.node;
    c.clock.add(60000);
    const before = Date.now();
    c.clock.add(60000);
    await a('PATCH', `nodes/${f.id}`, { nameCipher: await VC.encryptName(v.tk, v.id, 1, 'Später.pdf') });
    c.clock.add(60000);
    const tt = await a('POST', `nodes/${v.node.id}/timetravel`, { at: new Date(before).toISOString() });
    assert.equal(tt.status, 200, JSON.stringify(tt.json));
    const now = (await a('GET', `nodes/${f.id}`)).json.node;
    assert.equal(await VC.decryptName({ 1: v.tk }, v.id, now.nameCipher), 'Erst.pdf');
  });
});
