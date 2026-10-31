'use strict';

// Speicherorte (1.5.0): copies of received attachments in GateControl's media area `attachments` (the administrator puts
// it on this server or a storage target — never Mail); inline pictures, account pictures and draft files stay on this
// server; the attachments of 1.4 move into the area once; no room for a new file at GateControl (503 storage_unavailable,
// 507 server_full) pauses the prefetch — the sync goes on — and answers 409 to a person; the outbox never sends twice.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, ANNA } = require('./helpers');
const storage = require('../server/storage');
const texts = require('../server/texts.json');

async function due(host) {
  await host.gc.db.run("UPDATE outbox SET send_at = 0 WHERE state = 'waiting'");
  await host.tick();
  await settle();
}

const PDF = { filename: 'Rechnung.pdf', contentType: 'application/pdf', data: '%PDF-rechnung' };
const LOGO = { filename: 'logo.png', contentType: 'image/png', data: 'PNG-logo', inline: true, contentId: '<logo@example.com>' };

/** Anna's mail with an attachment and an inline picture, synced → { s (summary), m (the message), acc } */
async function mailWithFiles(c, extra = {}) {
  c.mail.login('anna@gmx.de', 'geheim-123');
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { address: 'shop@example.com' }, subject: 'Beleg', html: '<p>anbei</p>', attachments: [PDF, LOGO], ...extra });
  const acc = await c.addGmx(ANNA);
  await c.tick();
  const [s] = (await c.list(ANNA, {})).items;
  const m = (await c.as(ANNA)('GET', `messages/${s.id}`)).json;
  return { s, m, acc };
}

const fileOf = (m, name) => m.attachments.find((t) => t.name === name);

test('manifest: media.areas — the install dialog shows „Speicherorte“; the limits stay', () => {
  const manifest = require('../plugin.json');
  assert.equal(manifest.version, '1.5.0');
  assert.equal(manifest.media.areas, true);
  assert.equal(manifest.media.maxBytes, 50 * 1024 * 1024, 'gc.mail loads at most 50 MB a mail');
  assert.equal(manifest.media.quotaDefault, '500GB');
  for (const lang of ['de', 'en']) {
    for (const k of ['error.storage_unavailable', 'error.server_full', 'error.quota_exceeded', 'a.place', 'a.place_d', 'a.place_server']) assert.ok(texts[lang][k], `${lang} ${k}`);
  }
});

test('an attachment goes into the area „attachments“; inline pictures and draft files stay on this server (account pictures: avatars.test.js)', () => withMail({}, async (host, c) => {
  const { s, m } = await mailWithFiles(c);
  const area = host.mediaAreas.get('attachments');
  assert.ok(area, 'created on the first use');
  assert.equal(area.label, 'Anhänge');
  const att = (await c.as(ANNA)('GET', `messages/${s.id}/attachments/${fileOf(m, 'Rechnung.pdf').id}`)).json;
  assert.equal(host.media.get(att.mediaId).area, 'attachments');
  assert.equal(host.media.get(att.mediaId).path, null, 'no path: on a NAS below .gcdrive, never scanned');
  assert.equal(host.media.get(att.mediaId).claimed, true);
  const logo = (await c.as(ANNA)('GET', `cid/${s.id}/${fileOf(m, 'logo.png').id}`)).json;
  assert.equal(host.media.get(logo.mediaId).area, undefined, 'an inline picture stays here');
  // a file from the device for a draft: GateControl's upload, kept by the draft — here
  const up = await host.upload({ id: ANNA.id }, Buffer.from('foto'), 'image/jpeg');
  const d = (await c.as(ANNA)('POST', 'drafts', { to: ['bo@web.de'], subject: 'Foto', attachments: [{ mediaId: up.body.mediaId }] })).json.draft;
  assert.equal(d.attachments.length, 1);
  assert.equal(host.media.get(up.body.mediaId).area, undefined);
  // what is used per person counts the attachments wherever they lie
  const me = (await c.as(ANNA)('GET', 'me')).json;
  assert.ok(me.limits.usedBytes >= Buffer.byteLength(PDF.data));
  // the admin page: where they lie (a note only — GateControl's „Speicherorte“ decides)
  let st = (await c.admin('GET', 'admin/settings')).json.storage;
  assert.deepEqual([st.area, st.target.kind, st.state, st.count], ['attachments', 'server', 'ok', 1]);
  area.target = { id: 3, kind: 'webdav', label: 'NAS Keller' };
  area.state = 'unreachable';
  st = (await c.admin('GET', 'admin/settings')).json.storage;
  assert.deepEqual([st.target.kind, st.target.label, st.state], ['webdav', 'NAS Keller', 'unreachable']);
}));

test('attachments of 1.4 (no area) move into the area once, a batch per run; inline pictures stay', () => withMail({}, async (host, c) => {
  const { s, m } = await mailWithFiles(c);
  const a1 = (await c.as(ANNA)('GET', `messages/${s.id}/attachments/${fileOf(m, 'Rechnung.pdf').id}`)).json;
  const l1 = (await c.as(ANNA)('GET', `cid/${s.id}/${fileOf(m, 'logo.png').id}`)).json;
  await c.tick();
  // as 1.4 left them: claimed without an area (GateControl gives such a file no area of its own), nothing moved yet
  delete host.media.get(a1.mediaId).area;
  delete host.media.get(a1.mediaId).path;
  host.kv.delete('area_attachments');
  // a file GateControl no longer knows is skipped
  await host.gc.db.run('INSERT INTO attachments (message_id, part_id, name, mime, size, inline, media_id, media_bytes) VALUES (?, ?, ?, ?, ?, 0, ?, 5)',
    [s.id, '9', 'Weg.pdf', 'application/pdf', 5, 'f'.repeat(32)]);
  await c.tick();
  assert.equal(host.media.get(a1.mediaId).area, 'attachments');
  assert.equal(host.media.get(a1.mediaId).claimed, true);
  assert.equal(host.media.get(l1.mediaId).area, undefined);
  assert.equal(host.kv.get('area_attachments').done, true);
  assert.ok(host.logs.some((l) => /attachments in their area/.test(l.message)));
  // once: a file without an area later (e.g. from a restore) is not looked for again
  delete host.media.get(a1.mediaId).area;
  await c.tick();
  assert.equal(host.media.get(a1.mediaId).area, undefined);
}));

test('no room at GateControl (503 storage_unavailable, 507 server_full): the sync goes on, the prefetch pauses, a person gets 409; later it works', () => withMail({ settings: { attachments: 'always' } }, async (host, c) => {
  host.mediaCapacity('storage_unavailable');
  const { s, m } = await mailWithFiles(c);
  // the mail is there (body and all), only the copy of the attachment is missing
  assert.equal(m.subject, 'Beleg');
  assert.match(m.html, /anbei/);
  const rows = await c.db('SELECT media_id FROM attachments WHERE name = ?', ['Rechnung.pdf']);
  assert.equal(rows[0].media_id, null);
  // more mail arrives meanwhile: synced, no new attempt to store files while paused
  c.mail.deliver('anna@gmx.de', { from: { address: 'shop@example.com' }, subject: 'Noch ein Beleg', text: 'x', attachments: [{ filename: 'Zwei.pdf', contentType: 'application/pdf', data: '%PDF-2' }] });
  await settle(400);
  await c.tick();
  assert.deepEqual((await c.list(ANNA, {})).items.map((x) => x.subject).sort(), ['Beleg', 'Noch ein Beleg']);
  assert.equal(host.media.size, 0);
  // a person asking: 409 with the code and when to ask again
  const pdf = fileOf(m, 'Rechnung.pdf');
  let r = await c.as(ANNA)('GET', `messages/${s.id}/attachments/${pdf.id}`);
  assert.deepEqual([r.status, r.json.error.code, r.json.error.retryAfter], [409, 'storage_unavailable', 300]);
  assert.match(r.json.error.message, /nicht erreichbar/);
  host.mediaCapacity('server_full');
  r = await c.as(ANNA)('GET', `messages/${s.id}/attachments/${pdf.id}`);
  assert.deepEqual([r.status, r.json.error.code], [409, 'server_full']);
  // the admin page says the prefetch pauses
  assert.equal((await c.admin('GET', 'admin/settings')).json.storage.paused, 'server_full');
  // an upload of a file for a draft gets GateControl's answer (the portal shows the text of its code)
  const up = await host.upload({ id: ANNA.id }, Buffer.from('foto'), 'image/jpeg');
  assert.deepEqual([up.status, up.body.code], [507, 'server_full']);
  // room again: the person gets the file, into the area
  host.mediaCapacity(null);
  r = await c.as(ANNA)('GET', `messages/${s.id}/attachments/${pdf.id}`);
  assert.equal(r.status, 200);
  assert.equal(host.media.get(r.json.mediaId).area, 'attachments');
  assert.equal(host.media.get(r.json.mediaId).data.toString(), PDF.data);
  // the prefetch still pauses (15 minutes after server_full); once over, the mails that waited get their attachments
  await c.tick();
  assert.equal((await c.db('SELECT media_id FROM attachments WHERE name = ?', ['Zwei.pdf']))[0].media_id, null);
  storage.reset(); // the pause is over
  await c.tick();
  const two = (await c.db('SELECT media_id FROM attachments WHERE name = ?', ['Zwei.pdf']))[0].media_id;
  assert.ok(two);
  assert.deepEqual([host.media.get(two).area, host.media.get(two).data.toString()], ['attachments', '%PDF-2']);
}));

// without Drive: its filing would load the attachment in the first run already
test('the area full (its quota): the copy goes again, 409 server_full; nothing is kept elsewhere', () => withMail({ drive: false }, async (host, c) => {
  const { s, m } = await mailWithFiles(c);
  host.mediaAreas.get('attachments').quota = 4;
  const r = await c.as(ANNA)('GET', `messages/${s.id}/attachments/${fileOf(m, 'Rechnung.pdf').id}`);
  assert.deepEqual([r.status, r.json.error.code, r.json.error.reason], [409, 'server_full', 'area_full']);
  assert.equal([...host.media.values()].filter((x) => x.mime === 'application/pdf').length, 0, 'the copy went again');
  const rows = await c.db('SELECT media_id FROM attachments WHERE name = ?', ['Rechnung.pdf']);
  assert.equal(rows[0].media_id, null);
}));

test('the outbox: no room for the copy into „Gesendet“ → sent once, never twice; a forwarded file on a target that fails waits', () => withMail({}, async (host, c) => {
  const { s, m } = await mailWithFiles(c);
  // the copy for „Gesendet“ is refused after the server took the mail
  host.mediaCapacity('server_full');
  const d = (await c.as(ANNA)('POST', 'drafts', { to: ['bo@web.de'], subject: 'Hallo', html: '<p>x</p>' })).json.draft;
  await c.as(ANNA)('POST', `drafts/${d.id}/send`, {});
  await due(host);
  await due(host);
  assert.equal(c.mail.sent.length, 1, 'sent once');
  assert.equal(c.mail.appended.length, 0, 'no copy');
  assert.deepEqual((await c.as(ANNA)('GET', 'outbox')).json.items, []);
  assert.ok(host.logs.some((l) => /copy to sent failed/.test(l.message) && /server_full/.test(l.message)));
  host.mediaCapacity(null);
  // forward the mail with its attachment while the area's target fails: waits (storage_unavailable), the account stays ok
  await c.as(ANNA)('GET', `messages/${s.id}/attachments/${fileOf(m, 'Rechnung.pdf').id}`);
  const area = host.mediaAreas.get('attachments');
  area.target = { id: 3, kind: 'webdav', label: 'NAS' };
  area.state = 'unreachable';
  const f = (await c.as(ANNA)('POST', 'drafts', { mode: 'forward', replyTo: s.id, to: ['bo@web.de'] })).json.draft;
  await c.as(ANNA)('POST', `drafts/${f.id}/send`, {});
  await due(host);
  assert.equal(c.mail.sent.length, 1, 'not sent while the file cannot be read');
  const [o] = (await c.as(ANNA)('GET', 'outbox')).json.items;
  assert.deepEqual([o.state, o.error], ['waiting', 'storage_unavailable']);
  assert.ok(o.sendAt > Date.now() + 4 * 60000, 'again in five minutes');
  assert.equal((await c.as(ANNA)('GET', 'me')).json.accounts[0].state, 'ok');
  // the target is back
  area.state = 'ok';
  await due(host);
  assert.equal(c.mail.sent.length, 2);
  assert.deepEqual(c.mail.sent[1].files.map((x) => [x.filename, x.data]), [['Rechnung.pdf', PDF.data]]);
}));

test('GateControl\'s refusals as the plugin sees them: gc.media.fetch the code, gc.mail ERR_INVALID with it, gc.media.copy ERR_BUSY / ERR_MEDIA_QUOTA', () => {
  const err = (code, message) => Object.assign(new Error(message), { code });
  assert.equal(storage.refusal(err('storage_unavailable', 'storage_unavailable')), 'storage_unavailable');
  assert.equal(storage.refusal(err('server_full', 'server_full')), 'server_full');
  assert.equal(storage.refusal(err('ERR_INVALID', 'server_full')), 'server_full');
  assert.equal(storage.refusal(err('ERR_INVALID', 'storage_unavailable')), 'storage_unavailable');
  assert.equal(storage.refusal(err('ERR_BUSY', 'storage_unavailable')), 'storage_unavailable');
  assert.equal(storage.refusal(err('ERR_MEDIA_QUOTA', 'server_full')), 'server_full');
  for (const e of [err('ERR_MEDIA_QUOTA', 'quota exceeded'), err('ERR_INVALID', 'unknown part'), err('ERR_MAIL_NET', 'server_full'), null]) assert.equal(storage.refusal(e), null);
});
