'use strict';

// 1.4.0 — the whole way of a ring into the family chat, as it failed in the field (the chime rang,
// no card in the chat „Familie“): Ring's dings/active restricted (an error / a 429 there no longer
// stops the poll — the location events are the only source then), a ring Ring lists late (taken up
// to 10 minutes; the push only up to 5), the card through the REAL Messenger plugin (its service
// hook in a second mock host: target 'family' = Familie's group, cleanCard with the picture and the
// action '<lockId>:open'), the fallback to the people's own channels without the group, and the
// diagnosis on the page „Einstellungen“ and in GET /me.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');
const cameras = require('../server/cameras');
const { withDoor, ringLogin, app, USERS, ANNA, MARC, LENA, GAST, SEC, MIN, jpeg } = require('./helpers');

const MSG_DIR = path.join(__dirname, '..', '..', 'gatecontrol-messenger');

/** The Messenger plugin in its own mock host, offered to the door as the provider of send_message. */
async function withMessenger(fn, { group = true } = {}) {
  const msg = await createHost(MSG_DIR, { users: USERS, gatecontrol: '1.180.0' });
  await msg.start();
  const provider = {
    plugin: 'gatecontrol-messenger', provides: ['send_message'],
    service: (c) => msg.callService(c.name, { caller: c.caller, user: c.user, payload: c.payload }),
  };
  try {
    return await withDoor({ services: [provider], gatecontrol: '1.180.0' }, async (host, ctx) => {
      if (group) {
        const g = await msg.callService('sync_group', { caller: 'gatecontrol-familie', user: null, payload: { key: 'family', title: 'Familie', userIds: [ANNA.id, MARC.id, LENA.id] } });
        assert.equal(g.ok, true);
      }
      await ringLogin(ctx);
      const cams = (await ctx.admin('GET', 'status')).json.cameras;
      for (const c of cams) assert.equal((await ctx.admin('PATCH', `cameras/${c.id}`, { lockId: ctx.lockId })).status, 200);
      const chats = async (u) => (await msg.request({ method: 'GET', path: 'conversations', query: {}, body: null, user: app(u), lang: 'de' })).json.conversations;
      const messages = async (u, convId) => (await msg.request({ method: 'GET', path: `conversations/${convId}/messages`, query: {}, body: null, user: app(u), lang: 'de' })).json.messages;
      return fn(host, { ...ctx, msg, chats, messages });
    });
  } finally {
    await msg.close();
  }
}

const event = (id, agoMs, kind = 'ding') => ({ ding_id_str: String(id), doorbot_id: 111, kind, created_at: new Date(Date.now() - agoMs).toISOString() });
const settings = async (ctx) => (await ctx.admin('GET', 'settings')).json.chat;

test('dings/active refused by Ring: the poll goes on with the location events (every 15 s); the ring reaches the family chat through the real messenger', () => withMessenger(async (host, ctx) => {
  const { cloud, clock, lockId } = ctx;
  cloud.ring.activeStatus = 500;
  await host.tick();
  let st = (await ctx.admin('GET', 'status')).json.ring;
  assert.deepEqual([st.state, st.broken], ['ok', false], 'no "Ring-Verbindung gestört" for dings/active alone');
  let ch = await settings(ctx);
  assert.equal(ch.detect.active.state, 'off');
  assert.equal(ch.detect.active.code, 'ring_error');
  assert.equal(ch.detect.lastDing, null);
  // the ring as Ring lists it: 40 s after it rang
  cloud.ring.events = [event(7001, 40 * SEC)];
  const before = cloud.calls.filter((c) => /\/events\?/.test(c.url)).length;
  clock.add(15 * SEC);
  await host.tick();
  assert.equal(cloud.calls.filter((c) => /\/events\?/.test(c.url)).length, before + 1, 'events every 15 s while dings/active is off');
  assert.equal(cloud.calls.filter((c) => c.url.includes('dings/active')).length, 1, 'dings/active not asked again for 10 minutes');
  // push as before
  assert.ok(host.notifications.some((n) => n.topic === 'doorbell' && n.users.includes(ANNA.id)));
  // the card in Familie's group, with the picture and „Tür öffnen“
  assert.equal(host.serviceCalls.length, 1);
  const fam = (await ctx.chats(ANNA)).find((c) => c.managedBy === 'gatecontrol-familie');
  const card = (await ctx.messages(ANNA, fam.id)).find((m) => m.kind === 'card');
  assert.ok(card, 'the card is in the chat „Familie“');
  assert.equal(card.card.kind, 'doorbell');
  assert.equal(card.card.title, 'Klingel · Haustür');
  assert.deepEqual(card.card.image, { mime: 'image/jpeg', bytes: jpeg().length });
  assert.deepEqual(card.card.actions.map((a) => [a.plugin, a.actionId]), [['gatecontrol-door', `${lockId}:open`]]);
  // the diagnosis: seen 40 s late through the event list, handled; the chat result
  ch = await settings(ctx);
  assert.deepEqual({ ...ch.detect.lastDing, at: undefined, seenAt: undefined }, { at: undefined, seenAt: undefined, delayS: 55, source: 'events', camera: 'Klingel Haustür', outcome: 'handled', pushed: true });
  assert.deepEqual([ch.last.ok, ch.last.error, ch.last.image, ch.last.fallback], [true, null, true, null]);
  const me = (await ctx.call(app(LENA), 'GET', '/me')).json.doorbell;
  assert.deepEqual(me, { lastRingAt: ch.detect.lastDing.at, source: 'events', chat: { at: ch.last.at, ok: true, error: null, fallback: false } });
  // after 10 minutes dings/active is asked again — and used when it answers
  cloud.ring.activeStatus = null;
  clock.add(10 * MIN);
  await host.tick();
  assert.equal((await settings(ctx)).detect.active.state, 'ok');
  cloud.ring.active = [{ id: 7002, id_str: '7002', doorbot_id: 111, kind: 'ding', now: Date.now() / 1000, expires_in: 60 }];
  clock.add(5 * SEC);
  await host.tick();
  assert.equal((await settings(ctx)).detect.lastDing.source, 'active');
  assert.equal(host.serviceCalls.length, 2);
}));

test('a 429 on dings/active: switched off for Retry-After, no back-off of the whole poll — rings still come from the event list', () => withMessenger(async (host, ctx) => {
  const { cloud, clock } = ctx;
  cloud.ring.activeStatus = 429;
  cloud.ring.activeRetry = '1200';
  await host.tick();
  assert.equal(cameras.blocked(Date.now()), false);
  const ch = await settings(ctx);
  assert.deepEqual([ch.detect.active.state, ch.detect.active.code], ['off', 'ring_rate_limited']);
  assert.equal(Date.parse(ch.detect.active.offUntil) - Date.now(), 1200 * SEC);
  cloud.ring.events = [event(7101, 10 * SEC)];
  clock.add(15 * SEC);
  await host.tick();
  assert.equal(host.serviceCalls.length, 1);
  assert.equal((await settings(ctx)).last.ok, true);
}));

test('a ring Ring lists late: ≤ 5 min push and card, ≤ 10 min card and history without push, older → only the diagnosis; never twice', () => withMessenger(async (host, ctx) => {
  const { cloud, clock } = ctx;
  await host.tick();
  const pushes = () => host.notifications.filter((n) => n.topic === 'doorbell').length;
  const history = async () => (await ctx.admin('GET', 'history', null, { kind: 'ding' })).json.items.length;
  // 4 minutes late (e.g. after a back-off): push and card — before 1.4.0 it was dropped after 2 minutes
  cloud.ring.events = [event(7201, 4 * MIN)];
  clock.add(31 * SEC);
  await host.tick();
  assert.deepEqual([pushes(), host.serviceCalls.length, await history()], [2, 1, 1], 'push (opener + viewers), card, history');
  // 7 minutes late: card and history, no push
  cloud.ring.events = [event(7202, 7 * MIN), event(7201, 4 * MIN + 31 * SEC)];
  clock.add(31 * SEC);
  await host.tick();
  assert.deepEqual([pushes(), host.serviceCalls.length, await history()], [2, 2, 2]);
  let d = (await settings(ctx)).detect.lastDing;
  assert.deepEqual([d.outcome, d.pushed, d.source], ['handled', false, 'events']);
  // 11 minutes: too old — noted for the page, nothing sent
  cloud.ring.events = [event(7203, 11 * MIN)];
  clock.add(31 * SEC);
  await host.tick();
  assert.deepEqual([pushes(), host.serviceCalls.length, await history()], [2, 2, 2]);
  d = (await settings(ctx)).detect.lastDing;
  assert.equal(d.outcome, 'too_old');
  // the same rings again (a restart forgets what it saw — the history's ext_id does not)
  cameras.reset();
  cloud.ring.events = [event(7201, 6 * MIN), event(7202, 8 * MIN)];
  clock.add(31 * SEC);
  await host.tick();
  assert.deepEqual([pushes(), host.serviceCalls.length, await history()], [2, 2, 2], 'never twice');
  // motion keeps the 2 minutes
  cloud.ring.events = [event(7204, 3 * MIN, 'motion')];
  clock.add(31 * SEC);
  await host.tick();
  assert.equal((await ctx.admin('GET', 'history', null, { kind: 'motion' })).json.items.length, 0);
}));

test('no group „Familie“ (not_found): the card goes to the people of the ring\'s push, each in their own channel „Tür & Kamera“', () => withMessenger(async (host, ctx) => {
  const { cloud, clock, lockId } = ctx;
  // Marc switched the doorbell push off for this camera: he gets no channel message either
  const bell = (await ctx.admin('GET', 'status')).json.cameras.find((c) => c.doorbell);
  await ctx.admin('PUT', `rights/${MARC.id}`, { cameras: { [bell.id]: { ding: false } } });
  await host.tick();
  cloud.ring.events = [event(7301, 20 * SEC)];
  clock.add(31 * SEC);
  await host.tick();
  assert.equal(host.serviceCalls.length, 2);
  assert.equal(host.serviceCalls[0].payload.conversation, 'family');
  assert.deepEqual(host.serviceCalls[1].payload.conversation, [`user:${ANNA.id}`, `user:${LENA.id}`]);
  assert.equal(host.serviceCalls[1].payload.title, 'Tür & Kamera');
  for (const u of [ANNA, LENA]) {
    const conv = (await ctx.chats(u)).find((c) => c.managedBy === 'gatecontrol-door');
    assert.ok(conv, `${u.name}: own channel`);
    assert.deepEqual([conv.title, conv.readonly, conv.members.map((m) => m.userId)], ['Tür & Kamera', true, [u.id]]);
    const card = (await ctx.messages(u, conv.id)).find((m) => m.kind === 'card');
    assert.deepEqual([card.card.title, card.card.actions[0].actionId, !!card.card.image], ['Klingel · Haustür', `${lockId}:open`, true]);
  }
  assert.equal((await ctx.chats(MARC)).filter((c) => c.managedBy === 'gatecontrol-door').length, 0);
  assert.equal((await ctx.chats(GAST)).length, 0);
  const ch = await settings(ctx);
  assert.deepEqual([ch.last.ok, ch.last.error, ch.last.fallback], [true, null, { to: 2, sent: 2, failed: 0 }]);
  assert.deepEqual((await ctx.call(app(ANNA), 'GET', '/me')).json.doorbell.chat.fallback, true);
}, { group: false }));

test('the page „Einstellungen“: the diagnosis card and its texts (de/en), every chat reason explained', () => {
  const ui = require('../server/ui');
  const texts = require('../server/texts.json');
  const html = ui.render({ view: 'page', page: 'settings', lang: 'de' }, require('../server/index')._t);
  for (const id of ['dr-diag', 'dr-d-ding', 'dr-d-chat', 'dr-d-active']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('Klingel-Diagnose'));
  const keys = ['diag.title', 'diag.hint', 'diag.ding', 'diag.ding_none', 'diag.ding_v', 'diag.src_active', 'diag.src_events', 'diag.out_handled', 'diag.out_handled_late',
    'diag.out_too_old', 'diag.out_no_camera', 'diag.out_failed', 'diag.chat', 'diag.chat_none', 'diag.chat_ok', 'diag.chat_image', 'diag.chat_fallback', 'diag.chat_err',
    'diag.active', 'diag.active_none', 'diag.active_ok', 'diag.active_off'];
  for (const code of ['not_found', 'unavailable', 'rate_limit', 'timeout', 'too_big', 'invalid', 'forbidden', 'failed']) keys.push(`chat_reason.${code}`);
  for (const k of keys) assert.ok(texts.de[k] && texts.en[k], k);
});
