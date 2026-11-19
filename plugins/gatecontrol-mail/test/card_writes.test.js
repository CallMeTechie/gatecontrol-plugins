'use strict';

// Mail 1.17.1: der Abgleich der Kontakte schrieb unveränderte Kontakte neu. Eine neue ETag (der Server serialisiert
// neu, stempelt REV, faltet das Foto anders), ein Graph-Delta von vorn (nach 410) oder eine neue changeKey desselben
// Inhalts: jede Karte ging ganz durch cardstore.storeCard — Zeile, Adressen, Nummern, Foto, eine neue Version für
// GET cards?since= und das Live-Ereignis an die Apps. Jetzt: derselbe Inhalt (Felder in jeder Reihenfolge, die vCard
// ohne REV/PRODID, dasselbe Foto) schreibt höchstens die neue ETag — keine Version, kein Ereignis.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, ANNA } = require('./helpers');
const { FakeDav, vcf } = require('./pim-helpers');
const pim = require('../server/pim');
const cardstore = require('../server/cardstore');
const pimstore = require('../server/pimstore');
const store = require('../server/store');

async function syncAll(host, n = 6) {
  for (let i = 0; i < n; i++) {
    for (const x of [...Array(50).keys()].map((k) => pim.lineOf(k))) { x.retryAt = 0; x.pause = 0; for (const k of Object.keys(x.last)) if (k !== 'calList' && k !== 'bookList') x.last[k] = 0; }
    await host.tick();
    await settle(20);
  }
}

// the writes that rewrite a card (cards, its addresses, numbers, photo, the version counter, tombstones)
const CARD_SQL = /\b(cards|card_emails|card_phones|card_photos|card_versions|card_tombstones)\b/;

/** Count the statements on the card tables (every write of the plugin goes through store.run). */
function countWrites(t) {
  const seen = [];
  const orig = store.run;
  t.mock.method(store, 'run', (gc, sql, params) => { if (CARD_SQL.test(sql)) seen.push(String(sql).replace(/\s+/g, ' ').slice(0, 60)); return orig(gc, sql, params); });
  return seen;
}

const PHOTO = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL';

test('CardDAV: dieselben Kontakte unter neuer ETag (REV, PRODID, gefaltetes Foto) schreiben nichts neu, ein geänderter schon', async (t) => {
  const dav = new FakeDav({ user: 'anna@gmx.de', pass: 'geheim-123' });
  const book = dav.book('kontakte', { name: 'Adressbuch' });
  const cards = {
    p1: ['FN:Peter Pan', 'N:Pan;Peter;;;', 'EMAIL;TYPE=INTERNET:peter@example.com', 'TEL;TYPE=CELL:+49 151 00000000', `PHOTO;ENCODING=b;TYPE=JPEG:${PHOTO}`],
    p2: ['FN:Wendy Darling', 'N:Darling;Wendy;;;', 'EMAIL;TYPE=INTERNET:wendy@example.com', 'ORG:Nimmerland GmbH'],
    p3: ['FN:John Darling', 'N:Darling;John;;;', 'TEL;TYPE=HOME:+49 151 00000000'],
  };
  for (const [uid, lines] of Object.entries(cards)) dav.put(book, `${uid}.vcf`, vcf(uid, ['PRODID:-//Server//1.0//EN', 'REV:20261001T080000Z', ...lines]));
  await withMail({ gatecontrol: '1.219.0', dav }, async (host, c) => {
    await c.addGmx(ANNA);
    const anna = c.as(ANNA);
    await anna('GET', 'addressbooks');
    await syncAll(host);
    const remote = (await anna('GET', 'addressbooks')).json.items.find((b) => b.source === 'carddav');
    assert.equal(remote.count, 3);
    const before = (await host.gc.db.query('SELECT id, uid, version, etag, updated_at FROM cards ORDER BY uid')).rows;
    const version = await pimstore.cardVersion(host.gc, ANNA.id);
    // the server writes every card anew: a new ETag, REV and PRODID stamped, the photo folded at 40 characters,
    // lines in another order — the same contacts. One of them really changes.
    const fold = (s) => s.match(/.{1,40}/g).join('\r\n ');
    for (const [uid, lines] of Object.entries(cards)) {
      const now = lines.map((l) => (l.startsWith('PHOTO') ? fold(l) : l)).reverse();
      if (uid === 'p3') now.push('ORG:Piratenschiff');
      dav.put(book, `${uid}.vcf`, vcf(uid, ['PRODID:-//Server//2.0//EN', 'REV:20261119T120000Z', ...now]));
    }
    const writes = countWrites(t);
    const mark = host.events.length;
    await syncAll(host, 2);
    const after = (await host.gc.db.query('SELECT id, uid, version, etag, updated_at FROM cards ORDER BY uid')).rows;
    const by = (rows, uid) => rows.find((r) => r.uid === uid);
    for (const uid of ['p1', 'p2']) {
      assert.equal(by(after, uid).version, by(before, uid).version, `${uid}: no new version`);
      assert.equal(by(after, uid).updated_at, by(before, uid).updated_at, `${uid}: not rewritten`);
      assert.notEqual(by(after, uid).etag, by(before, uid).etag, `${uid}: the new ETag is kept (no fetching it again)`);
    }
    assert.ok(by(after, 'p3').version > by(before, 'p3').version, 'the changed card has a new version');
    assert.equal(await pimstore.cardVersion(host.gc, ANNA.id), version + 1, 'one new version: the changed card');
    // the unchanged cards: one ETag update each, nothing else; the changed one: the full write
    const etagOnly = writes.filter((w) => /^UPDATE cards SET etag = \?, change_key/.test(w));
    assert.equal(etagOnly.length, 2, JSON.stringify(writes));
    assert.ok(!writes.some((w) => /card_photos/.test(w)), `the photo is not written again: ${JSON.stringify(writes)}`);
    const full = writes.filter((w) => !/^UPDATE cards SET etag = \?, change_key/.test(w));
    assert.ok(full.length > 0 && full.length <= 8, JSON.stringify(full));
    // the apps hear of the changed card only
    const ev = host.events.slice(mark).filter((e) => e.type === 'contacts' && e.data.kind === 'changed');
    assert.deepEqual(ev.map((e) => e.data.contactIds), [[by(after, 'p3').id]]);
    // nothing new at all: no write, no event
    for (const uid of ['p1', 'p2']) dav.put(book, `${uid}.vcf`, dav.cols.get(book).objects.get(`${book}${uid}.vcf`).data);
    writes.length = 0;
    const mark2 = host.events.length;
    await syncAll(host, 2);
    assert.equal(writes.filter((w) => !/^UPDATE cards SET etag = \?, change_key/.test(w)).length, 0, JSON.stringify(writes));
    assert.deepEqual(host.events.slice(mark2).filter((e) => e.type === 'contacts'), []);
  });
});

test('storeCard (Microsoft: Delta von vorn, neue changeKey): dieselben Felder in anderer Reihenfolge und dasselbe Foto schreiben nur die changeKey', (t) => withMail({}, async (host, c) => {
  const gc = host.gc;
  await c.as(ANNA)('GET', 'addressbooks');
  const book = (await gc.db.get("SELECT * FROM addressbooks WHERE user_id = ? AND source = 'local'", [ANNA.id])).row;
  const fields = { uid: 'graph:1', name: { display: 'Peter Pan', given: 'Peter', family: 'Pan' }, emails: [{ value: 'peter@example.com', type: 'work' }],
    phones: [{ value: '+49 151 00000000', type: 'cell' }], company: 'Nimmerland GmbH' };
  const photo = { mime: 'image/jpeg', data: PHOTO };
  const first = await cardstore.storeCard(gc, book, { uid: 'graph:1', fields, vcard: null, remoteId: 'AAA1', changeKey: 'ck1', photo });
  assert.equal(first.created, true);
  const writes = countWrites(t);
  // the same contact again (keys in another order, the photo with line breaks, a new changeKey)
  const again = { company: 'Nimmerland GmbH', phones: [{ type: 'cell', value: '+49 151 00000000' }], emails: [{ type: 'work', value: 'peter@example.com' }],
    name: { family: 'Pan', given: 'Peter', display: 'Peter Pan' }, uid: 'graph:1' };
  const r = await cardstore.storeCard(gc, book, { id: first.id, uid: 'graph:1', fields: again, vcard: null, remoteId: 'AAA1', changeKey: 'ck2', photo: { mime: 'image/jpeg', data: PHOTO.match(/.{1,30}/g).join('\n') } });
  assert.equal(r.unchanged, true);
  assert.equal(r.version, first.version);
  assert.deepEqual(writes, ['UPDATE cards SET etag = ?, change_key = ?, href = ?, remote_']);
  // the same changeKey, the photo kept (undefined): nothing at all
  writes.length = 0;
  assert.equal((await cardstore.storeCard(gc, book, { id: first.id, uid: 'graph:1', fields: again, vcard: null, remoteId: 'AAA1', changeKey: 'ck2' })).unchanged, true);
  assert.deepEqual(writes, []);
  // a real change: written, a new version
  const changed = await cardstore.storeCard(gc, book, { id: first.id, uid: 'graph:1', fields: { ...again, company: 'Piratenschiff' }, vcard: null, remoteId: 'AAA1', changeKey: 'ck3' });
  assert.ok(!changed.unchanged);
  assert.ok(changed.version > first.version);
  assert.equal(changed.company, 'Piratenschiff');
  // the photo removed: a change too
  const nophoto = await cardstore.storeCard(gc, book, { id: first.id, uid: 'graph:1', fields: { ...again, company: 'Piratenschiff' }, vcard: null, remoteId: 'AAA1', changeKey: 'ck4', photo: null });
  assert.ok(!nophoto.unchanged);
  assert.equal(nophoto.photo_etag, null);
}));
