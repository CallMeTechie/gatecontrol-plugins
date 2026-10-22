'use strict';

// Own devices: through the server (push + download), directly in the same Wi-Fi (contract C: tickets, keys,
// candidates, silent pushes, results, the fallback to the server and late uploads), and the ticket's expiry.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, PDF, PNG, MIN } = require('./helpers');

const phone = (c) => c.as(ANNA, 'anna-phone');
const pc = (c) => c.as(ANNA, 'anna-pc');

test('through the server: a push to that device only, the device downloads; nobody else reads the file', async () => {
  await withHost({}, async (host, c) => {
    const m = await c.upload(ANNA, PDF, 'application/pdf');
    const r = await phone(c)('POST', 'sends', { items: [{ mediaId: m, name: 'angebot-kueche.pdf' }], note: 'fürs Büro', to: { devices: ['anna-pc', 'anna-tab'] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.direct, []);
    assert.deepEqual(r.json.deliveries.map((d) => [d.kind, d.target, d.label, d.status, d.via]), [['device', 'anna-pc', 'Büro-PC', 'delivered', 'server'], ['device', 'anna-tab', 'Tablet', 'waiting', 'server']], 'the tablet is offline');
    const pushes = c.pushes();
    assert.equal(pushes.length, 2);
    assert.deepEqual(pushes.map((p) => [p.topic, p.users, p.devices, p.silent]), [['received', [ANNA.id], ['anna-pc'], undefined], ['received', [ANNA.id], ['anna-tab'], undefined]]);
    assert.equal(pushes[0].title, 'Pixel hat dir eine Datei geschickt');
    assert.equal(pushes[0].body, 'angebot-kueche.pdf');
    assert.deepEqual(pushes[0].data, { route: 'plg-gatecontrol-gatedrop', gatedrop: { send: r.json.id } });
    // the PC: its inbox, the send, the file
    const inbox = (await pc(c)('GET', 'inbox', null, { kind: 'received' })).json;
    assert.deepEqual(inbox.items.map((s) => [s.id, s.role, s.from.deviceName, s.note]), [[r.json.id, 'received', 'Pixel', 'fürs Büro']]);
    const it = (await pc(c)('GET', `items/${m}`)).json;
    assert.deepEqual([it.item.name, it.url], ['angebot-kueche.pdf', `/api/v1/client/plugins/gatecontrol-gatedrop/media/${m}`]);
    assert.equal((await host.mediaGet({ ...ANNA }, m)).status, 200);
    assert.equal((await host.mediaGet({ ...MARC }, m)).status, 404);
    assert.equal((await host.mediaGet({ ...ANNA, kiosk: true }, m)).status, 404);
    assert.equal((await c.as(MARC)('GET', `items/${m}`)).status, 404);
    assert.equal((await c.as(MARC)('GET', `sends/${r.json.id}`)).status, 404);
    // the portal gets a signed URL
    assert.match((await c.portal(ANNA)('GET', `items/${m}`)).json.url, /^\/plugin-media\//);
    // opened from the PC
    const o = (await pc(c)('POST', `sends/${r.json.id}/opened`)).json.send;
    assert.deepEqual(o.deliveries.map((d) => [d.target, d.status]), [['anna-pc', 'opened'], ['anna-tab', 'waiting']]);
    // a text to the PC: "einen Text"
    await phone(c)('POST', 'sends', { text: 'WLAN-Passwort: geheim', to: { devices: ['anna-pc'] } });
    assert.deepEqual([c.pushes().pop().title, c.pushes().pop().body], ['Pixel hat dir einen Text geschickt', 'WLAN-Passwort: geheim']);
  });
});

test('direct, push mode: the PC listens in the same network — ticket, key, candidates; a silent push; the result', async () => {
  await withHost({}, async (host, c) => {
    await c.presence(ANNA, 'anna-phone', '192.168.1.31', false);
    await c.presence(ANNA, 'anna-pc', '192.168.1.20', true);
    const t = (await phone(c)('GET', 'targets')).json;
    assert.deepEqual(t.devices.map((d) => [d.id, d.direct, d.mode]), [['anna-pc', true, 'push'], ['anna-tab', false, undefined]]);
    // the files stay on the phone (local items): only for devices reached directly
    const r = (await phone(c)('POST', 'sends', { items: [{ name: 'IMG_2041.jpg', bytes: 3_100_000, mime: 'image/jpeg', local: true }, { name: 'IMG_2044.jpg', bytes: 3_300_000, local: true }], to: { devices: ['anna-pc'] } })).json;
    assert.equal(r.direct.length, 1);
    const d = r.direct[0];
    assert.deepEqual([d.deviceId, d.mode, d.candidates], ['anna-pc', 'push', ['192.168.1.20:47731']]);
    assert.equal(Buffer.from(d.key, 'base64').length, 32);
    assert.match(d.ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.match(d.transferId, /^[0-9a-f]{24}$/);
    assert.deepEqual(r.deliveries.map((x) => [x.status, x.via]), [['direct', 'direct']]);
    assert.deepEqual(r.send.items.map((i) => [i.name, i.local, i.available, i.mime]), [['IMG_2041.jpg', true, false, 'image/jpeg'], ['IMG_2044.jpg', true, false, 'application/octet-stream']]);
    // the silent push to the PC carries the same
    const p = c.pushes().pop();
    assert.deepEqual([p.silent, p.users, p.devices, p.topic], [true, [ANNA.id], ['anna-pc'], 'received']);
    const g = p.data.gatedrop;
    assert.deepEqual([g.transfer, g.send, g.mode, g.key, g.ticket, g.candidates], [d.transferId, r.id, 'push', d.key, d.ticket, d.candidates]);
    assert.deepEqual(g.from, { userId: ANNA.id, name: 'Anna', deviceId: 'anna-phone', deviceName: 'Pixel' });
    assert.deepEqual(g.items, [{ index: 0, name: 'IMG_2041.jpg', bytes: 3100000, mime: 'image/jpeg' }, { index: 1, name: 'IMG_2044.jpg', bytes: 3300000, mime: 'application/octet-stream' }]);
    // the listener asks again (authenticated): ticket and key while open
    const tr = (await pc(c)('GET', `transfers/${d.transferId}`)).json.transfer;
    assert.deepEqual([tr.side, tr.status, tr.ticket, tr.key, tr.items.length], ['receiver', 'open', d.ticket, d.key, 2]);
    assert.equal((await c.as(ANNA, 'anna-tab')('GET', `transfers/${d.transferId}`)).status, 404, 'another device');
    assert.equal((await c.as(MARC, 'marc-phone')('GET', `transfers/${d.transferId}`)).status, 404);
    assert.equal((await c.portal(ANNA)('GET', `transfers/${d.transferId}`)).json.code, 'no_device');
    for (const body of [{}, { ok: 'yes' }, { ok: false, error: 'Bad Thing!' }, { ok: true, bytes: -1 }]) assert.equal((await pc(c)('POST', `transfers/${d.transferId}/result`, body)).json.code, 'invalid');
    // both ends report success
    const res = (await pc(c)('POST', `transfers/${d.transferId}/result`, { ok: true, bytes: 6400000 })).json;
    assert.deepEqual([res.transfer.status, res.transfer.side, res.delivery.status, res.delivery.via, res.fallback], ['done', 'receiver', 'delivered', 'direct', null]);
    const res2 = (await phone(c)('POST', `transfers/${d.transferId}/result`, { ok: true, bytes: 6400000 })).json;
    assert.deepEqual([res2.transfer.side, res2.delivery.status], ['sender', 'delivered']);
    assert.equal((await pc(c)('GET', `transfers/${d.transferId}`)).json.transfer.ticket, null, 'no ticket once done');
    assert.equal(c.pushes().filter((x) => !x.silent).length, 0, 'no server push');
    assert.equal((await pc(c)('GET', 'inbox', null, { kind: 'received' })).json.items[0].deliveries[0].via, 'direct');
  });
});

test('direct, pull mode and the networks: only the sender listens; other subnets, stale presence, offline devices → server', async () => {
  await withHost({}, async (host, c) => {
    await c.presence(ANNA, 'anna-phone', '10.0.5.7', true, 16);
    await c.presence(ANNA, 'anna-pc', '10.0.9.20', false, 24);
    await c.presence(ANNA, 'anna-tab', '10.0.5.8', true, 16);
    let t = (await phone(c)('GET', 'targets')).json.devices;
    assert.deepEqual(t.map((d) => [d.id, d.direct, d.mode]), [['anna-pc', true, 'pull'], ['anna-tab', false, undefined]], 'the tablet is offline');
    const m = await c.upload(ANNA, PNG, 'image/png');
    const r = (await phone(c)('POST', 'sends', { items: [{ mediaId: m }], to: { devices: ['anna-pc'] } })).json;
    assert.deepEqual([r.direct[0].mode, r.direct[0].candidates], ['pull', ['10.0.5.7:47731']], 'the PC fetches from the phone');
    // another network, a public address, a stale report
    await c.presence(ANNA, 'anna-pc', '192.168.178.20', true);
    assert.equal((await phone(c)('GET', 'targets')).json.devices[0].direct, false);
    await c.presence(ANNA, 'anna-phone', '8.8.8.8', true, 24);
    await c.presence(ANNA, 'anna-pc', '8.8.8.9', true, 24);
    assert.equal((await phone(c)('GET', 'targets')).json.devices[0].direct, false, 'public addresses never');
    await c.presence(ANNA, 'anna-phone', '192.168.178.31', false);
    await c.presence(ANNA, 'anna-pc', '192.168.178.20', true);
    assert.equal((await phone(c)('GET', 'targets')).json.devices[0].direct, true);
    c.clock.add(16 * MIN);
    t = (await phone(c)('GET', 'targets')).json.devices;
    assert.equal(t[0].direct, false, 'reports older than 15 minutes do not count');
  });
});

test('direct failed: the server way — a push when the files are there, else the sender uploads them (POST sends/<id>/items)', async () => {
  await withHost({}, async (host, c) => {
    await c.presence(ANNA, 'anna-phone', '192.168.1.31', false);
    await c.presence(ANNA, 'anna-pc', '192.168.1.20', true);
    // files on the phone only
    const r = (await phone(c)('POST', 'sends', { items: [{ name: 'video.mp4', bytes: 900_000_000, mime: 'video/mp4', local: true }], text: 'Urlaub', to: { devices: ['anna-pc'] } })).json;
    const id = r.direct[0].transferId;
    const f = (await phone(c)('POST', `transfers/${id}/result`, { ok: false, error: 'connect_timeout' })).json;
    assert.deepEqual([f.transfer.status, f.delivery.status, f.delivery.error, f.fallback, f.missing], ['failed', 'pending', 'direct_failed', 'upload', [0]]);
    assert.equal((await pc(c)('POST', `transfers/${id}/result`, { ok: false })).json.fallback, 'upload', 'the receiver learns it too');
    assert.equal(c.pushes().filter((x) => !x.silent).length, 0);
    // the sender uploads the file (the real size is checked by GateControl, 2 GB at most)
    const m = await c.upload(ANNA, Buffer.from('video'), 'video/mp4', { bytes: 900_000_000 });
    for (const body of [{}, { items: [{ index: 5, mediaId: m }] }, { items: [{ index: 0, mediaId: 'x' }] }]) assert.equal((await phone(c)('POST', `sends/${r.id}/items`, body)).json.code, 'invalid');
    assert.equal((await c.as(MARC)('POST', `sends/${r.id}/items`, { items: [{ index: 0, mediaId: m }] })).status, 404);
    const u = (await phone(c)('POST', `sends/${r.id}/items`, { items: [{ index: 0, mediaId: m }] })).json.send;
    assert.deepEqual(u.items.map((i) => [i.mediaId, i.bytes, i.available]), [[m, 900000000, true]]);
    assert.deepEqual(u.deliveries.map((d) => [d.status, d.via, d.error]), [['delivered', 'server', 'direct_failed']]);
    const p = c.pushes().filter((x) => !x.silent).pop();
    assert.deepEqual([p.devices, p.title, p.body], [['anna-pc'], 'Pixel hat dir eine Datei geschickt', 'video.mp4']);
    assert.equal((await pc(c)('GET', `items/${m}`)).status, 200);
    // already uploaded files: a failure goes the server way at once
    const m2 = await c.upload(ANNA, PDF, 'application/pdf');
    const r2 = (await phone(c)('POST', 'sends', { items: [{ mediaId: m2, name: 'x.pdf' }], to: { devices: ['anna-pc'] } })).json;
    const f2 = (await pc(c)('POST', `transfers/${r2.direct[0].transferId}/result`, { ok: false, error: 'decrypt_failed' })).json;
    assert.deepEqual([f2.fallback, f2.delivery.status, f2.delivery.via], ['server', 'delivered', 'server']);
    // a late success after the fallback changes nothing
    const late = (await phone(c)('POST', `transfers/${r2.direct[0].transferId}/result`, { ok: true })).json;
    assert.deepEqual([late.delivery.status, late.delivery.via], ['delivered', 'server']);
  });
});

test('the ticket expires after 10 minutes without a result → the server way (background)', async () => {
  await withHost({}, async (host, c) => {
    await c.presence(ANNA, 'anna-phone', '192.168.1.31', true);
    await c.presence(ANNA, 'anna-pc', '192.168.1.20', true);
    const m = await c.upload(ANNA, PDF, 'application/pdf');
    const r = (await phone(c)('POST', 'sends', { items: [{ mediaId: m, name: 'a.pdf' }], to: { devices: ['anna-pc'] } })).json;
    const r2 = (await phone(c)('POST', 'sends', { items: [{ name: 'b.zip', bytes: 5, local: true }], to: { devices: ['anna-pc'] } })).json;
    c.clock.add(9 * MIN);
    await host.tick();
    assert.equal((await phone(c)('GET', `sends/${r.id}`)).json.send.deliveries[0].status, 'direct');
    c.clock.add(2 * MIN);
    const out = await host.tick();
    assert.equal(out.transfers, 2);
    assert.deepEqual((await phone(c)('GET', `sends/${r.id}`)).json.send.deliveries.map((d) => [d.status, d.via]), [['delivered', 'server']]);
    assert.deepEqual((await phone(c)('GET', `sends/${r2.id}`)).json.send.deliveries.map((d) => [d.status, d.error]), [['pending', 'direct_failed']]);
    assert.equal(c.pushes().filter((x) => !x.silent).length, 1);
    assert.equal((await pc(c)('GET', `transfers/${r.direct[0].transferId}`)).json.transfer.status, 'expired');
  });
});
