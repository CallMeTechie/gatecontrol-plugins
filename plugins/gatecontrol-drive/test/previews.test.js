'use strict';

// Previews (GateControl ≥ 1.208.0, media.previews, server/previews.js): every file node carries preview { url, largeUrl }
// — the apps' endpoint for app callers, a signed frame URL for the portal; the device's preview of a HEIC / video;
// null for documents, trashed files and on an older GateControl.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, OMA, portal } = require('./helpers');

const APP_URL = (id) => `/api/v1/client/plugins/gatecontrol-drive/media/${id}/preview`;

test('app: file nodes in every answer carry the apps\' preview URL; folders and documents none', async () => {
  await withHost({}, async (host, c) => {
    const a = c.as(ANNA);
    const mine = await c.area(ANNA, 'mine');
    const dir = (await a('POST', 'nodes', { parentId: mine.rootId, name: 'Fotos' })).json.node;
    assert.equal('preview' in dir, false, 'a folder has no preview field');
    const up = await c.put(ANNA, dir.id, 'Strand.jpg', 'jpeg-bytes', { mime: 'image/jpeg' });
    assert.equal(up.status, 200);
    const photo = up.json.node;
    assert.deepEqual(photo.preview, { url: APP_URL(photo.mediaId), largeUrl: APP_URL(photo.mediaId) + '?size=large' });
    const doc = (await c.put(ANNA, dir.id, 'Brief.pdf', '%PDF', { mime: 'application/pdf' })).json.node;
    assert.equal(doc.preview, null);

    const list = await a('GET', `nodes/${dir.id}/children`);
    assert.deepEqual(list.json.items.map((n) => [n.name, n.preview && n.preview.url]), [['Brief.pdf', null], ['Strand.jpg', APP_URL(photo.mediaId)]]);
    assert.equal((await a('GET', `nodes/${photo.id}`)).json.node.preview.url, APP_URL(photo.mediaId));
    assert.equal((await a('GET', 'nodes/by-path', null, { area: mine.id, path: 'Fotos/Strand.jpg' })).json.node.preview.url, APP_URL(photo.mediaId));
    assert.equal((await a('GET', 'search', null, { q: 'strand' })).json.items[0].preview.url, APP_URL(photo.mediaId));
    const ch = (await a('GET', 'changes', null, { since: 0 })).json.changes.filter((x) => x.node && x.node.id === photo.id);
    assert.ok(ch.length && ch.every((x) => x.node.preview.url === APP_URL(photo.mediaId)));
    assert.equal((await a('GET', `nodes/${photo.id}/versions`)).json.current.preview.url, APP_URL(photo.mediaId));
    assert.equal((await a('POST', 'uploads/check', { parentId: dir.id, name: 'Strand.jpg' })).json.node.preview.url, APP_URL(photo.mediaId));

    // the endpoint answers with the rights of the file (hook mediaAccess)
    assert.equal((await host.previewGet(ANNA, photo.mediaId)).status, 200);
    assert.equal((await host.previewGet(MARC, photo.mediaId)).status, 404, 'not in Marc\'s areas');

    // a new version: the preview of the new media
    const v2 = await c.put(ANNA, dir.id, 'Strand.jpg', 'jpeg-2', { mime: 'image/jpeg', onConflict: 'version' });
    assert.notEqual(v2.json.node.mediaId, photo.mediaId);
    assert.equal(v2.json.node.preview.url, APP_URL(v2.json.node.mediaId));

    // in the trash: none
    await a('DELETE', `nodes/${photo.id}`);
    const trash = await a('GET', 'trash');
    assert.equal(trash.json.items.find((n) => n.id === photo.id).preview, null);
  });
});

test('portal: a signed frame URL of the preview; thumbs are the previews', async () => {
  await withHost({}, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const photo = (await c.put(ANNA, mine.rootId, 'Hund.png', 'png', { mime: 'image/png' })).json.node;
    const p = c.portal(ANNA);
    const list = await p('GET', `nodes/${mine.rootId}/children`, null, { thumbs: 1 });
    const it = list.json.items[0];
    assert.match(it.preview.url, new RegExp(`^/plugin-media/${photo.mediaId}\\.\\d+\\.${ANNA.id}\\.[A-Za-z0-9_-]{22}/preview$`));
    assert.equal(it.preview.largeUrl, it.preview.url + '?size=large');
    assert.equal(it.thumb, it.preview.url);
    const r = await host.mediaFromUrl(it.preview.largeUrl);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/jpeg');
    assert.equal(r.body.toString(), `preview:${photo.mediaId}:large`);
    assert.ok((await p('GET', `nodes/${photo.id}`)).json.node.preview.url.startsWith('/plugin-media/'));
  });
});

test('HEIC and videos: the uploading device sends the preview (before or after the commit)', async () => {
  await withHost({}, async (host, c) => {
    const fam = await c.area(ANNA, 'family');
    // before the commit: right after the upload
    const heic = await c.upload(ANNA, 'heic-bytes', 'image/heic');
    assert.equal((await host.previewPut(MARC, heic, 'jpg', 'image/jpeg')).status, 404, 'only the uploader');
    assert.equal((await host.previewPut(ANNA, heic, 'jpg', 'image/jpeg')).status, 200);
    const node = (await c.as(ANNA)('POST', 'uploads/commit', { mediaId: heic, parentId: fam.rootId, name: 'IMG_0001.HEIC' })).json.node;
    assert.equal(node.preview.url, APP_URL(heic));
    // the family reads it
    assert.equal((await host.previewGet(MARC, heic)).status, 200);
    assert.equal((await host.previewGet(OMA, heic)).status, 404);
    // after the commit
    const video = (await c.put(ANNA, fam.rootId, 'Clip.mp4', 'mp4-bytes', { mime: 'video/mp4' })).json.node;
    assert.equal(video.preview, null);
    assert.equal((await host.previewPut(ANNA, video.mediaId, 'webp', 'image/webp')).status, 200);
    const list = await c.as(MARC)('GET', `nodes/${fam.rootId}/children`);
    assert.equal(list.json.items.find((n) => n.name === 'Clip.mp4').preview.url, APP_URL(video.mediaId));
    // a JPEG the server reads itself takes none
    const jpg = await c.upload(ANNA, 'jpeg', 'image/jpeg');
    assert.equal((await host.previewPut(ANNA, jpg, 'x', 'image/jpeg')).body.code, 'preview_by_server');
  });
});

test('an older GateControl (no gc.media.previews): preview null, the portal\'s thumbs are the pictures', async () => {
  await withHost({ gatecontrol: '1.207.0' }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    await c.put(ANNA, mine.rootId, 'Strand.jpg', 'jpeg', { mime: 'image/jpeg' });
    const it = (await c.portal(ANNA)('GET', `nodes/${mine.rootId}/children`, null, { thumbs: 1 })).json.items[0];
    assert.equal(it.preview, null);
    assert.match(it.thumb, /^\/plugin-media\/[0-9a-f]{32}\.\d+\.\d+\.[A-Za-z0-9_-]{22}$/);
    assert.equal((await c.as(ANNA)('GET', `nodes/${it.id}`)).json.node.preview, null);
    assert.equal(portal(ANNA).app, undefined);
  });
});
