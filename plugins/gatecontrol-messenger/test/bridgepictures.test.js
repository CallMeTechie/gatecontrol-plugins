'use strict';

// 1.19.1 — profile pictures over a bridge that did not come in the first real test (a WhatsApp chat with initials only):
//
//   for now   a picture the host refuses for now (an answer it does not take — as GateControl before 1.278.1 with a
//             homeserver answering chunked —, the bridge away) is asked for again later, the wait doubling; until
//             1.19.0 it was given up for good after a few runs and never asked for again
//   repair    pictures noted as done without a file (by 1.19.0, or by a final answer) are asked for once more per start
//   final     a final answer (gone, a type that is no picture) ends it: initials, no endless asking

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, ANNA, HOUR, MIN } = require('./helpers');

const V6 = { enabled: true, networks: { whatsapp: true }, running: true, version: 6 };
const GC = '1.219.0';
const B = { bridged: '1' };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 9)]);
const KIM = { id: 'c' + 'k'.repeat(21), name: 'Kim' };
let n = 0;

async function link(c, host) {
  const me = c.as(ANNA);
  assert.equal((await me('POST', 'bridges/whatsapp/consent', { accept: true })).status, 200);
  let r = await me('POST', 'bridges/whatsapp/login', { flow: 'qr' });
  host.bridges.confirm(r.json.login.processId);
  r = await me('POST', `bridges/whatsapp/login/${r.json.login.processId}/${r.json.login.step.id}`, {});
  assert.equal(r.json.login.step.type, 'complete');
}
/** A direct chat with its picture (the contact's, as mautrix sets it with private_chat_portal_meta) and a message. */
async function chatWithPicture(c, host, pic) {
  await link(c, host);
  const ref = host.bridges.chat(ANNA.id, { kind: 'direct', name: 'Schatzimausi 💕' });
  const chat = { id: ref, kind: 'direct', name: 'Schatzimausi 💕', avatar: pic };
  await host.bridges.deliver([{ userId: ANNA.id, type: 'message', chat, id: `$bp${++n}`, sender: KIM, kind: 'text', text: 'Hallo', replyTo: null }]);
  return chat;
}
const list = async (c) => (await c.call(app(ANNA), 'GET', 'conversations', null, B)).json.conversations;
const fetchesOf = (host, ref) => host.bridges.fetches.filter((f) => f.ref === ref).length;

test('a chat’s picture refused for now: asked for again later — not given up after a few runs', async () => {
  await withHost({ bridges: V6, gatecontrol: GC, scan: true }, async (host, c) => {
    const clock = c.clock;
    {
      const pic = host.bridges.file(ANNA.id, { data: JPEG, mime: 'image/jpeg' });
      // the homeserver's answer the host did not take (GateControl 1.278.0: no Content-Length)
      host.bridges.failFetch = { code: 'ERR_BRIDGE', reason: 'bad_answer' };
      await chatWithPicture(c, host, pic);
      for (let i = 0; i < 10; i++) { await host.tick(); clock.add(HOUR); }
      let [conv] = await list(c);
      assert.equal(conv.avatarMediaId, null, 'not there yet: initials');
      const tried = fetchesOf(host, pic);
      assert.ok(tried >= 6, `asked for on several runs (${tried})`);
      // not on every run: the wait grows (at most every PICTURE_WAIT_MAX_MS)
      for (let i = 0; i < 5; i++) { await host.tick(); clock.add(MIN); }
      assert.equal(fetchesOf(host, pic), tried, 'not asked for on every run meanwhile');
      // the host takes the answer now (GateControl 1.278.1): the picture comes on its own
      host.bridges.failFetch = null;
      clock.add(7 * HOUR);
      await host.tick();
      [conv] = await list(c);
      assert.match(String(conv.avatarMediaId), /^[0-9a-f]{32}$/, 'the contact’s picture in the chat list');
      assert.equal((await host.mediaGet(ANNA, conv.avatarMediaId)).status, 200);
    }
  });
});

test('a picture noted as done without a file (by 1.19.0): asked for once more after a start', async () => {
  await withHost({ bridges: V6, gatecontrol: GC, scan: true }, async (host, c) => {
    const pic = host.bridges.file(ANNA.id, { data: JPEG, mime: 'image/jpeg' });
    // a final answer: noted as done, initials
    host.bridges.failFetch = { code: 'ERR_INVALID', reason: 'gone' };
    await chatWithPicture(c, host, pic);
    await host.tick();
    let [conv] = await list(c);
    assert.equal(conv.avatarMediaId, null);
    const once = fetchesOf(host, pic);
    assert.equal(once, 1);
    host.bridges.failFetch = null;
    for (let i = 0; i < 3; i++) await host.tick();
    assert.equal(fetchesOf(host, pic), once, 'final: not asked for on every run');
    // as 1.19.0 left it after a few failed runs
    const row = (await host.gc.db.query('SELECT bridge_avatar, bridge_avatar_got, avatar_media_id FROM conversations WHERE bridge_net IS NOT NULL')).rows[0];
    assert.equal(row.bridge_avatar_got, row.bridge_avatar);
    assert.equal(row.avatar_media_id, null);
    // a start (an update of the plugin or of GateControl): once more
    require('../server/bridgemedia')._reset();
    await host.tick();
    [conv] = await list(c);
    assert.equal(fetchesOf(host, pic), once + 1);
    assert.match(String(conv.avatarMediaId), /^[0-9a-f]{32}$/);
  });
});

test('a picture that is no picture: initials, not asked for again and again', async () => {
  await withHost({ bridges: V6, gatecontrol: GC, scan: true }, async (host, c) => {
    const pic = host.bridges.file(ANNA.id, { data: Buffer.from('%PDF-1.4\n%x\n'), mime: 'application/pdf' });
    await chatWithPicture(c, host, pic);
    for (let i = 0; i < 4; i++) await host.tick();
    const [conv] = await list(c);
    assert.equal(conv.avatarMediaId, null);
    assert.equal(fetchesOf(host, pic), 1);
  });
});
