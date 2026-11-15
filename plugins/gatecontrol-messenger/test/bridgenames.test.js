'use strict';

// 1.19.0 — what the first real test over the bridge showed (a picture sent from the person's phone, a chat with a
// contact the bridge knew no name of):
//
//   names   a chat or contact the bridge names by its phone number („+49… (WA)“) gets no number as a name: the chat is
//           named by the person's own address book (Mail, matched by the number at GateControl — the number never comes
//           here), else neutrally („WhatsApp-Kontakt“); names stored before are put right once per start
//   files   a file the host keeps refusing (an answer it does not read, a call that timed out, …) does not stay
//           „wird geladen …“: after a few runs the placeholder says „failed / unavailable“ with retry: true, and
//           POST messages/:id/fetch tries again; the plugin's log names the code (never a reference or a name)

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, ANNA } = require('./helpers');

const V6 = { enabled: true, networks: { whatsapp: true }, running: true, version: 6 };
const GC = '1.219.0';
const B = { bridged: '1' };
// fake numbers only
const NUMBER = '+4915100000000';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 9)]);
const KIM = { id: 'c' + 'k'.repeat(21), name: `${NUMBER} (WA)` };

function mail(book) {
  return {
    plugin: 'gatecontrol-mail', provides: { contacts_phones: { label: { de: 'Kontakte', en: 'Contacts' }, maxPerHour: 3600 } },
    service: async ({ user, payload }) => {
      if (!user || payload.userId !== user.id) return { ok: false, code: 'forbidden' };
      return { ok: true, items: book[user.id] || [], next: null };
    },
  };
}
async function link(c, host, user) {
  const me = c.as(user);
  assert.equal((await me('POST', 'bridges/whatsapp/consent', { accept: true })).status, 200);
  let r = await me('POST', 'bridges/whatsapp/login', { flow: 'qr' });
  host.bridges.confirm(r.json.login.processId);
  r = await me('POST', `bridges/whatsapp/login/${r.json.login.processId}/${r.json.login.step.id}`, {});
  assert.equal(r.json.login.step.type, 'complete');
}
async function numberedChat(c, host) {
  await link(c, host, ANNA);
  const ref = host.bridges.chat(ANNA.id, { kind: 'direct', name: `${NUMBER} (WA)` });
  const chat = { id: ref, kind: 'direct', name: `${NUMBER} (WA)` };
  await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat }]);
  return { ref, chat };
}
const list = async (c) => (await c.call(app(ANNA), 'GET', 'conversations', null, B)).json.conversations;
const msgs = async (c, convId) => (await c.call(app(ANNA), 'GET', `conversations/${convId}/messages`, null, B)).json.messages;
let n = 0;
// the address book's names are kept in memory for 10 minutes — each test starts without them
test.beforeEach(() => require('../server/contactchat')._reset());
const text = (chat, sender, extra = {}) => ({ userId: ANNA.id, type: 'message', chat, id: `$bn${++n}`, sender, kind: 'text', text: 'Hallo', replyTo: null, ...extra });

test('a chat the bridge names by its number: the address book’s name, else „WhatsApp-Kontakt“ — never the number', async () => {
  await withHost({ bridges: V6, gatecontrol: GC, services: [mail({})] }, async (host, c) => {
    const { chat } = await numberedChat(c, host);
    await host.bridges.deliver([text(chat, KIM)]);
    const [conv] = await list(c);
    assert.equal(conv.title, 'WhatsApp-Kontakt');
    const [m] = await msgs(c, conv.id);
    assert.equal(m.bridge.sender.name, null, 'the contact has no name either');
    assert.doesNotMatch(JSON.stringify(await list(c)) + JSON.stringify(await msgs(c, conv.id)), /15100000|\(WA\)/);
  });
  // the same with Anna's address book: the contact there has this number → its name
  const book = { [ANNA.id]: [{ id: 21, name: 'Jenny Muster', phones: [{ key: 'mobile', kind: 'mobile', value: '0151 00000000', e164: NUMBER, landline: false }] }] };
  await withHost({ bridges: V6, gatecontrol: GC, services: [mail(book)] }, async (host, c) => {
    require('../server/contactchat')._reset();
    const { ref, chat } = await numberedChat(c, host);
    host.bridges.contacts = [{ number: NUMBER, name: null, chatId: ref }];
    await host.bridges.deliver([text(chat, KIM)]);
    const [conv] = await list(c);
    assert.equal(conv.title, 'Jenny Muster', 'named like in the messenger’s own app: by the person’s address book');
    assert.equal((await c.call(app(ANNA), 'GET', `conversations/${conv.id}`, null, B)).json.conversation.title, 'Jenny Muster');
    // a public name the bridge learns later does not win over the address book
    await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat: { ...chat, name: 'Jenny' } }]);
    assert.equal((await list(c))[0].title, 'Jenny Muster');
  });
});

test('names stored before 1.19.0 („+49… (WA)“, „Kim (WA)“) are put right once per start', async () => {
  await withHost({ bridges: V6, gatecontrol: GC, services: [mail({})] }, async (host, c) => {
    const { chat } = await link(c, host, ANNA).then(() => {
      const ref = host.bridges.chat(ANNA.id, { kind: 'direct', name: 'Kim' });
      return { chat: { id: ref, kind: 'direct', name: 'Kim' } };
    });
    await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat }, text(chat, { id: KIM.id, name: 'Kim' })]);
    const seal = require('../server/seal');
    await host.gc.db.query('UPDATE conversations SET title_enc = ? WHERE bridge_ref = ?', [seal.seal(`${NUMBER} (WA)`), chat.id]);
    await host.gc.db.query('UPDATE bridge_contacts SET name_enc = ?', [seal.seal('Kim (WA)')]);
    require('../server/bridgechats')._reset();
    await host.tick();
    const [conv] = await list(c);
    assert.equal(conv.title, 'WhatsApp-Kontakt');
    const [m] = await msgs(c, conv.id);
    assert.equal(m.bridge.sender.name, 'Kim', 'the suffix goes, the name stays');
    const stored = (await host.gc.db.query('SELECT title_enc FROM conversations WHERE bridge_ref = ?', [chat.id])).rows[0];
    assert.equal(stored.title_enc, null, 'the number is gone from the database');
  });
});

test('the own picture sent from the phone: never „wird geladen …“ for ever — failed with „Erneut versuchen“, then fetched', async () => {
  await withHost({ bridges: V6, gatecontrol: GC, scan: true, services: [mail({})] }, async (host, c) => {
    const { chat } = await numberedChat(c, host);
    const fref = host.bridges.file(ANNA.id, { data: JPEG, mime: 'image/jpeg' });
    // a refusal the plugin cannot read as final (a homeserver answer the host does not take, a call that timed out)
    host.bridges.failFetch = { code: 'ERR_BRIDGE', reason: 'bad_answer' };
    await host.bridges.deliver([{ userId: ANNA.id, type: 'message', chat, id: '$own1', sender: { self: true }, kind: 'media',
      media: { kind: 'image', name: 'image.jpg', ref: fref, mime: 'image/jpeg', size: JPEG.length }, text: null, replyTo: null }]);
    const [conv] = await list(c);
    for (let i = 0; i < 6; i++) await host.tick();
    let [m] = await msgs(c, conv.id);
    assert.equal(m.mine, true);
    assert.deepEqual([m.kind, m.bridge.placeholder.state, m.bridge.placeholder.reason, m.bridge.placeholder.retry], ['text', 'failed', 'unavailable', true]);
    // „Erneut versuchen“
    host.bridges.failFetch = null;
    const r = await c.call(app(ANNA), 'POST', `messages/${m.id}/fetch`, {}, B);
    assert.equal(r.status, 200);
    await host.tick();
    [m] = await msgs(c, conv.id);
    assert.equal(m.kind, 'image');
    assert.ok(m.media && m.media.id, 'the picture is there');
    // nothing to fetch again now
    assert.equal((await c.call(app(ANNA), 'POST', `messages/${m.id}/fetch`, {}, B)).status, 400);
  });
});

test('the bridge away: the file waits (no „failed“ after a few runs), the next files are not asked meanwhile', async () => {
  await withHost({ bridges: V6, gatecontrol: GC, scan: true, services: [mail({})] }, async (host, c) => {
    const { chat } = await numberedChat(c, host);
    const fref = host.bridges.file(ANNA.id, { data: JPEG, mime: 'image/jpeg' });
    host.bridges.failFetch = { code: 'ERR_BRIDGE_UNREACHABLE', reason: 'unreachable' };
    await host.bridges.deliver([{ userId: ANNA.id, type: 'message', chat, id: '$k1', sender: { id: KIM.id, name: 'Kim' }, kind: 'media',
      media: { kind: 'image', name: 'image.jpg', ref: fref, mime: 'image/jpeg', size: JPEG.length }, text: null, replyTo: null }]);
    const [conv] = await list(c);
    for (let i = 0; i < 8; i++) await host.tick();
    let [m] = await msgs(c, conv.id);
    assert.equal(m.bridge.placeholder.state, 'loading');
    host.bridges.failFetch = null;
    await host.tick();
    [m] = await msgs(c, conv.id);
    assert.equal(m.kind, 'image');
  });
});
