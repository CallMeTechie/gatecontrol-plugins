'use strict';

// The edge part's MQTT normaliser and commands (edge/normalize.js, edge/commands.js) with messages as Shelly
// Gen1/Gen2+ and Tasmota devices publish them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, apply, snapshot, newDevice } = require('../edge/normalize');
const commands = require('../edge/commands');

const buf = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v));

/** Feed messages into one device record → its snapshot. */
function feed(messages) {
  let dev = null;
  for (const [topic, payload] of messages) {
    const r = parse(topic, buf(payload));
    if (!r) continue;
    dev = dev || newDevice(r.base, r.family);
    if (r.family) dev.family = r.family;
    apply(dev, r.patch);
  }
  return dev && snapshot(dev);
}

test('Shelly Gen2: status/switch:0 with power and energy, online', () => {
  const s = feed([
    ['shellies/licht-flur/online', 'true'],
    ['shellies/licht-flur/status/switch:0', {
      id: 0, source: 'MQTT', output: true, apower: 38.4, voltage: 231.2, freq: 50, current: 0.21,
      aenergy: { total: 1234.567, by_minute: [12.1, 11.9, 12], minute_ts: 1730800000 }, temperature: { tC: 41.2, tF: 106.2 },
    }],
  ]);
  assert.deepEqual(s, {
    base: 'shellies/licht-flur', family: 'shelly2', online: true,
    ch: { 'switch:0': { on: true, power: 38.4, energy: 1234.567 } }, sensor: {}, info: {}, drop: [],
  });
});

test('Shelly Gen2: events/rpc NotifyStatus / NotifyFullStatus (cover, light, H&T), other events ignored', () => {
  const s = feed([
    ['shellies/rollo-wz/events/rpc', {
      src: 'shellyplus2pm-a8032ab1c2d4', dst: 'shellies/rollo-wz/events', method: 'NotifyFullStatus',
      params: { ts: 1730800000.12, 'cover:0': { id: 0, state: 'stopped', current_pos: 60, apower: 0, aenergy: { total: 10 } }, sys: { mac: 'A8032AB1C2D4' }, wifi: { rssi: -60 } },
    }],
    ['shellies/rollo-wz/events/rpc', { src: 'shellyplus2pm-a8032ab1c2d4', method: 'NotifyStatus', params: { ts: 1, 'cover:0': { id: 0, state: 'opening' } } }],
    ['shellies/rollo-wz/events/rpc', { src: 'shellyplus2pm-a8032ab1c2d4', method: 'NotifyEvent', params: { ts: 1, events: [{ component: 'input:0', event: 'single_push' }] } }],
  ]);
  assert.deepEqual(s.ch, { 'cover:0': { pos: 60, moving: 'opening', power: 0 } });
  assert.equal(s.info.id, 'shellyplus2pm-a8032ab1c2d4');

  const dim = feed([['shellies/deckenlicht/status/light:0', { id: 0, source: 'init', output: true, brightness: 70, apower: 38 }]]);
  assert.deepEqual(dim.ch, { 'light:0': { on: true, bri: 70, power: 38 } });

  const ht = feed([
    ['shellies/klima-keller/status/temperature:0', { id: 0, tC: 14.83, tF: 58.7 }],
    ['shellies/klima-keller/status/humidity:0', { id: 0, rh: 63.4 }],
    ['shellies/klima-keller/status/devicepower:0', { id: 0, battery: { V: 5.6, percent: 82 }, external: { present: false } }],
  ]);
  assert.deepEqual(ht.sensor, { temperature: 14.8, humidity: 63, battery: 82, external: false }, 'on battery (external.present false): it sleeps');
  assert.deepEqual(ht.ch, {});
  assert.equal(feed([['shellies/klima-keller/status/devicepower:0', { id: 0, battery: { V: 5.6, percent: 100 }, external: { present: true } }]]).sensor.external, true, 'on USB power it stays awake');
});

test('Shelly Gen1: relay/0, relay/0/power, relay/0/energy, roller, dimmer, H&T, announce', () => {
  const relay = feed([
    ['shellies/pumpe/online', 'true'],
    ['shellies/pumpe/relay/0', 'on'],
    ['shellies/pumpe/relay/0/power', '512.30'],
    ['shellies/pumpe/relay/0/energy', '6000'],
    ['shellies/pumpe/input/0', '1'],
    ['shellies/pumpe/announce', { id: 'shelly1pm-84CCA8A1B2C3', model: 'SHSW-PM', mac: '84CCA8A1B2C3', ip: '192.168.1.40', new_fw: false, fw_ver: '20230913-114008/v1.14.0-gcb84623' }],
  ]);
  assert.equal(relay.family, 'shelly1');
  assert.deepEqual(relay.ch, { 'switch:0': { on: true, power: 512.3, energy: 100 } });
  assert.deepEqual(relay.info, { model: 'SHSW-PM', firmware: '20230913-114008/v1.14.0-gcb84623', ip: '192.168.1.40', mac: '84CCA8A1B2C3' });

  const roller = feed([['shellies/rollo/roller/0', 'close'], ['shellies/rollo/roller/0/pos', '35'], ['shellies/rollo/roller/0', 'stop']]);
  assert.deepEqual(roller.ch, { 'cover:0': { moving: null, pos: 35 } });
  assert.deepEqual(feed([['shellies/r2/roller/0/pos', '-1']]).ch, { 'cover:0': { pos: null } }, 'not calibrated');

  const dimmer = feed([['shellies/dim/light/0', 'on'], ['shellies/dim/light/0/status', { ison: true, has_timer: false, mode: 'white', brightness: 45 }]]);
  assert.deepEqual(dimmer.ch, { 'light:0': { on: true, bri: 45 } });

  const ht = feed([['shellies/ht/sensor/temperature', '21.25'], ['shellies/ht/sensor/humidity', '48.5'], ['shellies/ht/sensor/battery', '91']]);
  assert.deepEqual(ht.sensor, { temperature: 21.3, humidity: 49, battery: 91 });
});

test('Tasmota: LWT, tele/STATE, tele/SENSOR (ENERGY, AM2301), stat/RESULT, stat/POWER1', () => {
  const s = feed([
    ['tasmota/truhe/tele/LWT', 'Online'],
    ['tasmota/truhe/tele/STATE', { Time: '2026-11-05T10:00:00', Uptime: '0T06:00:00', Heap: 25, SleepMode: 'Dynamic', POWER: 'ON', Wifi: { AP: 1, SSId: 'home', RSSI: 70 } }],
    ['tasmota/truhe/tele/SENSOR', { Time: '2026-11-05T10:00:00', ENERGY: { TotalStartTime: '2026-01-01T00:00:00', Total: 312.4, Yesterday: 1.3, Today: 1.234, Power: 85, ApparentPower: 90, Voltage: 230, Current: 0.39 } }],
    ['tasmota/truhe/stat/POWER', 'OFF'],
  ]);
  assert.deepEqual(s, { base: 'tasmota/truhe', family: 'tasmota', online: true, ch: { 'switch:0': { on: false, power: 85, today: 1.234 } }, sensor: {}, info: {}, drop: [] });

  const two = feed([['tasmota/doppel/tele/STATE', { POWER1: 'ON', POWER2: 'OFF' }], ['tasmota/doppel/stat/RESULT', { POWER2: 'ON' }]]);
  assert.deepEqual(two.ch, { 'switch:0': { on: true }, 'switch:1': { on: true } });

  const klima = feed([['tasmota/keller/tele/SENSOR', { Time: 'x', AM2301: { Temperature: 14.84, Humidity: 63.2, DewPoint: 7.8 }, TempUnit: 'C' }]]);
  assert.deepEqual(klima.sensor, { temperature: 14.8, humidity: 63 });

  assert.equal(feed([['tasmota/truhe/tele/LWT', 'Offline']]).online, false);
});

test('Tasmota: a dimmer is light:0, a shutter takes its two relays (dropped once known)', () => {
  const dim = feed([['tasmota/flur/tele/STATE', { POWER: 'ON', Dimmer: 40 }], ['tasmota/flur/stat/RESULT', { POWER: 'OFF' }]]);
  assert.deepEqual(dim.ch, { 'light:0': { bri: 40, on: false } });

  const dev = newDevice('tasmota/rollo', 'tasmota');
  apply(dev, parse('tasmota/rollo/tele/STATE', buf({ POWER1: 'OFF', POWER2: 'OFF', POWER3: 'ON' })).patch);
  assert.deepEqual(Object.keys(dev.ch).sort(), ['switch:0', 'switch:1', 'switch:2']);
  apply(dev, parse('tasmota/rollo/tele/SENSOR', buf({ Shutter1: { Position: 60, Direction: 0, Target: 60, Tilt: 0 } })).patch);
  const s = snapshot(dev);
  assert.deepEqual(s.ch, { 'switch:2': { on: true }, 'cover:0': { pos: 60, moving: null } });
  assert.deepEqual(s.drop, ['switch:0', 'switch:1']);
  apply(dev, parse('tasmota/rollo/stat/RESULT', buf({ Shutter1: { Position: 62, Direction: 1, Target: 100 } })).patch);
  assert.deepEqual(dev.ch['cover:0'], { pos: 62, moving: 'opening' });
  apply(dev, parse('tasmota/rollo/stat/RESULT', buf({ POWER1: 'ON' })).patch);
  assert.equal(dev.ch['switch:0'], undefined, 'a shutter relay never comes back as a switch');
});

test('unknown and own messages are ignored cleanly', () => {
  for (const [topic, payload] of [
    ['shellies/x/rpc', { id: 1, src: 'shellies/x/gc', method: 'Switch.Set', params: { id: 0, on: true } }],
    ['shellies/x/gc/rpc', { id: 1, src: 'x', result: {} }],
    ['shellies/x/command', 'status_update'],
    ['shellies/x/relay/0/command', 'on'],
    ['shellies/x/status/sys', { mac: 'x' }],
    ['shellies/x/status/switch:0', 'not json {'],
    ['shellies/x/info', { wifi_sta: {} }],
    ['shellies/x/relay/0', 'maybe'],
    ['tasmota/x/cmnd/POWER1', 'ON'],
    ['tasmota/x/tele/STATE', '[1,2]'],
    ['tasmota/x/tele/UPTIME', { Uptime: 1 }],
    ['tasmota/x/stat/STATUS', { Status: {} }],
    ['other/x/state', 'on'],
    ['shellies/../relay/0', 'on'],
    ['shellies', 'on'],
  ]) {
    assert.equal(parse(topic, buf(payload)), null, topic);
  }
});

test('commands: Gen2 RPC, Gen1 topics, Tasmota cmnd; refresh; bad commands refused', () => {
  const one = (c) => commands.messages(c).map((m) => [m.topic, m.payload]);
  const rpc = (c) => commands.messages(c).map((m) => { const j = JSON.parse(m.payload); return [m.topic, j.method, j.params, j.src]; });
  assert.deepEqual(rpc({ base: 'shellies/a', family: 'shelly2', ch: 'switch:0', op: 'on' }), [['shellies/a/rpc', 'Switch.Set', { id: 0, on: true }, 'shellies/a/gc']]);
  assert.deepEqual(rpc({ base: 'shellies/a', family: 'shelly2', ch: 'light:0', op: 'bri', value: 55.4 }), [['shellies/a/rpc', 'Light.Set', { id: 0, on: true, brightness: 55 }, 'shellies/a/gc']]);
  assert.deepEqual(rpc({ base: 'shellies/a', family: 'shelly2', ch: 'cover:0', op: 'pos', value: 30 }), [['shellies/a/rpc', 'Cover.GoToPosition', { id: 0, pos: 30 }, 'shellies/a/gc']]);
  assert.deepEqual(rpc({ base: 'shellies/a', family: 'shelly2', ch: 'cover:1', op: 'stop' }), [['shellies/a/rpc', 'Cover.Stop', { id: 1 }, 'shellies/a/gc']]);
  assert.deepEqual(one({ base: 'shellies/b', family: 'shelly1', ch: 'switch:1', op: 'off' }), [['shellies/b/relay/1/command', 'off']]);
  assert.deepEqual(one({ base: 'shellies/b', family: 'shelly1', ch: 'light:0', op: 'bri', value: 20 }), [['shellies/b/light/0/set', '{"turn":"on","brightness":20}']]);
  assert.deepEqual(one({ base: 'shellies/b', family: 'shelly1', ch: 'cover:0', op: 'close' }), [['shellies/b/roller/0/command', 'close']]);
  assert.deepEqual(one({ base: 'shellies/b', family: 'shelly1', ch: 'cover:0', op: 'pos', value: 80 }), [['shellies/b/roller/0/command/pos', '80']]);
  assert.deepEqual(one({ base: 'tasmota/c', family: 'tasmota', ch: 'switch:1', op: 'on' }), [['tasmota/c/cmnd/POWER2', 'ON']]);
  assert.deepEqual(one({ base: 'tasmota/c', family: 'tasmota', ch: 'light:0', op: 'bri', value: 40 }), [['tasmota/c/cmnd/Dimmer', '40']]);
  assert.deepEqual(one({ base: 'tasmota/c', family: 'tasmota', ch: 'light:0', op: 'off' }), [['tasmota/c/cmnd/POWER1', 'OFF']]);
  assert.deepEqual(one({ base: 'tasmota/c', family: 'tasmota', ch: 'cover:0', op: 'open' }), [['tasmota/c/cmnd/ShutterOpen1', '']]);
  assert.deepEqual(one({ base: 'tasmota/c', family: 'tasmota', ch: 'cover:0', op: 'pos', value: 0 }), [['tasmota/c/cmnd/ShutterPosition1', '0']]);
  assert.deepEqual(commands.refresh({ base: 'shellies/a', family: 'shelly2' }).map((m) => [m.topic, m.payload]), [['shellies/a/command', 'status_update']]);
  assert.deepEqual(commands.refresh({ base: 'tasmota/c', family: 'tasmota' }).map((m) => m.payload), ['11', '10']);
  for (const bad of [
    { base: 'other/a', family: 'shelly2', ch: 'switch:0', op: 'on' },
    { base: 'shellies/a', family: 'shelly2', ch: 'switch:0', op: 'open' },
    { base: 'shellies/a', family: 'shelly2', ch: 'light:0', op: 'bri', value: 0 },
    { base: 'shellies/a', family: 'shelly2', ch: 'cover:0', op: 'pos', value: 101 },
    { base: 'shellies/a', family: 'zigbee', ch: 'switch:0', op: 'on' },
    { base: 'shellies/a/#', family: 'shelly2', ch: 'switch:0', op: 'on' },
    null,
  ]) assert.throws(() => commands.messages(bad), (e) => e.code === 'bad_command', JSON.stringify(bad));
});
