'use strict';

// Quick actions of the GateControl apps (hooks quickActions / runQuickAction):
// the portal's vehicle controls for a signed-in owner, grouped per vehicle
// (device v:<id>) — climate (carrying the vehicle's widget), charging and
// window heating as toggles from the stored state, the lock as one toggle
// (S-PIN; on = locked, asks before unlocking); no cloud call in the list; at
// most 16. Start tiles carry items for the apps. Right after a command the
// apps show the state it aims for until the vehicle reports it; a command
// queued past the host's time limit answers "on its way".

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, connected, fakeSkoda, ADMIN, ADA, BOB, VIN } = require('./helpers');
const store = require('../server/store');
const service = require('../server/service');
const control = require('../server/control');

const CAR = 'M5 16l1-5 2-3h8l2 3 1 5v3h-2a2 2 0 0 1-4 0H9a2 2 0 0 1-4 0H3v-3z';
const BATTERY = 'M2 7h16v10H2zM21 10v4M5 10v4M8 10v4M11 10v4';
const ROUTE = 'M3 19a3 3 0 1 0 6 0a3 3 0 1 0-6 0M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15M15 5a3 3 0 1 0 6 0a3 3 0 1 0-6 0';
const LOCKED = 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4M12 15v2';
const UNLOCKED = 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.9-1M12 15v2';
const LOOK = { on: { icon: LOCKED, tone: 'good' }, off: { icon: UNLOCKED, tone: 'crit' } };
const ICON_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,2000}$/;
// the widget badge: battery empty, one, two, three bars; with a lightning bolt while charging
const BAT = ['', 'M6 10v4', 'M6 10v4M10 10v4', 'M6 10v4M10 10v4M14 10v4'].map((bars) => 'M2 7h16v10H2zM21 10v4' + bars);
const BAT_CHARGING = 'M2 7h16v10H2zM21 10v4M11 9l-3 3h4l-3 3';

/** Change the stored vehicle state (what the next poll would bring). */
async function patchState(host, id, patch) {
  const v = await store.getVehicle(host.gc, id);
  await store.saveState(host.gc, id, { ...v.state, ...patch });
}

const direct = (host, user, id, lang = 'de') => host.plugin.runQuickAction({ user: { portal: true, loggedIn: true, app: true, ...user }, lang, id }, host.gc);
const settle = () => new Promise((r) => setTimeout(r, 50)); // a command finishing in the background

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
    device: { id: `v:${v}`, title: 'Elroq', subtitle: null, icon: CAR }, widget: null, verbs: { on: 'Lock', off: 'Unlock' }, targets: true,
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
  assert.deepEqual(r, { status: 200, body: { ok: true, unchanged: false, message: 'Elroq: Klimatisierung wird gestartet', state: 'on', widget: null } });
  assert.deepEqual(last(), { method: 'POST', path: `/api/v2/air-conditioning/${VIN}/start`, body: { heaterSource: 'ELECTRIC', targetTemperature: { temperatureValue: 22, unitInCar: 'CELSIUS' } } });
  await settle();
  r = await host.runQuickAction(ADA, `charging:${v}`, 'en');
  assert.deepEqual(r.body, { ok: true, unchanged: false, message: 'Elroq: stopping charging', state: 'off', widget: null });
  assert.equal(last().path, `/api/v1/charging/${VIN}/stop`);
  r = await host.runQuickAction(ADA, `windowheat:${v}`);
  assert.deepEqual(r.body, { ok: true, unchanged: false, message: 'Elroq: Scheibenheizung wird eingeschaltet', state: 'on', widget: null });
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
  assert.deepEqual(r.body, { ok: true, unchanged: false, message: 'Elroq wird entriegelt', state: 'off', widget: null });
  assert.deepEqual(last(), { method: 'POST', path: `/api/v1/vehicle-access/${VIN}/unlock`, body: { currentSpin: '4711' } });
  await settle();
  // unlocked → lock
  await patchState(host, v, { locked: false });
  assert.deepEqual([(await lock('en')).title, (await lock()).state, (await lock()).icon, (await lock()).look], ['Unlocked', 'off', UNLOCKED, LOOK]);
  r = await host.runQuickAction(ADA, `lock:${v}`, 'en');
  assert.deepEqual(r.body, { ok: true, unchanged: false, message: 'Elroq is being locked', state: 'on', widget: null });
  assert.deepEqual(last(), { method: 'POST', path: `/api/v1/vehicle-access/${VIN}/lock`, body: { currentSpin: '4711' } });
  await settle();
  // unknown → lock, the toggle without a state (the lock command's expected state is over)
  control.reset();
  await patchState(host, v, { locked: null });
  const unknown = await lock();
  assert.deepEqual([unknown.title, unknown.state, unknown.icon, unknown.confirm, unknown.confirmWhen], ['Schloss', null, LOCKED, true, 'off']);
  r = await host.runQuickAction(ADA, `lock:${v}`);
  assert.deepEqual(r.body, { ok: true, unchanged: false, message: 'Elroq wird verriegelt', state: 'on', widget: null });
  assert.equal(last().path, `/api/v1/vehicle-access/${VIN}/lock`);
  await settle();
  // old "Entriegeln" pins: not listed any more → 404; the hook itself does not know the id either
  const n = cloud.commands.length;
  assert.equal((await host.runQuickAction(ADA, `unlock:${v}`)).status, 404);
  assert.deepEqual(await direct(host, ADA, `unlock:${v}`), { ok: false, message: 'Diese Aktion gibt es nicht mehr.' });
  assert.equal(cloud.commands.length, n);
}));

test('target states (GateControl ≥ 1.173.0): every toggle declares its verbs and honours a target', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId: v } = await owned(host, cloud);
  await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '4711' });
  const verbs = async (lang) => (await host.quickActions(ADA, lang)).map((a) => [a.id.split(':')[0], a.verbs, a.targets]);
  assert.deepEqual(await verbs('de'), [
    ['climate', { on: 'Einschalten', off: 'Ausschalten' }, true], ['charging', { on: 'Laden starten', off: 'Laden stoppen' }, true],
    ['windowheat', { on: 'Einschalten', off: 'Ausschalten' }, true], ['lock', { on: 'Verriegeln', off: 'Entriegeln' }, true],
  ]);
  assert.deepEqual(await verbs('en'), [
    ['climate', { on: 'Turn on', off: 'Turn off' }, true], ['charging', { on: 'Start charging', off: 'Stop charging' }, true],
    ['windowheat', { on: 'Turn on', off: 'Turn off' }, true], ['lock', { on: 'Lock', off: 'Unlock' }, true],
  ]);
  const last = () => cloud.commands.at(-1);
  const run = async (id, state, lang = 'de') => { const r = await host.runQuickAction(ADA, `${id}:${v}`, lang, { state }); await settle(); return r; };
  // the vehicle is locked: target on → lock again (never unlock), target off → unlock
  let r = await run('lock', 'on');
  assert.deepEqual(r.body, { ok: true, message: 'Elroq wird verriegelt', state: 'on', widget: null, unchanged: false });
  assert.deepEqual(last(), { method: 'POST', path: `/api/v1/vehicle-access/${VIN}/lock`, body: { currentSpin: '4711' } });
  r = await run('lock', 'on');
  assert.equal(last().path, `/api/v1/vehicle-access/${VIN}/lock`, 'twice: lock twice');
  r = await run('lock', 'off', 'en');
  assert.deepEqual(r.body, { ok: true, message: 'Elroq is being unlocked', state: 'off', widget: null, unchanged: false });
  assert.equal(last().path, `/api/v1/vehicle-access/${VIN}/unlock`);
  // the state the command aims for is what the apps show until the vehicle reports (as without a target)
  assert.equal((await host.quickActions(ADA)).find((a) => a.id === `lock:${v}`).state, 'off');
  r = await run('lock', 'off');
  assert.equal(last().path, `/api/v1/vehicle-access/${VIN}/unlock`, 'unlocked (expected) + target off: unlock again');
  // charging is on: target on → start (again), target off → stop; climate / window heating are off: off → stop
  await run('charging', 'on');
  assert.equal(last().path, `/api/v1/charging/${VIN}/start`);
  await run('climate', 'off');
  assert.equal(last().path, `/api/v2/air-conditioning/${VIN}/stop`);
  await run('climate', 'on');
  assert.equal(last().path, `/api/v2/air-conditioning/${VIN}/start`);
  await run('windowheat', 'off');
  assert.equal(last().path, `/api/v2/air-conditioning/${VIN}/stop-window-heating`);
  // another plugin's automation (a Familie rule): the lock is titled „Schloss“, the target reaches the command
  control.reset();
  const auto = { automation: true, via: 'gatecontrol-familie' };
  r = await host.runQuickAction(ADA, `lock:${v}`, 'de', { ...auto, state: 'on' });
  assert.deepEqual(r.body, { ok: true, message: 'Elroq wird verriegelt', state: 'on', widget: null, unchanged: false });
  assert.equal(last().path, `/api/v1/vehicle-access/${VIN}/lock`);
  await settle();
  // without a target: as before (switches over)
  r = await host.runQuickAction(ADA, `lock:${v}`);
  assert.equal(last().path, `/api/v1/vehicle-access/${VIN}/unlock`);
  await settle();
  // the hook itself: anything but 'on' | 'off' is no target (window heating, expected off → switched on)
  const out = await host.plugin.runQuickAction({ user: { portal: true, loggedIn: true, app: true, ...ADA }, lang: 'de', id: `windowheat:${v}`, target: 'sideways' }, host.gc);
  assert.deepEqual([out.ok, out.state, last().path], [true, 'on', `/api/v2/air-conditioning/${VIN}/start-window-heating`]);
  await settle();
}));

test('the lock for another plugin\'s automation is titled „Schloss“ in every state; the apps keep the state titles', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId: v } = await owned(host, cloud);
  await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '4711' });
  const titleFor = async (viewer, lang) => {
    const list = viewer === 'app' ? await host.quickActions(ADA, lang) : await host.plugin.quickActions({ user: { id: ADA.id, name: ADA.name, role: ADA.role, portal: true, loggedIn: true, automation: true, via: 'gatecontrol-familie' }, lang }, host.gc);
    return list.find((a) => a.id === `lock:${v}`).title;
  };
  assert.deepEqual([await titleFor('app'), await titleFor('auto'), await titleFor('auto', 'en')], ['Verriegelt', 'Schloss', 'Lock']);
  await patchState(host, v, { locked: false });
  assert.deepEqual([await titleFor('app'), await titleFor('auto')], ['Entriegelt', 'Schloss']);
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
    // the charge level as the badge (charging: the lightning battery), no main value, only the range as a reading
    assert.deepEqual(list[0].widget, {
      label: null, value: null, unit: null, status: 'Lädt', state: 'good', controls: [], power: false,
      readings: [{ id: 'range', label: 'Reichweite', value: 310, unit: 'km', icon: ROUTE, state: null }],
      badge: { icon: BAT_CHARGING, value: 74, unit: '%', state: 'good', label: 'Ladestand' },
    });
    // unlocked, not charging, climate on, English: the lock stays on its toggle — no reading, no amber card
    await patchState(host, v, { locked: false, charging: { state: 'READY_FOR_CHARGING' }, climate: { state: 'HEATING' } });
    list = await host.quickActions(ADA, 'en');
    assert.deepEqual(list[0].widget, {
      label: null, value: null, unit: null, status: 'Climate control on', state: 'good', controls: [], power: false,
      readings: [{ id: 'range', label: 'Range', value: 310, unit: 'km', icon: ROUTE, state: null }],
      badge: { icon: BAT[2], value: 74, unit: '%', state: 'good', label: 'Charge level' },
    });
    // a low charge level: red card (whatever the lock)
    await patchState(host, v, { soc: 12 });
    assert.equal((await host.quickActions(ADA))[0].widget.state, 'crit');
    await patchState(host, v, { soc: 15, locked: true });
    assert.equal((await host.quickActions(ADA))[0].widget.state, 'crit', '15 % is still red');
    await patchState(host, v, { soc: 16, locked: false });
    assert.equal((await host.quickActions(ADA))[0].widget.state, 'good', 'unlocked → no warn');
    // no charge level (a combustion car): no badge, still no main value, the range as the reading; lock unknown → nothing about it
    await patchState(host, v, { soc: null, locked: null, charging: null, climate: { state: 'OFF' } });
    list = await host.quickActions(ADA);
    assert.deepEqual(list[0].widget, {
      label: null, value: null, unit: null, status: null, state: null, controls: [], power: false,
      readings: [{ id: 'range', label: 'Reichweite', value: 310, unit: 'km', icon: ROUTE, state: null }], badge: null,
    });
    assert.deepEqual(list.map((a) => a.id), [`climate:${v}`, `windowheat:${v}`], 'no charging toggle without a battery');
    // nothing known: an empty widget (never a dash), the status line still shows
    await patchState(host, v, { rangeKm: null });
    assert.deepEqual((await host.quickActions(ADA))[0].widget, { label: null, value: null, unit: null, status: null, state: null, controls: [], readings: [], power: false, badge: null });
    await patchState(host, v, { climate: { state: 'HEATING' } });
    assert.equal((await host.quickActions(ADA))[0].widget.status, 'Klimatisierung an');
  });
});

test('quick actions: the badge\'s battery shows the charge level (empty ≤ 15 %, one bar ≤ 40, two ≤ 75, three above), lightning while charging', () => withHost({}, async (host, cloud) => {
  const { vehicleId: v } = await owned(host, cloud);
  await patchState(host, v, { charging: { state: 'READY_FOR_CHARGING' } });
  const badge = async (soc, lang) => { await patchState(host, v, { soc }); return (await host.quickActions(ADA, lang))[0].widget.badge; };
  for (const [soc, icon, state] of [
    [0, BAT[0], 'crit'], [15, BAT[0], 'crit'], [15.4, BAT[0], 'crit'], [16, BAT[1], 'good'], [40, BAT[1], 'good'], [41, BAT[2], 'good'],
    [75, BAT[2], 'good'], [76, BAT[3], 'good'], [100, BAT[3], 'good'],
  ]) {
    assert.deepEqual(await badge(soc), { icon, value: Math.round(soc), unit: '%', state, label: 'Ladestand' }, `${soc} %`);
  }
  assert.equal((await badge(57.6, 'en')).value, 58, 'a whole number');
  // charging: the lightning battery at every level; a low level stays red
  await patchState(host, v, { charging: { state: 'CHARGING' } });
  assert.deepEqual(await badge(9), { icon: BAT_CHARGING, value: 9, unit: '%', state: 'crit', label: 'Ladestand' });
  assert.deepEqual(await badge(90, 'en'), { icon: BAT_CHARGING, value: 90, unit: '%', state: 'good', label: 'Charge level' });
  await patchState(host, v, { charging: { state: 'READY_FOR_CHARGING' } });
  assert.equal((await badge(50)).icon, BAT[2], 'no longer charging: the level again');
  for (const icon of [...BAT, BAT_CHARGING]) assert.ok(ICON_RE.test(icon), icon);
  assert.equal(new Set([...BAT, BAT_CHARGING]).size, 5, 'five different icons');
}));

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

test('right after a command the apps show the state it aims for, until the vehicle reports it or 3 minutes pass', (t) => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId: v } = await owned(host, cloud);
  await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '4711' });
  const action = async (kind, lang) => (await host.quickActions(ADA, lang)).find((a) => a.id === `${kind}:${v}`);
  const lockItem = async () => (await host.clientTiles(ADA))[0].items.at(-1);
  // window heating: stored off → on is shown at once; the next press switches it off again (not "on" a second time)
  assert.equal((await action('windowheat')).state, 'off');
  await host.runQuickAction(ADA, `windowheat:${v}`);
  assert.equal((await action('windowheat')).state, 'on');
  assert.equal((await host.runQuickAction(ADA, `windowheat:${v}`)).body.state, 'off');
  assert.equal(cloud.commands.at(-1).path, `/api/v2/air-conditioning/${VIN}/stop-window-heating`);
  assert.equal((await action('windowheat')).state, 'off', 'equals the stored state again');
  // climate and charging the same way, the widget follows
  await host.runQuickAction(ADA, `climate:${v}`);
  await host.runQuickAction(ADA, `charging:${v}`);
  assert.deepEqual([(await action('climate')).state, (await action('charging')).state], ['on', 'off']);
  assert.equal((await action('climate')).widget.status, 'Klimatisierung an');
  assert.equal((await action('climate')).widget.badge.icon, BAT[2], 'charging stopped: the badge shows the level, no lightning');
  // the lock: stored locked → unlock; title, icon, state and tile item follow at once (the widget's card stays green)
  await host.runQuickAction(ADA, `lock:${v}`);
  const lock = await action('lock', 'en');
  assert.deepEqual([lock.title, lock.state, lock.icon, lock.look], ['Unlocked', 'off', UNLOCKED, LOOK]);
  assert.deepEqual((await action('climate')).widget.readings.map((r) => r.id), ['range'], 'the lock is no widget reading');
  assert.deepEqual(await lockItem(), { label: 'Entriegelt', value: null, unit: null, icon: UNLOCKED, state: 'crit' });
  assert.equal((await action('climate')).widget.state, 'good', 'unlocked → no warn on the card');
  // the vehicle reports it → the entry goes; a later report is shown as it is
  await patchState(host, v, { locked: false });
  assert.equal((await action('lock')).state, 'off');
  await patchState(host, v, { locked: true });
  assert.deepEqual([(await action('lock')).state, (await lockItem()).icon], ['on', LOCKED]);
  // not reported within 3 minutes → the stored state again
  await host.runQuickAction(ADA, `lock:${v}`);
  assert.equal((await action('lock')).state, 'off');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + control.EXPECT_MS);
  assert.deepEqual([(await action('lock')).state, (await action('lock')).title, (await lockItem()).icon, (await lockItem()).label], ['on', 'Verriegelt', LOCKED, 'Verriegelt']);
}));

test('runQuickAction: a command queued past the time budget answers "on its way" without a state; a late failure is only logged', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId: v } = await owned(host, cloud);
  host.plugin._setQuickActionBudgetForTest(60);
  // the account is busy (e.g. the sync after the previous command): the lock call waits for it
  let release = null;
  const hold = () => { service.withAccountLock(accountId, () => new Promise((r) => { release = r; })); };
  hold();
  // checks before the cloud call still answer at once with their message
  assert.deepEqual(await direct(host, ADA, `lock:${v}`), { ok: false, message: 'Dafür wird die S-PIN des Kontos gebraucht.' });
  await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '4711' });
  const n = cloud.commands.length;
  const started = Date.now();
  let r = await host.runQuickAction(ADA, `lock:${v}`);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(r.body, { ok: true, unchanged: false, message: 'Elroq: Befehl unterwegs – der Status folgt', state: null, widget: null });
  assert.equal(cloud.commands.length, n, 'still waiting for the account');
  assert.equal((await host.quickActions(ADA)).find((a) => a.id === `lock:${v}`).state, 'on', 'the stored state until the command went through');
  release();
  await settle();
  assert.deepEqual(cloud.commands.at(-1), { method: 'POST', path: `/api/v1/vehicle-access/${VIN}/unlock`, body: { currentSpin: '4711' } });
  assert.equal((await host.quickActions(ADA)).find((a) => a.id === `lock:${v}`).state, 'off', 'then the state it aims for');
  // a late failure: the answer is out already, so it is logged
  hold();
  cloud.fail['/vehicle-access/'] = 500;
  r = await host.runQuickAction(ADA, `lock:${v}`, 'en');
  assert.deepEqual(r.body, { ok: true, unchanged: false, message: 'Elroq: command on its way – the status follows', state: null, widget: null });
  assert.ok(!host.logs.some((l) => l.message.includes('quick action failed')));
  release();
  await settle();
  assert.ok(host.logs.some((l) => l.level === 'warn' && l.message.includes('quick action failed late') && l.message.includes(`lock:${v}`)));
  assert.ok(!host.logs.some((l) => l.message.includes('4711')), 'the S-PIN is never logged');
  // fast path unchanged: within the budget the answer carries the state
  delete cloud.fail['/vehicle-access/'];
  host.plugin._setQuickActionBudgetForTest(null);
  r = await host.runQuickAction(ADA, `windowheat:${v}`);
  assert.deepEqual(r.body, { ok: true, unchanged: false, message: 'Elroq: Scheibenheizung wird eingeschaltet', state: 'on', widget: null });
}));

test('runQuickAction: a command Škoda refuses says so with the HTTP status; the log gets Škoda\'s reason', () => withHost({}, async (host, cloud) => {
  const { accountId, vehicleId: v } = await owned(host, cloud);
  await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '4711' });
  cloud.fail['/vehicle-access/'] = { status: 403, body: { errorCode: 'SPIN_INVALID', message: 'The S-PIN is not valid.\nTry again' } };
  // a refused lock/unlock: the stored S-PIN is marked as rejected (control.test.js)
  assert.deepEqual(await direct(host, ADA, `lock:${v}`), { ok: false, message: 'Škoda hat den Befehl abgelehnt (HTTP 403) – bitte die S-PIN im Konto prüfen und neu eingeben.' });
  const line = host.logs.find((l) => l.level === 'warn' && l.message.includes('quick action failed') && l.message.includes(`lock:${v}`));
  assert.ok(line, 'logged');
  for (const part of ['SKODA_API_ERROR', 'HTTP 403', 'SPIN_INVALID – The S-PIN is not valid. Try again']) assert.ok(line.message.includes(part), part);
  assert.ok(!host.logs.some((l) => l.message.includes('4711')), 'the S-PIN is never logged');
  await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '4711' }); // clears the mark
  cloud.fail['/vehicle-access/'] = 503;
  assert.deepEqual(await direct(host, ADA, `lock:${v}`, 'en'), { ok: false, message: 'Škoda cloud error (HTTP 503) – please try again later.' });
}));
