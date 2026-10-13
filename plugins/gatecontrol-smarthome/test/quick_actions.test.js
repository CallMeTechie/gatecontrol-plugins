'use strict';

// Quick actions of the GateControl apps (hooks quickActions / runQuickAction):
// exactly the portal's owner scope — a toggle per own light, plug and group,
// a button per scene of an own group; cached state only; at most 16.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDeconz, withHost, asAdmin, connected, ADMIN, ADA, BOB } = require('./helpers');

const EVE = { id: 9, name: 'Eve', role: 'user' };
const own = async (host, by, names, userIds) => {
  for (const n of names) await asAdmin(host, 'PUT', `/resources/${by(n).id}/owners`, { userIds });
};
// the hook as the host calls it, without the host's "listed for this viewer" check
const direct = (host, user, id, lang = 'de') => host.plugin.runQuickAction({ user: { portal: true, loggedIn: true, app: true, ...user }, lang, id }, host.gc);

test('quick actions: only the viewer\'s own devices, toggles first, scenes as buttons, sensors never', () => withHost({ gateways: [fakeDeconz()] }, async (host) => {
  const { by } = await connected(host);
  await own(host, by, ['Stehlampe', 'Wohnzimmer', 'Temp', 'Fensterkontakt'], [2]);
  await own(host, by, ['Poolpumpe'], [3]);
  const ada = await host.quickActions(ADA);
  assert.deepEqual(ada.map((a) => [a.id, a.title, a.subtitle, a.kind, a.state]), [
    [`group:${by('Wohnzimmer').id}`, 'Wohnzimmer', 'Gruppe', 'toggle', 'on'],
    [`light:${by('Stehlampe').id}`, 'Stehlampe', 'Licht · 100 %', 'toggle', 'on'],
    [`scene:${by('Wohnzimmer · Abend').id}`, 'Wohnzimmer · Abend', 'Szene', 'button', null],
  ]);
  assert.ok(ada.every((a) => a.icon && a.confirm === false));
  assert.deepEqual((await host.quickActions(BOB, 'en')).map((a) => [a.title, a.subtitle, a.state]), [['Poolpumpe', 'Plug', 'off']]);
  assert.deepEqual(await host.quickActions(EVE), []);
  assert.deepEqual(await host.quickActions(ADMIN), [], 'an administrator gets only what is assigned to them, like in the portal');
  assert.deepEqual(await host.quickActions({ ...ADA, loggedIn: false }), [], 'never for a viewer that is not signed in');
  // a resource the gateway no longer has is no action
  await host.gc.db.run('UPDATE resources SET enabled = 0 WHERE id = ?', [by('Stehlampe').id]);
  assert.ok(!(await host.quickActions(ADA)).some((a) => a.title === 'Stehlampe'));
}));

test('quick actions: at most 16, scenes are the first to go; long names cut to 40', () => {
  const lights = {};
  for (let i = 1; i <= 20; i++) lights[i] = { name: `Licht ${String(i).padStart(2, '0')} ${'x'.repeat(i === 1 ? 60 : 0)}`.trim(), type: 'Dimmable light', uniqueid: `u${i}`, state: { on: i % 2 === 0, bri: 127 } };
  return withHost({ gateways: [fakeDeconz({ lights })] }, async (host) => {
    const { resources } = await connected(host);
    for (const r of resources.filter((x) => x.kind === 'light' || x.kind === 'group')) await asAdmin(host, 'PUT', `/resources/${r.id}/owners`, { userIds: [2] });
    const list = await host.quickActions(ADA); // the mock host throws on more than 16 or a title over 40
    assert.equal(list.length, 16);
    assert.ok(list.every((a) => a.kind === 'toggle'), 'toggles fill the list before scenes');
    assert.ok(list.some((a) => a.title.startsWith('Licht 01 x') && a.title.length === 40));
    assert.deepEqual(list.filter((a) => a.title.startsWith('Licht 02')).map((a) => [a.state, a.subtitle]), [['on', 'Licht · 50 %']]);
  });
});

test('runQuickAction: a toggle switches the cached state over, a scene is recalled, both reach the gateway', () => {
  const gw = fakeDeconz();
  return withHost({ gateways: [gw] }, async (host) => {
    const { by } = await connected(host);
    await own(host, by, ['Stehlampe', 'Wohnzimmer'], [2]);
    const lamp = `light:${by('Stehlampe').id}`;
    let r = await host.runQuickAction(ADA, lamp);
    assert.deepEqual(r, { status: 200, body: { ok: true, message: 'Stehlampe ausgeschaltet', state: 'off' } });
    assert.deepEqual([gw.calls.at(-1).method, gw.calls.at(-1).path, gw.calls.at(-1).body], ['PUT', '/api/KEY1234567/lights/3/state', { on: false }]);
    assert.equal((await host.quickActions(ADA)).find((a) => a.id === lamp).state, 'off', 'the list follows at once');
    r = await host.runQuickAction(ADA, lamp, 'en');
    assert.deepEqual(r.body, { ok: true, message: 'Stehlampe switched on', state: 'on' });
    assert.deepEqual(gw.calls.at(-1).body, { on: true });
    r = await host.runQuickAction(ADA, `group:${by('Wohnzimmer').id}`);
    assert.deepEqual(r.body, { ok: true, message: 'Wohnzimmer ausgeschaltet', state: 'off' });
    assert.equal(gw.calls.at(-1).path, '/api/KEY1234567/groups/8/action');
    r = await host.runQuickAction(ADA, `scene:${by('Wohnzimmer · Abend').id}`);
    assert.deepEqual(r.body, { ok: true, message: 'Szene „Wohnzimmer · Abend“ aktiviert', state: null });
    assert.equal(gw.calls.at(-1).path, '/api/KEY1234567/groups/8/scenes/2/recall');
  });
});

test('runQuickAction: unknown ids, other people\'s devices and wrong kinds change nothing', () => {
  const gw = fakeDeconz();
  return withHost({ gateways: [gw] }, async (host) => {
    const { by } = await connected(host);
    await own(host, by, ['Stehlampe', 'Temp'], [2]);
    const lamp = by('Stehlampe').id;
    const n = gw.calls.length;
    for (const id of ['light:999', `plug:${lamp}`, `sensor:${by('Temp').id}`, 'nope', '']) {
      assert.equal((await host.runQuickAction(ADA, id)).status, 404, id);
    }
    assert.equal((await host.runQuickAction(BOB, `light:${lamp}`)).status, 404, 'not listed for Bob');
    // the hook checks again on its own (never trusts that the host did)
    for (const [user, id] of [[BOB, `light:${lamp}`], [ADA, `plug:${lamp}`], [ADA, `light:${by('Temp').id}`], [ADA, 'light:0'], [ADA, 'x'], [{ ...ADA, loggedIn: false }, `light:${lamp}`]]) {
      const out = await direct(host, user, id);
      assert.equal(out.ok, false, `${user.name} ${id}`);
      assert.equal(typeof out.message, 'string');
    }
    assert.equal((await direct(host, BOB, `light:${lamp}`)).message, 'Dieses Gerät gehört dir nicht.');
    assert.equal((await direct(host, ADA, 'x', 'en')).message, 'This action no longer exists.');
    assert.equal(gw.calls.length, n, 'nothing reached the gateway');
  });
});

test('runQuickAction: an unreachable gateway is a failed action with a message, not an error', () => {
  const gw = fakeDeconz();
  return withHost({ gateways: [gw] }, async (host) => {
    const { by } = await connected(host);
    await own(host, by, ['Stehlampe'], [2]);
    gw.down = true;
    const r = await host.runQuickAction(ADA, `light:${by('Stehlampe').id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.ok(r.body.message && r.body.message.length <= 120, r.body.message);
    assert.equal(r.body.state, null);
  });
});
