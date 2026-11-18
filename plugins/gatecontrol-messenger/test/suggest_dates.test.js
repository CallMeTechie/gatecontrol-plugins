'use strict';

// 1.28.0: „Termin vorschlagen“ (server/suggest.js) reads a numeric day without the last dot — „30.11 um 08:00“ is the
// 30th, not today 08:00 — and the title keeps no date words („30 11“, „am“, „um“, „Uhr“). The same cases as the Android
// app (chat/ChatDateHint.kt). Texts made up; sent on Wednesday 18.11.2026, 10:00 (the server's time zone).

const test = require('node:test');
const assert = require('node:assert/strict');
const { dates } = require('../server/suggest');

const SENT = new Date(2026, 10, 18, 10, 0).getTime();
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
const first = (text) => dates(text, SENT)[0] || null;

test('a numeric day with or without the last dot, with the year', () => {
  for (const [text, start, allDay, title] of [
    ['30.11 Elternabend', at(2026, 11, 30), true, 'Elternabend'],
    ['30.11. Elternabend in der Aula', at(2026, 11, 30), true, 'Elternabend in der Aula'],
    ['Zahnarzt 30.11.2026 um 9 Uhr', at(2026, 11, 30, 9), false, 'Zahnarzt'],
    ['Lesung 30.11.26', at(2026, 11, 30), true, 'Lesung'],
  ]) {
    const d = first(text);
    assert.deepEqual([d.startsAt, d.allDay, d.title], [start, allDay, title], text);
  }
});

test('a day and a time: „30.11 um 08:00“, „am 30.11 um 8“, „30.11 8:00“ — no leftovers in the title', () => {
  let d = first('30.11 um 08:00 kommt der Schornsteinfeger');
  assert.deepEqual([d.startsAt, d.allDay, d.title, d.label], [at(2026, 11, 30, 8), false, 'Kommt der Schornsteinfeger', 'Mo., 30.11. 08:00']);
  d = first('Probe am 30.11 um 8');
  assert.deepEqual([d.startsAt, d.title], [at(2026, 11, 30, 8), 'Probe']);
  d = first('30.11 8:00 Lieferung Brennholz');
  assert.deepEqual([d.startsAt, d.title], [at(2026, 11, 30, 8), 'Lieferung Brennholz']);
});

test('a time is not a day; a past day without a year is next year\'s', () => {
  let d = first('Morgen um 10.15 Training');
  assert.deepEqual([d.startsAt, d.title], [at(2026, 11, 19, 10, 15), 'Training']);
  assert.equal(first('Morgen 10.15 Uhr Training').startsAt, at(2026, 11, 19, 10, 15));
  d = first('Sommerfest 05.07');
  assert.deepEqual([d.startsAt, d.allDay, d.title], [at(2027, 7, 5), true, 'Sommerfest']);
  assert.equal(first('18.11 Hausputz').startsAt, at(2026, 11, 18), 'today stays this year');
  assert.equal(first('Nur so ein Text 15.30').startsAt, at(2026, 11, 18, 15, 30), 'a time, no day');
  assert.equal(first('Wir sehen uns 31.11'), null, 'no such day');
});
