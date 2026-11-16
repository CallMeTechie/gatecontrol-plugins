/* Admin page "Berechtigungen": the four rights per group and person, and the matrix of people and groups × devices.
   1.2: the recording per group and person (aus / wählbar / immer — the stricter of person and device holds). */
(function () {
  'use strict';
  var P = window.RM;
  var T = P.T, el = P.el, $ = P.$;
  var KEYS = ['rdp', 'ssh', 'support', 'share'];
  var S = null;

  function avatar(u) {
    if (u.avatarUrl) return el('img', { class: 'rm-av', src: u.avatarUrl, alt: '' });
    var av = el('span', { class: 'rm-av', text: u.initials || (u.name || '?').slice(0, 1) });
    if (u.color) av.style.background = u.color;
    return av;
  }

  /** null = not set here, true / false */
  function choice(kind, who, key, value, label) {
    var s = el('select', { class: 'form-select', 'aria-label': label }, [
      el('option', { value: '', text: kind === 'user' ? T('rights.inherit') : T('rights.unset') }),
      el('option', { value: '1', text: T('common.yes') }),
      el('option', { value: '0', text: T('common.no') }),
    ]);
    s.value = value == null ? '' : (value ? '1' : '0');
    s.addEventListener('change', function () {
      var patch = {};
      patch[key] = s.value === '' ? null : s.value === '1';
      s.disabled = true;
      P.api('PUT', 'admin/rights/' + kind + '/' + who.id, patch).then(function () { P.toast(T('common.saved')); return load(); }).catch(function (e) { P.warn(e); load(); });
    });
    return s;
  }

  /** 1.2: the recording of a group or person: not set here / off / optional / always */
  function recChoice(kind, who, value, label) {
    var s = el('select', { class: 'form-select', 'aria-label': label }, [
      el('option', { value: '', text: kind === 'user' ? T('rights.inherit') : T('rights.unset') }),
      el('option', { value: 'off', text: T('rec.off') }), el('option', { value: 'optional', text: T('rec.optional') }), el('option', { value: 'always', text: T('rec.always') })]);
    s.value = value || '';
    s.addEventListener('change', function () {
      var go = s.value === 'always' ? P.confirmDialog(T('rights.rec_always_q', { name: who.name }), T('rec.always')) : Promise.resolve(true);
      go.then(function (ok) {
        if (!ok) { s.value = value || ''; return null; }
        s.disabled = true;
        return P.api('PUT', 'admin/rights/' + kind + '/' + who.id, { recording: s.value || null }).then(function () { P.toast(T('common.saved')); return load(); });
      }).catch(function (e) { P.warn(e); load(); });
    });
    return s;
  }

  function personCell(u) {
    var name = el('button', { type: 'button', class: 'btn btn-sm', text: u.name, title: T('rights.view_person'), on: { click: function () { personView(u); } } });
    return el('td', null, [avatar(u), name, u.role === 'admin' ? el('span', { class: 'rm-sub', text: ' (' + T('rights.admin') + ')' }) : null]);
  }

  function drawRights() {
    var tbl = P.clear($('#rm-rights'));
    tbl.appendChild(el('thead', null, [el('tr', null, [el('th', { scope: 'col', text: T('rights.col_who') })].concat(KEYS.map(function (k) { return el('th', { scope: 'col', text: T('right.' + k) }); }))
      .concat([el('th', { scope: 'col', text: T('rights.col_rec') })]))]));
    var body = el('tbody');
    S.groups.forEach(function (g) {
      body.appendChild(el('tr', { class: 'rm-group-row', 'data-group': String(g.id) }, [el('td', { text: T('rights.group', { name: g.path || g.name }) })].concat(KEYS.map(function (k) {
        return el('td', null, [choice('group', g, k, g.set[k], g.name + ' – ' + T('right.' + k))]);
      })).concat([el('td', null, [recChoice('group', g, g.set.recording, g.name + ' – ' + T('rights.col_rec'))])])));
    });
    S.people.forEach(function (u) {
      body.appendChild(el('tr', { 'data-user': String(u.id) }, [personCell(u)].concat(KEYS.map(function (k) {
        if (u.role === 'admin') return el('td', { class: 'rm-sub', text: T('rights.always') });
        var eff = el('span', { class: 'rm-sub', text: ' → ' + (u.effective[k] ? T('common.yes') : T('common.no')) + (u.set[k] == null ? ' (' + T('rights.src.' + u.source[k]) + ')' : '') });
        return el('td', null, [choice('user', u, k, u.set[k], u.name + ' – ' + T('right.' + k)), eff]);
      })).concat([u.role === 'admin' ? el('td', { class: 'rm-sub', text: T('rights.rec_device') }) : el('td', null, [recChoice('user', u, u.set.recording, u.name + ' – ' + T('rights.col_rec')),
        el('span', { class: 'rm-sub', text: ' → ' + (u.effective.recording ? T('rec.' + u.effective.recording) : T('rights.rec_device')) })])])));
    });
    tbl.appendChild(body);
  }

  function saveAccess(d, list) {
    return P.api('PUT', 'admin/devices/' + d.id + '/access', list).then(function () { P.toast(T('common.saved')); return load(); }).catch(function (e) { P.warn(e); load(); });
  }

  function drawAccess() {
    var tbl = P.clear($('#rm-access'));
    $('#rm-a-none').hidden = S.devices.length > 0;
    if (!S.devices.length) return;
    var head = [el('th', { scope: 'col', text: T('rights.col_who') })];
    S.devices.forEach(function (d) {
      var open = !d.access.users.length && !d.access.groups.length;
      var mode = el('select', { class: 'form-select', 'aria-label': d.name + ' – ' + T('access.mode') }, [
        el('option', { value: 'all', text: T('access.all') }), el('option', { value: 'some', text: T('access.some') })]);
      mode.value = open ? 'all' : 'some';
      mode.addEventListener('change', function () {
        if (mode.value === 'all') saveAccess(d, { users: [], groups: [] });
        else { d._some = true; drawAccess(); }
      });
      head.push(el('th', { scope: 'col' }, [el('div', { class: 'rm-col-head' }, [el('span', { text: d.name }), P.protoBadge(d.protocol), mode,
        open && d.access.tokens.length ? el('span', { class: 'rm-sub', text: T('access.tokens', { n: d.access.tokens.length }) }) : null])]));
    });
    tbl.appendChild(el('thead', null, [el('tr', null, head)]));
    var body = el('tbody');
    function cells(kind, who) {
      return S.devices.map(function (d) {
        var open = !d.access.users.length && !d.access.groups.length && !d._some;
        var list = kind === 'group' ? d.access.groups : d.access.users;
        var box = el('input', { type: 'checkbox', checked: open || list.indexOf(who.id) >= 0, disabled: open || who.role === 'admin', 'aria-label': who.name + ' – ' + d.name });
        box.addEventListener('change', function () {
          var next = { users: d.access.users.slice(), groups: d.access.groups.slice() };
          var arr = kind === 'group' ? next.groups : next.users;
          var i = arr.indexOf(who.id);
          if (box.checked && i < 0) arr.push(who.id);
          if (!box.checked && i >= 0) arr.splice(i, 1);
          box.disabled = true;
          saveAccess(d, next);
        });
        return el('td', null, [box]);
      });
    }
    S.groups.forEach(function (g) { body.appendChild(el('tr', { class: 'rm-group-row' }, [el('td', { text: T('rights.group', { name: g.path || g.name }) })].concat(cells('group', g)))); });
    S.people.forEach(function (u) { body.appendChild(el('tr', null, [el('td', null, [avatar(u), el('span', { text: u.name })])].concat(cells('user', u)))); });
    tbl.appendChild(body);
  }

  /** What one person may do and reach — the administrator's view of a person. */
  function personView(u) {
    P.api('GET', 'admin/rights/user/' + u.id).then(function (r) {
      var list = el('ul', { class: 'rm-right-list' }, KEYS.map(function (k) {
        return el('li', null, [el('span', { class: 'rm-mark', 'data-on': r.rights[k] ? '1' : '0', text: r.rights[k] ? '✓' : '–' }), el('span', { text: T('right.' + k) }),
          el('span', { class: 'rm-sub', text: '(' + T('rights.src.' + (r.rights.source[k] || 'default')) + ')' })]);
      }));
      var devs = r.devices.length ? el('ul', { class: 'rm-right-list' }, r.devices.map(function (d) { return el('li', null, [P.protoBadge(d.protocol), el('span', { text: d.name })]); }))
        : el('p', { class: 'rm-hint', text: T('rights.person_none') });
      return P.dialog(el('div', null, [el('h2', { class: 'rm-card-title', text: T('rights.person_title', { name: r.user.name }) }), list,
        el('h3', { class: 'form-label', text: T('rights.person_devices') }), devs]));
    }).catch(P.warn);
  }

  function load() {
    return P.api('GET', 'admin/rights').then(function (r) {
      var some = {};
      if (S) S.devices.forEach(function (d) { if (d._some) some[d.id] = true; });
      S = r;
      S.devices.forEach(function (d) { if (some[d.id] && !d.access.users.length && !d.access.groups.length) d._some = true; });
      drawRights();
      drawAccess();
    }).catch(P.warn);
  }
  load();
})();
