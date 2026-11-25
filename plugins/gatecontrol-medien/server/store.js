'use strict';

// Database access (migrations/001_init.sql). Writes run one transaction at a time in this process.

let chain = Promise.resolve();

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

async function all(gc, sql, params) {
  const r = await gc.db.query(sql, params || []);
  return (r && r.rows) || [];
}
async function one(gc, sql, params) {
  const r = await gc.db.get(sql, params || []);
  return (r && r.row) || null;
}
async function run(gc, sql, params) {
  return gc.db.run(sql, params || []);
}
const marks = (n) => new Array(n).fill('?').join(', ');

/** The change counter of everything the apps see (v1/sources `rev`). */
async function rev(gc) {
  const v = await gc.storage.get('rev');
  return Number.isSafeInteger(v) && v > 0 ? v : 1;
}
async function bump(gc) {
  const n = (await rev(gc)) + 1;
  await gc.storage.set('rev', n);
  return n;
}

/** A random key of the plugin (derives the Jellyfin DeviceIds), made once. */
async function pepper(gc) {
  let p = await gc.storage.get('pepper');
  if (typeof p !== 'string' || p.length < 32) {
    p = require('node:crypto').randomBytes(32).toString('hex');
    await gc.storage.set('pepper', p);
  }
  return p;
}

/** Rate limit: at most `max` hits of `bucket` within `windowMs` → true when allowed (and counted). */
async function hit(gc, bucket, max, windowMs, now = Date.now()) {
  const row = await one(gc, 'SELECT COUNT(*) AS n FROM hits WHERE bucket = ? AND at > ?', [bucket, now - windowMs]);
  if (row && row.n >= max) return false;
  await run(gc, 'INSERT INTO hits (bucket, at) VALUES (?, ?)', [bucket, now]);
  return true;
}

module.exports = { tx, all, one, run, marks, rev, bump, pepper, hit };
