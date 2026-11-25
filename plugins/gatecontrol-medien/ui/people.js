/* Tab "Personen": the right "Medien", the Jellyfin user of each person, the sources each person sees. */
(function () {
  'use strict';
  var P = window.MD;
  var T = P.T, el = P.el, $ = P.$;
  var S = null;

  function triSelect(value, label, onChange, inheritText) {
    var s = el('select', { class: 'form-select', 'aria-label': label }, [
      el('option', { value: '', text: inheritText || T('rights.inherit') }), el('option', { value: '1', text: T('common.yes') }), el('option', { value: '0', text: T('common.no') })]);
    s.value = value == null ? '' : (value ? '1' : '0');
    s.addEventListener('change', function () { s.disabled = true; onChange(s.value === '' ? null : s.value === '1'); });
    return s;
  }

  function save(method, path, body) {
    return P.api(method, path, body).then(function () { P.toast(T('common.saved')); return load(); }).catch(function (e) { P.warn(e); load(); });
  }

  function mappingCell(u, src) {
    var users = S.jellyfinUsers[src.id];
    var link = u.links[src.id];
    if (users == null) return el('td', { class: 'md-sub', text: T('people.jf_unreachable') });
    var sel = el('select', { class: 'form-select', 'aria-label': u.name + ' – ' + src.name }, [
      el('option', { value: '__auto', text: T('map.auto') }), el('option', { value: '__none', text: T('map.none') })].concat(users.map(function (x) { return el('option', { value: x.id, text: x.name }); })));
    sel.value = !link ? '__auto' : (link.how === 'none' ? '__none' : link.jfUserId);
    if (link && link.jfUserId && !users.some(function (x) { return x.id === link.jfUserId; })) sel.appendChild(el('option', { value: link.jfUserId, text: (link.jfUserName || '?') + ' ⚠', selected: true }));
    sel.addEventListener('change', function () {
      sel.disabled = true;
      var b = sel.value === '__auto' ? { auto: true } : (sel.value === '__none' ? { jfUserId: null } : { jfUserId: sel.value });
      save('PUT', 'admin/sources/' + src.id + '/mapping/' + u.id, b);
    });
    var how = link ? el('span', { class: 'md-sub', text: ' ' + T('map.how.' + link.how) }) : el('span', { class: 'md-sub', text: ' ' + T('map.how.missing') });
    var create = !link || !link.jfUserId ? el('button', { type: 'button', class: 'btn btn-sm', text: T('map.create'), on: { click: function () { createUser(u, src); } } }) : null;
    return el('td', null, [sel, how, create]);
  }

  function createUser(u, src) {
    var name = P.input({ value: u.suggest, maxlength: 40 });
    P.dialog(el('div', null, [el('h2', { class: 'md-card-title', text: T('map.create_title', { name: u.name }) }), P.field(T('map.create_login'), name), el('p', { class: 'md-hint', text: T('map.create_hint') })]),
      [{ label: T('common.cancel'), value: false }, { label: T('map.create'), primary: true, run: function () {
        return P.api('POST', 'admin/sources/' + src.id + '/mapping/' + u.id + '/create', { name: name.value }).then(function () { P.toast(T('map.created')); load(); return true; });
      } }]);
  }

  function accessCell(u, src) {
    var a = u.access[src.id] || {};
    var box = el('input', { type: 'checkbox', checked: !!a.allowed, disabled: !u.media.effective, 'aria-label': u.name + ' – ' + src.name });
    box.addEventListener('change', function () { box.disabled = true; save('PUT', 'admin/sources/' + src.id + '/people/' + u.id, { allow: box.checked }); });
    var reset = a.own != null ? el('button', { type: 'button', class: 'btn btn-sm', text: T('access.reset'), title: T('access.reset_hint'), on: { click: function () { save('PUT', 'admin/sources/' + src.id + '/people/' + u.id, { allow: null }); } } }) : null;
    var why = a.source === 'child' ? el('span', { class: 'md-sub', text: ' ' + T('access.child') }) : null;
    return el('td', null, [box, why, reset]);
  }

  function draw() {
    var tbl = P.clear($('#md-people'));
    var jfs = S.sources.filter(function (s) { return s.kind === 'jellyfin'; });
    var head = [el('th', { scope: 'col', text: T('people.col_person') }), el('th', { scope: 'col', text: T('people.col_media') })]
      .concat(jfs.map(function (s) { return el('th', { scope: 'col', text: T('people.col_jf', { name: s.name }) }); }))
      .concat(S.sources.map(function (s) { return el('th', { scope: 'col', text: s.name + (s.kind === 'share' ? ' (NAS)' : '') }); }))
      .concat([el('th', { scope: 'col', text: T('people.col_devices') })]);
    tbl.appendChild(el('thead', null, [el('tr', null, head)]));
    var body = el('tbody');
    var media = 0;
    var linked = 0;
    S.people.forEach(function (u) {
      if (u.media.effective) media++;
      if (jfs.some(function (s) { return u.links[s.id] && u.links[s.id].jfUserId; })) linked++;
      var who = el('td', null, [P.avatar(u), el('span', { text: u.name }), el('span', { class: 'md-sub', text: ' ' + [u.role === 'admin' ? T('people.admin') : null, u.family ? T('people.family.' + u.family) : null].filter(Boolean).join(' · ') })]);
      var mediaCell = el('td', null, [triSelect(u.media.set, u.name + ' – ' + T('people.col_media'), function (v) { save('PUT', 'admin/rights/user/' + u.id, { media: v }); }),
        el('span', { class: 'md-sub', text: ' → ' + (u.media.effective ? T('common.yes') : T('common.no')) + (u.media.set == null ? ' (' + T('rights.src.' + u.media.source) + ')' : '') })]);
      body.appendChild(el('tr', { 'data-user': String(u.id) }, [who, mediaCell].concat(jfs.map(function (s) { return mappingCell(u, s); }))
        .concat(S.sources.map(function (s) { return accessCell(u, s); })).concat([el('td', { text: String(u.devices) })])));
    });
    tbl.appendChild(body);
    $('#md-p-sum').textContent = T('people.summary', { media: media, linked: linked });
    var gt = P.clear($('#md-groups'));
    gt.appendChild(el('thead', null, [el('tr', null, [el('th', { scope: 'col', text: T('groups.col') }), el('th', { scope: 'col', text: T('people.col_media') })])]));
    var gb = el('tbody');
    S.groups.forEach(function (g) {
      gb.appendChild(el('tr', null, [el('td', { text: g.path || g.name }), el('td', null, [triSelect(g.media, g.name, function (v) { save('PUT', 'admin/rights/group/' + g.id, { media: v }); }, T('rights.unset'))])]));
    });
    if (!S.groups.length) gb.appendChild(el('tr', null, [el('td', { colspan: '2', class: 'md-sub', text: T('groups.none') })]));
    gt.appendChild(gb);
  }

  function load() {
    return P.api('GET', 'admin/people').then(function (r) { S = r; draw(); }).catch(P.warn);
  }
  load();
})();
