/* Wall tablet (portal tab of a member with the role 'wall'): clock and date,
   the family, "Heute" (dates today/tomorrow, today's rides, birthdays within
   7 days), today's tasks with a chip per person (tap = done for that person)
   and the open items of one shopping list (tap = bought, field = add).
   GET wall every 60 s; dark from 21:00 to 06:00 (server's local time); a
   small pixel shift every few minutes against burn-in. A paired kiosk
   device or a portal login writes; device trust only (no login): read-only. */
(function () {
  'use strict';
  var A = window.FA, T = A.T, $ = A.$, el = A.el, CTX = A.CTX;
  var LOCALE = CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  var ICON_CAKE = 'M3 21h18M5 21v-8h14v8M12 13V9M9 6c0-1 1-2 3-3 2 1 3 2 3 3a3 3 0 0 1-6 0z';
  var ICON_CAR = 'M5 17h14v-5l-2-5H7l-2 5zM5 12h14M7 17v2M17 17v2';
  var ICON_CHECK = 'M5 12l5 5 9-10';
  var REFRESH_MS = 60000;
  var SHIFT_MS = 4 * 60000;
  var MAX_TODAY = 6;
  var MAX_TASKS = 5;
  var MAX_ITEMS = 18;

  var writable = CTX.loggedIn === true;
  var data = null;
  var offset = 0;     // server clock − browser clock (ms)
  var busy = false;

  function banner(text) { var b = $('#fa-w-banner'); b.textContent = text || ''; b.hidden = !text; }

  function fmt(d, opts) {
    try { return d.toLocaleString(LOCALE, Object.assign({ timeZone: data && data.timezone }, opts)); } catch (_) { return d.toLocaleString(LOCALE, opts); }
  }

  /** Clock in the server's time zone; dark between 21:00 and 06:00 there. */
  function tickClock() {
    if (!data) return;
    var now = new Date(Date.now() + offset);
    $('#fa-w-time').textContent = fmt(now, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    $('#fa-w-date').textContent = fmt(now, { weekday: 'long', day: 'numeric', month: 'long' });
    var hh = parseInt(fmt(now, { hour: '2-digit', hourCycle: 'h23' }), 10);
    if (!isNaN(hh)) $('#fa-wall').classList.toggle('is-dark', hh >= 21 || hh < 6);
  }

  function dot(m) {
    var d = el('span', { class: 'fa-w-dot', text: A.initials(m.name), 'aria-hidden': 'true' });
    d.style.setProperty('--c', A.safeColor(m.color, '#0B7A55'));
    return d;
  }

  function renderPeople() {
    var box = A.clear($('#fa-w-people'));
    data.members.slice(0, 6).forEach(function (m) {
      var a = el('span', { class: 'fa-w-avatar', text: A.initials(m.name), 'aria-hidden': 'true' });
      a.style.setProperty('--c', A.safeColor(m.color, '#0B7A55'));
      box.appendChild(el('div', { class: 'fa-w-person' }, [a, el('span', { text: m.name })]));
    });
  }

  function row(when, main, sub) {
    return el('div', { class: 'fa-w-row' }, [
      el('span', { class: 'fa-w-row-when', text: when }),
      el('span', { class: 'fa-w-row-main' }, [main, sub ? el('span', { class: 'fa-w-row-sub', text: sub }) : null]),
    ]);
  }

  function rideSub(r) {
    var who = r.status === 'taken' && r.driver ? (r.driver.name || r.driver.label) : T('wall.ride_open');
    return [r.place, who].filter(Boolean).join(' · ');
  }

  function renderToday() {
    var t = data.today;
    $('#fa-w-today').hidden = !t;
    if (!t) return;
    var box = A.clear($('#fa-w-today-list'));
    // today's dates and rides by time (all-day first), then tomorrow
    var today = [];
    t.dates.forEach(function (e) { today.push([e.allDay || !e.time ? '' : e.time, row(e.allDay || !e.time ? T('wall.allday') : e.time, e.title)]); });
    t.rides.forEach(function (r) { today.push([r.time, row(r.time, r.title, rideSub(r))]); });
    today.sort(function (a, b) { return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0); });
    var rows = today.map(function (x) { return x[1]; });
    t.tomorrow.forEach(function (e) { rows.push(row(T('rel.tomorrow'), e.title, e.allDay || !e.time ? '' : e.time)); });
    rows.slice(0, MAX_TODAY).forEach(function (n) { box.appendChild(n); });
    if (rows.length > MAX_TODAY) box.appendChild(el('span', { class: 'fa-w-more', text: T('wall.more', { n: rows.length - MAX_TODAY }) }));
    if (!rows.length) box.appendChild(el('p', { class: 'fa-w-empty', text: T('wall.today_none') }));
    var open = t.rides.filter(function (r) { return r.status === 'open'; }).length;
    if (open) box.appendChild(el('div', { class: 'fa-w-note is-warm' }, [A.svg(ICON_CAR, 20), ' ', T(open === 1 ? 'wall.rides_open_1' : 'wall.rides_open', { n: open })]));
    var b = t.birthdays[0];
    if (b) {
      var when = b.inDays === 0 ? T('rel.today') : (b.inDays === 1 ? T('rel.tomorrow') : T('portal.in_days', { n: b.inDays }));
      var text = b.years ? T('wall.birthday_age', { name: b.title, age: b.years, when: when }) : T('wall.birthday', { name: b.title, when: when });
      box.appendChild(el('div', { class: 'fa-w-note' }, [A.svg(ICON_CAKE, 20), ' ', text]));
    }
  }

  function done(task, chip, btn) {
    if (!writable || busy) return;
    busy = true;
    btn.disabled = true;
    A.api('POST', 'tasks/' + task.id + '/done', { userId: chip.userId }).then(function (r) {
      A.toast(r.starsBooked ? T('portal.done_stars', { n: r.starsBooked }) : T('portal.done'));
    }).catch(A.warn).then(function () { busy = false; load(); });
  }

  function renderTasks() {
    var list = data.tasks;
    $('#fa-w-tasks').hidden = !list;
    if (!list) return;
    var box = A.clear($('#fa-w-task-list'));
    list.slice(0, MAX_TASKS).forEach(function (t) {
      var sub = [t.chips.map(function (c) { return c.name; }).join(', ')];
      if (t.overdue) sub.push(T('portal.overdue'));
      else if (t.dueTime) sub.push(t.dueTime);
      if (t.mode !== 'fixed') sub.push(T('task.mode_' + t.mode + '_short'));
      if (t.stars) sub.push(t.stars + ' ★');
      var chips = el('div', { class: 'fa-w-task-chips' });
      t.chips.forEach(function (c) {
        var pressed = !!c.done;
        var b = el('button', { type: 'button', class: 'fa-w-chip', 'aria-pressed': pressed ? 'true' : 'false', disabled: !writable || pressed || (t.done && t.mode !== 'fixed'),
          'aria-label': T('wall.done_for', { title: t.title, name: c.name }), title: c.name }, [pressed ? el('span', { class: 'fa-w-dot' }, [A.svg(ICON_CHECK, 22)]) : dot(c)]);
        b.addEventListener('click', function () { done(t, c, b); });
        chips.appendChild(b);
      });
      box.appendChild(el('div', { class: 'fa-w-task' + (t.done ? ' is-done' : '') }, [
        el('div', { class: 'fa-w-task-main' }, [el('div', { class: 'fa-w-task-title', text: t.title }), el('div', { class: 'fa-w-task-sub', text: sub.filter(Boolean).join(' · ') })]),
        chips,
      ]));
    });
    if (list.length > MAX_TASKS) box.appendChild(el('span', { class: 'fa-w-more', text: T('wall.more', { n: list.length - MAX_TASKS }) }));
    if (!list.length) box.appendChild(el('p', { class: 'fa-w-empty', text: T('wall.tasks_none') }));
  }

  function ops(list) {
    busy = true;
    return A.api('POST', 'shopping/ops', { ops: list }).then(function (r) {
      if (r.rejected && r.rejected.length) A.toast(T('portal.op_rejected'), 'error');
    }).catch(A.warn).then(function () { busy = false; load(); });
  }

  function renderShopping() {
    var s = data.shopping;
    $('#fa-w-shop').hidden = !s;
    if (!s) return;
    $('#fa-w-shop-h').textContent = s.list ? s.list.name : T('wall.shopping');
    $('#fa-w-shop-open').textContent = s.list ? T('wall.open', { n: s.open }) : '';
    var box = A.clear($('#fa-w-items'));
    s.items.slice(0, MAX_ITEMS).forEach(function (i) {
      var b = el('button', { type: 'button', class: 'fa-w-item', text: i.qty ? i.text + ' ' + i.qty : i.text, disabled: !writable, 'aria-label': T('wall.bought', { name: i.text }) });
      b.addEventListener('click', function () { if (!busy) { b.disabled = true; ops([{ op: 'item_check', id: i.id, checked: true }]); } });
      box.appendChild(b);
    });
    if (s.items.length > MAX_ITEMS) box.appendChild(el('span', { class: 'fa-w-more', text: T('wall.more', { n: s.items.length - MAX_ITEMS }) }));
    if (!s.list) box.appendChild(el('p', { class: 'fa-w-empty', text: T('portal.lists_none') }));
    else if (!s.items.length) box.appendChild(el('p', { class: 'fa-w-empty', text: T('portal.items_none') }));
    $('#fa-w-add').hidden = !writable || !s.list;
  }

  $('#fa-w-add').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('#fa-w-add-text');
    var text = input.value.trim();
    if (!text || !data || !data.shopping || !data.shopping.list || busy) return;
    input.value = '';
    ops([{ op: 'item_add', id: A.uuid(), listId: data.shopping.list.id, text: text.slice(0, 120) }]);
  });

  function render() {
    renderPeople();
    renderToday();
    renderTasks();
    renderShopping();
    tickClock();
  }

  function load() {
    return A.api('GET', 'wall').then(function (r) {
      data = r;
      offset = new Date(r.now).getTime() - Date.now();
      if (!isFinite(offset) || Math.abs(offset) < 30000) offset = 0;
      banner(writable ? '' : T('wall.readonly'));
      render();
    }).catch(function (e) {
      var c = A.errCode(e);
      banner(c === 'module_off' ? T('wall.off') : (c === 'not_member' ? T('portal.not_member') : A.errText(e)));
    });
  }

  /** A few pixels every few minutes against burn-in. */
  function shift() {
    var dx = Math.round(Math.random() * 8) - 4;
    var dy = Math.round(Math.random() * 6) - 3;
    $('#fa-w-shift').style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  }

  load();
  setInterval(function () { if (!busy) load(); }, REFRESH_MS);
  setInterval(tickClock, 10000);
  setInterval(shift, SHIFT_MS);
}());
