'use strict';

// Quick actions of the GateControl apps (hooks quickActions / runQuickAction):
// exactly the portal's owner scope — a toggle per own light, plug and group,
// a button per scene of an own group; cached state only; at most 16. Dimmable
// lights and groups carry a widget (brightness value, brightness slider).
// Every resource is a device (r:<id>); a scene belongs to its group's device
// when the viewer has that group.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDeconz, withHost, asAdmin, connected, ADMIN, ADA, BOB } = require('./helpers');

const EVE = { id: 9, name: 'Eve', role: 'user' };
const own = async (host, by, names, userIds) => {
  for (const n of names) await asAdmin(host, 'PUT', `/resources/${by(n).id}/owners`, { userIds });
};
// the hook as the host calls it, without the host's "listed for this viewer" check
const direct = (host, user, id, lang = 'de', extra = {}) => host.plugin.runQuickAction({ user: { portal: true, loggedIn: true, app: true, ...user }, lang, id, ...extra }, host.gc);

/** The widget as the host passes it on: `value` (brightness while on, else the off text), status, state, one slider at `bri`. */
function widget({ value, unit = null, status, state, bri = 100, lang = 'de' }) {
  return { label: lang === 'en' ? 'Brightness' : 'Helligkeit', value, unit, status, state, readings: [], power: true, controls: [{ id: 'bri', kind: 'slider', label: lang === 'en' ? 'Brightness' : 'Helligkeit', value: bri, min: 1, max: 100, step: 1, unit: '%' }] };
}

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
  assert.ok(ada.every((a) => a.icon && a.confirm === false && a.look === null && a.confirmWhen === null));
  assert.deepEqual(ada.map((a) => a.widget), [
    widget({ value: 'An', status: 'Gruppe', state: 'on' }),               // a group has no brightness of its own: "on", slider at 100
    widget({ value: 100, unit: '%', status: 'Licht', state: 'on', bri: 100 }),
    null,                                                                 // a scene stays a button
  ]);
  const bob = await host.quickActions(BOB, 'en');
  assert.deepEqual(bob.map((a) => [a.title, a.subtitle, a.state, a.widget]), [['Poolpumpe', 'Plug', 'off', null]], 'a plug has no widget');
  assert.deepEqual(await host.quickActions(EVE), []);
  assert.deepEqual(await host.quickActions(ADMIN), [], 'an administrator gets only what is assigned to them, like in the portal');
  assert.deepEqual(await host.quickActions({ ...ADA, loggedIn: false }), [], 'never for a viewer that is not signed in');
  // a resource the gateway no longer has is no action
  await host.gc.db.run('UPDATE resources SET enabled = 0 WHERE id = ?', [by('Stehlampe').id]);
  assert.ok(!(await host.quickActions(ADA)).some((a) => a.title === 'Stehlampe'));
}));

const GROUP_ICON = 'M3 11l9-7 9 7M5 10v10h14V10';
const LIGHT_ICON = 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z';
const PLUG_ICON = 'M9 2v5M15 2v5M7 7h10v3a5 5 0 0 1-10 0zM12 15v7';
const SCENE_ICON = 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z';

test('quick actions: a device per light, plug and group; scenes under their group\'s device', () => withHost({ gateways: [fakeDeconz()] }, async (host) => {
  const { by } = await connected(host);
  await own(host, by, ['Stehlampe', 'Wohnzimmer', 'Poolpumpe'], [2]);
  const group = { id: `r:${by('Wohnzimmer').id}`, title: 'Wohnzimmer', subtitle: null, icon: GROUP_ICON };
  let ada = await host.quickActions(ADA);
  assert.deepEqual(ada.map((a) => [a.id, a.device]), [
    [`group:${by('Wohnzimmer').id}`, group],
    [`light:${by('Stehlampe').id}`, { id: `r:${by('Stehlampe').id}`, title: 'Stehlampe', subtitle: null, icon: LIGHT_ICON }],
    [`plug:${by('Poolpumpe').id}`, { id: `r:${by('Poolpumpe').id}`, title: 'Poolpumpe', subtitle: null, icon: PLUG_ICON }],
    [`scene:${by('Wohnzimmer · Abend').id}`, group],
  ]);
  // the group gone (disabled) while its scene stays: the scene is a device of its own
  await host.gc.db.run('UPDATE resources SET enabled = 0 WHERE id = ?', [by('Wohnzimmer').id]);
  ada = await host.quickActions(ADA, 'en');
  assert.deepEqual(ada.find((a) => a.id.startsWith('scene:')).device, { id: `r:${by('Wohnzimmer · Abend').id}`, title: 'Wohnzimmer · Abend', subtitle: null, icon: SCENE_ICON });
  assert.ok(!ada.some((a) => a.device.id === group.id));
}));

test('quick actions: the widget of a light that is off, unreachable or not dimmable', () => {
  const lights = {
    3: { name: 'Stehlampe', type: 'Color temperature light', uniqueid: 'l1', state: { on: true, bri: 254, reachable: false } },
    4: { name: 'Bunt', type: 'Extended color light', uniqueid: 'l2', state: { on: false, bri: 127, reachable: true } },
    5: { name: 'Flur', type: 'On/Off light', uniqueid: 'l3', state: { on: true, reachable: true } },
  };
  return withHost({ gateways: [fakeDeconz({ lights, groups: {} })] }, async (host) => {
    const { by } = await connected(host);
    await own(host, by, ['Stehlampe', 'Bunt', 'Flur'], [2]);
    const w = Object.fromEntries((await host.quickActions(ADA, 'en')).map((a) => [a.title, a.widget]));
    assert.deepEqual(w.Stehlampe, widget({ value: 100, unit: '%', status: 'Light · unreachable', state: 'on', bri: 100, lang: 'en' }));
    assert.deepEqual(w.Bunt, widget({ value: 'Off', status: 'Light', state: 'off', bri: 50, lang: 'en' }), 'off: the off text, the slider keeps the last brightness');
    assert.equal(w.Flur, null, 'an on/off light has no widget');
    assert.equal((await host.quickActions(ADA)).find((a) => a.title === 'Bunt').widget.value, 'Aus');
  });
});

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
    assert.deepEqual(r, { status: 200, body: { ok: true, message: 'Stehlampe ausgeschaltet', state: 'off', widget: widget({ value: 'Aus', status: 'Licht', state: 'off', bri: 100 }) } });
    assert.deepEqual([gw.calls.at(-1).method, gw.calls.at(-1).path, gw.calls.at(-1).body], ['PUT', '/api/KEY1234567/lights/3/state', { on: false }]);
    assert.equal((await host.quickActions(ADA)).find((a) => a.id === lamp).state, 'off', 'the list follows at once');
    r = await host.runQuickAction(ADA, lamp, 'en');
    assert.deepEqual(r.body, { ok: true, message: 'Stehlampe switched on', state: 'on', widget: widget({ value: 100, unit: '%', status: 'Light', state: 'on', bri: 100, lang: 'en' }) });
    assert.deepEqual(gw.calls.at(-1).body, { on: true });
    r = await host.runQuickAction(ADA, `group:${by('Wohnzimmer').id}`);
    assert.deepEqual(r.body, { ok: true, message: 'Wohnzimmer ausgeschaltet', state: 'off', widget: widget({ value: 'Aus', status: 'Gruppe', state: 'off' }) });
    assert.equal(gw.calls.at(-1).path, '/api/KEY1234567/groups/8/action');
    r = await host.runQuickAction(ADA, `scene:${by('Wohnzimmer · Abend').id}`);
    assert.deepEqual(r.body, { ok: true, message: 'Szene „Wohnzimmer · Abend“ aktiviert', state: null, widget: null });
    assert.equal(gw.calls.at(-1).path, '/api/KEY1234567/groups/8/scenes/2/recall');
  });
});

test('runQuickAction with the brightness control: sets the brightness and switches on, the answer carries the new widget', () => {
  const gw = fakeDeconz();
  return withHost({ gateways: [gw] }, async (host) => {
    const { by } = await connected(host);
    await own(host, by, ['Stehlampe', 'Bunt', 'Wohnzimmer', 'Poolpumpe'], [2]);
    const lamp = `light:${by('Stehlampe').id}`;
    const bunt = `light:${by('Bunt').id}`;
    let r = await host.runQuickAction(ADA, lamp, 'de', { control: 'bri', value: 60 });
    assert.deepEqual(r, { status: 200, body: { ok: true, message: null, state: 'on', widget: widget({ value: 60, unit: '%', status: 'Licht', state: 'on', bri: 60 }) } });
    assert.deepEqual([gw.calls.at(-1).path, gw.calls.at(-1).body], ['/api/KEY1234567/lights/3/state', { on: true, bri: 152 }]);
    assert.equal((await host.quickActions(ADA)).find((a) => a.id === lamp).subtitle, 'Licht · 60 %', 'the list follows at once');
    // a light that is off comes on with the brightness
    r = await host.runQuickAction(ADA, bunt, 'en', { control: 'bri', value: 1 });
    assert.deepEqual(r.body, { ok: true, message: null, state: 'on', widget: widget({ value: 1, unit: '%', status: 'Light', state: 'on', bri: 1, lang: 'en' }) });
    assert.deepEqual(gw.calls.at(-1).body, { on: true, bri: 3 });
    r = await host.runQuickAction(ADA, `group:${by('Wohnzimmer').id}`, 'de', { control: 'bri', value: 100 });
    assert.deepEqual(r.body, { ok: true, message: null, state: 'on', widget: widget({ value: 100, unit: '%', status: 'Gruppe', state: 'on', bri: 100 }) });
    assert.deepEqual([gw.calls.at(-1).path, gw.calls.at(-1).body], ['/api/KEY1234567/groups/8/action', { on: true, bri: 254 }]);
    // the host checks control and value against the listed widget before the hook sees them
    const n = gw.calls.length;
    for (const [id, control, value] of [[lamp, 'on', true], [lamp, 'bri', 0], [lamp, 'bri', 101], [lamp, 'bri', '50'], [`plug:${by('Poolpumpe').id}`, 'bri', 50], [`scene:${by('Wohnzimmer · Abend').id}`, 'bri', 50]]) {
      const bad = await host.runQuickAction(ADA, id, 'de', { control, value });
      assert.equal(bad.status, 400, `${id} ${control} ${value}`);
    }
    // … and the hook checks again on its own
    for (const [id, control, value] of [[lamp, 'on', true], [lamp, 'bri', 0], [lamp, 'bri', 100.5], [lamp, 'bri', '50'], [lamp, 'bri', NaN], [lamp, null, 50], [`plug:${by('Poolpumpe').id}`, 'bri', 50], [`scene:${by('Wohnzimmer · Abend').id}`, 'bri', 50]]) {
      const out = await direct(host, ADA, id, 'de', { control, value });
      assert.deepEqual(out, { ok: false, message: 'Diese Aktion gibt es nicht mehr.' }, `${id} ${control} ${value}`);
    }
    assert.equal((await direct(host, BOB, lamp, 'de', { control: 'bri', value: 50 })).message, 'Dieses Gerät gehört dir nicht.');
    assert.equal(gw.calls.length, n, 'nothing reached the gateway');
    gw.down = true;
    r = await host.runQuickAction(ADA, lamp, 'de', { control: 'bri', value: 30 });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.deepEqual(r.body.widget, widget({ value: 60, unit: '%', status: 'Licht', state: 'on', bri: 60 }), 'a failed run answers with the widget as it was');
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
