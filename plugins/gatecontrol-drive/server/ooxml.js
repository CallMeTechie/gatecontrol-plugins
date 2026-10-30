'use strict';

// Office files and a scan PDF made by Drive itself (since 1.14.0, scans.js) — no library: a small ZIP writer (deflate
// of node:zlib, CRC-32), the parts of a Word document (DOCX) and an Excel workbook (XLSX) as WordprocessingML /
// SpreadsheetML, and a PDF of JPEG pages with the recognised text as an invisible layer.
//
//   docx({ title, blocks, table, image, imageAt, lang })   → Buffer
//     blocks: [{ type: 'heading', level: 1|2, text } | { type: 'paragraph', text } | { type: 'bullet', text } |
//              { type: 'check', text, done } | { type: 'open', text }] — a run of 'open' blocks gets the heading
//              „Offen“ / “Open” unless one is above it; table: a Word table (as in xlsx, without formulas);
//     image: { data: Buffer, mime: 'image/jpeg' | 'image/png' } — at the top (imageAt 'top', the whiteboard) or on a page
//            of its own at the end ('end', a handwritten page)
//   xlsx({ title, columns, rows, total })                  → Buffer
//     columns: [{ name, type: 'text' | 'number' | 'integer' | 'currency' | 'date', currency? }]; rows: [[string]] —
//     numbers with a "." as decimal point, dates YYYY-MM-DD (anything else stays text); total: { label, cells: [{ column,
//     op: 'sum' | 'difference' | 'average' }] } | null — a last row of formulas. The header is bold and frozen, the
//     columns as wide as their content, numbers as numbers, dates as dates (Excel's short date).
//   pdf({ title, pages: [{ data: Buffer (JPEG) }], text })  → Buffer — each picture a page (150 dpi), the text on them
//     invisible (render mode 3) and so searchable and copyable, spread over the pages line by line.
//   imageSize(buf) → { width, height, mime } | null (JPEG, PNG)
//   zip([{ name, data }]) → Buffer

const zlib = require('node:zlib');

// ─── ZIP ────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 1 January 2026 00:00 as an MS-DOS date and time: the files of a ZIP carry no real time (the same input, the same bytes)
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** Files [{ name, data (Buffer | string) }] → a ZIP (deflated, or stored when that is not smaller). */
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const crc = crc32(raw);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    locals.push(head, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(stored ? 0 : 8, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += head.length + name.length + body.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

// ─── shared ─────────────────────────────────────

/** Text for XML: escaped, without the characters XML 1.0 cannot hold. */
function x(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Width and height of a JPEG or PNG → { width, height, mime } | null. */
function imageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: 'image/png' };
  }
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    // SOF0…SOF15 except DHT (c4), JPG (c8) and DAC (cc)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), mime: 'image/jpeg', components: buf[i + 9] };
    }
    i += 2 + len;
  }
  return null;
}

const CORE = (title) => XML + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
  + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
  + `<dc:title>${x(title || '')}</dc:title><dc:creator>GateControl Drive</dc:creator></cp:coreProperties>`;

// ─── DOCX ───────────────────────────────────────

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
  + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const STYLES = XML + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/>'
  + '<w:lang w:val="de-DE"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="1F4E79"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="2E74B5"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/></w:pPr></w:style>'
  + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>'
  + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>`).join('')
  + '</w:tblBorders><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
  + '</w:styles>';

const NUMBERING = XML + '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  + '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>'
  + '<w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>'
  + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';

const run = (text, rpr = '') => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${x(text)}</w:t></w:r>`;
const para = (inner, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`;
const SYMBOL = '<w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol" w:cs="Segoe UI Symbol"/>';

// the page's text width: A4 with 2.5 cm margins ≈ 16 cm
const TEXT_WIDTH_EMU = 5760720;
const TEXT_HEIGHT_EMU = 8640000;

function drawing(img, id) {
  const size = imageSize(img.data) || { width: 1600, height: 1200 };
  let w = TEXT_WIDTH_EMU;
  let hgt = Math.round((w * size.height) / Math.max(1, size.width));
  if (hgt > TEXT_HEIGHT_EMU) { w = Math.round((w * TEXT_HEIGHT_EMU) / hgt); hgt = TEXT_HEIGHT_EMU; }
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${w}" cy="${hgt}"/><wp:docPr id="${id}" name="Scan ${id}"/>`
    + '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
    + `<pic:nvPicPr><pic:cNvPr id="${id}" name="scan${id}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="rIdImg${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w}" cy="${hgt}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
}

/** A Word table of a table's columns and rows (strings), the header row bold and repeated on every page. */
function wordTable(t) {
  const cols = t.columns || [];
  const n = Math.max(1, cols.length);
  const cw = Math.floor(9070 / n);
  const cell = (text, bold, right) => `<w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/></w:tcPr>${para(run(text, bold ? '<w:b/>' : ''), `<w:spacing w:after="0"/>${right ? '<w:jc w:val="right"/>' : ''}`)}</w:tc>`;
  const numeric = cols.map((c) => ['number', 'integer', 'currency'].includes(c && c.type));
  let out = `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1"/></w:tblPr><w:tblGrid>${cols.map(() => `<w:gridCol w:w="${cw}"/>`).join('')}</w:tblGrid>`;
  out += `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cols.map((c) => cell(c && c.name, true, false)).join('')}</w:tr>`;
  for (const r of t.rows || []) out += `<w:tr>${cols.map((c, i) => cell(r[i] == null ? '' : r[i], false, numeric[i])).join('')}</w:tr>`;
  return out + '</w:tbl>' + para('');
}

const OPEN_HEAD = { de: 'Offen', en: 'Open' };

function docx(o) {
  const lang = o.lang === 'en' ? 'en' : 'de';
  const img = o.image && Buffer.isBuffer(o.image.data) ? o.image : null;
  const body = [];
  if (o.title) body.push(para(run(o.title), '<w:pStyle w:val="Title"/>'));
  if (img && o.imageAt !== 'end') body.push(para(drawing(img, 1), '<w:jc w:val="center"/>'));
  const blocks = Array.isArray(o.blocks) ? o.blocks : [];
  let lastHeading = '';
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] || {};
    const text = typeof b.text === 'string' ? b.text : '';
    if (b.type === 'heading') {
      lastHeading = text.trim().toLowerCase();
      body.push(para(run(text), `<w:pStyle w:val="${b.level === 2 ? 'Heading2' : 'Heading1'}"/>`));
    } else if (b.type === 'bullet') {
      body.push(para(run(text), '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'));
    } else if (b.type === 'check') {
      body.push(para(run(b.done ? '☑ ' : '☐ ', SYMBOL) + run(text, b.done ? '<w:strike/>' : ''), '<w:pStyle w:val="ListParagraph"/><w:ind w:left="720" w:hanging="360"/>'));
    } else if (b.type === 'open') {
      const prev = blocks[i - 1];
      // the first of a run of open points: „Offen“ above it, unless the heading above says so already
      if (!(prev && prev.type === 'open') && lastHeading !== OPEN_HEAD[lang].toLowerCase()) {
        lastHeading = OPEN_HEAD[lang].toLowerCase();
        body.push(para(run(OPEN_HEAD[lang]), '<w:pStyle w:val="Heading1"/>'));
      }
      body.push(para(run(text, '<w:highlight w:val="yellow"/>'), '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'));
    } else if (text) {
      body.push(para(run(text)));
    }
  }
  if (o.table && Array.isArray(o.table.columns) && o.table.columns.length) body.push(wordTable(o.table));
  if (img && o.imageAt === 'end') body.push(para('<w:r><w:br w:type="page"/></w:r>') + para(drawing(img, 1), '<w:jc w:val="center"/>'));
  if (!body.length) body.push(para(''));
  const doc = XML + `<w:document ${W_NS}><w:body>${body.join('')}`
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1134" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
    + '</w:body></w:document>';
  const ext = img && img.mime === 'image/png' ? 'png' : 'jpeg';
  const files = [
    { name: '[Content_Types].xml', data: XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
      + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>' },
    { name: '_rels/.rels', data: XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>' },
    { name: 'docProps/core.xml', data: CORE(o.title) },
    { name: 'word/_rels/document.xml.rels', data: XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
      + (img ? `<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.${ext}"/>` : '')
      + '</Relationships>' },
    { name: 'word/document.xml', data: doc },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/numbering.xml', data: NUMBERING },
  ];
  if (img) files.push({ name: `word/media/image1.${ext}`, data: img.data });
  return zip(files);
}

// ─── XLSX ───────────────────────────────────────

/** Column index (0…) → letters (A, B, … Z, AA …). */
function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const EPOCH_1900 = Date.UTC(1899, 11, 30);

/** "2026-03-01" → Excel's day number (1900 system), else null. */
function serial(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== m[0]) return null;
  return Math.round((t - EPOCH_1900) / 86400000);
}

/** "41208", "84.20", "-3", "1e3" → a number, else null (the AI writes numbers with a "." as decimal point). */
function num(v) {
  const s = String(v).trim().replace(/\s/g, '');
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const SYMBOLS = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF' };

// cellXfs: 0 text · 1 header · 2 date · 3 integer · 4 decimal · 5 currency · 6 bold text · 7 bold integer · 8 bold
// decimal · 9 bold currency · 10 bold date
const XF = { text: 0, header: 1, date: 2, integer: 3, number: 4, currency: 5 };
const BOLD = { text: 6, integer: 7, number: 8, currency: 9, date: 10 };

function xlsxStyles(cur) {
  const sym = SYMBOLS[cur] || cur || '';
  const fmt = sym ? `#,##0.00\\ "${sym.replace(/"/g, '')}"` : '#,##0.00';
  const xf = (numFmt, font, fill) => `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="0" xfId="0"${numFmt ? ' applyNumberFormat="1"' : ''}${font ? ' applyFont="1"' : ''}${fill ? ' applyFill="1"' : ''}/>`;
  return XML + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<numFmts count="1"><numFmt numFmtId="164" formatCode="${x(fmt)}"/></numFmts>`
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFE7EEF7"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="11">' + [xf(0, 0, 0), xf(0, 1, 2), xf(14, 0, 0), xf(3, 0, 0), xf(4, 0, 0), xf(164, 0, 0),
      xf(0, 1, 0), xf(3, 1, 0), xf(4, 1, 0), xf(164, 1, 0), xf(14, 1, 0)].join('') + '</cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
}

const SHEET_NAME_RE = /[\\/?*[\]:]/g;

function xlsx(o) {
  const columns = (Array.isArray(o.columns) ? o.columns : []).map((c) => ({ name: String((c && c.name) || ''), type: c && XF[c.type] != null && c.type !== 'header' ? c.type : 'text', currency: c && c.currency }));
  if (!columns.length) columns.push({ name: '', type: 'text' });
  const rows = (Array.isArray(o.rows) ? o.rows : []).map((r) => (Array.isArray(r) ? r : []));
  const width = columns.map((c) => Math.max(4, c.name.length));
  const cellXml = (ref, v, type, bold) => {
    if (v == null || String(v).trim() === '') return '';
    if (type === 'date') {
      const d = serial(v);
      if (d != null) { width[ref.col] = Math.max(width[ref.col], 10); return `<c r="${ref.a}" s="${bold ? BOLD.date : XF.date}"><v>${d}</v></c>`; }
    } else if (type !== 'text') {
      const n = num(v);
      if (n != null) {
        const t = type === 'number' && Number.isInteger(n) && !String(v).includes('.') ? 'integer' : type;
        width[ref.col] = Math.max(width[ref.col], String(Math.round(Math.abs(n))).length + (t === 'integer' ? 2 : 5));
        return `<c r="${ref.a}" s="${bold ? BOLD[t] : XF[t]}"><v>${n}</v></c>`;
      }
    }
    const s = String(v);
    width[ref.col] = Math.max(width[ref.col], Math.min(60, s.length));
    return `<c r="${ref.a}" t="inlineStr"${bold ? ` s="${BOLD.text}"` : ''}><is><t xml:space="preserve">${x(s)}</t></is></c>`;
  };
  const out = [];
  out.push(`<row r="1">${columns.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="${XF.header}"><is><t xml:space="preserve">${x(c.name)}</t></is></c>`).join('')}</row>`);
  rows.forEach((r, ri) => {
    const rn = ri + 2;
    out.push(`<row r="${rn}">${columns.map((c, i) => cellXml({ a: `${colName(i)}${rn}`, col: i }, r[i], c.type, false)).join('')}</row>`);
  });
  const last = rows.length + 1;
  const total = o.total && Array.isArray(o.total.cells) && rows.length ? o.total : null;
  if (total) {
    const rn = last + 1;
    const cells = new Map();
    for (const t of total.cells) {
      const i = Number(t && t.column);
      if (!Number.isInteger(i) || i < 0 || i >= columns.length || cells.has(i)) continue;
      const c = colName(i);
      const f = t.op === 'difference' ? `${c}${last}-${c}2` : t.op === 'average' ? `AVERAGE(${c}2:${c}${last})` : `SUM(${c}2:${c}${last})`;
      const type = columns[i].type === 'text' || columns[i].type === 'date' ? 'number' : columns[i].type;
      cells.set(i, `<c r="${c}${rn}" s="${BOLD[type]}"><f>${x(f)}</f></c>`);
    }
    // the label in the first column without a formula
    let labelAt = 0;
    while (cells.has(labelAt)) labelAt++;
    const label = String(total.label || '').trim();
    const parts = [];
    for (let i = 0; i < columns.length; i++) {
      if (cells.has(i)) parts.push(cells.get(i));
      else if (i === labelAt && label) parts.push(cellXml({ a: `${colName(i)}${rn}`, col: i }, label, 'text', true));
    }
    out.push(`<row r="${rn}">${parts.join('')}</row>`);
  }
  const cols = width.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(62, Math.max(8, Math.round(w * 1.15 + 2)))}" customWidth="1"/>`).join('');
  const lastRef = `${colName(columns.length - 1)}${last}`;
  const sheet = XML + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    + '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
    + `<sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${out.join('')}</sheetData>`
    + (rows.length ? `<autoFilter ref="A1:${lastRef}"/>` : '')
    + '</worksheet>';
  const sheetName = (String(o.title || 'Tabelle').replace(SHEET_NAME_RE, ' ').trim() || 'Tabelle').slice(0, 31);
  const cur = (columns.find((c) => c.type === 'currency' && c.currency) || {}).currency || 'EUR';
  const files = [
    { name: '[Content_Types].xml', data: XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>' },
    { name: '_rels/.rels', data: XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>' },
    { name: 'docProps/core.xml', data: CORE(o.title) },
    { name: 'xl/workbook.xml', data: XML + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<sheets><sheet name="${x(sheetName)}" sheetId="1" r:id="rId1"/></sheets>`
      + (rows.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${x(sheetName.replace(/'/g, "''"))}'!$A$1:$${colName(columns.length - 1)}$${last}</definedName></definedNames>` : '')
      + '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
    { name: 'xl/styles.xml', data: xlsxStyles(cur) },
  ];
  return zip(files);
}

// ─── PDF (a scan with an invisible text layer) ──

// Unicode → WinAnsi (cp1252) for 0x80…0x9F; 0xA0…0xFF are Latin-1 as is (as gatecontrol-skoda's pdf.js)
const CP1252 = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89,
  0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** A line of text as a PDF string literal in WinAnsi (unknown characters → "?"). */
function pdfString(s) {
  let out = '(';
  for (const ch of String(s)) {
    let cp = ch.codePointAt(0);
    if (!((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff))) cp = CP1252[cp] || 0x3f;
    if (cp === 0x28 || cp === 0x29 || cp === 0x5c) out += '\\' + String.fromCharCode(cp);
    else if (cp < 0x20 || cp > 0x7e) out += '\\' + cp.toString(8).padStart(3, '0');
    else out += String.fromCharCode(cp);
  }
  return out + ')';
}

const DPI = 150;

function pdf(o) {
  const pages = (o.pages || []).map((p) => ({ data: p.data, size: imageSize(p.data) })).filter((p) => p.size && p.size.mime === 'image/jpeg');
  if (!pages.length) throw new Error('no JPEG page');
  const lines = String(o.text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const per = Math.ceil(lines.length / pages.length);
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  // 1 catalog, 2 pages, 3 font, 4 info — filled in below; then per page: image, content, page
  add(null); add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const info = add(`<< /Title ${pdfString(o.title || '')} /Producer (GateControl Drive) >>`);
  const kids = [];
  pages.forEach((p, i) => {
    const w = Math.round((p.size.width * 72) / DPI * 100) / 100;
    const hgt = Math.round((p.size.height * 72) / DPI * 100) / 100;
    const cs = p.size.components === 1 ? '/DeviceGray' : p.size.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    const img = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${p.size.width} /Height ${p.size.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode`, data: p.data });
    const mine = lines.slice(i * per, (i + 1) * per);
    let content = `q ${w} 0 0 ${hgt} 0 0 cm /Im0 Do Q\n`;
    if (mine.length) {
      const lead = Math.min(14, (hgt - 40) / mine.length);
      const size = Math.max(2, Math.min(10, lead * 0.8));
      content += `BT 3 Tr /F1 ${size.toFixed(2)} Tf ${lead.toFixed(2)} TL 20 ${(hgt - 20 - size).toFixed(2)} Td\n`;
      content += mine.map((l) => `${pdfString(l)} Tj T*`).join('\n') + '\nET\n';
    }
    const stream = zlib.deflateSync(Buffer.from(content, 'latin1'));
    const c = add({ dict: '<< /Filter /FlateDecode', data: stream });
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${hgt}] /Resources << /XObject << /Im0 ${img} 0 R >> /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`));
  });
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = parts[0].length;
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pos);
    let b;
    if (typeof body === 'string') b = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    else b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${body.dict} /Length ${body.data.length} >>\nstream\n`, 'latin1'), body.data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    parts.push(b);
    pos += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o2) => `${String(o2).padStart(10, '0')} 00000 n \n`).join('')}`
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

module.exports = { zip, crc32, docx, xlsx, pdf, imageSize, colName, serial, num };
