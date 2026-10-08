/* Klimaanlage page (port of GateControl's public/js/midea.js). */
(function () {
  'use strict';
  var M = window.MD, T = M.T, $ = M.$, $$ = M.$$, el = M.el;

  // Fan: percent steps like the Midea app (1·20·40·60·80·100; 100 = max). Auto = 102 (off the scale).
  var FAN_STEPS = [1, 20, 40, 60, 80, 100];
  var MODES = ['auto', 'cool', 'heat', 'dry', 'fan'];
  // Static icon markup (never data) — mode buttons show icons, the label is title/aria-label.
  var MODE_ICONS = {
    auto: '<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 4 21 9 16 9"/>',
    cool: '<line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/>',
    heat: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4"/>',
    dry: '<path d="M12 2.7S6 9 6 14a6 6 0 0 0 12 0c0-5-6-11.3-6-11.3z"/>',
    fan: '<path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/><path d="M17.7 7.7A2.5 2.5 0 1 1 19.5 12H2"/>',
  };
  var AC_ICON = '<rect x="2" y="4" width="20" height="10" rx="2"/><path d="M6 18v1M10 18v2M14 18v2M18 18v1"/><line x1="6" y1="9" x2="18" y2="9"/>';

  var devices = [];
  var targets = [];
  var cloud = { configured: false };
  var cloudDevices = [];
  var allUsers = null;
  var ownerDevice = null;
  var editDevice = null;
  var cloudTimer = null;

  function icon(body, size) {
    var span = el('span');
    span.innerHTML = '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
    return span.firstChild;
  }
  function errText(e) {
    var d = e && e.data && e.data.detail ? ' (' + e.data.detail + ')' : '';
    return ((e && e.message) || T('common.error')) + d;
  }
  function warn(e) { M.toast(errText(e), 'error'); }
  function fanIndex(v) { return FAN_STEPS.reduce(function (b, val, i, a) { return Math.abs(val - v) < Math.abs(a[b] - v) ? i : b; }, 0); }
  function byId(id) { return devices.find(function (d) { return d.id === id; }) || null; }
  function cardOf(id) { return $('.md-card[data-id="' + Number(id) + '"]'); }

  // ── device cards ────────────────────────────────────────────────────────────
  function ownerBlock(d) {
    var names = (d.owners || []).map(function (o) { return o.username; });
    return el('div', { class: 'md-owners' }, [
      el('span', { class: 'md-lbl', text: T('owners.label') }),
      el('div', { class: 'md-owner-chips' }, names.length
        ? names.map(function (n) { return el('span', { class: 'md-chip-name', text: n }); })
        : [el('span', { class: 'md-no-owner', text: T('owners.none') })]),
      el('button', { type: 'button', class: 'btn btn-sm' + (names.length ? '' : ' btn-primary'), 'data-act': 'owners', text: T(names.length ? 'owners.manage' : 'owners.assign') }),
    ]);
  }
  function subLine(d) {
    if (d.transport === 'cloud') return el('span', { class: 'tag tag-blue', text: T('transport.cloud') });
    var where = d.target_label || T('device.no_target');
    var parts = [where, 'v' + d.protocol_version];
    if (d.protocol_version === 3 && !d.has_credentials) parts.push(T('device.no_keys'));
    return el('span', { class: 'tag', text: parts.join(' · ') });
  }
  function card(d) {
    var modeBtns = MODES.map(function (m) {
      var b = el('button', { type: 'button', class: 'md-mode', 'data-act': 'mode', 'data-mode': m, title: T('mode.' + m), 'aria-label': T('mode.' + m), 'aria-pressed': 'false' });
      b.appendChild(icon(MODE_ICONS[m], 16));
      return b;
    });
    var slider = el('input', { type: 'range', min: '0', max: '5', step: '1', value: '3', 'data-act': 'fan', 'aria-label': T('fan.label') });
    var c = el('div', { class: 'md-card' + (d.enabled ? '' : ' is-disabled'), 'data-id': String(d.id) }, [
      el('div', { class: 'md-head' }, [
        el('div', { class: 'md-ic' }, [icon(AC_ICON, 20)]),
        el('div', { class: 'md-head-text' }, [el('div', { class: 'md-name', text: d.name }), el('div', { class: 'md-sub' }, [subLine(d)])]),
        el('span', { class: 'tag md-status', text: '—' }),
      ]),
      el('div', { class: 'md-climate' }, [
        el('div', { class: 'md-ring-wrap' }, [
          el('div', { class: 'md-ring' }, [el('div', { class: 'md-ring-in' }, [el('span', { class: 'md-ring-v', text: '—' }), el('span', { class: 'md-ring-l', text: T('device.current') })])]),
          el('div', { class: 'md-outdoor', hidden: true }),
        ]),
        el('div', { class: 'md-set' }, [
          el('div', null, [
            el('div', { class: 'md-lbl', text: T('device.target') }),
            el('div', { class: 'md-stepper' }, [
              el('button', { type: 'button', 'data-step': '-1', 'aria-label': T('device.cooler') }, ['−']),
              el('span', { class: 'v', 'aria-live': 'polite', text: '— °C' }),
              el('button', { type: 'button', 'data-step': '1', 'aria-label': T('device.warmer') }, ['+']),
            ]),
          ]),
          el('div', null, [el('div', { class: 'md-lbl', text: T('device.mode') }), el('div', { class: 'md-modes', role: 'group', 'aria-label': T('device.mode') }, modeBtns)]),
          el('div', { class: 'md-fan' }, [
            el('div', { class: 'md-fan-head' }, [
              el('span', { class: 'md-lbl', text: T('fan.label') }),
              el('button', { type: 'button', class: 'md-tgl', 'data-act': 'fan-auto', 'aria-pressed': 'false', text: T('fan.auto') }),
              el('span', { class: 'md-fan-val', text: '—' }),
            ]),
            slider,
            el('div', { class: 'md-fan-ticks', 'aria-hidden': 'true' }, FAN_STEPS.map(function (v) { return el('span', { text: v + '%' }); })),
          ]),
          el('div', null, [
            el('div', { class: 'md-lbl', text: T('extras.label') }),
            el('div', { class: 'md-tgl-row' }, [
              el('button', { type: 'button', class: 'md-tgl', 'data-act': 'turbo', 'aria-pressed': 'false', text: T('turbo') }),
              el('button', { type: 'button', class: 'md-tgl', 'data-act': 'eco', 'aria-pressed': 'false', text: T('eco') }),
            ]),
          ]),
        ]),
      ]),
      ownerBlock(d),
      el('div', { class: 'md-foot' }, [
        el('button', { type: 'button', class: 'btn btn-sm md-grow', 'data-act': 'power', text: T('device.power') }),
        el('button', { type: 'button', class: 'btn btn-sm', 'data-act': d.transport === 'cloud' ? 'refresh' : 'test', text: T(d.transport === 'cloud' ? 'device.refresh' : 'device.test') }),
        el('button', { type: 'button', class: 'btn btn-sm', 'data-act': 'edit', text: T('device.edit') }),
      ]),
    ]);
    slider.addEventListener('input', function () { var v = $('.md-fan-val', c); if (v) v.textContent = FAN_STEPS[Number(slider.value)] + '%'; });
    slider.addEventListener('change', function () { control(d.id, { fanSpeed: FAN_STEPS[Number(slider.value)] }); });
    return c;
  }

  function updateOnlineKpi() {
    var k = $('#md-kpi-online');
    if (!k) return;
    var total = $$('.md-card').length;
    var online = $$('.md-card').filter(function (c) { return c.getAttribute('data-online') === '1'; }).length;
    k.textContent = online + ' / ' + total;
  }

  function setCardState(c, st) {
    var d = byId(Number(c.getAttribute('data-id')));
    if (d) d.state = st;
    var ring = $('.md-ring', c);
    var status = $('.md-status', c);
    var stepper = $('.md-stepper', c);
    var outdoor = $('.md-outdoor', c);
    if (!st || st.offline) {
      c.classList.add('offline');
      c.setAttribute('data-online', '0');
      ring.style.setProperty('--ring-val', '0%');
      $('.md-ring-v', c).textContent = '—';
      status.textContent = T('device.offline');
      status.removeAttribute('data-tone');
      stepper.classList.remove('pending', 'confirmed');
      outdoor.hidden = true;
      updateOnlineKpi();
      return;
    }
    c.classList.remove('offline');
    c.setAttribute('data-online', '1');
    var indoor = Number(st.indoorTemp);
    var has = st.indoorTemp != null && isFinite(indoor);
    ring.style.setProperty('--ring-val', (has ? Math.max(0, Math.min(100, ((indoor - 16) / 14) * 100)) : 0) + '%');
    $('.md-ring-v', c).textContent = has ? Math.round(indoor) + '°' : '—';
    status.textContent = st.power ? T('device.on') : T('device.off');
    status.setAttribute('data-tone', st.power ? 'good' : 'muted');
    var target = Number(st.targetTemp);
    $('.v', stepper).textContent = isFinite(target) && st.targetTemp != null ? target + ' °C' : '— °C';
    // the displayed target is now the device's setpoint → confirmed (green), no longer pending
    stepper.classList.remove('pending');
    stepper.classList.toggle('confirmed', isFinite(target) && st.targetTemp != null);
    $$('.md-mode', c).forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-mode') === st.mode ? 'true' : 'false'); });
    var out = Number(st.outdoorTemp);
    if (st.outdoorTemp == null || !isFinite(out)) outdoor.hidden = true;
    else { outdoor.hidden = false; outdoor.textContent = T('device.outdoor') + ' ' + Math.round(out) + '°'; }
    // fan: auto (102) → chip on, slider dimmed; otherwise snap the slider to the nearest step
    var fanAuto = $('[data-act="fan-auto"]', c);
    var fanBox = $('.md-fan', c);
    var fanVal = $('.md-fan-val', c);
    var fs = Number(st.fanSpeed);
    if (st.fanSpeed === 102) {
      fanAuto.setAttribute('aria-pressed', 'true'); fanBox.classList.add('is-auto'); fanVal.textContent = T('fan.auto');
    } else if (st.fanSpeed != null && isFinite(fs)) {
      fanAuto.setAttribute('aria-pressed', 'false'); fanBox.classList.remove('is-auto');
      var idx = fanIndex(fs);
      $('input[data-act="fan"]', c).value = String(idx);
      fanVal.textContent = FAN_STEPS[idx] + '%';
    }
    // turbo / eco only mirror what the device reports
    $('[data-act="turbo"]', c).setAttribute('aria-pressed', st.turbo ? 'true' : 'false');
    $('[data-act="eco"]', c).setAttribute('aria-pressed', st.eco ? 'true' : 'false');
    updateOnlineKpi();
  }

  function refreshState(id) {
    var c = cardOf(id);
    return M.api('GET', 'devices/' + Number(id) + '/state').then(function (r) {
      if (c) setCardState(c, r.state);
      return { suspend: !!(r.state && r.state.offline) };
    }, function (e) {
      if (c) { var s = $('.md-status', c); s.textContent = errText(e); s.setAttribute('data-tone', 'error'); }
      return { suspend: !!(e && e.data && e.data.code === 'MIDEA_CLOUD_RATE_LIMITED') };
    });
  }

  function control(id, patch) {
    return M.api('POST', 'devices/' + Number(id) + '/state', { patch: patch }).then(function (r) {
      var c = cardOf(id);
      if (c) setCardState(c, r.state);
      if (r.state && r.state.offline) M.toast(T('error.offline'), 'error');
    }, warn);
  }

  function renderKpis() {
    var host = M.clear($('#md-kpis'));
    var total = devices.length;
    var withOwner = devices.filter(function (d) { return (d.owners || []).length; }).length;
    [
      [T('kpi.devices'), String(total), null],
      [T('kpi.online'), '0 / ' + total, 'md-kpi-online'],
      [T('kpi.assigned'), withOwner + ' / ' + total, null],
      [T('kpi.cloud'), cloud.configured ? T('cloud.connected') : '—', null],
    ].forEach(function (k) {
      host.appendChild(el('div', { class: 'md-kpi' }, [el('span', { class: 'l', text: k[0] }), el('span', { class: 'v', id: k[2], text: k[1] })]));
    });
  }

  function startCloudRefresh() {
    // cloud devices while the page is visible, every 120 s (as before); stops on rate limit/offline
    if (cloudTimer) { clearInterval(cloudTimer); cloudTimer = null; }
    var ids = devices.filter(function (d) { return d.transport === 'cloud'; }).map(function (d) { return d.id; });
    if (!ids.length) return;
    cloudTimer = setInterval(function () {
      if (document.hidden) return;
      ids.reduce(function (p, id) {
        return p.then(function (stop) { return stop ? true : refreshState(id).then(function (r) { return r.suspend; }); });
      }, Promise.resolve(false)).then(function (stop) { if (stop && cloudTimer) { clearInterval(cloudTimer); cloudTimer = null; } });
    }, 120000);
  }
  // LAN devices: the background run polls them every 30 s; mirror its cached
  // states here (no extra device round trip)
  setInterval(function () {
    if (document.hidden || $$('.modal-overlay').some(function (m) { return !m.hidden; })) return;
    if (!devices.some(function (d) { return d.transport !== 'cloud'; })) return;
    M.api('GET', 'status').then(function (st) {
      $('#md-reauth').hidden = !st.cloud_needs_reauth;
      (st.devices || []).forEach(function (s) {
        var c = s.transport !== 'cloud' && s.checked ? cardOf(s.id) : null;
        if (c) setCardState(c, s.online && s.state ? s.state : { offline: true });
      });
    }, function () { /* retried on the next run */ });
  }, 30000);

  function loadDevices() {
    return Promise.all([
      M.api('GET', 'devices'),
      M.api('GET', 'status').catch(function () { return {}; }),
      M.api('GET', 'targets').catch(function () { return { targets: [] }; }),
    ]).then(function (out) {
      devices = out[0].devices || [];
      var st = out[1] || {};
      cloud = st.cloud || { configured: false };
      targets = out[2].targets || [];
      $('#md-reauth').hidden = !st.cloud_needs_reauth;
      renderKpis();
      var host = M.clear($('#md-devices'));
      if (!devices.length) { host.appendChild(el('p', { class: 'md-empty', text: T('devices.none') })); return; }
      devices.forEach(function (d) { host.appendChild(card(d)); });
      // the real state right after rendering (parallel, per card)
      devices.forEach(function (d) { refreshState(d.id); });
      startCloudRefresh();
    }, function (e) {
      var host = M.clear($('#md-devices'));
      host.appendChild(el('p', { class: 'md-empty', text: errText(e) }));
    });
  }

  // ── card actions ────────────────────────────────────────────────────────────
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('.md-card button[data-act]') : null;
    if (!btn) return;
    var c = btn.closest('.md-card');
    var id = Number(c.getAttribute('data-id'));
    var d = byId(id);
    var act = btn.getAttribute('data-act');
    if (act === 'owners') { if (d) openOwners(d); return; }
    if (act === 'edit') { if (d) openEdit(d); return; }
    if (act === 'refresh') { refreshState(id); return; }
    if (act === 'test') {
      btn.disabled = true;
      M.api('POST', 'devices/' + id + '/test').then(function (r) {
        setCardState(c, r.state);
        M.toast(T('device.test_ok', { ms: r.latencyMs }));
      }, warn).then(function () { btn.disabled = false; });
      return;
    }
    var st = (d && d.state) || {};
    if (act === 'power') { control(id, { power: !st.power }); return; }
    if (act === 'mode') { control(id, { mode: btn.getAttribute('data-mode') }); return; }
    if (act === 'fan-auto') { control(id, { fanSpeed: 102 }); return; }
    if (act === 'turbo' || act === 'eco') { var p = {}; p[act] = !st[act]; control(id, p); }
  });

  // Target temperature: whole degrees, optimistic (amber = pending), debounced
  // (rapid +/- clicks coalesce into one command); green once the device confirms.
  document.addEventListener('click', function (ev) {
    var step = ev.target.closest ? ev.target.closest('.md-stepper button[data-step]') : null;
    if (!step) return;
    var c = step.closest('.md-card');
    var id = Number(c.getAttribute('data-id'));
    var d = byId(id);
    if (!d || !d.state || d.state.offline || d.state.targetTemp == null) return; // no state yet — never send a default
    var next = Math.min(30, Math.max(16, Math.round(Number(d.state.targetTemp)) + Number(step.getAttribute('data-step'))));
    d.state = Object.assign({}, d.state, { targetTemp: next });
    var wrap = step.closest('.md-stepper');
    $('.v', wrap).textContent = next + ' °C';
    wrap.classList.add('pending'); wrap.classList.remove('confirmed');
    clearTimeout(wrap._t);
    wrap._t = setTimeout(function () {
      M.api('POST', 'devices/' + id + '/state', { patch: { targetTemp: next } }).then(function (r) { setCardState(c, r.state); }, function (e) { wrap.classList.remove('pending'); warn(e); });
    }, 500);
  });

  // ── cloud account ───────────────────────────────────────────────────────────
  function cloudStateText() {
    return cloud.configured ? T('cloud.connected_as', { email: cloud.email || '' }) : T('cloud.not_connected');
  }
  $('#md-cloud-open').addEventListener('click', function () {
    $('#md-cloud-state').textContent = cloudStateText();
    $('#md-cl-app').value = cloud.app || 'msmarthome';
    $('#md-cl-email').value = cloud.email || '';
    $('#md-cl-password').value = '';
    $('#md-cloud-msg').textContent = '';
    M.openModal('md-cloud-modal');
  });
  function connectCloud() {
    var btn = $('#md-cloud-connect');
    var msg = $('#md-cloud-msg');
    var body = { app: $('#md-cl-app').value, email: $('#md-cl-email').value.trim(), password: $('#md-cl-password').value };
    if (!body.email || !body.password) { msg.textContent = T('error.email_password_required'); return; }
    btn.disabled = true;
    msg.textContent = '…';
    M.api('POST', 'cloud/connect', body).then(function () {
      $('#md-cl-password').value = '';
      msg.textContent = T('cloud.connected');
      M.toast(T('cloud.connected'));
      M.closeModal('md-cloud-modal');
      return loadDevices().then(loadCloudDevices);
    }, function (e) {
      msg.textContent = e && e.data && e.data.code === 'MIDEA_CLOUD_2FA_REQUIRED' ? T('error.twofa') : errText(e);
    }).then(function () { btn.disabled = false; });
  }
  $('#md-cloud-connect').addEventListener('click', connectCloud);
  $('#md-cloud-form').addEventListener('submit', function (e) { e.preventDefault(); connectCloud(); });

  function isAdded(cd) {
    return devices.some(function (x) { return x.device_sn === cd.sn || x.device_sn === 'cloud-' + cd.id || String(x.cloud_appliance_id) === String(cd.id); });
  }
  function renderCloudList() {
    var list = M.clear($('#md-cloud-list'));
    var hint = $('#md-cloud-list-hint');
    if (!cloud.configured) { hint.textContent = T('add.cloud_first'); return; }
    var pending = cloudDevices.filter(function (cd) { return !isAdded(cd); });
    hint.textContent = pending.length ? T('add.cloud_hint') : T('add.cloud_none');
    pending.forEach(function (cd) {
      list.appendChild(el('div', { class: 'md-cloud-row' }, [
        el('span', { class: 'md-cloud-name', text: cd.name || cd.sn || String(cd.id) }),
        el('span', { class: 'tag', 'data-tone': cd.online ? 'good' : 'muted', text: cd.online ? T('device.online') : T('device.offline') }),
        el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: T('cloud.add'), on: { click: function (e) { addCloud(cd, e.currentTarget); } } }),
      ]));
    });
  }
  function fillSnSelect() {
    var sel = $('#md-lan-sn');
    while (sel.options.length > 1) sel.remove(1); // keep the static "no cloud" option
    cloudDevices.forEach(function (cd) { sel.appendChild(el('option', { value: cd.sn, text: (cd.name || '') + ' (' + cd.sn + ')' })); });
  }
  function loadCloudDevices() {
    if (!cloud.configured) { cloudDevices = []; renderCloudList(); fillSnSelect(); return Promise.resolve(); }
    $('#md-cloud-list-hint').textContent = '…';
    return M.api('GET', 'cloud/devices').then(function (r) { cloudDevices = r.devices || []; }, function (e) {
      cloudDevices = [];
      $('#md-cloud-list-hint').textContent = errText(e);
      return 'failed';
    }).then(function (f) { if (f !== 'failed') renderCloudList(); fillSnSelect(); });
  }
  function addCloud(cd, btn) {
    btn.disabled = true;
    M.api('POST', 'devices', { transport: 'cloud', cloud_appliance_id: String(cd.id), name: cd.name || '' }).then(function () {
      M.closeModal('md-add-modal');
      return loadDevices();
    }, warn).then(function () { btn.disabled = false; });
  }

  // ── add dialog ──────────────────────────────────────────────────────────────
  function showPane(isCloud) {
    $('#md-tab-cloud').classList.toggle('active', isCloud);
    $('#md-tab-lan').classList.toggle('active', !isCloud);
    $('#md-tab-cloud').setAttribute('aria-selected', isCloud ? 'true' : 'false');
    $('#md-tab-lan').setAttribute('aria-selected', isCloud ? 'false' : 'true');
    $('#md-pane-cloud').hidden = !isCloud;
    $('#md-pane-lan').hidden = isCloud;
  }
  $('#md-tab-cloud').addEventListener('click', function () { showPane(true); });
  $('#md-tab-lan').addEventListener('click', function () { showPane(false); });
  function fillTargets(select, current) {
    M.clear(select);
    targets.forEach(function (a) { select.appendChild(el('option', { value: String(a.index), text: a.label })); });
    if (current != null) select.value = String(current);
    select.disabled = !targets.length;
  }
  $('#md-add-open').addEventListener('click', function () {
    fillTargets($('#md-lan-target'), null);
    $('#md-lan-target-hint').textContent = targets.length ? T('lan.target_hint') : T('lan.no_targets');
    $('#md-lan-add').disabled = !targets.length;
    $('#md-lan-msg').textContent = '';
    showPane(true);
    renderCloudList();
    M.openModal('md-add-modal');
    loadCloudDevices();
  });
  $('#md-lan-add').addEventListener('click', function () {
    var btn = $('#md-lan-add');
    var msg = $('#md-lan-msg');
    var body = { target_index: Number($('#md-lan-target').value), name: $('#md-lan-name').value.trim() };
    var sn = $('#md-lan-sn').value;
    if (sn) body.sn = sn;
    btn.disabled = true;
    msg.textContent = '…';
    M.api('POST', 'devices', body).then(function (r) {
      msg.textContent = '✓ ' + ((r.device && r.device.name) || '');
      $('#md-lan-name').value = '';
      M.closeModal('md-add-modal');
      return loadDevices();
    }, function (e) { msg.textContent = errText(e); }).then(function () { btn.disabled = false; });
  });

  // ── local discovery ─────────────────────────────────────────────────────────
  $('#md-discover').addEventListener('click', function () {
    var btn = $('#md-discover');
    var msg = $('#md-discover-msg');
    var found = M.clear($('#md-found'));
    msg.textContent = T('discover.running');
    btn.disabled = true;
    M.openModal('md-discover-modal');
    M.api('POST', 'discover').then(function (r) {
      var list = r.devices || [];
      msg.textContent = list.length + ' ' + T('discover.result');
      list.forEach(function (f) {
        var assigned = targets.some(function (a) { return String(a.label).split(':')[0] === f.address; });
        found.appendChild(el('div', { class: 'md-found-row' }, [
          el('b', { text: f.address }),
          el('span', { class: 'md-found-meta', text: 'v' + f.version + ' · ID ' + f.deviceId + (f.sn ? ' · ' + f.sn : '') }),
          el('span', { class: 'tag', 'data-tone': assigned ? 'good' : 'muted', text: assigned ? T('discover.assigned') : T('discover.unassigned') }),
        ]));
      });
    }, function (e) { msg.textContent = errText(e); }).then(function () { btn.disabled = false; });
  });

  // ── edit / remove ───────────────────────────────────────────────────────────
  function openEdit(d) {
    editDevice = d;
    $('#md-e-name').value = d.name || '';
    $('#md-e-enabled').checked = !!d.enabled;
    var lanDevice = d.transport !== 'cloud';
    $('#md-e-target-group').hidden = !lanDevice;
    if (lanDevice) fillTargets($('#md-e-target'), d.target_index);
    M.openModal('md-edit-modal');
  }
  $('#md-e-save').addEventListener('click', function () {
    var d = editDevice; if (!d) return;
    var body = { name: $('#md-e-name').value.trim(), enabled: $('#md-e-enabled').checked };
    if (d.transport !== 'cloud' && targets.length) body.target_index = Number($('#md-e-target').value);
    M.api('PUT', 'devices/' + d.id, body).then(function () { M.closeModal('md-edit-modal'); M.toast(T('device.saved')); return loadDevices(); }, warn);
  });
  $('#md-e-remove').addEventListener('click', function () {
    var d = editDevice; if (!d) return;
    M.confirm(T('device.remove_confirm', { name: d.name }), T('device.remove'), true).then(function (ok) {
      if (!ok) return null;
      return M.api('DELETE', 'devices/' + d.id).then(function () { M.closeModal('md-edit-modal'); return loadDevices(); }, warn);
    });
  });

  // ── owners ──────────────────────────────────────────────────────────────────
  function fetchUsers() {
    if (allUsers) return Promise.resolve(allUsers);
    return M.api('GET', 'users').then(function (r) { allUsers = r.users || []; return allUsers; }, function () { return []; });
  }
  function updateOwnerCount() {
    var all = $$('#md-owner-list .md-owner-row');
    var sel = all.filter(function (r) { return $('input', r).checked; }).length;
    $('#md-owner-count').textContent = T('owners.selected', { n: sel, total: all.length });
  }
  function openOwners(d) {
    ownerDevice = d;
    $('#md-owner-sub').textContent = T('owners.modal_sub') + ' — ' + (d.name || '');
    $('#md-owner-search').value = '';
    fetchUsers().then(function (users) {
      var owned = {}; (d.owners || []).forEach(function (o) { owned[o.id] = true; });
      var list = M.clear($('#md-owner-list'));
      users.forEach(function (u) {
        var cb = el('input', { type: 'checkbox', value: String(u.id), checked: !!owned[u.id] });
        cb.addEventListener('change', updateOwnerCount);
        list.appendChild(el('label', { class: 'md-owner-row', 'data-name': String(u.username || '').toLowerCase() }, [
          cb, el('span', { class: 'md-owner-name' }, [el('b', { text: u.username }), el('small', { text: u.role || '' })]),
        ]));
      });
      updateOwnerCount();
      M.openModal('md-owner-modal');
    });
  }
  $('#md-owner-search').addEventListener('input', function () {
    var q = $('#md-owner-search').value.toLowerCase();
    $$('#md-owner-list .md-owner-row').forEach(function (row) { row.hidden = row.getAttribute('data-name').indexOf(q) < 0; });
  });
  $('#md-owner-save').addEventListener('click', function () {
    if (!ownerDevice) return;
    var ids = $$('#md-owner-list input:checked').map(function (c) { return Number(c.value); });
    M.api('PUT', 'devices/' + ownerDevice.id + '/owners', { user_ids: ids }).then(function () {
      M.closeModal('md-owner-modal');
      M.toast(T('owners.saved'));
      return loadDevices();
    }, function (e) { M.toast(e && e.data && e.data.code === 'MIDEA_OWNER_UNKNOWN_USER' ? T('error.owner_unknown_user') : errText(e), 'error'); });
  });

  loadDevices();
}());
