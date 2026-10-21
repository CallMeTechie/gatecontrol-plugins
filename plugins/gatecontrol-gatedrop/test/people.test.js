'use strict';

// People: with the Messenger a message of the sender in the chat (files handed over, service send_file);
// without it, or when it refuses, a push to the person, who downloads from GateDrop.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, ANNA, MARC, LENA, OMA, PDF, PNG } = require('./helpers');

test('with the Messenger: the files handed over, a message from Anna in her direct chat with Marc', async () => {
  await withHost({ messenger: true }, async (host, c) => {
    const pdf = await c.upload(ANNA, PDF, 'application/pdf');
    const img = await c.upload(ANNA, PNG, 'image/png');
    const r = (await c.as(ANNA, 'anna-phone')('POST', 'sends', { items: [{ mediaId: pdf, name: 'angebot.pdf' }, { mediaId: img, name: 'skizze.png' }], text: 'Schau mal', link: 'https://example.com/kueche', to: { people: [MARC.id] } })).json;
    const d = r.deliveries[0];
    assert.deepEqual([d.kind, d.target, d.label, d.status, d.via, d.error], ['person', String(MARC.id), 'Marc', 'delivered', 'server', null]);
    assert.ok(d.conversationId > 0);
    assert.deepEqual(host.handOvers.map((h) => [h.to, h.from, h.user]), [['gatecontrol-messenger', pdf, ANNA.id], ['gatecontrol-messenger', img, ANNA.id]]);
    assert.deepEqual(host.serviceCalls.filter((s) => s.service === 'send_file').map((s) => [s.userId, s.payload.conversation, s.payload.user, s.payload.names, s.payload.text]),
      [[ANNA.id, `direct:${MARC.id}`, ANNA.id, ['angebot.pdf', 'skizze.png'], 'Schau mal\n\nhttps://example.com/kueche']]);
    const msgs = (await c.messenger.request({ method: 'GET', path: `conversations/${d.conversationId}/messages`, user: app(MARC), query: {} })).json.messages;
    assert.deepEqual(msgs.map((m) => [m.kind, m.senderId, m.text, m.meta && m.meta.fileName]), [['file', ANNA.id, 'Schau mal\n\nhttps://example.com/kueche', 'angebot.pdf'], ['image', ANNA.id, null, 'skizze.png']]);
    assert.equal(c.pushes().length, 0, 'GateDrop itself pushes nothing — the Messenger does');
    assert.equal(c.messenger.notifications.filter((n) => n.kind === 'message').length, 2);
    // in the chat, not in Marc's GateDrop inbox; the sender still sees it under "sent"
    assert.equal((await c.as(MARC)('GET', 'inbox', null, { kind: 'received' })).json.items.length, 0);
    assert.equal((await c.as(ANNA)('GET', 'inbox', null, { kind: 'sent' })).json.items[0].deliveries[0].conversationId, d.conversationId);
  });
});

test('the family chat with the Messenger; files the Messenger does not take (type, > 25 MB) stay in GateDrop', async () => {
  await withHost({ messenger: true }, async (host, c) => {
    await c.messenger.callService('sync_group', { caller: 'gatecontrol-familie', payload: { key: 'family', title: 'Familie', userIds: [ANNA.id, MARC.id, LENA.id] } });
    const img = await c.upload(ANNA, PNG, 'image/png');
    const r = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: img, name: 'Wandertag.png' }], to: { people: ['family'] } })).json;
    assert.deepEqual([r.deliveries[0].target, r.deliveries[0].label, r.deliveries[0].status, !!r.deliveries[0].conversationId], ['family', 'Familie', 'delivered', true]);
    // a type the Messenger does not take (video/quicktime) and a file over 25 MB stay in GateDrop: the chat message names
    // them, GateDrop pushes and lists them; the small one goes into the chat
    const mov = await c.upload(ANNA, Buffer.from('moov'), 'video/quicktime');
    const big = await c.upload(ANNA, Buffer.from('big'), 'video/mp4', { bytes: 300 * 1024 * 1024 });
    const png = await c.upload(ANNA, PNG, 'image/png');
    const r2 = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: mov, name: 'clip.mov' }, { mediaId: big, name: 'film.mp4' }, { mediaId: png, name: 'foto.png' }], to: { people: [MARC.id] } })).json;
    const d2 = r2.deliveries[0];
    assert.deepEqual([d2.status, d2.via, d2.error, !!d2.conversationId], ['delivered', 'server', null, true]);
    assert.deepEqual(host.handOvers.slice(-1).map((h) => h.from), [png], 'only the small file was handed over (the .mov was refused by type)');
    const msgs = (await c.messenger.request({ method: 'GET', path: `conversations/${d2.conversationId}/messages`, user: app(MARC), query: {} })).json.messages;
    assert.deepEqual(msgs.map((m) => [m.kind, m.text, m.senderId]), [['image', '+2 Dateien in GateDrop: clip.mov, film.mp4', ANNA.id]]);
    const p = c.pushes().pop();
    assert.deepEqual([p.users, p.devices, p.title, p.body, p.data.gatedrop.send], [[MARC.id], undefined, 'Anna hat dir 2 Dateien geschickt', 'clip.mov, film.mp4', r2.id]);
    const inbox = (await c.as(MARC)('GET', 'inbox', null, { kind: 'received' })).json.items;
    assert.deepEqual(inbox.map((s) => s.id), [r2.id]);
    assert.equal((await host.mediaGet({ ...MARC }, big)).status, 200);
    assert.equal((await host.mediaGet({ ...LENA }, mov)).status, 404);
    assert.equal((await host.mediaGet({ ...MARC }, mov)).status, 200);
    assert.equal((await host.mediaGet({ ...LENA }, mov)).status, 404);
    assert.equal((await c.as(MARC)('POST', `sends/${r2.id}/opened`)).json.send.deliveries[0].status, 'opened');
  });
});

test('without the Messenger: a push to the person (family: to its members); Familie refusing → family not offered', async () => {
  await withHost({}, async (host, c) => {
    const r = (await c.as(ANNA)('POST', 'sends', { text: 'Bin um 6 da', to: { people: [MARC.id, 'family'] } })).json;
    assert.deepEqual(r.deliveries.map((d) => [d.target, d.status, d.via]), [[String(MARC.id), 'delivered', 'server'], ['family', 'delivered', 'server']]);
    const pushes = c.pushes();
    assert.deepEqual(pushes.map((p) => [p.users, p.title, p.body]), [[[MARC.id], 'Anna hat dir einen Text geschickt', 'Bin um 6 da'], [[MARC.id, LENA.id], 'Anna hat dir einen Text geschickt', 'Bin um 6 da']]);
    // Lena (family) and Marc see it; Oma does not
    assert.equal((await c.as(LENA)('GET', 'inbox', null, { kind: 'received' })).json.items[0].text, 'Bin um 6 da');
    assert.equal((await c.as(LENA)('GET', `sends/${r.id}`)).json.send.role, 'received');
    assert.equal((await c.as(OMA)('GET', `sends/${r.id}`)).status, 404);
    assert.equal((await c.as(OMA)('GET', 'inbox', null, { kind: 'received' })).json.items.length, 0);
    // pushes in the recipient's language
    await c.as(MARC, null)('GET', 'targets');
    await host.request({ method: 'GET', path: 'targets', user: app(MARC), lang: 'en' });
    await c.as(ANNA)('POST', 'sends', { link: 'https://example.com', to: { people: [MARC.id] } });
    assert.equal(c.pushes().pop().title, 'Anna sent you a link');
  });
  await withHost({ roles: null }, async (host, c) => {
    assert.equal((await c.as(ANNA)('GET', 'targets')).json.people.some((p) => p.id === 'family'), false);
    assert.equal((await c.as(ANNA)('POST', 'sends', { text: 'x', to: { people: ['family'] } })).json.code, 'forbidden');
  });
});
