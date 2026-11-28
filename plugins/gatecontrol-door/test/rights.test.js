'use strict';

// Rights matrix (none / view / lock / open × lock / unlock / open × app / portal /
// device trust / kiosk / admin without rights), time windows (days, over
// midnight, time zone), the rate limit (10 per minute), quick actions per
// right (ids, confirm, icons, state) and their runs (app, notification).

const test = require('node:test');
const assert = require('node:assert/strict');
const rights = require('../server/rights');
const { withDoor, app, portal, kiosk, ADMIN, ANNA, MARC, LENA, GAST, MIN, SEC } = require('./helpers');

test('rights matrix: who may do what, checked on the server for every action', () => withDoor({}, async (host, { call, lockId, bridge }) => {
  const expect = {
    [ANNA.id]: { lock: 200, unlock: 200, open: 200 },
    [MARC.id]: { lock: 200, unlock: 200, open: 403 },
    [LENA.id]: { lock: 403, unlock: 403, open: 403 },
    [GAST.id]: { lock: 404, unlock: 404, open: 404 },
    [ADMIN.id]: { lock: 404, unlock: 404, open: 404 },
  };
  for (const u of [ANNA, MARC, LENA, GAST, ADMIN]) {
    for (const a of ['unlock', 'lock', 'open']) {
      const r = await call(app(u), 'POST', `/locks/${lockId}/${a}`);
      assert.equal(r.status, expect[u.id][a], `${u.name} ${a}: ${JSON.stringify(r.json)}`);
      if (r.status === 403) assert.equal(r.json.code, 'no_right');
    }
  }
  assert.equal(bridge.requests.filter((r) => r.path === '/lockAction').length, 5);
  // admins get nothing automatically: no lock in GET me, no portal/app tab
  assert.deepEqual((await call(app(ADMIN), 'GET', '/me')).json.locks, []);
  assert.equal(await host.portalVisible(ADMIN), false);
  assert.equal(await host.appVisible(ADMIN), false);
  assert.equal(await host.appVisible(LENA), true);
  assert.equal(await host.portalVisible(GAST), false);
}));

test('kiosk devices and device-trust portal viewers only look; a signed-in portal viewer may act', () => withDoor({}, async (host, { call, lockId }) => {
  for (const v of [kiosk(ANNA), portal(ANNA, false)]) {
    const me = (await call(v, 'GET', '/me')).json;
    assert.equal(me.me.canAct, false);
    assert.equal(me.locks[0].blocked, 'read_only');
    const r = await call(v, 'POST', `/locks/${lockId}/unlock`);
    assert.deepEqual([r.status, r.json.code], [403, 'read_only']);
  }
  assert.equal((await call(portal(ANNA), 'POST', `/locks/${lockId}/unlock`)).status, 200);
  const h = (await call(app(ANNA), 'GET', '/history')).json.items;
  assert.deepEqual(h.slice(0, 3).map((x) => [x.via, x.result, x.reason]), [['portal', 'ok', null], ['portal', 'refused', 'read_only'], ['portal', 'refused', 'read_only']]);
  assert.deepEqual(await host.quickActions(kiosk(ANNA)), []);
}));

test('time windows: weekdays, from inclusive / to exclusive, over midnight, in the configured zone', () => {
  const win = rights.parseWindow({ days: [1, 2, 3, 4, 5], from: '07:00', to: '20:00' });
  const at = (d, hh, mm) => Date.UTC(2026, 9, d, hh - 2, mm); // CEST: local hh:mm on 2026-10-d
  assert.equal(rights.windowAllows(win, at(14, 7, 0), 'Europe/Berlin'), true, 'Wed 07:00');
  assert.equal(rights.windowAllows(win, at(14, 6, 59), 'Europe/Berlin'), false);
  assert.equal(rights.windowAllows(win, at(14, 20, 0), 'Europe/Berlin'), false, 'to is exclusive');
  assert.equal(rights.windowAllows(win, at(17, 12, 0), 'Europe/Berlin'), false, 'Saturday');
  assert.equal(rights.windowAllows(win, at(14, 7, 0), 'UTC'), false, '05:00 UTC');
  const night = rights.parseWindow({ days: [5], from: '22:00', to: '06:00' });
  assert.equal(rights.windowAllows(night, at(16, 23, 0), 'Europe/Berlin'), true, 'Fri 23:00');
  assert.equal(rights.windowAllows(night, at(17, 5, 0), 'Europe/Berlin'), true, 'Sat 05:00 belongs to Friday');
  assert.equal(rights.windowAllows(night, at(16, 5, 0), 'Europe/Berlin'), false, 'Fri 05:00 belongs to Thursday');
  assert.equal(rights.windowAllows(null, at(16, 5, 0), 'Europe/Berlin'), true);
  for (const bad of [{ days: [], from: '07:00', to: '08:00' }, { days: [8], from: '07:00', to: '08:00' }, { days: [1], from: '7:00', to: '08:00' }, { days: [1], from: '08:00', to: '08:00' }, [1]]) {
    assert.throws(() => rights.parseWindow(bad), { code: 'invalid' }, JSON.stringify(bad));
  }
});

test('a time window blocks actions outside it (also quick actions), shown as blocked', () => withDoor({}, async (host, { call, admin, lockId, clock }) => {
  // Wednesday 10:00 local: window Mo–Fr 11:00–20:00 → outside
  assert.equal((await admin('PUT', `rights/${MARC.id}`, { window: { days: [1, 2, 3, 4, 5], from: '11:00', to: '20:00' } })).status, 200);
  assert.equal((await admin('PUT', `rights/${MARC.id}`, { window: { days: [9], from: '11:00', to: '20:00' } })).json.code, 'invalid');
  const me = (await call(app(MARC), 'GET', '/me')).json;
  assert.deepEqual([me.me.windowOpen, me.locks[0].blocked], [false, 'outside_window']);
  const r = await call(app(MARC), 'POST', `/locks/${lockId}/unlock`);
  assert.deepEqual([r.status, r.json.code], [403, 'outside_window']);
  // the apps' lock switch (1.11.0), aufsperren
  const q = await host.runQuickAction(MARC, `${lockId}:toggle`, 'de', { state: 'off' });
  assert.deepEqual([q.status, q.body.ok], [200, false]);
  assert.match(q.body.message, /Zeitfenster/);
  clock.add(61 * MIN);
  assert.equal((await call(app(MARC), 'POST', `/locks/${lockId}/unlock`)).status, 200);
  await admin('PUT', `rights/${MARC.id}`, { window: null });
  assert.equal((await call(app(MARC), 'GET', '/me')).json.me.window, null);
}));

test('at most 10 actions per minute per person (429 rate_limited with retryAfter)', () => withDoor({}, async (host, { call, lockId, clock }) => {
  for (let i = 0; i < 10; i++) assert.equal((await call(app(ANNA), 'POST', `/locks/${lockId}/${i % 2 ? 'lock' : 'unlock'}`)).status, 200, `run ${i}`);
  const r = await call(app(ANNA), 'POST', `/locks/${lockId}/lock`);
  assert.deepEqual([r.status, r.json.code], [429, 'rate_limited']);
  assert.ok(r.json.retryAfter > 0 && r.json.retryAfter <= 60);
  assert.equal((await call(app(MARC), 'POST', `/locks/${lockId}/lock`)).status, 200, 'per person');
  clock.add(61 * SEC);
  assert.equal((await call(app(ANNA), 'POST', `/locks/${lockId}/lock`)).status, 200);
}));

test('quick actions per right: the switch zugesperrt ⇄ aufgesperrt (1.11.0) and öffnen (opener: Summer), confirm before aufsperren/open, icons, state', () => withDoor({}, async (host, { lockId, openerId, bridge }) => {
  const LOCK = 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z';
  const UNLOCK = 'M7 11V7a5 5 0 0 1 9.9-1M5 11h14v10H5z';
  const anna = await host.quickActions(ANNA);
  assert.deepEqual(anna.map((a) => [a.id, a.title, a.kind, a.confirm]), [
    [`${lockId}:toggle`, 'Zugesperrt', 'toggle', true], [`${lockId}:open`, 'Haustür öffnen', 'button', true],
    [`${openerId}:open`, 'Hoftor Summer', 'button', true],
  ]);
  // the switch: on = zugesperrt (green lock), off = aufgesperrt (open lock), asks only before aufsperren, targets for rules
  assert.deepEqual(anna[0], {
    id: `${lockId}:toggle`, title: 'Zugesperrt', subtitle: 'Haustür · Tür zu', icon: LOCK, kind: 'toggle', state: 'on', confirm: true, confirmWhen: 'off',
    look: { on: { icon: LOCK, tone: 'good' }, off: { icon: UNLOCK, tone: 'warn' } }, verbs: { on: 'Zusperren', off: 'Aufsperren' }, targets: true,
    device: { id: `lock:${lockId}`, title: 'Haustür', subtitle: null, icon: LOCK }, widget: anna[0].widget,
  });
  // one device per lock (GateControl ≥ 1.172.0): all of its actions under it
  const openerDevice = { id: `lock:${openerId}`, title: 'Hoftor', subtitle: null, icon: 'M5 21V4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v17M3 21h18M15 12h.01' };
  assert.deepEqual(anna.map((a) => a.device.id), [`lock:${lockId}`, `lock:${lockId}`, `lock:${openerId}`]);
  assert.deepEqual(anna[2].device, openerDevice);
  assert.ok(anna.slice(1).every((a) => a.look === null && a.confirmWhen === null && a.verbs === null && a.targets === false && a.state === null), 'buttons as before');
  // the battery on the switch, inside the one button (1.8.0: on the lock's first action)
  assert.deepEqual(anna.map((a) => a.widget && a.widget.badge && a.widget.badge.value), [80, null, 80]);
  assert.equal(anna[1].subtitle, 'Zugesperrt');
  // Marc (right „lock“): only the switch; Lena (view): nothing
  assert.deepEqual((await host.quickActions(MARC)).map((a) => a.id), [`${lockId}:toggle`]);
  assert.deepEqual(await host.quickActions(LENA), []);
  assert.deepEqual((await host.quickActions(ANNA, 'en')).map((a) => a.title), ['Locked', 'Open Haustür', 'Hoftor buzzer']);
  assert.deepEqual((await host.quickActions(ANNA, 'en'))[0].verbs, { on: 'Lock', off: 'Unlock' });
  // the apps no longer offer the two buttons: a pin of them that is run is gone (404) — the apps move it to the switch
  for (const id of [`${lockId}:lock`, `${lockId}:unlock`]) assert.equal((await host.runQuickAction(ANNA, id)).status, 404, id);
  // a tap switches over: zugesperrt → aufsperren (state off, the widget after it)
  let r = (await host.runQuickAction(ANNA, `${lockId}:toggle`)).body;
  assert.deepEqual([r.ok, r.message, r.state, r.widget.badge.value], [true, 'Haustür aufgesperrt', 'off', 80]);
  assert.equal(bridge.devices[1001].state, 3);
  let sw = (await host.quickActions(ANNA))[0];
  assert.deepEqual([sw.title, sw.state, sw.icon], ['Aufgesperrt', 'off', UNLOCK]);
  // … and back: aufgesperrt → zusperren
  r = (await host.runQuickAction(ANNA, `${lockId}:toggle`)).body;
  assert.deepEqual([r.ok, r.message, r.state], [true, 'Haustür zugesperrt', 'on']);
  assert.equal(bridge.devices[1001].state, 1);
  // a target state does exactly that, whatever is shown (zugesperrt + „on“ → zusperren again, never aufsperren)
  r = (await host.runQuickAction(ANNA, `${lockId}:toggle`, 'de', { state: 'on' })).body;
  assert.deepEqual([r.ok, r.state, bridge.devices[1001].state], [true, 'on', 1]);
  // a run from a notification and the opener: both checked and in the history with their source
  assert.deepEqual((await host.runQuickAction(ANNA, `${openerId}:open`, 'de', { via: 'notification' })).body, { ok: true, unchanged: false, message: 'Hoftor: Summer betätigt', state: null, widget: null });
  assert.equal((await host.runQuickAction(MARC, `${lockId}:open`)).status, 404, 'not listed for Marc');
  const h = await host.request({ method: 'GET', path: '/history', user: app(ANNA) });
  assert.deepEqual(h.json.items.slice(0, 4).map((x) => [x.action, x.via, x.userName]), [['open', 'notification', 'Anna'], ['lock', 'app', 'Anna'], ['lock', 'app', 'Anna'], ['unlock', 'app', 'Anna']]);
  assert.deepEqual(bridge.devices[2002].lastAction, 3);
}));
