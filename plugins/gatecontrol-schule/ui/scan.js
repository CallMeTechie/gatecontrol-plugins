/* Adding a WebUntis account (1.3.0), shared by the settings (page 'setup') and the profile section:
   1. „QR-Code scannen“ — the camera (getUserMedia; GateControl ≥ 1.188.0 allows it with plugin.json
      ui.camera) reads the WebUntis QR code (untis://setschool?…) directly;
   2. „QR-Bild hochladen“ — a screenshot or photo of the QR code, read in the browser;
   3. „Manuell eingeben“ — server, school, user and key or password;
   and, small, „Link einfügen“ for the untis:// link itself.
   Reading uses the browser's BarcodeDetector where there is one, else the vendored jsQR
   (ui/vendor/jsqr, Apache-2.0), which the frame asks the plugin for only then (GET qr-decoder) and runs
   as an inline script. Nothing leaves the browser but the link that was read, to the plugin.
   Manual test (camera and image decoding need a real browser; the automated tests cover the API):
   GateControl ≥ 1.188.0 over HTTPS › Einstellungen › Plugins › Schule › Einstellungen › „WebUntis-Konto
   hinzufügen“ › „QR-Code scannen“: the browser asks for the camera, the QR code shown by WebUntis is read
   within a second or two and the account is added; denying the camera shows the hint to upload a picture.
   „QR-Bild hochladen“ with a screenshot of the QR code: added. Repeat in Firefox/Safari (no
   BarcodeDetector → jsQR is fetched once) and on a phone (rear camera), and in the portal under „Meine
   Geräte“ › „WebUntis“ with a student account. On GateControl < 1.188.0 the camera tile is hidden
   (no allow="camera"); upload and manual entry still work. */
(function () {
  'use strict';
  var S = window.SC, T = S.T, el = S.el;
  var ID = 'sc-add-modal';
  var decoderPath = S.CTX.view === 'portal' ? 'portal/qr-decoder' : 'qr-decoder';
  var cur = null; // { opts, step, stream, timer, busy }

  // ── reading QR codes ─────────────────────────────────────────────────────
  var detectorP = null;
  function detector() {
    if (!detectorP) {
      detectorP = Promise.resolve().then(function () {
        if (typeof window.BarcodeDetector !== 'function') return null;
        var fmts = typeof window.BarcodeDetector.getSupportedFormats === 'function' ? window.BarcodeDetector.getSupportedFormats() : Promise.resolve(['qr_code']);
        return fmts.then(function (f) { return f.indexOf('qr_code') >= 0 ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null; });
      }).catch(function () { return null; });
    }
    return detectorP;
  }
  var jsqrP = null;
  function jsqr() {
    if (typeof window.jsQR === 'function') return Promise.resolve(window.jsQR);
    if (!jsqrP) {
      jsqrP = S.api('GET', decoderPath).then(function (r) {
        var s = document.createElement('script');
        s.textContent = String((r && r.js) || '');
        document.head.appendChild(s);
        if (typeof window.jsQR !== 'function') throw new Error('decoder');
        return window.jsQR;
      }).catch(function (e) { jsqrP = null; throw e; });
    }
    return jsqrP;
  }
  /** Read a QR code from a video frame / bitmap / image → its text, or null. */
  function readFrom(source, w, h) {
    return detector().then(function (d) {
      if (d) return d.detect(source).then(function (codes) { return codes && codes.length ? String(codes[0].rawValue || '') : null; });
      return jsqr().then(function (decode) {
        var scale = Math.min(1, 1280 / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));
        var c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        var g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(source, 0, 0, cw, ch);
        var img = g.getImageData(0, 0, cw, ch);
        var code = decode(img.data, cw, ch, { inversionAttempts: 'attemptBoth' });
        return code ? String(code.data || '') : null;
      });
    });
  }
  function bitmapOf(file) {
    if (typeof window.createImageBitmap === 'function') return window.createImageBitmap(file);
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { var i = new Image(); i.onload = function () { resolve(i); }; i.onerror = reject; i.src = String(fr.result); };
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }
  function isUntis(text) { return /^untis:\/\/setschool\?/i.test(String(text || '').trim()); }

  function cameraPossible() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') return false;
    // an older GateControl does not allow the camera in the frame (no allow="camera")
    try { if (document.featurePolicy && typeof document.featurePolicy.allowsFeature === 'function' && !document.featurePolicy.allowsFeature('camera')) return false; } catch (_) { /* unknown */ }
    return true;
  }

  // ── the dialog ───────────────────────────────────────────────────────────
  function stopCamera() {
    if (!cur) return;
    if (cur.timer) { clearTimeout(cur.timer); cur.timer = null; }
    if (cur.stream) { cur.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) { /* gone */ } }); cur.stream = null; }
  }
  function msg(text, tone) { var m = document.getElementById('sc-add-msg'); if (m) { m.textContent = text || ''; m.setAttribute('data-tone', tone || ''); } }

  function submit(body) {
    if (!cur || cur.busy) return;
    cur.busy = true;
    stopCamera();
    msg(T('account.checking'));
    S.$$('#' + ID + ' button').forEach(function (b) { if (!b.hasAttribute('data-close')) b.disabled = true; });
    Promise.resolve(cur.opts.onSubmit(body)).then(function () {
      S.closeModal(ID);
    }).catch(function (e) {
      if (!cur) return;
      cur.busy = false;
      S.$$('#' + ID + ' button').forEach(function (b) { b.disabled = false; });
      msg(S.errText(e), 'error');
    });
  }

  function tile(icon, title, sub, onClick, id) {
    return el('button', { type: 'button', class: 'pick', id: id || null, on: { click: onClick } }, [
      el('span', { class: 'pick-ic' }, [S.svg(icon, 22)]),
      el('span', { class: 'pick-text' }, [el('b', { text: title }), el('small', { text: sub })]),
    ]);
  }

  function body() { return S.clear(document.getElementById('sc-add-body')); }
  function back() { return el('button', { type: 'button', class: 'btn btn-ghost btn-sm sc-back', text: '‹ ' + T('scan.back'), on: { click: function () { stopCamera(); step('choose'); } } }); }

  function step(name) {
    if (!cur) return;
    cur.step = name;
    msg('');
    var b = body();
    if (name === 'choose') {
      if (cur.opts.intro) b.appendChild(el('p', { class: 'hint sc-intro', text: cur.opts.intro }));
      var tiles = el('div', { class: 'picks' });
      if (cameraPossible()) tiles.appendChild(tile(S.ICON.camera, T('scan.camera'), T('scan.camera_sub'), function () { step('camera'); }, 'sc-pick-camera'));
      tiles.appendChild(tile(S.ICON.image, T('scan.upload'), T('scan.upload_sub'), function () { step('upload'); }, 'sc-pick-upload'));
      tiles.appendChild(tile(S.ICON.keyboard, T('scan.manual'), T('scan.manual_sub'), function () { step('manual'); }, 'sc-pick-manual'));
      b.appendChild(tiles);
      b.appendChild(el('div', { class: 'sc-where' }, [el('b', { text: T('scan.where_title') }), el('span', { text: ' ' + T('scan.where') })]));
      b.appendChild(el('p', { class: 'hint' }, [el('button', { type: 'button', class: 'btn-link', id: 'sc-pick-link', text: T('scan.paste'), on: { click: function () { step('link'); } } })]));
    } else if (name === 'camera') {
      var video = el('video', { class: 'sc-video', playsinline: true, muted: true, autoplay: true });
      video.muted = true;
      b.appendChild(back());
      b.appendChild(el('div', { class: 'sc-viewport' }, [video, el('span', { class: 'sc-frame', 'aria-hidden': 'true' })]));
      b.appendChild(el('p', { class: 'hint', text: T('scan.camera_hint') }));
      msg(T('scan.camera_starting'));
      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }).then(function (stream) {
        if (!cur || cur.step !== 'camera') { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        cur.stream = stream;
        video.srcObject = stream;
        var p = video.play();
        if (p && p.catch) p.catch(function () { /* autoplay */ });
        msg(T('scan.camera_looking'));
        var tick = function () {
          if (!cur || cur.step !== 'camera' || !cur.stream) return;
          var w = video.videoWidth, h = video.videoHeight;
          var go = w && h ? readFrom(video, w, h) : Promise.resolve(null);
          go.then(function (text) {
            if (!cur || cur.step !== 'camera') return;
            if (text && isUntis(text)) { submit({ mode: 'qr', link: text.trim() }); return; }
            if (text) msg(T('scan.not_untis'), 'error');
            cur.timer = setTimeout(tick, 300);
          }).catch(function () { if (cur && cur.step === 'camera') cur.timer = setTimeout(tick, 600); });
        };
        cur.timer = setTimeout(tick, 400);
      }).catch(function (e) {
        var n = e && e.name;
        msg(n === 'NotAllowedError' || n === 'SecurityError' ? T('scan.camera_denied') : (n === 'NotFoundError' || n === 'OverconstrainedError' ? T('scan.camera_none') : T('scan.camera_failed')), 'error');
      });
    } else if (name === 'upload') {
      var input = el('input', { type: 'file', accept: 'image/*', id: 'sc-file', class: 'sr' });
      var drop = el('label', { class: 'sc-drop', for: 'sc-file' }, [S.svg(S.ICON.image, 26), el('b', { text: T('scan.upload_choose') }), el('small', { text: T('scan.upload_hint') })]);
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (!f) return;
        if (f.size > 15 * 1024 * 1024) { msg(T('scan.too_big'), 'error'); return; }
        msg(T('scan.reading'));
        bitmapOf(f).then(function (bmp) { return readFrom(bmp, bmp.width, bmp.height); }).then(function (text) {
          input.value = '';
          if (!text) { msg(T('scan.none_found'), 'error'); return; }
          if (!isUntis(text)) { msg(T('scan.not_untis'), 'error'); return; }
          submit({ mode: 'qr', link: text.trim() });
        }).catch(function () { input.value = ''; msg(T('scan.read_failed'), 'error'); });
      });
      b.appendChild(back());
      b.appendChild(input);
      b.appendChild(drop);
    } else if (name === 'manual') {
      var mode = 'secret';
      var field = function (id, label, attrs) {
        return el('div', { class: 'form-group' }, [el('label', { class: 'form-label', for: id, text: label }), el('input', Object.assign({ class: 'form-input', id: id, type: 'text', autocomplete: 'off', spellcheck: 'false' }, attrs || {}))]);
      };
      var seg = el('div', { class: 'seg', role: 'tablist' });
      var keyBox = field('sc-m-key', T('field.key'), { type: 'password', maxlength: '200' });
      var pwBox = field('sc-m-pass', T('field.password'), { type: 'password', maxlength: '500', autocomplete: 'new-password' });
      pwBox.hidden = true;
      [['secret', T('scan.with_key')], ['password', T('scan.with_password')]].forEach(function (m) {
        seg.appendChild(el('button', { type: 'button', class: 'seg-btn', role: 'tab', 'aria-selected': String(m[0] === mode), text: m[1], on: { click: function (ev) {
          mode = m[0];
          S.$$('.seg-btn', seg).forEach(function (x) { x.setAttribute('aria-selected', String(x === ev.currentTarget)); });
          keyBox.hidden = mode !== 'secret'; pwBox.hidden = mode !== 'password';
        } } }));
      });
      var form = el('form', { class: 'sc-manual', novalidate: true, autocomplete: 'off' }, [
        el('p', { class: 'hint', text: T('scan.manual_hint') }),
        el('div', { class: 'form-row' }, [field('sc-m-host', T('field.host'), { placeholder: 'xyz.webuntis.com', maxlength: '253', 'data-autofocus': true }), field('sc-m-school', T('field.school'), { maxlength: '120' })]),
        field('sc-m-user', T('field.user'), { maxlength: '120' }),
        el('div', { class: 'form-group' }, [seg]),
        keyBox, pwBox,
        el('div', { class: 'sc-actions' }, [el('button', { type: 'submit', class: 'btn btn-primary', text: cur.opts.submitLabel || T('account.connect') })]),
      ]);
      var v = function (id) { return (document.getElementById(id) || {}).value || ''; };
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var o = { mode: mode, host: v('sc-m-host'), school: v('sc-m-school'), username: v('sc-m-user') };
        if (mode === 'secret') o.secret = v('sc-m-key'); else o.password = v('sc-m-pass');
        submit(o);
      });
      b.appendChild(back());
      b.appendChild(form);
      if (cur.opts.preset) {
        ['host', 'school', 'user'].forEach(function (k) { var n = document.getElementById('sc-m-' + k); if (n) n.value = cur.opts.preset[k === 'user' ? 'username' : k] || ''; });
      }
    } else if (name === 'link') {
      var ta = el('textarea', { class: 'form-input', id: 'sc-l-link', spellcheck: 'false', autocomplete: 'off', placeholder: 'untis://setschool?url=…&school=…&user=…&key=…' });
      var lf = el('form', { novalidate: true }, [
        el('div', { class: 'form-group' }, [el('label', { class: 'form-label', for: 'sc-l-link', text: T('qr.link') }), ta, el('span', { class: 'form-hint', text: T('scan.paste_hint') })]),
        el('div', { class: 'sc-actions' }, [el('button', { type: 'submit', class: 'btn btn-primary', text: cur.opts.submitLabel || T('account.connect') })]),
      ]);
      lf.addEventListener('submit', function (e) { e.preventDefault(); submit({ mode: 'qr', link: ta.value.trim() }); });
      b.appendChild(back());
      b.appendChild(lf);
    }
  }

  function ensureModal() {
    var m = document.getElementById(ID);
    if (m) return m;
    m = el('div', { class: 'modal-overlay', id: ID, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sc-add-title', hidden: true }, [
      el('div', { class: 'modal modal-wide' }, [
        el('div', { class: 'modal-head' }, [el('div', { class: 'modal-title', id: 'sc-add-title' }), el('button', { type: 'button', class: 'btn modal-close', 'data-close': ID, 'aria-label': T('common.close'), text: '×' })]),
        el('div', { class: 'modal-body' }, [el('div', { id: 'sc-add-body' }), el('p', { class: 'msg', id: 'sc-add-msg', role: 'status' }), el('p', { class: 'hint sc-privacy', text: T('account.privacy') })]),
      ]),
    ]);
    document.body.appendChild(m);
    S.onClose(ID, function () { stopCamera(); cur = null; });
    return m;
  }

  /**
   * opts = { title, intro?, submitLabel?, start?: 'choose'|'manual', preset?: { host, school, username },
   *          onSubmit(body) → Promise (rejects with the API error to show it) }
   */
  function open(opts) {
    ensureModal();
    stopCamera();
    cur = { opts: opts || {}, step: null, stream: null, timer: null, busy: false };
    document.getElementById('sc-add-title').textContent = cur.opts.title || T('account.add');
    S.openModal(ID);
    step(cur.opts.start || 'choose');
  }

  window.SCScan = { open: open, isUntis: isUntis, cameraPossible: cameraPossible };
}());
