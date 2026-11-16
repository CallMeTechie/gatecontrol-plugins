'use strict';

// 1.16.0: a new chat by number with a dialog in the apps and the portal — against the mock host's gc.bridges version 4.
//
//   line       GET bridges → networks[].newChat { available, reason, limit }; the feature word bridge_new_chat as soon
//              as a service is linked (not only with a chat)
//   limit      10 checks per person and hour (the admin sets 1–60 in the card „Brücken“); invalid numbers, a chat that
//              exists and a bridge that does not answer do not count; starting the chat of a number just found neither
//   existing   a chat started by number is found again (a keyed hash, never the number) — until the service is unlinked
//   children   a second switch of the parents per child (Familie's bridge_child_set newChat), off by default
//   states     logged out → 409 bridge_logged_out, not reachable → 503 bridge_unreachable

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, ANNA, MARC, LENA } = require('./helpers');

const V4 = { enabled: true, networks: { whatsapp: true }, running: true, version: 4 };
const B = { bridged: '1' };
const familie = () => ({ plugin: 'gatecontrol-familie', provides: ['family_roles'], service: () => ({ ok: true, parents: [ANNA.id, MARC.id], children: [LENA.id] }) });
const KIM = '+4915112345678';

async function link(c, host, user) {
  const me = c.as(user);
  assert.equal((await me('POST', 'bridges/whatsapp/consent', { accept: true })).status, 200);
  let r = await me('POST', 'bridges/whatsapp/login', { flow: 'qr' });
  host.bridges.confirm(r.json.login.processId);
  r = await me('POST', `bridges/whatsapp/login/${r.json.login.processId}/${r.json.login.step.id}`, {});
  assert.equal(r.json.login.step.type, 'complete');
  return r.json.login.step.loginId;
}
const newChatOf = async (c, user) => (await c.as(user)('GET', 'bridges')).json.bridges.networks[0].newChat;
const number = (i) => `+49151${String(10000000 + i)}`;

test('the line and the feature word: as soon as a service is linked — not before, not on a GateControl without lookups', async () => {
  await withHost({ bridges: V4 }, async (host, c) => {
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.bridge_new_chat, undefined, 'nothing linked yet');
    assert.deepEqual(await newChatOf(c, ANNA), { available: false, reason: 'unlinked', limit: { perHour: 10, left: 10, retryAfterS: 0 } });
    await link(c, host, ANNA);
    const f = (await c.as(ANNA)('GET', 'me')).json.features;
    assert.deepEqual([f.bridge_new_chat, f.bridge_chats], [true, undefined], 'the first chat can be one the person starts');
    assert.deepEqual(await newChatOf(c, ANNA), { available: true, reason: null, limit: { perHour: 10, left: 10, retryAfterS: 0 } });
    assert.equal((await c.as(MARC)('GET', 'me')).json.features.bridge_new_chat, undefined, 'only who linked');
  });
  await withHost({ bridges: { ...V4, version: 3 } }, async (host, c) => {
    await link(c, host, ANNA);
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.bridge_new_chat, undefined);
    assert.equal((await newChatOf(c, ANNA)).reason, 'off');
    assert.deepEqual([(await c.as(ANNA)('POST', 'bridges/whatsapp/resolve', { number: KIM })).json.code], ['feature_off']);
  });
});

test('the limit: 10 checks an hour, the time to wait; invalid numbers, chats that exist and a silent bridge do not count', async () => {
  await withHost({ bridges: V4 }, async (host, c) => {
    host.bridges.numbers.set(KIM, { name: 'Kim Muster' });
    const me = c.as(ANNA);
    await link(c, host, ANNA);
    // a chat started by number: found again without asking the service, also later
    let r = await me('POST', 'bridges/whatsapp/resolve', { number: '+49 151 1234 5678' });
    assert.deepEqual([r.json.found, r.json.name, r.json.existing], [true, 'Kim Muster', null]);
    r = await me('POST', 'bridges/whatsapp/chats', { number: KIM });
    const convId = r.json.conversation.id;
    assert.equal((await newChatOf(c, ANNA)).limit.left, 9, 'the check counted, starting the chat of that number not');
    for (let i = 0; i < 3; i++) {
      r = await me('POST', 'bridges/whatsapp/resolve', { number: '0049 151-12345678' });
      assert.deepEqual([r.json.found, r.json.name, r.json.existing], [true, 'Kim Muster', { conversationId: convId }]);
      assert.equal(r.json.avatarUrl, null);
    }
    r = await me('POST', 'bridges/whatsapp/chats', { number: KIM });
    assert.deepEqual([r.json.created, r.json.conversation.id], [false, convId]);
    // invalid numbers count neither (and reach nobody)
    for (const bad of ['0151 12345678', '+49 0151 12345678', '+12', 'Kim', '+49151123456789012']) {
      assert.deepEqual([(await me('POST', 'bridges/whatsapp/resolve', { number: bad })).json.code], ['invalid_number'], bad);
    }
    // a bridge that does not answer: 503, not counted
    host.bridges.setHost({ bridgeDown: true });
    r = await me('POST', 'bridges/whatsapp/resolve', { number: number(1) });
    assert.deepEqual([r.status, r.json.code], [503, 'bridge_unreachable']);
    assert.equal((await newChatOf(c, ANNA)).reason, 'unreachable');
    host.bridges.setHost({ bridgeDown: false });
    assert.deepEqual(await newChatOf(c, ANNA), { available: true, reason: null, limit: { perHour: 10, left: 9, retryAfterS: 0 } });
    assert.equal(host.bridges.state.log.filter((l) => l.op === 'resolve').length, 1, 'the service was asked once');

    // nine more numbers, then the limit — with the time to wait
    for (let i = 2; i <= 10; i++) assert.equal((await me('POST', 'bridges/whatsapp/resolve', { number: number(i) })).status, 200);
    r = await me('POST', 'bridges/whatsapp/resolve', { number: number(11) });
    assert.deepEqual([r.status, r.json.code], [429, 'rate_limited']);
    assert.ok(r.json.retryAfterS > 3500 && r.json.retryAfterS <= 3600, String(r.json.retryAfterS));
    assert.equal(r.json.perHour, 10, 'the limit is named');
    const nc = await newChatOf(c, ANNA);
    assert.deepEqual([nc.available, nc.limit.left, nc.limit.retryAfterS > 0], [true, 0, true]);
    // the chat that exists still opens, and an unknown number cannot be started instead of checked
    assert.equal((await me('POST', 'bridges/whatsapp/resolve', { number: KIM })).json.existing.conversationId, convId);
    assert.equal((await me('POST', 'bridges/whatsapp/chats', { number: number(12) })).json.code, 'rate_limited');
    // per person: Marc is not affected
    await link(c, host, MARC);
    assert.equal((await c.as(MARC)('POST', 'bridges/whatsapp/resolve', { number: number(1) })).status, 200);
    c.clock.add(61 * 60000);
    assert.equal((await me('POST', 'bridges/whatsapp/resolve', { number: number(11) })).status, 200);
    // the number is in no log and in no answer about the chat
    const all = JSON.stringify(host.bridges.state.log) + JSON.stringify((await c.admin('GET', 'log')).json) + JSON.stringify(host.logs || [])
      + JSON.stringify((await c.call(app(ANNA), 'GET', `conversations/${convId}`, null, B)).json);
    assert.doesNotMatch(all, /15112345678|15110000001/);
  });
});

test('the administrator sets the limit in the card „Brücken“ (1–60)', async () => {
  await withHost({ bridges: V4 }, async (host, c) => {
    let b = (await c.admin('GET', 'bridges')).json.bridges;
    assert.deepEqual(b.newChat, { available: true, perHour: 10, min: 1, max: 60 });
    for (const bad of [0, 61, 2.5, '5', null]) assert.equal((await c.admin('PUT', 'bridges', { newChatPerHour: bad })).json.code, 'invalid', String(bad));
    assert.equal((await c.admin('PUT', 'bridges', { newChatPerHour: 3, enabled: true })).json.code, 'invalid', 'one thing at a time');
    b = (await c.admin('PUT', 'bridges', { newChatPerHour: 2 })).json.bridges;
    assert.equal(b.newChat.perHour, 2);
    assert.equal((await c.as(ANNA)('PUT', 'admin/bridges', { newChatPerHour: 60 })).status, 403);
    await link(c, host, ANNA);
    const me = c.as(ANNA);
    assert.equal((await me('POST', 'bridges/whatsapp/resolve', { number: number(1) })).status, 200);
    assert.equal((await me('POST', 'bridges/whatsapp/resolve', { number: number(2) })).status, 200);
    assert.equal((await me('POST', 'bridges/whatsapp/resolve', { number: number(3) })).json.code, 'rate_limited');
    assert.deepEqual((await newChatOf(c, ANNA)).limit.perHour, 2);
  });
});

test('children: a second switch of the parents, off by default — the line is gone, answers in chats stay', async () => {
  await withHost({ bridges: V4, services: [familie()] }, async (host, c) => {
    host.bridges.numbers.set(KIM, { name: 'Kim Muster' });
    const svc = (name, user, payload) => host.callService(name, { caller: 'gatecontrol-familie', user, payload: payload || {} });
    const lena = c.as(LENA);
    assert.deepEqual((await newChatOf(c, LENA)).reason, 'unlinked');
    let r = await svc('bridge_children', { id: ANNA.id });
    assert.equal(r.newChat, true, 'this GateControl can look numbers up: Familie shows the switch');
    assert.deepEqual(r.children[0].newChat, { whatsapp: false });
    // not without the permission itself
    assert.deepEqual(await svc('bridge_child_set', { id: ANNA.id }, { childId: LENA.id, newChat: { whatsapp: true } }), { ok: false, code: 'invalid' });
    for (const bad of [{ childId: LENA.id, newChat: { whatsapp: 'yes' } }, { childId: LENA.id, newChat: [] }, { childId: LENA.id, newChat: { telegram: true } }]) {
      assert.deepEqual(await svc('bridge_child_set', { id: ANNA.id }, bad), { ok: false, code: 'invalid' }, JSON.stringify(bad));
    }
    r = await svc('bridge_child_set', { id: ANNA.id }, { childId: LENA.id, networks: { whatsapp: true } });
    assert.deepEqual(r.child.newChat, { whatsapp: false }, 'linking allowed, new chats by number still off');
    await link(c, host, LENA);
    assert.equal((await lena('GET', 'me')).json.features.bridge_new_chat, true);
    assert.deepEqual(await newChatOf(c, LENA), { available: false, reason: 'child_new_chat_off', limit: { perHour: 10, left: 10, retryAfterS: 0 } });
    r = await lena('POST', 'bridges/whatsapp/resolve', { number: KIM });
    assert.deepEqual([r.status, r.json.code], [403, 'child_new_chat_off']);
    assert.equal((await lena('POST', 'bridges/whatsapp/chats', { number: KIM })).json.code, 'child_new_chat_off');
    // the other parent allows it
    r = await svc('bridge_child_set', { id: MARC.id }, { childId: LENA.id, newChat: { whatsapp: true } });
    assert.deepEqual(r.child, { userId: LENA.id, networks: { whatsapp: true }, linked: { whatsapp: true }, newChat: { whatsapp: true } });
    assert.equal((await newChatOf(c, LENA)).available, true);
    r = await lena('POST', 'bridges/whatsapp/chats', { number: KIM });
    assert.equal(r.json.created, true);
    const convId = r.json.conversation.id;
    // and takes it back: no new chats, the chat stays and takes answers
    await svc('bridge_child_set', { id: ANNA.id }, { childId: LENA.id, newChat: { whatsapp: false } });
    assert.equal((await lena('POST', 'bridges/whatsapp/resolve', { number: KIM })).json.code, 'child_new_chat_off');
    r = await c.call(app(LENA), 'POST', `conversations/${convId}/messages`, { clientId: c.cid(), kind: 'text', text: 'Hallo!' }, B);
    assert.equal(r.json.message.status, 'sent');
    // WhatsApp taken back as a whole: the second switch goes with it, a new permission starts without it
    await host.bridges.acting(MARC.id, () => svc('bridge_child_set', { id: MARC.id }, { childId: LENA.id, newChat: { whatsapp: true } }));
    await host.bridges.acting(MARC.id, () => svc('bridge_child_set', { id: MARC.id }, { childId: LENA.id, networks: { whatsapp: false } }));
    r = await svc('bridge_child_set', { id: ANNA.id }, { childId: LENA.id, networks: { whatsapp: true } });
    assert.deepEqual(r.child.newChat, { whatsapp: false });
    // the parents' route of the app takes the same
    r = await c.as(ANNA)('PUT', `bridges/children/${LENA.id}`, { newChat: { whatsapp: true } });
    assert.deepEqual(r.json.child.newChat, { whatsapp: true });
  });
});

test('signed out at the service, unlinked: the states of the dialog — and the chat is no longer found by its number', async () => {
  await withHost({ bridges: V4 }, async (host, c) => {
    host.bridges.numbers.set(KIM, { name: 'Kim Muster' });
    const me = c.as(ANNA);
    const loginId = await link(c, host, ANNA);
    const conv = (await me('POST', 'bridges/whatsapp/chats', { number: KIM })).json.conversation;
    host.bridges.logOut(ANNA.id, loginId);
    assert.deepEqual((await newChatOf(c, ANNA)).reason, 'logged_out');
    let r = await me('POST', 'bridges/whatsapp/resolve', { number: KIM });
    assert.deepEqual([r.status, r.json.code, r.json.reason], [409, 'bridge_logged_out', 'logged_out']);
    // unlinked: the line is gone; linked again, the number is a new question
    assert.equal((await me('DELETE', `bridges/whatsapp/logins/${loginId}`)).status, 200);
    assert.deepEqual((await newChatOf(c, ANNA)).reason, 'unlinked');
    r = await me('POST', 'bridges/whatsapp/resolve', { number: KIM });
    assert.deepEqual([r.status, r.json.code, r.json.reason], [409, 'bridge_unlinked', 'unlinked']);
    await link(c, host, ANNA);
    r = await me('POST', 'bridges/whatsapp/resolve', { number: KIM });
    assert.deepEqual([r.json.found, r.json.existing], [true, null], 'the keyed hash went with the link');
    assert.ok(conv.id);
  });
});
