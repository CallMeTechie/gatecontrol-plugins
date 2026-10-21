'use strict';

// 1.8.0: the service send_file (GateDrop) — files handed over with gc.media.handOver (GateControl ≥ 1.193.0)
// become messages of the sending person in a direct chat, the family group or a group.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withHost, ANNA, MARC, LENA, OMA, PNG, PDF } = require('./helpers');

const GD = 'gatecontrol-gatedrop';
const FAM = 'gatecontrol-familie';
const as = (u) => ({ id: u.id, name: u.name, role: u.role });

/** A file handed over to the messenger for `user` (what gc.media.handOver of GateDrop leaves in its store). */
function handed(host, user, data, mime, bytes) {
  return host._receiveHandOver({ mime, bytes: bytes || data.length, data, owner: user.id }).mediaId;
}

const call = (host, user, payload) => host.callService('send_file', { caller: GD, user: user ? as(user) : null, payload });

test('send_file direct: messages of the sender (not GateControl), one per file, caption on the first, pushed like a message', async () => {
  await withHost({ gatecontrol: '1.193.0' }, async (host, c) => {
    const img = handed(host, ANNA, PNG, 'image/png');
    const pdf = handed(host, ANNA, PDF, 'application/pdf');
    c.resetEvents();
    const r = await call(host, ANNA, { conversation: `direct:${MARC.id}`, user: ANNA.id, mediaIds: [img, pdf], names: ['Foto.png', 'angebot-kueche.pdf'], text: 'Hier die Unterlagen' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.messageIds.length, 2);
    const msgs = (await c.as(MARC)('GET', `conversations/${r.conversationId}/messages`)).json.messages;
    assert.deepEqual(msgs.map((m) => [m.kind, m.senderId, m.via, m.text, m.meta && m.meta.fileName]), [
      ['image', ANNA.id, null, 'Hier die Unterlagen', 'Foto.png'],
      ['file', ANNA.id, null, null, 'angebot-kueche.pdf'],
    ]);
    assert.deepEqual(msgs.map((m) => m.media.id), [img, pdf]);
    assert.equal((await c.as(MARC)('GET', `conversations/${r.conversationId}`)).json.conversation.kind, 'direct');
    const pushes = c.pushes();
    assert.equal(pushes.length, 2);
    assert.deepEqual(pushes.map((p) => p.users), [[MARC.id], [MARC.id]], 'only the other member, never the sender');
    assert.equal(pushes[0].data.sender.name, 'Anna');
    assert.ok(c.events('message.new').length >= 2);
    // the files belong to the messages now: Marc may read them, Lena may not
    assert.equal((await host.mediaGet({ ...MARC, app: true }, pdf)).status, 200);
    assert.equal((await host.mediaGet({ ...LENA, app: true }, pdf)).status, 404);
    // the same file again → media_in_use
    assert.deepEqual(await call(host, ANNA, { conversation: `direct:${MARC.id}`, user: ANNA.id, mediaIds: [pdf] }), { ok: false, code: 'media_in_use' });
  });
});

test('send_file: text only (split at 4000), voice by type, kinds and the family group', async () => {
  await withHost({ gatecontrol: '1.193.0' }, async (host, c) => {
    const long = 'x'.repeat(9000);
    const r = await call(host, ANNA, { conversation: `direct:${MARC.id}`, user: ANNA.id, text: long });
    assert.equal(r.ok, true);
    const msgs = (await c.as(MARC)('GET', `conversations/${r.conversationId}/messages`)).json.messages;
    assert.deepEqual(msgs.map((m) => [m.kind, m.text.length]), [['text', 4000], ['text', 4000], ['text', 1000]]);
    // a long text with a file: the text first, then the file without caption
    const ogg = handed(host, ANNA, Buffer.from('OggS fake'), 'audio/ogg');
    const r2 = await call(host, ANNA, { conversation: `direct:${MARC.id}`, user: ANNA.id, mediaIds: [ogg], text: 'y'.repeat(4500) });
    const m2 = (await c.as(MARC)('GET', `conversations/${r2.conversationId}/messages`)).json.messages.slice(-3);
    assert.deepEqual(m2.map((m) => m.kind), ['text', 'text', 'voice']);
    // family: Familie's group, the sender a member
    const g = await host.callService('sync_group', { caller: FAM, payload: { key: 'family', title: 'Familie', userIds: [ANNA.id, MARC.id, LENA.id] } });
    const img = handed(host, ANNA, PNG, 'image/png');
    const r3 = await call(host, ANNA, { conversation: 'family', user: ANNA.id, mediaIds: [img] });
    assert.deepEqual([r3.ok, r3.conversationId], [true, g.conversationId]);
    const img2 = handed(host, OMA, PNG, 'image/png');
    assert.deepEqual(await call(host, OMA, { conversation: 'family', user: OMA.id, mediaIds: [img2] }), { ok: false, code: 'forbidden' }, 'not a member');
    assert.deepEqual(await call(host, OMA, { conversation: `group:${g.conversationId}`, user: OMA.id, mediaIds: [img2] }), { ok: false, code: 'forbidden' });
  });
});

test('send_file refusals: user, files, size, blocks, read-only', async () => {
  await withHost({ gatecontrol: '1.193.0' }, async (host, c) => {
    const pdf = handed(host, ANNA, PDF, 'application/pdf');
    for (const [p, user, code] of [
      [{ conversation: `direct:${MARC.id}`, mediaIds: [pdf] }, ANNA, 'invalid'],                       // no user
      [{ conversation: `direct:${MARC.id}`, user: MARC.id, mediaIds: [pdf] }, ANNA, 'invalid'],        // not the calling person
      [{ conversation: `direct:${MARC.id}`, user: ANNA.id }, ANNA, 'invalid'],                         // nothing to send
      [{ conversation: `direct:${MARC.id}`, user: ANNA.id, mediaIds: new Array(21).fill(pdf) }, ANNA, 'invalid'],
      [{ conversation: 'nowhere', user: ANNA.id, mediaIds: [pdf] }, ANNA, 'invalid'],
      [{ conversation: `direct:${ANNA.id}`, user: ANNA.id, mediaIds: [pdf] }, ANNA, 'invalid'],        // oneself
      [{ conversation: `direct:${LENA.id}`, user: MARC.id, mediaIds: [pdf] }, MARC, 'media_invalid'],  // handed over for Anna
      [{ conversation: 'family', user: ANNA.id, mediaIds: [pdf] }, ANNA, 'not_found'],                 // no family group
    ]) assert.deepEqual(await call(host, user, p), { ok: false, code }, JSON.stringify(p));
    // larger than 2 GB (the hand-over of the core would refuse it before; checked here as well)
    const big = crypto.randomBytes(16).toString('hex');
    host.media.set(big, { mime: 'video/mp4', bytes: 2 * 1024 ** 3 + 1, owner: ANNA.id, data: Buffer.from('x'), claimed: false, createdAt: Date.now() });
    assert.deepEqual(await call(host, ANNA, { conversation: `direct:${MARC.id}`, user: ANNA.id, mediaIds: [big] }), { ok: false, code: 'file_too_large' });
    // a block either way
    const d = await c.direct(ANNA, LENA);
    assert.equal((await c.as(LENA)('POST', 'blocks', { userId: ANNA.id })).status, 200);
    assert.deepEqual(await call(host, ANNA, { conversation: `direct:${LENA.id}`, user: ANNA.id, mediaIds: [pdf] }), { ok: false, code: 'forbidden' });
    assert.ok(d.id);
    // a read-only notice channel
    const ch = await host.callService('send_message', { caller: GD, payload: { conversation: `user:${MARC.id}`, text: 'x' } });
    const pdf2 = handed(host, MARC, PDF, 'application/pdf');
    assert.deepEqual(await call(host, MARC, { conversation: `group:${ch.conversationId}`, user: MARC.id, mediaIds: [pdf2] }), { ok: false, code: 'readonly' });
    // nothing of a refused call stays: the file can still be sent
    const ok = await call(host, ANNA, { conversation: `direct:${MARC.id}`, user: ANNA.id, mediaIds: [pdf] });
    assert.equal(ok.ok, true);
  });
});
