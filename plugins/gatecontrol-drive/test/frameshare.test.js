'use strict';

// "Für Fotorahmen freigeben" (1.31.0, server/frameshare.js): the apps share single photos for the photo frame — into the
// person's own frame album (made on the first share, `frame: true`); only pictures one reads, nothing of a vault, a
// child's folder or held back by the virus scan; a child shares nothing. GET frame from an app device (the GateControl
// TV): the frame of what that person reads — never another person's private photos. The kiosk device as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, OMA } = require('./helpers');

const KIOSK = { ...OMA, portal: true, loggedIn: true, kiosk: true };
const TV = 'tv-' + ANNA.id;
const tvOf = (c, u, device = 'tv-' + u.id) => (m, p, b, q) => c.call({ ...u, portal: true, loggedIn: true, app: true, device: { id: device, platform: 'android-tv' } }, m, p, b, q);

async function pic(c, user, area, name, day, mime = 'image/jpeg') {
  return (await c.put(user, area.rootId, name, `${name}-bytes`, { mime, takenAt: Date.UTC(2026, 3, day) })).json.node;
}

test('share for the frame: the own frame album is made, only pictures, skipped with a reason, ask, remove', async () => {
  let next = { state: 'clean' };
  await withHost({ gatecontrol: '1.210.0', scan: () => next }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const fam = await c.area(ANNA, 'family');
    const child = await c.area(LENA, 'child');
    const p1 = await pic(c, ANNA, mine, 'Strand.jpg', 1);
    const p2 = await pic(c, ANNA, fam, 'Fest.jpg', 2);
    const vid = await pic(c, ANNA, mine, 'Film.mp4', 3, 'video/mp4');
    const doc = await pic(c, ANNA, mine, 'Brief.pdf', 4, 'application/pdf');
    const kid = await pic(c, LENA, child, 'Lena.jpg', 5);
    next = { state: 'infected', finding: 'Test.Sig' };
    const bad = await pic(c, ANNA, mine, 'Boese.jpg', 6);
    next = { state: 'clean' };
    const vaulted = await pic(c, ANNA, mine, 'Geheim.jpg', 7);
    await host.gc.db.run('UPDATE nodes SET vault_id = ? WHERE id = ?', ['v-test', vaulted.id]);
    const gone = await pic(c, ANNA, mine, 'Weg.jpg', 8);
    await a('DELETE', `nodes/${gone.id}`);

    assert.ok((await a('GET', 'me')).json.features.includes('framePhotos'));
    // nothing shared yet: no album
    let r = await a('GET', 'frame/photos');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.album, r.json.ids, r.json.count], [null, [], 0]);
    assert.equal((await a('POST', 'frame/photos', { ids: [] })).status, 400);
    assert.equal((await a('POST', 'frame/photos', { ids: new Array(501).fill(p1.id) })).status, 400, '≤ 500');
    // only what cannot be shared: no album is made
    r = await a('POST', 'frame/photos', { ids: [vid.id] });
    assert.deepEqual([r.json.album, r.json.added, r.json.skipped], [null, [], [{ id: vid.id, reason: 'not_image' }]]);
    assert.equal((await a('GET', 'albums')).json.albums.length, 0);
    // Anna (a parent, she reads Lena's folder) shares several at once
    r = await a('POST', 'frame/photos', { ids: [p1.id, p2.id, vid.id, doc.id, kid.id, bad.id, vaulted.id, gone.id, 999999] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.added, [p1.id, p2.id]);
    assert.deepEqual(r.json.skipped, [
      { id: vid.id, reason: 'not_image' }, { id: doc.id, reason: 'not_image' }, { id: kid.id, reason: 'child' },
      { id: bad.id, reason: 'blocked' }, { id: vaulted.id, reason: 'vault' }, { id: gone.id, reason: 'not_found' }, { id: 999999, reason: 'not_found' },
    ]);
    assert.deepEqual([r.json.ids, r.json.count], [[p2.id, p1.id], 2], 'newest first');
    const al = r.json.album;
    assert.deepEqual([al.name, al.areaId, al.frame, al.count, al.canFrame], ['Fotorahmen', mine.id, true, 2, true]);
    // an ordinary album of hers: in GET albums, the portal shows it
    assert.deepEqual((await a('GET', 'albums')).json.albums.map((x) => x.id), [al.id]);
    // twice: once, the same album
    r = await a('POST', 'frame/photos', { ids: [p1.id] });
    assert.deepEqual([r.json.album.id, r.json.added, r.json.count], [al.id, [p1.id], 2]);
    // ask: which of these are shared?
    r = await a('GET', 'frame/photos', null, { ids: `${p1.id},${vid.id},${doc.id}` });
    assert.deepEqual(r.json.ids, [p1.id]);
    assert.equal((await a('GET', 'frame/photos', null, { ids: 'x' })).status, 400);
    // Marc has no frame album of his own and does not see Anna's
    assert.deepEqual((await c.as(MARC)('GET', 'frame/photos')).json.album, null);
    // remove (body or ?ids=) — the photo stays
    r = await a('DELETE', 'frame/photos', { ids: [p1.id, vid.id] });
    assert.deepEqual([r.json.removed, r.json.ids, r.json.count], [[p1.id], [p2.id], 1]);
    r = await a('DELETE', 'frame/photos', null, { ids: String(p2.id) });
    assert.deepEqual([r.json.removed, r.json.count, r.json.album.id], [[p2.id], 0, al.id]);
    assert.equal((await a('GET', `nodes/${p1.id}`)).status, 200);
    // switched off or deleted in the portal: the next share switches it on again / makes it anew
    await a('POST', 'frame/photos', { ids: [p1.id] });
    await a('PATCH', `albums/${al.id}`, { frame: false });
    assert.equal((await a('POST', 'frame/photos', { ids: [p2.id] })).json.album.frame, true);
    await a('DELETE', `albums/${al.id}`);
    r = await a('POST', 'frame/photos', { ids: [p2.id] });
    assert.deepEqual([r.json.album.frame, r.json.album.count, r.json.added], [true, 1, [p2.id]], 'made anew');
    assert.deepEqual(r.json.ids, [p2.id]);
  });
});

test('a child shares nothing; the frame album is the person\'s own', async () => {
  await withHost({ gatecontrol: '1.210.0', lang: 'en' }, async (host, c) => {
    const child = await c.area(LENA, 'child');
    const p = await pic(c, LENA, child, 'Ich.jpg', 1);
    const r = await c.as(LENA)('POST', 'frame/photos', { ids: [p.id] });
    assert.deepEqual([r.status, r.json.code, r.json.field], [403, 'forbidden', 'frame']);
    assert.equal((await c.as(LENA)('GET', 'frame/photos')).json.album, null, 'asking is fine');
    const mine = await c.area(MARC, 'mine');
    const q = await pic(c, MARC, mine, 'Marc.jpg', 2);
    assert.equal((await c.as(MARC)('POST', 'frame/photos', { ids: [q.id] })).json.album.name, 'Photo frame');
    // Anna cannot share Marc's own photo (she does not read it)
    assert.deepEqual((await c.as(ANNA)('POST', 'frame/photos', { ids: [q.id] })).json.skipped, [{ id: q.id, reason: 'not_found' }]);
  });
});

test('GET frame on the TV (an app device): the shared photos and the family\'s frame — never another one\'s private photos', async () => {
  await withHost({ gatecontrol: '1.210.0', settings: { frame_order: 'date', frame_seconds: 15, frame_accounts: 'Küche' } }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const fam = await c.area(ANNA, 'family');
    const marcs = await c.area(MARC, 'mine');
    const own = await pic(c, ANNA, mine, 'Anna.jpg', 1);
    const notShared = await pic(c, ANNA, mine, 'Nicht.jpg', 2);
    const famPic = await pic(c, ANNA, fam, 'Familie.jpg', 3);
    const marcPic = await pic(c, MARC, marcs, 'Marc privat.jpg', 4);
    const tv = tvOf(c, ANNA);
    // nothing shared: on, empty
    let r = await tv('GET', 'frame');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.on, r.json.ready, r.json.seconds, r.json.order, r.json.items], [true, true, 15, 'date', []], 'frame_accounts is for kiosk accounts');
    await c.as(ANNA)('POST', 'frame/photos', { ids: [own.id] });
    // Marc shares his own private photo and puts a family album with Anna's photo on the frame
    await c.as(MARC)('POST', 'frame/photos', { ids: [marcPic.id] });
    const al = (await c.as(MARC)('POST', 'albums', { name: 'Wand', areaId: fam.id })).json.album;
    await c.as(ANNA)('POST', `albums/${al.id}/items`, { ids: [famPic.id] });
    await c.as(MARC)('PATCH', `albums/${al.id}`, { frame: true });
    r = await tv('GET', 'frame');
    assert.equal(r.json.items.length, 2, JSON.stringify(r.json));
    assert.deepEqual(r.json.items.map((x) => x.takenAt), [3, 1].map((d) => new Date(Date.UTC(2026, 3, d)).toISOString()), 'the family\'s and Anna\'s own, by date');
    for (const it of r.json.items) {
      assert.deepEqual(Object.keys(it).sort(), ['takenAt', 'url']);
      assert.match(it.url, new RegExp(`^/plugin-media/[0-9a-f]{32}\\.\\d+\\.${ANNA.id}\\.[A-Za-z0-9_-]{22}/preview\\?size=large$`), 'preview-only, signed for Anna');
      const prev = await host.mediaFromUrl(it.url);
      assert.equal(prev.status, 200);
      assert.equal((await host.mediaFromUrl(it.url.replace(/\/preview\?size=large$/, ''))).status, 404, 'never the file');
    }
    const body = JSON.stringify(r.json);
    for (const s of [marcPic.mediaId, notShared.mediaId, 'Anna.jpg', 'Wand']) assert.ok(!body.includes(s), s);
    // Marc's TV: his own, the family's — not Anna's own
    const m = (await tvOf(c, MARC)('GET', 'frame')).json.items;
    assert.equal(m.length, 2);
    // the kiosk device: everything on the frame, as before (each once)
    const k = (await c.call(KIOSK, 'GET', 'frame')).json;
    assert.equal(k.on, false, 'Oma\'s kiosk account is not listed in frame_accounts');
    host.settings.frame_accounts = '';
    assert.equal((await c.call(KIOSK, 'GET', 'frame')).json.items.length, 3);
    // the portal still gets no frame; frame_on off: none on the TV either
    assert.equal((await c.portal(ANNA)('GET', 'frame')).status, 404);
    host.settings.frame_on = false;
    r = (await tv('GET', 'frame')).json;
    assert.deepEqual([r.on, r.items], [false, []]);
  });
});

test('the own frame album keeps work photos (shared on purpose); a family album still leaves them out', async () => {
  await withHost({ gatecontrol: '1.210.0' }, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const workDir = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Arbeit' })).json.node;
    assert.equal((await a('PUT', 'photos/settings', { workFolder: workDir.id })).status, 200);
    const w = (await c.put(ANNA, workDir.id, 'Baustelle.jpg', 'b', { mime: 'image/jpeg', takenAt: Date.UTC(2026, 3, 1) })).json.node;
    const al = (await a('POST', 'albums', { name: 'Andere' })).json.album;
    await a('POST', `albums/${al.id}/items`, { ids: [w.id] });
    await a('PATCH', `albums/${al.id}`, { frame: true });
    assert.equal((await tvOf(c, ANNA)('GET', 'frame')).json.items.length, 0);
    await a('POST', 'frame/photos', { ids: [w.id] });
    assert.equal((await tvOf(c, ANNA)('GET', 'frame')).json.items.length, 1);
  });
});

test('the TV device id is a normal app device: Drive records it like any other', async () => {
  await withHost({ gatecontrol: '1.210.0' }, async (host, c) => {
    assert.equal((await tvOf(c, ANNA, TV)('GET', 'me')).json.me.deviceId, TV);
  });
});
