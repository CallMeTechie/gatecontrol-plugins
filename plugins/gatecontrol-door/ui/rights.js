/* Admin page "Berechtigungen": per person and lock a level; per person time window, auto-unlock opt-in, pushes per camera. */
(function () {
  'use strict';
  var D = window.DOOR;
  var T = D.T, el = D.el, $ = D.$;
  var S = null;
  var LEVELS = ['none', 'view', 'lock', 'open'];

  function levelSelect(u, l) {
    var cur = ((S.rights[u.id] || {})[l.id]) || 'none';
    var sel = el('select', { class: 'form-select', 'aria-label': u.name + ' – ' + l.name, on: { change: function () {
      var locks = {}; locks[l.id] = sel.value;
      D.api('PUT', 'admin/rights/' + u.id, { locks: locks }).then(function (r) { S = r; D.toast(T('common.saved')); }).catch(function (e) { D.warn(e); render(); });
    } } }, LEVELS.filter(function (lv) { return lv !== 'open' || l.actions.indexOf('open') >= 0 || cur === 'open'; }).map(function (lv) {
      return el('option', { value: lv, text: T('level.' + lv), selected: lv === cur });
    }));
    return sel;
  }

  function winText(p) {
    if (!p || !p.window) return T('rights.window_none');
    return p.window.days.map(function (d) { return T('wd.' + d); }).join(' ') + ' ' + p.window.from + '–' + p.window.to;
  }

  function edit(u) {
    var p = S.prefs[u.id] || { autoUnlock: false, window: null };
    var w = p.window || { days: [1, 2, 3, 4, 5], from: '07:00', to: '20:00' };
    var on = el('input', { type: 'checkbox', checked: !!p.window });
    var days = [1, 2, 3, 4, 5, 6, 7].map(function (d) { return el('input', { type: 'checkbox', checked: w.days.indexOf(d) >= 0, 'data-d': String(d) }); });
    var from = el('input', { class: 'form-input', type: 'time', value: w.from });
    var to = el('input', { class: 'form-input', type: 'time', value: w.to });
    var auto = el('input', { type: 'checkbox', checked: p.autoUnlock });
    var cp = S.cameraPrefs[u.id] || {};
    var camRows = S.cameras.filter(function (c) { return c.lockId; }).map(function (c) {
      var x = cp[c.id] || { ding: true, motion: false };
      var ding = el('input', { type: 'checkbox', checked: x.ding, 'data-c': String(c.id), 'data-k': 'ding' });
      var motion = el('input', { type: 'checkbox', checked: x.motion, 'data-c': String(c.id), 'data-k': 'motion' });
      return { c: c, ding: ding, motion: motion, node: el('div', { class: 'dr-days' }, [el('strong', { text: c.name }), el('label', {}, [ding, T('portal.ding_push')]), el('label', {}, [motion, T('portal.motion_push')])]) };
    });
    var form = el('div', {}, [
      el('div', { class: 'dr-item-title', text: u.name }),
      el('label', { class: 'check' }, [on, T('rights.window_on')]),
      el('div', { class: 'dr-days' }, days.map(function (c) { return el('label', {}, [c, T('wd.' + c.getAttribute('data-d'))]); })),
      el('div', { class: 'form-row' }, [el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: T('rights.from') }), from]), el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: T('rights.to') }), to])]),
      el('label', { class: 'check' }, [auto, T('rights.auto')]),
      el('p', { class: 'dr-hint', text: T('rights.auto_hint') }),
      camRows.length ? el('div', { class: 'form-label', text: T('rights.camera_push') }) : null,
    ].concat(camRows.map(function (x) { return x.node; })));
    D.dialog(form, [{ label: T('common.cancel'), value: false }, { label: T('common.save'), value: true, primary: true }]).then(function (ok) {
      if (!ok) return;
      var cams = {};
      camRows.forEach(function (x) { cams[x.c.id] = { ding: x.ding.checked, motion: x.motion.checked }; });
      var body = {
        autoUnlock: auto.checked, cameras: cams,
        window: on.checked ? { days: days.filter(function (c) { return c.checked; }).map(function (c) { return Number(c.getAttribute('data-d')); }), from: from.value, to: to.value } : null,
      };
      D.api('PUT', 'admin/rights/' + u.id, body).then(function (r) { S = r; D.toast(T('common.saved')); render(); }).catch(D.warn);
    });
  }

  function render() {
    var table = D.clear($('#dr-rights'));
    table.appendChild(el('thead', {}, [el('tr', {}, [el('th', { text: T('rights.person') })].concat(S.locks.map(function (l) { return el('th', { text: l.name }); }), [el('th', { text: T('rights.window') }), el('th', { text: T('rights.auto') }), el('th', {})]))]));
    var body = el('tbody');
    S.users.forEach(function (u) {
      var p = S.prefs[u.id];
      body.appendChild(el('tr', {}, [el('td', { text: u.name + (u.role === 'admin' ? ' (Admin)' : '') })].concat(
        S.locks.map(function (l) { return el('td', {}, [levelSelect(u, l)]); }),
        [el('td', { text: winText(p) }), el('td', { text: p && p.autoUnlock ? T('common.yes') : T('common.no') }),
          el('td', {}, [el('button', { type: 'button', class: 'btn btn-sm', text: T('common.edit'), on: { click: function () { edit(u); } } })])])));
    });
    table.appendChild(body);
    $('#dr-no-users').hidden = S.users.length > 0;
  }

  D.api('GET', 'admin/rights').then(function (r) { S = r; render(); }).catch(D.warn);
})();
