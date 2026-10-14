'use strict';

// Once-only background pushes (table notices, migrations/002): a key per
// occasion — "ride:<id>:reminder:…", "ride:<id>:open:…", "age14:<child>:<date>"
// — is stored when the push is decided, so a restart or the next tick never
// sends it again. Rows go after 30 days.

const store = require('./store');

const KEEP_DAYS = 30;
const DAY = 86400000;

/** true the first time `key` is seen (and remembers it), false afterwards. Inside a transaction. */
async function once(gc, key, now) {
  const r = await store.run(gc, 'INSERT INTO notices (key, at) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', [String(key).slice(0, 200), now]);
  return !!(r && r.changes);
}

async function purge(gc, now) {
  await store.run(gc, 'DELETE FROM notices WHERE at < ?', [now - KEEP_DAYS * DAY]);
}

module.exports = { once, purge };
