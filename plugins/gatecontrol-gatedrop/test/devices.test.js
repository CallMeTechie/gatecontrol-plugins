'use strict';

// Own devices: through the server (push + download), directly in the same Wi-Fi (contract C: tickets, keys,
// candidates, silent pushes, results, the fallback to the server and late uploads), and the ticket's expiry.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, WALL, PDF, PNG, MIN } = require('./helpers');

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

test('device ids as numbers (Android 1.61 sends GateControl token ids as JSON numbers)', async () => {
  const devs = [
    { id: '106', userId: ANNA.id, name: 'Pixel', platform: 'android', online: true },
    { id: '107', userId: ANNA.id, name: 'Surface Pro 8', platform: 'windows', online: false },
  ];
  await withHost({ devices: devs }, async (host, c) => {
    const fold = c.as(ANNA, '106');
    const r = await fold('POST', 'sends', { text: 'hallo', to: { devices: [107] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.deliveries.map((d) => [d.target, d.status]), [['107', 'waiting']]);
    assert.equal((await fold('POST', 'sends', { text: 'hallo', to: { devices: [106] } })).json.code, 'invalid', 'not to itself');
    for (const bad of [0, -1, 1.5, 2 ** 53]) assert.equal((await fold('POST', 'sends', { text: 'x', to: { devices: [bad] } })).json.code, 'invalid', String(bad));
  });
});

test('who may send to a device: GET/PUT device — open for everyone, listed for others with the owner, closed again', async () => {
  await withHost({}, async (host, c) => {
    const marc = c.as(MARC, 'marc-phone');
    // the default: only the owner
    assert.deepEqual((await pc(c)('GET', 'device')).json.device, { id: 'anna-pc', receiveFrom: 'self' });
    assert.equal((await c.portal(ANNA)('GET', 'device')).json.code, 'no_device');
    assert.equal((await c.portal(ANNA)('PUT', 'device', { receiveFrom: 'everyone' })).json.code, 'no_device');
    for (const body of [{}, { receiveFrom: 'all' }, { receiveFrom: true }, null]) assert.equal((await pc(c)('PUT', 'device', body)).json.code, 'invalid');
    assert.deepEqual((await marc('GET', 'targets')).json.peopleDevices, []);
    assert.equal((await marc('POST', 'sends', { text: 'hi', to: { devices: ['anna-pc'] } })).json.code, 'invalid', 'not open');
    // Anna opens her PC (and her tablet); Marc sees both with the owner; Anna's phone never lists them as someone else's
    assert.deepEqual((await pc(c)('PUT', 'device', { receiveFrom: 'everyone' })).json.device, { id: 'anna-pc', receiveFrom: 'everyone' });
    await c.as(ANNA, 'anna-tab')('PUT', 'device', { receiveFrom: 'everyone' });
    assert.equal((await pc(c)('GET', 'targets')).json.me.receiveFrom, 'everyone');
    const t = (await marc('GET', 'targets')).json;
    assert.deepEqual(t.peopleDevices.map((d) => [d.id, d.name, d.platform, d.online, d.direct, d.owner]),
      [['anna-pc', 'Büro-PC', 'windows', true, false, { id: ANNA.id, name: 'Anna' }], ['anna-tab', 'Tablet', 'android', false, false, { id: ANNA.id, name: 'Anna' }]]);
    assert.deepEqual(t.devices, [], 'Marc has no other device of his own');
    assert.deepEqual((await phone(c)('GET', 'targets')).json.peopleDevices, []);
    // Marc sends a file to Anna's PC: the delivery belongs to Anna — her PC's push, GET pending, her inbox
    const m = await c.upload(MARC, PDF, 'application/pdf');
    const r = (await marc('POST', 'sends', { items: [{ mediaId: m, name: 'rechnung.pdf' }], to: { devices: ['anna-pc'] } })).json;
    assert.equal(r.ok, true);
    assert.deepEqual(r.deliveries.map((d) => [d.kind, d.target, d.label, d.status, d.via, d.ownerId]), [['device', 'anna-pc', 'Büro-PC (Anna)', 'delivered', 'server', ANNA.id]]);
    const p = c.pushes().pop();
    assert.deepEqual([p.users, p.devices, p.title], [[ANNA.id], ['anna-pc'], 'Marc hat dir eine Datei geschickt']);
    const pend = (await pc(c)('GET', 'pending')).json.items;
    assert.deepEqual(pend.map((s) => [s.id, s.role, s.from.name, s.items[0].name]), [[r.id, 'received', 'Marc', 'rechnung.pdf']]);
    assert.deepEqual((await phone(c)('GET', 'pending')).json.items, [], 'only that device');
    assert.equal((await pc(c)('GET', `items/${m}`)).status, 200, 'Anna may download it');
    assert.equal((await host.mediaGet({ ...ANNA }, m)).status, 200);
    assert.equal((await c.as(LENA)('GET', `items/${m}`)).status, 404, 'nobody else');
    assert.deepEqual((await pc(c)('GET', 'inbox', null, { kind: 'received' })).json.items.map((s) => [s.id, s.from.name]), [[r.id, 'Marc']]);
    assert.deepEqual((await marc('GET', 'inbox', null, { kind: 'sent' })).json.items.map((s) => s.id), [r.id]);
    assert.deepEqual((await marc('GET', 'inbox', null, { kind: 'received' })).json.items, [], 'not Marc\'s device');
    const o = (await pc(c)('POST', `sends/${r.id}/opened`)).json.send;
    assert.deepEqual(o.deliveries.map((d) => [d.target, d.status]), [['anna-pc', 'opened']]);
    assert.deepEqual((await marc('GET', `sends/${r.id}`)).json.send.deliveries.map((d) => d.status), ['opened'], 'the sender sees it opened');
    // the offline tablet: waiting until it asks
    const r2 = (await marc('POST', 'sends', { text: 'Bis später', to: { devices: ['anna-tab'] } })).json;
    assert.deepEqual(r2.deliveries.map((d) => [d.status, d.ownerId]), [['waiting', ANNA.id]]);
    // Anna closes the PC: gone for Marc, a send to it is refused as unavailable (not invalid)
    await pc(c)('PUT', 'device', { receiveFrom: 'self' });
    assert.deepEqual((await marc('GET', 'targets')).json.peopleDevices.map((d) => d.id), ['anna-tab']);
    assert.equal((await marc('POST', 'sends', { text: 'hi', to: { devices: ['anna-pc'] } })).json.code, 'unavailable');
    // kiosk accounts are never listed and never send
    await c.as(WALL, 'wall-tab')('PUT', 'device', { receiveFrom: 'everyone' });
    assert.equal((await c.call({ ...WALL, app: true, kiosk: true, device: { id: 'wall-tab', platform: 'android' } }, 'GET', 'targets')).json.code, 'forbidden');
  });
});

test('another person\'s device directly in the same Wi-Fi: local items, the silent push to its owner, both ends report', async () => {
  await withHost({}, async (host, c) => {
    const marc = c.as(MARC, 'marc-phone');
    await pc(c)('PUT', 'device', { receiveFrom: 'everyone' });
    await c.presence(MARC, 'marc-phone', '192.168.1.40', false);
    await c.presence(ANNA, 'anna-pc', '192.168.1.20', true);
    const t = (await marc('GET', 'targets')).json.peopleDevices;
    assert.deepEqual(t.map((d) => [d.id, d.direct, d.mode]), [['anna-pc', true, 'push']]);
    const r = (await marc('POST', 'sends', { items: [{ name: 'urlaub.mp4', bytes: 50_000_000, mime: 'video/mp4', local: true }], to: { devices: ['anna-pc'] } })).json;
    const d = r.direct[0];
    assert.deepEqual([d.deviceId, d.mode, d.candidates], ['anna-pc', 'push', ['192.168.1.20:47731']]);
    const p = c.pushes().pop();
    assert.deepEqual([p.silent, p.users, p.devices], [true, [ANNA.id], ['anna-pc']]);
    assert.deepEqual(p.data.gatedrop.from, { userId: MARC.id, name: 'Marc', deviceId: 'marc-phone', deviceName: 'Marcs Handy' });
    // the PC (Anna) is the receiving end, Marc's phone the sending end; Anna's phone is neither
    const tr = (await pc(c)('GET', `transfers/${d.transferId}`)).json.transfer;
    assert.deepEqual([tr.side, tr.status, tr.ticket, tr.from.name], ['receiver', 'open', d.ticket, 'Marc']);
    assert.equal((await phone(c)('GET', `transfers/${d.transferId}`)).status, 404);
    assert.equal((await marc('GET', `transfers/${d.transferId}`)).json.transfer.side, 'sender');
    const res = (await pc(c)('POST', `transfers/${d.transferId}/result`, { ok: true, bytes: 50_000_000 })).json;
    assert.deepEqual([res.delivery.status, res.delivery.via], ['delivered', 'direct']);
    // a failed direct transfer: the server way to Anna's PC after Marc uploads
    const r2 = (await marc('POST', 'sends', { items: [{ name: 'b.jpg', bytes: 10, local: true }], to: { devices: ['anna-pc'] } })).json;
    const f = (await marc('POST', `transfers/${r2.direct[0].transferId}/result`, { ok: false, error: 'not_fetched' })).json;
    assert.deepEqual([f.fallback, f.missing], ['upload', [0]]);
    const m = await c.upload(MARC, PNG, 'image/jpeg');
    await marc('POST', `sends/${r2.id}/items`, { items: [{ index: 0, mediaId: m }] });
    const push = c.pushes().pop();
    assert.deepEqual([push.silent, push.users, push.devices, push.title], [undefined, [ANNA.id], ['anna-pc'], 'Marc hat dir eine Datei geschickt']);
    assert.deepEqual((await pc(c)('GET', 'pending')).json.items.map((s) => s.id), [r2.id]);
  });
});
