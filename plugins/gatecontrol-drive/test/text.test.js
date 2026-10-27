'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC } = require('./helpers');

test('recognised text: stored with the commit, found by search, dropped with new bytes and on purge', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const text = 'REISEPASS\r\nBundesrepublik Deutschland\u0000\n\n\n\nGültig bis 14.03.2027';
    const up = await c.put(ANNA, mine.rootId, 'Scan 2026-10-27.pdf', 'pdf1', { mime: 'application/pdf', text });
    assert.equal(up.status, 200);
    const id = up.json.node.id;
    // found by its text, with a snippet around the hit
    let s = await a('GET', 'search', null, { q: 'bundesrepublik' });
    assert.equal(s.status, 200);
    assert.deepEqual(s.json.items.map((x) => [x.id, x.match]), [[id, 'text']]);
    assert.match(s.json.items[0].snippet, /Bundesrepublik Deutschland/);
    assert.doesNotMatch(s.json.items[0].snippet, /\u0000/);
    // a name hit comes first and only once
    s = await a('GET', 'search', null, { q: 'scan' });
    assert.deepEqual(s.json.items.map((x) => [x.id, x.match]), [[id, 'name']]);
    // nobody else finds it
    assert.deepEqual((await c.as(MARC)('GET', 'search', null, { q: 'bundesrepublik' })).json.items, []);
    // not a string: invalid
    const bad = await c.put(ANNA, mine.rootId, 'x.pdf', 'pdf2', { mime: 'application/pdf', text: 42 });
    assert.equal(bad.status, 400);
    // a new version without text: the old text belonged to other bytes
    const v2 = await c.put(ANNA, mine.rootId, 'Scan 2026-10-27.pdf', 'pdf3', { mime: 'application/pdf', onConflict: 'version' });
    assert.equal(v2.json.node.id, id);
    assert.deepEqual((await a('GET', 'search', null, { q: 'bundesrepublik' })).json.items, []);
    // a new version with text, then restoring the old one drops it again
    await c.put(ANNA, mine.rootId, 'Scan 2026-10-27.pdf', 'pdf4', { mime: 'application/pdf', onConflict: 'version', text: 'Zeugnis Klasse 7' });
    assert.equal((await a('GET', 'search', null, { q: 'zeugnis' })).json.items.length, 1);
    const versions = (await a('GET', `nodes/${id}/versions`)).json.versions;
    assert.equal((await a('POST', `nodes/${id}/versions/${versions[0].id}/restore`)).status, 200);
    assert.deepEqual((await a('GET', 'search', null, { q: 'zeugnis' })).json.items, []);
    // in the trash: not found; purged: the text is gone
    await c.put(ANNA, mine.rootId, 'Brief.pdf', 'pdf5', { mime: 'application/pdf', text: 'Elternbrief Herbstferien' });
    const brief = (await a('GET', 'search', null, { q: 'herbstferien' })).json.items[0];
    assert.equal((await a('DELETE', `nodes/${brief.id}`)).status, 200);
    assert.deepEqual((await a('GET', 'search', null, { q: 'herbstferien' })).json.items, []);
    assert.equal((await a('DELETE', `trash/${brief.id}`)).status, 200);
  });
});

test('GET me: the default format of scans (setting scan_format)', async () => {
  await withHost({}, async (host, c) => {
    assert.equal((await c.as(ANNA)('GET', 'me')).json.settings.scanFormat, 'pdf');
  });
  await withHost({ settings: { scan_format: 'image' } }, async (host, c) => {
    assert.equal((await c.as(ANNA)('GET', 'me')).json.settings.scanFormat, 'image');
  });
});
