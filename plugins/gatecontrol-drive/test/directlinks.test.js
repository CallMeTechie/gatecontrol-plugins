'use strict';

// Direct links into the portal (1.6.0, server/address.js): GET me links { node, drive } — from the setting portal_url or
// the public address GateControl builds its links on; null without one; notifications carry the link and the button
// "Öffnen" (open_portal with ?drive=<id>).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, MIN } = require('./helpers');

const PORTAL = 'https://gc.example.com/portal';

test('GET me links: null until Drive knows an address; the public links\' address; the setting portal_url wins', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    let me = (await a('GET', 'me')).json;
    assert.equal(me.links, null, 'no link made yet: GateControl names no address');
    assert.ok(me.features.includes('links'));
    const mine = await c.area(ANNA, 'mine');
    const f = (await c.put(ANNA, mine.rootId, 'Brief.pdf', '%PDF')).json.node;
    assert.equal((await a('POST', 'links', { nodeId: f.id })).status, 200);
    me = (await a('GET', 'me')).json;
    assert.deepEqual(me.links, { node: `${PORTAL}?drive={id}#plg-gatecontrol-drive`, drive: `${PORTAL}#plg-gatecontrol-drive` });
    // forgotten (a new database): GET me asks GateControl's public links again (at most once an hour)
    await host.gc.storage.delete('public_origin');
    assert.equal((await c.as(MARC)('GET', 'me')).json.links, null, 'asked within the hour already');
    c.clock.add(61 * MIN);
    assert.deepEqual((await c.as(MARC)('GET', 'me')).json.links.drive, `${PORTAL}#plg-gatecontrol-drive`);
  });
  await withHost({ settings: { portal_url: 'https://drive.example.org/irgendwo?x=1' } }, async (host, c) => {
    assert.deepEqual((await c.as(ANNA)('GET', 'me')).json.links, {
      node: 'https://drive.example.org/portal?drive={id}#plg-gatecontrol-drive', drive: 'https://drive.example.org/portal#plg-gatecontrol-drive',
    });
  });
  // links switched off and no setting: no address
  await withHost({ links: false }, async (host, c) => {
    assert.equal((await c.as(ANNA)('GET', 'me')).json.links, null);
    await host.tick();
    assert.equal((await c.as(ANNA)('GET', 'me')).json.links, null);
  });
});

test('notifications carry the direct link: an upload through a link (the file), a look into a child\'s folder (its folder)', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const fam = await c.area(ANNA, 'family');
    const inbox = (await a('POST', 'nodes', { parentId: fam.rootId, name: 'Eingang' })).json.node;
    const l = (await a('POST', 'links', { nodeId: inbox.id, mode: 'upload', expires: '7d' })).json.link;
    await host.publicLinkUpload(l.token, { name: 'Rechnung.pdf', data: '%PDF-1', mime: 'application/pdf', by: 'Opa Karl' });
    const file = (await a('GET', 'nodes/by-path', null, { area: fam.id, path: 'Eingang/Rechnung.pdf' })).json.node;
    const up = c.pushes().find((x) => x.topic === 'link_upload');
    assert.equal(up.data.link, `${PORTAL}?drive=${file.id}#plg-gatecontrol-drive`);
    assert.deepEqual(up.data.drive, { node: inbox.id, area: fam.id, file: file.id });
    assert.deepEqual(up.data.actions, [{ id: 'open', type: 'open_portal', label: 'Öffnen', target: `/portal?drive=${file.id}#plg-gatecontrol-drive` }]);
    // Anna looks into Lena's folder: Lena's note opens her folder
    const lena = await c.area(LENA, 'child');
    await a('GET', `nodes/${lena.rootId}/children`);
    const cv = c.pushes().find((x) => x.topic === 'child_view');
    assert.equal(cv.data.link, `${PORTAL}?drive=${lena.rootId}#plg-gatecontrol-drive`);
    assert.equal(cv.data.drive.node, lena.rootId);
    assert.equal(cv.data.actions[0].target, `/portal?drive=${lena.rootId}#plg-gatecontrol-drive`);
  });
});
