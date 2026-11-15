'use strict';

// The services for Drive (1.6.0, server/services.js): calendar_list and calendar_add — the calendars a person can write
// to, an all-day event like POST events with the all-day reminder, idempotent by key, the refusals. tofile_count (1.7.0):
// "Zum Ablegen" for Drive's overview. The accounts' calendars
// (Microsoft Graph, CalDAV): test/graphpim.test.js and test/caldav.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, ANNA, MARC, BOB } = require('./helpers');

const DRIVE = 'gatecontrol-drive';
const as = (u) => ({ id: u.id, name: u.name, role: 'user' });
const call = (host, name, user, payload, caller = DRIVE) => host.callService(name, { caller, user: user ? as(user) : null, payload });

test('calendar_list and calendar_add: own calendars, an all-day event with note and all-day reminder, the same key once, the refusals', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  await c.as(ANNA)('GET', 'me');
  const list = await call(host, 'calendar_list', ANNA, { userId: ANNA.id });
  assert.equal(list.ok, true);
  assert.deepEqual(list.calendars.map((x) => [x.name, x.account.label, x.account.kind, x.account.id, x.writable]),
    [['Privat', 'GateControl', 'local', null, true], ['Firma', 'GateControl', 'local', null, true]]);
  assert.match(list.calendars[0].color, /^#[0-9A-F]{6}$/);
  const priv = list.calendars[0];
  const payload = { userId: ANNA.id, calendarId: priv.id, title: 'Kfz-Versicherung kündigen', startsAt: '2026-11-30', allDay: true,
    note: 'Versicherung.pdf\nIn Drive öffnen: https://gc.example/d/1', key: 'drive:deadline:7' };
  const r = await call(host, 'calendar_add', ANNA, payload);
  assert.equal(r.ok, true, JSON.stringify(r));
  const ev = (await c.as(ANNA)('GET', `events/${r.eventId}`)).json;
  assert.deepEqual([ev.title, ev.allDay, ev.startDate, ev.endDate, ev.description, ev.reminders, ev.calendarId],
    ['Kfz-Versicherung kündigen', true, '2026-11-30', '2026-11-30', payload.note, [360], priv.id]);
  // the same key: the same event — also two at once; another key: a new one
  const again = await Promise.all([call(host, 'calendar_add', ANNA, payload), call(host, 'calendar_add', ANNA, payload)]);
  assert.deepEqual(again.map((x) => x.eventId), [r.eventId, r.eventId]);
  const other = await call(host, 'calendar_add', ANNA, { ...payload, key: 'drive:deadline:8' });
  assert.notEqual(other.eventId, r.eventId);
  const nokey = await call(host, 'calendar_add', ANNA, { userId: ANNA.id, calendarId: priv.id, title: 'Ohne Schlüssel', startsAt: '2026-12-01' });
  assert.equal(nokey.ok, true);
  // the event deleted in the calendar: the key makes a new one
  assert.equal((await c.as(ANNA)('DELETE', `events/${r.eventId}`)).status, 200);
  const anew = await call(host, 'calendar_add', ANNA, payload);
  assert.ok(anew.ok && anew.eventId !== r.eventId);
  // only Drive, only for the person of the call
  assert.deepEqual(await call(host, 'calendar_list', ANNA, { userId: ANNA.id }, 'gatecontrol-familie'), { ok: false, code: 'forbidden' });
  assert.deepEqual(await call(host, 'calendar_add', ANNA, payload, 'gatecontrol-messenger'), { ok: false, code: 'forbidden' });
  assert.deepEqual(await call(host, 'calendar_add', MARC, payload), { ok: false, code: 'forbidden' });
  assert.deepEqual(await call(host, 'calendar_list', null, { userId: ANNA.id }), { ok: false, code: 'forbidden' });
  // input
  for (const bad of [{ title: '' }, { title: 'x'.repeat(81) }, { startsAt: '30.11.2026' }, { startsAt: '2026-02-30T10:00' }, { allDay: false }, { note: 'x'.repeat(501) },
    { key: 'kein Schlüssel' }, { calendarId: 'Privat' }]) {
    assert.deepEqual(await call(host, 'calendar_add', ANNA, { ...payload, ...bad }), { ok: false, code: 'invalid' }, JSON.stringify(bad));
  }
  // another person's calendar, a calendar that is not there
  await c.as(MARC)('GET', 'me');
  const marc = await call(host, 'calendar_list', MARC, { userId: MARC.id });
  assert.deepEqual(await call(host, 'calendar_add', ANNA, { ...payload, calendarId: marc.calendars[0].id }), { ok: false, code: 'not_found' });
  assert.deepEqual(await call(host, 'calendar_add', ANNA, { ...payload, calendarId: 99999 }), { ok: false, code: 'not_found' });
  // the administrator switches calendars off: none, unavailable
  await c.admin('PUT', 'admin/settings', { calendar: { enabled: false } });
  assert.deepEqual(await call(host, 'calendar_list', ANNA, { userId: ANNA.id }), { ok: true, calendars: [] });
  assert.deepEqual(await call(host, 'calendar_add', ANNA, payload), { ok: false, code: 'unavailable', reason: 'feature_off' });
}));

test('calendar_list and calendar_add: a person without a place has no calendars; a disconnected account is unavailable', () => withMail({ gatecontrol: '1.219.0', license: { tier: 'family', seats: { included: 2, family: 0, business: 0 } } }, async (host, c) => {
  await c.as(ANNA)('GET', 'me');
  await c.as(MARC)('GET', 'me');
  assert.equal((await c.as(BOB)('GET', 'me')).json.seat, null);
  assert.deepEqual(await call(host, 'calendar_list', BOB, { userId: BOB.id }), { ok: true, calendars: [] });
  assert.deepEqual(await call(host, 'calendar_add', BOB, { userId: BOB.id, calendarId: 1, title: 'x', startsAt: '2026-11-30', allDay: true }),
    { ok: false, code: 'unavailable', reason: 'no_seat' });
  // nobody gets a place from Drive asking
  assert.equal((await c.db('SELECT COUNT(*) AS n FROM seats WHERE user_id = ?', [BOB.id]))[0].n, 0);
  // an account calendar whose sign-in failed
  const acc = await c.addGmx(ANNA);
  await c.as(ANNA)('GET', 'calendars');
  const now = Date.now();
  const ins = await host.gc.db.run(`INSERT INTO calendars (user_id, account_id, source, name, color, kind, writable, is_default, sort, state, synced_at, created_at)
    VALUES (?, ?, 'caldav', 'Kalender', '#FF8800', 'private', 1, 0, 0, 'ok', ?, ?)`, [ANNA.id, acc.id, now, now]);
  const calId = Number(ins.lastInsertRowid);
  const list = await call(host, 'calendar_list', ANNA, { userId: ANNA.id, lang: 'en' });
  const gmx = list.calendars.find((x) => x.id === calId);
  assert.deepEqual(gmx.account, { id: acc.id, label: 'GMX', kind: 'gmx', email: acc.email });
  await host.gc.db.run("UPDATE accounts SET state = 'auth_failed' WHERE id = ?", [acc.id]);
  assert.deepEqual(await call(host, 'calendar_add', ANNA, { userId: ANNA.id, calendarId: calId, title: 'x', startsAt: '2026-11-30', allDay: true }),
    { ok: false, code: 'unavailable', reason: 'auth_failed' });
}));

test('tofile_count: the attachments of "Zum Ablegen" and the suggestion of the newest; only Drive, only the person, the refusals', () => withMail({ license: { tier: 'family', seats: { included: 2, family: 0, business: 0 } } }, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  const acc = await c.addGmx(ANNA);
  await c.tick();
  // nothing to file yet
  assert.deepEqual(await call(host, 'tofile_count', ANNA, { userId: ANNA.id }), { ok: true, count: 0, hint: null });
  // automatic filing with unsure suggestions: the attachments wait in "Zum Ablegen"
  await c.as(ANNA)('PATCH', `accounts/${acc.id}`, { attachments: 'auto' });
  const orig = c.drive.service;
  const where = { 'Vertrag.pdf': 'Meine Dateien › Verträge', 'Police.pdf': 'Familie › Versicherungen', 'Beleg.pdf': null };
  c.drive.service = async (x) => (x.name === 'suggest_folder'
    ? { ok: true, suggestion: where[x.payload.name] ? { folderId: 12, areaId: 'mine:2', path: 'x', where: where[x.payload.name], name: x.payload.name, confidence: 0.6, reason: 'ai' } : null, sha256Exists: false }
    : orig(x));
  for (const [name, subject] of [['Vertrag.pdf', 'Vertrag'], ['Police.pdf', 'Police']]) {
    c.mail.deliver('anna@gmx.de', { from: { address: 'post@firma.example' }, subject, text: 'x', attachments: [{ filename: name, contentType: 'application/pdf', data: '%PDF-' + name }] });
    await settle(1200);
    await c.tick();
  }
  const items = (await c.as(ANNA)('GET', 'filing')).json.items;
  assert.deepEqual(items.map((x) => x.name), ['Police.pdf', 'Vertrag.pdf']);
  assert.deepEqual(await call(host, 'tofile_count', ANNA, { userId: ANNA.id }), { ok: true, count: 2, hint: 'Familie › Versicherungen' });
  // the newest without a suggestion: no hint
  c.mail.deliver('anna@gmx.de', { from: { address: 'post@firma.example' }, subject: 'Beleg', text: 'x', attachments: [{ filename: 'Beleg.pdf', contentType: 'application/pdf', data: '%PDF-b' }] });
  await settle(1200);
  await c.tick();
  assert.deepEqual(await call(host, 'tofile_count', ANNA, { userId: ANNA.id }), { ok: true, count: 3, hint: null });
  // filed or dismissed: gone from the count
  const now = (await c.as(ANNA)('GET', 'filing')).json.items;
  assert.equal((await c.as(ANNA)('POST', `filing/${now[0].id}/dismiss`)).status, 200);
  assert.deepEqual(await call(host, 'tofile_count', ANNA, { userId: ANNA.id }), { ok: true, count: 2, hint: 'Familie › Versicherungen' });
  // only Drive, only for the person of the call
  assert.deepEqual(await call(host, 'tofile_count', ANNA, { userId: ANNA.id }, 'gatecontrol-familie'), { ok: false, code: 'forbidden' });
  assert.deepEqual(await call(host, 'tofile_count', MARC, { userId: ANNA.id }), { ok: false, code: 'forbidden' });
  assert.deepEqual(await call(host, 'tofile_count', null, { userId: ANNA.id }), { ok: false, code: 'forbidden' });
  // another person has their own (none)
  await c.as(MARC)('GET', 'me');
  assert.deepEqual(await call(host, 'tofile_count', MARC, { userId: MARC.id }), { ok: true, count: 0, hint: null });
  // no place (the licence is full): unavailable — and nobody gets a place from Drive asking
  assert.deepEqual(await call(host, 'tofile_count', BOB, { userId: BOB.id }), { ok: false, code: 'unavailable', reason: 'no_seat' });
  assert.equal((await c.db('SELECT COUNT(*) AS n FROM seats WHERE user_id = ?', [BOB.id]))[0].n, 0);
}));

// ─── 1.15.0: the calendar „Aufgaben“ for Notizen & Aufgaben ──────────

const NOTIZEN = 'gatecontrol-notizen';
const START = Date.parse('2026-11-15T08:00:00Z'); // 09:00 in Berlin

test('1.15.0 calendar_tasks: the person\'s calendar „Aufgaben“ is a GateControl calendar of its own, made once', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  await c.as(ANNA)('GET', 'me');
  const [a, b] = await Promise.all([call(host, 'calendar_tasks', ANNA, { userId: ANNA.id }, NOTIZEN), call(host, 'calendar_tasks', ANNA, { userId: ANNA.id }, NOTIZEN)]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.calendar.id, b.calendar.id);
  assert.deepEqual([a.calendar.created, b.calendar.created].sort(), [false, true]);
  assert.equal(a.calendar.name, 'Aufgaben');
  const list = (await c.as(ANNA)('GET', 'calendars')).json.calendars;
  assert.deepEqual(list.map((x) => [x.name, x.source, x.role, x.isDefault, x.writable]),
    [['Privat', 'local', null, true, true], ['Firma', 'local', null, false, true], ['Aufgaben', 'local', 'tasks', false, true]]);
  // another person gets their own, in their language
  await c.as(MARC)('GET', 'me');
  const m = await call(host, 'calendar_tasks', MARC, { userId: MARC.id, lang: 'en' }, NOTIZEN);
  assert.equal(m.calendar.name, 'Tasks');
  assert.notEqual(m.calendar.id, a.calendar.id);
  // only Notizen & Aufgaben, only for the person of the call
  assert.deepEqual(await call(host, 'calendar_tasks', ANNA, { userId: ANNA.id }), { ok: false, code: 'forbidden' });
  assert.deepEqual(await call(host, 'calendar_tasks', MARC, { userId: ANNA.id }, NOTIZEN), { ok: false, code: 'forbidden' });
  // deleted by the person: the next call makes a new one
  assert.equal((await c.as(ANNA)('DELETE', `calendars/${a.calendar.id}`)).status, 200);
  const anew = await call(host, 'calendar_tasks', ANNA, { userId: ANNA.id }, NOTIZEN);
  assert.ok(anew.ok && anew.calendar.created && anew.calendar.id !== a.calendar.id);
  // calendars switched off
  await c.admin('PUT', 'admin/settings', { calendar: { enabled: false } });
  assert.deepEqual(await call(host, 'calendar_tasks', ANNA, { userId: ANNA.id }, NOTIZEN), { ok: false, code: 'unavailable', reason: 'feature_off' });
}));

test('1.15.0 calendar_add with a time and without a reminder, calendar_update, calendar_delete — only events the caller made', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  await c.as(ANNA)('GET', 'me');
  const cal = (await call(host, 'calendar_tasks', ANNA, { userId: ANNA.id }, NOTIZEN)).calendar;
  const payload = { userId: ANNA.id, calendarId: cal.id, title: 'Mülltonne rausstellen', allDay: false, start: START, end: START + 30 * 60000, reminder: false, note: 'Aufgabe · Aufgaben', key: 'task:41' };
  const r = await call(host, 'calendar_add', ANNA, payload, NOTIZEN);
  assert.equal(r.ok, true, JSON.stringify(r));
  let ev = (await c.as(ANNA)('GET', `events/${r.eventId}`)).json;
  assert.deepEqual([ev.title, ev.allDay, ev.start, ev.end, ev.reminders, ev.calendarId, ev.description, ev.busy],
    ['Mülltonne rausstellen', false, START, START + 30 * 60000, [], cal.id, 'Aufgabe · Aufgaben', 'busy']);
  // the same key again: the same event
  assert.equal((await call(host, 'calendar_add', ANNA, payload, NOTIZEN)).eventId, r.eventId);
  // a title of 255 characters for Notizen, not for Drive
  assert.equal((await call(host, 'calendar_add', ANNA, { ...payload, title: 'x'.repeat(255), key: 'task:42' }, NOTIZEN)).ok, true);
  assert.deepEqual(await call(host, 'calendar_add', ANNA, { ...payload, title: 'x'.repeat(256), key: 'task:43' }, NOTIZEN), { ok: false, code: 'invalid' });
  assert.deepEqual(await call(host, 'calendar_add', ANNA, { ...payload, title: 'x'.repeat(81), key: 'drive:1' }), { ok: false, code: 'invalid' });
  for (const bad of [{ end: START - 1 }, { start: 'morgen' }, { end: START + 8 * 86400000 }, { reminder: true }, { busy: 'oof' }]) {
    assert.deepEqual(await call(host, 'calendar_add', ANNA, { ...payload, key: 'task:44', ...bad }, NOTIZEN), { ok: false, code: 'invalid' }, JSON.stringify(bad));
  }
  // moved by a day, done („✓“, the time is free again)
  const later = START + 86400000;
  assert.deepEqual(await call(host, 'calendar_update', ANNA, { userId: ANNA.id, eventId: r.eventId, start: later, end: later + 30 * 60000 }, NOTIZEN), { ok: true, eventId: r.eventId });
  assert.deepEqual(await call(host, 'calendar_update', ANNA, { userId: ANNA.id, eventId: r.eventId, title: '✓ Mülltonne rausstellen', busy: 'free' }, NOTIZEN), { ok: true, eventId: r.eventId });
  ev = (await c.as(ANNA)('GET', `events/${r.eventId}`)).json;
  assert.deepEqual([ev.title, ev.start, ev.end, ev.busy, ev.reminders, ev.description], ['✓ Mülltonne rausstellen', later, later + 30 * 60000, 'free', [], 'Aufgabe · Aufgaben']);
  // nothing given: nothing changes
  assert.deepEqual(await call(host, 'calendar_update', ANNA, { userId: ANNA.id, eventId: r.eventId }, NOTIZEN), { ok: true, eventId: r.eventId });
  // an event the person wrote themselves, another person's, another caller: never
  const own = (await c.as(ANNA)('POST', 'events', { title: 'Eigener Termin', allDay: false, start: START, end: START + 3600000 })).json.event;
  assert.deepEqual(await call(host, 'calendar_update', ANNA, { userId: ANNA.id, eventId: own.eventId, title: 'x' }, NOTIZEN), { ok: false, code: 'not_found' });
  assert.deepEqual(await call(host, 'calendar_delete', ANNA, { userId: ANNA.id, eventId: own.eventId }, NOTIZEN), { ok: true, removed: false });
  assert.equal((await c.as(ANNA)('GET', `events/${own.eventId}`)).status, 200);
  await c.as(MARC)('GET', 'me');
  assert.deepEqual(await call(host, 'calendar_update', MARC, { userId: MARC.id, eventId: r.eventId, title: 'x' }, NOTIZEN), { ok: false, code: 'not_found' });
  assert.deepEqual(await call(host, 'calendar_update', ANNA, { userId: ANNA.id, eventId: r.eventId, title: 'x' }), { ok: false, code: 'forbidden' });
  assert.deepEqual(await call(host, 'calendar_delete', ANNA, { userId: ANNA.id, eventId: r.eventId }), { ok: false, code: 'forbidden' });
  // delete: once
  assert.deepEqual(await call(host, 'calendar_delete', ANNA, { userId: ANNA.id, eventId: r.eventId }, NOTIZEN), { ok: true, removed: true });
  assert.equal((await c.as(ANNA)('GET', `events/${r.eventId}`)).status, 404);
  assert.deepEqual(await call(host, 'calendar_delete', ANNA, { userId: ANNA.id, eventId: r.eventId }, NOTIZEN), { ok: true, removed: false });
  assert.deepEqual(await call(host, 'calendar_update', ANNA, { userId: ANNA.id, eventId: r.eventId, title: 'x' }, NOTIZEN), { ok: false, code: 'not_found' });
  // deleted in the calendar by the person: update says not_found, the key makes a new event
  const again = await call(host, 'calendar_add', ANNA, payload, NOTIZEN);
  assert.equal((await c.as(ANNA)('DELETE', `events/${again.eventId}`)).status, 200);
  assert.deepEqual(await call(host, 'calendar_update', ANNA, { userId: ANNA.id, eventId: again.eventId, title: 'x' }, NOTIZEN), { ok: false, code: 'not_found' });
  // an event of the person's own that gets the number of the deleted one (SQLite gives it out again) is not the caller's
  const reused = (await c.as(ANNA)('POST', 'events', { calendarId: cal.id, title: 'Selbst eingetragen', allDay: false, start: START, end: START + 3600000 })).json.event;
  assert.deepEqual(await call(host, 'calendar_update', ANNA, { userId: ANNA.id, eventId: reused.eventId, title: 'x' }, NOTIZEN), { ok: false, code: 'not_found' });
  assert.deepEqual(await call(host, 'calendar_delete', ANNA, { userId: ANNA.id, eventId: reused.eventId }, NOTIZEN), { ok: true, removed: false });
  const anew = await call(host, 'calendar_add', ANNA, payload, NOTIZEN);
  assert.ok(anew.ok && anew.eventId !== reused.eventId, JSON.stringify(anew));
  assert.equal((await c.as(ANNA)('GET', `events/${reused.eventId}`)).json.title, 'Selbst eingetragen');
  // no reminder is ever due for such an event
  assert.equal((await c.db('SELECT COUNT(*) AS n FROM reminders_sent'))[0].n, 0);
}));

test('1.16.0 contacts_phones: own contacts with a number for the Messenger — kinds, keys, +49, landlines last, search, pages, ids; only the Messenger, only the person', () => withMail({ gatecontrol: '1.219.0', license: { tier: 'family', seats: { included: 2, family: 0, business: 0 } } }, async (host, c) => {
  const MS = 'gatecontrol-messenger';
  const anna = c.as(ANNA);
  const mk = async (b) => { const r = await anna('POST', 'cards', b); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.card; };
  const paul = await mk({ name: { given: 'Paul', family: 'Hoffmann' }, phones: [{ value: '0160 98765432', type: 'mobile' }] });
  const sabine = await mk({ name: { given: 'Sabine', family: 'Wolf' }, phones: [{ value: '+49 30 12345678', type: 'home' }, { value: '+49 170 2345678', type: 'work' }, { value: '+49 (0)151 23456780', type: 'mobile' }, { value: '030 999', type: 'fax' }, { value: '+49 171 1111111', type: 'mobile' }] });
  await mk({ name: { given: 'Ohne', family: 'Nummer' }, emails: [{ value: 'ohne@example.com' }] });
  const odd = await mk({ name: { given: 'Zora', family: 'Ausland' }, phones: [{ value: '+1 212 555 0100', type: 'other' }] });
  const page = await call(host, 'contacts_phones', ANNA, { userId: ANNA.id }, MS);
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.deepEqual(page.items.map((x) => x.name), ['Zora Ausland', 'Paul Hoffmann', 'Sabine Wolf'], 'only with a number, sorted like „Kontakte“');
  assert.equal(page.next, null);
  assert.deepEqual(page.items[1], { id: paul.id, name: 'Paul Hoffmann', phones: [{ key: 'mobile', kind: 'mobile', value: '0160 98765432', e164: '+4916098765432', landline: false }] });
  assert.deepEqual(page.items[2].phones.map((p) => [p.key, p.e164, p.landline]), [
    ['mobile', '+4915123456780', false], ['mobile-2', '+491711111111', false], ['work', '+491702345678', false], ['home', '+493012345678', true],
  ], 'mobile first, then work, home; the landline last; no fax');
  assert.deepEqual(page.items[0].phones.map((p) => [p.kind, p.e164, p.landline]), [['other', '+12125550100', null]]);
  // search by name and by number; pages; just the tapped one
  assert.deepEqual((await call(host, 'contacts_phones', ANNA, { userId: ANNA.id, q: 'wol' }, MS)).items.map((x) => x.id), [sabine.id]);
  assert.deepEqual((await call(host, 'contacts_phones', ANNA, { userId: ANNA.id, q: '98765' }, MS)).items.map((x) => x.id), [paul.id]);
  const p1 = await call(host, 'contacts_phones', ANNA, { userId: ANNA.id, limit: 2 }, MS);
  assert.deepEqual(p1.items.map((x) => x.id), [odd.id, paul.id]);
  const p2 = await call(host, 'contacts_phones', ANNA, { userId: ANNA.id, limit: 2, cursor: p1.next }, MS);
  assert.deepEqual([p2.items.map((x) => x.id), p2.next], [[sabine.id], null]);
  assert.deepEqual((await call(host, 'contacts_phones', ANNA, { userId: ANNA.id, ids: [sabine.id, 99999] }, MS)).items.map((x) => x.id), [sabine.id]);
  // only the person's own contacts
  await c.as(MARC)('GET', 'me');
  assert.deepEqual((await call(host, 'contacts_phones', MARC, { userId: MARC.id, ids: [sabine.id] }, MS)).items, []);
  assert.deepEqual(await call(host, 'contacts_phones', MARC, { userId: ANNA.id }, MS), { ok: false, code: 'forbidden' });
  assert.deepEqual(await call(host, 'contacts_phones', ANNA, { userId: ANNA.id }), { ok: false, code: 'forbidden' }, 'only the Messenger');
  for (const bad of [{ limit: 0 }, { limit: 101 }, { ids: [] }, { ids: ['x'] }, { cursor: '!!' }, { q: 'x'.repeat(101) }, { q: 5 }]) {
    assert.deepEqual(await call(host, 'contacts_phones', ANNA, { userId: ANNA.id, ...bad }, MS), { ok: false, code: 'invalid' }, JSON.stringify(bad));
  }
  // without a place, with contacts switched off
  assert.deepEqual(await call(host, 'contacts_phones', BOB, { userId: BOB.id }, MS), { ok: false, code: 'unavailable', reason: 'no_seat' });
  await c.admin('PUT', 'admin/settings', { contacts: { enabled: false } });
  assert.deepEqual(await call(host, 'contacts_phones', ANNA, { userId: ANNA.id }, MS), { ok: false, code: 'unavailable', reason: 'feature_off' });
}));

test('1.16.0 contacts_phones: a page stays within the 16 KB of an answer', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  const anna = c.as(ANNA);
  for (let i = 0; i < 60; i++) {
    const r = await anna('POST', 'cards', { name: { given: `Person${String(i).padStart(2, '0')}`, family: 'Mit Einem Sehr Langen Familiennamen Für Die Größe' }, phones: Array.from({ length: 6 }, (_, k) => ({ value: `+49 151 ${1000000 + i * 10 + k}`, type: 'mobile' })) });
    assert.equal(r.status, 200);
  }
  const seen = [];
  let cursor;
  for (let n = 0; n < 10; n++) {
    const p = await call(host, 'contacts_phones', ANNA, { userId: ANNA.id, limit: 100, ...(cursor ? { cursor } : {}) }, 'gatecontrol-messenger');
    assert.ok(JSON.stringify(p).length < 16 * 1024);
    seen.push(...p.items.map((x) => x.id));
    if (!p.next) break;
    cursor = p.next;
  }
  assert.equal(new Set(seen).size, 60, 'every contact once over the pages');
}));
