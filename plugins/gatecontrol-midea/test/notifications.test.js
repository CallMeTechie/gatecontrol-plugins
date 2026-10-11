'use strict';

// Air-conditioner notifications: the pure transition logic (alerts.evaluate)
// and the path LAN poll → gc.notify({ topic, … }) against the mock host.

const test = require('node:test');
const assert = require('node:assert/strict');
const alerts = require('../server/alerts');
const manifest = require('../plugin.json');
const { fakeAc, discoveryAnswer, withHost, asAdmin, ADA } = require('./helpers');

const CFG = { offlineMin: 10, lang: 'de' };
const MIN = 60000;
const T0 = Date.parse('2026-10-11T08:00:00Z');
const DEV = { id: 1, name: 'Büro' };
const ok = (st = {}) => ({ online: true, state: { power: true, mode: 'cool', indoorTemp: 24, filterAlert: false, applianceError: false, errorCode: 0, ...st } });
const off = { online: false, state: null };

function run(seq) {
  let memo = null;
  const events = [];
  for (const [o, min] of seq) {
    const r = alerts.evaluate(memo, [{ device: DEV, ...o }], CFG, T0 + min * MIN);
    memo = r.memo;
    events.push(...r.events.map((e) => `${e.topic}:${e.kind}`));
  }
  return { events, memo };
}

test('first run: an offline device, a dirty filter and an error that already were are not announced', () => {
  assert.deepEqual(run([[off, 0], [off, 30], [ok(), 31]]).events, [], 'no "reachable again" without an announced outage');
  assert.deepEqual(run([[ok({ filterAlert: true, applianceError: true }), 0], [ok({ filterAlert: true, applianceError: true }), 1], [ok(), 2]]).events, []);
  // first met offline, then its first state shows a dirty filter: still "already the case"
  assert.deepEqual(run([[off, 0], [ok({ filterAlert: true }), 5], [ok({ filterAlert: true }), 6]]).events, []);
});

test('device_unreachable: after 10 minutes, once; "reachable again" afterwards', () => {
  assert.deepEqual(run([[ok(), 0], [off, 1], [off, 10], [off, 11], [off, 40], [ok(), 41], [off, 42], [ok(), 45]]).events,
    ['device_unreachable:down', 'device_unreachable:up']);
});

test('filter_clean once until reset; error_code once per error with "resolved"', () => {
  assert.deepEqual(run([[ok(), 0], [ok({ filterAlert: true }), 1], [ok({ filterAlert: true }), 2], [off, 3], [ok({ filterAlert: true }), 4], [ok(), 5], [ok({ filterAlert: true }), 6]]).events,
    ['filter_clean:filter', 'filter_clean:filter']);
  assert.deepEqual(run([[ok(), 0], [ok({ applianceError: true, errorCode: 5 }), 1], [ok({ applianceError: true, errorCode: 5 }), 2], [ok(), 3]]).events,
    ['error_code:error', 'error_code:clear']);
});

test('payloads: priorities, collapse keys, error code, owners, language', () => {
  const gc = { plugin: { id: 'gatecontrol-midea' } };
  const err = alerts.toNotification(gc, { topic: 'error_code', kind: 'error', device: DEV, state: ok({ applianceError: true, errorCode: 5 }).state }, CFG, [2]);
  assert.deepEqual([err.title, err.body, err.priority, err.collapseKey, err.users], ['Störung am Klimagerät', 'Büro meldet eine Störung (Code 5)', 'high', 'error:1', [2]]);
  assert.deepEqual(err.data.facts[0], { label: 'Fehlercode', value: '5' });
  const clear = alerts.toNotification(gc, { topic: 'error_code', kind: 'clear', device: DEV, state: ok().state }, CFG, []);
  assert.deepEqual([clear.priority, clear.collapseKey, clear.users], ['info', 'error:1', null]);
  const down = alerts.toNotification(gc, { topic: 'device_unreachable', kind: 'down', device: DEV, minutes: 10 }, { ...CFG, lang: 'en' }, []);
  assert.deepEqual([down.title, down.body, down.priority], ['Air conditioner unreachable', 'Büro has not answered for 10 minutes', 'normal']);
  const filter = alerts.toNotification(gc, { topic: 'filter_clean', kind: 'filter', device: DEV, state: ok().state }, CFG, []);
  assert.deepEqual([filter.title, filter.priority, filter.data.route], ['Filter reinigen', 'info', 'plg-gatecontrol-midea']);
});

test('every topic the plugin sends is declared in plugin.json (with a de/en label)', () => {
  const declared = new Map(manifest.notifyTopics.map((t) => [t.id, t]));
  for (const id of ['device_unreachable', 'filter_clean', 'error_code']) {
    assert.ok(declared.has(id), id);
    assert.ok(declared.get(id).label.de && declared.get(id).label.en, id);
    assert.notEqual(declared.get(id).default, false, `${id} is on by default`);
  }
  assert.equal(manifest.permissions.notify, true);
});

test('LAN poll → error (high) to the owners and filter notice; offline device after 10 minutes; restart keeps the state', () => {
  const dev = fakeAc({ power: true });
  return withHost({ lan: [{ dev, version: 2, deviceId: '1001', answer: discoveryAnswer({ version: 2, deviceId: '1001' }) }] }, async (host) => {
    const add = await asAdmin(host, 'POST', '/devices', { target_index: 0, name: 'Büro' });
    const id = add.json.device.id;
    await asAdmin(host, 'PUT', `/devices/${id}/owners`, { user_ids: [ADA.id] });
    await host.tick(); // first poll: recorded only
    assert.deepEqual(host.notifications, []);

    dev.state.applianceError = true;
    dev.state.errorCode = 3;
    dev.state.filterAlert = true;
    await host.tick();
    assert.deepEqual(host.notifications.map((n) => [n.topic, n.priority]), [['filter_clean', 'info'], ['error_code', 'high']]);
    const err = host.notifications[1];
    assert.equal(err.body, 'Büro meldet eine Störung (Code 3)');
    assert.deepEqual(err.users, [ADA.id]);
    assert.equal(err.collapseKey, `error:${id}`);
    assert.equal(err.data.actions[0].target, 'plg-gatecontrol-midea');

    await host.stop();
    await host.start();
    await host.tick();
    assert.equal(host.notifications.length, 2, 'nothing repeated after a restart');
    dev.state.applianceError = false;
    await host.tick();
    assert.equal(host.notifications[2].title, 'Störung behoben');

    // offline: the poll records it; 10 minutes later (clock passed in) it is announced
    dev.down = true;
    const t = Date.now();
    await alerts.check(host.gc, [{ device: { id, name: 'Büro' }, online: false, state: null }], { now: t });
    await alerts.check(host.gc, [{ device: { id, name: 'Büro' }, online: false, state: null }], { now: t + 11 * MIN });
    const down = host.notifications[3];
    assert.deepEqual([down.topic, down.title, down.collapseKey], ['device_unreachable', 'Klimagerät nicht erreichbar', `device:${id}`]);
    dev.down = false;
    await host.tick();
    assert.equal(host.notifications[4].title, 'Klimagerät wieder erreichbar');
    assert.equal(host.notifications.length, 5);
  });
});
