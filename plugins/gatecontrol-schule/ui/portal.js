/* Portal tab "Schule": the week of the students this viewer may see (this / next week),
   cancelled lessons struck through in red, substitutions in orange with the original teacher /
   room crossed out, extra lessons highlighted, info and substitution texts below.
   1.2.0: an exam badge at the top of the day, the homework due that day below its lessons. */
(function () {
  'use strict';
  var S = window.SC, T = S.T, $ = S.$, $$ = S.$$, el = S.el;
  var week = 0;
  var current = null;   // selected student id
  var last = null;      // last answer

  function empty(text) { var e = $('#pt-sc-empty'); e.textContent = text; e.hidden = !text; }

  function changedPair(now, old) {
    if (!old) return [el('span', { text: now || '' })];
    return [el('span', { class: 'pt-sc-old', text: old }), el('span', { class: 'pt-sc-new', text: now || '–' })];
  }

  function lesson(l) {
    var p = l.period != null ? String(l.period) + (l.periodEnd ? '–' + l.periodEnd : '') + '.' : l.start;
    var sub = el('div', { class: 'pt-sc-sub' });
    sub.appendChild(el('span', { text: l.start + '–' + l.end + ' · ' }));
    changedPair(l.teacher, l.teacherOld).forEach(function (n) { sub.appendChild(n); });
    if (l.room || l.roomOld) {
      sub.appendChild(el('span', { text: ' · ' }));
      changedPair(l.room, l.roomOld).forEach(function (n) { sub.appendChild(n); });
    }
    var subj = el('div', { class: 'pt-sc-subj', title: l.subjectLong || '' });
    if (l.subjectOld) changedPair(l.subject, l.subjectOld).forEach(function (n) { subj.appendChild(n); });
    else subj.textContent = (l.subjectLong && l.subjectLong.length <= 16 ? l.subjectLong : l.subject) || l.text || '–';
    var notes = [];
    if (l.state === 'cancelled') notes.push(T('portal.cancelled'));
    if (l.state === 'extra') notes.push(T('portal.extra'));
    if (l.substText) notes.push(l.substText);
    if (l.info) notes.push(l.info);
    return el('div', { class: 'pt-sc-l is-' + l.state }, [
      el('span', { class: 'pt-sc-p', text: p }),
      el('div', { class: 'pt-sc-main' }, [subj, sub, notes.length ? el('div', { class: 'pt-sc-note', text: notes.join(' · ') }) : null]),
    ]);
  }

  function subjName(x) { return (x.subjectLong && x.subjectLong.length <= 16 ? x.subjectLong : x.subject) || '–'; }

  /** 1.2.0: "Arbeit · Mathe 09:50" */
  function examBadge(x) {
    var text = T('portal.exam') + ' · ' + subjName(x) + (x.start ? ' ' + x.start : '');
    return el('div', { class: 'pt-sc-exam', title: [x.name, x.type, x.text].filter(Boolean).join(' · ') }, [el('span', { text: text }), x.name ? el('span', { class: 'pt-sc-exam-name', text: x.name }) : null]);
  }

  /** 1.2.0: the homework due that day */
  function homeworkBox(list) {
    var box = el('div', { class: 'pt-sc-hw' }, [el('div', { class: 'pt-sc-hw-h', text: T('portal.homework') })]);
    list.forEach(function (h) {
      box.appendChild(el('div', { class: 'pt-sc-hw-row' + (h.completed ? ' is-done' : ''), title: h.givenDate ? T('portal.given', { date: S.dayLabel(h.givenDate) }) : '' }, [
        el('span', { class: 'pt-sc-hw-subj', text: subjName(h) }),
        el('span', { text: (h.text || '–') + (h.completed ? ' (' + T('portal.hw_done') + ')' : '') }),
      ]));
    });
    return box;
  }

  function renderStudentTabs(list) {
    var box = S.clear($('#pt-sc-students'));
    box.hidden = list.length < 2;
    list.forEach(function (s) {
      box.appendChild(el('button', { type: 'button', class: 'sc-seg-btn' + (s.id === current ? ' active' : ''), text: s.name, on: { click: function () { current = s.id; render(); } } }));
    });
  }

  function render() {
    var r = last;
    var grid = S.clear($('#pt-sc-week'));
    var list = (r && r.students) || [];
    if (!list.length) { renderStudentTabs([]); $('#pt-sc-head').textContent = ''; empty(T('portal.none')); return; }
    if (!list.some(function (s) { return s.id === current; })) current = list[0].id;
    renderStudentTabs(list);
    var s = list.filter(function (x) { return x.id === current; })[0];
    $('#pt-sc-head').textContent = [s.name, s.klasse, s.updatedAt ? T('portal.updated', { when: S.when(s.updatedAt) }) : T('portal.not_yet')].filter(Boolean).join(' · ');
    // Saturday only when it has lessons (or an exam / homework)
    var days = s.days.filter(function (d, i) { return i < 5 || d.lessons.length || (d.exams && d.exams.length) || (d.homework && d.homework.length); });
    grid.style.setProperty('--days', String(days.length));
    days.forEach(function (d) {
      var col = el('div', { class: 'pt-sc-day' + (d.date === r.today ? ' is-today' : '') }, [el('div', { class: 'pt-sc-dayh', text: (d.date === r.today ? T('portal.today') + ' · ' : '') + S.dayLabel(d.date) })]);
      (d.exams || []).forEach(function (x) { col.appendChild(examBadge(x)); });
      if (d.holiday && !d.lessons.length) col.appendChild(el('div', { class: 'pt-sc-holiday', text: T('portal.holiday', { name: d.holiday }) }));
      else if (!d.lessons.length) col.appendChild(el('div', { class: 'pt-sc-free', text: T('portal.no_lessons') }));
      d.lessons.forEach(function (l) { col.appendChild(lesson(l)); });
      if (d.homework && d.homework.length) col.appendChild(homeworkBox(d.homework));
      grid.appendChild(col);
    });
    empty('');
  }

  function load() {
    S.api('GET', 'portal/timetable?week=' + week).then(function (r) { last = r; render(); }).catch(function () { empty(T('portal.error')); });
  }

  $$('.pt-sc-weeks .sc-seg-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      week = Number(b.getAttribute('data-week')) || 0;
      $$('.pt-sc-weeks .sc-seg-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
      load();
    });
  });
  load();
  setInterval(load, 5 * 60 * 1000);
}());
