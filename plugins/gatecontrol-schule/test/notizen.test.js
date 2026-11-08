'use strict';

// 1.8.0 — Schule as a source of „Notizen & Aufgaben“ (gatecontrol-notizen, contract v1, server/notizen.js): homework and
// exams per child for the child and its recipients, ticking homework off (and undoing it) round trip, the push only of
// real changes in one call, kept on ERR_RATE_LIMIT, nothing without the hub; only the hub may call todo_items /
// todo_complete.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asApp, setupParent, clock, EVA, LENA, BOB, T0 } = require('./helpers');
const { fakeHub, checkItem, pullAll, HUB } = require('../../../tools/testing/notizen-hub');
const notizen = require('../server/notizen');
const manifest = require('../plugin.json');

const MIN = 60000;

function seed(untis) {
  untis.state.homework = {
    homeworks: [
      { id: 501, lessonId: 9001, date: 20261019, dueDate: 20261021, text: 'S. 42 Nr. 3', remark: '', completed: false, attachments: [] },
      { id: 502, lessonId: 9002, date: 20261020, dueDate: 20261021, text: 'Vokabeln Unit 3', completed: true },
      { id: 503, lessonId: 9003, date: 20261020, dueDate: 20261022, text: 'Gedicht lernen', completed: false },
    ],
    lessons: [{ id: 9001, subject: 'Mathematik', lessonType: 'Unterricht' }, { id: 9002, subject: 'E', lessonType: 'Unterricht' }, { id: 9003, subject: 'Deutsch', lessonType: 'Unterricht' }],
    records: [{ homeworkId: 501, teacherId: 11, elementIds: [101] }, { homeworkId: 502, teacherId: 12, elementIds: [101] }, { homeworkId: 503, teacherId: 11, elementIds: [102] }],
    teachers: [{ id: 11, name: 'MUE' }],
  };
  untis.state.exams = [
    { id: 7001, examType: 'Klassenarbeit', name: 'KA 2', examDate: 20261021, startTime: 950, endTime: 1035, subject: 'M', text: 'Bruchrechnung',
      assignedStudents: [{ id: 101, displayName: 'Lena Muster', klasse: { id: 501, name: '5a' } }] },
  ];
}

const run = (o, fn) => withHost({ gatecontrol: '1.216.0', ...o, services: o.hub === null ? [] : [o.hub || (o.hub = fakeHub())] }, async (host, untis) => {
  notizen.source.state.noTimer = true;
  try { return await fn(host, untis, o.hub); } finally { notizen.source.stop(); }
});
const flush = (host) => notizen.source.flush(host.gc, clock.now(), { force: true });
const complete = (host, user, id, done, caller = HUB) => host.callService('todo_complete', { caller, user, payload: { v: 1, id, done } });

test('plugin.json: todo_items and todo_complete (600 an hour), GateControl 1.216.0 for maxPerHour', () => {
  assert.equal(manifest.version, '1.8.0');
  assert.equal(manifest.gatecontrol, '>=1.216.0');
  for (const n of ['todo_items', 'todo_complete']) assert.equal(manifest.services.provides[n].maxPerHour, 600);
  assert.ok(manifest.permissions.services.includes('gatecontrol-notizen:todo_changed'));
});

test('items: homework and exams of a child for the child and its recipients — not for others', () => run({}, async (host, untis) => {
  seed(untis);
  const { lena } = await setupParent(host);
  const items = [...(await notizen.source.items(host.gc, clock.now())).values()];
  const hw = items.find((x) => x.kind === 'homework' && x.title === 'M: S. 42 Nr. 3');
  assert.ok(hw, JSON.stringify(items.map((x) => x.title)));
  assert.equal(checkItem({ ...hw, updatedAt: 1 }, 'gatecontrol-schule'), null);
  assert.deepEqual([hw.due, hw.allDay, hw.done, hw.canComplete, hw.assignee, hw.users], ['2026-10-21', true, false, true, LENA.id, [LENA.id, EVA.id]]);
  assert.deepEqual(hw.group, { id: `child:${lena.id}`, label: lena.display || 'Lena Muster' });
  assert.equal(hw.meta.child, hw.group.label);
  assert.match(hw.open.route, new RegExp(`^homework/${lena.id}:501$`));
  const done = items.find((x) => x.title === 'E: Vokabeln Unit 3');
  assert.equal(done.done, true, 'completed in WebUntis');
  const exam = items.find((x) => x.kind === 'exam');
  assert.deepEqual([exam.title, exam.due, exam.allDay, exam.canComplete], ['M: KA 2', '2026-10-21T09:50:00+02:00', false, false]);
  assert.ok(!items.some((x) => x.title.includes('Gedicht')), 'Max has no account and no recipients: nobody to show it to');
  // Bob sees nothing
  assert.deepEqual((await pullAll(host, BOB)).items, []);
  assert.equal((await pullAll(host, EVA)).items.length, items.length);
}));

test('todo_complete: ticked off for the child (shown as done in Schule), undone; WebUntis’ own done is read only', () => run({}, async (host, untis, hub) => {
  seed(untis);
  const { lena } = await setupParent(host);
  const id = `hw:${lena.id}:501`;
  const r = await complete(host, EVA, id, true);
  assert.equal(r.ok, true);
  assert.deepEqual([r.item.id, r.item.done], [id, true]);
  const tt = await asApp(host, LENA, '/app/timetable', { from: '2026-10-21', to: '2026-10-21' });
  assert.deepEqual(tt.json.students[0].days[0].homework.find((h) => h.text === 'S. 42 Nr. 3').completed, true, 'Schule shows it done');
  // a fetch replaces the homework rows: the tick stays
  await asAdmin(host, 'POST', `/accounts/${lena.account_id}/refresh`);
  assert.equal((await notizen.source.items(host.gc, clock.now())).get(id).done, true);
  // the answer's item is what the hub keeps: no push for it
  await flush(host);
  assert.ok(hub.pushes().every((c) => c.payload.upsert.filter((x) => x.id === id).every((x) => x.done === true)));
  const before = hub.pushes().length;
  assert.equal((await complete(host, LENA, id, true)).ok, true, 'twice is fine');
  await flush(host);
  assert.equal(hub.pushes().length, before, 'nothing changed');
  const u = await complete(host, LENA, id, false);
  assert.deepEqual([u.ok, u.item.done], [true, false]);
  assert.deepEqual(await complete(host, EVA, `hw:${lena.id}:502`, false), { ok: false, code: 'read_only' }, 'done in WebUntis');
  assert.deepEqual(await complete(host, EVA, (await pullAll(host, EVA)).items.find((x) => x.kind === 'exam').id, true), { ok: false, code: 'read_only' });
  assert.deepEqual(await complete(host, BOB, id, true), { ok: false, code: 'not_found' }, 'not his');
  assert.deepEqual(await complete(host, EVA, id, true, 'gatecontrol-familie'), { ok: false, code: 'forbidden' });
  assert.deepEqual(await host.callService('todo_items', { caller: 'gatecontrol-familie', user: EVA, payload: { v: 1 } }), { ok: false, code: 'forbidden' });
}));

test('push: one call, only real changes, removals, kept on ERR_RATE_LIMIT; nothing without the hub', async () => {
  let fail = false;
  const hub = fakeHub({ answer: () => { if (fail) throw Object.assign(new Error('rate'), { code: 'ERR_RATE_LIMIT' }); return undefined; } });
  await run({ hub }, async (host, untis) => {
    seed(untis);
    const { lena } = await setupParent(host);
    const a = await flush(host);
    assert.deepEqual([a.sent, hub.rejected.length], [1, 0]);
    assert.equal(hub.pushes()[0].payload.upsert.length, 3);
    assert.equal((await flush(host)).sent, 0, 'nothing changed');
    // the recipients change: every item of Lena again (users), in one call
    await asAdmin(host, 'PUT', `/students/${lena.id}`, { recipients: [EVA.id, BOB.id] });
    fail = true;
    assert.equal((await flush(host)).upserted, 0);
    fail = false;
    const b = await flush(host);
    assert.equal(b.sent, 1);
    assert.ok(hub.pushes().at(-1).payload.upsert.every((x) => x.users.includes(BOB.id)));
    // the child switched off: removed
    await asAdmin(host, 'PUT', `/students/${lena.id}`, { enabled: false });
    await flush(host);
    assert.equal(hub.pushes().at(-1).payload.remove.length, 3);
    assert.equal(hub.items.size, 0);
    // the background run pushes at most once a minute
    await asAdmin(host, 'PUT', `/students/${lena.id}`, { enabled: true });
    clock.set(T0 + 30 * MIN);
    await host.tick();
    const n = hub.pushes().length;
    clock.set(T0 + 30 * MIN + 20000);
    await host.tick();
    assert.equal(hub.pushes().length, n);
  });
  await run({ hub: null }, async (host, untis) => {
    seed(untis);
    await setupParent(host);
    assert.equal((await flush(host)).skipped, 'unavailable');
    await host.tick();
    assert.equal(host.serviceCalls.filter((c) => c.plugin === HUB).length, 0);
  });
});
