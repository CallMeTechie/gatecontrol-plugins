/* Smart Home — the assistant "Tuya-Geräte hinzufügen" and "Key neu holen" (since 1.21.0, server/tuya.js). Three steps:
   the keys (Tuya-IoT access, devices.json of "tinytuya wizard", or one device by hand), the gateway listens in the home
   network, done. The keys never reach this page: the server keeps them; the page sees names, kinds and short ids.
   window.SH_TUYA.open(gateway, onDone) · window.SH_TUYA.rekey(device, onDone) */
(function () {
  'use strict';
  var S = window.SH, T = S.T, $ = S.$, $$ = S.$$, el = S.el;
  var REGIONS = ['eu', 'weu', 'us', 'use', 'in', 'cn'];
  var st = { gw: null, status: null, session: null, devices: [], step: 1, done: null, busy: false };

  function warn(err) { S.toast((err && err.message) || T('common.error'), 'error'); }
  function errText(e) {
    var t = (e && e.message) || T('common.error');
    return e && e.detail ? t + ' (' + e.detail + ')' : t;
  }
  function source() { var r = $('input[name="sh-t-src"]:checked'); return r ? r.value : 'cloud'; }
  function showErr(text) { var p = $('#sh-t-error'); p.textContent = text || ''; p.hidden = !text; }

  // ─── Step 1: the rights and the keys ───

  function renderCaps() {
    var host = S.clear($('#sh-t-caps'));
    var c = st.status && st.status.caps;
    host.hidden = !c || c.ok;
    if (!c || c.ok) return;
    var text;
    var action = null;
    if (c.gatewaySupported === false) text = T('tuya.caps.too_old', { name: st.gw.name });
    else if (c.missing.every(function (k) { return c.requested.indexOf(k) >= 0; })) text = T('tuya.caps.waiting', { name: st.gw.name });
    else {
      text = T('tuya.caps.missing', { name: st.gw.name });
      action = el('button', { type: 'button', class: 'btn btn-sm', text: T('tuya.caps.request'), on: { click: function () {
        action.disabled = true;
        S.api('POST', 'edge/tuya/request', { gateway_id: st.gw.id }).then(function (r) { st.status.caps = r.caps; renderCaps(); S.toast(T('tuya.caps.requested')); }, function (e) { action.disabled = false; warn(e); });
      } } });
    }
    var link = el('a', { class: 'btn btn-sm', href: c.link || ('/gateways#gw/' + st.gw.id + '/edge'), target: '_top', text: T('tuya.caps.open') });
    host.appendChild(el('span', { class: 'sh-notice-text', text: text }));
    if (action) host.appendChild(action);
    host.appendChild(link);
  }

  function renderSource() {
    var src = source();
    $('#sh-t-cloud').hidden = src !== 'cloud';
    $('#sh-t-file').hidden = src !== 'file';
    $('#sh-t-manual').hidden = src !== 'manual';
    var saved = !!(st.status && st.status.cloud && st.status.cloud.saved);
    $('#sh-t-saved-row').hidden = !saved;
    var useSaved = saved && $('#sh-t-saved').checked;
    $('#sh-t-cloud-fields').hidden = useSaved;
    $('#sh-t-next').textContent = T('tuya.fetch');
  }

  /** devices.json of tinytuya: only the fields the plugin needs leave the page (the file is not kept). */
  function readFile() {
    var f = $('#sh-t-json').files && $('#sh-t-json').files[0];
    if (!f) return Promise.reject(new Error(T('tuya.file.none')));
    if (f.size > 4 * 1024 * 1024) return Promise.reject(new Error(T('tuya.file.bad')));
    return new Promise(function (resolve, reject) {
      var rd = new FileReader();
      rd.onload = function () {
        var list;
        try { list = JSON.parse(String(rd.result)); } catch (e) { reject(new Error(T('tuya.file.bad'))); return; }
        if (!Array.isArray(list)) { reject(new Error(T('tuya.file.bad'))); return; }
        var keep = ['id', 'key', 'name', 'category', 'product_name', 'model', 'mapping', 'node_id', 'parent', 'sub', 'ip', 'version'];
        resolve(list.slice(0, 200).filter(function (d) { return d && typeof d === 'object'; }).map(function (d) {
          var o = {};
          keep.forEach(function (k) { if (d[k] !== undefined) o[k] = d[k]; });
          return o;
        }));
      };
      rd.onerror = function () { reject(new Error(T('tuya.file.bad'))); };
      rd.readAsText(f);
    });
  }

  function importBody() {
    var src = source();
    var base = { gateway_id: st.gw.id, source: src };
    if (src === 'cloud') {
      if (!$('#sh-t-saved-row').hidden && $('#sh-t-saved').checked) return Promise.resolve(Object.assign(base, { saved: true }));
      var id = $('#sh-t-id').value.trim();
      var secret = $('#sh-t-secret').value.trim();
      if (!id || !secret) return Promise.reject(new Error(T('tuya.cloud.required')));
      return Promise.resolve(Object.assign(base, { id: id, secret: secret, region: $('#sh-t-region').value, keep: $('#sh-t-keep').checked }));
    }
    if (src === 'file') return readFile().then(function (devices) { return Object.assign(base, { devices: devices }); });
    var did = $('#sh-t-mid').value.trim();
    var key = $('#sh-t-mkey').value.trim();
    if (!did || key.length !== 16) return Promise.reject(new Error(T('tuya.manual.required')));
    return Promise.resolve(Object.assign(base, { id: did, key: key, kind: $('#sh-t-mkind').value, ip: $('#sh-t-mip').value.trim() || undefined }));
  }

  // ─── Step 2: in the home network ───

  function reasonText(d) {
    if (d.exists) return T('tuya.row.exists');
    if (d.reason === 'hub') return T('tuya.row.hub', { n: d.subs || 0 });
    if (d.reason === 'sub') return T('tuya.row.sub');
    if (d.reason === 'no_key') return T('tuya.row.no_key');
    if (d.reason === 'unsupported') return T('tuya.row.unsupported');
    return null;
  }
  function kindText(d) {
    if (d.kind === 'light') {
      var parts = [T('kind.light')];
      if (d.light && d.light.color) parts.push(T('tuya.kind.colour'));
      if (d.light && d.light.ct) parts.push(T('tuya.kind.white'));
      return parts.join(' · ');
    }
    if (d.kind === 'plug') return T('kind.plug') + (d.channels > 1 ? ' · ' + T('tuya.kind.channels', { n: d.channels }) : '') + (d.power ? ' · ' + T('tuya.kind.power') : '');
    if (d.kind === 'switch') return T('tuya.kind.switch') + (d.channels > 1 ? ' · ' + T('tuya.kind.channels', { n: d.channels }) : '');
    if (d.kind === 'auto') return T('tuya.kind.auto');
    if (d.reason === 'hub') return T('tuya.kind.hub');
    if (d.reason === 'sub') return T('tuya.kind.sub');
    return d.category ? T('tuya.kind.category', { c: d.category }) : '–';
  }

  function renderList(scanning) {
    var host = S.clear($('#sh-t-list'));
    var found = st.devices.filter(function (d) { return d.found; }).length;
    $('#sh-t-sum').textContent = scanning ? T('tuya.scan.running', { n: st.devices.length }) : T('tuya.scan.done', { n: st.devices.length, found: found });
    $('#sh-t-spin').hidden = !scanning;
    st.devices.forEach(function (d) {
      var addable = (d.supported || (d.reason === 'unsupported' && d.bools && d.bools.length)) && !d.exists;
      var cb = el('input', { type: 'checkbox', 'data-ref': String(d.ref), checked: !!(d.supported && !d.exists && (d.found || d.ip)), disabled: !addable || (!d.supported), 'aria-label': T('tuya.row.take', { name: d.name || d.short }) });
      var name = addable ? el('input', { class: 'form-input sh-t-name', type: 'text', maxlength: '60', value: d.name || '', placeholder: d.product || d.short, 'data-name': String(d.ref), 'aria-label': T('add.name') })
        : el('strong', { text: d.name || d.product || d.short });
      var place;
      if (d.ip) place = el('span', { class: 'sh-t-ip', text: d.ip });
      else if (addable) place = el('input', { class: 'form-input sh-t-ipin', type: 'text', maxlength: '15', placeholder: T('tuya.row.ip_ph'), 'data-ip': String(d.ref), 'aria-label': T('tuya.row.ip_of', { name: d.name || d.short }) });
      else place = null;
      var why = reasonText(d);
      var extra = null;
      if (d.reason === 'unsupported' && d.bools && d.bools.length && !d.exists) {
        // "Ein/Aus als Schalter zeigen": one of its on/off datapoints, chosen by hand
        extra = el('select', { class: 'form-select sh-t-dp', 'data-dp': String(d.ref), 'aria-label': T('tuya.row.as_switch') });
        extra.appendChild(el('option', { value: '', text: T('tuya.row.not_take') }));
        d.bools.forEach(function (b) { extra.appendChild(el('option', { value: String(b.dp), text: T('tuya.row.dp', { dp: b.dp, code: b.code || '' }) })); });
        extra.addEventListener('change', function () { cb.disabled = !extra.value; cb.checked = !!extra.value; updateLimit(); });
      }
      cb.addEventListener('change', updateLimit);
      host.appendChild(el('div', { class: 'sh-t-row' + (addable ? '' : ' is-off') }, [
        el('span', { class: 'sh-t-cb' }, [cb]),
        el('span', { class: 'sh-t-dev' }, [name, el('span', { class: 'sh-sub', text: [d.short, d.product].filter(Boolean).join(' · ') })]),
        el('span', { class: 'sh-t-kind' }, [el('span', { text: kindText(d) }), why ? el('span', { class: 'sh-sub', text: why }) : null, extra]),
        el('span', { class: 'sh-t-where' }, [place, d.found ? null : (addable && !scanning ? el('span', { class: 'sh-sub', text: T('tuya.row.not_found') }) : null)]),
        el('span', { class: 'sh-t-ver', text: d.ver || '' }),
      ]));
    });
    if (!st.devices.length) host.appendChild(el('p', { class: 'sh-sub', text: T('tuya.scan.none') }));
    updateLimit();
  }

  function chosen() {
    return $$('#sh-t-list input[type="checkbox"][data-ref]').filter(function (c) { return c.checked && !c.disabled; }).map(function (c) {
      var ref = Number(c.getAttribute('data-ref'));
      var o = { ref: ref };
      var n = $('#sh-t-list [data-name="' + ref + '"]');
      if (n && n.value.trim()) o.name = n.value.trim();
      var ip = $('#sh-t-list [data-ip="' + ref + '"]');
      if (ip && ip.value.trim()) o.ip = ip.value.trim();
      var dp = $('#sh-t-list [data-dp="' + ref + '"]');
      if (dp && dp.value) o.dp = Number(dp.value);
      return o;
    });
  }

  function updateLimit() {
    var lim = st.status && st.status.limit;
    var p = $('#sh-t-limit');
    if (!lim) { p.hidden = true; return; }
    var n = lim.count + chosen().length;
    p.hidden = n < lim.warn;
    p.textContent = n > lim.max ? T('tuya.limit.over', { max: lim.max }) : T('tuya.limit.near', { n: n, max: lim.max });
    $('#sh-t-next').disabled = st.step === 2 && !chosen().length;
  }

  // ─── Steps ───

  function setStep(n) {
    st.step = n;
    $$('#sh-t-steps li').forEach(function (li, i) { li.setAttribute('data-state', i + 1 < n ? 'done' : (i + 1 === n ? 'running' : 'pending')); if (i + 1 === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
    $('#sh-t-p1').hidden = n !== 1;
    $('#sh-t-p2').hidden = n !== 2;
    $('#sh-t-p3').hidden = n !== 3;
    $('#sh-t-back').hidden = n !== 2;
    $('#sh-t-cancel').hidden = n === 3;
    $('#sh-t-next').disabled = false;
    $('#sh-t-next').textContent = n === 1 ? T('tuya.fetch') : (n === 2 ? T('tuya.take') : T('tuya.finish'));
    showErr('');
  }

  function scan() {
    renderList(true);
    $('#sh-t-next').disabled = true;
    return S.api('POST', 'edge/tuya/scan', { session: st.session }).then(function (r) {
      st.devices = r.devices || st.devices;
      renderList(false);
      if (r.denied) showErr(T('tuya.scan.denied'));
    }, function (e) { renderList(false); showErr(errText(e)); });
  }

  function next() {
    if (st.busy) return;
    if (st.step === 1) {
      st.busy = true;
      $('#sh-t-next').disabled = true;
      importBody().then(function (body) { return S.api('POST', 'edge/tuya/import', body); }).then(function (r) {
        st.session = r.session;
        st.devices = r.devices || [];
        $('#sh-t-secret').value = '';
        $('#sh-t-mkey').value = '';
        setStep(2);
        return scan();
      }, function (e) { showErr(errText(e)); }).then(function () { st.busy = false; $('#sh-t-next').disabled = false; updateLimit(); });
      return;
    }
    if (st.step === 2) {
      var list = chosen();
      if (!list.length) return;
      st.busy = true;
      $('#sh-t-next').disabled = true;
      S.api('POST', 'edge/tuya/add', { session: st.session, devices: list }).then(function (r) {
        $('#sh-t-done').textContent = T('tuya.done', { n: r.added, name: st.gw.name }) + (r.limited ? ' ' + T('tuya.limit.left', { n: r.limited, max: r.max }) : '');
        setStep(3);
        if (st.done) st.done();
      }, function (e) { showErr(errText(e)); }).then(function () { st.busy = false; $('#sh-t-next').disabled = false; });
      return;
    }
    S.closeModal('sh-tuya-modal');
  }

  function open(gw, onDone) {
    st.gw = gw;
    st.done = onDone || null;
    st.session = null;
    st.devices = [];
    st.status = null;
    $('#sh-t-sub').textContent = T('tuya.via', { name: gw.name });
    var region = S.clear($('#sh-t-region'));
    REGIONS.forEach(function (r) { region.appendChild(el('option', { value: r, text: T('tuya.region.' + r) })); });
    $('#sh-t-id').value = '';
    $('#sh-t-secret').value = '';
    $('#sh-t-keep').checked = true;
    $('#sh-t-json').value = '';
    $('#sh-t-mid').value = '';
    $('#sh-t-mkey').value = '';
    $('#sh-t-mip').value = '';
    $('input[name="sh-t-src"][value="cloud"]').checked = true;
    setStep(1);
    renderSource();
    renderCaps();
    S.openModal('sh-tuya-modal', 'input[name="sh-t-src"]:checked');
    S.api('GET', 'edge/tuya/status?gateway_id=' + Number(gw.id)).then(function (r) {
      st.status = r;
      if (r.cloud && r.cloud.saved) { $('#sh-t-saved').checked = true; if (r.cloud.region) $('#sh-t-region').value = r.cloud.region; }
      renderSource();
      renderCaps();
    }, warn);
  }

  $$('input[name="sh-t-src"]').forEach(function (r) { r.addEventListener('change', function () { renderSource(); showErr(''); }); });
  $('#sh-t-saved').addEventListener('change', renderSource);
  $('#sh-t-next').addEventListener('click', next);
  $('#sh-t-back').addEventListener('click', function () { setStep(1); renderSource(); });
  $('#sh-t-cancel').addEventListener('click', function () { S.closeModal('sh-tuya-modal'); });
  $('#sh-t-forget').addEventListener('click', function () {
    S.api('DELETE', 'edge/tuya/cloud').then(function () {
      if (st.status) st.status.cloud = { saved: false, region: null };
      $('#sh-t-saved').checked = false;
      renderSource();
      S.toast(T('tuya.cloud.forgotten'));
    }, warn);
  });

  // ─── Key neu holen ───

  var rk = { device: null, done: null, saved: false };
  function rekeySource() { var r = $('input[name="sh-k-src"]:checked'); return r ? r.value : 'manual'; }
  function renderRekey() {
    var src = rekeySource();
    $('#sh-k-file').hidden = src !== 'file';
    $('#sh-k-manual').hidden = src !== 'manual';
  }
  function rekey(device, onDone) {
    rk.device = device;
    rk.done = onDone || null;
    $('#sh-k-sub').textContent = [device.name, device.tuya && device.tuya.short].filter(Boolean).join(' · ');
    $('#sh-k-key').value = '';
    $('#sh-k-json').value = '';
    var p = $('#sh-k-error'); p.hidden = true;
    S.api('GET', 'edge/tuya/status?gateway_id=' + Number(device.gateway_id)).catch(function () { return null; }).then(function (r) {
      rk.saved = !!(r && r.cloud && r.cloud.saved);
      $('#sh-k-cloud-row').hidden = !rk.saved;
      $('input[name="sh-k-src"][value="' + (rk.saved ? 'cloud' : 'file') + '"]').checked = true;
      renderRekey();
      S.openModal('sh-tkey-modal', 'input[name="sh-k-src"]:checked');
    });
  }
  function keyFromFile() {
    var f = $('#sh-k-json').files && $('#sh-k-json').files[0];
    if (!f) return Promise.reject(new Error(T('tuya.file.none')));
    return new Promise(function (resolve, reject) {
      var rd = new FileReader();
      rd.onload = function () {
        var list;
        try { list = JSON.parse(String(rd.result)); } catch (e) { reject(new Error(T('tuya.file.bad'))); return; }
        // the device is found by its id's last characters as the page knows them — the server checks the key's form
        var short = rk.device.tuya && rk.device.tuya.short ? rk.device.tuya.short.slice(-4) : '';
        var hit = Array.isArray(list) ? list.filter(function (d) { return d && typeof d.id === 'string' && d.id.slice(-4) === short && d.id.slice(0, 2) === rk.device.tuya.short.slice(0, 2); }) : [];
        if (hit.length !== 1 || typeof hit[0].key !== 'string') { reject(new Error(T('tuya.file.missing'))); return; }
        resolve(hit[0].key);
      };
      rd.onerror = function () { reject(new Error(T('tuya.file.bad'))); };
      rd.readAsText(f);
    });
  }
  $$('input[name="sh-k-src"]').forEach(function (r) { r.addEventListener('change', renderRekey); });
  $('#sh-k-submit').addEventListener('click', function () {
    var d = rk.device;
    if (!d) return;
    var src = rekeySource();
    var btn = $('#sh-k-submit'); btn.disabled = true;
    var body = src === 'cloud' ? Promise.resolve({ source: 'cloud' }) : (src === 'file' ? keyFromFile().then(function (k) { return { source: 'file', key: k }; }) : Promise.resolve({ source: 'manual', key: $('#sh-k-key').value.trim() }));
    body.then(function (b) { return S.api('POST', 'edge/devices/' + Number(d.id) + '/tuya_key', b); }).then(function () {
      $('#sh-k-key').value = '';
      S.closeModal('sh-tkey-modal');
      S.toast(T('tuya.rekey.done', { name: d.name }));
      if (rk.done) rk.done();
    }, function (e) { var p = $('#sh-k-error'); p.textContent = errText(e); p.hidden = false; }).then(function () { btn.disabled = false; });
  });

  window.SH_TUYA = { open: open, rekey: rekey };
}());
