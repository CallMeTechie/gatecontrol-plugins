'use strict';

// Quick actions of the GateControl apps (hooks quickActions / runQuickAction):
// the portal's vehicle controls for a signed-in owner, grouped per vehicle
// (device v:<id>) — climate (carrying the vehicle's widget), charging and
// window heating as toggles from the stored state, the lock as one toggle
// (S-PIN; on = locked, asks before unlocking); no cloud call in the list; at
// most 16. Start tiles carry items for the apps.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, connected, fakeSkoda, ADMIN, ADA, BOB, VIN } = require('./helpers');
const store = require('../server/store');

const CAR = 'M5 16l1-5 2-3h8l2 3 1 5v3h-2a2 2 0 0 1-4 0H9a2 2 0 0 1-4 0H3v-3z';
const BATTERY = 'M2 7h16v10H2zM21 10v4M5 10v4M8 10v4M11 10v4';
const ROUTE = 'M3 19a3 3 0 1 0 6 0a3 3 0 1 0-6 0M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15M15 5a3 3 0 1 0 6 0a3 3 0 1 0-6 0';
const LOCKED = 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4M12 15v2';
const UNLOCKED = 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.9-1M12 15v2';
const LOOK = { on: { icon: LOCKED, tone: 'good' }, off: { icon: UNLOCKED, tone: 'crit' } };
const ICON_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,2000}$/;

/** Change the stored vehicle state (what the next poll would bring). */
async function patchState(host, id, patch) {
  const v = await store.getVehicle(host.gc, id);
  await store.saveState(host.gc, id, { ...v.state, ...patch });
}

const direct = (host, user, id, lang = 'de') => host.plugin.runQuickAction({ user: { portal: true, loggedIn: true, app: true, ...user }, lang, id }, host.gc);
const settle = () => new Promise((r) => setTimeout(r, 50)); // the command's background refresh

async function owned(host, cloud) {
  const ids = await connected(host, cloud);
  await asAdmin(host, 'PUT', `/vehicles/${ids.vehicleId}/owners`, { user_ids: [ADA.id] });
  return ids;
}

test('quick actions: the portal\'s controls for the signed-in owner, stored state, lock only with the S-PIN', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId: v } = await owned(host, cloud);
  const calls = cloud.calls.length;
  let list = await host.quickActions(ADA);
  assert.equal(cloud.calls.length, calls, 'no cloud call inside the hook');
  assert.deepEqual(list.map((a) => [a.id, a.title, a.subtitle, a.kind, a.state, a.confirm]), [
    [`climate:${v}`, 'Klimatisierung', 'Elroq', 'toggle', 'off', false],
    [`charging:${v}`, 'Laden', 'Elroq', 'toggle', 'on', false],
    [`windowheat:${v}`, 'Scheibenheizung', 'Elroq', 'toggle', 'off', false],
  ]);
  assert.ok(list.every((a) => /^M/.test(a.icon)));
  assert.ok(list.every((a) => a.look === null && a.confirmWhen === null));
  await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '4711' });
  list = await host.quickActions(ADA, 'en');
  assert.deepEqual(list.map((a) => a.id), [`climate:${v}`, `charging:${v}`, `windowheat:${v}`, `lock:${v}`], 'no unlock action any more');
  assert.deepEqual(list[3], {
    id: `lock:${v}`, title: 'Locked', subtitle: 'Elroq', icon: LOCKED, kind: 'toggle', state: 'on', confirm: true, confirmWhen: 'off', look: LOOK,
    device: { id: `v:${v}`, title: 'Elroq', subtitle: null, icon: CAR }, widget: null,
  });
  assert.ok(!JSON.stringify(list).includes(VIN) && !JSON.stringify(list).includes('4711'));
  assert.deepEqual(await host.quickActions(BOB), [], 'never another person\'s vehicle');
  assert.deepEqual(await host.quickActions(ADMIN), [], 'an administrator gets only what is assigned, like in the portal');
  assert.deepEqual(await host.quickActions({ ...ADA, loggedIn: false }), [], 'no controls without a sign-in, like the portal');
}));

test('quick actions: at most 16 over several vehicles', () => {
  const cloud = fakeSkoda();
  for (let i = 2; i <= 5; i++) cloud.garage.vehicles.push({ vin: `TMBTESTVIN00000${i}`, name: `Auto ${i}`, specification: { model: 'Enyaq' } });
  return withHost({ cloud }, async (host) => {
    const { accountId } = await connected(host, cloud);
    await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '4711' });
    const vehicles = (await asAdmin(host, 'GET', '/')).json.vehicles;
    assert.equal(vehicles.length, 5);
    for (const x of vehicles) await asAdmin(host, 'PUT', `/vehicles/${x.id}/owners`, { user_ids: [ADA.id] });
    const list = await host.quickActions(ADA); // the mock host throws on more than 16
    assert.equal(list.length, 16);
    assert.deepEqual(list.slice(0, 5).map((a) => a.id.split(':')[0]), ['climate', 'charging', 'windowheat', 'lock', 'climate']);
    assert.deepEqual(list.slice(0, 5).map((a) => a.device.id), [`v:${vehicles[0].id}`, `v:${vehicles[0].id}`, `v:${vehicles[0].id}`, `v:${vehicles[0].id}`, `v:${vehicles[1].id}`]);
    assert.equal(list.filter((a) => a.widget).length, 4, 'one widget per vehicle');
  });
});

test('runQuickAction: toggles send the portal\'s commands and report the state they aim for', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId: v } = await owned(host, cloud);
  const last = () => cloud.commands.at(-1);
  let r = await host.runQuickAction(ADA, `climate:${v}`);
  assert.deepEqual(r, { status: 200, body: { ok: true, message: 'Elroq: Klimatisierung wird gestartet', state: 'on', widget: null } });
  assert.deepEqual(last(), { method: 'POST', path: `/api/v2/air-conditioning/${VIN}/start`, body: { heaterSource: 'ELECTRIC', targetTemperature: { temperatureValue: 22, unitInCar: 'CELSIUS' } } });
  await settle();
  r = await host.runQuickAction(ADA, `charging:${v}`, 'en');
  assert.deepEqual(r.body, { ok: true, message: 'Elroq: stopping charging', state: 'off', widget: null });
  assert.equal(last().path, `/api/v1/charging/${VIN}/stop`);
  r = await host.runQuickAction(ADA, `windowheat:${v}`);
  assert.deepEqual(r.body, { ok: true, message: 'Elroq: Scheibenheizung wird eingeschaltet', state: 'on', widget: null });
  assert.equal(last().path, `/api/v2/air-conditioning/${VIN}/start-window-heating`);
  await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '4711' });
  await settle();
}));

test('runQuickAction: the lock toggle unlocks a locked vehicle and locks an unlocked or unknown one', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId: v } = await owned(host, cloud);
  await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '4711' });
  const last = () => cloud.commands.at(-1);
  const lock = async (lang) => (await host.quickActions(ADA, lang)).find((a) => a.id === `lock:${v}`);
  // locked (the stored state) → unlock
  assert.deepEqual([(await lock()).title, (await lock()).state, (await lock()).icon], ['Verriegelt', 'on', LOCKED]);
  let r = await host.runQuickAction(ADA, `lock:${v}`);
  assert.deepEqual(r.body, { ok: true, message: 'Elroq wird entriegelt', state: 'off', widget: null });
  assert.deepEqual(last(), { method: 'POST', path: `/api/v1/vehicle-access/${VIN}/unlock`, body: { currentSpin: '4711' } });
  await settle();
  // unlocked → lock
  await patchState(host, v, { locked: false });
  assert.deepEqual([(await lock('en')).title, (await lock()).state, (await lock()).icon, (await lock()).look], ['Unlocked', 'off', UNLOCKED, LOOK]);
  r = await host.runQuickAction(ADA, `lock:${v}`, 'en');
  assert.deepEqual(r.body, { ok: true, message: 'Elroq is being locked', state: 'on', widget: null });
  assert.deepEqual(last(), { method: 'POST', path: `/api/v1/vehicle-access/${VIN}/lock`, body: { currentSpin: '4711' } });
  await settle();
  // unknown → lock, the toggle without a state
  await patchState(host, v, { locked: null });
  const unknown = await lock();
  assert.deepEqual([unknown.title, unknown.state, unknown.icon, unknown.confirm, unknown.confirmWhen], ['Schloss', null, LOCKED, true, 'off']);
  r = await host.runQuickAction(ADA, `lock:${v}`);
  assert.deepEqual(r.body, { ok: true, message: 'Elroq wird verriegelt', state: 'on', widget: null });
  assert.equal(last().path, `/api/v1/vehicle-access/${VIN}/lock`);
  await settle();
  // old "Entriegeln" pins: not listed any more → 404; the hook itself does not know the id either
  const n = cloud.commands.length;
  assert.equal((await host.runQuickAction(ADA, `unlock:${v}`)).status, 404);
  assert.deepEqual(await direct(host, ADA, `unlock:${v}`), { ok: false, message: 'Diese Aktion gibt es nicht mehr.' });
  assert.equal(cloud.commands.length, n);
}));

test('quick actions: the vehicle\'s device and its widget on the climate action', () => {
  const cloud = fakeSkoda();
  cloud.garage.vehicles[0].name = 'Familienauto';
  return withHost({ cloud }, async (host) => {
    const { vehicleId: v } = await owned(host, cloud);
    let list = await host.quickActions(ADA);
    const device = { id: `v:${v}`, title: 'Familienauto', subtitle: 'Elroq', icon: CAR };
    assert.ok(list.every((a) => JSON.stringify(a.device) === JSON.stringify(device)), 'every action of the vehicle: one device');
    assert.deepEqual(list.map((a) => [a.id, Boolean(a.widget)]), [[`climate:${v}`, true], [`charging:${v}`, false], [`windowheat:${v}`, false]]);
    assert.deepEqual(list[0].widget, {
      label: 'Ladestand', value: 74, unit: '%', status: 'Lädt', state: 'good', controls: [], power: false,
      readings: [
        { id: 'range', label: 'Reichweite', value: 310, unit: 'km', icon: ROUTE, state: null },
        { id: 'lock', label: 'Verriegelung', value: null, unit: null, icon: LOCKED, state: 'good' },
      ],
    });
    // unlocked, not charging, climate on, English
    await patchState(host, v, { locked: false, charging: { state: 'READY_FOR_CHARGING' }, climate: { state: 'HEATING' } });
    list = await host.quickActions(ADA, 'en');
    assert.deepEqual(list[0].widget, {
      label: 'Charge level', value: 74, unit: '%', status: 'Climate control on', state: 'warn', controls: [], power: false,
      readings: [
        { id: 'range', label: 'Range', value: 310, unit: 'km', icon: ROUTE, state: null },
        { id: 'lock', label: 'Locking', value: null, unit: null, icon: UNLOCKED, state: 'crit' },
      ],
    });
    // low charge level beats unlocked
    await patchState(host, v, { soc: 12 });
    assert.equal((await host.quickActions(ADA))[0].widget.state, 'crit');
    // no charge level (a combustion car): the range is the value, no range reading; lock unknown → no lock reading
    await patchState(host, v, { soc: null, locked: null, charging: null, climate: { state: 'OFF' } });
    list = await host.quickActions(ADA);
    assert.deepEqual(list[0].widget, { label: 'Reichweite', value: 310, unit: 'km', status: null, state: null, controls: [], readings: [], power: false });
    assert.deepEqual(list.map((a) => a.id), [`climate:${v}`, `windowheat:${v}`], 'no charging toggle without a battery');
    await patchState(host, v, { rangeKm: null });
    assert.deepEqual((await host.quickActions(ADA))[0].widget, { label: 'Reichweite', value: '–', unit: null, status: null, state: null, controls: [], readings: [], power: false });
  });
});

test('Start tiles: items for the apps (charge level, range, lock), value text for the portal', () => withHost({}, async (host, cloud) => {
  const { vehicleId: v } = await owned(host, cloud);
  const tiles = await host.clientTiles(ADA);
  assert.deepEqual(tiles, [{
    section: 'skoda', title: 'Elroq', value: '74 % · 310 km · lädt', unit: null, state: 'on', icon: CAR,
    items: [
      { label: 'Ladestand', value: 74, unit: '%', icon: BATTERY, state: 'good' },
      { label: 'Reichweite', value: 310, unit: 'km', icon: ROUTE, state: null },
      { label: 'Verriegelt', value: null, unit: null, icon: LOCKED, state: 'good' },
    ],
  }]);
  for (const icon of [BATTERY, ROUTE, LOCKED, UNLOCKED]) assert.ok(ICON_RE.test(icon));
  await patchState(host, v, { soc: 9, locked: false });
  assert.deepEqual((await host.clientTiles(ADA, 'en'))[0].items, [
    { label: 'Charge level', value: 9, unit: '%', icon: BATTERY, state: 'crit' },
    { label: 'Range', value: 310, unit: 'km', icon: ROUTE, state: null },
    { label: 'Unlocked', value: null, unit: null, icon: UNLOCKED, state: 'crit' },
  ]);
  await patchState(host, v, { soc: null, rangeKm: null, locked: null });
  assert.deepEqual((await host.clientTiles(ADA))[0].items, [], 'nothing known → no items');
}));

test('runQuickAction: unknown ids, other people\'s vehicles and no sign-in send nothing; cloud errors are messages', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId: v } = await owned(host, cloud);
  const n = cloud.commands.length;
  for (const id of [`lock:${v}`, 'climate:999', `timer:${v}`, '']) assert.equal((await host.runQuickAction(ADA, id)).status, 404, id); // lock: no S-PIN yet
  assert.equal((await host.runQuickAction(BOB, `climate:${v}`)).status, 404);
  for (const [user, id] of [[BOB, `climate:${v}`], [ADA, 'climate:0'], [ADA, 'x'], [{ ...ADA, loggedIn: false }, `climate:${v}`]]) {
    const out = await direct(host, user, id);
    assert.equal(out.ok, false, `${user.name} ${id}`);
    assert.equal(typeof out.message, 'string');
  }
  assert.equal((await direct(host, BOB, `climate:${v}`)).message, 'Dieses Fahrzeug ist dir nicht zugewiesen.');
  assert.equal((await direct(host, ADA, `lock:${v}`)).message, 'Dafür wird die S-PIN des Kontos gebraucht.', 'the command\'s own check still applies');
  assert.equal(cloud.commands.length, n, 'nothing reached the cloud');
  await host.gc.settings.setSecret(`acc.${accountId}.access`, null);
  const r = await host.runQuickAction(ADA, `climate:${v}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.ok(r.body.message && r.body.state === null);
}));
