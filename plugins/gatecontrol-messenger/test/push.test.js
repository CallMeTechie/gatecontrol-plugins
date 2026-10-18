'use strict';

// Chat pushes: one per new message to every member but the sender who is not muted
// and does not have the chat open; preview per person; reply / mark_read actions
// that work against the API; the topic in plugin.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, OMA, SEC, HOUR, PNG, OGG, PDF, png } = require('./helpers');

test('one push per message to the other members; sender, conversation, actions as the device contract expects', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA], 'Familie');
    assert.equal(c.pushes().length, 0, 'creating a group pushes nothing');
    const m = await c.send(ANNA, g.id, { text: 'Bist du schon unterwegs?' });
    const p = c.pushes();
    assert.equal(p.length, 1);
    assert.deepEqual(p[0].users.sort(), [MARC.id, LENA.id]);
    assert.equal(p[0].topic, 'message');
    assert.equal(p[0].title, 'Anna');
    assert.equal(p[0].body, 'Bist du schon unterwegs?');
    assert.equal(p[0].collapseKey, `chat:${g.id}`);
    assert.deepEqual(p[0].data.conversation, { id: String(g.id), title: 'Familie', isGroup: true });
    assert.deepEqual(p[0].data.sender, { id: ANNA.id, name: 'Anna', avatarUrl: null });
    assert.equal(p[0].data.messageId, m.id);
    assert.equal(p[0].data.conversationId, g.id);
    assert.deepEqual(p[0].data.actions, [
      { id: 'reply', label: 'Antworten', type: 'reply', path: `conversations/${g.id}/messages` },
      { id: 'mark_read', label: 'Gelesen', type: 'mark_read', path: `conversations/${g.id}/read`, body: { upTo: m.id } },
    ]);
    // direct chats: conversation title null (the apps show the sender)
    const d = await c.direct(MARC, ANNA);
    await c.send(MARC, d.id, { text: 'Hi' });
    const q = c.pushes()[1];
    assert.deepEqual([q.users, q.data.conversation], [[ANNA.id], { id: String(d.id), title: null, isGroup: false }]);
  });
});

test('the reply and mark_read actions work as the apps send them', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const m = await c.send(ANNA, d.id, { text: 'Kommst du?' });
    const [reply, markRead] = c.pushes()[0].data.actions;
    // reply: { ...body, clientId, kind: 'text', text, source: 'notification' } to the action's path
    const body = { ...(reply.body || {}), clientId: '7f6c1a2e-2b1d-4f3a-9a77-0c5d1e2f3a4b', kind: 'text', text: 'Ja, gleich!', source: 'notification' };
    let r = await c.as(MARC)('POST', reply.path, body);
    assert.equal(r.status, 200);
    assert.equal(r.json.message.text, 'Ja, gleich!');
    r = await c.as(MARC)('POST', reply.path, body);
    assert.equal(r.json.duplicate, true, 'a retried reply is stored once');
    assert.equal((await c.as(MARC)('GET', `conversations/${d.id}`)).json.conversation.unread, 0, 'replying reads');
    // mark_read: the body (or {}) to the action's path
    const m2 = await c.send(ANNA, d.id, { text: 'Und?' });
    const mr = c.pushes().filter((p) => p.users.includes(MARC.id)).pop().data.actions[1];
    assert.deepEqual(mr.body, { upTo: m2.id });
    r = await c.as(MARC)('POST', mr.path, mr.body);
    assert.deepEqual(r.json, { ok: true, lastReadId: m2.id, unread: 0 });
    assert.ok(m.id < m2.id);
    assert.equal(markRead.type, 'mark_read');
  });
});

test('preview off: "Neue Nachricht von Anna" without text; per recipient and language', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA, OMA]);
    await c.as(MARC)('PUT', 'prefs', { preview: false });
    await c.call({ ...LENA, portal: true, loggedIn: true, app: true }, 'GET', 'me').then(() => host.request({ method: 'GET', path: 'me', user: { ...OMA, portal: true, loggedIn: true, app: true }, lang: 'en' }));
    await c.send(ANNA, g.id, { text: 'Geheimer Plan' });
    const ps = c.pushes();
    assert.equal(ps.length, 3, 'preview on/de, preview off/de, preview on/en');
    const forMarc = ps.find((p) => p.users.includes(MARC.id));
    assert.deepEqual([forMarc.title, forMarc.body, forMarc.users], ['Neue Nachricht von Anna', '', [MARC.id]]);
    assert.ok(!JSON.stringify(forMarc).includes('Geheimer Plan'), 'no text anywhere in that push');
    const forLena = ps.find((p) => p.users.includes(LENA.id));
    assert.deepEqual([forLena.title, forLena.body], ['Anna', 'Geheimer Plan']);
    const forOma = ps.find((p) => p.users.includes(OMA.id));
    assert.deepEqual([forOma.title, forOma.body, forOma.data.actions[0].label, forOma.data.actions[1].label], ['Anna', 'Geheimer Plan', 'Reply', 'Mark read']);
    // the language of a person's pushes is the one of their last request
    await host.request({ method: 'PUT', path: 'prefs', body: { preview: false }, user: { ...OMA, portal: true, loggedIn: true, app: true }, lang: 'en' });
    await c.send(ANNA, g.id, { text: 'noch einer' });
    assert.equal(c.pushes().find((p) => p.users.includes(OMA.id) && p.body === '').title, 'New message from Anna');
  });
});

test('bodies of other kinds: photo with caption, voice with duration, file name, place', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    await c.send(ANNA, d.id, { kind: 'image', mediaId: await c.upload(ANNA, PNG, 'image/png'), text: 'Steht noch was drauf?' });
    await c.send(ANNA, d.id, { kind: 'image', mediaId: await c.upload(ANNA, PNG, 'image/png') });
    await c.send(ANNA, d.id, { kind: 'voice', mediaId: await c.upload(ANNA, OGG, 'audio/ogg'), meta: { durationMs: 14000 } });
    await c.send(ANNA, d.id, { kind: 'file', mediaId: await c.upload(ANNA, PDF, 'application/pdf'), meta: { fileName: 'Elternbrief.pdf' } });
    await c.send(ANNA, d.id, { kind: 'location', location: { lat: 1, lon: 2, label: 'Schule' } });
    await c.send(ANNA, d.id, { text: 'x'.repeat(4000) });
    const bodies = c.pushes().map((p) => p.body);
    assert.deepEqual(bodies.slice(0, 5), ['Foto: Steht noch was drauf?', 'Foto', 'Sprachnachricht (0:14)', 'Datei: Elternbrief.pdf', 'Standort: Schule']);
    assert.equal(bodies[5].length, 1000);
  });
});

test('picture messages (1.1.0): the preview as the push picture on GateControl ≥ 1.178.0 — preview recipients only; older hosts get none', async () => {
  const pic = png(64, 48);
  await withHost({ gatecontrol: '1.178.0' }, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA]);
    await c.as(LENA)('PUT', 'prefs', { preview: false });
    const photo = await c.upload(ANNA, pic, 'image/png');
    const thumb = await c.upload(ANNA, png(40, 32), 'image/png');
    await c.send(ANNA, g.id, { kind: 'image', mediaId: photo, thumbMediaId: thumb, text: 'Schau mal' });
    const ps = c.pushes().slice(-2);
    const forMarc = ps.find((p) => p.users.includes(MARC.id));
    const forLena = ps.find((p) => p.users.includes(LENA.id));
    assert.deepEqual([forMarc.image.mime, forMarc.image.width, forMarc.image.height], ['image/png', 40, 32], 'the preview file');
    assert.equal(forLena.image, undefined, 'no picture without preview');
    // no preview file: the photo itself (≤ 300 KB); a picture the host refuses (1×1): the push without it
    await c.send(ANNA, g.id, { kind: 'image', mediaId: await c.upload(ANNA, pic, 'image/png') });
    assert.equal(c.pushes().slice(-2).find((p) => p.users.includes(MARC.id)).image.width, 64);
    const n = c.pushes().length;
    await c.send(ANNA, g.id, { kind: 'image', mediaId: await c.upload(ANNA, PNG, 'image/png') });
    assert.equal(c.pushes().length, n + 2, 'both pushes went out');
    assert.ok(c.pushes().slice(-2).every((p) => !p.image));
    assert.ok(host.logs.some((l) => l.level === 'warn' && l.message.includes('push picture refused')));
    // other kinds carry none
    await c.send(ANNA, g.id, { text: 'Text' });
    assert.ok(c.pushes().slice(-2).every((p) => !p.image));
  });
  await withHost({ gatecontrol: '1.177.0' }, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    await c.send(ANNA, d.id, { kind: 'image', mediaId: await c.upload(ANNA, pic, 'image/png') });
    const p = c.pushes().at(-1);
    assert.deepEqual([p.users, p.image], [[MARC.id], undefined], 'GateControl 1.177.0: no picture, no refused attempt');
    assert.ok(!host.logs.some((l) => l.message.includes('push picture refused')));
  });
});

test('no push: muted (until a time / always), the conversation open (active within 30 s), the sender', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA, OMA]);
    await c.as(MARC)('PATCH', `conversations/${g.id}`, { mutedUntil: new Date(Date.now() + HOUR).toISOString() });
    await c.as(LENA)('PATCH', `conversations/${g.id}`, { notify: 'none' });
    let r = await c.as(OMA)('POST', `conversations/${g.id}/active`, {});
    assert.equal(r.json.until, new Date(Date.now() + 30 * SEC).toISOString());
    await c.send(ANNA, g.id, { text: 'eins' });
    assert.equal(c.pushes().length, 0, 'Marc muted, Lena never, Oma has the chat open');
    c.clock.add(31 * SEC);
    await c.send(ANNA, g.id, { text: 'zwei' });
    assert.deepEqual(c.pushes().map((p) => p.users), [[OMA.id]], 'Oma did not ping for 31 s');
    // the apps ping every 20 s while open; leaving ends it at once
    await c.as(OMA)('POST', `conversations/${g.id}/active`, {});
    c.clock.add(20 * SEC);
    await c.as(OMA)('POST', `conversations/${g.id}/active`, {});
    c.clock.add(20 * SEC);
    await c.send(ANNA, g.id, { text: 'drei' });
    assert.equal(c.pushes().length, 1);
    r = await c.as(OMA)('POST', `conversations/${g.id}/active`, { active: false });
    assert.equal(r.json.until, null);
    c.clock.add(HOUR);
    await c.send(ANNA, g.id, { text: 'vier' });
    assert.deepEqual(c.pushes().slice(1).map((p) => p.users.sort()), [[MARC.id, OMA.id]], 'Marc\'s mute ran out');
    assert.equal((await c.as(OMA)('POST', `conversations/${g.id}/active`, { active: 'yes' })).json.code, 'invalid');
    // active is per conversation
    await c.as(OMA)('POST', `conversations/${g.id}/active`, {});
    const d = await c.direct(ANNA, OMA);
    await c.send(ANNA, d.id, { text: 'privat' });
    assert.ok(c.pushes().pop().users.includes(OMA.id));
  });
});

test('push failures and the host\'s limits are logged (Protokoll), the message is stored anyway', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    // 120 pushes per hour per recipient: the 121st leaves Marc out
    for (let i = 0; i < 121; i++) await c.send(ANNA, d.id, { text: `n${i}` });
    assert.equal(c.pushes().length, 120);
    assert.equal((await c.as(MARC)('GET', `conversations/${d.id}`)).json.conversation.unread, 121);
    const log = (await c.admin('GET', 'log')).json.entries;
    assert.deepEqual(log.map((e) => [e.code, e.level, e.count]), [['push_rate_limit', 'limit', 1]]);
  });
});

test('plugin.json: the chat topic "message", app + events + media + services', () => {
  const m = require('../plugin.json');
  assert.deepEqual(m.notifyTopics, [{ id: 'message', label: { de: 'Chat-Nachrichten', en: 'Chat messages' }, chat: true, default: true },
    // 1.4.0: the daily story digest (not a chat push, off by default)
    { id: 'status', label: { de: 'Status-Zusammenfassung', en: 'Status digest' }, default: false }]);
  assert.equal(m.permissions.app, true);
  assert.equal(m.permissions.events, true);
  assert.equal(m.permissions.notify, true);
  assert.equal(m.media.maxBytes, 25 * 1024 * 1024);
  assert.equal(m.media.quotaDefault, '10GB');
  for (const t of ['image/jpeg', 'image/webp', 'audio/ogg', 'audio/mp4', 'audio/webm', 'application/pdf']) assert.ok(m.media.types.includes(t), t);
  assert.deepEqual(Object.keys(m.services.provides), ['send_message', 'sync_group', 'release_group', 'set_place_status']);
});
