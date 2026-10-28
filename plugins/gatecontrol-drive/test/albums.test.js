'use strict';

// Albums (1.7.0, server/albums.js): an album of an area points at photos — who reads the area sees it, who writes in it
// changes it; items others cannot read stay hidden; cover, rename, remove, delete; the frame switch (not a child, a
// family's album only by a parent or an administrator).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, BOB } = require('./helpers');

async function photos(c, user, area, n, prefix = 'Bild') {
  const out = [];
  for (let i = 1; i <= n; i++) out.push((await c.put(user, area.rootId, `${prefix}${i}.jpg`, `${prefix}${i}`, { mime: 'image/jpeg', takenAt: Date.UTC(2026, 0, i) })).json.node);
  return out;
}

test('an album of my files: create, add, list, items, cover, rename, take out, delete — the photos stay', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const pics = await photos(c, ANNA, mine, 3);
    const doc = (await c.put(ANNA, mine.rootId, 'Brief.pdf', '%PDF', { mime: 'application/pdf' })).json.node;
    const made = await a('POST', 'albums', { name: '  Urlaub   2026 ' });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const al = made.json.album;
    assert.deepEqual({ name: al.name, areaId: al.areaId, count: al.count, coverId: al.coverId, frame: al.frame, canEdit: al.canEdit, canFrame: al.canFrame },
      { name: 'Urlaub 2026', areaId: mine.id, count: 0, coverId: null, frame: false, canEdit: true, canFrame: true });
    assert.equal((await a('POST', 'albums', { name: '' })).status, 400);
    // only pictures and videos one reads
    const bad = await a('POST', `albums/${al.id}/items`, { ids: [pics[0].id, doc.id] });
    assert.equal(bad.status, 400);
    assert.deepEqual([bad.json.field, bad.json.ids], ['ids', [doc.id]]);
    assert.equal((await a('POST', `albums/${al.id}/items`, { ids: new Array(501).fill(pics[0].id) })).status, 400, '≤ 500');
    const add = await a('POST', `albums/${al.id}/items`, { ids: pics.map((p) => p.id) });
    assert.equal(add.status, 200);
    assert.equal(add.json.album.count, 3);
    assert.equal(add.json.album.coverId, pics[2].id, 'the newest without a cover chosen');
    assert.equal((await a('POST', `albums/${al.id}/items`, { ids: [pics[0].id] })).json.album.count, 3, 'twice: once');
    const list = (await a('GET', 'albums')).json.albums;
    assert.deepEqual(list.map((x) => [x.id, x.count]), [[al.id, 3]]);
    assert.match(list[0].coverUrl, /\/media\/[0-9a-f]{32}\/preview$/);
    // items like GET photos
    const got = (await a('GET', `albums/${al.id}`, null, { limit: '2' })).json;
    assert.deepEqual(got.items.map((x) => x.name), ['Bild3.jpg', 'Bild2.jpg']);
    assert.ok(got.next);
    assert.deepEqual((await a('GET', `albums/${al.id}`, null, { before: got.next })).json.items.map((x) => x.name), ['Bild1.jpg']);
    // cover: one of its items
    assert.equal((await a('PATCH', `albums/${al.id}`, { coverId: doc.id })).status, 400);
    assert.equal((await a('PATCH', `albums/${al.id}`, { coverId: pics[0].id, name: 'Sommer' })).json.album.coverId, pics[0].id);
    // a photo in the trash is left out; back from it, it is there again
    await a('DELETE', `nodes/${pics[0].id}`);
    let now = (await a('GET', `albums/${al.id}`)).json;
    assert.deepEqual([now.album.count, now.album.coverId, now.album.name], [2, pics[2].id, 'Sommer']);
    await a('POST', `trash/${pics[0].id}/restore`);
    assert.equal((await a('GET', `albums/${al.id}`)).json.album.count, 3);
    // take out (also ?ids=) — the files stay
    assert.equal((await a('DELETE', `albums/${al.id}/items`, { ids: [pics[1].id] })).json.album.count, 2);
    assert.equal((await a('DELETE', `albums/${al.id}/items`, null, { ids: String(pics[2].id) })).json.album.count, 1);
    assert.equal((await a('GET', `nodes/${pics[1].id}`)).status, 200);
    // purged for good: gone from the album too
    await a('DELETE', `nodes/${pics[0].id}`);
    await a('DELETE', `trash/${pics[0].id}`);
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM album_items WHERE node_id = ?', [pics[0].id])).row.n, 0);
    const del = await a('DELETE', `albums/${al.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.json.ok, true);
    assert.equal((await a('GET', `albums/${al.id}`)).status, 404);
    assert.equal((await a('GET', `nodes/${pics[1].id}`)).status, 200);
  });
});

test('rights: the family\'s album — members see and change it, items from my own files stay hidden from them; others see nothing', async () => {
  await withHost({}, async (host, c) => {
    const fam = await c.area(ANNA, 'family');
    const mine = await c.area(ANNA, 'mine');
    const famPics = await photos(c, ANNA, fam, 2, 'Fam');
    const minePics = await photos(c, ANNA, mine, 1, 'Privat');
    const al = (await c.as(ANNA)('POST', 'albums', { name: 'Familie', areaId: fam.id })).json.album;
    assert.equal((await c.as(ANNA)('POST', `albums/${al.id}/items`, { ids: [...famPics, ...minePics].map((p) => p.id) })).json.album.count, 3);
    // Marc (parent, family member): sees it without Anna's own photo, may change it and switch the frame
    const m = (await c.as(MARC)('GET', 'albums')).json.albums.find((x) => x.id === al.id);
    assert.deepEqual([m.count, m.canEdit, m.canFrame], [2, true, true]);
    assert.deepEqual((await c.as(MARC)('GET', `albums/${al.id}`)).json.items.map((x) => x.name).sort(), ['Fam1.jpg', 'Fam2.jpg']);
    assert.equal((await c.as(MARC)('POST', `albums/${al.id}/items`, { ids: [minePics[0].id] })).status, 400, 'not one he reads');
    assert.equal((await c.as(MARC)('PATCH', `albums/${al.id}`, { name: 'Familie Berg' })).status, 200);
    // Lena (a child of the family): sees and changes it, but never switches the frame
    const l = (await c.as(LENA)('GET', 'albums')).json.albums.find((x) => x.id === al.id);
    assert.deepEqual([l.count, l.canEdit, l.canFrame], [2, true, false]);
    const no = await c.as(LENA)('PATCH', `albums/${al.id}`, { frame: true });
    assert.equal(no.status, 403);
    assert.equal(no.json.field, 'frame');
    assert.equal((await c.as(LENA)('POST', 'albums', { name: 'Meins' })).json.album.canFrame, false, 'not in her own files either');
    const child = await c.area(LENA, 'child');
    assert.equal((await c.as(LENA)('POST', 'albums', { name: 'Kinderordner', areaId: child.id })).json.album.canFrame, false);
    // Anna reads Lena's folder: sees an album there, may not change it
    const kid = (await c.as(LENA)('GET', 'albums')).json.albums.find((x) => x.areaId === child.id);
    const seen = (await c.as(ANNA)('GET', 'albums')).json.albums.find((x) => x.id === kid.id);
    assert.deepEqual([seen.canEdit, seen.canFrame], [false, false]);
    assert.equal((await c.as(ANNA)('PATCH', `albums/${kid.id}`, { name: 'x' })).status, 403);
    assert.equal((await c.as(ANNA)('DELETE', `albums/${kid.id}`)).status, 403);
    // Bob (no family): nothing of it
    assert.equal((await c.as(BOB)('GET', `albums/${al.id}`)).status, 404);
    assert.equal((await c.as(BOB)('PATCH', `albums/${al.id}`, { name: 'x' })).status, 404);
    assert.ok(!(await c.as(BOB)('GET', 'albums')).json.albums.some((x) => x.id === al.id));
    assert.equal((await c.as(BOB)('POST', 'albums', { name: 'x', areaId: fam.id })).status, 404);
    // Marc switches the frame on (a parent), the album says who may
    const on = await c.as(MARC)('PATCH', `albums/${al.id}`, { frame: true });
    assert.equal(on.status, 200);
    assert.equal(on.json.album.frame, true);
    assert.equal((await c.as(MARC)('PATCH', `albums/${al.id}`, { frame: 'ja' })).status, 400);
  });
});
