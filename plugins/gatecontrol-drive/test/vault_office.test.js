'use strict';

// The reader of office files of a vault (ui/vaultoffice.js, 1.29.0): what it makes of Word, Excel, PowerPoint and
// OpenDocument files (real ones written by LibreOffice in test/fixtures/office, and ones made here), and what it
// refuses — an office file is not trusted. The model it returns holds text, yes/no marks and counts only: every test
// of a prepared file checks that nothing else of the file (markup, an address, a formula, a macro) is in it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const VO = require('../ui/vaultoffice');
const F = require('./office-files');

const read = (buf, name, lang = 'de') => VO.read(new Uint8Array(buf), name, { lang });
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'office', name));
const textOf = (b) => (b.t === 'table' ? b.rows.map((r) => r.map((c) => c.blocks.map(textOf).join('/')).join(' | ')).join('\n') : (b.runs || []).map((r) => r.text).join(''));
const lines = (blocks) => blocks.map(textOf);
const cellsOf = (sheet) => sheet.rows.map((r) => Object.keys(r.cells).sort((a, b) => a - b).map((c) => r.cells[c].v));
const code = (c) => (e) => e && e.code === c;

/** Every key and every string of a model — a model may hold only the keys of the format described in vaultoffice.js. */
const KEYS = new Set(['kind', 'blocks', 'images', 'truncated', 'sheets', 'slides', 'name', 'rows', 'cols', 'r', 'cells', 'v', 'n', 'other', 't', 'level', 'runs', 'text', 'b', 'i', 'u', 's', 'img', 'list', 'label', 'align', 'span']);
function strings(model) {
  const out = [];
  const walk = (x, key) => {
    if (typeof x === 'string') { out.push(x); return; }
    if (Array.isArray(x)) { x.forEach((y) => walk(y, key)); return; }
    if (x && typeof x === 'object') {
      for (const [k, v] of Object.entries(x)) {
        // the cells of a row are keyed by their column number
        if (key !== 'cells') assert.ok(KEYS.has(k), 'unexpected key in the model: ' + k);
        walk(v, k);
      }
    }
  };
  walk(model);
  return out;
}

test('formats: which names are read, which only get a note', () => {
  assert.deepEqual(['a.docx', 'a.DOCM', 'a.dotx', 'a.xlsx', 'a.xlsm', 'a.pptx', 'a.ppsx', 'a.odt', 'a.ods', 'a.odp'].map(VO.formatOf), ['docx', 'docx', 'docx', 'xlsx', 'xlsx', 'pptx', 'pptx', 'odt', 'ods', 'odp']);
  assert.deepEqual(['a.doc', 'a.xls', 'a.ppt', 'a.rtf', 'a.pages', 'a.numbers', 'a.pdf', 'a', ''].map(VO.formatOf), [null, null, null, null, null, null, null, null, null]);
});

test('real files (LibreOffice): a Word document — headings, bold / italic / underlined, lists, a table, a picture as a mark', async () => {
  for (const name of ['Mietvertrag.docx', 'Mietvertrag.odt']) {
    const m = await read(fixture(name), name);
    assert.equal(m.kind, 'doc', name);
    assert.equal(m.truncated, false);
    assert.deepEqual({ t: m.blocks[0].t, level: m.blocks[0].level, text: textOf(m.blocks[0]) }, { t: 'h', level: 1, text: 'Mietvertrag Wohnung Lindenstraße 12' }, name);
    const p = m.blocks[1];
    assert.equal(textOf(p), 'Zwischen Anna Beispiel (Vermieterin) und Jonas Muster (Mieter) wird folgender Vertrag geschlossen. Preis: 20 m2 & H2O <inklusive>.');
    assert.deepEqual(p.runs.find((r) => r.text === 'Anna Beispiel'), { text: 'Anna Beispiel', b: true });
    assert.deepEqual(p.runs.find((r) => r.text === 'Jonas Muster'), { text: 'Jonas Muster', i: true });
    assert.deepEqual(p.runs.find((r) => r.text === 'Vertrag'), { text: 'Vertrag', u: true });
    assert.deepEqual(p.runs.filter((r) => r.v).map((r) => r.v), ['sup', 'sub']);
    assert.deepEqual(m.blocks.filter((b) => b.t === 'h').map((b) => [b.level, textOf(b)]), [[1, 'Mietvertrag Wohnung Lindenstraße 12'], [2, '§ 1 Mietsache'], [2, '§ 2 Miete']]);
    assert.deepEqual(m.blocks.filter((b) => b.list).map((b) => [b.list.level, b.list.label, textOf(b)]),
      [[0, '•', '3 Zimmern'], [0, '•', 'Küche und Bad'], [1, '•', 'mit Fenster'], [0, '•', 'Kellerabteil Nr. 7'], [0, '1.', 'Kaltmiete'], [0, '2.', 'Nebenkosten'], [0, '3.', 'Kaution']], name);
    const table = m.blocks.find((b) => b.t === 'table');
    assert.deepEqual(table.rows.map((r) => r.map((c) => c.blocks.map(textOf).join(''))), [['Posten', 'Betrag'], ['Kaltmiete', '950,00 €'], ['Nebenkosten', '210,00 €'], ['Summe: 1.160,00 €']], name);
    assert.equal(table.rows[3][0].span, 2);
    assert.equal(m.blocks.find((b) => textOf(b).startsWith('Berlin')).align, 'center');
    assert.equal(m.images, 1);
    assert.ok(m.blocks[m.blocks.length - 1].runs[0].img, 'the picture is a mark, not a picture');
    strings(m);
  }
});

test('real files (LibreOffice): a spreadsheet — dates, numbers, booleans, the stored value of a formula', async () => {
  const x = await read(fixture('Haushalt.xlsx'), 'Haushalt.xlsx');
  assert.equal(x.kind, 'sheets');
  assert.equal(x.sheets.length, 1);
  assert.equal(x.sheets[0].name, 'haushalt');
  assert.deepEqual(cellsOf(x.sheets[0]), [
    ['Datum', 'Posten', 'Betrag', 'Anteil', 'Bezahlt'],
    ['05.01.2026', 'Miete', '950', '0,62', 'WAHR'],
    ['07.01.2026', 'Strom', '84,5', '0,055', 'WAHR'],
    ['12.01.2026', 'Versicherung', '312,4', '0,2', 'FALSCH'],
    ['01.02.2026', 'Internet, Telefon', '39,99', '0,026', 'WAHR'],
    ['Summe', '1386,89', '0,901'],
  ]);
  assert.equal(x.sheets[0].rows[5].r, 6);
  assert.deepEqual(Object.keys(x.sheets[0].rows[5].cells), ['2', '3', '4'], 'an empty cell is no cell');
  assert.equal(x.sheets[0].rows[1].cells[3].n, true);
  assert.ok(!strings(x).some((s) => /SUM/.test(s)), 'no formula');
  const en = await read(fixture('Haushalt.xlsx'), 'Haushalt.xlsx', 'en');
  assert.deepEqual(cellsOf(en.sheets[0])[1], ['2026-01-05', 'Miete', '950', '0.62', 'TRUE']);

  const o = await read(fixture('Haushalt.ods'), 'Haushalt.ods');
  assert.equal(o.sheets[0].name, 'haushalt');
  assert.deepEqual(cellsOf(o.sheets[0])[0], ['Datum', 'Posten', 'Betrag', 'Anteil', 'Bezahlt']);
  // an ods shows what its program wrote into the cell
  assert.deepEqual(cellsOf(o.sheets[0])[5], ['Summe', '1386.89', '0.901']);
  assert.equal(o.sheets[0].rows.length, 6, 'a million empty rows after the last one are no rows');
});

test('real files (LibreOffice): a presentation — its slides in order', async () => {
  for (const name of ['Urlaub.pptx', 'Urlaub.odp']) {
    const m = await read(fixture(name), name);
    assert.equal(m.kind, 'slides', name);
    assert.deepEqual(m.slides.map((s) => lines(s.blocks)), [
      ['Familienurlaub 2027', 'Wohin? Ostsee oder Alpen', 'Wann? In den Sommerferien', 'Wer kommt mit?'],
      ['Kosten', 'Unterkunft: 1.200 €', 'Anreise: 300 €', 'Verpflegung: 450 €'],
      ['Nächste Schritte', 'Ferienwohnung buchen', 'Katzensitter fragen'],
    ], name);
    strings(m);
  }
});

test('Word: headings by style (also inherited), numbered lists that count, alignment, a page break, tabs and line breaks', async () => {
  const body = F.wp('Vertrag', { style: 'Titel' }) + F.wp('Erstens', { style: 'berschrift1' }) + F.wp('Geerbt', { style: 'Vertrag' })
    + F.wp('eins', { num: [2, 0] }) + F.wp('a', { num: [2, 1] }) + F.wp('b', { num: [2, 1] }) + F.wp('zwei', { num: [2, 0] }) + F.wp('c', { num: [2, 1] }) + F.wp('Punkt', { num: [1, 0] })
    + F.wp('rechts', { jc: 'right' })
    + '<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>'
    + '<w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:rPr><w:b w:val="0"/><w:i w:val="false"/><w:strike/><w:vertAlign w:val="superscript"/></w:rPr><w:t>Ebene</w:t></w:r></w:p>';
  const m = await read(F.docx(body), 'a.docx');
  assert.deepEqual(m.blocks.filter((b) => b.t === 'h').map((b) => [b.level, textOf(b)]), [[1, 'Vertrag'], [1, 'Erstens'], [2, 'Geerbt'], [3, 'Ebene']]);
  assert.deepEqual(m.blocks.filter((b) => b.list).map((b) => b.list.label + ' ' + textOf(b)), ['1. eins', 'a) a', 'b) b', '2. zwei', 'a) c', '• Punkt']);
  assert.equal(m.blocks.find((b) => textOf(b) === 'rechts').align, 'right');
  assert.ok(m.blocks.some((b) => b.t === 'break'));
  assert.ok(m.blocks.some((b) => textOf(b) === 'A\tB\nC'));
  assert.deepEqual(m.blocks[m.blocks.length - 1].runs, [{ text: 'Ebene', s: true, v: 'sup' }]);
});

test('Word: what a document only says about its past or says twice is left out — deleted text, field codes, the fallback of a text box', async () => {
  const body = '<w:p><w:r><w:t>bleibt </w:t></w:r><w:del><w:r><w:delText>GELÖSCHT</w:delText></w:r></w:del><w:ins><w:r><w:t>neu</w:t></w:r></w:ins></w:p>'
    + '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> INCLUDEPICTURE "http://evil.example/track.png" \\d </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Seite 3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    + '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent><w:p><w:r><w:t>Kasten</w:t></w:r></w:p></w:txbxContent></w:drawing></mc:Choice>'
    + '<mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>Kasten</w:t></w:r></w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>'
    + '<w:p><w:pPr><w:rPr><w:b/></w:rPr><w:pPrChange><w:pPr><w:pStyle w:val="berschrift1"/></w:pPr></w:pPrChange></w:pPr><w:r><w:t>kein Titel, nicht fett</w:t></w:r></w:p>';
  const m = await read(F.docx(body), 'a.docx');
  const all = strings(m).join('\n');
  assert.ok(all.includes('bleibt neu'));
  assert.ok(!all.includes('GELÖSCHT') && !all.includes('INCLUDEPICTURE') && !all.includes('evil.example'));
  assert.ok(all.includes('Seite 3'));
  assert.equal(all.split('Kasten').length - 1, 1, 'the text box once');
  assert.deepEqual(m.blocks[m.blocks.length - 1], { t: 'p', runs: [{ text: 'kein Titel, nicht fett' }] });
});

test('sanitizing: markup, scripts and addresses of a prepared Word file stay text or do not appear at all', async () => {
  const evil = '&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;';
  const body = F.wp(evil)
    + '<w:p><w:hyperlink r:id="rIdJs" w:tooltip="javascript:alert(3)"><w:r><w:t>Klick mich</w:t></w:r></w:hyperlink></w:p>'
    + '<w:p><w:r><w:t><![CDATA[<svg onload=alert(4)>]]></w:t></w:r></w:p>'
    + '<w:altChunk r:id="rIdHtml"/>'
    + '<w:p><w:r><w:object><o:OLEObject xmlns:o="urn:schemas-microsoft-com:office:office" ProgID="Package" r:id="rIdOle"/></w:object></w:r></w:p>'
    + '<w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:link="rIdImg"/></w:drawing></w:r></w:p>'
    + '<w:p onclick="alert(5)" style="background:url(http://evil.example/x)"><w:r><w:t>Absatz</w:t></w:r></w:p>'
    + '<script xmlns="http://www.w3.org/1999/xhtml">alert(6)</script>';
  const file = F.docx(body, {
    rels: [
      { id: 'rIdJs', type: F.REL + '/hyperlink', target: 'javascript:alert(3)', external: true },
      { id: 'rIdImg', type: F.REL + '/image', target: 'http://evil.example/pixel.png', external: true },
      { id: 'rIdHtml', type: F.REL + '/aFChunk', target: 'evil.html' },
      { id: 'rIdOle', type: F.REL + '/oleObject', target: 'embeddings/oleObject1.bin' },
      { id: 'rIdTpl', type: F.REL + '/attachedTemplate', target: 'file://///evil.example/share/tpl.dotm', external: true },
    ],
    extra: {
      'word/evil.html': '<html><body><script>alert(7)</script>HTML-CHUNK</body></html>',
      // never unpacked: its bytes are no deflate stream at all
      'word/vbaProject.bin': { raw: Buffer.from('MAKRO not deflate'), usize: 4096 },
      'word/embeddings/oleObject1.bin': { raw: Buffer.from('OLE not deflate'), usize: 4096 },
    },
  });
  const m = await read(file, 'Rechnung.docm');
  const all = strings(m);
  // what the file writes as text is text — in one string, to be put into a text node
  assert.equal(textOf(m.blocks[0]), '<script>alert(1)</script><img src=x onerror=alert(2)>');
  assert.ok(all.includes('<svg onload=alert(4)>'));
  assert.ok(all.includes('Klick mich') && all.includes('Absatz'));
  // nothing else: no address, no handler, no chunk of HTML, no macro, no object
  const joined = all.join('\n');
  for (const bad of ['javascript:', 'evil.example', 'http:', 'file:', 'onclick', 'background', 'HTML-CHUNK', 'alert(6)', 'alert(7)', 'MAKRO', 'OLE', 'Package']) assert.ok(!joined.includes(bad), bad);
  assert.equal(m.images, 2, 'an object and a linked picture are marks');
});

test('sanitizing: a DOCTYPE, entities of the file, an external entity and elements nested too deep end the reading', async () => {
  const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>'
    + `<w:document ${F.W}><w:body><w:p><w:r><w:t>&lol3;</w:t></w:r></w:p></w:body></w:document>`;
  await assert.rejects(read(F.docx('', { document: bomb }), 'a.docx'), code('office_unsafe'));
  const xxe = `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><w:document ${F.W}><w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body></w:document>`;
  await assert.rejects(read(F.docx('', { document: xxe }), 'a.docx'), code('office_unsafe'));
  // also in a part read on the way (styles, shared strings, relationships)
  await assert.rejects(read(F.docx(F.wp('x'), { styles: '<!DOCTYPE s SYSTEM "http://evil.example/s.dtd"><w:styles/>' }), 'a.docx'), code('office_unsafe'));
  await assert.rejects(read(F.xlsx([{ name: 'A', data: '' }], { sharedXml: '<!DOCTYPE x [<!ENTITY a "b">]><sst/>' }), 'a.xlsx'), code('office_unsafe'));
  await assert.rejects(read(F.zip({ 'content.xml': '<!DOCTYPE x [<!ENTITY a "b">]><office:document-content/>' }), 'a.odt'), code('office_unsafe'));
  // an entity nobody defined stays the text it is; the five of XML and character references are decoded
  const m = await read(F.docx(F.wp('&xxe; &amp; &lt;b&gt; &#228;&#x1F600; &#0; &#xD800; &#99999999;')), 'a.docx');
  assert.equal(textOf(m.blocks[0]), '&xxe; & <b> ä😀 � � &#99999999;');
  const deep = '<w:p>' + '<w:smartTag>'.repeat(VO.CAPS.depth + 5) + '<w:r><w:t>tief</w:t></w:r>' + '</w:smartTag>'.repeat(VO.CAPS.depth + 5) + '</w:p>';
  await assert.rejects(read(F.docx(deep), 'a.docx'), code('office_unsafe'));
  await assert.rejects(read(F.docx('', { document: '<w:document><w:body><w:p <w:r>' }), 'a.docx'), code('office_broken'));
});

test('sanitizing: the ZIP — a part that unpacks far beyond its claim, encrypted entries, old and password-protected files, broken archives', async () => {
  // 60 MB of spaces in a part that claims 100 bytes: the unpacking stops at the limit of a part
  const big = Buffer.concat([Buffer.from(`<w:document ${F.W}><w:body><w:p><w:r><w:t>`), Buffer.alloc(60 * 1024 * 1024, 0x20)]);
  const packed = zlib.deflateRawSync(big);
  assert.ok(packed.length < 200 * 1024, 'a small file');
  const started = Date.now();
  await assert.rejects(read(F.docx('', { extra: { 'word/document.xml': { raw: packed, usize: 100 } } }), 'a.docx'), code('office_too_large'));
  assert.ok(Date.now() - started < 20000);
  // a part that says itself that it is too large is not unpacked at all
  await assert.rejects(read(F.docx('', { extra: { 'word/document.xml': { data: '<x/>', usize: VO.CAPS.part + 1 } } }), 'a.docx'), code('office_too_large'));
  // the limit on everything unpacked together: many sheets of 40 MB each
  const sheet = zlib.deflateRawSync(Buffer.concat([Buffer.from(`<worksheet ${F.S}><sheetData>`), Buffer.alloc(40 * 1024 * 1024, 0x20), Buffer.from('</sheetData></worksheet>')]));
  const many = F.xlsx([1, 2, 3, 4, 5].map((n) => ({ name: 'S' + n, data: '' })), { extra: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`xl/worksheets/sheet${n}.xml`, { raw: sheet, usize: 10 }])) });
  await assert.rejects(read(many, 'a.xlsx'), code('office_too_large'));

  await assert.rejects(read(F.docx('', { extra: { 'word/document.xml': { data: '<x/>', flags: 1 } } }), 'a.docx'), code('office_password'));
  // an OLE container: Word 97–2003 under a new name, or a file with a password
  await assert.rejects(read(Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(600)]), 'a.docx'), code('office_password'));
  await assert.rejects(read(F.docx('', { extra: { 'word/document.xml': { data: '<x/>', method: 99 } } }), 'a.docx'), code('office_broken'));
  await assert.rejects(read(F.docx('', { extra: { 'word/document.xml': { raw: Buffer.from('this is no deflate stream at all'), usize: 50 } } }), 'a.docx'), code('office_broken'));
  await assert.rejects(read(Buffer.from('just a text, no archive at all, long enough to look at'), 'a.docx'), code('office_broken'));
  await assert.rejects(read(Buffer.alloc(0), 'a.xlsx'), code('office_broken'));
  const whole = F.docx(F.wp('x'));
  await assert.rejects(read(whole.subarray(0, whole.length - 40), 'a.docx'), code('office_broken'));
  // ZIP64 marks and far too many entries
  const z64 = Buffer.from(whole);
  z64.writeUInt16LE(0xffff, z64.length - 22 + 10);
  await assert.rejects(read(z64, 'a.docx'), code('office_too_large'));
  const crowd = Buffer.from(whole);
  crowd.writeUInt16LE(VO.CAPS.entries + 1, crowd.length - 22 + 10);
  await assert.rejects(read(crowd, 'a.docx'), code('office_too_large'));
  // an entry whose data would lie outside the file
  const off = Buffer.from(whole);
  off.writeUInt32LE(0x7fffffff, off.lastIndexOf('word/document.xml') - 46 + 42); // its entry in the central directory
  await assert.rejects(read(off, 'a.docx'), code('office_broken'));
  // a file without the part it must have; a name that is no office format
  await assert.rejects(read(F.zip({ 'readme.txt': 'hello' }), 'a.docx'), code('office_broken'));
  await assert.rejects(read(whole, 'a.doc'), code('office_format'));
  // two entries of one name: the first counts; a relationship that points out of the package finds nothing
  const twice = Buffer.concat([F.docx(F.wp('erste'))]);
  assert.equal(textOf((await read(twice, 'a.docx')).blocks[0]), 'erste');
  const out = F.zip({ '_rels/.rels': F.relsXml([{ type: F.REL + '/officeDocument', target: '../../../etc/passwd' }]), 'word/document.xml': F.XML + `<w:document ${F.W}><w:body>${F.wp('innen')}</w:body></w:document>` });
  assert.equal(textOf((await read(out, 'a.docx')).blocks[0]), 'innen');
});

test('Excel: strings, numbers as their format shows them, dates, booleans, errors — a formula is never read', async () => {
  const data = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>46027</v></c><c r="C1" s="2"><v>0.125</v></c><c r="D1" s="3"><v>3.14159</v></c><c r="E1" s="4"><v>1234.5</v></c><c r="F1" s="5"><v>007</v></c><c r="G1" s="6"><v>1.5</v></c><c r="H1" s="7"><v>46027.75</v></c></row>'
    + '<row r="2"><c r="A2" t="inlineStr"><is><r><t>in</t></r><r><t>line</t></r><rPh><t>PHONETIK</t></rPh></is></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="e"><v>#DIV/0!</v></c>'
    + '<c r="D2" t="str"><f>CONCAT("a","b")</f><v>ab</v></c><c r="E2"><f>cmd|\'/c calc\'!A1</f><v>42</v></c><c r="F2"><v>0.1</v></c><c r="G2"><v>1E+21</v></c><c r="H2"><v></v></c><c r="I2" t="s"><v>1</v></c></row>'
    + '<row r="9"><c r="C9" s="1"><v>1</v></c><c r="D9" s="1"><v>60</v></c><c r="E9" s="1"><v>61</v></c><c r="F9"><v>-2.50</v></c><c r="G9" t="s"><v>99</v></c></row>';
  const file = F.xlsx([{ name: 'Zahlen & mehr', data }, { name: 'Leer', data: '' }], { shared: ['Hallo &lt;b&gt;Welt&lt;/b&gt;', 'Zeile_x000D__x000A_zwei'] });
  const m = await read(file, 'a.xlsx');
  assert.deepEqual(m.sheets.map((s) => s.name), ['Zahlen & mehr', 'Leer'], 'the order of the workbook, not of the parts');
  const s = m.sheets[0];
  assert.deepEqual(cellsOf(s), [
    ['Hallo <b>Welt</b>', '05.01.2026', '12,50 %', '3,14', '1.234,50 €', '007', '36:00', '05.01.2026 18:00'],
    ['inline', 'WAHR', '#DIV/0!', 'ab', '42', '0,1', '1e+21', 'Zeile\r\nzwei'],
    // day 60 is Excel's 29 February 1900, a day that never was: shown as the day before
    ['01.01.1900', '28.02.1900', '01.03.1900', '-2,5'],
  ]);
  assert.deepEqual(s.rows.map((r) => r.r), [1, 2, 9]);
  assert.equal(s.cols, 9);
  assert.equal(s.rows[0].cells[1].n, undefined);
  assert.equal(s.rows[0].cells[5].n, true);
  const all = strings(m).join('\n');
  for (const bad of ['CONCAT', 'cmd|', 'calc', 'PHONETIK']) assert.ok(!all.includes(bad), bad);
  assert.deepEqual(m.sheets[1].rows, []);
  const en = await read(file, 'a.xlsx', 'en');
  assert.deepEqual(cellsOf(en.sheets[0])[0].slice(1, 5), ['2026-01-05', '12.50 %', '3.14', '1,234.50 €']);
  // the 1904 date system of old Mac files; elements with a prefix; a chart sheet
  const mac = await read(F.xlsx([{ name: 'M', xml: F.XML + '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" s="1"><x:v>0</x:v></x:c></x:row></x:sheetData></x:worksheet>' }], { workbookPr: '<workbookPr date1904="1"/>' }), 'a.xlsx');
  assert.deepEqual(cellsOf(mac.sheets[0]), [['01.01.1904']]);
});

test('Excel: number formats', () => {
  const k = (c) => VO.formatKind(c).type;
  assert.deepEqual(['General', '0.00', '#,##0', '0%', 'dd/mm/yyyy', 'yyyy-mm-dd hh:mm:ss', 'h:mm AM/PM', '[h]:mm:ss', 'mmm-yy', '@', '0.00E+00', '[Red]#,##0.00;[Blue]-#,##0.00', '"Stück" 0', ''].map(k),
    ['general', 'fixed', 'fixed', 'percent', 'date', 'datetime', 'time', 'time', 'date', 'text', 'general', 'fixed', 'fixed', 'general']);
  assert.equal(VO.formatNumber(1234.567, VO.formatKind('#,##0.00'), 'de'), '1.234,57');
  assert.equal(VO.formatNumber(1234.567, VO.formatKind('#,##0.00'), 'en'), '1,234.57');
  assert.equal(VO.formatNumber(-5, VO.formatKind('[$$-409]#,##0.00'), 'en'), '$ -5.00');
  assert.equal(VO.formatNumber(12, VO.formatKind('0.00" EUR"'), 'de'), '12,00 EUR');
  assert.equal(VO.formatNumber(5, VO.formatKind('[$-407]0.0'), 'de'), '5,0', 'a locale in brackets is no currency');
  assert.equal(VO.formatNumber(0.5, VO.formatKind('h:mm'), 'de'), '12:00');
  assert.equal(VO.formatNumber(0.1 + 0.2, VO.formatKind('General'), 'de'), '0,3');
  assert.equal(VO.formatNumber(-3, VO.formatKind('dd.mm.yyyy'), 'de'), '-3', 'no date before the first day');
  assert.equal(VO.colName(1) + VO.colName(26) + VO.colName(27) + VO.colName(100), 'AZAACV');
});

test('Excel: limits — rows, columns and cells beyond them are left out and the sheet says so', async () => {
  let data = '';
  for (let r = 1; r <= VO.CAPS.rows + 50; r++) data += `<row r="${r}"><c r="A${r}"><v>${r}</v></c></row>`;
  const tall = await read(F.xlsx([{ name: 'Lang', data }]), 'a.xlsx');
  assert.equal(tall.sheets[0].rows.length, VO.CAPS.rows);
  assert.equal(tall.sheets[0].truncated, true);
  assert.equal(tall.truncated, true);
  let wide = '<row r="1">';
  for (let c = 1; c <= VO.CAPS.cols + 20; c++) wide += `<c r="${VO.colName(c)}1"><v>${c}</v></c>`;
  const w = await read(F.xlsx([{ name: 'Breit', data: wide + '</row>' }]), 'a.xlsx');
  assert.equal(w.sheets[0].cols, VO.CAPS.cols);
  assert.equal(Object.keys(w.sheets[0].rows[0].cells).length, VO.CAPS.cols);
  assert.equal(w.truncated, true);
  // a row number far away is just a row number
  const far = await read(F.xlsx([{ name: 'F', data: '<row r="1048576"><c r="XFD1048576"><v>1</v></c></row>' }]), 'a.xlsx');
  assert.equal(far.sheets[0].rows.length, 0);
  assert.equal(far.truncated, true);
  // more sheets than are shown
  const lots = await read(F.xlsx(Array.from({ length: VO.CAPS.sheets + 3 }, (_, i) => ({ name: 'S' + i, data: '' }))), 'a.xlsx');
  assert.equal(lots.sheets.length, VO.CAPS.sheets);
  assert.equal(lots.truncated, true);
});

test('PowerPoint: slides in the order of the presentation, the title, levels, a table, pictures as a count', async () => {
  const table = '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>A1</a:t></a:r></a:p></a:txBody></a:tc><a:tc gridSpan="2"><a:txBody><a:p><a:r><a:t>B1</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
  const m = await read(F.pptx([
    F.sp('Erste', { title: true }) + F.sp(['Punkt', 'Unterpunkt'], { lvl: 1 }) + F.sp('7', { ph: 'sldNum' }) + '<p:pic><p:blipFill><a:blip r:embed="rId9"/></p:blipFill></p:pic>',
    F.sp('Zweite &lt;b&gt;', { title: true, bold: true }) + table,
    '',
  ]), 'a.pptx');
  assert.equal(m.slides.length, 3);
  assert.deepEqual(m.slides[0].blocks.map((b) => [b.t, textOf(b), b.list ? b.list.level : null]), [['h', 'Erste', null], ['p', 'Punkt', 1], ['p', 'Unterpunkt', 1]]);
  assert.equal(m.slides[0].images, 1);
  assert.deepEqual(m.slides[1].blocks[0], { t: 'h', level: 2, runs: [{ text: 'Zweite <b>', b: true }] });
  assert.deepEqual(m.slides[1].blocks[1].rows.map((r) => r.map((c) => [c.span, c.blocks.map(textOf).join('')])), [[[1, 'A1'], [2, 'B1']]]);
  assert.deepEqual(m.slides[2].blocks, []);
  strings(m);
});

test('OpenDocument: text with styles and lists, a table; a sheet with repeated cells and rows; slides; comments and scripts left out', async () => {
  const styles = '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold" fo:font-style="italic"/></style:style>'
    + '<text:list-style style:name="L1"><text:list-level-style-number text:level="1"/><text:list-level-style-bullet text:level="2"/></text:list-style>';
  const body = '<text:h text:outline-level="2">Kapitel</text:h>'
    + '<text:p>normal <text:span text:style-name="T1">fett&#x20;kursiv</text:span><text:s text:c="3"/>Ende<text:tab/>T<text:line-break/>Z</text:p>'
    + '<text:list text:style-name="L1"><text:list-item><text:p>eins</text:p><text:list><text:list-item><text:p>innen</text:p></text:list-item></text:list></text:list-item><text:list-item><text:p>zwei</text:p></text:list-item></text:list>'
    + '<text:p>vor<office:annotation><text:p>KOMMENTAR</text:p></office:annotation>nach</text:p>'
    + '<text:p><text:a xlink:href="javascript:alert(1)">Link</text:a></text:p>'
    + '<office:scripts><office:script script:language="ooo:Basic">MAKRO</office:script></office:scripts>'
    + '<table:table><table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>breit</text:p></table:table-cell><table:covered-table-cell/></table:table-row></table:table>';
  const m = await read(F.odf('text', body, styles), 'a.odt');
  assert.deepEqual(m.blocks[0], { t: 'h', runs: [{ text: 'Kapitel' }], level: 2 });
  assert.deepEqual(m.blocks[1].runs, [{ text: 'normal ' }, { text: 'fett kursiv', b: true, i: true }, { text: '   Ende\tT\nZ' }]);
  assert.deepEqual(m.blocks.filter((b) => b.list).map((b) => [b.list.level, b.list.label, textOf(b)]), [[0, '1.', 'eins'], [1, '•', 'innen'], [0, '2.', 'zwei']]);
  const all = strings(m).join('\n');
  assert.ok(all.includes('vornach') && all.includes('Link'));
  for (const bad of ['KOMMENTAR', 'javascript:', 'MAKRO']) assert.ok(!all.includes(bad), bad);
  assert.deepEqual(m.blocks[m.blocks.length - 1].rows, [[{ blocks: [{ t: 'p', runs: [{ text: 'breit' }] }], span: 2 }]]);

  const sheet = '<table:table table:name="Blatt &lt;1&gt;">'
    + '<table:table-row><table:table-cell office:value-type="string"><text:p>A</text:p></table:table-cell><table:table-cell table:number-columns-repeated="3" office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16380"/></table:table-row>'
    + '<table:table-row table:number-rows-repeated="5"/>'
    + '<table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="2"/><table:table-cell><text:p>C</text:p><text:p>zweite Zeile</text:p></table:table-cell></table:table-row>'
    + '<table:table-row table:number-rows-repeated="1048569"><table:table-cell table:number-columns-repeated="16384"/></table:table-row></table:table>'
    + '<table:table table:name="Voll"><table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="16384"><text:p>x</text:p></table:table-cell></table:table-row>'
    + '<table:table-row><table:table-cell><text:p>NACH DER GRENZE</text:p></table:table-cell></table:table-row></table:table>';
  const started = Date.now();
  const s = await read(F.odf('spreadsheet', sheet), 'a.ods');
  assert.ok(Date.now() - started < 5000, 'repeats are counted, not copied without end');
  assert.deepEqual(s.sheets.map((x) => x.name), ['Blatt <1>', 'Voll']);
  assert.deepEqual(cellsOf(s.sheets[0]), [['A', '7', '7', '7'], ['C\nzweite Zeile'], ['C\nzweite Zeile']]);
  assert.deepEqual(s.sheets[0].rows.map((r) => r.r), [1, 7, 8]);
  assert.equal(s.sheets[0].rows[0].cells[2].n, true);
  assert.equal(s.sheets[0].truncated, false);
  assert.equal(s.sheets[1].truncated, true);
  assert.ok(s.sheets[1].rows.length <= 200 && Object.keys(s.sheets[1].rows[0].cells).length === VO.CAPS.cols);
  assert.ok(!strings(s).includes('NACH DER GRENZE'));

  const p = await read(F.odf('presentation', '<draw:page draw:name="p1"><draw:frame presentation:class="title"><draw:text-box><text:p>Titel</text:p></draw:text-box></draw:frame><draw:frame><draw:text-box><text:p>Text</text:p></draw:text-box></draw:frame><draw:frame><draw:image xlink:href="http://evil.example/p.png"/></draw:frame></draw:page><draw:page draw:name="p2"/>'), 'a.odp');
  assert.deepEqual(p.slides.map((x) => x.blocks.map((b) => [b.t, textOf(b)])), [[['h', 'Titel'], ['p', 'Text']], []]);
  assert.ok(!strings(p).join('').includes('evil'));
});

test('limits of a document: text beyond them is left out and the model says so; the XML reader', async () => {
  const long = 'x'.repeat(1000);
  let body = '';
  for (let i = 0; i < 4300; i++) body += F.wp(long);
  const m = await read(F.docx(body), 'a.docx');
  assert.equal(m.truncated, true);
  assert.ok(m.blocks.length > 4000 && m.blocks.length < 4300);
  let many = '';
  for (let i = 0; i < VO.CAPS.blocks + 100; i++) many += F.wp('z');
  const b = await read(F.docx(many), 'a.docx');
  assert.equal(b.truncated, true);
  assert.equal(b.blocks.length, VO.CAPS.blocks);

  // attributes: quotes of both kinds, '>' inside a value, a prefix beside the plain name
  const seen = [];
  VO._sax('<?xml version="1.0"?><!-- c --><a:x id="1" r:id=\'rId7\' t="a > b &amp; c"><y/>text</a:x>', { wantText: true, open: (n, a) => seen.push(['open', n, { ...VO._attrs(a) }]), close: (n) => seen.push(['close', n]), text: (t) => seen.push(['text', t]) });
  assert.deepEqual(seen, [['open', 'x', { id: '1', 'r:id': 'rId7', t: 'a > b & c' }], ['open', 'y', {}], ['close', 'y'], ['text', 'text'], ['close', 'x']]);
  assert.equal(VO._attrs(' __proto__="x" constructor="y"').toString, undefined, 'an object without a prototype');
});
