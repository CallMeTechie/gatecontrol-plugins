'use strict';

// 1.25.0 — the contacts' WhatsApp status updates in the status row (GateControl with gc.bridges version 12; the mock
// host's stand-in, tools/testing/mock-bridges.js; the events as GateControl's services/bridges/events.js makes them:
// chat.status on the room of the status updates, each status a message of the contact). Names and numbers are made up.
//
//   no chat     the room is not listed, not opened, not counted, causes no push, and is never marked read at the bridge
//   feed        GET status/feed → bridged (older clients read only items)
//   24 h        each status runs out 24 h after it was posted, with its file; a deletion of the contact at once
//   seen        watched here always; WhatsApp is told only with the person's switch and read receipts on, and only up
//               to the end of the watched run
//   answer      a text or an emoji goes as a message into the direct chat with the contact
//   older       a GateControl before version 12 never says chat.status: the chat stays a chat
//   catch-up    1.25.1: the one event with chat.status went to Messenger 1.24.x (server updated first) — the person's
//               next GET conversations / status/feed (then hourly until done) asks the bridge's chat list
//               (gc.bridges.chats, status: true) and puts it right

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, ANNA } = require('./helpers');

const V12 = { enabled: true, networks: { whatsapp: true }, running: true, version: 12 };
const V11 = { ...V12, version: 11 };
const B = { bridged: '1' };
const KIM = { id: 'c' + 'k'.repeat(21), name: 'Kim Muster' };
const JO = { id: 'c' + 'j'.repeat(21), name: 'Jo Test' };
const JO_DOT = { id: 'c' + 'd'.repeat(21), name: '…' };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(800, 7)]);
const HOUR = 3600000;
let n = 0;
const eid = () => `$st${++n}`;

async function link(c, host) {
  const me = c.as(ANNA);
  assert.equal((await me('POST', 'bridges/whatsapp/consent', { accept: true })).status, 200);
  let r = await me('POST', 'bridges/whatsapp/login', { flow: 'qr' });
  host.bridges.confirm(r.json.login.processId);
  r = await me('POST', `bridges/whatsapp/login/${r.json.login.processId}/${r.json.login.step.id}`, {});
  assert.equal(r.json.login.step.type, 'complete');
}
/** Anna's status room and her direct chat with Kim. → { room, dm } as the events carry them */
async function setup(c, host, { status = true } = {}) {
  await link(c, host);
  const st = host.bridges.chat(ANNA.id, { name: 'WhatsApp Status Broadcast', status });
  const d = host.bridges.chat(ANNA.id, { kind: 'direct', name: 'Kim Muster' });
  const room = { id: st, kind: 'group', name: 'WhatsApp Status Broadcast', avatar: null, channel: false, readOnly: true, ...(status ? { status: true } : {}) };
  const dm = { id: d, kind: 'direct', name: 'Kim Muster', avatar: null, channel: false, readOnly: false };
  await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat: room }, { userId: ANNA.id, type: 'chat', chat: dm }]);
  return { room, dm };
}
const msg = (chat, sender, text, extra = {}) => ({ userId: ANNA.id, type: 'message', chat, id: eid(), sender, kind: 'text', text, replyTo: null, ...extra });
const get = (c, path, q = B) => c.call(app(ANNA), 'GET', path, null, q);
const post = (c, path, body, q = B) => c.call(app(ANNA), 'POST', path, body, q);
const feedOf = async (c) => (await get(c, 'status/feed')).json;
/** A query on the plugin's own database file (read only). */
function query(host, sql, ...args) {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(require('node:path').join(host.filesDir, '..', 'plugin.db'), { readOnly: true });
  try { return d.prepare(sql).get(...args); } finally { d.close(); }
}

test('the status room is no chat: not listed, not opened, not counted, no push — its updates are in the status row', async () => {
  await withHost({ bridges: V12 }, async (host, c) => {
    const { room, dm } = await setup(c, host);
    const now = Date.now();
    await host.bridges.deliver([
      msg(dm, KIM, 'Hallo Anna'),
      msg(room, KIM, 'Heute ab 15 Uhr nicht erreichbar', { at: now - 2 * HOUR }),
      msg(room, JO, 'Abendrunde am See', { at: now - HOUR }),
      msg(room, KIM, 'Wieder da', { at: now - 60000 }),
    ]);
    assert.equal(c.pushes().length, 1, 'only the direct chat pushes');
    const list = (await get(c, 'conversations')).json.conversations;
    assert.deepEqual(list.map((x) => x.title), ['Kim Muster']);
    assert.equal(list.reduce((a, x) => a + x.unread, 0), 1);
    const conv = query(host, 'SELECT * FROM conversations WHERE bridge_status = 1');
    assert.ok(conv);
    assert.equal((await get(c, `conversations/${conv.id}`)).status, 404);
    assert.equal((await get(c, `conversations/${conv.id}/messages`)).status, 404);
    const me = (await get(c, 'me')).json;
    assert.equal(me.features.bridge_status, true);
    assert.equal(me.prefs.privacy.bridgedStatusSeen, false, 'off by default');
    const f = await feedOf(c);
    assert.deepEqual(f.items, [], 'no account has a status');
    assert.equal(f.bridged.length, 2);
    // the newest first (both unseen): Kim (a minute ago), then Jo
    assert.deepEqual(f.bridged.map((x) => [x.network, x.contact.name, x.stories.length, x.unseen]), [['whatsapp', 'Kim Muster', 2, true], ['whatsapp', 'Jo Test', 1, true]]);
    const kim = f.bridged[0];
    assert.equal(kim.chatId, list[0].id, 'the direct chat with Kim, for an answer');
    assert.equal(kim.canReply, true);
    assert.deepEqual(kim.stories.map((s) => [s.kind, s.text, s.seen]), [['text', 'Heute ab 15 Uhr nicht erreichbar', false], ['text', 'Wieder da', false]]);
    assert.equal(Date.parse(kim.stories[0].expiresAt) - Date.parse(kim.stories[0].createdAt), 24 * HOUR);
    // nothing went to the bridge: no read receipt, no message
    assert.deepEqual(host.bridges.sent.filter((s) => s.chatId === room.id), []);
    // a client without ?bridged=1 gets no `bridged` entries it could not show either way — items only
    assert.ok(Array.isArray((await get(c, 'status/feed', {})).json.items));
  });
});

test('24 hours: a status runs out with its file; one older already is not filed; a deletion goes at once', async () => {
  await withHost({ bridges: V12, scan: true }, async (host, c) => {
    const { room } = await setup(c, host);
    const ref = host.bridges.file(ANNA.id, { data: JPEG, mime: 'image/jpeg' });
    const now = Date.now();
    const pic = msg(room, KIM, 'Abendrunde', { kind: 'media', media: { kind: 'image', ref, mime: 'image/jpeg', w: 10, h: 10, size: JPEG.length, name: 'status.jpg' }, at: now - 23 * HOUR });
    const gone = msg(room, KIM, 'Gelöscht', { at: now - HOUR });
    await host.bridges.deliver([msg(room, JO, 'Zu alt', { at: now - 25 * HOUR }), pic, gone]);
    await host.tick();
    let f = await feedOf(c);
    assert.equal(f.bridged.length, 1, 'Jo’s status had run out already');
    assert.deepEqual(f.bridged[0].stories.map((s) => [s.kind, s.text, !!s.mediaId]), [['image', 'Abendrunde', true], ['text', 'Gelöscht', false]]);
    const mediaId = f.bridged[0].stories[0].mediaId;
    await host.bridges.deliver([{ userId: ANNA.id, type: 'redact', chat: room, id: eid(), sender: KIM, target: gone.id }]);
    f = await feedOf(c);
    assert.deepEqual(f.bridged[0].stories.map((s) => s.text), ['Abendrunde']);
    assert.ok(host.events.some((e) => e.type === 'story.bridged' && e.data.action === 'remove'));
    // an hour and a bit later the picture ran out: gone with its file
    c.clock.add(1.1 * HOUR);
    assert.deepEqual((await feedOf(c)).bridged, [], 'not shown once it ran out');
    await host.tick();
    await host.tick();
    // the picture's row went for good; the deleted one is a tombstone without content until its own 24 h are over
    const left = query(host, 'SELECT COUNT(*) AS n, SUM(CASE WHEN body_enc IS NULL THEN 0 ELSE 1 END) AS content FROM messages WHERE conv_id = (SELECT id FROM conversations WHERE bridge_status = 1)');
    assert.deepEqual([left.n, left.content], [1, 0]);
    assert.equal(query(host, 'SELECT COUNT(*) AS n FROM media WHERE media_id = ?', mediaId).n, 0, 'the file went too');
  });
});

test('seen: here always; WhatsApp only with the switch and read receipts, and only up to the end of the watched run', async () => {
  await withHost({ bridges: V12 }, async (host, c) => {
    const { room } = await setup(c, host);
    const now = Date.now();
    const a = msg(room, KIM, 'eins', { at: now - 3 * HOUR });
    const b = msg(room, JO, 'zwei', { at: now - 2 * HOUR });
    const k = msg(room, KIM, 'drei', { at: now - HOUR });
    await host.bridges.deliver([a, b, k]);
    const ids = async () => { const f = await feedOf(c); return Object.fromEntries(f.bridged.flatMap((x) => x.stories.map((s) => [s.text, s]))); };
    let s = await ids();
    const reads = () => host.bridges.sent.filter((x) => x.op === 'read' && x.chatId === room.id);
    // switch off (default): watched here, nothing to WhatsApp
    assert.deepEqual((await post(c, `status/bridged/${s.eins.id}/seen`, {})).json, { ok: true, seen: true, reported: false });
    s = await ids();
    assert.equal(s.eins.seen, true);
    assert.deepEqual(reads(), []);
    // the switch on, but read receipts off: still nothing
    await c.call(app(ANNA), 'PUT', 'prefs', { readReceipts: false, privacy: { bridgedStatusSeen: true } }, B);
    assert.equal((await post(c, `status/bridged/${s.drei.id}/seen`, {})).json.reported, false);
    assert.deepEqual(reads(), []);
    // read receipts on: Kim's „drei“ was watched, Jo's „zwei“ before it not — only „eins“ may be told
    await c.call(app(ANNA), 'PUT', 'prefs', { readReceipts: true }, B);
    assert.equal((await post(c, `status/bridged/${s.eins.id}/seen`, {})).json.reported, true);
    assert.deepEqual(reads().map((x) => [x.messageId, x.status]), [[a.id, true]]);
    // Jo's watched now: the run reaches „drei“
    await post(c, `status/bridged/${s.zwei.id}/seen`, {});
    assert.deepEqual(reads().map((x) => x.messageId), [a.id, k.id]);
    // nothing new: nothing told again
    await post(c, `status/bridged/${s.drei.id}/seen`, {});
    assert.equal(reads().length, 2);
    // somebody else's status, an unknown one: not found
    assert.equal((await post(c, 'status/bridged/999999/seen', {})).status, 404);
  });
});

test('an answer and an emoji go as messages into the WhatsApp direct chat — nothing into the status room', async () => {
  await withHost({ bridges: V12 }, async (host, c) => {
    const { room, dm } = await setup(c, host);
    const st = msg(room, KIM, 'Wieder da');
    await host.bridges.deliver([msg(dm, KIM, 'Hallo'), st]);
    const id = (await feedOf(c)).bridged[0].stories[0].id;
    let r = await post(c, `status/bridged/${id}/reply`, { text: 'Schön!', clientId: 'reply-0001' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.message.text, 'Schön!');
    r = await post(c, `status/bridged/${id}/reply`, { emoji: '❤️', clientId: 'reply-0002' });
    assert.equal(r.json.message.text, '❤️ auf deinen Status');
    assert.equal(r.json.emoji, '❤️');
    const out = host.bridges.sent.filter((x) => x.op === 'send');
    assert.deepEqual(out.map((x) => [x.chatId, x.text, x.replyTo]), [[dm.id, 'Schön!', null], [dm.id, '❤️ auf deinen Status', null]]);
    assert.equal((await feedOf(c)).bridged[0].stories[0].seen, true, 'an answer counts as watched');
    for (const bad of [{}, { text: '' }, { emoji: 'abc' }, { text: 'x', emoji: '❤️' }]) assert.equal((await post(c, `status/bridged/${id}/reply`, bad)).status, 400, JSON.stringify(bad));
    // Jo has no direct chat and is not in the bridge's contacts: no answer
    const jo = msg(room, JO, 'Hallo zusammen');
    await host.bridges.deliver([jo]);
    const joId = (await feedOf(c)).bridged.find((x) => x.contact.name === 'Jo Test').stories[0].id;
    r = await post(c, `status/bridged/${joId}/reply`, { text: 'Hi' });
    assert.deepEqual([r.status, r.json.code], [404, 'not_found']);
  });
});

test('an older GateControl (gc.bridges version 11) never says chat.status: the chat stays a chat, read as before', async () => {
  await withHost({ bridges: V11 }, async (host, c) => {
    const { room } = await setup(c, host, { status: false });
    await host.bridges.deliver([msg(room, KIM, 'Status')]);
    const list = (await get(c, 'conversations')).json.conversations;
    assert.ok(list.some((x) => x.title === 'WhatsApp Status Broadcast'));
    const f = await feedOf(c);
    assert.equal(f.bridged, undefined);
    assert.equal((await get(c, 'me')).json.features.bridge_status, undefined);
  });
});

test('a chat „WhatsApp Status Broadcast“ from before turns into the status room — out of the list, nothing lost', async () => {
  await withHost({ bridges: V12 }, async (host, c) => {
    const { room } = await setup(c, host, { status: false });
    const plain = { ...room };
    delete plain.status;
    await host.bridges.deliver([msg(plain, KIM, 'Vorher')]);
    assert.ok((await get(c, 'conversations')).json.conversations.some((x) => x.title === 'WhatsApp Status Broadcast'));
    // GateControl 12 looks at the room again: the event says status
    await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat: { ...room, status: true } }]);
    assert.deepEqual((await get(c, 'conversations')).json.conversations.map((x) => x.title), []);
    assert.deepEqual((await feedOf(c)).bridged.map((x) => x.stories.map((s) => s.text)), [['Vorher']]);
  });
});

/** The server updated first: its one event with chat.status reached Messenger 1.24.x, which kept the room as a group. */
async function setupOld(c, host) {
  await link(c, host);
  const st = host.bridges.chat(ANNA.id, { name: 'WhatsApp Status Broadcast', status: true });
  const old = { id: st, kind: 'group', name: 'WhatsApp Status Broadcast', avatar: null, channel: false, readOnly: true };
  await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat: old }]);
  return old;
}

test('1.25.1: the status room an older version kept as a chat is caught up on the next list — hidden, muted, 24 h, in the feed', async () => {
  await withHost({ bridges: V12 }, async (host, c) => {
    const old = await setupOld(c, host);
    const now = Date.now();
    await host.bridges.deliver([msg(old, KIM, 'Vorher', { at: now - HOUR }), msg(old, JO, 'Ganz alt', { at: now - 30 * HOUR })]);
    // as Messenger 1.24.x left it: a group chat with messages, no status room
    assert.deepEqual({ ...query(host, "SELECT kind, bridge_status FROM conversations WHERE bridge_net = 'whatsapp'") }, { kind: 'group', bridge_status: 0 });
    assert.deepEqual((await get(c, 'conversations')).json.conversations.map((x) => x.title), []);
    const conv = query(host, 'SELECT * FROM conversations WHERE bridge_status = 1');
    assert.ok(conv, 'the status room');
    assert.equal(query(host, 'SELECT notify FROM members WHERE conv_id = ?', conv.id).notify, 'none');
    const m = query(host, 'SELECT COUNT(*) AS n, SUM(CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END) AS open, MIN(expires_at) AS first FROM messages WHERE conv_id = ?', conv.id);
    assert.equal(m.open, 0, 'every message runs out');
    assert.equal(m.first, now - 30 * HOUR + 24 * HOUR);
    assert.deepEqual((await feedOf(c)).bridged.map((x) => x.stories.map((s) => s.text)), [['Vorher']]);
    assert.equal((await get(c, 'me')).json.features.bridge_status, true);
    assert.ok(query(host, 'SELECT value FROM settings WHERE key = ?', `bridge_status_catchup:${ANNA.id}`), 'done — never again');
    assert.ok(query(host, "SELECT 1 AS x FROM log WHERE code = 'bridge_status_caught_up'"));
  });
});

test('1.25.1: the catch-up looks again an hour later while the bridge names no chats, and ends once it did', async () => {
  await withHost({ bridges: V12 }, async (host, c) => {
    const old = await setupOld(c, host);
    await host.bridges.deliver([msg(old, KIM, 'Vorher', { at: Date.now() - HOUR })]);
    const titles = async () => (await get(c, 'conversations')).json.conversations.map((x) => x.title);
    const done = () => query(host, 'SELECT value FROM settings WHERE key = ?', `bridge_status_catchup:${ANNA.id}`);
    // the bridges answer with no chats at all (away for a while): nothing changes, not done
    const chats = host.bridges.state.chats;
    const kept = new Map(chats);
    chats.clear();
    assert.deepEqual(await titles(), ['WhatsApp Status Broadcast']);
    assert.equal(done(), undefined);
    for (const [k, v] of kept) chats.set(k, v);
    // within the hour: not again
    c.clock.add(30 * 60000);
    assert.deepEqual(await titles(), ['WhatsApp Status Broadcast']);
    // an hour on: caught up (the status feed asks as well), done
    c.clock.add(31 * 60000);
    assert.deepEqual((await feedOf(c)).bridged.map((x) => x.stories.map((s) => s.text)), [['Vorher']]);
    assert.deepEqual(await titles(), []);
    assert.ok(done());
  });
});

test('1.25.1: no catch-up without gc.bridges version 12', async () => {
  await withHost({ bridges: V11 }, async (host, c) => {
    const { room } = await setup(c, host, { status: false });
    await host.bridges.deliver([msg(room, KIM, 'Status')]);
    assert.ok((await get(c, 'conversations')).json.conversations.some((x) => x.title === 'WhatsApp Status Broadcast'));
    await feedOf(c);
    assert.equal(query(host, 'SELECT COUNT(*) AS n FROM conversations WHERE bridge_status = 1').n, 0);
    assert.equal(query(host, 'SELECT value FROM settings WHERE key = ?', `bridge_status_catchup:${ANNA.id}`), undefined, 'looked at once GateControl has it');
  });
});

// ─── 1.25.2: who a status is from ─────────────────────────────────────────────
//
// The bridge names the sender of a status by the contact's LID ghost (pickLID) and its public WhatsApp name — often „.“
// or nothing, never the name of the person's address book; the ghost's picture comes later or not at all. The status
// row names the contact as the person knows it: address book (Mail), the direct chat, the bridge's contacts — the ghost's
// name last, never „.“ — and shows the direct chat's picture, else the contact's own.

const NUMBER = '+4915100000000';
const LID = { id: 'c' + 'l'.repeat(21), name: '.' };
const KIM_PN = { id: 'c' + 'p'.repeat(21), name: 'Kim Muster' };
function mail(book) {
  return {
    plugin: 'gatecontrol-mail', provides: { contacts_phones: { label: { de: 'Kontakte', en: 'Contacts' }, maxPerHour: 3600 } },
    service: async ({ user, payload }) => {
      if (!user || payload.userId !== user.id) return { ok: false, code: 'forbidden' };
      return { ok: true, items: book[user.id] || [], next: null };
    },
  };
}
const BOOK = { [ANNA.id]: [{ id: 31, name: 'Kim Muster', phones: [{ key: 'mobile', kind: 'mobile', value: '0151 00000000', e164: NUMBER, landline: false }] }] };

test('1.25.2: a LID ghost named „.“ without a chat — the address book names it (by the contactId), never „.“', async () => {
  require('../server/contactchat')._reset();
  await withHost({ bridges: V12, services: [mail(BOOK)] }, async (host, c) => {
    const { room } = await setup(c, host);
    host.bridges.contacts = [{ number: NUMBER, name: '.', contactId: LID.id }];
    await host.bridges.deliver([msg(room, LID, 'Neuer Status')]);
    const f = await feedOf(c);
    assert.deepEqual(f.bridged.map((x) => [x.contact.name, x.chatId, x.stories[0].text]), [['Kim Muster', null, 'Neuer Status']]);
    assert.equal(f.bridged[0].canReply, true, 'an answer finds the chat by the bridge’s contacts');
  });
});

test('1.25.2: the direct chat found by the bridge’s contacts gives name and picture; without anything „WhatsApp-Kontakt“', async () => {
  require('../server/contactchat')._reset();
  await withHost({ bridges: V12, scan: true }, async (host, c) => {
    const { room, dm } = await setup(c, host);
    // the direct chat: its picture (the contact's, private_chat_portal_meta), a message of the number's ghost
    const pic = host.bridges.file(ANNA.id, { data: JPEG, mime: 'image/jpeg' });
    await host.bridges.deliver([msg({ ...dm, avatar: pic }, KIM_PN, 'Hallo Anna'), msg(room, LID, 'Wieder da'), msg(room, JO_DOT, 'Ohne Namen')]);
    await host.tick();
    const conv = (await get(c, 'conversations')).json.conversations[0];
    assert.match(String(conv.avatarMediaId), /^[0-9a-f]{32}$/);
    // the bridge's contacts: the LID ghost (the same contactId as the status) and its direct chat
    host.bridges.contacts = [{ number: NUMBER, name: '.', contactId: LID.id, chatId: dm.id }];
    const f = await feedOf(c);
    const kim = f.bridged.find((x) => x.stories[0].text === 'Wieder da');
    assert.deepEqual([kim.contact.name, kim.chatId, kim.contact.avatarMediaId], ['Kim Muster', conv.id, conv.avatarMediaId]);
    const jo = f.bridged.find((x) => x.stories[0].text === 'Ohne Namen');
    assert.deepEqual([jo.contact.name, jo.chatId, jo.contact.avatarMediaId], ['WhatsApp-Kontakt', null, null]);
  });
});

test('1.25.2: the bridge’s contacts name a contact without a chat; the ghost’s own name comes last', async () => {
  require('../server/contactchat')._reset();
  await withHost({ bridges: V12 }, async (host, c) => {
    const { room } = await setup(c, host);
    host.bridges.contacts = [{ number: NUMBER, name: 'Kim Muster', contactId: LID.id }];
    await host.bridges.deliver([msg(room, LID, 'Status'), msg(room, JO, 'Status')]);
    const f = await feedOf(c);
    assert.deepEqual(f.bridged.map((x) => x.contact.name).sort(), ['Jo Test', 'Kim Muster']);
  });
});

test('1.25.2: the contact’s own picture is fetched as the status comes, and the status row learns it', async () => {
  await withHost({ bridges: V12, scan: true }, async (host, c) => {
    const { room } = await setup(c, host);
    const pic = host.bridges.file(ANNA.id, { data: JPEG, mime: 'image/jpeg' });
    await host.bridges.deliver([msg(room, { ...LID, avatar: pic }, 'Status mit Bild')]);
    await host.tick();
    assert.ok(host.events.some((e) => e.type === 'story.bridged' && e.data.action === 'contact'), 'the apps load the feed again');
    const [x] = (await feedOf(c)).bridged;
    assert.equal(x.contact.name, 'WhatsApp-Kontakt');
    assert.match(String(x.contact.avatarMediaId), /^[0-9a-f]{32}$/);
    assert.equal((await host.mediaGet(ANNA, x.contact.avatarMediaId)).status, 200);
  });
});

test('1.25.2: several pictures of one contact, filed right after each other — each status its own file', async () => {
  await withHost({ bridges: V12, scan: true }, async (host, c) => {
    const { room } = await setup(c, host);
    const now = Date.now();
    const pics = [1, 2, 3].map((k) => {
      const data = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(800, k)]);
      return msg(room, KIM, `Bild ${k}`, { kind: 'media', media: { kind: 'image', ref: host.bridges.file(ANNA.id, { data, mime: 'image/jpeg' }), mime: 'image/jpeg', w: 10, h: 10, size: data.length, name: `s${k}.jpg` }, at: now - (4 - k) * 60000 });
    });
    await host.bridges.deliver(pics);
    await host.tick();
    const [x] = (await feedOf(c)).bridged;
    assert.deepEqual(x.stories.map((s) => s.text), ['Bild 1', 'Bild 2', 'Bild 3']);
    const ids = x.stories.map((s) => s.mediaId);
    assert.equal(new Set(ids).size, 3, 'three files');
    for (const [k, id] of ids.entries()) {
      const r = await host.mediaGet(ANNA, id);
      assert.equal(r.status, 200);
      assert.equal(Buffer.from(r.body || r.buffer || []).at(-1), k + 1, 'its own picture');
    }
  });
});
