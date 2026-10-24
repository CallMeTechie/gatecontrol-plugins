'use strict';

// Entries: encrypted blobs in a vault, saved with compare-and-swap (baseRev), a trash (30 days), the last 10
// versions, and the sync the apps keep their offline copy with. README "App-API" › Einträge, Abgleich.

const store = require('./store');
const vaults = require('./vaults');
const account = require('./account');
const wifi = require('./wifi');
const { fail, b64, SIZE, clientId, posInt, nonNeg, optLine, canWrite, iso } = require('./util');

// vaultChars: the encrypted entries of one vault (base64 text) — 64 MiB; with ≤ 21 vaults per person that bounds what
// one account can store (versions add at most 10 × an entry's size).
const LIMITS = { batch: 100, perVault: 5000, vaultChars: 64 * 1024 * 1024, history: 10, trashDays: 30, page: 200, pageMax: 500 };
const STATE = ['live', 'trash', 'purged'];

function view(r) {
  return {
    id: r.id,
    vaultId: r.vault_id,
    rev: r.rev,
    keyRev: r.key_rev,
    blob: r.state === 2 ? null : r.blob,
    state: STATE[r.state],
    trashedAt: iso(r.trashed_at),
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
    device: r.device || null,
    seq: r.seq,
  };
}

/** The key generation an entry of this vault must use now: the new one during a key change. */
const wantedKeyRev = (v) => v.pending_key_rev || v.key_rev;

/** One entry of POST items (inside tx) → { id, ok, rev, seq } | { id, ok: false, code, current? }. */
async function saveOne(ctx, it, seq, cache) {
  const { gc, viewer, now } = ctx;
  const id = clientId(it.id);
  const vaultId = clientId(it.vaultId);
  const blob = b64(it.blob, ...SIZE.blob);
  const keyRev = posInt(it.keyRev);
  const baseRev = nonNeg(it.baseRev == null ? 0 : it.baseRev);
  if (!keyRev) throw fail('invalid');
  const member = async (vid) => {
    if (!cache.has(vid)) cache.set(vid, await vaults.membership(gc, vid, viewer).catch(() => null));
    return cache.get(vid);
  };
  const used = async (vid) => {
    const k = 'chars:' + vid;
    if (!cache.has(k)) cache.set(k, (await store.one(gc, 'SELECT COALESCE(SUM(LENGTH(blob)), 0) AS n FROM items WHERE vault_id = ? AND state < 2', [vid])).n);
    return cache.get(k);
  };
  const fits = async (vid, add) => (await used(vid)) + add <= LIMITS.vaultChars;
  const charge = (vid, delta) => cache.set('chars:' + vid, cache.get('chars:' + vid) + delta);
  const v = await member(vaultId);
  if (!v) return { id, ok: false, code: 'not_found' };
  if (!canWrite(v.role)) return { id, ok: false, code: 'forbidden' };
  if (keyRev !== wantedKeyRev(v)) return { id, ok: false, code: 'stale_key' };
  const cur = await store.one(gc, 'SELECT * FROM items WHERE id = ?', [id]);
  if (!cur) {
    if (baseRev !== 0) return { id, ok: false, code: 'not_found' };
    const n = (await store.one(gc, 'SELECT COUNT(*) AS n FROM items WHERE vault_id = ? AND state < 2', [vaultId])).n;
    if (n >= LIMITS.perVault || !(await fits(vaultId, blob.length))) return { id, ok: false, code: 'limit' };
    charge(vaultId, blob.length);
    await store.run(gc, `INSERT INTO items (id, vault_id, rev, key_rev, blob, state, seq, updated_at, updated_by, device)
      VALUES (?, ?, 1, ?, ?, 0, ?, ?, ?, ?)`, [id, vaultId, keyRev, blob, seq, now, viewer, ctx.device]);
    await store.event(gc, now, viewer, 'item.create', vaultId, id);
    return { id, ok: true, rev: 1, seq };
  }
  // an existing entry: readable for the person (its vault), not purged, the version they changed
  const from = await member(cur.vault_id);
  if (!from) return { id, ok: false, code: 'not_found' };
  if (cur.state === 2) return { id, ok: false, code: 'not_found' };
  if (!canWrite(from.role)) return { id, ok: false, code: 'forbidden' };
  if (cur.rev !== baseRev) return { id, ok: false, code: 'conflict', current: view(cur) };
  const live = cur.blob.length;
  if (cur.vault_id === vaultId) {
    if (!(await fits(vaultId, blob.length - live))) return { id, ok: false, code: 'limit' };
    charge(vaultId, blob.length - live);
  } else {
    if (!(await fits(vaultId, blob.length))) return { id, ok: false, code: 'limit' };
    await used(cur.vault_id);
    charge(vaultId, blob.length);
    charge(cur.vault_id, -live);
  }
  if (cur.vault_id === vaultId) {
    await store.run(gc, 'INSERT OR REPLACE INTO history (item_id, rev, key_rev, blob, updated_at, updated_by, device) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, cur.rev, cur.key_rev, cur.blob, cur.updated_at, cur.updated_by, cur.device]);
    await store.run(gc, `DELETE FROM history WHERE item_id = ? AND rev NOT IN (SELECT rev FROM history WHERE item_id = ? ORDER BY rev DESC LIMIT ${LIMITS.history})`, [id, id]);
  } else {
    // moved to another vault: the old versions were encrypted with the other vault's key; its Wi-Fi shares end
    // (they belong to the vault's people)
    await store.run(gc, 'DELETE FROM history WHERE item_id = ?', [id]);
    await wifi.dropItem(gc, id, now, viewer, 'move');
  }
  // the trash state stays: a key change re-encrypts trashed entries too (restore is its own call)
  await store.run(gc, `UPDATE items SET vault_id = ?, rev = rev + 1, key_rev = ?, blob = ?, seq = ?, updated_at = ?, updated_by = ?, device = ?
    WHERE id = ?`, [vaultId, keyRev, blob, seq, now, viewer, ctx.device, id]);
  await store.event(gc, now, viewer, cur.vault_id === vaultId ? 'item.update' : 'item.move', vaultId, id);
  return { id, ok: true, rev: cur.rev + 1, seq };
}

/**
 * POST items — { items: [{ id, vaultId, blob, keyRev, baseRev }], device? } (1–100; an app request is ≤ 64 KB).
 * baseRev 0 creates, else the revision the app changed. Each entry is answered on its own (results), a conflict
 * carries the current version — the app keeps both (README).
 */
async function save(ctx, body) {
  const b = body || {};
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > LIMITS.batch) throw fail('invalid');
  const seen = new Set();
  for (const it of b.items) {
    if (!it || typeof it !== 'object') throw fail('invalid');
    if (seen.has(it.id)) throw fail('invalid');
    seen.add(it.id);
  }
  ctx.device = optLine(b.device, 80);
  const results = [];
  await store.tx(ctx.gc, async () => {
    await account.need(ctx.gc, ctx.viewer);
    const cache = new Map();
    for (const it of b.items) {
      const seq = await store.nextSeq(ctx.gc);
      results.push(await saveOne(ctx, it, seq, cache));
    }
  });
  return { results };
}

/** The entry and the person's role in its vault, or not_found. */
async function entry(ctx, idRaw) {
  const id = clientId(idRaw);
  const cur = await store.one(ctx.gc, 'SELECT * FROM items WHERE id = ?', [id]);
  if (!cur) throw fail('not_found');
  const m = await vaults.membership(ctx.gc, cur.vault_id, ctx.viewer);
  return { cur, m };
}

/** POST items/<id>/trash · /restore — into the trash and back (write). */
async function setTrash(ctx, idRaw, trash) {
  const { gc, viewer, now } = ctx;
  let out;
  await store.tx(gc, async () => {
    const { cur, m } = await entry(ctx, idRaw);
    if (!canWrite(m.role)) throw fail('forbidden');
    if (cur.state === 2) throw fail('not_found');
    const seq = await store.nextSeq(gc);
    await store.run(gc, 'UPDATE items SET state = ?, trashed_at = ?, seq = ? WHERE id = ?', [trash ? 1 : 0, trash ? now : null, seq, cur.id]);
    if (trash) await wifi.dropItem(gc, cur.id, now, viewer, 'trash');
    await store.event(gc, now, viewer, trash ? 'item.trash' : 'item.restore', cur.vault_id, cur.id);
    out = view(await store.one(gc, 'SELECT * FROM items WHERE id = ?', [cur.id]));
  });
  return { item: out };
}

/** Purge (inside tx): blob and versions gone, a tombstone stays so every app drops its copy; Wi-Fi shares end. */
async function purgeRow(gc, id, seq, userId = 0) {
  await wifi.dropItem(gc, id, Date.now(), userId, 'purge');
  await store.run(gc, 'DELETE FROM history WHERE item_id = ?', [id]);
  await store.run(gc, 'UPDATE items SET blob = NULL, state = 2, seq = ? WHERE id = ?', [seq, id]);
}

/** DELETE items/<id> — delete for good now (write). */
async function purge(ctx, idRaw) {
  const { gc, viewer, now } = ctx;
  let out;
  await store.tx(gc, async () => {
    const { cur, m } = await entry(ctx, idRaw);
    if (!canWrite(m.role)) throw fail('forbidden');
    if (cur.state === 2) throw fail('not_found');
    const seq = await store.nextSeq(gc);
    await purgeRow(gc, cur.id, seq, viewer);
    await store.event(gc, now, viewer, 'item.purge', cur.vault_id, cur.id);
    out = view(await store.one(gc, 'SELECT * FROM items WHERE id = ?', [cur.id]));
  });
  return { item: out };
}

/** GET items/<id>/history — the earlier versions, newest first (read). */
async function history(ctx, idRaw) {
  const { cur } = await entry(ctx, idRaw);
  const rows = await store.all(ctx.gc, 'SELECT * FROM history WHERE item_id = ? ORDER BY rev DESC', [cur.id]);
  return {
    history: rows.map((h) => ({ rev: h.rev, keyRev: h.key_rev, blob: h.blob, updatedAt: iso(h.updated_at), updatedBy: h.updated_by, device: h.device || null })),
  };
}

/**
 * GET sync?since=<seq>&limit=&vault=<id> — what changed since the app's last sync:
 *   seq          the server's change counter now (store it after the last page)
 *   account      the account when it changed since `since` (or since = 0), else null
 *   vaults       every vault the person is in, always complete (keys, role, members)
 *   items        changed entries (tombstones included) in those vaults, ordered by seq, ≤ limit
 *   more, next   another page: call again with since = next
 * A vault the app does not know yet (just shared with the person): sync with vault=<id>&since=0 for its entries.
 */
async function sync(ctx, query) {
  const q = query || {};
  const { gc } = ctx;
  const since = q.since == null || q.since === '' ? 0 : nonNeg(q.since);
  const limit = Math.min(posInt(q.limit) || LIMITS.page, LIMITS.pageMax);
  const vault = q.vault != null && q.vault !== '' ? clientId(q.vault) : null;
  // in a transaction: the host has one connection, so a read beside an open write could see a seq that is rolled
  // back and handed out again — an app would then skip what gets that number
  return store.tx(gc, () => syncIn(ctx, since, limit, vault));
}

async function syncIn(ctx, since, limit, vault) {
  const { gc, viewer, now } = ctx;
  const a = await account.need(gc, viewer);
  const seq = await store.currentSeq(gc);
  const list = await vaults.listFor(gc, viewer, ctx.users);
  let ids = list.map((v) => v.id);
  if (vault) {
    if (!ids.includes(vault)) throw fail('not_found');
    ids = [vault];
  }
  let rows = [];
  if (ids.length) {
    rows = await store.all(gc, `SELECT * FROM items WHERE vault_id IN (${store.marks(ids.length)}) AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`,
      [...ids, since, seq, limit + 1]);
  }
  const more = rows.length > limit;
  if (more) rows = rows.slice(0, limit);
  await store.run(gc, 'UPDATE accounts SET seen_at = ? WHERE user_id = ?', [now, viewer]);
  return {
    seq,
    account: since === 0 || a.seq > since ? account.view(a) : null,
    vaults: list,
    items: rows.map(view),
    more,
    next: more ? rows[rows.length - 1].seq : seq,
  };
}

module.exports = { view, save, setTrash, purge, purgeRow, history, sync, LIMITS };
