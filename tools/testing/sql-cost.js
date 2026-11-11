'use strict';

// What a plugin's statements cost, checked without a fixed time limit — a limit in milliseconds fails on a busy CI
// runner although nothing is wrong (one UPDATE of a row took 465 ms there). Used by the speed tests of the plugins
// (node:sqlite in the mock host: every gc.db call is one prepared statement on the test's thread).
//
//   const rec = await record(async () => { …requests, background runs… })
//   rec.statements   Map(sql → { sql, db, method, runs, rows, ms, args })   ms and args: of the slowest run
//   rec.runs         statements run (N+1 queries show here: the number grows with the rows)
//   rec.rows         rows the statements gave back
//   rec.count(re)    runs of the statements matching `re`
//
//   fullReads(rec, { rows = 1000, allow = [] }) → ['SCAN nodes ← SELECT …', …]
//       the query plan of EVERY statement of the recording (EXPLAIN QUERY PLAN — the same on every machine): a table of
//       `rows` rows or more that is read as a whole — without an index (SCAN t), along a whole index (SCAN t USING
//       [COVERING] INDEX i) or through an index made for this one run (AUTOMATIC … INDEX). `allow`: RegExps of the
//       lines that are meant to be (say why beside each).
//   indexes(rec) → ['bodies_bytes', 'messages_list', …] the indexes the statements of the recording go by (their
//       plans again). A test names the ones its screens stand on: an index that is gone, or that a changed statement
//       no longer takes, is missing here — also where SQLite then takes another index and sorts, which reads no table
//       as a whole and may still be quick enough with the rows of a test.
//   plan(db, sql) → 'SEARCH m USING INDEX … / …'
//
//   tooSlow(rec, { unit, factor, runs = 5 }) → ['3.2 × the unit (41.0 ms, unit 12.8 ms) ← SELECT …', …]
//       for what a plan does not show (a search that matches nearly every row, a sort of all of them, a subquery per
//       row): the time of a statement against the time of `unit` in the same run, never against the clock. `unit`
//       is a statement of the test that stands for the data (say: every row of the largest table read once — what a
//       missing index costs). A statement whose recorded run took more than `factor` units is run again `runs` times,
//       each beside a run of the unit (writes inside a savepoint that is rolled back); it is too slow when the median
//       of its runs is above `factor` times the median of the unit's. A busy machine slows both alike; a statement
//       that really got slow is slow every time. A write that cannot be run again (its key is taken) counts as too
//       slow, but for an INSERT of one row (… VALUES …): that is no work that grows.
//   slowest(rec, unit, n = 3) → ['0.31 × SELECT …'] the slowest recorded runs in units, for a test's diagnostic
//
//   await ratio(fn, unit, runs = 5) → the median time of the async `fn` in units: the median time of the async `unit`,
//       run in turns with it — for a whole request against a piece of work of the same run (say: every row read once)

const sqlite = require('node:sqlite');
const { performance } = require('node:perf_hooks');

const METHODS = ['all', 'get', 'run'];
// no plan to ask for
const SKIP = /^(EXPLAIN|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const flat = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const median = (list) => { const s = [...list].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/** Every statement run while `fn` runs. */
async function record(fn) {
  const SP = sqlite.StatementSync.prototype;
  const DP = sqlite.DatabaseSync.prototype;
  const orig = { prepare: DP.prepare };
  for (const m of METHODS) orig[m] = SP[m];
  const dbOf = new WeakMap();
  const statements = new Map();
  const rec = { statements, runs: 0, rows: 0, count: (re) => [...statements.values()].filter((s) => re.test(s.sql)).reduce((n, s) => n + s.runs, 0) };
  DP.prepare = function prepare(...a) {
    const stmt = orig.prepare.apply(this, a);
    dbOf.set(stmt, this);
    return stmt;
  };
  for (const method of METHODS) {
    SP[method] = function measured(...args) {
      const t = performance.now();
      let out;
      try { out = orig[method].apply(this, args); return out; } finally {
        const ms = performance.now() - t;
        const sql = flat(this.sourceSQL);
        let s = statements.get(sql);
        if (!s) statements.set(sql, s = { sql, db: dbOf.get(this), method, runs: 0, rows: 0, ms: -1, args: [] });
        const n = Array.isArray(out) ? out.length : (method === 'get' && out ? 1 : 0);
        s.runs++; s.rows += n; rec.runs++; rec.rows += n;
        if (ms > s.ms) { s.ms = ms; s.args = args; s.method = method; }
      }
    };
  }
  try { await fn(); } finally { Object.assign(SP, Object.fromEntries(METHODS.map((m) => [m, orig[m]]))); DP.prepare = orig.prepare; }
  return rec;
}

/** The query plan of `sql` on a DatabaseSync, its steps joined by ' / '. */
function plan(db, sql) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' / ');
}

/** Map(table → rows) of the tables with `min` rows or more. */
function largeTables(db, min) {
  const out = new Map();
  // real tables only: a virtual table (FTS) answers a MATCH from its own index, its shadow tables are not asked directly
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' AND name NOT LIKE 'sqlite_%'").all()) {
    const n = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).get().n);
    if (n >= min) out.set(t.name.toLowerCase(), n);
  }
  return out;
}

/** The table behind `name` of a plan step: the table itself or its alias in `sql`; null: a subquery, a CTE, a small table. */
function tableOf(name, sql, large) {
  const n = name.toLowerCase();
  if (large.has(n)) return n;
  for (const t of large.keys()) {
    if (new RegExp(`(?:^|\\W)"?${t}"?\\s+(?:(?:NOT\\s+INDEXED|INDEXED\\s+BY\\s+\\w+)\\s+)?(?:AS\\s+)?"?${n}"?(?![\\w.])`, 'i').test(sql)
      || new RegExp(`(?:^|\\W)"?${t}"?\\s+(?:AS\\s+)?"?${n}"?\\s+(?:NOT\\s+INDEXED|INDEXED\\s+BY)\\b`, 'i').test(sql)) return t;
  }
  return null;
}

/** The large tables a statement of the recording reads as a whole → ['SCAN nodes ← SELECT …'] (see the top). */
function fullReads(rec, opts = {}) {
  const min = opts.rows || 1000;
  const allow = opts.allow || [];
  const tables = new Map();
  const out = [];
  for (const s of rec.statements.values()) {
    if (!s.db || !s.db.isOpen || SKIP.test(s.sql)) continue;
    if (!tables.has(s.db)) tables.set(s.db, largeTables(s.db, min));
    const large = tables.get(s.db);
    for (const step of s.db.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all().map((r) => String(r.detail))) {
      const m = /^(?:SCAN|SEARCH) (?:TABLE )?(\S+)(.*)$/.exec(step);
      if (!m || / VIRTUAL TABLE /.test(step)) continue;
      const whole = step.startsWith('SCAN ') || / AUTOMATIC /.test(m[2]);
      const table = whole && tableOf(m[1], s.sql, large);
      if (!table) continue;
      const line = `${step.replace(m[1], table)} ← ${s.sql}`;
      if (!allow.some((re) => re.test(line))) out.push(line);
    }
  }
  return out;
}

/** The indexes the statements of the recording go by, sorted (see the top). */
function indexes(rec) {
  const out = new Set();
  for (const s of rec.statements.values()) {
    if (!s.db || !s.db.isOpen || SKIP.test(s.sql)) continue;
    for (const r of s.db.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all()) {
      const m = / USING (?:COVERING )?INDEX (\S+)/.exec(String(r.detail));
      if (m) out.add(m[1]);
    }
  }
  return [...out].sort();
}

/** The statements of the recording that cost more than `factor` runs of `unit` → [text] (see the top). */
function tooSlow(rec, opts) {
  const { unit, factor } = opts;
  const runs = opts.runs || 5;
  if (typeof unit !== 'string' || !(factor > 0)) throw new Error('tooSlow: unit (a statement) and factor are needed');
  const timeOf = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
  const units = new Map();
  const unitOf = (db) => {
    if (!units.has(db)) {
      const stmt = db.prepare(unit);
      stmt.all();
      units.set(db, { stmt, ms: median(Array.from({ length: runs }, () => timeOf(() => stmt.all()))) });
    }
    return units.get(db);
  };
  const out = [];
  for (const s of rec.statements.values()) {
    if (!s.db || !s.db.isOpen || SKIP.test(s.sql)) continue;
    const u = unitOf(s.db);
    if (s.ms <= factor * u.ms) continue;
    // again, each run beside a run of the unit: what the machine does meanwhile slows both
    const mine = [];
    const theirs = [];
    let failed = null;
    for (let i = 0; i < runs && !failed; i++) {
      theirs.push(timeOf(() => u.stmt.all()));
      s.db.exec('SAVEPOINT gc_sql_cost');
      try {
        const stmt = s.db.prepare(s.sql);
        mine.push(timeOf(() => stmt[s.method](...s.args)));
      } catch (e) { failed = e; } finally { s.db.exec('ROLLBACK TO gc_sql_cost; RELEASE gc_sql_cost'); }
    }
    if (failed) {
      // a row that cannot be written twice (its key is taken now): one row is no work that grows; anything else counts
      if (/^INSERT\b(?:(?!\bSELECT\b).)*$/i.test(s.sql)) continue;
      out.push(`cannot be run again (${failed.message}), took ${s.ms.toFixed(1)} ms, unit ${u.ms.toFixed(1)} ms ← ${s.sql}`);
      continue;
    }
    const [a, b] = [median(mine), median(theirs)];
    if (a > factor * b) out.push(`${(a / b).toFixed(1)} × the unit (${a.toFixed(1)} ms, unit ${b.toFixed(1)} ms) ← ${s.sql}`);
  }
  return out;
}

/** The median time of `fn` over the median time of `unit`, `runs` runs of each in turns (see the top). */
async function ratio(fn, unit, runs = 5) {
  const mine = [];
  const theirs = [];
  await unit();
  for (let i = 0; i < runs; i++) {
    let t = performance.now();
    await unit();
    theirs.push(performance.now() - t);
    t = performance.now();
    await fn();
    mine.push(performance.now() - t);
  }
  return median(mine) / median(theirs);
}

/** The slowest statements against the unit, for a test's diagnostic → ['0.31 × SELECT …']. */
function slowest(rec, unit, n = 3) {
  const per = new Map();
  const ms = (db) => { if (!per.has(db)) { const st = db.prepare(unit); st.all(); const t = performance.now(); st.all(); per.set(db, performance.now() - t); } return per.get(db); };
  return [...rec.statements.values()].filter((s) => s.db && s.db.isOpen).sort((a, b) => b.ms - a.ms).slice(0, n).map((s) => `${(s.ms / ms(s.db)).toFixed(2)} × ${s.sql.slice(0, 90)}`);
}

module.exports = { record, plan, fullReads, indexes, tooSlow, ratio, slowest, largeTables };
