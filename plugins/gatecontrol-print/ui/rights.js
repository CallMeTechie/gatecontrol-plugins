/* Admin page "Berechtigungen": per person print yes/no, scan yes/no, pages per day, black and white only. */
(function () {
  'use strict';
  var P = window.PR;
  var T = P.T, el = P.el, $ = P.$;

  function save(u, patch, input) {
    if (input) input.disabled = true;
    return P.api('PUT', 'admin/rights/' + u.id, patch).then(function () { P.toast(T('common.saved')); return load(); }).catch(function (e) { P.warn(e); load(); });
  }

  function check(u, key, label) {
    var admin = u.role === 'admin';
    var box = el('input', { type: 'checkbox', checked: !!u[key], disabled: admin, 'aria-label': u.name + ' – ' + label, on: { change: function () { var p = {}; p[key] = box.checked; save(u, p, box); } } });
    return el('td', null, [el('label', { class: 'check' }, [box, box.checked ? T('common.yes') : T('common.no')])]);
  }

  function limit(u) {
    if (u.role === 'admin') return el('td', { text: T('rights.none') });
    var n = el('input', { type: 'number', min: '0', max: '1000', step: '1', class: 'form-input', value: String(u.pagesPerDay || 0), 'aria-label': u.name + ' – ' + T('rights.col_limit'), on: { change: function () {
      var v = Math.max(0, Math.min(1000, parseInt(n.value, 10) || 0));
      save(u, { pagesPerDay: v }, n);
    } } });
    return el('td', null, [el('div', { class: 'pr-actions' }, [n, el('span', { class: 'pr-sub', text: T('rights.per_day') })])]);
  }

  function person(u) {
    var who = [u.name];
    if (u.role === 'admin') who.push(T('rights.admin'));
    else if (u.child) who.push(T('rights.child'));
    var av = el('span', { class: 'pr-av', text: u.initials || (u.name || '?').slice(0, 1) });
    if (u.color) av.style.background = u.color;
    return el('td', null, [av, el('strong', { text: who[0] }), who[1] ? el('span', { class: 'pr-sub', text: ' (' + who[1] + ')' }) : null]);
  }

  function load() {
    return P.api('GET', 'admin/rights').then(function (r) {
      var tbl = P.clear($('#pr-rights'));
      tbl.appendChild(el('thead', null, [el('tr', null, [T('rights.col_person'), T('rights.col_print'), T('rights.col_scan'), T('rights.col_limit'), T('rights.col_bw'), ''].map(function (h) { return el('th', { scope: 'col', text: h }); }))]));
      var body = el('tbody');
      (r.people || []).forEach(function (u) {
        var reset = u.source === 'custom' ? el('button', { class: 'btn btn-sm', type: 'button', text: T('rights.reset'), on: { click: function () { save(u, { reset: true }); } } }) : el('span', { class: 'pr-sub', text: T('rights.src.' + u.source) });
        body.appendChild(el('tr', { 'data-user': String(u.id) }, [person(u), check(u, 'print', T('rights.col_print')), check(u, 'scan', T('rights.col_scan')), limit(u), check(u, 'bwOnly', T('rights.col_bw')), el('td', null, [reset])]));
      });
      tbl.appendChild(body);
    }).catch(P.warn);
  }
  load();
})();
