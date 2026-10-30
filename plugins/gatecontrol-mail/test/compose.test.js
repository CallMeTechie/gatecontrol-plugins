'use strict';

// Writing: drafts (reply / reply all / forward filled in by the server), attachments from the device, a mail and Drive,
// warnings, the outbox with undo and planned sending, SMTP with the copy into "Gesendet", contacts.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, ANNA, MARC } = require('./helpers');

async function due(host) {
  await host.gc.db.run("UPDATE outbox SET send_at = 0 WHERE state = 'waiting'");
  await host.tick();
  await settle();
}

test('reply all: recipients without the own address, Re:, the quote; send after the undo time with In-Reply-To; answered', () => withMail({}, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  c.mail.mail('anna@gmx.de', 'INBOX', {
    from: { name: 'Tim Brandt', address: 'tim@example.com' }, to: [{ address: 'anna@gmx.de' }, { name: 'Sabine', address: 'sabine@example.com' }],
    cc: [{ address: 'chef@example.com' }], subject: 'Angebot Kunde Müller', text: 'Kannst du bis Freitag die Preise prüfen?', messageId: '<orig@example.com>',
  });
  const acc = await c.addGmx(ANNA, { body: {} });
  await c.as(ANNA)('PATCH', `accounts/${acc.id}`, { signature: 'Viele Grüße\nAnna' });
  await c.tick();
  const [m] = (await c.list(ANNA, {})).items;
  const d = (await c.as(ANNA)('POST', 'drafts', { mode: 'replyAll', replyTo: m.id })).json.draft;
  assert.deepEqual(d.to.map((p) => p.email), ['tim@example.com', 'sabine@example.com']);
  assert.deepEqual(d.cc.map((p) => p.email), ['chef@example.com']);
  assert.equal(d.subject, 'Re: Angebot Kunde Müller');
  assert.equal(d.accountId, acc.id);
  assert.match(d.html, /Viele Grüße<br>Anna/);
  assert.match(d.html, /<blockquote>.*Kannst du bis Freitag/s);
  assert.deepEqual(d.warnings, []);
  const put = (await c.as(ANNA)('PUT', `drafts/${d.id}`, { html: '<p onmouseover="x()">Mach ich!</p><script>bad()</script>' + d.html })).json.draft;
  assert.ok(!/onmouseover|script/.test(put.html));
  const s = (await c.as(ANNA)('POST', `drafts/${d.id}/send`, {})).json;
  assert.ok(s.undoUntil - Date.now() > 8000 && s.sendAt >= s.undoUntil);
  assert.deepEqual((await c.as(ANNA)('GET', 'outbox')).json.items.map((o) => [o.id, o.state]), [[s.outboxId, 'waiting']]);
  // undo: back to the draft
  assert.deepEqual((await c.as(ANNA)('POST', `outbox/${s.outboxId}/cancel`)).json, { draftId: d.id });
  assert.equal(c.mail.sent.length, 0);
  const s2 = (await c.as(ANNA)('POST', `drafts/${d.id}/send`, {})).json;
  await host.tick();
  assert.equal(c.mail.sent.length, 0, 'not before the undo time');
  await due(host);
  assert.equal(c.mail.sent.length, 1);
  const sent = c.mail.sent[0];
  assert.deepEqual([sent.host, sent.port, sent.security, sent.auth.user], ['mail.gmx.net', 465, 'tls', 'anna@gmx.de']);
  assert.equal(sent.message.inReplyTo, '<orig@example.com>');
  assert.deepEqual(sent.message.references, ['<orig@example.com>']);
  assert.deepEqual(sent.message.from, { name: 'Anna', address: 'anna@gmx.de' });
  assert.match(sent.message.text, /Mach ich!/);
  // the copy in "Gesendet", the original answered, the draft and outbox entry gone
  assert.equal(c.mail.appended.length, 1);
  assert.deepEqual([c.mail.appended[0].path, c.mail.appended[0].flags], ['Gesendet', ['\\Seen']]);
  assert.ok([...c.mail.box('anna@gmx.de', 'INBOX').msgs.values()][0].flags.includes('\\Answered'));
  assert.deepEqual((await c.as(ANNA)('GET', 'outbox')).json.items, []);
  assert.equal((await c.as(ANNA)('GET', `drafts/${d.id}`)).status, 404);
  assert.equal((await c.as(ANNA)('POST', `outbox/${s2.outboxId}/cancel`)).status, 404);
  // the recipients are contacts now
  const ct = (await c.as(ANNA)('GET', 'contacts', null, { q: 'sab' })).json.items;
  assert.deepEqual(ct.map((x) => [x.email, x.source]), [['sabine@example.com', 'recent']]);
}));

test('forward with the attachments of the mail, a file from the device, Drive as copy and link; warnings; too large → link', () => withMail({ driveOpts: { fileSize: 30 * 1024 * 1024 } }, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { address: 'shop@example.com' }, subject: 'Beleg', text: 'anbei', attachments: [{ filename: 'Beleg.pdf', contentType: 'application/pdf', data: '%PDF-beleg' }] });
  await c.addGmx(ANNA);
  await c.tick();
  const [m] = (await c.list(ANNA, {})).items;
  const up = await host.upload({ id: ANNA.id }, Buffer.from('foto'), 'image/jpeg');
  const d = (await c.as(ANNA)('POST', 'drafts', { mode: 'forward', replyTo: m.id, to: ['bo@web.de'] })).json.draft;
  assert.equal(d.subject, 'Fwd: Beleg');
  assert.deepEqual(d.attachments.map((x) => [x.name, x.as]), [['Beleg.pdf', 'copy']]);
  // + a photo from the device, + a Drive file that is too large for GMX (20 MB) → a link, + a link with a password
  const d2 = (await c.as(ANNA)('PUT', `drafts/${d.id}`, { subject: '', html: '<p>Hier das Passwort: geheim123</p>', attachments: [...d.attachments.map((x) => ({ id: x.id })),
    { mediaId: up.body.mediaId }, { driveNodeId: 42, as: 'copy' }, { driveNodeId: 43, as: 'link', expiresDays: 7, password: '4711' }] })).json.draft;
  assert.deepEqual(d2.attachments.map((x) => [x.name, x.as]), [['Beleg.pdf', 'copy'], ['Datei', 'copy'], ['Datei-42.pdf', 'link'], ['Drive', 'link']]);
  assert.deepEqual(d2.warnings.map((w) => w.kind).sort(), ['no_subject', 'password', 'too_large']);
  assert.ok(c.drive.calls.some((x) => x.name === 'give_file' && x.payload.nodeId === 42));
  assert.ok(c.drive.calls.some((x) => x.name === 'share_link' && x.payload.nodeId === 42), 'too large: switched to a link');
  assert.deepEqual(c.drive.calls.find((x) => x.name === 'share_link' && x.payload.nodeId === 43).payload, { nodeId: 43, expiresDays: 7, password: '4711' });
  // someone else's upload is refused
  const other = await host.upload({ id: MARC.id }, Buffer.from('x'), 'image/jpeg');
  assert.equal((await c.as(ANNA)('PUT', `drafts/${d.id}`, { attachments: [{ mediaId: other.body.mediaId }] })).json.error.code, 'invalid');
  // files from the device beyond the provider's limit: 413
  const big = await host.upload({ id: ANNA.id }, Buffer.from('x'), 'application/pdf', { bytes: 21 * 1024 * 1024 });
  assert.deepEqual([(await c.as(ANNA)('PUT', `drafts/${d.id}`, { attachments: [{ mediaId: big.body.mediaId }] })).status], [413]);
  const s = (await c.as(ANNA)('POST', `drafts/${d.id}/send`, { sendAt: Date.now() + 3600000 })).json;
  assert.ok(s.sendAt > Date.now() + 3500000);
  await host.tick();
  assert.equal(c.mail.sent.length, 0, 'planned for later');
  await due(host);
  const msg = c.mail.sent[0].message;
  assert.deepEqual(c.mail.sent[0].files.map((f) => [f.filename, f.data]), [['Beleg.pdf', '%PDF-beleg'], ['Datei', 'foto']]);
  assert.match(msg.html, /https:\/\/gc\.example\.com\/s\/link42/);
  assert.match(msg.html, /https:\/\/gc\.example\.com\/s\/link43/);
  assert.equal(msg.inReplyTo, undefined, 'a forward is no answer');
}));

test('a refused send: failed with a push (mail_failed); invalid drafts; another person\'s draft', () => withMail({}, async (host, c) => {
  await c.addGmx(ANNA);
  const d = (await c.as(ANNA)('POST', 'drafts', { to: ['bo@web.de'], subject: 'Hallo', html: '<p>x</p>' })).json.draft;
  assert.equal((await c.as(ANNA)('POST', 'drafts', { to: ['kein-mail'] })).json.error.code, 'invalid');
  assert.equal((await c.as(MARC)('GET', `drafts/${d.id}`)).status, 404);
  const empty = (await c.as(ANNA)('POST', 'drafts', {})).json.draft;
  assert.equal((await c.as(ANNA)('POST', `drafts/${empty.id}/send`, {})).json.error.code, 'invalid', 'no recipient');
  c.mail.logins.get('anna@gmx.de').pass = 'geändert';
  const s = (await c.as(ANNA)('POST', `drafts/${d.id}/send`, {})).json;
  await due(host);
  const o = (await c.as(ANNA)('GET', 'outbox')).json.items[0];
  assert.deepEqual([o.id, o.state, o.error], [s.outboxId, 'failed', 'auth_failed']);
  const p = host.notifications.find((n) => n.topic === 'mail_failed');
  assert.deepEqual(p.data.mail, { outboxId: s.outboxId });
  assert.equal((await c.as(ANNA)('GET', 'me')).json.accounts[0].state, 'auth_failed');
  // edit and send again: the failed entry is replaced
  assert.equal((await c.as(ANNA)('POST', `outbox/${s.outboxId}/cancel`)).json.draftId, d.id);
  assert.deepEqual((await c.as(ANNA)('DELETE', `drafts/${d.id}`)).json, { ok: true });
}));

test('the service new_draft (Drive: "Per Mail senden"): a draft with the handed-over files', () => withMail({}, async (host, c) => {
  await c.addGmx(ANNA);
  const up = await host.upload({ id: ANNA.id }, Buffer.from('%PDF'), 'application/pdf');
  const r = await host.callService('new_draft', { caller: 'gatecontrol-drive', user: { id: ANNA.id, name: 'Anna', role: 'user' }, payload: { files: [{ mediaId: up.body.mediaId, name: 'Vertrag.pdf' }], subject: 'Vertrag' } });
  assert.equal(r.ok, true);
  const d = (await c.as(ANNA)('GET', `drafts/${r.draftId}`)).json.draft;
  assert.deepEqual([d.subject, d.attachments.map((x) => x.name)], ['Vertrag', ['Vertrag.pdf']]);
  assert.equal((await host.callService('new_draft', { caller: 'gatecontrol-drive', user: null, payload: {} })).ok, false);
}));
