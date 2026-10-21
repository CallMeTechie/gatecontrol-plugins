/* Admin page "Einstellungen": time zone, notification language, picture retention, motion gap, Ring polling, Nuki log import,
   the doorbell in the family chat (1.3.0), the doorbell diagnosis (1.4.0: last ring seen, last chat result with its reason,
   how Ring's dings/active answers; 1.5.0: warnings — Ring not polled, a camera nobody sees). */
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
  function time(isoStr) { return isoStr ? new Date(isoStr).toLocaleString(D.CTX.lang === 'en' ? 'en-GB' : 'de-DE', { dateStyle: 'short', timeStyle: 'medium' }) : '–'; }
  function reason(code) { var k = 'chat_reason.' + code; return T(k) !== k ? T(k) : T('chat_reason.failed') + ' (' + code + ')'; }
  function diag(ch) {
    var d = (ch && ch.detect) || {};
    var l = d.lastDing;
    var s;
    if (!l) s = T('diag.ding_none');
    else {
      s = T('diag.ding_v', { time: time(l.at), camera: l.camera || '–', delay: l.delayS == null ? '?' : l.delayS, source: T(l.source === 'active' ? 'diag.src_active' : 'diag.src_events') });
      var k = 'diag.out_' + (l.outcome || 'failed');
      s += ' · ' + (l.outcome === 'handled' && !l.pushed ? T('diag.out_handled_late') : (T(k) !== k ? T(k) : T('diag.out_failed')));
    }
    $('#dr-d-ding').textContent = s;
    var last = ch && ch.last;
    if (!last) s = T('diag.chat_none');
    else if (last.ok && last.fallback && last.fallback.sent) s = T('diag.chat_fallback', { time: time(last.at), sent: last.fallback.sent, to: last.fallback.to });
    else if (last.ok) s = T('diag.chat_ok', { time: time(last.at) }) + (last.image ? ' ' + T('diag.chat_image') : '');
    else s = T('diag.chat_err', { time: time(last.at), reason: reason(last.error || 'failed') });
    $('#dr-d-chat').textContent = s;
    var a = d.active;
    $('#dr-d-active').textContent = !a ? T('diag.active_none') : (a.state === 'off' ? T('diag.active_off', { code: a.code || '?', time: time(a.offUntil) }) : T('diag.active_ok'));
  }
  /** 1.5.0: what keeps a ring from reaching anybody (server: admin/settings warnings). */
  function warns(list) {
    var box = D.clear($('#dr-d-warns'));
    (list || []).forEach(function (w) {
      var s = w.code === 'ring_off' ? T('diag.warn_ring_off')
        : (w.lock ? T('diag.warn_no_viewers_lock', { camera: w.camera, lock: w.lock }) : T('diag.warn_no_viewers', { camera: w.camera }));
      box.appendChild(D.el('div', { class: 'dr-note', text: s }));
    });
  }
  function ringOff() { $('#dr-s-ring-off').hidden = $('#dr-s-ring').checked; }
  function fill(c, ch, w) {
    $('#dr-s-tz').value = c.timezone; $('#dr-s-lang').value = c.notifyLang; $('#dr-s-media').value = String(c.mediaDays);
    $('#dr-s-gap').value = String(c.motionGapMin); $('#dr-s-ring').checked = c.ring; $('#dr-s-nlog').checked = c.nukiLogImport;
    $('#dr-s-chat').checked = c.familyChat;
    chatHint(ch);
    diag(ch);
    warns(w);
    ringOff();
  }
  $('#dr-s-ring').addEventListener('change', ringOff);
  D.api('GET', 'admin/settings').then(function (r) { fill(r.config, r.chat, r.warnings); }).catch(D.warn);
  $('#dr-set').addEventListener('submit', function (e) {
    e.preventDefault();
    D.api('PUT', 'admin/settings', {
      timezone: $('#dr-s-tz').value.trim(), notifyLang: $('#dr-s-lang').value, mediaDays: Number($('#dr-s-media').value),
      motionGapMin: Number($('#dr-s-gap').value), ring: $('#dr-s-ring').checked, nukiLogImport: $('#dr-s-nlog').checked,
      familyChat: $('#dr-s-chat').checked,
    }).then(function (r) { fill(r.config, r.chat, r.warnings); D.toast(T('common.saved')); }).catch(D.warn);
  });
})();
