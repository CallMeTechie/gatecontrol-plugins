'use strict';

// "Nur auf diesem Gerät" (1.32.0, vaultlocal.js, feature vaultLocal): the device's proof (HPKE, opened with
// ui/vaultcrypto.js as the apps do), the move (manifest, lease, locks, commit, content hidden for 24 hours and then gone
// for good), "Rückgängig", the way back, "Platzhalter entfernen", what is refused (shared vaults, the switch off, nested,
// writes into a placeholder, the trash, the time travel, jobs) — and that the server keeps nothing it could read.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');
const VC = require('../ui/vaultcrypto');
const local = require('../server/vaultlocal');
const { withHost, ANNA, MARC, DAY, MIN } = require('./helpers');

const concat = (parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));
const ON = { settings: { vault_local: true } };

async function deviceOf() {
  const kp = await VC.generateDeviceKey();
  const raw = await VC.exportPublic(kp.publicKey);
  return { privateKey: kp.privateKey, publicRaw: raw, publicKey: VC.b64u(raw), id: await VC.deviceId(raw) };
}

async function makeVault(call, parentId, dev, name = 'Privat') {
  const id = VC.newVaultId();
  const tk = VC.newVaultKey();
  const rec = VC.newRecoveryKey();
  const rk = await VC.recoveryKeyPair(rec.key);
  const r = await call('POST', 'vaults', {
    id, parentId, nameCipher: await VC.encryptName(tk, id, 1, name), recoveryPub: VC.b64u(rk.publicRaw), recoveryAuth: await VC.recoveryAuth(rec.key), recoveryWrap: await VC.wrapKey(tk, rk.publicRaw, id, 1),
    device: { publicKey: dev.publicKey, name: 'Pixel 8', platform: 'android' }, wrap: await VC.wrapKey(tk, dev.publicRaw, id, 1),
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { id, tk, rec, node: r.json.node };
}

/** A second device of the same person, approved by the first (wraps every version). */
async function addDevice(call, v, name = 'Laptop', platform = 'windows') {
  const dev = await deviceOf();
  const ask = await call('POST', `vaults/${v.id}/devices`, { publicKey: dev.publicKey, name, platform });
  assert.equal(ask.status, 200, JSON.stringify(ask.json));
  const ok = await call('POST', `vaults/${v.id}/devices/${dev.id}/approve`, { wrap: await VC.wrapKey(v.tk, dev.publicRaw, v.id, 1) });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  return dev;
}

const encName = (v, name) => VC.encryptName(v.tk, v.id, 1, name);

async function folder(call, v, parentId, name) {
  const r = await call('POST', 'nodes', { parentId, encrypted: true, nameCipher: await encName(v, name), keyVersion: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.node;
}

async function upload(c, user, device, v, parentId, name, data, extra = {}) {
  const parts = await VC.encryptContent(v.tk, v.id, 1, new Uint8Array(Buffer.from(data)));
  const mediaId = await c.upload(user, concat(parts), 'application/octet-stream');
  return c.as(user, device)('POST', 'uploads/commit', { mediaId, parentId, encrypted: true, nameCipher: await encName(v, name), keyVersion: 1, ...extra });
}

/** The proof the device gives: open the challenge with its key (what the apps do with their Keystore key). */
async function proofOf(call, v, dev) {
  const r = await call('POST', `vaults/${v.id}/local/challenge`, { deviceId: dev.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const b = VC.unb64u(r.json.challenge);
  assert.equal(b.length, 81, 'the shape of a wrap');
  assert.equal(b[0], 1);
  const info = new TextEncoder().encode(`gcdrive-v1:local-proof:${v.id}:${dev.id}`);
  const secret = await VC.hpkeOpen(dev.privateKey, dev.publicRaw, info, new Uint8Array(0), b.subarray(1));
  assert.equal(secret.length, 32);
  return VC.b64u(secret);
}

const sent = (items) => items.map((x) => (x.isDir ? { id: x.id } : { id: x.id, rev: x.rev, sha256: x.sha256 }));

/** A vault of Anna's own files with Ordner "Fotos" (a sub folder, two files, one file in the trash). */
async function setup(c, phone = 'phone-a') {
  const a = c.as(ANNA, phone);
  const mine = await c.area(ANNA, 'mine');
  const dev = await deviceOf();
  const v = await makeVault(a, mine.rootId, dev);
  const fotos = await folder(a, v, v.node.id, 'Fotoalbum');
  const urlaub = await folder(a, v, fotos.id, 'Sommerreise');
  const f1 = (await upload(c, ANNA, phone, v, fotos.id, 'Strand.jpg', 'Bild am Strand')).json.node;
  const f2 = (await upload(c, ANNA, phone, v, urlaub.id, 'Berg.jpg', 'Bild am Berg')).json.node;
  const old = (await upload(c, ANNA, phone, v, fotos.id, 'Alt.jpg', 'altes Bild')).json.node;
  assert.equal((await a('DELETE', `nodes/${old.id}`)).status, 200);
  // a new version of f1 (the versions are counted and go too)
  const f1b = await upload(c, ANNA, phone, v, fotos.id, 'Strand.jpg', 'Bild am Strand, Fassung 2', { name: f1.name, onConflict: 'version' });
  assert.equal(f1b.status, 200, JSON.stringify(f1b.json));
  return { a, mine, dev, v, fotos, urlaub, f1: f1b.json.node, f2, old };
}

async function move(c, t, phone = 'phone-a') {
  const a = c.as(ANNA, phone);
  const s = await a('POST', `vaults/${t.v.id}/local`, { nodeId: t.fotos.id, deviceId: t.dev.id });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const proof = await proofOf(a, t.v, t.dev);
  const cm = await a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/commit`, { deviceId: t.dev.id, proof, manifest: sent(s.json.manifest.items) });
  assert.equal(cm.status, 200, JSON.stringify(cm.json));
  return { start: s.json, commit: cm.json };
}

test('the proof: the server seals with Node\'s crypto, ui/vaultcrypto.js opens it (the apps\' HPKE of the wraps)', async () => {
  const dev = await deviceOf();
  const info = Buffer.from('gcdrive-v1:local-proof:x:y');
  const pt = crypto.randomBytes(32);
  const sealed = local.hpkeSeal(Buffer.from(dev.publicRaw), info, pt);
  assert.equal(sealed.length, 32 + 32 + 16);
  assert.deepEqual(Buffer.from(await VC.hpkeOpen(dev.privateKey, dev.publicRaw, new Uint8Array(info), new Uint8Array(0), new Uint8Array(sealed))), pt);
  await assert.rejects(VC.hpkeOpen(dev.privateKey, dev.publicRaw, new TextEncoder().encode('gcdrive-v1:local-proof:x:z'), new Uint8Array(0), new Uint8Array(sealed)));
});

test('move to the device: manifest, lease, locks while moving, proof and manifest checked, then only a placeholder', async () => {
  await withHost(ON, async (host, c) => {
    const t = await setup(c);
    const a = t.a;
    const pin = await a('PUT', `nodes/${t.f2.id}/offline`);
    assert.equal(pin.status, 200);
    const me = await a('GET', 'me');
    assert.ok(me.json.features.includes('vaultLocal'));
    const s = await a('POST', `vaults/${t.v.id}/local`, { nodeId: t.fotos.id, deviceId: t.dev.id });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    assert.equal(s.json.local.state, 'moving');
    assert.equal(s.json.local.deviceName, 'Pixel 8');
    assert.equal(s.json.local.thisDevice, true);
    assert.deepEqual([s.json.manifest.files, s.json.manifest.folders], [2, 1]);
    assert.equal(s.json.versions.count, 1);
    assert.deepEqual([s.json.trash.entries, s.json.trash.files], [1, 1]);
    const item = s.json.manifest.items.find((x) => x.id === t.f1.id);
    assert.deepEqual([item.rev, item.sha256, item.mediaId, item.parentId], [2, t.f1.sha256, t.f1.mediaId, t.fotos.id]);
    assert.ok(item.nameCipher);
    // while it moves: reading works, writing waits
    assert.equal((await a('GET', `nodes/${t.fotos.id}/children`)).json.items.length, 2);
    const busy = await upload(c, ANNA, 'phone-a', t.v, t.urlaub.id, 'Neu.jpg', 'neu');
    assert.equal(busy.status, 409);
    assert.equal(busy.json.code, 'local_moving');
    assert.match(busy.json.error, /Pixel 8/);
    assert.equal((await a('DELETE', `nodes/${t.f2.id}`)).json.code, 'local_moving');
    // the lease
    const l = await a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/lease`, { deviceId: t.dev.id });
    assert.equal(l.status, 200);
    // the commit: no proof, a wrong one, a used one
    const man = sent(s.json.manifest.items);
    assert.equal((await a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/commit`, { deviceId: t.dev.id, manifest: man })).json.reason, 'proof');
    await a('POST', `vaults/${t.v.id}/local/challenge`, { deviceId: t.dev.id });
    assert.equal((await a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/commit`, { deviceId: t.dev.id, proof: VC.b64u(crypto.randomBytes(32)), manifest: man })).json.reason, 'proof');
    // the manifest: what the device has must be what is there
    const p1 = await proofOf(a, t.v, t.dev);
    const short = await a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/commit`, { deviceId: t.dev.id, proof: p1, manifest: man.filter((x) => x.id !== t.f2.id) });
    assert.equal(short.status, 409);
    assert.equal(short.json.reason, 'changed');
    assert.deepEqual(short.json.added.map((x) => x.id), [t.f2.id]);
    const stale = man.map((x) => (x.id === t.f1.id ? { ...x, rev: 1 } : x));
    const p2 = await proofOf(a, t.v, t.dev);
    assert.deepEqual((await a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/commit`, { deviceId: t.dev.id, proof: p2, manifest: stale })).json.changed.map((x) => x.id), [t.f1.id]);
    assert.equal((await a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/commit`, { deviceId: t.dev.id, proof: p2, manifest: man })).json.reason, 'proof', 'a proof counts once');
    host.events.length = 0;
    const p3 = await proofOf(a, t.v, t.dev);
    const cm = await a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/commit`, { deviceId: t.dev.id, proof: p3, manifest: man });
    assert.equal(cm.status, 200, JSON.stringify(cm.json));
    assert.equal(cm.json.local.state, 'local');
    assert.equal(cm.json.local.undo, true);
    assert.equal(cm.json.hidden, 3);
    // the placeholder: an empty folder with `local`; nothing below it can be read
    const kids = await a('GET', `nodes/${t.fotos.id}/children`, null, { deviceId: t.dev.id });
    assert.deepEqual(kids.json.items, []);
    assert.equal(kids.json.local.state, 'local');
    assert.equal(kids.json.local.thisDevice, true);
    const up = await a('GET', `nodes/${t.v.node.id}/children`);
    const ph = up.json.items.find((x) => x.id === t.fotos.id);
    assert.equal(ph.local.deviceName, 'Pixel 8');
    assert.equal(ph.local.platform, 'android');
    assert.equal(ph.local.mine, true);
    assert.equal(ph.nameCipher, t.fotos.nameCipher, 'the name stays (encrypted)');
    for (const id of [t.f1.id, t.f2.id, t.urlaub.id]) assert.equal((await a('GET', `nodes/${id}`)).status, 404);
    assert.equal((await a('GET', `nodes/${t.f1.id}/content`)).status, 404);
    assert.ok(!(await a('GET', 'trash')).json.items.some((x) => [t.old.id, t.f1.id].includes(x.id)), 'not in the trash');
    assert.deepEqual((await a('GET', 'offline')).json.items, [], 'the offline marks end');
    assert.equal((await a('GET', `nodes/${t.f1.id}/versions`)).status, 404);
    // the list of the vault, another device of the person sees it greyed
    const lap = await addDevice(a, t.v);
    const ls = await c.as(ANNA, 'pc-a')('GET', `vaults/${t.v.id}/local`, null, { deviceId: lap.id });
    assert.deepEqual(ls.json.items.map((x) => [x.nodeId, x.state, x.deviceName, x.thisDevice]), [[t.fotos.id, 'local', 'Pixel 8', false]]);
    // the change log: a 'delete' of what was right below, 'local' for the placeholder
    const ch = (await a('GET', 'changes', null, { since: 0 })).json.changes;
    const last = ch.filter((x) => x.nodeId === t.fotos.id).pop();
    assert.equal(last.op, 'local');
    assert.equal(last.node.local.state, 'local');
    assert.ok(ch.some((x) => x.op === 'delete' && x.nodeId === t.urlaub.id));
    // a push to the person's devices, the live event, no alarm of the ransomware protection
    const p = c.pushes().filter((x) => x.topic === 'vault' && x.data.drive.event === 'local').pop();
    assert.deepEqual(p.users, [ANNA.id]);
    assert.match(p.body, /Pixel 8/);
    assert.equal(p.data.drive.event, 'local');
    assert.ok(host.events.some((e) => e.type === 'vault' && e.data.event === 'local' && e.data.node === t.fotos.id));
    assert.deepEqual((await a('GET', 'guard/incidents')).json.incidents || [], []);
    // the media lie hidden for 24 hours, then they go — with the versions and the trash entry
    const media = [t.f1.mediaId, t.f2.mediaId, t.old.mediaId];
    for (const m of media) assert.ok(host.media.has(m), 'still kept for the undo');
    c.clock.add(DAY - MIN);
    await host.tick();
    assert.ok(host.media.has(t.f1.mediaId));
    c.clock.add(2 * MIN);
    await host.tick();
    for (const m of media) assert.equal(host.media.has(m), false, 'gone for good');
    const rows = (await host.gc.db.query('SELECT COUNT(*) AS n FROM nodes WHERE trash_id = ?', [t.fotos.id])).rows[0].n;
    assert.equal(rows, 0);
    assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM versions')).rows[0].n, 0);
    const after = await a('GET', `vaults/${t.v.id}/local/${t.fotos.id}`);
    assert.equal(after.json.local.undo, false);
    assert.equal(after.json.local.purgeAt, null);
    assert.equal((await a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/undo`, { deviceId: t.dev.id })).json.reason, 'purged');
  });
});

test('a placeholder refuses what would put something on the server: uploads, folders, moves, jobs, the trash, the time travel', async () => {
  await withHost(ON, async (host, c) => {
    const t = await setup(c);
    const a = t.a;
    const other = await folder(a, t.v, t.v.node.id, 'Andere');
    const loose = (await upload(c, ANNA, 'phone-a', t.v, other.id, 'Lose.jpg', 'lose')).json.node;
    await move(c, t);
    const up = await upload(c, ANNA, 'phone-a', t.v, t.fotos.id, 'Neu.jpg', 'neu');
    assert.equal(up.status, 409);
    assert.equal(up.json.code, 'local_only');
    assert.equal(up.json.deviceName, 'Pixel 8');
    assert.match(up.json.error, /Pixel 8/);
    assert.equal((await a('POST', 'nodes', { parentId: t.fotos.id, encrypted: true, nameCipher: await encName(t.v, 'X'), keyVersion: 1 })).json.code, 'local_only');
    assert.equal((await a('PATCH', `nodes/${loose.id}`, { parentId: t.fotos.id })).json.code, 'local_only');
    assert.equal((await a('PUT', `nodes/${t.fotos.id}/offline`)).json.code, 'local_only');
    // the trash: not the placeholder, not a folder holding it (only …/forget), not a mark either
    assert.equal((await a('DELETE', `nodes/${t.fotos.id}`)).json.code, 'local_only');
    assert.equal((await a('DELETE', `nodes/${t.fotos.id}`, null, { after: 60 })).json.code, 'local_only');
    // jobs
    const mv = await a('POST', 'ops/check', { op: 'move', ids: [loose.id], target: t.fotos.id });
    assert.equal(mv.json.code, 'local_only');
    const tr = await a('POST', 'ops/check', { op: 'trash', ids: [t.fotos.id, loose.id] });
    assert.deepEqual(tr.json.blocked.map((x) => [x.id, x.reason]), [[t.fotos.id, 'local_only']]);
    // the time travel of the vault's folder would bring the hidden content back
    assert.equal((await a('GET', `nodes/${t.v.node.id}/timetravel`, null, { at: new Date(Date.now() - MIN).toISOString() })).json.code, 'local_only');
    // a vault folder that holds a placeholder: not into the trash either
    const sub = await folder(a, t.v, t.v.node.id, 'Oben');
    assert.equal((await a('PATCH', `nodes/${t.fotos.id}`, { parentId: sub.id })).status, 200, 'the placeholder itself may move');
    assert.equal((await a('DELETE', `nodes/${sub.id}`)).json.code, 'local_only');
    // a rename of the placeholder (its encrypted name) works
    assert.equal((await a('PATCH', `nodes/${t.fotos.id}`, { nameCipher: await encName(t.v, 'Bilder') })).status, 200);
    // the switch off: placeholders stay what they are, no new ones
    await host.saveSettings({ vault_local: false });
    assert.ok(!(await a('GET', 'me')).json.features.includes('vaultLocal'));
    assert.equal((await upload(c, ANNA, 'phone-a', t.v, t.fotos.id, 'Neu.jpg', 'neu')).json.code, 'local_only');
    assert.equal((await a('POST', `vaults/${t.v.id}/local`, { nodeId: other.id, deviceId: t.dev.id })).json.code, 'feature_off');
  });
});

test('who and where: only "Nur ich", an approved device of mine, a folder below the vault, not nested', async () => {
  await withHost(ON, async (host, c) => {
    const t = await setup(c);
    const a = t.a;
    // a family vault
    const fam = await c.area(ANNA, 'family');
    const fdev = await deviceOf();
    const fv = await makeVault(a, fam.rootId, fdev, 'Familie');
    const ff = await folder(a, fv, fv.node.id, 'Gemeinsam');
    assert.equal((await a('POST', `vaults/${fv.id}/local`, { nodeId: ff.id, deviceId: fdev.id })).json.code, 'local_shared');
    // the vault's folder itself; a file; another vault's folder
    assert.equal((await a('POST', `vaults/${t.v.id}/local`, { nodeId: t.v.node.id, deviceId: t.dev.id })).json.field, 'nodeId');
    assert.equal((await a('POST', `vaults/${t.v.id}/local`, { nodeId: t.f1.id, deviceId: t.dev.id })).json.field, 'nodeId');
    assert.equal((await a('POST', `vaults/${t.v.id}/local`, { nodeId: ff.id, deviceId: t.dev.id })).json.field, 'nodeId');
    // a device that is not approved, one of another vault
    const lone = await deviceOf();
    await a('POST', `vaults/${t.v.id}/devices`, { publicKey: lone.publicKey, name: 'Neu' });
    assert.equal((await a('POST', `vaults/${t.v.id}/local`, { nodeId: t.fotos.id, deviceId: lone.id })).json.reason, 'device');
    assert.equal((await a('POST', `vaults/${t.v.id}/local`, { nodeId: t.fotos.id, deviceId: fdev.id })).json.reason, 'device');
    // someone else: not their vault
    assert.equal((await c.as(MARC)('POST', `vaults/${t.v.id}/local`, { nodeId: t.fotos.id, deviceId: t.dev.id })).status, 404);
    // nested: below a placeholder, above one
    const s = await a('POST', `vaults/${t.v.id}/local`, { nodeId: t.urlaub.id, deviceId: t.dev.id });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    const lap = await addDevice(a, t.v);
    const nest = await c.as(ANNA, 'pc-a')('POST', `vaults/${t.v.id}/local`, { nodeId: t.fotos.id, deviceId: lap.id });
    assert.equal(nest.json.code, 'local_nested');
    assert.equal(nest.json.deviceName, 'Pixel 8');
    // the other device cannot take a move over
    assert.equal((await c.as(ANNA, 'pc-a')('POST', `vaults/${t.v.id}/local`, { nodeId: t.urlaub.id, deviceId: lap.id })).json.code, 'local_moving');
    // called off: nothing was deleted, writes work again
    assert.equal((await a('DELETE', `vaults/${t.v.id}/local/${t.urlaub.id}`, null, { deviceId: t.dev.id })).status, 200);
    assert.equal((await upload(c, ANNA, 'phone-a', t.v, t.urlaub.id, 'Neu.jpg', 'neu')).status, 200);
    assert.deepEqual((await a('GET', `vaults/${t.v.id}/local`)).json.items, []);
  });
});

test('a lease that runs out ends the move — nothing was deleted', async () => {
  await withHost(ON, async (host, c) => {
    const t = await setup(c);
    const s = await t.a('POST', `vaults/${t.v.id}/local`, { nodeId: t.fotos.id, deviceId: t.dev.id });
    assert.equal(s.status, 200);
    c.clock.add(31 * MIN);
    assert.equal((await upload(c, ANNA, 'phone-a', t.v, t.fotos.id, 'Neu.jpg', 'neu')).status, 200, 'the lock ends with the lease');
    await host.tick();
    assert.deepEqual((await t.a('GET', `vaults/${t.v.id}/local`)).json.items, []);
    assert.equal((await t.a('GET', `nodes/${t.fotos.id}/children`)).json.items.length, 3);
  });
});

test('"Rückgängig" within 24 hours: everything back as it was — paths, versions, the trash entry', async () => {
  await withHost(ON, async (host, c) => {
    const t = await setup(c);
    await move(c, t);
    c.clock.add(5 * 3600000);
    const lap = await addDevice(t.a, t.v);
    assert.equal((await c.as(ANNA, 'pc-a')('POST', `vaults/${t.v.id}/local/${t.fotos.id}/undo`, { deviceId: lap.id })).json.reason, 'device', 'only on the device with the copy');
    const u = await t.a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/undo`, { deviceId: t.dev.id });
    assert.equal(u.status, 200, JSON.stringify(u.json));
    assert.equal(u.json.restored, 3);
    const kids = await t.a('GET', `nodes/${t.fotos.id}/children`);
    assert.equal(kids.json.items.length, 2);
    assert.equal(kids.json.local, undefined);
    const f = (await t.a('GET', `nodes/${t.f2.id}`)).json.node;
    assert.equal(f.parentId, t.urlaub.id);
    const ct = host.media.get(f.mediaId).data;
    const pt = concat(await VC.decryptContent(new Map([[1, t.v.tk]]), t.v.id, (x, y) => Promise.resolve(ct.subarray(x, y + 1)), ct.length));
    assert.equal(pt.toString('utf8'), 'Bild am Berg');
    assert.equal((await t.a('GET', `nodes/${t.f1.id}/versions`)).json.versions.length, 1);
    assert.ok((await t.a('GET', 'trash')).json.items.some((x) => x.id === t.old.id), 'back in the trash');
    assert.equal((await upload(c, ANNA, 'phone-a', t.v, t.fotos.id, 'Neu.jpg', 'neu')).status, 200);
    c.clock.add(DAY);
    await host.tick();
    assert.ok(host.media.has(t.f1.mediaId), 'nothing goes after the undo');
  });
});

test('back to the server: only the returning device uploads, the count is checked, then a plain folder', async () => {
  await withHost(ON, async (host, c) => {
    const t = await setup(c);
    await move(c, t);
    const a = t.a;
    const r = await a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/return`, { deviceId: t.dev.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.local.state, 'returning');
    // another GateControl device of the same person: still local for it
    assert.equal((await upload(c, ANNA, 'pc-a', t.v, t.fotos.id, 'X.jpg', 'x')).json.code, 'local_only');
    const sub = await folder(a, t.v, t.fotos.id, 'Urlaub');
    assert.equal((await upload(c, ANNA, 'phone-a', t.v, t.fotos.id, 'Strand.jpg', 'Bild am Strand, Fassung 2')).status, 200);
    assert.equal((await upload(c, ANNA, 'phone-a', t.v, sub.id, 'Berg.jpg', 'Bild am Berg')).status, 200);
    assert.equal((await a('GET', `nodes/${t.fotos.id}/children`)).json.items.length, 2, 'the returning device sees what is up');
    assert.deepEqual((await c.as(ANNA, 'pc-a')('GET', `nodes/${t.fotos.id}/children`)).json.items, [], 'others not yet');
    const p1 = await proofOf(a, t.v, t.dev);
    const bad = await a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/return/commit`, { deviceId: t.dev.id, proof: p1, count: 3 });
    assert.equal(bad.json.reason, 'count');
    assert.equal(bad.json.files, 2);
    const p2 = await proofOf(a, t.v, t.dev);
    const ok = await a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/return/commit`, { deviceId: t.dev.id, proof: p2, count: 2 });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal((await c.as(ANNA, 'pc-a')('GET', `nodes/${t.fotos.id}/children`)).json.items.length, 2);
    assert.equal((await upload(c, ANNA, 'pc-a', t.v, t.fotos.id, 'X.jpg', 'x')).status, 200, 'a plain folder again');
    // what lay hidden from the move went for good with the return
    assert.equal(host.media.has(t.f1.mediaId), false);
    assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM nodes WHERE trash_id = ?', [t.fotos.id])).rows[0].n, 0);
  });
});

test('a return whose lease runs out is local again; what it uploaded stays out of sight and is kept for the next try', async () => {
  await withHost(ON, async (host, c) => {
    const t = await setup(c);
    await move(c, t);
    await t.a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/return`, { deviceId: t.dev.id });
    assert.equal((await upload(c, ANNA, 'phone-a', t.v, t.fotos.id, 'Strand.jpg', 'x')).status, 200);
    c.clock.add(31 * MIN);
    await host.tick();
    const l = await t.a('GET', `vaults/${t.v.id}/local/${t.fotos.id}`);
    assert.equal(l.json.local.state, 'local');
    assert.deepEqual((await t.a('GET', `nodes/${t.fotos.id}/children`)).json.items, []);
    assert.equal((await upload(c, ANNA, 'phone-a', t.v, t.fotos.id, 'Neu.jpg', 'neu')).json.code, 'local_only');
    assert.equal((await t.a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/undo`, { deviceId: t.dev.id })).json.reason, 'not_empty');
    await t.a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/return`, { deviceId: t.dev.id });
    assert.equal((await t.a('GET', `nodes/${t.fotos.id}/children`)).json.items.length, 1, 'the next try sees the part already up');
  });
});

test('"Platzhalter entfernen": another device only after the 24 hours, the device itself with its proof; into the trash, a push', async () => {
  await withHost(ON, async (host, c) => {
    const t = await setup(c);
    await move(c, t);
    const lap = await addDevice(t.a, t.v);
    const pc = c.as(ANNA, 'pc-a');
    const early = await pc('POST', `vaults/${t.v.id}/local/${t.fotos.id}/forget`, { deviceId: lap.id });
    assert.equal(early.json.reason, 'purge_pending');
    assert.ok(early.json.purgeAt);
    assert.equal((await c.as(MARC)('POST', `vaults/${t.v.id}/local/${t.fotos.id}/forget`, { deviceId: lap.id })).status, 404);
    c.clock.add(DAY + MIN);
    await host.tick();
    const f = await pc('POST', `vaults/${t.v.id}/local/${t.fotos.id}/forget`, { deviceId: lap.id });
    assert.equal(f.status, 200, JSON.stringify(f.json));
    assert.equal(f.json.trashed, 1);
    assert.equal((await pc('GET', `nodes/${t.fotos.id}`)).status, 404);
    assert.ok((await pc('GET', 'trash')).json.items.some((x) => x.id === t.fotos.id), 'an empty folder in the trash');
    assert.deepEqual((await pc('GET', `vaults/${t.v.id}/local`)).json.items, []);
    const p = c.pushes().filter((x) => x.topic === 'vault' && x.data.drive.event === 'local_forgotten').pop();
    assert.ok(p);
    assert.match(p.body, /Pixel 8/);
  });
  await withHost(ON, async (host, c) => {
    const t = await setup(c);
    await move(c, t);
    assert.equal((await t.a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/forget`, { deviceId: t.dev.id })).json.reason, 'proof');
    const proof = await proofOf(t.a, t.v, t.dev);
    const f = await t.a('POST', `vaults/${t.v.id}/local/${t.fotos.id}/forget`, { deviceId: t.dev.id, proof });
    assert.equal(f.status, 200, JSON.stringify(f.json));
    assert.equal(host.media.has(t.f1.mediaId), false, 'with the proof: gone at once');
  });
});

test('the server keeps nothing it could read — and not the proof', async () => {
  await withHost(ON, async (host, c) => {
    const t = await setup(c);
    const a = t.a;
    await a('POST', `vaults/${t.v.id}/local`, { nodeId: t.fotos.id, deviceId: t.dev.id });
    const proof = await proofOf(a, t.v, t.dev);
    const tables = (await host.gc.db.query("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => r.name);
    let dump = '';
    for (const tb of tables) dump += JSON.stringify((await host.gc.db.query(`SELECT * FROM "${tb}"`)).rows);
    dump += JSON.stringify([...host.kv.entries()]) + JSON.stringify(host.notifications) + JSON.stringify(host.events) + JSON.stringify(host.logs);
    for (const n of ['Fotoalbum', 'Sommerreise', 'Strand.jpg', 'Berg.jpg', 'Bild am', proof, Buffer.from(VC.unb64u(proof)).toString('hex'), VC.hex(t.v.tk)]) {
      assert.equal(dump.includes(n), false, `the server holds "${n}"`);
    }
  });
});

test('migration 026 on a database of 1.31.0 with data: no row changes, the new tables are empty, nodes.local_trash is null', () => {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const at = files.indexOf('026_vault_local.sql');
  assert.equal(at, 25);
  const db = new sqlite.DatabaseSync(':memory:');
  try {
    for (const f of files.slice(0, at)) db.exec(`BEGIN;${fs.readFileSync(path.join(dir, f), 'utf8')};COMMIT;`);
    db.exec(`BEGIN;
      INSERT INTO nodes (id, area_id, parent_id, name, is_dir, created_at, updated_at) VALUES (1, 'mine:2', NULL, '', 1, 1, 1);
      WITH RECURSIVE s(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM s WHERE i < 2000)
        INSERT INTO nodes (id, area_id, parent_id, name, is_dir, created_at, updated_at, deleted_at, trash_id, vault_id)
        SELECT i, 'mine:2', MAX(1, i / 10), printf('%032x', i), i % 10 = 0, i, i, CASE WHEN i % 7 = 0 THEN 5 END, CASE WHEN i % 7 = 0 THEN i END, 'v1' FROM s;
      COMMIT;`);
    const sum = () => db.prepare('SELECT COUNT(*) AS n, SUM(id + COALESCE(parent_id, 0) + is_dir + COALESCE(deleted_at, 0) + COALESCE(trash_id, 0)) AS s FROM nodes').get();
    const before = sum();
    // as GateControl runs migrations: in one transaction
    db.exec(`BEGIN;${fs.readFileSync(path.join(dir, files[at]), 'utf8')};COMMIT;`);
    assert.deepEqual(sum(), before, 'no row changed');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE local_trash IS NOT NULL').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vault_local').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vault_local_proofs').get().n, 0);
    // what the server asks of the new table goes by its indexes
    assert.match(db.prepare('EXPLAIN QUERY PLAN SELECT * FROM vault_local WHERE vault_id = ? ORDER BY node_id').all('v1').map((r) => r.detail).join(' / '), /vault_local_vault/);
    assert.match(db.prepare('EXPLAIN QUERY PLAN SELECT * FROM nodes WHERE trash_id = ?').all(5).map((r) => r.detail).join(' / '), /nodes_trash/);
  } finally { db.close(); }
});
