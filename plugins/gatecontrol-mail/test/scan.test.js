'use strict';

// 1.8.0: GateControl's virus scan (server/scan.js; the mock host's opts.scan): attachments carry `scan` once their copy
// was checked — a quarantined one is not opened, downloaded or filed in Drive (423 quarantined), an attachment GateControl
// deleted at once is "Anhang entfernt" (410 attachment_removed, also as `mediaError` of a parsed mail), a forward with a
// held-back attachment warns and is not sent (409 attachment_blocked) until it is removed, a quarantined upload is no
// attachment (422 infected), the hook mediaScanned changes an attachment later. Without the scan nothing changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, ANNA } = require('./helpers');

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

async function due(host) {
  await host.gc.db.run("UPDATE outbox SET send_at = 0 WHERE state = 'waiting'");
  await host.tick();
  await settle();
}

/** Anna's GMX with one mail of `attachments` → the message (as GET messages/<id> shows it). */
async function mailWith(c, attachments) {
  c.mail.login('anna@gmx.de', 'geheim-123');
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { name: 'Shop', address: 'shop@example.com' }, subject: 'Rechnung', text: 'anbei', attachments });
  await c.addGmx(ANNA);
  await c.tick();
  const [s] = (await c.list(ANNA, {})).items;
  return (await c.as(ANNA)('GET', `messages/${s.id}`)).json;
}

test('GET me lists the feature; an older GateControl: no `scan`, the attachment opens', () => withMail({}, async (host, c) => {
  assert.ok((await c.as(ANNA)('GET', 'me')).json.features.includes('scan'));
  const m = await mailWith(c, [{ filename: 'eicar.pdf', contentType: 'application/pdf', data: EICAR }]);
  assert.equal((await c.as(ANNA)('GET', `messages/${m.id}/attachments/${m.attachments[0].id}`)).status, 200);
  assert.equal((await c.as(ANNA)('GET', `messages/${m.id}`)).json.attachments[0].scan, undefined);
}));

test('a quarantined attachment: 423 quarantined, its chip on the message, no Drive; a forward warns and is not sent until it is removed', () => withMail({ scan: true }, async (host, c) => {
  const m = await mailWith(c, [{ filename: 'Rechnung.pdf', contentType: 'application/pdf', data: EICAR }, { filename: 'AGB.pdf', contentType: 'application/pdf', data: '%PDF-agb' }]);
  const [bad, ok] = m.attachments;
  const r = await c.as(ANNA)('GET', `messages/${m.id}/attachments/${bad.id}`);
  assert.deepEqual([r.status, r.json.error.code, r.json.error.scan], [423, 'quarantined', { state: 'infected', blocked: true, finding: 'Eicar-Test-Signature' }]);
  assert.equal(r.json.error.message, 'Der Anhang ist gesperrt – der Virenscan hat Schadsoftware gefunden.');
  const good = (await c.as(ANNA)('GET', `messages/${m.id}/attachments/${ok.id}`)).json;
  assert.deepEqual(good.scan, { state: 'clean', blocked: false, finding: null });
  const again = (await c.as(ANNA)('GET', `messages/${m.id}`)).json.attachments;
  assert.deepEqual(again.map((t) => [t.name, t.scan && t.scan.state, t.scan && t.scan.blocked]), [['Rechnung.pdf', 'infected', true], ['AGB.pdf', 'clean', false]]);
  // "In Drive ablegen": refused before anything goes to Drive
  const sv = await c.as(ANNA)('POST', `messages/${m.id}/attachments/${bad.id}/drive/save`, { folderId: 7 });
  assert.deepEqual([sv.status, sv.json.error.code], [423, 'quarantined']);
  assert.ok(!c.drive.calls.some((x) => x.name === 'save_file'));
  // forward: the held-back attachment is flagged, sending refused until it is removed
  const d = (await c.as(ANNA)('POST', 'drafts', { mode: 'forward', replyTo: m.id, to: ['bo@web.de'] })).json.draft;
  assert.deepEqual(d.attachments.map((x) => [x.name, x.scan && x.scan.blocked]), [['Rechnung.pdf', true], ['AGB.pdf', false]]);
  assert.ok(d.warnings.some((w) => w.kind === 'attachment_blocked'));
  const s = await c.as(ANNA)('POST', `drafts/${d.id}/send`, {});
  assert.deepEqual([s.status, s.json.error.code, s.json.error.name], [409, 'attachment_blocked', 'Rechnung.pdf']);
  const d2 = (await c.as(ANNA)('PUT', `drafts/${d.id}`, { attachments: [{ id: d.attachments[1].id }] })).json.draft;
  assert.ok(!d2.warnings.some((w) => w.kind === 'attachment_blocked'));
  assert.equal((await c.as(ANNA)('POST', `drafts/${d.id}/send`, {})).status, 200);
  await due(host);
  assert.deepEqual(c.mail.sent[0].files.map((f) => f.filename), ['AGB.pdf']);
}));

test('deleted at once ("Sofort löschen"): "Anhang entfernt" — 410, never loaded again; also as mediaError of a parsed mail', () => withMail({ scan: (f) => (f.data.includes('EICAR') ? { deleted: true, finding: 'Eicar-Test-Signature' } : null) }, async (host, c) => {
  const m = await mailWith(c, [{ filename: 'Rechnung.exe', contentType: 'application/pdf', data: EICAR }, { filename: 'b.pdf', contentType: 'application/pdf', data: 'x', mediaError: 'ERR_MEDIA_INFECTED' }]);
  const r = await c.as(ANNA)('GET', `messages/${m.id}/attachments/${m.attachments[0].id}`);
  assert.deepEqual([r.status, r.json.error.code], [410, 'attachment_removed']);
  const before = c.mail.sessions.length;
  assert.equal((await c.as(ANNA)('GET', `messages/${m.id}/attachments/${m.attachments[0].id}`)).status, 410);
  assert.equal(c.mail.sessions.length, before, 'not loaded again');
  const atts = (await c.as(ANNA)('GET', `messages/${m.id}`)).json.attachments;
  assert.deepEqual(atts.map((t) => t.scan), [{ state: 'infected', blocked: true, finding: null, removed: true }, { state: 'infected', blocked: true, finding: null, removed: true }]);
}));

test('a later result (mediaScanned): a clean copy blocked by the nightly re-check, released again; a quarantined upload is no attachment', () => withMail({ scan: true }, async (host, c) => {
  const m = await mailWith(c, [{ filename: 'a.pdf', contentType: 'application/pdf', data: '%PDF-a' }]);
  const t = m.attachments[0];
  const got = (await c.as(ANNA)('GET', `messages/${m.id}/attachments/${t.id}`)).json;
  const before = host.events.length;
  await host.mediaScanned(got.mediaId, { state: 'infected', finding: 'Win.Trojan.Agent-1' });
  assert.ok(host.events.slice(before).some((e) => e.type === 'mail' && e.data.attachmentId === t.id));
  assert.equal((await c.as(ANNA)('GET', `messages/${m.id}/attachments/${t.id}`)).json.error.code, 'quarantined');
  await host.mediaScanned(got.mediaId, { state: 'clean' });
  assert.equal((await c.as(ANNA)('GET', `messages/${m.id}/attachments/${t.id}`)).status, 200);
  // an upload GateControl quarantined is no attachment
  const up = await host.upload({ id: ANNA.id }, Buffer.from(EICAR), 'application/pdf');
  assert.equal(up.body.scan.state, 'infected');
  const d = (await c.as(ANNA)('POST', 'drafts', { to: ['bo@web.de'] })).json.draft;
  const r = await c.as(ANNA)('PUT', `drafts/${d.id}`, { attachments: [{ mediaId: up.body.mediaId, name: 'x.pdf' }] });
  assert.deepEqual([r.status, r.json.error.code], [422, 'infected']);
}));
