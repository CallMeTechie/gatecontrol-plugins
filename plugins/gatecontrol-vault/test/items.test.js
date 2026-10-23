'use strict';

// Entries: create / change with compare-and-swap, conflicts, the last 10 versions, moving between vaults, trash,
// purge (tombstones), the background purge after 30 days, and the sync (pages, since, tombstones, one vault).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, fake, ANNA, MARC, DAY, HOUR } = require('./helpers');

test('save: create (baseRev 0) and change (baseRev = current); a second device with an old version gets the current one', async () => {
  await withHost({}, async (host, c) => {
    const { personalId: v } = await c.setup(ANNA);
    const a = await c.item(ANNA, v, 1);
    assert.deepEqual([a.ok, a.rev], [true, 1]);
    const b = await c.item(ANNA, v, 1, { id: a.id, baseRev: 1 });
    assert.deepEqual([b.ok, b.rev], [true, 2]);
    const stale = await c.item(ANNA, v, 1, { id: a.id, baseRev: 1 });
    assert.deepEqual([stale.ok, stale.code, stale.current.rev, stale.current.blob], [false, 'conflict', 2, b.sent.blob]);
    // create with an id that exists → conflict too (baseRev 0 ≠ 2)
    assert.equal((await c.item(ANNA, v, 1, { id: a.id })).code, 'conflict');
    // a change of a missing entry
    assert.equal((await c.item(ANNA, v, 1, { baseRev: 3 })).code, 'not_found');
    // the wrong key generation
    assert.equal((await c.item(ANNA, v, 2)).code, 'stale_key');
    // someone else's vault: not_found (no hint that it exists)
    await c.setup(MARC);
    assert.equal((await c.item(MARC, v, 1)).code, 'not_found');
    assert.equal((await c.item(MARC, v, 1, { id: a.id, baseRev: 2 })).code, 'not_found');
  });
});

test('save: the request is checked as a whole (1–100 entries, no duplicate ids, sizes); each entry answered on its own', async () => {
  await withHost({}, async (host, c) => {
    const { personalId: v } = await c.setup(ANNA);
    const it = (o = {}) => ({ id: fake.id(), vaultId: v, blob: fake.blob(), keyRev: 1, baseRev: 0, ...o });
    const bad = [
      {}, { items: [] }, { items: new Array(101).fill(0).map(() => it()) },
      { items: [it({ id: 'x' })] }, { items: [it({ blob: fake.blob(40000) })] }, { items: [it({ blob: 'no!' })] },
      { items: [it({ keyRev: 0 })] }, { items: [it({ baseRev: -1 })] },
    ];
    const dup = it();
    bad.push({ items: [dup, { ...dup }] });
    for (const [i, b] of bad.entries()) assert.equal((await c.as(ANNA)('POST', 'items', b)).json.code, 'invalid', `case ${i}`);
    const r = (await c.as(ANNA)('POST', 'items', { items: [it(), it({ vaultId: fake.id() }), it()], device: 'Pixel 10\u0000' })).json.results;
    assert.deepEqual(r.map((x) => x.ok), [true, false, true]);
    assert.equal(r[1].code, 'not_found');
    const s = (await c.as(ANNA)('GET', 'sync')).json;
    assert.equal(s.items.length, 2);
    assert.equal(s.items[0].device, 'Pixel 10', 'the device name, control characters removed');
    // nothing at all without an account
    assert.equal((await c.as(MARC)('POST', 'items', { items: [it()] })).json.code, 'no_account');
  });
});

test('versions: the last 10, newest first; moving to another vault drops them', async () => {
  await withHost({}, async (host, c) => {
    const { personalId: v } = await c.setup(ANNA);
    const a = await c.item(ANNA, v, 1);
    const blobs = [a.sent.blob];
    for (let rev = 1; rev <= 12; rev++) blobs.push((await c.item(ANNA, v, 1, { id: a.id, baseRev: rev })).sent.blob);
    const h = (await c.as(ANNA)('GET', `items/${a.id}/history`)).json.history;
    assert.deepEqual(h.map((x) => x.rev), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    assert.equal(h[0].blob, blobs[11]);
    const shared = fake.id();
    await c.as(ANNA)('POST', 'vaults', { id: shared, nameEnc: fake.name(), sealedKey: fake.sealed() });
    const moved = await c.item(ANNA, shared, 1, { id: a.id, baseRev: 13 });
    assert.deepEqual([moved.ok, moved.rev], [true, 14]);
    assert.equal((await c.as(ANNA)('GET', `items/${a.id}/history`)).json.history.length, 0, 'encrypted with the other vault key');
    await c.setup(MARC);
    assert.equal((await c.as(MARC)('GET', `items/${a.id}/history`)).json.code, 'not_found');
  });
});

test('trash, restore, purge: tombstones reach the apps; a purged entry can neither be changed nor reused', async () => {
  await withHost({}, async (host, c) => {
    const { personalId: v } = await c.setup(ANNA);
    const a = await c.item(ANNA, v, 1);
    const seq0 = (await c.as(ANNA)('GET', 'sync')).json.seq;
    const t = (await c.as(ANNA)('POST', `items/${a.id}/trash`)).json.item;
    assert.deepEqual([t.state, t.blob, typeof t.trashedAt], ['trash', a.sent.blob, 'string']);
    assert.equal((await c.as(ANNA)('POST', `items/${a.id}/restore`)).json.item.state, 'live');
    const p = (await c.as(ANNA)('DELETE', `items/${a.id}`)).json.item;
    assert.deepEqual([p.state, p.blob], ['purged', null]);
    const s = (await c.as(ANNA)('GET', 'sync', null, { since: seq0 })).json;
    assert.deepEqual(s.items.map((x) => [x.id, x.state]), [[a.id, 'purged']], 'one row per entry: its latest state');
    assert.equal((await c.as(ANNA)('DELETE', `items/${a.id}`)).json.code, 'not_found');
    assert.equal((await c.as(ANNA)('POST', `items/${a.id}/trash`)).json.code, 'not_found');
    assert.equal((await c.item(ANNA, v, 1, { id: a.id, baseRev: 1 })).code, 'not_found');
    assert.equal((await c.item(ANNA, v, 1, { id: a.id })).code, 'not_found', 'a purged id is never reused');
    assert.equal((await c.as(ANNA)('GET', 'items/bad/history')).json.code, 'invalid');
  });
});

test('background: 30 days in the trash → purged (tombstone, versions gone); live entries stay', async () => {
  await withHost({}, async (host, c) => {
    const { personalId: v } = await c.setup(ANNA);
    const a = await c.item(ANNA, v, 1);
    await c.item(ANNA, v, 1, { id: a.id, baseRev: 1 });
    const keep = await c.item(ANNA, v, 1);
    await c.as(ANNA)('POST', `items/${a.id}/trash`);
    c.clock.add(29 * DAY);
    assert.equal((await host.tick()).purged, 0);
    c.clock.add(DAY + HOUR);
    assert.equal((await host.tick()).purged, 1);
    const all = (await c.as(ANNA)('GET', 'sync')).json.items;
    assert.deepEqual(all.map((x) => [x.id, x.state]).sort(), [[a.id, 'purged'], [keep.id, 'live']].sort());
    assert.equal((await c.as(ANNA)('GET', `items/${a.id}/history`)).json.history.length, 0);
  });
});

test('sync: pages by seq, since, the account only when changed, a single vault', async () => {
  await withHost({}, async (host, c) => {
    const { personalId: v } = await c.setup(ANNA);
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push((await c.item(ANNA, v, 1)).id);
    const p1 = (await c.as(ANNA)('GET', 'sync', null, { limit: 3 })).json;
    assert.equal(p1.items.length, 3);
    assert.equal(p1.more, true);
    assert.ok(p1.account, 'since 0: the account');
    const p2 = (await c.as(ANNA)('GET', 'sync', null, { since: p1.next, limit: 3 })).json;
    const p3 = (await c.as(ANNA)('GET', 'sync', null, { since: p2.next, limit: 3 })).json;
    assert.equal(p3.more, false);
    assert.equal(p3.next, p3.seq);
    assert.deepEqual([...p1.items, ...p2.items, ...p3.items].map((x) => x.id), ids);
    assert.equal(p2.account, null);
    const again = (await c.as(ANNA)('GET', 'sync', null, { since: p3.next })).json;
    assert.deepEqual([again.items.length, again.more], [0, false]);
    await c.item(ANNA, v, 1, { id: ids[2], baseRev: 1 });
    assert.deepEqual((await c.as(ANNA)('GET', 'sync', null, { since: p3.next })).json.items.map((x) => [x.id, x.rev]), [[ids[2], 2]]);
    // one vault from 0 (a vault just shared with the person)
    assert.equal((await c.as(ANNA)('GET', 'sync', null, { vault: v })).json.items.length, 7);
    assert.equal((await c.as(ANNA)('GET', 'sync', null, { vault: fake.id() })).json.code, 'not_found');
    assert.equal((await c.as(ANNA)('GET', 'sync', null, { since: 'x' })).json.code, 'invalid');
    assert.equal((await c.as(ANNA)('GET', 'sync', null, { limit: 9999 })).json.items.length, 7, 'limit capped, not refused');
  });
});

test('limits: the encrypted entries of one vault have a size budget (changes and moves count, the trash too)', async () => {
  const items = require('../server/items');
  const keep = items.LIMITS.vaultChars;
  items.LIMITS.vaultChars = 1500;
  try {
    await withHost({}, async (host, c) => {
      const { personalId: v } = await c.setup(ANNA);
      // budget 1500 characters; fake.blob(n) is ceil(n * 4 / 3) characters of base64url
      const a = await c.item(ANNA, v, 1, { blob: fake.blob(400) }); //  534
      const b = await c.item(ANNA, v, 1, { blob: fake.blob(400) }); // 1068
      assert.equal((await c.item(ANNA, v, 1, { blob: fake.blob(400) })).code, 'limit'); // 1602
      assert.equal((await c.item(ANNA, v, 1, { id: a.id, baseRev: 1, blob: fake.blob(800) })).code, 'limit', 'a change that grows too much'); // 1601
      assert.equal((await c.item(ANNA, v, 1, { id: a.id, baseRev: 1, blob: fake.blob(100) })).ok, true, 'a smaller version'); // 670
      assert.equal((await c.item(ANNA, v, 1, { blob: fake.blob(400) })).ok, true); // 1204
      await c.as(ANNA)('POST', `items/${b.id}/trash`);
      assert.equal((await c.item(ANNA, v, 1, { blob: fake.blob(300) })).code, 'limit', 'the trash still counts'); // 1604
      await c.as(ANNA)('DELETE', `items/${b.id}`); // 670
      // one request with several entries is charged as it goes: 400 + 400 fit (1470), the third does not
      const many = [0, 1, 2].map(() => ({ id: fake.id(), vaultId: v, blob: fake.blob(300), keyRev: 1, baseRev: 0 }));
      assert.deepEqual((await c.as(ANNA)('POST', 'items', { items: many })).json.results.map((r) => r.code || 'ok'), ['ok', 'ok', 'limit']);
      // a move counts against the target vault
      const fam = fake.id();
      await c.as(ANNA)('POST', 'vaults', { id: fam, nameEnc: fake.name(), sealedKey: fake.sealed() });
      await c.item(ANNA, fam, 1, { blob: fake.blob(1000) }); // 1334 in fam
      assert.equal((await c.item(ANNA, fam, 1, { id: many[0].id, baseRev: 1, blob: fake.blob(300) })).code, 'limit');
      assert.equal((await c.item(ANNA, fam, 1, { id: many[0].id, baseRev: 1, blob: fake.blob(100) })).ok, true); // 1470 in fam, 1070 left
    });
  } finally {
    items.LIMITS.vaultChars = keep;
  }
});

