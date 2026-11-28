'use strict';

// 1.11.0 — the apps' quick action of a Nuki smart lock is ONE switch (`<id>:toggle`): zugesperrt (on) ⇄ aufgesperrt
// (off), the title the state, the battery as the badge inside it, asks before aufsperren. Moving, unclear, blocked or
// not reachable: no side; a tap then locks. Rules (automation) and other plugins' buttons keep `:lock` / `:unlock`;
// a push button „Zusperren“ runs the switch and only locks.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ICONS } = require('../server/index');
const { withDoor, app, ANNA, MARC, SEC } = require('./helpers');

const FAMILIE = { automation: true, via: 'gatecontrol-familie' };
const sw = async (host, lockId, u = ANNA, lang = 'de') => (await host.quickActions(u, lang)).find((a) => a.id === `${lockId}:toggle`);
const poll = async (host, clock) => { clock.add(30 * SEC); await host.tick(); };

test('switch: the state as title / side, the door sensor in the subtitle, moving and blocked without a side', () => withDoor({}, async (host, { bridge, clock, lockId }) => {
  const d = bridge.devices[1001];
  const seen = async () => { const a = await sw(host, lockId); return [a.title, a.subtitle, a.state, a.icon === ICONS.lock ? 'lock' : 'unlock']; };
  assert.deepEqual(await seen(), ['Zugesperrt', 'Haustür · Tür zu', 'on', 'lock']);
  d.state = 3; d.door = 3;
  await poll(host, clock);
  assert.deepEqual(await seen(), ['Aufgesperrt', 'Haustür · Tür offen', 'off', 'unlock']);
  d.state = 5; d.door = 2;
  await poll(host, clock);
  assert.deepEqual(await seen(), ['Geöffnet', 'Haustür · Tür zu', 'off', 'unlock'], 'unlatched counts as aufgesperrt');
  d.state = 4;
  await poll(host, clock);
  assert.deepEqual(await seen(), ['Sperrt zu …', 'Haustür · Tür zu', null, 'lock'], 'locking: no side yet');
  d.state = 2;
  await poll(host, clock);
  assert.deepEqual(await seen(), ['Sperrt auf …', 'Haustür · Tür zu', null, 'unlock']);
  d.state = 254;
  await poll(host, clock);
  assert.deepEqual(await seen(), ['Blockiert', 'Haustür · Tür zu', null, 'lock']);
  // the widget (battery, state) stays on the switch whatever the state
  const a = await sw(host, lockId);
  assert.deepEqual([a.widget.badge.value, a.widget.state, a.widget.value], [80, 'crit', 'Blockiert']);
  // English
  d.state = 1;
  await poll(host, clock);
  const en = await sw(host, lockId, ANNA, 'en');
  assert.deepEqual([en.title, en.subtitle, en.verbs], ['Locked', 'Haustür · Door closed', { on: 'Lock', off: 'Unlock' }]);
}));

test('switch: not reachable → no side, „Nicht erreichbar“; a tap then tries to lock (never aufsperren)', () => withDoor({}, async (host, { bridge, clock, lockId, call }) => {
  bridge.devices[1001].state = 1;
  bridge.down = true;
  for (let i = 0; i < 22; i++) await poll(host, clock);
  const a = await sw(host, lockId);
  assert.deepEqual([a.title, a.subtitle, a.state], ['Nicht erreichbar', 'Haustür', null]);
  const before = bridge.requests.length;
  const r = (await host.runQuickAction(ANNA, `${lockId}:toggle`)).body;
  assert.equal(r.ok, false);
  const tried = bridge.requests.slice(before).filter((x) => x.path === '/lockAction');
  assert.ok(tried.every((x) => x.query.action === '2'), 'only a lock is attempted');
  const h = (await call(app(ANNA), 'GET', '/history')).json.items[0];
  assert.deepEqual([h.action, h.via], ['lock', 'app']);
}));

test('switch: a tap while it moves or is unclear locks; a push button only locks, also when already zugesperrt', () => withDoor({}, async (host, { bridge, clock, lockId }) => {
  const d = bridge.devices[1001];
  d.state = 2; // unlocking
  await poll(host, clock);
  let r = (await host.runQuickAction(ANNA, `${lockId}:toggle`)).body;
  assert.deepEqual([r.ok, r.state, d.lastAction], [true, 'on', 2]);
  // zugesperrt + a push button „Zusperren“ (via notification) → zusperren again, not the other way round
  await poll(host, clock);
  assert.equal((await sw(host, lockId)).state, 'on');
  r = (await host.runQuickAction(MARC, `${lockId}:toggle`, 'de', { via: 'notification' })).body;
  assert.deepEqual([r.ok, r.state, d.state, d.lastAction], [true, 'on', 1, 2]);
  // a target 'off' unlocks exactly
  r = (await host.runQuickAction(MARC, `${lockId}:toggle`, 'de', { state: 'off' })).body;
  assert.deepEqual([r.ok, r.state, d.state], [true, 'off', 3]);
}));

test('several locks: the switch names the lock („Haustür: Zugesperrt“)', () => withDoor({
  devices: { 1001: { deviceType: 4, name: 'Haustür', state: 1, door: 2 }, 3003: { deviceType: 4, name: 'Keller', state: 3, door: 2 } },
}, async (host, { admin, lockId }) => {
  const bridgeId = (await admin('GET', 'status')).json.bridges[0].id;
  const k = await admin('POST', 'locks', { name: 'Keller', source: 'bridge', bridgeId, nukiId: '3003', deviceType: 4, actions: ['lock', 'unlock'], doorSensor: false });
  assert.equal(k.status, 200, JSON.stringify(k.json));
  const kid = k.json.lock.id;
  assert.equal((await admin('PUT', `rights/${ANNA.id}`, { locks: { [lockId]: 'open', [kid]: 'lock' } })).status, 200);
  await host.tick();
  const list = await host.quickActions(ANNA);
  const titles = list.filter((a) => a.kind === 'toggle').map((a) => [a.id, a.title, a.subtitle]);
  assert.deepEqual(titles, [[`${lockId}:toggle`, 'Haustür: Zugesperrt', 'Haustür · Tür zu'], [`${kid}:toggle`, 'Keller: Aufgesperrt', 'Keller']]);
  // Marc only has the front door: a single switch, without the name
  assert.deepEqual((await host.quickActions(MARC)).map((a) => a.title), ['Zugesperrt']);
}));

test('a lock the administrator allows only zusperren: the button as before, no switch', () => withDoor({ lock: { actions: ['lock', 'open'] } }, async (host, { lockId }) => {
  const list = await host.quickActions(ANNA);
  assert.deepEqual(list.map((a) => [a.id, a.kind]).slice(0, 2), [[`${lockId}:lock`, 'button'], [`${lockId}:open`, 'button']]);
  assert.equal((await host.runQuickAction(ANNA, `${lockId}:toggle`)).status, 404);
}));

test('rules and other plugins keep zusperren / aufsperren — the switch is the apps\' own', () => withDoor({}, async (host, { lockId }) => {
  const auto = await host.plugin.quickActions({ user: { ...ANNA, portal: true, loggedIn: true, automation: true, via: 'gatecontrol-familie' }, lang: 'de' }, host.gc);
  assert.deepEqual(auto.map((a) => [a.id, a.title]), [[`${lockId}:lock`, 'Haustür zusperren'], [`${lockId}:unlock`, 'Haustür aufsperren']]);
  const chat = await host.plugin.quickActions({ user: { ...ANNA, portal: true, loggedIn: true, automation: false, interactive: true, via: 'gatecontrol-messenger' }, lang: 'de' }, host.gc);
  assert.deepEqual(chat.filter((a) => a.device.id === `lock:${lockId}`).map((a) => a.id), [`${lockId}:lock`, `${lockId}:unlock`, `${lockId}:open`]);
  // a rule's stored `:lock` still locks (the toggle is not listed for it)
  assert.equal((await host.runQuickAction(ANNA, `${lockId}:lock`, 'de', FAMILIE)).body.ok, true);
  assert.equal((await host.runQuickAction(ANNA, `${lockId}:toggle`, 'de', FAMILIE)).status, 404);
  // forged straight at the hook: refused as well
  const forged = await host.plugin.runQuickAction({ user: { ...ANNA, portal: true, loggedIn: true, automation: true, via: 'gatecontrol-familie' }, lang: 'de', id: `${lockId}:toggle`, via: 'gatecontrol-familie', automation: true }, host.gc);
  assert.equal(forged.ok, false);
}));
