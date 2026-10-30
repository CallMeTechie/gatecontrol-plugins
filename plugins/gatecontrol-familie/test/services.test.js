'use strict';

// Services for the Messenger (1.8.0, services.provides): list_add, calendar_add, calendar_upsert,
// calendar_remove, places — called as gatecontrol-messenger would (host.callService) — and the
// place in the messenger status (set_place_status) on presence changes and place events, against
// a stand-in messenger that records what it gets.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFamily, ANNA, MARC, LENA, TIM, OMA, KUECHE, MIN } = require('./helpers');

const MSG = 'gatecontrol-messenger';
const call = (host, name, payload, o = {}) => host.callService(name, { caller: o.caller || MSG, user: o.user || null, payload });
const rows = async (host, sql, params) => (await host.gc.db.query(sql, params || [])).rows;

/** A messenger offering set_place_status (provides: [] = not installed); calls are recorded in got. */
function stand(o = {}) {
  const m = {
    plugin: MSG, provides: o.provides || ['set_place_status'], got: [], answer: o.answer || null,
    service: async (c) => { m.got.push({ name: c.name, payload: c.payload }); return m.answer ? m.answer(c) : { ok: true }; },
  };
  return m;
}

test('list_add: the shopping list (made when there is none), a list by id, duplicates skipped; members only, module, checks', () => withFamily({ settings: { mod_wall: true } }, async (host, { as, admin }) => {
  const a = await call(host, 'list_add', { userId: LENA.id, list: 'shopping', items: ['Milch', ' Brot  ', 'milch'] });
  assert.equal(a.ok, true);
  assert.deepEqual([a.listName, a.added, a.skipped, a.itemIds.length], ['Einkaufsliste', 2, 1, 2]);
  const s = (await as(ANNA)('GET', '/shopping')).json;
  assert.deepEqual(s.lists.map((l) => [l.id, l.name]), [[a.listId, 'Einkaufsliste']]);
  assert.deepEqual(s.items.map((i) => [i.text, i.listId]), [['Milch', a.listId], ['Brot', a.listId]]);
  // again: an item still open is skipped, a checked one may come again
  const milk = s.items.find((i) => i.text === 'Milch');
  await as(ANNA)('POST', '/shopping/ops', { ops: [{ op: 'item_check', id: milk.id, checked: true }] });
  const b = await call(host, 'list_add', { userId: ANNA.id, items: ['MILCH', 'brot', 'Eier'] });
  assert.deepEqual([b.listId, b.added, b.skipped], [a.listId, 2, 1], 'list missing = shopping');
  // a list by id
  await as(MARC)('POST', '/shopping/ops', { ops: [{ op: 'list_add', id: 'baumarkt-0001', name: 'Baumarkt' }] });
  const c = await call(host, 'list_add', { userId: MARC.id, list: 'baumarkt-0001', items: ['Schrauben'] });
  assert.deepEqual([c.ok, c.listId, c.listName, c.added], [true, 'baumarkt-0001', 'Baumarkt', 1]);
  assert.deepEqual((await rows(host, 'SELECT created_by FROM shop_items WHERE id = ?', [c.itemIds[0]])).map((x) => x.created_by), [MARC.id]);
  // the host's user stands in for a missing userId
  assert.equal((await call(host, 'list_add', { items: ['Käse'] }, { user: { id: TIM.id, name: 'Tim', role: 'user' } })).added, 1);
  // refusals
  assert.deepEqual(await call(host, 'list_add', { userId: ANNA.id, list: 'nope-nope-1', items: ['x'] }), { ok: false, code: 'not_found' });
  assert.deepEqual(await call(host, 'list_add', { userId: OMA.id, items: ['x'] }), { ok: false, code: 'not_member' });
  await admin('POST', 'members', { userId: KUECHE.id, role: 'wall' });
  assert.deepEqual(await call(host, 'list_add', { userId: KUECHE.id, items: ['x'] }), { ok: false, code: 'not_member' }, 'a wall tablet');
  for (const bad of [{ userId: ANNA.id }, { userId: ANNA.id, items: [] }, { userId: ANNA.id, items: ['x'.repeat(121)] }, { userId: ANNA.id, items: [7] },
    { userId: ANNA.id, items: new Array(51).fill('a') }, { userId: ANNA.id, items: ['x'], list: 'a b' }, { items: ['x'] }]) {
    assert.deepEqual(await call(host, 'list_add', bad), { ok: false, code: 'invalid' }, JSON.stringify(bad).slice(0, 60));
  }
  assert.deepEqual(await call(host, 'list_add', { userId: ANNA.id, items: ['x'] }, { caller: 'gatecontrol-other' }), { ok: false, code: 'forbidden' });
  await admin('PUT', 'modules', { shopping: false });
  assert.deepEqual(await call(host, 'list_add', { userId: ANNA.id, items: ['x'] }), { ok: false, code: 'module_off' });
}));

test('calendar_add: an ordinary date of that person, from the chat (place, end time, all-day); checks', () => withFamily({}, async (host, { as, admin }) => {
  const a = await call(host, 'calendar_add', { userId: LENA.id, title: 'Kino', startsAt: '2026-10-20T15:00:00Z', endsAt: '2026-10-20T16:30:00Z', place: 'Cinemaxx' });
  assert.equal(a.ok, true);
  assert.ok(Number.isSafeInteger(a.eventId));
  const b = await call(host, 'calendar_add', { userId: ANNA.id, title: 'Ausflug', startsAt: '2026-10-24', endsAt: '2026-10-25', place: { label: 'Harz', lat: 51.8, lon: 10.6 } });
  const c = await call(host, 'calendar_add', { userId: ANNA.id, title: 'Spät', startsAt: '2026-10-21T21:30:00Z', endsAt: '2026-10-21T22:30:00Z' });
  const g = (await as(TIM)('GET', '/dates', null, { from: '2026-10-14', to: '2026-10-31' })).json.events;
  const kino = g.find((e) => e.id === a.eventId);
  assert.deepEqual([kino.date, kino.time, kino.endTime, kino.endDate, kino.allDay, kino.place, kino.origin, kino.readOnly, kino.createdBy, kino.memberIds],
    ['2026-10-20', '17:00', '18:30', null, false, 'Cinemaxx', 'chat', false, LENA.id, []], 'Berlin time; the whole family');
  const trip = g.find((e) => e.id === b.eventId);
  assert.deepEqual([trip.date, trip.endDate, trip.allDay, trip.time, trip.endTime, trip.place], ['2026-10-24', '2026-10-25', true, null, null, 'Harz'], 'the label only');
  const late = g.find((e) => e.id === c.eventId);
  assert.deepEqual([late.date, late.time, late.endDate, late.endTime], ['2026-10-21', '23:30', '2026-10-22', '00:30'], 'past midnight');
  // an ordinary date: anyone edits it; changing the time drops the end time
  const p = await as(MARC)('PATCH', `/dates/${a.eventId}`, { time: '18:00' });
  assert.deepEqual([p.status, p.json.event.time, p.json.event.endTime, p.json.event.origin], [200, '18:00', null, 'chat']);
  const q = await as(MARC)('PATCH', `/dates/${a.eventId}`, { endTime: '20:00', place: 'Zoo Palast' });
  assert.deepEqual([q.json.event.endTime, q.json.event.place], ['20:00', 'Zoo Palast']);
  assert.equal((await as(MARC)('PATCH', `/dates/${a.eventId}`, { endTime: '17:00' })).json.code, 'invalid', 'end before start');
  assert.equal((await as(LENA)('DELETE', `/dates/${a.eventId}`)).status, 200);
  // a date of the app may carry a place too
  const own = await as(ANNA)('POST', '/dates', { title: 'Arzt', date: '2026-10-22', time: '09:00', endTime: '09:30', place: 'Praxis Dr. Weiß' });
  assert.deepEqual([own.json.event.place, own.json.event.endTime, own.json.event.origin], ['Praxis Dr. Weiß', '09:30', null]);
  for (const bad of [
    { userId: ANNA.id, title: '', startsAt: '2026-10-20T15:00:00Z' }, { userId: ANNA.id, title: 'x'.repeat(81), startsAt: '2026-10-20T15:00:00Z' },
    { userId: ANNA.id, title: 'x', startsAt: '20.10.2026' }, { userId: ANNA.id, title: 'x', startsAt: '2026-02-30' },
    { userId: ANNA.id, title: 'x', startsAt: '2026-10-20T15:00:00Z', endsAt: '2026-10-20T14:00:00Z' },
    { userId: ANNA.id, title: 'x', startsAt: '2026-10-20', endsAt: '2027-01-20' }, { userId: ANNA.id, title: 'x', startsAt: '2026-10-20', allDay: 'yes' },
    { userId: ANNA.id, title: 'x', startsAt: '2026-10-20', place: 'x'.repeat(81) }, { userId: ANNA.id, title: 'x', startsAt: '2026-10-20', place: 7 },
  ]) {
    assert.deepEqual(await call(host, 'calendar_add', bad), { ok: false, code: 'invalid' }, JSON.stringify(bad).slice(0, 80));
  }
  assert.deepEqual(await call(host, 'calendar_add', { userId: OMA.id, title: 'x', startsAt: '2026-10-20' }), { ok: false, code: 'not_member' });
  await admin('PUT', 'modules', { dates: false });
  assert.deepEqual(await call(host, 'calendar_add', { userId: ANNA.id, title: 'x', startsAt: '2026-10-20' }), { ok: false, code: 'module_off' });
}));

test('calendar_add from Drive (1.15.3): only for the person of the call, a family member; an ordinary date', () => withFamily({ settings: { mod_wall: true } }, async (host, { as, admin }) => {
  const drive = (payload, user) => call(host, 'calendar_add', payload, { caller: 'gatecontrol-drive', user });
  const anna = { id: ANNA.id, name: 'Anna', role: 'user' };
  const a = await drive({ userId: ANNA.id, title: 'Kfz-Versicherung kündigen', startsAt: '2026-11-30', allDay: true }, anna);
  assert.equal(a.ok, true, JSON.stringify(a));
  const ev = (await as(MARC)('GET', '/dates', null, { from: '2026-11-01', to: '2026-12-31' })).json.events.find((e) => e.id === a.eventId);
  assert.deepEqual([ev.title, ev.date, ev.allDay, ev.createdBy, ev.origin], ['Kfz-Versicherung kündigen', '2026-11-30', true, ANNA.id, null], 'no "aus dem Familien-Chat"');
  // never for someone else, never without the person of the call
  assert.deepEqual(await drive({ userId: LENA.id, title: 'x', startsAt: '2026-11-30' }, anna), { ok: false, code: 'forbidden' });
  assert.deepEqual(await drive({ userId: ANNA.id, title: 'x', startsAt: '2026-11-30' }, null), { ok: false, code: 'forbidden' });
  assert.deepEqual(await drive({ title: 'x', startsAt: '2026-11-30' }, anna), { ok: false, code: 'forbidden' }, 'userId must be named');
  // not in the family, a wall tablet
  assert.deepEqual(await drive({ userId: OMA.id, title: 'x', startsAt: '2026-11-30' }, { id: OMA.id, name: 'Oma', role: 'user' }), { ok: false, code: 'not_member' });
  await admin('POST', 'members', { userId: KUECHE.id, role: 'wall' });
  assert.deepEqual(await drive({ userId: KUECHE.id, title: 'x', startsAt: '2026-11-30' }, { id: KUECHE.id, name: 'Küche', role: 'user' }), { ok: false, code: 'not_member' });
  // Drive may call nothing else
  assert.deepEqual(await call(host, 'list_add', { userId: ANNA.id, items: ['x'] }, { caller: 'gatecontrol-drive', user: anna }), { ok: false, code: 'forbidden' });
  assert.deepEqual(await call(host, 'calendar_upsert', { sourceRef: 'drive:1', title: 'x', startsAt: '2026-11-30' }, { caller: 'gatecontrol-drive' }), { ok: false, code: 'forbidden' });
  await admin('PUT', 'modules', { dates: false });
  assert.deepEqual(await drive({ userId: ANNA.id, title: 'x', startsAt: '2026-11-30' }, anna), { ok: false, code: 'module_off' });
}));

test('calendar_upsert / calendar_remove: idempotent by sourceRef, read-only in Familie, members of the family only', () => withFamily({}, async (host, { as }) => {
  const ev = { sourceRef: 'messenger:42', title: 'Grillen', startsAt: '2026-10-25T14:00:00Z', place: { label: 'Garten' }, userIds: [ANNA.id, LENA.id, OMA.id, 999] };
  const a = await call(host, 'calendar_upsert', ev);
  assert.deepEqual([a.ok, a.created], [true, true]);
  const b = await call(host, 'calendar_upsert', { ...ev, title: 'Grillen bei uns', startsAt: '2026-10-25T15:00:00Z', endsAt: '2026-10-25T19:00:00Z' });
  assert.deepEqual([b.ok, b.eventId, b.created], [true, a.eventId, false]);
  assert.equal((await rows(host, "SELECT COUNT(*) AS n FROM events WHERE source_ref = 'messenger:42'"))[0].n, 1);
  const e = (await as(TIM)('GET', '/dates', null, { from: '2026-10-25', to: '2026-10-25' })).json.events[0];
  assert.deepEqual([e.id, e.title, e.time, e.endTime, e.place, e.memberIds, e.origin, e.readOnly, e.createdBy],
    [a.eventId, 'Grillen bei uns', '16:00', '20:00', 'Garten', [ANNA.id, LENA.id], 'chat', true, null], 'winter time from 25 October; non-members dropped');
  assert.equal((await as(ANNA)('PATCH', `/dates/${a.eventId}`, { title: 'x' })).json.code, 'read_only');
  assert.equal((await as(ANNA)('DELETE', `/dates/${a.eventId}`)).json.code, 'read_only');
  // without userIds: the whole family
  const c = await call(host, 'calendar_upsert', { sourceRef: 'messenger:43', title: 'Elternabend', startsAt: '2026-10-26' });
  assert.deepEqual((await rows(host, 'SELECT member_ids_json, all_day FROM events WHERE id = ?', [c.eventId]))[0], { member_ids_json: '[]', all_day: 1 });
  assert.deepEqual(await call(host, 'calendar_remove', { sourceRef: 'messenger:42' }), { ok: true, removed: true });
  assert.deepEqual(await call(host, 'calendar_remove', { sourceRef: 'messenger:42' }), { ok: true, removed: false });
  assert.equal((await rows(host, 'SELECT COUNT(*) AS n FROM events WHERE id = ?', [a.eventId]))[0].n, 0);
  for (const bad of [{ ...ev, sourceRef: 'x' }, { ...ev, sourceRef: 'Messenger:1' }, { ...ev, sourceRef: 7 }, { ...ev, title: '' }, { ...ev, userIds: 'all' }]) {
    assert.deepEqual(await call(host, 'calendar_upsert', bad), { ok: false, code: 'invalid' }, JSON.stringify(bad).slice(0, 60));
  }
  assert.deepEqual(await call(host, 'calendar_remove', {}), { ok: false, code: 'invalid' });
  assert.deepEqual(await call(host, 'calendar_remove', { sourceRef: 'messenger:43' }, { caller: 'gatecontrol-other' }), { ok: false, code: 'forbidden' });
}));

test('places: home from the settings and the rule places (module presence) for members; nothing for others', () => withFamily({ settings: { lat: '52.52', lon: '13.405' } }, async (host, { as, admin }) => {
  assert.deepEqual(await call(host, 'places', { userId: TIM.id }), [{ id: 'home', name: 'Zuhause', lat: 52.52, lon: 13.405, radiusM: 150 }], 'presence off: home only');
  await admin('PUT', 'modules', { presence: true });
  const s = (await as(ANNA)('POST', '/presence/places', { name: 'Schule', lat: 52.5301, lon: 13.4101, radius: 300 })).json.place;
  assert.deepEqual(await call(host, 'places', { userId: LENA.id }), [
    { id: 'home', name: 'Zuhause', lat: 52.52, lon: 13.405, radiusM: 150 },
    { id: `place:${s.id}`, name: 'Schule', lat: 52.5301, lon: 13.4101, radiusM: 300 },
  ]);
  assert.deepEqual(await call(host, 'places', { userId: OMA.id }), []);
  assert.deepEqual(await call(host, 'places', {}), []);
  assert.deepEqual(await call(host, 'places', { userId: ANNA.id }, { caller: 'gatecontrol-other' }), []);
  assert.deepEqual(await call(host, 'unknown_service', {}).catch((e) => e.code), 'ERR_SERVICE_UNAVAILABLE', 'only the declared services');
}));

test('set_place_status: home / away, place events, consent withdrawn — names only, only changes, after the commit', () => {
  const m = stand();
  return withFamily({ settings: { mod_presence: true }, services: [m] }, async (host, { as, clock }) => {
    await as(LENA)('PUT', '/presence/consent', { share: true, places: true });
    assert.equal((await as(LENA)('POST', '/presence', { home: true })).status, 200);
    assert.deepEqual(m.got, [{ name: 'set_place_status', payload: { userId: LENA.id, place: 'Zuhause' } }]);
    clock.add(2 * MIN);
    await as(LENA)('POST', '/presence', { home: true });
    assert.equal(m.got.length, 1, 'no change, nothing sent');
    clock.add(2 * MIN);
    await as(LENA)('POST', '/presence', { home: false });
    assert.deepEqual(m.got[1].payload, { userId: LENA.id, place: null });
    const s = (await as(ANNA)('POST', '/presence/places', { name: 'Schule', lat: 52.5301, lon: 13.4101 })).json.place;
    await as(LENA)('POST', `/presence/places/${s.id}/event`, { transition: 'enter' });
    assert.deepEqual(m.got[2].payload, { userId: LENA.id, place: 'Schule' });
    assert.ok(!JSON.stringify(m.got).includes('52.53'), 'never a position');
    await as(LENA)('POST', `/presence/places/${s.id}/event`, { transition: 'enter' });
    assert.equal(m.got.length, 3, 'a repeat runs nothing');
    clock.add(5 * MIN);
    await as(LENA)('POST', `/presence/places/${s.id}/event`, { transition: 'exit' });
    assert.deepEqual(m.got[3].payload, { userId: LENA.id, place: null }, 'left the place while away');
    await as(LENA)('POST', `/presence/places/${s.id}/event`, { transition: 'enter', at: new Date(clock.now() - 11 * MIN).toISOString() });
    assert.equal(m.got.length, 4, 'a late event runs nothing');
    clock.add(2 * MIN);
    await as(LENA)('POST', '/presence', { home: true });
    await as(LENA)('POST', `/presence/places/${s.id}/event`, { transition: 'exit' });
    assert.deepEqual(m.got.slice(4).map((x) => x.payload.place), ['Zuhause'], 'left a place while at home: still „Zuhause“ (unchanged, not sent)');
    await as(LENA)('PUT', '/presence/consent', { share: false });
    assert.deepEqual(m.got[5].payload, { userId: LENA.id, place: null }, 'consent withdrawn');
    // without consent there is nothing to pass on
    await as(TIM)('POST', '/presence', { home: true });
    assert.equal(m.got.length, 6);
    assert.ok(host.serviceCalls.every((c) => c.service !== 'set_place_status' || c.userId === null), 'the person goes in the payload');
  });
});

test('set_place_status: kept while the messenger is missing or refuses for the budget, delivered later by the background run; gc.services.available', () => {
  const m = stand({ provides: [] });
  return withFamily({ settings: { mod_presence: true }, services: [m], gatecontrol: '1.178.0' }, async (host, { as, clock }) => {
    await as(MARC)('PUT', '/presence/consent', { share: true });
    await as(MARC)('POST', '/presence', { home: true });
    clock.add(2 * MIN);
    await as(MARC)('POST', '/presence', { home: false });
    assert.equal(m.got.length, 0, 'not installed: gc.services.available says no, nothing is called');
    m.provides.push('set_place_status');
    await host.tick();
    assert.equal(m.got.length, 0, 'tried at most every 5 minutes');
    clock.add(5 * MIN);
    await host.tick();
    assert.deepEqual(m.got.map((x) => x.payload), [{ userId: MARC.id, place: null }], 'the latest place only');
    clock.add(5 * MIN);
    await host.tick();
    assert.equal(m.got.length, 1, 'delivered once');
    // the messenger answers itself (e.g. it does not know the person): done, not tried again
    m.answer = () => ({ ok: false, code: 'not_found' });
    clock.add(2 * MIN);
    await as(MARC)('POST', '/presence', { home: true });
    clock.add(10 * MIN);
    await host.tick();
    assert.equal(m.got.length, 2);
    // a provider that throws: kept and tried again
    m.answer = () => { throw new Error('boom'); };
    clock.add(2 * MIN);
    await as(MARC)('POST', '/presence', { home: false });
    assert.equal(m.got.length, 3);
    m.answer = null;
    clock.add(5 * MIN);
    await host.tick();
    assert.deepEqual(m.got.slice(3).map((x) => x.payload), [{ userId: MARC.id, place: null }]);
  });
});

test('set_place_status: an older GateControl without gc.services, or the module off — nothing breaks', () => withFamily({ settings: { mod_presence: true } }, async (host, { as }) => {
  await as(ANNA)('PUT', '/presence/consent', { share: true });
  const r = await as(ANNA)('POST', '/presence', { home: true });
  assert.equal(r.status, 200, 'no messenger at all');
  await host.tick();
}));
