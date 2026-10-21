'use strict';

// 1.5.0: school messages without WebUntis — the full text (the detail call), the attachments (into
// GateControl's media store, read only by the people who may read the inbox), "new" per person
// (opened in an app or on a page) and the read confirmation the sender asks for (sent only on a tap).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHost, asAdmin, asApp, asPortal, asPortalPost, setupParent, tickAt, at, clock, ADMIN, EVA, LENA, BOB, T0, S3_HOST } = require('./helpers');
const messages = require('../server/messages');
const untisLib = require('../server/untis');

const MIN = 60000;
const DAY = 86400000;
const SCHOOL = { untis: { school: true } };
const PDF = Buffer.from('%PDF-1.4 Elternbrief');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function msg(id, subject, extra = {}) {
  return {
    id, subject, contentPreview: `Vorschau ${id}`, hasAttachments: false, isMessageRead: false,
    sender: { userId: 7, displayName: 'Frau Schmidt', imageUrl: '', className: '' }, sentDateTime: '2026-10-20T06:00:00Z', ...extra,
  };
}
const pushes = (host) => host.notifications.filter((n) => n.topic === 'messages');
const get = async (host, user) => (await asApp(host, user, '/app/messages')).json.messages;
const post = (host, user, p) => asApp(host, user, p, {}, 'POST', {});

test('detail and attachments: parsed safely', () => {
  const d = messages.detailOf({
    content: '<p>Liebe Eltern,</p><p>am <b>Freitag</b> ist Wandertag.</p><script>x()</script>',
    storageAttachments: [{ id: 'a-1', name: '../../Elternbrief.pdf', size: 1234 }, { id: 'a-1', name: 'doppelt' }, { id: 'bad id!', name: 'x' }, { id: 7, name: 'Foto.JPG' }],
  });
  assert.equal(d.body, 'Liebe Eltern,\n\nam Freitag ist Wandertag.');
  assert.deepEqual(d.attachments, [
    { id: 'a-1', name: 'Elternbrief.pdf', size: 1234, mime: 'application/pdf' },
    { id: '7', name: 'Foto.JPG', size: null, mime: 'image/jpeg' },
  ]);
  assert.deepEqual(messages.detailOf({}), { body: null, attachments: [] });
  assert.equal(messages.mimeOf('liste.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(messages.mimeOf('ohne'), 'application/octet-stream');
  // the storage link: https only; host / cookie / authorization headers are never passed on
  const l = untisLib.storageLink({ downloadUrl: 'https://b.s3.amazonaws.com/x?sig=1', additionalHeaders: [{ key: 'x-amz-k', value: 'v' }, { key: 'Host', value: 'evil' }, { key: 'Cookie', value: 'c' }, { key: 'bad name', value: 'v' }] });
  assert.deepEqual(l, { url: 'https://b.s3.amazonaws.com/x?sig=1', headers: { 'x-amz-k': 'v' } });
  for (const bad of [{}, { downloadUrl: 'http://b.s3.amazonaws.com/x' }, { downloadUrl: 'https://u:p@b.s3.amazonaws.com/x' }]) {
    assert.throws(() => untisLib.storageLink(bad), (e) => e.code === 'failed');
  }
});

test('a new message: full text in the push and the API, its attachments fetched in the cycle, readable only by who may read the inbox', () => withHost(SCHOOL, async (host, untis) => {
  untis.state.inbox = [msg(1, 'Wandertag')];
  untis.state.details[1] = { content: '<p>Alter Text</p>' };
  await setupParent(host);
  // the baseline message gets its full text too (no push)
  let list = await get(host, EVA);
  assert.deepEqual([list[0].body, list[0].fullText, list[0].isNew], ['Alter Text', true, false]);
  assert.equal(pushes(host).length, 0);

  untis.state.inbox.unshift(msg(2, 'Elternbrief', { hasAttachments: true, contentPreview: 'Liebe Eltern …' }));
  untis.state.details[2] = {
    content: '<p>Liebe Eltern,</p><p>anbei der Elternbrief und ein Foto.</p>',
    storageAttachments: [{ id: 'f-pdf', name: 'Elternbrief.pdf', size: PDF.length }, { id: 'f-jpg', name: 'Foto.jpg' }],
  };
  untis.state.files['f-pdf'] = { body: PDF, type: 'binary/octet-stream' };
  untis.state.files['f-jpg'] = { body: JPG, type: 'image/jpeg' };
  await tickAt(host, T0 + 15 * MIN);
  const p = pushes(host);
  assert.equal(p.length, 1);
  assert.equal(p[0].body, 'Frau Schmidt: Liebe Eltern, anbei der Elternbrief und ein Foto.', 'the push from the full text');

  list = await get(host, EVA);
  const m = list[0];
  assert.deepEqual([m.subject, m.body, m.fullText, m.isNew, m.read, m.confirmation], ['Elternbrief', 'Liebe Eltern,\n\nanbei der Elternbrief und ein Foto.', true, true, false, null]);
  assert.deepEqual(m.attachments, [
    { id: 'f-pdf', name: 'Elternbrief.pdf', size: PDF.length, mime: 'application/pdf' },
    { id: 'f-jpg', name: 'Foto.jpg', size: JPG.length, mime: 'image/jpeg' },
  ]);
  // fetched with the storage headers WebUntis named (never its "Host"), into the media store, claimed, no owner
  const files = host.fetches.filter((f) => f.url.startsWith(`https://${S3_HOST}/`));
  assert.equal(files.length, 2);
  assert.deepEqual(files[0].opts.headers, { 'x-amz-server-side-encryption-customer-key': 'k3y' });
  assert.equal(host.media.size, 2);
  assert.ok([...host.media.values()].every((f) => f.claimed && f.owner === null));

  // the app asks for it → the media id; the file from the client media route
  const r = await post(host, EVA, `/app/messages/${m.id}/attachments/f-pdf`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.file.name, r.json.file.mime, r.json.file.bytes, r.json.file.url], ['Elternbrief.pdf', 'application/pdf', PDF.length, undefined]);
  const f = await host.mediaGet(EVA, r.json.file.mediaId);
  assert.equal(f.status, 200);
  assert.deepEqual(Buffer.from(f.body), PDF);
  assert.match(f.headers['content-disposition'], /^attachment; filename="Elternbrief\.pdf"/);
  assert.equal((await host.mediaGet(BOB, r.json.file.mediaId)).status, 404, 'Bob may not read the inbox');
  assert.equal((await host.mediaGet(LENA, r.json.file.mediaId)).status, 404, 'nor the child through the parents’ inbox');
  assert.equal((await host.mediaGet(ADMIN, r.json.file.mediaId)).status, 200);
  assert.equal(untis.state.calls.filter((c) => c === 'file').length, 2, 'not fetched again');
  // others: not found
  assert.equal((await post(host, BOB, `/app/messages/${m.id}/attachments/f-pdf`)).json.code, 'SCHULE_MESSAGE_NOT_FOUND');
  assert.equal((await post(host, EVA, `/app/messages/${m.id}/attachments/nope`)).json.code, 'SCHULE_ATTACHMENT_NOT_FOUND');
  assert.equal((await post(host, EVA, '/app/messages/x/read')).json.code, 'SCHULE_MESSAGE_NOT_FOUND');

  // pages: the attachments as /plugin-media/ links (a picture shows in the message)
  const ov = (await asPortal(host, EVA, '/portal/overview')).json;
  const pm = ov.students.find((s) => s.messages).messages[0];
  assert.match(pm.attachments[1].url, /^\/plugin-media\/[0-9a-f]{32}\./);
  assert.equal((await host.mediaFromUrl(pm.attachments[1].url)).headers['content-type'], 'image/jpeg');
  // uploads by people: refused (the plugin takes none)
  assert.equal((await host.upload(EVA, PDF, 'application/pdf')).status, 403);
}));

test('"new" per person: opening a message (app or page) takes its mark away for that person only', () => withHost(SCHOOL, async (host, untis) => {
  untis.state.inbox = [];
  const { lena } = await setupParent(host);
  // Admin is a recipient too: both get it
  await asAdmin(host, 'PUT', `/students/${lena.id}`, { recipients: [EVA.id, ADMIN.id] });
  untis.state.inbox = [msg(5, 'Hitzefrei')];
  await tickAt(host, T0 + 15 * MIN);
  const id = (await get(host, EVA))[0].id;
  assert.equal((await get(host, EVA))[0].isNew, true);
  const tiles = async (user) => (await host.portalTiles(user)).map((t) => JSON.stringify(t)).join();
  assert.match(await tiles(EVA), /1 neue Nachricht/);
  const r = await post(host, EVA, `/app/messages/${id}/read`);
  assert.deepEqual([r.status, r.json.message.isNew, r.json.message.read], [200, false, true]);
  assert.equal((await get(host, EVA))[0].isNew, false);
  assert.doesNotMatch(await tiles(EVA), /neue Nachricht/);
  assert.equal((await get(host, ADMIN))[0].isNew, true, 'still new for the admin');
  // the page (portal) marks it read too
  const pr = await asPortalPost(host, ADMIN, `/portal/messages/${id}/read`);
  assert.equal(pr.json.message.isNew, false);
  assert.equal((await get(host, ADMIN))[0].isNew, false);
  // read twice: fine
  assert.equal((await post(host, EVA, `/app/messages/${id}/read`)).status, 200);
}));

test('read confirmation: asked for → sent only on the tap, once, with who and when; confirmed elsewhere is seen', () => withHost(SCHOOL, async (host, untis) => {
  untis.state.inbox = [];
  await setupParent(host);
  untis.state.confirm = [msg(20, 'Information der Schulleitung'), msg(21, 'Zweite Bitte')];
  await tickAt(host, T0 + 15 * MIN);
  let list = await get(host, EVA);
  const m = list.find((x) => x.subject === 'Information der Schulleitung');
  assert.deepEqual(m.confirmation, { confirmedAt: null, by: null });
  assert.deepEqual(untis.state.confirmed, [], 'nothing sent by itself');
  assert.equal((await post(host, BOB, `/app/messages/${m.id}/confirm`)).json.code, 'SCHULE_MESSAGE_NOT_FOUND');

  const r = await post(host, EVA, `/app/messages/${m.id}/confirm`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.message.confirmation, { confirmedAt: '2026-10-20T12:00:00.000Z', by: 'Eva' });
  assert.equal(r.json.message.read, true);
  assert.deepEqual(untis.state.confirmed, ['20']);
  assert.equal(untis.state.sessions.size, 0, 'logged out again');
  await post(host, EVA, `/app/messages/${m.id}/confirm`);
  assert.deepEqual(untis.state.confirmed, ['20'], 'once');
  // a message without a request
  untis.state.inbox = [msg(22, 'Normal')];
  await tickAt(host, T0 + 30 * MIN);
  const n = (await get(host, EVA)).find((x) => x.subject === 'Normal');
  assert.equal((await post(host, EVA, `/app/messages/${n.id}/confirm`)).json.code, 'SCHULE_CONFIRM_NOT_REQUIRED');
  // the second one confirmed in WebUntis: no longer in that list → seen as confirmed (by nobody here)
  untis.state.confirm = [];
  untis.state.inbox.push(msg(21, 'Zweite Bitte'));
  await tickAt(host, T0 + 45 * MIN);
  list = await get(host, EVA);
  const second = list.find((x) => x.subject === 'Zweite Bitte');
  assert.ok(second.confirmation.confirmedAt);
  assert.equal(second.confirmation.by, null);
  // WebUntis down: a clear code, nothing stored
  untis.state.confirm = [msg(23, 'Dritte Bitte')];
  await tickAt(host, T0 + 60 * MIN);
  const third = (await get(host, EVA)).find((x) => x.subject === 'Dritte Bitte');
  untis.state.schoolStatus.confirm = 500;
  const bad = await post(host, EVA, `/app/messages/${third.id}/confirm`);
  assert.deepEqual([bad.status, bad.json.code], [503, 'SCHULE_UNTIS_UNAVAILABLE']);
  assert.equal((await get(host, EVA)).find((x) => x.subject === 'Dritte Bitte').confirmation.confirmedAt, null);
}));

test('attachments on demand (older messages), too large, failing storage; detail retries; pruned with their messages', () => withHost(SCHOOL, async (host, untis) => {
  untis.state.inbox = [msg(30, 'Alt', { hasAttachments: true })];
  untis.state.details[30] = { content: 'Text', storageAttachments: [{ id: 'old', name: 'Plan.pdf' }, { id: 'big', name: 'Video.mp4', size: 30 * 1024 * 1024 }] };
  untis.state.files.old = { body: PDF, type: 'application/pdf' };
  await setupParent(host);
  assert.equal(host.media.size, 0, 'baseline messages: nothing fetched in the cycle');
  const id = (await get(host, EVA))[0].id;
  let r = await post(host, EVA, `/app/messages/${id}/attachments/big`);
  assert.deepEqual([r.status, r.json.code], [413, 'SCHULE_ATTACHMENT_TOO_LARGE']);
  untis.state.schoolStatus.file = 500;
  r = await post(host, EVA, `/app/messages/${id}/attachments/old`);
  assert.deepEqual([r.status, r.json.code], [502, 'SCHULE_ATTACHMENT_FAILED']);
  delete untis.state.schoolStatus.file;
  r = await post(host, EVA, `/app/messages/${id}/attachments/old`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(host.media.size, 1);
  assert.equal(untis.state.sessions.size, 0, 'logged out again');
  // pages get the link
  const pr = await asPortalPost(host, EVA, `/portal/messages/${id}/attachments/old`);
  assert.match(pr.json.file.url, /^\/plugin-media\//);

  // a detail that fails is asked again later — not every cycle
  untis.state.inbox.unshift(msg(31, 'Ohne Detail'));
  await tickAt(host, T0 + 15 * MIN);
  const before = untis.state.detailCalls.filter((x) => x === '31').length;
  assert.equal(before, 1);
  await tickAt(host, T0 + 30 * MIN);
  assert.equal(untis.state.detailCalls.filter((x) => x === '31').length, 1, 'waits an hour');
  untis.state.details[31] = { content: 'Jetzt da' };
  await tickAt(host, T0 + 75 * MIN);
  assert.equal((await get(host, EVA)).find((x) => x.subject === 'Ohne Detail').body, 'Jetzt da');

  // 90 days later the message and its file go
  untis.state.inbox = [];
  clock.set(at('2026-10-19T16:00:00Z') + 91 * DAY);
  await host.tick();
  assert.equal(host.media.size, 0);
}));

test('1.5.1: the push of a message carries a card for the chats (GateControl ≥ 1.191.0): whole text, link to the message', () => withHost({ ...SCHOOL, gatecontrol: '1.191.0' }, async (host, untis) => {
  untis.state.inbox = [];
  await setupParent(host);
  const long = 'Liebe Eltern, ' + 'am Freitag ist Wandertag. '.repeat(200);
  untis.state.inbox.unshift(msg(3, 'Wandertag'));
  untis.state.details[3] = { content: `<p>${long}</p>` };
  await tickAt(host, T0 + 15 * MIN);
  const p = pushes(host);
  assert.equal(p.length, 1);
  assert.equal(p[0].body.length <= 1000, true);
  const card = p[0].card;
  assert.deepEqual(card.link, { label: 'Ganze Nachricht lesen', route: 'plg-gatecontrol-schule' });
  assert.ok(card.text.length <= 4000 && card.text.length > 3990, `the whole text, cut to 4000 (${card.text.length})`);
  assert.ok(card.text.startsWith('Von Frau Schmidt\n\nLiebe Eltern, am Freitag ist Wandertag.'), card.text.slice(0, 60));
  assert.ok(card.text.endsWith('…'));
  assert.ok(p[0].data.schule.messageId, 'the push data still names the message (the app opens it)');
  // pushOf: a message without the detail yet → the preview; no sender → only the text
  const po = messages.pushOf({ subject: 'X', preview: 'Kurz', full_text: 0, body: null, sender: '' }, 'en');
  assert.deepEqual(po.card, { text: 'Kurz', link: { label: 'Read the whole message', route: 'plg-gatecontrol-schule' } });
}));
