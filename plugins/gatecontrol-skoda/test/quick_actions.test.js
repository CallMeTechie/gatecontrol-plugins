'use strict';

// Quick actions of the GateControl apps (hooks quickActions / runQuickAction):
// the portal's vehicle controls for a signed-in owner — climate, charging and
// window heating as toggles from the stored state, lock and unlock (S-PIN;
// unlock asks first) as buttons; no cloud call in the list; at most 16.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, connected, fakeSkoda, ADMIN, ADA, BOB, VIN } = require('./helpers');

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
  await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '4711' });
  list = await host.quickActions(ADA, 'en');
  assert.deepEqual(list.slice(3).map((a) => [a.id, a.title, a.kind, a.state, a.confirm]), [
    [`lock:${v}`, 'Lock', 'button', null, false],
    [`unlock:${v}`, 'Unlock', 'button', null, true],
  ]);
  assert.ok(!JSON.stringify(list).includes(VIN) && !JSON.stringify(list).includes('4711'));
  assert.deepEqual(await host.quickActions(BOB), [], 'never another person\'s vehicle');
  assert.deepEqual(await host.quickActions(ADMIN), [], 'an administrator gets only what is assigned, like in the portal');
  assert.deepEqual(await host.quickActions({ ...ADA, loggedIn: false }), [], 'no controls without a sign-in, like the portal');
}));

test('quick actions: at most 16 over several vehicles', () => {
  const cloud = fakeSkoda();
  for (let i = 2; i <= 4; i++) cloud.garage.vehicles.push({ vin: `TMBTESTVIN00000${i}`, name: `Auto ${i}`, specification: { model: 'Enyaq' } });
  return withHost({ cloud }, async (host) => {
    const { accountId } = await connected(host, cloud);
    await asAdmin(host, 'PUT', `/accounts/${accountId}/spin`, { spin: '4711' });
    const vehicles = (await asAdmin(host, 'GET', '/')).json.vehicles;
    assert.equal(vehicles.length, 4);
    for (const x of vehicles) await asAdmin(host, 'PUT', `/vehicles/${x.id}/owners`, { user_ids: [ADA.id] });
    const list = await host.quickActions(ADA); // the mock host throws on more than 16
    assert.equal(list.length, 16);
    assert.deepEqual(list.slice(0, 5).map((a) => a.id.split(':')[0]), ['climate', 'charging', 'windowheat', 'lock', 'unlock']);
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
  r = await host.runQuickAction(ADA, `unlock:${v}`);
  assert.deepEqual(r.body, { ok: true, message: 'Elroq wird entriegelt', state: null, widget: null });
  assert.deepEqual(last(), { method: 'POST', path: `/api/v1/vehicle-access/${VIN}/unlock`, body: { currentSpin: '4711' } });
  r = await host.runQuickAction(ADA, `lock:${v}`);
  assert.equal(r.body.message, 'Elroq wird verriegelt');
  assert.equal(last().path, `/api/v1/vehicle-access/${VIN}/lock`);
  await settle();
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
