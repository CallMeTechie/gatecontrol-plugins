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

// GateControl's database worker takes at most 100 parameters a statement: lists of ids go in parts of CHUNK
const CHUNK = 90;
/** `list` in parts of at most `n`. */
function chunks(list, n = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

module.exports = { tx, all, one, run, marks, chunks, CHUNK };
