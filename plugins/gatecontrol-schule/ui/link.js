/* Profile section „WebUntis verknüpfen“ (1.3.0; portal „Meine Geräte“, plugin.json
   ui.portal.profileSections, GateControl ≥ 1.188.0). The viewer links his own WebUntis student
   account — scan the QR code, upload a picture of it or type it in (ui/scan.js) — and can undo it.
   Only ever for himself: the server maps the student to the signed-in viewer (server/link.js). */
(function () {
  'use strict';
  var S = window.SC, T = S.T, $ = S.$, el = S.el;
  var data = null;

  function load() {
    return S.api('GET', 'portal/link').then(function (r) { data = r; render(); }).catch(function (e) { S.toast(S.errText(e), 'error'); });
  }

  function row(s) {
    var sub = [s.klasse ? T('view.class', { klasse: s.klasse }) : null, s.school, s.by === 'admin' ? T('link.by_admin') : T('link.by_self')].filter(Boolean).join(' · ');
    return el('div', { class: 'sl-item', style: { '--kid': s.color } }, [
      S.avatar(s, 'av-lg'),
      el('div', { class: 'sl-item-main' }, [el('b', { text: s.name }), el('small', { text: sub })]),
      s.removable ? el('button', { type: 'button', class: 'btn btn-sm btn-ghost btn-danger', text: T('link.remove'), on: { click: function () { unlink(s); } } }) : null,
    ]);
  }

  function render() {
    var list = S.clear($('#sl-list'));
    (data.students || []).forEach(function (s) { list.appendChild(row(s)); });
    var has = (data.students || []).length > 0;
    $('#sl-lead').textContent = has ? T('link.lead_linked') : T('link.lead');
    $('#sl-add').hidden = !data.allowed;
    $('#sl-add').textContent = has ? T('link.add_more') : T('link.add');
    $('#sl-off').hidden = !!data.allowed;
  }

  function add() {
    window.SCScan.open({
      title: T('link.add'),
      intro: T('scan.intro_self'),
      submitLabel: T('link.connect'),
      onSubmit: function (body) {
        return S.api('POST', 'portal/link', body).then(function (r) {
          S.toast(r.merged ? T('link.done_merged', { name: r.student.name }) : T('link.done', { name: r.student.name }));
          return load();
        });
      },
    });
  }

  function unlink(s) {
    S.confirm(T('link.remove_confirm', { name: s.name }), T('link.remove'), true).then(function (yes) {
      if (!yes) return null;
      return S.api('DELETE', 'portal/link/' + s.id).then(function () { S.toast(T('link.removed')); return load(); });
    }).catch(function (e) { S.toast(S.errText(e), 'error'); });
  }

  $('#sl-ic').appendChild(S.svg(S.ICON.school, 20));
  $('#sl-add').addEventListener('click', add);
  load();
}());
