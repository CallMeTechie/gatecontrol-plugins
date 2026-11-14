/* Notizen & Aufgaben 1.5.0 — places in the portal tab: the dialog „Ort“ of a task (the places near, the fastest to
   reach first; „Meine Orte“; a point on the map; on arriving / on leaving; „als meinen Baumarkt merken“) and the
   card „Orte“ of „Einstellungen“ (the person's switches, „Meine Orte“). ui/portal.js hands in its helpers (init).

   The portal has no position of its own: a search is made near one of the person's places („in der Nähe von
   Zuhause“) — the server rounds that too. A search only goes out on „Suchen“ or Enter, never while typing (the
   public search service forbids completing as one types). The reminder itself comes on the phone. */
(function () {
  'use strict';
  var E = null;
  var CTX = window.NA_CTX || {};
  function T(k, p) { return E.T(k, p); }
  function init(env) { E = env; }
  function me() { return E.state().me || {}; }
  function info() { return me().places || { search: { state: 'off' } }; }

  /** „2,4 km“ / „300 m“ */
  function distText(m) {
    if (m == null) return '';
    if (m < 950) return Math.max(50, Math.round(m / 50) * 50) + ' m';
    var s = (m / 1000).toFixed(1);
    return (me().lang === 'en' ? s : s.replace('.', ',')) + ' km';
  }
  /** „Baumarkt Nord · beim Ankommen“ */
  function summary(p) { return p.name + ' · ' + T(p.trigger === 'exit' ? 'pl.on_exit' : 'pl.on_enter'); }

  // ── the map (GateControl's Leaflet, plugin.json ui.maps) — a point is set by a click; without it the coordinates stay ──
  var loading = null;
  function leaflet() {
    if (window.L && window.L.map) return Promise.resolve(window.L);
    if (loading) return loading;
    var cfg = CTX.leaflet || {};
    loading = new Promise(function (resolve, reject) {
      if (!cfg.js || !document.head) { reject(new Error('no leaflet')); return; }
      var done = false;
      var finish = function (ok) { if (done) return; done = true; if (ok && window.L && window.L.map) resolve(window.L); else { loading = null; reject(new Error('leaflet unavailable')); } };
      if (cfg.css) { var link = document.createElement('link'); link.rel = 'stylesheet'; link.href = cfg.css; document.head.appendChild(link); }
      var s = document.createElement('script');
      s.src = cfg.js; s.async = true;
      s.onload = function () { finish(true); };
      s.onerror = function () { finish(false); };
      document.head.appendChild(s);
      setTimeout(function () { finish(!!(window.L && window.L.map)); }, 8000);
    });
    return loading;
  }
  /** A map in `box` to set a point: o = { lat, lon, radius, center, onPick(lat, lon) } → { set(lat, lon) } | null. */
  function mapPick(box, o) {
    return leaflet().then(function (L) {
      E.clear(box);
      var holder = E.h('div', { class: 'na-map', role: 'application', attrs: { 'aria-label': T('pl.map_aria') } });
      box.appendChild(holder);
      var map = L.map(holder, { scrollWheelZoom: false, attributionControl: true });
      L.tileLayer((window.GC && typeof window.GC.tiles === 'string' && window.GC.tiles) || CTX.tiles, { maxZoom: 19, referrerPolicy: 'origin',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(map);
      var pos = o.lat != null && o.lon != null ? { lat: o.lat, lon: o.lon } : null;
      var marker = null;
      var circle = null;
      function draw() {
        if (!pos) return;
        var ll = [pos.lat, pos.lon];
        if (!marker) {
          circle = L.circle(ll, { radius: o.radius || 150, color: '#0f766e', weight: 2, fillColor: '#0f766e', fillOpacity: 0.14, interactive: false }).addTo(map);
          marker = L.marker(ll, { draggable: true, keyboard: true, title: T('pl.map_point'), alt: T('pl.map_point'), icon: L.divIcon({ className: 'na-pin', html: '', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(map);
          marker.on('dragend', function (e) { var p = e.target.getLatLng(); pos = { lat: p.lat, lon: p.lng }; circle.setLatLng(p); o.onPick(pos.lat, pos.lon); });
        } else { marker.setLatLng(ll); circle.setLatLng(ll); }
      }
      map.on('click', function (e) { pos = { lat: e.latlng.lat, lon: e.latlng.lng }; draw(); o.onPick(pos.lat, pos.lon); });
      var start = pos || o.center || { lat: 51.2, lon: 10.4 };
      map.setView([start.lat, start.lon], pos ? 16 : (o.center ? 13 : 6));
      draw();
      setTimeout(function () { try { map.invalidateSize(); } catch (_) { /* gone */ } }, 60);
      return { set: function (lat, lon) { pos = { lat: lat, lon: lon }; draw(); map.setView([lat, lon], 16); } };
    }).catch(function () { return null; });
  }

  /** The places to search near: the family's home first, then the person's own named places. */
  function nearOptions(all) {
    var out = [];
    (all.family || []).forEach(function (f) { out.push({ value: 'f:' + f.familyId, label: f.name, lat: f.lat, lon: f.lon }); });
    (all.places || []).forEach(function (p) { if (p.named) out.push({ value: 'p:' + p.id, label: p.name, lat: p.lat, lon: p.lon }); });
    return out;
  }
  function nearArg(v) { return !v ? {} : v.slice(0, 2) === 'f:' ? { nearFamilyId: v.slice(2) } : { nearPlaceId: Number(v.slice(2)) }; }

  /** One row to choose („○ Baumarkt Nord — Industriestraße 4 — 6 Min. 2,4 km“). */
  function row(name, sub, right, on, pick, dashed) {
    return E.h('button', { type: 'button', class: 'na-pl' + (on ? ' is-on' : '') + (dashed ? ' is-any' : ''), attrs: { 'aria-pressed': on ? 'true' : 'false' }, on: { click: pick } }, [
      E.h('span', { class: 'na-pl-rd' }), E.h('span', { class: 'na-pl-t' }, [E.h('b', { text: name }), sub ? E.h('small', { text: sub }) : null]),
      right ? E.h('span', { class: 'na-pl-m' }, [E.h('b', { text: right[0] }), E.h('small', { text: right[1] })]) : null]);
  }

  /**
   * The dialog „Ort“: o = { place: Task.place | null, hint: { key, label, query } | null, onSave(arg | null), none: bool }
   * — onSave gets the `place` of POST / PATCH tasks (null: no place).
   */
  function choose(o) {
    var cur = o.place || null;
    var st = { sel: null, trigger: cur && cur.trigger === 'exit' ? 'exit' : 'enter', key: (o.hint && o.hint.key) || (cur && cur.key) || null, label: (o.hint && o.hint.label) || (cur && cur.label) || null,
      remember: false, results: null, any: false, all: { places: [], family: [], favs: [] }, pin: null, busy: false, error: null, attribution: null };
    var body = E.h('div', { class: 'na-pl-body' });
    var box = E.dialog(st.label ? T('pl.which', { label: st.label }) : T('pl.title'), [body]);
    var q = E.h('input', { type: 'search', class: 'dp-input', value: (o.hint && o.hint.query) || '', attrs: { placeholder: T('pl.search_ph'), 'aria-label': T('pl.search_ph'), maxlength: '80' } });
    var near = E.h('select', { class: 'dp-input', attrs: { 'aria-label': T('pl.near') } });
    var mapBox = E.h('div', { class: 'na-pl-map', hidden: true });
    var pinName = E.h('input', { type: 'text', class: 'dp-input', attrs: { placeholder: T('pl.pin_name'), 'aria-label': T('pl.pin_name'), maxlength: '80' } });
    var lat = E.h('input', { type: 'number', class: 'dp-input', attrs: { step: 'any', min: '-90', max: '90', placeholder: T('pl.lat'), 'aria-label': T('pl.lat') } });
    var lon = E.h('input', { type: 'number', class: 'dp-input', attrs: { step: 'any', min: '-180', max: '180', placeholder: T('pl.lon'), 'aria-label': T('pl.lon') } });
    var mapApi = null;
    function pinFromFields() {
      var a = Number(lat.value), b = Number(lon.value);
      if (lat.value === '' || lon.value === '' || !isFinite(a) || !isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) { st.pin = null; return; }
      st.pin = { lat: a, lon: b };
      st.sel = { type: 'pin' };
    }
    lat.addEventListener('change', function () { pinFromFields(); if (mapApi && st.pin) mapApi.set(st.pin.lat, st.pin.lon); draw(); });
    lon.addEventListener('change', function () { pinFromFields(); if (mapApi && st.pin) mapApi.set(st.pin.lat, st.pin.lon); draw(); });
    function showMap() {
      mapBox.hidden = false;
      if (mapBox.firstChild) return;
      var slot = E.h('div');
      var opts = nearOptions(st.all);
      var c = cur && cur.lat != null ? cur : opts[0] || null;
      mapBox.appendChild(slot);
      mapBox.appendChild(E.h('div', { class: 'na-add' }, [pinName, lat, lon]));
      mapBox.appendChild(E.h('p', { class: 'dp-hint', text: T('pl.map_hint') }));
      mapPick(slot, { center: c ? { lat: c.lat, lon: c.lon } : null, radius: 150, onPick: function (a, b) { lat.value = a.toFixed(6); lon.value = b.toFixed(6); st.pin = { lat: a, lon: b }; st.sel = { type: 'pin' }; draw(); } })
        .then(function (m) { mapApi = m; if (!m) { E.clear(slot); slot.appendChild(E.h('p', { class: 'dp-hint', text: T('pl.map_none') })); } });
    }
    function search() {
      var text = q.value.trim();
      if (text.length < 2 && !st.key) return;
      st.busy = true; st.error = null; draw();
      var b = text.length >= 2 && !(o.hint && text === o.hint.query && st.key) ? { q: text } : { key: st.key, label: st.label };
      var n = nearArg(near.value);
      Object.keys(n).forEach(function (k) { b[k] = n[k]; });
      E.api('POST', 'places/search', b).then(function (r) {
        st.busy = false; st.results = r.results; st.any = r.any; st.attribution = r.attribution; st.radius = r.radiusKm;
        if (r.key) { st.key = r.key; st.label = r.label; } else { st.key = null; st.label = null; }
        var fav = r.results.filter(function (x) { return x.fav; })[0];
        if (!st.sel && r.results.length) st.sel = { type: 'hit', hit: fav || r.results[0] };
        draw();
      }, function (e) {
        st.busy = false; st.results = null;
        st.error = e.code === 'module_off' ? T('pl.search_off') : e.code === 'busy' ? T('pl.search_busy') : e.code === 'invalid' && e.extra && e.extra.field === 'near' ? T('pl.search_near') : T('pl.search_down');
        draw();
      });
    }
    q.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); search(); } });
    function isSel(type, test) { return !!st.sel && st.sel.type === type && (!test || test(st.sel)); }
    function draw() {
      E.clear(body);
      var search_on = info().search.state === 'on';
      var opts = nearOptions(st.all);
      // the search: a word, „in der Nähe von“, the button
      if (search_on) {
        E.clear(near);
        opts.forEach(function (x) { near.appendChild(E.h('option', { value: x.value, text: T('pl.near_of', { name: x.label }) })); });
        if (!opts.length) near.appendChild(E.h('option', { value: '', text: T('pl.near_none') }));
        body.appendChild(E.h('div', { class: 'na-add na-pl-search' }, [q, near, E.btn(T('pl.search'), search, { small: true, icon: 'search' })]));
        if (!opts.length) body.appendChild(E.h('p', { class: 'dp-hint', text: T('pl.near_hint') }));
      }
      if (st.busy) body.appendChild(E.h('p', { class: 'dp-hint', attrs: { role: 'status' }, text: T('pl.searching') }));
      if (st.error) body.appendChild(E.h('div', { class: 'dp-note', attrs: { role: 'alert' } }, [E.icon('pin', 16), E.h('span', { text: st.error })]));
      if (st.results) {
        if (!st.results.length) body.appendChild(E.h('p', { class: 'na-pl-none', text: T('pl.none', { label: st.label || q.value.trim(), km: st.radius || 15 }) }));
        var list = E.h('div', { class: 'na-pl-list', role: 'group', attrs: { 'aria-label': st.label ? T('pl.which', { label: st.label }) : T('pl.title') } });
        st.results.forEach(function (x) {
          var sub = [x.address, x.fav && st.label ? T('pl.fav_for', { label: st.label }) : x.uses > 1 ? T('pl.used', { n: x.uses }) : null].filter(Boolean).join(' · ');
          list.appendChild(row(x.name, sub, x.distanceM == null ? null : [T('pl.min', { n: x.minutes }), distText(x.distanceM)], isSel('hit', function (s) { return s.hit === x; }), function () { st.sel = { type: 'hit', hit: x }; draw(); }));
        });
        if (st.any && st.key) list.appendChild(row(T('pl.any', { label: st.label }), T('pl.any_hint'), null, isSel('any'), function () { st.sel = { type: 'any' }; draw(); }, true));
        body.appendChild(list);
        if (st.attribution) body.appendChild(E.h('p', { class: 'dp-hint na-pl-attr' }, [E.h('span', { text: T('pl.approx') + ' ' }), E.h('a', { href: st.attribution.url, target: '_blank', rel: 'noopener', text: st.attribution.text })]));
      }
      // „Meine Orte“
      var mine = (st.all.places || []);
      var fam = (st.all.family || []);
      if (mine.length || fam.length) {
        body.appendChild(E.h('div', { class: 'na-lb', text: T('pl.mine') }));
        var ml = E.h('div', { class: 'na-pl-list', role: 'group', attrs: { 'aria-label': T('pl.mine') } });
        fam.forEach(function (f) { ml.appendChild(row(f.name, T('pl.family'), null, isSel('family', function (s) { return s.familyId === f.familyId; }), function () { st.sel = { type: 'family', familyId: f.familyId }; draw(); })); });
        mine.forEach(function (p) {
          var sub = [p.address, (p.favFor || []).map(function (f) { return T('pl.fav_for', { label: f.label }); }).join(', ') || (p.named ? T('pl.saved') : null)].filter(Boolean).join(' · ');
          ml.appendChild(row(p.name, sub, null, isSel('own', function (s) { return s.placeId === p.id; }), function () { st.sel = { type: 'own', placeId: p.id }; draw(); }));
        });
        body.appendChild(ml);
      }
      // a point on the map
      var mapBtn = E.h('button', { type: 'button', class: 'na-pl-opt', on: { click: function () { showMap(); } } }, [E.icon('pin', 16), E.h('span', { text: T('pl.map') }), E.icon('chevr', 14)]);
      body.appendChild(mapBtn);
      body.appendChild(mapBox);
      if (!search_on) body.appendChild(E.h('p', { class: 'dp-hint', text: T(info().search.state === 'unavailable' ? 'pl.search_down' : 'pl.search_off') }));
      // on arriving / on leaving, remember
      var seg = E.h('div', { class: 'na-seg', role: 'group', attrs: { 'aria-label': T('pl.when') } });
      ['enter', 'exit'].forEach(function (tr) {
        seg.appendChild(E.h('button', { type: 'button', class: st.trigger === tr ? 'is-on' : '', attrs: { 'aria-pressed': st.trigger === tr ? 'true' : 'false' }, text: T(tr === 'exit' ? 'pl.exit' : 'pl.enter'), on: { click: function () { st.trigger = tr; draw(); } } }));
      });
      body.appendChild(seg);
      var concrete = isSel('hit') || isSel('own');
      if (st.key && st.label && concrete) {
        var ck = E.h('input', { type: 'checkbox', checked: st.remember, attrs: { id: 'na-pl-rem' } });
        ck.addEventListener('change', function () { st.remember = ck.checked; });
        body.appendChild(E.h('label', { class: 'na-pl-rem', attrs: { for: 'na-pl-rem' } }, [ck, E.h('span', { text: T('pl.remember', { label: st.label }) })]));
      }
      body.appendChild(E.h('p', { class: 'dp-hint', text: T('pl.phone_hint') }));
      var can = !!st.sel || !!cur;
      body.appendChild(E.h('div', { class: 'dp-actions' }, [
        o.none !== false && cur ? E.btn(T('pl.remove'), function () { E.closeDialog(); o.onSave(null); }, { small: true, danger: true }) : null,
        E.btn(T('p.cancel'), E.closeDialog),
        E.btn(T('p.save'), function () { var arg = argOf(); if (arg === undefined) { E.toast(T('pl.pin_need'), 'error'); return; } E.closeDialog(); o.onSave(arg, textOf()); }, { primary: true, disabled: !can }),
      ]));
    }
    /** The name of what is chosen (for a chip). */
    function textOf() {
      var s = st.sel;
      if (!s) return cur ? cur.name : '';
      if (s.type === 'hit') return s.hit.name;
      if (s.type === 'any') return T('pl.any', { label: st.label });
      if (s.type === 'pin') return pinName.value.trim();
      if (s.type === 'family') return ((st.all.family || []).filter(function (f) { return f.familyId === s.familyId; })[0] || {}).name || '';
      return ((st.all.places || []).filter(function (p) { return p.id === s.placeId; })[0] || {}).name || '';
    }
    /** The `place` argument for what is chosen; undefined: something is missing. */
    function argOf() {
      var s = st.sel;
      var base = { trigger: st.trigger };
      if (!s) return base;
      if (s.type === 'family') { base.familyId = s.familyId; base.key = null; return base; }
      if (s.type === 'any') { base.any = true; base.key = st.key; base.label = st.label; return base; }
      if (s.type === 'pin') {
        if (!st.pin || !pinName.value.trim()) return undefined;
        base.name = pinName.value.trim(); base.lat = st.pin.lat; base.lon = st.pin.lon; base.key = null;
        return base;
      }
      if (st.key) { base.key = st.key; base.label = st.label; if (st.remember) base.remember = true; } else base.key = null;
      if (s.type === 'own') { base.placeId = s.placeId; return base; }
      var x = s.hit;
      if (x.placeId) base.placeId = x.placeId;
      else { if (x.ref) base.ref = x.ref; base.name = x.name; base.address = x.address; base.lat = x.lat; base.lon = x.lon; }
      return base;
    }
    draw();
    E.api('GET', 'places').then(function (r) {
      st.all = r;
      if (cur && cur.id && !st.sel && (r.places || []).some(function (p) { return p.id === cur.id; })) st.sel = { type: 'own', placeId: cur.id };
      draw();
      // a kind or a name from the line, and a place to search near: the list is there at once (one search, asked for by opening the dialog)
      if (o.hint && o.hint.key && info().search.state === 'on' && nearOptions(r).length) search();
    }, E.fail);
    return box;
  }

  /** The dialog of one of „Meine Orte“ (new or changed): name, address, a point on the map, the radius. */
  function edit(p, all, done) {
    var name = E.h('input', { type: 'text', class: 'dp-input', value: p ? p.name : '', attrs: { 'aria-label': T('pl.name'), maxlength: '80' } });
    var addr = E.h('input', { type: 'text', class: 'dp-input', value: p ? p.address : '', attrs: { 'aria-label': T('pl.address'), maxlength: '160', placeholder: T('pl.address_ph') } });
    var lat = E.h('input', { type: 'number', class: 'dp-input', value: p ? String(p.lat) : '', attrs: { step: 'any', min: '-90', max: '90', 'aria-label': T('pl.lat'), placeholder: T('pl.lat') } });
    var lon = E.h('input', { type: 'number', class: 'dp-input', value: p ? String(p.lon) : '', attrs: { step: 'any', min: '-180', max: '180', 'aria-label': T('pl.lon'), placeholder: T('pl.lon') } });
    var radius = E.h('input', { type: 'number', class: 'dp-input', value: String(p ? p.radius : info().radius ? info().radius.default : 150), attrs: { min: '50', max: '2000', step: '10', 'aria-label': T('pl.radius') } });
    var slot = E.h('div');
    var hits = E.h('div', { class: 'na-pl-list' });
    var mapApi = null;
    function setPos(a, b) { lat.value = Number(a).toFixed(6); lon.value = Number(b).toFixed(6); if (mapApi) mapApi.set(Number(a), Number(b)); }
    function find() {
      var text = addr.value.trim();
      if (text.length < 3) return;
      E.clear(hits);
      hits.appendChild(E.h('p', { class: 'dp-hint', attrs: { role: 'status' }, text: T('pl.searching') }));
      var opts = nearOptions(all);
      var b = { q: text, address: true };
      var n = nearArg(opts[0] ? opts[0].value : '');
      Object.keys(n).forEach(function (k) { b[k] = n[k]; });
      E.api('POST', 'places/search', b).then(function (r) {
        E.clear(hits);
        if (!r.results.length) hits.appendChild(E.h('p', { class: 'na-pl-none', text: T('pl.addr_none') }));
        r.results.forEach(function (x) { hits.appendChild(row(x.name, x.address, null, false, function () { setPos(x.lat, x.lon); if (!addr.value.trim() || x.address) addr.value = x.address || addr.value; E.clear(hits); })); });
        if (r.attribution && r.results.length) hits.appendChild(E.h('p', { class: 'dp-hint na-pl-attr' }, [E.h('a', { href: r.attribution.url, target: '_blank', rel: 'noopener', text: r.attribution.text })]));
      }, function (e) { E.clear(hits); hits.appendChild(E.h('p', { class: 'dp-hint', attrs: { role: 'alert' }, text: e.code === 'busy' ? T('pl.search_busy') : T('pl.search_down') })); });
    }
    var searchOn = info().search.state === 'on';
    var kids = [
      E.h('label', { class: 'dp-field' }, [E.h('span', { class: 'dp-label', text: T('pl.name') }), name]),
      E.h('label', { class: 'dp-field' }, [E.h('span', { class: 'dp-label', text: T('pl.address') }), E.h('span', { class: 'na-add' }, [addr, searchOn ? E.btn(T('pl.addr_find'), find, { small: true, icon: 'search' }) : null])]),
      hits, slot,
      E.h('div', { class: 'na-add' }, [lat, lon]),
      E.h('label', { class: 'dp-field' }, [E.h('span', { class: 'dp-label', text: T('pl.radius') }), radius]),
      E.h('p', { class: 'dp-hint', text: T(searchOn ? 'pl.edit_hint' : 'pl.edit_hint_off') }),
      E.h('div', { class: 'dp-actions' }, [E.btn(T('p.cancel'), E.closeDialog), E.btn(T('p.save'), function () {
        var a = Number(lat.value), b = Number(lon.value);
        if (!name.value.trim()) { E.toast(T('pl.name_need'), 'error'); return; }
        if (lat.value === '' || lon.value === '' || !isFinite(a) || !isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) { E.toast(T('pl.pin_need'), 'error'); return; }
        var body = { name: name.value.trim(), address: addr.value.trim(), lat: a, lon: b, radius: Number(radius.value) || 150 };
        (p ? E.api('PATCH', 'places/' + p.id, Object.assign(body, { named: true })) : E.api('POST', 'places', body)).then(function () { E.closeDialog(); done(); }, E.fail);
      }, { primary: true })]),
    ];
    E.dialog(p ? T('pl.edit') : T('pl.new'), kids);
    var opts = nearOptions(all);
    mapPick(slot, { lat: p ? p.lat : null, lon: p ? p.lon : null, radius: p ? p.radius : 150, center: opts[0] ? { lat: opts[0].lat, lon: opts[0].lon } : null, onPick: function (a, b) { lat.value = a.toFixed(6); lon.value = b.toFixed(6); } })
      .then(function (m) { mapApi = m; if (!m) slot.appendChild(E.h('p', { class: 'dp-hint', text: T('pl.map_none') })); });
  }

  /** „Einstellungen“ › Orte: the person's switches and „Meine Orte“. */
  function settings(wrap, savePrefs) {
    var p = info();
    var prefs = (me().prefs && me().prefs.places) || {};
    wrap.appendChild(E.h('h3', { text: T('pl.set_title') }));
    var rows = E.h('div', { class: 'na-tl' });
    var sw = function (label, hint, on, fn, disabled) {
      var c = E.h('input', { type: 'checkbox', class: 'dp-sw', checked: !!on, disabled: !!disabled, attrs: { 'aria-label': label } });
      c.addEventListener('change', function () { fn(c.checked); });
      return E.h('div', { class: 'na-set-row' }, [E.h('span', { class: 't' }, [E.h('span', { text: label }), hint ? E.h('small', { text: hint }) : null]), c]);
    };
    var again = function () { return E.api('GET', 'me').then(function (r) { E.state().me = r; E.rerender(); }, E.fail); };
    var adminOff = !p.search.enabled;
    rows.appendChild(sw(T('pl.set_search'), adminOff ? T('pl.set_search_admin') : T('pl.set_search_hint'), !adminOff && prefs.search !== false, function (v) { savePrefs({ places: { search: v } }).then(again); }, adminOff));
    rows.appendChild(sw(T('pl.set_nearby'), T('pl.set_nearby_hint'), prefs.nearby !== false, function (v) { savePrefs({ places: { nearby: v } }).then(again); }));
    var quiet = prefs.quiet || null;
    var from = E.h('input', { type: 'time', class: 'dp-input na-time', value: quiet ? quiet.from : '21:00', attrs: { 'aria-label': T('pl.set_quiet_from') } });
    var to = E.h('input', { type: 'time', class: 'dp-input na-time', value: quiet ? quiet.to : '07:00', attrs: { 'aria-label': T('pl.set_quiet_to') } });
    var saveQuiet = function () { if (from.value && to.value) savePrefs({ places: { quiet: { from: from.value, to: to.value } } }).then(again); };
    from.addEventListener('change', saveQuiet);
    to.addEventListener('change', saveQuiet);
    rows.appendChild(sw(T('pl.set_quiet'), T('pl.set_quiet_hint'), !!quiet, function (v) { savePrefs({ places: { quiet: v ? { from: from.value || '21:00', to: to.value || '07:00' } : null } }).then(again); }));
    if (quiet) rows.appendChild(E.h('div', { class: 'na-set-row' }, [E.h('span', { class: 't' }, [E.h('span', { text: T('pl.set_quiet_times') })]), E.h('span', { class: 'na-add' }, [from, to])]));
    var card = E.h('div', { class: 'na-card' }, [rows, E.h('p', { class: 'dp-hint', text: T('pl.privacy') })]);
    wrap.appendChild(card);
    // „Meine Orte“
    var mine = E.h('div', { class: 'na-card', attrs: { id: 'na-places' } }, [E.h('p', { class: 'dp-hint', text: T('pl.loading') })]);
    wrap.appendChild(mine);
    var load = function () {
      E.api('GET', 'places').then(function (r) {
        E.clear(mine);
        mine.appendChild(E.h('div', { class: 'na-set-h' }, [E.h('b', { text: T('pl.mine'), style: 'flex:1' }), E.btn(T('pl.new'), function () { edit(null, r, load); }, { small: true, icon: 'plus' })]));
        var list = E.h('div', { class: 'na-tl' });
        (r.family || []).forEach(function (f) { list.appendChild(E.h('div', { class: 'na-set-row' }, [E.h('span', { class: 't' }, [E.h('span', { text: f.name }), E.h('small', { text: T('pl.family') })]), E.icon('home', 16)])); });
        (r.places || []).forEach(function (x) {
          var favs = (x.favFor || []);
          var sub = [x.address, favs.map(function (f) { return T('pl.fav_for', { label: f.label }); }).join(', ')].filter(Boolean).join(' · ');
          var tools = E.h('span', { class: 'na-add' }, [
            favs.length ? E.ib('x', T('pl.forget', { label: favs.map(function (f) { return f.label; }).join(', ') }), function () { Promise.all(favs.map(function (f) { return E.api('PUT', 'places/favs', { key: f.key, placeId: null }); })).then(load, E.fail); }) : null,
            E.ib('edit', T('pl.edit'), function () { edit(x, r, load); }),
            E.ib('trash', T('p.delete'), function () { E.api('DELETE', 'places/' + x.id).then(load, E.fail); }),
          ]);
          list.appendChild(E.h('div', { class: 'na-set-row' }, [E.h('span', { class: 't' }, [E.h('span', { text: x.name }), sub ? E.h('small', { text: sub }) : null]), tools]));
        });
        if (!(r.family || []).length && !(r.places || []).length) list.appendChild(E.h('p', { class: 'dp-hint', text: T('pl.mine_none') }));
        mine.appendChild(list);
      }, E.fail);
    };
    load();
  }

  window.NAPlaces = { init: init, choose: choose, edit: edit, settings: settings, summary: summary, distText: distText };
}());
