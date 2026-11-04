/* Admin page "Übersicht": storage, the last 7 days, the sends (a page at a time), retention, freeing storage, links and
   what works with GateDrop (GET admin/overview, GET admin/sends, PUT admin/retention, GET/POST admin/cleanup,
   DELETE admin/sends/<id>). Names of people and devices only — never a file name, a text, a link or a path. */
(function () {
  'use strict';
  var G = window.GD;
  var T = G.T;
  var el = G.el;
  var LOC = G.CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  var PAGE = 50;
  var DAY = 86400000;
  var S = { o: null, range: '7d', filter: 'all', q: '', rows: [], cursor: null, hasMore: false, counts: null, seq: 0, loading: false };

  // ─── formatting ───────────────────────────────────────────────────────────
  function age(ms) {
    var m = Math.max(1, Math.round(ms / 60000));
    if (m < 60) return T('admin.age_min', { n: m });
    var h = Math.round(m / 60);
    if (h < 48) return T('admin.age_h', { n: h });
    var d = Math.round(h / 24);
    return d === 1 ? T('admin.age_d1') : T('admin.age_d', { n: d });
  }
  function since(isoStr) { return age(Date.now() - new Date(isoStr).getTime()); }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function day(isoStr) {
    var d = new Date(isoStr);
    var start = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((start(new Date()) - start(d)) / DAY);
    if (diff === 0) return cap(T('portal.today'));
    if (diff === 1) return cap(T('portal.yesterday'));
    return d.toLocaleDateString(LOC, { weekday: 'short', day: 'numeric', month: 'numeric' });
  }
  function time(isoStr) { return new Date(isoStr).toLocaleTimeString(LOC, { hour: '2-digit', minute: '2-digit' }); }
  function dayTime(isoStr) { return isoStr ? day(isoStr) + ' ' + time(isoStr) : null; }
  function date(isoStr) { return new Date(isoStr).toLocaleDateString(LOC, { day: 'numeric', month: 'numeric' }); }
  function errText(code) {
    var k = 'admin.err.' + code;
    var s = T(k);
    return s === k ? T('admin.err.other', { code: code }) : s;
  }
  function platform(p) { return { android: 'Android', windows: 'Windows', ios: 'iOS' }[p] || (p ? cap(p) : ''); }
  function pill(text, tone) { return el('span', { class: 'gd-pill' + (tone ? ' is-' + tone : ''), text: text }); }
  function cell(main, sub, cls) {
    return el('td', cls ? { class: cls } : null, [main == null ? '—' : main, sub ? el('span', { class: 'gd-sub', text: sub }) : null]);
  }

  // ─── tiles ────────────────────────────────────────────────────────────────
  function tile(label, value, unit, sub, extra, cls) {
    return el('div', { class: 'gd-tile' + (cls ? ' ' + cls : '') }, [
      el('span', { class: 'gd-tile-l', text: label }),
      el('span', { class: 'gd-tile-v' }, [value, unit ? el('small', { text: ' ' + unit }) : null]),
    ].concat(extra || []).concat([sub ? el('span', { class: 'gd-tile-s', text: sub }) : null]));
  }
  function tiles(o) {
    var st = o.storage;
    var h = o.held;
    var quota = st && st.quota ? st.quota : 0;
    var pct = function (b) { return quota ? Math.min(100, (b / quota) * 100) : 0; };
    var used = st ? st.bytes : h.picked.bytes + h.unpicked.bytes;
    var bar = el('div', { class: 'gd-bar gd-bar2', role: 'img', 'aria-label': T('admin.t_held_aria', { picked: G.bytes(h.picked.bytes), unpicked: G.bytes(h.unpicked.bytes), free: G.bytes(Math.max(0, quota - used)) }) }, [
      el('i', { class: 'is-good', style: 'width:' + pct(h.picked.bytes).toFixed(1) + '%' }),
      el('i', { class: 'is-warn', style: 'width:' + pct(h.unpicked.bytes).toFixed(1) + '%' }),
    ]);
    var split = el('span', { class: 'gd-tile-s' }, [
      el('span', { class: 'gd-dot is-good', 'aria-hidden': 'true' }), ' ' + T('admin.t_held_picked', { bytes: G.bytes(h.picked.bytes) }) + ' · ',
      el('span', { class: 'gd-dot is-warn', 'aria-hidden': 'true' }), ' ' + T('admin.t_held_unpicked', { bytes: G.bytes(h.unpicked.bytes) }),
    ]);
    var w = o.week;
    var up = h.unpicked;
    var free = el('button', { type: 'button', class: 'btn btn-sm gd-start', text: T('admin.free'), on: { click: openCleanup } });
    return el('div', { class: 'gd-tiles' }, [
      tile(T('admin.t_held'), G.bytes(used), quota ? T('admin.t_of', { quota: G.bytes(quota) }) : null, null, [quota ? bar : null, split]),
      tile(T('admin.t_arrived'), String(w.arrived), (w.sends === 1 ? T('admin.t_arrived_of1') : T('admin.t_arrived_of', { n: w.sends })), T('admin.t_arrived_s', { waiting: w.waiting, failed: w.failed })),
      el('div', { class: 'gd-tile' }, [
        el('span', { class: 'gd-tile-l', text: T('admin.t_way') }),
        el('span', { class: 'gd-tile-v' }, [String(w.direct), el('small', { text: ' ' + T('admin.t_direct') }), ' · ' + w.server, el('small', { text: ' ' + T('admin.t_server') })]),
        el('span', { class: 'gd-tile-s', text: T('admin.t_way_s') }),
      ]),
      tile(T('admin.t_unpicked'), String(up.count), T(up.count === 1 ? 'admin.t_unpicked_v1' : 'admin.t_unpicked_v', { bytes: G.bytes(up.bytes) }),
        up.count && up.oldestAt ? T('admin.t_oldest', { age: since(up.oldestAt) }) : T('admin.t_all_picked'), [free], up.count ? 'is-warn' : ''),
    ]);
  }

  // ─── the list ─────────────────────────────────────────────────────────────
  function toMain(r) {
    if (r.kind === 'device' || r.kind === 'person') return r.name || T('admin.unknown');
    return T('admin.to_' + r.kind);
  }
  function toSub(r) {
    if (r.kind === 'device') return [platform(r.platform), r.owner].filter(Boolean).join(' · ') || null;
    if (r.kind === 'person') return r.messenger ? T('admin.to_person_chat') : T('admin.to_person_s');
    if (r.kind === 'family') return T('admin.to_family_s', { n: r.members });
    if (r.kind === 'nas') return r.name ? T('admin.to_nas_s', { name: r.name }) : T('admin.to_nas_s0');
    if (r.kind === 'drive') return T('admin.to_drive_s');
    return [r.pin ? T('admin.to_link_pin') : null, r.maxDownloads ? T('admin.to_link_max', { n: r.maxDownloads }) : null].filter(Boolean).join(' · ') || null;
  }
  function toCell(s) {
    if (!s.to.length) return cell(null);
    var td = cell(toMain(s.to[0]), toSub(s.to[0]));
    if (s.to.length > 1) td.appendChild(el('span', { class: 'gd-sub', text: T('admin.to_more', { n: s.to.length - 1 }), title: s.to.slice(1).map(toMain).join(', ') }));
    return td;
  }
  function wayCell(s) {
    if (!s.way) return cell(null);
    var tone = { direct: 'good', server: 'info', fallback: 'info', mixed: 'info', link: 'off' }[s.way];
    var sub = null;
    if (s.way === 'direct') sub = T('admin.way_direct_s');
    else if (s.way === 'fallback') sub = T('admin.way_fallback_s');
    else if (s.way === 'server' && s.to.length === 1) {
      var r = s.to[0];
      if ((r.kind === 'person' || r.kind === 'family') && r.messenger) sub = T('admin.way_chat_s');
      else if (r.kind === 'nas') sub = T('admin.way_nas_s');
      else if (r.kind === 'drive') sub = T('admin.way_drive_s');
    }
    return cell(pill(T('admin.way_' + s.way), tone), sub);
  }
  function statusCell(s) {
    var st = s.status;
    var bad = s.problem;
    switch (st.state) {
      case 'picked': return cell(pill(T('admin.st_' + st.how), 'good'), st.how === 'received' ? T('admin.st_received_s') : dayTime(st.at));
      case 'partial': return cell(pill(T('admin.st_partial', { x: st.picked, y: st.total }), bad ? 'crit' : 'warn'),
        st.open && st.open.length ? T('admin.st_open', { names: st.open.join(', ') }) : (st.error ? errText(st.error) : null));
      case 'waiting': return cell(pill(T('admin.st_waiting'), bad ? 'crit' : 'warn'),
        st.scan ? T('admin.st_scan') : (st.offline && st.lastSeen ? T('admin.st_offline', { age: since(st.lastSeen) }) : T('admin.st_since', { age: since(st.since) })));
      case 'pending': return cell(pill(T('admin.st_pending'), bad ? 'crit' : 'info'), st.scan ? T('admin.st_scan') : null);
      case 'failed': return cell(pill(T('admin.st_failed'), 'crit'), errText(st.error));
      case 'removed': return cell(pill(T('admin.st_removed'), 'off'), dayTime(st.at));
      case 'link': return cell(pill(st.downloads ? T('admin.st_link_loaded', { n: st.downloads }) : T('admin.st_link_none'), st.downloads ? 'good' : 'off'),
        st.error ? errText(st.error) : (st.active && st.expiresAt ? T('admin.st_link_until', { age: age(new Date(st.expiresAt).getTime() - Date.now()) }) : T('admin.st_link_ended')));
      default: return cell(pill(T('admin.st_expired'), bad ? 'crit' : 'off'), T('admin.st_expired_s'));
    }
  }
  function serverCell(s) {
    var v = s.server;
    if (v.state === 'held') return cell(G.bytes(v.bytes), v.until ? T('admin.srv_until', { date: date(v.until) }) : null, 'gd-nowrap');
    return cell('—', T('admin.srv_' + v.state), 'gd-nowrap');
  }
  function removeOne(s) {
    G.confirm(T('admin.delete_confirm', { bytes: G.bytes(s.server.bytes) }), T('admin.delete')).then(function (yes) {
      if (!yes) return;
      G.api('DELETE', 'admin/sends/' + encodeURIComponent(s.id)).then(function (r) {
        G.toast(T('admin.deleted', { bytes: G.bytes(r.bytes) }));
        refresh();
      }, function (e) { G.toast(G.errText(e), 'error'); });
    });
  }
  function rowOf(s) {
    var files = s.files ? (s.files === 1 ? T('admin.files_one') : T('admin.files', { n: s.files })) : T('admin.no_files');
    return el('tr', null, [
      cell(day(s.createdAt), time(s.createdAt), 'gd-nowrap'),
      cell(s.from.name || T('admin.unknown'), s.from.portal ? T('admin.portal') : s.from.device),
      toCell(s),
      cell(files, s.files ? G.bytes(s.bytes) : null, 'gd-nowrap'),
      wayCell(s),
      statusCell(s),
      serverCell(s),
      el('td', { class: 'gd-act' }, [s.canDelete ? el('button', { type: 'button', class: 'btn btn-sm btn-crit', text: T('admin.delete'), 'aria-label': T('admin.delete_aria'), on: { click: function () { removeOne(s); } } }) : null]),
    ]);
  }
  function chips() {
    var box = G.$('#gd-chips');
    if (!box) return;
    G.clear(box);
    ['all', 'problems', 'waiting', 'direct', 'server', 'links'].forEach(function (f) {
      var n = S.counts ? S.counts[f] : null;
      box.appendChild(el('button', {
        type: 'button', class: 'gd-chip' + (S.filter === f ? ' is-on' : ''), 'aria-pressed': S.filter === f ? 'true' : 'false',
        text: T('admin.f_' + f) + (n == null ? '' : ' · ' + n),
        on: { click: function () { if (S.filter !== f) { S.filter = f; load(true); } } },
      }));
    });
  }
  function renderList() {
    var body = G.$('#gd-rows');
    if (!body) return;
    chips();
    G.clear(body);
    S.rows.forEach(function (s) { body.appendChild(rowOf(s)); });
    G.$('#gd-empty').hidden = S.loading || S.rows.length > 0;
    var more = G.$('#gd-more');
    more.hidden = !S.hasMore;
    more.disabled = S.loading;
  }
  function load(reset) {
    var seq = ++S.seq;
    S.loading = true;
    renderList();
    var qs = 'range=' + encodeURIComponent(S.range) + '&filter=' + encodeURIComponent(S.filter) + '&limit=' + PAGE
      + (S.q ? '&q=' + encodeURIComponent(S.q) : '') + (!reset && S.cursor ? '&cursor=' + encodeURIComponent(S.cursor) : '');
    G.api('GET', 'admin/sends?' + qs).then(function (r) {
      if (seq !== S.seq) return;
      S.rows = reset ? r.items : S.rows.concat(r.items);
      S.cursor = r.cursor;
      S.hasMore = r.hasMore;
      S.counts = r.counts;
      S.loading = false;
      renderList();
    }, function (e) {
      if (seq !== S.seq) return;
      S.loading = false;
      renderList();
      G.toast(G.errText(e), 'error');
    });
  }
  function sendsCard() {
    var timer = null;
    var search = el('input', {
      type: 'search', class: 'gd-search-in', placeholder: T('admin.search'), 'aria-label': T('admin.search_label'), maxlength: '60',
      on: { input: function (ev) { clearTimeout(timer); var v = ev.target.value.trim(); timer = setTimeout(function () { if (v !== S.q) { S.q = v; load(true); } }, 300); } },
    });
    var range = el('select', { class: 'gd-select', 'aria-label': T('admin.range'), on: { change: function (ev) { S.range = ev.target.value; load(true); } } },
      ['7d', '30d', 'server'].map(function (r) { return el('option', { value: r, text: T('admin.range_' + r) }); }));
    range.value = S.range;
    var head = el('tr', null, ['time', 'from', 'to', 'size', 'way', 'status', 'server'].map(function (k) { return el('th', { scope: 'col', text: T('admin.col_' + k) }); })
      .concat([el('th', { scope: 'col' }, [el('span', { class: 'gd-sr', text: T('admin.col_action') })])]));
    return el('section', { class: 'gd-card gd-sends', 'aria-labelledby': 'gd-sends-h' }, [
      el('div', { class: 'gd-sends-head' }, [
        el('h2', { id: 'gd-sends-h', text: T('admin.sends_title') }),
        el('label', { class: 'gd-search' }, [G.svg('M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z|m20 20-3.5-3.5'), search]),
        range,
      ]),
      el('div', { class: 'gd-chips', id: 'gd-chips', role: 'group', 'aria-label': T('admin.sends_title') }),
      el('div', { class: 'gd-tablewrap' }, [el('table', { class: 'gd-table' }, [el('thead', null, [head]), el('tbody', { id: 'gd-rows' })])]),
      el('p', { class: 'gd-muted gd-empty', id: 'gd-empty', text: T('admin.empty'), hidden: true }),
      el('button', { type: 'button', class: 'btn btn-sm gd-start', id: 'gd-more', text: T('admin.more'), hidden: true, on: { click: function () { load(false); } } }),
      el('p', { class: 'gd-note', text: T('admin.list_note') }),
    ]);
  }

  // ─── retention ────────────────────────────────────────────────────────────
  function retentionCard(r) {
    var after = el('select', { class: 'gd-select', id: 'gd-ret-after' }, r.after.map(function (n) {
      return el('option', { value: String(n), text: n === 0 ? T('admin.ret_now') : (n === 1 ? T('admin.ret_keep_1') : T('admin.ret_keep_n', { n: n })) });
    }));
    after.value = String(r.afterDays);
    var unpicked = el('select', { class: 'gd-select', id: 'gd-ret-unpicked' }, r.unpicked.map(function (n) { return el('option', { value: String(n), text: T('admin.ret_days', { n: n }) }); }));
    unpicked.value = String(r.unpickedDays);
    var save = el('button', { type: 'button', class: 'btn btn-primary gd-start', text: T('admin.ret_save') });
    save.addEventListener('click', function () {
      save.disabled = true;
      G.api('PUT', 'admin/retention', { afterDays: Number(after.value), unpickedDays: Number(unpicked.value) }).then(function () {
        save.disabled = false;
        G.toast(T('admin.ret_saved'));
        refresh();
      }, function (e) { save.disabled = false; G.toast(G.errText(e), 'error'); });
    });
    return el('section', { class: 'gd-card' }, [
      el('h2', { text: T('admin.ret_title') }),
      el('p', { text: T('admin.ret_hint') }),
      el('div', { class: 'gd-fields' }, [
        el('label', { class: 'gd-field', for: 'gd-ret-after' }, [T('admin.ret_after'), after]),
        el('label', { class: 'gd-field', for: 'gd-ret-unpicked' }, [T('admin.ret_unpicked'), unpicked]),
      ]),
      el('span', { class: 'gd-note', text: T('admin.ret_note') }),
      save,
    ]);
  }

  // ─── freeing storage ──────────────────────────────────────────────────────
  function openCleanup() {
    var info = null;
    var ov = null;
    var close = function () { ov.remove(); };
    var days = el('select', { class: 'gd-select gd-select-sm', 'aria-label': T('admin.cl_min_age') }, [1, 3, 7].map(function (n) {
      return el('option', { value: String(n), text: n === 1 ? T('admin.cl_day_1') : T('admin.cl_day_n', { n: n }) });
    }));
    days.value = '3';
    var cbU = el('input', { type: 'checkbox', checked: true });
    var cbP = el('input', { type: 'checkbox' });
    var sumU = el('span', { class: 'gd-opt-d', text: T('admin.cl_loading') });
    var sumP = el('span', { class: 'gd-opt-d', text: T('admin.cl_loading') });
    var go = el('button', { type: 'button', class: 'btn btn-danger', disabled: true });
    var optU = el('label', { class: 'gd-opt' }, [cbU, el('span', { class: 'gd-opt-t' }, [el('span', { class: 'gd-opt-h' }, [T('admin.cl_unpicked') + ' ', days]), sumU])]);
    var optP = el('label', { class: 'gd-opt' }, [cbP, el('span', { class: 'gd-opt-t' }, [el('span', { class: 'gd-opt-h', text: T('admin.cl_picked') }), sumP])]);
    function sum(x) { return T(x.count === 1 ? 'admin.cl_sum_one' : 'admin.cl_sum', { n: x.count, bytes: G.bytes(x.bytes) }); }
    function paint() {
      if (info) {
        sumU.textContent = sum(info.unpicked) + ' · ' + T('admin.cl_unpicked_s');
        sumP.textContent = sum(info.picked) + ' · ' + T('admin.cl_picked_s');
      }
      optU.classList.toggle('is-on', cbU.checked);
      optP.classList.toggle('is-on', cbP.checked);
      var n = info ? (cbU.checked ? info.unpicked.count : 0) + (cbP.checked ? info.picked.count : 0) : 0;
      var bytes = info ? (cbU.checked ? info.unpicked.bytes : 0) + (cbP.checked ? info.picked.bytes : 0) : 0;
      go.textContent = T('admin.cl_go', { bytes: G.bytes(bytes) });
      go.disabled = !n;
    }
    function fetchInfo() {
      var want = days.value;
      info = null;
      sumU.textContent = T('admin.cl_loading');
      paint();
      G.api('GET', 'admin/cleanup?olderDays=' + encodeURIComponent(want)).then(function (r) { if (days.value === want) { info = r; paint(); } }, function (e) { G.toast(G.errText(e), 'error'); });
    }
    cbU.addEventListener('change', paint);
    cbP.addEventListener('change', paint);
    days.addEventListener('change', fetchInfo);
    go.addEventListener('click', function () {
      go.disabled = true;
      G.api('POST', 'admin/cleanup', { unpicked: cbU.checked ? Number(days.value) : null, picked: cbP.checked }).then(function (r) {
        close();
        G.toast(T('admin.cl_done', { n: r.removed, bytes: G.bytes(r.bytes) }));
        refresh();
      }, function (e) { go.disabled = false; G.toast(G.errText(e), 'error'); });
    });
    ov = el('div', { class: 'gd-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gd-cl-h', on: { keydown: function (ev) { if (ev.key === 'Escape') close(); } } }, [
      el('div', { class: 'gd-modal gd-modal-wide' }, [
        el('h2', { id: 'gd-cl-h', class: 'gd-modal-h', text: T('admin.cl_title') }),
        el('p', { class: 'gd-muted', text: T('admin.cl_hint') }),
        optU, optP,
        el('div', { class: 'gd-warnbox' }, [G.svg('M12 9v4|M12 17h.01|M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 18), el('span', { text: T('admin.cl_warn') })]),
        el('div', { class: 'gd-modal-foot' }, [el('button', { type: 'button', class: 'btn', text: T('admin.cl_cancel'), on: { click: close } }), go]),
      ]),
    ]);
    document.body.appendChild(ov);
    fetchInfo();
    setTimeout(function () { cbU.focus(); }, 30);
  }

  // ─── the page ─────────────────────────────────────────────────────────────
  function pillOn(on) { return el('span', { class: 'gd-pill' + (on ? '' : ' is-off'), text: on ? T('admin.on') : T('admin.off') }); }
  function render(o) {
    S.o = o;
    var page = G.clear(G.$('#gd-page'));
    page.appendChild(el('div', { class: 'gd-head' }, [el('span', { class: 'gd-pill is-info' }, [G.svg('M7 11V7a5 5 0 0 1 10 0v4|M5 11h14v10H5z', 14), T('admin.privacy')])]));
    page.appendChild(tiles(o));
    page.appendChild(sendsCard());
    page.appendChild(el('div', { class: 'gd-grid2' }, [
      retentionCard(o.retention),
      el('div', { class: 'gd-card' }, [el('h2', { text: T('admin.links_title') }), pillOn(o.linksEnabled), el('p', { text: o.linksEnabled ? T('admin.links_on') : T('admin.links_off') }),
        el('p', { text: T('admin.active_links', { n: o.activeLinks }) })]),
      el('div', { class: 'gd-card' }, [el('h2', { text: T('admin.quota_title') }), el('p', { text: T('admin.quota_hint') })]),
      el('div', { class: 'gd-card' }, [el('h2', { text: T('admin.who_title') }), el('p', { text: T('admin.who_people') }), el('p', { text: T('admin.who_links') })]),
      el('div', { class: 'gd-card' }, [el('h2', { text: T('admin.integrations') }),
        el('div', { class: 'gd-int' }, [el('span', { text: T('admin.int_messenger') }), pillOn(o.integrations.messenger)]),
        el('div', { class: 'gd-int' }, [el('span', { text: T('admin.int_nas') }), pillOn(o.integrations.nas)]),
        el('div', { class: 'gd-int' }, [el('span', { text: T('admin.int_drive') }), pillOn(o.integrations.drive)]),
        el('div', { class: 'gd-int' }, [el('span', { text: T('admin.int_familie') }), pillOn(o.integrations.familie)])]),
    ]));
    renderList();
  }
  /** The tiles anew and the list from its first page (after saving, deleting, freeing storage). */
  function refresh() {
    G.api('GET', 'admin/overview').then(function (o) {
      var old = G.$('.gd-tiles');
      S.o = o;
      if (old) old.replaceWith(tiles(o));
    }, function () {});
    load(true);
  }
  G.api('GET', 'admin/overview').then(function (o) { render(o); load(true); }, function () { G.$('#gd-loading').textContent = T('admin.load_failed'); });
}());
