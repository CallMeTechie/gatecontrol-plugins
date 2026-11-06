/* Admin page "Einstellungen": where scans go in Drive, "Mit KI benennen und einsortieren", notices, history. */
(function () {
  'use strict';
  var P = window.PR;
  var T = P.T, $ = P.$;

  function folderLabels() {
    var f = $('#pr-folder').value.trim() || 'Scans';
    $('#pr-area-mine').textContent = T('set.area_mine', { folder: f });
    $('#pr-area-family').textContent = T('set.area_family', { folder: f });
  }

  P.api('GET', 'admin/settings').then(function (r) {
    var s = r.settings;
    document.querySelectorAll('input[name="pr-area"]').forEach(function (x) { x.checked = x.value === s.driveArea; });
    $('#pr-folder').value = s.folder;
    $('#pr-ai').checked = !!s.aiFile;
    $('#pr-notify').checked = !!s.notify;
    $('#pr-days').value = String(s.historyDays);
    $('#pr-no-drive').hidden = !!r.drive;
    folderLabels();
  }).catch(P.warn);
  $('#pr-folder').addEventListener('input', folderLabels);
  $('#pr-save').addEventListener('click', function () {
    var area = document.querySelector('input[name="pr-area"]:checked');
    var b = $('#pr-save');
    b.disabled = true;
    P.api('PUT', 'admin/settings', {
      driveArea: area ? area.value : 'mine', folder: $('#pr-folder').value.trim(), aiFile: $('#pr-ai').checked,
      notify: $('#pr-notify').checked, historyDays: parseInt($('#pr-days').value, 10) || 90,
    }).then(function () { P.toast(T('common.saved')); }).catch(P.warn).then(function () { b.disabled = false; });
  });
})();
