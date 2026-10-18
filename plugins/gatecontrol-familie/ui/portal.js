/* Portal tab "Familie": shopping lists (edit), tasks of the week (done;
   parents create/edit), dates and birthdays, rides of the week (take,
   decline, ask, release), and for parents the locate panel (request,
   countdown, last results on a map) and the emergency card (view and edit).
   Same API as the app; a viewer recognised only by device trust reads (no
   positions, no emergency card) and changes nothing.
   1.3.0: the family as chips in the header — picture or initials on the
   favourite colour inside the presence ring (A.avatar, ui/common.js),
   refreshed every minute with GET me while the module presence is on. */
(function () {
  'use strict';
  var A = window.FA, T = A.T, $ = A.$, $$ = A.$$, el = A.el;
  var CTX = A.CTX;
  var ICON_CHECK = 'M5 12l5 5 9-10';
  var ICON_EDIT = 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4';
  var ICON_X = 'M6 6l12 12M18 6L6 18';

  var me = null;          // GET me
  var shop = { lists: [], items: [], listId: null };
  var tasksData = null;
  var editTask = null;
  var editList = null;
  var pending = {};       // childId → { id, expiresAt }
  var writable = CTX.loggedIn === true;

  function memberById(id) { return (me.members || []).filter(function (m) { return m.userId === id; })[0] || null; }
  function nameOf(id) { var m = memberById(id); return m ? m.name : '–'; }
  function banner(text) { var b = $('#fa-p-banner'); b.textContent = text; b.hidden = !text; }

  // ── header ───────────────────────────────────────────────────────────────
  function renderSub() {
    var parts = [new Date().toLocaleDateString(CTX.lang === 'en' ? 'en-GB' : 'de-DE', { weekday: 'long', day: 'numeric', month: 'long' })];
    parts.push(T('portal.people', { n: me.members.length }));
    if (tasksData) {
      var open = tasksData.tasks.filter(function (t) { return t.dueDate && t.dueDate <= A.todayStr() && !t.doneToday && !t.completed; }).length;
      parts.push(T('portal.tasks_open', { n: open }));
    }
    $('#fa-p-sub').textContent = parts.join(' · ');
  }

  /** The member chips in the header: avatar with the presence ring and the name. */
  function renderPeople() {
    var box = A.clear($('#fa-p-people'));
    (me.members || []).forEach(function (m) {
      var label = A.avatarLabel(m);
      var a = A.avatar(m, 30);
      a.removeAttribute('role'); a.removeAttribute('aria-label'); a.setAttribute('aria-hidden', 'true');
      box.appendChild(el('span', { class: 'fa-p-chip', role: 'listitem', title: label, 'aria-label': label }, [a, el('span', { text: m.name, 'aria-hidden': 'true' })]));
    });
    box.hidden = !(me.members || []).length;
  }

  // ── shopping ─────────────────────────────────────────────────────────────
  function ops(list) {
    return A.api('POST', 'shopping/ops', { ops: list }).then(function (r) {
      if (r.rejected && r.rejected.length) A.toast(T('portal.op_rejected'), 'error');
      return loadShopping();
    }).catch(A.warn);
  }
  function loadShopping() {
    return A.api('GET', 'shopping').then(function (r) {
      shop.lists = r.lists; shop.items = r.items;
      if (!shop.lists.some(function (l) { return l.id === shop.listId; })) shop.listId = shop.lists.length ? shop.lists[0].id : null;
      renderShopping();
    }).catch(A.warn);
  }
  function renderShopping() {
    var sel = A.clear($('#fa-shop-list'));
    shop.lists.forEach(function (l) {
      var open = shop.items.filter(function (i) { return i.listId === l.id && !i.checked; }).length;
      sel.appendChild(el('option', { value: l.id, text: l.name + ' (' + open + ')' }));
    });
    sel.hidden = !shop.lists.length;
    if (shop.listId) sel.value = shop.listId;
    $('#fa-shop-list-edit').hidden = !shop.listId || !writable;
    $('#fa-shop-add').hidden = !shop.listId || !writable;
    $('#fa-shop-clear').disabled = !shop.items.some(function (i) { return i.listId === shop.listId && i.checked; });
    $('#fa-shop-going').disabled = !shop.listId;
    var ul = A.clear($('#fa-shop-items'));
    var items = shop.items.filter(function (i) { return i.listId === shop.listId; });
    items.sort(function (a, b) { return (a.checked ? 1 : 0) - (b.checked ? 1 : 0); });
    items.forEach(function (i) {
      var cb = el('input', { type: 'checkbox', checked: i.checked, 'aria-label': i.text, disabled: !writable });
      cb.addEventListener('change', function () { ops([{ op: 'item_check', id: i.id, checked: cb.checked }]); });
      ul.appendChild(el('li', { class: 'fa-p-item' + (i.checked ? ' is-checked' : '') }, [
        cb,
        el('span', { class: 'fa-p-item-text', text: i.text }),
        el('span', { class: 'fa-p-item-qty', text: i.checked && i.checkedBy ? nameOf(i.checkedBy) : (i.qty || '') }),
        writable ? el('button', { type: 'button', class: 'btn fa-p-x', 'aria-label': T('portal.item_delete', { name: i.text }), on: { click: function () { ops([{ op: 'item_delete', id: i.id }]); } } }, [A.svg(ICON_X, 14)]) : null,
      ]));
    });
    var empty = $('#fa-shop-empty');
    empty.textContent = !shop.lists.length ? T('portal.lists_none') : T('portal.items_none');
    empty.hidden = items.length > 0;
  }
  $('#fa-shop-list').addEventListener('change', function () { shop.listId = $('#fa-shop-list').value; renderShopping(); });
  $('#fa-shop-add').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = $('#fa-shop-text').value.trim();
    if (!text || !shop.listId) return;
    var qty = $('#fa-shop-qty').value.trim();
    var op = { op: 'item_add', id: A.uuid(), listId: shop.listId, text: text.slice(0, 120) };
    if (qty) op.qty = qty.slice(0, 40);
    $('#fa-shop-text').value = ''; $('#fa-shop-qty').value = '';
    ops([op]).then(function () { $('#fa-shop-text').focus(); });
  });
  $('#fa-shop-clear').addEventListener('click', function () { if (shop.listId) ops([{ op: 'clear_checked', listId: shop.listId }]); });
  $('#fa-shop-going').addEventListener('click', function () {
    if (!shop.listId) return;
    A.api('POST', 'shopping/lists/' + encodeURIComponent(shop.listId) + '/going').then(function (r) {
      A.toast(T('portal.going_sent', { n: r.notified }));
    }).catch(function (e) { A.toast(A.errCode(e) === 'too_soon' ? T('portal.going_soon') : A.errText(e), 'error'); });
  });
  function openList(l) {
    editList = l || null;
    $('#fa-l-title').textContent = l ? T('portal.list_edit') : T('portal.list_new');
    $('#fa-l-name').value = l ? l.name : '';
    $('#fa-l-delete').hidden = !l;
    $('#fa-l-msg').textContent = '';
    A.openModal('fa-list-modal');
  }
  $('#fa-shop-new').addEventListener('click', function () { openList(null); });
  $('#fa-shop-list-edit').addEventListener('click', function () { openList(shop.lists.filter(function (l) { return l.id === shop.listId; })[0]); });
  $('#fa-l-save').addEventListener('click', function () {
    var name = $('#fa-l-name').value.trim();
    if (!name) { $('#fa-l-msg').textContent = T('portal.list_name_required'); return; }
    var op = editList ? { op: 'list_rename', id: editList.id, name: name.slice(0, 40) } : { op: 'list_add', id: A.uuid(), name: name.slice(0, 40) };
    if (!editList) shop.listId = op.id;
    A.closeModal('fa-list-modal');
    ops([op]);
  });
  $('#fa-l-delete').addEventListener('click', function () {
    var l = editList;
    if (!l) return;
    A.confirm(T('portal.list_delete_confirm', { name: l.name }), T('common.delete'), true).then(function (ok) {
      if (!ok) return;
      A.closeModal('fa-list-modal');
      ops([{ op: 'list_delete', id: l.id }]);
    });
  });

  // ── tasks ────────────────────────────────────────────────────────────────
  var WD = function (n) { var d = new Date(2024, 0, n); return d.toLocaleDateString(CTX.lang === 'en' ? 'en-GB' : 'de-DE', { weekday: 'short' }); }; // 2024-01-01 = Monday
  function endOfWeek() {
    var d = new Date();
    var wd = (d.getDay() + 6) % 7;
    var e = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (6 - wd));
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return e.getFullYear() + '-' + p(e.getMonth() + 1) + '-' + p(e.getDate());
  }
  function taskSub(t) {
    var parts = [];
    var n = A.daysUntil(t.dueDate);
    if (n === 0) parts.push(T('rel.today') + (t.dueTime ? ' ' + t.dueTime : ''));
    else if (n != null && n < 0) parts.push(T('portal.overdue'));
    else parts.push(A.day(t.dueDate, { weekday: 'short' }) + (t.dueTime ? ' ' + t.dueTime : ''));
    if (t.repeat !== 'none') parts.push(T('repeat.' + t.repeat));
    if (t.mode !== 'fixed') parts.push(T('task.mode_' + t.mode + '_short'));
    if (t.stars && me.modules.stars) parts.push(t.stars + ' ★');
    return parts.join(' · ');
  }
  function doneFor(t, userId) {
    return t.mode === 'fixed' ? t.doneBy.indexOf(userId) >= 0 : t.doneBy.length > 0;
  }
  function markDone(t, userId) {
    var body = userId !== me.me.userId ? { userId: userId } : {};
    A.api('POST', 'tasks/' + t.id + '/done', body).then(function (r) {
      A.toast(r.starsBooked ? T('portal.done_stars', { n: r.starsBooked }) : T('portal.done'));
      return loadTasks();
    }).catch(A.warn);
  }
  function loadTasks() {
    return A.api('GET', 'tasks').then(function (r) { tasksData = r; renderTasks(); renderSub(); }).catch(A.warn);
  }
  function renderTasks() {
    var box = A.clear($('#fa-task-cols'));
    var until = endOfWeek();
    var parent = me.me.role === 'parent';
    $('#fa-task-add').hidden = !parent || !writable;
    var any = false;
    me.members.forEach(function (m) {
      var mine = tasksData.tasks.filter(function (t) {
        if (!t.dueDate || t.dueDate > until) return false;
        if (t.completed && A.daysUntil(t.lastDone && t.lastDone.at ? t.lastDone.at.slice(0, 10) : t.dueDate) < 0) return false;
        return t.mode === 'rotate' ? t.current === m.userId : t.assignees.indexOf(m.userId) >= 0;
      });
      var head = el('div', { class: 'fa-p-col-head' }, [A.avatar(m), el('b', { text: m.name })]);
      if (m.role === 'child' && tasksData.stars && tasksData.stars.week) {
        head.appendChild(el('span', { class: 'fa-p-stars', text: (tasksData.stars.week[m.userId] || 0) + ' / ' + (tasksData.stars.goal[m.userId] || 0) + ' ★' }));
      }
      var col = el('div', { class: 'fa-p-col' }, [head]);
      mine.forEach(function (t) {
        any = true;
        var done = doneFor(t, m.userId);
        var canDo = writable && !done && (m.userId === me.me.userId || parent);
        var btn = el('button', { type: 'button', class: 'btn fa-p-done', 'aria-pressed': done ? 'true' : 'false', 'aria-label': T('portal.mark_done', { title: t.title }), disabled: !canDo });
        btn.appendChild(A.svg(ICON_CHECK, 14));
        if (canDo) btn.addEventListener('click', function () { markDone(t, m.userId); });
        col.appendChild(el('div', { class: 'fa-p-task' + (done ? ' is-done' : '') }, [
          btn,
          el('div', { class: 'fa-p-task-main' }, [el('div', { class: 'fa-p-task-title', text: t.title }), el('div', { class: 'fa-p-task-sub', text: taskSub(t) })]),
          parent && writable ? el('button', { type: 'button', class: 'btn fa-p-edit', 'aria-label': T('portal.task_edit', { title: t.title }), on: { click: function () { openTask(t); } } }, [A.svg(ICON_EDIT, 14)]) : null,
        ]));
      });
      box.appendChild(col);
    });
    $('#fa-tasks-empty').hidden = any;
  }

  function weekdayBoxes(selected) {
    var box = A.clear($('#fa-t-weekdays'));
    for (var i = 1; i <= 7; i++) {
      box.appendChild(el('label', null, [el('input', { type: 'checkbox', value: String(i), checked: selected.indexOf(i) >= 0 }), WD(i)]));
    }
  }
  function syncRepeat() { $('#fa-t-wd-group').hidden = $('#fa-t-repeat').value !== 'weekly'; }
  $('#fa-t-repeat').addEventListener('change', syncRepeat);
  function openTask(t) {
    editTask = t || null;
    $('#fa-t-title').textContent = t ? T('portal.task_edit_title') : T('portal.task_add');
    $('#fa-t-name').value = t ? t.title : '';
    var people = A.clear($('#fa-t-people'));
    me.members.forEach(function (m) {
      people.appendChild(el('label', { class: 'fa-check-row' }, [el('input', { type: 'checkbox', value: String(m.userId), checked: t ? t.assignees.indexOf(m.userId) >= 0 : false }), A.avatar(m), m.name]));
    });
    $('#fa-t-mode').value = t ? t.mode : 'fixed';
    $('#fa-t-repeat').value = t ? t.repeat : 'none';
    weekdayBoxes(t && t.weekdays ? t.weekdays : []);
    $('#fa-t-date').value = t ? t.dueDate : A.todayStr();
    $('#fa-t-time').value = t && t.dueTime ? t.dueTime : '';
    $('#fa-t-stars').value = String(t ? t.stars : 0);
    $('#fa-t-stars-group').hidden = !me.modules.stars;
    $('#fa-t-remind').checked = t ? t.reminder : true;
    $('#fa-t-delete').hidden = !t;
    $('#fa-t-msg').textContent = '';
    syncRepeat();
    A.openModal('fa-task-modal');
  }
  $('#fa-task-add').addEventListener('click', function () { openTask(null); });
  $('#fa-t-save').addEventListener('click', function () {
    var assignees = $$('#fa-t-people input:checked').map(function (x) { return parseInt(x.value, 10); });
    var body = {
      title: $('#fa-t-name').value.trim(), assignees: assignees, mode: $('#fa-t-mode').value, repeat: $('#fa-t-repeat').value,
      dueDate: $('#fa-t-date').value || A.todayStr(), dueTime: $('#fa-t-time').value || null,
      stars: Math.max(0, Math.min(10, parseInt($('#fa-t-stars').value, 10) || 0)), reminder: $('#fa-t-remind').checked,
    };
    if (body.repeat === 'weekly') {
      body.weekdays = $$('#fa-t-weekdays input:checked').map(function (x) { return parseInt(x.value, 10); });
      if (!body.weekdays.length) { $('#fa-t-msg').textContent = T('portal.weekdays_required'); return; }
    }
    if (!body.title) { $('#fa-t-msg').textContent = T('portal.title_required'); return; }
    if (!assignees.length) { $('#fa-t-msg').textContent = T('portal.assignees_required'); return; }
    var p = editTask ? A.api('PATCH', 'tasks/' + editTask.id, body) : A.api('POST', 'tasks', body);
    p.then(function () { A.closeModal('fa-task-modal'); A.toast(T('common.saved')); return loadTasks(); })
      .catch(function (e) { $('#fa-t-msg').textContent = A.errText(e); });
  });
  $('#fa-t-delete').addEventListener('click', function () {
    var t = editTask;
    if (!t) return;
    A.confirm(T('portal.task_delete_confirm', { title: t.title }), T('common.delete'), true).then(function (ok) {
      if (!ok) return;
      A.api('DELETE', 'tasks/' + t.id).then(function () { A.closeModal('fa-task-modal'); return loadTasks(); }).catch(A.warn);
    });
  });

  // ── dates ────────────────────────────────────────────────────────────────
  function loadDates() {
    var from = A.todayStr();
    var d = new Date(); d.setDate(d.getDate() + 60);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var to = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    return A.api('GET', 'dates?from=' + from + '&to=' + to).then(function (r) {
      var list = A.clear($('#fa-date-list'));
      var events = r.events.filter(function (e) { return e.kind !== 'birthday' && A.daysUntil(e.date) <= 14; }).slice(0, 8);
      events.forEach(function (e) {
        var n = A.daysUntil(e.date);
        var when = n === 0 ? (e.time || T('rel.today')) : (n === 1 ? T('rel.tomorrow') : A.day(e.date, { weekday: 'short', day: '2-digit', month: '2-digit' }));
        var main = e.title + (n !== 0 && e.time ? ' · ' + e.time : '') + (e.time && e.endTime ? '–' + e.endTime : '') + (e.place ? ' · ' + e.place : '');
        var kids = [el('span', { class: 'fa-p-date-main', text: main })];
        // 1.8.0: a date from the family chat (Messenger)
        if (e.origin === 'chat') kids.push(el('span', { class: 'fa-pill fa-p-date-chat', text: T('portal.from_chat') }));
        list.appendChild(el('div', { class: 'fa-p-date' }, [el('span', { class: 'fa-p-date-when', text: when })].concat(kids)));
      });
      if (!events.length) list.appendChild(el('p', { class: 'fa-empty', text: T('portal.dates_none') }));
      var bl = A.clear($('#fa-bday-list'));
      var bdays = r.events.filter(function (e) { return e.kind === 'birthday'; }).slice(0, 6);
      bdays.forEach(function (e) {
        var n = A.daysUntil(e.date);
        var label = n === 0 ? T('rel.today') : (n === 1 ? T('rel.tomorrow') : T('portal.in_days', { n: n }));
        bl.appendChild(el('div', { class: 'fa-p-bday' }, [
          el('b', { text: e.title + (e.years ? ' · ' + e.years : '') }),
          el('span', { class: n <= 7 ? 'fa-pill is-child' : 'fa-sub', text: label }),
        ]));
      });
      if (!bdays.length) bl.appendChild(el('p', { class: 'fa-empty', text: T('portal.birthdays_none') }));
    }).catch(A.warn);
  }

  // ── locate (parents, real login) ─────────────────────────────────────────
  function kidStatus(k, last) {
    if (!k.locatable) return k.locateMode === 'off' ? T('portal.locate_off') : T('members.adult');
    if (pending[k.userId]) {
      var s = Math.max(0, Math.round((new Date(pending[k.userId].expiresAt).getTime() - Date.now()) / 1000));
      return T('portal.waiting', { m: Math.floor(s / 60), s: (s % 60 < 10 ? '0' : '') + (s % 60) });
    }
    if (!last) return T('portal.never');
    if (last.status === 'answered') return T('portal.last_answered', { when: A.when(last.answeredAt) }) + (last.accuracy != null ? ' · ±' + Math.round(last.accuracy) + ' m' : '');
    return A.when(last.createdAt) + ' · ' + T('status.' + last.status, { name: k.name });
  }
  var locateData = [];
  var mapKey = null;
  function renderLocate() {
    var kids = me.members.filter(function (m) { return m.role === 'child'; });
    var box = A.clear($('#fa-kids'));
    if (!kids.length) box.appendChild(el('p', { class: 'fa-empty', text: T('portal.no_kids') }));
    kids.forEach(function (k) {
      var last = locateData.filter(function (x) { return x.childId === k.userId; })[0] || null;
      var btn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: T('portal.locate_now'), disabled: !k.locatable || !!pending[k.userId] });
      btn.addEventListener('click', function () { requestLocate(k, btn); });
      box.appendChild(el('div', { class: 'fa-p-kid' }, [A.avatar(k, 32), el('div', { class: 'fa-p-kid-main' }, [el('b', { text: k.name + (k.age != null ? ' · ' + k.age : '') }), el('span', { text: kidStatus(k, last) })]), btn]));
    });
    var points = [];
    kids.forEach(function (k) {
      var ans = locateData.filter(function (x) { return x.childId === k.userId && x.status === 'answered' && x.lat != null; })[0];
      if (ans) points.push({ lat: ans.lat, lon: ans.lon, accuracy: ans.accuracy, label: k.name, sub: A.when(ans.at || ans.answeredAt), color: k.colorHex });
    });
    // redraw the map only when the positions changed (the countdown re-renders every 3 s)
    var key = JSON.stringify(points);
    if (key !== mapKey) { mapKey = key; A.map.show($('#fa-locate-map'), points); }
    var recent = A.clear($('#fa-locate-recent'));
    var rows = locateData.slice(0, 6);
    if (rows.length) {
      var tb = el('tbody');
      rows.forEach(function (x) {
        var res = x.status === 'answered' && x.lat != null ? A.map.osmLink({ lat: x.lat, lon: x.lon }, '±' + Math.round(x.accuracy || 0) + ' m') : el('span', { class: 'fa-muted', text: T('status.' + x.status, { name: x.childName || '' }) });
        tb.appendChild(el('tr', null, [el('td', { class: 'fa-time', text: A.when(x.createdAt) }), el('td', { text: x.requestedByName || '–' }), el('td', { text: x.childName || '–' }), el('td', null, [res])]));
      });
      recent.appendChild(el('div', { class: 'fa-table-wrap fa-p-recent' }, [el('table', { class: 'fa-table' }, [
        el('thead', null, [el('tr', null, [el('th', { text: T('log.col_time') }), el('th', { text: T('log.col_who') }), el('th', { text: T('log.col_child') }), el('th', { text: T('log.col_result') })])]),
        tb,
      ])]));
    }
  }
  function loadLocate() {
    return A.api('GET', 'locate/requests?limit=30').then(function (r) {
      locateData = r.requests;
      pending = {};
      r.requests.forEach(function (x) { if (x.status === 'pending' && !pending[x.childId]) pending[x.childId] = { id: x.id, expiresAt: x.expiresAt }; });
      renderLocate();
      if (Object.keys(pending).length) schedulePoll();
    }).catch(A.warn);
  }
  var pollTimer = null;
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
      if (!Object.keys(pending).length) return;
      loadLocate();
    }, 3000);
    renderLocate();
  }
  function requestLocate(k, btn) {
    btn.disabled = true;
    A.api('POST', 'locate/' + k.userId).then(function (r) {
      pending[k.userId] = { id: r.request.id, expiresAt: r.request.expiresAt };
      A.toast(T('portal.locate_sent', { name: k.name }));
      return loadLocate();
    }).catch(function (e) {
      var c = A.errCode(e);
      A.toast(c === 'too_soon' ? T('portal.locate_soon') : (c === 'daily_limit' ? T('portal.locate_limit') : A.errText(e)), 'error');
      btn.disabled = false;
    });
  }

  // ── rides (next 7 days) ──────────────────────────────────────────────────
  var ridesData = [];
  function canDrive() { return me.me.role === 'parent' || (me.me.role === 'child' && me.me.age != null && me.me.age >= 18); }
  function rideWho(r) {
    if (r.status === 'cancelled') return T('ride.cancelled');
    if (r.status === 'taken') return r.driver && r.driver.userId === me.me.userId ? T('ride.you_drive') : T('ride.driver', { name: r.driver ? (r.driver.name || r.driver.label) : '–' });
    var parts = [T('ride.open')];
    if (r.declined.length) parts.push(T('ride.declined', { names: r.declined.map(function (d) { return d.name; }).join(', ') }));
    return parts.join(' · ');
  }
  function rideAction(r, action) {
    A.api('POST', 'rides/' + encodeURIComponent(r.id) + '/' + action).then(function (x) {
      A.toast(action === 'ask' ? T('ride.asked', { n: x.notified || 0 }) : T('common.saved'));
      return loadRides();
    }).catch(function (e) {
      var c = A.errCode(e);
      A.toast(c === 'too_soon' ? T('ride.ask_soon') : (c === 'already_taken' ? T('error.already_taken') : A.errText(e)), 'error');
      loadRides();
    });
  }
  function renderRides() {
    var box = A.clear($('#fa-ride-list'));
    if (!ridesData.length) { box.appendChild(el('p', { class: 'fa-empty', text: T('ride.none') })); return; }
    ridesData.forEach(function (r) {
      var n = A.daysUntil(r.date);
      var when = (n === 0 ? T('rel.today') : (n === 1 ? T('rel.tomorrow') : A.day(r.date, { weekday: 'short', day: '2-digit', month: '2-digit' }))) + ' ' + r.time;
      var btns = [];
      if (writable && r.status === 'open') {
        if (canDrive()) btns.push(el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: T('ride.take'), on: { click: function () { rideAction(r, 'take'); } } }));
        if (me.me.role === 'parent' && !r.declined.some(function (d) { return d.userId === me.me.userId; })) btns.push(el('button', { type: 'button', class: 'btn btn-sm', text: T('ride.decline'), on: { click: function () { rideAction(r, 'decline'); } } }));
        btns.push(el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: T('ride.ask'), on: { click: function () { rideAction(r, 'ask'); } } }));
      }
      if (writable && r.status === 'taken' && r.driver && r.driver.userId === me.me.userId) {
        btns.push(el('button', { type: 'button', class: 'btn btn-sm', text: T('ride.release'), on: { click: function () { rideAction(r, 'release'); } } }));
      }
      var kids = r.childIds.map(memberById).filter(Boolean);
      box.appendChild(el('div', { class: 'fa-p-ride is-' + r.status }, [
        el('span', { class: 'fa-p-date-when', text: when }),
        el('div', { class: 'fa-p-ride-main' }, [
          el('div', { class: 'fa-p-task-title', text: r.title }),
          el('div', { class: 'fa-p-task-sub', text: [r.place, kids.map(function (k) { return k.name; }).join(', '), rideWho(r)].filter(Boolean).join(' · ') }),
        ]),
        btns.length ? el('div', { class: 'fa-p-ride-btns' }, btns) : null,
      ]));
    });
  }
  function loadRides() {
    return A.api('GET', 'rides').then(function (r) {
      ridesData = r.rides.filter(function (x) { return x.status !== 'cancelled' || A.daysUntil(x.date) <= 1; });
      renderRides();
    }).catch(A.warn);
  }

  // ── emergency card (parents, signed in) ──────────────────────────────────
  var ICON_PHONE = 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2';
  var BLOOD = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', '0+', '0-', 'unknown'];
  var em = null;
  var emSel = null;
  var emEdit = null;
  function telHref(phone) { return 'tel:' + String(phone).replace(/[^0-9+]/g, ''); }
  function contactRow(c) {
    return el('div', { class: 'fa-p-contact' }, [
      el('div', { class: 'fa-p-contact-main' }, [el('b', { text: c.label }), el('span', { class: 'fa-sub', text: [c.phone, c.note].filter(Boolean).join(' · ') })]),
      el('a', { class: 'btn btn-sm', href: telHref(c.phone), target: '_blank', rel: 'noopener', 'aria-label': T('emergency.call', { name: c.label }) }, [A.svg(ICON_PHONE, 14)]),
    ]);
  }
  function masked(num) {
    var s = String(num || '');
    return s.length > 4 ? s.slice(0, -4).replace(/[^\s]/g, '•') + s.slice(-4) : s;
  }
  function field(label, value) {
    return value ? el('div', { class: 'fa-p-em-field' }, [el('span', { class: 'fa-p-em-label', text: label }), el('span', { class: 'fa-p-em-value', text: value })]) : null;
  }
  function renderEmergency() {
    var chips = A.clear($('#fa-em-chips'));
    em.members.forEach(function (m) {
      var b = el('button', { type: 'button', class: 'btn btn-sm fa-p-chip', role: 'tab', 'aria-selected': m.userId === emSel ? 'true' : 'false', text: m.name });
      b.addEventListener('click', function () { emSel = m.userId; renderEmergency(); });
      chips.appendChild(b);
    });
    var c = em.members.filter(function (m) { return m.userId === emSel; })[0];
    var box = A.clear($('#fa-em-card'));
    if (c) {
      var mem = memberById(c.userId);
      var sub = [];
      if (c.birthdate) sub.push(T('emergency.born', { date: A.dateLong(c.birthdate) }));
      if (c.age != null) sub.push(T('members.years', { n: c.age }));
      if (c.weightKg != null) sub.push(c.weightKg + ' kg');
      box.appendChild(el('div', { class: 'fa-person' }, [A.avatar(mem || c, 36), el('div', null, [el('b', { text: c.name }), el('div', { class: 'fa-sub', text: sub.join(' · ') })])]));
      var ins = null;
      if (c.insurance) {
        var num = el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: masked(c.insurance.number), title: T('emergency.reveal') });
        num.addEventListener('click', function () { num.textContent = c.insurance.number; });
        ins = el('div', { class: 'fa-p-em-field' }, [el('span', { class: 'fa-p-em-label', text: T('emergency.insurance') }), el('span', { class: 'fa-p-em-value' }, [c.insurance.name + ' ', c.insurance.number ? num : null])]);
      }
      var fields = [
        field(T('emergency.allergies'), c.allergies), field(T('emergency.blood'), c.bloodType ? (c.bloodType === 'unknown' ? T('emergency.blood_unknown') : c.bloodType) : ''),
        field(T('emergency.medications'), c.medications), field(T('emergency.conditions'), c.conditions), field(T('emergency.notes'), c.notes), ins,
      ].filter(Boolean);
      box.appendChild(fields.length ? el('div', { class: 'fa-p-em-grid' }, fields) : el('p', { class: 'fa-empty', text: T('emergency.empty') }));
      c.contacts.forEach(function (x) { box.appendChild(contactRow(x)); });
      if (c.updatedAt) box.appendChild(el('p', { class: 'fa-hint', text: T('emergency.updated', { when: A.when(c.updatedAt), name: (c.updatedBy && c.updatedBy.name) || '–' }) }));
      if (writable) box.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('emergency.edit', { name: c.name }), on: { click: function () { openEmergency(c); } } }));
    }
    var fam = A.clear($('#fa-em-family'));
    em.contacts.forEach(function (x) { fam.appendChild(contactRow(x)); });
    if (!em.contacts.length) fam.appendChild(el('p', { class: 'fa-empty', text: T('emergency.family_none') }));
  }
  /** A small editor for a list of { label, phone, note }; returns a getter. */
  function contactsEditor(box, list, max) {
    A.clear(box);
    function addRow(c) {
      if (box.children.length >= max) return;
      var row = el('div', { class: 'fa-p-contact-edit' }, [
        el('input', { class: 'form-input', type: 'text', maxlength: '60', placeholder: T('emergency.label'), 'aria-label': T('emergency.label'), value: (c && c.label) || '' }),
        el('input', { class: 'form-input', type: 'tel', maxlength: '30', placeholder: T('emergency.phone'), 'aria-label': T('emergency.phone'), value: (c && c.phone) || '' }),
        el('input', { class: 'form-input', type: 'text', maxlength: '80', placeholder: T('emergency.note'), 'aria-label': T('emergency.note'), value: (c && c.note) || '' }),
      ]);
      row.appendChild(el('button', { type: 'button', class: 'btn fa-p-x', 'aria-label': T('common.delete'), on: { click: function () { row.remove(); } } }, [A.svg(ICON_X, 14)]));
      box.appendChild(row);
    }
    (list || []).forEach(addRow);
    return {
      add: function () { addRow(null); },
      get: function () {
        return $$('.fa-p-contact-edit', box).map(function (r) {
          var i = r.querySelectorAll('input');
          return { label: i[0].value.trim(), phone: i[1].value.trim(), note: i[2].value.trim() };
        }).filter(function (c) { return c.label || c.phone; });
      },
    };
  }
  var emContacts = null;
  var famContacts = null;
  function openEmergency(c) {
    emEdit = c;
    $('#fa-e-title').textContent = T('emergency.edit', { name: c.name });
    var sel = A.clear($('#fa-e-blood'));
    sel.appendChild(el('option', { value: '', text: '–' }));
    BLOOD.forEach(function (b) { sel.appendChild(el('option', { value: b, text: b === 'unknown' ? T('emergency.blood_unknown') : b })); });
    sel.value = c.bloodType || '';
    $('#fa-e-weight').value = c.weightKg != null ? String(c.weightKg) : '';
    $('#fa-e-allergies').value = c.allergies;
    $('#fa-e-medications').value = c.medications;
    $('#fa-e-conditions').value = c.conditions;
    $('#fa-e-notes').value = c.notes;
    $('#fa-e-ins-name').value = c.insurance ? c.insurance.name : '';
    $('#fa-e-ins-number').value = c.insurance ? c.insurance.number : '';
    emContacts = contactsEditor($('#fa-e-contacts'), c.contacts, 10);
    $('#fa-e-msg').textContent = '';
    A.openModal('fa-em-modal');
  }
  $('#fa-e-contact-add').addEventListener('click', function () { if (emContacts) emContacts.add(); });
  function fieldError(e) {
    var f = e && e.data && e.data.field;
    if (f && /\.phone$/.test(f)) return T('emergency.invalid_phone');
    return f ? T('emergency.invalid_field', { field: f }) : A.errText(e);
  }
  $('#fa-e-save').addEventListener('click', function () {
    if (!emEdit) return;
    var w = $('#fa-e-weight').value.trim();
    var name = $('#fa-e-ins-name').value.trim();
    var number = $('#fa-e-ins-number').value.trim();
    var body = {
      bloodType: $('#fa-e-blood').value || null, weightKg: w ? Number(w.replace(',', '.')) : null,
      allergies: $('#fa-e-allergies').value, medications: $('#fa-e-medications').value, conditions: $('#fa-e-conditions').value, notes: $('#fa-e-notes').value,
      insurance: name || number ? { name: name, number: number } : null, contacts: emContacts.get(),
    };
    A.api('PUT', 'emergency/members/' + emEdit.userId, body).then(function () {
      A.closeModal('fa-em-modal');
      A.toast(T('common.saved'));
      return loadEmergency();
    }).catch(function (e) { $('#fa-e-msg').textContent = fieldError(e); });
  });
  $('#fa-em-family-edit').addEventListener('click', function () {
    famContacts = contactsEditor($('#fa-f-contacts'), em ? em.contacts : [], 20);
    $('#fa-f-msg').textContent = '';
    A.openModal('fa-emf-modal');
  });
  $('#fa-f-contact-add').addEventListener('click', function () { if (famContacts) famContacts.add(); });
  $('#fa-f-save').addEventListener('click', function () {
    A.api('PUT', 'emergency/contacts', { contacts: famContacts.get() }).then(function () {
      A.closeModal('fa-emf-modal');
      A.toast(T('common.saved'));
      return loadEmergency();
    }).catch(function (e) { $('#fa-f-msg').textContent = fieldError(e); });
  });
  function loadEmergency() {
    return A.api('GET', 'emergency').then(function (r) {
      em = r;
      if (!r.members.some(function (m) { return m.userId === emSel; })) emSel = r.members.length ? r.members[0].userId : null;
      renderEmergency();
    }).catch(A.warn);
  }

  // ── start ────────────────────────────────────────────────────────────────
  function start() {
    A.api('GET', 'me').then(function (r) {
      me = r;
      var mod = r.modules;
      $('#fa-p-main').hidden = false;
      if (!writable) banner(T('portal.readonly'));
      $$('.fa-write').forEach(function (n) { if (!writable) n.hidden = true; });
      $('#fa-shop').hidden = !mod.shopping;
      $('#fa-tasks').hidden = !mod.tasks;
      $('#fa-dates').hidden = !mod.dates;
      $('#fa-bdays').hidden = !mod.dates;
      renderSub();
      renderPeople();
      if (mod.shopping) loadShopping();
      if (mod.tasks) loadTasks();
      if (mod.dates) loadDates();
      if (mod.locate && writable && r.me.role === 'parent') { $('#fa-locate').hidden = false; loadLocate(); }
      if (mod.rides) { $('#fa-rides').hidden = false; loadRides(); }
      if (mod.emergency && writable && r.me.role === 'parent') { $('#fa-emergency').hidden = false; loadEmergency(); }
    }).catch(function (e) {
      var c = A.errCode(e);
      banner(c === 'not_member' ? T('portal.not_member') : A.errText(e));
    });
  }
  start();
  setInterval(function () {
    if (!me) return;
    if (me.modules.shopping) loadShopping();
    if (me.modules.tasks) loadTasks();
    if (me.modules.rides) loadRides();
    // the presence ring follows who is home
    if (me.modules.presence) A.api('GET', 'me').then(function (r) { me.members = r.members; me.me = r.me; renderPeople(); }).catch(function () { /* next minute */ });
  }, 60000);
}());
