'use strict';

// Vehicle notifications: the pure transition logic (alerts.evaluate) and the
// whole path sync → gc.notify({ topic, … }) against the mock host.

const test = require('node:test');
const assert = require('node:assert/strict');
const alerts = require('../server/alerts');
const manifest = require('../plugin.json');
const { withHost, asAdmin, connected, fx, VIN, ADA } = require('./helpers');

const CFG = { batteryLow: 20, unlockedMin: 15, lang: 'de' };
const MIN = 60000;
const T0 = Date.parse('2026-10-11T08:00:00Z');

function vehicle(state, extra = {}) {
  return { id: 1, vin: VIN, name: 'Elroq', model: 'Elroq', state, ...extra };
}
function st(o = {}) {
  return {
    soc: 50, rangeKm: 250, locked: true,
    charging: { state: 'READY_FOR_CHARGING', targetPercent: 80 },
    climate: { state: 'OFF', remainingMin: null, targetC: 22 },
    ...o,
  };
}
/** Run evaluate over a sequence of [state, minutesAfterT0]; returns all events. */
function run(seq, cfg = CFG, memo0 = undefined) {
  let memo = memo0 === undefined ? null : memo0;
  const events = [];
  for (const [state, min] of seq) {
    const r = alerts.evaluate(memo, [vehicle(state)], cfg, T0 + min * MIN);
    memo = r.memo;
    events.push(...r.events.map((e) => `${e.topic}:${e.kind}`));
  }
  return { events, memo };
}

test('first run: pre-existing states are only recorded, never announced', () => {
  const { events, memo } = run([[st({ soc: 10, locked: false, charging: { state: 'CHARGING', targetPercent: 80 }, climate: { state: 'HEATING', remainingMin: 0 } }), 0]]);
  assert.deepEqual(events, []);
  assert.equal(memo.vehicles[VIN].lowNotified, true);
  assert.equal(memo.vehicles[VIN].unlockNotified, true);
  // a vehicle that appears later is a first sighting as well
  const later = alerts.evaluate(memo, [vehicle(st()), vehicle(st({ soc: 5 }), { id: 2, vin: 'OTHERVIN' })], CFG, T0 + MIN);
  assert.deepEqual(later.events, []);
});

test('charging_done: CHARGING → done at the target, not when stopped early', () => {
  const charging = (soc) => st({ soc, charging: { state: 'CHARGING', targetPercent: 80 } });
  assert.deepEqual(run([[charging(60), 0], [charging(75), 15], [st({ soc: 80 }), 30]]).events, ['charging_done:done']);
  assert.deepEqual(run([[charging(60), 0], [st({ soc: 79, charging: { state: 'CONSERVING', targetPercent: 80 } }), 15]]).events, ['charging_done:done']);
  // unplugged at 65 % of 80 %: no "complete"
  assert.deepEqual(run([[charging(60), 0], [st({ soc: 65 }), 15]]).events, []);
  // no charging state in this poll (part failed): no transition, CHARGING is remembered
  const r = run([[charging(60), 0], [st({ soc: 70, charging: { state: null } }), 15], [st({ soc: 80 }), 30]]);
  assert.deepEqual(r.events, ['charging_done:done']);
});

test('battery_low: once per drop, again only after recovering 5 points; never while charging', () => {
  const r = run([[st({ soc: 30 }), 0], [st({ soc: 19 }), 15], [st({ soc: 15 }), 30], [st({ soc: 22 }), 45], [st({ soc: 18 }), 60], [st({ soc: 26 }), 75], [st({ soc: 18 }), 90]]);
  assert.deepEqual(r.events, ['battery_low:low', 'battery_low:low']);
  assert.deepEqual(run([[st({ soc: 30 }), 0], [st({ soc: 12, charging: { state: 'CHARGING', targetPercent: 80 } }), 15]]).events, []);
  // threshold from the settings
  assert.deepEqual(run([[st({ soc: 40 }), 0], [st({ soc: 33 }), 15]], { ...CFG, batteryLow: 35 }).events, ['battery_low:low']);
});

test('not_locked: after N minutes unlocked, once until locked again', () => {
  const r = run([[st(), 0], [st({ locked: false }), 15], [st({ locked: false }), 25], [st({ locked: false }), 31], [st({ locked: false }), 60], [st({ locked: true }), 75], [st({ locked: false }), 90], [st({ locked: false }), 110]]);
  assert.deepEqual(r.events, ['not_locked:unlocked', 'not_locked:unlocked']);
  // unknown lock state keeps the running timer
  assert.deepEqual(run([[st(), 0], [st({ locked: false }), 1], [st({ locked: null }), 10], [st({ locked: false }), 17]]).events, ['not_locked:unlocked']);
  assert.deepEqual(run([[st(), 0], [st({ locked: false }), 1], [st({ locked: false }), 40]], { ...CFG, unlockedMin: 60 }).events, []);
});

test('climate_done: once per run — target reached or, failing that, finished', () => {
  const heat = (rem) => st({ climate: { state: 'HEATING', remainingMin: rem, targetC: 22 } });
  assert.deepEqual(run([[st(), 0], [heat(10), 5], [heat(0), 15], [heat(0), 20], [st(), 30]]).events, ['climate_done:reached']);
  assert.deepEqual(run([[st(), 0], [heat(10), 5], [st(), 15]]).events, ['climate_done:finished']);
});

test('a vehicle without state keeps what was known', () => {
  const a = run([[st({ charging: { state: 'CHARGING', targetPercent: 80 } }), 0]]);
  const b = alerts.evaluate(a.memo, [vehicle(null)], CFG, T0 + MIN);
  assert.deepEqual(b.memo, a.memo);
  const c = alerts.evaluate(b.memo, [vehicle(st({ soc: 80 }))], CFG, T0 + 2 * MIN);
  assert.deepEqual(c.events.map((e) => e.topic), ['charging_done']);
});

test('every topic the plugin sends is declared in plugin.json (with a de/en label)', () => {
  const declared = new Map(manifest.notifyTopics.map((t) => [t.id, t]));
  for (const id of ['charging_done', 'battery_low', 'not_locked', 'climate_done']) {
    assert.ok(declared.has(id), id);
    assert.ok(declared.get(id).label.de && declared.get(id).label.en, id);
  }
  assert.equal(manifest.permissions.notify, true);
  assert.deepEqual(manifest.notifyTopics.filter((t) => t.default === false).map((t) => t.id), ['not_locked', 'climate_done']);
});

test('settings: thresholds with fallbacks, language', () => {
  assert.deepEqual(alerts.configOf({}), { batteryLow: 20, unlockedMin: 15, lang: 'de' });
  assert.deepEqual(alerts.configOf({ notify_battery_low: 30, notify_unlocked_min: 60, notify_lang: 'en' }), { batteryLow: 30, unlockedMin: 60, lang: 'en' });
  assert.deepEqual(alerts.configOf({ notify_battery_low: 0, notify_unlocked_min: 'x' }), { batteryLow: 20, unlockedMin: 15, lang: 'de' });
});

test('sync → charging_done as gc.notify({ topic, … }) to the vehicle owners; across restarts, no repeats', () => withHost({}, async (host, cloud) => {
  const saved = JSON.parse(JSON.stringify({ charging: fx.charging, drivingRange: fx.drivingRange }));
  try {
    const { accountId, vehicleId } = await connected(host, cloud);   // first sync: CHARGING at 74 % — recorded only
    assert.deepEqual(host.notifications, []);
    assert.ok(await host.gc.storage.get(alerts.STATE_KEY), 'state persisted');
    await asAdmin(host, 'PUT', `/vehicles/${vehicleId}/owners`, { user_ids: [ADA.id] });

    // plugin restart (caches gone, storage kept): the transition is still recognised afterwards
    await host.stop();
    await host.start();
    fx.charging.status.state = 'CONSERVING';
    fx.charging.status.battery.stateOfChargeInPercent = 80;
    fx.drivingRange.primaryEngineRange.currentSoCInPercent = 80;
    fx.drivingRange.totalRangeInKm = 390;
    await asAdmin(host, 'POST', `/accounts/${accountId}/sync`);

    assert.equal(host.notifications.length, 1);
    const n = host.notifications[0];
    assert.equal(n.topic, 'charging_done');
    assert.equal(n.title, 'Laden abgeschlossen');
    assert.equal(n.body, 'Elroq · 80 % · ca. 390 km');
    assert.equal(n.priority, 'normal');
    assert.equal(n.collapseKey, `charge:${VIN}`);
    assert.deepEqual(n.users, [ADA.id]);
    assert.equal(n.data.route, 'plg-gatecontrol-skoda');
    assert.deepEqual(n.data.actions, [{ id: 'open', label: 'Öffnen', type: 'open_app_route', target: 'plg-gatecontrol-skoda' }]);
    assert.deepEqual(n.data.facts, [{ label: 'Akku', value: '80 %' }, { label: 'Reichweite', value: '390 km' }, { label: 'Ladeziel', value: '80 %' }]);
    assert.equal(n.data.vehicle_id, vehicleId);

    // the same state again (also after another restart): nothing new
    await asAdmin(host, 'POST', `/accounts/${accountId}/sync`);
    await host.stop();
    await host.start();
    await asAdmin(host, 'POST', `/accounts/${accountId}/sync`);
    assert.equal(host.notifications.length, 1);
  } finally {
    Object.assign(fx.charging, saved.charging);
    Object.assign(fx.drivingRange, saved.drivingRange);
  }
}));

test('English notifications and no owners → the topic rule decides (users omitted)', () => withHost({ settings: { notify_lang: 'en' } }, async (host, cloud) => {
  const saved = JSON.parse(JSON.stringify(fx.drivingRange));
  try {
    const { accountId } = await connected(host, cloud);
    fx.drivingRange.primaryEngineRange.currentSoCInPercent = 12;
    fx.drivingRange.totalRangeInKm = 50;
    // the fixture is still CHARGING → no battery_low while charging
    await asAdmin(host, 'POST', `/accounts/${accountId}/sync`);
    assert.deepEqual(host.notifications, []);
  } finally {
    Object.assign(fx.drivingRange, saved);
  }
  const ev = { topic: 'battery_low', kind: 'low', vin: VIN, vehicleId: 1, name: 'Elroq', state: st({ soc: 12, rangeKm: 50 }) };
  const n = alerts.toNotification(host.gc, ev, { ...CFG, lang: 'en' }, []);
  assert.equal(n.title, 'Battery low');
  assert.equal(n.body, 'Elroq · 12 % · approx. 50 km');
  assert.equal(n.users, null);
  assert.equal(n.data.actions[0].label, 'Open');
}));
