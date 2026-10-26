'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ADMIN, ANNA, MARC, LENA, OMA, BOB, FAMILY, OFFICE, DAY } = require('./helpers');

const kinds = (r) => r.json.areas.map((a) => `${a.kind}:${a.role}`).sort();

test('people switched on see their areas; others only GET me', async () => {
  await withHost({}, async (host, c) => {
    const anna = await c.as(ANNA)('GET', 'me');
    assert.equal(anna.status, 200);
    assert.equal(anna.json.me.seat, 'family');
    assert.deepEqual(kinds(anna), ['child:read', 'family:write', 'mine:manage']);
    const mine = anna.json.areas.find((a) => a.kind === 'mine');
    assert.equal(mine.label, 'Meine Dateien');
    assert.equal(anna.json.areas.find((a) => a.kind === 'child').label, 'Kinder · Lena');
    assert.equal(anna.json.areas.find((a) => a.kind === 'family').label, 'Familie Berg');

    const lena = await c.as(LENA)('GET', 'me');
    assert.deepEqual(kinds(lena), ['child:manage', 'family:write', 'mine:manage']);

    const bob = await c.as(BOB)('GET', 'me');
    assert.deepEqual(kinds(bob), ['mine:manage']);

    // Oma is not switched on: GET me answers, everything else is no_seat
    const oma = await c.as(OMA)('GET', 'me');
    assert.equal(oma.status, 200);
    assert.equal(oma.json.me.seat, null);
    assert.deepEqual(oma.json.areas, []);
    const no = await c.as(OMA)('GET', 'areas');
    assert.equal(no.status, 403);
    assert.equal(no.json.code, 'no_seat');

    // every area has its own media area, labelled for the administrator
    assert.equal(host.mediaAreas.get('u2').label, 'Meine Dateien · Anna');
    assert.ok(host.mediaAreas.has(`f${FAMILY}`));
    assert.equal(host.mediaAreas.get('c4').label, 'Kinder · Lena');
    // the default quota of my files: 50 GB
    assert.equal(host.mediaAreas.get('u2').quota, 50 * 1024 ** 3);
  });
});

test('english labels, storage in GET areas', async () => {
  await withHost({ lang: 'en' }, async (host, c) => {
    const r = await c.as(ANNA)('GET', 'areas');
    assert.equal(r.status, 200);
    const mine = r.json.areas.find((a) => a.kind === 'mine');
    assert.equal(mine.label, 'My files');
    assert.equal(r.json.areas.find((a) => a.kind === 'child').label, 'Kids · Lena');
    assert.equal(mine.storage.bytes, 0);
    assert.equal(mine.storage.quota, 50 * 1024 ** 3);
  });
});

test('a family person without a family seat: no family areas; a child without a seat: no child area', async () => {
  await withHost({ seats: { [ANNA.id]: 'family', [MARC.id]: 'business' } }, async (host, c) => {
    assert.deepEqual(kinds(await c.as(ANNA)('GET', 'me')), ['family:write', 'mine:manage']);
    assert.deepEqual(kinds(await c.as(MARC)('GET', 'me')), ['mine:manage']);
  });
});

test('parents look into a child folder only while the setting is on; the child is told once a day', async () => {
  await withHost({}, async (host, c) => {
    const lenaArea = await c.area(LENA, 'child');
    const put = await c.put(LENA, lenaArea.rootId, 'Tagebuch.txt', 'geheim');
    assert.equal(put.status, 200);
    // Anna reads the list: Lena gets a note
    const list = await c.as(ANNA)('GET', `nodes/${lenaArea.rootId}/children`);
    assert.equal(list.status, 200);
    assert.equal(list.json.items.length, 1);
    assert.equal(list.json.role, 'read');
    let notes = c.pushes().filter((n) => n.topic === 'child_view');
    assert.equal(notes.length, 1);
    assert.deepEqual(notes[0].users, [LENA.id]);
    assert.equal(notes[0].title, 'Anna hat in deinen Ordner gesehen');
    // again the same day: no new note; Marc: a note of his own
    await c.as(ANNA)('GET', `nodes/${put.json.node.id}/content`);
    await c.as(MARC)('GET', `nodes/${lenaArea.rootId}/children`);
    notes = c.pushes().filter((n) => n.topic === 'child_view');
    assert.equal(notes.length, 2);
    // the next day: again
    c.clock.add(DAY);
    await c.as(ANNA)('GET', `nodes/${lenaArea.rootId}/children`);
    assert.equal(c.pushes().filter((n) => n.topic === 'child_view').length, 3);
    // Lena herself: no note
    await c.as(LENA)('GET', `nodes/${lenaArea.rootId}/children`);
    assert.equal(c.pushes().filter((n) => n.topic === 'child_view').length, 3);
    // parents may not write
    const w = await c.put(ANNA, lenaArea.rootId, 'Von Mama.txt', 'x');
    assert.equal(w.status, 403);
    assert.equal(w.json.code, 'forbidden');
  });
  await withHost({ settings: { child_parents_view: false } }, async (host, c) => {
    assert.deepEqual(kinds(await c.as(ANNA)('GET', 'me')), ['family:write', 'mine:manage']);
    const lenaArea = await c.area(LENA, 'child');
    const r = await c.as(ANNA)('GET', `nodes/${lenaArea.rootId}/children`);
    assert.equal(r.status, 404);
  });
});

test('other people\'s areas are not found', async () => {
  await withHost({}, async (host, c) => {
    const marc = await c.area(MARC, 'mine');
    const r = await c.as(ANNA)('GET', `nodes/${marc.rootId}`);
    assert.equal(r.status, 404);
    const p = await c.as(ANNA)('GET', 'nodes/by-path', null, { area: marc.id, path: '' });
    assert.equal(p.status, 404);
    const bob = await c.as(BOB)('GET', 'nodes/by-path', null, { area: `family:${FAMILY}`, path: '' });
    assert.equal(bob.status, 404);
  });
});

test('team folders: people and groups with roles, business seats only', async () => {
  await withHost({}, async (host, c) => {
    const t = await c.admin('POST', 'admin/teams', { label: 'Projekte', members: [{ principal: `g:${OFFICE}`, role: 'write' }, { principal: `u:${MARC.id}`, role: 'read' }] });
    assert.equal(t.status, 200);
    assert.equal(t.json.team.id, 'team:1');
    assert.ok(host.mediaAreas.has('t1'));
    // Bob (business, in Büro) writes; Anna is in Büro but has a family seat: no team folders
    assert.deepEqual(kinds(await c.as(BOB)('GET', 'me')), ['mine:manage', 'team:write']);
    assert.deepEqual(kinds(await c.as(ANNA)('GET', 'me')), ['child:read', 'family:write', 'mine:manage']);
    const team = await c.area(BOB, 'team');
    assert.equal(team.label, 'Projekte');
    assert.equal((await c.put(BOB, team.rootId, 'Plan.txt', 'v1')).status, 200);
    // the admin makes Bob read-only
    const u = await c.admin('PUT', 'admin/teams/team:1', { members: [{ principal: `u:${BOB.id}`, role: 'read' }] });
    assert.equal(u.status, 200);
    const w = await c.put(BOB, team.rootId, 'Plan2.txt', 'v1');
    assert.equal(w.status, 403);
    // a folder with files is not removed; archived it is read only
    const del = await c.admin('DELETE', 'admin/teams/team:1');
    assert.equal(del.status, 409);
    assert.equal(del.json.code, 'not_empty');
    await c.admin('PUT', 'admin/teams/team:1', { archived: true });
    assert.deepEqual(kinds(await c.as(BOB)('GET', 'me')), ['mine:manage']);
    // an empty team folder goes
    const e = await c.admin('POST', 'admin/teams', { label: 'Leer', members: [] });
    assert.equal((await c.admin('DELETE', `admin/teams/${e.json.team.id}`)).status, 200);
    assert.ok(!host.mediaAreas.has('t2'));
    // bad input
    assert.equal((await c.admin('POST', 'admin/teams', { label: '', members: [] })).status, 400);
    assert.equal((await c.admin('POST', 'admin/teams', { label: 'X', members: [{ principal: 'x:1', role: 'read' }] })).status, 400);
  });
});

test('admin routes: only administrators in the admin UI', async () => {
  await withHost({}, async (host, c) => {
    const r = await c.call({ ...ANNA }, 'GET', 'admin/overview');
    assert.equal(r.status, 403);
    const p = await c.call({ ...ADMIN, portal: true, loggedIn: true }, 'GET', 'admin/overview');
    assert.equal(p.status, 403);
    const o = await c.admin('GET', 'admin/overview');
    assert.equal(o.status, 200);
    assert.equal(o.json.overview.licence.tier, 'combo');
    assert.deepEqual(o.json.overview.counts, { family: 3, business: 1, total: 4 });
    assert.equal(o.json.overview.people.find((p2) => p2.id === BOB.id).seat, 'business');
  });
});

test('kiosk devices and signed-out portal viewers are refused', async () => {
  await withHost({}, async (host, c) => {
    const k = await c.call({ ...ANNA, portal: true, loggedIn: true, kiosk: true }, 'GET', 'me');
    assert.equal(k.status, 403);
    const s = await c.portal(ANNA, false)('GET', 'me');
    assert.equal(s.status, 403);
    assert.equal(s.json.code, 'login_required');
    const pv = await c.portal(ANNA)('GET', 'portal/me');
    assert.equal(pv.status, 200);
    assert.equal(await host.portalVisible(ANNA), true);
    assert.equal(await host.portalVisible(OMA), false);
  });
});
