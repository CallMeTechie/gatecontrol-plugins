/* Portal tab "Fernzugriff" (phone first, targets ≥ 44 px): the devices I may reach, their state, "Verbinden", "Aufwecken". */
(function () {
  'use strict';
  var P = window.RM;
  var T = P.T, el = P.el, $ = P.$;
  var S = null;

  function busy(b, p) { b.disabled = true; return p.catch(P.warn).then(function () { b.disabled = false; }); }

  function card(d) {
    var acts = el('div', { class: 'rm-actions' });
    if (d.browser && !d.maintenance && !d.credentialUnreadable) {
      var c = el('button', { class: 'btn btn-primary', type: 'button', text: T('dev.connect'), 'aria-label': T('portal.connect_to', { name: d.name }) });
      c.addEventListener('click', function () {
        busy(c, P.api('POST', 'devices/' + d.id + '/connect', {}).then(function (r) { return P.openSession(r.session.ref, acts); }));
      });
      acts.appendChild(c);
    }
    if (d.wake) {
      var w = el('button', { class: 'btn', type: 'button', text: T('dev.wake') });
      w.addEventListener('click', function () { busy(w, P.api('POST', 'devices/' + d.id + '/wake').then(function () { P.toast(T('dev.woken')); })); });
      acts.appendChild(w);
    }
    var note = null;
    if (d.maintenance) note = T('portal.maintenance');
    else if (d.credentialUnreadable) note = T('portal.cred_unreadable');
    else if (!d.browser) note = d.protocol === 'rdp' ? T('portal.app_only') : T('portal.no_browser');
    var sub = [];
    if (d.lastCheck) sub.push(T('dev.checked', { ago: P.ago(d.lastCheck) }));
    return el('div', { class: 'rm-item', 'data-device': String(d.id) }, [
      el('div', { class: 'rm-item-main' }, [
        el('div', { class: 'rm-item-title', text: d.name }),
        d.description ? el('div', { class: 'rm-item-sub', text: d.description }) : null,
        sub.length ? el('div', { class: 'rm-item-sub', text: sub.join(' · ') }) : null,
        note ? el('div', { class: 'rm-item-sub', text: note }) : null,
      ]),
      el('div', { class: 'rm-badges' }, [P.protoBadge(d.protocol), P.stateBadge(d)]),
      acts,
    ]);
  }

  function draw() {
    var q = $('#rm-search').value.trim().toLowerCase();
    var box = P.clear($('#rm-list'));
    S.devices.filter(function (d) { return !q || (d.name + ' ' + (d.description || '') + ' ' + (d.tags || []).join(' ')).toLowerCase().indexOf(q) >= 0; })
      .forEach(function (d) { box.appendChild(card(d)); });
    $('#rm-none').hidden = S.devices.length > 0;
    $('#rm-search').hidden = S.devices.length < 8;
  }

  function load() {
    return P.api('GET', 'overview').then(function (r) {
      S = r;
      $('#rm-loading').hidden = true;
      $('#rm-p-card').hidden = false;
      draw();
    }).catch(function (e) { $('#rm-loading').textContent = P.errText(e); });
  }

  $('#rm-search').addEventListener('input', draw);
  $('#rm-reload').addEventListener('click', load);
  // live: a device went online or offline (GateControl's events of this plugin)
  if (window.GC && typeof window.GC.on === 'function') {
    try { window.GC.on('event', function (ev) { if (ev && ev.type === 'devices') load(); }); } catch (e) { /* no live updates */ }
  }
  load();
})();
