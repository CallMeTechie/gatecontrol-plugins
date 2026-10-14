/* Page "Mitglieder & Ortung": who belongs to the family (GateControl users),
   parent or child, birthdate, locate mode per child, star goal; the locate
   switches (the same module switches as on "Funktionen"); the last 7 days
   of the locate log. */
(function () {
  'use strict';
  var A = window.FA, T = A.T, $ = A.$, el = A.el;
  var data = null;
  var edit = null; // member being edited (null = new)

  function roleOfAccount(u) { return u && u.role === 'admin' ? T('account.admin') : T('account.user'); }

  function locateCell(m) {
    if (m.role === 'wall') return el('span', { class: 'fa-muted', text: '–' });
    if (m.role !== 'child') return data.modules.locate ? el('span', { class: 'fa-ok', text: T('members.may_locate') }) : el('span', { class: 'fa-muted', text: '–' });
    if (m.adult) return el('span', { class: 'fa-pill is-warn', text: T('members.adult') });
    if (!data.modules.locate) return el('span', { class: 'fa-muted', text: T('members.module_off') });
    if (m.locateMode === 'off') return el('span', { class: 'fa-muted', text: T('members.locate_off') });
    return el('span', null, [
      el('span', { text: T('members.locatable', { mode: T('mode.' + m.locateMode) }) }),
      m.ageHint ? el('span', { class: 'fa-age-hint', text: T('members.age_hint', { name: m.name }) }) : null,
    ]);
  }

  /** Full years on `today` (both YYYY-MM-DD), like the server. */
  function ageOn(birth, today) {
    var b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth || '');
    var t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today || '');
    if (!b || !t) return null;
    var a = +t[1] - +b[1];
    if (+t[2] < +b[2] || (+t[2] === +b[2] && +t[3] < +b[3])) a--;
    return a < 0 ? 0 : a;
  }

  function memberRow(m) {
    var acct = [T('members.account', { name: m.name }), m.gcRole === 'admin' ? T('account.admin') : T('account.user')];
    if (m.role === 'child' && m.age != null) acct.push(T('members.years', { n: m.age }));
    var person = el('div', { class: 'fa-person' }, [A.avatar(m), el('div', null, [el('b', { text: m.name }), el('div', { class: 'fa-sub', text: acct.join(' · ') })])]);
    return el('tr', null, [
      el('td', null, [person]),
      el('td', null, [el('span', { class: 'fa-pill' + (m.role === 'child' ? ' is-child' : (m.role === 'wall' ? ' is-off' : '')), text: T('role.' + m.role) })]),
      el('td', { text: m.birthdate ? A.dateLong(m.birthdate) : '–' }),
      el('td', null, [locateCell(m)]),
      el('td', { text: m.role === 'child' ? String(m.starGoal) + ' ★' : '–' }),
      el('td', null, [el('button', { type: 'button', class: 'btn btn-sm', text: T('common.edit'), on: { click: function () { openMember(m); } } })]),
    ]);
  }

  function option(box, title, desc, on, onChange, disabled) {
    A.clear(box);
    box.appendChild(el('div', { class: 'fa-opt-text' }, [el('span', { class: 'fa-opt-title', text: title }), el('span', { class: 'fa-opt-desc', text: desc })]));
    box.appendChild(A.switchBtn(on, title, onChange, disabled));
  }

  function setModule(key, on, btn) {
    var body = {}; body[key] = on;
    A.api('PUT', 'admin/modules', body).then(function (r) {
      data.modules = r.modules;
      A.toast(T('modules.saved'));
      render();
    }).catch(function (e) { A.setSwitch(btn, !on); A.warn(e); });
  }

  function render() {
    var probs = (data.settings.problems || []).map(function (p) { return T('problem.' + p); });
    $('#fa-problems').hidden = !probs.length;
    $('#fa-problems').textContent = probs.join(' ');
    var rows = A.clear($('#fa-member-rows'));
    data.members.forEach(function (m) { rows.appendChild(memberRow(m)); });
    $('#fa-members-empty').hidden = data.members.length > 0;
    $('#fa-add').disabled = !data.users.some(function (u) { return !u.member; });
    option($('#fa-opt-locate'), T('locate.opt_locate'), T('locate.opt_locate_desc'), data.modules.locate, function (on, b) { setModule('locate', on, b); });
    option($('#fa-opt-sees'), T('locate.opt_sees'), T('locate.opt_sees_desc'), true, null, true);
    option($('#fa-opt-sos'), T('locate.opt_sos'), T('locate.opt_sos_desc'), data.modules.arrival_sos, function (on, b) { setModule('arrival_sos', on, b); });
    option($('#fa-opt-adult'), T('locate.opt_adult'), T('locate.opt_adult_desc'), true, null, true);
  }

  // ── log (last 7 days: locate requests and arrivals) ───────────────────────
  function resultCell(e) {
    var td = el('td');
    if (e.kind === 'arrival') {
      td.appendChild(document.createTextNode(e.label || T('log.arrived')));
      if (e.position) { td.appendChild(document.createTextNode(' · ')); td.appendChild(A.map.osmLink(e.position, '±' + Math.round(e.position.accuracy || 0) + ' m')); }
      return td;
    }
    if (e.status === 'answered') {
      if (e.position) td.appendChild(A.map.osmLink(e.position, T('log.position', { m: Math.round(e.position.accuracy || 0) })));
      else td.appendChild(el('span', { class: 'fa-muted', text: T('log.answered_purged') }));
      return td;
    }
    var cls = e.status === 'declined' || e.status === 'failed' ? 'fa-bad' : 'fa-muted';
    var text = T('status.' + e.status, { name: e.subject });
    if (e.status === 'failed' && e.reason) text += ' · ' + T('fail.' + e.reason);
    td.appendChild(el('span', { class: cls, text: text }));
    return td;
  }

  function loadLog() {
    A.api('GET', 'admin/log?days=7&kind=locate,arrival').then(function (r) {
      var rows = A.clear($('#fa-log-rows'));
      r.entries.slice(0, 50).forEach(function (e) {
        rows.appendChild(el('tr', null, [
          el('td', { class: 'fa-time', text: A.when(e.at) }),
          el('td', { text: T('kind.' + e.kind) }),
          el('td', { text: e.by }),
          el('td', { text: e.subject }),
          resultCell(e),
        ]));
      });
      $('#fa-log-empty').hidden = r.entries.length > 0;
    }).catch(A.warn);
  }

  // ── member dialog ─────────────────────────────────────────────────────────
  function roleValue() { return $('#fa-m-child').checked ? 'child' : ($('#fa-m-wall').checked ? 'wall' : 'parent'); }
  function syncRole() {
    var role = roleValue();
    $('#fa-m-child-box').hidden = role !== 'child';
    $('#fa-m-person-box').hidden = role === 'wall';
    $('#fa-m-wall-hint').hidden = role !== 'wall';
    $('#fa-m-birth-hint').textContent = role === 'child' ? T('members.birthdate_required') : T('members.birthdate_hint');
    syncAgeHint();
  }
  /** From 14 we recommend "<Name> bestätigt": a hint next to the select when "Automatisch" is chosen. */
  function syncAgeHint() {
    var a = ageOn($('#fa-m-birth').value, data.today);
    var name = edit ? edit.name : ($('#fa-m-user').selectedOptions && $('#fa-m-user').selectedOptions[0] ? $('#fa-m-user').selectedOptions[0].textContent.replace(/ \(.*\)$/, '') : '');
    var h = $('#fa-m-age-hint');
    h.textContent = T('members.age_hint', { name: name || T('role.child') });
    h.hidden = !(roleValue() === 'child' && a != null && a >= 14 && a < 18 && $('#fa-m-mode').value === 'auto');
  }
  $('#fa-m-parent').addEventListener('change', syncRole);
  $('#fa-m-child').addEventListener('change', syncRole);
  $('#fa-m-wall').addEventListener('change', syncRole);
  $('#fa-m-mode').addEventListener('change', syncAgeHint);
  $('#fa-m-user').addEventListener('change', syncAgeHint);
  $('#fa-m-birth').addEventListener('change', function () {
    // a new child of 14 or older starts with "Kind bestätigt"
    var a = ageOn($('#fa-m-birth').value, data.today);
    if (!edit && a != null && a >= 14) $('#fa-m-mode').value = 'confirm';
    syncAgeHint();
  });

  function openMember(m) {
    edit = m || null;
    $('#fa-m-title').textContent = m ? T('members.edit', { name: m.name }) : T('members.add');
    $('#fa-m-user-group').hidden = !!m;
    if (!m) {
      var sel = A.clear($('#fa-m-user'));
      data.users.filter(function (u) { return !u.member; }).forEach(function (u) {
        sel.appendChild(el('option', { value: String(u.id), text: u.name + ' (' + roleOfAccount(u) + ')' }));
      });
    }
    $('#fa-m-parent').checked = !m || m.role === 'parent';
    $('#fa-m-child').checked = !!m && m.role === 'child';
    $('#fa-m-wall').checked = !!m && m.role === 'wall';
    $('#fa-m-birth').value = (m && m.birthdate) || '';
    $('#fa-m-birth').max = data.today;
    $('#fa-m-color').value = (m && m.color ? m.color : '#0f766e').toLowerCase();
    $('#fa-m-mode').value = (m && m.locateMode) || 'confirm';
    $('#fa-m-goal').value = String((m && m.starGoal) || 20);
    $('#fa-m-delete').hidden = !m;
    $('#fa-m-msg').textContent = '';
    syncRole();
    A.openModal('fa-member-modal');
  }
  $('#fa-add').addEventListener('click', function () { openMember(null); });

  $('#fa-m-save').addEventListener('click', function () {
    var role = roleValue();
    var body = role === 'wall' ? { role: role } : { role: role, birthdate: $('#fa-m-birth').value || null, color: $('#fa-m-color').value };
    if (role === 'child') {
      if (!body.birthdate) { $('#fa-m-msg').textContent = T('members.birthdate_required'); return; }
      body.locateMode = $('#fa-m-mode').value;
      body.starGoal = parseInt($('#fa-m-goal').value, 10) || 20;
    }
    var btn = $('#fa-m-save');
    btn.disabled = true;
    var p;
    if (edit) p = A.api('PATCH', 'admin/members/' + edit.userId, body);
    else { body.userId = parseInt($('#fa-m-user').value, 10); p = A.api('POST', 'admin/members', body); }
    p.then(function () {
      A.closeModal('fa-member-modal');
      A.toast(T('common.saved'));
      return load();
    }).catch(function (e) { $('#fa-m-msg').textContent = A.errText(e); }).then(function () { btn.disabled = false; });
  });

  $('#fa-m-delete').addEventListener('click', function () {
    if (!edit) return;
    var m = edit;
    A.confirm(T('members.remove_confirm', { name: m.name }), T('members.remove'), true).then(function (ok) {
      if (!ok) return;
      A.api('DELETE', 'admin/members/' + m.userId).then(function () {
        A.closeModal('fa-member-modal');
        A.toast(T('members.removed'));
        return load();
      }).catch(A.warn);
    });
  });

  function load() {
    return A.api('GET', 'admin/status').then(function (r) { data = r; render(); loadLog(); }).catch(A.warn);
  }
  load();
}());
