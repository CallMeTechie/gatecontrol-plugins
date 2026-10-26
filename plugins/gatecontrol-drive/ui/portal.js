/* Drive (gatecontrol-drive) — the portal tab "Drive" (mockup "Portal – Dateien & Freigabe").
 *
 * The areas (my files, the family, the children's folders, team folders) on the left, the folder as tiles or a list,
 * breadcrumbs, search; upload with the button or by dropping files and folders (GC.upload, then uploads/commit — a
 * name that exists asks: a new version, keep both, or skip); a preview for pictures, videos and sound (the signed
 * media URL — every other type downloads); new folder, rename, move (also into another area), versions, trash;
 * sharing with people without an account (links v2: view, view + download, upload into a folder; 1 / 7 / 30 days or
 * without an end; an optional PIN; the log); "Geteilte Links" and "Papierkorb" as pages. Live: the event 'changed'
 * (GC.on) reloads the folder shown when its area changed.
 *
 * The frame is sandboxed (opaque origin, no storage, no network of its own): everything goes through GC.call /
 * GC.upload. Server and user text only ever goes into textContent or attributes — never innerHTML.
 */
(function () {
  'use strict';

  var CTX = window.DP_CTX || { texts: {}, lang: 'de' };
  var LOCALE = CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  var NS = 'http://www.w3.org/2000/svg';
  var PAGE = 200;
  var LIVE_DELAY_MS = 400;

  // ── texts ────────────────────────────────────────────────

  function T(k, p) {
    var s = CTX.texts && CTX.texts[k] != null ? String(CTX.texts[k]) : k;
    if (p) Object.keys(p).forEach(function (x) { s = s.split('{{' + x + '}}').join(String(p[x])); });
    return s;
  }
  function P(k, n, p) { return T(k + (n === 1 ? '.one' : '.other'), Object.assign({ count: n }, p || {})); }

  // ── DOM helpers (text only through textContent / attributes) ──

  var ICONS = {
    cloud: 'M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    file: 'M6 3h8l4 4v14H6z|M14 3v4h4',
    image: 'M4 5h16v14H4z|M4 16l5-5 4 4 2-2 5 5|M15 9h.01',
    video: 'M3 6h13v12H3z|M16 10l5-3v10l-5-3',
    audio: 'M9 18V5l11-2v13|M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0|M20 16a3 3 0 1 1-6 0a3 3 0 1 1 6 0',
    search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14|M20 20l-3.5-3.5',
    upload: 'M12 16V4|M7 9l5-5 5 5|M4 16v4h16v-4',
    plus: 'M12 5v14M5 12h14',
    more: 'M12 6h.01M12 12h.01M12 18h.01',
    grid: 'M4 4h7v7H4z|M13 4h7v7h-7z|M4 13h7v7H4z|M13 13h7v7h-7z',
    list: 'M8 6h12M8 12h12M8 18h12|M4 6h.01M4 12h.01M4 18h.01',
    share: 'M18 8a3 3 0 1 0 0-6a3 3 0 1 0 0 6|M6 15a3 3 0 1 0 0-6a3 3 0 1 0 0 6|M18 22a3 3 0 1 0 0-6a3 3 0 1 0 0 6|M8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1|M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    trash: 'M4 7h16|M10 11v6M14 11v6|M6 7l1 13h10l1-13|M9 7V4h6v3',
    history: 'M3 12a9 9 0 1 0 3-6.7L3 8|M3 3v5h5|M12 7v5l3 3',
    edit: 'M4 20h4L19 9l-4-4L4 16z|M14 6l4 4',
    move: 'M5 12h14|M13 6l6 6-6 6',
    download: 'M12 4v12|M7 11l5 5 5-5|M4 20h16',
    eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z|M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
    copy: 'M9 9h11v11H9z|M5 15H4V4h11v1',
    close: 'M6 6l12 12M18 6L6 18',
    info: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18|M12 11v5M12 8h.01',
    restore: 'M3 12a9 9 0 1 0 3-6.7L3 8|M3 3v5h5',
    up: 'M12 19V5|M5 12l7-7 7 7',
  };

  function icon(name, size) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', String(size || 16));
    s.setAttribute('height', String(size || 16));
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.9');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    (ICONS[name] || '').split('|').forEach(function (d) {
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
    });
    return s;
  }

  /** h('div', { class, text, attrs: {}, on: {}, hidden, value, type, … }, [children]) */
  function h(tag, o, kids) {
    var n = document.createElement(tag);
    var opts = o || {};
    Object.keys(opts).forEach(function (k) {
      var v = opts[k];
      if (v === undefined || v === null) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = String(v);
      else if (k === 'attrs') Object.keys(v).forEach(function (a) { if (v[a] !== undefined && v[a] !== null && v[a] !== false) n.setAttribute(a, v[a] === true ? '' : String(v[a])); });
      else if (k === 'on') Object.keys(v).forEach(function (e) { n.addEventListener(e, v[e]); });
      else if (k === 'hidden' || k === 'disabled' || k === 'checked' || k === 'selected') n[k] = !!v;
      else if (k === 'value' || k === 'type' || k === 'placeholder' || k === 'id' || k === 'title') n[k] = v;
      else n.setAttribute(k, String(v));
    });
    add(n, kids);
    return n;
  }
  function add(n, kids) {
    (Array.isArray(kids) ? kids : kids == null ? [] : [kids]).forEach(function (c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) add(n, c);
      else n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  var $ = function (id) { return document.getElementById(id); };

  function btn(label, onClick, o) {
    var x = o || {};
    return h('button', { type: 'button', class: 'dp-btn' + (x.primary ? ' dp-btn-primary' : '') + (x.danger ? ' dp-btn-danger' : '') + (x.small ? ' dp-btn-sm' : ''), disabled: x.disabled, on: { click: onClick }, attrs: x.attrs },
      [x.icon ? icon(x.icon) : null, h('span', { text: label })]);
  }
  function ibtn(name, label, onClick, o) {
    var x = o || {};
    return h('button', { type: 'button', class: 'dp-ib' + (x.cls ? ' ' + x.cls : '') + (x.on ? ' is-on' : ''), on: { click: onClick }, attrs: { 'aria-label': label, title: label, 'aria-pressed': x.pressed == null ? null : String(!!x.pressed) } }, icon(name, x.size || 18));
  }

  var toastTimer = null;
  function toast(text, kind) {
    var t = $('dp-toast');
    t.textContent = text;
    t.className = 'dp-toast' + (kind === 'error' ? ' is-error' : '');
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, kind === 'error' ? 6000 : 3000);
  }

  /** Copies text: a hidden text area + execCommand (works in a sandboxed frame during the click), then navigator.clipboard. */
  function copyText(text) {
    var value = String(text == null ? '' : text);
    var ok = false;
    var ta = h('textarea', { class: 'dp-clip', attrs: { readonly: true, 'aria-hidden': 'true', tabindex: '-1' } });
    ta.value = value;
    document.body.appendChild(ta);
    try { ta.select(); ta.setSelectionRange(0, value.length); ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (ok) { toast(T('p.copied')); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () { toast(T('p.copied')); }, function () { toast(T('p.copy_failed'), 'error'); });
      return;
    }
    toast(T('p.copy_failed'), 'error');
  }

  // ── formats ──────────────────────────────────────────────

  function fmtSize(n) {
    var b = Number(n) || 0;
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
    var digits = i === 0 || b >= 100 ? 0 : 1;
    return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(b) + ' ' + units[i];
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return T('p.today_at', { time: d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }) });
    return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  }
  function personName(id) {
    if (id == null) return '';
    var p = S.people.get(id);
    return p ? p : '';
  }
  /** folder | image | video | audio | pdf | doc */
  function kindOf(n) {
    if (n.isDir) return 'folder';
    var m = String(n.mime || '');
    if (/^image\//.test(m)) return 'image';
    if (/^video\//.test(m)) return 'video';
    if (/^audio\//.test(m)) return 'audio';
    if (m === 'application/pdf') return 'pdf';
    return 'doc';
  }
  function extOf(name) {
    var i = String(name).lastIndexOf('.');
    return i > 0 && name.length - i <= 6 ? name.slice(i + 1).toUpperCase() : '';
  }
  var KIND_ICON = { folder: 'folder', image: 'image', video: 'video', audio: 'audio', pdf: 'file', doc: 'file' };

  // ── API ──────────────────────────────────────────────────

  function codeErr(code, extra) { var e = new Error(code); e.code = code; e.extra = extra || null; return e; }
  function qs(q) {
    if (!q) return '';
    var parts = Object.keys(q).filter(function (k) { return q[k] != null && q[k] !== ''; }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(String(q[k])); });
    return parts.length ? '?' + parts.join('&') : '';
  }
  function api(method, path, body, query) {
    if (!window.GC || typeof window.GC.call !== 'function') return Promise.reject(codeErr('network'));
    return window.GC.call(method, path + qs(query), body).then(function (r) {
      if (!r || r.ok !== true) throw codeErr((r && typeof r.code === 'string' && r.code) || 'failed', r);
      return r;
    }, function (e) {
      var d = e && e.data;
      throw codeErr((d && typeof d.code === 'string' && d.code) || (e && typeof e.code === 'string' && e.code) || (e && e.status === 0 ? 'network' : 'failed'), d || null);
    });
  }
  function errText(e) {
    var code = (e && e.code) || 'failed';
    if (e && e.extra && typeof e.extra.error === 'string' && e.extra.error) return e.extra.error;
    var k = 'err.' + code;
    return CTX.texts && CTX.texts[k] ? T(k) : T('err.generic', { code: code });
  }
  function fail(e) { toast(errText(e), 'error'); }

  // ── state ────────────────────────────────────────────────

  var S = {
    me: null,
    areas: [],            // from GET me / GET areas
    storage: new Map(),   // area id → storage
    people: new Map(),    // user id → name
    page: 'files',        // files · trash · links · search
    areaId: null,
    folder: null,         // the node shown (GET nodes/<id>) with crumbs and role
    items: [],
    total: 0,
    next: null,
    view: 'grid',
    sort: 'name',
    order: 'asc',
    q: '',
    meSettings: null,
    linksEnabled: true,
    seq: 0,               // guards against an older answer arriving last
    uploads: [],
    uploading: false,
    conflictAll: null,    // 'version' | 'rename' | 'skip' — the choice "for all" of this batch
  };

  function areaOf(id) { for (var i = 0; i < S.areas.length; i++) if (S.areas[i].id === id) return S.areas[i]; return null; }
  function canWrite() { return !!(S.folder && (S.folder.role === 'write' || S.folder.role === 'manage')); }

  // ── screens ──────────────────────────────────────────────

  function message(title, text) {
    var m = $('dp-msg');
    clear(m);
    add(m, [icon('cloud', 34), h('b', { text: title }), text ? h('span', { class: 'dp-muted', text: text }) : null]);
    m.hidden = false;
    $('dp-app').hidden = true;
  }

  function boot() {
    if (!CTX.loggedIn) { message(T('p.login_title'), T('p.login_text')); return; }
    message(T('p.loading'), '');
    api('GET', 'me').then(function (r) {
      S.me = r.me;
      S.meSettings = r.settings || null;
      (r.people || []).forEach(function (p) { S.people.set(p.id, p.name); });
      if (!r.licence || !r.licence.valid) { message(T('p.unlicensed_title'), T('p.unlicensed_text')); return; }
      if (!r.me || !r.me.seat) { message(T('p.noseat_title'), T('p.noseat_text')); return; }
      S.areas = r.areas || [];
      $('dp-msg').hidden = true;
      $('dp-app').hidden = false;
      setupChrome();
      var first = areaOf('mine:' + r.me.id) || S.areas[0];
      if (first) openFolder(first.id, first.rootId);
      loadStorage();
      live();
    }, function (e) { message(T('p.failed_title'), errText(e)); });
  }

  function setupChrome() {
    var si = $('dp-search-ic');
    clear(si);
    si.appendChild(icon('search'));
    var q = $('dp-q');
    var timer = null;
    q.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        var v = q.value.trim();
        if (v.length >= 2) search(v);
        else if (S.page === 'search') openFolder(S.areaId, S.folder ? S.folder.id : null);
      }, 300);
    });
    $('dp-file').addEventListener('change', function (ev) {
      var files = [].slice.call((ev.target && ev.target.files) || []);
      ev.target.value = '';
      if (files.length) enqueue(files.map(function (f) { return { file: f, dirs: [] }; }));
    });
    setupDrop();
  }

  function loadStorage() {
    api('GET', 'areas').then(function (r) {
      (r.areas || []).forEach(function (a) { S.storage.set(a.id, a.storage || null); });
      renderNav();
    }, function () { /* the meter stays empty */ });
  }

  // ── navigation ───────────────────────────────────────────

  function renderNav() {
    var nav = $('dp-nav');
    clear(nav);
    S.areas.forEach(function (a) {
      var cur = S.page === 'files' && S.areaId === a.id;
      nav.appendChild(h('button', { type: 'button', attrs: { 'aria-current': cur ? 'page' : null }, on: { click: function () { $('dp-q').value = ''; openFolder(a.id, a.rootId); } } },
        [icon(a.kind === 'mine' ? 'cloud' : 'folder'), h('span', { text: a.label })]));
    });
    nav.appendChild(h('hr'));
    nav.appendChild(h('button', { type: 'button', attrs: { 'aria-current': S.page === 'links' ? 'page' : null }, on: { click: showLinks } }, [icon('link'), h('span', { text: T('p.links') })]));
    nav.appendChild(h('button', { type: 'button', attrs: { 'aria-current': S.page === 'trash' ? 'page' : null }, on: { click: showTrash } }, [icon('trash'), h('span', { text: T('p.trash') })]));
    var a = areaOf(S.areaId);
    var st = a ? S.storage.get(a.id) : null;
    if (a && st && S.page === 'files') {
      var pct = st.quota ? Math.min(100, Math.round((st.bytes / st.quota) * 100)) : 0;
      nav.appendChild(h('div', { class: 'dp-store' }, [
        h('span', { text: a.label + (st.target && st.target.label ? ' · ' + st.target.label : '') }),
        st.quota ? h('div', { class: 'dp-meter', attrs: { role: 'img', 'aria-label': T('p.used_of', { used: fmtSize(st.bytes), quota: fmtSize(st.quota) }) } }, h('span', { attrs: { style: 'width:' + pct + '%' } })) : null,
        h('span', { text: st.quota ? T('p.used_of', { used: fmtSize(st.bytes), quota: fmtSize(st.quota) }) : T('p.used', { used: fmtSize(st.bytes) }) }),
      ]));
    }
  }

  function renderCrumbs() {
    var c = $('dp-crumbs');
    clear(c);
    if (S.page !== 'files' || !S.folder) {
      c.appendChild(h('button', { type: 'button', attrs: { 'aria-current': 'page' }, text: S.page === 'trash' ? T('p.trash') : S.page === 'links' ? T('p.links') : T('p.results', { q: S.q }) }));
      return;
    }
    var a = areaOf(S.areaId);
    var parts = S.folder.crumbs.concat([{ id: S.folder.id, name: S.folder.name }]);
    parts.forEach(function (x, i) {
      if (i) c.appendChild(h('span', { class: 'dp-sep', text: '›', attrs: { 'aria-hidden': 'true' } }));
      var label = i === 0 ? (a ? a.label : '') : x.name;
      var last = i === parts.length - 1;
      c.appendChild(h('button', { type: 'button', text: label, attrs: { 'aria-current': last ? 'page' : null }, on: { click: last ? null : function () { openFolder(S.areaId, x.id); } } }));
    });
  }

  function renderTools() {
    var t = $('dp-tools');
    clear(t);
    if (S.page !== 'files') return;
    t.appendChild(ibtn('grid', T('p.view_grid'), function () { S.view = 'grid'; renderMain(); renderTools(); }, { pressed: S.view === 'grid' }));
    t.appendChild(ibtn('list', T('p.view_list'), function () { S.view = 'list'; renderMain(); renderTools(); }, { pressed: S.view === 'list' }));
    var sel = h('select', { class: 'dp-input dp-btn-sm', attrs: { 'aria-label': T('p.sort') }, on: { change: function (ev) { var v = ev.target.value.split(':'); S.sort = v[0]; S.order = v[1]; reload(); } } },
      [['name:asc', T('p.sort_name')], ['updated:desc', T('p.sort_new')], ['size:desc', T('p.sort_size')]].map(function (o) { return h('option', { value: o[0], text: o[1], selected: o[0] === S.sort + ':' + S.order }); }));
    sel.style.width = 'auto';
    t.appendChild(sel);
    if (canWrite()) {
      t.appendChild(btn(T('p.new_folder'), newFolder, { icon: 'plus' }));
      t.appendChild(btn(T('p.upload'), function () { $('dp-file').click(); }, { icon: 'upload', primary: true }));
    }
  }

  // ── a folder ─────────────────────────────────────────────

  function openFolder(areaId, folderId) {
    if (!areaId || !folderId) return;
    var seq = ++S.seq;
    S.page = 'files';
    S.areaId = areaId;
    return Promise.all([
      api('GET', 'nodes/' + folderId),
      api('GET', 'nodes/' + folderId + '/children', null, { sort: S.sort, order: S.order, limit: PAGE, thumbs: 1 }),
    ]).then(function (r) {
      if (seq !== S.seq) return;
      S.folder = r[0].node;
      S.items = r[1].items || [];
      S.total = r[1].total || 0;
      S.next = r[1].next;
      renderAll();
    }, function (e) {
      if (seq !== S.seq) return;
      fail(e);
      // the folder is gone (deleted elsewhere): back to the area's top
      var a = areaOf(areaId);
      if (e && e.code === 'not_found' && a && folderId !== a.rootId) openFolder(areaId, a.rootId);
    });
  }
  function reload() { if (S.page === 'files' && S.folder) return openFolder(S.areaId, S.folder.id); return Promise.resolve(); }

  function loadMore() {
    if (S.next == null || !S.folder) return;
    api('GET', 'nodes/' + S.folder.id + '/children', null, { sort: S.sort, order: S.order, limit: PAGE, offset: S.next, thumbs: 1 }).then(function (r) {
      S.items = S.items.concat(r.items || []);
      S.next = r.next;
      renderMain();
    }, fail);
  }

  function renderAll() { renderNav(); renderCrumbs(); renderTools(); renderMain(); }

  function renderMain() {
    var main = $('dp-main');
    clear(main);
    if (S.page === 'files' && S.folder && S.folder.role === 'read' && areaOf(S.areaId) && areaOf(S.areaId).via === 'parent') {
      main.appendChild(h('div', { class: 'dp-note' }, [icon('info'), h('span', { text: T('p.parent_note') })]));
    }
    if (!S.items.length) {
      main.appendChild(h('div', { class: 'dp-empty', text: S.page === 'search' ? T('p.no_results') : canWrite() ? T('p.empty_write') : T('p.empty') }));
      return;
    }
    main.appendChild(S.view === 'list' || S.page === 'search' ? listOf(S.items) : gridOf(S.items));
    if (S.next != null && S.page === 'files') main.appendChild(h('div', { class: 'dp-more-row' }, btn(T('p.more'), loadMore)));
  }

  function metaOf(n) {
    if (n.isDir) return fmtDate(n.updatedAt);
    return fmtSize(n.size) + ' · ' + fmtDate(n.mtime || n.updatedAt);
  }

  function thumbOf(n, cls) {
    var k = kindOf(n);
    if (k === 'image' && n.thumb) return h('img', { attrs: { src: n.thumb, alt: '', loading: 'lazy' } });
    var box = h('span', { class: cls || '' }, [icon(KIND_ICON[k], cls ? 16 : 30)]);
    return box;
  }

  function gridOf(items) {
    var g = h('div', { class: 'dp-grid', attrs: { role: 'list' } });
    items.forEach(function (n) {
      var thumb = h('div', { class: 'dp-thumb' }, [n.isDir || kindOf(n) !== 'image' || !n.thumb ? icon(KIND_ICON[kindOf(n)], 34) : h('img', { attrs: { src: n.thumb, alt: '', loading: 'lazy' } })]);
      var ext = extOf(n.name);
      g.appendChild(h('div', { class: 'dp-card', attrs: { role: 'listitem' } }, [
        h('button', { type: 'button', class: 'dp-open', on: { click: function () { openNode(n); } }, attrs: { 'aria-label': n.name } }, [
          thumb,
          h('div', { class: 'dp-card-tx' }, [
            h('span', { class: 'dp-name', text: n.name, attrs: { title: n.name } }),
            h('span', { class: 'dp-meta' }, [!n.isDir && ext ? h('span', { class: 'dp-badge', text: ext }) : null, ' ', metaOf(n)]),
          ]),
        ]),
        ibtn('more', T('p.actions_for', { name: n.name }), function () { actions(n); }, { cls: 'dp-more' }),
      ]));
    });
    return g;
  }

  function listOf(items) {
    var l = h('div', { class: 'dp-list', attrs: { role: 'table' } });
    l.appendChild(h('div', { class: 'dp-row dp-head', attrs: { role: 'row' } }, [
      h('span', { text: T('p.col_name'), attrs: { role: 'columnheader' } }), h('span', { class: 'dp-num', text: T('p.col_changed'), attrs: { role: 'columnheader' } }),
      h('span', { class: 'dp-num dp-right', text: T('p.col_size'), attrs: { role: 'columnheader' } }), h('span'),
    ]));
    items.forEach(function (n) {
      var ic = h('span', { class: 'dp-ic' }, [kindOf(n) === 'image' && n.thumb ? h('img', { attrs: { src: n.thumb, alt: '', loading: 'lazy' } }) : icon(KIND_ICON[kindOf(n)])]);
      l.appendChild(h('div', { class: 'dp-row', attrs: { role: 'row' } }, [
        h('button', { type: 'button', class: 'dp-open', on: { click: function () { openNode(n); } } }, [ic, h('span', { class: 'dp-name', text: n.name, attrs: { title: n.name } }),
          n.path && S.page === 'search' ? h('span', { class: 'dp-meta', text: n.path }) : null]),
        h('span', { class: 'dp-num', text: fmtDate(n.mtime || n.updatedAt) }),
        h('span', { class: 'dp-num dp-right', text: n.isDir ? '—' : fmtSize(n.size) }),
        ibtn('more', T('p.actions_for', { name: n.name }), function () { actions(n); }),
      ]));
    });
    return l;
  }

  function openNode(n) {
    if (n.isDir) { $('dp-q').value = ''; openFolder(n.areaId, n.id); return; }
    preview(n);
  }

  // ── dialogs ──────────────────────────────────────────────

  var lastFocus = null;
  function dialog(title, body, o) {
    var x = o || {};
    var back = $('dp-dialog');
    clear(back);
    lastFocus = document.activeElement;
    var box = h('div', { class: 'dp-dialog' + (x.wide ? ' is-wide' : ''), attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title } }, [
      h('div', { attrs: { style: 'display:flex;align-items:flex-start;gap:12px' } }, [
        h('div', { attrs: { style: 'flex:1;min-width:0;display:flex;flex-direction:column;gap:12px' } }, [h('h3', { text: title }), x.sub ? h('p', { class: 'dp-dialog-sub', text: x.sub }) : null]),
        ibtn('close', T('p.close'), closeDialog),
      ]),
    ].concat(body || []));
    back.appendChild(box);
    back.hidden = false;
    return box;
  }
  function closeDialog() {
    var back = $('dp-dialog');
    back.hidden = true;
    clear(back);
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* gone */ } }
  }
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !$('dp-dialog').hidden) closeDialog(); });

  /** A name: { title, label, value, ok } → onOk(name) (a promise; its error shows in the dialog). */
  function askName(title, value, okLabel, onOk) {
    var input = h('input', { class: 'dp-input', type: 'text', value: value || '', attrs: { maxlength: '255', 'aria-label': T('p.name') } });
    var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    var go = function () {
      err.textContent = '';
      var v = input.value.trim();
      if (!v) { err.textContent = T('err.invalid'); return; }
      onOk(v).then(closeDialog, function (e) { err.textContent = errText(e); });
    };
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go(); });
    dialog(title, [h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.name') }), input]), err,
      h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(okLabel, go, { primary: true })])]);
    input.focus();
    var dot = value ? value.lastIndexOf('.') : -1;
    try { input.setSelectionRange(0, dot > 0 ? dot : (value || '').length); } catch (e) { /* not a text field */ }
  }

  function confirmDialog(title, text, okLabel, onOk, danger) {
    var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    dialog(title, [h('p', { class: 'dp-hint', text: text }), err, h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog),
      btn(okLabel, function () { onOk().then(closeDialog, function (e) { err.textContent = errText(e); }); }, { primary: !danger, danger: !!danger })])]);
  }

  // ── actions of a node ────────────────────────────────────

  function actions(n) {
    var write = canWriteNode(n);
    var k = kindOf(n);
    var items = [];
    var item = function (ic, label, fn, danger) { items.push(h('button', { type: 'button', class: danger ? 'is-danger' : '', on: { click: function () { closeDialog(); fn(); } } }, [icon(ic), h('span', { text: label })])); };
    if (n.isDir) item('folder', T('p.open'), function () { openNode(n); });
    else if (k === 'image' || k === 'video' || k === 'audio') item('eye', T('p.preview'), function () { preview(n); });
    if (!n.isDir) item('download', T('p.download'), function () { download(n); });
    if (S.page === 'search') item('folder', T('p.show_in_folder'), function () { $('dp-q').value = ''; openFolder(n.areaId, n.parentId); });
    if (write) item('share', T('p.share'), function () { share(n); });
    if (write) item('edit', T('p.rename'), function () { rename(n); });
    if (write) item('move', T('p.move'), function () { moveDialog(n); });
    if (!n.isDir) item('history', T('p.versions'), function () { versions(n); });
    if (write) item('trash', T('p.to_trash'), function () { toTrash(n); }, true);
    dialog(n.name, [h('div', { class: 'dp-menu' }, items)], { sub: n.isDir ? T('p.folder') : fmtSize(n.size) + ' · ' + fmtDate(n.mtime || n.updatedAt) });
  }
  function canWriteNode(n) {
    var a = areaOf(n.areaId);
    return !!(a && !a.archived && (a.role === 'write' || a.role === 'manage'));
  }

  function newFolder() {
    askName(T('p.new_folder'), T('p.new_folder_name'), T('p.create'), function (name) {
      return api('POST', 'nodes', { parentId: S.folder.id, name: name }).then(function () { reload(); });
    });
  }
  function rename(n) {
    askName(T('p.rename'), n.name, T('p.save'), function (name) {
      return api('PATCH', 'nodes/' + n.id, { name: name }).then(function () { reload(); toast(T('p.renamed')); });
    });
  }
  function toTrash(n) {
    confirmDialog(T('p.to_trash'), T(n.isDir ? 'p.to_trash_folder' : 'p.to_trash_file', { name: n.name, days: (S.meSettings && S.meSettings.trashDays) || 30 }), T('p.to_trash'), function () {
      return api('DELETE', 'nodes/' + n.id).then(function () { reload(); loadStorage(); toast(T('p.trashed', { name: n.name })); });
    }, true);
  }

  function download(n) {
    api('GET', 'nodes/' + n.id + '/content').then(function (r) {
      // pictures, videos and sound are shown inline by GateControl: the preview has them; other files download
      if (/^(image|video|audio)\//.test(String(r.mime || ''))) { preview(n, r); return; }
      var a = h('a', { attrs: { href: r.url, download: r.name || n.name, rel: 'noopener' } });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }, fail);
  }

  function preview(n, got) {
    var k = kindOf(n);
    var show = function (r) {
      var media = k === 'image' ? h('img', { attrs: { src: r.url, alt: n.name } })
        : k === 'video' ? h('video', { attrs: { src: r.url, controls: true, preload: 'metadata' } })
          : k === 'audio' ? h('audio', { attrs: { src: r.url, controls: true, preload: 'metadata' } })
            : h('div', { class: 'dp-empty', text: T('p.no_preview') });
      var acts = [];
      if (k !== 'image' && k !== 'video' && k !== 'audio') acts.push(btn(T('p.download'), function () { download(n); }, { icon: 'download', primary: true }));
      if (canWriteNode(n)) acts.push(btn(T('p.share'), function () { share(n); }, { icon: 'share' }));
      acts.push(btn(T('p.versions'), function () { versions(n); }, { icon: 'history' }));
      dialog(n.name, [h('div', { class: 'dp-preview' }, media), (k === 'image' || k === 'video') ? h('p', { class: 'dp-hint', text: T('p.save_hint') }) : null, h('div', { class: 'dp-actions' }, acts)],
        { wide: true, sub: fmtSize(n.size) + ' · ' + fmtDate(n.mtime || n.updatedAt) + (n.updatedBy ? ' · ' + personName(n.updatedBy) : '') });
    };
    if (got) { show(got); return; }
    api('GET', 'nodes/' + n.id + '/content').then(show, fail);
  }

  // ── move ─────────────────────────────────────────────────

  function moveDialog(n) {
    var target = { areaId: n.areaId, folderId: null, crumbs: [] };
    var picker = h('div', { class: 'dp-picker', attrs: { role: 'list' } });
    var where = h('p', { class: 'dp-hint' });
    var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    var areaSel = h('select', { class: 'dp-input', attrs: { 'aria-label': T('p.area') }, on: { change: function (ev) { var a = areaOf(ev.target.value); go(a.id, a.rootId); } } },
      S.areas.filter(function (a) { return !a.archived && (a.role === 'write' || a.role === 'manage'); }).map(function (a) { return h('option', { value: a.id, text: a.label, selected: a.id === n.areaId }); }));
    var go = function (areaId, folderId) {
      target.areaId = areaId;
      target.folderId = folderId;
      Promise.all([api('GET', 'nodes/' + folderId), api('GET', 'nodes/' + folderId + '/children', null, { limit: 1000 })]).then(function (r) {
        clear(picker);
        var node = r[0].node;
        target.crumbs = node.crumbs.concat([{ id: node.id, name: node.name }]);
        where.textContent = T('p.move_to', { path: [areaOf(areaId).label].concat(target.crumbs.slice(1).map(function (c) { return c.name; })).join(' › ') });
        if (node.parentId != null) picker.appendChild(h('button', { type: 'button', on: { click: function () { go(areaId, node.parentId); } } }, [icon('up'), h('span', { text: T('p.up') })]));
        (r[1].items || []).filter(function (x) { return x.isDir && x.id !== n.id; }).forEach(function (x) {
          picker.appendChild(h('button', { type: 'button', attrs: { role: 'listitem' }, on: { click: function () { go(areaId, x.id); } } }, [icon('folder'), h('span', { text: x.name })]));
        });
        if (!picker.firstChild) picker.appendChild(h('p', { class: 'dp-hint', text: T('p.no_folders'), attrs: { style: 'padding:12px' } }));
      }, function (e) { err.textContent = errText(e); });
    };
    dialog(T('p.move_title', { name: n.name }), [h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.area') }), areaSel]), where, picker, err,
      h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(T('p.move_here'), function () {
        if (!target.folderId) return;
        api('PATCH', 'nodes/' + n.id, { parentId: target.folderId }).then(function () { closeDialog(); reload(); loadStorage(); toast(T('p.moved')); }, function (e) { err.textContent = errText(e); });
      }, { primary: true })])]);
    var a = areaOf(n.areaId);
    go(n.areaId, n.parentId || (a && a.rootId));
  }

  // ── versions ─────────────────────────────────────────────

  function versions(n) {
    api('GET', 'nodes/' + n.id + '/versions').then(function (r) {
      var write = canWriteNode(n);
      var rows = (r.versions || []).map(function (v) {
        return h('tr', null, [
          h('td', { text: fmtDate(v.at) }), h('td', { text: v.by != null ? personName(v.by) : T('p.nas') }), h('td', { class: 'dp-num', text: fmtSize(v.size) }),
          h('td', { class: 'dp-right' }, [
            btn(T('p.open'), function () { api('GET', 'nodes/' + n.id + '/versions/' + v.id + '/content').then(function (c) { if (/^(image|video|audio)\//.test(String(c.mime || ''))) preview(n, c); else { var a = h('a', { attrs: { href: c.url, download: n.name } }); document.body.appendChild(a); a.click(); document.body.removeChild(a); } }, fail); }, { small: true }),
            write ? btn(T('p.restore'), function () { api('POST', 'nodes/' + n.id + '/versions/' + v.id + '/restore').then(function () { closeDialog(); reload(); toast(T('p.version_restored')); }, fail); }, { small: true }) : null,
            write ? btn(T('p.delete'), function () { api('DELETE', 'nodes/' + n.id + '/versions/' + v.id).then(function () { versions(n); }, fail); }, { small: true, danger: true }) : null,
          ]),
        ]);
      });
      var cur = r.current;
      dialog(T('p.versions_of', { name: n.name }), [
        h('p', { class: 'dp-hint', text: T('p.current_version', { date: fmtDate(cur.updatedAt), size: fmtSize(cur.size), who: personName(cur.updatedBy) || T('p.nas') }) }),
        rows.length ? h('div', { attrs: { style: 'overflow-x:auto' } }, h('table', { class: 'dp-table' }, [h('thead', null, h('tr', null, [h('th', { text: T('p.col_changed') }), h('th', { text: T('p.col_by') }), h('th', { text: T('p.col_size') }), h('th')])), h('tbody', null, rows)]))
          : h('p', { class: 'dp-hint', text: T('p.no_versions') }),
      ], { wide: true });
    }, fail);
  }

  // ── sharing ──────────────────────────────────────────────

  function pin4() {
    var a = new Uint32Array(1);
    window.crypto.getRandomValues(a);
    return String(1000 + (a[0] % 9000));
  }

  function share(n) {
    var st = { mode: 'download', expires: '7d', pin: false, pinValue: pin4() };
    var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    var result = h('div');
    var existing = h('div', { class: 'dp-links' });
    var seg = function (opts, key) {
      var box = h('div', { class: key === 'expires' ? 'dp-chips' : 'dp-seg', attrs: { role: 'group' } });
      var draw = function () {
        clear(box);
        opts.forEach(function (o) {
          box.appendChild(h('button', { type: 'button', text: o[1], disabled: !!o[2], attrs: { 'aria-pressed': String(st[key] === o[0]) }, on: { click: function () { st[key] = o[0]; draw(); } } }));
        });
      };
      draw();
      return box;
    };
    var modes = [['view', T('p.mode_view')], ['download', T('p.mode_download')], ['upload', T('p.mode_upload'), !n.isDir]];
    var pinInput = h('input', { class: 'dp-input dp-pin', type: 'text', value: st.pinValue, hidden: true, attrs: { inputmode: 'numeric', maxlength: '8', 'aria-label': T('p.pin') } });
    var pinBox = h('input', { type: 'checkbox', on: { change: function (ev) { st.pin = !!ev.target.checked; pinInput.hidden = !st.pin; } } });
    var create = function () {
      err.textContent = '';
      var pinV = st.pin ? String(pinInput.value || '').trim() : '';
      if (st.pin && !/^\d{4,8}$/.test(pinV)) { err.textContent = T('err.pin'); return; }
      api('POST', 'links', { nodeId: n.id, mode: st.mode, expires: st.expires, pin: pinV || undefined }).then(function (r) {
        showLink(result, r.link, pinV);
        loadExisting();
      }, function (e) { err.textContent = errText(e); });
    };
    var loadExisting = function () {
      api('GET', 'links', null, { nodeId: n.id }).then(function (r) {
        clear(existing);
        var act = (r.links || []).filter(function (l) { return l.active; });
        if (act.length) existing.appendChild(h('span', { class: 'dp-label', text: T('p.links_active') }));
        act.forEach(function (l) { existing.appendChild(linkRow(l, loadExisting)); });
        if (r.enabled === false) existing.appendChild(h('div', { class: 'dp-note is-warn' }, [icon('info'), h('span', { text: T('err.links_disabled') })]));
      }, function () { /* the list stays empty */ });
    };
    dialog(T('p.share_title', { name: n.name }), [
      h('p', { class: 'dp-dialog-sub', text: n.isDir ? T('p.share_sub_folder') : T('p.share_sub_file') }),
      h('div', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.share_what') }), seg(modes, 'mode')]),
      h('div', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.share_valid') }), seg([['1d', T('p.days_1')], ['7d', T('p.days_7')], ['30d', T('p.days_30')], ['never', T('p.days_never')]], 'expires')]),
      h('div', { attrs: { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' } }, [h('label', { class: 'dp-check' }, [pinBox, h('span', { text: T('p.pin_ask') })]), pinInput]),
      err,
      h('div', { class: 'dp-actions' }, [btn(T('p.share_create'), create, { primary: true, icon: 'link' })]),
      result,
      existing,
      h('p', { class: 'dp-hint', text: T('p.share_note') }),
    ]);
    loadExisting();
  }

  function showLink(box, link, pin) {
    clear(box);
    if (!link || !link.url) return;
    add(box, [
      h('div', { class: 'dp-url' }, [h('span', { text: link.url, attrs: { title: link.url } }), btn(T('p.copy'), function () { copyText(link.url); }, { primary: true })]),
      pin ? h('p', { class: 'dp-hint', text: T('p.pin_tell', { pin: pin }) }) : null,
    ]);
  }

  function linkKind(l) { return l.kind === 'upload' ? T('p.mode_upload') : l.mode === 'view' ? T('p.mode_view') : T('p.mode_download'); }

  function linkRow(l, after) {
    var stateLabel = T('p.state_' + (l.state || 'gone'));
    return h('div', { class: 'dp-link' }, [
      h('div', { class: 'dp-link-tx' }, [
        h('span', { class: 'dp-name', text: l.name || l.title || '' }),
        h('span', { class: 'dp-meta', text: [linkKind(l), l.expiresAt ? T('p.until', { date: fmtDate(l.expiresAt) }) : T('p.days_never'), l.pin ? T('p.with_pin') : null,
          P('p.opens', l.opens || 0), l.kind === 'upload' && l.upload ? P('p.uploaded', l.upload.files || 0) : P('p.downloads', l.downloads || 0)].filter(Boolean).join(' · ') }),
      ]),
      h('span', { class: 'dp-state' + (l.active ? ' is-active' : ''), text: l.endedWhy && !l.active ? T('p.ended_' + l.endedWhy) : stateLabel }),
      l.active && l.url ? ibtn('copy', T('p.copy'), function () { copyText(l.url); }) : null,
      ibtn('history', T('p.log'), function () { linkLog(l); }),
      l.active ? btn(T('p.end'), function () { api('DELETE', 'links/' + encodeURIComponent(l.token)).then(function () { toast(T('p.link_ended')); after(); }, fail); }, { small: true, danger: true }) : null,
    ]);
  }

  function linkLog(l) {
    api('GET', 'links/' + encodeURIComponent(l.token) + '/events').then(function (r) {
      var rows = (r.events || []).map(function (e) {
        return h('tr', null, [h('td', { text: fmtDate(e.at) }), h('td', { text: T('p.ev_' + e.kind) }), h('td', { text: e.name || e.uploader || '' }), h('td', { class: 'dp-num', text: e.ip || '' })]);
      });
      dialog(T('p.log_of', { name: l.name || l.title || '' }), [rows.length
        ? h('div', { attrs: { style: 'overflow-x:auto' } }, h('table', { class: 'dp-table' }, [h('thead', null, h('tr', null, [h('th', { text: T('p.col_when') }), h('th', { text: T('p.col_what') }), h('th', { text: T('p.col_file') }), h('th', { text: T('p.col_address') })])), h('tbody', null, rows)]))
        : h('p', { class: 'dp-hint', text: T('p.log_empty') })], { wide: true });
    }, fail);
  }

  // ── pages: shared links, trash, search ───────────────────

  function showLinks() {
    $('dp-q').value = '';
    S.page = 'links';
    S.seq++;
    renderNav(); renderCrumbs(); renderTools();
    var main = $('dp-main');
    clear(main);
    api('GET', 'links').then(function (r) {
      if (S.page !== 'links') return;
      clear(main);
      if (r.enabled === false) main.appendChild(h('div', { class: 'dp-note is-warn' }, [icon('info'), h('span', { text: T('err.links_disabled') })]));
      var list = r.links || [];
      if (!list.length) { main.appendChild(h('div', { class: 'dp-empty', text: T('p.links_none') })); return; }
      var box = h('div', { class: 'dp-links' });
      list.forEach(function (l) { box.appendChild(linkRow(l, showLinks)); });
      main.appendChild(box);
    }, fail);
  }

  function showTrash() {
    $('dp-q').value = '';
    S.page = 'trash';
    S.seq++;
    renderNav(); renderCrumbs(); renderTools();
    var main = $('dp-main');
    clear(main);
    api('GET', 'trash').then(function (r) {
      if (S.page !== 'trash') return;
      clear(main);
      var items = r.items || [];
      main.appendChild(h('p', { class: 'dp-hint', text: T('p.trash_note', { days: (S.meSettings && S.meSettings.trashDays) || 30 }), attrs: { style: 'margin-bottom:12px' } }));
      if (!items.length) { main.appendChild(h('div', { class: 'dp-empty', text: T('p.trash_empty') })); return; }
      var l = h('div', { class: 'dp-list' });
      items.forEach(function (n) {
        var a = areaOf(n.areaId);
        l.appendChild(h('div', { class: 'dp-row', attrs: { style: 'grid-template-columns:minmax(0,1fr) auto' } }, [
          h('div', { attrs: { style: 'display:flex;gap:10px;align-items:center;min-width:0' } }, [h('span', { class: 'dp-ic' }, icon(KIND_ICON[kindOf(n)])),
            h('div', { attrs: { style: 'display:flex;flex-direction:column;min-width:0' } }, [h('span', { class: 'dp-name', text: n.name }),
              h('span', { class: 'dp-meta', text: [(a ? a.label : '') + (n.from ? ' › ' + n.from : ''), T('p.deleted_at', { date: fmtDate(n.deletedAt), who: personName(n.deletedBy) }), n.isDir ? P('p.files_n', n.files || 0) : fmtSize(n.size)].join(' · ') })])]),
          h('div', { class: 'dp-actions' }, [
            btn(T('p.restore'), function () { api('POST', 'trash/' + n.id + '/restore').then(function () { toast(T('p.restored', { name: n.name })); showTrash(); loadStorage(); }, fail); }, { small: true, icon: 'restore' }),
            btn(T('p.delete_forever'), function () {
              confirmDialog(T('p.delete_forever'), T('p.delete_forever_text', { name: n.name }), T('p.delete_forever'), function () {
                return api('DELETE', 'trash/' + n.id).then(function () { showTrash(); loadStorage(); });
              }, true);
            }, { small: true, danger: true }),
          ]),
        ]));
      });
      main.appendChild(l);
    }, fail);
  }

  function search(q) {
    var seq = ++S.seq;
    S.page = 'search';
    S.q = q;
    api('GET', 'search', null, { q: q }).then(function (r) {
      if (seq !== S.seq) return;
      S.items = r.items || [];
      S.next = null;
      renderAll();
    }, function (e) { if (seq === S.seq) fail(e); });
  }

  // ── uploads ──────────────────────────────────────────────

  function setupDrop() {
    var root = $('dp-root');
    var zone = $('dp-drop');
    var depth = 0;
    var hasFiles = function (ev) { var t = ev.dataTransfer && ev.dataTransfer.types; return !!t && [].indexOf.call(t, 'Files') >= 0; };
    root.addEventListener('dragenter', function (ev) { if (!hasFiles(ev) || !canWrite() || S.page !== 'files') return; ev.preventDefault(); depth++; zone.hidden = false; });
    root.addEventListener('dragover', function (ev) { if (!hasFiles(ev) || !canWrite() || S.page !== 'files') return; ev.preventDefault(); if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'; });
    root.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) zone.hidden = true; });
    root.addEventListener('drop', function (ev) {
      depth = 0;
      zone.hidden = true;
      if (!hasFiles(ev) || !canWrite() || S.page !== 'files') return;
      ev.preventDefault();
      collect(ev.dataTransfer).then(function (list) { if (list.length) enqueue(list); });
    });
  }

  /** The dropped files, folders walked (webkitGetAsEntry) → [{ file, dirs: ['Ordner', 'Unterordner'] }]. */
  function collect(dt) {
    var items = dt.items ? [].slice.call(dt.items) : [];
    var entries = items.map(function (it) { return it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; }).filter(Boolean);
    if (!entries.length) return Promise.resolve([].slice.call(dt.files || []).map(function (f) { return { file: f, dirs: [] }; }));
    var out = [];
    var walk = function (entry, dirs) {
      if (entry.isFile) return new Promise(function (res) { entry.file(function (f) { out.push({ file: f, dirs: dirs }); res(); }, function () { res(); }); });
      if (!entry.isDirectory) return Promise.resolve();
      var reader = entry.createReader();
      var all = [];
      var more = function () {
        return new Promise(function (res) { reader.readEntries(function (batch) { res(batch); }, function () { res([]); }); }).then(function (batch) {
          if (!batch.length) return null;
          all = all.concat(batch);
          return more();
        });
      };
      return more().then(function () { return all.reduce(function (p, e) { return p.then(function () { return walk(e, dirs.concat([entry.name])); }); }, Promise.resolve()); });
    };
    return entries.reduce(function (p, e) { return p.then(function () { return walk(e, []); }); }, Promise.resolve()).then(function () { return out; });
  }

  function enqueue(list) {
    var target = { areaId: S.areaId, folderId: S.folder.id };
    list.forEach(function (x) { S.uploads.push({ file: x.file, dirs: x.dirs, target: target, state: 'waiting', loaded: 0, error: null }); });
    S.conflictAll = null;
    renderUploads();
    pump();
  }

  var folderCache = {};
  /** The folder dirs below target.folderId (made where missing) → its id. */
  function folderFor(target, dirs) {
    var key = target.folderId + '/' + dirs.join('/');
    if (!dirs.length) return Promise.resolve(target.folderId);
    if (folderCache[key]) return folderCache[key];
    var p = folderFor(target, dirs.slice(0, -1)).then(function (parentId) {
      var name = dirs[dirs.length - 1];
      return api('POST', 'nodes', { parentId: parentId, name: name }).then(function (r) { return r.node.id; }, function (e) {
        if (e.code !== 'exists') throw e;
        return api('GET', 'nodes/' + parentId + '/children', null, { limit: 1000 }).then(function (r) {
          var hit = (r.items || []).filter(function (x) { return x.isDir && x.name.toLowerCase() === name.toLowerCase(); })[0];
          if (!hit) throw e;
          return hit.id;
        });
      });
    });
    folderCache[key] = p;
    p.catch(function () { delete folderCache[key]; });
    return p;
  }

  function pump() {
    if (S.uploading) return;
    var u = S.uploads.filter(function (x) { return x.state === 'waiting'; })[0];
    if (!u) { folderCache = {}; return; }
    S.uploading = true;
    u.state = 'uploading';
    renderUploads();
    var done = function () { S.uploading = false; renderUploads(); pump(); };
    folderFor(u.target, u.dirs).then(function (parentId) {
      u.parentId = parentId;
      if (!window.GC || typeof window.GC.upload !== 'function') throw codeErr('upload_unsupported');
      return window.GC.upload(u.file, { onProgress: function (p) { u.loaded = p && p.loaded ? p.loaded : 0; renderUploads(); } });
    }).then(function (up) {
      u.mediaId = up.mediaId;
      return commit(u, null);
    }).then(function (r) {
      u.state = r === 'skipped' ? 'skipped' : 'done';
      if (r !== 'skipped' && u.target.folderId === (S.folder && S.folder.id) && S.page === 'files') scheduleReload();
      done();
    }, function (e) {
      u.state = 'error';
      var k = 'err.upload_' + ((e && e.code) || 'failed');
      u.error = e && (e.code === 'upload_unsupported' || e.status) ? T(CTX.texts && CTX.texts[k] ? k : 'err.upload_failed') : errText(e);
      done();
    });
  }

  function commit(u, onConflict) {
    var body = { mediaId: u.mediaId, parentId: u.parentId, name: u.file.name, mtime: u.file.lastModified || undefined };
    if (onConflict) body.onConflict = onConflict;
    return api('POST', 'uploads/commit', body).then(function () { return 'done'; }, function (e) {
      if (e.code !== 'conflict' && e.code !== 'exists') throw e;
      var isDir = e.code === 'exists';
      var choice = S.conflictAll ? Promise.resolve(S.conflictAll) : askConflict(u.file.name, isDir);
      return choice.then(function (c) {
        if (c === 'skip') return 'skipped';
        if (isDir && c === 'version') c = 'rename';
        return commit(u, c);
      });
    });
  }

  function askConflict(name, isDir) {
    return new Promise(function (resolve) {
      var all = h('input', { type: 'checkbox' });
      var pick = function (c) { if (all.checked) S.conflictAll = c; closeDialog(); resolve(c); };
      var b = dialog(T('p.conflict_title'), [
        h('p', { class: 'dp-hint', text: T(isDir ? 'p.conflict_folder' : 'p.conflict_text', { name: name }) }),
        h('label', { class: 'dp-check' }, [all, h('span', { text: T('p.conflict_all') })]),
        h('div', { class: 'dp-actions' }, [
          btn(T('p.conflict_skip'), function () { pick('skip'); }),
          btn(T('p.conflict_both'), function () { pick('rename'); }),
          isDir ? null : btn(T('p.conflict_version'), function () { pick('version'); }, { primary: true }),
        ]),
      ]);
      // closing the dialog otherwise = skip
      b.querySelector('.dp-ib').addEventListener('click', function () { resolve('skip'); });
    });
  }

  var reloadTimer = null;
  function scheduleReload() {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(function () { reloadTimer = null; reload(); loadStorage(); }, LIVE_DELAY_MS);
  }

  function renderUploads() {
    var box = $('dp-ups');
    clear(box);
    var list = S.uploads;
    if (!list.length) { box.hidden = true; return; }
    var open = list.filter(function (u) { return u.state === 'waiting' || u.state === 'uploading'; }).length;
    var failed = list.filter(function (u) { return u.state === 'error'; }).length;
    box.hidden = false;
    box.appendChild(h('div', { class: 'dp-ups-head' }, [
      h('span', { text: open ? P('p.uploading', open) : failed ? P('p.upload_failed_n', failed) : T('p.uploads_done') }),
      open ? null : ibtn('close', T('p.close'), function () { S.uploads = []; renderUploads(); }),
    ]));
    list.slice(-8).forEach(function (u) {
      var pct = u.state === 'done' ? 100 : u.file.size ? Math.round((u.loaded / u.file.size) * 100) : 0;
      var st = u.state === 'done' ? T('p.up_done') : u.state === 'skipped' ? T('p.up_skipped') : u.state === 'error' ? (u.error || T('p.up_error')) : u.state === 'waiting' ? T('p.up_waiting') : pct + ' %';
      box.appendChild(h('div', { class: 'dp-up' + (u.state === 'error' ? ' is-error' : u.state === 'done' ? ' is-done' : '') }, [
        h('div', { class: 'dp-up-l' }, [h('span', { text: u.dirs.concat([u.file.name]).join('/') }), h('span', { text: st })]),
        u.state === 'uploading' ? h('div', { class: 'dp-progress' }, h('span', { attrs: { style: 'width:' + pct + '%' } })) : null,
      ]));
    });
  }

  // ── live ─────────────────────────────────────────────────

  function live() {
    if (!window.GC || typeof window.GC.on !== 'function') return;
    window.GC.on('event', function (ev) {
      var d = ev && ev.data;
      if (!ev || ev.type !== 'changed' || !d || !Array.isArray(d.areas)) return;
      if (S.page === 'files' && d.areas.indexOf(S.areaId) >= 0 && !S.uploading) scheduleReload();
      else if (S.page === 'trash') showTrash();
    });
  }

  boot();
}());
