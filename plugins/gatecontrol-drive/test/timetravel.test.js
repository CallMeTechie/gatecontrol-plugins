'use strict';

// Time travel (1.7.0, server/timetravel.js): a folder back to a time — the preview is what the run does, the run can be
// undone with a time travel to its `before`, rights, the history (node_log) and its limit, versions a time travel
// needs, and the ransomware protection that does not watch it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, BOB, MIN, DAY } = require('./helpers');

/** The folder's content as { 'path': 'bytes' | '/' } (folders '/'), from the API. */
async function snapshot(host, call, folderId, base = '') {
  const out = {};
  const r = await call('GET', `nodes/${folderId}/children`, null, { limit: 1000 });
  for (const n of r.json.items) {
    const p = base ? `${base}/${n.name}` : n.name;
    if (n.isDir) { out[p] = '/'; Object.assign(out, await snapshot(host, call, n.id, p)); continue; }
    const got = (await call('GET', `nodes/${n.id}/content`)).json;
    out[p] = got.empty ? '' : String((await host.mediaFromUrl(got.url)).body);
  }
  return out;
}

async function seed(c) {
  const a = c.portal(ANNA);
  const mine = await c.area(ANNA, 'mine');
  const top = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Projekt' })).json.node;
  const sub = (await a('POST', 'nodes', { parentId: top.id, name: 'Entwürfe' })).json.node;
  const elsewhere = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Woanders' })).json.node;
  const f = {};
  for (const [name, parent, data] of [['Brief.txt', top, 'Brief v1'], ['Plan.txt', top, 'Plan v1'], ['Notiz.txt', sub, 'Notiz'], ['Alt.txt', top, 'alt'],
    ['Weg.txt', top, 'geht raus'], ['Fremd.txt', elsewhere, 'von woanders']]) {
    f[name] = (await c.put(ANNA, parent.id, name, data)).json.node;
  }
  return { a, mine, top, sub, elsewhere, f };
}

test('preview = run: deleted back, contents of then, names and folders of then, what is new into the trash — and undo', async () => {
  await withHost({}, async (host, c) => {
    const { a, top, sub, elsewhere, f } = await seed(c);
    c.clock.add(MIN);
    const at = new Date(c.clock.now()).toISOString();
    const then = await snapshot(host, a, top.id);
    c.clock.add(MIN);
    // the changes since
    assert.equal((await a('DELETE', `nodes/${f['Alt.txt'].id}`)).status, 200);
    assert.equal((await c.put(ANNA, top.id, 'Brief.txt', 'Brief v2', { onConflict: 'version' })).status, 200);
    assert.equal((await a('PATCH', `nodes/${f['Plan.txt'].id}`, { name: 'Plan final.txt' })).status, 200);
    assert.equal((await a('PATCH', `nodes/${f['Notiz.txt'].id}`, { parentId: top.id })).status, 200);
    assert.equal((await a('PATCH', `nodes/${f['Weg.txt'].id}`, { parentId: elsewhere.id })).status, 200);
    assert.equal((await a('PATCH', `nodes/${f['Fremd.txt'].id}`, { parentId: sub.id })).status, 200);
    assert.equal((await c.put(ANNA, top.id, 'Neu.txt', 'neu')).status, 200);
    const nd = (await a('POST', 'nodes', { parentId: top.id, name: 'Neuer Ordner' })).json.node;
    assert.equal((await c.put(ANNA, nd.id, 'Drin.txt', 'drin')).status, 200);
    // a new file under the old name of a deleted one
    assert.equal((await a('DELETE', `nodes/${f['Brief.txt'].id}`)).status, 200);
    assert.equal((await c.put(ANNA, top.id, 'Brief.txt', 'ein anderer Brief')).status, 200);
    c.clock.add(MIN);
    const now = await snapshot(host, a, top.id);
    // the preview changes nothing
    const pv = await a('GET', `nodes/${top.id}/timetravel`, null, { at });
    assert.equal(pv.status, 200, JSON.stringify(pv.json));
    assert.deepEqual(await snapshot(host, a, top.id), now);
    const p = pv.json;
    assert.equal(p.at, at);
    assert.equal(p.limited, false);
    assert.equal(typeof p.historySince, 'string');
    assert.deepEqual({ restore: p.restore, revert: p.revert, move: p.move, trash: p.trash, lost: p.lost },
      { restore: 2, revert: 1, move: 4, trash: 4, lost: 0 }, JSON.stringify(p));
    assert.ok(p.sample.length > 0 && p.sample.every((s) => ['restore', 'revert', 'move', 'trash'].includes(s.op) && typeof s.name === 'string' && typeof s.path === 'string'));
    assert.ok(p.sample.some((s) => s.op === 'restore' && s.name === 'Alt.txt'));
    // the run: the same counts, the folder as it was
    const run = await a('POST', `nodes/${top.id}/timetravel`, { at });
    assert.equal(run.status, 200, JSON.stringify(run.json));
    const r = run.json;
    assert.deepEqual({ restored: r.restored, reverted: r.reverted, moved: r.moved, trashed: r.trashed, failed: r.failed },
      { restored: p.restore, reverted: p.revert, moved: p.move, trashed: p.trash, failed: 0 });
    assert.equal(r.at, at);
    assert.equal(r.before, new Date(c.clock.now() - 1).toISOString());
    assert.deepEqual(await snapshot(host, a, top.id), then);
    // what went elsewhere is back, what came from elsewhere went back there
    assert.equal((await a('GET', `nodes/${f['Weg.txt'].id}`)).json.node.parentId, top.id);
    assert.equal((await a('GET', `nodes/${f['Fremd.txt'].id}`)).json.node.parentId, elsewhere.id);
    // nothing deleted for good: the new ones are in the trash
    const trash = (await a('GET', 'trash')).json.items.map((x) => x.name).sort();
    assert.ok(['Brief.txt', 'Neu.txt', 'Neuer Ordner'].every((n) => trash.includes(n)), trash.join());
    // a second preview: nothing left to do
    const again = (await a('GET', `nodes/${top.id}/timetravel`, null, { at })).json;
    assert.deepEqual([again.restore, again.revert, again.move, again.trash], [0, 0, 0, 0]);
    // undo: a time travel to `before`
    c.clock.add(MIN);
    const undo = await a('POST', `nodes/${top.id}/timetravel`, { at: r.before });
    assert.equal(undo.status, 200, JSON.stringify(undo.json));
    assert.equal(undo.json.failed, 0);
    assert.deepEqual(await snapshot(host, a, top.id), now);
  });
});

test('rights: write on the folder — a parent reading the child\'s folder and others get no time travel', async () => {
  await withHost({}, async (host, c) => {
    const child = await c.area(LENA, 'child');
    const dir = (await c.as(LENA)('POST', 'nodes', { parentId: child.rootId, name: 'Schule' })).json.node;
    c.clock.add(MIN);
    const at = new Date(c.clock.now() - 30000).toISOString();
    for (const [m, body, q] of [['GET', null, { at }], ['POST', { at }, null]]) {
      assert.equal((await c.as(ANNA)(m, `nodes/${dir.id}/timetravel`, body, q)).status, 403, `${m}: a parent only reads`);
      assert.equal((await c.as(BOB)(m, `nodes/${dir.id}/timetravel`, body, q)).status, 404, `${m}: not visible`);
    }
    assert.equal((await c.as(LENA)('GET', `nodes/${dir.id}/timetravel`, null, { at })).status, 200);
    // the family folder: every member writes
    const fam = await c.area(MARC, 'family');
    assert.equal((await c.as(MARC)('GET', `nodes/${fam.rootId}/timetravel`, null, { at })).status, 200);
    // `at`: a time before now
    for (const bad of [undefined, 'gestern', new Date(c.clock.now() + MIN).toISOString()]) {
      const r = await c.as(LENA)('GET', `nodes/${dir.id}/timetravel`, null, bad === undefined ? {} : { at: bad });
      assert.equal(r.status, 400, String(bad));
      assert.equal(r.json.field, 'at');
    }
    // a file is no folder
    const file = (await c.put(LENA, dir.id, 'a.txt', 'a')).json.node;
    assert.equal((await c.as(LENA)('GET', `nodes/${file.id}/timetravel`, null, { at })).status, 400);
    // a locked device may not (a write)
    const me = (await c.as(LENA)('GET', 'me')).json;
    assert.ok(['timeTravel', 'takenAt', 'photos', 'albums', 'frame', 'storage'].every((x) => me.features.includes(x)));
  });
});

test('limited before the history began; contents older than the versions kept are lost (the preview says so)', async () => {
  await withHost({ settings: { versions_max: 1 } }, async (host, c) => {
    const a = c.portal(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const before = new Date(c.clock.now() - DAY).toISOString(); // before history_since (the first start)
    const dir = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Texte' })).json.node;
    const doc = (await c.put(ANNA, dir.id, 'Text.txt', 'eins')).json.node;
    c.clock.add(MIN);
    const at = new Date(c.clock.now()).toISOString();
    c.clock.add(MIN);
    await c.put(ANNA, dir.id, 'Text.txt', 'zwei', { onConflict: 'version' });
    c.clock.add(MIN);
    await c.put(ANNA, dir.id, 'Text.txt', 'drei', { onConflict: 'version' }); // versions_max 1: "eins" is gone
    const p = (await a('GET', `nodes/${dir.id}/timetravel`, null, { at })).json;
    assert.deepEqual([p.revert, p.lost, p.limited], [0, 1, false], JSON.stringify(p));
    const old = (await a('GET', `nodes/${mine.rootId}/timetravel`, null, { at: before })).json;
    assert.equal(old.limited, true);
    assert.ok(old.trash >= 1, 'everything made since is new');
    const r = (await a('POST', `nodes/${dir.id}/timetravel`, { at })).json;
    assert.deepEqual([r.reverted, r.lost, r.failed], [0, 1, 0]);
    const got = (await a('GET', `nodes/${doc.id}/content`)).json;
    assert.equal(String((await host.mediaFromUrl(got.url)).body), 'drei', 'the file stays as it is');
  });
});

test('versions a time travel made stay for its undo — versions_max and versions_days leave them', async () => {
  await withHost({ settings: { versions_max: 1, versions_days: 1, trash_days: 5 } }, async (host, c) => {
    const a = c.portal(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const dir = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Bilanz' })).json.node;
    const doc = (await c.put(ANNA, dir.id, 'Bilanz.txt', 'alt')).json.node;
    c.clock.add(MIN);
    const at = new Date(c.clock.now()).toISOString();
    c.clock.add(MIN);
    await c.put(ANNA, dir.id, 'Bilanz.txt', 'neu', { onConflict: 'version' });
    c.clock.add(MIN);
    const r = (await a('POST', `nodes/${dir.id}/timetravel`, { at })).json;
    assert.equal(r.reverted, 1);
    // two more versions (versions_max 1) and two days (versions_days 1): the one the undo needs stays
    await c.put(ANNA, dir.id, 'Bilanz.txt', 'noch neuer', { onConflict: 'version' });
    c.clock.add(2 * DAY);
    await host.tick();
    const vs = (await a('GET', `nodes/${doc.id}/versions`)).json.versions;
    assert.ok(vs.length >= 1);
    // the undo of the time travel brings "neu" back
    const u = (await a('POST', `nodes/${dir.id}/timetravel`, { at: r.before })).json;
    assert.equal(u.reverted, 1, JSON.stringify(u));
    const got = (await a('GET', `nodes/${doc.id}/content`)).json;
    assert.equal(String((await host.mediaFromUrl(got.url)).body), 'neu');
  });
});

test('300 files from one device: the ransomware protection does not watch a time travel (no row, no lock)', async () => {
  await withHost({ settings: { guard_files: 10 } }, async (host, c) => {
    const a = c.portal(ANNA);
    const pc = c.as(ANNA, 'tok-pc');
    const mine = await c.area(ANNA, 'mine');
    const dir = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Archiv' })).json.node;
    const old = [];
    for (let i = 1; i <= 150; i++) old.push((await c.put(ANNA, dir.id, `Datei${i}.txt`, `alt ${i}`)).json.node);
    c.clock.add(MIN);
    const at = new Date(c.clock.now()).toISOString();
    c.clock.add(MIN);
    // since then: 150 renamed, 150 new (from the portal — not watched either)
    for (let i = 0; i < 150; i++) await a('PATCH', `nodes/${old[i].id}`, { name: `${old[i].name}.alt` });
    for (let i = 1; i <= 150; i++) await c.put(ANNA, dir.id, `Neu${i}.txt`, `neu ${i}`);
    const rows = async () => (await host.gc.db.get("SELECT COUNT(*) AS n FROM guard_log WHERE device = 'tok-pc'", [])).row.n;
    const pv = await pc('GET', `nodes/${dir.id}/timetravel`, null, { at });
    assert.equal(pv.status, 200, JSON.stringify(pv.json));
    assert.deepEqual([pv.json.move, pv.json.trash], [150, 150]);
    const r = await pc('POST', `nodes/${dir.id}/timetravel`, { at });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.moved, r.json.trashed, r.json.failed], [150, 150, 0]);
    assert.equal(await rows(), 0, 'nothing in the guard\'s journal');
    const me = (await pc('GET', 'me')).json;
    assert.equal(me.guard.locked, false);
    assert.deepEqual(me.incidents, []);
    assert.equal(c.pushes().filter((n) => n.topic === 'guard').length, 0);
    // the device still writes
    assert.equal((await pc('POST', 'nodes', { parentId: dir.id, name: 'Danach' })).status, 200);
  });
});

test('a folder of 120 files: into the trash, back and purged in parts (GateControl takes ≤ 100 parameters a statement)', async () => {
  await withHost({}, async (host, c) => {
    const a = c.portal(ANNA);
    const mine = await c.area(ANNA, 'mine');
    c.clock.add(MIN);
    const at = new Date(c.clock.now()).toISOString();
    c.clock.add(MIN);
    const dir = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Viele' })).json.node;
    for (let i = 1; i <= 120; i++) await a('POST', 'nodes', { parentId: dir.id, name: `Ordner ${i}` });
    const p = (await a('GET', `nodes/${mine.rootId}/timetravel`, null, { at })).json;
    assert.deepEqual([p.trash, p.ops], [121, 1]);
    const r = (await a('POST', `nodes/${mine.rootId}/timetravel`, { at })).json;
    assert.deepEqual([r.trashed, r.failed], [121, 0]);
    assert.equal((await a('POST', `trash/${dir.id}/restore`)).status, 200);
    assert.equal((await a('GET', `nodes/${dir.id}/children`)).json.total, 120);
    assert.equal((await a('DELETE', `nodes/${dir.id}`)).status, 200);
    const gone = await a('DELETE', `trash/${dir.id}`);
    assert.equal(gone.status, 200, JSON.stringify(gone.json));
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM nodes WHERE trash_id = ?', [dir.id])).row.n, 0);
  });
});
