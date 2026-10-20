'use strict';

// Wall tablet: a member with the role 'wall' (module wall, default off) sees
// only the wall view — never listed as family, no pushes, no app tab; it may
// read, tick tasks off for the person whose task it is and add / check
// shopping items, nothing else. GET wall, dark at night, the chosen list,
// the portal tab renders the wall view.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, KUECHE, MIN, portal, app, pushes } = require('./helpers');

const WALL = portal(KUECHE, true);
const wallSetup = async (admin) => {
  const r = await admin('POST', 'members', { userId: KUECHE.id, role: 'wall', birthdate: '2000-01-01', locateMode: 'auto' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.member;
};

test('the role wall: no family member anywhere, no app tab, portal tab only with the module on', () => withFamily({}, async (host, { admin, as, call }) => {
  const m = await wallSetup(admin);
  assert.deepEqual([m.role, m.birthdate, m.age, m.locatable], ['wall', null, null, false]);
  const st = await admin('GET', 'status');
  assert.deepEqual(st.json.members.map((x) => [x.userId, x.role]), [[ANNA.id, 'parent'], [MARC.id, 'parent'], [LENA.id, 'child'], [TIM.id, 'child'], [KUECHE.id, 'wall']]);
  assert.equal(st.json.users.find((u) => u.id === KUECHE.id).member, true);
  // module off (default): nothing for the tablet
  assert.equal(await host.portalVisible(KUECHE), false);
  assert.equal((await call(WALL, 'GET', '/wall')).json.code, 'module_off');
  assert.equal((await call(WALL, 'GET', '/me')).json.code, 'module_off');
  await admin('PUT', 'modules', { wall: true });
  assert.equal(await host.portalVisible(KUECHE), true);
  assert.equal(await host.appVisible(KUECHE), false, 'never an app tab');
  assert.equal(await host.plugin.appVisible(app(KUECHE), host.gc), false);
  const me = await call(WALL, 'GET', '/me');
  assert.deepEqual([me.json.me.role, me.json.me.locateMode, me.json.members.map((x) => x.userId)], ['wall', null, [ANNA.id, MARC.id, LENA.id, TIM.id]]);
  // the family never sees it
  const anna = await as(ANNA)('GET', '/me');
  assert.ok(!anna.json.members.some((x) => x.userId === KUECHE.id));
  assert.ok(!(await as(ANNA)('GET', '/emergency')).json.members.some((x) => x.userId === KUECHE.id));
  // nobody may assign it, it gets no pushes
  assert.equal((await as(ANNA)('POST', '/tasks', { title: 'x', assignees: [KUECHE.id] })).json.code, 'invalid');
  assert.equal((await as(ANNA)('POST', '/rides', { date: '2026-10-14', time: '16:00', title: 'x', driver: { userId: KUECHE.id } })).json.code, 'invalid');
  assert.equal((await as(ANNA)('POST', `/locate/${KUECHE.id}`)).status, 404);
  await as(ANNA)('POST', '/shopping/ops', { ops: [{ op: 'list_add', id: 'list-0000-0001', name: 'REWE' }] });
  await as(ANNA)('POST', '/shopping/lists/list-0000-0001/going');
  await as(TIM)('POST', '/sos', {});
  await as(TIM)('POST', '/rides', { date: '2026-10-14', time: '16:00', title: 'Bitte abholen' });
  for (const n of host.notifications) assert.ok(!n.users.includes(KUECHE.id), `${n.topic}: ${n.title}`);
  // a wall tablet becomes a child only with a birthdate
  assert.equal((await admin('PATCH', 'members/' + KUECHE.id, { role: 'child' })).json.code, 'invalid');
}));

test('wall restrictions: read, tick for the assignee, add / check shopping — nothing else (403 forbidden)', () => withFamily({ settings: { mod_wall: true } }, async (host, { admin, as, call }) => {
  await wallSetup(admin);
  const wall = (m, p, b, q) => call(WALL, m, p, b, q);
  for (const [m, p, b] of [
    ['GET', '/overview'], ['GET', '/emergency'], ['PUT', `/emergency/members/${TIM.id}`, {}], ['GET', '/places'], ['POST', '/places', {}], ['POST', `/locate/${TIM.id}`],
    ['GET', '/locate/requests'], ['POST', '/sos', {}], ['GET', '/sos'], ['POST', '/arrival', {}], ['POST', '/tasks', { title: 'x', assignees: [TIM.id] }],
    ['PATCH', '/tasks/1', { title: 'x' }], ['DELETE', '/tasks/1'], ['POST', '/tasks/1/snooze', { minutes: 30 }], ['POST', '/dates', { title: 'x', date: '2026-10-14' }],
    ['DELETE', '/dates/1'], ['POST', '/rides', { date: '2026-10-14', time: '16:00', title: 'x' }], ['POST', '/rides/1/take'], ['POST', '/rides/1/ask'],
    ['GET', '/rides/1'], ['POST', '/shopping/lists/list-0000-0001/going'], ['GET', '/tasks/1'], ['GET', '/nothing'],
  ]) {
    const r = await wall(m, p, b);
    assert.deepEqual([r.status, r.json.code], [403, 'forbidden'], `${m} ${p}`);
  }
  for (const p of ['/me', '/wall', '/dates', '/rides', '/tasks', '/shopping']) assert.equal((await wall('GET', p)).status, 200, p);

  // tasks: rotate → whose turn it is, fixed → each assignee, first → any assignee
  const rot = (await as(ANNA)('POST', '/tasks', { title: 'Müll raus', mode: 'rotate', assignees: [LENA.id, TIM.id], repeat: 'daily', stars: 2 })).json.task;
  const fix = (await as(ANNA)('POST', '/tasks', { title: 'Zimmer aufräumen', mode: 'fixed', assignees: [LENA.id, TIM.id], repeat: 'daily' })).json.task;
  const fst = (await as(ANNA)('POST', '/tasks', { title: 'Bad putzen', mode: 'first', assignees: [ANNA.id, MARC.id], repeat: 'daily', dueTime: '09:00' })).json.task;
  assert.equal((await wall('POST', `/tasks/${rot.id}/done`, { userId: TIM.id })).json.code, 'invalid', 'not Tim\'s turn');
  assert.equal((await wall('POST', `/tasks/${rot.id}/done`, {})).json.code, 'invalid', 'for whom?');
  assert.equal((await wall('POST', `/tasks/${fix.id}/done`, { userId: ANNA.id })).json.code, 'invalid', 'not an assignee');
  const d = await wall('POST', `/tasks/${rot.id}/done`, { userId: LENA.id });
  assert.deepEqual([d.status, d.json.starsBooked, d.json.task.current, d.json.task.lastDone.by], [200, 2, TIM.id, LENA.id]);
  assert.equal((await wall('POST', `/tasks/${fix.id}/done`, { userId: TIM.id })).status, 200);
  const from = host.notifications.length;
  assert.equal((await wall('POST', `/tasks/${fst.id}/done`, { userId: MARC.id })).status, 200);
  assert.equal(pushes(host, 'task_done', from).length, 0, 'no reminder was sent, so nothing to replace');

  // shopping: item_add and item_check only
  await as(ANNA)('POST', '/shopping/ops', { ops: [{ op: 'list_add', id: 'list-0000-0001', name: 'REWE' }, { op: 'item_add', id: 'item-0000-0001', listId: 'list-0000-0001', text: 'Milch', qty: '2×' }] });
  const ops = await wall('POST', '/shopping/ops', { ops: [
    { op: 'item_add', id: 'item-0000-0002', listId: 'list-0000-0001', text: 'Bananen' },
    { op: 'item_check', id: 'item-0000-0001', checked: true },
    { op: 'item_delete', id: 'item-0000-0002' },
    { op: 'list_add', id: 'list-0000-0002', name: 'DM' },
    { op: 'clear_checked', listId: 'list-0000-0001' },
  ] });
  assert.deepEqual([ops.json.applied, ops.json.rejected], [2, [{ index: 2, code: 'forbidden' }, { index: 3, code: 'forbidden' }, { index: 4, code: 'forbidden' }]]);

  // device trust: the wall reads, but changes nothing
  const trust = portal(KUECHE, false);
  assert.equal((await call(trust, 'GET', '/wall')).status, 200);
  assert.equal((await call(trust, 'POST', `/tasks/${fix.id}/done`, { userId: LENA.id })).json.code, 'login_required');
  assert.equal((await call(trust, 'GET', '/emergency')).json.code, 'forbidden');
}));

test('GET wall: today, tomorrow, birthdays, rides, tasks with chips, one shopping list; dark at night', () => withFamily({ settings: { mod_wall: true } }, async (host, { admin, as, call, clock }) => {
  await wallSetup(admin);
  await as(ANNA)('POST', '/dates', { title: 'Elternabend 4b', date: '2026-10-14', time: '19:00' });
  await as(ANNA)('POST', '/dates', { title: 'Gelbe Tonne', date: '2026-10-15' });
  await as(ANNA)('POST', '/dates', { title: 'Zahnarzt', date: '2026-10-16', time: '08:00' });
  await as(ANNA)('POST', '/dates', { title: 'Oma Helga', date: '1946-10-20', kind: 'birthday' });
  await as(ANNA)('POST', '/rides', { date: '2026-10-14', time: '16:00', title: 'Tim vom Training abholen', place: 'Sporthalle Nord', childIds: [TIM.id], lat: 50.9, lon: 6.9 });
  await as(ANNA)('POST', '/rides', { date: '2026-10-15', time: '16:00', title: 'Morgen', childIds: [TIM.id] });
  const rot = (await as(ANNA)('POST', '/tasks', { title: 'Müll raus', mode: 'rotate', assignees: [LENA.id, TIM.id], repeat: 'daily', stars: 2 })).json.task;
  const fix = (await as(ANNA)('POST', '/tasks', { title: 'Zimmer', mode: 'fixed', assignees: [LENA.id, TIM.id], repeat: 'daily', dueTime: '18:00' })).json.task;
  await as(ANNA)('POST', '/tasks', { title: 'Bad putzen', mode: 'first', assignees: [ANNA.id, MARC.id], dueDate: '2026-10-13' });
  await as(ANNA)('POST', '/tasks', { title: 'Morgen erst', mode: 'fixed', assignees: [ANNA.id], dueDate: '2026-10-15' });
  await as(ANNA)('POST', '/shopping/ops', { ops: [
    { op: 'list_add', id: 'list-0000-0001', name: 'REWE' }, { op: 'list_add', id: 'list-0000-0002', name: 'DM' },
    { op: 'item_add', id: 'item-0000-0001', listId: 'list-0000-0001', text: 'Milch', qty: '2×' },
    { op: 'item_add', id: 'item-0000-0002', listId: 'list-0000-0002', text: 'Zahnpasta' },
  ] });
  await call(WALL, 'POST', `/tasks/${fix.id}/done`, { userId: TIM.id });

  const w = (await call(WALL, 'GET', '/wall')).json;
  assert.deepEqual([w.date, w.time, w.timezone, w.dark, w.now], ['2026-10-14', '10:00', 'Europe/Berlin', false, '2026-10-14T08:00:00Z']);
  assert.deepEqual(w.members.map((m) => m.name), ['Anna', 'Marc', 'Lena', 'Tim']);
  assert.deepEqual(w.today.dates.map((e) => [e.title, e.time]), [['Elternabend 4b', '19:00']]);
  assert.deepEqual(w.today.tomorrow.map((e) => e.title), ['Gelbe Tonne']);
  assert.deepEqual(w.today.birthdays.map((b) => [b.title, b.years, b.inDays]), [['Oma Helga', 80, 6]]);
  assert.deepEqual(w.today.rides.map((r) => [r.title, r.status, r.lat]), [['Tim vom Training abholen', 'open', 50.9]]);
  const byTitle = Object.fromEntries(w.tasks.map((t) => [t.title, t]));
  assert.deepEqual(Object.keys(byTitle).sort(), ['Bad putzen', 'Müll raus', 'Zimmer']);
  assert.deepEqual(byTitle['Müll raus'].chips.map((c) => [c.name, c.done]), [['Lena', false]], 'rotate: whose turn it is');
  assert.deepEqual([byTitle['Müll raus'].stars, byTitle['Müll raus'].id], [2, rot.id]);
  assert.deepEqual(byTitle.Zimmer.chips.map((c) => [c.name, c.done]), [['Lena', false], ['Tim', true]], 'fixed: each assignee');
  assert.deepEqual([byTitle.Zimmer.done, byTitle.Zimmer.dueTime], [false, '18:00']);
  assert.deepEqual([byTitle['Bad putzen'].overdue, byTitle['Bad putzen'].chips.map((c) => c.name)], [true, ['Anna', 'Marc']], 'first: any assignee');
  assert.deepEqual([w.shopping.list, w.shopping.open, w.shopping.items], [{ id: 'list-0000-0001', name: 'REWE', icon: null }, 1, [{ id: 'item-0000-0001', text: 'Milch', qty: '2×' }]]);

  // the chosen list (page "Funktionen")
  assert.equal((await admin('PUT', 'wall', { listId: 'nope' })).json.code, 'invalid');
  assert.equal((await admin('PUT', 'wall', { listId: 'list-0000-0002' })).json.wall.listId, 'list-0000-0002');
  assert.equal((await admin('GET', 'status')).json.wall.listId, 'list-0000-0002');
  assert.deepEqual((await call(WALL, 'GET', '/wall')).json.shopping.items.map((i) => i.text), ['Zahnpasta']);
  await as(ANNA)('POST', '/shopping/ops', { ops: [{ op: 'list_delete', id: 'list-0000-0002' }] });
  assert.equal((await call(WALL, 'GET', '/wall')).json.shopping.list.name, 'REWE', 'a deleted list falls back to the first');

  // device trust: no coordinates of the rides
  assert.equal((await call(portal(KUECHE, false), 'GET', '/wall')).json.today.rides[0].lat, null);
  // modules off are null
  await admin('PUT', 'modules', { shopping: false, tasks: false });
  const off = (await call(WALL, 'GET', '/wall')).json;
  assert.deepEqual([off.shopping, off.tasks, off.modules.tasks], [null, null, false]);
  // dark 21:00–06:00 server time
  for (const [hh, dark] of [[20, false], [21, true], [23, true], [5, true], [6, false]]) {
    clock.set(Date.UTC(2026, 9, 14, hh - 2, 30));
    assert.equal((await call(WALL, 'GET', '/wall')).json.dark, dark, `${hh}:30`);
  }
  // a parent may look at the wall view as well
  assert.equal((await as(ANNA)('GET', '/wall')).status, 200);
}));

test('the portal tab of a wall tablet renders the wall view', () => withFamily({ settings: { mod_wall: true } }, async (host, { admin }) => {
  await wallSetup(admin);
  const w = (await host.render({ view: 'portal', user: WALL, loggedIn: true })).html;
  assert.ok(w.includes('id="fa-wall"') && !w.includes('fa-p-head'), 'wall view');
  assert.ok(w.includes('"page":"wall"'));
  const a = (await host.render({ view: 'portal', user: portal(ANNA), loggedIn: true })).html;
  assert.ok(a.includes('fa-p-head') && !a.includes('id="fa-wall"'), 'family portal');
}));

// 1.13.0: „Schule heute“ / „Schule morgen“ from the Schule plugin's service school_day — only with the plugin
// (GateControl ≥ 1.178.0 gc.services.available), cached 10 minutes per date (also a failure), names as the
// family knows them, the answer checked.
function schule(o = {}) {
  const s = {
    plugin: 'gatecontrol-schule', provides: ['school_students', 'school_day'], calls: [],
    service: async (c) => {
      if (c.name !== 'school_day') return { ok: true, students: [] };
      s.calls.push(c.payload.date);
      if (o.fail) throw new Error('down');
      return o.answer ? o.answer(c) : {
        ok: true, date: c.payload.date, students: [
          { userId: LENA.id, name: 'Lena M.', start: '07:45', end: '13:05', cancelled: 1, changed: 0, exams: [{ subject: 'Mathe', name: 'Klassenarbeit 2' }], free: false },
          { userId: TIM.id, name: 'Tim M.', cancelled: 0, changed: 0, exams: [], free: true },
          { userId: 99, name: '<img src=x onerror=alert(1)>', start: '8 Uhr', end: '13:05', cancelled: -3, changed: 'x', holiday: 'Herbstferien', exams: [{}, 'x', { subject: 'D' }], free: true },
          { userId: 'x', name: 'kaputt' },
        ],
      };
    },
  };
  return s;
}

test('GET wall: „Schule heute“ (from 15:00 „Schule morgen“) from the Schule plugin, cached 10 minutes per date', () => {
  const s = schule();
  return withFamily({ settings: { mod_wall: true }, services: [s], gatecontrol: '1.178.0' }, async (host, { admin, call, clock }) => {
    await wallSetup(admin);
    const w = (await call(WALL, 'GET', '/wall')).json;
    assert.deepEqual(w.school, {
      day: 'today', date: '2026-10-14', students: [
        { userId: LENA.id, name: 'Lena', start: '07:45', end: '13:05', cancelled: 1, changed: 0, holiday: null, exams: [{ subject: 'Mathe', name: 'Klassenarbeit 2' }], free: false },
        { userId: TIM.id, name: 'Tim', start: null, end: null, cancelled: 0, changed: 0, holiday: null, exams: [], free: true },
        { userId: 99, name: '<img src=x onerror=alert(1)>', start: null, end: '13:05', cancelled: 0, changed: 0, holiday: 'Herbstferien', exams: [{ subject: 'D', name: '' }], free: true },
      ],
    });
    assert.deepEqual(s.calls, ['2026-10-14']);
    // the wall polls every minute: one call per date in 10 minutes
    for (let i = 0; i < 9; i++) { clock.add(MIN); await call(WALL, 'GET', '/wall'); }
    assert.equal(s.calls.length, 1);
    clock.add(MIN);
    await call(WALL, 'GET', '/wall');
    assert.deepEqual(s.calls, ['2026-10-14', '2026-10-14']);
    // 15:00: tomorrow
    clock.set(Date.UTC(2026, 9, 14, 13, 0, 0));
    const t = (await call(WALL, 'GET', '/wall')).json.school;
    assert.deepEqual([t.day, t.date], ['tomorrow', '2026-10-15']);
    assert.deepEqual(s.calls, ['2026-10-14', '2026-10-14', '2026-10-15']);
    // the members' view of the wall is the same call (GET wall is the wall's own)
    assert.equal((await call({ ...ANNA, portal: true, loggedIn: true }, 'GET', '/wall')).json.school.day, 'tomorrow');
    assert.equal(s.calls.length, 3, 'from the cache');
  });
});

test('GET wall: no school section without the Schule plugin, on an older GateControl, without students; a failure is cached too', async () => {
  for (const o of [{}, { services: [schule()] }, { gatecontrol: '1.178.0' }]) {
    await withFamily({ settings: { mod_wall: true }, ...o }, async (host, { admin, call }) => {
      await wallSetup(admin);
      assert.equal((await call(WALL, 'GET', '/wall')).json.school, null);
    });
  }
  const empty = schule({ answer: () => ({ ok: true, students: [] }) });
  await withFamily({ settings: { mod_wall: true }, services: [empty], gatecontrol: '1.178.0' }, async (host, { admin, call }) => {
    await wallSetup(admin);
    assert.equal((await call(WALL, 'GET', '/wall')).json.school, null);
  });
  const down = schule({ fail: true });
  await withFamily({ settings: { mod_wall: true }, services: [down], gatecontrol: '1.178.0' }, async (host, { admin, call, clock }) => {
    await wallSetup(admin);
    assert.equal((await call(WALL, 'GET', '/wall')).status, 200);
    clock.add(5 * MIN);
    assert.equal((await call(WALL, 'GET', '/wall')).json.school, null);
    assert.equal(down.calls.length, 1, 'not again within 10 minutes');
  });
});

test('the wall view renders the school section safely (textContent only)', () => {
  const ui = require('../server/ui');
  const t = (lang, k) => require('../server/texts.json')[lang][k] || k;
  const html = ui.render({ view: 'portal', wall: true, loggedIn: true, lang: 'de' }, t);
  assert.ok(html.includes('id="fa-w-school"') && html.includes('Schule heute') && html.includes('function renderSchool()'));
  const js = html.slice(html.indexOf('function renderSchool()'), html.indexOf('function done('));
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(js), 'no HTML from data');
  assert.ok(html.includes('.fa-w-school{'), 'styled like the wall');
});
