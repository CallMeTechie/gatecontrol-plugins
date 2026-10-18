/* Admin page "Einstellungen": time zone, notification language, picture retention, motion gap, Ring polling, Nuki log import,
   the doorbell in the family chat (1.3.0). */
(function () {
  'use strict';
  var D = window.DOOR;
  var T = D.T, $ = D.$;
  function chatHint(ch) {
    var key = !ch || !ch.api || ch.available === false ? 'set.family_chat_missing' : 'set.family_chat_hint';
    var s = T(key);
    if (ch && ch.last && !ch.last.ok && ch.last.error && ch.last.error !== 'unavailable') s += ' ' + T('set.family_chat_failed', { code: ch.last.error });
    $('#dr-s-chat-hint').textContent = s;
  }
  function fill(c, ch) {
    $('#dr-s-tz').value = c.timezone; $('#dr-s-lang').value = c.notifyLang; $('#dr-s-media').value = String(c.mediaDays);
    $('#dr-s-gap').value = String(c.motionGapMin); $('#dr-s-ring').checked = c.ring; $('#dr-s-nlog').checked = c.nukiLogImport;
    $('#dr-s-chat').checked = c.familyChat;
    chatHint(ch);
  }
  D.api('GET', 'admin/settings').then(function (r) { fill(r.config, r.chat); }).catch(D.warn);
  $('#dr-set').addEventListener('submit', function (e) {
    e.preventDefault();
    D.api('PUT', 'admin/settings', {
      timezone: $('#dr-s-tz').value.trim(), notifyLang: $('#dr-s-lang').value, mediaDays: Number($('#dr-s-media').value),
      motionGapMin: Number($('#dr-s-gap').value), ring: $('#dr-s-ring').checked, nukiLogImport: $('#dr-s-nlog').checked,
      familyChat: $('#dr-s-chat').checked,
    }).then(function (r) { fill(r.config, r.chat); D.toast(T('common.saved')); }).catch(D.warn);
  });
})();
