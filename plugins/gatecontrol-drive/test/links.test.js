'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, BOB, FAMILY, DAY } = require('./helpers');

test('a file link and a folder link: what GateControl gets, the list, the log, the end', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const fam = await c.area(ANNA, 'family');
    const d = await a('POST', 'nodes', { parentId: fam.rootId, name: 'Herbstferien 2026' });
    const f = await c.put(ANNA, d.json.node.id, 'Strand.jpg', 'jpeg', { mime: 'image/jpeg' });
    // a folder, view only, 7 days, with a PIN
    const l1 = await a('POST', 'links', { nodeId: d.json.node.id, mode: 'view', expires: '7d', pin: '4817' });
    assert.equal(l1.status, 200, JSON.stringify(l1.json));
    assert.match(l1.json.link.url, /^https:\/\/gc\.example\.com\/s\/[A-Za-z0-9_-]{24}$/);
    assert.deepEqual([l1.json.link.kind, l1.json.link.mode, l1.json.link.pin, l1.json.link.active], ['folder', 'view', true, true]);
    const g1 = host.publicLinks.get(l1.json.link.token);
    assert.deepEqual([g1.kind, g1.mode, g1.area, g1.path, g1.title, g1.ownerUserId], ['folder', 'view', `f${FAMILY}`, 'Herbstferien 2026', 'Herbstferien 2026', ANNA.id]);
    assert.equal(g1.expiresAt, c.clock.now() + 7 * DAY);
    // a file, download, 1 day
    const l2 = await a('POST', 'links', { nodeId: f.json.node.id, mode: 'download', expires: '1d' });
    assert.equal(l2.json.link.kind, 'files');
    assert.equal(host.publicLinks.get(l2.json.link.token).files[0].mediaId, f.json.node.mediaId);
    // an upload link only for a folder
    assert.equal((await a('POST', 'links', { nodeId: f.json.node.id, mode: 'upload' })).status, 400);
    // bad input
    assert.equal((await a('POST', 'links', { nodeId: d.json.node.id, expires: '2d' })).status, 400);
    assert.equal((await a('POST', 'links', { nodeId: d.json.node.id, pin: '12' })).status, 400);
    // without an end only while the administrator allows it
    const never = await a('POST', 'links', { nodeId: d.json.node.id, expires: 'never' });
    assert.equal(never.status, 403);
    assert.equal(never.json.code, 'no_unlimited');
    // the list: mine, and those of a node
    const mine = await a('GET', 'links');
    assert.equal(mine.json.enabled, true);
    assert.deepEqual(mine.json.links.map((l) => l.kind).sort(), ['files', 'folder']);
    const ofNode = await c.as(MARC)('GET', 'links', null, { nodeId: d.json.node.id });
    assert.equal(ofNode.json.links.length, 1, 'Marc writes in the family: he sees the folder\'s links');
    // Marc may not end Anna's link (the family area: write, not manage), Bob does not even see the folder
    assert.equal((await c.as(MARC)('DELETE', `links/${l1.json.link.token}`)).status, 404);
    assert.equal((await c.as(BOB)('GET', 'links', null, { nodeId: d.json.node.id })).status, 404);
    // the log
    await host.publicLinkDownload(l2.json.link.token, { file: 1 });
    const ev = await a('GET', `links/${l1.json.link.token}/events`);
    assert.equal(ev.status, 200);
    assert.deepEqual(ev.json.events, []);
    // the end
    const end = await a('DELETE', `links/${l1.json.link.token}`);
    assert.deepEqual(end.json, { ok: true, ended: true });
    assert.equal(host.publicLinks.get(l1.json.link.token).revoked, true);
    const after = await a('GET', 'links');
    const ended = after.json.links.find((l) => l.token === l1.json.link.token);
    assert.equal(ended.active, false);
    assert.equal(after.json.links.find((l) => l.token === l2.json.link.token).downloads, 1);
  });
});

test('who may share: write in the area; a parent looking into a child folder may not', async () => {
  await withHost({}, async (host, c) => {
    const lenaArea = await c.area(LENA, 'child');
    const f = await c.put(LENA, lenaArea.rootId, 'Bild.png', 'png', { mime: 'image/png' });
    assert.equal((await c.as(ANNA)('POST', 'links', { nodeId: f.json.node.id })).status, 403);
    assert.equal((await c.as(LENA)('POST', 'links', { nodeId: f.json.node.id })).status, 200);
    // the root of an area: its title is the area's name
    const mine = await c.area(ANNA, 'mine');
    const r = await c.as(ANNA)('POST', 'links', { nodeId: mine.rootId, mode: 'upload', expires: '30d' });
    assert.equal(r.status, 200);
    assert.equal(host.publicLinks.get(r.json.link.token).title, 'Meine Dateien');
    assert.equal(host.publicLinks.get(r.json.link.token).path, '');
  });
});

test('links switched off by the administrator, links without an end allowed', async () => {
  await withHost({ links: false }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const r = await c.as(ANNA)('POST', 'links', { nodeId: mine.rootId });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'links_disabled');
    const l = await c.as(ANNA)('GET', 'links');
    assert.deepEqual(l.json, { ok: true, links: [], enabled: true });
  });
  await withHost({ unlimited: true }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const r = await c.as(ANNA)('POST', 'links', { nodeId: mine.rootId, expires: 'never' });
    assert.equal(r.status, 200);
    assert.equal(r.json.link.expiresAt, null);
    assert.equal(host.publicLinks.get(r.json.link.token).expiresAt, null);
  });
});

test('a folder renamed, moved or trashed ends its links; a file in the trash ends its links; a moved file keeps them', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const top = await a('POST', 'nodes', { parentId: mine.rootId, name: 'Fotos' });
    const sub = await a('POST', 'nodes', { parentId: top.json.node.id, name: '2026' });
    const other = await a('POST', 'nodes', { parentId: mine.rootId, name: 'Andere' });
    const f = await c.put(ANNA, sub.json.node.id, 'a.jpg', 'x', { mime: 'image/jpeg' });
    const lTop = (await a('POST', 'links', { nodeId: top.json.node.id })).json.link.token;
    const lSub = (await a('POST', 'links', { nodeId: sub.json.node.id, mode: 'upload' })).json.link.token;
    const lOther = (await a('POST', 'links', { nodeId: other.json.node.id })).json.link.token;
    const lFile = (await a('POST', 'links', { nodeId: f.json.node.id })).json.link.token;
    // renaming the top folder: its links and those of the folders below end; the file link stays
    assert.equal((await a('PATCH', `nodes/${top.json.node.id}`, { name: 'Bilder' })).status, 200);
    assert.equal(host.publicLinks.get(lTop).revoked, true);
    assert.equal(host.publicLinks.get(lSub).revoked, true);
    assert.equal(host.publicLinks.get(lFile).revoked, false);
    assert.equal(host.publicLinks.get(lOther).revoked, false);
    const list = (await a('GET', 'links')).json.links;
    assert.equal(list.find((l) => l.token === lTop).endedWhy, 'moved');
    // moving the file: its link stays (it shares the file, not a path)
    assert.equal((await a('PATCH', `nodes/${f.json.node.id}`, { parentId: other.json.node.id })).status, 200);
    assert.equal(host.publicLinks.get(lFile).revoked, false);
    // a failed rename (the name exists) ends nothing
    await a('POST', 'nodes', { parentId: mine.rootId, name: 'Belegt' });
    assert.equal((await a('PATCH', `nodes/${other.json.node.id}`, { name: 'Belegt' })).status, 409);
    assert.equal(host.publicLinks.get(lOther).revoked, false);
    // the folder into the trash: its link and the file link inside end
    assert.equal((await a('DELETE', `nodes/${other.json.node.id}`)).status, 200);
    assert.equal(host.publicLinks.get(lOther).revoked, true);
    assert.equal(host.publicLinks.get(lFile).revoked, true);
    assert.equal((await a('GET', 'links')).json.links.find((l) => l.token === lFile).endedWhy, 'trashed');
  });
});

test('upload links: a visitor\'s file lands in the tree, the owner is told, the readers get the event; the background run catches up', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const fam = await c.area(ANNA, 'family');
    const inbox = await a('POST', 'nodes', { parentId: fam.rootId, name: 'Eingang' });
    const l = (await a('POST', 'links', { nodeId: inbox.json.node.id, mode: 'upload', expires: '7d' })).json.link;
    assert.equal(l.kind, 'upload');
    const up = await host.publicLinkUpload(l.token, { name: 'Rechnung.pdf', data: '%PDF-1', mime: 'application/pdf', by: 'Opa Karl' });
    assert.equal(up.status, 200);
    const n = await c.as(MARC)('GET', 'nodes/by-path', null, { area: fam.id, path: 'Eingang/Rechnung.pdf' });
    assert.equal(n.status, 200);
    assert.equal(n.json.node.createdBy, ANNA.id);
    const ch = await c.as(MARC)('GET', 'changes', null, { since: 0 });
    assert.ok(ch.json.changes.some((x) => x.device === 'link' && x.nodeId === n.json.node.id));
    const note = c.pushes().filter((x) => x.topic === 'link_upload');
    assert.equal(note.length, 1);
    assert.deepEqual(note[0].users, [ANNA.id]);
    assert.equal(note[0].title, '„Rechnung.pdf“ ist über deinen Link angekommen');
    assert.equal(note[0].body, 'Opa Karl · in „Eingang“');
    assert.ok(c.events().some((e) => e.type === 'changed' && e.users.includes(MARC.id) && e.data.areas.includes(fam.id)));
    // the same name again: GateControl gives it " (2)"
    await host.publicLinkUpload(l.token, { name: 'Rechnung.pdf', data: '%PDF-2', mime: 'application/pdf' });
    assert.equal((await c.as(MARC)('GET', 'nodes/by-path', null, { area: fam.id, path: 'Eingang/Rechnung (2).pdf' })).status, 200);
    // a missed hook: the background run brings it
    const hook = host.plugin.publicLinkEvent;
    host.plugin.publicLinkEvent = undefined;
    await host.publicLinkUpload(l.token, { name: 'Foto.jpg', data: 'jpg', mime: 'image/jpeg' });
    host.plugin.publicLinkEvent = hook;
    assert.equal((await c.as(MARC)('GET', 'nodes/by-path', null, { area: fam.id, path: 'Eingang/Foto.jpg' })).status, 404);
    await host.tick();
    assert.equal((await c.as(MARC)('GET', 'nodes/by-path', null, { area: fam.id, path: 'Eingang/Foto.jpg' })).status, 200);
    // the link's upload counts
    const listed = (await a('GET', 'links')).json.links.find((x) => x.token === l.token);
    assert.equal(listed.upload.files, 3);
  });
});
