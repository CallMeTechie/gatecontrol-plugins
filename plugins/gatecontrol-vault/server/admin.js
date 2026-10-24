'use strict';

// The admin page "Übersicht": counts and who has set up Vault — nothing an administrator could read entries with
// (there is nothing readable on the server).

const store = require('./store');
const people = require('./people');
const { iso } = require('./util');
const wifi = require('./wifi');

async function overview(gc) {
  const users = await people.users(gc);
  const c = async (sql, p) => (await store.one(gc, sql, p || [])).n;
  const accounts = await store.all(gc, 'SELECT user_id, created_at, seen_at FROM accounts ORDER BY created_at');
  return {
    counts: {
      accounts: accounts.length,
      sharedVaults: await c("SELECT COUNT(*) AS n FROM vaults WHERE kind = 'shared'"),
      items: await c('SELECT COUNT(*) AS n FROM items WHERE state = 0'),
      trash: await c('SELECT COUNT(*) AS n FROM items WHERE state = 1'),
      emergency: await c('SELECT COUNT(*) AS n FROM emergency'),
      emergencyOpen: await c("SELECT COUNT(*) AS n FROM emergency WHERE status != 'ready'"),
      wifiShares: await wifi.counts(gc),
    },
    accounts: accounts.map((a) => ({
      userId: a.user_id,
      name: (users.get(a.user_id) && users.get(a.user_id).name) || `#${a.user_id}`,
      createdAt: iso(a.created_at),
      seenAt: iso(a.seen_at),
    })),
  };
}

module.exports = { overview };
