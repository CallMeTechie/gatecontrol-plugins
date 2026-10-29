'use strict';

// A ZIP of a selection (feature zip) and one link for several files (feature multiLink) — 1.12.0, both through
// GateControl's public links.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, MIN } = require('./helpers');

async function setup(c) {
  const a = c.as(ANNA);
  const mine = await c.area(ANNA, 'mine');
  const d = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Urlaub' })).json.node;
  const sub = (await a('POST', 'nodes', { parentId: d.id, name: 'Tag 1' })).json.node;
  const put = async (p, n, data) => (await c.put(ANNA, p, n, data)).json.node;
  return { a, mine, d, sub, f1: await put(d.id, 'Brief.pdf', 'pdf1'), f2: await put(sub.id, 'Brief.pdf', 'pdf2'), f3: await put(sub.id, 'Bild.jpg', 'jpg') };
}

test('POST zip: one folder, or up to 20 files from anywhere — a link of 15 minutes in no list', async () => {
  await withHost({}, async (host, c) => {
    const s = await setup(c);
    const z = await s.a('POST', 'zip', { ids: [s.d.id] });
    assert.equal(z.status, 200, JSON.stringify(z.json));
    assert.match(z.json.url, /^https:\/\/gc\.example\.com\/s\/[A-Za-z0-9_-]{24}\/zip$/);
    assert.deepEqual([z.json.name, z.json.files], ['Urlaub.zip', 3]);
    assert.equal(Date.parse(z.json.expiresAt), c.clock.now() + 15 * MIN);
    const token = z.json.url.split('/')[4];
    const g = host.publicLinks.get(token);
    assert.deepEqual([g.kind, g.mode, g.path, g.ownerUserId], ['folder', 'download', 'Urlaub', ANNA.id]);
    // files from two folders: the same name twice gets a number
    const f = await s.a('POST', 'zip', { ids: [s.f1.id, s.f2.id, s.f3.id] });
    assert.equal(f.json.name, 'Drive – 3 Dateien.zip');
    const gf = host.publicLinks.get(f.json.url.split('/')[4]);
    assert.deepEqual(gf.files.map((x) => x.name), ['Brief.pdf', 'Brief (2).pdf', 'Bild.jpg']);
    // an empty file is left out
    const e = (await s.a('POST', 'uploads/commit', { parentId: s.d.id, name: 'leer.txt', size: 0 })).json.node;
    const fe = await s.a('POST', 'zip', { ids: [s.f1.id, e.id], name: 'Auswahl' });
    assert.deepEqual([fe.json.name, fe.json.files, fe.json.skipped], ['Auswahl.zip', 1, [{ id: e.id, reason: 'empty' }]]);
    // not in the lists
    assert.deepEqual((await s.a('GET', 'links')).json.links, []);
    // a folder and files, two folders, too many
    assert.deepEqual([(await s.a('POST', 'zip', { ids: [s.d.id, s.f1.id] })).json.reason], ['mixed']);
    assert.deepEqual([(await s.a('POST', 'zip', { ids: [s.d.id, s.sub.id] })).json.reason], ['mixed']);
    const many = await s.a('POST', 'zip', { ids: new Array(21).fill(0).map((x, i) => s.f1.id + 100 + i) });
    assert.deepEqual([many.status, many.json.reason, many.json.max], [400, 'too_many', 20]);
    // somebody else's: not found
    assert.equal((await c.as(MARC)('POST', 'zip', { ids: [s.f1.id] })).status, 404);
    // a reader may download: a parent in the child's folder
    const lena = await c.area(LENA, 'child');
    const lf = (await c.put(LENA, lena.rootId, 'Bild.png', 'png')).json.node;
    assert.equal((await s.a('POST', 'zip', { ids: [lf.id] })).status, 200);
  });
  await withHost({ links: false }, async (host, c) => {
    const s = await setup(c);
    const z = await s.a('POST', 'zip', { ids: [s.d.id] });
    assert.deepEqual([z.status, z.json.code], [403, 'links_disabled']);
  });
});

test('POST links { nodeIds }: one link for several files; a folder among them is refused; a file in the trash ends it', async () => {
  await withHost({}, async (host, c) => {
    const s = await setup(c);
    const l = await s.a('POST', 'links', { nodeIds: [s.f1.id, s.f2.id, s.f3.id], mode: 'download', expires: '7d', pin: '1234' });
    assert.equal(l.status, 200, JSON.stringify(l.json));
    assert.deepEqual([l.json.link.kind, l.json.link.count, l.json.link.nodeIds, l.json.link.title, l.json.link.pin], ['files', 3, [s.f1.id, s.f2.id, s.f3.id], '3 Dateien', true]);
    const g = host.publicLinks.get(l.json.link.token);
    assert.deepEqual(g.files.map((x) => x.name), ['Brief.pdf', 'Brief (2).pdf', 'Bild.jpg']);
    // the lists: mine, and those of each of its files
    assert.equal((await s.a('GET', 'links')).json.links[0].count, 3);
    assert.equal((await s.a('GET', 'links', null, { nodeId: s.f3.id })).json.links.length, 1);
    // one id: as before
    const one = await s.a('POST', 'links', { nodeIds: [s.f1.id] });
    assert.equal(one.json.link.count, undefined);
    // a folder among them, too many, an empty file
    const mixed = await s.a('POST', 'links', { nodeIds: [s.f1.id, s.sub.id] });
    assert.deepEqual([mixed.status, mixed.json.code, mixed.json.reason], [400, 'invalid', 'mixed']);
    assert.equal((await s.a('POST', 'links', { nodeIds: new Array(21).fill(0).map((x, i) => i + 1) })).json.reason, 'too_many');
    const e = (await s.a('POST', 'uploads/commit', { parentId: s.d.id, name: 'leer.txt', size: 0 })).json.node;
    const em = await s.a('POST', 'links', { nodeIds: [s.f1.id, e.id] });
    assert.deepEqual([em.json.reason, em.json.ids], ['empty', [e.id]]);
    assert.equal((await s.a('POST', 'links', { nodeIds: [s.f1.id, s.f2.id], mode: 'upload' })).status, 400);
    // a file of it into the trash: the link ends
    await s.a('DELETE', `nodes/${s.f3.id}`);
    const after = (await s.a('GET', 'links')).json.links.find((x) => x.token === l.json.link.token);
    assert.deepEqual([after.state, after.endedWhy], ['ended', 'trashed']);
  });
});

test('GateControl 1.215 (zipMixed): a ZIP and one link of any selection — folders as their files with paths', async () => {
  await withHost({ gatecontrol: '1.215.0' }, async (host, c) => {
    const s = await setup(c);
    assert.ok((await s.a('GET', 'me')).json.features.includes('zipMixed'));
    const other = (await s.a('POST', 'nodes', { parentId: s.mine.rootId, name: 'Andere' })).json.node;
    const o1 = (await c.put(ANNA, other.id, 'Brief.pdf', 'other')).json.node;
    // a folder and a file of elsewhere: the folder's files under its name, the file at the top
    const z = await s.a('POST', 'zip', { ids: [s.d.id, o1.id] });
    assert.equal(z.status, 200, JSON.stringify(z.json));
    assert.deepEqual([z.json.name, z.json.files], ['Drive – 4 Dateien.zip', 4]);
    const g = host.publicLinks.get(z.json.url.split('/')[4]);
    assert.equal(g.kind, 'files');
    assert.deepEqual(g.files.map((x) => [x.path || '', x.name]).sort(), [['', 'Brief.pdf'], ['Urlaub', 'Brief.pdf'], ['Urlaub/Tag 1', 'Bild.jpg'], ['Urlaub/Tag 1', 'Brief.pdf']]);
    // a single folder alone stays a folder link
    assert.equal(host.publicLinks.get((await s.a('POST', 'zip', { ids: [s.d.id] })).json.url.split('/')[4]).kind, 'folder');
    // more than 20 files now
    const many = (await s.a('POST', 'nodes', { parentId: s.mine.rootId, name: 'Viele' })).json.node;
    for (let i = 0; i < 25; i++) await c.put(ANNA, many.id, `f${i}.txt`, `x${i}`);
    const zm = await s.a('POST', 'zip', { ids: [many.id, s.f1.id] });
    assert.equal(zm.json.files, 26);
    // one link: a folder among the files; a file of the folder in the trash ends it
    const l = await s.a('POST', 'links', { nodeIds: [s.sub.id, o1.id], mode: 'view', expires: '1d' });
    assert.equal(l.status, 200, JSON.stringify(l.json));
    assert.deepEqual([l.json.link.count, l.json.link.files, l.json.link.nodeIds], [2, 3, [s.sub.id, o1.id]]);
    assert.deepEqual(host.publicLinks.get(l.json.link.token).files.map((x) => x.path || '').sort(), ['', 'Tag 1', 'Tag 1']);
    assert.deepEqual((await s.a('GET', 'links')).json.links.find((x) => x.token === l.json.link.token).nodeIds, [s.sub.id, o1.id]);
    await s.a('DELETE', `nodes/${s.f3.id}`);
    const after = (await s.a('GET', 'links')).json.links.find((x) => x.token === l.json.link.token);
    assert.deepEqual([after.state, after.endedWhy], ['ended', 'trashed']);
  });
});
