/* Admin page "Einstellungen": the licence, the take-over of the built-in Remote Desktops, limits and retention
   (1.2: also of the recordings, and what GateControl can record). */
(function () {
  'use strict';
  var P = window.RM;
  var T = P.T, $ = P.$;

  function licenceText(l) {
    if (!l) return T('lic.unknown');
    if (l.valid === false) return T('lic.missing');
    var src = l.source ? T('lic.source.' + l.source) : '';
    var until = l.expiresAt ? T('lic.until', { date: P.when(l.expiresAt) }) : T('lic.no_end');
    return T('lic.valid') + (src && src !== 'lic.source.' + l.source ? ' · ' + src : '') + ' · ' + until + (l.state === 'expiring' ? ' · ' + T('lic.expiring') : '');
  }

  P.api('GET', 'admin/settings').then(function (r) {
    var s = r.settings;
    $('#rm-max-user').value = String(s.maxPerUser);
    $('#rm-max-device').value = String(s.maxPerDevice);
    $('#rm-check-min').value = String(s.checkMinutes);
    $('#rm-days').value = String(s.historyDays);
    $('#rm-rec-days').value = String(s.recordingDays);
    $('#rm-lic').textContent = licenceText(r.license);
    var i = r.import;
    $('#rm-imp').textContent = i ? T('set.import_done', { when: P.when(i.at), devices: i.counts.devices, sessions: i.counts.sessions, runs: i.runs }) + (i.counts.unreadable ? ' ' + T('set.import_unreadable', { n: i.counts.unreadable }) : '') + (i.counts.listenerErrors ? ' ' + T('set.import_listener', { n: i.counts.listenerErrors }) : '') : T('set.import_none');
    var a = r.recordings || {};
    if (a.available) {
      $('#rm-rec').textContent = T('set.rec_available', { used: Math.round((a.usedBytes || 0) / 1048576), max: Math.round((a.maxBytes || 0) / 1073741824), days: a.days || 30 })
        + (a.engines && !a.engines.guac ? ' ' + T('set.rec_ssh_only') : '');
    } else if (a.reason === 'no_drive' || a.reason === 'full') $('#rm-rec').textContent = T('set.rec_off.' + a.reason);
  }).catch(P.warn);

  $('#rm-imp-open').addEventListener('click', function () {
    if (window.GC && typeof window.GC.openSettings === 'function') window.GC.openSettings();
  });

  function num(id, d) { var n = parseInt($(id).value, 10); return isFinite(n) ? n : d; }
  $('#rm-save').addEventListener('click', function () {
    var b = $('#rm-save');
    b.disabled = true;
    P.api('PUT', 'admin/settings', {
      maxPerUser: num('#rm-max-user', 0), maxPerDevice: num('#rm-max-device', 0), checkMinutes: num('#rm-check-min', 5), historyDays: num('#rm-days', 365),
      recordingDays: num('#rm-rec-days', 30),
    }).then(function () { P.toast(T('common.saved')); }).catch(P.warn).then(function () { b.disabled = false; });
  });
})();
