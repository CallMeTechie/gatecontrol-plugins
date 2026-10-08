/* Vehicles page (port of GateControl's public/js/skoda.js). */
(function () {
  'use strict';
  var S = window.SK, T = S.T, $ = S.$, $$ = S.$$, el = S.el;
  var current = { accounts: [], vehicles: [] };
  var ownerVehicle = null;
  var spinAccountId = null;
  var passwordAccountId = null;
  var allUsers = null;
  var enrich = {};          // vehId -> details node, cached on success only
  var pending = {};         // vehId -> details fetch in flight
  var images = {};          // vehId -> data: URL (or false = none)

  function fail(e) {
    var code = S.codeOf(e);
    S.toast(code === 'SKODA_REFRESH_COOLDOWN' ? T('error.cooldown') : ((e && e.message) || T('error.generic')), 'error');
  }

  // ─── Accounts ─────────────────────────────────
  function accountRow(a) {
    var key = 'accounts.status.' + (['ok', 'login_failed', 'rate_limited', 'error'].indexOf(a.status) >= 0 ? a.status : 'error');
    var statusText = a.status === 'rate_limited'
      ? T(key, { time: a.next_retry_at ? new Date(a.next_retry_at).toLocaleTimeString(S.LOCALE) : '—' })
      : T(key);
    var row = el('div', { class: 'sk-account', 'data-id': String(a.id) }, [
      el('span', { class: 'sk-account-email', text: a.email }),
      el('span', { class: 'sk-badge', 'data-status': a.status, title: a.status_detail || '', text: statusText }),
      a.has_spin ? null : el('span', { class: 'sk-badge', 'data-status': 'muted', text: T('accounts.no_spin') }),
      el('span', { class: 'sk-grow' }),
      el('button', { type: 'button', class: 'btn btn-sm', text: T('accounts.sync'), on: { click: function () { syncAccount(a.id); } } }),
      el('button', { type: 'button', class: 'btn btn-sm', text: T('accounts.change_password'), on: { click: function () { passwordAccountId = a.id; $('#sk-pw-input').value = ''; S.openModal('sk-password-modal'); } } }),
      el('button', { type: 'button', class: 'btn btn-sm', text: T('cmd.spin'), on: { click: function () { spinAccountId = a.id; $('#sk-spin-input').value = ''; S.openModal('sk-spin-modal'); } } }),
      el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: T('accounts.remove'), on: { click: function () { removeAccount(a); } } }),
    ]);
    return row;
  }
  function syncAccount(id) {
    // fire and forget: the status lands on the account row
    S.toast(T('accounts.sync_started'));
    S.api('POST', 'accounts/' + Number(id) + '/sync').then(load, function (e) { fail(e); load(); });
  }
  function removeAccount(a) {
    S.confirm({ message: T('accounts.confirm_remove', { email: a.email }), okLabel: T('accounts.remove'), danger: true }).then(function (ok) {
      if (!ok) return;
      S.api('DELETE', 'accounts/' + Number(a.id)).then(load, fail);
    });
  }

  // ─── Vehicles ─────────────────────────────────
  function timerRow(v, t) {
    var days = Array.isArray(t.days) ? t.days : [];
    // only RECURRING is writable — the server refuses everything else; values are shown, locked
    var editable = t.type === 'RECURRING';
    var msg = el('span', { class: 'sk-timer-msg', 'aria-live': 'polite', text: t.type === 'ONE_OFF' ? T('timers.readonly') : '' });
    var enabled = el('input', { type: 'checkbox', checked: !!t.enabled, disabled: !editable });
    var time = el('input', { type: 'time', class: 'form-input sk-time', value: String(t.time || ''), disabled: !editable, 'aria-label': T('timers.time') });
    var row = el('div', { class: 'sk-timer', 'data-veh': String(v.id), 'data-timer': String(t.id) });
    function dirty() { row.setAttribute('data-dirty', '1'); markDirty(); }
    var dayRow = el('div', { class: 'sk-timer-days', role: 'group', 'aria-label': T('timers.days') }, S.DAYS.map(function (d) {
      var b = el('button', { type: 'button', class: 'sk-timer-day', 'data-day': d[0], 'aria-pressed': days.indexOf(d[0]) >= 0 ? 'true' : 'false', disabled: !editable, text: T('timers.day.' + d[1]) });
      b.addEventListener('click', function () { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); dirty(); });
      return b;
    }));
    [enabled, time].forEach(function (n) { n.addEventListener('change', dirty); n.addEventListener('input', dirty); });
    var save = editable ? el('button', { type: 'button', class: 'btn btn-sm', text: T('timers.save') }) : null;
    if (save) {
      save.addEventListener('click', function () {
        if (save.disabled) return;
        var picked = $$('.sk-timer-day[aria-pressed="true"]', dayRow).map(function (b) { return b.getAttribute('data-day'); });
        if (!time.value || !picked.length) { msg.textContent = T('timers.invalid'); return; }
        // freeze the whole row: "saved" must not confirm edits typed after sending
        var fields = [enabled, time, save].concat($$('.sk-timer-day', dayRow));
        fields.forEach(function (f) { f.disabled = true; });
        msg.textContent = '';
        msg.classList.remove('is-ok');
        S.api('POST', 'vehicles/' + Number(v.id) + '/command', { action: 'timer_set', args: { id: Number(t.id), enabled: enabled.checked, time: time.value, days: picked } })
          .then(function () {
            row.removeAttribute('data-dirty');
            msg.textContent = T('timers.saved');
            msg.classList.add('is-ok');
          }, function (e) {
            var code = S.codeOf(e);
            msg.textContent = T(code && Object.prototype.hasOwnProperty.call(S.TIMER_ERRORS, code) ? S.TIMER_ERRORS[code] : 'timers.save_failed');
          })
          .then(function () { fields.forEach(function (f) { f.disabled = false; }); });
      });
    }
    row.appendChild(el('div', { class: 'sk-timer-head' }, [
      el('strong', { text: T('timers.timer', { n: Number(t.id) }) }),
      el('label', { class: 'check' }, [enabled, ' ' + T('timers.active')]),
      el('label', { class: 'sk-field' }, [T('timers.time') + ' ', time]),
    ]));
    row.appendChild(dayRow);
    row.appendChild(el('div', { class: 'sk-timer-foot' }, [save, msg]));
    return row;
  }

  // Emergency brake like the built-in page: an unsaved timer edit blocks
  // reloads, but only for 10 minutes — otherwise a never-saved row would
  // block every action of the page until a reload.
  var dirtyTimer = null;
  function markDirty() {
    clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(function () { $$('.sk-timer[data-dirty]').forEach(function (r) { r.removeAttribute('data-dirty'); }); }, 600000);
  }

  function detailsNode(d) {
    var meta = d.meta || {};
    var rows = [];
    function row(label, value) { if (value != null && value !== '') rows.push(el('div', null, [el('dt', { text: label }), el('dd', { text: String(value) })])); }
    row(T('details.model'), meta.title || meta.model);
    row(T('details.year'), meta.modelYear);
    row(T('details.made'), meta.manufacturingDate);
    row(T('details.body'), meta.body);
    row(T('details.trim'), meta.trimLevel);
    row(T('details.power'), meta.powerKw != null ? S.fmtNum(meta.powerKw) + ' kW' : null);
    row(T('details.battery'), meta.batteryKwh != null ? S.fmtNum(meta.batteryKwh, 1) + ' kWh' : null);
    row(T('details.max_charging'), meta.maxChargingKw != null ? S.fmtNum(meta.maxChargingKw) + ' kW' : null);
    var conn = d.connection;
    if (conn) {
      var parts = [];
      if (conn.online != null) parts.push(conn.online ? T('details.online') : T('details.offline'));
      if (conn.ignitionOn != null) parts.push(conn.ignitionOn ? T('details.ignition_on') : T('details.ignition_off'));
      if (conn.inMotion) parts.push(T('details.in_motion'));
      row(T('details.connection'), parts.join(', '));
    }
    var score = d.drivingScore;
    if (score) {
      var sp = [];
      if (score.weekly != null) sp.push(T('details.score_weekly') + ': ' + S.fmtNum(score.weekly));
      if (score.monthly != null) sp.push(T('details.score_monthly') + ': ' + S.fmtNum(score.monthly));
      if (score.lastCalculationDate != null) sp.push(T('details.score_as_of') + ': ' + score.lastCalculationDate);
      row(T('details.score'), sp.join(' · '));
    }
    var out = el('div', null, [rows.length ? el('dl', { class: 'sk-facts' }, rows) : null]);
    var eq = Array.isArray(d.equipment) ? d.equipment : [];
    if (eq.length) {
      out.appendChild(el('div', { class: 'sk-equipment' }, [el('strong', { text: T('details.equipment') })].concat(eq.map(function (e) { return el('span', { class: 'sk-chip', text: String(e) }); }))));
    }
    if (!rows.length && !eq.length) out.appendChild(el('p', { class: 'muted', text: T('details.none') }));
    return out;
  }

  function loadDetails(vehId, box) {
    if (enrich[vehId]) { S.clear(box).appendChild(enrich[vehId].cloneNode(true)); return; }
    if (pending[vehId]) return;
    pending[vehId] = true;
    S.clear(box).appendChild(el('p', { class: 'muted', text: T('common.loading') }));
    S.api('GET', 'vehicles/' + Number(vehId) + '/details').then(function (r) {
      var node = detailsNode((r && r.details) || {});
      enrich[vehId] = node;
      S.clear(box).appendChild(node.cloneNode(true));
    }, function (e) {
      // transient (esp. 429) — shown, not cached, so reopening retries
      S.clear(box).appendChild(el('p', { class: 'sk-details-error', text: e && e.status === 429 ? T('details.rate_limited') : T('details.load_error') }));
    }).then(function () { delete pending[vehId]; });
  }

  function loadImage(v, img) {
    if (images[v.id]) { img.src = images[v.id]; img.hidden = false; return; }
    if (images[v.id] === false) return;
    images[v.id] = false;
    S.api('GET', 'vehicles/' + Number(v.id) + '/image').then(function (r) {
      var src = S.safeImage(r && r.image);
      if (!src) return;
      images[v.id] = src;
      img.src = src;
      img.hidden = false;
    }, function () { delete images[v.id]; });
  }

  function command(vehId, action, args, ctl) {
    var go = action === 'unlock'
      ? S.confirm({ message: T('cmd.confirm_unlock'), okLabel: T('cmd.unlock'), danger: true })
      : Promise.resolve(true);
    return go.then(function (ok) {
      if (!ok || (ctl && ctl.disabled)) return; // in flight → no command storm
      var isBtn = ctl && ctl.tagName === 'BUTTON';
      var label = isBtn ? ctl.textContent : null;
      if (ctl) { ctl.disabled = true; if (isBtn) ctl.textContent = T('cmd.running'); }
      var reset = function () { if (ctl) { ctl.disabled = false; if (isBtn && label != null) ctl.textContent = label; } };
      return S.api('POST', 'vehicles/' + Number(vehId) + '/command', { action: action, args: args || {} }).then(function () {
        S.toast(T('cmd.sent'));
        setTimeout(load, 3000); // let the post-command refresh start, then reload the state
      }, function (e) {
        var code = S.codeOf(e);
        S.toast(code === 'SKODA_SPIN_REQUIRED' ? T('cmd.spin_required') : ((e && e.message) || T('cmd.failed')), 'error');
      }).then(function () { setTimeout(reset, 3000); });
    });
  }

  function vehicleCard(v, open) {
    var s = v.state || {};
    var lock = s.locked === true ? T('vehicle.locked') : (s.locked === false ? T('vehicle.unlocked') : '—');
    var fetched = v.fetched_at ? T('vehicle.fetched', { time: (S.toDate(v.fetched_at) || new Date(0)).toLocaleString(S.LOCALE) }) : '—';
    var img = el('img', { class: 'sk-card-img', alt: '', hidden: true });
    if (v.has_image) loadImage(v, img);
    var tempInput = el('input', { type: 'number', class: 'form-input sk-num', min: '15.5', max: '30', step: '0.5', value: '21', 'aria-label': T('cmd.set_temp') });
    function wantTemp() { var n = Number(tempInput.value); return { temp: isFinite(n) && n ? n : 21 }; }
    function cmdBtn(action, label, args, cls) {
      var b = el('button', { type: 'button', class: 'btn btn-sm' + (cls ? ' ' + cls : ''), text: label });
      b.addEventListener('click', function () { command(v.id, action, typeof args === 'function' ? args() : args, b); });
      return b;
    }
    var limit = el('select', { class: 'form-select sk-limit', 'aria-label': T('cmd.set_limit') }, [50, 60, 70, 80, 90, 100].map(function (p) {
      return el('option', { value: String(p), selected: s.charging && Number(s.charging.targetPercent) === p, text: p + ' %' });
    }));
    limit.addEventListener('change', function () { command(v.id, 'charge_limit', { limit: Number(limit.value) }, limit); });
    var detailsBox = el('div', { class: 'sk-enrich' });
    var det = el('details', { class: 'sk-details-block', open: open && open.details }, [el('summary', { text: T('details.title') }), detailsBox]);
    det.addEventListener('toggle', function () { if (det.open) loadDetails(v.id, detailsBox); });
    if (open && open.details) loadDetails(v.id, detailsBox);
    var timers = (s.climate && s.climate.timers) || [];
    var timersBlock = el('details', { class: 'sk-timers-block', open: open && open.timers }, [
      el('summary', { text: T('timers.title') }),
      timers.length ? el('div', null, timers.map(function (t) { return timerRow(v, t); })) : el('p', { class: 'muted', text: T('timers.none') }),
    ]);
    var owners = (v.owners || []).map(function (o) { return o.username; }).join(', ') || T('owner.none');
    return el('div', { class: 'sk-card', 'data-id': String(v.id) }, [
      img,
      el('div', { class: 'sk-card-head' }, [el('strong', { text: v.name || v.model || v.vin }), el('span', { class: 'sk-vin', text: v.vin })]),
      el('div', { class: 'sk-card-stats' }, [
        el('span', { text: T('vehicle.soc') + ': ' + (s.soc != null ? S.fmtNum(s.soc) + ' %' : '—') }),
        el('span', { text: T('vehicle.range') + ': ' + (s.rangeKm != null ? S.fmtNum(s.rangeKm) + ' km' : '—') }),
        el('span', { text: lock }),
        el('span', { text: T('vehicle.mileage') + ': ' + (s.health && s.health.mileageKm != null ? S.fmtNum(s.health.mileageKm) + ' km' : '—') }),
      ]),
      el('div', { class: 'sk-card-meta', text: fetched + ' · ' + T('vehicle.owners') + ': ' + owners }),
      el('div', { class: 'sk-card-actions' }, [
        el('button', { type: 'button', class: 'btn btn-sm', text: T('vehicle.owners'), on: { click: function () { openOwners(v); } } }),
        el('button', { type: 'button', class: 'btn btn-sm', text: T('vehicle.refresh'), on: { click: function (e) { refresh(v.id, e.currentTarget); } } }),
      ]),
      el('div', { class: 'sk-cmds' }, [
        cmdBtn('ac_start', T('cmd.ac_on'), wantTemp),
        cmdBtn('ac_stop', T('cmd.ac_off'), {}),
        el('label', { class: 'sk-field' }, [T('cmd.set_temp') + ' ', tempInput]),
        cmdBtn('ac_temp', T('cmd.set_temp'), wantTemp),
        cmdBtn('charge_start', T('cmd.charge_on'), {}),
        cmdBtn('charge_stop', T('cmd.charge_off'), {}),
        cmdBtn('window_heat_start', T('cmd.window_heat_on'), {}),
        cmdBtn('window_heat_stop', T('cmd.window_heat_off'), {}),
        cmdBtn('lock', T('cmd.lock'), {}),
        cmdBtn('unlock', T('cmd.unlock'), {}, 'btn-danger'),
        el('label', { class: 'sk-field' }, [T('cmd.set_limit') + ' ', limit]),
      ]),
      det,
      timersBlock,
    ]);
  }

  function refresh(id, btn) {
    if (btn) btn.disabled = true;
    S.api('POST', 'vehicles/' + Number(id) + '/refresh').then(function () { S.toast(T('vehicle.refreshed')); return load(); }, fail)
      .then(function () { if (btn) btn.disabled = false; });
  }

  // ─── Owners ───────────────────────────────────
  function renderOwnerList(selected) {
    var q = ($('#sk-owner-search').value || '').trim().toLowerCase();
    var list = S.clear($('#sk-owner-list'));
    (allUsers || []).filter(function (u) { return !q || String(u.username).toLowerCase().indexOf(q) >= 0; }).forEach(function (u) {
      var cb = el('input', { type: 'checkbox', value: String(u.id), checked: selected.has(u.id) });
      cb.addEventListener('change', function () { if (cb.checked) selected.add(u.id); else selected.delete(u.id); });
      list.appendChild(el('label', { class: 'sk-owner-item' }, [cb, ' ' + u.username]));
    });
  }
  var ownerSelected = new Set();
  function openOwners(v) {
    ownerVehicle = v;
    ownerSelected = new Set((v.owners || []).map(function (o) { return o.id; }));
    $('#sk-owner-sub').textContent = T('owner.sub', { name: v.name || v.model || v.vin });
    $('#sk-owner-search').value = '';
    var go = allUsers ? Promise.resolve() : S.api('GET', 'users').then(function (r) { allUsers = (r && r.users) || []; });
    go.then(function () { renderOwnerList(ownerSelected); S.openModal('sk-owner-modal'); }, fail);
  }
  $('#sk-owner-search').addEventListener('input', function () { renderOwnerList(ownerSelected); });
  $('#sk-owner-save').addEventListener('click', function () {
    if (!ownerVehicle) return;
    S.api('PUT', 'vehicles/' + Number(ownerVehicle.id) + '/owners', { user_ids: Array.from(ownerSelected) })
      .then(function () { S.closeModal('sk-owner-modal'); return load(); }, fail);
  });

  // ─── Load ─────────────────────────────────────
  function load() {
    var box = $('#sk-vehicles');
    // an unsaved timer edit wins over every rebuild (also the one 3 s after a command)
    if (box.querySelector('.sk-timer[data-dirty]')) return Promise.resolve();
    // open blocks per vehicle id (not by position)
    var open = {};
    $$('.sk-card', box).forEach(function (c) {
      open[c.getAttribute('data-id')] = {
        details: !!(c.querySelector('.sk-details-block') || {}).open,
        timers: !!(c.querySelector('.sk-timers-block') || {}).open,
      };
    });
    return S.api('GET', '').then(function (r) {
      current = r || { accounts: [], vehicles: [] };
      var poll = $('#sk-poll-interval');
      if (document.activeElement !== poll) poll.value = String(current.poll_interval_min || 15);
      var acc = S.clear($('#sk-accounts'));
      (current.accounts || []).forEach(function (a) { acc.appendChild(accountRow(a)); });
      if (!(current.accounts || []).length) acc.appendChild(el('p', { class: 'muted', text: T('accounts.empty') }));
      S.clear(box);
      (current.vehicles || []).forEach(function (v) { box.appendChild(vehicleCard(v, open[String(v.id)])); });
      if (!(current.vehicles || []).length) box.appendChild(el('p', { class: 'muted', text: T('vehicles.empty') }));
    }, fail);
  }

  $('#sk-account-add-open').addEventListener('click', function () { S.openModal('sk-account-modal'); });
  $('#sk-acc-save').addEventListener('click', function () {
    var email = $('#sk-acc-email').value;
    var password = $('#sk-acc-password').value;
    S.api('POST', 'accounts', { email: email, password: password }).then(function (r) {
      S.closeModal('sk-account-modal');
      $('#sk-acc-email').value = '';
      $('#sk-acc-password').value = '';
      if (r && r.account) syncAccount(r.account.id); else load();
    }, fail);
  });
  $('#sk-pw-save').addEventListener('click', function () {
    var pw = $('#sk-pw-input').value;
    if (!pw || passwordAccountId == null) return;
    S.api('PUT', 'accounts/' + Number(passwordAccountId), { password: pw }).then(function () {
      S.closeModal('sk-password-modal');
      $('#sk-pw-input').value = '';
      syncAccount(passwordAccountId);
    }, fail);
  });
  $('#sk-spin-save').addEventListener('click', function () {
    if (spinAccountId == null) return;
    S.api('PUT', 'accounts/' + Number(spinAccountId) + '/spin', { spin: $('#sk-spin-input').value }).then(function () {
      S.closeModal('sk-spin-modal');
      $('#sk-spin-input').value = '';
      S.toast(T('cmd.spin_saved'));
      load();
    }, fail);
  });
  $('#sk-poll-interval').addEventListener('change', function (ev) {
    S.api('PUT', 'settings', { poll_interval_min: Number(ev.target.value) }).then(function () { S.toast(T('settings.saved')); }, fail);
  });

  load();
}());
