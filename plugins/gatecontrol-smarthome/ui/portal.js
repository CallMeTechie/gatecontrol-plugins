/* Portal tab "Zuhause" (port of the Smart Home part of GateControl's public/js/portal.js).
   Only the viewer's own devices; switching needs a portal or web login. */
(function () {
  'use strict';
  var S = window.SH, T = S.T, $ = S.$, el = S.el;
  var loggedIn = !!S.CTX.loggedIn;
  var lang = S.CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  function fmtNum(v) { var n = Number(v); return Number.isFinite(n) ? n.toLocaleString(lang, { maximumFractionDigits: 1 }) : '–'; }

  function shStatus(d) {
    if (d.kind === 'scene') return T('portal.activate');
    var st = d.state || {};
    var on = st.on ? T('portal.on') : T('portal.off');
    if (st.on && d.capabilities && d.capabilities.bri && st.bri != null) return on + ' · ' + fmtNum(st.bri) + ' %';
    return on;
  }
  function control(id, patch) {
    if (!loggedIn) return Promise.resolve(false);
    return S.api('POST', 'portal/resources/' + Number(id) + '/state', { patch: patch }).then(function () { return true; },
      function () { S.toast(T('portal.error'), 'error'); return false; });
  }
  function sync(tile, d) {
    var on = !!(d.state && d.state.on);
    tile.classList.toggle('is-on', on && d.kind !== 'scene');
    var b = tile.querySelector('.pt-shtile-main');
    if (b && d.kind !== 'scene') b.setAttribute('aria-pressed', on ? 'true' : 'false');
    var s = tile.querySelector('.pt-small');
    if (s) s.textContent = shStatus(d);
  }
  function tile(d) {
    var st = d.state || {};
    var scene = d.kind === 'scene';
    var main = el('button', { type: 'button', class: 'pt-shtile-main', 'aria-pressed': scene ? null : (st.on ? 'true' : 'false'), disabled: !loggedIn },
      [el('b', { text: scene ? T('portal.scene', { name: d.name || '' }) : (d.name || '') }), el('span', { class: 'pt-small', text: shStatus(d) })]);
    var t = el('div', { class: 'pt-shtile' + (st.on && !scene ? ' is-on' : ''), 'data-id': String(d.id) }, [main]);
    main.addEventListener('click', function () {
      if (scene) { control(d.id, {}).then(function (ok) { if (ok) S.toast(T('portal.scene_done', { name: d.name || '' })); }); return; }
      var next = !(d.state && d.state.on);
      d.state = Object.assign({}, d.state || {}, { on: next });
      sync(t, d);
      control(d.id, { on: next }).then(function (ok) { if (!ok) { d.state.on = !next; sync(t, d); } });
    });
    if (!scene && d.capabilities && d.capabilities.bri) {
      var range = el('input', { type: 'range', min: '0', max: '100', value: String(st.bri != null ? st.bri : 0), disabled: !loggedIn, 'aria-label': T('portal.brightness_of', { name: d.name || '' }) });
      range.addEventListener('change', function () {
        d.state = Object.assign({}, d.state || {}, { bri: Number(range.value) });
        sync(t, d);
        control(d.id, { bri: Number(range.value) });
      });
      t.appendChild(range);
    }
    return t;
  }
  function sensorValue(s) {
    var st = s.state || {};
    var v = st.value;
    if (v === null || v === undefined || v === '') return { text: '–', tone: null };
    switch (st.type) {
      case 'temperature': return { text: fmtNum(v) + ' °C', tone: null };
      case 'humidity': return { text: fmtNum(v) + ' %', tone: null };
      case 'lightlevel': return { text: fmtNum(v) + ' lx', tone: null };
      case 'open': return { text: v ? T('portal.open') : T('portal.closed'), tone: v ? 'warn' : 'good' };
      case 'presence': return { text: v ? T('portal.motion') : T('portal.no_motion'), tone: null };
      case 'water': return { text: v ? T('portal.wet') : T('portal.dry'), tone: v ? 'warn' : 'good' };
      default: return { text: '–', tone: null };
    }
  }
  function render(data) {
    var devices = data.devices || [];
    var sensors = data.sensors || [];
    var tiles = S.clear($('#pt-sh-tiles'));
    devices.forEach(function (d) { tiles.appendChild(tile(d)); });
    tiles.hidden = !devices.length;
    var list = S.clear($('#pt-sh-sensor-list'));
    sensors.forEach(function (s) { var v = sensorValue(s); list.appendChild(el('li', null, [el('span', { text: s.name || '' }), el('b', { 'data-tone': v.tone, text: v.text })])); });
    $('#pt-sh-sensors').hidden = !sensors.length;
    var empty = $('#pt-sh-empty');
    empty.textContent = T('portal.empty');
    empty.hidden = devices.length + sensors.length > 0;
    var hint = $('#pt-sh-hint');
    hint.textContent = T('portal.login_hint');
    hint.hidden = loggedIn || !devices.length;
  }
  function load() {
    return S.api('GET', 'portal').then(render, function () {
      var empty = $('#pt-sh-empty'); empty.textContent = T('portal.load_error'); empty.hidden = false;
    });
  }
  load();
  setInterval(function () {
    if (document.hidden) return;
    var ae = document.activeElement;
    if (ae && ae.tagName === 'INPUT') return;
    load();
  }, 30000);
}());
