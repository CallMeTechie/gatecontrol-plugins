/* Drive (gatecontrol-drive) — the overview of the portal (since 1.18.0, feature `overview`; mockup "Drive-Startseite",
 * board WinStart): the start of Drive and its default page, one request (GET overview), tiles in a grid — one column at
 * phone width. In the order of the mockup:
 *
 *   row 1   "Zu erledigen" (the next deadlines, the photos to check, Mail's attachments to file) · "Zuletzt geöffnet" ·
 *           "Neu in Familie" (what others added in the shared areas) with the storage below
 *   row 2   "Erinnerungen" (this day in earlier years) · "Personen" (with "Wer ist das?") · "Orte" (a small map as a
 *           picture with the count, the places with the most photos)
 *
 * A tile without anything is left out (the storage stays). Live: the event 'changed' loads the overview again — at most
 * every LIVE_MIN_MS. portal.js calls DriveOverview.attach(ui) with its helpers. Server and user text only ever goes into
 * textContent or attributes.
 */
(function () {
  'use strict';

  var RECENT_SHOWN = 5;
  var MEMORIES_SHOWN = 2;
  var LIVE_DELAY_MS = 1500;
  var LIVE_MIN_MS = 10000;
  var DAY = 86400000;

  function attach(U) {
    var T = U.T;
    var P = U.P;
    var h = U.h;
    var icon = U.icon;
    var api = U.api;
    var S = U.S;
    var has = U.has;
    var clear = U.clear;
    var st = { seq: 0, data: null, timer: null, last: 0 };

    // ── small things ─────────────────────────────────────

    function num(n) { return Number(n || 0).toLocaleString(U.LOCALE); }
    function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

    /** "vor 5 Min.", "vor 2 Std.", "gestern", "vor 3 Tagen", else the date. */
    function ago(iso) {
      var d = new Date(iso);
      if (!iso || isNaN(d.getTime())) return '';
      var now = new Date();
      var mins = Math.round((now.getTime() - d.getTime()) / 60000);
      if (mins < 1) return T('p.ov.just_now');
      if (mins < 60) return T('p.ov.mins_ago', { count: mins });
      var days = Math.round((startOfDay(now) - startOfDay(d)) / DAY);
      if (days <= 0) return T('p.ov.hours_ago', { count: Math.max(1, Math.round(mins / 60)) });
      if (days === 1) return T('p.ov.yesterday');
      if (days < 7) return T('p.ov.days_ago', { count: days });
      return d.toLocaleDateString(U.LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    /** Days from today to 'YYYY-MM-DD' (0: today). */
    function daysTo(date) {
      var p = String(date || '').split('-');
      var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
      if (isNaN(d.getTime())) return null;
      return Math.round((d.getTime() - startOfDay(new Date())) / DAY);
    }
    function inDays(n) { return n === 0 ? T('p.ov.today') : n === 1 ? T('p.ov.tomorrow') : T('p.ov.in_days', { count: n }); }

    /** The small badge of a file: PDF, DOC, XLS, … by its type and name. */
    function badge(n) {
      var m = String(n.mime || '');
      var ext = U.extOf(n.name || '');
      var kind = m === 'application/pdf' ? 'pdf' : /sheet|excel|csv/.test(m) || /^(XLSX?|ODS|CSV)$/.test(ext) ? 'xls'
        : /word|document|text/.test(m) || /^(DOCX?|ODT|TXT|RTF)$/.test(ext) ? 'doc' : 'any';
      var label = kind === 'pdf' ? 'PDF' : kind === 'xls' ? 'XLS' : kind === 'doc' ? 'DOC' : (ext || '').slice(0, 4) || '·';
      return h('span', { class: 'dp-ov-fi is-' + kind, text: label, attrs: { 'aria-hidden': 'true' } });
    }

    function tile(title, more, kids, cls) {
      return h('section', { class: 'dp-ov-tile' + (cls ? ' ' + cls : ''), attrs: { 'aria-label': title } }, [
        h('div', { class: 'dp-ov-th' }, [h('h2', { class: 'dp-ov-h', text: title }), more]),
      ].concat(kids));
    }
    function moreLink(label, fn) { return h('button', { type: 'button', class: 'dp-ov-more', text: label, on: { click: fn } }); }
    function count(n) { return h('span', { class: 'dp-meta', text: num(n) }); }

    /** A row of a tile: its icon, a title and a line below; a button when it does something. */
    function row(lead, title, sub, fn, cls) {
      var kids = [lead, h('span', { class: 'dp-ov-tx' }, [typeof title === 'string' ? h('span', { class: 'dp-ov-t', text: title }) : title, sub ? h('span', { class: 'dp-meta', text: sub }) : null])];
      return fn ? h('button', { type: 'button', class: 'dp-ov-row' + (cls ? ' ' + cls : ''), on: { click: fn } }, kids)
        : h('div', { class: 'dp-ov-row is-static' + (cls ? ' ' + cls : '') }, kids);
    }

    // ── the tiles ────────────────────────────────────────

    function todoTile(td) {
      var rows = [];
      (td.deadlines || []).forEach(function (d) {
        var n = daysTo(d.date);
        var what = d.label || T('p.dl_' + d.kind) + (d.node ? ' · ' + d.node.name : '');
        var amount = d.doc && d.doc.amount != null ? U.fmtAmount(d.doc.amount, d.doc.currency) : '';
        var area = d.node ? U.areaOf(d.node.areaId) : null;
        var sub = [n == null ? '' : inDays(n), amount, area ? area.label : ''].filter(Boolean).join(' · ');
        rows.push(row(h('span', { class: 'dp-ov-ti is-warn', text: n == null ? '!' : String(Math.max(0, n)), attrs: { 'aria-hidden': 'true' } }), what, sub,
          function () { if (d.node) U.openTarget(d.node.id, null); }));
      });
      if (td.deadlinesTotal > (td.deadlines || []).length) rows.push(h('button', { type: 'button', class: 'dp-ov-all', text: T('p.ov.all_deadlines', { count: td.deadlinesTotal }), on: { click: U.showDeadlines } }));
      if (td.review > 0) {
        rows.push(row(h('span', { class: 'dp-ov-ti is-warn', attrs: { 'aria-hidden': 'true' } }, icon('help', 16)), P('p.ov.review', td.review), T('p.ov.review_sub'),
          function () { U.PH.cls = 'review'; U.showPhotos(); }));
      }
      if (td.toFile > 0) {
        // "Zum Ablegen" is in Mail (the apps open it there)
        rows.push(row(h('span', { class: 'dp-ov-ti is-info', attrs: { 'aria-hidden': 'true' } }, icon('mail', 16)), P('p.ov.tofile', td.toFile),
          td.toFileHint ? T('p.ov.tofile_hint', { where: td.toFileHint }) : T('p.ov.tofile_where'), null));
      }
      if (!rows.length) return null;
      var n = (td.deadlinesTotal || 0) + (td.review > 0 ? 1 : 0) + (td.toFile > 0 ? 1 : 0);
      return tile(T('p.ov.todo'), count(n), rows, 'is-todo');
    }

    function recentTile(list) {
      var rows = list.slice(0, RECENT_SHOWN).map(function (n) {
        var sub = [ago(n.openedAt || n.changedAt), n.areaLabel].filter(Boolean).join(' · ');
        return row(badge(n), h('span', { class: 'dp-ov-t', text: n.name, attrs: { title: n.name } }), sub, function () { U.openTarget(n.id, null); });
      });
      return tile(T('p.ov.recent'), moreLink(T('p.ov.all'), function () { U.showFiles(); }), rows, 'is-recent');
    }

    function initials(name) {
      var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return '?';
      return (parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : '')).toUpperCase();
    }

    function activityText(x) {
      var who = h('b', { text: (x.user && x.user.name) || '?' });
      var one = x.count === 1 && x.sample ? x.sample.name : null;
      var key = x.kind === 'added_photos' ? (one ? 'p.ov.act_photo' : 'p.ov.act_photos') : x.kind === 'changed' ? (one ? 'p.ov.act_changed_one' : 'p.ov.act_changed')
        : (one ? 'p.ov.act_file' : 'p.ov.act_files');
      // "{{who}} hat 14 Fotos hinzugefügt": the name bold, the rest as text
      var parts = T(key, { count: num(x.count), name: one || '' }).split('{{who}}');
      return h('span', { class: 'dp-ov-t is-wrap' }, [parts[0] || null, who, parts.slice(1).join('') || null]);
    }

    function activityTile(list, storage) {
      var rows = (list || []).map(function (x) {
        var where = x.folder && x.folder.path ? x.folder.path.split('/').pop() : (x.area && x.area.label) || '';
        var sub = [where, ago(x.at)].filter(Boolean).join(' · ');
        var lead = h('span', { class: 'dp-ov-av', text: initials(x.user && x.user.name), attrs: { 'aria-hidden': 'true', 'data-hue': String(((x.user && x.user.id) || 0) % 5) } });
        return row(lead, activityText(x), sub, function () {
          if (x.sample) U.openTarget(x.sample.id, null);
          else if (x.folder) U.openFolder(x.area.id, x.folder.id);
        });
      });
      var family = (list || []).length && list.every(function (x) { var a = U.areaOf(x.area && x.area.id); return a && a.kind === 'family'; });
      var title = !rows.length ? T('p.storage') : family ? T('p.ov.family') : T('p.ov.shared');
      var kids = rows.slice();
      if (storage) kids.push(storageBox(storage, !rows.length));
      return tile(title, null, kids, 'is-activity');
    }

    function storageBox(s, alone) {
      var pct = s.total ? Math.min(100, Math.round((s.used / s.total) * 100)) : 0;
      var text = s.total ? T('p.used_of', { used: U.fmtSize(s.used), quota: U.fmtSize(s.total) }) : T('p.used', { used: U.fmtSize(s.used) });
      return h('div', { class: 'dp-ov-store' + (alone ? ' is-alone' : '') }, [
        h('span', { class: 'dp-meta', text: (alone ? '' : T('p.storage') + ' · ') + text + (s.target ? ' · ' + s.target : '') }),
        s.total ? h('span', { class: 'dp-meter', attrs: { role: 'img', 'aria-label': text } }, h('span', { attrs: { style: 'width:' + pct + '%' } })) : null,
      ]);
    }

    function memoriesTile(list) {
      var grid = h('div', { class: 'dp-ov-mems' }, list.slice(0, MEMORIES_SHOWN).map(function (g) {
        var label = P('p.ov.today_years', g.yearsAgo);
        var src = g.cover && (g.cover.largeUrl || g.cover.previewUrl);
        return h('button', { type: 'button', class: 'dp-ov-mem', attrs: { 'aria-label': label + ' · ' + P('p.photos_n', g.count) }, on: { click: function () { U.showPhotos(); } } }, [
          src ? h('img', { attrs: { src: src, alt: '', loading: 'lazy' } }) : null,
          h('span', { class: 'dp-ov-memtx' }, [h('b', { text: label }), h('span', { text: P('p.photos_n', g.count) })]),
        ]);
      }));
      return tile(T('p.ov.memories'), moreLink(T('p.ov.all'), function () { U.showPhotos(); }), [grid], 'is-memories');
    }

    function peopleTile(pp) {
      var PL = U.PL();
      var faces = (pp.people || []).map(function (p) {
        var c = p.cover;
        var face = PL && c && c.item ? PL.faceCrop(c.item, c.box, 48, { label: p.name }) : h('span', { class: 'dp-ov-fc', text: initials(p.name) });
        return h('button', { type: 'button', class: 'dp-ov-face', attrs: { title: p.name }, on: { click: function () { if (PL) PL.showPerson(p.id); } } }, [face, h('span', { class: 'dp-ov-fn', text: p.name })]);
      });
      if (pp.unnamed > 0) {
        faces.push(h('button', { type: 'button', class: 'dp-ov-face is-who', attrs: { title: T('p.pp.who') }, on: { click: function () { if (PL) PL.showPeople(); } } },
          [h('span', { class: 'dp-ov-fc is-who', text: '?' }), h('span', { class: 'dp-ov-fn', text: T('p.pp.who') })]));
      }
      return tile(T('p.pp.people'), moreLink(T('p.ov.all'), function () { if (PL) PL.showPeople(); }), [h('div', { class: 'dp-ov-faces' }, faces)], 'is-people');
    }

    /** The small map: a picture (no map library here), the bubble with the count. */
    function placesTile(pl) {
      var PL = U.PL();
      var NS = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 240 120');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('aria-hidden', 'true');
      [['M0 70c40-15 80 5 120-6s80-20 120-8v64H0z', 'dp-ov-land'], ['M0 30 90 55 240 38M80 120 105 0', 'dp-ov-road']].forEach(function (d) {
        var p = document.createElementNS(NS, 'path');
        p.setAttribute('d', d[0]);
        p.setAttribute('class', d[1]);
        svg.appendChild(p);
      });
      var map = h('button', { type: 'button', class: 'dp-ov-map', attrs: { 'aria-label': T('p.ov.open_map') }, on: { click: function () { if (PL) PL.showMap(); } } },
        [svg, pl.cluster ? h('span', { class: 'dp-ov-bubble', text: num(pl.cluster.count) }) : null]);
      var chips = h('div', { class: 'dp-ov-chips' }, (pl.top || []).map(function (p) {
        return h('button', { type: 'button', class: 'dp-ov-chip', text: p.name + ' · ' + num(p.count), on: { click: function () { if (PL) PL.openPlace(p.key, p.name); } } });
      }));
      return tile(T('p.pp.places'), moreLink(T('p.pp.map_nav'), function () { if (PL) PL.showMap(); }), [map, chips], 'is-places');
    }

    // ── the page ─────────────────────────────────────────

    function render(main, d) {
      clear(main);
      var row1 = [];
      var row2 = [];
      if (d.todo) { var td = todoTile(d.todo); if (td) row1.push(td); }
      if (d.recent && d.recent.length) row1.push(recentTile(d.recent));
      if ((d.activity && d.activity.length) || d.storage) row1.push(activityTile(d.activity, d.storage));
      if (d.memories && d.memories.length) row2.push(memoriesTile(d.memories));
      if (d.people && ((d.people.people || []).length || d.people.unnamed > 0) && has('photoPeople')) row2.push(peopleTile(d.people));
      if (d.places && has('photoPlaces')) row2.push(placesTile(d.places));
      if (!row1.length && !row2.length) { main.appendChild(h('div', { class: 'dp-empty', text: T('p.ov.empty') })); return; }
      if (row1.length) main.appendChild(h('div', { class: 'dp-ov-grid', attrs: { 'data-n': String(row1.length) } }, row1));
      if (row2.length) {
        // the memories twice as wide as the others (2fr 1fr 1fr)
        var cols = row2.map(function (t) { return /is-memories/.test(t.className) && row2.length > 1 ? '2fr' : '1fr'; }).join(' ');
        main.appendChild(h('div', { class: 'dp-ov-grid is-second', attrs: { style: '--dp-ov-cols:' + cols } }, row2));
      }
    }

    /** The page "Übersicht". */
    function show() {
      var main = U.startPage('overview');
      var seq = ++st.seq;
      if (st.data) render(main, st.data);
      else main.appendChild(h('p', { class: 'dp-hint', text: T('p.loading') }));
      return load(seq, main);
    }

    function load(seq, main) {
      st.last = Date.now();
      return api('GET', 'overview').then(function (r) {
        if (seq !== st.seq || S.page !== 'overview') return;
        st.data = r;
        render(main, r);
      }, function (e) {
        if (seq !== st.seq || S.page !== 'overview') return;
        if (!st.data) { clear(main); main.appendChild(h('div', { class: 'dp-empty', text: U.errText(e) })); }
      });
    }

    /** Live: something changed in an area — load again a little later, at most every LIVE_MIN_MS. */
    function changed() {
      if (S.page !== 'overview') { st.data = null; return; }
      if (st.timer) return;
      var wait = Math.max(LIVE_DELAY_MS, st.last + LIVE_MIN_MS - Date.now());
      st.timer = setTimeout(function () {
        st.timer = null;
        if (S.page !== 'overview') return;
        load(++st.seq, U.$('dp-main'));
      }, wait);
    }

    return { show: show, changed: changed };
  }

  window.DriveOverview = { attach: attach };
}());
