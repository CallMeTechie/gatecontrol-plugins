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
