'use strict';

// Ring location modes (Ring app: Inaktiv / Zuhause / Abwesend), faked like the
// rest of the unofficial Ring API: locations with the device sync, Ring Alarm
// locations left alone, the mode poll, three quick-action buttons per location
// plus the widget's choice, rights ("Ring-Modus schalten", administrators
// always), the portal / admin API, Ring errors → clear messages, history.

const test = require('node:test');
const assert = require('node:assert/strict');
const plugin = require('../server/index');
const ring = require('../server/ring');
const modes = require('../server/modes');
const { withDoor, ringLogin, app, portal, kiosk, ADMIN, ANNA, MARC, LENA, GAST, SEC, MIN, T0, HOUR } = require('./helpers');

const MODE_URL = 'https://prd-api-us.prd.rings.solutions/api/v1/mode/location/';

/** Three locations: loc1 (modes on, home), loc2 (a Ring Alarm base station), loc3 (modes off in the Ring app). */
function threeLocations(cloud) {
  const R = cloud.ring;
  R.locations.push({ location_id: 'loc2', name: 'Ferienhaus', owner_id: 1 }, { location_id: 'loc3', name: 'Garage', owner_id: 1 });
  R.devices.stickup_cams.push({ id: 333, description: 'Ferienhaus Hof', kind: 'stickup_cam_v4', location_id: 'loc2', alerts: {}, settings: {} },
    { id: 444, description: 'Garage', kind: 'stickup_cam_v4', location_id: 'loc3', alerts: {}, settings: {} });
  R.devices.base_stations = [{ id: 900, description: 'Alarm', kind: 'base_station_v1', location_id: 'loc2' }];
  R.modes.loc2 = { mode: 'away', readOnly: false, lastUpdateTimeMS: T0 };
  R.modes.loc3 = { mode: 'disabled', readOnly: false, lastUpdateTimeMS: T0 };
}

const modeCalls = (cloud, method) => cloud.calls.filter((c) => c.url.startsWith(MODE_URL) && (!method || c.method === method));

test('locations: modes read after the login; a Ring Alarm location is never read or switched; modes off → not offered', () => withDoor({}, async (host, ctx) => {
  const { admin, cloud } = ctx;
  threeLocations(cloud);
  await ringLogin(ctx);
  const list = (await admin('GET', 'status')).json.ringModes;
  assert.deepEqual(list.map((l) => [l.id, l.name, l.mode, l.supported, l.why, l.cameras, l.alarm]), [
    ['loc3', 'Garage', 'disabled', false, 'disabled', 1, false],
    ['loc1', 'Langenlonsheim', 'home', true, null, 2, false],
    ['loc2', 'Ferienhaus', null, false, 'alarm', 1, true],
  ]);
  assert.equal(list[1].modeAt, new Date(T0 - HOUR).toISOString().replace('.000', ''));
  // the alarm location's mode is never asked for, let alone set
  assert.ok(!cloud.calls.some((c) => c.url.includes('/mode/location/loc2')));
  // the same headers and session as every Ring request
  const get = modeCalls(cloud, 'GET').find((c) => c.url.endsWith('/loc1'));
  assert.equal(get.url, MODE_URL + 'loc1');
  assert.equal(get.headers.authorization, `Bearer at-${cloud.ring.rt}`);
  assert.equal(get.headers['user-agent'], 'android:com.ringapp');
  assert.match(get.headers.hardware_id, /^[0-9a-f-]{36}$/);
  assert.ok(cloud.calls.some((c) => c.url === ring.DEVICES_API + 'locations'));
  // switching them is refused (with the history entry), Ring is not asked
  const a = await admin('POST', 'modes/loc2/disarmed');
  assert.deepEqual([a.status, a.json.code, a.json.error], [409, 'mode_alarm', 'An diesem Standort ist eine Ring-Alarmanlage – ihren Modus schaltet nur die Ring-App.']);
  const d = await admin('POST', 'modes/loc3/home');
  assert.deepEqual([d.status, d.json.code], [409, 'mode_disabled']);
  assert.equal(modeCalls(cloud, 'POST').length, 0);
  const rows = (await admin('GET', 'history', null, { kind: 'mode' })).json.items;
  assert.deepEqual(rows.map((r) => [r.locationName, r.action, r.result, r.reason, r.via]), [['Garage', 'home', 'refused', 'mode_disabled', 'admin'], ['Ferienhaus', 'disarmed', 'refused', 'mode_alarm', 'admin']]);
  // rights only for locations it makes sense for (no alarm)
  const rv = (await admin('GET', 'rights')).json;
  assert.deepEqual(rv.locations, [{ id: 'loc3', name: 'Garage', supported: false }, { id: 'loc1', name: 'Langenlonsheim', supported: true }]);
  assert.equal((await admin('PUT', `rights/${ANNA.id}`, { modes: { loc2: true } })).json.code, 'invalid');
  // quick actions: only loc1
  assert.deepEqual((await host.quickActions(ADMIN)).map((x) => x.id), ['mode:loc1', 'mode_disarmed:loc1']);
}));

test('quick actions: per location the toggle Zuhause ⇄ Abwesend (carries the widget) and the button "Inaktiv"; the two old buttons are gone', () => withDoor({}, async (host, ctx) => {
  await ringLogin(ctx);
  const list = await host.quickActions(ADMIN);
  assert.deepEqual(list.map((x) => [x.id, x.title, x.subtitle, x.kind, x.state, x.confirm]), [
    ['mode:loc1', 'Zuhause', 'Langenlonsheim', 'toggle', 'off', false],
    ['mode_disarmed:loc1', 'Inaktiv', 'Aktuell: Zuhause', 'button', null, false],
  ]);
  assert.ok(!list.some((x) => /^mode_(home|away):/.test(x.id)), 'mode_home / mode_away no longer listed');
  assert.deepEqual(list[0].device, { id: 'ring:loc1', title: 'Langenlonsheim', subtitle: 'Ring-Modus', icon: modes.ICONS.device });
  assert.ok(list.every((x) => x.device.id === 'ring:loc1'));
  assert.deepEqual(list[0].look, { on: { icon: modes.ICONS.away, tone: 'good' }, off: { icon: modes.ICONS.home, tone: 'neutral' } });
  assert.deepEqual([list[0].verbs, list[0].targets, list[0].confirmWhen], [{ on: 'Abwesend', off: 'Zuhause' }, true, null]);
  assert.deepEqual([list[0].icon, list[1].icon, list[1].look, list[1].verbs, list[1].targets], [modes.ICONS.home, modes.ICONS.disarmed, null, null, false]);
  assert.deepEqual(list[0].widget.controls, [{ id: 'mode', kind: 'choice', label: 'Modus', value: 'home', options: [{ id: 'disarmed', label: 'Inaktiv' }, { id: 'home', label: 'Zuhause' }, { id: 'away', label: 'Abwesend' }] }]);
  assert.deepEqual([list[0].widget.label, list[0].widget.value, list[0].widget.state, list[0].widget.power], ['Ring-Modus', 'Zuhause', 'good', false]);
  assert.equal(list[1].widget, null);
  // the options carry the icons (GateControl ≥ 1.174.0 passes them on; the mock host drops them like older hosts)
  const raw = await plugin.quickActions({ user: app(ADMIN), lang: 'de' }, host.gc);
  assert.deepEqual(raw[0].widget.controls[0].options.map((o) => o.icon), [modes.ICONS.disarmed, modes.ICONS.home, modes.ICONS.away]);
  // English
  const en = await host.quickActions(ADMIN, 'en');
  assert.deepEqual(en.map((x) => x.title), ['Home', 'Disarmed']);
  assert.deepEqual(en[0].verbs, { on: 'Away', off: 'Home' });
  assert.equal(en[0].widget.label, 'Ring mode');
  assert.equal(en[1].subtitle, 'Current: Home');
  assert.deepEqual((await host.quickActions(ANNA)).map((x) => x.id).filter((id) => id.startsWith('mode')), [], 'Anna has no mode right');
}));

test('the toggle per mode: state, title, icon — away on, home off, disarmed / unknown null "Ring-Modus"', () => withDoor({}, async (host, ctx) => {
  const { cloud, clock } = ctx;
  await ringLogin(ctx);
  for (const [mode, state, title, icon] of [['away', 'on', 'Abwesend', modes.ICONS.away], ['home', 'off', 'Zuhause', modes.ICONS.home], ['disarmed', null, 'Ring-Modus', modes.ICONS.device]]) {
    cloud.ring.modes.loc1.mode = mode;
    clock.add(61 * SEC);
    await host.tick();
    const [tg, btn] = await host.quickActions(ADMIN);
    assert.deepEqual([tg.id, tg.state, tg.title, tg.icon, tg.widget.controls[0].value], ['mode:loc1', state, title, icon, mode], mode);
    assert.equal(btn.id, 'mode_disarmed:loc1');
  }
  assert.deepEqual([modes.toggleState('away'), modes.toggleState('home'), modes.toggleState('disarmed'), modes.toggleState(null)], ['on', 'off', null, null]);
}));

test('the toggle without a target: away → home, home → away, disarmed → home; the answer has the new state and widget; history', () => withDoor({}, async (host, ctx) => {
  const { cloud, admin } = ctx;
  await ringLogin(ctx);
  const run = async (o) => (await host.runQuickAction(ADMIN, 'mode:loc1', 'de', o || {})).body;
  let r = await run(); // home → away
  assert.deepEqual([r.ok, r.message, r.state, r.widget.value, r.unchanged], [true, 'Ring: Abwesend', 'on', 'Abwesend', false]);
  assert.equal(cloud.ring.modes.loc1.mode, 'away');
  const listed = await host.quickActions(ADMIN);
  assert.deepEqual([listed[0].state, listed[0].title, listed[1].subtitle], ['on', 'Abwesend', 'Aktuell: Abwesend'], 'the new mode shows at once');
  assert.equal((await admin('GET', 'status')).json.ringModes[0].mode, 'away');
  r = await run(); // away → home
  assert.deepEqual([r.message, r.state], ['Ring: Zuhause', 'off']);
  const off = (await host.runQuickAction(ADMIN, 'mode_disarmed:loc1', 'de', { via: 'notification' })).body;
  assert.deepEqual([off.ok, off.message, off.state, off.widget], [true, 'Ring: Inaktiv', null, null]);
  assert.equal((await host.quickActions(ADMIN))[0].state, null);
  r = await run({ via: 'notification' }); // disarmed → home
  assert.deepEqual([r.message, r.state], ['Ring: Zuhause', 'off']);
  assert.equal((await host.runQuickAction(ADMIN, 'mode:loc1', 'en')).body.message, 'Ring: Away');
  assert.deepEqual(modeCalls(cloud, 'POST').map((c) => [c.url, c.json.mode]), [[MODE_URL + 'loc1', 'away'], [MODE_URL + 'loc1', 'home'], [MODE_URL + 'loc1', 'disarmed'], [MODE_URL + 'loc1', 'home'], [MODE_URL + 'loc1', 'away']]);
  const rows = (await admin('GET', 'history', null, { kind: 'mode' })).json.items;
  assert.deepEqual(rows.map((x) => [x.action, x.result, x.via, x.userName, x.locationName]), [
    ['away', 'ok', 'app', 'admin', 'Langenlonsheim'], ['home', 'ok', 'notification', 'admin', 'Langenlonsheim'],
    ['disarmed', 'ok', 'notification', 'admin', 'Langenlonsheim'], ['home', 'ok', 'app', 'admin', 'Langenlonsheim'], ['away', 'ok', 'app', 'admin', 'Langenlonsheim'],
  ]);
  // the old ids are not listed any more → 404 from the host, and the plugin does not know them either
  assert.equal((await host.runQuickAction(ADMIN, 'mode_away:loc1')).status, 404);
  assert.deepEqual(await plugin.runQuickAction({ user: app(ADMIN), lang: 'de', id: 'mode_home:loc1', via: 'app', automation: false }, host.gc), { ok: false, message: 'Nicht gefunden.' });
}));

test('the toggle with a target sets exactly that mode from every mode (also again); rules too', () => withDoor({}, async (host, ctx) => {
  const { cloud, clock } = ctx;
  await ringLogin(ctx);
  for (const from of ['disarmed', 'home', 'away']) {
    for (const [target, want] of [['on', 'away'], ['off', 'home']]) {
      cloud.ring.modes.loc1.mode = from;
      clock.add(61 * SEC);
      await host.tick();
      const n = modeCalls(cloud, 'POST').length;
      const r = await host.runQuickAction(ADMIN, 'mode:loc1', 'de', { state: target });
      assert.deepEqual([r.status, r.body.ok, r.body.state, r.body.unchanged, r.body.message], [200, true, target, false, `Ring: ${want === 'away' ? 'Abwesend' : 'Zuhause'}`], `${from} → ${target}`);
      assert.deepEqual(modeCalls(cloud, 'POST').slice(n).map((c) => c.json), [{ mode: want }], `${from} → ${target}: sent even when already there`);
      assert.equal(cloud.ring.modes.loc1.mode, want);
      clock.add(7 * SEC); // stay below 10 switches per minute
    }
  }
  // a Familie rule (gc.actions.run with a target state)
  const rule = await host.runQuickAction(ADMIN, 'mode:loc1', 'de', { automation: true, via: 'gatecontrol-familie', state: 'on' });
  assert.deepEqual([rule.body.ok, rule.body.state, cloud.ring.modes.loc1.mode], [true, 'on', 'away']);
  assert.deepEqual((await host.runQuickAction(ADMIN, 'mode_disarmed:loc1', 'de', { state: 'on' })).body, { ok: false, error: 'invalid_state' }, 'the button has no states');
}));

test('the widget (on the toggle): the choice control "mode" sets that mode; anything else never reaches Ring', () => withDoor({}, async (host, ctx) => {
  const { cloud } = ctx;
  await ringLogin(ctx);
  const r = await host.runQuickAction(ADMIN, 'mode:loc1', 'de', { control: 'mode', value: 'away' });
  assert.deepEqual([r.body.ok, r.body.message, r.body.state, r.body.widget.value, r.body.widget.controls[0].value], [true, 'Ring: Abwesend', 'on', 'Abwesend', 'away']);
  const d = await host.runQuickAction(ADMIN, 'mode:loc1', 'de', { control: 'mode', value: 'disarmed' });
  assert.deepEqual([d.body.message, d.body.state, d.body.widget.value], ['Ring: Inaktiv', null, 'Inaktiv']);
  assert.deepEqual(modeCalls(cloud, 'POST').map((c) => c.json), [{ mode: 'away' }, { mode: 'disarmed' }]);
  assert.deepEqual((await host.runQuickAction(ADMIN, 'mode:loc1', 'de', { control: 'mode', value: 'panic' })).body, { ok: false, error: 'invalid_value' });
  assert.deepEqual((await host.runQuickAction(ADMIN, 'mode:loc1', 'de', { control: 'volume', value: 3 })).body, { ok: false, error: 'invalid_control' });
  assert.deepEqual((await host.runQuickAction(ADMIN, 'mode_disarmed:loc1', 'de', { control: 'mode', value: 'home' })).body, { ok: false, error: 'invalid_control' }, 'only the toggle has the widget');
  // the plugin checks the value itself as well
  const direct = await plugin.runQuickAction({ user: app(ADMIN), lang: 'de', id: 'mode:loc1', via: 'app', automation: false, control: 'mode', value: 'panic' }, host.gc);
  assert.deepEqual(direct, { ok: false, message: 'Ungültige Eingabe.' });
  assert.equal(modeCalls(cloud, 'POST').length, 2);
}));

test('rights: "Ring-Modus schalten" per person and location; administrators always; rules run as the person; kiosk and time window', () => withDoor({}, async (host, ctx) => {
  const { admin, call, cloud, clock } = ctx;
  await ringLogin(ctx);
  // nobody but administrators at first
  for (const u of [ANNA, MARC, LENA, GAST]) assert.deepEqual((await host.quickActions(u)).filter((x) => x.id.startsWith('mode')), []);
  assert.equal((await host.runQuickAction(MARC, 'mode:loc1')).status, 404);
  assert.equal((await call(app(MARC), 'POST', '/modes/loc1/away')).status, 404);
  assert.deepEqual((await call(app(MARC), 'GET', '/me')).json.ringModes, []);
  // the admin page assigns the right
  const rv = (await admin('PUT', `rights/${MARC.id}`, { modes: { loc1: true } })).json;
  assert.deepEqual(rv.modeRights, { [MARC.id]: ['loc1'] });
  assert.equal((await admin('PUT', `rights/${MARC.id}`, { modes: { loc1: 'yes' } })).json.code, 'invalid');
  assert.equal((await admin('PUT', `rights/${MARC.id}`, { modes: { nowhere: true } })).json.code, 'invalid');
  assert.deepEqual((await host.quickActions(MARC)).map((x) => x.id).filter((id) => id.startsWith('mode')), ['mode:loc1', 'mode_disarmed:loc1']);
  // a Familie rule (gc.actions.run) as Marc
  const rule = await host.runQuickAction(MARC, 'mode:loc1', 'de', { automation: true, via: 'gatecontrol-familie', state: 'on' });
  assert.deepEqual([rule.status, rule.body.ok, rule.body.message], [200, true, 'Ring: Abwesend']);
  const h = (await admin('GET', 'history', null, { kind: 'mode' })).json.items[0];
  assert.deepEqual([h.userName, h.via, h.caller, h.action], ['Marc', 'automation', 'gatecontrol-familie', 'away']);
  // an administrator's rule works without any assignment
  assert.equal((await host.runQuickAction(ADMIN, 'mode:loc1', 'de', { automation: true, via: 'gatecontrol-familie', state: 'off' })).body.message, 'Ring: Zuhause');
  // portal (signed in) and the app API
  const me = (await call(portal(MARC), 'GET', '/me')).json.ringModes;
  assert.deepEqual(me, [{ id: 'loc1', name: 'Langenlonsheim', mode: 'home', modes: ['disarmed', 'home', 'away'], blocked: null, modeAt: me[0].modeAt, checkedAt: me[0].checkedAt }]);
  const p = await call(portal(MARC), 'POST', '/modes/loc1/disarmed');
  assert.deepEqual([p.status, p.json.message, p.json.ringMode.mode], [200, 'Ring: Inaktiv', 'disarmed']);
  assert.equal((await admin('GET', 'history', null, { kind: 'mode' })).json.items[0].via, 'portal');
  assert.equal((await call(portal(MARC), 'POST', '/modes/loc1/panic')).status, 404);
  // kiosk / device-trust viewers only look
  const k = await call(kiosk(MARC), 'POST', '/modes/loc1/away');
  assert.deepEqual([k.status, k.json.code], [403, 'read_only']);
  assert.equal((await call(kiosk(MARC), 'GET', '/me')).json.ringModes[0].blocked, 'read_only');
  assert.equal((await call(portal(MARC, false), 'POST', '/modes/loc1/away')).json.code, 'read_only');
  // the person's time window (Mon–Fri 07:00–09:00 Berlin; now Wednesday 10:00)
  await admin('PUT', `rights/${MARC.id}`, { window: { days: [1, 2, 3, 4, 5], from: '07:00', to: '09:00' } });
  const w = await host.runQuickAction(MARC, 'mode:loc1', 'de', { automation: true, via: 'gatecontrol-familie', state: 'on' });
  assert.deepEqual([w.body.ok, w.body.message], [false, 'Außerhalb deines Zeitfensters.']);
  assert.equal((await call(app(MARC), 'GET', '/me')).json.ringModes[0].blocked, 'outside_window');
  clock.set(Date.UTC(2026, 9, 15, 6, 0, 0)); // Thursday 08:00 Berlin
  assert.equal((await host.runQuickAction(MARC, 'mode:loc1', 'de', { state: 'on' })).body.ok, true);
  // taking the right away
  await admin('PUT', `rights/${MARC.id}`, { modes: { loc1: false } });
  assert.equal((await host.runQuickAction(MARC, 'mode:loc1', 'de', { state: 'off' })).status, 404);
  assert.equal(cloud.ring.modes.loc1.mode, 'away');
  // the portal tab: people with a lock right or a mode right; tiles show the mode
  assert.equal(await plugin.portalVisible({ user: portal(GAST) }, host.gc), false);
  assert.equal(await plugin.portalVisible({ user: portal(ADMIN) }, host.gc), true, 'administrators may always switch');
  assert.equal(await plugin.appVisible(app(ADMIN), host.gc), false, 'the app tab stays lock-only');
  const tiles = await host.portalTiles(ADMIN);
  assert.deepEqual(tiles.map((x) => [x.title, x.value, x.state]), [['Ring-Modus · Langenlonsheim', 'Abwesend', 'good']]);
}));

test('Ring errors → clear messages (with Ring\'s HTTP status), the history says failed; nothing changes', () => withDoor({}, async (host, ctx) => {
  const { cloud, admin, clock } = ctx;
  await ringLogin(ctx);
  const R = cloud.ring;
  const run = async (id, lang) => (await host.runQuickAction(ADMIN, id, lang || 'de', { state: 'on' })).body;
  R.modeStatus = 403;
  assert.deepEqual(await run('mode:loc1'), { ok: false, message: 'Ring lehnt den Moduswechsel ab (HTTP 403).', state: null, widget: null, unchanged: false });
  assert.equal((await run('mode:loc1', 'en')).message, 'Ring refused the mode change (HTTP 403).');
  const api = await admin('POST', 'modes/loc1/away');
  assert.deepEqual([api.status, api.json.code, api.json.httpStatus], [502, 'ring_mode_refused', 403]);
  R.modeStatus = 503;
  assert.equal((await run('mode:loc1')).message, 'Ring hat den Modus nicht umgestellt (HTTP 503).');
  R.modeStatus = null;
  R.modeDown = true;
  assert.equal((await run('mode:loc1')).message, 'Ring ist nicht erreichbar – der Modus wurde nicht umgestellt.');
  R.modeDown = false;
  R.modeIgnore = true;
  assert.equal((await run('mode:loc1')).message, 'Ring hat den Modus nicht übernommen und meldet weiter „Zuhause“.');
  assert.equal((await admin('POST', 'modes/loc1/away')).json.error, 'Ring hat den Modus nicht übernommen und meldet weiter „Zuhause“.');
  R.modeIgnore = false;
  R.status429 = true;
  assert.equal((await run('mode:loc1')).message, 'Ring bremst gerade – bitte später erneut versuchen.');
  R.status429 = false;
  const rows = (await admin('GET', 'history', null, { kind: 'mode' })).json.items;
  assert.deepEqual(rows.map((r) => [r.result, r.reason]), [
    ['failed', 'ring_rate_limited'], ['failed', 'ring_mode_mismatch'], ['failed', 'ring_mode_mismatch'], ['failed', 'ring_mode_unreachable'],
    ['failed', 'ring_mode_failed'], ['failed', 'ring_mode_refused'], ['failed', 'ring_mode_refused'], ['failed', 'ring_mode_refused'],
  ]);
  assert.equal(rows[0].reasonText, 'Ring bremst gerade');
  assert.equal(R.modes.loc1.mode, 'home');
  assert.equal((await admin('GET', 'status')).json.ringModes[0].mode, 'home');
  // not connected
  await admin('POST', 'ring/logout');
  clock.add(MIN);
  const nc = await admin('POST', 'modes/loc1/away');
  assert.deepEqual([nc.status, nc.json.code, nc.json.error], [409, 'ring_not_connected', 'Ring ist nicht verbunden.']);
  assert.deepEqual(await host.quickActions(ADMIN).then((l) => l.length), 2, 'the last known state stays listed');
}));

test('the mode poll: every minute, a change in the Ring app shows up; read-only → not offered; a failing read never touches the doorbell poll', () => withDoor({}, async (host, ctx) => {
  const { cloud, admin, clock } = ctx;
  await ringLogin(ctx);
  const R = cloud.ring;
  const gets = () => modeCalls(cloud, 'GET').length;
  const n0 = gets();
  R.modes.loc1.mode = 'away'; // switched in the Ring app
  clock.add(20 * SEC);
  await host.tick();
  assert.equal(gets(), n0, 'not before a minute');
  clock.add(41 * SEC);
  await host.tick();
  assert.equal(gets(), n0 + 1);
  assert.equal((await admin('GET', 'status')).json.ringModes[0].mode, 'away');
  assert.equal((await host.quickActions(ADMIN))[0].widget.value, 'Abwesend');
  // the read fails: kept per location, own back-off, the Ring status stays fine
  R.modeStatus = 500;
  clock.add(61 * SEC);
  await host.tick();
  let st = (await admin('GET', 'status')).json;
  assert.deepEqual([st.ringModes[0].error, st.ringModes[0].mode, st.ringModes[0].supported], ['ring_mode_failed', 'away', true]);
  assert.equal(st.ring.state, 'ok');
  clock.add(61 * SEC);
  await host.tick(); // second failure → 2 min back-off
  const n1 = gets();
  clock.add(61 * SEC);
  await host.tick();
  assert.equal(gets(), n1, 'backs off: 1 min after the first failure, 2 min after the second …');
  R.modeStatus = null;
  clock.add(5 * MIN);
  await host.tick();
  st = (await admin('GET', 'status')).json;
  assert.equal(st.ringModes[0].error, null);
  // read-only for this account → the buttons disappear, the admin page says why
  R.modes.loc1.readOnly = true;
  clock.add(16 * MIN);
  await host.tick();
  st = (await admin('GET', 'status')).json;
  assert.deepEqual([st.ringModes[0].supported, st.ringModes[0].why], [false, 'read_only']);
  assert.deepEqual(await host.quickActions(ADMIN), []);
  assert.equal((await admin('POST', 'modes/loc1/home')).json.code, 'mode_read_only');
  // Ring polling switched off → no mode reads either
  R.modes.loc1.readOnly = false;
  await admin('PUT', 'settings', { ring: false });
  const n2 = gets();
  clock.add(30 * MIN);
  await host.tick();
  assert.equal(gets(), n2);
}));

test('at most 10 switches per minute per person and location (rate_limited with retryAfter); a location never read is asked first', () => withDoor({}, async (host, ctx) => {
  const { cloud, admin, clock } = ctx;
  cloud.ring.modeStatus = 503; // the first read after the login fails
  await ringLogin(ctx);
  let st = (await admin('GET', 'status')).json.ringModes[0];
  assert.deepEqual([st.mode, st.why, st.error], [null, 'error', 'ring_mode_failed']);
  assert.deepEqual(await host.quickActions(ADMIN), [], 'unknown mode → not offered yet');
  cloud.ring.modeStatus = null;
  // the admin page may still try: the mode is read first, then set
  const r = await admin('POST', 'modes/loc1/away');
  assert.deepEqual([r.status, r.json.message, r.json.ringMode.mode], [200, 'Ring: Abwesend', 'away']);
  for (let i = 0; i < 9; i++) assert.equal((await host.runQuickAction(ADMIN, 'mode:loc1', 'de', { state: 'off' })).body.ok, true);
  const x = await admin('POST', 'modes/loc1/away');
  assert.deepEqual([x.status, x.json.code], [429, 'rate_limited']);
  assert.ok(x.json.retryAfter > 0);
  clock.add(61 * SEC);
  assert.equal((await admin('POST', 'modes/loc1/away')).status, 200);
}));

test('pages: the admin page, the rights page and the portal tab render the Ring mode parts', () => withDoor({}, async (host, ctx) => {
  await ringLogin(ctx);
  const dev = (await host.render({ view: 'page', page: 'devices', lang: 'de' })).html;
  assert.ok(dev.includes('id="dr-modes"') && dev.includes('Ring-Modus'));
  assert.ok(dev.includes('"modeIcons"'));
  const pr = (await host.render({ view: 'portal', lang: 'de', user: portal(ADMIN) })).html;
  assert.ok(pr.includes('id="dr-modes-card"'));
  const set = (await host.render({ view: 'page', page: 'settings', lang: 'en' })).html;
  assert.ok(set.includes('Ring mode in rules'));
}));
