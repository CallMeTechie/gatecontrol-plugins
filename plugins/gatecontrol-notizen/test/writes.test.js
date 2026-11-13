'use strict';

// 1.2.1 — fewer and cheaper statements on a slow disk (GateControl's protocol: "slow plugin database statements"):
//   * the housekeeping of the trash asks "is this notebook / list empty?" of indexes (migrations/004_trash_indexes.sql)
//     instead of reading every note or task — with the same answer as the statement before;
//   * "used the hub" (prefs.updated_at) is written at most every 12 hours, PUT prefs with the same choices not at all;
//   * the migration on a database of 1.2.0 with data.
// No limit in milliseconds (tools/testing/sql-cost.js): the query plans and the writes the mock host counts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');
const { withHost, ANNA, MARC, clock } = require('./helpers');
const { fill, N } = require('./big-data');
const cost = require('../../../tools/testing/sql-cost');
const housekeeping = require('../server/housekeeping');
const prefs = require('../server/prefs');

const DAY = 86400000;
// the statements of 1.2.0, as a question: the notebooks and lists its housekeeping would remove now
const OLD = {
  notebooks: 'SELECT id FROM notebooks WHERE deleted_at IS NOT NULL AND deleted_at < ? AND NOT EXISTS (SELECT 1 FROM notes WHERE notes.notebook_id = notebooks.id) ORDER BY id',
  lists: 'SELECT id FROM lists WHERE deleted_at IS NOT NULL AND deleted_at < ? AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.list_id = lists.id) ORDER BY id',
};
const ids = async (db, sql, args) => ((await db.query(sql, args || [])).rows || []).map((r) => r.id);

test(`the trash with ${N} tasks and notes: "empty?" goes by indexes and removes what 1.2.0 removed`, { timeout: 600000 }, async () => {
  const h = await withHost();
  try {
    const { lists, nbs } = await fill(h);
    const db = h.host.gc.db;
    const now = clock.now();
    const old = now - 31 * DAY;
    const ctx = { now, today: '2026-11-08', time: '10:00', tz: 'Europe/Berlin' };
    // notebooks: [0] in the trash for 31 days and empty · [1] 31 days, one note in the trash since 5 days · [2] 31 days,
    // one note still there · [3] in the trash since 5 days, empty
    // lists: [0] 31 days, empty · [1] 31 days, a task in the trash that waits for To Do (ext_dirty) · [2] 31 days, only
    // a sub-task whose task is gone · [3] 31 days, a task still there · [4] in the trash since 5 days, empty
    const nb = nbs.slice(20, 24);
    // (the fill gives sub-tasks to the lists 0 and 10)
    const li = [lists[11], lists[12], lists[10], lists[13], lists[14]];
    await db.exec('BEGIN');
    for (const [i, id] of nb.entries()) {
      await db.run(`DELETE FROM notes WHERE notebook_id = ? AND id NOT IN (SELECT id FROM notes WHERE notebook_id = ? ORDER BY id LIMIT ${i === 1 || i === 2 ? 1 : 0})`, [id, id]);
      await db.run('UPDATE notebooks SET deleted_at = ? WHERE id = ?', [i === 3 ? now - 5 * DAY : old, id]);
    }
    await db.run('UPDATE notes SET deleted_at = ? WHERE notebook_id = ?', [now - 5 * DAY, nb[1]]);
    for (const [i, id] of li.entries()) {
      await db.run(`DELETE FROM tasks WHERE list_id = ? AND id NOT IN (SELECT id FROM tasks WHERE list_id = ? AND parent_id IS ${i === 2 ? 'NOT ' : ''}NULL ORDER BY id LIMIT ${i >= 1 && i <= 3 ? 1 : 0})`, [id, id]);
      await db.run('UPDATE lists SET deleted_at = ? WHERE id = ?', [i === 4 ? now - 5 * DAY : old, id]);
    }
    await db.run('UPDATE tasks SET deleted_at = ?, ext_dirty = 1 WHERE list_id = ?', [old, li[1]]);
    // the trash itself: 2 900 notes and tasks of the last 29 days, some 300 of each older than 30 days (they go now)
    await db.run(`UPDATE notes SET deleted_at = ${now} - (id % 29) * ${DAY} WHERE id % 17 = 0 AND deleted_at IS NULL AND notebook_id NOT IN (${nb.join(',')})`);
    await db.run(`UPDATE tasks SET deleted_at = ${now} - (id % 29) * ${DAY} WHERE id % 17 = 0 AND deleted_at IS NULL AND list_id NOT IN (${li.join(',')})`);
    await db.run(`UPDATE notes SET deleted_at = ${old} WHERE id % 125 = 1 AND deleted_at IS NULL AND notebook_id NOT IN (${nb.join(',')})`);
    await db.run(`UPDATE tasks SET deleted_at = ${old} WHERE id % 125 = 1 AND deleted_at IS NULL AND list_id NOT IN (${li.join(',')})`);
    await db.exec('COMMIT');
    const before = now - 30 * DAY;
    // what 1.2.0 would remove (its statements, as questions) once the old notes and tasks of the trash are gone
    const expected = { notebooks: await ids(db, OLD.notebooks, [before]), lists: await ids(db, OLD.lists, [before]) };
    assert.deepEqual(expected, { notebooks: [nb[0]], lists: [li[0]] }, 'the data of this test');

    let purged = 0;
    const rec = await cost.record(async () => { purged = await housekeeping.purge(h.host.gc, ctx); });
    assert.ok(purged >= 500, `${purged} notes and tasks left the trash`);
    // the plans: no note and no task read as a whole (1.2.0: SCAN notes, SCAN tasks) …
    assert.deepEqual(cost.fullReads(rec), [], 'a large table read as a whole');
    const del = (table) => [...rec.statements.values()].find((s) => new RegExp(`^DELETE FROM ${table} `).test(s.sql));
    const plans = { notebooks: cost.plan(del('notebooks').db, del('notebooks').sql), lists: cost.plan(del('lists').db, del('lists').sql) };
    assert.match(plans.notebooks, /SEARCH notes USING (COVERING )?INDEX idx_notes_nb \(notebook_id=\?\).*SEARCH notes USING (COVERING )?INDEX idx_notes_gone \(notebook_id=\?\)/);
    assert.match(plans.lists, /SEARCH tasks USING (COVERING )?INDEX idx_tasks_list \(list_id=\?\).*SEARCH tasks USING (COVERING )?INDEX idx_tasks_rest \(list_id=\?\)/);
    assert.doesNotMatch(`${plans.notebooks} / ${plans.lists}`, /SCAN (notes|tasks)/);
    // … and the same rows gone as with the statements of 1.2.0: these, and nothing 1.2.0 would still remove
    const left = { notebooks: await ids(db, `SELECT id FROM notebooks WHERE id IN (${nb.join(',')}) ORDER BY id`), lists: await ids(db, `SELECT id FROM lists WHERE id IN (${li.join(',')}) ORDER BY id`) };
    assert.deepEqual(left, { notebooks: nb.slice(1), lists: li.slice(1).sort((a, b) => a - b) });
    assert.deepEqual({ notebooks: await ids(db, OLD.notebooks, [before]), lists: await ids(db, OLD.lists, [before]) }, { notebooks: [], lists: [] });
    // the next run: nothing to do, nothing written
    h.host.resetDbWrites();
    assert.equal(await housekeeping.purge(h.host.gc, ctx), 0);
    assert.deepEqual(h.host.dbWrites, []);
  } finally { await h.close(); }
});

test('"used the hub": one write in 12 hours, however often the hub is opened', async () => {
  const h = await withHost();
  try {
    const prefsWrites = () => h.host.dbWrites.filter((w) => /INTO prefs/.test(w.sql || ''));
    await h.ok(ANNA, 'GET', 'me');
    const t0 = (await h.host.gc.db.get('SELECT updated_at FROM prefs WHERE user_id = ?', [ANNA.id])).row.updated_at;
    assert.equal(t0, clock.now());
    h.host.resetDbWrites();
    for (let i = 0; i < 11; i++) { clock.set(clock.now() + 3600000); await h.ok(ANNA, 'GET', 'me'); }
    assert.deepEqual(prefsWrites(), [], 'eleven hours of opening the hub');
    clock.set(clock.now() + 3600000);
    await h.ok(ANNA, 'GET', 'me');
    assert.equal(prefsWrites().length, 1, 'after 12 hours');
    assert.equal((await h.host.gc.db.get('SELECT updated_at FROM prefs WHERE user_id = ?', [ANNA.id])).row.updated_at, t0 + prefs.TOUCH_MS);
    // someone else: their own row, at once
    h.host.resetDbWrites();
    await h.ok(MARC, 'GET', 'me');
    assert.equal(prefsWrites().length, 1);
    // a clock set back: written (as before)
    clock.set(t0 - 60000);
    h.host.resetDbWrites();
    await h.ok(ANNA, 'GET', 'me');
    assert.equal(prefsWrites().length, 1);
  } finally { await h.close(); }
});

test('PUT prefs: the same choices again write nothing, a changed one does', async () => {
  const h = await withHost();
  try {
    const prefsWrites = () => h.host.dbWrites.filter((w) => /INTO prefs/.test(w.sql || ''));
    await h.ok(ANNA, 'GET', 'me');
    const first = (await h.ok(ANNA, 'PUT', 'prefs', { area: 'work', times: { morning: '07:30' } })).prefs;
    assert.equal(first.area, 'work');
    h.host.resetDbWrites();
    // the portal sends the area with every change of the area, an app with every start
    for (let i = 0; i < 5; i++) assert.deepEqual((await h.ok(ANNA, 'PUT', 'prefs', { area: 'work' })).prefs, first);
    assert.deepEqual((await h.ok(ANNA, 'PUT', 'prefs', { times: { morning: '07:30' } })).prefs, first);
    assert.deepEqual(prefsWrites(), []);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'prefs')).prefs, first);
    const second = (await h.ok(ANNA, 'PUT', 'prefs', { area: 'private' })).prefs;
    assert.equal(second.area, 'private');
    assert.equal(prefsWrites().length, 1);
    assert.deepEqual((await h.ok(ANNA, 'GET', 'prefs')).prefs, second);
    // the same choices half a day later: "used the hub" is noted (prefs.touch), the choices stay
    clock.set(clock.now() + prefs.TOUCH_MS);
    h.host.resetDbWrites();
    assert.deepEqual((await h.ok(ANNA, 'PUT', 'prefs', { area: 'private' })).prefs, second);
    assert.equal(prefsWrites().length, 1);
    assert.equal((await h.host.gc.db.get('SELECT updated_at FROM prefs WHERE user_id = ?', [ANNA.id])).row.updated_at, clock.now());
    assert.deepEqual((await h.ok(ANNA, 'GET', 'prefs')).prefs, second);
  } finally { await h.close(); }
});

test('migration 004 on a database of 1.2.0 with data: the indexes hold the trash and the sub-tasks, nothing else changes', () => {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  assert.equal(files[3], '004_trash_indexes.sql');
  const db = new sqlite.DatabaseSync(':memory:');
  try {
    for (const f of files.slice(0, 3)) db.exec(`BEGIN;${fs.readFileSync(path.join(dir, f), 'utf8')};COMMIT;`);
    // data of 1.2.0: 2 lists and 2 notebooks, 3 000 tasks (every 10th a sub-task, every 7th in the trash) and notes
    db.exec(`BEGIN;
      INSERT INTO lists (id, owner_id, name, area, created_at, updated_at) VALUES (1, 1, 'A', 'private', 1, 1), (2, 1, 'B', 'private', 1, 1);
      INSERT INTO notebooks (id, owner_id, name, area, created_at, updated_at) VALUES (1, 1, 'A', 'private', 1, 1), (2, 1, 'B', 'private', 1, 1);
      WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 3000)
        INSERT INTO tasks (id, list_id, parent_id, title, created_by, created_at, updated_at, deleted_at)
        SELECT i, 1 + i % 2, CASE WHEN i % 10 = 0 THEN i - 1 END, 'Aufgabe ' || i, 1, i, i, CASE WHEN i % 7 = 0 THEN 1000 + i END FROM s;
      WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 3000)
        INSERT INTO notes (id, notebook_id, title, body, created_by, updated_by, created_at, updated_at, deleted_at)
        SELECT i, 1 + i % 2, 'Notiz ' || i, 'Text ' || i, 1, 1, i, i, CASE WHEN i % 7 = 0 THEN 1000 + i END FROM s;
      COMMIT;`);
    const sums = () => db.prepare(`SELECT (SELECT COUNT(*) FROM tasks) AS t, (SELECT SUM(id + COALESCE(deleted_at, 0) + COALESCE(parent_id, 0)) FROM tasks) AS ts,
      (SELECT COUNT(*) FROM notes) AS n, (SELECT SUM(id + COALESCE(deleted_at, 0)) FROM notes) AS ns, (SELECT group_concat(title, '|') FROM (SELECT title FROM notes ORDER BY id LIMIT 3)) AS first`).get();
    const before = sums();
    const scan = db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM notes WHERE notebook_id = ?').all(1).map((r) => r.detail).join(' / ');
    assert.match(scan, /^SCAN notes$/, 'the question of 1.2.0 read the notes');
    // as GateControl runs migrations: in one transaction
    db.exec(`BEGIN;${fs.readFileSync(path.join(dir, files[3]), 'utf8')};COMMIT;`);
    assert.deepEqual(sums(), before, 'no row changed');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_notes_gone', 'idx_tasks_rest') ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(names, ['idx_notes_gone', 'idx_tasks_rest']);
    const n = (sql) => Number(Object.values(db.prepare(sql).get())[0]);
    // the rows of the old data are in the new indexes (asked through them and without any index)
    for (const id of [1, 2]) {
      assert.equal(n(`SELECT COUNT(*) FROM notes INDEXED BY idx_notes_gone WHERE notebook_id = ${id} AND deleted_at IS NOT NULL`), n(`SELECT COUNT(*) FROM notes NOT INDEXED WHERE notebook_id = ${id} AND deleted_at IS NOT NULL`));
      assert.equal(n(`SELECT COUNT(*) FROM tasks INDEXED BY idx_tasks_rest WHERE list_id = ${id} AND (deleted_at IS NOT NULL OR parent_id IS NOT NULL)`),
        n(`SELECT COUNT(*) FROM tasks NOT INDEXED WHERE list_id = ${id} AND (deleted_at IS NOT NULL OR parent_id IS NOT NULL)`));
    }
    assert.ok(n('SELECT COUNT(*) FROM notes INDEXED BY idx_notes_gone WHERE notebook_id = 1 AND deleted_at IS NOT NULL') > 200);
    // rows written after the migration keep them right: into the trash, out of it, a new sub-task, gone for good
    db.exec('UPDATE notes SET deleted_at = 5 WHERE id = 1; UPDATE notes SET deleted_at = NULL WHERE id = 7; DELETE FROM notes WHERE id = 14;');
    db.exec("INSERT INTO tasks (id, list_id, parent_id, title, created_by, created_at, updated_at) VALUES (5000, 2, 1, 'Sub', 1, 1, 1); UPDATE tasks SET deleted_at = NULL WHERE id = 7;");
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(n('SELECT COUNT(*) FROM notes INDEXED BY idx_notes_gone WHERE notebook_id = 2 AND deleted_at IS NOT NULL'), n('SELECT COUNT(*) FROM notes NOT INDEXED WHERE notebook_id = 2 AND deleted_at IS NOT NULL'));
    assert.equal(n('SELECT COUNT(*) FROM tasks INDEXED BY idx_tasks_rest WHERE list_id = 2 AND (deleted_at IS NOT NULL OR parent_id IS NOT NULL)'),
      n('SELECT COUNT(*) FROM tasks NOT INDEXED WHERE list_id = 2 AND (deleted_at IS NOT NULL OR parent_id IS NOT NULL)'));
  } finally { db.close(); }
});
