/* Portal section "Klimaanlage" in the tab "Zuhause" (port of the Klima part of
   GateControl's public/js/portal.js). Only the viewer's own air conditioners;
   control needs a portal or web login. */
(function () {
  'use strict';
  var M = window.MD, T = M.T, $ = M.$, el = M.el;
  var loggedIn = !!M.CTX.loggedIn;
  var lang = M.CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  var MODES = ['auto', 'cool', 'heat', 'dry', 'fan'];
  var FAN_STEPS = [1, 20, 40, 60, 80, 100]; // percent steps like the Midea app; Auto = 102
  var devices = [];
  var timers = {};

  function fmtNum(v, digits) { var n = Number(v); return isFinite(n) ? n.toLocaleString(lang, { maximumFractionDigits: digits == null ? 1 : digits }) : '–'; }
  function fanIndex(v) { return FAN_STEPS.reduce(function (b, val, i, a) { return Math.abs(val - v) < Math.abs(a[b] - v) ? i : b; }, 0); }
  function byId(id) { for (var i = 0; i < devices.length; i++) if (devices[i].id === id) return devices[i]; return null; }
  function info(d) {
    var st = d.state || {};
    var offline = !d.state || !!st.offline;
    return { st: st, offline: offline, powered: !offline && !!st.power, canControl: loggedIn && !offline };
  }
  function modeLabel(m) { return T('portal.mode_' + m); }
  function switchBtn(on, label, disabled, onClick) {
    return el('button', { type: 'button', class: 'pt-switch', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label, disabled: disabled, on: { click: onClick } },
      [el('span', { class: 'pt-knob', 'aria-hidden': 'true' })]);
  }
  function stepper(d) {
    var i = info(d);
    var tgt = Number(i.st.targetTemp);
    var has = !i.offline && i.st.targetTemp != null && isFinite(tgt);
    var dis = !i.canControl || !has;
    return el('div', { class: 'pt-stepper' }, [
      el('button', { type: 'button', class: 'pt-round', 'data-act': 'down', 'aria-label': T('portal.cooler_name', { name: d.name }), disabled: dis, on: { click: function () { step(d.id, -1); } } }, ['−']),
      el('span', { class: 'pt-target', 'aria-live': 'polite', text: has ? fmtNum(tgt, 1) + '°' : '–' }),
      el('button', { type: 'button', class: 'pt-round', 'data-act': 'up', 'aria-label': T('portal.warmer_name', { name: d.name }), disabled: dis, on: { click: function () { step(d.id, 1); } } }, ['+']),
    ]);
  }
  function renderCard(d) {
    var i = info(d);
    var st = i.st;
    var dis = !i.canControl;
    var status = i.offline ? T('portal.offline') : (i.powered ? T('portal.power_on') : T('portal.power_off'));
    var sub = [T('portal.target')];
    if (!i.offline && st.indoorTemp != null && isFinite(Number(st.indoorTemp))) sub.push(T('portal.now', { temp: fmtNum(st.indoorTemp, 1) + '°' }));
    if (!i.offline && st.outdoorTemp != null && isFinite(Number(st.outdoorTemp))) sub.push(T('portal.outside', { temp: fmtNum(st.outdoorTemp, 0) + '°' }));
    var modes = el('div', { class: 'pt-seg', role: 'group', 'aria-label': T('portal.mode') }, MODES.map(function (m) {
      var on = !i.offline && st.mode === m;
      return el('button', { type: 'button', 'data-mode': m, 'aria-pressed': on ? 'true' : 'false', disabled: dis, class: on && m === 'heat' ? 'is-heat' : null,
        on: { click: function () { control(d.id, { mode: m }); } } }, [modeLabel(m)]);
    }));
    var isAuto = !i.offline && st.fanSpeed === 102;
    var idx = (i.offline || st.fanSpeed == null || !isFinite(Number(st.fanSpeed))) ? 3 : fanIndex(Number(st.fanSpeed));
    var fanVal = el('span', { class: 'pt-fan-val', text: isAuto ? T('portal.fan_auto') : FAN_STEPS[idx] + ' %' });
    var slider = el('input', { type: 'range', min: '0', max: '5', step: '1', value: String(idx), 'data-act': 'fan', disabled: dis,
      'aria-label': T('portal.fan'), 'aria-valuetext': isAuto ? T('portal.fan_auto') : FAN_STEPS[idx] + ' %' });
    slider.addEventListener('input', function () { fanVal.textContent = FAN_STEPS[Number(slider.value)] + ' %'; });
    slider.addEventListener('change', function () { control(d.id, { fanSpeed: FAN_STEPS[Number(slider.value)] }); });
    var toggles = el('div', { class: 'pt-chip-row' }, [
      el('button', { type: 'button', class: 'pt-chip', 'data-act': 'fan-auto', 'aria-pressed': isAuto ? 'true' : 'false', disabled: dis,
        on: { click: function () { control(d.id, { fanSpeed: 102 }); } } }, [T('portal.fan_auto_btn')]),
      el('button', { type: 'button', class: 'pt-chip', 'data-act': 'turbo', 'aria-pressed': (!i.offline && st.turbo) ? 'true' : 'false', disabled: dis,
        on: { click: function () { control(d.id, { turbo: !st.turbo }); } } }, [T('portal.turbo')]),
      el('button', { type: 'button', class: 'pt-chip', 'data-act': 'eco', 'aria-pressed': (!i.offline && st.eco) ? 'true' : 'false', disabled: dis,
        on: { click: function () { control(d.id, { eco: !st.eco }); } } }, [T('portal.eco')]),
    ]);
    return el('section', { class: 'card pt-ac' + (i.offline ? ' is-offline' : ''), 'data-id': String(d.id), 'aria-label': d.name }, [
      el('div', { class: 'pt-card-row' }, [
        el('h2', { class: 'pt-h2', text: d.name }),
        el('span', { class: 'pt-pill', 'data-tone': i.offline ? 'muted' : (i.powered ? 'good' : 'muted'), text: status }),
        switchBtn(i.powered, T('portal.power_name', { name: d.name }), dis, function () { control(d.id, { power: !i.powered }); }),
      ]),
      el('div', { class: 'pt-ac-climate' }, [stepper(d), el('div', { class: 'pt-ac-sub muted', text: sub.join(' · ') })]),
      modes,
      el('div', { class: 'pt-fan' }, [
        el('div', { class: 'pt-fan-head' }, [el('span', { class: 'pt-overline', text: T('portal.fan') }), fanVal]),
        slider,
        el('div', { class: 'pt-fan-ticks', 'aria-hidden': 'true' }, FAN_STEPS.map(function (v) { return el('span', { text: v + '%' }); })),
      ]),
      toggles,
      el('div', { class: 'pt-foot', text: d.transport === 'cloud' ? T('portal.cloud') : T('portal.lan') }),
    ]);
  }
  // Re-render one device, keeping keyboard focus on the same control.
  function focusKey(node) {
    if (!node || !node.getAttribute) return null;
    if (node.getAttribute('role') === 'switch') return '[role="switch"]';
    if (node.getAttribute('data-mode')) return '[data-mode="' + node.getAttribute('data-mode') + '"]';
    if (node.getAttribute('data-act')) return '[data-act="' + node.getAttribute('data-act') + '"]';
    return null;
  }
  function refresh(id, confirmed) {
    var d = byId(id);
    var old = document.querySelector('.pt-ac[data-id="' + id + '"]');
    if (!d || !old) return;
    var active = document.activeElement;
    var key = active && old.contains(active) ? focusKey(active) : null;
    var fresh = renderCard(d);
    old.replaceWith(fresh);
    if (confirmed) { var s = fresh.querySelector('.pt-stepper'); if (s) s.classList.add('is-confirmed'); }
    if (key) { var target = fresh.querySelector(key); if (target && !target.disabled) target.focus(); }
  }
  function failed() { M.toast(T('portal.error'), 'error'); }
  function control(id, patch) {
    if (!loggedIn) return;
    M.api('POST', 'portal/devices/' + Number(id) + '/state', { patch: patch }).then(function (r) {
      var d = byId(id);
      if (d && r && r.state) { d.state = r.state; refresh(id, false); }
    }, failed);
  }
  // Target temperature: whole degrees, optimistic, debounced (rapid +/- clicks
  // coalesce into one command); the device's confirmed value turns it green.
  function step(id, delta) {
    var d = byId(id);
    if (!d || !d.state) return;
    var cur = Number(d.state.targetTemp);
    if (!isFinite(cur)) return;
    var next = Math.min(30, Math.max(16, Math.round(cur) + delta));
    d.state = Object.assign({}, d.state, { targetTemp: next });
    var card = document.querySelector('.pt-ac[data-id="' + id + '"]');
    if (card) {
      card.querySelector('.pt-target').textContent = fmtNum(next, 1) + '°';
      var s = card.querySelector('.pt-stepper'); s.classList.add('is-pending'); s.classList.remove('is-confirmed');
    }
    clearTimeout(timers[id]);
    timers[id] = setTimeout(function () {
      delete timers[id];
      M.api('POST', 'portal/devices/' + Number(id) + '/state', { patch: { targetTemp: next } }).then(function (r) {
        if (r && r.state) { d.state = r.state; refresh(id, true); }
      }, function () {
        var c = document.querySelector('.pt-ac[data-id="' + id + '"] .pt-stepper');
        if (c) c.classList.remove('is-pending');
        failed();
      });
    }, 500);
  }
  function load() {
    return M.api('GET', 'portal').then(function (r) {
      devices = r.devices || [];
      var list = M.clear($('#pt-md-list'));
      devices.forEach(function (d) { list.appendChild(renderCard(d)); });
      var empty = $('#pt-md-empty');
      empty.textContent = T('portal.empty');
      empty.hidden = devices.length > 0;
      var hint = $('#pt-md-hint');
      hint.textContent = T('portal.login_hint');
      hint.hidden = loggedIn || !devices.length;
    }, function () {
      var empty = $('#pt-md-empty'); empty.textContent = T('portal.load_error'); empty.hidden = false;
    });
  }
  load();
  // every 120 s (cloud devices are served from cache); never while a control is in use
  setInterval(function () {
    if (document.hidden || navigator.onLine === false) return;
    devices.forEach(function (d) {
      var a = document.activeElement;
      if (a && a.getAttribute && a.getAttribute('data-act') === 'fan' && a.closest('[data-id="' + d.id + '"]')) return;
      if (timers[d.id]) return;
      M.api('GET', 'portal/devices/' + Number(d.id) + '/state').then(function (r) {
        if (r && r.state) { d.state = r.state; refresh(d.id, false); }
      }, function () { /* a failed tick is retried on the next one */ });
    });
  }, 120000);
}());
