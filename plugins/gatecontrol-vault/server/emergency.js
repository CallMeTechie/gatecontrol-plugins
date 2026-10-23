'use strict';

// Emergency access (README › Notfallzugriff): the grantor's app seals the grantor's user key to a trusted person's
// public key. The trusted person can ask for access; the grantor is told and can refuse. Only when the waiting time
// passed (or the grantor allows it early) does the server hand the sealed key out — read access to all of the
// grantor's vaults. The server cannot open the key either.

const store = require('./store');
const account = require('./account');
const vaults = require('./vaults');
const items = require('./items');
const people = require('./people');
const { fail, b64, SIZE, posInt, nonNeg, newId, iso } = require('./util');

const LIMITS = { perGrantor: 10, minHours: 1, maxHours: 720 };
const HOUR = 3600000;
const ID_RE = /^[0-9a-f]{24}$/;

const name = (ctx, id) => (ctx.users.get(id) && ctx.users.get(id).name) || `#${id}`;

function view(ctx, e) {
  return {
    id: e.id,
    grantor: { id: e.grantor_id, name: name(ctx, e.grantor_id) },
    grantee: { id: e.grantee_id, name: name(ctx, e.grantee_id) },
    waitHours: e.wait_hours,
    status: e.status,
    requestedAt: iso(e.requested_at),
    releaseAt: e.status === 'requested' ? iso(e.requested_at + e.wait_hours * HOUR) : null,
    grantedAt: iso(e.granted_at),
  };
}

/** GET emergency — { granted: what I gave (I am the grantor), received: what I got (I am the trusted person) }. */
async function list(ctx) {
  const { gc, viewer } = ctx;
  const mine = await store.all(gc, 'SELECT * FROM emergency WHERE grantor_id = ? ORDER BY created_at', [viewer]);
  const got = await store.all(gc, 'SELECT * FROM emergency WHERE grantee_id = ? ORDER BY created_at', [viewer]);
  return { granted: mine.map((e) => view(ctx, e)), received: got.map((e) => view(ctx, e)) };
}

async function row(gc, idRaw) {
  if (typeof idRaw !== 'string' || !ID_RE.test(idRaw)) throw fail('not_found');
  const e = await store.one(gc, 'SELECT * FROM emergency WHERE id = ?', [idRaw]);
  if (!e) throw fail('not_found');
  return e;
}

/**
 * POST emergency — { granteeId, waitHours, sealedKey }: name a trusted person, or renew the sealed key / waiting
 * time of one (only while nothing is requested or granted).
 */
async function put(ctx, body) {
  const b = body || {};
  const grantee = posInt(b.granteeId);
  const wait = posInt(b.waitHours);
  if (!grantee || !wait || wait < LIMITS.minHours || wait > LIMITS.maxHours) throw fail('invalid');
  const sealed = b64(b.sealedKey, ...SIZE.sealed);
  const { gc, viewer, now } = ctx;
  if (grantee === viewer) throw fail('invalid');
  let id;
  await store.tx(gc, async () => {
    await account.need(gc, viewer);
    if (!ctx.users.has(grantee) || (await people.kioskIds(gc)).has(grantee)) throw fail('not_found');
    if (!(await store.one(gc, 'SELECT 1 AS x FROM accounts WHERE user_id = ?', [grantee]))) throw fail('no_account');
    const cur = await store.one(gc, 'SELECT * FROM emergency WHERE grantor_id = ? AND grantee_id = ?', [viewer, grantee]);
    if (cur) {
      if (cur.status !== 'ready') throw fail('conflict');
      await store.run(gc, 'UPDATE emergency SET wait_hours = ?, sealed_key = ? WHERE id = ?', [wait, sealed, cur.id]);
      id = cur.id;
    } else {
      const n = (await store.one(gc, 'SELECT COUNT(*) AS n FROM emergency WHERE grantor_id = ?', [viewer])).n;
      if (n >= LIMITS.perGrantor) throw fail('limit');
      id = newId();
      await store.run(gc, `INSERT INTO emergency (id, grantor_id, grantee_id, wait_hours, sealed_key, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'ready', ?)`, [id, viewer, grantee, wait, sealed, now]);
    }
    await store.event(gc, now, viewer, 'emergency.put');
  });
  return { emergency: view(ctx, await row(gc, id)) };
}

/** DELETE emergency/<id> — the grantor withdraws it, or the trusted person declines it. */
async function remove(ctx, idRaw) {
  const { gc, viewer, now } = ctx;
  await store.tx(gc, async () => {
    const e = await row(gc, idRaw);
    if (e.grantor_id !== viewer && e.grantee_id !== viewer) throw fail('not_found');
    await store.run(gc, 'DELETE FROM emergency WHERE id = ?', [e.id]);
    await store.event(gc, now, viewer, 'emergency.remove');
  });
  return { removed: idRaw };
}

/** POST emergency/<id>/request — the trusted person asks; the grantor gets a push with the waiting time. */
async function request(ctx, idRaw) {
  const { gc, viewer, now } = ctx;
  let e;
  await store.tx(gc, async () => {
    e = await row(gc, idRaw);
    if (e.grantee_id !== viewer) throw fail('not_found');
    if (e.status !== 'ready') throw fail('conflict');
    await store.run(gc, "UPDATE emergency SET status = 'requested', requested_at = ? WHERE id = ?", [now, e.id]);
    await store.event(gc, now, viewer, 'emergency.request');
  });
  await people.push(gc, e.grantor_id, 'emergency', 'requested', { name: name(ctx, viewer), hours: e.wait_hours }, { emergency: e.id });
  return { emergency: view(ctx, await row(gc, e.id)) };
}

/** POST emergency/<id>/deny — the grantor refuses (or takes back a granted access): back to ready. */
async function deny(ctx, idRaw) {
  const { gc, viewer, now } = ctx;
  let e;
  await store.tx(gc, async () => {
    e = await row(gc, idRaw);
    if (e.grantor_id !== viewer) throw fail('not_found');
    if (e.status === 'ready') throw fail('conflict');
    await store.run(gc, "UPDATE emergency SET status = 'ready', requested_at = NULL, granted_at = NULL WHERE id = ?", [e.id]);
    await store.event(gc, now, viewer, 'emergency.deny');
  });
  await people.push(gc, e.grantee_id, 'emergency', 'denied', { name: name(ctx, viewer) }, { emergency: e.id });
  return { emergency: view(ctx, await row(gc, e.id)) };
}

/** POST emergency/<id>/approve — the grantor allows it before the waiting time ends. */
async function approve(ctx, idRaw) {
  const { gc, viewer, now } = ctx;
  let e;
  await store.tx(gc, async () => {
    e = await row(gc, idRaw);
    if (e.grantor_id !== viewer) throw fail('not_found');
    if (e.status !== 'requested') throw fail('conflict');
    await store.run(gc, "UPDATE emergency SET status = 'granted', granted_at = ? WHERE id = ?", [now, e.id]);
    await store.event(gc, now, viewer, 'emergency.approve');
  });
  await people.push(gc, e.grantee_id, 'emergency', 'granted', { name: name(ctx, viewer) }, { emergency: e.id });
  return { emergency: view(ctx, await row(gc, e.id)) };
}

/** Background: requests whose waiting time passed become granted (both sides get a push). */
async function release(gc, now, users) {
  const done = await store.tx(gc, async () => {
    const due = await store.all(gc, "SELECT * FROM emergency WHERE status = 'requested' AND requested_at + wait_hours * ? <= ?", [HOUR, now]);
    for (const e of due) {
      await store.run(gc, "UPDATE emergency SET status = 'granted', granted_at = ? WHERE id = ?", [now, e.id]);
      await store.event(gc, now, e.grantee_id, 'emergency.release');
    }
    return due;
  });
  const ctx = { users };
  for (const e of done) {
    await people.push(gc, e.grantee_id, 'emergency', 'granted', { name: name(ctx, e.grantor_id) }, { emergency: e.id });
    await people.push(gc, e.grantor_id, 'emergency', 'released', { name: name(ctx, e.grantee_id) }, { emergency: e.id });
  }
  return done.length;
}

/** A granted access of the viewer as trusted person, else not_found. */
async function granted(ctx, idRaw) {
  const e = await row(ctx.gc, idRaw);
  if (e.grantee_id !== ctx.viewer || e.status !== 'granted') throw fail('not_found');
  return e;
}

/**
 * GET emergency/<id>/access — the sealed user key, the grantor's wrapped private key, and the grantor's vaults
 * (their keys sealed to the grantor). Entries: GET emergency/<id>/items?since=&limit= (read-only, like sync).
 */
async function access(ctx, idRaw) {
  const e = await granted(ctx, idRaw);
  const a = await account.need(ctx.gc, e.grantor_id);
  await store.tx(ctx.gc, () => store.event(ctx.gc, ctx.now, ctx.viewer, 'emergency.access'));
  return {
    sealedKey: e.sealed_key,
    grantor: { id: e.grantor_id, name: name(ctx, e.grantor_id), publicKey: a.public_key, privateKeyEnc: a.private_key_enc },
    vaults: await vaults.listFor(ctx.gc, e.grantor_id, ctx.users),
  };
}

async function entries(ctx, idRaw, query) {
  const e = await granted(ctx, idRaw);
  const q = query || {};
  const since = q.since == null || q.since === '' ? 0 : nonNeg(q.since);
  const limit = Math.min(posInt(q.limit) || items.LIMITS.page, items.LIMITS.pageMax);
  return store.tx(ctx.gc, async () => {
    const ids = (await store.all(ctx.gc, 'SELECT vault_id FROM members WHERE user_id = ?', [e.grantor_id])).map((r) => r.vault_id);
    const seq = await store.currentSeq(ctx.gc);
    let rows = ids.length
      ? await store.all(ctx.gc, `SELECT * FROM items WHERE vault_id IN (${store.marks(ids.length)}) AND state < 2 AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`, [...ids, since, seq, limit + 1])
      : [];
    const more = rows.length > limit;
    if (more) rows = rows.slice(0, limit);
    return { seq, items: rows.map(items.view), more, next: more ? rows[rows.length - 1].seq : seq };
  });
}

module.exports = { list, put, remove, request, deny, approve, release, access, entries, LIMITS };
