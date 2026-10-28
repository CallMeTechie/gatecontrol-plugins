'use strict';

// The overview of the storage (1.7.0, server/storage.js): per area what files, versions and the trash take, the
// largest files, duplicates (the same sha256 and size, empty files not counted) — a person: the areas they read; an
// administrator with all=1: every area and every person; old versions cleaned up by administrators and managers.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ADMIN, ANNA, MARC, LENA, BOB } = require('./helpers');

test('a person: their areas, versions and trash, the largest files, duplicates with canDelete', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const fam = await c.area(ANNA, 'family');
    const child = await c.area(LENA, 'child');
    const big = 'x'.repeat(5000);
    const f1 = (await c.put(ANNA, mine.rootId, 'Gross.bin', big)).json.node;
    const f2 = (await c.put(ANNA, fam.rootId, 'Gross Kopie.bin', big)).json.node;
    const f3 = (await c.put(LENA, child.rootId, 'Gross bei Lena.bin', big)).json.node;
    await c.put(ANNA, mine.rootId, 'Klein.txt', 'klein');
    await c.put(ANNA, mine.rootId, 'Klein.txt', 'kleiner', { onConflict: 'version' });
    const gone = (await c.put(ANNA, mine.rootId, 'Weg.txt', 'weg damit')).json.node;
    await a('DELETE', `nodes/${gone.id}`);
    const empty1 = await a('POST', 'uploads/commit', { parentId: mine.rootId, name: 'Leer.txt', size: 0 });
    const empty2 = await a('POST', 'uploads/commit', { parentId: fam.rootId, name: 'Leer.txt', size: 0 });
    assert.deepEqual([empty1.status, empty2.status], [200, 200]);
    const r = await a('GET', 'storage');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const s = r.json;
    assert.equal(s.all, false);
    assert.deepEqual(s.areas.map((x) => x.id).sort(), [mine.id, fam.id, child.id].sort());
    const m = s.areas.find((x) => x.id === mine.id);
    assert.deepEqual({ bytes: m.bytes, files: m.files, versionsBytes: m.versionsBytes, trashBytes: m.trashBytes, label: m.label, kind: m.kind, canPrune: m.canPrune },
      { bytes: 5000 + 7, files: 3, versionsBytes: 5, trashBytes: 9, label: 'Meine Dateien', kind: 'mine', canPrune: true });
    assert.equal(s.areas.find((x) => x.id === fam.id).canPrune, false, 'a family member writes, does not manage');
    assert.equal(s.total.bytes, 3 * 5000 + 7);
    assert.equal(s.total.files, 6);
    assert.deepEqual(s.people, [], 'only for administrators with all');
    assert.deepEqual(s.largest.slice(0, 3).map((x) => x.size), [5000, 5000, 5000]);
    const l = s.largest.find((x) => x.id === f1.id);
    assert.deepEqual({ name: l.name, areaId: l.areaId, parentId: l.parentId, path: l.path, canDelete: l.canDelete }, { name: 'Gross.bin', areaId: mine.id, parentId: mine.rootId, path: 'Gross.bin', canDelete: true });
    assert.equal(s.largest.find((x) => x.id === f3.id).canDelete, false, 'Lena\'s folder: Anna only reads');
    assert.equal(s.duplicates.length, 1, 'empty files are no duplicates');
    const d = s.duplicates[0];
    assert.deepEqual({ size: d.size, count: d.count, wasted: d.wasted }, { size: 5000, count: 3, wasted: 10000 });
    assert.match(d.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(d.items.map((x) => [x.id, x.canDelete]), [[f1.id, true], [f2.id, true], [f3.id, false]], 'the oldest first');
    // cleaning up: the ordinary delete
    await a('DELETE', `nodes/${f2.id}`);
    const after = (await a('GET', 'storage')).json;
    assert.equal(after.duplicates[0].count, 2);
    // Bob sees only his own
    const bob = (await c.as(BOB)('GET', 'storage')).json;
    assert.deepEqual(bob.areas.map((x) => x.kind), ['mine']);
    assert.deepEqual([bob.largest, bob.duplicates], [[], []]);
    // all=1 of someone who is no administrator: their own
    assert.equal((await a('GET', 'storage', null, { all: '1' })).json.all, false);
  });
});

test('an administrator with all=1: every area and every person (also without a seat); the admin overview in short', async () => {
  await withHost({}, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const bob = await c.area(BOB, 'mine');
    await c.put(ANNA, mine.rootId, 'a.bin', 'a'.repeat(300));
    await c.put(BOB, bob.rootId, 'b.bin', 'b'.repeat(100));
    await c.put(BOB, bob.rootId, 'a-kopie.bin', 'a'.repeat(300));
    const adm = (m, p, b, q) => c.call({ ...ADMIN, portal: true, loggedIn: true }, m, p, b, q);
    assert.equal((await adm('GET', 'storage')).status, 403, 'no seat, not all');
    const r = await adm('GET', 'storage', null, { all: '1' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.all, true);
    assert.ok(r.json.areas.some((x) => x.id === bob.id && x.label === 'Meine Dateien · Bob' && x.canPrune));
    assert.deepEqual(r.json.people.map((p) => [p.user, p.name, p.bytes, p.files]), [[BOB.id, 'Bob', 400, 2], [ANNA.id, 'Anna', 300, 1]]);
    assert.equal(r.json.duplicates.length, 1);
    assert.ok(r.json.duplicates[0].items.every((x) => x.canDelete === false), 'all: the administrator does not write in these areas');
    assert.equal(r.json.total.bytes, 700);
    const ov = (await c.admin('GET', 'admin/overview')).json.overview.storage;
    assert.deepEqual({ bytes: ov.bytes, files: ov.files, groups: ov.duplicates.groups, wasted: ov.duplicates.wastedBytes }, { bytes: 700, files: 3, groups: 1, wasted: 300 });
  });
});

test('old versions cleaned up: managers and administrators, keep the newest, what an undo needs stays', async () => {
  await withHost({}, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const fam = await c.area(ANNA, 'family');
    for (let i = 1; i <= 4; i++) await c.put(ANNA, mine.rootId, 'Text.txt', `fassung ${i}`, { onConflict: 'version' });
    for (let i = 1; i <= 3; i++) await c.put(ANNA, fam.rootId, 'Plan.txt', `plan ${i}`, { onConflict: 'version' });
    const vs = async (id) => (await host.gc.db.get('SELECT COUNT(*) AS n FROM versions v JOIN nodes n ON n.id = v.node_id WHERE n.area_id = ?', [id])).row.n;
    assert.equal(await vs(mine.id), 3);
    for (const keep of [-1, 501, '2', null]) assert.equal((await c.as(ANNA)('POST', 'storage/versions/prune', { areaId: mine.id, keep })).status, 400, String(keep));
    assert.equal((await c.as(MARC)('POST', 'storage/versions/prune', { areaId: fam.id, keep: 0 })).status, 403, 'family members write, nobody manages');
    assert.equal((await c.as(MARC)('POST', 'storage/versions/prune', { areaId: mine.id, keep: 0 })).status, 404, 'not his');
    const r = await c.as(ANNA)('POST', 'storage/versions/prune', { areaId: mine.id, keep: 1 });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.removed, r.json.freedBytes, r.json.more], [2, 18, false]);
    assert.equal(await vs(mine.id), 1);
    const adm = await c.admin('GET', 'admin/overview');
    assert.equal(adm.status, 200);
    const portalAdmin = (m, p, b) => c.call({ ...ADMIN, portal: true, loggedIn: true }, m, p, b);
    const ar = await portalAdmin('POST', 'storage/versions/prune', { areaId: fam.id, keep: 0 });
    assert.equal(ar.status, 200, JSON.stringify(ar.json));
    assert.equal(ar.json.removed, 2);
    assert.equal(await vs(fam.id), 0);
    assert.equal((await portalAdmin('POST', 'storage/versions/prune', { areaId: 'team:99', keep: 0 })).status, 404);
    // a version a time travel made (its undo needs it) stays
    const dir = (await c.as(ANNA)('POST', 'nodes', { parentId: mine.rootId, name: 'Akte' })).json.node;
    await c.put(ANNA, dir.id, 'Akte.txt', 'damals');
    c.clock.add(60000);
    const at = new Date(c.clock.now()).toISOString();
    c.clock.add(60000);
    await c.put(ANNA, dir.id, 'Akte.txt', 'heute', { onConflict: 'version' });
    c.clock.add(60000);
    assert.equal((await c.as(ANNA)('POST', `nodes/${dir.id}/timetravel`, { at })).json.reverted, 1);
    const held = (await c.as(ANNA)('POST', 'storage/versions/prune', { areaId: mine.id, keep: 0 })).json;
    assert.equal(held.removed, 1, 'Text.txt\'s last one; Akte.txt\'s stays');
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM versions WHERE hold_until IS NOT NULL', [])).row.n, 1);
  });
});
