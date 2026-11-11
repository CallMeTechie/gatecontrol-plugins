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
const cost = require('../../../tools/testing/sql-cost');

// the unit of a statement's cost: every note read once. The costliest statement (a list of 1 667 open tasks) is less
// than half of it.
const UNIT = 'SELECT COUNT(*), MAX(LENGTH(body)) FROM notes NOT INDEXED';
const FACTOR = 1;
// read as a whole on purpose
const WHOLE = [
  // the newest notes of the notebooks: along the index of the change time, down to the page (LIMIT)
  /^SCAN notes USING INDEX idx_notes_updated ← .* ORDER BY n\.updated_at DESC, n\.id DESC LIMIT \?$/,
  // housekeeping, once for a notebook or list that left the trash: is it empty? The indexes of notebook_id and list_id
  // leave out deleted rows, so this reads the table — only for such a notebook or list, never on a screen
  /^SCAN notes ← DELETE FROM notebooks WHERE deleted_at IS NOT NULL AND deleted_at < \? AND NOT EXISTS/,
  /^SCAN tasks ← DELETE FROM lists WHERE deleted_at IS NOT NULL AND deleted_at < \? AND NOT EXISTS/,
];
// the indexes the statements stand on: one that is gone or no longer taken shows here, also where SQLite then finds
// its way by another index and sorts
const INDEXES = {
  screens: ['idx_tasks_list', 'idx_tasks_due', 'idx_tasks_important', 'idx_tasks_assignee', 'idx_tasks_done', 'idx_tasks_parent', 'idx_my_day_task', 'idx_notes_nb', 'idx_notes_pinned',
    'idx_notes_updated', 'idx_note_tags_tag', 'idx_list_members_list', 'idx_notebook_members_nb'],
  background: ['idx_tasks_remind', 'idx_tasks_trash', 'idx_notes_trash', 'idx_notes_expires', 'idx_src_item_users_item', 'idx_src_items_done'],
};
// the requests of the screens run 766 statements; one per row of a list (1 667 tasks, 50 notes a page) would be far more
const SCREENS_MAX = 900;
const N = 50000;

async function fill(h) {
  const db = h.host.gc.db;
  const now = Date.now();
  // Anna: 20 lists (2 shared with Marc), Marc: 5 lists of his own
  await h.ok(ANNA, 'GET', 'me');
  await h.ok(ANNA, 'GET', 'nav', null, { area: 'private' });
  const lists = [];
  for (let i = 0; i < 20; i++) lists.push((await h.ok(ANNA, 'POST', 'lists', { name: 'Liste ' + i, area: i % 4 === 0 ? 'work' : 'private' })).list.id);
  await h.ok(ANNA, 'PUT', `lists/${lists[1]}/members`, { members: [MARC.id] });
  // 1.2.0: two lists with today (Sunday) as their day, one with the morning push
  await h.ok(ANNA, 'PATCH', `lists/${lists[1]}`, { days: [6, 7], remind: '09:00' });
  await h.ok(ANNA, 'PATCH', `lists/${lists[2]}`, { days: [7] });
  for (let i = 0; i < 5; i++) await h.ok(MARC, 'POST', 'lists', { name: 'Marc ' + i });
  // the rows are made by SQLite itself (a recursive CTE), not one statement each: the fill stays short and keeps
  // the CPU free for the other test files running at the same time
  const W = "CASE i % 10 WHEN 0 THEN 'Zahnarzt' WHEN 1 THEN 'Rechnung' WHEN 2 THEN 'Angebot' WHEN 3 THEN 'Rasen' WHEN 4 THEN 'Reifen' WHEN 5 THEN 'Steuer' WHEN 6 THEN 'Einkauf' WHEN 7 THEN 'Bericht' WHEN 8 THEN 'Meeting' ELSE 'Garten' END";
  const seq = `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ${N})`;
  const pick = (ids) => `CASE i % ${ids.length} ${ids.map((id, k) => `WHEN ${k} THEN ${Number(id)}`).join(' ')} END`;
  await db.exec('BEGIN');
  await db.run(`${seq}, v AS (SELECT i, CASE WHEN i % 3 = 0 THEN ${now} - (i % 100) * 3600000 END AS done,
      CASE WHEN i % 5 = 0 THEN printf('2026-%02d-%02d', 1 + (i % 12), 1 + (i % 28)) END AS due FROM s)
    INSERT INTO tasks (list_id, title, note, important, due_date, due_at, remind_at, assignee_id, done_at, position, created_by, created_at, updated_at)
    SELECT ${pick(lists)}, ${W} || ' ' || i, CASE WHEN i % 7 = 0 THEN 'Notiz zur Aufgabe ' || i ELSE '' END, i % 11 = 0, due,
      CASE WHEN due IS NOT NULL THEN (unixepoch(due || ' 22:59:00')) * 1000 END,
      CASE WHEN i % 13 = 0 AND done IS NULL THEN ${now} + i * 60000 END, CASE WHEN i % 17 = 0 THEN ${ANNA.id} END, done, i, ${ANNA.id}, ${now} - i * 1000, ${now} - i * 1000
    FROM v ORDER BY i`);
  await db.run('INSERT INTO tasks_fts (rowid, title, note) SELECT id, title, note FROM tasks');
  await db.run(`INSERT INTO tasks (list_id, parent_id, title, position, created_by, created_at, updated_at)
    SELECT t.list_id, t.id, 'Sub ' || k.s, k.s, ${ANNA.id}, ${now}, ${now} FROM tasks t, (SELECT 0 AS s UNION ALL SELECT 1 UNION ALL SELECT 2) k
    WHERE t.parent_id IS NULL AND t.position % 50 = 0 ORDER BY t.id, k.s`);
  await db.run(`INSERT OR IGNORE INTO my_day (user_id, day, task_id) SELECT ${ANNA.id}, '2026-11-08', id FROM tasks WHERE parent_id IS NULL AND position % 200 = 0`);
  await db.exec('COMMIT');
  // 30 notebooks, 50 000 notes with tags and text
  const nbs = [];
  for (let i = 0; i < 30; i++) nbs.push((await h.ok(ANNA, 'POST', 'notebooks', { name: 'Buch ' + i, area: i % 5 === 0 ? 'work' : 'private' })).notebook.id);
  const para = 'Lorem ipsum dolor sit amet, consetetur sadipscing elitr, sed diam nonumy eirmod tempor invidunt ut labore. '.repeat(4);
  await db.exec('BEGIN');
  await db.run(`${seq} INSERT INTO notes (notebook_id, title, body, snippet, pinned, check_done, check_total, created_by, updated_by, created_at, updated_at)
    SELECT ${pick(nbs)}, ${W} || ' Notiz ' || i, '# Notiz ' || i || char(10) || ? || char(10) || '- [ ] Punkt ' || i || char(10) || '- [x] erledigt' || char(10) || '#tag' || (i % 40) || ' #thema' || (i % 7),
      ?, i % 500 = 0, 1, 2, ${ANNA.id}, ${ANNA.id}, ${now} - i * 60000, ${now} - i * 60000 FROM s ORDER BY i`, [para, para.slice(0, 200)]);
  await db.run(`INSERT INTO note_tags (note_id, tag) SELECT id, 'tag' || (CAST(substr(title, instr(title, 'Notiz ') + 6) AS INTEGER) % 40) FROM notes
    UNION ALL SELECT id, 'thema' || (CAST(substr(title, instr(title, 'Notiz ') + 6) AS INTEGER) % 7) FROM notes`);
  await db.run(`INSERT INTO notes_fts (rowid, title, body, tags, ocr) SELECT n.id, n.title, n.body, group_concat(g.tag, ' '), '' FROM notes n JOIN note_tags g ON g.note_id = n.id GROUP BY n.id`);
  await db.run(`INSERT INTO notebook_tags (notebook_id, tag, n) SELECT n.notebook_id, g.tag, COUNT(*) FROM note_tags g JOIN notes n ON n.id = g.note_id GROUP BY n.notebook_id, g.tag`);
  await db.exec('COMMIT');
  const count = async (sql) => { const r = await db.query(sql); return Object.values((r.rows || r)[0])[0]; };
  assert.deepEqual([await count('SELECT COUNT(*) FROM tasks'), await count('SELECT COUNT(*) FROM tasks_fts'), await count('SELECT COUNT(*) FROM my_day'),
    await count('SELECT COUNT(*) FROM notes'), await count('SELECT COUNT(*) FROM note_tags'), await count('SELECT COUNT(*) FROM notes_fts'),
    await count("SELECT COUNT(*) FROM tasks WHERE due_date = '2026-06-06' AND due_at = " + Date.parse('2026-06-06T22:59:00Z'))],
  [N + 3 * (N / 50), N, N / 200, N, 2 * N, N, await count("SELECT COUNT(*) FROM tasks WHERE due_date = '2026-06-06'")]);
  // 600 items of the sources
  for (let k = 0; k < 3; k++) {
    const up = [];
    for (let i = 0; i < 200; i++) up.push(item('gatecontrol-mail', `m:${k}:${i}`, { title: 'Mail ' + i, due: i % 3 ? '2026-11-08' : '2026-11-20', users: [ANNA.id, MARC.id] }));
    await h.push('gatecontrol-mail', { upsert: up });
  }
  return { lists, nbs };
}

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
      await h.ok(ANNA, 'POST', 'tasks', { text: 'morgen 9 Uhr Zahnarzt anrufen wichtig', area: 'private' });
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
