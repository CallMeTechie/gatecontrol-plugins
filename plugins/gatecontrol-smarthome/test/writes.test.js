'use strict';

// Writes of the background sync (1.9.1). GateControl's protocol of 8. 11.: "UPDATE resources SET deconz_id = ?, …,
// state_json = ?" 935 times an hour, ~300 ms each on a slow disk — every sync (30 s) wrote every light, group, scene
// and sensor, changed or not, and "zuletzt gesehen" of the gateway. Now: an unchanged sync writes nothing, a change
// is one commit, the gateway's last_seen_at at most once a minute.

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../server/service');
const store = require('../server/store');
const { fakeDeconz, withHost, connected } = require('./helpers');

/** A flat with 24 lights, 6 groups with 3 scenes each and 14 sensors (a realistic deCONZ setup). */
function flat() {
  const lights = {};
  for (let i = 1; i <= 24; i++) lights[i] = { name: `Licht ${i}`, type: i % 4 ? 'Color temperature light' : 'On/Off plug-in unit', uniqueid: `l${i}`, state: { on: i % 2 === 0, bri: 200, ct: 300, reachable: true } };
  const groups = {};
  for (let g = 1; g <= 6; g++) groups[g] = { name: `Raum ${g}`, state: { any_on: g % 2 === 0 }, scenes: [1, 2, 3].map((n) => ({ id: String(n), name: `Szene ${n}` })) };
  const sensors = {};
  for (let i = 1; i <= 14; i++) sensors[i] = i % 2 ? { name: `Temp ${i}`, type: 'ZHATemperature', uniqueid: `t${i}`, state: { temperature: 2100 + i } } : { name: `Kontakt ${i}`, type: 'ZHAOpenClose', uniqueid: `c${i}`, state: { open: false } };
  return fakeDeconz({ lights, groups, sensors });
}

test('an unchanged sync writes nothing; a changed light is one commit; a missing one is switched off once', async () => {
  const gw = flat();
  await withHost({ gateways: [gw] }, async (host) => {
    const { id } = await connected(host);
    host.resetDbWrites();
    // 120 syncs = one hour at the default interval of 30 s, nothing changed
    for (let i = 0; i < 120; i++) await service.syncGatewayFull(host.gc, id);
    assert.deepEqual(host.dbWrites, [], 'an hour of unchanged syncs: no write');

    gw.lights[3].state.on = !gw.lights[3].state.on;
    gw.sensors[1].state.temperature = 2250;
    await service.syncGatewayFull(host.gc, id);
    assert.deepEqual(host.dbWrites.map((w) => [w.kind, w.changes]), [['commit', 2]], 'two changed resources: one commit');
    const temp = (await store.listResources(host.gc, id)).find((r) => r.name === 'Temp 1');
    assert.equal(temp.state.value, 22.5);

    host.resetDbWrites();
    delete gw.lights[24];
    await service.syncGatewayFull(host.gc, id);
    await service.syncGatewayFull(host.gc, id);
    assert.deepEqual(host.dbWrites.map((w) => [w.kind, w.changes]), [['commit', 1]], 'switched off once, not every sync');
    assert.equal((await store.listResources(host.gc, id)).find((r) => r.name === 'Licht 24').enabled, 0);
  });
});

test('"zuletzt gesehen" of a gateway: at most once a minute', async () => {
  await withHost({ gateways: [flat()] }, async (host) => {
    const { id } = await connected(host);
    const first = (await store.getGateway(host.gc, id)).last_seen_at;
    assert.ok(first, 'set by the first sync');
    const t = Date.now();
    assert.equal(await store.touchGateway(host.gc, id, t + 1000), false);
    assert.equal(await store.touchGateway(host.gc, id, t + store.TOUCH_MS + 1000), true);
  });
});
