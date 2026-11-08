'use strict';

// The shared pure modules every client ports: the quick entry (ui/quickparse.js), the repeat rules (ui/repeat.js)
// and the note text (ui/notemd.js). The vectors in test/vectors/*.json are the contract for Android and Windows.

const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../ui/quickparse');
const R = require('../ui/repeat');
const M = require('../ui/notemd');
const qv = require('./vectors/quickparse.json');
const rv = require('./vectors/repeat.json');

test('quick entry: every vector', () => {
  assert.ok(qv.cases.length >= 50);
  for (const c of qv.cases) {
    const p = Q.parse(c.input, qv.ctx);
    const got = { title: p.title, date: p.date, time: p.time, remind: p.remind, important: p.important, list: p.list, listName: p.listName, assignee: p.assignee, assigneeName: p.assigneeName, repeat: p.repeat };
    assert.deepEqual(got, c.expect, c.input);
  }
  assert.deepEqual(Q.parse(qv.cases[0].input, qv.ctx).marks, qv.marksOfFirst);
});

test('quick entry: the mockup line and what must stay text', () => {
  const p = Q.parse('Morgen 9 Uhr Zahnarzt anrufen, wichtig , #gesundheit', { today: '2026-11-08', lists: [{ id: 7, name: 'Gesundheit' }] });
  assert.deepEqual([p.title, p.date, p.time, p.important, p.list && p.list.name], ['Zahnarzt anrufen', '2026-11-09', '09:00', true, 'Gesundheit']);
  assert.deepEqual(p.remind, { date: '2026-11-09', time: '09:00' });
  for (const s of ['So geht das nicht', 'Do it now', 'Buch S. 42, Nr. 3–6', 'Mail an a@b.de']) assert.equal(Q.parse(s, { today: '2026-11-08' }).title, s, s);
  assert.throws(() => Q.parse('x', {}), /today/);
  // a time already over today → tomorrow; still to come → today
  assert.equal(Q.parse('um 8 Bäcker', { today: '2026-11-08', now: '10:00' }).date, '2026-11-09');
  assert.equal(Q.parse('um 18 Sport', { today: '2026-11-08', now: '10:00' }).date, '2026-11-08');
});

test('repeat rules: every vector', () => {
  for (const c of rv.next) assert.equal(R.next(c.rule, { due: c.due, done: c.done }), c.expect, JSON.stringify(c));
  for (const c of rv.first) assert.equal(R.first(c.rule, c.today), c.expect, JSON.stringify(c));
  for (const c of rv.describe) { assert.equal(R.describe(c.rule, 'de'), c.de); assert.equal(R.describe(c.rule, 'en'), c.en); }
  for (const r of rv.invalid) assert.equal(R.normalize(r), null, JSON.stringify(r));
  // a week rule never jumps into the past, whatever day it is completed on
  for (let d = 0; d < 60; d++) {
    const done = R.addDays('2026-11-01', d);
    const n = R.next({ type: 'weekly', interval: 3, days: [2, 6] }, { due: '2026-11-03', done });
    assert.ok(n > done && [2, 6].includes(R.weekday(n)), done + ' → ' + n);
  }
});

test('note text: render is safe, checks, toggle, tags, a line to a task', () => {
  const md = '# Werkstatt\n<script>alert(1)</script> **fett** [x](javascript:alert(1)) [ok](https://example.com)\n- [x] eins\n- [ ] zwei [Aufgabe](task:5)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![Bild](att:3) #auto #Werkstatt';
  const html = M.render(md, { att: (id) => ({ url: '/plugin-media/t' + id, name: 'b.jpg', mime: 'image/jpeg' }), task: () => ({ label: 'Aufgabe · Mi.' }), checkable: true });
  assert.ok(!/<script/i.test(html) && !/href="javascript/i.test(html));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>fett<\/strong>/);
  assert.match(html, /<a href="https:\/\/example.com"/);
  assert.match(html, /<table>/);
  assert.match(html, /<img class="nm-img" src="\/plugin-media\/t3"/);
  assert.deepEqual(M.checks(md).map((c) => [c.line, c.text, c.done, c.task]), [[2, 'eins', true, null], [3, 'zwei', false, 5]]);
  assert.equal(M.toggle(md, 3, true).split('\n')[3], '- [x] zwei [Aufgabe](task:5)');
  assert.equal(M.toggle(md, 0, true), null);
  assert.deepEqual(M.tags(md), ['auto', 'werkstatt']);
  assert.deepEqual(M.attachments(md), [3]);
  assert.equal(M.lineText(md, 3), 'zwei');
  assert.equal(M.linkTask('- [ ] a', 0, 9, 'Aufgabe'), '- [ ] a [Aufgabe](task:9)');
  assert.ok(!M.plain(md).includes('**'));
  // headings are not tags, code is not either
  assert.deepEqual(M.tags('# Titel\n`#nein` text #ja'), ['ja']);
});
