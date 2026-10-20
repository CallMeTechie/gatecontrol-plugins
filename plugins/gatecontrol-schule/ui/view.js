/* Schule page (admin, page 'main') and portal tab „Schule“ (1.3.0): only the information. One card
   per child (picture or initials in the child's colour) — choosing one shows its week (this / next,
   on a phone one day at a time), the coming changes, exams and homework. Without an account (or
   without children switched on) a clear pointer to the settings. Accounts, children and
   diagnostics live in the settings (page 'setup').
   1.4.0: per child „Nachrichten“ (its account's inbox — only when the viewer may read it; a message
   opens in place to read its text) and „Fehlzeiten“ (date / time, excused / not excused / open, reason)
   — each section only when the API sends it. */
(function () {
  'use strict';
  var S = window.SC, T = S.T, $ = S.$, $$ = S.$$, el = S.el;
  var portal = S.CTX.view === 'portal';
  var base = portal ? 'portal/overview' : 'overview';
  var st = { week: 0, current: null, day: null, data: null, failed: false, open: {} };

  function subjName(x, max) { return (x.subjectLong && x.subjectLong.length <= (max || 18) ? x.subjectLong : x.subject) || x.name || x.text || '–'; }
  function pair(now, old) {
    if (!old) return [el('span', { text: now || '' })];
    return [el('span', { class: 'ls-old', text: old }), el('span', { class: 'ls-new', text: now || '–' })];
  }

  function lesson(l) {
    var p = l.period != null ? String(l.period) + (l.periodEnd ? '–' + l.periodEnd : '') : '';
    var sub = el('div', { class: 'ls-sub' }, [el('span', { text: l.start + '–' + l.end + (l.teacher || l.teacherOld ? ' · ' : '') })]);
    if (l.teacher || l.teacherOld) pair(l.teacher, l.teacherOld).forEach(function (n) { sub.appendChild(n); });
    if (l.room || l.roomOld) { sub.appendChild(el('span', { text: ' · ' })); pair(l.room, l.roomOld).forEach(function (n) { sub.appendChild(n); }); }
    var subj = el('div', { class: 'ls-subj', title: l.subjectLong || null });
    if (l.subjectOld) pair(l.subject, l.subjectOld).forEach(function (n) { subj.appendChild(n); });
    else subj.textContent = subjName(l, 18);
    var notes = [];
    if (l.state === 'cancelled') notes.push(T('portal.cancelled'));
    if (l.state === 'extra') notes.push(T('portal.extra'));
    if (l.substText) notes.push(l.substText);
    if (l.info) notes.push(l.info);
    return el('div', { class: 'ls is-' + l.state }, [
      el('span', { class: 'ls-p', text: p }),
      el('div', { class: 'ls-main' }, [subj, sub, notes.length ? el('div', { class: 'ls-note', text: notes.join(' · ') }) : null]),
    ]);
  }

  function examBadge(x) {
    return el('div', { class: 'ex', title: [x.name, x.type, x.text].filter(Boolean).join(' · ') || null }, [
      el('span', { text: T('portal.exam') + ' · ' + subjName(x, 16) + (x.start ? ' · ' + x.start : '') }),
      x.name ? el('span', { text: x.name }) : null,
    ]);
  }

  function homeworkBox(list) {
    return el('div', { class: 'hw' }, [el('div', { class: 'hw-h', text: T('portal.homework') })].concat(list.map(function (h) {
      return el('div', { class: 'hw-row' + (h.completed ? ' is-done' : '') }, [el('b', { text: subjName(h, 16) }), el('span', { text: h.text || '–' })]);
    })));
  }

  /** Today of a child within the loaded week (null when today is not in it). */
  function todayOf(s) { return s.days.filter(function (d) { return d.date === st.data.today; })[0] || null; }

  function todayText(s) {
    var d = st.week === 0 ? todayOf(s) : null;
    if (!d) return s.klasse ? T('view.class', { klasse: s.klasse }) : '';
    var on = d.lessons.filter(function (l) { return l.state !== 'cancelled'; });
    var head = s.klasse ? T('view.class', { klasse: s.klasse }) + ' · ' : '';
    if (d.holiday && !d.lessons.length) return head + T('portal.holiday', { name: d.holiday });
    if (!on.length) return head + T('view.today_free');
    var a = on.reduce(function (m, l) { return l.start < m ? l.start : m; }, on[0].start);
    var b = on.reduce(function (m, l) { return l.end > m ? l.end : m; }, on[0].end);
    return head + T('view.today_span', { from: a, to: b });
  }

  function kidCard(s, many) {
    var flags = [];
    var cancelled = s.changes.filter(function (c) { return c.state === 'cancelled'; }).length;
    var other = s.changes.length - cancelled;
    if (cancelled) flags.push(el('span', { class: 'pill', 'data-tone': 'crit', text: cancelled === 1 ? T('tile.one_cancelled') : T('tile.cancelled', { n: cancelled }) }));
    if (other) flags.push(el('span', { class: 'pill', 'data-tone': 'warn', text: other === 1 ? T('tile.one_changed') : T('tile.changed', { n: other }) }));
    var news = (s.messages || []).filter(function (m) { return m.isNew; }).length;
    if (news) flags.push(el('span', { class: 'pill', 'data-tone': 'info', text: news === 1 ? T('tile.one_message') : T('tile.messages', { n: news }) }));
    var exam = s.exams[0];
    if (exam) flags.push(el('span', { class: 'pill', 'data-tone': 'info', text: T('view.exam_on', { subject: subjName(exam, 14), day: S.weekday(exam.date) }) }));
    var on = s.id === st.current;
    return el(many ? 'button' : 'div', {
      type: many ? 'button' : null, class: 'kid', role: many ? 'tab' : null, 'aria-selected': many ? String(on) : null,
      style: { '--kid': s.color }, on: many ? { click: function () { st.current = s.id; st.day = null; render(); } } : null,
    }, [
      S.avatar({ color: s.color, avatarUrl: s.avatarUrl, initials: s.initials }, 'av-lg'),
      el('span', { class: 'kid-main' }, [
        el('span', { class: 'kid-name', text: s.name }),
        el('span', { class: 'kid-sub', text: todayText(s) || ' ' }),
        flags.length ? el('span', { class: 'kid-flags' }, flags) : null,
      ]),
    ]);
  }

  function empty(kind) {
    var box = $('#sv-empty');
    box.hidden = !kind;
    if (!kind) return;
    S.clear($('#sv-empty-ic')).appendChild(S.svg(kind === 'error' ? S.ICON.x : S.ICON.school, 26));
    $('#sv-empty-title').textContent = T('view.empty_' + kind + '_title');
    $('#sv-empty-text').textContent = T('view.empty_' + kind + '_text');
    $('#sv-empty-go').hidden = portal || kind === 'error';
  }

  function render() {
    var r = st.data;
    var kids = S.clear($('#sv-kids'));
    if (!r) { $('#sv-child').hidden = true; empty(st.failed ? 'error' : null); return; }
    var list = r.students || [];
    var alert = !portal && r.accountErrors > 0;
    $('#sv-alert').hidden = !alert;
    if (alert) $('#sv-alert-text').textContent = r.accountErrors === 1 ? T('view.account_error_one') : T('view.account_errors', { n: r.accountErrors });
    if (!list.length) {
      $('#sv-child').hidden = true;
      empty(portal ? 'portal' : (r.configured ? 'nokids' : 'none'));
      return;
    }
    empty(null);
    if (!list.some(function (s) { return s.id === st.current; })) st.current = list[0].id;
    list.forEach(function (s) { kids.appendChild(kidCard(s, list.length > 1)); });
    var s = list.filter(function (x) { return x.id === st.current; })[0];
    renderChild(s);
  }

  function renderChild(s) {
    var r = st.data;
    var box = $('#sv-child');
    box.hidden = false;
    box.style.setProperty('--kid', s.color);
    var title = S.clear($('#sv-title'));
    title.appendChild(el('span', { text: T('view.week_of', { from: S.dayNum(r.from), to: S.dayNum(r.to) }) }));
    title.appendChild(el('small', { text: s.updatedAt ? T('portal.updated', { when: S.when(s.updatedAt) }) : T('portal.not_yet') }));
    // Saturday only when it has something
    var days = s.days.filter(function (d, i) { return i < 5 || d.lessons.length || (d.exams && d.exams.length) || (d.homework && d.homework.length); });
    if (!days.some(function (d) { return d.date === st.day; })) st.day = (days.filter(function (d) { return d.date === r.today; })[0] || days[0]).date;
    var pick = S.clear($('#sv-daypick'));
    var grid = S.clear($('#sv-week'));
    grid.style.setProperty('--days', String(days.length));
    days.forEach(function (d) {
      var special = d.lessons.some(function (l) { return l.state !== 'normal'; });
      pick.appendChild(el('button', {
        type: 'button', role: 'tab', class: 'day-chip' + (d.date === r.today ? ' is-today' : ''), 'aria-selected': String(d.date === st.day),
        on: { click: function () { st.day = d.date; renderChild(s); } },
      }, [el('span', { text: S.weekday(d.date) }), el('small', { text: S.dayNum(d.date) }), special ? el('span', { class: 'dot', 'aria-hidden': 'true' }) : null]));
      var col = el('div', { class: 'sv-day' + (d.date === r.today ? ' is-today' : '') + (d.date === st.day ? ' is-picked' : '') }, [
        el('div', { class: 'sv-dayh' }, [el('span', { text: (d.date === r.today ? T('portal.today') : S.weekday(d.date, true)) }), el('small', { text: S.dayNum(d.date) })]),
      ]);
      (d.exams || []).forEach(function (x) { col.appendChild(examBadge(x)); });
      if (d.holiday && !d.lessons.length) col.appendChild(el('div', { class: 'sv-free', text: T('portal.holiday', { name: d.holiday }) }));
      else if (!d.lessons.length) col.appendChild(el('div', { class: 'sv-free', text: T('portal.no_lessons') }));
      d.lessons.forEach(function (l) { col.appendChild(lesson(l)); });
      if (d.homework && d.homework.length) col.appendChild(homeworkBox(d.homework));
      grid.appendChild(col);
    });
    fill('#sv-changes', s.changes, 'view.no_changes', function (c) {
      var what = c.state === 'cancelled' ? T('view.chg_cancelled') : (c.state === 'extra' ? T('view.chg_extra') : T('view.chg_changed'));
      var facts = [];
      if (c.subjectOld) facts.push(T('fact.instead', { now: c.subject || '–', old: c.subjectOld }));
      if (c.teacherOld) facts.push(T('fact.teacher', { now: c.teacher || '–', old: c.teacherOld }));
      if (c.roomOld) facts.push(T('fact.room', { now: c.room || '–', old: c.roomOld }));
      if (c.substText) facts.push(c.substText);
      return item('is-' + c.state, S.dayLabel(c.date), subjName(c, 22) + ' · ' + what, [(c.period != null ? T('period', { n: c.period }) + ' · ' : '') + c.start + '–' + c.end].concat(facts).join(' · '));
    });
    fill('#sv-exams', s.exams, 'view.no_exams', function (x) {
      return item('', S.dayLabel(x.date), subjName(x, 22) + (x.name ? ' · ' + x.name : ''), [x.start ? x.start + (x.end ? '–' + x.end : '') : '', x.type, x.text].filter(Boolean).join(' · '));
    });
    fill('#sv-hw', s.homework, 'view.no_homework', function (h) {
      return item(h.completed ? 'is-done' : '', S.dayLabel(h.date), subjName(h, 22), (h.text || '') + (h.completed ? ' · ' + T('portal.hw_done') : ''));
    });
    renderSchool(s);
  }

  // ── 1.4.0: messages and absences ───────────────────────────────────────
  function localDay(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function messageItem(m) {
    var key = m.id;
    var open = !!st.open[key];
    var bodyBox = el('div', { class: 'msg-body', hidden: !open }, [
      el('div', { class: 'msg-from', text: m.sender ? T('view.msg_from', { sender: m.sender }) + ' · ' + S.when(Date.parse(m.sentAt)) : S.when(Date.parse(m.sentAt)) }),
      el('div', { class: 'msg-text', text: m.body || m.preview || '' }),
      !m.body ? el('div', { class: 'msg-note', text: T('view.msg_preview_only') }) : null,
      m.hasAttachments ? el('div', { class: 'msg-note', text: T('view.msg_attach') }) : null,
    ]);
    var head = el('button', {
      type: 'button', class: 'msg-head', 'aria-expanded': String(open),
      on: { click: function () { st.open[key] = !st.open[key]; bodyBox.hidden = !st.open[key]; head.setAttribute('aria-expanded', String(!!st.open[key])); } },
    }, [
      el('span', { class: 'sv-when', text: S.dayLabel(localDay(m.sentAt)) }),
      el('span', { class: 'sv-what' }, [
        el('b', {}, [m.isNew ? el('span', { class: 'pill no-dot msg-new', 'data-tone': 'info', text: T('view.msg_new') }) : null, document.createTextNode(m.subject || '–')]),
        el('small', { text: [m.sender, m.preview].filter(Boolean).join(' · ') }),
      ]),
    ]);
    return el('li', { class: 'sv-item msg' + (m.isNew ? ' is-new' : '') }, [head, bodyBox]);
  }

  function absenceItem(a) {
    var tone = a.excused === true ? 'good' : (a.excused === false ? 'crit' : 'warn');
    var word = a.excused === true ? T('view.abs_excused') : (a.excused === false ? T('view.abs_unexcused') : T('view.abs_open'));
    var when = S.dayLabel(a.date) + (a.endDate ? ' – ' + S.dayLabel(a.endDate) : '');
    var time = a.start ? a.start + (a.end ? '–' + a.end : '') : T('view.abs_whole_day');
    return el('li', { class: 'sv-item abs' }, [
      el('span', { class: 'sv-when', text: when }),
      el('span', { class: 'sv-what' }, [
        el('b', { text: time }),
        (a.reason || a.text) ? el('small', { text: [a.reason, a.text].filter(Boolean).join(' · ') }) : null,
      ]),
      el('span', { class: 'pill', 'data-tone': tone, text: word }),
    ]);
  }

  function renderSchool(s) {
    var hasMsg = Array.isArray(s.messages);
    var hasAbs = Array.isArray(s.absences);
    $('#sv-msg-box').hidden = !hasMsg;
    $('#sv-abs-box').hidden = !hasAbs;
    $('#sv-school').hidden = !hasMsg && !hasAbs;
    if (hasMsg) fill('#sv-msgs', s.messages, 'view.no_messages', messageItem);
    if (hasAbs) {
      var open = s.absences.filter(function (a) { return a.excused == null; }).length;
      $('#sv-abs-sum').textContent = s.absences.length ? T('view.abs_sum', { n: s.absences.length, open: open }) : '';
      fill('#sv-abs', s.absences, 'view.no_absences', absenceItem);
    }
  }

  function item(cls, whenText, title, sub) {
    return el('li', { class: 'sv-item ' + cls }, [
      el('span', { class: 'sv-when', text: whenText }),
      el('span', { class: 'sv-what' }, [el('b', { text: title }), sub ? el('small', { text: sub }) : null]),
    ]);
  }
  function fill(sel, list, none, fn) {
    var ul = S.clear($(sel));
    if (!list.length) { ul.appendChild(el('li', { class: 'sv-none', text: T(none) })); return; }
    list.forEach(function (x) { ul.appendChild(fn(x)); });
  }

  function load() {
    S.api('GET', base + '?week=' + st.week).then(function (r) { st.data = r; st.failed = false; render(); })
      .catch(function () { st.failed = true; if (!st.data) render(); });
  }

  $$('.sv-weeks .seg-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      st.week = Number(b.getAttribute('data-week')) || 0;
      st.day = null;
      $$('.sv-weeks .seg-btn').forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); });
      load();
    });
  });
  $('#sv-empty-go').addEventListener('click', S.openSettings);
  $('#sv-alert-go').addEventListener('click', S.openSettings);
  load();
  setInterval(load, 5 * 60 * 1000);
}());
