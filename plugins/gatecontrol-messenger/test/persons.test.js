'use strict';

// 1.21.0: persons (chats v2, part B) — against the mock host's gc.bridges version 9 (tools/testing/mock-bridges.js:
// matchAccounts names the pairings the server's profile service would find, recognition the person's consent). No
// WhatsApp, no phone number anywhere.
//
//   suggestions   a bridged chat the server recognises as an account → a suggestion (strong first), „Nicht jetzt“ hides
//                 it for 7 days, „Nicht mehr vorschlagen“ for good; a withdrawn consent takes it away
//   merging       one entry per person in GET conversations?people=1 (`person`, `folded`), only in the viewer's view;
//                 groups and channels never; a chat with the account is made when there is none (without a message)
//   history       both ways by time, every message with its way, the source filter, cursors across the ways
//   answers       over the way of the newest incoming message (a tie and none: GateControl); an answer to a message goes
//                 back its message's way
//   settings      unread of all ways, read, mute and archive for the person; pushes „Name · über WhatsApp“
//   splitting     „Trennen“ — both chats again, nothing lost, not suggested again
//   recognition   GET bridges recognition, PUT bridges/recognition (the consent at the link of WhatsApp)

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, ANNA, MARC, LENA, DAY, MIN } = require('./helpers');

const V9 = { enabled: true, networks: { whatsapp: true }, running: true, version: 9 };
const Q = { bridged: '1', channels: '1', people: '1' };
const SCHATZ = { id: 'c' + 's'.repeat(21), name: 'Schatzimausi 💕' };
const KIM = { id: 'c' + 'k'.repeat(21), name: 'Kim Muster' };
let n = 0;
const eid = () => `$pp${++n}`;

async function link(c, host) {
  const me = c.as(ANNA);
  assert.equal((await me('POST', 'bridges/whatsapp/consent', { accept: true }, { bridged: '1' })).status, 200);
  let r = await me('POST', 'bridges/whatsapp/login', { flow: 'qr' }, { bridged: '1' });
  host.bridges.confirm(r.json.login.processId);
  r = await me('POST', `bridges/whatsapp/login/${r.json.login.processId}/${r.json.login.step.id}`, {}, { bridged: '1' });
  assert.equal(r.json.login.step.type, 'complete');
}
/** Anna linked WhatsApp; her chat with „Schatzimausi 💕“ (who is Marc) and with Kim, and a WhatsApp group. */
async function setup(c, host, { group = false } = {}) {
  await link(c, host);
  const dm = { id: host.bridges.chat(ANNA.id, { kind: 'direct', name: SCHATZ.name }), kind: 'direct', name: SCHATZ.name, avatar: null };
  const kim = { id: host.bridges.chat(ANNA.id, { kind: 'direct', name: KIM.name }), kind: 'direct', name: KIM.name, avatar: null };
  const grp = { id: host.bridges.chat(ANNA.id, { kind: 'group', name: 'Verein' }), kind: 'group', name: 'Verein', avatar: null };
  await host.bridges.deliver([
    { userId: ANNA.id, type: 'chat', chat: dm }, { userId: ANNA.id, type: 'chat', chat: kim },
    ...(group ? [{ userId: ANNA.id, type: 'chat', chat: grp }, wa(grp, KIM, 'Hallo Verein')] : []),
    wa(dm, SCHATZ, 'Kannst du Milch mitbringen?', { at: Date.now() - 10 * MIN }), wa(kim, KIM, 'Moin'),
  ]);
  host.bridges.accounts = [{ contactId: SCHATZ.id, userId: MARC.id, strength: 'strong', via: 'own_whatsapp' }];
  return { dm, kim, grp };
}
const wa = (chat, who, text, extra = {}) => ({ userId: ANNA.id, type: 'message', chat, id: eid(), sender: { id: who.id, name: who.name }, kind: 'text', text, replyTo: null, ...extra });
const as = (c, u) => (method, path, body, q = Q) => c.call(app(u), method, path, body === undefined ? null : body, q);
const list = async (c, u = ANNA, q = Q) => (await as(c, u)('GET', 'conversations', undefined, q)).json;
const convOf = (l, title) => l.conversations.find((x) => x.title === title);

/** Anna merges her WhatsApp chat with Marc's account (from the suggestion) → the person's entry. */
async function merged(c, host) {
  const s = await setup(c, host);
  const sg = (await as(c, ANNA)('GET', 'persons/suggestions')).json.suggestions;
  assert.equal(sg.length, 1);
  const r = await as(c, ANNA)('POST', 'persons', { conversationIds: [sg[0].conversationId], userId: MARC.id, name: 'account' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { ...s, entry: r.json.conversation, person: r.json.person, waId: sg[0].conversationId };
}

test('a suggestion: the server recognises the WhatsApp chat as Marc — the pairing only, strong first; no word without ?people=1', async () => {
  await withHost({ bridges: V9 }, async (host, c) => {
    await setup(c, host);
    assert.equal((await as(c, ANNA)('GET', 'me')).json.features.chat_people, true);
    assert.equal((await as(c, MARC)('GET', 'me')).json.features.chat_people, undefined, 'only for people with bridged chats');
    host.bridges.accounts.push({ contactId: KIM.id, userId: LENA.id, strength: 'medium', via: 'profile_phone' });
    const r = await as(c, ANNA)('GET', 'persons/suggestions');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const [a, b] = r.json.suggestions;
    assert.deepEqual([a.userId, a.strength, a.via, a.network, a.label, a.contact.name, a.account.name], [MARC.id, 'strong', 'own_whatsapp', 'whatsapp', 'WhatsApp', SCHATZ.name, 'Marc']);
    assert.equal(a.text, '„Schatzimausi 💕“ bei WhatsApp ist vielleicht Marc.');
    assert.equal(a.reason, 'Marc hat das eigene WhatsApp mit GateControl verknüpft, und es ist dein Kontakt „Schatzimausi 💕“.');
    assert.deepEqual([b.userId, b.strength], [LENA.id, 'medium']);
    assert.match(b.reason, /nicht bestätigt/);
    // matchAccounts was asked once (kept 10 minutes)
    await as(c, ANNA)('GET', 'persons/suggestions');
    assert.equal(host.bridges.state.log.filter((x) => x.op === 'match_accounts').length, 1);
    // a client that does not know persons gets nothing of it
    assert.equal((await as(c, ANNA)('GET', 'persons/suggestions', undefined, { bridged: '1' })).status, 404);
    assert.equal((await as(c, ANNA)('GET', 'persons/suggestions', undefined, {})).status, 404);
  });
});

test('merging: one entry for the person, only in the viewer’s view; Marc sees nothing; older clients keep both chats', async () => {
  await withHost({ bridges: V9 }, async (host, c) => {
    const { entry, person, waId } = await merged(c, host);
    assert.equal(entry.title, 'Marc');
    assert.equal(person.ways.length, 2);
    assert.deepEqual(person.ways.map((w) => w.way).sort(), ['gatecontrol', 'whatsapp']);
    const gc = person.ways.find((w) => w.way === 'gatecontrol');
    assert.equal(entry.id, gc.conversationId, 'the lead is the chat inside GateControl (made now, no message yet)');
    assert.deepEqual(person.names.sort(), ['Marc', SCHATZ.name].sort(), 'the search finds both names');
    const l = await list(c);
    assert.deepEqual(l.folded, [waId]);
    const e = l.conversations.find((x) => x.person);
    assert.equal(e.id, entry.id);
    assert.equal(e.unread, 1, 'the unread messages of both ways');
    assert.equal(e.lastMessage.text, 'Kannst du Milch mitbringen?');
    assert.equal(e.lastMessage.way, 'whatsapp');
    assert.ok(!l.conversations.some((x) => x.id === waId));
    // the suggestion is answered
    assert.deepEqual((await as(c, ANNA)('GET', 'persons/suggestions')).json.suggestions, []);
    // Marc sees nothing: no chat with Anna (it has no message), no person
    assert.deepEqual((await list(c, MARC)).conversations, []);
    // a client without ?people=1: the chats as before
    const old = await list(c, ANNA, { bridged: '1', channels: '1' });
    assert.ok(old.conversations.some((x) => x.id === waId));
    assert.ok(old.conversations.every((x) => !x.person));
    // GET conversations/:id of the way names the person (the app opens the person)
    const w = (await as(c, ANNA)('GET', `conversations/${waId}`)).json.conversation;
    assert.equal(w.person.id, person.id);
    assert.equal(w.person.conversationId, entry.id);
  });
});

test('the shared history: both ways by time, each message with its way; the source filter; paging across the ways', async () => {
  await withHost({ bridges: V9 }, async (host, c) => {
    const { dm, person, entry } = await merged(c, host);
    c.clock.add(MIN);
    await c.send(MARC, entry.id, { text: 'Bist du heute Abend da?' });
    c.clock.add(MIN);
    // a WhatsApp message that is older than Marc's (it waited at the bridge)
    await host.bridges.deliver([wa(dm, SCHATZ, 'Bis später, ich bring Brot mit'), wa(dm, SCHATZ, 'Früher geschrieben', { at: Date.now() - 90 * 1000 })]);
    const r = (await as(c, ANNA)('GET', `persons/${person.id}/messages`)).json;
    assert.deepEqual(r.messages.map((m) => [m.text, m.way]), [
      ['Kannst du Milch mitbringen?', 'whatsapp'], ['Früher geschrieben', 'whatsapp'], ['Bist du heute Abend da?', 'gatecontrol'], ['Bis später, ich bring Brot mit', 'whatsapp'],
    ]);
    assert.equal(r.hasMore, false);
    assert.equal(r.ways.length, 2);
    const only = (await as(c, ANNA)('GET', `persons/${person.id}/messages`, undefined, { ...Q, way: 'gatecontrol' })).json;
    assert.deepEqual(only.messages.map((m) => m.text), ['Bist du heute Abend da?']);
    // two at a time: the newest two, then the two before them
    const p1 = (await as(c, ANNA)('GET', `persons/${person.id}/messages`, undefined, { ...Q, limit: '2' })).json;
    assert.deepEqual(p1.messages.map((m) => m.text), ['Bist du heute Abend da?', 'Bis später, ich bring Brot mit']);
    assert.equal(p1.hasMore, true);
    const p2 = (await as(c, ANNA)('GET', `persons/${person.id}/messages`, undefined, { ...Q, limit: '2', before: String(p1.messages[0].id) })).json;
    assert.deepEqual(p2.messages.map((m) => m.text), ['Kannst du Milch mitbringen?', 'Früher geschrieben']);
    assert.equal(p2.hasMore, false);
    const p3 = (await as(c, ANNA)('GET', `persons/${person.id}/messages`, undefined, { ...Q, after: String(p2.messages[1].id) })).json;
    assert.deepEqual(p3.messages.map((m) => m.text), ['Bist du heute Abend da?', 'Bis später, ich bring Brot mit']);
    const around = (await as(c, ANNA)('GET', `persons/${person.id}/messages`, undefined, { ...Q, limit: '2', around: String(p1.messages[0].id) })).json;
    assert.deepEqual(around.messages.map((m) => m.text), ['Früher geschrieben', 'Bist du heute Abend da?']);
    // search over both ways
    const s = (await as(c, ANNA)('GET', `persons/${person.id}/search`, undefined, { ...Q, q: 'bri' })).json;
    assert.deepEqual(s.results.map((m) => [m.text, m.way]), [['Bis später, ich bring Brot mit', 'whatsapp'], ['Kannst du Milch mitbringen?', 'whatsapp']]);
    // a message of another chat is no cursor
    const other = (await list(c)).conversations.find((x) => x.title === KIM.name);
    assert.equal((await as(c, ANNA)('GET', `persons/${person.id}/messages`, undefined, { ...Q, before: String(other.lastMessage.id) })).status, 404);
  });
});

test('the answer goes over the way of the newest incoming message — a tie and none: GateControl; an answer to a message goes back its way', async () => {
  await withHost({ bridges: V9 }, async (host, c) => {
    const { dm, person, entry, waId } = await merged(c, host);
    const me = as(c, ANNA);
    // the newest incoming message came over WhatsApp
    let p = (await me('GET', `persons/${person.id}`)).json.person;
    assert.deepEqual([p.reply.way, p.reply.label, p.reply.conversationId], ['whatsapp', 'WhatsApp', waId]);
    let r = await me('POST', `persons/${person.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'Klar, mach ich' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.way, r.json.conversationId, r.json.message.way], ['whatsapp', waId, 'whatsapp']);
    assert.equal(host.bridges.sent.filter((x) => x.op === 'send').pop().text, 'Klar, mach ich');
    // Marc writes inside GateControl: now GateControl
    c.clock.add(MIN);
    const gm = await c.send(MARC, entry.id, { text: 'Ab sieben' });
    p = (await me('GET', `persons/${person.id}`)).json.person;
    assert.equal(p.reply.way, 'gatecontrol');
    r = await me('POST', `persons/${person.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'Gut' });
    assert.deepEqual([r.json.way, r.json.message.conversationId], ['gatecontrol', entry.id]);
    // a tie (same moment on both ways): GateControl
    c.clock.add(MIN);
    await c.send(MARC, entry.id, { text: 'gleichzeitig' });
    await host.bridges.deliver([wa(dm, SCHATZ, 'gleichzeitig auch')]);
    p = (await me('GET', `persons/${person.id}`)).json.person;
    assert.equal(p.reply.way, 'gatecontrol');
    // an answer to a WhatsApp message goes back over WhatsApp, whatever the newest message was
    const waMsg = (await me('GET', `persons/${person.id}/messages`, undefined, { ...Q, way: 'whatsapp' })).json.messages.find((m) => m.text === 'Kannst du Milch mitbringen?');
    r = await me('POST', `persons/${person.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'Zu deiner Frage: ja', replyTo: waMsg.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.way, 'whatsapp');
    assert.equal(r.json.message.replyTo.id, waMsg.id);
    assert.ok(gm.id);
  });
});

test('without an incoming message the answer goes over GateControl (two chats merged by hand, the name chosen)', async () => {
  await withHost({ bridges: V9 }, async (host, c) => {
    const { kim } = await setup(c, host);
    const l = await list(c);
    const kimConv = convOf(l, KIM.name);
    // Lena never wrote; Anna merges her chat with Kim with Lena's account by hand, Kim's name kept
    const cand = (await as(c, ANNA)('GET', 'persons/candidates', undefined, { ...Q, conversationId: String(kimConv.id) })).json;
    assert.ok(cand.accounts.some((a) => a.userId === LENA.id));
    assert.ok(cand.chats.some((x) => x.title === SCHATZ.name));
    assert.ok(!cand.accounts.some((a) => a.userId === ANNA.id));
    const r = await as(c, ANNA)('POST', 'persons', { conversationIds: [kimConv.id], userId: LENA.id, name: kimConv.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.conversation.title, KIM.name);
    assert.equal(r.json.person.nameFrom, kimConv.id);
    // Kim's message is incoming: WhatsApp; Kim's message gone from view → GateControl
    assert.equal(r.json.person.reply.way, 'whatsapp');
    const m = (await as(c, ANNA)('GET', `persons/${r.json.person.id}/messages`)).json.messages[0];
    assert.equal((await as(c, ANNA)('DELETE', `messages/${m.id}`, undefined, { ...Q, for: 'me' })).status, 200);
    assert.equal((await as(c, ANNA)('GET', `persons/${r.json.person.id}`)).json.person.reply.way, 'gatecontrol');
    // the name: the account's again
    const p2 = await as(c, ANNA)('PATCH', `persons/${r.json.person.id}`, { name: 'account' });
    assert.equal(p2.json.conversation.title, 'Lena');
    assert.ok(kim);
  });
});

test('groups and channels are never merged; at most one account; a person of one way is none', async () => {
  await withHost({ bridges: V9 }, async (host, c) => {
    await setup(c, host, { group: true });
    const l = await list(c);
    const grp = convOf(l, 'Verein');
    const wa1 = convOf(l, SCHATZ.name);
    const me = as(c, ANNA);
    let r = await me('POST', 'persons', { conversationIds: [grp.id], userId: MARC.id });
    assert.deepEqual([r.status, r.json.code, r.json.reason], [409, 'cannot_merge', 'group']);
    const fam = await c.group(ANNA, [MARC, LENA], 'Familie');
    r = await me('POST', 'persons', { conversationIds: [wa1.id, fam.id] });
    assert.deepEqual([r.status, r.json.reason], [409, 'group']);
    const withMarc = await c.direct(ANNA, MARC);
    const withLena = await c.direct(ANNA, LENA);
    r = await me('POST', 'persons', { conversationIds: [withMarc.id, withLena.id] });
    assert.deepEqual([r.status, r.json.reason], [409, 'two_accounts']);
    r = await me('POST', 'persons', { conversationIds: [wa1.id] });
    assert.deepEqual([r.status, r.json.reason], [409, 'one_way']);
    // somebody else's chat does not exist for Anna
    const lm = await c.direct(LENA, MARC);
    r = await me('POST', 'persons', { conversationIds: [wa1.id, lm.id] });
    assert.equal(r.status, 404);
  });
});

test('unread, read, mute and archive hold for the person; pushes name the person and the way', async () => {
  await withHost({ bridges: V9 }, async (host, c) => {
    const { dm, person, entry, waId } = await merged(c, host);
    const me = as(c, ANNA);
    const before = c.pushes().length;
    c.clock.add(MIN);
    await host.bridges.deliver([wa(dm, SCHATZ, 'Noch da?')]);
    await c.send(MARC, entry.id, { text: 'Hallo Anna' });
    const p = c.pushes().slice(before);
    assert.equal(p.length, 2);
    assert.equal(p[0].title, 'Marc · über WhatsApp');
    assert.deepEqual(p[0].data.person, { id: person.id, conversationId: entry.id });
    assert.equal(p[1].title, 'Marc · über GateControl');
    assert.deepEqual(p[1].data.person, { id: person.id, conversationId: entry.id });
    let e = (await me('GET', `persons/${person.id}`)).json.conversation;
    assert.equal(e.unread, 3);
    const r = await me('POST', `persons/${person.id}/read`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.unread, 0);
    assert.equal(host.bridges.sent.filter((x) => x.op === 'read').length, 1, 'WhatsApp learns it too');
    // mute the person: both ways
    assert.equal((await me('PATCH', `persons/${person.id}`, { notify: 'none' })).status, 200);
    e = (await me('GET', `persons/${person.id}`)).json.conversation;
    assert.ok(e.person.ways.every((w) => w.muted));
    const n0 = c.pushes().length;
    await host.bridges.deliver([wa(dm, SCHATZ, 'leise')]);
    await c.send(MARC, entry.id, { text: 'auch leise' });
    assert.equal(c.pushes().length, n0);
    // a change on one way (an app that patches the conversation) holds for the other as well
    assert.equal((await me('PATCH', `conversations/${waId}`, { notify: 'all' })).status, 200);
    e = (await me('GET', `persons/${person.id}`)).json.conversation;
    assert.ok(e.person.ways.every((w) => !w.muted));
    // archive the person: both ways
    const a = await me('POST', `persons/${person.id}/archive`, { archived: true });
    assert.equal(a.json.conversation.archived, true);
    assert.ok(a.json.person.ways.every((w) => w.archived));
  });
});

test('„Trennen“: both chats again, nothing lost; that suggestion does not come back', async () => {
  await withHost({ bridges: V9 }, async (host, c) => {
    const { person, entry, waId } = await merged(c, host);
    await c.send(MARC, entry.id, { text: 'Hallo' });
    const all = (await as(c, ANNA)('GET', `persons/${person.id}/messages`)).json.messages.length;
    const r = await as(c, ANNA)('DELETE', `persons/${person.id}/ways/${waId}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.person, null, 'two ways: the person is dissolved');
    assert.deepEqual(r.json.conversations.map((x) => x.id).sort((a, b) => a - b), [entry.id, waId].sort((a, b) => a - b));
    const l = await list(c);
    assert.ok(l.conversations.every((x) => !x.person));
    assert.deepEqual(l.folded, []);
    const wa1 = l.conversations.find((x) => x.id === waId);
    const gc = l.conversations.find((x) => x.id === entry.id);
    const count = async (id) => (await as(c, ANNA)('GET', `conversations/${id}/messages`)).json.messages.length;
    assert.equal((await count(wa1.id)) + (await count(gc.id)), all, 'no message lost');
    assert.equal((await as(c, ANNA)('GET', `persons/${person.id}`)).status, 404);
    c.clock.add(11 * MIN);
    assert.deepEqual((await as(c, ANNA)('GET', 'persons/suggestions')).json.suggestions, []);
  });
});

test('„Nicht jetzt“ hides a suggestion for 7 days, „Nicht mehr vorschlagen“ for good; a withdrawn consent takes it away', async () => {
  await withHost({ bridges: V9 }, async (host, c) => {
    await setup(c, host);
    const me = as(c, ANNA);
    let [s] = (await me('GET', 'persons/suggestions')).json.suggestions;
    assert.equal((await me('POST', `persons/suggestions/${s.id}`, { action: 'later' })).status, 200);
    assert.deepEqual((await me('GET', 'persons/suggestions')).json.suggestions, []);
    c.clock.add(7 * DAY + MIN);
    [s] = (await me('GET', 'persons/suggestions')).json.suggestions;
    assert.ok(s);
    assert.equal((await me('POST', `persons/suggestions/${s.id}`, { action: 'never' })).status, 200);
    c.clock.add(30 * DAY);
    assert.deepEqual((await me('GET', 'persons/suggestions')).json.suggestions, []);
    assert.equal((await me('POST', 'persons/suggestions/1-2', { action: 'later' })).status, 404);
    assert.equal((await me('POST', `persons/suggestions/${s.id}`, { action: 'sometime' })).status, 400);
    // Kim is Lena — until Lena takes her consent back (the server no longer names the pairing)
    host.bridges.accounts = [{ contactId: KIM.id, userId: LENA.id, strength: 'strong', via: 'profile_phone' }];
    c.clock.add(11 * MIN);
    assert.equal((await me('GET', 'persons/suggestions')).json.suggestions.length, 1);
    host.bridges.accounts = [];
    c.clock.add(11 * MIN);
    assert.deepEqual((await me('GET', 'persons/suggestions')).json.suggestions, []);
  });
});

test('recognition: asked once at the link of WhatsApp — GET bridges recognition, PUT bridges/recognition', async () => {
  await withHost({ bridges: V9 }, async (host, c) => {
    await link(c, host);
    const me = as(c, ANNA);
    let b = (await me('GET', 'bridges')).json.bridges;
    assert.deepEqual(b.recognition, { available: true, network: 'whatsapp', asked: false, allowed: false });
    let r = await me('PUT', 'bridges/recognition', { allowed: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.recognition, { available: true, network: 'whatsapp', asked: true, allowed: true });
    assert.deepEqual(host.bridges.recognition(ANNA.id), { asked: true, allowed: true });
    r = await me('PUT', 'bridges/recognition', { allowed: false });
    assert.deepEqual([r.json.recognition.asked, r.json.recognition.allowed], [true, false]);
    assert.equal((await me('PUT', 'bridges/recognition', { allowed: 'ja' })).status, 400);
    b = (await me('GET', 'bridges')).json.bridges;
    assert.equal(b.recognition.asked, true);
  });
  // an older GateControl (gc.bridges version 8): no question, nothing to set
  await withHost({ bridges: { ...V9, version: 8 } }, async (host, c) => {
    await link(c, host);
    assert.equal((await as(c, ANNA)('GET', 'bridges')).json.bridges.recognition, null);
    assert.equal((await as(c, ANNA)('PUT', 'bridges/recognition', { allowed: true })).status, 403);
  });
});

test('an older GateControl (gc.bridges version 7): no suggestions, merging by hand still works', async () => {
  await withHost({ bridges: { ...V9, version: 7 } }, async (host, c) => {
    await setup(c, host);
    assert.deepEqual((await as(c, ANNA)('GET', 'persons/suggestions')).json.suggestions, []);
    const wa1 = convOf(await list(c), SCHATZ.name);
    const r = await as(c, ANNA)('POST', 'persons', { conversationIds: [wa1.id], userId: MARC.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.conversation.title, 'Marc', 'the account’s name by default');
  });
});
