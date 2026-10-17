/* Admin page "Protokoll": errors and limits only (no contents, no names). */
(function () {
  'use strict';
  var M = window.MS;
  var T = M.T;
  var el = M.el;
  var days = 7;

  function render(r) {
    var body = M.clear(M.$('#ms-log-rows'));
    (r.entries || []).forEach(function (e) {
      var what = M.CTX.texts['log.code.' + e.code] ? T('log.code.' + e.code) : e.code;
      body.appendChild(el('tr', {}, [
        el('td', { class: 'ms-mono', text: M.when(e.lastAt) }),
        el('td', {}, [el('span', { class: 'ms-pill is-' + e.level, text: T('log.level_' + e.level) })]),
        el('td', { text: what }),
        el('td', { class: 'ms-muted', text: e.detail || '–' }),
        el('td', { class: 'ms-mono', text: String(e.count) }),
      ]));
    });
    M.$('#ms-log-empty').hidden = !!(r.entries && r.entries.length);
  }

  function load() { M.api('GET', 'admin/log?days=' + days).then(render).catch(M.warn); }

  M.$$('[data-days]').forEach(function (b) {
    b.addEventListener('click', function () {
      days = Number(b.getAttribute('data-days'));
      M.$$('[data-days]').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      load();
    });
  });
  load();
}());
