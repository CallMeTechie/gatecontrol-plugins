/* Profile section "Fernzugriff" (Meine Geräte in the portal): what I may do, set by an administrator — read only. */
(function () {
  'use strict';
  var P = window.RM;
  var T = P.T, el = P.el, $ = P.$;
  P.api('GET', 'profile').then(function (r) {
    var box = P.clear($('#rm-rights'));
    ['rdp', 'ssh', 'support', 'share'].forEach(function (k) {
      var on = !!r.rights[k];
      box.appendChild(el('li', null, [el('span', { class: 'rm-mark', 'data-on': on ? '1' : '0', 'aria-hidden': 'true', text: on ? '✓' : '–' }),
        el('span', { text: T('right.' + k) + ': ' + (on ? T('common.yes') : T('common.no')) }),
        k === 'support' || k === 'share' ? el('span', { class: 'rm-sub', text: '(' + T('profile.later') + ')' }) : null]));
    });
    $('#rm-devs').textContent = r.admin ? T('profile.admin') : T('profile.devices', { n: r.devices.total });
  }).catch(function (e) { P.clear($('#rm-rights')).appendChild(el('li', { text: P.errText(e) })); });
})();
