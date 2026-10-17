'use strict';

// Files: the hook mediaAccess (members only — also previews and group pictures,
// never before joining, never after leaving, never a hidden or deleted message),
// signed URLs only for the portal frame, files of deleted messages removed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, OMA, PNG, OGG, PDF } = require('./helpers');

test('mediaAccess: the members of the conversation — file and preview; nobody else', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC]);
    const img = await c.upload(ANNA, PNG, 'image/png');
    const thumb = await c.upload(ANNA, PNG, 'image/png');
    await c.send(ANNA, g.id, { kind: 'image', mediaId: img, thumbMediaId: thumb });
    for (const id of [img, thumb]) {
      assert.equal((await host.mediaGet(ANNA, id)).status, 200);
      assert.equal((await host.mediaGet(MARC, id)).status, 200);
      assert.equal((await host.mediaGet(LENA, id)).status, 404, 'not a member');
      assert.equal((await host.mediaGet({ ...MARC, kiosk: true }, id)).status, 404, 'never a kiosk device');
    }
    // range requests for voice messages
    const voice = await c.upload(MARC, OGG, 'audio/ogg');
    await c.send(MARC, g.id, { kind: 'voice', mediaId: voice, meta: { durationMs: 2000 } });
    const part = await host.mediaGet(ANNA, voice, { range: 'bytes=0-3' });
    assert.deepEqual([part.status, part.body.toString()], [206, 'OggS']);
  });
});

test('mediaAccess: a member who joined later does not get older files; a member who left gets none', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC]);
    const before = await c.upload(ANNA, PDF, 'application/pdf');
    await c.send(ANNA, g.id, { kind: 'file', mediaId: before, meta: { fileName: 'a.pdf' } });
    await c.as(ANNA)('PATCH', `conversations/${g.id}`, { add: [LENA.id] });
    const after = await c.upload(ANNA, PDF, 'application/pdf');
    await c.send(ANNA, g.id, { kind: 'file', mediaId: after, meta: { fileName: 'b.pdf' } });
    assert.equal((await host.mediaGet(LENA, before)).status, 404, 'from before Lena joined');
    assert.equal((await host.mediaGet(LENA, after)).status, 200);
    await c.as(MARC)('PATCH', `conversations/${g.id}`, { remove: [MARC.id] });
    assert.equal((await host.mediaGet(MARC, before)).status, 404, 'left');
    assert.equal((await host.mediaGet(MARC, after)).status, 404);
  });
});

test('mediaAccess: hidden ("delete for me") and deleted-for-everyone messages; an unsent upload is its uploader\'s only', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const a = await c.upload(ANNA, PNG, 'image/png');
    const m = await c.send(ANNA, d.id, { kind: 'image', mediaId: a });
    await c.as(MARC)('DELETE', `messages/${m.id}`, null, { for: 'me' });
    assert.equal((await host.mediaGet(MARC, a)).status, 404, 'hidden for Marc');
    assert.equal((await host.mediaGet(ANNA, a)).status, 200);
    const b = await c.upload(ANNA, PNG, 'image/png');
    const m2 = await c.send(ANNA, d.id, { kind: 'image', mediaId: b });
    await c.as(ANNA)('DELETE', `messages/${m2.id}`, null, { for: 'all' });
    assert.equal((await host.mediaGet(ANNA, b)).status, 404, 'deleted for everyone: nobody');
    const loose = await c.upload(LENA, PNG, 'image/png');
    assert.equal((await host.mediaGet(LENA, loose)).status, 200, 'not sent yet: the uploader');
    assert.equal((await host.mediaGet(ANNA, loose)).status, 404);
    // the file of the deleted message is removed from GateControl's store by the background run
    assert.ok(host.media.has(b));
    const out = await host.tick();
    assert.equal(out.media, 1);
    assert.equal(host.media.has(b), false);
    assert.equal(host.media.has(a), true, 'a hidden message keeps its file');
  });
});

test('group picture: an image the admin/a member uploaded, bound to the group, members only; the old one removed', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC]);
    const pic = await c.upload(MARC, PNG, 'image/png');
    let r = await c.as(MARC)('PATCH', `conversations/${g.id}`, { avatarMediaId: pic });
    assert.equal(r.status, 200);
    assert.equal(r.json.conversation.avatarMediaId, pic);
    assert.equal(r.json.conversation.avatarUrl, null, 'the apps load it through the media route');
    assert.equal(host.media.get(pic).claimed, true);
    assert.equal((await host.mediaGet(ANNA, pic)).status, 200);
    assert.equal((await host.mediaGet(OMA, pic)).status, 404);
    const portalView = (await c.as(ANNA, (u) => ({ ...u, portal: true, loggedIn: true }))('GET', `conversations/${g.id}`)).json.conversation;
    assert.match(portalView.avatarUrl, /^\/plugin-media\/[0-9a-f]{32}\./, 'the frame gets a signed URL');
    const pic2 = await c.upload(ANNA, PNG, 'image/png');
    await c.as(ANNA)('PATCH', `conversations/${g.id}`, { avatarMediaId: pic2 });
    await host.tick();
    assert.equal(host.media.has(pic), false, 'the replaced picture is deleted');
    assert.equal((await c.as(ANNA)('PATCH', `conversations/${g.id}`, { avatarMediaId: await c.upload(ANNA, PDF, 'application/pdf') })).json.code, 'media_invalid');
    r = await c.as(ANNA)('PATCH', `conversations/${g.id}`, { avatarMediaId: null });
    assert.equal(r.json.conversation.avatarMediaId, null);
  });
});

test('signed URLs: only for portal viewers (app answers carry none); they work and expire', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const img = await c.upload(ANNA, PNG, 'image/png');
    const thumb = await c.upload(ANNA, PNG, 'image/png');
    await c.send(ANNA, d.id, { kind: 'image', mediaId: img, thumbMediaId: thumb });
    const appMsg = (await c.as(MARC)('GET', `conversations/${d.id}/messages`)).json.messages[0];
    assert.deepEqual([appMsg.media.url, appMsg.media.thumbUrl], [null, null]);
    const portalMsg = (await c.as(MARC, (u) => ({ ...u, portal: true, loggedIn: true }))('GET', `conversations/${d.id}/messages`)).json.messages[0];
    assert.match(portalMsg.media.url, /^\/plugin-media\/[0-9a-f]{32}\.\d+\.3\.[A-Za-z0-9_-]{22}$/);
    assert.match(portalMsg.media.thumbUrl, new RegExp('^/plugin-media/' + thumb));
    assert.equal((await host.mediaFromUrl(portalMsg.media.url)).status, 200);
    assert.equal((await host.mediaFromUrl(portalMsg.media.url, { now: Date.now() + 7 * 3600000 })).status, 404, 'valid for 6 h');
    assert.equal((await c.as(OMA, (u) => ({ ...u, portal: true, loggedIn: true }))('GET', `conversations/${d.id}/messages`)).status, 404, 'a non-member gets no URL');
  });
});
