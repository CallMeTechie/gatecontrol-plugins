'use strict';

// Mail 1.1 on GateControl ≥ 1.217.0: Microsoft accounts send files from the device, from other mails and from Drive
// (Graph draft, small files with contentBytes — GateControl puts the media file in base64 —, large ones through an upload
// session in pieces, then send), Graph's own forward drops the attachments the person took out; the SMTP login of a new or
// changed account is checked with gc.mail.smtp.verify. On 1.216.0 everything stays as in 1.0 (feature detection).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, fakeDrive, ANNA } = require('./helpers');
const { storeType } = require('../server/util');

const CLIENT = { microsoft: { registration: 'custom', customClientId: '11111111-2222-3333-4444-555555555555' } };
const PKCE = { code: 'CODE-OK', codeVerifier: 'v'.repeat(43), redirectUri: 'msauth://com.gatecontrol.client/abc%3D' };
const B64 = '{{gc:media:base64}}';

/** A fake Microsoft (token endpoint, Graph, the upload host) that records every request. */
function graphWorld(o = {}) {
  const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const st = { calls: [], uploads: new Map(), seq: 0, failPut: !!o.failPut };
  const json = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const msg = {
    id: 'g1', internetMessageId: '<g1@outlook>', conversationId: 'c1', subject: 'Unterlagen', bodyPreview: 'anbei', from: { emailAddress: { name: 'Chef', address: 'chef@firma.example' } },
    toRecipients: [{ emailAddress: { address: 'anna@outlook.com' } }], receivedDateTime: new Date().toISOString(), isRead: false, flag: { flagStatus: 'notFlagged' },
    hasAttachments: true, inferenceClassification: 'focused',
  };
  // o.atts: the original's attachments (1.17.3: with odd types); their bytes at …/attachments/<id>/$value
  const origAtts = o.atts || [{ id: 'a1', name: 'Vertrag.pdf', contentType: 'application/pdf', size: 1200, isInline: false }, { id: 'a2', name: 'Alt.pdf', contentType: 'application/pdf', size: 800, isInline: false }];
  st.fetch = async (url, x) => {
    const u = new URL(url);
    const rec = { method: x.method || 'GET', host: u.host, path: u.pathname.replace('/v1.0', ''), query: u.search, json: x.json, headers: x.headers || {}, body: x.body, bodyMedia: x.bodyMedia };
    if (u.host === 'login.microsoftonline.com') {
      const f = x.form || {};
      if (f.grant_type === 'authorization_code') return json(200, { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, id_token: jwt({ email: 'anna@outlook.com', tid: '9188040d-6c67-4c5b-b112-36a304b66dad', name: 'Anna' }) });
      if (f.grant_type === 'refresh_token') return json(200, { access_token: 'AT-2', expires_in: 3600 });
      return json(400, { error: 'unsupported' });
    }
    st.calls.push(rec);
    if (u.host === 'outlook.office.com') {
      // the upload session: pre-authenticated URL, no Bearer token; pieces in order
      assert.equal(rec.headers.authorization, undefined, 'no token on the upload URL');
      const id = /AttachmentSessions\('([^']+)'\)/.exec(u.pathname)[1];
      const up = st.uploads.get(id);
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(rec.headers['content-range'] || '');
      assert.ok(m, 'Content-Range from the host');
      up.ranges.push([Number(m[1]), Number(m[2]), Number(m[3])]);
      if (st.failPut) return json(500, { error: { code: 'ServerError' } });
      if (Number(m[2]) + 1 >= up.size) return { status: 201, headers: { location: `https://outlook.office.com/api/v2.0/Messages('x')/Attachments('${id}')` }, body: '' };
      return json(200, { expirationDateTime: '2030-01-01T00:00:00Z', nextExpectedRanges: [`${Number(m[2]) + 1}-`] });
    }
    assert.equal(u.host, 'graph.microsoft.com');
    assert.match(rec.headers.authorization, /^Bearer AT-/);
    const p = rec.path;
    const wk = /^\/me\/mailFolders\/(inbox|sentitems|drafts|archive|junkemail|deleteditems)$/.exec(p);
    if (wk) return json(200, { id: `F-${wk[1]}` });
    if (p === '/me/mailFolders') return json(200, { value: ['inbox', 'sentitems', 'drafts', 'archive', 'junkemail', 'deleteditems'].map((n) => ({ id: `F-${n}`, displayName: n, childFolderCount: 0, totalItemCount: 1, unreadItemCount: 0 })) });
    if (/\/messages\/delta$/.test(p)) return json(200, { value: p.includes('F-inbox') ? [msg] : [], '@odata.deltaLink': `https://graph.microsoft.com/v1.0${p}?$deltatoken=t1` });
    if (p === '/me/messages/g1' && rec.method === 'GET') return json(200, { body: { contentType: 'html', content: '<p>anbei</p>' }, internetMessageHeaders: [], hasAttachments: true });
    if (p === '/me/messages/g1/attachments') return json(200, { value: origAtts.map((t) => ({ '@odata.type': '#microsoft.graph.fileAttachment', ...t })) });
    const val = /^\/me\/messages\/g1\/attachments\/([^/]+)\/\$value$/.exec(p);
    if (val && origAtts.some((t) => t.id === val[1])) return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from(`bytes-${val[1]}`) };
    if (p === '/me/messages' && rec.method === 'POST') return json(201, { id: `new-${++st.seq}` });
    const act = /^\/me\/messages\/([^/]+)\/(createReply|createReplyAll|createForward|send)$/.exec(p);
    if (act) return act[2] === 'send' ? { status: 202, headers: {}, body: '' } : json(201, { id: `draft-${act[1]}` });
    const atts = /^\/me\/messages\/([^/]+)\/attachments$/.exec(p);
    if (atts && rec.method === 'GET') return json(200, { value: act ? [] : origAtts.map((t) => ({ id: `fw-${t.id}`, name: t.name, size: t.size, isInline: false })) });
    if (atts && rec.method === 'POST') return json(201, { id: `att-${++st.seq}` });
    const sess = /^\/me\/messages\/([^/]+)\/attachments\/createUploadSession$/.exec(p);
    if (sess) {
      const id = `S${++st.seq}`;
      st.uploads.set(id, { size: rec.json.AttachmentItem.size, ranges: [] });
      return json(201, { uploadUrl: `https://outlook.office.com/api/v2.0/Users('u')/Messages('${sess[1]}')/AttachmentSessions('${id}')?authtoken=tok`, nextExpectedRanges: ['0-'] });
    }
    if (/^\/me\/messages\/[^/]+$/.test(p) && (rec.method === 'PATCH' || rec.method === 'DELETE')) return json(rec.method === 'DELETE' ? 204 : 200, {});
    if (/^\/me\/messages\/[^/]+\/attachments\/[^/]+$/.test(p) && rec.method === 'DELETE') return { status: 204, headers: {}, body: '' };
    if (p === '/me/sendMail') return { status: 202, headers: {}, body: '' };
    return json(404, { error: { code: 'ErrorItemNotFound' } });
  };
  return st;
}

async function due(host) {
  await host.gc.db.run("UPDATE outbox SET send_at = 0 WHERE state = 'waiting'");
  await host.tick();
  await settle();
}

async function microsoftAccount(c) {
  await c.admin('PUT', 'admin/settings', CLIENT);
  const acc = (await c.as(ANNA)('POST', 'accounts/microsoft', PKCE)).json.account;
  await settle(200);
  await c.tick();
  return acc;
}

const calls = (w, method, re) => w.calls.filter((x) => x.method === method && re.test(x.path));

test('Microsoft on 1.217.0: files from the device (small and large), from another mail and from Drive go along through Graph', () => {
  const w = graphWorld();
  return withMail({ gatecontrol: '1.217.0', fetch: w.fetch }, async (host, c) => {
    // a mail with an attachment in another (IMAP) account of Anna
    c.mail.login('anna@gmx.de', 'geheim-123');
    c.mail.mail('anna@gmx.de', 'INBOX', { from: { address: 'shop@example.com' }, subject: 'Beleg', text: 'anbei', attachments: [{ filename: 'Beleg.pdf', contentType: 'application/pdf', data: '%PDF-beleg' }] });
    const gmx = await c.addGmx(ANNA);
    const acc = await microsoftAccount(c);
    await c.tick();
    const beleg = (await c.list(ANNA, { box: String(gmx.id) })).items.find((m) => m.subject === 'Beleg');
    const full = (await c.as(ANNA)('GET', `messages/${beleg.id}`)).json;
    const small = await host.upload({ id: ANNA.id }, Buffer.from('foto-bytes'), 'image/jpeg');
    const big = await host.upload({ id: ANNA.id }, Buffer.from('gross'), 'application/pdf', { bytes: 7 * 1024 * 1024 + 5 });
    const d = (await c.as(ANNA)('POST', 'drafts', {
      accountId: acc.id, to: ['bo@web.de'], subject: 'Unterlagen', html: '<p>Hallo</p>',
      attachments: [{ mediaId: small.body.mediaId, name: 'Foto.jpg' }, { mediaId: big.body.mediaId, name: 'Plan.pdf' }, { messageId: beleg.id, attachmentId: full.attachments[0].id }, { driveNodeId: 42, as: 'copy' }],
    })).json.draft;
    assert.deepEqual(d.attachments.map((x) => [x.name, x.as]), [['Foto.jpg', 'copy'], ['Plan.pdf', 'copy'], ['Beleg.pdf', 'copy'], ['Datei-42.pdf', 'copy']]);
    assert.deepEqual(d.warnings, [], 'no "Microsoft cannot send files" any more, Drive stays a copy');
    assert.equal(c.drive.calls.some((x) => x.name === 'share_link'), false);
    const s = await c.as(ANNA)('POST', `drafts/${d.id}/send`, {});
    assert.equal(s.status, 200, JSON.stringify(s.json));
    await due(host);
    // a Graph draft with the recipients, the files, then send — no sendMail
    const created = calls(w, 'POST', /^\/me\/messages$/);
    assert.equal(created.length, 1);
    assert.equal(created[0].json.toRecipients[0].emailAddress.address, 'bo@web.de');
    assert.equal(created[0].json.subject, 'Unterlagen');
    const id = 'new-1';
    const posted = calls(w, 'POST', /\/attachments$/);
    assert.deepEqual(posted.map((x) => x.json.name), ['Foto.jpg', 'Beleg.pdf', 'Datei-42.pdf']);
    for (const x of posted) {
      assert.equal(x.path, `/me/messages/${id}/attachments`);
      assert.equal(x.json['@odata.type'], '#microsoft.graph.fileAttachment');
      assert.equal(x.headers['content-type'], 'application/json');
      assert.ok(x.bodyMedia && x.bodyMedia.mediaId, 'the host streams the file');
    }
    // the host put the file in base64 where MEDIA_BASE64 stood
    const sent = posted.map((x) => Buffer.from(JSON.parse(x.body.toString()).contentBytes, 'base64').toString());
    assert.deepEqual(sent, ['foto-bytes', '%PDF-beleg', 'drive-42']);
    assert.equal(posted[0].json.contentBytes, B64);
    // the large one: an upload session, pieces of < 4 MB in order, the last answered 201
    const sess = calls(w, 'POST', /\/attachments\/createUploadSession$/);
    assert.equal(sess.length, 1);
    assert.deepEqual(sess[0].json.AttachmentItem, { attachmentType: 'file', name: 'Plan.pdf', size: 7 * 1024 * 1024 + 5, contentType: 'application/pdf' });
    const ranges = [...w.uploads.values()][0].ranges;
    assert.equal(ranges[0][0], 0);
    assert.equal(ranges[ranges.length - 1][1], 7 * 1024 * 1024 + 4);
    for (let i = 0; i < ranges.length; i++) {
      assert.ok(ranges[i][1] - ranges[i][0] + 1 < 4 * 1024 * 1024, 'each piece under 4 MB');
      if (i) assert.equal(ranges[i][0], ranges[i - 1][1] + 1);
    }
    assert.ok(calls(w, 'PUT', /AttachmentSessions/).every((x) => x.bodyMedia && Number.isInteger(x.bodyMedia.start)), 'ranges by the host');
    assert.deepEqual(calls(w, 'POST', /\/send$/).map((x) => x.path), [`/me/messages/${id}/send`]);
    assert.equal(calls(w, 'POST', /^\/me\/sendMail$/).length, 0);
    assert.deepEqual((await c.as(ANNA)('GET', 'outbox')).json.items, []);
    // without files a new mail stays one sendMail
    const d2 = (await c.as(ANNA)('POST', 'drafts', { accountId: acc.id, to: ['bo@web.de'], subject: 'Kurz', html: '<p>x</p>' })).json.draft;
    await c.as(ANNA)('POST', `drafts/${d2.id}/send`, {});
    await due(host);
    assert.equal(calls(w, 'POST', /^\/me\/sendMail$/).length, 1);
  });
});

test('Microsoft on 1.217.0: Graph\'s own forward keeps the original\'s files the person kept, drops the others, adds the device\'s', () => {
  const w = graphWorld();
  return withMail({ gatecontrol: '1.217.0', fetch: w.fetch }, async (host, c) => {
    const acc = await microsoftAccount(c);
    const [m] = (await c.list(ANNA, {})).items;
    assert.equal(m.subject, 'Unterlagen');
    const d = (await c.as(ANNA)('POST', 'drafts', { mode: 'forward', replyTo: m.id, to: ['bo@web.de'] })).json.draft;
    assert.equal(d.accountId, acc.id);
    assert.deepEqual(d.attachments.map((x) => x.name), ['Vertrag.pdf', 'Alt.pdf']);
    const up = await host.upload({ id: ANNA.id }, Buffer.from('notiz'), 'text/plain');
    const d2 = (await c.as(ANNA)('PUT', `drafts/${d.id}`, { attachments: [{ id: d.attachments[0].id }, { mediaId: up.body.mediaId, name: 'Notiz.txt' }] })).json.draft;
    assert.deepEqual(d2.attachments.map((x) => x.name), ['Vertrag.pdf', 'Notiz.txt']);
    const downloads = () => host.fetches.filter((f) => /\/attachments\/a\d\/\$value$/.test(f.url)).length;
    const before = downloads();
    await c.as(ANNA)('POST', `drafts/${d.id}/send`, {});
    await due(host);
    assert.equal(calls(w, 'POST', /\/g1\/createForward$/).length, 1);
    assert.deepEqual(calls(w, 'DELETE', /\/attachments\//).map((x) => x.path), ['/me/messages/draft-g1/attachments/fw-a2'], 'only the one taken out');
    const posted = calls(w, 'POST', /\/draft-g1\/attachments$/);
    assert.deepEqual(posted.map((x) => [x.json.name, Buffer.from(JSON.parse(x.body.toString()).contentBytes, 'base64').toString()]), [['Notiz.txt', 'notiz']]);
    assert.deepEqual(calls(w, 'POST', /\/send$/).map((x) => x.path), ['/me/messages/draft-g1/send']);
    assert.equal(downloads(), before, 'Graph keeps the original\'s files itself: nothing downloaded for the send');
  });
});

test('Microsoft on 1.217.0: a failed upload removes the Graph draft again; the entry waits for the next try', () => {
  const w = graphWorld({ failPut: true });
  return withMail({ gatecontrol: '1.217.0', fetch: w.fetch }, async (host, c) => {
    const acc = await microsoftAccount(c);
    const big = await host.upload({ id: ANNA.id }, Buffer.from('gross'), 'application/pdf', { bytes: 4 * 1024 * 1024 });
    const d = (await c.as(ANNA)('POST', 'drafts', { accountId: acc.id, to: ['bo@web.de'], subject: 'Plan', attachments: [{ mediaId: big.body.mediaId }] })).json.draft;
    await c.as(ANNA)('POST', `drafts/${d.id}/send`, {});
    await due(host);
    assert.deepEqual(calls(w, 'DELETE', /^\/me\/messages\/[^/]+$/).map((x) => x.path), ['/me/messages/new-1']);
    assert.equal(calls(w, 'POST', /\/send$/).length, 0);
    const o = (await c.as(ANNA)('GET', 'outbox')).json.items[0];
    assert.deepEqual([o.state, o.error], ['waiting', 'unreachable']);
  });
});

test('Microsoft on 1.216.0: files from the device stay refused (attachments_unsupported), Drive goes as a link', () => {
  const w = graphWorld();
  return withMail({ fetch: w.fetch }, async (host, c) => {
    const acc = await microsoftAccount(c);
    const up = await host.upload({ id: ANNA.id }, Buffer.from('x'), 'application/pdf');
    const d = (await c.as(ANNA)('POST', 'drafts', { accountId: acc.id, to: ['x@example.com'], subject: 'Datei', attachments: [{ mediaId: up.body.mediaId }, { driveNodeId: 42, as: 'copy' }] })).json.draft;
    assert.deepEqual(d.attachments.map((x) => x.as), ['copy', 'link']);
    assert.deepEqual(d.warnings.map((x) => x.kind), ['too_large', 'too_large']);
    const r = await c.as(ANNA)('POST', `drafts/${d.id}/send`, {});
    assert.deepEqual([r.status, r.json.error.code], [409, 'attachments_unsupported']);
    assert.match(r.json.error.message, /1\.217/);
  });
});

test('SMTP on 1.217.0: a new account and a new password are checked with gc.mail.smtp.verify; on 1.216.0 not', async () => {
  await withMail({ gatecontrol: '1.217.0' }, async (host, c) => {
    c.mail.login('anna@gmx.de', 'geheim-123', { smtpPass: 'nur-smtp' });
    const r = await c.as(ANNA)('POST', 'accounts', { provider: 'gmx', email: 'anna@gmx.de', password: 'geheim-123' });
    assert.equal(r.status, 409);
    assert.deepEqual([r.json.error.code, r.json.error.server], ['auth_failed', 'smtp']);
    assert.match(r.json.error.message, /SMTP/);
    assert.deepEqual(host.mailVerified.map((x) => [x.host, x.port, x.security, x.user]), [['mail.gmx.net', 465, 'tls', 'anna@gmx.de']]);
    assert.ok(host.mailSessions.every((s) => s.closed), 'the probed IMAP session is closed again');
    assert.deepEqual((await c.as(ANNA)('GET', 'me')).json.accounts, []);
    // a working SMTP login: the account is there
    c.mail.logins.get('anna@gmx.de').smtpPass = null;
    const ok = await c.as(ANNA)('POST', 'accounts', { provider: 'gmx', email: 'anna@gmx.de', password: 'geheim-123' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    // a new password: IMAP and SMTP first
    c.mail.logins.get('anna@gmx.de').pass = 'neu-456';
    c.mail.logins.get('anna@gmx.de').smtpPass = 'smtp-anders';
    const p = await c.as(ANNA)('PATCH', `accounts/${ok.json.account.id}`, { password: 'neu-456' });
    assert.deepEqual([p.status, p.json.error.code, p.json.error.server], [409, 'auth_failed', 'smtp']);
    c.mail.logins.get('anna@gmx.de').smtpPass = null;
    const p2 = await c.as(ANNA)('PATCH', `accounts/${ok.json.account.id}`, { password: 'neu-456' });
    assert.equal(p2.status, 200, JSON.stringify(p2.json));
    assert.equal(host.mailVerified.length, 4);
  });
  await withMail({}, async (host, c) => {
    c.mail.login('anna@gmx.de', 'geheim-123', { smtpPass: 'nur-smtp' });
    const r = await c.as(ANNA)('POST', 'accounts', { provider: 'gmx', email: 'anna@gmx.de', password: 'geheim-123' });
    assert.equal(r.status, 200, 'an older GateControl checks SMTP with the first send');
    assert.deepEqual(host.mailVerified, []);
  });
});

// 1.17.3: an attachment with a type GateControl does not store for Mail (Graph's contentType as it was: message/rfc822,
// text/html, application/json, "unknown/unknown", none) ended in ERR_MEDIA_TYPE — a 500 for the attachment and for
// „In Drive speichern“. Now: its own type when GateControl takes it, else the one of its ending, else octet-stream.
test('storeType: the own type without parameters, else the ending, else application/octet-stream — never a denied one', () => {
  assert.equal(storeType('Rechnung.pdf', 'application/pdf; name="Rechnung.pdf"'), 'application/pdf');
  assert.equal(storeType('Foto.JPG', 'IMAGE/JPEG'), 'image/jpeg');
  assert.equal(storeType('Scan.pdf', 'unknown/unknown'), 'application/pdf');
  assert.equal(storeType('Bild.png', 'binary'), 'image/png');
  assert.equal(storeType('Brief.docx', ''), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(storeType('daten', null), 'application/octet-stream');
  assert.equal(storeType('Weiterleitung.eml', 'message/rfc822'), 'application/octet-stream');
  assert.equal(storeType('seite.htm', 'text/html'), 'application/octet-stream', 'HTML never stored as a page');
  assert.equal(storeType('daten.json', 'application/json'), 'application/octet-stream');
  assert.equal(storeType('logo.svg', 'image/svg+xml'), 'application/octet-stream');
  assert.equal(storeType('termin.ics', 'text/calendar; method=REQUEST'), 'text/calendar');
});

test('Microsoft: attachments with odd or missing types are fetched with a type GateControl takes — suggest and save in Drive answer 200', () => {
  const atts = [
    { id: 'a1', name: 'Weiterleitung.eml', contentType: 'message/rfc822', size: 300, isInline: false },
    { id: 'a2', name: 'seite.htm', contentType: 'text/html', size: 200, isInline: false },
    { id: 'a3', name: 'Scan.pdf', contentType: 'unknown/unknown', size: 400, isInline: false },
    { id: 'a4', name: 'daten', size: 100, isInline: false },
    { id: 'a5', name: 'Beleg.pdf', contentType: 'application/pdf; name="Beleg.pdf"', size: 500, isInline: false },
  ];
  const w = graphWorld({ atts });
  return withMail({ gatecontrol: '1.217.0', fetch: w.fetch }, async (host, c) => {
    await microsoftAccount(c);
    const [s] = (await c.list(ANNA, {})).items;
    const m = (await c.as(ANNA)('GET', `messages/${s.id}`)).json;
    assert.deepEqual(m.attachments.map((t) => t.name), atts.map((t) => t.name));
    for (const t of m.attachments) {
      const r = await c.as(ANNA)('POST', `messages/${s.id}/attachments/${t.id}/drive/suggest`, null, { lang: 'de' });
      assert.equal(r.status, 200, `${t.name}: ${JSON.stringify(r.json)}`);
      assert.equal(r.json.suggestion.folderId, 11);
    }
    const fetched = host.fetches.filter((f) => /\/attachments\/a\d\/\$value$/.test(f.url)).map((f) => [/(a\d)\/\$value$/.exec(f.url)[1], f.opts.mime]);
    assert.deepEqual(fetched, [['a1', 'application/octet-stream'], ['a2', 'application/octet-stream'], ['a3', 'application/pdf'], ['a4', 'application/octet-stream'], ['a5', 'application/pdf']]);
    const eml = m.attachments[0];
    const saved = await c.as(ANNA)('POST', `messages/${s.id}/attachments/${eml.id}/drive/save`, {});
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(c.drive.calls.filter((x) => x.name === 'save_file').pop().payload.name, 'Weiterleitung.eml', 'the name stays');
    // the attachment itself opens too (as a download)
    const got = await c.as(ANNA)('GET', `messages/${s.id}/attachments/${m.attachments[1].id}`);
    assert.deepEqual([got.status, got.json.mime], [200, 'application/octet-stream']);
  });
});

test('Drive takes no file of this type: 415 unsupported_type with its words (de/en), not 500 or "Drive ist nicht erreichbar"', async () => {
  for (const lang of ['de', 'en']) {
    const drive = fakeDrive();
    drive.media = { maxBytes: 104857600, types: ['application/pdf'], quotaDefault: '10GB' };
    await withMail({ drive, lang }, async (host, c) => {
      c.mail.login('anna@gmx.de', 'geheim-123');
      c.mail.mail('anna@gmx.de', 'INBOX', { subject: 'Weitergeleitet', text: 'x', attachments: [{ filename: 'Weiterleitung.eml', contentType: 'message/rfc822', data: 'From: a@example.com' }] });
      await c.addGmx(ANNA);
      await c.tick();
      const [s] = (await c.list(ANNA, {})).items;
      const m = (await c.as(ANNA)('GET', `messages/${s.id}`)).json;
      const r = await c.as(ANNA)('POST', `messages/${s.id}/attachments/${m.attachments[0].id}/drive/suggest`);
      assert.deepEqual([r.status, r.json.error.code], [415, 'unsupported_type']);
      assert.match(r.json.error.message, lang === 'de' ? /Diese Art von Datei/ : /cannot take this kind of file/);
      const sv = await c.as(ANNA)('POST', `messages/${s.id}/attachments/${m.attachments[0].id}/drive/save`, { folderId: 11 });
      assert.deepEqual([sv.status, sv.json.error.code], [415, 'unsupported_type']);
    });
  }
});
