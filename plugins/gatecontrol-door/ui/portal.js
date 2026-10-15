/* Portal tab "Tür": lock cards with buttons per right, latest pictures per camera, history. */
(function () {
  'use strict';
  var D = window.DOOR;
  var T = D.T, el = D.el, $ = D.$;
  var me = null;
  var cursor = null;

  function lockCard(lock) {
    var buttons = lock.actions.map(function (a) {
      return el('button', {
        type: 'button', class: 'btn ' + (a === 'lock' ? '' : 'btn-primary'), text: D.actLabel(lock, a), disabled: !!lock.blocked,
        on: { click: function () { run(lock, a); } },
      });
    });
    var sub = D.stateText(lock);
    if (lock.blocked === 'outside_window') sub += ' · ' + T('portal.outside_window');
    return el('div', { class: 'dr-item' }, [
      el('div', { class: 'dr-item-main' }, [
        el('div', { class: 'dr-item-title' }, [lock.name + ' ', el('span', { class: 'dr-badge', 'data-tone': D.tone(lock), text: lock.state.reachable ? T('state.' + lock.state.lock) : T('portal.unreachable') })]),
        el('div', { class: 'dr-item-sub', text: sub }),
      ]),
      el('div', { class: 'dr-actions' }, buttons),
    ]);
  }

  function run(lock, a) {
    var key = a === 'open' && lock.type === 'opener' ? 'buzz' : a;
    var ask = a === 'lock' ? Promise.resolve(true) : D.confirmDialog(T('confirm.' + key, { name: lock.name }), D.actLabel(lock, a));
    ask.then(function (ok) {
      if (!ok) return null;
      return D.api('POST', 'locks/' + lock.id + '/' + a).then(function (r) { D.toast(r.message); load(); });
    }).catch(D.warn);
  }

  function camCard(cam) {
    var box = el('div', { class: 'dr-noimg', text: T('portal.no_image') });
    var wrap = el('div', { class: 'dr-cam' }, [
      el('div', { class: 'dr-item-title', text: cam.name }), box,
      el('div', { class: 'dr-actions' }, [
        el('button', { type: 'button', class: 'btn btn-sm', text: T('portal.new_image'), on: { click: function () { snap(cam, box, true); } } }),
        el('label', { class: 'check' }, [el('input', { type: 'checkbox', checked: cam.prefs.ding, disabled: !me.me.canAct, on: { change: function (e) { pref(cam, { ding: e.target.checked }); } } }), T('portal.ding_push')]),
        el('label', { class: 'check' }, [el('input', { type: 'checkbox', checked: cam.prefs.motion, disabled: !me.me.canAct, on: { change: function (e) { pref(cam, { motion: e.target.checked }); } } }), T('portal.motion_push')]),
      ]),
    ]);
    if (cam.lastImageAt) snap(cam, box, false);
    return wrap;
  }

  function snap(cam, box, refresh) {
    D.api('GET', 'cameras/' + cam.id + '/snapshot' + (refresh ? '?refresh=1' : '')).then(function (r) {
      var u = D.imgUrl(r.snapshot);
      if (!u) return;
      var img = el('img', { src: u, alt: cam.name, title: D.when(r.snapshot.at), on: { click: function () { D.showImage(r.snapshot); } } });
      box.replaceWith(img);
      box = img;
    }).catch(function (e) { if (refresh) D.warn(e); });
  }

  function pref(cam, body) { D.api('PUT', 'cameras/' + cam.id + '/prefs', body).then(function () { D.toast(T('common.saved')); }).catch(D.warn); }

  function histRow(h) {
    var what = h.kind === 'action' ? T('act.' + (h.action || 'lock')) : (h.kind === 'alert' ? T('alert.' + h.action) : T('kind.' + h.kind));
    var who = [h.userName, h.via ? T('via.' + h.via) : null].filter(Boolean).join(' · ');
    var res = h.result && h.result !== 'ok' ? T('result.' + h.result) + (h.reasonText ? ': ' + h.reasonText : '') : '';
    var kids = [el('div', { class: 'dr-item-main' }, [
      el('div', { class: 'dr-item-title', text: what + ' – ' + (h.lockName || h.cameraName || '') }),
      el('div', { class: 'dr-item-sub', text: [D.when(h.at), who, res].filter(Boolean).join(' · ') }),
    ])];
    if (h.hasImage) kids.push(el('button', { type: 'button', class: 'btn btn-sm', text: T('hist.image'), on: { click: function () { D.api('GET', 'events/' + h.id).then(function (r) { D.showImage(r.event.image); }).catch(D.warn); } } }));
    return el('div', { class: 'dr-item' }, kids);
  }

  function loadHistory(more) {
    D.api('GET', 'history' + (more && cursor ? '?cursor=' + cursor : '')).then(function (r) {
      var box = $('#dr-hist');
      if (!more) D.clear(box);
      r.items.forEach(function (h) { box.appendChild(histRow(h)); });
      cursor = r.nextCursor;
      $('#dr-more').hidden = !cursor;
      $('#dr-hist-empty').hidden = box.children.length > 0;
    }).catch(D.warn);
  }

  function load() {
    D.api('GET', 'me').then(function (r) {
      me = r;
      $('#dr-ring-broken').hidden = !(r.ring && r.ring.broken);
      $('#dr-readonly').hidden = r.me.canAct;
      var box = D.clear($('#dr-locks'));
      r.locks.forEach(function (l) { box.appendChild(lockCard(l)); });
      $('#dr-empty').hidden = r.locks.length > 0;
      var cams = D.clear($('#dr-cams'));
      r.cameras.forEach(function (c) { cams.appendChild(camCard(c)); });
      $('#dr-cams-card').hidden = !r.cameras.length;
      loadHistory(false);
    }).catch(D.warn);
  }

  $('#dr-more').addEventListener('click', function () { loadHistory(true); });
  load();
  setInterval(function () { if (!document.hidden) D.api('GET', 'me').then(function (r) { me = r; var box = D.clear($('#dr-locks')); r.locks.forEach(function (l) { box.appendChild(lockCard(l)); }); }).catch(function () {}); }, 30000);
})();
