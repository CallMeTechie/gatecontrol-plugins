'use strict';

// "Auf TV/PC abspielen" (38 a): cast messages of the cast contract between the own devices, through the plugin.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, withJellyfin, withShare, MILA, JONAS, LENA } = require('./helpers');

const SESSION = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const play = (x = {}) => ({ v: 1, session: SESSION, seq: 0, at: 1764000000000, type: 'cast.play', source: { id: 'jf-1', kind: 'jellyfin' },
  item: { id: 'item-1', name: 'Kobaltnacht', kind: 'movie', runtimeMs: 6480000 }, positionMs: 2530000, audio: 1, subtitle: -1, from: 'Pixel 8', ...x });

test('targets: the own TVs and PCs, not the asking phone', async () => {
  const t = await setup();
  try {
    await withJellyfin(t);
    const r = await t.appReq(MILA, '11', 'GET', 'cast/targets');
    assert.deepEqual(r.devices.map((d) => [d.id, d.kind, d.online]), [['12', 'tv', true]]);
    const j = await t.appReq(JONAS, '21', 'GET', 'cast/targets');
    assert.deepEqual(j.devices, []);
  } finally { await t.host.close(); }
});

test('cast.play to the TV: a realtime event and a silent signal; commands and states as events while online', async () => {
  const t = await setup();
  try {
    await withJellyfin(t);
    let r = await t.appReq(MILA, '11', 'POST', `cast/${SESSION}/message`, { to: '12', body: play() });
    assert.equal(r.ok, true);
    assert.deepEqual(r.via, ['event', 'push']);
    const ev = t.host.events.at(-1);
    assert.equal(ev.type, 'media.cast');
    assert.deepEqual(ev.users, [1]);
    assert.equal(ev.data.to, '12');
    assert.equal(ev.data.from, '11');
    assert.equal(ev.data.body.type, 'cast.play');
    const push = t.host.notifications.at(-1);
    assert.equal(push.topic, 'media_signal');
    assert.deepEqual(push.devices, ['12']);
    assert.equal(push.data.kind, 'media.cast');
    // a command: only the event
    const n = t.host.notifications.length;
    r = await t.appReq(MILA, '11', 'POST', `cast/${SESSION}/message`, { to: '12', body: { v: 1, session: SESSION, seq: 1, at: 1764000005000, type: 'cast.cmd', cmd: 'seekBy', deltaMs: -10000 } });
    assert.deepEqual(r.via, ['event']);
    assert.equal(t.host.notifications.length, n);
    // the TV answers with its state
    r = await t.appReq(MILA, '12', 'POST', `cast/${SESSION}/message`, { to: '11', body: { v: 1, session: SESSION, seq: 1, at: 1764000006000, type: 'cast.state', state: 'playing', positionMs: 2531000, durationMs: 6480000,
      audio: [{ id: 'a:1', label: 'Deutsch', selected: true }], subtitles: [{ id: 'off', label: 'Aus', selected: true }], device: 'Wohnzimmer-TV' } });
    assert.deepEqual(r.via, ['event']);
    // stop: also as a push
    r = await t.appReq(MILA, '11', 'POST', `cast/${SESSION}/message`, { to: '12', body: { v: 1, session: SESSION, seq: 2, at: 1764000009000, type: 'cast.cmd', cmd: 'stop' } });
    assert.deepEqual(r.via, ['event', 'push']);
    // the handoff shortcut builds the cast.play itself
    r = await t.appReq(MILA, '11', 'POST', 'handoff', { to: '12', sourceId: 'jf-1', item: { id: 'item-2', name: 'Folge 3' }, positionMs: 1000 });
    assert.match(r.session, /^[0-9a-f]{24}$/);
    assert.equal(t.host.events.at(-1).data.body.seq, 0);
  } finally { await t.host.close(); }
});

test('a target that is offline gets the message as a silent signal only', async () => {
  const t = await setup();
  try {
    await withJellyfin(t);
    t.devices.find((d) => d.id === '12').online = false;
    const r = await t.appReq(MILA, '11', 'POST', `cast/${SESSION}/message`, { to: '12', body: { v: 1, session: SESSION, seq: 1, at: 1, type: 'cast.cmd', cmd: 'pause' } });
    assert.deepEqual(r.via, ['push']);
    assert.equal(r.online, false);
  } finally { await t.host.close(); }
});

test('refusals: another person\'s device, a source the person does not see, secrets, size, bad messages', async () => {
  const t = await setup();
  try {
    await withJellyfin(t);
    await withShare(t);
    // Jonas' PC is not Mila's
    let r = await t.appReq(MILA, '11', 'POST', `cast/${SESSION}/message`, { to: '21', body: play() });
    assert.equal(r.code, 'no_access');
    // Lena (child) may not cast a share she does not see
    t.devices.push({ id: '32', userId: 3, name: 'Lenas TV', platform: 'android', clientType: 'android-tv', online: true });
    r = await t.appReq(LENA, '31', 'POST', `cast/${SESSION}/message`, { to: '32', body: play({ source: { id: 'sh-1' }, item: { id: 'f:filme/a.mkv', path: 'a.mkv', name: 'A' } }) });
    assert.equal(r.code, 'no_access');
    // no secrets in messages
    r = await t.appReq(MILA, '11', 'POST', `cast/${SESSION}/message`, { to: '12', body: play({ source: { id: 'jf-1', accessToken: 'x' } }) });
    assert.equal(r.reason, 'secret');
    // too large
    r = await t.appReq(MILA, '11', 'POST', `cast/${SESSION}/message`, { to: '12', body: play({ item: { id: 'i', name: 'x'.repeat(4000) } }) });
    assert.equal(r.code, 'too_large');
    // session of the path and the body must match; unknown cmd; to itself
    r = await t.appReq(MILA, '11', 'POST', 'cast/bbbbbbbbbbbb/message', { to: '12', body: play() });
    assert.equal(r.code, 'invalid');
    r = await t.appReq(MILA, '11', 'POST', `cast/${SESSION}/message`, { to: '12', body: { v: 1, session: SESSION, seq: 1, at: 1, type: 'cast.cmd', cmd: 'explode' } });
    assert.equal(r.field, 'cmd');
    r = await t.appReq(MILA, '11', 'POST', `cast/${SESSION}/message`, { to: '11', body: play() });
    assert.equal(r.field, 'to');
  } finally { await t.host.close(); }
});

test('the rate limit per sending device (60 a minute)', async () => {
  const t = await setup();
  try {
    await withJellyfin(t);
    let last;
    for (let i = 0; i < 61; i++) last = await t.appReq(MILA, '12', 'POST', `cast/${SESSION}/message`, { to: '11', body: { v: 1, session: SESSION, seq: i + 1, at: 1, type: 'cast.state', state: 'playing', positionMs: i } });
    assert.equal(last.status, 429);
  } finally { await t.host.close(); }
});
