'use strict';

// Who may use GateDrop, GET targets, and the checks of POST sends.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, ADMIN, ANNA, MARC, LENA, OMA, WALL, PDF, PNG } = require('./helpers');

test('access: app users and signed-in portal viewers only — never a kiosk device, device trust or the admin UI', async () => {
  await withHost({}, async (host, c) => {
    const kiosk = { ...WALL, portal: true, loggedIn: true, kiosk: true };
    for (const [user, code] of [[null, 'forbidden'], [ANNA, 'forbidden'], [kiosk, 'forbidden'], [{ ...ANNA, portal: true, loggedIn: false }, 'login_required'], [{ ...ANNA, app: true, loggedIn: false }, 'login_required']]) {
      const r = await c.call(user, 'GET', 'targets');
      assert.deepEqual([r.status, r.json.code], [403, code], JSON.stringify(user));
    }
    assert.equal((await c.portal(ANNA)('GET', 'targets')).status, 200);
    assert.equal((await c.portal(ANNA)('GET', 'portal/targets')).status, 200, 'the same routes under portal/…');
    // a kiosk device seen once is never offered as a person
    assert.equal(await host.portalVisible(kiosk), false);
    const people = (await c.portal(ANNA)('GET', 'targets')).json.people.map((p) => p.id);
    assert.ok(!people.includes(WALL.id));
    assert.equal(await host.portalVisible({ ...ANNA, loggedIn: true }), true);
    assert.equal(await host.portalVisible({ ...ANNA }, 'section'), false);
    // the admin overview: administrators in the admin UI only
    assert.equal((await c.call(ADMIN, 'GET', 'admin/overview')).status, 200);
    assert.equal((await c.call(app(ADMIN), 'GET', 'admin/overview')).status, 403);
    assert.equal((await c.call(ANNA, 'GET', 'admin/overview')).status, 403);
    assert.equal((await c.as(ANNA)('GET', 'nothing')).status, 404);
  });
});

test('GET targets: people, the family, own devices (not the asking one, no web clients), NAS folders and links by role', async () => {
  await withHost({ nas: true }, async (host, c) => {
    const t = (await c.as(ANNA, 'anna-phone')('GET', 'targets')).json;
    assert.deepEqual(t.me, { id: ANNA.id, name: 'Anna', canLink: true, canNas: true, deviceId: 'anna-phone' });
    assert.deepEqual(t.people.map((p) => [p.id, p.kind]), [['family', 'family'], [ADMIN.id, 'user'], [WALL.id, 'user'], [LENA.id, 'user'], [MARC.id, 'user'], [OMA.id, 'user']]);
    assert.deepEqual(Object.keys(t.people[1]).sort(), ['avatar', 'colorHex', 'id', 'initials', 'kind', 'name']);
    assert.deepEqual(t.devices.map((d) => [d.id, d.platform, d.online, d.direct]), [['anna-pc', 'windows', true, false], ['anna-tab', 'android', false, false]]);
    assert.deepEqual(t.nas.map((n) => n.path), ['/Familie/Ablage']);
    assert.deepEqual(t.links, { enabled: true });
    assert.equal(t.limits.maxBytes, 2147483648);
    assert.equal(t.limits.maxItems, 20);
    assert.equal(t.limits.retentionDays, 7);
    assert.equal(t.storage.quota, 10 * 1024 ** 3);
    // a child: no NAS, no links, still the family; Oma: no family, no NAS; the administrator: everything
    const lena = (await c.as(LENA)('GET', 'targets')).json;
    assert.deepEqual([lena.me.canLink, lena.me.canNas, lena.nas, lena.people[0].id], [false, false, [], 'family']);
    const oma = (await c.as(OMA)('GET', 'targets')).json;
    assert.deepEqual([oma.me.canLink, oma.nas.length, oma.people.some((p) => p.id === 'family')], [false, 0, false]);
    const admin = (await c.portal(ADMIN)('GET', 'targets')).json;
    assert.deepEqual([admin.me.canLink, admin.me.canNas, admin.nas.length, admin.me.deviceId], [true, true, 1, null]);
  });
  // links switched off by the administrator; no Familie: only administrators share links and NAS
  await withHost({ links: false, roles: false }, async (host, c) => {
    const t = (await c.as(ANNA)('GET', 'targets')).json;
    assert.deepEqual([t.links.enabled, t.me.canLink, t.people.some((p) => p.id === 'family')], [false, false, false]);
    host.setPublicLinks(true);
    c.clock.add(2 * 60000);
    assert.equal((await c.as(ADMIN)('GET', 'targets')).json.links.enabled, true);
  });
});

test('POST sends: checks of items, text, link, targets and the files', async () => {
  await withHost({}, async (host, c) => {
    const as = c.as(ANNA, 'anna-phone');
    const m = await c.upload(ANNA, PDF, 'application/pdf');
    const marcs = await c.upload(MARC, PDF, 'application/pdf');
    const bad = [
      [{}, 'invalid'],
      [{ text: 'hi' }, 'invalid'],                                                          // no target
      [{ to: { people: [MARC.id] } }, 'invalid'],                                           // nothing to send
      [{ text: 'x'.repeat(20001), to: { people: [MARC.id] } }, 'invalid'],
      [{ link: 'javascript:alert(1)', to: { people: [MARC.id] } }, 'invalid'],
      [{ items: new Array(21).fill({ mediaId: m }), to: { people: [MARC.id] } }, 'invalid'],
      [{ items: [{ mediaId: m }, { mediaId: m }], to: { people: [MARC.id] } }, 'invalid'],
      [{ items: [{ mediaId: 'nope' }], to: { people: [MARC.id] } }, 'invalid'],
      [{ text: 'hi', to: { people: [ANNA.id] } }, 'invalid'],                               // oneself
      [{ text: 'hi', to: { people: [99] } }, 'invalid'],
      [{ text: 'hi', to: { devices: ['marc-phone'] } }, 'invalid'],                         // not her device
      [{ text: 'hi', to: { devices: ['anna-phone'] } }, 'invalid'],                         // the sending device itself
      [{ text: 'hi', to: { link: { expires: '1d' } } }, 'invalid'],                         // a link needs files
      [{ items: [{ mediaId: m }], to: { link: { expires: '2y' } } }, 'invalid'],
      [{ items: [{ mediaId: m }], to: { nas: [{ id: 1, path: '../etc' }] } }, 'invalid'],
      [{ items: [{ mediaId: marcs }], to: { people: [MARC.id] } }, 'media_invalid'],        // Marc's upload
      [{ items: [{ mediaId: 'f'.repeat(32) }], to: { people: [MARC.id] } }, 'media_invalid'],
      [{ items: [{ name: 'big.mkv', bytes: 1e9, local: true }], to: { people: [MARC.id] } }, 'upload_required'],
      [{ items: [{ name: 'big.mkv', bytes: 1e9, local: true }], to: { devices: ['anna-pc'] } }, 'upload_required'], // not direct
      [{ items: [{ name: 'x', bytes: 3e9, local: true }], to: { devices: ['anna-pc'] } }, 'invalid'],               // > 2 GB
    ];
    for (const [body, code] of bad) {
      const r = await as('POST', 'sends', body);
      assert.equal(r.json.code, code, JSON.stringify(body).slice(0, 120));
    }
    // links and NAS folders: administrators and Familie's parents only
    const lm = await c.upload(LENA, PNG, 'image/png');
    assert.equal((await c.as(LENA)('POST', 'sends', { items: [{ mediaId: lm }], to: { link: { expires: '1d' } } })).json.code, 'forbidden');
    const om = await c.upload(OMA, PNG, 'image/png');
    assert.equal((await c.as(OMA)('POST', 'sends', { items: [{ mediaId: om }], to: { nas: [{ id: 1 }] } })).json.code, 'forbidden');
    assert.equal((await c.as(OMA)('POST', 'sends', { text: 'hi', to: { people: ['family'] } })).json.code, 'forbidden', 'not in the family');
    assert.equal((await as('POST', 'sends', { items: [{ mediaId: m }], to: { nas: [{ id: 1 }] } })).json.code, 'not_found', 'no NAS plugin');
    // a sent file cannot be sent again; nothing of a refused send is stored
    const ok = await as('POST', 'sends', { items: [{ mediaId: m, name: 'Brief.pdf' }], to: { people: [MARC.id] } });
    assert.equal(ok.status, 200);
    assert.equal((await as('POST', 'sends', { items: [{ mediaId: m }], to: { people: [MARC.id] } })).json.code, 'media_in_use');
    assert.equal((await as('GET', 'inbox', null, { kind: 'sent' })).json.items.length, 1);
    assert.equal((await as('GET', 'inbox', null, { kind: 'nope' })).json.code, 'invalid');
    assert.equal((await as('GET', 'inbox', null, { kind: 'sent', limit: '500' })).json.code, 'invalid');
  });
});

test('presence: only from an app installation, checked; the answer tells how often to report', async () => {
  await withHost({}, async (host, c) => {
    assert.equal((await c.portal(ANNA)('PUT', 'presence', { lan: [], listening: false })).json.code, 'no_device');
    assert.equal((await c.as(ANNA)('PUT', 'presence', { lan: [], listening: false })).json.code, 'no_device', 'an app without user.device (older core)');
    const as = c.as(ANNA, 'anna-pc');
    for (const body of [null, { lan: 'x', listening: true }, { lan: [], listening: 'yes' }, { lan: [{ ip: '192.168.1.2', prefix: 24 }], listening: true, port: 80 }, { lan: new Array(17).fill({ ip: '10.0.0.1', prefix: 8 }), listening: true }]) {
      assert.equal((await as('PUT', 'presence', body)).json.code, 'invalid', JSON.stringify(body));
    }
    const r = await as('PUT', 'presence', { lan: [{ ip: '192.168.1.20', prefix: 24 }, { ip: 'fe80::1', prefix: 64 }, { ip: '999.1.1.1', prefix: 24 }], port: 47731, listening: true });
    assert.deepEqual(r.json.presence, { lan: [{ ip: '192.168.1.20', prefix: 24 }], port: 47731, listening: true, everyS: 300, freshS: 900 });
  });
});
