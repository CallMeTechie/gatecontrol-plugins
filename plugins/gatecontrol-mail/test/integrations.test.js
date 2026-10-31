'use strict';

// Drive (suggestion, saving with origin, save all, automatic filing, "Zum Ablegen"), AI (Kurz gesagt, Zu tun, replies,
// family calendar, sorting of unclear mail) and Microsoft (sign-in with code and device code, Graph delta, body, sending).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, ANNA } = require('./helpers');

test('Drive: suggestion, saving with the origin and "Immer für diesen Absender", save all, automatic filing and "Zum Ablegen"', () => withMail({}, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { name: 'Stadtwerke', address: 'rechnung@stadtwerke.example' }, subject: 'Rechnung', text: 'anbei',
    attachments: [{ filename: 'Rechnung.pdf', contentType: 'application/pdf', data: '%PDF-1' }, { filename: 'AGB.pdf', contentType: 'application/pdf', data: '%PDF-2' },
      { filename: 'logo.png', contentType: 'image/png', data: 'png', inline: true, contentId: '<logo@x>' }] });
  const acc = await c.addGmx(ANNA);
  await c.tick();
  const [s] = (await c.list(ANNA, {})).items;
  const m = (await c.as(ANNA)('GET', `messages/${s.id}`)).json;
  const pdf = m.attachments.find((t) => t.name === 'Rechnung.pdf');
  const sg = (await c.as(ANNA)('POST', `messages/${s.id}/attachments/${pdf.id}/drive/suggest`)).json;
  assert.deepEqual([sg.suggestion.folderId, sg.suggestion.reason, sg.duplicate], [11, 'learned', false]);
  const call = c.drive.calls.find((x) => x.name === 'suggest_folder');
  assert.deepEqual([call.user, call.payload.name, call.payload.from.address, call.payload.subject], [ANNA.id, 'Rechnung.pdf', 'rechnung@stadtwerke.example', 'Rechnung']);
  assert.match(call.payload.mediaId, /^[0-9a-f]{32}$/, 'handed over to Drive first');
  assert.equal(host.handOvers[0].to, 'gatecontrol-drive');
  const saved = (await c.as(ANNA)('POST', `messages/${s.id}/attachments/${pdf.id}/drive/save`, { remember: true })).json;
  assert.equal(saved.savedTo.where, 'Meine Dateien › Finanzen › Rechnung.pdf');
  const sf = c.drive.calls.find((x) => x.name === 'save_file');
  assert.equal(sf.payload.mediaId, call.payload.mediaId, 'the same hand-over (within 24 h)');
  assert.deepEqual(sf.payload.source, { plugin: 'gatecontrol-mail', label: sf.payload.source.label, ref: String(s.id) });
  assert.match(sf.payload.source.label, /^Aus Mail von Stadtwerke, \d\d\.\d\d\.$/);
  assert.deepEqual(sf.payload.learn, { from: 'rechnung@stadtwerke.example', always: true });
  assert.equal(sf.payload.folderId, 11);
  const again = (await c.as(ANNA)('GET', `messages/${s.id}`)).json;
  assert.deepEqual(again.attachments.find((t) => t.id === pdf.id).savedTo, saved.savedTo);
  assert.equal((await c.list(ANNA, {})).items[0].savedToDrive, true);
  // save all: the rest (not the inline logo)
  const all = (await c.as(ANNA)('POST', `messages/${s.id}/drive/save-all`)).json;
  assert.deepEqual([all.saved.length, all.failed.length], [1, 0]);
  // automatic filing: sure suggestions are saved, unsure ones wait in "Zum Ablegen", duplicates are left
  await c.as(ANNA)('PATCH', `accounts/${acc.id}`, { attachments: 'auto' });
  let unsure = false;
  c.drive.calls.length = 0;
  const orig = c.drive.service;
  c.drive.service = async (x) => (x.name === 'suggest_folder' && unsure ? { ok: true, suggestion: { folderId: 12, areaId: 'mine:2', path: 'Verträge', where: 'Meine Dateien › Verträge', name: x.payload.name, confidence: 0.6, reason: 'ai' }, sha256Exists: false } : orig(x));
  c.mail.deliver('anna@gmx.de', { from: { address: 'rechnung@stadtwerke.example' }, subject: 'Rechnung Dezember', text: 'x', attachments: [{ filename: 'Dez.pdf', contentType: 'application/pdf', data: '%PDF-3' }] });
  await settle(1200);
  await c.tick();
  assert.ok(c.drive.calls.some((x) => x.name === 'save_file' && x.payload.name === 'Dez.pdf'), 'learned: filed on its own');
  unsure = true;
  c.mail.deliver('anna@gmx.de', { from: { address: 'vertrieb@firma.example' }, subject: 'Vertrag', text: 'x', attachments: [{ filename: 'Vertrag.pdf', contentType: 'application/pdf', data: '%PDF-4' }] });
  await settle(1200);
  await c.tick();
  const filing = (await c.as(ANNA)('GET', 'filing')).json.items;
  assert.deepEqual(filing.map((f) => [f.name, f.suggestion.confidence]), [['Vertrag.pdf', 0.6]]);
  const conf = (await c.as(ANNA)('POST', `filing/${filing[0].id}/confirm`, { folderId: 77 })).json;
  assert.ok(conf.savedTo.nodeId);
  assert.equal(c.drive.calls.filter((x) => x.name === 'save_file').pop().payload.folderId, 77);
  assert.deepEqual((await c.as(ANNA)('GET', 'filing')).json.items, []);
  // the pickers of the portal
  assert.equal((await c.as(ANNA)('GET', 'drive/browse', null, { folder: '5' })).json.items[0].name, 'Angebot.pdf');
  assert.equal((await c.as(ANNA)('GET', 'drive/areas')).json.areas[0].kind, 'mine');
}));

test('Drive missing or without a seat: no feature, the calls answer drive_unavailable / forbidden', () => withMail({ drive: false }, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  c.mail.mail('anna@gmx.de', 'INBOX', { subject: 'A', text: 'x', attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', data: '%PDF' }] });
  await c.addGmx(ANNA);
  await c.tick();
  assert.ok(!(await c.as(ANNA)('GET', 'me')).json.features.includes('drive'));
  const [s] = (await c.list(ANNA, {})).items;
  const m = (await c.as(ANNA)('GET', `messages/${s.id}`)).json;
  assert.equal((await c.as(ANNA)('POST', `messages/${s.id}/attachments/${m.attachments[0].id}/drive/suggest`)).json.error.code, 'drive_unavailable');
}));

function aiOpts(extra) {
  return {
    extract: async (req) => {
      if (req.task === 'mail_sort') return { tab: /angebot|sale/i.test(JSON.stringify(req.input)) ? 'other' : 'relevant' };
      assert.equal(req.task, 'mail_assist');
      const short = req.input.some((x) => x.label === 'Note');
      return {
        summary: short ? 'zu kurz' : 'Rechnung über 84,20 € für Strom im Oktober, Abbuchung am 28.11.',
        todos: [{ kind: 'deadline', text: 'Abbuchung prüfen', date: '2026-11-28', time: null, amount: 84.2, currency: 'eur' }, { kind: 'task', text: 'Zählerstand melden', date: null }],
        replies: [{ label: 'Danke', text: 'Danke, ist angekommen.' }],
      };
    },
    ...(extra || {}),
  };
}

test('AI: Kurz gesagt, Zu tun, replies; short mail without summary; into the family calendar; off per account and for business accounts', () => withMail({ ai: aiOpts() }, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { address: 'rechnung@stadtwerke.example' }, subject: 'Rechnung', text: 'Sehr geehrte Kundin, '.repeat(40) });
  c.mail.mail('anna@gmx.de', 'INBOX', { from: { address: 'tim@example.com' }, subject: 'Kurz', text: 'Passt.' });
  const acc = await c.addGmx(ANNA);
  await c.tick();
  assert.ok((await c.as(ANNA)('GET', 'me')).json.features.includes('ai'));
  const [kurz, lang] = (await c.list(ANNA, { tab: 'all' })).items;
  assert.deepEqual((await c.as(ANNA)('GET', `ai/${lang.id}`)).json, { status: 'none' });
  const r = (await c.as(ANNA)('POST', `ai/${lang.id}`)).json;
  assert.equal(r.status, 'done');
  assert.match(r.summary, /84,20/);
  assert.deepEqual(r.todos[0], { kind: 'deadline', text: 'Abbuchung prüfen', date: '2026-11-28', amount: 84.2, currency: 'EUR' });
  assert.deepEqual(r.replies, [{ label: 'Danke', text: 'Danke, ist angekommen.' }]);
  assert.deepEqual((await c.as(ANNA)('GET', `ai/${lang.id}`)).json, r);
  assert.equal((await c.list(ANNA, { tab: 'all' })).items.find((x) => x.id === lang.id).ai.summary, r.summary);
  assert.equal((await c.as(ANNA)('POST', `ai/${kurz.id}`)).json.summary, null, 'short mail: no summary');
  // a result that is there is answered without asking again; two runs at once share one request; again: true asks anew
  const n0 = host.aiRequests.filter((x) => x.task === 'mail_assist').length;
  assert.deepEqual((await c.as(ANNA)('POST', `ai/${lang.id}`)).json, r);
  assert.equal(host.aiRequests.filter((x) => x.task === 'mail_assist').length, n0);
  await Promise.all([c.as(ANNA)('POST', `ai/${lang.id}`, { again: true }), c.as(ANNA)('POST', `ai/${lang.id}`, { again: true })]);
  assert.equal(host.aiRequests.filter((x) => x.task === 'mail_assist').length, n0 + 1);
  const req = host.aiRequests.find((x) => x.task === 'mail_assist');
  assert.equal(req.user, ANNA.id);
  assert.ok(req.input.every((x) => x.type === 'text'), 'text first, never a picture of a mail with text');
  // a deadline into the family calendar
  const w = (await c.as(ANNA)('POST', `ai/${lang.id}/todo/0`, { action: 'family_calendar' })).json;
  assert.match(w.where, /Familienkalender · 28\.11\.2026/);
  assert.deepEqual(c.familie.calls[0], { name: 'calendar_add', user: ANNA.id, payload: { userId: ANNA.id, title: 'Abbuchung prüfen', startsAt: '2026-11-28', allDay: true } });
  assert.equal((await c.as(ANNA)('POST', `ai/${lang.id}/todo/1`, { action: 'family_calendar' })).json.error.code, 'invalid', 'no date');
  // off for the account, and for business accounts when the administrator blocks them
  await c.as(ANNA)('PATCH', `accounts/${acc.id}`, { ai: false });
  assert.equal((await c.as(ANNA)('POST', `ai/${lang.id}`)).json.error.code, 'ai_off');
  await c.as(ANNA)('PATCH', `accounts/${acc.id}`, { ai: true, kind: 'business' });
  await c.admin('PUT', 'admin/settings', { ai: { blockBusiness: true } });
  assert.equal((await c.as(ANNA)('POST', `ai/${lang.id}`)).json.error.code, 'ai_off');
  await c.admin('PUT', 'admin/settings', { ai: { bar: false } });
  assert.ok(!(await c.as(ANNA)('GET', 'me')).json.features.includes('ai'));
}));

test('AI sorting: unclear new mail goes to the AI in the background, a sure rule never', () => withMail({ ai: aiOpts() }, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  await c.addGmx(ANNA);
  await c.tick();
  c.mail.deliver('anna@gmx.de', { from: { address: 'shop@example.com' }, subject: 'Großer Sale', text: 'Jetzt 50 % sparen' });
  c.mail.deliver('anna@gmx.de', { from: { address: 'news@shop.example' }, subject: 'Newsletter', text: 'x', headers: { 'list-id': '<n>' } });
  await settle(1200);
  await c.tick();
  const other = (await c.list(ANNA, { tab: 'other' })).items.map((m) => m.subject).sort();
  assert.deepEqual(other, ['Großer Sale', 'Newsletter']);
  assert.equal(host.aiRequests.filter((x) => x.task === 'mail_sort').length, 1, 'the newsletter was sure without AI');
}));

function microsoftWorld() {
  const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const st = { polls: 0, sent: [], patched: [], token: 'AT-1', messages: [] };
  const MSG = (id, o) => ({ id, internetMessageId: `<${id}@outlook>`, conversationId: o.conv || id, subject: o.subject, bodyPreview: o.preview || '', from: { emailAddress: { name: o.from, address: o.addr } },
    toRecipients: [{ emailAddress: { address: 'anna@outlook.com' } }], receivedDateTime: new Date(o.date || Date.now()).toISOString(), isRead: false, flag: { flagStatus: 'notFlagged' }, hasAttachments: false, inferenceClassification: o.other ? 'other' : 'focused' });
  st.messages.push(MSG('g1', { subject: 'Hallo aus Outlook', from: 'Chef', addr: 'chef@firma.example', preview: 'Bitte bis Montag' }));
  st.messages.push(MSG('g2', { subject: 'Dein wöchentlicher Bericht', from: 'Microsoft', addr: 'no-reply@microsoft.example', other: true }));
  const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  st.fetch = async (url, o) => {
    const u = new URL(url);
    if (u.host === 'login.microsoftonline.com') {
      const f = o.form || {};
      if (u.pathname.endsWith('/devicecode')) return json(200, { device_code: 'DEV-SECRET', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 });
      if (f.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        if (st.polls++ === 0) return json(400, { error: 'authorization_pending' });
        return json(200, { access_token: 'AT-D', refresh_token: 'RT-D', expires_in: 3600, id_token: jwt({ preferred_username: 'chef@firma.example', tid: 'tenant-firma', name: 'Chef' }) });
      }
      if (f.grant_type === 'authorization_code') {
        if (f.code !== 'CODE-OK') return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: st.token, refresh_token: 'RT-1', expires_in: 3600, id_token: jwt({ email: 'anna@outlook.com', tid: '9188040d-6c67-4c5b-b112-36a304b66dad', name: 'Anna' }) });
      }
      if (f.grant_type === 'refresh_token') return json(200, { access_token: 'AT-2', expires_in: 3600 });
      return json(400, { error: 'unsupported' });
    }
    assert.equal(u.host, 'graph.microsoft.com');
    assert.match(o.headers.authorization, /^Bearer AT-/);
    const p = u.pathname.replace('/v1.0', '');
    const wk = /^\/me\/mailFolders\/(inbox|sentitems|drafts|archive|junkemail|deleteditems)$/.exec(p);
    if (wk) return json(200, { id: `F-${wk[1]}` });
    if (p === '/me/mailFolders') return json(200, { value: ['inbox', 'sentitems', 'drafts', 'archive', 'junkemail', 'deleteditems'].map((x) => ({ id: `F-${x}`, displayName: x, childFolderCount: 0, totalItemCount: 1, unreadItemCount: 0 })) });
    if (/\/messages\/delta$/.test(p)) return json(200, { value: p.includes('F-inbox') ? st.messages : [], '@odata.deltaLink': `https://graph.microsoft.com/v1.0${p}?$deltatoken=t1` });
    const one = /^\/me\/messages\/([^/]+)$/.exec(p);
    if (one && o.method === 'GET') return json(200, { body: { contentType: 'html', content: '<p>Bitte bis Montag</p>' }, internetMessageHeaders: [], hasAttachments: false });
    if (one && o.method === 'PATCH') { st.patched.push({ id: one[1], body: o.json }); return json(200, {}); }
    if (p === '/me/sendMail') { st.sent.push(o.json); return { status: 202, headers: {}, body: '' }; }
    const act = /^\/me\/messages\/([^/]+)\/(createReply|createReplyAll|createForward|send)$/.exec(p);
    if (act) { if (act[2] === 'send') { st.sent.push({ sendDraft: act[1] }); return { status: 202, headers: {}, body: '' }; } return json(201, { id: `draft-${act[1]}` }); }
    return json(404, { error: { code: 'ErrorItemNotFound' } });
  };
  return st;
}

test('Microsoft: off with „Eigene“ and no client id; code sign-in (PKCE), Graph delta, body, sorting by Focused/Other, flags, sending; device code', async () => {
  const w = microsoftWorld();
  await withMail({ fetch: w.fetch }, async (host, c) => {
    const pkce = { codeVerifier: 'v'.repeat(43), redirectUri: 'msauth://com.gatecontrol.client/abc%3D' };
    // 1.3.2: the publisher's registration is the default; off only with „Eigene“ and no client id
    await c.admin('PUT', 'admin/settings', { microsoft: { registration: 'custom', customClientId: null } });
    assert.equal((await c.as(ANNA)('POST', 'accounts/microsoft', { code: 'CODE-OK', ...pkce })).json.error.code, 'microsoft_off');
    await c.admin('PUT', 'admin/settings', { microsoft: { registration: 'custom', customClientId: '11111111-2222-3333-4444-555555555555' } });
    assert.equal((await c.as(ANNA)('POST', 'accounts/microsoft', { code: 'BAD', ...pkce })).json.error.code, 'auth_failed');
    assert.equal((await c.as(ANNA)('POST', 'accounts/microsoft', { code: 'CODE-OK', ...pkce, redirectUri: 'https://evil.example/' })).json.error.code, 'invalid');
    const acc = (await c.as(ANNA)('POST', 'accounts/microsoft', { code: 'CODE-OK', ...pkce })).json.account;
    assert.deepEqual([acc.provider, acc.email, acc.kind], ['outlook', 'anna@outlook.com', 'personal']);
    const tokenCall = host.fetches.find((f) => f.opts.form && f.opts.form.grant_type === 'authorization_code');
    assert.deepEqual([tokenCall.opts.form.client_id, tokenCall.opts.form.code_verifier, tokenCall.opts.form.redirect_uri], ['11111111-2222-3333-4444-555555555555', 'v'.repeat(43), pkce.redirectUri]);
    assert.ok(!tokenCall.opts.form.client_secret, 'a public client');
    await settle(200);
    await c.tick();
    const rel = (await c.list(ANNA, { tab: 'relevant' })).items;
    assert.deepEqual(rel.map((m) => m.subject), ['Hallo aus Outlook']);
    assert.deepEqual((await c.list(ANNA, { tab: 'other' })).items.map((m) => m.subject), ['Dein wöchentlicher Bericht']);
    const m = (await c.as(ANNA)('GET', `messages/${rel[0].id}`)).json;
    assert.equal(m.html, '<p>Bitte bis Montag</p>');
    await c.as(ANNA)('POST', 'messages/flags', { ids: [m.id], unread: false });
    assert.deepEqual(w.patched[0], { id: 'g1', body: { isRead: true } });
    // a reply goes through Graph's own reply (threading)
    const d = (await c.as(ANNA)('POST', 'drafts', { mode: 'reply', replyTo: m.id })).json.draft;
    await c.as(ANNA)('POST', `drafts/${d.id}/send`, {});
    await host.gc.db.run("UPDATE outbox SET send_at = 0");
    await host.tick();
    assert.deepEqual(w.sent[0], { sendDraft: 'draft-g1' });
    assert.equal(w.patched.find((x) => x.id === 'draft-g1').body.toRecipients[0].emailAddress.address, 'chef@firma.example');
    // a file from the device cannot go through Graph
    const up = await host.upload({ id: ANNA.id }, Buffer.from('x'), 'application/pdf');
    const d2 = (await c.as(ANNA)('POST', 'drafts', { to: ['x@example.com'], subject: 'Datei', attachments: [{ mediaId: up.body.mediaId }] })).json.draft;
    assert.ok(d2.warnings.some((x) => x.kind === 'too_large'));
    assert.equal((await c.as(ANNA)('POST', `drafts/${d2.id}/send`, {})).json.error.code, 'attachments_unsupported');
    // the device code (portal)
    const dev = (await c.as(ANNA)('POST', 'accounts/microsoft/device', { kind: 'business' })).json;
    assert.deepEqual([dev.userCode, dev.verificationUri, dev.interval], ['ABCD-EFGH', 'https://microsoft.com/devicelogin', 5]);
    assert.ok(!JSON.stringify(dev).includes('DEV-SECRET'), 'the device code stays on the server');
    assert.equal((await c.as(ANNA)('GET', `accounts/microsoft/device/${dev.deviceId}`)).json.status, 'pending', 'not before the interval');
    await host.gc.db.run('UPDATE ms_device SET next_at = 0');
    assert.equal((await c.as(ANNA)('GET', `accounts/microsoft/device/${dev.deviceId}`)).json.status, 'pending');
    await host.gc.db.run('UPDATE ms_device SET next_at = 0');
    const done = (await c.as(ANNA)('GET', `accounts/microsoft/device/${dev.deviceId}`)).json;
    assert.deepEqual([done.status, done.account.provider, done.account.email, done.account.kind], ['done', 'm365', 'chef@firma.example', 'business']);
    assert.ok(!JSON.stringify(await c.db('SELECT * FROM accounts')).includes('RT-'), 'refresh tokens are secrets');
  });
});
