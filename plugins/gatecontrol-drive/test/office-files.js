'use strict';

// Office files made for the tests of the vault's office view (ui/vaultoffice.js, 1.29.0): a small ZIP writer and the
// packages around a body — Word (docx), Excel (xlsx), PowerPoint (pptx), OpenDocument — plus the ways to make a ZIP
// that lies (sizes, flags, methods). Nothing here is used by the plugin itself.

const zlib = require('node:zlib');

/**
 * A ZIP of `entries` ({ <name>: string | Buffer | { data, store, flags, method, usize, raw } }).
 *   store: no compression · flags: general purpose flags · method: the method written (the data stays deflate) ·
 *   usize: the uncompressed size the headers claim · raw: bytes written as the compressed data, as they are
 */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, v] of Object.entries(entries)) {
    const o = v && typeof v === 'object' && !Buffer.isBuffer(v) ? v : { data: v };
    const data = Buffer.from(o.data || '');
    const nameBuf = Buffer.from(name);
    const body = o.raw ? Buffer.from(o.raw) : o.store ? data : zlib.deflateRawSync(data);
    const method = o.method !== undefined ? o.method : o.store ? 0 : 8;
    const usize = o.usize !== undefined ? o.usize : data.length;
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(o.flags || 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(o.flags || 0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(usize, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const relsXml = (list) => XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + list.map((r, i) => `<Relationship Id="${r.id || 'rId' + (i + 1)}" Type="${r.type}" Target="${r.target}"${r.external ? ' TargetMode="External"' : ''}/>`).join('') + '</Relationships>';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="' + REL + '" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';

/** A paragraph of Word: p('text') · p('text', { style, bold, italic, num: [numId, level] }) */
function wp(text, o = {}) {
  const ppr = (o.style ? `<w:pStyle w:val="${o.style}"/>` : '') + (o.num ? `<w:numPr><w:ilvl w:val="${o.num[1]}"/><w:numId w:val="${o.num[0]}"/></w:numPr>` : '') + (o.jc ? `<w:jc w:val="${o.jc}"/>` : '');
  const rpr = (o.bold ? '<w:b/>' : '') + (o.italic ? '<w:i/>' : '') + (o.underline ? '<w:u w:val="single"/>' : '') + (o.strike ? '<w:strike/>' : '');
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

const STYLES = XML + `<w:styles ${W}>`
  + '<w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/><w:basedOn w:val="Standard"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="berschrift2"><w:name w:val="heading 2"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Vertrag"><w:name w:val="Vertrag"/><w:basedOn w:val="berschrift2"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Titel"><w:name w:val="Title"/></w:style>'
  + '</w:styles>';
const NUMBERING = XML + `<w:numbering ${W}>`
  + '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>'
  + '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>'
  + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
  + '</w:numbering>';

/** A docx around `body` (the inside of w:body). o: { document (the whole part instead), rels, extra: more entries, styles, numbering } */
function docx(body, o = {}) {
  const document = o.document || (XML + `<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`);
  return zip({
    '[Content_Types].xml': XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    '_rels/.rels': relsXml([{ type: REL + '/officeDocument', target: 'word/document.xml' }]),
    'word/document.xml': document,
    'word/_rels/document.xml.rels': relsXml([{ type: REL + '/styles', target: 'styles.xml' }, { type: REL + '/numbering', target: 'numbering.xml' }, ...(o.rels || [])]),
    'word/styles.xml': o.styles || STYLES,
    'word/numbering.xml': o.numbering || NUMBERING,
    ...(o.extra || {}),
  });
}

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="' + REL + '"';
// cell styles 0…7: General · date (14) · percent (10) · 0.00 · #,##0.00 € · text · [h]:mm · yyyy-mm-dd hh:mm
const XLSX_STYLES = XML + `<styleSheet ${S}><numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00\\ [$€-407]"/><numFmt numFmtId="165" formatCode="[h]:mm"/><numFmt numFmtId="166" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/></numFmts>`
  + '<cellStyleXfs count="1"><xf numFmtId="9"/></cellStyleXfs>'
  + '<cellXfs count="8"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="10"/><xf numFmtId="2"/><xf numFmtId="164"/><xf numFmtId="49"/><xf numFmtId="165"/><xf numFmtId="166"/></cellXfs></styleSheet>';

/**
 * An xlsx. sheets: [{ name, data: the inside of sheetData, xml: the whole part instead }]; o: { shared: [strings],
 * sharedXml, styles, workbookPr, extra, rels: more workbook relationships }
 */
function xlsx(sheets, o = {}) {
  const shared = o.sharedXml || (XML + `<sst ${S}>${(o.shared || []).map((s) => `<si><t xml:space="preserve">${s}</t></si>`).join('')}</sst>`);
  const entries = {
    '[Content_Types].xml': XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    '_rels/.rels': relsXml([{ type: REL + '/officeDocument', target: 'xl/workbook.xml' }]),
    'xl/workbook.xml': XML + `<workbook ${S}>${o.workbookPr || ''}<sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    // on purpose: the parts are numbered against the order of the sheets
    'xl/_rels/workbook.xml.rels': relsXml([...sheets.map((s, i) => ({ id: 'rId' + (i + 1), type: REL + '/worksheet', target: `worksheets/sheet${sheets.length - i}.xml` })),
      { id: 'rIdS', type: REL + '/styles', target: 'styles.xml' }, { id: 'rIdT', type: REL + '/sharedStrings', target: 'sharedStrings.xml' }, ...(o.rels || [])]),
    'xl/styles.xml': o.styles || XLSX_STYLES,
    'xl/sharedStrings.xml': shared,
  };
  sheets.forEach((s, i) => { entries[`xl/worksheets/sheet${sheets.length - i}.xml`] = s.xml || (XML + `<worksheet ${S}><sheetData>${s.data || ''}</sheetData></worksheet>`); });
  return zip({ ...entries, ...(o.extra || {}) });
}

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="' + REL + '" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
/** A shape of a slide: sp('text' | ['line', …], { title, lvl }) */
function sp(text, o = {}) {
  const lines = Array.isArray(text) ? text : [text];
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr>${o.title ? '<p:ph type="title"/>' : o.ph ? `<p:ph type="${o.ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>`
    + lines.map((l) => `<a:p>${o.lvl ? `<a:pPr lvl="${o.lvl}"/>` : ''}<a:r><a:rPr lang="de-DE"${o.bold ? ' b="1"' : ''}/><a:t>${l}</a:t></a:r></a:p>`).join('') + '</p:txBody></p:sp>';
}
/** A pptx of `slides` (each the inside of p:spTree), shown in this order — the parts are numbered backwards. */
function pptx(slides, o = {}) {
  const n = slides.length;
  const entries = {
    '[Content_Types].xml': XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    '_rels/.rels': relsXml([{ type: REL + '/officeDocument', target: 'ppt/presentation.xml' }]),
    'ppt/presentation.xml': XML + `<p:presentation ${P}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': relsXml(slides.map((_, i) => ({ id: 'rId' + (i + 1), type: REL + '/slide', target: `slides/slide${n - i}.xml` }))),
  };
  slides.forEach((s, i) => { entries[`ppt/slides/slide${n - i}.xml`] = XML + `<p:sld ${P}><p:cSld><p:spTree>${s}</p:spTree></p:cSld></p:sld>`; });
  return zip({ ...entries, ...(o.extra || {}) });
}

const ODF = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
  + 'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"';
/** An OpenDocument file: kind 'text' | 'spreadsheet' | 'presentation', `body` the inside of office:<kind>, `styles` the inside of office:automatic-styles */
function odf(kind, body, styles = '') {
  return zip({
    mimetype: { data: 'application/vnd.oasis.opendocument.' + kind, store: true },
    'content.xml': XML + `<office:document-content ${ODF}><office:automatic-styles>${styles}</office:automatic-styles><office:body><office:${kind}>${body}</office:${kind}></office:body></office:document-content>`,
  });
}

module.exports = { zip, docx, wp, xlsx, pptx, sp, odf, relsXml, XML, REL, W, S, STYLES, NUMBERING, XLSX_STYLES };
