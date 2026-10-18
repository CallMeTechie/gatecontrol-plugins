'use strict';

// Cards in the Messenger (1.9.0): a shopping list asked of a person (direct chat → family chat → push),
// „Ich gehe einkaufen“ in the family chat (setting shopping_chat), tasks from a chat (POST tasks/quick) —
// and the quick actions of those cards (shop-take / shop-decline / task-done), listed only for the person
// they belong to while open. The Messenger is a small fake provider here (send_message with a card).
// Also the service family_roles.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, MIN, pushes } = require('./helpers');

const L1 = '6f1c2a90-1111-4c1d-9a00-000000000001';
const I = (n) => `6f1c2a90-aaaa-4c1d-9a00-00000000000${n}`;

/** A Messenger: direct:<uid> answered with o.direct ('ok' | an error code), group:7 exists, family as o.family. */
function fakeMessenger(calls, o = {}) {
  return [{
    plugin: 'gatecontrol-messenger', provides: ['send_message', 'sync_group', 'release_group', 'set_place_status'],
    service: async (c) => {
      calls.push({ name: c.name, user: c.user ? c.user.id : null, payload: c.payload });
      if (c.name !== 'send_message') return { ok: true, conversationId: 1 };
      const conv = c.payload.conversation;
      if (typeof conv === 'string' && conv.startsWith('direct:')) return (o.direct || 'ok') === 'ok' ? { ok: true, conversationId: 40, messageId: 1 } : { ok: false, code: o.direct };
      if (conv === 'family') return (o.family || 'ok') === 'ok' ? { ok: true, conversationId: 1, messageId: 2 } : { ok: false, code: o.family };
      if (conv === 'group:7') return { ok: true, conversationId: 7, messageId: 3 };
      return { ok: false, code: 'not_found' };
    },
  }];
}

async function list(as) {
  await as(ANNA)('POST', '/shopping/ops', { ops: [{ op: 'list_add', id: L1, name: 'REWE' }, { op: 'item_add', id: I(1), listId: L1, text: 'Milch' }, { op: 'item_add', id: I(2), listId: L1, text: 'Brot' }] });
}
const cards = (calls) => calls.filter((c) => c.name === 'send_message' && c.payload.card);

test('assign: a card in the direct chat with „Übernehmen“ / „Heute nicht“; the lists carry assignee and dueAt', () => {
  const calls = [];
  return withFamily({ services: fakeMessenger(calls) }, async (host, { as }) => {
    await list(as);
    const r = await as(ANNA)('POST', `/shopping/lists/${L1}/assign`, { userId: LENA.id, dueAt: '2026-10-14T16:00:00Z' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.notified, { via: 'direct', ok: true, code: null });
    assert.deepEqual(r.json.list.assignee, { userId: LENA.id, by: ANNA.id, at: '2026-10-14T08:00:00Z', state: 'open', notify: 'direct' });
    assert.equal(r.json.list.dueAt, '2026-10-14T16:00:00Z');
    const c = cards(calls);
    assert.equal(c.length, 1);
    assert.deepEqual([c[0].user, c[0].payload.conversation], [ANNA.id, `direct:${LENA.id}`]);
    assert.deepEqual(c[0].payload.card, {
      kind: 'notice', title: 'Kannst du einkaufen gehen?', text: 'REWE · 2 Artikel · bis heute 18:00',
      actions: [{ actionId: `shop-take:${L1}`, label: 'Übernehmen' }, { actionId: `shop-decline:${L1}`, label: 'Heute nicht' }],
    });
    assert.equal(pushes(host, 'shopping_assigned').length, 0, 'the chat tells her');
    // GET shopping and the overview show it
    assert.deepEqual((await as(TIM)('GET', '/shopping')).json.lists[0].assignee.userId, LENA.id);
    assert.equal((await as(TIM)('GET', '/overview')).json.shopping.lists[0].dueAt, '2026-10-14T16:00:00Z');
    // only Lena has the buttons as quick actions
    assert.deepEqual((await host.quickActions(LENA)).map((q) => [q.id, q.title, q.subtitle]), [[`shop-take:${L1}`, 'Einkauf übernehmen: REWE', '2 Artikel'], [`shop-decline:${L1}`, 'Heute nicht: REWE', '2 Artikel']]);
    assert.deepEqual(await host.quickActions(MARC), []);
    assert.equal((await host.runQuickAction(MARC, `shop-take:${L1}`)).status, 404, 'a card in the family chat pressed by someone else');
    // Lena takes it: Anna is told, the request is closed
    const take = await host.runQuickAction(LENA, `shop-take:${L1}`, 'de', { via: 'gatecontrol-messenger', automation: true });
    assert.deepEqual([take.status, take.body.ok, take.body.message], [200, true, 'Du übernimmst den Einkauf.']);
    const told = pushes(host, 'shopping_taken');
    assert.deepEqual([told.length, told[0].users, told[0].title], [1, [ANNA.id], 'Lena übernimmt den Einkauf (REWE)']);
    assert.deepEqual(await host.quickActions(LENA), []);
    assert.equal((await as(ANNA)('GET', '/shopping')).json.lists[0].assignee.state, 'taken');
    // asked again, declined
    await as(ANNA)('POST', `/shopping/lists/${L1}/assign`, { userId: LENA.id });
    assert.equal((await host.runQuickAction(LENA, `shop-decline:${L1}`)).body.message, 'Abgesagt – Bescheid ist gegeben.');
    assert.equal(pushes(host, 'shopping_declined')[0].title, 'Lena kann heute nicht einkaufen (REWE)');
    assert.equal((await as(ANNA)('GET', '/shopping')).json.lists[0].assignee.state, 'declined');
    // nobody: the request ends
    const none = await as(ANNA)('POST', `/shopping/lists/${L1}/assign`, { userId: null });
    assert.deepEqual([none.json.list.assignee, none.json.list.dueAt, none.json.notified], [null, null, null]);
  });
});

test('assign: an older Messenger (no direct:) → family chat; no Messenger → a push with the two buttons; checks', () => {
  const calls = [];
  return withFamily({ services: fakeMessenger(calls, { direct: 'invalid' }) }, async (host, { as }) => {
    await list(as);
    const r = await as(ANNA)('POST', `/shopping/lists/${L1}/assign`, { userId: MARC.id });
    assert.deepEqual(r.json.notified, { via: 'family', ok: true, code: null });
    assert.deepEqual(cards(calls).map((c) => c.payload.conversation), [`direct:${MARC.id}`, 'family']);
    // 'push' only the push
    const p = await as(ANNA)('POST', `/shopping/lists/${L1}/assign`, { userId: TIM.id, notify: 'push' });
    assert.deepEqual(p.json.notified, { via: 'push', ok: true, code: null });
    const n = pushes(host, 'shopping_assigned');
    assert.equal(n.length, 1);
    assert.deepEqual([n[0].users, n[0].title, n[0].body], [[TIM.id], 'Anna fragt: Kannst du einkaufen gehen?', 'REWE · 2 Artikel']);
    assert.deepEqual(n[0].data.actions, [
      { type: 'quick_action', label: 'Übernehmen', plugin: 'gatecontrol-familie', id: `shop-take:${L1}` },
      { type: 'quick_action', label: 'Heute nicht', plugin: 'gatecontrol-familie', id: `shop-decline:${L1}` },
    ]);
    // asking oneself sends nothing; checks
    assert.equal((await as(ANNA)('POST', `/shopping/lists/${L1}/assign`, { userId: ANNA.id })).json.notified, null);
    assert.equal((await as(ANNA)('POST', `/shopping/lists/${L1}/assign`, {})).json.field, 'userId');
    assert.equal((await as(ANNA)('POST', `/shopping/lists/${L1}/assign`, { userId: 99 })).json.field, 'userId');
    assert.equal((await as(ANNA)('POST', `/shopping/lists/${L1}/assign`, { userId: TIM.id, dueAt: 'morgen' })).json.field, 'dueAt');
    assert.equal((await as(ANNA)('POST', `/shopping/lists/${L1}/assign`, { userId: TIM.id, notify: 'mail' })).json.field, 'notify');
    assert.equal((await as(ANNA)('POST', '/shopping/lists/ffffffff-none/assign', { userId: TIM.id })).status, 404);
  });
});

test('assign without any Messenger: the setting shopping_notify, then the push', () => withFamily({ settings: { shopping_notify: 'family' } }, async (host, { as }) => {
  await list(as);
  const r = await as(MARC)('POST', `/shopping/lists/${L1}/assign`, { userId: LENA.id });
  assert.deepEqual(r.json.notified, { via: 'push', ok: true, code: null });
  assert.equal(r.json.list.assignee.notify, 'family', 'as the setting says');
}));

test('„Ich gehe einkaufen“: a card in the family chat with „Zur Liste“ (setting shopping_chat); the person asked going takes it', () => {
  const calls = [];
  return withFamily({ services: fakeMessenger(calls) }, async (host, { as, clock }) => {
    await list(as);
    await as(ANNA)('POST', `/shopping/lists/${L1}/assign`, { userId: MARC.id });
    const r = await as(MARC)('POST', `/shopping/lists/${L1}/going`);
    assert.deepEqual(r.json, { ok: true, notified: 3, chat: { ok: true, code: null } });
    const c = cards(calls).filter((x) => x.payload.conversation === 'family');
    assert.deepEqual([c[0].user, c[0].payload.card], [MARC.id, { kind: 'notice', title: 'Marc geht jetzt einkaufen', text: 'REWE · 2 Artikel', link: { label: 'Zur Liste', route: 'plg-gatecontrol-familie' } }]);
    assert.equal(pushes(host, 'shopping_going').length, 1, 'the push as before');
    assert.equal((await as(ANNA)('GET', '/shopping')).json.lists[0].assignee.state, 'taken');
    host.settings.shopping_chat = 'off';
    clock.add(16 * MIN);
    assert.deepEqual((await as(MARC)('POST', `/shopping/lists/${L1}/going`)).json, { ok: true, notified: 3, chat: null });
  });
});

test('tasks/quick: a task from a chat with its card and „Erledigt“; due, repeat, whoever is first; checks', () => {
  const calls = [];
  return withFamily({ services: fakeMessenger(calls) }, async (host, { as }) => {
    const r = await as(LENA)('POST', '/tasks/quick', { title: 'Spülmaschine ausräumen', assigneeId: TIM.id, due: '2026-10-14T17:00:00Z', conversationId: 7 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const t = r.json.task;
    assert.deepEqual([t.title, t.mode, t.assignees, t.dueDate, t.dueTime, t.repeat, t.stars, t.source, t.conversationId, t.createdBy],
      ['Spülmaschine ausräumen', 'fixed', [TIM.id], '2026-10-14', '19:00', 'none', 0, 'chat', 7, LENA.id]);
    assert.deepEqual(r.json.card, { ok: true, conversation: 'group:7', code: null });
    const c = cards(calls)[0];
    assert.deepEqual([c.user, c.payload.conversation, c.payload.card], [LENA.id, 'group:7', {
      kind: 'notice', title: 'Aufgabe: Spülmaschine ausräumen', text: 'Tim · bis heute 19:00', actions: [{ actionId: `task-done:${t.id}`, label: 'Erledigt' }],
    }]);
    // „Erledigt“ only for Tim, until it is done
    assert.deepEqual((await host.quickActions(TIM)).map((q) => [q.id, q.title]), [[`task-done:${t.id}`, 'Erledigt: Spülmaschine ausräumen']]);
    assert.deepEqual(await host.quickActions(LENA), []);
    const done = await host.runQuickAction(TIM, `task-done:${t.id}`, 'de', { via: 'gatecontrol-messenger', automation: true });
    assert.deepEqual([done.status, done.body.message], [200, 'Erledigt.']);
    assert.equal((await as(TIM)('GET', `/tasks/${t.id}`)).json.task.doneToday, true);
    assert.deepEqual(await host.quickActions(TIM), []);
    // a direct chat (no group): the direct chat with the person whose task it is
    const d = await as(ANNA)('POST', '/tasks/quick', { title: 'Müll', assigneeId: MARC.id, due: '2026-10-16', repeat: 'weekly:5', conversationId: 12 });
    assert.deepEqual(d.json.card, { ok: true, conversation: `direct:${MARC.id}`, code: null });
    assert.deepEqual([d.json.task.repeat, d.json.task.weekdays, d.json.task.dueDate, d.json.task.dueTime], ['weekly', [5], '2026-10-16', null]);
    // whoever is first, no chat
    const w = await as(ANNA)('POST', '/tasks/quick', { title: 'Blumen gießen', assigneeId: null, due: null });
    assert.deepEqual([w.json.task.mode, w.json.task.assignees, w.json.task.dueDate, w.json.card], ['first', [ANNA.id, MARC.id, LENA.id, TIM.id], '2026-10-14', null]);
    for (const [body, field] of [[{ title: '' }, 'title'], [{ title: 'x', assigneeId: 99 }, 'assigneeId'], [{ title: 'x', due: 'bald' }, 'due'], [{ title: 'x', due: '2026-02-30' }, 'due'],
      [{ title: 'x', repeat: 'daily' }, 'repeat'], [{ title: 'x', conversationId: 'a' }, 'conversationId']]) {
      assert.equal((await as(ANNA)('POST', '/tasks/quick', body)).json.field, field, JSON.stringify(body));
    }
  });
});

test('family_roles: parents and children for the Messenger only', () => withFamily({}, async (host) => {
  assert.deepEqual(await host.callService('family_roles', { caller: 'gatecontrol-messenger', payload: {} }), { ok: true, parents: [ANNA.id, MARC.id], children: [LENA.id, TIM.id] });
  assert.deepEqual(await host.callService('family_roles', { caller: 'gatecontrol-door', payload: {} }), { ok: false, code: 'forbidden' });
}));
