'use strict';

// Mail 1.13.1: der Hintergrundlauf hält sein Zeitbudget.
//   Protokoll vom 12./13. 11.: 56× „background run failed: plugin did not answer in time“ (GateControl beendet einen Lauf
//   nach 120 s), 23× „folder sync failed 1 unreachable“. Nachgestellt (unten, im Maßstab): ein Microsoft-Konto, dessen
//   Ordner-Anfragen ohne Antwort bleiben, wartete für JEDEN Ordner auf sein eigenes Zeitlimit (30 s) — 12 Ordner
//   = 330 s in einem Lauf, eine Meldung je Ordner. Dazu lief ein Lauf ohne Blick auf die Uhr durch alle Ordner aller
//   Konten und danach durch Kalender, KI-Sortierung, Ablage …
//   * ein Konto ohne Antwort beendet seinen Zug beim ersten Fehlschlag, pausiert (30 s … 30 min) und setzt danach bei
//     demselben Ordner fort; die anderen Konten laufen daneben weiter
//   * ein Zug, der an seinem Server hängt, hält den Lauf nicht auf (IMAP-Befehle haben ein eigenes Zeitlimit)
//   * die Runde durch die Ordner geht in Häppchen und merkt sich, wo sie war — kein Ordner zweimal je Runde
//   * der ganze Lauf antwortet nach seinem Budget, auch wenn ein Teil hängt; daneben startet kein zweiter
//   * ein Ordner / Konto ohne Neues schreibt nichts in die Datenbank („synced“ bleibt im Speicher)

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, ANNA, MARC, settle, hostError } = require('./helpers');
const cost = require('../../../tools/testing/sql-cost');
const engine = require('../server/engine');

const CLIENT = { microsoft: { registration: 'custom', customClientId: '11111111-2222-3333-4444-555555555555' } };
const PKCE = { code: 'CODE-OK', codeVerifier: 'v'.repeat(43), redirectUri: 'msauth://com.gatecontrol.client/abc%3D' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run fn with other limits of the engine / the run; they are set back after. */
async function withLimits(l, fn) {
  const keep = { ...engine.limits };
  Object.assign(engine.limits, l);
  try { return await fn(); } finally { Object.assign(engine.limits, keep); }
}

/**
 * A fake Microsoft with `n` folders (F-inbox, F-sentitems, X0 …). st: { asked: [folder ids of the delta requests],
 * fail(id, opt) → a promise that rejects / an answer / undefined (answer as usual) }.
 */
function microsoft(n, st) {
  const jwt = (c) => `x.${Buffer.from(JSON.stringify(c)).toString('base64url')}.y`;
  const json = (status, body, headers) => ({ status, headers: { 'content-type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) });
  const ids = ['F-inbox', 'F-sentitems', ...Array.from({ length: n - 2 }, (_, i) => `X${i}`)];
  const entry = (id) => ({ id, displayName: id, parentFolderId: 'ROOT', childFolderCount: 0, totalItemCount: 0, unreadItemCount: 0 });
  st.asked = [];
  st.mail = new Map(); // folder id → messages of the next delta answer
  st.tokens = 0;
  return async (url, opt) => {
    const u = new URL(url);
    if (u.host === 'login.microsoftonline.com') return json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, id_token: jwt({ email: 'anna@outlook.com', tid: '9188040d-6c67-4c5b-b112-36a304b66dad', name: 'Anna' }) });
    const p = decodeURIComponent(u.pathname.replace('/v1.0', ''));
    const wk = /^\/me\/mailFolders\/(inbox|sentitems|drafts|archive|junkemail|deleteditems)$/.exec(p);
    if (wk) return ids.includes(`F-${wk[1]}`) ? json(200, entry(`F-${wk[1]}`)) : json(404, { error: { code: 'ErrorItemNotFound' } });
    if (p === '/me/mailFolders') return json(200, { value: ids.map(entry) });
    const d = /^\/me\/mailFolders\/([^/]+)\/messages\/delta$/.exec(p);
    if (d) {
      st.asked.push(d[1]);
      const out = st.fail ? await st.fail(d[1], opt) : undefined;
      if (out) return out;
      const value = st.mail.get(d[1]) || [];
      st.mail.delete(d[1]);
      return json(200, { value, '@odata.deltaLink': `${u.origin}${u.pathname}?$deltatoken=t${++st.tokens}` });
    }
    if (/\/messages$/.test(p)) return json(200, { value: [] });
    return json(404, { error: { code: 'ErrorItemNotFound' } });
  };
}
microsoft.json = (status, body, headers) => ({ status, headers: { 'content-type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) });

async function signIn(c) {
  const r = await c.as(ANNA)('POST', 'accounts/microsoft', PKCE);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await settle(200);
  await c.tick();
  await c.tick();
  return (await c.db("SELECT * FROM accounts WHERE provider NOT IN ('gmx') ORDER BY id DESC LIMIT 1"))[0];
}

/** The folders' round of account `id` is due now, its posteingang is not. */
function roundDue(id, inboxToo = false) {
  const x = engine.stateOf(id);
  x.lastAll = 0; x.retryAt = 0; x.pause = 0;
  x.lastInbox = inboxToo ? 0 : Date.now();
  return x;
}

const SCALE = 100; // 30 s of a request without an answer → 300 ms

test('Microsoft ohne Antwort: der Zug endet beim ersten Ordner (vorher: jeder Ordner wartete sein Zeitlimit ab), eine Meldung mit Konto und Grund, Pause, dann weiter bei demselben Ordner', () => {
  const st = {};
  return withMail({ settings: CLIENT, fetch: microsoft(12, st) }, async (host, c) => {
    const acc = await signIn(c);
    const x = roundDue(acc.id);
    st.asked.length = 0;
    // the first two folders answer, then Microsoft is gone: a request ends with its time limit
    let waited = 0;
    st.fail = async (id, opt) => {
      if (st.asked.length <= 2) return undefined;
      waited += opt.timeoutMs;
      await sleep(opt.timeoutMs / SCALE);
      throw hostError('ERR_TIMEOUT', 'timeout');
    };
    const before = host.logs.length;
    const t0 = Date.now();
    await host.tick();
    const ms = Date.now() - t0;
    assert.equal(st.asked.length, 3, 'two folders synced, the third without an answer — no further folder asked');
    assert.equal(waited, engine.limits.graphMs, 'one time limit waited for (1.13.0: one per folder, 30 s each — 9 × 30 s here)');
    assert.ok(ms * SCALE < 60000, `the run took ${ms * SCALE / 1000} s at full scale`);
    const logs = host.logs.slice(before).map((l) => l.message);
    assert.deepEqual(logs.filter((m) => /unreachable|folder sync failed/.test(m)), [`account unreachable account ${acc.id} (Microsoft) unreachable: ERR_TIMEOUT`]);
    assert.equal((await c.db('SELECT state, error_code FROM accounts WHERE id = ?', [acc.id]))[0].state, 'unreachable');
    // the pause: no request in the next runs
    assert.ok(x.retryAt > Date.now() + 20000 && x.retryAt < Date.now() + 40000, 'a pause of 30 s');
    assert.equal(x.round.length, 9, 'the round keeps its place: nine folders to do, the failed one first');
    await host.tick();
    await host.tick();
    assert.equal(st.asked.length, 3, 'no request during the pause');
    assert.equal(host.logs.slice(before).filter((l) => /account unreachable/.test(l.message)).length, 1, 'said once');
    // after the pause Microsoft is back: the round goes on where it stopped — the two folders of before are not asked again
    st.fail = null;
    x.retryAt = 0;
    const third = st.asked[2];
    st.asked.length = 0;
    await host.tick();
    assert.equal(st.asked[0], third, 'the folder that failed comes first');
    assert.equal(st.asked.length, 9);
    assert.equal(new Set(st.asked).size, 9, 'every folder once');
    assert.equal(x.round, null, 'the round is through');
    assert.ok(Date.now() - x.lastAll < 5000);
    // the posteingang syncs again: the account is fine, and the log says so
    x.lastInbox = 0;
    await host.tick();
    assert.equal((await c.db('SELECT state FROM accounts WHERE id = ?', [acc.id]))[0].state, 'ok');
    assert.ok(host.logs.slice(before).some((l) => l.message === `account reachable again account ${acc.id} (Microsoft)`));
  });
});

test('Microsoft bittet um eine Pause (429, Retry-After): der Zug endet, das Konto wartet so lange; ein Ordner mit einem Fehler nur für sich wird übersprungen und mit Konto, Ordner und Grund gemeldet', () => {
  const st = {};
  return withMail({ settings: CLIENT, fetch: microsoft(6, st) }, async (host, c) => {
    const acc = await signIn(c);
    const x = roundDue(acc.id);
    st.asked.length = 0;
    st.fail = async () => (st.asked.length === 2 ? microsoft.json(429, { error: { code: 'TooManyRequests' } }, { 'retry-after': '120' }) : undefined);
    await host.tick();
    assert.equal(st.asked.length, 2, 'no folder asked after the 429');
    assert.ok(x.retryAt > Date.now() + 100000 && x.retryAt < Date.now() + 130000, 'waits as long as Microsoft says');
    assert.equal(x.round.length, 4);
    // one folder answers 500 — only it: skipped, the others are synced
    x.retryAt = 0;
    st.asked.length = 0;
    const before = host.logs.length;
    st.fail = async (id) => (id === 'X1' ? microsoft.json(500, { error: { code: 'ErrorInternalServerError' } }) : undefined);
    await host.tick();
    assert.equal(st.asked.length, 4, 'all four folders of the round asked');
    assert.equal(x.round, null);
    const f = (await c.db("SELECT id FROM folders WHERE remote_id = 'X1'"))[0];
    assert.deepEqual(host.logs.slice(before).filter((l) => /folder sync failed/.test(l.message)).map((l) => l.message),
      [`folder sync failed account ${acc.id} (Microsoft) folder ${f.id} unreachable: ErrorInternalServerError`]);
  });
});

test('ein Konto hängt an seinem Server: der Lauf wartet nicht darauf, das andere Konto synchronisiert daneben; das hängende Konto bekommt keinen zweiten Zug', () => {
  const st = {};
  return withLimits({ runMs: 300, graceMs: 50 }, () => withMail({ settings: CLIENT, fetch: microsoft(6, st) }, async (host, c) => {
    const acc = await signIn(c);
    const marc = await c.addGmx(MARC);
    await c.tick();
    c.mail.mail('marc@gmx.de', 'Archiv', { subject: 'im Archiv', text: 'hallo' });
    roundDue(acc.id);
    roundDue(marc.id);
    st.asked.length = 0;
    let release;
    const hang = new Promise((r) => { release = r; });
    st.fail = async () => { await hang; return undefined; };
    const t0 = Date.now();
    await host.tick();
    const ms = Date.now() - t0;
    assert.ok(ms < 5000, `the run answered after ${ms} ms although Microsoft hangs`);
    assert.equal(st.asked.length, 1, 'the request hangs');
    assert.equal((await c.db("SELECT COUNT(*) AS n FROM messages WHERE subject = 'im Archiv'"))[0].n, 1, 'the other account went through its folders meanwhile');
    assert.ok(engine.stateOf(acc.id).turn, 'the turn still runs');
    // the next runs: no second turn for the hanging account, the others go on
    await host.tick();
    assert.equal(st.asked.length, 1);
    release();
    await settle(100);
    assert.equal(engine.stateOf(acc.id).turn, null);
    st.fail = null;
    await host.tick();
    assert.equal(engine.stateOf(acc.id).round, null, 'the round went on and is through');
    assert.equal(new Set(st.asked).size, 5, 'every folder once, the one that hung too');
    assert.equal(st.asked.length, 5);
  }));
});

/** The fake mail world with a hook per IMAP command: world.before(op, user, args) may wait or throw. */
function hooked(world) {
  const orig = world.handler.bind(world);
  world.handler = () => {
    const h = orig();
    const imap = h.imap;
    h.imap = async (o, ctx) => {
      if (world.connect) await world.connect(o);
      const s = await imap(o, ctx);
      for (const op of ['open', 'search', 'fetch', 'list']) {
        const f = s[op];
        s[op] = async (...a) => { if (world.before) await world.before(op, o.auth.user, a); return f(...a); };
      }
      return s;
    };
    return h;
  };
  return world;
}

test('IMAP: die Runde durch die Ordner in Häppchen — nach dem Zeitbudget geht sie im nächsten Lauf beim nächsten Ordner weiter, kein Ordner zweimal, neue Mail kommt genau einmal', () => {
  const { FakeMail } = require('./helpers');
  const world = hooked(new FakeMail());
  const folders = { Gesendet: '\\Sent', Archiv: '\\Archive' };
  for (let i = 0; i < 8; i++) folders[`Ordner${i}`] = null;
  return withLimits({ turnMs: 60 }, () => withMail({ world }, async (host, c) => {
    const acc = await c.addGmx(ANNA, { login: { folders } });
    for (let i = 0; i < 4; i++) await c.tick();
    for (const p of Object.keys(folders)) c.mail.mail('anna@gmx.de', p, { subject: `neu in ${p}`, text: 'x' });
    const x = roundDue(acc.id);
    const opened = [];
    // every folder takes 25 ms to open: two or three fit into a turn of 60 ms
    world.before = async (op, user, a) => { if (op === 'open' && a[0] !== 'INBOX') { opened.push(a[0]); await sleep(25); } };
    let runs = 0;
    for (; runs < 40; runs++) {
      await host.tick();
      x.lastInbox = Date.now();
      if (!x.round && x.lastAll) break;
    }
    assert.ok(runs >= 2, `the round took ${runs + 1} runs`);
    assert.ok(runs < 40, 'the round ended');
    assert.deepEqual([...opened].sort(), Object.keys(folders).sort(), 'every folder opened once in the round');
    const rows = await c.db("SELECT subject, COUNT(*) AS n FROM messages WHERE subject LIKE 'neu in %' GROUP BY subject");
    assert.equal(rows.length, 10);
    assert.ok(rows.every((r) => r.n === 1), 'no mail twice');
    // between the runs the session is back on the posteingang (IDLE): new mail there is not missed during a long round
    assert.ok(world.sessions.some((s) => s.open && s.cur === 'INBOX' && s.idling));
  }));
});

test('IMAP-Server nicht erreichbar: kurzes Zeitlimit beim Verbinden (10 s), Pause mit wachsendem Abstand, eine Meldung mit Konto und Grund; das andere Konto läuft weiter', () => {
  const { FakeMail } = require('./helpers');
  const world = hooked(new FakeMail());
  return withMail({ world }, async (host, c) => {
    const anna = await c.addGmx(ANNA);
    const marc = await c.addGmx(MARC);
    await c.tick();
    // Anna's server is gone: the session breaks, a new one cannot be opened
    const connects = [];
    world.connect = async (o) => {
      if (o.auth.user !== 'anna@gmx.de') return;
      connects.push(o.timeoutMs);
      throw Object.assign(hostError('ERR_MAIL_NET', 'connect ETIMEDOUT'), { serverText: 'connect ETIMEDOUT 203.0.113.5:993' });
    };
    await engine.forget(anna.id);
    c.mail.mail('marc@gmx.de', 'INBOX', { subject: 'für Marc', text: 'x' });
    engine.stateOf(marc.id).lastInbox = 0;
    const before = host.logs.length;
    await host.tick();
    assert.deepEqual(connects, [engine.limits.connectMs], 'one attempt, with the short limit');
    assert.equal(engine.limits.connectMs, 10000);
    assert.equal((await c.db("SELECT COUNT(*) AS n FROM messages WHERE subject = 'für Marc'"))[0].n, 1);
    assert.deepEqual(host.logs.slice(before).filter((l) => l.level === 'warn').map((l) => l.message),
      [`account unreachable account ${anna.id} (IMAP gmx) ERR_MAIL_NET: connect ETIMEDOUT 203.0.113.5:993`]);
    const x = engine.stateOf(anna.id);
    const first = x.retryAt - Date.now();
    assert.ok(first > 20000 && first <= 30000, 'the first pause: 30 s');
    await host.tick();
    await host.tick();
    assert.equal(connects.length, 1, 'no attempt during the pause');
    // the next attempt fails again: the pause doubles, nothing more in the log
    x.retryAt = 0;
    await host.tick();
    assert.equal(connects.length, 2);
    const second = x.retryAt - Date.now();
    assert.ok(second > 50000 && second <= 60000, 'the second pause: 60 s');
    assert.equal(host.logs.slice(before).filter((l) => /account unreachable/.test(l.message)).length, 1);
    // back again
    world.connect = null;
    x.retryAt = 0;
    await host.tick();
    assert.equal((await c.db('SELECT state FROM accounts WHERE id = ?', [anna.id]))[0].state, 'ok');
    assert.equal(x.pause, 0, 'the pause starts small again');
  });
});

test('IMAP-Befehl ohne Antwort: nach dem Zeitlimit des Plugins wird die Sitzung geschlossen und der Schritt endet (GateControl wartet 2 … 10 Minuten)', () => {
  const { FakeMail } = require('./helpers');
  const world = hooked(new FakeMail());
  return withLimits({ callMs: 80 }, () => withMail({ world }, async (host, c) => {
    const acc = await c.addGmx(ANNA);
    await c.tick();
    const x = roundDue(acc.id, true);
    let hung = 0;
    world.before = async (op) => { if (op === 'search') { hung++; await new Promise(() => {}); } };
    const before = host.logs.length;
    const t0 = Date.now();
    await host.tick();
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(hung, 1);
    assert.equal(x.s, null, 'the session is dropped');
    assert.ok(world.sessions.every((s) => !s.open), 'and closed at GateControl');
    assert.ok(x.retryAt > Date.now(), 'a pause');
    assert.match(host.logs.slice(before).map((l) => l.message).join('\n'), new RegExp(`account unreachable account ${acc.id} \\(IMAP gmx\\) ERR_MAIL_NET: no answer to search in 0 s`));
    // the server answers again: a new session, the sync goes on
    world.before = null;
    c.mail.mail('anna@gmx.de', 'INBOX', { subject: 'danach', text: 'x' });
    x.retryAt = 0;
    await host.tick();
    await settle();
    assert.equal((await c.db("SELECT COUNT(*) AS n FROM messages WHERE subject = 'danach'"))[0].n, 1);
  }));
});

test('der ganze Lauf: ein Teil, der hängt, hält die Antwort an GateControl nicht auf — eine Meldung mit dem Teil, daneben startet kein zweiter Lauf', () => {
  const reminders = require('../server/reminders');
  const keep = reminders.tick;
  return withLimits({ hardMs: 150 }, () => withMail({}, async (host, c) => {
    await c.addGmx(ANNA);
    await c.tick();
    let calls = 0;
    let release;
    const hang = new Promise((r) => { release = r; });
    reminders.tick = async () => { calls++; await hang; return 0; };
    try {
      const before = host.logs.length;
      const t0 = Date.now();
      await host.tick();
      assert.ok(Date.now() - t0 < 3000, 'answered');
      assert.match(host.logs.slice(before).map((l) => l.message).join('\n'), /background run takes long part reminders \d+ s/);
      await host.tick();
      await host.tick();
      assert.equal(calls, 1, 'no second run beside the one that hangs');
      assert.equal(host.logs.slice(before).filter((l) => /takes long/.test(l.message)).length, 1, 'said once');
      release();
      await settle(100);
      await host.tick();
      assert.equal(calls, 2, 'the next run works again');
    } finally { reminders.tick = keep; release(); }
  }));
});

test('der ganze Lauf: ist sein Budget verbraucht, warten KI-Sortierung, Ablage und Aufräumen auf den nächsten Lauf — Erinnerungen und der Postausgang nicht', () => {
  const reminders = require('../server/reminders');
  const ai = require('../server/ai');
  const compose = require('../server/compose');
  const keep = { r: reminders.tick, a: ai.tick, c: compose.due };
  return withMail({}, async (host, c) => {
    await c.addGmx(ANNA);
    await c.tick();
    const ran = [];
    reminders.tick = async (...a) => { ran.push('reminders'); return keep.r(...a); };
    ai.tick = async (...a) => { ran.push('ai'); return keep.a(...a); };
    compose.due = async (...a) => { ran.push('outbox'); return keep.c(...a); };
    try {
      await host.tick();
      assert.deepEqual(ran, ['outbox', 'reminders', 'outbox', 'ai']);
      ran.length = 0;
      await withLimits({ totalMs: 0 }, () => host.tick());
      assert.deepEqual(ran, ['outbox', 'reminders', 'outbox'], 'no budget left: the AI waits for the next run');
    } finally { reminders.tick = keep.r; ai.tick = keep.a; compose.due = keep.c; }
  });
});

test('KI-Sortierung: die nächste Mail wird nur gefragt, solange eine Antwort (bis 20 s) noch in den Lauf passt', () => {
  const ai = require('../server/ai');
  let asked = 0;
  return withMail({ ai: { extract: async () => { asked++; return { tab: 'other' }; } } }, async (host, c) => {
    c.mail.login('anna@gmx.de', 'geheim-123');
    for (let i = 0; i < 4; i++) c.mail.mail('anna@gmx.de', 'INBOX', { from: { address: `neu${i}@example.com` }, subject: `Unklar ${i}`, text: 'x' });
    await c.addGmx(ANNA);
    await c.db('UPDATE messages SET ai_pending = 1, tab_by = \'rule\'');
    asked = 0;
    assert.equal(await ai.tick(host.gc, () => 5000), 1, 'one mail, then the time is too short for another');
    assert.equal(asked, 1);
    assert.equal(await ai.tick(host.gc, () => 60000), 3, 'the rest with time');
    assert.equal((await c.db('SELECT COUNT(*) AS n FROM messages WHERE ai_pending = 1'))[0].n, 0);
  });
});

const writes = (rec, re) => [...rec.statements.values()].filter((s) => re.test(s.sql)).reduce((n, s) => n + s.runs, 0);

test('IMAP: eine Runde ohne Neues schreibt nichts (vorher: ein UPDATE je Ordner und je Posteingang-Sync); „synced“ gilt trotzdem; Neues wird geschrieben', () => withMail({}, async (host, c) => {
  const acc = await c.addGmx(ANNA);
  for (let i = 0; i < 3; i++) await c.tick();
  const x = roundDue(acc.id, true);
  const stored = async () => c.db('SELECT id, role, synced_at, uid_next FROM folders ORDER BY id');
  const before = await stored();
  await sleep(5);
  const rec = await cost.record(async () => { await host.tick(); });
  assert.ok(x.lastAll && !x.round, 'the round ran');
  assert.equal(writes(rec, /^UPDATE folders/i), 0, 'no folder written');
  assert.equal(writes(rec, /^UPDATE accounts/i), 0, 'no account written');
  assert.deepEqual(await stored(), before);
  // „synced“ is known all the same: opening the folder does not sync it again
  const archive = before.find((f) => f.role === 'archive');
  const row = (await c.db('SELECT * FROM folders WHERE id = ?', [archive.id]))[0];
  assert.ok(engine.folderSynced(row) > row.synced_at, 'the time of the sync that was not written');
  const opens = c.mail.sessions.length;
  const rec2 = await cost.record(async () => { assert.equal((await c.as(ANNA)('GET', 'messages', null, { folder: String(archive.id) })).status, 200); });
  assert.equal(writes(rec2, /^UPDATE folders/i), 0);
  assert.equal(c.mail.sessions.length, opens);
  // a stored time older than an hour is written again (it survives a restart)
  await c.db('UPDATE folders SET synced_at = ? WHERE id = ?', [Date.now() - 2 * 3600000, archive.id]);
  roundDue(acc.id);
  const rec3 = await cost.record(async () => { await host.tick(); });
  assert.equal(writes(rec3, /^UPDATE folders/i), 1);
  assert.ok(Date.now() - (await c.db('SELECT synced_at FROM folders WHERE id = ?', [archive.id]))[0].synced_at < 5000);
  // new mail in a folder: written (uid_next), and the account's time with new mail in the posteingang
  c.mail.mail('anna@gmx.de', 'Archiv', { subject: 'abgelegt', text: 'x' });
  c.mail.mail('anna@gmx.de', 'INBOX', { subject: 'neu', text: 'x' });
  roundDue(acc.id, true);
  const rec4 = await cost.record(async () => { await host.tick(); });
  assert.equal(writes(rec4, /^UPDATE folders SET uid_validity/i), 2, 'the two folders that changed');
  assert.equal(writes(rec4, /^UPDATE accounts SET synced_at/i), 1);
  assert.equal((await c.db("SELECT COUNT(*) AS n FROM messages WHERE subject IN ('abgelegt', 'neu')"))[0].n, 2);
}));

test('Microsoft: eine Delta-Runde ohne Neues schreibt nichts und behält ihren deltaLink; kommt etwas, wird geschrieben', () => {
  const st = {};
  return withMail({ settings: CLIENT, fetch: microsoft(6, st) }, async (host, c) => {
    const acc = await signIn(c);
    roundDue(acc.id, true);
    await host.tick();
    const before = await c.db('SELECT id, remote_id, delta, synced_at, complete FROM folders ORDER BY id');
    assert.ok(before.every((f) => /deltatoken/.test(f.delta) && f.synced_at));
    roundDue(acc.id, true);
    st.asked.length = 0;
    const rec = await cost.record(async () => { await host.tick(); });
    assert.equal(st.asked.length, 6, 'every folder asked');
    assert.equal(writes(rec, /^UPDATE folders/i), 0);
    assert.equal(writes(rec, /^UPDATE accounts/i), 0);
    assert.deepEqual(await c.db('SELECT id, remote_id, delta, synced_at, complete FROM folders ORDER BY id'), before);
    // a mail comes in X0: its row and its new deltaLink are written
    st.mail.set('X0', [{ id: 'M1', subject: 'neu bei Microsoft', receivedDateTime: new Date().toISOString(), from: { emailAddress: { address: 'a@example.com', name: 'A' } }, isRead: false }]);
    roundDue(acc.id);
    const rec2 = await cost.record(async () => { await host.tick(); });
    assert.equal(writes(rec2, /^UPDATE folders SET delta/i), 1);
    const x0 = (await c.db("SELECT delta FROM folders WHERE remote_id = 'X0'"))[0];
    assert.notEqual(x0.delta, before.find((f) => f.remote_id === 'X0').delta);
    assert.equal((await c.db("SELECT COUNT(*) AS n FROM messages WHERE subject = 'neu bei Microsoft'"))[0].n, 1);
    // the same delta answer once more (the old link asked again) brings no second copy
    roundDue(acc.id);
    await host.tick();
    assert.equal((await c.db("SELECT COUNT(*) AS n FROM messages WHERE subject = 'neu bei Microsoft'"))[0].n, 1);
  });
});

test('KI-Sortierung: die unklaren Mails über den Teilindex messages_ai_pending — auch mit vielen Mails, auch nach einem Update von 1.13.0', () => withMail({}, async (host, c) => {
  await c.addGmx(ANNA);
  const db = host.gc.db;
  const f = (await c.db("SELECT f.id, f.account_id, a.user_id FROM folders f JOIN accounts a ON a.id = f.account_id WHERE f.role = 'inbox'"))[0];
  const N = 20000;
  const fill = async () => {
    await db.exec('BEGIN');
    for (let i = 1; i <= N; i++) {
      await db.run(`INSERT INTO messages (user_id, account_id, folder_id, uid, date, subject, tab, tab_by, ai_pending, created_at) VALUES (?, ?, ?, ?, ?, ?, 'relevant', ?, ?, ?)`,
        [f.user_id, f.account_id, f.id, 1000 + i, i * 1000, `Mail ${i}`, i % 3 ? 'rule' : 'user', i % 5000 === 0 ? 1 : 0, i]);
    }
    await db.exec('COMMIT');
  };
  const SQL = `SELECT m.*, a.ai AS acc_ai, a.kind AS acc_kind FROM messages m JOIN accounts a ON a.id = m.account_id
    WHERE m.ai_pending = 1 AND m.tab_by = 'rule' ORDER BY m.date DESC LIMIT ?`;
  const plan = async () => (await db.query(`EXPLAIN QUERY PLAN ${SQL}`, [20])).rows.map((r) => r.detail).join(' / ');
  // as 1.13.0: without the index — every mail read
  await db.exec('DROP INDEX messages_ai_pending');
  await fill();
  assert.match(await plan(), /SCAN m USING INDEX messages_date/);
  const want = (await db.query(SQL, [20])).rows.map((r) => r.id);
  assert.equal(want.length, 3, 'the pending mails sorted by a rule (one of the four pending ones was sorted by the person)');
  // the update: migrations/013_run.sql on the mails that are there
  const sql = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'migrations', '013_run.sql'), 'utf8');
  await db.exec(sql);
  assert.match(await plan(), /SCAN m USING INDEX messages_ai_pending/);
  assert.doesNotMatch(await plan(), /messages_date|USE TEMP B-TREE/);
  assert.deepEqual((await db.query(SQL, [20])).rows.map((r) => r.id), want, 'the same mails in the same order');
  // the statement as the plugin runs it goes by the index and reads no large table as a whole
  const ai = require('../server/ai');
  const rec = await cost.record(async () => { await ai.tick(host.gc).catch(() => 0); await db.query(SQL, [20]); });
  assert.ok(cost.indexes(rec).includes('messages_ai_pending'));
  assert.deepEqual(cost.fullReads(rec, { allow: [/USING INDEX messages_ai_pending /] }), []);
  // the index follows the mail: sorted → out of it; unclear again → in
  await db.run('UPDATE messages SET ai_pending = 0 WHERE id = ?', [want[0]]);
  assert.deepEqual((await db.query(SQL, [20])).rows.map((r) => r.id), want.slice(1));
}));
