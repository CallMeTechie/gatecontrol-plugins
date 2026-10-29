'use strict';

// Several at once (1.12.0, feature bulk): ops/check, the jobs move / copy / trash / restore / purge with the rule for
// the same name, the bytes of a copy brought by a device (GateControl has no copy of a media file), cancel, undo, the
// live event 'op', the change log, the ransomware protection, the rights and the vault rules.

const test = require('node:test');
const assert = require('node:assert/strict');
const VC = require('../ui/vaultcrypto');
const ops = require('../server/ops');
const { withHost, ANNA, MARC, LENA, BOB, FAMILY, DAY, MIN } = require('./helpers');

/** A tree in Anna's files: Projekte/{a.txt, b.txt, Fotos/{c.jpg}}, Archiv/{a.txt (other content), b.txt (same)}. */
async function tree(c) {
  const a = c.as(ANNA);
  const mine = await c.area(ANNA, 'mine');
  const mk = async (parentId, name) => (await a('POST', 'nodes', { parentId, name })).json.node;
  const projekte = await mk(mine.rootId, 'Projekte');
  const archiv = await mk(mine.rootId, 'Archiv');
  const fotos = await mk(projekte.id, 'Fotos');
  const put = async (parentId, name, data, o) => (await c.put(ANNA, parentId, name, data, o)).json.node;
  return {
    a, mine, projekte, archiv, fotos,
    fa: await put(projekte.id, 'a.txt', 'aaa'),
    fb: await put(projekte.id, 'b.txt', 'bbb'),
    fc: await put(fotos.id, 'c.jpg', 'jpeg', { mime: 'image/jpeg' }),
    xa: await put(archiv.id, 'a.txt', 'old a'),
    xb: await put(archiv.id, 'b.txt', 'bbb'),
  };
}

const names = async (a, id) => (await a('GET', `nodes/${id}/children`)).json.items.map((x) => x.name);

/** Bring the bytes of a copy as a device does: download each url, upload, hand over the mediaId. */
async function pump(host, c, user, opId, o = {}) {
  const a = c.as(user);
  let last = null;
  for (let round = 0; round < 50; round++) {
    const t = await a('POST', `ops/${opId}/transfers`, { limit: 3 });
    assert.equal(t.status, 200, JSON.stringify(t.json));
    if (!t.json.transfers.length) break;
    for (const x of t.json.transfers) {
      const got = await host.mediaFromUrl(x.url);
      assert.equal(got.status, 200);
      const mediaId = await c.upload(user, o.tamper ? 'other bytes' : got.body, x.mime || 'application/octet-stream');
      last = await a('POST', `ops/${opId}/transfers/${x.id}`, { mediaId });
      assert.equal(last.status, 200, JSON.stringify(last.json));
    }
  }
  return last;
}

test('GET me: the feature bulk (zip and multiLink while links are allowed)', async () => {
  await withHost({}, async (host, c) => {
    const f = (await c.as(ANNA)('GET', 'me')).json.features;
    assert.ok(f.includes('bulk') && f.includes('zip') && f.includes('multiLink'));
  });
  await withHost({ links: false }, async (host, c) => {
    const f = (await c.as(ANNA)('GET', 'me')).json.features;
    assert.ok(f.includes('bulk'));
    assert.ok(!f.includes('zip') && !f.includes('multiLink'));
  });
});

test('ops/check: counts, the names at the target (merged folders looked into), what may not go', async () => {
  await withHost({}, async (host, c) => {
    const t = await tree(c);
    const ck = await t.a('POST', 'ops/check', { op: 'copy', ids: [t.fa.id, t.fb.id, t.fotos.id], target: t.archiv.id });
    assert.equal(ck.status, 200, JSON.stringify(ck.json));
    assert.deepEqual([ck.json.items, ck.json.files, ck.json.folders, ck.json.bytes], [3, 3, 1, 3 + 3 + 4]);
    assert.deepEqual(ck.json.conflicts.map((x) => [x.name, x.same, x.existing.id]), [['a.txt', false, t.xa.id], ['b.txt', true, t.xb.id]]);
    assert.deepEqual(ck.json.blocked, []);
    assert.equal(ck.json.limit, ops.NODES_MAX);
    // a folder of the same name: merged — what is in it is looked at
    const arch2 = (await t.a('POST', 'nodes', { parentId: t.mine.rootId, name: 'Ziel' })).json.node;
    await c.put(ANNA, (await t.a('POST', 'nodes', { parentId: arch2.id, name: 'Projekte' })).json.node.id, 'a.txt', 'zzz');
    const m = await t.a('POST', 'ops/check', { op: 'move', ids: [t.projekte.id], target: arch2.id });
    assert.equal(m.json.merges, 1);
    assert.deepEqual(m.json.conflicts.map((x) => x.path), ['Projekte/a.txt']);
    // what may not go: into itself, where it is, the root, unknown
    const b = await t.a('POST', 'ops/check', { op: 'move', ids: [t.projekte.id, t.fa.id, t.mine.rootId, 999999, t.archiv.id], target: t.fotos.id });
    assert.deepEqual(b.json.blocked.map((x) => [x.id, x.reason]), [[t.projekte.id, 'into_itself'], [t.mine.rootId, 'root'], [999999, 'not_found']]);
    assert.equal(b.json.items, 2, 'a.txt and Archiv may go');
    const same = await t.a('POST', 'ops/check', { op: 'move', ids: [t.fa.id], target: t.projekte.id });
    assert.deepEqual(same.json.blocked.map((x) => x.reason), ['same_folder']);
    // bad input
    assert.equal((await t.a('POST', 'ops/check', { op: 'fly', ids: [t.fa.id] })).status, 400);
    assert.equal((await t.a('POST', 'ops/check', { op: 'move', ids: [t.fa.id] })).json.field, 'target');
    assert.equal((await t.a('POST', 'ops/check', { op: 'trash', ids: [] })).status, 400);
    assert.equal((await t.a('POST', 'ops/check', { op: 'trash', ids: new Array(10001).fill(1).map((x, i) => i + 1) })).status, 400);
    // a target the person may not write to
    const marc = await c.area(MARC, 'mine');
    assert.equal((await t.a('POST', 'ops/check', { op: 'copy', ids: [t.fa.id], target: marc.rootId })).status, 404);
  });
});

test('move: several at once, the same name by the rule, the change log, the live events, undo', async () => {
  await withHost({}, async (host, c) => {
    const t = await tree(c);
    const before = (await t.a('GET', 'changes', null, { since: 0 })).json.next;
    host.events.length = 0;
    const r = await t.a('POST', 'ops', { op: 'move', ids: [t.fa.id, t.fb.id, t.fotos.id], target: t.archiv.id, onConflict: 'rename' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const op = r.json.op;
    assert.equal(op.state, 'done');
    assert.deepEqual([op.kind, op.items, op.total, op.done, op.bytesTotal, op.bytesDone], ['move', 3, 3, 3, 10, 10]);
    assert.equal(op.targetName, 'Archiv');
    assert.ok(op.undoUntil);
    // a.txt: renamed; b.txt: the same content there — it went into the trash; Fotos moved
    assert.deepEqual((await names(t.a, t.archiv.id)).sort(), ['a (2).txt', 'a.txt', 'b.txt', 'Fotos'].sort());
    assert.deepEqual(await names(t.a, t.projekte.id), []);
    assert.equal((await t.a('GET', `nodes/${t.fb.id}`)).status, 404);
    assert.equal((await t.a('GET', 'trash')).json.items[0].id, t.fb.id);
    assert.equal(host.media.get(t.fc.mediaId).path, 'Archiv/Fotos/c.jpg', 'the media follow');
    assert.deepEqual(op.results.resultIds.sort(), [t.fa.id, t.xb.id, t.fotos.id].sort());
    // the change log: a move each, a delete for b.txt
    const ch = (await t.a('GET', 'changes', null, { since: before })).json.changes.map((x) => [x.op, x.nodeId]);
    assert.ok(ch.some((x) => x[0] === 'move' && x[1] === t.fa.id));
    assert.ok(ch.some((x) => x[0] === 'delete' && x[1] === t.fb.id));
    // the live events: 'changed' to the readers, 'op' (the last) to the person
    assert.ok(host.events.some((e) => e.type === 'changed'));
    const last = host.events.filter((e) => e.type === 'op').pop();
    assert.deepEqual([last.users, last.data.op.id, last.data.op.state], [[ANNA.id], op.id, 'done']);
    // GET ops/<id>, GET ops
    assert.equal((await t.a('GET', `ops/${op.id}`)).json.op.state, 'done');
    assert.equal((await t.a('GET', 'ops')).json.ops[0].id, op.id);
    assert.equal((await c.as(MARC)('GET', `ops/${op.id}`)).status, 404, 'only the person sees a job');
    // undo: everything back (b.txt out of the trash)
    const u = await t.a('POST', `ops/${op.id}/undo`);
    assert.equal(u.status, 200, JSON.stringify(u.json));
    assert.deepEqual([u.json.op.kind, u.json.op.state, u.json.op.undoOf], ['undo', 'done', op.id]);
    assert.deepEqual((await names(t.a, t.projekte.id)).sort(), ['a.txt', 'b.txt', 'Fotos'].sort());
    assert.deepEqual((await names(t.a, t.archiv.id)).sort(), ['a.txt', 'b.txt']);
    assert.equal(host.media.get(t.fc.mediaId).path, 'Projekte/Fotos/c.jpg');
    // only once
    const again = await t.a('POST', `ops/${op.id}/undo`);
    assert.deepEqual([again.status, again.json.reason], [409, 'undone']);
    assert.equal((await t.a('GET', `ops/${op.id}`)).json.op.undoneBy, u.json.op.id);
  });
});

test('move: version (the moved file becomes the new content there), skip, merged folders; undo skips what changed', async () => {
  await withHost({}, async (host, c) => {
    const t = await tree(c);
    const r = await t.a('POST', 'ops', { op: 'move', ids: [t.fa.id], target: t.archiv.id });
    assert.equal(r.json.op.state, 'done');
    const v = await t.a('GET', `nodes/${t.xa.id}/versions`);
    assert.equal(v.json.current.sha256, t.fa.sha256, 'the content of the moved one');
    assert.equal(v.json.versions.length, 1, 'the content there before is a version');
    assert.equal((await t.a('GET', `nodes/${t.fa.id}`)).status, 404, 'the moved node is gone');
    // skip
    const s = await t.a('POST', 'ops', { op: 'move', ids: [t.fb.id], target: t.archiv.id, onConflict: 'skip' });
    assert.equal(s.json.op.results.done, 1, 'the same content counts as done');
    // folders of the same name merge
    const ziel = (await t.a('POST', 'nodes', { parentId: t.mine.rootId, name: 'Ziel' })).json.node;
    const zf = (await t.a('POST', 'nodes', { parentId: ziel.id, name: 'Fotos' })).json.node;
    const m = await t.a('POST', 'ops', { op: 'move', ids: [t.fotos.id], target: ziel.id });
    assert.equal(m.json.op.state, 'done', JSON.stringify(m.json.op));
    assert.deepEqual(await names(t.a, zf.id), ['c.jpg']);
    assert.deepEqual(await names(t.a, t.projekte.id), [], 'the empty folder went into the trash');
    // undo after a change: what changed is skipped and reported
    await t.a('PATCH', `nodes/${t.fc.id}`, { name: 'd.jpg' });
    const u = await t.a('POST', `ops/${m.json.op.id}/undo`);
    assert.equal(u.json.op.results.skipped, 1);
    assert.deepEqual(await names(t.a, t.projekte.id), ['Fotos'], 'the folder came back');
    assert.deepEqual(await names(t.a, zf.id), ['d.jpg']);
    // too late
    const r2 = await t.a('POST', 'ops', { op: 'move', ids: [t.xb.id], target: t.projekte.id });
    c.clock.add(16 * MIN);
    const late = await t.a('POST', `ops/${r2.json.op.id}/undo`);
    assert.deepEqual([late.status, late.json.reason], [409, 'expired']);
  });
});

test('copy: folders made at once, the bytes brought by a device, the same content not stored twice, undo', async () => {
  await withHost({}, async (host, c) => {
    const t = await tree(c);
    const ziel = (await t.a('POST', 'nodes', { parentId: t.mine.rootId, name: 'Ziel' })).json.node;
    await c.put(ANNA, ziel.id, 'b.txt', 'bbb');
    const before = (await t.a('GET', 'changes', null, { since: 0 })).json.next;
    const r = await t.a('POST', 'ops', { op: 'copy', ids: [t.projekte.id, t.xb.id], target: ziel.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    let op = r.json.op;
    assert.deepEqual([op.kind, op.state, op.transfer, op.transfersLeft], ['copy', 'running', 'client', 3]);
    assert.deepEqual([op.total, op.done], [4, 1], 'Archiv/b.txt: the same content is there — done');
    // the folders are there already
    const p = (await t.a('GET', 'nodes/by-path', null, { area: t.mine.id, path: 'Ziel/Projekte/Fotos' })).json.node;
    assert.ok(p && p.isDir);
    const last = await pump(host, c, ANNA, op.id);
    op = last.json.op;
    assert.deepEqual([op.state, op.done, op.bytesDone, op.transfersLeft], ['done', 4, op.bytesTotal, 0]);
    assert.ok(op.undoUntil);
    const copied = (await t.a('GET', 'nodes/by-path', null, { area: t.mine.id, path: 'Ziel/Projekte/Fotos/c.jpg' })).json.node;
    assert.equal(copied.sha256, t.fc.sha256);
    assert.notEqual(copied.mediaId, t.fc.mediaId, 'a file of its own');
    assert.equal(copied.mime, 'image/jpeg');
    assert.equal(host.media.get(copied.mediaId).path, 'Ziel/Projekte/Fotos/c.jpg');
    assert.equal((await t.a('GET', `nodes/${t.fc.id}`)).json.node.path, 'Projekte/Fotos/c.jpg', 'the original stays');
    // the change log: a create for every node made
    const ch = (await t.a('GET', 'changes', null, { since: before })).json.changes.filter((x) => x.op === 'create');
    assert.equal(ch.length, 5, 'Projekte, Fotos, a.txt, b.txt, c.jpg');
    // undo: the copies into the trash
    const u = await t.a('POST', `ops/${op.id}/undo`);
    assert.equal(u.json.op.state, 'done');
    assert.deepEqual(await names(t.a, ziel.id), ['b.txt']);
  });
});

test('copy: version and rename, a device that brings other bytes, a file gone meanwhile, cancel', async () => {
  await withHost({}, async (host, c) => {
    const t = await tree(c);
    // version: a.txt becomes the new content of Archiv/a.txt
    let r = await t.a('POST', 'ops', { op: 'copy', ids: [t.fa.id], target: t.archiv.id });
    await pump(host, c, ANNA, r.json.op.id);
    const v = await t.a('GET', `nodes/${t.xa.id}/versions`);
    assert.equal(v.json.current.sha256, t.fa.sha256);
    assert.equal(v.json.versions.length, 1);
    // undo: the content before comes back
    await t.a('POST', `ops/${r.json.op.id}/undo`);
    assert.equal((await t.a('GET', `nodes/${t.xa.id}`)).json.node.sha256, t.xa.sha256);
    // rename: both stay
    r = await t.a('POST', 'ops', { op: 'copy', ids: [t.fa.id], target: t.archiv.id, onConflict: 'rename' });
    await pump(host, c, ANNA, r.json.op.id);
    assert.deepEqual((await names(t.a, t.archiv.id)).sort(), ['a (2).txt', 'a.txt', 'b.txt']);
    // a copy into the folder it is in: a name of its own
    r = await t.a('POST', 'ops', { op: 'copy', ids: [t.fotos.id], target: t.projekte.id });
    await pump(host, c, ANNA, r.json.op.id);
    assert.deepEqual((await names(t.a, t.projekte.id)).sort(), ['a.txt', 'b.txt', 'Fotos', 'Fotos (2)'].sort());
    // other bytes than the original's: that file fails
    r = await t.a('POST', 'ops', { op: 'copy', ids: [t.fa.id], target: t.mine.rootId });
    const bad = await pump(host, c, ANNA, r.json.op.id, { tamper: true });
    assert.deepEqual([bad.json.op.state, bad.json.op.results.failed[0].reason], ['done', 'changed']);
    // a mediaId that is not the person's fresh upload
    r = await t.a('POST', 'ops', { op: 'copy', ids: [t.fb.id], target: t.mine.rootId });
    const tr = await t.a('POST', `ops/${r.json.op.id}/transfers`);
    assert.equal(tr.json.transfers.length, 1);
    assert.equal(tr.json.left, 1);
    assert.equal((await t.a('POST', `ops/${r.json.op.id}/transfers`)).json.transfers.length, 0, 'leased to the first device');
    const marcMedia = await c.upload(MARC, 'bbb');
    assert.equal((await t.a('POST', `ops/${r.json.op.id}/transfers/${tr.json.transfers[0].id}`, { mediaId: marcMedia })).status, 409);
    // cancel: what is done stays, a late upload is refused
    const x = await t.a('DELETE', `ops/${r.json.op.id}`);
    assert.equal(x.json.op.state, 'cancelled');
    const mediaId = await c.upload(ANNA, 'bbb');
    const late = await t.a('POST', `ops/${r.json.op.id}/transfers/${tr.json.transfers[0].id}`, { mediaId });
    assert.deepEqual([late.status, late.json.reason], [409, 'cancelled']);
    assert.equal(host.media.has(mediaId), false, 'the upload is dropped');
    // a device gives one up
    r = await t.a('POST', 'ops', { op: 'copy', ids: [t.fb.id], target: t.mine.rootId, onConflict: 'rename' });
    const tr2 = await t.a('POST', `ops/${r.json.op.id}/transfers`);
    const gave = await t.a('POST', `ops/${r.json.op.id}/transfers/${tr2.json.transfers[0].id}`, { failed: true, reason: 'download' });
    assert.deepEqual([gave.json.op.state, gave.json.op.results.failed[0].reason], ['done', 'download']);
  });
});

test('copy: nobody brings the bytes — the background run ends it after a day; old jobs go', async () => {
  await withHost({}, async (host, c) => {
    const t = await tree(c);
    const r = await t.a('POST', 'ops', { op: 'copy', ids: [t.fa.id], target: t.mine.rootId });
    assert.equal(r.json.op.state, 'running');
    await host.tick();
    assert.equal((await t.a('GET', `ops/${r.json.op.id}`)).json.op.state, 'running');
    c.clock.add(DAY + MIN);
    await host.tick();
    const op = (await t.a('GET', `ops/${r.json.op.id}`)).json.op;
    assert.deepEqual([op.state, op.error], ['failed', 'abandoned']);
    assert.deepEqual((await t.a('GET', 'ops', null, { state: 'failed' })).json.ops.map((x) => x.id), [op.id]);
    c.clock.add(8 * DAY);
    await host.tick();
    assert.equal((await t.a('GET', `ops/${r.json.op.id}`)).status, 404);
  });
});

test('copy: empty files need no bytes; GET me without copyServer on GateControl 1.208', async () => {
  await withHost({}, async (host, c) => {
    const t = await tree(c);
    const e = await t.a('POST', 'uploads/commit', { parentId: t.projekte.id, name: 'leer.txt', size: 0 });
    const r = await t.a('POST', 'ops', { op: 'copy', ids: [e.json.node.id], target: t.archiv.id });
    assert.equal(r.json.op.state, 'done');
    assert.ok((await names(t.a, t.archiv.id)).includes('leer.txt'));
    const f = (await t.a('GET', 'me')).json.features;
    assert.ok(!f.includes('copyServer') && !f.includes('zipMixed'));
  });
});

test('copy on GateControl 1.215: gc.media.copy on the server — no device, into the target area, the job goes on alone, undo', async () => {
  await withHost({ gatecontrol: '1.215.0' }, async (host, c) => {
    const t = await tree(c);
    assert.ok((await t.a('GET', 'me')).json.features.includes('copyServer'));
    const fam = await c.area(ANNA, 'family');
    const before = (await t.a('GET', 'changes', null, { since: 0 })).json.next;
    const r = await t.a('POST', 'ops', { op: 'copy', ids: [t.projekte.id], target: fam.rootId });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    let op = r.json.op;
    assert.deepEqual([op.transfer, op.transfersLeft], ['server', 0]);
    await ops.idle();
    op = (await t.a('GET', `ops/${op.id}`)).json.op;
    assert.deepEqual([op.state, op.done, op.total, op.bytesDone, op.bytesTotal], ['done', 3, 3, 10, 10]);
    assert.equal(host.mediaCopies.length, 3);
    assert.ok(host.mediaCopies.every((x) => x.area === `f${FAMILY}` && !x.claim), 'copied straight into the family area, claimed by Drive');
    assert.ok(host.mediaCopies.every((x) => host.media.get(x.id).claimed && host.media.get(x.id).owner === ANNA.id));
    const copied = (await t.a('GET', 'nodes/by-path', null, { area: fam.id, path: 'Projekte/Fotos/c.jpg' })).json.node;
    assert.equal(copied.sha256, t.fc.sha256);
    assert.notEqual(copied.mediaId, t.fc.mediaId);
    assert.deepEqual([host.media.get(copied.mediaId).area, host.media.get(copied.mediaId).path], [`f${FAMILY}`, 'Projekte/Fotos/c.jpg']);
    const ch = (await c.as(MARC)('GET', 'changes', null, { since: before })).json.changes.filter((x) => x.op === 'create');
    assert.equal(ch.length, 5, 'Marc\'s devices see the copies as new');
    // a version: the copy becomes the new content of the file there; undo
    const v = await t.a('POST', 'ops', { op: 'copy', ids: [t.fa.id], target: t.archiv.id });
    await ops.idle();
    assert.equal((await t.a('GET', `nodes/${t.xa.id}`)).json.node.sha256, t.fa.sha256);
    const u = await t.a('POST', `ops/${v.json.op.id}/undo`);
    assert.equal(u.json.op.state, 'done');
    assert.equal((await t.a('GET', `nodes/${t.xa.id}`)).json.node.sha256, t.xa.sha256);
    // the transfers route has nothing to hand out
    const w = await t.a('POST', 'ops', { op: 'copy', ids: [t.fb.id], target: t.mine.rootId, onConflict: 'rename' });
    assert.equal((await t.a('POST', `ops/${w.json.op.id}/transfers`)).json.transfers.length, 0);
    await ops.idle();
    // the quota of the target area ends the job
    await host.gc.media.areas.ensure(`f${FAMILY}`, { quota: 1024 * 1024 });
    const big = (await c.put(ANNA, t.projekte.id, 'gross.bin', Buffer.alloc(1100 * 1024))).json.node;
    const q = await t.a('POST', 'ops', { op: 'copy', ids: [big.id], target: fam.rootId });
    assert.deepEqual([q.status, q.json.code], [507, 'quota']);
  });
});

test('copy on the server: a storage target that does not answer (ERR_BUSY) — the job waits and goes on', async () => {
  await withHost({}, async (host, c) => {
    const t = await tree(c);
    let busy = true;
    ops._setCopy(async (id) => {
      if (busy) throw Object.assign(new Error('busy'), { code: 'ERR_BUSY' });
      const m = host.media.get(id);
      return { id: (await host.upload(ANNA, m.data, m.mime)).body.mediaId };
    });
    try {
      const r = await t.a('POST', 'ops', { op: 'copy', ids: [t.fa.id], target: t.mine.rootId });
      assert.deepEqual([r.json.op.state, r.json.op.transfer, r.json.op.done], ['running', 'server', 0]);
      await ops.idle();
      busy = false;
      c.clock.add(2 * MIN);
      await host.tick();
      await ops.idle();
      assert.equal((await t.a('GET', `ops/${r.json.op.id}`)).json.op.state, 'done');
    } finally { ops._setCopy(null); }
  });
});

test('copy: a job waiting for a device goes on on the server once GateControl copies (the hook stands in)', async () => {
  await withHost({}, async (host, c) => {
    const t = await tree(c);
    const r = await t.a('POST', 'ops', { op: 'copy', ids: [t.fotos.id], target: t.archiv.id });
    assert.deepEqual([r.json.op.state, r.json.op.transfer], ['running', 'client']);
    const copied = [];
    ops._setCopy(async (id, o) => {
      const m = host.media.get(id);
      copied.push([id, o.area]);
      const r2 = await host.upload(ANNA, m.data, m.mime);
      return { id: r2.body.mediaId };
    });
    try {
      await host.tick();
      await ops.idle();
      const op = (await t.a('GET', `ops/${r.json.op.id}`)).json.op;
      assert.deepEqual([op.state, op.transfer], ['done', 'server']);
      assert.deepEqual(copied, [[t.fc.mediaId, `u${ANNA.id}`]]);
      assert.ok((await t.a('GET', 'nodes/by-path', null, { area: t.mine.id, path: 'Archiv/Fotos/c.jpg' })).json.node);
    } finally { ops._setCopy(null); }
  });
});

test('trash, restore and purge several; undo of a trash', async () => {
  await withHost({}, async (host, c) => {
    const t = await tree(c);
    const r = await t.a('POST', 'ops', { op: 'trash', ids: [t.fa.id, t.fotos.id, t.fc.id] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.op.state, r.json.op.items, r.json.op.total, r.json.op.results.done], ['done', 3, 2, 2], 'c.jpg goes with Fotos');
    assert.deepEqual(await names(t.a, t.projekte.id), ['b.txt']);
    const u = await t.a('POST', `ops/${r.json.op.id}/undo`);
    assert.equal(u.json.op.results.done, 2);
    assert.deepEqual((await names(t.a, t.projekte.id)).sort(), ['a.txt', 'b.txt', 'Fotos'].sort());
    // restore and purge from the trash
    await t.a('POST', 'ops', { op: 'trash', ids: [t.fa.id, t.fb.id] });
    const back = await t.a('POST', 'ops', { op: 'restore', ids: [t.fa.id, 4242] });
    assert.deepEqual([back.json.op.results.done, back.json.op.results.failed], [1, [{ id: 4242, name: null, reason: 'not_found' }]]);
    assert.equal(back.json.op.undoUntil, undefined, 'a restore is not undone');
    const gone = await t.a('POST', 'ops', { op: 'purge', ids: [t.fb.id] });
    assert.equal(gone.json.op.results.done, 1);
    assert.equal(host.media.has(t.fb.mediaId), false);
    assert.equal((await t.a('GET', 'trash')).json.items.length, 0);
  });
});

test('rights: a parent in the child\'s folder, a reader, another person\'s area; copy needs the right to read', async () => {
  await withHost({}, async (host, c) => {
    const lena = await c.area(LENA, 'child');
    const f = (await c.put(LENA, lena.rootId, 'Tagebuch.txt', 'geheim')).json.node;
    const anna = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const ck = await anna('POST', 'ops/check', { op: 'move', ids: [f.id], target: mine.rootId });
    assert.deepEqual(ck.json.blocked.map((x) => x.reason), ['forbidden']);
    const tr = await anna('POST', 'ops', { op: 'trash', ids: [f.id] });
    assert.deepEqual(tr.json.op.results.failed.map((x) => x.reason), ['forbidden']);
    assert.equal((await c.as(LENA)('GET', `nodes/${f.id}`)).status, 200, 'still there');
    // a copy: reading is enough (the child is told someone looked)
    const cp = await anna('POST', 'ops/check', { op: 'copy', ids: [f.id], target: mine.rootId });
    assert.deepEqual(cp.json.blocked, []);
    // into a folder the child owns: not for the parent
    assert.equal((await anna('POST', 'ops', { op: 'copy', ids: [f.id], target: lena.rootId })).status, 403);
    // another person's file: not found
    const b = (await c.put(BOB, (await c.area(BOB, 'mine')).rootId, 'x.txt', 'x')).json.node;
    assert.deepEqual((await anna('POST', 'ops/check', { op: 'trash', ids: [b.id] })).json.blocked.map((x) => x.reason), ['not_found']);
  });
});

test('limits: running jobs a person, the quota of the target area', async () => {
  await withHost({}, async (host, c) => {
    const t = await tree(c);
    for (let i = 0; i < ops.RUNNING_MAX; i++) {
      const r = await t.a('POST', 'ops', { op: 'copy', ids: [t.fa.id], target: t.mine.rootId, onConflict: 'rename' });
      assert.equal(r.json.op.state, 'running');
    }
    const no = await t.a('POST', 'ops', { op: 'trash', ids: [t.fb.id] });
    assert.deepEqual([no.status, no.json.code, no.json.max], [409, 'job_limit', ops.RUNNING_MAX]);
    for (const o of (await t.a('GET', 'ops', null, { state: 'running' })).json.ops) await t.a('DELETE', `ops/${o.id}`);
    // the target area's quota
    await host.gc.media.areas.ensure(`u${ANNA.id}`, { quota: 1024 * 1024 });
    const big = (await c.put(ANNA, t.projekte.id, 'gross.bin', Buffer.alloc(700 * 1024))).json.node;
    const ck = await t.a('POST', 'ops/check', { op: 'copy', ids: [big.id], target: t.archiv.id });
    assert.equal(ck.json.quota.needed, 700 * 1024);
    const q = await t.a('POST', 'ops', { op: 'copy', ids: [big.id], target: t.archiv.id });
    assert.deepEqual([q.status, q.json.code], [507, 'quota']);
  });
});

test('an app device: its copies are new files for the ransomware protection; a stopped device may only look', async () => {
  await withHost({}, async (host, c) => {
    const t = await tree(c);
    const phone = c.as(ANNA, 'phone-x');
    const r = await phone('POST', 'ops', { op: 'move', ids: [t.fa.id, t.fb.id], target: t.mine.rootId });
    assert.equal(r.json.op.state, 'done');
    const log = (await host.gc.db.query("SELECT op, device FROM guard_log WHERE device = 'phone-x' ORDER BY id")).rows;
    assert.deepEqual(log.map((x) => x.op), ['rename', 'rename']);
    // the device stopped: check and cancel stay, a job does not start
    await host.gc.db.run("INSERT INTO guard_incidents (user_id, device, state, at, since, files, sample) VALUES (?, 'phone-x', 'open', ?, ?, 0, '[]')", [ANNA.id, c.clock.now(), c.clock.now()]);
    assert.equal((await phone('POST', 'ops/check', { op: 'trash', ids: [t.fa.id] })).status, 200);
    assert.equal((await phone('POST', 'ops', { op: 'trash', ids: [t.fa.id] })).status, 423);
  });
});

test('vaults: nothing into or out of one, its folder never moves; inside the same vault move and copy work', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const kp = await VC.generateDeviceKey();
    const raw = await VC.exportPublic(kp.publicKey);
    const dev = { publicKey: VC.b64u(raw), publicRaw: raw };
    const id = VC.newVaultId();
    const tk = VC.newVaultKey();
    const rec = VC.newRecoveryKey();
    const rk = await VC.recoveryKeyPair(rec.key);
    const v = await a('POST', 'vaults', {
      id, parentId: mine.rootId, nameCipher: await VC.encryptName(tk, id, 1, 'Steuer'), recoveryPub: VC.b64u(rk.publicRaw), recoveryAuth: await VC.recoveryAuth(rec.key),
      recoveryWrap: await VC.wrapKey(tk, rk.publicRaw, id, 1), device: { publicKey: dev.publicKey, name: 'Laptop', platform: 'windows' }, wrap: await VC.wrapKey(tk, dev.publicRaw, id, 1),
    });
    assert.equal(v.status, 200, JSON.stringify(v.json));
    const vroot = v.json.node;
    const enc = async (parentId, name) => (await a('POST', 'nodes', { parentId, encrypted: true, nameCipher: await VC.encryptName(tk, id, 1, name), keyVersion: 1 })).json.node;
    const sub = await enc(vroot.id, '2026');
    const parts = await VC.encryptContent(tk, id, 1, new Uint8Array(Buffer.from('Bescheid')));
    const mediaId = await c.upload(ANNA, Buffer.concat(parts.map((p) => Buffer.from(p))), 'application/octet-stream');
    const file = (await a('POST', 'uploads/commit', { mediaId, parentId: vroot.id, encrypted: true, nameCipher: await VC.encryptName(tk, id, 1, 'Bescheid.pdf'), keyVersion: 1 })).json.node;
    const plain = (await c.put(ANNA, mine.rootId, 'x.txt', 'x')).json.node;
    const ck = await a('POST', 'ops/check', { op: 'move', ids: [vroot.id, plain.id], target: sub.id });
    assert.deepEqual(ck.json.blocked.map((x) => [x.id, x.reason]), [[vroot.id, 'encrypted'], [plain.id, 'encrypted']]);
    assert.deepEqual((await a('POST', 'ops/check', { op: 'copy', ids: [file.id], target: mine.rootId })).json.blocked.map((x) => x.reason), ['encrypted']);
    // inside the vault: move and copy (the ciphertext as it is — the device decrypts the same name)
    const mv = await a('POST', 'ops', { op: 'move', ids: [file.id], target: sub.id });
    assert.equal(mv.json.op.state, 'done');
    assert.equal(mv.json.op.label, null, 'no name of a vault in a job');
    const cp = await a('POST', 'ops', { op: 'copy', ids: [file.id], target: vroot.id });
    const tr = await a('POST', `ops/${cp.json.op.id}/transfers`);
    const x = tr.json.transfers[0];
    assert.deepEqual([x.encrypted, x.vaultId, x.nameCipher], [true, id, file.nameCipher]);
    const got = await host.mediaFromUrl(x.url);
    const done = await a('POST', `ops/${cp.json.op.id}/transfers/${x.id}`, { mediaId: await c.upload(ANNA, got.body, 'application/octet-stream') });
    assert.equal(done.json.op.state, 'done', JSON.stringify(done.json));
    const kids = (await a('GET', `nodes/${vroot.id}/children`)).json.items.filter((x) => !x.isDir);
    assert.equal(kids.length, 1);
    assert.equal(await VC.decryptName(new Map([[1, tk]]), id, kids[0].nameCipher), 'Bescheid.pdf');
    assert.notEqual(kids[0].name, file.name, 'a new opaque name');
    // trash inside the vault: fine
    assert.equal((await a('POST', 'ops', { op: 'trash', ids: [kids[0].id] })).json.op.results.done, 1);
  });
});

test('a large job goes on after the answer and after a restart (the background run)', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const src = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Viele' })).json.node;
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push((await a('POST', 'nodes', { parentId: src.id, name: `Ordner ${i}` })).json.node.id);
    const dest = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Ziel' })).json.node;
    // as if the plugin restarted: a job with rows still to do
    await host.gc.db.run(`INSERT INTO ops (id, user_id, kind, state, ids, target_id, items, created_at, updated_at) VALUES ('AAAAAAAAAAAAAAAAAAAAAA', ?, 'move', 'running', ?, ?, ?, ?, ?)`,
      [ANNA.id, JSON.stringify(ids), dest.id, ids.length, c.clock.now(), c.clock.now()]);
    for (let i = 0; i < ids.length; i++) await host.gc.db.run("INSERT INTO op_items (op_id, seq, node_id, is_dir, name) VALUES ('AAAAAAAAAAAAAAAAAAAAAA', ?, ?, 1, ?)", [i + 1, ids[i], `Ordner ${i}`]);
    host.events.length = 0;
    await host.tick();
    await ops.idle();
    const op = (await a('GET', 'ops/AAAAAAAAAAAAAAAAAAAAAA')).json.op;
    assert.deepEqual([op.state, op.results.done], ['done', 12]);
    assert.equal((await names(a, dest.id)).length, 12);
    assert.ok(host.events.some((e) => e.type === 'changed'), 'the background run announces the changes');
    assert.ok(host.events.some((e) => e.type === 'op' && e.data.op.state === 'done'));
  });
});
