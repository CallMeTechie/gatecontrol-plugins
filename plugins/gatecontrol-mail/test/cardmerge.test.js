'use strict';

// Mail 1.4.0 — the GateControl contact as the master: the rules of a merge (an emoji name, a missing family name, the
// most complete name, the picture), the one run after the update with its protocol (old links into GC contacts, certain
// duplicates merged, uncertain ones listed with where they come from and a preview), confirming and undoing, conflicts
// (take over / dismiss — a dismissed value stays away until it changes at the provider), writing back a value taken
// over, favourites with the main number, deleting a GC contact, the calendar widget.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, ANNA } = require('./helpers');
const { FakeDav, vcf } = require('./pim-helpers');
const pim = require('../server/pim');
const cardmerge = require('../server/cardmerge');
const tz = require('../server/tz');

const JPEG = Buffer.from('fake-jpeg-bytes').toString('base64');

/** Everything due again now, then some runs (sync steps and the contacts' run). */
async function syncs(host, n = 8) {
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 10; k++) { const x = pim.lineOf(k); x.retryAt = 0; x.pause = 0; for (const key of Object.keys(x.last)) if (!/List$/.test(key)) x.last[key] = 0; }
    cardmerge.reset();
    await host.tick();
    await settle(20);
  }
}

const entry = (id, local, f, extra = {}) => ({ row: { id, photo_etag: null, updated_at: extra.updated || id, ...extra }, local, f: { emails: [], phones: [], addresses: [], urls: [], ...f } });

test('the rules: similar names, an emoji name wins, a missing family name from another card, else the most complete name; lists without doubles', async () => {
  const f = (given, family, display) => ({ name: { given, family, display: display || [given, family].filter(Boolean).join(' ') } });
  assert.equal(cardmerge.similar(f('Sabrina', ''), f('Sabrina', 'Martin')), true);
  assert.equal(cardmerge.similar(f('P.', 'Pan'), f('Peter', 'Pan')), true);
  assert.equal(cardmerge.similar(f('', '', 'Schatzimausi 💞'), f('Sabrina', 'Martin')), false);
  assert.equal(cardmerge.similar(f('', '', 'anna@example.com'), f('Anna', 'Lang')), true, 'a card without a name');
  assert.equal(cardmerge.similar(f('Anna', 'Lang'), f('Berta', 'Lang')), false);
  const emoji = await cardmerge.unionOf(null, [
    entry(1, false, { ...f('Sabrina', 'Martin'), phones: [{ value: '0171 1000001', type: 'other' }], company: 'Firma' }),
    entry(2, false, { ...f('', '', 'Schatzimausi 💞'), phones: [{ value: '+49 171 1000001', type: 'mobile' }], note: 'Jahrestag 12.5.' }),
    entry(3, false, { ...f('Sabrina', ''), emails: [{ value: 'sabrina@example.com', type: 'home', primary: true }], note: 'Jahrestag 12.5.' }),
  ]);
  assert.equal(emoji.fields.name.display, 'Schatzimausi 💞');
  assert.deepEqual(emoji.fields.phones, [{ value: '+49 171 1000001', type: 'mobile' }], 'one number, the more exact kind, the + form');
  assert.deepEqual([emoji.fields.emails.map((e) => e.value), emoji.fields.company, emoji.fields.note], [['sabrina@example.com'], 'Firma', 'Jahrestag 12.5.']);
  const family = await cardmerge.unionOf(null, [entry(1, true, f('Sabrina', '')), entry(2, false, { ...f('Sabrina', 'Martin'), name: { given: 'Sabrina', family: 'Martin', display: 'S. Martin', middle: null } }),
    entry(3, false, f('Bine', ''))], { pick: { name: 1 } });
  assert.deepEqual([family.fields.name.given, family.fields.name.family, family.fields.name.display], ['Sabrina', 'Martin', 'Sabrina Martin']);
  const complete = await cardmerge.unionOf(null, [entry(1, true, f('Peter', '')), entry(2, false, { name: { given: 'Peter', family: 'Pan', middle: 'J.', display: 'Peter J. Pan' } })]);
  assert.equal(complete.fields.name.display, 'Peter J. Pan');
  assert.deepEqual(cardmerge.mainPhoneOf({ phones: [{ value: '030 1', type: 'work' }, { value: '0171 2', type: 'mobile' }] }, null), { value: '0171 2', type: 'mobile' });
});

test('after the update: old links become GC contacts, certain duplicates are merged with a protocol, uncertain ones wait with origin and preview; confirm and undo; nothing deleted at the provider', async () => {
  const dav = new FakeDav({ user: 'anna@gmx.de', pass: 'geheim-123' });
  const gmx = dav.book('k', { name: 'GMX-Kontakte' });
  const phone = dav.book('o', { name: 'OnePlus 10 Pro 5G' });
  dav.put(gmx, 's1.vcf', vcf('s1', ['FN:Sabrina Martin', 'N:Martin;Sabrina;;;', 'EMAIL:sabrina@example.com', 'TEL;TYPE=CELL:0171 1000001']));
  dav.put(gmx, 'p1.vcf', vcf('p1', ['FN:Peter Pan', 'N:Pan;Peter;;;', 'TEL;TYPE=CELL:0170 2000002', 'BDAY:1990-05-01', 'ORG:Nimmerland', 'PHOTO;ENCODING=b;TYPE=JPEG:' + JPEG]));
  dav.put(gmx, 'w1.vcf', vcf('w1', ['FN:Wendy Darling', 'N:Darling;Wendy;;;', 'EMAIL:wendy@example.com', 'TEL;TYPE=WORK:030 123456']));
  dav.put(phone, 'z1.vcf', vcf('z1', ['FN:Schatzimausi 💞', 'N:;Schatzimausi 💞;;;', 'TEL;TYPE=CELL:+49 171 1000001', 'ADR;TYPE=HOME:;;Hauptstr. 1;Berlin;;10115;']));
  await withMail({ gatecontrol: '1.219.0', dav }, async (host, c) => {
    // as before 1.4.0: no run yet
    const tick = cardmerge.tick;
    cardmerge.tick = async () => 0;
    await c.addGmx(ANNA);
    const anna = c.as(ANNA);
    await anna('GET', 'addressbooks');
    await syncs(host, 10);
    const before = (await anna('GET', 'cards')).json;
    const ids = new Map(before.items.map((x) => [x.name, x.id]));
    assert.equal(ids.size, 4, JSON.stringify([...ids.keys()]));
    const peter = (await anna('POST', 'cards', { name: { given: 'Peter' }, phones: [{ value: '+49 170 2000002', type: 'mobile' }], note: 'Kindergarten' })).json.card;
    const wendy = (await anna('POST', 'cards', { name: { given: 'Wendy', family: 'Darling' }, emails: [{ value: 'wendy@example.com' }] })).json.card;
    // a link of 1.3: the account card the main one, the GC card linked to it
    await c.db('UPDATE cards SET link_id = ? WHERE id = ?', [ids.get('Wendy Darling'), wendy.id]);
    assert.deepEqual((await anna('GET', `cards/${ids.get('Wendy Darling')}`)).json.linked.map((l) => l.id), [wendy.id]);
    cardmerge.tick = tick;
    await syncs(host, 2);
    // the protocol
    const merges = (await anna('GET', 'cards/merges')).json.items;
    assert.deepEqual(merges.map((m) => [m.mode, m.created, m.cards.map((x) => x.name).sort()]).sort(), [['auto', false, ['Peter', 'Peter Pan']], ['migrated', false, ['Wendy Darling', 'Wendy Darling']]]);
    assert.ok(host.logs.some((l) => /contacts merged/.test(l.message) && /"merged":1/.test(l.message) && /"migrated":1/.test(l.message)), JSON.stringify(host.logs.slice(-5)));
    // Peter: the GC card stays, the most complete name, the account card's birthday, company and picture
    const p = (await anna('GET', `cards/${peter.id}`)).json;
    assert.deepEqual([p.name.display, p.phones.map((x) => x.value), p.birthday, p.company, p.note, !!p.photo, p.sources.map((s) => [s.source, s.addressbook, s.account])],
      ['Peter Pan', ['+49 170 2000002'], '1990-05-01', 'Nimmerland', 'Kindergarten', true, [['local', 'Meine Kontakte', null], ['carddav', 'GMX-Kontakte', 'anna@gmx.de']]]);
    // Wendy: now the GC card is the contact, with the number of the account card
    const w = (await anna('GET', `cards/${wendy.id}`)).json;
    assert.deepEqual([w.masterId, w.linked.map((l) => l.id), w.phones.map((x) => x.value)], [null, [ids.get('Wendy Darling')], ['030 123456']]);
    assert.equal((await anna('GET', `cards/${ids.get('Wendy Darling')}`)).json.masterId, wendy.id);
    // the list: the GC contacts and the rest, the linked account cards not on their own
    const list = (await anna('GET', 'cards')).json.items;
    assert.deepEqual(list.map((x) => x.name).sort(), ['Peter Pan', 'Sabrina Martin', 'Schatzimausi 💞', 'Wendy Darling']);
    // the apps' offline copy: a card linked since then is gone from the list of all contacts
    const since = (await anna('GET', 'cards', null, { since: String(before.version) })).json;
    assert.ok(since.deleted.includes(ids.get('Peter Pan')) && since.deleted.includes(ids.get('Wendy Darling')), JSON.stringify(since.deleted));
    assert.ok(since.items.some((x) => x.id === peter.id));
    // the uncertain one: the same number, names that do not look alike — with where each comes from and a preview
    const d = (await anna('GET', 'cards/duplicates', null, { details: '1' })).json.items;
    assert.equal(d.length, 1);
    assert.deepEqual([d[0].reason, d[0].certain, d[0].details.map((x) => [x.source.addressbook, x.source.account, x.card.phones.length, x.card.addresses.length]).sort()],
      ['phone', false, [['GMX-Kontakte', 'anna@gmx.de', 1, 0], ['OnePlus 10 Pro 5G', 'anna@gmx.de', 1, 1]]]);
    const pv = d[0].preview;
    assert.deepEqual([pv.id, pv.name.display, pv.phones.length, pv.emails.map((e) => e.value), pv.addresses.map((a) => a.city), pv.sources.length], [null, 'Schatzimausi 💞', 1, ['sabrina@example.com'], ['Berlin'], 2]);
    // confirmed: a new GC contact, both linked, nothing deleted at the provider
    const m = await anna('POST', 'cards/merge', { ids: d[0].cards.map((x) => x.id) });
    assert.equal(m.status, 200, JSON.stringify(m.json));
    assert.deepEqual([m.json.card.source, m.json.card.name.display, m.json.card.sources.map((s) => s.source)], ['local', 'Schatzimausi 💞', ['local', 'carddav', 'carddav']]);
    assert.deepEqual([dav.cols.get(gmx).objects.size, dav.cols.get(phone).objects.size], [3, 1]);
    assert.deepEqual((await anna('GET', 'cards/duplicates')).json.items, []);
    assert.deepEqual((await anna('GET', 'cards')).json.items.map((x) => x.name).sort(), ['Peter Pan', 'Schatzimausi 💞', 'Wendy Darling']);
    // undone: the GC contact made by it goes, both come back on their own and stay apart (also after a sync)
    const u = await anna('POST', `cards/merges/${m.json.mergeId}/undo`, {});
    assert.equal(u.status, 200, JSON.stringify(u.json));
    assert.deepEqual([u.json.card, u.json.unlinked.length], [null, 2]);
    assert.equal((await anna('GET', `cards/${m.json.card.id}`)).status, 404);
    await syncs(host, 2);
    assert.deepEqual((await anna('GET', 'cards')).json.items.map((x) => x.name).sort(), ['Peter Pan', 'Sabrina Martin', 'Schatzimausi 💞', 'Wendy Darling']);
    assert.deepEqual((await anna('GET', 'cards/duplicates')).json.items, []);
    // the automatic one undone: the GC card stays (it was there before), the account card is on its own again
    const auto = merges.find((x) => x.mode === 'auto');
    const u2 = (await anna('POST', `cards/merges/${auto.id}/undo`, {})).json;
    assert.deepEqual([u2.card.id, u2.unlinked.length, u2.card.linked], [peter.id, 1, []]);
    assert.equal((await anna('GET', 'cards')).json.items.length, 5);
    assert.equal((await anna('GET', 'cards/merges')).json.items.filter((x) => x.undoneAt).length, 2);
  });
});

test('conflicts: another value of the same kind is shown, not written; dismissed stays away until the provider changes it; taken over replaces; a value taken over goes back to its card; favourites and the main number; deleting keeps the account card', async () => {
  const dav = new FakeDav({ user: 'anna@gmx.de', pass: 'geheim-123' });
  const gmx = dav.book('k', { name: 'GMX-Kontakte' });
  const card = (lines) => vcf('a1', ['FN:Anna Lang', 'N:Lang;Anna;;;', 'EMAIL:anna.lang@example.com', ...lines]);
  const { href } = dav.put(gmx, 'a1.vcf', card(['TEL;TYPE=CELL:0170 1111111', 'ORG:Firma A']));
  const change = (lines) => { const col = dav.cols.get(gmx); dav.remove(gmx, href); col.objects.set(href, { data: card(lines), etag: `"x${col.token}"` }); col.token++; col.ctag++; col.log.push({ token: col.token, path: href, gone: false }); };
  await withMail({ gatecontrol: '1.219.0', dav }, async (host, c) => {
    await c.addGmx(ANNA);
    const anna = c.as(ANNA);
    await anna('GET', 'addressbooks');
    const own = (await anna('POST', 'cards', { name: { given: 'Anna', family: 'Lang' }, emails: [{ value: 'anna.lang@example.com' }], phones: [{ value: '0170 9999999', type: 'mobile' }], company: 'Firma B' })).json.card;
    await syncs(host, 10);
    // certain (the same address and name): merged after the sync; both mobile numbers, the GC card's company, the other one a conflict
    let a = (await anna('GET', `cards/${own.id}`)).json;
    assert.deepEqual([a.linked.length, a.phones.map((x) => x.value), a.company], [1, ['0170 9999999', '0170 1111111'], 'Firma B']);
    assert.deepEqual(a.conflicts.map((x) => [x.field, x.value, x.replaces, x.source.addressbook]), [['company', 'Firma A', 'Firma B', 'GMX-Kontakte']]);
    assert.equal((await anna('GET', 'cards')).json.items.find((x) => x.id === own.id).conflicts, 1);
    assert.deepEqual((await anna('GET', 'cards/conflicts')).json.items.map((x) => [x.card.id, x.conflicts.length]), [[own.id, 1]]);
    // dismissed: stays away, also after the next sync
    a = (await anna('POST', `cards/${own.id}/conflicts/${a.conflicts[0].id}/dismiss`)).json.card;
    assert.deepEqual(a.conflicts, []);
    change(['TEL;TYPE=CELL:0170 1111111', 'ORG:Firma A', 'NOTE:neu']);
    await syncs(host, 4);
    a = (await anna('GET', `cards/${own.id}`)).json;
    assert.deepEqual([a.conflicts, a.company, a.note], [[], 'Firma B', 'neu']);
    // the provider changes it: a conflict again; the mobile number changes there too: a conflict replacing the one taken over from it
    change(['TEL;TYPE=CELL:0170 2222222', 'ORG:Firma C', 'NOTE:neu']);
    await syncs(host, 4);
    a = (await anna('GET', `cards/${own.id}`)).json;
    assert.deepEqual(a.conflicts.map((x) => [x.field, x.field === 'phones' ? x.value.value : x.value, x.replaces && (x.replaces.value || x.replaces)]).sort(),
      [['company', 'Firma C', 'Firma B'], ['phones', '0170 2222222', '0170 1111111']]);
    assert.deepEqual(a.phones.map((x) => x.value), ['0170 9999999', '0170 1111111'], 'nothing overwritten without asking');
    const ph = a.conflicts.find((x) => x.field === 'phones');
    a = (await anna('POST', `cards/${own.id}/conflicts/${ph.id}/accept`, {})).json.card;
    assert.deepEqual([a.phones.map((x) => x.value), a.conflicts.map((x) => x.field)], [['0170 9999999', '0170 2222222'], ['company']]);
    const davBefore = dav.requests.filter((r) => r.method === 'PUT').length;
    // the person changes the number taken over from GMX: it goes back to that card at GMX
    const p = await anna('PATCH', `cards/${own.id}`, { phones: [{ value: '0170 9999999', type: 'mobile' }, { value: '0170 2222223', type: 'mobile' }], etag: a.etag });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.deepEqual(p.json.writeBack.map((x) => x.ok), [true]);
    assert.equal(dav.requests.filter((r) => r.method === 'PUT').length, davBefore + 1);
    assert.match(dav.cols.get(gmx).objects.get(href).data, /0170 2222223/);
    assert.doesNotMatch(dav.cols.get(gmx).objects.get(href).data, /0170 2222222/);
    // a number of the GC card only: nothing to GMX
    const p2 = await anna('PATCH', `cards/${own.id}`, { phones: [{ value: '0170 9999990', type: 'mobile' }, { value: '0170 2222223', type: 'mobile' }] });
    assert.deepEqual([p2.json.writeBack, dav.requests.filter((r) => r.method === 'PUT').length], [[], davBefore + 1]);
    // favourites and the main number (GateControl's own; also on a read-only card)
    assert.equal((await anna('PATCH', `cards/${own.id}`, { mainPhone: '030 0000' })).json.error.code, 'invalid');
    const f = (await anna('PATCH', `cards/${own.id}`, { favorite: true, mainPhone: '+49 170 2222223' })).json.card;
    assert.deepEqual([f.favorite, f.mainPhone, f.mainPhoneChosen], [true, { value: '0170 2222223', type: 'mobile' }, true]);
    assert.equal(dav.requests.filter((r) => r.method === 'PUT').length, davBefore + 1, 'never to the provider');
    const other = (await anna('POST', 'cards', { name: { given: 'Bert' }, phones: [{ value: '0151 1', type: 'work' }] })).json.card;
    await anna('PATCH', `cards/${other.id}`, { favorite: true });
    let fav = (await anna('GET', 'cards/favorites')).json.items;
    assert.deepEqual(fav.map((x) => [x.name, x.phone && x.phone.value]), [['Anna Lang', '0170 2222223'], ['Bert', '0151 1']]);
    fav = (await anna('PUT', 'cards/favorites', { ids: [other.id, own.id] })).json.items;
    assert.deepEqual(fav.map((x) => x.id), [other.id, own.id]);
    assert.deepEqual((await anna('GET', 'cards')).json.items.find((x) => x.id === own.id).phone, '0170 2222223', 'the list shows the main number');
    await anna('PATCH', `cards/${other.id}`, { favorite: false });
    assert.deepEqual((await anna('GET', 'cards/favorites')).json.items.map((x) => x.id), [own.id]);
    // deleting the GC contact: the account card stays (at GMX and here), on its own
    const linked = a.linked[0].id;
    assert.equal((await anna('DELETE', `cards/${own.id}`)).status, 200);
    assert.equal(dav.cols.get(gmx).objects.size, 1);
    assert.equal((await anna('GET', `cards/${linked}`)).json.masterId, null);
    assert.ok((await anna('GET', 'cards')).json.items.some((x) => x.id === linked));
  });
});

test('the calendar widget: today and tomorrow, all-day first, running ones, birthdays; without cancelled, declined and ended ones', () => withMail({ gatecontrol: '1.219.0' }, async (host, c) => {
  const anna = c.as(ANNA);
  const cals = (await anna('GET', 'calendars')).json;
  const zone = cals.prefs.timeZone;
  const priv = cals.calendars.find((x) => x.kind === 'private');
  const now = Date.now();
  const today = tz.localDate(now, zone);
  const tomorrow = tz.addDays(today, 1);
  const mk = async (b) => { const r = await anna('POST', 'events', { calendarId: priv.id, timeZone: zone, ...b }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.event; };
  await mk({ title: 'Läuft', allDay: false, start: now - 10 * 60000, end: now + 10 * 60000 });
  await mk({ title: 'Vorbei', allDay: false, start: now - 3 * 3600000, end: now - 2 * 3600000 });
  await mk({ title: 'Urlaub', allDay: true, startDate: today, endDate: today });
  await mk({ title: 'Morgen', allDay: false, start: tz.at(tomorrow, { hh: 12, mm: 0 }, zone), end: tz.at(tomorrow, { hh: 13, mm: 0 }, zone) });
  const no = await mk({ title: 'Abgelehnt', allDay: false, start: tz.at(tomorrow, { hh: 9, mm: 0 }, zone), end: tz.at(tomorrow, { hh: 10, mm: 0 }, zone) });
  const off = await mk({ title: 'Abgesagt', allDay: false, start: tz.at(tomorrow, { hh: 10, mm: 0 }, zone), end: tz.at(tomorrow, { hh: 11, mm: 0 }, zone) });
  await c.db("UPDATE events SET my_response = 'declined' WHERE id = ?", [no.eventId]);
  await c.db("UPDATE events SET status = 'cancelled' WHERE id = ?", [off.eventId]);
  await anna('POST', 'cards', { name: { given: 'Clara', family: 'Geburtstag' }, birthday: `--${tomorrow.slice(5)}` });
  const w = (await anna('GET', 'events/upcoming')).json;
  assert.deepEqual([w.timeZone, w.today], [zone, today]);
  assert.deepEqual(w.items.map((x) => [x.title, x.day, x.allDay]), [['Urlaub', today, true], ['Läuft', today, false], ['Clara Geburtstag', tomorrow, true], ['Morgen', tomorrow, false]]);
  assert.deepEqual([w.items[0].color, w.items[2].overlayId, w.items[2].eventId, w.more], [priv.color, 'birthdays', null, 0]);
  const one = (await anna('GET', 'events/upcoming', null, { days: '1', limit: '1' })).json;
  assert.deepEqual([one.items.map((x) => x.title), one.more], [['Urlaub'], 1]);
  await settle(10);
}));
