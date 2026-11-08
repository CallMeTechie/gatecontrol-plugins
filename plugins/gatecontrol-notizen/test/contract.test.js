'use strict';

// docs/notes-sources-contract.md from the hub's side: pushes (todo_changed) with their checks, who sees what, the
// reconciliation (todo_items in pages, what did not come goes), ticking off (todo_complete, a refusal undoes it), the
// budgets, a source that goes away, the person's choices of „Quellen“ and the evening before.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, item, ANNA, MARC, LENA, BOB, clock, T0 } = require('./helpers');

const FAM = 'gatecontrol-familie';
const MAIL = 'gatecontrol-mail';
const ALLTAG = 'gatecontrol-alltag';
const SCHULE = 'gatecontrol-schule';

const sec = (v, id) => v.sections.find((s) => s.id === id).items;

test('push: items are checked, only their users see them, a bad one is rejected alone', async () => {
  const h = await withHost();
  try {
    const r = await h.push(MAIL, { upsert: [
      item(MAIL, 'msg:1', { title: 'Angebot beantworten', subtitle: 'Zu tun aus „Ihr Angebot 2026-114“', users: [ANNA.id] }),
      item(MAIL, 'msg:2', { users: [ANNA.id, MARC.id], important: true, due: '2026-11-07' }),
      item(MAIL, 'msg:3', { open: { plugin: FAM, route: 'x' } }),
      item(MAIL, 'msg:4', { due: '2026-11-08T25:00:00+01:00' }),
      item(MAIL, 'msg:5', { users: [] }),
      { id: 'bad id!', kind: 'task' },
    ] });
    assert.equal(r.ok, true);
    assert.equal(r.accepted, 2);
    assert.deepEqual(r.rejected.map((x) => [x.id, x.field]), [['msg:3', 'open'], ['msg:4', 'due'], ['msg:5', 'users'], [null, 'id']]);
    const a = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    assert.deepEqual(sec(a, 'today').map((x) => x.title), ['Angebot beantworten']);
    assert.deepEqual(sec(a, 'overdue').map((x) => x.id === undefined ? null : x.source.plugin), [MAIL]);
    const m = await h.ok(MARC, 'GET', 'views/myday', null, { area: 'private' });
    assert.equal(sec(m, 'overdue').length, 1);
    assert.equal(sec(m, 'today').length, 0);
    const b = await h.ok(BOB, 'GET', 'views/myday', null, { area: 'private' });
    assert.equal(b.sections.reduce((n, s) => n + s.items.length, 0), 0);
    // a source may not push for another, an unknown caller is refused, payload limits
    assert.equal((await h.host.callService('todo_changed', { caller: 'gatecontrol-hello', payload: { upsert: [] } })).code, 'forbidden');
    assert.equal((await h.push(MAIL, { upsert: new Array(201).fill(item(MAIL, 'x')) })).code, 'invalid');
    // removing, then the users of an item change exactly
    await h.push(MAIL, { upsert: [item(MAIL, 'msg:2', { users: [MARC.id], updatedAt: clock.now() + 1 })], remove: ['msg:1'] });
    const a2 = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    assert.equal(a2.sections.reduce((n, s) => n + s.items.length, 0), 0);
    // an older update is ignored
    await h.push(MAIL, { upsert: [item(MAIL, 'msg:2', { users: [MARC.id], title: 'alt', updatedAt: 5 })] });
    const m2 = await h.ok(MARC, 'GET', 'views/myday', null, { area: 'private' });
    const all = m2.sections.flatMap((x) => x.items);
    assert.equal(all.length, 1);
    assert.notEqual(all[0].title, 'alt');
    // realtime: the people concerned were told (merged)
    require('../server/events').now();
    assert.ok(h.host.events.some((e) => e.type === 'changed' && e.users.includes(MARC.id)));
  } finally { await h.close(); }
});

test('reconciliation: pages until the end, what did not come goes; within the budget', async () => {
  const h = await withHost();
  try {
    const fam = h.src(FAM);
    for (let i = 1; i <= 5; i++) fam.state.items.set('t:' + i, item(FAM, 't:' + i, { title: 'Aufgabe ' + i, users: [ANNA.id] }));
    await h.ok(ANNA, 'GET', 'me'); // the first visit asks every source
    await h.host.tick();
    const pulls = fam.state.calls.filter((c) => c.name === 'todo_items');
    assert.deepEqual(pulls.map((c) => c.payload.cursor), [null, '2', '4']);
    assert.ok(pulls.every((c) => c.user === ANNA.id && c.payload.v === 1));
    let v = await h.ok(ANNA, 'GET', 'views/source:' + FAM, null, { area: 'private' });
    assert.equal(v.sections[0].items.length, 5);
    // two gone in the source, one new: the next reconciliation catches up
    fam.state.items.delete('t:1');
    fam.state.items.delete('t:2');
    fam.state.items.set('t:9', item(FAM, 't:9', { users: [ANNA.id] }));
    const r = await h.ok(ANNA, 'POST', 'sources/' + FAM + '/sync');
    assert.equal(r.scheduled, false, 'just reconciled: not again within 10 minutes');
    clock.advance(11 * 60000);
    assert.equal((await h.ok(ANNA, 'POST', 'sources/' + FAM + '/sync')).scheduled, true);
    await h.host.tick();
    v = await h.ok(ANNA, 'GET', 'views/source:' + FAM, null, { area: 'private' });
    assert.deepEqual(v.sections[0].items.map((x) => x.title).sort(), ['Aufgabe 3', 'Aufgabe 4', 'Aufgabe 5', 'Item t:9']);
    // nothing more is due for 12 hours: a tick asks nobody
    const before = fam.state.calls.length;
    clock.advance(3600000);
    await h.host.tick();
    assert.equal(fam.state.calls.length, before);
    // the hub never polls a source per request
    for (let i = 0; i < 10; i++) await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    assert.equal(fam.state.calls.length, before);
    // the per-source budget of the reconciliation (300 an hour) is kept below the source's 600
    const sources = require('../server/sources');
    sources._calls.set(FAM, new Array(300).fill(clock.now()));
    await h.ok(ANNA, 'POST', 'sources/' + FAM + '/sync').catch(() => {});
    clock.advance(11 * 60000);
    await require('../server/store').run(h.host.gc, 'UPDATE src_sync SET next_at = 0');
    sources._calls.set(FAM, new Array(300).fill(clock.now()));
    await h.host.tick();
    assert.equal(fam.state.calls.length, before);
  } finally { await h.close(); }
});

test('complete: ticks it off in the source; a refusal leaves it open; read-only items refuse', async () => {
  const h = await withHost();
  try {
    const mail = h.src(MAIL);
    mail.state.items.set('msg:1', item(MAIL, 'msg:1', { users: [ANNA.id] }));
    await h.push(MAIL, { upsert: [mail.state.items.get('msg:1'), item(MAIL, 'msg:2', { kind: 'event', canComplete: false })] });
    const v = await h.ok(ANNA, 'GET', 'views/source:' + MAIL, null, { area: 'private' });
    const it = v.sections[0].items.find((x) => x.title === 'Item msg:1');
    const ro = v.sections[0].items.find((x) => x.title === 'Item msg:2');
    const r = await h.ok(ANNA, 'POST', `items/${it.id}/complete`, { done: true });
    assert.equal(r.item.done, true);
    assert.deepEqual(mail.state.completes, [{ id: 'msg:1', done: true, user: ANNA.id }]);
    const md = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    assert.ok(sec(md, 'done').some((x) => x.id === it.id));
    mail.state.refuse = 'read_only';
    const no = await h.call(ANNA, 'POST', `items/${it.id}/complete`, { done: false });
    assert.equal(no.status, 403);
    assert.equal((await h.ok(ANNA, 'GET', 'items/' + it.id)).item.done, true);
    mail.state.down = true;
    assert.equal((await h.call(ANNA, 'POST', `items/${it.id}/complete`, { done: false })).status, 503);
    assert.equal((await h.call(ANNA, 'POST', `items/${ro.id}/complete`, { done: true })).status, 403);
    assert.equal((await h.call(BOB, 'POST', `items/${it.id}/complete`, { done: true })).status, 404);
  } finally { await h.close(); }
});

test('a hub task carrying a source item: sub tasks of its own, completing ticks it off there, the source closes it', async () => {
  const h = await withHost();
  try {
    const mail = h.src(MAIL);
    mail.state.items.set('msg:7', item(MAIL, 'msg:7', { title: 'Angebot beantworten', users: [ANNA.id] }));
    await h.push(MAIL, { upsert: [mail.state.items.get('msg:7')] });
    const id = (await h.ok(ANNA, 'GET', 'views/source:' + MAIL, null, { area: 'private' })).sections[0].items[0].id;
    const c = await h.ok(ANNA, 'POST', `items/${id}/carry`);
    assert.equal(c.task.title, 'Angebot beantworten');
    assert.equal(c.task.sourceItem.source.plugin, MAIL);
    assert.equal((await h.ok(ANNA, 'POST', `items/${id}/carry`)).task.id, c.task.id, 'once per person');
    await h.ok(ANNA, 'POST', 'tasks', { parentId: c.task.id, title: 'Preise vergleichen' });
    // shown once: as the task
    const md = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    assert.deepEqual(sec(md, 'today').map((x) => x.type), ['task']);
    const done = await h.ok(ANNA, 'POST', `tasks/${c.task.id}/complete`, { done: true });
    assert.equal(done.task.done, true);
    assert.deepEqual(mail.state.completes.map((x) => x.id), ['msg:7']);
    // the source reopens it: the task follows
    await h.push(MAIL, { upsert: [{ ...mail.state.items.get('msg:7'), done: false, updatedAt: clock.now() + 1000 }] });
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + c.task.id)).task.done, false);
    // a refusal of the source leaves the task open
    mail.state.refuse = 'not_found';
    assert.equal((await h.call(ANNA, 'POST', `tasks/${c.task.id}/complete`, { done: true })).status, 503);
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + c.task.id)).task.done, false);
    // the source removes it: the task stays as a task of its own
    await h.push(MAIL, { remove: ['msg:7'] });
    const t = (await h.ok(ANNA, 'GET', 'tasks/' + c.task.id)).task;
    assert.equal(t.source, null);
  } finally { await h.close(); }
});

test('the evening before, children, shopping lists, flagged mails, groups to areas', async () => {
  const h = await withHost();
  try {
    await h.push(ALLTAG, { upsert: [item(ALLTAG, 'w:1', { kind: 'event', title: 'Gelbe Tonne rausstellen', subtitle: 'Abholung morgen früh', due: '2026-11-09', lead: 'evening', users: [ANNA.id, MARC.id] })] });
    await h.push(FAM, { upsert: [
      item(FAM, 't:1', { title: 'Rasen mähen', assignee: LENA.id, users: [ANNA.id, LENA.id], meta: { stars: 2 } }),
      item(FAM, 'l:1', { kind: 'list', title: 'Einkauf', meta: { type: 'shopping' }, progress: { done: 1, total: 6 } }),
    ] });
    await h.push(MAIL, { upsert: [
      item(MAIL, 'f:1', { title: 'Markierte Mail', meta: { flagged: true } }),
      item(MAIL, 'w:1', { title: 'Projekt X', area: 'private', group: { id: 'account:3', label: 'Arbeit (Microsoft 365)' } }),
    ] });
    await h.push(SCHULE, { upsert: [item(SCHULE, 'e:1', { kind: 'event', title: 'Elternabend Klasse 6b', due: '2026-11-08T19:30:00+01:00', allDay: false, canComplete: false })] });
    let v = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    assert.deepEqual(sec(v, 'events').map((x) => [x.title, x.show.time]), [['Gelbe Tonne rausstellen', '18:00'], ['Elternabend Klasse 6b', '19:30']]);
    assert.deepEqual(sec(v, 'today').map((x) => x.title).sort(), ['Markierte Mail', 'Projekt X', 'Rasen mähen']);
    // Anna's choices
    await h.ok(ANNA, 'PUT', 'prefs', { sources: { [FAM]: { kids: 'mine', shoppingInMyDay: true }, [MAIL]: { flagged: false }, [ALLTAG]: { evening: '19:15' } }, groups: { [MAIL + '|account:3']: 'work' } });
    v = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    assert.deepEqual(sec(v, 'today').map((x) => x.title), ['Einkauf']);
    assert.equal(sec(v, 'events')[0].show.time, '19:15');
    const w = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'work' });
    assert.deepEqual(sec(w, 'today').map((x) => x.title), ['Projekt X']);
    // a source the person switched off, or the administrator
    await h.ok(ANNA, 'PUT', 'prefs', { sources: { [ALLTAG]: { on: false } } });
    v = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    assert.ok(!sec(v, 'events').some((x) => x.source.plugin === ALLTAG));
    await h.host.saveSettings({ source_schule: false });
    v = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    assert.equal(sec(v, 'events').length, 0);
    // „Quellen“ lists the groups
    const s = await h.ok(ANNA, 'GET', 'sources');
    assert.deepEqual(s.sources.find((x) => x.plugin === MAIL).groups.map((g) => g.label), ['Arbeit (Microsoft 365)']);
  } finally { await h.close(); }
});

test('a source that goes away: its items hide at once and go after 7 days; one that comes back is reconciled', async () => {
  const h = await withHost();
  try {
    await h.ok(ANNA, 'GET', 'me');
    await h.push(FAM, { upsert: [item(FAM, 't:1')] });
    await h.host.tick();
    const fam = h.src(FAM);
    fam.state.down = false;
    // GateControl's services.available says no once the plugin is gone
    const gc = h.host.gc;
    const svc = fam.entry.service;
    fam.entry.service = null;
    await h.host.tick();
    let v = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    assert.equal(sec(v, 'today').length, 0);
    clock.advance(8 * 86400000);
    await h.host.tick();
    const n = await require('../server/store').one(gc, 'SELECT COUNT(*) AS n FROM src_items WHERE plugin = ?', [FAM]);
    assert.equal(n.n, 0);
    fam.entry.service = svc;
    fam.state.items.set('t:2', item(FAM, 't:2', { due: '2026-11-16' }));
    clock.advance(31 * 60000);
    await h.host.tick();
    clock.advance(31 * 60000);
    await h.host.tick();
    v = await h.ok(ANNA, 'GET', 'views/myday', null, { area: 'private' });
    assert.deepEqual(sec(v, 'today').map((x) => x.title), ['Item t:2']);
  } finally { await h.close(); clock.set(T0); }
});
