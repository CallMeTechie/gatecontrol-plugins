'use strict';

// Photos of a folder and the camera uploads (1.10.0, feature photosFolder — server/photos.js): GET photos, months and
// memories with folder= (that folder and every folder below it; read access, a vault 409 encrypted, a file or a folder
// outside `area` invalid) and camera=1 (Bilder/Kamera-Uploads of my files; none yet: nothing), GET|POST photos/camera
// — and a vault's contents never show.

const test = require('node:test');
const assert = require('node:assert/strict');
const VC = require('../ui/vaultcrypto');
const { withHost, ANNA, MARC, LENA, OMA, BOB, T0 } = require('./helpers');

const iso = (ms) => new Date(ms).toISOString();
const concat = (parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));

async function vaultIn(c, parentId) {
  const kp = await VC.generateDeviceKey();
  const raw = await VC.exportPublic(kp.publicKey);
  const id = VC.newVaultId();
  const tk = VC.newVaultKey();
  const rec = VC.newRecoveryKey();
  const rk = await VC.recoveryKeyPair(rec.key);
  const r = await c.as(ANNA)('POST', 'vaults', { id, parentId, nameCipher: await VC.encryptName(tk, id, 1, 'Tresor'), recoveryPub: VC.b64u(rk.publicRaw),
    recoveryAuth: await VC.recoveryAuth(rec.key), recoveryWrap: await VC.wrapKey(tk, rk.publicRaw, id, 1), device: { publicKey: VC.b64u(raw) }, wrap: await VC.wrapKey(tk, raw, id, 1) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { id, tk, node: r.json.node };
}

/** An encrypted file in vault `v` (folder `parentId`, default the vault's folder); its row then claims to be a JPEG. */
async function photoInVault(host, c, v, name, t, parentId = v.node.id) {
  const mediaId = await c.upload(ANNA, concat(await VC.encryptContent(v.tk, v.id, 1, new Uint8Array(Buffer.from(name)))), 'application/octet-stream');
  const r = await c.as(ANNA)('POST', 'uploads/commit', { mediaId, parentId, encrypted: true, nameCipher: await VC.encryptName(v.tk, v.id, 1, name), keyVersion: 1, takenAt: t });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // a second lock: even a vault's row that says image/* stays out
  await host.gc.db.run("UPDATE nodes SET mime = 'image/jpeg' WHERE id = ?", [r.json.node.id]);
  return r.json.node;
}

const mkdir = async (c, user, parentId, name) => {
  const r = await c.as(user)('POST', 'nodes', { parentId, name });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.node;
};
const names = (r) => r.json.items.map((x) => x.name);

test('photos of a folder: every folder below it, newest first, pages with before, months and memories', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    assert.ok((await a('GET', 'me')).json.features.includes('photosFolder'));
    const mine = await c.area(ANNA, 'mine');
    const fam = await c.area(ANNA, 'family');
    const pics = await mkdir(c, ANNA, mine.rootId, 'Bilder');
    const trip = await mkdir(c, ANNA, pics.id, 'Urlaub');
    const deep = await mkdir(c, ANNA, trip.id, 'Tag 1');
    const other = await mkdir(c, ANNA, mine.rootId, 'Dokumente');
    const base = Date.UTC(2026, 5, 1, 12);
    const put = (parentId, name, t, mime = 'image/jpeg') => c.put(ANNA, parentId, name, name, { mime, takenAt: t });
    await put(pics.id, 'oben.jpg', base);
    await put(trip.id, 'strand.mp4', base + 1000, 'video/mp4');
    for (let i = 0; i < 3; i++) await put(deep.id, `serie${i}.jpg`, base + 2000);
    await put(deep.id, 'notiz.txt', base + 3000, 'text/plain');
    await put(other.id, 'scan.jpg', base + 4000);
    await put(mine.rootId, 'wurzel.jpg', base + 5000);
    await put(fam.rootId, 'familie.jpg', base + 6000);
    const trashed = await mkdir(c, ANNA, trip.id, 'Weg');
    await put(trashed.id, 'weg.jpg', base + 7000);
    await a('DELETE', `nodes/${trashed.id}`);
    // the folder and everything below it — not the folder next to it, the root or another area, not a text, not the trash
    const all = await a('GET', 'photos', null, { folder: String(pics.id) });
    assert.equal(all.status, 200);
    assert.deepEqual(names(all), ['serie2.jpg', 'serie1.jpg', 'serie0.jpg', 'strand.mp4', 'oben.jpg']);
    assert.equal(all.json.next, null);
    assert.deepEqual(names(await a('GET', 'photos', null, { folder: deep.id })), ['serie2.jpg', 'serie1.jpg', 'serie0.jpg']);
    // the root of an area: the whole area (as area=)
    assert.deepEqual(names(await a('GET', 'photos', null, { folder: mine.rootId })), names(await a('GET', 'photos', null, { area: mine.id })));
    // pages: limit 1 ends after the whole burst, then goes on below it
    const p1 = (await a('GET', 'photos', null, { folder: pics.id, limit: '1' })).json;
    assert.deepEqual(p1.items.map((x) => x.name), ['serie2.jpg', 'serie1.jpg', 'serie0.jpg']);
    assert.equal(p1.next, iso(base + 2000));
    const p2 = (await a('GET', 'photos', null, { folder: pics.id, limit: '1', before: p1.next })).json;
    assert.deepEqual([p2.items.map((x) => x.name), p2.next], [['strand.mp4'], iso(base + 1000)]);
    const p3 = (await a('GET', 'photos', null, { folder: pics.id, limit: '1', before: p2.next })).json;
    assert.deepEqual([p3.items.map((x) => x.name), p3.next], [['oben.jpg'], null]);
    // with its own area: fine; another area: invalid
    assert.equal((await a('GET', 'photos', null, { folder: pics.id, area: mine.id })).json.items.length, 5);
    const wrong = await a('GET', 'photos', null, { folder: pics.id, area: fam.id });
    assert.deepEqual([wrong.status, wrong.json.field], [400, 'folder']);
    // months
    assert.deepEqual((await a('GET', 'photos/months', null, { folder: trip.id })).json.months, [{ month: '2026-06', count: 4 }]);
    const mWrong = await a('GET', 'photos/months', null, { folder: pics.id, area: fam.id });
    assert.deepEqual([mWrong.status, mWrong.json.field], [400, 'folder']);
    // memories: this day a year ago, only those of the folder
    const now = new Date(T0);
    const ago = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate(), 12).getTime();
    await put(trip.id, 'vorjahr.jpg', ago);
    await put(other.id, 'vorjahr-dok.jpg', ago);
    const mem = (await a('GET', 'photos/memories', null, { folder: pics.id })).json;
    assert.deepEqual(mem.groups.map((g) => [g.yearsAgo, g.items.map((x) => x.name)]), [[1, ['vorjahr.jpg']]]);
    assert.equal((await a('GET', 'photos/memories')).json.groups[0].items.length, 2, 'without a folder: both');
    assert.deepEqual((await a('GET', 'photos/memories', null, { folder: deep.id })).json.groups, []);
  });
});

test('photos of a folder: read access (404), a file or a bad id (400), a vault (409), folder and camera together (400)', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const pics = await mkdir(c, ANNA, mine.rootId, 'Bilder');
    const file = (await c.put(ANNA, pics.id, 'a.jpg', 'a', { mime: 'image/jpeg' })).json.node;
    for (const p of ['photos', 'photos/months', 'photos/memories']) {
      // Bob does not read Anna's files; Marc neither (her own area)
      for (const u of [BOB, MARC]) assert.equal((await c.as(u)('GET', p, null, { folder: pics.id })).status, 404, `${p} ${u.name}`);
      assert.equal((await a('GET', p, null, { folder: 999999 })).status, 404, p);
      for (const [folder, why] of [[file.id, 'a file'], ['abc', 'not an id'], ['-3', 'negative']]) {
        const r = await a('GET', p, null, { folder: String(folder) });
        assert.deepEqual([r.status, r.json.field], [400, 'folder'], `${p}: ${why}`);
      }
      const both = await a('GET', p, null, { folder: pics.id, camera: '1' });
      assert.deepEqual([both.status, both.json.field], [400, 'camera'], p);
      const bad = await a('GET', p, null, { camera: 'vielleicht' });
      assert.deepEqual([bad.status, bad.json.field], [400, 'camera'], p);
    }
    // a vault's folder: 409 encrypted; a folder inside the vault and a file of it too
    const v = await vaultIn(c, pics.id);
    const vf = await photoInVault(host, c, v, 'geheim.jpg', Date.UTC(2026, 5, 2));
    for (const p of ['photos', 'photos/months', 'photos/memories']) {
      for (const id of [v.node.id, vf.id]) {
        const r = await a('GET', p, null, { folder: id });
        assert.deepEqual([r.status, r.json.code], [409, 'encrypted'], `${p} ${id}`);
      }
    }
    // the folder around the vault: the vault's contents never show
    assert.deepEqual(names(await a('GET', 'photos', null, { folder: pics.id })), ['a.jpg']);
    assert.deepEqual(names(await a('GET', 'photos')), ['a.jpg']);
    assert.equal((await a('GET', 'photos/months', null, { folder: pics.id })).json.months.reduce((s, m) => s + m.count, 0), 1);
    // a folder in the trash: gone
    const old = await mkdir(c, ANNA, mine.rootId, 'Alt');
    await a('DELETE', `nodes/${old.id}`);
    assert.equal((await a('GET', 'photos', null, { folder: old.id })).status, 404);
  });
});

test('photos of a folder: a parent who reads the child\'s folder sees its photos (the child hears of it) — read access is enough', async () => {
  await withHost({}, async (host, c) => {
    const child = await c.area(LENA, 'child');
    const school = await mkdir(c, LENA, child.rootId, 'Schule');
    await c.put(LENA, school.id, 'klasse.jpg', 'k', { mime: 'image/jpeg' });
    const r = await c.as(ANNA)('GET', 'photos', null, { folder: school.id });
    assert.deepEqual(names(r), ['klasse.jpg']);
    assert.equal(c.pushes().filter((n) => n.topic === 'child_view' && n.users.includes(LENA.id)).length, 1);
  });
});

test('camera uploads: GET|POST photos/camera, camera=1 for photos, months and memories; none yet: nothing; vault contents never', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const fam = await c.area(ANNA, 'family');
    // none yet: no folder, empty answers, no error
    assert.deepEqual((await a('GET', 'photos/camera')).json, { ok: true, folder: null });
    await c.put(ANNA, mine.rootId, 'lose.jpg', 'l', { mime: 'image/jpeg' });
    assert.deepEqual((await a('GET', 'photos', null, { camera: '1' })).json, { ok: true, items: [], next: null });
    assert.deepEqual((await a('GET', 'photos/months', null, { camera: '1' })).json.months, []);
    assert.deepEqual((await a('GET', 'photos/memories', null, { camera: '1' })).json.groups, []);
    // "Bilder" there, "Kamera-Uploads" not yet: still nothing
    const pics = await mkdir(c, ANNA, mine.rootId, 'bilder');
    assert.equal((await a('GET', 'photos/camera')).json.folder, null);
    // POST: made where missing — the existing "bilder" (names as in every path: case-insensitive), the change log
    const since = (await a('GET', 'me')).json.latest;
    const made = await a('POST', 'photos/camera');
    assert.equal(made.status, 200, JSON.stringify(made.json));
    assert.equal(made.json.created, true);
    assert.deepEqual(Object.keys(made.json.folder).sort(), ['areaId', 'id', 'path']);
    assert.equal(made.json.folder.path, 'bilder/Kamera-Uploads');
    assert.equal(made.json.folder.areaId, mine.id);
    const node = (await a('GET', `nodes/${made.json.folder.id}`)).json.node;
    assert.deepEqual([node.isDir, node.parentId, node.name], [true, pics.id, 'Kamera-Uploads']);
    const log = (await a('GET', 'changes', null, { since: String(since) })).json.changes;
    assert.deepEqual(log.filter((x) => x.op === 'create').map((x) => x.nodeId), [made.json.folder.id]);
    // again: the same folder, nothing new
    const again = await a('POST', 'photos/camera');
    assert.deepEqual([again.json.created, again.json.folder], [false, made.json.folder]);
    assert.deepEqual((await a('GET', 'photos/camera')).json.folder, made.json.folder);
    // the photos below it, with the year and month folders the app makes
    const y = await mkdir(c, ANNA, made.json.folder.id, '2026');
    const mo = await mkdir(c, ANNA, y.id, '06');
    const base = Date.UTC(2026, 5, 1, 12);
    await c.put(ANNA, mo.id, 'IMG_1.jpg', '1', { mime: 'image/jpeg', takenAt: base });
    await c.put(ANNA, mo.id, 'VID_2.mp4', '2', { mime: 'video/mp4', takenAt: base + 1000 });
    await c.put(ANNA, made.json.folder.id, 'IMG_0.heic', '0', { mime: 'image/heic', takenAt: base - 86400000 * 40 });
    await c.put(ANNA, pics.id, 'daneben.jpg', 'd', { mime: 'image/jpeg', takenAt: base + 2000 });
    await c.put(ANNA, fam.rootId, 'familie.jpg', 'f', { mime: 'image/jpeg', takenAt: base + 3000 });
    // a vault in the camera folder: never shown
    const v = await vaultIn(c, made.json.folder.id);
    await photoInVault(host, c, v, 'tresor.jpg', base + 4000);
    const r = await a('GET', 'photos', null, { camera: '1' });
    assert.deepEqual(names(r), ['VID_2.mp4', 'IMG_1.jpg', 'IMG_0.heic']);
    assert.deepEqual(names(await a('GET', 'photos', null, { camera: 'true', area: mine.id })), ['VID_2.mp4', 'IMG_1.jpg', 'IMG_0.heic']);
    assert.ok(names(await a('GET', 'photos')).includes('daneben.jpg'), 'without camera: every photo (photos are files)');
    assert.ok(!names(await a('GET', 'photos')).includes('tresor.jpg'));
    // pages with before
    const p1 = (await a('GET', 'photos', null, { camera: '1', limit: '2' })).json;
    assert.deepEqual([p1.items.map((x) => x.name), p1.next], [['VID_2.mp4', 'IMG_1.jpg'], iso(base)]);
    const p2 = (await a('GET', 'photos', null, { camera: '1', limit: '2', before: p1.next })).json;
    assert.deepEqual([p2.items.map((x) => x.name), p2.next], [['IMG_0.heic'], null]);
    assert.deepEqual((await a('GET', 'photos/months', null, { camera: '1' })).json.months, [{ month: '2026-06', count: 2 }, { month: '2026-04', count: 1 }]);
    // memories: a year ago in the camera folder, not the one next to it
    const now = new Date(T0);
    const ago = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate(), 12).getTime();
    await c.put(ANNA, mo.id, 'IMG_alt.jpg', 'alt', { mime: 'image/jpeg', takenAt: ago });
    await c.put(ANNA, pics.id, 'alt-daneben.jpg', 'ad', { mime: 'image/jpeg', takenAt: ago });
    await photoInVault(host, c, v, 'tresor-alt.jpg', ago);
    assert.deepEqual((await a('GET', 'photos/memories', null, { camera: '1' })).json.groups.map((g) => g.items.map((x) => x.name)), [['IMG_alt.jpg']]);
    assert.deepEqual((await a('GET', 'photos/memories')).json.groups.map((g) => g.items.map((x) => x.name).sort()), [['IMG_alt.jpg', 'alt-daneben.jpg']]);
    // camera with another area: invalid
    for (const p of ['photos', 'photos/months', 'photos/memories']) {
      const x = await a('GET', p, null, { camera: '1', area: fam.id });
      assert.deepEqual([x.status, x.json.field], [400, 'area'], p);
    }
    // each person has their own: Marc none yet, then his own folder
    assert.equal((await c.as(MARC)('GET', 'photos/camera')).json.folder, null);
    assert.deepEqual((await c.as(MARC)('GET', 'photos', null, { camera: '1' })).json.items, []);
    const marc = (await c.as(MARC)('POST', 'photos/camera')).json;
    assert.equal(marc.folder.areaId, `mine:${MARC.id}`);
    assert.equal(marc.folder.path, 'Bilder/Kamera-Uploads');
    assert.notEqual(marc.folder.id, made.json.folder.id);
  });
});

test('POST photos/camera: a file in the way (409 exists), no seat 403; the app\'s and the portal\'s answers alike', async () => {
  await withHost({}, async (host, c) => {
    const bob = await c.area(BOB, 'mine');
    await c.put(BOB, bob.rootId, 'Bilder', 'kein Ordner');
    const r = await c.as(BOB)('POST', 'photos/camera');
    assert.deepEqual([r.status, r.json.code, r.json.field], [409, 'exists', 'path']);
    assert.equal((await c.as(BOB)('GET', 'photos/camera')).json.folder, null);
    assert.deepEqual((await c.as(BOB)('GET', 'photos', null, { camera: '1' })).json.items, []);
    // Oma has no seat
    assert.equal((await c.as(OMA)('POST', 'photos/camera')).status, 403);
    // the portal: the same folder
    const p = await c.portal(ANNA)('POST', 'photos/camera');
    assert.equal(p.status, 200);
    assert.deepEqual((await c.as(ANNA)('GET', 'photos/camera')).json.folder, p.json.folder);
  });
});
