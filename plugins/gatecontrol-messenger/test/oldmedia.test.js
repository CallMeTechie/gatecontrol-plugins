'use strict';

// 1.26.0 — old media from the phone (GateControl with gc.bridges version 13; the mock host's stand-in,
// tools/testing/mock-bridges.js). A WhatsApp file of the history whose copy at WhatsApp ran out arrives as
// message.oldMedia instead of the bridge's English notice: a placeholder of its kind that says whether the phone is
// asked for it; the file the phone sent later (an edit with `media`) replaces it, a phone that could not marks it
// failed. The administrator's switch „Alte Medien vom Handy nachladen“ on the card „Brücken“. Names are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, app, portal, ANNA, OGG } = require('./helpers');
const texts = require('../server/texts.json');

const V13 = { enabled: true, networks: { whatsapp: true }, running: true, version: 13 };
const B = { bridged: '1' };
const KIM = { id: 'c' + 'k'.repeat(21), name: 'Kim Muster' };
let n = 0;
const eid = () => `$om${++n}`;

async function annaAndKim(c, host) {
  const me = c.as(ANNA);
  assert.equal((await me('POST', 'bridges/whatsapp/consent', { accept: true })).status, 200);
  let r = await me('POST', 'bridges/whatsapp/login', { flow: 'qr' });
  host.bridges.confirm(r.json.login.processId);
  r = await me('POST', `bridges/whatsapp/login/${r.json.login.processId}/${r.json.login.step.id}`, {});
  assert.equal(r.json.login.step.type, 'complete');
  const ref = host.bridges.chat(ANNA.id, { kind: 'direct', name: 'Kim Muster' });
  const chat = { id: ref, kind: 'direct', name: 'Kim Muster' };
  await host.bridges.deliver([{ userId: ANNA.id, type: 'chat', chat }]);
  return chat;
}
const old = (chat, oldMedia, extra = {}) => ({ userId: ANNA.id, type: 'message', chat, id: eid(), sender: KIM, kind: 'unsupported', oldMedia, text: null, replyTo: null, ...extra });
const msgs = async (c, convId, viewer = app) => (await c.call(viewer(ANNA), 'GET', `conversations/${convId}/messages`, null, B)).json.messages;
const conv = async (c) => (await c.call(app(ANNA), 'GET', 'conversations', null, B)).json.conversations[0];

test('an old file: a placeholder of its kind with what became of the request to the phone — never the English line', async () => {
  await withHost({ bridges: V13 }, async (host, c) => {
    const chat = await annaAndKim(c, host);
    await host.bridges.deliver([
      old(chat, { kind: 'voice', name: null, request: 'off' }),
      old(chat, { kind: 'image', name: null, request: 'daily' }, { text: 'Am See' }),
      old(chat, { kind: 'file', name: 'Rechnung.pdf', request: 'now' }),
      old(chat, { kind: 'sticker', name: null, request: 'failed' }),
      old(chat, { kind: 'nonsense', name: null, request: 'whatever' }),
    ]);
    await host.tick();
    const ms = await msgs(c, (await conv(c)).id);
    assert.deepEqual(ms.map((m) => [m.kind, m.text, m.bridge.placeholder]), [
      ['text', null, { kind: 'voice', name: null, state: 'failed', reason: 'gone', old: 'off', retry: false }],
      ['text', 'Am See', { kind: 'image', name: null, state: 'loading', reason: null, old: 'daily' }],
      ['text', null, { kind: 'file', name: 'Rechnung.pdf', state: 'loading', reason: null, old: 'now' }],
      ['text', null, { kind: 'sticker', name: null, state: 'failed', reason: 'unavailable', old: 'failed', retry: false }],
      ['text', null, { kind: 'file', name: null, state: 'failed', reason: 'gone', old: 'off', retry: false }],
    ]);
    assert.equal(host.bridges.fetches.length, 0, 'nothing to fetch yet');
  });
});

test('the file the phone sent later replaces the placeholder; a phone that could not marks it failed', async () => {
  await withHost({ bridges: V13, scan: true }, async (host, c) => {
    const chat = await annaAndKim(c, host);
    const voice = old(chat, { kind: 'voice', name: null, request: 'daily' }, { history: true, at: Date.now() - 40 * 86400000 });
    const photo = old(chat, { kind: 'image', name: null, request: 'daily' }, { history: true, at: Date.now() - 39 * 86400000 });
    await host.bridges.deliver([voice, photo]);
    await host.tick();
    const id = (await conv(c)).id;
    const ref = host.bridges.file(ANNA.id, { data: OGG, mime: 'audio/ogg' });
    c.resetEvents();
    await host.bridges.deliver([
      // an edit of a stranger changes nothing
      { userId: ANNA.id, type: 'edit', chat, id: eid(), sender: { id: 'c' + 'z'.repeat(21), name: 'Jo' }, target: voice.id, text: 'Voice message.ogg', media: { kind: 'voice', name: 'Voice message.ogg', ref, mime: 'audio/ogg', durationMs: 3000, waveform: [0, 512, 1024] } },
      { userId: ANNA.id, type: 'edit', chat, id: eid(), sender: KIM, target: voice.id, text: 'Voice message.ogg', media: { kind: 'voice', name: 'Voice message.ogg', ref, mime: 'audio/ogg', durationMs: 3000, waveform: [0, 512, 1024] } },
      { userId: ANNA.id, type: 'edit', chat, id: eid(), sender: KIM, target: photo.id, text: null, oldMedia: { request: 'failed' } },
    ]);
    await host.tick();
    const ms = await msgs(c, id);
    assert.deepEqual([ms[0].kind, ms[0].text, ms[0].media.mime, ms[0].meta.durationMs], ['voice', null, 'audio/ogg', 3000]);
    assert.deepEqual(ms[0].media.scan, { state: 'clean', blocked: false, finding: null });
    assert.equal(ms[0].bridge.placeholder, null);
    assert.deepEqual([ms[1].kind, ms[1].bridge.placeholder.old, ms[1].bridge.placeholder.state], ['text', 'failed', 'failed']);
    assert.equal(host.bridges.fetches.length, 1, 'fetched once, right away (not only when asked like other history)');
    assert.ok(c.events('message.update').some((e) => e.data.messageId === ms[1].id && e.data.media === true));
    // a later edit with text never puts the bridge's words on a placeholder
    await host.bridges.deliver([{ userId: ANNA.id, type: 'edit', chat, id: eid(), sender: KIM, target: photo.id, text: 'Failed to bridge media' }]);
    await host.tick();
    assert.equal((await msgs(c, id))[1].text, null);
  });
});

test('admin: „Alte Medien vom Handy nachladen“ — off, once a day or right away; only with GateControl version 13', async () => {
  await withHost({ bridges: V13 }, async (host, c) => {
    let a = (await c.admin('GET', 'bridges')).json.bridges;
    assert.deepEqual(a.mediaRequests, { mode: 'off', options: ['off', 'daily', 'now'], dailyAt: '11:10', timeZone: 'Europe/Berlin' });
    a = (await c.admin('PUT', 'bridges', { mediaRequests: 'daily' })).json.bridges;
    assert.equal(a.mediaRequests.mode, 'daily');
    assert.equal(host.bridges.mediaRequests, 'daily');
    a = (await c.admin('PUT', 'bridges', { mediaRequests: 'now' })).json.bridges;
    assert.equal(a.mediaRequests.mode, 'now');
    for (const bad of ['night', true, null, 'NOW']) assert.equal((await c.admin('PUT', 'bridges', { mediaRequests: bad })).json.code, 'invalid', String(bad));
    assert.equal((await c.as(ANNA)('PUT', 'admin/bridges', { mediaRequests: 'off' })).status, 403);
    assert.equal(host.bridges.mediaRequests, 'now');
  });
  await withHost({ bridges: { ...V13, version: 12 } }, async (host, c) => {
    const a = (await c.admin('GET', 'bridges')).json.bridges;
    assert.equal(a.mediaRequests, undefined, 'no switch without GateControl version 13');
    assert.equal((await c.admin('PUT', 'bridges', { mediaRequests: 'daily' })).json.code, 'feature_off');
  });
});

test('the portal gets the same placeholder (its texts build the line)', async () => {
  await withHost({ bridges: V13 }, async (host, c) => {
    const chat = await annaAndKim(c, host);
    await host.bridges.deliver([old(chat, { kind: 'voice', name: null, request: 'off' })]);
    await host.tick();
    const [m] = await msgs(c, (await conv(c)).id, portal);
    assert.equal(m.bridge.placeholder.old, 'off');
  });
});

test('texts: the switch and every placeholder in German and English', () => {
  for (const lang of ['de', 'en']) {
    for (const k of ['admin.br_media', 'admin.br_media_when', 'admin.br_media_daily', 'admin.br_media_now', 'admin.br_media_off', 'admin.br_media_daily_at', 'admin.br_media_daily_sub', 'admin.br_media_now_sub', 'admin.br_media_cost', 'bc.old_off', 'bc.old_daily', 'bc.old_now', 'bc.old_failed']) {
      assert.ok(typeof texts[lang][k] === 'string' && texts[lang][k].length, `${lang}: ${k}`);
    }
    for (const kind of ['image', 'video', 'voice', 'audio', 'file', 'sticker']) {
      assert.ok(texts[lang]['bc.old.' + kind], `${lang}: bc.old.${kind}`);
      assert.ok(texts[lang]['bc.old_it.' + kind], `${lang}: bc.old_it.${kind}`);
    }
  }
  const line = (lang, kind, state) => `${texts[lang]['bc.old.' + kind]} – ${texts[lang]['bc.old_' + state].replace(/\{\{it\}\}/g, texts[lang]['bc.old_it.' + kind]).replace('{{network}}', 'WhatsApp')}`;
  assert.equal(line('de', 'voice', 'off'), 'Ältere Sprachnachricht – öffne sie in WhatsApp');
  assert.equal(line('de', 'voice', 'daily'), 'Ältere Sprachnachricht – wird später vom Handy geladen');
  assert.equal(line('de', 'voice', 'now'), 'Ältere Sprachnachricht – wird geladen');
  assert.equal(line('de', 'image', 'off'), 'Älteres Bild – öffne es in WhatsApp');
  assert.equal(line('en', 'voice', 'off'), 'Older voice message – open it in WhatsApp');
  assert.equal(texts.de['admin.br_media_daily'], 'Einmal am Tag (empfohlen)');
});
