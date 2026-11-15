'use strict';

// 1.14.0: chats over a bridge — against the mock host's gc.bridges version 3 (tools/testing/mock-bridges.js: the
// inbox of neutral events as GateControl's services/bridges/events.js makes them, the hook bridgeEvents, and what
// the plugin sends out). No WhatsApp, no Matrix.
//
//   who sees what      a chat appears with its first message, for the linked person only — no other member, no
//                      administrator, no client that does not say ?bridged=1
//   in                 text, reply, edit, deletion, reaction, files as a placeholder, twice, in any order, a restart
//   out                text, reply, edit, deletion, reaction, read — and what became of it; refusals change nothing
//   states             bridge down, logged out, unlinked, a child without the parents' yes

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, portal, ADMIN, ANNA, MARC, LENA } = require('./helpers');

const ON = { enabled: true, networks: { whatsapp: true }, running: true, version: 3 };
const B = { bridged: '1' };
const KIM = { id: 'c' + 'k'.repeat(21), name: 'Kim Muster' };
const ROBIN = { id: 'c' + 'r'.repeat(21), name: 'Robin' };
const familie = () => ({ plugin: 'gatecontrol-familie', provides: ['family_roles'], service: () => ({ ok: true, parents: [ANNA.id, MARC.id], children: [LENA.id] }) });
let n = 0;
const eid = () => `$ev${++n}`;

async function link(c, host, user) {
  const me = c.as(user);
  assert.equal((await me('POST', 'bridges/whatsapp/consent', { accept: true })).status, 200);
  let r = await me('POST', 'bridges/whatsapp/login', { flow: 'qr' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  host.bridges.confirm(r.json.login.processId);
  r = await me('POST', `bridges/whatsapp/login/${r.json.login.processId}/${r.json.login.step.id}`, {});
  assert.equal(r.json.login.step.type, 'complete', JSON.stringify(r.json));
}
/** Anna linked, a chat with Kim opened by the bridge. → { ref, chat } (chat = what the events carry) */
async function annaAndKim(c, host, { kind = 'direct', name = 'Kim Muster', user = ANNA } = {}) {
  await link(c, host, user);
  const ref = host.bridges.chat(user.id, { kind, name });
  const chat = { id: ref, kind, name };
  await host.bridges.deliver([{ userId: user.id, type: 'chat', chat }]);
  return { ref, chat };
}
const text = (userId, chat, body, extra = {}) => ({ userId, type: 'message', chat, id: eid(), sender: KIM, kind: 'text', text: body, replyTo: null, ...extra });
const list = async (c, user, q = B) => (await c.call(app(user), 'GET', 'conversations', null, q)).json.conversations;
const msgs = async (c, user, convId) => (await c.call(app(user), 'GET', `conversations/${convId}/messages`, null, B)).json.messages;
const bcall = (c, user, method, path, body) => c.call(app(user), method, path, body, B);

test('a server without the message part of the bridges: nothing changes, nothing is offered', async () => {
  await withHost({ bridges: { enabled: true, networks: { whatsapp: true }, running: true } }, async (host, c) => {
    await link(c, host, ANNA);
    const me = (await c.as(ANNA)('GET', 'me')).json;
    assert.equal(me.features.bridge_chats, undefined);
    assert.equal(me.features.linked_services, true);
    await host.tick();
    assert.deepEqual(await list(c, ANNA), []);
  });
});

test('a chat appears with its first message — for the linked person only, and only for clients that know such chats', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const { chat } = await annaAndKim(c, host);
    assert.deepEqual(await list(c, ANNA), [], 'known, but nothing was said yet');
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.bridge_chats, undefined);
    c.resetEvents();
    await host.bridges.deliver([text(ANNA.id, chat, 'Kommt ihr Samstag zum Grillen?')]);
    assert.equal(host.bridges.state.inbox.length, 0, 'filed and acknowledged');

    const [conv] = await list(c, ANNA);
    assert.equal(conv.kind, 'direct');
    assert.equal(conv.title, 'Kim Muster');
    assert.equal(conv.peer, null);
    assert.deepEqual(conv.bridge, { network: 'whatsapp', label: 'WhatsApp', state: 'ok', closed: false, supports: ['text', 'reply', 'reaction', 'edit', 'delete', 'read', 'typing'] });
    assert.deepEqual(conv.members.map((m) => m.userId), [ANNA.id], 'the only member is the linked person');
    assert.equal(conv.unread, 1);
    assert.deepEqual(conv.can, { send: true, pin: true, editInfo: false, manageMembers: false, leave: false, setDisappearing: false });
    assert.equal(conv.lastMessage.text, 'Kommt ihr Samstag zum Grillen?');
    const [m] = await msgs(c, ANNA, conv.id);
    assert.deepEqual([m.senderId, m.mine, m.kind, m.text], [null, false, 'text', 'Kommt ihr Samstag zum Grillen?']);
    assert.equal(m.bridge.sender.name, 'Kim Muster');
    assert.equal(typeof m.bridge.sender.contactId, 'number');
    assert.equal(m.bridge.placeholder, null);

    // an app that does not know bridged chats: no such chat, not even by its id
    assert.deepEqual(await list(c, ANNA, {}), []);
    for (const p of [`conversations/${conv.id}`, `conversations/${conv.id}/messages`, `messages/${m.id}`]) {
      const r = await c.as(ANNA)(p.startsWith('messages') ? 'DELETE' : 'GET', p);
      assert.equal(r.status, 404, p);
    }
    assert.equal((await c.as(ANNA)('POST', `conversations/${conv.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'x' })).status, 404);
    // nobody else: not another member of the household, not the administrator, with or without the mark
    for (const other of [MARC, LENA]) {
      assert.deepEqual(await list(c, other), []);
      assert.equal((await bcall(c, other, 'GET', `conversations/${conv.id}`)).status, 404);
      assert.equal((await bcall(c, other, 'GET', `conversations/${conv.id}/messages`)).status, 404);
    }
    assert.equal((await c.call(portal(ADMIN), 'GET', `conversations/${conv.id}/messages`, null, B)).status, 404);
    // the live event went to Anna alone
    const evs = c.events('message.new');
    assert.equal(evs.length, 1);
    assert.deepEqual(evs[0].users, [ANNA.id]);
    assert.equal(evs[0].data.bridge, 'whatsapp');
    // the feature word appears for Anna only — an older app shows its "newer version" hint to exactly these people
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.bridge_chats, true);
    assert.equal((await c.as(MARC)('GET', 'me')).json.features.bridge_chats, undefined);
  });
});

test('the push of a contact’s message goes to the chat’s person only — with the text only when they want previews', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const { chat } = await annaAndKim(c, host);
    await host.bridges.deliver([text(ANNA.id, chat, 'Kommt ihr Samstag?')]);
    const [conv] = await list(c, ANNA);
    let p = c.pushes();
    assert.equal(p.length, 1);
    assert.deepEqual(p[0].users, [ANNA.id]);
    assert.equal(p[0].title, 'Kim Muster · WhatsApp');
    assert.equal(p[0].body, 'Kommt ihr Samstag?');
    assert.deepEqual(p[0].data.conversation, { id: String(conv.id), title: null, isGroup: false });
    assert.equal(p[0].data.sender.name, 'Kim Muster');
    assert.equal(p[0].data.bridge, 'whatsapp');
    // the buttons of the push work in every app: they carry the mark in their body
    const [reply, markRead] = p[0].data.actions;
    assert.equal((await c.as(ANNA)('POST', markRead.path, markRead.body)).status, 200);
    const r = await c.as(ANNA)('POST', reply.path, { ...reply.body, clientId: c.cid(), kind: 'text', text: 'Gern!', source: 'notification' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(host.bridges.sent.filter((s) => s.op === 'send')[0].text, 'Gern!');

    // without previews: no text, the service is named
    assert.equal((await c.as(ANNA)('PUT', 'prefs', { preview: false })).status, 200);
    await host.bridges.deliver([text(ANNA.id, chat, 'streng geheim')]);
    p = c.pushes();
    assert.equal(p.length, 2);
    assert.equal(p[1].title, 'Neue Nachricht über WhatsApp');
    assert.equal(p[1].body, '');
    assert.ok(!JSON.stringify(p[1]).includes('geheim'));
    // muted: none
    await bcall(c, ANNA, 'PATCH', `conversations/${conv.id}`, { notify: 'none' });
    await host.bridges.deliver([text(ANNA.id, chat, 'leise')]);
    assert.equal(c.pushes().length, 2);
  });
});

test('what a contact does: reply, edit, deletion, reaction and taking it back', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const { chat } = await annaAndKim(c, host);
    const first = text(ANNA.id, chat, 'Ab 16 Uhr');
    const reply = text(ANNA.id, chat, 'Passt, bis Samstag!', { replyTo: first.id });
    await host.bridges.deliver([first, reply]);
    const [conv] = await list(c, ANNA);
    let m = await msgs(c, ANNA, conv.id);
    assert.equal(m[1].replyTo.id, m[0].id);
    assert.equal(m[1].replyTo.text, 'Ab 16 Uhr');
    assert.equal(m[1].replyTo.senderName, 'Kim Muster');

    c.resetEvents();
    const reaction = { userId: ANNA.id, type: 'reaction', chat, id: eid(), sender: KIM, target: first.id, emoji: '👍' };
    await host.bridges.deliver([{ userId: ANNA.id, type: 'edit', chat, id: eid(), sender: KIM, target: first.id, text: 'Ab 17 Uhr' }, reaction]);
    m = await msgs(c, ANNA, conv.id);
    assert.equal(m[0].text, 'Ab 17 Uhr');
    assert.ok(m[0].editedAt);
    assert.deepEqual(m[0].reactions, [{ emoji: '👍', count: 1, userIds: [], contactIds: [m[0].bridge.sender.contactId] }]);
    assert.ok(c.events('message.update').every((e) => e.users.length === 1 && e.users[0] === ANNA.id));
    // an edit by somebody who did not write it changes nothing
    await host.bridges.deliver([{ userId: ANNA.id, type: 'edit', chat, id: eid(), sender: ROBIN, target: first.id, text: 'gefälscht' }]);
    assert.equal((await msgs(c, ANNA, conv.id))[0].text, 'Ab 17 Uhr');

    await host.bridges.deliver([{ userId: ANNA.id, type: 'redact', chat, id: eid(), sender: KIM, target: reaction.id }]);
    assert.deepEqual((await msgs(c, ANNA, conv.id))[0].reactions, []);
    await host.bridges.deliver([{ userId: ANNA.id, type: 'redact', chat, id: eid(), sender: KIM, target: reply.id }]);
    m = await msgs(c, ANNA, conv.id);
    assert.deepEqual([m[1].deleted, m[1].text], [true, null]);
  });
});

test('files arrive as a line that says what came — nothing is swallowed; the bridge’s own notices are system lines', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const { chat } = await annaAndKim(c, host);
    await host.bridges.deliver([
      text(ANNA.id, chat, 'So sah es letztes Jahr aus', { kind: 'media', media: { kind: 'image', name: 'grill.jpg' } }),
      text(ANNA.id, chat, null, { kind: 'media', media: { kind: 'voice', name: null } }),
      text(ANNA.id, chat, null, { kind: 'unsupported' }),
      text(ANNA.id, chat, 'Du wurdest abgemeldet', { kind: 'notice', sender: { system: true } }),
    ]);
    const [conv] = await list(c, ANNA);
    const m = await msgs(c, ANNA, conv.id);
    assert.deepEqual(m.map((x) => [x.kind, x.text, x.bridge.placeholder]), [
      // 1.15.0: state / reason — null: nothing to fetch (a GateControl without files over the bridge)
      ['text', 'So sah es letztes Jahr aus', { kind: 'image', name: 'grill.jpg', state: null, reason: null }],
      ['text', null, { kind: 'voice', name: null, state: null, reason: null }],
      ['text', null, { kind: 'unsupported', name: null, state: null, reason: null }],
      ['system', 'Du wurdest abgemeldet', null],
    ]);
    assert.equal(m[3].system.event, 'bridge_notice');
    assert.equal(conv.unread, 4);
    const p = c.pushes();
    assert.equal(p[0].body, 'Bild: So sah es letztes Jahr aus');
    assert.equal(p[1].body, 'Sprachnachricht');
  });
});

test('twice, in any order, with a restart in between: every message once, what came too early waits', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const { chat } = await annaAndKim(c, host);
    const a = text(ANNA.id, chat, 'eins');
    const b = text(ANNA.id, chat, 'zwei');
    // the same events again (the homeserver re-sent a transaction, the backlog of a new room overlaps)
    await host.bridges.deliver([a, a, b]);
    await host.bridges.deliver([b, a]);
    const [conv] = await list(c, ANNA);
    assert.deepEqual((await msgs(c, ANNA, conv.id)).map((m) => m.text), ['eins', 'zwei']);
    assert.equal(c.pushes().length, 2);

    // reaction, edit and deletion before their message
    const late = text(ANNA.id, chat, 'später');
    const gone = text(ANNA.id, chat, 'wird gelöscht');
    await host.bridges.deliver([
      { userId: ANNA.id, type: 'reaction', chat, id: eid(), sender: KIM, target: late.id, emoji: '❤️' },
      { userId: ANNA.id, type: 'edit', chat, id: eid(), sender: KIM, target: late.id, text: 'später (geändert)' },
      { userId: ANNA.id, type: 'redact', chat, id: eid(), sender: KIM, target: gone.id },
    ]);
    assert.equal((await msgs(c, ANNA, conv.id)).length, 2, 'nothing to show yet');
    await host.bridges.deliver([late, gone]);
    const m = await msgs(c, ANNA, conv.id);
    assert.deepEqual(m.map((x) => [x.text, x.deleted, x.reactions.length]), [['eins', false, 0], ['zwei', false, 0], ['später (geändert)', false, 1], [null, true, 0]]);

    // delivered while the plugin was not listening (no hook): the background run fetches it; a crash between
    // filing and acknowledging hands the same events over again
    const c3 = text(ANNA.id, chat, 'drei');
    await host.bridges.deliver([c3], { wake: false });
    assert.equal(host.bridges.state.inbox.length, 1);
    await host.tick();
    assert.equal(host.bridges.state.inbox.length, 0);
    await host.bridges.deliver([c3], { wake: false });
    await host.tick();
    assert.equal((await msgs(c, ANNA, conv.id)).filter((x) => x.text === 'drei').length, 1);
    // nonsense is acknowledged and gone, the rest goes on
    await host.bridges.deliver([{ userId: ANNA.id, type: 'message', chat: { id: 'nope' }, id: '$x', sender: KIM }, { userId: 9999, type: 'message', chat, id: eid(), sender: KIM, text: 'x' }, { type: 'lost', userId: ANNA.id }, text(ANNA.id, chat, 'vier')]);
    assert.equal(host.bridges.state.inbox.length, 0);
    assert.equal((await msgs(c, ANNA, conv.id)).slice(-1)[0].text, 'vier');
  });
});

test('sending: a text goes out as the person, and the chat shows what became of it', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const { ref, chat } = await annaAndKim(c, host);
    const first = text(ANNA.id, chat, 'Kommt ihr?');
    await host.bridges.deliver([first]);
    const [conv] = await list(c, ANNA);
    const [incoming] = await msgs(c, ANNA, conv.id);
    const clientId = c.cid();
    let r = await bcall(c, ANNA, 'POST', `conversations/${conv.id}/messages`, { clientId, kind: 'text', text: 'Gern! Wir bringen Salat mit.', replyTo: incoming.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const sent = r.json.message;
    assert.deepEqual([sent.mine, sent.status, sent.bridge.state, sent.bridge.reason], [true, 'sent', 'sent', null]);
    const out = host.bridges.sent.filter((s) => s.op === 'send');
    assert.equal(out.length, 1);
    assert.deepEqual([out[0].userId, out[0].network, out[0].chatId, out[0].text, out[0].replyTo], [ANNA.id, 'whatsapp', ref, 'Gern! Wir bringen Salat mit.', first.id]);
    // the same clientId again: stored once, sent once
    r = await bcall(c, ANNA, 'POST', `conversations/${conv.id}/messages`, { clientId, kind: 'text', text: 'Gern! Wir bringen Salat mit.' });
    assert.equal(r.json.duplicate, true);
    assert.equal(host.bridges.sent.filter((s) => s.op === 'send').length, 1);
    assert.equal(c.pushes().length, 1, 'no push for one’s own message');

    // the bridge's word: delivered, then read by the other side
    c.resetEvents();
    await host.bridges.deliver([{ userId: ANNA.id, type: 'status', chat, target: out[0].id, status: 'delivered' }]);
    assert.equal((await msgs(c, ANNA, conv.id))[1].status, 'delivered');
    assert.equal(c.events('message.update')[0].data.status, 'delivered');
    await host.bridges.ephemeral([{ userId: ANNA.id, type: 'receipt', chat: { id: ref, kind: 'direct' }, upTo: out[0].id, reader: { id: KIM.id } }]);
    assert.equal((await msgs(c, ANNA, conv.id))[1].status, 'read');
    const cv = (await bcall(c, ANNA, 'GET', `conversations/${conv.id}`)).json.conversation;
    assert.deepEqual([cv.readUpTo, cv.deliveredUpTo], [sent.id, sent.id]);
    // a late "sent" does not take "read" back
    await host.bridges.deliver([{ userId: ANNA.id, type: 'status', chat, target: out[0].id, status: 'sent' }]);
    assert.equal((await msgs(c, ANNA, conv.id))[1].status, 'read');

    // written in the messenger's own app: Anna's, no push, nothing unread
    const before = c.pushes().length;
    await host.bridges.deliver([text(ANNA.id, chat, 'vom Handy', { sender: { self: true } })]);
    const m = await msgs(c, ANNA, conv.id);
    assert.deepEqual([m[2].mine, m[2].senderId, m[2].bridge.remote, m[2].status], [true, ANNA.id, true, 'sent']);
    assert.equal(c.pushes().length, before);
    assert.equal((await bcall(c, ANNA, 'GET', `conversations/${conv.id}`)).json.conversation.unread, 0);
  });
});

test('only text crosses: everything else is refused before anything is stored or sent', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const { chat } = await annaAndKim(c, host);
    await host.bridges.deliver([text(ANNA.id, chat, 'hi')]);
    const [conv] = await list(c, ANNA);
    const mediaId = await c.upload(app(ANNA), Buffer.from('x'), 'text/plain');
    for (const body of [
      { kind: 'file', mediaId }, { kind: 'location', location: { lat: 51, lon: 7 } }, { kind: 'poll', poll: { question: 'Kuchen?', options: ['ja', 'nein'] } },
      { kind: 'text', text: 'x', mediaId }, { kind: 'text', text: 'x', meta: { fileName: 'a' } },
    ]) {
      const r = await bcall(c, ANNA, 'POST', `conversations/${conv.id}/messages`, { clientId: c.cid(), ...body });
      assert.deepEqual([r.status, r.json.code], [409, 'bridge_text_only'], JSON.stringify(body));
    }
    assert.equal((await bcall(c, ANNA, 'POST', `conversations/${conv.id}/messages`, { clientId: c.cid(), kind: 'text', text: '' })).status, 400);
    for (const patch of [{ title: 'x' }, { disappearingS: 86400 }, { add: [MARC.id] }]) {
      assert.equal((await bcall(c, ANNA, 'PATCH', `conversations/${conv.id}`, patch)).json.code, 'bridge_text_only');
    }
    assert.equal((await msgs(c, ANNA, conv.id)).length, 1);
    assert.equal(host.bridges.sent.length, 0);
    // muting and archiving are the person's own business
    assert.equal((await bcall(c, ANNA, 'PATCH', `conversations/${conv.id}`, { notify: 'none' })).status, 200);
  });
});

test('a message the bridge did not take says why and can be sent again; a bridge that is down takes nothing', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const { chat } = await annaAndKim(c, host);
    await host.bridges.deliver([text(ANNA.id, chat, 'hi')]);
    const [conv] = await list(c, ANNA);
    host.bridges.failSend = { code: 'ERR_BRIDGE', reason: 'm_forbidden' };
    let r = await bcall(c, ANNA, 'POST', `conversations/${conv.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'kommt nicht an' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.message.status, r.json.message.bridge.state, r.json.message.bridge.reason], ['failed', 'failed', 'm_forbidden']);
    const id = r.json.message.id;
    // nobody else may send it again, and only a failed one
    assert.equal((await bcall(c, MARC, 'POST', `messages/${id}/resend`, {})).status, 404);
    r = await bcall(c, ANNA, 'POST', `messages/${id}/resend`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.message.status, 'sent');
    assert.equal(host.bridges.sent.filter((s) => s.op === 'send').length, 1);
    assert.equal((await bcall(c, ANNA, 'POST', `messages/${id}/resend`, {})).status, 400);
    // the bridge reports a failure later
    await host.bridges.deliver([{ userId: ANNA.id, type: 'status', chat, target: host.bridges.sent[0].id, status: 'failed', reason: 'network_error', retriable: true }]);
    const m = (await msgs(c, ANNA, conv.id))[1];
    assert.deepEqual([m.status, m.bridge.reason], ['failed', 'network_error']);
    const log = (await c.admin('GET', 'log')).json;
    assert.ok(JSON.stringify(log).includes('bridge_send_failed'));
    assert.ok(!JSON.stringify(log).includes('kommt nicht an'), 'no content in the log');

    // the bridge does not run: refused before anything is stored
    host.bridges.setHost({ state: 'failed', running: false });
    const cv = (await bcall(c, ANNA, 'GET', `conversations/${conv.id}`)).json.conversation;
    assert.deepEqual([cv.bridge.state, cv.can.send], ['unreachable', false]);
    r = await bcall(c, ANNA, 'POST', `conversations/${conv.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'x' });
    assert.deepEqual([r.status, r.json.code], [503, 'bridge_unreachable']);
    assert.equal((await msgs(c, ANNA, conv.id)).length, 2);
    // the history stays readable
    assert.equal((await msgs(c, ANNA, conv.id))[0].text, 'hi');
  });
});

test('one’s own edit, deletion and reaction go to the other side first — refused there, nothing changes here', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const { chat } = await annaAndKim(c, host);
    const first = text(ANNA.id, chat, 'hi');
    await host.bridges.deliver([first]);
    const [conv] = await list(c, ANNA);
    const [incoming] = await msgs(c, ANNA, conv.id);
    const mine = (await bcall(c, ANNA, 'POST', `conversations/${conv.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'Hallo Kim' })).json.message;
    const ext = host.bridges.sent[0].id;

    let r = await bcall(c, ANNA, 'PATCH', `messages/${mine.id}`, { text: 'Hallo Kim!' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([host.bridges.sent[1].op, host.bridges.sent[1].edit, host.bridges.sent[1].text], ['send', ext, 'Hallo Kim!']);
    host.bridges.failSend = { code: 'ERR_BRIDGE', reason: 'too_old' };
    r = await bcall(c, ANNA, 'PATCH', `messages/${mine.id}`, { text: 'zu spät' });
    assert.deepEqual([r.status, r.json.code, r.json.reason], [502, 'bridge_failed', 'too_old']);
    assert.equal((await msgs(c, ANNA, conv.id))[1].text, 'Hallo Kim!');
    // somebody else's message is not mine to change or delete
    assert.equal((await bcall(c, ANNA, 'PATCH', `messages/${incoming.id}`, { text: 'x' })).json.code, 'not_sender');
    assert.equal((await bcall(c, ANNA, 'DELETE', `messages/${incoming.id}?for=all`)).status >= 400, true);

    // a reaction, another one (the old one is taken back first), none
    r = await bcall(c, ANNA, 'PUT', `messages/${incoming.id}/reaction`, { emoji: '👍' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.reactions, [{ emoji: '👍', count: 1, userIds: [ANNA.id] }]);
    const react1 = host.bridges.sent.filter((s) => s.op === 'react')[0];
    assert.deepEqual([react1.target, react1.emoji], [first.id, '👍']);
    await bcall(c, ANNA, 'PUT', `messages/${incoming.id}/reaction`, { emoji: '❤️' });
    assert.deepEqual(host.bridges.sent.slice(-2).map((s) => [s.op, s.target]), [['redact', react1.id], ['react', first.id]]);
    await bcall(c, ANNA, 'PUT', `messages/${incoming.id}/reaction`, { emoji: null });
    assert.equal(host.bridges.sent.slice(-1)[0].op, 'redact');
    assert.deepEqual((await msgs(c, ANNA, conv.id))[0].reactions, []);
    host.bridges.failSend = { code: 'ERR_BRIDGE_UNREACHABLE', reason: 'timeout' };
    r = await bcall(c, ANNA, 'PUT', `messages/${incoming.id}/reaction`, { emoji: '👍' });
    assert.equal(r.status, 503);
    assert.deepEqual((await msgs(c, ANNA, conv.id))[0].reactions, []);

    // delete for everyone: the other side first
    const q = { ...B, for: 'all' };
    host.bridges.failSend = { code: 'ERR_BRIDGE', reason: 'no_permission' };
    assert.equal((await c.call(app(ANNA), 'DELETE', `messages/${mine.id}`, null, q)).status, 502);
    assert.equal((await msgs(c, ANNA, conv.id))[1].deleted, false);
    r = await c.call(app(ANNA), 'DELETE', `messages/${mine.id}`, null, q);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(host.bridges.sent.slice(-1).map((s) => [s.op, s.target]), [['redact', ext]]);
    assert.equal((await msgs(c, ANNA, conv.id))[1].deleted, true);
    // delete for me stays here
    const count = host.bridges.sent.length;
    assert.equal((await c.call(app(ANNA), 'DELETE', `messages/${incoming.id}`, null, { ...B, for: 'me' })).status, 200);
    assert.equal(host.bridges.sent.length, count);
  });
});

test('read and typing: the other side learns it only from people who share it; theirs arrive live', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const { ref, chat } = await annaAndKim(c, host);
    const first = text(ANNA.id, chat, 'hi');
    await host.bridges.deliver([first]);
    const [conv] = await list(c, ANNA);
    const [m] = await msgs(c, ANNA, conv.id);
    assert.equal((await bcall(c, ANNA, 'POST', `conversations/${conv.id}/read`, { upTo: m.id })).json.unread, 0);
    assert.deepEqual(host.bridges.sent.map((s) => [s.op, s.messageId]), [['read', first.id]]);
    assert.equal((await bcall(c, ANNA, 'POST', `conversations/${conv.id}/typing`, {})).status, 200);
    assert.deepEqual(host.bridges.sent.slice(-1).map((s) => [s.op, s.on]), [['typing', true]]);
    // "typing …" of the contact: a live event for Anna alone, with the contact's name
    c.resetEvents();
    await host.bridges.ephemeral([{ userId: ANNA.id, type: 'typing', chat: { id: ref, kind: 'direct' }, contacts: [KIM.id] }]);
    const [ty] = c.events('typing');
    assert.deepEqual(ty.users, [ANNA.id]);
    assert.deepEqual([ty.data.conversationId, ty.data.userId, ty.data.contacts[0].name], [conv.id, null, 'Kim Muster']);
    // read in the messenger's own app: read here
    const second = text(ANNA.id, chat, 'noch da?');
    await host.bridges.deliver([second]);
    assert.equal((await bcall(c, ANNA, 'GET', `conversations/${conv.id}`)).json.conversation.unread, 1);
    await host.bridges.ephemeral([{ userId: ANNA.id, type: 'receipt', chat: { id: ref, kind: 'direct' }, upTo: second.id, reader: { self: true } }]);
    assert.equal((await bcall(c, ANNA, 'GET', `conversations/${conv.id}`)).json.conversation.unread, 0);

    // somebody who shares neither: nothing goes out
    assert.equal((await c.as(ANNA)('PUT', 'prefs', { readReceipts: false, typing: false })).status, 200);
    const third = text(ANNA.id, chat, 'und jetzt?');
    await host.bridges.deliver([third]);
    const before = host.bridges.sent.length;
    const last = (await msgs(c, ANNA, conv.id)).slice(-1)[0];
    await bcall(c, ANNA, 'POST', `conversations/${conv.id}/read`, { upTo: last.id });
    await bcall(c, ANNA, 'POST', `conversations/${conv.id}/typing`, {});
    assert.equal(host.bridges.sent.length, before);
  });
});

test('logged out or unlinked: the chats stay readable, sending needs a new link', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const { chat } = await annaAndKim(c, host);
    await host.bridges.deliver([text(ANNA.id, chat, 'hi')]);
    const [conv] = await list(c, ANNA);
    // the service dropped the linked device
    const login = host.bridges.state.logins.get(ANNA.id)[0];
    host.bridges.logOut(ANNA.id, login.id);
    await c.as(ANNA)('GET', 'bridges');
    let cv = (await bcall(c, ANNA, 'GET', `conversations/${conv.id}`)).json.conversation;
    assert.deepEqual([cv.bridge.state, cv.can.send], ['logged_out', false]);
    let r = await bcall(c, ANNA, 'POST', `conversations/${conv.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'x' });
    assert.deepEqual([r.status, r.json.code, r.json.reason], [409, 'bridge_unlinked', 'logged_out']);
    // unlinked by the person: the same, and the history is still there
    assert.equal((await c.as(ANNA)('DELETE', `bridges/whatsapp/logins/${login.id}`)).status, 200);
    cv = (await bcall(c, ANNA, 'GET', `conversations/${conv.id}`)).json.conversation;
    assert.deepEqual([cv.bridge.state, cv.can.send], ['unlinked', false]);
    assert.equal((await msgs(c, ANNA, conv.id))[0].text, 'hi');
    assert.equal((await list(c, ANNA)).length, 1);
    assert.equal(host.bridges.sent.length, 0);
    // the account left the chat at the service
    await link(c, host, ANNA);
    await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat, closed: true }]);
    cv = (await bcall(c, ANNA, 'GET', `conversations/${conv.id}`)).json.conversation;
    assert.deepEqual([cv.bridge.state, cv.bridge.closed, cv.can.send], ['ok', true, false]);
  });
});

test('children: nothing arrives and nothing goes out without the parents’ yes', async () => {
  await withHost({ bridges: ON, services: [familie()] }, async (host, c) => {
    // Lena has no permission: what the bridge delivers for her is dropped, not kept for later
    const ref = host.bridges.chat(LENA.id, { name: 'Kim Muster' });
    const chat = { id: ref, kind: 'direct', name: 'Kim Muster' };
    await host.bridges.deliver([{ userId: LENA.id, type: 'chat', chat }, text(LENA.id, chat, 'für Lena')]);
    assert.equal(host.bridges.state.inbox.length, 0);
    assert.deepEqual(await list(c, LENA), []);
    assert.equal(c.pushes().length, 0);
    assert.ok(JSON.stringify((await c.admin('GET', 'log')).json).includes('bridge_event_locked'));

    // a parent allows it: from now on it works
    assert.equal((await c.as(ANNA)('PUT', `bridges/children/${LENA.id}`, { networks: { whatsapp: true } })).status, 200);
    await link(c, host, LENA);
    await host.bridges.deliver([text(LENA.id, chat, 'jetzt')]);
    const [conv] = await list(c, LENA);
    assert.equal(conv.bridge.state, 'ok');
    assert.equal((await bcall(c, LENA, 'POST', `conversations/${conv.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'hallo' })).status, 200);
    // not even a parent reads the child's chat
    assert.deepEqual(await list(c, ANNA), []);
    assert.equal((await bcall(c, ANNA, 'GET', `conversations/${conv.id}/messages`)).status, 404);

    // taken back: locked — readable, no sending, nothing new
    assert.equal((await c.as(ANNA)('PUT', `bridges/children/${LENA.id}`, { networks: { whatsapp: false } })).status, 200);
    const cv = (await bcall(c, LENA, 'GET', `conversations/${conv.id}`)).json.conversation;
    assert.deepEqual([cv.bridge.state, cv.can.send], ['locked', false]);
    assert.equal((await bcall(c, LENA, 'POST', `conversations/${conv.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'x' })).json.code, 'bridge_locked');
    await host.bridges.deliver([text(LENA.id, chat, 'kommt nicht an')]);
    assert.equal((await msgs(c, LENA, conv.id)).length, 2);
  });
});

test('a group of the other messenger: every contact with its name, the group’s name as the title', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const { chat } = await annaAndKim(c, host, { kind: 'group', name: 'Elternrunde 4b' });
    await host.bridges.deliver([text(ANNA.id, chat, 'Wer bringt Kuchen mit?', { sender: ROBIN }), text(ANNA.id, chat, 'Ich!')]);
    const [conv] = await list(c, ANNA);
    assert.deepEqual([conv.kind, conv.title, conv.bridge.network], ['group', 'Elternrunde 4b', 'whatsapp']);
    assert.deepEqual((await msgs(c, ANNA, conv.id)).map((m) => m.bridge.sender.name), ['Robin', 'Kim Muster']);
    assert.deepEqual(c.pushes()[0].data.conversation, { id: String(conv.id), title: 'Elternrunde 4b', isGroup: true });
    // renamed over there, and a contact's new name
    await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat: { ...chat, name: 'Elternrunde 5b' } }, { userId: ANNA.id, type: 'contact', chat, contact: { id: ROBIN.id, name: 'Robin K.' } }]);
    assert.equal((await list(c, ANNA))[0].title, 'Elternrunde 5b');
    assert.equal((await msgs(c, ANNA, conv.id))[0].bridge.sender.name, 'Robin K.');
    // Anna's own chats inside GateControl are untouched
    const d = await c.direct(ANNA, MARC);
    await c.send(ANNA, d.id, { text: 'intern' });
    const all = await list(c, ANNA);
    assert.deepEqual(all.map((x) => !!x.bridge).sort(), [false, true]);
    assert.equal((await list(c, ANNA, {})).length, 1, 'without the mark only the chat inside GateControl');
    assert.equal(all.find((x) => !x.bridge).bridge, null);
  });
});
