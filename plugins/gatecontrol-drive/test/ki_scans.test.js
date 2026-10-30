'use strict';

// Scans become documents (1.14.0, server/scans.js, server/ooxml.js) against the mock host's gc.ai: classify with the
// text first and the picture only when needed and allowed, convert into an Excel workbook (types, frozen header, a sum
// row as formulas), a Word file (outline, tasks, „Offen“, the picture), the text of a PDF and the PDF itself, the
// uploaded file filed with scans/save (recognised text, the original kept or into the trash), rights and refusals.

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { withHost, ANNA, MARC, LENA, BOB } = require('./helpers');

// a 16×8 JPEG
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAIABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwC8AYmv/9k=', 'base64');

/** The files of a ZIP → Map name → Buffer. */
function unzip(buf) {
  const out = new Map();
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lName = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lName + lExtra, local + 30 + lName + lExtra + size);
    out.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

const TABLE = {
  title: 'Zählerstände 2026',
  columns: [{ name: 'Datum', type: 'date', currency: null }, { name: 'Zähler', type: 'text', currency: null }, { name: 'Stand (kWh)', type: 'integer', currency: null }],
  rows: [['2026-01-01', 'Strom', '41208'], ['2026-02-01', 'Strom', '41497'], ['2026-03-01', 'Strom', '41771']],
  total: { label: 'Summe', cells: [{ column: 2, op: 'difference' }] },
};
const BOARD = {
  title: 'Sprint-Planung KW 45',
  blocks: [
    { type: 'heading', text: 'Ziele', level: 1, done: null },
    { type: 'bullet', text: 'Release 2.4 bis Freitag', level: null, done: null },
    { type: 'heading', text: 'Aufgaben', level: 1, done: null },
    { type: 'check', text: 'Testplan schreiben – Anna', level: null, done: false },
    { type: 'check', text: 'Kunden informieren – Tim', level: null, done: true },
    { type: 'open', text: 'Budget für Testgeräte?', level: null, done: null },
  ],
};

/** The AI: what a scan is (by o.kind, sure only with the picture when o.unsure), a table, blocks, the text. */
function ai(o = {}) {
  return {
    mediaAllowed: o.mediaAllowed !== false,
    // (o may change while a test runs)
    extract: async (req) => {
      const media = req.input.some((i) => i.type === 'media');
      if (req.task === 'drive_scan_kind') return { kind: o.kind || 'table', confidence: o.unsure && !media ? 0.3 : 0.9, summary: '3 Spalten, 3 Zeilen, Summenzeile', title: 'Zählerstände 2026' };
      if (req.task === 'drive_scan_table') return TABLE;
      if (req.task === 'drive_scan_document') return BOARD;
      if (req.task === 'drive_scan_text') return { text: 'Rechnung\nGesamtbetrag 84,20 EUR' };
      if (req.task === 'drive_document') return { kind: 'other', title: null, date: null, sender: null, amount: null, currency: null, folder: null, name: null, deadlines: [] };
      throw new Error('unexpected ' + req.task);
    },
  };
}

test('classify: the text first, the picture only when the text leaves it open and pictures may go', async () => {
  const o = { kind: 'printed' };
  await withHost({ ai: ai(o) }, async (host, c) => {
    const a = c.as(ANNA);
    assert.ok((await a('GET', 'me')).json.features.includes('scanDocs'));
    const media = await c.upload(ANNA, JPEG, 'image/jpeg');
    // a sure answer from the text: no picture goes
    let r = await a('POST', 'scans/classify', { mediaIds: [media], text: 'Stadtwerke Musterstadt – Rechnung Nr. 4711 vom 20.10.2026' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.kind, r.json.confidence, r.json.source, r.json.title], ['printed', 0.9, 'text', 'Zählerstände 2026']);
    assert.ok(host.aiRequests.every((q) => q.input.every((i) => i.type === 'text')));
    // unsure from the text: once more with the picture
    Object.assign(o, { kind: 'table', unsure: true });
    host.aiRequests.length = 0;
    r = await a('POST', 'scans/classify', { mediaIds: [media], text: '01.01.2026 Strom 41208 01.02.2026 Strom 41497' });
    assert.deepEqual([r.json.kind, r.json.source, r.json.summary], ['table', 'media', '3 Spalten, 3 Zeilen, Summenzeile']);
    assert.equal(host.aiRequests.length, 2);
    assert.deepEqual(host.aiRequests[1].input.filter((i) => i.type === 'media').map((i) => i.mediaId), [media]);
    // only the picture
    r = await a('POST', 'scans/classify', { mediaIds: [media] });
    assert.equal(r.json.source, 'media');
    // pictures may not go: the text's answer, or 422 without text
    host.ai.mediaAllowed = false;
    r = await a('POST', 'scans/classify', { mediaIds: [media], text: '01.01.2026 Strom 41208 01.02.2026 Strom 41497' });
    assert.deepEqual([r.json.kind, r.json.source], ['table', 'text']);
    r = await a('POST', 'scans/classify', { mediaIds: [media] });
    assert.deepEqual([r.status, r.json.code, r.json.reason], [422, 'unsupported', 'media_disabled']);
    // another person's upload, a file one cannot read, nothing at all
    const bobs = await c.upload(BOB, JPEG, 'image/jpeg');
    assert.equal((await a('POST', 'scans/classify', { mediaIds: [bobs] })).status, 400);
    assert.equal((await a('POST', 'scans/classify', { mediaIds: ['x'] })).status, 400);
    assert.equal((await a('POST', 'scans/classify', {})).status, 400);
    const mine = await c.area(ANNA, 'mine');
    const pic = (await c.put(ANNA, mine.rootId, 'Zähler.jpg', JPEG, { mime: 'image/jpeg' })).json.node;
    assert.equal((await c.as(BOB)('POST', 'scans/classify', { nodeId: pic.id })).status, 404);
    // a file one reads: its picture (Anna's own)
    host.ai.mediaAllowed = true;
    assert.equal((await a('POST', 'scans/classify', { nodeId: pic.id })).json.kind, 'table');
  });
  await withHost({}, async (host, c) => {
    assert.equal((await c.as(ANNA)('POST', 'scans/classify', { text: 'x'.repeat(40) })).json.code, 'feature_off');
  });
});

test('convert a table into an Excel workbook, save it, the original into the trash', async () => {
  await withHost({ ai: ai() }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const house = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Haus' })).json.node;
    const pic = (await c.put(ANNA, house.id, 'Scan 2026-10-26.jpg', JPEG, { mime: 'image/jpeg' })).json.node;
    host.aiRequests.length = 0;
    assert.equal((await a('POST', 'scans/convert', { nodeId: pic.id, kind: 'printed', target: 'xlsx' })).status, 400, 'Excel only for a table');
    assert.equal((await a('POST', 'scans/convert', { nodeId: pic.id, kind: 'tabelle', target: 'xlsx' })).status, 400);
    const r = await a('POST', 'scans/convert', { nodeId: pic.id, kind: 'table', target: 'xlsx' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const x = r.json;
    assert.deepEqual([x.kind, x.target, x.title, x.name, x.folderId, x.folderPath, x.source], ['table', 'xlsx', 'Zählerstände 2026', '2026-10-26 Zählerstände 2026.xlsx', house.id, 'Haus', 'media']);
    assert.deepEqual(x.content.table.rows[0], ['2026-01-01', 'Strom', '41208']);
    assert.equal(x.text, 'Zählerstände 2026\nDatum Zähler Stand (kWh)\n2026-01-01 Strom 41208\n2026-02-01 Strom 41497\n2026-03-01 Strom 41771');
    assert.equal(x.file.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const bytes = Buffer.from(x.file.data, 'base64');
    assert.equal(bytes.length, x.file.size);
    assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'), x.file.sha256);
    const parts = unzip(bytes);
    const sheet = parts.get('xl/worksheets/sheet1.xml').toString();
    assert.match(sheet, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
    assert.match(sheet, /<c r="A2" s="2"><v>46023<\/v><\/c>/, 'a date as a date');
    assert.match(sheet, /<c r="C2" s="3"><v>41208<\/v><\/c>/, 'a number as a number');
    assert.match(sheet, /<c r="C5" s="7"><f>C4-C2<\/f><\/c>/, 'the sum row as a formula');
    assert.match(sheet, /Summe/);
    assert.match(parts.get('xl/workbook.xml').toString(), /sheet name="Zählerstände 2026"/);
    assert.equal(host.aiRequests[0].task, 'drive_scan_table');

    // the portal uploads the bytes, then files them; the scan goes into the trash
    const media = await c.upload(ANNA, bytes, x.file.mime);
    const s = await a('POST', 'scans/save', { mediaId: media, folderId: x.folderId, name: x.name, text: x.text, sourceId: pic.id, keepOriginal: false });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    assert.deepEqual([s.json.node.name, s.json.node.parentId, s.json.original], ['2026-10-26 Zählerstände 2026.xlsx', house.id, null]);
    assert.equal((await a('GET', `nodes/${pic.id}`)).status, 404, 'in the trash');
    // its text is searchable
    const found = (await a('GET', 'search', null, { q: '41497' })).json.items;
    assert.deepEqual(found.map((n) => [n.id, n.match]), [[s.json.node.id, 'text']]);
    // a second one of the same name: a free name; the original kept
    const pic2 = (await c.put(ANNA, house.id, 'Scan 2.jpg', JPEG, { mime: 'image/jpeg' })).json.node;
    const y = (await a('POST', 'scans/convert', { nodeId: pic2.id, kind: 'table', target: 'xlsx' })).json;
    assert.equal(y.name, '2026-10-26 Zählerstände 2026 (2).xlsx');
    const m2 = await c.upload(ANNA, Buffer.from(y.file.data, 'base64'), y.file.mime);
    const s2 = await a('POST', 'scans/save', { mediaId: m2, folderId: house.id, name: '2026-10-26 Zählerstände 2026.xlsx', text: y.text, sourceId: pic2.id });
    assert.equal(s2.json.node.name, '2026-10-26 Zählerstände 2026 (2).xlsx');
    assert.equal(s2.json.original.id, pic2.id);
    assert.equal((await a('POST', 'scans/save', { mediaId: m2, name: 'x.xlsx' })).status, 400);
  });
});

test('convert a whiteboard into a Word file with the picture on top; a handwritten page at the end; a table as a Word table', async () => {
  await withHost({ ai: ai() }, async (host, c) => {
    const a = c.as(ANNA);
    const fam = await c.area(ANNA, 'family');
    const media = await c.upload(ANNA, JPEG, 'image/jpeg');
    const r = await a('POST', 'scans/convert', { mediaIds: [media], text: 'Sprint-Planung KW 45 Ziele Release', kind: 'whiteboard', target: 'docx', folderId: fam.rootId, name: 'Besprechung.jpg', images: [JPEG.toString('base64')] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.name, r.json.folderId, r.json.source], ['Besprechung.docx', fam.rootId, 'media']);
    assert.equal(r.json.content.blocks.length, 6);
    assert.deepEqual(r.json.content.blocks[3], { type: 'check', text: 'Testplan schreiben – Anna', done: false });
    assert.match(r.json.text, /☐ Testplan schreiben – Anna\n☑ Kunden informieren – Tim\n• Budget für Testgeräte\?/);
    const parts = unzip(Buffer.from(r.json.file.data, 'base64'));
    const doc = parts.get('word/document.xml').toString();
    assert.ok(parts.has('word/media/image1.jpeg'));
    assert.ok(doc.indexOf('<w:drawing>') < doc.indexOf('Ziele'), 'the picture on top');
    assert.match(doc, /Heading1"\/><\/w:pPr><w:r><w:t xml:space="preserve">Offen</);
    assert.match(doc, /☐ /);
    // the text and the picture went: the whiteboard needs the picture
    const req = host.aiRequests.find((q) => q.task === 'drive_scan_document');
    assert.deepEqual(req.input.map((i) => i.type), ['text', 'media']);
    assert.match(req.instructions, /whiteboard/);

    // handwriting: the picture as the last page
    const h = (await a('POST', 'scans/convert', { mediaIds: [media], kind: 'handwriting', target: 'docx', images: [JPEG.toString('base64')] })).json;
    const hdoc = unzip(Buffer.from(h.file.data, 'base64')).get('word/document.xml').toString();
    assert.ok(hdoc.indexOf('<w:br w:type="page"/>') < hdoc.indexOf('<w:drawing>'));
    assert.equal(h.folderId, null, 'no folder: the device chooses');
    // a table as a Word table
    const t = (await a('POST', 'scans/convert', { mediaIds: [media], kind: 'table', target: 'docx' })).json;
    assert.match(unzip(Buffer.from(t.file.data, 'base64')).get('word/document.xml').toString(), /<w:tbl>.*41771/);
    // pictures too large or not a picture
    assert.equal((await a('POST', 'scans/convert', { mediaIds: [media], kind: 'whiteboard', target: 'docx', images: ['bm9wZQ=='] })).status, 400);
    assert.equal((await a('POST', 'scans/convert', { mediaIds: [media], kind: 'whiteboard', target: 'docx', images: [Buffer.alloc(700 * 1024).toString('base64')] })).status, 413);
    // a folder one cannot write: Lena's for Marc is read only
    const child = await c.area(LENA, 'child');
    assert.equal((await c.as(MARC)('POST', 'scans/convert', { text: 'x'.repeat(40), kind: 'printed', target: 'docx', folderId: child.rootId })).status, 403);
  });
});

test('printed text: the device\'s text for a PDF without AI, the PDF itself with the pictures; text before pictures', async () => {
  await withHost({ ai: ai({ mediaAllowed: false }) }, async (host, c) => {
    const a = c.as(ANNA);
    const media = await c.upload(ANNA, JPEG, 'image/jpeg');
    host.aiRequests.length = 0;
    const r = await a('POST', 'scans/convert', { mediaIds: [media], text: 'Rechnung Nr. 4711\nGesamtbetrag 84,20 €', kind: 'printed', target: 'pdf', images: [JPEG.toString('base64'), JPEG.toString('base64')] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.source, r.json.name, r.json.file.mime], ['device', '2026-10-26 Scan.pdf', 'application/pdf']);
    assert.equal(host.aiRequests.length, 0, 'no AI for the device\'s text');
    const pdf = Buffer.from(r.json.file.data, 'base64').toString('latin1');
    assert.match(pdf, /^%PDF-1\.4/);
    assert.equal((pdf.match(/\/Type \/Page /g) || []).length, 2);
    assert.match(pdf, /\/Filter \/DCTDecode/);
    // without pictures: only the text (the device makes the PDF)
    const t = (await a('POST', 'scans/convert', { mediaIds: [media], text: 'Rechnung Nr. 4711 Gesamtbetrag', kind: 'printed', target: 'pdf' })).json;
    assert.deepEqual([t.file, t.text], [null, 'Rechnung Nr. 4711 Gesamtbetrag']);
    // printed into Word: the text alone goes
    const w = (await a('POST', 'scans/convert', { mediaIds: [media], text: 'Rechnung Nr. 4711 Gesamtbetrag 84,20 EUR', kind: 'printed', target: 'docx' })).json;
    assert.equal(w.source, 'text');
    assert.ok(host.aiRequests.every((q) => q.input.every((i) => i.type === 'text')));
    // a whiteboard without text while pictures may not go: 422
    const b = await a('POST', 'scans/convert', { mediaIds: [media], kind: 'whiteboard', target: 'docx' });
    assert.deepEqual([b.status, b.json.reason], [422, 'media_disabled']);
    // PNG pages cannot become PDF pages here
    assert.equal((await a('POST', 'scans/convert', { mediaIds: [media], text: 'x'.repeat(30), kind: 'printed', target: 'pdf', images: [Buffer.from('89504e470d0a1a0a0000000d4948445200000010000000080806000000', 'hex').toString('base64')] })).status, 400);
  });
});
