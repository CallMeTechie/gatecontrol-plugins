'use strict';

// Mail 1.17.1: die Ergebnisse des Virenscans (Hook mediaScanned) gesammelt in einer Transaktion — das Muster von
// Drive 1.28.1. GateControl ruft den Hook je Datei (die nächtliche Nachprüfung: Hunderte in Minuten, fast alle wieder
// „clean“). Jeder Hook las und schrieb für sich; hing der Datenträger, liefen die Hooks nebeneinander weiter, bis mehr
// als 32 Host-Aufrufe offen waren — GateControl antwortete ERR_BUSY, und jede Datei schrieb „scan state failed“.
// Jetzt: Warteschlange, Stapel bis 200 in einer Transaktion, ein Stapel zur Zeit, ohne Änderung kein Schreiben,
// ERR_BUSY / SQLITE_BUSY nach 250 ms, 1 s, 3 s erneut, eine Zeile je Lauf statt je Datei.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, ANNA } = require('./helpers');
const scan = require('../server/scan');
const store = require('../server/store');
const plugin = require('../server/index');

const N = 494;
const hex = (i) => i.toString(16).padStart(32, '0');

/** N attachments with their copies (media ids) in one message of Anna's posteingang, clean; and one draft file. */
async function attachments(host, c) {
  const acc = await c.addGmx(ANNA);
  await c.tick();
  const db = host.gc.db;
  const f = (await db.get("SELECT id FROM folders WHERE account_id = ? AND role = 'inbox'", [acc.id])).row;
  const m = await db.run(`INSERT INTO messages (user_id, account_id, folder_id, uid, date, from_email, subject, has_att, body_state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'stored', ?)`, [ANNA.id, acc.id, f.id, 99999, Date.now(), 'tim@example.com', 'Viele Anhänge', Date.now()]);
  await db.exec('BEGIN');
  for (let i = 0; i < N; i++) {
    await db.run("INSERT INTO attachments (message_id, part_id, name, mime, size, media_id, scan_state, scan_blocked) VALUES (?, ?, ?, 'application/pdf', 10, ?, 'clean', 0)",
      [m.lastInsertRowid, String(i + 2), `datei-${i}.pdf`, hex(i + 1)]);
  }
  await db.exec('COMMIT');
  const d = await db.run('INSERT INTO drafts (user_id, account_id, created_at, updated_at) VALUES (?, ?, ?, ?)', [ANNA.id, acc.id, Date.now(), Date.now()]);
  await db.run("INSERT INTO draft_atts (draft_id, kind, name, mime, media_id, scan_state, scan_blocked) VALUES (?, 'upload', 'x.pdf', 'application/pdf', ?, 'clean', 0)", [d.lastInsertRowid, hex(1)]);
  return { messageId: Number(m.lastInsertRowid), draftId: Number(d.lastInsertRowid) };
}

/** GateControl's limit: more than 32 open host calls of the plugin → ERR_BUSY (runtime.js). */
function hostLimit(t, max = 32) {
  const st = { open: 0, most: 0, refused: 0 };
  for (const name of ['all', 'one', 'run']) {
    const orig = store[name];
    t.mock.method(store, name, async (...a) => {
      if (st.open >= max) { st.refused++; throw Object.assign(new Error('too many concurrent host calls'), { code: 'ERR_BUSY' }); }
      st.open++;
      st.most = Math.max(st.most, st.open);
      try { return await orig(...a); } finally { st.open--; }
    });
  }
  return st;
}

const states = async (host) => (await host.gc.db.query('SELECT scan_state, scan_blocked, COUNT(*) AS n FROM attachments GROUP BY scan_state, scan_blocked ORDER BY scan_state')).rows
  .map((r) => `${r.scan_state}/${r.scan_blocked}/${r.n}`);

test(`${N} Hooks auf einmal: alle Zustände geschrieben, in Stapeln je eine Transaktion, kein ERR_BUSY, keine Zeile je Datei`, (t) => withMail({}, async (host, c) => {
  const x = await attachments(host, c);
  const limit = hostLimit(t);
  host.resetDbWrites();
  const mark = host.events.length;
  // the nightly re-check: 100 are malware now, the others clean again — all at once, as GateControl sends them
  await Promise.all(Array.from({ length: N }, (_, i) => plugin.mediaScanned({ mediaId: hex(i + 1), state: i < 100 ? 'infected' : 'clean', blocked: i < 100, finding: i < 100 ? 'Win.Trojan.Agent-1' : null }, host.gc)));
  await scan.flush();
  assert.equal(limit.refused, 0, 'never more than 32 host calls at once');
  assert.deepEqual(await states(host), ['clean/0/394', 'infected/1/100']);
  const draft = (await host.gc.db.get('SELECT scan_state, scan_blocked FROM draft_atts')).row;
  assert.deepEqual([draft.scan_state, draft.scan_blocked], ['infected', 1]);
  // written in transactions only (≤ 200 results a batch), only the changed rows
  assert.deepEqual(host.dbWrites.filter((w) => w.kind !== 'commit'), [], JSON.stringify(host.dbWrites.slice(0, 5)));
  const commits = host.dbWrites.filter((w) => w.kind === 'commit');
  assert.ok(commits.length >= 1 && commits.length <= 3, JSON.stringify(commits));
  assert.equal(commits.reduce((s, w) => s + w.changes, 0), 101, 'the 100 attachments and the draft file');
  // the live events: one per changed attachment, one for the draft
  const ev = host.events.slice(mark).filter((e) => e.type === 'mail');
  assert.equal(ev.filter((e) => e.data.attachmentId).length, 100);
  assert.deepEqual(ev.filter((e) => e.data.draftId).map((e) => e.data.draftId), [x.draftId]);
  assert.ok(!host.logs.some((l) => /scan state/.test(l.message)), JSON.stringify(host.logs.filter((l) => /scan/.test(l.message)).slice(0, 3)));
  // the next night, the same results: no write at all, no event
  host.resetDbWrites();
  const mark2 = host.events.length;
  await Promise.all(Array.from({ length: N }, (_, i) => plugin.mediaScanned({ mediaId: hex(i + 1), state: i < 100 ? 'infected' : 'clean', blocked: i < 100, finding: i < 100 ? 'Win.Trojan.Agent-1' : null }, host.gc)));
  await scan.flush();
  assert.deepEqual(host.dbWrites, []);
  assert.deepEqual(host.events.slice(mark2).filter((e) => e.type === 'mail'), []);
  assert.equal(limit.refused, 0);
}));

test('ERR_BUSY: der Stapel nach kurzer Pause erneut — geschrieben, keine Warnung', (t) => withMail({}, async (host, c) => {
  scan._setWaitsForTest({ waits: [1, 1, 1], deferMs: 5 });
  t.after(() => scan._setWaitsForTest());
  await attachments(host, c);
  const orig = store.run;
  let left = 2;
  t.mock.method(store, 'run', (gc, sql, params) => {
    if (left > 0 && /^UPDATE attachments SET scan_state/.test(sql)) { left--; return Promise.reject(Object.assign(new Error('busy'), { code: 'ERR_BUSY' })); }
    return orig(gc, sql, params);
  });
  await Promise.all([1, 2, 3].map((i) => plugin.mediaScanned({ mediaId: hex(i), state: 'unscannable', blocked: false, finding: 'encrypted' }, host.gc)));
  assert.equal(left, 0, 'it was busy');
  assert.deepEqual(await states(host), ['clean/0/491', 'unscannable/0/3']);
  assert.ok(!host.logs.some((l) => /scan state/.test(l.message)), JSON.stringify(host.logs));
}));

test('weiter belegt (SQLITE_BUSY): die Dateien warten auf den nächsten Lauf — eine Zeile für den Lauf; ein anderer Fehler: eine Warnung je Stapel', (t) => withMail({}, async (host, c) => {
  scan._setWaitsForTest({ waits: [1, 1], deferMs: 5 });
  t.after(() => scan._setWaitsForTest());
  await attachments(host, c);
  const orig = store.run;
  let left = 3;
  let other = 0;
  t.mock.method(store, 'run', (gc, sql, params) => {
    if (/^UPDATE attachments SET scan_state/.test(sql)) {
      if (left > 0) { left--; return Promise.reject(Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'ERR_DB' })); }
      if (other > 0) { other--; return Promise.reject(Object.assign(new Error('disk I/O error'), { code: 'ERR_DB' })); }
    }
    return orig(gc, sql, params);
  });
  await Promise.all([1, 2, 3, 4].map((i) => plugin.mediaScanned({ mediaId: hex(i), state: 'infected', blocked: true, finding: 'Eicar-Test-Signature' }, host.gc)));
  await scan.flush();
  assert.deepEqual(await states(host), ['clean/0/490', 'infected/1/4']);
  let lines = host.logs.filter((l) => /scan state/.test(l.message));
  assert.equal(lines.length, 1, JSON.stringify(host.logs));
  assert.equal(lines[0].level, 'info');
  assert.match(lines[0].message, /^scan states deferred \(database busy\) .*"deferred":4,"dropped":0/);
  other = 1;
  await Promise.all([5, 6, 7].map((i) => plugin.mediaScanned({ mediaId: hex(i), state: 'infected', finding: 'X' }, host.gc)));
  lines = host.logs.filter((l) => /scan state failed/.test(l.message));
  assert.equal(lines.length, 1, JSON.stringify(host.logs));
  assert.match(lines[0].message, /^scan state failed ERR_DB \{"files":3\}$/);
}));
