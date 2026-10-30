'use strict';

// Photos found by what is on them (1.14.0, server/labels.js, server/photos.js): the phones' labels (PUT nodes/<id>/labels),
// GET photos?q= with German words (and prefixes, plurals), the chips and the total, ?unlabeled=1 for the backfill,
// `labeled` on photo items, rights, and the labels going with the file.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, BOB, MIN } = require('./helpers');
const labels = require('../server/labels');

test('the German words of the label map', () => {
  assert.deepEqual(labels.labelsFor('Strand'), ['beach']);
  assert.ok(labels.labelsFor('Hunde').includes('dog'), 'a plural');
  assert.ok(labels.labelsFor('sonnen').includes('sunset') && labels.labelsFor('sonnen').includes('sunrise'), 'a prefix');
  assert.ok(labels.labelsFor('Fahrrad').includes('bicycle'));
  assert.ok(labels.labelsFor('beach').includes('beach'), 'the English label itself');
  assert.ok(labels.labelsFor('kuehe').length === 0 && labels.labelsFor('Kühe').includes('cattle'));
  assert.equal(labels.textOf('beach', 'de'), 'Strand');
  assert.equal(labels.textOf('beach', 'en'), 'Beach');
  assert.equal(labels.textOf('zeppelin', 'de'), 'Zeppelin');
  assert.ok(Object.keys(require('../server/labels.json').de).length >= 400, 'about 400 labels');
});

test('labels of a photo, the search with chips, the backfill list, rights', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const me = (await a('GET', 'me')).json;
    assert.ok(me.features.includes('photoSearch'));
    const mine = me.areas.find((x) => x.kind === 'mine');
    const put = async (name, i) => {
      c.clock.add(MIN);
      return (await c.put(ANNA, mine.rootId, name, 'jpeg' + i, { mime: 'image/jpeg' })).json.node;
    };
    const p1 = await put('strand1.jpg', 1);
    const p2 = await put('strand2.jpg', 2);
    const p3 = await put('hund.jpg', 3);
    const p4 = await put('neu.jpg', 4);
    const doc = (await c.put(ANNA, mine.rootId, 'a.pdf', 'pdf', { mime: 'application/pdf' })).json.node;
    // the phone's labels
    let r = await a('PUT', `nodes/${p1.id}/labels`, { labels: ['Beach', 'Sea', 'Sunset', 'sea', ' Sky '], source: 'device' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json, { ok: true, id: p1.id, labels: ['beach', 'sea', 'sunset', 'sky'], labeledAt: new Date(c.clock.now()).toISOString() });
    await a('PUT', `nodes/${p2.id}/labels`, { labels: ['Beach', 'Sea', 'Person'] });
    await a('PUT', `nodes/${p3.id}/labels`, { labels: ['Dog', 'Grass', 'Beach'] });
    // nothing found: marked as looked at
    await a('PUT', `nodes/${p4.id}/labels`, { labels: [] });

    // „Strand“: three photos, chips of the other labels by count
    r = await a('GET', 'photos', null, { q: 'Strand' });
    assert.deepEqual(r.json.items.map((x) => x.name), ['hund.jpg', 'strand2.jpg', 'strand1.jpg']);
    assert.deepEqual(r.json.search.terms, ['Strand']);
    assert.deepEqual(r.json.search.labels, ['beach']);
    assert.equal(r.json.search.total, 3);
    assert.deepEqual(r.json.search.chips.slice(0, 1), [{ label: 'sea', text: 'Meer', count: 2 }]);
    assert.ok(r.json.search.chips.every((x) => x.count < 3));
    // the same at the top: terms [{ term, label, count }] and total
    assert.equal(r.json.total, 3);
    assert.deepEqual(r.json.terms[0], { term: 'Meer', label: 'sea', count: 2 });
    // „Strand Meer“ (a chip taken): both words
    r = await a('GET', 'photos', null, { q: 'Strand Meer' });
    assert.deepEqual(r.json.items.map((x) => x.name), ['strand2.jpg', 'strand1.jpg']);
    // plurals, prefixes, English
    assert.deepEqual((await a('GET', 'photos', null, { q: 'Hunde' })).json.items.map((x) => x.name), ['hund.jpg']);
    assert.deepEqual((await a('GET', 'photos', null, { q: 'Sonnenunterg' })).json.items.map((x) => x.name), ['strand1.jpg']);
    assert.deepEqual((await a('GET', 'photos', null, { q: 'dog' })).json.items.map((x) => x.name), ['hund.jpg']);
    r = await a('GET', 'photos', null, { q: 'Giraffe' });
    assert.deepEqual([r.json.items, r.json.search.total, r.json.search.chips], [[], 0, []]);
    assert.equal((await a('GET', 'photos', null, { q: 'x' })).status, 400);
    // months with q
    assert.deepEqual((await a('GET', 'photos/months', null, { q: 'Strand' })).json.months.map((m) => m.count), [3]);
    // items say whether a phone looked at them; the backfill list has the rest
    const all = (await a('GET', 'photos')).json.items;
    assert.deepEqual(all.map((x) => [x.name, x.labeled]), [['neu.jpg', true], ['hund.jpg', true], ['strand2.jpg', true], ['strand1.jpg', true]]);
    const p5 = await put('ohne.jpg', 5);
    assert.deepEqual((await a('GET', 'photos', null, { unlabeled: 1 })).json.items.map((x) => x.id), [p5.id]);

    // rights: a picture or video one writes to
    assert.equal((await a('PUT', `nodes/${doc.id}/labels`, { labels: ['text'] })).status, 400);
    assert.equal((await c.as(BOB)('PUT', `nodes/${p1.id}/labels`, { labels: ['x'] })).status, 404);
    const child = await c.area(LENA, 'child');
    const lp = (await c.put(LENA, child.rootId, 'lena.jpg', 'jl', { mime: 'image/jpeg' })).json.node;
    assert.equal((await c.as(MARC)('PUT', `nodes/${lp.id}/labels`, { labels: ['cat'] })).status, 403, 'a parent only reads');
    assert.ok(!(await c.as(MARC)('GET', 'photos', null, { unlabeled: 1 })).json.items.some((x) => x.id === lp.id), 'not in a parent\'s backfill');
    assert.ok((await c.as(LENA)('GET', 'photos', null, { unlabeled: 1 })).json.items.some((x) => x.id === lp.id));
    // the body
    assert.equal((await a('PUT', `nodes/${p5.id}/labels`, { labels: 'beach' })).status, 400);
    assert.equal((await a('PUT', `nodes/${p5.id}/labels`, { labels: Array.from({ length: 21 }, (_, i) => 'l' + i) })).status, 400);
    assert.equal((await a('PUT', `nodes/${p5.id}/labels`, { labels: ['x'.repeat(41)] })).status, 400);
    assert.equal((await a('PUT', `nodes/${p5.id}/labels`, { labels: ['beach'], source: 'server' })).status, 400);

    // the labels go with the file: trash (not found while there), purge (gone)
    await a('DELETE', `nodes/${p3.id}`);
    assert.deepEqual((await a('GET', 'photos', null, { q: 'Hund' })).json.items, []);
    await a('DELETE', `trash/${p3.id}`);
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM node_labels WHERE node_id = ?', [p3.id])).row.n, 0);
  });
});
