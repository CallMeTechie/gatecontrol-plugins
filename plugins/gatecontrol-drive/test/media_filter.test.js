'use strict';

// Only pictures or only videos (1.25.0, feature `mediaFilter`): media=image|video on photos, months, memories, classes,
// suggest and search (search then also without q); `durationMs` from uploads/commit on nodes and photo items.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, DAY } = require('./helpers');
const ops = require('../server/ops');

const iso = (ms) => new Date(ms).toISOString();

test('mediaFilter: the feature, photos and months only pictures or only videos, invalid media → 400', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    assert.ok((await a('GET', 'me')).json.features.includes('mediaFilter'));
    const mine = await c.area(ANNA, 'mine');
    const base = Date.UTC(2026, 4, 3, 10);
    const put = (name, t, mime) => c.put(ANNA, mine.rootId, name, name, { mime, takenAt: iso(t) });
    const p1 = (await put('Strand.jpg', base, 'image/jpeg')).json.node;
    const v1 = (await put('Strand.mp4', base + 1000, 'video/mp4')).json.node;
    const p2 = (await put('Berg.heic', base - DAY * 40, 'image/heic')).json.node;
    const v2 = (await put('Berg.mov', base - DAY * 40 + 1000, 'video/quicktime')).json.node;
    await put('Notiz.txt', base + 2000, 'text/plain');

    const ids = (r) => r.json.items.map((x) => x.id);
    assert.deepEqual(ids(await a('GET', 'photos')), [v1.id, p1.id, v2.id, p2.id], 'both without media');
    assert.deepEqual(ids(await a('GET', 'photos', null, { media: 'video' })), [v1.id, v2.id]);
    assert.deepEqual(ids(await a('GET', 'photos', null, { media: 'IMAGE' })), [p1.id, p2.id], 'case does not matter');
    assert.deepEqual(ids(await a('GET', 'photos', null, { media: '' })), [v1.id, p1.id, v2.id, p2.id], 'empty: both');
    // pages of only the videos
    const first = await a('GET', 'photos', null, { media: 'video', limit: 1 });
    assert.deepEqual(ids(first), [v1.id]);
    assert.deepEqual(ids(await a('GET', 'photos', null, { media: 'video', limit: 1, before: first.json.next })), [v2.id]);

    const months = (await a('GET', 'photos/months', null, { media: 'video' })).json.months;
    assert.deepEqual(months.map((m) => m.count), [1, 1]);
    const { work, private: priv, review } = (await a('GET', 'photos/classes', null, { media: 'video' })).json;
    assert.deepEqual({ work, private: priv, review }, { work: 0, private: 2, review: 0 });

    const bad = await a('GET', 'photos', null, { media: 'audio' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.field, 'media');
    assert.equal((await a('GET', 'photos/months', null, { media: 'gif' })).status, 400);
    assert.equal((await a('GET', 'photos/memories', null, { media: 'x' })).status, 400);
  });
});

test('mediaFilter: memories of only the videos (a year ago today)', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const now = new Date(c.clock.now());
    const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate(), 12).getTime();
    const v = (await c.put(ANNA, mine.rootId, 'Geburtstag.mp4', 'v', { mime: 'video/mp4', takenAt: iso(yearAgo) })).json.node;
    await c.put(ANNA, mine.rootId, 'Geburtstag.jpg', 'p', { mime: 'image/jpeg', takenAt: iso(yearAgo + 1000) });
    const all = (await a('GET', 'photos/memories')).json.groups;
    assert.equal(all[0].items.length, 2);
    const vids = (await a('GET', 'photos/memories', null, { media: 'video' })).json.groups;
    assert.deepEqual(vids[0].items.map((x) => x.id), [v.id]);
  });
});

test('search: media=video|image only those files (no folders), also without q; q still at least 2 characters', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    await a('POST', 'nodes', { parentId: mine.rootId, name: 'Urlaub Ordner' });
    const v = (await c.put(ANNA, mine.rootId, 'Urlaub.mp4', 'v', { mime: 'video/mp4' })).json.node;
    c.clock.add(1000);
    const p = (await c.put(ANNA, mine.rootId, 'Urlaub.jpg', 'p', { mime: 'image/jpeg' })).json.node;
    c.clock.add(1000);
    const v2 = (await c.put(ANNA, mine.rootId, 'Hochzeit.mov', 'v2', { mime: 'video/quicktime' })).json.node;
    await c.put(ANNA, mine.rootId, 'Urlaub.pdf', 'd', { mime: 'application/pdf' });

    const names = (r) => r.json.items.map((x) => x.name);
    assert.deepEqual(names(await a('GET', 'search', null, { q: 'urlaub' })).sort(), ['Urlaub Ordner', 'Urlaub.jpg', 'Urlaub.mp4', 'Urlaub.pdf'].sort());
    assert.deepEqual(names(await a('GET', 'search', null, { q: 'urlaub', media: 'video' })), ['Urlaub.mp4']);
    assert.deepEqual(names(await a('GET', 'search', null, { q: 'urlaub', media: 'image' })), ['Urlaub.jpg']);
    // without a word: the newest videos
    const vids = await a('GET', 'search', null, { media: 'video' });
    assert.equal(vids.status, 200);
    assert.deepEqual(vids.json.items.map((x) => x.id), [v2.id, v.id]);
    assert.equal(vids.json.items[0].path, 'Hochzeit.mov');
    assert.ok(!vids.json.items.some((x) => x.id === p.id));
    // q is still checked: one character, or none without media
    assert.equal((await a('GET', 'search', null, { q: 'u', media: 'video' })).status, 400);
    assert.equal((await a('GET', 'search', null, {})).status, 400);
    const bad = await a('GET', 'search', null, { q: 'urlaub', media: 'audio' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.field, 'media');
  });
});

test('search: media also narrows the hits in the recognised text', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    await c.put(ANNA, mine.rootId, 'scan1.jpg', 'x', { mime: 'image/jpeg', text: 'Rechnung Stadtwerke' });
    await c.put(ANNA, mine.rootId, 'brief.pdf', 'y', { mime: 'application/pdf', text: 'Rechnung Telefon' });
    const r = await a('GET', 'search', null, { q: 'rechnung', media: 'image' });
    assert.deepEqual(r.json.items.map((x) => [x.name, x.match]), [['scan1.jpg', 'text']]);
  });
});

test('durationMs: kept for videos, on nodes and photo items, a copy keeps it, a picture or nonsense never', async () => {
  await withHost({ gatecontrol: '1.215.0' }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const v = await c.put(ANNA, mine.rootId, 'Clip.mp4', 'v', { mime: 'video/mp4', durationMs: 83456.4 });
    assert.equal(v.status, 200);
    assert.equal(v.json.node.durationMs, 83456);
    const item = (await a('GET', 'photos', null, { media: 'video' })).json.items[0];
    assert.equal(item.durationMs, 83456);
    // a picture: none, also when sent
    const p = await c.put(ANNA, mine.rootId, 'Bild.jpg', 'p', { mime: 'image/jpeg', durationMs: 5000 });
    assert.equal(p.json.node.durationMs, undefined);
    // 0 or more than 7 days: unknown; not a number: 400
    assert.equal((await c.put(ANNA, mine.rootId, 'Null.mp4', 'n', { mime: 'video/mp4', durationMs: 0 })).json.node.durationMs, undefined);
    assert.equal((await c.put(ANNA, mine.rootId, 'Lang.mp4', 'l', { mime: 'video/mp4', durationMs: 8 * DAY })).json.node.durationMs, undefined);
    const bad = await c.put(ANNA, mine.rootId, 'Bad.mp4', 'b', { mime: 'video/mp4', durationMs: 'lang' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.field, 'durationMs');
    assert.equal((await c.put(ANNA, mine.rootId, 'Bool.mp4', 'b2', { mime: 'video/mp4', durationMs: true })).status, 400);
    // a new version without it: unknown again (it belonged to the old bytes)
    const v2 = await c.put(ANNA, mine.rootId, 'Clip.mp4', 'v neu', { mime: 'video/mp4', onConflict: 'version' });
    assert.equal(v2.json.node.durationMs, undefined);
    const v3 = await c.put(ANNA, mine.rootId, 'Clip.mp4', 'v neuer', { mime: 'video/mp4', onConflict: 'version', durationMs: 1200 });
    assert.equal(v3.json.node.durationMs, 1200);
    // a copy keeps it
    const dir = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Kopien' })).json.node;
    const job = await a('POST', 'ops', { op: 'copy', ids: [v3.json.node.id], target: dir.id });
    assert.equal(job.status, 200, JSON.stringify(job.json));
    await ops.idle();
    const copied = (await a('GET', `nodes/${dir.id}/children`)).json.items.find((x) => x.name === 'Clip.mp4');
    assert.equal(copied.durationMs, 1200);
  });
});
