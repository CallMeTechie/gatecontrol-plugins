'use strict';

// The background run (permissions.background, every 5 minutes): emergency requests whose waiting time passed are
// released, entries 30 days in the trash are purged (a tombstone stays for the apps), events older than 90 days go.

const store = require('./store');
const people = require('./people');
const items = require('./items');
const emergency = require('./emergency');

const DAY = 86400000;
const EVENTS_DAYS = 90;
const PURGE_BATCH = 500;

async function tick(gc, now) {
  const users = await people.users(gc);
  const released = await emergency.release(gc, now, users);
  const purged = await store.tx(gc, async () => {
    const old = await store.all(gc, 'SELECT id FROM items WHERE state = 1 AND trashed_at <= ? LIMIT ?', [now - items.LIMITS.trashDays * DAY, PURGE_BATCH]);
    for (const r of old) await items.purgeRow(gc, r.id, await store.nextSeq(gc));
    await store.run(gc, 'DELETE FROM events WHERE at < ?', [now - EVENTS_DAYS * DAY]);
    return old.length;
  });
  return { released, purged };
}

module.exports = { tick };
