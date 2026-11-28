'use strict';

// "Nur auf diesem Gerät" (since 1.32.0, feature `vaultLocal`, setting vault_local — off by default): a folder of a vault
// whose content lies on ONE device only. The server keeps the folder as a placeholder — the same node (id, parent,
// opaque name, name_cipher), no files, no folders below, no size — and knows only that it exists, on which vault device
// (vault_devices: name, platform) and since when. Table vault_local (migration 026). README "Nur auf diesem Gerät".
//
// Who: an approved vault device of the person, with the write right, only in a vault of "Meine Dateien" of that person
// ("Nur ich" — 409 local_shared in a family's or a team's vault, it would take the folder away from the others). Only a
// folder below the vault's folder, not the vault's folder itself; not inside a placeholder, not above one (409
// local_nested, naming the device).
//
// The move (the device's work, README):  POST vaults/<id>/local { nodeId, deviceId } → state moving, a lease of 30
// minutes (…/lease extends it), the manifest of every node below; the device fetches and checks everything; then
// POST …/commit { deviceId, proof, manifest } — the proof that the request comes from the device with the key (a random
// number the server sealed to the device's public key: POST …/local/challenge, HPKE as the wraps, info
// "gcdrive-v1:local-proof:<vaultId>:<deviceId>"; a stolen login token cannot move content past the trash). The manifest
// must match the server's nodes below (else 409 conflict { reason: 'changed', changed, added, removed }). Then the
// content goes hidden: every node below (live ones leave their paths as in the trash; ones in the trash already keep
// their own batch in nodes.local_trash) gets trash_id = the folder — in no trash, no listing, no download — and goes for
// good after 24 hours (purge_at, the background run: media, versions, history, offline marks, the home cache's uses —
// nodes.purgeRows). Until then "Rückgängig" (POST …/undo) brings it back as it was. No alarm of the ransomware
// protection (guard.js is not asked: the device's proof and a push to every device of the person stand for it).
//
// Back: POST …/return → state returning (lease as above); only the GateControl device of that request may upload into
// the folder; POST …/return/commit { deviceId, proof, count } → a plain folder again. "Platzhalter entfernen" (the
// device is lost): POST …/forget — from the device itself with the proof, or from another approved device of the person
// without one (then only after the 24 hours) — the placeholder goes into the trash as an empty folder; a push to every
// device of the person.

const crypto = require('node:crypto');
const store = require('./store');
const nodes = require('./nodes');
const { fail, iso } = require('./util');
const { t } = require('./text');

// vault.js needs nodes.js, which needs this module when it checks a write: loaded when first used
const vaults = () => require('./vault');
const homecache = () => require('./homecache');

const MIN = 60000;
const HOUR = 3600000;
const LEASE_MS = 30 * MIN;
const PROOF_MS = 60000;
const GRACE_MS = 24 * HOUR;
const MANIFEST_MAX = 20000;
const PROOF_BYTES = 32;
const PROOF_VERSION = 1;
// placeholders a background run brings forward (expired leases, the end of the 24 hours)
const TICK_MAX = 20;

/** The administrator's switch (Einstellungen › Plugins › Drive, vault_local; default off). */
async function enabled(gc) {
  const all = await gc.settings.all();
  return all.vault_local === true || all.vault_local === 'true';
}

// ─── The device's proof (HPKE base mode, the suite of the wraps — README "Kryptografie") ─────

const L8 = (s) => Buffer.from(s);
const i2osp = (n, w) => { const b = Buffer.alloc(w); b.writeUIntBE(n, 0, w); return b; };
const extract = (salt, ikm) => crypto.createHmac('sha256', salt.length ? salt : Buffer.alloc(32)).update(ikm).digest();
const expand = (prk, info, len) => crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
const KEM = Buffer.concat([L8('KEM'), i2osp(0x20, 2)]);
const SUITE = Buffer.concat([L8('HPKE'), i2osp(0x20, 2), i2osp(1, 2), i2osp(2, 2)]);
const lx = (suite, salt, label, ikm) => extract(salt, Buffer.concat([L8('HPKE-v1'), suite, L8(label), ikm]));
const le = (suite, prk, label, info, len) => expand(prk, Buffer.concat([i2osp(len, 2), L8('HPKE-v1'), suite, L8(label), info]), len);
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');

/** HPKE single-shot Seal(pkR, info, aad = "", pt) → enc (32) ‖ ct ‖ tag — DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM. */
function hpkeSeal(pkR, info, pt) {
  const eph = crypto.generateKeyPairSync('x25519');
  const enc = eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519.length);
  const pub = crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, pkR]), format: 'der', type: 'spki' });
  const dh = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pub });
  const shared = le(KEM, lx(KEM, Buffer.alloc(0), 'eae_prk', dh), 'shared_secret', Buffer.concat([enc, pkR]), 32);
  const ctx = Buffer.concat([Buffer.from([0]), lx(SUITE, Buffer.alloc(0), 'psk_id_hash', Buffer.alloc(0)), lx(SUITE, Buffer.alloc(0), 'info_hash', info)]);
  const secret = lx(SUITE, shared, 'secret', Buffer.alloc(0));
  const c = crypto.createCipheriv('aes-256-gcm', le(SUITE, secret, 'key', ctx, 32), le(SUITE, secret, 'base_nonce', ctx, 12));
  const ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  return Buffer.concat([enc, ct]);
}

const proofInfo = (vaultId, deviceId) => L8(`gcdrive-v1:local-proof:${vaultId}:${deviceId}`);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** An approved vault device of the viewer (else 403 { reason: 'device' }) → its row. */
async function myDevice(ctx, vaultId, deviceId) {
  const d = typeof deviceId === 'string' && vaults().DEVICE_ID_RE.test(deviceId)
    ? await store.one(ctx.gc, 'SELECT * FROM vault_devices WHERE vault_id = ? AND device_id = ?', [vaultId, deviceId]) : null;
  if (!d || d.user_id !== ctx.viewer || d.state !== 'approved') throw fail('forbidden', { reason: 'device' });
  return d;
}

/**
 * POST vaults/<id>/local/challenge { deviceId } → { challenge, expiresAt } — 0x01 ‖ HPKE(device's public key, info
 * "gcdrive-v1:local-proof:<vaultId>:<deviceId>", 32 random bytes) as base64url (81 bytes, the shape of a wrap). The
 * device opens it with its key and sends the 32 bytes back as `proof` (base64url) — within 60 seconds, once.
 */
async function challenge(ctx, id, body) {
  const b = body && typeof body === 'object' ? body : {};
  const { vault } = await vaults().reach(ctx, id);
  const d = await myDevice(ctx, vault.id, b.deviceId);
  const secret = crypto.randomBytes(PROOF_BYTES);
  const sealed = hpkeSeal(Buffer.from(d.public_key, 'base64url'), proofInfo(vault.id, d.device_id), secret);
  const expires = ctx.now + PROOF_MS;
  await store.run(ctx.gc, `INSERT INTO vault_local_proofs (vault_id, device_id, hash, expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(vault_id, device_id) DO UPDATE SET hash = excluded.hash, expires_at = excluded.expires_at`, [vault.id, d.device_id, sha(secret), expires]);
  return { challenge: Buffer.concat([Buffer.from([PROOF_VERSION]), sealed]).toString('base64url'), expiresAt: iso(expires) };
}

/**
 * The proof of `deviceId` — taken once, in a transaction of its own before the change (a wrong one and one followed by a
 * 409 are used up too: the next try asks for a new challenge) — else 403 { reason: 'proof' }.
 */
async function takeProof(ctx, vaultId, deviceId, proof) {
  const p = await store.tx(ctx.gc, async () => {
    const row = await store.one(ctx.gc, 'SELECT * FROM vault_local_proofs WHERE vault_id = ? AND device_id = ?', [vaultId, deviceId]);
    if (row) await store.run(ctx.gc, 'DELETE FROM vault_local_proofs WHERE vault_id = ? AND device_id = ?', [vaultId, deviceId]);
    return row;
  });
  let got = null;
  if (typeof proof === 'string' && /^[A-Za-z0-9_-]{43}$/.test(proof)) {
    const raw = Buffer.from(proof, 'base64url');
    if (raw.length === PROOF_BYTES && raw.toString('base64url') === proof) got = Buffer.from(sha(raw), 'hex');
  }
  const want = p ? Buffer.from(p.hash, 'hex') : null;
  if (!p || p.expires_at < ctx.now || !got || got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw fail('forbidden', { reason: 'proof' });
}

// ─── Rows and what they block ───────────────────

const rowOf = (gc, nodeId) => store.one(gc, 'SELECT * FROM vault_local WHERE node_id = ?', [nodeId]);
const rowsOfVault = (gc, vaultId) => store.all(gc, 'SELECT * FROM vault_local WHERE vault_id = ? ORDER BY node_id', [vaultId]);

/** The state that counts now: a move whose lease ran out is gone (nothing was deleted), a return whose lease ran out is local again. */
function stateOf(r, now) {
  if (!r) return null;
  if (r.state === 'moving') return r.lease_until != null && r.lease_until > now ? 'moving' : null;
  if (r.state === 'returning') return r.lease_until != null && r.lease_until > now ? 'returning' : 'local';
  return 'local';
}

async function deviceRow(gc, r) {
  return store.one(gc, 'SELECT name, platform, state FROM vault_devices WHERE vault_id = ? AND device_id = ?', [r.vault_id, r.device_id]);
}

/** May this request write while the folder returns? Only its GateControl device (the one that started the return). */
const returner = (ctx, r) => !!(ctx.deviceId && r.gc_device && ctx.deviceId === r.gc_device);

async function refusal(gc, r, state) {
  const d = await deviceRow(gc, r);
  return fail(state === 'moving' ? 'local_moving' : 'local_only', { nodeId: r.node_id, deviceId: r.device_id, deviceName: (d && d.name) || null, state });
}

/** The ids of node `id` and the folders above it. */
async function upIds(gc, id) {
  const rows = await store.all(gc, `WITH RECURSIVE up(id, parent_id) AS (SELECT id, parent_id FROM nodes WHERE id = ?
    UNION ALL SELECT p.id, p.parent_id FROM nodes p JOIN up ON p.id = up.parent_id) SELECT id FROM up`, [id]);
  return new Set(rows.map((x) => x.id));
}

/**
 * A write at node `node` of a vault (nodes.reach 'write'; `into`: something goes into the folder — nodes.folderFor).
 * Below or into a placeholder: 409 local_only { nodeId, deviceId, deviceName } (while it returns: only the returning
 * GateControl device may); below a folder being moved: 409 local_moving. The placeholder itself may be renamed or moved
 * (its encrypted name; nothing of the content).
 */
async function checkWrite(ctx, node, into = false) {
  if (!node || !node.vault_id) return;
  const rows = await rowsOfVault(ctx.gc, node.vault_id);
  if (!rows.length) return;
  const up = await upIds(ctx.gc, node.id);
  for (const r of rows) {
    if (!up.has(r.node_id)) continue;
    const s = stateOf(r, ctx.now);
    if (!s) continue;
    if (s === 'returning' && returner(ctx, r)) continue;
    if (s === 'local' && r.node_id === node.id && !into) continue;
    throw await refusal(ctx.gc, r, s);
  }
}

/** Is a placeholder at node `node` or below it (a trash, a mark, a time travel of it)? → 409 local_only / local_moving. */
async function checkTree(ctx, node) {
  if (!node || !node.vault_id) return;
  for (const r of await rowsOfVault(ctx.gc, node.vault_id)) {
    const s = stateOf(r, ctx.now);
    if (!s || (s === 'returning' && returner(ctx, r) && r.node_id !== node.id)) continue;
    if (r.node_id === node.id || (await upIds(ctx.gc, r.node_id)).has(node.id)) throw await refusal(ctx.gc, r, s);
  }
}

/** The placeholder as the API shows it (`deviceId` of the asking app: thisDevice). */
async function view(ctx, r, deviceId) {
  const s = stateOf(r, ctx.now);
  const d = await deviceRow(ctx.gc, r);
  const mine = r.user_id === ctx.viewer;
  const pending = r.purge_at != null && r.purge_at > ctx.now;
  return {
    nodeId: r.node_id, vaultId: r.vault_id, deviceId: r.device_id, deviceName: (d && d.name) || null, platform: (d && d.platform) || null,
    deviceState: d ? d.state : null, state: s, since: iso(r.state === 'moving' ? r.started_at : r.since), mine,
    ...(typeof deviceId === 'string' && deviceId ? { thisDevice: deviceId === r.device_id } : {}),
    ...(s === 'moving' || s === 'returning' ? { leaseUntil: iso(r.lease_until) } : {}),
    ...(mine ? { purgeAt: pending ? iso(r.purge_at) : null, undo: s === 'local' && pending } : {}),
  };
}

/**
 * The field `local` on the nodes of an answer that are placeholders (folders of a vault) — GET children, GET nodes/<id>,
 * GET changes. `deviceId`: the app's vault device (?deviceId=) → thisDevice.
 */
async function attach(ctx, items, deviceId) {
  const dirs = (items || []).filter((n) => n && n.encrypted && n.isDir && !n.deleted);
  if (!dirs.length) return items;
  const rows = [];
  for (const part of store.chunks(dirs.map((n) => n.id))) rows.push(...await store.all(ctx.gc, `SELECT * FROM vault_local WHERE node_id IN (${store.marks(part.length)})`, part));
  if (!rows.length) return items;
  const by = new Map(rows.map((r) => [r.node_id, r]));
  for (const n of dirs) {
    const r = by.get(n.id);
    if (r && stateOf(r, ctx.now)) n.local = await view(ctx, r, deviceId);
  }
  return items;
}

/**
 * GET children of a placeholder: nothing while it is local (what an interrupted return uploaded stays out of sight) and
 * while it returns — except for the returning device; while it is moved: as always (the device fetches it). → null
 * (list as always) or { local } (an empty list with the placeholder).
 */
async function childrenOf(ctx, node, deviceId) {
  if (!node.vault_id || node.is_dir !== 1) return null;
  const r = await rowOf(ctx.gc, node.id);
  const s = stateOf(r, ctx.now);
  if (!s) return null;
  const local = await view(ctx, r, deviceId);
  if (s === 'moving' || (s === 'returning' && returner(ctx, r))) return { local, list: true };
  return { local, list: false };
}

// ─── The API ────────────────────────────────────

/** The vault for a change: reach with the write right, only "Nur ich" (my own files), the device approved. */
async function reachMine(ctx, id, deviceId) {
  const r = await vaults().reach(ctx, id, 'write');
  const v = await vaults().refresh(ctx, r.vault, r.area);
  if (r.area.kind !== 'mine' || r.area.owner_user !== ctx.viewer) throw fail('local_shared');
  const d = await myDevice(ctx, v.id, deviceId);
  return { ...r, vault: v, device: d };
}

/** A placeholder of vault `vault` (its row) the viewer owns → the row; else not_found. */
async function mineRow(ctx, vault, nodeId) {
  const id = Number(nodeId);
  const r = Number.isSafeInteger(id) ? await rowOf(ctx.gc, id) : null;
  if (!r || r.vault_id !== vault.id || r.user_id !== ctx.viewer || !stateOf(r, ctx.now)) throw fail('not_found');
  return r;
}

/** GET vaults/<id>/local?deviceId= → { items: [Local] } — the placeholders of the vault. */
async function list(ctx, id, q) {
  const { vault } = await vaults().reach(ctx, id);
  const out = [];
  for (const r of await rowsOfVault(ctx.gc, vault.id)) if (stateOf(r, ctx.now)) out.push(await view(ctx, r, q && q.deviceId));
  return { items: out };
}

/** GET vaults/<id>/local/<nodeId>?deviceId= → { local } — also after an answer that got lost. */
async function get(ctx, id, nodeId, q) {
  const { vault } = await vaults().reach(ctx, id);
  const n = Number(nodeId);
  const r = Number.isSafeInteger(n) ? await rowOf(ctx.gc, n) : null;
  if (!r || r.vault_id !== vault.id || !stateOf(r, ctx.now)) throw fail('not_found');
  return { local: await view(ctx, r, q && q.deviceId) };
}

/** Every node below folder `id` (live and in the trash). */
const below = (gc, id) => nodes.below(gc, id);

function manifestItem(n) {
  return {
    id: n.id, parentId: n.parent_id, isDir: n.is_dir === 1, nameCipher: n.name_cipher || null, keyVersion: n.key_version == null ? null : n.key_version,
    ...(n.is_dir === 1 ? {} : { rev: n.rev, sha256: n.sha256 || null, size: n.size, mediaId: n.media_id || null, mtime: iso(n.mtime) }),
  };
}

/**
 * POST vaults/<id>/local { nodeId, deviceId } → { local, manifest: { items, files, folders, bytes }, versions: { count,
 * bytes }, trash: { entries, files, bytes } } — the move begins (state moving, a lease of 30 minutes). Again for the
 * same device while it moves: a new manifest and lease.
 */
async function start(ctx, id, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!(await enabled(ctx.gc))) throw fail('feature_off');
  const { vault, area, device } = await reachMine(ctx, id, b.deviceId);
  const nodeId = Number(b.nodeId);
  const out = await store.tx(ctx.gc, async () => {
    const node = Number.isSafeInteger(nodeId) ? await nodes.row(ctx.gc, nodeId) : null;
    if (!node || node.deleted_at != null || node.vault_id !== vault.id || node.is_dir !== 1 || node.id === vault.node_id) throw fail('invalid', { field: 'nodeId' });
    if (area.archived_at != null) throw fail('forbidden');
    const have = await rowOf(ctx.gc, node.id);
    const hs = stateOf(have, ctx.now);
    if (have && hs && !(hs === 'moving' && have.device_id === device.device_id)) throw await refusal(ctx.gc, have, hs);
    if (have && !hs) await store.run(ctx.gc, 'DELETE FROM vault_local WHERE node_id = ?', [node.id]);
    // not inside a placeholder, none below it
    const up = await upIds(ctx.gc, node.id);
    for (const r of await rowsOfVault(ctx.gc, vault.id)) {
      const s = stateOf(r, ctx.now);
      if (!s || r.node_id === node.id) continue;
      if (up.has(r.node_id)) throw await refusal(ctx.gc, r, s);
      if ((await upIds(ctx.gc, r.node_id)).has(node.id)) {
        const d = await deviceRow(ctx.gc, r);
        throw fail('local_nested', { nodeId: r.node_id, deviceId: r.device_id, deviceName: (d && d.name) || null });
      }
    }
    const rows = await below(ctx.gc, node.id);
    const live = rows.filter((r) => r.deleted_at == null);
    if (live.length > MANIFEST_MAX) throw fail('too_large', { max: MANIFEST_MAX });
    const filesLive = live.filter((r) => r.is_dir === 0);
    const ids = rows.map((r) => r.id);
    let vCount = 0;
    let vBytes = 0;
    for (const part of store.chunks(ids)) {
      const s = await store.one(ctx.gc, `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM versions WHERE node_id IN (${store.marks(part.length)})`, part);
      vCount += s.n; vBytes += s.b;
    }
    const tops = rows.filter((r) => r.trash_id != null && r.trash_id === r.id);
    const trashedFiles = rows.filter((r) => r.deleted_at != null && r.is_dir === 0);
    const manifest = live.map((r) => ({ id: r.id, d: r.is_dir === 1 ? 1 : 0, rev: r.rev, sha: r.sha256 || null }));
    await store.run(ctx.gc, `INSERT INTO vault_local (node_id, vault_id, device_id, user_id, state, lease_until, manifest, since, purge_at, gc_device, started_at)
      VALUES (?, ?, ?, ?, 'moving', ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET lease_until = excluded.lease_until, manifest = excluded.manifest, gc_device = excluded.gc_device`,
    [node.id, vault.id, device.device_id, ctx.viewer, ctx.now + LEASE_MS, JSON.stringify(manifest), ctx.now, ctx.deviceId, ctx.now]);
    if (!have || !hs) await nodes.log(ctx.gc, node.area_id, node.id, 'local', ctx);
    return {
      manifest: { items: live.map(manifestItem), files: filesLive.length, folders: live.length - filesLive.length, bytes: filesLive.reduce((s, r) => s + (r.size || 0), 0) },
      versions: { count: vCount, bytes: vBytes },
      trash: { entries: tops.length, files: trashedFiles.length, bytes: trashedFiles.reduce((s, r) => s + (r.size || 0), 0) },
      nodeId: node.id,
    };
  });
  const r = await rowOf(ctx.gc, out.nodeId);
  return { local: await view(ctx, r, device.device_id), manifest: out.manifest, versions: out.versions, trash: out.trash };
}

/** A placeholder of mine in `state`, bound to vault device `deviceId` (that device of mine, approved). */
async function boundRow(ctx, id, nodeId, deviceId, states) {
  const { vault, area, device } = await reachMine(ctx, id, deviceId);
  const r = await mineRow(ctx, vault, nodeId);
  const s = stateOf(r, ctx.now);
  if (r.device_id !== device.device_id) throw fail('forbidden', { reason: 'device' });
  if (!states.includes(s)) throw fail('conflict', { reason: 'state', state: s });
  return { vault, area, device, r, s };
}

/** POST vaults/<id>/local/<nodeId>/lease { deviceId } → { local } — the lease of a move or a return 30 minutes more. */
async function lease(ctx, id, nodeId, body) {
  const b = body && typeof body === 'object' ? body : {};
  const { r, device } = await boundRow(ctx, id, nodeId, b.deviceId, ['moving', 'returning']);
  await store.run(ctx.gc, 'UPDATE vault_local SET lease_until = ? WHERE node_id = ?', [ctx.now + LEASE_MS, r.node_id]);
  return { local: await view(ctx, await rowOf(ctx.gc, r.node_id), device.device_id) };
}

/** DELETE vaults/<id>/local/<nodeId>?deviceId= → { local: null } — a move called off (nothing was deleted). */
async function cancel(ctx, id, nodeId, q) {
  const { r, vault } = await boundRow(ctx, id, nodeId, q && q.deviceId, ['moving']);
  await store.tx(ctx.gc, async () => {
    await store.run(ctx.gc, 'DELETE FROM vault_local WHERE node_id = ?', [r.node_id]);
    const n = await nodes.row(ctx.gc, r.node_id);
    if (n) await nodes.log(ctx.gc, n.area_id, n.id, 'local', ctx);
  });
  event(ctx, vault, r.node_id, 'local_cancelled');
  return { local: null, nodeId: r.node_id };
}

/** The manifest the device holds against the nodes below now → { changed, added, removed } (node items). */
function compare(have, live) {
  const now = new Map(live.map((n) => [n.id, n]));
  const sent = new Map();
  for (const x of have) {
    if (!x || !Number.isSafeInteger(Number(x.id))) throw fail('invalid', { field: 'manifest' });
    sent.set(Number(x.id), x);
  }
  const changed = [];
  const added = [];
  const removed = [];
  for (const [nid, n] of now) {
    const x = sent.get(nid);
    if (!x) { added.push(manifestItem(n)); continue; }
    if (n.is_dir === 0 && (Number(x.rev) !== n.rev || (x.sha256 || null) !== (n.sha256 || null))) changed.push(manifestItem(n));
  }
  for (const nid of sent.keys()) if (!now.has(nid)) removed.push(nid);
  return { changed, added, removed };
}

/**
 * POST vaults/<id>/local/<nodeId>/commit { deviceId, proof, manifest: [{ id, rev?, sha256? }] (every node below, files
 * with rev and sha256) } → { local, purgeAt, hidden } — the content leaves the server (hidden for 24 hours, then for
 * good). 409 conflict { reason: 'changed', changed, added, removed } when the nodes below are not what the device has.
 */
async function commit(ctx, id, nodeId, body) {
  const b = body && typeof body === 'object' ? body : {};
  const { r, vault, area, device } = await boundRow(ctx, id, nodeId, b.deviceId, ['moving']);
  if (!Array.isArray(b.manifest) || b.manifest.length > MANIFEST_MAX) throw fail('invalid', { field: 'manifest' });
  await takeProof(ctx, vault.id, device.device_id, b.proof);
  const out = await store.tx(ctx.gc, async () => {
    const node = await nodes.row(ctx.gc, r.node_id);
    if (!node || node.deleted_at != null) throw fail('not_found');
    const rows = await below(ctx.gc, node.id);
    const live = rows.filter((x) => x.deleted_at == null);
    const diff = compare(b.manifest, live);
    // rare: the lease holds the writes below — but the NAS (sync.js) or an older lease may have changed something
    if (diff.changed.length || diff.added.length || diff.removed.length) throw fail('conflict', { reason: 'changed', ...diff });
    const hidden = await hide(ctx, node, area, rows);
    await store.run(ctx.gc, "UPDATE vault_local SET state = 'local', since = ?, purge_at = ?, lease_until = NULL, manifest = NULL, gc_device = NULL WHERE node_id = ?",
      [ctx.now, ctx.now + GRACE_MS, node.id]);
    await nodes.log(ctx.gc, area.id, node.id, 'local', ctx);
    return { hidden };
  });
  await homecache().touch(ctx.gc);
  await push(ctx, vault, device, r.node_id, 'local');
  return { local: await view(ctx, await rowOf(ctx.gc, r.node_id), device.device_id), purgeAt: iso(ctx.now + GRACE_MS), hidden: out.hidden };
}

/**
 * Inside a transaction: every node below placeholder `node` goes hidden — the live ones leave their paths (as in the
 * trash: on a NAS below .gcdrive/files) and get deleted_at and trash_id = the placeholder (no trash lists them, nothing
 * reads them); the ones in the trash already keep their batch in local_trash. Offline marks, uses of the home cache and
 * office locks below end now (the home cache withdraws its offers at its next run, in the next minute). A 'delete' in
 * the change log for each node right below (the apps drop their copies), → the count hidden.
 */
async function hide(ctx, node, area, rows) {
  const gc = ctx.gc;
  const live = rows.filter((x) => x.deleted_at == null);
  const moved = [];
  try {
    for (const x of live) if (x.is_dir === 0 && x.media_id) { await gc.media.move(x.media_id, { path: null }); moved.push(x); }
  } catch (e) {
    const paths = nodes.pathsBelow(node.id, await nodes.pathOf(gc, node), rows);
    for (const x of moved) { try { await gc.media.move(x.media_id, { path: paths.get(x.id) }); } catch { /* best effort */ } }
    throw e;
  }
  for (const part of store.chunks(live.map((x) => x.id), 80)) {
    await store.run(gc, `UPDATE nodes SET deleted_at = ?, deleted_by = ?, trash_id = ?, ${nodes.UNMARKED} WHERE id IN (${store.marks(part.length)})`, [ctx.now, ctx.viewer, node.id, ...part]);
  }
  const trashed = rows.filter((x) => x.deleted_at != null && x.trash_id !== node.id);
  for (const part of store.chunks(trashed.map((x) => x.id), 80)) {
    await store.run(gc, `UPDATE nodes SET local_trash = trash_id, trash_id = ? WHERE id IN (${store.marks(part.length)})`, [node.id, ...part]);
  }
  const ids = [node.id, ...rows.map((x) => x.id)];
  for (const part of store.chunks(ids)) {
    const m = store.marks(part.length);
    await store.run(gc, `DELETE FROM offline_pins WHERE node_id IN (${m})`, part);
    await store.run(gc, `DELETE FROM cache_uses WHERE node_id IN (${m})`, part);
    await store.run(gc, `DELETE FROM office_locks WHERE node_id IN (${m})`, part);
  }
  for (const x of live) if (x.parent_id === node.id) await nodes.log(gc, area.id, x.id, 'delete', ctx);
  return live.length;
}

/**
 * POST vaults/<id>/local/<nodeId>/undo { deviceId } → { local: null, restored } — within the 24 hours: the content comes
 * back as it was (paths, the trash entries of then). Only from the device with the copy; not once something of a return
 * is on the server again (409 conflict { reason: 'not_empty' }).
 */
async function undo(ctx, id, nodeId, body) {
  const b = body && typeof body === 'object' ? body : {};
  const { r, vault, area } = await boundRow(ctx, id, nodeId, b.deviceId, ['local']);
  if (r.purge_at == null || r.purge_at <= ctx.now) throw fail('conflict', { reason: 'purged' });
  const restored = await store.tx(ctx.gc, async () => {
    const node = await nodes.row(ctx.gc, r.node_id);
    if (!node || node.deleted_at != null) throw fail('not_found');
    const liveNow = await store.one(ctx.gc, 'SELECT COUNT(*) AS n FROM nodes WHERE parent_id = ? AND deleted_at IS NULL', [node.id]);
    if (liveNow.n) throw fail('conflict', { reason: 'not_empty' });
    const hidden = await store.all(ctx.gc, 'SELECT * FROM nodes WHERE trash_id = ?', [node.id]);
    const back = hidden.filter((x) => x.local_trash == null);
    const paths = nodes.pathsBelow(node.id, await nodes.pathOf(ctx.gc, node), back);
    const files = back.filter((x) => x.is_dir === 0 && x.media_id).map((x) => ({ id: x.id, media_id: x.media_id, path: paths.get(x.id) }));
    await nodes.moveMedia(ctx.gc, files, area.media_area, area.media_area, new Map(files.map((f) => [f.id, null])));
    for (const part of store.chunks(back.map((x) => x.id), 90)) {
      await store.run(ctx.gc, `UPDATE nodes SET deleted_at = NULL, deleted_by = NULL, trash_id = NULL WHERE id IN (${store.marks(part.length)})`, part);
    }
    await store.run(ctx.gc, 'UPDATE nodes SET trash_id = local_trash, local_trash = NULL WHERE trash_id = ? AND local_trash IS NOT NULL', [node.id]);
    await store.run(ctx.gc, 'DELETE FROM vault_local WHERE node_id = ?', [node.id]);
    for (const x of back) if (x.parent_id === node.id) await nodes.log(ctx.gc, area.id, x.id, 'restore', ctx);
    await nodes.log(ctx.gc, area.id, node.id, 'local', ctx);
    return back.length;
  });
  await homecache().touch(ctx.gc);
  event(ctx, vault, r.node_id, 'local_undone');
  return { local: null, nodeId: r.node_id, restored };
}

/** POST vaults/<id>/local/<nodeId>/return { deviceId } → { local } — the way back begins (state returning, a lease). */
async function startReturn(ctx, id, nodeId, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!ctx.deviceId) throw fail('invalid', { field: 'device' });
  const { r, device } = await boundRow(ctx, id, nodeId, b.deviceId, ['local', 'returning']);
  await store.tx(ctx.gc, async () => {
    await store.run(ctx.gc, "UPDATE vault_local SET state = 'returning', lease_until = ?, gc_device = ? WHERE node_id = ?", [ctx.now + LEASE_MS, ctx.deviceId, r.node_id]);
    const n = await nodes.row(ctx.gc, r.node_id);
    if (r.state !== 'returning' && n) await nodes.log(ctx.gc, n.area_id, n.id, 'local', ctx);
  });
  return { local: await view(ctx, await rowOf(ctx.gc, r.node_id), device.device_id) };
}

/**
 * POST vaults/<id>/local/<nodeId>/return/commit { deviceId, proof, count } → { local: null, files } — back on the server:
 * a plain folder again. `count`: the files the device uploaded (the files below now; else 409 conflict { reason:
 * 'count', files }). What still lay hidden from the move goes for good now.
 */
async function finishReturn(ctx, id, nodeId, body) {
  const b = body && typeof body === 'object' ? body : {};
  const { r, vault, area, device } = await boundRow(ctx, id, nodeId, b.deviceId, ['returning', 'local']);
  if (stateOf(r, ctx.now) !== 'returning' || !returner(ctx, r)) throw fail('conflict', { reason: 'state', state: stateOf(r, ctx.now) });
  const count = Number(b.count);
  if (!Number.isSafeInteger(count) || count < 0) throw fail('invalid', { field: 'count' });
  await takeProof(ctx, vault.id, device.device_id, b.proof);
  const files = await store.tx(ctx.gc, async () => {
    const node = await nodes.row(ctx.gc, r.node_id);
    if (!node || node.deleted_at != null) throw fail('not_found');
    const live = (await below(ctx.gc, node.id)).filter((x) => x.deleted_at == null && x.is_dir === 0).length;
    if (live !== count) throw fail('conflict', { reason: 'count', files: live });
    await purgeHidden(ctx.gc, node.id);
    await store.run(ctx.gc, 'DELETE FROM vault_local WHERE node_id = ?', [node.id]);
    await nodes.log(ctx.gc, area.id, node.id, 'local', ctx);
    return live;
  });
  event(ctx, vault, r.node_id, 'local_returned');
  return { local: null, nodeId: r.node_id, files };
}

/**
 * POST vaults/<id>/local/<nodeId>/forget { deviceId, proof? } → { forgotten, trashed } — "Platzhalter entfernen" (the
 * device is lost): from the device itself with the proof, or from another approved device of the person without one —
 * then only once the 24 hours are over (409 conflict { reason: 'purge_pending', purgeAt }). What still lies hidden goes
 * for good; the placeholder (and what an interrupted return left in it) goes into the trash. A push to every device.
 */
async function forget(ctx, id, nodeId, body) {
  const b = body && typeof body === 'object' ? body : {};
  const { vault, area, device } = await reachMine(ctx, id, b.deviceId);
  const r = await mineRow(ctx, vault, nodeId);
  const s = stateOf(r, ctx.now);
  if (s === 'moving') throw fail('conflict', { reason: 'state', state: s });
  const own = r.device_id === device.device_id;
  const pending = r.purge_at != null && r.purge_at > ctx.now;
  if (!own && b.proof != null) throw fail('invalid', { field: 'proof' });
  if (!own && pending) throw fail('conflict', { reason: 'purge_pending', purgeAt: iso(r.purge_at) });
  if (!own && s === 'returning') throw fail('conflict', { reason: 'state', state: s });
  if (own) await takeProof(ctx, vault.id, device.device_id, b.proof);
  const trashed = await store.tx(ctx.gc, async () => {
    const node = await nodes.row(ctx.gc, r.node_id);
    await purgeHidden(ctx.gc, r.node_id);
    await store.run(ctx.gc, 'DELETE FROM vault_local WHERE node_id = ?', [r.node_id]);
    if (!node || node.deleted_at != null) return 0;
    const all = await nodes.trashRows(ctx, node, area);
    return all.length;
  });
  if (trashed) nodes.unlinkLater(ctx, 'all', [r.node_id]);
  const holder = await store.one(ctx.gc, 'SELECT * FROM vault_devices WHERE vault_id = ? AND device_id = ?', [vault.id, r.device_id]);
  await push(ctx, vault, holder || { device_id: r.device_id, name: null }, r.node_id, 'local_forgotten');
  return { forgotten: true, nodeId: r.node_id, trashed };
}

// ─── Purge, background, notes ───────────────────

/** Inside a transaction: what lies hidden below placeholder `nodeId` goes for good (nodes.purgeRows). → files removed */
async function purgeHidden(gc, nodeId) {
  const rows = await store.all(gc, 'SELECT * FROM nodes WHERE trash_id = ?', [nodeId]);
  if (!rows.length) return 0;
  return nodes.purgeRows(gc, rows);
}

/**
 * The background run (every minute): moves whose lease ran out end (nothing was deleted), returns whose lease ran out
 * are local again, and after the 24 hours what lay hidden goes for good. → Set of area ids changed
 */
async function tick(gc, now = Date.now()) {
  const touched = new Set();
  const rows = await store.all(gc, `SELECT * FROM vault_local WHERE (state IN ('moving', 'returning') AND lease_until <= ?) OR (purge_at IS NOT NULL AND purge_at <= ?)
    ORDER BY node_id LIMIT ?`, [now, now, TICK_MAX]);
  for (const r of rows) {
    const ctx = { gc, viewer: null, deviceId: null, now, touched };
    try {
      await store.tx(gc, async () => {
        const cur = await rowOf(gc, r.node_id);
        if (!cur) return;
        const n = await nodes.row(gc, cur.node_id);
        if (cur.state === 'moving' && cur.lease_until <= now) {
          await store.run(gc, 'DELETE FROM vault_local WHERE node_id = ?', [cur.node_id]);
          if (n) await nodes.log(gc, n.area_id, n.id, 'local', ctx);
          return;
        }
        if (cur.state === 'returning' && cur.lease_until <= now) {
          await store.run(gc, "UPDATE vault_local SET state = 'local', lease_until = NULL, gc_device = NULL WHERE node_id = ?", [cur.node_id]);
          if (n) await nodes.log(gc, n.area_id, n.id, 'local', ctx);
        }
        if (cur.purge_at != null && cur.purge_at <= now) {
          await purgeHidden(gc, cur.node_id);
          await store.run(gc, 'UPDATE vault_local SET purge_at = NULL WHERE node_id = ?', [cur.node_id]);
          if (n) await nodes.log(gc, n.area_id, n.id, 'local', ctx);
        }
      });
    } catch (e) { gc.log.warn('vault local run failed', (e && e.code) || 'error'); }
  }
  return touched;
}

/** The live event `vault` to the person (after the answer, vault.announce). */
function event(ctx, vault, nodeId, ev) {
  (ctx.vaultEvents || (ctx.vaultEvents = [])).push({ users: [ctx.viewer], vault: vault.id, event: ev, node: nodeId });
}

/** A push to every device of the person ("liegt jetzt nur auf …", "Platzhalter entfernt") and the live event. */
async function push(ctx, vault, device, nodeId, ev) {
  event(ctx, vault, nodeId, ev);
  const lang = (ctx.users.get(ctx.viewer) || {}).lang === 'en' ? 'en' : 'de';
  const name = device.name || t(lang, 'vault.device.unnamed');
  try {
    await ctx.gc.notify({
      topic: 'vault', users: [ctx.viewer], collapseKey: `drive-vault-local:${vault.id}:${nodeId}`,
      title: t(lang, ev === 'local' ? 'vault.local.title' : 'vault.local.forgotten.title'),
      body: t(lang, ev === 'local' ? 'vault.local.body' : 'vault.local.forgotten.body', { device: name }),
      data: { drive: { vault: vault.id, node: nodeId, event: ev, device: device.device_id } },
    });
  } catch (e) { ctx.gc.log.warn('vault push failed', (e && e.code) || 'error'); }
}

module.exports = {
  enabled, hpkeSeal, challenge, checkWrite, checkTree, attach, childrenOf, list, get, start, lease, cancel, commit, undo,
  startReturn, finishReturn, forget, tick, stateOf, GRACE_MS, LEASE_MS, PROOF_MS,
};
