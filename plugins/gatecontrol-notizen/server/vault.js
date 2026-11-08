'use strict';

// Tresor notebooks — end-to-end encrypted with Drive's vault format (README "Tresor-Notizbücher – Kryptografie",
// ui/vaultcrypto.js with the label prefix "gcnotes-v1"). The server keeps only ciphertext (titles, Markdown, attachment
// names and bytes), public keys of the devices and the notebook key wrapped for each approved device and for the
// recovery key. Who may use a Tresor: its members (notebook_members). The API mirrors Drive's vaults/… routes.

const crypto = require('node:crypto');
const store = require('./store');
const config = require('./config');
const notes = require('./notes');
const events = require('./events');
const { t } = require('./text');
const { fail, line, area: areaOf } = require('./util');

const PREFIX = 'gcnotes-v1';
const VAULT_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const RECOVERY = 'recovery';
const WRAP_BYTES = 81;
const NAME_MIN = 1 + 4 + 12 + 32 + 16;
const NAME_MAX = 1 + 4 + 12 + 1024 + 16;
const DEVICES_MAX = 200;
const KV_MAX = 1000000;

function b64(v, bytes, field) {
  if (typeof v !== 'string' || !B64URL_RE.test(v)) throw fail('invalid', { field });
  const buf = Buffer.from(v, 'base64url');
  if ((bytes != null && buf.length !== bytes) || buf.toString('base64url') !== v) throw fail('invalid', { field });
  return buf;
}
function pubArg(v, field = 'publicKey') { const b = b64(v, 32, field); if (b.every((x) => x === 0)) throw fail('invalid', { field }); return v; }
function wrapArg(v, field = 'wrap') { const b = b64(v, WRAP_BYTES, field); if (b[0] !== 1) throw fail('invalid', { field }); return v; }
function nameCipherArg(v, field = 'nameCipher') {
  if (typeof v !== 'string' || v.length > 2000) throw fail('invalid', { field });
  const buf = b64(v, null, field);
  if (buf.length < NAME_MIN || buf.length > NAME_MAX || (buf.length - 33) % 32 !== 0 || buf[0] !== 1) throw fail('invalid', { field });
  return v;
}
const nameVersion = (v) => Buffer.from(v, 'base64url').readUInt32BE(1);
const authHash = (v, field = 'recoveryAuth') => crypto.createHash('sha256').update(b64(v, 32, field)).digest('hex');
function authOk(v, hash) {
  if (typeof v !== 'string' || typeof hash !== 'string') return false;
  let got;
  try { got = Buffer.from(authHash(v), 'hex'); } catch { return false; }
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
/** base64url(SHA-256("gcnotes-v1:device:" ‖ public key)[0..16]) — the devices compute the same. */
function deviceIdOf(pub) {
  return crypto.createHash('sha256').update(Buffer.concat([Buffer.from(PREFIX + ':device:'), Buffer.from(pub, 'base64url')])).digest().subarray(0, 16).toString('base64url');
}
function kvArg(v, field = 'keyVersion') {
  const n = typeof v === 'string' && /^\d{1,7}$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 1 || n > KV_MAX) throw fail('invalid', { field });
  return n;
}
function deviceArg(d) {
  if (!d || typeof d !== 'object') throw fail('invalid', { field: 'device' });
  const publicKey = pubArg(d.publicKey, 'device.publicKey');
  return { id: deviceIdOf(publicKey), publicKey, name: d.name == null ? null : line(d.name, 80) || null, platform: typeof d.platform === 'string' && /^[a-z]{1,16}$/.test(d.platform) ? d.platform : null };
}

/** The Tresor `id` (its vault id) the person is a member of → the notebook row. */
async function reach(gc, ctx, id) {
  if (typeof id !== 'string' || !VAULT_ID_RE.test(id)) throw fail('not_found');
  const nb = await store.one(gc, `SELECT b.*, m.role AS my_role FROM notebooks b JOIN notebook_members m ON m.notebook_id = b.id AND m.user_id = ?
    WHERE b.vault_id = ? AND b.deleted_at IS NULL`, [ctx.userId, id]);
  if (!nb) throw fail('not_found');
  return refresh(gc, ctx, nb);
}

/** Devices of people who are no longer members are revoked; the notebook then asks for a new key. */
async function refresh(gc, ctx, nb) {
  const out = await store.all(gc, `SELECT d.device_id FROM vault_devices d WHERE d.notebook_id = ? AND d.state <> 'revoked'
    AND NOT EXISTS (SELECT 1 FROM notebook_members m WHERE m.notebook_id = d.notebook_id AND m.user_id = d.user_id)`, [nb.id]);
  if (!out.length) return nb;
  await store.tx(gc, async () => {
    for (const d of out) {
      await store.run(gc, "UPDATE vault_devices SET state = 'revoked', revoked_at = ? WHERE notebook_id = ? AND device_id = ?", [ctx.now, nb.id, d.device_id]);
      await store.run(gc, 'DELETE FROM vault_keys WHERE notebook_id = ? AND device_id = ?', [nb.id, d.device_id]);
    }
    await store.run(gc, 'UPDATE notebooks SET needs_rotation = 1 WHERE id = ?', [nb.id]);
  });
  return { ...nb, needs_rotation: 1 };
}

const deviceView = (d) => ({
  deviceId: d.device_id, userId: d.user_id, name: d.name || null, platform: d.platform || null, publicKey: d.public_key, state: d.state, via: d.via || null,
  createdAt: d.created_at, approvedAt: d.approved_at || null, approvedBy: d.approved_by || null, revokedAt: d.revoked_at || null,
});

async function view(gc, ctx, nb) {
  const devs = await store.all(gc, 'SELECT * FROM vault_devices WHERE notebook_id = ? ORDER BY created_at, device_id', [nb.id]);
  const mine = devs.filter((d) => d.user_id === ctx.userId);
  return {
    id: nb.vault_id, notebookId: nb.id, area: nb.area, nameCipher: nb.name_cipher, keyVersion: nb.key_version, recoveryPub: nb.recovery_pub,
    recoveryHolder: nb.recovery_holder || null, needsRotation: !!nb.needs_rotation, rotatedAt: nb.rotated_at || null, createdAt: nb.created_at,
    myDevices: mine.map((d) => ({ deviceId: d.device_id, state: d.state, name: d.name || null })),
    pending: mine.some((d) => d.state === 'approved') ? devs.filter((d) => d.state === 'pending').length : 0,
  };
}

function putWrap(gc, nbId, deviceId, kv, wrap) {
  return store.run(gc, `INSERT INTO vault_keys (notebook_id, device_id, key_version, wrap) VALUES (?, ?, ?, ?)
    ON CONFLICT(notebook_id, device_id, key_version) DO UPDATE SET wrap = excluded.wrap`, [nbId, deviceId, kv, wrap]);
}

/** POST vaults { id, area, nameCipher, recoveryPub, recoveryAuth, recoveryWrap, device: { publicKey, name, platform }, wrap } → { vault, notebook } */
async function create(gc, ctx, b) {
  const cfg = await config.get(gc);
  if (!cfg.vaults) throw fail('forbidden', { reason: 'vaults_off' });
  if (!b || typeof b.id !== 'string' || !VAULT_ID_RE.test(b.id)) throw fail('invalid', { field: 'id' });
  const nameCipher = nameCipherArg(b.nameCipher);
  if (nameVersion(nameCipher) !== 1) throw fail('invalid', { field: 'nameCipher' });
  const recoveryPub = pubArg(b.recoveryPub, 'recoveryPub');
  const recoveryWrap = wrapArg(b.recoveryWrap, 'recoveryWrap');
  const recoveryAuth = authHash(b.recoveryAuth);
  const dev = deviceArg(b.device);
  const wrap = wrapArg(b.wrap);
  if (await store.one(gc, 'SELECT 1 AS x FROM notebooks WHERE vault_id = ?', [b.id])) throw fail('conflict', { reason: 'exists' });
  const made = await notes.createNotebook(gc, ctx, { name: '', area: areaOf(b.area), color: b.color }, {
    vault: { id: b.id, nameCipher, recoveryPub, recoveryAuth },
    inTx: async (nbId) => {
      await store.run(gc, `INSERT INTO vault_devices (notebook_id, device_id, user_id, public_key, name, platform, state, via, created_at, approved_at, approved_by)
        VALUES (?, ?, ?, ?, ?, ?, 'approved', 'create', ?, ?, ?)`, [nbId, dev.id, ctx.userId, dev.publicKey, dev.name, dev.platform, ctx.now, ctx.now, ctx.userId]);
      await putWrap(gc, nbId, dev.id, 1, wrap);
      await putWrap(gc, nbId, RECOVERY, 1, recoveryWrap);
    },
  });
  const nb = await reach(gc, ctx, b.id);
  return { vault: await view(gc, ctx, nb), notebook: made.notebook };
}

async function list(gc, ctx) {
  const rows = await store.all(gc, `SELECT b.*, m.role AS my_role FROM notebook_members m JOIN notebooks b ON b.id = m.notebook_id AND b.deleted_at IS NULL AND b.vault_id IS NOT NULL
    WHERE m.user_id = ? ORDER BY b.id`, [ctx.userId]);
  const out = [];
  for (const r of rows) out.push(await view(gc, ctx, await refresh(gc, ctx, r)));
  return { vaults: out };
}
async function get(gc, ctx, id) { return { vault: await view(gc, ctx, await reach(gc, ctx, id)) }; }

async function keys(gc, ctx, id, q) {
  const nb = await reach(gc, ctx, id);
  const deviceId = q && typeof q.deviceId === 'string' && DEVICE_ID_RE.test(q.deviceId) ? q.deviceId : null;
  if (!deviceId) throw fail('invalid', { field: 'deviceId' });
  const d = await store.one(gc, 'SELECT * FROM vault_devices WHERE notebook_id = ? AND device_id = ?', [nb.id, deviceId]);
  if (!d || d.user_id !== ctx.userId) throw fail('not_found');
  if (d.state !== 'approved') return { deviceId, state: d.state, keyVersion: nb.key_version, keys: [] };
  const rows = await store.all(gc, 'SELECT key_version, wrap FROM vault_keys WHERE notebook_id = ? AND device_id = ? ORDER BY key_version', [nb.id, deviceId]);
  return { deviceId, state: d.state, keyVersion: nb.key_version, keys: rows.map((r) => ({ keyVersion: r.key_version, wrap: r.wrap })) };
}

async function recovery(gc, ctx, id) {
  const nb = await reach(gc, ctx, id);
  const rows = await store.all(gc, 'SELECT key_version, wrap FROM vault_keys WHERE notebook_id = ? AND device_id = ? ORDER BY key_version', [nb.id, RECOVERY]);
  return { recoveryPub: nb.recovery_pub, keyVersion: nb.key_version, keys: rows.map((r) => ({ keyVersion: r.key_version, wrap: r.wrap })) };
}

async function devices(gc, ctx, id) {
  const nb = await reach(gc, ctx, id);
  return { devices: (await store.all(gc, 'SELECT * FROM vault_devices WHERE notebook_id = ? ORDER BY created_at, device_id', [nb.id])).map(deviceView) };
}

/** POST vaults/<id>/devices { publicKey, name, platform } → { device } — the others with an approved device get a push. */
async function ask(gc, ctx, id, b) {
  const nb = await reach(gc, ctx, id);
  const dev = deviceArg(b);
  const have = await store.one(gc, 'SELECT * FROM vault_devices WHERE notebook_id = ? AND device_id = ?', [nb.id, dev.id]);
  if (have && have.user_id !== ctx.userId) throw fail('conflict');
  if (have && have.state !== 'revoked') return { device: deviceView(have) };
  const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM vault_devices WHERE notebook_id = ?', [nb.id]);
  if (!have && n.n >= DEVICES_MAX) throw fail('too_many');
  await store.run(gc, `INSERT INTO vault_devices (notebook_id, device_id, user_id, public_key, name, platform, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(notebook_id, device_id) DO UPDATE SET state = 'pending', name = excluded.name, platform = excluded.platform, created_at = excluded.created_at,
      approved_at = NULL, approved_by = NULL, via = NULL, revoked_at = NULL`, [nb.id, dev.id, ctx.userId, dev.publicKey, dev.name, dev.platform, ctx.now]);
  const users = (await store.all(gc, "SELECT DISTINCT user_id FROM vault_devices WHERE notebook_id = ? AND state = 'approved'", [nb.id])).map((r) => r.user_id);
  if (users.length) {
    await gc.events.emit({ users, type: 'vault', data: { vault: nb.vault_id, event: 'request', device: dev.id } }).catch(() => {});
    await gc.notify({ topic: 'vault', users, collapseKey: `notes-vault:${nb.vault_id}:${dev.id}`, title: t(ctx.notifyLang, 'n.vault_request_title'),
      body: t(ctx.notifyLang, 'n.vault_request_body', { who: ctx.userName || '', device: dev.name || t(ctx.notifyLang, 'n.vault_device') }),
      data: { notizen: { vault: nb.vault_id, notebook: nb.id, event: 'request' } } }).catch(() => {});
  }
  return { device: deviceView(await store.one(gc, 'SELECT * FROM vault_devices WHERE notebook_id = ? AND device_id = ?', [nb.id, dev.id])) };
}

function wrapsArg(b, current) {
  const l = Array.isArray(b.wraps) ? b.wraps : (b.wrap != null ? [{ keyVersion: current, wrap: b.wrap }] : null);
  if (!l || !l.length || l.length > current) throw fail('invalid', { field: 'wraps' });
  const out = new Map();
  for (const w of l) {
    const kv = kvArg(w && w.keyVersion, 'wraps');
    if (kv > current || out.has(kv)) throw fail('invalid', { field: 'wraps' });
    out.set(kv, wrapArg(w.wrap, 'wraps'));
  }
  if (!out.has(current)) throw fail('invalid', { field: 'wraps' });
  return out;
}

async function approve(gc, ctx, id, deviceId, b0) {
  const b = b0 && typeof b0 === 'object' ? b0 : {};
  const nb = await reach(gc, ctx, id);
  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) throw fail('not_found');
  const d = await store.one(gc, 'SELECT * FROM vault_devices WHERE notebook_id = ? AND device_id = ?', [nb.id, deviceId]);
  if (!d || d.state === 'revoked') throw fail('not_found');
  const mine = await store.one(gc, "SELECT 1 AS x FROM vault_devices WHERE notebook_id = ? AND user_id = ? AND state = 'approved' LIMIT 1", [nb.id, ctx.userId]);
  const recovered = b.via === 'recovery' && d.user_id === ctx.userId && authOk(b.recoveryAuth, nb.recovery_auth);
  if (b.via === 'recovery' && !recovered) throw fail('forbidden', { reason: 'recovery_auth' });
  if (!mine && !recovered) throw fail('forbidden');
  const wraps = wrapsArg(b, nb.key_version);
  await store.tx(gc, async () => {
    for (const [kv, w] of wraps) await putWrap(gc, nb.id, d.device_id, kv, w);
    if (d.state !== 'approved') await store.run(gc, "UPDATE vault_devices SET state = 'approved', approved_at = ?, approved_by = ?, via = ? WHERE notebook_id = ? AND device_id = ?",
      [ctx.now, ctx.userId, recovered ? 'recovery' : 'device', nb.id, d.device_id]);
  });
  await gc.events.emit({ users: [d.user_id], type: 'vault', data: { vault: nb.vault_id, event: 'approved', device: d.device_id } }).catch(() => {});
  return { device: deviceView(await store.one(gc, 'SELECT * FROM vault_devices WHERE notebook_id = ? AND device_id = ?', [nb.id, d.device_id])) };
}

async function revoke(gc, ctx, id, deviceId) {
  const nb = await reach(gc, ctx, id);
  const d = typeof deviceId === 'string' && DEVICE_ID_RE.test(deviceId) ? await store.one(gc, 'SELECT * FROM vault_devices WHERE notebook_id = ? AND device_id = ?', [nb.id, deviceId]) : null;
  if (!d) throw fail('not_found');
  const mine = await store.one(gc, "SELECT 1 AS x FROM vault_devices WHERE notebook_id = ? AND user_id = ? AND state = 'approved' LIMIT 1", [nb.id, ctx.userId]);
  if (!mine && d.user_id !== ctx.userId) throw fail('forbidden');
  if (d.state !== 'revoked') {
    await store.tx(gc, async () => {
      await store.run(gc, "UPDATE vault_devices SET state = 'revoked', revoked_at = ? WHERE notebook_id = ? AND device_id = ?", [ctx.now, nb.id, d.device_id]);
      await store.run(gc, 'DELETE FROM vault_keys WHERE notebook_id = ? AND device_id = ?', [nb.id, d.device_id]);
      if (d.state === 'approved') await store.run(gc, 'UPDATE notebooks SET needs_rotation = 1 WHERE id = ?', [nb.id]);
    });
  }
  return { device: deviceView(await store.one(gc, 'SELECT * FROM vault_devices WHERE notebook_id = ? AND device_id = ?', [nb.id, d.device_id])) };
}

/** POST vaults/<id>/rotate { keyVersion, wraps: [{ deviceId, wrap }], recoveryWrap | recovery: { pub, auth, wraps } } */
async function rotate(gc, ctx, id, b0) {
  const b = b0 && typeof b0 === 'object' ? b0 : {};
  const nb = await reach(gc, ctx, id);
  const mine = await store.one(gc, "SELECT 1 AS x FROM vault_devices WHERE notebook_id = ? AND user_id = ? AND state = 'approved' LIMIT 1", [nb.id, ctx.userId]);
  if (!mine) throw fail('forbidden');
  const next = kvArg(b.keyVersion);
  if (next !== nb.key_version + 1) throw fail('conflict', { keyVersion: nb.key_version });
  const want = (await store.all(gc, "SELECT device_id FROM vault_devices WHERE notebook_id = ? AND state = 'approved' ORDER BY device_id", [nb.id])).map((d) => d.device_id);
  const wraps = new Map();
  for (const w of Array.isArray(b.wraps) ? b.wraps : []) {
    if (!w || typeof w.deviceId !== 'string' || !DEVICE_ID_RE.test(w.deviceId) || wraps.has(w.deviceId)) throw fail('invalid', { field: 'wraps' });
    wraps.set(w.deviceId, wrapArg(w.wrap, 'wraps'));
  }
  if (wraps.size !== want.length || want.some((x) => !wraps.has(x))) throw fail('conflict', { devices: want });
  let rec = null;
  if (b.recovery != null) {
    const r = b.recovery;
    rec = { pub: pubArg(r && r.pub, 'recovery.pub'), auth: authHash(r && r.auth, 'recovery.auth'), wraps: wrapsArg({ wraps: r && r.wraps }, next) };
    if (rec.wraps.size !== next) throw fail('invalid', { field: 'recovery.wraps' });
  } else {
    const holder = nb.recovery_holder ? await store.one(gc, 'SELECT 1 AS x FROM notebook_members WHERE notebook_id = ? AND user_id = ?', [nb.id, nb.recovery_holder]) : true;
    if (!holder) throw fail('conflict', { reason: 'recovery_required' });
    wrapArg(b.recoveryWrap, 'recoveryWrap');
  }
  await store.tx(gc, async () => {
    for (const [dev, w] of wraps) await putWrap(gc, nb.id, dev, next, w);
    if (rec) {
      await store.run(gc, 'DELETE FROM vault_keys WHERE notebook_id = ? AND device_id = ?', [nb.id, RECOVERY]);
      for (const [kv, w] of rec.wraps) await putWrap(gc, nb.id, RECOVERY, kv, w);
      await store.run(gc, 'UPDATE notebooks SET recovery_pub = ?, recovery_auth = ?, recovery_holder = ? WHERE id = ?', [rec.pub, rec.auth, ctx.userId, nb.id]);
    } else await putWrap(gc, nb.id, RECOVERY, next, b.recoveryWrap);
    await store.run(gc, 'UPDATE notebooks SET key_version = ?, needs_rotation = 0, rotated_at = ? WHERE id = ?', [next, ctx.now, nb.id]);
  });
  events.changed(gc, await notes.memberIds(gc, nb.id), 'notebooks');
  return { vault: await view(gc, ctx, await reach(gc, ctx, id)) };
}

/** PUT vaults/<id>/recovery { pub, auth, wraps } — a new recovery key (every key version wrapped for it). */
async function setRecovery(gc, ctx, id, b0) {
  const b = b0 && typeof b0 === 'object' ? b0 : {};
  const nb = await reach(gc, ctx, id);
  const mine = await store.one(gc, "SELECT 1 AS x FROM vault_devices WHERE notebook_id = ? AND user_id = ? AND state = 'approved' LIMIT 1", [nb.id, ctx.userId]);
  if (!mine) throw fail('forbidden');
  const pub = pubArg(b.pub, 'pub');
  const auth = authHash(b.auth, 'auth');
  const rw = wrapsArg({ wraps: b.wraps }, nb.key_version);
  if (rw.size !== nb.key_version) throw fail('invalid', { field: 'wraps' });
  await store.tx(gc, async () => {
    await store.run(gc, 'DELETE FROM vault_keys WHERE notebook_id = ? AND device_id = ?', [nb.id, RECOVERY]);
    for (const [kv, w] of rw) await putWrap(gc, nb.id, RECOVERY, kv, w);
    await store.run(gc, 'UPDATE notebooks SET recovery_pub = ?, recovery_auth = ?, recovery_holder = ? WHERE id = ?', [pub, auth, ctx.userId, nb.id]);
  });
  return { vault: await view(gc, ctx, await reach(gc, ctx, id)) };
}

module.exports = { PREFIX, deviceIdOf, create, list, get, keys, recovery, devices, ask, approve, revoke, rotate, setRecovery, nameCipherArg, nameVersion };
