/* Page "Übersicht" (sidebar Apps › Medien): licence, counts, the sources at a glance, the log. */
(function () {
  'use strict';
  var P = window.MD;
  var T = P.T, el = P.el, $ = P.$;

  function stat(label, value) { return el('div', { class: 'md-stat' }, [el('b', { text: String(value) }), el('span', { class: 'md-sub', text: label })]); }

  function draw(r) {
    var lic = P.clear($('#md-o-lic'));
    if (r.license && !r.license.ok) lic.appendChild(el('p', { class: 'md-note', text: T('ov.license.' + (r.license.reason || 'missing')) }));
    var st = P.clear($('#md-o-stats'));
    st.appendChild(stat(T('ov.stat_sources'), r.sources.length));
    st.appendChild(stat(T('ov.stat_people'), r.people.media + ' / ' + r.people.total));
    st.appendChild(stat(T('ov.stat_linked'), r.people.linked));
    st.appendChild(stat(T('ov.stat_devices'), r.devices));
    var list = P.clear($('#md-o-list'));
    if (!r.sources.length) list.appendChild(el('p', { class: 'md-hint', text: T('sources.empty') }));
    r.sources.forEach(function (s) {
      var stt = s.status || {};
      list.appendChild(el('div', { class: 'md-item' }, [el('div', { class: 'md-item-main' }, [
        el('div', { class: 'md-item-title', text: (s.kind === 'jellyfin' ? 'Jellyfin · ' : T('src.share') + ' · ') + s.name }),
        el('div', { class: 'md-item-sub', text: (stt.version ? 'Jellyfin ' + stt.version + ' · ' : '') + (s.away.mode === 'direct' ? T('away.direct', { address: s.away.address }) : T('away.vpn')) })]),
      P.badge(!s.enabled ? T('src.off') : (stt.ok ? T('src.ok') : (stt.at ? T('src.problem') : T('src.unchecked'))), !s.enabled ? null : (stt.ok ? 'good' : 'warn')),
      s.enabled && s.home && s.home.level !== 'unique' ? P.badge(T('home.badge'), 'warn') : null]));
    });
    (r.problems || []).forEach(function (p) { list.appendChild(el('p', { class: 'md-note', text: T('ov.problem', { problem: p.problem || '', when: P.when(p.at) }) })); });
    var lg = P.clear($('#md-o-log'));
    (r.log || []).forEach(function (x) { lg.appendChild(el('div', null, [el('span', { class: 'md-sub', text: P.when(x.at) + ' · ' }), el('span', { text: x.text })])); });
    if (!(r.log || []).length) lg.appendChild(el('p', { class: 'md-hint', text: T('ov.log_empty') }));
  }

  $('#md-o-go').addEventListener('click', function () { if (window.GC && typeof window.GC.navigate === 'function') window.GC.navigate('sources'); });
  P.api('GET', 'admin/overview').then(draw).catch(P.warn);
})();
