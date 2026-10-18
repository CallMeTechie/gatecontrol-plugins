'use strict';

// The doorbell in the family chat (1.3.0): a ring → send_message { conversation: 'family', card } to
// the Messenger (a stand-in provider of the mock host's services), with the picture and the lock's
// „open“ quick action; without the picture when the host refuses the size; the switch on the page
// „Einstellungen“; nothing breaks without the messenger or on an older GateControl.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const chat = require('../server/chat');
const { withDoor, ringLogin, ANNA, MARC, LENA, MIN, jpeg, DIR } = require('./helpers');

const MSG = 'gatecontrol-messenger';

function messenger(o = {}) {
  const m = {
    plugin: MSG, provides: o.provides || ['send_message'], got: [], answer: o.answer || null,
    service: async (c) => { m.got.push({ name: c.name, caller: c.caller, payload: c.payload }); return m.answer ? m.answer(c) : { ok: true, messageId: m.got.length }; },
  };
  return m;
}

async function linkCameras(admin, lockId) {
  const cams = (await admin('GET', 'status')).json.cameras;
  for (const c of cams) assert.equal((await admin('PATCH', `cameras/${c.id}`, { lockId })).status, 200);
  return cams;
}

let dingId = 9000;
async function ding(host, ctx) {
  dingId++;
  ctx.cloud.ring.active = [{ id: dingId, id_str: String(dingId), doorbot_id: 111, kind: 'ding', state: 'ringing', now: Date.now() / 1000, expires_in: 60 }];
  await host.tick();
  ctx.cloud.ring.active = [];
}

test('a ring → a card in the family chat: title, text, picture, the lock\'s „open“ quick action; once per ring, motion never', () => {
  const m = messenger();
  return withDoor({ services: [m] }, async (host, ctx) => {
    await ringLogin(ctx);
    await linkCameras(ctx.admin, ctx.lockId);
    await ding(host, ctx);
    await host.tick();
    assert.equal(m.got.length, 1);
    const { name, caller, payload } = m.got[0];
    assert.deepEqual([name, caller], ['send_message', 'gatecontrol-door']);
    assert.deepEqual(Object.keys(payload), ['conversation', 'card']);
    assert.equal(payload.conversation, 'family');
    assert.deepEqual({ ...payload.card, imageBase64: undefined }, {
      kind: 'doorbell', title: 'Klingel · Haustür', text: 'Klingel Haustür · 10:00', actions: [`${ctx.lockId}:open`], imageBase64: undefined,
    });
    assert.ok(Buffer.from(payload.card.imageBase64, 'base64').equals(jpeg()), 'the ring\'s JPEG');
    assert.ok(host.notifications.some((n) => n.topic === 'doorbell'), 'the pushes as before');
    // the action is the push's quick action: it runs through the door's checks
    assert.equal((await host.runQuickAction(ANNA, payload.card.actions[0], 'de', { via: 'notification' })).body.ok, true);
    // motion never goes into the chat
    ctx.clock.add(MIN);
    ctx.cloud.ring.active = [{ id: 9500, id_str: '9500', doorbot_id: 111, kind: 'motion', now: Date.now() / 1000, expires_in: 60 }];
    await host.tick();
    assert.equal(m.got.length, 1);
    const st = (await ctx.admin('GET', 'settings')).json;
    assert.deepEqual([st.config.familyChat, st.chat.api, st.chat.available, st.chat.last.ok, st.chat.last.image], [true, true, null, true, true], 'available unknown on GateControl 1.177.0');
  });
});

test('no linked lock / no „open“: the camera\'s name, no action; a lock without open (only lock/unlock)', () => {
  const m = messenger();
  return withDoor({ services: [m], lock: { actions: ['lock', 'unlock'] } }, async (host, ctx) => {
    await ringLogin(ctx);
    await ding(host, ctx);
    assert.deepEqual([m.got[0].payload.card.title, m.got[0].payload.card.actions], ['Klingel · Klingel Haustür', []], 'not linked: the camera');
    await linkCameras(ctx.admin, ctx.lockId);
    ctx.clock.add(MIN);
    await ding(host, ctx);
    assert.deepEqual([m.got[1].payload.card.title, m.got[1].payload.card.actions], ['Klingel · Haustür', []], 'the lock cannot open');
  });
});

test('a picture over the host\'s 16 KB: the card once more without it; the messenger refusing the picture as well; English texts', () => {
  const m = messenger();
  return withDoor({ services: [m] }, async (host, ctx) => {
    await ringLogin(ctx);
    await linkCameras(ctx.admin, ctx.lockId);
    await ctx.admin('PUT', 'settings', { notifyLang: 'en' });
    ctx.cloud.ring.snapshot = jpeg(640, 360, 20000);
    await ding(host, ctx);
    assert.equal(m.got.length, 1, 'the refused call never reached the messenger');
    assert.equal(m.got[0].payload.card.imageBase64, undefined);
    assert.deepEqual([m.got[0].payload.card.title, m.got[0].payload.card.text], ['Doorbell · Haustür', 'Klingel Haustür · 10:00']);
    assert.equal((await ctx.admin('GET', 'settings')).json.chat.last.image, false);
    ctx.cloud.ring.snapshot = jpeg();
    m.answer = (c) => (c.payload.card.imageBase64 ? { ok: false, code: 'invalid' } : { ok: true });
    ctx.clock.add(MIN);
    await ding(host, ctx);
    assert.deepEqual(m.got.slice(1).map((x) => !!x.payload.card.imageBase64), [true, false]);
    // no picture at all: sent without one
    ctx.cloud.ring.snapshot = null;
    m.answer = null;
    ctx.clock.add(MIN);
    await ding(host, ctx);
    assert.equal(m.got.length, 4);
    assert.equal(m.got[3].payload.card.imageBase64, undefined);
  });
});

test('the switch „Klingel in den Familien-Chat“ (default on); gc.services.available; no messenger; failures are logged, the ring works', () => {
  const m = messenger({ provides: [] });
  return withDoor({ services: [m], gatecontrol: '1.178.0' }, async (host, ctx) => {
    await ringLogin(ctx);
    await linkCameras(ctx.admin, ctx.lockId);
    let st = (await ctx.admin('GET', 'settings')).json;
    assert.deepEqual([st.config.familyChat, st.chat.available, st.chat.last], [true, false, null]);
    await ding(host, ctx);
    assert.equal(m.got.length, 0, 'not installed: not even called');
    assert.equal(host.serviceCalls.length, 0);
    assert.ok(host.notifications.some((n) => n.topic === 'doorbell'), 'the ring as before');
    m.provides.push('send_message');
    assert.equal((await ctx.admin('PUT', 'settings', { familyChat: false })).json.config.familyChat, false);
    ctx.clock.add(MIN);
    await ding(host, ctx);
    assert.equal(m.got.length, 0, 'switched off');
    st = (await ctx.admin('PUT', 'settings', { familyChat: true })).json;
    assert.deepEqual([st.config.familyChat, st.chat.available], [true, true]);
    assert.equal((await ctx.admin('PUT', 'settings', { familyChat: 'yes' })).json.code, 'invalid');
    // the messenger answers with a refusal (e.g. no group „Familie“): logged, kept for the page — 1.4.0: not_found
    // tries the people of the ring's push once (refused here as well)
    m.answer = () => ({ ok: false, code: 'not_found' });
    ctx.clock.add(MIN);
    await ding(host, ctx);
    assert.equal(m.got.length, 2);
    assert.deepEqual(m.got[1].payload.conversation, [`user:${ANNA.id}`, `user:${MARC.id}`, `user:${LENA.id}`]);
    st = (await ctx.admin('GET', 'settings')).json;
    assert.deepEqual([st.chat.last.ok, st.chat.last.error, st.chat.last.fallback], [false, 'not_found', { to: 3, sent: 0, failed: 3 }]);
    assert.ok(host.logs.some((l) => l.level === 'warn' && l.message === 'doorbell card not sent not_found'));
    // a provider that throws
    m.answer = () => { throw new Error('boom'); };
    ctx.clock.add(MIN);
    await ding(host, ctx);
    assert.equal((await ctx.admin('GET', 'settings')).json.chat.last.error, 'failed');
  });
});

test('an older GateControl without gc.services: nothing breaks; the card helper; plugin.json, page and texts', async () => {
  await withDoor({}, async (host, ctx) => {
    await ringLogin(ctx);
    await linkCameras(ctx.admin, ctx.lockId);
    const gc = { ...host.gc, services: undefined };
    assert.deepEqual(await chat.ring(gc, { familyChat: true, notifyLang: 'de' }, { camera: { name: 'Klingel' }, lock: null, time: '10:00', image: null }),
      { sent: false, ok: false, error: 'unavailable', image: false, fallback: null });
    await ding(host, ctx);
    assert.ok(host.notifications.some((n) => n.topic === 'doorbell'));
  });
  const big = Buffer.alloc(300 * 1024 + 1, 1);
  assert.equal(chat.cardOf({ lang: 'de', camera: { name: 'K' }, lock: { id: 3, name: 'Tür', actions: '["open"]' }, time: '07:05', image: big }).card.imageBase64, undefined, 'over 300 KB: never');
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
  assert.equal(manifest.version, '1.4.0');
  assert.deepEqual(manifest.permissions.services, ['gatecontrol-messenger:send_message']);
  assert.equal(manifest.gatecontrol, '>=1.169.0', 'the chat is optional: an older host ignores permissions.services');
  const texts = require('../server/texts.json');
  for (const k of ['set.family_chat', 'set.family_chat_hint', 'set.family_chat_missing', 'set.family_chat_failed']) assert.ok(texts.de[k] && texts.en[k], k);
  const ui = require('../server/ui');
  const html = ui.render({ view: 'page', page: 'settings', lang: 'de' }, require('../server/index')._t);
  assert.ok(html.includes('id="dr-s-chat"') && html.includes('Klingel in den Familien-Chat'));
});

// GateControl's interactive run (a person tapped „Tür öffnen“ on the Messenger's chat card):
// user.automation false, user.interactive true, user.via the calling plugin — a person's action.
const tap = (host, u, id, o = {}) => host.plugin.runQuickAction({
  user: { ...u, portal: true, loggedIn: true, automation: false, interactive: true, via: MSG, ...(o.user || {}) },
  lang: 'de', id, via: MSG, automation: false, interactive: true,
}, host.gc);

test('a chat tap (interactive run): a person\'s action with that person\'s rights — never the automation refusals; history „Chat“ with the caller', () => withDoor({}, async (host, { admin, call, lockId, openerId }) => {
  const h0 = host.notifications.length;
  // listed for the person like in the app: Anna (open) gets „open“, which automation never gets
  const listed = await host.plugin.quickActions({ user: { ...ANNA, portal: true, loggedIn: true, automation: false, interactive: true, via: MSG }, lang: 'de' }, host.gc);
  assert.ok(listed.some((a) => a.id === `${lockId}:open`));
  const r = await tap(host, ANNA, `${lockId}:open`);
  assert.equal(r.ok, true, JSON.stringify(r));
  const h = (await admin('GET', 'history', null, { kind: 'action' })).json.items[0];
  assert.deepEqual([h.action, h.via, h.caller, h.result, h.userId], ['open', 'chat', MSG, 'ok', ANNA.id]);
  // Marc may lock/unlock, not open: refused with the normal reason (not auto_open), no „automatic unlock“ push
  const m = await tap(host, MARC, `${lockId}:open`);
  assert.equal(m.ok, false);
  const hm = (await admin('GET', 'history', null, { kind: 'action' })).json.items[0];
  assert.deepEqual([hm.via, hm.caller, hm.result, hm.reason], ['chat', MSG, 'refused', 'no_right']);
  // unlock without the opt-in „automatisch aufsperren“: allowed — it is no automation
  const u = await tap(host, MARC, `${lockId}:unlock`);
  assert.equal(u.ok, true, JSON.stringify(u));
  assert.equal(host.notifications.slice(h0).filter((n) => n.topic === 'auto').length, 0, 'no automation pushes');
  // Lena (view only) cannot; a kiosk device never
  assert.equal((await tap(host, LENA, `${openerId}:open`)).ok, false);
  assert.equal((await tap(host, ANNA, `${lockId}:open`, { user: { kiosk: true } })).ok, false);
  // the history page labels it
  const texts = require('../server/texts.json');
  assert.deepEqual([texts.de['via.chat'], texts.en['via.chat']], ['Chat', 'Chat']);
  assert.equal((await call({ ...ANNA, portal: true, loggedIn: true, app: true }, 'GET', '/history')).json.items[0].via, 'chat');
}));
