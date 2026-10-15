/* Page "Protokoll": locate requests, "Bin angekommen", SOS and place
   transitions (90 days; coordinates 7 days), and the last answered position
   per child on an OpenStreetMap map (falls back to coordinates + link). */
(function () {
  'use strict';
  var A = window.FA, T = A.T, $ = A.$, el = A.el;
  var usersFilled = false;

  function posLink(p, label) { return A.map.osmLink(p, label || ('±' + Math.round(p.accuracy || 0) + ' m')); }

  function resultCell(e) {
    var td = el('td');
    var add = function (n) { td.appendChild(typeof n === 'string' ? document.createTextNode(n) : n); };
    if (e.kind === 'locate') {
      if (e.status === 'answered') {
        if (e.position) add(posLink(e.position, T('log.position', { m: Math.round(e.position.accuracy || 0) })));
        else add(el('span', { class: 'fa-muted', text: T('log.answered_purged') }));
      } else {
        var text = T('status.' + e.status, { name: e.subject });
        if (e.status === 'failed' && e.reason) text += ' · ' + T('fail.' + e.reason);
        if (e.status === 'declined' && e.reason) text += ' · ' + T('decline.' + e.reason);
        add(el('span', { class: e.status === 'declined' || e.status === 'failed' ? 'fa-bad' : 'fa-muted', text: text }));
      }
      add(el('div', { class: 'fa-sub', text: T('mode.' + e.mode) }));
    } else if (e.kind === 'arrival') {
      add(e.label || T('log.arrived'));
      if (e.position) { add(' · '); add(posLink(e.position)); }
    } else if (e.kind === 'sos') {
      if (e.position) add(posLink(e.position, T('log.position', { m: Math.round(e.position.accuracy || 0) })));
      else add(el('span', { class: 'fa-muted', text: e.purged ? T('log.answered_purged') : T('log.no_position') }));
      if (e.acks && e.acks.length) add(el('div', { class: 'fa-sub', text: T('log.seen_by', { names: e.acks.map(function (a) { return a.name; }).join(', ') }) }));
    } else if (e.kind === 'place') {
      add(T(e.transition === 'exit' ? 'log.place_exit' : 'log.place_enter', { title: e.label }));
      if (e.told) add(el('div', { class: 'fa-sub', text: T('log.place_told', { n: e.told }) }));
    }
    return td;
  }

  function load() {
    var q = 'admin/log?days=' + encodeURIComponent($('#fa-f-days').value) + '&kind=' + encodeURIComponent($('#fa-f-kind').value)
      + ($('#fa-f-user').value ? '&userId=' + encodeURIComponent($('#fa-f-user').value) : '');
    A.api('GET', q).then(function (r) {
      if (!usersFilled) {
        usersFilled = true;
        var sel = $('#fa-f-user');
        r.members.forEach(function (m) { sel.appendChild(el('option', { value: String(m.userId), text: m.name })); });
      }
      var rows = A.clear($('#fa-log-rows'));
      r.entries.forEach(function (e) {
        rows.appendChild(el('tr', null, [
          el('td', { class: 'fa-time', text: A.when(e.at) }),
          el('td', { text: T('kind.' + e.kind) }),
          el('td', { text: e.by }),
          el('td', { text: e.subject }),
          resultCell(e),
        ]));
      });
      $('#fa-log-empty').hidden = r.entries.length > 0;
      var colors = {};
      r.children.forEach(function (c) { colors[c.userId] = c.colorHex; });
      A.map.show($('#fa-map-box'), r.positions.map(function (p) {
        return { lat: p.lat, lon: p.lon, accuracy: p.accuracy, label: p.childName, sub: A.when(p.at || p.answeredAt), color: colors[p.childId] };
      }));
    }).catch(A.warn);
  }
  ['#fa-f-days', '#fa-f-kind', '#fa-f-user'].forEach(function (s) { $(s).addEventListener('change', load); });
  load();
}());
