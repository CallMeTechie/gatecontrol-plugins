'use strict';

// Writes per request (1.4.3). GateControl's protocol of 8. 11.: "INSERT INTO people (user_id, lang, seen_at) … ON
// CONFLICT DO UPDATE" on every request — ~300 ms each on a slow disk. Now the person and "zuletzt gesehen" of the
// account are written once per 10 minutes (or when the language changes), a wall tablet is marked once.

const test = require('node:test');
const assert = require('node:assert/strict');
const peopleMod = require('../server/people');
const { withHost, ANNA, WALL, MIN } = require('./helpers');

test('an hour of an app syncing every 30 s: the person and the account are written once per 10 minutes', async () => {
  await withHost({}, async (host, c) => {
    await c.setup(ANNA);
    host.resetDbWrites();
    for (let i = 0; i < 120; i++) {
      const r = await c.as(ANNA)('GET', 'sync', undefined, { since: '0' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      c.clock.add(30000);
    }
    const per = 60 / (peopleMod.TOUCH_EVERY_MS / MIN);
    // the setup just before wrote both: 5 or 6 each in the hour, never 120 (the account's seen_at goes in the sync's
    // transaction: a commit)
    const people = host.dbWrites.filter((w) => /INTO people/.test(w.sql || '')).length;
    const commits = host.dbWrites.filter((w) => w.kind === 'commit').length;
    assert.ok(people >= per - 1 && people <= per, `people: ${people}`);
    assert.ok(commits >= per - 1 && commits <= per, `sync commits (seen_at): ${commits}`);
    assert.equal(host.dbWrites.length, people + commits, JSON.stringify(host.dbWrites));
  });
});

test('a wall tablet is marked as a kiosk device once', async () => {
  await withHost({}, async (host) => {
    host.resetDbWrites();
    for (let i = 0; i < 10; i++) await peopleMod.markKiosk(host.gc, WALL.id);
    assert.equal(host.dbWrites.length, 1);
    assert.ok((await peopleMod.kioskIds(host.gc)).has(WALL.id));
  });
});
