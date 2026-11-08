'use strict';

// Writes per request (1.5.2). GateControl's protocol of 8. 11.: "INSERT INTO people (user_id, lang, seen_at) … ON
// CONFLICT DO UPDATE" on every request of every app — ~300 ms each on a slow disk. Now the person is written once per
// 10 minutes (or when the language changes), a wall tablet is marked once.

const test = require('node:test');
const assert = require('node:assert/strict');
const people = require('../server/people');
const { withHost, ANNA, WALL, MIN } = require('./helpers');

const peopleWrites = (host) => host.dbWrites.filter((w) => /INTO people/.test(w.sql || ''));

test('an hour of an app polling every 30 s: the person is written once per 10 minutes', async () => {
  await withHost({}, async (host, c) => {
    const anna = c.as(ANNA, 'anna-phone');
    host.resetDbWrites();
    for (let i = 0; i < 120; i++) {
      const r = await anna('GET', 'pending');
      assert.equal(r.status, 200);
      c.clock.add(30000);
    }
    // the household's apps were seen just before (helpers): 5 or 6 writes in the hour, never 120
    const per = 60 / (people.TOUCH_EVERY_MS / MIN);
    assert.ok(peopleWrites(host).length >= per - 1 && peopleWrites(host).length <= per, `people writes: ${peopleWrites(host).length}`);
    assert.ok(host.dbWrites.length <= 12, `writes in the hour: ${host.dbWrites.length} (people + devices_seen)`);
    // a changed language is written at once
    const viewer = { ...ANNA, portal: true, loggedIn: true, app: true, device: { id: 'anna-phone', platform: 'android' } };
    await host.request({ method: 'GET', path: 'pending', user: viewer, lang: 'de', query: {} });
    host.resetDbWrites();
    await host.request({ method: 'GET', path: 'pending', user: viewer, lang: 'en', query: {} });
    assert.equal(peopleWrites(host).length, 1);
    assert.equal(await people.langOf(host.gc, ANNA.id), 'en');
  });
});

test('a wall tablet is marked as a kiosk device once, not with every request', async () => {
  await withHost({}, async (host) => {
    host.resetDbWrites();
    for (let i = 0; i < 10; i++) await people.markKiosk(host.gc, WALL.id);
    assert.equal(peopleWrites(host).length, 1);
    assert.ok((await people.kioskIds(host.gc)).has(WALL.id));
  });
});
