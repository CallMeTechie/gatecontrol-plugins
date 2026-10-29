'use strict';

// When a photo was taken (1.7.0, uploads/commit { takenAt }, node takenAt) and the photos (GET photos, months,
// memories — server/photos.js): newest first by takenAt, pictures and videos only, the areas one reads, pages that
// never split a moment, months, "Vor einem Jahr".

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, BOB, DAY, T0 } = require('./helpers');

const iso = (ms) => new Date(ms).toISOString();

test('takenAt: ISO or ms, invalid → 400, too far ahead or before 1900 ignored, else mtime, else when it came; versions keep it', async () => {
  await withHost({}, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const at = Date.UTC(2024, 6, 14, 16, 30, 5);
    const one = await c.put(ANNA, mine.rootId, 'Strand.jpg', 'jpeg 1', { mime: 'image/jpeg', takenAt: iso(at), mtime: Date.UTC(2025, 0, 1) });
    assert.equal(one.status, 200);
    assert.equal(one.json.node.takenAt, iso(at));
    const two = await c.put(ANNA, mine.rootId, 'Berg.jpg', 'jpeg 2', { mime: 'image/jpeg', takenAt: at + 1000 });
    assert.equal(two.json.node.takenAt, iso(at + 1000), 'ms since the epoch');
    const three = await c.put(ANNA, mine.rootId, 'See.jpg', 'jpeg 3', { mime: 'image/jpeg', takenAt: String(at + 2000) });
    assert.equal(three.json.node.takenAt, iso(at + 2000), 'ms as a string');
    const bad = await c.put(ANNA, mine.rootId, 'Bad.jpg', 'jpeg 4', { mime: 'image/jpeg', takenAt: 'gestern' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.field, 'takenAt');
    const mtime = Date.UTC(2023, 1, 2);
    const ahead = await c.put(ANNA, mine.rootId, 'Zukunft.jpg', 'jpeg 5', { mime: 'image/jpeg', takenAt: c.clock.now() + 2 * DAY, mtime });
    assert.equal(ahead.json.node.takenAt, iso(mtime), 'more than a day ahead: ignored, mtime counts');
    const old = await c.put(ANNA, mine.rootId, 'Alt.jpg', 'jpeg 6', { mime: 'image/jpeg', takenAt: '1850-01-01T00:00:00Z' });
    assert.equal(old.json.node.takenAt, iso(c.clock.now()), 'before 1900: ignored, no mtime: when it came');
    const soon = await c.put(ANNA, mine.rootId, 'Gleich.jpg', 'jpeg 7', { mime: 'image/jpeg', takenAt: c.clock.now() + 3600000 });
    assert.equal(soon.json.node.takenAt, iso(c.clock.now() + 3600000), 'within a day ahead: taken');
    const row = (await host.gc.db.get('SELECT taken_at FROM nodes WHERE id = ?', [ahead.json.node.id])).row;
    assert.equal(row.taken_at, null, 'stored as null');
    // a new version without takenAt keeps it; with one takes it
    c.clock.add(60000);
    const v2 = await c.put(ANNA, mine.rootId, 'Strand.jpg', 'jpeg 1 bearbeitet', { mime: 'image/jpeg', onConflict: 'version' });
    assert.equal(v2.json.node.takenAt, iso(at));
    const v3 = await c.put(ANNA, mine.rootId, 'Strand.jpg', 'jpeg 1 neu', { mime: 'image/jpeg', onConflict: 'version', takenAt: iso(at - 1000) });
    assert.equal(v3.json.node.takenAt, iso(at - 1000));
    // every node answer has it; a folder: null
    const dir = (await c.as(ANNA)('POST', 'nodes', { parentId: mine.rootId, name: 'Ordner' })).json.node;
    assert.equal(dir.takenAt, null);
    const kids = (await c.as(ANNA)('GET', `nodes/${mine.rootId}/children`)).json.items;
    assert.ok(kids.every((k) => (k.isDir ? k.takenAt === null : typeof k.takenAt === 'string')));
    assert.equal((await c.as(ANNA)('GET', `nodes/${one.json.node.id}`)).json.node.takenAt, iso(at - 1000));
  });
});

test('photos: pictures and videos newest first by takenAt, the areas one reads, pages that keep a moment together', async () => {
  await withHost({ gatecontrol: '1.208.0' }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const fam = await c.area(ANNA, 'family');
    const base = Date.UTC(2026, 5, 1, 12);
    const put = (area, name, t, mime = 'image/jpeg') => c.put(ANNA, area.rootId, name, name, { mime, takenAt: t });
    const a = (await put(mine, 'a.jpg', base)).json.node;
    const b = (await put(mine, 'b.mp4', base + 1000, 'video/mp4')).json.node;
    await put(mine, 'notes.txt', base + 5000, 'text/plain');
    const d = (await put(fam, 'd.jpg', base + 3000)).json.node;
    const same = [];
    for (let i = 0; i < 4; i++) same.push((await put(fam, `burst${i}.jpg`, base + 2000)).json.node);
    const all = await c.as(ANNA)('GET', 'photos');
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.items.map((x) => x.name), ['d.jpg', 'burst3.jpg', 'burst2.jpg', 'burst1.jpg', 'burst0.jpg', 'b.mp4', 'a.jpg']);
    assert.equal(all.json.next, null);
    const item = all.json.items.find((x) => x.id === a.id);
    assert.deepEqual(Object.keys(item).sort(), ['areaId', 'id', 'largeUrl', 'mediaId', 'mime', 'name', 'parentId', 'preview', 'previewUrl', 'size', 'takenAt', 'review', 'work'].sort());
    // since 1.13.0: the review mark and the work bag
    assert.deepEqual([item.review, item.work], [null, false]);
    assert.equal(item.takenAt, iso(base));
    assert.equal(item.preview, true);
    assert.equal(item.previewUrl, `/api/v1/client/plugins/gatecontrol-drive/media/${a.mediaId}/preview`, 'the app\'s endpoint');
    assert.equal(all.json.items.find((x) => x.id === b.id).preview, false, 'a video without the device\'s preview');
    const portal = (await c.portal(ANNA)('GET', 'photos')).json.items.find((x) => x.id === a.id);
    assert.match(portal.previewUrl, /^\/plugin-media\/[0-9a-f]{32}\.\d+\.\d+\.[A-Za-z0-9_-]{22}\/preview$/);
    assert.equal(portal.largeUrl, portal.previewUrl + '?size=large');
    // pages: limit 2 ends after the whole burst (same moment), then goes on below it
    const p1 = (await c.as(ANNA)('GET', 'photos', null, { limit: '2' })).json;
    assert.deepEqual(p1.items.map((x) => x.name), ['d.jpg', 'burst3.jpg', 'burst2.jpg', 'burst1.jpg', 'burst0.jpg']);
    assert.equal(p1.next, iso(base + 2000));
    const p2 = (await c.as(ANNA)('GET', 'photos', null, { limit: '2', before: p1.next })).json;
    assert.deepEqual(p2.items.map((x) => x.name), ['b.mp4', 'a.jpg']);
    assert.equal(p2.next, null);
    // one area; one not readable; the trash is left out
    assert.deepEqual((await c.as(ANNA)('GET', 'photos', null, { area: mine.id })).json.items.map((x) => x.name), ['b.mp4', 'a.jpg']);
    assert.equal((await c.as(BOB)('GET', 'photos', null, { area: mine.id })).status, 404);
    assert.deepEqual((await c.as(BOB)('GET', 'photos')).json.items, []);
    await c.as(ANNA)('DELETE', `nodes/${d.id}`);
    const marc = (await c.as(MARC)('GET', 'photos')).json.items.map((x) => x.name);
    assert.deepEqual(marc, ['burst3.jpg', 'burst2.jpg', 'burst1.jpg', 'burst0.jpg'], 'Marc reads the family\'s, not Anna\'s own');
    for (const [q, field] of [[{ before: 'gestern' }, 'before'], [{ limit: '0' }, 'limit']]) {
      const r = await c.as(ANNA)('GET', 'photos', null, q);
      assert.equal(r.status, 400);
      assert.equal(r.json.field, field);
    }
    // months
    const m = (await c.as(ANNA)('GET', 'photos/months')).json.months;
    assert.deepEqual(m, [{ month: '2026-06', count: 6 }]);
    assert.equal(same.length, 4);
  });
});

test('memories: this calendar day (± 1 day) in earlier years, ≤ 30 a year, nearest year first; a parent looking is noted', async () => {
  await withHost({}, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const now = new Date(T0);
    const y = now.getFullYear();
    const at = (years, days, h = 12) => new Date(y - years, now.getMonth(), now.getDate() + days, h).getTime();
    for (const [name, t] of [['vor1.jpg', at(1, 0)], ['vor1-gestern.jpg', at(1, -1)], ['vor1-morgen.jpg', at(1, 1)], ['vor1-weit.jpg', at(1, 3)],
      ['vor3.jpg', at(3, 0)], ['heute.jpg', at(0, 0, 8)]]) {
      await c.put(ANNA, mine.rootId, name, name, { mime: 'image/jpeg', takenAt: t });
    }
    for (let i = 0; i < 33; i++) await c.put(ANNA, mine.rootId, `viele${i}.jpg`, `v${i}`, { mime: 'image/jpeg', takenAt: at(2, 0) + i });
    const r = (await c.as(ANNA)('GET', 'photos/memories')).json;
    assert.equal(r.date, `${y}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`);
    assert.deepEqual(r.groups.map((g) => [g.yearsAgo, g.items.length]), [[1, 3], [2, 30], [3, 1]]);
    assert.deepEqual(r.groups[0].items.map((x) => x.name), ['vor1-gestern.jpg', 'vor1.jpg', 'vor1-morgen.jpg']);
    assert.equal(r.groups[0].date, `${y - 1}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`);
    // another day
    const other = (await c.as(ANNA)('GET', 'photos/memories', null, { date: `${y}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate() + 3).padStart(2, '0')}` })).json;
    assert.deepEqual(other.groups.map((g) => g.items.map((x) => x.name)), [['vor1-weit.jpg']]);
    for (const bad of ['heute', '2026-02-30', '2026-13-01']) assert.equal((await c.as(ANNA)('GET', 'photos/memories', null, { date: bad })).status, 400, bad);
    // a parent who sees the child's photos: the child hears of it (once a day)
    const child = await c.area(LENA, 'child');
    await c.put(LENA, child.rootId, 'Lena.jpg', 'lena', { mime: 'image/jpeg', takenAt: at(1, 0) });
    await c.as(ANNA)('GET', 'photos');
    assert.equal(c.pushes().filter((n) => n.topic === 'child_view' && n.users.includes(LENA.id)).length, 1);
  });
});
