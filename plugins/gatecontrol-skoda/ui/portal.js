/* Portal section "Fahrzeuge" in the tab "Fahrzeug" (port of the vehicle part
   of GateControl's public/js/portal.js). Only the viewer's own vehicles;
   controls, position and departure times need a portal or web login. */
(function () {
  'use strict';
  var S = window.SK, T = S.T, $ = S.$, $$ = S.$$, el = S.el, fmtNum = S.fmtNum;
  var vehicles = [];
  var loggedIn = false;
  var detailsCache = {};
  var images = {};
  var dirtyTimers = false;

  function up(x) { return String(x || '').toUpperCase(); }
  function temp(v) { return fmtNum(v, 1) + ' °C'; }
  function carState(v) {
    var s = v.state || {};
    var ch = s.charging || {};
    var cl = s.climate || {};
    return { s: s, ch: ch, cl: cl, hl: s.health || {}, mt: s.maintenance || {}, dt: s.detail || {},
      charging: up(ch.state) === 'CHARGING', climateOn: cl.state != null && up(cl.state) !== 'OFF' };
  }
  function carLine(v) {
    var c = carState(v);
    var parts = [];
    if (c.s.locked === true) parts.push(T('portal.locked'));
    else if (c.s.locked === false) parts.push(T('portal.unlocked'));
    if (c.s.doorsOpen === false && c.s.windowsOpen === false) parts.push(T('portal.all_closed'));
    else if (c.s.doorsOpen || c.s.windowsOpen) parts.push(T('portal.something_open'));
    if (c.charging) parts.push(T('portal.charging'));
    if (v.fetched_at) parts.push(T('portal.as_of', { when: S.rel(v.fetched_at) }));
    return parts.join(' · ');
  }
  function carCommand(v, action, args, ctl) {
    if (!loggedIn) return Promise.resolve();
    // sensitive: unlocking asks first (the plugin checks login + owner again)
    var go = action === 'unlock'
      ? S.confirm({ title: T('portal.confirm_unlock_title', { name: v.name || v.model || '' }), message: T('portal.confirm_unlock'), okLabel: T('portal.unlock_ok'), danger: true })
      : Promise.resolve(true);
    return go.then(function (ok) {
      if (!ok || (ctl && ctl.disabled)) return null;
      if (ctl) { ctl.disabled = true; ctl.setAttribute('aria-busy', 'true'); }
      return S.api('POST', 'portal/vehicles/' + Number(v.id) + '/command', { action: action, args: args || {} }).then(function () {
        S.toast(T('portal.cmd_sent'));
        setTimeout(function () { load(true); }, 3000);
      }, function (e) {
        var code = S.codeOf(e);
        S.toast(code === 'SKODA_SPIN_REQUIRED' ? T('cmd.spin_required') : ((e && e.message) || T('portal.cmd_failed')), 'error');
      }).then(function () {
        if (ctl) setTimeout(function () { ctl.disabled = false; ctl.removeAttribute('aria-busy'); }, 3000);
      });
    });
  }
  function actionBtn(v, title, sub, action, args, cls) {
    var b = el('button', { type: 'button', class: 'pt-action' + (cls ? ' ' + cls : ''), 'data-cmd': action }, [el('b', { text: title }), sub ? el('span', { class: 'pt-small muted', text: sub }) : null]);
    b.addEventListener('click', function () { carCommand(v, action, typeof args === 'function' ? args() : args, b); });
    return b;
  }
  function battery(v) {
    var c = carState(v);
    var soc = Number(c.s.soc);
    var has = c.s.soc != null && isFinite(soc);
    var fill = el('span');
    fill.style.setProperty('--w', (has ? Math.max(0, Math.min(100, soc)) : 0) + '%');
    var bar = el('div', { class: 'pt-progress' + (c.charging ? ' is-charging' : '') + (has && soc <= 15 ? ' is-low' : ''), role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
      'aria-valuenow': has ? String(soc) : null, 'aria-label': T('portal.battery') }, [fill]);
    return el('div', { class: 'pt-batt' }, [bar, c.charging ? el('div', { class: 'pt-small muted', text: T('portal.charging_detail', {
      power: fmtNum(c.ch.powerKw, 1), minutes: fmtNum(c.ch.remainingMin), target: fmtNum(c.ch.targetPercent) }) }) : null]);
  }
  function carTags(v) {
    var c = carState(v);
    var list = [[T('portal.doors'), c.s.doorsOpen === true], [T('portal.windows'), c.s.windowsOpen === true],
      [T('portal.bonnet'), up(c.dt.bonnet) === 'OPEN'], [T('portal.trunk'), up(c.dt.trunk) === 'OPEN']];
    if (c.dt.sunroof != null && up(c.dt.sunroof) !== 'UNSUPPORTED') list.push([T('portal.sunroof'), up(c.dt.sunroof) === 'OPEN']);
    if (c.s.lightsOn === true) list.push([T('portal.lights_on'), true]);
    if (c.ch.cableConnected) list.push([T('portal.cable'), false]);
    return el('div', { class: 'pt-chip-row' }, list.map(function (x) {
      return el('span', { class: 'pt-tag' + (x[1] ? ' is-open' : ''), text: x[1] ? T('portal.open_item', { item: x[0] }) : x[0] });
    }));
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
    row(T('details.power'), meta.powerKw != null ? fmtNum(meta.powerKw) + ' kW' : null);
    row(T('details.battery'), meta.batteryKwh != null ? fmtNum(meta.batteryKwh, 1) + ' kWh' : null);
    row(T('details.max_charging'), meta.maxChargingKw != null ? fmtNum(meta.maxChargingKw) + ' kW' : null);
    row(T('details.vin'), meta.vin);
    var conn = d.connection;
    if (conn) {
      var parts = [];
      if (conn.online != null) parts.push(conn.online ? T('portal.d_online') : T('portal.d_offline'));
      if (conn.ignitionOn != null) parts.push(conn.ignitionOn ? T('portal.d_ignition_on') : T('portal.d_ignition_off'));
      if (conn.inMotion) parts.push(T('portal.d_in_motion'));
      row(T('portal.d_connection'), parts.join(', '));
    }
    var score = d.drivingScore;
    if (score) {
      var sp = [];
      if (score.weekly != null) sp.push(T('portal.d_score_week', { value: fmtNum(score.weekly) }));
      if (score.monthly != null) sp.push(T('portal.d_score_month', { value: fmtNum(score.monthly) }));
      if (score.lastCalculationDate != null) sp.push(T('portal.d_score_as_of', { date: String(score.lastCalculationDate) }));
      row(T('portal.d_score'), sp.join(' · '));
    }
    var out = el('div', null, [el('dl', { class: 'pt-facts' }, rows)]);
    var eq = Array.isArray(d.equipment) ? d.equipment : [];
    if (eq.length) out.appendChild(el('div', { class: 'pt-chip-row' }, eq.map(function (e) { return el('span', { class: 'pt-tag', text: String(e) }); })));
    if (!rows.length && !eq.length) out.appendChild(el('div', { class: 'pt-small muted', text: T('portal.details_none') }));
    return out;
  }
  function detailsBlock(v) {
    var body = el('div', { class: 'pt-details-body' }, [el('div', { class: 'pt-small muted', text: T('common.loading') })]);
    var det = el('details', { class: 'pt-details' }, [el('summary', { text: T('portal.details') }), body]);
    det.addEventListener('toggle', function () {
      if (!det.open) return;
      if (detailsCache[v.id]) { S.clear(body).appendChild(detailsCache[v.id].cloneNode(true)); return; }
      S.api('GET', 'portal/vehicles/' + Number(v.id) + '/details').then(function (r) {
        var node = detailsNode((r && r.details) || {});
        detailsCache[v.id] = node;
        S.clear(body).appendChild(node.cloneNode(true));
      }, function (e) {
        S.clear(body).appendChild(el('div', { class: 'pt-small', 'data-tone': 'warn', text: e && e.status === 429 ? T('portal.details_busy') : T('portal.details_error') }));
      });
    });
    return det;
  }
  function timerRow(v, t) {
    var days = Array.isArray(t.days) ? t.days : [];
    var editable = t.type === 'RECURRING';
    var msg = el('span', { class: 'pt-small', 'aria-live': 'polite', text: t.type === 'ONE_OFF' ? T('timers.readonly') : '' });
    var enabled = el('input', { type: 'checkbox', checked: !!t.enabled, disabled: !editable });
    var time = el('input', { type: 'time', class: 'pt-input pt-input-sm', value: String(t.time || ''), disabled: !editable, 'aria-label': T('portal.timer_time') });
    var dayRow = el('div', { class: 'pt-chip-row', role: 'group', 'aria-label': T('timers.days') }, S.DAYS.map(function (d) {
      var b = el('button', { type: 'button', class: 'pt-chip', 'data-day': d[0], 'aria-pressed': days.indexOf(d[0]) >= 0 ? 'true' : 'false', disabled: !editable, text: T('timers.day.' + d[1]) });
      b.addEventListener('click', function () { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); dirtyTimers = true; });
      return b;
    }));
    [enabled, time].forEach(function (n) { n.addEventListener('change', function () { dirtyTimers = true; }); });
    var save = editable ? el('button', { type: 'button', class: 'pt-btn pt-btn-sm', text: T('timers.save') }) : null;
    if (save) {
      save.addEventListener('click', function () {
        var picked = $$('[aria-pressed="true"]', dayRow).map(function (c) { return c.getAttribute('data-day'); });
        if (!time.value || !picked.length) { msg.textContent = T('timers.invalid'); return; }
        save.disabled = true;
        msg.textContent = '';
        S.api('POST', 'portal/vehicles/' + Number(v.id) + '/command', { action: 'timer_set', args: { id: Number(t.id), enabled: enabled.checked, time: time.value, days: picked } })
          .then(function () {
            dirtyTimers = false;
            msg.textContent = T('timers.saved');
          }, function (e) {
            var code = S.codeOf(e);
            msg.textContent = T(code && Object.prototype.hasOwnProperty.call(S.TIMER_ERRORS, code) ? S.TIMER_ERRORS[code] : 'timers.save_failed');
          })
          .then(function () { save.disabled = false; });
      });
    }
    return el('div', { class: 'pt-timer' }, [
      el('div', { class: 'pt-timer-head' }, [el('b', { text: T('timers.timer', { n: t.id }) }),
        el('label', { class: 'pt-check' }, [enabled, T('portal.timer_active')]), time]),
      dayRow,
      el('div', { class: 'pt-timer-foot' }, [save, msg]),
    ]);
  }
  function loadImage(v, holder) {
    function put(src) {
      S.clear(holder).appendChild(el('img', { class: 'pt-car-img', src: src, alt: '' }));
    }
    if (images[v.id]) { put(images[v.id]); return; }
    if (images[v.id] === false) return;
    images[v.id] = false;
    S.api('GET', 'portal/vehicles/' + Number(v.id) + '/image').then(function (r) {
      var src = S.safeImage(r && r.image);
      if (!src) return;
      images[v.id] = src;
      put(src);
    }, function () { delete images[v.id]; });
  }
  var CAR_ICON = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 16l1.5-5h11L19 16M4 16h16v3H4zM7 19v2M17 19v2"/></svg>';
  function renderCarCard(v) {
    var c = carState(v);
    var name = v.name || v.model || '';
    var tempInput = el('input', { type: 'number', min: '15.5', max: '30', step: '0.5', value: c.cl.targetC != null ? String(c.cl.targetC) : '21',
      class: 'pt-input pt-input-sm', 'aria-label': T('portal.target_temp') });
    function wantTemp() { var n = Number(tempInput.value); return { temp: isFinite(n) && n ? n : 21 }; }
    var pic = el('span', { class: 'pt-car-ic' });
    pic.innerHTML = CAR_ICON; // static markup above, no data
    if (v.has_image) loadImage(v, pic);
    var head = el('div', { class: 'pt-car-head' }, [
      pic,
      el('div', { class: 'pt-grow' }, [el('h2', { class: 'pt-h2 pt-h2-lg', text: name }), el('div', { class: 'pt-small muted', text: carLine(v) })]),
      el('div', { class: 'pt-car-stats' }, [
        el('div', null, [el('div', { class: 'pt-small muted', text: T('portal.battery') }), el('div', { class: 'pt-big', text: c.s.soc != null ? fmtNum(c.s.soc) + ' %' : '–' })]),
        el('div', null, [el('div', { class: 'pt-small muted', text: T('portal.range') }), el('div', { class: 'pt-big', text: c.s.rangeKm != null ? fmtNum(c.s.rangeKm) + ' km' : '–' })]),
      ]),
    ]);
    var card = el('section', { class: 'card pt-car', 'data-id': String(v.id), 'aria-label': name }, [head, battery(v), carTags(v)]);
    var limitText = c.ch.targetPercent != null ? T('portal.limit', { pct: fmtNum(c.ch.targetPercent) }) : null;
    if (loggedIn) {
      card.appendChild(el('div', { class: 'pt-actions' }, [
        c.climateOn ? actionBtn(v, T('portal.climate_off'), T('portal.climate_running'), 'ac_stop', {})
          : actionBtn(v, T('portal.climatize'), T('portal.to_temp', { temp: fmtNum(c.cl.targetC != null ? c.cl.targetC : 21, 1) }), 'ac_start', wantTemp),
        c.charging ? actionBtn(v, T('portal.charge_stop'), limitText, 'charge_stop', {}) : actionBtn(v, T('portal.charge_start'), limitText, 'charge_start', {}),
        c.cl.windowHeating === true ? actionBtn(v, T('portal.window_heat'), T('portal.on'), 'window_heat_stop', {})
          : actionBtn(v, T('portal.window_heat'), T('portal.off'), 'window_heat_start', {}),
        c.s.locked === false ? actionBtn(v, T('portal.lock'), T('portal.unlocked'), 'lock', {})
          : actionBtn(v, T('portal.unlock'), T('portal.with_confirm'), 'unlock', {}, 'is-danger'),
      ]));
      var limit = el('select', { class: 'pt-input pt-input-sm', 'aria-label': T('portal.charge_limit') }, [50, 60, 70, 80, 90, 100].map(function (p) {
        return el('option', { value: String(p), selected: Number(c.ch.targetPercent) === p, text: p + ' %' });
      }));
      limit.addEventListener('change', function () { carCommand(v, 'charge_limit', { limit: Number(limit.value) }, limit); });
      var setTemp = el('button', { type: 'button', class: 'pt-btn pt-btn-sm', text: T('portal.apply') });
      setTemp.addEventListener('click', function () { carCommand(v, 'ac_temp', wantTemp(), setTemp); });
      card.appendChild(el('div', { class: 'pt-car-settings' }, [
        el('div', { class: 'pt-inline-field' }, [el('span', { class: 'pt-small muted', text: T('portal.target_temp') }), tempInput, setTemp]),
        el('div', { class: 'pt-inline-field' }, [el('span', { class: 'pt-small muted', text: T('portal.charge_limit') }), limit]),
      ]));
    }
    var facts = [];
    function fact(label, value) { if (value != null && value !== '') facts.push(el('div', null, [el('dt', { text: label }), el('dd', { text: String(value) })])); }
    fact(T('portal.mileage'), c.hl.mileageKm != null ? fmtNum(c.hl.mileageKm) + ' km' : null);
    fact(T('portal.inspection'), c.mt.dueInDays != null ? T('portal.in_days', { days: fmtNum(c.mt.dueInDays) }) + (c.mt.dueInKm != null ? ' · ' + fmtNum(c.mt.dueInKm) + ' km' : '') : null);
    fact(T('portal.partner'), c.mt.partner || null);
    fact(T('portal.climate'), c.cl.state == null ? null : (c.climateOn ? T('portal.on') : T('portal.off'))
      + (c.cl.targetC != null ? ' · ' + temp(c.cl.targetC) : '') + (c.cl.remainingMin != null ? ' · ' + T('portal.minutes_left', { minutes: fmtNum(c.cl.remainingMin) }) : ''));
    var activeTimers = (c.cl.timers || []).filter(function (t) { return t.enabled && t.time; });
    if (activeTimers.length) fact(T('portal.timers'), activeTimers.map(function (t) { return t.time; }).join(', '));
    if (c.hl.warnings && c.hl.warnings.length) fact(T('portal.warnings'), c.hl.warnings.join(', '));
    var pos = c.s.position;
    if (pos) {
      var lat = Number(pos.lat);
      var lon = Number(pos.lon);
      var okPos = pos.lat != null && pos.lon != null && isFinite(lat) && isFinite(lon);
      // the frame cannot open other sites: address and coordinates as text
      fact(T('portal.position'), pos.address ? pos.address + (okPos ? ' (' + lat.toFixed(4) + ', ' + lon.toFixed(4) + ')' : '') : (okPos ? lat.toFixed(4) + ', ' + lon.toFixed(4) : null));
    }
    if (facts.length) card.appendChild(el('dl', { class: 'pt-facts' }, facts));
    card.appendChild(detailsBlock(v));
    if (loggedIn) {
      var all = c.cl.timers || [];
      card.appendChild(el('details', { class: 'pt-details pt-timers' }, [el('summary', { text: T('portal.timers_edit') }),
        el('div', { class: 'pt-details-body' }, all.length ? all.map(function (t) { return timerRow(v, t); }) : [el('div', { class: 'pt-small muted', text: T('portal.timers_none') })])]));
    }
    return card;
  }
  function render() {
    // an unsaved timer edit wins over a refresh
    if (dirtyTimers) return;
    var list = $('#pt-sk-list');
    var open = {};
    $$('.pt-car', list).forEach(function (c) {
      open[c.getAttribute('data-id')] = $$('details', c).map(function (d) { return d.open; });
    });
    S.clear(list);
    vehicles.forEach(function (v) {
      var card = renderCarCard(v);
      var prev = open[String(v.id)];
      if (prev) $$('details', card).forEach(function (d, i) { if (prev[i]) d.open = true; });
      list.appendChild(card);
    });
    var empty = $('#pt-sk-empty');
    empty.textContent = T('portal.empty');
    empty.hidden = vehicles.length > 0;
    $('#pt-sk-hint').hidden = loggedIn || !vehicles.length;
  }
  function load(refresh) {
    return S.api('GET', 'portal').then(function (r) {
      vehicles = (r && r.vehicles) || [];
      loggedIn = !!(r && r.loggedIn) && !!S.CTX.loggedIn;
      render();
    }, function () {
      if (refresh) return;
      var empty = $('#pt-sk-empty');
      empty.textContent = T('portal.load_error');
      empty.hidden = false;
    });
  }
  load(false);
  setInterval(function () {
    if (document.hidden) return;
    var ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT')) return;
    load(true);
  }, 120000);
}());
