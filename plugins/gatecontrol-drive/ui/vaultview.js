/* Drive (gatecontrol-drive) — the viewer of vault files in the portal tab (since 1.22.0): window.DriveVaultView.
 *
 * A vault's file is decrypted in this tab (ui/vault.js) and shown here, in memory only:
 *   * pictures (JPEG, PNG, GIF, WebP, AVIF, BMP, SVG): decoded with ImageDecoder from the bytes (no URL at all; the
 *     orientation of a JPEG from its EXIF), else createImageBitmap of an in-memory Blob — then drawn on a <canvas>;
 *   * PDF: pdf.js (vendor/pdfjs, loaded only now through GET viewer/pdfjs, server/viewer.js) renders the pages on
 *     <canvas> elements in this frame — no browser PDF plugin, no URL, no network (the frame has connect-src 'none');
 *   * text and Markdown: decoded and shown as text (Markdown as headings, lists, code — built with text nodes only,
 *     never HTML of the file).
 * Never a blob:/data: URL of the plaintext (the frame's CSP allows none for media anyway), nothing in a storage, a cache
 * or a service worker (the frame has none), nothing handed to another program — "Herunterladen" stays the one explicit
 * way out, with a note that the downloaded copy is not encrypted. Videos and office files: a note instead (the frame may
 * play media only from GateControl's /plugin-media/ — no blob:, no MediaSource; office files have no safe renderer in
 * the browser). Closing the viewer, locking the vault (lockAll → close('lock')) or the tab hiding while vaults lock then
 * drops everything: the decrypted bytes overwritten with zeros, bitmaps closed, canvases emptied (width 0), pdf.js's
 * document destroyed, the DOM removed. A decryption still running when the viewer closed or the vault locked is
 * stopped at its next read and its result dropped (the session's `alive()`).
 *
 * vault.js calls DriveVaultView.attach({ T, h, icon, btn, ibtn, api, touch, decrypt, download, lock, fmtSize }) →
 * { open(node, name, content?), close(why), isOpen(), kindOf(name), LIMITS }.
 */
(function () {
  'use strict';

  var MB = 1048576;
  // what is decrypted into memory at most (the size of the ciphertext counts: a little larger than the file)
  var LIMITS = { image: 64 * MB, pdf: 100 * MB, text: 8 * MB };
  var MAX_SIDE = 8192; // a picture is drawn at most this large (a canvas of more would need too much memory)
  var MAX_PAGES_AHEAD = 2; // pages rendered beyond the ones on screen

  var IMAGE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon' };
  var TEXT = ['txt', 'text', 'log', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'ini', 'conf', 'cfg', 'toml', 'env', 'sh', 'ps1', 'bat', 'js', 'ts', 'py', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'sql', 'html', 'htm', 'css', 'vcf', 'ics'];
  var MARKDOWN = ['md', 'markdown', 'mdown', 'mkd'];
  var VIDEO = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', '3gp', 'mpg', 'mpeg', 'wmv'];
  var OFFICE = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'pages', 'numbers', 'key'];
  var HEIC = ['heic', 'heif'];

  function extOf(name) { var m = /\.([a-z0-9]{1,8})$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }

  /** What the viewer does with a file of this name: image | pdf | text | markdown | video | office | heic | other */
  function kindOf(name) {
    var e = extOf(name);
    if (IMAGE[e]) return 'image';
    if (e === 'pdf') return 'pdf';
    if (MARKDOWN.indexOf(e) >= 0) return 'markdown';
    if (TEXT.indexOf(e) >= 0) return 'text';
    if (VIDEO.indexOf(e) >= 0) return 'video';
    if (OFFICE.indexOf(e) >= 0) return 'office';
    if (HEIC.indexOf(e) >= 0) return 'heic';
    return 'other';
  }
  function limitOf(kind) { return kind === 'markdown' ? LIMITS.text : LIMITS[kind] || 0; }

  function wipeAll(parts) { (parts || []).forEach(function (p) { try { if (p && p.fill && p.buffer && p.buffer.byteLength) p.fill(0); } catch (e) { /* detached */ } }); }
  function join(parts) {
    var n = 0;
    parts.forEach(function (p) { n += p.length; });
    var out = new Uint8Array(n);
    var o = 0;
    parts.forEach(function (p) { out.set(p, o); o += p.length; });
    return out;
  }

  /** The EXIF orientation (1…8) of a JPEG, 1 when it has none. */
  function jpegOrientation(b) {
    if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    var o = 2;
    while (o + 4 <= b.length) {
      if (b[o] !== 0xff) return 1;
      var marker = b[o + 1];
      var len = dv.getUint16(o + 2);
      if (marker === 0xda || len < 2) return 1;
      if (marker === 0xe1 && o + 10 <= b.length && dv.getUint32(o + 4) === 0x45786966) {
        var t = o + 10; // TIFF header
        if (t + 8 > b.length) return 1;
        var le = dv.getUint16(t) === 0x4949;
        var ifd = t + dv.getUint32(t + 4, le);
        if (ifd + 2 > b.length) return 1;
        var count = dv.getUint16(ifd, le);
        for (var i = 0; i < count; i++) {
          var e = ifd + 2 + i * 12;
          if (e + 10 > b.length) return 1;
          if (dv.getUint16(e, le) === 0x0112) { var v = dv.getUint16(e + 8, le); return v >= 1 && v <= 8 ? v : 1; }
        }
        return 1;
      }
      o += 2 + len;
    }
    return 1;
  }

  // ── Markdown as DOM (text nodes only) ─────────────────────

  function inline(h, text) {
    var out = [];
    var re = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
    var last = 0;
    var m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      var s = m[0];
      if (s[0] === '`') out.push(h('code', { text: s.slice(1, -1) }));
      else if (s.slice(0, 2) === '**' || s.slice(0, 2) === '__') out.push(h('strong', { text: s.slice(2, -2) }));
      else out.push(h('em', { text: s.slice(1, -1) }));
      last = m.index + s.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  /** Markdown → a list of elements: headings, lists, quotes, code blocks, rules, paragraphs; links stay text. */
  function markdown(h, src) {
    var lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var i = 0;
    var para = [];
    var flush = function () { if (para.length) { out.push(h('p', null, inline(h, para.join(' ')))); para = []; } };
    while (i < lines.length) {
      var l = lines[i];
      var fence = /^\s*(```|~~~)/.exec(l);
      if (fence) {
        flush();
        var code = [];
        i++;
        while (i < lines.length && lines[i].trim().indexOf(fence[1]) !== 0) { code.push(lines[i]); i++; }
        i++;
        out.push(h('pre', { class: 'dp-vv-code', text: code.join('\n') }));
        continue;
      }
      var hd = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
      if (hd) { flush(); out.push(h('h' + Math.min(6, hd[1].length + 1), null, inline(h, hd[2]))); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out.push(h('hr')); i++; continue; }
      var li = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(l);
      if (li) {
        flush();
        var ordered = /\d/.test(li[1]);
        var list = h(ordered ? 'ol' : 'ul');
        while (i < lines.length) {
          var x = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i]);
          if (!x || /\d/.test(x[1]) !== ordered) break;
          var item = x[2].replace(/^\[( |x|X)\]\s+/, function (_, c) { return c === ' ' ? '☐ ' : '☑ '; });
          list.appendChild(h('li', null, inline(h, item)));
          i++;
        }
        out.push(list);
        continue;
      }
      if (/^\s*>/.test(l)) {
        flush();
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push(h('blockquote', null, inline(h, q.join(' '))));
        continue;
      }
      if (!l.trim()) { flush(); i++; continue; }
      para.push(l.trim());
      i++;
    }
    flush();
    return out;
  }

  // ── pdf.js, loaded once per tab ───────────────────────────

  var pdfjs = null; // a promise of window.pdfjsLib

  /** Runs `code` as an inline module script; resolves when it ran (its last statement calls back). */
  function runModule(code, tag) {
    return new Promise(function (resolve, reject) {
      var key = '__dvvReady_' + tag;
      var el = document.createElement('script');
      var finish = function (ok) {
        clearTimeout(timer);
        delete window[key];
        if (el.parentNode) el.parentNode.removeChild(el);
        if (ok) resolve(); else reject(Object.assign(new Error('pdfjs'), { code: 'viewer_failed' }));
      };
      var timer = setTimeout(function () { finish(false); }, 30000);
      window[key] = function () { finish(true); };
      el.type = 'module';
      el.textContent = code + '\n;globalThis[' + JSON.stringify(key) + '] && globalThis[' + JSON.stringify(key) + ']();\n';
      document.head.appendChild(el);
    });
  }

  function loadPdfjs(api) {
    if (window.pdfjsLib && window.pdfjsLib.getDocument) return Promise.resolve(window.pdfjsLib);
    if (pdfjs) return pdfjs;
    var code = { worker: [], lib: [] };
    var get = function (n) {
      return api('GET', 'viewer/pdfjs', null, { part: n }).then(function (r) {
        (code[r.file] = code[r.file] || [])[r.index] = r.code;
        return n + 1 < r.parts ? get(n + 1) : null;
      });
    };
    pdfjs = get(0).then(function () { return runModule(code.worker.join(''), 'worker'); })
      .then(function () { return runModule(code.lib.join(''), 'lib'); })
      .then(function () {
        if (!window.pdfjsLib || !window.pdfjsLib.getDocument || !window.pdfjsWorker) throw Object.assign(new Error('pdfjs'), { code: 'viewer_failed' });
        return window.pdfjsLib;
      });
    pdfjs.catch(function () { pdfjs = null; });
    return pdfjs;
  }

  function attach(D) {
    var T = D.T;
    var h = D.h;
    var cur = null; // the session shown: { node, name, kind, alive(), cleanups: [], root }

    function isOpen() { return !!cur; }

    /** Close the viewer: everything decrypted for it goes (why: 'user' | 'lock' | 'escape'). */
    function close(why) {
      var s = cur;
      if (!s) return false;
      cur = null;
      s.closed = true;
      s.cleanups.splice(0).reverse().forEach(function (fn) { try { fn(); } catch (e) { /* best effort */ } });
      if (s.root && s.root.parentNode) s.root.parentNode.removeChild(s.root);
      document.removeEventListener('keydown', s.onKey, true);
      if (why !== 'lock' && s.focus && s.focus.focus) { try { s.focus.focus(); } catch (e) { /* gone */ } }
      return true;
    }

    function note(text, kind) { return h('div', { class: 'dp-vv-note' + (kind ? ' is-' + kind : '') }, [D.icon(kind === 'warn' ? 'info' : 'lock', 20), h('p', { text: text })]); }

    /**
     * "Herunterladen" — the one way out of the viewer: a decrypted copy on this computer, so it asks first, in the viewer
     * (the sandboxed frame may show no confirm()).
     */
    function downloadAct(s) {
      return D.btn(T('p.vv.download'), function () {
        D.touch();
        if (s.asking) return;
        var row = h('div', { class: 'dp-vv-ask', attrs: { role: 'alert' } }, [
          D.icon('info', 18), h('span', { text: T('p.vv.download_confirm') }),
          D.btn(T('p.cancel'), function () { s.asking = null; if (row.parentNode) row.parentNode.removeChild(row); }, { small: true }),
          D.btn(T('p.vv.download_go'), function () { s.asking = null; if (row.parentNode) row.parentNode.removeChild(row); D.download(s.node, s.content); }, { small: true, primary: true, icon: 'download' }),
        ]);
        s.asking = row;
        s.body.parentNode.insertBefore(row, s.body);
      }, { icon: 'download', small: true });
    }

    /** Open the viewer for vault file `node` (its decrypted `name`; `content`: a version's content answer). */
    function open(node, name, content) {
      close('user');
      var kind = kindOf(name);
      var s = { node: node, name: name, kind: kind, content: content || null, cleanups: [], closed: false, focus: document.activeElement };
      s.alive = function () { return !s.closed && cur === s; };
      var body = h('div', { class: 'dp-vv-body', attrs: { 'aria-live': 'polite' } });
      var tools = h('div', { class: 'dp-vv-tools' });
      var sub = h('p', { class: 'dp-dialog-sub', text: D.fmtSize(node.size) + ' · ' + T('p.vv.in_memory') });
      var box = h('div', { class: 'dp-dialog is-wide dp-vv', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': name } }, [
        h('div', { class: 'dp-vv-head' }, [
          h('div', { class: 'dp-vv-title' }, [h('h3', { text: name }), sub]),
          tools,
          D.lock ? D.ibtn('lock', T('p.vv.lock'), function () { D.lock(); }) : null,
          D.ibtn('close', T('p.close'), function () { close('user'); }),
        ]),
        body,
      ]);
      s.root = h('div', { class: 'dp-dialog-back dp-vv-back', attrs: { 'data-vault-viewer': '1' } }, box);
      // anything done in the viewer counts as use of the tab (the vault's lock timer starts again)
      ['pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart'].forEach(function (ev) { s.root.addEventListener(ev, function () { D.touch(); }, true); });
      s.root.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
      s.root.addEventListener('dragstart', function (ev) { ev.preventDefault(); });
      s.root.addEventListener('click', function (ev) { if (ev.target === s.root) close('user'); });
      s.onKey = function (ev) { if (ev.key === 'Escape' && cur === s) { ev.dpHandled = true; ev.stopPropagation(); close('escape'); } };
      document.addEventListener('keydown', s.onKey, true);
      document.body.appendChild(s.root);
      cur = s;
      s.body = body;
      s.tools = tools;

      var limit = limitOf(kind);
      if (kind === 'video') { body.appendChild(note(T('p.vv.video_note'))); tools.appendChild(downloadAct(s)); return s; }
      if (kind === 'office') { body.appendChild(note(T('p.vv.office_note'))); tools.appendChild(downloadAct(s)); return s; }
      if (kind === 'heic') { body.appendChild(note(T('p.vv.heic_note'))); tools.appendChild(downloadAct(s)); return s; }
      if (kind === 'other') { body.appendChild(note(T('p.vv.other_note'))); tools.appendChild(downloadAct(s)); return s; }
      if ((content && content.size ? content.size : node.size) > limit) {
        body.appendChild(note(T('p.vv.too_large', { max: Math.round(limit / MB) }), 'warn'));
        tools.appendChild(downloadAct(s));
        return s;
      }
      var wait = h('div', { class: 'dp-vv-wait' }, [h('span', { class: 'dp-vv-spin', attrs: { 'aria-hidden': 'true' } }), h('span', { text: T('p.v.decrypting') })]);
      body.appendChild(wait);
      D.decrypt(node, content, s.alive, function (done, total) { if (total) wait.lastChild.textContent = T('p.v.decrypting') + ' ' + Math.floor(done * 100 / total) + ' %'; })
        .then(function (parts) {
          if (!s.alive()) { wipeAll(parts); return; }
          s.cleanups.push(function () { wipeAll(parts); parts.length = 0; });
          if (wait.parentNode) wait.parentNode.removeChild(wait);
          if (kind === 'image') return showImage(s, parts);
          if (kind === 'pdf') return showPdf(s, parts);
          return showText(s, parts, kind === 'markdown');
        })
        .catch(function (e) {
          if (!s.alive()) return;
          if (wait.parentNode) wait.parentNode.removeChild(wait);
          body.appendChild(note(e && e.code === 'decrypt' ? T('p.v.unreadable') : (e && e.code === 'viewer_failed' ? T('p.vv.failed') : D.errText(e)), 'warn'));
          tools.appendChild(downloadAct(s));
        });
      return s;
    }

    // ── pictures ────────────────────────────────────────────

    function decodeImage(bytes, type) {
      // ImageDecoder (WebCodecs) reads the bytes directly: no Blob, no URL
      if (typeof window.ImageDecoder === 'function' && type !== 'image/svg+xml') {
        return Promise.resolve(window.ImageDecoder.isTypeSupported ? window.ImageDecoder.isTypeSupported(type) : true).then(function (ok) {
          if (!ok) return viaBitmap(bytes, type);
          var dec = new window.ImageDecoder({ data: bytes, type: type, preferAnimation: false });
          return dec.decode({ frameIndex: 0 }).then(function (r) {
            var f = r.image;
            return { source: f, width: f.displayWidth || f.codedWidth, height: f.displayHeight || f.codedHeight, orientation: type === 'image/jpeg' ? jpegOrientation(bytes) : 1,
              release: function () { try { f.close(); } catch (e) { /* closed */ } try { dec.close(); } catch (e) { /* closed */ } } };
          }, function () { try { dec.close(); } catch (e) { /* closed */ } return viaBitmap(bytes, type); });
        });
      }
      return viaBitmap(bytes, type);
    }
    function viaBitmap(bytes, type) {
      if (typeof window.createImageBitmap !== 'function') return Promise.reject(Object.assign(new Error('no decoder'), { code: 'viewer_failed' }));
      // an in-memory Blob of the picture (at most LIMITS.image) — never a URL of it
      var blob = new Blob([bytes], { type: type });
      return window.createImageBitmap(blob, { imageOrientation: 'from-image' }).then(function (bm) {
        blob = null;
        return { source: bm, width: bm.width, height: bm.height, orientation: 1, release: function () { try { bm.close(); } catch (e) { /* closed */ } } };
      });
    }

    function showImage(s, parts) {
      var type = IMAGE[extOf(s.name)] || 'image/png';
      var bytes = join(parts);
      wipeAll(parts);
      s.cleanups.push(function () { bytes.fill(0); });
      return decodeImage(bytes, type).then(function (img) {
        if (!s.alive()) { img.release(); return; }
        var o = img.orientation;
        var turned = o >= 5;
        var w = turned ? img.height : img.width;
        var hgt = turned ? img.width : img.height;
        var scale = Math.min(1, MAX_SIDE / Math.max(w, hgt, 1));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(hgt * scale));
        var canvas = h('canvas', { class: 'dp-vv-canvas', attrs: { width: String(cw), height: String(ch), role: 'img', 'aria-label': s.name } });
        canvas.width = cw;
        canvas.height = ch;
        var cx = canvas.getContext('2d');
        // EXIF orientations 2…8 (ImageDecoder does not turn the picture itself)
        var dw = (turned ? ch : cw);
        var dh = (turned ? cw : ch);
        var M = { 2: [-1, 0, 0, 1, cw, 0], 3: [-1, 0, 0, -1, cw, ch], 4: [1, 0, 0, -1, 0, ch], 5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, cw, 0], 7: [0, -1, -1, 0, cw, ch], 8: [0, -1, 1, 0, 0, ch] }[o];
        if (M) cx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
        cx.drawImage(img.source, 0, 0, dw, dh);
        img.release();
        bytes.fill(0);
        s.cleanups.push(function () { canvas.width = 0; canvas.height = 0; });
        var wrap = h('div', { class: 'dp-preview dp-vv-stage' }, canvas);
        s.body.appendChild(wrap);
        // zoom: fit (default), 100 %, larger and smaller
        var zoom = 0; // 0: fit
        var label = h('span', { class: 'dp-vv-zoom', text: T('p.vv.fit') });
        var apply = function () {
          if (!zoom) { canvas.style.width = ''; canvas.style.maxWidth = '100%'; canvas.style.maxHeight = '70vh'; label.textContent = T('p.vv.fit'); wrap.classList.remove('is-zoomed'); return; }
          canvas.style.maxWidth = 'none';
          canvas.style.maxHeight = 'none';
          canvas.style.width = Math.round(cw * zoom) + 'px';
          label.textContent = Math.round(zoom * 100 / scale) + ' %';
          wrap.classList.add('is-zoomed');
        };
        var fitted = function () { var r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null; return r && r.width ? r.width / cw : 1; };
        var step = function (f) { zoom = Math.max(0.05, Math.min(8, (zoom || fitted()) * f)); apply(); };
        s.tools.appendChild(D.btn('−', function () { step(1 / 1.25); }, { small: true, attrs: { 'aria-label': T('p.vv.zoom_out'), title: T('p.vv.zoom_out') } }));
        s.tools.appendChild(label);
        s.tools.appendChild(D.btn('+', function () { step(1.25); }, { small: true, attrs: { 'aria-label': T('p.vv.zoom_in'), title: T('p.vv.zoom_in') } }));
        s.tools.appendChild(D.btn(T('p.vv.fit'), function () { zoom = 0; apply(); }, { small: true }));
        s.tools.appendChild(downloadAct(s));
        canvas.addEventListener('dblclick', function () { zoom = zoom ? 0 : scale; apply(); });
        wrap.addEventListener('wheel', function (ev) { if (!ev.ctrlKey) return; ev.preventDefault(); step(ev.deltaY < 0 ? 1.15 : 1 / 1.15); });
        apply();
      });
    }

    // ── PDF ─────────────────────────────────────────────────

    function showPdf(s, parts) {
      var bytes = join(parts);
      wipeAll(parts);
      var doc = null;
      var task = null;
      s.cleanups.push(function () {
        try { if (task) task.destroy(); } catch (e) { /* gone */ }
        try { if (doc) doc.destroy(); } catch (e) { /* gone */ }
        try { if (bytes.buffer.byteLength) bytes.fill(0); } catch (e) { /* handed to pdf.js */ }
      });
      var wait = h('div', { class: 'dp-vv-wait' }, [h('span', { class: 'dp-vv-spin', attrs: { 'aria-hidden': 'true' } }), h('span', { text: T('p.vv.pdf_loading') })]);
      s.body.appendChild(wait);
      return loadPdfjs(D.api).then(function (lib) {
        if (!s.alive()) return null;
        task = lib.getDocument({
          data: bytes,
          // nothing from the network (the frame has none anyway) and no scripts of the PDF
          isEvalSupported: false, enableXfa: false, disableAutoFetch: true, disableStream: true, disableRange: true,
          useSystemFonts: true, isOffscreenCanvasSupported: false, stopAtErrors: false, verbosity: 0,
        });
        return task.promise;
      }).then(function (d) {
        if (!d) return;
        if (!s.alive()) { try { d.destroy(); } catch (e) { /* gone */ } return; }
        doc = d;
        var L = window.pdfjsLib;
        if (wait.parentNode) wait.parentNode.removeChild(wait);
        var pages = h('div', { class: 'dp-vv-pages' });
        s.body.appendChild(pages);
        var count = h('span', { class: 'dp-vv-zoom', text: T('p.vv.pages', { n: d.numPages }) });
        s.tools.appendChild(count);
        s.tools.appendChild(downloadAct(s));
        var slots = [];
        var canvases = [];
        s.cleanups.push(function () { canvases.forEach(function (c) { c.width = 0; c.height = 0; }); canvases.length = 0; });
        var width = Math.max(320, Math.min(1600, (pages.clientWidth || 800) - 8));
        var ratio = Math.min(2, window.devicePixelRatio || 1);
        var busy = Promise.resolve();
        var render = function (i) {
          if (slots[i].done) return busy;
          slots[i].done = true;
          busy = busy.then(function () {
            if (!s.alive()) return null;
            return d.getPage(i + 1).then(function (page) {
              if (!s.alive()) return null;
              var base = page.getViewport({ scale: 1 });
              var vp = page.getViewport({ scale: (width / base.width) * ratio });
              var c = h('canvas', { class: 'dp-vv-page', attrs: { role: 'img', 'aria-label': T('p.vv.page', { n: i + 1 }) } });
              c.width = Math.floor(vp.width);
              c.height = Math.floor(vp.height);
              c.style.width = Math.floor(vp.width / ratio) + 'px';
              canvases.push(c);
              var slot = slots[i].el;
              while (slot.firstChild) slot.removeChild(slot.firstChild);
              slot.appendChild(c);
              slot.style.minHeight = '';
              return page.render({ canvasContext: c.getContext('2d'), viewport: vp, annotationMode: L.AnnotationMode ? L.AnnotationMode.ENABLE : 1 }).promise.then(function () { page.cleanup(); });
            });
          }).catch(function () { /* one page that cannot be shown */ });
          return busy;
        };
        for (var i = 0; i < d.numPages; i++) {
          var el = h('div', { class: 'dp-vv-slot', attrs: { 'data-page': String(i + 1) } });
          el.style.minHeight = Math.round(width * 1.3) + 'px';
          slots.push({ el: el, done: false });
          pages.appendChild(el);
        }
        if (typeof window.IntersectionObserver === 'function') {
          var io = new window.IntersectionObserver(function (entries) {
            entries.forEach(function (en) {
              if (!en.isIntersecting) return;
              var n = Number(en.target.getAttribute('data-page')) - 1;
              for (var k = n; k <= Math.min(d.numPages - 1, n + MAX_PAGES_AHEAD); k++) render(k);
            });
          }, { root: s.root, rootMargin: '400px 0px' });
          slots.forEach(function (x) { io.observe(x.el); });
          s.cleanups.push(function () { io.disconnect(); });
        }
        // the first pages at once
        for (var k = 0; k < Math.min(d.numPages, 1 + MAX_PAGES_AHEAD); k++) render(k);
      }).catch(function (e) {
        if (!s.alive()) return;
        if (wait.parentNode) wait.parentNode.removeChild(wait);
        s.body.appendChild(note(e && e.name === 'PasswordException' ? T('p.vv.pdf_password') : T('p.vv.failed'), 'warn'));
        s.tools.appendChild(downloadAct(s));
      });
    }

    // ── text ────────────────────────────────────────────────

    function showText(s, parts, md) {
      var bytes = join(parts);
      wipeAll(parts);
      var text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      bytes.fill(0);
      var box = md ? h('div', { class: 'dp-vv-md' }, markdown(h, text)) : h('pre', { class: 'dp-vv-text', text: text });
      text = null;
      s.body.appendChild(box);
      s.tools.appendChild(downloadAct(s));
      s.cleanups.push(function () { while (box.firstChild) box.removeChild(box.firstChild); box.textContent = ''; });
    }

    return { open: open, close: close, isOpen: isOpen, kindOf: kindOf, LIMITS: LIMITS, _cur: function () { return cur; } };
  }

  var api = { attach: attach, kindOf: kindOf, markdown: markdown, jpegOrientation: jpegOrientation, LIMITS: LIMITS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DriveVaultView = api;
}());
