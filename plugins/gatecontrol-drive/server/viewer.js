'use strict';

// The vault viewer of the portal (ui/vaultview.js, since 1.22.0) is not part of the page (GateControl answers at most
// 1 MiB per page; the portal page stays well below): GET viewer/vaultview hands the frame its script, its style and its
// texts (p.vv.*, the viewer's language) when a vault file is opened for the first time; the frame runs the script as an
// inline script (its CSP allows inline scripts only). Since 1.29.0 the script starts with ui/vaultoffice.js: the reader
// of office files of a vault (docx, xlsx, pptx, odt, ods, odp) — own code, no library; it reads the decrypted bytes in
// the tab and hands the viewer a model of text and tables, never HTML.
//
// Its PDF renderer: Mozilla's pdf.js (vendor/pdfjs,
// Apache-2.0, the legacy build) — handed to the portal frame only when a vault's PDF is opened, never inlined into the
// page (GateControl answers at most 1 MiB per page or answer; pdf.js is ~1.8 MB). GET viewer/pdfjs?part=<n> answers
// one piece of the code (≤ PART_CHARS characters, well below 1 MiB as JSON): the frame joins the pieces of each file and runs them as an
// inline module script (its CSP allows inline scripts only — no URL, no CDN, no eval). The worker runs in the frame
// itself (pdf.js's "fake worker": globalThis.pdfjsWorker) — the frame may start no Worker (no blob: in its CSP).
// Nothing here sees a vault file: the PDF is decrypted and rendered in the browser.

const fs = require('node:fs');
const path = require('node:path');
const { fail } = require('./util');
const texts = require('./texts.json');

// the viewer's texts: handed over with it, not in the page's DP_CTX (server/ui.js leaves them out)
const TEXT_PREFIX = 'p.vv.';

const DIR = path.join(__dirname, '..', 'vendor', 'pdfjs');
// the order the frame runs them in: the worker first (it sets globalThis.pdfjsWorker), then the library
const FILES = [{ id: 'worker', file: 'pdf.worker.min.mjs' }, { id: 'lib', file: 'pdf.min.mjs' }];
const PART_CHARS = 600 * 1024;
const VERSION = '6.4.299';

let parts = null;

/** The pieces: [{ file: 'worker'|'lib', index, of, code }] (read once). */
function load() {
  if (parts) return parts;
  const out = [];
  for (const f of FILES) {
    const code = fs.readFileSync(path.join(DIR, f.file), 'utf8');
    const pieces = [];
    for (let a = 0; a < code.length;) {
      let b = Math.min(code.length, a + PART_CHARS);
      // never between the two halves of a surrogate pair
      if (b < code.length && /[\udc00-\udfff]/.test(code[b])) b--;
      pieces.push(code.slice(a, b));
      a = b;
    }
    if (!pieces.length) pieces.push('');
    pieces.forEach((c, i) => out.push({ file: f.id, index: i, of: pieces.length, code: c }));
  }
  parts = out;
  return parts;
}

const UI = path.join(__dirname, '..', 'ui');
let viewerFiles = null;

/** GET viewer/vaultview → { code, css, texts } */
function vaultview(lang) {
  // since 1.29.0 the reader of office files (ui/vaultoffice.js) comes with the viewer, in front of it
  if (!viewerFiles) {
    viewerFiles = {
      code: fs.readFileSync(path.join(UI, 'vaultoffice.js'), 'utf8') + '\n' + fs.readFileSync(path.join(UI, 'vaultview.js'), 'utf8'),
      css: fs.readFileSync(path.join(UI, 'vaultview.css'), 'utf8'),
    };
  }
  const all = texts[lang === 'en' ? 'en' : 'de'];
  const out = {};
  for (const [k, v] of Object.entries(all)) if (k.startsWith(TEXT_PREFIX)) out[k] = v;
  return { code: viewerFiles.code, css: viewerFiles.css, texts: out };
}

/** GET viewer/pdfjs?part=<n> → { version, part, parts, file, index, of, code } */
function pdfjsPart(q) {
  const all = load();
  const n = Number(q && q.part);
  if (!Number.isInteger(n) || n < 0 || n >= all.length) throw fail('invalid', { field: 'part' });
  const p = all[n];
  return { version: VERSION, part: n, parts: all.length, file: p.file, index: p.index, of: p.of, code: p.code };
}

module.exports = { vaultview, pdfjsPart, TEXT_PREFIX, PART_CHARS, VERSION, FILES, DIR };
