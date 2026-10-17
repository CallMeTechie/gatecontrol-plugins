/* Positions on an OpenStreetMap map (plugin.json ui.maps): GateControl serves
   its bundled Leaflet at a frame-loadable URL (FA_CTX.leaflet, one constant in
   server/ui.js) and allows the OSM tiles in the frame. When Leaflet does not
   load (older GateControl, blocked, offline) the page still shows every
   position as coordinates with an "OpenStreetMap" link. No marker images
   (the frame allows none): circles only.
   1.5.0: pick() — choose a position (a rule place): tap the map or drag the
   point, the radius drawn as a circle; the point is a styled div (no image). */
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

  var GERMANY = { lat: 51.16, lon: 10.45 };

  /**
   * A map to choose a position in `box` (1.5.0): o = { lat, lon (null = none yet), radius (m),
   * center: { lat, lon } | null (where to look without a position), color, onPick(lat, lon) }.
   * Resolves { set(lat, lon), radius(m), fit(), invalidate() } — or null when Leaflet does not load
   * (the caller keeps its coordinate fields).
   */
  function pick(box, o) {
    return load().then(function (L) {
      A.clear(box);
      var holder = el('div', { class: 'fa-map fa-map-pick', role: 'application', 'aria-label': T('map.pick_aria') });
      box.appendChild(holder);
      var map = L.map(holder, { scrollWheelZoom: false, attributionControl: true });
      L.tileLayer(CTX.tiles, {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
        referrerPolicy: 'origin',
      }).addTo(map);
      var color = A.safeColor(o.color, '#0F766E');
      var pos = o.lat != null && o.lon != null ? { lat: o.lat, lon: o.lon } : null;
      var radius = o.radius || 200;
      var marker = null, circle = null;
      function draw() {
        if (!pos) return;
        var ll = [pos.lat, pos.lon];
        if (!marker) {
          circle = L.circle(ll, { radius: radius, color: color, weight: 2, fillColor: color, fillOpacity: 0.14, interactive: false }).addTo(map);
          marker = L.marker(ll, { draggable: true, keyboard: true, title: T('map.pick_point'), alt: T('map.pick_point'),
            icon: L.divIcon({ className: 'fa-pin', html: '', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(map);
          marker.on('drag', function (e) { var p = e.target.getLatLng(); pos = { lat: p.lat, lon: p.lng }; circle.setLatLng(p); });
          marker.on('dragend', function () { o.onPick(pos.lat, pos.lon); });
        } else { marker.setLatLng(ll); circle.setLatLng(ll); }
        circle.setRadius(radius);
      }
      // the circle with some room around it (computed from the position: no projection needed)
      function fit() {
        if (pos) map.fitBounds(L.latLng(pos.lat, pos.lon).toBounds(radius * 2), { padding: [28, 28], maxZoom: 17, animate: false });
      }
      map.on('click', function (e) { pos = { lat: e.latlng.lat, lon: e.latlng.lng }; draw(); o.onPick(pos.lat, pos.lon); });
      // a view first, then the layers
      var start = pos || o.center || GERMANY;
      map.setView([start.lat, start.lon], pos ? 16 : (o.center ? 14 : 6));
      if (pos) { draw(); fit(); }
      setTimeout(function () { try { map.invalidateSize(); if (pos) fit(); } catch (_) { /* gone */ } }, 60);
      return {
        set: function (lat, lon) { pos = { lat: lat, lon: lon }; draw(); fit(); },
        radius: function (r) { radius = r; if (circle) circle.setRadius(r); },
        fit: fit,
        invalidate: function () { try { map.invalidateSize(); } catch (_) { /* gone */ } },
      };
    }).catch(function () { return null; });
  }

  window.FA.map = { load: load, show: show, pick: pick, osmLink: osmLink, osmUrl: osmUrl, coordText: coordText, GERMANY: GERMANY };
}());
