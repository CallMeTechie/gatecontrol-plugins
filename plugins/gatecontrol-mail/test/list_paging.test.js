'use strict';

// Mail 1.17.1: „mit Anhang“ in der Unterhaltungsansicht verschluckte Unterhaltungen.
//   * Eine Seite zählt Unterhaltungen und Mails, die den Filter bestehen; vom Server kamen ältere Mails (jenseits der
//     Aufbewahrung) in Stapeln von `limit` Mails. Füllte ein Stapel die Seite nicht, endete die Liste (kein Cursor);
//     eine erste Seite ohne Treffer gab gar keinen. Eine Unterhaltung, deren Anhang nur in einer älteren Mail jenseits
//     der Aufbewahrung steckt, erschien nie. Jetzt: Stapel nacheinander, bis die Seite voll ist, der Server nichts
//     mehr hat oder die Wartezeit um ist; die Liste geht weiter, solange der Server ältere Mails hat.
//   * Microsoft: ältere Mails ab der ältesten hier (nicht ab der letzten Zeile der Seite — mit Filter viel neuer: es
//     kamen nur bekannte Mails, und der Ordner galt als vollständig).
//   * „mit Anhang“ geht über den Teilindex messages_att, nicht über jede Mail des Ordners.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, ANNA } = require('./helpers');
const engine = require('../server/engine');
const config = require('../server/config');

const D = 86400000;
const PDF = [{ filename: 'A.pdf', contentType: 'application/pdf', data: '%PDF' }];

/** Every page of a list → [[subject/threadCount …] …] */
async function pages(c, q) {
  const out = [];
  let before;
  do {
    const r = await c.list(ANNA, { ...q, ...(before ? { before } : {}) });
    out.push(r.items.map((m) => `${m.subject}/${m.threadCount}`));
    before = r.next;
  } while (before && out.length < 40);
  return out;
}

/** The mails into the posteingang in the order they came (IMAP: the UIDs follow the dates). */
function deliver(c, mails) {
  for (const m of mails.sort((x, y) => x.date - y.date)) c.mail.mail('anna@gmx.de', 'INBOX', { from: { address: 'tim@example.com' }, text: 'x', ...m });
}

test('„mit Anhang“: Unterhaltungen mit dem Anhang nur in einer älteren Mail jenseits der Aufbewahrung, über mehrere Seiten', () => withMail({}, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  const now = Date.now();
  const mails = [];
  for (let i = 0; i < 6; i++) {
    // the attachment more than 12 months ago (beyond the retention), the answer last week (here)
    mails.push({ subject: `T${i}`, messageId: `<t${i}a@example.com>`, date: now - (400 + 20 * i) * D, attachments: PDF });
    mails.push({ subject: `Re: T${i}`, messageId: `<t${i}b@example.com>`, inReplyTo: `<t${i}a@example.com>`, date: now - (10 + i) * D });
  }
  // many older mails without an attachment between them: a batch from the server fills no page
  for (let i = 0; i < 60; i++) mails.push({ subject: `N${i}`, messageId: `<n${i}@example.com>`, date: now - (380 + 2 * i) * D - 3600000 });
  deliver(c, mails);
  const acc = await c.addGmx(ANNA);
  await c.tick();
  assert.equal((await c.list(ANNA, { box: String(acc.id) })).items.length, 6, 'six conversations here');
  const got = await pages(c, { box: String(acc.id), attachments: '1', limit: '2' });
  const flat = got.flat();
  assert.deepEqual(flat, ['T0/2', 'T1/2', 'T2/2', 'T3/2', 'T4/2', 'T5/2'], JSON.stringify(got));
  // full pages but the last; no empty page before the end
  assert.ok(got.slice(0, -1).every((p) => p.length === 2), JSON.stringify(got));
  // the server has nothing older: the folder is complete, the list ends
  assert.equal((await host.gc.db.get("SELECT complete FROM folders WHERE role = 'inbox'")).row.complete, 1);
}));

test('„mit Anhang“: eine kurze Seite nach Mails vom Server beendet die Liste nicht, solange der Server ältere hat', () => withMail({}, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  const now = Date.now();
  const mails = [];
  // here: one conversation with an attachment in its first mail
  mails.push({ subject: 'Hier', messageId: '<h1@example.com>', date: now - 30 * D, attachments: PDF });
  mails.push({ subject: 'Re: Hier', messageId: '<h2@example.com>', inReplyTo: '<h1@example.com>', date: now - 3 * D });
  // beyond the retention: an attachment every 15 mails
  for (let i = 0; i < 90; i++) mails.push({ subject: `Alt${i}`, messageId: `<a${i}@example.com>`, date: now - (400 + i) * D, ...(i % 15 === 7 ? { attachments: PDF } : {}) });
  deliver(c, mails);
  const acc = await c.addGmx(ANNA);
  await c.tick();
  const got = await pages(c, { box: String(acc.id), attachments: '1', limit: '3' });
  assert.deepEqual(got.flat(), ['Hier/2', 'Alt7/1', 'Alt22/1', 'Alt37/1', 'Alt52/1', 'Alt67/1', 'Alt82/1'], JSON.stringify(got));
  assert.equal(new Set(got.flat()).size, got.flat().length, 'no conversation twice');
}));

test('„mit Anhang“ ohne Aufbewahrungsgrenze: der Anhang in der älteren Mail, Seiten und Cursor stimmen', () => withMail({}, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  const H = 3600000;
  const t0 = Date.now() - 100 * H;
  const mails = [];
  let k = 0;
  for (let i = 0; i < 6; i++) {
    mails.push({ subject: `T${i}`, messageId: `<t${i}a@example.com>`, date: t0 + (k++) * H, attachments: PDF });
    mails.push({ subject: `N${i}`, messageId: `<n${i}@example.com>`, date: t0 + (k++) * H });
  }
  for (let i = 0; i < 6; i++) mails.push({ subject: `Re: T${i}`, messageId: `<t${i}b@example.com>`, inReplyTo: `<t${i}a@example.com>`, date: t0 + (k++) * H });
  deliver(c, mails);
  await c.addGmx(ANNA);
  await c.tick();
  // every posteingang (no retention paging): the conversations with their mail that has the attachment
  const got = await pages(c, { attachments: '1', limit: '4' });
  assert.deepEqual(got, [['T5/2', 'T4/2', 'T3/2', 'T2/2'], ['T1/2', 'T0/2']]);
  // the statement goes by the partial index of the mails with an attachment
  const plan = (await host.gc.db.query(`EXPLAIN QUERY PLAN SELECT m.id FROM messages m INDEXED BY messages_att WHERE m.folder_id IN (1) AND m.has_att = 1
    ORDER BY m.date DESC, m.id DESC LIMIT 5`)).rows.map((r) => r.detail).join('\n');
  assert.match(plan, /messages_att/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
}));

// Mail 1.17.2 (Befunde aus PR #246):
//   * Ältere Mails (jenseits der Aufbewahrung) kamen in UID-Reihenfolge, die höchsten UIDs zuerst. In einem importierten
//     Ordner folgen die UIDs dem Moment, in dem eine Mail in den Ordner kam, nicht ihrem Datum: der erste Stapel war
//     z. B. Mails von vor Jahren, die Liste setzte ihren Cursor dorthin, und die neueren Mails des nächsten Stapels
//     lagen über dem Cursor — nie zu sehen. Jetzt nach dem Datum (Date-Kopf, wie die Liste sortiert), in Tagesfenstern.
//   * `complete` (nichts Älteres mehr auf dem Server) setzte jede Synchronisierung mit Aufbewahrungsgrenze wieder auf
//     0: die Liste fragte an ihrem Ende jedes Mal den Server und zeigte „mehr“, wo nichts mehr war.

/** The fake mail world, counting what the sessions search and fetch. */
function counted() {
  const { FakeMail } = require('./helpers');
  const world = new FakeMail();
  const orig = world.handler.bind(world);
  world.ops = { search: 0, fetched: 0 };
  world.handler = () => {
    const h = orig();
    const imap = h.imap;
    h.imap = async (o, ctx) => {
      const s = await imap(o, ctx);
      const { search, fetch } = s;
      s.search = async (...a) => { world.ops.search++; return search(...a); };
      s.fetch = async (...a) => { const r = await fetch(...a); if (a[1] && a[1].envelope) world.ops.fetched += (r || []).length; return r; };
      return s;
    };
    return h;
  };
  return world;
}

test('importierter Ordner (UIDs nicht in Datumsfolge): ältere Mails kommen nach dem Datum — jede Seite schließt an die vorige an, keine Mail landet über dem Cursor', () => {
  const world = counted();
  return withMail({ world }, async (host, c) => {
    c.mail.login('anna@gmx.de', 'geheim-123');
    const now = Date.now();
    // here (in the retention): five mails of the last weeks
    for (let i = 0; i < 5; i++) c.mail.mail('anna@gmx.de', 'INBOX', { subject: `Neu${i}`, date: now - (10 + i) * D, text: 'x' });
    // beyond the retention, imported in a mixed order: the UIDs follow the import, the dates go back four years —
    // one mail a day and a few days with several (the date windows: whole days)
    const old = [];
    for (let i = 0; i < 150; i++) old.push({ subject: `Alt${String(i).padStart(3, '0')}`, date: now - (400 + i * 9) * D - (i % 5) * 3600000 });
    for (let i = 0; i < 12; i++) old.push({ subject: `Tag${i}`, date: now - (400 + 45 * 9) * D - (i + 1) * 60000 });
    const order = old.map((m, i) => ({ m, k: (i * 61) % old.length }));
    order.sort((p, q) => p.k - q.k);
    for (const { m } of order) c.mail.mail('anna@gmx.de', 'INBOX', { ...m, internalDate: now - 30 * D, text: 'x' });
    const acc = await c.addGmx(ANNA);
    await c.tick();
    assert.equal((await c.list(ANNA, { box: String(acc.id) })).items.length, 5, 'five mails here');
    const want = [...Array.from({ length: 5 }, (_, i) => ({ subject: `Neu${i}`, date: now - (10 + i) * D })), ...old]
      .sort((p, q) => q.date - p.date).map((m) => m.subject);
    // page by page; a batch from the server must not put a mail above a cursor handed out before
    world.ops.search = 0; world.ops.fetched = 0;
    const got = [];
    let before;
    let n = 0;
    do {
      const r = await c.list(ANNA, { box: String(acc.id), limit: '20', ...(before ? { before } : {}) });
      got.push(...r.items.map((m) => m.subject));
      before = r.next;
      n++;
    } while (before && n < 40);
    assert.deepEqual(got, want, 'every mail once, newest first, no page behind the one before');
    // a few searches per batch, the headers of about what the pages showed — not every mail of the folder
    assert.ok(world.ops.search <= n * 16, `${world.ops.search} searches for ${n} pages`);
    assert.ok(world.ops.fetched <= old.length + 40, `${world.ops.fetched} headers fetched`);
    assert.equal((await c.db("SELECT complete FROM folders WHERE role = 'inbox'"))[0].complete, 1, 'everything here: the folder is complete');
  });
});

test('Ordnerflag „vollständig“: eine Synchronisierung mit Aufbewahrungsgrenze lässt es stehen — am Ende der Liste keine Frage an den Server; die Aufräumung alter Mails setzt es zurück', () => {
  const world = counted();
  return withMail({ world }, async (host, c) => {
    c.mail.login('anna@gmx.de', 'geheim-123');
    const now = Date.now();
    for (let i = 0; i < 3; i++) c.mail.mail('anna@gmx.de', 'INBOX', { subject: `Neu${i}`, date: now - (10 + i) * D, text: 'x' });
    for (let i = 0; i < 4; i++) c.mail.mail('anna@gmx.de', 'INBOX', { subject: `Alt${i}`, date: now - (500 + i) * D, text: 'x' });
    const acc = await c.addGmx(ANNA);
    await c.tick();
    const flag = async () => (await c.db("SELECT complete FROM folders WHERE role = 'inbox'"))[0].complete;
    assert.equal(await flag(), 0, 'older mail on the server');
    // to the end of the list: the older mails come, the folder is complete
    let r = await c.list(ANNA, { box: String(acc.id), limit: '3' });
    const seen = r.items.map((m) => m.subject);
    while (r.next) { r = await c.list(ANNA, { box: String(acc.id), limit: '3', before: r.next }); seen.push(...r.items.map((m) => m.subject)); }
    assert.deepEqual(seen, ['Neu0', 'Neu1', 'Neu2', 'Alt0', 'Alt1', 'Alt2', 'Alt3']);
    assert.equal(await flag(), 1);
    // the posteingang syncs again (with the retention): before 1.17.2 the flag went back to 0
    engine.stateOf(acc.id).lastInbox = 0;
    c.mail.deliver('anna@gmx.de', { subject: 'Neu-heute', date: Date.now(), text: 'x' });
    await c.tick();
    assert.equal((await c.db("SELECT COUNT(*) AS n FROM messages WHERE subject = 'Neu-heute'"))[0].n, 1, 'the sync ran');
    assert.equal(await flag(), 1, 'still complete after the sync');
    // the end of the list again: no search on the server, no cursor
    world.ops.search = 0;
    const first = await c.list(ANNA, { box: String(acc.id), limit: '20' });
    assert.equal(first.items.length, 8);
    assert.equal(first.next, null, 'the list ends');
    assert.equal(world.ops.search, 0, 'nothing asked of the server');
    // the retention clean-up drops the old mails nobody looked at: the server has older mail again
    await c.db('UPDATE messages SET seen_at = NULL');
    const gone = await engine.retention(host.gc, await config.get(host.gc), Date.now());
    assert.equal(gone, 4);
    assert.equal(await flag(), 0, 'older mail on the server again');
    const again = await c.list(ANNA, { box: String(acc.id), limit: '20' });
    assert.equal(again.items.length, 4);
    assert.ok(again.next, 'the list goes on to the older mail');
  });
});
