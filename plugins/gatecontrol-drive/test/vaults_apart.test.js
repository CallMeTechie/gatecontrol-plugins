'use strict';

// Vaults apart (1.11.0, feature vaultsApart): the vault folders are in the menu only — GET children leaves them out
// (vaults=1 lists them), children?dirs=1 gives the folder tree with hasDirs, a new vault goes into the top folder of the
// area its parentId is in, a vault folder no longer moves; vault folders of older versions move into the top folder of
// their area (start and the background run — idempotent, with the change log and the live event), and the encryption
// does not notice (the names and contents stay readable, the paths follow).

const test = require('node:test');
const assert = require('node:assert/strict');
const VC = require('../ui/vaultcrypto');
const { withHost, ANNA, MARC, MIN } = require('./helpers');

const concat = (parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));

async function deviceOf() {
  const kp = await VC.generateDeviceKey();
  const raw = await VC.exportPublic(kp.publicKey);
  return { privateKey: kp.privateKey, publicRaw: raw, publicKey: VC.b64u(raw), id: await VC.deviceId(raw) };
}

/** Make a vault as `call` with `parentId` → { id, tk, node, vault } */
async function makeVault(call, parentId, dev, name = 'Steuer') {
  const id = VC.newVaultId();
  const tk = VC.newVaultKey();
  const rec = VC.newRecoveryKey();
  const rk = await VC.recoveryKeyPair(rec.key);
  const r = await call('POST', 'vaults', {
    id, parentId, nameCipher: await VC.encryptName(tk, id, 1, name), recoveryPub: VC.b64u(rk.publicRaw), recoveryAuth: await VC.recoveryAuth(rec.key), recoveryWrap: await VC.wrapKey(tk, rk.publicRaw, id, 1),
    device: { publicKey: dev.publicKey, name: 'Laptop', platform: 'windows' }, wrap: await VC.wrapKey(tk, dev.publicRaw, id, 1),
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { id, tk, node: r.json.node, vault: r.json.vault };
}

async function putEncrypted(c, user, v, parentId, name, data) {
  const parts = await VC.encryptContent(v.tk, v.id, 1, new Uint8Array(Buffer.from(data)));
  const mediaId = await c.upload(user, concat(parts), 'application/octet-stream');
  const r = await c.as(user)('POST', 'uploads/commit', { mediaId, parentId, encrypted: true, nameCipher: await VC.encryptName(v.tk, v.id, 1, name), keyVersion: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.node;
}

/** What an older Drive left: vault `v` in folder `folder` (its row and the paths of its files, as a move would have). */
async function intoFolder(host, v, folder) {
  const db = host.gc.db;
  await db.run('UPDATE nodes SET parent_id = ? WHERE id = ?', [folder.id, v.node.id]);
  const files = (await db.query('SELECT id, media_id FROM nodes WHERE vault_id = ? AND is_dir = 0 AND media_id IS NOT NULL', [v.id])).rows;
  for (const f of files) {
    const m = host.media.get(f.media_id);
    await host.gc.media.move(f.media_id, { path: `${folder.name}/${m.path}` });
  }
}

const seqOf = async (host) => (await host.gc.db.query('SELECT COALESCE(MAX(seq), 0) AS s FROM changes')).rows[0].s;

test('GET me: the feature vaultsApart', async () => {
  await withHost({}, async (host, c) => {
    assert.ok((await c.as(ANNA)('GET', 'me')).json.features.includes('vaultsApart'));
  });
});

test('children: no vault folders (total too), vaults=1 lists them, inside a vault as before; dirs=1 the tree with hasDirs', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const docs = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Dokumente' })).json.node;
    const bills = (await a('POST', 'nodes', { parentId: docs.id, name: 'Rechnungen' })).json.node;
    await a('POST', 'nodes', { parentId: mine.rootId, name: 'alt' });
    const empty = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Bilder' })).json.node;
    await c.put(ANNA, mine.rootId, 'Brief.pdf', '%PDF');
    // a folder in the trash is no folder of the tree
    const gone = (await a('POST', 'nodes', { parentId: empty.id, name: 'weg' })).json.node;
    await a('DELETE', `nodes/${gone.id}`);
    const v = await makeVault(a, mine.rootId, await deviceOf());
    const sub = (await a('POST', 'nodes', { parentId: v.node.id, encrypted: true, nameCipher: await VC.encryptName(v.tk, v.id, 1, 'Belege'), keyVersion: 1 })).json.node;
    await putEncrypted(c, ANNA, v, v.node.id, 'a.txt', 'x');

    const plain = (await a('GET', `nodes/${mine.rootId}/children`)).json;
    assert.deepEqual(plain.items.map((x) => x.name), ['alt', 'Bilder', 'Dokumente', 'Brief.pdf']);
    assert.equal(plain.total, 4);
    assert.ok(plain.items.every((x) => x.hasDirs === undefined), 'hasDirs only with dirs=1');
    const withVaults = (await a('GET', `nodes/${mine.rootId}/children`, null, { vaults: 1 })).json;
    assert.equal(withVaults.total, 5);
    assert.ok(withVaults.items.some((x) => x.id === v.node.id && x.encrypted));
    // inside the vault: everything, as before
    const inside = (await a('GET', `nodes/${v.node.id}/children`)).json;
    assert.equal(inside.total, 2);
    assert.ok(inside.items.some((x) => x.id === sub.id));
    // the tree: folders only, by name (sort ignored), hasDirs; no vault
    const tree = (await a('GET', `nodes/${mine.rootId}/children`, null, { dirs: 1, sort: 'size', order: 'asc' })).json;
    assert.deepEqual(tree.items.map((x) => [x.name, x.hasDirs]), [['alt', false], ['Bilder', false], ['Dokumente', true]]);
    assert.equal(tree.total, 3);
    assert.deepEqual((await a('GET', `nodes/${docs.id}/children`, null, { dirs: 1 })).json.items.map((x) => [x.id, x.hasDirs]), [[bills.id, false]]);
    // a page of the tree
    const page = (await a('GET', `nodes/${mine.rootId}/children`, null, { dirs: 1, limit: 2 })).json;
    assert.deepEqual([page.items.map((x) => x.name), page.next, page.total], [['alt', 'Bilder'], 2, 3]);
    // with vaults=1 the vault is a folder of the tree too; inside a vault its folders
    assert.equal((await a('GET', `nodes/${mine.rootId}/children`, null, { dirs: 1, vaults: 1 })).json.total, 4);
    const vt = (await a('GET', `nodes/${v.node.id}/children`, null, { dirs: 1 })).json.items;
    assert.deepEqual(vt.map((x) => [x.id, x.hasDirs]), [[sub.id, false]]);
    // search and the photos never show a vault (as since 1.9.0)
    assert.deepEqual((await a('GET', 'search', null, { q: v.node.name.slice(0, 8) })).json.items, []);
  });
});

test('POST vaults: always into the top folder of the area of parentId; a vault folder does not move (400), a rename does', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const fam = await c.area(ANNA, 'family');
    const deep = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'A' })).json.node;
    const deeper = (await a('POST', 'nodes', { parentId: deep.id, name: 'B' })).json.node;
    const famSub = (await a('POST', 'nodes', { parentId: fam.rootId, name: 'Haus' })).json.node;
    const dev = await deviceOf();
    const v1 = await makeVault(a, deeper.id, dev, 'Eins');
    assert.equal(v1.node.parentId, mine.rootId);
    assert.equal(v1.vault.parentId, mine.rootId);
    assert.equal(v1.node.areaId, mine.id);
    const v2 = await makeVault(a, famSub.id, dev, 'Zwei');
    assert.equal(v2.node.parentId, fam.rootId);
    assert.equal(v2.vault.areaId, fam.id);
    // a folder of an area one only reads, inside a vault: refused as before
    const child = await c.area(ANNA, 'child');
    const ro = await a('POST', 'vaults', { id: VC.newVaultId(), parentId: child.rootId });
    assert.ok([400, 403].includes(ro.status), String(ro.status));
    assert.equal((await a('POST', 'vaults', { id: VC.newVaultId(), parentId: v1.node.id })).status, 400);
    // no move: into a folder, into another area, not even back from the top
    for (const parentId of [deep.id, fam.rootId, famSub.id]) {
      const r = await a('PATCH', `nodes/${v1.node.id}`, { parentId });
      assert.equal(r.status, 400, `to ${parentId}`);
      assert.equal(r.json.field, 'parentId');
    }
    // the same folder, a new encrypted name: fine
    assert.equal((await a('PATCH', `nodes/${v1.node.id}`, { parentId: mine.rootId })).status, 200);
    const ren = await a('PATCH', `nodes/${v1.node.id}`, { nameCipher: await VC.encryptName(v1.tk, v1.id, 1, 'Neu') });
    assert.equal(ren.status, 200, JSON.stringify(ren.json));
    assert.equal(await VC.decryptName({ 1: v1.tk }, v1.id, ren.json.node.nameCipher), 'Neu');
    // inside a vault nodes still move
    const s1 = (await a('POST', 'nodes', { parentId: v1.node.id, encrypted: true, nameCipher: await VC.encryptName(v1.tk, v1.id, 1, 's1'), keyVersion: 1 })).json.node;
    const f = await putEncrypted(c, ANNA, v1, v1.node.id, 'f.txt', 'f');
    assert.equal((await a('PATCH', `nodes/${f.id}`, { parentId: s1.id })).status, 200);
    // a folder holding nothing of a vault any more moves and goes into the trash as any other
    assert.equal((await a('PATCH', `nodes/${deep.id}`, { parentId: fam.rootId })).status, 200);
    assert.equal((await a('DELETE', `nodes/${deep.id}`)).status, 200);
  });
});

test('vault folders of an older version move into the top folder of their area — once, with the change log and the live event; nothing breaks', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const fam = await c.area(ANNA, 'family');
    const old = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Alt' })).json.node;
    const famOld = (await a('POST', 'nodes', { parentId: fam.rootId, name: 'Familie alt' })).json.node;
    const dev = await deviceOf();
    const v = await makeVault(a, mine.rootId, dev, 'Steuer');
    const sub = (await a('POST', 'nodes', { parentId: v.node.id, encrypted: true, nameCipher: await VC.encryptName(v.tk, v.id, 1, 'Belege'), keyVersion: 1 })).json.node;
    const f = await putEncrypted(c, ANNA, v, sub.id, 'Beleg.pdf', 'geheimer Beleg');
    const w = await makeVault(a, fam.rootId, dev, 'Haus');
    const g = await putEncrypted(c, ANNA, w, w.node.id, 'Plan.txt', 'Plan');
    // as an older Drive left them: in folders below the top
    await intoFolder(host, v, old);
    await intoFolder(host, w, famOld);
    assert.equal(host.media.get(f.mediaId).path, `Alt/${v.node.name}/${sub.name}/${f.name}`);
    c.clock.add(MIN);
    const seq = await seqOf(host);
    const events = c.events().length;
    await host.tick();
    // both at the top, the paths of the files follow (also on a NAS: a rename), the opaque names stay
    for (const [x, area] of [[v, mine], [w, fam]]) {
      const n = (await a('GET', `nodes/${x.node.id}`)).json.node;
      assert.equal(n.parentId, area.rootId);
      assert.equal(n.name, x.node.name);
    }
    assert.equal(host.media.get(f.mediaId).path, `${v.node.name}/${sub.name}/${f.name}`);
    assert.equal(host.media.get(g.mediaId).path, `${w.node.name}/${g.name}`);
    // the change log: a move each; the live event to the readers of both areas
    const ch = (await a('GET', 'changes', null, { since: seq })).json.changes;
    assert.deepEqual(ch.map((x) => [x.op, x.nodeId]).sort(), [['move', v.node.id], ['move', w.node.id]].sort());
    assert.equal(ch.find((x) => x.nodeId === v.node.id).node.parentId, mine.rootId);
    const ev = c.events().slice(events).filter((e) => e.type === 'changed');
    assert.ok(ev.some((e) => e.users.includes(ANNA.id) && e.data.areas.includes(mine.id)));
    assert.ok(ev.some((e) => e.users.includes(MARC.id) && e.data.areas.includes(fam.id)), 'Marc reads the family');
    // the history knows where it was (time travel)
    const log = (await host.gc.db.query('SELECT parent_id FROM node_log WHERE node_id = ? ORDER BY id DESC LIMIT 1', [v.node.id])).rows[0];
    assert.equal(log.parent_id, old.id);
    // idempotent: nothing more to do
    const seq2 = await seqOf(host);
    await host.tick();
    assert.equal(await seqOf(host), seq2);
    // the device still reads everything: names, contents (nothing of the encryption hangs on the folder)
    const k = (await a('GET', `vaults/${v.id}/keys`, null, { deviceId: dev.id })).json;
    const tk = await VC.unwrapKey(k.keys[0].wrap, dev.privateKey, dev.publicRaw, v.id, 1);
    const top = (await a('GET', `nodes/${v.node.id}`)).json.node;
    assert.equal(await VC.decryptName(new Map([[1, tk]]), v.id, top.nameCipher), 'Steuer');
    const list = (await a('GET', `nodes/${sub.id}/children`)).json.items;
    assert.equal(await VC.decryptName(new Map([[1, tk]]), v.id, list[0].nameCipher), 'Beleg.pdf');
    const ct = host.media.get(f.mediaId).data;
    const pt = concat(await VC.decryptContent(new Map([[1, tk]]), v.id, (x, y) => Promise.resolve(ct.subarray(x, y + 1)), ct.length));
    assert.equal(pt.toString('utf8'), 'geheimer Beleg');
    // the folders that held them are plain folders now: into the trash and back, nothing of a vault with them
    const del = await a('DELETE', `nodes/${old.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.json.trashed, 1);
    assert.equal((await a('GET', `nodes/${v.node.id}`)).status, 200);
    assert.equal((await a('GET', 'vaults')).json.vaults.length, 2);
  });
});

test('a vault folder that comes back from the trash, or by a time travel, stays in the top folder', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const old = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Alt' })).json.node;
    const dev = await deviceOf();
    const v = await makeVault(a, mine.rootId, dev, 'Steuer');
    await putEncrypted(c, ANNA, v, v.node.id, 'x.txt', 'x');
    // an older layout, then the move to the top
    await intoFolder(host, v, old);
    c.clock.add(MIN);
    const before = Date.now();
    c.clock.add(MIN);
    await host.tick();
    assert.equal((await a('GET', `nodes/${v.node.id}`)).json.node.parentId, mine.rootId);
    c.clock.add(MIN);
    // the time travel of the folder it was in: the vault stays where it is, nothing fails
    const tt = await a('POST', `nodes/${old.id}/timetravel`, { at: new Date(before).toISOString() });
    assert.equal(tt.status, 200, JSON.stringify(tt.json));
    assert.equal(tt.json.failed, 0);
    assert.equal((await a('GET', `nodes/${v.node.id}`)).json.node.parentId, mine.rootId);
    // the trash: a vault folder in a folder (an older layout) comes back to the top
    await intoFolder(host, v, old);
    assert.equal((await a('DELETE', `nodes/${v.node.id}`)).status, 200);
    const back = await a('POST', `trash/${v.node.id}/restore`);
    assert.equal(back.status, 200, JSON.stringify(back.json));
    assert.equal(back.json.node.parentId, mine.rootId);
  });
});
