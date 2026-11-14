'use strict';

// 1.24.0 — the tasks and place reminders in „Notizen & Aufgaben“ (server/tasksync.js), tested against the real hub
// (plugins/gatecontrol-notizen ≥ 1.6.0 in a mock host of its own, the two wired through their services): only Familie
// → nothing changes; the move by its button with the preview, again without anything twice, cut short and gone on; both
// directions afterwards (the old API of Familie, the wall tablet, a task from a chat — and the hub's own routes); the
// stars booked in Familie when a task is ticked off in the hub, taken back with „Noch nicht fertig“; no reminder twice;
// the place reminders and which phone watches them; the hub away, back, forgotten; „Zurückholen“ and the move again.
// The clock is the helpers' (2026-10-14 10:00 in Berlin, a Wednesday) and only ever set.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');
const { withFamily, ADMIN, ANNA, MARC, LENA, TIM, KUECHE, USERS, MIN, HOUR, DAY, app, kioskViewer, pushes } = require('./helpers');
const tasksync = require('../server/tasksync');
const shopsync = require('../server/shopsync');

const NZ_DIR = path.join(__dirname, '..', '..', 'gatecontrol-notizen');
const nz = (f) => require(path.join(NZ_DIR, 'server', f));
const HUB = 'gatecontrol-notizen';
const FAM = 'gatecontrol-familie';
const HOME = { lat: 52.5301, lon: 13.4102, radius: 150 };

/** Familie (the helpers' family) and the real hub, each in its own mock host — see test/shopmove.test.js. */
async function linked(o, fn) {
  const entry = { plugin: HUB, provides: require(path.join(NZ_DIR, 'plugin.json')).services.provides, service: null };
  return withFamily({ gatecontrol: '1.216.0', ...o, services: o.hub === false ? [] : [entry] }, async (famHost, ctx) => {
    tasksync.state.noTimer = true;
    shopsync.state.noTimer = true;
    nz('clock.js').set(null); // the hub's clock is the mocked Date of the helpers
    nz('config.js').reset();
    nz('people.js').reset();
    let hubHost = null;
    const flaky = { after: null, calls: 0 };
    const start = async () => {
      hubHost = await createHost(NZ_DIR, {
        gatecontrol: '1.216.0', users: USERS, license: { required: true, licensed: true, state: 'valid', expiresAt: null },
        services: [{ plugin: FAM, provides: require('../plugin.json').services.provides, service: (c) => famHost.callService(c.name, { caller: c.caller, user: c.user, payload: c.payload }) }],
      });
      await hubHost.start();
      nz('famtasks.js').state.noTimer = true;
      nz('shopping.js').state.noTimer = true;
      entry.service = async (c) => {
        // a hub that breaks off in the middle: after `flaky.after` calls of tasks_put it answers nothing any more
        if (c.name === 'tasks_put' && flaky.after != null && ++flaky.calls > flaky.after) throw Object.assign(new Error('down'), { code: 'ERR_SERVICE_FAILED' });
        return hubHost.callService(c.name, { caller: c.caller, user: c.user, payload: c.payload });
      };
    };
    if (o.hub !== false) await start();
    const req = (host) => (user) => (method, p, body, query) => host.request({ method, path: p, body: body === undefined ? null : body, query: query || {}, user: app(user), lang: 'de' });
    const x = {
      famHost, clock: ctx.clock, admin: ctx.admin, fam: req(famHost), hub: (user) => req(hubHost)(user), hubHost: () => hubHost, flaky,
      async both() { if (hubHost && entry.service) await hubHost.tick(); await famHost.tick(); if (hubHost && entry.service) await hubHost.tick(); },
      hubOff() { entry.saved = entry.service; entry.service = null; tasksync.state.hub = null; },
      hubOn() { entry.service = entry.saved; tasksync.state.hub = null; },
      async freshHub() { await hubHost.close(); await start(); tasksync.state.hub = null; },
      hubCalls: () => famHost.serviceCalls.filter((c) => c.plugin === HUB && /^tasks_/.test(c.service)),
      wall: (method, p, body) => famHost.request({ method, path: p, body: body === undefined ? null : body, query: {}, user: kioskViewer(KUECHE), lang: 'de' }),
    };
    try { return await fn(x); } finally { if (hubHost) await hubHost.close(); }
  });
}

/** The family's tasks and place reminders of the tests → their ids. */
async function seed(x) {
  const anna = x.fam(ANNA);
  const mk = async (body) => (await anna('POST', '/tasks', body)).json.task.id;
  const ids = {
    room: await mk({ title: 'Zimmer aufräumen', assignees: [LENA.id], dueTime: '17:00', stars: 2 }),
    each: await mk({ title: 'Zähne putzen', assignees: [LENA.id, TIM.id], repeat: 'daily', stars: 1 }),
    dish: await mk({ title: 'Spülmaschine', mode: 'rotate', assignees: [LENA.id, TIM.id], repeat: 'daily', dueTime: '18:00' }),
    plants: await mk({ title: 'Blumen gießen', mode: 'first', assignees: [ANNA.id, MARC.id, LENA.id], repeat: 'weekly', weekdays: [3] }),
    paper: await mk({ title: 'Altpapier', assignees: [TIM.id], stars: 1 }),
  };
  assert.equal((await x.fam(TIM)('POST', `/tasks/${ids.paper}/done`, {})).json.starsBooked, 1);
  const pl = async (user, body) => (await x.fam(user)('POST', '/places', { ...HOME, ...body })).json.place.id;
  ids.pOwn = await pl(ANNA, { title: 'Paket abholen', note: 'Abholschein' });
  ids.pMarc = await pl(ANNA, { title: 'Milch mitbringen', targetUserId: MARC.id, trigger: 'exit' });
  ids.pTell = await pl(ANNA, { title: 'Schule', targetUserId: ANNA.id, action: 'tell', tellUserIds: [MARC.id] });
  ids.pOff = await pl(MARC, { title: 'Aus', active: false });
  return ids;
}
const famTasks = async (x, user = ANNA) => (await x.fam(user)('GET', '/tasks')).json;
const hubFamily = async (x, user = ANNA) => {
  const me = (await x.hub(user)('GET', 'me')).json;
  const v = (await x.hub(user)('GET', `views/list:${me.familyTasks.listId}`)).json;
  return v.sections.flatMap((s) => s.items);
};
const titles = (list) => list.map((t) => t.title).sort();
const stars = async (x) => (await famTasks(x)).stars.week;

test('only Familie installed: everything as before — no hub, no move, nothing sent', () => linked({ hub: false }, async (x) => {
  const ids = await seed(x);
  assert.deepEqual((await x.fam(ANNA)('GET', '/me')).json.features, ['shoppingHome', 'tasksHome']);
  const pv = (await x.fam(ANNA)('GET', '/tasks/move')).json;
  assert.deepEqual([pv.tasks, pv.split, pv.rotate, pv.first, pv.places, pv.placesOthers, pv.placesTell, pv.placesOff, pv.hub, pv.moved, pv.canMove, pv.canBack, pv.home],
    [6, 1, 1, 1, 2, 1, 1, 1, { available: false }, false, false, false, { home: 'familie', since: null }]);
  const mv = await x.fam(ANNA)('POST', '/tasks/move', {});
  assert.deepEqual([mv.status, mv.json.code, mv.json.reason], [409, 'unavailable', 'hub']);
  x.clock.set(Date.UTC(2026, 9, 14, 16, 1));
  await x.famHost.tick();
  assert.ok(pushes(x.famHost, 'task_due').length >= 3, 'Familie reminds as ever');
  const g = await famTasks(x);
  assert.deepEqual([g.home, g.tasks.length, (await x.fam(ANNA)('GET', '/overview')).json.tasks.home], [{ home: 'familie', since: null }, 5, { home: 'familie', since: null }]);
  assert.equal((await x.fam(ANNA)('GET', '/places')).json.places.find((p) => p.id === ids.pOwn).home, 'familie');
  assert.deepEqual(x.famHost.serviceCalls.filter((c) => c.plugin === HUB), []);
}));

test('the hub installed but no move: Familie owns its tasks, no task service is called, the hub shows them as its items', () => linked({}, async (x) => {
  await seed(x);
  await x.both();
  x.clock.add(6 * MIN);
  await x.both();
  assert.deepEqual(x.hubCalls(), [], 'no task service is called without the button');
  assert.deepEqual((await x.hub(ANNA)('GET', 'me')).json.familyTasks, { available: true, bound: false, listId: null, parent: false, stars: false, starsMax: 10, moved: null });
  const day = (await x.hub(LENA)('GET', 'views/myday')).json.sections.flatMap((s) => s.items).filter((i) => i.type === 'source').map((i) => i.title);
  assert.ok(day.includes('Zimmer aufräumen'));
}));

test('the move: a preview, the button, everything by its id — again makes nothing twice; who may', () => linked({}, async (x) => {
  const ids = await seed(x);
  assert.equal((await x.fam(LENA)('GET', '/tasks/move')).json.code, 'parents_only');
  assert.equal((await x.fam(LENA)('POST', '/tasks/move', {})).json.code, 'parents_only');
  const pv = (await x.admin('GET', 'tasks')).json.tasks;
  assert.deepEqual([pv.tasks, pv.repeating, pv.split, pv.stars, pv.places, pv.placesOthers, pv.placesTell, pv.placesOff, pv.canMove], [6, 4, 1, 4, 2, 1, 1, 1, true]);
  const mv = await x.admin('POST', 'tasks/move', {});
  assert.deepEqual([mv.status, mv.json.moved, mv.json.pending, mv.json.home.home, mv.json.tasks.moved, mv.json.tasks.canMove, mv.json.tasks.canBack], [200, { tasks: 6, places: 2 }, 0, 'notizen', true, false, true]);
  // Familie: „jeder für sich“ is one task per person now (the done rows and stars with them); the tasks say where they live
  const g = await famTasks(x);
  assert.deepEqual([g.home.home, titles(g.tasks), g.stars.week], ['notizen', ['Altpapier', 'Blumen gießen', 'Spülmaschine', 'Zimmer aufräumen', 'Zähne putzen', 'Zähne putzen'], { [LENA.id]: 0, [TIM.id]: 1 }]);
  assert.deepEqual(g.tasks.filter((t) => t.title === 'Zähne putzen').map((t) => t.assignees), [[LENA.id], [TIM.id]]);
  // the hub: the list „Familie“ of the whole family with every task as it was — whose turn, the stars, the repeats
  const me = (await x.hub(LENA)('GET', 'me')).json.familyTasks;
  assert.deepEqual([me.bound, me.parent, me.stars, me.moved.tasks, me.moved.places, me.moved.seen], [true, false, true, 6, 2, false]);
  const hub = await hubFamily(x, LENA);
  assert.deepEqual(titles(hub), ['Altpapier', 'Blumen gießen', 'Spülmaschine', 'Zimmer aufräumen', 'Zähne putzen', 'Zähne putzen']);
  const by = (t) => hub.find((h) => h.title === t);
  assert.deepEqual([by('Zimmer aufräumen').stars, by('Zimmer aufräumen').assignee.id, by('Zimmer aufräumen').due, by('Zimmer aufräumen').canEdit, by('Zimmer aufräumen').family],
    [2, LENA.id, { date: '2026-10-14', time: '17:00' }, false, true]);
  assert.deepEqual([by('Spülmaschine').turn, by('Spülmaschine').people.map((u) => u.id), by('Spülmaschine').assignee.id, by('Spülmaschine').repeat.type], ['rotate', [LENA.id, TIM.id], LENA.id, 'daily']);
  assert.deepEqual([by('Blumen gießen').turn, by('Blumen gießen').people.length, by('Blumen gießen').repeat.days], ['first', 3, [3]]);
  assert.deepEqual([by('Altpapier').done, by('Altpapier').doneBy.id], [true, TIM.id]);
  // the place reminders: Anna's own in her list, the one for Marc in a list only the two see (his answer still open);
  // the one that tells Marc and the one that is off stay Familie's
  const annaAll = (await x.hub(ANNA)('GET', 'lists')).json.lists;
  assert.deepEqual(annaAll.map((l) => l.name).sort(), ['Aufgaben', 'Erinnerungen Anna & Marc', 'Familie']);
  assert.equal((await x.hub(LENA)('GET', 'lists')).json.lists.some((l) => /Erinnerungen/.test(l.name)), false);
  const pair = (await x.hub(MARC)('GET', `views/list:${annaAll.find((l) => /Erinnerungen/.test(l.name)).id}`)).json.sections.flatMap((s) => s.items);
  assert.deepEqual(pair.map((t) => [t.title, t.place.trigger, t.place.consent, t.place.canConsent, t.assignee.id]), [['Milch mitbringen', 'exit', 'pending', true, MARC.id]]);
  const fp = (await x.fam(ANNA)('GET', '/places')).json.places;
  assert.deepEqual(fp.map((p) => [p.title, p.moved, p.home, p.active]), [['Paket abholen', true, 'familie', true], ['Milch mitbringen', true, 'familie', true], ['Schule', false, 'familie', true]]);
  // again (the button twice, the background run): nothing twice, nothing written
  const before = x.hubCalls().length;
  const again = await x.fam(ANNA)('POST', '/tasks/move', {});
  assert.deepEqual([again.status, again.json.moved, again.json.pending], [200, { tasks: 6, places: 2 }, 0]);
  await x.both();
  assert.deepEqual(titles(await hubFamily(x)), titles(hub));
  assert.equal((await x.hub(ANNA)('GET', 'lists')).json.lists.length, 3);
  assert.ok(x.hubCalls().slice(before).every((c) => c.service !== 'tasks_put'), 'nothing is sent a second time');
  assert.ok(ids.room > 0);
}));

test('cut short and gone on: the hub breaks off in the middle — the move stands, goes on by itself, nothing twice', () => linked({}, async (x) => {
  const anna = x.fam(ANNA);
  for (let i = 0; i < 60; i++) await anna('POST', '/tasks', { title: `Aufgabe ${i}`, assignees: [i % 2 ? LENA.id : TIM.id], repeat: i % 3 ? 'none' : 'daily' });
  x.flaky.after = 1;
  const mv = await anna('POST', '/tasks/move', {});
  assert.deepEqual([mv.status, mv.json.code, mv.json.reason, mv.json.moved, mv.json.pending], [409, 'unavailable', 'hub', true, 35]);
  let pv = (await anna('GET', '/tasks/move')).json;
  assert.deepEqual([pv.moved, pv.pending, pv.canMove, pv.home.home], [true, 35, true, 'notizen']);
  assert.equal((await hubFamily(x)).length, 25);
  // Familie still reminds of what the hub has not got yet — and of nothing the hub has
  x.clock.set(Date.UTC(2026, 9, 14, 6, 1));
  await x.famHost.tick();
  assert.equal(pushes(x.famHost, 'task_due').reduce((n, p) => n + p.users.length, 0), 35);
  // the hub is back: the button again (or just the background run) sends the rest — every task once
  x.flaky.after = null;
  const go = await anna('POST', '/tasks/move', {});
  assert.deepEqual([go.status, go.json.pending, go.json.moved], [200, 0, { tasks: 60, places: 0 }]);
  pv = (await anna('GET', '/tasks/move')).json;
  assert.deepEqual([pv.pending, pv.canMove, pv.canBack], [0, false, true]);
  const hub = await hubFamily(x);
  assert.deepEqual([hub.length, new Set(hub.map((t) => t.title)).size], [60, 60]);
}));

test('after the move: ticked off in the hub books the stars in Familie, „Noch nicht fertig“ takes them back; the old API, the wall and the chat work on', () => linked({ settings: { mod_wall: true } }, async (x) => {
  await x.admin('POST', 'members', { userId: KUECHE.id, role: 'wall' });
  const ids = await seed(x);
  await x.admin('POST', 'tasks/move', {});
  const hubId = async (title, user = ANNA) => (await hubFamily(x, user)).find((t) => t.title === title && !t.done).id;
  // Lena ticks „Zimmer aufräumen“ off in the hub: Familie books her 2 stars — once, however often it is fetched
  const room = await hubId('Zimmer aufräumen');
  assert.equal((await x.hub(LENA)('POST', `tasks/${room}/complete`, { done: true })).status, 200);
  await x.both();
  await x.both();
  let g = await famTasks(x, LENA);
  assert.deepEqual([g.stars.week[LENA.id], g.tasks.find((t) => t.id === ids.room).doneToday, g.tasks.find((t) => t.id === ids.room).completed], [2, true, true]);
  // the parents heard of it from the hub; „Noch nicht fertig“: open again in both, the stars are gone
  const fb = x.hubHost().notifications.filter((n) => n.data && n.data.notizen && n.data.notizen.kind === 'done_feedback');
  assert.deepEqual([fb.length, fb[0].title, fb[0].body], [1, 'Lena hat „Zimmer aufräumen“ erledigt', '2 Sterne gutgeschrieben · Familie']);
  assert.deepEqual(await x.hubHost().notifyAction({ userId: ANNA.id, notificationId: 1, action: 'not_done', data: { notizen: fb[0].data.notizen } }), { ok: true, undone: true });
  await x.both();
  g = await famTasks(x, LENA);
  assert.deepEqual([g.stars.week[LENA.id], g.tasks.find((t) => t.id === ids.room).doneToday], [0, false]);
  // an older app: Lena ticks „Spülmaschine“ off through Familie's API (her turn): the hub's task is done, its next one
  // is Tim's (Familie's turn), nothing is booked twice and no parent is told twice
  const dish = await hubId('Spülmaschine');
  const d = (await x.fam(LENA)('POST', `/tasks/${ids.dish}/done`, {})).json;
  assert.deepEqual([d.alreadyDone, d.task.current, d.task.doneToday], [false, TIM.id, true]);
  await x.both();
  const old = (await x.hub(ANNA)('GET', `tasks/${dish}`)).json.task;
  const next = (await hubFamily(x)).find((t) => t.title === 'Spülmaschine' && !t.done);
  assert.deepEqual([old.done, old.doneBy.id, next.assignee.id, next.due.date, next.turn], [true, LENA.id, TIM.id, '2026-10-15', 'rotate']);
  assert.equal(x.hubHost().notifications.filter((n) => n.data && n.data.notizen && n.data.notizen.kind === 'done_feedback').length, 1);
  // … and the other way round the next day: Tim ticks it off in the hub — Familie's turn goes on to Lena
  x.clock.set(Date.UTC(2026, 9, 15, 8, 0));
  await x.hub(TIM)('POST', `tasks/${next.id}/complete`, { done: true });
  await x.both();
  const ft = (await famTasks(x)).tasks.find((t) => t.id === ids.dish);
  assert.deepEqual([ft.current, ft.doneToday, ft.dueDate, ft.doneBy], [LENA.id, true, '2026-10-15', [TIM.id]]);
  // a task made in the hub (by a parent, with stars, „wer zuerst“) is in Familie: its API, the wall tablet with a chip per person
  const made = (await x.hub(MARC)('POST', 'tasks', { title: 'Müll rausbringen', listId: (await x.hub(MARC)('GET', 'me')).json.familyTasks.listId, turn: 'first', people: [LENA.id, TIM.id], stars: 3, due: { date: '2026-10-15' } })).json.task;
  await x.both();
  const mirrored = (await famTasks(x)).tasks.find((t) => t.title === 'Müll rausbringen');
  assert.deepEqual([mirrored.mode, mirrored.assignees, mirrored.stars, mirrored.dueDate, mirrored.createdBy], ['first', [LENA.id, TIM.id], 3, '2026-10-15', MARC.id]);
  const wall = (await x.wall('GET', '/wall')).json;
  const row = wall.tasks.find((t) => t.title === 'Müll rausbringen');
  assert.deepEqual([row.mode, row.stars, row.chips.map((c) => [c.userId, c.done])], ['first', 3, [[LENA.id, false], [TIM.id, false]]]);
  // the wall tablet ticks it off for Tim: done in the hub for all, Tim's 3 stars booked in Familie only once
  assert.equal((await x.wall('POST', `/tasks/${mirrored.id}/done`, { userId: TIM.id })).json.starsBooked, 3);
  await x.both();
  const hubDone = (await x.hub(LENA)('GET', `tasks/${made.id}`)).json.task;
  assert.deepEqual([hubDone.done, hubDone.doneBy.id, (await stars(x))[TIM.id]], [true, TIM.id, 4]);
  await x.both();
  assert.equal((await stars(x))[TIM.id], 4);
  // a task from a chat is made in Familie and lives in the hub; „Erledigt“ on its card ticks it off there
  const quick = (await x.fam(ANNA)('POST', '/tasks/quick', { title: 'Brot holen', assigneeId: LENA.id })).json.task;
  await x.both();
  assert.ok((await hubFamily(x)).some((t) => t.title === 'Brot holen' && t.assignee.id === LENA.id));
  const qa = await x.famHost.runQuickAction(LENA, `task-done:${quick.id}`, 'de', { via: 'gatecontrol-messenger', automation: true });
  assert.equal(qa.status, 200);
  await x.both();
  assert.equal((await hubFamily(x)).find((t) => t.title === 'Brot holen').done, true);
  // changed and deleted on either side
  await x.fam(ANNA)('PATCH', `/tasks/${ids.plants}`, { title: 'Alle Blumen gießen', dueTime: '09:30' });
  await x.both();
  const plants = (await hubFamily(x)).find((t) => t.title === 'Alle Blumen gießen');
  assert.deepEqual([plants.due.time, plants.turn], ['09:30', 'first']);
  await x.hub(ANNA)('PATCH', `tasks/${plants.id}`, { title: 'Blumen und Kräuter gießen' });
  await x.both();
  assert.equal((await famTasks(x)).tasks.find((t) => t.id === ids.plants).title, 'Blumen und Kräuter gießen');
  await x.hub(ANNA)('DELETE', `tasks/${plants.id}`);
  await x.both();
  assert.equal((await famTasks(x)).tasks.some((t) => t.id === ids.plants), false);
  const teeth = (await famTasks(x)).tasks.find((t) => t.title === 'Zähne putzen' && t.assignees[0] === TIM.id);
  assert.equal((await x.fam(ANNA)('DELETE', `/tasks/${teeth.id}`)).status, 200);
  await x.both();
  assert.equal((await hubFamily(x)).filter((t) => t.title === 'Zähne putzen' && !t.done).length, 1);
  // nothing is shown twice in „Mein Tag“ of the hub: Familie reports no task as its own item any more
  const day = (await x.hub(LENA)('GET', 'views/myday')).json.sections.flatMap((s) => s.items);
  assert.deepEqual(day.filter((i) => i.type === 'source' && i.source.plugin === FAM && i.kind === 'task' && !(i.meta && i.meta.type)).length, 0);
}));

test('no reminder twice: the hub reminds of what it has, Familie of nothing — and of everything again while the hub is away', () => linked({}, async (x) => {
  await seed(x);
  await x.admin('POST', 'tasks/move', {});
  const n0 = pushes(x.famHost, 'task_due').length;
  // 18:01 in Berlin: Zimmer 17:00 and Spülmaschine 18:00 are due — what had no time was due at 08:00, before the move
  x.clock.set(Date.UTC(2026, 9, 14, 16, 1));
  await x.both();
  assert.equal(pushes(x.famHost, 'task_due').length, n0, 'Familie keeps quiet');
  const rem = () => x.hubHost().notifications.filter((n) => n.data && n.data.notizen && n.data.notizen.kind === 'reminder').map((n) => [n.title, n.users.slice().sort()]).sort();
  assert.deepEqual(rem(), [['Spülmaschine', [LENA.id]], ['Zimmer aufräumen', [LENA.id]]]);
  // … and the next occurrence of one without a time has its reminder at 08:00 in the hub: Lena does her teeth, the hub
  // reminds her the next morning (and of „wer zuerst“ everybody)
  const teeth0 = (await hubFamily(x, LENA)).find((h) => h.title === 'Zähne putzen' && h.assignee.id === LENA.id);
  await x.hub(LENA)('POST', `tasks/${teeth0.id}/complete`, { done: true });
  x.clock.set(Date.UTC(2026, 9, 15, 6, 1));
  await x.both();
  assert.deepEqual(rem().filter((r) => r[0] === 'Zähne putzen'), [['Zähne putzen', [LENA.id]]]);
  assert.equal(pushes(x.famHost, 'task_due').length, n0, 'Familie still keeps quiet');
  // the hub goes away (stopped, removed): the tasks are Familie's again for the apps, and it reminds — the next day, of all
  x.hubOff();
  x.clock.set(Date.UTC(2026, 9, 15, 16, 1));
  await x.famHost.tick();
  assert.equal((await famTasks(x)).home.home, 'familie');
  // (what the hub reminded of this morning rings once more: Familie cannot know — only on the day the hub goes away)
  assert.equal(pushes(x.famHost, 'task_due').length - n0, 3, 'Spülmaschine at 18:00 and the two „Zähne putzen“ of today');
  // ticked off meanwhile through Familie (the stars are booked here at once); the hub comes back and catches up
  const teeth = (await famTasks(x)).tasks.find((t) => t.title === 'Zähne putzen' && t.assignees[0] === LENA.id);
  assert.equal((await x.fam(LENA)('POST', `/tasks/${teeth.id}/done`, {})).json.starsBooked, 1);
  x.hubOn();
  await x.both();
  assert.equal((await famTasks(x)).home.home, 'notizen');
  const t = (await hubFamily(x, LENA)).filter((h) => h.title === 'Zähne putzen' && h.assignee.id === LENA.id && !h.done);
  assert.deepEqual(t.map((h) => h.due.date), ['2026-10-16']);
  assert.equal((await stars(x))[LENA.id], 2, 'a star for each of the two days — one ticked off in the hub, one in Familie');
}));

test('the place reminders: which phone watches them — the hub\'s for a phone that asks the hub, Familie\'s for any other; never both', () => linked({}, async (x) => {
  const ids = await seed(x);
  await x.fam(MARC)('POST', `/places/${ids.pMarc}/consent`, { accept: true });
  await x.admin('POST', 'tasks/move', {});
  const mine = async (u) => (await x.fam(u)('GET', '/places')).json.places.filter((p) => p.targetUserId === u.id).map((p) => [p.title, p.active, p.home]);
  // an older app (it never asks the hub): Familie hands it its reminders as ever
  assert.deepEqual(await mine(MARC), [['Milch mitbringen', true, 'familie'], ['Aus', false, 'familie']]);
  // Marc's new app asks the hub which places to watch: the hub hands it the reminder as a task at a place — with all the
  // room the phone has, for Familie counts the moved one no longer — and Familie hands it to that phone no more
  const w = (await x.hub(MARC)('POST', 'places/watch', {})).json;
  assert.deepEqual([w.fences.map((f) => f.tasks.map((t) => [t.title, t.trigger])), w.max], [[[['Milch mitbringen', 'exit']]], 60]);
  assert.deepEqual(await mine(MARC), [['Milch mitbringen', false, 'notizen'], ['Aus', false, 'familie']]);
  // Anna's phone: the one that tells Marc stays Familie's and is counted; her own one is the hub's once she asks it
  assert.deepEqual(await mine(ANNA), [['Paket abholen', true, 'familie'], ['Schule', true, 'familie']]);
  const wa = (await x.hub(ANNA)('POST', 'places/watch', {})).json;
  assert.deepEqual([wa.fences.length, wa.max], [1, 60]);
  assert.deepEqual(await mine(ANNA), [['Paket abholen', false, 'notizen'], ['Schule', true, 'familie']]);
  // done in the hub: off in Familie; a new answer in the hub is Familie's too; deleted in Familie: in the hub's trash
  const own = wa.fences[0].tasks[0].taskId;
  await x.hub(ANNA)('POST', `tasks/${own}/complete`, { done: true });
  await x.hub(MARC)('POST', `tasks/${w.fences[0].tasks[0].taskId}/place/consent`, { accept: false });
  await x.both();
  const all = (await x.fam(ANNA)('GET', '/places')).json.places;
  assert.deepEqual(all.map((p) => [p.title, p.active, p.consent]), [['Paket abholen', false, 'accepted'], ['Milch mitbringen', false, 'declined'], ['Schule', true, 'accepted']]);
  assert.equal((await x.fam(ANNA)('DELETE', `/places/${ids.pMarc}`)).status, 200);
  await x.both();
  assert.equal((await x.hub(MARC)('GET', `tasks/${w.fences[0].tasks[0].taskId}`)).status, 404);
  // a reminder made in Familie after the move (an older app) lives in the hub at once; one that tells others never
  const fresh = (await x.fam(MARC)('POST', '/places', { ...HOME, title: 'Apotheke', repeat: 'once' })).json.place;
  await x.fam(MARC)('POST', '/places', { ...HOME, title: 'Bescheid', action: 'tell', tellUserIds: [ANNA.id] });
  await x.both();
  const w2 = (await x.hub(MARC)('POST', 'places/watch', {})).json;
  assert.deepEqual(w2.fences.flatMap((f) => f.tasks.map((t) => t.title)), ['Apotheke']);
  // … it fires once on an old phone (reported to Familie): off there, done in the hub
  await x.fam(MARC)('POST', `/places/${fresh.id}/triggered`, { transition: 'enter' });
  await x.both();
  assert.deepEqual((await x.hub(MARC)('POST', 'places/watch', {})).json.fences, []);
}));

test('the hub forgets (a fresh hub): the tasks are Familie\'s own again; „Zurückholen“ and the move again — nothing twice, nothing lost', () => linked({}, async (x) => {
  const ids = await seed(x);
  await x.admin('POST', 'tasks/move', {});
  await x.freshHub();
  x.clock.add(6 * MIN);
  await x.both();
  let pv = (await x.admin('GET', 'tasks')).json.tasks;
  assert.deepEqual([pv.moved, pv.canMove, pv.home.home, pv.tasks, pv.places], [false, true, 'familie', 6, 2]);
  assert.equal((await x.fam(ANNA)('GET', '/places')).json.places.find((p) => p.id === ids.pOwn).moved, false);
  // move again into the fresh hub, work there, then bring everything back
  await x.admin('POST', 'tasks/move', {});
  const listId = (await x.hub(ANNA)('GET', 'me')).json.familyTasks.listId;
  await x.hub(ANNA)('POST', 'tasks', { title: 'Im Hub angelegt', listId, assigneeId: TIM.id, stars: 2 });
  const room = (await hubFamily(x)).find((t) => t.title === 'Zimmer aufräumen');
  await x.hub(LENA)('POST', `tasks/${room.id}/complete`, { done: true });
  const back = await x.admin('POST', 'tasks/move', { back: true });
  assert.deepEqual([back.status, back.json.home.home, back.json.tasks.moved, back.json.tasks.canMove], [200, 'familie', false, true]);
  // Familie has everything, with what happened in the hub last (the new task, Lena's stars); it reminds itself again
  const g = await famTasks(x);
  assert.deepEqual([g.home.home, titles(g.tasks), g.stars.week], ['familie', ['Altpapier', 'Blumen gießen', 'Im Hub angelegt', 'Spülmaschine', 'Zimmer aufräumen', 'Zähne putzen', 'Zähne putzen'], { [LENA.id]: 2, [TIM.id]: 1 }]);
  assert.deepEqual((await x.fam(ANNA)('GET', '/places')).json.places.map((p) => [p.title, p.moved, p.active]), [['Paket abholen', false, true], ['Milch mitbringen', false, true], ['Schule', false, true]]);
  // the hub let go: no family list any more, its open tasks from Familie are in the trash (nothing rings twice), the
  // done one stays; nobody's phone watches a place for the hub
  const me = (await x.hub(ANNA)('GET', 'me')).json.familyTasks;
  assert.deepEqual([me.bound, me.listId], [false, null]);
  const left = (await x.hub(ANNA)('GET', `views/list:${listId}`)).json.sections.flatMap((s) => s.items);
  assert.deepEqual(left.map((t) => [t.title, t.done]), [['Zimmer aufräumen', true], ['Altpapier', true]].filter((r) => left.some((t) => t.title === r[0])));
  assert.equal(left.some((t) => !t.done), false);
  assert.deepEqual((await x.hub(ANNA)('POST', 'places/watch', {})).json.fences, []);
  x.clock.set(Date.UTC(2026, 9, 15, 16, 1));
  await x.both();
  assert.ok(pushes(x.famHost, 'task_due').length >= 3, 'Familie reminds itself again');
  assert.equal(x.hubHost().notifications.filter((n) => n.data && n.data.notizen && n.data.notizen.kind === 'reminder').length, 0);
  // and once more to the hub: the same tasks come out of the trash — not a second copy
  const mv = await x.admin('POST', 'tasks/move', {});
  assert.equal(mv.status, 200);
  const hub = await hubFamily(x);
  assert.deepEqual(titles(hub.filter((t) => !t.done)), ['Blumen gießen', 'Im Hub angelegt', 'Spülmaschine', 'Zähne putzen', 'Zähne putzen']);
  assert.equal((await x.hub(ANNA)('GET', 'me')).json.familyTasks.listId, listId);
}));
