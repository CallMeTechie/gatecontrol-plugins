'use strict';

// The mock host's mirror of GateControl 1.231.0 gc.homeNetwork.internet (src/services/homeInternet.js, hostApi.js
// internetCall, plugins/personContext.js writers, the child bootstrap's makeHomeNetwork): only with
// permissions.homeInternet, changes only inside a changing request of a signed-in person (the actors), the host's codes
// and limits (pause ≤ 7 days, extend from the end of a running extension, ≤ 24 h, 0 ends it).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mock } = require('node:test');
const { createHost } = require('../testing/mock-host');

const USERS = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna', role: 'user' }, { id: 3, name: 'Tim', role: 'user' }, { id: 4, name: 'Weg', role: 'user', disabled: true }];
const T0 = Date.parse('2026-11-05T16:00:00Z');
const MIN = 60000;

// a plugin whose request hook calls gc.homeNetwork.internet[op](...args) and answers { ok, result } or { ok: false, code }
const CODE = `
module.exports = {
  async request(req, gc) {
    const b = req.body || {};
    try { return { json: { ok: true, result: await gc.homeNetwork.internet[b.op](...(b.args || [])) } }; } catch (e) { return { json: { ok: false, code: e.code } }; }
  },
};`;

function plugin(perms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hi-plugin-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'hi-test', name: 'H', version: '1.0.0', entry: 'server/index.js', permissions: perms }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), CODE);
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('gc.homeNetwork.internet: only with permissions.homeInternet, from GateControl 1.231.0 or with opts.homeInternet', async () => {
  const p = plugin({ homeInternet: true });
  const both = plugin({ homeInternet: true, homePresence: true });
  const none = plugin({ homePresence: true });
  try {
    for (const [dir, o, has, presence] of [[p.dir, {}, false, false], [p.dir, { gatecontrol: '1.230.0' }, false, false], [p.dir, { gatecontrol: '1.231.0' }, true, false],
      [p.dir, { homeInternet: {} }, true, false], [none.dir, { gatecontrol: '1.231.0' }, false, true], [both.dir, { gatecontrol: '1.231.0' }, true, true],
      [both.dir, { gatecontrol: '1.230.0' }, false, true]]) {
      const h = await createHost(dir, o);
      assert.equal(!!(h.gc.homeNetwork && h.gc.homeNetwork.internet), has, JSON.stringify(o));
      assert.equal(!!(h.gc.homeNetwork && h.gc.homeNetwork.presence), presence, JSON.stringify(o));
      await h.close();
    }
    const bad = plugin({ homeInternet: 'yes' });
    await assert.rejects(createHost(bad.dir, { gatecontrol: '1.231.0' }), (e) => e.code === 'ERR_INVALID');
    // an older GateControl ignores the key
    await (await createHost(bad.dir, { gatecontrol: '1.230.0' })).close();
    bad.done();
  } finally { p.done(); both.done(); none.done(); }
});

test('gc.homeNetwork.internet: status any time; pause, resume, extend only in a changing request of a person', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  const p = plugin({ homeInternet: true });
  const h = await createHost(p.dir, {
    users: USERS,
    homeInternet: { people: { 3: { devices: 2, profile: { id: 1, name: 'Kinder', gateway: 'Pi Keller' }, nextSchedule: { from: '2026-11-05T20:00:00.000Z', to: '2026-11-06T06:00:00.000Z', block: 'categories', categories: ['social', 'games', 'video'], active: false } } } },
  });
  await h.start();
  const as = (user, method, op, ...args) => h.request({ method, path: '/x', user, body: { op, args } }).then((r) => r.json);
  const anna = { ...USERS[1], portal: true, loggedIn: true };
  const I = h.gc.homeNetwork.internet;
  try {
    assert.deepEqual(await I.status(3), {
      userId: 3, profile: { id: 1, name: 'Kinder', gateway: 'Pi Keller' }, paused: null, extended: null,
      nextSchedule: { from: '2026-11-05T20:00:00.000Z', to: '2026-11-06T06:00:00.000Z', block: 'categories', categories: ['social', 'games', 'video'], active: false },
      devices: 2, filtered: true,
    });
    assert.deepEqual(await I.status(2), { userId: 2, profile: null, paused: null, extended: null, nextSchedule: null, devices: 0, filtered: false });
    await assert.rejects(I.status(4), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(I.status('3'), (e) => e.code === 'ERR_INVALID');
    // outside a request (start, tick, a hook), a GET, a device trust viewer, a kiosk device, an automation: never
    await assert.rejects(I.pause(3, 30), (e) => e.code === 'ERR_NOT_PERSON');
    assert.deepEqual(await as(anna, 'GET', 'pause', 3, 30), { ok: false, code: 'ERR_NOT_PERSON' });
    assert.deepEqual(await as({ ...anna, loggedIn: false }, 'POST', 'pause', 3, 30), { ok: false, code: 'ERR_NOT_PERSON' });
    assert.deepEqual(await as({ ...anna, kiosk: true }, 'POST', 'pause', 3, 30), { ok: false, code: 'ERR_NOT_PERSON' });
    assert.deepEqual(await as({ ...anna, automation: true }, 'POST', 'pause', 3, 30), { ok: false, code: 'ERR_NOT_PERSON' });
    assert.deepEqual(await as(anna, 'GET', 'status', 3), { ok: true, result: await I.status(3) });
    // wrong times
    for (const v of [0, 1.5, -3, 'morgen', '2026-11-05T15:00:00Z', 7 * 24 * 60 + 1, null]) assert.deepEqual(await as(anna, 'POST', 'pause', 3, v), { ok: false, code: 'ERR_INVALID' }, String(v));
    assert.deepEqual(await as(anna, 'POST', 'pause', 4, 30), { ok: false, code: 'ERR_INVALID' });
    // GateControl does not check who decides for whom — any signed-in person (the plugin checks)
    const r = await as(anna, 'POST', 'pause', 3, 30);
    assert.equal(r.result.paused, new Date(T0 + 30 * MIN).toISOString());
    assert.equal((await as(anna, 'POST', 'pause', 3, '2026-11-06T06:00:00.000Z')).result.paused, '2026-11-06T06:00:00.000Z');
    assert.deepEqual(h.homeInternet.log.map((x) => [x.op, x.userId, x.until, x.actors]), [['pause', 3, '2026-11-05T16:30:00.000Z', [2]], ['pause', 3, '2026-11-06T06:00:00.000Z', [2]]]);
    // resume: the pause ends, a second resume is not logged
    assert.equal((await as(anna, 'DELETE', 'resume', 3)).result.paused, null);
    await as(anna, 'POST', 'resume', 3);
    assert.equal(h.homeInternet.log.filter((x) => x.op === 'resume').length, 1);
    // extend: from now, then from the end of the running extension; ≤ 24 h; 0 ends it
    assert.equal((await as(anna, 'POST', 'extend', 3, 30)).result.extended, '2026-11-05T16:30:00.000Z');
    assert.equal((await as(anna, 'POST', 'extend', 3, 60)).result.extended, '2026-11-05T17:30:00.000Z');
    assert.deepEqual(await as(anna, 'POST', 'extend', 3, 23 * 60), { ok: false, code: 'ERR_INVALID' });
    assert.deepEqual(await as(anna, 'POST', 'extend', 3, -1), { ok: false, code: 'ERR_INVALID' });
    assert.deepEqual(await as(anna, 'POST', 'extend', 3, '30'), { ok: false, code: 'ERR_INVALID' });
    assert.equal((await as(anna, 'POST', 'extend', 3, 0)).result.extended, null);
    assert.deepEqual(h.homeInternet.log.at(-1), { op: 'extend', userId: 3, until: null, minutes: 0, actors: [2] });
    // what ended is gone from status
    await as(anna, 'POST', 'pause', 3, 10);
    mock.timers.setTime(T0 + 11 * MIN);
    assert.equal((await I.status(3)).paused, null);
    // GateControl's state changed elsewhere (e.g. the admin)
    h.homeInternetSet(3, { pause: T0 + 60 * MIN, devices: 0 });
    assert.deepEqual(await I.status(3), { userId: 3, profile: null, paused: '2026-11-05T17:00:00.000Z', extended: null, nextSchedule: null, devices: 0, filtered: false });
  } finally { await h.close(); p.done(); mock.timers.reset(); }
});

test('gc.homeNetwork.internet { actor } (GateControl 1.259.0): an automation acts for the person it names', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  const p = plugin({ homeInternet: true });
  const anna = { ...USERS[1], portal: true, loggedIn: true };
  try {
    // an older host: no flag, the argument is ignored
    const old = await createHost(p.dir, { users: USERS, gatecontrol: '1.258.0' });
    await old.start();
    assert.equal(old.gc.homeNetwork.internet.actors, undefined);
    await assert.rejects(old.gc.homeNetwork.internet.pause(3, 30, { actor: 2 }), (e) => e.code === 'ERR_NOT_PERSON');
    await old.close();
    for (const o of [{ gatecontrol: '1.259.0' }, { homeInternet: { actors: true } }]) {
      const h = await createHost(p.dir, { users: USERS, ...o });
      await h.start();
      const I = h.gc.homeNetwork.internet;
      assert.equal(I.actors, true);
      // outside a request: only with an actor, an enabled account
      await assert.rejects(I.pause(3, 30), (e) => e.code === 'ERR_NOT_PERSON');
      await assert.rejects(I.pause(3, 30, {}), (e) => e.code === 'ERR_NOT_PERSON');
      for (const actor of [4, 99, 0, '2', 1.5]) await assert.rejects(I.pause(3, 30, { actor }), (e) => e.code === 'ERR_INVALID', String(actor));
      assert.equal((await I.pause(3, 30, { actor: 2 })).paused, new Date(T0 + 30 * MIN).toISOString());
      assert.equal((await I.resume(3, { actor: 2 })).paused, null);
      assert.equal((await I.extend(3, 45, { actor: 2 })).extended, new Date(T0 + 45 * MIN).toISOString());
      assert.equal((await I.extend(3, 0, { actor: 2 })).extended, null);
      assert.deepEqual(h.homeInternet.log.map((x) => [x.op, x.actors, x.automated]), [['pause', [2], true], ['resume', [2], true], ['extend', [2], true], ['extend', [2], true]]);
      // inside somebody's request the named person is the actor; a person's own change is not marked
      const CODE2 = { method: 'POST', path: '/x', user: { ...USERS[2], portal: true, loggedIn: true } };
      assert.equal((await h.request({ ...CODE2, body: { op: 'pause', args: [3, 10, { actor: 2 }] } })).json.ok, true);
      assert.deepEqual([h.homeInternet.log.at(-1).actors, h.homeInternet.log.at(-1).automated], [[2], true]);
      assert.equal((await h.request({ method: 'POST', path: '/x', user: anna, body: { op: 'pause', args: [3, 10] } })).json.ok, true);
      assert.deepEqual([h.homeInternet.log.at(-1).actors, 'automated' in h.homeInternet.log.at(-1)], [[2], false]);
      await h.close();
    }
  } finally { p.done(); mock.timers.reset(); }
});

test('gc.homeNetwork.internet: without the permission no gc.homeNetwork at all', async () => {
  const p = plugin({});
  const h = await createHost(p.dir, { users: USERS, gatecontrol: '1.231.0', homeInternet: { people: { 3: { devices: 1 } } } });
  try {
    assert.equal(h.gc.homeNetwork, undefined);
  } finally { await h.close(); p.done(); }
});
