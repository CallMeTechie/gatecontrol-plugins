/* Portal tab "Tür": Ring mode per location, lock cards with buttons per right, latest pictures per camera, history. */
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
        el('div', { class: 'dr-item-title' }, [lock.name + ' ', el('span', { class: 'dr-badge', 'data-tone': D.tone(lock), text: D.badgeText(lock) })]),
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

  /** A Ring location: its current mode and the three buttons (Inaktiv / Zuhause / Abwesend). */
  function modeCard(loc) {
    var sub = [];
    if (loc.modeAt) sub.push(T('mode.changed', { when: D.when(loc.modeAt) }));
    if (loc.blocked === 'outside_window') sub.push(T('portal.outside_window'));
    return el('div', { class: 'dr-item' }, [
      el('div', { class: 'dr-item-main' }, [
        el('div', { class: 'dr-item-title' }, [loc.name + ' ', el('span', { class: 'dr-badge', 'data-tone': D.modeTone(loc.mode), text: D.modeText(loc.mode) })]),
        el('div', { class: 'dr-item-sub', text: sub.join(' · ') }),
      ]),
      D.modeSeg(loc.name, loc.mode, !!loc.blocked, function (m) {
        return D.api('POST', 'modes/' + encodeURIComponent(loc.id) + '/' + m).then(function (r) {
          D.toast(r.message);
          me.ringModes = me.ringModes.map(function (x) { return x.id === loc.id ? r.ringMode : x; });
          renderModes();
          loadHistory(false);
        }).catch(function (e) { D.warn(e); load(); });
      }),
    ]);
  }

  function renderModes() {
    var list = (me && me.ringModes) || [];
    var box = D.clear($('#dr-modes'));
    list.forEach(function (l) { box.appendChild(modeCard(l)); });
    $('#dr-modes-card').hidden = !list.length;
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
    var what = h.kind === 'action' ? T('act.' + (h.action || 'lock')) : (h.kind === 'alert' ? T('alert.' + h.action) : (h.kind === 'mode' ? T('kind.mode') + ' · ' + D.modeText(h.action) : T('kind.' + h.kind)));
    var who = [h.userName, h.via ? T('via.' + h.via) : null].filter(Boolean).join(' · ');
    var res = h.result && h.result !== 'ok' ? T('result.' + h.result) + (h.reasonText ? ': ' + h.reasonText : '') : '';
    var kids = [el('div', { class: 'dr-item-main' }, [
      el('div', { class: 'dr-item-title', text: what + ' – ' + (h.lockName || h.cameraName || h.locationName || '') }),
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
      // only Ring modes for this person: no empty "Schlösser" card
      $('#dr-locks-card').hidden = !r.locks.length && !!(r.ringModes && r.ringModes.length);
      renderModes();
      var cams = D.clear($('#dr-cams'));
      r.cameras.forEach(function (c) { cams.appendChild(camCard(c)); });
      $('#dr-cams-card').hidden = !r.cameras.length;
      loadHistory(false);
    }).catch(D.warn);
  }

  $('#dr-more').addEventListener('click', function () { loadHistory(true); });
  load();
  setInterval(function () { if (!document.hidden) D.api('GET', 'me').then(function (r) { me = r; var box = D.clear($('#dr-locks')); r.locks.forEach(function (l) { box.appendChild(lockCard(l)); }); renderModes(); }).catch(function () {}); }, 30000);
})();
