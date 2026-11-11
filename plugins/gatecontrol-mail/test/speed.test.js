'use strict';

// Mail 1.10.1: ein großes Postfach liest die Datenbank nicht mehr bei jedem Hintergrundlauf ganz.
//   * GateControl 1.253.4 meldete Blockaden von 2–5 s mit einem db.query von Mail in jeder: die Summe der Bytes einer
//     Person (Hintergrundlauf je Konto und Takt, GET me) las jede Mail selbst (bodies.html/text mit ihren
//     Überlaufseiten, also die ganze Datenbank). Jetzt aus dem Index bodies_bytes (migrations/010_speed.sql).
//   * Ungelesene je Posteingang, die Unterhaltung einer neuen Mail (In-Reply-To), Mails ohne Text, Anhänge zum
//     Ablegen, die Aufbewahrung: auf ihren Indizes.
//   * 30 000 Mails in drei Konten (zwei Personen): keine Anweisung von GET me, folders, messages, Zum Ablegen und
//     zwei Hintergrundläufen liest eine große Tabelle ganz (der Abfrageplan jeder Anweisung), die Ansichten bleiben bei
//     einer festen Zahl von Anweisungen, und keine kostet ein Viertel dessen, was das Lesen jeder Mail kostet (im selben
//     Lauf gemessen).
//     Keine feste Grenze in Millisekunden: die hing an der Auslastung des Rechners (tools/testing/sql-cost.js).
//   * „mit Anhang“ (und Relevant/Sonstige) in der Unterhaltungsansicht: eine Unterhaltung, deren neueste Mail keinen
//     Anhang hat, verschwindet nicht mehr.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, ANNA, MARC } = require('./helpers');
const cost = require('../../../tools/testing/sql-cost');

const N = 30000;
// the unit of a statement's cost: every mail itself read once — what GET me cost before 1.10.1
const UNIT = 'SELECT SUM(LENGTH(html)) FROM bodies NOT INDEXED';
// read as a whole on purpose
const WHOLE = [
  /USING INDEX messages_unfiled /, // a partial index: only the mails with an attachment that is not filed yet
];
// the eight requests run 50 statements; one more per mail of a page (50 mails) would be 50 more
const SCREENS_MAX = 75;

// the indexes the statements stand on: one that is gone or no longer taken shows here, also where SQLite then finds
// its way by another index and sorts
const INDEXES = {
  screens: ['messages_list', 'messages_thread', 'messages_unread', 'messages_user', 'bodies_bytes', 'attachments_message', 'filing_user'],
  background: ['messages_body_state', 'messages_unfiled', 'messages_user', 'bodies_bytes', 'attachments_message'],
  items: ['ai_results_at', 'messages_flagged', 'todo_done_message'],
};

/** Nothing in the recording reads a large table as a whole or costs a quarter of the unit (the slowest: a twentieth);
 *  the statements go by the indexes `needed`. */
function cheap(rec, what, needed) {
  const used = cost.indexes(rec);
  assert.deepEqual(needed.filter((i) => !used.includes(i)), [], `${what}: indexes no statement goes by any more`);
  assert.deepEqual(cost.fullReads(rec, { allow: WHOLE }), [], `${what}: a large table read as a whole`);
  assert.deepEqual(cost.tooSlow(rec, { unit: UNIT, factor: 0.25 }), [], `${what}: a quarter of reading every mail, or more`);
}

/** N mails in the inbox, archive and sent folders of three accounts; 60 % with a body of 2–14 KB, 10 % with a PDF. */
async function bigMailbox(host, c) {
  await c.addGmx(ANNA);
  await c.addGmx(ANNA, { email: 'anna.work@gmx.de', name: 'Anna Arbeit' });
  await c.addGmx(MARC);
  await c.tick();
  const db = host.gc.db;
  const folders = (await db.query('SELECT f.id, f.role, f.path, a.id AS account_id, a.user_id, a.email FROM folders f JOIN accounts a ON a.id = f.account_id ORDER BY a.id')).rows;
  const accs = [...new Set(folders.map((f) => f.account_id))];
  const plan = [[accs[0], 'inbox', 0.3], [accs[0], 'archive', 0.2], [accs[0], 'sent', 0.1], [accs[1], 'inbox', 0.16], [accs[1], 'sent', 0.04], [accs[2], 'inbox', 0.14], [accs[2], 'archive', 0.06]];
  const now = Date.now();
  const kb = 'x'.repeat(1024);
  for (const [acc, role, share] of plan) {
    const f = folders.find((x) => x.account_id === acc && x.role === role);
    const box = c.mail.logins.get(f.email).boxes.get(f.path);
    const n = Math.round(N * share);
    await db.exec('BEGIN');
    let tid = null;
    for (let i = 1; i <= n; i++) {
      const date = now - (n - i) * 600000;
      const att = i % 10 === 0 ? 1 : 0;
      const first = i % 3 === 1;
      const r = await db.run(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, in_reply_to, thread_id, date, from_name, from_email, to_json, subject, snippet,
        unread, has_att, size, tab, body_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.user_id, acc, f.id, i, `<m${f.id}.${i}@example.com>`, first ? null : `<m${f.id}.${i - 1}@example.com>`, first ? null : tid, date, `Absender ${i % 300}`,
        `absender${i % 300}@example.com`, JSON.stringify([{ name: '', email: f.email }]), `Rechnung ${i % 977}`, `Nachricht ${i}`, i > n - 100 ? 1 : 0, att, 20000,
        i % 3 ? 'relevant' : 'other', i % 5 < 3 ? 'stored' : 'none', date]);
      const id = r.lastInsertRowid;
      if (first) { tid = id; await db.run('UPDATE messages SET thread_id = ? WHERE id = ?', [id, id]); }
      if (i % 5 < 3) {
        const size = 2 + (i % 13);
        await db.run('INSERT INTO bodies (message_id, html, text, bytes, at, used_at) VALUES (?, ?, ?, ?, ?, ?)', [id, `<p>${kb.repeat(size)}</p>`, `Text ${i}`, size * 1024, date, date]);
      }
      if (att) {
        const t = await db.run('INSERT INTO attachments (message_id, part_id, name, mime, size) VALUES (?, ?, ?, ?, ?)', [id, '2', `Rechnung-${i}.pdf`, 'application/pdf', 50000]);
        if (i % 30 === 0) await db.run('INSERT INTO filing (user_id, message_id, attachment_id, created_at) VALUES (?, ?, ?, ?)', [f.user_id, id, t.lastInsertRowid, date]);
        else await db.run('UPDATE messages SET filed = 1 WHERE id = ?', [id]);
      }
      // the same mail on the (fake) server: the sync finds nothing new and nothing gone
      box.msgs.set(i, { uid: i, flags: i > n - 100 ? [] : ['\\Seen'], size: 20000, internalDate: date, envelope: { date, subject: 's', from: [{ address: 'a@b.c' }], to: [], cc: [], bcc: [], replyTo: [], sender: [], messageId: `<m${f.id}.${i}@example.com>` }, headers: {}, bodyStructure: { type: 'text/plain' }, text: 't', html: null, attachments: [] });
    }
    box.uidNext = n + 1;
    await db.exec('COMMIT');
    await db.run('UPDATE folders SET uid_validity = 7, uid_next = ?, low_uid = 0, synced_at = ?, complete = 1, remote_total = ? WHERE id = ?', [n + 1, now, n, f.id]);
  }
  await db.run("UPDATE accounts SET first_done = 1, state = 'ok'");
  return { folders, accs };
}

const plan = async (db, sql, params) => (await db.query(`EXPLAIN QUERY PLAN ${sql}`, params || [])).rows.map((r) => r.detail).join(' / ');

test(`großes Postfach (${N} Mails, drei Konten): keine Anweisung liest eine große Tabelle ganz, keine die Mails selbst`, { timeout: 180000 }, (t) => withMail({}, async (host, c) => {
  const { folders, accs } = await bigMailbox(host, c);
  const anna = c.as(ANNA);
  const services = require('../server/services');
  const archive = folders.find((f) => f.account_id === accs[0] && f.role === 'archive');
  const rec = await cost.record(async () => {
    for (const r of [await anna('GET', 'me'), await anna('GET', 'folders'), await anna('GET', 'messages'), await anna('GET', 'messages', null, { tab: 'relevant' }),
      await anna('GET', 'messages', null, { attachments: '1' }), await anna('GET', 'messages', null, { folder: String(archive.id) }), await anna('GET', 'filing')]) {
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    await services.handle(host.gc, { name: 'tofile_count', caller: 'gatecontrol-drive', user: { id: ANNA.id }, payload: { userId: ANNA.id } }).catch(() => null);
  });
  const ticks = await cost.record(async () => {
    await c.tick();
    await c.tick();
  });
  cheap(rec, 'the screens', INDEXES.screens);
  cheap(ticks, 'the background runs', INDEXES.background);
  // the screens: a fixed number of statements, none per mail of a page (four lists of 50 mails)
  assert.ok(rec.runs <= SCREENS_MAX, `${rec.runs} statements for the screens`);
  t.diagnostic(`screens: ${rec.runs} statements, ${rec.rows} rows; background: ${ticks.runs} statements; slowest: ${cost.slowest(rec, UNIT).concat(cost.slowest(ticks, UNIT, 1)).join(' | ')}`);
  const usage = [...rec.statements.keys()].find((k) => k.includes('SUM(b.bytes)'));
  assert.ok(usage, 'the usage ran');
  assert.match(cost.plan(rec.statements.get(usage).db, usage), /COVERING INDEX bodies_bytes/, 'the usage as the plugin runs it');

  // the plans: the indexes of migrations/010_speed.sql, never the rows of bodies
  const db = host.gc.db;
  const p1 = await plan(db, 'SELECT COALESCE(SUM(b.bytes), 0) AS n FROM messages m JOIN bodies b INDEXED BY bodies_bytes ON b.message_id = m.id WHERE m.user_id = ?', [ANNA.id]);
  assert.match(p1, /COVERING INDEX bodies_bytes/);
  assert.doesNotMatch(p1, /INTEGER PRIMARY KEY|SCAN b\b/);
  assert.match(await plan(db, `SELECT f.account_id, COUNT(*) AS n FROM folders f JOIN accounts a ON a.id = f.account_id
    JOIN messages m INDEXED BY messages_unread ON m.folder_id = f.id AND m.unread = 1 WHERE a.user_id = ? AND f.role = 'inbox' GROUP BY f.account_id`, [ANNA.id]), /COVERING INDEX messages_unread/);
  assert.match(await plan(db, 'SELECT thread_id FROM messages INDEXED BY messages_reply WHERE user_id = ? AND in_reply_to = ? AND thread_id IS NOT NULL LIMIT 1', [ANNA.id, '<x@y>']),
    /messages_reply \(user_id=\? AND in_reply_to=\?\)/);
  assert.match(await plan(db, 'SELECT thread_id FROM messages WHERE account_id = ? AND conv = ? AND thread_id IS NOT NULL LIMIT 1', [accs[0], 'c']), /messages_conv/);
  assert.match(await plan(db, `SELECT m.* FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.account_id = ? AND m.body_state = 'none'
    AND f.role IN ('inbox', 'sent', 'archive') ORDER BY m.date DESC LIMIT ?`, [accs[0], 10]), /messages_body_state/);
  assert.match(await plan(db, 'SELECT id FROM messages WHERE date < ? AND (seen_at IS NULL OR seen_at < ?) AND flagged = 0 LIMIT 2000', [1, 1]), /messages_date/);
  // the bytes are the same as from the rows
  const mailstore = require('../server/mailstore');
  const rows = (await db.query('SELECT COALESCE(SUM(b.bytes), 0) AS n FROM bodies b JOIN messages m ON m.id = b.message_id WHERE m.user_id = ?', [ANNA.id])).rows[0].n;
  assert.equal(await mailstore.usage(host.gc, ANNA.id), rows);
  // GET me: the bytes and the unread mail of the posteingänge (100 unread in each)
  const me = (await anna('GET', 'me')).json;
  assert.equal(me.limits.usedBytes, rows);
  assert.deepEqual([me.unread.all, Object.values(me.unread.byAccount).sort()], [200, [100, 100]]);

  // 1.11.0: the items of „Notizen & Aufgaben“ (server/notizen.js) — 600 flagged mails, 2000 AI results — on their indexes
  await db.run('UPDATE messages SET flagged = 1 WHERE id % 50 = 0');
  await db.exec('BEGIN');
  for (const m of (await db.query('SELECT id FROM messages WHERE id % 15 = 0 LIMIT 2000')).rows) {
    await db.run('INSERT INTO ai_results (message_id, summary, todos_json, replies_json, at) VALUES (?, NULL, ?, \'[]\', ?)', [m.id, JSON.stringify([{ kind: 'task', text: `Aufgabe ${m.id}` }]), Date.now() - (m.id % 40) * 86400000]);
  }
  await db.exec('COMMIT');
  const notizen = require('../server/notizen');
  let items = null;
  const rec2 = await cost.record(async () => { items = await notizen.collect(host.gc, Date.now()); });
  cheap(rec2, 'the items', INDEXES.items);
  assert.ok(items.filter((x) => x.id.startsWith('flag:')).length >= 200 && items.some((x) => x.id.startsWith('todo:')));
  assert.match(await plan(db, `SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND m.flagged = 1 ORDER BY m.date DESC LIMIT ?`, [ANNA.id, 200]), /messages_flagged/);
  assert.match(await plan(db, `SELECT r.message_id FROM ai_results r JOIN messages m ON m.id = r.message_id JOIN folders f ON f.id = m.folder_id
    WHERE r.at >= ? AND r.todos_json <> '[]' ORDER BY r.at DESC LIMIT ?`, [0, 2000]), /ai_results_at/);
}));

test('„mit Anhang“ und Relevant/Sonstige in der Unterhaltungsansicht: die Unterhaltung bleibt, mit ihrer neuesten passenden Mail', () => withMail({}, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  const DAY = 86400000;
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { address: 'tim@example.com' }, subject: 'Angebot', text: 'anbei', messageId: '<t1@example.com>', date: Date.now() - 2 * DAY,
    attachments: [{ filename: 'Angebot.pdf', contentType: 'application/pdf', data: '%PDF-angebot' }] });
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { address: 'tim@example.com' }, subject: 'Re: Angebot', text: 'Danke', messageId: '<t2@example.com>', inReplyTo: '<t1@example.com>', date: Date.now() - DAY });
  await c.addGmx(ANNA);
  await c.tick();
  const all = await c.list(ANNA, {});
  assert.equal(all.items.length, 1, 'one conversation');
  assert.equal(all.items[0].subject, 'Re: Angebot');
  assert.equal(all.items[0].threadCount, 2);
  const withAtt = await c.list(ANNA, { attachments: '1' });
  assert.deepEqual(withAtt.items.map((m) => [m.subject, m.threadCount]), [['Angebot', 2]], 'the conversation with its mail that has the attachment');
  // the answer went to „Sonstige“: under Relevant the conversation shows its relevant mail
  const [first, answer] = (await host.gc.db.query("SELECT id, subject FROM messages ORDER BY date")).rows;
  await host.gc.db.run("UPDATE messages SET tab = 'relevant' WHERE id = ?", [first.id]);
  await host.gc.db.run("UPDATE messages SET tab = 'other' WHERE id = ?", [answer.id]);
  assert.deepEqual((await c.list(ANNA, { tab: 'relevant' })).items.map((m) => m.subject), ['Angebot']);
  assert.deepEqual((await c.list(ANNA, { tab: 'other' })).items.map((m) => m.subject), ['Re: Angebot']);
  assert.deepEqual((await c.list(ANNA, { tab: 'relevant', attachments: '1' })).items.map((m) => m.subject), ['Angebot']);
  assert.deepEqual((await c.list(ANNA, { tab: 'other', attachments: '1' })).items.map((m) => m.subject), []);
  // without conversations: every mail, as before
  await c.as(ANNA)('PUT', 'settings', { threads: false });
  assert.deepEqual((await c.list(ANNA, { attachments: '1' })).items.map((m) => m.subject), ['Angebot']);
  assert.equal((await c.list(ANNA, {})).items.length, 2);
}));
