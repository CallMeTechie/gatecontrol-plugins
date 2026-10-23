'use strict';

// Vaults and who may open them. The personal vault belongs to one person and is never shared; a shared vault has
// members with a role (read · write · manage) and, for each, the vault key sealed to their public key.
//
// A key change (README › Schlüsselwechsel) after someone left: a manager's app makes a new key, seals it to every
// remaining member (rekey/start), re-encrypts every entry with it (POST items with the new keyRev — during the change
// only the new one is accepted), and ends it (rekey/finish): the new key becomes the current one, the old entry
// versions (history, encrypted with the old key) go. App requests are ≤ 64 KB, hence the steps.

const store = require('./store');
const account = require('./account');
const people = require('./people');
const { fail, b64, SIZE, clientId, posInt, role, canWrite, iso } = require('./util');

const LIMITS = { sharedPerUser: 20, membersPerVault: 50 };

/** The person's membership in a vault (+ the vault), or not_found (also when the vault does not exist). */
async function membership(gc, vaultId, userId) {
  const m = await store.one(gc, `SELECT v.*, m.role, m.sealed_key, m.pending_key FROM vaults v JOIN members m ON m.vault_id = v.id
    WHERE v.id = ? AND m.user_id = ?`, [vaultId, userId]);
  if (!m) throw fail('not_found');
  return m;
}

async function needRole(gc, vaultId, userId, want) {
  const m = await membership(gc, vaultId, userId);
  if (want === 'write' && !canWrite(m.role)) throw fail('forbidden');
  if (want === 'manage' && m.role !== 'manage') throw fail('forbidden');
  return m;
}

/** A vault as one member sees it; members: [{ userId, name, role }] of everyone in it. */
function view(m, members, users) {
  return {
    id: m.id,
    kind: m.kind,
    ownerId: m.owner_id,
    nameEnc: m.name_enc,
    role: m.role,
    keyRev: m.key_rev,
    sealedKey: m.sealed_key,
    pending: m.pending_key_rev ? { keyRev: m.pending_key_rev, sealedKey: m.pending_key || null } : null,
    needsRekey: m.needs_rekey > 0,
    members: (members || []).map((x) => ({ userId: x.user_id, name: (users && users.get(x.user_id) && users.get(x.user_id).name) || `#${x.user_id}`, role: x.role })),
    updatedAt: iso(m.updated_at),
  };
}

/** Every vault the person is in (the sync's list — small: ≤ 51 vaults × ≤ 50 members). */
async function listFor(gc, userId, users) {
  const rows = await store.all(gc, `SELECT v.*, m.role, m.sealed_key, m.pending_key FROM vaults v JOIN members m ON m.vault_id = v.id
    WHERE m.user_id = ? ORDER BY v.kind DESC, v.created_at`, [userId]);
  if (!rows.length) return [];
  const all = await store.all(gc, `SELECT vault_id, user_id, role FROM members WHERE vault_id IN (${store.marks(rows.length)}) ORDER BY added_at, user_id`, rows.map((r) => r.id));
  return rows.map((r) => view(r, all.filter((x) => x.vault_id === r.id), users));
}

async function one(ctx, id) {
  const m = await membership(ctx.gc, id, ctx.viewer);
  const members = await store.all(ctx.gc, 'SELECT vault_id, user_id, role FROM members WHERE vault_id = ? ORDER BY added_at, user_id', [id]);
  return view(m, members, ctx.users);
}

/** POST vaults — { id, nameEnc, sealedKey }: a shared vault, the creator its manager. */
async function create(ctx, body) {
  const b = body || {};
  const id = clientId(b.id);
  const nameEnc = b64(b.nameEnc, ...SIZE.name);
  const sealed = b64(b.sealedKey, ...SIZE.sealed);
  const { gc, viewer, now } = ctx;
  await store.tx(gc, async () => {
    await account.need(gc, viewer);
    if (await store.one(gc, 'SELECT 1 AS x FROM vaults WHERE id = ?', [id])) throw fail('exists');
    const n = await store.one(gc, "SELECT COUNT(*) AS n FROM members m JOIN vaults v ON v.id = m.vault_id WHERE m.user_id = ? AND v.kind = 'shared'", [viewer]);
    if (n.n >= LIMITS.sharedPerUser) throw fail('limit');
    const seq = await store.nextSeq(gc);
    await store.run(gc, `INSERT INTO vaults (id, kind, owner_id, name_enc, key_rev, seq, created_at, updated_at) VALUES (?, 'shared', ?, ?, 1, ?, ?, ?)`, [id, viewer, nameEnc, seq, now, now]);
    await store.run(gc, `INSERT INTO members (vault_id, user_id, role, sealed_key, added_by, added_at, seq) VALUES (?, ?, 'manage', ?, ?, ?, ?)`, [id, viewer, sealed, viewer, now, seq]);
    await store.event(gc, now, viewer, 'vault.create', id);
  });
  return { vault: await one(ctx, id) };
}

/** PUT vaults/<id> — { nameEnc } (manage; the personal vault's owner too). Not during a key change (finish names it). */
async function rename(ctx, id, body) {
  const nameEnc = b64((body || {}).nameEnc, ...SIZE.name);
  const { gc, viewer, now } = ctx;
  await store.tx(gc, async () => {
    const m = await needRole(gc, id, viewer, 'manage');
    if (m.pending_key_rev) throw fail('rekeying');
    const seq = await store.nextSeq(gc);
    await store.run(gc, 'UPDATE vaults SET name_enc = ?, seq = ?, updated_at = ? WHERE id = ?', [nameEnc, seq, now, id]);
    await store.event(gc, now, viewer, 'vault.rename', id);
  });
  return { vault: await one(ctx, id) };
}

/** DELETE vaults/<id> — a shared vault with all entries (manage). */
async function remove(ctx, id) {
  const { gc, viewer, now } = ctx;
  await store.tx(gc, async () => {
    const m = await needRole(gc, id, viewer, 'manage');
    if (m.kind !== 'shared') throw fail('forbidden');
    await store.nextSeq(gc);
    await account.dropVault(gc, id);
    await store.event(gc, now, viewer, 'vault.delete', id);
  });
  return { removed: id };
}

/** POST vaults/<id>/members — { userId, role, sealedKey } (manage; not during a key change). */
async function addMember(ctx, id, body) {
  const b = body || {};
  const uid = posInt(b.userId);
  if (!uid) throw fail('invalid');
  const r = role(b.role);
  const sealed = b64(b.sealedKey, ...SIZE.sealed);
  const { gc, viewer, now } = ctx;
  await store.tx(gc, async () => {
    const m = await needRole(gc, id, viewer, 'manage');
    if (m.kind !== 'shared') throw fail('forbidden');
    if (m.pending_key_rev) throw fail('rekeying');
    if (!ctx.users.has(uid) || (await people.kioskIds(gc)).has(uid)) throw fail('not_found');
    if (!(await store.one(gc, 'SELECT 1 AS x FROM accounts WHERE user_id = ?', [uid]))) throw fail('no_account');
    if (await store.one(gc, 'SELECT 1 AS x FROM members WHERE vault_id = ? AND user_id = ?', [id, uid])) throw fail('exists');
    const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM members WHERE vault_id = ?', [id]);
    if (n.n >= LIMITS.membersPerVault) throw fail('limit');
    const seq = await store.nextSeq(gc);
    await store.run(gc, 'INSERT INTO members (vault_id, user_id, role, sealed_key, added_by, added_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, uid, r, sealed, viewer, now, seq]);
    await store.run(gc, 'UPDATE vaults SET seq = ?, updated_at = ? WHERE id = ?', [seq, now, id]);
    await store.event(gc, now, viewer, 'member.add', id);
  });
  await people.push(gc, uid, 'share', 'shared', { name: ctx.user.name }, { vault: id });
  return { vault: await one(ctx, id) };
}

async function managers(gc, id) {
  return (await store.all(gc, "SELECT user_id FROM members WHERE vault_id = ? AND role = 'manage'", [id])).map((r) => r.user_id);
}

/** PUT vaults/<id>/members/<uid> — { role } (manage). A vault keeps at least one manager. */
async function setRole(ctx, id, uidRaw, body) {
  const uid = posInt(uidRaw);
  if (!uid) throw fail('invalid');
  const r = role((body || {}).role);
  const { gc, viewer, now } = ctx;
  await store.tx(gc, async () => {
    const m = await needRole(gc, id, viewer, 'manage');
    if (m.kind !== 'shared') throw fail('forbidden');
    const target = await store.one(gc, 'SELECT role FROM members WHERE vault_id = ? AND user_id = ?', [id, uid]);
    if (!target) throw fail('not_found');
    if (target.role === 'manage' && r !== 'manage' && (await managers(gc, id)).length <= 1) throw fail('last_manager');
    const seq = await store.nextSeq(gc);
    await store.run(gc, 'UPDATE members SET role = ?, seq = ? WHERE vault_id = ? AND user_id = ?', [r, seq, id, uid]);
    await store.run(gc, 'UPDATE vaults SET seq = ?, updated_at = ? WHERE id = ?', [seq, now, id]);
    await store.event(gc, now, viewer, 'member.role', id);
  });
  return { vault: await one(ctx, id) };
}

/**
 * DELETE vaults/<id>/members/<uid> — a manager removes someone, or a member leaves (uid = self). The vault is marked
 * needsRekey: what the person could read they know, so a manager's app changes the key. The last member leaving
 * deletes the vault; the last manager cannot leave while others remain (make someone manager first).
 */
async function removeMember(ctx, id, uidRaw) {
  const uid = posInt(uidRaw);
  if (!uid) throw fail('invalid');
  const { gc, viewer, now } = ctx;
  let gone = false;
  await store.tx(gc, async () => {
    const m = await membership(gc, id, viewer);
    if (m.kind !== 'shared') throw fail('forbidden');
    if (uid !== viewer && m.role !== 'manage') throw fail('forbidden');
    const target = await store.one(gc, 'SELECT role FROM members WHERE vault_id = ? AND user_id = ?', [id, uid]);
    if (!target) throw fail('not_found');
    // whoever leaves now has seen the new key too: finish the change first, then remove (and change again)
    if (m.pending_key_rev) throw fail('rekeying');
    const count = (await store.one(gc, 'SELECT COUNT(*) AS n FROM members WHERE vault_id = ?', [id])).n;
    const seq = await store.nextSeq(gc);
    if (count === 1) {
      await account.dropVault(gc, id);
      gone = true;
    } else {
      if (target.role === 'manage' && (await managers(gc, id)).length <= 1) throw fail('last_manager');
      await store.run(gc, 'DELETE FROM members WHERE vault_id = ? AND user_id = ?', [id, uid]);
      await store.run(gc, 'UPDATE vaults SET needs_rekey = 1, seq = ?, updated_at = ? WHERE id = ?', [seq, now, id]);
    }
    await store.event(gc, now, viewer, uid === viewer ? 'member.leave' : 'member.remove', id);
  });
  if (gone || uid === viewer) return { vault: null };
  return { vault: await one(ctx, id) };
}

/**
 * POST vaults/<id>/rekey/start — { keyRev, keys: [{ userId, sealedKey }] }: the new key (generation key_rev + 1)
 * sealed to exactly the current members. Repeating it is allowed until an entry uses the new key.
 */
async function rekeyStart(ctx, id, body) {
  const b = body || {};
  const keyRev = posInt(b.keyRev);
  if (!keyRev || !Array.isArray(b.keys) || !b.keys.length || b.keys.length > LIMITS.membersPerVault) throw fail('invalid');
  const keys = new Map();
  for (const k of b.keys) {
    const uid = posInt(k && k.userId);
    if (!uid || keys.has(uid)) throw fail('invalid');
    keys.set(uid, b64(k.sealedKey, ...SIZE.sealed));
  }
  const { gc, viewer, now } = ctx;
  await store.tx(gc, async () => {
    const m = await needRole(gc, id, viewer, 'manage');
    if (keyRev !== m.key_rev + 1) throw fail('stale_key');
    if (m.pending_key_rev && (await store.one(gc, 'SELECT 1 AS x FROM items WHERE vault_id = ? AND key_rev = ?', [id, m.pending_key_rev]))) throw fail('rekeying');
    const members = (await store.all(gc, 'SELECT user_id FROM members WHERE vault_id = ?', [id])).map((r) => r.user_id);
    if (members.length !== keys.size || !members.every((u) => keys.has(u))) throw fail('invalid');
    const seq = await store.nextSeq(gc);
    for (const [uid, sealed] of keys) await store.run(gc, 'UPDATE members SET pending_key = ?, seq = ? WHERE vault_id = ? AND user_id = ?', [sealed, seq, id, uid]);
    await store.run(gc, 'UPDATE vaults SET pending_key_rev = ?, seq = ?, updated_at = ? WHERE id = ?', [keyRev, seq, now, id]);
    await store.event(gc, now, viewer, 'vault.rekey_start', id);
  });
  return { vault: await one(ctx, id) };
}

/**
 * POST vaults/<id>/rekey/finish — { nameEnc } (the name under the new key): every entry not yet purged must be
 * encrypted with the new key (else `rekeying` with the count left). The old entry versions are deleted.
 */
async function rekeyFinish(ctx, id, body) {
  const nameEnc = b64((body || {}).nameEnc, ...SIZE.name);
  const { gc, viewer, now } = ctx;
  await store.tx(gc, async () => {
    const m = await needRole(gc, id, viewer, 'manage');
    if (!m.pending_key_rev) throw fail('invalid');
    const left = (await store.one(gc, 'SELECT COUNT(*) AS n FROM items WHERE vault_id = ? AND state < 2 AND key_rev != ?', [id, m.pending_key_rev])).n;
    if (left) throw fail('rekeying', { left });
    const seq = await store.nextSeq(gc);
    await store.run(gc, 'UPDATE members SET sealed_key = pending_key, pending_key = NULL, seq = ? WHERE vault_id = ?', [seq, id]);
    // needs_rekey 2: someone's account was deleted during the change — they knew the new key, so change again
    await store.run(gc, `UPDATE vaults SET key_rev = pending_key_rev, pending_key_rev = NULL, needs_rekey = CASE needs_rekey WHEN 2 THEN 1 ELSE 0 END,
      name_enc = ?, seq = ?, updated_at = ? WHERE id = ?`, [nameEnc, seq, now, id]);
    await store.run(gc, 'DELETE FROM history WHERE item_id IN (SELECT id FROM items WHERE vault_id = ?) AND key_rev != ?', [id, m.pending_key_rev]);
    await store.event(gc, now, viewer, 'vault.rekey_finish', id);
  });
  return { vault: await one(ctx, id) };
}

module.exports = { membership, needRole, listFor, one, create, rename, remove, addMember, setRole, removeMember, rekeyStart, rekeyFinish, LIMITS };
