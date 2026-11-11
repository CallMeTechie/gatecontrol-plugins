/* Drive (gatecontrol-drive) — office files of a vault read in the portal tab (since 1.29.0): window.DriveVaultOffice.
 *
 * The server can show no office file of a vault (its Collabora / OnlyOffice and its PDF conversion would need the
 * plaintext). So the tab reads the decrypted bytes itself, in memory, and hands the viewer (ui/vaultview.js) a plain
 * model of what the file says — never HTML:
 *
 *   read(bytes, name, { lang }) → Promise of
 *     { kind: 'doc',    blocks, images, truncated }                      docx · docm · dotx · odt
 *     { kind: 'sheets', sheets: [{ name, rows: [{ r, cells: { <col>: { v, n } } }], cols, truncated }], truncated }
 *                                                                        xlsx · xlsm · xltx · ods
 *     { kind: 'slides', slides: [{ blocks, images }], truncated }        pptx · ppsx · pptm · odp
 *   block: { t: 'p' | 'h' | 'table' | 'break', level, runs: [{ text, b, i, u, s, v: 'sup' | 'sub', img }],
 *            list: { level, label }, align, rows: [[{ blocks, span }]] }
 *
 * The model holds text, a few yes/no marks (bold, italic …) and numbers of this file's own counting — no markup, no
 * address, no colour, no style text of the file. The viewer builds elements and text nodes from it; nothing of the
 * file can become a script, a handler or a request (the frame's CSP allows inline scripts — HTML of a file must never
 * reach it).
 *
 * An office file is not trusted:
 *   * the ZIP is read here (central directory, stored and deflate entries; inflate through the browser's
 *     DecompressionStream) with limits on entries, on every part and on everything unpacked together (a small file
 *     that unpacks to gigabytes stops at the limit); ZIP64, encrypted entries and other methods are refused;
 *   * only the XML parts with the text are read — never vbaProject.bin (macros), embedded objects, external links,
 *     pictures; a relationship marked External is never followed (there is no network in the frame anyway);
 *   * the XML reader knows elements, attributes, text, CDATA, comments and the five predefined entities. A DOCTYPE or
 *     any other <! declaration ends the reading ('office_unsafe'): no entity of the file is ever defined or expanded
 *     (no "billion laughs", no external entity);
 *   * formulas are never calculated: a cell shows the value the file stored last; fields show their stored result;
 *   * limits on paragraphs, text, rows, columns, cells, sheets and slides — beyond them the model says `truncated`.
 *
 * Errors carry `code`: office_format (not a format read here) · office_password (an encrypted or old binary file) ·
 * office_unsafe · office_broken · office_too_large · office_browser (no DecompressionStream).
 */
(function () {
  'use strict';

  var MB = 1048576;
  var CAPS = {
    entries: 5000,        // files in the ZIP
    part: 48 * MB,        // one unpacked XML part
    total: 128 * MB,      // everything unpacked for one file
    depth: 256,           // nested elements
    blocks: 20000,        // paragraphs and tables of a document
    chars: 4 * MB,        // characters of text taken from a document / presentation
    rows: 2000,           // rows of a sheet
    cols: 100,            // columns of a sheet
    cells: 60000,         // filled cells of a sheet
    sheets: 40,
    slides: 400,
    strings: 400000,      // shared strings of a workbook
    cellChars: 8000,      // characters of one cell
  };

  var FORMATS = {
    docx: 'docx', docm: 'docx', dotx: 'docx', dotm: 'docx',
    xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx', xltm: 'xlsx',
    pptx: 'pptx', pptm: 'pptx', ppsx: 'pptx', ppsm: 'pptx', potx: 'pptx',
    odt: 'odt', ott: 'odt', ods: 'ods', ots: 'ods', odp: 'odp', otp: 'odp',
  };

  function fail(code) { return Object.assign(new Error(code), { code: code }); }
  /** An error of this reader as it is; anything else (the browser's inflate, a bug) is a broken file. */
  function own(e) { return e && typeof e.code === 'string' && e.code.indexOf('office_') === 0 ? e : fail('office_broken'); }
  var STOP = { stop: true }; // thrown by a handler that has enough (a limit reached)

  function extOf(name) { var m = /\.([a-z0-9]{1,8})$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
  /** 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp' for a name read here, else null */
  function formatOf(name) { return FORMATS[extOf(name)] || null; }

  // ── ZIP ──────────────────────────────────────────────────

  /** The central directory → { bytes, entries: { <name>: { flags, method, csize, usize, offset } } } */
  function zipOpen(b) {
    if (!b || b.length < 22) throw fail('office_broken');
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    // an OLE container: Word / Excel / PowerPoint 97–2003, or a file with a password
    if (b.length >= 8 && dv.getUint32(0) === 0xd0cf11e0) throw fail('office_password');
    if (dv.getUint32(0, true) !== 0x04034b50) throw fail('office_broken');
    var eocd = -1;
    for (var i = b.length - 22, min = Math.max(0, b.length - 22 - 65535); i >= min; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw fail('office_broken');
    var count = dv.getUint16(eocd + 10, true);
    var size = dv.getUint32(eocd + 12, true);
    var off = dv.getUint32(eocd + 16, true);
    if (count === 0xffff || off === 0xffffffff || size === 0xffffffff) throw fail('office_too_large'); // ZIP64
    if (count > CAPS.entries) throw fail('office_too_large');
    if (off + size > eocd) throw fail('office_broken');
    var entries = Object.create(null);
    var dec = new TextDecoder('utf-8', { fatal: false });
    var p = off;
    for (var n = 0; n < count; n++) {
      if (p + 46 > eocd || dv.getUint32(p, true) !== 0x02014b50) throw fail('office_broken');
      var nl = dv.getUint16(p + 28, true);
      var el = dv.getUint16(p + 30, true);
      var cl = dv.getUint16(p + 32, true);
      if (p + 46 + nl > eocd) throw fail('office_broken');
      var name = dec.decode(b.subarray(p + 46, p + 46 + nl));
      // the first entry of a name counts (a second one of the same name is never read)
      if (!(name in entries)) {
        entries[name] = { flags: dv.getUint16(p + 8, true), method: dv.getUint16(p + 10, true), csize: dv.getUint32(p + 20, true), usize: dv.getUint32(p + 24, true), offset: dv.getUint32(p + 42, true) };
      }
      p += 46 + nl + el + cl;
    }
    return { bytes: b, entries: entries, left: CAPS.total };
  }

  function wipe(list) { list.forEach(function (c) { try { c.fill(0); } catch (e) { /* detached */ } }); }

  /** Inflate `raw` (deflate without a header) to at most `cap` bytes. */
  function inflate(raw, cap) {
    var DS = typeof DecompressionStream === 'function' ? DecompressionStream : null;
    var ds = null;
    try { ds = DS ? new DS('deflate-raw') : null; } catch (e) { ds = null; }
    if (!ds) return Promise.reject(fail('office_browser'));
    var writer = ds.writable.getWriter();
    var reader = ds.readable.getReader();
    var chunks = [];
    var n = 0;
    var quiet = function () { /* the reader reports the error */ };
    writer.write(raw).then(function () { return writer.close(); }).catch(quiet);
    var pump = function () {
      return reader.read().then(function (r) {
        if (r.done) return null;
        n += r.value.length;
        chunks.push(r.value);
        if (n > cap) throw fail('office_too_large');
        return pump();
      });
    };
    return pump().then(function () {
      var out = new Uint8Array(n);
      var o = 0;
      chunks.forEach(function (c) { out.set(c, o); o += c.length; });
      wipe(chunks);
      return out;
    }, function (e) {
      wipe(chunks);
      try { reader.cancel().catch(quiet); } catch (x) { /* closed */ }
      try { writer.abort().catch(quiet); } catch (x) { /* closed */ }
      throw own(e);
    });
  }

  /** The part `name` as text, null when the file has none. */
  function zipText(zip, name) {
    var e = zip.entries[name];
    if (!e) return Promise.resolve(null);
    var b = zip.bytes;
    if (e.flags & 1) return Promise.reject(fail('office_password'));
    if (e.csize === 0xffffffff || e.usize === 0xffffffff || e.usize > CAPS.part) return Promise.reject(fail('office_too_large'));
    if (e.offset + 30 > b.length) return Promise.reject(fail('office_broken'));
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (dv.getUint32(e.offset, true) !== 0x04034b50) return Promise.reject(fail('office_broken'));
    var start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
    if (start + e.csize > b.length) return Promise.reject(fail('office_broken'));
    var raw = b.subarray(start, start + e.csize);
    var cap = Math.min(CAPS.part, zip.left);
    var got;
    if (e.method === 0) got = raw.length > cap ? Promise.reject(fail('office_too_large')) : Promise.resolve(raw);
    else if (e.method === 8) got = inflate(raw, cap);
    else return Promise.reject(fail('office_broken'));
    return got.then(function (out) {
      zip.left -= out.length;
      var text = decodeXml(out);
      if (out !== raw) out.fill(0);
      return text;
    });
  }

  function decodeXml(u) {
    if (u.length >= 2 && u[0] === 0xff && u[1] === 0xfe) return new TextDecoder('utf-16le').decode(u.subarray(2));
    if (u.length >= 2 && u[0] === 0xfe && u[1] === 0xff) return new TextDecoder('utf-16be').decode(u.subarray(2));
    return new TextDecoder('utf-8', { fatal: false }).decode(u.length >= 3 && u[0] === 0xef && u[1] === 0xbb && u[2] === 0xbf ? u.subarray(3) : u);
  }

  // ── XML ──────────────────────────────────────────────────

  var NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'' };
  /** The five predefined entities and character references; any other &name; stays as it is written. */
  function unescapeXml(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g, function (all, e) {
      if (e[0] !== '#') return NAMED[e];
      var cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!(cp > 0) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
      return String.fromCodePoint(cp);
    });
  }

  function local(name) { var c = name.indexOf(':'); return c < 0 ? name : name.slice(c + 1); }

  /**
   * The attributes of a start tag (its text after the name) → { <full name>: value, <local name>: value } — a name
   * without a prefix wins its local name (`id` beside `r:id`).
   */
  function attrs(src) {
    var out = Object.create(null);
    if (!src) return out;
    var re = /([^\s=<>"'/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    var m;
    var n = 0;
    while ((m = re.exec(src)) && n++ < 200) {
      var v = unescapeXml(m[2] !== undefined ? m[2] : m[3]);
      out[m[1]] = v;
      var l = local(m[1]);
      if (l === m[1] || !(l in out)) out[l] = v;
    }
    return out;
  }
  /** The relationship id of an element (r:id, r:embed has another name on purpose) */
  function relId(a) { return a['r:id'] || a.id || null; }

  /**
   * Walks XML text: on.open(localName, attrText, name) · on.close(localName) (also after an empty element) ·
   * on.text(text) — text only while on.wantText is true. Throws office_unsafe on any <! declaration that is not a
   * comment or CDATA and on elements nested too deep; office_broken on text that is no XML.
   */
  function sax(x, on) {
    var i = 0;
    var n = x.length;
    var depth = 0;
    try {
      while (i < n) {
        var lt = x.indexOf('<', i);
        if (lt < 0) break;
        if (on.wantText && lt > i) on.text(unescapeXml(x.slice(i, lt)));
        var c = x.charCodeAt(lt + 1);
        var end;
        if (c === 33) { // <!
          if (x.startsWith('<!--', lt)) {
            end = x.indexOf('-->', lt + 4);
            if (end < 0) throw fail('office_broken');
            i = end + 3;
            continue;
          }
          if (x.startsWith('<![CDATA[', lt)) {
            end = x.indexOf(']]>', lt + 9);
            if (end < 0) throw fail('office_broken');
            if (on.wantText) on.text(x.slice(lt + 9, end));
            i = end + 3;
            continue;
          }
          throw fail('office_unsafe'); // <!DOCTYPE, <!ENTITY …
        }
        if (c === 63) { // <? … ?>
          end = x.indexOf('?>', lt + 2);
          if (end < 0) throw fail('office_broken');
          i = end + 2;
          continue;
        }
        // the end of the tag: a '>' outside a quoted attribute value
        var gt = -1;
        for (var j = lt + 1; j < n; j++) {
          var ch = x.charCodeAt(j);
          if (ch === 62) { gt = j; break; }
          if (ch === 34 || ch === 39) {
            j = x.indexOf(ch === 34 ? '"' : '\'', j + 1);
            if (j < 0) break;
          } else if (ch === 60) break;
        }
        if (gt < 0) throw fail('office_broken');
        if (c === 47) { // </name>
          depth--;
          on.close(local(x.slice(lt + 2, gt).trim()));
          i = gt + 1;
          continue;
        }
        var empty = x.charCodeAt(gt - 1) === 47;
        var inner = x.slice(lt + 1, empty ? gt - 1 : gt);
        var sp = inner.search(/\s/);
        var name = sp < 0 ? inner : inner.slice(0, sp);
        if (!name) throw fail('office_broken');
        if (++depth > CAPS.depth) throw fail('office_unsafe');
        var ln = local(name);
        on.open(ln, sp < 0 ? '' : inner.slice(sp), name);
        if (empty) { depth--; on.close(ln); }
        i = gt + 1;
      }
    } catch (e) {
      if (e !== STOP) throw e;
      return false;
    }
    return true;
  }

  // ── packages: main part and relationships ────────────────

  function dirOf(p) { var s = p.lastIndexOf('/'); return s < 0 ? '' : p.slice(0, s + 1); }
  function resolvePath(base, target) {
    var parts = (target[0] === '/' ? target.slice(1) : dirOf(base) + target).split('/');
    var out = [];
    parts.forEach(function (s) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); });
    return out.join('/');
  }
  /** The relationships of `part` → [{ id, type, target }] (those marked External are left out). */
  function rels(zip, part) {
    var name = part ? dirOf(part) + '_rels/' + part.slice(dirOf(part).length) + '.rels' : '_rels/.rels';
    return zipText(zip, name).then(function (x) {
      var out = [];
      if (!x) return out;
      sax(x, {
        open: function (n, a) {
          if (n !== 'Relationship' || out.length >= 5000) return;
          var at = attrs(a);
          if (String(at.TargetMode || '').toLowerCase() === 'external' || !at.Target) return;
          out.push({ id: at.Id || '', type: String(at.Type || ''), target: resolvePath(part || '', at.Target) });
        },
        close: function () {},
      });
      return out;
    });
  }
  function ofType(list, suffix) { return list.filter(function (r) { return r.type.slice(-suffix.length) === suffix; }); }
  function mainPart(zip, fallback) {
    return rels(zip, '').then(function (list) {
      var m = ofType(list, '/officeDocument')[0];
      var p = m && zip.entries[m.target] ? m.target : fallback;
      if (!zip.entries[p]) throw fail('office_broken');
      return p;
    });
  }

  // ── shared pieces of the models ──────────────────────────

  function onOff(a) { var v = attrs(a).val; return !(v === '0' || v === 'false' || v === 'off' || v === 'none'); }

  /** Collects paragraphs with runs; counts text and blocks against the limits. */
  function Collector() {
    this.chars = 0;
    this.blocks = 0;
    this.images = 0;
    this.truncated = false;
    this.maxChars = CAPS.chars;
    this.maxBlocks = CAPS.blocks;
  }
  Collector.prototype.text = function (para, s, f) {
    if (!s) return;
    this.chars += s.length;
    if (this.chars > this.maxChars) { this.truncated = true; throw STOP; }
    var last = para.runs[para.runs.length - 1];
    var fl = f || {};
    if (last && !last.img && !!last.b === !!fl.b && !!last.i === !!fl.i && !!last.u === !!fl.u && !!last.s === !!fl.s && (last.v || null) === (fl.v || null)) { last.text += s; return; }
    var run = { text: s };
    if (fl.b) run.b = true;
    if (fl.i) run.i = true;
    if (fl.u) run.u = true;
    if (fl.s) run.s = true;
    if (fl.v === 'sup' || fl.v === 'sub') run.v = fl.v;
    para.runs.push(run);
  };
  Collector.prototype.image = function (para) {
    this.images++;
    var last = para && para.runs[para.runs.length - 1];
    if (para && !(last && last.img)) para.runs.push({ text: '', img: true });
  };
  Collector.prototype.block = function (list, b) {
    if (++this.blocks > this.maxBlocks) { this.truncated = true; throw STOP; }
    list.push(b);
  };
  function hasText(p) { return p.runs.some(function (r) { return r.img || /\S/.test(r.text); }); }
  /** Pushes a paragraph: empty ones only once in a row (they are the spacing of the document). */
  function pushPara(col, list, p) {
    var last = list[list.length - 1];
    if (!hasText(p)) {
      if (!last || (last.t === 'p' && !last.runs.length)) return;
      p.runs = [];
      delete p.list;
    }
    col.block(list, p);
  }

  function roman(n) {
    var out = '';
    [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']].forEach(function (p) { while (n >= p[0] && out.length < 20) { out += p[1]; n -= p[0]; } });
    return out;
  }
  function letters(n) { var s = ''; while (n > 0 && s.length < 6) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } return s; }
  function listLabel(fmt, n) {
    if (fmt === 'decimal' || fmt === 'decimalZero') return n + '.';
    if (fmt === 'lowerLetter') return letters(n) + ')';
    if (fmt === 'upperLetter') return letters(n).toUpperCase() + ')';
    if (fmt === 'lowerRoman') return roman(n) + '.';
    if (fmt === 'upperRoman') return roman(n).toUpperCase() + '.';
    if (fmt === 'none') return '';
    return '•';
  }

  // ── Word (docx) ──────────────────────────────────────────

  function docxStyles(x) {
    var map = Object.create(null);
    if (!x) return function () { return null; };
    var cur = null;
    sax(x, {
      open: function (n, a) {
        if (n === 'style') { cur = { id: attrs(a).styleId || '', level: null, based: null }; return; }
        if (!cur) return;
        if (n === 'name') {
          var v = String(attrs(a).val || '');
          var m = /^heading ([1-9])$/i.exec(v);
          if (m) cur.level = Number(m[1]);
          else if (/^title$/i.test(v)) cur.level = 1;
          else if (/^subtitle$/i.test(v)) cur.level = 2;
        } else if (n === 'basedOn') cur.based = attrs(a).val || null;
        else if (n === 'outlineLvl' && cur.level === null) { var l = Number(attrs(a).val); if (l >= 0 && l < 9) cur.level = l + 1; }
      },
      close: function (n) { if (n === 'style' && cur) { if (cur.id) map[cur.id] = cur; cur = null; } },
    });
    return function (id) {
      for (var hop = 0, s = map[id]; s && hop < 12; hop++, s = map[s.based]) if (s.level !== null) return s.level;
      return null;
    };
  }

  function docxNumbering(x) {
    var abs = Object.create(null);
    var nums = Object.create(null);
    if (x) {
      var a0 = null;
      var lvl = null;
      var num = null;
      sax(x, {
        open: function (n, a) {
          if (n === 'abstractNum') { a0 = abs[attrs(a).abstractNumId] = Object.create(null); lvl = null; }
          else if (n === 'lvl' && a0) { lvl = a0[attrs(a).ilvl] = { fmt: 'bullet', start: 1 }; }
          else if (n === 'numFmt' && lvl) lvl.fmt = attrs(a).val || 'bullet';
          else if (n === 'start' && lvl) { var s = Number(attrs(a).val); if (s >= 0 && s < 100000) lvl.start = s; }
          else if (n === 'num') num = attrs(a).numId;
          else if (n === 'abstractNumId' && num != null) nums[num] = attrs(a).val;
        },
        close: function (n) { if (n === 'abstractNum') { a0 = null; lvl = null; } else if (n === 'lvl') lvl = null; else if (n === 'num') num = null; },
      });
    }
    var counters = Object.create(null);
    /** The label of the next paragraph of list `numId` at `level` ("•", "1.", "a)" …) */
    return function (numId, level) {
      var a = abs[nums[numId]];
      var d = a && a[level];
      if (!d) return '•';
      var c = counters[numId] = counters[numId] || [];
      c[level] = c[level] === undefined ? d.start : c[level] + 1;
      c.length = level + 1; // deeper levels start again
      return listLabel(d.fmt, c[level]);
    };
  }

  // what a document says only about its past (tracked changes) or twice (the fallback of a drawing)
  var DOCX_SKIP = { Fallback: 1, del: 1, moveFrom: 1, pPrChange: 1, rPrChange: 1, sectPrChange: 1, tblPrChange: 1, tcPrChange: 1, trPrChange: 1, tblGridChange: 1, instrText: 1, delText: 1, delInstrText: 1 };

  function docxBody(x, styleLevel, label, col) {
    var root = [];
    var lists = [root];   // where blocks go: the body, a table cell
    var paras = [];       // paragraphs open (a text box sits inside a paragraph)
    var tables = [];
    var stack = [];
    var skip = 0;
    var para = null;
    var run = null;
    var on = {
      wantText: false,
      open: function (n, a) {
        if (skip) { skip++; return; }
        if (DOCX_SKIP[n]) { skip = 1; return; }
        var parent = stack[stack.length - 1];
        stack.push(n);
        switch (n) {
          case 'p': paras.push(para); para = { t: 'p', runs: [], style: null, num: null, lvl: 0, level: null }; break;
          case 'r': run = {}; break;
          case 't': if (run && para) on.wantText = true; break;
          case 'tab': if (parent === 'r' && para) col.text(para, '\t', run); break;
          case 'br': case 'cr':
            if (para && attrs(a).type === 'page') para.pageBreak = true;
            else if (para) col.text(para, '\n', run);
            break;
          case 'noBreakHyphen': if (para) col.text(para, '‑', run); break;
          case 'drawing': case 'pict': case 'object': if (para) col.image(para); break;
          case 'pStyle': if (para && parent === 'pPr') para.style = attrs(a).val || null; break;
          case 'numId': if (para && parent === 'numPr') para.num = attrs(a).val || null; break;
          case 'ilvl': if (para && parent === 'numPr') { var l = Number(attrs(a).val); para.lvl = l >= 0 && l <= 8 ? l : 0; } break;
          case 'outlineLvl': if (para && parent === 'pPr') { var o = Number(attrs(a).val); if (o >= 0 && o < 9) para.level = o + 1; } break;
          case 'jc': if (para && parent === 'pPr') { var j = attrs(a).val; if (j === 'center') para.align = 'center'; else if (j === 'right' || j === 'end') para.align = 'right'; } break;
          case 'b': if (run && parent === 'rPr') run.b = onOff(a); break;
          case 'i': if (run && parent === 'rPr') run.i = onOff(a); break;
          case 'u': if (run && parent === 'rPr') run.u = onOff(a); break;
          case 'strike': case 'dstrike': if (run && parent === 'rPr') run.s = onOff(a); break;
          case 'vertAlign': if (run && parent === 'rPr') { var v = attrs(a).val; run.v = v === 'superscript' ? 'sup' : v === 'subscript' ? 'sub' : null; } break;
          case 'position': if (run && parent === 'rPr' && !run.v) { var ps = Number(attrs(a).val); run.v = ps > 0 ? 'sup' : ps < 0 ? 'sub' : null; } break;
          case 'tbl': tables.push({ t: 'table', rows: [], row: null }); break;
          case 'tr': if (tables.length) tables[tables.length - 1].row = []; break;
          case 'tc': if (tables.length) { var cell = { blocks: [], span: 1 }; tables[tables.length - 1].cell = cell; lists.push(cell.blocks); } break;
          case 'gridSpan': if (parent === 'tcPr' && tables.length && tables[tables.length - 1].cell) { var g = Number(attrs(a).val); if (g > 1 && g <= 63) tables[tables.length - 1].cell.span = Math.floor(g); } break;
          default:
        }
      },
      text: function (s) { if (!skip && run && para) col.text(para, s, run); },
      close: function (n) {
        if (skip) { skip--; return; }
        stack.pop();
        var list = lists[lists.length - 1];
        var tb = tables[tables.length - 1];
        switch (n) {
          case 't': on.wantText = false; break;
          case 'r': run = null; break;
          case 'p':
            if (!para) break;
            var level = para.level || (para.style ? styleLevel(para.style) : null);
            var out = { t: level ? 'h' : 'p', runs: para.runs };
            if (level) out.level = level;
            else if (para.num && para.num !== '0') out.list = { level: para.lvl, label: label(para.num, para.lvl) };
            if (para.align) out.align = para.align;
            if (para.pageBreak) col.block(list, { t: 'break' });
            pushPara(col, list, out);
            para = paras.pop() || null;
            break;
          case 'tc': if (tb && tb.cell) { lists.pop(); if (tb.row && tb.row.length < 64) tb.row.push(tb.cell); tb.cell = null; } break;
          case 'tr': if (tb && tb.row) { if (tb.row.length && tb.rows.length < CAPS.rows) tb.rows.push(tb.row); tb.row = null; } break;
          case 'tbl': if (tb) { tables.pop(); if (tb.rows.length) col.block(lists[lists.length - 1], { t: 'table', rows: tb.rows }); } break;
          default:
        }
      },
    };
    sax(x, on);
    return root;
  }

  function readDocx(zip) {
    var col = new Collector();
    return mainPart(zip, 'word/document.xml').then(function (main) {
      return rels(zip, main).then(function (r) {
        var st = ofType(r, '/styles')[0];
        var nu = ofType(r, '/numbering')[0];
        return zipText(zip, st ? st.target : dirOf(main) + 'styles.xml').then(function (sx) {
          return zipText(zip, nu ? nu.target : dirOf(main) + 'numbering.xml').then(function (nx) {
            return zipText(zip, main).then(function (x) {
              var blocks = docxBody(x, docxStyles(sx), docxNumbering(nx), col);
              return { kind: 'doc', blocks: blocks, images: col.images, truncated: col.truncated };
            });
          });
        });
      });
    });
  }

  // ── Excel (xlsx) ─────────────────────────────────────────

  var GENERAL = { type: 'general' };
  var BUILTIN = { 1: { type: 'fixed', dec: 0 }, 2: { type: 'fixed', dec: 2 }, 3: { type: 'fixed', dec: 0, group: true }, 4: { type: 'fixed', dec: 2, group: true },
    9: { type: 'percent', dec: 0 }, 10: { type: 'percent', dec: 2 }, 14: { type: 'date' }, 15: { type: 'date' }, 16: { type: 'date' }, 17: { type: 'date' },
    18: { type: 'time' }, 19: { type: 'time', secs: true }, 20: { type: 'time' }, 21: { type: 'time', secs: true }, 22: { type: 'datetime' },
    37: { type: 'fixed', dec: 0, group: true }, 38: { type: 'fixed', dec: 0, group: true }, 39: { type: 'fixed', dec: 2, group: true }, 40: { type: 'fixed', dec: 2, group: true },
    45: { type: 'time', secs: true }, 46: { type: 'time', secs: true }, 47: { type: 'time', secs: true }, 49: { type: 'text' } };

  /** What a number format code means for showing a number: { type: general | fixed | percent | date | time | datetime | text, … } */
  function formatKind(code) {
    var c = String(code || '').slice(0, 300).split(';')[0];
    var bare = c.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi, '').replace(/[_*]./g, '').trim();
    if (!bare || /^general$/i.test(bare)) return GENERAL;
    if (bare === '@') return { type: 'text' };
    var digits = /[0#?]/.test(bare);
    var date = /[dy]/i.test(bare);
    var time = /[hs]/i.test(bare) || /AM\/PM/i.test(bare);
    if (date || time || (!digits && /m/i.test(bare))) {
      if (time && !date) return { type: 'time', secs: /s/i.test(bare) };
      return { type: date && time ? 'datetime' : 'date', secs: /s/i.test(bare) };
    }
    if (!digits || /E[+-]/i.test(bare)) return GENERAL;
    var m = /[0#?][0#?,]*(?:\.([0#?]+))?/.exec(bare);
    var out = { type: bare.indexOf('%') >= 0 ? 'percent' : 'fixed', dec: m && m[1] ? Math.min(10, m[1].length) : 0, group: /[0#?],[0#?]/.test(bare) };
    var cur = /\[\$([^\]-]{1,4})/.exec(c) || /([€$£¥])/.exec(c.replace(/\[[^\]]*\]/g, '')) || /"\s*([A-Z]{3})\s*"/.exec(c);
    if (cur && cur[1].trim()) { out.cur = cur[1].trim(); out.curFirst = c.indexOf(cur[1]) < c.search(/[0#?]/); }
    return out;
  }

  function xlsxStyles(x) {
    var custom = Object.create(null);
    var xfs = [];
    if (!x) return xfs;
    var inXfs = false;
    var cache = Object.create(null);
    sax(x, {
      open: function (n, a) {
        if (n === 'numFmt') { var at = attrs(a); if (at.numFmtId !== undefined && Object.keys(custom).length < 2000) custom[at.numFmtId] = at.formatCode || ''; }
        else if (n === 'cellXfs') inXfs = true;
        else if (n === 'xf' && inXfs && xfs.length < 65000) {
          var id = attrs(a).numFmtId || '0';
          if (!(id in cache)) cache[id] = id in custom ? formatKind(custom[id]) : BUILTIN[id] || GENERAL;
          xfs.push(cache[id]);
        }
      },
      close: function (n) { if (n === 'cellXfs') inXfs = false; },
    });
    return xfs;
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  /** A number as its format shows it (`lang` 'de' | 'en'); dates from Excel's day count. */
  function formatNumber(num, k, lang, date1904) {
    var loc = lang === 'en' ? 'en-US' : 'de-DE';
    if ((k.type === 'date' || k.type === 'time' || k.type === 'datetime') && num >= 0 && num < 2958466) {
      var days = Math.floor(num);
      var secs = Math.round((num - days) * 86400);
      if (secs >= 86400) { days++; secs = 0; }
      var hh = Math.floor(secs / 3600);
      var mm = Math.floor((secs % 3600) / 60);
      var ss = secs % 60;
      if (k.type === 'time') return pad(days * 24 + hh) + ':' + pad(mm) + (k.secs || ss ? ':' + pad(ss) : '');
      // day 1 is 1900-01-01, and Excel counts a 1900-02-29 that never was
      var d = new Date(date1904 ? Date.UTC(1904, 0, 1 + days) : Date.UTC(1899, 11, days < 60 ? 31 + days : 30 + days));
      var date = lang === 'en' ? d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) : pad(d.getUTCDate()) + '.' + pad(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear();
      return k.type === 'date' ? date : date + ' ' + pad(hh) + ':' + pad(mm) + (k.secs || ss ? ':' + pad(ss) : '');
    }
    if (k.type === 'percent') return (num * 100).toLocaleString(loc, { minimumFractionDigits: k.dec, maximumFractionDigits: k.dec, useGrouping: false }) + ' %';
    if (k.type === 'fixed') {
      var s = num.toLocaleString(loc, { minimumFractionDigits: k.dec, maximumFractionDigits: k.dec, useGrouping: !!k.group });
      return k.cur ? (k.curFirst ? k.cur + ' ' + s : s + ' ' + k.cur) : s;
    }
    var g = String(parseFloat(num.toPrecision(15)));
    return lang === 'en' || g.indexOf('e') >= 0 ? g : g.replace('.', ',');
  }

  function colOf(ref) {
    var n = 0;
    for (var i = 0; i < ref.length && i < 4; i++) {
      var c = ref.charCodeAt(i) & ~32;
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n;
  }
  /** "A", "B" … "CV" of a column number (1 = A) */
  function colName(n) { var s = ''; while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); } return s; }
  function xEscapes(s) { return s.indexOf('_x') < 0 ? s : s.replace(/_x([0-9A-Fa-f]{4})_/g, function (_, h) { var c = parseInt(h, 16); return c === 0 || (c >= 0xd800 && c <= 0xdfff) ? '' : String.fromCharCode(c); }); }

  function xlsxStrings(x) {
    var out = [];
    if (!x) return out;
    var cur = null;
    var skip = 0;
    var on = {
      wantText: false,
      open: function (n) {
        if (skip) { skip++; return; }
        if (n === 'rPh') { skip = 1; return; } // how to pronounce it, not what it says
        if (n === 'si') { if (out.length >= CAPS.strings) throw STOP; cur = ''; }
        else if (n === 't' && cur !== null) on.wantText = true;
      },
      text: function (s) { if (!skip && cur !== null && cur.length < CAPS.cellChars) cur += s; },
      close: function (n) {
        if (skip) { skip--; return; }
        if (n === 't') on.wantText = false;
        else if (n === 'si' && cur !== null) { out.push(xEscapes(cur).slice(0, CAPS.cellChars)); cur = null; }
      },
    };
    sax(x, on);
    return out;
  }

  function xlsxSheet(x, shared, xfs, o) {
    var sheet = { rows: [], cols: 0, truncated: false };
    var row = null;
    var rowNo = 0;
    var colNo = 0;
    var cell = null;
    var buf = null;
    var cells = 0;
    var skip = 0;
    var on = {
      wantText: false,
      open: function (n, a) {
        if (skip) { skip++; return; }
        if (n === 'rPh' || n === 'f') { skip = 1; return; } // a formula is never read, only its stored value
        if (n === 'row') {
          var r = Number(attrs(a).r);
          rowNo = r > rowNo && r < 1e7 ? Math.floor(r) : rowNo + 1;
          if (rowNo > CAPS.rows) { sheet.truncated = true; throw STOP; }
          row = { r: rowNo, cells: {} };
          colNo = 0;
        } else if (n === 'c' && row) {
          var at = attrs(a);
          var c = at.r ? colOf(at.r) : 0;
          colNo = c > colNo ? c : colNo + 1;
          if (colNo > CAPS.cols) { sheet.truncated = true; cell = null; return; }
          cell = { t: at.t || 'n', s: Number(at.s) || 0, v: null };
        } else if (cell && (n === 'v' || n === 't')) { buf = ''; on.wantText = true; }
      },
      text: function (s) { if (!skip && buf !== null && buf.length < CAPS.cellChars) buf += s; },
      close: function (n) {
        if (skip) { skip--; return; }
        if ((n === 'v' || n === 't') && buf !== null) {
          if (cell) cell.v = (cell.v || '') + buf;
          buf = null;
          on.wantText = false;
        } else if (n === 'c' && cell) {
          var shown = cellText(cell, shared, xfs, o);
          if (shown && shown.v !== '') {
            if (++cells > CAPS.cells) { sheet.truncated = true; throw STOP; }
            row.cells[colNo] = shown;
            if (colNo > sheet.cols) sheet.cols = colNo;
          }
          cell = null;
        } else if (n === 'row' && row) {
          if (Object.keys(row.cells).length) sheet.rows.push(row);
          row = null;
        }
      },
    };
    var whole = sax(x, on);
    if (!whole && row && Object.keys(row.cells).length) sheet.rows.push(row);
    return sheet;
  }

  function cellText(cell, shared, xfs, o) {
    var v = cell.v;
    if (v === null || v === '') return null;
    switch (cell.t) {
      case 's': { var s = shared[Number(v)]; return s ? { v: s } : null; }
      case 'inlineStr': case 'str': return { v: xEscapes(v).slice(0, CAPS.cellChars) };
      case 'b': return { v: v === '1' ? (o.lang === 'en' ? 'TRUE' : 'WAHR') : (o.lang === 'en' ? 'FALSE' : 'FALSCH') };
      case 'e': return { v: v.slice(0, 40) };
      case 'd': return { v: v.slice(0, 40), n: true };
      default: {
        var num = Number(v);
        if (!isFinite(num) || !/\d/.test(v)) return { v: v.slice(0, 40) };
        var k = xfs[cell.s] || GENERAL;
        if (k.type === 'text') return { v: v.slice(0, 40) };
        return { v: formatNumber(num, k, o.lang, o.date1904), n: true };
      }
    }
  }

  function chain(list, fn) { return list.reduce(function (p, x, i) { return p.then(function () { return fn(x, i); }); }, Promise.resolve()); }

  function readXlsx(zip, o) {
    return mainPart(zip, 'xl/workbook.xml').then(function (main) {
      return Promise.all([zipText(zip, main), rels(zip, main)]).then(function (got) {
        var r = got[1];
        var names = [];
        var date1904 = false;
        sax(got[0], {
          open: function (n, a) {
            if (n === 'sheet') { var at = attrs(a); names.push({ name: String(at.name || '').slice(0, 80), rel: relId(at) }); }
            else if (n === 'workbookPr') { var d = attrs(a).date1904; date1904 = d === '1' || d === 'true'; }
          },
          close: function () {},
        });
        var byId = Object.create(null);
        r.forEach(function (x) { byId[x.id] = x.target; });
        var st = ofType(r, '/styles')[0];
        var sh = ofType(r, '/sharedStrings')[0];
        var out = { kind: 'sheets', sheets: [], truncated: names.length > CAPS.sheets };
        return zipText(zip, st ? st.target : dirOf(main) + 'styles.xml').then(function (sx) {
          var xfs = xlsxStyles(sx);
          return zipText(zip, sh ? sh.target : dirOf(main) + 'sharedStrings.xml').then(function (tx) {
            var shared = xlsxStrings(tx);
            var opt = { lang: o.lang, date1904: date1904 };
            return chain(names.slice(0, CAPS.sheets), function (s, i) {
              var p = byId[s.rel];
              // a chart sheet or a macro sheet is no worksheet: nothing to show
              if (!p || !/worksheets\//.test(p)) { out.sheets.push({ name: s.name || String(i + 1), rows: [], cols: 0, truncated: false, other: true }); return null; }
              return zipText(zip, p).then(function (x) {
                var sheet = x ? xlsxSheet(x, shared, xfs, opt) : { rows: [], cols: 0, truncated: false };
                sheet.name = s.name || String(i + 1);
                if (sheet.truncated) out.truncated = true;
                out.sheets.push(sheet);
              });
            });
          });
        }).then(function () { return out; });
      });
    });
  }

  // ── PowerPoint (pptx) ────────────────────────────────────

  function pptxSlide(x, col) {
    var slide = { blocks: [], images: 0 };
    var shape = null;       // { title, blocks }
    var lists = [slide.blocks];
    var tables = [];
    var para = null;
    var run = null;
    var body = 0;
    var skip = 0;
    var on = {
      wantText: false,
      open: function (n, a) {
        if (skip) { skip++; return; }
        if (n === 'Fallback') { skip = 1; return; }
        switch (n) {
          case 'sp': shape = { title: false }; break;
          case 'ph': if (shape) { var ty = attrs(a).type; if (ty === 'title' || ty === 'ctrTitle') shape.title = true; else if (ty === 'sldNum' || ty === 'dt' || ty === 'ftr') shape.skip = true; } break;
          case 'txBody': body++; break;
          case 'p': if (body) para = { t: 'p', runs: [], lvl: 0 }; break;
          case 'pPr': if (para) { var l = Number(attrs(a).lvl); if (l > 0 && l <= 8) para.lvl = Math.floor(l); } break;
          case 'r': case 'fld': if (para) run = {}; break;
          case 'rPr': if (run) { var at = attrs(a); run.b = at.b === '1' || at.b === 'true'; run.i = at.i === '1' || at.i === 'true'; run.u = !!at.u && at.u !== 'none'; run.s = !!at.strike && at.strike !== 'noStrike'; } break;
          case 't': if (run && para) on.wantText = true; break;
          case 'br': if (para) col.text(para, '\n', run); break;
          case 'pic': slide.images++; col.images++; break;
          case 'tbl': tables.push({ rows: [], row: null, cell: null }); break;
          case 'tr': if (tables.length) tables[tables.length - 1].row = []; break;
          case 'tc': if (tables.length) { var cell = { blocks: [], span: 1 }; var g = Number(attrs(a).gridSpan); if (g > 1 && g <= 63) cell.span = Math.floor(g); tables[tables.length - 1].cell = cell; lists.push(cell.blocks); } break;
          default:
        }
      },
      text: function (s) { if (!skip && run && para) col.text(para, s, run); },
      close: function (n) {
        if (skip) { skip--; return; }
        var tb = tables[tables.length - 1];
        switch (n) {
          case 't': on.wantText = false; break;
          case 'r': case 'fld': run = null; break;
          case 'p':
            if (!para) break;
            if (!(shape && shape.skip)) {
              var out = shape && shape.title && !tables.length ? { t: 'h', level: 2, runs: para.runs } : { t: 'p', runs: para.runs };
              if (out.t === 'p' && para.lvl) out.list = { level: para.lvl, label: '' };
              pushPara(col, lists[lists.length - 1], out);
            }
            para = null;
            break;
          case 'txBody': body--; break;
          case 'sp': shape = null; break;
          case 'tc': if (tb && tb.cell) { lists.pop(); if (tb.row && tb.row.length < 64) tb.row.push(tb.cell); tb.cell = null; } break;
          case 'tr': if (tb && tb.row) { if (tb.row.length && tb.rows.length < CAPS.rows) tb.rows.push(tb.row); tb.row = null; } break;
          case 'tbl': if (tb) { tables.pop(); if (tb.rows.length) col.block(lists[lists.length - 1], { t: 'table', rows: tb.rows }); } break;
          default:
        }
      },
    };
    var whole = sax(x, on);
    if (!whole) col.truncated = true;
    return slide;
  }

  function readPptx(zip) {
    var col = new Collector();
    return mainPart(zip, 'ppt/presentation.xml').then(function (main) {
      return Promise.all([zipText(zip, main), rels(zip, main)]).then(function (got) {
        var byId = Object.create(null);
        got[1].forEach(function (x) { byId[x.id] = x; });
        var order = [];
        sax(got[0], { open: function (n, a) { if (n === 'sldId') { var r = byId[attrs(a)['r:id']]; if (r && /\/slide$/.test(r.type)) order.push(r.target); } }, close: function () {} });
        // a presentation that names no slides in order: the slide parts by their number
        if (!order.length) order = ofType(got[1], '/slide').map(function (r) { return r.target; });
        var out = { kind: 'slides', slides: [], images: 0, truncated: order.length > CAPS.slides };
        return chain(order.slice(0, CAPS.slides), function (p) {
          if (col.truncated) return null;
          return zipText(zip, p).then(function (x) { if (x) out.slides.push(pptxSlide(x, col)); });
        }).then(function () {
          out.images = col.images;
          if (col.truncated) out.truncated = true;
          return out;
        });
      });
    });
  }

  // ── OpenDocument (odt, ods, odp) ─────────────────────────

  var ODF_SKIP = { annotation: 1, 'tracked-changes': 1, forms: 1, 'note-body': 1, 'table-of-content-source': 1, 'index-title-template': 1, script: 1, 'event-listeners': 1, 'content-validations': 1, object: 1, 'object-ole': 1, plugin: 1, applet: 1 };
  var ODF_NUMERIC = { float: 1, currency: 1, percentage: 1, date: 1, time: 1 };

  function readOdf(zip, format) {
    return zipText(zip, 'content.xml').then(function (x) {
      if (!x) throw fail('office_broken');
      var col = new Collector();
      var sheetsMode = format === 'ods';
      var slidesMode = format === 'odp';
      // a sheet has its own limits (rows, columns, cells); its cells' paragraphs are not the blocks of a document
      if (sheetsMode) { col.maxBlocks = Infinity; col.maxChars = CAPS.cells * 200; }
      var full = false;  // the sheet read has reached its limit: the rest of it is passed over
      var out = sheetsMode ? { kind: 'sheets', sheets: [], truncated: false } : slidesMode ? { kind: 'slides', slides: [], images: 0, truncated: false } : { kind: 'doc', blocks: [], images: 0, truncated: false };
      var styles = Object.create(null); // text and paragraph styles of the file: { b, i, u, s }
      var style = null;
      var root = slidesMode || sheetsMode ? [] : out.blocks;
      var lists = [root];
      var paras = [];
      var para = null;
      var spans = [];
      var listDepth = 0;
      var tables = [];   // doc mode: { rows, row, cell }
      var tableDepth = 0;
      var sheet = null;
      var srow = null;   // { r, rep, cells }
      var scell = null;  // { rep, blocks, n }
      var rowNo = 0;
      var colNo = 0;
      var cells = 0;
      var skip = 0;
      var flagsNow = function () { return spans.length ? spans[spans.length - 1] : (para && para.flags) || null; };
      var merge = function (a, b) { if (!b) return a; return { b: (a && a.b) || b.b, i: (a && a.i) || b.i, u: (a && a.u) || b.u, s: (a && a.s) || b.s, v: b.v || (a && a.v) || null }; };
      var listStyles = Object.create(null); // <name>: { <level>: 'number' | 'bullet' }
      var listStyle = null;
      var olists = [];   // lists open: { style, n, fresh }
      var frames = [];   // frames open: true for the title of a slide
      var on = {
        wantText: false,
        open: function (n, a) {
          if (skip) { skip++; return; }
          if (ODF_SKIP[n]) { skip = 1; return; }
          var at;
          switch (n) {
            case 'style':
              at = attrs(a);
              style = at.name ? (styles[at.name] = {}) : null;
              if (style) { var hl = odfHeading(at['parent-style-name']); if (hl) style.level = hl; }
              break;
            case 'paragraph-properties': if (style) { var ta = attrs(a)['text-align']; if (ta === 'center') style.align = 'center'; else if (ta === 'end' || ta === 'right') style.align = 'right'; } break;
            case 'text-properties':
              if (style) {
                at = attrs(a);
                style.b = at['font-weight'] === 'bold';
                style.i = at['font-style'] === 'italic';
                style.u = !!at['text-underline-style'] && at['text-underline-style'] !== 'none';
                style.s = !!at['text-line-through-style'] && at['text-line-through-style'] !== 'none';
                var tp = String(at['text-position'] || '');
                // "super 58%", "sub 58%", or how far above / below the line in percent ("33% 80%", "-8% 80%")
                style.v = /^super/.test(tp) || parseFloat(tp) > 0 ? 'sup' : /^sub/.test(tp) || parseFloat(tp) < 0 ? 'sub' : null;
              }
              break;
            case 'list-style': at = attrs(a); listStyle = at.name ? (listStyles[at.name] = Object.create(null)) : null; break;
            case 'list-level-style-number': case 'list-level-style-bullet': if (listStyle) listStyle[attrs(a).level] = n === 'list-level-style-number' ? 'number' : 'bullet'; break;
            case 'list-item': if (olists.length) { var top = olists[olists.length - 1]; top.n++; top.fresh = true; } break;
            case 'h': case 'p':
              at = attrs(a);
              paras.push(para);
              para = { t: n === 'h' ? 'h' : 'p', runs: [], flags: styles[at['style-name']] || null };
              if (n === 'h') { var lv = Number(at['outline-level']); para.level = lv >= 1 && lv <= 9 ? Math.floor(lv) : 1; }
              else {
                // a paragraph that is a heading by its style ("Heading 1", "Title") without being a text:h
                var sl = odfHeading(at['style-name']) || (para.flags && para.flags.level) || 0;
                if (sl) { para.t = 'h'; para.level = sl; }
              }
              if (para.flags && para.flags.align) para.align = para.flags.align;
              if (frames.length && frames[frames.length - 1] && para.t === 'p') { para.t = 'h'; para.level = 2; }
              on.wantText = true;
              break;
            case 'span': spans.push(merge(flagsNow(), styles[attrs(a)['style-name']])); break;
            case 's': if (para) { var c = Number(attrs(a).c); col.text(para, ' '.repeat(c >= 1 && c <= 200 ? Math.floor(c) : 1), flagsNow()); } break;
            case 'tab': if (para) col.text(para, '\t', flagsNow()); break;
            case 'line-break': if (para) col.text(para, '\n', flagsNow()); break;
            case 'list': listDepth++; olists.push({ style: attrs(a)['style-name'] || (olists.length ? olists[olists.length - 1].style : null), n: 0, fresh: false }); break;
            case 'image': col.image(para); break;
            case 'frame': at = attrs(a); frames.push(slidesMode && (at['presentation:class'] === 'title' || at['presentation:class'] === 'subtitle')); break;
            case 'page':
              if (slidesMode) {
                if (out.slides.length >= CAPS.slides) { out.truncated = true; throw STOP; }
                var slide = { blocks: [], images: 0 };
                out.slides.push(slide);
                lists = [slide.blocks];
              }
              break;
            case 'table':
              tableDepth++;
              if (sheetsMode) {
                if (tableDepth === 1) {
                  if (out.sheets.length >= CAPS.sheets) { out.truncated = true; throw STOP; }
                  sheet = { name: String(attrs(a).name || '').slice(0, 80) || String(out.sheets.length + 1), rows: [], cols: 0, truncated: false };
                  rowNo = 0;
                  cells = 0;
                  full = false;
                }
              } else tables.push({ rows: [], row: null, cell: null });
              break;
            case 'table-row':
              if (sheetsMode) {
                if (tableDepth === 1 && sheet) {
                  if (full) { skip = 1; return; }
                  var rr = Number(attrs(a)['number-rows-repeated']);
                  srow = { r: rowNo + 1, rep: rr >= 1 ? Math.floor(rr) : 1, cells: {} };
                  colNo = 0;
                }
              } else if (tables.length) tables[tables.length - 1].row = [];
              break;
            case 'table-cell': case 'covered-table-cell':
              at = attrs(a);
              if (sheetsMode) {
                if (tableDepth === 1 && srow) { var cr = Number(at['number-columns-repeated']); scell = { rep: cr >= 1 ? Math.floor(cr) : 1, blocks: [], n: !!ODF_NUMERIC[at['value-type']] }; lists.push(scell.blocks); }
              } else if (tables.length) {
                var cell = { blocks: [], span: 1, covered: n === 'covered-table-cell' };
                var sp = Number(at['number-columns-spanned']);
                if (sp > 1 && sp <= 63) cell.span = Math.floor(sp);
                tables[tables.length - 1].cell = cell;
                lists.push(cell.blocks);
              }
              break;
            default:
          }
        },
        text: function (s) { if (!skip && para) col.text(para, s, flagsNow()); },
        close: function (n) {
          if (skip) { skip--; return; }
          var tb = tables[tables.length - 1];
          switch (n) {
            case 'style': style = null; break;
            case 'span': spans.pop(); break;
            case 'list': listDepth--; olists.pop(); break;
            case 'list-style': listStyle = null; break;
            case 'frame': frames.pop(); break;
            case 'h': case 'p':
              if (!para) break;
              var b = { t: para.t, runs: para.runs };
              if (para.align) b.align = para.align;
              if (para.t === 'h') b.level = para.level;
              else if (listDepth > 0 && olists.length) {
                var ol = olists[olists.length - 1];
                var kind = (listStyles[ol.style] || {})[listDepth];
                b.list = { level: Math.min(8, listDepth - 1), label: !ol.fresh ? '' : kind === 'number' ? ol.n + '.' : '•' };
                ol.fresh = false;
              }
              pushPara(col, lists[lists.length - 1], b);
              para = paras.pop() || null;
              on.wantText = !!para;
              break;
            case 'table-cell': case 'covered-table-cell':
              if (sheetsMode) {
                if (tableDepth !== 1 || !scell) break;
                lists.pop();
                var text = scell.blocks.map(blockText).filter(function (t) { return t !== ''; }).join('\n').slice(0, CAPS.cellChars);
                if (text !== '') {
                  for (var k = 0; k < scell.rep && colNo + k < CAPS.cols; k++) srow.cells[colNo + k + 1] = scell.n ? { v: text, n: true } : { v: text };
                  if (colNo + scell.rep > CAPS.cols) sheet.truncated = true;
                }
                colNo += scell.rep;
                scell = null;
              } else if (tb && tb.cell) {
                lists.pop();
                // a cell covered by its neighbour's span is no cell of its own
                if (tb.row && tb.row.length < 64 && !tb.cell.covered) { delete tb.cell.covered; tb.row.push(tb.cell); }
                tb.cell = null;
              }
              break;
            case 'table-row':
              if (sheetsMode) {
                if (tableDepth !== 1 || !srow) break;
                var keys = Object.keys(srow.cells);
                if (keys.length) {
                  // the same filled row several times: every copy (a few), then the limit
                  for (var i = 0; i < srow.rep && i < 200; i++) {
                    if (rowNo + i + 1 > CAPS.rows || (cells += keys.length) > CAPS.cells) { sheet.truncated = true; full = true; break; }
                    sheet.rows.push({ r: rowNo + i + 1, cells: srow.cells });
                  }
                  keys.forEach(function (c) { if (Number(c) > sheet.cols) sheet.cols = Number(c); });
                }
                rowNo += srow.rep;
                srow = null;
              } else if (tb && tb.row) { if (tb.row.length && tb.rows.length < CAPS.rows) tb.rows.push(tb.row); tb.row = null; }
              break;
            case 'table':
              tableDepth--;
              if (sheetsMode) {
                if (tableDepth === 0 && sheet) { if (sheet.truncated) out.truncated = true; out.sheets.push(sheet); sheet = null; }
              } else if (tb) { tables.pop(); if (tb.rows.length) col.block(lists[lists.length - 1], { t: 'table', rows: tb.rows }); }
              break;
            default:
          }
        },
      };
      sax(x, on);
      // the limit on text reached in the middle of a sheet: what was read of it stays
      if (sheetsMode && sheet) { sheet.truncated = true; out.sheets.push(sheet); out.truncated = true; }
      if (col.truncated) out.truncated = true;
      if (!sheetsMode) out.images = col.images;
      return out;
    });
  }

  /** The heading level a paragraph style's name stands for ("Heading_20_2" → 2, "Title" → 1), else 0 */
  function odfHeading(name) {
    var m = /^Heading(?:_20_)?([1-9])$/.exec(String(name || ''));
    if (m) return Number(m[1]);
    return name === 'Title' ? 1 : name === 'Subtitle' ? 2 : 0;
  }

  /** The text of a block (a table cell of a sheet shows text only) */
  function blockText(b) {
    if (b.t === 'table') return b.rows.map(function (r) { return r.map(function (c) { return c.blocks.map(blockText).join(' '); }).join(' '); }).join('\n');
    return (b.runs || []).map(function (r) { return r.text; }).join('');
  }

  // ── entry ────────────────────────────────────────────────

  /** Reads office file `bytes` named `name` → a model (see the top). `bytes` is not changed and not kept. */
  function read(bytes, name, o) {
    var opt = { lang: o && o.lang === 'en' ? 'en' : 'de' };
    var format = formatOf(name);
    return Promise.resolve().then(function () {
      if (!format) throw fail('office_format');
      var zip = zipOpen(bytes);
      var done = function (m) { zip.bytes = null; return m; };
      var failed = function (e) { zip.bytes = null; throw own(e); };
      if (format === 'docx') return readDocx(zip, opt).then(done, failed);
      if (format === 'xlsx') return readXlsx(zip, opt).then(done, failed);
      if (format === 'pptx') return readPptx(zip, opt).then(done, failed);
      return readOdf(zip, format, opt).then(done, failed);
    }).catch(function (e) { throw own(e); });
  }

  var api = { read: read, formatOf: formatOf, colName: colName, formatKind: formatKind, formatNumber: formatNumber, CAPS: CAPS, _sax: sax, _attrs: attrs, _unescape: unescapeXml, _zipOpen: zipOpen };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DriveVaultOffice = api;
}());
