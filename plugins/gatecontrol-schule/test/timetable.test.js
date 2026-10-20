'use strict';

// Parsing WebUntis lessons (server/timetable.js): cancelled, teacher / room / subject
// substitutions with orgname, irregular lessons, substitution texts, periods from the
// timegrid (double lessons), events without a subject, duplicate slots, holidays.

const test = require('node:test');
const assert = require('node:assert/strict');
const tt = require('../server/timetable');
const { fixture } = require('./helpers');

const grid = tt.compactTimegrid(fixture('timegrid.json').result);
const rows = tt.normalize(fixture('timetable_special.json').result, grid, { from: '2026-10-19', to: '2026-11-01' });
const at = (date, start) => rows.filter((r) => r.date === date && r.t_start === start);

test('timegrid: units per weekday, periods by start (and end for double lessons)', () => {
  assert.equal(grid.length, 5);
  assert.deepEqual(grid[0].units[2], { name: '3', start: '09:50', end: '10:35' });
  assert.deepEqual(tt.periodOf(grid, '2026-10-20', '09:50', '10:35'), { period: 3, periodEnd: null });
  assert.deepEqual(tt.periodOf(grid, '2026-10-21', '10:40', '12:25'), { period: 4, periodEnd: 5 });
  assert.deepEqual(tt.periodOf(grid, '2026-10-25', '08:00', '08:45'), { period: null, periodEnd: null }, 'Sunday has no grid');
  assert.deepEqual(tt.periodOf(grid, '2026-10-20', '07:15', '07:55'), { period: null, periodEnd: null }, 'not in the grid');
  assert.deepEqual(tt.periodOf([], '2026-10-20', '08:00', '08:45'), { period: null, periodEnd: null });
});

test('a normal lesson', () => {
  const [m] = at('2026-10-20', '08:00');
  assert.deepEqual({ ...m }, {
    lkey: '2026-10-20|08:00|1', date: '2026-10-20', t_start: '08:00', t_end: '08:45', period: 1, period_end: null,
    subject: 'M', subject_long: 'Mathematik', subject_old: null, teacher: 'MUE', teacher_old: null, room: '101', room_old: null, klasse: '5a',
    state: 'normal', info: null, subst_text: null, lstext: null,
  });
});

test('cancelled: code cancelled, with its text', () => {
  const [d] = at('2026-10-20', '08:50');
  assert.deepEqual([d.state, d.subject, d.subst_text, d.period], ['cancelled', 'D', 'Lehrkraft erkrankt', 2]);
  assert.equal(tt.shownState(d), 'cancelled');
});

test('substitution: another teacher (orgname), code irregular, substitution text', () => {
  const [e] = at('2026-10-20', '09:50');
  assert.deepEqual([e.state, e.teacher, e.teacher_old, e.subst_text], ['changed', 'SCH', 'WEB', 'Vertretung']);
  assert.equal(tt.shownState(e), 'changed');
});

test('room change without a code: orgname of the room', () => {
  const [b] = at('2026-10-20', '10:40');
  assert.deepEqual([b.state, b.room, b.room_old, b.teacher_old], ['changed', '104', '201', null]);
});

test('subject change: the key keeps the original subject, the old name is kept', () => {
  const [mu] = at('2026-10-20', '11:40');
  assert.deepEqual([mu.state, mu.subject, mu.subject_old, mu.info, mu.lkey], ['changed', 'MU', 'GE', 'Probe für das Konzert', '2026-10-20|11:40|7']);
});

test('double lesson, event without subject (lstext), duplicate slot', () => {
  const [sp] = at('2026-10-21', '10:40');
  assert.deepEqual([sp.period, sp.period_end, sp.lstext], [4, 5, 'Doppelstunde']);
  const [w] = at('2026-10-21', '08:00');
  assert.deepEqual([w.subject, w.lkey, w.state, w.teacher, w.period, w.period_end], ['Wandertag', '2026-10-21|08:00|Wandertag', 'changed', '', 1, 6]);
  const dup = at('2026-10-22', '08:00');
  assert.deepEqual(dup.map((r) => [r.lkey, r.room]), [['2026-10-22|08:00|1', '101'], ['2026-10-22|08:00|1#2', '104']], 'ordered by WebUntis id');
});

test('range: lessons outside are dropped; sorted by date and time', () => {
  assert.ok(!rows.some((r) => r.date === '2026-11-23'));
  const keys = rows.map((r) => r.date + r.t_start);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(tt.normalize(null, grid).length, 0);
  assert.equal(tt.normalize([{ id: 1, date: 2026102, startTime: 800, endTime: 845 }, { id: 2, date: 20261020, startTime: 2500, endTime: 845 }], grid).length, 0, 'bad date or time');
});

test('an original equal to the current name is no change', () => {
  const [r] = tt.normalize([{ id: 1, date: 20261020, startTime: 800, endTime: 845, su: [{ id: 1, name: 'M' }], te: [{ id: 11, name: 'MUE', orgid: 11, orgname: 'MUE' }], ro: [] }], grid);
  assert.equal(r.state, 'normal');
});

test('holidays: compact, overlapping the range, the name of a date', () => {
  const h = tt.compactHolidays(fixture('holidays.json').result, '2026-10-01', '2026-12-01');
  assert.deepEqual(h, [{ name: 'Brückentag', from: '2026-10-30', to: '2026-10-30' }]);
  assert.equal(tt.holidayOn(h, '2026-10-30'), 'Brückentag');
  assert.equal(tt.holidayOn(h, '2026-10-29'), null);
});

test('class: the most frequent one; shown state of extra and removed lessons', () => {
  assert.equal(tt.mainKlasse(rows), '5a');
  assert.equal(tt.shownState({ state: 'normal', added: true }), 'extra');
  assert.equal(tt.shownState({ state: 'changed', added: true }), 'extra');
  assert.equal(tt.shownState({ state: 'normal', removed: true }), 'cancelled');
  assert.equal(tt.shownState({ state: 'normal' }), 'normal');
});
