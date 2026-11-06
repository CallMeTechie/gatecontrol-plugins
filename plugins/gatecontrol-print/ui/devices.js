/* Admin page "Geräte": found printers and scanners with ink and state, "Neu suchen", "Testseite", a changed certificate. */
(function () {
  'use strict';
  var P = window.PR;
  var T = P.T, el = P.el, $ = P.$;

  function stateBadge(d) {
    if (d.problem === 'cert_changed') return el('span', { class: 'pr-badge', 'data-tone': 'crit', text: T('dev.cert_changed') });
    if (!d.gatewayOnline) return el('span', { class: 'pr-badge', 'data-tone': 'warn', text: T('dev.gateway_offline') });
    if (!d.online) return el('span', { class: 'pr-badge', 'data-tone': 'warn', text: T('dev.offline') });
    var p = d.printer;
    if (p && (p.reasons || []).some(function (r) { return /sleep|standby|power-save/.test(r); })) return el('span', { class: 'pr-badge', text: T('dev.standby') });
    if (p && p.state === 'stopped') return el('span', { class: 'pr-badge', 'data-tone': 'warn', text: T('dev.stopped') });
    if ((p && p.state === 'processing') || (d.scanner && d.scanner.state === 'processing')) return el('span', { class: 'pr-badge', text: T('dev.busy') });
    return el('span', { class: 'pr-badge', 'data-tone': 'good', text: T('dev.ready') });
  }

  function features(d) {
    var f = [P.kindText(d)];
    if (d.location) f.push(d.location);
    if (d.ip) f.push(d.ip);
    var p = d.printer;
    if (p) f.push(p.color ? T('dev.color') : T('dev.bw'));
    if (p && p.duplex) f.push(T('dev.duplex'));
    if (d.scanner && d.scanner.feeder) f.push(T('dev.feeder'));
    if (p && (p.formats || []).indexOf('application/pdf') < 0 && (p.formats || []).length) f.push(T('dev.no_pdf'));
    return f.join(' · ');
  }

  function ink(d) {
    var m = (d.printer && d.printer.markers) || [];
    if (!m.length) return null;
    var low = m.filter(function (x) { return x.low; });
    return el('div', { class: 'pr-ink-wrap' }, [
      el('div', { class: 'pr-ink', role: 'img', 'aria-label': T('dev.ink') + ': ' + m.map(function (x) { return x.name + ' ' + (x.level == null ? '?' : x.level + ' %'); }).join(', ') }, m.map(function (x) {
        var fill = el('span', { class: 'pr-ink-fill' });
        fill.style.height = (x.level == null ? 0 : x.level) + '%';
        fill.style.background = x.color || 'var(--muted)';
        return el('span', { class: 'pr-ink-bar', 'data-low': x.low ? '1' : '0', title: x.name + ' ' + (x.level == null ? '?' : x.level + ' %') }, [el('span', { class: 'pr-ink-tube' }, [fill]), (x.name || '').slice(0, 3)]);
      })),
      low.length ? el('span', { class: 'pr-sub', text: T('dev.ink_low', { names: low.map(function (x) { return x.name; }).join(', ') }) }) : null,
    ]);
  }

  function row(d) {
    var acts = [];
    if (d.printer) {
      var b = el('button', { class: 'btn btn-sm', type: 'button', 'data-test': d.id, text: T('dev.test'), disabled: !d.gatewayOnline || d.problem === 'cert_changed', on: { click: function () {
        b.disabled = true;
        P.api('POST', 'admin/devices/' + encodeURIComponent(d.id) + '/test').then(function () { P.toast(T('dev.test_sent')); }).catch(P.warn).then(function () { b.disabled = false; });
      } } });
      acts.push(b);
    }
    if (d.problem === 'cert_changed') {
      acts.push(el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: T('dev.retrust'), on: { click: function () {
        P.confirmDialog(T('dev.retrust_q', { name: d.name }), T('dev.retrust')).then(function (ok) {
          if (!ok) return null;
          return P.api('POST', 'admin/devices/' + encodeURIComponent(d.id) + '/retrust').then(function () { P.toast(T('dev.retrust_done')); });
        }).catch(P.warn);
      } } }));
    }
    return el('div', { class: 'pr-item', 'data-device': d.id }, [
      el('div', { class: 'pr-item-main' }, [
        el('div', { class: 'pr-item-title', text: d.name }),
        el('div', { class: 'pr-item-sub', text: features(d) }),
        d.gateway ? el('div', { class: 'pr-item-sub', text: T('dev.via', { gateway: d.gateway }) }) : null,
      ]),
      ink(d),
      stateBadge(d),
      el('div', { class: 'pr-actions' }, acts),
    ]);
  }

  function load() {
    return P.api('GET', 'admin/devices').then(function (r) {
      var box = P.clear($('#pr-devices'));
      (r.devices || []).forEach(function (d) { box.appendChild(row(d)); });
      $('#pr-none').hidden = (r.devices || []).length > 0;
      var g = (r.devices || [])[0];
      $('#pr-dev-when').textContent = r.reportedAt ? T('dev.searched', { ago: P.ago(r.reportedAt), gateway: g && g.gateway ? g.gateway : '–' }) : '';
    }).catch(P.warn);
  }

  $('#pr-discover').addEventListener('click', function () {
    var b = $('#pr-discover');
    b.disabled = true;
    P.api('POST', 'admin/devices/discover').then(function (r) {
      P.toast(r.asked ? T('dev.discovering') : T('dev.no_gateway'), r.asked ? 'good' : 'error');
      setTimeout(load, 8000);
    }).catch(P.warn).then(function () { b.disabled = false; });
  });
  load();
})();
