'use strict';

// What 1.13.0 adds:
//   * the battery of a device as the badge of its quick action's widget (GateControl's widget.badge { icon, value,
//     unit, state, label }) — the mock host checks the badge as strictly as GateControl does; sensors and buttons on
//     batteries (Shelly H&T, deCONZ, zigbee2mqtt) become cards of the apps; a sleeping Shelly H&T shows its last value
//     with its age, an overdue one "Batterie leer?"; the threshold is the setting of the notification (default 15 %);
//     the page and the portal get the level of the battery symbol (battery_level);
//   * the kind of one output of a zigbee2mqtt device with several (light, plug, switch) — it stays over every report
//     and changes the icon and the quick action, never the device (Shelly / Tasmota had that per output already).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeDeconz, withHost, asAdmin, asPortal, connected, ADMIN, ADA } = require('./helpers');
const battery = require('../server/battery');
const zigbee = require('../server/zigbee');
const radio = require('../server/radio');

// GateControl's check of an icon (src/services/plugins/quickActions.js ICON_RE)
const ICON_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,2000}$/;
const FULL = battery.LEVEL_ICONS[3][1];
const HALF = battery.LEVEL_ICONS[2][1];
const EMPTY = battery.LEVEL_ICONS[0][1];

test('battery badge: level icon, value in %, warn at the threshold, crit at 5 % / the flag / overdue, label ≤ 20', () => {
  const now = Date.parse('2026-11-21T12:00:00.000Z');
  const b = (state, lowAt = 15, lang = 'de') => battery.badge(state, { lowAt, lang, now });
  assert.equal(b({}), null, 'no battery, no badge');
  assert.equal(b({ battery: null }), null);
  assert.deepEqual(b({ battery: 82 }), { icon: FULL, state: 'good', label: 'Batterie', value: 82, unit: '%' });
  assert.deepEqual(b({ battery: 60.4 }, 15, 'en'), { icon: HALF, state: 'good', label: 'Battery', value: 60, unit: '%' });
  assert.equal(b({ battery: 16 }).state, 'good');
  assert.equal(b({ battery: 15 }).state, 'warn', 'at the threshold: "Batterie schwach"');
  assert.equal(b({ battery: 15 }).icon, EMPTY);
  assert.equal(b({ battery: 25 }, 30).state, 'warn', 'the threshold of the setting');
  assert.equal(b({ battery: 5 }).state, 'crit');
  assert.equal(b({ battery: 4 }, 5).state, 'crit', 'with a threshold of 5 % straight to crit');
  assert.deepEqual(b({ lowbattery: true }), { icon: battery.EMPTY_ICON, state: 'crit', label: 'Batterie', value: 'schwach' }, 'deCONZ: low without a percentage');
  // a sleeping Shelly H&T: its last value with its age; silent for longer than it sleeps: "Batterie leer?"
  const twoH = new Date(now - 2 * 3600000 - 60000).toISOString();
  assert.deepEqual(b({ battery: 70, sleeping: true, reachable: true, lastupdated: twoH }), { icon: HALF, state: 'good', label: 'Batterie, vor 2 h', value: 70, unit: '%' });
  assert.equal(b({ battery: 70, sleeping: true, reachable: true, lastupdated: new Date(now - 12 * 60000).toISOString() }).label, 'Batterie, vor 12 min');
  assert.equal(b({ battery: 70, sleeping: true, reachable: true, lastupdated: new Date(now - 72 * 3600000).toISOString() }, 15, 'en').label, 'Battery, 3 d ago');
  assert.deepEqual(b({ battery: 70, sleeping: true, reachable: false, lastupdated: twoH }), { icon: HALF, state: 'crit', label: 'Batterie leer?', value: 70, unit: '%' });
  assert.equal(b({ battery: 70, reachable: false, lastupdated: twoH }).label, 'Batterie, vor 2 h', 'unreachable (zigbee2mqtt): the age of the value');
  for (const st of [{ battery: 0 }, { battery: 100 }, { lowbattery: true }, { battery: 3, sleeping: true, reachable: true, lastupdated: new Date(now - 59 * 60000).toISOString() }]) {
    for (const lang of ['de', 'en']) {
      const x = b(st, 15, lang);
      assert.match(x.icon, ICON_RE);
      assert.ok(x.label.length <= 20 && String(x.value).length <= 8, JSON.stringify(x));
    }
  }
});

const SENSORS = {
  10: { name: 'Temp Bad', type: 'ZHATemperature', uniqueid: '00:15:8d:00:01:02:03:04-01-0402', state: { temperature: 2150 }, config: { battery: 12, reachable: true } },
  11: { name: 'Feuchte Bad', type: 'ZHAHumidity', uniqueid: '00:15:8d:00:01:02:03:04-01-0405', state: { humidity: 4810 }, config: { battery: 90 } },
  14: { name: 'Fenster', type: 'ZHAOpenClose', uniqueid: 's1', state: { open: true, lowbattery: true }, config: {} },
  15: { name: 'Temp Flur', type: 'ZHATemperature', uniqueid: 't2', state: { temperature: 1900 } },
  16: { name: 'Taster', type: 'ZHASwitch', uniqueid: 'sw1', state: { buttonevent: 1002 }, config: { battery: 4 } },
};

test('deCONZ sensors on batteries: battery in the state, cards with the badge, the page and the portal', () => withHost({ gateways: [fakeDeconz({ sensors: SENSORS })] }, async (host) => {
  const { by, resources } = await connected(host);
  assert.deepEqual(by('Temp Bad').state, { type: 'temperature', value: 21.5, battery: 12 });
  assert.deepEqual(by('Fenster').state, { type: 'open', value: true, lowbattery: true });
  assert.deepEqual(by('Temp Flur').state, { type: 'temperature', value: 19 }, 'mains / no battery: as before');
  assert.deepEqual([by('Temp Bad').battery_low, by('Temp Bad').battery_level, by('Feuchte Bad').battery_level, by('Taster').battery_level], [true, 'warn', 'good', 'crit']);
  assert.ok(!('battery_level' in by('Temp Flur')), 'the page: no symbol without a battery');
  assert.ok(resources.every((r) => r.kind !== 'light' || !('battery_low' in r)));
  for (const n of ['Temp Bad', 'Feuchte Bad', 'Fenster', 'Temp Flur', 'Stehlampe']) await asAdmin(host, 'PUT', `/resources/${by(n).id}/owners`, { userIds: [ADA.id] });

  const qa = await host.quickActions(ADA);
  assert.deepEqual(qa.map((a) => [a.id, a.kind]).sort(), [
    [`light:${by('Stehlampe').id}`, 'toggle'],
    [`sensor:${by('Temp Bad').id}`, 'button'],
    [`sensor:${by('Feuchte Bad').id}`, 'button'],
    [`sensor:${by('Fenster').id}`, 'button'],
  ].sort(), 'a sensor without a battery stays out; buttons (deCONZ switches) have no owners');
  assert.equal(qa[0].id, `light:${by('Stehlampe').id}`, 'the switches first, the sensors after them');
  assert.equal(qa[0].widget.badge, null, 'a lamp on mains: no badge');
  const card = (n) => qa.find((a) => a.id === `sensor:${by(n).id}`);
  const temp = card('Temp Bad');
  assert.equal(temp.title, 'Temp Bad');
  assert.deepEqual(temp.widget, { label: 'Temperatur', value: '21,5', unit: '°C', status: 'Temperatur', state: null, readings: [], controls: [], power: false,
    badge: { icon: EMPTY, value: 12, unit: '%', state: 'warn', label: 'Batterie' } });
  assert.deepEqual(card('Fenster').widget.badge, { icon: battery.EMPTY_ICON, value: 'schwach', unit: null, state: 'crit', label: 'Batterie' });
  assert.deepEqual([card('Fenster').widget.value, card('Fenster').widget.state], ['offen', 'warn']);
  assert.deepEqual([card('Feuchte Bad').widget.value, card('Feuchte Bad').widget.unit, card('Feuchte Bad').widget.badge.value], ['48,1', '%', 90]);
  assert.ok(qa.slice(1).every((a) => a.device.id === `r:${a.id.split(':')[1]}` && ICON_RE.test(a.icon)));

  // a card shows, nothing runs: the answer is its widget as it is now; a control or a target is refused
  const r = (await host.runQuickAction(ADA, temp.id)).body;
  assert.equal(r.ok, true);
  assert.deepEqual(r.widget.badge, temp.widget.badge);
  assert.equal((await host.plugin.runQuickAction({ user: { ...ADA, portal: true, loggedIn: true, app: true }, lang: 'de', id: temp.id, target: 'on' }, host.gc)).ok, false);
  assert.equal((await host.plugin.runQuickAction({ user: { ...ADA, portal: true, loggedIn: true, app: true }, lang: 'de', id: `sensor:${by('Temp Flur').id}` }, host.gc)).ok, false, 'no battery: no card');
  assert.equal((await host.plugin.runQuickAction({ user: { id: 3, name: 'Bob', role: 'user', portal: true, loggedIn: true, app: true }, lang: 'de', id: temp.id }, host.gc)).ok, false, 'not the owner');

  // the threshold of the setting
  await host.gc.settings.set('notify_battery_low', 10);
  assert.equal((await host.quickActions(ADA)).find((a) => a.id === temp.id).widget.badge.state, 'good');

  // the portal: battery_level beside battery_low
  const p = (await asPortal(host, ADA, 'GET', '/portal')).json;
  const ps = Object.fromEntries(p.sensors.map((s) => [s.name, s.state]));
  assert.deepEqual([ps['Temp Bad'].battery, ps['Temp Bad'].battery_low, ps['Temp Bad'].battery_level], [12, undefined, 'good']);
  assert.deepEqual([ps.Fenster.lowbattery, ps.Fenster.battery_low, ps.Fenster.battery_level], [true, true, 'crit']);
  assert.ok(!('battery_level' in ps['Temp Flur']));
}));

const base = { gatewayId: 7, gateway: 'Pi Keller', online: true };
const now = () => new Date().toISOString();
const SWITCH2 = (o = {}) => ({ ...base, id: 'z2m:a4c1380000445566', ieee: 'a4:c1:38:00:00:44:55:66', name: 'Doppelschalter', model: 'TS0002', vendor: 'Tuya',
  kind: 'plug', caps: { channels: ['l1', 'l2'] }, values: { on: true, ch: { l1: true, l2: false } }, seenAt: now(), ...o });
const BLIND = (o = {}) => ({ ...base, id: 'z2m:000d6ffffe778899', ieee: '00:0d:6f:ff:fe:77:88:99', name: 'Rollo Bad', model: 'E1757', vendor: 'IKEA',
  kind: 'cover', caps: { position: true }, values: { pos: 40, battery: 9 }, seenAt: now(), ...o });
const BULB = (o = {}) => ({ ...base, id: 'z2m:000d6ffffe112244', ieee: '00:0d:6f:ff:fe:11:22:44', name: 'Akkulampe', model: 'X', vendor: 'Y',
  kind: 'light', caps: { bri: true }, values: { on: true, bri: 50, battery: 55 }, seenAt: now(), ...o });
const REMOTE_PLUG = (o = {}) => ({ ...base, id: 'z2m:000d6ffffe112255', ieee: '00:0d:6f:ff:fe:11:22:55', name: 'Akkudose', model: 'X', vendor: 'Y',
  kind: 'plug', caps: {}, values: { on: false, battery: 80 }, seenAt: now(), ...o });

async function withRadio(listFn, fn) {
  const sent = [];
  zigbee._mem.at = 0;
  radio._mem.at = 0;
  await withHost({ gateways: [], radio: {
    sensors: () => [],
    zigbee: () => ({ gateways: [{ id: 7, name: 'Pi Keller' }], devices: listFn() }),
    command: async (id, set) => { sent.push([id, set]); return { accepted: true }; },
  } }, async (host) => fn(host, sent));
}
const z2m = async (host) => { zigbee._mem.at = 0; return (await host.request({ path: '/ble/resources', query: { gateway_id: '7' }, user: ADMIN })).json.resources; };

test('zigbee2mqtt on batteries: the badge on a cover, a dimmable light and a plain plug (a small widget of its own)', () => withRadio(() => [BLIND(), BULB(), REMOTE_PLUG()], async (host) => {
  const res = await z2m(host);
  for (const r of res) await asAdmin(host, 'PUT', `/resources/${r.id}/owners`, { userIds: [ADA.id] });
  const qa = await host.quickActions(ADA);
  const of = (name) => qa.filter((a) => a.title === name || a.device.title === name);
  const bulb = of('Akkulampe')[0];
  assert.deepEqual(bulb.widget.badge, { icon: HALF, value: 55, unit: '%', state: 'good', label: 'Batterie' });
  assert.equal(bulb.widget.controls[0].id, 'bri', 'the widget stays the brightness widget');
  const plug = of('Akkudose')[0];
  assert.deepEqual(plug.widget, { label: null, value: 'Aus', unit: null, status: 'Steckdose', state: 'off', readings: [], controls: [], power: true,
    badge: { icon: FULL, value: 80, unit: '%', state: 'good', label: 'Batterie' } });
  const open = of('Rollo Bad').find((a) => a.id.endsWith(':open'));
  assert.deepEqual(open.widget.badge, { icon: EMPTY, value: 9, unit: '%', state: 'warn', label: 'Batterie' });
  // the answer of a run carries the badge too
  const r = (await host.runQuickAction(ADA, plug.id)).body;
  assert.equal(r.state, 'on');
  assert.deepEqual([r.widget.value, r.widget.badge.value], ['An', 80]);
  const c = (await host.runQuickAction(ADA, open.id, 'de', { control: 'pos', value: 70 })).body;
  assert.equal(c.widget.badge.state, 'warn');
}));

test('zigbee2mqtt: the kind of each output of a device with several — kept over the reports, on the quick action', () => withRadio(() => [SWITCH2()], async (host, sent) => {
  let res = await z2m(host);
  const ch = res.sort((a, b) => a.capabilities.channel_no - b.capabilities.channel_no);
  assert.deepEqual(ch.map((r) => r.kind), ['plug', 'plug']);
  assert.equal((await asAdmin(host, 'PUT', `/resources/${ch[0].id}`, { kind: 'light' })).status, 200);
  assert.equal((await asAdmin(host, 'PUT', `/resources/${ch[1].id}`, { kind: 'relay' })).status, 200);
  for (const bad of ['cover', 'sensor', 'thermostat', '', 1, null]) {
    assert.equal((await asAdmin(host, 'PUT', `/resources/${ch[0].id}`, { kind: bad })).status, 400, String(bad));
  }
  res = await z2m(host);
  assert.deepEqual(res.sort((a, b) => a.capabilities.channel_no - b.capabilities.channel_no).map((r) => [r.kind, r.capabilities.kind_set, r.capabilities.bri]), [['light', 'light', false], ['relay', 'relay', false]], 'the next report keeps it');
  for (const r of res) await asAdmin(host, 'PUT', `/resources/${r.id}/owners`, { userIds: [ADA.id] });
  const qa = await host.quickActions(ADA);
  assert.deepEqual(qa.map((a) => [a.id.split(':')[0], a.subtitle, a.widget]), [['light', 'Licht', null], ['relay', 'Schalter', null]], 'a channel is no dimmer: no brightness widget');
  const r = (await host.runQuickAction(ADA, qa[0].id, 'de', { state: 'off' })).body;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(sent.pop(), ['z2m:a4c1380000445566', { on: false, channel: 'l1' }], 'switched by its channel, whatever kind it stands for');
  // a chain on the server: a channel as a light is switched, never dimmed
  const def = (set) => ({ version: 2, triggers: [{ kind: 'manual' }], conditions: { mode: 'all', list: [] }, steps: [{ kind: 'action', resourceId: Number(qa[0].id.split(':')[1]), set }], retrigger: 'restart' });
  const dim = await asAdmin(host, 'POST', '/rules', { source: 'server', name: 'Dimmen', definition: def({ bri: 50 }) });
  assert.deepEqual([dim.status, dim.json.detail], [400, 'no_bri_capability'], JSON.stringify(dim.json));
  const on = await asAdmin(host, 'POST', '/rules', { source: 'server', name: 'Schalten', definition: def({ on: true }) });
  assert.equal(on.status, 200, JSON.stringify(on.json));
}));

test('zigbee2mqtt: a device without channels and deCONZ resources take no kind', () => withHost({ gateways: [fakeDeconz()] }, async (host) => {
  const { by } = await connected(host);
  const r = await asAdmin(host, 'PUT', `/resources/${by('Poolpumpe').id}`, { kind: 'light' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'SMARTHOME_NOT_CONTROLLABLE');
}));

test('edge capabilities stay those of 1.12.0 (no confirmation on the gateways), the page and the portal know the symbol', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'));
  assert.deepEqual(manifest.edge.capabilities, { mdns: { services: ['_shelly._tcp', '_http._tcp'] }, http: { lan: true }, mqtt: { topics: ['shellies/#', 'tasmota/#'] } });
  const common = fs.readFileSync(path.join(__dirname, '..', 'ui', 'common.js'), 'utf8');
  assert.match(common, /batteryChip: batteryChip/);
  for (const f of ['admin.js', 'portal.js']) assert.match(fs.readFileSync(path.join(__dirname, '..', 'ui', f), 'utf8'), /S\.batteryChip\(/, f);
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'admin.html'), 'utf8');
  assert.match(html, /id="sh-owner-kind"/);
});
