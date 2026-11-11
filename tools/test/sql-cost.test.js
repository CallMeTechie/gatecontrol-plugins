'use strict';

// tools/testing/sql-cost.js: what the speed tests of the plugins stand on — a recording of the statements, the tables
// read as a whole and the indexes taken (from the query plans) and the time against a unit of the same run.

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite = require('node:sqlite');
const cost = require('../testing/sql-cost');

const N = 20000;

function database() {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(`CREATE TABLE mails (id INTEGER PRIMARY KEY, folder INTEGER NOT NULL, date INTEGER NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX mails_folder ON mails (folder, date);
    CREATE TABLE folders (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO folders (id, name) VALUES (1, 'Posteingang'), (2, 'Archiv'), (3, 'Gesendet');
    WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ${N})
      INSERT INTO mails (folder, date, subject, body) SELECT 1 + i % 3, i, 'Betreff ' || i, printf('%.*c', 400, 'x') FROM s;`);
  return db;
}
const all = (db, sql, ...args) => db.prepare(sql).all(...args);
const UNIT = 'SELECT COUNT(*), MAX(LENGTH(body)) FROM mails NOT INDEXED';

test('record: the statements, their runs and rows; the methods are as before afterwards', async () => {
  const db = database();
  const before = sqlite.StatementSync.prototype.all;
  const rec = await cost.record(async () => {
    for (const f of [1, 2, 3]) all(db, 'SELECT id FROM mails  WHERE folder = ?\n ORDER BY date DESC LIMIT 10', f);
    db.prepare('SELECT name FROM folders WHERE id = ?').get(2);
    db.prepare('UPDATE folders SET name = ? WHERE id = ?').run('Ablage', 2);
  });
  assert.equal(sqlite.StatementSync.prototype.all, before);
  assert.deepEqual([rec.runs, rec.rows, rec.statements.size], [5, 31, 3]);
  const list = rec.statements.get('SELECT id FROM mails WHERE folder = ? ORDER BY date DESC LIMIT 10');
  assert.deepEqual([list.runs, list.rows, list.method, list.db], [3, 30, 'all', db]);
  assert.equal(rec.count(/FROM mails/), 3);
  all(db, 'SELECT 1');
  assert.equal(rec.runs, 5, 'nothing is recorded afterwards');
  await assert.rejects(cost.record(async () => { throw new Error('x'); }), /x/);
  assert.equal(sqlite.StatementSync.prototype.all, before, 'also after a failure');
});

test('fullReads: a large table read as a whole — by its name or an alias, without an index, along a whole index, through an index made for the run', async () => {
  const db = database();
  const good = await cost.record(async () => {
    all(db, 'SELECT * FROM mails WHERE folder = ? ORDER BY date DESC LIMIT 50', 1);
    all(db, 'SELECT m.subject, f.name FROM mails m JOIN folders f ON f.id = m.folder WHERE m.id = ?', 7);
    all(db, 'SELECT * FROM folders');
    all(db, 'WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 5) SELECT i FROM s');
    db.prepare('UPDATE mails SET subject = ? WHERE id = ?').run('neu', 3);
  });
  assert.deepEqual(cost.fullReads(good), [], 'searches on an index, a small table, a CTE');
  const bad = await cost.record(async () => {
    all(db, 'SELECT id FROM mails WHERE subject = ?', 'Betreff 5');
    all(db, 'SELECT f.name, COUNT(*) FROM folders f JOIN mails AS m ON m.folder = f.id WHERE m.body = ? GROUP BY f.id', 'x');
    all(db, 'SELECT folder, COUNT(*) FROM mails GROUP BY folder');
    db.prepare('UPDATE mails SET subject = ? WHERE date = ?').run('neu', 3);
  });
  const reads = cost.fullReads(bad);
  assert.equal(reads.length, 4, reads.join('\n'));
  assert.match(reads[0], /^SCAN mails ← SELECT id FROM mails WHERE subject = \?$/);
  assert.match(reads[1], /^SCAN mails ← SELECT f\.name/, 'the alias m is the table mails');
  assert.match(reads[2], /^SCAN mails USING COVERING INDEX mails_folder ← /);
  assert.match(reads[3], /^SCAN mails ← UPDATE mails/);
  assert.deepEqual(cost.fullReads(bad, { allow: [/COVERING INDEX mails_folder/, /^SCAN mails ← (SELECT id|UPDATE)/] }).length, 1, 'allowed lines');
  assert.deepEqual(cost.fullReads(bad, { rows: N + 1 }), [], 'only tables of `rows` rows or more');
  // the same statement with and without its index: what a dropped index looks like
  const list = () => cost.record(async () => { all(db, 'SELECT * FROM mails WHERE folder = ? ORDER BY date DESC LIMIT 50', 1); });
  assert.deepEqual(cost.fullReads(await list()), []);
  assert.deepEqual(cost.indexes(await list()), ['mails_folder'], 'the index the statement goes by');
  // … also where SQLite still finds its way without it: by another index, sorting what it finds
  db.exec('CREATE INDEX mails_folder_only ON mails (folder)');
  db.exec('DROP INDEX mails_folder');
  assert.deepEqual(cost.fullReads(await list()), []);
  assert.deepEqual(cost.indexes(await list()), ['mails_folder_only']);
  db.exec('DROP INDEX mails_folder_only');
  assert.match(cost.fullReads(await list())[0], /^SCAN mails ← /);
  assert.deepEqual(cost.indexes(await list()), []);
  assert.match(cost.fullReads(await cost.record(async () => { all(db, 'SELECT x.id FROM main.mails x WHERE x.subject = ?', 'a'); }))[0], /^SCAN mails ← /, 'an alias after a schema name');
  // an index SQLite makes for one run reads the table as well
  db.exec('CREATE TABLE tags (mail INTEGER, tag TEXT)');
  const auto = await cost.record(async () => { all(db, 'SELECT COUNT(*) FROM folders f, mails a, mails b WHERE a.subject = b.subject AND a.folder = f.id'); });
  assert.ok(cost.fullReads(auto).some((x) => /^SEARCH mails USING AUTOMATIC /.test(x)), cost.fullReads(auto).join('\n'));
});

test('tooSlow: against a unit of the same run — a statement that got slow every time, not one that was slow once; writes are rolled back', async () => {
  const db = database();
  const rec = await cost.record(async () => {
    all(db, 'SELECT * FROM mails WHERE folder = ? ORDER BY date DESC LIMIT 50', 1);
    // every mail against a hundred others: far more than reading each once
    all(db, 'SELECT COUNT(*) FROM mails a NOT INDEXED, (SELECT id, subject FROM mails LIMIT 100) b WHERE a.subject < b.subject');
    db.prepare('UPDATE mails SET subject = subject || ? WHERE folder = ? AND date < ?').run('!', 2, 500);
    db.prepare('INSERT INTO folders (id, name) VALUES (?, ?)').run(9, 'Neu');
  });
  const slow = cost.tooSlow(rec, { unit: UNIT, factor: 2 });
  assert.equal(slow.length, 1, slow.join('\n'));
  assert.match(slow[0], /^\d+\.\d × the unit \(\d+\.\d ms, unit \d+\.\d ms\) ← SELECT COUNT\(\*\) FROM mails a NOT INDEXED/);
  // a run that was slow once (the machine was busy, the disk waited): measured again, it is not
  for (const s of rec.statements.values()) s.ms = 1e6;
  const again = cost.tooSlow(rec, { unit: UNIT, factor: 2 });
  assert.equal(again.length, 1, again.join('\n'));
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM mails WHERE subject LIKE '%!!'")[0].n, 0, 'the UPDATE measured again left nothing behind');
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM mails WHERE subject LIKE '%!'")[0].n, 167, 'and the first one stays');
  // a write that cannot be run again and is no single row counts
  const copy = await cost.record(async () => { db.prepare('INSERT INTO folders (id, name) SELECT 20 + id, name FROM folders').run(); });
  for (const s of copy.statements.values()) s.ms = 1e6;
  assert.match(cost.tooSlow(copy, { unit: UNIT, factor: 2 })[0], /^cannot be run again \(.*UNIQUE.*\), took /);
  assert.throws(() => cost.tooSlow(rec, { factor: 2 }), /unit/);
});

test('ratio: a piece of work in units of another of the same run', async () => {
  const db = database();
  const one = () => all(db, UNIT);
  const r = await cost.ratio(async () => { for (let i = 0; i < 8; i++) one(); }, async () => one());
  assert.ok(r > 4 && r < 16, `eight runs are ${r.toFixed(1)} units`);
});
