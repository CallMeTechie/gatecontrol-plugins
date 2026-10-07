/* Smart Home main page (port of GateControl's public/js/smarthome.js). */
(function () {
  'use strict';
  var S = window.SH, T = S.T, $ = S.$, $$ = S.$$, el = S.el;
  // 8 colour presets → hue/sat (deCONZ hue 0–65535, sat 0–254)
  var SWATCHES = [
    { c: '#ff7a59', hue: 2000, sat: 200 }, { c: '#ff5d8f', hue: 60000, sat: 200 },
    { c: '#9d7bff', hue: 47000, sat: 180 }, { c: '#5b8cff', hue: 44000, sat: 200 },
    { c: '#36d6c3', hue: 33000, sat: 200 }, { c: '#8be36b', hue: 23000, sat: 200 },
    { c: '#ffd27a', hue: 8000, sat: 160 }, { c: '#ffffff', hue: 0, sat: 0 },
  ];
  var ICONS = {
    light: '<circle cx="12" cy="9" r="5"/><path d="M9 18h6M10 21h4"/>',
    plug: '<path d="M9 2v5M15 2v5"/><path d="M7 7h10v3a5 5 0 0 1-10 0z"/><path d="M12 15v7"/>',
    group: '<circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><circle cx="12" cy="16" r="3"/>',
    scene: '<path d="M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 8.7l5.4-.8z"/>',
    switch: '<rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="8" r="1.6"/><path d="M10 14h4"/>',
    'sensor.presence': '<circle cx="12" cy="12" r="2"/><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4.5 4.5a11 11 0 0 0 0 15M19.5 4.5a11 11 0 0 1 0 15"/>',
    'sensor.open': '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M14 3v18"/><circle cx="11.5" cy="12" r="1"/>',
    'sensor.water': '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
    'sensor.temperature': '<path d="M10 13V5a2 2 0 1 1 4 0v8a4 4 0 1 1-4 0z"/>',
    'sensor.humidity': '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/><path d="M9 14a3 3 0 0 0 3 3"/>',
    'sensor.lightlevel': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
    'sensor.button': '<rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="8" r="1.6"/>',
    'sensor.unknown': '<circle cx="12" cy="12" r="8"/><path d="M12 8v4M12 16h.01"/>',
  };

  var gateways = [];
  var targets = [];
  var allUsers = null;
  var ownerTarget = null;

  function send(id, body) { return S.api('POST', 'resources/' + Number(id) + '/state', body); }
  function warn(err) { S.toast((err && err.message) || T('common.error'), 'error'); }
  function currentGatewayId() { var s = $('#sh-gateway-select'); return s && s.value ? Number(s.value) : null; }
  function currentGateway() { var id = currentGatewayId(); return gateways.find(function (g) { return g.id === id; }) || null; }

  function catKey(r) { return r.kind === 'sensor' ? 'sensor.' + ((r.capabilities && r.capabilities.reading) || 'unknown') : r.kind; }
  function subLabel(r) { return r.kind === 'sensor' ? T('sensor.' + ((r.capabilities && r.capabilities.reading) || 'unknown')) : T('kind.' + r.kind); }
  function iconSvg(r) {
    var body = ICONS[catKey(r)] || ICONS['sensor.unknown']; // static markup from the table above
    var span = el('span', { class: 'sh-ico-wrap' });
    span.innerHTML = '<svg class="sh-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
    return span.firstChild;
  }
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
      el('button', { type: 'button', class: 'sh-owner-btn', text: T('owners.manage'), on: { click: function () { openOwners(r); } } }),
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
    if (caps.color === 'hs' || caps.color === 'xy') {
      var row = el('div', { class: 'sh-swatches' });
      SWATCHES.forEach(function (s) {
        var dot = el('button', { type: 'button', class: 'sh-sw', 'aria-label': T('color') + ' ' + s.c, style: 'background:' + s.c });
        dot.addEventListener('click', function () { send(r.id, { hue: s.hue, sat: s.sat }).catch(warn); });
        row.appendChild(dot);
      });
      body.appendChild(el('div', null, [el('div', { class: 'sh-ctl-lbl', text: T('color') }), row]));
    } else if (caps.color === 'ct') {
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

  function renderKpis(res) {
    var host = S.clear($('#smarthome-kpis'));
    var by = function (k) { return res.filter(function (r) { return r.kind === k; }).length; };
    [[T('section.lights'), by('light')], [T('kpi.groups'), by('group') + by('scene')], [T('section.sensors'), by('sensor')]].forEach(function (x) {
      host.appendChild(el('div', { class: 'sh-kpi' }, [el('span', { class: 'l', text: x[0] }), el('span', { class: 'v', text: String(x[1]) })]));
    });
  }
  function section(title, items, renderer) {
    if (!items.length) return null;
    var grid = el('div', { class: 'sh-grid' });
    items.forEach(function (r) { grid.appendChild(renderer(r)); });
    return el('div', null, [el('div', { class: 'sh-section-title' }, [title, el('span', { class: 'ln' })]), grid]);
  }

  function emptyMsg(text) { var host = S.clear($('#smarthome-devices')); host.appendChild(el('div', { class: 'sh-empty', text: text })); }

  function loadResources(gatewayId) {
    if (!gatewayId) { renderKpis([]); emptyMsg(gateways.length ? T('empty') : T('gateway.none')); return Promise.resolve(); }
    return S.api('GET', 'resources?gateway_id=' + Number(gatewayId)).then(function (data) {
      var res = (data.resources || []).filter(function (r) { return r.enabled; });
      renderKpis(res);
      var blocks = [
        section(T('section.lights'), res.filter(function (r) { return r.kind === 'light'; }), renderControllable),
        section(T('section.plugs'), res.filter(function (r) { return r.kind === 'plug'; }), renderControllable),
        section(T('section.groups'), res.filter(function (r) { return r.kind === 'group' || r.kind === 'scene'; }), function (r) { return r.kind === 'scene' ? renderScene(r) : renderControllable(r); }),
        section(T('section.switches'), res.filter(function (r) { return r.kind === 'switch'; }), renderSwitch),
        section(T('section.sensors'), res.filter(function (r) { return r.kind === 'sensor'; }), renderSensor),
      ].filter(Boolean);
      var host = S.clear($('#smarthome-devices'));
      if (!blocks.length) { emptyMsg(T('empty')); return; }
      blocks.forEach(function (b) { host.appendChild(b); });
    }, function () { emptyMsg(T('load_error')); });
  }

  function renderGatewayInfo() {
    var g = currentGateway();
    var info = $('#sh-gwinfo');
    info.textContent = g ? (T('connect.target') + ': ' + (g.target_label || T('gateway.no_target')) + ' · ' + T('gateway.last_seen') + ': ' + (g.last_seen_at || T('gateway.never'))) : '';
    ['#sh-test', '#sh-sync', '#sh-edit'].forEach(function (s) { $(s).disabled = !g; });
  }

  function loadGateways(selectId) {
    return Promise.all([
      S.api('GET', 'gateways').catch(function () { return { gateways: [] }; }),
      S.api('GET', 'targets').catch(function () { return { targets: [] }; }),
    ]).then(function (out) {
      gateways = out[0].gateways || [];
      targets = out[1].targets || [];
      var sel = S.clear($('#sh-gateway-select'));
      gateways.forEach(function (g) { sel.appendChild(el('option', { value: String(g.id), text: g.name + (g.enabled ? '' : ' (' + T('gateway.off') + ')') })); });
      sel.hidden = !gateways.length;
      var first = gateways.find(function (g) { return g.id === selectId; }) || gateways.find(function (g) { return g.enabled; }) || gateways[0];
      if (first) sel.value = String(first.id);
      renderGatewayInfo();
      return loadResources(first ? first.id : null);
    });
  }

  function fillTargets(select, current) {
    S.clear(select);
    targets.forEach(function (a) { select.appendChild(el('option', { value: String(a.index), text: a.label })); });
    if (current != null) select.value = String(current);
    select.disabled = !targets.length;
  }

  // Live values: the plugin polls deCONZ in the background; mirror that here.
  // Paused while hidden, while a control is focused or a dialog is open.
  setInterval(function () {
    if (document.hidden) return;
    var ae = document.activeElement;
    if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    if ($$('.modal-overlay').some(function (m) { return !m.hidden; })) return;
    var id = currentGatewayId();
    if (id) loadResources(id);
  }, 30000);

  $('#sh-gateway-select').addEventListener('change', function () { renderGatewayInfo(); loadResources(currentGatewayId()); });

  $('#sh-connect-open').addEventListener('click', function () {
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
      return loadGateways(r.gateway && r.gateway.id);
    }, warn).then(function () { btn.disabled = false; });
  });

  $('#sh-sync').addEventListener('click', function () {
    var id = currentGatewayId(); if (!id) return;
    var btn = $('#sh-sync'); btn.disabled = true;
    S.api('POST', 'gateways/' + id + '/sync').then(function (r) {
      S.toast(T('sync.done', r.counts || {}));
      return loadGateways(id);
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
    S.api('PUT', 'gateways/' + g.id, body).then(function () { S.closeModal('sh-edit-modal'); S.toast(T('gateway.saved')); return loadGateways(g.id); }, warn);
  });
  $('#sh-e-remove').addEventListener('click', function () {
    var g = currentGateway(); if (!g) return;
    S.confirm(T('gateway.remove_confirm', { name: g.name }), T('gateway.remove'), true).then(function (ok) {
      if (!ok) return null;
      return S.api('DELETE', 'gateways/' + g.id).then(function () { S.closeModal('sh-edit-modal'); return loadGateways(); }, warn);
    });
  });

  function fetchUsers() {
    if (allUsers) return Promise.resolve(allUsers);
    return S.api('GET', 'users').then(function (r) { allUsers = r.users || []; return allUsers; }, function () { return []; });
  }
  function openOwners(r) {
    ownerTarget = r;
    $('#sh-owner-sub').textContent = r.name || '';
    $('#sh-owner-search').value = '';
    fetchUsers().then(function (users) {
      var owned = {}; (r.owners || []).forEach(function (o) { owned[o.id] = true; });
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
    if (!ownerTarget) return;
    var ids = $$('#sh-owner-list input:checked').map(function (c) { return Number(c.value); });
    S.api('PUT', 'resources/' + ownerTarget.id + '/owners', { userIds: ids }).then(function () {
      S.closeModal('sh-owner-modal');
      return loadResources(currentGatewayId());
    }, warn);
  });

  loadGateways();
}());
