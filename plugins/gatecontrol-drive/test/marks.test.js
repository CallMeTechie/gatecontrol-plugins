'use strict';

// "Auf dem Gerät gelöscht, wird am … gelöscht" (1.5.0): DELETE nodes/<id>?after=<s>, PATCH nodes/<id> { deleteAt },
// the change log (mark / unmark), new content ends a mark, the background run puts what is due into the trash.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, MIN, DAY } = require('./helpers');

const isoAt = (ms) => new Date(ms).toISOString();

test('marks: delete later from a device — the file stays until then, marked, in the change log', async () => {
  await withHost({}, async (host, c) => {
    const pc = c.as(ANNA, 'tok-pc');
    const phone = c.as(ANNA, 'phone-2');
    const mine = await c.area(ANNA, 'mine');
    await pc('PUT', 'devices/pc-1', { name: 'PC' });
    const file = (await c.put(ANNA, mine.rootId, 'Brief.pdf', '%PDF-1')).json.node;
    const since = (await pc('GET', 'me')).json.latest;
    const t0 = c.clock.now();

    const r = await pc('DELETE', `nodes/${file.id}`, null, { after: String(30 * 86400) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.marked, true);
    assert.equal(r.json.deleteAt, isoAt(t0 + 30 * DAY));
    assert.deepEqual([r.json.node.deleteAt, r.json.node.deletedOnDevice, r.json.node.deleteMarkedBy, r.json.node.deleted], [isoAt(t0 + 30 * DAY), 'PC', ANNA.id, false]);
    // still there for everyone: listed, readable, not in the trash
    const kids = (await phone('GET', `nodes/${mine.rootId}/children`)).json.items;
    assert.equal(kids.find((x) => x.id === file.id).deleteAt, isoAt(t0 + 30 * DAY));
    assert.equal((await phone('GET', `nodes/${file.id}/content`)).status, 200);
    assert.equal((await phone('GET', 'trash')).json.items.length, 0);
    // the change log: op mark with the node as it is now, from the PC
    const ch = (await phone('GET', 'changes', null, { since })).json.changes;
    assert.deepEqual(ch.map((x) => [x.op, x.nodeId, x.device]), [['mark', file.id, 'tok-pc']]);
    assert.equal(ch[0].node.deletedOnDevice, 'PC');

    // sent again: the earlier time stays, nothing new in the log; an earlier one wins
    c.clock.add(MIN);
    assert.equal((await pc('DELETE', `nodes/${file.id}`, null, { after: String(30 * 86400) })).json.deleteAt, isoAt(t0 + 30 * DAY));
    assert.equal((await phone('GET', 'changes', null, { since })).json.changes.length, 1);
    const sooner = await phone('DELETE', `nodes/${file.id}`, null, { after: '3600', device: 'nope' });
    assert.equal(sooner.json.deleteAt, isoAt(c.clock.now() + 3600000));
    assert.equal(sooner.json.node.deletedOnDevice, null, 'the phone registered no device');

    // PATCH { deleteAt }: exactly; null ends it
    const at = c.clock.now() + 2 * DAY;
    const p = await pc('PATCH', `nodes/${file.id}`, { deleteAt: isoAt(at), device: 'pc-1' });
    assert.equal(p.status, 200);
    assert.deepEqual([p.json.node.deleteAt, p.json.node.deletedOnDevice], [isoAt(at), 'PC']);
    const un = await phone('PATCH', `nodes/${file.id}`, { deleteAt: null });
    assert.equal(un.json.node.deleteAt, undefined);
    const ops = (await phone('GET', 'changes', null, { since })).json.changes.map((x) => x.op);
    assert.deepEqual(ops, ['mark', 'mark', 'mark', 'unmark']);
    // ending no mark: nothing
    await phone('PATCH', `nodes/${file.id}`, { deleteAt: null });
    assert.equal((await phone('GET', 'changes', null, { since })).json.changes.length, 4);

    // bad input
    for (const q of [{ after: 'abc' }, { after: '-5' }, { after: String(366 * 86400) }]) {
      const b = await pc('DELETE', `nodes/${file.id}`, null, q);
      assert.equal(b.status, 400, JSON.stringify(q));
      assert.equal(b.json.field, 'after');
    }
    assert.equal((await pc('PATCH', `nodes/${file.id}`, { deleteAt: 'bald' })).json.field, 'deleteAt');
    assert.equal((await pc('PATCH', `nodes/${file.id}`, { deleteAt: c.clock.now() + 400 * DAY })).json.field, 'deleteAt');
    assert.equal((await pc('PATCH', `nodes/${file.id}`, { deleteAt: isoAt(at), name: 'x.pdf' })).json.field, 'deleteAt');
    assert.equal((await pc('DELETE', `nodes/${mine.rootId}`, null, { after: '60' })).status, 400, 'never the root');
    // after=0: a delete now (as before)
    const now = await pc('DELETE', `nodes/${file.id}`, null, { after: '0' });
    assert.deepEqual([now.status, now.json.trashed], [200, 1]);
  });
});

test('marks: only with the right to write; other people\'s files stay out of reach', async () => {
  await withHost({}, async (host, c) => {
    const lenaArea = await c.area(LENA, 'child');
    const f = (await c.put(LENA, lenaArea.rootId, 'Tagebuch.txt', 'x')).json.node;
    // Anna, a parent, may look in (read) — not mark
    const r = await c.as(ANNA)('DELETE', `nodes/${f.id}`, null, { after: '60' });
    assert.equal(r.status, 403);
    assert.equal((await c.as(ANNA)('PATCH', `nodes/${f.id}`, { deleteAt: null })).status, 403);
    // Marc's own file: Anna cannot find it at all
    const marcMine = await c.area(MARC, 'mine');
    const g = (await c.put(MARC, marcMine.rootId, 'a.txt', 'x')).json.node;
    assert.equal((await c.as(ANNA)('DELETE', `nodes/${g.id}`, null, { after: '60' })).status, 404);
    // the family: whoever writes there may
    const fam = await c.area(ANNA, 'family');
    const h = (await c.put(ANNA, fam.rootId, 'Liste.txt', 'x')).json.node;
    const m = await c.as(MARC)('DELETE', `nodes/${h.id}`, null, { after: '60' });
    assert.equal(m.status, 200);
    assert.equal(m.json.node.deleteMarkedBy, MARC.id);
  });
});

test('marks: new content ends a mark — a new version, a rename, something new in a marked folder; the trash clears it', async () => {
  await withHost({}, async (host, c) => {
    const pc = c.as(ANNA, 'tok-pc');
    const mine = await c.area(ANNA, 'mine');
    const dir = (await pc('POST', 'nodes', { parentId: mine.rootId, name: 'Projekt' })).json.node;
    const file = (await c.put(ANNA, dir.id, 'a.txt', 'v1')).json.node;
    await pc('DELETE', `nodes/${file.id}`, null, { after: '86400' });
    await pc('DELETE', `nodes/${dir.id}`, null, { after: '86400' });
    const since = (await pc('GET', 'me')).json.latest;
    // uploaded again: the file's mark and the folder's end
    const v2 = await c.put(ANNA, dir.id, 'a.txt', 'v2', { baseRev: 1 });
    assert.equal(v2.json.node.deleteAt, undefined);
    assert.equal((await pc('GET', `nodes/${dir.id}`)).json.node.deleteAt, undefined);
    const ch = (await pc('GET', 'changes', null, { since })).json.changes.map((x) => [x.op, x.nodeId]);
    assert.deepEqual(ch.sort(), [['unmark', dir.id], ['update', file.id]].sort());
    // a rename ends it
    await pc('DELETE', `nodes/${file.id}`, null, { after: '86400' });
    assert.equal((await pc('PATCH', `nodes/${file.id}`, { name: 'b.txt' })).json.node.deleteAt, undefined);
    // a new folder in a marked folder ends the folder's
    await pc('DELETE', `nodes/${dir.id}`, null, { after: '86400' });
    await pc('POST', 'nodes', { parentId: dir.id, name: 'Neu' });
    assert.equal((await pc('GET', `nodes/${dir.id}`)).json.node.deleteAt, undefined);
    // a restored version ends it
    await pc('DELETE', `nodes/${file.id}`, null, { after: '86400' });
    const vid = (await pc('GET', `nodes/${file.id}/versions`)).json.versions[0].id;
    assert.equal((await pc('POST', `nodes/${file.id}/versions/${vid}/restore`)).json.node.deleteAt, undefined);
    // into the trash and back: no mark
    await pc('DELETE', `nodes/${file.id}`, null, { after: '86400' });
    await pc('DELETE', `nodes/${file.id}`);
    assert.equal((await pc('POST', `trash/${file.id}/restore`)).json.node.deleteAt, undefined);
    // changed on the NAS: the mark ends
    await pc('DELETE', `nodes/${file.id}`, null, { after: '86400' });
    const p = (await pc('GET', `nodes/${file.id}`)).json.node.path;
    await host.mediaScan(`u${ANNA.id}`, [{ type: 'changed', path: p, data: 'v3' }]);
    const n = (await pc('GET', `nodes/${file.id}`)).json.node;
    assert.deepEqual([n.size, n.deleteAt], [2, undefined]);
  });
});

test('marks: the background run puts what is due into the trash, as the person who marked it', async () => {
  await withHost({}, async (host, c) => {
    const pc = c.as(ANNA, 'tok-pc');
    const mine = await c.area(ANNA, 'mine');
    await pc('PUT', 'devices/pc-1', { name: 'PC' });
    const keep = (await c.put(ANNA, mine.rootId, 'bleibt.txt', 'x')).json.node;
    const dir = (await pc('POST', 'nodes', { parentId: mine.rootId, name: 'Alt' })).json.node;
    const inner = (await c.put(ANNA, dir.id, 'drin.txt', 'y')).json.node;
    const lone = (await c.put(ANNA, mine.rootId, 'weg.txt', 'z')).json.node;
    await pc('DELETE', `nodes/${dir.id}`, null, { after: String(2 * 86400) });
    await pc('DELETE', `nodes/${lone.id}`, null, { after: String(3 * 86400) });
    await pc('DELETE', `nodes/${keep.id}`, null, { after: String(10 * 86400) });
    // a share link of the folder ends with it
    const link = await pc('POST', 'links', { nodeId: dir.id, mode: 'download', expires: '7d' });
    assert.equal(link.status, 200);
    const since = (await pc('GET', 'me')).json.latest;

    c.clock.add(DAY);
    assert.equal((await host.tick()).markedTrashed, 0);
    c.clock.add(DAY + MIN);
    const t1 = await host.tick();
    assert.equal(t1.markedTrashed, 1);
    assert.equal((await pc('GET', `nodes/${dir.id}`)).status, 404);
    assert.equal((await pc('GET', `nodes/${inner.id}`)).status, 404);
    const trash = (await pc('GET', 'trash')).json.items;
    assert.deepEqual(trash.map((x) => [x.id, x.deletedBy]), [[dir.id, ANNA.id]]);
    const ch = (await pc('GET', 'changes', null, { since })).json.changes;
    assert.deepEqual(ch.map((x) => [x.op, x.nodeId, x.by, x.device]), [['delete', dir.id, ANNA.id, 'tok-pc']]);
    const ended = (await pc('GET', 'links')).json.links.find((l) => l.nodeId === dir.id);
    assert.deepEqual([ended.active, ended.endedWhy], [false, 'trashed']);
    assert.ok(c.events().some((e) => e.type === 'changed' && e.data.areas.includes(mine.id) && e.data.seq === ch[0].seq));

    c.clock.add(DAY);
    assert.equal((await host.tick()).markedTrashed, 1);
    assert.equal((await pc('GET', `nodes/${lone.id}`)).status, 404);
    // the one kept going is still there, marked
    assert.ok((await pc('GET', `nodes/${keep.id}`)).json.node.deleteAt);
    // what went in stays there trash_days long, then is purged like any other
    c.clock.add(31 * DAY);
    const t3 = await host.tick();
    assert.equal(t3.markedTrashed, 1);
    assert.ok(t3.purged >= 2);
  });
});

test('marks: older clients — DELETE without `after` is the plain delete; GET me says what this Drive can', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const f = (await c.put(ANNA, mine.rootId, 'x.txt', 'x')).json.node;
    const r = await a('DELETE', `nodes/${f.id}`);
    assert.deepEqual(r.json, { ok: true, id: f.id, trashed: 1 });
    const me = (await a('GET', 'me')).json;
    for (const k of ['devices', 'deleteAfter', 'emptyFiles']) assert.ok(me.features.includes(k), k);
    // a node without a mark has none of the fields
    const g = (await c.put(ANNA, mine.rootId, 'y.txt', 'y')).json.node;
    for (const k of ['deleteAt', 'deletedOnDevice', 'deleteMarkedBy']) assert.ok(!(k in g), k);
  });
});
