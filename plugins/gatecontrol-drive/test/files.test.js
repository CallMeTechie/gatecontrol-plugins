'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, BOB, FAMILY } = require('./helpers');

const pathOf = (host, mediaId) => { const m = host.mediaStore ? host.mediaStore.get(mediaId) : null; return m ? m.path : undefined; };

test('folders and files: create, rename, move — the media follow their paths', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const f = await a('POST', 'nodes', { parentId: mine.rootId, name: 'Fotos' });
    assert.equal(f.status, 200);
    const sub = await a('POST', 'nodes', { parentId: f.json.node.id, name: '2026' });
    const up = await c.put(ANNA, sub.json.node.id, 'Strand.jpg', 'jpeg', { mime: 'image/jpeg' });
    assert.equal(up.status, 200);
    assert.equal(up.json.created, true);
    const file = up.json.node;
    assert.equal(file.size, 4);
    let info = (await host.request({ method: 'GET', path: `nodes/${file.id}`, user: { ...ANNA, portal: true, loggedIn: true } })).json.node;
    assert.equal(info.path, 'Fotos/2026/Strand.jpg');
    assert.deepEqual(info.crumbs.map((x) => x.name), ['', 'Fotos', '2026']);
    // the same name again: exists (folder), case does not matter
    const dup = await a('POST', 'nodes', { parentId: mine.rootId, name: 'fotos' });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.code, 'exists');
    const free = await a('POST', 'nodes', { parentId: mine.rootId, name: 'Fotos', rename: true });
    assert.equal(free.json.node.name, 'Fotos (2)');
    // bad names
    for (const name of ['', 'a/b', 'x:y', 'dot.', '..', '.gcdrive']) {
      assert.equal((await a('POST', 'nodes', { parentId: mine.rootId, name })).status, 400, name);
    }
    // rename the folder: the file's media path follows
    const ren = await a('PATCH', `nodes/${f.json.node.id}`, { name: 'Bilder' });
    assert.equal(ren.status, 200);
    let m = await host.request({ method: 'GET', path: `nodes/${file.id}`, user: { ...ANNA, portal: true, loggedIn: true } });
    assert.equal(m.json.node.path, 'Bilder/2026/Strand.jpg');
    const media = await c.as(ANNA)('GET', `nodes/${file.id}/content`);
    assert.equal(media.status, 200);
    assert.match(media.json.url, /^\/plugin-media\//);
    // move the file to the top
    const mv = await a('PATCH', `nodes/${file.id}`, { parentId: mine.rootId });
    assert.equal(mv.status, 200);
    m = await a('GET', 'nodes/by-path', null, { area: mine.id, path: 'Strand.jpg' });
    assert.equal(m.json.node.id, file.id);
    // a folder into itself: invalid
    assert.equal((await a('PATCH', `nodes/${f.json.node.id}`, { parentId: sub.json.node.id })).status, 400);
    // the root: invalid
    assert.equal((await a('DELETE', `nodes/${mine.rootId}`)).status, 400);
    // children: folders first
    const list = await a('GET', `nodes/${mine.rootId}/children`);
    assert.deepEqual(list.json.items.map((x) => x.name), ['Bilder', 'Fotos (2)', 'Strand.jpg']);
    // search
    const s = await a('GET', 'search', null, { q: 'stra' });
    assert.deepEqual(s.json.items.map((x) => x.path), ['Strand.jpg']);
    assert.equal((await a('GET', 'search', null, { q: 's' })).status, 400);
  });
});

test('move into another area: the media go along; versions stay behind', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const fam = await c.area(ANNA, 'family');
    const d = await a('POST', 'nodes', { parentId: mine.rootId, name: 'Urlaub' });
    const up = await c.put(ANNA, d.json.node.id, 'Plan.txt', 'v1');
    await c.put(ANNA, d.json.node.id, 'Plan.txt', 'v2', { baseRev: 1 });
    const mv = await a('PATCH', `nodes/${d.json.node.id}`, { parentId: fam.rootId });
    assert.equal(mv.status, 200);
    assert.equal(mv.json.node.areaId, `family:${FAMILY}`);
    const node = (await a('GET', `nodes/${up.json.node.id}`)).json.node;
    assert.equal(node.areaId, `family:${FAMILY}`);
    assert.equal(node.path, 'Urlaub/Plan.txt');
    const info = await host.request({ method: 'GET', path: `nodes/${up.json.node.id}/versions`, user: { ...MARC, portal: true, loggedIn: true } });
    assert.equal(info.status, 200);
    assert.equal(info.json.versions.length, 1);
    // Marc sees it in the family now; the change log of Anna's area says it went
    const ch = await a('GET', 'changes', null, { since: 0 });
    const last = ch.json.changes.filter((x) => x.nodeId === d.json.node.id);
    assert.deepEqual(last.map((x) => `${x.op}@${x.areaId}`), [`create@mine:${ANNA.id}`, `delete@mine:${ANNA.id}`, `create@family:${FAMILY}`]);
    assert.equal(last[1].node, null);
    // the old version restores into the family area
    const vid = info.json.versions[0].id;
    const r = await c.as(MARC)('POST', `nodes/${up.json.node.id}/versions/${vid}/restore`);
    assert.equal(r.status, 200);
    assert.equal(r.json.node.size, 2);
    assert.equal(r.json.node.rev, 3);
    const content = await c.as(MARC)('GET', `nodes/${up.json.node.id}/content`);
    const got = await host.mediaFromUrl(content.json.url);
    assert.equal(String(got.body), 'v1');
  });
});

test('uploads: conflicts, baseRev, onConflict, check, versions and their limit', async () => {
  await withHost({ settings: { versions_max: 2 } }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const v1 = await c.put(ANNA, mine.rootId, 'Brief.txt', 'eins');
    assert.equal(v1.json.node.rev, 1);
    // the same name without baseRev → conflict with the current node
    const cf = await c.put(ANNA, mine.rootId, 'Brief.txt', 'zwei');
    assert.equal(cf.status, 409);
    assert.equal(cf.json.code, 'conflict');
    assert.equal(cf.json.current.rev, 1);
    // rename
    const rn = await c.put(ANNA, mine.rootId, 'brief.txt', 'zwei', { onConflict: 'rename' });
    assert.equal(rn.json.node.name, 'brief (2).txt');
    // baseRev: a new version
    const v2 = await c.put(ANNA, mine.rootId, 'Brief.txt', 'zwei!', { baseRev: 1 });
    assert.equal(v2.status, 200);
    assert.equal(v2.json.created, false);
    assert.equal(v2.json.node.rev, 2);
    // an old baseRev → conflict
    assert.equal((await c.put(ANNA, mine.rootId, 'Brief.txt', 'alt', { baseRev: 1 })).status, 409);
    await c.put(ANNA, mine.rootId, 'Brief.txt', 'drei', { onConflict: 'version' });
    await c.put(ANNA, mine.rootId, 'Brief.txt', 'vier', { onConflict: 'version' });
    const vs = await a('GET', `nodes/${v1.json.node.id}/versions`);
    assert.equal(vs.json.current.rev, 4);
    assert.deepEqual(vs.json.versions.map((v) => v.rev), [3, 2]); // at most 2
    // an older version's content
    const vc = await a('GET', `nodes/${v1.json.node.id}/versions/${vs.json.versions[1].id}/content`);
    assert.equal(String((await host.mediaFromUrl(vc.json.url)).body), 'zwei!');
    // delete a version
    assert.equal((await a('DELETE', `nodes/${v1.json.node.id}/versions/${vs.json.versions[1].id}`)).status, 200);
    assert.equal((await a('GET', `nodes/${v1.json.node.id}/versions`)).json.versions.length, 1);
    // check: the very same file is there
    const sha = (await a('GET', `nodes/${v1.json.node.id}`)).json.node.sha256;
    const ck = await a('POST', 'uploads/check', { parentId: mine.rootId, name: 'BRIEF.TXT', sha256: sha, size: 4 });
    assert.deepEqual([ck.json.exists, ck.json.same], [true, true]);
    const nk = await a('POST', 'uploads/check', { parentId: mine.rootId, name: 'Neu.txt', sha256: sha });
    assert.deepEqual([nk.json.exists, nk.json.same], [false, false]);
    // someone else's upload, or one committed already: upload_invalid
    const bobs = await c.upload(BOB, 'bob');
    const bad = await a('POST', 'uploads/commit', { mediaId: bobs, parentId: mine.rootId, name: 'X.txt' });
    assert.equal(bad.status, 409);
    assert.equal(bad.json.code, 'upload_invalid');
    const again = await a('POST', 'uploads/commit', { mediaId: v1.json.node.mediaId, parentId: mine.rootId, name: 'Y.txt' });
    assert.equal(again.json.code, 'upload_invalid');
  });
});

test('trash: delete, list, restore (a free name), purge', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const d = await a('POST', 'nodes', { parentId: mine.rootId, name: 'Alt' });
    const f1 = await c.put(ANNA, d.json.node.id, 'a.txt', 'aaa');
    await c.put(ANNA, d.json.node.id, 'b.txt', 'bb');
    const del = await a('DELETE', `nodes/${d.json.node.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.json.trashed, 3);
    assert.equal((await a('GET', `nodes/${f1.json.node.id}`)).status, 404);
    const tr = await a('GET', 'trash');
    assert.equal(tr.json.items.length, 1);
    assert.equal(tr.json.items[0].size, 5);
    assert.equal(tr.json.items[0].files, 2);
    // the name is free again: a new "Alt" with a.txt at the same path
    const d2 = await a('POST', 'nodes', { parentId: mine.rootId, name: 'Alt' });
    assert.equal((await c.put(ANNA, d2.json.node.id, 'a.txt', 'neu')).status, 200);
    // restore → "Alt (2)", the files at their paths
    const rs = await a('POST', `trash/${d.json.node.id}/restore`);
    assert.equal(rs.status, 200);
    assert.equal(rs.json.node.name, 'Alt (2)');
    const back = await a('GET', 'nodes/by-path', null, { area: mine.id, path: 'Alt (2)/a.txt' });
    assert.equal(back.json.node.id, f1.json.node.id);
    // delete again and purge: the media are gone
    await a('DELETE', `nodes/${f1.json.node.id}`);
    const pg = await a('DELETE', `trash/${f1.json.node.id}`);
    assert.equal(pg.status, 200);
    assert.equal(pg.json.files, 1);
    const media = await c.as(ANNA)('GET', `nodes/${f1.json.node.id}/content`);
    assert.equal(media.status, 404);
    assert.equal((await a('GET', 'trash')).json.items.length, 0);
    // someone else's trash: not found
    await a('DELETE', `nodes/${d2.json.node.id}`);
    assert.equal((await c.as(MARC)('POST', `trash/${d2.json.node.id}/restore`)).status, 404);
  });
});

test('change log, live events to the readers, the device that made a change', async () => {
  await withHost({}, async (host, c) => {
    const fam = await c.area(ANNA, 'family');
    const start = (await c.as(MARC)('GET', 'me')).json.latest;
    const up = await c.put(ANNA, fam.rootId, 'Einkauf.txt', 'Milch');
    const ev = c.events().filter((e) => e.type === 'changed');
    const last = ev[ev.length - 1];
    assert.deepEqual(last.users.slice().sort(), [ANNA.id, MARC.id, LENA.id].sort());
    assert.deepEqual(last.data.areas, [`family:${FAMILY}`]);
    const ch = await c.as(MARC)('GET', 'changes', null, { since: start });
    assert.equal(ch.json.changes.length, 1);
    assert.equal(ch.json.changes[0].op, 'create');
    assert.equal(ch.json.changes[0].device, `phone-${ANNA.id}`);
    assert.equal(ch.json.changes[0].node.name, 'Einkauf.txt');
    assert.equal(ch.json.next, ch.json.changes[0].seq);
    assert.equal(ch.json.more, false);
    // nothing new: next stays
    const none = await c.as(MARC)('GET', 'changes', null, { since: ch.json.next });
    assert.deepEqual([none.json.changes.length, none.json.next], [0, ch.json.next]);
    // Bob does not read the family: nothing for him
    const bob = await c.as(BOB)('GET', 'changes', null, { since: 0 });
    assert.ok(bob.json.changes.every((x) => x.areaId !== `family:${FAMILY}`));
    // paging
    for (let i = 0; i < 3; i++) await c.put(ANNA, fam.rootId, `n${i}.txt`, 'x');
    const p1 = await c.as(MARC)('GET', 'changes', null, { since: start, limit: 2 });
    assert.equal(p1.json.changes.length, 2);
    assert.equal(p1.json.more, true);
    const p2 = await c.as(MARC)('GET', 'changes', null, { since: p1.json.next, limit: 10 });
    assert.equal(p2.json.changes.length, 2);
    assert.equal(p2.json.more, false);
    assert.ok(up.json.node.id);
  });
});

test('mediaAccess: the readers of the area; a fresh upload only its uploader', async () => {
  await withHost({}, async (host, c) => {
    const fam = await c.area(ANNA, 'family');
    const mine = await c.area(ANNA, 'mine');
    const f = await c.put(ANNA, fam.rootId, 'Rezept.txt', 'Mehl');
    const p = await c.put(ANNA, mine.rootId, 'Privat.txt', 'nur ich');
    assert.equal((await host.mediaGet(MARC, f.json.node.mediaId)).status, 200);
    assert.equal((await host.mediaGet(BOB, f.json.node.mediaId)).status, 404);
    assert.equal((await host.mediaGet(MARC, p.json.node.mediaId)).status, 404);
    assert.equal((await host.mediaGet(ANNA, p.json.node.mediaId)).status, 200);
    const fresh = await c.upload(LENA, 'neu');
    assert.equal((await host.mediaGet(LENA, fresh)).status, 200);
    assert.equal((await host.mediaGet(ANNA, fresh)).status, 404);
    // in the trash: nobody
    await c.as(ANNA)('DELETE', `nodes/${p.json.node.id}`);
    assert.equal((await host.mediaGet(ANNA, p.json.node.mediaId)).status, 404);
  });
});

test('a NAS scan: added, changed (a version), removed — the tree follows, readers are told', async () => {
  await withHost({}, async (host, c) => {
    const fam = await c.area(ANNA, 'family');
    const media = `f${FAMILY}`;
    const before = c.events().length;
    await host.mediaScan(media, [{ type: 'added', path: 'Scans/Rechnung.pdf', data: '%PDF-1', mime: 'application/pdf' }]);
    const n = await c.as(MARC)('GET', 'nodes/by-path', null, { area: fam.id, path: 'Scans/Rechnung.pdf' });
    assert.equal(n.status, 200);
    assert.equal(n.json.node.size, 6);
    assert.equal(n.json.node.createdBy, null);
    assert.ok(c.events().length > before);
    await host.mediaScan(media, [{ type: 'changed', path: 'Scans/Rechnung.pdf', data: '%PDF-22', mime: 'application/pdf' }]);
    const v = await c.as(MARC)('GET', `nodes/${n.json.node.id}/versions`);
    assert.equal(v.json.current.size, 7);
    assert.equal(v.json.current.rev, 2);
    assert.equal(v.json.versions.length, 1);
    const ch = await c.as(MARC)('GET', 'changes', null, { since: 0 });
    assert.ok(ch.json.changes.some((x) => x.device === 'nas' && x.op === 'update'));
    await host.mediaScan(media, [{ type: 'removed', path: 'Scans/Rechnung.pdf' }]);
    assert.equal((await c.as(MARC)('GET', `nodes/${n.json.node.id}`)).status, 404);
    // the folder stays
    assert.equal((await c.as(MARC)('GET', 'nodes/by-path', null, { area: fam.id, path: 'Scans' })).status, 200);
    // the journal is read once: the background run applies nothing again
    const t = await host.tick();
    assert.equal(t.synced, 0);
  });
});
