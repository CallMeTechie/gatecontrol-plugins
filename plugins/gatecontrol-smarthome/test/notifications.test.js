'use strict';

// Smart Home notifications: sensor observations, the pure transition logic
// (alerts.evaluate) and the path background sync → gc.notify({ topic, … })
// against the mock host with a fake deCONZ gateway.

const test = require('node:test');
const assert = require('node:assert/strict');
const alerts = require('../server/alerts');
const service = require('../server/service');
const manifest = require('../plugin.json');
const { fakeDeconz, withHost, asAdmin, connected, ADA } = require('./helpers');

const CFG = { windowMin: 15, batteryLow: 15, gatewayDownMin: 5, lang: 'de' };
const MIN = 60000;
const T0 = new Date(2026, 9, 11, 8, 0, 0).getTime(); // local time: battery days are local days
const GW = { id: 1, name: 'Wohnung' };

function obs(id, o = {}) {
  return { id: String(id), uniqueid: `u${id}`, name: `Sensor ${id}`, type: 'ZHAWater', alarm: null, alarmKind: null, open: null, battery: null, lowBattery: false, thermostat: false, heating: null, ...o };
}
/** Run evaluate over [[{ reachable, sensors }, minutesAfterT0], …]; returns "topic:kind" events. */
function run(seq, cfg = CFG) {
  let memo = null;
  const events = [];
  for (const [r, min] of seq) {
    const out = alerts.evaluate(memo, [{ gateway: GW, reachable: r.reachable !== false, sensors: r.sensors || [] }], cfg, T0 + min * MIN);
    memo = out.memo;
    events.push(...out.events.map((e) => `${e.topic}:${e.kind}`));
  }
  return { events, memo };
}

test('sensorObservation: alarm kinds, contact, battery, thermostat heating', () => {
  const o = service.sensorObservation;
  assert.deepEqual([o(1, { type: 'ZHAWater', state: { water: true } }).alarm, o(1, { type: 'ZHAWater', state: { water: true } }).alarmKind], [true, 'water']);
  assert.deepEqual([o(2, { type: 'ZHAFire', state: { fire: false } }).alarm, o(2, { type: 'ZHAFire', state: { fire: false } }).alarmKind], [false, 'smoke']);
  assert.equal(o(3, { type: 'ZHACarbonMonoxide', state: { carbonmonoxide: true } }).alarmKind, 'co');
  assert.equal(o(4, { type: 'ZHAAlarm', state: { alarm: true } }).alarmKind, 'alarm');
  assert.equal(o(5, { type: 'ZHATemperature', state: { temperature: 2100 } }).alarm, null);
  assert.equal(o(6, { type: 'ZHAOpenClose', state: { open: true }, config: { battery: 9 } }).open, true);
  assert.equal(o(6, { type: 'ZHAOpenClose', state: { open: true }, config: { battery: 9 } }).battery, 9);
  assert.equal(o(7, { type: 'ZHAOpenClose', state: { lowbattery: true } }).lowBattery, true);
  assert.equal(o(8, { type: 'ZHAThermostat', state: { on: false }, config: { mode: 'heat' } }).heating, true);
  assert.equal(o(8, { type: 'ZHAThermostat', state: { on: true }, config: { mode: 'off' } }).heating, false);
  assert.equal(o(8, { type: 'ZHAThermostat', state: { on: true }, config: {} }).heating, true);
  assert.equal(o(9, { type: 'ZHAPresence', state: { presence: true } }).heating, null);
});

test('first run: an alarm, an open window, a weak battery and a dead gateway that already were are not announced', () => {
  assert.deepEqual(run([[{ sensors: [obs(1, { alarm: true, alarmKind: 'water' }), obs(2, { open: true }), obs(3, { battery: 5 })] }, 0], [{ sensors: [obs(1, { alarm: true }), obs(2, { open: true }), obs(3, { battery: 5 })] }, 30]]).events, []);
  const down = run([[{ reachable: false }, 0], [{ reachable: false }, 10], [{ sensors: [] }, 20]]);
  assert.deepEqual(down.events, [], 'no "reachable again" without an announced outage');
});

test('alarm: high once per trigger, all-clear when it ends; flapping does not repeat while active', () => {
  const w = (alarm) => ({ sensors: [obs(1, { alarm, alarmKind: 'water' })] });
  assert.deepEqual(run([[w(false), 0], [w(true), 1], [w(true), 2], [w(null), 3], [w(true), 4], [w(false), 5], [w(true), 6]]).events,
    ['alarm:water', 'alarm:clear', 'alarm:water']);
});

test('window_open: after N minutes, once per opening; with thermostats only while heating', () => {
  const win = (open, extra = []) => ({ sensors: [obs(2, { type: 'ZHAOpenClose', open }), ...extra] });
  assert.deepEqual(run([[win(false), 0], [win(true), 1], [win(true), 10], [win(true), 16], [win(true), 40], [win(false), 41], [win(true), 42], [win(true), 60]]).events,
    ['window_open:open', 'window_open:open']);
  const th = (heating) => obs(9, { type: 'ZHAThermostat', thermostat: true, heating });
  assert.deepEqual(run([[win(false, [th(false)]), 0], [win(true, [th(false)]), 1], [win(true, [th(false)]), 30]]).events, []);
  assert.deepEqual(run([[win(false, [th(false)]), 0], [win(true, [th(false)]), 1], [win(true, [th(true)]), 30]]).events, ['window_open:heating']);
  assert.deepEqual(run([[win(false), 0], [win(true), 1], [win(true), 20]], { ...CFG, windowMin: 30 }).events, []);
});

test('battery_low: once per device and day, all of a gateway in one event', () => {
  const b = (x, y) => ({ sensors: [obs(3, { battery: x }), obs(4, { battery: y, lowBattery: y == null })] });
  const r = run([[b(50, 80), 0], [b(12, 80), 10], [b(11, 80), 20], [b(18, 80), 30], [b(12, null), 40], [b(10, null), 60 * 24 + 10]]);
  assert.deepEqual(r.events, ['battery_low:low', 'battery_low:low', 'battery_low:low']);
  const out = alerts.evaluate(r.memo, [{ gateway: GW, reachable: true, sensors: [obs(3, { battery: 9 }), obs(4, { battery: 9 })] }], CFG, T0 + 3 * 24 * 60 * MIN);
  assert.equal(out.events.length, 1);
  assert.deepEqual(out.events[0].items.map((o) => o.id), ['3', '4']);
});

test('battery_low: the sensors of one device are one entry (the lowest battery), other devices stay apart', () => {
  const mac = '00:15:8d:00:02:aa:bb:cc';
  const motion = (id, ep, battery) => obs(id, { uniqueid: `${mac}-01-${ep}`, name: 'Bewegungsmelder Wintergarten', type: 'ZHAPresence', battery });
  const sensors = (b) => [motion(10, '0406', b), motion(11, '0400', b), motion(12, '0402', b + 1), obs(13, { battery: b })];
  const r = run([[{ sensors: sensors(50) }, 0]]);
  const out = alerts.evaluate(r.memo, [{ gateway: GW, reachable: true, sensors: sensors(14) }], CFG, T0 + 10 * MIN);
  assert.equal(out.events.length, 1);
  assert.deepEqual(out.events[0].items.map((o) => [o.name, o.battery]), [['Bewegungsmelder Wintergarten', 14], ['Sensor 13', 14]]);
  const n = alerts.toNotification({ plugin: { id: 'gatecontrol-smarthome' } }, out.events[0], CFG, null);
  assert.equal(n.body, 'Bewegungsmelder Wintergarten 14 %, Sensor 13 14 % · Wohnung');
  assert.equal(n.data.facts.length, 2);
});

test('gateway_unreachable: after 5 minutes (high), "reachable again" with the same collapse key; sensors are kept while down', () => {
  const up = { sensors: [obs(1, { alarm: false, alarmKind: 'water' })] };
  const r = run([[up, 0], [{ reachable: false }, 1], [{ reachable: false }, 4], [{ reachable: false }, 6], [{ reachable: false }, 30], [up, 31], [{ reachable: false }, 32], [up, 33]]);
  assert.deepEqual(r.events, ['gateway_unreachable:down', 'gateway_unreachable:up']);
  assert.ok(r.memo.gateways[GW.id].sensors['u:u1'], 'sensor state survives the outage');
  const ev = { topic: 'gateway_unreachable', kind: 'down', gateway: GW, minutes: 5 };
  const gc = { plugin: { id: 'gatecontrol-smarthome' } };
  const down = alerts.toNotification(gc, ev, CFG, []);
  const back = alerts.toNotification(gc, { ...ev, kind: 'up' }, CFG, []);
  assert.equal(down.priority, 'high');
  assert.equal(back.priority, 'info');
  assert.equal(down.collapseKey, back.collapseKey);
  assert.equal(down.body, 'Wohnung antwortet seit 5 Minuten nicht');
});

test('every topic the plugin sends is declared in plugin.json (with a de/en label)', () => {
  const declared = new Map(manifest.notifyTopics.map((t) => [t.id, t]));
  for (const id of ['alarm', 'window_open', 'battery_low', 'gateway_unreachable']) {
    assert.ok(declared.has(id), id);
    assert.ok(declared.get(id).label.de && declared.get(id).label.en, id);
  }
  assert.equal(manifest.permissions.notify, true);
  assert.deepEqual(manifest.notifyTopics.filter((t) => t.default === false).map((t) => t.id), ['window_open']);
  assert.deepEqual(alerts.configOf({ notify_window_min: 1, notify_battery_low: 20, notify_lang: 'en' }), { windowMin: 15, batteryLow: 20, gatewayDownMin: 5, lang: 'en' });
});

const tick = async (host) => { host.plugin._state.lastSync = 0; await host.tick(); };

test('background sync → alarm (high) and all-clear via gc.notify({ topic, … }); weak batteries in one message', async () => {
  const gw = fakeDeconz({
    sensors: {
      20: { name: 'Wassermelder Bad', type: 'ZHAWater', uniqueid: 'w1', state: { water: false }, config: { battery: 90, reachable: true } },
      21: { name: 'Fenster Küche', type: 'ZHAOpenClose', uniqueid: 'c1', state: { open: false }, config: { battery: 40 } },
      22: { name: 'Rauchmelder Flur', type: 'ZHAFire', uniqueid: 'f1', state: { fire: false }, config: { battery: 70 } },
      30: { name: 'CLIP', type: 'CLIPGenericFlag', state: { flag: true } },
    },
  });
  await withHost({ gateways: [gw] }, async (host) => {
    await connected(host);
    await tick(host); // first background run: recorded only
    assert.deepEqual(host.notifications, []);

    gw.sensors[20].state.water = true;
    gw.sensors[21].config.battery = 9;
    gw.sensors[22].config.battery = 12;
    await tick(host);
    const [alarm, battery] = host.notifications;
    assert.equal(host.notifications.length, 2);
    assert.equal(alarm.topic, 'alarm');
    assert.equal(alarm.title, 'Wasser erkannt');
    assert.equal(alarm.body, 'Wassermelder Bad · Wohnung');
    assert.equal(alarm.priority, 'high');
    assert.equal(alarm.users, null, 'alarms go to everyone the topic rule names');
    assert.match(alarm.collapseKey, /^alarm:\d+:20$/);
    assert.equal(alarm.data.route, 'plg-gatecontrol-smarthome');
    assert.equal(alarm.data.actions[0].type, 'open_app_route');
    assert.equal(battery.topic, 'battery_low');
    assert.equal(battery.body, 'Fenster Küche 9 %, Rauchmelder Flur 12 % · Wohnung');

    await tick(host); // unchanged: nothing new
    assert.equal(host.notifications.length, 2);

    // restart: the open alarm is remembered, its end is still announced
    await host.stop();
    await host.start();
    gw.sensors[20].state.water = false;
    await tick(host);
    assert.equal(host.notifications.length, 3);
    assert.equal(host.notifications[2].title, 'Entwarnung');
    assert.equal(host.notifications[2].collapseKey, alarm.collapseKey);
  });
});

test('gateway down 5 minutes → high, back → info (same collapse key); window owners get the window message', async () => {
  const gw = fakeDeconz({ sensors: { 21: { name: 'Fenster Küche', type: 'ZHAOpenClose', uniqueid: 'c1', state: { open: false }, config: { battery: 80 } } } });
  await withHost({ gateways: [gw] }, async (host) => {
    const { id, by } = await connected(host);
    await asAdmin(host, 'PUT', `/resources/${by('Fenster Küche').id}/owners`, { userIds: [ADA.id] });
    const at = async (min) => {
      const r = await service.syncGatewayFull(host.gc, id);
      await alerts.check(host.gc, [{ gateway: { id, name: 'Wohnung' }, reachable: r.reachable, sensors: r.sensors }], { now: T0 + min * MIN });
    };
    await at(0);
    gw.sensors[21].state.open = true;
    await at(1);
    await at(17);
    assert.equal(host.notifications.length, 1);
    assert.equal(host.notifications[0].topic, 'window_open');
    assert.deepEqual(host.notifications[0].users, [ADA.id]);
    assert.equal(host.notifications[0].body, 'Fenster Küche ist seit 16 Minuten offen');

    gw.down = true;
    await at(20);
    await at(24);
    assert.equal(host.notifications.length, 1);
    await at(26);
    gw.down = false;
    await at(40);
    const [down, up] = host.notifications.slice(1);
    assert.deepEqual([down.topic, down.priority, down.title], ['gateway_unreachable', 'high', 'Gateway nicht erreichbar']);
    assert.deepEqual([up.priority, up.title], ['info', 'Gateway wieder erreichbar']);
    assert.equal(down.collapseKey, `gateway:${id}`);
    assert.equal(up.collapseKey, down.collapseKey);
  });
});

test('a gateway that refuses the key still counts as reachable', async () => {
  const gw = fakeDeconz();
  await withHost({ gateways: [gw] }, async (host) => {
    const { id } = await connected(host);
    gw.key = 'OTHERKEY12';
    gw.newKey = 'OTHERKEY13';
    const r = await service.syncGatewayFull(host.gc, id);
    assert.equal(r.reachable, true);
    gw.down = true;
    assert.equal((await service.syncGatewayFull(host.gc, id)).reachable, false);
  });
});
