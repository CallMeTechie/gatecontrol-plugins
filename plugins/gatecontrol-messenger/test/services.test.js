'use strict';

// Services for Familie: sync_group (a managed group "Familie" whose members only the
// calling plugin changes) and send_message (a system message from "GateControl").

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, ANNA, MARC, LENA, OMA, SEC, PNG } = require('./helpers');

const FAM = 'gatecontrol-familie';

test('sync_group: creates the managed group, keeps title and members in step, members cannot change it', async () => {
  await withHost({}, async (host, c) => {
    let r = await host.callService('sync_group', { caller: FAM, payload: { key: 'family', title: 'Familie', userIds: [ANNA.id, MARC.id, LENA.id, 99] } });
    assert.equal(r.ok, true);
    assert.equal(r.created, true);
    assert.deepEqual(r.added.sort(), [ANNA.id, MARC.id, LENA.id]);
    assert.deepEqual(r.ignored, [99], 'unknown or disabled accounts are ignored');
    const id = r.conversationId;
    const conv = (await c.as(ANNA)('GET', `conversations/${id}`)).json.conversation;
    assert.deepEqual([conv.title, conv.managedBy, conv.readonly, conv.me.role], ['Familie', FAM, false, 'member']);
    assert.deepEqual(conv.can, { send: true, pin: false, editInfo: false, manageMembers: false, leave: false, setDisappearing: true });
    for (const body of [{ title: 'x' }, { add: [OMA.id] }, { remove: [ANNA.id] }, { remove: [MARC.id] }, { avatarMediaId: null }]) {
      assert.equal((await c.as(ANNA)('PATCH', `conversations/${id}`, body)).json.code, 'managed', JSON.stringify(body));
    }
    assert.equal((await c.as(ANNA)('PATCH', `conversations/${id}`, { notify: 'none' })).status, 200, 'mute works');
    await c.send(ANNA, id, { text: 'Hallo Familie' });
    // the next sync: Lena out, Oma in, a new title; the same group
    c.resetEvents();
    r = await host.callService('sync_group', { caller: FAM, payload: { key: 'family', title: 'Familie Müller', userIds: [ANNA.id, MARC.id, OMA.id] } });
    assert.deepEqual([r.conversationId, r.created, r.added, r.removed], [id, false, [OMA.id], [LENA.id]]);
    assert.deepEqual(c.events('conversation.remove').map((e) => e.users), [[LENA.id]]);
    assert.equal((await c.as(LENA)('GET', `conversations/${id}`)).status, 404);
    const msgs = (await c.as(OMA)('GET', `conversations/${id}/messages`)).json.messages;
    assert.ok(!msgs.some((m) => m.text === 'Hallo Familie'), 'Oma sees the group from joining on');
    assert.deepEqual(msgs.map((m) => m.system && m.system.event), ['member_added', 'member_removed']);
    assert.equal((await c.as(OMA)('GET', `conversations/${id}`)).json.conversation.title, 'Familie Müller');
    // another plugin's key is another group; bad payloads
    const other = await host.callService('sync_group', { caller: 'gatecontrol-other', payload: { key: 'family', title: 'X', userIds: [ANNA.id] } });
    assert.notEqual(other.conversationId, id);
    for (const payload of [{ key: 'Family', title: 'x', userIds: [] }, { key: 'family', title: '', userIds: [] }, { key: 'family', title: 'x', userIds: 'all' }, { key: 'family', title: 'x', userIds: [-1] }]) {
      assert.deepEqual(await host.callService('sync_group', { caller: FAM, payload }), { ok: false, code: 'invalid' }, JSON.stringify(payload));
    }
    assert.ok((await c.admin('GET', 'log')).json.entries.some((e) => e.code === 'service_refused' && e.detail === 'sync_group: invalid'));
  });
});

test('send_message family: a system message from "GateControl" to the managed group, pushed to everyone', async () => {
  await withHost({}, async (host, c) => {
    assert.deepEqual(await host.callService('send_message', { caller: FAM, payload: { conversation: 'family', text: 'x' } }), { ok: false, code: 'not_found' }, 'no group yet');
    const g = await host.callService('sync_group', { caller: FAM, payload: { key: 'family', title: 'Familie', userIds: [ANNA.id, MARC.id] } });
    c.resetEvents();
    const r = await host.callService('send_message', { caller: FAM, user: { id: ANNA.id, name: 'Anna', role: 'user' }, payload: { conversation: 'family', text: 'Tim ist zu Hause angekommen' } });
    assert.deepEqual(Object.keys(r).sort(), ['conversationId', 'messageId', 'ok']);
    assert.equal(r.conversationId, g.conversationId);
    const m = (await c.as(MARC)('GET', `conversations/${g.conversationId}/messages`)).json.messages.pop();
    assert.deepEqual([m.kind, m.senderId, m.via, m.text, m.system], ['system', null, FAM, 'Tim ist zu Hause angekommen', { event: 'notice' }]);
    assert.equal((await c.as(MARC)('GET', `conversations/${g.conversationId}`)).json.conversation.unread, 1, 'a notice counts as unread');
    const p = c.pushes().pop();
    assert.deepEqual(p.users.sort(), [ANNA.id, MARC.id], 'everyone, there is no sender');
    assert.deepEqual([p.title, p.body, p.data.sender], ['GateControl', 'Tim ist zu Hause angekommen', { id: 'gatecontrol', name: 'GateControl', avatarUrl: null }]);
    assert.ok(c.events('message.new').some((e) => e.data.messageId === r.messageId));
    assert.deepEqual(await host.callService('send_message', { caller: FAM, payload: { conversation: 'family', text: '' } }), { ok: false, code: 'invalid' });
    assert.deepEqual(await host.callService('send_message', { caller: FAM, payload: { conversation: 'family', text: 'x'.repeat(4001) } }), { ok: false, code: 'invalid' });
  });
});

test('send_message user:<id>: the caller\'s notice channel for that person (read-only for them)', async () => {
  await withHost({}, async (host, c) => {
    const r = await host.callService('send_message', { caller: FAM, payload: { conversation: `user:${LENA.id}`, text: 'Denk an den Turnbeutel', title: 'Familie' } });
    assert.equal(r.ok, true);
    const conv = (await c.as(LENA)('GET', `conversations/${r.conversationId}`)).json.conversation;
    assert.deepEqual([conv.title, conv.readonly, conv.managedBy, conv.members.map((m) => m.userId), conv.can.send], ['Familie', true, FAM, [LENA.id], false]);
    const send = await c.as(LENA)('POST', `conversations/${r.conversationId}/messages`, { clientId: c.cid(), kind: 'text', text: 'ok' });
    assert.equal(send.json.code, 'readonly');
    const p = c.pushes().pop();
    assert.deepEqual(p.users, [LENA.id]);
    assert.deepEqual(p.data.actions.map((a) => a.type), ['mark_read'], 'no reply field for a read-only channel');
    const r2 = await host.callService('send_message', { caller: FAM, payload: { conversation: `user:${LENA.id}`, text: 'Noch was', title: 'Familie' } });
    assert.equal(r2.conversationId, r.conversationId, 'one channel per person and plugin');
    assert.equal((await c.as(MARC)('GET', `conversations/${r.conversationId}`)).status, 404, 'nobody else sees it');
    assert.deepEqual(await host.callService('send_message', { caller: FAM, payload: { conversation: 'user:99', text: 'x' } }), { ok: false, code: 'invalid' });
  });
});

test('1.9.1: Familie\'s notice channels still called „Familie“ / „Family“ are renamed once at start, nothing else', async () => {
  await withHost({}, async (host, c) => {
    const familie = require('../server/familie');
    const titleOf = async (u, id) => (await c.as(u)('GET', `conversations/${id}`)).json.conversation.title;
    const lena = (await host.callService('send_message', { caller: FAM, payload: { conversation: `user:${LENA.id}`, text: 'a', title: 'Familie' } })).conversationId;
    const oma = (await host.callService('send_message', { caller: FAM, payload: { conversation: `user:${OMA.id}`, text: 'b', title: 'Family' } })).conversationId;
    const own = (await host.callService('send_message', { caller: FAM, payload: { conversation: `user:${MARC.id}`, text: 'c', title: 'Familie-Hinweise' } })).conversationId;
    const door = (await host.callService('send_message', { caller: 'gatecontrol-door', payload: { conversation: `user:${LENA.id}`, text: 'd', title: 'Familie' } })).conversationId;
    const group = (await host.callService('sync_group', { caller: FAM, payload: { key: 'family', title: 'Familie', userIds: [ANNA.id, LENA.id] } })).conversationId;
    assert.equal(await familie.renameNoticeChannels(host.gc), 2);
    assert.equal(await titleOf(LENA, lena), 'Familie-Hinweise');
    assert.equal(await titleOf(OMA, oma), 'Family notices');
    assert.equal(await titleOf(MARC, own), 'Familie-Hinweise');
    assert.equal(await titleOf(LENA, door), 'Familie', 'another plugin\'s channel keeps its name');
    assert.equal(await titleOf(ANNA, group), 'Familie', 'the family group keeps its name');
    assert.equal(await familie.renameNoticeChannels(host.gc), 0, 'once');
  });
});

test('send_message group:<id>: groups the caller manages, or groups the calling person is a member of', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC], 'Eltern');
    const asAnna = { id: ANNA.id, name: 'Anna', role: 'user' };
    let r = await host.callService('send_message', { caller: FAM, user: asAnna, payload: { conversation: `group:${g.id}`, text: 'Abholen 16 Uhr' } });
    assert.equal(r.ok, true);
    r = await host.callService('send_message', { caller: FAM, user: { id: LENA.id, name: 'Lena', role: 'user' }, payload: { conversation: `group:${g.id}`, text: 'x' } });
    assert.deepEqual(r, { ok: false, code: 'forbidden' }, 'Lena is not in that group');
    r = await host.callService('send_message', { caller: FAM, payload: { conversation: `group:${g.id}`, text: 'x' } });
    assert.deepEqual(r, { ok: false, code: 'forbidden' }, 'no person, not managed by the caller');
    const d = await c.direct(ANNA, MARC);
    r = await host.callService('send_message', { caller: FAM, user: asAnna, payload: { conversation: `group:${d.id}`, text: 'x' } });
    assert.deepEqual(r, { ok: false, code: 'not_found' }, 'a direct chat is no group');
    assert.deepEqual(await host.callService('send_message', { caller: FAM, payload: { conversation: 'everyone', text: 'x' } }), { ok: false, code: 'invalid' });
    await assert.rejects(host.callService('nope', { caller: FAM, payload: {} }), /not in services.provides/);
  });
});

test('send_message (1.1.0): several targets in one call — one message per target, the outcome of each', async () => {
  await withHost({}, async (host, c) => {
    const g = await host.callService('sync_group', { caller: FAM, payload: { key: 'family', title: 'Familie', userIds: [ANNA.id, MARC.id] } });
    const before = c.pushes().length;
    c.resetEvents();
    const r = await host.callService('send_message', { caller: FAM, payload: { conversation: [`user:${LENA.id}`, `user:${OMA.id}`, 'family', 'user:99', `user:${LENA.id}`, 'everyone'], text: 'Abendessen um 18 Uhr', title: 'Familie' } });
    assert.equal(r.ok, true);
    assert.deepEqual([r.sent, r.failed], [3, 2]);
    assert.deepEqual(r.results.map((x) => [x.conversation, x.ok, x.code || null]), [
      [`user:${LENA.id}`, true, null], [`user:${OMA.id}`, true, null], ['family', true, null], ['user:99', false, 'invalid'], ['everyone', false, 'invalid'],
    ], 'in the given order, duplicates dropped');
    assert.equal(r.results[2].conversationId, g.conversationId);
    for (const [u, x] of [[LENA, r.results[0]], [OMA, r.results[1]]]) {
      const conv = (await c.as(u)('GET', `conversations/${x.conversationId}`)).json.conversation;
      assert.deepEqual([conv.title, conv.readonly, conv.lastMessage.id, conv.lastMessage.text, conv.lastMessage.via], ['Familie', true, x.messageId, 'Abendessen um 18 Uhr', FAM], u.name);
    }
    assert.equal(c.pushes().length - before, 3, 'one push per target');
    assert.equal(c.events('message.new').length, 3);
    assert.ok((await c.admin('GET', 'log')).json.entries.some((e) => e.code === 'service_refused' && e.detail === 'send_message: invalid'));
    // the person of the call counts per target (group:<id>)
    const eltern = await c.group(ANNA, [MARC], 'Eltern');
    const r2 = await host.callService('send_message', { caller: FAM, user: { id: LENA.id, name: 'Lena', role: 'user' }, payload: { conversation: [`group:${eltern.id}`, `user:${MARC.id}`], text: 'x' } });
    assert.deepEqual(r2.results.map((x) => [x.ok, x.code || null]), [[false, 'forbidden'], [true, null]]);
    // nothing usable: refused as a whole
    for (const conversation of [[], Array.from({ length: 21 }, (_, i) => `user:${i + 1}`), ['family', 3], [{ a: 1 }]]) {
      assert.deepEqual(await host.callService('send_message', { caller: FAM, payload: { conversation, text: 'x' } }), { ok: false, code: 'invalid' }, JSON.stringify(conversation));
    }
    assert.deepEqual(await host.callService('send_message', { caller: FAM, payload: { conversation: ['family'], text: '' } }), { ok: false, code: 'invalid' });
    // the single form is unchanged
    const one = await host.callService('send_message', { caller: FAM, payload: { conversation: 'family', text: 'eins' } });
    assert.deepEqual(Object.keys(one).sort(), ['conversationId', 'messageId', 'ok']);
  });
});

test('release_group (1.1.0): the managed group becomes a normal group — members may leave, admins as given', async () => {
  await withHost({}, async (host, c) => {
    const g = await host.callService('sync_group', { caller: FAM, payload: { key: 'family', title: 'Familie', userIds: [ANNA.id, MARC.id, LENA.id] } });
    const id = g.conversationId;
    await c.send(MARC, id, { text: 'bleibt' });
    c.resetEvents();
    const r = await host.callService('release_group', { caller: FAM, payload: { key: 'family', adminIds: [MARC.id, OMA.id] } });
    assert.deepEqual(r, { ok: true, conversationId: id, released: true, deleted: false, admins: [MARC.id] });
    assert.deepEqual(c.events('conversation.update').map((e) => [e.users.sort(), e.data.reason]), [[[ANNA.id, MARC.id, LENA.id], 'released']]);
    assert.equal(c.events('message.new').length, 1);
    const conv = (await c.as(MARC)('GET', `conversations/${id}`)).json.conversation;
    assert.deepEqual([conv.managedBy, conv.me.role, conv.can.leave, conv.can.editInfo, conv.can.manageMembers], [null, 'admin', true, true, true]);
    const msgs = (await c.as(ANNA)('GET', `conversations/${id}/messages`)).json.messages;
    assert.deepEqual(msgs.slice(-2).map((m) => [m.text, m.system]), [['bleibt', null], [null, { event: 'released', by: null }]], 'the history stays, a system message tells');
    assert.equal((await c.as(ANNA)('GET', `conversations/${id}`)).json.conversation.unread, 1, 'the system message is not unread');
    // now a normal group: Lena leaves, Marc (admin) adds Oma, the title changes
    assert.equal((await c.as(LENA)('PATCH', `conversations/${id}`, { remove: [LENA.id] })).json.left, true);
    assert.equal((await c.as(MARC)('PATCH', `conversations/${id}`, { add: [OMA.id], title: 'Wir' })).status, 200);
    // the key is free: the next sync creates a new group; releasing again → not_found
    assert.deepEqual(await host.callService('release_group', { caller: FAM, payload: { key: 'family' } }), { ok: false, code: 'not_found' });
    const g2 = await host.callService('sync_group', { caller: FAM, payload: { key: 'family', title: 'Familie', userIds: [ANNA.id] } });
    assert.equal(g2.created, true);
    assert.notEqual(g2.conversationId, id);
    // without adminIds: the member who joined first
    const r3 = await host.callService('release_group', { caller: FAM, payload: { key: 'family' } });
    assert.deepEqual(r3.admins, [ANNA.id]);
    for (const payload of [{}, { key: 'Family' }, { key: 'family', delete: 'yes' }, { key: 'family', adminIds: 'all' }, { key: 'family', adminIds: [0] }]) {
      assert.deepEqual(await host.callService('release_group', { caller: FAM, payload }), { ok: false, code: 'invalid' }, JSON.stringify(payload));
    }
    // another plugin's group cannot be released
    await host.callService('sync_group', { caller: 'gatecontrol-other', payload: { key: 'x', title: 'X', userIds: [ANNA.id] } });
    assert.deepEqual(await host.callService('release_group', { caller: FAM, payload: { key: 'x' } }), { ok: false, code: 'not_found' });
  });
});

test('release_group delete (1.1.0): the managed group is deleted for everyone, with its messages and files', async () => {
  await withHost({}, async (host, c) => {
    const g = await host.callService('sync_group', { caller: FAM, payload: { key: 'family', title: 'Familie', userIds: [ANNA.id, MARC.id] } });
    const id = g.conversationId;
    const media = await c.upload(ANNA, PNG, 'image/png');
    const pic = await c.send(ANNA, id, { kind: 'image', mediaId: media });
    await c.as(MARC)('PUT', `messages/${pic.id}/reaction`, { emoji: '👍' });
    const t = new Date(Date.now()).toISOString();
    c.clock.add(SEC);
    c.resetEvents();
    const r = await host.callService('release_group', { caller: FAM, payload: { key: 'family', delete: true } });
    assert.deepEqual(r, { ok: true, conversationId: id, released: false, deleted: true, admins: [] });
    assert.deepEqual(c.events('conversation.remove').map((e) => [e.users.sort(), e.data]), [[[ANNA.id, MARC.id], { conversationId: id }]]);
    for (const u of [ANNA, MARC]) {
      assert.equal((await c.as(u)('GET', `conversations/${id}`)).status, 404, u.name);
      const list = (await c.as(u)('GET', 'conversations', null, { since: t })).json;
      assert.deepEqual([list.conversations.length, list.removed], [0, [id]], 'apps that were offline learn it');
    }
    assert.equal((await host.mediaGet(app(ANNA), media)).status, 404, 'the file is gone for the members');
    await host.tick();
    assert.equal(host.media.has(media), false, 'and deleted from GateControl\'s store');
    assert.deepEqual((await host.gc.db.query('SELECT id FROM messages WHERE conv_id = ?', [id])).rows, []);
    assert.deepEqual((await host.gc.db.query('SELECT * FROM reactions')).rows, []);
    // the key is free again
    assert.equal((await host.callService('sync_group', { caller: FAM, payload: { key: 'family', title: 'Familie', userIds: [ANNA.id] } })).created, true);
  });
});
