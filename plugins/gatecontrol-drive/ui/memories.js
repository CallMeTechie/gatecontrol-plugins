/* Drive (gatecontrol-drive) — the page „Erinnerungen“ of the portal (since 1.26.0, feature `memoryCollections`): the
 * overview's „Alle“ and its cards open it. One request (GET memories) for the collections of the person's private
 * photos, each a card with its cover — in the order of the server:
 *
 *   „Heute vor X Jahren“ · „Ausflüge und Reisen“ · „Mit <Person>“ · „Diesen Monat vor X Jahren“ · „Jahresrückblick“ ·
 *   „Orte“
 *
 * textOf() names a collection here and on the overview's cards of memoryPicks (since 1.28.0, portal.js memoryTitle).
 * A card opens its photos (GET memories/photos?id=, page by page) as tiles of „Fotos“ — a click shows them in the viewer
 * and goes through them. portal.js calls DriveMemories.attach(ui) with its helpers. Server and user text only ever goes
 * into textContent or attributes.
 */
(function () {
  'use strict';

  var PAGE = 120;
  var KINDS = ['day', 'trip', 'person', 'month', 'year', 'place'];

  function attach(U) {
    var T = U.T;
    var P = U.P;
    var h = U.h;
    var api = U.api;
    var clear = U.clear;
    var st = { seq: 0, data: null, cur: null, items: [], next: null };

    function num(n) { return Number(n || 0).toLocaleString(U.LOCALE); }
    function dateOf(key) {
      var p = String(key || '').split('-').map(Number);
      return new Date(p[0], (p[1] || 1) - 1, p[2] || 1);
    }
    function monthYear(key) { var d = dateOf(key); return isNaN(d.getTime()) ? String(key) : d.toLocaleDateString(U.LOCALE, { month: 'long', year: 'numeric' }); }
    function fullDate(key) { var d = dateOf(key); return isNaN(d.getTime()) ? String(key) : d.toLocaleDateString(U.LOCALE, { day: 'numeric', month: 'long', year: 'numeric' }); }

    /** The title and the line below of a collection. */
    function textOf(c) {
      var n = P('p.photos_n', c.count);
      if (c.kind === 'day') return { title: P('p.ov.today_years', c.yearsAgo), sub: fullDate(c.date) + ' · ' + n };
      if (c.kind === 'trip') {
        var where = (c.places && c.places.length ? c.places : [c.place ? c.place.name : '']).filter(Boolean).join(', ');
        return { title: where || T('p.mem.trip'), sub: [P('p.mem.days', c.days), monthYear(c.firstDay), n].join(' · ') };
      }
      if (c.kind === 'person') return { title: T('p.mem.with', { name: c.person ? c.person.name : '' }), sub: n };
      if (c.kind === 'month') return { title: P('p.mem.month_years', c.yearsAgo), sub: monthYear(c.month + '-01') + ' · ' + n };
      if (c.kind === 'year') return { title: T('p.mem.year', { year: String(c.year) }), sub: n };
      return { title: c.place ? c.place.name : '', sub: n };
    }

    function card(c) {
      var tx = textOf(c);
      var src = c.cover && (c.cover.largeUrl || c.cover.previewUrl);
      return h('button', { type: 'button', class: 'dp-ov-mem dp-mem-card', attrs: { 'aria-label': tx.title + ' · ' + tx.sub, 'data-memory': c.id }, on: { click: function () { open(c); } } }, [
        src ? h('img', { attrs: { src: src, alt: '', loading: 'lazy' } }) : null,
        h('span', { class: 'dp-ov-memtx' }, [h('b', { text: tx.title }), h('span', { text: tx.sub })]),
      ]);
    }

    function render(main, d) {
      clear(main);
      var list = d.collections || [];
      if (!list.length) { main.appendChild(h('div', { class: 'dp-empty', text: T('p.mem.none') })); return; }
      main.appendChild(h('p', { class: 'dp-hint dp-mem-note', text: T('p.mem.private') }));
      KINDS.forEach(function (k) {
        var of = list.filter(function (c) { return c.kind === k; });
        if (!of.length) return;
        main.appendChild(h('section', { class: 'dp-mem-sec', attrs: { 'aria-label': T('p.mem.sec_' + k) } }, [
          h('h2', { class: 'dp-month' }, [h('span', { text: T('p.mem.sec_' + k) }), h('span', { class: 'dp-meta', text: num(of.length) })]),
          h('div', { class: 'dp-mem-cards' }, of.map(card)),
        ]));
      });
    }

    /** The page „Erinnerungen“. */
    function show() {
      var main = U.startPage('memories');
      var seq = ++st.seq;
      st.cur = null;
      if (st.data) render(main, st.data);
      else main.appendChild(h('p', { class: 'dp-hint', text: T('p.loading') }));
      return api('GET', 'memories').then(function (r) {
        if (seq !== st.seq || U.S.page !== 'memories') return;
        st.data = r;
        render(main, r);
      }, function (e) {
        if (seq !== st.seq || U.S.page !== 'memories') return;
        clear(main);
        main.appendChild(h('div', { class: 'dp-empty', text: U.errText(e) }));
      });
    }

    function renderPhotos(main) {
      clear(main);
      var tx = textOf(st.cur);
      main.appendChild(h('div', { class: 'dp-mem-head' }, [h('h2', { class: 'dp-h2', text: tx.title }), h('span', { class: 'dp-meta', text: tx.sub })]));
      if (!st.items.length) { main.appendChild(h('div', { class: 'dp-empty', text: T('p.mem.empty') })); return; }
      // the viewer goes through the photos shown (as on „Fotos“)
      U.PH.items = st.items;
      U.PH.select = false;
      U.PH.chosen = {};
      main.appendChild(h('div', { class: 'dp-phs' }, st.items.map(function (x) { return U.photoTile(x); })));
      if (st.next) main.appendChild(h('div', { class: 'dp-more-row' }, U.btn(T('p.more'), more)));
    }

    function load(seq, before) {
      return api('GET', 'memories/photos', null, { id: st.cur.id, limit: PAGE, before: before || null }).then(function (r) {
        if (seq !== st.seq || U.S.page !== 'memory') return;
        st.items = st.items.concat(r.items || []);
        st.next = r.next || null;
        renderPhotos(U.$('dp-main'));
      }, function (e) {
        if (seq !== st.seq || U.S.page !== 'memory') return;
        U.fail(e);
      });
    }

    /** One collection: its photos as tiles (`c` a collection of GET memories, or { id, kind, … } of the overview). */
    function open(c) {
      st.cur = c;
      st.items = [];
      st.next = null;
      var main = U.startPage('memory');
      var seq = ++st.seq;
      main.appendChild(h('p', { class: 'dp-hint', text: T('p.loading') }));
      return load(seq, null);
    }

    function more() { load(st.seq, st.next); }

    /** The path above: „Erinnerungen“ (› the collection) — true when it is one of these pages. */
    function crumbs(box) {
      if (U.S.page !== 'memories' && U.S.page !== 'memory') return false;
      var inOne = U.S.page === 'memory' && st.cur;
      box.appendChild(h('button', { type: 'button', text: T('p.ov.memories'), attrs: { 'aria-current': inOne ? null : 'page' }, on: { click: inOne ? show : null } }));
      if (inOne) {
        box.appendChild(h('span', { class: 'dp-sep', text: '›', attrs: { 'aria-hidden': 'true' } }));
        box.appendChild(h('button', { type: 'button', text: textOf(st.cur).title, attrs: { 'aria-current': 'page' } }));
      }
      return true;
    }

    /** Live: photos changed — the collections are loaded again the next time. */
    function changed() { st.data = null; }

    return { show: show, open: open, crumbs: crumbs, changed: changed, textOf: textOf };
  }

  window.DriveMemories = { attach: attach };
}());
