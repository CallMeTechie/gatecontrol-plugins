/* The logbook's map (1.6.0): every trip of the shown month on an OpenStreetMap
   map beside the list (plugin.json ui.maps — GateControl serves its bundled
   Leaflet at SK_CTX.leaflet and relays the tiles, window.GC.tiles). Colours by
   purpose, a dashed line for a straight line (kind 'line') or a way not
   computed yet; the same way (start and end within ~150 m, either direction,
   same purpose) is drawn once with its count. A click on a way selects its
   newest trip (onSelect → the list marks it), focus(id) zooms to one trip.
   Without Leaflet (older GateControl, offline) the map says so and the list
   works as before. No marker images (the frame allows none): circles only. */
(function () {
  'use strict';
  var SK = window.SK;
  var T = SK.T, el = SK.el, clear = SK.clear;
  var CTX = SK.CTX;
  var COLORS = { commute: '#0B8A5C', business: '#1A56C4', private: '#B45309', open: '#566274' };
  var FILTERS = ['all', 'commute', 'business', 'private', 'open'];
  var GRID = 0.0015;
  var state = { L: null, map: null, layer: null, box: null, trips: [], filter: 'all', selected: null, onSelect: null, fitted: false };
  var loading = null;

  function tileUrl() {
    var t = window.GC && typeof window.GC.tiles === 'string' ? window.GC.tiles : null;
    return t || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  }

  function load() {
    if (window.L && window.L.map) return Promise.resolve(window.L);
    if (loading) return loading;
    var cfg = CTX.leaflet || {};
    loading = new Promise(function (resolve, reject) {
      if (!cfg.js) { reject(new Error('no leaflet')); return; }
      var done = false;
      var finish = function (ok) {
        if (done) return;
        done = true;
        if (ok && window.L && window.L.map) resolve(window.L); else reject(new Error('leaflet unavailable'));
      };
      if (cfg.css) document.head.appendChild(el('link', { rel: 'stylesheet', href: cfg.css }));
      var s = document.createElement('script');
      s.src = cfg.js;
      s.async = true;
      s.onload = function () { finish(true); };
      s.onerror = function () { finish(false); };
      document.head.appendChild(s);
      setTimeout(function () { finish(!!(window.L && window.L.map)); }, 8000);
    });
    return loading;
  }

  function purposeOf(tr) { return tr.purpose || 'open'; }
  function pointsOf(tr) {
    if (tr.route && tr.route.points && tr.route.points.length > 1) return tr.route.points;
    if (tr.start && tr.end) return [[tr.start.lat, tr.start.lon], [tr.end.lat, tr.end.lon]];
    return null;
  }
  function cell(p) { return Math.round(p.lat / GRID) + ':' + Math.round(p.lon / GRID); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function place(a) { return a ? String(a).split(',')[0] : T('logbook.unknown_place'); }

  /** Trips with a position → ways: one per start/end pair (either direction) and purpose, newest trip first. */
  function groupsOf(trips) {
    var by = {};
    var out = [];
    trips.forEach(function (tr) {
      if (!pointsOf(tr) || !tr.start || !tr.end) return;
      var a = cell(tr.start);
      var b = cell(tr.end);
      var k = (a < b ? a + '|' + b : b + '|' + a) + '|' + purposeOf(tr);
      if (!by[k]) { by[k] = { key: k, trips: [], km: 0 }; out.push(by[k]); }
      by[k].trips.push(tr);
      by[k].km += Number(tr.distanceKm) || 0;
    });
    return out;
  }

  function visible() {
    return state.trips.filter(function (tr) { return state.filter === 'all' || purposeOf(tr) === state.filter; });
  }

  function popupOf(g) {
    var tr = g.trips[0];
    var kind = tr.route ? (tr.route.kind === 'road' ? T('logbook.map_road') : T('logbook.map_line')) : T('logbook.map_pending');
    var rows = [
      el('b', { text: T('logbook.route_group', { from: place(tr.startAddress), to: place(tr.endAddress) }) }),
      el('span', { text: g.trips.length > 1
        ? T('logbook.group_trips', { n: g.trips.length, km: SK.fmtNum(g.km) + ' km' })
        : tr.dateLabel + ' · ' + tr.startTime + '–' + tr.endTime + ' · ' + SK.fmtNum(tr.distanceKm) + ' km' }),
      el('span', { class: 'muted', text: T(tr.purpose ? 'logbook.purpose_' + tr.purpose : 'logbook.purpose_open') + ' · ' + kind }),
    ];
    return el('div', { class: 'lb-pop' }, rows);
  }

  function draw() {
    var L = state.L;
    if (!L || !state.map) return;
    state.layer.clearLayers();
    var bounds = [];
    var groups = groupsOf(visible());
    // the selected way last, so it lies on top
    groups.sort(function (a, b) { return (sel(a) ? 1 : 0) - (sel(b) ? 1 : 0); });
    groups.forEach(function (g) {
      var tr = g.trips[0];
      var pts = pointsOf(tr);
      var color = COLORS[purposeOf(tr)];
      var straight = !tr.route || tr.route.kind !== 'road';
      var on = sel(g);
      var dim = state.selected != null && !on;
      L.polyline(pts, { color: '#ffffff', weight: on ? 11 : 8, opacity: dim ? 0.5 : 0.9, interactive: false }).addTo(state.layer);
      var line = L.polyline(pts, {
        color: color, weight: on ? 7 : (g.trips.length > 1 ? 6 : 4), opacity: dim ? 0.45 : 1,
        dashArray: straight ? '2 9' : null, lineCap: 'round', lineJoin: 'round',
      }).addTo(state.layer);
      line.on('click', function () { select(tr.id, true); });
      line.bindPopup(function () { return popupOf(g); });
      [pts[0], pts[pts.length - 1]].forEach(function (p) {
        L.circleMarker(p, { radius: 5, color: color, weight: 3, fillColor: '#ffffff', fillOpacity: 1, opacity: dim ? 0.5 : 1, interactive: false }).addTo(state.layer);
      });
      if (g.trips.length > 1) {
        var mid = pts[Math.floor(pts.length / 2)];
        // the badge is a span inside the marker (Leaflet positions the marker itself with a transform);
        // its element exists only once the map has a view, so the text goes into the icon's html
        var label = esc(T('logbook.times_n', { n: g.trips.length }));
        L.marker(mid, { interactive: false, keyboard: false, icon: L.divIcon({ className: 'lb-count', html: '<span data-p="' + purposeOf(tr) + '">' + label + '</span>', iconSize: null }) }).addTo(state.layer);
      }
      pts.forEach(function (p) { bounds.push(p); });
      if (on) line.openPopup();
    });
    if (!state.fitted && bounds.length) { state.map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 }); state.fitted = true; }
    renderFilters();
  }

  function sel(g) { return state.selected != null && g.trips.some(function (x) { return x.id === state.selected; }); }

  function select(id, fromMap) {
    state.selected = id;
    draw();
    if (fromMap && state.onSelect) state.onSelect(id);
  }

  /** Zoom to one trip and mark it (the list's "On the map"). */
  function focus(id) {
    var tr = state.trips.filter(function (x) { return x.id === id; })[0];
    var pts = tr && pointsOf(tr);
    if (!pts || !state.map) return;
    if (state.filter !== 'all' && purposeOf(tr) !== state.filter) state.filter = 'all';
    state.selected = id;
    state.map.fitBounds(pts, { padding: [36, 36], maxZoom: 16 });
    draw();
    if (state.box && state.box.scrollIntoView && window.matchMedia && window.matchMedia('(max-width: 999px)').matches) state.box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function renderFilters() {
    var bar = state.box && state.box.querySelector('.lb-map-filters');
    if (!bar) return;
    clear(bar);
    FILTERS.forEach(function (f) {
      var label = f === 'all' ? T('logbook.filter_all') : T('logbook.purpose_' + f);
      bar.appendChild(el('button', {
        type: 'button', class: 'lb-chip', 'aria-pressed': String(state.filter === f),
        on: { click: function () { state.filter = f; state.selected = null; state.fitted = false; draw(); } },
      }, [f === 'all' ? null : el('span', { class: 'lb-dot', 'data-p': f, 'aria-hidden': 'true' }), label]));
    });
  }

  /**
   * Show the trips of the month on the map in box (the page's map panel).
   * @param {HTMLElement} box   holds .lb-map-filters, .lb-map and .lb-map-msg
   * @param {object[]} trips    the logbook answer's trips (start / end / route)
   * @param {{onSelect?: function(number)}} opts
   */
  function show(box, trips, opts) {
    state.box = box;
    state.trips = trips || [];
    state.onSelect = opts && opts.onSelect;
    state.selected = null;
    state.fitted = false;
    var msg = box.querySelector('.lb-map-msg');
    var any = state.trips.some(function (tr) { return tr.start && tr.end; });
    box.hidden = !any;
    if (!any) return;
    load().then(function (L) {
      state.L = L;
      if (!state.map) {
        state.map = L.map(box.querySelector('.lb-map'), { scrollWheelZoom: false, attributionControl: true });
        L.tileLayer(tileUrl(), { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(state.map);
        state.layer = L.layerGroup().addTo(state.map);
      }
      msg.hidden = true;
      setTimeout(function () { state.map.invalidateSize(); draw(); }, 0);
    }, function () {
      msg.hidden = false;
      msg.textContent = T('logbook.map_unavailable');
    });
  }

  SK.lbMap = { show: show, focus: focus, groupsOf: groupsOf };
}());
