'use strict';

// The mock host's mirror of GateControl 1.230.0 gc.homeNetwork.presence (src/services/homePresence.js, hostApi.js
// presenceCall, plugins/personContext.js, the child bootstrap's makeHomeNetwork): only with permissions.homePresence,
// the person check of setConsent / setCounts / devices, the host's codes, the hook to the on() handlers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('../testing/mock-host');

const USERS = [{ id: 1, name: 'admin', role: 'admin' }, { id: 2, name: 'Anna', role: 'user' }, { id: 3, name: 'Marc', role: 'user' }, { id: 4, name: 'Weg', role: 'user', disabled: true }];

// a plugin whose request hook calls gc.homeNetwork.presence[op](...args) and answers { ok, result } or { ok: false, code }
const CODE = `
const events = [];
module.exports = {
  async start(gc) { if (gc.homeNetwork) gc.homeNetwork.presence.on((ev) => { events.push(ev); if (ev.userId === 99) throw new Error('boom'); }); },
  async request(req, gc) {
    if (req.path === '/events') return { json: { events } };
    const b = req.body || {};
    try { return { json: { ok: true, result: await gc.homeNetwork.presence[b.op](...(b.args || [])) } }; } catch (e) { return { json: { ok: false, code: e.code } }; }
  },
};`;

function plugin(perms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hn-plugin-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'hn-test', name: 'H', version: '1.0.0', entry: 'server/index.js', permissions: perms }));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), CODE);
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('gc.homeNetwork: only with permissions.homePresence, from GateControl 1.230.0 or with opts.homeNetwork', async () => {
  const p = plugin({ homePresence: true });
  const none = plugin({});
  try {
    for (const [dir, o, has] of [[p.dir, {}, false], [p.dir, { gatecontrol: '1.229.0' }, false], [p.dir, { gatecontrol: '1.230.0' }, true], [p.dir, { homeNetwork: {} }, true],
      [none.dir, { gatecontrol: '1.230.0', homeNetwork: {} }, false]]) {
      const h = await createHost(dir, o);
      assert.equal(!!h.gc.homeNetwork, has, JSON.stringify(o));
      await h.close();
    }
    const bad = plugin({ homePresence: 'yes' });
    await assert.rejects(createHost(bad.dir, { gatecontrol: '1.230.0' }), (e) => e.code === 'ERR_INVALID');
    // an older GateControl ignores the key
    await (await createHost(bad.dir, { gatecontrol: '1.229.0' })).close();
    bad.done();
  } finally { p.done(); none.done(); }
});

test('gc.homeNetwork.presence: list, consent; setConsent, setCounts and devices only in a request of that person', async () => {
  const p = plugin({ homePresence: true });
  const h = await createHost(p.dir, {
    users: USERS,
    homeNetwork: {
      consent: { 2: true },
      devices: [
        { id: 11, userId: 2, name: 'Annas Handy', gateway: 'Pi Keller', online: true, at: Date.parse('2026-11-05T08:00:00Z') },
        { id: 12, userId: 2, name: 'Annas iPad', gateway: 'Pi Keller', counts: false },
        { id: 21, userId: 3, name: 'Marcs Handy', gateway: 'Pi Keller', online: false, at: Date.parse('2026-11-05T07:00:00Z') },
      ],
    },
  });
  await h.start();
  const as = (user, method, op, ...args) => h.request({ method, path: '/x', user, body: { op, args } }).then((r) => r.json);
  const anna = { ...USERS[1], portal: true, loggedIn: true };
  const marc = { ...USERS[2], portal: true, loggedIn: true, app: true };
  try {
    assert.deepEqual(await h.gc.homeNetwork.presence.list(), [{ userId: 2, home: true, since: '2026-11-05T08:00:00.000Z', source: 'wifi' }]);
    assert.deepEqual((await h.gc.homeNetwork.presence.consent(3)).consent, false);
    await assert.rejects(h.gc.homeNetwork.presence.consent(4), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(h.gc.homeNetwork.presence.consent('2'), (e) => e.code === 'ERR_INVALID');
    // outside a request (start, tick, a hook): never
    await assert.rejects(h.gc.homeNetwork.presence.setConsent(3, true), (e) => e.code === 'ERR_NOT_PERSON');
    await assert.rejects(h.gc.homeNetwork.presence.devices(2), (e) => e.code === 'ERR_NOT_PERSON');
    // a GET of the person: devices yes, changes no
    assert.deepEqual(await as(anna, 'GET', 'devices', 2), { ok: true, result: [
      { id: 12, name: 'Annas iPad', lastSeen: null, counts: false, gateway: 'Pi Keller' },
      { id: 11, name: 'Annas Handy', lastSeen: '2026-11-05T08:00:00.000Z', counts: true, gateway: 'Pi Keller' },
    ].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())) });
    assert.deepEqual(await as(anna, 'GET', 'setConsent', 2, false), { ok: false, code: 'ERR_NOT_PERSON' });
    // somebody else, a device trust viewer, a kiosk device, an automation: no
    assert.deepEqual(await as(anna, 'PUT', 'setConsent', 3, true), { ok: false, code: 'ERR_NOT_PERSON' });
    assert.deepEqual(await as(anna, 'GET', 'devices', 3), { ok: false, code: 'ERR_NOT_PERSON' });
    assert.deepEqual(await as({ ...anna, loggedIn: false }, 'PUT', 'setConsent', 2, false), { ok: false, code: 'ERR_NOT_PERSON' });
    assert.deepEqual(await as({ ...anna, kiosk: true }, 'PUT', 'setConsent', 2, false), { ok: false, code: 'ERR_NOT_PERSON' });
    assert.deepEqual(await as({ ...anna, automation: true }, 'PUT', 'setConsent', 2, false), { ok: false, code: 'ERR_NOT_PERSON' });
    assert.deepEqual(await as(anna, 'PUT', 'setConsent', 2, 'no'), { ok: false, code: 'ERR_INVALID' });
    // the person themselves (portal or app): yes — Marc agrees, his phone is known (away) → an event
    assert.deepEqual(await as(marc, 'POST', 'setConsent', 3, true), { ok: true, result: { consent: true } });
    await h.homePresenceIdle();
    assert.deepEqual(h.homePresenceEvents.map((e) => [e.userId, e.home]), [[3, false]]);
    assert.deepEqual((await h.gc.homeNetwork.presence.list()).map((x) => [x.userId, x.home]), [[2, true], [3, false]]);
    // the gateway sees Marc's phone → home; an older report changes nothing
    await h.homeDevice(21, true, { at: Date.parse('2026-11-05T09:00:00Z') });
    assert.deepEqual(h.homePresenceEvents.at(-1), { userId: 3, home: true, since: '2026-11-05T09:00:00.000Z', source: 'wifi' });
    assert.deepEqual(await h.homeDevice(21, false, { at: Date.parse('2026-11-05T08:30:00Z') }), { accepted: 0 });
    // setCounts: only own devices; the last counting device goes → no longer known (null)
    assert.deepEqual(await as(marc, 'PUT', 'setCounts', 3, 11, false), { ok: false, code: 'ERR_NOT_FOUND' });
    assert.deepEqual(await as(marc, 'PUT', 'setCounts', 3, 21, 'nein'), { ok: false, code: 'ERR_INVALID' });
    assert.deepEqual(await as(marc, 'PUT', 'setCounts', 3, 21, false), { ok: true, result: { counts: false } });
    await h.homePresenceIdle();
    assert.equal(h.homePresenceEvents.at(-1).home, null);
    // withdrawing the consent: null as well, list() without her
    assert.deepEqual(await as(anna, 'DELETE', 'setConsent', 2, false), { ok: true, result: { consent: false } });
    await h.homePresenceIdle();
    assert.deepEqual(h.homePresenceEvents.at(-1).userId, 2);
    assert.deepEqual(await h.gc.homeNetwork.presence.list(), []);
    // the plugin got every event; a handler that throws is logged
    const seen = (await h.request({ path: '/events', user: anna })).json.events;
    assert.deepEqual(seen.map((e) => [e.userId, e.home]), h.homePresenceEvents.map((e) => [e.userId, e.home]));
    await h.homePresenceEmit({ userId: 99, home: true, since: null });
    assert.ok(h.logs.some((l) => l.level === 'error' && /homeNetwork\.presence\.on handler failed/.test(l.message)));
  } finally { await h.close(); p.done(); }
});
