'use strict';

// 1.18.0 — „Termin“ in the quick entry of „Notizen & Aufgaben“ (gatecontrol-notizen): the services it writes a real
// event with (calendar_list with every calendar, the default and the default reminders; calendar_add with the default
// calendar, a place, a chosen reminder, an all-day event over days, a series, idempotent by key; calendar_update) and the
// events Mail reports to the hub (server/notizen.js): only to a hub that asks for them, own / shared / family /
// subscribed / „Aufgaben“ told apart, never an invitation without an answer, a declined or a cancelled one.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, ANNA, MARC, BOB } = require('./helpers');
const { fakeOverlays } = require('./pim-helpers');
const { fakeHub, checkItem, HUB } = require('../../../tools/testing/notizen-hub');
const notizen = require('../server/notizen');
const tz = require('../server/tz');
const manifest = require('../plugin.json');

const DRIVE = 'gatecontrol-drive';
const BERLIN = 'Europe/Berlin';
const as = (u) => ({ id: u.id, name: u.name, role: 'user' });
const call = (host, name, user, payload, caller = HUB) => host.callService(name, { caller, user: user ? as(user) : null, payload });
const day = (n) => tz.addDays(tz.localDate(Date.now(), BERLIN), n);
const at = (d, hh, mm = 0) => tz.at(d, { hh, mm }, BERLIN);
const O = { gatecontrol: '1.219.0' };

/** Every item of `user` as a hub that takes events pulls them. */
async function pull(host, user, accepts = ['calendar']) {
  const items = [];
  let cursor = null;
  let last;
  for (let i = 0; i < 50; i++) {
    last = await host.callService('todo_items', { caller: HUB, user: as(user), payload: { v: 1, cursor, ...(accepts ? { accepts } : {}) } });
    assert.equal(last.ok, true, JSON.stringify(last));
    assert.ok(Buffer.byteLength(JSON.stringify(last)) <= 16 * 1024);
    items.push(...last.items);
    cursor = last.cursor;
    if (!cursor) break;
  }
  return { items, last };
}

test('plugin.json: no new service and no new permission — an update asks the administrator nothing', () => {
  assert.equal(manifest.version, '1.18.0');
  assert.deepEqual(Object.keys(manifest.services.provides).sort(), ['calendar_add', 'calendar_delete', 'calendar_list', 'calendar_tasks', 'calendar_update', 'contacts_phones',
    'ms_accounts', 'ms_tasks_consent', 'ms_tasks_token', 'new_draft', 'todo_complete', 'todo_items', 'tofile_count']);
});

test('calendar_list for Notizen: every calendar with its kind, the default, the default reminders — no addresses; Drive as before', () => withMail({ ...O, overlays: fakeOverlays({}) }, async (host, c) => {
  await c.addGmx(ANNA);
  await c.addGmx(MARC);
  const anna = c.as(ANNA);
  await anna('GET', 'calendars');
  await call(host, 'calendar_tasks', ANNA, { userId: ANNA.id });
  // Marc shares his calendar with Anna; she shows it
  const marcCal = (await c.as(MARC)('GET', 'calendars')).json.calendars[0];
  await c.as(MARC)('POST', `calendars/${marcCal.id}/shares`, { type: 'user', id: ANNA.id, level: 'read' });
  let r = await call(host, 'calendar_list', ANNA, { userId: ANNA.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.calendars.map((x) => [x.name, x.kind, x.writable, x.isDefault, x.area, x.key === (x.id ? `cal:${x.id}` : 'overlay:familie')]), [
    ['Privat', 'own', true, true, 'private', true], ['Firma', 'own', true, false, 'work', true], ['Aufgaben', 'tasks', true, false, 'private', true],
    ['Familie', 'family', false, false, 'private', true]]);
  assert.equal(r.defaultId, r.calendars[0].id);
  assert.deepEqual(r.reminders, { timed: 15, allDay: 360 });
  assert.equal(r.timeZone, BERLIN);
  assert.ok(!JSON.stringify(r).includes('@'), 'no address leaves Mail');
  await anna('PATCH', `shared/${marcCal.id}`, { visible: true });
  r = await call(host, 'calendar_list', ANNA, { userId: ANNA.id });
  assert.deepEqual(r.calendars.filter((x) => x.kind === 'shared').map((x) => [x.id, x.name, x.writable]), [[marcCal.id, 'Privat', false]]);
  // the person's own choices: another default, other reminders
  await anna('PUT', 'calendar/settings', { defaultCalendarId: r.calendars[1].id, defaultReminder: 30, allDayReminder: 720 });
  r = await call(host, 'calendar_list', ANNA, { userId: ANNA.id });
  assert.deepEqual([r.defaultId, r.reminders], [r.calendars[1].id, { timed: 30, allDay: 720 }]);
  // „Aufgaben“ is never the default, even when the person chose it in Mail
  const tasks = r.calendars.find((x) => x.kind === 'tasks');
  await anna('PUT', 'calendar/settings', { defaultCalendarId: tasks.id });
  assert.equal((await call(host, 'calendar_list', ANNA, { userId: ANNA.id })).defaultId, r.calendars[0].id);
  // Drive gets what it got: the calendars to write into, with the account
  const d = await call(host, 'calendar_list', ANNA, { userId: ANNA.id }, DRIVE);
  assert.deepEqual(Object.keys(d.calendars[0]).sort(), ['account', 'color', 'id', 'name', 'writable']);
  assert.equal(d.defaultId, undefined);
  // only for the person of the call, only these two callers
  assert.deepEqual(await call(host, 'calendar_list', MARC, { userId: ANNA.id }), { ok: false, code: 'forbidden' });
  assert.deepEqual(await call(host, 'calendar_list', ANNA, { userId: ANNA.id }, 'gatecontrol-familie'), { ok: false, code: 'forbidden' });
  // calendars switched off: none, with the reason (Drive: none)
  await c.admin('PUT', 'admin/settings', { calendar: { enabled: false } });
  assert.deepEqual(await call(host, 'calendar_list', ANNA, { userId: ANNA.id }), { ok: true, calendars: [], reason: 'feature_off' });
  assert.deepEqual(await call(host, 'calendar_list', ANNA, { userId: ANNA.id }, DRIVE), { ok: true, calendars: [] });
}));

test('calendar_add for Notizen: the default calendar and its reminder, a place, a chosen reminder, all day over days, a series, the same key once', () => withMail(O, async (host, c) => {
  const anna = c.as(ANNA);
  const cals = (await anna('GET', 'calendars')).json.calendars;
  const d = day(5);
  const base = { userId: ANNA.id, title: 'Fashion Outlet', allDay: false, start: at(d, 14), end: at(d, 15), location: 'Fashion Outlet, Halle 2', key: 'event:c-1' };
  // no calendar named: the default one, the calendar's default reminder (15 minutes)
  const r = await call(host, 'calendar_add', ANNA, base);
  assert.deepEqual([r.ok, Object.keys(r).sort()], [true, ['eventId', 'ok']], JSON.stringify(r));
  let ev = (await anna('GET', `events/${r.eventId}`)).json;
  assert.deepEqual([ev.title, ev.calendarId, ev.start, ev.end, ev.location, ev.reminders, ev.allDay], ['Fashion Outlet', cals[0].id, at(d, 14), at(d, 15), 'Fashion Outlet, Halle 2', [15], false]);
  // the same key again — also after the person chose another default calendar, also two at once: the same event
  await anna('PUT', 'calendar/settings', { defaultCalendarId: cals[1].id });
  const again = await Promise.all([call(host, 'calendar_add', ANNA, base), call(host, 'calendar_add', ANNA, { ...base, items: true })]);
  assert.deepEqual(again.map((x) => [x.ok, x.eventId]), [[true, r.eventId], [true, r.eventId]]);
  assert.deepEqual([again[1].calendarId, again[1].replayed, again[1].items.map((x) => x.id)], [cals[0].id, true, [`ev:${r.eventId}`]]);
  // a new one goes into the new default; a chosen reminder; none
  const two = await call(host, 'calendar_add', ANNA, { ...base, key: 'event:c-2', reminder: 60 });
  ev = (await anna('GET', `events/${two.eventId}`)).json;
  assert.deepEqual([ev.calendarId, ev.reminders], [cals[1].id, [60]]);
  const none = await call(host, 'calendar_add', ANNA, { ...base, key: 'event:c-3', calendarId: cals[0].id, reminder: false });
  assert.deepEqual((await anna('GET', `events/${none.eventId}`)).json.reminders, []);
  // all day, three days, the all-day default (18:00 the day before)
  const days = await call(host, 'calendar_add', ANNA, { userId: ANNA.id, title: 'Urlaub', allDay: true, startsAt: d, endsAt: tz.addDays(d, 2), key: 'event:c-4' });
  ev = (await anna('GET', `events/${days.eventId}`)).json;
  assert.deepEqual([ev.allDay, ev.startDate, ev.endDate, ev.reminders, ev.location], [true, d, tz.addDays(d, 2), [360], null]);
  // a series: every week on that weekday
  const wd = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][tz.weekday(d)];
  const series = await call(host, 'calendar_add', ANNA, { ...base, key: 'event:c-5', title: 'Chor', recurrence: { freq: 'weekly', byDay: [wd] } });
  ev = (await anna('GET', `events/${series.eventId}`)).json;
  assert.deepEqual([ev.recurring, ev.recurrence.freq, ev.recurrence.byDay], [true, 'weekly', [wd]]);
  const occ = (await anna('GET', 'events', null, { from: at(d, 0), to: at(tz.addDays(d, 22), 0) })).json.items.filter((x) => x.eventId === series.eventId);
  assert.equal(occ.length, 4);
  // input
  for (const bad of [{ location: 'x'.repeat(256) }, { location: 7 }, { location: '  ' }, { reminder: -1 }, { reminder: 40321 }, { reminder: 1.5 }, { reminder: true }, { recurrence: 'weekly' },
    { recurrence: { freq: 'hourly' } }, { recurrence: [] }, { calendarId: 'Privat' }, { calendarId: 99999 }]) {
    const x = await call(host, 'calendar_add', ANNA, { ...base, key: 'event:bad', ...bad });
    assert.deepEqual([x.ok, x.code], [false, bad.calendarId === 99999 ? 'not_found' : 'invalid'], JSON.stringify(bad));
  }
  for (const bad of [{ endsAt: tz.addDays(d, -1) }, { endsAt: tz.addDays(d, 8) }, { endsAt: '2026-02-30' }]) {
    assert.deepEqual(await call(host, 'calendar_add', ANNA, { userId: ANNA.id, title: 'x', allDay: true, startsAt: d, key: 'event:bad', ...bad }), { ok: false, code: 'invalid' }, JSON.stringify(bad));
  }
  // Drive keeps its narrow door: a calendar must be named, no place, no minutes, no series, no end day
  const drive = { userId: ANNA.id, calendarId: cals[0].id, title: 'Frist', startsAt: d, allDay: true };
  assert.equal((await call(host, 'calendar_add', ANNA, drive, DRIVE)).ok, true);
  for (const more of [{ calendarId: null }, { location: 'Amt' }, { reminder: 30 }, { recurrence: { freq: 'daily' } }, { endsAt: tz.addDays(d, 1) }]) {
    assert.deepEqual(await call(host, 'calendar_add', ANNA, { ...drive, ...more }, DRIVE), { ok: false, code: 'invalid' }, JSON.stringify(more));
  }
  // never into a calendar of somebody else, never for somebody else
  const marcCal = (await c.as(MARC)('GET', 'calendars')).json.calendars[0];
  assert.deepEqual(await call(host, 'calendar_add', ANNA, { ...base, key: 'event:c-6', calendarId: marcCal.id }), { ok: false, code: 'not_found' });
  assert.deepEqual(await call(host, 'calendar_add', MARC, { ...base, key: 'event:c-6' }), { ok: false, code: 'forbidden' });
  // calendars off for everybody
  await c.admin('PUT', 'admin/settings', { calendar: { enabled: false } });
  assert.deepEqual(await call(host, 'calendar_add', ANNA, { ...base, key: 'event:c-7' }), { ok: false, code: 'unavailable', reason: 'feature_off' });
}));

test('calendar_update for Notizen: place, reminder, all day, a series and back — only its own events', () => withMail(O, async (host, c) => {
  const anna = c.as(ANNA);
  await anna('GET', 'calendars');
  const d = day(4);
  const r = await call(host, 'calendar_add', ANNA, { userId: ANNA.id, title: 'Zahnarzt', allDay: false, start: at(d, 16, 30), end: at(d, 17, 30), key: 'event:u-1' });
  const upd = (p) => call(host, 'calendar_update', ANNA, { userId: ANNA.id, eventId: r.eventId, ...p });
  assert.deepEqual(await upd({ location: 'Praxis am Markt', reminder: 120 }), { ok: true, eventId: r.eventId });
  let ev = (await anna('GET', `events/${r.eventId}`)).json;
  assert.deepEqual([ev.location, ev.reminders, ev.start], ['Praxis am Markt', [120], at(d, 16, 30)]);
  assert.equal((await upd({ allDay: true, startsAt: d, endsAt: tz.addDays(d, 1), location: null, reminder: false })).ok, true);
  ev = (await anna('GET', `events/${r.eventId}`)).json;
  assert.deepEqual([ev.allDay, ev.startDate, ev.endDate, ev.location, ev.reminders], [true, d, tz.addDays(d, 1), null, []]);
  assert.equal((await upd({ start: at(d, 9), end: at(d, 10), recurrence: { freq: 'daily', count: 3 } })).ok, true);
  ev = (await anna('GET', `events/${r.eventId}`)).json;
  assert.deepEqual([ev.allDay, ev.recurring, ev.recurrence.count], [false, true, 3]);
  assert.equal((await upd({ recurrence: null })).ok, true);
  assert.equal((await anna('GET', `events/${r.eventId}`)).json.recurring, false);
  for (const bad of [{ location: 'x'.repeat(256) }, { reminder: 'bald' }, { recurrence: 'nie' }, { allDay: true, startsAt: d, start: at(d, 9), end: at(d, 10) }, { allDay: true, startsAt: 'morgen' }]) {
    assert.deepEqual(await upd(bad), { ok: false, code: 'invalid' }, JSON.stringify(bad));
  }
  // an event the person made in Mail stays out of reach
  const own = (await anna('POST', 'events', { title: 'Eigener', allDay: false, start: at(d, 11), end: at(d, 12) })).json.event;
  assert.deepEqual(await call(host, 'calendar_update', ANNA, { userId: ANNA.id, eventId: own.eventId, location: 'x' }), { ok: false, code: 'not_found' });
}));

test('events for the hub: only when it asks; own, tasks, shared and family calendars; invitations without an answer, declined and cancelled ones stay out', async () => {
  const hub = fakeHub();
  const fam = fakeOverlays({ familie: [{ id: 'f1', date: day(3), title: 'Geburtstag Oma', allDay: true, place: 'Bei Oma' }] });
  await withMail({ ...O, overlays: fam, services: [hub] }, async (host, c) => {
    notizen.source.state.noTimer = true;
    for (const u of [ANNA, MARC, BOB]) await c.addGmx(u);
    const anna = c.as(ANNA);
    const marc = c.as(MARC);
    const cals = (await anna('GET', 'calendars')).json.calendars;
    const d = day(2);
    const dentist = (await anna('POST', 'events', { calendarId: cals[0].id, title: 'Zahnarzt', location: 'Praxis am Markt', allDay: false, start: at(d, 16, 30), end: at(d, 17, 15), timeZone: BERLIN })).json.event;
    const trip = (await anna('POST', 'events', { calendarId: cals[1].id, title: 'Messe', allDay: true, startDate: d, endDate: tz.addDays(d, 1) })).json.event;
    await anna('POST', 'events', { calendarId: cals[0].id, title: 'Zu spät', allDay: false, start: at(day(notizen.EVENT_DAYS + 3), 9), end: at(day(notizen.EVENT_DAYS + 3), 10) });
    await anna('POST', 'events', { calendarId: cals[0].id, title: 'Gestern', allDay: false, start: at(day(-1), 9), end: at(day(-1), 10) });
    // a hub of contract v1 (no `accepts`): no event, the answer as before
    let p = await pull(host, ANNA, null);
    assert.deepEqual([p.items.filter((x) => x.kind === 'event').length, p.last.provides], [0, undefined]);
    await notizen.source.flush(host.gc, Date.now(), { force: true });
    assert.equal([...hub.items.values()].filter((x) => x.kind === 'event').length, 0);
    // the hub asks for events
    p = await pull(host, ANNA);
    assert.deepEqual(p.last.provides, ['calendar']);
    const evs = p.items.filter((x) => x.kind === 'event');
    for (const x of evs) assert.equal(checkItem(x, 'gatecontrol-mail'), null, x.id);
    assert.deepEqual(evs.map((x) => x.title).sort(), ['Geburtstag Oma', 'Messe', 'Zahnarzt']);
    const z = evs.find((x) => x.title === 'Zahnarzt');
    assert.deepEqual([z.id, z.subtitle, z.allDay, z.canComplete, z.done, z.area, z.users, z.group, z.open],
      [`ev:${dentist.eventId}`, 'Praxis am Markt', false, false, false, 'private', [ANNA.id], { id: `cal:${cals[0].id}`, label: 'Privat' }, { plugin: 'gatecontrol-mail', route: `event/${dentist.eventId}` }]);
    assert.equal(Date.parse(z.due), at(d, 16, 30));
    assert.match(z.due, /T16:30:00[+-]\d{2}:\d{2}$/);
    assert.deepEqual([z.meta.type, z.meta.cal, z.meta.location, Date.parse(z.meta.end), z.meta.eventId, z.meta.recurring, z.meta.writable, z.meta.color],
      ['calendar', 'own', 'Praxis am Markt', at(d, 17, 15), dentist.eventId, false, true, cals[0].color]);
    const m = evs.find((x) => x.title === 'Messe');
    assert.deepEqual([m.id, m.due, m.allDay, m.area, m.meta.endDate, m.meta.end], [`ev:${trip.eventId}`, d, true, 'work', tz.addDays(d, 1), undefined]);
    const o = evs.find((x) => x.title === 'Geburtstag Oma');
    assert.deepEqual([o.id.startsWith('ov:familie'), o.due, o.subtitle, o.group, o.meta.cal, o.meta.writable, o.open.route], [true, day(3), 'Bei Oma', { id: 'overlay:familie', label: 'Familie' }, 'family', false, `calendar/${day(3)}`]);
    // nobody else sees them
    assert.equal((await pull(host, BOB)).items.filter((x) => x.kind === 'event').length, 0);
    // an invitation: Marc sees it only once he said yes; declined: gone again
    const meet = (await anna('POST', 'events', { calendarId: cals[0].id, title: 'Planung', allDay: false, start: at(d, 10), end: at(d, 11), timeZone: BERLIN, attendees: [{ email: 'marc@gmx.de', name: 'Marc' }] })).json.event;
    const titles = async (u) => (await pull(host, u)).items.filter((x) => x.kind === 'event' && x.meta.cal !== 'family').map((x) => x.title).sort();
    assert.deepEqual(await titles(MARC), []);
    const inv = (await marc('GET', 'invitations')).json.items[0];
    assert.equal((await marc('POST', `invitations/${inv.id}/respond`, { response: 'accepted' })).status, 200);
    assert.deepEqual(await titles(MARC), ['Planung']);
    assert.ok((await titles(ANNA)).includes('Planung'), 'the organizer sees her own event');
    assert.equal((await marc('POST', `invitations/${inv.id}/respond`, { response: 'declined' })).status, 200);
    assert.deepEqual(await titles(MARC), []);
    assert.ok(meet.eventId > 0);
    // the calendar „Aufgaben“ and a calendar shared with the person are told apart (the hub hides „Aufgaben“ by itself)
    const tasks = (await call(host, 'calendar_tasks', ANNA, { userId: ANNA.id })).calendar;
    await call(host, 'calendar_add', ANNA, { userId: ANNA.id, calendarId: tasks.id, title: 'Müll rausstellen', allDay: false, start: at(d, 7), end: at(d, 7, 30), reminder: false, key: 'task:9' });
    const marcCal = (await marc('GET', 'calendars')).json.calendars[0];
    await marc('POST', 'events', { calendarId: marcCal.id, title: 'Marc beim Friseur', allDay: false, start: at(d, 12), end: at(d, 13) });
    await marc('POST', 'events', { calendarId: marcCal.id, title: 'Geheim', private: true, allDay: false, start: at(d, 13), end: at(d, 14) });
    await marc('POST', `calendars/${marcCal.id}/shares`, { type: 'user', id: ANNA.id, level: 'read' });
    assert.ok(!(await titles(ANNA)).includes('Marc beim Friseur'), 'not shown in Mail yet');
    await anna('PATCH', `shared/${marcCal.id}`, { visible: true });
    const all = (await pull(host, ANNA)).items.filter((x) => x.kind === 'event');
    assert.deepEqual(all.filter((x) => x.meta.cal === 'tasks').map((x) => [x.title, x.group.label]), [['Müll rausstellen', 'Aufgaben']]);
    assert.deepEqual(all.filter((x) => x.meta.cal === 'shared').map((x) => [x.title, x.group.id, x.meta.writable]), [['Marc beim Friseur', `cal:${marcCal.id}`, false]]);
    assert.ok(!JSON.stringify(all).includes('Geheim'));
    // the push: what changed, in one call; a deleted event is removed
    // (what a pull answered is not pushed again)
    const fresh = (await anna('POST', 'events', { calendarId: cals[0].id, title: 'Frisch', allDay: false, start: at(d, 21), end: at(d, 22) })).json.event;
    const f0 = await notizen.source.flush(host.gc, Date.now(), { force: true });
    assert.deepEqual([f0.sent, hub.rejected.length], [1, 0], JSON.stringify(hub.rejected));
    assert.equal((await notizen.source.flush(host.gc, Date.now(), { force: true })).sent, 0, 'nothing changed');
    assert.ok(hub.items.has(`gatecontrol-mail|ev:${fresh.eventId}`));
    assert.equal((await anna('DELETE', `events/${fresh.eventId}`)).status, 200);
    assert.equal((await anna('DELETE', `events/${dentist.eventId}`)).status, 200);
    const f = await notizen.source.flush(host.gc, Date.now(), { force: true });
    assert.deepEqual([f.sent, f.removed, f.upserted], [1, 2, 0]);
    assert.deepEqual(hub.pushes().at(-1).payload.remove.sort(), [`ev:${dentist.eventId}`, `ev:${fresh.eventId}`].sort());
    assert.ok(!hub.items.has(`gatecontrol-mail|ev:${fresh.eventId}`));
    // a series: one item per occurrence, each with its own id and route
    const wd = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][tz.weekday(d)];
    const chor = await call(host, 'calendar_add', ANNA, { userId: ANNA.id, title: 'Chor', allDay: false, start: at(d, 19), end: at(d, 20, 30), recurrence: { freq: 'weekly', byDay: [wd] }, key: 'event:s-1', items: true });
    assert.equal(chor.ok, true, JSON.stringify(chor));
    assert.ok(chor.items.length >= 4 && chor.items.length <= 5, String(chor.items.length));
    for (const x of chor.items) assert.equal(checkItem(x, 'gatecontrol-mail'), null, x.id);
    assert.equal(new Set(chor.items.map((x) => x.id)).size, chor.items.length);
    assert.ok(chor.items.every((x) => x.id.startsWith(`ev:${chor.eventId}:`) && x.open.route.startsWith(`event/${chor.eventId}/`) && x.meta.recurring === true));
    // moved through the service: the answer's items are the new ones
    const moved = await call(host, 'calendar_update', ANNA, { userId: ANNA.id, eventId: chor.eventId, recurrence: null, start: at(d, 18), end: at(d, 19), location: 'Gemeindehaus', items: true });
    assert.deepEqual(moved.items.map((x) => [x.id, x.subtitle, Date.parse(x.due)]), [[`ev:${chor.eventId}`, 'Gemeindehaus', at(d, 18)]]);
    // calendars switched off: every event goes
    await c.admin('PUT', 'admin/settings', { calendar: { enabled: false } });
    assert.equal((await pull(host, ANNA)).items.filter((x) => x.kind === 'event').length, 0);
    await c.admin('PUT', 'admin/settings', { calendar: { enabled: true } });
    // an older hub again (a pull without `accepts`): Mail stops reporting events and takes them back
    assert.equal((await pull(host, ANNA, null)).items.filter((x) => x.kind === 'event').length, 0);
    await notizen.source.flush(host.gc, Date.now(), { force: true });
    assert.equal([...hub.items.values()].filter((x) => x.kind === 'event').length, 0);
  });
});

test('events for the hub: a person without a mail account has them too; todo_complete refuses an event', () => withMail({ ...O, services: [fakeHub()] }, async (host, c) => {
  notizen.source.state.noTimer = true;
  const anna = c.as(ANNA);
  await anna('GET', 'calendars');
  const d = day(1);
  const r = await call(host, 'calendar_add', ANNA, { userId: ANNA.id, title: 'Elternabend', allDay: false, start: at(d, 19), end: at(d, 20), location: 'Aula', key: 'event:n-1' });
  const p = await pull(host, ANNA);
  assert.deepEqual(p.items.map((x) => [x.id, x.title, x.subtitle]), [[`ev:${r.eventId}`, 'Elternabend', 'Aula']]);
  assert.deepEqual(await host.callService('todo_complete', { caller: HUB, user: as(ANNA), payload: { v: 1, id: `ev:${r.eventId}`, done: true } }), { ok: false, code: 'read_only' });
}));
