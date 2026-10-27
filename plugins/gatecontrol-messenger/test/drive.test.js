'use strict';

// 1.10.0: "In Drive speichern" — POST messages/:id/to-drive hands the message's file over to the Drive plugin
// (gc.media.handOver) and saves it with Drive's service save_file for the caller; GET me integrations.drive.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, ANNA, MARC, LENA, PNG, OGG, PDF } = require('./helpers');

const DRIVE = 'gatecontrol-drive';
const GC = '1.193.0';

/** A fake Drive: save_file answers like Drive 1.4.0 (or `answer`), the calls in `calls`, the files in `received`. */
function drive(opts = {}) {
  const d = {
    plugin: DRIVE, provides: ['list_areas', 'save_file'], calls: [],
    media: { maxBytes: 26214400, types: ['image/*', 'audio/*', 'video/*', 'application/*'], quotaDefault: '1GB' },
    async service({ name, user, payload }) {
      d.calls.push({ name, user, payload });
      if (opts.answer) return opts.answer;
      const file = payload.folderId ? payload.name : payload.path.split('/').pop();
      const where = payload.folderId ? `Familie › Schule › ${file}` : `Meine Dateien › ${payload.path.split('/').join(' › ')}`;
      return { ok: true, nodeId: 77, areaId: payload.folderId ? 'family' : 'user:' + user.id, path: payload.folderId ? `Schule/${file}` : payload.path, name: file, created: true, where };
    },
  };
  return d;
}

/** Anna sends Marc a PDF in a direct chat → { conv, msg }. */
async function pdfFromAnna(c) {
  const conv = await c.direct(ANNA, MARC);
  const id = await c.upload(ANNA, PDF, 'application/pdf');
  const msg = await c.send(ANNA, conv.id, { kind: 'file', mediaId: id, meta: { fileName: 'Elternbrief: Herbst.pdf' } });
  return { conv, msg };
}

test('to-drive: default place Meine Dateien › Messenger › <file name>, a copy for Drive, for the caller', async () => {
  const d = drive();
  await withHost({ gatecontrol: GC, services: [d] }, async (host, c) => {
    assert.equal((await c.as(MARC)('GET', 'me')).json.integrations.drive, true);
    const { msg } = await pdfFromAnna(c);
    const r = await c.as(MARC)('POST', `messages/${msg.id}/to-drive`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.saved, { nodeId: 77, name: 'Elternbrief_ Herbst.pdf', where: 'Meine Dateien › Messenger › Elternbrief_ Herbst.pdf' });
    assert.equal(d.calls.length, 1);
    const call = d.calls[0];
    assert.equal(call.name, 'save_file');
    assert.equal(call.user.id, MARC.id, 'saved for the person who asked, not the sender');
    assert.deepEqual({ ...call.payload, mediaId: null }, { mediaId: null, area: 'mine', path: 'Messenger/Elternbrief_ Herbst.pdf', onConflict: 'rename', lang: 'de' });
    // Drive got its own copy (owner Marc), the chat keeps its file
    assert.equal(d.received.length, 1);
    assert.equal(d.received[0].mediaId, call.payload.mediaId);
    assert.equal(d.received[0].owner, MARC.id);
    assert.notEqual(call.payload.mediaId, msg.media.id);
    assert.equal((await host.mediaGet(MARC, msg.media.id)).status, 200);
    // the sender may save it too
    assert.equal((await c.as(ANNA, (u) => ({ ...u, portal: true, loggedIn: true }))('POST', `messages/${msg.id}/to-drive`, {})).status, 200);
  });
});

test('to-drive: into a folder the person picked (folderId); pictures and voice messages without a name get one', async () => {
  const d = drive();
  await withHost({ gatecontrol: GC, services: [d] }, async (host, c) => {
    const { msg } = await pdfFromAnna(c);
    const r = await c.as(MARC)('POST', `messages/${msg.id}/to-drive`, { folderId: 12 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.saved, { nodeId: 77, name: 'Elternbrief_ Herbst.pdf', where: 'Familie › Schule › Elternbrief_ Herbst.pdf' });
    assert.deepEqual({ ...d.calls[0].payload, mediaId: null }, { mediaId: null, folderId: 12, name: 'Elternbrief_ Herbst.pdf', onConflict: 'rename', lang: 'de' });
    // a picture and a voice message: "Foto <date time>.png", "Sprachnachricht <date time>.ogg" (server time zone)
    const conv = (await c.direct(ANNA, MARC));
    const img = await c.send(ANNA, conv.id, { kind: 'image', mediaId: await c.upload(ANNA, PNG, 'image/png') });
    const voice = await c.send(ANNA, conv.id, { kind: 'voice', mediaId: await c.upload(ANNA, OGG, 'audio/ogg'), meta: { durationMs: 2000 } });
    const at = new Date(Date.parse(img.createdAt));
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}-${p(at.getMinutes())}`;
    assert.equal((await c.as(MARC)('POST', `messages/${img.id}/to-drive`, {})).json.saved.name, `Foto ${stamp}.png`);
    assert.equal((await c.as(MARC)('POST', `messages/${voice.id}/to-drive`, {})).json.saved.name, `Sprachnachricht ${stamp}.ogg`);
    // in English for an English caller
    const en = await host.request({ method: 'POST', path: `messages/${img.id}/to-drive`, body: {}, query: {}, user: { ...MARC, portal: true, loggedIn: true, app: true }, lang: 'en' });
    assert.equal(en.json.saved.name, `Photo ${stamp}.png`);
    assert.equal(d.calls.at(-1).payload.lang, 'en');
    // a bad folderId, a message without a file
    assert.equal((await c.as(MARC)('POST', `messages/${msg.id}/to-drive`, { folderId: 'x' })).json.code, 'invalid');
    assert.equal((await c.as(MARC)('POST', `messages/${msg.id}/to-drive`, { folderId: -1 })).json.code, 'invalid');
    const txt = await c.send(ANNA, conv.id, { text: 'Hallo' });
    const none = await c.as(MARC)('POST', `messages/${txt.id}/to-drive`, {});
    assert.deepEqual([none.status, none.json.code], [404, 'not_found']);
  });
});

test('to-drive: Drive\'s refusals are passed on (no_seat, not_licensed, forbidden, quota, not_found, invalid)', async () => {
  for (const code of ['no_seat', 'not_licensed', 'forbidden', 'quota', 'not_found', 'invalid', 'exists', 'upload_invalid']) {
    await withHost({ gatecontrol: GC, services: [drive({ answer: { ok: false, code } })] }, async (host, c) => {
      const { msg } = await pdfFromAnna(c);
      const r = await c.as(MARC)('POST', `messages/${msg.id}/to-drive`, {});
      assert.equal(r.json.ok, false);
      assert.equal(r.json.code, code);
      assert.equal(r.status, { no_seat: 403, not_licensed: 403, forbidden: 403, quota: 409, not_found: 404, invalid: 400, exists: 409, upload_invalid: 409 }[code], code);
      assert.ok(r.json.error && r.json.error !== 'error.' + code, 'a German text');
    });
  }
  // an answer Drive does not document → drive_unavailable (logged, no content)
  await withHost({ gatecontrol: GC, services: [drive({ answer: { ok: false, code: 'internal' } })] }, async (host, c) => {
    const { msg } = await pdfFromAnna(c);
    const r = await c.as(MARC)('POST', `messages/${msg.id}/to-drive`, {});
    assert.deepEqual([r.status, r.json.code], [409, 'drive_unavailable']);
    const log = (await c.admin('GET', 'log')).json;
    assert.ok(JSON.stringify(log).includes('service_refused'));
  });
});

test('to-drive: drive_unavailable without Drive (not installed, older host); integrations.drive false', async () => {
  await withHost({ gatecontrol: GC }, async (host, c) => {
    assert.equal((await c.as(MARC)('GET', 'me')).json.integrations.drive, false);
    const { msg } = await pdfFromAnna(c);
    const r = await c.as(MARC)('POST', `messages/${msg.id}/to-drive`, {});
    assert.deepEqual([r.status, r.json.code], [409, 'drive_unavailable']);
    assert.equal(r.json.error, 'Drive ist gerade nicht verfügbar.');
  });
  // GateControl before the hand-over (1.193.0): no gc.media.handOver
  await withHost({ gatecontrol: '1.180.0', services: [drive()] }, async (host, c) => {
    assert.equal((await c.as(MARC)('GET', 'me')).json.integrations.drive, false);
    const { msg } = await pdfFromAnna(c);
    assert.equal((await c.as(MARC)('POST', `messages/${msg.id}/to-drive`, {})).json.code, 'drive_unavailable');
  });
});

test('to-drive: only who may download the file — others get not_found, nothing is handed over', async () => {
  const d = drive();
  await withHost({ gatecontrol: GC, services: [d] }, async (host, c) => {
    const { msg } = await pdfFromAnna(c);
    // not a member
    const lena = await c.as(LENA)('POST', `messages/${msg.id}/to-drive`, {});
    assert.deepEqual([lena.status, lena.json.code], [404, 'not_found']);
    // a portal viewer with device trust only, a kiosk device
    assert.equal((await c.call({ ...MARC, portal: true, loggedIn: false }, 'POST', `messages/${msg.id}/to-drive`, {})).json.code, 'login_required');
    assert.equal((await c.call({ ...MARC, portal: true, loggedIn: true, kiosk: true }, 'POST', `messages/${msg.id}/to-drive`, {})).json.code, 'forbidden');
    // hidden for Marc ("delete for me"), then deleted for everyone
    await c.as(MARC)('DELETE', `messages/${msg.id}`, null, { for: 'me' });
    assert.equal((await c.as(MARC)('POST', `messages/${msg.id}/to-drive`, {})).json.code, 'not_found');
    await c.as(ANNA)('DELETE', `messages/${msg.id}`, null, { for: 'all' });
    assert.equal((await c.as(ANNA)('POST', `messages/${msg.id}/to-drive`, {})).json.code, 'not_found');
    // unknown message
    assert.equal((await c.as(MARC)('POST', 'messages/999999/to-drive', {})).json.code, 'not_found');
    assert.equal(d.calls.length, 0);
    assert.equal((d.received || []).length, 0);
  });
});

test('to-drive: 20 saves per hour and person', async () => {
  const d = drive();
  await withHost({ gatecontrol: GC, services: [d] }, async (host, c) => {
    const { msg } = await pdfFromAnna(c);
    for (let i = 0; i < 20; i++) assert.equal((await c.as(MARC)('POST', `messages/${msg.id}/to-drive`, {})).status, 200);
    const r = await c.as(MARC)('POST', `messages/${msg.id}/to-drive`, {});
    assert.deepEqual([r.status, r.json.code], [429, 'rate_limited']);
    assert.equal((await c.as(ANNA)('POST', `messages/${msg.id}/to-drive`, {})).status, 200, 'another person has their own');
    c.clock.add(3600001);
    assert.equal((await c.as(MARC)('POST', `messages/${msg.id}/to-drive`, {})).status, 200);
  });
});
