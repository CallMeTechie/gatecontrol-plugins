'use strict';

// The search index (1.14.0) — an option the administrator switches on (Einstellungen › „Volltextsuche“, config.js
// search.fulltext; off unless chosen): a full-text index over what GET search looks through — subject, sender,
// recipients, the snippet and the mail's text — instead of `LIKE '%…%'` over every mail and every text.
//
// While it is off nothing of this exists: no table, no trigger, no index, no statement in the background run — the
// search is the one of 1.13. The only thing an update brings is the column messages.fts (migrations/014_search.sql).
//
// SQLite's FTS5 with the trigram tokenizer: a phrase is found anywhere in a field, also in the middle of a word
// („rechnung“ finds „Stromrechnung“) — what LIKE '%…%' did, and unlike it without regard to case for umlauts too.
// The tables keep no copy of the text (content='', contentless_delete=1 — SQLite ≥ 3.43), only the index.
//
// SHARDS tables (mail_fts_0 …, a mail in the one of its id modulo SHARDS) instead of one: taking the index away again
// must not be one long statement — GateControl ends a statement after 15 s, and dropping a table reads all its pages
// (the shadow tables of FTS5 cannot be emptied row by row: the server's SQLite runs in defensive mode). So the index
// goes table by table, each a statement of its own.
//
// Switched on: tables, triggers and the partial index messages_fts_todo are made; triggers on `messages` and `bodies`
// keep the index from then on (a new mail, its text, a changed snippet, a mail that goes). messages.fts says what the
// index holds of a mail: 0 nothing yet, 1 all of it, 2 all but the text beyond BODY_MAX characters. The mails that are
// there already (fts = 0) are put in by the background run, the newest first, a batch (one short transaction) at a
// time — the column is the progress, so the build can stop anywhere. Until a mail is in the index GET search looks at
// it the old way (LIKE); so does it for the long rest of a text. Results are complete at any time.
//
// Switched off: the triggers go at once (nothing is kept any more, the search is the one of 1.13 from that moment);
// the background run then drops the tables one by one, drops messages_fts_todo and sets messages.fts back to 0 in
// ranges of ids. The pages of the index become free pages of the database file — new mail uses them; the file itself
// does not shrink (SQLite gives pages back only with VACUUM, which GateControl does not allow a plugin). Switched on
// again while that goes on: the removal ends first, then the build starts anew.
//
// The phase ('off' | 'on' | 'removing') is kept in the plugin's storage (key `search`), written only when it changes.
// Nothing is forced: where the database cannot do this (no FTS5, no trigram tokenizer) switching on makes nothing and
// the settings page says so.

const store = require('./store');

const SHARDS = 32;           // with the accounts and filters of a search still far below GateControl's 100 parameters a statement
const BODY_MAX = 100000;      // characters of a mail's text in the index; a longer text: the rest by LIKE (fts = 2)
const MIN_CHARS = 3;          // a trigram needs three characters
const BATCH_MAX = 90;         // GateControl takes 100 parameters a statement
const BATCH_MIN = 5;
const SLOW_MS = 1500;         // a batch slower than this: the next one half as large …
const FAST_MS = 300;          // … faster than this: twice as large
const KEY = 'search';
// tickMs: what a background run spends on the build or the removal; maxBytes: the build rests while the database is
// larger than this (plugin.json storage.maxMB is 4096 — the index must not take the room new mail needs); resetRows:
// ids per statement when messages.fts is set back. A test changes them.
const limits = { tickMs: 3000, maxBytes: 3072 * 1024 * 1024, resetRows: 500 };

const TRIGGERS = ['mail_fts_new', 'mail_fts_head', 'mail_fts_gone', 'mail_fts_body', 'mail_fts_body_new', 'mail_fts_body_gone'];
const shards = Array.from({ length: SHARDS }, (_, k) => k);
const table = (k) => `mail_fts_${k}`;

// what the index holds of mail `m` (and its text `b`): the fields GET search looked through with LIKE before (messages.js)
const DOC = `m.id, m.subject, m.from_name || ' ' || m.from_email, m.to_json, m.snippet, substr(COALESCE(b.text, ''), 1, ${BODY_MAX})`;
const COLS = 'rowid, subject, sender, recipients, snippet, body';
const STATE = `CASE WHEN COALESCE((SELECT length(text) FROM bodies WHERE message_id = messages.id), 0) > ${BODY_MAX} THEN 2 ELSE 1 END`;
// a mail into the index anew (in its table): its entry of before goes first. Not INSERT OR REPLACE — inside a trigger
// that an upsert fires (mailstore.setBody) SQLite does not replace, and the words of the old text stayed in the index.
const PUT = (id) => `${shards.map((k) => `DELETE FROM ${table(k)} WHERE rowid = ${id} AND ${id} % ${SHARDS} = ${k};
    INSERT INTO ${table(k)} (${COLS}) SELECT ${DOC} FROM messages m LEFT JOIN bodies b ON b.message_id = m.id WHERE m.id = ${id} AND m.id % ${SHARDS} = ${k};`).join('\n    ')}
    UPDATE messages SET fts = ${STATE} WHERE id = ${id};`;

// each a statement of its own for gc.db.exec (GateControl takes 100 KB a statement)
const SCHEMA = [
  // the mails the index does not hold (completely): the build's rest (fts = 0, newest first — and how many are left,
  // from the index alone) and what GET search still looks through the old way
  'CREATE INDEX IF NOT EXISTS messages_fts_todo ON messages (fts, date) WHERE fts <> 1',
  ...shards.map((k) => `CREATE VIRTUAL TABLE IF NOT EXISTS ${table(k)} USING fts5(subject, sender, recipients, snippet, body, content='', contentless_delete=1, tokenize='trigram')`),
  `CREATE TRIGGER IF NOT EXISTS mail_fts_new AFTER INSERT ON messages BEGIN
    ${PUT('new.id')}
  END`,
  `CREATE TRIGGER IF NOT EXISTS mail_fts_head AFTER UPDATE OF subject, from_name, from_email, to_json, snippet ON messages
    WHEN old.subject IS NOT new.subject OR old.from_name IS NOT new.from_name OR old.from_email IS NOT new.from_email
      OR old.to_json IS NOT new.to_json OR old.snippet IS NOT new.snippet BEGIN
    ${PUT('new.id')}
  END`,
  `CREATE TRIGGER IF NOT EXISTS mail_fts_gone AFTER DELETE ON messages BEGIN
    ${shards.map((k) => `DELETE FROM ${table(k)} WHERE rowid = old.id AND old.id % ${SHARDS} = ${k};`).join('\n    ')}
  END`,
  `CREATE TRIGGER IF NOT EXISTS mail_fts_body AFTER INSERT ON bodies BEGIN
    ${PUT('new.message_id')}
  END`,
  `CREATE TRIGGER IF NOT EXISTS mail_fts_body_new AFTER UPDATE OF text ON bodies WHEN old.text IS NOT new.text BEGIN
    ${PUT('new.message_id')}
  END`,
  `CREATE TRIGGER IF NOT EXISTS mail_fts_body_gone AFTER DELETE ON bodies BEGIN
    ${PUT('old.message_id')}
  END`,
];
const DROP_TRIGGERS = TRIGGERS.map((t) => `DROP TRIGGER IF EXISTS ${t};`).join(' ');

let phase = null;        // 'off' | 'on' | 'removing' — null: not read yet (this process)
let ready = false;       // phase 'on': tables and triggers are known to be there (this process)
let unavailable = null;  // why the database cannot do it (switching on failed), else null
let batch = 40;
let built = false;       // the build is through (said once in the log)
let said = null;         // what the log was told last: 'building' | 'full'
let cursor = 0;          // the removal: messages.fts is back at 0 up to this id
let busy = Promise.resolve(); // one change of the phase / step of the removal / batch of the build at a time

function reset() { phase = null; ready = false; unavailable = null; batch = 40; built = false; said = null; cursor = 0; busy = Promise.resolve(); }

/** fn() after the change that runs. */
function serial(fn) {
  const p = busy.then(fn, fn);
  busy = p.catch(() => {});
  return p;
}

async function load(gc) {
  if (phase) return phase;
  let v = null;
  try { v = await gc.storage.get(KEY); } catch { v = null; }
  phase = v && (v.phase === 'on' || v.phase === 'removing') ? v.phase : 'off';
  return phase;
}

async function setPhase(gc, p) {
  await gc.storage.set(KEY, { phase: p });
  phase = p;
}

/** Tables, triggers and the partial index (IF NOT EXISTS, one transaction) → true, or false when the database cannot. */
async function make(gc) {
  try {
    await store.tx(gc, async () => { for (const sql of SCHEMA) await gc.db.exec(sql); });
    unavailable = null;
    return true;
  } catch (e) {
    unavailable = String((e && e.message) || e).slice(0, 160);
    gc.log.warn('search index not available — the search works as before', unavailable);
    return false;
  }
}

/**
 * What the administrator chose (`want`: config search.fulltext) against what is there — at the start, when the setting
 * changes, in every background run. Off and nothing there (the usual case): no statement at all. → the phase
 */
function apply(gc, want) {
  return serial(async () => {
    await load(gc);
    if (!want) unavailable = null;
    if (want && phase === 'off' && !unavailable) {
      // the phase first: a start that breaks off in the middle is finished by the next one (IF NOT EXISTS)
      await setPhase(gc, 'on');
      if (await make(gc)) { ready = true; built = false; said = null; gc.log.info('search index switched on'); } else await setPhase(gc, 'off');
    } else if (want && phase === 'on' && !ready) {
      // a start with the index on: its tables and triggers are there (nothing is written) — or made now
      if (await make(gc)) ready = true; else { cursor = 0; await setPhase(gc, 'removing'); }
    } else if (!want && phase === 'on') {
      await setPhase(gc, 'removing');
      ready = false; built = false; said = null; cursor = 0;
      // at once: nothing keeps the index any more
      await gc.db.exec(DROP_TRIGGERS);
      gc.log.info('search index switched off — it is being removed');
    }
    return phase;
  });
}

/** Does GET search ask the index? */
const isOn = () => phase === 'on' && ready;

/**
 * What a person typed → the FTS5 query for it, or null when the index cannot answer (shorter than a trigram). The
 * text is one phrase — in quotes, so no character of it is FTS5 syntax (AND, OR, NOT, *, ^, :, -, parentheses …); a
 * quote in it is doubled.
 */
function matchOf(text) {
  const t = String(text == null ? '' : text).replace(/[\u0000-\u001f]/g, ' ');
  if ([...t].length < MIN_CHARS) return null;
  return `"${t.replace(/"/g, '""')}"`;
}

/**
 * The ids the index finds for a phrase of matchOf: a subquery with the column rowid, and its parameters — the phrase
 * once per table (plain `?`: the server's SQLite binding takes no numbered parameters from a list).
 */
const MATCH_ALL = `(${shards.map((k) => `SELECT rowid FROM ${table(k)} WHERE ${table(k)} MATCH ?`).join(' UNION ALL ')})`;
const matchArgs = (match) => shards.map(() => match);

/** Mails the index does not hold yet (the build's rest) — from the partial index. */
async function pending(gc) {
  if (!isOn()) return 0;
  const r = await store.one(gc, 'SELECT COUNT(*) AS n FROM messages WHERE fts <> 1 AND fts = 0');
  return r ? r.n : 0;
}

/** The size of the database file and of its free pages in bytes (three numbers of the file's header), or null. */
async function dbSize(gc) {
  try {
    const r = await store.one(gc, `SELECT (SELECT page_size FROM pragma_page_size()) AS size, (SELECT page_count FROM pragma_page_count()) AS pages,
      (SELECT freelist_count FROM pragma_freelist_count()) AS free`);
    return r ? { bytes: r.size * r.pages, freeBytes: r.size * r.free } : null;
  } catch { return null; }
}

/** One step of the removal → true when it is through. Every step may run again (a restart in the middle). */
async function removeStep(gc) {
  // the triggers (gone already, but for a restart in the middle), then a table per step
  await gc.db.exec(DROP_TRIGGERS);
  const left = await store.all(gc, `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${shards.map((k) => `'${table(k)}'`).join(',')}) ORDER BY name`);
  if (left.length) { await gc.db.exec(`DROP TABLE IF EXISTS ${left[0].name}`); return false; }
  // the partial index before the marks: setting a mail back to 0 would put it into that index first
  await gc.db.exec('DROP INDEX IF EXISTS messages_fts_todo');
  const max = await store.one(gc, 'SELECT MAX(id) AS n FROM messages');
  const top = (max && max.n) || 0;
  if (cursor < top) {
    const to = cursor + limits.resetRows;
    await store.run(gc, 'UPDATE messages SET fts = 0 WHERE id > ? AND id <= ? AND fts <> 0', [cursor, to]);
    cursor = to;
    if (cursor < top) return false;
  }
  await setPhase(gc, 'off');
  cursor = 0;
  gc.log.info('search index removed');
  return true;
}

/** The build's part of a run: the mails without an entry into the index, newest first. → mails put in */
async function buildStep(gc, started, left) {
  let n = 0;
  for (;;) {
    const ids = (await store.all(gc, 'SELECT id FROM messages WHERE fts <> 1 AND fts = 0 ORDER BY date DESC LIMIT ?', [batch])).map((r) => r.id);
    if (!ids.length) {
      built = true;
      if (n || said) gc.log.info('search index built');
      break;
    }
    if (!n) {
      // before the first batch of a run: is there room? (a trigram index is about as large as the texts themselves)
      const size = await dbSize(gc);
      if (size && size.bytes - size.freeBytes > limits.maxBytes) {
        if (said !== 'full') { said = 'full'; gc.log.warn('search index: the build rests — the database is nearly full; mails outside the index are searched the old way'); }
        return 0;
      }
      if (said !== 'building') { said = 'building'; gc.log.info('search index: building', `${await pending(gc)} mails to go`); }
    }
    const t0 = Date.now();
    await store.tx(gc, async () => {
      for (const k of shards) {
        const part = ids.filter((id) => id % SHARDS === k);
        if (!part.length) continue;
        const marks = store.marks(part.length);
        await store.run(gc, `DELETE FROM ${table(k)} WHERE rowid IN (${marks})`, part);
        await store.run(gc, `INSERT INTO ${table(k)} (${COLS}) SELECT ${DOC} FROM messages m LEFT JOIN bodies b ON b.message_id = m.id WHERE m.id IN (${marks})`, part);
      }
      await store.run(gc, `UPDATE messages SET fts = ${STATE} WHERE id IN (${store.marks(ids.length)})`, ids);
    });
    n += ids.length;
    const ms = Date.now() - t0;
    if (ms > SLOW_MS) batch = Math.max(BATCH_MIN, Math.floor(batch / 2));
    else if (ms < FAST_MS) batch = Math.min(BATCH_MAX, batch * 2);
    if (Date.now() - started >= limits.tickMs || (left && left() <= 0)) break;
  }
  return n;
}

/**
 * The background run's part (`want`: config search.fulltext; left(): the run's rest in ms): the removal's steps or the
 * build's batches, for limits.tickMs at most. Off and nothing there, or on and built: no statement. → mails put in
 */
async function tick(gc, want, left) {
  await apply(gc, want);
  const started = Date.now();
  if (phase === 'removing') {
    await serial(async () => {
      while (phase === 'removing') {
        if (await removeStep(gc)) break;
        if (Date.now() - started >= limits.tickMs || (left && left() <= 0)) break;
      }
    });
    // switched on again meanwhile: the build starts once the removal is through
    if (phase === 'off' && want) await apply(gc, want);
    return 0;
  }
  if (!isOn() || built) return 0;
  return serial(() => (isOn() ? buildStep(gc, started, left) : 0));
}

/**
 * For the settings page and GET search: { state: 'off' | 'building' | 'ready' | 'removing' | 'unavailable', pending,
 * reason? } — pending: mails not in the index yet (building).
 */
async function view(gc) {
  await load(gc);
  if (phase === 'removing') return { state: 'removing', pending: 0 };
  if (!isOn()) return unavailable ? { state: 'unavailable', pending: 0, reason: unavailable } : { state: 'off', pending: 0 };
  const n = await pending(gc);
  return { state: n ? 'building' : 'ready', pending: n };
}

module.exports = { apply, tick, view, matchOf, matchArgs, pending, dbSize, isOn, reset, limits, BODY_MAX, MIN_CHARS, SHARDS, MATCH_ALL, TRIGGERS, table };
