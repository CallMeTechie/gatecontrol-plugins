/* Admin page "Sitzungen": the history of the apps' and the browser sessions, end an open browser session, CSV export;
   1.1: the filter "Freigaben" — the protocol of codes, requests, "ohne Code" and the firewall of the Windows PCs;
   1.2: the recordings — watch (GateControl's playback page, GC.openSession) and delete. */
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
      s.mode === 'view' ? el('span', { class: 'rm-badge', text: T('ses.view') }) : null,
      s.engine === 'term' ? el('span', { class: 'rm-badge', text: T('dev.engine_term') }) : null,
      s.recordingId ? el('span', { class: 'rm-badge', 'data-tone': 'warn', text: T('ses.recorded') }) : null]);
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

  var shares = false;
  function shareLine(e) {
    var label = T('log.' + e.type) !== 'log.' + e.type ? T('log.' + e.type) : e.type;
    var sub = [P.when(e.at)];
    if (e.userName) sub.push(e.userName);
    if (e.details && e.details.via) sub.push(T('ses.via.' + (e.details.via === 'app' ? 'native' : 'browser')));
    if (e.details && e.details.shareMode) sub.push(T(e.details.shareMode === 'open' ? 'dev.share_open' : 'dev.share_code'));
    if (e.details && e.details.mode === 'view') sub.push(T('ses.view'));
    return el('div', { class: 'rm-hist' }, [
      el('div', { class: 'rm-hist-main' }, [el('div', { class: 'rm-item-title', text: (e.deviceName || (e.deviceId ? '#' + e.deviceId : '–')) + ' · ' + label }), el('div', { class: 'rm-item-sub', text: sub.join(' · ') })]),
      el('div', { class: 'rm-badges' }, [el('span', { class: 'rm-badge', 'data-tone': e.type === 'remote_code_failed' || e.type === 'remote_request_denied' ? 'warn' : null, text: label })]),
    ]);
  }

  function draw() {
    var box = P.clear($('#rm-sessions'));
    rows.forEach(function (s) { box.appendChild(shares ? shareLine(s) : line(s)); });
    $('#rm-s-none').textContent = shares ? T('ses.shares_none') : T('ses.none');
    $('#rm-s-none').hidden = rows.length > 0;
  }

  function query(before) {
    var q = [];
    shares = $('#rm-status').value === 'shares';
    if (shares) {
      if ($('#rm-device').value) q.push('device=' + encodeURIComponent($('#rm-device').value));
      if (before) q.push('before=' + before);
      q.push('limit=100');
      return 'admin/sessions/shares?' + q.join('&');
    }
    if ($('#rm-status').value) q.push('status=' + encodeURIComponent($('#rm-status').value));
    if ($('#rm-device').value) q.push('device=' + encodeURIComponent($('#rm-device').value));
    if (before) q.push('before=' + before);
    q.push('limit=100');
    return 'admin/sessions?' + q.join('&');
  }

  function size(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }

  function recLine(x) {
    var acts = el('div', { class: 'rm-actions' });
    if (x.status === 'ready') {
      acts.appendChild(el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: T('ses.rec_play'), on: { click: function (ev) {
        var b = ev.currentTarget;
        b.disabled = true;
        P.api('POST', 'admin/recordings/' + encodeURIComponent(x.id) + '/play').then(function (r) { return P.openSession(r.ref, acts); }).catch(P.warn).then(function () { b.disabled = false; });
      } } }));
      acts.appendChild(el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: T('ses.rec_delete'), on: { click: function () {
        P.confirmDialog(T('ses.rec_delete_q', { device: x.deviceName || '–', when: P.when(x.startedAt) }), T('ses.rec_delete')).then(function (ok) {
          if (!ok) return null;
          return P.api('DELETE', 'admin/recordings/' + encodeURIComponent(x.id)).then(function () { P.toast(T('ses.rec_deleted')); loadRecs(); });
        }).catch(P.warn);
      } } }));
    }
    var sub = [P.when(x.startedAt), T('ses.duration', { d: P.duration(x.durationSeconds) }), size(x.bytes || 0)];
    return el('div', { class: 'rm-hist' }, [
      el('div', { class: 'rm-hist-main' }, [el('div', { class: 'rm-item-title', text: (x.deviceName || '–') + ' · ' + (x.userName || T('ses.unknown')) }), el('div', { class: 'rm-item-sub', text: sub.join(' · ') })]),
      el('div', { class: 'rm-badges' }, [P.protoBadge(x.protocol || 'ssh'), x.status !== 'ready' ? el('span', { class: 'rm-badge', text: T('ses.rec_status.' + x.status) }) : null]),
      acts,
    ]);
  }

  function loadRecs() {
    var q = $('#rm-device').value ? '?device=' + encodeURIComponent($('#rm-device').value) : '';
    return P.api('GET', 'admin/recordings' + q).then(function (r) {
      var a = r.available || {};
      $('#rm-rec').textContent = a.available ? T('ses.rec_available') : T('ses.rec_off.' + (a.reason === 'no_drive' || a.reason === 'full' ? a.reason : 'not_yet'));
      var box = P.clear($('#rm-recs'));
      (r.recordings || []).forEach(function (x) { box.appendChild(recLine(x)); });
      if (!(r.recordings || []).length && a.available) box.appendChild(el('p', { class: 'rm-hint', text: T('ses.rec_none') }));
    }).catch(P.warn);
  }

  function reload() {
    return P.api('GET', query()).then(function (r) {
      rows = (shares ? r.entries : r.sessions) || [];
      $('#rm-more').hidden = rows.length < 100;
      draw();
    }).catch(P.warn).then(loadRecs);
  }

  $('#rm-more').addEventListener('click', function () {
    var last = rows[rows.length - 1];
    if (!last) return;
    P.api('GET', query(last.id)).then(function (r) {
      var more = (shares ? r.entries : r.sessions) || [];
      rows = rows.concat(more);
      $('#rm-more').hidden = more.length < 100;
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
