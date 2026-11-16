/* Profile section "Fernzugriff" (Meine Geräte in the portal): what I may do, set by an administrator — read only;
   1.1: my PCs (registered in the app) and the protocol of their sharing. */
(function () {
  'use strict';
  var P = window.RM;
  var T = P.T, el = P.el, $ = P.$;
  P.api('GET', 'profile').then(function (r) {
    var box = P.clear($('#rm-rights'));
    ['rdp', 'ssh', 'support', 'share'].forEach(function (k) {
      var on = !!r.rights[k];
      box.appendChild(el('li', null, [el('span', { class: 'rm-mark', 'data-on': on ? '1' : '0', 'aria-hidden': 'true', text: on ? '✓' : '–' }),
        el('span', { text: T('right.' + k) + ': ' + (on ? T('common.yes') : T('common.no')) })]));
    });
    $('#rm-devs').textContent = r.admin ? T('profile.admin') : T('profile.devices', { n: r.devices.total });
    // 1.2: a recording an administrator set for me (or one of my groups) — "immer" is never hidden from the person
    if (r.recording === 'always' || r.recording === 'optional') box.appendChild(el('li', null, [el('span', { class: 'rm-mark', 'data-on': '1', 'aria-hidden': 'true', text: '●' }), el('span', { text: T('profile.rec_' + r.recording) })]));
    var hosts = r.hosts || [];
    $('#rm-hosts-card').hidden = !hosts.length;
    var hb = P.clear($('#rm-hosts'));
    hosts.forEach(function (h) {
      var mode = !h.registered ? T('dev.unregistered') : T(h.shareMode === 'open' && h.allowOpen ? 'dev.share_open' : 'dev.share_code');
      hb.appendChild(el('li', null, [el('span', { text: T('profile.host_line', { name: h.name, mode: mode }) + (h.recording === 'always' ? ' · ' + T('profile.host_rec_always') : '') })]));
    });
    var box2 = P.clear($('#rm-hist'));
    (r.history || []).forEach(function (e) {
      var label = T('log.' + e.type) !== 'log.' + e.type ? T('log.' + e.type) : e.type;
      box2.appendChild(el('div', { class: 'rm-hist' }, [el('div', { class: 'rm-hist-main' }, [
        el('div', { class: 'rm-item-title', text: (e.deviceName || '–') + ' · ' + label }),
        el('div', { class: 'rm-item-sub', text: [P.when(e.at), e.userName].filter(Boolean).join(' · ') })])]));
    });
    if (hosts.length && !(r.history || []).length) box2.appendChild(el('p', { class: 'rm-hint', text: T('profile.no_history') }));
  }).catch(function (e) { P.clear($('#rm-rights')).appendChild(el('li', { text: P.errText(e) })); });
  // 1.2: the recordings of my own devices (the owner may watch them)
  P.api('GET', 'recordings?limit=20').then(function (r) {
    var list = (r.recordings || []).filter(function (x) { return x.status === 'ready'; });
    if (!list.length) return;
    $('#rm-recs-card').hidden = false;
    var box = P.clear($('#rm-recs'));
    list.forEach(function (x) {
      var acts = el('div', { class: 'rm-actions' });
      acts.appendChild(el('button', { class: 'btn btn-primary', type: 'button', text: T('ses.rec_play'), on: { click: function (ev) {
        var b = ev.currentTarget;
        b.disabled = true;
        P.api('POST', 'recordings/' + encodeURIComponent(x.id) + '/play').then(function (p) { return P.openSession(p.ref, acts); }).catch(P.warn).then(function () { b.disabled = false; });
      } } }));
      box.appendChild(el('div', { class: 'rm-hist' }, [el('div', { class: 'rm-hist-main' }, [
        el('div', { class: 'rm-item-title', text: (x.deviceName || '–') + ' · ' + (x.userName || T('ses.unknown')) }),
        el('div', { class: 'rm-item-sub', text: [P.when(x.startedAt), T('ses.duration', { d: P.duration(x.durationSeconds) })].join(' · ') })]), acts]));
    });
  }).catch(function () { /* older GateControl: no recordings */ });
})();
