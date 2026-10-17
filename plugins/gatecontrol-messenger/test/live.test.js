'use strict';

// Read receipts (last_read_id, the preference honoured both ways), delivered marks,
// unread counts, "typing …" (throttle 3 s, valid 6 s, preference both ways) and the
// realtime events of every change — only ever to the members.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, OMA, SEC } = require('./helpers');

test('read: unread count, read mark, events to one\'s own devices and to the others; never back', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const m1 = await c.send(ANNA, d.id, { text: 'eins' });
    const m2 = await c.send(ANNA, d.id, { text: 'zwei' });
    const marc = c.as(MARC);
    assert.equal((await marc('GET', `conversations/${d.id}`)).json.conversation.unread, 2);
    c.resetEvents();
    let r = await marc('POST', `conversations/${d.id}/read`, { upTo: m1.id });
    assert.deepEqual(r.json, { ok: true, lastReadId: m1.id, unread: 1 });
    const evs = c.events('read');
    assert.deepEqual(evs.find((e) => e.users[0] === MARC.id).data, { conversationId: d.id, userId: MARC.id, lastDeliveredId: m1.id, lastReadId: m1.id, self: true, unread: 1 });
    assert.deepEqual(evs.find((e) => e.users[0] === ANNA.id).data, { conversationId: d.id, userId: MARC.id, lastDeliveredId: m1.id, lastReadId: m1.id });
    // Anna sees it: readUpTo and the status of her messages
    let forAnna = (await c.as(ANNA)('GET', `conversations/${d.id}/messages`)).json;
    assert.equal(forAnna.readUpTo, m1.id);
    assert.deepEqual(forAnna.messages.map((m) => m.status), ['read', 'sent'], 'm2 not fetched by Marc yet (GET conversations/:id does not count as delivered)');
    assert.deepEqual(forAnna.receipts, [{ userId: MARC.id, lastReadId: m1.id, lastDeliveredId: m1.id }]);
    // marks never move back; beyond the newest is clamped
    r = await marc('POST', `conversations/${d.id}/read`, { upTo: 1 });
    assert.equal(r.json.lastReadId, m1.id);
    r = await marc('POST', `conversations/${d.id}/read`, { upTo: 999999 });
    assert.deepEqual([r.json.lastReadId, r.json.unread], [m2.id, 0]);
    assert.equal((await marc('POST', `conversations/${d.id}/read`, {})).json.code, 'invalid');
    forAnna = (await c.as(ANNA)('GET', `conversations/${d.id}/messages`)).json;
    assert.deepEqual(forAnna.messages.map((m) => m.status), ['read', 'read']);
  });
});

test('delivered: when the other side\'s apps fetched the conversations or messages', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const m = await c.send(ANNA, d.id, { text: 'hallo' });
    assert.equal(m.status, 'sent');
    c.resetEvents();
    await c.as(MARC)('GET', 'conversations');
    const ev = c.events('read');
    assert.deepEqual(ev.map((e) => [e.users, e.data.lastDeliveredId, e.data.lastReadId]), [[[ANNA.id], m.id, 0]]);
    const forAnna = (await c.as(ANNA)('GET', `conversations/${d.id}`)).json.conversation;
    assert.equal(forAnna.deliveredUpTo, m.id);
    assert.equal(forAnna.lastMessage.status, 'delivered');
    c.resetEvents();
    await c.as(MARC)('GET', 'conversations');
    assert.equal(c.events('read').length, 0, 'no event when nothing moved');
  });
});

test('read receipts off: one sends none and sees none — both ways (like WhatsApp)', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const m = await c.send(ANNA, d.id, { text: 'Gelesen?' });
    await c.as(MARC)('PUT', 'prefs', { readReceipts: false });
    c.resetEvents();
    await c.as(MARC)('POST', `conversations/${d.id}/read`, { upTo: m.id });
    const toAnna = c.events('read').filter((e) => e.users.includes(ANNA.id));
    assert.equal(toAnna.length, 1);
    assert.equal(toAnna[0].data.lastReadId, null, 'Anna learns no read mark');
    assert.equal(toAnna[0].data.lastDeliveredId, m.id, 'delivered still');
    let forAnna = (await c.as(ANNA)('GET', `conversations/${d.id}`)).json.conversation;
    assert.deepEqual([forAnna.readUpTo, forAnna.receipts, forAnna.lastMessage.status], [null, [], 'delivered']);
    // the other way: Marc (off) does not see that Anna read his message
    const m2 = await c.send(MARC, d.id, { text: 'Antwort' });
    c.resetEvents();
    await c.as(ANNA)('POST', `conversations/${d.id}/read`, { upTo: m2.id });
    assert.equal(c.events('read').find((e) => e.users.includes(MARC.id)).data.lastReadId, null);
    const forMarc = (await c.as(MARC)('GET', `conversations/${d.id}/messages`)).json;
    assert.deepEqual([forMarc.readUpTo, forMarc.receipts], [null, []]);
    assert.equal(forMarc.messages.find((x) => x.id === m2.id).status, 'delivered');
    // back on: both see marks again
    await c.as(MARC)('PUT', 'prefs', { readReceipts: true });
    forAnna = (await c.as(ANNA)('GET', `conversations/${d.id}`)).json.conversation;
    assert.equal(forAnna.readUpTo, m2.id, 'Marc read up to his own reply');
    assert.equal((await c.as(MARC)('PUT', 'prefs', { readReceipts: 'yes' })).json.code, 'invalid');
  });
});

test('groups: readUpTo is the lowest read mark of the members who share receipts', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA]);
    const m = await c.send(ANNA, g.id, { text: 'Hallo alle' });
    await c.as(MARC)('POST', `conversations/${g.id}/read`, { upTo: m.id });
    let conv = (await c.as(ANNA)('GET', `conversations/${g.id}`)).json.conversation;
    assert.equal(conv.lastMessage.status, 'sent', 'Lena has not read (nor fetched) yet');
    assert.ok(conv.readUpTo < m.id);
    await c.as(LENA)('POST', `conversations/${g.id}/read`, { upTo: m.id });
    conv = (await c.as(ANNA)('GET', `conversations/${g.id}`)).json.conversation;
    assert.equal(conv.readUpTo, m.id);
    assert.equal(conv.lastMessage.status, 'read');
    assert.equal(conv.receipts.length, 2);
  });
});

test('sending reads everything before it (the sender\'s own devices learn it)', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    await c.send(ANNA, d.id, { text: 'Frage' });
    assert.equal((await c.as(MARC)('GET', `conversations/${d.id}`)).json.conversation.unread, 1);
    c.resetEvents();
    const reply = await c.send(MARC, d.id, { text: 'Antwort' });
    assert.equal((await c.as(MARC)('GET', `conversations/${d.id}`)).json.conversation.unread, 0);
    const self = c.events('read').find((e) => e.users.includes(MARC.id) && e.data.self);
    assert.deepEqual([self.data.lastReadId, self.data.unread], [reply.id, 0]);
  });
});

test('typing: at most every 3 s, valid 6 s, to the other members who show "typing"; stop; preference both ways', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA]);
    await c.as(LENA)('PUT', 'prefs', { typing: false });
    c.resetEvents();
    let r = await c.as(ANNA)('POST', `conversations/${g.id}/typing`, {});
    assert.equal(r.json.until, new Date(Date.now() + 6000).toISOString());
    assert.deepEqual(c.events('typing').map((e) => [e.users, e.data.userId]), [[[MARC.id], ANNA.id]], 'not to Lena (typing off), not to Anna herself');
    c.clock.add(2 * SEC);
    await c.as(ANNA)('POST', `conversations/${g.id}/typing`, {});
    assert.equal(c.events('typing').length, 1, 'throttled: within 3 s no second event');
    let forMarc = (await c.as(MARC)('GET', `conversations/${g.id}`)).json.conversation;
    assert.deepEqual(forMarc.typing, [ANNA.id]);
    assert.deepEqual((await c.as(LENA)('GET', `conversations/${g.id}`)).json.conversation.typing, [], 'Lena sees nobody typing');
    c.clock.add(5 * SEC);
    forMarc = (await c.as(MARC)('GET', `conversations/${g.id}`)).json.conversation;
    assert.deepEqual(forMarc.typing, [], 'valid 6 s');
    await c.as(ANNA)('POST', `conversations/${g.id}/typing`, {});
    c.resetEvents();
    await c.as(ANNA)('POST', `conversations/${g.id}/typing`, { stop: true });
    assert.deepEqual(c.events('typing').map((e) => e.data.until), [null]);
    // Lena (off) sends none
    c.resetEvents();
    r = await c.as(LENA)('POST', `conversations/${g.id}/typing`, {});
    assert.equal(r.json.until, null);
    assert.equal(c.events('typing').length, 0);
    // a sent message ends "typing"
    await c.as(MARC)('POST', `conversations/${g.id}/typing`, {});
    await c.send(MARC, g.id, { text: 'fertig' });
    assert.deepEqual((await c.as(ANNA)('GET', `conversations/${g.id}`)).json.conversation.typing, []);
  });
});

test('events: message.new / update / delete, reaction, conversation.update / remove reach the members only', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC]);
    c.resetEvents();
    const m = await c.send(ANNA, g.id, { text: 'Hi' });
    const nw = c.events('message.new');
    assert.deepEqual(nw.map((e) => [e.users.sort(), e.data]), [[[ANNA.id, MARC.id], { conversationId: g.id, messageId: m.id, senderId: ANNA.id, clientId: m.clientId, kind: 'text', createdAt: m.createdAt }]]);
    await c.as(MARC)('PUT', `messages/${m.id}/reaction`, { emoji: '👍' });
    await c.as(ANNA)('PATCH', `messages/${m.id}`, { text: 'Hi!' });
    await c.as(ANNA)('DELETE', `messages/${m.id}`, null, { for: 'all' });
    await c.as(ANNA)('PATCH', `conversations/${g.id}`, { title: 'Neu' });
    await c.as(ANNA)('PATCH', `conversations/${g.id}`, { remove: [MARC.id] });
    const types = c.events().map((e) => e.type);
    for (const t of ['message.new', 'reaction', 'message.update', 'message.delete', 'conversation.update', 'conversation.remove']) assert.ok(types.includes(t), t);
    for (const e of host.events) for (const u of e.users) assert.ok([ANNA.id, MARC.id].includes(u), `${e.type} → ${u}`);
    assert.ok(!host.events.some((e) => e.users.includes(LENA.id) || e.users.includes(OMA.id)));
    // every event is small (≤ 4 KB) and carries no message text
    for (const e of host.events) {
      assert.ok(Buffer.byteLength(JSON.stringify(e.data)) < 4096);
      assert.ok(!JSON.stringify(e.data).includes('Hi!'));
    }
  });
});

test('a failed request sends nothing; an events refusal of the host is logged, the request still works', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    c.resetEvents();
    const bad = await c.as(ANNA)('POST', `conversations/${d.id}/messages`, { clientId: c.cid(), kind: 'image', mediaId: 'f'.repeat(32) });
    assert.equal(bad.status, 409);
    assert.equal(c.events().length, 0);
    // emulate the host's rate limit: the mock throws ERR_RATE_LIMIT after 600 events a minute
    for (let i = 0; i < 600; i++) await host.gc.events.emit({ users: [ANNA.id], type: 'x', data: null });
    const ok = await c.as(ANNA)('POST', `conversations/${d.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'trotzdem' });
    assert.equal(ok.status, 200);
    const log = (await c.admin('GET', 'log')).json.entries;
    assert.ok(log.some((e) => e.code === 'events_rate_limit' && e.level === 'limit'));
  });
});
