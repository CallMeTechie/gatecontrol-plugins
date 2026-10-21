/* Admin page "Übersicht": storage, retention, links, what works with GateDrop (GET admin/overview). */
(function () {
  'use strict';
  var G = window.GD;
  var T = G.T;
  var el = G.el;
  function tile(label, value, sub, bar) {
    return el('div', { class: 'gd-tile' }, [el('span', { class: 'gd-tile-l', text: label }), el('span', { class: 'gd-tile-v', text: value }), bar || null, sub ? el('span', { class: 'gd-tile-s', text: sub }) : null]);
  }
  function pill(on) { return el('span', { class: 'gd-pill' + (on ? '' : ' is-off'), text: on ? T('admin.on') : T('admin.off') }); }
  function render(o) {
    var page = G.clear(G.$('#gd-page'));
    var st = o.storage;
    var pct = st && st.quota ? Math.min(100, (st.bytes / st.quota) * 100) : 0;
    var bar = el('div', { class: 'gd-bar' + (pct >= 95 ? ' is-crit' : (pct >= 80 ? ' is-warn' : '')) }, [el('i', { style: 'width:' + pct.toFixed(1) + '%' })]);
    page.appendChild(el('div', { class: 'gd-tiles' }, [
      tile(T('admin.storage'), st ? G.bytes(st.bytes) : '–', st ? T('admin.storage_of', { quota: G.bytes(st.quota), count: st.count }) : null, st ? bar : null),
      tile(T('admin.retention'), T('admin.retention_v'), T('admin.retention_s')),
      tile(T('admin.links'), String(o.activeLinks)),
      tile(T('admin.sends'), String(o.sends7d)),
    ]));
    page.appendChild(el('div', { class: 'gd-grid2' }, [
      el('div', { class: 'gd-card' }, [el('h2', { text: T('admin.links_title') }), pill(o.linksEnabled), el('p', { text: o.linksEnabled ? T('admin.links_on') : T('admin.links_off') })]),
      el('div', { class: 'gd-card' }, [el('h2', { text: T('admin.quota_title') }), el('p', { text: T('admin.quota_hint') })]),
      el('div', { class: 'gd-card' }, [el('h2', { text: T('admin.who_title') }), el('p', { text: T('admin.who_people') }), el('p', { text: T('admin.who_links') })]),
      el('div', { class: 'gd-card' }, [el('h2', { text: T('admin.integrations') }),
        el('div', { class: 'gd-int' }, [el('span', { text: T('admin.int_messenger') }), pill(o.integrations.messenger)]),
        el('div', { class: 'gd-int' }, [el('span', { text: T('admin.int_nas') }), pill(o.integrations.nas)]),
        el('div', { class: 'gd-int' }, [el('span', { text: T('admin.int_familie') }), pill(o.integrations.familie)])]),
    ]));
  }
  G.api('GET', 'admin/overview').then(render, function () { G.$('#gd-loading').textContent = T('admin.load_failed'); });
}());
