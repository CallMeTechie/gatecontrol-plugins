/*
 * Notizen & Aufgaben — the portal tab (mockup „Windows“ / „Portal: Mein Tag“): the menu (Privat | Arbeit, Mein Tag,
 * Wichtig, Geplant, Mir zugewiesen, the other plugins, my lists, notes), the list in the middle with the quick entry
 * (ui/quickparse.js) and the details on the right (a task, an item of another plugin, a note). Notes: cards, a note
 * with its Markdown (ui/notemd.js), Tresor notebooks (ui/vaultcrypto.js, end-to-end). „Quellen“ and „Umziehen“
 * (Microsoft To Do, DS Note: ui/nsx.js) are pages of the menu's foot.
 *
 * Runs in GateControl's sandboxed frame: the API through window.GC.call, uploads GC.upload, keys GC.keys, file bytes
 * GC.mediaBytes, live events GC.on('event'). No storage, no network of its own.
 */
(function () {
  'use strict';

  var CTX = window.NA_CTX || { texts: {}, lang: 'de' };
  var Q = window.GCQuickParse;
  var MD = window.GCNoteMd;
  var RP = window.GCRepeat;
  var VC = window.NotesVaultCrypto;
  var NSX = window.NotesNsx;
  var PL = window.NAPlaces;
  var SOURCES = ['gatecontrol-familie', 'gatecontrol-mail', 'gatecontrol-drive', 'gatecontrol-schule', 'gatecontrol-alltag'];
  var COLORS = ['none', 'yellow', 'green', 'blue', 'pink', 'grey', 'orange', 'purple'];
  var COLOR_HEX = { none: 'transparent', yellow: '#fde68a', green: '#bbf7d0', blue: '#bfdbfe', pink: '#fbcfe8', grey: '#e5e7eb', orange: '#fed7aa', purple: '#ddd6fe' };
  var COLOR_HEX_STRONG = { yellow: '#ca8a04', green: '#16a34a', blue: '#2563eb', pink: '#db2777', grey: '#6b7280', orange: '#ea580c', purple: '#7c3aed' };

  // ── helpers ──────────────────────────────────────────────

  function T(key, params) {
    var s = CTX.texts && CTX.texts[key] != null ? String(CTX.texts[key]) : key;
    if (params) Object.keys(params).forEach(function (k) { s = s.split('{{' + k + '}}').join(String(params[k] == null ? '' : params[k])); });
    return s;
  }
  var ICONS = {
    sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
    star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
    cal: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
    bell: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
    list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
    plus: 'M12 5v14M5 12h14',
    check: 'M5 12l5 5L20 7',
    note: 'M6 3h9l4 4v14H6zM14 3v5h5',
    lock: 'M6 11h12v10H6zM8 11V8a4 4 0 0 1 8 0v3',
    tag: 'M3 12V4h8l10 10-8 8zM7.5 8.5h.01',
    pin: 'M9 3h6l-1 6 4 4H6l4-4zM12 13v8',
    place: 'M12 21s7-6 7-11a7 7 0 0 0-14 0c0 5 7 11 7 11zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    back: 'M15 18l-6-6 6-6',
    open: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
    gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
    move: 'M4 12h16M14 6l6 6-6 6',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
    clip: 'M21 12l-8.5 8.5a5 5 0 0 1-7-7L14 5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 8',
    edit: 'M4 20h4L20 8l-4-4L4 16zM14 6l4 4',
    x: 'M6 6l12 12M18 6L6 18',
    menu: 'M4 6h16M4 12h16M4 18h16',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    chevr: 'M9 6l6 6-6 6',
    chevd: 'M6 9l6 6 6-6',
    folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
    cart: 'M6 6h15l-1.5 9h-12zM6 6L5 3H2M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM18 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    home: 'M3 11l9-8 9 8M5 10v10h14V10M10 20v-6h4v6',
    tool: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
    gift: 'M4 11h16v10H4zM3 7h18v4H3zM12 7v14M12 7S10.5 3 8 3a2 2 0 0 0 0 4M12 7s1.5-4 4-4a2 2 0 0 1 0 4',
    plane: 'M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z',
    heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z',
    work: 'M3 7h18v13H3zM8 7V4h8v3M3 13h18',
    leave: 'M9 21H5V3h4M16 17l5-5-5-5M21 12H9',
  };
  var WIDE = { more: '3' };
  function icon(name, size) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size || 18));
    s.setAttribute('height', String(size || 18));
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', WIDE[name] || '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', ICONS[name] || ICONS.list);
    s.appendChild(p);
    return s;
  }
  /** h('div', { class, text, on: { click }, attrs: {…}, … }, [children]) — text only via textContent. */
  function h(tag, o, kids) {
    var n = document.createElement(tag);
    o = o || {};
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      if (v == null || v === false) return;
      if (k === 'text') n.textContent = String(v);
      else if (k === 'class') n.className = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { n.addEventListener(ev, v[ev]); });
      else if (k === 'attrs') Object.keys(v).forEach(function (a) { if (v[a] != null) n.setAttribute(a, String(v[a])); });
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = !!v;
      else if (k === 'disabled') n.disabled = !!v;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    (Array.isArray(kids) ? kids : kids == null ? [] : [kids]).forEach(function (c) { if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function btn(label, fn, o) {
    o = o || {};
    return h('button', { type: 'button', class: 'dp-btn' + (o.primary ? ' dp-btn-primary' : '') + (o.danger ? ' dp-btn-danger' : '') + (o.solid ? ' is-solid' : '') + (o.small ? ' dp-btn-sm' : ''), disabled: o.disabled, on: { click: fn } },
      [o.icon ? icon(o.icon, 16) : null, h('span', { text: label })]);
  }
  function ib(name, label, fn, on) { return h('button', { type: 'button', class: 'dp-ib' + (on ? ' is-on' : ''), title: label, attrs: { 'aria-label': label }, on: { click: fn } }, icon(name)); }
  function qs(q) {
    if (!q) return '';
    var parts = [];
    Object.keys(q).forEach(function (k) { if (q[k] != null && q[k] !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(q[k]))); });
    return parts.length ? '?' + parts.join('&') : '';
  }
  function codeErr(code, extra) { var e = new Error(code); e.code = code; e.extra = extra || null; return e; }
  function api(method, path, body, query) {
    if (!window.GC) return Promise.reject(codeErr('network'));
    return window.GC.call(method, path + qs(query), body).then(function (r) { return r || {}; }, function (e) {
      var d = (e && e.data) || {};
      throw codeErr(d.code || (e && e.status === 0 ? 'network' : 'failed'), d);
    });
  }
  function errText(e) {
    var code = (e && e.code) || 'failed';
    return CTX.texts['err.' + code] ? T('err.' + code) : T('err.failed', { code: code });
  }
  var toastTimer = null;
  function toast(msg, tone) {
    var t = document.getElementById('na-toast');
    t.textContent = msg;
    t.className = 'dp-toast' + (tone === 'error' ? ' is-error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3800);
  }
  function fail(e) { toast(errText(e), 'error'); }

  function dialog(title, kids, o) {
    var back = document.getElementById('na-dialog');
    clear(back);
    var box = h('div', { class: 'dp-dialog' + (o && o.wide ? ' is-wide' : ''), role: 'dialog', attrs: { 'aria-modal': 'true', 'aria-label': title } },
      [h('div', { class: 'na-set-h' }, [h('h3', { text: title, style: 'flex:1;margin:0' }), ib('x', T('p.close'), closeDialog)])].concat(kids));
    back.appendChild(box);
    back.hidden = false;
    back.onclick = function (ev) { if (ev.target === back) closeDialog(); };
    return box;
  }
  function closeDialog() { var b = document.getElementById('na-dialog'); b.hidden = true; clear(b); }

  var WD = function (i) { return T('wd.' + i); };
  var MO = function (i) { return T('mo.' + i); };
  function addDays(d, n) { return RP.addDays(d, n); }
  /** A date as the lists show it: heute, morgen, gestern, Fr. 13. Nov. */
  function dayText(date) {
    if (!date) return '';
    var today = S.me.today;
    if (date === today) return T('w.today');
    if (date === addDays(today, 1)) return T('w.tomorrow');
    if (date === addDays(today, -1)) return T('w.yesterday');
    return shortDate(date);
  }
  /** „Sa. 21. Nov.“ (with the year when it is not this one). */
  function shortDate(date) {
    var p = date.split('-');
    return WD(RP.weekday(date)) + ' ' + Number(p[2]) + '. ' + MO(Number(p[1])) + (p[0] !== S.me.today.slice(0, 4) ? ' ' + p[0] : '');
  }
  function longDate(date) {
    var p = date.split('-');
    return T('wdl.' + RP.weekday(date)) + ', ' + Number(p[2]) + '. ' + T('mol.' + Number(p[1]));
  }
  /** An ISO time of the server (its zone's wall clock) → „14:00“ today, else „morgen 9:00“. */
  function isoWhen(iso) {
    var d = String(iso || '').slice(0, 10);
    var tm = String(iso || '').slice(11, 16).replace(/^0/, '');
    return d === S.me.today ? tm : dayText(d) + ' ' + tm;
  }
  function whenText(x) {
    var d = x.show || x.due;
    if (!d) return '';
    if (d.time && d.date === S.me.today) return d.time.replace(/^0/, '');
    if (x.type === 'source' && x.kind === 'homework' && x.due && x.due.date === addDays(S.me.today, 1)) return T('w.until_tomorrow');
    return dayText(d.date) + (d.time ? ' ' + d.time.replace(/^0/, '') : '');
  }

  // ── state ────────────────────────────────────────────────

  var S = {
    me: null, area: 'private', nav: null, view: { kind: 'smart', id: 'myday' }, data: null, detail: null, detailData: null,
    pane: 'list', people: [], vault: { device: null, keys: {}, state: {}, names: {}, vaults: {} }, editing: false, notesFilter: {},
    navOpen: false, folded: {}, listFilter: {}, popAnchor: null,
  };
  var app = function () { return document.getElementById('na-app'); };

  function load() {
    return api('GET', 'me').then(function (me) {
      S.me = me;
      var p = me.prefs || {};
      // 1.2.0: „Beim Öffnen“ — a fixed area or the one open last
      S.area = p.startArea === 'private' || p.startArea === 'work' ? p.startArea : p.area || 'private';
      document.getElementById('na-msg').hidden = true;
      app().hidden = false;
      document.getElementById('na-topbar').hidden = false;
      api('GET', 'people').then(function (r) { S.people = r.people || []; }).catch(function () {});
      return Promise.all([reloadNav(), reloadView()]);
    }).catch(function (e) {
      var m = document.getElementById('na-msg');
      clear(m);
      m.appendChild(h('b', { text: T('p.unavailable') }));
      m.appendChild(h('span', { class: 'dp-muted', text: errText(e) }));
      m.hidden = false;
    });
  }

  function reloadNav() {
    return api('GET', 'nav', null, { area: S.area }).then(function (n) {
      var first = !S.nav;
      S.nav = n;
      renderNav();
      // the rows name their list: when the view came before the menu (the first load), they are drawn again
      if (first && S.data && (S.view.kind === 'smart' || S.view.kind === 'source')) renderMain();
    }).catch(fail);
  }
  function reloadView() {
    var v = S.view;
    var p;
    if (v.kind === 'smart') p = api('GET', 'views/' + v.id, null, { area: S.area });
    else if (v.kind === 'list') p = api('GET', 'views/list:' + v.id);
    else if (v.kind === 'source') p = api('GET', 'views/source:' + v.plugin, null, { area: S.area });
    else if (v.kind === 'notes') p = loadNotes();
    else if (v.kind === 'search') p = api('GET', 'search', null, { q: v.q, area: S.area });
    else if (v.kind === 'settings') p = api('GET', 'sources');
    else if (v.kind === 'shop') p = api('GET', 'shopping');
    return p.then(function (d) {
      // a view chosen meanwhile gets its own answer
      if (S.view !== v) return;
      S.data = d;
      // 1.4.0: a shopping list that is gone (deleted, left)
      if (v.kind === 'shop' && !shopList()) { go({ kind: 'smart', id: 'myday' }); return; }
      renderMain();
      if (S.detail) reloadDetail();
    }).catch(function (e) {
      if (e && e.code === 'not_found' && v.kind !== 'smart') { go({ kind: 'smart', id: 'myday' }); return; }
      fail(e);
    });
  }
  function go(view) {
    // 1.1 pages of the menu's foot are part of „Einstellungen“ now
    if (view.kind === 'sources' || view.kind === 'import') view = { kind: 'settings' };
    closePop();
    S.view = view;
    S.detail = null;
    S.editing = false;
    S.pane = 'list';
    renderSide();
    renderNav();
    return reloadView();
  }
  function setPane(p) { S.pane = p; app().setAttribute('data-pane', p); }

  var refreshTimer = null;
  function soon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { if (!S.editing) { reloadNav(); reloadView(); } }, 400);
  }

  // ── the menu (1.2.0: as in Drive — the fixed views, „Meine Listen“ with groups as folders, the other plugins, the
  // notebooks, ⋯ at every list, group and notebook, the gear of „Einstellungen“ at the bottom left; at phone width
  // behind the menu button) ─────────────────────────────────

  var PALETTE = ['#c2410c', '#2563eb', '#0b7d70', '#7c3aed', '#be185d', '#0f766e', '#b45309', '#4d7c0f'];
  function personOf(p) { return p ? (S.people.filter(function (x) { return x.id === p.id; })[0] || p) : null; }
  function initials(name) {
    var w = String(name || '').trim().split(/\s+/).filter(Boolean);
    return w.length ? w[0].charAt(0).toUpperCase() : '?';
  }
  /** A person's small round picture: their initial on their colour. */
  function avatar(p, size) {
    var q = personOf(p) || {};
    var color = q.colorHex || PALETTE[Math.abs(Number(q.id) || 0) % PALETTE.length];
    return h('span', { class: 'na-av' + (size ? ' ' + size : ''), style: 'background:' + color, title: q.name || '', attrs: { 'aria-hidden': 'true' }, text: q.initials || initials(q.name) });
  }
  function firstName(p) { var q = personOf(p) || {}; return String(q.name || '').split(/\s+/)[0] || ''; }
  function names(list) {
    var n = (list || []).map(firstName).filter(Boolean);
    return n.length > 1 ? n.slice(0, -1).join(', ') + ' ' + T('p.and') + ' ' + n[n.length - 1] : n.join('');
  }
  function listIcon(l) { return l && l.icon && ICONS[l.icon] ? l.icon : 'list'; }
  /** „jeden Samstag“ / „Sa. und So.“ in „Mein Tag“. */
  function daysText(days) {
    if (!days || !days.length) return '';
    if (days.length === 1) return T('p.days_one', { day: T('wdl.' + days[0]) });
    return T('p.days_many', { days: days.map(function (d) { return T('wd.' + d); }).join(', ') });
  }
  function shortDays(days) { return (days || []).map(function (d) { return T('wd.' + d); }).join(' '); }

  function navRow(label, count, current, fn, o) {
    o = o || {};
    return h('button', { type: 'button', class: 'na-row' + (o.sub ? ' is-sub' : '') + (o.quiet ? ' is-quiet' : ''), attrs: { 'aria-current': current ? 'page' : null }, on: { click: function () { navGo(); fn(); setPane('list'); } } }, [
      o.icon ? h('span', { class: 'na-ic' }, icon(o.icon, 17)) : null, o.dot ? h('span', { class: 'na-dot', style: 'background:' + o.dot }) : null,
      h('span', { class: 'na-tx', text: label }), o.badge || null, count != null && count !== 0 ? h('span', { class: 'na-count', text: String(count) }) : null,
    ]);
  }
  /** A row with ⋯ at its end (lists, groups, notebooks). */
  function moreRow(row, label, items) {
    var more = h('button', { type: 'button', class: 'dp-ib na-more', title: label, attrs: { 'aria-label': label, 'aria-haspopup': 'menu' }, on: { click: function (ev) { ev.stopPropagation(); popMenu(more, items()); } } }, icon('more', 18));
    return h('div', { class: 'na-rowwrap' + (row.getAttribute('aria-current') ? ' is-current' : '') }, [row, more]);
  }
  function isView(kind, id) {
    var v = S.view;
    return v.kind === kind && (id == null || v.id === id || v.plugin === id || (kind === 'notes' && v.notebook === id));
  }
  function labRow(text, plusLabel, plusFn) {
    return h('div', { class: 'na-lab' }, [h('span', { text: text }), plusFn ? h('button', { type: 'button', class: 'dp-ib', title: plusLabel, attrs: { 'aria-label': plusLabel }, on: { click: plusFn } }, icon('plus', 16)) : null]);
  }

  function renderNav() {
    var nav = document.getElementById('na-nav');
    clear(nav);
    var n = S.nav;
    var me = (S.me && S.me.user) || {};
    nav.appendChild(h('div', { class: 'na-nav-head' }, [
      h('b', { class: 'na-nav-title', text: T('p.title') }),
      h('div', { class: 'na-me' }, [avatar(me), h('span', { class: 'na-me-tx' }, [h('b', { text: me.name || '' }), h('span', { text: T('area.' + S.area) })])]),
    ]));
    var seg = h('div', { class: 'na-seg', role: 'group', attrs: { 'aria-label': T('p.area') } });
    ['private', 'work'].forEach(function (a) {
      seg.appendChild(h('button', { type: 'button', text: T('area.' + a), attrs: { 'aria-pressed': S.area === a ? 'true' : 'false' }, on: { click: function () {
        if (S.area === a) return;
        S.area = a;
        api('PUT', 'prefs', { area: a }).catch(function () {});
        if (S.view.kind === 'list' || S.view.kind === 'shop' || (S.view.kind === 'notes' && S.view.notebook)) S.view = { kind: 'smart', id: 'myday' };
        S.detail = null;
        renderSide();
        reloadNav();
        reloadView();
      } } }));
    });
    nav.appendChild(seg);
    if (n) {
      var sm = n.smart || {};
      var lists = n.lists || [];
      var def = lists.filter(function (l) { return l.isDefault && l.role === 'owner'; })[0];
      nav.appendChild(navRow(T('v.myday'), sm.myday, isView('smart', 'myday'), function () { go({ kind: 'smart', id: 'myday' }); }, { icon: 'sun' }));
      nav.appendChild(navRow(T('v.important'), sm.important, isView('smart', 'important'), function () { go({ kind: 'smart', id: 'important' }); }, { icon: 'star' }));
      nav.appendChild(navRow(T('v.planned'), sm.planned, isView('smart', 'planned'), function () { go({ kind: 'smart', id: 'planned' }); }, { icon: 'cal' }));
      nav.appendChild(navRow(T('v.assigned'), sm.assigned, isView('smart', 'assigned'), function () { go({ kind: 'smart', id: 'assigned' }); }, { icon: 'user' }));
      if (def) nav.appendChild(moreRow(navRow(def.name, def.open, isView('list', def.id), function () { go({ kind: 'list', id: def.id }); }, { icon: listIcon(def) }), T('p.more_of', { name: def.name }), function () { return listMenu(def); }));
      // „Meine Listen“: lists without a group, then the groups as folders
      nav.appendChild(labRow(T('p.my_lists'), T('p.new_list'), function () { newListOrGroup({}); }));
      var groups = {};
      (n.groups || []).forEach(function (g) { groups[g.id] = g; });
      var byGroup = {};
      lists.forEach(function (l) { if (l === def) return; var k = l.groupId && groups[l.groupId] ? l.groupId : 0; (byGroup[k] = byGroup[k] || []).push(l); });
      (byGroup[0] || []).forEach(function (l) { nav.appendChild(listRow(l)); });
      (n.groups || []).forEach(function (g) {
        var closed = !!S.folded['g' + g.id];
        var row = h('button', { type: 'button', class: 'na-row is-folder', attrs: { 'aria-expanded': closed ? 'false' : 'true' }, on: { click: function () { S.folded['g' + g.id] = !closed; renderNav(); } } }, [
          h('span', { class: 'na-chev' }, icon(closed ? 'chevr' : 'chevd', 15)), h('span', { class: 'na-ic' }, icon('folder', 17)), h('span', { class: 'na-tx', text: g.name }),
          g.open ? h('span', { class: 'na-count', text: String(g.open) }) : null,
        ]);
        nav.appendChild(moreRow(row, T('p.more_of', { name: g.name }), function () { return groupMenu(g); }));
        if (!closed) (byGroup[g.id] || []).forEach(function (l) { nav.appendChild(listRow(l, true)); });
      });
      // 1.4.0: the shopping lists — lists of items to tick, not of tasks
      nav.appendChild(labRow(T('p.shop_lists'), T('p.shop_new'), newShopList));
      (n.shopping || []).forEach(function (l) {
        var badge = l.family ? h('span', { class: 'na-shared', title: T('p.shop_family'), attrs: { 'aria-label': T('p.shop_family') } }, icon('home', 15))
          : l.shared ? h('span', { class: 'na-shared', title: T('p.shop_shared'), attrs: { 'aria-label': T('p.shop_shared') } }, icon('users', 15)) : null;
        nav.appendChild(navRow(l.name, l.open, isView('shop', l.id), function () { goShop(l.id); }, { icon: l.icon && ICONS[l.icon] ? l.icon : 'cart', badge: badge }));
      });
      if ((n.sources || []).length) {
        nav.appendChild(labRow(T('p.from_plugins')));
        n.sources.forEach(function (s) {
          nav.appendChild(navRow(s.label, s.open, isView('source', s.plugin), function () { go({ kind: 'source', plugin: s.plugin }); }, { icon: 'open' }));
        });
      }
      var notes = n.notes || { notebooks: [], total: 0 };
      nav.appendChild(labRow(T('p.notebooks'), T('p.new_notebook'), newNotebook));
      nav.appendChild(navRow(T('p.all_notes'), notes.total, S.view.kind === 'notes' && !S.view.notebook && !S.view.tag, function () { go({ kind: 'notes' }); }, { icon: 'note' }));
      (notes.notebooks || []).forEach(function (b) {
        var label = b.vault ? (S.vault.names[b.vault.id] || T('p.vault_locked_name')) : b.bound ? b.name + ' (' + b.bound.label + ')' : b.name;
        var row = navRow(label, b.count, isView('notes', b.id), function () { go({ kind: 'notes', notebook: b.id }); }, { sub: true, icon: b.vault ? 'lock' : null, dot: b.color ? COLOR_HEX[b.color] : null, badge: sharedBadge(b) });
        nav.appendChild(b.bound ? row : moreRow(row, T('p.more_of', { name: label }), function () { return notebookMenu(b); }));
      });
      if ((notes.tags || []).length) {
        nav.appendChild(labRow(T('p.tags')));
        notes.tags.slice(0, 12).forEach(function (t) {
          nav.appendChild(navRow('#' + t.tag, t.count, S.view.kind === 'notes' && S.view.tag === t.tag, function () { go({ kind: 'notes', tag: t.tag }); }, { sub: true }));
        });
      }
    }
    // the gear of „Einstellungen“ first, at the bottom left
    var on = isView('settings');
    nav.appendChild(h('div', { class: 'na-foot' }, [
      h('button', { type: 'button', class: 'dp-ib' + (on ? ' is-on' : ''), title: T('p.settings'), attrs: { 'aria-label': T('p.settings'), 'aria-current': on ? 'page' : null }, on: { click: function () { navGo(); go({ kind: 'settings' }); } } }, icon('gear', 18)),
      h('span', { class: 'na-tip', text: T('p.settings') }),
    ]));
    var tg = document.getElementById('na-navtoggle');
    if (tg) tg.setAttribute('aria-expanded', String(!!S.navOpen));
    nav.className = 'na-nav' + (S.navOpen ? ' is-open' : '');
  }
  /** Users icon: I shared it; the owner's small picture: someone shared it with me. */
  function sharedBadge(x) {
    if (!x.shared) return null;
    if (x.role === 'owner') return h('span', { class: 'na-shared', title: T('p.shared_by_me'), attrs: { 'aria-label': T('p.shared_by_me') } }, icon('users', 15));
    return h('span', { class: 'na-shared', title: T('p.shared_by', { name: (x.owner && x.owner.name) || '' }) }, avatar(x.owner, 'xs'));
  }
  function listRow(l, sub) {
    var row = navRow(l.name, l.open, isView('list', l.id), function () { go({ kind: 'list', id: l.id }); }, { sub: !!sub, icon: listIcon(l), badge: sharedBadge(l) });
    if (l.color) row.firstChild.style.color = COLOR_HEX_STRONG[l.color] || '';
    return moreRow(row, T('p.more_of', { name: l.name }), function () { return listMenu(l); });
  }
  /** At phone width the menu closes once something was chosen. */
  function navGo() { if (S.navOpen) { S.navOpen = false; var nv = document.getElementById('na-nav'); if (nv) nv.className = 'na-nav'; var t = document.getElementById('na-navtoggle'); if (t) t.setAttribute('aria-expanded', 'false'); } }
  function toggleNav() { S.navOpen = !S.navOpen; renderNav(); }

  // ── small menus (⋯) ──────────────────────────────────────

  function inside(node, root) { for (var x = node; x; x = x.parentNode) if (x === root) return true; return false; }
  function popMenu(anchor, items) {
    var pop = document.getElementById('na-pop');
    clear(pop);
    var box = h('div', { class: 'dp-menu na-menu', role: 'menu' });
    items.forEach(function (it) {
      if (!it) return;
      if (it === '-') { box.appendChild(h('hr')); return; }
      box.appendChild(h('button', { type: 'button', role: 'menuitem', class: it.danger ? 'is-danger' : null, on: { click: function () { closePop(); it.fn(); } } },
        [icon(it.icon || 'list', 17), h('span', { class: 'na-tx', text: it.label }), it.end ? h('span', { class: 'end', text: it.end }) : null]));
    });
    pop.appendChild(box);
    pop.hidden = false;
    S.popAnchor = anchor;
    if (anchor && anchor.getBoundingClientRect) {
      var r = anchor.getBoundingClientRect();
      var w = window.innerWidth || 800;
      var hh = window.innerHeight || 600;
      var bw = 260;
      var bh = box.offsetHeight || 200;
      var left = Math.max(8, Math.min(r.right - bw, w - bw - 8));
      if (r.left + bw < w - 8 && r.right - bw < 8) left = r.left;
      var top = r.bottom + 4;
      if (top + bh > hh - 8) top = Math.max(8, r.top - bh - 4);
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
    }
    var first = box.querySelector('button');
    if (first && first.focus) first.focus();
  }
  function closePop() { var p = document.getElementById('na-pop'); if (p && !p.hidden) { p.hidden = true; clear(p); } S.popAnchor = null; }

  function listMenu(l) {
    var owner = l.role === 'owner';
    var nMembers = (l.members || []).length;
    if (owner) {
      return [
        { icon: 'edit', label: T('p.edit_dots'), fn: function () { editList(l); } },
        { icon: 'users', label: T('p.share_dots'), end: nMembers ? T('p.persons', { n: nMembers }) : null, fn: function () { shareDialog('list', l); } },
        { icon: 'folder', label: T('p.to_group'), fn: function () { moveToGroup(l); } },
        { icon: 'cart', label: T('p.listday'), end: shortDays(l.days) || T('p.off'), fn: function () { editList(l, true); } },
        l.isDefault ? null : '-',
        l.isDefault ? null : { icon: 'trash', label: T('p.delete_list_dots'), danger: true, fn: function () { deleteList(l); } },
      ];
    }
    return [
      { icon: 'folder', label: T('p.to_group'), fn: function () { moveToGroup(l); } },
      { icon: 'sun', label: T('p.show_in_myday'), end: l.mydayOff ? T('p.off') : T('p.on'), fn: function () {
        api('PATCH', 'lists/' + l.id, { mydayOff: !l.mydayOff }).then(function () { toast(l.mydayOff ? T('p.myday_on_toast') : T('p.myday_off_toast')); reloadNav(); reloadView(); }, fail);
      } },
      '-',
      { icon: 'leave', label: T('p.leave_list'), danger: true, fn: function () { leave('list', l); } },
    ];
  }
  function groupMenu(g) {
    return [
      { icon: 'plus', label: T('p.new_list_in_group'), fn: function () { newListOrGroup({ group: g.id }); } },
      { icon: 'edit', label: T('p.rename'), fn: function () { nameDialog(T('p.rename_group'), g.name, [], function (name) { return api('PATCH', 'groups/' + g.id, { name: name }).then(reloadNav); }); } },
      '-',
      { icon: 'trash', label: T('p.dissolve_dots'), danger: true, fn: function () { dissolveGroup(g); } },
    ];
  }
  function notebookMenu(b) {
    if (b.role !== 'owner') return [{ icon: 'leave', label: T('p.leave_notebook'), danger: true, fn: function () { leave('notebook', b); } }];
    var nMembers = (b.members || []).length;
    return [
      { icon: 'edit', label: T('p.edit_dots'), fn: function () { editNotebook(b); } },
      { icon: 'users', label: T('p.share_dots'), end: nMembers ? T('p.persons', { n: nMembers }) : null, fn: function () { shareDialog('notebook', b); } },
      b.isDefault ? null : '-',
      b.isDefault ? null : { icon: 'trash', label: T('p.delete_notebook_dots'), danger: true, fn: function () { deleteNotebook(b); } },
    ];
  }

  // ── the main column ──────────────────────────────────────

  function header(title, sub, extra, o) {
    o = o || {};
    var t = document.getElementById('na-topbar-title');
    if (t) t.textContent = title;
    return h('div', { class: 'na-head' }, [h('div', { class: 'na-head-tx' }, [h('h2', null, [o.icon ? icon(o.icon, 22) : null, h('span', { text: title })]), sub ? (typeof sub === 'string' ? h('span', { class: 'na-sub', text: sub }) : sub) : null])].concat(extra || []));
  }

  function viewTitle() {
    var v = S.view;
    var d = S.data || {};
    if (v.kind === 'smart') return T('v.' + v.id);
    return d.title || '';
  }

  /** Under the name of a list: who it is shared with (or by), and its day in „Mein Tag“. */
  function listSub(l) {
    var bits = [];
    var who = [];
    if (l.shared && l.role === 'owner') {
      who = l.members || [];
      bits.push(T('p.shared_with', { names: names(who) }));
    } else if (l.shared) {
      who = [l.owner];
      bits.push(T('p.shared_by', { name: firstName(l.owner) }) + (l.role === 'read' ? ' · ' + T('p.read_only') : ''));
    }
    if (l.days && l.days.length) bits.push(daysText(l.days));
    if (!bits.length) return null;
    var avs = h('span', { class: 'na-avs' }, who.slice(0, 4).map(function (p) { return avatar(p, 'sm'); }));
    return h('span', { class: 'na-sub' }, [who.length ? avs : null, h('span', { text: bits.join(' · ') })]);
  }

  function renderMain() {
    var main = document.getElementById('na-main');
    clear(main);
    var v = S.view;
    if (v.kind === 'notes') return renderNotes(main);
    if (v.kind === 'settings') return renderSettings(main);
    if (v.kind === 'search') return renderSearch(main);
    if (v.kind === 'shop') return renderShop(main);
    var d = S.data || { sections: [] };
    var l = v.kind === 'list' ? d.list : null;
    var sub = v.kind === 'smart' && v.id === 'myday' ? longDate(S.me.today) : l ? listSub(l) : null;
    var extra = [];
    if (!l || l.canEdit !== false) extra.push(quickBox(l));
    if (l && l.role !== 'owner') extra.unshift(btn(T('p.leave'), function () { leave('list', l); }, { small: true, icon: 'leave' }));
    if (l) {
      var mb = h('button', { type: 'button', class: 'dp-ib', title: T('p.more_of', { name: l.name }), attrs: { 'aria-label': T('p.more_of', { name: l.name }), 'aria-haspopup': 'menu' }, on: { click: function () { popMenu(mb, listMenu(l)); } } }, icon('more', 18));
      extra.unshift(mb);
    }
    main.appendChild(header(viewTitle(), sub, extra, { icon: l ? listIcon(l) : null }));
    // 1.3.0: „Gestern offen geblieben“ above everything of today — until every row is decided
    var yest = v.kind === 'smart' && v.id === 'myday' && d.yesterday && d.yesterday.count ? d.yesterday : null;
    if (yest) main.appendChild(yesterdayCard(yest));
    if (v.kind === 'smart' && v.id === 'myday') (d.listdays || []).forEach(function (c) { main.appendChild(listDayCard(c)); });
    var sections = d.sections || [];
    if (yest) {
      // its tasks are in „Überfällig“ too (for older apps): shown once, in the card
      var inCard = {};
      yest.items.forEach(function (x) { inCard[x.uid] = true; });
      sections = sections.map(function (s) { return s.id === 'overdue' ? Object.assign({}, s, { items: s.items.filter(function (x) { return !inCard[x.uid]; }) }) : s; });
    }
    if (l && l.shared) {
      var open = (sections.filter(function (s) { return s.id === 'open'; })[0] || { items: [] }).items;
      main.appendChild(assignFilter(l, open));
    }
    var any = false;
    sections.forEach(function (s) {
      var items = l && s.id === 'open' ? s.items.filter(filterFn(l)) : s.items;
      if (!items.length && !(v.kind === 'list' && s.id === 'open')) return;
      any = true;
      main.appendChild(sectionCard(Object.assign({}, s, { items: items })));
    });
    if (!any && !yest && !(d.listdays || []).length) main.appendChild(h('div', { class: 'na-card' }, h('div', { class: 'na-empty', text: T(v.kind === 'source' ? 'p.empty_source' : 'p.empty') })));
  }

  /** Are tasks with a time written into the person's calendar „Aufgaben“ in Mail (Mail there, both switches on)? */
  function calOn() { var c = S.me && S.me.calendar; return !!(c && c.available && c.enabled && c.mine); }

  /** 1.3.0 „Gestern offen geblieben“: each task with „Erledigt“, „Heute“, „Verschieben“; several: „Alle heute“. */
  function yesterdayCard(y) {
    var all = function (body) {
      return api('POST', 'yesterday', Object.assign({ area: S.area }, body)).then(function (r) {
        if (r.failed && r.failed.length) toast(T('p.y_failed', { n: r.failed.length }), 'error');
        soon();
      }, fail);
    };
    var move = function (x, to) { return api('POST', 'tasks/' + x.id + '/move', { to: to }).then(function (r) { toast(T('p.y_moved', { when: dayText(r.task.due ? r.task.due.date : S.me.today) })); soon(); }, fail); };
    var stop = function (fn) { return function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); fn(); }; };
    var card = h('div', { class: 'na-card na-yest' });
    card.appendChild(h('div', { class: 'na-sec' }, [h('span', { text: y.title }), h('span', { class: 'na-count', text: String(y.count) }),
      y.count > 1 ? btn(T('p.y_all_today'), function () { all({ action: 'today' }); }, { small: true }) : null]));
    y.items.forEach(function (x) {
      var l = listOf(x.listId);
      var meta = h('div', { class: 'na-meta' });
      if (l) meta.appendChild(h('span', { text: l.name }));
      if (x.due && x.due.time) meta.appendChild(h('span', { text: T('w.yesterday') + ' ' + x.due.time.replace(/^0/, '') }));
      if (x.missedReminder) meta.appendChild(h('span', { class: 'na-mi' }, [icon('bell', 13), h('span', { text: T('p.y_missed') })]));
      var mv = btn(T('p.y_move'), stop(function () {
        var items = (y.moveOptions || []).map(function (o) { return { icon: 'move', label: o.label, end: shortDate(o.date), fn: function () { move(x, o.to); } }; });
        items.push({ icon: 'cal', label: T('p.y_other'), fn: function () {
          var dd = h('input', { type: 'date', class: 'dp-input', value: addDays(S.me.today, 1), attrs: { min: S.me.today, 'aria-label': T('p.due') } });
          dialog(T('p.y_move_title', { title: x.title }), [h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.due') }), dd]),
            h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(T('p.y_move'), function () { if (!dd.value) return; closeDialog(); move(x, dd.value); }, { primary: true })])]);
        } });
        popMenu(mv, items);
      }), { small: true, disabled: x.canEdit === false });
      card.appendChild(h('div', { class: 'na-item na-yest-it', role: 'button', tabindex: '0', on: { click: function () { openDetail(x); }, keydown: function (ev) { if (ev.key === 'Enter' && ev.target === ev.currentTarget) openDetail(x); } } }, [
        h('div', { class: 'na-it' }, [h('span', { class: 'na-it-title', text: x.title }), meta.childNodes.length ? meta : null]),
        h('div', { class: 'na-yest-b' }, [
          btn(T('p.y_done'), stop(function () { complete(x, true); }), { small: true, primary: true, disabled: x.canComplete === false }),
          btn(T('p.y_today'), stop(function () { move(x, 'today'); }), { small: true, disabled: x.canEdit === false }),
          mv,
        ]),
      ]));
    });
    return card;
  }

  /** „Heute ist Einkaufstag“: a list whose day is today, at the top of „Mein Tag“. */
  function listDayCard(c) {
    var l = c.list;
    var others = l.role === 'owner' ? (l.members || []) : [l.owner].concat((l.members || []).filter(function (m) { return m.id !== S.me.user.id; }));
    var line2 = [];
    if (l.shared) line2.push(T('p.ld_shared', { names: names(others) }));
    if (c.assignedToMe) line2.push(T('p.ld_mine', { n: c.assignedToMe }));
    var peek = h('div', { class: 'na-peek' });
    (c.items || []).forEach(function (x) {
      var can = x.canComplete !== false;
      peek.appendChild(h('button', { type: 'button', class: 'na-peek-it', disabled: !can, attrs: { 'aria-label': T('p.complete') + ': ' + x.title }, on: { click: function () { complete(x, true); } } }, [h('i'), h('span', { text: x.title }), x.assignee ? avatar(x.assignee, 'xs') : null]));
    });
    // 1.4.0: the day of a shopping list — its first items, ticked right here
    (c.points || []).forEach(function (i) {
      peek.appendChild(h('button', { type: 'button', class: 'na-peek-it', disabled: l.canEdit === false, attrs: { 'aria-label': T('p.shop_tick') + ': ' + i.text }, on: { click: function () { shopOps([{ op: 'item_check', id: i.id, checked: true }]); } } },
        [h('i'), h('span', { text: i.text + (i.qty ? ' · ' + i.qty : '') })]));
    });
    if (c.more) peek.appendChild(h('span', { class: 'na-peek-more', text: T('p.ld_more', { n: c.more }) }));
    return h('div', { class: 'na-today' }, [
      h('span', { class: 'na-today-ic' }, icon(listIcon(l), 22)),
      h('div', { class: 'na-today-tx' }, [h('small', { text: c.title }), h('b', { text: T('p.ld_open', { name: l.name, n: c.open }) }), line2.length ? h('span', { text: line2.join(' · ') }) : null]),
      btn(T('p.open_list'), function () { if (c.shopping) goShop(c.shopping.id); else go({ kind: 'list', id: l.id }); }, { small: true, primary: true }),
      (c.items || []).length || (c.points || []).length ? peek : null,
    ]);
  }

  /** The filter above a shared list: Alle / Mir zugewiesen / each person / Niemandem. */
  function assignFilter(l, open) {
    var f = S.listFilter[l.id] || 'all';
    var people = [l.owner].concat(l.members || []);
    var count = function (k) { return open.filter(filterFn(l, k)).length; };
    var chips = h('div', { class: 'dp-chips na-filter', role: 'group', attrs: { 'aria-label': T('p.filter') } });
    var chip = function (k, label, av) {
      chips.appendChild(h('button', { type: 'button', attrs: { 'aria-pressed': f === k ? 'true' : 'false' }, on: { click: function () { S.listFilter[l.id] = k; renderMain(); } } }, [av || null, h('span', { text: label + ' ' + count(k) })]));
    };
    chip('all', T('p.f_all'));
    chip('me', T('v.assigned'), avatar(S.me.user, 'xs'));
    people.forEach(function (p) { if (p && p.id !== S.me.user.id) chip('u' + p.id, firstName(p), avatar(p, 'xs')); });
    chip('none', T('p.f_none'));
    return chips;
  }
  function filterFn(l, key) {
    var f = key || (l && S.listFilter[l.id]) || 'all';
    return function (x) {
      if (f === 'all') return true;
      var a = x.assignee ? x.assignee.id : null;
      if (f === 'me') return a === S.me.user.id;
      if (f === 'none') return a == null;
      return 'u' + a === f;
    };
  }

  var folded = {};
  function sectionCard(s) {
    var card = h('div', { class: 'na-card' });
    var key = S.view.kind + ':' + (S.view.id || S.view.plugin || '') + ':' + s.id;
    var closed = folded[key] != null ? folded[key] : !!s.collapsed;
    var title = s.id === 'done' && S.view.id === 'myday' ? T('v.done_today') : s.title;
    var head = h('div', { class: 'na-sec' + (s.id === 'overdue' ? ' is-over' : '') }, s.collapsed
      ? h('button', { type: 'button', attrs: { 'aria-expanded': closed ? 'false' : 'true' }, on: { click: function () { folded[key] = !closed; renderMain(); } } }, [h('span', { text: (closed ? '▸ ' : '▾ ') + title + ' (' + s.count + ')' })])
      : [h('span', { text: title }), s.items.length ? h('span', { class: 'na-count', text: String(s.items.length) }) : null]);
    card.appendChild(head);
    if (!closed) s.items.forEach(function (x) { card.appendChild(itemRow(x)); });
    return card;
  }

  function itemRow(x) {
    var open = S.detail && S.detail.uid === x.uid;
    var row = h('div', { class: 'na-item' + (open ? ' is-open' : '') + (x.done ? ' is-done' : ''), role: 'button', tabindex: '0', on: {
      click: function () { openDetail(x); },
      keydown: function (ev) { if (ev.key === 'Enter') openDetail(x); },
    } });
    if (x.type === 'task') {
      // a member who may only look: the box is greyed out unless the task is theirs
      var can = x.canComplete !== false;
      row.appendChild(h('button', { type: 'button', class: 'na-ck' + (x.done ? ' is-on' : '') + (can ? '' : ' is-off'), disabled: !can, attrs: { 'aria-label': x.done ? T('p.undo') : T('p.complete'), 'aria-pressed': x.done ? 'true' : 'false' },
        on: { click: function (ev) { ev.stopPropagation(); complete(x, !x.done); } } }, icon('check', 14)));
    } else if (x.canComplete) {
      row.appendChild(h('button', { type: 'button', class: 'na-ck' + (x.done ? ' is-on' : ''), attrs: { 'aria-label': x.done ? T('p.undo') : T('p.complete'), 'aria-pressed': x.done ? 'true' : 'false' },
        on: { click: function (ev) { ev.stopPropagation(); complete(x, !x.done); } } }, icon('check', 14)));
    } else row.appendChild(h('span', { class: 'na-ck-none' }));
    var meta = h('div', { class: 'na-meta' });
    var l = x.type === 'task' ? listOf(x.listId) : null;
    if (x.type === 'source') {
      meta.appendChild(h('span', { class: 'na-src', 'data-src': x.source.plugin, text: x.source.label + (x.kind === 'deadline' ? ' · ' + T('k.deadline') : x.kind === 'homework' ? ' · ' + T('k.homework') : x.kind === 'exam' ? ' · ' + T('k.exam') : '') }));
      if (x.subtitle) meta.appendChild(h('span', { text: x.subtitle }));
      if (x.meta && x.meta.amount) meta.appendChild(h('span', { text: x.meta.amount }));
      if (x.assignee && x.assignee.name && x.assignee.id !== S.me.user.id) meta.appendChild(h('span', { text: x.assignee.name }));
      if (x.meta && x.meta.stars) meta.appendChild(h('span', { text: T('p.stars', { n: x.meta.stars }) }));
    } else {
      if (x.source) meta.appendChild(h('span', { class: 'na-src', 'data-src': x.source.plugin, text: T('src.' + x.source.plugin) }));
      if (l && !(S.view.kind === 'list')) meta.appendChild(h('span', { text: T('area.' + l.area) + ' › ' + l.name }));
      if (x.assignee && x.assignee.id !== S.me.user.id && !(l && l.shared)) meta.appendChild(h('span', { text: x.assignee.name || '' }));
      if (x.repeatText) meta.appendChild(h('span', { text: '↻ ' + x.repeatText }));
      // 1.3.0: a reminder is to come (or was put off with „Später“), the task is in the person's calendar in Mail
      if (x.reminder && !x.done) meta.appendChild(h('span', { class: 'na-mi' }, [icon('bell', 13), h('span', { text: x.snoozed ? T('p.snoozed_until', { when: isoWhen(x.reminder.at) }) : T('p.reminder') })]));
      if (x.calendar && x.calendar.mine) meta.appendChild(h('span', { class: 'na-mi', title: T(x.calendar.state === 'pending' ? 'p.cal_pending' : 'p.cal_hint') }, [icon('cal', 13), h('span', { text: T('p.in_calendar') })]));
      // 1.4.0: the shopping list the task carries, and how far it is ticked
      if (x.attachedList) meta.appendChild(attachedChip(x.attachedList));
      // 1.5.0: the place the task hangs on
      if (x.place) meta.appendChild(h('span', { class: 'na-mi', title: PL.summary(x.place) }, [icon('place', 13), h('span', { text: x.place.name })]));
      if (x.hasNote) meta.appendChild(h('span', { text: T('p.has_note') }));
      if (x.attachments) meta.appendChild(h('span', { text: '📎 ' + x.attachments }));
    }
    if (x.progress && x.progress.total) meta.appendChild(h('span', { text: x.type === 'task' ? T('p.subtasks_n', { done: x.progress.done, total: x.progress.total }) : x.progress.done + '/' + x.progress.total }));
    row.appendChild(h('div', { class: 'na-it' }, [h('span', { class: 'na-it-title', text: x.title }), meta.childNodes.length ? meta : null]));
    if (x.important) row.appendChild(h('span', { class: 'na-src', 'data-src': 'important', text: T('p.important') }));
    var w = whenText(x);
    if (w) row.appendChild(h('span', { class: 'na-when' + (x.overdue ? ' is-over' : ''), text: w }));
    // in a shared list: the person's picture at the task; a click picks someone of the list
    if (x.type === 'task' && l && l.shared && !x.done) {
      var mine = x.assignee && x.assignee.id === S.me.user.id;
      var who = x.assignee
        ? h('button', { type: 'button', class: 'na-who', disabled: x.canEdit === false, attrs: { 'aria-label': T('p.assigned') + ': ' + (x.assignee.name || '') } }, [avatar(x.assignee, 'xs'), h('span', { text: mine ? T('p.me_short') : firstName(x.assignee) })])
        : x.canEdit !== false ? h('button', { type: 'button', class: 'na-who is-add', attrs: { 'aria-label': T('p.assign') } }, [h('span', { text: '+ ' + T('p.person') })]) : null;
      if (who) {
        who.addEventListener('click', function (ev) { ev.stopPropagation(); if (x.canEdit !== false) popMenu(who, assignItems(x, l)); });
        row.appendChild(who);
      }
    }
    if (x.type === 'task' && x.canEdit !== false) {
      row.appendChild(h('button', { type: 'button', class: 'na-star' + (x.important ? ' is-on' : ''), attrs: { 'aria-label': T('p.important'), 'aria-pressed': x.important ? 'true' : 'false' },
        on: { click: function (ev) { ev.stopPropagation(); api('PATCH', 'tasks/' + x.id, { important: !x.important }).then(soon, fail); } } }, icon('star', 17)));
    }
    return row;
  }
  /** The people a task of list `l` can go to: nobody, me, the others of the list (those who may only look marked). */
  function assignItems(x, l) {
    var set = function (id) { return function () { api('PATCH', 'tasks/' + x.id, { assigneeId: id }).then(function () { if (id && id !== S.me.user.id) toast(T('p.assigned_toast', { name: firstName({ id: id }) })); soon(); }, fail); }; };
    var out = [{ icon: 'x', label: T('p.nobody'), fn: set(null) }];
    [l.owner].concat(l.members || []).forEach(function (p) {
      if (!p) return;
      out.push({ icon: 'user', label: p.id === S.me.user.id ? T('p.me_named', { name: firstName(p) }) : p.name || '', end: p.role === 'read' ? T('p.read_short') : null, fn: set(p.id) });
    });
    return out;
  }
  function listOf(id) { return ((S.nav && S.nav.lists) || []).filter(function (l) { return l.id === id; })[0] || null; }

  function complete(x, done) {
    var p = x.type === 'task' ? api('POST', 'tasks/' + x.id + '/complete', { done: done }) : api('POST', 'items/' + x.id + '/complete', { done: done });
    x.done = done;
    renderMain();
    p.then(function (r) {
      if (r && r.next) toast(T('p.next_repeat', { when: dayText(r.next.due && r.next.due.date) }));
      else if (x.type === 'source' && done) toast(T('p.done_there', { source: x.source.label }));
      soon();
    }, function (e) { x.done = !done; renderMain(); fail(e); });
  }

  // ── shopping lists (1.4.0: lists of items to tick; a task can carry one) ─────────────────

  /** An id for a list or an item, made here (the server takes it as it is; sent again it never makes a second one). */
  function uuid() {
    var c = window.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    var s = Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
    return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20);
  }
  function shopNav() { return (S.nav && S.nav.shopping) || []; }
  function famInfo() { return (S.me && S.me.shopping && S.me.shopping.family) || {}; }
  function shopList() { var d = S.data || {}; return (d.lists || []).filter(function (l) { return l.id === S.view.id; })[0] || null; }
  function goShop(uid) { go({ kind: 'shop', id: uid }); }

  /** POST shopping/ops; „Alles abgehakt“ → the message with „Rückgängig“ for every task it completed. */
  function shopOps(ops) {
    return api('POST', 'shopping/ops', { ops: ops }).then(function (r) {
      if (r.rejected && r.rejected.length) toast(errText({ code: r.rejected[0].code }), 'error');
      (r.completed || []).slice(0, 1).forEach(function (c) {
        snack(T('p.shop_all_done', { title: c.title }), function () { api('POST', 'tasks/' + c.taskId + '/complete', { done: false }).then(soon, fail); });
      });
      soon();
      return r;
    }, fail);
  }

  /** Under the name: who it is shared with, its day. */
  function shopSub(l) {
    var bits = [];
    var who = [];
    if (l.family) bits.push(T('p.shop_family'));
    else if (l.shared && l.role === 'owner') { who = l.members || []; bits.push(T('p.shared_with', { names: names(who) })); }
    else if (l.shared) { who = [l.owner]; bits.push(T('p.shared_by', { name: firstName(l.owner) }) + (l.role === 'read' ? ' · ' + T('p.read_only') : '')); }
    else bits.push(T('p.shop_only_me'));
    if (l.days && l.days.length) bits.push(daysText(l.days));
    var avs = h('span', { class: 'na-avs' }, who.slice(0, 4).map(function (p) { return avatar(p, 'sm'); }));
    return h('span', { class: 'na-sub' }, [who.length ? avs : null, h('span', { text: bits.join(' · ') })]);
  }

  /** The list as the list dialogs know it (PATCH lists/<n>, members). */
  function asList(l) {
    return { id: l.listId, name: l.name, area: l.area, color: null, icon: l.icon, days: l.days, remind: l.remind, role: l.role, shared: l.shared, members: l.members, owner: l.owner, isDefault: false, groupId: null };
  }

  function shopMenu(l) {
    var fam = famInfo();
    var out = [];
    if (l.canManage) {
      out.push({ icon: 'edit', label: T('p.rename_dots'), fn: function () {
        nameDialog(T('p.shop_rename'), l.name, null, function (name) { return shopOps([{ op: 'list_rename', id: l.id, name: name.slice(0, 40) }]); }, { label: T('p.list_name') });
      } });
    }
    if (l.role === 'owner') {
      out.push({ icon: 'cart', label: T('p.listday'), end: shortDays(l.days) || T('p.off'), fn: function () { editList(asList(l), true); } });
      if (!l.family) out.push({ icon: 'users', label: T('p.share_dots'), end: (l.members || []).length ? T('p.persons', { n: l.members.length }) : null, fn: function () { shareDialog('list', asList(l)); } });
    }
    if (fam.bound && l.canManage && (l.family || fam.parent)) {
      out.push({ icon: 'home', label: T('p.shop_fam_share'), end: l.family ? T('p.on') : T('p.off'), fn: function () {
        api('PUT', 'shopping/lists/' + l.id + '/family', { on: !l.family }).then(function () { toast(T(l.family ? 'p.shop_fam_off' : 'p.shop_fam_on')); soon(); }, fail);
      } });
    }
    var anyDone = ((S.data && S.data.items) || []).some(function (i) { return i.listId === l.id && i.checked; });
    if (l.canEdit && anyDone) out.push({ icon: 'x', label: T('p.shop_clear'), fn: function () { shopOps([{ op: 'clear_checked', listId: l.id }]); } });
    if (l.canManage) {
      out.push('-');
      out.push({ icon: 'trash', label: T('p.delete_list_dots'), danger: true, fn: function () {
        dialog(T('p.shop_delete_title', { name: l.name }), [h('p', { class: 'dp-dialog-sub', style: 'margin:0', text: T(l.shared ? 'p.shop_delete_shared' : 'p.shop_delete_text') }),
          h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(T('p.delete'), function () {
            shopOps([{ op: 'list_delete', id: l.id }]).then(function () {
              closeDialog();
              go({ kind: 'smart', id: 'myday' });
              if (l.role === 'owner') snack(T('p.shop_deleted', { name: l.name }), function () { api('POST', 'lists/' + l.listId + '/restore').then(function () { goShop(l.id); reloadNav(); }, fail); });
            });
          }, { danger: true, solid: true })])]);
      } });
    } else {
      out.push('-');
      out.push({ icon: 'leave', label: T('p.leave_list'), danger: true, fn: function () { leave('list', asList(l)); } });
    }
    return out;
  }

  function newShopList() {
    var fam = famInfo();
    var sw = h('input', { type: 'checkbox', class: 'dp-sw', attrs: { 'aria-label': T('p.shop_fam_share') } });
    var extra = fam.bound && fam.parent ? [h('div', { class: 'na-set-h' }, [h('div', null, [h('b', { text: T('p.shop_fam_share') }), h('span', { class: 's', text: T('p.shop_fam_hint') })]), sw])] : [];
    nameDialog(T('p.shop_new'), '', extra, function (name) {
      var id = uuid();
      return api('POST', 'shopping/ops', { ops: [{ op: 'list_add', id: id, name: name.slice(0, 40), icon: 'cart', area: S.area, family: sw.checked || undefined }] }).then(function (r) {
        if (r.rejected && r.rejected.length) throw codeErr(r.rejected[0].code);
        reloadNav();
        goShop(id);
      });
    }, { label: T('p.list_name'), ok: T('p.create') });
  }

  /** „Ich gehe einkaufen“ and „Kannst du einkaufen gehen?“ of a family list (done by the Familie plugin). */
  function shopFamily(l) {
    var fam = famInfo();
    var bits = [];
    (l.going || []).forEach(function (g) { bits.push(T('p.shop_going_now', { name: firstName({ id: g.userId }) || T('p.someone') })); });
    if (l.assignee) {
      var who = firstName({ id: l.assignee.userId }) || T('p.someone');
      bits.push(T(l.assignee.state === 'taken' ? 'p.shop_asked_taken' : l.assignee.state === 'declined' ? 'p.shop_asked_declined' : 'p.shop_asked_open', { name: who }));
    }
    var box = h('div', { class: 'na-shop-fam' });
    if (bits.length) box.appendChild(h('span', { class: 'na-sub', text: bits.join(' · ') }));
    if (fam.available && l.canEdit) {
      box.appendChild(btn(T('p.shop_going'), function () {
        api('POST', 'shopping/lists/' + l.id + '/going').then(function () { toast(T('p.shop_going_sent')); soon(); }, fail);
      }, { small: true, icon: 'cart' }));
      box.appendChild(btn(T('p.shop_ask'), function () { askDialog(l); }, { small: true, icon: 'user' }));
    }
    return box.childNodes.length ? box : null;
  }
  function askDialog(l) {
    var sel = h('select', { class: 'dp-input', attrs: { 'aria-label': T('p.person') } });
    [l.owner].concat(l.members || []).forEach(function (p) { if (p && p.id !== S.me.user.id) sel.appendChild(h('option', { value: String(p.id), text: p.name || '' })); });
    var until = h('input', { type: 'time', class: 'dp-input na-time', attrs: { 'aria-label': T('p.shop_until') } });
    var errBox = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    var send = function (userId) {
      var dueAt = null;
      if (userId && until.value) { var d = new Date(S.me.today + 'T' + until.value + ':00'); if (!isNaN(d.getTime())) dueAt = d.toISOString(); }
      api('POST', 'shopping/lists/' + l.id + '/assign', { userId: userId, dueAt: dueAt }).then(function () { closeDialog(); toast(T(userId ? 'p.shop_asked' : 'p.shop_ask_ended')); soon(); }, function (e) { errBox.textContent = errText(e); });
    };
    dialog(T('p.shop_ask_title'), [labeled(T('p.person'), sel), labeled(T('p.shop_until'), until, T('p.shop_until_hint')), errBox,
      h('div', { class: 'dp-actions is-split' }, [l.assignee ? btn(T('p.shop_ask_end'), function () { send(null); }, { small: true }) : h('span'),
        h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(T('p.shop_ask_send'), function () { if (sel.value) send(Number(sel.value)); }, { primary: true })])])]);
  }

  function shopAdd(l) {
    var text = h('input', { class: 'dp-input', type: 'text', attrs: { placeholder: T('p.shop_add'), 'aria-label': T('p.shop_add'), maxlength: '120', autocomplete: 'off' } });
    var qty = h('input', { class: 'dp-input na-shop-qty', type: 'text', attrs: { placeholder: T('p.shop_qty'), 'aria-label': T('p.shop_qty'), maxlength: '40', autocomplete: 'off' } });
    var add = function () {
      var s = text.value.trim();
      if (!s) return;
      var op = { op: 'item_add', id: uuid(), listId: l.id, text: s };
      if (qty.value.trim()) op.qty = qty.value.trim();
      text.value = '';
      qty.value = '';
      shopOps([op]).then(function () { var again = document.getElementById('na-shop-text'); if (again) again.focus(); });
    };
    text.id = 'na-shop-text';
    [text, qty].forEach(function (el) { el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') add(); }); });
    return h('div', { class: 'na-add na-shop-add' }, [text, qty, ib('plus', T('p.shop_add'), add)]);
  }

  function shopRow(l, i) {
    var can = l.canEdit;
    var row = h('div', { class: 'na-item na-shop-it' + (i.checked ? ' is-done' : '') });
    row.appendChild(h('button', { type: 'button', class: 'na-ck' + (i.checked ? ' is-on' : '') + (can ? '' : ' is-off'), disabled: !can, attrs: { 'aria-label': (i.checked ? T('p.undo') : T('p.shop_tick')) + ': ' + i.text, 'aria-pressed': i.checked ? 'true' : 'false' },
      on: { click: function () { i.checked = !i.checked; renderMain(); shopOps([{ op: 'item_check', id: i.id, checked: i.checked }]); } } }, icon('check', 14)));
    var edit = function () {
      if (!can) return;
      var q = h('input', { class: 'dp-input', type: 'text', value: i.qty || '', attrs: { maxlength: '40', 'aria-label': T('p.shop_qty') } });
      nameDialog(T('p.shop_edit'), i.text, [labeled(T('p.shop_qty'), q)], function (name) { return shopOps([{ op: 'item_edit', id: i.id, text: name.slice(0, 120), qty: q.value.trim() || null }]); }, { label: T('p.shop_item') });
    };
    row.appendChild(h('button', { type: 'button', class: 'na-it na-shop-tx', disabled: !can, on: { click: edit } }, [h('span', { class: 'na-it-title', text: i.text })]));
    if (i.qty) row.appendChild(h('span', { class: 'na-when', text: i.qty }));
    if (i.checked && i.checkedBy && i.checkedBy !== S.me.user.id) row.appendChild(avatar({ id: i.checkedBy }, 'xs'));
    if (can) row.appendChild(ib('trash', T('p.delete') + ': ' + i.text, function () { shopOps([{ op: 'item_delete', id: i.id }]); }));
    return row;
  }

  function renderShop(main) {
    var d = S.data || {};
    var l = shopList();
    if (!l) return;
    var items = (d.items || []).filter(function (i) { return i.listId === l.id; });
    var open = items.filter(function (i) { return !i.checked; });
    var done = items.filter(function (i) { return i.checked; });
    var mb = h('button', { type: 'button', class: 'dp-ib', title: T('p.more_of', { name: l.name }), attrs: { 'aria-label': T('p.more_of', { name: l.name }), 'aria-haspopup': 'menu' }, on: { click: function () { popMenu(mb, shopMenu(l)); } } }, icon('more', 18));
    main.appendChild(header(l.name, shopSub(l), [mb], { icon: listIcon(l) }));
    // the task it belongs to right now, and how far it is
    if (l.tasks && l.tasks.length) {
      main.appendChild(h('div', { class: 'dp-note na-shop-of' }, [icon('check', 16), h('span', { text: T('p.shop_of', { title: l.tasks[0].title, done: done.length, total: items.length }) })]));
    }
    var fam = l.family ? shopFamily(l) : null;
    if (fam) main.appendChild(fam);
    var card = h('div', { class: 'na-card na-shop' });
    if (l.canEdit) card.appendChild(shopAdd(l));
    else card.appendChild(h('div', { class: 'dp-note' }, [icon('users', 16), h('span', { text: T('p.read_only_hint') })]));
    open.forEach(function (i) { card.appendChild(shopRow(l, i)); });
    if (!items.length) card.appendChild(h('div', { class: 'na-empty', text: T('p.shop_empty') }));
    else if (!open.length) card.appendChild(h('div', { class: 'na-empty', text: T('p.shop_all_ticked') }));
    main.appendChild(card);
    if (done.length) {
      var dc = h('div', { class: 'na-card na-shop' });
      dc.appendChild(h('div', { class: 'na-sec' }, [h('span', { text: T('p.shop_ticked') }), h('span', { class: 'na-count', text: String(done.length) }),
        l.canEdit ? h('span', { class: 'na-shop-clear' }, btn(T('p.shop_clear'), function () { shopOps([{ op: 'clear_checked', listId: l.id }]); }, { small: true })) : null]));
      done.forEach(function (i) { dc.appendChild(shopRow(l, i)); });
      main.appendChild(dc);
    }
  }

  /** At a task: „Einkauf 0/8“ — a click opens the list. */
  function attachedChip(a) {
    return h('button', { type: 'button', class: 'na-mi na-att', title: T('p.open_list'), attrs: { 'aria-label': T('p.att_open', { name: a.name }) }, on: { click: function (ev) { ev.stopPropagation(); goShop(a.uid); } } },
      [icon(a.icon && ICONS[a.icon] ? a.icon : 'cart', 13), h('span', { text: a.name + ' ' + a.done + '/' + a.total })]);
  }

  /** In a task's details: the row „Angehängte Liste“ — choose one of the person's shopping lists, or none. */
  function attachedField(t) {
    var sel = h('select', { class: 'dp-input', attrs: { 'aria-label': T('p.att_label') } }, [h('option', { value: '', text: T('p.att_none') })]);
    var lists = shopNav();
    lists.forEach(function (l) {
      sel.appendChild(h('option', { value: String(l.listId), text: l.name + ' · ' + (l.family ? T('p.shop_family') : l.shared ? T('p.shop_shared') : T('p.shop_only_me')) + ' · ' + T('v.listday_open', { n: l.open }) }));
    });
    var cur = t.attachedList;
    if (cur && !lists.some(function (l) { return l.listId === cur.id; })) sel.appendChild(h('option', { value: String(cur.id), text: cur.name }));
    sel.appendChild(h('option', { value: 'new', text: T('p.att_new') }));
    sel.value = cur ? String(cur.id) : '';
    sel.addEventListener('change', function () {
      if (sel.value === 'new') { sel.value = cur ? String(cur.id) : ''; newShopList(); return; }
      patchTask(t, { attachedListId: sel.value ? Number(sel.value) : null });
    });
    var open = cur ? ib('open', T('p.open_list'), function () { goShop(cur.uid); }) : null;
    if (open) open.setAttribute('data-keep', '');
    return field(T('p.att_label'), h('span', { class: 'na-add' }, [sel, open]));
  }

  /** 1.5.0 — in a task's details: the row „Ort“ („Baumarkt Nord · beim Ankommen“); a click opens the dialog (ui/places.js). */
  function placeField(t) {
    var p = t.place;
    var open = h('button', { type: 'button', class: 'dp-btn dp-btn-sm na-place-btn', attrs: { 'aria-label': p ? T('pl.change', { name: p.name }) : T('pl.choose') }, on: { click: function () {
      PL.choose({ place: p, onSave: function (arg) { patchTask(t, { place: arg }); } });
    } } }, [icon('place', 15), h('span', { text: p ? PL.summary(p) : T('pl.choose') })]);
    var box = h('div', null, [field(T('pl.field'), open)]);
    if (p && p.consent === 'pending') {
      // someone else's choice: the phone of the person whose task it is watches the place only after they agreed
      var mine = t.assignee ? t.assignee.id === S.me.user.id : p.by !== S.me.user.id;
      var answer = function (accept) { api('POST', 'tasks/' + t.id + '/place/consent', { accept: accept }).then(function () { reloadDetail(); soon(); }, fail); };
      var yes = btn(T('n.b_accept'), function () { answer(true); }, { small: true, primary: true });
      var no = btn(T('n.b_decline'), function () { answer(false); }, { small: true });
      yes.setAttribute('data-keep', ''); no.setAttribute('data-keep', '');
      box.appendChild(h('div', { class: 'dp-note' }, [icon('place', 16), h('span', { text: T(mine && p.by !== S.me.user.id ? 'pl.consent_me' : 'pl.consent_wait') }), mine && p.by !== S.me.user.id ? h('span', { class: 'na-add' }, [yes, no]) : null]));
    } else if (p && p.consent === 'declined') box.appendChild(h('p', { class: 'dp-hint', text: T('pl.consent_no') }));
    else if (p && p.nearby && S.me.places && S.me.places.nearby && S.me.places.search.state === 'on') box.appendChild(h('p', { class: 'dp-hint', text: T('pl.nearby_hint', { label: p.label || '' }) }));
    return box;
  }

  // ── quick entry ──────────────────────────────────────────

  function quickBox(l) {
    var input = h('input', { id: 'na-quick', type: 'text', autocomplete: 'off', attrs: { placeholder: T(l && l.shared ? 'p.quick_ph_shared' : 'p.quick_ph'), 'aria-label': T('p.quick'), maxlength: '500' } });
    var chips = h('div', { class: 'na-chips', attrs: { 'aria-live': 'polite' } });
    var parsed = null;
    // 1.4.0: the shopping list the line names („bei Lidl einkaufen“ → „Einkauf“) — asked of the server, the parser does not know it
    var att = { hint: null, forText: null, off: false, pick: null, timer: null };
    function attList() { return att.off ? null : att.pick || (att.hint && att.hint.list) || null; }
    // 1.5.0: the place the line names („beim Baumarkt“, „bei Oma“) — from the same answer; decided ones (an own place,
    // the remembered one of a kind) are taken, the others are a chip to choose from
    var pl = { hint: null, off: false, pick: null };
    function plArg() {
      if (pl.off) return null;
      if (pl.pick) return pl.pick.arg;
      var x = pl.hint;
      if (!x || !x.place || !x.certain) return null;
      return x.place.familyId ? { familyId: x.place.familyId, trigger: 'enter' } : { placeId: x.place.id, key: x.key || undefined, trigger: 'enter' };
    }
    function plChoose() {
      var x = pl.hint || {};
      PL.choose({ place: null, none: false, hint: x.key || x.query ? { key: x.key || null, label: x.key ? x.label : null, query: x.query || '' } : null,
        onSave: function (arg, name) { pl.pick = arg && (arg.placeId || arg.familyId || arg.any || arg.lat != null) ? { arg: arg, name: name } : null; pl.off = false; show(); input.focus(); } });
    }
    function ask() {
      clearTimeout(att.timer);
      var s = input.value.trim();
      if (!s) { att.hint = null; att.forText = null; att.off = false; att.pick = null; pl.hint = null; pl.off = false; pl.pick = null; return; }
      att.timer = setTimeout(function () {
        api('POST', 'parse', { text: s, area: S.area }).then(function (r) {
          if (input.value.trim() !== s) return;
          att.hint = r.attach || null;
          att.forText = s;
          pl.hint = r.place || null;
          if (att.pick && !(att.hint && att.hint.lists.some(function (x) { return x.id === att.pick.id; }))) att.pick = null;
          if (!pl.hint) { pl.pick = null; pl.off = false; }
          show();
        }, function () {});
      }, 350);
    }
    function ctxParse() {
      return { today: S.me.today, now: S.me.time, lists: ((S.nav && S.nav.lists) || []).filter(function (x) { return x.canEdit !== false; }).map(function (x) { return { id: x.id, name: x.name }; }), people: S.people, times: S.me.prefs && S.me.prefs.times };
    }
    function show() {
      clear(chips);
      var s = input.value.trim();
      parsed = s ? Q.parse(s, ctxParse()) : null;
      if (!parsed) return;
      if (parsed.date) chips.appendChild(h('span', { class: 'na-chip', text: dayText(parsed.date) + (parsed.time ? ', ' + parsed.time : '') }));
      if (parsed.remind) chips.appendChild(h('span', { class: 'na-chip', text: T('p.reminder') + ' ' + parsed.remind.time }));
      // 1.3.0: with a time it also becomes an event in the calendar „Aufgaben“ of Mail
      if (parsed.date && parsed.time && calOn()) chips.appendChild(h('span', { class: 'na-chip', title: T('p.cal_hint') }, [icon('cal', 13), h('span', { text: T('p.cal_chip', { name: S.me.calendar.name }) })]));
      if (parsed.repeat) chips.appendChild(h('span', { class: 'na-chip', text: '↻ ' + RP.describe(parsed.repeat, S.me.lang) }));
      if (parsed.important) chips.appendChild(h('span', { class: 'na-chip', text: T('p.important') }));
      if (parsed.list) chips.appendChild(h('span', { class: 'na-chip', text: T('p.list') + ': ' + parsed.list.name }));
      else if (parsed.listName && !(att.hint && att.hint.via === 'tag')) chips.appendChild(h('span', { class: 'na-chip is-plain', text: T('p.new_list_named', { name: parsed.listName }) }));
      var al = attList();
      if (al) {
        chips.appendChild(h('span', { class: 'na-chip' }, [icon('cart', 13), h('span', { text: T('p.att_chip', { name: al.name, n: al.open }) }),
          h('button', { type: 'button', class: 'na-chip-x', title: T('p.att_remove'), attrs: { 'aria-label': T('p.att_remove') }, on: { click: function () { att.off = true; show(); input.focus(); } } }, icon('x', 12))]));
      } else if (!att.off && att.hint && att.hint.lists.length > 1) {
        var choose = h('button', { type: 'button', class: 'na-chip is-plain', attrs: { 'aria-haspopup': 'menu' } }, [icon('cart', 13), h('span', { text: T('p.att_choose') })]);
        choose.addEventListener('click', function () {
          popMenu(choose, att.hint.lists.map(function (x) { return { icon: 'cart', label: x.name, end: T('v.listday_open', { n: x.open }), fn: function () { att.pick = x; show(); input.focus(); } }; }));
        });
        chips.appendChild(choose);
      }
      // 1.5.0: the place
      var px = pl.off ? null : pl.hint;
      var xBtn = function () { return h('button', { type: 'button', class: 'na-chip-x', title: T('pl.chip_remove'), attrs: { 'aria-label': T('pl.chip_remove') }, on: { click: function (ev) { ev.stopPropagation(); pl.off = true; pl.pick = null; show(); input.focus(); } } }, icon('x', 12)); };
      if (!pl.off && pl.pick) {
        chips.appendChild(h('span', { class: 'na-chip', title: T('pl.chip_title') }, [icon('place', 13), h('button', { type: 'button', class: 'na-chip-t', text: pl.pick.name + ' · ' + T(pl.pick.arg.trigger === 'exit' ? 'pl.on_exit' : 'pl.on_enter'), on: { click: plChoose } }), xBtn()]));
      } else if (px && px.place && px.certain) {
        chips.appendChild(h('span', { class: 'na-chip', title: px.uses > 1 ? T('pl.usual', { label: px.label, n: px.uses }) : T('pl.chip_title') }, [icon(px.place.familyId === 'home' ? 'home' : 'place', 13),
          h('button', { type: 'button', class: 'na-chip-t', text: px.place.name + ' · ' + T('pl.on_enter'), on: { click: plChoose } }), xBtn()]));
      } else if (px) {
        chips.appendChild(h('button', { type: 'button', class: 'na-chip is-plain', attrs: { 'aria-haspopup': 'dialog' }, on: { click: plChoose } }, [icon('place', 13), h('span', { text: T('pl.chip', { label: px.label }) })]));
      }
      if (parsed.assignee) chips.appendChild(h('span', { class: 'na-chip', text: '@' + parsed.assignee.name }));
      else if (parsed.assigneeName) chips.appendChild(h('span', { class: 'na-chip is-plain', text: T('p.unknown_person', { name: parsed.assigneeName }) }));
    }
    input.addEventListener('input', function () { show(); ask(); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' || !input.value.trim()) return;
      var text = input.value.trim();
      var body = { text: text, area: S.area, createList: !!(parsed && parsed.listName) && !(att.hint && att.hint.via === 'tag') };
      clearTimeout(att.timer);
      var al = attList();
      if (al) body.attachedListId = al.id;
      // Enter before the server answered: it attaches the list itself when exactly one fits
      else if (!att.off && att.forText !== text && shopNav().length) body.attach = 'auto';
      // 1.5.0: the place — what is chosen or decided; before the server answered it takes a decided one itself
      var pa = plArg();
      if (pa) body.place = pa;
      else if (!pl.off && att.forText !== text) body.place = 'auto';
      if (S.view.kind === 'list' && !(parsed && (parsed.list || parsed.listName))) body.listId = S.view.id;
      if (S.view.kind === 'smart' && S.view.id === 'myday') body.myDay = true;
      if (S.view.kind === 'smart' && S.view.id === 'important') body.important = true;
      input.disabled = true;
      api('POST', 'tasks', body).then(function () { input.value = ''; att.hint = null; att.forText = null; att.off = false; att.pick = null; pl.hint = null; pl.off = false; pl.pick = null; show(); input.disabled = false; input.focus(); soon(); }, function (e) { input.disabled = false; fail(e); });
    });
    return h('div', { class: 'na-quick' }, [h('label', { class: 'na-quick-box' }, [icon('plus'), input, h('span', { class: 'na-kbd', text: T('p.kbd_new') })]), chips]);
  }

  // ── details ──────────────────────────────────────────────

  function openDetail(x) {
    S.detail = { uid: x.uid, type: x.type, id: x.id };
    S.editing = false;
    setPane('detail');
    renderMain();
    reloadDetail();
  }
  function closeDetail() { S.detail = null; S.editing = false; setPane('list'); renderSide(); renderMain(); }
  function reloadDetail() {
    var d = S.detail;
    if (!d) return renderSide();
    var p = d.type === 'task' ? api('GET', 'tasks/' + d.id) : d.type === 'source' ? api('GET', 'items/' + d.id) : api('GET', 'notes/' + d.id);
    return p.then(function (r) { S.detailData = r; renderSide(); }, function (e) { if (e.code === 'not_found') { S.detail = null; renderSide(); } else fail(e); });
  }
  function renderSide() {
    var side = document.getElementById('na-side');
    clear(side);
    var wide = S.view.kind === 'settings';
    app().classList.toggle('no-side', wide);
    if (!S.detail || !S.detailData) {
      if (!wide) side.appendChild(h('div', { class: 'na-card' }, h('div', { class: 'na-empty', text: S.view.kind === 'notes' ? T('p.pick_note') : T('p.pick') })));
      return;
    }
    if (S.detail.type === 'task') side.appendChild(taskDetail(S.detailData.task));
    else if (S.detail.type === 'source') side.appendChild(itemDetail(S.detailData.item, S.detailData.taskId));
    else side.appendChild(noteDetail(S.detailData.note));
  }
  function closeRow() {
    var x = ib('x', T('p.close'), closeDetail);
    x.setAttribute('data-keep', '');
    return h('div', { class: 'na-d-foot', style: 'margin:0' }, [h('button', { type: 'button', class: 'dp-ib na-back', attrs: { 'aria-label': T('p.back'), 'data-keep': '' }, on: { click: closeDetail } }, icon('back')), h('span'), x]);
  }
  function openOriginal(open) {
    if (!open) return;
    if (window.GC && typeof window.GC.openPortal === 'function') {
      window.GC.openPortal({ plugin: open.plugin, query: { open: open.route } }).then(function (r) { if (r && r.ok === false) toast(T('p.open_there', { plugin: T('src.' + open.plugin) })); }, function () { toast(T('p.open_there', { plugin: T('src.' + open.plugin) })); });
    } else toast(T('p.open_there', { plugin: T('src.' + open.plugin) }));
  }

  function field(label, control) { return h('div', { class: 'na-f' }, [h('span', { text: label }), control]); }

  function repeatSelect(t) {
    var cur = t.repeat;
    var wd = RP.weekday((t.due && t.due.date) || S.me.today);
    var opts = [
      ['none', T('r.none'), null],
      ['daily', T('r.daily'), { type: 'daily', interval: 1 }],
      ['workdays', T('r.workdays'), { type: 'weekly', interval: 1, days: [1, 2, 3, 4, 5] }],
      ['weekly', T('r.weekly', { day: T('wdl.' + wd) }), { type: 'weekly', interval: 1, days: [wd] }],
      ['biweekly', T('r.biweekly', { day: T('wdl.' + wd) }), { type: 'weekly', interval: 2, days: [wd] }],
      ['monthly', T('r.monthly'), { type: 'monthly', interval: 1 }],
      ['yearly', T('r.yearly'), { type: 'yearly', interval: 1 }],
      ['after', T('r.after'), 'after'],
    ];
    var sel = h('select', { class: 'dp-input', attrs: { 'aria-label': T('p.repeat') } });
    var match = 'none';
    opts.forEach(function (o) {
      if (cur && o[2] && o[2] !== 'after' && JSON.stringify(RP.normalize(o[2])) === JSON.stringify(RP.normalize(cur))) match = o[0];
    });
    if (cur && match === 'none') match = cur.type === 'after' ? 'after' : 'custom';
    opts.forEach(function (o) { sel.appendChild(h('option', { value: o[0], text: o[1] })); });
    if (match === 'custom' || (cur && cur.type === 'after')) sel.appendChild(h('option', { value: 'custom', text: RP.describe(cur, S.me.lang) }));
    sel.value = cur && cur.type === 'after' ? 'custom' : match;
    sel.addEventListener('change', function () {
      var o = opts.filter(function (x) { return x[0] === sel.value; })[0];
      if (sel.value === 'custom') return;
      if (o && o[2] === 'after') {
        var n = h('input', { type: 'number', class: 'dp-input', value: '7', attrs: { min: '1', max: '365', 'aria-label': T('r.days') } });
        dialog(T('r.after'), [h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('r.days') }), n]),
          h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(T('p.save'), function () { closeDialog(); patchTask(t, { repeat: { type: 'after', interval: Math.max(1, Math.min(365, Number(n.value) || 1)) } }); }, { primary: true })])]);
        return;
      }
      patchTask(t, { repeat: o ? o[2] : null });
    });
    return sel;
  }

  function patchTask(t, body) { return api('PATCH', 'tasks/' + t.id, body).then(function (r) { S.detailData = r; renderSide(); soon(); }, fail); }

  function taskDetail(t) {
    var card = h('div', { class: 'na-card' });
    card.appendChild(closeRow());
    var title = h('textarea', { class: 'na-d-title', rows: '2', attrs: { 'aria-label': T('p.title_field'), maxlength: '300' } });
    title.value = t.title;
    title.addEventListener('change', function () { if (title.value.trim() && title.value.trim() !== t.title) patchTask(t, { title: title.value }); });
    card.appendChild(h('div', { class: 'na-set-h' }, [h('button', { type: 'button', class: 'na-ck' + (t.done ? ' is-on' : ''), attrs: { 'aria-label': T('p.complete'), 'data-keep': t.canComplete !== false ? '' : null }, on: { click: function () { complete(t, !t.done); setTimeout(reloadDetail, 600); } } }, icon('check', 14)), title,
      h('button', { type: 'button', class: 'na-star' + (t.important ? ' is-on' : ''), attrs: { 'aria-label': T('p.important') }, on: { click: function () { patchTask(t, { important: !t.important }); } } }, icon('star', 20))]));
    if (t.sourceItem) {
      var si = t.sourceItem;
      card.appendChild(h('button', { type: 'button', class: 'na-from', on: { click: function () { openOriginal(si.source.open); } } }, [h('b', { text: T('p.from', { source: si.source.label }) }), h('span', { text: (si.subtitle || si.title) + ' · ' + T('p.open') })]));
    }
    // sub tasks
    card.appendChild(h('div', { class: 'na-lb', text: T('p.subtasks') }));
    (t.subtasks || []).forEach(function (s) {
      card.appendChild(h('div', { class: 'na-subt' + (s.done ? ' is-done' : '') }, [
        h('button', { type: 'button', class: 'na-ck' + (s.done ? ' is-on' : ''), attrs: { 'aria-label': s.done ? T('p.undo') : T('p.complete') }, on: { click: function () { api('POST', 'tasks/' + s.id + '/complete', { done: !s.done }).then(reloadDetail, fail); } } }, icon('check', 12)),
        h('span', { text: s.title }), ib('trash', T('p.delete'), function () { api('DELETE', 'tasks/' + s.id).then(reloadDetail, fail); }),
      ]));
    });
    var sub = h('input', { class: 'dp-input', type: 'text', attrs: { placeholder: T('p.add_subtask'), 'aria-label': T('p.add_subtask'), maxlength: '300' } });
    sub.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && sub.value.trim()) api('POST', 'tasks', { parentId: t.id, title: sub.value }).then(function () { reloadDetail(); soon(); }, fail); });
    card.appendChild(h('div', { class: 'na-add' }, [sub]));
    // details
    card.appendChild(h('div', { class: 'na-lb', text: T('p.details') }));
    var myday = h('input', { type: 'checkbox', class: 'dp-sw', checked: t.myDay, attrs: { 'aria-label': T('p.in_myday'), 'data-keep': '' } });
    myday.addEventListener('change', function () { patchTask(t, { myDay: myday.checked }); });
    card.appendChild(field(T('p.in_myday'), myday));
    var dd = h('input', { type: 'date', class: 'dp-input', value: t.due ? t.due.date : '', attrs: { 'aria-label': T('p.due') } });
    var dt = h('input', { type: 'time', class: 'dp-input', value: t.due && t.due.time ? t.due.time : '', attrs: { 'aria-label': T('p.due_time') } });
    var setDue = function () { patchTask(t, { due: dd.value ? { date: dd.value, time: dt.value || null } : null }); };
    dd.addEventListener('change', setDue);
    dt.addEventListener('change', setDue);
    card.appendChild(field(T('p.due'), h('span', { class: 'na-add' }, [dd, dt])));
    var rm = h('input', { type: 'datetime-local', class: 'dp-input', value: t.remindAt ? t.remindAt.slice(0, 16) : '', attrs: { 'aria-label': T('p.reminder') } });
    rm.addEventListener('change', function () {
      if (!rm.value) return patchTask(t, { remindAt: null });
      patchTask(t, { remindAt: { date: rm.value.slice(0, 10), time: rm.value.slice(11, 16) } });
    });
    card.appendChild(field(T('p.reminder'), rm));
    if (t.snoozed && t.reminder) card.appendChild(h('p', { class: 'dp-hint', text: T('p.snoozed_until', { when: isoWhen(t.reminder.at) }) }));
    if (t.calendar && t.calendar.mine) card.appendChild(field(T('p.calendar'), h('span', { class: 'na-mi' }, [icon('cal', 15), h('span', { text: T(t.calendar.state === 'pending' ? 'p.cal_pending' : 'p.cal_in', { name: (S.me.calendar && S.me.calendar.name) || '' }) })])));
    card.appendChild(field(T('p.repeat'), repeatSelect(t)));
    var members = [];
    var l = listOf(t.listId);
    if (l) members = [l.owner].concat(l.members || []);
    var as = h('select', { class: 'dp-input', attrs: { 'aria-label': T('p.assigned') } }, [h('option', { value: '', text: T('p.nobody') })]);
    members.forEach(function (m) { if (m) as.appendChild(h('option', { value: String(m.id), text: (m.id === S.me.user.id ? T('p.me') : m.name || '') + (m.role === 'read' ? ' (' + T('p.read_short') + ')' : '') })); });
    as.value = t.assignee ? String(t.assignee.id) : '';
    as.addEventListener('change', function () { patchTask(t, { assigneeId: as.value ? Number(as.value) : null }); });
    card.appendChild(field(T('p.assigned'), as));
    var ls = h('select', { class: 'dp-input', attrs: { 'aria-label': T('p.list') } });
    ((S.nav && S.nav.lists) || []).forEach(function (x) { ls.appendChild(h('option', { value: String(x.id), text: T('area.' + x.area) + ' › ' + x.name })); });
    if (!listOf(t.listId)) ls.appendChild(h('option', { value: String(t.listId), text: t.list ? t.list.name : '' }));
    ls.value = String(t.listId);
    ls.addEventListener('change', function () { patchTask(t, { listId: Number(ls.value) }); });
    card.appendChild(field(T('p.list'), ls));
    // 1.4.0: the shopping list the task carries („Einkauf 0/8“; all of it ticked completes the task)
    if (!t.parentId) card.appendChild(attachedField(t));
    // 1.5.0: the place the task hangs on (the phone reminds on arriving or leaving)
    if (!t.parentId) card.appendChild(placeField(t));
    // attachments
    card.appendChild(h('div', { class: 'na-lb', text: T('p.attachments') }));
    card.appendChild(attachmentList('task', t.id, t.attachmentList || []));
    // note
    card.appendChild(h('div', { class: 'na-lb', text: T('p.note') }));
    var note = h('textarea', { class: 'dp-input', rows: '4', attrs: { 'aria-label': T('p.note'), placeholder: T('p.note_ph') } });
    note.value = t.note || '';
    note.addEventListener('change', function () { patchTask(t, { note: note.value }); });
    card.appendChild(note);
    if (t.sourceItem) card.appendChild(h('p', { class: 'dp-hint', text: T('p.done_here_there', { source: t.sourceItem.source.label }) }));
    card.appendChild(h('div', { class: 'na-d-foot' }, [h('span', { text: T('p.made', { when: new Date(t.updatedAt).toLocaleString(S.me.lang) }) }),
      btn(T('p.delete'), function () { api('DELETE', 'tasks/' + t.id).then(function () { closeDetail(); soon(); toast(T('p.deleted')); }, fail); }, { small: true, danger: true, icon: 'trash' })]));
    // 1.2.0: a member who may only look changes nothing here (only their „Mein Tag“ and, if it is theirs, done)
    if (t.canEdit === false) {
      card.querySelectorAll('input,select,textarea,button').forEach(function (el) { if (!el.hasAttribute('data-keep')) el.disabled = true; });
      card.insertBefore(h('div', { class: 'dp-note' }, [icon('users', 16), h('span', { text: T('p.read_only_hint') })]), card.childNodes[1] || null);
    }
    return card;
  }

  function itemDetail(x, taskId) {
    var card = h('div', { class: 'na-card' });
    card.appendChild(closeRow());
    card.appendChild(h('div', { class: 'na-d-title', text: x.title }));
    card.appendChild(h('button', { type: 'button', class: 'na-from', on: { click: function () { openOriginal(x.source.open); } } }, [h('b', { text: T('p.from', { source: x.source.label }) }), h('span', { text: (x.subtitle || '') + ' · ' + T('p.open') })]));
    card.appendChild(h('div', { class: 'na-lb', text: T('p.details') }));
    if (x.due) card.appendChild(field(T('p.due'), h('span', { text: dayText(x.due.date) + (x.due.time ? ' ' + x.due.time : '') })));
    if (x.show && x.lead === 'evening') card.appendChild(field(T('p.shown'), h('span', { text: dayText(x.show.date) + ' ' + x.show.time })));
    if (x.assignee && x.assignee.name) card.appendChild(field(T('p.assigned'), h('span', { text: x.assignee.name })));
    if (x.group) card.appendChild(field(T('p.group'), h('span', { text: x.group.label })));
    if (x.progress) card.appendChild(field(T('p.progress'), h('span', { text: x.progress.done + '/' + x.progress.total })));
    Object.keys(x.meta || {}).forEach(function (k) { if (k !== 'type' && typeof x.meta[k] !== 'boolean') card.appendChild(field(T('m.' + k), h('span', { text: String(x.meta[k]) }))); });
    if (x.canComplete) card.appendChild(btn(x.done ? T('p.undo') : T('p.complete_there', { source: x.source.label }), function () { complete(x, !x.done); setTimeout(reloadDetail, 600); }, { primary: !x.done, icon: 'check' }));
    if (x.canComplete && x.type === 'source') {
      card.appendChild(h('p', { class: 'dp-hint', text: T('p.carry_hint') }));
      card.appendChild(btn(taskId ? T('p.carry_open') : T('p.carry'), function () {
        api('POST', 'items/' + x.id + '/carry').then(function (r) { S.detail = { uid: 't:' + r.task.id, type: 'task', id: r.task.id }; S.detailData = r; renderSide(); soon(); }, fail);
      }, { icon: 'plus' }));
    }
    return card;
  }

  // ── attachments ──────────────────────────────────────────

  function pickFiles(cb) {
    var f = document.getElementById('na-file');
    f.value = '';
    f.onchange = function () { var files = Array.prototype.slice.call(f.files || []); if (files.length) cb(files); };
    f.click();
  }
  function upload(kind, refId, files, encrypt) {
    if (!window.GC || !window.GC.upload) { toast(T('err.unavailable'), 'error'); return Promise.resolve([]); }
    var out = [];
    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        if (file.size > S.me.attachMB * 1048576) { toast(T('err.too_large'), 'error'); return null; }
        if (encrypt) {
          return file.arrayBuffer().then(function (buf) { return encrypt(new Uint8Array(buf), file.name); }).then(function (enc) {
            return window.GC.upload(new Blob(enc.parts, { type: 'application/octet-stream' })).then(function (r) { return api('POST', 'attachments', { kind: kind, refId: refId, mediaId: r.mediaId, nameCipher: enc.nameCipher }); });
          });
        }
        return window.GC.upload(file).then(function (r) { return api('POST', 'attachments', { kind: kind, refId: refId, mediaId: r.mediaId, name: file.name }); });
      }).then(function (r) { if (r) out.push(r.attachment); }, fail);
    });
    return chain.then(function () { return out; });
  }
  function attachmentList(kind, refId, list) {
    var box = h('div', { class: 'na-atts' });
    list.forEach(function (a) {
      box.appendChild(h('div', { class: 'na-att' }, [icon('clip', 15), h('a', { href: a.url || '#', target: '_blank', rel: 'noopener', text: a.name || T('p.file') }), ib('trash', T('p.delete'), function () { api('DELETE', 'attachments/' + a.id).then(reloadDetail, fail); })]));
    });
    box.appendChild(btn(T('p.add_file'), function () { pickFiles(function (files) { upload(kind, refId, files).then(function () { reloadDetail(); soon(); }); }); }, { small: true, icon: 'clip' }));
    return box;
  }

  // ── lists, groups and notebooks: new, edit, share, delete (1.2.0) ──

  function nameDialog(title, value, extra, onSave, o) {
    o = o || {};
    var input = h('input', { class: 'dp-input', type: 'text', value: value || '', attrs: { maxlength: '80', 'aria-label': o.label || T('p.name') } });
    var errBox = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    var go = function () { if (!input.value.trim()) return; Promise.resolve(onSave(input.value.trim())).then(function (keep) { if (keep !== false) closeDialog(); }, function (e) { errBox.textContent = errText(e); }); };
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go(); });
    dialog(title, [h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: o.label || T('p.name') }), input])].concat(extra || []).concat([errBox, h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(o.ok || T('p.save'), go, { primary: true })])]));
    input.focus();
  }
  function groupSelect(cur, area) {
    var sel = h('select', { class: 'dp-input', attrs: { 'aria-label': T('p.group') } }, [h('option', { value: '', text: T('p.no_group') })]);
    ((S.nav && S.nav.groups) || []).forEach(function (g) { if (!area || g.area === area) sel.appendChild(h('option', { value: String(g.id), text: g.name })); });
    sel.value = cur ? String(cur) : '';
    return sel;
  }
  function segOf(values, cur, onPick) {
    var seg = h('div', { class: 'dp-seg', role: 'group' });
    values.forEach(function (v) {
      var b = h('button', { type: 'button', attrs: { 'aria-pressed': v[0] === cur ? 'true' : 'false' }, on: { click: function () {
        Array.prototype.forEach.call(seg.children, function (c) { c.setAttribute('aria-pressed', c === b ? 'true' : 'false'); });
        onPick(v[0]);
      } } }, [v[2] ? icon(v[2], 16) : null, h('span', { text: v[1] })]);
      seg.appendChild(b);
    });
    return seg;
  }
  function colorPicker(cur, onPick) {
    var colors = h('div', { class: 'na-colors', role: 'group', attrs: { 'aria-label': T('p.color') } });
    COLORS.forEach(function (c) {
      colors.appendChild(h('button', { type: 'button', style: 'background:' + COLOR_HEX[c], attrs: { 'aria-label': T('c.' + c), 'aria-pressed': (cur || 'none') === c ? 'true' : 'false' }, on: { click: function (ev) {
        onPick(c);
        Array.prototype.forEach.call(colors.children, function (b) { b.setAttribute('aria-pressed', b === ev.currentTarget ? 'true' : 'false'); });
      } } }));
    });
    return colors;
  }
  function labeled(label, ctl, hint) { return h('div', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: label }), ctl, hint ? h('p', { class: 'dp-hint', text: hint }) : null]); }

  /** „Neue Liste oder Gruppe“: one window, Liste | Gruppe at the top. o: { group (a list in it), kind } */
  function newListOrGroup(o) {
    var kind = o.kind || 'list';
    var body = h('div', { class: 'na-dlg-body' });
    var errBox = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    var name = h('input', { class: 'dp-input', type: 'text', attrs: { maxlength: '80' } });
    var groups = groupSelect(o.group, S.area);
    var pick = {};
    var okBtn = btn('', function () { save(); }, { primary: true });
    function draw() {
      clear(body);
      name.setAttribute('aria-label', T(kind === 'list' ? 'p.list_name' : 'p.group_name'));
      body.appendChild(labeled(T(kind === 'list' ? 'p.list_name' : 'p.group_name'), name));
      if (kind === 'list') {
        if (((S.nav && S.nav.groups) || []).length) body.appendChild(labeled(T('p.in_group'), groups));
        body.appendChild(h('p', { class: 'dp-hint', text: T('p.new_list_hint') }));
      } else {
        var lists = ((S.nav && S.nav.lists) || []).filter(function (l) { return !l.isDefault && l.area === S.area; });
        if (lists.length) {
          var box = h('div', { class: 'na-tl' });
          lists.forEach(function (l) {
            var cb = h('input', { type: 'checkbox', checked: !!pick[l.id] });
            cb.addEventListener('change', function () { pick[l.id] = cb.checked; });
            box.appendChild(h('label', null, [cb, icon(listIcon(l), 16), h('span', { text: l.name })]));
          });
          body.appendChild(labeled(T('p.put_lists'), box));
        }
      }
      okBtn.lastChild.textContent = T(kind === 'list' ? 'p.make_list' : 'p.make_group');
    }
    function save() {
      var n = name.value.trim();
      if (!n) { name.focus(); return; }
      var p = kind === 'list'
        ? api('POST', 'lists', { name: n, area: S.area, groupId: groups.value ? Number(groups.value) : null }).then(function (r) { closeDialog(); reloadNav(); go({ kind: 'list', id: r.list.id }); })
        : api('POST', 'groups', { name: n, area: S.area, lists: Object.keys(pick).filter(function (k) { return pick[k]; }).map(Number) }).then(function () { closeDialog(); reloadNav(); toast(T('p.group_made', { name: n })); });
      p.catch(function (e) { errBox.textContent = errText(e); });
    }
    name.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') save(); });
    var seg = segOf([['list', T('p.kind_list'), 'list'], ['group', T('p.kind_group'), 'folder']], kind, function (k) { kind = k; draw(); });
    dialog(T('p.new_list'), [seg, body, errBox, h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), okBtn])]);
    draw();
    name.focus();
  }

  /** „Liste bearbeiten“ (the owner): name, colour, symbol, group, days in „Mein Tag“, the push in the morning. */
  function editList(l, daysFirst) {
    var st = { color: l.color || 'none', icon: l.icon || 'list', days: (l.days || []).slice(), remind: l.remind || null };
    var name = h('input', { class: 'dp-input', type: 'text', value: l.name, attrs: { maxlength: '80', 'aria-label': T('p.name') } });
    var icons = h('div', { class: 'na-icons', role: 'group', attrs: { 'aria-label': T('p.symbol') } });
    (S.me.listIcons || ['list', 'cart', 'home', 'tool', 'gift', 'plane', 'heart', 'work']).forEach(function (ic) {
      icons.appendChild(h('button', { type: 'button', title: T('i.' + ic), attrs: { 'aria-label': T('i.' + ic), 'aria-pressed': st.icon === ic ? 'true' : 'false' }, on: { click: function (ev) {
        st.icon = ic;
        Array.prototype.forEach.call(icons.children, function (b) { b.setAttribute('aria-pressed', b === ev.currentTarget ? 'true' : 'false'); });
      } } }, icon(ic, 18)));
    });
    var groups = groupSelect(l.groupId, l.area);
    var days = h('div', { class: 'dp-chips na-days', role: 'group', attrs: { 'aria-label': T('p.days_label') } });
    var hint = h('p', { class: 'dp-hint' });
    var showHint = function () {
      var ds = st.days.slice().sort();
      var when = ds.length === 1 ? T('p.days_when_one', { day: T('wdl.' + ds[0]) }) : T('p.days_when_many', { days: ds.map(function (d) { return T('wd.' + d); }).join(', ') });
      hint.textContent = ds.length ? T(l.shared ? 'p.days_hint_shared' : 'p.days_hint', { when: when }) : T('p.days_none');
    };
    [1, 2, 3, 4, 5, 6, 7].forEach(function (d) {
      var b = h('button', { type: 'button', text: T('wd.' + d).replace('.', ''), attrs: { 'aria-label': T('wdl.' + d), 'aria-pressed': st.days.indexOf(d) >= 0 ? 'true' : 'false' }, on: { click: function () {
        var i = st.days.indexOf(d);
        if (i >= 0) st.days.splice(i, 1); else st.days.push(d);
        b.setAttribute('aria-pressed', i >= 0 ? 'false' : 'true');
        showHint();
      } } });
      days.appendChild(b);
    });
    showHint();
    var sw = h('input', { type: 'checkbox', class: 'dp-sw', checked: !!st.remind, attrs: { 'aria-label': T('p.remind_morning') } });
    var tm = h('input', { type: 'time', class: 'dp-input na-time', value: st.remind || '09:00', disabled: !st.remind, attrs: { 'aria-label': T('p.time') } });
    sw.addEventListener('change', function () { tm.disabled = !sw.checked; });
    var remind = h('div', { class: 'na-set-h' }, [h('div', null, [h('b', { text: T('p.remind_morning') }), h('span', { class: 's', text: T('p.remind_hint') })]), tm, sw]);
    var errBox = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    var save = function () {
      var n = name.value.trim();
      if (!n) { name.focus(); return; }
      var body = { name: n, color: st.color, icon: st.icon === 'list' && !l.icon ? null : st.icon, days: st.days.slice().sort(), remind: sw.checked ? (tm.value || '09:00') : null, groupId: groups.value ? Number(groups.value) : null };
      api('PATCH', 'lists/' + l.id, body).then(function () { closeDialog(); reloadNav(); reloadView(); }, function (e) { errBox.textContent = errText(e); });
    };
    var kids = [
      labeled(T('p.name'), name),
      labeled(T('p.color'), colorPicker(st.color, function (c) { st.color = c; })),
      labeled(T('p.symbol'), icons),
      labeled(T('p.group'), groups, T('p.group_own')),
      labeled(T('p.days_label'), days), hint, remind, errBox,
      h('div', { class: 'dp-actions is-split' }, [l.isDefault ? h('span') : btn(T('p.delete_list'), function () { closeDialog(); deleteList(l); }, { small: true, danger: true, icon: 'trash' }),
        h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(T('p.save'), save, { primary: true })])]),
    ];
    dialog(T('p.list_settings'), kids);
    if (daysFirst && days.firstChild) days.firstChild.focus(); else name.focus();
  }

  /** The question before deleting a list: what happens to its tasks (and who no longer sees it); then „Rückgängig“. */
  function deleteList(l) {
    api('GET', 'lists/' + l.id + '/usage').then(function (u) {
      var mode = 'move';
      var text = T('p.del_list_text', { open: u.open, done: u.done }) + (u.members.length ? ' ' + T(u.members.length === 1 ? 'p.del_members_one' : 'p.del_members', { names: names(u.members) }) : '');
      var kids = [h('p', { class: 'dp-dialog-sub', style: 'margin:0', text: text })];
      if (u.open) {
        kids.push(h('b', { text: T('p.del_what') }));
        kids.push(radios([['move', T('p.del_move', { name: (u.target && u.target.name) || T('s.default_list') }), T('p.del_move_hint', { n: u.open })], ['delete', T('p.del_all'), null]], mode, function (m) { mode = m; }));
      }
      var errBox = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      kids.push(errBox, h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(T('p.delete_list'), function () {
        api('DELETE', 'lists/' + l.id, null, { tasks: u.open ? mode : 'delete' }).then(function () {
          closeDialog();
          if (S.view.kind === 'list' && S.view.id === l.id) go({ kind: 'smart', id: 'myday' });
          reloadNav();
          snack(T('p.deleted_named', { name: l.name }), function () {
            api('POST', 'lists/' + l.id + '/restore').then(function () { reloadNav(); go({ kind: 'list', id: l.id }); toast(T('p.restored')); }, fail);
          });
        }, function (e) { errBox.textContent = errText(e); });
      }, { danger: true, solid: true })]));
      dialog(T('p.del_list_title', { name: l.name }), kids);
    }, fail);
  }
  function radios(opts, cur, onPick) {
    var box = h('div', { class: 'na-radios', role: 'radiogroup' });
    var nm = 'r' + Math.random().toString(36).slice(2);
    opts.forEach(function (o) {
      var r = h('input', { type: 'radio', name: nm, value: o[0], checked: o[0] === cur });
      r.addEventListener('change', function () { if (r.checked) onPick(o[0]); });
      box.appendChild(h('label', { class: 'dp-check na-radio' }, [r, h('span', null, [h('b', { text: o[1] }), o[2] ? h('small', { text: o[2] }) : null])]));
    });
    return box;
  }

  function moveToGroup(l) {
    var groups = groupSelect(l.groupId, l.area);
    dialog(T('p.to_group'), [labeled(T('p.group'), groups, T('p.group_own')), h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(T('p.save'), function () {
      api('PATCH', 'lists/' + l.id, { groupId: groups.value ? Number(groups.value) : null }).then(function () { closeDialog(); reloadNav(); }, fail);
    }, { primary: true })])]);
  }
  function dissolveGroup(g) {
    var inGroup = ((S.nav && S.nav.lists) || []).filter(function (l) { return l.groupId === g.id; }).map(function (l) { return l.name; });
    dialog(T('p.dissolve_title', { name: g.name }), [h('p', { class: 'dp-dialog-sub', style: 'margin:0', text: inGroup.length ? T('p.dissolve_text', { lists: inGroup.join(', ') }) : T('p.dissolve_empty') }),
      h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(T('p.dissolve'), function () {
        api('DELETE', 'groups/' + g.id).then(function () { closeDialog(); reloadNav(); }, fail);
      }, { danger: true, solid: true })])]);
  }
  function leave(kind, x) {
    var title = kind === 'list' ? T('p.leave_list_title', { name: x.name }) : T('p.leave_nb_title', { name: x.name || T('p.vault') });
    dialog(title, [h('p', { class: 'dp-dialog-sub', style: 'margin:0', text: T('p.leave_text', { name: (x.owner && x.owner.name) || '' }) }),
      h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(T('p.leave'), function () {
        api('DELETE', (kind === 'list' ? 'lists/' : 'notebooks/') + x.id).then(function () {
          closeDialog();
          go(kind === 'list' ? { kind: 'smart', id: 'myday' } : { kind: 'notes' });
          reloadNav();
        }, fail);
      }, { danger: true, solid: true })])]);
  }

  /** „… teilen“: people with a GateControl account, Ansehen or Bearbeiten each, removed at any time (saved at once). */
  function shareDialog(kind, x) {
    var path = (kind === 'list' ? 'lists/' : 'notebooks/') + x.id + '/members';
    var members = (x.members || []).map(function (m) { return { id: m.id, name: m.name, role: m.role || 'write', since: m.since || null }; });
    var q = h('input', { class: 'dp-input', type: 'search', attrs: { placeholder: T('p.share_search'), 'aria-label': T('p.share_search'), autocomplete: 'off' } });
    var found = h('div', { class: 'na-pick' });
    var who = h('div', { class: 'na-pick' });
    var errBox = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    function put() {
      return api('PUT', path, { members: members.map(function (m) { return { id: m.id, role: m.role }; }) }).then(function (r) {
        var y = r.list || r.notebook;
        members = (y.members || []).map(function (m) { return { id: m.id, name: m.name, role: m.role, since: m.since }; });
        x.members = y.members;
        x.shared = y.shared;
        errBox.textContent = '';
        draw();
        reloadNav();
      }, function (e) { errBox.textContent = e.code === 'forbidden' && e.extra && e.extra.userId ? T('p.share_not_allowed') : errText(e); });
    }
    function draw() {
      clear(found);
      var s = q.value.trim().toLowerCase();
      var have = {};
      members.forEach(function (m) { have[m.id] = true; });
      var cand = S.people.filter(function (p) { return !p.me && !have[p.id] && (!s || String(p.name || '').toLowerCase().indexOf(s) >= 0); });
      if (s || cand.length <= 6) {
        cand.slice(0, 6).forEach(function (p) {
          found.appendChild(h('div', { class: 'p' }, [avatar(p), h('span', { class: 'n' }, [h('b', { text: p.name || '' })]), btn(T('p.add'), function () { members.push({ id: p.id, name: p.name, role: 'write' }); q.value = ''; put(); }, { small: true })]));
        });
      }
      found.hidden = !found.childNodes.length;
      clear(who);
      var me = S.me.user;
      who.appendChild(h('div', { class: 'p' }, [avatar(me), h('span', { class: 'n' }, [h('b', { text: me.name + ' ' + T('p.you') }), h('small', { text: T('p.owner_hint') })]), h('span', { class: 'na-role is-static', text: T('p.owner') })]));
      members.forEach(function (m) {
        var role = h('select', { class: 'dp-input na-role', attrs: { 'aria-label': T('p.role_of', { name: m.name || '' }) } }, [h('option', { value: 'write', text: T('p.role_write') }), h('option', { value: 'read', text: T('p.role_read') })]);
        role.value = m.role;
        role.addEventListener('change', function () { m.role = role.value; put(); });
        who.appendChild(h('div', { class: 'p' }, [avatar(m), h('span', { class: 'n' }, [h('b', { text: m.name || '' }), m.since ? h('small', { text: T('p.since', { when: dayText(isoDay(m.since)) }) }) : null]), role,
          ib('x', T('p.remove_person', { name: m.name || '' }), function () { members = members.filter(function (y) { return y.id !== m.id; }); put(); })]));
      });
    }
    q.addEventListener('input', draw);
    var title = T(kind === 'list' ? 'p.share_list_title' : 'p.share_nb_title', { name: x.name || T('p.vault') });
    var kids = [h('p', { class: 'dp-dialog-sub', text: S.me.sharing === 'off' ? T('p.sharing_off') : T('p.share_sub') })];
    if (S.me.sharing !== 'off') kids.push(q, found);
    kids.push(h('b', { class: 'dp-label', text: T('p.who_access') }), who, h('div', { class: 'dp-note' }, [icon('users', 16), h('span', { text: T('p.roles_hint') })]));
    if (kind === 'notebook' && x.vault) kids.push(h('p', { class: 'dp-hint', text: T('p.vault_share_hint') }));
    kids.push(errBox, h('div', { class: 'dp-actions' }, [btn(T('p.done'), function () { closeDialog(); reloadView(); }, { primary: true })]));
    dialog(title, kids);
    draw();
    if (S.me.sharing !== 'off') q.focus();
  }

  function newNotebook() {
    var vault = false;
    var seg = h('div', { class: 'dp-seg' });
    ['plain', 'vault'].forEach(function (k) {
      var b = h('button', { type: 'button', text: T('p.nb_' + k), disabled: k === 'vault' && !S.me.vaults, attrs: { 'aria-pressed': (k === 'vault') === vault ? 'true' : 'false' }, on: { click: function () {
        vault = k === 'vault';
        hint.textContent = vault ? T('p.vault_hint') : '';
        Array.prototype.forEach.call(seg.children, function (c) { c.setAttribute('aria-pressed', c === b ? 'true' : 'false'); });
      } } });
      seg.appendChild(b);
    });
    var hint = h('p', { class: 'dp-hint' });
    nameDialog(T('p.new_notebook'), '', [seg, hint], function (name) {
      if (vault) { closeDialog(); setTimeout(function () { makeVault(name); }, 0); return null; }
      return api('POST', 'notebooks', { name: name, area: S.area }).then(function (r) { reloadNav(); go({ kind: 'notes', notebook: r.notebook.id }); });
    });
  }

  /** „Notizbuch bearbeiten“: name, colour, who has it (sharing in its own window). */
  function editNotebook(nb) {
    var st = { color: nb.color || 'none' };
    var cur = nb.vault ? (S.vault.names[nb.vault.id] || '') : nb.name;
    var name = h('input', { class: 'dp-input', type: 'text', value: cur, disabled: !!(nb.vault && !S.vault.keys[nb.vault.id]), attrs: { maxlength: '80', 'aria-label': T('p.name') } });
    var who = h('div', { class: 'na-pick' });
    (nb.members || []).forEach(function (m) {
      who.appendChild(h('div', { class: 'p' }, [avatar(m), h('span', { class: 'n' }, [h('b', { text: m.name || '' })]), h('span', { class: 'na-role is-static', text: T(m.role === 'read' ? 'p.role_read' : 'p.role_write') })]));
    });
    who.appendChild(h('button', { type: 'button', class: 'p na-pick-add', on: { click: function () { closeDialog(); shareDialog('notebook', nb); } } }, [icon('plus', 16), h('span', { text: T('p.add_person') })]));
    var errBox = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    var save = function () {
      var n = name.value.trim();
      var p;
      if (nb.vault) {
        var keys = S.vault.keys[nb.vault.id];
        p = keys && n && n !== cur ? VC.encryptName(keys.get(nb.vault.keyVersion), nb.vault.id, nb.vault.keyVersion, n).then(function (c) { S.vault.names[nb.vault.id] = n; return api('PATCH', 'notebooks/' + nb.id, { nameCipher: c, color: st.color }); })
          : api('PATCH', 'notebooks/' + nb.id, { color: st.color });
      } else {
        if (!n) { name.focus(); return; }
        p = api('PATCH', 'notebooks/' + nb.id, { name: n, color: st.color });
      }
      p.then(function () { closeDialog(); reloadNav(); reloadView(); }, function (e) { errBox.textContent = errText(e); });
    };
    dialog(T('p.nb_settings'), [labeled(T('p.name'), name), labeled(T('p.color'), colorPicker(st.color, function (c) { st.color = c; })), labeled(T('p.shared_with_label'), who), errBox,
      h('div', { class: 'dp-actions is-split' }, [nb.isDefault ? h('span') : btn(T('p.delete_notebook'), function () { closeDialog(); deleteNotebook(nb); }, { small: true, danger: true, icon: 'trash' }),
        h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(T('p.save'), save, { primary: true })])])]);
    name.focus();
  }

  /** The question before deleting a notebook: how many notes, where they can go; a Tresor asks for its name. */
  function deleteNotebook(nb) {
    api('GET', 'notebooks/' + nb.id + '/usage').then(function (u) {
      var mode = u.vault ? 'delete' : 'move';
      var label = nb.vault ? (S.vault.names[nb.vault.id] || T('p.vault')) : nb.name;
      var text = T(u.withImages ? 'p.del_nb_text_img' : 'p.del_nb_text', { n: u.notes, img: u.withImages }) + (u.members.length ? ' ' + T(u.members.length === 1 ? 'p.del_nb_members_one' : 'p.del_nb_members', { names: names(u.members) }) : '');
      var kids = [h('p', { class: 'dp-dialog-sub', style: 'margin:0', text: text })];
      if (u.notes && !u.vault) kids.push(radios([['move', T('p.del_nb_move', { name: (u.target && u.target.name) || T('s.default_notebook') }), null], ['delete', T('p.del_nb_all'), null]], mode, function (m) { mode = m; }));
      var typed = null;
      if (u.vault) {
        typed = h('input', { class: 'dp-input', type: 'text', attrs: { autocomplete: 'off', 'aria-label': T('p.type_name', { name: label }) } });
        kids.push(h('div', { class: 'dp-note is-crit' }, [icon('lock', 16), h('span', { text: T('p.del_vault_hint') })]), labeled(T('p.type_name', { name: label }), typed));
      }
      var errBox = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      kids.push(errBox, h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(T('p.delete'), function () {
        if (typed && typed.value.trim() !== label) { errBox.textContent = T('p.type_name_wrong'); typed.focus(); return; }
        api('DELETE', 'notebooks/' + nb.id, null, { notes: mode }).then(function () {
          closeDialog();
          go({ kind: 'notes' });
          reloadNav();
          snack(T('p.deleted_named', { name: label }), function () {
            api('POST', 'notebooks/' + nb.id + '/restore').then(function () { reloadNav(); go({ kind: 'notes', notebook: nb.id }); toast(T('p.restored')); }, fail);
          });
        }, function (e) { errBox.textContent = errText(e); });
      }, { danger: true, solid: true })]));
      dialog(T('p.del_nb_title', { name: label }), kids);
    }, fail);
  }

  var snackTimer = null;
  /** A message with „Rückgängig“ for a few seconds. */
  function snack(msg, undo) {
    var s = document.getElementById('na-snack');
    clear(s);
    s.appendChild(h('span', { text: msg }));
    if (undo) s.appendChild(h('button', { type: 'button', class: 'dp-snack-undo', text: T('p.undo_action'), on: { click: function () { s.hidden = true; clearTimeout(snackTimer); undo(); } } }));
    s.hidden = false;
    clearTimeout(snackTimer);
    snackTimer = setTimeout(function () { s.hidden = true; }, 8000);
  }

  // ── notes ────────────────────────────────────────────────

  function notebookOf(id) { return (((S.nav && S.nav.notes) || {}).notebooks || []).filter(function (b) { return b.id === id; })[0] || null; }

  function loadNotes() {
    var v = S.view;
    var nb = v.notebook ? notebookOf(v.notebook) : null;
    if (nb && nb.vault) {
      return vaultReady(nb).then(function (state) {
        if (state !== 'approved') return { locked: state, notebook: nb, notes: [] };
        return api('GET', 'notes', null, { notebook: nb.id, limit: 200 }).then(function (r) { return decryptTitles(nb, r.notes).then(function () { return { notebook: nb, notes: r.notes, next: r.next }; }); });
      });
    }
    var q = { area: S.area, notebook: v.notebook || null, tag: v.tag || null };
    return Promise.all([api('GET', 'notes', null, Object.assign({ pinned: '1', limit: 50 }, q)), api('GET', 'notes', null, Object.assign({ limit: 60 }, q))]).then(function (x) {
      return { notebook: nb, pinned: x[0].notes, notes: x[1].notes.filter(function (n) { return !n.pinned; }), next: x[1].next };
    });
  }
  function noteCard(n) {
    var open = S.detail && S.detail.type === 'note' && S.detail.id === n.id;
    var nb = notebookOf(n.notebookId);
    var title = n.encrypted ? (S.vault.names['n' + n.id] || T('p.vault_note')) : (n.title || firstLine(n.snippet) || T('p.untitled'));
    var meta = h('div', { class: 'na-meta' });
    (n.tags || []).slice(0, 3).forEach(function (t) { meta.appendChild(h('span', { text: '#' + t })); });
    if (nb && S.view.kind === 'notes' && !S.view.notebook) meta.appendChild(h('span', { text: nb.vault ? T('p.vault') : nb.name }));
    if (n.check) meta.appendChild(h('span', { text: n.check.done + '/' + n.check.total }));
    if (n.images) meta.appendChild(h('span', { text: T('p.images_n', { n: n.images }) }));
    meta.appendChild(h('span', { text: dayText(isoDay(n.updatedAt)) }));
    return h('button', { type: 'button', class: 'na-nc' + (open ? ' is-open' : '') + (n.encrypted && !S.vault.names['n' + n.id] ? ' is-locked' : ''), 'data-color': n.color || null, on: { click: function () { openDetail({ uid: 'n:' + n.id, type: 'note', id: n.id }); } } },
      [h('b', { text: title }), n.snippet ? h('span', { class: 'na-snip', text: n.snippet }) : null, meta]);
  }
  function firstLine(s) { return String(s || '').split(' · ')[0].slice(0, 80); }
  function isoDay(ms) {
    var d = new Date(ms);
    var p = function (v) { return (v < 10 ? '0' : '') + v; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function renderNotes(main) {
    var d = S.data || {};
    var v = S.view;
    var nb = d.notebook;
    var title = v.tag ? '#' + v.tag : nb ? (nb.vault ? (S.vault.names[nb.vault.id] || T('p.vault_locked_name')) : nb.name) : T('p.all_notes');
    var actions = h('div', { class: 'dp-actions' }, [
      h('label', { class: 'na-quick-box', style: 'min-height:38px' }, [icon('search', 16), h('input', { type: 'search', attrs: { placeholder: T('p.search_ph'), 'aria-label': T('p.search') }, on: { keydown: function (ev) {
        if (ev.key === 'Enter' && ev.target.value.trim().length >= 2) go({ kind: 'search', q: ev.target.value.trim() });
      } } })]),
      nb && nb.canEdit === false ? null : btn(T('p.new_note'), function () { newNote(nb); }, { primary: true, icon: 'plus', disabled: !!(nb && nb.vault && !S.vault.keys[nb.vault.id]) }),
    ]);
    if (nb && !nb.bound) {
      var mb = h('button', { type: 'button', class: 'dp-ib', title: T('p.more_of', { name: title }), attrs: { 'aria-label': T('p.more_of', { name: title }), 'aria-haspopup': 'menu' }, on: { click: function () { popMenu(mb, notebookMenu(nb)); } } }, icon('more', 18));
      actions.appendChild(mb);
    }
    var nbSub = null;
    if (nb && nb.bound) nbSub = T('p.bound_hint', { plugin: nb.bound.label });
    else if (nb && nb.shared) nbSub = h('span', { class: 'na-sub' }, [h('span', { class: 'na-avs' }, (nb.role === 'owner' ? nb.members : [nb.owner]).slice(0, 4).map(function (p) { return avatar(p, 'sm'); })),
      h('span', { text: nb.role === 'owner' ? T('p.shared_with', { names: names(nb.members) }) : T('p.shared_by', { name: firstName(nb.owner) }) + (nb.role === 'read' ? ' · ' + T('p.read_only') : '') })]);
    main.appendChild(header(title, nbSub, [actions]));
    if (d.locked) { main.appendChild(lockedCard(nb, d.locked)); return; }
    if (nb && nb.vault) vaultBanner(main, nb);
    // notebooks as chips (mockup Notizen)
    if (!nb && !v.tag) {
      var chips = h('div', { class: 'dp-chips' });
      (((S.nav && S.nav.notes) || {}).notebooks || []).forEach(function (b) {
        chips.appendChild(h('button', { type: 'button', text: b.vault ? '🔒 ' + (S.vault.names[b.vault.id] || T('p.vault')) : b.name, attrs: { 'aria-pressed': 'false' }, on: { click: function () { go({ kind: 'notes', notebook: b.id }); } } }));
      });
      main.appendChild(chips);
    }
    if ((d.pinned || []).length) {
      main.appendChild(h('div', { class: 'na-sec', style: 'padding:4px 2px' }, h('span', { text: T('p.pinned') })));
      main.appendChild(h('div', { class: 'na-notes' }, d.pinned.map(noteCard)));
    }
    main.appendChild(h('div', { class: 'na-sec', style: 'padding:4px 2px' }, h('span', { text: T('p.recent') })));
    if (!(d.notes || []).length && !(d.pinned || []).length) main.appendChild(h('div', { class: 'na-card' }, h('div', { class: 'na-empty', text: T('p.no_notes') })));
    else main.appendChild(h('div', { class: 'na-notes' }, (d.notes || []).map(noteCard)));
    if (d.next) main.appendChild(btn(T('p.more_notes'), function () {
      api('GET', 'notes', null, { area: S.area, notebook: v.notebook || null, tag: v.tag || null, before: d.next, limit: 60 }).then(function (r) {
        var add = nb && nb.vault ? decryptTitles(nb, r.notes) : Promise.resolve();
        return add.then(function () { d.notes = d.notes.concat(r.notes.filter(function (n) { return !n.pinned || (nb && nb.vault); })); d.next = r.next; renderMain(); });
      }, fail);
    }, { small: true }));
  }
  function newNote(nb) {
    if (nb && nb.vault) {
      var keys = S.vault.keys[nb.vault.id];
      return encryptNote(nb, T('p.untitled'), '').then(function (enc) { return api('POST', 'notes', { notebookId: nb.id, titleCipher: enc.titleCipher, cipher: enc.cipher, keyVersion: enc.keyVersion }); })
        .then(function (r) { S.vault.names['n' + r.note.id] = T('p.untitled'); soon(); openNote(r.note.id, true); }, fail);
    }
    api('POST', 'notes', { notebookId: nb ? nb.id : null, area: S.area, title: '', body: '' }).then(function (r) { soon(); openNote(r.note.id, true); }, fail);
  }
  function openNote(id, edit) {
    S.detail = { uid: 'n:' + id, type: 'note', id: id };
    S.editing = !!edit;
    setPane('detail');
    reloadDetail();
  }
  /** The text of a note, its toolbar, its check boxes (a line → a task), attachments, pin, colour, move. */
  function noteDetail(n) {
    var card = h('div', { class: 'na-card' });
    card.appendChild(closeRow());
    var nb = notebookOf(n.notebookId);
    var vaultNb = nb && nb.vault ? nb : null;
    var plain = { title: n.title, body: n.body };
    var ready = Promise.resolve(plain);
    if (vaultNb) {
      if (!S.vault.keys[vaultNb.vault.id]) { card.appendChild(lockedCard(vaultNb, 'locked')); return card; }
      ready = decryptNote(vaultNb, n);
    }
    var holder = h('div', { class: 'na-note' }, h('p', { class: 'dp-muted', text: T('p.loading') }));
    card.appendChild(h('div', { class: 'na-sub', text: (vaultNb ? '🔒 ' + (S.vault.names[vaultNb.vault.id] || T('p.vault')) : nb ? nb.name : '') + ' · ' + T('p.saved') }));
    card.appendChild(holder);
    ready.then(function (pt) {
      clear(holder);
      if (S.editing) return editNote(holder, n, pt, vaultNb);
      holder.appendChild(h('h2', { text: pt.title || T('p.untitled'), style: 'margin:0' }));
      var atts = {};
      (n.attachments || []).forEach(function (a) { atts[a.id] = a; });
      var body = h('div', { class: 'na-note' });
      var html = MD.render(pt.body || '', {
        checkable: true,
        att: function (id) { var a = atts[id]; return a ? { url: a.encrypted ? null : a.url, name: a.name || (S.vault.names['a' + id] || T('p.file')), mime: a.encrypted ? 'application/octet-stream' : a.mime } : null; },
        task: function (id) { var t = (n.tasks || []).filter(function (x) { return x.id === id; })[0]; return t ? { label: T('p.task_chip') + (t.due ? ' · ' + dayText(t.due.date) : ''), done: t.done } : null; },
      });
      setHtml(body, html);
      // check boxes, „→ Aufgabe“ and task chips
      Array.prototype.forEach.call(body.querySelectorAll('.nm-box'), function (box) {
        if (nb && nb.canEdit === false) { box.disabled = true; return; }
        box.addEventListener('change', function () {
          var ln = Number(box.getAttribute('data-line'));
          if (vaultNb) {
            var md = MD.toggle(pt.body, ln, box.checked);
            saveVaultNote(vaultNb, n, pt.title, md).then(reloadDetail, fail);
          } else api('POST', 'notes/' + n.id + '/check', { line: ln, done: box.checked }).then(function (r) { S.detailData = r; renderSide(); soon(); }, fail);
        });
        var li = box.parentNode;
        if (!vaultNb && li && !li.querySelector('.nm-task')) {
          li.appendChild(h('button', { type: 'button', class: 'nm-totask', text: T('p.to_task'), on: { click: function () {
            api('POST', 'notes/' + n.id + '/task', { line: Number(box.getAttribute('data-line')) }).then(function () { toast(T('p.task_made')); reloadDetail(); soon(); }, fail);
          } } }));
        }
      });
      Array.prototype.forEach.call(body.querySelectorAll('.nm-task'), function (a) {
        a.addEventListener('click', function (ev) { ev.preventDefault(); openDetail({ uid: 't:' + a.getAttribute('data-task'), type: 'task', id: Number(a.getAttribute('data-task')) }); });
      });
      Array.prototype.forEach.call(body.querySelectorAll('[data-att]'), function (el) {
        var a = atts[Number(el.getAttribute('data-att'))];
        if (a && a.encrypted && vaultNb) showVaultAttachment(vaultNb, a, el);
      });
      holder.appendChild(body);
      var rest = (n.attachments || []).filter(function (a) { return (pt.body || '').indexOf('(att:' + a.id + ')') < 0; });
      if (rest.length) {
        holder.appendChild(h('div', { class: 'na-lb', text: T('p.attachments') }));
        rest.forEach(function (a) {
          var link = h('a', { href: a.url || '#', target: '_blank', rel: 'noopener', text: a.name || S.vault.names['a' + a.id] || T('p.file') });
          if (a.encrypted && vaultNb) { link.href = '#'; showVaultAttachment(vaultNb, a, link); }
          holder.appendChild(h('div', { class: 'na-att' }, [icon('clip', 15), link]));
        });
      }
    }, function (e) { clear(holder); holder.appendChild(h('p', { class: 'dp-err', text: errText(e) })); });
    // tools
    var tools = h('div', { class: 'dp-actions', style: 'justify-content:flex-start' }, [
      btn(T('p.edit'), function () { S.editing = true; renderSide(); }, { small: true, icon: 'edit' }),
      ib('pin', n.pinned ? T('p.unpin') : T('p.pin'), function () { api('PATCH', 'notes/' + n.id, { pinned: !n.pinned }).then(function (r) { S.detailData = r; renderSide(); soon(); }, fail); }, n.pinned),
      ib('clip', T('p.add_file'), function () { pickFiles(function (files) { addNoteFiles(n, files, vaultNb); }); }),
    ]);
    var colors = h('div', { class: 'na-colors', role: 'group', attrs: { 'aria-label': T('p.color') } });
    COLORS.forEach(function (c) {
      colors.appendChild(h('button', { type: 'button', style: 'background:' + COLOR_HEX[c], attrs: { 'aria-label': T('c.' + c), 'aria-pressed': (n.color || 'none') === c ? 'true' : 'false' }, on: { click: function () {
        api('PATCH', 'notes/' + n.id, { color: c }).then(function (r) { S.detailData = r; renderSide(); soon(); }, fail);
      } } }));
    });
    var ro = !!(nb && nb.canEdit === false);
    if (ro) card.appendChild(h('div', { class: 'dp-note' }, [icon('users', 16), h('span', { text: T('p.read_only_nb_hint') })]));
    if (!S.editing && !ro) { card.appendChild(tools); card.appendChild(colors); }
    var move = h('select', { class: 'dp-input', attrs: { 'aria-label': T('p.move_to') } });
    (((S.nav && S.nav.notes) || {}).notebooks || []).forEach(function (b) { if (!!b.vault === !!vaultNb && (!vaultNb || b.id === vaultNb.id)) move.appendChild(h('option', { value: String(b.id), text: b.vault ? T('p.vault') : b.name })); });
    move.value = String(n.notebookId);
    move.addEventListener('change', function () { api('PATCH', 'notes/' + n.id, { notebookId: Number(move.value) }).then(function () { soon(); reloadDetail(); }, fail); });
    if (!S.editing && !vaultNb && !ro) card.appendChild(field(T('p.move_to'), move));
    if (!S.editing && !ro) card.appendChild(h('div', { class: 'na-d-foot' }, [h('span', { text: T('p.changed', { when: new Date(n.updatedAt).toLocaleString(S.me.lang) }) }),
      btn(T('p.delete'), function () { api('DELETE', 'notes/' + n.id).then(function () { closeDetail(); soon(); toast(T('p.deleted')); }, fail); }, { small: true, danger: true, icon: 'trash' })]));
    return card;
  }
  /** Rendered Markdown (notemd.js escapes every text and builds only its own tags) into a node. */
  function setHtml(node, html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    node.appendChild(tpl.content);
  }

  function editNote(holder, n, pt, vaultNb) {
    var title = h('input', { class: 'dp-input', type: 'text', value: pt.title || '', attrs: { placeholder: T('p.title_field'), 'aria-label': T('p.title_field'), maxlength: '300' } });
    var ta = h('textarea', { class: 'dp-input na-editor', attrs: { 'aria-label': T('p.text'), placeholder: T('p.text_ph'), spellcheck: 'true' } });
    ta.value = pt.body || '';
    function wrap(before, after, ph) {
      var s = ta.selectionStart, e = ta.selectionEnd;
      var sel = ta.value.slice(s, e) || ph || '';
      ta.setRangeText(before + sel + (after || ''), s, e, 'end');
      ta.focus();
    }
    function prefix(p) {
      var s = ta.selectionStart;
      var start = ta.value.lastIndexOf('\n', s - 1) + 1;
      ta.setRangeText(p, start, start, 'end');
      ta.focus();
    }
    var tools = h('div', { class: 'na-tools', role: 'toolbar', attrs: { 'aria-label': T('p.format') } }, [
      h('button', { type: 'button', text: 'H', title: T('f.heading'), on: { click: function () { prefix('## '); } } }),
      h('button', { type: 'button', text: 'B', title: T('f.bold'), style: 'font-weight:900', on: { click: function () { wrap('**', '**', T('f.bold')); } } }),
      h('button', { type: 'button', text: 'I', title: T('f.italic'), style: 'font-style:italic', on: { click: function () { wrap('*', '*', T('f.italic')); } } }),
      h('button', { type: 'button', text: '•', title: T('f.list'), on: { click: function () { prefix('- '); } } }),
      h('button', { type: 'button', text: '1.', title: T('f.numbered'), on: { click: function () { prefix('1. '); } } }),
      h('button', { type: 'button', text: '☐', title: T('f.check'), on: { click: function () { prefix('- [ ] '); } } }),
      h('button', { type: 'button', text: '▦', title: T('f.table'), on: { click: function () { wrap('\n| ' + T('f.col') + ' 1 | ' + T('f.col') + ' 2 |\n| --- | --- |\n|  |  |\n', ''); } } }),
      h('button', { type: 'button', text: '🔗', title: T('f.link'), on: { click: function () { wrap('[', '](https://)', T('f.link_text')); } } }),
      h('button', { type: 'button', text: '🖼', title: T('f.image'), on: { click: function () {
        pickFiles(function (files) {
          addNoteFiles(n, files, vaultNb, true).then(function (list) {
            list.forEach(function (a, i) { wrap('\n' + (/^image\//.test(files[i].type) ? '!' : '') + '[' + files[i].name.replace(/[[\]()]/g, '') + '](att:' + a.id + ')\n', ''); });
          });
        });
      } } }),
    ]);
    var errBox = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    function save(close) {
      var p = vaultNb ? saveVaultNote(vaultNb, n, title.value, ta.value) : api('PATCH', 'notes/' + n.id, { title: title.value, body: ta.value, rev: n.rev });
      return p.then(function (r) {
        if (close) { S.editing = false; reloadDetail(); } else if (r && r.note) n.rev = r.note.rev;
        soon();
      }, function (e) { errBox.textContent = e.code === 'conflict' ? T('err.note_conflict') : errText(e); });
    }
    var timer = null;
    ta.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { save(false); }, 2500); });
    ta.addEventListener('keydown', function (ev) { if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') { ev.preventDefault(); clearTimeout(timer); save(true); } });
    holder.appendChild(title);
    holder.appendChild(tools);
    holder.appendChild(ta);
    holder.appendChild(h('p', { class: 'dp-hint', text: T('p.md_hint') }));
    holder.appendChild(errBox);
    holder.appendChild(h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), function () { clearTimeout(timer); S.editing = false; reloadDetail(); }), btn(T('p.done'), function () { clearTimeout(timer); save(true); }, { primary: true, icon: 'check' })]));
    setTimeout(function () { (pt.title ? ta : title).focus(); }, 0);
  }

  function addNoteFiles(n, files, vaultNb, quiet) {
    var enc = vaultNb ? function (bytes, name) { return encryptFile(vaultNb, bytes, name); } : null;
    return upload('note', n.id, files, enc).then(function (list) { if (!quiet) reloadDetail(); soon(); return list; });
  }

  function renderSearch(main) {
    var d = S.data || {};
    main.appendChild(header(T('p.search_for', { q: S.view.q }), null, []));
    var any = false;
    if ((d.tasks || []).length || (d.items || []).length) {
      any = true;
      main.appendChild(sectionCard({ id: 'tasks', title: T('p.tasks'), items: (d.tasks || []).concat(d.items || []), count: 0 }));
    }
    if ((d.notes || []).length) {
      any = true;
      main.appendChild(h('div', { class: 'na-sec', style: 'padding:4px 2px' }, h('span', { text: T('p.notes') })));
      main.appendChild(h('div', { class: 'na-notes' }, d.notes.map(function (n) {
        var c = noteCard(n);
        if (n.hit) { var s = c.querySelector('.na-snip') || c.appendChild(h('span', { class: 'na-snip' })); clear(s); markHit(s, n.hit); }
        return c;
      })));
    }
    if (!any) main.appendChild(h('div', { class: 'na-card' }, h('div', { class: 'na-empty', text: T('p.nothing_found') })));
  }
  function markHit(node, hit) {
    String(hit).split('\u0002').forEach(function (part, i) {
      if (i === 0) { node.appendChild(document.createTextNode(part)); return; }
      var p = part.split('\u0003');
      node.appendChild(h('mark', { text: p[0] }));
      node.appendChild(document.createTextNode(p.slice(1).join('')));
    });
  }

  // ── Tresor notebooks (end-to-end, ui/vaultcrypto.js) ─────

  function keyName() { return 'notes-device-' + String(S.me.user.id); }
  function vaultSupported() { return VC && window.GC && window.GC.keys ? VC.supported() : Promise.resolve(false); }
  function device() {
    if (S.vault.device) return Promise.resolve(S.vault.device);
    return window.GC.keys.get(keyName()).then(function (kp) {
      if (kp && kp.privateKey && kp.publicKey) return kp;
      return VC.generateDeviceKey().then(function (fresh) { return window.GC.keys.put(keyName(), { publicKey: fresh.publicKey, privateKey: fresh.privateKey }).then(function () { return fresh; }); });
    }).then(function (kp) {
      return VC.exportPublic(kp.publicKey).then(function (raw) {
        return VC.deviceId(raw).then(function (id) { S.vault.device = { privateKey: kp.privateKey, publicKey: kp.publicKey, publicRaw: raw, id: id }; return S.vault.device; });
      });
    });
  }
  function deviceName() {
    var ua = String(navigator.userAgent || '');
    var b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : T('p.browser');
    return T('p.device_portal', { browser: b });
  }
  /** The keys of a Tresor for this browser → 'approved' (keys kept), 'pending', 'none', 'unsupported'. */
  function vaultReady(nb) {
    var v = nb.vault;
    if (S.vault.keys[v.id]) return Promise.resolve('approved');
    return vaultSupported().then(function (ok) {
      if (!ok) return 'unsupported';
      return device().then(function (d) {
        return api('GET', 'vaults/' + v.id + '/keys', null, { deviceId: d.id }).then(function (r) {
          if (r.state !== 'approved') return r.state;
          var m = new Map();
          var chain = Promise.resolve();
          (r.keys || []).forEach(function (k) { chain = chain.then(function () { return VC.unwrapKey(k.wrap, d.privateKey, d.publicRaw, v.id, k.keyVersion).then(function (tk) { m.set(k.keyVersion, tk); }); }); });
          return chain.then(function () {
            S.vault.keys[v.id] = m;
            return VC.decryptName(m, v.id, v.nameCipher).then(function (name) { S.vault.names[v.id] = name; renderNav(); }, function () {}).then(function () { touchVault(); return 'approved'; });
          });
        }, function (e) { if (e && e.code === 'not_found') return 'none'; throw e; });
      });
    });
  }
  var lockTimer = null;
  function touchVault() { clearTimeout(lockTimer); lockTimer = setTimeout(function () { lockAll(); }, 15 * 60000); }
  function lockAll() {
    Object.keys(S.vault.keys).forEach(function (k) { S.vault.keys[k].forEach(function (tk) { try { VC.wipe(tk); } catch (e) { /* not bytes */ } }); });
    S.vault.keys = {};
    S.vault.names = {};
    if (S.detail && S.detail.type === 'note') { S.detail = null; renderSide(); }
    renderNav();
    if (S.view.kind === 'notes') reloadView();
  }
  function lockedCard(nb, state) {
    var box = h('div', { class: 'na-card na-lock' }, [icon('lock', 32), h('b', { text: T('p.vault_locked') })]);
    if (state === 'unsupported') { box.appendChild(h('p', { class: 'dp-hint', text: T('p.vault_unsupported') })); return box; }
    if (state === 'pending') box.appendChild(h('p', { class: 'dp-hint', text: T('p.vault_pending') }));
    else box.appendChild(h('p', { class: 'dp-hint', text: T('p.vault_new_device') }));
    var acts = h('div', { class: 'dp-actions', style: 'justify-content:center' });
    if (state === 'locked') acts.appendChild(btn(T('p.unlock'), function () { vaultReady(nb).then(function () { reloadView(); reloadDetail(); }, fail); }, { primary: true, icon: 'lock' }));
    if (state === 'none' || state === 'revoked') acts.appendChild(btn(T('p.vault_ask'), function () { askAccess(nb); }, { primary: true }));
    acts.appendChild(btn(T('p.vault_recover'), function () { recover(nb); }));
    box.appendChild(acts);
    return box;
  }
  function askAccess(nb) {
    device().then(function (d) {
      return api('POST', 'vaults/' + nb.vault.id + '/devices', { publicKey: VC.b64u(d.publicRaw), name: deviceName(), platform: 'web' }).then(function () { return VC.safetyNumber(d.publicRaw); });
    }).then(function (num) {
      dialog(T('p.vault_asked'), [h('p', { class: 'dp-hint', text: T('p.vault_asked_text') }), h('p', { class: 'dp-safety', text: num }), h('div', { class: 'dp-actions' }, [btn(T('p.close'), function () { closeDialog(); reloadView(); }, { primary: true })])]);
    }, fail);
  }
  function wrapAll(m, pubRaw, vid) {
    var out = [];
    var chain = Promise.resolve();
    m.forEach(function (tk, kv) { chain = chain.then(function () { return VC.wrapKey(tk, pubRaw, vid, kv).then(function (w) { out.push({ keyVersion: kv, wrap: w }); }); }); });
    return chain.then(function () { return out; });
  }
  function recover(nb) {
    var v = nb.vault;
    var input = h('textarea', { class: 'dp-input', rows: '3', attrs: { spellcheck: 'false', autocomplete: 'off', 'aria-label': T('p.recovery_key') } });
    var errBox = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    var goOn = function () {
      errBox.textContent = '';
      var key;
      try { key = VC.parseRecoveryKey(input.value); } catch (e) { errBox.textContent = T('p.recovery_wrong'); return; }
      var rec, auth;
      Promise.all([VC.recoveryKeyPair(key), VC.recoveryAuth(key)]).then(function (x) {
        rec = x[0]; auth = x[1]; VC.wipe(key);
        return api('GET', 'vaults/' + v.id + '/recovery');
      }).then(function (r) {
        if (VC.b64u(rec.publicRaw) !== r.recoveryPub) throw codeErr('recovery_wrong');
        var m = new Map();
        var chain = Promise.resolve();
        (r.keys || []).forEach(function (k) { chain = chain.then(function () { return VC.unwrapKey(k.wrap, rec.privateKey, rec.publicRaw, v.id, k.keyVersion).then(function (tk) { m.set(k.keyVersion, tk); }); }); });
        return chain.then(function () { return m; });
      }).then(function (m) {
        return device().then(function (d) {
          return api('POST', 'vaults/' + v.id + '/devices', { publicKey: VC.b64u(d.publicRaw), name: deviceName(), platform: 'web' })
            .then(function () { return wrapAll(m, d.publicRaw, v.id); })
            .then(function (wraps) { return api('POST', 'vaults/' + v.id + '/devices/' + d.id + '/approve', { wraps: wraps, via: 'recovery', recoveryAuth: auth }); });
        }).then(function () { S.vault.keys[v.id] = m; return VC.decryptName(m, v.id, v.nameCipher).then(function (n) { S.vault.names[v.id] = n; }, function () {}); });
      }).then(function () { closeDialog(); toast(T('p.recovered')); renderNav(); reloadView(); }, function (e) {
        errBox.textContent = e && (e.code === 'recovery_wrong' || e.code === 'decrypt') ? T('p.recovery_wrong') : errText(e);
      });
    };
    dialog(T('p.vault_recover'), [h('p', { class: 'dp-hint', text: T('p.recover_text') }), input, errBox, h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(T('p.unlock'), goOn, { primary: true })])]);
    input.focus();
  }
  function vaultBanner(main, nb) {
    var v = nb.vault;
    var keys = S.vault.keys[v.id];
    if (!keys) return;
    api('GET', 'vaults/' + v.id).then(function (r) {
      var vv = r.vault;
      if (vv.pending > 0) main.insertBefore(h('div', { class: 'dp-note' }, [icon('lock'), h('span', { text: T('p.vault_requests', { n: vv.pending }) }), btn(T('p.review'), function () { review(nb); }, { small: true })]), main.children[1] || null);
      if (vv.needsRotation) main.insertBefore(h('div', { class: 'dp-note is-warn' }, [icon('lock'), h('span', { text: T('p.vault_rotate') }), btn(T('p.rotate'), function () { rotate(nb, vv, false); }, { small: true })]), main.children[1] || null);
    }).catch(function () {});
  }
  function review(nb) {
    var v = nb.vault;
    api('GET', 'vaults/' + v.id + '/devices').then(function (r) {
      var pending = (r.devices || []).filter(function (d) { return d.state === 'pending'; });
      var box = h('div', { class: 'na-tl' });
      var chain = Promise.resolve();
      pending.forEach(function (d) {
        chain = chain.then(function () { return VC.safetyNumber(VC.unb64u(d.publicKey)); }).then(function (num) {
          var who = (S.people.filter(function (p) { return p.id === d.userId; })[0] || {}).name || '';
          var row = h('div', { class: 'na-card', style: 'padding:10px;gap:6px;display:flex;flex-direction:column' }, [h('b', { text: who + (d.name ? ' · ' + d.name : '') }), h('p', { class: 'dp-safety', text: num }),
            h('div', { class: 'dp-actions' }, [
              btn(T('p.decline'), function () { api('DELETE', 'vaults/' + v.id + '/devices/' + d.deviceId).then(function () { row.remove(); }, fail); }, { small: true, danger: true }),
              btn(T('p.approve'), function () {
                wrapAll(S.vault.keys[v.id], VC.unb64u(d.publicKey), v.id).then(function (wraps) { return api('POST', 'vaults/' + v.id + '/devices/' + d.deviceId + '/approve', { wraps: wraps }); })
                  .then(function () { row.remove(); toast(T('p.approved')); }, fail);
              }, { small: true, primary: true })])]);
          box.appendChild(row);
        });
      });
      chain.then(function () { dialog(T('p.review_title'), [h('p', { class: 'dp-hint', text: T('p.review_text') }), box]); });
    }, fail);
  }
  function showRecovery(text, onKept) {
    return new Promise(function (resolve, reject) {
      var kept = h('input', { type: 'checkbox' });
      var errBox = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var goBtn = btn(T('p.recovery_done'), function () {
        goBtn.disabled = true;
        Promise.resolve(onKept()).then(function (x) { closeDialog(); resolve(x); }, function (e) { goBtn.disabled = false; errBox.textContent = errText(e); });
      }, { primary: true, disabled: true });
      kept.addEventListener('change', function () { goBtn.disabled = !kept.checked; });
      var save = function () {
        if (window.GC && window.GC.saveFile) window.GC.saveFile(new Blob([T('p.recovery_file', { key: text }) + '\n'], { type: 'text/plain' }), T('p.recovery_filename')).catch(function () {});
      };
      dialog(T('p.recovery_title'), [h('p', { class: 'dp-hint', text: T('p.recovery_text') }), h('p', { class: 'dp-recovery', text: text }),
        h('div', { class: 'dp-actions' }, [btn(T('p.save_file'), save, {})]), h('label', { class: 'dp-check' }, [kept, h('span', { text: T('p.recovery_kept') })]), errBox,
        h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), function () { closeDialog(); reject(codeErr('cancelled')); }), goBtn])], { wide: true });
    });
  }
  function makeVault(name) {
    vaultSupported().then(function (ok) {
      if (!ok) { dialog(T('p.vault_unsupported_title'), [h('p', { class: 'dp-hint', text: T('p.vault_unsupported') })]); return null; }
      return device().then(function (d) {
        var id = VC.newVaultId();
        var tk = VC.newVaultKey();
        var rec = VC.newRecoveryKey();
        return VC.recoveryKeyPair(rec.key).then(function (kp) {
          return Promise.all([VC.encryptName(tk, id, 1, name), VC.wrapKey(tk, kp.publicRaw, id, 1), VC.wrapKey(tk, d.publicRaw, id, 1), VC.recoveryAuth(rec.key)]).then(function (x) {
            var body = { id: id, area: S.area, nameCipher: x[0], recoveryPub: VC.b64u(kp.publicRaw), recoveryAuth: x[3], recoveryWrap: x[1], device: { publicKey: VC.b64u(d.publicRaw), name: deviceName(), platform: 'web' }, wrap: x[2] };
            return showRecovery(rec.text, function () {
              return api('POST', 'vaults', body).then(function (r) {
                S.vault.keys[id] = new Map([[1, tk]]);
                S.vault.names[id] = name;
                touchVault();
                toast(T('p.vault_made', { name: name }));
                return reloadNav().then(function () { go({ kind: 'notes', notebook: r.notebook.id }); });
              });
            });
          });
        });
      });
    }).catch(function (e) { if (e && e.code !== 'cancelled') fail(e); });
  }
  function rotate(nb, vv, newRecovery) {
    var v = nb.vault;
    var m = S.vault.keys[v.id];
    if (!m) return;
    var next = vv.keyVersion + 1;
    var tk = VC.newVaultKey();
    var rec = newRecovery ? VC.newRecoveryKey() : null;
    api('GET', 'vaults/' + v.id + '/devices').then(function (r) {
      var wraps = [];
      var chain = Promise.resolve();
      (r.devices || []).filter(function (d) { return d.state === 'approved'; }).forEach(function (d) { chain = chain.then(function () { return VC.wrapKey(tk, VC.unb64u(d.publicKey), v.id, next).then(function (w) { wraps.push({ deviceId: d.deviceId, wrap: w }); }); }); });
      return chain.then(function () {
        if (!rec) return VC.wrapKey(tk, VC.unb64u(vv.recoveryPub), v.id, next).then(function (w) { return { keyVersion: next, wraps: wraps, recoveryWrap: w }; });
        return Promise.all([VC.recoveryKeyPair(rec.key), VC.recoveryAuth(rec.key)]).then(function (x) {
          var all = new Map(m); all.set(next, tk);
          return wrapAll(all, x[0].publicRaw, v.id).then(function (rw) { return { keyVersion: next, wraps: wraps, recovery: { pub: VC.b64u(x[0].publicRaw), auth: x[1], wraps: rw } }; });
        });
      });
    }).then(function (body) {
      var send = function () { return api('POST', 'vaults/' + v.id + '/rotate', body).then(function () { m.set(next, tk); toast(T('p.rotated')); reloadNav(); reloadView(); }); };
      return rec ? showRecovery(rec.text, send) : send();
    }).catch(function (e) {
      if (e && e.code === 'conflict' && e.extra && e.extra.reason === 'recovery_required') return rotate(nb, vv, true);
      if (e && e.code !== 'cancelled') fail(e);
    });
  }
  function currentKey(nb) { var m = S.vault.keys[nb.vault.id]; var kv = 0; m.forEach(function (_, k) { if (k > kv) kv = k; }); return { kv: kv, tk: m.get(kv) }; }
  function concatParts(parts) { var n = 0; parts.forEach(function (p) { n += p.length; }); var out = new Uint8Array(n); var o = 0; parts.forEach(function (p) { out.set(p, o); o += p.length; }); return out; }
  function encryptNote(nb, title, body) {
    var k = currentKey(nb);
    return Promise.all([VC.encryptName(k.tk, nb.vault.id, k.kv, String(title || T('p.untitled')).slice(0, 300)), VC.encryptContent(k.tk, nb.vault.id, k.kv, new TextEncoder().encode(body || ''))]).then(function (x) {
      return { titleCipher: x[0], cipher: VC.b64u(concatParts(x[1])), keyVersion: k.kv };
    });
  }
  function saveVaultNote(nb, n, title, body) {
    return encryptNote(nb, title, body).then(function (enc) { S.vault.names['n' + n.id] = title || T('p.untitled'); return api('PATCH', 'notes/' + n.id, enc); });
  }
  function decryptNote(nb, n) {
    var m = S.vault.keys[nb.vault.id];
    touchVault();
    var bytes = n.cipher ? VC.unb64u(n.cipher) : null;
    return Promise.all([VC.decryptName(m, nb.vault.id, n.titleCipher), bytes ? VC.decryptContent(m, nb.vault.id, function (a, b) { return Promise.resolve(bytes.subarray(a, b + 1)); }, bytes.length) : Promise.resolve([])]).then(function (x) {
      S.vault.names['n' + n.id] = x[0];
      return { title: x[0], body: new TextDecoder().decode(concatParts(x[1])) };
    });
  }
  function decryptTitles(nb, list) {
    var m = S.vault.keys[nb.vault.id];
    if (!m) return Promise.resolve();
    return Promise.all(list.map(function (n) { return n.titleCipher ? VC.decryptName(m, nb.vault.id, n.titleCipher).then(function (t) { S.vault.names['n' + n.id] = t; }, function () {}) : null; }));
  }
  function encryptFile(nb, bytes, name) {
    var k = currentKey(nb);
    return Promise.all([VC.encryptContent(k.tk, nb.vault.id, k.kv, bytes), VC.encryptName(k.tk, nb.vault.id, k.kv, name)]).then(function (x) { return { parts: x[0], nameCipher: x[1] }; });
  }
  function showVaultAttachment(nb, a, el) {
    var m = S.vault.keys[nb.vault.id];
    if (a.nameCipher) VC.decryptName(m, nb.vault.id, a.nameCipher).then(function (name) { S.vault.names['a' + a.id] = name; if (el.tagName === 'A') el.textContent = name; }, function () {});
    if (!a.url || !window.GC.mediaBytes || a.bytes > 16 * 1048576) return;
    el.addEventListener('click', function (ev) {
      ev.preventDefault();
      window.GC.mediaBytes(a.url, {}).then(function (r) {
        var b = new Uint8Array(r.data);
        return VC.decryptContent(m, nb.vault.id, function (x, y) { return Promise.resolve(b.subarray(x, y + 1)); }, b.length);
      }).then(function (parts) {
        var name = S.vault.names['a' + a.id] || 'datei';
        var type = /\.pdf$/i.test(name) ? 'application/pdf' : /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'text/plain';
        return window.GC.saveFile(new Blob(parts, { type: type }), name);
      }).catch(fail);
    });
  }

  // ── „Einstellungen“ (1.2.0, instead of „Quellen“ and „Umziehen“): the gear at the bottom left ──

  function savePrefs(body) {
    return api('PUT', 'prefs', body).then(function (r) {
      S.me.prefs = r.prefs;
      if (S.me.calendar && r.prefs.calendar) S.me.calendar.mine = r.prefs.calendar.tasks !== false;
      reloadNav();
      return r;
    }, fail);
  }
  function swRow(label, hint, on, onChange) {
    var sw = h('input', { type: 'checkbox', class: 'dp-sw', checked: !!on, attrs: { 'aria-label': label } });
    sw.addEventListener('change', function () { onChange(sw.checked); });
    return h('div', { class: 'na-set-row' }, [h('span', { class: 't' }, [h('span', { text: label }), hint ? h('small', { text: hint }) : null]), sw]);
  }
  function setRow(label, hint, ctl) { return h('div', { class: 'na-set-row' }, [h('span', { class: 't' }, [h('span', { text: label }), hint ? h('small', { text: hint }) : null]), ctl]); }

  function renderSettings(main) {
    main.appendChild(header(T('p.settings'), T('p.settings_sub'), []));
    var wrap = h('div', { class: 'na-set' });
    var prefs = S.me.prefs || { sources: {}, groups: {}, times: {}, myday: {}, notify: {} };
    // Aufgaben aus anderen Plugins (until 1.1: „Quellen“)
    wrap.appendChild(h('h3', { text: T('p.sources_title') }));
    wrap.appendChild(h('p', { class: 'dp-hint', text: T('p.sources_intro') }));
    sourceCards(wrap, prefs);
    // Mein Tag
    wrap.appendChild(h('h3', { text: T('v.myday') }));
    var md = prefs.myday || {};
    var start = h('select', { class: 'dp-input na-sel', attrs: { 'aria-label': T('p.start_area') } }, [h('option', { value: 'last', text: T('p.start_last') }), h('option', { value: 'private', text: T('area.private') }), h('option', { value: 'work', text: T('area.work') })]);
    start.value = prefs.startArea || 'last';
    start.addEventListener('change', function () { savePrefs({ startArea: start.value }); });
    wrap.appendChild(h('div', { class: 'na-card' }, h('div', { class: 'na-tl' }, [
      swRow(T('p.set_listdays'), T('p.set_listdays_hint'), md.listdays !== false, function (v) { savePrefs({ myday: { listdays: v } }); }),
      swRow(T('p.set_show_done'), null, md.showDone !== false, function (v) { savePrefs({ myday: { showDone: v } }); }),
      setRow(T('p.start_area'), null, start),
    ])));
    // Uhrzeiten der Schnell-Eingabe
    wrap.appendChild(h('h3', { text: T('p.times_title') }));
    var times = h('div', { class: 'na-tl' });
    var DEF = { morning: '09:00', noon: '12:00', afternoon: '15:00', evening: '19:00', night: '21:00' };
    ['morning', 'noon', 'afternoon', 'evening', 'night'].forEach(function (k) {
      var tm = h('input', { type: 'time', class: 'dp-input na-time', value: (prefs.times || {})[k] || DEF[k], attrs: { 'aria-label': T('p.time_' + k) } });
      tm.addEventListener('change', function () { if (tm.value) { var o = {}; o[k] = tm.value; savePrefs({ times: o }).then(function (r) { if (r) S.me.prefs = r.prefs; }); } });
      times.appendChild(setRow(T('p.time_' + k), null, tm));
    });
    wrap.appendChild(h('div', { class: 'na-card' }, [h('p', { class: 'dp-hint', text: T('p.times_hint') }), times]));
    // Benachrichtigungen
    wrap.appendChild(h('h3', { text: T('p.notify_title') }));
    var nt = prefs.notify || {};
    var yAt = h('input', { type: 'time', class: 'dp-input na-time', value: prefs.yesterdayAt || '07:30', attrs: { 'aria-label': T('p.yesterday_at') } });
    yAt.addEventListener('change', function () { if (yAt.value) savePrefs({ yesterdayAt: yAt.value }); });
    wrap.appendChild(h('div', { class: 'na-card' }, [h('div', { class: 'na-tl' }, [
      swRow(T('p.notify_reminders'), null, nt.reminders !== false, function (v) { savePrefs({ notify: { reminders: v } }); }),
      swRow(T('p.notify_shared'), null, nt.shared !== false, function (v) { savePrefs({ notify: { shared: v } }); }),
      swRow(T('p.notify_listday'), T('p.notify_listday_hint'), nt.listday !== false, function (v) { savePrefs({ notify: { listday: v } }); }),
      swRow(T('p.notify_yesterday'), T('p.notify_yesterday_hint'), nt.yesterday !== false, function (v) { savePrefs({ notify: { yesterday: v } }); }),
      setRow(T('p.yesterday_at'), null, yAt),
    ]), h('p', { class: 'dp-hint', text: T('p.notify_hint') })]));
    // 1.5.0: Orte — the person's switches of the place search and of the hints on the way, „Meine Orte“
    if (S.me.places) PL.settings(wrap, savePrefs);
    // 1.3.0: Kalender — only while Mail offers it and the administrator has it on
    var cal = S.me.calendar;
    if (cal && cal.available && cal.enabled) {
      wrap.appendChild(h('h3', { text: T('p.calendar') }));
      wrap.appendChild(h('div', { class: 'na-card' }, [h('div', { class: 'na-tl' }, [
        swRow(T('p.cal_mine', { name: cal.name }), T('p.cal_mine_hint'), cal.mine !== false, function (v) { savePrefs({ calendar: { tasks: v } }); }),
      ])]));
    }
    // Umziehen
    if (S.me.imports && (S.me.imports.mstodo || S.me.imports.dsnote)) {
      wrap.appendChild(h('h3', { text: T('p.import') }));
      wrap.appendChild(h('p', { class: 'dp-hint', text: T('p.import_intro') }));
      if (S.me.imports.mstodo) wrap.appendChild(mstodoCard());
      if (S.me.imports.dsnote) wrap.appendChild(dsnoteCard());
    }
    wrap.appendChild(h('p', { class: 'dp-hint', text: T('p.settings_admin') }));
    main.appendChild(wrap);
  }

  function sourceCards(wrap, prefs) {
    var save = function (body) { return savePrefs(body); };
    (S.data && S.data.sources || []).forEach(function (s) {
      var sp = prefs.sources[s.plugin] || {};
      var on = h('input', { type: 'checkbox', class: 'dp-sw', checked: sp.on !== false && s.enabled, disabled: !s.enabled || !s.available, attrs: { 'aria-label': s.label } });
      on.addEventListener('change', function () { var o = {}; o[s.plugin] = { on: on.checked }; save({ sources: o }); });
      var card = h('div', { class: 'na-card' }, [h('div', { class: 'na-set-h' }, [h('span', { class: 'na-badge', 'data-src': s.plugin, text: s.label.slice(0, 2) }), h('div', null, [h('b', { text: s.label }),
        h('span', { text: !s.enabled ? T('p.src_off_admin') : !s.available ? T('p.src_missing') : s.hint })]), on])]);
      var opt = function (label, ctl) { card.appendChild(field(label, ctl)); };
      var sel = function (key, values, cur) {
        var x = h('select', { class: 'dp-input' });
        values.forEach(function (v) { x.appendChild(h('option', { value: v[0], text: v[1] })); });
        x.value = cur;
        x.addEventListener('change', function () { var o = {}; o[s.plugin] = {}; o[s.plugin][key] = x.value === 'true' ? true : x.value === 'false' ? false : x.value; save({ sources: o }); });
        return x;
      };
      if (s.plugin === 'gatecontrol-familie') {
        opt(T('p.src_kids'), sel('kids', [['all', T('p.kids_all')], ['mine', T('p.kids_mine')], ['none', T('p.kids_none')]], sp.kids || 'all'));
        opt(T('p.src_shopping'), sel('shoppingInMyDay', [['false', T('p.no')], ['true', T('p.yes')]], String(!!sp.shoppingInMyDay)));
      }
      if (s.plugin === 'gatecontrol-mail') opt(T('p.src_flagged'), sel('flagged', [['true', T('p.yes')], ['false', T('p.no')]], String(sp.flagged !== false)));
      if (s.plugin === 'gatecontrol-alltag') {
        var tm = h('input', { type: 'time', class: 'dp-input', value: sp.evening || prefs.evening || '18:00' });
        tm.addEventListener('change', function () { if (tm.value) { var o = {}; o[s.plugin] = { evening: tm.value }; save({ sources: o }); } });
        opt(T('p.src_evening'), tm);
      }
      (s.groups || []).forEach(function (g) {
        var k = s.plugin + '|' + g.id;
        var x = h('select', { class: 'dp-input' }, [h('option', { value: '', text: T('p.group_as_sent') }), h('option', { value: 'private', text: T('area.private') }), h('option', { value: 'work', text: T('area.work') }), h('option', { value: 'hide', text: T('p.hide') })]);
        x.value = (prefs.groups || {})[k] || '';
        x.addEventListener('change', function () { var o = {}; o[k] = x.value || null; save({ groups: o }); });
        opt(g.label + ' (' + g.count + ')', x);
      });
      if (s.available && s.enabled) card.appendChild(h('div', { class: 'na-d-foot' }, [h('span', { text: s.lastSync ? T('p.last_sync', { when: new Date(s.lastSync).toLocaleString(S.me.lang) }) : T('p.never_synced') }),
        btn(T('p.sync_now'), function () { api('POST', 'sources/' + s.plugin + '/sync').then(function (r) { toast(r.scheduled ? T('p.sync_soon') : T('p.sync_recent')); }, fail); }, { small: true })]));
      wrap.appendChild(card);
    });
  }

  function mstodoCard() {
    var card = h('div', { class: 'na-card' }, [h('div', { class: 'na-set-h' }, [h('span', { class: 'na-badge', text: 'To Do' }), h('div', null, [h('b', { text: 'Microsoft To Do' }), h('span', { text: T('p.mstodo_hint') })])])]);
    var body = h('div', { class: 'na-tl' }, h('p', { class: 'dp-muted', text: T('p.loading') }));
    card.appendChild(body);
    api('GET', 'import/mstodo/accounts').then(function (r) {
      clear(body);
      if (!r.available) { body.appendChild(h('p', { class: 'dp-hint', text: T(r.reason === 'mail_missing' ? 'p.mstodo_no_mail' : r.reason === 'off' ? 'p.mstodo_off' : 'p.mstodo_unavailable') })); return; }
      if (!r.accounts.length) { body.appendChild(h('p', { class: 'dp-hint', text: T('p.mstodo_no_account') })); return; }
      var acc = h('select', { class: 'dp-input' });
      r.accounts.forEach(function (a) { acc.appendChild(h('option', { value: String(a.id), text: a.email })); });
      body.appendChild(field(T('p.account'), acc));
      var area = h('div');
      body.appendChild(area);
      var step = function () {
        clear(area);
        var a = r.accounts.filter(function (x) { return String(x.id) === acc.value; })[0];
        if (!a.tasks) { area.appendChild(h('p', { class: 'dp-hint', text: T('p.mstodo_consent_hint') })); area.appendChild(btn(T('p.mstodo_consent'), function () { consent(a, step); }, { primary: true })); return; }
        area.appendChild(h('p', { class: 'dp-muted', text: T('p.loading') }));
        api('GET', 'import/mstodo/preview', null, { accountId: a.id }).then(function (pv) { clear(area); mstodoPreview(area, a, pv); }, function (e) {
          clear(area);
          if (e.code === 'consent_required') { a.tasks = false; step(); return; }
          area.appendChild(h('p', { class: 'dp-err', text: errText(e) }));
        });
      };
      acc.addEventListener('change', step);
      step();
      api('GET', 'import/mstodo/links').then(function (l) {
        if (!(l.links || []).some(function (x) { return x.twoWay; })) return;
        card.appendChild(h('div', { class: 'na-lb', text: T('p.mstodo_links') }));
        l.links.filter(function (x) { return x.twoWay; }).forEach(function (x) {
          card.appendChild(field(x.listName + (x.error ? ' · ' + T('p.sync_error') : ''), btn(T('p.mstodo_unlink'), function () { api('DELETE', 'import/mstodo/links/' + x.id).then(function () { toast(T('p.mstodo_unlinked')); go({ kind: 'settings' }); }, fail); }, { small: true })));
        });
      }).catch(function () {});
    }, function (e) { clear(body); body.appendChild(h('p', { class: 'dp-err', text: errText(e) })); });
    return card;
  }
  function consent(a, after) {
    api('POST', 'import/mstodo/consent', { accountId: a.id }).then(function (r) {
      var stop = false;
      dialog(T('p.mstodo_consent'), [h('p', { class: 'dp-hint', text: T('p.mstodo_code_text', { url: r.verificationUri }) }), h('p', { class: 'dp-safety', text: r.userCode }),
        h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), function () { stop = true; closeDialog(); })])]);
      var poll = function () {
        if (stop) return;
        api('POST', 'import/mstodo/consent', { accountId: a.id, deviceId: r.deviceId }).then(function (p) {
          if (p.status === 'done') { closeDialog(); a.tasks = true; toast(T('p.mstodo_consented')); after(); return; }
          if (p.status === 'pending') { setTimeout(poll, Math.max(5, r.interval || 5) * 1000); return; }
          closeDialog(); toast(T('p.mstodo_consent_failed'), 'error');
        }, function (e) { closeDialog(); fail(e); });
      };
      setTimeout(poll, Math.max(5, r.interval || 5) * 1000);
    }, fail);
  }
  function mstodoPreview(area, a, pv) {
    var t = pv.totals || {};
    area.appendChild(h('div', { class: 'na-stats' }, [h('div', null, [h('b', { text: String(t.lists || 0) }), h('span', { text: T('p.lists') })]), h('div', null, [h('b', { text: String(t.open || 0) }), h('span', { text: T('p.open_tasks') })]), h('div', null, [h('b', { text: String(t.attachments || 0) }), h('span', { text: T('p.with_attachment') })])]));
    var rows = [];
    var tl = h('div', { class: 'na-tl' });
    pv.lists.forEach(function (l) {
      var inc = h('input', { type: 'checkbox', checked: l.include });
      var ar = h('select', { class: 'dp-input' }, [h('option', { value: 'private', text: T('area.private') }), h('option', { value: 'work', text: T('area.work') })]);
      ar.value = l.area;
      rows.push({ l: l, inc: inc, ar: ar });
      tl.appendChild(h('label', null, [inc, h('span', { text: l.name + ' (' + l.open + ')' }), ar]));
    });
    area.appendChild(tl);
    var done = h('select', { class: 'dp-input' }, [[0, T('p.done_none')], [30, T('p.done_30')], [90, T('p.done_90')], [365, T('p.done_365')], [-1, T('p.done_all')]].map(function (o) { return h('option', { value: String(o[0]), text: o[1] }); }));
    done.value = '90';
    area.appendChild(field(T('p.take_done'), done));
    var two = h('input', { type: 'checkbox', class: 'dp-sw', disabled: !S.me.imports.mstodoSync });
    area.appendChild(field(T('p.two_way'), two));
    area.appendChild(h('p', { class: 'dp-hint', text: T('p.two_way_hint') }));
    var bar = h('div', { class: 'na-bar', hidden: true }, h('i'));
    var status = h('p', { class: 'dp-hint' });
    var start = btn(T('p.take_n', { n: t.open || 0 }), function () {
      start.disabled = true;
      api('POST', 'import/mstodo/start', { accountId: a.id, lists: rows.map(function (r) { return { id: r.l.id, name: r.l.name, area: r.ar.value, include: r.inc.checked }; }), doneDays: Number(done.value), twoWay: two.checked }).then(function (r) {
        bar.hidden = false;
        var total = rows.filter(function (r) { return r.inc.checked; }).reduce(function (n, r) { return n + r.l.open; }, 0) || 1;
        var poll = function () {
          api('GET', 'import/jobs/' + r.job.id).then(function (j) {
            var st = j.job.stats || {};
            bar.firstChild.style.width = Math.min(100, Math.round(100 * (st.tasks || 0) / total)) + '%';
            status.textContent = T('p.job_stats', { tasks: st.tasks || 0, lists: st.lists || 0, attachments: st.attachments || 0 });
            if (j.job.state === 'running') setTimeout(poll, 4000);
            else if (j.job.state === 'done') { toast(T('p.import_done')); reloadNav(); }
            else status.textContent = T('p.import_failed', { code: j.job.error || '' });
          }, fail);
        };
        poll();
      }, function (e) { start.disabled = false; fail(e); });
    }, { primary: true });
    area.appendChild(bar);
    area.appendChild(status);
    area.appendChild(start);
  }

  function dsnoteCard() {
    var card = h('div', { class: 'na-card' }, [h('div', { class: 'na-set-h' }, [h('span', { class: 'na-badge', text: 'DS' }), h('div', null, [h('b', { text: 'Synology DS Note' }), h('span', { text: T('p.dsnote_hint') })])])]);
    var area = h('div', { class: 'na-tl' });
    card.appendChild(btn(T('p.dsnote_pick'), function () {
      var f = document.getElementById('na-nsx');
      f.value = '';
      f.onchange = function () { if (f.files && f.files[0]) readNsx(f.files[0], area); };
      f.click();
    }, { icon: 'note' }));
    card.appendChild(h('p', { class: 'dp-hint', text: T('p.dsnote_nas') }));
    card.appendChild(area);
    return card;
  }
  function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') return Promise.reject(codeErr('unsupported'));
    var ds = new DecompressionStream('deflate-raw');
    return new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  function readNsx(file, area) {
    clear(area);
    area.appendChild(h('p', { class: 'dp-muted', text: T('p.dsnote_reading') }));
    var read = function (a, b) { return file.slice(a, b).arrayBuffer().then(function (x) { return new Uint8Array(x); }); };
    NSX.open(read, file.size, { inflateRaw: inflateRaw }).then(function (arc) {
      return NSX.summary(arc).then(function (sum) {
        clear(area);
        area.appendChild(h('b', { text: T('p.dsnote_found', { file: file.name }) }));
        area.appendChild(h('div', { class: 'na-stats' }, [h('div', null, [h('b', { text: String(sum.notebooks.length) }), h('span', { text: T('p.notebooks') })]), h('div', null, [h('b', { text: String(sum.notes) }), h('span', { text: T('p.notes') })]),
          h('div', null, [h('b', { text: (sum.bytes / 1073741824 >= 1 ? (sum.bytes / 1073741824).toFixed(1).replace('.', ',') + ' GB' : Math.round(sum.bytes / 1048576) + ' MB') }), h('span', { text: T('p.images_files') })])]));
        var pw = h('input', { type: 'password', class: 'dp-input', attrs: { autocomplete: 'off', 'aria-label': T('p.dsnote_password') } });
        if (sum.protectedNotes) {
          area.appendChild(h('p', { class: 'dp-hint', text: T('p.dsnote_protected', { n: sum.protectedNotes }) }));
          area.appendChild(field(T('p.dsnote_password'), pw));
        }
        area.appendChild(h('p', { class: 'dp-hint', text: T('p.dsnote_where') }));
        var bar = h('div', { class: 'na-bar', hidden: true }, h('i'));
        var status = h('p', { class: 'dp-hint' });
        var go2 = btn(T('p.take_notes_n', { n: sum.notes }), function () { go2.disabled = true; bar.hidden = false; importNsx(arc, sum, pw.value, file.name, bar, status).then(function () { go2.disabled = false; }); }, { primary: true });
        area.appendChild(bar); area.appendChild(status); area.appendChild(go2);
      });
    }).catch(function (e) { clear(area); area.appendChild(h('p', { class: 'dp-err', text: e && e.code === 'unsupported' ? T('err.unsupported') : T('p.dsnote_bad') })); });
  }
  function importNsx(arc, sum, password, fileName, bar, status) {
    var stats = { notes: 0, skipped: 0, prot: 0 };
    var job;
    var done = 0;
    var progress = function () { bar.firstChild.style.width = Math.round(100 * done / Math.max(1, sum.notes)) + '%'; status.textContent = T('p.dsnote_progress', { done: done, total: sum.notes }); };
    return api('POST', 'import/dsnote/start', { file: fileName, notebooks: sum.notebooks.length, notes: sum.notes, bytes: sum.bytes }).then(function (r) {
      job = r.job.id;
      var chain = Promise.resolve();
      sum.notebooks.forEach(function (nb) {
        chain = chain.then(function () { return importBook(arc, sum, nb, password, job, stats, function () { done++; progress(); }); });
      });
      return chain;
    }).then(function () {
      return api('POST', 'import/dsnote/' + job + '/finish', { skipped: stats.skipped, protectedSkipped: stats.prot });
    }).then(function () {
      status.textContent = T('p.dsnote_done', { notes: stats.notes, skipped: stats.skipped + stats.prot }) + (stats.prot ? ' ' + T('p.dsnote_prot_skipped', { n: stats.prot }) : '');
      reloadNav();
    }, function (e) { status.textContent = errText(e); });
  }
  function importBook(arc, sum, nb, password, job, stats, tick) {
    var ids = [];
    var noteRows = [];
    var chain = Promise.resolve();
    sum.noteIds.forEach(function (id) { chain = chain.then(function () { return NSX.note(arc, id).then(function (n) { if ((n.notebookId || '_') === nb.id) noteRows.push(n); }); }); });
    return chain.then(function () {
      if (!noteRows.length) return null;
      var prot = noteRows.some(function (n) { return n.encrypted; });
      var plain = noteRows.filter(function (n) { return !n.encrypted; });
      var p = Promise.resolve();
      var ref = String(nb.id).replace(/[^A-Za-z0-9:._-]/g, '').slice(0, 90) || 'nb';
      if (plain.length) {
        p = p.then(function () { return api('POST', 'import/dsnote/' + job + '/notebook', { ref: ref, name: nb.title, area: S.area }); }).then(function (r) { return sendNotes(arc, r.notebookId, plain, null, job, stats, tick); });
      }
      if (prot) {
        var enc = noteRows.filter(function (n) { return n.encrypted; });
        p = p.then(function () {
          if (!password || !VC) { stats.prot += enc.length; enc.forEach(tick); return null; }
          // try the password on the first note: a Tresor notebook only if it opens
          return NSX.decrypt(enc[0].html, password).then(function () { return vaultForImport(nb.title + ' (DS Note)'); }).then(function (vnb) {
            return sendNotes(arc, vnb.id, enc, { nb: vnb, password: password }, job, stats, tick);
          }, function () { stats.prot += enc.length; enc.forEach(tick); });
        });
      }
      return p;
    });
  }
  function vaultForImport(name) {
    return new Promise(function (resolve, reject) {
      device().then(function (d) {
        var id = VC.newVaultId();
        var tk = VC.newVaultKey();
        var rec = VC.newRecoveryKey();
        return VC.recoveryKeyPair(rec.key).then(function (kp) {
          return Promise.all([VC.encryptName(tk, id, 1, name), VC.wrapKey(tk, kp.publicRaw, id, 1), VC.wrapKey(tk, d.publicRaw, id, 1), VC.recoveryAuth(rec.key)]).then(function (x) {
            var body = { id: id, area: S.area, nameCipher: x[0], recoveryPub: VC.b64u(kp.publicRaw), recoveryAuth: x[3], recoveryWrap: x[1], device: { publicKey: VC.b64u(d.publicRaw), name: deviceName(), platform: 'web' }, wrap: x[2] };
            return showRecovery(rec.text, function () {
              return api('POST', 'vaults', body).then(function (r) {
                S.vault.keys[id] = new Map([[1, tk]]);
                S.vault.names[id] = name;
                return reloadNav().then(function () { resolve(notebookOf(r.notebook.id) || { id: r.notebook.id, vault: { id: id, keyVersion: 1 } }); });
              });
            });
          });
        });
      }).catch(reject);
    });
  }
  function sendNotes(arc, notebookId, list, vaultInfo, job, stats, tick) {
    var i = 0;
    function next() {
      if (i >= list.length) return Promise.resolve();
      var batch = list.slice(i, i + 10);
      i += 10;
      var payload = [];
      var chain = Promise.resolve();
      batch.forEach(function (n) {
        chain = chain.then(function () {
          var att = [];
          var byRef = {};
          var c2 = Promise.resolve();
          n.attachments.forEach(function (a, k) {
            if (!a.entry || a.size > S.me.attachMB * 1048576) return;
            c2 = c2.then(function () { return arc.bytes(a.entry); }).then(function (bytes) {
              if (vaultInfo) return encryptFile(vaultInfo.nb, bytes, a.name).then(function (e) { return window.GC.upload(new Blob(e.parts, { type: 'application/octet-stream' })).then(function (u) { att.push({ n: k, mediaId: u.mediaId, nameCipher: e.nameCipher }); }); });
              return window.GC.upload(new Blob([bytes], { type: a.mime })).then(function (u) { att.push({ n: k, mediaId: u.mediaId, name: a.name }); if (a.ref) byRef[a.ref] = k; });
            }).catch(function () { stats.skipped++; });
          });
          return c2.then(function () {
            var html = n.html;
            var content = vaultInfo ? NSX.decrypt(html, vaultInfo.password) : Promise.resolve(html);
            return content.then(function (h2) {
              var md = NSX.toMarkdown(h2, { image: function (ref) { return byRef[ref] != null ? 'attnew:' + byRef[ref] : null; } });
              var refId = String(n.id).replace(/[^A-Za-z0-9:._-]/g, '').slice(0, 90);
              if (!vaultInfo) { payload.push({ ref: refId, title: n.title, body: md, tags: n.tags, created: n.created, updated: n.updated, attachments: att }); return null; }
              return encryptNote(vaultInfo.nb, n.title, md + (n.tags.length ? '\n\n' + n.tags.map(function (t) { return '#' + t.replace(/\s+/g, '-'); }).join(' ') : '')).then(function (e) {
                payload.push({ ref: refId, titleCipher: e.titleCipher, cipher: e.cipher, keyVersion: e.keyVersion, created: n.created, updated: n.updated, attachments: att });
              });
            }, function () { stats.prot++; });
          });
        }).then(function () { tick(); });
      });
      return chain.then(function () {
        if (!payload.length) return null;
        return api('POST', 'import/dsnote/' + job + '/notes', { notebookId: notebookId, notes: payload }).then(function (r) { stats.notes += r.imported; stats.skipped += r.skipped; });
      }).then(next);
    }
    return next();
  }

  // ── start ────────────────────────────────────────────────

  document.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'n' || ev.key === 'N')) {
      var q = document.getElementById('na-quick');
      if (q) { ev.preventDefault(); q.focus(); }
    }
    if (ev.key === 'Escape' && !document.getElementById('na-pop').hidden) { closePop(); return; }
    if (ev.key === 'Escape' && !document.getElementById('na-dialog').hidden) closeDialog();
  });
  // a click outside the small menu closes it
  document.addEventListener('click', function (ev) {
    var pop = document.getElementById('na-pop');
    if (pop.hidden || inside(ev.target, pop) || (S.popAnchor && inside(ev.target, S.popAnchor))) return;
    closePop();
  });
  (function () {
    var tg = document.getElementById('na-navtoggle');
    tg.appendChild(icon('menu', 20));
    tg.addEventListener('click', toggleNav);
  }());
  if (window.GC && typeof window.GC.on === 'function') {
    window.GC.on('event', function (ev) {
      if (!ev || ev.plugin !== 'gatecontrol-notizen') return;
      if (ev.type === 'changed') soon();
      if (ev.type === 'vault' && ev.data && ev.data.event === 'approved') soon();
    });
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden) { /* keep */ } });
  window.addEventListener('pagehide', lockAll);
  PL.init({ h: h, T: T, icon: icon, btn: btn, ib: ib, clear: clear, api: api, fail: fail, toast: toast, dialog: dialog, closeDialog: closeDialog, state: function () { return S; }, rerender: function () { renderMain(); } });
  app().setAttribute('data-pane', 'list');
  load();
}());
