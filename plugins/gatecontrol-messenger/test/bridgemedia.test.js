'use strict';

// 1.15.0: files, pictures and a new chat by number over a bridge — against the mock host's gc.bridges version 4
// (tools/testing/mock-bridges.js: a file is a reference the host streams into the plugin's media, with the virus scan).
//
//   in         a contact's picture, voice message, video, file: a placeholder "wird geladen …", then a normal message
//              with its file — or the placeholder with a reason (too large, type, gone, malware); a location as a link
//   pictures   the chat's picture when it changes, a contact's once somebody sees their messages; only the person
//   out        picture, voice message, video, file — only in a type the bridge takes, only after the scan; the rest
//              stays refused (409 bridge_text_only)
//   new chat   resolve / chats by number: the linked person only, children locked, a limit, the number nowhere
//   older      a GateControl with version 3: nothing of it, no new feature words

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, portal, ANNA, MARC, LENA, PNG, OGG, PDF, png } = require('./helpers');

const V4 = { enabled: true, networks: { whatsapp: true }, running: true, version: 4 };
const B = { bridged: '1' };
const KIM = { id: 'c' + 'k'.repeat(21), name: 'Kim Muster' };
const familie = () => ({ plugin: 'gatecontrol-familie', provides: ['family_roles'], service: () => ({ ok: true, parents: [ANNA.id, MARC.id], children: [LENA.id] }) });
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 9)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(200)]);
const WEBM = Buffer.from('\x1aE\xdf\xa3webm-voice');
let n = 0;
const eid = () => `$fm${++n}`;

async function link(c, host, user) {
  const me = c.as(user);
  assert.equal((await me('POST', 'bridges/whatsapp/consent', { accept: true })).status, 200);
  let r = await me('POST', 'bridges/whatsapp/login', { flow: 'qr' });
  host.bridges.confirm(r.json.login.processId);
  r = await me('POST', `bridges/whatsapp/login/${r.json.login.processId}/${r.json.login.step.id}`, {});
  assert.equal(r.json.login.step.type, 'complete');
}
async function annaAndKim(c, host, { kind = 'direct', name = 'Kim Muster', avatar } = {}) {
  await link(c, host, ANNA);
  const ref = host.bridges.chat(ANNA.id, { kind, name });
  const chat = { id: ref, kind, name, ...(avatar !== undefined ? { avatar } : {}) };
  await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat }]);
  return { ref, chat };
}
const media = (chat, m, extra = {}) => ({ userId: ANNA.id, type: 'message', chat, id: eid(), sender: KIM, kind: 'media', media: m, text: null, replyTo: null, ...extra });
const list = async (c, user = ANNA) => (await c.call(app(user), 'GET', 'conversations', null, B)).json.conversations;
const msgs = async (c, convId, user = ANNA, viewer = app) => (await c.call(viewer(user), 'GET', `conversations/${convId}/messages`, null, B)).json.messages;
const bcall = (c, user, method, path, body) => c.call(app(user), method, path, body, B);

test('a GateControl without files over the bridge (version 3): placeholders as before, no new feature words', async () => {
  await withHost({ bridges: { ...V4, version: 3 }, scan: true }, async (host, c) => {
    const { chat } = await annaAndKim(c, host);
    await host.bridges.deliver([media(chat, { kind: 'image', name: 'image.jpg', ref: 'm' + 'x'.repeat(50) })]);
    await host.tick();
    const [conv] = await list(c);
    assert.deepEqual(conv.bridge.supports, ['text', 'reply', 'reaction', 'edit', 'delete', 'read', 'typing']);
    assert.equal(conv.bridge.mediaTypes, undefined);
    const [m] = await msgs(c, conv.id);
    assert.deepEqual([m.kind, m.bridge.placeholder.state], ['text', null], 'nothing to fetch, nothing waits');
    const f = (await c.as(ANNA)('GET', 'me')).json.features;
    assert.equal(f.bridge_chats, true);
    assert.equal(f.bridge_media, undefined);
    assert.equal(f.bridge_new_chat, undefined);
    const up = await c.upload(ANNA, PNG, 'image/png');
    const r = await bcall(c, ANNA, 'POST', `conversations/${conv.id}/messages`, { clientId: c.cid(), kind: 'image', mediaId: up });
    assert.deepEqual([r.status, r.json.code], [409, 'bridge_text_only']);
  });
});

test('a contact’s picture: "wird geladen …", then a normal picture with the virus scan — for the linked person only', async () => {
  await withHost({ bridges: V4, scan: true }, async (host, c) => {
    const { chat } = await annaAndKim(c, host);
    const ref = host.bridges.file(ANNA.id, { data: JPEG, mime: 'image/jpeg' });
    c.resetEvents();
    await host.bridges.deliver([media(chat, { kind: 'image', name: 'image.jpg', ref, mime: 'image/jpeg', size: JPEG.length, w: 1280, h: 960 }, { text: 'Grillen!' })]);
    const [conv] = await list(c);
    assert.deepEqual(conv.bridge.supports, ['text', 'reply', 'reaction', 'edit', 'delete', 'read', 'typing', 'image', 'video', 'voice', 'file']);
    assert.deepEqual(conv.bridge.mediaTypes.voice, ['audio/ogg', 'audio/mp4', 'audio/aac', 'audio/mpeg']);
    let [m] = await msgs(c, conv.id);
    // the fetch runs after the events are filed; in the mock it may already be done — or still waiting
    if (m.kind === 'text') assert.deepEqual([m.bridge.placeholder.kind, m.bridge.placeholder.state], ['image', 'loading']);
    await host.tick();
    [m] = await msgs(c, conv.id);
    assert.deepEqual([m.kind, m.text, m.media.mime, m.media.bytes, m.meta.w, m.meta.h], ['image', 'Grillen!', 'image/jpeg', JPEG.length, 1280, 960]);
    assert.deepEqual(m.media.scan, { state: 'clean', blocked: false, finding: null });
    assert.equal(m.bridge.placeholder, null);
    assert.equal(m.bridge.sender.name, 'Kim Muster');
    assert.ok(c.events('message.update').some((e) => e.data.messageId === m.id && e.data.media === true && e.users.includes(ANNA.id)));
    assert.equal(host.bridges.fetches.length, 1, 'fetched once');
    // the file: Anna, nobody else (not even another member of the family)
    assert.equal((await host.mediaGet(ANNA, m.media.id)).status, 200);
    assert.equal((await host.mediaGet(MARC, m.media.id)).status, 404);
    const f = (await c.as(ANNA)('GET', 'me')).json.features;
    assert.deepEqual([f.bridge_chats, f.bridge_media, f.bridge_new_chat], [true, true, true]);
    assert.equal((await c.as(MARC)('GET', 'me')).json.features.bridge_media, undefined, 'only people with bridged chats');
    // the portal gets a signed URL
    const [pm] = await msgs(c, conv.id, ANNA, portal);
    assert.match(pm.media.url, /^\/plugin-media\//);
  });
});

test('voice message, video, file, sticker, location — each as GateControl shows it', async () => {
  await withHost({ bridges: V4, scan: true }, async (host, c) => {
    const { chat } = await annaAndKim(c, host);
    const voice = host.bridges.file(ANNA.id, { data: OGG, mime: 'audio/ogg' });
    const video = host.bridges.file(ANNA.id, { data: MP4, mime: 'video/mp4' });
    const doc = host.bridges.file(ANNA.id, { data: PDF, mime: 'application/pdf' });
    const odd = host.bridges.file(ANNA.id, { data: Buffer.from('BEGIN:VCALENDAR'), mime: 'text/x-odd' });
    const sticker = host.bridges.file(ANNA.id, { data: PNG, mime: 'image/webp' });
    await host.bridges.deliver([
      media(chat, { kind: 'voice', name: 'Voice message.ogg', ref: voice, mime: 'audio/ogg', durationMs: 4200, waveform: [0, 512, 1024] }),
      media(chat, { kind: 'video', name: 'video.mp4', ref: video, mime: 'video/mp4', durationMs: 9000, w: 640, h: 360 }),
      media(chat, { kind: 'file', name: 'Vertrag.pdf', ref: doc, mime: 'application/pdf' }),
      media(chat, { kind: 'file', name: 'termin.odd', ref: odd }),
      media(chat, { kind: 'sticker', name: 'sticker.webp', ref: sticker, w: 190, h: 190 }),
      media(chat, { kind: 'location', name: null, geo: { lat: 51.12, lon: 7.65 } }, { text: 'Location: Marktplatz' }),
    ]);
    await host.tick();
    const [conv] = await list(c);
    const m = await msgs(c, conv.id);
    assert.deepEqual([m[0].kind, m[0].meta.durationMs, m[0].meta.waveform], ['voice', 4200, [0, 128, 255]]);
    assert.deepEqual([m[1].kind, m[1].media.mime, m[1].video, m[1].meta.fileName], ['file', 'video/mp4', { durationMs: 9000, width: 640, height: 360 }, 'video.mp4']);
    assert.deepEqual([m[2].kind, m[2].meta.fileName], ['file', 'Vertrag.pdf']);
    assert.deepEqual([m[3].kind, m[3].media.mime], ['file', 'application/octet-stream'], 'another type: a download');
    assert.deepEqual([m[4].kind, m[4].media.mime], ['image', 'image/webp']);
    // 1.27.0: a real location (the map card), its name without the bridge's „Location:“
    assert.deepEqual([m[5].kind, m[5].text, m[5].location, m[5].bridge.placeholder], ['location', null, { lat: 51.12, lon: 7.65, label: 'Marktplatz' }, null]);
  });
});

test('what cannot come keeps its placeholder — with the reason; a bridge that is away is asked again later', async () => {
  await withHost({ bridges: V4, scan: (f) => (f.data.includes('EICAR') ? { deleted: true, finding: 'Eicar-Test-Signature' } : null) }, async (host, c) => {
    const { chat } = await annaAndKim(c, host);
    const big = host.bridges.file(ANNA.id, { data: Buffer.alloc(10), mime: 'image/jpeg' });
    const gif = host.bridges.file(ANNA.id, { data: Buffer.from('heic-bytes'), mime: 'image/heic' });
    const gone = host.bridges.file(ANNA.id, { data: JPEG, mime: 'image/jpeg' });
    host.bridges.gone(gone);
    const bad = host.bridges.file(ANNA.id, { data: Buffer.from('X5O!P%@AP EICAR-STANDARD-ANTIVIRUS-TEST-FILE'), mime: 'application/octet-stream' });
    const later = host.bridges.file(ANNA.id, { data: JPEG, mime: 'image/jpeg' });
    await host.bridges.deliver([
      media(chat, { kind: 'image', name: 'big.jpg', ref: big, size: 26214401 }),
      media(chat, { kind: 'image', name: 'foto.heic', ref: gif }),
      media(chat, { kind: 'image', name: 'gone.jpg', ref: gone }),
      media(chat, { kind: 'file', name: 'bad.exe', ref: bad }),
    ]);
    await host.tick();
    const [conv] = await list(c);
    const m = await msgs(c, conv.id);
    assert.deepEqual(m.map((x) => [x.kind, x.bridge.placeholder && x.bridge.placeholder.state, x.bridge.placeholder && x.bridge.placeholder.reason]), [
      ['text', 'failed', 'too_large'], ['text', 'failed', 'type'], ['text', 'failed', 'gone'], ['text', 'failed', 'infected'],
    ]);
    assert.equal(host.bridges.fetches.filter((f) => f.ref === big).length, 0, 'too large: not even asked for');
    // the bridge is away: the file waits and comes later
    host.bridges.setHost({ bridgeDown: true });
    await host.bridges.deliver([media(chat, { kind: 'image', name: 'later.jpg', ref: later })]);
    await host.tick();
    let [l] = (await msgs(c, conv.id)).slice(-1);
    assert.deepEqual([l.kind, l.bridge.placeholder.state], ['text', 'loading']);
    host.bridges.setHost({ bridgeDown: false });
    await host.tick();
    [l] = (await msgs(c, conv.id)).slice(-1);
    assert.equal(l.kind, 'image');
  });
});

test('a message deleted at the other side takes its file with it', async () => {
  await withHost({ bridges: V4, scan: true }, async (host, c) => {
    const { chat } = await annaAndKim(c, host);
    const ev = media(chat, { kind: 'image', name: 'x.jpg', ref: host.bridges.file(ANNA.id, { data: JPEG, mime: 'image/jpeg' }) });
    await host.bridges.deliver([ev]);
    await host.tick();
    const [conv] = await list(c);
    const [m] = await msgs(c, conv.id);
    assert.equal(m.kind, 'image');
    await host.bridges.deliver([{ userId: ANNA.id, type: 'redact', chat, id: eid(), sender: KIM, target: ev.id }]);
    const [d] = await msgs(c, conv.id);
    assert.deepEqual([d.deleted, d.media], [true, null]);
    assert.equal((await host.mediaGet(ANNA, m.media.id)).status, 404);
    await host.tick();
    assert.equal((await host.mediaGet(ANNA, m.media.id)).status, 404, 'removed from GateControl too');
  });
});

test('pictures: the chat’s when it changes, a contact’s once somebody sees their messages — only for the person', async () => {
  await withHost({ bridges: V4, scan: true }, async (host, c) => {
    const pic1 = host.bridges.file(ANNA.id, { data: png(64, 64), mime: 'image/png' });
    const { chat } = await annaAndKim(c, host, { kind: 'group', name: 'Grillfreunde', avatar: pic1 });
    const kimPic = host.bridges.file(ANNA.id, { data: JPEG, mime: 'image/jpeg' });
    await host.bridges.deliver([{ userId: ANNA.id, type: 'message', chat, id: eid(), sender: { ...KIM, avatar: kimPic }, kind: 'text', text: 'Hallo', replyTo: null }]);
    await host.tick();
    // the contact's picture: not fetched until a message of theirs was shown (here: as the chat's last message)
    assert.equal(host.bridges.fetches.filter((f) => f.ref === kimPic).length, 0);
    let [conv] = await list(c);
    assert.match(conv.avatarMediaId, /^[0-9a-f]{32}$/);
    assert.equal((await host.mediaGet(ANNA, conv.avatarMediaId)).status, 200);
    assert.equal((await host.mediaGet(MARC, conv.avatarMediaId)).status, 404);
    const [pconv] = (await c.call(portal(ANNA), 'GET', 'conversations', null, B)).json.conversations;
    assert.match(pconv.avatarUrl, /^\/plugin-media\//);
    await host.tick();
    let [m] = await msgs(c, conv.id);
    [m] = await msgs(c, conv.id);
    assert.match(m.bridge.sender.avatarMediaId, /^[0-9a-f]{32}$/);
    assert.equal((await host.mediaGet(ANNA, m.bridge.sender.avatarMediaId)).status, 200);
    assert.equal((await host.mediaGet(MARC, m.bridge.sender.avatarMediaId)).status, 404, 'a contact’s picture: the person whose contact it is');
    // unchanged: not fetched again; taken away: gone
    const before = host.bridges.fetches.length;
    await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat: { ...chat, avatar: pic1 } }]);
    await host.tick();
    assert.equal(host.bridges.fetches.length, before);
    const old = conv.avatarMediaId;
    await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat: { ...chat, avatar: null } }]);
    [conv] = await list(c);
    assert.equal(conv.avatarMediaId, null);
    await host.tick();
    assert.equal((await host.mediaGet(ANNA, old)).status, 404);
  });
});

test('out: picture, voice message, video, file — after the scan, in a type the bridge takes; the rest stays refused', async () => {
  let held = false;
  await withHost({ bridges: V4, scan: () => (held ? { state: 'pending' } : null) }, async (host, c) => {
    const { chat } = await annaAndKim(c, host);
    await host.bridges.deliver([{ userId: ANNA.id, type: 'message', chat, id: eid(), sender: KIM, kind: 'text', text: 'Schick mal', replyTo: null }]);
    const [conv] = await list(c);
    const [first] = await msgs(c, conv.id);
    const send = (body) => bcall(c, ANNA, 'POST', `conversations/${conv.id}/messages`, { clientId: c.cid(), ...body });

    const pic = await c.upload(ANNA, PNG, 'image/webp');
    let r = await send({ kind: 'image', mediaId: pic, text: 'So sieht es aus', meta: { w: 800, h: 600 }, replyTo: first.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.message.status, 'sent');
    const s = host.bridges.sent.at(-1);
    assert.deepEqual([s.op, s.text, s.media, s.mime, s.replyTo], ['send', 'So sieht es aus', { mediaId: pic, kind: 'image', w: 800, h: 600 }, 'image/webp', first.id ? s.replyTo : null]);
    assert.match(s.replyTo, /^\$fm/);

    const ogg = await c.upload(ANNA, OGG, 'audio/ogg');
    r = await send({ kind: 'voice', mediaId: ogg, meta: { durationMs: 3000, waveform: [1, 2, 3] } });
    assert.equal(r.status, 200);
    assert.deepEqual(host.bridges.sent.at(-1).media, { mediaId: ogg, kind: 'voice', durationMs: 3000, waveform: [1, 2, 3] });
    const mp4 = await c.upload(ANNA, MP4, 'video/mp4');
    r = await send({ kind: 'file', mediaId: mp4, meta: { fileName: 'clip.mp4' }, video: { durationMs: 5000, width: 640, height: 360 } });
    assert.deepEqual(host.bridges.sent.at(-1).media, { mediaId: mp4, kind: 'video', name: 'clip.mp4', durationMs: 5000, w: 640, h: 360 });
    const pdf = await c.upload(ANNA, PDF, 'application/pdf');
    r = await send({ kind: 'file', mediaId: pdf, meta: { fileName: 'Plan.pdf' } });
    assert.deepEqual(host.bridges.sent.at(-1).media, { mediaId: pdf, kind: 'file', name: 'Plan.pdf' });
    const sentBefore = host.bridges.sent.length;

    // a voice message as webm: WhatsApp does not take it — refused before anything is stored
    const webm = await c.upload(ANNA, WEBM, 'audio/webm');
    r = await send({ kind: 'voice', mediaId: webm });
    assert.deepEqual([r.status, r.json.code, r.json.reason], [409, 'bridge_media_type', 'voice']);
    const gif = await c.upload(ANNA, Buffer.from('GIF89a'), 'image/gif');
    r = await send({ kind: 'image', mediaId: gif });
    assert.deepEqual([r.status, r.json.code, r.json.reason], [409, 'bridge_media_type', 'image']);
    // still being checked: not yet
    held = true;
    const wait = await c.upload(ANNA, JPEG, 'image/jpeg');
    held = false;
    r = await send({ kind: 'image', mediaId: wait });
    assert.deepEqual([r.status, r.json.code], [423, 'scan_pending']);
    // GateControl's own kinds stay out
    for (const body of [{ kind: 'location', location: { lat: 1, lon: 2 } }, { kind: 'poll', poll: { question: 'x', options: ['a', 'b'] } }, { kind: 'text', text: 'x', mediaId: pic }]) {
      r = await send(body);
      assert.deepEqual([r.status, r.json.code], [409, 'bridge_text_only'], JSON.stringify(body));
    }
    assert.equal(host.bridges.sent.length, sentBefore, 'nothing of it went out');
    // a caption is not edited at the other side
    const mine = (await msgs(c, conv.id)).filter((x) => x.mine && x.kind === 'image')[0];
    r = await bcall(c, ANNA, 'PATCH', `messages/${mine.id}`, { text: 'neu' });
    assert.equal(r.json.code, 'bridge_text_only');
  });
});

test('out: a file that did not go out is sent again with "Erneut senden"', async () => {
  await withHost({ bridges: V4, scan: true }, async (host, c) => {
    const { chat } = await annaAndKim(c, host);
    await host.bridges.deliver([{ userId: ANNA.id, type: 'message', chat, id: eid(), sender: KIM, kind: 'text', text: 'Hi', replyTo: null }]);
    const [conv] = await list(c);
    const pdf = await c.upload(ANNA, PDF, 'application/pdf');
    host.bridges.failSend = { code: 'ERR_BRIDGE_UNREACHABLE', reason: 'timeout' };
    let r = await bcall(c, ANNA, 'POST', `conversations/${conv.id}/messages`, { clientId: c.cid(), kind: 'file', mediaId: pdf, meta: { fileName: 'Plan.pdf' } });
    assert.deepEqual([r.json.message.status, r.json.message.bridge.reason], ['failed', 'timeout']);
    r = await bcall(c, ANNA, 'POST', `messages/${r.json.message.id}/resend`, {});
    assert.equal(r.json.message.status, 'sent');
    assert.deepEqual(host.bridges.sent.at(-1).media, { mediaId: pdf, kind: 'file', name: 'Plan.pdf' });
  });
});

test('a new chat by number: the linked person only, a child only with the parents’ yes, a limit — the number nowhere', async () => {
  await withHost({ bridges: V4, scan: true, services: [familie()] }, async (host, c) => {
    host.bridges.numbers.set('+4915112345678', { name: 'Kim Muster' });
    const me = c.as(ANNA);
    // not linked yet
    let r = await me('POST', 'bridges/whatsapp/resolve', { number: '+49 151 12345678' });
    assert.deepEqual([r.status, r.json.code, r.json.reason], [409, 'bridge_unlinked', 'unlinked']);
    await link(c, host, ANNA);
    r = await me('POST', 'bridges/whatsapp/resolve', { number: '+49 151 12345678' });
    assert.deepEqual([r.status, r.json.found, r.json.name], [200, true, 'Kim Muster']);
    r = await me('POST', 'bridges/whatsapp/resolve', { number: '+4915199999999' });
    assert.deepEqual([r.json.found, r.json.name, r.json.avatarUrl, r.json.existing], [false, null, null, null]);
    r = await me('POST', 'bridges/whatsapp/resolve', { number: '0151 12345678' });
    assert.deepEqual([r.status, r.json.code], [400, 'invalid_number']);
    r = await me('POST', 'bridges/whatsapp/resolve', {});
    assert.deepEqual([r.status, r.json.code], [400, 'invalid_number']);

    r = await me('POST', 'bridges/whatsapp/chats', { number: '+4915112345678' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.created, true);
    const conv = r.json.conversation;
    assert.deepEqual([conv.kind, conv.title, conv.bridge.network, conv.bridge.state, conv.can.send], ['direct', 'Kim Muster', 'whatsapp', 'ok', true]);
    // known at once (no message yet: not in the list, but there)
    assert.equal((await c.call(app(ANNA), 'GET', `conversations/${conv.id}`, null, B)).status, 200);
    assert.deepEqual(await list(c), []);
    r = await bcall(c, ANNA, 'POST', `conversations/${conv.id}/messages`, { clientId: c.cid(), kind: 'text', text: 'Hallo Kim, hier ist Anna!' });
    assert.equal(r.json.message.status, 'sent');
    // the same number again: the same chat
    r = await me('POST', 'bridges/whatsapp/chats', { number: '+49 151 1234 5678' });
    assert.deepEqual([r.json.created, r.json.conversation.id], [false, conv.id]);
    r = await me('POST', 'bridges/whatsapp/chats', { number: '+4915199999999' });
    assert.deepEqual([r.status, r.json.code, r.json.reason], [404, 'not_found', 'not_on_network']);

    // a child: locked until the parents allow it
    r = await c.as(LENA)('POST', 'bridges/whatsapp/resolve', { number: '+4915112345678' });
    assert.deepEqual([r.status, r.json.code], [403, 'bridge_locked']);
    // 1.16.0: the chat started here is found again by the number — without asking the service (test/newchat.test.js)
    r = await me('POST', 'bridges/whatsapp/resolve', { number: '+4915112345678' });
    assert.deepEqual([r.status, r.json.found, r.json.existing], [200, true, { conversationId: conv.id }]);
    // the number is in no log entry (of the plugin, of what the host was asked to note) and in no answer about the chat
    const log = JSON.stringify(host.bridges.state.log) + JSON.stringify((await c.admin('GET', 'log')).json) + JSON.stringify(await list(c)) + JSON.stringify(host.logs || []);
    assert.doesNotMatch(log, /4915112345678|15112345678/);
  });
});
