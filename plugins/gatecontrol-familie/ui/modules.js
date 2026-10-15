/* Page "Funktionen": the modules as switches (plugin settings mod_*,
   grouped like the mockup AdminModules), the wall tablet (its shopping list
   and how to set it up), the locate mode per child (with the hint from 14),
   and a live preview of the app's family screen for a chosen member. */
(function () {
  'use strict';
  var A = window.FA, T = A.T, $ = A.$, el = A.el;
  var data = null;

  var GROUPS = [
    ['group.everyday', [['shopping', 'all'], ['tasks', 'all'], ['dates', 'all'], ['board', 'all'], ['meals', 'all']]],
    ['group.out', [['places', 'all'], ['rides', 'all']]],
    ['group.kids', [['locate', 'parents'], ['arrival_sos', 'children'], ['stars', 'children'], ['emergency', 'all']]],
    ['group.money', [['allowance', 'family'], ['wishes', 'all'], ['expenses', 'parents']]],
    ['group.home', [['wall', 'none'], ['presence', 'all']]],
  ];
  // what the app shows (the wall tablet has no app screen)
  var ORDER = ['shopping', 'tasks', 'stars', 'dates', 'board', 'meals', 'rides', 'emergency', 'locate', 'arrival_sos', 'places', 'allowance', 'wishes', 'expenses', 'presence'];

  function ageHint(k) { return k.role === 'child' && !k.adult && k.age != null && k.age >= 14 && k.locateMode === 'auto'; }
  function family() { return data.members.filter(function (m) { return m.role !== 'wall'; }); }
  function hasKids() { return data.members.some(function (m) { return m.role === 'child'; }); }

  function setModule(key, on, btn) {
    var body = {}; body[key] = on;
    A.api('PUT', 'admin/modules', body).then(function (r) {
      data.modules = r.modules;
      A.toast(T('modules.saved'));
      render();
    }).catch(function (e) { A.setSwitch(btn, !on); A.warn(e); });
  }

  function renderGroups() {
    var box = A.clear($('#fa-groups'));
    GROUPS.forEach(function (g) {
      var sec = el('section', { class: 'fa-card fa-flush' }, [el('h2', { class: 'fa-group-h', text: T(g[0]) })]);
      g[1].forEach(function (it) {
        var key = it[0];
        var on = !!data.modules[key];
        var text = [el('span', { class: 'fa-opt-title', text: T('module.' + key) }), el('span', { class: 'fa-opt-desc', text: T('module.' + key + '_desc') })];
        // Pocket money needs a child: without one the app shows no card at all.
        if (key === 'allowance' && !hasKids()) text.push(el('span', { class: 'fa-age-hint', text: T('modules.allowance_no_kids') }));
        sec.appendChild(el('div', { class: 'fa-mod' + (on ? '' : ' is-off') }, [
          el('div', { class: 'fa-opt-text' }, text),
          el('span', { class: 'fa-mod-who', text: T('who.' + it[1]) }),
          A.switchBtn(on, T('module.' + key), function (v, b) { setModule(key, v, b); }),
        ]));
      });
      box.appendChild(sec);
    });
  }

  function renderKids() {
    var box = A.clear($('#fa-kids'));
    var kids = data.members.filter(function (m) { return m.role === 'child'; });
    if (!kids.length) { box.appendChild(el('p', { class: 'fa-empty', text: T('modules.no_kids') })); return; }
    kids.forEach(function (k) {
      var label = k.name + (k.age != null ? ' (' + k.age + ')' : '');
      if (k.adult) {
        box.appendChild(el('div', { class: 'fa-kid-row' }, [el('span', { class: 'fa-kid-name', text: label }), el('span', { class: 'fa-pill is-warn', text: T('members.adult') })]));
        return;
      }
      var sel = el('select', { class: 'form-select', 'aria-label': T('modules.mode_for', { name: k.name }) }, ['confirm', 'auto', 'off'].map(function (v) {
        return el('option', { value: v, text: v === 'confirm' ? T('mode.confirm_named', { name: k.name }) : T('mode.' + v) });
      }));
      sel.value = k.locateMode;
      sel.disabled = !data.modules.locate;
      var hint = el('span', { class: 'fa-age-hint', text: T('members.age_hint', { name: k.name }) });
      hint.hidden = !ageHint(k);
      sel.addEventListener('change', function () {
        var prev = k.locateMode;
        A.api('PATCH', 'admin/members/' + k.userId, { locateMode: sel.value }).then(function (r) {
          k.locateMode = r.member.locateMode;
          hint.hidden = !ageHint(k);
          A.toast(T('common.saved'));
          renderPreview();
        }).catch(function (e) { sel.value = prev; A.warn(e); });
      });
      box.appendChild(el('div', { class: 'fa-kid-row' }, [el('span', { class: 'fa-kid-name', text: label }), sel, hint]));
    });
  }

  /** What the app's family screen shows for this member (mirrors the app: modules on, by role). */
  function cardsFor(m) {
    var mod = data.modules;
    var child = m && m.role === 'child';
    var out = [];
    ORDER.forEach(function (key) {
      if (!mod[key]) return;
      if (key === 'stars' && !mod.tasks) return;
      if (key === 'locate' && child && (m.adult || m.locateMode === 'off')) return;
      if (key === 'expenses' && child) return;
      out.push(T('card.' + key + (child ? '_child' : '_parent')));
    });
    return out;
  }

  function renderPreview() {
    var sel = $('#fa-preview-as');
    var id = parseInt(sel.value, 10);
    var m = family().filter(function (x) { return x.userId === id; })[0] || null;
    var list = A.clear($('#fa-preview-cards'));
    var cards = m ? cardsFor(m) : [];
    cards.forEach(function (c) { list.appendChild(el('div', { class: 'fa-phone-card' }, [el('span', { class: 'fa-phone-dot' }), el('span', { text: c })])); });
    if (!m) list.appendChild(el('p', { class: 'fa-empty', text: T('modules.preview_none') }));
    var on = ORDER.filter(function (k) { return data.modules[k]; }).length;
    $('#fa-preview-count').textContent = m && !on ? T('modules.preview_hidden') : T('modules.preview_count', { n: on, total: ORDER.length });
  }

  function renderPreviewSelect() {
    var sel = $('#fa-preview-as');
    var keep = sel.value;
    A.clear(sel);
    family().forEach(function (m) { sel.appendChild(el('option', { value: String(m.userId), text: m.name + ' (' + T('role.' + m.role) + ')' })); });
    if (keep && family().some(function (m) { return String(m.userId) === keep; })) sel.value = keep;
  }
  $('#fa-preview-as').addEventListener('change', renderPreview);

  // ── wall tablet ───────────────────────────────────────────────────────────
  function renderWall() {
    var walls = data.members.filter(function (m) { return m.role === 'wall'; });
    // an administrator account cannot be paired as a kiosk device (GateControl refuses it)
    var admins = walls.filter(function (m) { return m.gcRole === 'admin'; });
    $('#fa-wall-who').textContent = walls.length
      ? T('wallcfg.accounts', { names: walls.map(function (m) { return m.name; }).join(', ') }) + (data.modules.wall ? '' : ' ' + T('wallcfg.module_off'))
        + (admins.length ? ' ' + T('wallcfg.admin_account', { names: admins.map(function (m) { return m.name; }).join(', ') }) : '')
      : T('wallcfg.none');
    var sel = A.clear($('#fa-wall-list'));
    sel.appendChild(el('option', { value: '', text: T('wallcfg.list_first') }));
    (data.wall.lists || []).forEach(function (l) { sel.appendChild(el('option', { value: l.id, text: l.name })); });
    sel.value = data.wall.listId && (data.wall.lists || []).some(function (l) { return l.id === data.wall.listId; }) ? data.wall.listId : '';
    sel.disabled = !data.modules.wall || !data.modules.shopping;
  }
  $('#fa-wall-list').addEventListener('change', function () {
    var sel = $('#fa-wall-list');
    var prev = data.wall.listId || '';
    A.api('PUT', 'admin/wall', { listId: sel.value || null }).then(function (r) {
      data.wall.listId = r.wall.listId;
      A.toast(T('common.saved'));
    }).catch(function (e) { sel.value = prev; A.warn(e); });
  });

  function render() {
    renderGroups();
    renderWall();
    renderKids();
    renderPreview();
  }

  A.api('GET', 'admin/status').then(function (r) {
    data = r;
    renderPreviewSelect();
    render();
  }).catch(A.warn);
}());
