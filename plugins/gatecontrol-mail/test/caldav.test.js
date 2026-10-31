'use strict';

// CalDAV / CardDAV of password accounts (GMX here) through gc.mail.dav (GateControl 1.219.0, pim-helpers FakeDav):
// discovery, sync-token and the getctag fallback, changes of other clients, writing with If-Match and the field merge
// after a 412, the mass delete guard, the account's settings (own addresses, an own password, the iCal subscription),
// invitations by mail (REQUEST / CANCEL / REPLY / COUNTER, SEQUENCE) and the answers by iMIP.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, ANNA, MARC, DAY } = require('./helpers');
const { FakeDav, vevent, vcf, utc } = require('./pim-helpers');
const tz = require('../server/tz');
const pim = require('../server/pim');

const BERLIN = 'Europe/Berlin';
const at = (date, hh, mm = 0) => tz.toUtc({ ...tz.parseDate(date), hh, mm }, BERLIN);

/** Background runs until the account's calendars and address books are through. */
async function syncAll(c, host, n = 8) {
  for (let i = 0; i < n; i++) {
    for (const x of [...Array(50).keys()].map((k) => pim.lineOf(k))) { x.retryAt = 0; x.pause = 0; for (const k of Object.keys(x.last)) if (k !== 'calList' && k !== 'bookList') x.last[k] = 0; }
    await host.tick();
    await settle(20);
  }
}

test('CalDAV: discovery, the calendars of the account, objects of another client, sync-token, deleted ones; writing with If-Match', async () => {
  const dav = new FakeDav({ user: 'anna@gmx.de', pass: 'geheim-123' });
  const cal = dav.calendar('home', { name: 'Kalender', color: '#FF8800' });
  dav.book('kontakte', { name: 'Adressbuch' });
  const t0 = at('2026-11-10', 9);
  const first = dav.put(cal, 'a.ics', vevent('a', [`DTSTART:${utc(t0)}`, `DTEND:${utc(t0 + 3600000)}`, 'SUMMARY:Arzt', 'X-OTHER-APP:bleibt']));
  dav.put(cal, 'b.ics', vevent('b', ['DTSTART;TZID=W. Europe Standard Time:20261111T080000', 'DTEND;TZID=W. Europe Standard Time:20261111T090000', 'SUMMARY:Outlook-Zone']));
  await withMail({ gatecontrol: '1.219.0', dav }, async (host, c) => {
    const acc = await c.addGmx(ANNA);
    const anna = c.as(ANNA);
    await anna('GET', 'calendars');
    await syncAll(c, host);
    const list = (await anna('GET', 'calendars')).json.calendars;
    const gmx = list.find((x) => x.source === 'caldav');
    assert.ok(gmx, JSON.stringify(list));
    assert.deepEqual([gmx.name, gmx.color, gmx.accountId, gmx.writable, gmx.state, gmx.kind], ['Kalender', '#FF8800', acc.id, true, 'ok', 'private']);
    const me = (await anna('GET', 'me')).json.accounts[0];
    assert.deepEqual(me.calendar, { sync: true, state: 'ok', readOnly: false, server: 'caldav.gmx.net' });
    assert.ok(dav.requests.every((r) => !/authorization/i.test(JSON.stringify(r.headers))), 'credentials only as auth');
    let items = (await anna('GET', 'events', null, { from: at('2026-11-09', 0), to: at('2026-11-13', 0), calendars: String(gmx.id) })).json.items;
    assert.deepEqual(items.map((x) => [x.title, x.start]), [['Arzt', t0], ['Outlook-Zone', at('2026-11-11', 8)]]);
    // another client changes one and deletes the other: the sync-token brings it
    dav.put(cal, 'a.ics', vevent('a', [`DTSTART:${utc(t0)}`, `DTEND:${utc(t0 + 3600000)}`, 'SUMMARY:Arzt (verschoben)', 'X-OTHER-APP:bleibt']));
    dav.remove(cal, `${cal}b.ics`);
    const before = dav.requests.length;
    await syncAll(c, host, 2);
    assert.ok(dav.requests.slice(before).some((r) => /sync-collection/.test(r.body || '')), 'sync-collection');
    items = (await anna('GET', 'events', null, { from: at('2026-11-09', 0), to: at('2026-11-13', 0), calendars: String(gmx.id) })).json.items;
    assert.deepEqual(items.map((x) => x.title), ['Arzt (verschoben)']);
    // unchanged: only PROPFIND Depth 0
    const quiet = dav.requests.length;
    await syncAll(c, host, 1);
    assert.ok(dav.requests.slice(quiet).every((r) => r.method === 'PROPFIND' || r.method === 'OPTIONS'));
    // writing: a new event (If-None-Match: *), a change (If-Match) — unknown properties stay
    const ev = await anna('POST', 'events', { calendarId: gmx.id, title: 'Neu', allDay: false, start: t0 + DAY, end: t0 + DAY + 3600000, timeZone: BERLIN });
    assert.equal(ev.status, 200, JSON.stringify(ev.json));
    const put = dav.requests.filter((r) => r.method === 'PUT').pop();
    assert.equal(put.headers['if-none-match'], '*');
    assert.match(put.body, /BEGIN:VTIMEZONE[\s\S]*TZID:Europe\/Berlin/);
    const arzt = items[0];
    const p = await anna('PATCH', `events/${arzt.eventId}`, { location: 'Praxis' });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    const put2 = dav.requests.filter((r) => r.method === 'PUT').pop();
    assert.equal(put2.headers['if-match'], dav.cols.get(cal).log.length ? put2.headers['if-match'] : null);
    assert.match(dav.cols.get(cal).objects.get(`${cal}a.ics`).data, /X-OTHER-APP:bleibt/);
    assert.match(dav.cols.get(cal).objects.get(`${cal}a.ics`).data, /LOCATION:Praxis/);
    void first;
    // deleted here → deleted there
    assert.equal((await anna('DELETE', `events/${ev.json.event.eventId}`)).status, 200);
    assert.equal(dav.cols.get(cal).objects.size, 1);
  });
});

test('CalDAV: a 412 is merged field by field (other fields: sent again; the same field: conflict), the getctag fallback, the mass delete guard', async () => {
  const dav = new FakeDav({ user: 'anna@gmx.de', pass: 'geheim-123', syncTokens: false });
  const cal = dav.calendar('home', { name: 'Kalender' });
  const t0 = at('2026-11-10', 9);
  dav.put(cal, 'a.ics', vevent('a', [`DTSTART:${utc(t0)}`, `DTEND:${utc(t0 + 3600000)}`, 'SUMMARY:Arzt', 'SEQUENCE:0']));
  await withMail({ gatecontrol: '1.219.0', dav }, async (host, c) => {
    await c.addGmx(ANNA);
    const anna = c.as(ANNA);
    await anna('GET', 'calendars');
    await syncAll(c, host);
    const gmx = (await anna('GET', 'calendars')).json.calendars.find((x) => x.source === 'caldav');
    const id = (await anna('GET', 'events', null, { from: at('2026-11-09', 0), to: at('2026-11-13', 0), calendars: String(gmx.id) })).json.items[0].eventId;
    // another client sets the place meanwhile; we change the title → both stay
    dav.put(cal, 'a.ics', vevent('a', [`DTSTART:${utc(t0)}`, `DTEND:${utc(t0 + 3600000)}`, 'SUMMARY:Arzt', 'LOCATION:Praxis Süd', 'SEQUENCE:0']));
    const r = await anna('PATCH', `events/${id}`, { title: 'Zahnarzt' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.event.title, r.json.event.location], ['Zahnarzt', 'Praxis Süd']);
    const data = dav.cols.get(cal).objects.get(`${cal}a.ics`).data;
    assert.match(data, /SUMMARY:Zahnarzt/);
    assert.match(data, /LOCATION:Praxis Süd/);
    // both change the title: the provider wins, 409 conflict with its state
    dav.put(cal, 'a.ics', data.replace('SUMMARY:Zahnarzt', 'SUMMARY:Kieferorthopäde'));
    const k = await anna('PATCH', `events/${id}`, { title: 'Hausarzt' });
    assert.deepEqual([k.status, k.json.error.code, k.json.error.current.title], [409, 'conflict', 'Kieferorthopäde']);
    // without sync-token: the ETags by calendar-query
    for (let i = 0; i < 250; i++) dav.put(cal, `m${i}.ics`, vevent(`m${i}`, [`DTSTART:${utc(t0 + i * 3600000)}`, `DTEND:${utc(t0 + i * 3600000 + 600000)}`, `SUMMARY:M${i}`]));
    const q = dav.requests.length;
    await syncAll(c, host, 2);
    assert.ok(dav.requests.slice(q).some((x) => /calendar-query/.test(x.body || '') && /time-range/.test(x.body || '')));
    assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM events WHERE calendar_id = ?', [gmx.id])).rows[0].n, 251);
    // more than 50 % and more than 200 gone at once: held back (unreachable / mass_delete) until a second sync confirms it
    for (let i = 0; i < 240; i++) dav.remove(cal, `${cal}m${i}.ics`);
    await syncAll(c, host, 1);
    let cal2 = (await anna('GET', 'calendars')).json.calendars.find((x) => x.id === gmx.id);
    assert.deepEqual([cal2.state, cal2.error && cal2.error.code], ['unreachable', 'mass_delete']);
    assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM events WHERE calendar_id = ?', [gmx.id])).rows[0].n, 251);
    await syncAll(c, host, 1);
    cal2 = (await anna('GET', 'calendars')).json.calendars.find((x) => x.id === gmx.id);
    assert.equal(cal2.state, 'ok');
    assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM events WHERE calendar_id = ?', [gmx.id])).rows[0].n, 11);
  });
});

test('account settings: an own CalDAV address and password are tried first (auth_failed, dav_unavailable), sync off, the iCal subscription of Gmail', async () => {
  const dav = new FakeDav({ origins: ['https://dav.firma.example'], user: 'anna@firma.example', pass: 'app-pass' });
  const cal = dav.calendar('arbeit', { name: 'Arbeit' });
  dav.put(cal, 'x.ics', vevent('x', ['DTSTART:20261110T080000Z', 'DTEND:20261110T090000Z', 'SUMMARY:Meeting']));
  const feed = vevent('g1', ['DTSTART;VALUE=DATE:20261112', 'DTEND;VALUE=DATE:20261113', 'SUMMARY:Feiertag'], { more: [] }).replace('PRODID:-//Test//Test//EN', 'PRODID:-//Google Inc//Google Calendar//EN\r\nX-WR-CALNAME:Gmail-Kalender');
  const handler = dav.handler();
  const both = async (req) => {
    if (req.url.startsWith('https://calendar.google.com/')) {
      if (req.auth) return { status: 400 };
      return req.headers['if-none-match'] === '"g1"' ? { status: 304 } : { status: 200, headers: { etag: '"g1"', 'content-type': 'text/calendar' }, body: feed };
    }
    return handler(req);
  };
  await withMail({ gatecontrol: '1.219.0', dav: { handler: () => both } }, async (host, c) => {
    c.mail.login('anna@firma.example', 'mail-pass');
    const acc = (await c.as(ANNA)('POST', 'accounts', { provider: 'imap', email: 'anna@firma.example', password: 'mail-pass', imap: { host: 'imap.firma.example', port: 993, security: 'tls' }, smtp: { host: 'smtp.firma.example', port: 587, security: 'starttls' } })).json.account;
    const anna = c.as(ANNA);
    // the mail password does not open the calendar
    let r = await anna('PATCH', `accounts/${acc.id}`, { caldavUrl: 'https://dav.firma.example/' });
    assert.deepEqual([r.status, r.json.error.code], [409, 'auth_failed']);
    r = await anna('PATCH', `accounts/${acc.id}`, { caldavUrl: 'https://nichts.firma.example/', davPassword: 'app-pass' });
    assert.deepEqual([r.status, r.json.error.code], [409, 'dav_unavailable']);
    assert.equal((await anna('PATCH', `accounts/${acc.id}`, { caldavUrl: 'http://dav.firma.example/' })).json.error.field, 'caldavUrl');
    r = await anna('PATCH', `accounts/${acc.id}`, { caldavUrl: 'https://dav.firma.example/', davPassword: 'app-pass' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(!JSON.stringify(r.json).includes('app-pass'));
    const rows = (await host.gc.db.query('SELECT caldav_url FROM accounts WHERE id = ?', [acc.id])).rows;
    assert.equal(rows[0].caldav_url, 'https://dav.firma.example/');
    assert.ok(!JSON.stringify(await host.gc.db.query('SELECT * FROM accounts')).includes('app-pass'), 'the password is a secret');
    await anna('GET', 'calendars');
    await syncAll(c, host);
    const fc = (await anna('GET', 'calendars')).json.calendars.find((x) => x.source === 'caldav');
    assert.equal(fc.name, 'Arbeit');
    // the mail still logs in with its own password
    assert.equal((await anna('GET', 'me')).json.accounts[0].state !== 'auth_failed', true);
    // sync off: the account's calendars go (the provider keeps them)
    r = await anna('PATCH', `accounts/${acc.id}`, { calendarSync: false });
    assert.equal(r.json.account.calendar.state, 'off');
    assert.ok(!(await anna('GET', 'calendars')).json.calendars.some((x) => x.source === 'caldav'));
    assert.equal(dav.cols.get(cal).objects.size, 1);
    // Gmail: the secret iCal address
    c.mail.login('anna@gmail.com', 'app-pw');
    const g = (await anna('POST', 'accounts', { provider: 'gmail', email: 'anna@gmail.com', password: 'app-pw' })).json.account;
    assert.equal(g.calendar.state, 'none');
    assert.equal((await anna('PATCH', `accounts/${acc.id}`, { icsUrl: 'webcal://calendar.google.com/x.ics' })).status, 200, 'IMAP accounts may');
    r = await anna('PATCH', `accounts/${g.id}`, { icsUrl: 'webcal://calendar.google.com/calendar/ical/geheim/basic.ics' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.account.calendar, { sync: true, state: 'ok', readOnly: true, server: null });
    const sub = (await anna('GET', 'calendars')).json.calendars.find((x) => x.source === 'ics' && x.accountId === g.id);
    assert.deepEqual([sub.name, sub.writable], ['Gmail-Kalender', false]);
    assert.ok(!JSON.stringify(await anna('GET', 'calendars')).includes('geheim'), 'the secret address never goes out');
    const evs = (await anna('GET', 'events', null, { from: at('2026-11-10', 0), to: at('2026-11-15', 0), calendars: String(sub.id) })).json.items;
    assert.deepEqual(evs.map((x) => [x.title, x.allDay, x.startDate]), [['Feiertag', true, '2026-11-12']]);
    assert.equal((await anna('POST', 'events', { calendarId: sub.id, title: 'x', allDay: true, startDate: '2026-11-12' })).json.error.code, 'read_only');
    assert.equal((await anna('PATCH', `events/${evs[0].eventId}`, { title: 'x' })).json.error.code, 'read_only');
    // a subscription of any address; webcal → https; an unreadable one → invalid_ics
    const s2 = await anna('POST', 'calendars/subscribe', { url: 'webcal://calendar.google.com/zwei.ics', name: 'Feiertage' });
    assert.equal(s2.json.calendar.name, 'Feiertage');
    assert.equal((await anna('POST', 'calendars/subscribe', { url: 'ftp://x' })).json.error.code, 'invalid');
    assert.equal((await anna('DELETE', `calendars/${s2.json.calendar.id}`)).status, 200);
  });
});

test('invitations by mail: REQUEST (card, needs_action event), an answer by iMIP, a newer SEQUENCE outdates, CANCEL; REPLY and COUNTER to the organizer', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  const acc = await c.addGmx(ANNA);
  await settle(300);
  const anna = c.as(ANNA);
  await anna('GET', 'calendars');
  const t0 = at('2026-11-18', 13);
  const req = (seq, title, method = 'REQUEST') => vevent('inv-1@outlook', [`DTSTART:${utc(t0)}`, `DTEND:${utc(t0 + 3600000)}`, `SUMMARY:${title}`, `SEQUENCE:${seq}`, 'LOCATION:Raum 4',
    'ORGANIZER;CN=Chef:mailto:chef@firma.example', 'ATTENDEE;CN=Anna;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:anna@gmx.de', 'ATTENDEE;CN=Bob;PARTSTAT=ACCEPTED:mailto:bob@firma.example'], { method });
  c.mail.deliver('anna@gmx.de', { from: { name: 'Chef', address: 'chef@firma.example' }, subject: 'Einladung: Quartal', text: 'Bitte kommen', calendar: [{ partId: '2', method: 'REQUEST', text: req(0, 'Quartal') }] });
  await settle(1500);
  await c.tick();
  const list = (await c.list(ANNA)).items;
  const m = list.find((x) => x.subject === 'Einladung: Quartal');
  assert.equal(m.invite, 'request');
  const msg = (await anna('GET', `messages/${m.id}`)).json;
  assert.ok(msg.invite, 'the card');
  assert.deepEqual([msg.invite.method, msg.invite.state, msg.invite.title, msg.invite.location, msg.invite.myResponse, msg.invite.organizer.email], ['request', 'open', 'Quartal', 'Raum 4', 'needs_action', 'chef@firma.example']);
  assert.deepEqual(msg.invite.counts, { accepted: 1, tentative: 0, declined: 0, needs_action: 1 });
  const priv = (await anna('GET', 'calendars')).json.calendars.find((x) => x.kind === 'private');
  assert.equal(msg.invite.calendarId, priv.id, 'no account calendar here: the own private one');
  const evs = (await anna('GET', 'events', null, { from: t0 - DAY, to: t0 + DAY })).json.items;
  assert.deepEqual(evs.map((x) => [x.title, x.myResponse]), [['Quartal', 'needs_action']]);
  // accept with a comment: REPLY by iMIP through the account, to the organizer
  const sent0 = c.mail.sent.length;
  const r = await anna('POST', `invitations/${msg.invite.id}/respond`, { response: 'accepted', comment: 'Bin dabei' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const reply = c.mail.sent[sent0];
  assert.deepEqual([reply.message.subject, reply.message.to.map((x) => x.address), reply.message.icalEvent.method, reply.message.text], ['Zugesagt: Quartal', ['chef@firma.example'], 'REPLY', 'Bin dabei']);
  assert.match(reply.message.icalEvent.content, /ATTENDEE[^\n]*PARTSTAT=ACCEPTED[^\n]*\r?\n?[^\n]*anna@gmx\.de/);
  assert.equal(r.json.event.myResponse, 'accepted');
  // a newer SEQUENCE: the old card is outdated, the event follows
  c.mail.deliver('anna@gmx.de', { from: { name: 'Chef', address: 'chef@firma.example' }, subject: 'Aktualisiert: Quartal', text: '', calendar: [{ method: 'REQUEST', text: req(1, 'Quartal (neu)') }] });
  await settle(1500);
  await c.tick();
  const old = (await anna('GET', `invitations/${msg.invite.id}`)).json;
  assert.equal(old.state, 'outdated');
  assert.equal((await anna('POST', `invitations/${msg.invite.id}/respond`, { response: 'declined' })).json.error.code, 'invitation_outdated');
  // an older one arriving late stays outdated
  c.mail.deliver('anna@gmx.de', { from: { name: 'Chef', address: 'chef@firma.example' }, subject: 'Alt', text: '', calendar: [{ method: 'REQUEST', text: req(0, 'Quartal (alt)') }] });
  await settle(1500);
  await c.tick();
  const open = (await anna('GET', 'invitations')).json.items;
  assert.deepEqual(open.map((x) => x.title), ['Quartal (neu)']);
  // CANCEL: the event is cancelled, „Aus Kalender entfernen“
  c.mail.deliver('anna@gmx.de', { from: { name: 'Chef', address: 'chef@firma.example' }, subject: 'Abgesagt: Quartal', text: '', calendar: [{ method: 'CANCEL', text: req(2, 'Quartal (neu)', 'CANCEL').replace('SUMMARY', 'STATUS:CANCELLED\r\nSUMMARY') }] });
  await settle(1500);
  await c.tick();
  const ev2 = (await anna('GET', 'events', null, { from: t0 - DAY, to: t0 + DAY })).json.items;
  assert.deepEqual(ev2.map((x) => x.status), ['cancelled']);
  const cancel = (await anna('GET', 'invitations')).json.items.find((x) => x.method === 'cancel');
  assert.equal((await anna('POST', `invitations/${cancel.id}/apply`)).status, 200);
  assert.deepEqual((await anna('GET', 'events', null, { from: t0 - DAY, to: t0 + DAY })).json.items, []);
  // not for the person (a forwarded invitation): no card
  c.mail.deliver('anna@gmx.de', { subject: 'Weitergeleitet', text: '', calendar: [{ method: 'REQUEST', text: req(0, 'Fremd').replace(/anna@gmx\.de/g, 'jemand@example.com') }] });
  await settle(1500);
  await c.tick();
  assert.equal((await c.list(ANNA)).items.find((x) => x.subject === 'Weitergeleitet').invite, null);
  void acc;
}));

test('own event with an external attendee: REQUEST, the REPLY arrives and applies itself, a COUNTER is taken over (new REQUEST) or declined', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  await c.addGmx(ANNA);
  await settle(300);
  const anna = c.as(ANNA);
  const cals = (await anna('GET', 'calendars')).json.calendars;
  const t0 = at('2026-11-20', 10);
  const r = await anna('POST', 'events', { calendarId: cals[1].id, title: 'Angebot', allDay: false, start: t0, end: t0 + 3600000, timeZone: BERLIN, attendees: [{ email: 'kunde@example.com', name: 'Kunde' }] });
  assert.deepEqual(r.json.sent, { mail: 1, internal: 0 });
  const id = r.json.event.eventId;
  const uid = (await host.gc.db.query('SELECT uid FROM events WHERE id = ?', [id])).rows[0].uid;
  const answer = (method, partstat, lines = []) => vevent(uid, [`DTSTART:${utc(t0)}`, `DTEND:${utc(t0 + 3600000)}`, 'SUMMARY:Angebot', 'SEQUENCE:0', 'ORGANIZER:mailto:anna@gmx.de',
    `ATTENDEE;CN=Kunde;PARTSTAT=${partstat}:mailto:kunde@example.com`, ...lines], { method });
  c.mail.deliver('anna@gmx.de', { from: { name: 'Kunde', address: 'kunde@example.com' }, subject: 'Zugesagt: Angebot', text: '', calendar: [{ method: 'REPLY', text: answer('REPLY', 'ACCEPTED') }] });
  await settle(1500);
  await c.tick();
  const ev = (await anna('GET', `events/${id}`)).json;
  assert.deepEqual(ev.attendees.map((a) => [a.email, a.response]), [['kunde@example.com', 'accepted']]);
  const card = (await anna('GET', 'invitations', null, { state: 'applied' })).json.items[0];
  assert.deepEqual([card.method, card.from.name], ['reply', 'Kunde']);
  // a counter: another time proposed
  const t1 = t0 + 2 * 3600000;
  const counter = answer('COUNTER', 'TENTATIVE').replace(`DTSTART:${utc(t0)}`, `DTSTART:${utc(t1)}`).replace(`DTEND:${utc(t0 + 3600000)}`, `DTEND:${utc(t1 + 3600000)}`);
  c.mail.deliver('anna@gmx.de', { from: { name: 'Kunde', address: 'kunde@example.com' }, subject: 'Neuer Zeitvorschlag', text: '', calendar: [{ method: 'COUNTER', text: counter }] });
  await settle(1500);
  await c.tick();
  const co = (await anna('GET', 'invitations')).json.items.find((x) => x.method === 'counter');
  assert.deepEqual(co.proposed, { start: t1, end: t1 + 3600000 });
  const n0 = c.mail.sent.length;
  const ap = await anna('POST', `invitations/${co.id}/apply`);
  assert.equal(ap.status, 200, JSON.stringify(ap.json));
  assert.equal(ap.json.event.start, t1);
  const upd = c.mail.sent[n0];
  assert.deepEqual([upd.message.icalEvent.method, upd.message.subject], ['REQUEST', 'Aktualisiert: Angebot']);
  assert.match(upd.message.icalEvent.content, /SEQUENCE:1/);
  // another counter declined: DECLINECOUNTER
  c.mail.deliver('anna@gmx.de', { from: { name: 'Kunde', address: 'kunde@example.com' }, subject: 'Noch ein Vorschlag', text: '', calendar: [{ method: 'COUNTER', text: counter.replace('SEQUENCE:0', 'SEQUENCE:1') }] });
  await settle(1500);
  await c.tick();
  const co2 = (await anna('GET', 'invitations')).json.items.find((x) => x.method === 'counter');
  assert.equal((await anna('POST', `invitations/${co2.id}/dismiss`, { decline: true })).status, 200);
  assert.equal(c.mail.sent[c.mail.sent.length - 1].message.icalEvent.method, 'DECLINECOUNTER');
  // the sending fails: nothing is stored (send_failed)
  c.mail.logins.get('anna@gmx.de').pass = 'anders';
  const f = await anna('PATCH', `events/${id}`, { title: 'Angebot 2' });
  assert.deepEqual([f.status, f.json.error.code], [409, 'send_failed']);
  assert.equal((await anna('GET', `events/${id}`)).json.title, 'Angebot');
}));

test('CardDAV: the address book of the account, contacts of another client, a change with If-Match (unknown properties stay), photos', async () => {
  const dav = new FakeDav({ user: 'anna@gmx.de', pass: 'geheim-123' });
  const book = dav.book('kontakte', { name: 'Adressbuch' });
  dav.put(book, 'p1.vcf', vcf('p1', ['FN:Peter Pan', 'N:Pan;Peter;;;', 'EMAIL;TYPE=INTERNET:peter@example.com', 'TEL;TYPE=CELL:+49 170 111', 'X-ABLABEL:bleibt',
    'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQ']));
  await withMail({ gatecontrol: '1.219.0', dav }, async (host, c) => {
    await c.addGmx(ANNA);
    const anna = c.as(ANNA);
    await anna('GET', 'addressbooks');
    await syncAll(c, host);
    const books = (await anna('GET', 'addressbooks')).json.items;
    const remote = books.find((b) => b.source === 'carddav');
    assert.deepEqual([remote.name, remote.count, remote.state, remote.writable], ['Adressbuch', 1, 'ok', true]);
    const list = (await anna('GET', 'cards', null, { book: String(remote.id) })).json.items;
    assert.deepEqual(list.map((x) => [x.name, x.letter, x.emails, x.photo]), [['Peter Pan', 'P', ['peter@example.com'], true]]);
    const card = (await anna('GET', `cards/${list[0].id}`)).json;
    assert.equal((await anna('GET', `cards/${card.id}/photo`)).json.data, '/9j/4AAQ');
    const p = await anna('PATCH', `cards/${card.id}`, { company: 'Nimmerland GmbH', etag: card.etag });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    const put = dav.requests.filter((r) => r.method === 'PUT').pop();
    assert.ok(put.headers['if-match']);
    assert.match(put.body, /X-ABLABEL:bleibt/);
    assert.match(put.body, /PHOTO;ENCODING=b;TYPE=JPEG:\/9j\/4AAQ/, 'the photo goes back');
    assert.match(put.body, /ORG:Nimmerland GmbH/);
    // a new contact in this address book
    const n = await anna('POST', 'cards', { addressbookId: remote.id, name: { given: 'Wendy', family: 'Darling' }, emails: [{ value: 'wendy@example.com' }] });
    assert.equal(n.status, 200, JSON.stringify(n.json));
    assert.equal(dav.cols.get(book).objects.size, 2);
    // deleted elsewhere → gone here
    dav.remove(book, `${book}p1.vcf`);
    await syncAll(c, host, 2);
    assert.deepEqual((await anna('GET', 'cards', null, { book: String(remote.id) })).json.items.map((x) => x.name), ['Wendy Darling']);
  });
});

test('GateControl 1.216.0 without gc.mail.dav: GMX calendars are „none“, nothing breaks; the account removed takes its calendars along', () => withMail({}, async (host, c) => {
  const acc = await c.addGmx(MARC);
  const marc = c.as(MARC);
  await marc('GET', 'calendars');
  await host.tick();
  const me = (await marc('GET', 'me')).json;
  assert.ok(!me.features.includes('dav'));
  assert.equal(me.accounts[0].calendar.state, 'none');
  assert.equal((await marc('PATCH', `accounts/${acc.id}`, { caldavUrl: 'https://dav.example.com/' })).json.error.reason, 'host_old');
  assert.equal((await marc('DELETE', `accounts/${acc.id}`)).status, 200);
  assert.deepEqual((await marc('GET', 'calendars')).json.calendars.map((x) => x.source), ['local', 'local']);
}));
