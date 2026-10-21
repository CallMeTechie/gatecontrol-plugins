'use strict';

// NAS folders (the NAS plugin's save_file after the answer) and links for outsiders (gc.publicLinks):
// expiry, PIN, downloads, lock, ending a link, the administrator's switch and the public URL.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ADMIN, ANNA, MARC, LENA, PDF, PNG, MIN } = require('./helpers');

test('NAS: each file handed over to the NAS plugin and saved into the drop folder (or a folder below it)', async () => {
  await withHost({ nas: true }, async (host, c) => {
    const a = await c.upload(ANNA, PDF, 'application/pdf');
    const b = await c.upload(ANNA, PNG, 'image/png');
    const r = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: a, name: 'rechnung.pdf' }, { mediaId: b, name: 'beleg.png' }], to: { nas: [{ id: c.nas.folderId, path: 'Rechnungen/2026' }] } })).json;
    assert.deepEqual(r.deliveries.map((d) => [d.kind, d.target, d.label, d.status]), [['nas', '/Familie/Ablage/Rechnungen/2026', 'Ablage/Rechnungen/2026', 'pending']], 'after the answer');
    await host.plugin._idle();
    const d = (await c.as(ANNA)('GET', `sends/${r.id}`)).json.send.deliveries[0];
    assert.deepEqual([d.status, d.via, d.paths], ['delivered', 'server', ['/Familie/Ablage/Rechnungen/2026/rechnung.pdf', '/Familie/Ablage/Rechnungen/2026/beleg.png']]);
    assert.deepEqual(c.nas.dsm.state.uploads.map((u) => [u.path, u.name]), [['/Familie/Ablage/Rechnungen/2026', 'rechnung.pdf'], ['/Familie/Ablage/Rechnungen/2026', 'beleg.png']]);
    assert.deepEqual(host.handOvers.map((h) => h.to), ['gatecontrol-synology', 'gatecontrol-synology']);
    assert.equal(c.nas.host.media.size, 0, 'the NAS plugin removed its copies');
    assert.ok(host.media.has(a), 'GateDrop keeps its own for 7 days');
    // the DSM refuses (no space): failed with the code
    c.nas.dsm.state.uploadError = 416;
    const x = await c.upload(ANNA, PDF, 'application/pdf');
    const r2 = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: x, name: 'y.pdf' }], to: { nas: [{ id: c.nas.folderId }] } })).json;
    await host.plugin._idle();
    const d2 = (await c.as(ANNA)('GET', `sends/${r2.id}`)).json.send.deliveries[0];
    assert.deepEqual([d2.status, d2.error], ['failed', 'no_space']);
    assert.equal((await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf') }], to: { nas: [{ id: 99 }] } })).json.code, 'not_found');
  });
});

test('links: created with expiry and PIN, listed with counters, downloads and a lock reported, ended by the owner', async () => {
  await withHost({}, async (host, c) => {
    const a = await c.upload(ANNA, PNG, 'image/png');
    const b = await c.upload(ANNA, PNG, 'image/png');
    const r = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: a, name: 'IMG_2041.png' }, { mediaId: b, name: 'IMG_2044.png' }], note: 'Fotos vom Wandertag', to: { link: { expires: '1d', pin: true } } })).json;
    assert.match(r.link.url, /^https:\/\/gc\.example\.com\/s\/[A-Za-z0-9_-]{22,}$/);
    assert.match(r.link.pin, /^\d{4}$/);
    assert.deepEqual([r.link.expiresAt, r.link.maxDownloads], [new Date(Date.now() + 86400000).toISOString(), null]);
    const l = host.publicLinks.get(r.link.token);
    assert.deepEqual([l.title, l.note, l.files.map((f) => f.name), l.pin, l.ownerUserId], ['2 Dateien', 'Fotos vom Wandertag', ['IMG_2041.png', 'IMG_2044.png'], r.link.pin, ANNA.id]);
    assert.deepEqual(r.deliveries.map((d) => [d.kind, d.target, d.status]), [['link', r.link.token, 'delivered']]);
    // a download of one file: counted, the owner told (topic link); the ZIP counts one of each file
    assert.equal((await host.publicLinkDownload(r.link.token, { pin: r.link.pin, file: 1 })).status, 200);
    let p = c.pushes().pop();
    assert.deepEqual([p.topic, p.users, p.title, p.body], ['link', [ANNA.id], 'Link geladen: 2 Dateien', '1× heruntergeladen']);
    assert.equal((await host.publicLinkDownload(r.link.token, { pin: r.link.pin })).status, 200);
    assert.equal(c.pushes().pop().body, '3× heruntergeladen');
    let list = (await c.as(ANNA)('GET', 'inbox', null, { kind: 'links' })).json.items;
    assert.deepEqual(list.map((x) => [x.token, x.title, x.pin, x.downloads, x.state, x.active, x.url]), [[r.link.token, '2 Dateien', true, 3, 'active', true, r.link.url]]);
    // five wrong PINs: locked, the owner told
    for (let i = 0; i < 5; i++) await host.publicLinkUnlock(r.link.token, '0000' === r.link.pin ? '1111' : '0000');
    p = c.pushes().pop();
    assert.deepEqual([p.title, p.body], ['Link gesperrt: 2 Dateien', '5 falsche PINs – der Link ist gesperrt.']);
    list = (await c.as(ANNA)('GET', 'inbox', null, { kind: 'links' })).json.items;
    assert.deepEqual([list[0].locked, list[0].state, list[0].active], [true, 'locked', false]);
    // once: one download; ended by the owner (not by another person)
    const o = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf'), name: 'steuer-2025.pdf' }], to: { link: { expires: 'once', pin: false } } })).json;
    assert.deepEqual([o.link.pin, o.link.maxDownloads, host.publicLinks.get(o.link.token).title], [null, 1, 'steuer-2025.pdf']);
    assert.equal((await c.as(MARC)('DELETE', `links/${o.link.token}`)).status, 404);
    assert.deepEqual((await c.as(ANNA)('DELETE', `links/${o.link.token}`)).json, { ok: true, revoked: true });
    assert.equal(host.publicLinks.get(o.link.token).revoked, true);
    assert.equal((await host.publicLinkDownload(o.link.token)).status, 410, 'ended');
    const s = (await c.as(ANNA)('GET', `sends/${o.id}`)).json.send;
    assert.deepEqual([s.deliveries[0].status, s.deliveries[0].error], ['expired', 'revoked']);
    // 1 h: expired after an hour (GateControl reports it)
    const h = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: await c.upload(ANNA, PDF, 'application/pdf'), name: 'z.pdf' }], to: { link: { expires: '1h' } } })).json;
    c.clock.add(61 * MIN);
    assert.equal((await host.publicLinkDownload(h.link.token)).status, 410);
    assert.equal((await c.as(ANNA)('GET', `sends/${h.id}`)).json.send.deliveries[0].status, 'expired');
  });
});

test('links: off by the administrator, no public URL, a parent may, a child may not; the administrator always', async () => {
  await withHost({ links: false }, async (host, c) => {
    const m = await c.upload(ANNA, PNG, 'image/png');
    assert.equal((await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: m }], to: { link: { expires: '1d' } } })).json.code, 'links_disabled');
    assert.equal((await c.as(ANNA)('GET', 'inbox', null, { kind: 'links' })).json.items.length, 0);
    const lm = await c.upload(LENA, PNG, 'image/png');
    assert.equal((await c.as(LENA)('POST', 'sends', { items: [{ mediaId: lm }], to: { link: { expires: '1d' } } })).json.code, 'forbidden');
  });
  await withHost({ publicUrl: null }, async (host, c) => {
    const m = await c.upload(ADMIN, PNG, 'image/png');
    const r = (await c.portal(ADMIN)('POST', 'sends', { items: [{ mediaId: m, name: 'x.png' }], to: { link: { expires: '7d', pin: true } } })).json;
    assert.deepEqual([r.link, r.deliveries[0].status, r.deliveries[0].error], [null, 'failed', 'no_public_url']);
  });
});
