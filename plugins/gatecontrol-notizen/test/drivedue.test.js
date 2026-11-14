'use strict';

// 1.7.0 — the reminders of Drive's deadlines ring from here (server/drivedue.js). Drive is a stand-in that speaks its
// part (the item of a deadline through todo_changed, the service deadline_claim); both real plugins together:
// plugins/gatecontrol-drive/test/duehub.test.js.
//   * the service deadline_reminders: Drive's whole list — a task per reminder that carries the item (Task.deadline),
//     what the list no longer names goes; only Drive may call; refused as a whole without Drive's deadline_claim or
//     while the source Drive is off; a reminder whose item the person does not see is rejected (Drive keeps it);
//   * the first ring asks Drive — send: the push „Frist in 3 Tagen: …“ with Erledigt / Später / Datei öffnen; no: nothing
//     rings; no answer: asked again later, nothing marked;
//   * „Erledigt“ on the push ticks the deadline off in Drive; a reminder missed for more than a day is part of „Gestern
//     offen geblieben“; a task the person made of the item themselves only gets (and loses) the reminder;
//   * the item renamed or gone in Drive: the task follows.
// The clock is pinned (helpers: Sunday 2026-11-08 10:00 in Berlin) and only ever set.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, fakeSource, item, ANNA, MARC, BOB, PLUGINS, clock, T0 } = require('./helpers');
const manifest = require('../plugin.json');

const DRIVE = 'gatecontrol-drive';
const at = (s) => Date.parse(s);
const REMIND = at('2026-11-27T07:00:00Z');

/** The hub with a Drive that answers deadline_claim (o.claim: its answer, a function of the payload; o.noClaim: an older Drive). */
async function setup(o = {}) {
  const st = { claims: [], answer: o.claim || (() => ({ ok: true, send: true })) };
  const drive = fakeSource(DRIVE, {
    provides: o.noClaim ? {} : { deadline_claim: { label: { de: 'x', en: 'x' }, maxPerHour: 600 } },
    service: async ({ name, user, payload }) => {
      if (name !== 'deadline_claim') return { ok: false, code: 'not_found' };
      st.claims.push({ user: user && user.id, payload });
      const r = st.answer(payload);
      if (r instanceof Error) throw r;
      return r;
    },
  });
  const h = await withHost({ sources: [...PLUGINS.filter((p) => p !== DRIVE).map((p) => fakeSource(p)), drive], settings: o.settings });
  const deadline = (id, extra = {}) => item(DRIVE, `deadline:${id}`, { kind: 'deadline', title: 'Kfz-Versicherung kündigen', subtitle: 'Versicherungsschein.pdf', due: '2026-11-30',
    users: [ANNA.id, MARC.id], meta: { type: 'cancellation' }, open: { plugin: DRIVE, route: `node/${40 + id}` }, ...extra });
  const give = async (...items) => { for (const i of items) drive.state.items.set(i.id, i); return h.push(DRIVE, { upsert: items }); };
  const put = (reminders, caller = DRIVE) => h.host.callService('deadline_reminders', { caller, user: null, payload: { v: 1, reminders } });
  const rem = (id, user = ANNA, extra = {}) => ({ id: `deadline:${id}`, userId: user.id, at: REMIND, daysBefore: 3, sent: false, ...extra });
  const tasks = async (user = ANNA) => (await h.ok(user, 'GET', 'views/planned')).sections.flatMap((s) => s.items).filter((x) => x.type === 'task' && x.deadline);
  const pushes = () => h.host.notifications.filter((n) => n.topic === 'reminders' && n.data.notizen.kind === 'reminder');
  return { h, st, drive, deadline, give, put, rem, tasks, pushes };
}

test('plugin.json: the service deadline_reminders, the permission to ask Drive; the feature word', async () => {
  assert.equal(manifest.services.provides.deadline_reminders.maxPerHour, 600);
  assert.ok(manifest.permissions.services.includes('gatecontrol-drive:deadline_claim'));
  const s = await setup();
  try {
    const me = await s.h.ok(ANNA, 'GET', 'me');
    assert.ok(me.features.includes('driveDeadlines'));
    assert.deepEqual(me.driveDeadlines, { available: true, active: false });
  } finally { await s.h.close(); clock.set(T0); }
});

test('the list: a task per reminder that carries the item; the whole list each time — what it no longer names goes; who may call and when it is refused', async () => {
  const s = await setup();
  try {
    await s.give(s.deadline(1), s.deadline(2, { title: 'Strom bezahlen', due: '2026-12-05', meta: { type: 'payment', amount: '84,20 €' } }));
    assert.deepEqual(await s.put([s.rem(1)], 'gatecontrol-mail'), { ok: false, code: 'forbidden' });
    assert.deepEqual(await s.h.host.callService('deadline_reminders', { caller: DRIVE, user: null, payload: { v: 2, reminders: [] } }), { ok: false, code: 'invalid' });
    const r = await s.put([s.rem(1), s.rem(2, MARC, { daysBefore: 7, at: REMIND + 3600000 }), s.rem(9), s.rem(1, BOB), { id: 'deadline:1', userId: ANNA.id, at: 'x' }]);
    assert.deepEqual(r, { ok: true, taken: 2, rejected: ['9:1', '1:4', '1:1'] }, 'no such item, not Bob\'s to see, a broken entry');
    const [t] = await s.tasks(ANNA);
    assert.deepEqual([t.title, t.due, t.source, t.reminder.atMs], ['Kfz-Versicherung kündigen', { date: '2026-11-30', time: null }, { plugin: DRIVE, id: 'deadline:1' }, REMIND]);
    assert.deepEqual(t.deadline, { date: '2026-11-30', kind: 'cancellation', file: 'Versicherungsschein.pdf', daysBefore: 3, open: { plugin: DRIVE, route: 'node/41' } });
    assert.deepEqual((await s.tasks(MARC)).map((x) => [x.title, x.deadline.daysBefore, x.deadline.kind]), [['Strom bezahlen', 7, 'payment']]);
    assert.equal((await s.h.ok(ANNA, 'GET', 'me')).driveDeadlines.active, true);
    // the item is not shown a second time beside its task
    const all = (await s.h.ok(ANNA, 'GET', 'views/planned')).sections.flatMap((x) => x.items);
    assert.equal(all.filter((x) => x.type === 'source' && x.title === 'Kfz-Versicherung kündigen').length, 0);
    // the same list again: nothing new
    assert.deepEqual(await s.put([s.rem(1), s.rem(2, MARC, { daysBefore: 7, at: REMIND + 3600000 })]), { ok: true, taken: 2, rejected: [] });
    assert.equal((await s.tasks(ANNA)).length, 1);
    assert.equal((await s.tasks(ANNA))[0].id, t.id);
    // Marc's is no longer named: his task goes, Anna's stays
    await s.put([s.rem(1)]);
    assert.deepEqual(await s.tasks(MARC), []);
    assert.equal((await s.tasks(ANNA)).length, 1);
    // an empty list (Drive reminds itself again): all go, and the item is an item again
    assert.deepEqual(await s.put([]), { ok: true, taken: 0, rejected: [] });
    assert.deepEqual(await s.tasks(ANNA), []);
    const back = (await s.h.ok(ANNA, 'GET', 'views/planned')).sections.flatMap((x) => x.items);
    assert.equal(back.filter((x) => x.type === 'source' && x.title === 'Kfz-Versicherung kündigen').length, 1);
    assert.equal((await s.h.ok(ANNA, 'GET', 'me')).driveDeadlines.active, false);
  } finally { await s.h.close(); clock.set(T0); }
});

test('refused as a whole: an older Drive that cannot be asked, the source Drive switched off', async () => {
  const old = await setup({ noClaim: true });
  try {
    await old.give(old.deadline(1));
    assert.deepEqual(await old.put([old.rem(1)]), { ok: false, code: 'unavailable', reason: 'claim' });
    assert.deepEqual(await old.tasks(), []);
    assert.deepEqual((await old.h.ok(ANNA, 'GET', 'me')).driveDeadlines, { available: false, active: false });
    assert.deepEqual(await old.put([]), { ok: true, taken: 0, rejected: [] }, 'an empty list is always taken: there is nothing to ask for');
  } finally { await old.h.close(); clock.set(T0); }
  const off = await setup({ settings: { source_drive: false } });
  try {
    assert.deepEqual(await off.put([off.rem(1)]), { ok: false, code: 'source_off' });
  } finally { await off.h.close(); clock.set(T0); }
});

test('the ring: asked once in Drive — „Frist in 3 Tagen: …“ with Erledigt / Später / Datei öffnen; „Erledigt“ ticks the deadline off in Drive', async () => {
  const s = await setup();
  try {
    await s.give(s.deadline(1));
    await s.put([s.rem(1)]);
    const [t] = await s.tasks();
    await s.h.host.tick();
    assert.equal(s.pushes().length, 0, 'not due');
    assert.equal(s.st.claims.length, 0, 'and not asked before it is');
    // GET reminders: the texts of the push, for a device's own alarm
    clock.set(at('2026-11-20T09:00:00Z'));
    const feed = (await s.h.ok(ANNA, 'GET', 'reminders')).reminders;
    assert.deepEqual(feed.map((x) => [x.taskId, x.tag, x.title, x.body, x.atMs]), [[t.id, `task:${t.id}:${REMIND}`, 'Frist in 3 Tagen: Kfz-Versicherung kündigen', 'Kündigung bis 30.11.2026 · Versicherungsschein.pdf', REMIND]]);
    assert.deepEqual(feed[0].deadline, t.deadline);
    assert.deepEqual((await s.h.ok(MARC, 'GET', 'reminders')).reminders, []);
    clock.set(REMIND + 20000);
    await s.h.host.tick();
    assert.deepEqual(s.st.claims, [{ user: ANNA.id, payload: { v: 1, id: 'deadline:1', userId: ANNA.id } }]);
    const [n] = s.pushes();
    assert.deepEqual([n.title, n.body, n.users, n.collapseKey], ['Frist in 3 Tagen: Kfz-Versicherung kündigen', 'Kündigung bis 30.11.2026 · Versicherungsschein.pdf', [ANNA.id], 'task:' + t.id]);
    assert.deepEqual(n.data.actions.map((a) => [a.type, a.id, a.label, a.target || null]),
      [['callback', 'done', 'Erledigt', null], ['callback', 'snooze_1h', 'In 1 Std.', null], ['callback', 'snooze_eve', 'Heute Abend', null], ['open_portal', 'open_file', 'Datei öffnen', '/portal?drive=41#plg-gatecontrol-drive']]);
    assert.deepEqual([n.data.notizen.kind, n.data.notizen.taskId, n.data.notizen.tag], ['reminder', t.id, `task:${t.id}:${REMIND}`]);
    assert.deepEqual(n.data.notizen.deadline, t.deadline);
    // „In 1 Std.“: again in an hour, and Drive is not asked a second time
    assert.deepEqual(await s.h.press(ANNA, n, 'snooze_1h'), { ok: true, snoozed: true });
    clock.set(REMIND + 3600000 + 80000);
    await s.h.host.tick();
    assert.equal(s.pushes().length, 2);
    assert.equal(s.st.claims.length, 1);
    // „Erledigt“: the deadline is ticked off in Drive, the task is done
    assert.deepEqual(await s.h.press(ANNA, s.pushes()[1], 'done'), { ok: true, done: true });
    assert.deepEqual(s.drive.state.completes, [{ id: 'deadline:1', done: true, user: ANNA.id }]);
    assert.equal((await s.h.ok(ANNA, 'GET', 'tasks/' + t.id)).task.done, true);
    // the list without it (Drive names no reminder of a deadline ticked off): the done task stays as the record of it
    await s.put([]);
    assert.equal((await s.h.ok(ANNA, 'GET', 'tasks/' + t.id)).task.done, true);
  } finally { await s.h.close(); clock.set(T0); }
});

test('Drive says no: nothing rings. Drive does not answer: nothing rings and nothing is marked — asked again five minutes on', async () => {
  const no = await setup({ claim: () => ({ ok: true, send: false }) });
  try {
    await no.give(no.deadline(1));
    await no.put([no.rem(1)]);
    clock.set(REMIND + 20000);
    await no.h.host.tick();
    clock.set(REMIND + 90000);
    await no.h.host.tick();
    assert.equal(no.pushes().length, 0);
    assert.equal(no.st.claims.length, 1, 'the answer is kept: not asked again');
    assert.equal((await no.tasks())[0].reminder, null, 'no reminder to come');
  } finally { await no.h.close(); clock.set(T0); }
  let down = true;
  const s = await setup({ claim: () => (down ? Object.assign(new Error('down'), { code: 'ERR_TIMEOUT' }) : { ok: true, send: true }) });
  try {
    await s.give(s.deadline(1));
    await s.put([s.rem(1)]);
    clock.set(REMIND + 20000);
    await s.h.host.tick();
    clock.set(REMIND + 80000);
    await s.h.host.tick();
    assert.equal(s.pushes().length, 0);
    assert.equal(s.st.claims.length, 1, 'not every minute');
    assert.ok((await s.tasks())[0].reminder, 'still to come');
    down = false;
    clock.set(REMIND + 6 * 60000);
    await s.h.host.tick();
    assert.equal(s.pushes().length, 1);
    assert.equal(s.st.claims.length, 2);
  } finally { await s.h.close(); clock.set(T0); }
});

test('missed for more than a day (the server was off): not rung, not asked — part of „Gestern offen geblieben“', async () => {
  const s = await setup();
  try {
    await s.give(s.deadline(1));
    await s.put([s.rem(1)]);
    clock.set(REMIND + 25 * 3600000);
    await s.h.host.tick();
    assert.equal(s.pushes().length, 0);
    assert.equal(s.st.claims.length, 0);
    const [t] = await s.tasks();
    assert.equal(t.missedReminder, true);
    const y = await s.h.ok(ANNA, 'GET', 'yesterday');
    assert.ok(JSON.stringify(y).includes('Kfz-Versicherung kündigen'), 'in the list of what stayed open');
  } finally { await s.h.close(); clock.set(T0); }
});

test('a task the person made of the item themselves gets the reminder and only loses that; the item renamed or gone: the hub\'s task follows', async () => {
  const s = await setup();
  try {
    await s.give(s.deadline(1), s.deadline(2, { title: 'Strom bezahlen', due: '2026-12-05' }));
    const planned = (await s.h.ok(ANNA, 'GET', 'views/planned')).sections.flatMap((x) => x.items);
    const src = planned.find((x) => x.type === 'source' && x.title === 'Kfz-Versicherung kündigen');
    const own = (await s.h.ok(ANNA, 'POST', `items/${src.id}/carry`)).task;
    assert.equal(own.reminder, null);
    await s.put([s.rem(1), s.rem(2)]);
    const list = await s.tasks();
    assert.equal(list.length, 2);
    const mine = list.find((x) => x.id === own.id);
    assert.equal(mine.reminder.atMs, REMIND, 'the person\'s own task carries the reminder');
    const made = list.find((x) => x.id !== own.id);
    // Drive read the file anew: another title — the hub's task follows
    await s.give(s.deadline(2, { title: 'Stromrechnung bezahlen', due: '2026-12-05', updatedAt: clock.now() + 1 }));
    assert.equal((await s.h.ok(ANNA, 'GET', 'tasks/' + made.id)).task.title, 'Stromrechnung bezahlen');
    // the reminders are gone in Drive: the hub's task goes, the person's own stays without the reminder
    await s.put([]);
    const after = (await s.h.ok(ANNA, 'GET', 'tasks/' + own.id)).task;
    assert.deepEqual([after.reminder, after.deadline], [null, null]);
    assert.equal((await s.h.call(ANNA, 'GET', 'tasks/' + made.id)).status, 404);
    // the deadline itself gone in Drive (the file deleted): the task made for its reminder goes with the item
    await s.put([s.rem(2)]);
    const again = (await s.tasks()).find((x) => x.source.id === 'deadline:2');
    assert.ok(again);
    s.drive.state.items.delete('deadline:2');
    await s.h.push(DRIVE, { remove: ['deadline:2'] });
    assert.equal((await s.h.call(ANNA, 'GET', 'tasks/' + again.id)).status, 404);
    clock.set(REMIND + 20000);
    await s.h.host.tick();
    assert.equal(s.pushes().length, 0, 'nothing rings for what is gone');
  } finally { await s.h.close(); clock.set(T0); }
});
