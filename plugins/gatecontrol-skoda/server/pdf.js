'use strict';

// A small PDF writer for tables (the logbook export) — no dependencies: the
// standard fonts Helvetica / Helvetica-Bold with WinAnsiEncoding (German
// umlauts, ß, €, quotes and dashes; anything else becomes "?"), A4 landscape
// or portrait, deflated content streams. Text widths come from Helvetica's
// metrics, so cells can be cut with "…" to fit their column.
//
//   const doc = new PdfDoc({ landscape: true, title: 'Fahrtenbuch' });
//   doc.page();                                  // a new page (the first one too)
//   doc.text(x, y, 'Hallo', { size: 9, bold: true, color: [0.4, 0.4, 0.4] });
//   doc.rect(x, y, w, h, [0.95, 0.95, 0.95]);    // filled
//   doc.line(x1, y1, x2, y2, [0.8, 0.8, 0.8]);
//   doc.width('Hallo', 9, false)                 // width in points
//   doc.fit('ein langer Text', 60, 8)            // cut with … to 60 pt
//   const buf = doc.toBuffer();
//
// Coordinates: points from the top left (converted to PDF's bottom left here).

const zlib = require('node:zlib');

// Helvetica widths (1/1000 em) for 32…126 (AFM)
const W_REG = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
// Helvetica-Bold widths for 32…126 (AFM)
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// Unicode → WinAnsi (cp1252) for 0x80…0x9F; 0xA0…0xFF are Latin-1 as is
const CP1252 = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
// widths of the special ones (regular; bold uses the same — close enough for cutting)
const W_SPECIAL = { 0x80: 556, 0x85: 1000, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x84: 333, 0x82: 222, 0x95: 350, 0x96: 556, 0x97: 1000, 0x99: 1000, 0xdf: 611, 0xb0: 400, 0xa0: 278 };

/** A string → WinAnsi codes (unknown characters → "?"). */
function encode(str) {
  const out = [];
  for (const ch of String(str == null ? '' : str)) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x20 && cp <= 0x7e) out.push(cp);
    else if (cp >= 0xa0 && cp <= 0xff) out.push(cp);
    else if (CP1252[cp]) out.push(CP1252[cp]);
    else if (cp === 0x09 || cp === 0x0a || cp === 0x0d) out.push(0x20);
    else out.push(0x3f);
  }
  return out;
}

/** Width of one WinAnsi code in 1/1000 em. */
function charWidth(code, bold) {
  const table = bold ? W_BOLD : W_REG;
  if (code >= 32 && code <= 126) return table[code - 32];
  if (W_SPECIAL[code]) return W_SPECIAL[code];
  if (code >= 0xc0) {
    // accented letters: the width of the base letter
    const base = String.fromCharCode(code).normalize('NFD').charCodeAt(0);
    if (base >= 32 && base <= 126) return table[base - 32];
  }
  return 556;
}

function escapeBytes(codes) {
  let s = '';
  for (const c of codes) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) s += '\\' + String.fromCharCode(c);
    else if (c < 0x20 || c > 0x7e) s += '\\' + c.toString(8).padStart(3, '0');
    else s += String.fromCharCode(c);
  }
  return s;
}

const num = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (c) => (Array.isArray(c) && c.length === 3 ? c.map((x) => num(Math.max(0, Math.min(1, Number(x) || 0)))).join(' ') : '0 0 0');

class PdfDoc {
  constructor({ landscape = false, title = '', author = '' } = {}) {
    this.w = landscape ? 842 : 595;
    this.h = landscape ? 595 : 842;
    this.title = title;
    this.author = author;
    this.pages = [];
    this.cur = null;
  }

  page() {
    this.cur = [];
    this.pages.push(this.cur);
    return this.pages.length;
  }

  width(str, size, bold = false) {
    let w = 0;
    for (const c of encode(str)) w += charWidth(c, bold);
    return (w * size) / 1000;
  }

  /** `str` cut (with "…") so it fits `max` points. */
  fit(str, max, size, bold = false) {
    const s = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
    if (this.width(s, size, bold) <= max) return s;
    const chars = [...s];
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.width(chars.slice(0, mid).join('').trimEnd() + '…', size, bold) <= max) lo = mid; else hi = mid - 1;
    }
    return lo ? chars.slice(0, lo).join('').trimEnd() + '…' : '';
  }

  text(x, y, str, { size = 9, bold = false, color = null, align = 'left', width = 0 } = {}) {
    const codes = encode(str);
    if (!codes.length) return;
    let tx = x;
    if (align !== 'left' && width > 0) {
      const w = this.width(str, size, bold);
      tx = align === 'right' ? x + width - w : x + (width - w) / 2;
    }
    const fill = color ? `${rgb(color)} rg ` : '0 0 0 rg ';
    this.cur.push(`BT ${fill}/${bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(tx)} ${num(this.h - y)} Td (${escapeBytes(codes)}) Tj ET`);
  }

  rect(x, y, w, h, color) {
    this.cur.push(`${rgb(color)} rg ${num(x)} ${num(this.h - y - h)} ${num(w)} ${num(h)} re f`);
  }

  line(x1, y1, x2, y2, color = [0, 0, 0], width = 0.5) {
    this.cur.push(`${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(this.h - y1)} m ${num(x2)} ${num(this.h - y2)} l S`);
  }

  toBuffer() {
    if (!this.pages.length) this.page();
    const objs = [];   // index → Buffer of the object body
    const add = (body) => { objs.push(body); return objs.length; };
    const catalog = add(null);
    const pagesObj = add(null);
    const f1 = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
    const f2 = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
    const kids = [];
    for (const ops of this.pages) {
      const data = zlib.deflateSync(Buffer.from(ops.join('\n'), 'latin1'));
      const content = add(Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`), data, Buffer.from('\nendstream')]));
      kids.push(add(Buffer.from(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${this.w} ${this.h}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`)));
    }
    objs[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
    objs[pagesObj - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
    const pdfStr = (s) => `(${escapeBytes(encode(s))})`;
    const info = add(Buffer.from(`<< /Title ${pdfStr(this.title)} /Author ${pdfStr(this.author)} /Producer (GateControl) >>`));

    const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = parts[0].length;
    const offsets = [];
    objs.forEach((body, i) => {
      offsets.push(offset);
      const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
      parts.push(chunk);
      offset += chunk.length;
    });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
    return Buffer.concat(parts);
  }
}

module.exports = { PdfDoc, encode, charWidth };
