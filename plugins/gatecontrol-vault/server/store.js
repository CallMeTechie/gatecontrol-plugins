'use strict';

// Database access helpers (migrations/001_init.sql). Every change runs in
// one transaction at a time (BEGIN … COMMIT over the host's single
// connection to the plugin database), serialised in this process — the
// request handlers and the background run never interleave their writes.

let chain = Promise.resolve();

/** Run fn inside a transaction; never nest. */
function tx(gc, fn) {
  const run = async () => {
    await gc.db.exec('BEGIN');
    try {
      const out = await fn();
      await gc.db.exec('COMMIT');
      return out;
    } catch (e) {
      await gc.db.exec('ROLLBACK').catch(() => {});
      throw e;
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/** Rows of a query (the host answers { rows }). */
async function all(gc, sql, params) {
  const r = await gc.db.query(sql, params || []);
  return (r && r.rows) || [];
}

/** One row or null (the host answers { row }). */
async function one(gc, sql, params) {
  const r = await gc.db.get(sql, params || []);
  return (r && r.row) || null;
}

/** { changes, lastInsertRowid } */
function run(gc, sql, params) {
  return gc.db.run(sql, params || []);
}

/** "?,?,?" for n parameters. */
const marks = (n) => new Array(n).fill('?').join(',');

/** The next value of the global change counter the apps sync with (call inside tx). */
async function nextSeq(gc) {
  await run(gc, "UPDATE meta SET value = value + 1 WHERE key = 'seq'");
  return (await one(gc, "SELECT value FROM meta WHERE key = 'seq'")).value;
}

async function currentSeq(gc) {
  return (await one(gc, "SELECT value FROM meta WHERE key = 'seq'")).value;
}

/** A line in the event log — what happened, never content (detail: e.g. where and how long a Wi-Fi share runs). */
function event(gc, at, userId, action, vaultId, itemId, detail) {
  return run(gc, 'INSERT INTO events (at, user_id, action, vault_id, item_id, detail) VALUES (?, ?, ?, ?, ?, ?)', [at, userId, action, vaultId || null, itemId || null, detail || null]);
}

module.exports = { tx, all, one, run, marks, nextSeq, currentSeq, event };
