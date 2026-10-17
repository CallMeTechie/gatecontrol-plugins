'use strict';

// Background: disappearing messages (deleted for good with reactions and files,
// event 'expired'), retention, the administrator switching disappearing chats off.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, MIN, HOUR, DAY, PNG } = require('./helpers');

test('disappearing: messages carry expiresAt and are deleted for good after it — files, reactions, hidden marks', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const before = await c.send(ANNA, d.id, { text: 'bleibt' });
    await c.as(MARC)('PATCH', `conversations/${d.id}`, { disappearingS: 86400 });
    const sys = (await c.as(ANNA)('GET', `conversations/${d.id}/messages`)).json.messages.pop();
    assert.deepEqual(sys.system, { event: 'disappearing', by: MARC.id, seconds: 86400 });
    const img = await c.upload(ANNA, PNG, 'image/png');
    const m = await c.send(ANNA, d.id, { kind: 'image', mediaId: img });
    assert.equal(m.expiresAt, new Date(Date.now() + DAY).toISOString());
    assert.equal(before.expiresAt, null, 'messages from before keep');
    await c.as(MARC)('PUT', `messages/${m.id}/reaction`, { emoji: '👍' });
    await c.as(MARC)('DELETE', `messages/${m.id}`);
    c.clock.add(DAY - MIN);
    let out = await host.tick();
    assert.equal(out.expired, 0);
    c.clock.add(2 * MIN);
    c.resetEvents();
    out = await host.tick();
    assert.equal(out.expired, 2, 'the image and the system message sent after switching on');
    assert.equal(out.media, 1);
    assert.equal(host.media.has(img), false);
    const ev = c.events('message.delete');
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].users.sort(), ev[0].data.reason, ev[0].data.messageIds.includes(m.id)], [[ANNA.id, MARC.id], 'expired', true]);
    const left = (await c.as(ANNA)('GET', `conversations/${d.id}/messages`)).json.messages.map((x) => x.text);
    assert.deepEqual(left, ['bleibt']);
    for (const t of ['reactions', 'hidden']) assert.equal((await host.gc.db.get(`SELECT COUNT(*) AS n FROM ${t}`)).row.n, 0, t);
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM media')).row.n, 0);
  });
});

test('disappearing switched off by the administrator: no new timers (switching off still works); me tells the apps', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC]);
    await c.as(ANNA)('PATCH', `conversations/${g.id}`, { disappearingS: 604800 });
    await c.admin('PUT', 'settings', { allowDisappearing: false });
    assert.equal((await c.as(ANNA)('PATCH', `conversations/${g.id}`, { disappearingS: 86400 })).json.code, 'disappearing_off');
    let conv = (await c.as(ANNA)('GET', `conversations/${g.id}`)).json.conversation;
    assert.equal(conv.can.setDisappearing, true, 'a chat that still has a timer may switch it off');
    assert.equal((await c.as(ANNA)('PATCH', `conversations/${g.id}`, { disappearingS: 0 })).status, 200);
    conv = (await c.as(ANNA)('GET', `conversations/${g.id}`)).json.conversation;
    assert.equal(conv.can.setDisappearing, false);
    assert.equal((await c.as(ANNA)('GET', 'me')).json.features.disappearing, false);
  });
});

test('retention: older messages go hourly (with their files), unlimited by default', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const img = await c.upload(ANNA, PNG, 'image/png');
    await c.send(ANNA, d.id, { kind: 'image', mediaId: img });
    c.clock.add(40 * DAY);
    await c.send(ANNA, d.id, { text: 'neu' });
    assert.equal((await host.tick()).retention, 0, 'unlimited');
    await c.admin('PUT', 'settings', { retentionDays: 30 });
    c.clock.add(HOUR);
    c.resetEvents();
    const out = await host.tick();
    assert.equal(out.retention, 1);
    assert.equal(host.media.has(img), false);
    assert.equal(c.events('message.delete')[0].data.reason, 'retention');
    assert.deepEqual((await c.as(MARC)('GET', `conversations/${d.id}/messages`)).json.messages.map((m) => m.text), ['neu']);
    assert.equal((await c.as(MARC)('GET', 'me')).json.limits.retentionDays, 30);
  });
});
