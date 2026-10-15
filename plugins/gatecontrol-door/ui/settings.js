/* Admin page "Einstellungen": time zone, notification language, picture retention, motion gap, Ring polling, Nuki log import. */
(function () {
  'use strict';
  var D = window.DOOR;
  var T = D.T, $ = D.$;
  function fill(c) {
    $('#dr-s-tz').value = c.timezone; $('#dr-s-lang').value = c.notifyLang; $('#dr-s-media').value = String(c.mediaDays);
    $('#dr-s-gap').value = String(c.motionGapMin); $('#dr-s-ring').checked = c.ring; $('#dr-s-nlog').checked = c.nukiLogImport;
  }
  D.api('GET', 'admin/settings').then(function (r) { fill(r.config); }).catch(D.warn);
  $('#dr-set').addEventListener('submit', function (e) {
    e.preventDefault();
    D.api('PUT', 'admin/settings', {
      timezone: $('#dr-s-tz').value.trim(), notifyLang: $('#dr-s-lang').value, mediaDays: Number($('#dr-s-media').value),
      motionGapMin: Number($('#dr-s-gap').value), ring: $('#dr-s-ring').checked, nukiLogImport: $('#dr-s-nlog').checked,
    }).then(function (r) { fill(r.config); D.toast(T('common.saved')); }).catch(D.warn);
  });
})();
