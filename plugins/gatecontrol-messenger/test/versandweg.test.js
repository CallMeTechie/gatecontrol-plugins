'use strict';

// 1.27.0: the way a person is written to (replyPref), a location over the bridge (gc.bridges version 14), place
// messages — against the mock host (tools/testing/mock-bridges.js). Names made up, no phone number anywhere.
//
//   replyPref       PUT persons/:id { replyPref }: auto | gatecontrol | a network the person has (bad_request
//                   otherwise); person.reply follows it, while that way cannot send GateControl with fallback: true; an
//                   answer to a message still goes back its message's way
//   location        bridge.supports names 'location' with version 14 for WhatsApp / Telegram (not Signal, not before
//                   14); the location goes out as one, an incoming one is a message of kind 'location'
//   place messages  create / list / change / delete, the limits (10 active, radius, text), fire → a normal message with
//                   meta.placeMessage only in the sender's view, once an hour, at most 30 minutes late, once → done,
//                   the phone that owns it, no read-only targets, place_messages.changed

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, ANNA, MARC, LENA, MIN, HOUR } = require('./helpers');

const V14 = { enabled: true, networks: { whatsapp: true }, running: true, version: 14 };
const V13 = { ...V14, version: 13 };
const Q = { bridged: '1', channels: '1', people: '1' };
const SCHATZ = { id: 'c' + 's'.repeat(21), name: 'Schatzimausi 💕' };
const KIM = { id: 'c' + 'k'.repeat(21), name: 'Kim Muster' };
let n = 0;
const eid = () => `$vw${++n}`;
const DEV = 'pixel-lea-01';
const HOME = { familieId: 7, name: 'Zuhause', lat: 51.2345, lon: 7.6543, radiusM: 150 };

async function link(c, host, net = 'whatsapp') {
  const me = c.as(ANNA);
  assert.equal((await me('POST', `bridges/${net}/consent`, { accept: true }, { bridged: '1' })).status, 200);
  let r = await me('POST', `bridges/${net}/login`, { flow: 'qr' }, { bridged: '1' });
  host.bridges.confirm(r.json.login.processId);
  r = await me('POST', `bridges/${net}/login/${r.json.login.processId}/${r.json.login.step.id}`, {}, { bridged: '1' });
  assert.equal(r.json.login.step.type, 'complete');
}
const wa = (chat, who, text, extra = {}) => ({ userId: ANNA.id, type: 'message', chat, id: eid(), sender: { id: who.id, name: who.name }, kind: 'text', text, replyTo: null, ...extra });
const as = (c, u) => (method, path, body, q = Q) => c.call(app(u), method, path, body === undefined ? null : body, q);
const list = async (c, u = ANNA) => (await as(c, u)('GET', 'conversations')).json.conversations;

/** Anna linked WhatsApp; chats with „Schatzimausi 💕“ (Marc) and Kim. */
async function setup(c, host) {
  await link(c, host);
  const dm = { id: host.bridges.chat(ANNA.id, { kind: 'direct', name: SCHATZ.name }), kind: 'direct', name: SCHATZ.name, avatar: null };
  const kim = { id: host.bridges.chat(ANNA.id, { kind: 'direct', name: KIM.name }), kind: 'direct', name: KIM.name, avatar: null };
  await host.bridges.deliver([
    { userId: ANNA.id, type: 'chat', chat: dm }, { userId: ANNA.id, type: 'chat', chat: kim },
    wa(dm, SCHATZ, 'Kannst du Milch mitbringen?', { at: Date.now() - 10 * MIN }), wa(kim, KIM, 'Moin'),
  ]);
  const l = await list(c);
  return { dm, kim, waId: l.find((x) => x.title === SCHATZ.name).id, kimId: l.find((x) => x.title === KIM.name).id };
}

/** … and merges the WhatsApp chat with Marc's account. */
async function merged(c, host) {
  const s = await setup(c, host);
  const r = await as(c, ANNA)('POST', 'persons', { conversationIds: [s.waId], userId: MARC.id, name: 'account' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { ...s, person: r.json.person, gcId: r.json.person.ways.find((w) => w.way === 'gatecontrol').conversationId };
}

// ─── replyPref ─────────────────────────────────────────────────────────────

test('replyPref: „Immer GateControl“ / „Immer WhatsApp“ / automatic — person.reply follows; a way the person lacks is bad_request', async () => {
  await withHost({ bridges: V14 }, async (host, c) => {
    const { person, waId, gcId } = await merged(c, host);
    const me = as(c, ANNA);
    assert.equal(person.replyPref, 'auto');
    assert.equal(person.reply.way, 'whatsapp', 'automatic: the way of the newest incoming message');
    assert.equal(person.reply.fallback, undefined);
    c.resetEvents();
    let r = await me('PUT', `persons/${person.id}`, { replyPref: 'gatecontrol' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.person.replyPref, r.json.person.reply.way, r.json.person.reply.conversationId], ['gatecontrol', 'gatecontrol', gcId]);
    assert.ok(c.events('conversation.update').some((e) => e.data.reason === 'person' && e.data.personId === person.id), 'the own devices learn it');
    // a new message goes over GateControl, an answer to the WhatsApp message still over WhatsApp
    r = await me('POST', `persons/${person.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'Bin gleich da' });
    assert.deepEqual([r.json.way, r.json.conversationId], ['gatecontrol', gcId]);
    const waMsg = (await me('GET', `persons/${person.id}/messages`, undefined, { ...Q, way: 'whatsapp' })).json.messages[0];
    r = await me('POST', `persons/${person.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'Ja, Milch kommt', replyTo: waMsg.id });
    assert.deepEqual([r.json.way, r.json.conversationId], ['whatsapp', waId]);
    // Marc writes inside GateControl — „Immer WhatsApp“ stays WhatsApp
    await c.send(MARC, gcId, { text: 'Danke!' });
    r = await me('PUT', `persons/${person.id}`, { replyPref: 'whatsapp' });
    assert.deepEqual([r.json.person.replyPref, r.json.person.reply.way], ['whatsapp', 'whatsapp']);
    // the list entry and GET persons/:id carry it too
    const e = (await list(c)).find((x) => x.person && x.person.id === person.id);
    assert.equal(e.person.replyPref, 'whatsapp');
    assert.equal((await me('GET', `persons/${person.id}`)).json.person.replyPref, 'whatsapp');
    // no Signal way, no number, no word
    assert.equal((await me('PUT', `persons/${person.id}`, { replyPref: 'signal' })).json.code, 'bad_request');
    assert.equal((await me('PUT', `persons/${person.id}`, { replyPref: 'signal' })).status, 400);
    assert.equal((await me('PUT', `persons/${person.id}`, { replyPref: 7 })).json.code, 'invalid');
    // automatic again (null too)
    r = await me('PUT', `persons/${person.id}`, { replyPref: null });
    assert.deepEqual([r.json.person.replyPref, r.json.person.reply.way], ['auto', 'gatecontrol']);
    // only one's own person
    assert.equal((await as(c, LENA)('PUT', `persons/${person.id}`, { replyPref: 'gatecontrol' })).status, 404);
  });
});

test('replyPref „Immer WhatsApp“ while WhatsApp cannot send: GateControl with fallback: true; back once it can', async () => {
  await withHost({ bridges: V14 }, async (host, c) => {
    const { person, gcId, waId } = await merged(c, host);
    const me = as(c, ANNA);
    await me('PUT', `persons/${person.id}`, { replyPref: 'whatsapp' });
    host.bridges.setHost({ running: false });
    let p = (await me('GET', `persons/${person.id}`)).json.person;
    assert.deepEqual([p.reply.way, p.reply.conversationId, p.reply.fallback, p.replyPref], ['gatecontrol', gcId, true, 'whatsapp']);
    const r = await me('POST', `persons/${person.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'Geht trotzdem raus' });
    assert.deepEqual([r.json.way, r.json.conversationId], ['gatecontrol', gcId]);
    host.bridges.setHost({ running: true });
    p = (await me('GET', `persons/${person.id}`)).json.person;
    assert.deepEqual([p.reply.way, p.reply.conversationId, p.reply.fallback], ['whatsapp', waId, undefined]);
  });
});

// ─── a location over the bridge ─────────────────────────────────────────────

test('location over WhatsApp (version 14): supports names it, it goes out as m.location with its answer; nothing stored as text', async () => {
  await withHost({ bridges: V14 }, async (host, c) => {
    const { kimId, kim } = await setup(c, host);
    const me = as(c, ANNA);
    const conv = (await me('GET', `conversations/${kimId}`)).json.conversation;
    assert.ok(conv.bridge.supports.includes('location'), JSON.stringify(conv.bridge.supports));
    const moin = (await me('GET', `conversations/${kimId}/messages`)).json.messages[0];
    const r = await me('POST', `conversations/${kimId}/messages`, { clientId: c.cid(), kind: 'location', location: { lat: 51.5, lon: 7.25, label: 'Marktplatz' }, replyTo: moin.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.message.kind, r.json.message.location, r.json.message.status], ['location', { lat: 51.5, lon: 7.25, label: 'Marktplatz' }, 'sent']);
    const out = host.bridges.sent.filter((x) => x.op === 'send').pop();
    assert.deepEqual([out.chatId, out.text, out.location], [kim.id, null, { lat: 51.5, lon: 7.25, label: 'Marktplatz' }]);
    assert.match(String(out.replyTo), /^\$vw\d+$/, 'with the answer (the bridge\'s id of „Moin“)');
    assert.equal(r.json.message.replyTo.id, moin.id);
    // other rich kinds stay GateControl's
    assert.equal((await me('POST', `conversations/${kimId}/messages`, { clientId: c.cid(), kind: 'poll', poll: { question: 'Pizza?', options: ['ja', 'nein'] } })).json.code, 'bridge_text_only');
  });
});

test('location: before version 14 and to Signal still refused (bridge_text_only), supports without it', async () => {
  await withHost({ bridges: V13 }, async (host, c) => {
    const { kimId } = await setup(c, host);
    const me = as(c, ANNA);
    assert.ok(!(await me('GET', `conversations/${kimId}`)).json.conversation.bridge.supports.includes('location'));
    const r = await me('POST', `conversations/${kimId}/messages`, { clientId: c.cid(), kind: 'location', location: { lat: 51.5, lon: 7.25 } });
    assert.deepEqual([r.status, r.json.code], [409, 'bridge_text_only']);
  });
  await withHost({ bridges: { ...V14, networks: { whatsapp: true, signal: true } } }, async (host, c) => {
    await link(c, host, 'signal');
    const ref = host.bridges.chat(ANNA.id, { kind: 'direct', name: 'Oma Hilde', network: 'signal' });
    const chat = { id: ref, kind: 'direct', name: 'Oma Hilde' };
    await host.bridges.deliver([{ userId: ANNA.id, network: 'signal', type: 'chat', chat }, { ...wa(chat, KIM, 'Hallo'), network: 'signal' }]);
    const conv = (await list(c)).find((x) => x.bridge && x.bridge.network === 'signal');
    assert.ok(!conv.bridge.supports.includes('location'));
    const r = await as(c, ANNA)('POST', `conversations/${conv.id}/messages`, { clientId: c.cid(), kind: 'location', location: { lat: 51.5, lon: 7.25 } });
    assert.equal(r.json.code, 'bridge_text_only');
  });
});

test('an incoming location is a message of kind location (map card), a geo URI as caption is no name; the push says „Standort“', async () => {
  await withHost({ bridges: V14 }, async (host, c) => {
    const { kim, kimId } = await setup(c, host);
    await host.bridges.deliver([
      wa(kim, KIM, 'Schwimmbad Nord', { kind: 'media', media: { kind: 'location', name: null, geo: { lat: 51.31, lon: 7.41 } } }),
      wa(kim, KIM, 'geo:51.3,7.4', { kind: 'media', media: { kind: 'location', name: null, geo: { lat: 51.3, lon: 7.4 } } }),
      wa(kim, KIM, 'kaputt', { kind: 'media', media: { kind: 'location', name: null } }),
    ]);
    const m = (await as(c, ANNA)('GET', `conversations/${kimId}/messages`)).json.messages;
    const [a, b, x] = m.slice(-3);
    assert.deepEqual([a.kind, a.text, a.location, a.bridge.placeholder, a.bridge.sender.name], ['location', null, { lat: 51.31, lon: 7.41, label: 'Schwimmbad Nord' }, null, KIM.name]);
    assert.deepEqual([b.kind, b.location.label], ['location', null]);
    assert.deepEqual([x.kind, x.bridge.placeholder.kind], ['text', 'location'], 'without geo: the placeholder as before');
    const push = c.pushes().find((p) => /Schwimmbad/.test(p.body || ''));
    assert.ok(push, JSON.stringify(c.pushes().map((p) => p.body)));
    assert.match(push.body, /^Standort: Schwimmbad Nord$/);
  });
});

// ─── place messages ────────────────────────────────────────────────────────

const pm = (convId, extra = {}) => ({ deviceId: DEV, trigger: 'enter', place: HOME, text: 'Bin da, Tür ist offen.', conversationId: convId, ...extra });

test('place messages: the feature word, create / list / change / delete with place_messages.changed; limits', async () => {
  await withHost({ bridges: V14 }, async (host, c) => {
    const { person, gcId } = await merged(c, host);
    const me = as(c, ANNA);
    assert.equal((await me('GET', 'me')).json.features.placeMessages, true);
    c.resetEvents();
    let r = await me('POST', 'place-messages', pm(gcId, { repeat: 'always', window: { days: [5, 1, 2, 3, 4, 5], from: '16:00', to: '20:00' } }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const p = r.json.placeMessage;
    assert.deepEqual([p.trigger, p.place, p.text, p.conversationId, p.way, p.repeat, p.window, p.ask, p.enabled, p.lastFiredAt, p.doneAt, p.deviceId],
      ['enter', HOME, 'Bin da, Tür ist offen.', gcId, 'auto', 'always', { days: [1, 2, 3, 4, 5], from: '16:00', to: '20:00' }, true, true, null, null, DEV]);
    assert.deepEqual([p.target.title, p.target.personId, p.target.reply.way], ['Marc', person.id, 'whatsapp']);
    assert.deepEqual(c.events('place_messages.changed').map((e) => [e.data.id, e.data.reason, e.users]), [[p.id, 'created', [ANNA.id]]]);
    // defaults: radius 150, once, ask
    r = await me('POST', 'place-messages', pm(gcId, { place: { name: 'Schule', lat: 51.1, lon: 7.1 }, trigger: 'exit', way: 'whatsapp' }));
    assert.deepEqual([r.json.placeMessage.place.radiusM, r.json.placeMessage.repeat, r.json.placeMessage.ask, r.json.placeMessage.way, r.json.placeMessage.place.familieId], [150, 'once', true, 'whatsapp', null]);
    const second = r.json.placeMessage.id;
    // checks
    for (const bad of [{ place: { ...HOME, radiusM: 99 } }, { place: { ...HOME, radiusM: 2001 } }, { text: '' }, { text: 'x'.repeat(1001) }, { trigger: 'near' },
      { repeat: 'twice' }, { window: { days: [8], from: '16:00', to: '20:00' } }, { window: { days: [1], from: '25:00', to: '20:00' } }, { deviceId: '' }, { place: { name: 'X', lat: 91, lon: 0 } }, { color: 'red' }]) {
      assert.equal((await me('POST', 'place-messages', pm(gcId, bad))).json.code, 'invalid', JSON.stringify(bad));
    }
    assert.equal((await me('POST', 'place-messages', pm(gcId, { way: 'telegram' }))).json.code, 'bad_request');
    // the list, newest first — only one's own
    let l = (await me('GET', 'place-messages')).json;
    assert.deepEqual(l.placeMessages.map((x) => x.id), [second, p.id]);
    assert.deepEqual([l.limits.activeMax, l.limits.radiusMinM, l.limits.radiusMaxM, l.limits.radiusDefaultM, l.limits.textMax, l.limits.everyS, l.limits.lateS], [10, 100, 2000, 150, 1000, 3600, 1800]);
    assert.deepEqual((await as(c, LENA)('GET', 'place-messages')).json.placeMessages, []);
    assert.equal((await as(c, LENA)('PUT', `place-messages/${p.id}`, { enabled: false })).status, 404);
    // change, delete
    c.resetEvents();
    r = await me('PUT', `place-messages/${p.id}`, { text: 'Bin zuhause.', ask: false, window: null, deviceId: 'pixel-lea-02' });
    assert.deepEqual([r.json.placeMessage.text, r.json.placeMessage.ask, r.json.placeMessage.window, r.json.placeMessage.deviceId], ['Bin zuhause.', false, null, 'pixel-lea-02']);
    assert.equal((await me('DELETE', `place-messages/${second}`)).json.deleted, true);
    assert.deepEqual(c.events('place_messages.changed').map((e) => e.data.reason), ['updated', 'deleted']);
    // at most 10 active
    for (let i = 0; i < 9; i++) assert.equal((await me('POST', 'place-messages', pm(gcId))).status, 200);
    assert.deepEqual([(await me('POST', 'place-messages', pm(gcId))).status, (await me('POST', 'place-messages', pm(gcId))).json.code], [409, 'limit']);
    r = await me('POST', 'place-messages', pm(gcId, { enabled: false }));
    assert.equal(r.status, 200, 'a switched-off one does not count');
    assert.equal((await me('PUT', `place-messages/${r.json.placeMessage.id}`, { enabled: true })).json.code, 'limit');
    l = (await me('GET', 'place-messages')).json;
    assert.equal(l.placeMessages.length, 11);
  });
});

test('place messages: Familie ids home and place:<id> (1.27.1), bad text ids refused', async () => {
  await withHost({ bridges: V14 }, async (host, c) => {
    const { gcId } = await merged(c, host);
    const me = as(c, ANNA);
    const at = (familieId) => ({ ...HOME, familieId });
    let r = await me('POST', 'place-messages', pm(gcId, { place: at('home') }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.placeMessage.place.familieId, 'home');
    const id = r.json.placeMessage.id;
    r = await me('POST', 'place-messages', pm(gcId, { place: { ...at('place:3'), name: 'Schule' } }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.placeMessage.place.familieId, 'place:3');
    r = await me('PUT', `place-messages/${id}`, { place: { ...at('place:3'), name: 'Schule' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.placeMessage.place.familieId, r.json.placeMessage.place.name], ['place:3', 'Schule']);
    r = await me('PUT', `place-messages/${id}`, { place: at('home') });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.placeMessage.place.familieId, 'home');
    assert.deepEqual((await me('GET', 'place-messages')).json.placeMessages.map((x) => x.place.familieId).sort(), ['home', 'place:3']);
    for (const bad of ['', 'place 3', ' home', 'x'.repeat(65), 'place:3/4', 0, -1, 1.5, true, {}]) {
      assert.equal((await me('POST', 'place-messages', pm(gcId, { place: at(bad) }))).json.code, 'invalid', JSON.stringify(bad));
      assert.equal((await me('PUT', `place-messages/${id}`, { place: at(bad) })).json.code, 'invalid', JSON.stringify(bad));
    }
    assert.equal((await me('POST', 'place-messages', pm(gcId, { place: at('p'.repeat(64)) }))).status, 200, '64 characters are fine');
    assert.equal((await me('GET', `place-messages`)).json.placeMessages.find((x) => x.id === id).place.familieId, 'home', 'a refused change keeps the place');
  });
});

test('place messages: no channel or read-only target; a chat that is no person takes auto or its own way', async () => {
  await withHost({ bridges: V14 }, async (host, c) => {
    const { kimId } = await setup(c, host);
    const me = as(c, ANNA);
    assert.equal((await me('POST', 'place-messages', pm(kimId, { way: 'whatsapp' }))).status, 200);
    assert.equal((await me('POST', 'place-messages', pm(kimId, { way: 'gatecontrol' }))).json.code, 'bad_request');
    const ch = { id: host.bridges.chat(ANNA.id, { kind: 'group', name: 'Stadtnachrichten', channel: true }), kind: 'group', name: 'Stadtnachrichten', channel: true, readOnly: true };
    await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat: ch }, { userId: ANNA.id, type: 'message', chat: ch, id: eid(), sender: { channel: true, system: true }, kind: 'text', text: 'Neu', replyTo: null }]);
    const chId = (await me('GET', 'channels')).json.channels[0].id;
    assert.equal((await me('POST', 'place-messages', pm(chId))).json.code, 'readonly');
    assert.equal((await as(c, LENA)('POST', 'place-messages', pm(kimId))).status, 404, 'not her chat');
  });
});

test('fire: a normal message with meta.placeMessage (only the sender sees the line), once → done, once an hour, 30 minutes late, the own phone', async () => {
  await withHost({ bridges: V14 }, async (host, c) => {
    const { gcId, person } = await merged(c, host);
    const me = as(c, ANNA);
    await me('PUT', `persons/${person.id}`, { replyPref: 'gatecontrol' });
    const p = (await me('POST', 'place-messages', pm(gcId, { repeat: 'always' }))).json.placeMessage;
    const at = new Date(Date.now() - 2 * MIN).toISOString();
    assert.equal((await me('POST', `place-messages/${p.id}/fire`, { at, deviceId: 'other-phone' })).json.code, 'not_allowed');
    c.resetEvents();
    let r = await me('POST', `place-messages/${p.id}/fire`, { at, deviceId: DEV });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.way, r.json.conversationId, r.json.duplicate, r.json.message.text, r.json.message.placeMessage], ['gatecontrol', gcId, false, 'Bin da, Tür ist offen.', { name: 'Zuhause', trigger: 'enter' }]);
    assert.equal(r.json.placeMessage.lastFiredAt, at);
    assert.equal(r.json.placeMessage.enabled, true, 'always: stays on');
    assert.ok(c.events('place_messages.changed').some((e) => e.data.reason === 'fired'));
    assert.ok(c.events('message.new').some((e) => e.data.conversationId === gcId));
    // Marc sees a normal message — no place line, no coordinates
    const theirs = (await as(c, MARC)('GET', `conversations/${gcId}/messages`)).json.messages.pop();
    assert.deepEqual([theirs.text, theirs.placeMessage, theirs.location], ['Bin da, Tür ist offen.', null, null]);
    assert.ok(c.pushes().some((x) => x.users.includes(MARC.id)), 'Marc gets the push of a normal message');
    // the same firing again: nothing new
    r = await me('POST', `place-messages/${p.id}/fire`, { at, deviceId: DEV });
    assert.deepEqual([r.status, r.json.duplicate, r.json.message.id], [200, true, theirs.id]);
    // within the hour: too_soon; after it: again
    c.clock.add(30 * MIN);
    assert.equal((await me('POST', `place-messages/${p.id}/fire`, { at: new Date().toISOString(), deviceId: DEV })).json.code, 'too_soon');
    c.clock.add(HOUR);
    // more than 30 minutes late: expired
    assert.equal((await me('POST', `place-messages/${p.id}/fire`, { at: new Date(Date.now() - 31 * MIN).toISOString(), deviceId: DEV })).json.code, 'expired');
    assert.equal((await me('POST', `place-messages/${p.id}/fire`, { at: 'gestern', deviceId: DEV })).json.code, 'invalid');
    assert.equal((await me('POST', `place-messages/${p.id}/fire`, { at: new Date(Date.now() + HOUR).toISOString(), deviceId: DEV })).json.code, 'invalid', 'not in the future');
    assert.equal((await me('POST', `place-messages/${p.id}/fire`, { at: new Date().toISOString(), deviceId: DEV })).status, 200);
    // once: done and off afterwards
    const once = (await me('POST', 'place-messages', pm(gcId, { trigger: 'exit' }))).json.placeMessage;
    r = await me('POST', `place-messages/${once.id}/fire`, { at: new Date().toISOString(), deviceId: DEV });
    assert.deepEqual([r.json.placeMessage.enabled, !!r.json.placeMessage.doneAt, r.json.message.placeMessage.trigger], [false, true, 'exit']);
    c.clock.add(2 * HOUR);
    assert.equal((await me('POST', `place-messages/${once.id}/fire`, { at: new Date().toISOString(), deviceId: DEV })).json.code, 'closed');
    // switched on again it starts afresh
    r = await me('PUT', `place-messages/${once.id}`, { enabled: true });
    assert.deepEqual([r.json.placeMessage.enabled, r.json.placeMessage.doneAt], [true, null]);
  });
});

test('fire over WhatsApp: way auto follows person.reply, only the text crosses (no mark at the bridge)', async () => {
  await withHost({ bridges: V14 }, async (host, c) => {
    const { gcId, waId } = await merged(c, host);
    const me = as(c, ANNA);
    const p = (await me('POST', 'place-messages', pm(gcId, { ask: false }))).json.placeMessage;
    const r = await me('POST', `place-messages/${p.id}/fire`, { at: new Date().toISOString(), deviceId: DEV });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.way, r.json.conversationId, r.json.message.placeMessage.name, r.json.message.status], ['whatsapp', waId, 'Zuhause', 'sent']);
    const out = host.bridges.sent.filter((x) => x.op === 'send').pop();
    assert.equal(out.text, 'Bin da, Tür ist offen.');
    assert.ok(!JSON.stringify(out).includes('Zuhause') && !JSON.stringify(out).includes('51.23'), 'neither the place nor where');
    // a fixed way: WhatsApp away → GateControl
    const q = (await me('POST', 'place-messages', pm(gcId, { way: 'whatsapp', repeat: 'always' }))).json.placeMessage;
    host.bridges.setHost({ running: false });
    const r2 = await me('POST', `place-messages/${q.id}/fire`, { at: new Date().toISOString(), deviceId: DEV });
    assert.deepEqual([r2.json.way, r2.json.conversationId], ['gatecontrol', gcId]);
  });
});
