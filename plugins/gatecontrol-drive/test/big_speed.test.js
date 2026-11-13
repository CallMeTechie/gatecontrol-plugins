'use strict';

// 1.29.1 — the statements GateControl's protocol named as slow on a slow disk ("slow plugin database statements"),
// on a Drive of 50 000 photos, 5 000 documents, a trash, three vaults and a change log of 200 000 entries
// (test/big-data.js). No limit in milliseconds, which fails on a busy machine (tools/testing/sql-cost.js): the query
// plan of every statement that runs, and each changed statement against the statement of 1.29.0 on the same data —
// the same rows in the same order.
//   * a page of photos: found in the index, only its rows read (1.29.0: the row of every photo of the areas, to sort)
//   * the photos of a day in earlier years: along the index of the time taken
//   * the folders below a folder (the work folder, a folder's photos): along nodes_dirs (migrations/023_dirs.sql;
//     1.29.0: SQLite made itself an index of every folder for each statement)
//   * the deadlines of the overview and of „Notizen & Aufgaben“: from the deadlines to their files (1.29.0: every node
//     of the areas)
//   * the ends of the change log: each by itself (1.29.0: one pass over the log)
//   * the vaults outside the top folder, every minute: from the vaults (1.29.0: every node)
//   * the stock of the home cache: one statement over the photos with the columns it needs (1.29.0: two with all)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');
const { withHost, ANNA, DAY } = require('./helpers');
const { big, SIZES } = require('./big-data');
const cost = require('../../../tools/testing/sql-cost');
const homecache = require('../server/homecache');
const areas = require('../server/areas');
const vault = require('../server/vault');
const { fakeHub } = require('../../../tools/testing/notizen-hub');

// read as a whole on purpose
const WHOLE = [
  // the newest photos for the previews of the home cache: along the index of the time taken, down to its LIMIT
  /^SCAN nodes USING INDEX nodes_taken ← SELECT id, area_id, .* ORDER BY COALESCE\(taken_at, mtime, created_at\) DESC LIMIT \?$/,
  // the trash, every 5 minutes: its own small index (what is in the trash), never the files
  /^SCAN nodes USING INDEX nodes_trash ← SELECT id FROM nodes WHERE trash_id = id AND deleted_at < \?/,
];
const flat = (sql) => sql.replace(/\s+/g, ' ').trim();
const rowsOf = (s, sql) => s.db.prepare(sql).all(...s.args);
/** The one recorded statement matching `re`. */
function one(rec, re, what) {
  const list = [...rec.statements.values()].filter((s) => re.test(s.sql));
  assert.equal(list.length, 1, `${what}: ${list.length} statements match ${re}`);
  return list[0];
}
/** The statement of the recording gives what `old` (its text in 1.29.0, the same parameters) gives → its plan. */
function sameAsOld(s, old, what) {
  assert.notEqual(flat(old), s.sql, `${what}: the statement of 1.29.0 is another one`);
  const now = rowsOf(s, s.sql);
  assert.ok(now.length > 0, `${what}: no rows`);
  assert.deepEqual(now, rowsOf(s, old), `${what}: other rows than 1.29.0`);
  return cost.plan(s.db, s.sql);
}

test(`a Drive of ${SIZES.photos} photos and ${SIZES.changes} changes: the statements of the protocol go by their indexes and give what 1.29.0 gave`, { timeout: 600000 }, async (t) => {
  const hub = fakeHub();
  await withHost({ gatecontrol: '1.262.0', homeCache: {}, services: [hub] }, async (host, c) => {
    const d = await big(host, c);
    const a = c.as(ANNA);
    const gc = host.gc;
    // a work folder with folders below it: every photo statement of a class walks its tree
    assert.equal((await a('PUT', 'photos/settings', { workFolder: d.folders[5].year, people: true })).status, 200);
    const get = async (p, q) => { const r = await a('GET', p, null, q); assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.json).slice(0, 300)}`); return r.json; };

    // ─── the screens ───
    let first = null;
    let ov = null;
    const rec = await cost.record(async () => {
      ov = await get('overview');
      first = await get('photos', { limit: 120 });
      await get('photos', { limit: 120, before: first.next });
      await get('photos', { class: 'private', limit: 120 });
      await get('photos', { class: 'work' });
      await get('photos', { folder: d.folders[1].year });
      await get('photos/classes');
      await get('photos/memories');
      await get('deadlines');
    });
    assert.equal(first.items.length >= 120, true);
    assert.equal(ov.todo.deadlines.length, 3);
    assert.ok(ov.todo.deadlinesTotal > 100, `${ov.todo.deadlinesTotal} deadlines`);
    assert.ok(ov.activity.length > 0, 'the change log in the overview');
    assert.deepEqual(cost.fullReads(rec), [], 'the screens: a large table read as a whole');
    const used = cost.indexes(rec);
    assert.deepEqual(['nodes_memories', 'nodes_taken', 'nodes_dirs', 'doc_deadlines_date', 'changes_area'].filter((i) => !used.includes(i)), [], 'indexes no statement goes by any more');
    assert.ok(rec.rows < 5000, `${rec.rows} rows given back by the screens`);

    // a page of photos (the protocol: 1 126 ms for 121 rows)
    const PAGE = /^SELECT \* FROM nodes WHERE id IN \(SELECT id FROM (nodes WHERE area_id IN \(\?,\?,\?\) AND is_dir = 0 AND deleted_at IS NULL AND vault_id IS NULL AND \(mime LIKE 'image\/%' OR mime LIKE 'video\/%'\)( AND review_at IS NULL AND parent_id NOT IN \(.*\))?( AND COALESCE\(taken_at, mtime, created_at\) < \?)? ORDER BY COALESCE\(taken_at, mtime, created_at\) DESC, id DESC LIMIT \?)\) ORDER BY COALESCE\(taken_at, mtime, created_at\) DESC, id DESC$/;
    const pages = [...rec.statements.values()].filter((s) => PAGE.test(s.sql));
    assert.equal(pages.length, 3, 'the first page, the next one, the private photos');
    for (const s of pages) {
      const plan = sameAsOld(s, `SELECT * FROM ${PAGE.exec(s.sql)[1]}`, 'a page of photos');
      assert.equal(rowsOf(s, s.sql).length, 121);
      // its ids from the index alone, then 121 rows by their id
      assert.match(plan, /^SEARCH nodes USING INTEGER PRIMARY KEY \(rowid=\?\) \/ LIST SUBQUERY \d+ \/ SEARCH nodes USING COVERING INDEX nodes_memories \(area_id=\? AND is_dir=\? AND deleted_at=\?\)/, s.sql);
      assert.doesNotMatch(plan, /AUTOMATIC|SCAN nodes/);
    }
    // the folders of a tree: the work folder (class), a folder's photos
    const trees = [...rec.statements.values()].filter((s) => /WITH RECURSIVE tree\(id\)/.test(s.sql));
    assert.ok(trees.length >= 4, `${trees.length} statements walk a tree of folders`);
    for (const s of trees) {
      assert.match(s.sql, /FROM nodes n INDEXED BY nodes_dirs JOIN tree/);
      const plan = cost.plan(s.db, s.sql);
      assert.match(plan, /SEARCH n USING COVERING INDEX nodes_dirs \(parent_id=\?/, s.sql);
      assert.doesNotMatch(plan, /AUTOMATIC/, s.sql);
      assert.deepEqual(rowsOf(s, s.sql), rowsOf(s, s.sql.replace(/ INDEXED BY nodes_dirs/g, '')), `other rows than 1.29.0: ${s.sql}`);
    }
    const work = await get('photos', { class: 'work', limit: 200 });
    assert.equal(work.items.length, 200);
    assert.ok(work.items.every((x) => x.work === true && x.parentId === d.folders[5].id), 'the photos below the work folder');
    // the photos of this day in earlier years
    const days = [...rec.statements.values()].filter((s) => /COALESCE\(taken_at, mtime, created_at\) >= \? AND COALESCE\(taken_at, mtime, created_at\) < \? ORDER BY COALESCE\(taken_at, mtime, created_at\), id LIMIT/.test(s.sql));
    assert.equal(days.length, 2, 'GET photos/memories and the overview');
    assert.ok(days.some((s) => s.runs >= 10), 'one statement per earlier year');
    for (const s of days) {
      assert.deepEqual(rowsOf(s, s.sql), rowsOf(s, s.sql.replace(' INDEXED BY nodes_taken', '')), `other rows than 1.29.0: ${s.sql}`);
      assert.match(cost.plan(s.db, s.sql), /SEARCH nodes USING INDEX nodes_taken \(<expr>>\? AND <expr><\?\)/, s.sql);
    }
    // the deadlines: how many (the overview); the next three and the list (one statement)
    const dls = [...rec.statements.values()].filter((s) => /FROM doc_deadlines d CROSS JOIN nodes n ON n\.id = d\.node_id/.test(s.sql));
    assert.equal(dls.length, 2);
    for (const s of dls) {
      const plan = sameAsOld(s, s.sql.replace('CROSS JOIN nodes', 'JOIN nodes'), 'deadlines');
      assert.match(plan, /^SEARCH d USING INDEX doc_deadlines_date \(date>\? AND date<\?\) \/ SEARCH n USING INTEGER PRIMARY KEY \(rowid=\?\)$/, s.sql);
    }
    // the ends of the change log
    const ends = one(rec, /MIN\(seq\).*MAX\(seq\)/, 'the ends of the change log');
    assert.match(sameAsOld(ends, 'SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM changes', 'the ends of the change log'), /^SCAN CONSTANT ROW \/ SCALAR SUBQUERY \d+ \/ SEARCH changes \/ SCALAR SUBQUERY \d+ \/ SEARCH changes$/);
    assert.deepEqual(rowsOf(ends, ends.sql).map((r) => ({ ...r })), [{ lo: 1, hi: SIZES.changes }]);

    // ─── the background run: the housekeeping, the vaults, „Notizen & Aufgaben“, the home cache ───
    let out = null;
    const bg = await cost.record(async () => { out = await host.tick(); });
    assert.ok(out && out.homeCache && !out.homeCache.skipped, JSON.stringify(out && out.homeCache));
    assert.deepEqual(cost.fullReads(bg, { allow: WHOLE }), [], 'the background run: a large table read as a whole');
    // the deadlines for „Notizen & Aufgaben“ (every two minutes): as the overview's
    const hubSql = one(bg, /FROM doc_deadlines d CROSS JOIN nodes n ON n\.id = d\.node_id/, 'the deadlines for the hub');
    assert.match(sameAsOld(hubSql, hubSql.sql.replace('CROSS JOIN nodes', 'JOIN nodes'), 'the deadlines for the hub'), /^SEARCH d USING INDEX doc_deadlines_date \(date>\? AND date<\?\) \/ SEARCH n USING INTEGER PRIMARY KEY \(rowid=\?\)$/);
    assert.ok(hub.items.size > 100, `${hub.items.size} deadlines in the hub`);
    // the vaults outside the top folder (every minute; the protocol: 5 794 ms)
    const roots = one(bg, /FROM vaults v /, 'vaults to the top folder');
    const OLD_ROOTS = roots.sql.replace(/CROSS JOIN/g, 'JOIN');
    const rootsPlan = cost.plan(roots.db, roots.sql);
    assert.match(rootsPlan, /^SCAN v USING COVERING INDEX \S+ \/ SEARCH n USING INTEGER PRIMARY KEY \(rowid=\?\) \/ SEARCH a USING INDEX \S+ \(id=\?\)/);
    assert.doesNotMatch(rootsPlan, /SCAN n\b/);
    assert.deepEqual(rowsOf(roots, roots.sql), []);
    // one of them below a folder: both statements find it, the run brings it back
    const v = d.vaults[0];
    await gc.db.run('DELETE FROM nodes WHERE parent_id = ?', [v.nodeId]); // (its files have no bytes in the mock host to move)
    await gc.db.run('UPDATE nodes SET parent_id = ? WHERE id = ?', [d.folders[0].id, v.nodeId]);
    assert.deepEqual(rowsOf(roots, roots.sql).map((r) => r.id), [v.nodeId]);
    assert.deepEqual(rowsOf(roots, roots.sql), rowsOf(roots, OLD_ROOTS));
    assert.deepEqual([...await vault.toRoots(gc, Date.now())], [v.area]);
    assert.equal((await gc.db.get('SELECT parent_id FROM nodes WHERE id = ?', [v.nodeId])).row.parent_id, d.mine.rootId);

    // the stock of the home cache (the protocol: 200–240 ms about every hour): one statement over the photos, not two,
    // with the columns the stock needs — and no other statement of the run gives back a thousand whole rows
    const stock = one(bg, /^SELECT .* FROM nodes WHERE is_dir = 0 AND deleted_at IS NULL AND vault_id IS NULL AND \(mime LIKE /, 'the photos of the stock');
    assert.match(stock.sql, /^SELECT id, area_id, is_dir, media_id, size, sha256, mime, vault_id, taken_at, mtime, created_at, content_at, updated_at FROM nodes /);
    assert.equal(stock.rows, homecache.PREVIEW_PHOTOS);
    assert.deepEqual([...bg.statements.values()].filter((s) => /^SELECT (\*|\w+\.\*|.*, \w+\.\*) FROM/.test(s.sql) && / nodes\b/.test(s.sql) && s.rows / s.runs >= 1000).map((s) => s.sql), []);
    // what should be in the stock is what the two statements of 1.29.0 give: the photos of 90 days as offers of the
    // kind photos (30 days: priority 40), the newest PREVIEW_PHOTOS as small previews
    const now = Date.now();
    const OLD_PHOTOS = "FROM nodes WHERE is_dir = 0 AND deleted_at IS NULL AND vault_id IS NULL AND (COALESCE(mime, '') LIKE 'image/%' OR COALESCE(mime, '') LIKE 'video/%') AND media_id IS NOT NULL AND size > 0";
    const T = 'COALESCE(taken_at, mtime, created_at)';
    const old90 = stock.db.prepare(`SELECT * ${OLD_PHOTOS} AND ${T} >= ? ORDER BY ${T} DESC LIMIT ?`).all(now - 90 * DAY, 4000);
    const oldGrid = stock.db.prepare(`SELECT * ${OLD_PHOTOS} ORDER BY ${T} DESC LIMIT ?`).all(homecache.PREVIEW_PHOTOS);
    assert.equal(old90.length, 4000);
    assert.equal(oldGrid.length, homecache.PREVIEW_PHOTOS);
    const want = await homecache.wanted(gc, now, await areas.settingsOf(gc), { previews: true });
    const taken = (n) => (n.taken_at != null ? n.taken_at : n.mtime);
    const photos = [...want.values()].filter((w) => !w.preview && w.kind === 'photos');
    assert.deepEqual(photos.map((w) => [w.key, w.priority]).sort(), old90.map((n) => [n.sha256, now - taken(n) <= 30 * DAY ? homecache.PRIO.photo30 : homecache.PRIO.photo]).sort());
    assert.deepEqual(photos.map((w) => w.mediaIds).flat().sort(), old90.map((n) => n.media_id).sort());
    const small = [...want.values()].filter((w) => w.preview === 'small');
    assert.deepEqual(small.map((w) => w.key).sort(), oldGrid.map((n) => `ps:${n.sha256}`).sort());
    // without previews (an older GateControl): the photos of 90 days alone, as before
    const plain = await homecache.wanted(gc, now, await areas.settingsOf(gc), {});
    assert.deepEqual([...plain.values()].filter((w) => w.kind === 'photos').map((w) => w.key).sort(), old90.map((n) => n.sha256).sort());
    assert.ok([...plain.values()].every((w) => !w.preview));

    t.diagnostic(`screens: ${rec.runs} statements, ${rec.rows} rows; background run: ${bg.runs} statements, ${bg.rows} rows`);
  });
});

test('migration 023 on a database of 1.29.0 with data: the folders are in nodes_dirs, the walk down a tree gives the same folders', () => {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const at = files.indexOf('023_dirs.sql');
  assert.equal(at, 22);
  const db = new sqlite.DatabaseSync(':memory:');
  try {
    for (const f of files.slice(0, at)) db.exec(`BEGIN;${fs.readFileSync(path.join(dir, f), 'utf8')};COMMIT;`);
    // data of 1.29.0: a tree of 400 folders four deep (every 9th in the trash, every 14th a vault) with 20 000 files
    db.exec(`BEGIN;
      INSERT INTO nodes (id, area_id, parent_id, name, is_dir, created_at, updated_at) VALUES (1, 'mine:2', NULL, '', 1, 1, 1);
      WITH RECURSIVE s(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM s WHERE i < 401)
        INSERT INTO nodes (id, area_id, parent_id, name, is_dir, created_at, updated_at, deleted_at, vault_id)
        SELECT i, 'mine:2', MAX(1, i / 4), 'Ordner ' || i, 1, i, i, CASE WHEN i % 9 = 0 THEN 5 END, CASE WHEN i % 14 = 0 THEN 'v1' END FROM s;
      WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 20000)
        INSERT INTO nodes (id, area_id, parent_id, name, is_dir, media_id, size, mime, created_at, updated_at)
        SELECT 1000 + i, 'mine:2', 1 + i % 401, 'IMG_' || i || '.jpg', 0, printf('%032x', i), 1000 + i, 'image/jpeg', i, i FROM s;
      COMMIT;`);
    const sum = () => db.prepare('SELECT COUNT(*) AS n, SUM(id + COALESCE(parent_id, 0) + is_dir + COALESCE(deleted_at, 0)) AS s FROM nodes').get();
    const before = sum();
    const TREE = (from) => `WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT n.id FROM ${from} JOIN tree ON n.parent_id = tree.id WHERE n.is_dir = 1 AND n.deleted_at IS NULL AND n.vault_id IS NULL) SELECT id FROM tree`;
    const walk = (from, top) => db.prepare(`${TREE(from)} ORDER BY id`).all(top).map((r) => r.id);
    const old = { all: walk('nodes n', 1), part: walk('nodes n', 3) };
    assert.ok(old.all.length > 100 && old.all.length < 401 && old.part.length > 10, `${old.all.length} / ${old.part.length} folders`);
    assert.throws(() => db.prepare(TREE('nodes n INDEXED BY nodes_dirs')), /no such index: nodes_dirs/);
    // as GateControl runs migrations: in one transaction
    db.exec(`BEGIN;${fs.readFileSync(path.join(dir, files[at]), 'utf8')};COMMIT;`);
    assert.deepEqual(sum(), before, 'no row changed');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual({ all: walk('nodes n INDEXED BY nodes_dirs', 1), part: walk('nodes n INDEXED BY nodes_dirs', 3) }, old);
    // only folders are in it: as many entries as folders, a file never
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nodes INDEXED BY nodes_dirs WHERE is_dir = 1').get().n, 401);
    // inside a statement over the photos (where SQLite made itself an index of the folders for every run before)
    const inside = `SELECT COUNT(*) AS n FROM nodes WHERE area_id IN (?, ?) AND is_dir = 0 AND deleted_at IS NULL AND vault_id IS NULL AND (mime LIKE 'image/%' OR mime LIKE 'video/%') AND review_at IS NULL AND parent_id NOT IN (${TREE('nodes n INDEXED BY nodes_dirs')})`;
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${inside}`).all('mine:2', 'family:10', 3).map((r) => r.detail).join(' / ');
    assert.match(plan, /SEARCH n USING COVERING INDEX nodes_dirs \(parent_id=\?/);
    assert.doesNotMatch(plan, /AUTOMATIC/);
    assert.equal(db.prepare(inside).get('mine:2', 'family:10', 3).n, db.prepare(inside.replace(' INDEXED BY nodes_dirs', '')).get('mine:2', 'family:10', 3).n);
    // folders made, moved, deleted and restored after the migration keep it right
    db.exec("INSERT INTO nodes (id, area_id, parent_id, name, is_dir, created_at, updated_at) VALUES (900, 'mine:2', 3, 'Neu', 1, 1, 1); UPDATE nodes SET parent_id = 900 WHERE id = 13; UPDATE nodes SET deleted_at = 7 WHERE id = 15; UPDATE nodes SET deleted_at = NULL WHERE id = 9;");
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(walk('nodes n INDEXED BY nodes_dirs', 3), walk('nodes n NOT INDEXED', 3));
    assert.ok(walk('nodes n INDEXED BY nodes_dirs', 3).includes(900));
  } finally { db.close(); }
});
