'use strict';

// The admin API: administrators in the admin UI only; numbers, storage, settings
// and errors — never a message, a title, a file name, a member or who writes to whom.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, portal, ADMIN, ANNA, MARC, LENA, PNG, PDF, OGG } = require('./helpers');

test('admin API: administrators of the admin UI only (not portal, not app, not users)', async () => {
  await withHost({}, async (host, c) => {
    assert.equal((await c.admin('GET', 'overview')).status, 200);
    for (const u of [ANNA, app(ADMIN), portal(ADMIN)]) {
      const r = await c.call(u, 'GET', 'admin/overview');
      assert.equal(r.status, 403, JSON.stringify(u));
    }
    assert.equal((await c.admin('GET', 'nope')).status, 404);
  });
});

test('overview: counts and storage per type — and no content anywhere in any admin answer', async () => {
  await withHost({}, async (host, c) => {
    const SECRETS = ['Geheimgruppe', 'Liebesbrief', 'Tagebuch.pdf', 'Versteck', 'Hochzeitstag'];
    const g = await c.group(ANNA, [MARC, LENA], 'Geheimgruppe');
    const d = await c.direct(ANNA, MARC);
    await c.send(ANNA, d.id, { text: 'Liebesbrief' });
    await c.send(ANNA, g.id, { kind: 'file', mediaId: await c.upload(ANNA, PDF, 'application/pdf'), meta: { fileName: 'Tagebuch.pdf' } });
    await c.send(MARC, g.id, { kind: 'image', mediaId: await c.upload(MARC, PNG, 'image/png'), text: 'Hochzeitstag' });
    await c.send(MARC, g.id, { kind: 'voice', mediaId: await c.upload(MARC, OGG, 'audio/ogg') });
    await c.send(LENA, g.id, { kind: 'location', location: { lat: 1, lon: 2, label: 'Versteck' } });
    await host.callService('sync_group', { caller: 'gatecontrol-familie', payload: { key: 'family', title: 'Familie', userIds: [ANNA.id] } });
    await host.callService('send_message', { caller: 'gatecontrol-familie', payload: { conversation: 'family', text: 'Hinweis' } });
    const o = (await c.admin('GET', 'overview')).json;
    assert.deepEqual(o.accounts, { total: 5, activeToday: 3, kiosk: 0 });
    assert.deepEqual(o.conversations, { total: 3, direct: 1, groups: 1, managed: 1, disappearing: 0 });
    assert.deepEqual(o.messages, { today: 6, fromPluginsToday: 1, last7Days: 6, total: 6 });
    assert.deepEqual(o.storage.byKind, { image: PNG.length, voice: OGG.length, file: PDF.length, avatar: 0 });
    assert.equal(o.storage.usage.quota, 10 * 1024 ** 3);
    assert.equal(o.license.licensed, true);
    const all = JSON.stringify([o, (await c.admin('GET', 'settings')).json, (await c.admin('GET', 'log')).json]);
    for (const s of SECRETS) assert.ok(!all.includes(s), s);
    for (const name of ['Anna', 'Marc', 'Lena']) assert.ok(!all.includes(name), name);
  });
});

test('settings: read with GateControl\'s media limits; partial update; only the offered values', async () => {
  await withHost({}, async (host, c) => {
    let r = (await c.admin('GET', 'settings')).json;
    assert.deepEqual(r.settings, {
      retentionDays: 0, allowDisappearing: true, editWindowMin: 15, maxVoiceS: 300, allowStories: true, allowActions: true,
      requestTtlMin: 15, requestApproversDefault: 'auto', childrenMayRequest: true, grantMaxDays: 7, // 1.5.0
      defaults: { readReceipts: true, typing: true, preview: true },
    });
    assert.deepEqual(r.options, {
      retentionDays: [0, 30, 90, 180, 365, 730], editWindowMin: [0, 5, 15, 60, 1440], maxVoiceS: [60, 120, 300, 600, 900], disappearingS: [0, 86400, 604800, 2592000],
      requestTtlMin: [5, 10, 15, 30, 60, 120, 240, 1440], requestApproversDefault: ['auto', 'parents', 'rights'], grantMaxDays: [1, 2, 3, 7, 14, 30],
    });
    assert.equal(r.familyRoles, false, 'no Familie here');
    assert.deepEqual([r.media.maxBytes, r.media.quota, r.media.types.length], [26214400, 10737418240, 24]);
    r = (await c.admin('PUT', 'settings', { retentionDays: 90, defaults: { preview: false } })).json;
    assert.equal(r.settings.retentionDays, 90);
    assert.deepEqual(r.settings.defaults, { readReceipts: true, typing: true, preview: false });
    assert.equal(r.settings.editWindowMin, 15, 'untouched');
    for (const body of [{ retentionDays: 31 }, { editWindowMin: 10 }, { maxVoiceS: 30 }, { allowDisappearing: 'no' }, { defaults: { typing: 1 } }, { defaults: [] }, null]) {
      assert.equal((await c.admin('PUT', 'settings', body)).json.code, 'invalid', JSON.stringify(body));
    }
  });
});

test('defaults for new accounts: apply to people who use the messenger for the first time', async () => {
  await withHost({}, async (host, c) => {
    const base = (p) => ({ readReceipts: p.readReceipts, typing: p.typing, preview: p.preview });
    assert.deepEqual(base((await c.as(ANNA)('GET', 'me')).json.prefs), { readReceipts: true, typing: true, preview: true });
    await c.admin('PUT', 'settings', { defaults: { readReceipts: false, typing: false, preview: false } });
    assert.deepEqual(base((await c.as(MARC)('GET', 'me')).json.prefs), { readReceipts: false, typing: false, preview: false });
    assert.deepEqual(base((await c.as(ANNA)('GET', 'me')).json.prefs), { readReceipts: true, typing: true, preview: true }, 'existing people keep theirs');
    assert.deepEqual(base((await c.as(MARC)('PUT', 'prefs', { preview: true })).json.prefs), { readReceipts: false, typing: false, preview: true });
  });
});

test('me: prefs, licence, features and limits for the apps', async () => {
  await withHost({}, async (host, c) => {
    const me = (await c.as(ANNA)('GET', 'me')).json;
    assert.deepEqual(me.user, { id: ANNA.id, name: 'Anna', avatarUrl: null, initials: 'AN', colorHex: '#22C55E' });
    assert.deepEqual(me.license, { licensed: true, state: 'valid', expiresAt: null });
    assert.equal(me.features.voice, true);
    assert.equal(me.features.bridges, false);
    // 1.3.0: flags for video meta and file previews (in the features object the released apps already read)
    assert.deepEqual([me.features.video_meta, me.features.file_thumbs], [true, true]);
    assert.deepEqual(me.limits, {
      maxBytes: 26214400, types: require('../plugin.json').media.types, quotaFull: false, editWindowS: 900, maxVoiceS: 300, textMax: 4000, thumbMaxBytes: 65536, thumbMaxSide: 640,
      imageMaxSide: 2048, groupMax: 256, titleMax: 80, pageMax: 100, typingS: 6, typingEveryS: 3, activeS: 30, disappearingS: [0, 86400, 604800, 2592000], retentionDays: 0,
      // 1.4.0
      statusTextMax: 60, storyTextMax: 700, storyTtlS: 86400, storyDurationsH: [1, 3, 6, 12, 24], storiesMax: 30, pollOptionsMax: 12, pollQuestionMax: 200, pollOptionMax: 80, eventTitleMax: 120,
      eventChecklistMax: 20, pinsMax: 3, listsMax: 20, remindersMax: 100, arrivalEveryS: 20, arrivalMaxS: 10800, arrivalRadiusM: 150,
      // 1.5.0
      requestTtlMin: 15, grantMaxDays: 7,
    });
    assert.ok(me.serverTime);
  });
});

test('log page: days 1…30, entries without content', async () => {
  await withHost({}, async (host, c) => {
    await host.callService('send_message', { caller: 'gatecontrol-familie', payload: { conversation: 'family', text: 'Geheimnis' } });
    const r = (await c.admin('GET', 'log', null, { days: '1' })).json;
    assert.equal(r.days, 1);
    assert.deepEqual(r.entries.map((e) => [e.level, e.code, e.detail, e.count]), [['error', 'service_refused', 'send_message: not_found', 1]]);
    assert.ok(!JSON.stringify(r).includes('Geheimnis'));
    assert.equal((await c.admin('GET', 'log', null, { days: '31' })).json.code, 'invalid');
  });
});

test('1.4.0 overview: counts only (statuses, stories, polls, events, arrivals, actions, blocks, reminders); switches for stories and home actions', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC]);
    await c.as(ANNA)('PUT', 'status', { preset: 'none', text: 'Geheimer Status' });
    await c.as(ANNA)('POST', 'status/stories', { kind: 'text', text: 'Geheime Story' });
    await c.send(ANNA, g.id, { kind: 'poll', poll: { question: 'Geheime Frage', options: ['a', 'b'] } });
    await c.send(ANNA, g.id, { kind: 'event', event: { title: 'Geheimer Termin', startsAt: new Date(Date.now() + 3600000).toISOString() } });
    await c.send(ANNA, g.id, { kind: 'arrival', arrival: { dest: { label: 'Geheim', lat: 1, lon: 1 } } });
    await c.as(ANNA)('POST', 'blocks', { userId: LENA.id });
    const o = (await c.admin('GET', 'overview')).json;
    assert.deepEqual(o.v14, { statusesActive: 1, storiesActive: 1, pollsOpen: 1, eventsUpcoming: 1, arrivalsLive: 1, actionMessages7Days: 0, cards7Days: 0, blocks: 1, remindersPending: 0, actionsAvailable: true });
    assert.ok(!JSON.stringify(o).includes('Geheim'), 'no content');
    const s = (await c.admin('PUT', 'settings', { allowStories: false, allowActions: false })).json.settings;
    assert.deepEqual([s.allowStories, s.allowActions], [false, false]);
    assert.equal((await c.admin('PUT', 'settings', { allowStories: 'no' })).json.code, 'invalid');
    const page = require('../server/ui').render({ view: 'page', page: 'overview', lang: 'de' }, (l, k) => require('../server/texts.json')[l][k] || k);
    for (const id of ['ms-v-status', 'ms-v-polls', 'ms-v-events', 'ms-v-actions', 'ms-allow-stories', 'ms-allow-actions']) assert.ok(page.includes(`id="${id}"`), id);
  });
});
