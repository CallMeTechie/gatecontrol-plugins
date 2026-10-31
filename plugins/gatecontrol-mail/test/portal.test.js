'use strict';

// The portal tab of Mail 1.3.0 in a small DOM (fake-dom.js) against the plugin: the menu's new foot (settings on the
// left, Kontakte and Kalender on the right, no „+“), the calendar (week, month, list, an event looked at and changed —
// only what changed is sent —, a new one, a calendar hidden), the contacts (letters, a contact, editing with the etag,
// a group with members, duplicates merged, vCard import and export), the invitation card of a mail (Zusagen with a
// comment), the band „Kalender und Kontakte freigeben“ with „Neu anmelden“ by device code; the admin pages (Kalender,
// Kontakte, the numbers, what the Microsoft registration needs). And the server side of signing in anew at the limit.

process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, app, ANNA, ADMIN } = require('./helpers');
const { vevent, vcf, utc } = require('./pim-helpers');
const ui = require('../server/ui');
const { t } = require('../server/text');
const { createWindow } = require('./fake-dom');
const L = require('../ui/pimlogic');

const tick = () => new Promise((r) => setTimeout(r, 3));
async function until(what, fn, n = 2500) {
  for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await tick(); }
  throw new Error('timed out waiting for ' + what);
}
const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));
const CLIENT = { microsoft: { registration: 'custom', customClientId: '11111111-2222-3333-4444-555555555555' } };

/** The portal for `user` in the small DOM; every call of the page in `calls`; `edit(path, r)` may change an answer. */
function portal(host, user, o = {}) {
  const calls = [];
  const saved = [];
  const gc = {
    async call(method, p, body) {
      const [path, qs] = String(p).split('?');
      const query = Object.fromEntries(new URLSearchParams(qs || ''));
      calls.push({ method, path, query, body: body === undefined ? null : JSON.parse(JSON.stringify(body)) });
      const r = await host.request({ method, path, body: body === undefined ? null : body, query, user: app(user), lang: 'de' });
      if (r.status !== 200) throw Object.assign(new Error('http ' + r.status), { status: r.status, data: r.json });
      return o.edit ? o.edit(method, path, r.json) : r.json;
    },
    on() {},
    upload: async () => ({ mediaId: 'x' }),
    saveFile: async (blob, name) => { saved.push({ name, text: Buffer.from(await blob.arrayBuffer()).toString('utf8') }); },
  };
  const f = createWindow(ui.render({ view: 'portal', lang: 'de', user: { id: user.id, loggedIn: true }, allowed: true }, t), gc);
  f.window.confirm = () => true;
  f.window.atob = globalThis.atob;
  f.window.Uint8Array = Uint8Array;
  f.run();
  const doc = f.document;
  const el = (id) => doc.getElementById(id);
  const all = () => doc.body.all();
  const byText = (tag, text, root) => (root || doc.body).all().filter((x) => x.localName === tag && textOf(x).trim() === text).pop();
  const byLabel = (label, root) => (root || doc.body).all().filter((x) => x.getAttribute('aria-label') === label).pop();
  const dialogText = () => textOf(el('mp-dialog'));
  return { f, doc, el, all, calls, saved, byText, byLabel, dialogText, text: (id) => textOf(el(id)), stop: () => f.stop() };
}
const click = (x, what) => { assert.ok(x, 'no ' + (what || 'element')); x.click(); };
const type = (input, value) => { input.value = value; input.dispatchEvent({ type: 'input' }); input.dispatchEvent({ type: 'change' }); };

test('the menu\'s foot: settings on the left, Kontakte and Kalender on the right, no „+“; the calendar: week, an event changed (only the title goes), month, list, a new event, a calendar hidden', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  const anna = c.as(ANNA);
  const cals = (await anna('GET', 'calendars')).json.calendars;
  const today = L.ymd(new Date());
  const ev = (await anna('POST', 'events', { calendarId: cals[0].id, title: 'Planung', allDay: false, start: L.at(today, '10:00'), end: L.at(today, '11:00'), timeZone: 'Europe/Berlin', location: 'Raum 1' })).json.event;
  const p = portal(host, ANNA);
  try {
    await until('the foot', () => p.byLabel('Kalender'));
    const nav = () => p.text('mp-nav');
    assert.ok(p.byLabel('Mail-Einstellungen'), 'the settings on the left');
    assert.ok(p.byLabel('Kontakte'), 'Kontakte');
    assert.ok(!nav().includes('Konto hinzufügen'), 'no „+“ in the menu');
    // Kalender
    click(p.byLabel('Kalender'));
    await until('the event in the week', () => p.text('mp-list').includes('Planung'));
    assert.ok(nav().includes('Posteingänge') && nav().includes('Privat') && nav().includes('Firma') && nav().includes('GateControl'));
    assert.equal(p.byLabel('Kalender').getAttribute('aria-pressed'), 'true');
    assert.match(p.el('mp-app').className, /is-calendar/);
    const range = p.calls.find((x) => x.path === 'events' && x.method === 'GET');
    assert.equal(Number(range.query.to) - Number(range.query.from), 7 * L.DAY, 'a week');
    // the event: the dialog, „Bearbeiten“, only the title changes
    const block = await until('the block', () => p.all().find((x) => x.localName === 'button' && x.className.includes('mc-ev') && x.getAttribute('title') === 'Planung'));
    click(block);
    await until('the dialog', () => p.dialogText().includes('Bearbeiten'));
    assert.ok(p.dialogText().includes('Raum 1'));
    click(p.byText('button', 'Bearbeiten'));
    await until('the form', () => p.byLabel('Titel'));
    type(p.byLabel('Titel'), 'Planung neu');
    click(p.byText('button', 'Speichern'));
    await until('saved', () => p.calls.some((x) => x.method === 'PATCH' && x.path === `events/${ev.eventId}`));
    const patch = p.calls.find((x) => x.method === 'PATCH' && x.path === `events/${ev.eventId}`);
    assert.deepEqual(Object.keys(patch.body).sort(), ['etag', 'scope', 'title']);
    assert.deepEqual([patch.body.title, patch.body.scope, patch.body.etag], ['Planung neu', 'series', ev.etag]);
    await until('the new title', () => p.text('mp-list').includes('Planung neu'));
    // Monat, Liste
    click(p.byText('button', 'Monat'));
    await until('the month', () => p.all().some((x) => x.className === 'mc-month') && p.text('mp-list').includes('Planung neu'));
    click(p.byText('button', 'Liste'));
    await until('the list', () => p.all().some((x) => x.className === 'mc-list') && p.text('mp-list').includes('Planung neu'));
    // „Neuer Termin“
    click(p.byText('button', 'Neuer Termin'));
    await until('the form', () => p.byLabel('Titel'));
    type(p.byLabel('Titel'), 'Sport');
    click(p.byText('button', 'Speichern'));
    await until('created', () => p.calls.some((x) => x.method === 'POST' && x.path === 'events'));
    const post = p.calls.find((x) => x.method === 'POST' && x.path === 'events');
    assert.deepEqual([post.body.title, post.body.calendarId, post.body.allDay, post.body.reminders], ['Sport', cals[0].id, false, [15]]);
    assert.equal(post.body.end - post.body.start, 3600000);
    await until('in the list', () => p.text('mp-list').includes('Sport'));
    // hide „Firma“: PATCH visible false
    const firma = p.all().find((x) => x.localName === 'button' && x.className === 'mp-row' && textOf(x).includes('Firma') && x.getAttribute('aria-pressed') === 'true');
    click(firma, 'Firma');
    await until('hidden', () => p.calls.some((x) => x.method === 'PATCH' && x.path === `calendars/${cals[1].id}`));
    assert.deepEqual(p.calls.find((x) => x.path === `calendars/${cals[1].id}`).body, { visible: false });
    assert.equal((await anna('GET', 'calendars')).json.calendars.find((x) => x.id === cals[1].id).visible, false);
    // back to the mail
    click(p.byText('button', 'Posteingänge'));
    await until('the mail', () => !p.el('mp-app').className.includes('is-calendar') && p.text('mp-nav').includes('Alle Posteingänge'));
  } finally { p.stop(); }
}));

test('„Alle Termine der Serie“ from an occurrence in the week: the series moves from Event.series, earlier occurrences stay', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  const anna = c.as(ANNA);
  const cals = (await anna('GET', 'calendars')).json.calendars;
  const today = L.ymd(new Date());
  const first = L.addDays(today, -14);
  const ev = (await anna('POST', 'events', { calendarId: cals[0].id, title: 'Jour fixe', allDay: false, start: L.at(first, '10:00'), end: L.at(first, '11:00'), timeZone: 'Europe/Berlin',
    recurrence: { freq: 'weekly', count: 5 } })).json.event;
  const p = portal(host, ANNA);
  try {
    click(await until('the foot', () => p.byLabel('Kalender')));
    const block = await until('this week\'s one', () => p.all().find((x) => x.localName === 'button' && x.className.includes('mc-ev') && x.getAttribute('title') === 'Jour fixe'));
    click(block);
    click(await until('„Bearbeiten“', () => p.byText('button', 'Bearbeiten')));
    const st = await until('the start time', () => p.el('mp-dialog').all().find((x) => x.localName === 'input' && x.type === 'time' && x.value === '10:00'));
    st.value = '11:30';
    st.dispatchEvent({ type: 'change' });
    click(p.byText('button', 'Speichern'));
    click(await until('the question', () => p.byText('button', 'Alle Termine der Serie')));
    await until('saved', () => p.calls.some((x) => x.method === 'PATCH'));
    const patch = p.calls.find((x) => x.method === 'PATCH').body;
    assert.deepEqual([patch.scope, patch.start, patch.end - patch.start], ['series', L.at(first, '11:30'), 3600000]);
    await until('the toast', () => p.text('mp-toast').includes('Gespeichert'));
  } finally { p.stop(); }
  const items = (await anna('GET', 'events', null, { from: L.at(first, '00:00'), to: L.at(L.addDays(first, 35), '00:00') })).json.items;
  assert.deepEqual(items.map((x) => [L.ymd(x.start), L.hhmm(x.start)]), [0, 7, 14, 21, 28].map((d) => [L.addDays(first, d), '11:30']), 'all five, the earlier ones too');
}));

test('contacts: letters, a contact, editing with the etag, a group with a member, duplicates merged, vCard export and import', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  const anna = c.as(ANNA);
  await anna('GET', 'addressbooks');
  const bernd = (await anna('POST', 'cards', { name: { given: 'Bernd', family: 'Brandt' }, phones: [{ value: '0221 4711', type: 'work' }], company: 'Werkstatt' })).json.card;
  await anna('POST', 'cards', { name: { given: 'Anna', family: 'Lang' }, emails: [{ value: 'anna.lang@firma.de', type: 'work' }], company: 'Keller GmbH' });
  await anna('POST', 'cards', { name: { given: 'Anna', family: 'Lang' }, emails: [{ value: 'anna.lang@firma.de', type: 'home' }], birthday: '1981-03-14' });
  const p = portal(host, ANNA);
  try {
    await until('the foot', () => p.byLabel('Kontakte'));
    click(p.byLabel('Kontakte'));
    await until('the list', () => p.text('mp-list').includes('Bernd Brandt') && p.text('mp-list').includes('Anna Lang'));
    assert.ok(p.text('mp-nav').includes('Alle Kontakte') && p.text('mp-nav').includes('Meine Kontakte') && p.text('mp-nav').includes('Dubletten'));
    const az = p.all().find((x) => x.className === 'mk-az');
    assert.deepEqual(az.childNodes.map(textOf), ['B', 'L'], 'sorted by the last name');
    await until('the duplicates band', () => p.text('mp-list').includes('1 mögliche Dublette'));
    // Bernd: the view, then editing (the etag goes along)
    click(p.all().find((x) => x.localName === 'button' && x.className.includes('mk-row') && textOf(x).includes('Bernd Brandt')));
    await until('the contact', () => p.text('mp-read').includes('0221 4711') && p.text('mp-read').includes('Werkstatt'));
    click(p.all().filter((x) => x.className === 'mk-act' && textOf(x).includes('Bearbeiten'))[0]);
    await until('the form', () => p.dialogText().includes('Kontakt bearbeiten'));
    const company = p.el('mp-dialog').all().find((x) => x.localName === 'input' && x.value === 'Werkstatt');
    type(company, 'Autowerkstatt Brandt');
    click(p.byText('button', 'Speichern'));
    await until('saved', () => p.text('mp-read').includes('Autowerkstatt Brandt'));
    const patch = p.calls.find((x) => x.method === 'PATCH' && x.path === `cards/${bernd.id}`);
    assert.equal(patch.body.etag, bernd.etag);
    assert.equal(patch.body.company, 'Autowerkstatt Brandt');
    assert.deepEqual(patch.body.phones, [{ value: '0221 4711', type: 'work' }]);
    // a group with a member typed in
    click(p.all().find((x) => x.getAttribute('role') === 'tab' && textOf(x).startsWith('Gruppen')));
    click(await until('„Neue Gruppe“', () => p.byText('button', 'Neue Gruppe')));
    await until('the dialog', () => p.dialogText().includes('Name der Gruppe'));
    type(p.el('mp-dialog').all().find((x) => x.localName === 'input'), 'Familie');
    click(p.byText('button', 'Anlegen'));
    await until('the group', () => p.text('mp-read').includes('Familie') && p.text('mp-read').includes('Noch keine Mitglieder'));
    const add = p.byLabel('Mitglied hinzufügen: Name oder Adresse');
    add.value = 'Tim <tim@familie.de>';
    add.dispatchEvent({ type: 'keydown', key: 'Enter' });
    await until('the member', () => p.text('mp-read').includes('tim@familie.de'));
    // duplicates: merged (same address book)
    click(p.all().find((x) => x.localName === 'button' && x.className === 'mp-row' && textOf(x).includes('Dubletten')));
    await until('the duplicates', () => p.text('mp-read').includes('Gleiche E-Mail-Adresse'));
    click(p.el('mp-read').all().find((x) => x.localName === 'button' && textOf(x) === 'Zusammenführen'));
    await until('the preview', () => p.dialogText().includes('Hauptkontakt'));
    click(p.el('mp-dialog').all().filter((x) => x.localName === 'button' && textOf(x) === 'Zusammenführen').pop());
    await until('merged', () => p.calls.some((x) => x.path === 'cards/merge'));
    const m = p.calls.find((x) => x.path === 'cards/merge').body;
    assert.equal(m.ids.length, 2);
    assert.equal(m.pick.note, 'join');
    await until('one Anna', () => (p.text('mp-list').match(/Anna Lang/g) || []).length === 1);
    // export: GC.saveFile with the vCard
    click(p.byLabel('Weitere Aktionen'));
    click(await until('the menu', () => p.byText('button', 'Als vCard exportieren')));
    click(await until('the dialog', () => p.byText('button', 'Exportieren')));
    await until('saved', () => p.saved.length);
    assert.equal(p.saved[0].name, 'kontakte.vcf');
    assert.match(p.saved[0].text, /BEGIN:VCARD/);
    assert.match(p.saved[0].text, /Autowerkstatt Brandt/);
    // import: a .vcf file
    click(p.byLabel('Weitere Aktionen'));
    click(await until('the menu', () => p.byText('button', 'vCard importieren')));
    const file = await until('the file field', () => p.el('mp-dialog').all().find((x) => x.localName === 'input' && x.type === 'file'));
    const text = vcf('imp-1', ['FN:Clara Cramer', 'N:Cramer;Clara;;;', 'EMAIL:clara@example.com']);
    file.files = [{ name: 'google.vcf', size: text.length, text: async () => text }];
    click(p.byText('button', 'Importieren'));
    await until('imported', () => p.text('mp-toast').includes('1 neu, 0 aktualisiert, 0 übersprungen'));
    await until('in the list', () => p.text('mp-list').includes('Clara Cramer'));
  } finally { p.stop(); }
}));

test('the invitation card of a mail: the label in the list, the day around it, Zusagen with a comment (iMIP REPLY), then „Du hast zugesagt“', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  await c.addGmx(ANNA);
  await settle(300);
  const anna = c.as(ANNA);
  await anna('GET', 'calendars');
  const t0 = L.at(L.addDays(L.ymd(new Date()), 3), '13:00');
  const ics = vevent('inv-portal@outlook', [`DTSTART:${utc(t0)}`, `DTEND:${utc(t0 + 3600000)}`, 'SUMMARY:Sprint-Review', 'SEQUENCE:0', 'LOCATION:Raum 1',
    'ORGANIZER;CN=Sabine Keller:mailto:sabine@firma.example', 'ATTENDEE;CN=Anna;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:anna@gmx.de', 'ATTENDEE;CN=Tim;PARTSTAT=ACCEPTED:mailto:tim@firma.example'], { method: 'REQUEST' });
  c.mail.deliver('anna@gmx.de', { from: { name: 'Sabine Keller', address: 'sabine@firma.example' }, subject: 'Einladung: Sprint-Review', text: 'Bis Mittwoch', calendar: [{ partId: '2', method: 'REQUEST', text: ics }] });
  await settle(1500);
  await c.tick();
  const p = portal(host, ANNA);
  try {
    const item = await until('the mail', () => p.all().find((x) => x.localName === 'button' && x.className.includes('mp-item') && textOf(x).includes('Sprint-Review')));
    assert.ok(item.all().some((x) => x.className === 'mp-tag' && textOf(x) === 'Einladung'), 'the label');
    click(item);
    await until('the card', () => p.text('mp-read').includes('Zusagen'));
    const read = p.text('mp-read');
    assert.ok(read.includes('Raum 1') && read.includes('Sabine Keller') && read.includes('Neue Zeit vorschlagen') && read.includes('Eintragen in:'));
    assert.ok(read.includes('Teilnehmer · 1 von 2 zugesagt'));
    assert.ok(p.el('mp-read').all().some((x) => x.className === 'mc-mini'), 'the small day');
    type(p.el('mp-read').all().find((x) => x.localName === 'input' && x.placeholder === 'Kommentar hinzufügen'), 'Bin dabei');
    const sent0 = c.mail.sent.length;
    click(p.el('mp-read').all().find((x) => x.localName === 'button' && textOf(x) === 'Zusagen'));
    await until('answered', () => p.text('mp-read').includes('Du hast zugesagt'));
    const reply = c.mail.sent[sent0];
    assert.deepEqual([reply.message.subject, reply.message.icalEvent.method, reply.message.text], ['Zugesagt: Sprint-Review', 'REPLY', 'Bin dabei']);
    // „Ändern“ shows the buttons again
    click(p.byText('button', 'Ändern'));
    await until('again', () => p.text('mp-read').includes('Mit Vorbehalt'));
    // the event is in the calendar as accepted
    const evs = (await anna('GET', 'events', null, { from: t0 - 3600000, to: t0 + 7200000 })).json.items;
    assert.deepEqual(evs.map((x) => [x.title, x.myResponse]), [['Sprint-Review', 'accepted']]);
  } finally { p.stop(); }
}));

/** A fake Microsoft: the token endpoint (granting `w.granted`) and the device code; Graph answers nothing. */
function msWorld() {
  const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const w = { granted: PHASE1 };
  w.fetch = async (url, o) => {
    const u = new URL(url);
    if (u.host === 'login.microsoftonline.com') {
      const f = o.form || {};
      if (u.pathname.endsWith('/devicecode')) return json(200, { device_code: 'DEV', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 });
      const id = jwt({ email: 'anna@firma.example', tid: 'tenant-firma', name: 'Anna' });
      if (f.grant_type === 'authorization_code' || f.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') return json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: w.granted, id_token: id });
      return json(200, { access_token: 'AT2', expires_in: 3600, scope: w.granted });
    }
    return json(404, { error: { code: 'ErrorItemNotFound' } });
  };
  return w;
}
const PHASE1 = 'openid profile email offline_access User.Read Mail.ReadWrite Mail.Send';
const signIn = (c) => c.as(ANNA)('POST', 'accounts/microsoft', { code: 'X', codeVerifier: 'v'.repeat(43), redirectUri: 'msauth://com.gatecontrol.client/abc%3D', name: 'Firma' });

test('Microsoft without the calendar right (an account of 1.1): the band „Kalender und Kontakte freigeben“, „Neu anmelden“ asks the device code for that account', () => {
  const w = msWorld();
  return withMail({ gatecontrol: '1.219.0', settings: CLIENT, fetch: w.fetch }, async (host, c) => {
    const acc = (await signIn(c)).json.account;
    assert.deepEqual(acc.missingScopes, ['Calendars.ReadWrite', 'Contacts.ReadWrite']);
    const p = portal(host, ANNA);
    try {
      click(await until('the foot', () => p.byLabel('Kalender')));
      await until('the band', () => p.text('mp-list').includes('Kalender und Kontakte von Firma · anna@firma.example freigeben'));
      click(p.el('mp-list').all().find((x) => x.localName === 'button' && textOf(x) === 'Neu anmelden'));
      await until('the code', () => p.dialogText().includes('ABCD-EFGH'));
      assert.ok(p.dialogText().includes('anna@firma.example neu anmelden'));
      const start = p.calls.find((x) => x.path === 'accounts/microsoft/device');
      assert.deepEqual(start.body, { kind: 'business', accountId: acc.id });
      // the contacts show the band too
      click(p.byLabel('Schließen'));
      click(p.byLabel('Kontakte'));
      await until('the band', () => p.text('mp-list').includes('Kalender und Kontakte von Firma · anna@firma.example freigeben'));
    } finally { p.stop(); }
  });
});

test('signing in anew by device code at the limit of accounts: no limit for an own Microsoft account (accountId), the rights it grants', async () => {
  const w = msWorld();
  await withMail({ gatecontrol: '1.219.0', settings: { ...CLIENT, accountsMax: 1 }, fetch: w.fetch }, async (host, c) => {
    const anna = c.as(ANNA);
    const acc = (await signIn(c)).json.account;
    assert.deepEqual(acc.missingScopes, ['Calendars.ReadWrite', 'Contacts.ReadWrite']);
    assert.equal((await anna('POST', 'accounts/microsoft/device', { kind: 'business' })).json.error.code, 'limit', 'a new account: the limit');
    assert.equal((await anna('POST', 'accounts/microsoft/device', { kind: 'business', accountId: 12345 })).status, 404);
    w.granted = `${PHASE1} https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Contacts.ReadWrite`;
    const dev = (await anna('POST', 'accounts/microsoft/device', { kind: 'business', accountId: acc.id })).json;
    assert.equal(dev.userCode, 'ABCD-EFGH');
    await host.gc.db.run('UPDATE ms_device SET next_at = 0');
    const done = (await anna('GET', `accounts/microsoft/device/${dev.deviceId}`)).json;
    assert.deepEqual([done.status, done.account.id], ['done', acc.id]);
    const me = (await anna('GET', 'me')).json;
    assert.deepEqual(me.accounts.map((a) => [a.id, a.missingScopes]), [[acc.id, []]]);
  });
});

test('admin: the cards Kalender and Kontakte, what the Microsoft registration needs, calendars, events and contacts in numbers', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  const anna = c.as(ANNA);
  const cals = (await anna('GET', 'calendars')).json.calendars;
  await anna('POST', 'events', { calendarId: cals[0].id, title: 'Eins', allDay: true, startDate: '2026-11-04', endDate: '2026-11-04' });
  await anna('POST', 'cards', { name: { given: 'Clara', family: 'Cramer' } });
  const gcAdmin = {
    async call(method, p, body) {
      const r = await host.request({ method, path: p, body: body === undefined ? null : body, query: {}, user: ADMIN, lang: 'de' });
      if (r.status !== 200) throw Object.assign(new Error('http ' + r.status), { status: r.status, data: r.json });
      return r.json;
    },
  };
  const f = createWindow(ui.render({ view: 'page', page: 'settings', lang: 'de' }, t), gcAdmin);
  try {
    f.run();
    const page = () => textOf(f.document.getElementById('ma-page'));
    await until('the cards', () => page().includes('Interne Einladungen'));
    for (const s of ['Kalender in Mail', 'Kalender der Konten abgleichen', 'Firmenkalender', 'Standard-Erinnerung', 'Geburtstage aus den Kontakten', 'Kontakte in Mail',
      'Adressbücher der Konten abgleichen', 'Signatur mit KI lesen', 'Rechte für Kalender und Kontakte', 'Calendars.ReadWrite', 'Contacts.ReadWrite']) assert.ok(page().includes(s), s);
    // the table: calendars, events, contacts per person
    const table = f.document.body.all().find((x) => x.localName === 'table' && textOf(x).includes('Termine'));
    assert.ok(table, 'the columns');
    const row = table.all().filter((x) => x.localName === 'tr').find((x) => textOf(x).includes('Anna'));
    assert.deepEqual(row.all().filter((x) => x.localName === 'td').slice(1, 5).map(textOf), ['0', '2', '1', '1']);
    // switches save at once
    const sws = f.document.body.all().filter((x) => x.localName === 'input' && x.className === 'dp-sw');
    const internal = sws.find((x) => textOf(x.parentNode).includes('Interne Einladungen'));
    internal.checked = false;
    internal.dispatchEvent({ type: 'change' });
    await until('saved', async () => (await c.admin('GET', 'admin/settings')).json.settings.calendar.internalInvites === false);
    const sel = f.document.body.all().filter((x) => x.localName === 'select').find((x) => textOf(x.parentNode).includes('Standard-Erinnerung'));
    sel.value = 'none';
    sel.dispatchEvent({ type: 'change' });
    await until('saved', async () => (await c.admin('GET', 'admin/settings')).json.settings.calendar.defaultReminder === null);
    const off = f.document.body.all().filter((x) => x.localName === 'input' && x.className === 'dp-sw').find((x) => textOf(x.parentNode).includes('Kontakte in Mail'));
    off.checked = false;
    off.dispatchEvent({ type: 'change' });
    await until('contacts off', async () => (await c.admin('GET', 'admin/settings')).json.settings.contacts.enabled === false);
    await until('the card folds', () => !page().includes('Signatur mit KI lesen'));
  } finally { f.stop(); }
  const o = createWindow(ui.render({ view: 'page', page: 'overview', lang: 'de' }, t), gcAdmin);
  try {
    o.run();
    const page = () => textOf(o.document.getElementById('ma-page'));
    await until('the numbers', () => page().includes('Kalender und Kontakte'));
    assert.ok(page().includes('Termine') && page().includes('Kontakte') && page().includes('Speicher für Termine und Kontakte'));
  } finally { o.stop(); }
}));
