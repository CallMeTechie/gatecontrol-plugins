'use strict';

// Vault folders (since 1.9.0, feature `vault`) — end-to-end encrypted: the devices encrypt contents and names
// (AES-256-GCM) before they upload; this server keeps only what it cannot read: ciphertext, sizes, times, public keys
// and the vault key wrapped for each device. The exact format is README.md "Tresor-Ordner – Kryptografie" (also
// ui/vaultcrypto.js, the portal's implementation, and its test vectors) — every app builds it from there.
//
// A vault is a folder (nodes.vault_id = its id on the folder and on everything below it). Who may use it: whoever
// reads its area (areas.js). Its key (TK, 32 random bytes, a new version on each rotation) lies here only wrapped:
//   * for each approved device of such a person (vault_devices: X25519 public key; vault_wraps: one wrap per key
//     version) — HPKE base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM;
//   * for the recovery key (device 'recovery': its X25519 public key derived from the 56 characters a person wrote
//     down when the vault was made; the server keeps the SHA-256 of the key's proof, recoveryAuth — HKDF of the key).
// A new device asks (POST vaults/<id>/devices → pending, a push to the people with an approved device); an approved
// device of anyone who reads the area compares the safety number and wraps the keys for it (…/approve) — or the
// person opens it with the recovery key and approves the device themselves (with the recovery key's proof). Losing the area (a person leaves the
// family or the team, a parent may no longer look in) revokes that person's devices and asks for a new key
// (needsRotation): POST vaults/<id>/rotate wraps a new version for exactly the remaining devices; new files get it,
// older ones stay readable for those who had the old one.
//
// The server never gets a plaintext or an unwrapped key — it checks only shapes and sizes (the tests prove it never
// stores anything else). Folders and files of a vault have an opaque name here (32 hex characters, also on a NAS) and
// the encrypted name in name_cipher; no previews, no recognised text, no search, no public links, no albums, no photo
// frame, no office; the trash and the time travel work.

const crypto = require('node:crypto');
const store = require('./store');
const areas = require('./areas');
const nodes = require('./nodes');
const { fail, line, iso } = require('./util');

const VAULT_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const RECOVERY = 'recovery';
const PUB_BYTES = 32;
const WRAP_BYTES = 1 + 32 + 32 + 16; // version ‖ enc (X25519 public key) ‖ AES-256-GCM(TK) with its tag
const NAME_MIN = 1 + 4 + 12 + 32 + 16; // version ‖ key version ‖ nonce ‖ ≥ one padded block ‖ tag
const NAME_MAX = 1 + 4 + 12 + 1024 + 16;
const OPAQUE_RE = /^[0-9a-f]{32}$/;
const DEVICES_MAX = 200;
const KEY_VERSION_MAX = 1000000;

// ─── Shapes (README "Tresor-Ordner – Kryptografie") ─────

function b64(v, bytes, field) {
  if (typeof v !== 'string' || !B64URL_RE.test(v)) throw fail('invalid', { field });
  const buf = Buffer.from(v, 'base64url');
  if ((bytes != null && buf.length !== bytes) || buf.toString('base64url') !== v) throw fail('invalid', { field });
  return buf;
}

/** A raw X25519 public key (32 bytes, base64url). */
function pubArg(v, field = 'publicKey') {
  const buf = b64(v, PUB_BYTES, field);
  if (buf.every((x) => x === 0)) throw fail('invalid', { field });
  return v;
}

/** A wrapped vault key: 0x01 ‖ enc (32) ‖ ciphertext (48). */
function wrapArg(v, field = 'wrap') {
  const buf = b64(v, WRAP_BYTES, field);
  if (buf[0] !== 1) throw fail('invalid', { field });
  return v;
}

/** An encrypted name: 0x01 ‖ key version (uint32 BE) ‖ nonce (12) ‖ ciphertext of the padded name (n × 32) ‖ tag (16). */
function nameCipherArg(v, field = 'nameCipher') {
  if (typeof v !== 'string' || v.length > 2000) throw fail('invalid', { field });
  const buf = b64(v, null, field);
  if (buf.length < NAME_MIN || buf.length > NAME_MAX || (buf.length - 33) % 32 !== 0 || buf[0] !== 1) throw fail('invalid', { field });
  const kv = buf.readUInt32BE(1);
  if (kv < 1 || kv > KEY_VERSION_MAX) throw fail('invalid', { field });
  return v;
}

/** The recovery key's proof (32 bytes base64url) → its SHA-256 (hex), what the server keeps. */
function authArg(v, field = 'recoveryAuth') {
  return crypto.createHash('sha256').update(b64(v, 32, field)).digest('hex');
}
const authOk = (v, hash) => {
  if (typeof v !== 'string' || typeof hash !== 'string') return false;
  let got;
  try { got = Buffer.from(authArg(v), 'hex'); } catch { return false; }
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};

/** The key version of an encrypted name (its header). */
const nameVersion = (v) => Buffer.from(v, 'base64url').readUInt32BE(1);

/** The id of a device: base64url(SHA-256("gcdrive-v1:device:" ‖ public key)[0..16]) — the apps compute the same. */
function deviceIdOf(pub) {
  return crypto.createHash('sha256').update(Buffer.concat([Buffer.from('gcdrive-v1:device:'), Buffer.from(pub, 'base64url')])).digest().subarray(0, 16).toString('base64url');
}

/** A new opaque name of a vault node (also its file name on a NAS). */
const opaqueName = () => crypto.randomBytes(16).toString('hex');

const keyVersionArg = (v, field = 'keyVersion') => {
  const n = typeof v === 'string' && /^\d{1,7}$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 1 || n > KEY_VERSION_MAX) throw fail('invalid', { field });
  return n;
};

// ─── Rows ───────────────────────────────────────

async function row(gc, id) {
  return typeof id === 'string' && VAULT_ID_RE.test(id) ? store.one(gc, 'SELECT * FROM vaults WHERE id = ?', [id]) : null;
}

/**
 * The vault `id` the viewer may use (`need`: their least role in its area) → { vault, node, area, role }. A vault in
 * the trash: not_found (its folder comes back with a restore).
 */
async function reach(ctx, id, need = 'read') {
  const v = await row(ctx.gc, id);
  if (!v) throw fail('not_found');
  const n = await nodes.row(ctx.gc, v.node_id);
  if (!n || n.deleted_at != null) throw fail('not_found');
  const r = await areas.roleIn(ctx, n.area_id, need).catch((e) => { throw e.code === 'forbidden' ? e : fail('not_found'); });
  return { vault: v, node: n, area: r.area, role: r.role };
}

/** The vault of node `n` (its own or the one it is in), or null. */
async function of(gc, n) {
  return n && n.vault_id ? row(gc, n.vault_id) : null;
}

/**
 * Devices of people who no longer read the vault's area are revoked (their wraps go) and the vault asks for a new key.
 * Runs before every answer about a vault (people leave a family or a team without Drive being asked). → the vault row
 */
async function refresh(ctx, v, area) {
  const readers = new Set(await areas.readers(ctx.gc, area, ctx.settings));
  const gone = await store.all(ctx.gc, "SELECT device_id, user_id FROM vault_devices WHERE vault_id = ? AND state <> 'revoked'", [v.id]);
  const out = gone.filter((d) => !readers.has(d.user_id));
  if (!out.length) return v;
  await store.tx(ctx.gc, async () => {
    for (const d of out) {
      await store.run(ctx.gc, "UPDATE vault_devices SET state = 'revoked', revoked_at = ? WHERE vault_id = ? AND device_id = ?", [ctx.now, v.id, d.device_id]);
      await store.run(ctx.gc, 'DELETE FROM vault_wraps WHERE vault_id = ? AND device_id = ?', [v.id, d.device_id]);
    }
    await store.run(ctx.gc, 'UPDATE vaults SET needs_rotation = 1 WHERE id = ?', [v.id]);
  });
  return row(ctx.gc, v.id);
}

function deviceView(d) {
  return {
    deviceId: d.device_id, userId: d.user_id, name: d.name || null, platform: d.platform || null, publicKey: d.public_key, state: d.state,
    via: d.via || null, createdAt: iso(d.created_at), approvedAt: iso(d.approved_at), approvedBy: d.approved_by == null ? null : d.approved_by,
    revokedAt: iso(d.revoked_at),
  };
}

/** The vault as a person sees it. */
async function view(ctx, v, n, area) {
  const devs = await store.all(ctx.gc, 'SELECT * FROM vault_devices WHERE vault_id = ? ORDER BY created_at, device_id', [v.id]);
  const mine = devs.filter((d) => d.user_id === ctx.viewer);
  const approved = mine.some((d) => d.state === 'approved');
  return {
    id: v.id, nodeId: v.node_id, areaId: area.id, parentId: n.parent_id, nameCipher: n.name_cipher, keyVersion: v.key_version,
    recoveryPub: v.recovery_pub, recoveryHolder: v.recovery_by == null ? null : v.recovery_by, needsRotation: v.needs_rotation === 1,
    createdAt: iso(v.created_at), createdBy: v.created_by, rotatedAt: iso(v.rotated_at),
    myDevices: mine.map((d) => ({ deviceId: d.device_id, state: d.state, name: d.name || null })),
    // requests an approved device of mine could answer
    pending: approved ? devs.filter((d) => d.state === 'pending').length : 0,
  };
}

// ─── API ────────────────────────────────────────

/**
 * POST vaults { id, parentId, nameCipher, recoveryPub, recoveryAuth, recoveryWrap, device: { publicKey, name, platform }, wrap }
 * → { vault, node }: a new vault folder in the top folder of the area of `parentId` (since 1.11.0 `parentId` only names
 * the area — any folder of it the viewer writes to, not inside a vault), the creating device approved with the wrap of
 * key version 1, the recovery key's wrap.
 */
async function create(ctx, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.id !== 'string' || !VAULT_ID_RE.test(b.id)) throw fail('invalid', { field: 'id' });
  const nameCipher = nameCipherArg(b.nameCipher);
  if (nameVersion(nameCipher) !== 1) throw fail('invalid', { field: 'nameCipher' });
  const recoveryPub = pubArg(b.recoveryPub, 'recoveryPub');
  const recoveryWrap = wrapArg(b.recoveryWrap, 'recoveryWrap');
  const recoveryAuth = authArg(b.recoveryAuth);
  const dev = deviceArg(b.device);
  const wrap = wrapArg(b.wrap);
  const out = await store.tx(ctx.gc, async () => {
    const { node: given, area } = await nodes.folderFor(ctx, Number(b.parentId));
    if (given.vault_id) throw fail('invalid', { field: 'parentId' });
    const parent = given.id === area.root_id ? given : await nodes.row(ctx.gc, area.root_id);
    if (await row(ctx.gc, b.id)) throw fail('exists');
    await nodes.unmarkUp(ctx.gc, parent.id, ctx);
    const r = await store.run(ctx.gc, `INSERT INTO nodes (area_id, parent_id, name, is_dir, created_at, created_by, updated_at, updated_by, vault_id, name_cipher, key_version)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1)`, [area.id, parent.id, opaqueName(), ctx.now, ctx.viewer, ctx.now, ctx.viewer, b.id, nameCipher]);
    const nodeId = Number(r.lastInsertRowid);
    await nodes.log(ctx.gc, area.id, nodeId, 'create', ctx);
    // folder links of the folders above end (they would list the vault's ciphertext — no public links for a vault)
    const up = await store.all(ctx.gc, `WITH RECURSIVE up(id, parent_id) AS (SELECT id, parent_id FROM nodes WHERE id = ?
      UNION ALL SELECT p.id, p.parent_id FROM nodes p JOIN up ON p.id = up.parent_id) SELECT id FROM up`, [parent.id]);
    const u = ctx.unlink || (ctx.unlink = { folders: [], all: [] });
    u.vault = (u.vault || []).concat(up.map((x) => x.id));
    await store.run(ctx.gc, `INSERT INTO vaults (id, node_id, area_id, key_version, recovery_pub, recovery_auth, recovery_by, created_at, created_by)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`, [b.id, nodeId, area.id, recoveryPub, recoveryAuth, ctx.viewer, ctx.now, ctx.viewer]);
    await store.run(ctx.gc, `INSERT INTO vault_devices (vault_id, device_id, user_id, public_key, name, platform, state, created_at, approved_at, approved_by, via)
      VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, 'create')`, [b.id, dev.id, ctx.viewer, dev.publicKey, dev.name, dev.platform, ctx.now, ctx.now, ctx.viewer]);
    await putWrap(ctx, b.id, dev.id, 1, wrap);
    await putWrap(ctx, b.id, RECOVERY, 1, recoveryWrap);
    return { nodeId, area };
  });
  const v = await row(ctx.gc, b.id);
  const n = await nodes.row(ctx.gc, out.nodeId);
  return { vault: await view(ctx, v, n, out.area), node: nodes.view(n) };
}

function deviceArg(d) {
  if (!d || typeof d !== 'object') throw fail('invalid', { field: 'device' });
  const publicKey = pubArg(d.publicKey, 'device.publicKey');
  const name = d.name == null ? null : (line(d.name) || '').slice(0, 80) || null;
  const platform = d.platform == null ? null : (typeof d.platform === 'string' && /^[a-z]{1,16}$/.test(d.platform) ? d.platform : null);
  return { id: deviceIdOf(publicKey), publicKey, name, platform };
}

function putWrap(ctx, vaultId, deviceId, keyVersion, wrap) {
  return store.run(ctx.gc, `INSERT INTO vault_wraps (vault_id, device_id, key_version, wrap, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(vault_id, device_id, key_version) DO UPDATE SET wrap = excluded.wrap, created_at = excluded.created_at, created_by = excluded.created_by`,
  [vaultId, deviceId, keyVersion, wrap, ctx.now, ctx.viewer]);
}

/** GET vaults → { vaults } the viewer may use (their areas, not in the trash). */
async function list(ctx) {
  const ids = (await ctx.visible()).map((x) => x.area.id);
  if (!ids.length) return { vaults: [] };
  const rows = await store.all(ctx.gc, `SELECT v.* FROM vaults v JOIN nodes n ON n.id = v.node_id
    WHERE n.area_id IN (${store.marks(ids.length)}) AND n.deleted_at IS NULL ORDER BY v.created_at`, ids);
  const out = [];
  for (const r of rows) {
    const { vault, node, area } = await reach(ctx, r.id);
    out.push(await view(ctx, await refresh(ctx, vault, area), node, area));
  }
  return { vaults: out };
}

/** GET vaults/<id> → { vault } */
async function get(ctx, id) {
  const { vault, node, area } = await reach(ctx, id);
  return { vault: await view(ctx, await refresh(ctx, vault, area), node, area) };
}

/** GET vaults/<id>/keys?deviceId= → { deviceId, state, keys: [{ keyVersion, wrap }] } — only one of the viewer's own devices. */
async function keys(ctx, id, q) {
  const { vault, area } = await reach(ctx, id);
  await refresh(ctx, vault, area);
  const deviceId = q && typeof q.deviceId === 'string' && DEVICE_ID_RE.test(q.deviceId) ? q.deviceId : null;
  if (!deviceId) throw fail('invalid', { field: 'deviceId' });
  const d = await store.one(ctx.gc, 'SELECT * FROM vault_devices WHERE vault_id = ? AND device_id = ?', [vault.id, deviceId]);
  if (!d || d.user_id !== ctx.viewer) throw fail('not_found');
  if (d.state !== 'approved') return { deviceId, state: d.state, keys: [] };
  await store.run(ctx.gc, 'UPDATE vault_devices SET seen_at = ? WHERE vault_id = ? AND device_id = ?', [ctx.now, vault.id, deviceId]);
  const rows = await store.all(ctx.gc, 'SELECT key_version, wrap FROM vault_wraps WHERE vault_id = ? AND device_id = ? ORDER BY key_version', [vault.id, deviceId]);
  return { deviceId, state: d.state, keyVersion: (await row(ctx.gc, vault.id)).key_version, keys: rows.map((r) => ({ keyVersion: r.key_version, wrap: r.wrap })) };
}

/** GET vaults/<id>/recovery → { recoveryPub, keys } — the recovery key's wraps (useless without the written-down key). */
async function recovery(ctx, id) {
  const { vault } = await reach(ctx, id);
  const rows = await store.all(ctx.gc, 'SELECT key_version, wrap FROM vault_wraps WHERE vault_id = ? AND device_id = ? ORDER BY key_version', [vault.id, RECOVERY]);
  return { recoveryPub: vault.recovery_pub, keyVersion: vault.key_version, keys: rows.map((r) => ({ keyVersion: r.key_version, wrap: r.wrap })) };
}

/** GET vaults/<id>/devices → { devices } — every device of the vault (an approving device needs the public keys). */
async function devices(ctx, id) {
  const { vault, area } = await reach(ctx, id);
  await refresh(ctx, vault, area);
  const rows = await store.all(ctx.gc, 'SELECT * FROM vault_devices WHERE vault_id = ? ORDER BY created_at, device_id', [vault.id]);
  return { devices: rows.map(deviceView) };
}

/**
 * POST vaults/<id>/devices { publicKey, name, platform } → { device } — a device of the viewer asks for the vault
 * (pending; an approved one stays approved). The people with an approved device get a push (after the answer).
 */
async function ask(ctx, id, body) {
  const { vault, area } = await reach(ctx, id);
  await refresh(ctx, vault, area);
  const dev = deviceArg(body);
  const have = await store.one(ctx.gc, 'SELECT * FROM vault_devices WHERE vault_id = ? AND device_id = ?', [vault.id, dev.id]);
  if (have && have.user_id !== ctx.viewer) throw fail('conflict');
  if (have && have.state !== 'revoked') return { device: deviceView(have) };
  const count = await store.one(ctx.gc, 'SELECT COUNT(*) AS n FROM vault_devices WHERE vault_id = ?', [vault.id]);
  if (!have && count.n >= DEVICES_MAX) throw fail('device_limit');
  await store.run(ctx.gc, `INSERT INTO vault_devices (vault_id, device_id, user_id, public_key, name, platform, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(vault_id, device_id) DO UPDATE SET state = 'pending', name = excluded.name, platform = excluded.platform, created_at = excluded.created_at,
      approved_at = NULL, approved_by = NULL, via = NULL, revoked_at = NULL`, [vault.id, dev.id, ctx.viewer, dev.publicKey, dev.name, dev.platform, ctx.now]);
  (ctx.vaultNotes || (ctx.vaultNotes = [])).push({ vault: vault.id, node: vault.node_id, area: area.id, device: dev.id, name: dev.name });
  return { device: deviceView(await store.one(ctx.gc, 'SELECT * FROM vault_devices WHERE vault_id = ? AND device_id = ?', [vault.id, dev.id])) };
}

/** wraps of a body: { wraps: [{ keyVersion, wrap }] } or { wrap } (the current version only) → Map version → wrap */
function wrapsArg(b, current) {
  const list = Array.isArray(b.wraps) ? b.wraps : (b.wrap != null ? [{ keyVersion: current, wrap: b.wrap }] : null);
  if (!list || !list.length || list.length > current) throw fail('invalid', { field: 'wraps' });
  const out = new Map();
  for (const w of list) {
    const kv = keyVersionArg(w && w.keyVersion, 'wraps');
    if (kv > current || out.has(kv)) throw fail('invalid', { field: 'wraps' });
    out.set(kv, wrapArg(w.wrap, 'wraps'));
  }
  if (!out.has(current)) throw fail('invalid', { field: 'wraps' });
  return out;
}

/**
 * POST vaults/<id>/devices/<deviceId>/approve { wraps: [{ keyVersion, wrap }] | wrap, via?, recoveryAuth? } → { device } —
 * the keys wrapped for that device (at least the current version). Who: a person with an approved device of this
 * vault, or the device's own person with the recovery key (via 'recovery' and its proof recoveryAuth — else 403).
 */
async function approve(ctx, id, deviceId, body) {
  const b = body && typeof body === 'object' ? body : {};
  const { vault, area } = await reach(ctx, id);
  const v = await refresh(ctx, vault, area);
  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) throw fail('not_found');
  const d = await store.one(ctx.gc, 'SELECT * FROM vault_devices WHERE vault_id = ? AND device_id = ?', [v.id, deviceId]);
  if (!d || d.state === 'revoked') throw fail('not_found');
  const mine = await store.one(ctx.gc, "SELECT 1 AS x FROM vault_devices WHERE vault_id = ? AND user_id = ? AND state = 'approved' LIMIT 1", [v.id, ctx.viewer]);
  // the recovery key: its proof, and only for one's own device
  const recovered = b.via === 'recovery' && d.user_id === ctx.viewer && authOk(b.recoveryAuth, v.recovery_auth);
  if (b.via === 'recovery' && !recovered) throw fail('forbidden', { reason: 'recovery_auth' });
  if (!mine && !recovered) throw fail('forbidden');
  const wraps = wrapsArg(b, v.key_version);
  const via = recovered ? 'recovery' : 'device';
  await store.tx(ctx.gc, async () => {
    for (const [kv, w] of wraps) await putWrap(ctx, v.id, d.device_id, kv, w);
    if (d.state !== 'approved') {
      await store.run(ctx.gc, "UPDATE vault_devices SET state = 'approved', approved_at = ?, approved_by = ?, via = ? WHERE vault_id = ? AND device_id = ?",
        [ctx.now, ctx.viewer, via, v.id, d.device_id]);
    }
  });
  (ctx.vaultEvents || (ctx.vaultEvents = [])).push({ users: [d.user_id], vault: v.id, event: 'approved', device: d.device_id });
  return { device: deviceView(await store.one(ctx.gc, 'SELECT * FROM vault_devices WHERE vault_id = ? AND device_id = ?', [v.id, d.device_id])) };
}

/**
 * DELETE vaults/<id>/devices/<deviceId> → { device } — a request declined or a device removed: its wraps go. Removing
 * an approved device asks for a new key (needsRotation). Who: the device's person; anyone with an approved device for a
 * request; another person's approved device only with the write right too.
 */
async function revoke(ctx, id, deviceId) {
  const { vault, role } = await reach(ctx, id);
  const d = typeof deviceId === 'string' && DEVICE_ID_RE.test(deviceId) ? await store.one(ctx.gc, 'SELECT * FROM vault_devices WHERE vault_id = ? AND device_id = ?', [vault.id, deviceId]) : null;
  if (!d) throw fail('not_found');
  const mine = await store.one(ctx.gc, "SELECT 1 AS x FROM vault_devices WHERE vault_id = ? AND user_id = ? AND state = 'approved' LIMIT 1", [vault.id, ctx.viewer]);
  if (!mine && d.user_id !== ctx.viewer) throw fail('forbidden');
  if (d.user_id !== ctx.viewer && d.state === 'approved' && !areas.can(role, 'write')) throw fail('forbidden');
  if (d.state !== 'revoked') {
    await store.tx(ctx.gc, async () => {
      await store.run(ctx.gc, "UPDATE vault_devices SET state = 'revoked', revoked_at = ? WHERE vault_id = ? AND device_id = ?", [ctx.now, vault.id, d.device_id]);
      await store.run(ctx.gc, 'DELETE FROM vault_wraps WHERE vault_id = ? AND device_id = ?', [vault.id, d.device_id]);
      if (d.state === 'approved') await store.run(ctx.gc, 'UPDATE vaults SET needs_rotation = 1 WHERE id = ?', [vault.id]);
    });
  }
  return { device: deviceView(await store.one(ctx.gc, 'SELECT * FROM vault_devices WHERE vault_id = ? AND device_id = ?', [vault.id, d.device_id])) };
}

/**
 * POST vaults/<id>/rotate { keyVersion (current + 1), wraps: [{ deviceId, wrap }] (exactly every approved device),
 * recoveryWrap | recovery: { pub, auth, wraps: [{ keyVersion, wrap }] (every version) } } → { vault } — a new vault key. A new
 * recovery key is needed when the person holding the old one no longer reads the area (409 recovery_required).
 */
async function rotate(ctx, id, body) {
  const b = body && typeof body === 'object' ? body : {};
  const { vault, node, area } = await reach(ctx, id, 'write');
  const v = await refresh(ctx, vault, area);
  const mine = await store.one(ctx.gc, "SELECT 1 AS x FROM vault_devices WHERE vault_id = ? AND user_id = ? AND state = 'approved' LIMIT 1", [v.id, ctx.viewer]);
  if (!mine) throw fail('forbidden');
  const next = keyVersionArg(b.keyVersion);
  if (next !== v.key_version + 1) throw fail('conflict', { keyVersion: v.key_version });
  const approved = await store.all(ctx.gc, "SELECT device_id FROM vault_devices WHERE vault_id = ? AND state = 'approved' ORDER BY device_id", [v.id]);
  const list = Array.isArray(b.wraps) ? b.wraps : [];
  const wraps = new Map();
  for (const w of list) {
    if (!w || typeof w.deviceId !== 'string' || !DEVICE_ID_RE.test(w.deviceId) || wraps.has(w.deviceId)) throw fail('invalid', { field: 'wraps' });
    wraps.set(w.deviceId, wrapArg(w.wrap, 'wraps'));
  }
  const want = approved.map((d) => d.device_id);
  if (wraps.size !== want.length || want.some((x) => !wraps.has(x))) throw fail('conflict', { devices: want });
  let rec = null;
  if (b.recovery != null) {
    const r = b.recovery;
    const pub = pubArg(r && r.pub, 'recovery.pub');
    const auth = authArg(r && r.auth, 'recovery.auth');
    const rw = wrapsArg({ wraps: r && r.wraps }, next);
    if (rw.size !== next) throw fail('invalid', { field: 'recovery.wraps' });
    rec = { pub, auth, wraps: rw };
  } else {
    const readers = new Set(await areas.readers(ctx.gc, area, ctx.settings));
    if (v.recovery_by != null && !readers.has(v.recovery_by)) throw fail('conflict', { reason: 'recovery_required' });
    wrapArg(b.recoveryWrap, 'recoveryWrap');
  }
  await store.tx(ctx.gc, async () => {
    for (const [dev, w] of wraps) await putWrap(ctx, v.id, dev, next, w);
    if (rec) {
      await store.run(ctx.gc, 'DELETE FROM vault_wraps WHERE vault_id = ? AND device_id = ?', [v.id, RECOVERY]);
      for (const [kv, w] of rec.wraps) await putWrap(ctx, v.id, RECOVERY, kv, w);
      await store.run(ctx.gc, 'UPDATE vaults SET recovery_pub = ?, recovery_auth = ?, recovery_by = ? WHERE id = ?', [rec.pub, rec.auth, ctx.viewer, v.id]);
    } else {
      await putWrap(ctx, v.id, RECOVERY, next, b.recoveryWrap);
    }
    await store.run(ctx.gc, 'UPDATE vaults SET key_version = ?, needs_rotation = 0, rotated_at = ?, rotated_by = ? WHERE id = ?', [next, ctx.now, ctx.viewer, v.id]);
  });
  (ctx.vaultEvents || (ctx.vaultEvents = [])).push({ area, vault: v.id, event: 'rotated', keyVersion: next });
  return { vault: await view(ctx, await row(ctx.gc, v.id), node, area) };
}

/**
 * PUT vaults/<id>/recovery { pub, auth, wraps: [{ keyVersion, wrap }] (every version) } → { vault } — a new recovery key
 * (the old one was lost): an approved device wraps every key version for it; the person becomes its holder.
 */
async function setRecovery(ctx, id, body) {
  const b = body && typeof body === 'object' ? body : {};
  const { vault, node, area } = await reach(ctx, id, 'write');
  const v = await refresh(ctx, vault, area);
  const mine = await store.one(ctx.gc, "SELECT 1 AS x FROM vault_devices WHERE vault_id = ? AND user_id = ? AND state = 'approved' LIMIT 1", [v.id, ctx.viewer]);
  if (!mine) throw fail('forbidden');
  const pub = pubArg(b.pub, 'pub');
  const auth = authArg(b.auth, 'auth');
  const rw = wrapsArg({ wraps: b.wraps }, v.key_version);
  if (rw.size !== v.key_version) throw fail('invalid', { field: 'wraps' });
  await store.tx(ctx.gc, async () => {
    await store.run(ctx.gc, 'DELETE FROM vault_wraps WHERE vault_id = ? AND device_id = ?', [v.id, RECOVERY]);
    for (const [kv, w] of rw) await putWrap(ctx, v.id, RECOVERY, kv, w);
    await store.run(ctx.gc, 'UPDATE vaults SET recovery_pub = ?, recovery_auth = ?, recovery_by = ? WHERE id = ?', [pub, auth, ctx.viewer, v.id]);
  });
  return { vault: await view(ctx, await row(ctx.gc, v.id), node, area) };
}

// ─── Nodes inside a vault (nodes.js, files.js) ─────

/**
 * What a new node in folder `parent` gets: { vaultId, name (opaque), nameCipher, keyVersion } inside a vault (the body
 * must say encrypted: true and carry nameCipher with the current key version), null outside (encrypted: true there →
 * invalid). `name`: an opaque name the device sends to update a file it has (a new version), else a new one.
 */
async function forNewNode(ctx, parent, b, { needName = true } = {}) {
  const enc = b.encrypted === true || b.encrypted === 'true';
  if (!parent.vault_id) {
    if (enc || b.nameCipher != null) throw fail('invalid', { field: 'encrypted' });
    return null;
  }
  if (!enc) throw fail('invalid', { field: 'encrypted' });
  const v = await row(ctx.gc, parent.vault_id);
  if (!v) throw fail('not_found');
  const kv = keyVersionArg(b.keyVersion);
  if (kv !== v.key_version) throw fail('conflict', { reason: 'stale_key', keyVersion: v.key_version });
  const nameCipher = b.nameCipher == null && !needName ? null : nameCipherArg(b.nameCipher);
  if (nameCipher && nameVersion(nameCipher) !== v.key_version) throw fail('conflict', { reason: 'stale_key', keyVersion: v.key_version });
  let name = null;
  if (b.name != null) {
    if (typeof b.name !== 'string' || !OPAQUE_RE.test(b.name)) throw fail('invalid', { field: 'name' });
    name = b.name;
  }
  return { vaultId: v.id, name: name || opaqueName(), nameCipher, keyVersion: kv };
}

/**
 * Vault folders that are not in the top folder of their area go there (since 1.11.0: the vaults are in the menu, not
 * among the files) — once for the vaults of older versions, then whatever brings one elsewhere (the NAS, an older time).
 * Idempotent; each vault in a transaction of its own; one that fails stays where it is until the next run.
 * → Set of the area ids changed (the live event: changes.announce)
 */
async function toRoots(gc, now = Date.now()) {
  const touched = new Set();
  const rows = await store.all(gc, `SELECT n.* FROM vaults v JOIN nodes n ON n.id = v.node_id JOIN areas a ON a.id = n.area_id
    WHERE n.deleted_at IS NULL AND a.root_id IS NOT NULL AND n.parent_id <> a.root_id ORDER BY n.id LIMIT 100`);
  for (const n of rows) {
    const ctx = { gc, viewer: null, deviceId: null, now, touched: new Set() };
    try {
      const moved = await store.tx(gc, async () => {
        const cur = await nodes.row(gc, n.id);
        const area = cur && cur.deleted_at == null ? await areas.row(gc, cur.area_id) : null;
        return area ? nodes.vaultToRoot(ctx, cur, area) : false;
      });
      if (moved) for (const id of ctx.touched) touched.add(id);
    } catch (e) { gc.log.warn('vault to the top folder failed', (e && e.code) || 'error'); }
  }
  return touched;
}

/** Remove the vault data of nodes `ids` that are vault folders (a purge for good). */
async function forget(gc, ids) {
  for (const part of store.chunks(ids)) {
    const vs = await store.all(gc, `SELECT id FROM vaults WHERE node_id IN (${store.marks(part.length)})`, part);
    for (const v of vs) {
      await store.run(gc, 'DELETE FROM vault_wraps WHERE vault_id = ?', [v.id]);
      await store.run(gc, 'DELETE FROM vault_devices WHERE vault_id = ?', [v.id]);
      await store.run(gc, 'DELETE FROM vaults WHERE id = ?', [v.id]);
    }
  }
}

/** The people with an approved device of the vaults asked for (ctx.vaultNotes) → a push each (after the answer). */
async function announce(gc, ctx, texts) {
  for (const n of ctx.vaultNotes || []) {
    const rows = await store.all(gc, "SELECT DISTINCT user_id FROM vault_devices WHERE vault_id = ? AND state = 'approved'", [n.vault]);
    const users = rows.map((r) => r.user_id);
    if (!users.length) continue;
    try { await gc.events.emit({ users, type: 'vault', data: { vault: n.vault, event: 'request', device: n.device } }); } catch (e) { gc.log.warn('vault event failed', (e && e.code) || 'error'); }
    for (const u of users) {
      const lang = (ctx.users.get(u) || {}).lang === 'en' ? 'en' : 'de';
      try {
        await gc.notify({
          topic: 'vault', users: [u], collapseKey: `drive-vault:${n.vault}:${n.device}`,
          title: texts(lang, 'vault.request.title'), body: texts(lang, 'vault.request.body', { who: (ctx.users.get(ctx.viewer) || {}).name || '', device: n.name || texts(lang, 'vault.device.unnamed') }),
          data: { drive: { vault: n.vault, node: n.node, area: n.area, event: 'request' } },
        });
      } catch (e) { gc.log.warn('vault push failed', (e && e.code) || 'error'); }
    }
  }
  for (const ev of ctx.vaultEvents || []) {
    let users = ev.users;
    if (!users && ev.area) users = await areas.readers(gc, ev.area, ctx.settings);
    if (!users || !users.length) continue;
    try { await gc.events.emit({ users, type: 'vault', data: { vault: ev.vault, event: ev.event, ...(ev.device ? { device: ev.device } : {}), ...(ev.keyVersion ? { keyVersion: ev.keyVersion } : {}) } }); } catch (e) { gc.log.warn('vault event failed', (e && e.code) || 'error'); }
  }
}

module.exports = {
  VAULT_ID_RE, DEVICE_ID_RE, OPAQUE_RE, RECOVERY, WRAP_BYTES,
  pubArg, wrapArg, nameCipherArg, nameVersion, deviceIdOf, opaqueName, keyVersionArg,
  row, reach, of, refresh, view, create, list, get, keys, recovery, devices, ask, approve, revoke, rotate, setRecovery, forNewNode, forget, announce, toRoots,
};
