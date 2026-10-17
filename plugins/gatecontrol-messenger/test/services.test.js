'use strict';

// Services for Familie: sync_group (a managed group "Familie" whose members only the
// calling plugin changes) and send_message (a system message from "GateControl").

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, OMA } = require('./helpers');

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
    assert.deepEqual(conv.can, { send: true, editInfo: false, manageMembers: false, leave: false, setDisappearing: true });
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
