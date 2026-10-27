'use strict';

// A person's devices (1.5.0): PUT devices/<id>, GET devices, PUT devices/<id>/folders, DELETE devices/<id> — unique names
// per person ("PC (2)"), the folder Meine Dateien › Geräte › <name>, only one's own devices.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, BOB, OMA, MIN } = require('./helpers');

test('devices: register, unique names per person, the device folder, last seen', async () => {
  await withHost({}, async (host, c) => {
    const pc1 = c.as(ANNA, 'tok-pc1');
    const pc2 = c.as(ANNA, 'tok-pc2');
    const mine = await c.area(ANNA, 'mine');
    const r1 = await pc1('PUT', 'devices/pc-1', { name: 'PC', platform: 'Windows', version: '1.40.0' });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    const d1 = r1.json.device;
    assert.deepEqual({ id: d1.id, name: d1.name, platform: d1.platform, version: d1.version, current: d1.current, folders: d1.folders },
      { id: 'pc-1', name: 'PC', platform: 'windows', version: '1.40.0', current: true, folders: [] });
    assert.equal(d1.lastSeen, new Date(c.clock.now()).toISOString());
    assert.equal(d1.folder.path, 'Geräte/PC');
    assert.equal(d1.folder.where, 'Meine Dateien › Geräte › PC');
    assert.equal(d1.folder.areaId, mine.id);
    const byPath = await pc1('GET', 'nodes/by-path', null, { area: mine.id, path: 'Geräte/PC' });
    assert.equal(byPath.json.node.id, d1.folder.id);

    // a second PC with the same host name: its own name and folder
    const d2 = (await pc2('PUT', 'devices/pc-2', { name: 'PC', platform: 'windows' })).json.device;
    assert.equal(d2.name, 'PC (2)');
    assert.equal(d2.folder.path, 'Geräte/PC (2)');
    assert.notEqual(d2.folder.id, d1.folder.id);
    // again: the same name and folder (the device keeps what it got)
    c.clock.add(5 * MIN);
    const again = (await pc1('PUT', 'devices/pc-1', { name: 'PC' })).json.device;
    assert.deepEqual([again.name, again.folder.id, again.platform, again.version], ['PC', d1.folder.id, 'windows', '1.40.0']);
    assert.equal(again.lastSeen, new Date(c.clock.now()).toISOString());
    // names ignore case
    assert.equal((await c.as(ANNA, 'tok-x')('PUT', 'devices/x', { name: 'pc' })).json.device.name, 'pc (3)');
    // what a folder cannot hold becomes "_"
    assert.equal((await c.as(ANNA, 'tok-y')('PUT', 'devices/y', { name: 'Büro: PC*' })).json.device.name, 'Büro_ PC_');

    // another person: their own names
    const bob = c.as(BOB, 'tok-bob');
    assert.equal((await bob('PUT', 'devices/pc-1', { name: 'PC' })).json.device.name, 'PC');
    // GET devices: mine only, last seen first; `current` for the asking token's
    const list = (await pc2('GET', 'devices')).json.devices;
    assert.deepEqual(list.map((d) => d.id).sort(), ['pc-1', 'pc-2', 'x', 'y']);
    assert.equal(list[list.length - 1].id, 'pc-2', 'seen longest ago: last');
    assert.deepEqual(list.filter((d) => d.current).map((d) => d.id), ['pc-2']);
    assert.deepEqual((await bob('GET', 'devices')).json.devices.map((d) => d.id), ['pc-1']);

    // last seen also through any request of the token that registered it (at most every 10 minutes)
    c.clock.add(11 * MIN);
    await pc2('GET', 'me');
    const seen = (await pc2('GET', 'devices')).json.devices.find((d) => d.id === 'pc-2');
    assert.equal(seen.lastSeen, new Date(c.clock.now()).toISOString());

    // the portal has no device token: it lists and registers like an app
    const portalList = (await c.portal(ANNA)('GET', 'devices')).json.devices;
    assert.equal(portalList.length, 4);
    assert.ok(portalList.every((d) => d.current === false));
  });
});

test('devices: folders, renaming, taking over an older folder, a folder gone, forgetting', async () => {
  await withHost({}, async (host, c) => {
    const pc = c.as(ANNA, 'tok-pc');
    const mine = await c.area(ANNA, 'mine');
    const d = (await pc('PUT', 'devices/pc-1', { name: 'PC' })).json.device;
    const pics = (await pc('POST', 'nodes', { parentId: d.folder.id, name: 'Bilder' })).json.node;
    const at = '2026-10-26T08:30:00.000Z';
    const f = await pc('PUT', 'devices/pc-1/folders', [
      { localPath: 'C:\\Users\\Anna\\Pictures', mode: 'backup', nodeId: pics.id, lastBackup: at },
      { localPath: 'D:\\Projekte', mode: 'sync', nodeId: null, lastBackup: null },
    ]);
    assert.equal(f.status, 200, JSON.stringify(f.json));
    assert.deepEqual(f.json.device.folders, [
      { localPath: 'C:\\Users\\Anna\\Pictures', mode: 'backup', nodeId: pics.id, lastBackup: at,
        node: { id: pics.id, name: 'Bilder', areaId: mine.id, path: 'Geräte/PC/Bilder', where: 'Meine Dateien › Geräte › PC › Bilder' } },
      { localPath: 'D:\\Projekte', mode: 'sync', nodeId: null, lastBackup: null, node: null },
    ]);
    // also as { folders }; ms for lastBackup
    const g = await pc('PUT', 'devices/pc-1/folders', { folders: [{ localPath: 'C:\\A', mode: 'sync', nodeId: String(pics.id), lastBackup: Date.parse(at) }] });
    assert.equal(g.json.device.folders[0].lastBackup, at);
    assert.equal(g.json.device.folders[0].nodeId, pics.id);
    // bad lists
    for (const [body, field] of [
      [[{ localPath: 'C:\\A', mode: 'mirror' }], 'folders[0].mode'],
      [[{ localPath: '', mode: 'sync' }], 'folders[0].localPath'],
      [[{ localPath: 'C:\\A', mode: 'sync', nodeId: -1 }], 'folders[0].nodeId'],
      [[{ localPath: 'C:\\A', mode: 'sync', lastBackup: 'gestern' }], 'folders[0].lastBackup'],
      [{ folders: 'x' }, 'folders'],
      [new Array(101).fill({ localPath: 'C:\\A', mode: 'sync' }), 'folders'],
    ]) {
      const r = await pc('PUT', 'devices/pc-1/folders', body);
      assert.equal(r.status, 400, field);
      assert.equal(r.json.field, field);
    }
    // an unknown device, another person's device: not found; their folder ids show no node
    assert.equal((await pc('PUT', 'devices/nope/folders', [])).status, 404);
    const bob = c.as(BOB, 'tok-bob');
    assert.equal((await bob('PUT', 'devices/pc-1/folders', [])).status, 404);
    await bob('PUT', 'devices/b1', { name: 'Laptop' });
    const spy = await bob('PUT', 'devices/b1/folders', [{ localPath: 'C:\\X', mode: 'sync', nodeId: pics.id }]);
    assert.equal(spy.json.device.folders[0].node, null, 'no names of folders Bob cannot read');
    // bad ids and names
    assert.equal((await pc('PUT', 'devices/a b', { name: 'X' })).json.field, 'id');
    assert.equal((await pc('PUT', 'devices/z', { name: '  ' })).json.field, 'name');
    assert.equal((await pc('PUT', 'devices/z', { name: 'X', platform: 'Win 11' })).json.field, 'platform');

    // renamed: the folder follows (its content too)
    const ren = (await pc('PUT', 'devices/pc-1', { name: 'Arbeits-PC' })).json.device;
    assert.equal(ren.name, 'Arbeits-PC');
    assert.equal(ren.folder.id, d.folder.id);
    assert.equal(ren.folder.path, 'Geräte/Arbeits-PC');
    assert.equal(ren.folders[0].node.path, 'Geräte/Arbeits-PC/Bilder');

    // an older app made Geräte/Laptop: the first device of that name takes it over
    const top = (await pc('GET', 'nodes/by-path', null, { area: mine.id, path: 'Geräte' })).json.node;
    const old = (await pc('POST', 'nodes', { parentId: top.id, name: 'Laptop' })).json.node;
    const lap = (await c.as(ANNA, 'tok-lap')('PUT', 'devices/lap', { name: 'Laptop' })).json.device;
    assert.equal(lap.folder.id, old.id);
    // a second "Laptop" does not
    const lap2 = (await c.as(ANNA, 'tok-lap2')('PUT', 'devices/lap2', { name: 'Laptop' })).json.device;
    assert.deepEqual([lap2.name, lap2.folder.path], ['Laptop (2)', 'Geräte/Laptop (2)']);

    // the folder went into the trash: the next PUT makes it again
    assert.equal((await pc('DELETE', `nodes/${lap2.folder.id}`)).status, 200);
    assert.equal((await pc('GET', 'devices')).json.devices.find((x) => x.id === 'lap2').folder, null);
    const back = (await c.as(ANNA, 'tok-lap2')('PUT', 'devices/lap2', { name: 'Laptop' })).json.device;
    assert.notEqual(back.folder.id, lap2.folder.id);
    assert.equal(back.folder.path, 'Geräte/Laptop (2)');

    // forget: the row goes, the files stay
    const del = await c.portal(ANNA)('DELETE', 'devices/pc-1');
    assert.deepEqual(del.json, { ok: true, id: 'pc-1', removed: true });
    assert.equal((await c.portal(ANNA)('DELETE', 'devices/pc-1')).json.removed, false);
    assert.equal((await pc('GET', `nodes/${pics.id}`)).status, 200);
    assert.ok(!(await pc('GET', 'devices')).json.devices.some((x) => x.id === 'pc-1'));
    // Bob cannot forget Anna's device
    assert.equal((await bob('DELETE', 'devices/lap')).json.removed, false);
    assert.ok((await pc('GET', 'devices')).json.devices.some((x) => x.id === 'lap'));
  });
});

test('devices: a seat is needed; at most 50 per person', async () => {
  await withHost({}, async (host, c) => {
    const oma = await c.as(OMA)('PUT', 'devices/o', { name: 'PC' });
    assert.equal(oma.status, 403);
    assert.equal(oma.json.code, 'no_seat');
    const m = c.as(MARC, 'tok-m');
    for (let i = 0; i < 50; i++) assert.equal((await m('PUT', `devices/d${i}`, { name: 'Handy' })).status, 200);
    const over = await m('PUT', 'devices/d50', { name: 'Handy' });
    assert.equal(over.status, 409);
    assert.equal(over.json.code, 'device_limit');
    // a known one may still update
    assert.equal((await m('PUT', 'devices/d0', { name: 'Handy' })).status, 200);
    assert.equal((await m('GET', 'devices')).json.devices.length, 50);
  });
});
