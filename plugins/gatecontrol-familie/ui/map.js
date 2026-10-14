/* Positions on an OpenStreetMap map (plugin.json ui.maps): GateControl serves
   its bundled Leaflet at a frame-loadable URL (FA_CTX.leaflet, one constant in
   server/ui.js) and allows the OSM tiles in the frame. When Leaflet does not
   load (older GateControl, blocked, offline) the page still shows every
   position as coordinates with an "OpenStreetMap" link. No marker images
   (the frame allows none): circles only. */
(function () {
  'use strict';
  var A = window.FA, T = A.T, el = A.el;
  var CTX = A.CTX;
  var loading = null;

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
      if (cfg.css) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = cfg.css;
        document.head.appendChild(link);
      }
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

  function fmt(n, d) { return Number(n).toFixed(d == null ? 5 : d); }

  function osmUrl(p) {
    return 'https://www.openstreetmap.org/?mlat=' + fmt(p.lat) + '&mlon=' + fmt(p.lon) + '#map=17/' + fmt(p.lat) + '/' + fmt(p.lon);
  }

  /** A link to openstreetmap.org (GC.openExternal when the host offers it, else a plain new-tab link). */
  function osmLink(p, label) {
    var a = el('a', { href: osmUrl(p), target: '_blank', rel: 'noopener noreferrer', class: 'fa-osm', text: label || T('map.open_osm') });
    a.addEventListener('click', function (e) {
      if (window.GC && typeof window.GC.openExternal === 'function') { e.preventDefault(); window.GC.openExternal(osmUrl(p)); }
    });
    return a;
  }

  /** "52.52000, 13.40500 · ±12 m" */
  function coordText(p) {
    return fmt(p.lat) + ', ' + fmt(p.lon) + (p.accuracy != null ? ' · ±' + Math.round(p.accuracy) + ' m' : '');
  }

  function fallback(box, points) {
    A.clear(box);
    box.classList.add('fa-map-fallback');
    box.appendChild(el('p', { class: 'fa-hint', text: T('map.unavailable') }));
    points.forEach(function (p) {
      box.appendChild(el('div', { class: 'fa-map-row' }, [
        el('span', { class: 'fa-map-dot' }),
        el('div', { class: 'fa-map-main' }, [
          el('div', { class: 'fa-map-label', text: p.label || '' }),
          el('div', { class: 'fa-map-coords', text: coordText(p) + (p.sub ? ' · ' + p.sub : '') }),
        ]),
        osmLink(p),
      ]));
    });
  }

  /**
   * Show points [{ lat, lon, accuracy, label, sub, color }] in `box`.
   * Returns a promise that resolves when drawn (map or fallback).
   */
  function show(box, points) {
    var list = (points || []).filter(function (p) { return p && isFinite(p.lat) && isFinite(p.lon); });
    if (!list.length) { A.clear(box); box.appendChild(el('p', { class: 'fa-empty', text: T('map.none') })); return Promise.resolve(); }
    return load().then(function (L) {
      A.clear(box);
      box.classList.remove('fa-map-fallback');
      var holder = el('div', { class: 'fa-map', role: 'img', 'aria-label': T('map.aria') });
      box.appendChild(holder);
      var map = L.map(holder, { scrollWheelZoom: false, attributionControl: true });
      L.tileLayer(CTX.tiles, {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
        referrerPolicy: 'origin',
      }).addTo(map);
      var bounds = [];
      list.forEach(function (p) {
        var c = A.safeColor(p.color, '#0F766E');
        if (p.accuracy != null && p.accuracy > 0) L.circle([p.lat, p.lon], { radius: p.accuracy, color: c, weight: 1, fillOpacity: 0.12 }).addTo(map);
        var m = L.circleMarker([p.lat, p.lon], { radius: 8, color: '#ffffff', weight: 2, fillColor: c, fillOpacity: 1 }).addTo(map);
        var tip = el('div', null, [el('b', { text: p.label || '' }), el('div', { text: coordText(p) + (p.sub ? ' · ' + p.sub : '') })]);
        m.bindTooltip(tip);
        bounds.push([p.lat, p.lon]);
      });
      if (bounds.length === 1) map.setView(bounds[0], 16); else map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
      // coordinates and links below the map (keyboard / screen readers, "open in OSM")
      var rows = el('div', { class: 'fa-map-list' });
      list.forEach(function (p) {
        rows.appendChild(el('div', { class: 'fa-map-row' }, [
          el('span', { class: 'fa-map-dot', style: '--c:' + A.safeColor(p.color, '#0F766E') }),
          el('div', { class: 'fa-map-main' }, [el('div', { class: 'fa-map-label', text: p.label || '' }), el('div', { class: 'fa-map-coords', text: coordText(p) + (p.sub ? ' · ' + p.sub : '') })]),
          osmLink(p),
        ]));
      });
      box.appendChild(rows);
      setTimeout(function () { try { map.invalidateSize(); } catch (_) { /* gone */ } }, 50);
      return map;
    }).catch(function () { fallback(box, list); });
  }

  window.FA.map = { load: load, show: show, osmLink: osmLink, osmUrl: osmUrl, coordText: coordText };
}());
