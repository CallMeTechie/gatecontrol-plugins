/* Admin page "Sitzungen": the history of the apps' and the browser sessions, end an open browser session, CSV export. */
(function () {
  'use strict';
  var P = window.RM;
  var T = P.T, el = P.el, $ = P.$;
  var rows = [];
  var devicesLoaded = false;

  function line(s) {
    var who = s.userName || s.tokenName || T('ses.unknown');
    var badges = el('div', { class: 'rm-badges' }, [P.protoBadge(s.protocol), el('span', { class: 'rm-badge', text: T('ses.via.' + s.via) }),
      s.status === 'active' ? el('span', { class: 'rm-badge', 'data-tone': 'good', text: T('ses.active') }) : null,
      s.mode === 'view' ? el('span', { class: 'rm-badge', text: T('ses.view') }) : null]);
    var acts = el('div', { class: 'rm-actions' });
    if (s.status === 'active' && s.hostSessionId) {
      acts.appendChild(el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: T('ses.end'), on: { click: function (ev) {
        var b = ev.currentTarget;
        P.confirmDialog(T('ses.end_q', { who: who, device: s.deviceName || '#' + s.deviceId }), T('ses.end')).then(function (ok) {
          if (!ok) return null;
          b.disabled = true;
          return P.api('POST', 'admin/sessions/' + s.id + '/end').then(function () { P.toast(T('ses.ended_now')); setTimeout(reload, 1500); });
        }).catch(P.warn);
      } } }));
    }
    var sub = [P.when(s.startedAt)];
    if (s.endedAt) sub.push(T('ses.duration', { d: P.duration(s.durationSeconds) }));
    if (s.endReason) sub.push(T('ses.reason.' + s.endReason) !== 'ses.reason.' + s.endReason ? T('ses.reason.' + s.endReason) : s.endReason);
    if (s.clientIp) sub.push(s.clientIp);
    return el('div', { class: 'rm-hist' }, [
      el('div', { class: 'rm-hist-main' }, [el('div', { class: 'rm-item-title', text: (s.deviceName || '#' + s.deviceId) + ' · ' + who }), el('div', { class: 'rm-item-sub', text: sub.join(' · ') })]),
      badges, acts,
    ]);
  }

  function draw() {
    var box = P.clear($('#rm-sessions'));
    rows.forEach(function (s) { box.appendChild(line(s)); });
    $('#rm-s-none').hidden = rows.length > 0;
  }

  function query(before) {
    var q = [];
    if ($('#rm-status').value) q.push('status=' + encodeURIComponent($('#rm-status').value));
    if ($('#rm-device').value) q.push('device=' + encodeURIComponent($('#rm-device').value));
    if (before) q.push('before=' + before);
    q.push('limit=100');
    return 'admin/sessions?' + q.join('&');
  }

  function reload() {
    return P.api('GET', query()).then(function (r) {
      rows = r.sessions || [];
      $('#rm-more').hidden = rows.length < 100;
      if (r.recordings && r.recordings.available) $('#rm-rec').textContent = T('ses.rec_available');
      draw();
    }).catch(P.warn);
  }

  $('#rm-more').addEventListener('click', function () {
    var last = rows[rows.length - 1];
    if (!last) return;
    P.api('GET', query(last.id)).then(function (r) {
      rows = rows.concat(r.sessions || []);
      $('#rm-more').hidden = (r.sessions || []).length < 100;
      draw();
    }).catch(P.warn);
  });
  $('#rm-status').addEventListener('change', reload);
  $('#rm-device').addEventListener('change', reload);
  $('#rm-csv').addEventListener('click', function () {
    var b = $('#rm-csv');
    b.disabled = true;
    P.api('GET', 'admin/sessions/csv').then(function (r) {
      if (!window.GC || typeof window.GC.saveFile !== 'function') throw new Error(T('ses.csv_unsupported'));
      return window.GC.saveFile(new Blob([r.csv], { type: 'text/csv' }), T('ses.csv_name') + ' ' + new Date().toISOString().slice(0, 10) + '.csv');
    }).catch(P.warn).then(function () { b.disabled = false; });
  });
  if (!devicesLoaded) {
    devicesLoaded = true;
    P.api('GET', 'admin/devices').then(function (r) {
      var s = $('#rm-device');
      (r.devices || []).forEach(function (d) { s.appendChild(el('option', { value: String(d.id), text: d.name })); });
    }).catch(function () {});
  }
  reload();
})();
