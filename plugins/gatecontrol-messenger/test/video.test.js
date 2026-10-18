'use strict';

// 1.3.0: videos as their own media category and preview pictures for files — `video` { durationMs, width,
// height } and `thumbMediaId` on file messages (kind stays 'file'), media?kind=video and counts.video,
// GET me features, the preview as push picture of a video, previews deleted with their message.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, PNG, PDF, DAY, HOUR, png } = require('./helpers');

const MP4 = Buffer.from('\0\0\0\x18ftypmp42\0\0\0\0mp42isomfake-video-bytes');
const WEBP = Buffer.from('RIFF\x1a\0\0\0WEBPVP8 fake-webp-preview', 'latin1');

test('file messages: thumbMediaId (WebP/JPEG/PNG ≤ 64 KB) and video { durationMs, width, height } — checked, returned, claimed', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC]);
    const vid = await c.upload(ANNA, MP4, 'video/mp4');
    const thumb = await c.upload(ANNA, WEBP, 'image/webp');
    const m = await c.send(ANNA, g.id, { kind: 'file', mediaId: vid, thumbMediaId: thumb, meta: { fileName: 'Urlaub.mp4' }, video: { durationMs: 12345, width: 1920, height: 1080 }, text: 'Strand' });
    assert.equal(m.kind, 'file', 'older apps keep showing it as a file');
    assert.equal(m.thumbMediaId, thumb);
    assert.deepEqual(m.video, { durationMs: 12345, width: 1920, height: 1080 });
    assert.deepEqual([m.media.id, m.media.mime, m.media.thumbId, m.meta.fileName, m.text], [vid, 'video/mp4', thumb, 'Urlaub.mp4', 'Strand']);
    assert.equal(host.media.get(thumb).claimed, true);
    // as the others read it
    const seen = (await c.as(MARC)('GET', `conversations/${g.id}/messages`)).json.messages.find((x) => x.id === m.id);
    assert.deepEqual([seen.thumbMediaId, seen.video], [thumb, { durationMs: 12345, width: 1920, height: 1080 }]);
    // unknown parts may be left out: null in the answer
    const m2 = await c.send(ANNA, g.id, { kind: 'file', mediaId: await c.upload(ANNA, MP4, 'video/mp4'), video: { durationMs: 900 } });
    assert.deepEqual([m2.video, m2.thumbMediaId], [{ durationMs: 900, width: null, height: null }, null]);
    // a PDF with a first-page preview (JPEG); no video
    const pdfThumb = await c.upload(ANNA, png(48, 64), 'image/png');
    const m3 = await c.send(ANNA, g.id, { kind: 'file', mediaId: await c.upload(ANNA, PDF, 'application/pdf'), thumbMediaId: pdfThumb, meta: { fileName: 'a.pdf' } });
    assert.deepEqual([m3.thumbMediaId, m3.video], [pdfThumb, null]);
    // other kinds: video null; picture previews keep coming back as thumbMediaId too
    const t = await c.send(ANNA, g.id, { text: 'hallo' });
    assert.deepEqual([t.thumbMediaId, t.video], [null, null]);
    const imgThumb = await c.upload(ANNA, PNG, 'image/png');
    const im = await c.send(ANNA, g.id, { kind: 'image', mediaId: await c.upload(ANNA, PNG, 'image/png'), thumbMediaId: imgThumb });
    assert.deepEqual([im.thumbMediaId, im.video], [imgThumb, null]);
    // older apps: a file without any of it works as before
    const old = await c.send(ANNA, g.id, { kind: 'file', mediaId: await c.upload(ANNA, MP4, 'video/mp4'), meta: { fileName: 'alt.mp4' } });
    assert.deepEqual([old.thumbMediaId, old.video], [null, null]);
  });
});

test('file previews and video meta: refusals', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const send = (b) => c.as(ANNA)('POST', `conversations/${d.id}/messages`, { clientId: c.cid(), kind: 'file', ...b });
    const vid = () => c.upload(ANNA, MP4, 'video/mp4');
    const code = async (b) => (await send(b)).json.code;
    // the preview: own unused upload, WebP/JPEG/PNG only, ≤ 64 KB, not the file itself
    assert.equal(await code({ mediaId: await vid(), thumbMediaId: await c.upload(ANNA, Buffer.from('GIF89a....'), 'image/gif') }), 'media_invalid', 'GIF');
    assert.equal(await code({ mediaId: await vid(), thumbMediaId: await c.upload(ANNA, PDF, 'application/pdf') }), 'media_invalid', 'no picture');
    assert.equal(await code({ mediaId: await vid(), thumbMediaId: await c.upload(ANNA, Buffer.concat([WEBP, Buffer.alloc(64 * 1024)]), 'image/webp') }), 'media_invalid', 'over 64 KB');
    assert.equal(await code({ mediaId: await vid(), thumbMediaId: await c.upload(MARC, WEBP, 'image/webp') }), 'media_invalid', 'someone else\'s upload');
    const v = await vid();
    assert.equal(await code({ mediaId: v, thumbMediaId: v }), 'invalid', 'the file as its own preview');
    const used = await c.upload(ANNA, WEBP, 'image/webp');
    await c.send(ANNA, d.id, { kind: 'file', mediaId: await vid(), thumbMediaId: used });
    assert.equal(await code({ mediaId: await vid(), thumbMediaId: used }), 'media_in_use');
    // video: only for a video/* file, an object of integers within bounds
    assert.equal(await code({ mediaId: await c.upload(ANNA, PDF, 'application/pdf'), video: { durationMs: 1000 } }), 'invalid', 'not a video file');
    for (const bad of [{ durationMs: -1 }, { durationMs: 24 * HOUR + 1 }, { durationMs: 1.5 }, { durationMs: '1000' }, { width: 0 }, { height: 16385 }, { width: 1280.5 }, [1, 2], 'x', 5]) {
      assert.equal(await code({ mediaId: await vid(), video: bad }), 'invalid', JSON.stringify(bad));
    }
    assert.equal((await c.as(ANNA)('POST', `conversations/${d.id}/messages`, { clientId: c.cid(), kind: 'image', mediaId: await c.upload(ANNA, PNG, 'image/png'), video: { durationMs: 1 } })).json.code, 'invalid', 'other kinds');
    assert.equal((await c.as(ANNA)('POST', `conversations/${d.id}/messages`, { clientId: c.cid(), text: 'x', video: { durationMs: 1 } })).json.code, 'invalid');
    // extra keys are ignored (newer clients), an empty object is no video
    const m = await c.send(ANNA, d.id, { kind: 'file', mediaId: await vid(), video: { durationMs: 0, width: 16384, height: 1, rotation: 90 } });
    assert.deepEqual(m.video, { durationMs: 0, width: 16384, height: 1 });
    assert.equal((await c.send(ANNA, d.id, { kind: 'file', mediaId: await vid(), video: {} })).video, null);
  });
});

test('media list: kind=video (file messages with a video/* file), kind=file without videos, counts.video; paging', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const v1 = await c.send(ANNA, d.id, { kind: 'file', mediaId: await c.upload(ANNA, MP4, 'video/mp4'), video: { durationMs: 1000 } });
    const f1 = await c.send(MARC, d.id, { kind: 'file', mediaId: await c.upload(MARC, PDF, 'application/pdf'), meta: { fileName: 'a.pdf' } });
    const v2 = await c.send(MARC, d.id, { kind: 'file', mediaId: await c.upload(MARC, MP4, 'video/mp4') }); // an older app: no video meta, still a video
    const i1 = await c.send(ANNA, d.id, { kind: 'image', mediaId: await c.upload(ANNA, PNG, 'image/png') });
    const v3 = await c.send(ANNA, d.id, { kind: 'file', mediaId: await c.upload(ANNA, MP4, 'video/mp4'), thumbMediaId: await c.upload(ANNA, WEBP, 'image/webp') });
    const list = async (q) => (await c.as(MARC)('GET', `conversations/${d.id}/media`, null, q)).json;
    let r = await list({});
    assert.deepEqual(r.counts, { image: 1, voice: 0, file: 1, video: 3 });
    assert.deepEqual(r.items.map((m) => m.id), [v3.id, i1.id, v2.id, f1.id, v1.id], 'all: unchanged');
    r = await list({ kind: 'all' });
    assert.equal(r.items.length, 5);
    r = await list({ kind: 'video' });
    assert.deepEqual([r.items.map((m) => m.id), r.hasMore], [[v3.id, v2.id, v1.id], false]);
    assert.ok(r.items.every((m) => m.kind === 'file' && /^video\//.test(m.media.mime)));
    assert.equal(r.items[0].thumbMediaId, v3.thumbMediaId);
    r = await list({ kind: 'file' });
    assert.deepEqual(r.items.map((m) => m.id), [f1.id], 'files without the videos');
    assert.deepEqual(r.counts, { image: 1, voice: 0, file: 1, video: 3 }, 'counts of the whole chat whatever the filter');
    // paging as before
    r = await list({ kind: 'video', limit: '2' });
    assert.deepEqual([r.items.map((m) => m.id), r.hasMore], [[v3.id, v2.id], true]);
    r = await list({ kind: 'video', limit: '2', before: String(v2.id) });
    assert.deepEqual([r.items.map((m) => m.id), r.hasMore], [[v1.id], false]);
    // deleted and hidden ones leave the list and the counts
    await c.as(MARC)('DELETE', `messages/${v1.id}`, null, { for: 'me' });
    await c.as(ANNA)('DELETE', `messages/${v3.id}`, null, { for: 'all' });
    r = await list({ kind: 'video' });
    assert.deepEqual([r.items.map((m) => m.id), r.counts.video], [[v2.id], 1]);
    assert.equal((await c.as(ANNA)('GET', `conversations/${d.id}/media`, null, { kind: 'video' })).json.counts.video, 2, 'Anna did not hide hers');
  });
});

test('GET me: features video_meta and file_thumbs next to the existing flags; thumbMaxSide', async () => {
  await withHost({}, async (host, c) => {
    const me = (await c.as(ANNA)('GET', 'me')).json;
    assert.equal(me.features.video_meta, true);
    assert.equal(me.features.file_thumbs, true);
    for (const k of ['direct', 'groups', 'voice', 'files', 'location', 'reactions', 'edit', 'search', 'disappearing', 'bridges', 'e2e']) assert.ok(k in me.features, k);
    assert.deepEqual([me.limits.thumbMaxBytes, me.limits.thumbMaxSide], [65536, 640]);
    const portalMe = (await c.as(ANNA, (u) => ({ ...u, portal: true, loggedIn: true }))('GET', 'me')).json;
    assert.deepEqual([portalMe.features.video_meta, portalMe.features.file_thumbs], [true, true], 'the portal reads the same');
  });
});

test('mediaAccess: a file\'s preview is the members\' only, like the file; signed URL in the portal', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC]);
    const vid = await c.upload(ANNA, MP4, 'video/mp4');
    const thumb = await c.upload(ANNA, WEBP, 'image/webp');
    const m = await c.send(ANNA, g.id, { kind: 'file', mediaId: vid, thumbMediaId: thumb, video: { durationMs: 3000, width: 640, height: 360 } });
    for (const id of [vid, thumb]) {
      assert.equal((await host.mediaGet(MARC, id)).status, 200);
      assert.equal((await host.mediaGet(LENA, id)).status, 404, 'not a member');
    }
    const pm = (await c.as(MARC, (u) => ({ ...u, portal: true, loggedIn: true }))('GET', `conversations/${g.id}/messages`)).json.messages.find((x) => x.id === m.id);
    assert.match(pm.media.thumbUrl, new RegExp('^/plugin-media/' + thumb));
    await c.as(MARC)('DELETE', `messages/${m.id}`, null, { for: 'me' });
    assert.equal((await host.mediaGet(MARC, thumb)).status, 404, 'hidden for Marc');
    assert.equal((await host.mediaGet(ANNA, thumb)).status, 200);
  });
});

test('previews are deleted with their message: delete for everyone, disappearing, retention', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const sendVideo = async () => {
      const vid = await c.upload(ANNA, MP4, 'video/mp4');
      const thumb = await c.upload(ANNA, WEBP, 'image/webp');
      const m = await c.send(ANNA, d.id, { kind: 'file', mediaId: vid, thumbMediaId: thumb, video: { durationMs: 1000 } });
      return { m, vid, thumb };
    };
    // deleted for everyone
    const a = await sendVideo();
    const del = (await c.as(ANNA)('DELETE', `messages/${a.m.id}`, null, { for: 'all' })).json.message;
    assert.deepEqual([del.thumbMediaId, del.video, del.media], [null, null, null]);
    assert.equal((await host.mediaGet(MARC, a.thumb)).status, 404);
    await host.tick();
    assert.deepEqual([host.media.has(a.vid), host.media.has(a.thumb)], [false, false]);
    // disappearing
    await c.as(ANNA)('PATCH', `conversations/${d.id}`, { disappearingS: 86400 });
    const b = await sendVideo();
    assert.ok(b.m.expiresAt);
    c.clock.add(DAY + 1000);
    await host.tick();
    await host.tick(); // the files go after the commit of the purge
    assert.deepEqual([host.media.has(b.vid), host.media.has(b.thumb)], [false, false]);
    await c.as(ANNA)('PATCH', `conversations/${d.id}`, { disappearingS: 0 });
    // retention
    const r = await sendVideo();
    c.clock.add(40 * DAY);
    await c.admin('PUT', 'settings', { retentionDays: 30 });
    c.clock.add(HOUR);
    await host.tick();
    await host.tick();
    assert.deepEqual([host.media.has(r.vid), host.media.has(r.thumb)], [false, false]);
    assert.equal((await host.gc.db.query('SELECT COUNT(*) AS n FROM media')).rows[0].n, 0, 'nothing left behind');
  });
});

test('push: a video file with a preview carries the preview as push picture (GateControl ≥ 1.178.0, preview on); others none', async () => {
  await withHost({ gatecontrol: '1.178.0' }, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA]);
    await c.as(LENA)('PUT', 'prefs', { preview: false });
    const thumb = await c.upload(ANNA, png(64, 36), 'image/png');
    await c.send(ANNA, g.id, { kind: 'file', mediaId: await c.upload(ANNA, MP4, 'video/mp4'), thumbMediaId: thumb, video: { durationMs: 5000, width: 1280, height: 720 }, meta: { fileName: 'clip.mp4' } });
    const ps = c.pushes().slice(-2);
    const forMarc = ps.find((p) => p.users.includes(MARC.id));
    const forLena = ps.find((p) => p.users.includes(LENA.id));
    assert.deepEqual([forMarc.image.mime, forMarc.image.width, forMarc.image.height], ['image/png', 64, 36]);
    assert.equal(forMarc.body, 'Datei: clip.mp4');
    assert.equal(forLena.image, undefined, 'no picture without preview');
    // a video without preview, a PDF with a preview: no picture (never the video itself, only videos' previews)
    await c.send(ANNA, g.id, { kind: 'file', mediaId: await c.upload(ANNA, MP4, 'video/mp4') });
    assert.ok(c.pushes().slice(-2).every((p) => !p.image));
    await c.send(ANNA, g.id, { kind: 'file', mediaId: await c.upload(ANNA, PDF, 'application/pdf'), thumbMediaId: await c.upload(ANNA, png(48, 64), 'image/png') });
    assert.ok(c.pushes().slice(-2).every((p) => !p.image));
    // a preview the host refuses (1×1): the push without it
    const n = c.pushes().length;
    await c.send(ANNA, g.id, { kind: 'file', mediaId: await c.upload(ANNA, MP4, 'video/mp4'), thumbMediaId: await c.upload(ANNA, PNG, 'image/png') });
    assert.equal(c.pushes().length, n + 2);
    assert.ok(c.pushes().slice(-2).every((p) => !p.image));
  });
  await withHost({ gatecontrol: '1.177.0' }, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    await c.send(ANNA, d.id, { kind: 'file', mediaId: await c.upload(ANNA, MP4, 'video/mp4'), thumbMediaId: await c.upload(ANNA, png(64, 36), 'image/png') });
    assert.equal(c.pushes().at(-1).image, undefined, 'GateControl 1.177.0: no picture');
  });
});
