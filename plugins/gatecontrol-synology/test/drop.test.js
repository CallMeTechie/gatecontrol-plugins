'use strict';

// 1.2.0: folders for GateDrop (admin API) and the services list_drop_folders / save_file — a file handed over
// by GateDrop (gc.media.handOver) is uploaded with SYNO.FileStation.Upload through gc.net.uploadTarget
// (GateControl ≥ 1.193.0) and removed from the plugin's media afterwards.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDsm, withHost, asAdmin, addNas, ADA } = require('./helpers');
const drop = require('../server/drop');

const GD = 'gatecontrol-gatedrop';
const PDF = Buffer.from('%PDF-1.4\n%fake\n');

/** A file handed over to this plugin for `userId` (what GateDrop's gc.media.handOver leaves in its store). */
const handed = (host, userId = ADA.id, data = PDF, mime = 'application/pdf') => host._receiveHandOver({ mime, bytes: data.length, data, owner: userId }).mediaId;
const save = (host, payload, caller = GD) => host.callService('save_file', { caller, user: { id: ADA.id, name: 'Ada', role: 'user' }, payload });

async function folder(host, nasId, path, label) {
  const r = await asAdmin(host, 'POST', '/drop-folders', { nas_id: nasId, path, label });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.folder;
}

test('drop folders: administrators add, change and remove them; checked paths; gone with their NAS', async () => {
  await withHost({ nas: [fakeDsm('dsm72.json'), fakeDsm('dsm71.json')] }, async (host) => {
    const a = await addNas(host);
    const b = await addNas(host, { name: 'Büro', target_index: 1 });
    for (const body of [{ nas_id: a, path: 'Familie' }, { nas_id: a, path: '/Familie/../etc' }, { nas_id: a, path: '/' }, { nas_id: 99, path: '/Familie' }, { nas_id: a, path: '/Fa:mi*lie' }]) {
      const r = await asAdmin(host, 'POST', '/drop-folders', body);
      assert.deepEqual([r.status, r.json.code], [400, 'FOLDER_INVALID'], JSON.stringify(body));
    }
    const f1 = await folder(host, a, '/Familie/Fotos/', 'Fotos');
    assert.deepEqual([f1.path, f1.label], ['/Familie/Fotos', 'Fotos']);
    const f2 = await folder(host, b, '/Dokumente');
    assert.equal(f2.label, 'Dokumente', 'the last folder name without a label');
    const st = (await asAdmin(host, 'GET', '/status')).json;
    assert.deepEqual(st.drop_folders.map((f) => [f.label, f.nas_name, f.path]), [['Dokumente', 'Büro', '/Dokumente'], ['Fotos', 'Keller', '/Familie/Fotos']]);
    const r = await asAdmin(host, 'PUT', `/drop-folders/${f2.id}`, { label: 'Papierkram' });
    assert.equal(r.json.folder.label, 'Papierkram');
    // a portal viewer or a user never reaches the routes
    assert.equal((await host.request({ method: 'POST', path: '/drop-folders', user: ADA, body: { nas_id: a, path: '/x' } })).status, 403);
    // services: only GateDrop sees them; a NAS switched off hides its folders
    assert.deepEqual(await host.callService('list_drop_folders', { caller: GD, payload: {} }), [{ id: f1.id, label: 'Fotos', path: '/Familie/Fotos' }, { id: f2.id, label: 'Papierkram', path: '/Dokumente' }]);
    assert.deepEqual(await host.callService('list_drop_folders', { caller: 'gatecontrol-other', payload: {} }), []);
    await asAdmin(host, 'PUT', `/nas/${b}`, { enabled: false });
    assert.deepEqual((await host.callService('list_drop_folders', { caller: GD, payload: {} })).map((f) => f.id), [f1.id]);
    assert.equal((await asAdmin(host, 'DELETE', `/drop-folders/${f2.id}`)).json.ok, true);
    assert.equal((await asAdmin(host, 'DELETE', `/drop-folders/${f2.id}`)).status, 404);
    await asAdmin(host, 'DELETE', `/nas/${a}`);
    assert.deepEqual((await asAdmin(host, 'GET', '/status')).json.drop_folders, [], 'removed with its NAS');
  });
});

test('save_file: File Station upload of the handed-over file into a drop folder (subfolders created, names kept free)', async () => {
  const d = fakeDsm('dsm72.json');
  await withHost({ nas: [d] }, async (host) => {
    const id = await addNas(host);
    await folder(host, id, '/Familie/Fotos');
    const m1 = handed(host);
    const r = await save(host, { user: ADA.id, mediaId: m1, name: 'rechnung.pdf', path: '/Familie/Fotos/2026' });
    assert.deepEqual(r, { ok: true, path: '/Familie/Fotos/2026/rechnung.pdf', nasId: id });
    const up = d.state.uploads.pop();
    assert.deepEqual([up.path, up.name, up.bytes, up.createParents, up.version], ['/Familie/Fotos/2026', 'rechnung.pdf', PDF.length, 'true', '2']);
    assert.deepEqual(d.state.files.get('/Familie/Fotos/2026/rechnung.pdf'), PDF);
    const rec = host.uploads.pop();
    assert.deepEqual([rec.target, rec.path, rec.file.field, rec.query.api, rec.query.method, rec.timeoutMs], ['nas', '/webapi/entry.cgi', 'file', 'SYNO.FileStation.Upload', 'upload', 1800000]);
    assert.ok(!JSON.stringify(rec.query).includes('S3cret'), 'no password in the upload');
    assert.equal(host.media.has(m1), false, 'the handed-over copy is gone afterwards');
    // the same name again → "rechnung (2).pdf"
    const r2 = await save(host, { user: ADA.id, mediaId: handed(host), name: 'rechnung.pdf', path: '/Familie/Fotos/2026' });
    assert.equal(r2.path, '/Familie/Fotos/2026/rechnung (2).pdf');
    // a stale session: logged in again once
    d.state.sessions.clear();
    const logins = d.state.logins.length;
    const r3 = await save(host, { user: ADA.id, mediaId: handed(host), name: 'x.pdf', path: '/Familie/Fotos' });
    assert.equal(r3.ok, true);
    assert.equal(d.state.logins.length, logins + 1);
    assert.ok(!host.logs.some((l) => /rechnung|x\.pdf/.test(l.message)), 'no file names in the log');
  });
});

test('save_file refusals: caller, paths, files, NAS state and DSM errors — the copy is removed every time', async () => {
  const d = fakeDsm('dsm72.json');
  await withHost({ nas: [d] }, async (host) => {
    const id = await addNas(host);
    await folder(host, id, '/Familie');
    const cases = [
      [GD, (m) => ({ user: ADA.id, mediaId: m, name: 'a.pdf', path: '/Privat' }), 'not_found'],
      [GD, (m) => ({ user: ADA.id, mediaId: m, name: 'a.pdf', path: '/Familie/../Privat' }), 'invalid'],
      [GD, (m) => ({ user: ADA.id, mediaId: m, name: '', path: '/Familie' }), 'invalid'],
      [GD, (m) => ({ mediaId: m, name: 'a.pdf', path: '/Familie' }), 'invalid'],
      ['gatecontrol-other', (m) => ({ user: ADA.id, mediaId: m, name: 'a.pdf', path: '/Familie' }), 'forbidden'],
    ];
    for (const [caller, p, code] of cases) {
      const m = handed(host);
      assert.deepEqual(await save(host, p(m), caller), { ok: false, code }, JSON.stringify(p(m)));
      assert.equal(host.media.has(m), false, 'removed: ' + code);
    }
    assert.deepEqual(await save(host, { user: ADA.id, mediaId: 'f'.repeat(32), name: 'a.pdf', path: '/Familie' }), { ok: false, code: 'not_found' });
    for (const [err, code] of [[416, 'no_space'], [407, 'permission'], [1800, 'upload_failed']]) {
      d.state.uploadError = err;
      assert.deepEqual(await save(host, { user: ADA.id, mediaId: handed(host), name: 'a.pdf', path: '/Familie' }), { ok: false, code });
    }
    d.state.uploadError = null;
    d.state.down = true;
    assert.deepEqual(await save(host, { user: ADA.id, mediaId: handed(host), name: 'a.pdf', path: '/Familie' }), { ok: false, code: 'unreachable' });
    d.state.down = false;
    // a GateControl without gc.net.uploadTarget
    const old = { ...host.gc, net: { ...host.gc.net, uploadTarget: undefined } };
    const m = handed(host);
    assert.deepEqual(await drop.handle(old, { name: 'save_file', caller: GD, payload: { user: ADA.id, mediaId: m, name: 'a.pdf', path: '/Familie' } }), { ok: false, code: 'unsupported' });
    await asAdmin(host, 'PUT', `/nas/${id}`, { enabled: false });
    assert.deepEqual(await save(host, { user: ADA.id, mediaId: handed(host), name: 'a.pdf', path: '/Familie' }), { ok: false, code: 'nas_disabled' });
    // nobody reads the handed-over files through the plugin's media route
    assert.equal((await host.mediaGet({ ...ADA, app: true }, handed(host))).status, 404);
  });
});

test('save_file: exactly the drop folder GateDrop chose (folderId) — never the longest prefix on another NAS', async () => {
  const a = fakeDsm('dsm72.json');
  const b = fakeDsm('dsm71.json');
  await withHost({ nas: [a, b] }, async (host) => {
    const na = await addNas(host);
    const nb = await addNas(host, { name: 'Büro', target_index: 1 });
    const fa = await folder(host, na, '/Familie');
    const fb = await folder(host, nb, '/Familie/Fotos');
    // folder A chosen, a path that NAS B's folder would match longer: saved on NAS A
    const r = await save(host, { user: ADA.id, folderId: fa.id, mediaId: handed(host), name: 'x.pdf', path: '/Familie/Fotos' });
    assert.deepEqual([r.ok, r.nasId], [true, na]);
    assert.deepEqual([a.state.uploads.length, b.state.uploads.length], [1, 0]);
    assert.equal((await save(host, { user: ADA.id, folderId: fb.id, mediaId: handed(host), name: 'x.pdf', path: '/Familie/Fotos/2026' })).nasId, nb);
    assert.deepEqual(await save(host, { user: ADA.id, folderId: fb.id, mediaId: handed(host), name: 'x.pdf', path: '/Familie' }), { ok: false, code: 'not_found' }, 'outside the chosen folder');
    assert.deepEqual(await save(host, { user: ADA.id, folderId: 99, mediaId: handed(host), name: 'x.pdf', path: '/Familie' }), { ok: false, code: 'not_found' });
    assert.deepEqual(await save(host, { user: ADA.id, folderId: 'x', mediaId: handed(host), name: 'x.pdf', path: '/Familie' }), { ok: false, code: 'invalid' });
    // without folderId only when exactly one folder fits
    assert.deepEqual(await save(host, { user: ADA.id, mediaId: handed(host), name: 'x.pdf', path: '/Familie/Fotos' }), { ok: false, code: 'invalid' }, 'two folders fit');
    assert.equal((await save(host, { user: ADA.id, mediaId: handed(host), name: 'y.pdf', path: '/Familie/Briefe' })).nasId, na);
  });
});
