/* Portal tab "GateDrop": choose files (or drop / paste them) and a text or link, pick targets (people, own
   devices, NAS folders, a link for outsiders), send. Files go up with GC.upload first (a type GateDrop does not
   take — e.g. HTML, JSON, SVG — goes up as application/octet-stream); then POST sends. Right: active links (end them) and the history
   (sent and received; received files open through signed /plugin-media/ URLs from GET items/<mediaId>). */
(function () {
  'use strict';
  var G = window.GD;
  var T = G.T;
  var el = G.el;
  var S = { files: [], targets: null, picked: {}, busy: false };
  var ICON_X = 'M6 6l12 12M18 6L6 18';
  var MAX_BYTES = 2147483648;

  if (!G.CTX.loggedIn) {
    G.$('#gd-portal').hidden = true;
    G.$('#gd-login').hidden = false;
    return;
  }

  function key(kind, id) { return kind + ':' + id; }

  // ─── files and text ───────────────────────────────────────────────
  function addFiles(list) {
    Array.prototype.forEach.call(list || [], function (f) {
      if (S.files.length >= ((S.targets && S.targets.limits.maxItems) || 20)) { G.toast(T('portal.too_many'), 'error'); return; }
      if (f.size > MAX_BYTES) { G.toast(T('portal.too_large', { name: f.name }), 'error'); return; }
      S.files.push({ file: f, pct: 0, bar: null });
    });
    renderFiles();
  }
  function renderFiles() {
    var box = G.clear(G.$('#gd-files'));
    S.files.forEach(function (x, i) {
      var bar = el('span', { class: 'gd-prog', hidden: !S.busy }, [el('i')]);
      x.bar = bar;
      box.appendChild(el('div', { class: 'gd-file' }, [
        el('span', { class: 'gd-file-name', text: x.file.name }), el('span', { class: 'gd-file-size', text: G.bytes(x.file.size) }), bar,
        el('button', { type: 'button', class: 'gd-x', 'aria-label': T('portal.remove'), disabled: S.busy, on: { click: function () { S.files.splice(i, 1); renderFiles(); } } }, [G.svg(ICON_X, 14)]),
      ]));
    });
  }
  var drop = G.$('#gd-drop');
  G.$('#gd-file').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
  drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', function () { drop.classList.remove('is-over'); });
  drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('is-over'); if (e.dataTransfer) addFiles(e.dataTransfer.files); });
  document.addEventListener('paste', function (e) {
    var cd = e.clipboardData;
    if (!cd || !cd.files || !cd.files.length || e.target === G.$('#gd-text')) return;
    e.preventDefault();
    addFiles(cd.files);
  });

  // ─── targets ──────────────────────────────────────────────────────
  function chip(kind, id, label, extra, hint) {
    var k = key(kind, id);
    var on = !!S.picked[k];
    return el('button', { type: 'button', class: 'gd-chip', title: hint || null, 'aria-pressed': on ? 'true' : 'false', on: { click: function () {
      if (S.picked[k]) delete S.picked[k]; else S.picked[k] = { kind: kind, id: id, label: label };
      G.$('#gd-linkopts').hidden = !S.picked['link:link'];
      renderTargets();
    } } }, [extra || null, el('span', { text: label }), hint ? el('small', { class: 'gd-chip-hint', text: hint }) : null]);
  }
  function renderTargets() {
    var box = G.clear(G.$('#gd-targets'));
    var tg = S.targets;
    if (!tg) return;
    tg.people.forEach(function (p) { box.appendChild(chip('person', p.id, p.name)); });
    // an offline device can be chosen too: the server keeps the files and it fetches them once it is online again
    tg.devices.forEach(function (d) { box.appendChild(chip('device', d.id, d.name, el('span', { class: 'gd-dot' + (d.online ? ' is-on' : '') }), d.online ? null : T('portal.offline_hint'))); });
    tg.nas.forEach(function (n) { box.appendChild(chip('nas', n.id, 'NAS: ' + n.path)); });
    if (tg.me.canLink && tg.links.enabled) box.appendChild(chip('link', 'link', T('portal.link_target')));
    if (!box.firstChild) box.appendChild(el('span', { class: 'gd-muted', text: T('portal.no_targets') }));
  }

  // ─── sending ──────────────────────────────────────────────────────
  function uploadOne(x) {
    var types = (S.targets && S.targets.limits.types) || [];
    var t = String(x.file.type || '').toLowerCase();
    var ok = t && (types.indexOf(t) >= 0 || types.indexOf(t.split('/')[0] + '/*') >= 0) && !/(html|xml|javascript|ecmascript|css|json|svg|x-www-form-urlencoded)/.test(t);
    var blob = ok ? x.file : new Blob([x.file], { type: 'application/octet-stream' });
    return window.GC.upload(blob, { onProgress: function (p) {
      x.pct = p.total ? (p.loaded / p.total) * 100 : 0;
      if (x.bar && x.bar.firstChild) x.bar.firstChild.style.width = Math.round(x.pct) + '%';
      G.$('#gd-progress').textContent = T('portal.uploading', { pct: Math.round(x.pct) });
    } }).then(function (r) { return { mediaId: r.mediaId, name: x.file.name }; }, function (e) {
      var code = (e && e.data && e.data.code) || '';
      throw new Error(code === 'quota_exceeded' ? T('portal.quota') : T('portal.upload_failed', { name: x.file.name }));
    });
  }
  function body(items) {
    var raw = G.$('#gd-text').value.trim();
    var out = { items: items, to: { people: [], devices: [], nas: [] } };
    if (raw) { if (/^https?:\/\/\S+$/i.test(raw)) out.link = raw; else out.text = raw; }
    Object.keys(S.picked).forEach(function (k) {
      var p = S.picked[k];
      if (p.kind === 'person') out.to.people.push(p.id);
      else if (p.kind === 'device') out.to.devices.push(p.id);
      else if (p.kind === 'nas') out.to.nas.push({ id: p.id });
      else if (p.kind === 'link') {
        var exp = document.querySelector('input[name="gd-exp"]:checked');
        out.to.link = { expires: exp ? exp.value : '1d', pin: G.$('#gd-pin').checked };
      }
    });
    return out;
  }
  function statusLabel(d) {
    if (d.status === 'waiting') return T('status.waiting', { device: d.label || d.target });
    return T('status.' + d.status) + (d.via && d.status !== 'failed' ? ' · ' + T('via.' + d.via) : '');
  }
  function showResult(r) {
    var box = G.clear(G.$('#gd-result'));
    box.hidden = false;
    box.appendChild(el('b', { text: T('portal.sent') }));
    r.deliveries.forEach(function (d) {
      if (d.kind === 'link') return;
      var tone = d.status === 'failed' ? ' is-crit' : (d.status === 'delivered' ? ' is-good' : '');
      box.appendChild(el('div', { class: 'gd-result-row' }, [el('b', { text: d.label || d.target }), el('span', { class: 'gd-st' + tone, text: statusLabel(d) })]));
    });
    if (r.link) {
      var copy = el('button', { type: 'button', class: 'btn btn-sm', text: T('portal.copy'), on: { click: function () {
        var txt = r.link.url + (r.link.pin ? '\nPIN: ' + r.link.pin : '');
        var done = function () { copy.textContent = T('portal.copied'); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () { G.toast(txt); });
        else G.toast(txt);
      } } });
      box.appendChild(el('div', { class: 'gd-linkbox' }, [
        el('span', { class: 'gd-muted', text: T('portal.link') }), el('b', { text: r.link.url }),
        r.link.pin ? el('span', { class: 'gd-muted', text: T('portal.pin_label') }) : null, r.link.pin ? el('span', { class: 'gd-pin', text: r.link.pin }) : null,
        el('div', { class: 'gd-actions' }, [copy]),
      ]));
    }
  }
  function send() {
    if (S.busy) return;
    var text = G.$('#gd-text').value.trim();
    if (!S.files.length && !text) { G.toast(T('portal.need_something'), 'error'); return; }
    if (!Object.keys(S.picked).length) { G.toast(T('portal.need_target'), 'error'); return; }
    S.busy = true;
    G.$('#gd-send').disabled = true;
    G.$('#gd-result').hidden = true;
    renderFiles();
    var items = [];
    var chain = Promise.resolve();
    S.files.forEach(function (x) { chain = chain.then(function () { return uploadOne(x).then(function (it) { items.push(it); }); }); });
    chain.then(function () {
      G.$('#gd-progress').textContent = T('portal.sending');
      return G.api('POST', 'sends', body(items));
    }).then(function (r) {
      S.files = [];
      G.$('#gd-text').value = '';
      showResult(r);
      loadSide();
    }, function (e) {
      G.toast(e && e.data ? G.errText(e) : (e && e.message) || T('error.internal'), 'error');
    }).then(function () {
      S.busy = false;
      G.$('#gd-send').disabled = false;
      G.$('#gd-progress').textContent = '';
      renderFiles();
    });
  }
  G.$('#gd-send').addEventListener('click', send);

  // ─── side: active links, history ──────────────────────────────────
  function expiresIn(isoStr) {
    var ms = new Date(isoStr).getTime() - Date.now();
    if (ms < 3600000) return T('portal.expires_in_min', { n: Math.max(1, Math.round(ms / 60000)) });
    if (ms < 2 * 86400000) return T('portal.expires_in_h', { n: Math.round(ms / 3600000) });
    return T('portal.expires_in_d', { n: Math.round(ms / 86400000) });
  }
  function renderLinks(list) {
    var box = G.clear(G.$('#gd-links'));
    var active = list.filter(function (l) { return l.active; });
    if (!active.length) { box.appendChild(el('p', { class: 'gd-empty', text: S.targets && !S.targets.links.enabled ? T('portal.links_off') : T('portal.no_links') })); return; }
    active.forEach(function (l) {
      var parts = [];
      if (l.pin) parts.push(T('portal.with_pin'));
      parts.push(expiresIn(l.expiresAt));
      parts.push(l.maxDownloads === 1 ? T('portal.once') : (l.downloads ? T('portal.downloads', { n: l.downloads }) : T('portal.not_loaded')));
      box.appendChild(el('div', { class: 'gd-row' }, [
        el('div', { class: 'gd-row-tx' }, [el('b', { text: l.title || l.token }), el('small', { text: parts.join(' · ') })]),
        el('button', { type: 'button', class: 'btn btn-sm', text: T('portal.end'), on: { click: function () {
          G.confirm(T('portal.end_confirm'), T('portal.end')).then(function (yes) {
            if (!yes) return;
            G.api('DELETE', 'links/' + encodeURIComponent(l.token)).then(loadSide, function (e) { G.toast(G.errText(e), 'error'); });
          });
        } } }),
      ]));
    });
  }
  function title(s) {
    if (s.items.length === 1) return s.items[0].name;
    if (s.items.length > 1) return T('what.files', { n: s.items.length });
    return s.link || (s.text || '').slice(0, 60);
  }
  function openItem(s) {
    var it = s.items.find(function (i) { return i.available; });
    if (!it) return;
    G.api('GET', 'items/' + it.mediaId).then(function (r) {
      var a = el('a', { href: r.url, download: it.name, target: '_blank', rel: 'noopener' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      G.api('POST', 'sends/' + s.id + '/opened').catch(function () {});
    }, function (e) { G.toast(G.errText(e), 'error'); });
  }
  function renderHistory(sent, received) {
    var box = G.clear(G.$('#gd-history'));
    var all = sent.map(function (s) { return { s: s, out: true }; }).concat(received.map(function (s) { return { s: s, out: false }; }))
      .sort(function (a, b) { return a.s.createdAt < b.s.createdAt ? 1 : -1; }).slice(0, 30);
    if (!all.length) { box.appendChild(el('p', { class: 'gd-empty', text: T('portal.no_history') })); return; }
    all.forEach(function (x) {
      var s = x.s;
      var sub;
      if (x.out) sub = T('portal.to', { names: s.deliveries.map(function (d) { return d.label || T('kind.' + d.kind); }).join(', ') });
      else sub = T('portal.from', { name: s.from.deviceName || s.from.name || '?' });
      sub += ' · ' + (s.expired ? T('portal.expired') : G.when(s.createdAt));
      var action = null;
      if (!x.out && !s.expired && s.items.some(function (i) { return i.available; })) action = el('button', { type: 'button', class: 'btn btn-sm', text: T('portal.download'), on: { click: function () { openItem(s); } } });
      else if (!x.out && s.link) action = el('a', { href: s.link, target: '_blank', rel: 'noopener noreferrer', text: T('portal.open_link') });
      box.appendChild(el('div', { class: 'gd-row' }, [
        el('div', { class: 'gd-row-tx' }, [el('b', { text: (x.out ? '↑ ' : '↓ ') + title(s) }), el('small', { text: sub })]), action,
      ]));
    });
  }
  function loadSide() {
    var none = { items: [] };
    Promise.all([
      G.api('GET', 'inbox?kind=links&limit=50').catch(function () { return none; }),
      G.api('GET', 'inbox?kind=sent&limit=20').catch(function () { return none; }),
      G.api('GET', 'inbox?kind=received&limit=20').catch(function () { return none; }),
    ]).then(function (r) { renderLinks(r[0].items); renderHistory(r[1].items, r[2].items); });
  }
  G.api('GET', 'targets').then(function (tg) {
    S.targets = tg;
    if (tg.storage) {
      var p = G.$('#gd-storage');
      p.textContent = T('portal.storage', { used: G.bytes(tg.storage.bytes), quota: G.bytes(tg.storage.quota) });
      p.hidden = false;
    }
    renderTargets();
    loadSide();
  }, function (e) { G.toast(G.errText(e), 'error'); });
}());
