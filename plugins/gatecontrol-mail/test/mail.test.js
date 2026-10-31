'use strict';

// Accounts, sync, lists, reading and the changes a person makes — against the mock host as GateControl 1.216.0 with a
// fake IMAP / SMTP world (helpers.js FakeMail).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withMail, settle, ANNA, MARC, BOB, ADMIN, DIR } = require('./helpers');
const PUBLISHER_ID = 'b2f917a9-e0eb-45b9-9e5f-14c283aa51e9';

test('plugin.json: GateControl 1.219.0, mail with dav, images, Drive, Familie and Alltag services, the app tab', () => {
  const m = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
  assert.equal(m.version, '1.4.0');
  // 1.2.0: gc.mail.dav (CalDAV/CardDAV), iMIP and up to 1000 pushes an hour need GateControl 1.219.0
  assert.equal(m.gatecontrol, '>=1.219.0');
  assert.ok(m.permissions.mail.dav.purpose.de && m.permissions.mail.dav.purpose.en);
  assert.deepEqual(m.permissions.notify, { perHour: 600 });
  for (const s of ['gatecontrol-familie:calendar_range', 'gatecontrol-alltag:calendar_list', 'gatecontrol-alltag:calendar_query']) assert.ok(m.permissions.services.includes(s), s);
  assert.equal(m.permissions.mail.maxConnections, 100);
  assert.ok(m.permissions.mail.purpose.de && m.permissions.mail.purpose.en);
  assert.equal(m.permissions.network.images, true);
  // outlook.office(365).com: the upload sessions of large attachments (Graph hands out their URLs there)
  assert.deepEqual(m.permissions.network.internet, ['graph.microsoft.com:443', 'login.microsoftonline.com:443', 'outlook.office.com:443', 'outlook.office365.com:443']);
  for (const s of ['list_areas', 'save_file', 'suggest_folder', 'give_file', 'share_link']) assert.ok(m.permissions.services.includes(`gatecontrol-drive:${s}`), s);
  assert.ok(m.permissions.services.includes('gatecontrol-familie:calendar_add'));
  assert.equal(m.storage.maxMB, 4096);
  assert.deepEqual(m.notifyTopics.map((t) => t.id), ['mail', 'mail_failed', 'calendar_reminder', 'calendar_invite']);
  assert.ok(m.notifyTopics.every((t) => t.default === true));
  assert.ok(m.ui.app && m.ui.portal);
});

test('GET me without accounts; who may use Mail (the administrator), not for a viewer without a login', () => withMail({}, async (host, c) => {
  const me = await c.as(ANNA)('GET', 'me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.json.accounts, []);
  assert.ok(me.json.features.includes('mail'));
  assert.ok(me.json.features.includes('images'));
  assert.ok(me.json.features.includes('drive'));
  assert.ok(me.json.features.includes('familyCalendar'));
  assert.ok(me.json.features.includes('microsoft'), '1.3.2: the publisher\'s registration');
  assert.ok(!me.json.features.includes('ai'), 'no AI in GateControl');
  assert.deepEqual(me.json.limits, { accountsMax: 5, quotaBytes: 5 * 1024 ** 3, usedBytes: 0, retentionMonths: 12 });
  // 1.2.0: the calendar and contact scopes (the administrator has both on), the admin consent link; 1.3.2: the publisher's client id
  assert.deepEqual(me.json.microsoft, { clientId: PUBLISHER_ID, authority: 'https://login.microsoftonline.com/common',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite', 'Contacts.ReadWrite'],
    adminConsentUrl: `https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=${PUBLISHER_ID}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default` });
  assert.ok(me.json.features.includes('calendar') && me.json.features.includes('contacts'));
  assert.ok(!me.json.features.includes('dav'), 'GateControl 1.216.0 has no gc.mail.dav');
  assert.deepEqual(me.json.settings, { threads: true, swipeLeft: 'archive', swipeRight: 'read' });
  assert.deepEqual((await c.as(ANNA)('PUT', 'settings', { swipeLeft: 'delete', threads: false })).json.settings, { threads: false, swipeLeft: 'delete', swipeRight: 'read' });
  assert.equal((await c.as(ANNA)('PUT', 'settings', { swipeLeft: 'fly' })).json.error.code, 'invalid');
  // only Anna
  assert.equal((await c.admin('PUT', 'admin/settings', { allowed: { all: false, principals: [{ type: 'user', id: ANNA.id }] } })).status, 200);
  const no = await c.as(MARC)('GET', 'me');
  assert.deepEqual([no.status, no.json.error.code], [403, 'not_allowed']);
  assert.equal(await host.appVisible({ id: MARC.id, name: 'Marc', role: 'user' }), false);
  assert.equal(await host.appVisible({ id: ANNA.id, name: 'Anna', role: 'user' }), true);
  assert.equal((await c.call({ ...ANNA, portal: true, loggedIn: false }, 'GET', 'me')).json.error.code, 'login_required');
  assert.equal((await c.call(ADMIN, 'GET', 'me')).status, 403, 'the admin UI is not a person');
  const providers = (await c.as(ANNA)('GET', 'providers')).json;
  assert.deepEqual(providers.map((p) => p.id), ['gmx', 'webde', 'tonline', 'gmail', 'outlook', 'm365', 'imap']);
  assert.equal(providers.find((p) => p.id === 'gmail').auth, 'app_password');
  assert.match(providers.find((p) => p.id === 'gmx').hint.de, /IMAP/);
  const d = (await c.as(ANNA)('POST', 'accounts/discover', { email: 'ada@web.de' })).json;
  assert.deepEqual([d.provider, d.imap.host, d.smtp.port], ['webde', 'imap.web.de', 587]);
  const d2 = (await c.as(ANNA)('POST', 'accounts/discover', { email: 'ada@firma.example' })).json;
  assert.deepEqual([d2.provider, d2.imap.host, d2.smtp.host], ['imap', 'imap.firma.example', 'smtp.firma.example']);
}));

test('add an account: the login is tried first (auth_failed with the hint, imap_disabled), sync, lists with Relevant / Sonstige', () => withMail({}, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  c.mail.login('anna@web.de', 'pw', { imapDisabled: true });
  const bad = await c.as(ANNA)('POST', 'accounts', { provider: 'gmx', email: 'anna@gmx.de', password: 'falsch' });
  assert.deepEqual([bad.status, bad.json.error.code], [409, 'auth_failed']);
  assert.match(bad.json.error.hint, /IMAP/);
  assert.equal((await c.as(ANNA)('POST', 'accounts', { provider: 'webde', email: 'anna@web.de', password: 'pw' })).json.error.code, 'imap_disabled');
  assert.equal((await c.as(ANNA)('POST', 'accounts', { provider: 'imap', email: 'anna@x.example', password: 'pw' })).json.error.code, 'invalid');
  const now = Date.now();
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { name: 'Sabine Keller', address: 'sabine@firma.example' }, subject: 'Projektbesprechung Dienstag', text: 'Hallo, passt dir Dienstag 10 Uhr?', date: now - 3600000 });
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { name: 'Elektromarkt', address: 'news@elektromarkt.example' }, subject: 'Nur heute: 20 %', text: 'Newsletter', headers: { 'list-id': '<news.elektromarkt.example>' }, date: now - 7200000 });
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { name: 'Bestellung', address: 'noreply@shop.example' }, subject: 'Ihre Bestellung', text: 'Danke', flags: ['\\Seen'], date: now - 9000000 });
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { address: 'alt@example.com' }, subject: 'Uralt', text: 'x', date: now - 500 * 86400000 });
  c.mail.mail('anna@gmx.de', 'Gesendet', { from: { address: 'anna@gmx.de' }, to: [{ address: 'tim@example.com' }], subject: 'Gesendet', text: 'x', flags: ['\\Seen'] });
  const acc = await c.addGmx(ANNA);
  assert.deepEqual([acc.provider, acc.email, acc.kind, acc.push, acc.attachments, acc.ai], ['gmx', 'anna@gmx.de', 'personal', 'relevant', 'suggest', true]);
  assert.match(acc.color, /^#[0-9A-F]{6}$/);
  assert.equal((await c.as(ANNA)('POST', 'accounts', { provider: 'gmx', email: 'anna@gmx.de', password: 'geheim-123' })).json.error.code, 'exists');
  await c.tick();
  const me = (await c.as(ANNA)('GET', 'me')).json;
  assert.equal(me.accounts[0].state, 'ok');
  assert.deepEqual(me.unread, { all: 2, byAccount: { [acc.id]: 2 } });
  // the credentials are a secret of the plugin, never in its database or an answer
  assert.ok(!JSON.stringify(me).includes('geheim-123'));
  assert.ok(!JSON.stringify(await c.db('SELECT * FROM accounts')).includes('geheim-123'));
  const rel = await c.list(ANNA, { box: 'all', tab: 'relevant' });
  assert.deepEqual(rel.items.map((m) => m.subject), ['Projektbesprechung Dienstag'], 'older than the retention: not synced');
  assert.deepEqual(rel.counts, { relevant: 1, other: 1 });
  const oth = await c.list(ANNA, { box: 'all', tab: 'other' });
  assert.deepEqual(oth.items.map((m) => m.subject), ['Nur heute: 20 %', 'Ihre Bestellung']);
  const s = rel.items[0];
  assert.deepEqual([s.from, s.accountId, s.unread, s.tab, s.threadCount, s.hasAttachments, s.savedToDrive, s.ai], [{ name: 'Sabine Keller', email: 'sabine@firma.example' }, acc.id, true, 'relevant', 1, false, false, null]);
  assert.equal(s.snippet, 'Hallo, passt dir Dienstag 10 Uhr?');
  const folders = (await c.as(ANNA)('GET', 'folders')).json.accounts[0].folders;
  assert.deepEqual(folders.map((f) => f.role), ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash']);
  const sent = folders.find((f) => f.role === 'sent');
  assert.deepEqual((await c.list(ANNA, { folder: sent.id })).items.map((m) => m.subject), ['Gesendet']);
  // filters, paging
  assert.deepEqual((await c.list(ANNA, { box: acc.id, tab: 'all', unread: '1' })).items.length, 2);
  const p1 = await c.list(ANNA, { box: 'all', tab: 'all', limit: '2' });
  assert.equal(p1.items.length, 2);
  const p2 = await c.list(ANNA, { box: 'all', tab: 'all', limit: '2', before: p1.next });
  assert.deepEqual(p2.items.map((m) => m.subject), ['Ihre Bestellung', 'Uralt'], 'scrolled past the retention: older mail from the server');
  // other people never see it
  assert.deepEqual((await c.list(MARC, { box: 'all' })).items, []);
  assert.equal((await c.as(MARC)('GET', `messages/${s.id}`)).status, 404);
  assert.equal((await c.as(MARC)('PATCH', `accounts/${acc.id}`, { name: 'x' })).status, 404);
}));

test('reading: the sanitized body, pictures only on request (proxy), trackers, attachments, flags, archive, trash, Sonstige learned', () => withMail({}, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  c.mail.mail('anna@gmx.de', 'INBOX', {
    from: { name: 'Stadtwerke', address: 'rechnung@stadtwerke.example' }, subject: 'Ihre Rechnung November',
    html: '<p onclick="steal()">Sehr geehrte Kundin,<script>alert(1)</script></p><img src="https://cdn.stadtwerke.example/logo.png"><img src="https://pixel.example/o.gif" width="1" height="1"><a href="https://stadtwerke.example">Portal</a>',
    attachments: [{ filename: 'Rechnung_2026_11.pdf', contentType: 'application/pdf', data: '%PDF-rechnung' }],
  });
  const acc = await c.addGmx(ANNA);
  await c.tick();
  const [s] = (await c.list(ANNA, {})).items;
  assert.equal(s.hasAttachments, true);
  const m = (await c.as(ANNA)('GET', `messages/${s.id}`)).json;
  assert.ok(!/script|onclick/.test(m.html));
  assert.match(m.html, /src="img\/\d+\.0\.[A-Za-z0-9_-]{22}"/);
  assert.ok(!m.html.includes('cdn.stadtwerke.example'), 'no external address in the HTML');
  assert.deepEqual([m.imagesBlocked, m.trackers], [true, 1]);
  assert.deepEqual(m.attachments.map((t) => [t.name, t.mime, t.inline, t.savedTo]), [['Rechnung_2026_11.pdf', 'application/pdf', false, null]]);
  const token = /src="(img\/[^"]+)"/.exec(m.html)[1];
  assert.equal((await c.as(ANNA)('GET', token)).json.error.code, 'images_blocked');
  assert.equal(host.imageFetches.length, 0);
  const allowed = (await c.as(ANNA)('POST', `messages/${s.id}/images`, { allow: 'sender' })).json;
  assert.equal(allowed.imagesBlocked, false);
  const img = (await c.as(ANNA)('GET', token)).json;
  assert.deepEqual([img.mime, Buffer.from(img.data, 'base64').toString()], ['image/png', 'PNGDATA']);
  assert.deepEqual(host.imageFetches, ['https://cdn.stadtwerke.example/logo.png']);
  assert.equal((await c.as(MARC)('GET', token)).status, 404, 'a token is for its person only');
  assert.equal((await c.as(ANNA)('GET', token.replace(/.$/, (x) => (x === 'A' ? 'B' : 'A')))).status, 404);
  // the attachment: downloaded once, then the cached copy
  const att = (await c.as(ANNA)('GET', `messages/${s.id}/attachments/${m.attachments[0].id}`)).json;
  assert.deepEqual([att.name, att.mime, host.media.get(att.mediaId).data.toString()], ['Rechnung_2026_11.pdf', 'application/pdf', '%PDF-rechnung']);
  assert.ok(att.url.startsWith('/plugin-media/'));
  assert.equal(await host.plugin.mediaAccess({ user: { id: ANNA.id }, mediaId: att.mediaId }, host.gc), true);
  assert.equal(await host.plugin.mediaAccess({ user: { id: MARC.id }, mediaId: att.mediaId }, host.gc), false);
  assert.equal((await c.as(ANNA)('GET', `messages/${s.id}/attachments/${m.attachments[0].id}`)).json.mediaId, att.mediaId);
  // flags on the server
  await c.as(ANNA)('POST', 'messages/flags', { ids: [s.id], unread: false, flagged: true });
  const box = c.mail.box('anna@gmx.de', 'INBOX');
  assert.deepEqual([...box.msgs.values()][0].flags.sort(), ['\\Flagged', '\\Seen']);
  // to Sonstige: learned for the sender
  const t = (await c.as(ANNA)('POST', 'messages/tab', { ids: [s.id], tab: 'other' })).json;
  assert.equal(t.items[0].tab, 'other');
  c.mail.deliver('anna@gmx.de', { from: { address: 'rechnung@stadtwerke.example' }, subject: 'Noch eine', text: 'x' });
  await settle(200);
  await c.tick();
  assert.deepEqual((await c.list(ANNA, { tab: 'other' })).items.map((x) => x.subject).sort(), ['Ihre Rechnung November', 'Noch eine']);
  // archive, delete (trash), delete in the trash (for good)
  const a1 = (await c.as(ANNA)('POST', 'messages/archive', { ids: [s.id] })).json;
  const archive = (await c.as(ANNA)('GET', 'folders')).json.accounts[0].folders.find((f) => f.role === 'archive');
  assert.equal(a1.items[0].folderId, archive.id);
  assert.equal(c.mail.box('anna@gmx.de', 'Archiv').msgs.size, 1);
  const d1 = (await c.as(ANNA)('POST', 'messages/delete', { ids: [s.id] })).json;
  assert.equal(c.mail.box('anna@gmx.de', 'Papierkorb').msgs.size, 1);
  await c.as(ANNA)('POST', 'messages/delete', { ids: [d1.items[0].id] });
  assert.equal(c.mail.box('anna@gmx.de', 'Papierkorb').msgs.size, 0);
  assert.equal((await c.as(ANNA)('GET', `messages/${s.id}`)).status, 404);
  void acc;
}));

test('new mail during IDLE: synced at once, a push per the account (relevant / all / off), the live event', () => withMail({}, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  c.mail.mail('anna@gmx.de', 'INBOX', { subject: 'Alt', text: 'x', flags: ['\\Seen'] });
  const acc = await c.addGmx(ANNA);
  await c.tick();
  assert.equal(host.notifications.length, 0, 'the first sync pushes nothing');
  c.mail.deliver('anna@gmx.de', { from: { name: 'Tim Brandt', address: 'tim@example.com' }, subject: 'Angebot Kunde Müller', text: 'Kannst du bis Freitag?' });
  await settle(1200);
  const pushes = host.notifications.filter((n) => n.topic === 'mail');
  assert.equal(pushes.length, 1);
  const p = pushes[0];
  assert.deepEqual([p.title, p.body, p.users], ['Tim Brandt', 'Angebot Kunde Müller', [ANNA.id]]);
  assert.equal(p.data.mail.accountId, acc.id);
  assert.ok(Number.isSafeInteger(p.data.mail.messageId));
  assert.ok(host.events.some((e) => e.type === 'mail' && e.data.kind === 'changed' && e.users[0] === ANNA.id));
  // a newsletter with push 'relevant': no push; with 'all': one
  c.mail.deliver('anna@gmx.de', { from: { address: 'news@shop.example' }, subject: 'Angebote', text: 'x', headers: { 'list-id': '<x>' } });
  await settle(1200);
  assert.equal(host.notifications.filter((n) => n.topic === 'mail').length, 1);
  await c.as(ANNA)('PATCH', `accounts/${acc.id}`, { push: 'all' });
  c.mail.deliver('anna@gmx.de', { from: { address: 'news@shop.example' }, subject: 'Mehr Angebote', text: 'x', headers: { 'list-id': '<x>' } });
  await settle(1200);
  assert.equal(host.notifications.filter((n) => n.topic === 'mail').length, 2);
  await c.as(ANNA)('PATCH', `accounts/${acc.id}`, { push: 'off' });
  c.mail.deliver('anna@gmx.de', { from: { address: 'tim@example.com' }, subject: 'Still', text: 'x' });
  await settle(1200);
  assert.equal(host.notifications.filter((n) => n.topic === 'mail').length, 2);
  assert.equal((await c.list(ANNA, { tab: 'all' })).items.length, 5);
}));

test('search: here first, then the server (beyond the retention); conversations; account settings, password, removal', () => withMail({}, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  const first = c.mail.mail('anna@gmx.de', 'INBOX', { from: { address: 'tim@example.com' }, subject: 'Angebot', text: 'Preise anbei', messageId: '<a1@example.com>' });
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { address: 'tim@example.com' }, subject: 'Re: Angebot', text: 'Danke', messageId: '<a2@example.com>', inReplyTo: '<a1@example.com>' });
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { address: 'oma@example.com' }, subject: 'Steuer 2023', text: 'Belege', date: Date.now() - 600 * 86400000 });
  const acc = await c.addGmx(ANNA);
  await c.tick();
  const list = await c.list(ANNA, {});
  assert.equal(list.items.length, 1, 'one conversation');
  assert.equal(list.items[0].threadCount, 2);
  assert.equal((await c.as(ANNA)('GET', `threads/${list.items[0].threadId}`)).json.items.map((m) => m.subject).join('|'), 'Angebot|Re: Angebot');
  assert.equal((await c.list(ANNA, { tab: 'all', unread: '1' })).items.length, 2, 'filters show every mail');
  const local = (await c.as(ANNA)('GET', 'search', null, { q: 'Preise' })).json;
  assert.deepEqual(local.items.map((m) => m.subject), ['Angebot']);
  const remote = (await c.as(ANNA)('GET', 'search', null, { q: 'Steuer' })).json;
  assert.deepEqual([remote.items.map((m) => m.subject), remote.remote], [['Steuer 2023'], true]);
  void first;
  // settings of the account
  const p = (await c.as(ANNA)('PATCH', `accounts/${acc.id}`, { name: 'Privat', color: '#f5b544', kind: 'personal', ai: false, attachments: 'auto', signature: 'Anna' })).json.account;
  assert.deepEqual([p.name, p.color, p.ai, p.attachments, p.signature], ['Privat', '#F5B544', false, 'auto', 'Anna']);
  assert.equal((await c.as(ANNA)('PATCH', `accounts/${acc.id}`, { push: 'sometimes' })).json.error.code, 'invalid');
  // a new password is tried first
  assert.equal((await c.as(ANNA)('PATCH', `accounts/${acc.id}`, { password: 'nein' })).json.error.code, 'auth_failed');
  c.mail.logins.get('anna@gmx.de').pass = 'neu-456';
  assert.equal((await c.as(ANNA)('PATCH', `accounts/${acc.id}`, { password: 'neu-456' })).status, 200);
  // the limit
  await c.admin('PUT', 'admin/settings', { accountsMax: 1 });
  c.mail.login('anna2@gmx.de', 'x');
  const lim = await c.as(ANNA)('POST', 'accounts', { provider: 'gmx', email: 'anna2@gmx.de', password: 'x' });
  assert.deepEqual([lim.status, lim.json.error.code, lim.json.error.max], [403, 'limit', 1]);
  // removal: the copy goes, the mail at the provider stays
  assert.deepEqual((await c.as(ANNA)('DELETE', `accounts/${acc.id}`)).json, { ok: true });
  assert.equal((await c.db('SELECT COUNT(*) AS n FROM messages'))[0].n, 0);
  assert.equal(c.mail.box('anna@gmx.de', 'INBOX').msgs.size, 3);
  assert.deepEqual((await c.as(ANNA)('GET', 'me')).json.accounts, []);
}));

test('admin settings: checked values, usage per person (numbers only), Microsoft consent link with an own client id', () => withMail({}, async (host, c) => {
  await c.addGmx(BOB);
  c.mail.deliver('bob@gmx.de', { subject: 'Geheimes Projekt', text: 'nur für Bob' });
  await settle(1200);
  await c.tick();
  const r = (await c.admin('GET', 'admin/settings')).json;
  assert.deepEqual(r.settings, { allowed: { all: true, principals: [] }, accountsMax: 5, retentionMonths: 12, attachments: 'on_demand', quotaGB: 5,
    ai: { bar: true, sort: true, autoFile: true, blockBusiness: false }, microsoft: { registration: 'default', customClientId: null },
    // 1.2.0: calendars and contacts (C9)
    calendar: { enabled: true, accounts: true, business: 'gatecontrol', defaultReminder: 15, internalInvites: true, overlays: { familie: true, alltag: true, birthdays: true } },
    contacts: { enabled: true, accounts: true, ai: true } });
  assert.equal(r.usage.people[0].name, 'Bob');
  assert.ok(r.usage.people[0].bytes > 0);
  assert.ok(!JSON.stringify(r).includes('Geheimes') && !JSON.stringify(r).includes('bob@gmx.de'), 'never mail or addresses of others');
  assert.deepEqual([r.microsoft.clientId, r.microsoft.defaultClientId], [PUBLISHER_ID, PUBLISHER_ID]);
  assert.equal(r.microsoft.consentUrl, `https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=${PUBLISHER_ID}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default`);
  for (const bad of [{ accountsMax: 21 }, { retentionMonths: 5 }, { quotaGB: 0 }, { attachments: 'never' }, { ai: { bar: 'yes' } }, { microsoft: { customClientId: 'abc' } },
    { calendar: { business: 'outlook' } }, { calendar: { defaultReminder: 7 } }, { calendar: { overlays: { schule: true } } }, { contacts: { enabled: 'no' } }, { calendar: { foo: true } }]) {
    assert.equal((await c.admin('PUT', 'admin/settings', bad)).json.error.code, 'invalid', JSON.stringify(bad));
  }
  const id = '11111111-2222-3333-4444-555555555555';
  const ms = (await c.admin('PUT', 'admin/settings', { microsoft: { registration: 'custom', customClientId: id } })).json.microsoft;
  assert.equal(ms.clientId, id);
  assert.equal(ms.consentUrl, `https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=${id}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default`);
  const me = (await c.as(BOB)('GET', 'me')).json;
  assert.ok(me.features.includes('microsoft'));
  assert.equal(me.microsoft.clientId, id);
  const ov = (await c.admin('GET', 'admin/overview')).json;
  assert.deepEqual([ov.people, ov.accounts, ov.byState.ok], [1, 1, 1]);
  assert.equal((await c.as(BOB)('GET', 'admin/settings')).status, 403);
  // the pages render
  const page = await host.plugin.render({ view: 'page', page: 'settings', lang: 'de' }, host.gc);
  assert.match(page.html, /MA_CTX/);
  const portal = await host.plugin.render({ view: 'portal', lang: 'en', user: { id: BOB.id, loggedIn: true } }, host.gc);
  assert.match(portal.html, /"allowed":true/);
}));

test('quota and retention: the oldest bodies and attachment copies go, the headers stay; old unseen mail goes', () => withMail({}, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  for (let i = 0; i < 5; i++) c.mail.mail('anna@gmx.de', 'INBOX', { subject: `Mail ${i}`, text: 'x'.repeat(4000), date: Date.now() - (i + 1) * 86400000 });
  await c.addGmx(ANNA);
  await c.tick();
  await c.tick();
  const store = require('../server/store');
  const mailstore = require('../server/mailstore');
  const used = await mailstore.usage(host.gc, ANNA.id);
  assert.ok(used > 15000, String(used));
  const freed = await mailstore.evict(host.gc, ANNA.id, 10000, Date.now());
  assert.ok(freed > 0);
  assert.ok(await mailstore.usage(host.gc, ANNA.id) <= 9000);
  const rows = await store.all(host.gc, 'SELECT subject, body_state FROM messages ORDER BY date DESC');
  assert.equal(rows.length, 5, 'the headers stay');
  assert.equal(rows[rows.length - 1].body_state, 'evicted', 'the oldest first');
  // an evicted body loads again from the server when the mail is opened
  const old = (await c.list(ANNA, {})).items.find((m) => m.subject === 'Mail 4');
  assert.equal((await c.as(ANNA)('GET', `messages/${old.id}`)).json.text, 'x'.repeat(4000));
  // retention: one month — older mail nobody looked at goes
  await c.admin('PUT', 'admin/settings', { retentionMonths: 1 });
  await store.run(host.gc, 'UPDATE messages SET date = ?, seen_at = NULL WHERE subject = ?', [Date.now() - 90 * 86400000, 'Mail 3']);
  const engine = require('../server/engine');
  const config = require('../server/config');
  assert.equal(await engine.retention(host.gc, await config.get(host.gc), Date.now()), 1);
}));
