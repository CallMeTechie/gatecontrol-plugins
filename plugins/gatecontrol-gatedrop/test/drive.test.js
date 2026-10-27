'use strict';

// One's own Drive (since 1.3.0): GET targets' drive flag (Drive installed, the sender has a seat — cached), POST sends
// to.drive (true | { folderId }), the Drive plugin's save_file after the answer, its codes passed through.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, LENA, PDF, PNG, MIN } = require('./helpers');

const listCalls = (host) => host.serviceCalls.filter((x) => x.plugin === 'gatecontrol-drive' && x.service === 'list_areas').length;

test('Drive: GET targets offers it to people with a seat, cached; not without Drive', async () => {
  await withHost({ drive: true }, async (host, c) => {
    assert.equal((await c.as(ANNA)('GET', 'targets')).json.drive, true);
    assert.equal((await c.portal(ANNA)('GET', 'targets')).json.drive, true);
    assert.equal(listCalls(host), 1, 'list_areas once per person (GateDrop has 60 service calls an hour)');
    assert.equal((await c.as(LENA)('GET', 'targets')).json.drive, false, 'no seat');
    assert.equal(listCalls(host), 2);
    // a seat given: offered after the cache (30 minutes)
    c.drive.seats.push(LENA.id);
    assert.equal((await c.as(LENA)('GET', 'targets')).json.drive, false);
    c.clock.add(31 * MIN);
    assert.equal((await c.as(LENA)('GET', 'targets')).json.drive, true);
  });
  await withHost({}, async (host, c) => {
    assert.equal((await c.as(ANNA)('GET', 'targets')).json.drive, false, 'Drive not installed');
    assert.equal((await c.call({ id: 1, name: 'admin', role: 'admin' }, 'GET', 'admin/overview')).json.integrations.drive, false);
  });
});

test('Drive: each file handed over and saved as GateDrop/<name> in the sender\'s own area; the text stays in GateDrop', async () => {
  await withHost({ drive: true }, async (host, c) => {
    const a = await c.upload(ANNA, PDF, 'application/pdf');
    const b = await c.upload(ANNA, PNG, 'image/png');
    const r = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: a, name: 'Elternbrief.pdf' }, { mediaId: b, name: 'Foto.png' }], text: 'nur für GateDrop', to: { drive: true } })).json;
    assert.deepEqual(r.deliveries.map((d) => [d.kind, d.target, d.label, d.status, d.files, d.where]), [['drive', 'mine', 'Mein Drive', 'pending', [], []]], 'after the answer');
    await host.plugin._idle();
    assert.deepEqual(c.drive.saved.map((s) => [s.user, s.payload.area, s.payload.path, s.payload.onConflict, s.payload.folderId]),
      [[ANNA.id, 'mine', 'GateDrop/Elternbrief.pdf', 'rename', undefined], [ANNA.id, 'mine', 'GateDrop/Foto.png', 'rename', undefined]]);
    assert.deepEqual(host.handOvers.map((h) => [h.to, h.user]), [['gatecontrol-drive', ANNA.id], ['gatecontrol-drive', ANNA.id]]);
    assert.deepEqual(c.drive.saved.map((s) => s.payload.mediaId), host.handOvers.map((h) => h.mediaId), 'the handed-over copies');
    assert.ok(host.media.has(a), 'GateDrop keeps its own for 7 days');
    const d = (await c.as(ANNA)('GET', `sends/${r.id}`)).json.send.deliveries[0];
    assert.deepEqual([d.kind, d.status, d.via, d.error, d.label], ['drive', 'delivered', 'server', null, 'Meine Dateien › GateDrop']);
    assert.deepEqual(d.where, ['Meine Dateien › GateDrop › Elternbrief.pdf', 'Meine Dateien › GateDrop › Foto.png']);
    assert.deepEqual(d.files.map((f) => [f.nodeId, f.areaId, f.name]), [[101, `mine:${ANNA.id}`, 'Elternbrief.pdf'], [102, `mine:${ANNA.id}`, 'Foto.png']]);
    assert.equal(c.pushes().length, 0, 'nobody is told');
    assert.equal((await c.as(ANNA)('GET', 'inbox', null, { kind: 'received' })).json.items.length, 0, 'not in one\'s own received list');
  });
});

test('Drive: into a folder the sender picked (folderId); Drive\'s codes fail the delivery', async () => {
  await withHost({ drive: true }, async (host, c) => {
    const a = await c.upload(ANNA, PDF, 'application/pdf');
    const r = (await c.as(ANNA, 'anna-phone')('POST', 'sends', { items: [{ mediaId: a, name: 'Zeugnis.pdf' }], to: { drive: { folderId: 7 } } })).json;
    assert.deepEqual([r.deliveries[0].target, r.deliveries[0].status], ['folder:7', 'pending']);
    await host.plugin._idle();
    assert.deepEqual(c.drive.saved[0].payload, { mediaId: host.handOvers[0].mediaId, folderId: 7, name: 'Zeugnis.pdf', onConflict: 'rename', lang: 'de' });
    let d = (await c.as(ANNA)('GET', `sends/${r.id}`)).json.send.deliveries[0];
    assert.deepEqual([d.status, d.label, d.where], ['delivered', 'Meine Dateien › Schule', ['Meine Dateien › Schule › Zeugnis.pdf']]);
    // a folder gone: not_found, no file saved
    const r2 = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf'), name: 'x.pdf' }], to: { drive: { folderId: 99 } } })).json;
    await host.plugin._idle();
    d = (await c.as(ANNA)('GET', `sends/${r2.id}`)).json.send.deliveries[0];
    assert.deepEqual([d.status, d.via, d.error, d.where, d.label], ['failed', null, 'not_found', [], 'Mein Drive']);
    // Drive is full: quota for the first file, the others are tried too
    c.drive.refuse = 'quota';
    const r3 = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf'), name: 'y.pdf' }, { mediaId: await c.upload(ANNA, PNG, 'image/png'), name: 'z.png' }], to: { drive: true } })).json;
    await host.plugin._idle();
    d = (await c.as(ANNA)('GET', `sends/${r3.id}`)).json.send.deliveries[0];
    assert.deepEqual([d.status, d.error], ['failed', 'quota']);
    assert.equal(c.drive.saved.length, 4);
  });
});

test('Drive: the seat taken away after GET targets → the delivery fails with no_seat and the target is no longer offered', async () => {
  await withHost({ drive: true }, async (host, c) => {
    assert.equal((await c.as(ANNA)('GET', 'targets')).json.drive, true);
    c.drive.seats.length = 0;
    const r = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf'), name: 'a.pdf' }, { mediaId: await c.upload(ANNA, PNG, 'image/png'), name: 'b.png' }], to: { drive: true } })).json;
    await host.plugin._idle();
    const d = (await c.as(ANNA)('GET', `sends/${r.id}`)).json.send.deliveries[0];
    assert.deepEqual([d.status, d.error, d.where], ['failed', 'no_seat', []]);
    assert.equal(host.handOvers.length, 1, 'no further file once Drive said no_seat');
    assert.equal((await c.as(ANNA)('GET', 'targets')).json.drive, false, 'remembered from the delivery');
    assert.equal((await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf') }], to: { drive: true } })).json.code, 'unavailable');
  });
});

test('Drive: checks of POST sends — files only, no seat / no Drive / no licence → unavailable, bad shapes → invalid', async () => {
  await withHost({ drive: true }, async (host, c) => {
    const send = (u, to, extra) => c.as(u)('POST', 'sends', { to, ...extra });
    const m = await c.upload(ANNA, PDF, 'application/pdf');
    assert.equal((await send(ANNA, { drive: true }, { text: 'Hallo' })).json.code, 'invalid', 'a text alone does not go to Drive');
    for (const bad of [{ folderId: 0 }, { folderId: 'x' }, { folderId: -3 }, [], 'mine', 1]) {
      assert.equal((await send(ANNA, { drive: bad }, { items: [{ mediaId: m }] })).json.code, 'invalid', JSON.stringify(bad));
    }
    assert.equal((await send(ANNA, { drive: true }, { items: [{ local: true, name: 'a.pdf', bytes: 10 }] })).json.code, 'upload_required');
    const lm = await c.upload(LENA, PDF, 'application/pdf');
    const r = await send(LENA, { drive: true }, { items: [{ mediaId: lm }] });
    assert.deepEqual([r.status, r.json.code], [409, 'unavailable'], 'no seat');
    assert.equal(host.handOvers.length, 0);
    // drive: false / null is no target
    assert.equal((await send(ANNA, { drive: false }, { items: [{ mediaId: m }] })).json.code, 'invalid');
    // together with another target: both deliveries
    const both = (await send(ANNA, { drive: {}, devices: ['anna-pc'] }, { items: [{ mediaId: m, name: 'beides.pdf' }] })).json;
    assert.deepEqual(both.deliveries.map((d) => d.kind).sort(), ['device', 'drive']);
    await host.plugin._idle();
  });
  await withHost({ drive: { licensed: false } }, async (host, c) => {
    assert.equal((await c.as(ANNA)('GET', 'targets')).json.drive, false);
    assert.equal((await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf') }], to: { drive: true } })).json.code, 'unavailable');
  });
  await withHost({}, async (host, c) => {
    assert.equal((await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf') }], to: { drive: true } })).json.code, 'unavailable', 'Drive not installed');
  });
});
