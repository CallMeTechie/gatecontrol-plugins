'use strict';

// Tresor notebooks (vault.js, ui/vaultcrypto.js): Drive's vault format with the prefix "gcnotes-v1" — the frozen
// vectors, a second implementation with Node's crypto only (what Android and Windows build), the API (make, devices,
// approve, recovery, rotation when someone leaves) and that the server never holds a title, a text or a key it could read.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const VC = require('../ui/vaultcrypto');
const vectors = require('./vault-vectors.json');
const { compute, contentBytes } = require('./vault-vectors');
const { withHost, ANNA, MARC, BOB } = require('./helpers');

test('the frozen vectors (test/vault-vectors.json) still come out bit for bit', async () => {
  assert.equal(VC.PREFIX, 'gcnotes-v1');
  assert.deepEqual(await compute(), vectors);
  assert.equal(vectors.recovery.text, 'R30W-5GY4-RQ3C-FJ69-SB5W-SKEE-SZ8D-3MPK-TKAX-DNYR-V7DD-QQ6X-VVFJ-63ZJ', 'the same recovery key text as Drive (the format of the Vault plugin)');
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
      const ctx = Buffer.concat([Buffer.from([0]), lx(HPKE, Buffer.alloc(0), 'psk_id_hash', Buffer.alloc(0)), lx(HPKE, Buffer.alloc(0), 'info_hash', L(`gcnotes-v1:tk:${vaultId}:${kv}`))]);
      const secret = lx(HPKE, shared, 'secret', Buffer.alloc(0));
      return gcmOpen(le(HPKE, secret, 'key', ctx, 32), le(HPKE, secret, 'base_nonce', ctx, 12), Buffer.alloc(0), b.subarray(33));
    },
    name(cipher, tk, vaultId) {
      const b = Buffer.from(cipher, 'base64url');
      const p = gcmOpen(hkdf(tk, Buffer.alloc(0), `gcnotes-v1:name:${vaultId}`, 32), b.subarray(5, 17), b.subarray(0, 5), b.subarray(17));
      let i = p.length - 1;
      while (p[i] === 0) i--;
      assert.equal(p[i], 0x80);
      return p.subarray(0, i).toString('utf8');
    },
    content(data, tk, vaultId) {
      const head = data.subarray(0, 29);
      assert.equal(head.subarray(0, 5).toString('latin1'), 'GCDV\x01');
      const cs = head.readUInt32BE(9);
      const key = hkdf(tk, head.subarray(13, 29), `gcnotes-v1:content:${vaultId}`, 32);
      const out = [];
      const step = cs + 16;
      const n = Math.ceil((data.length - 29) / step);
      for (let i = 0; i < n; i++) {
        const nonce = Buffer.concat([Buffer.alloc(8), i2osp(i, 4)]);
        out.push(gcmOpen(key, nonce, Buffer.concat([head, i2osp(i, 4), Buffer.from([i === n - 1 ? 1 : 0])]), data.subarray(29 + i * step, Math.min(data.length, 29 + (i + 1) * step))));
      }
      return Buffer.concat(out);
    },
    recoveryAuth(key) { return hkdf(key, Buffer.alloc(0), 'gcnotes-v1:recovery-auth', 32).toString('base64url'); },
    recoveryPub(key) {
      const seed = hkdf(key, Buffer.alloc(0), 'gcnotes-v1:recovery', 32);
      return crypto.createPublicKey(x25519Priv(seed)).export({ format: 'der', type: 'spki' }).subarray(12);
    },
  };
}

test('a second implementation with Node\'s crypto reads the vectors (wrap, name, note, content, recovery key)', () => {
  const N = node();
  const tk = N.unwrap(vectors.wrap, Buffer.from(vectors.input.deviceSeed, 'hex'), Buffer.from(vectors.device.publicKey, 'base64url'), vectors.input.vaultId, 1);
  assert.equal(tk.toString('hex'), vectors.input.vaultKey);
  assert.equal(N.name(vectors.nameCipher, tk, vectors.input.vaultId), vectors.input.name);
  assert.equal(N.content(Buffer.from(vectors.noteCipher, 'base64url'), tk, vectors.input.vaultId).toString('utf8'), vectors.input.note);
  assert.deepEqual(N.content(Buffer.from(vectors.content.base64url, 'base64url'), tk, vectors.input.vaultId), Buffer.from(contentBytes()));
  assert.equal(N.recoveryPub(Buffer.from(vectors.input.recoveryKey, 'hex')).toString('base64url'), vectors.recovery.publicKey);
  assert.equal(N.recoveryAuth(Buffer.from(vectors.input.recoveryKey, 'hex')), vectors.recovery.auth);
  const id = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('gcnotes-v1:device:'), Buffer.from(vectors.device.publicKey, 'base64url')])).digest().subarray(0, 16).toString('base64url');
  assert.equal(id, vectors.device.deviceId);
  assert.equal(require('../server/vault').deviceIdOf(vectors.device.publicKey), vectors.device.deviceId, 'the server computes the same id');
  // the other domain does not open it: a Drive wrap of the same key is different
  assert.notEqual(vectors.wrap, require('../../gatecontrol-drive/test/vault-vectors.json').wrap);
});

async function device() {
  const kp = await VC.generateDeviceKey();
  const raw = await VC.exportPublic(kp.publicKey);
  return { ...kp, raw, pub: VC.b64u(raw), id: await VC.deviceId(raw) };
}

/** A Tresor made the way the portal makes it. */
async function makeVault(h, user, name) {
  const d = await device();
  const id = VC.newVaultId();
  const tk = VC.newVaultKey();
  const rec = VC.newRecoveryKey();
  const rkp = await VC.recoveryKeyPair(rec.key);
  const body = { id, area: 'private', nameCipher: await VC.encryptName(tk, id, 1, name), recoveryPub: VC.b64u(rkp.publicRaw), recoveryAuth: await VC.recoveryAuth(rec.key),
    recoveryWrap: await VC.wrapKey(tk, rkp.publicRaw, id, 1), device: { publicKey: d.pub, name: 'Test', platform: 'web' }, wrap: await VC.wrapKey(tk, d.raw, id, 1) };
  const r = await h.ok(user, 'POST', 'vaults', body);
  return { d, id, tk, rec, nb: r.notebook, vault: r.vault };
}
const join = (parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));

test('Tresor: make, write a note, a second device asks and is approved, recovery, rotation when a member leaves', async () => {
  const h = await withHost();
  try {
    const v = await makeVault(h, ANNA, 'Versicherungen');
    assert.equal(v.nb.vault.id, v.id);
    assert.equal(v.nb.name, null);
    // a note: only ciphertext
    const title = await VC.encryptName(v.tk, v.id, 1, 'Kfz-Police');
    const cipher = VC.b64u(join(await VC.encryptContent(v.tk, v.id, 1, new TextEncoder().encode('Vertragsnummer 4711-0815 #geheim'))));
    const n = await h.ok(ANNA, 'POST', 'notes', { notebookId: v.nb.id, titleCipher: title, cipher, keyVersion: 1 });
    assert.equal(n.note.title, null);
    assert.equal(n.note.encrypted, true);
    assert.equal((await h.call(ANNA, 'POST', 'notes', { notebookId: v.nb.id, title: 'klar', body: 'text' })).status, 400, 'plain text is refused in a Tresor');
    assert.equal((await h.call(ANNA, 'POST', 'notes', { notebookId: v.nb.id, titleCipher: title, cipher, keyVersion: 2 })).status, 409);
    assert.equal((await h.call(ANNA, 'POST', `notes/${n.note.id}/check`, { line: 0, done: true })).status, 409);
    assert.equal((await h.ok(ANNA, 'GET', 'search', null, { q: 'vertragsnummer', area: 'private' })).notes.length, 0);
    const got = (await h.ok(ANNA, 'GET', 'notes/' + n.note.id)).note;
    const keys = (await h.ok(ANNA, 'GET', `vaults/${v.id}/keys`, null, { deviceId: v.d.id })).keys;
    const tk = await VC.unwrapKey(keys[0].wrap, v.d.privateKey, v.d.raw, v.id, 1);
    const m = new Map([[1, tk]]);
    assert.equal(await VC.decryptName(m, v.id, got.titleCipher), 'Kfz-Police');
    const bytes = Buffer.from(got.cipher, 'base64url');
    assert.equal(Buffer.from(join(await VC.decryptContent(m, v.id, (a, b) => Promise.resolve(bytes.subarray(a, b + 1)), bytes.length))).toString(), 'Vertragsnummer 4711-0815 #geheim');
    // Marc becomes a member; his device asks, Anna compares and approves
    await h.ok(ANNA, 'PUT', `notebooks/${v.nb.id}/members`, { members: [MARC.id] });
    const md = await device();
    const ask = await h.ok(MARC, 'POST', `vaults/${v.id}/devices`, { publicKey: md.pub, name: 'Marcs Handy', platform: 'android' });
    assert.equal(ask.device.state, 'pending');
    assert.ok(h.host.notifications.some((x) => x.topic === 'vault' && x.users.includes(ANNA.id)));
    assert.equal((await h.ok(MARC, 'GET', `vaults/${v.id}/keys`, null, { deviceId: md.id })).state, 'pending');
    assert.equal((await h.call(MARC, 'POST', `vaults/${v.id}/devices/${md.id}/approve`, { wrap: await VC.wrapKey(tk, md.raw, v.id, 1) })).status, 403, 'not by itself');
    await h.ok(ANNA, 'POST', `vaults/${v.id}/devices/${md.id}/approve`, { wraps: [{ keyVersion: 1, wrap: await VC.wrapKey(tk, md.raw, v.id, 1) }] });
    assert.equal((await h.ok(MARC, 'GET', `vaults/${v.id}/keys`, null, { deviceId: md.id })).keys.length, 1);
    assert.equal((await h.call(BOB, 'GET', `vaults/${v.id}`)).status, 404);
    // Anna's new browser opens it with the recovery key
    const ad = await device();
    await h.ok(ANNA, 'POST', `vaults/${v.id}/devices`, { publicKey: ad.pub });
    const rec = await h.ok(ANNA, 'GET', `vaults/${v.id}/recovery`);
    const rkp = await VC.recoveryKeyPair(VC.parseRecoveryKey(v.rec.text));
    assert.equal(VC.b64u(rkp.publicRaw), rec.recoveryPub);
    const rtk = await VC.unwrapKey(rec.keys[0].wrap, rkp.privateKey, rkp.publicRaw, v.id, 1);
    const wrong = await h.call(ANNA, 'POST', `vaults/${v.id}/devices/${ad.id}/approve`, { wrap: await VC.wrapKey(rtk, ad.raw, v.id, 1), via: 'recovery', recoveryAuth: VC.b64u(crypto.randomBytes(32)) });
    assert.equal(wrong.status, 403);
    await h.ok(ANNA, 'POST', `vaults/${v.id}/devices/${ad.id}/approve`, { wrap: await VC.wrapKey(rtk, ad.raw, v.id, 1), via: 'recovery', recoveryAuth: await VC.recoveryAuth(VC.parseRecoveryKey(v.rec.text)) });
    // Marc leaves: his device is revoked, the Tresor wants a new key; the rotation must name exactly the approved devices
    await h.ok(ANNA, 'PUT', `notebooks/${v.nb.id}/members`, { members: [] });
    const vv = (await h.ok(ANNA, 'GET', `vaults/${v.id}`)).vault;
    assert.equal(vv.needsRotation, true);
    const tk2 = VC.newVaultKey();
    const short = await h.call(ANNA, 'POST', `vaults/${v.id}/rotate`, { keyVersion: 2, wraps: [{ deviceId: v.d.id, wrap: await VC.wrapKey(tk2, v.d.raw, v.id, 2) }], recoveryWrap: await VC.wrapKey(tk2, rkp.publicRaw, v.id, 2) });
    assert.equal(short.status, 409);
    assert.deepEqual(short.json.devices.sort(), [v.d.id, ad.id].sort());
    const ok = await h.ok(ANNA, 'POST', `vaults/${v.id}/rotate`, { keyVersion: 2, wraps: [{ deviceId: v.d.id, wrap: await VC.wrapKey(tk2, v.d.raw, v.id, 2) }, { deviceId: ad.id, wrap: await VC.wrapKey(tk2, ad.raw, v.id, 2) }], recoveryWrap: await VC.wrapKey(tk2, rkp.publicRaw, v.id, 2) });
    assert.equal(ok.vault.keyVersion, 2);
    assert.equal(ok.vault.needsRotation, false);
    assert.equal((await h.call(MARC, 'GET', `vaults/${v.id}/keys`, null, { deviceId: md.id })).status, 404);
    // the server never stored a plaintext, a key or the recovery key
    const db = h.host.gc.db;
    const tables = (await db.query("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => r.name);
    const needles = ['Kfz-Police', 'Vertragsnummer', 'Versicherungen', Buffer.from(tk).toString('base64url'), Buffer.from(tk2).toString('base64url'), Buffer.from(v.tk).toString('hex'), v.rec.text];
    for (const t of tables) {
      const rows = (await db.query(`SELECT * FROM "${t}"`)).rows;
      const all = JSON.stringify(rows);
      for (const s of needles) assert.ok(!all.includes(s), `${t} holds ${s}`);
    }
  } finally { await h.close(); }
});

test('Tresor: switched off by the administrator; bad shapes are refused', async () => {
  const h = await withHost({ settings: { vaults: false } });
  try {
    const r = await h.call(ANNA, 'POST', 'vaults', { id: VC.newVaultId() });
    assert.equal(r.status, 403);
    await h.host.saveSettings({ vaults: true });
    assert.equal((await h.call(ANNA, 'POST', 'vaults', { id: 'kurz' })).status, 400);
    assert.equal((await h.call(ANNA, 'POST', 'vaults', { id: VC.newVaultId(), nameCipher: 'AAAA' })).status, 400);
  } finally { await h.close(); }
});

test('DS Note into a Tresor: the device sends ciphertext only (notes and attachments)', async () => {
  const h = await withHost();
  try {
    const v = await makeVault(h, ANNA, 'Versicherungen (DS Note)');
    const job = (await h.ok(ANNA, 'POST', 'import/dsnote/start', { file: 'x.nsx', notebooks: 1, notes: 1 })).job;
    const data = await VC.encryptContent(v.tk, v.id, 1, new TextEncoder().encode('PDF bytes'));
    const up = await h.host.upload({ ...ANNA, portal: true, loggedIn: true }, join(data), 'application/octet-stream');
    const note = { ref: 'N4note4', titleCipher: await VC.encryptName(v.tk, v.id, 1, 'Versicherungen'), cipher: VC.b64u(join(await VC.encryptContent(v.tk, v.id, 1, new TextEncoder().encode('Police 4711')))),
      keyVersion: 1, created: 1750000000000, attachments: [{ n: 0, mediaId: up.body.mediaId, nameCipher: await VC.encryptName(v.tk, v.id, 1, 'Police.pdf') }] };
    const r = await h.ok(ANNA, 'POST', `import/dsnote/${job.id}/notes`, { notebookId: v.nb.id, notes: [note] });
    assert.equal(r.imported, 1);
    const got = (await h.ok(ANNA, 'GET', 'notes/' + r.ids.N4note4)).note;
    assert.equal(got.encrypted, true);
    assert.equal(got.attachments[0].encrypted, true);
    assert.equal(got.attachments[0].name, null);
    assert.equal(got.createdAt, 1750000000000);
    const plain = await h.ok(ANNA, 'POST', `import/dsnote/${job.id}/notes`, { notebookId: v.nb.id, notes: [{ ref: 'x1', title: 'klar', body: 'text' }] });
    assert.deepEqual([plain.imported, plain.skipped], [0, 1], 'plain text never goes into a Tresor');
  } finally { await h.close(); }
});

test('Tresor offline (1.1.0): a note made with a clientId once, ciphertext sent twice is harmless, a stale rev or key is refused', async () => {
  const h = await withHost();
  try {
    const v = await makeVault(h, ANNA, 'Privat');
    const enc = async (s) => VC.b64u(join(await VC.encryptContent(v.tk, v.id, 1, new TextEncoder().encode(s))));
    const body = { notebookId: v.nb.id, titleCipher: await VC.encryptName(v.tk, v.id, 1, 'PIN'), cipher: await enc('1234'), keyVersion: 1, clientId: 'f00dbabe-0000-4000-8000-000000000001' };
    const a = await h.ok(ANNA, 'POST', 'notes', body);
    const b = await h.ok(ANNA, 'POST', 'notes', body);
    assert.equal(b.note.id, a.note.id);
    assert.equal(b.replayed, true);
    const rev = a.note.rev;
    const edit = { cipher: await enc('5678'), keyVersion: 1, rev };
    await h.ok(ANNA, 'PATCH', 'notes/' + a.note.id, edit);
    assert.equal((await h.ok(ANNA, 'PATCH', 'notes/' + a.note.id, edit)).note.rev, rev + 1, 'the same ciphertext again: nothing written');
    const c = await h.call(ANNA, 'PATCH', 'notes/' + a.note.id, { cipher: await enc('0000'), keyVersion: 1, rev });
    assert.deepEqual([c.status, c.json.code], [409, 'conflict']);
    const k = await h.call(ANNA, 'PATCH', 'notes/' + a.note.id, { cipher: await enc('0000'), keyVersion: 2 });
    assert.deepEqual([k.status, k.json.code, k.json.keyVersion], [409, 'stale_key', 1]);
    // a device asks: the push names the Tresor and the notebook
    const d = await device();
    await h.ok(ANNA, 'POST', `vaults/${v.id}/devices`, { publicKey: d.pub, name: 'Neues Handy', platform: 'android' });
    const p = h.host.notifications.filter((x) => x.topic === 'vault').map((x) => x.data.notizen);
    assert.deepEqual(p, [{ kind: 'vault_request', vaultId: v.id, notebookId: v.nb.id, deviceId: d.id, area: 'private', vault: v.id, notebook: v.nb.id, event: 'request' }]);
  } finally { await h.close(); }
});
