'use strict';

// Retention (7 days: files removed, history kept 30 days), the admin page and the portal page, the manifest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withHost, DIR, ADMIN, ANNA, MARC, PDF, PNG, DAY } = require('./helpers');

const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));

test('retention: after 7 days the files are gone (GateControl media deleted), the send expired; rows after 30 days', async () => {
  await withHost({}, async (host, c) => {
    const m = await c.upload(ANNA, PDF, 'application/pdf');
    const r = (await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: m, name: 'a.pdf' }], to: { people: [MARC.id] } })).json;
    c.clock.add(6 * DAY);
    await host.tick();
    assert.ok(host.media.has(m));
    assert.equal((await c.as(MARC)('GET', `items/${m}`)).status, 200);
    c.clock.add(DAY + 1000);
    const out = await host.tick();
    assert.equal(out.purged, 1);
    assert.equal(host.media.has(m), false);
    const s = (await c.as(MARC)('GET', 'inbox', null, { kind: 'received' })).json.items[0];
    assert.deepEqual([s.expired, s.items[0].available, s.items[0].mediaId, s.items[0].name], [true, false, null, 'a.pdf']);
    assert.equal((await c.as(MARC)('GET', `items/${m}`)).status, 404);
    assert.equal(await host.plugin.mediaAccess({ user: { id: MARC.id }, mediaId: m, owner: ANNA.id }, host.gc), false);
    c.clock.add(24 * DAY);
    assert.equal((await host.tick()).removed, 1);
    assert.equal((await c.as(ANNA)('GET', `sends/${r.id}`)).status, 404);
  });
});

test('admin overview: storage, retention, links, sends, what works with GateDrop', async () => {
  await withHost({ messenger: true }, async (host, c) => {
    const m = await c.upload(ANNA, PNG, 'image/png');
    await c.as(ANNA)('POST', 'sends', { items: [{ mediaId: m }], to: { link: { expires: '1d' } } });
    const o = (await c.call(ADMIN, 'GET', 'admin/overview')).json;
    assert.deepEqual([o.storage.bytes, o.storage.quota, o.retentionDays, o.sends7d, o.activeLinks, o.linksEnabled], [PNG.length, 10 * 1024 ** 3, 7, 1, 1, true]);
    assert.deepEqual(o.integrations, { messenger: true, nas: false, familie: true });
  });
});

test('pages: the portal tab and the admin page render in both languages; the manifest', async () => {
  await withHost({}, async (host) => {
    const p = (await host.render({ view: 'portal', user: { ...ANNA, loggedIn: true }, lang: 'en' })).html;
    assert.match(p, /window\.GD_CTX=/);
    assert.match(p, /Drop files here or choose them/);
    assert.match(p, /"loggedIn":true/);
    assert.doesNotMatch(p, /\{\{t:/);
    const k = (await host.render({ view: 'portal', user: { ...ANNA, loggedIn: true, kiosk: true } })).html;
    assert.match(k, /"loggedIn":false/, 'a kiosk device gets the login notice');
    const a = (await host.render({ view: 'page', page: 'overview', user: ADMIN })).html;
    assert.match(a, /gd-page/);
    assert.match(a, /Lädt/);
  });
  assert.equal(manifest.id, 'gatecontrol-gatedrop');
  assert.equal(manifest.gatecontrol, '>=1.193.0');
  assert.equal(manifest.media.maxBytes, 2147483648);
  assert.equal(manifest.media.quotaDefault, '10GB');
  assert.equal(manifest.license.required, true);
  assert.deepEqual(manifest.notifyTopics.map((t) => t.id), ['received', 'link']);
  assert.deepEqual([manifest.permissions.devices, manifest.permissions.publicLinks, manifest.permissions.app, manifest.permissions.portal], [true, true, true, true]);
  assert.deepEqual(manifest.permissions.services.sort(), ['gatecontrol-familie:family_roles', 'gatecontrol-messenger:send_file', 'gatecontrol-synology:list_drop_folders', 'gatecontrol-synology:save_file']);
  const texts = require('../server/texts.json');
  assert.deepEqual(Object.keys(texts.de).sort(), Object.keys(texts.en).sort());
});
