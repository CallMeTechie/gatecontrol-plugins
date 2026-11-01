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
