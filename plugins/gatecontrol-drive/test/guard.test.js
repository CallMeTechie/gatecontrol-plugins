'use strict';

// The ransomware protection (1.6.0, server/guard.js): a device that changes many existing files the way ransomware
// does is stopped (423 device_locked, reading stays), an incident with notes and the event 'guard'; undo brings every
// file back, release lets the device write again; rights, idempotence, no false alarms.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ADMIN, ANNA, MARC, MIN } = require('./helpers');
const guard = require('../server/guard');

const portalOf = (u) => ({ ...u, portal: true, loggedIn: true });

/** n files "Datei<i>.txt" in a new folder of Anna's files, uploaded from her phone (another device than the PC). */
async function seed(c, n, folder = 'Dokumente', ext = 'txt') {
  const mine = await c.area(ANNA, 'mine');
  const dir = (await c.as(ANNA)('POST', 'nodes', { parentId: mine.rootId, name: folder })).json.node;
  const files = [];
  for (let i = 1; i <= n; i++) files.push((await c.put(ANNA, dir.id, `Datei${i}.${ext}`, `Inhalt ${i}`)).json.node);
  return { mine, dir, files };
}

test('signs: known ransomware endings, an ending added or turned random, entropy only where bytes are never that dense', () => {
  assert.equal(guard.extSign('Brief.pdf.locked', 'Brief.pdf'), true);
  assert.equal(guard.extSign('Brief.pdf.WNCRY', 'Brief.pdf'), true);
  assert.equal(guard.extSign('Brief.pdf.a8f3k2', 'Brief.pdf'), true);
  assert.equal(guard.extSign('Brief.pdf.id-1234.eking', null), true);
  assert.equal(guard.extSign('Brief.x7k2', 'Brief.pdf'), true);
  assert.equal(guard.extSign('Brief (alt).pdf', 'Brief.pdf'), false, 'a rename keeping the ending');
  assert.equal(guard.extSign('Brief.docx', 'Brief.doc'), false, 'a known ending');
  assert.equal(guard.extSign('Urlaub.jpg', null), false);
  assert.equal(guard.extSign('Notizen', 'Notizen.txt'), false);
  assert.equal(guard.extSign('app.log.1', 'app.log'), false, 'a rotated log');
  assert.equal(guard.entropySign('a.txt', 7.9, null), true);
  assert.equal(guard.entropySign('a.jpg', 7.95, null), false, 'a photo is that dense anyway');
  assert.equal(guard.entropySign('a.docx', 7.9, 5.1), true, 'clearly below before');
  for (const n of ['scan.tif', 'alt.doc', 'plan.dwg', 'teil.stl', 'bild.psd']) assert.equal(guard.entropySign(n, 7.9, null), false, `${n} may hold compressed parts`);
  assert.equal(guard.entropySign('a.txt', 6.2, null), false);
  assert.throws(() => guard.entropyArg(9), /invalid/);
  assert.throws(() => guard.entropyArg('viel'), /invalid/);
  assert.equal(guard.entropyArg('7.25'), 7.25);
  assert.equal(guard.entropyArg(null), null);
});

test('renames to a ransomware ending: the device is stopped (423, reading stays), the incident, notes and events', async () => {
  await withHost({ settings: { guard_files: 10 } }, async (host, c) => {
    const pc = c.as(ANNA, 'tok-pc');
    await pc('PUT', 'devices/pc-1', { name: 'Arbeits-PC', platform: 'windows' });
    const { files } = await seed(c, 12);
    for (let i = 0; i < 9; i++) {
      const r = await pc('PATCH', `nodes/${files[i].id}`, { name: files[i].name + '.locked' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    assert.equal((await pc('GET', 'me')).json.guard.locked, false, 'below the threshold');
    assert.equal((await pc('PATCH', `nodes/${files[9].id}`, { name: files[9].name + '.locked' })).status, 200, 'the request that tips it still went through');
    // stopped
    const no = await pc('PATCH', `nodes/${files[10].id}`, { name: files[10].name + '.locked' });
    assert.equal(no.status, 423);
    assert.equal(no.json.code, 'device_locked');
    assert.equal(no.json.error, 'device_locked');
    assert.ok(Number.isInteger(no.json.incident));
    assert.match(no.json.message, /gestoppt/);
    for (const [m, p, b] of [['DELETE', `nodes/${files[11].id}`], ['POST', 'nodes', { parentId: files[0].parentId, name: 'Neu' }],
      ['POST', 'uploads/commit', { parentId: files[0].parentId, name: 'x.txt', size: 0 }], ['POST', 'links', { nodeId: files[0].id }]]) {
      assert.equal((await pc(m, p, b)).status, 423, `${m} ${p}`);
    }
    // reading, checking an upload, the device's own housekeeping still work
    assert.equal((await pc('GET', `nodes/${files[11].id}`)).status, 200);
    assert.equal((await pc('GET', `nodes/${files[11].id}/content`)).status, 200);
    assert.equal((await pc('POST', 'uploads/check', { parentId: files[0].parentId, name: 'Datei1.txt' })).status, 200);
    assert.equal((await pc('POST', 'wipes/done', { ids: [] })).status, 200);
    // GET me of the PC: locked, the incident; of the phone: not locked, the incident listed
    const me = (await pc('GET', 'me')).json;
    assert.ok(me.features.includes('guard') && me.features.includes('links'));
    assert.equal(me.guard.locked, true);
    const inc = me.guard.incident;
    assert.deepEqual({ id: inc.id, device: inc.device, deviceName: inc.deviceName, files: inc.files, state: inc.state },
      { id: no.json.incident, device: 'tok-pc', deviceName: 'Arbeits-PC', files: 10, state: 'open' });
    assert.equal(inc.at, new Date(c.clock.now()).toISOString());
    assert.equal(inc.sample.length, 5);
    assert.ok(inc.sample.every((s) => s.endsWith('.txt.locked')));
    assert.deepEqual(inc.reasons, ['ext']);
    const phone = (await c.as(ANNA)('GET', 'me')).json;
    assert.deepEqual([phone.guard.locked, phone.guard.incident], [false, null]);
    assert.deepEqual(phone.incidents.map((x) => x.id), [inc.id]);
    assert.equal((await c.as(ANNA)('POST', 'nodes', { parentId: files[0].parentId, name: 'Vom Handy' })).status, 200, 'other devices write on');
    // the person and the administrators are told, with the direct link button; the event 'guard'
    const notes = c.pushes().filter((n) => n.topic === 'guard');
    assert.equal(notes.length, 2);
    const mine = notes.find((n) => n.users.includes(ANNA.id));
    assert.deepEqual(mine.users, [ANNA.id]);
    assert.equal(mine.title, 'Drive hat ungewöhnliche Änderungen von Arbeits-PC gestoppt');
    assert.match(mine.body, /^10 Dateien in wenigen Minuten verändert, z\. B\. Datei\d+\.txt\.locked/);
    assert.equal(mine.data.drive.incident, inc.id);
    assert.equal(mine.data.actions[0].type, 'open_portal');
    assert.equal(mine.data.actions[0].target, '/portal#plg-gatecontrol-drive');
    const adm = notes.find((n) => n.users.includes(ADMIN.id));
    assert.equal(adm.title, 'Drive hat ungewöhnliche Änderungen von Arbeits-PC (Anna) gestoppt');
    const ev = c.events().filter((e) => e.type === 'guard');
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0].users.sort(), [ADMIN.id, ANNA.id].sort());
    assert.equal(ev[0].data.incident.id, inc.id);
    // the details
    const d = (await c.as(ANNA)('GET', `guard/incidents/${inc.id}`)).json;
    assert.equal(d.entries.length, 10);
    assert.deepEqual(d.entries[0], { op: 'rename', name: 'Datei1.txt.locked', oldName: 'Datei1.txt', nodeId: files[0].id, at: inc.at, flags: ['ext'] });
  });
});

test('undo: names, contents and folders back, the incident\'s new files into the trash, deleted ones back — idempotent', async () => {
  await withHost({ settings: { guard_files: 6 } }, async (host, c) => {
    const pc = c.as(ANNA, 'tok-pc');
    const { dir, files } = await seed(c, 8);
    const sub = (await c.as(ANNA)('POST', 'nodes', { parentId: dir.id, name: 'Archiv' })).json.node;
    // 1. three files encrypted in place (entropy) and renamed; one moved away
    for (let i = 0; i < 3; i++) {
      const up = await c.upload(ANNA, `verschlüsselt ${i}`);
      assert.equal((await pc('POST', 'uploads/commit', { mediaId: up, parentId: dir.id, name: files[i].name, onConflict: 'version', entropy: 7.98 })).status, 200);
      assert.equal((await pc('PATCH', `nodes/${files[i].id}`, { name: files[i].name + '.crypt' })).status, 200);
    }
    assert.equal((await pc('PATCH', `nodes/${files[3].id}`, { name: 'Datei4.txt.crypt', parentId: sub.id })).status, 200);
    // 2. an encrypted copy, then the original deleted (swap)
    for (let i = 4; i < 7; i++) {
      assert.equal((await c.put(ANNA, dir.id, files[i].name + '.x9q7z2', `kopie ${i}`)).status, 200); // from the phone: not this device
      const up = await c.upload(ANNA, `kopie ${i}`);
      // the sixth file changed tipped it: the seventh copy and delete are refused
      const made = await pc('POST', 'uploads/commit', { mediaId: up, parentId: dir.id, name: files[i].name + '.x7k2q9' });
      assert.equal(made.status, i < 6 ? 200 : 423);
      assert.equal((await pc('DELETE', `nodes/${files[i].id}`)).status, i < 6 ? 200 : 423);
    }
    const me = (await pc('GET', 'me')).json;
    assert.equal(me.guard.locked, true, JSON.stringify(me.guard));
    const id = me.guard.incident.id;
    assert.deepEqual(me.guard.incident.reasons.sort(), ['entropy', 'ext', 'swap']);
    // not someone else's: Marc gets not_found
    assert.equal((await c.as(MARC)('POST', `guard/incidents/${id}/undo`)).status, 404);
    assert.equal((await c.as(MARC)('GET', `guard/incidents/${id}`)).status, 404);
    // undo (from the portal)
    const r = await c.portal(ANNA)('POST', `guard/incidents/${id}/undo`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.incident.state, 'undone');
    assert.equal(r.json.restored, 6, JSON.stringify(r.json));
    assert.equal(r.json.trashed, 2, 'the encrypted copies of the files deleted (the third delete never happened)');
    assert.equal(r.json.failed, 0);
    const a = c.as(ANNA);
    const kids = (await a('GET', `nodes/${dir.id}/children`)).json.items.map((x) => x.name).sort();
    assert.deepEqual(kids, ['Archiv', 'Datei1.txt', 'Datei2.txt', 'Datei3.txt', 'Datei4.txt', 'Datei5.txt', 'Datei5.txt.x9q7z2', 'Datei6.txt', 'Datei6.txt.x9q7z2',
      'Datei7.txt', 'Datei7.txt.x9q7z2', 'Datei8.txt'].sort(), 'the phone\'s copies and what the device made after the lock stay');
    // the bytes before
    for (let i = 0; i < 3; i++) {
      const got = (await a('GET', `nodes/${files[i].id}/content`)).json;
      assert.equal(String((await host.mediaFromUrl(got.url)).body), `Inhalt ${i + 1}`);
    }
    assert.equal((await a('GET', `nodes/${files[3].id}`)).json.node.parentId, dir.id, 'back in its folder');
    // the device may write again; the same answer again
    assert.equal((await pc('GET', 'me')).json.guard.locked, false);
    assert.equal((await pc('POST', 'nodes', { parentId: dir.id, name: 'Wieder da' })).status, 200);
    const again = await c.portal(ANNA)('POST', `guard/incidents/${id}/undo`);
    assert.deepEqual({ ...again.json, incident: again.json.incident.id }, { ok: true, incident: id, restored: 6, trashed: 2, failed: 0 });
    const rel = await c.portal(ANNA)('POST', `guard/incidents/${id}/release`);
    assert.equal(rel.json.incident.state, 'undone');
    assert.ok(c.events().filter((e) => e.type === 'guard').some((e) => e.data.incident.state === 'undone'));
  });
});

test('release: a false alarm — the device writes again, idempotent; an administrator in the portal and the admin UI', async () => {
  await withHost({ settings: { guard_files: 5 } }, async (host, c) => {
    const pc = c.as(ANNA, 'tok-pc');
    const { files } = await seed(c, 6);
    for (let i = 0; i < 5; i++) await pc('PATCH', `nodes/${files[i].id}`, { name: files[i].name + '.enc' });
    const id = (await pc('GET', 'me')).json.guard.incident.id;
    // an administrator (no seat of their own) sees everyone's incidents in the portal
    const adm = (m, p, b, q) => c.call(portalOf(ADMIN), m, p, b, q);
    const all = await adm('GET', 'guard/incidents', null, { all: '1' });
    assert.equal(all.status, 200, JSON.stringify(all.json));
    assert.deepEqual(all.json.incidents.map((x) => [x.id, x.userName, x.state]), [[id, 'Anna', 'open']]);
    assert.equal(all.json.admin, true);
    assert.deepEqual((await c.as(MARC)('GET', 'guard/incidents', null, { all: '1' })).json.incidents, [], 'not an administrator: only their own');
    // the admin UI
    const ui = await c.admin('GET', 'admin/guard/incidents');
    assert.equal(ui.status, 200);
    assert.equal(ui.json.incidents[0].id, id);
    const rel = await c.admin('POST', `admin/guard/incidents/${id}/release`);
    assert.equal(rel.status, 200, JSON.stringify(rel.json));
    assert.deepEqual([rel.json.incident.state, rel.json.incident.endedBy, rel.json.restored, rel.json.trashed], ['released', ADMIN.id, 0, 0]);
    assert.equal((await adm('POST', `guard/incidents/${id}/release`)).json.incident.state, 'released', 'again: the same');
    assert.equal((await pc('GET', 'me')).json.guard.locked, false);
    assert.deepEqual((await pc('GET', 'me')).json.incidents, []);
    assert.equal((await pc('PATCH', `nodes/${files[5].id}`, { name: 'Datei6 neu.txt' })).status, 200);
    // what the incident held does not count again; new signs make a new incident
    for (let i = 0; i < 5; i++) await pc('PATCH', `nodes/${files[i].id}`, { name: files[i].name + '.v2.enc' });
    const me = (await pc('GET', 'me')).json;
    assert.equal(me.guard.locked, true);
    assert.notEqual(me.guard.incident.id, id);
    // an undo after a release still works (and releases nothing more)
    const u = await adm('POST', `guard/incidents/${me.guard.incident.id}/undo`);
    assert.equal(u.status, 200, JSON.stringify(u.json));
    assert.equal(u.json.restored, 5);
    assert.equal((await c.as(ANNA)('GET', `nodes/${files[0].id}`)).json.node.name, 'Datei1.txt.enc', 'back to the name before this incident');
  });
});

test('no false alarm: many new photos, edited photos, deleting many, the portal, the protection switched off', async () => {
  await withHost({ settings: { guard_files: 10 } }, async (host, c) => {
    const pc = c.as(ANNA, 'tok-pc');
    const mine = await c.area(ANNA, 'mine');
    const dir = (await pc('POST', 'nodes', { parentId: mine.rootId, name: 'Fotos' })).json.node;
    // 40 new photos, dense as photos are: new files never count
    const photos = [];
    for (let i = 1; i <= 40; i++) {
      const up = await c.upload(ANNA, `jpeg ${i}`, 'image/jpeg');
      const r = await pc('POST', 'uploads/commit', { mediaId: up, parentId: dir.id, name: `IMG_${1000 + i}.jpg`, entropy: 7.97 });
      assert.equal(r.status, 200);
      photos.push(r.json.node);
    }
    // 20 of them edited (new versions, still photos), 12 renamed keeping the ending, 12 deleted
    for (let i = 0; i < 20; i++) {
      const up = await c.upload(ANNA, `jpeg edited ${i}`, 'image/jpeg');
      assert.equal((await pc('POST', 'uploads/commit', { mediaId: up, parentId: dir.id, name: photos[i].name, onConflict: 'version', entropy: 7.96 })).status, 200);
    }
    for (let i = 20; i < 32; i++) assert.equal((await pc('PATCH', `nodes/${photos[i].id}`, { name: `Urlaub ${i}.jpg` })).status, 200);
    for (let i = 32; i < 40; i++) assert.equal((await pc('DELETE', `nodes/${photos[i].id}`)).status, 200);
    assert.equal((await pc('GET', 'me')).json.guard.locked, false);
    // the portal is no device: renaming there is never watched
    const p = c.portal(ANNA);
    for (let i = 0; i < 12; i++) assert.equal((await p('PATCH', `nodes/${photos[i].id}`, { name: `IMG_${1000 + i + 1}.jpg.locked` })).status, 200);
    assert.deepEqual((await p('GET', 'guard/incidents')).json.incidents, []);
    assert.equal(c.pushes().filter((n) => n.topic === 'guard').length, 0);
    // signs spread over more than the window: no incident
    c.clock.add(11 * MIN);
    const docs = (await seed(c, 12, 'Texte')).files;
    for (let i = 0; i < 6; i++) await pc('PATCH', `nodes/${docs[i].id}`, { name: docs[i].name + '.locked' });
    c.clock.add(11 * MIN);
    for (let i = 6; i < 12; i++) await pc('PATCH', `nodes/${docs[i].id}`, { name: docs[i].name + '.locked' });
    assert.equal((await pc('GET', 'me')).json.guard.locked, false);
  });
  // switched off: nothing is watched, nothing locked
  await withHost({ settings: { guard_files: 5, guard_on: false } }, async (host, c) => {
    const pc = c.as(ANNA, 'tok-pc');
    const { files } = await seed(c, 8);
    for (const f of files) assert.equal((await pc('PATCH', `nodes/${f.id}`, { name: f.name + '.locked' })).status, 200);
    const me = (await pc('GET', 'me')).json;
    assert.deepEqual([me.guard.on, me.guard.locked, me.incidents.length], [false, false, 0]);
  });
});

test('the default thresholds: 20 % of an area with at least 20 files (and at least 5 of them)', async () => {
  await withHost({}, async (host, c) => {
    const pc = c.as(ANNA, 'tok-pc');
    const { files } = await seed(c, 20);
    for (let i = 0; i < 4; i++) await pc('PATCH', `nodes/${files[i].id}`, { name: files[i].name + '.wncry' });
    assert.equal((await pc('GET', 'me')).json.guard.locked, false, '4 files: below the floor of 5');
    await pc('PATCH', `nodes/${files[4].id}`, { name: files[4].name + '.wncry' });
    const me = (await pc('GET', 'me')).json;
    assert.equal(me.guard.locked, true);
    assert.equal(me.guard.incident.files, 5);
  });
});

test('the journal is kept short; closed incidents go after 30 days; a version an open incident needs is kept', async () => {
  await withHost({ settings: { guard_files: 5, versions_max: 1 } }, async (host, c) => {
    const pc = c.as(ANNA, 'tok-pc');
    const { dir, files } = await seed(c, 6);
    for (let i = 0; i < 5; i++) {
      const up = await c.upload(ANNA, `x${i}`);
      await pc('POST', 'uploads/commit', { mediaId: up, parentId: dir.id, name: files[i].name, onConflict: 'version', entropy: 7.9 });
    }
    const id = (await pc('GET', 'me')).json.guard.incident.id;
    // another device overwrites a file of the incident again: the version before the incident stays (versions_max 1)
    const up = await c.upload(ANNA, 'vom Handy');
    await c.as(ANNA)('POST', 'uploads/commit', { mediaId: up, parentId: dir.id, name: files[0].name, onConflict: 'version' });
    const vs = (await c.as(ANNA)('GET', `nodes/${files[0].id}/versions`)).json.versions;
    assert.equal(vs.length, 2);
    c.clock.add(2 * 86400000);
    await host.tick();
    const r = await c.portal(ANNA)('POST', `guard/incidents/${id}/undo`);
    assert.equal(r.json.restored, 5);
    const got = (await c.as(ANNA)('GET', `nodes/${files[0].id}/content`)).json;
    assert.equal(String((await host.mediaFromUrl(got.url)).body), 'Inhalt 1');
    c.clock.add(31 * 86400000);
    assert.equal((await host.tick()).incidentsRemoved, 1);
    assert.equal((await c.portal(ANNA)('GET', `guard/incidents/${id}`)).status, 404);
  });
});

test('a backup app\'s pattern: encrypted copies uploaded, the originals marked "deleted on the PC" — stopped, undo ends the marks', async () => {
  await withHost({ settings: { guard_files: 5 } }, async (host, c) => {
    const pc = c.as(ANNA, 'tok-pc');
    await pc('PUT', 'devices/pc-1', { name: 'PC' });
    const { dir, files } = await seed(c, 6);
    for (let i = 0; i < 5; i++) {
      const up = await c.upload(ANNA, `enc ${i}`);
      assert.equal((await pc('POST', 'uploads/commit', { mediaId: up, parentId: dir.id, name: files[i].name + '.akira' })).status, 200);
      assert.equal((await pc('DELETE', `nodes/${files[i].id}`, null, { after: String(30 * 86400) })).status, 200);
    }
    const me = (await pc('GET', 'me')).json;
    assert.equal(me.guard.locked, true);
    assert.deepEqual(me.guard.incident.reasons.sort(), ['ext', 'swap']);
    assert.equal((await pc('DELETE', `nodes/${files[5].id}`, null, { after: '60' })).status, 423, 'marking is writing too');
    const r = await c.portal(ANNA)('POST', `guard/incidents/${me.guard.incident.id}/undo`);
    assert.deepEqual([r.json.restored, r.json.trashed, r.json.failed], [5, 5, 0]);
    const kids = (await c.as(ANNA)('GET', `nodes/${dir.id}/children`)).json.items;
    assert.deepEqual(kids.map((x) => x.name).sort(), files.map((f) => f.name).sort());
    assert.ok(kids.every((x) => x.deleteAt === undefined), 'no mark left');
  });
});
