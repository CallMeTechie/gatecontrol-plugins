'use strict';

// Every statement of the screens and the background run stays cheap with 50 000 tasks and 50 000 notes of one person
// (plus other people's data around them): GateControl logs a "slow plugin database statement" from 200 ms on and a long
// statement blocks the plugin's database worker. Checked per statement in node:sqlite (the mock host) without a limit
// in milliseconds, which failed on a busy machine (tools/testing/sql-cost.js): the query plan of every statement that
// runs (no table of the tasks or notes read as a whole), the number of statements and rows of the screens, and each
// statement's time against reading every note once in the same run.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, item, ANNA, MARC } = require('./helpers');
const { fill, N } = require('./big-data');
const cost = require('../../../tools/testing/sql-cost');

// the unit of a statement's cost: every note read once. The costliest statement (a list of 1 667 open tasks) is less
// than half of it.
const UNIT = 'SELECT COUNT(*), MAX(LENGTH(body)) FROM notes NOT INDEXED';
const FACTOR = 1;
// read as a whole on purpose
const WHOLE = [
  // the newest notes of the notebooks: along the index of the change time, down to the page (LIMIT)
  /^SCAN notes USING INDEX idx_notes_updated ← .* ORDER BY n\.updated_at DESC, n\.id DESC LIMIT \?$/,
];
// the indexes the statements stand on: one that is gone or no longer taken shows here, also where SQLite then finds
// its way by another index and sorts
const INDEXES = {
  screens: ['idx_tasks_list', 'idx_tasks_due', 'idx_tasks_important', 'idx_tasks_assignee', 'idx_tasks_done', 'idx_tasks_parent', 'idx_my_day_task', 'idx_tasks_missed', 'idx_notes_nb', 'idx_notes_pinned',
    'idx_notes_updated', 'idx_note_tags_tag', 'idx_list_members_list', 'idx_notebook_members_nb'],
  // idx_notes_gone, idx_tasks_rest (1.2.1): „is this notebook / list of the trash empty?“ — test/writes.test.js
  // idx_tasks_cal_dirty, idx_tasks_dueday, idx_tasks_missed, idx_my_day_day (1.3.0): the tasks the calendar has to look at,
  // „Gestern offen geblieben“ of everybody
  background: ['idx_tasks_remind', 'idx_tasks_trash', 'idx_notes_trash', 'idx_notes_expires', 'idx_src_item_users_item', 'idx_src_items_done', 'idx_notes_gone', 'idx_tasks_rest',
    'idx_tasks_cal_dirty', 'idx_tasks_dueday', 'idx_tasks_missed', 'idx_my_day_day'],
};
// the requests of the screens run 766 statements; one per row of a list (1 667 tasks, 50 notes a page) would be far more
const SCREENS_MAX = 900;

test(`speed: ${N} tasks and ${N} notes — no statement reads them as a whole`, { timeout: 600000 }, async (t) => {
  const h = await withHost();
  try {
    const { lists, nbs } = await fill(h);
    const rec = await cost.record(async () => {
      for (const area of ['private', 'work']) {
        await h.ok(ANNA, 'GET', 'nav', null, { area });
        for (const v of ['myday', 'important', 'planned', 'assigned']) await h.ok(ANNA, 'GET', 'views/' + v, null, { area });
        await h.ok(ANNA, 'GET', 'notes', null, { area });
        await h.ok(ANNA, 'GET', 'notes', null, { area, pinned: '1' });
        await h.ok(ANNA, 'GET', 'notes', null, { area, tag: 'tag3' });
        await h.ok(ANNA, 'GET', 'notebooks', null, { area });
      }
      await h.ok(ANNA, 'GET', 'views/list:' + lists[1]);
      await h.ok(ANNA, 'GET', `lists/${lists[1]}/usage`);
      await h.ok(ANNA, 'GET', `notebooks/${nbs[3]}/usage`);
      await h.ok(ANNA, 'GET', 'views/source:gatecontrol-mail', null, { area: 'private' });
      const page = await h.ok(ANNA, 'GET', 'notes', null, { notebook: nbs[3] });
      await h.ok(ANNA, 'GET', 'notes', null, { notebook: nbs[3], before: page.next });
      await h.ok(ANNA, 'GET', 'notes/' + page.notes[0].id);
      for (const q of ['zahnarzt', 'notiz 4711', 'lorem ipsum', 'tag1', 'ang']) await h.ok(ANNA, 'GET', 'search', null, { q, area: 'private' });
      const made = await h.ok(ANNA, 'POST', 'tasks', { text: 'morgen 9 Uhr Zahnarzt anrufen wichtig', area: 'private' });
      // 1.3.0: „Gestern offen geblieben“, the reminders to come, „Später“, „Verschieben“ — and a delete (the marks of „Mein Tag“ by task)
      await h.ok(ANNA, 'GET', 'yesterday');
      await h.ok(ANNA, 'GET', 'reminders');
      await h.ok(ANNA, 'POST', `tasks/${made.task.id}/snooze`, { until: '1h' });
      await h.ok(ANNA, 'POST', `tasks/${made.task.id}/move`, { to: 'weekend' });
      await h.ok(ANNA, 'DELETE', 'tasks/' + made.task.id);
      await h.ok(ANNA, 'POST', 'notes', { notebookId: nbs[1], title: 'Neu', body: '#tag1 Text' });
      await h.ok(MARC, 'GET', 'views/myday', null, { area: 'private' });
      await h.ok(MARC, 'GET', 'nav', null, { area: 'private' });
    });
    const background = await cost.record(async () => {
      await h.host.tick();
      const up = [];
      for (let i = 0; i < 200; i++) up.push(item('gatecontrol-mail', `m:0:${i}`, { title: 'Mail neu ' + i, users: [ANNA.id], updatedAt: Date.now() + 1000 }));
      await h.push('gatecontrol-mail', { upsert: up });
    });
    for (const [what, r, needed] of [['the screens', rec, INDEXES.screens], ['the background run and a push', background, INDEXES.background]]) {
      const used = cost.indexes(r);
      assert.deepEqual(needed.filter((i) => !used.includes(i)), [], `${what}: indexes no statement goes by any more`);
      assert.deepEqual(cost.fullReads(r, { allow: WHOLE }), [], `${what}: a large table read as a whole`);
      assert.deepEqual(cost.tooSlow(r, { unit: UNIT, factor: FACTOR }), [], `${what}: statements of ${FACTOR} units or more`);
    }
    assert.ok(rec.runs <= SCREENS_MAX, `${rec.runs} statements for the screens`);
    assert.ok(rec.rows < N, `${rec.rows} rows given back`);
    t.diagnostic(`screens: ${rec.runs} statements, ${rec.rows} rows; background and push: ${background.runs} statements; slowest: ${cost.slowest(rec, UNIT).concat(cost.slowest(background, UNIT, 1)).join(' | ')}`);
  } finally { await h.close(); }
});
