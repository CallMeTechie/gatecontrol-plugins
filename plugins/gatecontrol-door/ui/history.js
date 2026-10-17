/* Admin page "Verlauf": every action, ring, motion and notice, with pictures while they are kept. */
(function () {
  'use strict';
  var D = window.DOOR;
  var T = D.T, el = D.el, $ = D.$;
  var cursor = null;

  function row(h) {
    var what = h.kind === 'action' ? T('act.' + (h.action || 'lock')) : (h.kind === 'alert' ? T('alert.' + h.action)
      : (h.kind === 'mode' ? T('kind.mode') + ' · ' + D.modeText(h.action) : T('kind.' + h.kind) + (h.action ? ' · ' + T('act.' + h.action) : '')));
    var img = h.hasImage ? el('button', { type: 'button', class: 'btn btn-sm', text: T('hist.image'), on: { click: function () {
      D.api('GET', 'admin/events/' + h.id).then(function (r) { D.showImage(r.event.image); }).catch(D.warn);
    } } }) : '';
    return el('tr', {}, [
      el('td', { text: D.when(h.at) }), el('td', { text: what }), el('td', { text: [h.lockName, h.cameraName, h.locationName].filter(Boolean).join(' · ') }),
      el('td', { text: [h.userName, h.via ? T('via.' + h.via) : null, h.caller].filter(Boolean).join(' · ') }),
      el('td', { text: (h.result ? T('result.' + h.result) : '') + (h.reasonText ? ': ' + h.reasonText : '') }), el('td', {}, [img]),
    ]);
  }

  function load(more) {
    var q = [];
    if ($('#dr-f-kind').value) q.push('kind=' + encodeURIComponent($('#dr-f-kind').value));
    if (more && cursor) q.push('cursor=' + cursor);
    D.api('GET', 'admin/history' + (q.length ? '?' + q.join('&') : '')).then(function (r) {
      var box = $('#dr-rows');
      if (!more) D.clear(box);
      r.items.forEach(function (h) { box.appendChild(row(h)); });
      cursor = r.nextCursor;
      $('#dr-more').hidden = !cursor;
      $('#dr-empty').hidden = box.children.length > 0;
    }).catch(D.warn);
  }
  $('#dr-f-kind').addEventListener('change', function () { load(false); });
  $('#dr-more').addEventListener('click', function () { load(true); });
  load(false);
})();
