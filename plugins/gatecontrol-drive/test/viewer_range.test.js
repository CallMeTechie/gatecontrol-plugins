'use strict';

// The viewer of pictures and videos (1.21.0) streams from GET nodes/<id>/content: the signed URL for the portal
// (/plugin-media/<token>) and the app's media route both answer Range requests with the stored type — 206 with
// Content-Range, an open end, the last bytes, 416 beyond the end — so a video plays without loading it whole first.
// A file the virus scan holds back gives no URL (423), and nobody without the right to read it gets one.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, BOB } = require('./helpers');

const VIDEO = Buffer.from('....ftypisom' + 'x'.repeat(4096 - 12));

test('content of a video: Range on the signed URL and the app route, the stored type, 416 beyond the end', async () => {
  await withHost({}, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const up = await c.put(ANNA, mine.rootId, 'Urlaub.mp4', VIDEO, { mime: 'video/mp4' });
    assert.equal(up.status, 200);
    const got = await c.as(ANNA)('GET', `nodes/${up.json.node.id}/content`);
    assert.equal(got.status, 200);
    assert.equal(got.json.mime, 'video/mp4');
    assert.equal(got.json.size, VIDEO.length);
    assert.match(got.json.url, /^\/plugin-media\//);

    // the first bytes (a browser asks for bytes=0- first, then where it seeks to)
    const head = await host.mediaFromUrl(got.json.url, { range: 'bytes=0-11' });
    assert.equal(head.status, 206);
    assert.equal(head.headers['content-type'], 'video/mp4');
    assert.equal(head.headers['accept-ranges'], 'bytes');
    assert.equal(head.headers['content-range'], `bytes 0-11/${VIDEO.length}`);
    assert.equal(head.headers['content-length'], '12');
    assert.equal(String(head.body), '....ftypisom');
    // shown inline (a <video>), not as a download
    assert.doesNotMatch(String(head.headers['content-disposition'] || ''), /attachment/);
    // a seek: an open end
    const mid = await host.mediaFromUrl(got.json.url, { range: 'bytes=4000-' });
    assert.equal(mid.status, 206);
    assert.equal(mid.headers['content-range'], `bytes 4000-${VIDEO.length - 1}/${VIDEO.length}`);
    assert.equal(mid.body.length, VIDEO.length - 4000);
    // the last bytes (the moov box at the end of many MP4 files)
    const tail = await host.mediaFromUrl(got.json.url, { range: 'bytes=-96' });
    assert.equal(tail.status, 206);
    assert.equal(tail.body.length, 96);
    // beyond the end
    const out = await host.mediaFromUrl(got.json.url, { range: `bytes=${VIDEO.length}-` });
    assert.equal(out.status, 416);
    assert.equal(out.headers['content-range'], `bytes */${VIDEO.length}`);
    // no Range: the whole file
    const all = await host.mediaFromUrl(got.json.url);
    assert.equal(all.status, 200);
    assert.equal(all.body.length, VIDEO.length);

    // the apps (Android's player, the Windows app's gcdrive:) read the same file over their media route
    const app = await host.mediaGet(ANNA, got.json.mediaId, { range: 'bytes=100-199' });
    assert.equal(app.status, 206);
    assert.equal(app.headers['content-type'], 'video/mp4');
    assert.equal(app.headers['content-range'], `bytes 100-199/${VIDEO.length}`);
    assert.equal(app.body.length, 100);
    // someone else: neither the URL nor the bytes
    assert.equal((await c.as(BOB)('GET', `nodes/${up.json.node.id}/content`)).status, 404);
    assert.equal((await host.mediaGet(BOB, got.json.mediaId, { range: 'bytes=0-9' })).status, 404);
  });
});

test('content of a picture or video the virus scan holds back: no URL (423), the bytes neither', async () => {
  const scanner = (f) => {
    const s = f.data.toString();
    if (s === 'pending') return { state: 'pending' };
    if (s === 'virus') return { state: 'infected', finding: 'Eicar-Test-Signature' };
    return null;
  };
  await withHost({ scan: scanner }, async (host, c) => {
    const mine = await c.area(ANNA, 'mine');
    const pending = await c.put(ANNA, mine.rootId, 'neu.mp4', 'pending', { mime: 'video/mp4' });
    const bad = await c.put(ANNA, mine.rootId, 'bild.jpg', 'virus', { mime: 'image/jpeg' });
    const p = await c.as(ANNA)('GET', `nodes/${pending.json.node.id}/content`);
    assert.equal(p.status, 423);
    assert.equal(p.json.code, 'scan_pending');
    const b = await c.as(ANNA)('GET', `nodes/${bad.json.node.id}/content`);
    assert.equal(b.status, 423);
    assert.equal(b.json.code, 'quarantined');
    // the apps' route keeps it back as well (a player that knew the media id)
    assert.equal((await host.mediaGet(ANNA, pending.json.node.mediaId, { range: 'bytes=0-3' })).status, 423);
    // once checked: it plays
    host.mediaScanned(pending.json.node.mediaId, { state: 'clean' });
    const ok = await c.as(ANNA)('GET', `nodes/${pending.json.node.id}/content`);
    assert.equal(ok.status, 200);
    assert.equal((await host.mediaFromUrl(ok.json.url, { range: 'bytes=0-3' })).status, 206);
  });
});
