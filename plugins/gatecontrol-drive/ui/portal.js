/* Drive (gatecontrol-drive) — the portal tab "Drive" (mockup "Portal – Dateien & Freigabe").
 *
 * The areas (my files, the family, the children's folders, team folders) on the left, the folder as tiles or a list
 * (with GateControl's previews — pictures, and HEIC photos and videos whose device sent one), breadcrumbs, search; upload with the button or by dropping files and folders (GC.upload, then uploads/commit — a
 * name that exists asks: a new version, keep both, or skip); a preview for pictures, videos and sound (the signed
 * media URL — every other type downloads); new folder, rename, move (also into another area), versions, trash;
 * sharing with people without an account (links v2: view, view + download, upload into a folder; 1 / 7 / 30 days or
 * without an end; an optional PIN; the log); "Geteilte Links" and "Papierkorb" as pages. Live: the event 'changed'
 * (GC.on) reloads the folder shown when its area changed.
 * Since 1.5.0: "Geräte" as a page (my PCs and phones that back up or sync folders, their folders and last backup,
 * "Gerät vergessen"); a file deleted on such a device shows "wird am … gelöscht" and can be kept ("Behalten"); empty
 * files upload without GC.upload (uploads/commit { size: 0 }).
 * Since 1.6.0: a direct link opens its node (`drive=<id>` in the frame's address — GateControl passes the portal's
 * parameter on to the frame; a folder opens, a file opens its folder and shows itself), "Direktlink kopieren" (GET me
 * links); "Ordner hochladen" (<input webkitdirectory>) besides dropping folders — sub folders are made, empty ones too,
 * with the overall progress; the ransomware protection: a banner while a device of mine is stopped ("Rückgängig
 * machen", "War ich – freigeben", the changes), for administrators the page "Vorfälle" with everyone's (live: 'guard').
 *
 * Since 1.7.0: "Fotos" (a timeline by month with previews, "Vor einem Jahr", choosing several to put them into an
 * album), "Alben" (make, rename, cover, the photo frame of the wall tablet, remove photos, delete), "Speicher" (space
 * per area — an administrator: every area and person —, the largest files, duplicates to keep or put into the trash,
 * old versions cleaned up by those who may), "Zeitreise" for a folder (a preview, then back to a time; the result can be
 * undone) and the date a photo was taken on upload (EXIF of a JPEG, else the file's date).
 *
 * Since 1.9.0: vault folders, end-to-end encrypted (ui/vault.js with ui/vaultcrypto.js: names decrypted here, files
 * encrypted before GC.upload and decrypted after GC.mediaBytes, the device key in GC.keys — GateControl ≥ 1.211.0);
 * "Im Browser bearbeiten" for documents while an office server is set up (POST nodes/<id>/office, GC.openTab).
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
    device: 'M3 5h18v11H3z|M8 20h8|M12 16v4',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z|M12 8v5M12 16h.01',
    folderUp: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z|M12 16v-6|M9 13l3-3 3 3',
    photos: 'M4 6h16v13H4z|M4 15l4-4 4 4 3-3 5 5|M15 10h.01',
    album: 'M5 4h12a2 2 0 0 1 2 2v14l-4-3-4 3-4-3-4 3V6a2 2 0 0 1 2-2z',
    storage: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z|M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6|M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
    clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18|M12 7v5l3 2',
    check: 'M5 12l5 5 9-10',
    frame: 'M3 4h18v14H3z|M7 21h10|M7 14l3-3 3 3 2-2 3 3',
    lock: 'M5 11h14v10H5z|M8 11V8a4 4 0 0 1 8 0v3',
    key: 'M7 14a4 4 0 1 0 0-8a4 4 0 1 0 0 8|M10.5 11.5L20 21|M16 17l2-2|M18 19l2-2',
    office: 'M6 3h8l4 4v14H6z|M14 3v4h4|M9 13h6M9 17h4',
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
  function fmtDay(iso) {
    var d = iso ? new Date(iso) : null;
    return d && !isNaN(d.getTime()) ? d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
  }
  /** "Auf „PC“ gelöscht – kommt am … in den Papierkorb." of a marked node (since 1.5.0). */
  function markText(n) {
    return n.deletedOnDevice ? T('p.marked_on', { device: n.deletedOnDevice, date: fmtDay(n.deleteAt) }) : T('p.marked_plain', { date: fmtDay(n.deleteAt) });
  }
  /** The quiet note on a tile or row of a marked node. */
  function markOf(n) {
    if (!n.deleteAt) return null;
    return h('span', { class: 'dp-mark', text: T('p.marked', { date: fmtDay(n.deleteAt) }), attrs: { title: markText(n) } });
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
    page: 'files',        // files · trash · links · search · devices
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
    meDevices: 0,         // my devices that use Drive (GET me devices): "also on all my devices" when deleting
    linksEnabled: true,
    seq: 0,               // guards against an older answer arriving last
    uploads: [],
    uploading: false,
    conflictAll: null,    // 'version' | 'rename' | 'skip' — the choice "for all" of this batch
    links: null,          // GET me links { node, drive } (since 1.6.0) or null
    incidents: [],        // the open incidents of the ransomware protection the banner shows (mine; an admin: everyone's)
    admin: false,         // GET me me.admin: the page "Vorfälle" with everyone's incidents
    office: false,        // GET me features 'office' (since 1.9.0): "Im Browser bearbeiten"
  };

  function areaOf(id) { for (var i = 0; i < S.areas.length; i++) if (S.areas[i].id === id) return S.areas[i]; return null; }
  /** The name a person sees: a vault's node decrypted (ui/vault.js), else its name. */
  function nm(n) { return n && n.encrypted && V ? V.nameOf(n) : (n ? n.name : ''); }
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
      S.meDevices = r.devices || 0;
      (r.people || []).forEach(function (p) { S.people.set(p.id, p.name); });
      if (!r.licence || !r.licence.valid) { message(T('p.unlicensed_title'), T('p.unlicensed_text')); return; }
      if (!r.me || !r.me.seat) { message(T('p.noseat_title'), T('p.noseat_text')); return; }
      S.areas = r.areas || [];
      S.links = r.links || null;
      S.admin = !!r.me.admin;
      S.office = (r.features || []).indexOf('office') >= 0;
      S.incidents = (r.incidents || []).slice();
      $('dp-msg').hidden = true;
      $('dp-app').hidden = false;
      setupChrome();
      renderGuard();
      if (S.admin) loadIncidents();
      var first = areaOf('mine:' + r.me.id) || S.areas[0];
      var want = wanted();
      if (want) openTarget(want, first);
      else if (first) openFolder(first.id, first.rootId);
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
    // "Ordner hochladen": every file with its path below the chosen folder (webkitRelativePath "Fotos/2026/a.jpg")
    $('dp-dir').addEventListener('change', function (ev) {
      var files = [].slice.call((ev.target && ev.target.files) || []);
      ev.target.value = '';
      var list = files.map(function (f) {
        var parts = String(f.webkitRelativePath || f.name).split('/').filter(Boolean);
        parts.pop();
        return { file: f, dirs: parts };
      });
      if (list.length) enqueue(list);
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
    nav.appendChild(h('button', { type: 'button', attrs: { 'aria-current': S.page === 'photos' ? 'page' : null }, on: { click: function () { showPhotos(); } } }, [icon('photos'), h('span', { text: T('p.photos') })]));
    nav.appendChild(h('button', { type: 'button', attrs: { 'aria-current': S.page === 'albums' || S.page === 'album' ? 'page' : null }, on: { click: showAlbums } }, [icon('album'), h('span', { text: T('p.albums') })]));
    nav.appendChild(h('button', { type: 'button', attrs: { 'aria-current': S.page === 'links' ? 'page' : null }, on: { click: showLinks } }, [icon('link'), h('span', { text: T('p.links') })]));
    nav.appendChild(h('button', { type: 'button', attrs: { 'aria-current': S.page === 'trash' ? 'page' : null }, on: { click: showTrash } }, [icon('trash'), h('span', { text: T('p.trash') })]));
    nav.appendChild(h('button', { type: 'button', attrs: { 'aria-current': S.page === 'devices' ? 'page' : null }, on: { click: showDevices } }, [icon('device'), h('span', { text: T('p.devices') })]));
    nav.appendChild(h('button', { type: 'button', attrs: { 'aria-current': S.page === 'storage' ? 'page' : null }, on: { click: function () { showStorage(); } } }, [icon('storage'), h('span', { text: T('p.storage') })]));
    if (S.admin) nav.appendChild(h('button', { type: 'button', attrs: { 'aria-current': S.page === 'incidents' ? 'page' : null }, on: { click: showIncidents } }, [icon('shield'), h('span', { text: T('p.guard_incidents') })]));
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
      c.appendChild(h('button', { type: 'button', attrs: { 'aria-current': 'page' }, text: S.page === 'trash' ? T('p.trash') : S.page === 'links' ? T('p.links') : S.page === 'devices' ? T('p.devices')
        : S.page === 'incidents' ? T('p.guard_incidents') : S.page === 'photos' ? T('p.photos') : S.page === 'albums' ? T('p.albums')
          : S.page === 'album' ? (S.album ? S.album.name : T('p.albums')) : S.page === 'storage' ? T('p.storage') : T('p.results', { q: S.q }) }));
      return;
    }
    var a = areaOf(S.areaId);
    var parts = S.folder.crumbs.concat([{ id: S.folder.id, name: S.folder.name }]);
    parts.forEach(function (x, i) {
      if (i) c.appendChild(h('span', { class: 'dp-sep', text: '›', attrs: { 'aria-hidden': 'true' } }));
      // in a vault: the decrypted names (an opaque one not decrypted yet: the placeholder)
      var label = i === 0 ? (a ? a.label : '') : (V && S.folder.encrypted ? (V.cached(x.id) || (/^[0-9a-f]{32}$/.test(x.name) ? T('p.v.locked_name') : x.name)) : x.name);
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
    var vault = S.folder && S.folder.encrypted;
    // a vault this browser cannot open: nothing to do here but the lock screen
    if (vault && !(V && V.keysOf(S.folder.vaultId))) return;
    if (canWrite()) {
      t.appendChild(btn(T('p.tt'), function () { timeTravel(S.folder); }, { icon: 'clock' }));
      // a vault folder (since 1.9.0): not inside another one
      if (!vault && V) t.appendChild(btn(T('p.v.new'), function () { V.create(S.folder); }, { icon: 'lock' }));
      t.appendChild(btn(T('p.new_folder'), vault ? function () { V.newFolder(S.folder); } : newFolder, { icon: 'plus' }));
      if (!vault) t.appendChild(btn(T('p.upload_folder'), function () { $('dp-dir').click(); }, { icon: 'folderUp' }));
      t.appendChild(btn(T('p.upload'), function () { $('dp-file').click(); }, { icon: 'upload', primary: true }));
    }
  }

  // ── a folder ─────────────────────────────────────────────

  function openFolder(areaId, folderId, then) {
    if (!areaId || !folderId) return;
    var seq = ++S.seq;
    S.page = 'files';
    S.areaId = areaId;
    return Promise.all([
      api('GET', 'nodes/' + folderId),
      api('GET', 'nodes/' + folderId + '/children', null, { sort: S.sort, order: S.order, limit: PAGE, thumbs: 1 }),
    ]).then(function (r) {
      // a vault's folder (or vault folders in it): unlock and decrypt the names first
      return (V ? V.prepare(r[0].node, r[1].items || []) : Promise.resolve()).then(function () { return r; });
    }).then(function (r) {
      if (seq !== S.seq) return;
      S.folder = r[0].node;
      S.items = r[1].items || [];
      S.total = r[1].total || 0;
      S.next = r[1].next;
      renderAll();
      if (then) then();
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
      return (V ? V.prepare(S.folder, r.items || []) : Promise.resolve()).then(function () { return r; });
    }).then(function (r) {
      S.items = S.items.concat(r.items || []);
      S.next = r.next;
      renderMain();
    }, fail);
  }

  function renderAll() { renderNav(); renderCrumbs(); renderTools(); renderMain(); }

  function renderMain() {
    var main = $('dp-main');
    clear(main);
    // a vault (since 1.9.0): its lock screen while this browser cannot open it; requests and a new key above the list
    if (S.page === 'files' && V && V.renderLocked(main)) return;
    if (S.page === 'files' && V) V.banner(main);
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

  // The small picture of a file: its preview (GateControl ≥ 1.208.0 — pictures, and HEIC / videos whose device sent
  // one), else for pictures the older `thumb`; else the icon of its kind. A preview still being made answers 503: the
  // picture is asked for twice more, then the icon stays.
  function previewSrc(n) {
    if (n.isDir) return null;
    if (n.preview && n.preview.url) return n.preview.url;
    return kindOf(n) === 'image' && n.thumb ? n.thumb : null;
  }
  function picOf(n, size) {
    var src = previewSrc(n);
    var fallback = function () { return icon(KIND_ICON[kindOf(n)], size); };
    if (!src) return fallback();
    var tries = 0;
    var img = h('img', { attrs: { src: src, alt: '', loading: 'lazy' }, on: { error: function () {
      if (tries++ < 2) { setTimeout(function () { img.setAttribute('src', src); }, 3000); return; }
      if (img.parentNode) img.parentNode.replaceChild(fallback(), img);
    } } });
    return img;
  }

  function gridOf(items) {
    var g = h('div', { class: 'dp-grid', attrs: { role: 'list' } });
    items.forEach(function (n) {
      var thumb = h('div', { class: 'dp-thumb' }, [picOf(n, 34), n.encrypted ? h('span', { class: 'dp-lockb' }, icon('lock', 12)) : null]);
      var name = nm(n);
      var ext = extOf(name);
      g.appendChild(h('div', { class: 'dp-card', attrs: { role: 'listitem', 'data-node': String(n.id) } }, [
        h('button', { type: 'button', class: 'dp-open', on: { click: function () { openNode(n); } }, attrs: { 'aria-label': name } }, [
          thumb,
          h('div', { class: 'dp-card-tx' }, [
            h('span', { class: 'dp-name', text: name, attrs: { title: name } }),
            h('span', { class: 'dp-meta' }, [!n.isDir && ext ? h('span', { class: 'dp-badge', text: ext }) : null, ' ', metaOf(n)]),
            markOf(n),
          ]),
        ]),
        ibtn('more', T('p.actions_for', { name: name }), function () { actions(n); }, { cls: 'dp-more' }),
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
      var ic = h('span', { class: 'dp-ic' }, [n.encrypted && n.isDir ? icon('lock') : picOf(n)]);
      var name = nm(n);
      l.appendChild(h('div', { class: 'dp-row', attrs: { role: 'row', 'data-node': String(n.id) } }, [
        h('button', { type: 'button', class: 'dp-open', on: { click: function () { openNode(n); } } }, [ic, h('span', { class: 'dp-name', text: name, attrs: { title: name } }),
          n.path && S.page === 'search' ? h('span', { class: 'dp-meta', text: n.path }) : null, markOf(n)]),
        h('span', { class: 'dp-num', text: fmtDate(n.mtime || n.updatedAt) }),
        h('span', { class: 'dp-num dp-right', text: n.isDir ? '—' : fmtSize(n.size) }),
        ibtn('more', T('p.actions_for', { name: name }), function () { actions(n); }),
      ]));
    });
    return l;
  }

  function openNode(n) {
    if (n.isDir) { $('dp-q').value = ''; openFolder(n.areaId, n.id); return; }
    // a vault's file: decrypted here, then downloaded (no preview — the server has none, the frame shows no blob:)
    if (n.encrypted && V) { V.download(n); return; }
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

  function confirmDialog(title, text, okLabel, onOk, danger, extra) {
    var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    dialog(title, [h('p', { class: 'dp-hint', text: text })].concat(extra || []).concat([err, h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog),
      btn(okLabel, function () { onOk().then(closeDialog, function (e) { err.textContent = errText(e); }); }, { primary: !danger, danger: !!danger })])]));
  }

  // ── actions of a node ────────────────────────────────────

  function actions(n) {
    var write = canWriteNode(n);
    var k = kindOf(n);
    var items = [];
    var item = function (ic, label, fn, danger) { items.push(h('button', { type: 'button', class: danger ? 'is-danger' : '', on: { click: function () { closeDialog(); fn(); } } }, [icon(ic), h('span', { text: label })])); };
    if (n.encrypted) { vaultActions(n, write, item); return; }
    if (n.isDir) item('folder', T('p.open'), function () { openNode(n); });
    else if (k === 'image' || k === 'video' || k === 'audio') item('eye', T('p.preview'), function () { preview(n); });
    if (!n.isDir) item('download', T('p.download'), function () { download(n); });
    // office in the browser (since 1.9.0): documents, while an office server is set up
    if (!n.isDir && S.office && OFFICE_RE.test(n.name)) item('office', T(write ? 'p.office_edit' : 'p.office_view'), function () { openOffice(n); });
    if (S.page === 'search') item('folder', T('p.show_in_folder'), function () { $('dp-q').value = ''; openFolder(n.areaId, n.parentId); });
    // an empty file has nothing to share (no media object, since 1.5.0)
    if (write && (n.isDir || n.mediaId)) item('share', T('p.share'), function () { share(n); });
    // the direct link into the portal (GET me links, since 1.6.0) — for people with an account
    if (S.links && S.links.node) item('link', T('p.copy_link'), function () { copyText(nodeLink(n.id)); });
    if (write) item('edit', T('p.rename'), function () { rename(n); });
    if (write) item('move', T('p.move'), function () { moveDialog(n); });
    if (!n.isDir) item('history', T('p.versions'), function () { versions(n); });
    if (write && n.deleteAt) item('restore', T('p.keep'), function () { keep(n); });
    if (write) item('trash', T('p.to_trash'), function () { toTrash(n); }, true);
    dialog(n.name, [n.deleteAt ? h('div', { class: 'dp-note' }, [icon('info'), h('span', { text: markText(n) })]) : null, h('div', { class: 'dp-menu' }, items)],
      { sub: n.isDir ? T('p.folder') : fmtSize(n.size) + ' · ' + fmtDate(n.mtime || n.updatedAt) });
  }
  /** The menu of a vault's node: open / download (decrypted here), rename, versions, the trash — nothing shared. */
  function vaultActions(n, write, item) {
    var unlocked = !!(V && V.keysOf(n.vaultId));
    if (n.isDir) item('folder', T('p.open'), function () { openNode(n); });
    else if (unlocked) item('download', T('p.download'), function () { V.download(n); });
    if (S.links && S.links.node) item('link', T('p.copy_link'), function () { copyText(nodeLink(n.id)); });
    if (write && unlocked) item('edit', T('p.rename'), function () { V.rename(n); });
    if (!n.isDir && unlocked) item('history', T('p.versions'), function () { versions(n); });
    if (write) item('trash', T('p.to_trash'), function () { toTrash(n); }, true);
    dialog(nm(n), [h('div', { class: 'dp-note' }, [icon('lock'), h('span', { text: T('p.v.node_note') })]), h('div', { class: 'dp-menu' }, items)],
      { sub: n.isDir ? T('p.folder') : fmtSize(n.size) + ' · ' + fmtDate(n.mtime || n.updatedAt) });
  }

  // office in the browser (since 1.9.0): the types the office server opens
  var OFFICE_RE = /\.(docx|xlsx|pptx|odt|ods|odp|csv|doc|xls|ppt|rtf)$/i;
  /** "Im Browser bearbeiten": a new tab with the office editor (GC.openTab — during the click; else a button). */
  function openOffice(n) {
    api('POST', 'nodes/' + n.id + '/office').then(function (r) {
      if (!window.GC || typeof window.GC.openTab !== 'function') throw codeErr('office_unavailable');
      return window.GC.openTab(r.url).then(function (x) {
        if (x && x.ok) return;
        // the click's moment has passed: one more click opens it
        dialog(T('p.office_title'), [h('p', { class: 'dp-hint', text: T('p.office_click') }), h('div', { class: 'dp-actions' }, [btn(T('p.office_open'), function () {
          window.GC.openTab(r.url).then(function (y) { if (y && y.ok) closeDialog(); else toast(T('err.office_unavailable'), 'error'); });
        }, { primary: true, icon: 'office' })])]);
      });
    }).catch(fail);
  }

  /** "Behalten": the mark ends — the file stays (PATCH { deleteAt: null }). */
  function keep(n) {
    api('PATCH', 'nodes/' + n.id, { deleteAt: null }).then(function () { reload(); toast(T('p.kept', { name: n.name })); }, fail);
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
    // "also on all my devices" (wipes, since 1.2.0): only when Drive knows devices of mine — the browser keeps no copies
    var everywhere = h('input', { type: 'checkbox' });
    var extra = S.meDevices > 0 ? [h('label', { class: 'dp-check' }, [everywhere, h('span', { text: P('p.everywhere', S.meDevices) })]),
      h('p', { class: 'dp-hint', text: T('p.everywhere_hint') })] : null;
    confirmDialog(T('p.to_trash'), T(n.isDir ? 'p.to_trash_folder' : 'p.to_trash_file', { name: nm(n), days: (S.meSettings && S.meSettings.trashDays) || 30 }), T('p.to_trash'), function () {
      var all = !!(extra && everywhere.checked);
      return api('DELETE', 'nodes/' + n.id, null, all ? { everywhere: 1 } : null).then(function () { reload(); loadStorage(); toast(T(all ? 'p.trashed_everywhere' : 'p.trashed', { name: nm(n) })); });
    }, true, extra);
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
      // a picture the browser cannot show (HEIC): the large preview, when there is one
      var src = k === 'image' && /^image\/hei[cf]/.test(String(n.mime || '')) && n.preview && n.preview.largeUrl ? n.preview.largeUrl : r.url;
      var media = k === 'image' ? h('img', { attrs: { src: src, alt: n.name } })
        : k === 'video' ? h('video', { attrs: { src: r.url, controls: true, preload: 'metadata' } })
          : k === 'audio' ? h('audio', { attrs: { src: r.url, controls: true, preload: 'metadata' } })
            : h('div', { class: 'dp-empty', text: T('p.no_preview') });
      var acts = [];
      if (k !== 'image' && k !== 'video' && k !== 'audio') acts.push(btn(T('p.download'), function () { download(n); }, { icon: 'download', primary: true }));
      if (canWriteNode(n) && n.mediaId) acts.push(btn(T('p.share'), function () { share(n); }, { icon: 'share' }));
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
            btn(T('p.open'), function () { api('GET', 'nodes/' + n.id + '/versions/' + v.id + '/content').then(function (c) { if (n.encrypted && V) V.download(n, c); else if (/^(image|video|audio)\//.test(String(c.mime || ''))) preview(n, c); else { var a = h('a', { attrs: { href: c.url, download: n.name } }); document.body.appendChild(a); a.click(); document.body.removeChild(a); } }, fail); }, { small: true }),
            write ? btn(T('p.restore'), function () { api('POST', 'nodes/' + n.id + '/versions/' + v.id + '/restore').then(function () { closeDialog(); reload(); toast(T('p.version_restored')); }, fail); }, { small: true }) : null,
            write ? btn(T('p.delete'), function () { api('DELETE', 'nodes/' + n.id + '/versions/' + v.id).then(function () { versions(n); }, fail); }, { small: true, danger: true }) : null,
          ]),
        ]);
      });
      var cur = r.current;
      dialog(T('p.versions_of', { name: nm(n) }), [
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
      return (V ? V.names(r.items || []) : Promise.resolve()).then(function () { return r; });
    }).then(function (r) {
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
            h('div', { attrs: { style: 'display:flex;flex-direction:column;min-width:0' } }, [h('span', { class: 'dp-name', text: nm(n) }),
              h('span', { class: 'dp-meta', text: [(a ? a.label : '') + (n.from ? ' › ' + n.from : ''), T('p.deleted_at', { date: fmtDate(n.deletedAt), who: personName(n.deletedBy) }), n.isDir ? P('p.files_n', n.files || 0) : fmtSize(n.size)].join(' · ') })])]),
          h('div', { class: 'dp-actions' }, [
            btn(T('p.restore'), function () { api('POST', 'trash/' + n.id + '/restore').then(function () { toast(T('p.restored', { name: nm(n) })); showTrash(); loadStorage(); }, fail); }, { small: true, icon: 'restore' }),
            btn(T('p.delete_forever'), function () {
              confirmDialog(T('p.delete_forever'), T('p.delete_forever_text', { name: nm(n) }), T('p.delete_forever'), function () {
                return api('DELETE', 'trash/' + n.id).then(function () { showTrash(); loadStorage(); });
              }, true);
            }, { small: true, danger: true }),
          ]),
        ]));
      });
      main.appendChild(l);
    }, fail);
  }

  function showDevices() {
    $('dp-q').value = '';
    S.page = 'devices';
    S.seq++;
    renderNav(); renderCrumbs(); renderTools();
    var main = $('dp-main');
    clear(main);
    api('GET', 'devices').then(function (r) {
      if (S.page !== 'devices') return;
      clear(main);
      main.appendChild(h('p', { class: 'dp-hint', text: T('p.devices_hint'), attrs: { style: 'margin-bottom:12px' } }));
      var list = r.devices || [];
      if (!list.length) { main.appendChild(h('div', { class: 'dp-empty', text: T('p.devices_none') })); return; }
      var box = h('div', { class: 'dp-devices' });
      list.forEach(function (d) { box.appendChild(deviceCard(d)); });
      main.appendChild(box);
    }, fail);
  }

  function deviceCard(d) {
    var mine = areaOf('mine:' + (S.me && S.me.id));
    var openIn = function (node) {
      var a = areaOf(node.areaId) || mine;
      return a ? function () { openFolder(a.id, node.id); } : null;
    };
    var folders = (d.folders || []).map(function (f) {
      var go = f.node ? openIn(f.node) : null;
      return h('li', { class: 'dp-dev-folder' }, [
        h('span', { class: 'dp-name', text: f.localPath, attrs: { title: f.localPath } }),
        h('span', { class: 'dp-meta', text: [f.mode === 'sync' ? T('p.mode_sync') : T('p.mode_backup'),
          f.node ? f.node.where : T('p.folder_gone'),
          f.lastBackup ? T('p.last_backup', { date: fmtDate(f.lastBackup) }) : T('p.never_backed_up')].join(' · ') }),
        go ? btn(T('p.device_open'), go, { small: true, icon: 'folder' }) : null,
      ]);
    });
    var openFolderBtn = d.folder ? openIn(d.folder) : null;
    return h('section', { class: 'dp-device' }, [
      h('div', { class: 'dp-dev-head' }, [
        h('span', { class: 'dp-ic' }, icon('device')),
        h('div', { class: 'dp-dev-tx' }, [
          h('span', { class: 'dp-name', text: d.name + (d.current ? ' (' + T('p.device_this') + ')' : '') }),
          h('span', { class: 'dp-meta', text: [d.platform, d.version, T('p.device_seen', { date: fmtDate(d.lastSeen) })].filter(Boolean).join(' · ') }),
          d.folder ? h('span', { class: 'dp-meta', text: T('p.device_folder', { where: d.folder.where }) }) : null,
        ]),
        h('div', { class: 'dp-actions' }, [
          openFolderBtn ? btn(T('p.device_open'), openFolderBtn, { small: true, icon: 'folder' }) : null,
          btn(T('p.device_forget'), function () { forgetDevice(d); }, { small: true, danger: true }),
        ]),
      ]),
      folders.length ? h('ul', { class: 'dp-dev-folders' }, folders) : h('p', { class: 'dp-hint', text: T('p.device_no_folders') }),
    ]);
  }

  function forgetDevice(d) {
    confirmDialog(T('p.device_forget'), T('p.device_forget_text', { name: d.name }), T('p.device_forget'), function () {
      return api('DELETE', 'devices/' + encodeURIComponent(d.id)).then(function () { toast(T('p.device_forgotten', { name: d.name })); showDevices(); });
    }, true);
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
      var here = dirs.concat([entry.name]);
      var more = function () {
        return new Promise(function (res) { reader.readEntries(function (batch) { res(batch); }, function () { res([]); }); }).then(function (batch) {
          if (!batch.length) return null;
          all = all.concat(batch);
          return more();
        });
      };
      return more().then(function () {
        // an empty folder is made too (nothing below it would make it)
        if (!all.length) out.push({ file: null, dirs: here });
        return all.reduce(function (p, e) { return p.then(function () { return walk(e, here); }); }, Promise.resolve());
      });
    };
    return entries.reduce(function (p, e) { return p.then(function () { return walk(e, []); }); }, Promise.resolve()).then(function () { return out; });
  }

  function enqueue(list) {
    var target = { areaId: S.areaId, folderId: S.folder.id, vaultId: S.folder.encrypted ? S.folder.vaultId : null };
    // a vault: files only (folders of files are made in the apps)
    if (target.vaultId) {
      var flat = list.filter(function (x) { return x.file && !x.dirs.length; });
      if (flat.length < list.length) toast(T('p.v.no_folders'), 'error');
      list = flat;
      if (!list.length) return;
    }
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
      // into a vault (since 1.9.0): encrypted here, the encrypted name with the commit (ui/vault.js)
      if (u.target.vaultId) {
        if (!V) throw codeErr('vault_locked');
        u.vaultId = u.target.vaultId;
        return V.upload(u, askConflict).then(function (r) { return { folder: true, result: r }; });
      }
      // an empty folder: made, nothing to upload
      if (!u.file) return { folder: true };
      // an empty file: GateControl's upload takes no empty body — the commit makes it (since 1.5.0)
      if (!u.file.size) return { mediaId: null };
      if (!window.GC || typeof window.GC.upload !== 'function') throw codeErr('upload_unsupported');
      return takenOf(u.file).then(function (t) { u.takenAt = t; }).then(function () { return window.GC.upload(u.file, { onProgress: function (p) { u.loaded = p && p.loaded ? p.loaded : 0; renderUploads(); } }); });
    }).then(function (up) {
      if (up && up.folder) return up.result || 'done';
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
    var body = u.mediaId ? { mediaId: u.mediaId, parentId: u.parentId, name: u.file.name, mtime: u.file.lastModified || undefined, takenAt: u.takenAt || undefined }
      : { size: 0, mime: u.file.type || undefined, parentId: u.parentId, name: u.file.name, mtime: u.file.lastModified || undefined };
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
    // the overall progress (bytes) while a batch runs — a folder of many files
    if (open && list.length > 1) {
      var total = 0;
      var got = 0;
      list.forEach(function (u) {
        var size = u.file ? u.file.size || 0 : 0;
        total += size;
        got += u.state === 'done' || u.state === 'skipped' || u.state === 'error' ? size : Math.min(size, u.loaded || 0);
      });
      var all = total ? Math.round((got / total) * 100) : 0;
      box.appendChild(h('div', { class: 'dp-ups-all', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(all) } }, h('span', { attrs: { style: 'width:' + all + '%' } })));
    }
    list.slice(-8).forEach(function (u) {
      if (!u.file) {
        box.appendChild(h('div', { class: 'dp-up' + (u.state === 'error' ? ' is-error' : u.state === 'done' ? ' is-done' : '') }, [
          h('div', { class: 'dp-up-l' }, [h('span', { text: u.dirs.join('/') + '/' }), h('span', { text: u.state === 'done' ? T('p.up_done') : u.state === 'error' ? (u.error || T('p.up_error')) : T('p.up_waiting') })]),
        ]));
        return;
      }
      var pct = u.state === 'done' ? 100 : u.file.size ? Math.round((u.loaded / u.file.size) * 100) : 0;
      var st = u.state === 'done' ? T('p.up_done') : u.state === 'skipped' ? T('p.up_skipped') : u.state === 'error' ? (u.error || T('p.up_error')) : u.state === 'waiting' ? T('p.up_waiting') : pct + ' %';
      box.appendChild(h('div', { class: 'dp-up' + (u.state === 'error' ? ' is-error' : u.state === 'done' ? ' is-done' : '') }, [
        h('div', { class: 'dp-up-l' }, [h('span', { text: u.dirs.concat([u.file.name]).join('/') }), h('span', { text: st })]),
        u.state === 'uploading' ? h('div', { class: 'dp-progress' }, h('span', { attrs: { style: 'width:' + pct + '%' } })) : null,
      ]));
    });
  }

  // ── direct links (since 1.6.0) ───────────────────────────

  function nodeLink(id) { return String(S.links.node).split('{id}').join(encodeURIComponent(String(id))); }

  /**
   * The node a direct link names: `drive=<id>` in the frame's own address (query or hash) — GateControl hands the
   * portal's parameter on to the frame; a link without one opens the Drive tab as before. → id or null
   */
  function wanted() {
    var where = '';
    try { where = String(window.location && window.location.search || '') + '&' + String(window.location && window.location.hash || '').replace(/^#/, ''); } catch (e) { where = ''; }
    var m = /(?:^|[?&#])drive=(\d{1,15})(?:$|[&#])/.exec(where);
    return m ? Number(m[1]) : null;
  }

  /** Open node `id`: a folder opens, a file opens its folder, is marked and shown. Not there: my files and a note. */
  function openTarget(id, fallback) {
    api('GET', 'nodes/' + id).then(function (r) {
      var n = r.node;
      if (n.isDir) { openFolder(n.areaId, n.id); return; }
      openFolder(n.areaId, n.parentId, function () {
        var el = [].slice.call($('dp-main').querySelectorAll('[data-node]')).filter(function (x) { return x.getAttribute('data-node') === String(n.id); })[0];
        if (el) {
          el.className += ' dp-hl';
          if (el.scrollIntoView) { try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* old browsers */ } }
        }
        preview(n);
      });
    }, function () {
      toast(T('p.open_missing'), 'error');
      if (fallback) openFolder(fallback.id, fallback.rootId);
    });
  }

  // ── ransomware protection (since 1.6.0) ──────────────────

  function incidentTitle(x) {
    var mineOne = S.me && x.user === S.me.id;
    var device = x.deviceName || x.device;
    return mineOne ? T('p.guard_title', { device: device }) : T('p.guard_title_other', { device: device, name: x.userName || String(x.user) });
  }

  /** The banner above the files: every open incident (mine; an administrator: everyone's). */
  function renderGuard() {
    var box = $('dp-guard');
    if (!box) return;
    clear(box);
    var open = S.incidents.filter(function (x) { return x.state === 'open' || x.locked; });
    box.hidden = !open.length;
    open.forEach(function (x) {
      box.appendChild(h('div', { class: 'dp-guard-box' }, [
        icon('shield', 24),
        h('div', { class: 'dp-guard-tx' }, [
          h('b', { text: incidentTitle(x) }),
          h('span', { text: T('p.guard_text', { date: fmtDate(x.at), count: x.files }) }),
          x.sample && x.sample.length ? h('span', { class: 'dp-muted', text: T('p.guard_sample') }) : null,
          x.sample && x.sample.length ? h('ul', null, x.sample.map(function (nm) { return h('li', { text: nm, attrs: { title: nm } }); })) : null,
        ]),
        h('div', { class: 'dp-actions' }, incidentButtons(x)),
      ]));
    });
  }

  function incidentButtons(x) {
    if (x.state !== 'open' && x.state !== 'released') return [btn(T('p.guard_details'), function () { incidentDetails(x); }, { small: true })];
    return [
      btn(T('p.guard_undo'), function () { undoIncident(x); }, { primary: true, icon: 'restore' }),
      x.state === 'open' ? btn(T('p.guard_release'), function () { releaseIncident(x); }) : null,
      btn(T('p.guard_details'), function () { incidentDetails(x); }, { small: true }),
    ];
  }

  function settled(x) {
    S.incidents = S.incidents.filter(function (y) { return y.id !== x.id; });
    renderGuard();
    if (S.page === 'incidents') showIncidents();
  }

  function undoIncident(x) {
    confirmDialog(T('p.guard_undo_title'), T('p.guard_undo_text'), T('p.guard_undo'), function () {
      return api('POST', 'guard/incidents/' + x.id + '/undo').then(function (r) {
        toast(T('p.guard_undone', { restored: r.restored || 0, trashed: r.trashed || 0 }));
        settled(x);
        reload();
        loadStorage();
      });
    });
  }

  function releaseIncident(x) {
    var device = x.deviceName || x.device;
    confirmDialog(T('p.guard_release_title'), T('p.guard_release_text', { device: device }), T('p.guard_release'), function () {
      return api('POST', 'guard/incidents/' + x.id + '/release').then(function () {
        toast(T('p.guard_released', { device: device }));
        settled(x);
      });
    });
  }

  function incidentDetails(x) {
    api('GET', 'guard/incidents/' + x.id).then(function (r) {
      var rows = (r.entries || []).map(function (e) {
        return h('tr', null, [
          h('td', { text: fmtDate(e.at) }), h('td', { text: T('p.guard_op_' + e.op) }),
          h('td', null, [h('span', { text: e.name }), e.oldName && e.oldName !== e.name ? h('span', { class: 'dp-meta', text: ' · ' + T('p.guard_was', { name: e.oldName }) }) : null]),
        ]);
      });
      dialog(incidentTitle(r.incident), [
        h('p', { class: 'dp-hint', text: T('p.guard_text', { date: fmtDate(r.incident.at), count: r.incident.files }) }),
        h('div', { attrs: { style: 'overflow-x:auto' } }, h('table', { class: 'dp-table' }, [h('thead', null, h('tr', null, [h('th', { text: T('p.col_when') }), h('th', { text: T('p.col_what') }), h('th', { text: T('p.col_file') })])), h('tbody', null, rows)])),
        h('div', { class: 'dp-actions' }, incidentButtons(r.incident).map(function (b) { return b; })),
      ], { wide: true });
    }, fail);
  }

  /** An administrator: everyone's open incidents into the banner. */
  function loadIncidents() {
    return api('GET', 'guard/incidents', null, { all: S.admin ? 1 : null }).then(function (r) {
      S.incidents = (r.incidents || []).filter(function (x) { return x.state === 'open'; });
      renderGuard();
      return r.incidents || [];
    }, function () { return []; });
  }

  /** The page "Vorfälle" (administrators): every incident, open ones first. */
  function showIncidents() {
    $('dp-q').value = '';
    S.page = 'incidents';
    S.seq++;
    renderNav(); renderCrumbs(); renderTools();
    var main = $('dp-main');
    clear(main);
    loadIncidents().then(function (list) {
      if (S.page !== 'incidents') return;
      clear(main);
      main.appendChild(h('p', { class: 'dp-hint', text: T('p.guard_hint'), attrs: { style: 'margin-bottom:12px' } }));
      if (!list.length) { main.appendChild(h('div', { class: 'dp-empty', text: T('p.guard_none') })); return; }
      var box = h('div', { class: 'dp-incidents' });
      list.forEach(function (x) {
        box.appendChild(h('div', { class: 'dp-incident' }, [
          h('div', { attrs: { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' } }, [
            h('span', { class: 'dp-name', text: incidentTitle(x), attrs: { style: 'flex:1;min-width:0' } }),
            h('span', { class: 'dp-state' + (x.state === 'open' ? ' is-open' : ''), text: T('p.guard_state_' + x.state) }),
          ]),
          h('span', { class: 'dp-meta', text: [fmtDate(x.at), P('p.files_n', x.files || 0)].concat(x.sample || []).join(' · ') }),
          h('div', { class: 'dp-actions' }, incidentButtons(x)),
        ]));
      });
      main.appendChild(box);
    });
  }

  // ── when a photo was taken (since 1.7.0) ─────────────────

  /**
   * takenAt of a picture or video to upload (ms): a JPEG's EXIF DateTimeOriginal (else DateTime; the device's time
   * unless the photo names its offset), else the file's date. Other files: none (the server takes mtime).
   */
  function takenOf(file) {
    var type = String((file && file.type) || '');
    if (!/^(image|video)\//.test(type)) return Promise.resolve(null);
    var fallback = file.lastModified || null;
    if (type !== 'image/jpeg' || typeof file.slice !== 'function') return Promise.resolve(fallback);
    var part = file.slice(0, 256 * 1024);
    if (!part || typeof part.arrayBuffer !== 'function') return Promise.resolve(fallback);
    return part.arrayBuffer().then(function (buf) { return exifTaken(new DataView(buf)) || fallback; }, function () { return fallback; });
  }

  /** DateTimeOriginal (0x9003, with OffsetTimeOriginal 0x9011) or DateTime (0x0132) of a JPEG's EXIF → ms or null. */
  function exifTaken(v) {
    try {
      if (v.byteLength < 12 || v.getUint16(0) !== 0xFFD8) return null;
      var off = 2;
      while (off + 4 <= v.byteLength) {
        var marker = v.getUint16(off);
        var len = v.getUint16(off + 2);
        if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) return null;
        if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) return tiffTaken(v, off + 10);
        off += 2 + len;
      }
    } catch (e) { return null; }
    return null;
  }
  function tiffTaken(v, t) {
    var le = v.getUint16(t) === 0x4949;
    var u16 = function (o) { return v.getUint16(t + o, le); };
    var u32 = function (o) { return v.getUint32(t + o, le); };
    var str = function (o, n) { var s = ''; for (var i = 0; i < n; i++) { var c = v.getUint8(t + o + i); if (!c) break; s += String.fromCharCode(c); } return s; };
    var tags = function (ifd) {
      var out = {};
      var n = u16(ifd);
      for (var i = 0; i < n && i < 500; i++) {
        var e = ifd + 2 + i * 12;
        var tag = u16(e);
        var count = u32(e + 4);
        out[tag] = { type: u16(e + 2), count: count, value: u32(e + 8), at: count > 4 ? u32(e + 8) : e + 8 };
      }
      return out;
    };
    var ifd0 = tags(u32(4));
    var exif = ifd0[0x8769] ? tags(ifd0[0x8769].value) : {};
    var when = exif[0x9003] || ifd0[0x0132];
    if (!when) return null;
    var m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(str(when.at, 19));
    if (!m) return null;
    var off = exif[0x9011] ? /^([+-])(\d{2}):(\d{2})$/.exec(str(exif[0x9011].at, 6)) : null;
    var p = m.slice(1).map(Number);
    if (off) return Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5]) - (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) * 60000;
    var d = new Date(p[0], p[1] - 1, p[2], p[3], p[4], p[5]).getTime();
    return isNaN(d) ? null : d;
  }

  // ── photos (since 1.7.0) ─────────────────────────────────

  var PH = { area: '', items: [], next: null, months: {}, memories: [], select: false, chosen: {}, seq: 0 };
  var PHOTO_PAGE = 120;

  /** A photo item (GET photos, albums) as a node for the viewer (preview, actions). */
  function photoNode(x) {
    return { id: x.id, name: x.name, mime: x.mime, size: x.size, isDir: false, areaId: x.areaId, parentId: x.parentId, mediaId: x.mediaId,
      mtime: x.takenAt, updatedAt: x.takenAt, preview: x.previewUrl ? { url: x.previewUrl, largeUrl: x.largeUrl } : null };
  }
  function monthKey(iso) { var d = new Date(iso); return isNaN(d.getTime()) ? '' : d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2); }
  function monthLabel(key) {
    var p = key.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, 1);
    return isNaN(d.getTime()) ? key : d.toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
  }
  function chosenIds() { return Object.keys(PH.chosen).filter(function (k) { return PH.chosen[k]; }).map(Number); }

  /** A square tile of a photo: a click opens it, or chooses it while choosing. */
  function photoTile(x, onPick) {
    var n = photoNode(x);
    var on = !!PH.chosen[x.id];
    var tile = h('button', { type: 'button', class: 'dp-ph' + (on ? ' is-on' : ''), attrs: { 'aria-label': x.name, 'aria-pressed': PH.select ? String(on) : null, 'data-node': String(x.id) },
      on: { click: function () {
        if (PH.select) { PH.chosen[x.id] = !PH.chosen[x.id]; tile.className = 'dp-ph' + (PH.chosen[x.id] ? ' is-on' : ''); tile.setAttribute('aria-pressed', String(!!PH.chosen[x.id])); if (onPick) onPick(); return; }
        preview(n);
      } } }, [picOf(n, 28), /^video\//.test(String(x.mime || '')) ? h('span', { class: 'dp-ph-kind' }, icon('video', 14)) : null, PH.select ? h('span', { class: 'dp-ph-check' }, icon('check', 14)) : null]);
    return tile;
  }

  function startPage(page) {
    $('dp-q').value = '';
    S.page = page;
    S.seq++;
    renderNav(); renderCrumbs(); renderTools();
    var main = $('dp-main');
    clear(main);
    return main;
  }

  /** The page "Fotos": "Vor einem Jahr", then every month with its photos. */
  function showPhotos(keep) {
    if (!keep) { PH.select = false; PH.chosen = {}; }
    var main = startPage('photos');
    var seq = ++PH.seq;
    Promise.all([
      api('GET', 'photos', null, { area: PH.area || null, limit: PHOTO_PAGE }),
      api('GET', 'photos/months', null, { area: PH.area || null }).catch(function () { return { months: [] }; }),
      PH.area ? Promise.resolve({ groups: [] }) : api('GET', 'photos/memories').catch(function () { return { groups: [] }; }),
    ]).then(function (r) {
      if (seq !== PH.seq || S.page !== 'photos') return;
      PH.items = r[0].items || [];
      PH.next = r[0].next;
      PH.months = {};
      (r[1].months || []).forEach(function (m) { PH.months[m.month] = m.count; });
      PH.memories = r[2].groups || [];
      renderPhotos(main);
    }, fail);
  }

  function photoBar(onDone) {
    var bar = h('div', { class: 'dp-ph-bar' });
    var areaSel = h('select', { class: 'dp-input dp-btn-sm', attrs: { 'aria-label': T('p.area') }, on: { change: function (ev) { PH.area = ev.target.value; showPhotos(true); } } },
      [h('option', { value: '', text: T('p.photos_all'), selected: !PH.area })].concat(S.areas.map(function (a) { return h('option', { value: a.id, text: a.label, selected: PH.area === a.id }); })));
    areaSel.style.width = 'auto';
    var count = chosenIds().length;
    add(bar, [onDone ? null : areaSel, h('span', { class: 'dp-ph-grow' }),
      PH.select ? h('span', { class: 'dp-meta', text: P('p.chosen', count) }) : null,
      PH.select && onDone ? onDone(count) : null,
      PH.select && !onDone ? btn(T('p.album_add'), function () { addToAlbum(chosenIds()); }, { primary: true, disabled: !count, icon: 'album' }) : null,
      btn(PH.select ? T('p.cancel') : T('p.choose'), function () { PH.select = !PH.select; PH.chosen = {}; rerender(); }, { icon: PH.select ? null : 'check' })]);
    return bar;
  }
  function rerender() {
    var main = $('dp-main');
    clear(main);
    if (S.page === 'photos') renderPhotos(main);
    else if (S.page === 'album') renderAlbum(main);
  }

  function renderPhotos(main) {
    clear(main);
    main.appendChild(photoBar(null));
    if (PH.memories.length) {
      var mem = h('section', { class: 'dp-mem' }, [h('h2', { class: 'dp-h2', text: T('p.memories') })]);
      PH.memories.forEach(function (g) {
        var d = new Date(g.date + 'T12:00:00');
        mem.appendChild(h('div', { class: 'dp-mem-group' }, [
          h('span', { class: 'dp-label', text: P('p.years_ago', g.yearsAgo) + ' · ' + (isNaN(d.getTime()) ? g.date : d.toLocaleDateString(LOCALE, { day: '2-digit', month: 'long', year: 'numeric' })) }),
          h('div', { class: 'dp-mem-row' }, g.items.map(function (x) { return photoTile(x, rerenderBar); })),
        ]));
      });
      main.appendChild(mem);
    }
    if (!PH.items.length) { main.appendChild(h('div', { class: 'dp-empty', text: T('p.photos_none') })); return; }
    var groups = [];
    PH.items.forEach(function (x) {
      var k = monthKey(x.takenAt);
      if (!groups.length || groups[groups.length - 1].key !== k) groups.push({ key: k, items: [] });
      groups[groups.length - 1].items.push(x);
    });
    groups.forEach(function (g) {
      main.appendChild(h('h2', { class: 'dp-month' }, [h('span', { text: monthLabel(g.key) }), PH.months[g.key] ? h('span', { class: 'dp-meta', text: P('p.photos_n', PH.months[g.key]) }) : null]));
      main.appendChild(h('div', { class: 'dp-phs' }, g.items.map(function (x) { return photoTile(x, rerenderBar); })));
    });
    if (PH.next) main.appendChild(h('div', { class: 'dp-more-row' }, btn(T('p.more'), function () {
      api('GET', 'photos', null, { area: PH.area || null, limit: PHOTO_PAGE, before: PH.next }).then(function (r) {
        PH.items = PH.items.concat(r.items || []);
        PH.next = r.next;
        renderPhotos(main);
      }, fail);
    })));
  }
  /** Choosing changed: only the bar (the count, the buttons) is drawn again. */
  function rerenderBar() {
    var main = $('dp-main');
    var old = main.querySelector('.dp-ph-bar');
    if (!old) return;
    var bar = S.page === 'album' ? albumBar() : photoBar(null);
    main.replaceChild ? main.replaceChild(bar, old) : rerender();
  }

  // ── albums (since 1.7.0) ─────────────────────────────────

  function albumAreas() { return S.areas.filter(function (a) { return !a.archived && (a.role === 'write' || a.role === 'manage'); }); }

  /** "Zum Album hinzufügen": the albums I may change, or a new one. */
  function addToAlbum(ids) {
    if (!ids.length) return;
    api('GET', 'albums').then(function (r) {
      var list = (r.albums || []).filter(function (a) { return a.canEdit; });
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var put = function (id) {
        return api('POST', 'albums/' + id + '/items', { ids: ids }).then(function (x) {
          closeDialog();
          PH.select = false; PH.chosen = {};
          rerender();
          toast(P('p.album_added', ids.length, { album: x.album.name }));
        }, function (e) { err.textContent = errText(e); });
      };
      var input = h('input', { class: 'dp-input', type: 'text', placeholder: T('p.album_new_name'), attrs: { maxlength: '100', 'aria-label': T('p.album_new_name') } });
      var picker = h('div', { class: 'dp-picker', attrs: { role: 'list' } }, list.map(function (a) {
        return h('button', { type: 'button', attrs: { role: 'listitem' }, on: { click: function () { put(a.id); } } }, [icon('album'), h('span', { text: a.name + ' · ' + P('p.photos_n', a.count) })]);
      }));
      dialog(P('p.album_add_title', ids.length), [list.length ? picker : h('p', { class: 'dp-hint', text: T('p.albums_none') }),
        h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.album_new') }), input]), err,
        h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(T('p.album_create_add'), function () {
          var name = input.value.trim();
          if (!name) { err.textContent = T('err.invalid'); return; }
          api('POST', 'albums', { name: name }).then(function (x) { put(x.album.id); }, function (e) { err.textContent = errText(e); });
        }, { primary: true })])]);
    }, fail);
  }

  function showAlbums() {
    var main = startPage('albums');
    api('GET', 'albums').then(function (r) {
      if (S.page !== 'albums') return;
      clear(main);
      var writable = albumAreas();
      main.appendChild(h('div', { class: 'dp-ph-bar' }, [h('p', { class: 'dp-hint dp-ph-grow', text: T('p.albums_hint') }),
        writable.length ? btn(T('p.album_new'), newAlbum, { primary: true, icon: 'plus' }) : null]));
      var list = r.albums || [];
      if (!list.length) { main.appendChild(h('div', { class: 'dp-empty', text: T('p.albums_none') })); return; }
      main.appendChild(h('div', { class: 'dp-grid' }, list.map(function (a) {
        var area = areaOf(a.areaId);
        return h('div', { class: 'dp-card', attrs: { role: 'listitem' } }, [
          h('button', { type: 'button', class: 'dp-open', on: { click: function () { openAlbum(a.id); } }, attrs: { 'aria-label': a.name } }, [
            h('div', { class: 'dp-thumb dp-thumb-tall' }, a.coverUrl ? h('img', { attrs: { src: a.coverUrl, alt: '', loading: 'lazy' } }) : icon('album', 34)),
            h('div', { class: 'dp-card-tx' }, [
              h('span', { class: 'dp-name', text: a.name, attrs: { title: a.name } }),
              h('span', { class: 'dp-meta', text: P('p.photos_n', a.count) + (area ? ' · ' + area.label : '') }),
              a.frame ? h('span', { class: 'dp-frame-badge' }, [icon('frame', 12), h('span', { text: T('p.frame_on') })]) : null,
            ]),
          ]),
        ]);
      })));
    }, fail);
  }

  function newAlbum() {
    var writable = albumAreas();
    var input = h('input', { class: 'dp-input', type: 'text', attrs: { maxlength: '100', 'aria-label': T('p.name') } });
    var mine = 'mine:' + (S.me && S.me.id);
    var sel = h('select', { class: 'dp-input', attrs: { 'aria-label': T('p.area') } }, writable.map(function (a) { return h('option', { value: a.id, text: a.label, selected: a.id === mine }); }));
    var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    dialog(T('p.album_new'), [h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.name') }), input]),
      h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.area') }), sel]),
      h('p', { class: 'dp-hint', text: T('p.album_area_hint') }), err,
      h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(T('p.create'), function () {
        var name = input.value.trim();
        if (!name) { err.textContent = T('err.invalid'); return; }
        api('POST', 'albums', { name: name, areaId: sel.value }).then(function (r) { closeDialog(); openAlbum(r.album.id); }, function (e) { err.textContent = errText(e); });
      }, { primary: true })])]);
    input.focus();
  }

  function openAlbum(id, keep) {
    if (!keep) { PH.select = false; PH.chosen = {}; }
    var main = startPage('album');
    api('GET', 'albums/' + id, null, { limit: PHOTO_PAGE }).then(function (r) {
      if (S.page !== 'album') return;
      S.album = r.album;
      PH.items = r.items || [];
      PH.next = r.next;
      renderCrumbs();
      renderAlbum(main);
    }, function (e) { fail(e); showAlbums(); });
  }

  function albumBar() {
    var a = S.album;
    return photoBar(function (count) {
      return h('span', { class: 'dp-actions' }, [
        btn(T('p.album_cover'), function () {
          api('PATCH', 'albums/' + a.id, { coverId: chosenIds()[0] }).then(function () { toast(T('p.album_cover_set')); openAlbum(a.id); }, fail);
        }, { disabled: count !== 1 }),
        btn(T('p.album_remove'), function () {
          var ids = chosenIds();
          api('DELETE', 'albums/' + a.id + '/items', { ids: ids }).then(function () { toast(P('p.album_removed', ids.length)); openAlbum(a.id); }, fail);
        }, { danger: true, disabled: !count }),
      ]);
    });
  }

  function renderAlbum(main) {
    var a = S.album;
    clear(main);
    var area = areaOf(a.areaId);
    main.appendChild(h('div', { class: 'dp-album-head' }, [
      h('div', { class: 'dp-album-tx' }, [h('h2', { class: 'dp-h2', text: a.name }), h('span', { class: 'dp-meta', text: P('p.photos_n', a.count) + (area ? ' · ' + area.label : '') }),
        a.frame ? h('span', { class: 'dp-frame-badge' }, [icon('frame', 12), h('span', { text: T('p.frame_on') })]) : null]),
      h('div', { class: 'dp-actions' }, [
        a.canFrame ? btn(a.frame ? T('p.frame_stop') : T('p.frame_start'), function () { setFrame(a, !a.frame); }, { icon: 'frame' }) : null,
        a.canEdit ? btn(T('p.rename'), function () { askName(T('p.rename'), a.name, T('p.save'), function (name) { return api('PATCH', 'albums/' + a.id, { name: name }).then(function () { openAlbum(a.id); }); }); }, { icon: 'edit' }) : null,
        a.canEdit ? btn(T('p.album_delete'), function () {
          confirmDialog(T('p.album_delete'), T('p.album_delete_text', { name: a.name }), T('p.album_delete'), function () {
            return api('DELETE', 'albums/' + a.id).then(function () { toast(T('p.album_deleted', { name: a.name })); showAlbums(); });
          }, true);
        }, { danger: true, icon: 'trash' }) : null,
      ]),
    ]));
    if (a.canEdit) main.appendChild(albumBar());
    if (!PH.items.length) { main.appendChild(h('div', { class: 'dp-empty', text: T('p.album_empty') })); return; }
    main.appendChild(h('div', { class: 'dp-phs' }, PH.items.map(function (x) { return photoTile(x, rerenderBar); })));
    if (PH.next) main.appendChild(h('div', { class: 'dp-more-row' }, btn(T('p.more'), function () {
      api('GET', 'albums/' + a.id, null, { limit: PHOTO_PAGE, before: PH.next }).then(function (r) {
        PH.items = PH.items.concat(r.items || []);
        PH.next = r.next;
        renderAlbum(main);
      }, fail);
    })));
  }

  /** The photo frame of the wall tablet on or off (asks first: everyone in front of the tablet sees the photos). */
  function setFrame(a, on) {
    var go = function () { return api('PATCH', 'albums/' + a.id, { frame: on }).then(function () { toast(T(on ? 'p.frame_started' : 'p.frame_stopped')); openAlbum(a.id); }); };
    if (!on) { go().catch(fail); return; }
    confirmDialog(T('p.frame_start'), T('p.frame_text'), T('p.frame_start'), go);
  }

  // ── storage (since 1.7.0) ────────────────────────────────

  var ST = { all: false, keep: {} };

  function showStorage(all) {
    if (all !== undefined) ST.all = !!(all && S.admin);
    var main = startPage('storage');
    api('GET', 'storage', null, { all: ST.all ? 1 : null }).then(function (r) {
      if (S.page !== 'storage') return;
      clear(main);
      ST.keep = {};
      renderStorage(main, r);
    }, fail);
  }

  function renderStorage(main, r) {
    if (S.admin) {
      main.appendChild(h('div', { class: 'dp-chips', attrs: { style: 'margin-bottom:14px' } }, [
        h('button', { type: 'button', text: T('p.storage_mine'), attrs: { 'aria-pressed': String(!ST.all) }, on: { click: function () { showStorage(false); } } }),
        h('button', { type: 'button', text: T('p.storage_all'), attrs: { 'aria-pressed': String(ST.all) }, on: { click: function () { showStorage(true); } } }),
      ]));
    }
    var tot = r.total || {};
    main.appendChild(h('div', { class: 'dp-st-sum' }, [
      stat(T('p.st_files'), fmtSize(tot.bytes), P('p.files_n', tot.files || 0)),
      stat(T('p.st_versions'), fmtSize(tot.versionsBytes), null),
      stat(T('p.st_trash'), fmtSize(tot.trashBytes), null),
      r.limit && r.limit.maxBytes ? stat(T('p.st_limit'), fmtSize(r.limit.maxBytes), null) : null,
    ]));
    // per area
    var max = Math.max.apply(null, [1].concat((r.areas || []).map(function (a) { return a.bytes + a.versionsBytes + a.trashBytes; })));
    var areasBox = h('section', { class: 'dp-st-sec' }, [h('h2', { class: 'dp-h2', text: T('p.st_areas') })]);
    (r.areas || []).forEach(function (a) {
      var all3 = a.bytes + a.versionsBytes + a.trashBytes;
      var w = function (n) { return (Math.round((n / (a.quota || max)) * 1000) / 10) + '%'; };
      areasBox.appendChild(h('div', { class: 'dp-st-area' }, [
        h('div', { class: 'dp-st-row' }, [h('span', { class: 'dp-name', text: a.label }), h('span', { class: 'dp-num', text: a.quota ? T('p.used_of', { used: fmtSize(all3), quota: fmtSize(a.quota) }) : fmtSize(all3) })]),
        h('div', { class: 'dp-st-bar', attrs: { role: 'img', 'aria-label': T('p.st_bar', { files: fmtSize(a.bytes), versions: fmtSize(a.versionsBytes), trash: fmtSize(a.trashBytes) }) } }, [
          h('span', { class: 'is-files', attrs: { style: 'width:' + w(a.bytes) } }), h('span', { class: 'is-versions', attrs: { style: 'width:' + w(a.versionsBytes) } }),
          h('span', { class: 'is-trash', attrs: { style: 'width:' + w(a.trashBytes) } })]),
        h('div', { class: 'dp-st-row' }, [h('span', { class: 'dp-meta', text: [P('p.files_n', a.files), T('p.st_versions') + ' ' + fmtSize(a.versionsBytes), T('p.st_trash') + ' ' + fmtSize(a.trashBytes)].join(' · ') }),
          a.canPrune && a.versionsBytes > 0 ? btn(T('p.prune'), function () { prune(a); }, { small: true, icon: 'history' }) : null]),
      ]));
    });
    main.appendChild(areasBox);
    if (r.people && r.people.length) {
      main.appendChild(h('section', { class: 'dp-st-sec' }, [h('h2', { class: 'dp-h2', text: T('p.st_people') }),
        h('table', { class: 'dp-table' }, [h('tbody', null, r.people.map(function (p) {
          return h('tr', null, [h('td', { text: p.name || String(p.user) }), h('td', { class: 'dp-num', text: P('p.files_n', p.files) }), h('td', { class: 'dp-num dp-right', text: fmtSize(p.bytes) })]);
        }))])]));
    }
    if (r.largest && r.largest.length) {
      main.appendChild(h('section', { class: 'dp-st-sec' }, [h('h2', { class: 'dp-h2', text: T('p.st_largest') }),
        h('div', { class: 'dp-list' }, r.largest.map(function (f) { return fileRow(f, [f.canDelete ? btn(T('p.to_trash'), function () { trashOne(f); }, { small: true, danger: true }) : null]); }))]));
    }
    main.appendChild(dupSection(r.duplicates || []));
  }

  function stat(label, value, sub) {
    return h('div', { class: 'dp-st-stat' }, [h('span', { class: 'dp-label', text: label }), h('b', { text: value }), sub ? h('span', { class: 'dp-meta', text: sub }) : null]);
  }

  /** A file of the overview: its name, where it is, its size — a click shows it in its folder (when I read the area). */
  function fileRow(f, extra) {
    var a = areaOf(f.areaId);
    var where = (a ? a.label : f.areaId) + (f.path && f.path.indexOf('/') > 0 ? ' › ' + f.path.split('/').slice(0, -1).join(' › ') : '');
    return h('div', { class: 'dp-row dp-st-file' }, [
      h('button', { type: 'button', class: 'dp-open', disabled: !a, on: { click: function () { if (a) openTarget(f.id, null); } } }, [
        h('span', { class: 'dp-ic' }, icon('file')),
        h('span', { class: 'dp-st-tx' }, [h('span', { class: 'dp-name', text: f.name, attrs: { title: f.path } }), h('span', { class: 'dp-meta', text: where + ' · ' + fmtDate(f.updatedAt) })]),
      ]),
      h('span', { class: 'dp-num dp-right', text: fmtSize(f.size) }),
      h('span', { class: 'dp-actions' }, extra),
    ]);
  }

  function trashOne(f) {
    confirmDialog(T('p.to_trash'), T('p.to_trash_file', { name: f.name, days: (S.meSettings && S.meSettings.trashDays) || 30 }), T('p.to_trash'), function () {
      return api('DELETE', 'nodes/' + f.id).then(function () { toast(T('p.trashed', { name: f.name })); showStorage(); });
    }, true);
  }

  /** Duplicates: in each group the oldest is kept, the rest marked "Löschen" — changeable; one button for all. */
  function dupSection(groups) {
    var sec = h('section', { class: 'dp-st-sec' }, [h('h2', { class: 'dp-h2', text: T('p.st_dups') })]);
    if (!groups.length) { sec.appendChild(h('p', { class: 'dp-hint', text: T('p.st_dups_none') })); return sec; }
    var drop = {};
    var go = btn('', function () {
      var ids = Object.keys(drop).filter(function (k) { return drop[k]; });
      if (!ids.length) return;
      confirmDialog(T('p.dups_trash_title'), P('p.dups_trash_text', ids.length, { days: (S.meSettings && S.meSettings.trashDays) || 30 }), T('p.to_trash'), function () {
        var n = 0;
        return ids.reduce(function (p, id) { return p.then(function () { return api('DELETE', 'nodes/' + id).then(function () { n++; }); }); }, Promise.resolve()).then(function () {
          toast(P('p.dups_trashed', n));
          loadStorage();
          showStorage();
        });
      }, true);
    }, { danger: true, icon: 'trash' });
    var label = go.querySelector('span');
    var count = function () {
      var n = Object.keys(drop).filter(function (k) { return drop[k]; }).length;
      label.textContent = P('p.dups_trash', n);
      go.disabled = !n;
    };
    groups.forEach(function (g) {
      var box = h('div', { class: 'dp-dup' }, [h('div', { class: 'dp-st-row' }, [h('b', { text: P('p.dup_title', g.count, { size: fmtSize(g.size) }) }), h('span', { class: 'dp-meta', text: T('p.dup_wasted', { size: fmtSize(g.wasted) }) })])]);
      g.items.forEach(function (f, i) {
        if (i > 0 && f.canDelete) drop[f.id] = true;
        var sel = h('select', { class: 'dp-input dp-btn-sm', disabled: !f.canDelete, attrs: { 'aria-label': T('p.dup_choice', { name: f.name }) }, on: { change: function (ev) { drop[f.id] = ev.target.value === 'drop'; count(); } } }, [
          h('option', { value: 'keep', text: T('p.dup_keep'), selected: !drop[f.id] }), h('option', { value: 'drop', text: T('p.dup_drop'), selected: !!drop[f.id] })]);
        sel.style.width = 'auto';
        box.appendChild(fileRow(f, [sel]));
      });
      sec.appendChild(box);
    });
    sec.appendChild(h('div', { class: 'dp-actions', attrs: { style: 'margin-top:12px' } }, [go]));
    count();
    return sec;
  }

  /** "Alte Versionen aufräumen": every file of the area keeps its newest `keep` versions. */
  function prune(a) {
    var input = h('input', { class: 'dp-input', type: 'number', value: '3', attrs: { min: '0', max: '500', 'aria-label': T('p.prune_keep') } });
    var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    dialog(T('p.prune_title', { area: a.label }), [h('p', { class: 'dp-hint', text: T('p.prune_text', { size: fmtSize(a.versionsBytes) }) }),
      h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.prune_keep') }), input]), err,
      h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(T('p.prune'), function () {
        var keep = Number(input.value);
        if (!(keep >= 0 && keep <= 500 && Math.floor(keep) === keep)) { err.textContent = T('err.invalid'); return; }
        api('POST', 'storage/versions/prune', { areaId: a.id, keep: keep }).then(function (r) {
          closeDialog();
          toast(P('p.pruned', r.removed, { size: fmtSize(r.freedBytes) }));
          showStorage();
        }, function (e) { err.textContent = errText(e); });
      }, { danger: true })])]);
  }

  // ── time travel (since 1.7.0) ────────────────────────────

  /** "YYYY-MM-DDTHH:MM" of a time in the browser's zone (a datetime-local field). */
  function localInput(ms) {
    var d = new Date(ms);
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** "Zeitreise": a time, the preview of what changes, then the run — its result can be undone. */
  function timeTravel(folder) {
    if (!folder) return;
    var input = h('input', { class: 'dp-input', type: 'datetime-local', value: localInput(Date.now() - 86400000), attrs: { 'aria-label': T('p.tt_when') } });
    var out = h('div', { class: 'dp-tt' });
    var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    var run = btn(T('p.tt_run'), function () { go(); }, { primary: true, disabled: true });
    var plan = null;
    var at = function () { var d = new Date(input.value); return isNaN(d.getTime()) ? null : d.toISOString(); };
    var look = function () {
      err.textContent = '';
      clear(out);
      run.disabled = true;
      plan = null;
      var when = at();
      if (!when) return;
      out.appendChild(h('p', { class: 'dp-hint', text: T('p.loading') }));
      api('GET', 'nodes/' + folder.id + '/timetravel', null, { at: when }).then(function (r) {
        if (at() !== when) return;
        plan = r;
        clear(out);
        var total = r.restore + r.revert + r.trash + r.move;
        if (r.limited) out.appendChild(h('div', { class: 'dp-note is-warn' }, [icon('info'), h('span', { text: T('p.tt_limited', { date: fmtDate(r.historySince) }) })]));
        if (r.lost) out.appendChild(h('div', { class: 'dp-note is-warn' }, [icon('info'), h('span', { text: P('p.tt_lost', r.lost, { days: (S.meSettings && S.meSettings.versionsDays) || 30 }) })]));
        if (!total) { out.appendChild(h('p', { class: 'dp-hint', text: T('p.tt_nothing') })); return; }
        out.appendChild(h('ul', { class: 'dp-tt-list' }, [
          r.restore ? h('li', { text: P('p.tt_restore', r.restore) }) : null, r.revert ? h('li', { text: P('p.tt_revert', r.revert) }) : null,
          r.move ? h('li', { text: P('p.tt_move', r.move) }) : null, r.trash ? h('li', { text: P('p.tt_trash', r.trash) }) : null]));
        if (r.sample && r.sample.length) {
          out.appendChild(h('div', { attrs: { style: 'overflow-x:auto' } }, h('table', { class: 'dp-table' }, [h('tbody', null, r.sample.map(function (x) {
            return h('tr', null, [h('td', { text: T('p.tt_op_' + x.op) }), h('td', { text: x.path || x.name })]);
          }))])));
        }
        if (r.ops > r.max) { out.appendChild(h('p', { class: 'dp-err', text: T('p.tt_too_many', { max: r.max }) })); return; }
        out.appendChild(h('p', { class: 'dp-hint', text: T('p.tt_safe') }));
        run.disabled = false;
      }, function (e) { clear(out); err.textContent = errText(e); });
    };
    var go = function () {
      if (!plan) return;
      run.disabled = true;
      api('POST', 'nodes/' + folder.id + '/timetravel', { at: plan.at }).then(function (r) {
        closeDialog();
        reload();
        loadStorage();
        ttDone(folder, r);
      }, function (e) { run.disabled = false; err.textContent = errText(e); });
    };
    input.addEventListener('change', look);
    dialog(T('p.tt_title', { name: folder.name || (areaOf(S.areaId) || {}).label || '' }), [h('p', { class: 'dp-hint', text: T('p.tt_hint') }),
      h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.tt_when') }), input]), out, err,
      h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), run])], { wide: true });
    look();
  }

  /** The result of a time travel, with "Rückgängig machen" (a time travel to the moment before it). */
  function ttDone(folder, r) {
    var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    dialog(T('p.tt_done'), [h('ul', { class: 'dp-tt-list' }, [
      h('li', { text: P('p.tt_restore', r.restored) }), h('li', { text: P('p.tt_revert', r.reverted) }), h('li', { text: P('p.tt_move', r.moved) }), h('li', { text: P('p.tt_trash', r.trashed) }),
      r.failed ? h('li', { class: 'dp-err', text: P('p.tt_failed', r.failed) }) : null]), err,
      h('div', { class: 'dp-actions' }, [btn(T('p.tt_undo'), function () {
        api('POST', 'nodes/' + folder.id + '/timetravel', { at: r.before }).then(function () { closeDialog(); reload(); loadStorage(); toast(T('p.tt_undone')); }, function (e) { err.textContent = errText(e); });
      }, { icon: 'restore' }), btn(T('p.close'), closeDialog, { primary: true })])]);
  }

  // ── live ─────────────────────────────────────────────────

  function live() {
    if (!window.GC || typeof window.GC.on !== 'function') return;
    window.GC.on('event', function (ev) {
      var d = ev && ev.data;
      // the ransomware protection stopped a device, or an incident was settled elsewhere
      if (ev && ev.type === 'guard' && d && d.incident) {
        var x = d.incident;
        S.incidents = S.incidents.filter(function (y) { return y.id !== x.id; });
        if (x.state === 'open') S.incidents.unshift(x);
        renderGuard();
        if (S.page === 'incidents') showIncidents();
        return;
      }
      // vault folders (since 1.9.0): a device asks, was approved, a new key
      if (ev && ev.type === 'vault') { if (V) V.onEvent(d); return; }
      if (!ev || ev.type !== 'changed' || !d || !Array.isArray(d.areas)) return;
      if (S.page === 'files' && d.areas.indexOf(S.areaId) >= 0 && !S.uploading) scheduleReload();
      else if (S.page === 'trash') showTrash();
    });
  }

  // vault folders (ui/vault.js, since 1.9.0): its helpers from here
  var V = window.DriveVault ? window.DriveVault.attach({
    CTX: CTX, S: S, T: T, P: P, h: h, icon: icon, btn: btn, api: api, dialog: dialog, closeDialog: closeDialog, askName: askName, toast: toast,
    fail: fail, errText: errText, copyText: copyText, fmtDate: fmtDate, personName: personName, canWrite: canWrite, reload: reload,
    renderMain: renderMain, renderUploads: renderUploads,
  }) : null;

  boot();
}());
