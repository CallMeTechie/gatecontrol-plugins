'use strict';

// The person's account: set up once (keys + the personal vault), changed on a new master password or after a
// recovery, deleted with everything that is only theirs. README "App-API" › Konto.

const store = require('./store');
const { fail, b64, SIZE, clientId, nonNeg, iso } = require('./util');

// Argon2id bounds (README "Kryptoformat"): the apps default to 64 MiB, 3 passes; libsodium has exactly one lane.
const KDF = { m: [19456, 1048576], t: [2, 10], p: [1, 1] };

function kdf(v) {
  if (!v || typeof v !== 'object' || v.alg !== 'argon2id') throw fail('invalid');
  const out = {};
  for (const k of ['m', 't', 'p']) {
    const n = v[k];
    if (!Number.isSafeInteger(n) || n < KDF[k][0] || n > KDF[k][1]) throw fail('invalid');
    out[k] = n;
  }
  out.salt = b64(v.salt, ...SIZE.salt);
  return out;
}

function view(a) {
  return {
    kdf: { alg: 'argon2id', m: a.kdf_m, t: a.kdf_t, p: a.kdf_p, salt: a.kdf_salt },
    userKeyPw: a.user_key_pw,
    userKeyRk: a.user_key_rk,
    publicKey: a.public_key,
    privateKeyEnc: a.private_key_enc,
    rev: a.rev,
    createdAt: iso(a.created_at),
    updatedAt: iso(a.updated_at),
  };
}

const row = (gc, userId) => store.one(gc, 'SELECT * FROM accounts WHERE user_id = ?', [userId]);

/** The account row or no_account. */
async function need(gc, userId) {
  const a = await row(gc, userId);
  if (!a) throw fail('no_account');
  return a;
}

async function get(ctx) {
  const a = await row(ctx.gc, ctx.viewer);
  return { account: a ? view(a) : null };
}

/**
 * POST account — { kdf, userKeyPw, userKeyRk, publicKey, privateKeyEnc, personal: { id, nameEnc, sealedKey } }.
 * Creates the account and the personal vault (the app encrypted its name and sealed its key to publicKey).
 */
async function create(ctx, body) {
  const b = body || {};
  const k = kdf(b.kdf);
  const f = {
    pw: b64(b.userKeyPw, ...SIZE.wrapped),
    rk: b64(b.userKeyRk, ...SIZE.wrapped),
    pub: b64(b.publicKey, ...SIZE.publicKey),
    priv: b64(b.privateKeyEnc, ...SIZE.wrapped),
  };
  const p = b.personal || {};
  const vid = clientId(p.id);
  const nameEnc = b64(p.nameEnc, ...SIZE.name);
  const sealed = b64(p.sealedKey, ...SIZE.sealed);
  const { gc, viewer, now } = ctx;
  await store.tx(gc, async () => {
    if (await row(gc, viewer)) throw fail('exists');
    if (await store.one(gc, 'SELECT 1 AS x FROM vaults WHERE id = ?', [vid])) throw fail('exists');
    const seq = await store.nextSeq(gc);
    await store.run(gc, `INSERT INTO accounts (user_id, kdf_m, kdf_t, kdf_p, kdf_salt, user_key_pw, user_key_rk, public_key, private_key_enc, rev, seq, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`, [viewer, k.m, k.t, k.p, k.salt, f.pw, f.rk, f.pub, f.priv, seq, now, now]);
    await store.run(gc, `INSERT INTO vaults (id, kind, owner_id, name_enc, key_rev, seq, created_at, updated_at)
      VALUES (?, 'personal', ?, ?, 1, ?, ?, ?)`, [vid, viewer, nameEnc, seq, now, now]);
    await store.run(gc, `INSERT INTO members (vault_id, user_id, role, sealed_key, added_by, added_at, seq)
      VALUES (?, ?, 'manage', ?, ?, ?, ?)`, [vid, viewer, sealed, viewer, now, seq]);
    await store.event(gc, now, viewer, 'account.create', vid);
  });
  return get(ctx);
}

/**
 * PUT account — { rev, kdf, userKeyPw, userKeyRk? }: a new master password (the user key itself stays, only its
 * wrapping changes) or, after a recovery, a new password and a new recovery key. Compare-and-swap on rev.
 */
async function update(ctx, body) {
  const b = body || {};
  const rev = nonNeg(b.rev);
  const k = kdf(b.kdf);
  const pw = b64(b.userKeyPw, ...SIZE.wrapped);
  const rk = b.userKeyRk == null ? null : b64(b.userKeyRk, ...SIZE.wrapped);
  const { gc, viewer, now } = ctx;
  await store.tx(gc, async () => {
    const a = await need(gc, viewer);
    if (a.rev !== rev) throw fail('conflict', { account: view(a) });
    const seq = await store.nextSeq(gc);
    await store.run(gc, `UPDATE accounts SET kdf_m = ?, kdf_t = ?, kdf_p = ?, kdf_salt = ?, user_key_pw = ?, user_key_rk = COALESCE(?, user_key_rk),
      rev = rev + 1, seq = ?, updated_at = ? WHERE user_id = ?`, [k.m, k.t, k.p, k.salt, pw, rk, seq, now, viewer]);
    await store.event(gc, now, viewer, rk ? 'account.recover' : 'account.password');
  });
  return get(ctx);
}

/**
 * POST account/delete — { confirm: 'DELETE' }: the account, the personal vault with its entries, the person's
 * memberships and emergency grants. A shared vault the person was the only member of goes too; one where they were
 * the last manager gets the longest-standing remaining member as manager.
 */
async function remove(ctx, body) {
  if (!body || body.confirm !== 'DELETE') throw fail('invalid');
  const { gc, viewer, now } = ctx;
  await store.tx(gc, async () => {
    await need(gc, viewer);
    const seq = await store.nextSeq(gc);
    const mine = await store.all(gc, 'SELECT v.id, v.kind FROM members m JOIN vaults v ON v.id = m.vault_id WHERE m.user_id = ?', [viewer]);
    for (const v of mine) {
      const others = await store.all(gc, 'SELECT user_id, role FROM members WHERE vault_id = ? AND user_id != ? ORDER BY added_at, user_id', [v.id, viewer]);
      if (v.kind === 'personal' || !others.length) {
        await dropVault(gc, v.id);
        continue;
      }
      await store.run(gc, 'DELETE FROM members WHERE vault_id = ? AND user_id = ?', [v.id, viewer]);
      if (!others.some((o) => o.role === 'manage')) {
        await store.run(gc, "UPDATE members SET role = 'manage', seq = ? WHERE vault_id = ? AND user_id = ?", [seq, v.id, others[0].user_id]);
      }
      // during a key change the person knew the new key too (2: change again after finishing)
      await store.run(gc, 'UPDATE vaults SET needs_rekey = CASE WHEN pending_key_rev IS NULL THEN 1 ELSE 2 END, seq = ?, updated_at = ? WHERE id = ?', [seq, now, v.id]);
    }
    await store.run(gc, 'DELETE FROM emergency WHERE grantor_id = ? OR grantee_id = ?', [viewer, viewer]);
    await store.run(gc, 'DELETE FROM accounts WHERE user_id = ?', [viewer]);
    await store.event(gc, now, viewer, 'account.delete');
  });
  return { account: null };
}

/** A vault with everything in it (inside tx). */
async function dropVault(gc, id) {
  await store.run(gc, 'DELETE FROM history WHERE item_id IN (SELECT id FROM items WHERE vault_id = ?)', [id]);
  await store.run(gc, 'DELETE FROM items WHERE vault_id = ?', [id]);
  await store.run(gc, 'DELETE FROM members WHERE vault_id = ?', [id]);
  await store.run(gc, 'DELETE FROM vaults WHERE id = ?', [id]);
}

module.exports = { get, create, update, remove, need, view, dropVault, KDF };
