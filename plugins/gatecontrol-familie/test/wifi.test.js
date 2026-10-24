'use strict';

// Wi-Fi on the wall tablet (1.14.0, server/wifi.js): the Vault plugin's service wall_wifi hands over the whole set of
// running wall shares; GET wall shows them with their QR code to a kiosk device or a signed-in wall account — never
// device trust alone, never an expired one; the background purge drops expired rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const wifi = require('../server/wifi');
const { withFamily, KUECHE, ANNA, MIN, HOUR, portal, kioskViewer } = require('./helpers');

const ID1 = 'a'.repeat(24);
const ID2 = 'b'.repeat(24);
const share = (o = {}) => ({ id: ID1, ssid: 'Gäste;WLAN', security: 'WPA', password: 'Korrekt:Pferd', hidden: false, expiresAt: null, sharedBy: 'Anna', ...o });
const send = (host, shares, caller = 'gatecontrol-vault') => host.callService('wall_wifi', { caller, payload: { shares } });

async function wallOn(admin) {
  await admin('PUT', 'modules', { wall: true });
  const r = await admin('POST', 'members', { userId: KUECHE.id, role: 'wall', birthdate: '2000-01-01', locateMode: 'auto' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}

/** The QR code ({ size, rows }) read back with the jsQR of the Vault plugin's bundle (a test-only dependency). */
function decode(qr) {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'gatecontrol-vault', 'ui', 'vendor', 'noble.js'), 'utf8');
  const sandbox = { window: {}, self: {}, globalThis: {}, TextEncoder, TextDecoder, Uint8Array, Uint8ClampedArray, Math, Date };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox);
  const N = sandbox.window.VaultNoble || sandbox.VaultNoble;
  const scale = 4;
  const quiet = 4;
  const n = (qr.size + quiet * 2) * scale;
  const px = new Uint8ClampedArray(n * n * 4).fill(255);
  qr.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== '1') continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const i = (((y + quiet) * scale + dy) * n + (x + quiet) * scale + dx) * 4;
        px[i] = px[i + 1] = px[i + 2] = 0;
      }
    }
  });
  const got = N.qrDecode(px, n, n);
  return got && got.data;
}

test('the QR code text: WIFI:T:…;S:…;P:…;H:true;; with \\ ; , : " escaped', () => {
  assert.equal(wifi.qrText(share()), 'WIFI:T:WPA;S:Gäste\\;WLAN;P:Korrekt\\:Pferd;;');
  assert.equal(wifi.qrText({ ssid: 'a"b,c\\', security: 'nopass', password: '', hidden: true }), 'WIFI:T:nopass;S:a\\"b\\,c\\\\;H:true;;');
  const q = wifi.qrRows(wifi.qrText(share()));
  assert.ok(q.size >= 21 && q.rows.length === q.size && q.rows.every((r) => r.length === q.size && /^[01]+$/.test(r)));
  assert.equal(q.rows[0].slice(0, 7), '1111111', 'finder pattern');
  assert.equal(decode(q), wifi.qrText(share()), 'reads back');
});

test('service wall_wifi: only Vault calls it; the whole set replaces what was there; bad sets are refused', () => withFamily({}, async (host, { admin }) => {
  assert.deepEqual(await send(host, [share()], 'gatecontrol-messenger'), { ok: false, code: 'forbidden' });
  assert.deepEqual(await send(host, [share()]), { ok: true, walls: 0, wall: false }, 'no wall tablet yet');
  await wallOn(admin);
  assert.deepEqual(await send(host, [share(), share({ id: ID2, security: 'nopass', password: '' })]), { ok: true, walls: 1, wall: true });
  assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM wall_wifi', [])).row.n, 2);
  for (const bad of [
    [share({ id: 'x' })], [share({ ssid: '' })], [share({ security: 'WPA2' })], [share({ password: '' })], [share({ security: 'nopass' })],
    [share({ expiresAt: 'bald' })], [share({ ssid: 'a\nb' })], [share(), share()], [1, 2, 3, 4, 5].map((i) => share({ id: String(i).repeat(24) })),
  ]) assert.deepEqual(await send(host, bad), { ok: false, code: 'invalid' }, JSON.stringify(bad).slice(0, 80));
  assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM wall_wifi', [])).row.n, 2, 'a refused set changes nothing');
  assert.deepEqual(await send(host, []), { ok: true, walls: 1, wall: true });
  assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM wall_wifi', [])).row.n, 0, 'the empty set: all gone');
}));

test('GET wall: the running shares with QR code for a kiosk device or a signed-in wall account; device trust alone gets none; an expired one never', () => withFamily({}, async (host, { admin, call, clock }) => {
  await wallOn(admin);
  const until = new Date(clock.now() + 5 * MIN).toISOString();
  await send(host, [share({ expiresAt: until }), share({ id: ID2, ssid: 'Offen', security: 'nopass', password: '', hidden: true })]);
  const k = (await call(kioskViewer(KUECHE), 'GET', '/wall')).json;
  assert.deepEqual(k.wifi.map((w) => [w.id, w.ssid, w.security, w.password, w.hidden, w.expiresAt, w.sharedBy]), [
    [ID1, 'Gäste;WLAN', 'WPA', 'Korrekt:Pferd', false, until, 'Anna'],
    [ID2, 'Offen', 'nopass', '', true, null, 'Anna'],
  ]);
  assert.equal(decode(k.wifi[0].qr), 'WIFI:T:WPA;S:Gäste\\;WLAN;P:Korrekt\\:Pferd;;');
  assert.equal(decode(k.wifi[1].qr), 'WIFI:T:nopass;S:Offen;H:true;;');
  assert.equal((await call(portal(KUECHE, true), 'GET', '/wall')).json.wifi.length, 2, 'a signed-in wall account');
  assert.equal((await call(portal(KUECHE, false), 'GET', '/wall')).json.wifi, null, 'device trust alone: no password');
  assert.equal((await call(portal(ANNA, true), 'GET', '/wall')).json.wifi, null, 'a family member reading the wall view: not the Wi-Fi');
  clock.add(5 * MIN);
  assert.deepEqual((await call(kioskViewer(KUECHE), 'GET', '/wall')).json.wifi.map((w) => w.id), [ID2], 'expired: gone at once');
  clock.add(2 * HOUR);
  await host.tick();
  assert.deepEqual((await host.gc.db.query('SELECT id FROM wall_wifi', [])).rows.map((r) => r.id), [ID2], 'the purge dropped the expired row');
  await send(host, []);
  assert.equal((await call(kioskViewer(KUECHE), 'GET', '/wall')).json.wifi, null);
}));

test('the wall page draws the card: QR code, password behind „Anzeigen“, time left; a card goes when its time is up', () => {
  const fs = require('node:fs');
  const js = fs.readFileSync(path.join(__dirname, '..', 'ui', 'wall.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'wall.html'), 'utf8');
  assert.match(html, /id="fa-w-wifi"[^>]*hidden/);
  assert.match(js, /function renderWifi\(\)/);
  assert.match(js, /SHOW_MS = 30000/);
  assert.match(js, /setInterval\(tickWifi, 1000\)/);
  assert.doesNotMatch(js, /innerHTML/);
  const texts = require('../server/texts.json');
  for (const k of ['wall.wifi', 'wall.wifi_password', 'wall.wifi_show', 'wall.wifi_hide', 'wall.wifi_open', 'wall.wifi_scan', 'wall.wifi_by', 'wall.wifi_left', 'wall.wifi_hours', 'wall.wifi_days', 'wall.wifi_forever', 'wall.wifi_qr']) {
    assert.ok(texts.de[k] && texts.en[k], k);
  }
});
