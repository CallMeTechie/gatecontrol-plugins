'use strict';

// 1.23.0 — Signal (GateControl with gc.bridges version 10; the mock host's stand-in, tools/testing/mock-bridges.js):
// the network next to WhatsApp, linked by QR code only, „am PC fortsetzen“ (a handoff to the portal or the Windows
// client), the consent „Erkennen“ per network, what of the history Signal brings, disappearing messages and view-once
// pictures in a Signal chat, the administrator's switch for animated stickers and the hint when the server's
// docker-compose.yml does not know Signal yet. Names and numbers are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, ADMIN, ANNA } = require('./helpers');
const texts = require('../server/texts.json');

const ON = { enabled: true, networks: { whatsapp: true, signal: true }, running: true, version: 10 };
const B = { bridged: '1' };
const KIM = { id: 'c' + 'k'.repeat(21), name: 'Kim Muster' };
let n = 0;
const eid = () => `$sg${++n}`;

async function linkSignal(c, host, user) {
  const me = c.as(user);
  assert.equal((await me('POST', 'bridges/signal/consent', { accept: true })).status, 200);
  let r = await me('POST', 'bridges/signal/login', { flow: 'qr' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  host.bridges.confirm(r.json.login.processId);
  r = await me('POST', `bridges/signal/login/${r.json.login.processId}/${r.json.login.step.id}`, {});
  assert.equal(r.json.login.step.type, 'complete', JSON.stringify(r.json));
}

test('GET bridges: Signal next to WhatsApp — its way in, what of the history it brings, its own consent', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const b = (await c.as(ANNA)('GET', 'bridges')).json.bridges;
    assert.deepEqual(b.networks.map((x) => x.id), ['whatsapp', 'signal']);
    const sg = b.networks.find((x) => x.id === 'signal');
    assert.deepEqual(sg.flows, ['qr']);
    assert.deepEqual(sg.history, { maxDays: 30, phoneConfirms: true });
    assert.deepEqual(sg.recognition, { available: true, asked: false, allowed: false });
    assert.equal(sg.handoff, null);
    assert.deepEqual(b.networks[0].flows, ['phone', 'qr']);
    assert.equal(b.handoff, null);
  });
});

test('Signal links by QR code only — the code is passed to the screen, a pairing code is refused', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const me = c.as(ANNA);
    await me('POST', 'bridges/signal/consent', { accept: true });
    assert.equal((await me('POST', 'bridges/signal/login', { flow: 'phone' })).json.code, 'invalid');
    const r = await me('POST', 'bridges/signal/login', { flow: 'qr' });
    assert.equal(r.json.login.step.type, 'display_and_wait');
    assert.match(r.json.login.step.display.data, /^sgnl:\/\/linkdevice\?/);
    assert.ok(r.json.login.step.display.matrix && r.json.login.step.display.matrix.size > 20, 'the portal draws the code itself');
    assert.ok(!('instructions' in r.json.login.step), 'the bridge\'s words never reach the apps');
  });
});

test('„Im Windows-Client fortsetzen“: the step goes to the other screen (live event), and ends with the link', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    const me = c.as(ANNA);
    assert.equal((await me('POST', 'bridges/signal/handoff', { target: 'windows' })).json.code, 'consent_required');
    await me('POST', 'bridges/signal/consent', { accept: true });
    assert.equal((await me('POST', 'bridges/signal/handoff', { target: 'fax' })).json.code, 'invalid');
    assert.equal((await me('POST', 'bridges/whatsapp/handoff', { target: 'windows' })).status, 409, 'WhatsApp needs no second screen: consent first, and it has a code');
    const r = await me('POST', 'bridges/signal/handoff', { target: 'windows' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.handoff.network, 'signal');
    assert.equal(r.json.handoff.target, 'windows');
    assert.match(r.json.handoff.portalPath, /^\/portal#/);
    assert.ok(Date.parse(r.json.handoff.expiresAt) > Date.now());
    const ev = c.events('bridge.handoff')[0];
    assert.ok(ev, 'a live event for the person\'s other devices');
    assert.deepEqual(ev.users, [ANNA.id]);
    assert.equal(ev.data.network, 'signal');
    let b = (await me('GET', 'bridges')).json.bridges;
    assert.equal(b.handoff.target, 'windows');
    assert.equal(b.networks.find((x) => x.id === 'signal').handoff.target, 'windows');
    // the Windows client links: the handoff is over
    let s = await me('POST', 'bridges/signal/login', { flow: 'qr' });
    host.bridges.confirm(s.json.login.processId);
    s = await me('POST', `bridges/signal/login/${s.json.login.processId}/${s.json.login.step.id}`, {});
    assert.equal(s.json.login.step.type, 'complete');
    b = (await me('GET', 'bridges')).json.bridges;
    assert.equal(b.handoff, null);
    // cancelled by hand
    await me('POST', 'bridges/signal/handoff', { target: 'portal' });
    assert.equal((await me('DELETE', 'bridges/signal/handoff')).json.handoff, null);
    assert.equal((await me('GET', 'bridges')).json.bridges.handoff, null);
  });
});

test('„Erkennen“ per network: asked after the Signal link, kept apart from WhatsApp', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    await linkSignal(c, host, ANNA);
    const me = c.as(ANNA);
    let r = await me('PUT', 'bridges/recognition', { allowed: true, network: 'signal' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.recognitions.signal, { available: true, asked: true, allowed: true });
    assert.deepEqual(r.json.recognitions.whatsapp, { available: true, asked: false, allowed: false });
    assert.deepEqual(host.bridges.recognition(ANNA.id, 'signal'), { asked: true, allowed: true });
    assert.equal(host.bridges.recognition(ANNA.id).asked, false, 'WhatsApp\'s consent is another one');
    // without network: WhatsApp, as before
    r = await me('PUT', 'bridges/recognition', { allowed: false });
    assert.equal(r.json.recognition.network, 'whatsapp');
    assert.equal((await me('PUT', 'bridges/recognition', { allowed: true, network: 'icq' })).json.code, 'invalid');
  });
});

test('a Signal chat: the timer shows (nothing runs out here), its change is a line, a view-once picture a hint', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    await linkSignal(c, host, ANNA);
    const ref = host.bridges.chat(ANNA.id, { kind: 'direct', name: 'Oma Hilde', network: 'signal' });
    const chat = { id: ref, kind: 'direct', name: 'Oma Hilde', channel: false, readOnly: false, timer: { type: 'after_read', seconds: 604800 } };
    await host.bridges.deliver([
      { userId: ANNA.id, network: 'signal', type: 'chat', chat },
      { userId: ANNA.id, network: 'signal', type: 'message', chat, id: eid(), sender: KIM, kind: 'text', text: 'Danke für die Fotos!', replyTo: null },
      { userId: ANNA.id, network: 'signal', type: 'message', chat, id: eid(), sender: KIM, kind: 'unsupported', viewOnce: true, text: null, replyTo: null },
      { userId: ANNA.id, network: 'signal', type: 'message', chat, id: eid(), sender: KIM, kind: 'notice', text: 'Set the disappearing message timer to 1h', action: { type: 'timer', seconds: 3600 }, replyTo: null },
    ]);
    await host.tick();
    const list = (await c.call(app(ANNA), 'GET', 'conversations', null, B)).json.conversations;
    const conv = list.find((x) => x.bridge && x.bridge.network === 'signal');
    assert.ok(conv, JSON.stringify(list.map((x) => x.bridge)));
    assert.equal(conv.bridge.label, 'Signal');
    assert.equal(conv.disappearingS, 604800);
    assert.equal(conv.can.setDisappearing, false, 'changed only in Signal');
    const msgs = (await c.call(app(ANNA), 'GET', `conversations/${conv.id}/messages`, null, B)).json.messages;
    assert.equal(msgs[0].text, 'Danke für die Fotos!');
    assert.equal(msgs[0].expiresAt, null, 'the bridge deletes it, nothing runs out here');
    assert.equal(msgs[1].bridge.placeholder.kind, 'view_once');
    assert.equal(msgs[1].text, null);
    assert.equal(msgs[2].kind, 'system');
    assert.deepEqual({ event: msgs[2].system.event, seconds: msgs[2].system.seconds, network: msgs[2].system.network }, { event: 'disappearing', seconds: 3600, network: 'signal' });
    assert.ok(!JSON.stringify(msgs).includes('Set the disappearing'), 'the bridge\'s English line is not shown');
    // the timer goes off
    await host.bridges.deliver([{ userId: ANNA.id, network: 'signal', type: 'chat', chat: { ...chat, timer: null } }]);
    await host.tick();
    const again = (await c.call(app(ANNA), 'GET', `conversations/${conv.id}`, null, B)).json.conversation;
    assert.equal(again.disappearingS, 0);
  });
});

test('admin: Signal\'s row, the switch for animated stickers, and the hint for an older docker-compose.yml', async () => {
  await withHost({ bridges: ON }, async (host, c) => {
    let a = (await c.admin('GET', 'bridges')).json.bridges;
    assert.deepEqual(a.networks.map((x) => x.id), ['whatsapp', 'signal']);
    assert.deepEqual(a.stickers, { animated: false });
    a = (await c.admin('PUT', 'bridges', { animatedStickers: true })).json.bridges;
    assert.deepEqual(a.stickers, { animated: true });
    assert.equal((await c.admin('PUT', 'bridges', { animatedStickers: 'yes' })).json.code, 'invalid');
    assert.equal((await c.as(ANNA)('PUT', 'admin/bridges', { animatedStickers: false })).status, 403);
    host.bridges.setNeeds('signal', 'compose');
    a = (await c.admin('GET', 'bridges')).json.bridges;
    const sg = a.networks.find((x) => x.id === 'signal');
    assert.equal(sg.needs, 'compose');
    assert.equal(sg.state, 'failed');
    assert.equal(a.networks[0].state, 'running', 'WhatsApp keeps running');
  });
});

test('an older GateControl (gc.bridges version 9): no Signal, no sticker switch', async () => {
  await withHost({ bridges: { enabled: true, networks: { whatsapp: true }, running: true, version: 9 } }, async (host, c) => {
    const b = (await c.as(ANNA)('GET', 'bridges')).json.bridges;
    assert.deepEqual(b.networks.map((x) => x.id), ['whatsapp']);
    assert.equal((await c.admin('PUT', 'bridges', { animatedStickers: true })).json.code, 'feature_off');
    assert.equal((await c.as(ANNA)('PUT', 'bridges/recognition', { allowed: true, network: 'signal' })).json.code, 'feature_off');
  });
});

test('texts: every Signal text in German and English', () => {
  for (const k of Object.keys(texts.de).filter((x) => /signal|_sg|handoff|stickers|phone_history|hist_once|hist_line|view_once|dis_on_net|dis_off_net|dis\.(minutes|hours|days|weeks)|br\.done|bc\.timer/i.test(x))) {
    assert.ok(typeof texts.en[k] === 'string' && texts.en[k].length, `en: ${k}`);
  }
  assert.equal(texts.de['admin.br_net_signal'], 'Signal');
  assert.match(texts.de['bc.signal_safety'], /Sicherheitsnummern prüfst du in der Signal-App/);
});
