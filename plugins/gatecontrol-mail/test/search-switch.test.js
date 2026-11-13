'use strict';

// Mail 1.14.0: die Volltextsuche ist eine Option der Einstellungsseite (Karte „Suche“, Schalter „Volltextsuche“,
// config search.fulltext) — AUS, bis der Administrator sie einschaltet.
//   * Aus (also auch nach einem Update ohne Einschalten): keine Tabelle, kein Trigger, kein Index, keine Anweisung im
//     Hintergrundlauf, nichts im Speicher des Plugins — die Suche ist die von 1.13, auch mit ein oder zwei Zeichen.
//   * Ein: Tabellen, Trigger und der Teilindex entstehen, der Aufbau läuft im Hintergrund (search.test.js).
//   * Wieder aus: die Trigger sofort; der Hintergrundlauf entfernt den Index Tabelle für Tabelle (jede eine eigene
//     kurze Anweisung), dann den Teilindex, dann setzt er messages.fts in Bereichen zurück. Der Platz wird in der
//     Datenbank frei. Die Suche ist ab dem Ausschalten wieder die von 1.13.
//   * Umschalten mitten im Aufbau und mitten im Abbau, Neustart in jedem Zustand.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, ANNA, ADMIN } = require('./helpers');
const cost = require('../../../tools/testing/sql-cost');
const search = require('../server/search');
const ui = require('../server/ui');
const { t } = require('../server/text');
const { createWindow } = require('./fake-dom');

async function setSwitch(c, on) {
  const r = await c.admin('PUT', 'admin/settings', { search: { fulltext: on } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.search;
}
const objects = async (c) => (await c.db("SELECT name FROM sqlite_master WHERE name LIKE 'mail_fts%' OR name = 'messages_fts_todo' ORDER BY name")).map((r) => r.name);
const tables = async (c) => (await c.db("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mail_fts%'")).filter((r) => /^mail_fts_\d+$/.test(r.name)).length;
const triggers = async (c) => (await c.db("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'mail_fts%'")).length;
const marked = async (c) => (await c.db('SELECT COUNT(*) AS n FROM messages WHERE fts <> 0'))[0].n;
const folderOf = async (c) => (await c.db("SELECT f.id, f.account_id, a.user_id FROM folders f JOIN accounts a ON a.id = f.account_id WHERE f.role = 'inbox'"))[0];
const find = async (c, q) => { const r = await c.as(ANNA)('GET', 'search', null, { q }); assert.equal(r.status, 200, `${q}: ${JSON.stringify(r.json)}`); return r.json; };
const ids = (res) => res.items.map((m) => m.id);

async function likeIds(db, accountId, term) {
  const l = `%${term.replace(/[%_\\]/g, (ch) => '\\' + ch)}%`;
  const r = await db.query(`SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id LEFT JOIN bodies b ON b.message_id = m.id
    WHERE m.account_id IN (?) AND f.role IS NOT 'trash' AND f.role IS NOT 'junk'
      AND (m.subject LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\' OR m.from_email LIKE ? ESCAPE '\\' OR m.snippet LIKE ? ESCAPE '\\' OR b.text LIKE ? ESCAPE '\\' OR m.to_json LIKE ? ESCAPE '\\')
    ORDER BY m.date DESC, m.id DESC LIMIT 50`, [accountId, l, l, l, l, l, l]);
  return r.rows.map((x) => x.id);
}

let uid = 7000;
async function put(db, f, o) {
  const r = await db.run(`INSERT INTO messages (user_id, account_id, folder_id, uid, date, from_name, from_email, to_json, subject, snippet, tab, unread, body_state, created_at)
    VALUES (?, ?, ?, ?, ?, 'Tim', 'tim@example.com', '[]', ?, '', 'relevant', 0, 'stored', ?)`, [f.user_id, f.account_id, f.id, uid++, 1700000000000 + uid * 1000, o.subject, Date.now()]);
  const id = Number(r.lastInsertRowid);
  await db.run('INSERT INTO bodies (message_id, html, text, bytes, at, used_at) VALUES (?, ?, ?, ?, ?, ?)', [id, `<p>${o.text}</p>`, o.text, o.text.length, 1, 1]);
  return id;
}
/** N mails: „Bericht <i>“ with a text; every 20th holds „Kranich“, every 30th the two letters „qz“ in its text only. */
async function fill(db, f, n) {
  await db.exec('BEGIN');
  const out = [];
  for (let i = 0; i < n; i++) out.push(await put(db, f, { subject: `Bericht ${i}`, text: `Der Text ${i} ${i % 20 === 0 ? 'mit Kranich am Teich' : 'ohne Vogel'} ${i % 30 === 0 ? 'qz' : ''} ${'und etwas mehr Text. '.repeat(20)}` }));
  await db.exec('COMMIT');
  return out;
}
const TERMS = ['Kranich', 'ranich am', 'Bericht 1', 'qz', 'xy', 'gibtesnicht', 'tim@'];
async function sameAsLike(c, db, acc, what) {
  for (const q of TERMS) assert.deepEqual(ids(await find(c, q)), await likeIds(db, acc.id, q), `${what}: „${q}“`);
}
async function withLimits(l, fn) {
  const keep = { ...search.limits };
  Object.assign(search.limits, l);
  try { return await fn(); } finally { Object.assign(search.limits, keep); }
}

test('Standard AUS — wie nach einem Update ohne Einschalten: keine Tabelle, kein Trigger, kein Index, keine Anweisung im Hintergrundlauf, die Suche wie 1.13 (auch < 3 Zeichen im Text)', () => withMail({}, async (host, c) => {
  const s0 = (await c.admin('GET', 'admin/settings')).json;
  assert.deepEqual(s0.settings.search, { fulltext: false });
  assert.equal(s0.search.state, 'off');
  assert.ok(s0.search.db.bytes > 0 && s0.search.db.freeBytes >= 0, 'the size of the database file and its free room');
  const acc = await c.addGmx(ANNA);
  await c.tick();
  const db = host.gc.db;
  const f = await folderOf(c);
  await fill(db, f, 120);
  c.mail.deliver('anna@gmx.de', { subject: 'Neu vom Server', text: 'kommt über den Abgleich, mit qz im Text' });
  const rec = await cost.record(async () => { for (let i = 0; i < 3; i++) await c.tick(); });
  assert.equal((await c.db("SELECT COUNT(*) AS n FROM messages WHERE subject = 'Neu vom Server'"))[0].n, 1);
  assert.deepEqual(await objects(c), [], 'no table, no trigger, no index');
  assert.equal(await marked(c), 0);
  assert.equal(await host.gc.storage.get('search'), null, 'nothing kept in the plugin\'s storage');
  assert.deepEqual([...rec.statements.keys()].filter((sql) => /fts|sqlite_master|pragma_/i.test(sql)), [], 'the background run has no statement for the index');
  // the search of 1.13: LIKE over the fields and the texts, with one or two characters too
  await sameAsLike(c, db, acc, 'off');
  const qz = await find(c, 'qz');
  assert.equal(qz.items.length, 5, 'two characters found in the texts');
  assert.deepEqual(qz.index, { state: 'off', pending: 0 });
  const recS = await cost.record(async () => { await find(c, 'Kranich'); });
  assert.deepEqual([...recS.statements.keys()].filter((sql) => /fts|MATCH/i.test(sql)), [], 'the search does not ask for the index either');
  // a restart: still nothing
  search.reset();
  await host.tick();
  assert.deepEqual(await objects(c), []);
  assert.equal(await host.gc.storage.get('search'), null);
  // only a boolean
  assert.equal((await c.admin('PUT', 'admin/settings', { search: { fulltext: 'ja' } })).json.error.code, 'invalid');
  assert.equal((await c.admin('PUT', 'admin/settings', { search: { tokenizer: 'porter' } })).json.error.code, 'invalid');
  assert.equal((await c.admin('PUT', 'admin/settings', { search: null })).json.error.code, 'invalid');
  // other settings do not switch it on
  await c.admin('PUT', 'admin/settings', { quotaGB: 10 });
  assert.deepEqual(await objects(c), []);
}));

test('EIN, dann wieder AUS: Trigger sofort weg, der Index geht Tabelle für Tabelle (je eine Anweisung), der Merker wird zurückgesetzt, der Platz wird frei; die Suche ist ab dem Ausschalten die von 1.13', () => withLimits({ resetRows: 100 }, () => withMail({}, async (host, c) => {
  const acc = await c.addGmx(ANNA);
  await c.tick();
  const db = host.gc.db;
  const f = await folderOf(c);
  const all = await fill(db, f, 320);
  // on: made at once, built in the background
  const v = await setSwitch(c, true);
  assert.deepEqual([v.state, v.pending], ['building', all.length]);
  assert.equal(await tables(c), search.SHARDS);
  assert.equal(await triggers(c), 6);
  assert.deepEqual(await host.gc.storage.get('search'), { phase: 'on' });
  for (let i = 0; i < 20 && (await find(c, 'Kranich')).index.state !== 'ready'; i++) await host.tick();
  assert.equal(await marked(c), all.length);
  assert.deepEqual(ids(await find(c, 'qz')), [], 'on: two characters only in the fields');
  assert.deepEqual(ids(await find(c, 'Kranich')), await likeIds(db, acc.id, 'Kranich'));
  const before = (await c.admin('GET', 'admin/settings')).json.search;
  assert.equal(before.state, 'ready');
  // off
  const logs = host.logs.length;
  const off = await setSwitch(c, false);
  assert.equal(off.state, 'removing');
  assert.equal(await triggers(c), 0, 'the triggers are gone with the switch');
  assert.equal(await tables(c), search.SHARDS, 'the tables go in the background');
  assert.deepEqual(await host.gc.storage.get('search'), { phase: 'removing' });
  await sameAsLike(c, db, acc, 'right after switching off');
  assert.equal((await find(c, 'qz')).items.length, 11, 'two characters in the texts again');
  assert.equal((await find(c, 'qz')).index.state, 'removing');
  // mail goes on meanwhile: written without the index, nothing fails
  const fresh = await put(db, f, { subject: 'Bericht während des Abbaus', text: 'Kranich im Abbau' });
  assert.equal((await c.db('SELECT fts FROM messages WHERE id = ?', [fresh]))[0].fts, 0);
  await require('../server/mailstore').setBody(host.gc, fresh, { html: null, text: 'neuer Text mit Kranich', images: [], trackers: 0 }, Date.now());
  await require('../server/mailstore').remove(host.gc, [all[3]]);
  // one step per run (tickMs 0): a table each, then the partial index, then the marks in ranges
  await withLimits({ tickMs: 0 }, async () => {
    const seen = [];
    for (let i = 0; i < 60; i++) {
      const rec = await cost.record(async () => { await search.tick(host.gc, false, () => 60000); });
      const drops = [...rec.statements.keys()].filter((sql) => /^DROP TABLE/.test(sql));
      assert.ok(drops.length <= 1, 'at most one table per step');
      seen.push([await tables(c), (await objects(c)).includes('messages_fts_todo'), await marked(c)]);
      if ((await host.gc.storage.get('search')).phase === 'off') break;
    }
    const steps = seen.map((x) => x[0]);
    assert.deepEqual(steps.slice(0, search.SHARDS), Array.from({ length: search.SHARDS }, (_, i) => search.SHARDS - 1 - i), 'one table less per step');
    assert.ok(seen[search.SHARDS - 1][2] > 0 && seen[search.SHARDS - 1][1], 'the marks and the partial index are still there when the last table went');
    const marks = seen.slice(search.SHARDS).map((x) => x[2]);
    assert.ok(marks.length >= 3 && marks.every((n, i) => i === 0 || n <= marks[i - 1]), `the marks go in ranges: ${marks.join(' ')}`);
    assert.ok(seen.slice(search.SHARDS).every((x) => !x[1]), 'the partial index goes before the marks');
  });
  assert.deepEqual(await objects(c), [], 'nothing left');
  assert.equal(await marked(c), 0, 'messages.fts back at 0');
  assert.deepEqual(await host.gc.storage.get('search'), { phase: 'off' });
  assert.deepEqual(host.logs.slice(logs).map((l) => l.message).filter((m) => /search index/.test(m)), ['search index switched off — it is being removed', 'search index removed']);
  const after = (await c.admin('GET', 'admin/settings')).json.search;
  assert.equal(after.state, 'off');
  assert.ok(after.db.freeBytes > before.db.freeBytes, `free room in the database: ${before.db.freeBytes} → ${after.db.freeBytes} bytes`);
  assert.equal(after.db.bytes, before.db.bytes, 'the file itself keeps its size');
  await sameAsLike(c, db, acc, 'after the removal');
  // and no further work
  const rec = await cost.record(async () => { await search.tick(host.gc, false, () => 60000); });
  assert.equal(rec.runs, 0);
  // on again: the build starts anew and uses the free room
  const again = await setSwitch(c, true);
  assert.equal(again.state, 'building');
  assert.equal(again.pending, (await c.db('SELECT COUNT(*) AS n FROM messages'))[0].n);
  for (let i = 0; i < 20 && (await find(c, 'Kranich')).index.state !== 'ready'; i++) await host.tick();
  assert.deepEqual(ids(await find(c, 'Kranich')), await likeIds(db, acc.id, 'Kranich'));
  const rebuilt = (await c.admin('GET', 'admin/settings')).json.search.db;
  assert.ok(rebuilt.bytes < before.db.bytes * 1.1 && rebuilt.freeBytes < after.db.freeBytes / 2, 'built into the free pages — the file does not grow by another index');
})));

test('Umschalten mitten im Aufbau und mitten im Abbau; Neustart in jedem Zustand — die Suche ist immer vollständig', () => withLimits({ tickMs: 0, resetRows: 100 }, () => withMail({}, async (host, c) => {
  const acc = await c.addGmx(ANNA);
  await c.tick();
  const db = host.gc.db;
  const f = await folderOf(c);
  const all = await fill(db, f, 300);
  const LONG = ['Kranich', 'ranich am', 'Bericht 1', 'gibtesnicht', 'tim@'];
  const complete = async (what) => { for (const q of LONG) assert.deepEqual(ids(await find(c, q)), await likeIds(db, acc.id, q), `${what}: „${q}“`); };
  // on, two batches, then off in the middle of the build
  await setSwitch(c, true);
  await search.tick(host.gc, true, () => 60000);
  await search.tick(host.gc, true, () => 60000);
  const part = await marked(c);
  assert.ok(part > 0 && part < all.length, `${part} of ${all.length} in the index`);
  await complete('in the middle of the build');
  assert.equal((await setSwitch(c, false)).state, 'removing');
  await sameAsLike(c, db, acc, 'off in the middle of the build');
  // a restart in the middle of the removal: it goes on
  for (let i = 0; i < 5; i++) await search.tick(host.gc, false, () => 60000);
  assert.equal(await tables(c), search.SHARDS - 5);
  search.reset();
  assert.equal(await search.apply(host.gc, false), 'removing');
  assert.equal((await find(c, 'Kranich')).index.state, 'removing');
  await search.tick(host.gc, false, () => 60000);
  assert.equal(await tables(c), search.SHARDS - 6);
  // on again in the middle of the removal: the removal ends first (the index of before is not used), then the build
  const v = await setSwitch(c, true);
  assert.equal(v.state, 'removing');
  assert.equal(await triggers(c), 0);
  await sameAsLike(c, db, acc, 'on again in the middle of the removal');
  let states = [];
  for (let i = 0; i < 200; i++) {
    await host.tick();
    const st = (await find(c, 'Kranich')).index.state;
    if (states[states.length - 1] !== st) states.push(st);
    await complete(`${st} (${i})`);
    if (st === 'ready') break;
    // a restart now and then, in whatever state
    if (i % 7 === 3) search.reset();
  }
  assert.deepEqual(states, ['removing', 'building', 'ready']);
  assert.equal(await marked(c), all.length);
  assert.equal(await tables(c), search.SHARDS);
  assert.equal(await triggers(c), 6);
  assert.deepEqual(await host.gc.storage.get('search'), { phase: 'on' });
  // a restart with the index on and built: asks once whether tables and triggers are there, writes nothing, builds nothing
  search.reset();
  const rec = await cost.record(async () => { await host.tick(); await host.tick(); });
  assert.deepEqual([...rec.statements.keys()].filter((sql) => /^(INSERT|UPDATE|DELETE)\b.*(mail_fts|fts =)/.test(sql)), []);
  assert.equal(search.isOn(), true);
  assert.equal((await find(c, 'Kranich')).index.state, 'ready');
  // a mail that comes now is in the index at once
  const fresh = await put(db, f, { subject: 'Bericht danach', text: 'Kranich nach dem Neustart' });
  assert.equal((await c.db('SELECT fts FROM messages WHERE id = ?', [fresh]))[0].fts, 1);
  assert.equal(ids(await find(c, 'nach dem Neustart'))[0], fresh);
  // off and on in one go (the page clicked twice): ends as on, complete
  await setSwitch(c, false);
  await setSwitch(c, true);
  for (let i = 0; i < 200 && (await find(c, 'Kranich')).index.state !== 'ready'; i++) await host.tick();
  await complete('after off and on');
  assert.equal(await marked(c), all.length + 1);
})));

const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));
const tick = () => new Promise((r) => setTimeout(r, 3));
async function until(what, fn, n = 2500) {
  for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await tick(); }
  throw new Error('timed out waiting for ' + what);
}

test('Einstellungsseite: die Karte „Suche“ mit dem Schalter „Volltextsuche“ (aus), dem Hinweis und dem Zustand; Einschalten und Ausschalten speichern sofort (DE und EN)', () => withMail({}, async (host, c) => {
  await c.addGmx(ANNA);
  await c.tick();
  await fill(host.gc.db, await folderOf(c), 60);
  const open = (lang) => {
    const gc = { async call(method, p, body) { const r = await host.request({ method, path: p, body: body === undefined ? null : body, query: {}, user: ADMIN, lang }); if (r.status !== 200) throw Object.assign(new Error('http ' + r.status), { status: r.status, data: r.json }); return r.json; }, on() {} };
    const f = createWindow(ui.render({ view: 'page', page: 'settings', lang }, t), gc);
    f.run();
    return f;
  };
  const f = open('de');
  try {
    const card = () => f.document.body.all().find((x) => x.className === 'ma-card' && x.all().some((y) => y.localName === 'h2' && textOf(y) === 'Suche'));
    await until('the card', () => card());
    const sw = () => card().all().find((x) => x.localName === 'input' && x.className === 'dp-sw');
    assert.equal(sw().checked, false, 'off unless chosen');
    const text = () => textOf(card());
    assert.match(text(), /Volltextsuche/);
    assert.match(text(), /belegt etwa so viel Speicher wie die Mailtexte selbst und wird nach dem Einschalten im Hintergrund aufgebaut/);
    assert.match(text(), /Zustand.*Aus/);
    assert.match(text(), /Datenbank [\d.,]+ (KB|MB|GB), davon frei [\d.,]+ (B|KB|MB|GB)/);
    sw().checked = true;
    sw().dispatchEvent({ type: 'change' });
    await until('switched on', () => /Wird aufgebaut – noch 6\d Mails/.test(text()));
    assert.equal(sw().checked, true);
    assert.equal((await c.admin('GET', 'admin/settings')).json.settings.search.fulltext, true);
    for (let i = 0; i < 10; i++) await host.tick();
    sw().checked = false;
    sw().dispatchEvent({ type: 'change' });
    await until('switched off', () => /Wird entfernt/.test(text()));
    assert.equal((await c.admin('GET', 'admin/settings')).json.settings.search.fulltext, false);
  } finally { f.stop(); }
  for (let i = 0; i < 10; i++) await host.tick();
  await c.admin('PUT', 'admin/settings', { search: { fulltext: true } });
  for (let i = 0; i < 10; i++) await host.tick();
  const e = open('en');
  try {
    const card = () => e.document.body.all().find((x) => x.className === 'ma-card' && x.all().some((y) => y.localName === 'h2' && textOf(y) === 'Search'));
    await until('the card', () => card());
    assert.match(textOf(card()), /Full-text search/);
    assert.match(textOf(card()), /State.*Ready/);
    assert.match(textOf(card()), /Database [\d.,]+ (KB|MB|GB), of which free/);
  } finally { e.stop(); }
}));
