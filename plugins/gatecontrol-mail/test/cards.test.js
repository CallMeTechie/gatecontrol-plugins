'use strict';

// Contacts of Mail 1.2.0 (C3 „Kontakte“, path cards): the own address book (vCard), search and letters, changes with
// etag, ?since= for the apps' offline copy, photos, groups and the suggestions while writing (GET contacts?q=, the old
// form kept), duplicates (merge in one address book, link across them), vCard import / export (Gmail's export too), the
// sender view, „Als Kontakt speichern“ from a mail, the rights of a person.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, ANNA, MARC, BOB } = require('./helpers');
const { FakeDav, vcf } = require('./pim-helpers');
const pim = require('../server/pim');

const JPEG = Buffer.from('fake-jpeg-bytes').toString('base64');

test('cards: create, list with letters (Ä → A), search by name, company, address and number, etag conflict, since with tombstones, photos, rights', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  const anna = c.as(ANNA);
  const mk = async (b) => { const r = await anna('POST', 'cards', b); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.card; };
  const a = await mk({ name: { given: 'Anna', family: 'Ärmel' }, emails: [{ value: 'Anna.Aermel@Example.com', type: 'work' }], phones: [{ value: '+49 (170) 123-4567', type: 'mobile' }], company: 'Bäckerei Süß', birthday: '1986-11-12' });
  const b = await mk({ name: { given: 'Bernd', family: 'Zander' }, emails: [{ value: 'bernd@example.com' }], note: 'Alter Freund' });
  await mk({ company: '3M Deutschland' });
  assert.deepEqual([a.name.display, a.emails[0].value, a.emails[0].primary, a.phones[0].type, a.readOnly, a.source], ['Anna Ärmel', 'anna.aermel@example.com', true, 'mobile', false, 'local']);
  let list = (await anna('GET', 'cards')).json;
  assert.deepEqual(list.items.map((x) => [x.name, x.letter]), [['3M Deutschland', '#'], ['Anna Ärmel', 'A'], ['Bernd Zander', 'Z']]);
  assert.equal(list.next, null);
  // the person's order: by given name, shown family first
  await anna('PUT', 'cards/settings', { sort: 'given', show: 'family_given' });
  list = (await anna('GET', 'cards')).json;
  assert.deepEqual(list.items.map((x) => [x.name, x.letter]), [['3M Deutschland', '#'], ['Ärmel, Anna', 'A'], ['Zander, Bernd', 'B']]);
  await anna('PUT', 'cards/settings', { sort: 'family', show: 'given_family' });
  for (const [q, want] of [['ärm', ['Anna Ärmel']], ['ARMEL', ['Anna Ärmel']], ['süß', ['Anna Ärmel']], ['bernd@', ['Bernd Zander']], ['0170 1234567', ['Anna Ärmel']], ['zzz', []]]) {
    assert.deepEqual((await anna('GET', 'cards', null, { q })).json.items.map((x) => x.name), want, q);
  }
  // pages
  const p1 = (await anna('GET', 'cards', null, { limit: '2' })).json;
  const p2 = (await anna('GET', 'cards', null, { limit: '2', cursor: p1.next })).json;
  assert.deepEqual([...p1.items, ...p2.items].map((x) => x.name), ['3M Deutschland', 'Anna Ärmel', 'Bernd Zander']);
  // a change with the etag; an old etag → conflict with the current card
  const v0 = list.version;
  const ch = await anna('PATCH', `cards/${b.id}`, { title: 'Bäcker', etag: b.etag });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  const stale = await anna('PATCH', `cards/${b.id}`, { title: 'x', etag: b.etag });
  assert.deepEqual([stale.status, stale.json.error.code, stale.json.error.current.title], [409, 'conflict', 'Bäcker']);
  // since: changes and tombstones
  assert.equal((await anna('DELETE', `cards/${a.id}`)).status, 200);
  const since = (await anna('GET', 'cards', null, { since: String(v0) })).json;
  assert.deepEqual([since.items.map((x) => x.name), since.deleted], [['Bernd Zander'], [a.id]]);
  // photos ≤ 256 KB
  assert.equal((await anna('PUT', `cards/${b.id}/photo`, { mime: 'image/jpeg', data: JPEG })).json.card.photo.mime, 'image/jpeg');
  assert.deepEqual((await anna('GET', `cards/${b.id}/photo`)).json, { mime: 'image/jpeg', size: 15, data: JPEG });
  assert.equal((await anna('PUT', `cards/${b.id}/photo`, { mime: 'image/gif', data: JPEG })).json.error.code, 'invalid');
  assert.equal((await anna('PUT', `cards/${b.id}/photo`, { mime: 'image/png', data: Buffer.alloc(300 * 1024).toString('base64') })).json.error.code, 'too_large');
  assert.equal((await anna('DELETE', `cards/${b.id}/photo`)).json.card.photo, null);
  // input checks; other people's cards: 404
  for (const bad of [{ emails: [{ value: 'kein' }] }, { birthday: '2026-02-30' }, { phones: [{ value: 'abc' }] }, { note: 'x'.repeat(9000) }, {}]) { const rr = await anna('POST', 'cards', bad); assert.equal(rr.json.error && rr.json.error.code, 'invalid', JSON.stringify(bad) + JSON.stringify(rr.json).slice(0, 100)); }
  assert.equal((await c.as(MARC)('GET', `cards/${b.id}`)).status, 404);
  assert.equal((await c.as(MARC)('PATCH', `cards/${b.id}`, { title: 'x' })).status, 404);
  assert.equal((await c.as(MARC)('DELETE', `cards/${b.id}`)).status, 404);
  assert.equal((await c.as(MARC)('GET', `cards/${b.id}/photo`)).status, 404);
  assert.deepEqual((await c.as(MARC)('GET', 'cards')).json.items, []);
}));

test('GET contacts?q=: own contacts first (each address on its own), groups with their members, GateControl people, recent addresses — the old form stays', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  await c.addGmx(ANNA);
  await c.addGmx(MARC, { name: 'Marc' });
  await settle(200);
  const anna = c.as(ANNA);
  const card = (await anna('POST', 'cards', { name: { given: 'Marlene', family: 'Dietrich' }, emails: [{ value: 'marlene@example.com' }, { value: 'mdietrich@work.example' }] })).json.card;
  const g = (await anna('POST', 'groups', { name: 'Marathon' })).json.group;
  await anna('POST', `groups/${g.id}/members`, { add: [{ contactId: card.id }, { email: 'lauf@example.com', name: 'Läufer' }] });
  await host.gc.db.run("INSERT INTO contacts (user_id, email, name, sent, received, last_at) VALUES (?, 'mario@example.com', 'Mario', 1, 0, ?)", [ANNA.id, Date.now()]);
  const r = (await anna('GET', 'contacts', null, { q: 'mar' })).json.items;
  assert.deepEqual(r.map((x) => [x.source, x.name, x.email]), [
    ['contact', 'Marlene Dietrich', 'marlene@example.com'], ['contact', 'Marlene Dietrich', 'mdietrich@work.example'], ['group', 'Marathon (2)', null],
    ['person', 'Marc', 'marc@gmx.de'], ['recent', 'Mario', 'mario@example.com']]);
  assert.deepEqual([r[0].contactId, r[0].photo], [card.id, false]);
  assert.deepEqual(r[2].members, [{ name: 'Marlene Dietrich', email: 'marlene@example.com' }, { name: 'Läufer', email: 'lauf@example.com' }]);
  assert.ok(r.every((x) => 'name' in x && 'email' in x && 'source' in x));
  // without q: the recent addresses as before
  assert.deepEqual((await anna('GET', 'contacts')).json.items.map((x) => x.source), ['recent']);
  // contacts switched off by the administrator: like Phase 1
  await c.admin('PUT', 'admin/settings', { contacts: { enabled: false } });
  assert.deepEqual((await anna('GET', 'contacts', null, { q: 'mar' })).json.items.map((x) => x.source), ['person', 'recent']);
  // groups: limits, other people's groups
  await c.admin('PUT', 'admin/settings', { contacts: { enabled: true } });
  assert.equal((await c.as(BOB)('GET', `groups/${g.id}`)).status, 404);
  assert.deepEqual((await anna('GET', 'addressbooks')).json.groups, [{ id: g.id, name: 'Marathon', color: null, count: 2 }]);
  const gm = (await anna('GET', `groups/${g.id}`)).json.members;
  const rm = (await anna('POST', `groups/${g.id}/members`, { remove: [gm[1].id] })).json;
  assert.deepEqual(rm.members.map((x) => x.email), ['marlene@example.com']);
  assert.equal((await anna('PATCH', `groups/${g.id}`, { name: 'Lauftreff', color: '#46e0a0' })).json.group.color, '#46E0A0');
  assert.equal((await anna('DELETE', `groups/${g.id}`)).status, 200);
}));

test('duplicates: same address, same number, same name without addresses; ignore; merge in one address book (fields joined, groups move)', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  const anna = c.as(ANNA);
  const mk = async (b) => (await anna('POST', 'cards', b)).json.card;
  const a1 = await mk({ name: { given: 'Peter', family: 'Pan' }, emails: [{ value: 'peter@example.com' }], phones: [{ value: '0170 1112223' }], company: 'Nimmerland' });
  const a2 = await mk({ name: { given: 'P.', family: 'Pan' }, emails: [{ value: 'PETER@example.com' }, { value: 'pan@work.example' }], note: 'Zweitnotiz', birthday: '2000-01-01' });
  const b1 = await mk({ name: { given: 'Hook' }, phones: [{ value: '+49 171 999888' }] });
  const b2 = await mk({ name: { given: 'Käpt\'n', family: 'Hook' }, phones: [{ value: '0171/999888' }] });
  const n1 = await mk({ name: { given: 'Tinker', family: 'Bell' } });
  const n2 = await mk({ name: { given: 'Tinker', family: 'Bell' } });
  const d = (await anna('GET', 'cards/duplicates')).json.items;
  assert.deepEqual(d.map((x) => [x.reason, x.cards.map((y) => y.id)]), [['email', [a1.id, a2.id]], ['phone', [b1.id, b2.id]], ['name', [n1.id, n2.id]]]);
  assert.equal((await anna('POST', 'cards/duplicates/ignore', { ids: [n1.id, n2.id] })).status, 200);
  assert.equal((await anna('GET', 'cards/duplicates')).json.items.length, 2);
  const g = (await anna('POST', 'groups', { name: 'Kinder' })).json.group;
  await anna('POST', `groups/${g.id}/members`, { add: [{ contactId: a2.id }] });
  const m = await anna('POST', 'cards/merge', { ids: [a1.id, a2.id], primaryId: a1.id, pick: { birthday: a2.id, note: 'join' } });
  assert.equal(m.status, 200, JSON.stringify(m.json));
  const card = m.json.card;
  assert.deepEqual([card.id, card.emails.map((e) => e.value), card.phones.length, card.company, card.birthday, card.note, card.groups],
    [a1.id, ['peter@example.com', 'pan@work.example'], 1, 'Nimmerland', '2000-01-01', 'Zweitnotiz', [g.id]]);
  assert.equal((await anna('GET', `cards/${a2.id}`)).status, 404);
  assert.equal((await anna('POST', 'cards/merge', { ids: [b1.id], primaryId: b1.id })).json.error.code, 'invalid');
}));

test('linking across address books (a CardDAV one and the own): shown once, fields joined, nothing deleted at the provider', async () => {
  const dav = new FakeDav({ user: 'anna@gmx.de', pass: 'geheim-123' });
  const book = dav.book('k', { name: 'GMX-Kontakte' });
  dav.put(book, 'w.vcf', vcf('w', ['FN:Wendy Darling', 'N:Darling;Wendy;;;', 'EMAIL:wendy@example.com', 'TEL;TYPE=WORK:030 123456']));
  await withMail({ gatecontrol: '1.219.0', dav }, async (host, c) => {
    await c.addGmx(ANNA);
    const anna = c.as(ANNA);
    await anna('GET', 'addressbooks');
    for (let i = 0; i < 6; i++) { for (let k = 0; k < 5; k++) { const x = pim.lineOf(k); x.retryAt = 0; } await host.tick(); }
    const own = (await anna('POST', 'cards', { name: { given: 'Wendy', family: 'Darling' }, emails: [{ value: 'wendy@example.com' }], birthday: '--05-01' })).json.card;
    const all = (await anna('GET', 'cards')).json.items;
    const remote = all.find((x) => x.id !== own.id);
    assert.ok(remote, JSON.stringify(all));
    const d = (await anna('GET', 'cards/duplicates')).json.items;
    assert.deepEqual(d.map((x) => x.reason), ['email']);
    const m = await anna('POST', 'cards/merge', { ids: [own.id, remote.id], primaryId: own.id });
    assert.equal(m.status, 200, JSON.stringify(m.json));
    assert.deepEqual([m.json.card.linked.map((l) => [l.id, l.source]), m.json.card.phones.map((p) => p.value), m.json.card.birthday], [[[remote.id, 'carddav']], ['030 123456'], '--05-01']);
    const list = (await anna('GET', 'cards')).json.items;
    assert.deepEqual(list.map((x) => [x.id, x.linked]), [[own.id, [remote.id]]]);
    assert.equal(dav.cols.get(book).objects.size, 1, 'nothing deleted at the provider');
    assert.deepEqual((await anna('GET', 'cards/duplicates')).json.items, []);
  });
});

test('vCard import (Gmail export, again: updated / skipped), export as vCard 4.0; lookup for the sender view; activity; „Als Kontakt speichern“', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  await c.addGmx(ANNA);
  await settle(200);
  const anna = c.as(ANNA);
  const google = [
    vcf('g1', ['FN:Clara Schmidt', 'N:Schmidt;Clara;;;', 'EMAIL;TYPE=INTERNET:clara@example.com', 'TEL;TYPE=CELL:0151 444', 'item1.X-ABLabel:Privat', 'PHOTO;ENCODING=b;TYPE=JPEG:' + JPEG]),
    vcf('g2', ['FN:Dirk Doe', 'N:Doe;Dirk;;;', 'EMAIL:dirk@example.com', 'BDAY:--07-04']),
    'BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n',
  ].join('');
  const r = (await anna('POST', 'cards/import', { vcf: google })).json;
  assert.deepEqual(r, { imported: 2, updated: 0, skipped: 1 });
  assert.deepEqual((await anna('POST', 'cards/import', { vcf: google.replace('0151 444', '0151 555') })).json, { imported: 0, updated: 1, skipped: 2 });
  assert.equal((await anna('POST', 'cards/import', { vcf: 'kaputt' })).json.error.code, 'invalid_vcard');
  const clara = (await anna('GET', 'cards', null, { q: 'clara' })).json.items[0];
  assert.deepEqual([clara.phone, clara.photo], ['0151 555', true]);
  const exp = (await anna('GET', 'cards/export')).json;
  assert.deepEqual([exp.name, exp.mime], ['kontakte.vcf', 'text/vcard']);
  const text = Buffer.from(exp.data, 'base64').toString();
  assert.equal((text.match(/BEGIN:VCARD/g) || []).length, 2);
  assert.match(text, /VERSION:4\.0/);
  assert.match(text, /item1\.X-ABLabel:Privat/i, 'unknown properties stay');
  assert.match(text, /PHOTO:data:image\/jpeg;base64,/);
  // the sender view
  c.mail.deliver('anna@gmx.de', { from: { name: 'Clara Schmidt', address: 'clara@example.com' }, subject: 'Hallo', text: 'Hi Anna,\n\nbis bald.\n\nViele Grüße\nClara Schmidt\nProjektleiterin\nMuster GmbH\nTel.: +49 30 123 456 78\nMobil: 0151 9876543' });
  await settle(1500);
  await c.tick();
  const lk = (await anna('GET', 'cards/lookup', null, { email: 'CLARA@example.com' })).json;
  assert.deepEqual([lk.card.name.display, lk.person, lk.recent.received], ['Clara Schmidt', null, 1]);
  assert.deepEqual((await anna('GET', 'cards/lookup', null, { email: 'niemand@example.com' })).json, { card: null, person: null, recent: null });
  const act = (await anna('GET', `cards/${clara.id}/activity`)).json;
  assert.deepEqual(act.mails.map((m) => m.subject), ['Hallo']);
  // „Als Kontakt speichern“ from a mail of someone unknown: the signature by rules (no AI here)
  c.mail.deliver('anna@gmx.de', { from: { name: 'Max Mustermann', address: 'max@muster.example' }, subject: 'Angebot', text: 'Guten Tag,\n\nanbei das Angebot.\n\nMit freundlichen Grüßen\nMax Mustermann\nVertriebsleiter\nMuster Handel GmbH\nTelefon: 089 1234567\nFax: 089 1234568' });
  await settle(1500);
  await c.tick();
  const mid = (await c.list(ANNA)).items.find((x) => x.subject === 'Angebot').id;
  await anna('GET', `messages/${mid}`);
  const dr = (await anna('GET', 'cards/draft', null, { messageId: String(mid) })).json;
  assert.deepEqual([dr.draft.name.given, dr.draft.name.family, dr.draft.emails[0].value, dr.draft.company, dr.draft.title, dr.draft.phones.map((p) => [p.value, p.type]), dr.existing],
    ['Max', 'Mustermann', 'max@muster.example', 'Muster Handel GmbH', 'Vertriebsleiter', [['089 1234567', 'work'], ['089 1234568', 'fax']], null]);
  assert.equal((await c.as(MARC)('GET', 'cards/draft', null, { messageId: String(mid) })).status, 404);
  assert.equal((await anna('GET', 'cards', null, { q: 'max' })).json.items.length, 0, 'nothing was stored');
}));
