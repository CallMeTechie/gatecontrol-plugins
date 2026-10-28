'use strict';

// "Löschen auf allen Geräten" (1.2.0): DELETE nodes/<id>?everywhere=1, GET wipes, POST wipes/done, GET me `wipes`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withHost, DIR, ANNA, MARC, MIN, DAY } = require('./helpers');

const sha = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex');

test('plugin.json: permissions.devices — GateControl passes the asking device only then', () => {
  const m = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
  assert.equal(m.permissions.devices, true);
  assert.equal(m.version, '1.8.0');
});

test('a file deleted everywhere: every device of mine removes its copy, then the entry goes', async () => {
  await withHost({}, async (host, c) => {
    const phone = c.as(ANNA, 'phone-2');
    const pc = c.as(ANNA, 'pc-2');
    const portal = c.portal(ANNA);
    let me = await pc('GET', 'me');
    assert.equal(me.json.me.deviceId, 'pc-2');
    assert.equal(me.json.wipes, 0);
    const mine = await c.area(ANNA, 'mine'); // from phone-2: both devices are known now
    const up = await c.put(ANNA, mine.rootId, 'Strand.jpg', 'jpeg-bytes', { mime: 'image/jpeg' });
    const node = up.json.node;
    // a plain delete: no wipe
    const other = await c.put(ANNA, mine.rootId, 'Notiz.txt', 'x');
    const plain = await phone('DELETE', `nodes/${other.json.node.id}`);
    assert.equal(plain.status, 200);
    assert.equal(plain.json.wipe, undefined);
    assert.equal((await pc('GET', 'me')).json.wipes, 0);

    const before = c.events().length;
    const del = await phone('DELETE', `nodes/${node.id}`, null, { everywhere: '1' });
    assert.equal(del.status, 200);
    assert.equal(del.json.id, node.id);
    assert.equal(del.json.trashed, 1);
    assert.equal(typeof del.json.wipe.id, 'number');
    assert.deepEqual({ devices: del.json.wipe.devices, files: del.json.wipe.files }, { devices: 2, files: 1 });
    // in the trash like a plain delete
    assert.equal((await portal('GET', 'trash')).json.items.filter((x) => x.id === node.id).length, 1);
    // the live event to Anna's apps
    const ev = c.events().slice(before).find((e) => e.type === 'wipes');
    assert.ok(ev);
    assert.deepEqual(ev.users, [ANNA.id]);
    assert.deepEqual(ev.data, { wipe: del.json.wipe.id, files: 1 });

    me = await pc('GET', 'me');
    assert.equal(me.json.wipes, 1);
    assert.equal(me.json.devices, 2);
    const list = await pc('GET', 'wipes');
    assert.equal(list.status, 200);
    assert.equal(list.json.more, false);
    assert.equal(list.json.wipes.length, 1);
    const w = list.json.wipes[0];
    assert.deepEqual({ ...w, id: 0 }, {
      id: 0, wipeId: del.json.wipe.id, nodeId: node.id, name: 'Strand.jpg', sha256: sha('jpeg-bytes'), size: 10, mime: 'image/jpeg',
      createdAt: new Date(c.clock.now()).toISOString(),
    });
    // the portal has no copies: nothing to do there
    assert.deepEqual((await portal('GET', 'wipes')).json.wipes, []);
    assert.equal((await portal('GET', 'me')).json.wipes, 0);
    assert.deepEqual((await portal('POST', 'wipes/done', { ids: [w.id] })).json, { ok: true, done: 0, wipes: 0 });
    // another person cannot confirm for Anna's devices
    const marc = c.as(MARC, 'phone-3');
    assert.deepEqual((await marc('GET', 'wipes')).json.wipes, []);
    assert.equal((await marc('POST', 'wipes/done', { ids: [w.id] })).json.done, 0);

    // the PC confirms; the phone still has it
    const d1 = await pc('POST', 'wipes/done', { ids: [w.id, w.id, 999999] });
    assert.deepEqual(d1.json, { ok: true, done: 1, wipes: 0 });
    assert.deepEqual((await pc('GET', 'wipes')).json.wipes, []);
    assert.equal((await phone('GET', 'me')).json.wipes, 1);
    // again: nothing left to confirm
    assert.equal((await pc('POST', 'wipes/done', { ids: [w.id] })).json.done, 0);
    // the phone confirms: every target did — the entry and the wipe go
    assert.equal((await phone('POST', 'wipes/done', { ids: [w.id] })).json.done, 1);
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM wipe_entries')).row.n, 0);
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM wipes')).row.n, 0);
    // the node stays in the trash; purging it is a matter of the trash
    assert.equal((await portal('DELETE', `trash/${node.id}`)).status, 200);
  });
});

test('a folder deleted everywhere: every live file below it; a restore cancels what is left', async () => {
  await withHost({}, async (host, c) => {
    const phone = c.as(ANNA, 'phone-2');
    const pc = c.as(ANNA, 'pc-2');
    await pc('GET', 'me');
    const mine = await c.area(ANNA, 'mine');
    const f = (await phone('POST', 'nodes', { parentId: mine.rootId, name: 'Urlaub' })).json.node;
    const sub = (await phone('POST', 'nodes', { parentId: f.id, name: 'Tag 1' })).json.node;
    const a = (await c.put(ANNA, f.id, 'a.jpg', 'aa', { mime: 'image/jpeg' })).json.node;
    const b = (await c.put(ANNA, sub.id, 'b.mp4', 'bbb', { mime: 'video/mp4' })).json.node;
    const old = (await c.put(ANNA, sub.id, 'alt.txt', 'old')).json.node;
    await phone('DELETE', `nodes/${old.id}`); // in the trash before: not part of the folder's wipe
    const del = await phone('DELETE', `nodes/${f.id}`, null, { everywhere: 'true' });
    assert.equal(del.status, 200);
    assert.equal(del.json.trashed, 4);
    assert.deepEqual({ devices: del.json.wipe.devices, files: del.json.wipe.files }, { devices: 2, files: 2 });
    const list = (await phone('GET', 'wipes')).json.wipes;
    assert.deepEqual(list.map((x) => [x.nodeId, x.name, x.size, x.mime]), [[a.id, 'a.jpg', 2, 'image/jpeg'], [b.id, 'b.mp4', 3, 'video/mp4']]);
    // the phone handles one, then the folder comes back
    await phone('POST', 'wipes/done', { ids: [list[0].id] });
    assert.equal((await phone('GET', 'me')).json.wipes, 1);
    const back = await phone('POST', `trash/${f.id}/restore`);
    assert.equal(back.status, 200);
    assert.equal((await phone('GET', 'me')).json.wipes, 0);
    assert.equal((await pc('GET', 'me')).json.wipes, 0);
    assert.deepEqual((await pc('GET', 'wipes')).json.wipes, []);
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM wipe_pending')).row.n, 0);
    // restoring an unrelated trashed node does not touch another wipe
    const x = (await c.put(ANNA, mine.rootId, 'x.txt', 'x')).json.node;
    await phone('DELETE', `nodes/${x.id}`, null, { everywhere: 1 });
    await phone('POST', `trash/${old.id}/restore`);
    assert.equal((await pc('GET', 'me')).json.wipes, 1);
  });
});

test('the targets: my devices seen in the last 180 days when the wipe is made; the portal deletes everywhere too', async () => {
  await withHost({}, async (host, c) => {
    const portal = c.portal(ANNA);
    const mine = (await portal('GET', 'me')).json.areas.find((x) => x.kind === 'mine');
    // no device known: nothing to wipe
    const n0 = (await c.call({ ...ANNA, portal: true, loggedIn: true }, 'POST', 'nodes', { parentId: mine.rootId, name: 'D' })).json.node;
    let del = await portal('DELETE', `nodes/${n0.id}`, null, { everywhere: '1' });
    assert.deepEqual(del.json.wipe, { id: null, devices: 0, files: 0 });
    await c.as(ANNA, 'old-tablet')('GET', 'me');
    c.clock.add(181 * DAY);
    await c.as(ANNA, 'phone-2')('GET', 'me');
    await c.as(MARC, 'phone-3')('GET', 'me'); // Marc's devices are never Anna's targets
    const up = (await c.put(ANNA, mine.rootId, 'Brief.pdf', 'pdf', { mime: 'application/pdf' })).json.node;
    // a folder without files: no wipe needed
    const empty = (await portal('POST', 'nodes', { parentId: mine.rootId, name: 'Leer' })).json.node;
    del = await portal('DELETE', `nodes/${empty.id}`, null, { everywhere: '1' });
    assert.deepEqual(del.json.wipe, { id: null, devices: 1, files: 0 });
    // from the portal (no device): Anna's phone, not the tablet unseen for 181 days
    del = await portal('DELETE', `nodes/${up.id}`, null, { everywhere: '1' });
    assert.equal(del.json.wipe.devices, 1);
    assert.equal(del.json.wipe.files, 1);
    assert.equal((await c.as(ANNA, 'phone-2')('GET', 'wipes')).json.wipes.length, 1);
    assert.deepEqual((await c.as(ANNA, 'old-tablet')('GET', 'wipes')).json.wipes, []);
    // a device first seen after the wipe is no target of it
    assert.deepEqual((await c.as(ANNA, 'new-pc')('GET', 'wipes')).json.wipes, []);
    // the device's wipes also without a seat (they only remove the person's own copies)
    await c.admin('PUT', `admin/seats/${ANNA.id}`, { kind: null });
    const r = await c.as(ANNA, 'phone-2')('GET', 'wipes');
    assert.equal(r.status, 200);
    assert.equal(r.json.wipes.length, 1);
    assert.equal((await c.as(ANNA, 'phone-2')('GET', 'areas')).json.code, 'no_seat');
  });
});

test('POST wipes/done checks its ids', async () => {
  await withHost({}, async (host, c) => {
    const phone = c.as(ANNA, 'phone-2');
    for (const body of [null, {}, { ids: 'x' }, { ids: [0] }, { ids: ['a'] }, { ids: [-1] }, { ids: new Array(1001).fill(1) }]) {
      const r = await phone('POST', 'wipes/done', body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
      assert.equal(r.json.code, 'invalid');
    }
    assert.deepEqual((await phone('POST', 'wipes/done', { ids: [] })).json, { ok: true, done: 0, wipes: 0 });
    assert.equal((await phone('POST', 'wipes/done', { ids: ['12'] })).status, 200);
  });
});

test('background: wipes end after 90 days; devices GateControl no longer lists are not waited for', async () => {
  const devices = [{ id: 'phone-2', userId: ANNA.id, platform: 'android' }, { id: 'pc-2', userId: ANNA.id, platform: 'windows' }];
  await withHost({ devices }, async (host, c) => {
    const phone = c.as(ANNA, 'phone-2');
    const pc = c.as(ANNA, 'pc-2');
    await pc('GET', 'me');
    const mine = await c.area(ANNA, 'mine');
    const a = (await c.put(ANNA, mine.rootId, 'a.txt', 'a')).json.node;
    const b = (await c.put(ANNA, mine.rootId, 'b.txt', 'b')).json.node;
    await phone('DELETE', `nodes/${a.id}`, null, { everywhere: '1' });
    c.clock.add(MIN);
    // the PC's token is removed in GateControl
    devices.splice(1, 1);
    await phone('DELETE', `nodes/${b.id}`, null, { everywhere: '1' });
    let t = await host.tick();
    assert.equal(t.wipesDropped, 0); // seen by Drive only just now: still waited for
    c.clock.add(8 * DAY);
    await phone('GET', 'me');
    t = await host.tick();
    assert.equal(t.wipesDropped, 2);
    assert.equal(t.wipesExpired, 0);
    // the phone handles the first: it is gone everywhere now
    const list = (await phone('GET', 'wipes')).json.wipes;
    assert.equal(list.length, 2);
    await phone('POST', 'wipes/done', { ids: [list[0].id] });
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM wipes')).row.n, 1);
    // 90 days: the rest goes
    c.clock.add(83 * DAY);
    t = await host.tick();
    assert.equal(t.wipesExpired, 1);
    assert.equal((await phone('GET', 'me')).json.wipes, 0);
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM wipe_pending')).row.n, 0);
  });
});
