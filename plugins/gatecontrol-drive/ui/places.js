/* Drive (gatecontrol-drive) — places and people in the portal (since 1.16.0, mockups "Orte und Personen": Portal,
 * Karte, Ort, Personen, Person, Benennen, Einstellungen). Only while GET me features say so:
 *
 *   photoPlaces / photoPeople  on "Fotos" the search with marks: a person and a place are chips in the field ("Mama ×",
 *                     "Hamburg ×"), the suggestions while typing (GET photos/suggest — people, places, what is on them);
 *                     with a mark the result by day with its district, "N Fotos mit Mama in Hamburg", "Auch mit Lea · 64",
 *                     "Als Album speichern", and beside it the map of the place with its districts
 *   photoPlaces       "Karte" (OpenStreetMap through GateControl — ui.maps, the host's Leaflet; GeoNames named under the
 *                     map, CC BY 4.0): the photos as clusters with their count (GET photos/map on every move), a cluster of
 *                     one place shows its photos and "Alle ansehen"; below the places by count
 *   photoPeople       "Personen": the progress, the people with a name, "Wer ist das?" (the ones without), the hidden ones;
 *                     a person: "Ist das auch …?" (the unsure faces: "Ja, alle", "Einzeln prüfen"), "Zusammen mit", the
 *                     places, the photos by year, the menu (rename, link with a family member, merge, hide); "Wer ist das?"
 *                     with the name, suggestions of the family, "Sieht aus wie …" (merge), "Ausblenden", then "Rückgängig"
 *   both              the Drive settings: "Orte und Personen" (keep places, delete the places of my photos, recognise
 *                     people — off deletes every face after asking —, the children's folders, "Alle Gesichtsdaten
 *                     löschen")
 *
 * A face is cut out by the browser: the photo's preview in a round box, scaled and moved by the face's box once the
 * picture is loaded. portal.js calls DrivePlaces.attach(ui) with its helpers. Server and user text only ever goes into
 * textContent or attributes.
 */
(function () {
  'use strict';

  var LEAFLET_WAIT_MS = 8000;
  var SUGGEST_DELAY_MS = 200;
  var UNNAMED_SHOWN = 6;

  function attach(U) {
    var T = U.T;
    var P = U.P;
    var h = U.h;
    var icon = U.icon;
    var btn = U.btn;
    var api = U.api;
    var S = U.S;
    var PH = U.PH;
    var has = U.has;
    var clear = U.clear;
    var fail = U.fail;
    var CTX = U.CTX;
    var st = { people: null, person: null, seq: 0, map: null, mapTimer: null, settings: null, done: null };

    var places = function () { return has('photoPlaces'); };
    var people = function () { return has('photoPeople'); };

    // ── small things ─────────────────────────────────────

    function initials(name) {
      var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return '?';
      return (parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : '')).toUpperCase();
    }
    function num(n) { return Number(n || 0).toLocaleString(U.LOCALE); }
    function dayLabel(iso) {
      var d = new Date(iso);
      return isNaN(d.getTime()) ? '' : d.toLocaleDateString(U.LOCALE, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
    }
    function dayKey(iso) {
      var d = new Date(iso);
      return isNaN(d.getTime()) ? '' : d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    }
    function years(y) {
      if (!y || y.from == null) return '';
      return y.from === y.to ? String(y.from) : y.from + ' – ' + y.to;
    }
    function country(cc) {
      try { return new Intl.DisplayNames([CTX.lang === 'en' ? 'en' : 'de'], { type: 'region' }).of(cc) || cc; } catch (e) { return cc; }
    }

    /**
     * A face cut out of its photo: a round box of `size` px with the preview inside, scaled so that the face (box: x, y,
     * w, h of the upright picture, 0 … 1) fills it with a margin. The larger preview for a small face.
     */
    function faceCrop(item, box, size, o) {
      var x = o || {};
      var s = size || 56;
      var wrap = h('span', { class: 'dp-pp-face' + (x.cls ? ' ' + x.cls : ''), attrs: { style: 'width:' + s + 'px;height:' + s + 'px', 'aria-hidden': x.label ? null : 'true', role: x.label ? 'img' : null, 'aria-label': x.label || null } });
      var src = item && (box && box[2] < 0.25 && item.largeUrl ? item.largeUrl : item.previewUrl || item.largeUrl);
      if (!src || !box) {
        wrap.appendChild(h('span', { class: 'dp-pp-ini', text: x.name ? initials(x.name) : '' }, x.name ? null : icon('person', Math.round(s / 2))));
        return wrap;
      }
      var img = h('img', { attrs: { src: src, alt: '', loading: 'lazy', style: 'opacity:0' } });
      img.addEventListener('load', function () {
        var W = img.naturalWidth || 1;
        var H = img.naturalHeight || 1;
        var side = Math.max(box[2] * W, box[3] * H) * 1.5;
        var k = s / side;
        var cx = (box[0] + box[2] / 2) * W;
        var cy = (box[1] + box[3] / 2) * H;
        img.setAttribute('style', 'position:absolute;max-width:none;width:' + (W * k) + 'px;height:' + (H * k) + 'px;left:' + (s / 2 - cx * k) + 'px;top:' + (s / 2 - cy * k) + 'px');
      });
      img.addEventListener('error', function () { if (img.parentNode) img.parentNode.replaceChild(h('span', { class: 'dp-pp-ini' }, icon('person', Math.round(s / 2))), img); });
      wrap.appendChild(img);
      return wrap;
    }
    /** A person's round face (the cover), else the initials. */
    function personFace(p, size) {
      return faceCrop(p.cover && p.cover.item, p.cover && p.cover.box, size, { name: p.name || '' });
    }

    // ── the search with marks (on "Fotos") ─────────────────

    /** Are marks set (a person or a place)? Then the result is drawn here. */
    function active() { return !!((PH.people && PH.people.length) || PH.place); }

    /** The query's own parameters: person=, place=, districts, with=people. */
    function query(q) {
      if (PH.people && PH.people.length && people()) q.person = PH.people.map(function (p) { return p.id; }).join(',');
      if (PH.place && places()) { q.place = PH.place.key; q.districts = 1; }
      if (people() && active()) q['with'] = 'people';
      return q;
    }

    function setMarks(list, place) {
      PH.people = list || [];
      PH.place = place || null;
    }

    /** The search field with the marks and the suggestions. */
    function searchBox() {
      var input = h('input', { class: 'dp-pp-in dp-k-phq', type: 'search', value: PH.q || '', placeholder: T(active() ? 'p.pp.narrow' : 'p.pp.search'),
        attrs: { 'aria-label': T('p.pp.search_label'), autocomplete: 'off', 'aria-autocomplete': 'list', 'aria-expanded': 'false' } });
      var list = h('div', { class: 'dp-pp-sug', attrs: { role: 'listbox', 'aria-label': T('p.pp.suggestions') }, hidden: true });
      var timer = null;
      var seq = 0;
      var go = function () { U.showPhotos(true); };
      var token = function (label, ic, onX, cls) {
        return h('span', { class: 'dp-pp-tok' + (cls ? ' ' + cls : '') }, [ic, h('span', { text: label }),
          h('button', { type: 'button', class: 'dp-pp-tx', attrs: { 'aria-label': T('p.pp.remove', { name: label }) }, on: { click: onX } }, icon('close', 12))]);
      };
      var marks = [];
      (PH.people || []).forEach(function (p) {
        marks.push(token(p.name, h('span', { class: 'dp-pp-dot', text: initials(p.name) }), function () { PH.people = PH.people.filter(function (x) { return x.id !== p.id; }); go(); }, 'is-person'));
      });
      if (PH.place) marks.push(token(PH.place.name, icon('pin', 13), function () { PH.place = null; go(); }, 'is-place'));
      var hide = function () { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
      var pick = function (fn) { return function () { hide(); input.value = ''; fn(); PH.q = ''; go(); }; };
      var row = function (lead, title, sub, count, fn) {
        return h('button', { type: 'button', class: 'dp-pp-sugrow', attrs: { role: 'option' }, on: { click: fn } }, [lead,
          h('span', { class: 'dp-pp-sugtx' }, [h('span', { class: 'dp-name', text: title }), sub ? h('span', { class: 'dp-meta', text: sub }) : null]),
          count != null ? h('span', { class: 'dp-meta', text: num(count) }) : null]);
      };
      var suggest = function () {
        var text = input.value.trim();
        var mine = ++seq;
        if (text.length < 2) { hide(); return; }
        api('GET', 'photos/suggest', null, { q: text, area: PH.area || null }).then(function (r) {
          if (mine !== seq) return;
          clear(list);
          var rows = [];
          (r.people || []).forEach(function (p) {
            if ((PH.people || []).some(function (x) { return x.id === p.id; })) return;
            rows.push(row(h('span', { class: 'dp-pp-dot', text: initials(p.name) }), p.name, T('p.pp.sug_person'), p.count, pick(function () { PH.people = (PH.people || []).concat([{ id: p.id, name: p.name }]); })));
          });
          (r.places || []).forEach(function (p) {
            rows.push(row(h('span', { class: 'dp-pp-dot is-place' }, icon('pin', 13)), p.name, p.sub, p.count, pick(function () { PH.place = { key: p.key, name: p.name }; })));
          });
          (r.labels || []).forEach(function (l) {
            rows.push(row(h('span', { class: 'dp-pp-dot is-label' }, icon('spark', 13)), l.text, T('p.pp.sug_label'), l.count, pick(function () { PH.q = l.text; })));
          });
          if (!rows.length) { hide(); return; }
          rows.forEach(function (x) { list.appendChild(x); });
          list.hidden = false;
          input.setAttribute('aria-expanded', 'true');
        }, function () { hide(); });
      };
      input.addEventListener('input', function () { if (timer) clearTimeout(timer); timer = setTimeout(suggest, SUGGEST_DELAY_MS); });
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { hide(); PH.q = input.value.trim(); go(); }
        else if (ev.key === 'Escape') hide();
        else if (ev.key === 'Backspace' && !input.value) {
          if (PH.place) { PH.place = null; go(); } else if (PH.people && PH.people.length) { PH.people = PH.people.slice(0, -1); go(); }
        }
      });
      input.addEventListener('search', function () { if (!input.value.trim() && PH.q) { PH.q = ''; go(); } });
      return h('div', { class: 'dp-pp-search' }, [h('label', { class: 'dp-pp-field' }, [icon('search', 16)].concat(marks).concat([input])), list]);
    }

    /** "120 Fotos mit Mama und Lea in Hamburg" */
    function resultText(n) {
      var who = (PH.people || []).map(function (p) { return p.name; });
      var whoText = who.length ? who.slice(0, -1).join(', ') + (who.length > 1 ? ' ' + T('p.pp.and') + ' ' : '') + who[who.length - 1] : '';
      var key = 'p.pp.result' + (who.length ? '_who' : '') + (PH.place ? '_where' : '');
      return P(key, n, { who: whoText, where: PH.place ? PH.place.name : '' });
    }

    /** The result with marks: summary, chips, the days with their district — and beside it the place's map. */
    function renderResult(main, items, months, districts) {
      var total = 0;
      Object.keys(months || {}).forEach(function (k) { total += months[k]; });
      var col = h('div', { class: 'dp-pp-col' });
      // "Auch mit …": the people on the photos shown, not chosen yet
      var also = {};
      items.forEach(function (x) { (x.people || []).forEach(function (id) { also[id] = (also[id] || 0) + 1; }); });
      var chosen = (PH.people || []).map(function (p) { return p.id; });
      var names = st.names || {};
      var alsoList = Object.keys(also).map(Number).filter(function (id) { return chosen.indexOf(id) < 0 && names[id]; })
        .sort(function (a, b) { return also[b] - also[a]; }).slice(0, 2);
      col.appendChild(h('div', { class: 'dp-pp-sum' }, [h('span', { class: 'dp-pp-total', text: resultText(total) }), h('span', { class: 'dp-ph-grow' }),
        h('span', { class: 'dp-chips' }, alsoList.map(function (id) {
          return h('button', { type: 'button', text: T('p.pp.also_with', { name: names[id], count: num(also[id]) }), on: { click: function () { PH.people = (PH.people || []).concat([{ id: id, name: names[id] }]); U.showPhotos(true); } } });
        }).concat(items.length ? [h('button', { type: 'button', text: T('p.pp.save_album'), on: { click: function () { U.addToAlbum(items.map(function (x) { return x.id; })); } } })] : []))]));
      if (!items.length) col.appendChild(h('div', { class: 'dp-empty', text: T('p.pp.none') }));
      // by day, with the district most of the day's photos are in
      var days = [];
      items.forEach(function (x) {
        var k = dayKey(x.takenAt);
        if (!days.length || days[days.length - 1].key !== k) days.push({ key: k, iso: x.takenAt, items: [] });
        days[days.length - 1].items.push(x);
      });
      days.forEach(function (d) {
        var by = {};
        d.items.forEach(function (x) { var dn = x.geo && x.geo.place && (PH.place ? x.geo.place.district : x.geo.place.name); if (dn) by[dn] = (by[dn] || 0) + 1; });
        var top = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; })[0];
        col.appendChild(h('h2', { class: 'dp-month' }, [h('span', { text: dayLabel(d.iso) }), h('span', { class: 'dp-meta', text: (top ? top + ' · ' : '') + num(d.items.length) })]));
        col.appendChild(h('div', { class: 'dp-phs' }, d.items.map(function (x) { return U.photoTile(x); })));
      });
      if (PH.next) col.appendChild(h('div', { class: 'dp-more-row' }, btn(T('p.more'), function () { U.morePhotos(); })));
      if (!PH.place || !places()) { main.appendChild(col); return; }
      // beside it: the map of the place, its districts
      var mapBox = h('div', { class: 'dp-pp-minimap' });
      var aside = h('aside', { class: 'dp-pp-aside', attrs: { 'aria-label': PH.place.name } }, [mapBox]);
      if (districts && districts.length) {
        aside.appendChild(h('span', { class: 'dp-label', text: T('p.pp.districts') }));
        aside.appendChild(h('div', { class: 'dp-pp-dists' }, districts.map(function (d) { return h('div', { class: 'dp-pp-dist' }, [h('span', { text: d.name }), h('span', { class: 'dp-meta', text: num(d.count) })]); })));
      }
      aside.appendChild(h('p', { class: 'dp-hint', text: T('p.pp.combine') }));
      aside.appendChild(attribution());
      main.appendChild(h('div', { class: 'dp-pp-res' }, [col, aside]));
      var points = items.filter(function (x) { return x.geo; }).map(function (x) { return [x.geo.lat, x.geo.lon]; });
      drawMini(mapBox, points);
    }

    // ── maps (ui.maps: the host's Leaflet, OpenStreetMap through GateControl) ──

    var loading = null;
    function leaflet() {
      if (window.L && window.L.map) return Promise.resolve(window.L);
      if (loading) return loading;
      var cfg = CTX.leaflet || {};
      loading = new Promise(function (resolve, reject) {
        if (!cfg.js) { reject(new Error('no leaflet')); return; }
        var done = false;
        var finish = function (ok) { if (done) return; done = true; if (ok && window.L && window.L.map) resolve(window.L); else { loading = null; reject(new Error('leaflet unavailable')); } };
        var head = document.head || document.body;
        if (cfg.css) head.appendChild(h('link', { attrs: { rel: 'stylesheet', href: cfg.css } }));
        var s = document.createElement('script');
        s.src = cfg.js;
        s.async = true;
        s.onload = function () { finish(true); };
        s.onerror = function () { finish(false); };
        head.appendChild(s);
        setTimeout(function () { finish(!!(window.L && window.L.map)); }, LEAFLET_WAIT_MS);
      });
      return loading;
    }
    /** The tiles: GateControl's relay (window.GC.tiles — the frame sends no Referer), else OpenStreetMap directly. */
    function tiles(L, map) {
      var t = window.GC && typeof window.GC.tiles === 'string' ? window.GC.tiles : CTX.tiles;
      L.tileLayer(t, { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · <a href="https://www.geonames.org" target="_blank" rel="noopener">GeoNames</a> (CC BY 4.0)', referrerPolicy: 'origin' }).addTo(map);
    }
    function attribution() {
      return h('p', { class: 'dp-hint dp-pp-attr', text: T('p.pp.attribution') });
    }

    function drawMini(box, points) {
      if (!points.length) { box.appendChild(h('p', { class: 'dp-hint', text: T('p.pp.no_points') })); return; }
      box.appendChild(h('p', { class: 'dp-hint', text: T('p.loading') }));
      leaflet().then(function (L) {
        clear(box);
        var holder = h('div', { class: 'dp-pp-mapc', attrs: { role: 'img', 'aria-label': T('p.pp.map') } });
        box.appendChild(holder);
        var map = L.map(holder, { scrollWheelZoom: false, attributionControl: true, zoomControl: false });
        tiles(L, map);
        points.slice(0, 300).forEach(function (p) { L.circleMarker(p, { radius: 6, color: '#ffffff', weight: 2, fillColor: '#3DDC97', fillOpacity: 1 }).addTo(map); });
        if (points.length === 1) map.setView(points[0], 14); else map.fitBounds(points, { padding: [20, 20], maxZoom: 15 });
      }, function () { clear(box); box.appendChild(h('p', { class: 'dp-hint', text: T('p.pp.map_off') })); });
    }

    // ── "Karte" ───────────────────────────────────────────

    function showMap() {
      var main = U.startPage('map');
      var seq = ++st.seq;
      var box = h('div', { class: 'dp-pp-map' });
      var panel = h('div', { class: 'dp-pp-panel', hidden: true, attrs: { 'aria-live': 'polite' } });
      var list = h('div', { class: 'dp-pp-places' }, h('p', { class: 'dp-hint', text: T('p.loading') }));
      main.appendChild(h('div', { class: 'dp-pp-maphead' }, [h('h2', { class: 'dp-h2', text: T('p.pp.map_title') }), h('span', { class: 'dp-meta', text: T('p.pp.map_hint') })]));
      main.appendChild(box);
      main.appendChild(panel);
      main.appendChild(attribution());
      main.appendChild(h('h2', { class: 'dp-h2 dp-pp-h', text: T('p.pp.places') }));
      main.appendChild(list);
      api('GET', 'photos/places').then(function (r) {
        if (seq !== st.seq) return;
        clear(list);
        var all = r.places || [];
        if (!all.length) { list.appendChild(h('div', { class: 'dp-empty', text: T('p.pp.places_none') })); return; }
        all.slice(0, 60).forEach(function (p) {
          list.appendChild(h('button', { type: 'button', class: 'dp-pp-place', on: { click: function () { openPlace(p.key, p.name); } } }, [
            h('span', { class: 'dp-pp-pthumb' }, p.cover && p.cover.previewUrl ? h('img', { attrs: { src: p.cover.previewUrl, alt: '', loading: 'lazy' } }) : icon('pin', 20)),
            h('span', { class: 'dp-pp-sugtx' }, [h('span', { class: 'dp-name', text: p.name }), h('span', { class: 'dp-meta', text: [p.region, country(p.country)].filter(Boolean).join(', ') })]),
            h('span', { class: 'dp-meta', text: P('p.photos_n', p.count) }),
          ]));
        });
      }, function (e) { clear(list); fail(e); });
      box.appendChild(h('p', { class: 'dp-hint', text: T('p.loading') }));
      leaflet().then(function (L) {
        if (seq !== st.seq) return;
        clear(box);
        var holder = h('div', { class: 'dp-pp-mapc is-big', attrs: { role: 'region', 'aria-label': T('p.pp.map') } });
        box.appendChild(holder);
        var map = L.map(holder, { worldCopyJump: true });
        tiles(L, map);
        map.setView([51, 10], 5);
        var layer = L.layerGroup().addTo(map);
        var load = function () {
          var b = map.getBounds();
          var bbox = [b.getWest(), Math.max(-85, b.getSouth()), b.getEast(), Math.min(85, b.getNorth())].map(function (v) { return Math.round(v * 1e5) / 1e5; }).join(',');
          api('GET', 'photos/map', null, { bbox: bbox, zoom: Math.max(0, Math.min(19, Math.round(map.getZoom()))) }).then(function (r) {
            if (seq !== st.seq) return;
            layer.clearLayers();
            (r.clusters || []).forEach(function (c) {
              var el = h('span', { class: 'dp-pp-cl', text: c.count > 999 ? Math.round(c.count / 100) / 10 + 'k' : String(c.count) });
              var m = L.marker([c.lat, c.lon], { icon: L.divIcon({ className: 'dp-pp-clw', html: el, iconSize: [40, 40] }), keyboard: true, title: (c.cover && c.cover.geo && c.cover.geo.place ? c.cover.geo.place.name + ', ' : '') + P('p.photos_n', c.count) });
              m.on('click', function () {
                if (!c.key && map.getZoom() < 16) { map.setView([c.lat, c.lon], Math.min(18, map.getZoom() + 3)); return; }
                showCluster(panel, c);
              });
              m.addTo(layer);
            });
          }, function () { /* the map stays as it is */ });
        };
        map.on('moveend', function () { if (st.mapTimer) clearTimeout(st.mapTimer); st.mapTimer = setTimeout(load, 250); });
        // start where the photos are (every place of them)
        api('GET', 'photos/places').then(function (r) {
          var pts = (r.places || []).map(function (p) { return [p.lat, p.lon]; });
          if (pts.length === 1) map.setView(pts[0], 9); else if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 12 }); else load();
        }, load);
      }, function () {
        clear(box);
        box.appendChild(h('div', { class: 'dp-note is-warn' }, [icon('info'), h('span', { text: T('p.pp.map_off') })]));
      });
    }

    /** The panel of a cluster of one place: its photos, "Alle ansehen". */
    function showCluster(panel, c) {
      clear(panel);
      panel.hidden = false;
      var place = c.cover && c.cover.geo && c.cover.geo.place;
      var name = place ? place.name : T('p.pp.here');
      var thumbs = h('div', { class: 'dp-pp-thumbs' });
      add(panel, [h('div', { class: 'dp-pp-panelhead' }, [h('div', { class: 'dp-pp-sugtx' }, [h('b', { text: name }), h('span', { class: 'dp-meta', text: P('p.photos_n', c.count) })]),
        c.key ? btn(T('p.pp.see_all'), function () { openPlace(c.key, name); }, { small: true, primary: true }) : null,
        U.ibtn('close', T('p.close'), function () { panel.hidden = true; })]), thumbs]);
      api('GET', 'photos', null, c.key ? { place: c.key, limit: 8 } : { bbox: [c.lon - 0.01, c.lat - 0.01, c.lon + 0.01, c.lat + 0.01].join(','), limit: 8 }).then(function (r) {
        (r.items || []).forEach(function (x) { thumbs.appendChild(U.photoTile(x)); });
      }, fail);
    }
    function add(n, kids) { U.add(n, kids); }

    /** A place: the photos there with its map and districts (the result of the place's mark). */
    function openPlace(key, name) {
      setMarks([], { key: key, name: name });
      PH.q = '';
      U.showPhotos(true);
    }

    // ── "Personen" ────────────────────────────────────────

    function loadPeople() {
      return api('GET', 'people').then(function (r) {
        st.people = r;
        st.names = {};
        (r.people || []).forEach(function (p) { if (p.name && !p.hidden) st.names[p.id] = p.name; });
        return r;
      });
    }
    /** The names of my people (for "Auch mit …") — once, then kept. */
    function names() { return st.names ? Promise.resolve(st.names) : (people() ? loadPeople().then(function () { return st.names; }, function () { return {}; }) : Promise.resolve({})); }

    function settings() {
      return api('GET', 'photos/settings').then(function (r) { st.settings = r; return r; });
    }

    function personCard(p, onClick, sub) {
      return h('button', { type: 'button', class: 'dp-pp-p', on: { click: onClick } }, [personFace(p, 72),
        h('span', { class: 'dp-name', text: p.name || T('p.pp.name_it') }), h('span', { class: 'dp-meta', text: sub || P('p.photos_n', p.count) })]);
    }

    function showPeople() {
      var main = U.startPage('people');
      var seq = ++st.seq;
      main.appendChild(h('p', { class: 'dp-hint', text: T('p.loading') }));
      Promise.all([loadPeople(), settings()]).then(function (r) {
        if (seq !== st.seq) return;
        clear(main);
        var list = r[0].people || [];
        var s = r[1];
        var named = list.filter(function (p) { return p.name && !p.hidden; });
        var unnamed = list.filter(function (p) { return !p.name && !p.hidden; });
        var hidden = list.filter(function (p) { return p.hidden; });
        main.appendChild(h('div', { class: 'dp-pp-head' }, [h('h2', { class: 'dp-h2', text: T('p.pp.people') }),
          h('span', { class: 'dp-meta', text: T('p.pp.people_sub', { named: num(named.length), unnamed: num(unnamed.length) }) }), h('span', { class: 'dp-ph-grow' }),
          U.ibtn('gear', T('p.pp.settings'), function () { U.showSettings(); })]));
        if (!s.people) {
          main.appendChild(h('div', { class: 'dp-k-card' }, [h('b', { text: T('p.pp.off_title') }), howItWorks(),
            h('div', { class: 'dp-actions dp-k-acts' }, btn(T('p.pp.turn_on'), function () { putSettings({ people: true }).then(showPeople, fail); }, { primary: true }))]));
          return;
        }
        var pr = r[0].progress || { done: 0, total: 0 };
        if (pr.total) {
          var pct = Math.min(100, Math.round((pr.done / pr.total) * 100));
          main.appendChild(h('div', { class: 'dp-k-card' }, [
            h('b', { text: T(pr.done < pr.total ? 'p.pp.progress' : 'p.pp.progress_done', { done: num(pr.done), total: num(pr.total) }) }),
            h('div', { class: 'dp-meter', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) } }, h('span', { attrs: { style: 'width:' + pct + '%' } })),
            h('span', { class: 'dp-hint', text: T('p.pp.progress_hint') })]));
        }
        if (!list.length) { main.appendChild(h('div', { class: 'dp-empty', text: T('p.pp.people_none') })); return; }
        if (named.length) {
          main.appendChild(h('h2', { class: 'dp-month' }, h('span', { text: T('p.pp.named') })));
          main.appendChild(h('div', { class: 'dp-pp-grid' }, named.map(function (p) { return personCard(p, function () { showPerson(p.id); }); })));
        }
        if (unnamed.length) {
          main.appendChild(h('h2', { class: 'dp-month' }, [h('span', { text: T('p.pp.who') }), h('span', { class: 'dp-meta', text: T('p.pp.who_hint') })]));
          var grid = h('div', { class: 'dp-pp-grid' });
          var draw = function (all) {
            clear(grid);
            (all ? unnamed : unnamed.slice(0, UNNAMED_SHOWN)).forEach(function (p) { grid.appendChild(personCard(p, function () { nameDialog(p.id); }, P('p.photos_n', p.count))); });
          };
          draw(false);
          main.appendChild(grid);
          if (unnamed.length > UNNAMED_SHOWN) {
            var more = h('button', { type: 'button', class: 'dp-linkbtn', text: P('p.pp.more_unnamed', unnamed.length - UNNAMED_SHOWN), on: { click: function () { draw(true); more.hidden = true; } } });
            main.appendChild(more);
          }
        }
        if (hidden.length) {
          var hid = h('div', { class: 'dp-pp-grid', hidden: true }, hidden.map(function (p) { return personCard(p, function () { showPerson(p.id); }); }));
          main.appendChild(h('h2', { class: 'dp-month' }, [h('span', { text: T('p.pp.hidden') }), h('span', { class: 'dp-meta', text: num(hidden.length) }),
            h('button', { type: 'button', class: 'dp-linkbtn', text: T('p.pp.show'), on: { click: function (ev) { hid.hidden = !hid.hidden; ev.target.textContent = T(hid.hidden ? 'p.pp.show' : 'p.pp.hide_list'); } } })]));
          main.appendChild(h('p', { class: 'dp-hint', text: T('p.pp.hidden_hint') }));
          main.appendChild(hid);
        }
      }, function (e) { clear(main); fail(e); });
    }

    function howItWorks() {
      return h('ul', { class: 'dp-pp-how' }, ['p.pp.how1', 'p.pp.how2', 'p.pp.how3', 'p.pp.how4'].map(function (k) { return h('li', { class: 'dp-hint', text: T(k) }); }));
    }

    // ── a person ──────────────────────────────────────────

    function showPerson(id) {
      var main = U.startPage('person');
      var seq = ++st.seq;
      main.appendChild(h('p', { class: 'dp-hint', text: T('p.loading') }));
      api('GET', 'people/' + id).then(function (r) {
        if (seq !== st.seq) return;
        var p = r.person;
        st.person = p;
        U.renderCrumbs();
        clear(main);
        var sub = [P('p.photos_n', p.count), years(p.years)].filter(Boolean).join(' · ');
        main.appendChild(h('div', { class: 'dp-pp-phead' }, [personFace(p, 84),
          h('div', { class: 'dp-pp-sugtx' }, [h('h2', { class: 'dp-h2', text: p.name || T('p.pp.unnamed') }), h('span', { class: 'dp-meta', text: sub }),
            p.contact ? h('span', { class: 'dp-meta dp-pp-contact', text: T('p.pp.linked', { name: p.contact.name }) }) : null,
            p.hidden ? h('span', { class: 'dp-meta', text: T('p.pp.is_hidden') }) : null]),
          h('span', { class: 'dp-ph-grow' }),
          !p.name ? btn(T('p.pp.name_it'), function () { nameDialog(p.id); }, { primary: true, small: true }) : null,
          U.ibtn('more', T('p.pp.actions'), function () { personMenu(p); })]));
        // "Ist das auch …?"
        if (p.uncertain) {
          var faces = h('div', { class: 'dp-pp-qs' });
          var card = h('div', { class: 'dp-k-card dp-pp-unsure' }, [h('b', { text: T('p.pp.also_q', { name: p.name || T('p.pp.this_person') }) }), faces,
            h('span', { class: 'dp-hint', text: P('p.pp.unsure_text', p.uncertain) })]);
          main.appendChild(card);
          api('GET', 'people/' + p.id + '/uncertain', null, { limit: 200 }).then(function (u) {
            var list = u.faces || [];
            list.slice(0, 4).forEach(function (f) { faces.appendChild(faceCrop(f.item, f.box, 52)); });
            if (list.length > 4) faces.appendChild(h('span', { class: 'dp-pp-face dp-pp-more', text: '+' + (list.length - 4) }));
            card.appendChild(h('div', { class: 'dp-actions dp-k-acts' }, [
              btn(T('p.pp.yes_all'), function () {
                api('POST', 'people/' + p.id + '/confirm', { faceIds: list.map(function (f) { return f.faceId; }), yes: true }).then(function (x) { U.toast(P('p.pp.confirmed', x.changed)); st.names = null; showPerson(p.id); }, fail);
              }, { primary: true, small: true }),
              btn(T('p.pp.one_by_one'), function () { reviewDialog(p, list); }, { small: true })]));
          }, fail);
        }
        if (p.together && p.together.length) {
          main.appendChild(h('h2', { class: 'dp-month' }, [h('span', { text: T('p.pp.together') }), h('span', { class: 'dp-meta', text: T('p.pp.together_hint') })]));
          main.appendChild(h('div', { class: 'dp-chips' }, p.together.map(function (q) {
            return h('button', { type: 'button', text: (q.name || T('p.pp.unnamed')) + ' · ' + num(q.count), on: { click: function () {
              setMarks([{ id: p.id, name: p.name || T('p.pp.unnamed') }, { id: q.id, name: q.name || T('p.pp.unnamed') }], null); PH.q = ''; U.showPhotos(true);
            } } });
          })));
        }
        if (p.places && p.places.length && places()) {
          main.appendChild(h('h2', { class: 'dp-month' }, h('span', { text: T('p.pp.places') })));
          main.appendChild(h('div', { class: 'dp-chips' }, p.places.map(function (g) {
            return h('button', { type: 'button', text: g.name + ' · ' + num(g.count), on: { click: function () { setMarks([{ id: p.id, name: p.name || T('p.pp.unnamed') }], { key: g.key, name: g.name }); PH.q = ''; U.showPhotos(true); } } });
          })));
        }
        // the photos by year
        var photos = h('div');
        main.appendChild(photos);
        personPhotos(photos, p, null);
      }, function (e) { clear(main); fail(e); });
    }

    function personPhotos(box, p, before) {
      api('GET', 'photos', null, { person: p.id, limit: 120, before: before }).then(function (r) {
        var items = r.items || [];
        var groups = [];
        items.forEach(function (x) {
          var y = new Date(x.takenAt).getFullYear();
          if (!groups.length || groups[groups.length - 1].y !== y) groups.push({ y: y, items: [] });
          groups[groups.length - 1].items.push(x);
        });
        groups.forEach(function (g) {
          box.appendChild(h('h2', { class: 'dp-month' }, [h('span', { text: String(g.y) })]));
          box.appendChild(h('div', { class: 'dp-phs' }, g.items.map(function (x) { return U.photoTile(x); })));
        });
        if (r.next) {
          var more = h('div', { class: 'dp-more-row' }, btn(T('p.more'), function () { box.removeChild(more); personPhotos(box, p, r.next); }));
          box.appendChild(more);
        }
      }, fail);
    }

    /** The menu of a person: rename, link with a family member, merge with another person, hide / show. */
    function personMenu(p) {
      var row = function (ic, label, fn) { return h('button', { type: 'button', on: { click: function () { U.closeDialog(); fn(); } } }, [icon(ic), h('span', { text: label })]); };
      U.dialog(p.name || T('p.pp.unnamed'), [h('div', { class: 'dp-picker', attrs: { role: 'list' } }, [
        row('edit', T(p.name ? 'p.pp.rename' : 'p.pp.name_it'), function () { nameDialog(p.id); }),
        row('people', T('p.pp.link'), function () { linkDialog(p); }),
        row('move', T('p.pp.merge_with'), function () { mergeDialog(p); }),
        row(p.hidden ? 'eye' : 'close', T(p.hidden ? 'p.pp.unhide' : 'p.pp.hide'), function () {
          api('PATCH', 'people/' + p.id, { hidden: !p.hidden }).then(function () { st.names = null; showPerson(p.id); }, fail);
        }),
      ])]);
    }

    /** Link with a family member (an account of this server), or none. */
    function linkDialog(p) {
      var rows = [];
      S.people.forEach(function (name, id) {
        rows.push(h('button', { type: 'button', on: { click: function () { patch(p.id, { contact: { kind: 'family', id: id, name: name } }); } } }, [h('span', { class: 'dp-pp-dot', text: initials(name) }), h('span', { text: name })]));
      });
      if (p.contact) rows.push(h('button', { type: 'button', on: { click: function () { patch(p.id, { contact: null }); } } }, [icon('close'), h('span', { text: T('p.pp.unlink') })]));
      U.dialog(T('p.pp.link'), [h('p', { class: 'dp-hint', text: T('p.pp.link_hint') }), h('div', { class: 'dp-picker', attrs: { role: 'list' } }, rows)]);
    }
    function patch(id, body) {
      return api('PATCH', 'people/' + id, body).then(function (r) { U.closeDialog(); st.names = null; showPerson(r.person.id); return r; }, fail);
    }

    /** Merge with another person (this one goes into the one chosen). */
    function mergeDialog(p) {
      var others = ((st.people && st.people.people) || []).filter(function (q) { return q.id !== p.id; });
      var go = function (q) {
        api('POST', 'people/' + p.id + '/merge', { into: q.id }).then(function (r) { U.closeDialog(); st.names = null; U.toast(T('p.pp.merged', { name: q.name || T('p.pp.unnamed') })); showPerson(r.person.id); }, fail);
      };
      var draw = function (list) {
        U.dialog(T('p.pp.merge_with'), [h('p', { class: 'dp-hint', text: T('p.pp.merge_hint', { name: p.name || T('p.pp.this_person') }) }),
          list.length ? h('div', { class: 'dp-picker dp-pp-pick', attrs: { role: 'list' } }, list.map(function (q) {
            return h('button', { type: 'button', on: { click: function () { go(q); } } }, [personFace(q, 32), h('span', { text: (q.name || T('p.pp.unnamed')) + ' · ' + P('p.photos_n', q.count) })]);
          })) : h('p', { class: 'dp-hint', text: T('p.pp.people_none') })]);
      };
      if (st.people) draw(others); else loadPeople().then(function () { mergeDialog(p); }, fail);
    }

    /** "Einzeln prüfen": each unsure face with "Ja" / "Nein". */
    function reviewDialog(p, list) {
      var changed = false;
      var rows = list.map(function (f) {
        var state = h('span', { class: 'dp-meta' });
        var acts = h('span', { class: 'dp-actions' });
        var answer = function (yes) {
          api('POST', 'people/' + p.id + '/confirm', { faceIds: [f.faceId], yes: yes }).then(function () { changed = true; clear(acts); state.textContent = T(yes ? 'p.pp.is_yes' : 'p.pp.is_no'); }, fail);
        };
        add(acts, [btn(T('p.pp.no'), function () { answer(false); }, { small: true }), btn(T('p.pp.yes'), function () { answer(true); }, { small: true, primary: true })]);
        return h('div', { class: 'dp-pp-rev' }, [faceCrop(f.item, f.box, 64), h('span', { class: 'dp-pp-sugtx' }, [h('span', { class: 'dp-name', text: f.item ? f.item.name : '' }), state]), acts]);
      });
      var box = U.dialog(T('p.pp.also_q', { name: p.name || T('p.pp.this_person') }), [h('div', { class: 'dp-pp-revs' }, rows),
        h('div', { class: 'dp-actions' }, btn(T('p.pp.done'), function () { U.closeDialog(); if (changed) showPerson(p.id); }, { primary: true }))], { wide: true });
      return box;
    }

    // ── "Wer ist das?" ────────────────────────────────────

    function nameDialog(id) {
      Promise.all([api('GET', 'people/' + id), api('GET', 'people/' + id + '/similar').catch(function () { return { people: [] }; }),
        api('GET', 'photos', null, { person: id, limit: 3 }).catch(function () { return { items: [] }; }), st.people ? Promise.resolve(st.people) : loadPeople()]).then(function (r) {
        var p = r[0].person;
        var like = (r[1].people || [])[0] || null;
        var shots = r[2].items || [];
        var sub = [P('p.photos_n', p.count), years(p.years), p.together && p.together[0] && p.together[0].name ? T('p.pp.often_with', { name: p.together[0].name }) : ''].filter(Boolean).join(' · ');
        var input = h('input', { class: 'dp-input', type: 'text', value: p.name || '', placeholder: T('p.pp.name_ph'), attrs: { maxlength: '80', 'aria-label': T('p.name') } });
        var contact = null;
        var sugBox = h('div', { class: 'dp-pp-sugs' });
        var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
        var save = btn(T('p.pp.save'), function () { doSave(); }, { primary: true, disabled: !input.value.trim() });
        // the family (the accounts of this server) and my people with a name
        var pool = [];
        S.people.forEach(function (name, uid) { pool.push({ name: name, sub: T('p.pp.from_family'), contact: { kind: 'family', id: uid, name: name } }); });
        ((st.people && st.people.people) || []).forEach(function (q) {
          if (q.name && q.id !== p.id && !pool.some(function (x) { return x.name.toLowerCase() === q.name.toLowerCase(); })) pool.push({ name: q.name, sub: P('p.pp.named_already', q.count), contact: null });
        });
        var drawSug = function () {
          clear(sugBox);
          var q = input.value.trim().toLowerCase();
          var list = pool.filter(function (x) { return !q || x.name.toLowerCase().indexOf(q) >= 0; }).slice(0, 3);
          if (!list.length) return;
          sugBox.appendChild(h('span', { class: 'dp-set-lab', text: T('p.pp.from_family_contacts') }));
          list.forEach(function (x) {
            sugBox.appendChild(h('button', { type: 'button', class: 'dp-pp-sugrow', on: { click: function () { input.value = x.name; contact = x.contact; save.disabled = false; drawSug(); } } }, [
              h('span', { class: 'dp-pp-dot', text: initials(x.name) }), h('span', { class: 'dp-pp-sugtx' }, [h('span', { class: 'dp-name', text: x.name }), h('span', { class: 'dp-meta', text: x.sub })])]));
          });
        };
        input.addEventListener('input', function () { contact = null; save.disabled = !input.value.trim(); drawSug(); });
        input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && input.value.trim()) doSave(); });
        var faces = h('div', { class: 'dp-pp-trio' }, [personFace(p, 64)].concat(shots.filter(function (x) { return !p.cover || x.id !== p.cover.nodeId; }).slice(0, 2).map(function (x) {
          return h('span', { class: 'dp-pp-face' , attrs: { style: 'width:52px;height:52px' } }, x.previewUrl ? h('img', { attrs: { src: x.previewUrl, alt: '', style: 'width:100%;height:100%;object-fit:cover' } }) : null);
        })));
        var likeBox = like ? h('div', { class: 'dp-pp-like' }, [h('span', { class: 'dp-pp-dot', text: initials(like.name || '?') }),
          h('span', { class: 'dp-pp-sugtx' }, [h('b', { text: T('p.pp.looks_like', { name: like.name || T('p.pp.unnamed') }) }), h('span', { class: 'dp-meta', text: T('p.pp.looks_like_hint') })]),
          btn(T('p.pp.merge'), function () {
            api('POST', 'people/' + p.id + '/merge', { into: like.id }).then(function (x) { finish('merge', x.person, { name: like.name || T('p.pp.unnamed') }); }, function (e) { err.textContent = U.errText(e); });
          }, { small: true })]) : null;
        var finish = function (kind, person, extra) {
          st.names = null;
          st.people = null;
          var body = h('div', { class: 'dp-pp-done' }, [icon('check', 28),
            h('b', { text: kind === 'merge' ? T('p.pp.done_merge', extra) : kind === 'hide' ? T('p.pp.done_hide') : T('p.pp.done_save', { name: person.name }) }),
            h('span', { class: 'dp-hint', text: kind === 'merge' ? P('p.pp.done_merge_text', person.count, { name: extra.name }) : kind === 'hide' ? P('p.pp.done_hide_text', p.count) : P('p.pp.done_save_text', person.count, { name: person.name }) }),
            h('div', { class: 'dp-actions' }, [
              extra && extra.undo ? btn(T('p.pp.undo'), function () { api('PATCH', 'people/' + p.id, extra.undo).then(function () { U.closeDialog(); showPeople(); }, fail); }) : null,
              btn(T('p.pp.next'), function () { nextUnnamed(p.id); }, { primary: true })])]);
          U.dialog(T('p.pp.who_q'), [body]);
          if (U.S.page === 'people') showPeople();
        };
        var doSave = function () {
          var name = input.value.trim();
          if (!name) return;
          var body = { name: name };
          if (contact) body.contact = contact;
          api('PATCH', 'people/' + p.id, body).then(function (x) {
            finish('save', x.person, x.mergedInto ? { name: x.person.name } : { undo: { name: p.name || '', contact: p.contact || null } });
          }, function (e) { err.textContent = U.errText(e); });
        };
        U.dialog(T('p.pp.who_q'), [h('div', { class: 'dp-pp-who' }, [faces, h('span', { class: 'dp-meta', text: sub })]),
          h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.name') }), input]), sugBox, likeBox, err,
          h('div', { class: 'dp-actions' }, [btn(T('p.pp.hide'), function () {
            api('PATCH', 'people/' + p.id, { hidden: true }).then(function (x) { finish('hide', x.person, { undo: { hidden: false } }); }, function (e) { err.textContent = U.errText(e); });
          }), save])]);
        drawSug();
        input.focus();
      }, fail);
    }

    /** The next person without a name (after naming one), else "Personen". */
    function nextUnnamed(after) {
      loadPeople().then(function (r) {
        var next = (r.people || []).filter(function (p) { return !p.name && !p.hidden && p.id !== after; })[0];
        U.closeDialog();
        if (next) nameDialog(next.id); else showPeople();
      }, fail);
    }

    // ── the settings: "Orte und Personen" ─────────────────

    function putSettings(body) {
      return api('PUT', 'photos/settings', body).then(function (r) { st.settings = r; st.names = null; st.people = null; return r; });
    }

    function settingsSection(main) {
      if (!places() && !people()) return;
      var box = h('div', { class: 'dp-set-card' }, [U.setRow(T('p.loading'), null, null, { cls: 'is-note' })]);
      main.appendChild(h('section', { class: 'dp-set-sec' }, [h('h2', { class: 'dp-set-lab', text: T('p.pp.st_title') }), box]));
      var draw = function (s) {
        clear(box);
        var rows = [];
        if (places()) {
          rows.push(U.setRow(T('p.pp.st_places'), null, null, { cls: 'is-head' }));
          rows.push(U.setRow(T('p.pp.st_keep'), T('p.pp.st_keep_hint'), U.setSwitch(s.keepGeo !== false, T('p.pp.st_keep'), function (on) { putSettings({ keepGeo: on }).then(draw, function (e) { fail(e); draw(s); }); }), { label: true }));
          if (Object.prototype.hasOwnProperty.call(s, 'stripGeoOnShare')) {
            rows.push(U.setRow(T('p.pp.st_strip'), T('p.pp.st_strip_hint'), U.setSwitch(s.stripGeoOnShare !== false, T('p.pp.st_strip'), function (on) { putSettings({ stripGeoOnShare: on }).then(draw, function (e) { fail(e); draw(s); }); }), { label: true }));
          }
          rows.push(U.setRow(T('p.pp.st_delete_geo'), T('p.pp.st_delete_geo_hint'), btn(T('p.pp.st_delete'), function () {
            U.confirmDialog(T('p.pp.st_delete_geo_q'), T('p.pp.st_delete_geo_text'), T('p.pp.st_delete'), function () {
              return api('DELETE', 'photos/geo').then(function (r) { U.toast(P('p.pp.st_geo_deleted', r.deleted)); });
            }, true);
          }, { small: true, danger: true })));
        }
        if (people()) {
          rows.push(U.setRow(T('p.pp.st_people_head'), null, null, { cls: 'is-head' }));
          rows.push(U.setRow(T('p.pp.st_people'), T('p.pp.st_people_hint'), U.setSwitch(!!s.people, T('p.pp.st_people'), function (on) {
            if (on) { putSettings({ people: true }).then(draw, function (e) { fail(e); draw(s); }); return; }
            askWipe(s, draw);
          }), { label: true }));
          if (!s.people) rows.push(h('div', { class: 'dp-set-row is-note' }, [h('span', { class: 'dp-set-tx' }, [h('span', { class: 'dp-set-t', text: T('p.pp.how') }), howItWorks()])]));
          else {
            rows.push(U.setRow(T('p.pp.st_kids'), T('p.pp.st_kids_hint'), U.setSwitch(!!s.peopleKids, T('p.pp.st_kids'), function (on) { putSettings({ peopleKids: on }).then(draw, function (e) { fail(e); draw(s); }); }), { label: true }));
            rows.push(U.setRow(T('p.pp.st_devices'), null, null, { cls: 'is-note' }));
            rows.push(U.setRow(T('p.pp.st_wipe'), T('p.pp.st_wipe_hint'), btn(T('p.pp.st_delete'), function () { askWipe(s, draw); }, { small: true, danger: true })));
          }
        }
        U.add(box, rows);
      };
      settings().then(draw, function () { clear(box); box.appendChild(U.setRow(T('err.generic', { code: '' }), null, null, { cls: 'is-note' })); });
    }

    /** "Alle Gesichtsdaten löschen?" — then people: false. */
    function askWipe(s, draw) {
      U.confirmDialog(T('p.pp.st_wipe_q'), T('p.pp.st_wipe_text'), T('p.pp.st_delete'), function () {
        return putSettings({ people: false }).then(function (r) { U.toast(P('p.pp.st_wiped', r.deleted || 0)); draw(r); });
      }, true);
      // the switch shows the state until the answer
      draw(s);
    }

    // ── the menu, crumbs ──────────────────────────────────

    /** "Karte" and "Personen" below "Fotos" in the menu. */
    function navRows(nav, navGo) {
      var sub = function (ic, label, cur, fn) {
        nav.appendChild(h('button', { type: 'button', class: 'dp-nav-page dp-nav-sub', attrs: { 'aria-current': cur ? 'page' : null }, on: { click: function () { navGo(); fn(); } } }, [icon(ic), h('span', { text: label })]));
      };
      if (places()) sub('pin', T('p.pp.map_nav'), S.page === 'map', showMap);
      if (people()) sub('people', T('p.pp.people'), S.page === 'people' || S.page === 'person', showPeople);
    }

    function crumb(page) {
      if (page === 'map') return T('p.pp.map_nav');
      if (page === 'people') return T('p.pp.people');
      if (page === 'person') return st.person && st.person.name ? st.person.name : T('p.pp.people');
      return null;
    }

    return {
      active: active, query: query, searchBox: searchBox, renderResult: renderResult, names: names, showMap: showMap, showPeople: showPeople,
      showPerson: showPerson, nameDialog: nameDialog, settingsSection: settingsSection, navRows: navRows, crumb: crumb, faceCrop: faceCrop, setMarks: setMarks,
      openPlace: openPlace,
    };
  }

  window.DrivePlaces = { attach: attach };
}());
