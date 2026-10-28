'use strict';

// Empty files (1.5.0): GateControl's media upload takes no empty body (411), so uploads/commit { size: 0 } without a
// mediaId makes a file without a media object — check, content, versions both ways, move, trash, the NAS.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC } = require('./helpers');

const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('empty files: create, check, content, versions both ways, move, trash', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const fam = await c.area(ANNA, 'family');
    assert.equal((await host.upload(ANNA, Buffer.alloc(0), 'text/plain')).status, 411, 'GateControl refuses 0 bytes');

    const r = await a('POST', 'uploads/commit', { parentId: mine.rootId, name: 'leer.txt', size: 0, mime: 'text/plain', mtime: '2026-10-20T10:00:00Z' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.created, true);
    const n = r.json.node;
    assert.deepEqual([n.size, n.mediaId, n.sha256, n.mime, n.rev, n.preview], [0, null, EMPTY, 'text/plain', 1, null]);
    // also with the sha256 of no bytes, { empty: true } and a string "0"; another sha256 is wrong
    assert.equal((await a('POST', 'uploads/commit', { parentId: mine.rootId, name: 'b.txt', size: '0', sha256: EMPTY.toUpperCase() })).status, 200);
    assert.equal((await a('POST', 'uploads/commit', { parentId: mine.rootId, name: 'c.txt', empty: true })).json.node.size, 0);
    assert.equal((await a('POST', 'uploads/commit', { parentId: mine.rootId, name: 'd.txt', size: 0, sha256: 'a'.repeat(64) })).json.field, 'sha256');
    // without a mediaId and not empty: as before
    assert.equal((await a('POST', 'uploads/commit', { parentId: mine.rootId, name: 'e.txt', size: 5 })).json.field, 'mediaId');
    // the same name: conflict as for any file
    const dup = await a('POST', 'uploads/commit', { parentId: mine.rootId, name: 'leer.txt', size: 0 });
    assert.deepEqual([dup.status, dup.json.code, dup.json.current.id], [409, 'conflict', n.id]);

    // check: an empty file is the same as an empty one (with or without the sha256)
    for (const body of [{ size: 0 }, { size: 0, sha256: EMPTY }]) {
      const ck = await a('POST', 'uploads/check', { parentId: mine.rootId, name: 'leer.txt', ...body });
      assert.deepEqual([ck.json.exists, ck.json.same], [true, true], JSON.stringify(body));
    }
    assert.equal((await a('POST', 'uploads/check', { parentId: mine.rootId, name: 'leer.txt', size: 3 })).json.same, false);

    // content: nothing to download
    const ct = await a('GET', `nodes/${n.id}/content`);
    assert.deepEqual(ct.json, { ok: true, url: 'data:text/plain;base64,', name: 'leer.txt', mime: 'text/plain', size: 0, mediaId: null, empty: true });

    // bytes over the empty file: the empty one is a version
    const v2 = await c.put(ANNA, mine.rootId, 'leer.txt', 'hallo', { onConflict: 'version' });
    assert.deepEqual([v2.json.node.size, v2.json.node.rev, v2.json.created], [5, 2, false]);
    let vs = (await a('GET', `nodes/${n.id}/versions`)).json.versions;
    assert.deepEqual(vs.map((v) => [v.rev, v.size, v.sha256]), [[1, 0, EMPTY]]);
    const vc = await a('GET', `nodes/${n.id}/versions/${vs[0].id}/content`);
    assert.deepEqual([vc.json.empty, vc.json.size, vc.json.mediaId, vc.json.rev], [true, 0, null, 1]);
    // restore the empty version: the bytes become a version
    const back = await a('POST', `nodes/${n.id}/versions/${vs[0].id}/restore`);
    assert.deepEqual([back.json.node.size, back.json.node.mediaId, back.json.node.sha256, back.json.node.rev], [0, null, EMPTY, 3]);
    vs = (await a('GET', `nodes/${n.id}/versions`)).json.versions;
    assert.deepEqual(vs.map((v) => v.size), [5]);
    assert.equal((await a('GET', `nodes/${n.id}/versions/${vs[0].id}/content`)).json.empty, undefined);
    // and the bytes again
    const again = await a('POST', `nodes/${n.id}/versions/${vs[0].id}/restore`);
    assert.equal(again.json.node.size, 5);
    assert.match(again.json.node.mediaId, /^[0-9a-f]{32}$/);
    // empty over bytes (onConflict version): the bytes are a version
    const e2 = await a('POST', 'uploads/commit', { parentId: mine.rootId, name: 'leer.txt', size: 0, onConflict: 'version' });
    assert.deepEqual([e2.json.node.size, e2.json.node.mediaId, e2.json.node.mime], [0, null, 'text/plain']);
    vs = (await a('GET', `nodes/${n.id}/versions`)).json.versions;
    assert.deepEqual(vs.map((v) => v.size), [5, 0]);
    // a version without media goes like any other
    const emptyV = vs.find((v) => v.size === 0);
    assert.equal((await a('DELETE', `nodes/${n.id}/versions/${emptyV.id}`)).status, 200);

    // move into the family and rename: no media to move
    const mv = await a('PATCH', `nodes/${n.id}`, { parentId: fam.rootId, name: 'Leer.txt' });
    assert.equal(mv.status, 200);
    assert.equal((await c.as(MARC)('GET', `nodes/${n.id}/content`)).json.empty, true);
    // trash, restore, purge
    assert.equal((await a('DELETE', `nodes/${n.id}`)).json.trashed, 1);
    assert.equal((await a('POST', `trash/${n.id}/restore`)).json.node.size, 0);
    await a('DELETE', `nodes/${n.id}`);
    assert.equal((await a('DELETE', `trash/${n.id}`)).json.files, 1);
    assert.equal((await a('GET', `nodes/${n.id}`)).status, 404);
  });
});

test('empty files: a file the NAS puts at its path is its new content (the empty one a version)', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const n = (await a('POST', 'uploads/commit', { parentId: mine.rootId, name: 'notiz.txt', size: 0 })).json.node;
    await host.mediaScan(`u${ANNA.id}`, [{ type: 'added', path: 'notiz.txt', data: 'vom NAS' }]);
    const now = (await a('GET', `nodes/${n.id}`)).json.node;
    assert.deepEqual([now.size, now.rev], [7, 2]);
    assert.deepEqual((await a('GET', `nodes/${n.id}/versions`)).json.versions.map((v) => v.size), [0]);
  });
});

test('migration 005 on a database of 1.4.0: versions and nodes kept, versions take a null media_id', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const at = files.indexOf('005_devices_marks_empty.sql');
  assert.ok(at > 0);
  const db = new DatabaseSync(':memory:');
  for (const f of files.slice(0, at)) db.exec('BEGIN;' + fs.readFileSync(path.join(dir, f), 'utf8') + ';COMMIT;');
  db.exec(`INSERT INTO nodes (id, area_id, parent_id, name, is_dir, media_id, size, created_at, updated_at) VALUES (7, 'mine:2', 1, 'a.txt', 0, '${'a'.repeat(32)}', 3, 1, 1)`);
  db.exec(`INSERT INTO versions (id, node_id, rev, media_id, size, sha256, at, by) VALUES (4, 7, 1, '${'b'.repeat(32)}', 2, NULL, 5, 2)`);
  db.exec('BEGIN;' + fs.readFileSync(path.join(dir, files[at]), 'utf8') + ';COMMIT;');
  assert.deepEqual({ ...db.prepare('SELECT * FROM versions').get() }, { id: 4, node_id: 7, rev: 1, media_id: 'b'.repeat(32), size: 2, sha256: null, at: 5, by: 2 });
  db.exec(`INSERT INTO versions (node_id, rev, media_id, size, sha256, at) VALUES (7, 2, NULL, 0, '${EMPTY}', 6), (7, 3, NULL, 0, '${EMPTY}', 7)`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM versions WHERE media_id IS NULL').get().n, 2);
  assert.throws(() => db.exec(`INSERT INTO versions (node_id, rev, media_id, size, at) VALUES (7, 4, '${'b'.repeat(32)}', 0, 8)`), /UNIQUE/);
  const n = db.prepare('SELECT delete_at, delete_by, delete_device, delete_device_name FROM nodes WHERE id = 7').get();
  assert.deepEqual({ ...n }, { delete_at: null, delete_by: null, delete_device: null, delete_device_name: null });
  db.close();
});
