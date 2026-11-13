'use strict';

// Mail 1.14.0: die Suche über einen Volltextindex (server/search.js) statt `LIKE '%…%'` über alle Mails und alle Texte —
// eine Option, die der Administrator einschaltet (hier: eingeschaltet; aus, ein/aus im Betrieb: search-switch.test.js).
//   * FTS5 mit dem Tokenizer `trigram`: gefunden wird wie bisher an jeder Stelle eines Felds, auch mitten im Wort;
//     Groß/Klein jetzt auch bei Umlauten egal. Die Eingabe ist EIN Stück Text — kein Zeichen davon ist Suchsyntax.
//   * Trigger halten den Index: neue Mail, ihr Text, geänderter Anriss, gelöschte Mail, verdrängter Text.
//   * Mails, die beim Einschalten schon da sind, kommen im Hintergrund in Häppchen hinein (neueste zuerst, eine Transaktion je Häppchen,
//     messages.fts ist der Fortschritt). Bis dahin — und für den Rest sehr langer Texte — sucht GET search dort wie
//     bisher: das Ergebnis ist jederzeit vollständig. Ein Abbruch mitten im Häppchen lässt nichts halb zurück.
//   * Kann die Datenbank keinen solchen Index, bleibt alles wie in 1.13.
//   * Weniger als drei Zeichen: Betreff, Absender, Empfänger, Anriss — nicht mehr die Texte.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withMail, ANNA, MARC } = require('./helpers');
const cost = require('../../../tools/testing/sql-cost');
const search = require('../server/search');

/** The administrator switches the full-text search on (Einstellungen › „Volltextsuche“; it is off unless chosen). */
async function switchOn(c) {
  const r = await c.admin('PUT', 'admin/settings', { search: { fulltext: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.search;
}

/** What the search of 1.13 found for `term` (LIKE over the fields and the text), newest first → ids. */
async function likeIds(db, accountIds, term) {
  const l = `%${term.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
  const r = await db.query(`SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id LEFT JOIN bodies b ON b.message_id = m.id
    WHERE m.account_id IN (${accountIds.map(() => '?').join(',')}) AND f.role IS NOT 'trash' AND f.role IS NOT 'junk'
      AND (m.subject LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\' OR m.from_email LIKE ? ESCAPE '\\' OR m.snippet LIKE ? ESCAPE '\\' OR b.text LIKE ? ESCAPE '\\' OR m.to_json LIKE ? ESCAPE '\\')
    ORDER BY m.date DESC, m.id DESC LIMIT 50`, [...accountIds, l, l, l, l, l, l]);
  return r.rows.map((x) => x.id);
}

/** A mail straight into the database (as a sync writes it) → its id. o: { subject, text, from, fromName, to, snippet, date, folder } */
async function put(db, f, o) {
  const r = await db.run(`INSERT INTO messages (user_id, account_id, folder_id, uid, date, from_name, from_email, to_json, subject, snippet, tab, body_state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'relevant', ?, ?)`, [f.user_id, f.account_id, f.id, put.uid++, o.date || Date.now() - put.uid * 1000, o.fromName || 'Tim', o.from || 'tim@example.com',
    JSON.stringify([{ name: '', email: o.to || 'anna@gmx.de' }]), o.subject || '', o.snippet || '', o.text == null ? 'none' : 'stored', Date.now()]);
  const id = Number(r.lastInsertRowid);
  if (o.text != null) await db.run('INSERT INTO bodies (message_id, html, text, bytes, at, used_at) VALUES (?, ?, ?, ?, ?, ?)', [id, `<p>${o.text}</p>`, o.text, o.text.length, Date.now(), Date.now()]);
  return id;
}
put.uid = 5000;

const folderOf = async (c, role = 'inbox', email = 'anna@gmx.de') => (await c.db('SELECT f.id, f.account_id, a.user_id FROM folders f JOIN accounts a ON a.id = f.account_id WHERE f.role = ? AND a.email = ?', [role, email]))[0];
const find = async (c, q, extra, user = ANNA) => { const r = await c.as(user)('GET', 'search', null, { q, ...(extra || {}) }); assert.equal(r.status, 200, `${q}: ${JSON.stringify(r.json)}`); return r.json; };
const ids = (res) => res.items.map((m) => m.id);
const ftsCount = async (c, phrase) => (await c.db(`SELECT COUNT(*) AS n FROM ${search.MATCH_ALL}`, search.matchArgs(`"${phrase}"`)))[0].n;

test('Suche über den Index: Betreff, Absender, Empfänger, Anriss und Text; mitten im Wort; Groß/Klein auch bei Umlauten; nur die eigenen Mails, nicht Papierkorb und Spam', () => withMail({}, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { name: 'Stadtwerke Musterstadt', address: 'service@stadtwerke.example' }, subject: 'Ihre Stromrechnung für Oktober', text: 'Sehr geehrte Frau Müller, die Überweisung über 84,20 € buchen wir am 28.11. ab. Zählerstand: 4711.' });
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { name: 'Oma Erna', address: 'erna@example.com' }, subject: 'Kaffee am Sonntag?', text: 'Kommt ihr zum Apfelkuchen in die Gartenstraße?', to: [{ name: 'Anna', address: 'anna@gmx.de' }, { name: 'Jörg', address: 'joerg.schmidt@example.org' }] });
  c.mail.mail('anna@gmx.de', 'Papierkorb', { subject: 'Stromrechnung alt', text: 'gelöscht' });
  c.mail.mail('anna@gmx.de', 'Spam', { subject: 'Stromrechnung gewinnen', text: 'Werbung' });
  await switchOn(c);
  await c.addGmx(ANNA);
  await c.addGmx(MARC);
  for (let i = 0; i < 3; i++) await c.tick();
  const f = await folderOf(c, 'inbox', 'marc@gmx.de');
  await put(host.gc.db, f, { subject: 'Stromrechnung von Marc', text: 'nicht für Anna' });
  const strom = ['Ihre Stromrechnung für Oktober'];
  const subj = async (q, extra) => (await find(c, q, extra)).items.map((m) => m.subject);
  assert.equal((await find(c, 'Strom')).index.state, 'ready');
  assert.deepEqual(await subj('Stromrechnung'), strom, 'the subject — not the trash, not spam, not Marc\'s mail');
  assert.deepEqual(await subj('rechnung'), strom, 'the middle of a word, as LIKE found it');
  assert.deepEqual(await subj('STROMRECHNUNG'), strom);
  assert.deepEqual(await subj('stadtwerke.example'), strom, 'the sender\'s address');
  assert.deepEqual(await subj('werke Muster'), strom, 'the sender\'s name, across a blank');
  assert.deepEqual(await subj('Zählerstand: 4711'), strom, 'the text, with punctuation');
  assert.deepEqual(await subj('84,20 €'), strom);
  assert.deepEqual(await subj('überweisung'), strom, 'lower case finds the capital Ü');
  assert.deepEqual(await subj('ÜBERWEISUNG'), strom, 'and upper case the mixed one (LIKE knew this for a–z only)');
  assert.deepEqual(await subj('MÜLLER'), strom);
  assert.deepEqual(await subj('joerg.schmidt'), ['Kaffee am Sonntag?'], 'a recipient');
  assert.deepEqual(await subj('gartenstraße'), ['Kaffee am Sonntag?']);
  assert.deepEqual(await subj('Apfelkuchen in die'), ['Kaffee am Sonntag?'], 'several words: one piece of text');
  assert.deepEqual(await subj('Apfelkuchen Sonntag'), [], 'not two words from different places (as before)');
  assert.deepEqual(await subj('gibtesnicht'), []);
  // Marc finds his own
  assert.deepEqual((await find(c, 'Stromrechnung', null, MARC)).items.map((m) => m.subject), ['Stromrechnung von Marc']);
}));

test('Sonderzeichen in der Eingabe sind Text, nie Suchsyntax: Anführungszeichen, Sterne, Klammern, AND/OR/NOT, %, _, \\ — kein Fehler, dasselbe Ergebnis wie mit LIKE', () => withMail({}, async (host, c) => {
  await switchOn(c);
  const acc = await c.addGmx(ANNA);
  await c.tick();
  const db = host.gc.db;
  const f = await folderOf(c);
  const texts = [
    'Er sagte "Hallo Welt" und ging', "O'Brien's Pub um 8", 'Rabatt 50% auf alles', 'Rabatt 500 Euro', 'datei_name_v2.txt', 'dateiXnameXv2.txt', 'C:\\Users\\anna\\Dokumente',
    'Preis (netto) * 1,19 = brutto', 'foo AND bar OR baz NOT qux', 'NEAR(eins zwei, 3)', 'subject:geheim ^start', 'a-b-c -minus +plus', 'Smiley 😀 und Herz ❤ dabei', 'tab\there', 'quote""double', '{x} [y] <z> |pipe| ~tilde~',
  ];
  for (const t of texts) await put(db, f, { subject: `Nr ${texts.indexOf(t)}`, text: t });
  const terms = ['"Hallo Welt"', '"', '""', "O'Brien's", '50%', '50% auf', 'datei_name', '_name_', 'C:\\Users', '\\anna\\', '(netto) *', '* 1,19 =', 'AND bar OR', 'NOT qux', 'NOT', 'OR', 'NEAR(eins', 'NEAR(', 'subject:geheim', '^start', 'a-b-c', '-minus', '+plus',
    '😀 und', '❤', 'tab here', '""double', '{x} [y]', '<z> |pipe|', '~tilde~', '***', '(((', 'AND AND AND', '"unbalanced', 'x" OR "y', "'; DROP TABLE messages; --", '%%%', '___', 'foo AND bar OR baz NOT qux'];
  for (const q of terms) {
    const res = await find(c, q);
    // the same mails as LIKE finds (from three characters on — shorter: the fields only, see below)
    if ([...q].length >= 3) assert.deepEqual(ids(res), await likeIds(db, [acc.id], q), `„${q}“`);
  }
  // literally: 50% is not 500, _ is not any character
  assert.deepEqual((await find(c, '50%')).items.map((m) => m.subject), ['Nr 2']);
  assert.deepEqual((await find(c, 'datei_name')).items.map((m) => m.subject), ['Nr 4']);
  assert.deepEqual((await find(c, 'AND bar OR')).items.map((m) => m.subject), ['Nr 8']);
  assert.deepEqual((await find(c, '"Hallo Welt"')).items.map((m) => m.subject), ['Nr 0']);
  assert.equal((await c.db('SELECT COUNT(*) AS n FROM messages'))[0].n, texts.length, 'nothing dropped');
  assert.equal(search.matchOf('a"b c'), '"a""b c"');
  assert.equal(search.matchOf('ab'), null);
  assert.equal(search.matchOf('😀😀'), null, 'two characters, whatever their length in UTF-16');
  assert.equal(search.matchOf('😀😀😀'), '"😀😀😀"');
}));

test('der Index folgt den Mails: Text kommt später, Anriss ändert sich, Text wird verdrängt, Mail wird gelöscht — über die Schreibwege des Plugins', () => withMail({}, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  // the word far behind what the snippet of the list keeps
  for (let i = 0; i < 3; i++) c.mail.mail('anna@gmx.de', 'INBOX', { subject: `Rundbrief ${i}`, text: `${'Inhalt ohne Belang. '.repeat(30)} Kennwort Zebrafink${i} am Ende` });
  await switchOn(c);
  await c.addGmx(ANNA);
  await c.tick();
  const mailstore = require('../server/mailstore');
  const rows = await c.db("SELECT id, uid, subject, fts, body_state FROM messages WHERE subject LIKE 'Rundbrief %' ORDER BY subject");
  assert.ok(rows.every((r) => r.fts === 1 && r.body_state === 'stored'), 'in the index with their text');
  assert.deepEqual((await find(c, 'Zebrafink1')).items.map((m) => m.subject), ['Rundbrief 1']);
  assert.equal(await ftsCount(c, 'Zebrafink'), 3);
  // a new text for a mail (loaded again)
  await mailstore.setBody(host.gc, rows[1].id, { html: null, text: 'Jetzt steht hier Paradiesvogel', images: [], trackers: 0 }, Date.now());
  assert.deepEqual(ids(await find(c, 'Zebrafink1')), []);
  assert.deepEqual(ids(await find(c, 'paradiesvogel')), [rows[1].id]);
  // the quota takes the text away (mailstore.evict deletes the row of bodies): found by the subject, no longer by the text — as with LIKE
  await host.gc.db.run('DELETE FROM bodies WHERE message_id = ?', [rows[2].id]);
  assert.deepEqual(ids(await find(c, 'Zebrafink2')), []);
  assert.deepEqual(ids(await find(c, 'Rundbrief 2')), [rows[2].id]);
  assert.equal((await c.db('SELECT fts FROM messages WHERE id = ?', [rows[2].id]))[0].fts, 1);
  // the mail goes (on the server too — else the search beyond the copy here would bring it back)
  c.mail.box('anna@gmx.de', 'INBOX').msgs.delete(rows[0].uid);
  await mailstore.remove(host.gc, [rows[0].id]);
  assert.deepEqual(ids(await find(c, 'Zebrafink0')), []);
  assert.deepEqual(ids(await find(c, 'Rundbrief 0')), []);
  assert.equal(await ftsCount(c, 'Rundbrief'), 2, 'gone from the index too');
  // the subject changes (a write that names the column)
  await host.gc.db.run('UPDATE messages SET subject = ? WHERE id = ?', ['Umbenannt Kolibri', rows[1].id]);
  assert.deepEqual(ids(await find(c, 'kolibri')), [rows[1].id]);
  assert.deepEqual(ids(await find(c, 'Rundbrief 1')), []);
  // a write of other columns (read, flagged, the tab) does not touch the index
  const rec = await cost.record(async () => { await c.as(ANNA)('POST', 'messages/read', { ids: [rows[1].id], read: true }); });
  assert.ok(rec.runs > 0);
  assert.deepEqual(ids(await find(c, 'kolibri')), [rows[1].id]);
}));

test('Einschalten bei vorhandenen Mails: der Index entsteht im Hintergrund in Häppchen — die Suche ist währenddessen vollständig, ein Abbruch mitten im Häppchen lässt nichts halb zurück, nach einem Neustart geht es weiter', () => withMail({}, async (host, c) => {
  const acc = await c.addGmx(ANNA);
  await c.tick();
  const db = host.gc.db;
  const f = await folderOf(c);
  // the option is off: the mails come without an entry (fts = 0, the default of migration 014)
  const N = 240;
  await db.exec('BEGIN');
  for (let i = 0; i < N; i++) await put(db, f, { subject: i % 40 === 0 ? `Sammelbestellung ${i}` : `Betreff ${i}`, text: i % 3 === 0 ? null : `Text ${i} ${i % 60 === 7 ? 'mit Lieferschein-K' + i : 'ohne Besonderes'}`, date: 1700000000000 + i * 1000 });
  await db.exec('COMMIT');
  assert.equal((await c.db('SELECT COUNT(*) AS n FROM messages WHERE fts = 0'))[0].n, N);
  const TERMS = ['Sammelbestellung', 'Lieferschein-K', 'bestell', 'Text 1', 'ohne Besonderes', 'tim@example', 'gibtesnicht'];
  const want = {};
  for (const t of TERMS) want[t] = await likeIds(db, [acc.id], t);
  assert.equal(want.Sammelbestellung.length, 6);
  assert.equal(want['Lieferschein-K'].length, 4);
  const same = async (what) => { for (const t of TERMS) assert.deepEqual(ids(await find(c, t)), want[t], `${what}: „${t}“`); };
  await same('off');
  assert.equal((await find(c, 'Sammelbestellung')).index.state, 'off');
  // the administrator switches it on
  assert.deepEqual(await switchOn(c).then((v) => [v.state, v.pending]), ['building', N]);
  assert.equal(await search.pending(host.gc), N);
  const first = await find(c, 'Sammelbestellung');
  assert.deepEqual(first.index, { state: 'building', pending: N });
  await same('before the build');
  // one batch per run (tickMs 0), the newest mails first
  const keep = { ...search.limits };
  search.limits.tickMs = 0;
  try {
    const n1 = await search.tick(host.gc, true, () => 60000);
    assert.ok(n1 > 0 && n1 < N, `a batch of ${n1}`);
    assert.equal(await search.pending(host.gc), N - n1, 'the progress is in the database');
    const done = await c.db('SELECT MIN(date) AS lo FROM messages WHERE fts = 1');
    const open = await c.db('SELECT MAX(date) AS hi FROM messages WHERE fts = 0');
    assert.ok(done[0].lo > open[0].hi, 'newest first');
    await same('after the first batch');
    // a batch that breaks off in the middle (its second statement fails): rolled back, nothing half done
    const before = await search.pending(host.gc);
    const inIndex = await ftsCount(c, 'Betreff');
    const broken = { ...host.gc, db: { ...host.gc.db, run: async (sql, p) => { if (/^UPDATE messages SET fts/.test(sql)) throw new Error('disk I/O error'); return host.gc.db.run(sql, p); } } };
    await assert.rejects(search.tick(broken, true, () => 60000), /disk I\/O error/);
    assert.equal(await search.pending(host.gc), before, 'no mail marked');
    assert.equal(await ftsCount(c, 'Betreff'), inIndex, 'none put into the index');
    await same('after the broken batch');
    // a run with no time left: one batch at most, however long the build may take per run
    search.limits.tickMs = keep.tickMs;
    const n2 = await search.tick(host.gc, true, () => 0);
    assert.ok(n2 > 0 && n2 <= 90, `one batch of ${n2}`);
    assert.equal(await search.pending(host.gc), before - n2);
    search.limits.tickMs = 0;
    // the database is nearly full: the build rests (said once), the search goes on the old way for the rest
    const full = host.logs.length;
    search.limits.maxBytes = 1;
    assert.equal(await search.tick(host.gc, true, () => 60000), 0);
    assert.equal(await search.tick(host.gc, true, () => 60000), 0);
    assert.deepEqual(host.logs.slice(full).map((l) => [l.level, l.message]), [['warn', 'search index: the build rests — the database is nearly full; mails outside the index are searched the old way']]);
    await same('while the build rests');
    search.limits.maxBytes = keep.maxBytes;
    // a restart in the middle: table and triggers are there, the build goes on where it was
    const mid = await search.pending(host.gc);
    search.reset();
    assert.equal(await search.apply(host.gc, true), 'on');
    assert.equal(await search.pending(host.gc), mid);
    // a new mail meanwhile goes straight into the index (the trigger), whatever the build's state
    const fresh = await put(db, f, { subject: 'Sammelbestellung neu', text: 'frisch', date: Date.now() });
    assert.equal((await c.db('SELECT fts FROM messages WHERE id = ?', [fresh]))[0].fts, 1);
    want.Sammelbestellung = await likeIds(db, [acc.id], 'Sammelbestellung');
    want.bestell = await likeIds(db, [acc.id], 'bestell');
    want['tim@example'] = await likeIds(db, [acc.id], 'tim@example');
    assert.equal(want.Sammelbestellung[0], fresh);
    await same('in the middle');
    // the background run finishes the build (index.js: a part of every run)
    search.limits.tickMs = keep.tickMs;
    const logs = host.logs.length;
    for (let i = 0; i < 20 && await search.pending(host.gc); i++) await host.tick();
    assert.equal(await search.pending(host.gc), 0);
    assert.equal((await c.db('SELECT COUNT(*) AS n FROM messages WHERE fts <> 1'))[0].n, 0);
    assert.ok(host.logs.slice(logs).some((l) => l.message === 'search index built'));
    assert.equal(host.logs.filter((l) => /^search index: building \d+ mails to go$/.test(l.message)).length, 2, 'said at the start (and after the restart), not at every batch');
    assert.deepEqual((await find(c, 'Sammelbestellung')).index, { state: 'ready', pending: 0 });
    await same('after the build');
    // and no further work: a run with the build done asks the database nothing
    const rec = await cost.record(async () => { await search.tick(host.gc, true, () => 60000); });
    assert.equal(rec.runs, 0);
  } finally { Object.assign(search.limits, keep); }
}));

test('sehr langer Text: bis 100 000 Zeichen im Index, der Rest wie bisher — gefunden wird beides, keine Mail doppelt', () => withMail({}, async (host, c) => {
  await switchOn(c);
  await c.addGmx(ANNA);
  await c.tick();
  const f = await folderOf(c);
  const filler = 'lorem ipsum dolor sit amet '.repeat(4000); // 108 000 characters
  const long = await put(host.gc.db, f, { subject: 'Protokoll lang', text: `Anfangswort-Alpha ${filler} Schlusswort-Omega` });
  const short = await put(host.gc.db, f, { subject: 'Protokoll kurz', text: 'Anfangswort-Alpha und Schlusswort-Omega' });
  assert.ok(filler.length > search.BODY_MAX);
  assert.deepEqual((await c.db('SELECT id, fts FROM messages WHERE id IN (?, ?) ORDER BY id', [long, short])).map((r) => r.fts), [2, 1]);
  assert.deepEqual(ids(await find(c, 'Schlusswort-Omega')).sort(), [long, short].sort(), 'the end of the long text by LIKE');
  assert.deepEqual(ids(await find(c, 'Anfangswort-Alpha')).sort(), [long, short].sort(), 'its beginning by the index — and once');
  assert.deepEqual(ids(await find(c, 'Protokoll')).sort(), [long, short].sort());
  // the build leaves it alone (it is in the index) and the search says ready
  assert.equal(await search.pending(host.gc), 0);
  assert.equal((await find(c, 'Protokoll')).index.state, 'ready');
  // a shorter text for it: all of it in the index
  await require('../server/mailstore').setBody(host.gc, long, { html: null, text: 'nur noch kurz mit Schlusswort-Omega', images: [], trackers: 0 }, Date.now());
  assert.equal((await c.db('SELECT fts FROM messages WHERE id = ?', [long]))[0].fts, 1);
  assert.deepEqual(ids(await find(c, 'Anfangswort-Alpha')), [short]);
}));

test('weniger als drei Zeichen: Betreff, Absender, Empfänger und Anriss — nicht die Texte', () => withMail({}, async (host, c) => {
  await switchOn(c);
  await c.addGmx(ANNA);
  await c.tick();
  const f = await folderOf(c);
  const a = await put(host.gc.db, f, { subject: 'QZ-Bericht', text: 'nichts' });
  const b = await put(host.gc.db, f, { subject: 'Bericht', snippet: 'Anriss mit qz', text: 'nichts' });
  const t = await put(host.gc.db, f, { subject: 'Bericht', text: 'nur im Text steht qz' });
  const rec = await cost.record(async () => { assert.deepEqual(ids(await find(c, 'qz')).sort(), [a, b].sort()); });
  assert.equal([...rec.statements.keys()].filter((s) => /\bbodies\b/.test(s)).length, 0, 'no statement reads the texts');
  assert.deepEqual(ids(await find(c, 'steht qz')), [t], 'three characters and more: the texts too');
  assert.deepEqual(ids(await find(c, 'ü')), []);
}));

test('Filter und Blättern mit dem Index: box, from, attachments, unread, after/before, der Cursor über mehrere Seiten', () => withMail({}, async (host, c) => {
  await switchOn(c);
  const acc = await c.addGmx(ANNA);
  const work = await c.addGmx(ANNA, { email: 'anna.work@gmx.de', name: 'Arbeit' });
  await c.tick();
  const db = host.gc.db;
  const f = await folderOf(c);
  const fw = await folderOf(c, 'inbox', 'anna.work@gmx.de');
  await db.exec('BEGIN');
  const all = [];
  for (let i = 0; i < 130; i++) all.push(await put(db, i % 10 === 0 ? fw : f, { subject: `Wochenbericht ${i}`, text: `Kennzahl-W${i}`, from: i % 2 ? 'chef@example.com' : 'tim@example.com', date: 1700000000000 + i * 60000 }));
  await db.exec('COMMIT');
  await db.run('UPDATE messages SET unread = 0');
  await db.run('UPDATE messages SET has_att = 1 WHERE id IN (?, ?, ?)', [all[5], all[50], all[99]]);
  await db.run('UPDATE messages SET unread = 1 WHERE id IN (?, ?)', [all[7], all[70]]);
  // three pages, newest first, every mail once
  const seen = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const res = await find(c, 'Wochenbericht', cursor ? { cursor } : null);
    seen.push(...ids(res));
    cursor = res.next;
    if (!cursor) break;
  }
  assert.deepEqual(seen, [...all].reverse(), 'all 130 in order across the pages');
  assert.deepEqual(ids(await find(c, 'Wochenbericht', { box: String(work.id) })), all.filter((_, i) => i % 10 === 0).reverse());
  assert.deepEqual(ids(await find(c, 'Wochenbericht', { attachments: '1' })), [all[99], all[50], all[5]]);
  assert.deepEqual(ids(await find(c, 'Wochenbericht', { unread: '1' })), [all[70], all[7]]);
  assert.deepEqual(ids(await find(c, 'Kennzahl-W1', { from: 'chef@' })), all.filter((_, i) => i % 2 && String(i).startsWith('1')).reverse());
  assert.deepEqual(ids(await find(c, 'Wochenbericht', { after: String(1700000000000 + 120 * 60000), before: String(1700000000000 + 123 * 60000) })), [all[122], all[121], all[120]]);
  assert.equal((await c.as(ANNA)('GET', 'search', null, { q: 'Wochenbericht', box: '999' })).json.items.length, 0, 'not an account of the person');
  void acc;
}));

test('die Datenbank kann keinen Volltextindex: Einschalten legt nichts an — die Suche arbeitet wie in 1.13, die Einstellungsseite sagt es', () => withMail({}, async (host, c) => {
  const acc = await c.addGmx(ANNA);
  await c.tick();
  const db = host.gc.db;
  // a database without FTS5 / the trigram tokenizer refuses the tables
  const old = { ...host.gc, db: { ...host.gc.db, exec: async (sql) => { if (/VIRTUAL TABLE/.test(sql)) throw new Error('no such tokenizer: trigram'); return host.gc.db.exec(sql); } } };
  const logs = host.logs.length;
  await c.db('SELECT 1');
  // (the setting is stored as on; what the plugin does with it is search.apply — here with the refusing database)
  await require('../server/config').put(host.gc, { search: { fulltext: true } });
  assert.equal(await search.apply(old, true), 'off');
  assert.equal(await search.apply(old, true), 'off');
  assert.deepEqual(host.logs.slice(logs).map((l) => [l.level, l.message]), [['warn', 'search index not available — the search works as before no such tokenizer: trigram']], 'said once');
  assert.equal((await c.db("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'mail_fts%' OR name = 'messages_fts_todo'"))[0].n, 0, 'nothing half made');
  assert.deepEqual(await host.gc.storage.get('search'), { phase: 'off' });
  const f = await folderOf(c);
  const a = await put(db, f, { subject: 'Angebot Dachdecker', text: 'Die Überweisung bitte bis Freitag' });
  const b = await put(db, f, { subject: 'Zweite', text: 'ab hier nur zwei Zeichen: qz' });
  for (const q of ['dachdecker', 'berweis', 'bis Freitag', 'qz', '50%', '"']) {
    const res = await find(c, q);
    assert.deepEqual(ids(res), await likeIds(db, [acc.id], q), `„${q}“ as LIKE`);
    assert.deepEqual(res.index, { state: 'unavailable', pending: 0 });
  }
  assert.deepEqual(ids(await find(c, 'qz')), [b], 'two characters: the texts too, as before');
  assert.deepEqual(ids(await find(c, 'dachdecker')), [a]);
  assert.equal(await search.tick(old, true, () => 60000), 0);
  assert.equal((await c.db('SELECT COUNT(*) AS n FROM messages WHERE fts <> 0'))[0].n, 0, 'no mail marked');
  const view = (await c.admin('GET', 'admin/settings')).json.search;
  assert.deepEqual([view.state, view.reason], ['unavailable', 'no such tokenizer: trigram']);
}));

test('Migration 014 auf Altdaten: nur die Spalte fts (0 für jede Mail) — keine Tabelle, kein Trigger, kein Index', () => withMail({}, async (host, c) => {
  await c.addGmx(ANNA);
  await c.tick();
  const db = host.gc.db;
  const f = await folderOf(c);
  // back to 1.13: no column
  await db.exec('ALTER TABLE messages DROP COLUMN fts');
  await db.exec('BEGIN');
  for (let i = 0; i < 50; i++) {
    const r = await db.run(`INSERT INTO messages (user_id, account_id, folder_id, uid, date, subject, tab, created_at) VALUES (?, ?, ?, ?, ?, ?, 'relevant', ?)`, [f.user_id, f.account_id, f.id, 9000 + i, 1700000000000 + i, `Alt ${i}`, 1]);
    if (i % 2) await db.run('INSERT INTO bodies (message_id, html, text, bytes, at, used_at) VALUES (?, ?, ?, ?, ?, ?)', [r.lastInsertRowid, '<p>x</p>', `Altbestand-Text ${i}`, 10, 1, 1]);
  }
  await db.exec('COMMIT');
  const before = (await c.db('SELECT name FROM sqlite_master ORDER BY name')).map((r) => r.name);
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '014_search.sql'), 'utf8');
  const statements = sql.split('\n').filter((l) => l.trim() && !l.startsWith('--')).join(' ');
  assert.equal(statements, 'ALTER TABLE messages ADD COLUMN fts INTEGER NOT NULL DEFAULT 0;', 'the whole migration');
  await db.exec(sql);
  assert.deepEqual((await c.db('SELECT name FROM sqlite_master ORDER BY name')).map((r) => r.name), before, 'no table, no index, no trigger more');
  assert.equal((await c.db('SELECT COUNT(*) AS n FROM messages WHERE fts = 0'))[0].n, (await c.db('SELECT COUNT(*) AS n FROM messages'))[0].n);
  // switched on later: the partial index of the build, and the old mails are found
  await switchOn(c);
  const plan = async (q, p) => (await db.query(`EXPLAIN QUERY PLAN ${q}`, p || [])).rows.map((r) => r.detail).join(' / ');
  const todo = await plan('SELECT id FROM messages WHERE fts <> 1 AND fts = 0 ORDER BY date DESC LIMIT ?', [40]);
  assert.match(todo, /USING COVERING INDEX messages_fts_todo \(fts=\?\)/);
  assert.doesNotMatch(todo, /TEMP B-TREE/, 'newest first straight from the index');
  assert.match(await plan('SELECT COUNT(*) AS n FROM messages WHERE fts <> 1 AND fts = 0'), /COVERING INDEX messages_fts_todo \(fts=\?\)/);
  while (await search.tick(host.gc, true, () => 60000)) { /* the build */ }
  assert.equal(await search.pending(host.gc), 0);
  assert.equal((await find(c, 'Altbestand-Text 7')).items[0].subject, 'Alt 7');
  assert.equal((await find(c, 'Alt 8')).items[0].subject, 'Alt 8');
}));

test('viele Mails (20 000): eine Suche über den fertigen Index liest keine große Tabelle ganz und keinen Text; der Rest des Aufbaus über seinen Teilindex', { timeout: 180000 }, (t) => withMail({}, async (host, c) => {
  await switchOn(c);
  const acc = await c.addGmx(ANNA);
  await c.tick();
  const db = host.gc.db;
  const f = await folderOf(c);
  const N = 20000;
  const WORDS = 'rechnung strom wasser abschlag konto termin arzt schule lieferung paket bestellung angebot vertrag versicherung steuer bescheid zahlung betrag bitte danke unterlagen antrag frist kunde nummer urlaub reise buchung garten wohnung miete heizung'.split(' ');
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const words = (n) => { const o = []; for (let i = 0; i < n; i++) o.push(WORDS[Math.floor(rnd() * WORDS.length)]); return o.join(' '); };
  await db.exec('BEGIN');
  for (let i = 0; i < N; i++) await put(db, f, { subject: i % 2000 === 0 ? `Schornsteinfeger ${i}` : words(4), text: i % 5 < 3 ? words(120) + (i === 12345 ? ' Zaunkönig' : '') : null, date: 1700000000000 + i * 1000 });
  await db.exec('COMMIT');
  assert.equal(await search.pending(host.gc), 0, 'the triggers kept the index');
  const UNIT = 'SELECT SUM(LENGTH(text)) FROM bodies NOT INDEXED';
  const rec = await cost.record(async () => {
    assert.equal((await find(c, 'Schornsteinfeger')).items.length, 10);
    assert.equal((await find(c, 'zaunkönig')).items.length, 1);
    assert.equal((await find(c, 'gibtesnicht')).items.length, 0);
  });
  // the index is asked (a virtual table: its plan line is a SCAN of it — that is the index lookup)
  assert.deepEqual(cost.fullReads(rec, { allow: [/VIRTUAL TABLE INDEX/, /USING INDEX messages_fts_todo /] }), []);
  assert.ok(cost.indexes(rec).includes('messages_fts_todo'), 'the rest by its partial index');
  assert.equal([...rec.statements.keys()].filter((s) => /b\.text LIKE/.test(s)).every((s) => /m\.fts <> 1/.test(s)), true, 'LIKE over texts only for mails outside the index');
  assert.deepEqual(cost.tooSlow(rec, { unit: UNIT, factor: 0.5 }), [], 'no statement costs half of reading every text');
  // against the search of 1.13 (the same terms by LIKE), measured side by side
  const like = async (term) => likeIds(db, [acc.id], term);
  const ratio = await cost.ratio(async () => { await c.as(ANNA)('GET', 'search', null, { q: 'gibtesnicht', box: String(acc.id) }); }, async () => { await like('gibtesnicht'); }, 5);
  t.diagnostic(`a search without a hit: ${ratio.toFixed(2)} × the LIKE of 1.13; statements: ${rec.runs}; slowest: ${cost.slowest(rec, UNIT, 3).join(' | ')}`);
  assert.ok(ratio < 1, `the whole request (${ratio.toFixed(2)} × LIKE) is quicker than the one LIKE statement of before`);
  assert.deepEqual(ids(await find(c, 'Schornsteinfeger')), await like('Schornsteinfeger'));
}));
