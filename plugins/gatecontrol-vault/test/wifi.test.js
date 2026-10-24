'use strict';

// Wi-Fi shares (1.4.0, server/wifi.js): a copy of a Wi-Fi entry on the portal's start page (Start tiles) or the wall
// tablet (the Familie plugin's service wall_wifi, here a stub) — who may share, see and end, the time enforced here,
// the entry's trash / purge / move / vault deletion ending it, limits, the log, the QR code's text.

const test = require('node:test');
const assert = require('node:assert/strict');
const wifi = require('../server/wifi');
const { withHost, kiosk, fake, ANNA, MARC, LENA, OMA, WALL, MIN, HOUR, DAY } = require('./helpers');

const GAST = { ssid: 'Gäste;WLAN', security: 'WPA', password: 'Korrekt:Pferd"Batterie\\', hidden: false };

/** A stub of the Familie plugin: records the sets it gets; walls / wall / fail decide its answer. */
function familie(o = {}) {
  const st = { sets: [], walls: o.walls == null ? 1 : o.walls, wall: o.wall !== false, fail: false };
  st.entry = {
    plugin: 'gatecontrol-familie', provides: ['wall_wifi'],
    service: async ({ name, caller, payload }) => {
      assert.equal(name, 'wall_wifi');
      assert.equal(caller, 'gatecontrol-vault');
      if (st.fail) throw new Error('down');
      st.sets.push(payload.shares);
      return { ok: true, walls: st.walls, wall: st.wall };
    },
  };
  st.last = () => st.sets[st.sets.length - 1];
  return st;
}

/** Anna with a shared vault "fam": Marc writes, Lena reads; Oma has Vault but is not in it. One Wi-Fi entry in it. */
async function setup(c) {
  await c.setup(ANNA); await c.setup(MARC); await c.setup(LENA); await c.setup(OMA);
  const fam = fake.id();
  await c.as(ANNA)('POST', 'vaults', { id: fam, nameEnc: fake.name(), sealedKey: fake.sealed() });
  await c.as(ANNA)('POST', `vaults/${fam}/members`, { userId: MARC.id, role: 'write', sealedKey: fake.sealed() });
  await c.as(ANNA)('POST', `vaults/${fam}/members`, { userId: LENA.id, role: 'read', sealedKey: fake.sealed() });
  const it = await c.item(ANNA, fam, 1);
  return { fam, item: it.id };
}

const all = async (host, sql) => (await host.gc.db.query(sql, [])).rows;
const one = async (host, sql) => (await host.gc.db.get(sql, [])).row;
const body = (itemId, target, duration, o = {}) => ({ itemId, target, duration, ...GAST, ...o });

test('the QR code text: WIFI:T:…;S:…;P:…;H:true;; with \\ ; , : " escaped; nopass without P', () => {
  assert.equal(wifi.qrText(GAST), 'WIFI:T:WPA;S:Gäste\\;WLAN;P:Korrekt\\:Pferd\\"Batterie\\\\;;');
  assert.equal(wifi.qrText({ ssid: 'a,b', security: 'nopass', password: '', hidden: true }), 'WIFI:T:nopass;S:a\\,b;H:true;;');
  assert.equal(wifi.qrText({ ssid: 'W', security: 'WEP', password: '0123456789', hidden: false }), 'WIFI:T:WEP;S:W;P:0123456789;;');
  assert.equal(wifi.qrText({ ssid: 'W3', security: 'SAE', password: 'x', hidden: false }), 'WIFI:T:SAE;S:W3;P:x;;');
});

test('the copy is checked: only network name, security, password, hidden — in sane sizes', () => {
  assert.deepEqual(wifi.parseCopy(GAST), GAST);
  assert.deepEqual(wifi.parseCopy({ ssid: 'Offen', security: 'nopass' }), { ssid: 'Offen', security: 'nopass', password: '', hidden: false });
  for (const bad of [
    {}, { ...GAST, ssid: '' }, { ...GAST, ssid: '   ' }, { ...GAST, ssid: 'x'.repeat(65) }, { ...GAST, ssid: 'a\nb' },
    { ...GAST, security: 'WPA2' }, { ...GAST, password: '' }, { ...GAST, security: 'nopass' }, { ...GAST, password: 'p'.repeat(129) },
    { ...GAST, password: 7 }, { ...GAST, hidden: 'yes' },
  ]) assert.throws(() => wifi.parseCopy(bad), (e) => e.code === 'invalid', JSON.stringify(bad));
});

test('portal: a writer shares; the members see it, a reader cannot share or end, others see nothing; the Start tile for signed-in people only', async () => {
  await withHost({}, async (host, c) => {
    const { fam, item } = await setup(c);
    assert.equal((await c.as(LENA)('POST', 'wifi-shares', body(item, 'portal', '1h'))).json.code, 'forbidden', 'read role');
    assert.equal((await c.as(OMA)('POST', 'wifi-shares', body(item, 'portal', '1h'))).json.code, 'not_found', 'not in the vault');
    assert.equal((await c.as(MARC)('POST', 'wifi-shares', body(item, 'portal', '2h'))).json.code, 'invalid');
    assert.equal((await c.as(MARC)('POST', 'wifi-shares', body(item, 'kitchen', '1h'))).json.code, 'invalid');
    assert.equal((await c.as(MARC)('POST', 'wifi-shares', body(item, 'portal', 'keep'))).json.code, 'not_found', 'keep needs a running share');
    const r = await c.as(MARC)('POST', 'wifi-shares', body(item, 'portal', '1h'));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const s = r.json.share;
    assert.match(s.id, /^[0-9a-f]{24}$/);
    assert.deepEqual([s.itemId, s.vaultId, s.target, s.ssid, s.security, s.password, s.hidden, s.canEnd, s.createdBy.name],
      [item, fam, 'portal', GAST.ssid, 'WPA', GAST.password, false, true, 'Marc']);
    assert.equal(Date.parse(s.expiresAt), c.clock.now() + HOUR);

    const lena = (await c.as(LENA)('GET', 'wifi-shares', null, { item })).json;
    assert.deepEqual(lena.shares.map((x) => [x.id, x.canEnd]), [[s.id, false]], 'a reader sees it, cannot end it');
    assert.deepEqual(lena.targets, { wall: false, portal: true }, 'no Familie plugin: no wall');
    assert.deepEqual((await c.as(OMA)('GET', 'wifi-shares')).json.shares, [], 'not in the vault: nothing');
    assert.equal((await c.as(LENA)('DELETE', `wifi-shares/${s.id}`)).json.code, 'forbidden');
    assert.equal((await c.as(OMA)('DELETE', `wifi-shares/${s.id}`)).json.code, 'not_found');

    // Start tiles: signed-in people in the portal — also without Vault or a vault of their own
    const tiles = await host.portalTiles({ ...OMA, loggedIn: true });
    assert.equal(tiles.length, 1);
    assert.deepEqual(tiles[0], {
      title: 'WLAN', value: GAST.ssid, icon: tiles[0].icon, state: 'on', qr: wifi.qrText(GAST),
      secret: { label: 'Passwort', value: GAST.password }, until: s.expiresAt,
    });
    assert.deepEqual(await host.portalTiles({ ...OMA, loggedIn: false }), [], 'device trust alone');
    assert.deepEqual(await host.portalTiles({ ...WALL, loggedIn: true, kiosk: true }), [], 'a kiosk device');
    assert.deepEqual(await host.clientTiles({ ...ANNA }), [], 'never the apps\' start card');
    assert.equal((await host.portalTiles({ ...ANNA, loggedIn: true }, 'en'))[0].title, 'Wi-Fi');

    // after an hour it is gone everywhere — before the background run already
    c.clock.add(HOUR);
    assert.deepEqual(await host.portalTiles({ ...OMA, loggedIn: true }), []);
    assert.deepEqual((await c.as(ANNA)('GET', 'wifi-shares')).json.shares, []);
    await host.tick();
    const log = await all(host, "SELECT user_id, action, item_id, detail FROM events WHERE action LIKE 'wifi.%' ORDER BY rowid");
    assert.deepEqual(log.map((x) => [x.user_id, x.action, x.item_id, x.detail]), [
      [MARC.id, 'wifi.share', item, 'portal 1h'],
      [MARC.id, 'wifi.end', item, 'portal expired'],
    ]);
    assert.equal((await one(host, 'SELECT COUNT(*) AS n FROM wifi_shares')).n, 0, 'the copy is deleted');
  });
});

test('portal: ending deletes at once; sharing again replaces the copy; keep renews it with the same end; forever has no end', async () => {
  await withHost({}, async (host, c) => {
    const { item } = await setup(c);
    const a = (await c.as(ANNA)('POST', 'wifi-shares', body(item, 'portal', '5m'))).json.share;
    c.clock.add(MIN);
    const b = (await c.as(ANNA)('POST', 'wifi-shares', body(item, 'portal', 'keep', { password: 'neu' }))).json.share;
    assert.deepEqual([b.id, b.expiresAt, b.password], [a.id, a.expiresAt, 'neu'], 'keep: the same share, the same end, the new copy');
    const f = (await c.as(ANNA)('POST', 'wifi-shares', body(item, 'portal', 'forever'))).json.share;
    assert.deepEqual([f.id, f.expiresAt], [a.id, null]);
    c.clock.add(400 * DAY);
    assert.equal((await host.portalTiles({ ...MARC, loggedIn: true }))[0].until, undefined, 'forever: no until');
    const nopass = (await c.as(ANNA)('POST', 'wifi-shares', body(item, 'portal', '24h', { security: 'nopass', password: '' }))).json.share;
    assert.equal(nopass.security, 'nopass');
    const t = (await host.portalTiles({ ...MARC, loggedIn: true }))[0];
    assert.equal(t.secret, undefined, 'no password line for an open network');
    assert.equal((await c.as(MARC)('DELETE', `wifi-shares/${a.id}`)).json.removed, a.id);
    assert.deepEqual(await host.portalTiles({ ...MARC, loggedIn: true }), []);
    assert.equal((await c.as(MARC)('DELETE', `wifi-shares/${a.id}`)).json.code, 'not_found');
    assert.equal((await c.as(MARC)('DELETE', 'wifi-shares/nope')).json.code, 'not_found');
  });
});

test('the entry trashed, purged or moved, its vault deleted: the share ends (a log row with the reason)', async () => {
  await withHost({}, async (host, c) => {
    const { fam, item } = await setup(c);
    const share = (target) => c.as(ANNA)('POST', 'wifi-shares', body(item, target, '1h'));
    await share('portal');
    await c.as(ANNA)('POST', `items/${item}/trash`);
    assert.deepEqual(await host.portalTiles({ ...MARC, loggedIn: true }), [], 'trash');
    assert.equal((await share('portal')).json.code, 'conflict', 'not from the trash');
    await c.as(ANNA)('POST', `items/${item}/restore`);
    await share('portal');
    // moved into Anna's personal vault (the item is saved there with its next revision)
    const personal = (await c.as(ANNA)('GET', 'sync')).json.vaults.find((v) => v.kind === 'personal').id;
    await c.item(ANNA, personal, 1, { id: item, baseRev: 1 });
    assert.deepEqual(await host.portalTiles({ ...MARC, loggedIn: true }), [], 'moved');
    // a change in place keeps it (a copy; the apps offer "Aktualisieren")
    await share('portal');
    await c.item(ANNA, personal, 1, { id: item, baseRev: 2 });
    assert.equal((await host.portalTiles({ ...MARC, loggedIn: true })).length, 1, 'changed: still the copy');
    await c.as(ANNA)('DELETE', `items/${item}`);
    assert.deepEqual(await host.portalTiles({ ...MARC, loggedIn: true }), [], 'purged');
    // a vault deleted
    const it2 = (await c.item(ANNA, fam, 1)).id;
    await c.as(ANNA)('POST', 'wifi-shares', body(it2, 'portal', '1h'));
    await c.as(ANNA)('DELETE', `vaults/${fam}`);
    assert.equal((await one(host, 'SELECT COUNT(*) AS n FROM wifi_shares')).n, 0, 'vault deleted');
    const log = await all(host, "SELECT detail FROM events WHERE action = 'wifi.end' ORDER BY rowid");
    assert.deepEqual(log.map((x) => x.detail), ['portal ended: trash', 'portal ended: move', 'portal ended: purge']);
  });
});

test('limits: 4 running shares per target, 30 shares per person and hour; a kiosk device or no account gets nothing', async () => {
  await withHost({}, async (host, c) => {
    const { fam } = await setup(c);
    const items = [];
    for (let i = 0; i < 5; i++) items.push((await c.item(ANNA, fam, 1)).id);
    for (let i = 0; i < 4; i++) assert.equal((await c.as(ANNA)('POST', 'wifi-shares', body(items[i], 'portal', '1h'))).status, 200);
    assert.equal((await c.as(ANNA)('POST', 'wifi-shares', body(items[4], 'portal', '1h'))).json.code, 'limit');
    assert.equal((await c.as(ANNA)('POST', 'wifi-shares', body(items[0], 'portal', '24h'))).status, 200, 'renewing one of the four is fine');
    for (let i = 0; i < 25; i++) await c.as(ANNA)('POST', 'wifi-shares', body(items[1], 'portal', '1h'));
    const r = await c.as(ANNA)('POST', 'wifi-shares', body(items[1], 'portal', '1h'));
    assert.deepEqual([r.status, r.json.code], [429, 'rate_limited']);
    assert.equal((await c.as(MARC)('POST', 'wifi-shares', body(items[1], 'portal', '1h'))).status, 200, 'per person');
    const any = (await c.as(ANNA)('GET', 'wifi-shares')).json.shares[0];
    assert.equal((await c.as(ANNA)('DELETE', `wifi-shares/${any.id}`)).status, 200, 'ending is never limited');
    c.clock.add(HOUR);
    assert.equal((await c.as(ANNA)('POST', 'wifi-shares', body(items[1], 'portal', '1h'))).status, 200);
    assert.equal((await c.call(kiosk(WALL), 'GET', 'wifi-shares')).json.code, 'forbidden');
    assert.equal((await c.as(OMA)('GET', 'wifi-shares')).json.shares.length, 0);
  });
});

test('wall: the whole set goes to the Familie plugin on every change; nobody to show it → undone (no_wall)', async () => {
  const fa = familie();
  await withHost({ services: [fa.entry] }, async (host, c) => {
    const { item } = await setup(c);
    assert.deepEqual((await c.as(ANNA)('GET', 'wifi-shares')).json.targets, { wall: true, portal: true });
    const s = (await c.as(ANNA)('POST', 'wifi-shares', body(item, 'wall', '5m'))).json.share;
    assert.equal(s.target, 'wall');
    assert.deepEqual(fa.last(), [{ id: s.id, ssid: GAST.ssid, security: 'WPA', password: GAST.password, hidden: false, expiresAt: s.expiresAt, sharedBy: 'Anna' }]);
    assert.deepEqual(await host.portalTiles({ ...MARC, loggedIn: true }), [], 'a wall share is not on the portal');
    // ending: the empty set right away
    await c.as(MARC)('DELETE', `wifi-shares/${s.id}`);
    assert.deepEqual(fa.last(), []);
    // the Familie plugin has no wall tablet: refused, nothing kept, its set back to what it was
    fa.walls = 0;
    const n = fa.sets.length;
    const r = await c.as(ANNA)('POST', 'wifi-shares', body(item, 'wall', '1h'));
    assert.deepEqual([r.status, r.json.code], [409, 'no_wall']);
    assert.deepEqual(fa.sets.slice(n).map((x) => x.length), [1, 0], 'sent, then taken back');
    assert.equal((await one(host, "SELECT COUNT(*) AS n FROM wifi_shares WHERE target = 'wall'")).n, 0);
    // the wall module off: the same
    fa.walls = 1; fa.wall = false;
    assert.equal((await c.as(ANNA)('POST', 'wifi-shares', body(item, 'wall', '1h'))).json.code, 'no_wall');
    fa.wall = true;
    // the plugin fails: unavailable, nothing kept; the background run sends the set again
    fa.fail = true;
    const u = await c.as(ANNA)('POST', 'wifi-shares', body(item, 'wall', '1h'));
    assert.deepEqual([u.status, u.json.code], [503, 'unavailable']);
    fa.fail = false;
    const before = fa.sets.length;
    await host.tick();
    assert.deepEqual(fa.sets.slice(before), [[]], 'dirty → resent once');
    await host.tick();
    assert.equal(fa.sets.length, before + 1, 'in step: nothing to send');
  });
});

test('wall: trash ends it and the tablet gets the new set at once; hourly resend while shares run; an expired share is never sent', async () => {
  const fa = familie();
  await withHost({ services: [fa.entry] }, async (host, c) => {
    const { item } = await setup(c);
    await c.as(ANNA)('POST', 'wifi-shares', body(item, 'wall', 'forever'));
    assert.equal(fa.last().length, 1);
    await c.as(ANNA)('POST', `items/${item}/trash`);
    assert.deepEqual(fa.last(), [], 'trash → the empty set with that request');
    await c.as(ANNA)('POST', `items/${item}/restore`);
    await c.as(ANNA)('POST', 'wifi-shares', body(item, 'wall', '24h'));
    const n = fa.sets.length;
    await host.tick();
    assert.equal(fa.sets.length, n, 'just sent');
    c.clock.add(HOUR);
    await host.tick();
    assert.equal(fa.sets.length, n + 1, 'an hour later again (a reinstalled Familie plugin gets it back)');
    c.clock.add(DAY);
    await host.tick();
    const log = await all(host, "SELECT detail FROM events WHERE action = 'wifi.end' ORDER BY rowid");
    assert.deepEqual(log.map((x) => x.detail), ['wall ended: trash', 'wall expired']);
    assert.equal((await one(host, 'SELECT COUNT(*) AS n FROM wifi_shares')).n, 0);
  });
});

test('wall: without the Familie plugin the target is refused before anything is stored', async () => {
  await withHost({}, async (host, c) => {
    const { item } = await setup(c);
    const r = await c.as(ANNA)('POST', 'wifi-shares', body(item, 'wall', '1h'));
    assert.deepEqual([r.status, r.json.code], [409, 'no_wall']);
    assert.match(r.json.error, /Familie/);
    assert.equal((await one(host, 'SELECT COUNT(*) AS n FROM wifi_shares')).n, 0);
  });
});
