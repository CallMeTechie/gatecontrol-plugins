'use strict';

// 1.3.0 — a task with a time as an event in Mail's calendar „Aufgaben“ (server/calsync.js): half an hour from the due
// time, without a reminder, in the calendar of the person whose task it is; the link follows every change (title, time,
// person, done, deleted, the next of a repeat, a deleted list), survives Mail being away, parked or installed later, and
// both switches take the events out again. First against a stand-in of Mail that keeps what it is told, then against the
// real Mail plugin (its own mock host, linked as a service provider).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { withHost, fakeSource, ANNA, MARC, LENA, clock, T0, PLUGINS } = require('./helpers');
const { createHost } = require('../../../tools/testing/mock-host');

const MAIL = 'gatecontrol-mail';
const CAL = ['calendar_tasks', 'calendar_add', 'calendar_update', 'calendar_delete'];
const at = (s) => Date.parse(s);

/** Mail's four calendar services as a stand-in: cal.events (id → event), cal.calls, cal.refuse (user id → reason), cal.down. */
function fakeCalendar() {
  const cal = { events: new Map(), calendars: new Map(), calls: [], refuse: new Map(), down: false, next: 100, nextCal: 7 };
  const provides = Object.fromEntries(CAL.map((s) => [s, { label: { de: 'x', en: 'x' }, maxPerHour: 3600 }]));
  const service = async ({ name, caller, user, payload }) => {
    if (cal.down) throw new Error('down');
    cal.calls.push({ name, user: user && user.id, payload });
    if (caller !== 'gatecontrol-notizen' || !user || payload.userId !== user.id) return { ok: false, code: 'forbidden' };
    if (cal.refuse.has(user.id)) return { ok: false, code: 'unavailable', reason: cal.refuse.get(user.id) };
    if (name === 'calendar_tasks') {
      if (!cal.calendars.has(user.id)) cal.calendars.set(user.id, cal.nextCal++);
      return { ok: true, calendar: { id: cal.calendars.get(user.id), name: 'Aufgaben', color: '#112233', created: false } };
    }
    if (name === 'calendar_add') {
      if (cal.calendars.get(user.id) !== payload.calendarId) return { ok: false, code: 'not_found' };
      const have = [...cal.events.values()].find((e) => e.user === user.id && e.key === payload.key);
      if (have) return { ok: true, eventId: have.id };
      const id = cal.next++;
      cal.events.set(id, { id, user: user.id, key: payload.key, title: payload.title, start: payload.start, end: payload.end, busy: payload.busy, note: payload.note, reminder: payload.reminder, allDay: payload.allDay, calendarId: payload.calendarId });
      return { ok: true, eventId: id };
    }
    const ev = cal.events.get(payload.eventId);
    if (name === 'calendar_update') {
      if (!ev || ev.user !== user.id) return { ok: false, code: 'not_found' };
      for (const k of ['title', 'start', 'end', 'busy', 'note']) if (payload[k] !== undefined) ev[k] = payload[k];
      return { ok: true, eventId: ev.id };
    }
    if (name === 'calendar_delete') {
      if (!ev || ev.user !== user.id) return { ok: true, removed: false };
      cal.events.delete(ev.id);
      return { ok: true, removed: true };
    }
    return { ok: false, code: 'not_found' };
  };
  return { cal, source: fakeSource(MAIL, { provides, service }) };
}

const sourcesWith = (mail) => PLUGINS.map((p) => (p === MAIL && mail ? mail : fakeSource(p)));
const shown = (cal) => [...cal.events.values()].map((e) => [e.user, e.title, e.start, e.end - e.start, e.busy]);
const names = (cal) => cal.calls.map((c) => c.name);

test('a task with a time gets its event at once: 30 minutes, no reminder, the person\'s calendar; one without a time gets none', async () => {
  const { cal, source } = fakeCalendar();
  const h = await withHost({ sources: sourcesWith(source) });
  try {
    assert.deepEqual((await h.ok(ANNA, 'GET', 'me')).calendar, { available: true, enabled: true, mine: true, name: 'Aufgaben' });
    const a = await h.ok(ANNA, 'POST', 'tasks', { text: 'morgen 9 Uhr Mülltonne rausstellen' });
    const start = at('2026-11-09T08:00:00Z');
    assert.deepEqual([...cal.events.values()], [{ id: 100, user: ANNA.id, key: 'task:' + a.task.id, title: 'Mülltonne rausstellen', start, end: start + 30 * 60000, busy: 'busy',
      note: 'Aufgabe · Aufgaben', reminder: false, allDay: false, calendarId: 7 }]);
    assert.deepEqual(a.task.calendar, { state: 'synced', eventId: 100, calendarId: 7, mine: true });
    assert.deepEqual(names(cal), ['calendar_tasks', 'calendar_add']);
    // a date only, no date, a sub task: no event, no call
    const b = await h.ok(ANNA, 'POST', 'tasks', { title: 'Nur Datum', due: { date: '2026-11-09' } });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Ohne' });
    await h.ok(ANNA, 'POST', 'tasks', { parentId: a.task.id, title: 'Deckel zu' });
    assert.equal(b.task.calendar, null);
    assert.equal(cal.calls.length, 2);
    // the second task of the person: the calendar is known, one call
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Arzt', due: { date: '2026-11-10', time: '15:30' } });
    assert.deepEqual(names(cal).slice(2), ['calendar_add']);
    // the background run finds nothing left to do
    await h.host.tick();
    assert.equal(cal.calls.length, 3);
    assert.equal((await h.host.gc.db.get('SELECT COUNT(*) AS n FROM tasks WHERE cal_dirty != 0')).row.n, 0);
  } finally { await h.close(); clock.set(T0); }
});

test('the event follows the task: title, time, moved, done („✓“, free) and open again, the next of a repeat, deleted', async () => {
  const { cal, source } = fakeCalendar();
  const h = await withHost({ sources: sourcesWith(source) });
  try {
    const a = await h.ok(ANNA, 'POST', 'tasks', { title: 'Tabletten', due: { date: '2026-11-09', time: '08:00' }, repeat: { type: 'daily', interval: 1 } });
    const s9 = at('2026-11-09T07:00:00Z');
    assert.deepEqual(shown(cal), [[ANNA.id, 'Tabletten', s9, 1800000, 'busy']]);
    await h.ok(ANNA, 'PATCH', 'tasks/' + a.task.id, { title: 'Tabletten nehmen', due: { date: '2026-11-09', time: '08:30' } });
    assert.deepEqual(shown(cal), [[ANNA.id, 'Tabletten nehmen', s9 + 1800000, 1800000, 'busy']]);
    // a note, „Mein Tag“, important: nothing the calendar shows — no call
    const before = cal.calls.length;
    await h.ok(ANNA, 'PATCH', 'tasks/' + a.task.id, { note: 'nach dem Essen', important: true, myDay: true });
    assert.equal(cal.calls.length, before);
    // „Verschieben“
    await h.ok(ANNA, 'POST', `tasks/${a.task.id}/move`, { to: '2026-11-11' });
    assert.deepEqual(shown(cal).map((e) => e[2]), [at('2026-11-11T07:30:00Z')]);
    // „Später“ moves the reminder, not the event
    const calls = cal.calls.length;
    await h.ok(ANNA, 'POST', `tasks/${a.task.id}/snooze`, { until: '1h' });
    assert.equal(cal.calls.length, calls);
    // done: the event stays as „✓ …“ with its time free; the next one of the repeat gets its own
    const done = await h.ok(ANNA, 'POST', `tasks/${a.task.id}/complete`, { done: true });
    assert.deepEqual(shown(cal), [[ANNA.id, '✓ Tabletten nehmen', at('2026-11-11T07:30:00Z'), 1800000, 'free'], [ANNA.id, 'Tabletten nehmen', at('2026-11-12T07:30:00Z'), 1800000, 'busy']]);
    assert.deepEqual([done.task.calendar.state, done.next.calendar.state], ['synced', 'synced']);
    assert.notEqual(done.task.calendar.eventId, done.next.calendar.eventId);
    // the time taken away: the event goes; set again: it is back
    await h.ok(ANNA, 'PATCH', 'tasks/' + done.next.id, { due: { date: '2026-11-12' } });
    assert.deepEqual(shown(cal).map((e) => e[1]), ['✓ Tabletten nehmen']);
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + done.next.id)).task.calendar, null);
    await h.ok(ANNA, 'PATCH', 'tasks/' + done.next.id, { due: { date: '2026-11-12', time: '10:00' } });
    assert.deepEqual(shown(cal).map((e) => e[1]), ['✓ Tabletten nehmen', 'Tabletten nehmen']);
    // deleted: gone from the calendar (the done one as well)
    await h.ok(ANNA, 'DELETE', 'tasks/' + done.next.id);
    await h.ok(ANNA, 'DELETE', 'tasks/' + a.task.id);
    assert.deepEqual(shown(cal), []);
  } finally { await h.close(); clock.set(T0); }
});

test('whose calendar: the person the task is assigned to; it moves with the assignment; a deleted list takes its events along', async () => {
  const { cal, source } = fakeCalendar();
  const h = await withHost({ sources: sourcesWith(source) });
  try {
    const l = await h.ok(ANNA, 'POST', 'lists', { name: 'Haus' });
    await h.ok(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [MARC.id] });
    const a = await h.ok(ANNA, 'POST', 'tasks', { title: 'Rasen mähen', listId: l.list.id, assigneeId: MARC.id, due: { date: '2026-11-09', time: '16:00' } });
    assert.deepEqual(shown(cal).map((e) => [e[0], e[1]]), [[MARC.id, 'Rasen mähen']]);
    assert.equal([...cal.events.values()][0].note, 'Aufgabe · Haus');
    assert.deepEqual([a.task.calendar.state, a.task.calendar.mine], ['synced', false]);
    assert.equal((await h.ok(MARC, 'GET', 'tasks/' + a.task.id)).task.calendar.mine, true);
    // assigned to nobody: it is Anna's (she made it) — out of Marc's calendar, into hers
    await h.ok(ANNA, 'PATCH', 'tasks/' + a.task.id, { assigneeId: null });
    assert.deepEqual(shown(cal).map((e) => [e[0], e[1]]), [[ANNA.id, 'Rasen mähen']]);
    // Marc again, then he leaves the list: the background run brings it back to the owner
    await h.ok(ANNA, 'PATCH', 'tasks/' + a.task.id, { assigneeId: MARC.id });
    assert.deepEqual(shown(cal).map((e) => e[0]), [MARC.id]);
    await h.ok(MARC, 'DELETE', 'lists/' + l.list.id);
    await h.host.tick();
    assert.deepEqual(shown(cal).map((e) => e[0]), [ANNA.id]);
    // the list deleted: the event goes; restored: it is back
    await h.ok(ANNA, 'DELETE', 'lists/' + l.list.id);
    await h.host.tick();
    assert.deepEqual(shown(cal), []);
    await h.ok(ANNA, 'POST', `lists/${l.list.id}/restore`);
    await h.host.tick();
    assert.deepEqual(shown(cal).map((e) => [e[0], e[1]]), [[ANNA.id, 'Rasen mähen']]);
  } finally { await h.close(); clock.set(T0); }
});

test('Mail not there, down, or installed later: nothing is lost — the tasks are written once it answers', async () => {
  const { cal, source } = fakeCalendar();
  // an older Mail: it has todo_items but none of the calendar services
  const old = fakeSource(MAIL);
  const h = await withHost({ sources: sourcesWith(old) });
  try {
    assert.equal((await h.ok(ANNA, 'GET', 'me')).calendar.available, false);
    const a = await h.ok(ANNA, 'POST', 'tasks', { title: 'Zahnarzt', due: { date: '2026-11-09', time: '09:00' } });
    assert.equal(a.task.calendar, null, 'no Mail with a calendar: no sign of one');
    await h.host.tick();
    // Mail is updated (the same provider now offers the services) — a minute later the task is in
    Object.assign(old.entry.provides, source.provides);
    old.entry.service = source.service;
    clock.set(T0 + 61000);
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + a.task.id)).task.calendar.state, 'pending');
    await h.host.tick();
    assert.deepEqual(shown(cal).map((e) => e[1]), ['Zahnarzt']);
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + a.task.id)).task.calendar.state, 'synced');
    // Mail does not answer: the change waits and is written by a later run
    cal.down = true;
    await h.ok(ANNA, 'PATCH', 'tasks/' + a.task.id, { title: 'Zahnarzt anrufen' });
    assert.equal((await h.ok(ANNA, 'GET', 'tasks/' + a.task.id)).task.title, 'Zahnarzt anrufen', 'the task itself is saved all the same');
    await h.host.tick();
    assert.deepEqual(shown(cal).map((e) => e[1]), ['Zahnarzt']);
    cal.down = false;
    clock.set(T0 + 200000);
    await h.host.tick();
    assert.deepEqual(shown(cal).map((e) => e[1]), ['Zahnarzt anrufen']);
    assert.equal((await h.host.gc.db.get('SELECT COUNT(*) AS n FROM tasks WHERE cal_dirty != 0')).row.n, 0);
  } finally { await h.close(); clock.set(T0); }
});

test('Mail refuses for a person (no place): parked, asked again a day later — not every minute', async () => {
  const { cal, source } = fakeCalendar();
  const h = await withHost({ sources: sourcesWith(source) });
  try {
    cal.refuse.set(ANNA.id, 'no_seat');
    const a = await h.ok(ANNA, 'POST', 'tasks', { title: 'Zahnarzt', due: { date: '2026-11-12', time: '09:00' } });
    assert.equal(a.task.calendar, null);
    // (the first run after a start asks once more — a restart is a reason to)
    await h.host.tick();
    const calls = cal.calls.length;
    for (let i = 1; i <= 5; i++) { clock.set(T0 + i * 60000); await h.host.tick(); }
    assert.equal(cal.calls.length, calls, 'no call while parked');
    // the person gets a place; the next day the task is asked for again
    cal.refuse.clear();
    clock.set(T0 + 25 * 3600000);
    await h.host.tick();
    assert.deepEqual(shown(cal).map((e) => e[1]), ['Zahnarzt']);
  } finally { await h.close(); clock.set(T0); }
});

test('deleted in the calendar: the calendar „Aufgaben“ is asked for again, an event comes back with the task\'s next change', async () => {
  const { cal, source } = fakeCalendar();
  const h = await withHost({ sources: sourcesWith(source) });
  try {
    const a = await h.ok(ANNA, 'POST', 'tasks', { title: 'Eins', due: { date: '2026-11-09', time: '09:00' } });
    // the person deletes the event in Mail
    cal.events.clear();
    await h.ok(ANNA, 'PATCH', 'tasks/' + a.task.id, { title: 'Eins neu' });
    assert.deepEqual(shown(cal).map((e) => e[1]), ['Eins neu']);
    // the person deletes the whole calendar in Mail: it gets a new number there
    cal.events.clear();
    cal.calendars.set(ANNA.id, 55);
    const b = await h.ok(ANNA, 'POST', 'tasks', { title: 'Zwei', due: { date: '2026-11-09', time: '11:00' } });
    assert.deepEqual([...cal.events.values()].map((e) => [e.title, e.calendarId]), [['Zwei', 55]]);
    assert.equal(b.task.calendar.calendarId, 55);
  } finally { await h.close(); clock.set(T0); }
});

test('the switches: the administrator\'s and the person\'s own take the events out again and bring them back', async () => {
  const { cal, source } = fakeCalendar();
  const h = await withHost({ sources: sourcesWith(source) });
  try {
    const l = await h.ok(ANNA, 'POST', 'lists', { name: 'Haus' });
    await h.ok(ANNA, 'PUT', `lists/${l.list.id}/members`, { members: [MARC.id] });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Annas', due: { date: '2026-11-09', time: '09:00' } });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Marcs', listId: l.list.id, assigneeId: MARC.id, due: { date: '2026-11-09', time: '10:00' } });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Vorbei', due: { date: '2026-11-07', time: '10:00' } });
    assert.deepEqual(shown(cal).map((e) => e[1]), ['Annas', 'Marcs', 'Vorbei']);
    // Marc switches it off for himself: only his goes
    assert.equal((await h.ok(MARC, 'PUT', 'prefs', { calendar: { tasks: false } })).prefs.calendar.tasks, false);
    await h.host.tick();
    assert.deepEqual(shown(cal).map((e) => e[1]), ['Annas', 'Vorbei']);
    assert.deepEqual((await h.ok(MARC, 'GET', 'me')).calendar, { available: true, enabled: true, mine: false, name: 'Aufgaben' });
    await h.ok(MARC, 'PUT', 'prefs', { calendar: { tasks: true } });
    await h.host.tick();
    assert.deepEqual(shown(cal).map((e) => e[1]), ['Annas', 'Vorbei', 'Marcs']);
    // the administrator switches it off: all go, nothing new comes
    await h.host.saveSettings({ calendar_tasks: false });
    await h.host.tick();
    assert.deepEqual(shown(cal), []);
    const t = await h.ok(ANNA, 'POST', 'tasks', { title: 'Neu', due: { date: '2026-11-10', time: '09:00' } });
    assert.equal(t.task.calendar, null);
    assert.equal((await h.ok(ANNA, 'GET', 'me')).calendar.enabled, false);
    await h.host.tick();
    assert.deepEqual(shown(cal), []);
    // on again: the open tasks from today on are written — not the one of the day before yesterday
    await h.host.saveSettings({ calendar_tasks: true });
    await h.host.tick();
    assert.deepEqual(shown(cal).map((e) => e[1]).sort(), ['Annas', 'Marcs', 'Neu']);
  } finally { await h.close(); clock.set(T0); }
});

test('the migration of 1.3.0 marks the open tasks with a time from today on — written once Mail is there', async () => {
  const { cal, source } = fakeCalendar();
  const h = await withHost({ sources: sourcesWith(fakeSource(MAIL)) });
  try {
    // tasks as 1.2 left them: no mark at all
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Morgen', due: { date: '2026-11-09', time: '09:00' } });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Letzte Woche', due: { date: '2026-11-02', time: '09:00' } });
    await h.ok(ANNA, 'POST', 'tasks', { title: 'Ohne Zeit', due: { date: '2026-11-09' } });
    await h.host.gc.db.run('UPDATE tasks SET cal_dirty = 0');
    // the statement of migrations/005_reminders_calendar.sql, with the day of the test for date('now')
    const sql = require('node:fs').readFileSync(path.join(__dirname, '..', 'migrations', '005_reminders_calendar.sql'), 'utf8');
    const stmt = sql.split(';').map((s) => s.replace(/^\s*--.*$/gm, '').trim()).find((s) => s.startsWith('UPDATE tasks SET cal_dirty = 1'));
    assert.ok(stmt && stmt.includes("date('now')"), 'the migration marks the tasks');
    await h.host.gc.db.run(stmt.replace("date('now')", "'2026-11-08'"));
    const marked = (await h.host.gc.db.query('SELECT title FROM tasks WHERE cal_dirty = 1 ORDER BY id')).rows.map((r) => r.title);
    assert.deepEqual(marked, ['Morgen']);
    const mail = h.src(MAIL);
    Object.assign(mail.entry.provides, source.provides);
    mail.entry.service = source.service;
    clock.set(T0 + 61000);
    await h.host.tick();
    assert.deepEqual(shown(cal).map((e) => e[1]), ['Morgen']);
  } finally { await h.close(); clock.set(T0); }
});

test('with the real Mail plugin: the event is in the calendar „Aufgaben“, without a reminder, and follows the task', async () => {
  const mailDir = path.join(__dirname, '..', '..', MAIL);
  const users = [ANNA, MARC, LENA];
  const mail = await createHost(mailDir, { users, gatecontrol: '1.219.0', mail: {}, services: [], license: { required: true, licensed: true, state: 'valid', expiresAt: null } });
  await mail.start();
  const asMail = (u, method, p, body) => mail.request({ method, path: p, body: body === undefined ? null : body, query: {}, user: { ...u, portal: true, loggedIn: true, app: true }, lang: 'de' });
  const h = await withHost({ host: { services: [...PLUGINS.filter((p) => p !== MAIL).map((p) => { const s = fakeSource(p); return { plugin: s.plugin, provides: s.provides, service: s.service }; }), { plugin: MAIL, host: mail }] } });
  try {
    await asMail(ANNA, 'GET', 'me'); // Anna has opened Mail once (her place of the licence)
    const a = await h.ok(ANNA, 'POST', 'tasks', { text: 'morgen 9 Uhr Mülltonne rausstellen' });
    assert.equal(a.task.calendar.state, 'synced', JSON.stringify(a.task.calendar));
    const cals = (await asMail(ANNA, 'GET', 'calendars')).json.calendars;
    const tasksCal = cals.find((c) => c.role === 'tasks');
    assert.deepEqual([tasksCal.name, tasksCal.source, tasksCal.id], ['Aufgaben', 'local', a.task.calendar.calendarId]);
    let ev = (await asMail(ANNA, 'GET', 'events/' + a.task.calendar.eventId)).json;
    const start = at('2026-11-09T08:00:00Z');
    assert.deepEqual([ev.title, ev.allDay, ev.start, ev.end, ev.reminders, ev.calendarId, ev.busy, ev.description],
      ['Mülltonne rausstellen', false, start, start + 30 * 60000, [], tasksCal.id, 'busy', 'Aufgabe · Aufgaben']);
    // moved to the weekend, then done
    await h.ok(ANNA, 'POST', `tasks/${a.task.id}/move`, { to: 'weekend' });
    await h.ok(ANNA, 'POST', `tasks/${a.task.id}/complete`, { done: true });
    ev = (await asMail(ANNA, 'GET', 'events/' + a.task.calendar.eventId)).json;
    assert.deepEqual([ev.title, ev.start, ev.busy, ev.reminders], ['✓ Mülltonne rausstellen', at('2026-11-14T08:00:00Z'), 'free', []]);
    // deleted in Notizen: gone in Mail
    await h.ok(ANNA, 'DELETE', 'tasks/' + a.task.id);
    assert.equal((await asMail(ANNA, 'GET', 'events/' + a.task.calendar.eventId)).status, 404);
    // Mail's own reminders have nothing to say about such events
    assert.equal((await mail.gc.db.get('SELECT COUNT(*) AS n FROM reminders_sent')).row.n, 0);
  } finally { await h.close(); await mail.close(); clock.set(T0); }
});
