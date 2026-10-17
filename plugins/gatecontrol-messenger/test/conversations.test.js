'use strict';

// Conversations: direct chats (one per pair), groups (admins, members, leaving),
// managed groups, the since-sync, and that a non-member never learns anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, portal, ADMIN, ANNA, MARC, LENA, OMA, MIN } = require('./helpers');

test('direct chat: one per pair, created once, shown to the other side only after the first message', async () => {
  await withHost({}, async (host, c) => {
    const a = await c.as(ANNA)('POST', 'conversations', { kind: 'direct', userIds: [MARC.id] });
    assert.equal(a.status, 200);
    assert.equal(a.json.created, true);
    const d = a.json.conversation;
    assert.equal(d.kind, 'direct');
    assert.equal(d.title, 'Marc');
    assert.equal(d.peer.userId, MARC.id);
    assert.deepEqual(d.members.map((m) => m.userId).sort(), [ANNA.id, MARC.id]);
    const again = await c.as(MARC)('POST', 'conversations', { kind: 'direct', userIds: [ANNA.id] });
    assert.equal(again.json.created, false);
    assert.equal(again.json.conversation.id, d.id, 'the same chat from the other side');
    assert.equal(again.json.conversation.title, 'Anna');
    // Marc opened it too now (he called POST) — but Lena's view: a chat Anna opens with Lena stays hidden for Lena until a message
    const l = await c.direct(ANNA, LENA);
    assert.equal((await c.as(LENA)('GET', 'conversations')).json.conversations.length, 0);
    await c.send(ANNA, l.id, { text: 'Hi Lena' });
    const list = (await c.as(LENA)('GET', 'conversations')).json.conversations;
    assert.deepEqual(list.map((x) => x.id), [l.id]);
    assert.equal(list[0].unread, 1);
    assert.equal(list[0].lastMessage.text, 'Hi Lena');
    // invalid: oneself only, two people, unknown account, a title
    for (const body of [{ kind: 'direct', userIds: [ANNA.id] }, { kind: 'direct', userIds: [MARC.id, LENA.id] }, { kind: 'direct', userIds: [99] }, { kind: 'direct', userIds: [MARC.id], title: 'x' }, { kind: 'nope', userIds: [MARC.id] }]) {
      const r = await c.as(ANNA)('POST', 'conversations', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.code, 'invalid');
    }
  });
});

test('group: creator is admin, system message "created", members see it; title required', async () => {
  await withHost({}, async (host, c) => {
    const r = await c.as(ANNA)('POST', 'conversations', { kind: 'group', userIds: [MARC.id, LENA.id], title: '  Wochenende  ' });
    assert.equal(r.status, 200);
    const g = r.json.conversation;
    assert.equal(g.title, 'Wochenende');
    assert.equal(g.me.role, 'admin');
    assert.deepEqual(g.can, { send: true, editInfo: true, manageMembers: true, leave: true, setDisappearing: true });
    assert.equal(g.lastMessage.kind, 'system');
    assert.deepEqual(g.lastMessage.system, { event: 'created', by: ANNA.id, title: 'Wochenende' });
    const forMarc = (await c.as(MARC)('GET', `conversations/${g.id}`)).json.conversation;
    assert.equal(forMarc.me.role, 'member');
    assert.equal(forMarc.can.manageMembers, false);
    assert.equal(forMarc.unread, 0, 'system messages are not unread');
    assert.ok(c.events('conversation.update').some((e) => e.data.conversationId === g.id && e.data.reason === 'created' && e.users.includes(LENA.id)));
    assert.equal((await c.as(ANNA)('POST', 'conversations', { kind: 'group', userIds: [MARC.id] })).json.code, 'invalid');
    assert.equal((await c.as(ANNA)('POST', 'conversations', { kind: 'group', userIds: [], title: 'x' })).json.code, 'invalid');
    assert.equal((await c.as(ANNA)('POST', 'conversations', { kind: 'group', userIds: [MARC.id], title: 'x'.repeat(81) })).json.code, 'invalid');
  });
});

test('group changes: title by anyone, members and roles by admins, leaving, last admin hands over', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA]);
    const marc = c.as(MARC);
    // a member renames
    let r = await marc('PATCH', `conversations/${g.id}`, { title: 'Familie Müller' });
    assert.equal(r.status, 200);
    assert.equal(r.json.conversation.title, 'Familie Müller');
    // a member cannot add, remove others or change roles
    assert.equal((await marc('PATCH', `conversations/${g.id}`, { add: [OMA.id] })).json.code, 'not_admin');
    assert.equal((await marc('PATCH', `conversations/${g.id}`, { remove: [LENA.id] })).json.code, 'not_admin');
    assert.equal((await marc('PATCH', `conversations/${g.id}`, { role: { userId: MARC.id, role: 'admin' } })).json.code, 'not_admin');
    // the admin adds Oma: she sees the chat from now on, not the history before
    await c.send(ANNA, g.id, { text: 'vor Oma' });
    c.resetEvents();
    r = await c.as(ANNA)('PATCH', `conversations/${g.id}`, { add: [OMA.id] });
    assert.equal(r.json.conversation.members.length, 4);
    assert.ok(c.events('conversation.update').some((e) => e.users.includes(OMA.id)));
    const omaMsgs = (await c.as(OMA)('GET', `conversations/${g.id}/messages`)).json.messages;
    assert.ok(!omaMsgs.some((m) => m.text === 'vor Oma'), 'no history before joining');
    assert.deepEqual(omaMsgs.map((m) => m.system && m.system.event), ['member_added']);
    // make Marc admin, then remove Lena as Marc
    r = await c.as(ANNA)('PATCH', `conversations/${g.id}`, { role: { userId: MARC.id, role: 'admin' } });
    assert.equal(r.json.conversation.members.find((m) => m.userId === MARC.id).role, 'admin');
    c.resetEvents();
    r = await marc('PATCH', `conversations/${g.id}`, { remove: [LENA.id] });
    assert.equal(r.status, 200);
    assert.deepEqual(c.events('conversation.remove').map((e) => e.users), [[LENA.id]]);
    assert.equal((await c.as(LENA)('GET', `conversations/${g.id}`)).status, 404, 'a removed member sees nothing');
    // Anna and Marc leave → Oma (joined first among the rest) becomes admin
    r = await c.as(ANNA)('PATCH', `conversations/${g.id}`, { remove: [ANNA.id] });
    assert.equal(r.json.left, true);
    assert.equal(r.json.conversation, null);
    // the last admin cannot demote himself
    assert.equal((await marc('PATCH', `conversations/${g.id}`, { role: { userId: MARC.id, role: 'member' } })).json.code, 'invalid');
    await marc('PATCH', `conversations/${g.id}`, { remove: [MARC.id] });
    const forOma = (await c.as(OMA)('GET', `conversations/${g.id}`)).json.conversation;
    assert.equal(forOma.me.role, 'admin', 'someone is always admin');
    const sys = (await c.as(OMA)('GET', `conversations/${g.id}/messages`)).json.messages.map((m) => m.system && m.system.event);
    assert.deepEqual(sys, ['member_added', 'member_removed', 'member_left', 'member_left']);
  });
});

test('direct chats: no title, members or roles; disappearing allowed; mute and notify are personal', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    for (const body of [{ title: 'x' }, { add: [LENA.id] }, { remove: [MARC.id] }, { role: { userId: MARC.id, role: 'admin' } }]) {
      assert.equal((await c.as(ANNA)('PATCH', `conversations/${d.id}`, body)).json.code, 'invalid', JSON.stringify(body));
    }
    let r = await c.as(ANNA)('PATCH', `conversations/${d.id}`, { disappearingS: 86400 });
    assert.equal(r.json.conversation.disappearingS, 86400);
    assert.equal((await c.as(ANNA)('PATCH', `conversations/${d.id}`, { disappearingS: 1234 })).json.code, 'invalid');
    const until = new Date(Date.now() + 8 * 3600000).toISOString();
    r = await c.as(ANNA)('PATCH', `conversations/${d.id}`, { mutedUntil: until });
    assert.equal(r.json.conversation.muted, true);
    assert.equal(r.json.conversation.me.mutedUntil, until);
    assert.equal((await c.as(MARC)('GET', `conversations/${d.id}`)).json.conversation.muted, false, 'muting is personal');
    r = await c.as(ANNA)('PATCH', `conversations/${d.id}`, { mutedUntil: null, notify: 'none' });
    assert.equal(r.json.conversation.muted, true);
    assert.equal(r.json.conversation.me.notify, 'none');
    assert.equal((await c.as(ANNA)('PATCH', `conversations/${d.id}`, { notify: 'some' })).json.code, 'invalid');
    assert.equal((await c.as(ANNA)('PATCH', `conversations/${d.id}`, { mutedUntil: 'tomorrow' })).json.code, 'invalid');
  });
});

test('since-sync: only changed conversations, removed ones listed, serverTime', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    await c.send(ANNA, d.id, { text: 'eins' });
    const g = await c.group(ANNA, [MARC]);
    const first = (await c.as(MARC)('GET', 'conversations')).json;
    assert.equal(first.conversations.length, 2);
    assert.deepEqual(first.removed, []);
    c.clock.add(MIN);
    assert.equal((await c.as(MARC)('GET', 'conversations', null, { since: first.serverTime })).json.conversations.length, 0);
    await c.send(ANNA, d.id, { text: 'zwei' });
    await c.as(ANNA)('PATCH', `conversations/${g.id}`, { remove: [MARC.id] });
    const next = (await c.as(MARC)('GET', 'conversations', null, { since: first.serverTime })).json;
    assert.deepEqual(next.conversations.map((x) => x.id), [d.id]);
    assert.equal(next.conversations[0].lastMessage.text, 'zwei');
    assert.deepEqual(next.removed, [g.id]);
    assert.equal((await c.as(MARC)('GET', 'conversations', null, { since: 'yesterday' })).json.code, 'invalid');
  });
});

test('non-members: every route answers 404 — reading, sending, changing, reacting, reading marks, typing, search, media', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const m = await c.send(ANNA, d.id, { text: 'privat' });
    const oma = c.as(OMA);
    const routes = [
      ['GET', `conversations/${d.id}`], ['PATCH', `conversations/${d.id}`, { title: 'x' }], ['GET', `conversations/${d.id}/messages`],
      ['POST', `conversations/${d.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'ich auch' }], ['POST', `conversations/${d.id}/read`, { upTo: m.id }],
      ['POST', `conversations/${d.id}/typing`, {}], ['POST', `conversations/${d.id}/active`, {}], ['GET', `conversations/${d.id}/search`, null, { q: 'privat' }],
      ['GET', `conversations/${d.id}/media`], ['PATCH', `messages/${m.id}`, { text: 'x' }], ['DELETE', `messages/${m.id}`, null, { for: 'me' }],
      ['PUT', `messages/${m.id}/reaction`, { emoji: '👍' }], ['GET', 'conversations/999'], ['GET', 'conversations/abc'],
    ];
    for (const [method, p, body, query] of routes) {
      const r = await oma(method, p, body, query);
      assert.equal(r.status, 404, `${method} ${p}`);
      assert.equal(r.json.code, 'not_found');
    }
    assert.equal((await oma('GET', 'conversations')).json.conversations.length, 0);
    assert.ok(!host.events.some((e) => e.users.includes(OMA.id)), 'no event ever went to a non-member');
    assert.ok(!c.pushes().some((n) => n.users.includes(OMA.id)), 'no push either');
  });
});

test('who may chat: app users and signed-in portal viewers — not the admin UI, not device trust, not kiosk devices', async () => {
  await withHost({}, async (host, c) => {
    assert.equal((await c.call(ANNA, 'GET', 'me')).json.code, 'forbidden', 'admin UI request (no portal/app flag)');
    assert.equal((await c.call(ADMIN, 'GET', 'conversations')).json.code, 'forbidden');
    assert.equal((await c.call(portal(ANNA, false), 'GET', 'me')).json.code, 'login_required');
    assert.equal((await c.call({ ...ANNA, portal: true, loggedIn: true, kiosk: true }, 'GET', 'me')).json.code, 'forbidden');
    assert.equal((await c.call(app({ id: 77, name: 'ghost', role: 'user' }), 'GET', 'me')).json.code, 'forbidden', 'an account that is not enabled');
    assert.equal((await c.call(portal(ANNA), 'GET', 'me')).status, 200);
    assert.equal((await c.call(app(ADMIN), 'GET', 'me')).status, 200, 'administrators chat like everyone (as themselves)');
    assert.equal((await c.call(app(ANNA), 'GET', 'nope')).status, 404);
    // the visibility hooks
    assert.equal(await host.portalVisible(portal(ANNA)), true);
    assert.equal(await host.portalVisible({ ...ANNA, kiosk: true, loggedIn: true }), false);
    assert.equal(await host.portalVisible(portal(ANNA), 'section'), false);
    assert.equal(await host.appVisible(ANNA), true);
  });
});

test('people: every enabled account but oneself; accounts seen on a kiosk device are left out', async () => {
  await withHost({ users: [ADMIN, ANNA, MARC, LENA, OMA, { id: 6, name: 'Küche', role: 'user' }, { id: 7, name: 'Alt', role: 'user', disabled: true }] }, async (host, c) => {
    let ppl = (await c.as(ANNA)('GET', 'people')).json.people;
    assert.deepEqual(ppl.map((p) => p.name), ['admin', 'Küche', 'Lena', 'Marc', 'Oma']);
    assert.deepEqual(Object.keys(ppl[0]).sort(), ['avatarUrl', 'color', 'colorHex', 'id', 'initials', 'name']);
    await c.call({ id: 6, name: 'Küche', role: 'user', portal: true, loggedIn: true, kiosk: true }, 'GET', 'me');
    ppl = (await c.as(ANNA)('GET', 'people')).json.people;
    assert.ok(!ppl.some((p) => p.id === 6), 'the wall tablet account is no person to chat with');
    assert.ok(!ppl.some((p) => p.id === 7), 'disabled accounts are not listed');
    assert.equal((await c.as(ANNA)('POST', 'conversations', { kind: 'direct', userIds: [7] })).json.code, 'invalid');
  });
});

test('deleted account: the chat stays ("Gelöschtes Konto"), sending is refused', async () => {
  const users = [ADMIN, ANNA, MARC, LENA, OMA];
  await withHost({ users }, async (host, c) => {
    const d = await c.direct(ANNA, LENA);
    await c.send(ANNA, d.id, { text: 'hallo' });
    // Lena's account is disabled in GateControl: gc.users no longer lists it (emulated at the users cache)
    const people = require('../server/people');
    people.reset();
    const map = new Map((await host.gc.users.list()).filter((u) => u.id !== LENA.id).map((u) => [u.id, u]));
    const users2 = people.users;
    people.users = async () => map;
    try {
      const conv = (await c.as(ANNA)('GET', `conversations/${d.id}`)).json.conversation;
      assert.equal(conv.peer.gone, true);
      assert.equal(conv.title, null);
      assert.equal(conv.can.send, false);
      const r = await c.as(ANNA)('POST', `conversations/${d.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'noch da?' });
      assert.equal(r.status, 409);
      assert.equal(r.json.code, 'peer_unavailable');
    } finally {
      people.users = users2;
      people.reset();
    }
  });
});
