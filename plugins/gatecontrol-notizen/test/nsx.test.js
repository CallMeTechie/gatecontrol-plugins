'use strict';

// The DS Note import: ui/nsx.js reads test/fixtures/sample.nsx (ZIP, JSON entries, attachments, a protected note) and
// the server takes the batches (server/dsnote.js) — notebooks once per ref, notes with their pictures, a protected
// notebook as a Tresor (the device encrypts; the server never sees its text).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const NSX = require('../ui/nsx');
const { withHost, ANNA, MARC } = require('./helpers');

const FILE = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.nsx'));
const read = (a, b) => Promise.resolve(new Uint8Array(FILE.subarray(a, b)));
const inflateRaw = (b) => Promise.resolve(new Uint8Array(zlib.inflateRawSync(b)));

test('nsx: the fixture is what build-nsx.js writes', () => {
  const { entries, zip } = require('./fixtures/build-nsx');
  assert.deepEqual(zip(entries()), FILE);
});

test('nsx: summary, notes, HTML → Markdown, pictures by ref', async () => {
  const arc = await NSX.open(read, FILE.length, { inflateRaw });
  const sum = await NSX.summary(arc);
  assert.deepEqual(sum.notebooks.map((b) => [b.title, b.notes, b.protected]), [['Haushalt', 2, 0], ['Rezepte & Dokumente', 2, 1]]);
  assert.equal(sum.notes, 4);
  assert.equal(sum.protectedNotes, 1);
  assert.equal(sum.attachments, 2);
  const n1 = await NSX.note(arc, 'N1note1');
  assert.equal(n1.title, 'Gartenhaus Maße');
  assert.deepEqual(n1.tags, ['garten', 'bauen']);
  assert.equal(n1.created, 1760000000000);
  assert.deepEqual(n1.attachments.map((a) => [a.name, a.mime, !!a.entry]), [['skizze.png', 'image/png', true], ['Angebot.pdf', 'application/pdf', true]]);
  const png = await arc.bytes(n1.attachments[0].entry);
  assert.equal(Buffer.from(png).subarray(1, 4).toString(), 'PNG');
  const md = NSX.toMarkdown(n1.html, { image: (ref) => (ref === n1.attachments[0].ref ? 'attnew:0' : null) });
  assert.equal(md, '## Maße\n\nBreite **2,40 m**, Tiefe *1,80 m* & Dach 15 °.\n![Bild](attnew:0)');
  const n2 = await NSX.note(arc, 'N2note2');
  assert.equal(NSX.toMarkdown(n2.html), '- [x] Zahnbürste\n- [ ] Wanderschuhe\n\n| Tag | Ziel |\n| --- | --- |\n| Sa | Brocken |\n\nLink: [Wetter](https://example.com/harz)');
  const n3 = await NSX.note(arc, 'N3note3');
  assert.equal(NSX.toMarkdown(n3.html), '500 g Hack\n\n1. Soße\n2. Schichten');
});

test('nsx: a protected note opens with its password only; not a zip is refused', async () => {
  const arc = await NSX.open(read, FILE.length, { inflateRaw });
  const n4 = await NSX.note(arc, 'N4note4');
  assert.equal(n4.encrypted, true);
  assert.equal(await NSX.decrypt(n4.html, 'geheim'), '<p>Police <b>4711</b></p>');
  await assert.rejects(NSX.decrypt(n4.html, 'falsch'), (e) => e.code === 'decrypt');
  await assert.rejects(NSX.decrypt('irgendwas', 'geheim'), (e) => e.code === 'decrypt');
  assert.equal(Buffer.from(NSX.md5(new TextEncoder().encode('abc'))).toString('hex'), '900150983cd24fb0d6963f7d28e17f72');
  await assert.rejects(NSX.open((a, b) => Promise.resolve(new Uint8Array(b - a)), 1000, { inflateRaw }), (e) => e.code === 'invalid');
});

test('dsnote import: notebooks once, notes with pictures and tags, searchable, only the own job', async () => {
  const h = await withHost();
  try {
    const arc = await NSX.open(read, FILE.length, { inflateRaw });
    const sum = await NSX.summary(arc);
    const job = (await h.ok(ANNA, 'POST', 'import/dsnote/start', { file: 'sample.nsx', notebooks: 2, notes: sum.notes, bytes: sum.bytes })).job;
    const nb = await h.ok(ANNA, 'POST', `import/dsnote/${job.id}/notebook`, { ref: 'NB1aaaa', name: 'Haushalt' });
    const again = await h.ok(ANNA, 'POST', `import/dsnote/${job.id}/notebook`, { ref: 'NB1aaaa', name: 'Haushalt' });
    assert.equal(again.notebookId, nb.notebookId);
    const n1 = await NSX.note(arc, 'N1note1');
    const ups = [];
    for (const [k, a] of n1.attachments.entries()) {
      const u = await h.host.upload({ ...ANNA, portal: true, loggedIn: true }, Buffer.from(await arc.bytes(a.entry)), a.mime);
      assert.equal(u.status, 200, JSON.stringify(u.body));
      ups.push({ n: k, mediaId: u.body.mediaId, name: a.name });
    }
    const body = NSX.toMarkdown(n1.html, { image: (ref) => (ref === n1.attachments[0].ref ? 'attnew:0' : null) });
    const r = await h.ok(ANNA, 'POST', `import/dsnote/${job.id}/notes`, { notebookId: nb.notebookId, notes: [{ ref: 'N1note1', title: n1.title, body, tags: n1.tags, created: n1.created, updated: n1.updated, attachments: ups }] });
    assert.deepEqual([r.imported, r.skipped], [1, 0]);
    const dup = await h.ok(ANNA, 'POST', `import/dsnote/${job.id}/notes`, { notebookId: nb.notebookId, notes: [{ ref: 'N1note1', title: 'x', body: 'x' }] });
    assert.deepEqual([dup.imported, dup.skipped], [0, 1]);
    const note = (await h.ok(ANNA, 'GET', 'notes/' + r.ids.N1note1)).note;
    assert.match(note.body, /!\[Bild\]\(att:\d+\)/);
    assert.match(note.body, /#garten #bauen$/);
    assert.equal(note.images, 1);
    assert.equal(note.files, 1);
    assert.equal(note.updatedAt, n1.updated);
    assert.deepEqual(note.tags.sort(), ['bauen', 'garten']);
    const s = await h.ok(ANNA, 'GET', 'search', null, { q: 'gartenhaus', area: 'private' });
    assert.equal(s.notes.length, 1);
    // another person cannot write into Anna's import
    const r2 = await h.call(MARC, 'POST', `import/dsnote/${job.id}/notes`, { notebookId: nb.notebookId, notes: [{ ref: 'x', title: 'x', body: '' }] });
    assert.equal(r2.status, 404);
    const fin = await h.ok(ANNA, 'POST', `import/dsnote/${job.id}/finish`, { protectedSkipped: 1 });
    assert.equal(fin.job.state, 'done');
    assert.equal(fin.job.stats.notes, 1);
    assert.equal(fin.job.stats.protectedSkipped, 1);
  } finally { await h.close(); }
});
