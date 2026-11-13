'use strict';

// The search index (1.14.0): a full-text index over what GET search looks through — subject, sender, recipients, the
// snippet and the mail's text — instead of `LIKE '%…%'` over every mail and every body (which read the whole database).
//
// SQLite's FTS5 with the trigram tokenizer: a phrase is found anywhere in a field, also in the middle of a word
// („rechnung“ finds „Stromrechnung“) — what LIKE '%…%' did, and unlike it without regard to case for umlauts too
// („ÜBERWEISUNG“ finds „Überweisung“). The words of the default tokenizer would only be found from their beginning.
// The table keeps no copy of the text (content='', contentless_delete=1 — SQLite ≥ 3.43), only the index.
//
// The index is the database's own business: triggers on `messages` and `bodies` keep it (a new mail, its text, a
// changed snippet, a mail that goes), whatever part of the plugin writes — no statement more per mail from the plugin.
// messages.fts says what the index holds of a mail: 0 nothing yet, 1 all of it, 2 all but the text beyond BODY_MAX
// characters. The mails of before 1.14.0 (fts = 0) are put in by the background run, the newest first, a few at a
// time (tick) — a batch is one short transaction, the column is the progress, so the build can stop anywhere.
// Until a mail is in the index, GET search looks at it the old way (LIKE); so does it for the long rest of a text.
// Results are complete at any time, the search just gets faster as the build goes on.
//
// Nothing is forced: where the database cannot do this (no FTS5, no trigram tokenizer, an older SQLite), table and
// triggers are not made, every mail stays at fts = 0 and the search works as before 1.14.0.

const store = require('./store');

const BODY_MAX = 100000;      // characters of a mail's text in the index; a longer text: the rest by LIKE (fts = 2)
const MIN_CHARS = 3;          // a trigram needs three characters
const BATCH_MAX = 90;         // GateControl takes 100 parameters a statement
const BATCH_MIN = 5;
const SLOW_MS = 1500;         // a batch slower than this: the next one half as large …
const FAST_MS = 300;          // … faster than this: twice as large
// tickMs: what a background run spends on the build; maxBytes: the build rests while the database is larger than this
// (plugin.json storage.maxMB is 4096 — the index of the mails of before must not take the room new mail needs; the
// search stays complete, the old way). A test changes them.
const limits = { tickMs: 3000, maxBytes: 3072 * 1024 * 1024 };

// what the index holds of mail `m` (and its text `b`): the columns of mail_fts — the fields GET search looked through
// with LIKE before (messages.js)
const DOC = `m.id, m.subject, m.from_name || ' ' || m.from_email, m.to_json, m.snippet, substr(COALESCE(b.text, ''), 1, ${BODY_MAX})`;
const STATE = `CASE WHEN COALESCE((SELECT length(text) FROM bodies WHERE message_id = messages.id), 0) > ${BODY_MAX} THEN 2 ELSE 1 END`;
// a mail into the index anew: its entry of before goes first. Not INSERT OR REPLACE — inside a trigger that an upsert
// fires (mailstore.setBody) SQLite does not replace, and the words of the old text stayed in the index.
const PUT = (id) => `DELETE FROM mail_fts WHERE rowid = ${id};
    INSERT INTO mail_fts (rowid, subject, sender, recipients, snippet, body)
      SELECT ${DOC} FROM messages m LEFT JOIN bodies b ON b.message_id = m.id WHERE m.id = ${id};
    UPDATE messages SET fts = ${STATE} WHERE id = ${id};`;

const SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS mail_fts USING fts5(subject, sender, recipients, snippet, body, content='', contentless_delete=1, tokenize='trigram');
  CREATE TRIGGER IF NOT EXISTS mail_fts_new AFTER INSERT ON messages BEGIN
    ${PUT('new.id')}
  END;
  CREATE TRIGGER IF NOT EXISTS mail_fts_head AFTER UPDATE OF subject, from_name, from_email, to_json, snippet ON messages
    WHEN old.subject IS NOT new.subject OR old.from_name IS NOT new.from_name OR old.from_email IS NOT new.from_email
      OR old.to_json IS NOT new.to_json OR old.snippet IS NOT new.snippet BEGIN
    ${PUT('new.id')}
  END;
  CREATE TRIGGER IF NOT EXISTS mail_fts_gone AFTER DELETE ON messages BEGIN
    DELETE FROM mail_fts WHERE rowid = old.id;
  END;
  CREATE TRIGGER IF NOT EXISTS mail_fts_body AFTER INSERT ON bodies BEGIN
    ${PUT('new.message_id')}
  END;
  CREATE TRIGGER IF NOT EXISTS mail_fts_body_new AFTER UPDATE OF text ON bodies WHEN old.text IS NOT new.text BEGIN
    ${PUT('new.message_id')}
  END;
  CREATE TRIGGER IF NOT EXISTS mail_fts_body_gone AFTER DELETE ON bodies BEGIN
    ${PUT('old.message_id')}
  END;`;

let state = null;     // null: not looked yet · 'on' · 'off' (the database cannot do it)
let looking = null;
let batch = 40;
let built = false;    // the build of the mails of before is through (said once in the log)
let said = null;      // what the log was told last: 'building' | 'full'

function reset() { state = null; looking = null; batch = 40; built = false; said = null; }

/** The size of the database file in bytes, or 0 when it cannot be asked. */
async function dbBytes(gc) {
  try {
    const r = await store.one(gc, 'SELECT (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size()) AS n');
    return Number(r && r.n) || 0;
  } catch { return 0; }
}

/** Table and triggers (made once; IF NOT EXISTS) → is the index there? Never throws. */
function ensure(gc) {
  if (state) return Promise.resolve(state === 'on');
  if (!looking) {
    looking = (async () => {
      try {
        await gc.db.exec(SCHEMA);
        state = 'on';
      } catch (e) {
        state = 'off';
        gc.log.info('search index not available — the search works as before', String((e && e.message) || e).slice(0, 160));
      }
      looking = null;
      return state === 'on';
    })();
  }
  return looking;
}

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

/** Mails the index does not hold yet (the build's rest). */
async function pending(gc) {
  const r = await store.one(gc, 'SELECT COUNT(*) AS n FROM messages WHERE fts <> 1 AND fts = 0');
  return r ? r.n : 0;
}

/**
 * The background run's part: the mails of before into the index, newest first, in batches of one transaction each —
 * for limits.tickMs at most and while left() (the run's rest in ms) lasts. → mails put in. A slow batch (a slow disk)
 * makes the next one smaller.
 */
async function tick(gc, left) {
  if (built || !(await ensure(gc))) return 0;
  const started = Date.now();
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
      if (await dbBytes(gc) > limits.maxBytes) {
        if (said !== 'full') { said = 'full'; gc.log.warn('search index: the build rests — the database is nearly full; mails outside the index are searched the old way'); }
        return 0;
      }
      if (said !== 'building') { said = 'building'; gc.log.info('search index: building', `${await pending(gc)} mails to go`); }
    }
    const t0 = Date.now();
    const marks = store.marks(ids.length);
    await store.tx(gc, async () => {
      await store.run(gc, `DELETE FROM mail_fts WHERE rowid IN (${marks})`, ids);
      await store.run(gc, `INSERT INTO mail_fts (rowid, subject, sender, recipients, snippet, body)
        SELECT ${DOC} FROM messages m LEFT JOIN bodies b ON b.message_id = m.id WHERE m.id IN (${marks})`, ids);
      await store.run(gc, `UPDATE messages SET fts = ${STATE} WHERE id IN (${marks})`, ids);
    });
    n += ids.length;
    const ms = Date.now() - t0;
    if (ms > SLOW_MS) batch = Math.max(BATCH_MIN, Math.floor(batch / 2));
    else if (ms < FAST_MS) batch = Math.min(BATCH_MAX, batch * 2);
    if (Date.now() - started >= limits.tickMs || (left && left() <= 0)) break;
  }
  return n;
}

const isOn = () => state === 'on';

module.exports = { ensure, matchOf, pending, tick, reset, isOn, limits, BODY_MAX, MIN_CHARS };
