/* Portal tab "Drucken & Scannen" (phone first, targets ≥ 44 px): scan into Drive with the AI's name, print from anywhere. */
(function () {
  'use strict';
  var P = window.PR;
  var T = P.T, el = P.el, $ = P.$;
  var S = null;            // overview
  var sess = null;         // open scan session
  var media = null;        // uploaded file { mediaId, name }
  var copies = 1;
  var opt = { source: null, mode: 'document' };
  var poll = null;

  function tab(which) {
    ['scan', 'print'].forEach(function (k) {
      var on = k === which;
      $('#pr-tab-' + k).setAttribute('aria-selected', on ? 'true' : 'false');
      $('#pr-' + k).hidden = !on;
    });
  }
  $('#pr-tab-scan').addEventListener('click', function () { tab('scan'); });
  $('#pr-tab-print').addEventListener('click', function () { tab('print'); });

  function seg(box, items, cur, onPick) {
    P.clear(box);
    items.forEach(function (it) {
      box.appendChild(el('button', { type: 'button', 'data-v': it.v, 'aria-pressed': it.v === cur ? 'true' : 'false', on: { click: function () { onPick(it.v); } } }, [it.label, it.sub ? el('small', { text: it.sub }) : null]));
    });
  }

  function scanner() { return (S.scanners || []).find(function (d) { return d.id === $('#pr-scanner').value; }) || (S.scanners || [])[0] || null; }
  function printer() { return (S.printers || []).find(function (d) { return d.id === $('#pr-printer').value; }) || (S.printers || [])[0] || null; }

  function drawScanSetup() {
    var d = scanner();
    $('#pr-no-scanner').hidden = !!d;
    $('#pr-scan-setup').hidden = !d || !!sess;
    if (!d) return;
    var sc = d.scanner;
    var src = [];
    if (sc.feeder) src.push({ v: 'feeder', label: T('portal.src_feeder'), sub: T('portal.src_feeder_d') });
    if (sc.platen) src.push({ v: 'platen', label: T('portal.src_platen') });
    if (!opt.source || !src.some(function (x) { return x.v === opt.source; })) opt.source = sc.feeder && sc.adf === 'loaded' ? 'feeder' : (src[src.length - 1] || {}).v;
    seg($('#pr-source'), src, opt.source, function (v) { opt.source = v; drawScanSetup(); });
    seg($('#pr-mode'), [{ v: 'document', label: T('portal.mode_doc'), sub: T('portal.mode_doc_d') }, { v: 'photo', label: T('portal.mode_photo'), sub: T('portal.mode_photo_d') }], opt.mode, function (v) { opt.mode = v; drawScanSetup(); });
    var where = (S.target.area === 'family' ? T('portal.drive_family') : T('portal.drive_mine')) + ' › ' + S.target.folder + (S.ai ? ' · ' + T('portal.ai_sorts') : '');
    $('#pr-target').textContent = T('portal.target', { where: where });
    $('#pr-no-drive').hidden = !!S.drive;
    $('#pr-scan-go').disabled = !d.online || !S.drive;
  }

  function drawSession() {
    $('#pr-session').hidden = !sess;
    $('#pr-scan-setup').hidden = !!sess || !scanner();
    if (!sess) return;
    var n = sess.pages.length;
    $('#pr-sess-count').textContent = T(n === 1 ? 'portal.scanned_one' : 'portal.scanned', { n: n });
    $('#pr-sess-spin').hidden = !sess.scanning;
    var box = P.clear($('#pr-pages'));
    sess.pages.forEach(function (p) {
      var u = P.thumbUrl(p.thumb);
      box.appendChild(el('div', { class: 'pr-pagebox' }, [
        u ? el('img', { src: u, alt: T('portal.page', { n: p.n }) }) : el('div', { class: 'pr-noimg', text: T('portal.page', { n: p.n }) }),
        el('span', { text: String(p.n) }),
        sess.scanning ? null : el('button', { type: 'button', 'aria-label': T('portal.remove_page', { n: p.n }), text: '×', on: { click: function () {
          P.api('POST', 'scan/' + sess.id + '/remove-page', { n: p.n }).then(function (r) { sess = r.scan; drawSession(); suggest(); }).catch(P.warn);
        } } }),
      ]));
    });
    var err = $('#pr-sess-err');
    err.hidden = !sess.error;
    err.textContent = sess.error ? T('serr.' + sess.error) : '';
    var s = sess.suggestion;
    var sg = $('#pr-suggest');
    sg.hidden = !s;
    if (s) {
      P.clear(sg);
      sg.append(T('portal.ai'), ' ', el('strong', { text: s.name }), s.where ? ' ' + T('portal.in') + ' ' : '', s.where ? el('strong', { text: s.where }) : '');
      if (!$('#pr-name').dataset.touched) $('#pr-name').value = s.name;
    } else if (!$('#pr-name').value) $('#pr-name').value = S.defaultName;
    // searchable PDF: offered when a gateway with „Texterkennung“ is online
    $('#pr-ocr-row').hidden = !S.ocr || sess.state === 'ocr';
    var busy = $('#pr-ocr-busy');
    busy.hidden = sess.state !== 'ocr';
    if (sess.state === 'ocr') {
      P.clear(busy).append(el('span', { class: 'pr-spin', 'aria-hidden': 'true' }), ' ',
        sess.ocr && sess.ocr.pages ? T('portal.ocr_running', { page: Math.min(sess.ocr.page + 1, sess.ocr.pages), pages: sess.ocr.pages }) : T('portal.ocr_wait'));
    }
    $('#pr-more').disabled = sess.scanning || sess.state === 'ocr';
    $('#pr-save').disabled = sess.scanning || !n || sess.state === 'ocr';
    $('#pr-discard').disabled = sess.state === 'ocr';
  }

  /** The session was filed: the toast says where — and whether it is searchable. */
  function savedToast(sc) {
    var where = sc.savedWhere || sc.savedName;
    if (sc.searchable === true) P.toast(T('portal.saved_ocr', { where: where }));
    else if (sc.searchable === false) P.toast(T('portal.saved_no_ocr', { where: where, why: T('ocrerr.' + (sc.ocrError || 'ocr_failed')) }), 'warn');
    else P.toast(T('portal.saved', { where: where }));
    sess = null;
    $('#pr-name').value = '';
    delete $('#pr-name').dataset.touched;
    $('#pr-ocr').checked = false;
    drawSession(); drawScanSetup();
  }

  function watch() {
    clearTimeout(poll);
    if (!sess || (!sess.scanning && sess.state !== 'ocr')) return;
    poll = setTimeout(function () {
      P.api('GET', 'scan/' + sess.id).then(function (r) {
        var was = sess.scanning;
        sess = r.scan;
        if (sess.state === 'saved') { savedToast(sess); return; }
        drawSession();
        if (was && !sess.scanning) suggest();
        watch();
      }).catch(function (e) { P.warn(e); poll = setTimeout(watch, 4000); });
    }, sess.state === 'ocr' ? 3000 : 2000);
  }

  function suggest() {
    if (!sess || !sess.pages.length || !S.ai || sess.suggestion) return;
    var sg = $('#pr-suggest');
    sg.hidden = false;
    P.clear(sg).append(el('span', { class: 'pr-spin', 'aria-hidden': 'true' }), ' ', T('portal.ai_wait'));
    P.api('POST', 'scan/' + sess.id + '/suggest').then(function (r) { sess.suggestion = r.suggestion; drawSession(); }).catch(function () { sess.suggestion = null; drawSession(); });
  }

  function startScan(more) {
    var b = more ? $('#pr-more') : $('#pr-scan-go');
    b.disabled = true;
    var body = more ? { source: opt.source, mode: opt.mode } : { deviceId: scanner().id, source: opt.source, mode: opt.mode };
    P.api('POST', more ? 'scan/' + sess.id + '/more' : 'scan', body).then(function (r) { sess = r.scan; drawSession(); watch(); }).catch(P.warn).then(function () { b.disabled = false; });
  }
  $('#pr-scan-go').addEventListener('click', function () { startScan(false); });
  $('#pr-more').addEventListener('click', function () { startScan(true); });
  $('#pr-name').addEventListener('input', function () { $('#pr-name').dataset.touched = '1'; });
  $('#pr-save').addEventListener('click', function () {
    var b = $('#pr-save');
    b.disabled = true;
    var name = $('#pr-name').value.trim();
    var searchable = !!S.ocr && $('#pr-ocr').checked;
    P.api('POST', 'scan/' + sess.id + '/save', { name: name, searchable: searchable }).then(function (r) {
      if (r.scan.state === 'ocr') { sess = r.scan; drawSession(); watch(); return; }
      savedToast(r.scan);
    }).catch(function (e) { P.warn(e); b.disabled = false; });
  });
  $('#pr-discard').addEventListener('click', function () {
    P.confirmDialog(T('portal.discard_q'), T('portal.discard')).then(function (ok) {
      if (!ok) return null;
      return P.api('POST', 'scan/' + sess.id + '/discard').then(function () { sess = null; drawSession(); drawScanSetup(); });
    }).catch(P.warn);
  });

  // ── Drucken ──
  function drawPrint() {
    var d = printer();
    $('#pr-no-printer').hidden = !!d;
    var p = d && d.printer;
    var col = $('#pr-color');
    col.disabled = !p || !p.color || S.rights.bwOnly;
    if (col.disabled) col.checked = false;
    col.parentNode.title = S.rights.bwOnly ? T('portal.bw_only') : (p && !p.color ? T('portal.bw_printer') : '');
    var dup = $('#pr-duplex');
    dup.disabled = !p || !p.duplex;
    if (dup.disabled) dup.checked = false;
    // paper and tray: only what the printer names (none named: its own default, nothing to choose)
    var mv = (p && p.media) || { sizes: [], sources: [] };
    var paperSel = $('#pr-media');
    var traySel = $('#pr-tray');
    fillPaper(paperSel, mv.sizes || [], mv.default, P.paperName);
    fillPaper(traySel, mv.sources || [], mv.sourceDefault, P.trayName, true);
    $('#pr-media-row').hidden = (mv.sizes || []).length < 2;
    $('#pr-source-row').hidden = (mv.sources || []).length < 2;
    $('#pr-paper-row').hidden = $('#pr-media-row').hidden && $('#pr-source-row').hidden;
    // an office file for a printer whose gateway does not convert them: say so before printing
    var on = $('#pr-office-note');
    on.hidden = !(media && media.office && p && !p.office);
    on.textContent = on.hidden ? '' : T('portal.office_no');
    var max = p ? p.copiesMax : 1;
    copies = Math.max(1, Math.min(copies, max));
    $('#pr-copies').textContent = String(copies);
    $('#pr-copies-minus').disabled = copies <= 1;
    $('#pr-copies-plus').disabled = copies >= max;
    var lim = $('#pr-limit');
    lim.hidden = S.pagesLeft == null && !S.rights.bwOnly;
    lim.textContent = [S.pagesLeft != null ? T('portal.left', { n: S.pagesLeft }) : null, S.rights.bwOnly ? T('portal.bw_only') : null].filter(Boolean).join(' · ');
    $('#pr-print-go').disabled = !d || !media || (media.office && p && !p.office);
    var jobsBox = P.clear($('#pr-jobs'));
    $('#pr-jobs-h').hidden = !(S.jobs || []).length;
    (S.jobs || []).forEach(function (j) {
      var why = P.jobReason(j);
      jobsBox.appendChild(el('div', { class: 'pr-hist' }, [
        P.jobBadge(j),
        el('div', { class: 'pr-hist-main' }, [el('div', { text: j.name }), el('div', { class: 'pr-sub', text: [j.device, why].filter(Boolean).join(' · ') })]),
        el('span', { class: 'pr-hist-when', text: P.when(j.at) }),
        j.open && (j.state === 'queued' || j.state === 'waiting') ? el('button', { class: 'btn', type: 'button', text: T('portal.cancel'), on: { click: function () { P.api('POST', 'jobs/' + encodeURIComponent(j.id) + '/cancel').then(load).catch(P.warn); } } }) : null,
      ]));
    });
  }
  $('#pr-copies-minus').addEventListener('click', function () { copies -= 1; drawPrint(); });
  $('#pr-copies-plus').addEventListener('click', function () { copies += 1; drawPrint(); });
  $('#pr-printer').addEventListener('change', drawPrint);
  $('#pr-scanner').addEventListener('change', drawScanSetup);
  /**
   * The type of a file by its first bytes: a PDF the phone hands over without a type or under a name without ".pdf"
   * is still a PDF (else GateControl would refuse the upload). → a promise of the type or null.
   */
  var PRINTABLE = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'text/plain'];
  // office files (GateControl ≥ 1.246.0, a gateway with „Office-Dateien drucken“): by the name when the phone names no type
  var OFFICE = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation', rtf: 'application/rtf',
  };
  function officeType(f) {
    var m = /\.([a-z]{3,4})$/i.exec(f.name || '');
    var byName = m ? OFFICE[m[1].toLowerCase()] : null;
    var t = String(f.type || '').toLowerCase();
    if (t === 'text/rtf') t = 'application/rtf';
    return Object.keys(OFFICE).some(function (k) { return OFFICE[k] === t; }) ? t : byName;
  }
  function fillPaper(sel, list, dflt, name, tray) {
    var cur = sel.value;
    P.clear(sel);
    if (tray) sel.appendChild(el('option', { value: '', text: T('portal.tray_auto') }));
    list.forEach(function (v) { sel.appendChild(el('option', { value: v, text: name(v), selected: cur ? v === cur : v === dflt })); });
  }
  function sniffType(f) {
    if (!f || typeof f.slice !== 'function') return Promise.resolve(null);
    var part = f.slice(0, 1024);
    var read = typeof part.arrayBuffer === 'function' ? part.arrayBuffer() : new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = reject;
      r.readAsArrayBuffer(part);
    });
    return read.then(function (buf) {
      var u = new Uint8Array(buf);
      var s = '';
      for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
      if (s.indexOf('%PDF-') >= 0) return 'application/pdf';
      if (u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return 'image/jpeg';
      if (s.slice(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
      if (s.slice(0, 4) === 'RIFF' && s.slice(8, 12) === 'WEBP') return 'image/webp';
      if (s.slice(4, 8) === 'ftyp') return /^(heic|heix|hevc|hevx)$/.test(s.slice(8, 12)) ? 'image/heic' : (/^(mif1|msf1)$/.test(s.slice(8, 12)) ? 'image/heif' : null);
      return null;
    }).catch(function () { return null; });
  }
  /** The file to upload: with the type its content shows when the phone's type is missing or not a printable one. */
  function typed(f) {
    var off = officeType(f);
    if (off) return Promise.resolve(off === f.type ? f : new Blob([f], { type: off }));
    if (PRINTABLE.indexOf(String(f.type || '').toLowerCase()) >= 0 && f.type !== 'application/pdf') return Promise.resolve(f);
    if (/\.txt$/i.test(f.name || '') && !f.type) return Promise.resolve(new Blob([f], { type: 'text/plain' }));
    return sniffType(f).then(function (t) { return t && t !== f.type ? new Blob([f], { type: t }) : f; });
  }
  $('#pr-file-in').addEventListener('change', function () {
    var f = $('#pr-file-in').files && $('#pr-file-in').files[0];
    if (!f) return;
    media = null;
    drawPrint();
    var name = $('#pr-file-name');
    name.textContent = T('portal.uploading', { name: f.name, pct: 0 });
    if (!window.GC || typeof window.GC.upload !== 'function') { P.toast(T('common.error'), 'error'); return; }
    typed(f).then(function (file) { return window.GC.upload(file, { onProgress: function (p) { if (p && p.total) name.textContent = T('portal.uploading', { name: f.name, pct: Math.round((p.loaded / p.total) * 100) }); } }); })
      .then(function (r) { media = { mediaId: r.mediaId, name: f.name, office: !!officeType(f) }; name.textContent = f.name; drawPrint(); })
      .catch(function (e) { name.textContent = T('portal.no_file'); P.toast(e && e.code === 'unsupported_type' ? T('error.format') : (e && e.code === 'too_large' ? T('error.too_large') : P.errText(e)), 'error'); });
  });
  $('#pr-print-go').addEventListener('click', function () {
    var b = $('#pr-print-go');
    b.disabled = true;
    var paper = $('#pr-media-row').hidden ? null : $('#pr-media').value || null;
    var tray = $('#pr-source-row').hidden ? null : $('#pr-tray').value || null;
    P.api('POST', 'print', { deviceId: printer().id, mediaId: media.mediaId, name: media.name, copies: copies, color: $('#pr-color').checked, duplex: $('#pr-duplex').checked, media: paper, source: tray })
      .then(function () { P.toast(T('portal.printed')); media = null; $('#pr-file-in').value = ''; $('#pr-file-name').textContent = T('portal.no_file'); return load(); })
      .catch(function (e) { P.warn(e); b.disabled = false; });
  });

  function fillSelect(sel, list) {
    var cur = sel.value;
    P.clear(sel);
    list.forEach(function (d) { sel.appendChild(el('option', { value: d.id, text: d.name + (d.online ? '' : ' · ' + T('portal.off')), selected: d.id === cur })); });
    sel.parentNode.hidden = list.length < 2;
  }

  function load() {
    return P.api('GET', 'overview').then(function (r) {
      S = r;
      $('#pr-loading').hidden = true;
      $('#pr-tab-scan').hidden = !r.rights.scan;
      $('#pr-tab-print').hidden = !r.rights.print;
      $('#pr-tabs').hidden = !(r.rights.scan && r.rights.print);
      var any = (r.printers || []).concat(r.scanners || []).some(function (d) { return d.online; });
      var home = $('#pr-home');
      home.hidden = !(r.printers || []).length && !(r.scanners || []).length;
      home.textContent = any ? T('portal.reachable') : T('portal.unreachable');
      home.setAttribute('data-tone', any ? 'good' : 'warn');
      fillSelect($('#pr-scanner'), r.scanners || []);
      fillSelect($('#pr-printer'), r.printers || []);
      sess = r.scan || sess;
      if (sess && sess.state !== 'open' && sess.state !== 'ocr') sess = null;
      var shown = $('#pr-tab-print').getAttribute('aria-selected') === 'true' && r.rights.print ? 'print' : (r.rights.scan ? 'scan' : 'print');
      tab(shown);
      drawScanSetup(); drawSession(); drawPrint();
      watch();
      if (sess && !sess.scanning) suggest();
    }).catch(function (e) { $('#pr-loading').textContent = P.errText(e); });
  }
  load();
})();
