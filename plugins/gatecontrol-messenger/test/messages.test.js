'use strict';

// Messages: sending every kind (with the server's checks), idempotent clientId,
// replies, pages, edit/delete within the window, reactions (one per person),
// search, the media list — and encryption at rest.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, MIN, SEC, PNG, OGG, PDF } = require('./helpers');

test('text: idempotent by clientId, trimmed, ≤ 4000 characters, replies with a quote', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const anna = c.as(ANNA);
    const body = { clientId: 'abcdef1234', kind: 'text', text: '  Bist du schon unterwegs?\r\n\n\n\n\nZeile  ' };
    const r1 = await anna('POST', `conversations/${d.id}/messages`, body);
    assert.equal(r1.status, 200);
    assert.equal(r1.json.duplicate, false);
    assert.equal(r1.json.message.text, 'Bist du schon unterwegs?\n\n\nZeile');
    const r2 = await anna('POST', `conversations/${d.id}/messages`, { ...body, text: 'anders' });
    assert.equal(r2.json.duplicate, true);
    assert.equal(r2.json.message.id, r1.json.message.id, 'a retry with the same clientId returns the stored message');
    assert.equal((await anna('GET', `conversations/${d.id}/messages`)).json.messages.length, 1);
    assert.equal(c.pushes().length, 1, 'one push only');
    // the same clientId from the other person is another message
    const r3 = await c.as(MARC)('POST', `conversations/${d.id}/messages`, { clientId: 'abcdef1234', kind: 'text', text: 'Gleich', replyTo: r1.json.message.id });
    assert.equal(r3.json.duplicate, false);
    assert.deepEqual(r3.json.message.replyTo, { id: r1.json.message.id, senderId: ANNA.id, kind: 'text', text: 'Bist du schon unterwegs?\n\n\nZeile', deleted: false, missing: false });
    for (const bad of [{ kind: 'text', text: '' }, { kind: 'text', text: '   ' }, { kind: 'text', text: 'x'.repeat(4001) }, { kind: 'text' }, { kind: 'system', text: 'x' },
      { kind: 'text', text: 'x', replyTo: 999 }, { kind: 'text', text: 'x', mediaId: 'a'.repeat(32) }, { kind: 'text', text: 'x', location: { lat: 1, lon: 2 } }]) {
      const r = await anna('POST', `conversations/${d.id}/messages`, { clientId: c.cid(), ...bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    for (const clientId of [undefined, 'short', 'has space here', 'x'.repeat(65)]) {
      assert.equal((await anna('POST', `conversations/${d.id}/messages`, { clientId, kind: 'text', text: 'x' })).json.code, 'invalid');
    }
    assert.equal((await anna('POST', `conversations/${d.id}/messages`, { clientId: c.cid(), text: 'ohne kind' })).json.message.kind, 'text', 'kind defaults to text');
  });
});

test('image, voice, file, location: media claimed on send, meta checked, only own unused uploads', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC]);
    const img = await c.upload(ANNA, PNG, 'image/png');
    const thumb = await c.upload(ANNA, PNG, 'image/png');
    assert.equal(host.media.get(img).claimed, false);
    const m1 = await c.send(ANNA, g.id, { kind: 'image', mediaId: img, thumbMediaId: thumb, text: 'Einkaufszettel', meta: { w: 1200, h: 900 } });
    assert.equal(host.media.get(img).claimed, true, 'claimed when the message is stored');
    assert.equal(host.media.get(thumb).claimed, true);
    assert.deepEqual([m1.kind, m1.text, m1.meta, m1.media.id, m1.media.mime, m1.media.bytes, m1.media.thumbId, m1.media.url], ['image', 'Einkaufszettel', { w: 1200, h: 900 }, img, 'image/png', PNG.length, thumb, null]);
    const voice = await c.upload(ANNA, OGG, 'audio/ogg');
    const m2 = await c.send(ANNA, g.id, { kind: 'voice', mediaId: voice, meta: { durationMs: 14000, waveform: [0, 40, 255, 12] } });
    assert.deepEqual(m2.meta, { durationMs: 14000, waveform: [0, 40, 255, 12] });
    const pdf = await c.upload(ANNA, PDF, 'application/pdf');
    const m3 = await c.send(ANNA, g.id, { kind: 'file', mediaId: pdf, meta: { fileName: 'Elternbrief_Ausflug.pdf' } });
    assert.equal(m3.meta.fileName, 'Elternbrief_Ausflug.pdf');
    const m4 = await c.send(ANNA, g.id, { kind: 'location', location: { lat: 50.94, lon: 6.96, label: 'Kölner Dom', accuracy: 12.4 } });
    assert.deepEqual(m4.location, { lat: 50.94, lon: 6.96, label: 'Kölner Dom', accuracy: 12 });
    const anna = c.as(ANNA);
    const send = (b) => anna('POST', `conversations/${g.id}/messages`, { clientId: c.cid(), ...b });
    // someone else's upload, an upload used twice, wrong types, unknown ids
    const marcs = await c.upload(MARC, PNG, 'image/png');
    assert.equal((await send({ kind: 'image', mediaId: marcs })).json.code, 'media_invalid');
    assert.equal((await send({ kind: 'image', mediaId: img })).json.code, 'media_in_use');
    assert.equal((await send({ kind: 'voice', mediaId: await c.upload(ANNA, PNG, 'image/png') })).json.code, 'media_invalid');
    assert.equal((await send({ kind: 'image', mediaId: await c.upload(ANNA, PDF, 'application/pdf') })).json.code, 'media_invalid');
    assert.equal((await send({ kind: 'image', mediaId: 'f'.repeat(32) })).json.code, 'media_invalid');
    assert.equal((await send({ kind: 'image' })).json.code, 'invalid');
    const bigThumb = await c.upload(ANNA, Buffer.concat([PNG, Buffer.alloc(70000)]), 'image/png');
    assert.equal((await send({ kind: 'image', mediaId: await c.upload(ANNA, PNG, 'image/png'), thumbMediaId: bigThumb })).json.code, 'media_invalid', 'a preview over 64 KB');
    // meta / location checks; a voice message longer than the administrator allows (5 min + 1 s)
    assert.equal((await send({ kind: 'voice', mediaId: await c.upload(ANNA, OGG, 'audio/ogg'), meta: { durationMs: 302000 } })).json.code, 'invalid');
    assert.equal((await send({ kind: 'voice', mediaId: await c.upload(ANNA, OGG, 'audio/ogg'), meta: { waveform: new Array(65).fill(1) } })).json.code, 'invalid');
    assert.equal((await send({ kind: 'file', mediaId: await c.upload(ANNA, PDF, 'application/pdf'), meta: { w: 10 } })).json.code, 'invalid');
    assert.equal((await send({ kind: 'location', location: { lat: 91, lon: 0 } })).json.code, 'invalid');
    assert.equal((await send({ kind: 'location' })).json.code, 'invalid');
    // the conversation list shows a preview of the newest
    const conv = (await c.as(MARC)('GET', `conversations/${g.id}`)).json.conversation;
    assert.equal(conv.lastMessage.kind, 'location');
    assert.equal(conv.unread, 4);
  });
});

test('pages: newest first page ascending, before / after / changedSince, limit ≤ 100', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const ids = [];
    for (let i = 0; i < 7; i++) { ids.push((await c.send(ANNA, d.id, { text: `n${i}` })).id); c.clock.add(SEC); }
    const marc = c.as(MARC);
    let r = (await marc('GET', `conversations/${d.id}/messages`, null, { limit: '3' })).json;
    assert.deepEqual(r.messages.map((m) => m.text), ['n4', 'n5', 'n6']);
    assert.equal(r.hasMore, true);
    r = (await marc('GET', `conversations/${d.id}/messages`, null, { limit: '3', before: String(ids[4]) })).json;
    assert.deepEqual(r.messages.map((m) => m.text), ['n1', 'n2', 'n3']);
    r = (await marc('GET', `conversations/${d.id}/messages`, null, { limit: '3', before: String(ids[1]) })).json;
    assert.deepEqual([r.messages.map((m) => m.text), r.hasMore], [['n0'], false]);
    r = (await marc('GET', `conversations/${d.id}/messages`, null, { after: String(ids[4]) })).json;
    assert.deepEqual([r.messages.map((m) => m.text), r.hasMore], [['n5', 'n6'], false]);
    const t = new Date(Date.now()).toISOString();
    c.clock.add(SEC);
    await c.as(ANNA)('PATCH', `messages/${ids[2]}`, { text: 'n2!' });
    c.clock.add(SEC);
    await marc('PUT', `messages/${ids[0]}/reaction`, { emoji: '👍' });
    r = (await marc('GET', `conversations/${d.id}/messages`, null, { changedSince: t })).json;
    assert.deepEqual(r.messages.map((m) => m.text), ['n2!', 'n0'], 'edited and reacted messages, by change time');
    for (const q of [{ limit: '101' }, { limit: '0' }, { before: 'x' }, { before: '3', after: '1' }, { changedSince: 'gestern' }]) {
      assert.equal((await marc('GET', `conversations/${d.id}/messages`, null, q)).json.code, 'invalid', JSON.stringify(q));
    }
  });
});

test('pages (1.1.0): around=<id> gives the messages before and after it; serverTime in every mode', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const ids = [];
    for (let i = 0; i < 9; i++) { ids.push((await c.send(ANNA, d.id, { text: `n${i}` })).id); c.clock.add(SEC); }
    const marc = c.as(MARC);
    const get = async (q) => (await marc('GET', `conversations/${d.id}/messages`, null, q)).json;
    let r = await get({ around: String(ids[4]), limit: '5' });
    assert.deepEqual(r.messages.map((m) => m.text), ['n2', 'n3', 'n4', 'n5', 'n6'], '2 older, the message, 2 newer');
    assert.deepEqual([r.hasMore, r.hasMoreBefore, r.hasMoreAfter], [true, true, true]);
    assert.equal(r.serverTime, new Date(Date.now()).toISOString());
    r = await get({ around: String(ids[1]), limit: '6' });
    assert.deepEqual(r.messages.map((m) => m.text), ['n0', 'n1', 'n2', 'n3'], 'fewer older ones at the start (the newer half is not filled up)');
    assert.deepEqual([r.hasMoreBefore, r.hasMoreAfter], [false, true]);
    r = await get({ around: String(ids[8]), limit: '4' });
    assert.deepEqual(r.messages.map((m) => m.text), ['n6', 'n7', 'n8']);
    assert.deepEqual([r.hasMore, r.hasMoreBefore, r.hasMoreAfter], [true, true, false]);
    r = await get({ around: String(ids[4]), limit: '1' });
    assert.deepEqual([r.messages.map((m) => m.text), r.hasMoreBefore, r.hasMoreAfter], [['n4'], true, true]);
    // a message hidden for the viewer: its neighbours (the position still counts)
    await marc('DELETE', `messages/${ids[4]}`, null, { for: 'me' });
    r = await get({ around: String(ids[4]), limit: '4' });
    assert.deepEqual(r.messages.map((m) => m.text), ['n2', 'n3', 'n5', 'n6']);
    // the other modes carry serverTime too; it works as the next changedSince
    for (const q of [{}, { before: String(ids[3]) }, { after: String(ids[3]) }, { changedSince: new Date(Date.now() - 1000).toISOString() }]) {
      assert.equal((await get(q)).serverTime, new Date(Date.now()).toISOString(), JSON.stringify(q));
    }
    const t = (await get({})).serverTime;
    c.clock.add(SEC);
    await c.as(ANNA)('PATCH', `messages/${ids[7]}`, { text: 'n7!' });
    assert.deepEqual((await get({ changedSince: t })).messages.map((m) => m.text), ['n7!']);
    for (const q of [{ around: 'x' }, { around: '0' }, { around: String(ids[2]), before: String(ids[3]) }, { around: String(ids[2]), after: String(ids[1]) }, { around: String(ids[2]), limit: '101' }]) {
      assert.equal((await get(q)).code, 'invalid', JSON.stringify(q));
    }
    // another conversation's message id is only a position: nothing of that chat comes back
    const other = await c.direct(ANNA, LENA);
    const foreign = await c.send(ANNA, other.id, { text: 'privat' });
    r = await get({ around: String(foreign.id), limit: '4' });
    assert.ok(!r.messages.some((m) => m.text === 'privat'));
  });
});

test('edit and delete for everyone: sender only, within the window (default 15 min; 0 = never)', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const m = await c.send(ANNA, d.id, { text: 'Treffen um 5' });
    c.resetEvents();
    let r = await c.as(MARC)('PATCH', `messages/${m.id}`, { text: 'gehackt' });
    assert.equal(r.json.code, 'not_sender');
    c.clock.add(14 * MIN);
    r = await c.as(ANNA)('PATCH', `messages/${m.id}`, { text: 'Treffen um 6' });
    assert.equal(r.status, 200);
    assert.equal(r.json.message.text, 'Treffen um 6');
    assert.ok(r.json.message.editedAt);
    assert.deepEqual(c.events('message.update').map((e) => [e.users.sort(), e.data.messageId]), [[[ANNA.id, MARC.id], m.id]]);
    assert.equal((await c.as(ANNA)('PATCH', `messages/${m.id}`, { text: '' })).json.code, 'invalid', 'a text message keeps a text');
    c.clock.add(2 * MIN);
    assert.equal((await c.as(ANNA)('PATCH', `messages/${m.id}`, { text: 'zu spät' })).json.code, 'edit_window');
    assert.equal((await c.as(ANNA)('DELETE', `messages/${m.id}`, null, { for: 'all' })).json.code, 'edit_window');
    // within the window: delete for everyone → tombstone, reactions gone, event to both
    const m2 = await c.send(ANNA, d.id, { text: 'Ups' });
    await c.as(MARC)('PUT', `messages/${m2.id}/reaction`, { emoji: '😂' });
    assert.equal((await c.as(MARC)('DELETE', `messages/${m2.id}`, null, { for: 'all' })).json.code, 'not_sender');
    c.resetEvents();
    r = await c.as(ANNA)('DELETE', `messages/${m2.id}`, null, { for: 'all' });
    assert.equal(r.json.forAll, true);
    assert.deepEqual([r.json.message.deleted, r.json.message.text, r.json.message.reactions], [true, null, []]);
    assert.deepEqual(c.events('message.delete')[0].data, { conversationId: d.id, messageIds: [m2.id], reason: 'deleted' });
    const seen = (await c.as(MARC)('GET', `conversations/${d.id}/messages`)).json.messages.find((x) => x.id === m2.id);
    assert.deepEqual([seen.deleted, seen.text, seen.reactions], [true, null, []]);
    assert.equal((await c.as(ANNA)('PATCH', `messages/${m2.id}`, { text: 'x' })).json.code, 'deleted');
    assert.equal((await c.as(MARC)('PUT', `messages/${m2.id}/reaction`, { emoji: '👍' })).json.code, 'deleted');
    // 0 = no editing or deleting for everyone at all
    await c.admin('PUT', 'settings', { editWindowMin: 0 });
    const m3 = await c.send(ANNA, d.id, { text: 'fix' });
    assert.equal((await c.as(ANNA)('PATCH', `messages/${m3.id}`, { text: 'fix2' })).json.code, 'edit_window');
    assert.equal((await c.as(ANNA)('GET', 'me')).json.limits.editWindowS, 0);
  });
});

test('delete for me: hidden for that person only (any message), on the person\'s devices', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    const m = await c.send(ANNA, d.id, { text: 'Geheimnis' });
    c.resetEvents();
    const r = await c.as(MARC)('DELETE', `messages/${m.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.forAll, false);
    assert.deepEqual(c.events('message.delete').map((e) => [e.users, e.data.reason]), [[[MARC.id], 'hidden']]);
    assert.equal((await c.as(MARC)('GET', `conversations/${d.id}/messages`)).json.messages.length, 0);
    assert.equal((await c.as(ANNA)('GET', `conversations/${d.id}/messages`)).json.messages.length, 1);
    assert.equal((await c.as(MARC)('GET', `conversations/${d.id}`)).json.conversation.lastMessage, null);
    assert.equal((await c.as(MARC)('PUT', `messages/${m.id}/reaction`, { emoji: '👍' })).status, 404, 'a hidden message is gone for that person');
    assert.equal((await c.as(MARC)('DELETE', `messages/${m.id}`, null, { for: 'everyone' })).json.code, 'invalid');
  });
});

test('reactions: one per person (replaced), null removes, system messages take none', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC, LENA]);
    const m = await c.send(ANNA, g.id, { text: 'Pizza heute?' });
    const react = (u, emoji) => c.as(u)('PUT', `messages/${m.id}/reaction`, { emoji });
    await react(MARC, '👍');
    c.clock.add(SEC);
    await react(LENA, '👍');
    c.clock.add(SEC);
    let r = await react(MARC, '❤️');
    assert.deepEqual(r.json.reactions, [{ emoji: '👍', count: 1, userIds: [LENA.id] }, { emoji: '❤️', count: 1, userIds: [MARC.id] }]);
    c.resetEvents();
    r = await react(LENA, null);
    assert.deepEqual(r.json.reactions, [{ emoji: '❤️', count: 1, userIds: [MARC.id] }]);
    const ev = c.events('reaction')[0];
    assert.deepEqual([ev.users.sort(), ev.data.messageId, ev.data.userId, ev.data.emoji], [[ANNA.id, MARC.id, LENA.id], m.id, LENA.id, null]);
    const msg = (await c.as(ANNA)('GET', `conversations/${g.id}/messages`)).json.messages.find((x) => x.id === m.id);
    assert.deepEqual(msg.reactions, [{ emoji: '❤️', count: 1, userIds: [MARC.id] }]);
    for (const bad of ['', 'ab', 'x'.repeat(17), 'hi 👍', 42]) assert.equal((await react(MARC, bad)).json.code, 'invalid', String(bad));
    assert.equal((await react(MARC, '1️⃣')).status, 200, 'a keycap emoji');
    assert.equal((await react(MARC, '👨‍👩‍👧')).status, 200, 'a ZWJ sequence');
    assert.equal((await c.as(MARC)('PUT', `messages/${m.id}/reaction`, {})).json.code, 'invalid');
    const sys = (await c.as(ANNA)('GET', `conversations/${g.id}/messages`)).json.messages.find((x) => x.kind === 'system');
    assert.equal((await c.as(MARC)('PUT', `messages/${sys.id}/reaction`, { emoji: '👍' })).json.code, 'invalid');
  });
});

test('search: decrypted on the server, newest first, texts, file names and places; 2…100 characters', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC]);
    await c.send(ANNA, g.id, { text: 'Milch und Brot' });
    await c.send(MARC, g.id, { text: 'Brötchen?' });
    await c.send(MARC, g.id, { kind: 'file', mediaId: await c.upload(MARC, PDF, 'application/pdf'), meta: { fileName: 'Brotrezept.pdf' } });
    await c.send(ANNA, g.id, { kind: 'location', location: { lat: 1, lon: 2, label: 'Bäckerei Brot & Co' } });
    const r = (await c.as(ANNA)('GET', `conversations/${g.id}/search`, null, { q: 'BROT' })).json;
    assert.deepEqual(r.results.map((m) => m.kind), ['location', 'file', 'text']);
    assert.equal(r.scanned, 5);
    assert.equal(r.truncated, false);
    assert.equal((await c.as(ANNA)('GET', `conversations/${g.id}/search`, null, { q: 'x' })).json.code, 'invalid');
    assert.equal((await c.as(ANNA)('GET', `conversations/${g.id}/search`, null, {})).json.code, 'invalid');
  });
});

test('media list of a conversation: counts per kind, newest first, filter', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    await c.send(ANNA, d.id, { kind: 'image', mediaId: await c.upload(ANNA, PNG, 'image/png') });
    await c.send(MARC, d.id, { kind: 'image', mediaId: await c.upload(MARC, PNG, 'image/png') });
    await c.send(MARC, d.id, { kind: 'voice', mediaId: await c.upload(MARC, OGG, 'audio/ogg') });
    await c.send(ANNA, d.id, { text: 'kein Medium' });
    let r = (await c.as(ANNA)('GET', `conversations/${d.id}/media`)).json;
    assert.deepEqual(r.counts, { image: 2, voice: 1, file: 0 });
    assert.deepEqual(r.items.map((m) => m.kind), ['voice', 'image', 'image']);
    r = (await c.as(ANNA)('GET', `conversations/${d.id}/media`, null, { kind: 'image', limit: '1' })).json;
    assert.deepEqual([r.items.length, r.hasMore, r.items[0].senderId], [1, true, MARC.id]);
    assert.equal((await c.as(ANNA)('GET', `conversations/${d.id}/media`, null, { kind: 'video' })).json.code, 'invalid');
  });
});

test('at rest: message texts, locations, file names and group titles are encrypted in the database', async () => {
  await withHost({}, async (host, c) => {
    const g = await c.group(ANNA, [MARC], 'Geheimgruppe');
    await c.send(ANNA, g.id, { text: 'Streng geheimer Text' });
    await c.send(ANNA, g.id, { kind: 'location', location: { lat: 50.123456, lon: 6.654321, label: 'Versteck' } });
    await c.send(ANNA, g.id, { kind: 'file', mediaId: await c.upload(ANNA, PDF, 'application/pdf'), meta: { fileName: 'Tagebuch.pdf' } });
    const dump = JSON.stringify([
      (await host.gc.db.query('SELECT * FROM messages')).rows,
      (await host.gc.db.query('SELECT * FROM conversations')).rows,
      (await host.gc.db.query('SELECT * FROM media')).rows,
    ]);
    for (const secret of ['Streng geheimer Text', 'Versteck', '50.123456', 'Tagebuch', 'Geheimgruppe']) assert.ok(!dump.includes(secret), secret);
    assert.match(dump, /"body_enc":"v1\./);
    assert.ok(host.secrets.has('enc_key'), 'the key is a secret setting (gc.settings.setSecret)');
    assert.equal(Buffer.from(host.settings.enc_key, 'base64').length, 32);
    // a restart keeps the key and reads the texts again
    await host.start();
    const msgs = (await c.as(MARC)('GET', `conversations/${g.id}/messages`)).json.messages;
    assert.equal(msgs.find((m) => m.kind === 'text').text, 'Streng geheimer Text');
    assert.equal((await c.as(MARC)('GET', `conversations/${g.id}`)).json.conversation.title, 'Geheimgruppe');
  });
});

test('a text that cannot be decrypted (key changed) shows as undecryptable and is logged without content', async () => {
  await withHost({}, async (host, c) => {
    const d = await c.direct(ANNA, MARC);
    await c.send(ANNA, d.id, { text: 'alt' });
    await host.gc.settings.setSecret('enc_key', Buffer.alloc(32, 7).toString('base64'));
    await host.start();
    const m = (await c.as(MARC)('GET', `conversations/${d.id}/messages`)).json.messages[0];
    assert.deepEqual([m.undecryptable, m.text], [true, null]);
    const log = (await c.admin('GET', 'log')).json.entries;
    assert.deepEqual(log.map((e) => [e.code, e.detail]), [['decrypt_failed', null]]);
  });
});
