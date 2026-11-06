/* Admin page "Verlauf": printed, scanned, waiting — newest first. */
(function () {
  'use strict';
  var P = window.PR;
  var T = P.T, el = P.el, $ = P.$;

  function item(it) {
    var badge;
    var text;
    if (it.kind === 'print') {
      badge = P.jobBadge(it);
      var parts = [it.name, T('hist.pages', { n: it.pages * it.copies }), it.userName + (it.via === 'app' || it.via === 'portal' ? ', ' + T('hist.via_' + it.via) : (it.via === 'admin' ? ', ' + T('hist.via_admin') : ''))];
      var why = P.jobReason(it);
      if (why) parts.push(why);
      text = parts.join(' · ');
    } else {
      badge = el('span', { class: 'pr-badge', 'data-tone': it.state === 'saved' ? 'good' : '', text: T('scanstate.' + it.state) });
      text = [it.name ? it.name + (it.where ? ' → ' + it.where : '') : T('hist.pages', { n: it.pages }), it.userName].filter(Boolean).join(' · ');
    }
    return el('div', { class: 'pr-hist', 'data-kind': it.kind }, [
      badge,
      el('div', { class: 'pr-hist-main' }, [el('div', { text: text }), el('div', { class: 'pr-sub', text: it.device })]),
      el('span', { class: 'pr-hist-when', text: P.when(it.at) }),
      it.kind === 'print' && it.open ? el('button', { class: 'btn btn-sm', type: 'button', text: T('hist.cancel'), on: { click: function () {
        P.api('POST', 'admin/jobs/' + encodeURIComponent(it.id) + '/cancel').then(load).catch(P.warn);
      } } }) : null,
    ]);
  }

  function load() {
    return P.api('GET', 'admin/history').then(function (r) {
      var box = P.clear($('#pr-history'));
      (r.items || []).forEach(function (it) { box.appendChild(item(it)); });
      $('#pr-hist-none').hidden = (r.items || []).length > 0;
    }).catch(P.warn);
  }
  load();
})();
