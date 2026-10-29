'use strict';

// Drive 1.12.1: a job ends — also when the time of its request or of a slice of the background run is up right after
// its last row (1.12.0 left it 'running' with done == total: no end, no last event 'op', no undo, a slot of the five
// taken for good); jobs left so by 1.12.0 end in the background run. The files of a job (GET ops/<id>?files=1, the
// live event 'op').

const test = require('node:test');
const assert = require('node:assert/strict');
const ops = require('../server/ops');
const { withHost, ANNA } = require('./helpers');

test.afterEach(() => ops._setItemHook(null));

/** Five files in Anna's "Meine Dateien" and the folder FEC; row i of a job takes `ms[i]` (a slow storage target). */
async function five(host, c, ms) {
  const a = c.as(ANNA);
  const mine = await c.area(ANNA, 'mine');
  const fec = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'FEC' })).json.node;
  const names = ['PXL_20261020.jpg', 'Scan 2026-10-21.pdf', 'Screenshot_20261022.jpg', 'Zeichnung_1.pdf', 'Notiz.txt'];
  const files = [];
  for (const n of names) files.push((await c.put(ANNA, mine.rootId, n, `content of ${n}`)).json.node);
  // (the media move is in the host; the job's hook after each row stands in for the time it took)
  let i = 0;
  ops._setItemHook(() => { c.clock.add(ms[Math.min(i++, ms.length - 1)]); });
  return { a, mine, fec, files };
}

const kids = async (a, id) => (await a('GET', `nodes/${id}/children`)).json.items.map((x) => x.name).sort();
const lastOp = (host, id) => host.events.filter((e) => e.type === 'op' && e.data.op.id === id).pop();

test('move of five files: the time of the request is up during the last one — the job still ends (done, last event, undo)', async () => {
  await withHost({}, async (host, c) => {
    const t = await five(host, c, [1200]);
    host.events.length = 0;
    const r = await t.a('POST', 'ops', { op: 'move', ids: t.files.map((f) => f.id), target: t.fec.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await ops.idle();
    const op = (await t.a('GET', `ops/${r.json.op.id}`)).json.op;
    assert.deepEqual([op.state, op.items, op.total, op.done, op.results.done], ['done', 5, 5, 5, 5]);
    assert.ok(op.undoUntil, 'undo works');
    assert.deepEqual(await kids(t.a, t.mine.rootId), ['FEC'], 'the five went');
    assert.equal((await kids(t.a, t.fec.id)).length, 5);
    assert.equal(lastOp(host, op.id).data.op.state, 'done', 'the last event says so');
    assert.equal((await t.a('GET', 'ops', null, { state: 'running' })).json.ops.length, 0);
  });
});

test('move of five files: the rest after the answer — the slice ends during the last one, the job still ends', async () => {
  await withHost({}, async (host, c) => {
    const t = await five(host, c, [2600, 2600, 1800]);
    host.events.length = 0;
    const r = await t.a('POST', 'ops', { op: 'move', ids: t.files.map((f) => f.id), target: t.fec.id });
    assert.equal(r.json.op.state, 'running', 'two within the request');
    assert.equal(r.json.op.done, 2);
    await ops.idle();
    const op = (await t.a('GET', `ops/${r.json.op.id}`)).json.op;
    assert.deepEqual([op.state, op.done, op.results.done], ['done', 5, 5]);
    assert.equal((await kids(t.a, t.fec.id)).length, 5);
    assert.equal(lastOp(host, op.id).data.op.state, 'done');
    assert.ok(host.events.some((e) => e.type === 'changed'), 'the changes are announced');
  });
});

test('move of five files in the background run (after a restart): the slice ends during the last one, the job still ends', async () => {
  await withHost({}, async (host, c) => {
    const t = await five(host, c, [1200]);
    const id = 'BBBBBBBBBBBBBBBBBBBBBB';
    const ids = t.files.map((f) => f.id);
    await host.gc.db.run(`INSERT INTO ops (id, user_id, kind, state, ids, target_id, items, total, bytes_total, created_at, updated_at)
      VALUES (?, ?, 'move', 'running', ?, ?, 5, 5, 0, ?, ?)`, [id, ANNA.id, JSON.stringify(ids), t.fec.id, c.clock.now(), c.clock.now()]);
    for (let i = 0; i < ids.length; i++) {
      await host.gc.db.run("INSERT INTO op_items (op_id, seq, node_id, is_dir, name, files) VALUES (?, ?, ?, 0, ?, 1)", [id, i + 1, ids[i], t.files[i].name]);
    }
    host.events.length = 0;
    await host.tick();
    await ops.idle();
    const op = (await t.a('GET', `ops/${id}`)).json.op;
    assert.deepEqual([op.state, op.done], ['done', 5]);
    assert.equal(lastOp(host, id).data.op.state, 'done');
  });
});

test('a job 1.12.0 left running with nothing left to do ends in the background run', async () => {
  await withHost({}, async (host, c) => {
    const t = await five(host, c, [0]);
    const id = 'CCCCCCCCCCCCCCCCCCCCCC';
    const ids = t.files.map((f) => f.id);
    await host.gc.db.run(`INSERT INTO ops (id, user_id, kind, state, ids, target_id, items, total, done, n_done, bytes_total, created_at, updated_at)
      VALUES (?, ?, 'move', 'running', ?, ?, 5, 5, 5, 5, 0, ?, ?)`, [id, ANNA.id, JSON.stringify(ids), t.fec.id, c.clock.now(), c.clock.now()]);
    for (let i = 0; i < ids.length; i++) {
      await host.gc.db.run("INSERT INTO op_items (op_id, seq, node_id, is_dir, name, files, state) VALUES (?, ?, ?, 0, ?, 1, 'done')", [id, i + 1, ids[i], t.files[i].name]);
    }
    // a step, as the moves left them: undo works after the end
    await host.gc.db.run("INSERT INTO op_steps (op_id, seq, action, node_id, data) VALUES (?, 1, 'moved', ?, ?)",
      [id, ids[0], JSON.stringify({ from: { parentId: t.mine.rootId, name: t.files[0].name }, to: { parentId: t.fec.id, name: t.files[0].name } })]);
    host.events.length = 0;
    await host.tick();
    await ops.idle();
    const op = (await t.a('GET', `ops/${id}`)).json.op;
    assert.equal(op.state, 'done');
    assert.ok(op.undoUntil);
    assert.equal(lastOp(host, id).data.op.state, 'done');
  });
});

test('the files of a job: GET ops/<id>?files=1, the live event (fewer), a copy waiting for a device', async () => {
  await withHost({}, async (host, c) => {
    const t = await five(host, c, [2600, 2600, 0]);
    host.events.length = 0;
    const r = await t.a('POST', 'ops', { op: 'move', ids: t.files.map((f) => f.id), target: t.fec.id });
    assert.equal(r.json.op.state, 'running');
    assert.equal(r.json.op.files, undefined, 'only when asked');
    const g = (await t.a('GET', `ops/${r.json.op.id}`, null, { files: '1' })).json.op;
    assert.deepEqual(g.files.map((f) => [f.name, f.state]), [
      ['PXL_20261020.jpg', 'done'], ['Scan 2026-10-21.pdf', 'done'], ['Screenshot_20261022.jpg', 'running'], ['Zeichnung_1.pdf', 'waiting'], ['Notiz.txt', 'waiting'],
    ]);
    assert.deepEqual(Object.keys(g.files[0]).sort(), ['bytesDone', 'isDir', 'name', 'nodeId', 'seq', 'size', 'state']);
    assert.equal(g.files[0].bytesDone, g.files[0].size);
    assert.equal(g.files[2].bytesDone, undefined, 'no byte progress of a move: an indeterminate bar');
    assert.equal(g.filesMore, 0);
    await ops.idle();
    const done = (await t.a('GET', `ops/${r.json.op.id}`, null, { files: 'true' })).json.op;
    assert.ok(done.files.every((f) => f.state === 'done'));
    const ev = lastOp(host, done.id).data.op;
    assert.equal(ev.files.length, 5, 'the event carries them too');
    // GET ops?files=1
    assert.equal((await t.a('GET', 'ops', null, { files: '1' })).json.ops[0].files.length, 5);
    // a copy waiting for a device (GateControl 1.208), a failed one (blocked: into itself) with its reason
    const sub = (await t.a('POST', 'nodes', { parentId: t.fec.id, name: 'Unter' })).json.node;
    const again = await t.a('POST', 'ops', { op: 'copy', ids: [t.files[0].id, t.fec.id], target: sub.id });
    const cf = (await t.a('GET', `ops/${again.json.op.id}`, null, { files: '1' })).json.op;
    assert.deepEqual(cf.files.map((f) => [f.name, f.isDir, f.state, f.reason || null]), [
      ['PXL_20261020.jpg', false, 'waiting', null], ['FEC', true, 'failed', 'into_itself'],
    ]);
    // cancelled: what was still to do is skipped
    await t.a('DELETE', `ops/${again.json.op.id}`);
    const cc = (await t.a('GET', `ops/${again.json.op.id}`, null, { files: '1' })).json.op;
    assert.deepEqual(cc.files.map((f) => [f.state, f.reason]), [['skipped', 'cancelled'], ['failed', 'into_itself']]);
  });
});

test('the files of a large job: a window of 500 around where it is, filesMore', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const dest = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Ziel' })).json.node;
    const id = 'DDDDDDDDDDDDDDDDDDDDDD';
    await host.gc.db.run(`INSERT INTO ops (id, user_id, kind, state, ids, target_id, items, total, created_at, updated_at)
      VALUES (?, ?, 'move', 'running', '[]', ?, 1200, 1200, ?, ?)`, [id, ANNA.id, dest.id, c.clock.now(), c.clock.now()]);
    for (let i = 1; i <= 1200; i++) {
      await host.gc.db.run('INSERT INTO op_items (op_id, seq, node_id, is_dir, name, files, size, state) VALUES (?, ?, ?, 0, ?, 1, 10, ?)', [id, i, 100000 + i, `f${i}`, i <= 400 ? 'done' : 'pending']);
    }
    const g = (await a('GET', `ops/${id}`, null, { files: '1' })).json.op;
    assert.equal(g.files.length, 500);
    assert.equal(g.filesMore, 700);
    assert.equal(g.files.find((f) => f.state === 'running').seq, 401);
    assert.equal(g.files[0].seq, 381, 'a few done ones before');
    // near the end: the last 500
    await host.gc.db.run("UPDATE op_items SET state = 'done' WHERE op_id = ? AND seq < 1150", [id]);
    const e = (await a('GET', `ops/${id}`, null, { files: '1' })).json.op;
    assert.deepEqual([e.files[0].seq, e.files[e.files.length - 1].seq, e.filesMore], [701, 1200, 700]);
  });
});
