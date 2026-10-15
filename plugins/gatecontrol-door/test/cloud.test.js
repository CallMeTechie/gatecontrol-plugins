'use strict';

// 1.0.2 — owner's report after 1.0.1: a Nuki Web lock ("Haustür", Smart Lock,
// battery 82 %) stays on "Öffnet …"; the cloud answers state 7 (unlatching)
// also to GET /smartlock/{id} while the Nuki app shows "aufgesperrt".
//   * a row written by 1.0.0 (state 'unlatching', moving_since NULL after
//     migration 002) reaches the 3-minute fallback through both paths (the
//     /smartlock overview and the /smartlock/{id} re-read); no stable state
//     ever seen → 'unknown' + stale ("Zustand unklar"), never "Öffnet …"
//   * Nuki Web's updateDate older than 60 s on a transitional state → unclear
//     at once (and read again at once)
//   * admin diagnostics: the raw Nuki fields, the cloud's age, the hint

const test = require('node:test');
const assert = require('node:assert/strict');
const nuki = require('../server/nuki');
const { withDoor, webEntry, app, ANNA, WEB_TOKEN, SEC, MIN, HOUR } = require('./helpers');

const ID = 17999;
const FAMILIE = { automation: true, via: 'gatecontrol-familie' };
const shown = async (call, lockId) => (await call(app(ANNA), 'GET', '/me')).json.locks.find((l) => l.id === lockId).state;
const adminLock = async (admin, lockId) => (await admin('GET', 'status')).json.locks.find((l) => l.id === lockId);
const diag = async (admin, lockId) => (await adminLock(admin, lockId)).diag;
const isoAt = (ms) => new Date(ms).toISOString();

async function step(host, clock, ms = 30 * SEC) {
  clock.add(ms);
  await host.tick();
}

/** A Nuki Web lock "Haustür" (Anna: open), without a first poll. → lock */
async function webLock(host, { admin, cloud }, entries) {
  cloud.web.locks = entries;
  assert.equal((await admin('PUT', 'web', { token: WEB_TOKEN })).status, 200);
  const l = (await admin('POST', 'locks', { name: 'Haustür', source: 'web', nukiId: String(ID), deviceType: 4, actions: ['lock', 'unlock', 'open'] })).json.lock;
  assert.equal((await admin('PUT', `rights/${ANNA.id}`, { locks: { [l.id]: 'open' }, autoUnlock: true })).status, 200);
  return l;
}

/** The row as 1.0.0 left it: transitional, and after migration 002 no moving_since / stable_state / overview code. */
async function row100(host, lockId, at) {
  await host.gc.db.run(`INSERT INTO lock_state (lock_id, state, nuki_state, battery_percent, reachable, updated_at, checked_at)
    VALUES (?, 'unlatching', 7, 82, 1, ?, ?)
    ON CONFLICT(lock_id) DO UPDATE SET state = 'unlatching', nuki_state = 7, moving_since = NULL, stable_state = NULL, nuki_via = NULL,
      list_nuki_state = NULL, list_moving_since = NULL, cloud_at = NULL, nuki_raw = NULL`, [lockId, at - HOUR, at - HOUR]);
}

const single = (cloud) => cloud.calls.filter((c) => c.url === `https://api.nuki.io/smartlock/${ID}` && c.method === 'GET').length;

test('1.0.0 row (unlatching, moving_since NULL), live cloud stays on 7: overview → re-read → after 3 min "Zustand unklar" (unknown, stale) everywhere', () => withDoor({ setup: false }, async (host, ctx) => {
  const { admin, call, cloud, clock } = ctx;
  const l = await webLock(host, ctx, [webEntry(ID, 7)]);
  await row100(host, l.id, clock.now());
  // before any poll of 1.0.2: the raw row is transitional, no "since" — not stale yet, shown as it is
  assert.deepEqual([(await shown(call, l.id)).lock, (await shown(call, l.id)).stale], ['unlatching', false]);
  const t0 = clock.now();
  await host.tick(); // overview /smartlock: moving_since is set now (first sight)
  let d = await diag(admin, l.id);
  assert.deepEqual([d.via, d.nukiState, d.movingSince, d.stableState, d.stale], ['smartlock', 7, isoAt(t0).replace(/\.\d{3}Z$/, 'Z'), null, false]);
  assert.equal(single(cloud), 0);
  await step(host, clock);
  // the admin's "Status abfragen" in between does not restart the clock
  assert.equal((await admin('POST', `locks/${l.id}/refresh`)).status, 200);
  await step(host, clock); // 60 s: GET /smartlock/{id} — also 7
  d = await diag(admin, l.id);
  assert.deepEqual([d.via, d.nukiState, d.movingSince, single(cloud)], ['smartlock_id', 7, isoAt(t0).replace(/\.\d{3}Z$/, 'Z'), 1]);
  while (clock.now() - t0 < 3 * MIN - 30 * SEC) await step(host, clock);
  assert.deepEqual([(await shown(call, l.id)).lock, (await shown(call, l.id)).stale], ['unlatching', false], 'a live cloud: 3 minutes');
  await step(host, clock);
  assert.ok(single(cloud) >= 2, 'read again meanwhile');
  d = await diag(admin, l.id);
  assert.deepEqual([d.via, d.movingSince, d.stale, d.staleWhy, d.stableState, d.cloudHint], ['smartlock_id', isoAt(t0).replace(/\.\d{3}Z$/, 'Z'), true, 'moving', null, true]);
  // app / API: no stable state ever seen → unknown + stale, never "unlatching"
  const s = await shown(call, l.id);
  assert.deepEqual([s.lock, s.stale, s.reachable, s.batteryPercent], ['unknown', true, true, 82]);
  // portal tile and quick action: only "Zustand unklar" (not "– zuletzt: Unbekannt")
  const tile = (await host.portalTiles(ANNA)).find((x) => x.title === 'Haustür');
  assert.deepEqual([tile.value, tile.state], ['Zustand unklar', 'warn']);
  assert.equal((await host.portalTiles(ANNA, 'en')).find((x) => x.title === 'Haustür').value, 'State unclear');
  assert.equal((await host.quickActions(ANNA)).find((x) => x.id === `${l.id}:lock`).subtitle, 'Zustand unklar');
  // keeps stale while the cloud stays stuck (moving_since is never reset)
  for (let i = 0; i < 6; i++) await step(host, clock);
  assert.deepEqual([(await shown(call, l.id)).lock, (await shown(call, l.id)).stale], ['unknown', true]);
  // an automatic unlock is refused
  const r = await host.runQuickAction(ANNA, `${l.id}:unlock`, 'de', FAMILIE);
  assert.equal(r.body.ok, false);
  assert.equal((await call(app(ANNA), 'GET', '/history')).json.items[0].reason, 'state_unclear');
  assert.equal(cloud.web.actions.length, 0);
  // the cloud catches up → the real state, flag gone
  cloud.web.locks = [webEntry(ID, 3)];
  await step(host, clock);
  d = await diag(admin, l.id);
  assert.deepEqual([(await shown(call, l.id)).lock, (await shown(call, l.id)).stale, d.cloudHint, d.movingSince], ['unlocked', false, false, null]);
}));

test('1.0.0 row, only the re-read path: the overview keeps 7, GET /smartlock/{id} answers 7 every time → stale after 3 min, unknown', () => withDoor({ setup: false }, async (host, ctx) => {
  const { admin, call, cloud, clock } = ctx;
  const l = await webLock(host, ctx, [webEntry(ID, 7)]);
  cloud.web.fresh[String(ID)] = webEntry(ID, 7, { lastAction: 3, trigger: 2 });
  await row100(host, l.id, clock.now());
  const t0 = clock.now();
  await host.tick();
  const seen = [];
  while (clock.now() - t0 < 3 * MIN) {
    await step(host, clock);
    const d = await diag(admin, l.id);
    seen.push(d.movingSince);
    if (clock.now() - t0 < 3 * MIN) assert.equal((await shown(call, l.id)).lock, 'unlatching');
  }
  assert.equal(new Set(seen).size, 1, 'moving_since is set once and kept through the re-reads');
  const d = await diag(admin, l.id);
  assert.deepEqual([d.via, d.stale, d.raw.lastAction, d.raw.trigger], ['smartlock_id', true, 3, 2]);
  assert.deepEqual([(await shown(call, l.id)).lock, (await shown(call, l.id)).stale], ['unknown', true]);
}));

test('Nuki Web: transitional with updateDate older than 60 s → unclear at once and read again at once; hint and raw fields on "Geräte"', () => withDoor({ setup: false }, async (host, ctx) => {
  const { admin, call, cloud, clock } = ctx;
  const stuckSince = isoAt(clock.now() - 3 * HOUR);
  const l = await webLock(host, ctx, [webEntry(ID, 7, { updateDate: stuckSince, lastAction: 3, trigger: 0, doorState: 2 })]);
  await row100(host, l.id, clock.now());
  await host.tick();
  assert.equal(single(cloud), 1, 'read again at once, no 60 s wait');
  const s = await shown(call, l.id);
  assert.deepEqual([s.lock, s.stale], ['unknown', true], 'no 3-minute wait');
  const a = await adminLock(admin, l.id);
  assert.deepEqual([a.state.lock, a.state.stale], ['unknown', true]);
  const d = a.diag;
  assert.deepEqual([d.source, d.via, d.nukiState, d.stale, d.staleWhy, d.cloudHint], ['web', 'smartlock_id', 7, true, 'cloud', true]);
  assert.deepEqual(d.raw, { mode: 2, state: 7, lastAction: 3, trigger: 0, doorState: 2, serverState: 0, updateDate: stuckSince });
  assert.equal(d.cloudAt, stuckSince.replace(/\.\d{3}Z$/, 'Z'));
  assert.equal(d.cloudAgeSec, 3 * 3600);
  assert.equal((await host.portalTiles(ANNA)).find((x) => x.title === 'Haustür').value, 'Zustand unklar');
  // automatic unlock: refused at once
  const r = await host.runQuickAction(ANNA, `${l.id}:unlock`, 'de', FAMILIE);
  assert.equal(r.body.ok, false);
  assert.equal((await call(app(ANNA), 'GET', '/history')).json.items[0].reason, 'state_unclear');
  // the re-read stays rate-limited (≤ 1 per 2 min)
  await step(host, clock);
  assert.equal(single(cloud), 1);
  // the page "Geräte" carries the hint and the diagnostics texts
  const html = await host.render({ view: 'page', page: 'devices', user: { id: 1, name: 'admin', role: 'admin' }, lang: 'de' });
  const page = typeof html === 'string' ? html : JSON.stringify(html);
  assert.ok(page.includes('Nuki Web liefert einen veralteten Zustand. Für zuverlässige Anzeige die Nuki Bridge verwenden oder in der Nuki-App prüfen, ob das Schloss mit dem Internet verbunden ist.'));
  assert.ok(page.includes('dr-cloud-hint') && page.includes('Cloud-Stand: {{age}}') && page.includes('vor {{n}} Std.'));
  assert.ok(!JSON.stringify(await admin('GET', 'status')).includes(WEB_TOKEN), 'never the token');
}));

test('Nuki Web: old cloud data with a stable state seen before → "Zustand unklar – zuletzt: Aufgesperrt" at once', () => withDoor({ setup: false }, async (host, ctx) => {
  const { admin, call, cloud, clock } = ctx;
  const l = await webLock(host, ctx, [webEntry(ID, 3)]);
  await host.tick();
  assert.deepEqual([(await shown(call, l.id)).lock, (await diag(admin, l.id)).cloudHint], ['unlocked', false]);
  cloud.web.locks = [webEntry(ID, 7, { updateDate: isoAt(clock.now() - 2 * MIN) })];
  await step(host, clock);
  assert.deepEqual([(await shown(call, l.id)).lock, (await shown(call, l.id)).stale], ['unlocked', true]);
  assert.equal((await host.portalTiles(ANNA)).find((x) => x.title === 'Haustür').value, 'Zustand unklar – zuletzt: Aufgesperrt');
  const d = await diag(admin, l.id);
  assert.deepEqual([d.stableState, d.staleWhy, d.cloudHint], ['unlocked', 'cloud', true]);
}));

test('Nuki Web: a live transitional state (fresh updateDate) is shown; unclear only once the cloud data is older than 60 s', () => withDoor({ setup: false }, async (host, ctx) => {
  const { admin, call, cloud, clock } = ctx;
  const l = await webLock(host, ctx, [webEntry(ID, 1)]);
  await host.tick();
  // the lock starts moving now; the cloud copy is from 10 s ago and then does not change any more
  const at = clock.now() + 20 * SEC;
  cloud.web.locks = [webEntry(ID, 2, { updateDate: isoAt(at) })];
  await step(host, clock, 30 * SEC); // cloud data 10 s old
  assert.deepEqual([(await shown(call, l.id)).lock, (await shown(call, l.id)).stale, single(cloud)], ['unlocking', false, 0]);
  assert.equal((await diag(admin, l.id)).cloudHint, false);
  clock.add(40 * SEC); // 50 s
  assert.deepEqual([(await shown(call, l.id)).lock, (await shown(call, l.id)).stale], ['unlocking', false]);
  clock.add(15 * SEC); // 65 s — without a poll: the display already treats it as unclear
  assert.deepEqual([(await shown(call, l.id)).lock, (await shown(call, l.id)).stale], ['locked', true]);
  await host.tick();
  assert.equal(single(cloud), 1, 'and the next poll reads it again');
  // a live cloud (updateDate = now on every answer) keeps the normal 3-minute rule
  cloud.web.locks = [webEntry(ID, 4)];
  for (let i = 0; i < 4; i++) await step(host, clock);
  assert.deepEqual([(await shown(call, l.id)).lock, (await shown(call, l.id)).stale], ['locking', false]);
}));

test('Nuki Web without updateDate: no cloud age (the 3-minute rule only); unreachable keeps the raw serverState', () => withDoor({ setup: false }, async (host, ctx) => {
  const { admin, call, cloud, clock } = ctx;
  const l = await webLock(host, ctx, [webEntry(ID, 7, { updateDate: null })]);
  await host.tick();
  let d = await diag(admin, l.id);
  assert.deepEqual([d.cloudAt, d.cloudAgeSec, d.stale, d.raw.updateDate], [null, null, false, undefined]);
  assert.equal((await shown(call, l.id)).lock, 'unlatching');
  cloud.web.locks = [webEntry(ID, 3, { serverState: 4 })];
  await step(host, clock);
  d = await diag(admin, l.id);
  assert.equal((await shown(call, l.id)).reachable, false);
  assert.equal(d.raw.serverState, 4);
}));

test('Bridge: the raw lastKnownState fields (state, stateName, doorsensorState, timestamp) in the diagnostics; no cloud age, no hint', () => withDoor({}, async (host, { admin, bridge, clock, lockId }) => {
  let d = await diag(admin, lockId);
  assert.deepEqual([d.source, d.raw.state, d.raw.stateName, d.raw.doorsensorState, d.raw.mode, d.cloudAt, d.cloudHint], ['bridge', 1, 'x', 2, 2, null, false]);
  assert.equal(d.raw.timestamp, new Date(clock.now()).toISOString());
  // stuck cache → /lockState: its raw fields are saved
  bridge.devices[1001].state = 3;
  bridge.devices[1001].listState = 7;
  await step(host, clock);
  await step(host, clock);
  d = await diag(admin, lockId);
  assert.deepEqual([d.via, d.raw.state, d.listNukiState], ['lockState', 3, 7]);
}));

test('raw fields: only the listed keys, numbers / booleans / short strings; updateDate parsed', () => {
  const w = nuki.fromWebLock({ smartlockId: 1, type: 4, name: 'X', serverState: 0, updateDate: '2026-10-14T05:00:00.000Z', state: { state: 7, mode: 2, trigger: 0, lastAction: 3, doorState: 0, secret: 'nope', batteryCharge: 82 } });
  assert.deepEqual(w.state.raw, { mode: 2, state: 7, lastAction: 3, trigger: 0, doorState: 0, serverState: 0, updateDate: '2026-10-14T05:00:00.000Z' });
  assert.equal(w.state.cloudAt, Date.UTC(2026, 9, 14, 5, 0, 0));
  assert.equal(nuki.fromWebLock({ smartlockId: 1, type: 4, updateDate: 'gestern', state: { state: 1 } }).state.cloudAt, null);
  assert.equal(nuki.fromWebLock({ smartlockId: 1, type: 4, state: { state: 1 } }).state.cloudAt, null);
  assert.deepEqual(nuki.rawFields({ state: 1, stateName: 'x'.repeat(41), mode: { a: 1 }, timestamp: 't' }, ['state', 'stateName', 'mode', 'timestamp']), { state: 1, timestamp: 't' });
  assert.equal(nuki.rawFields({}, ['state']), null);
  const b = nuki.fromBridgeState(4, { mode: 2, state: 7, stateName: 'unlatching', doorsensorState: 2, timestamp: '2026-10-14T08:00:00+00:00', token: 'abc' });
  assert.deepEqual(b.raw, { mode: 2, state: 7, stateName: 'unlatching', doorsensorState: 2, timestamp: '2026-10-14T08:00:00+00:00' });
});

test('texts: the new keys exist in DE and EN', () => {
  const texts = require('../server/texts.json');
  for (const k of ['dev.web_stale_hint', 'dev.diag_raw_web', 'dev.diag_raw_bridge', 'dev.diag_cloud', 'dev.diag_cloud_none', 'dev.diag_stale_none', 'rel.ago_s', 'rel.ago_min', 'rel.ago_h', 'rel.ago_d']) {
    assert.ok(texts.de[k] && texts.en[k], k);
  }
  assert.deepEqual(Object.keys(texts.de).sort(), Object.keys(texts.en).sort());
});
