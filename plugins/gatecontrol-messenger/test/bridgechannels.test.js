'use strict';

// 1.20.0: channels, read-only groups, format and link previews of bridged chats — against the mock host's gc.bridges
// version 7 (tools/testing/mock-bridges.js; the events as GateControl's services/bridges/events.js makes them since
// version 7: chat.channel / chat.readOnly, sender { channel: true, system: true }, marks, preview). No WhatsApp.
//
//   the page „Kanäle“   a channel is not in GET conversations?channels=1 (nor in its unread), GET channels lists it;
//                       an older client keeps seeing it among the chats, read only
//   a channel           muted from the start, its posts are texts of the channel with format and preview (the picture
//                       fetched over the bridge), edits and deletions of the channel, nothing can be sent into it
//   reactions           the person's own; a refusal of the bridge switches reacting in channels off, remembered
//   groups              where only admins write: among the chats, can.send false with a reason

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, ANNA } = require('./helpers');

const V7 = { enabled: true, networks: { whatsapp: true }, running: true, version: 7 };
const B = { bridged: '1' };
const BC = { bridged: '1', channels: '1' };
const KIM = { id: 'c' + 'k'.repeat(21), name: 'Kim Muster' };
const CH = { channel: true, system: true };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(800, 7)]);
let n = 0;
const eid = () => `$kc${++n}`;

async function link(c, host) {
  const me = c.as(ANNA);
  assert.equal((await me('POST', 'bridges/whatsapp/consent', { accept: true })).status, 200);
  let r = await me('POST', 'bridges/whatsapp/login', { flow: 'qr' });
  host.bridges.confirm(r.json.login.processId);
  r = await me('POST', `bridges/whatsapp/login/${r.json.login.processId}/${r.json.login.step.id}`, {});
  assert.equal(r.json.login.step.type, 'complete');
}
/** Anna follows a channel (and has a chat with Kim). → { channel, chat } as the events carry them */
async function setup(c, host) {
  await link(c, host);
  const ch = host.bridges.chat(ANNA.id, { kind: 'group', name: 'Sicherheit kompakt', channel: true, readOnly: true });
  const dm = host.bridges.chat(ANNA.id, { kind: 'direct', name: 'Kim Muster' });
  const channel = { id: ch, kind: 'group', name: 'Sicherheit kompakt', avatar: null, channel: true, readOnly: true };
  const chat = { id: dm, kind: 'direct', name: 'Kim Muster', avatar: null, channel: false, readOnly: false };
  await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat: channel }, { userId: ANNA.id, type: 'chat', chat }]);
  return { channel, chat };
}
const post = (chat, text, extra = {}) => ({ userId: ANNA.id, type: 'message', chat, id: eid(), sender: CH, kind: 'text', text, replyTo: null, ...extra });
const get = (c, path, q = BC) => c.call(app(ANNA), 'GET', path, null, q);
const msgs = async (c, convId) => (await get(c, `conversations/${convId}/messages`)).json.messages;

test('a channel lives on its own page: not among the chats of a client that knows channels, nor in its unread', async () => {
  await withHost({ bridges: V7 }, async (host, c) => {
    const { channel, chat } = await setup(c, host);
    await host.bridges.deliver([post(channel, 'Erster Beitrag'), { ...post(chat, 'Hallo'), sender: KIM }]);
    assert.equal((await get(c, 'me')).json.features.bridge_channels, true);
    const r = (await get(c, 'conversations')).json;
    assert.deepEqual(r.conversations.map((x) => x.title), ['Kim Muster']);
    assert.deepEqual(r.channels, { count: 1, unread: 1 });
    const page = (await get(c, 'channels')).json;
    assert.equal(page.channels.length, 1);
    assert.equal(page.unread, 1);
    const ch = page.channels[0];
    assert.deepEqual([ch.title, ch.kind, ch.bridge.channel, ch.bridge.readOnly, ch.bridge.reactions], ['Sicherheit kompakt', 'group', true, true, 'own']);
    assert.deepEqual([ch.muted, ch.me.notify], [true, 'none'], 'muted from the start');
    assert.deepEqual([ch.can.send, ch.can.sendReason, ch.can.react], [false, 'channel', true]);
    // a client that does not know channels keeps them among its chats (read only)
    const old = (await get(c, 'conversations', B)).json;
    assert.equal(old.conversations.length, 2);
    assert.equal(old.channels, undefined);
    // nobody without ?bridged=1 gets the page
    assert.equal((await get(c, 'channels', {})).status, 404);
    // reading it empties the page's counter
    assert.equal((await c.call(app(ANNA), 'POST', `conversations/${ch.id}/read`, { upTo: ch.lastMessageId }, BC)).status, 200);
    assert.deepEqual((await get(c, 'conversations')).json.channels, { count: 1, unread: 0 });
  });
});

test('a post is a text of the channel — with its format, its link preview and the preview’s picture; no push', async () => {
  await withHost({ bridges: V7, scan: true }, async (host, c) => {
    const { channel } = await setup(c, host);
    const ref = host.bridges.file(ANNA.id, { data: JPEG, mime: 'image/jpeg' });
    const text = '  Jetzt patchen: Update für X200\nhttps://sicher.example/x200';
    await host.bridges.deliver([post(channel, text, {
      // offsets as the server counts them, into the text before it is trimmed here
      marks: [{ type: 'bold', start: 2, end: 16 }, { type: 'link', start: 0, end: 4, url: 'javascript:alert(1)' }, { type: 'italic', start: 28, end: 32 }],
      preview: { url: 'https://sicher.example/x200', title: 'Kritische Lücke', description: 'Angreifer können …', site: 'sicher.example', image: { ref, mime: 'image/jpeg', w: 640, h: 360, size: JPEG.length } },
    })]);
    await host.tick();
    const [ch] = (await get(c, 'channels')).json.channels;
    const [m] = await msgs(c, ch.id);
    assert.deepEqual([m.kind, m.senderId, m.bridge.sender, m.bridge.channel], ['text', null, null, true]);
    assert.equal(m.text, 'Jetzt patchen: Update für X200\nhttps://sicher.example/x200');
    assert.deepEqual(m.marks, [{ type: 'bold', start: 0, end: 14 }, { type: 'italic', start: 26, end: 30 }], 'moved with the trimmed text; no javascript: link');
    assert.deepEqual({ ...m.preview, image: null }, { url: 'https://sicher.example/x200', title: 'Kritische Lücke', description: 'Angreifer können …', site: 'sicher.example', image: null });
    assert.match(m.preview.image.mediaId, /^[0-9a-f]{32}$/, 'the picture was fetched over the bridge');
    assert.deepEqual([m.preview.image.w, m.preview.image.h, m.preview.image.state], [640, 360, null]);
    assert.equal(c.pushes().length, 0, 'a channel is muted');
    // the bell turns pushes on: „<Kanal> · Kanal über WhatsApp“, no answer
    assert.equal((await c.call(app(ANNA), 'PATCH', `conversations/${ch.id}`, { notify: 'all' }, BC)).status, 200);
    await host.bridges.deliver([post(channel, 'Zweiter Beitrag')]);
    const p = c.pushes();
    assert.equal(p.length, 1);
    assert.equal(p[0].title, 'Sicherheit kompakt · Kanal über WhatsApp');
    assert.deepEqual(p[0].data.actions.map((a) => a.type), ['mark_read']);
  });
});

test('the channel changes and deletes its posts; nothing can be sent into it', async () => {
  await withHost({ bridges: V7 }, async (host, c) => {
    const { channel } = await setup(c, host);
    const first = post(channel, 'Alt');
    const other = post(channel, 'Weg damit');
    await host.bridges.deliver([first, other]);
    await host.bridges.deliver([
      { userId: ANNA.id, type: 'edit', chat: channel, id: eid(), sender: CH, target: first.id, text: 'Neu', marks: [{ type: 'bold', start: 0, end: 3 }] },
      { userId: ANNA.id, type: 'redact', chat: channel, id: eid(), sender: CH, target: other.id },
      { userId: ANNA.id, type: 'message', chat: channel, id: eid(), sender: CH, kind: 'unsupported', text: null, replyTo: null },
    ]);
    const [ch] = (await get(c, 'channels')).json.channels;
    const [a, b, u] = await msgs(c, ch.id);
    assert.deepEqual([a.text, a.marks, !!a.editedAt], ['Neu', [{ type: 'bold', start: 0, end: 3 }], true]);
    assert.equal(b.deleted, true);
    assert.equal(u.bridge.placeholder.kind, 'unsupported');
    const r = await c.call(app(ANNA), 'POST', `conversations/${ch.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'Hallo?' }, BC);
    assert.deepEqual([r.status, r.json.code, r.json.reason], [409, 'bridge_read_only', 'channel']);
    assert.equal(host.bridges.sent.filter((s) => s.op === 'send').length, 0);
  });
});

test('reactions in a channel: the person’s own — and off for channels once the bridge refused one', async () => {
  await withHost({ bridges: V7 }, async (host, c) => {
    const { channel, chat } = await setup(c, host);
    await host.bridges.deliver([post(channel, 'Beitrag'), { ...post(chat, 'Hi'), sender: KIM }]);
    const [ch] = (await get(c, 'channels')).json.channels;
    const [m] = await msgs(c, ch.id);
    let r = await c.call(app(ANNA), 'PUT', `messages/${m.id}/reaction`, { emoji: '👍' }, BC);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const sent = host.bridges.sent.filter((s) => s.op === 'react');
    assert.equal(sent.length, 1);
    // WhatsApp refuses it: the bridge says so as the reaction's status
    await host.bridges.deliver([{ userId: ANNA.id, type: 'status', chat: channel, target: sent[0].id, status: 'failed', reason: 'network_error' }]);
    const [m2] = await msgs(c, ch.id);
    assert.deepEqual(m2.reactions, [], 'taken back here');
    const [ch2] = (await get(c, 'channels')).json.channels;
    assert.deepEqual([ch2.bridge.reactions, ch2.can.react], ['off', false]);
    r = await c.call(app(ANNA), 'PUT', `messages/${m.id}/reaction`, { emoji: '❤️' }, BC);
    assert.deepEqual([r.status, r.json.code, r.json.reason], [409, 'bridge_read_only', 'reactions_off']);
    // chats and groups keep reacting
    const conv = (await get(c, 'conversations')).json.conversations[0];
    assert.equal(conv.can.react, true);
    const [dm] = await msgs(c, conv.id);
    assert.equal((await c.call(app(ANNA), 'PUT', `messages/${dm.id}/reaction`, { emoji: '👍' }, BC)).status, 200);
  });
});

test('a group where only admins write stays among the chats, read only with its reason; a chat from before becomes a channel', async () => {
  await withHost({ bridges: V7 }, async (host, c) => {
    const { chat } = await setup(c, host);
    const g = host.bridges.chat(ANNA.id, { kind: 'group', name: 'Verein', readOnly: true });
    const group = { id: g, kind: 'group', name: 'Verein', avatar: null, channel: false, readOnly: true };
    await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat: group }, { ...post(group, 'Info'), sender: KIM }, { ...post(chat, 'Hi'), sender: KIM }]);
    let convs = (await get(c, 'conversations')).json.conversations;
    const vg = convs.find((x) => x.title === 'Verein');
    assert.deepEqual([vg.can.send, vg.can.sendReason, vg.can.react, vg.bridge.readOnly, vg.muted], [false, 'admins_only', true, true, false]);
    const r = await c.call(app(ANNA), 'POST', `conversations/${vg.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'Darf ich?' }, BC);
    assert.deepEqual([r.status, r.json.reason], [409, 'admins_only']);
    // the admins open the group again
    await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat: { ...group, readOnly: false } }]);
    convs = (await get(c, 'conversations')).json.conversations;
    assert.equal(convs.find((x) => x.title === 'Verein').can.send, true);
    // a chat known before 1.20.0 (an event without the field) that the server now names a channel
    const old = host.bridges.chat(ANNA.id, { kind: 'direct', name: 'Neuigkeiten' });
    await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat: { id: old, kind: 'direct', name: 'Neuigkeiten' } }, { ...post({ id: old, kind: 'direct', name: 'Neuigkeiten' }, 'x'), sender: { system: true } }]);
    assert.ok((await get(c, 'conversations')).json.conversations.some((x) => x.title === 'Neuigkeiten'));
    await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat: { id: old, kind: 'group', name: 'Neuigkeiten', avatar: null, channel: true, readOnly: true } }]);
    assert.ok(!(await get(c, 'conversations')).json.conversations.some((x) => x.title === 'Neuigkeiten'));
    const chans = (await get(c, 'channels')).json.channels;
    assert.deepEqual(chans.map((x) => [x.title, x.muted]), [['Neuigkeiten', true]], 'a channel without a post is not listed');
  });
});
