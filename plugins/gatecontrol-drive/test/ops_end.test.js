'use strict';

// Drive 1.12.1: a job ends — also when the time of its request or of a slice of the background run is up right after
// its last row (1.12.0 left it 'running' with done == total: no end, no last event 'op', no undo, a slot of the five
// taken for good); jobs left so by 1.12.0 end in the background run. The files of a job (GET ops/<id>?files=1, the
// live event 'op'). Drive 1.12.2: the answer comes at once — a quick job gets 0.3 s within its request, any other goes
// on right after the answer (the apps' "Ziel wählen" waited up to 5 s).

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
    const t = await five(host, c, [0, 0, 0, 0, 400]);
    host.events.length = 0;
    const r = await t.a('POST', 'ops', { op: 'move', ids: t.files.map((f) => f.id), target: t.fec.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.op.state, 'done', 'a quick job ends within its request');
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
    const t = await five(host, c, [400, 1000, 1000, 1000, 2600]);
    host.events.length = 0;
    const r = await t.a('POST', 'ops', { op: 'move', ids: t.files.map((f) => f.id), target: t.fec.id });
    assert.equal(r.json.op.state, 'running', 'one within the request (0.3 s)');
    assert.equal(r.json.op.done, 1);
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
    const t = await five(host, c, [400, 0]);
    host.events.length = 0;
    const r = await t.a('POST', 'ops', { op: 'move', ids: t.files.map((f) => f.id), target: t.fec.id });
    assert.equal(r.json.op.state, 'running');
    const states = [['PXL_20261020.jpg', 'done'], ['Scan 2026-10-21.pdf', 'running'], ['Screenshot_20261022.jpg', 'waiting'], ['Zeichnung_1.pdf', 'waiting'], ['Notiz.txt', 'waiting']];
    assert.deepEqual(r.json.op.files.map((f) => [f.name, f.state]), states, 'the answer carries them (1.12.2)');
    const g = (await t.a('GET', `ops/${r.json.op.id}`, null, { files: '1' })).json.op;
    assert.deepEqual(g.files.map((f) => [f.name, f.state]), states);
    assert.equal((await t.a('GET', `ops/${r.json.op.id}`)).json.op.files, undefined, 'GET only when asked');
    assert.deepEqual(Object.keys(g.files[0]).sort(), ['bytesDone', 'isDir', 'name', 'nodeId', 'seq', 'size', 'state']);
    assert.equal(g.files[0].bytesDone, g.files[0].size);
    assert.equal(g.files[1].bytesDone, undefined, 'no byte progress of a move: an indeterminate bar');
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
    await ops.idle();
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

test('1.12.2: the answer comes at once — a larger job goes on right after it (the events with its files), its undo too', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const fotos = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Fotos' })).json.node;
    for (let i = 0; i < 60; i++) await c.put(ANNA, fotos.id, `IMG_${String(i).padStart(4, '0')}.jpg`, `jpeg ${i}`);
    const dest = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Familie' })).json.node;
    let rows = 0;
    ops._setItemHook(() => { rows++; c.clock.add(50); });
    host.events.length = 0;
    // a folder with 60 files (more than a quick job's 50 nodes): nothing done within the request
    const r = await a('POST', 'ops', { op: 'move', ids: [fotos.id], target: dest.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.op.state, r.json.op.done, r.json.op.total, rows], ['running', 0, 60, 0], 'the answer before any work');
    assert.deepEqual(r.json.op.files.map((f) => [f.name, f.isDir, f.state]), [['Fotos', true, 'running']], 'its files from the start');
    await ops.idle();
    const op = (await a('GET', `ops/${r.json.op.id}`)).json.op;
    assert.deepEqual([op.state, op.done, op.results.done], ['done', 60, 1]);
    assert.ok(op.undoUntil);
    assert.deepEqual(await kids(a, dest.id), ['Fotos']);
    const evs = host.events.filter((e) => e.type === 'op' && e.data.op.id === op.id);
    assert.equal(evs[evs.length - 1].data.op.state, 'done', 'the last event says so');
    assert.deepEqual(evs[evs.length - 1].data.op.files.map((f) => f.state), ['done'], 'with its files');
    // a quick job still comes back done: three files into the trash
    const some = (await a('GET', `nodes/${fotos.id}/children`)).json.items.slice(0, 3).map((x) => x.id);
    const q = await a('POST', 'ops', { op: 'trash', ids: some });
    assert.equal(q.json.op.state, 'done');
    assert.deepEqual(q.json.op.files.map((f) => f.state), ['done', 'done', 'done']);
    // the undo of the large move: at once too, it goes on after the answer
    rows = 0;
    const u = await a('POST', `ops/${op.id}/undo`);
    assert.equal(u.status, 200, JSON.stringify(u.json));
    assert.deepEqual([u.json.op.kind, u.json.op.state, rows], ['undo', 'running', 0]);
    await ops.idle();
    assert.equal((await a('GET', `ops/${u.json.op.id}`)).json.op.state, 'done');
    assert.deepEqual(await kids(a, mine.rootId), ['Familie', 'Fotos']);
  });
});

test('1.12.2: a job that comes while the process works on another one is not left for the background run', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const mk = async (name) => (await a('POST', 'nodes', { parentId: mine.rootId, name })).json.node;
    const big = await mk('Gross');
    for (let i = 0; i < 55; i++) await c.put(ANNA, big.id, `f${i}.txt`, `x${i}`);
    const big2 = await mk('Gross2');
    for (let i = 0; i < 55; i++) await c.put(ANNA, big2.id, `g${i}.txt`, `y${i}`);
    const d1 = await mk('Ziel1');
    const d2 = await mk('Ziel2');
    let second = null;
    // while the first job is at work in the plugin process, the second one is asked for
    ops._setItemHook(async () => {
      if (!second) second = await a('POST', 'ops', { op: 'move', ids: [big2.id], target: d2.id });
    });
    const first = await a('POST', 'ops', { op: 'move', ids: [big.id], target: d1.id });
    assert.equal(first.json.op.state, 'running');
    await ops.idle();
    assert.equal(second && second.status, 200, 'the second came while the first one was at work');
    assert.equal((await a('GET', `ops/${first.json.op.id}`)).json.op.state, 'done');
    assert.equal((await a('GET', `ops/${second.json.op.id}`)).json.op.state, 'done', 'not left for the background run');
  });
});
