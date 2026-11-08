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
  var SOURCES = ['gatecontrol-familie', 'gatecontrol-mail', 'gatecontrol-drive', 'gatecontrol-schule', 'gatecontrol-alltag'];
  var COLORS = ['none', 'yellow', 'green', 'blue', 'pink', 'grey', 'orange', 'purple'];
  var COLOR_HEX = { none: 'transparent', yellow: '#fde68a', green: '#bbf7d0', blue: '#bfdbfe', pink: '#fbcfe8', grey: '#e5e7eb', orange: '#fed7aa', purple: '#ddd6fe' };

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
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
    list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
    plus: 'M12 5v14M5 12h14',
    check: 'M5 12l5 5L20 7',
    note: 'M6 3h9l4 4v14H6zM14 3v5h5',
    lock: 'M6 11h12v10H6zM8 11V8a4 4 0 0 1 8 0v3',
    tag: 'M3 12V4h8l10 10-8 8zM7.5 8.5h.01',
    pin: 'M9 3h6l-1 6 4 4H6l4-4zM12 13v8',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    back: 'M15 18l-6-6 6-6',
    open: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
    gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
    move: 'M4 12h16M14 6l6 6-6 6',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
    clip: 'M21 12l-8.5 8.5a5 5 0 0 1-7-7L14 5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 8',
    edit: 'M4 20h4L20 8l-4-4L4 16zM14 6l4 4',
    x: 'M6 6l12 12M18 6L6 18',
  };
  function icon(name, size) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size || 18));
    s.setAttribute('height', String(size || 18));
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
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
    return h('button', { type: 'button', class: 'dp-btn' + (o.primary ? ' dp-btn-primary' : '') + (o.danger ? ' dp-btn-danger' : '') + (o.small ? ' dp-btn-sm' : ''), disabled: o.disabled, on: { click: fn } },
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
    var p = date.split('-');
    return WD(RP.weekday(date)) + ' ' + Number(p[2]) + '. ' + MO(Number(p[1])) + (p[0] !== today.slice(0, 4) ? ' ' + p[0] : '');
  }
  function longDate(date) {
    var p = date.split('-');
    return T('wdl.' + RP.weekday(date)) + ', ' + Number(p[2]) + '. ' + T('mol.' + Number(p[1]));
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
  };
  var app = function () { return document.getElementById('na-app'); };

  function load() {
    return api('GET', 'me').then(function (me) {
      S.me = me;
      S.area = (me.prefs && me.prefs.area) || 'private';
      document.getElementById('na-msg').hidden = true;
      app().hidden = false;
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
    return api('GET', 'nav', null, { area: S.area }).then(function (n) { S.nav = n; renderNav(); }).catch(fail);
  }
  function reloadView() {
    var v = S.view;
    var p;
    if (v.kind === 'smart') p = api('GET', 'views/' + v.id, null, { area: S.area });
    else if (v.kind === 'list') p = api('GET', 'views/list:' + v.id);
    else if (v.kind === 'source') p = api('GET', 'views/source:' + v.plugin, null, { area: S.area });
    else if (v.kind === 'notes') p = loadNotes();
    else if (v.kind === 'search') p = api('GET', 'search', null, { q: v.q, area: S.area });
    else if (v.kind === 'sources') p = api('GET', 'sources');
    else if (v.kind === 'import') p = Promise.resolve({});
    return p.then(function (d) { S.data = d; renderMain(); if (S.detail) reloadDetail(); }).catch(function (e) {
      if (e && e.code === 'not_found' && v.kind !== 'smart') { go({ kind: 'smart', id: 'myday' }); return; }
      fail(e);
    });
  }
  function go(view) {
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

  // ── the menu ─────────────────────────────────────────────

  function navRow(label, count, current, fn, o) {
    o = o || {};
    return h('button', { type: 'button', class: 'na-row' + (o.sub ? ' is-sub' : '') + (o.quiet ? ' is-quiet' : ''), attrs: { 'aria-current': current ? 'page' : null }, on: { click: function () { fn(); setPane('list'); } } }, [
      o.icon ? h('span', { class: 'na-ic' }, icon(o.icon, 17)) : null, o.dot ? h('span', { class: 'na-dot', style: 'background:' + o.dot }) : null,
      h('span', { class: 'na-tx', text: label }), count != null && count !== 0 ? h('span', { class: 'na-count', text: String(count) }) : null,
    ]);
  }
  function isView(kind, id) {
    var v = S.view;
    return v.kind === kind && (id == null || v.id === id || v.plugin === id || (kind === 'notes' && v.notebook === id));
  }

  function renderNav() {
    var nav = document.getElementById('na-nav');
    clear(nav);
    var n = S.nav;
    nav.appendChild(h('div', { class: 'na-nav-title', text: T('p.title') }));
    var seg = h('div', { class: 'na-seg', role: 'group', attrs: { 'aria-label': T('p.area') } });
    ['private', 'work'].forEach(function (a) {
      seg.appendChild(h('button', { type: 'button', text: T('area.' + a), attrs: { 'aria-pressed': S.area === a ? 'true' : 'false' }, on: { click: function () {
        if (S.area === a) return;
        S.area = a;
        api('PUT', 'prefs', { area: a }).catch(function () {});
        if (S.view.kind === 'list' || (S.view.kind === 'notes' && S.view.notebook)) S.view = { kind: 'smart', id: 'myday' };
        S.detail = null;
        renderSide();
        reloadNav();
        reloadView();
      } } }));
    });
    nav.appendChild(seg);
    if (!n) return;
    var sm = n.smart || {};
    nav.appendChild(navRow(T('v.myday'), sm.myday, isView('smart', 'myday'), function () { go({ kind: 'smart', id: 'myday' }); }, { icon: 'sun' }));
    nav.appendChild(navRow(T('v.important'), sm.important, isView('smart', 'important'), function () { go({ kind: 'smart', id: 'important' }); }, { icon: 'star' }));
    nav.appendChild(navRow(T('v.planned'), sm.planned, isView('smart', 'planned'), function () { go({ kind: 'smart', id: 'planned' }); }, { icon: 'cal' }));
    nav.appendChild(navRow(T('v.assigned'), sm.assigned, isView('smart', 'assigned'), function () { go({ kind: 'smart', id: 'assigned' }); }, { icon: 'user' }));
    if ((n.sources || []).length) {
      nav.appendChild(h('div', { class: 'na-lab' }, h('span', { text: T('p.from_plugins') })));
      n.sources.forEach(function (s) {
        nav.appendChild(navRow(s.label, s.open, isView('source', s.plugin), function () { go({ kind: 'source', plugin: s.plugin }); }, { icon: 'open' }));
      });
    }
    nav.appendChild(h('div', { class: 'na-lab' }, h('span', { text: T('p.my_lists') })));
    var groups = {};
    (n.groups || []).forEach(function (g) { groups[g.id] = g; });
    var byGroup = {};
    (n.lists || []).forEach(function (l) { var k = l.groupId && groups[l.groupId] ? l.groupId : 0; (byGroup[k] = byGroup[k] || []).push(l); });
    (byGroup[0] || []).forEach(function (l) { nav.appendChild(listRow(l)); });
    (n.groups || []).forEach(function (g) {
      nav.appendChild(h('div', { class: 'na-row is-quiet', text: g.name }));
      (byGroup[g.id] || []).forEach(function (l) { nav.appendChild(listRow(l, true)); });
    });
    nav.appendChild(navRow(T('p.new_list'), null, false, newList, { icon: 'plus', quiet: true }));
    var notes = n.notes || { notebooks: [], total: 0 };
    nav.appendChild(h('div', { class: 'na-lab' }, h('span', { text: T('p.notes') })));
    nav.appendChild(navRow(T('p.all_notes'), notes.total, S.view.kind === 'notes' && !S.view.notebook && !S.view.tag, function () { go({ kind: 'notes' }); }, { icon: 'note' }));
    (notes.notebooks || []).forEach(function (b) {
      var label = b.vault ? (S.vault.names[b.vault.id] || T('p.vault_locked_name')) : b.bound ? b.name + ' (' + b.bound.label + ')' : b.name;
      nav.appendChild(navRow(label, b.count, isView('notes', b.id), function () { go({ kind: 'notes', notebook: b.id }); }, { sub: true, icon: b.vault ? 'lock' : null }));
    });
    nav.appendChild(navRow(T('p.new_notebook'), null, false, newNotebook, { icon: 'plus', quiet: true }));
    if ((notes.tags || []).length) {
      nav.appendChild(h('div', { class: 'na-lab' }, h('span', { text: T('p.tags') })));
      notes.tags.slice(0, 12).forEach(function (t) {
        nav.appendChild(navRow('#' + t.tag, t.count, S.view.kind === 'notes' && S.view.tag === t.tag, function () { go({ kind: 'notes', tag: t.tag }); }, { sub: true }));
      });
    }
    nav.appendChild(h('div', { class: 'na-lab' }, h('span', { text: T('p.more') })));
    nav.appendChild(navRow(T('p.sources'), null, isView('sources'), function () { go({ kind: 'sources' }); }, { icon: 'gear' }));
    if (S.me.imports && (S.me.imports.mstodo || S.me.imports.dsnote)) nav.appendChild(navRow(T('p.import'), null, isView('import'), function () { go({ kind: 'import' }); }, { icon: 'move' }));
  }
  function listRow(l, sub) {
    return navRow(l.name + (l.shared ? ' · ' + T('p.shared') : ''), l.open, isView('list', l.id), function () { go({ kind: 'list', id: l.id }); }, { sub: !!sub, icon: 'list', dot: l.color ? COLOR_HEX[l.color] : null });
  }

  // ── the main column ──────────────────────────────────────

  function header(title, sub, extra) {
    var back = h('button', { type: 'button', class: 'dp-ib na-back', attrs: { 'aria-label': T('p.menu') }, on: { click: function () { setPane('nav'); } } }, icon('back'));
    return h('div', { class: 'na-head' }, [back, h('div', { class: 'na-head-tx' }, [h('h2', { text: title }), sub ? h('span', { class: 'na-sub', text: sub }) : null])].concat(extra || []));
  }

  function renderMain() {
    var main = document.getElementById('na-main');
    clear(main);
    var v = S.view;
    if (v.kind === 'notes') return renderNotes(main);
    if (v.kind === 'sources') return renderSources(main);
    if (v.kind === 'import') return renderImport(main);
    if (v.kind === 'search') return renderSearch(main);
    var d = S.data || { sections: [] };
    var sub = v.kind === 'smart' && v.id === 'myday' ? longDate(S.me.today) : v.kind === 'list' && d.list && d.list.shared ? T('p.shared_with', { names: d.list.members.map(function (m) { return m.name; }).join(', ') }) : null;
    var extra = [quickBox()];
    if (v.kind === 'list' && d.list) extra.unshift(h('div', { class: 'dp-actions' }, [ib('gear', T('p.list_settings'), function () { listSettings(d.list); })]));
    main.appendChild(header(v.kind === 'smart' ? T('v.' + v.id) : d.title || '', sub, extra));
    var any = false;
    (d.sections || []).forEach(function (s) {
      if (!s.items.length && !(v.kind === 'list' && s.id === 'open')) return;
      any = true;
      main.appendChild(sectionCard(s));
    });
    if (!any) main.appendChild(h('div', { class: 'na-card' }, h('div', { class: 'na-empty', text: T(v.kind === 'source' ? 'p.empty_source' : 'p.empty') })));
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
    if (x.canComplete !== false && (x.type === 'task' || x.canComplete)) {
      row.appendChild(h('button', { type: 'button', class: 'na-ck' + (x.done ? ' is-on' : ''), attrs: { 'aria-label': x.done ? T('p.undo') : T('p.complete'), 'aria-pressed': x.done ? 'true' : 'false' },
        on: { click: function (ev) { ev.stopPropagation(); complete(x, !x.done); } } }, icon('check', 14)));
    } else row.appendChild(h('span', { class: 'na-ck-none' }));
    var meta = h('div', { class: 'na-meta' });
    if (x.type === 'source') {
      meta.appendChild(h('span', { class: 'na-src', 'data-src': x.source.plugin, text: x.source.label + (x.kind === 'deadline' ? ' · ' + T('k.deadline') : x.kind === 'homework' ? ' · ' + T('k.homework') : x.kind === 'exam' ? ' · ' + T('k.exam') : '') }));
      if (x.subtitle) meta.appendChild(h('span', { text: x.subtitle }));
      if (x.meta && x.meta.amount) meta.appendChild(h('span', { text: x.meta.amount }));
      if (x.assignee && x.assignee.name && x.assignee.id !== S.me.user.id) meta.appendChild(h('span', { text: x.assignee.name }));
      if (x.meta && x.meta.stars) meta.appendChild(h('span', { text: T('p.stars', { n: x.meta.stars }) }));
    } else {
      if (x.source) meta.appendChild(h('span', { class: 'na-src', 'data-src': x.source.plugin, text: T('src.' + x.source.plugin) }));
      var l = listOf(x.listId);
      if (l && !(S.view.kind === 'list')) meta.appendChild(h('span', { text: T('area.' + l.area) + ' › ' + l.name }));
      if (x.assignee && x.assignee.id !== S.me.user.id) meta.appendChild(h('span', { text: x.assignee.name || '' }));
      if (x.repeatText) meta.appendChild(h('span', { text: '↻ ' + x.repeatText }));
      if (x.hasNote) meta.appendChild(h('span', { text: T('p.has_note') }));
      if (x.attachments) meta.appendChild(h('span', { text: '📎 ' + x.attachments }));
    }
    if (x.progress && x.progress.total) meta.appendChild(h('span', { text: x.type === 'task' ? T('p.subtasks_n', { done: x.progress.done, total: x.progress.total }) : x.progress.done + '/' + x.progress.total }));
    row.appendChild(h('div', { class: 'na-it' }, [h('span', { class: 'na-it-title', text: x.title }), meta.childNodes.length ? meta : null]));
    if (x.important) row.appendChild(h('span', { class: 'na-src', 'data-src': 'important', text: T('p.important') }));
    var w = whenText(x);
    if (w) row.appendChild(h('span', { class: 'na-when' + (x.overdue ? ' is-over' : ''), text: w }));
    if (x.type === 'task') {
      row.appendChild(h('button', { type: 'button', class: 'na-star' + (x.important ? ' is-on' : ''), attrs: { 'aria-label': T('p.important'), 'aria-pressed': x.important ? 'true' : 'false' },
        on: { click: function (ev) { ev.stopPropagation(); api('PATCH', 'tasks/' + x.id, { important: !x.important }).then(soon, fail); } } }, icon('star', 17)));
    }
    return row;
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

  // ── quick entry ──────────────────────────────────────────

  function quickBox() {
    var input = h('input', { id: 'na-quick', type: 'text', autocomplete: 'off', attrs: { placeholder: T('p.quick_ph'), 'aria-label': T('p.quick'), maxlength: '500' } });
    var chips = h('div', { class: 'na-chips', attrs: { 'aria-live': 'polite' } });
    var parsed = null;
    function ctxParse() {
      return { today: S.me.today, now: S.me.time, lists: ((S.nav && S.nav.lists) || []).map(function (l) { return { id: l.id, name: l.name }; }), people: S.people, times: S.me.prefs && S.me.prefs.times };
    }
    function show() {
      clear(chips);
      var s = input.value.trim();
      parsed = s ? Q.parse(s, ctxParse()) : null;
      if (!parsed) return;
      if (parsed.date) chips.appendChild(h('span', { class: 'na-chip', text: dayText(parsed.date) + (parsed.time ? ', ' + parsed.time : '') }));
      if (parsed.remind) chips.appendChild(h('span', { class: 'na-chip', text: T('p.reminder') + ' ' + parsed.remind.time }));
      if (parsed.repeat) chips.appendChild(h('span', { class: 'na-chip', text: '↻ ' + RP.describe(parsed.repeat, S.me.lang) }));
      if (parsed.important) chips.appendChild(h('span', { class: 'na-chip', text: T('p.important') }));
      if (parsed.list) chips.appendChild(h('span', { class: 'na-chip', text: T('p.list') + ': ' + parsed.list.name }));
      else if (parsed.listName) chips.appendChild(h('span', { class: 'na-chip is-plain', text: T('p.new_list_named', { name: parsed.listName }) }));
      if (parsed.assignee) chips.appendChild(h('span', { class: 'na-chip', text: '@' + parsed.assignee.name }));
      else if (parsed.assigneeName) chips.appendChild(h('span', { class: 'na-chip is-plain', text: T('p.unknown_person', { name: parsed.assigneeName }) }));
    }
    input.addEventListener('input', show);
    input.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' || !input.value.trim()) return;
      var text = input.value.trim();
      var body = { text: text, area: S.area, createList: !!(parsed && parsed.listName) };
      if (S.view.kind === 'list' && !(parsed && (parsed.list || parsed.listName))) body.listId = S.view.id;
      if (S.view.kind === 'smart' && S.view.id === 'myday') body.myDay = true;
      if (S.view.kind === 'smart' && S.view.id === 'important') body.important = true;
      input.disabled = true;
      api('POST', 'tasks', body).then(function () { input.value = ''; show(); input.disabled = false; input.focus(); soon(); }, function (e) { input.disabled = false; fail(e); });
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
    var wide = S.view.kind === 'sources' || S.view.kind === 'import';
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
    return h('div', { class: 'na-d-foot', style: 'margin:0' }, [h('button', { type: 'button', class: 'dp-ib na-back', attrs: { 'aria-label': T('p.back') }, on: { click: closeDetail } }, icon('back')), h('span'), ib('x', T('p.close'), closeDetail)]);
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
    card.appendChild(h('div', { class: 'na-set-h' }, [h('button', { type: 'button', class: 'na-ck' + (t.done ? ' is-on' : ''), attrs: { 'aria-label': T('p.complete') }, on: { click: function () { complete(t, !t.done); setTimeout(reloadDetail, 600); } } }, icon('check', 14)), title,
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
    var myday = h('input', { type: 'checkbox', class: 'dp-sw', checked: t.myDay, attrs: { 'aria-label': T('p.in_myday') } });
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
    card.appendChild(field(T('p.repeat'), repeatSelect(t)));
    var members = [];
    var l = listOf(t.listId);
    if (l) members = [l.owner].concat(l.members || []);
    var as = h('select', { class: 'dp-input', attrs: { 'aria-label': T('p.assigned') } }, [h('option', { value: '', text: T('p.nobody') })]);
    members.forEach(function (m) { if (m) as.appendChild(h('option', { value: String(m.id), text: m.id === S.me.user.id ? T('p.me') : m.name || '' })); });
    as.value = t.assignee ? String(t.assignee.id) : '';
    as.addEventListener('change', function () { patchTask(t, { assigneeId: as.value ? Number(as.value) : null }); });
    card.appendChild(field(T('p.assigned'), as));
    var ls = h('select', { class: 'dp-input', attrs: { 'aria-label': T('p.list') } });
    ((S.nav && S.nav.lists) || []).forEach(function (x) { ls.appendChild(h('option', { value: String(x.id), text: T('area.' + x.area) + ' › ' + x.name })); });
    if (!listOf(t.listId)) ls.appendChild(h('option', { value: String(t.listId), text: t.list ? t.list.name : '' }));
    ls.value = String(t.listId);
    ls.addEventListener('change', function () { patchTask(t, { listId: Number(ls.value) }); });
    card.appendChild(field(T('p.list'), ls));
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

  // ── lists and notebooks ──────────────────────────────────

  function nameDialog(title, value, extra, onSave) {
    var input = h('input', { class: 'dp-input', type: 'text', value: value || '', attrs: { maxlength: '80', 'aria-label': T('p.name') } });
    var errBox = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    var go = function () { if (!input.value.trim()) return; Promise.resolve(onSave(input.value.trim())).then(closeDialog, function (e) { errBox.textContent = errText(e); }); };
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go(); });
    dialog(title, [h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.name') }), input])].concat(extra || []).concat([errBox, h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), btn(T('p.save'), go, { primary: true })])]));
    input.focus();
  }
  function newList() {
    var kind = 'list';
    var seg = h('div', { class: 'dp-seg' });
    ['list', 'group'].forEach(function (k) {
      var b = h('button', { type: 'button', text: T('p.kind_' + k), attrs: { 'aria-pressed': k === kind ? 'true' : 'false' }, on: { click: function () { kind = k; Array.prototype.forEach.call(seg.children, function (c) { c.setAttribute('aria-pressed', c === b ? 'true' : 'false'); }); } } });
      seg.appendChild(b);
    });
    nameDialog(T('p.new_list'), '', [seg], function (name) {
      if (kind === 'group') return api('POST', 'groups', { name: name, area: S.area }).then(reloadNav);
      return api('POST', 'lists', { name: name, area: S.area }).then(function (r) { reloadNav(); go({ kind: 'list', id: r.list.id }); });
    });
  }
  function sharePicker(current, onSave) {
    var chosen = {};
    (current || []).forEach(function (m) { chosen[m.id] = true; });
    var box = h('div', { class: 'na-tl' });
    S.people.filter(function (p) { return !p.me; }).forEach(function (p) {
      var cb = h('input', { type: 'checkbox', checked: !!chosen[p.id] });
      cb.addEventListener('change', function () { chosen[p.id] = cb.checked; });
      box.appendChild(h('label', null, [cb, h('span', { text: p.name })]));
    });
    if (!box.childNodes.length) box.appendChild(h('p', { class: 'dp-hint', text: S.me.sharing === 'off' ? T('p.sharing_off') : T('p.nobody_to_share') }));
    return { box: box, value: function () { return Object.keys(chosen).filter(function (k) { return chosen[k]; }).map(Number); } };
  }
  function listSettings(l) {
    var owner = l.role === 'owner';
    var share = sharePicker(l.members);
    var groups = h('select', { class: 'dp-input', attrs: { 'aria-label': T('p.group') } }, [h('option', { value: '', text: T('p.no_group') })]);
    ((S.nav && S.nav.groups) || []).forEach(function (g) { groups.appendChild(h('option', { value: String(g.id), text: g.name })); });
    groups.value = l.groupId ? String(l.groupId) : '';
    var colors = h('div', { class: 'na-colors', role: 'group', attrs: { 'aria-label': T('p.color') } });
    var color = l.color || 'none';
    COLORS.forEach(function (c) {
      colors.appendChild(h('button', { type: 'button', style: 'background:' + COLOR_HEX[c], attrs: { 'aria-label': T('c.' + c), 'aria-pressed': color === c ? 'true' : 'false' }, on: { click: function (ev) { color = c; Array.prototype.forEach.call(colors.children, function (b) { b.setAttribute('aria-pressed', b === ev.currentTarget ? 'true' : 'false'); }); } } }));
    });
    var extra = [h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.group') }), groups])];
    if (owner) extra.push(h('div', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.color') }), colors]), h('div', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.share_with') }), share.box]));
    extra.push(h('div', { class: 'dp-actions' }, [btn(owner ? T('p.delete_list') : T('p.leave_list'), function () {
      if (l.isDefault) { toast(T('err.default'), 'error'); return; }
      api('DELETE', 'lists/' + l.id).then(function () { closeDialog(); go({ kind: 'smart', id: 'myday' }); reloadNav(); }, fail);
    }, { small: true, danger: true, icon: 'trash' })]));
    nameDialog(T('p.list_settings'), l.name, extra, function (name) {
      var body = { groupId: groups.value ? Number(groups.value) : null };
      if (owner) { if (!l.isDefault || name !== l.name) body.name = name; body.color = color; }
      return api('PATCH', 'lists/' + l.id, body).then(function () { return owner ? api('PUT', 'lists/' + l.id + '/members', { members: share.value() }) : null; }).then(function () { reloadNav(); reloadView(); });
    });
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
      btn(T('p.new_note'), function () { newNote(nb); }, { primary: true, icon: 'plus', disabled: !!(nb && nb.vault && !S.vault.keys[nb.vault.id]) }),
    ]);
    if (nb && !nb.isDefault && !nb.bound) actions.appendChild(ib('gear', T('p.nb_settings'), function () { notebookSettings(nb); }));
    main.appendChild(header(title, nb && nb.bound ? T('p.bound_hint', { plugin: nb.bound.label }) : nb && nb.shared ? T('p.shared_with', { names: nb.members.map(function (m) { return m.name; }).join(', ') }) : null, [actions]));
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
  function notebookSettings(nb) {
    var owner = nb.role === 'owner';
    var share = sharePicker(nb.members);
    var extra = [];
    if (owner) extra.push(h('div', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.share_with') }), share.box]));
    if (nb.vault) extra.push(h('p', { class: 'dp-hint', text: T('p.vault_share_hint') }));
    extra.push(h('div', { class: 'dp-actions' }, [btn(owner ? T('p.delete_notebook') : T('p.leave_notebook'), function () {
      api('DELETE', 'notebooks/' + nb.id).then(function () { closeDialog(); go({ kind: 'notes' }); reloadNav(); }, fail);
    }, { small: true, danger: true, icon: 'trash' })]));
    var name = nb.vault ? (S.vault.names[nb.vault.id] || '') : nb.name;
    nameDialog(T('p.nb_settings'), name, extra, function (n) {
      var p;
      if (!owner) p = Promise.resolve();
      else if (nb.vault) {
        var keys = S.vault.keys[nb.vault.id];
        p = keys ? VC.encryptName(keys.get(nb.vault.keyVersion), nb.vault.id, nb.vault.keyVersion, n).then(function (c) { S.vault.names[nb.vault.id] = n; return api('PATCH', 'notebooks/' + nb.id, { nameCipher: c }); }) : Promise.resolve();
      } else p = api('PATCH', 'notebooks/' + nb.id, { name: n });
      return p.then(function () { return owner ? api('PUT', 'notebooks/' + nb.id + '/members', { members: share.value() }) : null; }).then(function () { reloadNav(); reloadView(); });
    });
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
    if (!S.editing) { card.appendChild(tools); card.appendChild(colors); }
    var move = h('select', { class: 'dp-input', attrs: { 'aria-label': T('p.move_to') } });
    (((S.nav && S.nav.notes) || {}).notebooks || []).forEach(function (b) { if (!!b.vault === !!vaultNb && (!vaultNb || b.id === vaultNb.id)) move.appendChild(h('option', { value: String(b.id), text: b.vault ? T('p.vault') : b.name })); });
    move.value = String(n.notebookId);
    move.addEventListener('change', function () { api('PATCH', 'notes/' + n.id, { notebookId: Number(move.value) }).then(function () { soon(); reloadDetail(); }, fail); });
    if (!S.editing && !vaultNb) card.appendChild(field(T('p.move_to'), move));
    if (!S.editing) card.appendChild(h('div', { class: 'na-d-foot' }, [h('span', { text: T('p.changed', { when: new Date(n.updatedAt).toLocaleString(S.me.lang) }) }),
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

  // ── „Quellen“ (mockup Quellen) ───────────────────────────

  function renderSources(main) {
    main.appendChild(header(T('p.sources'), null, []));
    var wrap = h('div', { class: 'na-set' });
    wrap.appendChild(h('p', { class: 'dp-hint', text: T('p.sources_intro') }));
    var prefs = S.me.prefs || { sources: {}, groups: {} };
    var save = function (body) { return api('PUT', 'prefs', body).then(function (r) { S.me.prefs = r.prefs; reloadNav(); }, fail); };
    (S.data && S.data.sources || []).forEach(function (s) {
      var sp = prefs.sources[s.plugin] || {};
      var on = h('input', { type: 'checkbox', class: 'dp-sw', checked: sp.on !== false && s.enabled, disabled: !s.enabled || !s.available, attrs: { 'aria-label': s.label } });
      on.addEventListener('change', function () { var o = {}; o[s.plugin] = { on: on.checked }; save({ sources: o }); });
      var card = h('div', { class: 'na-card' }, [h('div', { class: 'na-set-h' }, [h('span', { class: 'na-badge', text: s.label.slice(0, 2) }), h('div', null, [h('b', { text: s.label }),
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
    wrap.appendChild(h('div', { class: 'na-card' }, h('div', { class: 'na-set-h' }, [h('span', { class: 'na-badge', text: '…' }), h('div', null, [h('b', { text: T('p.src_later') }), h('span', { text: T('p.src_later_hint') })])])));
    main.appendChild(wrap);
  }

  // ── „Umziehen“ (mockup Import) ───────────────────────────

  function renderImport(main) {
    main.appendChild(header(T('p.import'), null, []));
    var wrap = h('div', { class: 'na-set' });
    wrap.appendChild(h('p', { class: 'dp-hint', text: T('p.import_intro') }));
    if (S.me.imports.mstodo) wrap.appendChild(mstodoCard());
    if (S.me.imports.dsnote) wrap.appendChild(dsnoteCard());
    main.appendChild(wrap);
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
          card.appendChild(field(x.listName + (x.error ? ' · ' + T('p.sync_error') : ''), btn(T('p.mstodo_unlink'), function () { api('DELETE', 'import/mstodo/links/' + x.id).then(function () { toast(T('p.mstodo_unlinked')); go({ kind: 'import' }); }, fail); }, { small: true })));
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
    if (ev.key === 'Escape' && !document.getElementById('na-dialog').hidden) closeDialog();
  });
  if (window.GC && typeof window.GC.on === 'function') {
    window.GC.on('event', function (ev) {
      if (!ev || ev.plugin !== 'gatecontrol-notizen') return;
      if (ev.type === 'changed') soon();
      if (ev.type === 'vault' && ev.data && ev.data.event === 'approved') soon();
    });
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden) { /* keep */ } });
  window.addEventListener('pagehide', lockAll);
  app().setAttribute('data-pane', 'list');
  load();
}());
