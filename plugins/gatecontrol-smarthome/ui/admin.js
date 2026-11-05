/* Smart Home main page (port of GateControl's public/js/smarthome.js) — Phoscon/deCONZ gateways and, since 1.7.0,
   Shelly and Tasmota devices through a GateControl gateway (the plugin's edge part, server/edge.js). */
(function () {
  'use strict';
  var S = window.SH, T = S.T, $ = S.$, $$ = S.$$, el = S.el;
  var SWATCHES = S.SWATCHES;
  var ICONS = {
    light: '<circle cx="12" cy="9" r="5"/><path d="M9 18h6M10 21h4"/>',
    plug: '<path d="M9 2v5M15 2v5"/><path d="M7 7h10v3a5 5 0 0 1-10 0z"/><path d="M12 15v7"/>',
    group: '<circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><circle cx="12" cy="16" r="3"/>',
    scene: '<path d="M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 8.7l5.4-.8z"/>',
    switch: '<rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="8" r="1.6"/><path d="M10 14h4"/>',
    relay: '<path d="M12 3v9M6.3 7.3a8 8 0 1 0 11.4 0"/>',
    cover: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16"/>',
    'sensor.presence': '<circle cx="12" cy="12" r="2"/><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4.5 4.5a11 11 0 0 0 0 15M19.5 4.5a11 11 0 0 1 0 15"/>',
    'sensor.open': '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M14 3v18"/><circle cx="11.5" cy="12" r="1"/>',
    'sensor.water': '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
    'sensor.temperature': '<path d="M10 13V5a2 2 0 1 1 4 0v8a4 4 0 1 1-4 0z"/>',
    'sensor.humidity': '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/><path d="M9 14a3 3 0 0 0 3 3"/>',
    'sensor.lightlevel': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
    'sensor.button': '<rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="8" r="1.6"/>',
    'sensor.unknown': '<circle cx="12" cy="12" r="8"/><path d="M12 8v4M12 16h.01"/>',
  };
  var STEP_ICONS = {
    done: '<path d="m5 12 5 5 9-10"/>',
    running: '<path d="M12 3a9 9 0 1 0 9 9"/>',
    need: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    error: '<path d="M6 6l12 12M18 6 6 18"/>',
    pending: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
  };
  // Gen1 type codes → names (the probe and announce give the code)
  var GEN1 = { 'SHSW-1': 'Shelly 1', 'SHSW-PM': 'Shelly 1PM', 'SHSW-L': 'Shelly 1L', 'SHSW-21': 'Shelly 2', 'SHSW-25': 'Shelly 2.5', 'SHPLG-S': 'Shelly Plug S', 'SHPLG-1': 'Shelly Plug',
    'SHDM-1': 'Shelly Dimmer', 'SHDM-2': 'Shelly Dimmer 2', 'SHHT-1': 'Shelly H&T', 'SHRGBW2': 'Shelly RGBW2', 'SHIX3-1': 'Shelly i3', 'SHEM': 'Shelly EM' };

  var gateways = [];            // deCONZ gateways
  var targets = [];
  var edge = { available: false, gateways: [], minGateway: '1.19.0' };
  var edgeDevices = [];
  var found = [];
  var deconzRes = [];
  var areas = {};
  var allUsers = null;
  var ownerTarget = null;       // { resource } (deCONZ) | { device } (Shelly / Tasmota)
  var source = null;            // { type: 'd' | 'e', id }

  function send(id, body) { return S.api('POST', 'resources/' + Number(id) + '/state', body); }
  function warn(err) { S.toast((err && err.message) || T('common.error'), 'error'); }
  function svg(body, size, cls) {
    var span = el('span', { class: 'sh-ico-wrap' });
    span.innerHTML = '<svg class="' + (cls || 'sh-ico') + '" viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>'; // static markup from the tables above
    return span.firstChild;
  }
  function currentGatewayId() { return source && source.type === 'd' ? source.id : null; }
  function currentGateway() { var id = currentGatewayId(); return gateways.find(function (g) { return g.id === id; }) || null; }
  function currentEdge() { return source && source.type === 'e' ? (edge.gateways.find(function (g) { return g.id === source.id; }) || null) : null; }
  function edgeName(id) { var g = edge.gateways.find(function (x) { return x.id === id; }); return g ? g.name : ''; }
  function rememberAreas(list) {
    list.forEach(function (a) { if (a) areas[a] = true; });
    var dl = S.clear($('#sh-areas'));
    Object.keys(areas).sort(function (a, b) { return a.localeCompare(b); }).forEach(function (a) { dl.appendChild(el('option', { value: a })); });
  }

  // ─── deCONZ cards (as before) ─────────────────

  function catKey(r) { return r.kind === 'sensor' ? 'sensor.' + ((r.capabilities && r.capabilities.reading) || 'unknown') : r.kind; }
  function subLabel(r) { return r.kind === 'sensor' ? T('sensor.' + ((r.capabilities && r.capabilities.reading) || 'unknown')) : T('kind.' + r.kind); }
  function iconSvg(r) { return svg(ICONS[catKey(r)] || ICONS['sensor.unknown']); }
  function cardShell(r) {
    return el('div', { class: 'sh-card', 'data-id': String(r.id) }, [
      el('div', { class: 'sh-name' }, [iconSvg(r), el('span', { text: r.name || '' })]),
      el('div', { class: 'sh-sub', text: subLabel(r) }),
    ]);
  }
  function ownerBlock(r) {
    var names = (r.owners || []).map(function (o) { return o.username; });
    return el('div', null, [
      el('div', { class: 'sh-owner-chips', text: names.length ? names.join(', ') : T('owners.none') }),
      el('button', { type: 'button', class: 'sh-owner-btn', text: T('owners.manage'), on: { click: function () { openOwners({ resource: r }); } } }),
    ]);
  }

  function renderControllable(r) {
    var card = cardShell(r);
    var caps = r.capabilities || {};
    var body = el('div', { class: 'sh-body' });
    var sw = el('button', { type: 'button', class: 'sh-switch' + (r.state && r.state.on ? ' on' : ''), role: 'switch', 'aria-checked': r.state && r.state.on ? 'true' : 'false', 'aria-label': T('power') + ' ' + (r.name || '') }, [el('i')]);
    sw.addEventListener('click', function () {
      var on = !sw.classList.contains('on');
      sw.classList.toggle('on', on); sw.setAttribute('aria-checked', on ? 'true' : 'false');
      send(r.id, { on: on }).catch(function (e) { sw.classList.toggle('on', !on); sw.setAttribute('aria-checked', !on ? 'true' : 'false'); warn(e); });
    });
    body.appendChild(el('div', { class: 'sh-pwr' }, [el('span', { text: T('power') }), sw]));
    if (caps.bri) {
      var range = el('input', { class: 'sh-bri', type: 'range', min: '0', max: '100', value: String(r.state && r.state.bri != null ? Number(r.state.bri) : 0), 'aria-label': T('brightness') });
      range.addEventListener('change', function () { send(r.id, { bri: Number(range.value) }).catch(warn); });
      body.appendChild(el('div', null, [el('div', { class: 'sh-ctl-lbl', text: T('brightness') }), range]));
    }
    if (S.hasColour(caps)) {
      var row = el('div', { class: 'sh-swatches' });
      SWATCHES.forEach(function (s) {
        var dot = el('button', { type: 'button', class: 'sh-sw', 'aria-label': T('color') + ' ' + s.c, style: 'background:' + s.c });
        dot.addEventListener('click', function () { send(r.id, { hue: s.hue, sat: s.sat }).catch(warn); });
        row.appendChild(dot);
      });
      body.appendChild(el('div', null, [el('div', { class: 'sh-ctl-lbl', text: T('color') }), row]));
    }
    if (S.hasWarmth(caps)) {
      var ct = el('input', { class: 'sh-bri', type: 'range', min: '153', max: '500', value: '300', 'aria-label': T('warmth') });
      ct.addEventListener('change', function () { send(r.id, { ct: Number(ct.value) }).catch(warn); });
      body.appendChild(el('div', null, [el('div', { class: 'sh-ctl-lbl', text: T('warmth') }), ct]));
    }
    if (r.kind === 'light' || r.kind === 'plug' || r.kind === 'group') body.appendChild(ownerBlock(r));
    card.appendChild(body);
    return card;
  }

  function renderScene(r) {
    var card = cardShell(r);
    card.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-primary', style: 'margin-top:12px', text: T('activate'),
      on: { click: function () { send(r.id, {}).then(function () { S.toast(T('portal.scene_done', { name: r.name || '' })); }, warn); } } }));
    if (r.owners && r.owners.length) card.appendChild(el('div', { class: 'sh-owner-chips', text: r.owners.map(function (o) { return o.username; }).join(', ') }));
    return card;
  }

  function formatValue(r) {
    var s = r.state || {}; var v = s.value;
    switch (s.type) {
      case 'temperature': return v == null ? '—' : v + ' °C';
      case 'humidity': return v == null ? '—' : v + ' %';
      case 'lightlevel': return v == null ? '—' : v + ' lx';
      case 'presence': return T(v ? 'val.motion' : 'val.idle');
      case 'open': return T(v ? 'val.open' : 'val.closed');
      case 'water': return T(v ? 'val.wet' : 'val.dry');
      default: return v == null ? '—' : String(v);
    }
  }
  function renderSensor(r) {
    var card = cardShell(r);
    card.appendChild(el('div', { class: 'sh-sensorval', text: formatValue(r) }));
    card.appendChild(ownerBlock(r)); // read-only sensor; owners see it in the portal
    return card;
  }
  function renderSwitch(r) { return cardShell(r); }
  function renderDeconz(r) {
    if (r.kind === 'scene') return renderScene(r);
    if (r.kind === 'sensor') return renderSensor(r);
    if (r.kind === 'switch') return renderSwitch(r);
    return renderControllable(r);
  }

  function kpis(list) {
    var host = S.clear($('#smarthome-kpis'));
    list.forEach(function (x) {
      host.appendChild(el('div', { class: 'sh-kpi' }, [el('span', { class: 'l', text: x[0] }), el('span', { class: 'v' + (x[2] ? ' is-warn' : ''), text: String(x[1]) })]));
    });
  }
  function renderKpis(res) {
    var by = function (k) { return res.filter(function (r) { return r.kind === k; }).length; };
    kpis([[T('section.lights'), by('light')], [T('kpi.groups'), by('group') + by('scene')], [T('section.sensors'), by('sensor')]]);
  }
  function section(title, items, renderer) {
    if (!items.length) return null;
    var grid = el('div', { class: 'sh-grid' });
    items.forEach(function (r) { grid.appendChild(renderer(r)); });
    return el('div', null, [el('h2', { class: 'sh-section-title' }, [title, el('span', { class: 'ln', 'aria-hidden': 'true' })]), grid]);
  }
  /** Sections per area (sorted), then — for what has no area — the given kind sections, as before. */
  function grouped(items, areaOf, renderer, kindSections) {
    var named = {};
    var rest = [];
    items.forEach(function (it) { var a = areaOf(it); if (a) (named[a] = named[a] || []).push(it); else rest.push(it); });
    var blocks = Object.keys(named).sort(function (a, b) { return a.localeCompare(b); }).map(function (a) { return section(a, named[a], renderer); });
    return blocks.concat(kindSections(rest)).filter(Boolean);
  }

  function emptyMsg(text) { var host = S.clear($('#smarthome-devices')); host.appendChild(el('div', { class: 'sh-empty', text: text })); }

  function loadResources(gatewayId) {
    if (!gatewayId) { renderKpis([]); emptyMsg(gateways.length || edge.gateways.length ? T('empty') : T('source.deconz_none')); return Promise.resolve(); }
    return S.api('GET', 'resources?gateway_id=' + Number(gatewayId)).then(function (data) {
      if (currentGatewayId() !== gatewayId) return;
      var res = (data.resources || []).filter(function (r) { return r.enabled; });
      deconzRes = res;
      rememberAreas(res.map(function (r) { return r.area; }));
      renderKpis(res);
      var groupArea = {};
      res.forEach(function (r) { if (r.kind === 'group') groupArea[r.deconz_id] = r.area || null; });
      var areaOf = function (r) { return r.kind === 'scene' ? (groupArea[r.capabilities && r.capabilities.group_id != null ? r.capabilities.group_id : String(r.deconz_id).split('/')[0]] || null) : (r.area || null); };
      var blocks = grouped(res, areaOf, renderDeconz, function (rest) {
        return [
          section(T('section.lights'), rest.filter(function (r) { return r.kind === 'light'; }), renderControllable),
          section(T('section.plugs'), rest.filter(function (r) { return r.kind === 'plug'; }), renderControllable),
          section(T('section.groups'), rest.filter(function (r) { return r.kind === 'group' || r.kind === 'scene'; }), function (r) { return r.kind === 'scene' ? renderScene(r) : renderControllable(r); }),
          section(T('section.switches'), rest.filter(function (r) { return r.kind === 'switch'; }), renderSwitch),
          section(T('section.sensors'), rest.filter(function (r) { return r.kind === 'sensor'; }), renderSensor),
        ];
      });
      var host = S.clear($('#smarthome-devices'));
      if (!blocks.length) { emptyMsg(T('empty')); return; }
      blocks.forEach(function (b) { host.appendChild(b); });
    }, function () { emptyMsg(T('load_error')); });
  }

  // ─── Shelly / Tasmota cards ───────────────────

  function prettyModel(d) {
    var m = d.model || '';
    if (d.family === 'tasmota') return T('family.short.tasmota');
    if (d.family === 'shelly1') return GEN1[m] || (m ? 'Shelly ' + m : T('family.short.shelly1'));
    if (!m) return T('family.short.shelly2');
    return 'Shelly ' + m.replace(/^Shelly\s*/i, '').replace(/([a-z])([A-Z0-9])/g, '$1 $2');
  }
  function kindText(r) {
    if (!r) return '';
    if (r.kind === 'cover') return T('cover.' + ((r.capabilities && r.capabilities.cover) || 'shutter'));
    if (r.kind === 'sensor') return T('device.sensor');
    return T('kind.' + r.kind);
  }
  function fmt(n, digits) {
    var v = Number(n);
    return isFinite(v) ? v.toLocaleString(S.CTX.lang === 'en' ? 'en-GB' : 'de-DE', { maximumFractionDigits: digits == null ? 1 : digits }) : '–';
  }
  function coverText(st) {
    if (st.moving === 'opening' || st.moving === 'closing') return T('cover.' + st.moving);
    if (st.pos != null) return Number(st.pos) <= 0 ? T('cover.closed') : T('cover.pos_open', { pos: fmt(st.pos, 0) });
    return '–';
  }
  function bigValue(label, value) {
    return el('div', { class: 'sh-val' }, [el('div', { class: 'sh-ctl-lbl', text: label }), el('div', { class: 'sh-val-v', text: value })]);
  }
  function pill(text, tone) { return el('span', { class: 'sh-pill' + (tone ? ' is-' + tone : ''), text: text }); }
  function ownersText(list) { var n = (list || []).map(function (o) { return o.username; }); return n.length ? n.join(', ') : T('owners.none'); }

  function edgeCard(it) {
    var d = it.device, r = it.resource;
    var name = r ? r.name : d.name;
    var st = (r && r.state) || {};
    var reachable = d.reachable && st.reachable !== false;
    var off = !reachable && !d.waiting;
    var icon = r ? (ICONS[r.kind === 'sensor' ? 'sensor.temperature' : r.kind] || ICONS.light) : ICONS['sensor.unknown'];
    var subParts = [prettyModel(d)];
    if (r) subParts.push(kindText(r));
    if (r && r.kind === 'sensor' && st.battery != null) subParts.push(T('card.battery', { pct: fmt(st.battery, 0) }));
    var head = el('div', null, [el('div', { class: 'sh-name' }, [svg(icon), el('span', { text: name || '' })]), el('div', { class: 'sh-sub', text: subParts.join(' · ') })]);
    var right = null;
    var switchable = r && (r.kind === 'light' || r.kind === 'plug' || r.kind === 'relay');
    if (d.waiting) right = pill(T('card.waiting'), 'info');
    else if (off) right = pill(T('card.unreachable'), 'warn');
    else if (switchable) {
      var on = !!st.on;
      var sw = el('button', { type: 'button', class: 'sh-switch' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', 'aria-label': name || T('power') }, [el('i')]);
      sw.addEventListener('click', function () {
        var next = sw.getAttribute('aria-pressed') !== 'true';
        sw.classList.toggle('on', next); sw.setAttribute('aria-pressed', next ? 'true' : 'false');
        send(r.id, { on: next }).catch(function (e) { sw.classList.toggle('on', !next); sw.setAttribute('aria-pressed', !next ? 'true' : 'false'); warn(e); });
      });
      right = sw;
    }
    var card = el('div', { class: 'sh-card sh-ecard' + (off ? ' is-off' : ''), 'data-id': r ? String(r.id) : 'd' + d.id }, [el('div', { class: 'sh-row' }, [head, right])]);
    var body = el('div', { class: 'sh-ebody' });
    if (d.waiting) body.appendChild(el('span', { class: 'sh-sub', text: T('card.waiting_text') }));
    else if (off) {
      body.appendChild(el('span', { class: 'sh-sub', text: d.online === false && d.channels.length ? T('card.offline') : T('card.silent', { dur: d.last_seen_at ? S.since(d.last_seen_at, true) : '–' }) }));
    } else if (r.kind === 'cover') {
      var pos = st.pos == null ? null : Math.max(0, Math.min(100, Number(st.pos)));
      var bar = el('div', { class: 'sh-bar', role: 'progressbar', 'aria-label': T('cover.position'), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': pos == null ? null : String(pos), 'aria-valuetext': coverText(st) }, [el('i', { style: 'width:' + (pos == null ? 0 : pos) + '%' })]);
      body.appendChild(el('div', null, [el('div', { class: 'sh-ctl-lbl' }, [el('span', { text: T('cover.position') }), el('span', { text: coverText(st) })]), bar]));
      var seg = el('div', { class: 'sh-seg', role: 'group', 'aria-label': T('cover.controls_of', { name: name }) });
      ['open', 'stop', 'close'].forEach(function (op) {
        seg.appendChild(el('button', { type: 'button', class: 'btn sh-seg-btn', text: T('cover.' + op), on: { click: function () { send(r.id, { cover: op }).then(function () { S.toast(T('cover.done_' + op, { name: name })); }, warn); } } }));
      });
      body.appendChild(seg);
    } else if (r.kind === 'sensor') {
      var vals = el('div', { class: 'sh-vals' });
      if (st.type === 'temperature' && st.value != null) vals.appendChild(bigValue(T('card.temperature'), fmt(st.value) + ' °C'));
      if (st.humidity != null) vals.appendChild(bigValue(T('card.humidity'), fmt(st.humidity, 0) + ' %'));
      body.appendChild(vals);
      if (d.last_seen_at) body.appendChild(el('span', { class: 'sh-sub', text: T('card.last_seen', { ago: S.since(d.last_seen_at) }) }));
    } else {
      if (r.kind === 'light' && r.capabilities && r.capabilities.bri) {
        var bri = st.bri != null ? Number(st.bri) : 100;
        var lbl = el('span', { text: st.on ? fmt(bri, 0) + ' %' : T('portal.off') });
        var range = el('input', { class: 'sh-bri', type: 'range', min: '1', max: '100', value: String(bri), 'aria-label': T('portal.brightness_of', { name: name }) });
        range.addEventListener('input', function () { lbl.textContent = range.value + ' %'; });
        range.addEventListener('change', function () { send(r.id, { bri: Number(range.value), on: true }).catch(warn); });
        body.appendChild(el('div', null, [el('div', { class: 'sh-ctl-lbl' }, [el('span', { text: T('brightness') }), lbl]), range]));
        if (st.power != null) body.appendChild(el('span', { class: 'sh-sub', text: fmt(st.power, 0) + ' W' }));
      } else if (r.capabilities && r.capabilities.power) {
        var pv = el('div', { class: 'sh-vals sh-vals-2' }, [bigValue(T('card.power'), st.power != null ? fmt(st.power, 0) + ' W' : '–')]);
        if (st.energy_today != null) pv.appendChild(bigValue(T('card.today'), fmt(st.energy_today, 1) + ' kWh'));
        body.appendChild(pv);
      }
    }
    if (body.firstChild) card.appendChild(body);
    card.appendChild(el('div', { class: 'sh-card-foot' }, [
      el('span', { class: 'sh-owner-chips', text: ownersText(r ? r.owners : []) }),
      el('button', { type: 'button', class: 'sh-owner-btn', text: T('card.edit'), 'aria-label': T('card.edit_of', { name: name || '' }), on: { click: function () { openDevice(d.id); } } }),
    ]));
    return card;
  }

  function renderEdge() {
    var items = [];
    edgeDevices.forEach(function (d) {
      if (!d.resources.length) items.push({ device: d, resource: null });
      else d.resources.forEach(function (r) { items.push({ device: d, resource: r }); });
    });
    rememberAreas(edgeDevices.map(function (d) { return d.area; }));
    var switchable = items.filter(function (it) { return it.resource && ['light', 'plug', 'relay'].indexOf(it.resource.kind) >= 0; });
    var on = switchable.filter(function (it) { return it.device.reachable && it.resource.state && it.resource.state.on; }).length;
    var power = 0;
    var metered = false;
    items.forEach(function (it) { var p = it.resource && it.resource.state && it.resource.state.power; if (it.device.reachable && p != null && isFinite(p)) { power += Number(p); metered = true; } });
    var unreachable = edgeDevices.filter(function (d) { return !d.reachable && !d.waiting; }).length;
    kpis([[T('kpi.devices'), edgeDevices.length], [T('kpi.on'), on], [T('kpi.power'), metered ? fmt(power, 0) + ' W' : '–'], [T('kpi.unreachable'), unreachable, unreachable > 0]]);
    var kindOf = function (it) { return it.resource ? it.resource.kind : 'waiting'; };
    var blocks = grouped(items, function (it) { return it.device.area || null; }, edgeCard, function (rest) {
      var of = function (k) { return rest.filter(function (it) { return kindOf(it) === k; }); };
      return [
        section(T('section.covers'), of('cover'), edgeCard),
        section(T('section.lights'), of('light'), edgeCard),
        section(T('section.plugs'), of('plug'), edgeCard),
        section(T('section.relays'), of('relay'), edgeCard),
        section(T('section.sensors'), of('sensor'), edgeCard),
        section(T('section.waiting'), of('waiting'), edgeCard),
      ];
    });
    var host = S.clear($('#smarthome-devices'));
    if (!blocks.length) { emptyMsg(T('edge.empty')); return; }
    blocks.forEach(function (b) { host.appendChild(b); });
  }

  function loadEdge(id) {
    return S.api('GET', 'edge/devices?gateway_id=' + Number(id)).then(function (data) {
      if (!source || source.type !== 'e' || source.id !== id) return;
      edgeDevices = data.devices || [];
      renderEdge();
    }, function () { kpis([]); emptyMsg(T('load_error')); });
  }

  function candidateLabel(c) {
    if (c.family === 'tasmota') return c.name ? T('family.short.tasmota') + ' „' + c.name + '“' : T('family.short.tasmota');
    return prettyModel({ family: c.family, model: c.model });
  }
  function renderFound() {
    var box = $('#sh-found');
    var g = currentEdge();
    if (!g || !found.length) { box.hidden = true; return; }
    var text = S.clear($('#sh-found-text'));
    text.appendChild(el('strong', { text: found.length === 1 ? T('found.banner_one') : T('found.banner', { count: found.length }) }));
    var names = found.slice(0, 4).map(function (c) { return candidateLabel(c) + ' (' + c.ip + ')'; });
    var list = names.length > 1 ? names.slice(0, -1).join(', ') + ' ' + T('found.and') + ' ' + names[names.length - 1] : names[0];
    text.appendChild(document.createTextNode(' ' + list + (found.length > 4 ? ', …' : '') + '.'));
    box.hidden = false;
  }
  function loadFound(id, ask) {
    return S.api('GET', 'edge/found?gateway_id=' + Number(id) + (ask ? '&ask=1' : '')).then(function (r) {
      if (!source || source.type !== 'e' || source.id !== id) return;
      found = r.devices || [];
      renderFound();
      if (!$('#sh-add-modal').hidden && Number($('#sh-a-gateway').value) === id) renderAddFound(false);
    }, function () { /* the hint stays as it was */ });
  }

  // ─── Sources ──────────────────────────────────

  function stateText(g) {
    if (g.state === 'running') {
      var parts = [T('source.running')];
      if (g.info && g.info.mqtt) parts.push(T('source.mqtt.' + (['ok', 'off', 'error', 'starting'].indexOf(g.info.mqtt) >= 0 ? g.info.mqtt : 'error')));
      return parts.join(' · ');
    }
    if (g.tooOld || g.state === 'gateway_too_old') return T('source.state.too_old', { version: g.version || '?', min: edge.minGateway || '1.19.0' });
    if (g.state === 'disabled' || g.state === 'edge_off' || g.state === 'no_edge') return T('source.state.off');
    if (['offline', 'crashed', 'update_pending', 'unsigned', 'plugin_off', 'denied', 'stopped'].indexOf(g.state) >= 0) return T('source.state.' + g.state);
    return T('source.state.pending');
  }
  function shortState(g) {
    if (g.state === 'running') return '';
    if (g.state === 'disabled' || g.state === 'edge_off' || g.state === 'no_edge') return T('gateway.off');
    return stateText(g).replace(/[.…]+$/, '').slice(0, 40);
  }

  function renderInfo() {
    var info = $('#sh-gwinfo');
    var g = currentGateway();
    var e = currentEdge();
    if (g) info.textContent = T('connect.target') + ': ' + (g.target_label || T('gateway.no_target')) + ' · ' + T('gateway.last_seen') + ': ' + (g.last_seen_at || T('gateway.never'));
    else if (e) {
      var parts = [T('source.via', { name: e.name })];
      if (e.state === 'running') {
        if (e.info && e.info.mqtt) parts.push(T('source.mqtt.' + (['ok', 'off', 'error', 'starting'].indexOf(e.info.mqtt) >= 0 ? e.info.mqtt : 'error')));
        if (e.info && e.info.startedAt) parts.push(T('source.since', { dur: S.since(e.info.startedAt, true) }));
      } else parts.push(stateText(e));
      info.textContent = parts.join(' · ');
    } else info.textContent = '';
    var isEdge = !!e;
    $$('[data-for="deconz"]').forEach(function (b) { b.hidden = isEdge || !g; b.disabled = !g; });
    $$('[data-for="edge"]').forEach(function (b) { b.hidden = !isEdge; b.disabled = !e || e.state !== 'running'; });
    $('#sh-source-open').classList.toggle('btn-primary', !isEdge);
    $('#sh-test-result').hidden = true;
    if (!isEdge) $('#sh-found').hidden = true;
  }

  function loadView() {
    renderInfo();
    if (source && source.type === 'e') {
      found = [];
      renderFound();
      var id = source.id;
      return loadEdge(id).then(function () {
        var e = currentEdge();
        if (e && e.state === 'running') { loadFound(id, false).then(function () { return loadFound(id, true); }); }
      });
    }
    return loadResources(currentGatewayId());
  }

  function loadGateways(select) {
    return Promise.all([
      S.api('GET', 'gateways').catch(function () { return { gateways: [] }; }),
      S.api('GET', 'targets').catch(function () { return { targets: [] }; }),
      S.api('GET', 'edge/gateways').catch(function () { return { available: false, gateways: [] }; }),
    ]).then(function (out) {
      gateways = out[0].gateways || [];
      targets = out[1].targets || [];
      edge = out[2] && typeof out[2] === 'object' ? out[2] : { available: false, gateways: [] };
      edge.gateways = edge.gateways || [];
      var sel = S.clear($('#sh-gateway-select'));
      if (gateways.length) {
        var g1 = el('optgroup', { label: T('source.group_deconz') });
        gateways.forEach(function (g) { g1.appendChild(el('option', { value: 'd:' + g.id, text: g.name + (g.enabled ? '' : ' (' + T('gateway.off') + ')') })); });
        sel.appendChild(g1);
      }
      if (edge.gateways.length) {
        var g2 = el('optgroup', { label: T('source.group_edge') });
        edge.gateways.forEach(function (g) { var s = shortState(g); g2.appendChild(el('option', { value: 'e:' + g.id, text: g.name + (s ? ' (' + s + ')' : '') })); });
        sel.appendChild(g2);
      }
      sel.hidden = !gateways.length && !edge.gateways.length;
      var want = select || (source ? source.type + ':' + source.id : null);
      var values = $$('option', sel).map(function (o) { return o.value; });
      if (!want || values.indexOf(want) < 0) {
        var d = gateways.find(function (g) { return g.enabled; }) || gateways[0];
        var e = edge.gateways.find(function (g) { return g.state === 'running'; }) || edge.gateways[0];
        want = d ? 'd:' + d.id : (e ? 'e:' + e.id : null);
      }
      if (want) sel.value = want;
      var m = /^([de]):(\d+)$/.exec(want || '');
      source = m ? { type: m[1], id: Number(m[2]) } : null;
      return loadView();
    });
  }

  function fillTargets(select, current) {
    S.clear(select);
    targets.forEach(function (a) { select.appendChild(el('option', { value: String(a.index), text: a.label })); });
    if (current != null) select.value = String(current);
    select.disabled = !targets.length;
  }

  // Live values: the plugin polls deCONZ and gets the edge part's reports in the background; mirror that here.
  // Paused while hidden, while a control is focused or a dialog is open.
  setInterval(function () {
    if (document.hidden) return;
    var ae = document.activeElement;
    if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    if ($$('.modal-overlay').some(function (m) { return !m.hidden; })) return;
    if (source && source.type === 'e') { loadEdge(source.id); loadFound(source.id, false); } else if (currentGatewayId()) loadResources(currentGatewayId());
  }, 30000);

  $('#sh-gateway-select').addEventListener('change', function () {
    var m = /^([de]):(\d+)$/.exec($('#sh-gateway-select').value);
    source = m ? { type: m[1], id: Number(m[2]) } : null;
    loadView();
  });

  // ─── deCONZ toolbar and dialogs (as before) ───

  $('#sh-connect-open').addEventListener('click', function () {
    S.closeModal('sh-source-modal');
    fillTargets($('#sh-c-target'), null);
    var hint = $('#sh-c-target-hint');
    hint.textContent = targets.length ? T('connect.target_hint') : T('connect.no_targets');
    $('#sh-c-submit').disabled = !targets.length;
    S.openModal('sh-connect-modal');
  });
  $('#sh-c-submit').addEventListener('click', function () {
    var btn = $('#sh-c-submit');
    var body = { name: $('#sh-c-name').value.trim(), target_index: Number($('#sh-c-target').value), apiKey: $('#sh-c-key').value.trim() || undefined };
    btn.disabled = true;
    S.api('POST', 'gateways', body).then(function (r) {
      S.closeModal('sh-connect-modal');
      $('#sh-c-key').value = '';
      return loadGateways(r.gateway && r.gateway.id ? 'd:' + r.gateway.id : null);
    }, warn).then(function () { btn.disabled = false; });
  });

  $('#sh-sync').addEventListener('click', function () {
    var id = currentGatewayId(); if (!id) return;
    var btn = $('#sh-sync'); btn.disabled = true;
    S.api('POST', 'gateways/' + id + '/sync').then(function (r) {
      S.toast(T('sync.done', r.counts || {}));
      return loadGateways('d:' + id);
    }, warn).then(function () { btn.disabled = false; });
  });

  $('#sh-test').addEventListener('click', function () {
    var id = currentGatewayId(); if (!id) return;
    var out = $('#sh-test-result');
    out.hidden = false; out.removeAttribute('data-tone'); out.textContent = '…';
    S.api('POST', 'gateways/' + id + '/test').then(function (d) {
      if (d.reachable) {
        out.setAttribute('data-tone', 'good');
        out.textContent = '✓ ' + T('test_ok') + (d.target ? ' (' + d.target + ')' : '') + (d.config && d.config.swversion ? ' · deCONZ ' + d.config.swversion : '');
      } else {
        out.setAttribute('data-tone', 'error');
        out.textContent = '✗ ' + T('test_fail') + (d.code ? ': ' + d.code : '');
      }
    }, function (e) { out.setAttribute('data-tone', 'error'); out.textContent = '✗ ' + ((e && e.message) || T('common.error')); });
  });

  $('#sh-edit').addEventListener('click', function () {
    var g = currentGateway(); if (!g) return;
    $('#sh-e-name').value = g.name;
    fillTargets($('#sh-e-target'), g.target_index);
    $('#sh-e-key').value = '';
    $('#sh-e-enabled').checked = !!g.enabled;
    S.openModal('sh-edit-modal');
  });
  $('#sh-e-save').addEventListener('click', function () {
    var g = currentGateway(); if (!g) return;
    var body = { name: $('#sh-e-name').value.trim(), enabled: $('#sh-e-enabled').checked };
    if (targets.length) body.target_index = Number($('#sh-e-target').value);
    if ($('#sh-e-key').value.trim()) body.apiKey = $('#sh-e-key').value.trim();
    S.api('PUT', 'gateways/' + g.id, body).then(function () { S.closeModal('sh-edit-modal'); S.toast(T('gateway.saved')); return loadGateways('d:' + g.id); }, warn);
  });
  $('#sh-e-remove').addEventListener('click', function () {
    var g = currentGateway(); if (!g) return;
    S.confirm(T('gateway.remove_confirm', { name: g.name }), T('gateway.remove'), true).then(function (ok) {
      if (!ok) return null;
      return S.api('DELETE', 'gateways/' + g.id).then(function () { S.closeModal('sh-edit-modal'); source = null; return loadGateways(); }, warn);
    });
  });

  // ─── Owners (deCONZ resource with its area, or every resource of a Shelly / Tasmota device) ───

  function fetchUsers() {
    if (allUsers) return Promise.resolve(allUsers);
    return S.api('GET', 'users').then(function (r) { allUsers = r.users || []; return allUsers; }, function () { return []; });
  }
  function deviceOwners(d) {
    var seen = {};
    var out = [];
    d.resources.forEach(function (r) { (r.owners || []).forEach(function (o) { if (!seen[o.id]) { seen[o.id] = true; out.push(o); } }); });
    return out;
  }
  function openOwners(target) {
    ownerTarget = target;
    var r = target.resource;
    var d = target.device;
    $('#sh-owner-sub').textContent = r ? (r.name || '') : d.name;
    $('#sh-owner-area-row').hidden = !r;
    $('#sh-owner-area').value = r ? (r.area || '') : '';
    $('#sh-owner-search').value = '';
    var current = r ? (r.owners || []) : deviceOwners(d);
    fetchUsers().then(function (users) {
      var owned = {}; current.forEach(function (o) { owned[o.id] = true; });
      var list = S.clear($('#sh-owner-list'));
      users.forEach(function (u) {
        var cb = el('input', { type: 'checkbox', value: String(u.id), checked: !!owned[u.id] });
        list.appendChild(el('label', { class: 'sh-owner-row', 'data-name': String(u.username || '').toLowerCase() }, [cb, el('span', { text: u.username })]));
      });
      S.openModal('sh-owner-modal');
    });
  }
  $('#sh-owner-search').addEventListener('input', function () {
    var q = $('#sh-owner-search').value.toLowerCase();
    $$('#sh-owner-list .sh-owner-row').forEach(function (row) { row.hidden = row.getAttribute('data-name').indexOf(q) < 0; });
  });
  $('#sh-owner-save').addEventListener('click', function () {
    var target = ownerTarget;
    if (!target) return;
    var ids = $$('#sh-owner-list input:checked').map(function (c) { return Number(c.value); });
    if (target.device) {
      S.api('PUT', 'edge/devices/' + target.device.id + '/owners', { userIds: ids }).then(function () {
        S.closeModal('sh-owner-modal');
        if (!$('#sh-device-modal').hidden) openDevice(target.device.id, true);
        return loadView();
      }, warn);
      return;
    }
    var r = target.resource;
    var area = $('#sh-owner-area').value.trim();
    S.api('PUT', 'resources/' + r.id + '/owners', { userIds: ids }).then(function () {
      return area === (r.area || '') ? null : S.api('PUT', 'resources/' + r.id, { area: area || null });
    }).then(function () {
      S.closeModal('sh-owner-modal');
      return loadResources(currentGatewayId());
    }, warn);
  });

  // ─── Quelle hinzufügen ────────────────────────

  function gatewayLink(g, label) {
    var a = el('a', { class: 'btn btn-sm', href: '/gateways#gw/' + g.id + '/edge', target: '_top', text: label });
    a.addEventListener('click', function () { S.toast(T('source.where', { name: g.name })); });
    return a;
  }
  $('#sh-source-open').addEventListener('click', function () {
    var list = S.clear($('#sh-s-list'));
    $('#sh-s-lead').hidden = !edge.available;
    if (!edge.available) list.appendChild(el('li', { class: 'sh-gw-row' }, [el('span', { class: 'sh-sub', text: T('source.unavailable') })]));
    else if (!edge.gateways.length) list.appendChild(el('li', { class: 'sh-gw-row' }, [el('span', { class: 'sh-sub', text: T('source.none') })]));
    edge.gateways.forEach(function (g) {
      var right;
      if (g.state === 'running') right = pill(T('source.connected'), 'good');
      else if (g.tooOld || g.state === 'gateway_too_old') right = gatewayLink(g, T('source.update'));
      else if (g.state === 'disabled' || g.state === 'edge_off' || g.state === 'no_edge') right = gatewayLink(g, T('source.enable'));
      else right = gatewayLink(g, T('source.open_gateway'));
      list.appendChild(el('li', { class: 'sh-gw-row' }, [
        el('span', { class: 'sh-gw-text' }, [el('strong', { text: g.name }), el('span', { class: 'sh-sub', text: stateText(g) })]), right,
      ]));
    });
    S.openModal('sh-source-modal', '.modal-close');
  });

  // ─── Gerät hinzufügen ─────────────────────────

  var suggested = '';
  function addCandidate() {
    var r = $('input[name="sh-a-dev"]:checked');
    if (!r || r.value === 'other') return null;
    return found.find(function (c) { return c.ip === r.value; }) || null;
  }
  function suggestName() {
    var c = addCandidate();
    var name = $('#sh-a-name');
    if (name.value.trim() && name.value !== suggested) return;
    suggested = c ? (c.name || candidateLabel(c)) : '';
    name.value = suggested;
  }
  function addButtons() {
    var g = edge.gateways.find(function (x) { return x.id === Number($('#sh-a-gateway').value); });
    var ok = !!g && g.state === 'running';
    $('#sh-a-auto').disabled = !ok || !addCandidate();
    $('#sh-a-manual').disabled = !ok;
  }
  function renderAddFound(searching) {
    var host = S.clear($('#sh-a-found'));
    var before = $('input[name="sh-a-dev"]:checked');
    var keep = before ? before.value : null;
    var opt = function (value, title, sub, tag) {
      var input = el('input', { type: 'radio', name: 'sh-a-dev', value: value });
      input.addEventListener('change', function () { suggestName(); addButtons(); });
      return el('label', { class: 'sh-opt' }, [input, el('span', { class: 'sh-opt-text' }, [el('strong', { text: title }), sub ? el('span', { class: 'sh-sub', text: sub }) : null]), tag ? el('span', { class: 'sh-opt-tag', text: tag }) : null]);
    };
    found.forEach(function (c) {
      var sub = [c.host || c.id, c.ip, c.firmware ? T('add.firmware', { v: c.firmware }) : null].filter(Boolean).join(' · ');
      host.appendChild(opt(c.ip, candidateLabel(c), sub, T('add.auto')));
    });
    if (!found.length) host.appendChild(el('p', { class: 'sh-sub', text: searching ? T('add.searching') : T('add.none_found') }));
    host.appendChild(opt('other', T('add.other'), T('add.other_hint'), null));
    var sel = keep && $('input[name="sh-a-dev"][value="' + (/^[\d.]+$|^other$/.test(keep) ? keep : 'other') + '"]');
    (sel || $('input[name="sh-a-dev"]')).checked = true;
    suggestName();
    addButtons();
  }
  function openAdd() {
    var sel = S.clear($('#sh-a-gateway'));
    var running = edge.gateways.filter(function (g) { return g.state === 'running'; });
    running.forEach(function (g) { sel.appendChild(el('option', { value: String(g.id), text: g.name })); });
    if (source && source.type === 'e' && running.some(function (g) { return g.id === source.id; })) sel.value = String(source.id);
    sel.disabled = running.length < 2;
    $('#sh-a-name').value = '';
    $('#sh-a-area').value = '';
    suggested = '';
    var err = $('#sh-a-error');
    err.hidden = !!running.length;
    err.textContent = running.length ? '' : T('add.no_gateway');
    renderAddFound(true);
    S.openModal('sh-add-modal', running.length ? 'input[name="sh-a-dev"]:checked' : '.modal-close');
    if (running.length) loadFound(Number(sel.value), true).then(function () { renderAddFound(false); });
  }
  $('#sh-add-open').addEventListener('click', openAdd);
  $('#sh-found-open').addEventListener('click', openAdd);
  $('#sh-a-gateway').addEventListener('change', function () {
    var id = Number($('#sh-a-gateway').value);
    found = [];
    renderAddFound(true);
    S.api('GET', 'edge/found?gateway_id=' + id + '&ask=1').then(function (r) { found = r.devices || []; renderAddFound(false); }, function () { renderAddFound(false); });
  });
  function addForm() {
    var name = $('#sh-a-name').value.trim();
    var err = $('#sh-a-error');
    if (!name) { err.textContent = T('add.name_required'); err.hidden = false; $('#sh-a-name').focus(); return null; }
    err.hidden = true;
    return { gateway_id: Number($('#sh-a-gateway').value), name: name, area: $('#sh-a-area').value.trim() || null, candidate: addCandidate() };
  }
  $('#sh-a-auto').addEventListener('click', function () {
    var f = addForm();
    if (!f || !f.candidate) return;
    var btn = $('#sh-a-auto'); btn.disabled = true;
    S.api('POST', 'edge/setup', f).then(function (r) {
      S.closeModal('sh-add-modal');
      openJob(r.job, { name: f.name, model: candidateLabel(f.candidate), ip: f.candidate.ip, gateway: edgeName(f.gateway_id) });
    }, warn).then(function () { btn.disabled = false; });
  });
  $('#sh-a-manual').addEventListener('click', function () {
    var f = addForm();
    if (!f) return;
    var btn = $('#sh-a-manual'); btn.disabled = true;
    f.family = f.candidate ? f.candidate.family : 'shelly2';
    S.api('POST', 'edge/devices', f).then(function (r) {
      S.closeModal('sh-add-modal');
      openManual(r.device.id, f.name, r.credentials);
    }, warn).then(function () { btn.disabled = false; });
  });

  // ─── Automatisch einrichten (steps, live) ─────

  var job = null;
  var jobCtx = {};
  var jobTimer = null;
  var jobLeaving = false;
  function stepIcon(state) {
    var key = state === 'skipped' ? 'done' : state === 'slow' ? 'running' : (STEP_ICONS[state] ? state : 'pending');
    return el('span', { class: 'sh-step-ico' }, [svg(STEP_ICONS[key], 14, 'sh-ico' + (state === 'running' ? ' sh-spin' : ''))]);
  }
  function stepRow(state, title, details) {
    return el('li', { class: 'sh-step', 'data-state': state }, [stepIcon(state), el('span', { class: 'sh-step-text' }, [el('strong', { text: title })].concat(details || []))]);
  }
  function renderJob() {
    if (!job) return;
    var s = {};
    job.steps.forEach(function (x) { s[x.id] = x; });
    $('#sh-j-title').textContent = T('auto.title', { name: jobCtx.name || job.name || '' });
    $('#sh-j-sub').textContent = [jobCtx.model, jobCtx.ip || job.ip, T('auto.via', { name: jobCtx.gateway || edgeName(job.gatewayId) })].filter(Boolean).join(' · ');
    var list = S.clear($('#sh-j-steps'));
    var d = function (text) { return el('span', { class: 'sh-sub', text: text }); };
    var a = s.account;
    list.appendChild(stepRow(a.state, a.state === 'done' ? T('auto.step.account') : T('auto.step.account_run'), a.state === 'done' ? [d(T('auto.step.account_detail', { user: a.username, topic: a.topic }))] : []));
    var r = s.reach;
    var reachDetail = r.state === 'done' ? [r.model ? prettyModel({ family: job.family, model: r.model }) : null, r.firmware ? T('auto.step.reach_detail_fw', { v: r.firmware }) : null, r.ident ? T('auto.step.reach_detail_id', { v: r.ident }) : null].filter(Boolean).join(' · ') : '';
    list.appendChild(stepRow(r.state, r.state === 'done' ? T('auto.step.reach') : r.state === 'error' ? T('auto.step.reach_error') : T('auto.step.reach_run'), reachDetail ? [d(reachDetail)] : (r.state === 'error' ? [d(T('auto.error.' + r.code) !== 'auto.error.' + r.code ? T('auto.error.' + r.code) : T('auto.error'))] : [])));
    var au = s.auth;
    if (au.state === 'need' || au.state === 'running') {
      var input = el('input', { class: 'form-input', type: 'password', id: 'sh-j-password', autocomplete: 'off', spellcheck: 'false', maxlength: '128', disabled: au.state === 'running' });
      var go = el('button', { type: 'button', class: 'btn btn-primary', text: T('auto.continue'), disabled: au.state === 'running' });
      var submit = function () {
        var pw = input.value;
        input.value = '';
        if (!pw) { input.focus(); return; }
        go.disabled = true;
        S.api('POST', 'edge/setup/' + encodeURIComponent(job.id) + '/password', { password: pw }).then(function (res) { job = res.job; renderJob(); pollJob(); }, function (e) { go.disabled = false; warn(e); });
      };
      go.addEventListener('click', submit);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      var details = [d(T('auto.step.auth_detail'))];
      if (au.code === 'auth_failed') details.push(el('span', { class: 'sh-form-error', role: 'alert', text: T('auto.step.auth_failed') }));
      details.push(el('div', { class: 'sh-pw-row' }, [el('label', { class: 'sr-only', for: 'sh-j-password', text: T('auto.password') }), input, go]));
      list.appendChild(stepRow(au.state === 'running' ? 'running' : 'need', T('auto.step.auth'), details));
      if (au.state === 'need') setTimeout(function () { if (document.activeElement === document.body || !$('#sh-auto-modal').contains(document.activeElement) || document.activeElement.id === 'sh-j-cancel') input.focus(); }, 30);
    } else if (au.state === 'skipped') list.appendChild(stepRow('done', T('auto.step.auth_none')));
    else if (au.state === 'done') list.appendChild(stepRow('done', T('auto.step.auth_done')));
    var c = s.configure;
    list.appendChild(stepRow(c.state, T('auto.step.configure'), [d(c.state === 'error' ? (T('auto.error.' + c.code) !== 'auto.error.' + c.code ? T('auto.error.' + c.code) : T('auto.error')) : T('auto.step.configure_detail'))]));
    var o = s.online;
    list.appendChild(stepRow(o.state, T('auto.step.online'), [d(o.state === 'slow' ? T('auto.step.online_slow') : T('auto.step.online_detail'))]));
    var prefix = a.topic ? String(a.topic).replace(/\/#$/, '') : '';
    $('#sh-j-what').textContent = T('auto.what_text', { prefix: prefix || '…' });
    var err = $('#sh-j-error');
    err.hidden = job.state !== 'failed';
    err.textContent = job.state === 'failed' ? (T('auto.error.' + job.error) !== 'auto.error.' + job.error ? T('auto.error.' + job.error) : T('auto.error')) : '';
    var finished = job.state === 'done' || job.state === 'waiting' || job.state === 'slow';
    $('#sh-j-done').hidden = !finished;
    $('#sh-j-cancel').hidden = finished;
    $('#sh-j-manual').hidden = finished;
  }
  function pollJob() {
    clearTimeout(jobTimer);
    if (!job || $('#sh-auto-modal').hidden) return;
    if (['running', 'waiting'].indexOf(job.state) < 0 && !(job.steps.some(function (x) { return x.state === 'running'; }))) return;
    jobTimer = setTimeout(function () {
      S.api('GET', 'edge/setup/' + encodeURIComponent(job.id)).then(function (r) { job = r.job; renderJob(); pollJob(); }, function () { pollJob(); });
    }, 1000);
  }
  function openJob(j, ctx) {
    job = j;
    jobCtx = ctx || {};
    jobLeaving = false;
    renderJob();
    S.openModal('sh-auto-modal', '#sh-j-cancel');
    pollJob();
  }
  function leaveJob(cancel) {
    var j = job;
    jobLeaving = true;
    clearTimeout(jobTimer);
    S.closeModal('sh-auto-modal');
    job = null;
    var p = cancel && j && ['done', 'waiting', 'slow'].indexOf(j.state) < 0 ? S.api('DELETE', 'edge/setup/' + encodeURIComponent(j.id)).catch(function () { return null; }) : Promise.resolve();
    return p.then(function () { return loadView(); });
  }
  $('#sh-j-cancel').addEventListener('click', function () { leaveJob(true); });
  $('#sh-j-x').addEventListener('click', function () { leaveJob(true); });
  $('#sh-j-done').addEventListener('click', function () { leaveJob(false); });
  $('#sh-auto-modal').addEventListener('sh:close', function () { if (!jobLeaving) leaveJob(true); });
  $('#sh-j-manual').addEventListener('click', function () {
    var j = job;
    if (!j) return;
    S.api('POST', 'edge/setup/' + encodeURIComponent(j.id) + '/manual').then(function (r) {
      jobLeaving = true;
      clearTimeout(jobTimer);
      S.closeModal('sh-auto-modal');
      job = null;
      openManual(r.device.id, jobCtx.name || j.name, r.credentials);
    }, warn);
  });

  // ─── Von Hand einrichten ──────────────────────

  var manual = null; // { id, name, cred, timer, arrived } — the password only while this dialog is open
  function kvRow(label, value, opts) {
    var o = opts || {};
    var v = el('span', { class: 'sh-kv-v', text: value });
    var copy = el('button', { type: 'button', class: 'btn btn-sm', text: T('manual.copy'), 'aria-label': T('manual.copy_of', { label: label }), disabled: !!o.noCopy });
    copy.addEventListener('click', function () {
      S.copyText(value).then(function (ok) {
        if (ok) { copy.textContent = T('manual.copied'); setTimeout(function () { copy.textContent = T('manual.copy'); }, 1500); return; }
        var range = document.createRange(); range.selectNodeContents(v);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        S.toast(T('manual.copy_failed'), 'error');
      });
    });
    return el('div', { class: 'sh-kv' + (o.key ? ' is-key' : '') }, [el('span', { class: 'sh-kv-k', text: label }), v, copy]);
  }
  function renderManual() {
    if (!manual) return;
    var c = manual.cred;
    var fam = c.family;
    $('#sh-m-title').textContent = T('manual.title', { name: manual.name });
    $('#sh-m-type').value = fam;
    var rows = S.clear($('#sh-m-rows'));
    var host = c.host || T('manual.host_unknown');
    if (fam === 'tasmota') {
      rows.appendChild(kvRow(T('manual.host'), host, { noCopy: !c.host }));
      rows.appendChild(kvRow(T('manual.port'), String(c.port || 1883)));
    } else rows.appendChild(kvRow(T('manual.server'), c.host ? c.host + ':' + (c.port || 1883) : host, { noCopy: !c.host }));
    rows.appendChild(kvRow(T('manual.user'), c.username));
    if (c.password) rows.appendChild(kvRow(T('manual.password'), c.password, { key: true }));
    if (fam === 'tasmota') {
      rows.appendChild(kvRow(T('manual.topic'), c.prefix));
      rows.appendChild(kvRow(T('manual.full_topic'), 'tasmota/%topic%/%prefix%/'));
    } else if (fam === 'shelly2') rows.appendChild(kvRow(T('manual.prefix'), 'shellies/' + c.prefix));
    else rows.appendChild(kvRow(T('manual.mqtt_id'), c.prefix));
    $('#sh-m-once').textContent = c.password ? T('manual.once') : T('manual.no_password');
    $('#sh-m-howto-title').textContent = T('manual.howto.' + fam);
    var ol = S.clear($('#sh-m-howto'));
    for (var i = 1; i <= 4; i++) {
      var key = 'manual.howto.' + fam + '.' + i;
      if (T(key) === key) break;
      ol.appendChild(el('li', null, S.kbText(T(key))));
    }
    $('#sh-m-wait-title').textContent = manual.arrived ? T('manual.arrived') : T('manual.wait');
    $('#sh-m-wait-text').textContent = manual.arrived ? T('manual.arrived_text') : T('manual.wait_text');
    $('#sh-m-wait').classList.toggle('is-good', !!manual.arrived);
    $('#sh-m-wait-ico').classList.toggle('sh-spin', !manual.arrived);
    $('#sh-m-cancel').hidden = !!manual.arrived;
    $('#sh-m-later').textContent = manual.arrived ? T('auto.done') : T('manual.later');
    $('#sh-m-later').classList.toggle('btn-primary', !!manual.arrived);
  }
  function pollManual() {
    if (!manual) return;
    clearTimeout(manual.timer);
    manual.timer = setTimeout(function () {
      if (!manual || $('#sh-manual-modal').hidden) return;
      var id = manual.id;
      S.api('GET', 'edge/devices/' + id).then(function (r) {
        if (!manual || manual.id !== id) return;
        if (r.device && !r.device.waiting) { manual.arrived = true; renderManual(); return; }
        pollManual();
      }, function () { pollManual(); });
    }, 3000);
  }
  function openManual(id, name, cred) {
    manual = { id: id, name: name, cred: cred, timer: null, arrived: false };
    renderManual();
    S.openModal('sh-manual-modal', '#sh-m-type');
    pollManual();
  }
  $('#sh-manual-modal').addEventListener('sh:close', function () {
    if (manual) clearTimeout(manual.timer);
    manual = null; // the password goes with the dialog
    S.clear($('#sh-m-rows'));
    loadView();
  });
  $('#sh-m-type').addEventListener('change', function () {
    if (!manual) return;
    var fam = $('#sh-m-type').value;
    var id = manual.id;
    S.api('POST', 'edge/devices/' + id + '/family', { family: fam }).then(function (r) {
      if (!manual || manual.id !== id) return;
      manual.cred = r.credentials || Object.assign({}, manual.cred, { family: fam });
      renderManual();
    }, function (e) { warn(e); if (manual) $('#sh-m-type').value = manual.cred.family; });
  });
  $('#sh-m-later').addEventListener('click', function () { S.closeModal('sh-manual-modal'); });
  $('#sh-m-cancel').addEventListener('click', function () {
    if (!manual) return;
    var m = manual;
    S.confirm(T('manual.cancel_confirm', { name: m.name }), T('device.remove'), true).then(function (ok) {
      if (!ok) return null;
      return S.api('DELETE', 'edge/devices/' + m.id).then(function () { S.closeModal('sh-manual-modal'); }, warn);
    });
  });

  // ─── Gerät bearbeiten ─────────────────────────

  var editing = null;
  function renderDevice(d) {
    $('#sh-d-title').textContent = T('device.title', { name: d.model ? prettyModel(d) : d.name });
    $('#sh-d-sub').textContent = [d.ip, d.firmware ? T('add.firmware', { v: d.firmware }) : null, T('device.via', { name: edgeName(d.gateway_id) }), d.username ? T('device.account', { user: d.username }) : null].filter(Boolean).join(' · ');
    var host = S.clear($('#sh-d-channels'));
    var cfg = (d.config && d.config.channels) || {};
    var rows = d.channels.map(function (ch) { return { key: ch.key, type: ch.type, n: Number(ch.key.split(':')[1]) }; });
    var sensor = d.resources.find(function (r) { return r.kind === 'sensor'; });
    if (sensor) rows.push({ key: 'sensor', type: 'sensor' });
    var many = rows.filter(function (x) { return x.type !== 'sensor'; }).length > 1;
    rows.forEach(function (x) {
      var res = d.resources.find(function (r) { return r.capabilities && r.capabilities.ch === x.key; });
      var label;
      var hint = null;
      var control = null;
      if (x.type === 'cover') { label = T('device.outputs_pair', { a: 2 * x.n + 1, b: 2 * x.n + 2 }); hint = T('device.pair_hint'); }
      else if (x.type === 'sensor') label = T('device.sensor');
      else label = T('device.output', { n: x.n + 1 });
      if (x.type === 'cover' || x.type === 'switch') {
        var opts = x.type === 'cover' ? [['shutter', T('cover.shutter')], ['awning', T('cover.awning')], ['gate', T('cover.gate')]] : [['light', T('kind.light')], ['plug', T('kind.plug')], ['relay', T('kind.relay')]];
        var sel = el('select', { class: 'form-select', 'data-ch': x.key, 'data-field': x.type === 'cover' ? 'cover' : 'kind', 'aria-label': T('device.kind_for', { label: label }) });
        opts.forEach(function (o) { sel.appendChild(el('option', { value: o[0], text: o[1] })); });
        sel.value = x.type === 'cover' ? ((res && res.capabilities.cover) || (cfg[x.key] && cfg[x.key].cover) || 'shutter') : ((res && res.kind) || (cfg[x.key] && cfg[x.key].kind) || 'relay');
        control = sel;
      } else control = el('span', { class: 'sh-sub', text: x.type === 'light' ? T('device.dimmer') : T('device.sensor') });
      var nameInput = many && x.type !== 'sensor' ? el('input', { class: 'form-input', type: 'text', maxlength: '60', 'data-ch': x.key, 'data-field': 'name', value: (cfg[x.key] && cfg[x.key].name) || '', placeholder: res ? res.name : '', 'aria-label': T('device.name_for', { label: label }) }) : null;
      host.appendChild(el('div', { class: 'sh-ch' }, [
        el('span', { class: 'sh-ch-text' }, [el('strong', { text: label }), hint ? el('span', { class: 'sh-sub', text: hint }) : null]),
        el('span', { class: 'sh-ch-ctl' }, [nameInput, control]),
      ]));
    });
    if (!rows.length) host.appendChild(el('p', { class: 'sh-sub', text: d.waiting ? T('device.no_channels') : T('device.no_channels') }));
    $('#sh-d-kinds-hint').hidden = !rows.some(function (x) { return x.type === 'switch'; });
    var chips = S.clear($('#sh-d-owners'));
    deviceOwners(d).forEach(function (o) { chips.appendChild(el('span', { class: 'sh-chip', text: o.username })); });
    if (!deviceOwners(d).length) chips.appendChild(el('span', { class: 'sh-sub', text: T('owners.none') }));
    chips.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('device.owners_change'), on: { click: function () { openOwners({ device: d }); } } }));
    var page = $('#sh-d-page');
    page.hidden = !d.page;
    if (d.page) page.setAttribute('href', d.page); else page.removeAttribute('href');
  }
  function openDevice(id, keepFields) {
    return S.api('GET', 'edge/devices/' + Number(id)).then(function (r) {
      editing = r.device;
      if (!keepFields || $('#sh-device-modal').hidden) {
        $('#sh-d-name').value = editing.name;
        $('#sh-d-area').value = editing.area || '';
      }
      renderDevice(editing);
      if ($('#sh-device-modal').hidden) S.openModal('sh-device-modal', '#sh-d-name');
    }, warn);
  }
  $('#sh-d-page').addEventListener('click', function () { if (editing && editing.page) S.toast(T('device.open_hint', { url: editing.page })); });
  $('#sh-d-save').addEventListener('click', function () {
    if (!editing) return;
    var name = $('#sh-d-name').value.trim();
    if (!name) { $('#sh-d-name').focus(); S.toast(T('add.name_required'), 'error'); return; }
    var channels = {};
    $$('#sh-d-channels [data-ch]').forEach(function (n) {
      var k = n.getAttribute('data-ch');
      var f = n.getAttribute('data-field');
      channels[k] = channels[k] || {};
      if (f === 'name') { if (n.value.trim()) channels[k].name = n.value.trim(); } else channels[k][f] = n.value;
    });
    var d = editing;
    S.api('PUT', 'edge/devices/' + d.id, { name: name, area: $('#sh-d-area').value.trim() || null, channels: channels }).then(function () {
      S.closeModal('sh-device-modal');
      S.toast(T('gateway.saved'));
      return loadView();
    }, warn);
  });
  $('#sh-d-remove').addEventListener('click', function () {
    if (!editing) return;
    var d = editing;
    S.confirm(T('device.remove_confirm', { name: d.name }), T('device.remove'), true).then(function (ok) {
      if (!ok) return null;
      return S.api('DELETE', 'edge/devices/' + d.id).then(function () { S.closeModal('sh-device-modal'); S.toast(T('device.removed')); return loadView(); }, warn);
    });
  });
  $('#sh-d-password').addEventListener('click', function () {
    if (!editing) return;
    var d = editing;
    var btn = $('#sh-d-password'); btn.disabled = true;
    S.api('POST', 'edge/devices/' + d.id + '/password').then(function (r) {
      if (r.applied) { S.toast(T('device.password_applied')); return; }
      S.closeModal('sh-device-modal');
      openManual(d.id, d.name, r.credentials);
    }, warn).then(function () { btn.disabled = false; });
  });

  $('#sh-refresh').addEventListener('click', function () {
    var e = currentEdge(); if (!e) return;
    var btn = $('#sh-refresh'); btn.disabled = true;
    S.api('POST', 'edge/gateways/' + e.id + '/refresh').then(function () {
      S.toast(T('edge.refreshed'));
      setTimeout(function () { loadGateways('e:' + e.id); }, 2500);
    }, warn).then(function () { btn.disabled = false; });
  });

  loadGateways();
}());
