'use strict';

// Work photos apart (1.13.0, feature photoClasses — server/work.js, server/photos.js): the person's work folder
// (GET|PUT photos/settings), the review mark (POST photos/review, `review` on nodes and photo items, op 'review'),
// class= on photos and months, GET photos/classes, the mark ending on a move into or out of the work folder (PATCH and
// a move job), memories and the photo frame without the work folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const ops = require('../server/ops');
const { withHost, ANNA, MARC, OMA } = require('./helpers');

const mkdir = async (c, user, parentId, name) => {
  const r = await c.as(user)('POST', 'nodes', { parentId, name });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.node;
};

/** Anna's files: Bilder/Kamera-Uploads/2026/10 with four photos and a text, Arbeit with one photo. */
async function setup(c) {
  const a = c.as(ANNA);
  const mine = await c.area(ANNA, 'mine');
  const cam = (await a('POST', 'photos/camera')).json.folder;
  const y = await mkdir(c, ANNA, cam.id, '2026');
  const m = await mkdir(c, ANNA, y.id, '10');
  const arbeit = await mkdir(c, ANNA, mine.rootId, 'Arbeit');
  const base = Date.UTC(2026, 9, 20, 12);
  const put = async (parentId, name, t, mime = 'image/jpeg') => {
    const r = await c.put(ANNA, parentId, name, name, { mime, takenAt: t });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.node;
  };
  const p = {
    p1: await put(m.id, 'p1.jpg', base),
    p2: await put(m.id, 'p2.jpg', base + 1000),
    p3: await put(m.id, 'p3.mp4', base + 2000, 'video/mp4'),
    p4: await put(m.id, 'p4.jpg', base + 3000),
    txt: await put(m.id, 'notiz.txt', base + 4000, 'text/plain'),
    w1: await put(arbeit.id, 'w1.jpg', base + 5000),
  };
  return { a, mine, cam, y, m, arbeit, base, put, ...p };
}

const names = (r) => r.json.items.map((x) => x.name).sort();

test('photos/settings: defaults, the work folder checked, the same on every device', async () => {
  await withHost({}, async (host, c) => {
    const t = await setup(c);
    const { a } = t;
    assert.ok((await a('GET', 'me')).json.features.includes('photoClasses'));
    let r = await a('GET', 'photos/settings');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.workFolder, r.json.workSubfolders, r.json.workInMemories, r.json.folder], [null, true, false, null]);
    // what is not a folder one writes to outside the camera uploads: 400 with the reason
    const bad = async (workFolder, reason) => {
      const x = await a('PUT', 'photos/settings', { workFolder });
      assert.equal(x.status, 400, JSON.stringify(x.json));
      assert.deepEqual([x.json.code, x.json.field, x.json.reason], ['invalid', 'workFolder', reason]);
    };
    await bad(t.w1.id, 'not_folder');
    await bad(999999, 'not_found');
    await bad('abc', 'not_found');
    await bad(t.mine.rootId, 'camera');
    await bad(t.cam.id, 'camera');
    const bilder = (await a('GET', 'nodes/by-path', null, { area: t.mine.id, path: 'Bilder' })).json.node;
    await bad(bilder.id, 'camera');
    const marcs = await c.area(MARC, 'mine');
    const secret = await mkdir(c, MARC, marcs.rootId, 'Geheim');
    await bad(secret.id, 'not_found');
    const fam = await c.area(ANNA, 'family');
    const famFolder = await mkdir(c, ANNA, fam.rootId, 'Ablage');
    assert.equal((await c.as(MARC)('PUT', 'photos/settings', { workSubfolders: 'yes' })).json.field, 'workSubfolders');
    // below the camera uploads is fine, so is a folder of another area one writes to
    r = await a('PUT', 'photos/settings', { workFolder: t.m.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await a('PUT', 'photos/settings', { workFolder: famFolder.id });
    assert.equal(r.json.folder.areaId, fam.id);
    r = await a('PUT', 'photos/settings', { workFolder: t.arbeit.id, workInMemories: true });
    assert.deepEqual([r.json.workFolder, r.json.workSubfolders, r.json.workInMemories], [t.arbeit.id, true, true]);
    assert.deepEqual(r.json.folder, { id: t.arbeit.id, path: 'Arbeit', areaId: t.mine.id });
    // only what is sent changes; the portal and another device see the same
    r = await c.portal(ANNA)('PUT', 'photos/settings', { workSubfolders: false });
    assert.deepEqual([r.json.workFolder, r.json.workSubfolders, r.json.workInMemories], [t.arbeit.id, false, true]);
    r = await c.as(ANNA, 'tablet-2')('GET', 'photos/settings');
    assert.deepEqual([r.json.workFolder, r.json.workSubfolders, r.json.workInMemories], [t.arbeit.id, false, true]);
    // Marc's settings are his
    assert.equal((await c.as(MARC)('GET', 'photos/settings')).json.workFolder, null);
    // the work folder in the trash: none (kept — back after the restore)
    await a('DELETE', `nodes/${t.arbeit.id}`);
    assert.equal((await a('GET', 'photos/settings')).json.workFolder, null);
    assert.equal((await a('POST', `trash/${t.arbeit.id}/restore`)).status, 200);
    assert.equal((await a('GET', 'photos/settings')).json.workFolder, t.arbeit.id);
    // none again
    r = await a('PUT', 'photos/settings', { workFolder: null });
    assert.equal(r.json.workFolder, null);
  });
});

test('review marks: set with a hint, the classes, the filters, the items, the change log', async () => {
  await withHost({}, async (host, c) => {
    const t = await setup(c);
    const { a } = t;
    // without a work folder: everything private
    let k = await a('GET', 'photos/classes');
    assert.deepEqual([k.json.work, k.json.private, k.json.review], [0, 5, 0]);
    assert.equal((await a('PUT', 'photos/settings', { workFolder: t.arbeit.id })).status, 200);
    const seq = (await a('GET', 'me')).json.latest;
    let r = await a('POST', 'photos/review', { ids: [t.p1.id, t.p2.id, t.p3.id], review: true, hint: 72.4 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.changed, 3);
    assert.deepEqual(r.json.items, [t.p1, t.p2, t.p3].map((n) => ({ id: n.id, review: { hint: 72 } })));
    // the same again: nothing changes; without a hint the hint stays; a new hint replaces it
    assert.equal((await a('POST', 'photos/review', { ids: [t.p1.id], review: true, hint: 72 })).json.changed, 0);
    r = await a('POST', 'photos/review', { ids: [t.p2.id], review: true });
    assert.deepEqual([r.json.changed, r.json.items[0].review], [0, { hint: 72 }]);
    r = await a('POST', 'photos/review', { ids: [t.p3.id], review: true, hint: null });
    assert.deepEqual([r.json.changed, r.json.items[0].review], [1, { hint: null }]);
    // the change log: op review with the node as it is now
    const ch = (await a('GET', 'changes', null, { since: String(seq) })).json.changes;
    assert.deepEqual(ch.map((x) => [x.op, x.nodeId]), [['review', t.p1.id], ['review', t.p2.id], ['review', t.p3.id], ['review', t.p3.id]]);
    assert.deepEqual(ch[0].node.review, { hint: 72 });
    // the node: `review` while marked, gone else
    assert.deepEqual((await a('GET', `nodes/${t.p1.id}`)).json.node.review, { hint: 72 });
    assert.equal('review' in (await a('GET', `nodes/${t.p4.id}`)).json.node, false);
    const kids = (await a('GET', `nodes/${t.m.id}/children`)).json.items;
    assert.deepEqual(kids.filter((x) => x.review).map((x) => x.name).sort(), ['p1.jpg', 'p2.jpg', 'p3.mp4']);
    // the classes: apart from each other, together all of them
    k = await a('GET', 'photos/classes');
    assert.deepEqual([k.json.work, k.json.private, k.json.review], [1, 1, 3]);
    assert.deepEqual(names(await a('GET', 'photos', null, { class: 'review' })), ['p1.jpg', 'p2.jpg', 'p3.mp4']);
    assert.deepEqual(names(await a('GET', 'photos', null, { class: 'work' })), ['w1.jpg']);
    assert.deepEqual(names(await a('GET', 'photos', null, { class: 'private' })), ['p4.jpg']);
    assert.deepEqual((await a('GET', 'photos/months', null, { class: 'review' })).json.months, [{ month: '2026-10', count: 3 }]);
    assert.deepEqual((await a('GET', 'photos/months', null, { class: 'work', camera: '1' })).json.months, []);
    assert.equal((await a('GET', 'photos', null, { class: 'arbeit' })).json.field, 'class');
    // camera=1 narrows the counts too
    k = await a('GET', 'photos/classes', null, { camera: '1' });
    assert.deepEqual([k.json.work, k.json.private, k.json.review], [0, 1, 3]);
    // the items: review and work (the bag)
    const items = new Map((await a('GET', 'photos')).json.items.map((x) => [x.name, x]));
    assert.deepEqual(items.get('p1.jpg').review, { hint: 72 });
    assert.equal(items.get('p1.jpg').work, false);
    assert.deepEqual([items.get('w1.jpg').review, items.get('w1.jpg').work], [null, true]);
    assert.deepEqual([items.get('p4.jpg').review, items.get('p4.jpg').work], [null, false]);
    // review: false ends it
    r = await a('POST', 'photos/review', { ids: [t.p2.id], review: false, hint: 10 });
    assert.deepEqual([r.json.changed, r.json.items], [1, [{ id: t.p2.id, review: null }]]);
    assert.equal('review' in (await a('GET', `nodes/${t.p2.id}`)).json.node, false);
    // all or nothing: not a photo, unknown, someone else's — invalid with the ids; nothing changed
    r = await a('POST', 'photos/review', { ids: [t.p4.id, t.txt.id, 999999], review: true });
    assert.equal(r.status, 400);
    assert.deepEqual([r.json.field, r.json.ids], ['ids', [t.txt.id, 999999]]);
    assert.equal('review' in (await a('GET', `nodes/${t.p4.id}`)).json.node, false);
    r = await c.as(MARC)('POST', 'photos/review', { ids: [t.p4.id], review: true });
    assert.deepEqual([r.status, r.json.ids], [400, [t.p4.id]]);
    for (const body of [{ ids: [t.p4.id] }, { ids: [], review: true }, { ids: [t.p4.id], review: true, hint: 101 }, { ids: [t.p4.id], review: true, hint: 'viel' }]) {
      assert.equal((await a('POST', 'photos/review', body)).status, 400, JSON.stringify(body));
    }
  });
});

test('review marks: read-only photos are forbidden', async () => {
  await withHost({}, async (host, c) => {
    const fam = await c.area(ANNA, 'family');
    const pic = (await c.put(ANNA, fam.rootId, 'fest.jpg', 'x', { mime: 'image/jpeg' })).json.node;
    // an archived area: nobody writes
    const area = (await c.as(ANNA)('GET', 'me')).json.areas.find((x) => x.id === fam.id);
    assert.ok(area);
    await host.gc.db.run('UPDATE areas SET archived_at = 1 WHERE id = ?', [fam.id]);
    const r = await c.as(ANNA)('POST', 'photos/review', { ids: [pic.id], review: true });
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.deepEqual([r.json.field, r.json.ids], ['ids', [pic.id]]);
  });
});

test('a move into or out of the work folder ends the mark — PATCH, a folder with photos, a move job; within private it stays', async () => {
  await withHost({}, async (host, c) => {
    const t = await setup(c);
    const { a } = t;
    assert.equal((await a('PUT', 'photos/settings', { workFolder: t.arbeit.id })).status, 200);
    await a('POST', 'photos/review', { ids: [t.p1.id, t.p2.id, t.p3.id, t.p4.id], review: true, hint: 60 });
    // within private: stays
    const other = await mkdir(c, ANNA, t.mine.rootId, 'Urlaub');
    let r = await a('PATCH', `nodes/${t.p1.id}`, { parentId: other.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.node.review, { hint: 60 });
    // into the work folder (a sub folder of it): gone
    const sub = await mkdir(c, ANNA, t.arbeit.id, '2026');
    r = await a('PATCH', `nodes/${t.p1.id}`, { parentId: sub.id });
    assert.equal('review' in r.json.node, false);
    // marked again inside the work folder, then out of it: gone
    await a('POST', 'photos/review', { ids: [t.p1.id], review: true });
    assert.deepEqual((await a('GET', 'photos/classes')).json.review, 4);
    r = await a('PATCH', `nodes/${t.p1.id}`, { parentId: t.m.id });
    assert.equal('review' in r.json.node, false);
    // a folder with marked photos below it into the work folder: every mark ends, each in the change log
    const box = await mkdir(c, ANNA, t.mine.rootId, 'Kiste');
    const inner = await mkdir(c, ANNA, box.id, 'innen');
    await a('PATCH', `nodes/${t.p2.id}`, { parentId: inner.id });
    assert.deepEqual((await a('GET', `nodes/${t.p2.id}`)).json.node.review, { hint: 60 });
    const seq = (await a('GET', 'me')).json.latest;
    assert.equal((await a('PATCH', `nodes/${box.id}`, { parentId: t.arbeit.id })).status, 200);
    assert.equal('review' in (await a('GET', `nodes/${t.p2.id}`)).json.node, false);
    const ch = (await a('GET', 'changes', null, { since: String(seq) })).json.changes;
    assert.deepEqual(ch.map((x) => [x.op, x.nodeId]), [['review', t.p2.id], ['move', box.id]]);
    // Marc has no work folder: a move by him changes no mark (the family area — he writes there)
    const fam = await c.area(ANNA, 'family');
    const fp = (await c.put(ANNA, fam.rootId, 'fam.jpg', 'f', { mime: 'image/jpeg' })).json.node;
    const ff = await mkdir(c, ANNA, fam.rootId, 'Ordner');
    await a('POST', 'photos/review', { ids: [fp.id], review: true });
    r = await c.as(MARC)('PATCH', `nodes/${fp.id}`, { parentId: ff.id });
    assert.deepEqual(r.json.node.review, { hint: null });
    // a move job (several at once) into the work folder: the marks end; its undo leaves them ended
    r = await a('POST', 'ops', { op: 'move', ids: [t.p3.id, t.p4.id], target: t.arbeit.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await ops.idle();
    const op = (await a('GET', `ops/${r.json.op.id}`)).json.op;
    assert.equal(op.state, 'done');
    for (const n of [t.p3, t.p4]) {
      const v = (await a('GET', `nodes/${n.id}`)).json.node;
      assert.deepEqual([v.parentId, 'review' in v], [t.arbeit.id, false]);
    }
    assert.deepEqual(names(await a('GET', 'photos', null, { class: 'work' })), ['p2.jpg', 'p3.mp4', 'p4.jpg', 'w1.jpg']);
    assert.equal((await a('POST', `ops/${op.id}/undo`)).status, 200);
    await ops.idle();
    assert.equal((await a('GET', `nodes/${t.p3.id}`)).json.node.parentId, t.m.id);
    assert.equal('review' in (await a('GET', `nodes/${t.p3.id}`)).json.node, false);
  });
});

test('memories and the photo frame leave the work folder out unless workInMemories', async () => {
  await withHost({ gatecontrol: '1.210.0' }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const arbeit = await mkdir(c, ANNA, mine.rootId, 'Arbeit');
    const sub = await mkdir(c, ANNA, arbeit.id, '2025');
    const ago = Date.UTC(2025, 9, 26, 12);
    const home = (await c.put(ANNA, mine.rootId, 'zuhause.jpg', 'z', { mime: 'image/jpeg', takenAt: ago })).json.node;
    const job = (await c.put(ANNA, sub.id, 'baustelle.jpg', 'b', { mime: 'image/jpeg', takenAt: ago + 1000 })).json.node;
    const mem = async () => (await a('GET', 'photos/memories', null, { date: '2026-10-26' })).json.groups.flatMap((g) => g.items.map((x) => x.name)).sort();
    // no work folder yet: both
    assert.deepEqual(await mem(), ['baustelle.jpg', 'zuhause.jpg']);
    await a('PUT', 'photos/settings', { workFolder: arbeit.id });
    assert.deepEqual(await mem(), ['zuhause.jpg']);
    // the frame: an album of Anna's on it
    const al = (await a('POST', 'albums', { name: 'Wand' })).json.album;
    await a('POST', `albums/${al.id}/items`, { ids: [home.id, job.id] });
    assert.equal((await a('PATCH', `albums/${al.id}`, { frame: true })).status, 200);
    const KIOSK = { ...OMA, portal: true, loggedIn: true, kiosk: true };
    const frame = async () => (await c.call(KIOSK, 'GET', 'frame')).json.items.length;
    assert.equal(await frame(), 1);
    // the album itself still shows both
    assert.equal((await a('GET', `albums/${al.id}`)).json.items.length, 2);
    await a('PUT', 'photos/settings', { workInMemories: true });
    assert.deepEqual(await mem(), ['baustelle.jpg', 'zuhause.jpg']);
    assert.equal(await frame(), 2);
  });
});
