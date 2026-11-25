/* Tab "Geräte": the GateControl apps of people with the right "Medien", what each got, "Abmelden". */
(function () {
  'use strict';
  var P = window.MD;
  var T = P.T, el = P.el, $ = P.$;

  function kind(d) {
    if (d.clientType === 'android-tv') return T('dev.kind.tv');
    if (d.clientType === 'pro') return 'GateControl Pro';
    if (d.clientType === 'community') return 'GateControl Community';
    return d.platform ? T('dev.kind.' + d.platform) : '–';
  }

  function revoke(d) {
    P.confirmDialog(T('dev.revoke_q', { name: d.name || d.id }), T('dev.revoke'), true).then(function (ok) {
      if (!ok) return null;
      return P.api('POST', 'admin/devices/' + encodeURIComponent(d.id) + '/revoke', {}).then(function () { P.toast(T('dev.revoked')); load(); });
    }).catch(P.warn);
  }

  function draw(list) {
    var tbl = P.clear($('#md-devices'));
    $('#md-d-empty').hidden = list.length > 0;
    tbl.appendChild(el('thead', null, [el('tr', null, ['dev.col_device', 'dev.col_person', 'dev.col_jf', 'dev.col_nas', 'dev.col_way', 'dev.col_last', 'dev.col_act'].map(function (k) { return el('th', { scope: 'col', text: T(k) }); }))]));
    var body = el('tbody');
    var lost = [];
    list.forEach(function (d) {
      var jf = d.jellyfin.length ? d.jellyfin.map(function (j) { return T('dev.jf_as', { user: j.user || '?', source: j.source }) + (j.state === 'paired' ? '' : ' ' + T('dev.jf_pending')); }).join(', ') : (d.removed ? '–' : (d.media ? T('dev.jf_none') : T('dev.no_right')));
      var nas = d.shares.length ? d.shares.map(function (x) { return T('dev.nas_got', { source: x.source, when: P.when(x.at) }) + (x.current ? '' : ' ' + T('dev.nas_old')) + (x.smb === true ? ' · ' + T('dev.smb_ok') : (x.smb === false ? ' · ' + T('dev.smb_bad', { problem: x.smbProblem || '' }) : '')); }).join('; ') : '–';
      var way = d.reports.filter(function (r) { return !r.ok; }).map(function (r) { return T('dev.way_bad.' + r.way, { problem: r.problem || '' }); }).join('; ') || (d.via ? T('dev.via.' + d.via) : '–');
      if (d.removed && d.shares.length) lost.push(d);
      body.appendChild(el('tr', { 'data-device': d.id }, [
        el('td', null, [el('div', { text: d.name || d.id }), el('div', { class: 'md-sub', text: kind(d) + (d.appVersion ? ' ' + d.appVersion : '') + (d.removed ? ' · ' + T('dev.removed') : '') })]),
        el('td', { text: d.person || '–' }), el('td', { text: jf }), el('td', { text: nas }), el('td', { text: way }),
        el('td', { text: d.online ? T('dev.online') : P.when(d.lastSeen) }),
        el('td', null, [d.jellyfin.length || d.shares.length ? el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: T('dev.revoke'), on: { click: function () { revoke(d); } } }) : null]),
      ]));
    });
    tbl.appendChild(body);
    var box = P.clear($('#md-d-lost'));
    lost.forEach(function (d) {
      box.appendChild(el('p', { class: 'md-note', text: T('dev.lost', { name: d.name || d.id, sources: d.shares.map(function (x) { return x.source; }).join(', ') }) }));
    });
  }

  function load() {
    return P.api('GET', 'admin/devices').then(function (r) { draw(r.devices || []); }).catch(P.warn);
  }
  load();
})();
