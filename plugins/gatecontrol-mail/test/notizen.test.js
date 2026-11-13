'use strict';

// 1.11.0 — Mail as a source of „Notizen & Aufgaben“ (gatecontrol-notizen, contract v1, server/notizen.js): the AI's
// „Zu tun“ and flagged mails as items of the account's owner (business accounts: area 'work'), ticking them off round
// trip (a to-do: done in Mail too; a flagged mail: the flag cleared on the server, undone flags it again), the push
// only of real changes in one call, kept on ERR_RATE_LIMIT, nothing without the hub; only the hub may call.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, ANNA, MARC, BOB } = require('./helpers');
const { fakeHub, checkItem, pullAll, HUB } = require('../../../tools/testing/notizen-hub');
const notizen = require('../server/notizen');
const manifest = require('../plugin.json');

function ai() {
  return {
    extract: async (req) => {
      if (req.task === 'mail_sort') return { tab: 'relevant' };
      return {
        summary: 'Rechnung über 84,20 €.',
        todos: [{ kind: 'deadline', text: 'Rechnung bis 28.11. bezahlen', date: '2026-11-28', time: '09:30', amount: null, currency: null },
          { kind: 'amount', text: 'Betrag 84,20 €', date: null, amount: 84.2, currency: 'EUR' }],
        replies: [],
      };
    },
  };
}

async function setup(host, c, o = {}) {
  notizen.source.state.noTimer = true;
  c.mail.login('anna@gmx.de', 'geheim-123');
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { name: 'Stadtwerke', address: 'rechnung@stadtwerke.example' }, subject: 'Ihre Rechnung Oktober', text: 'Sehr geehrte Kundin, '.repeat(40) });
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { name: 'Tim', address: 'tim@example.com' }, subject: 'Grillen am Samstag?', text: 'Kommst du?', flags: ['\\Flagged'] });
  const acc = await c.addGmx(ANNA, { body: o.business ? { kind: 'business' } : {} });
  await c.tick();
  const list = (await c.list(ANNA, { tab: 'all' })).items;
  const bill = list.find((x) => x.subject === 'Ihre Rechnung Oktober');
  const grill = list.find((x) => x.subject === 'Grillen am Samstag?');
  await c.as(ANNA)('POST', `ai/${bill.id}`);
  return { acc, bill, grill };
}

test('plugin.json: todo_items and todo_complete (600 an hour), todo_changed of the hub', () => {
  assert.ok(['1.11.0', '1.12.0', '1.12.1', '1.13.0', '1.13.1', '1.14.0'].includes(manifest.version));
  for (const n of ['todo_items', 'todo_complete']) assert.equal(manifest.services.provides[n].maxPerHour, 600);
  assert.ok(manifest.permissions.services.includes('gatecontrol-notizen:todo_changed'));
});

test('items: „Zu tun“ and flagged mails of the owner; a business account is work; nobody else sees them', () => withMail({ ai: ai(), services: [fakeHub()] }, async (host, c) => {
  const { acc, bill, grill } = await setup(host, c, { business: true });
  const items = (await pullAll(host, ANNA)).items;
  assert.equal(items.length, 3, JSON.stringify(items.map((x) => x.id)));
  for (const x of items) assert.equal(checkItem(x, 'gatecontrol-mail'), null, x.id);
  const pay = items.find((x) => x.meta.type === 'deadline');
  assert.deepEqual([pay.kind, pay.title, pay.subtitle, pay.due, pay.allDay, pay.area, pay.users, pay.done, pay.canComplete],
    ['task', 'Rechnung bis 28.11. bezahlen', 'Zu tun aus „Ihre Rechnung Oktober“', '2026-11-28T09:30:00+01:00', false, 'work', [ANNA.id], false, true]);
  assert.deepEqual(pay.group, { id: `account:${acc.id}`, label: acc.name });
  assert.deepEqual(pay.open, { plugin: 'gatecontrol-mail', route: `message/${bill.id}` });
  assert.equal(items.find((x) => x.meta.type === 'amount').meta.amount, '84,20 €');
  const flag = items.find((x) => x.id === `flag:${grill.id}`);
  assert.deepEqual([flag.title, flag.subtitle, flag.important, flag.meta.flagged, flag.due], ['Grillen am Samstag?', 'Tim', true, true, null]);
  assert.deepEqual((await pullAll(host, MARC)).items, []);
  assert.deepEqual((await pullAll(host, BOB)).items, []);
  // a personal account: private
  await c.as(ANNA)('PATCH', `accounts/${acc.id}`, { kind: 'personal' });
  assert.ok((await pullAll(host, ANNA)).items.every((x) => x.area === 'private'));
}));

test('todo_complete: a to-do done in Mail too (and back); a flagged mail unflagged on the server, undo flags it again', () => withMail({ ai: ai(), services: [fakeHub()] }, async (host, c) => {
  const { bill, grill } = await setup(host, c);
  const items = (await pullAll(host, ANNA)).items;
  const pay = items.find((x) => x.meta.type === 'deadline');
  const r = await host.callService('todo_complete', { caller: HUB, user: ANNA, payload: { v: 1, id: pay.id, done: true } });
  assert.deepEqual([r.ok, r.item.done], [true, true]);
  const view = (await c.as(ANNA)('GET', `ai/${bill.id}`)).json;
  assert.deepEqual(view.todos.map((x) => x.done), [true, false], 'Mail shows it ticked off');
  assert.equal(view.todos[0].key, pay.id.split(':')[2]);
  // Mail's own button, the other way
  const back = (await c.as(ANNA)('POST', `ai/${bill.id}/todo/0`, { action: 'open' })).json;
  assert.equal(back.todo.done, false);
  assert.equal((await pullAll(host, ANNA)).items.find((x) => x.id === pay.id).done, false);
  // a new AI run with the same to-do keeps the tick
  await c.as(ANNA)('POST', `ai/${bill.id}/todo/0`, { action: 'done' });
  await c.as(ANNA)('POST', `ai/${bill.id}`, { again: true });
  assert.equal((await c.as(ANNA)('GET', `ai/${bill.id}`)).json.todos[0].done, true);

  // the flagged mail: the flag goes on the server
  const id = `flag:${grill.id}`;
  const f = await host.callService('todo_complete', { caller: HUB, user: ANNA, payload: { v: 1, id, done: true } });
  assert.deepEqual([f.ok, f.item.done], [true, true]);
  const box = c.mail.logins.get('anna@gmx.de').boxes.get('INBOX');
  const raw = [...box.msgs.values()].find((m) => m.envelope.subject === 'Grillen am Samstag?');
  assert.ok(!raw.flags.includes('\\Flagged'), 'unflagged on the server');
  assert.equal((await c.as(ANNA)('GET', `messages/${grill.id}`)).json.flagged, false);
  const u = await host.callService('todo_complete', { caller: HUB, user: ANNA, payload: { v: 1, id, done: false } });
  assert.deepEqual([u.ok, u.item.done], [true, false]);
  assert.ok(raw.flags.includes('\\Flagged'), 'flagged again');
  // refusals
  assert.deepEqual(await host.callService('todo_complete', { caller: HUB, user: MARC, payload: { v: 1, id, done: true } }), { ok: false, code: 'not_found' });
  assert.deepEqual(await host.callService('todo_complete', { caller: 'gatecontrol-drive', user: ANNA, payload: { v: 1, id, done: true } }), { ok: false, code: 'forbidden' });
  assert.deepEqual(await host.callService('todo_items', { caller: 'gatecontrol-drive', user: ANNA, payload: { v: 1 } }), { ok: false, code: 'forbidden' });
  // the old services still answer
  assert.equal((await host.callService('tofile_count', { caller: 'gatecontrol-drive', user: ANNA, payload: { userId: ANNA.id } })).ok, true);
}));

test('push: one call for the changes, only real changes, kept on ERR_RATE_LIMIT; flagging in Mail goes out; nothing without the hub', async () => {
  let fail = false;
  const hub = fakeHub({ answer: () => { if (fail) throw Object.assign(new Error('rate'), { code: 'ERR_RATE_LIMIT' }); return undefined; } });
  await withMail({ ai: ai(), services: [hub] }, async (host, c) => {
    const { grill, bill } = await setup(host, c);
    // the background run of the first sync pushed the flagged mail already; the AI's two to-dos came later — one call
    assert.deepEqual(hub.pushes().map((x) => x.payload.upsert.map((i) => i.id)), [[`flag:${grill.id}`]]);
    const a = await notizen.source.flush(host.gc, Date.now(), { force: true });
    assert.deepEqual([a.sent, a.upserted, hub.rejected.length, hub.items.size], [1, 2, 0, 3]);
    assert.equal((await notizen.source.flush(host.gc, Date.now(), { force: true })).sent, 0, 'nothing changed');
    // unflagged in Mail: removed
    await c.as(ANNA)('POST', 'messages/flags', { ids: [grill.id], flagged: false });
    fail = true;
    assert.equal((await notizen.source.flush(host.gc, Date.now(), { force: true })).removed, 0);
    fail = false;
    const b = await notizen.source.flush(host.gc, Date.now(), { force: true });
    assert.deepEqual([b.sent, b.removed], [1, 1]);
    assert.deepEqual(hub.pushes().at(-1).payload.remove, [`flag:${grill.id}`]);
    // flagged in Mail: an upsert
    await c.as(ANNA)('POST', 'messages/flags', { ids: [bill.id], flagged: true });
    await notizen.source.flush(host.gc, Date.now(), { force: true });
    assert.deepEqual(hub.pushes().at(-1).payload.upsert.map((x) => x.id), [`flag:${bill.id}`]);
    assert.equal(hub.items.size, 3);
  });
  await withMail({ ai: ai() }, async (host, c) => {
    await setup(host, c);
    assert.equal((await notizen.source.flush(host.gc, Date.now(), { force: true })).skipped, 'unavailable');
    await c.tick();
    assert.equal(host.serviceCalls.filter((x) => x.plugin === HUB).length, 0);
  });
});
