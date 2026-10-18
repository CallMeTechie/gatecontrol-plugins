'use strict';

// 1.4.0: status line (presets, audience, expiry, dnd, auto_place through set_place_status) and stories
// (24 h, audience, seen / viewers, reactions as direct messages, files only for the audience, clean-up).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, OMA, MIN, HOUR, PNG, T0 } = require('./helpers');

const FAM = 'gatecontrol-familie';
const family = (host, ids) => host.callService('sync_group', { caller: FAM, payload: { key: 'family', title: 'Familie', userIds: ids } });

test('status: presets, text ≤ 60, until, audience all / family / custom, events, delete', async () => {
  await withHost({}, async (host, c) => {
    const anna = c.as(ANNA);
    let r = await anna('PUT', 'status', { preset: 'homeoffice', text: 'Im Homeoffice bis 17 Uhr', until: new Date(T0 + 2 * HOUR).toISOString() });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.status.preset, r.json.status.text, r.json.status.visibility, r.json.status.until], ['homeoffice', 'Im Homeoffice bis 17 Uhr', 'all', new Date(T0 + 2 * HOUR).toISOString()]);
    assert.ok(c.events('status.update').some((e) => e.users.includes(MARC.id) && e.data.userId === ANNA.id));
    const feed = (await c.as(MARC)('GET', 'status/feed')).json;
    const it = feed.items.find((x) => x.user.id === ANNA.id);
    assert.equal(it.status.text, 'Im Homeoffice bis 17 Uhr');
    assert.equal(it.status.visibility, undefined, 'the audience is the owner\'s business');
    for (const bad of [{ preset: 'x' }, { preset: 'none' }, { preset: 'away', text: 'x'.repeat(61) }, { preset: 'dnd', until: new Date(T0 - 1).toISOString() },
      { preset: 'dnd', visibility: 'custom' }, { preset: 'homeoffice', eta: new Date(T0).toISOString() }]) {
      assert.equal((await anna('PUT', 'status', bad)).json.code, 'invalid', JSON.stringify(bad));
    }
    // away with eta and destination; custom audience
    r = await anna('PUT', 'status', { preset: 'away', text: 'Unterwegs', eta: new Date(T0 + HOUR).toISOString(), destLabel: 'Oma', visibility: 'custom', userIds: [LENA.id] });
    assert.deepEqual([r.json.status.destLabel, r.json.status.userIds], ['Oma', [LENA.id]]);
    assert.equal((await c.as(MARC)('GET', 'status/feed')).json.items.find((x) => x.user.id === ANNA.id), undefined, 'not in the custom audience');
    assert.equal((await c.as(LENA)('GET', 'status/feed')).json.items.find((x) => x.user.id === ANNA.id).status.destLabel, 'Oma');
    // family: the Familie group's members; without Familie it is "all"
    await anna('PUT', 'status', { preset: 'none', text: 'Hallo', visibility: 'family' });
    assert.ok((await c.as(OMA)('GET', 'status/feed')).json.items.some((x) => x.user.id === ANNA.id), 'no Familie: everyone');
    await family(host, [ANNA.id, MARC.id]);
    assert.ok(!(await c.as(OMA)('GET', 'status/feed')).json.items.some((x) => x.user.id === ANNA.id));
    assert.ok((await c.as(MARC)('GET', 'status/feed')).json.items.some((x) => x.user.id === ANNA.id));
    // own status, the default audience from the privacy settings
    await anna('PUT', 'prefs', { privacy: { statusDefault: 'family' } });
    r = await anna('PUT', 'status', { preset: 'dnd' });
    assert.equal(r.json.status.visibility, 'family');
    assert.equal((await anna('GET', 'status')).json.status.preset, 'dnd');
    assert.equal((await anna('DELETE', 'status')).json.status, null);
    assert.equal((await anna('GET', 'status')).json.status, null);
    // stored encrypted
    await anna('PUT', 'status', { preset: 'none', text: 'Geheimer Text' });
    const row = await host.gc.db.get('SELECT text_enc FROM statuses WHERE user_id = ?', [ANNA.id]);
    assert.ok(row.row.text_enc.startsWith('v1.') && !row.row.text_enc.includes('Geheim'));
  });
});

test('status: expires (background run), dnd stops chat pushes, auto_place shows Familie\'s place by privacy', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    await c.as(MARC)('PUT', 'status', { preset: 'dnd', until: new Date(T0 + 30 * MIN).toISOString() });
    await c.send(ANNA, d.id, { text: 'Hallo?' });
    assert.equal(c.pushes().length, 0, 'dnd: no push');
    assert.equal((await c.as(MARC)('GET', `conversations/${d.id}`)).json.conversation.unread, 1, 'the message arrives');
    c.clock.add(31 * MIN);
    await host.tick();
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM statuses')).row.n, 0, 'expired rows go');
    await c.send(ANNA, d.id, { text: 'Jetzt?' });
    assert.equal(c.pushes().length, 1);
    // auto_place
    await family(host, [ANNA.id, MARC.id, LENA.id]);
    await c.as(LENA)('PUT', 'status', { preset: 'auto_place' });
    let r = await host.callService('set_place_status', { caller: FAM, payload: { userId: LENA.id, place: 'Schule' } });
    assert.deepEqual(r, { ok: true, applied: true });
    assert.equal((await c.as(ANNA)('GET', 'status/feed')).json.items.find((x) => x.user.id === LENA.id).status.text, 'Schule', 'placeInStatus family (default)');
    assert.ok(!((await c.as(OMA)('GET', 'status/feed')).json.items.find((x) => x.user.id === LENA.id) || { status: { place: null } }).status.place, 'not family: no place');
    await c.as(LENA)('PUT', 'prefs', { privacy: { placeInStatus: 'nobody' } });
    assert.equal((await c.as(ANNA)('GET', 'status/feed')).json.items.find((x) => x.user.id === LENA.id).status.place, null);
    assert.equal((await c.as(LENA)('GET', 'status')).json.status.place, 'Schule', 'the owner always sees it');
    // only Familie may report places; only auto_place shows them
    assert.deepEqual(await host.callService('set_place_status', { caller: 'gatecontrol-other', payload: { userId: LENA.id, place: 'x' } }), { ok: false, code: 'forbidden' });
    r = await host.callService('set_place_status', { caller: FAM, payload: { userId: ANNA.id, place: 'Zuhause' } });
    assert.deepEqual(r, { ok: true, applied: false });
    assert.deepEqual(await host.callService('set_place_status', { caller: FAM, payload: { userId: 99, place: 'x' } }), { ok: false, code: 'invalid' });
  });
});

test('stories: text and image, audience, feed order (unseen first), seen, viewers, reactions, files, expiry', async () => {
  await withHost({}, async (host, c) => {
    const anna = c.as(ANNA);
    let r = await anna('POST', 'status/stories', { kind: 'text', text: 'Sonntag Grillen!', bg: '#7C3AED', font: 'serif' });
    assert.equal(r.status, 200);
    const s1 = r.json.story;
    assert.deepEqual([s1.kind, s1.text, s1.bg, s1.font, s1.viewerCount, s1.expiresAt], ['text', 'Sonntag Grillen!', '#7C3AED', 'serif', 0, new Date(T0 + 24 * HOUR).toISOString()]);
    assert.ok(c.events('story.new').some((e) => e.users.includes(MARC.id)));
    const img = await c.upload(ANNA, PNG, 'image/png');
    c.clock.add(MIN);
    r = await anna('POST', 'status/stories', { kind: 'image', mediaId: img, text: 'Garten', visibility: 'custom', userIds: [MARC.id] });
    const s2 = r.json.story;
    assert.equal(host.media.get(img).claimed, true);
    await c.as(LENA)('POST', 'status/stories', { kind: 'text', text: 'Lena' });
    // 1.4.1: a chosen duration
    const short = (await c.as(LENA)('POST', 'status/stories', { kind: 'text', text: 'Kurz', durationH: 3 })).json.story;
    assert.equal(short.expiresAt, new Date(T0 + MIN + 3 * HOUR).toISOString());
    await c.as(LENA)('DELETE', `status/stories/${short.id}`);
    // bad bodies
    for (const bad of [{ kind: 'text', text: 'x', durationH: 2 }, { kind: 'text', text: 'x', durationH: '24' }, { kind: 'text' }, { kind: 'text', text: 'x', bg: 'red' }, { kind: 'text', text: 'x', font: 'comic' }, { kind: 'image' }, { kind: 'video', mediaId: await c.upload(ANNA, PNG, 'image/png') }, { kind: 'audio' }]) {
      const x = await anna('POST', 'status/stories', bad);
      assert.ok(x.status >= 400, JSON.stringify(bad));
    }
    // Marc sees both of Anna's, Oma only the text one; unseen first
    let feed = (await c.as(MARC)('GET', 'status/feed')).json;
    const a = feed.items.find((x) => x.user.id === ANNA.id);
    assert.deepEqual(a.stories.map((x) => x.id), [s1.id, s2.id]);
    assert.equal(a.unseen, true);
    assert.deepEqual((await c.as(OMA)('GET', 'status/feed')).json.items.find((x) => x.user.id === ANNA.id).stories.map((x) => x.id), [s1.id]);
    // files: the audience only
    assert.equal((await host.mediaGet(MARC, img)).status, 200);
    assert.equal((await host.mediaGet(OMA, img)).status, 404);
    assert.equal((await host.mediaGet(ANNA, img)).status, 200);
    // seen → Anna moves behind Lena in Marc's feed
    await c.as(MARC)('POST', `status/stories/${s1.id}/seen`);
    await c.as(MARC)('POST', `status/stories/${s2.id}/seen`);
    feed = (await c.as(MARC)('GET', 'status/feed')).json;
    assert.deepEqual(feed.items.map((x) => [x.user.id, x.unseen]), [[LENA.id, true], [ANNA.id, false]]);
    assert.equal((await c.as(OMA)('POST', `status/stories/${s2.id}/seen`)).status, 404, 'not in the audience');
    // a reaction: a direct message to Anna with replyStory
    r = await c.as(MARC)('POST', `status/stories/${s1.id}/react`, { emoji: '🔥' });
    assert.equal(r.status, 200);
    assert.equal(r.json.message.text, '🔥');
    assert.deepEqual(r.json.message.replyStory, { storyId: s1.id, ownerId: ANNA.id, preview: { kind: 'text', text: 'Sonntag Grillen!', thumbMediaId: null } });
    assert.equal(c.pushes().pop().users[0], ANNA.id);
    // a written reply with replyStory
    const reply = await c.send(LENA, (await c.direct(LENA, ANNA)).id, { text: 'Bin dabei', replyStory: { storyId: s1.id } });
    assert.equal(reply.replyStory.storyId, s1.id);
    assert.equal((await c.as(OMA)('POST', `conversations/${(await c.direct(OMA, MARC)).id}/messages`, { clientId: c.cid(), text: 'x', replyStory: { storyId: s1.id } })).json.code, 'invalid', 'only to the owner');
    // viewers (own only)
    const v = (await anna('GET', `status/stories/${s1.id}/viewers`)).json.viewers;
    assert.deepEqual(v.map((x) => [x.user.id, x.reaction]), [[MARC.id, '🔥']]);
    assert.equal((await c.as(MARC)('GET', `status/stories/${s1.id}/viewers`)).status, 404);
    assert.equal((await anna('GET', 'status/feed')).json.me.stories.find((x) => x.id === s1.id).viewerCount, 1);
    // delete one; the rest expires after 24 h with its files
    assert.equal((await c.as(MARC)('DELETE', `status/stories/${s1.id}`)).status, 404);
    assert.equal((await anna('DELETE', `status/stories/${s1.id}`)).status, 200);
    c.resetEvents();
    c.clock.add(24 * HOUR);
    await host.tick();
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM stories')).row.n, 0);
    assert.ok(c.events('story.remove').some((e) => e.data.storyId === s2.id));
    assert.equal(host.media.has(img), false, 'the file is deleted');
  });
});

test('stories: the administrator can switch them off; blocks hide status and stories both ways', async () => {
  await withHost({}, async (host, c) => {
    await c.as(ANNA)('POST', 'status/stories', { kind: 'text', text: 'Hi' });
    await c.as(ANNA)('PUT', 'status', { preset: 'none', text: 'Da' });
    await c.as(ANNA)('POST', 'blocks', { userId: MARC.id });
    assert.equal((await c.as(MARC)('GET', 'status/feed')).json.items.find((x) => x.user.id === ANNA.id), undefined);
    await c.as(MARC)('PUT', 'status', { preset: 'none', text: 'Marc' });
    assert.equal((await c.as(ANNA)('GET', 'status/feed')).json.items.find((x) => x.user.id === MARC.id), undefined);
    await c.as(ANNA)('DELETE', `blocks/${MARC.id}`);
    assert.ok((await c.as(MARC)('GET', 'status/feed')).json.items.find((x) => x.user.id === ANNA.id));
    await c.admin('PUT', 'settings', { allowStories: false });
    assert.equal((await c.as(ANNA)('POST', 'status/stories', { kind: 'text', text: 'x' })).json.code, 'feature_off');
    const me = (await c.as(ANNA)('GET', 'me')).json;
    assert.equal(me.features.stories, undefined);
    assert.equal(me.features.status, true);
    assert.deepEqual((await c.as(MARC)('GET', 'status/feed')).json.items.find((x) => x.user.id === ANNA.id).stories, []);
  });
});
