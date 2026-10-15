/* Admin page "Geräte": Nuki bridges and web token, locks, Ring login wizard, cameras ↔ lock. */
(function () {
  'use strict';
  var D = window.DOOR;
  var T = D.T, el = D.el, $ = D.$;
  var S = null;

  function opt(value, label, selected) { return el('option', { value: String(value), text: label, selected: !!selected }); }

  function renderBridges() {
    var box = D.clear($('#dr-bridges'));
    S.bridges.forEach(function (b) {
      box.appendChild(el('div', { class: 'dr-item' }, [
        el('div', { class: 'dr-item-main' }, [
          el('div', { class: 'dr-item-title', text: b.name }),
          el('div', { class: 'dr-item-sub', text: (b.targetLabel || ('#' + b.targetIndex)) + ' · ' + T(b.hasToken ? 'dev.token_set' : 'dev.token_missing') }),
        ]),
        el('div', { class: 'dr-actions' }, [
          el('button', { type: 'button', class: 'btn btn-sm', text: T('dev.test'), on: { click: function () { devices('bridges/' + b.id + '/devices', { source: 'bridge', bridgeId: b.id }); } } }),
          el('button', { type: 'button', class: 'btn btn-sm', text: T('dev.token'), on: { click: function () { newToken(b); } } }),
          el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: T('common.delete'), on: { click: function () { D.api('DELETE', 'admin/bridges/' + b.id).then(load).catch(D.warn); } } }),
        ]),
      ]));
    });
    var sel = D.clear($('#dr-b-target'));
    S.targets.forEach(function (t) { sel.appendChild(opt(t.index, t.label)); });
    $('#dr-no-targets').hidden = S.targets.length > 0;
  }

  function newToken(b) {
    var input = el('input', { class: 'form-input', type: 'password', maxlength: '64' });
    D.dialog(el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: T('dev.token') + ' – ' + b.name }), input]),
      [{ label: T('common.cancel'), value: false }, { label: T('common.save'), value: true, primary: true }]).then(function (ok) {
      if (!ok || !input.value) return;
      D.api('PATCH', 'admin/bridges/' + b.id, { token: input.value }).then(function () { D.toast(T('common.saved')); load(); }).catch(D.warn);
    });
  }

  /** Devices of a bridge / Nuki Web → pick one to add as a lock. */
  function devices(path, base) {
    D.api('GET', 'admin/' + path).then(function (r) {
      var list = el('div', { class: 'dr-list' }, r.devices.map(function (d) {
        return el('div', { class: 'dr-item' }, [
          el('div', { class: 'dr-item-main' }, [el('div', { class: 'dr-item-title', text: d.name || d.nukiId }), el('div', { class: 'dr-item-sub', text: T('dev.type_' + d.type) + ' · ' + d.nukiId })]),
          el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: T('common.add'), on: { click: function () {
            document.querySelector('.modal-overlay').remove();
            lockDialog(null, { source: base.source, bridgeId: base.bridgeId, nukiId: d.nukiId, deviceType: d.deviceType, name: d.name, actions: d.supported });
          } } }),
        ]);
      }));
      D.dialog(el('div', {}, [el('div', { class: 'dr-item-title', text: T('dev.found') }), list]));
    }).catch(D.warn);
  }

  function lockDialog(lock, preset) {
    var v = lock || Object.assign({ name: '', source: 'bridge', bridgeId: S.bridges.length ? S.bridges[0].id : null, nukiId: '', deviceType: 0, actions: ['lock', 'unlock'], doorSensor: false, openTooLongMin: 5, nightCheck: '22:00' }, preset || {});
    var name = el('input', { class: 'form-input', maxlength: '40', value: v.name });
    var source = el('select', { class: 'form-select' }, [opt('bridge', T('dev.source_bridge'), v.source === 'bridge'), opt('web', T('dev.source_web'), v.source === 'web')]);
    var bridge = el('select', { class: 'form-select' }, S.bridges.map(function (b) { return opt(b.id, b.name, b.id === v.bridgeId); }));
    var nukiId = el('input', { class: 'form-input', inputmode: 'numeric', maxlength: '20', value: v.nukiId });
    var type = el('select', { class: 'form-select' }, [opt(0, T('dev.type_smartlock') + ' (0)', v.deviceType === 0), opt(3, 'Smart Door (3)', v.deviceType === 3), opt(4, T('dev.type_smartlock') + ' 3.0/4 (4)', v.deviceType === 4), opt(5, T('dev.type_smartlock') + ' (5)', v.deviceType === 5), opt(2, T('dev.type_opener') + ' (2)', v.deviceType === 2)]);
    var acts = ['lock', 'unlock', 'open'].map(function (a) { return el('input', { type: 'checkbox', checked: v.actions.indexOf(a) >= 0, 'data-a': a }); });
    var sensor = el('input', { type: 'checkbox', checked: v.doorSensor });
    var openLong = el('input', { class: 'form-input', type: 'number', min: '0', max: '240', value: String(v.openTooLongMin) });
    var night = el('input', { class: 'form-input', type: 'time', value: v.nightCheck || '' });
    var g = function (label, input) { return el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: label }), input]); };
    var form = el('div', {}, [
      g(T('dev.lock_name'), name),
      el('div', { class: 'form-row' }, [g(T('dev.source'), source), g(T('dev.source_bridge'), bridge)]),
      el('div', { class: 'form-row' }, [g(T('dev.nuki_id'), nukiId), g(T('dev.device_type'), type)]),
      g(T('dev.actions'), el('div', { class: 'dr-days' }, acts.map(function (c) { return el('label', {}, [c, T('act.' + c.getAttribute('data-a'))]); }))),
      el('label', { class: 'check' }, [sensor, T('dev.door_sensor')]),
      el('div', { class: 'form-row' }, [g(T('dev.open_long'), openLong), g(T('dev.night'), night)]),
    ]);
    D.dialog(form, [{ label: T('common.cancel'), value: false }, { label: T('common.save'), value: true, primary: true }]).then(function (ok) {
      if (!ok) return;
      var body = {
        name: name.value, source: source.value, nukiId: nukiId.value.trim(), deviceType: Number(type.value),
        actions: acts.filter(function (c) { return c.checked; }).map(function (c) { return c.getAttribute('data-a'); }),
        doorSensor: sensor.checked, openTooLongMin: Number(openLong.value) || 0, nightCheck: night.value || null,
      };
      if (body.source === 'bridge') body.bridgeId = Number(bridge.value);
      (lock ? D.api('PATCH', 'admin/locks/' + lock.id, body) : D.api('POST', 'admin/locks', body)).then(function () { D.toast(T('common.saved')); load(); }).catch(D.warn);
    });
  }

  /** What Nuki reported (for support): source, raw code, where it came from, last read, moving since. */
  function diagText(l) {
    var d = l.diag || {};
    var code = d.nukiState == null ? '–' : String(d.nukiState);
    var parts = [T('dev.diag') + ': ' + (d.source === 'web' ? T('dev.source_web') : T('dev.source_bridge')), T('dev.diag_code', { code: code })];
    if (d.via) parts.push(T('dev.diag_via_' + d.via));
    if (d.listNukiState != null && d.listNukiState !== d.nukiState) parts.push(T('dev.diag_list', { code: d.listNukiState }));
    parts.push(T('dev.diag_updated', { when: D.when(d.updatedAt) }));
    if (d.movingSince) parts.push(T('dev.diag_moving', { when: D.when(d.movingSince) }));
    if (d.stale) parts.push(T('dev.diag_stale', { state: d.stableState ? T('state.' + d.stableState) : T('state.unknown') }));
    return parts.join(' · ');
  }

  function renderLocks() {
    var box = D.clear($('#dr-locks'));
    S.locks.forEach(function (l) {
      box.appendChild(el('div', { class: 'dr-item' }, [
        el('div', { class: 'dr-item-main' }, [
          el('div', { class: 'dr-item-title' }, [l.name + ' ', el('span', { class: 'dr-badge', 'data-tone': D.tone(l), text: D.badgeText(l) })]),
          el('div', { class: 'dr-item-sub', text: [T('dev.type_' + l.type), l.source === 'web' ? T('dev.source_web') : T('dev.source_bridge'), l.actions.map(function (a) { return D.actLabel(l, a); }).join('/'), D.stateText(l)].join(' · ') }),
          el('div', { class: 'dr-item-sub dr-diag', text: diagText(l) }),
        ]),
        el('div', { class: 'dr-actions' }, [
          el('button', { type: 'button', class: 'btn btn-sm', text: T('dev.refresh'), on: { click: function () { D.api('POST', 'admin/locks/' + l.id + '/refresh').then(load).catch(D.warn); } } }),
          el('button', { type: 'button', class: 'btn btn-sm', text: T('common.edit'), on: { click: function () { lockDialog(l); } } }),
          el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: T('common.delete'), on: { click: function () {
            D.confirmDialog(l.name + ' – ' + T('common.delete') + '?', T('common.delete')).then(function (ok) { if (ok) D.api('DELETE', 'admin/locks/' + l.id).then(load).catch(D.warn); });
          } } }),
        ]),
      ]));
    });
    $('#dr-no-locks').hidden = S.locks.length > 0;
  }

  var ringStep = 1;
  function renderRing() {
    var r = S.ring;
    var badge = $('#dr-ring-state');
    badge.textContent = r.broken ? T('dev.ring_broken') : T(r.connected ? 'dev.ring_connected' : 'dev.ring_off');
    badge.setAttribute('data-tone', r.broken ? 'crit' : (r.connected ? 'good' : ''));
    $('#dr-r-logout').hidden = !r.connected;
    $('#dr-r-sync').hidden = !r.connected;
  }

  function renderCams() {
    var box = D.clear($('#dr-cams'));
    S.cameras.forEach(function (c) {
      var sel = el('select', { class: 'form-select', on: { change: function () { D.api('PATCH', 'admin/cameras/' + c.id, { lockId: sel.value ? Number(sel.value) : null }).then(function () { D.toast(T('common.saved')); }).catch(D.warn); } } },
        [opt('', T('dev.camera_none'), !c.lockId)].concat(S.locks.map(function (l) { return opt(l.id, l.name, l.id === c.lockId); })));
      var en = el('input', { type: 'checkbox', checked: c.enabled, on: { change: function () { D.api('PATCH', 'admin/cameras/' + c.id, { enabled: en.checked }).catch(D.warn); } } });
      box.appendChild(el('div', { class: 'dr-item' }, [
        el('div', { class: 'dr-item-main' }, [
          el('div', { class: 'dr-item-title', text: c.name }),
          el('div', { class: 'dr-item-sub', text: [c.kind, c.online === false ? T('dev.offline') : null, c.battery != null ? T('dev.battery', { n: c.battery }) : null].filter(Boolean).join(' · ') }),
        ]),
        el('div', { class: 'form-group', style: 'margin:0;min-width:180px' }, [el('label', { class: 'form-label', text: T('dev.camera_lock') }), sel]),
        el('label', { class: 'check' }, [en, T('dev.camera_enabled')]),
        el('button', { type: 'button', class: 'btn btn-sm', text: T('portal.new_image'), on: { click: function () { D.api('GET', 'admin/cameras/' + c.id + '/snapshot?refresh=1').then(function (r) { D.showImage(r.snapshot); }).catch(D.warn); } } }),
      ]));
    });
    $('#dr-no-cams').hidden = S.cameras.length > 0;
  }

  function load() {
    return D.api('GET', 'admin/status').then(function (r) {
      S = r;
      $('#dr-web-state').textContent = T(r.web.hasToken ? 'dev.token_set' : 'dev.token_missing');
      renderBridges(); renderLocks(); renderRing(); renderCams();
    }).catch(D.warn);
  }

  $('#dr-bridge-form').addEventListener('submit', function (e) {
    e.preventDefault();
    D.api('POST', 'admin/bridges', { name: $('#dr-b-name').value, targetIndex: Number($('#dr-b-target').value), token: $('#dr-b-token').value })
      .then(function () { $('#dr-b-token').value = ''; $('#dr-b-name').value = ''; D.toast(T('common.saved')); load(); }).catch(D.warn);
  });
  $('#dr-web-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!$('#dr-w-token').value) return;
    D.api('PUT', 'admin/web', { token: $('#dr-w-token').value }).then(function () { $('#dr-w-token').value = ''; D.toast(T('common.saved')); load(); }).catch(D.warn);
  });
  $('#dr-w-test').addEventListener('click', function () { devices('web/devices', { source: 'web' }); });
  $('#dr-w-remove').addEventListener('click', function () { D.api('PUT', 'admin/web', { token: null }).then(load).catch(D.warn); });
  $('#dr-lock-add').addEventListener('click', function () { lockDialog(null); });
  $('#dr-ring-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var body = { email: $('#dr-r-email').value, password: $('#dr-r-pw').value };
    if (ringStep === 2) body.code = $('#dr-r-code').value;
    D.api('POST', 'admin/ring/login', body).then(function (r) {
      if (r.ring.connected) {
        // the password is dropped here as well
        $('#dr-r-pw').value = ''; $('#dr-r-code').value = ''; $('#dr-r-code-box').hidden = true; $('#dr-r-code-hint').hidden = true;
        ringStep = 1; $('#dr-r-submit').textContent = T('dev.ring_login');
        D.toast(T('dev.ring_connected'));
        load();
        return;
      }
      ringStep = 2;
      $('#dr-r-code-box').hidden = false;
      var hint = $('#dr-r-code-hint');
      hint.textContent = T('dev.ring_code_hint', { where: r.ring.tsvState === 'totp' ? T('dev.ring_code_app') : [r.ring.tsvState, r.ring.phone].filter(Boolean).join(' ') });
      hint.hidden = false;
      $('#dr-r-submit').textContent = T('dev.ring_next');
      $('#dr-r-code').focus();
    }).catch(D.warn);
  });
  $('#dr-r-logout').addEventListener('click', function () { D.api('POST', 'admin/ring/logout').then(load).catch(D.warn); });
  $('#dr-r-sync').addEventListener('click', function () { D.api('POST', 'admin/ring/sync').then(function () { D.toast(T('common.saved')); load(); }).catch(D.warn); });
  load();
})();
