'use strict';

// Mail 1.1.2: what a person waits for never waits behind a sync. A long first sync (Microsoft: a delta round that hangs;
// IMAP: a sync step that hangs) — opening a mail, an attachment, flags answer at once (Graph beside the account's line,
// IMAP on a short session of its own); a body that takes long comes with bodyMissing and the live event follows;
// an attachment that takes long answers 409 busy and asking again joins the download; the access token is renewed once
// for everyone who asks at the same time.

const test = require('node:test');
const assert = require('node:assert/strict');
const messages = require('../server/messages');
const { withMail, settle, ANNA } = require('./helpers');

const CLIENT = { microsoft: { registration: 'custom', customClientId: '11111111-2222-3333-4444-555555555555' } };
const PKCE = { code: 'CODE-OK', codeVerifier: 'v'.repeat(43), redirectUri: 'msauth://com.gatecontrol.client/abc%3D' };
const DAY = 86400000;

/** A gate: { wait (a promise), open() }. */
function gate() {
  let open;
  const wait = new Promise((r) => { open = r; });
  return { wait, open };
}

/** Ask `fn` until it is true (≤ ms). */
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
}

/** A fake Microsoft: the token endpoint (renewals counted, may hang), Graph (delta, bodies, attachments may hang). */
function graphWorld() {
  const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const now = Date.now();
  const MSG = (id, subject, ago, att) => ({
    id, internetMessageId: `<${id}@outlook>`, conversationId: `c-${id}`, subject, bodyPreview: `Vorschau ${subject}`,
    from: { emailAddress: { name: 'Chef', address: 'chef@firma.example' } }, toRecipients: [{ emailAddress: { address: 'anna@outlook.com' } }],
    receivedDateTime: new Date(now - ago).toISOString(), isRead: false, flag: { flagStatus: 'notFlagged' }, hasAttachments: !!att, inferenceClassification: 'focused',
  });
  const w = {
    messages: [MSG('g1', 'Vertrag', 1000, true), MSG('g2', 'Termin', 2 * DAY), MSG('g3', 'Rechnung', 3 * DAY)],
    deltaGate: null, deltaHeld: 0, bodyGate: null, bodyCalls: {}, fileGate: null, downloads: 0, patched: [],
    renewGate: null, renewals: 0, reject: null, unauthorized: 0, tokens: [],
  };
  w.fetch = async (url, o) => {
    const u = new URL(url);
    if (u.host === 'login.microsoftonline.com') {
      const f = o.form || {};
      if (f.grant_type === 'authorization_code') return json(200, { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, id_token: jwt({ email: 'anna@outlook.com', tid: '9188040d-6c67-4c5b-b112-36a304b66dad', name: 'Anna' }) });
      if (f.grant_type === 'refresh_token') {
        w.renewals++;
        if (w.renewGate) await w.renewGate.wait;
        return json(200, { access_token: `AT-${w.renewals + 1}`, refresh_token: `RT-${w.renewals + 1}`, expires_in: 3600 });
      }
      return json(400, { error: 'unsupported' });
    }
    assert.equal(u.host, 'graph.microsoft.com');
    const token = String((o.headers || {}).authorization || '').replace(/^Bearer /, '');
    w.tokens.push(token);
    if (w.reject && token === w.reject) { w.unauthorized++; return json(401, { error: { code: 'InvalidAuthenticationToken' } }); }
    const p = u.pathname.replace('/v1.0', '');
    const wk = /^\/me\/mailFolders\/(inbox|sentitems|drafts|archive|junkemail|deleteditems)$/.exec(p);
    if (wk) return json(200, { id: `F-${wk[1]}` });
    if (p === '/me/mailFolders') return json(200, { value: ['inbox', 'sentitems', 'drafts', 'archive', 'junkemail', 'deleteditems'].map((x) => ({ id: `F-${x}`, displayName: x, childFolderCount: 0, totalItemCount: 3, unreadItemCount: 3 })) });
    // the newest of the posteingang (the first step of a first sync)
    if (p === '/me/mailFolders/F-inbox/messages') {
      assert.match(decodeURIComponent(u.search), /\$orderby=receivedDateTime desc/);
      return json(200, { value: [...w.messages].sort((x, y) => Date.parse(y.receivedDateTime) - Date.parse(x.receivedDateTime)).slice(0, Number(u.searchParams.get('$top')) || 10) });
    }
    if (/\/messages\/delta$/.test(p)) {
      if (p.includes('F-inbox') && w.deltaGate) { w.deltaHeld++; await w.deltaGate.wait; }
      return json(200, { value: p.includes('F-inbox') ? w.messages : [], '@odata.deltaLink': `https://graph.microsoft.com/v1.0${p}?$deltatoken=t1` });
    }
    const file = /^\/me\/messages\/([^/]+)\/attachments\/([^/]+)\/\$value$/.exec(p);
    if (file) {
      w.downloads++;
      if (w.fileGate) await w.fileGate.wait;
      return { status: 200, headers: { 'content-type': 'application/pdf' }, body: Buffer.from('%PDF-vertrag') };
    }
    const atts = /^\/me\/messages\/([^/]+)\/attachments$/.exec(p);
    if (atts) return json(200, { value: atts[1] === 'g1' ? [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', name: 'Vertrag.pdf', contentType: 'application/pdf', size: 12, isInline: false }] : [] });
    const one = /^\/me\/messages\/([^/]+)$/.exec(p);
    if (one && (o.method || 'GET') === 'GET') {
      w.bodyCalls[one[1]] = (w.bodyCalls[one[1]] || 0) + 1;
      if (w.bodyGate) await w.bodyGate.wait;
      const m = w.messages.find((x) => x.id === one[1]);
      return json(200, { body: { contentType: 'html', content: `<p>Hallo – ${m ? m.subject : '?'}</p>` }, internetMessageHeaders: [], hasAttachments: !!(m && m.hasAttachments) });
    }
    if (one && o.method === 'PATCH') { w.patched.push({ id: one[1], body: o.json }); return json(200, {}); }
    return json(404, { error: { code: 'ErrorItemNotFound' } });
  };
  return w;
}

async function microsoft(c) {
  const r = await c.as(ANNA)('POST', 'accounts/microsoft', PKCE);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.account;
}

const bySubject = async (c, subject) => (await c.list(ANNA)).items.find((m) => m.subject === subject);

async function timed(fn) {
  const t0 = Date.now();
  const out = await fn();
  return { out, ms: Date.now() - t0 };
}

test('Microsoft: the first sync hangs in its delta round — the newest mail is listed, opening it, its attachment and flags answer at once', () => {
  const w = graphWorld();
  return withMail({ fetch: w.fetch, settings: CLIENT }, async (host, c) => {
    w.deltaGate = gate();
    await microsoft(c);
    // the newest mail of the posteingang first: the list is there while the delta round still hangs
    await until(async () => (await c.list(ANNA)).items.length === 3);
    await until(() => w.deltaHeld >= 1);
    const m1 = await bySubject(c, 'Vertrag');
    const open = await timed(() => c.as(ANNA)('GET', `messages/${m1.id}`));
    assert.equal(open.out.status, 200, JSON.stringify(open.out.json));
    assert.ok(open.ms < 1000, `opened in ${open.ms} ms`);
    assert.equal(open.out.json.bodyMissing, false);
    assert.match(open.out.json.html, /Hallo – Vertrag/);
    const file = await timed(() => c.as(ANNA)('GET', `messages/${m1.id}/attachments/${open.out.json.attachments[0].id}`));
    assert.equal(file.out.status, 200, JSON.stringify(file.out.json));
    assert.ok(file.ms < 1000 && file.out.json.mediaId);
    const flags = await timed(() => c.as(ANNA)('POST', 'messages/flags', { ids: [m1.id], unread: false }));
    assert.equal(flags.out.status, 200);
    assert.ok(flags.ms < 1000);
    assert.deepEqual(w.patched, [{ id: 'g1', body: { isRead: true } }]);
    assert.equal(w.deltaHeld, 1, 'the delta round still hangs');
    w.deltaGate.open();
    await settle(300);
    await until(async () => (await c.db('SELECT first_done FROM accounts'))[0].first_done === 1);
    assert.equal((await c.list(ANNA)).items.length, 3, 'the delta round brings the same mail — no doubles');
  });
});

test('IMAP: a sync step hangs — a body and an attachment come on a short session of their own (closed after); a free line uses its session', () => withMail({}, async (host, c) => {
  c.mail.login('anna@gmx.de', 'geheim-123');
  c.mail.mail('anna@gmx.de', 'INBOX', { subject: 'Mit Anhang', text: 'anbei', date: Date.now() - 3 * DAY, attachments: [{ filename: 'Beleg.pdf', contentType: 'application/pdf', data: '%PDF-beleg' }] });
  c.mail.mail('anna@gmx.de', 'INBOX', { subject: 'Zweite', text: 'Text zwei', date: Date.now() - 2 * DAY });
  c.mail.mail('anna@gmx.de', 'INBOX', { subject: 'Dritte', text: 'Text drei', date: Date.now() - DAY });
  await c.addGmx(ANNA);
  await c.tick();
  await host.gc.db.run('DELETE FROM attachments');
  await host.gc.db.run('DELETE FROM bodies');
  await host.gc.db.run("UPDATE messages SET body_state = 'none'");
  // the line is free: its own session, no other
  const before = host.mailSessions.length;
  const third = await bySubject(c, 'Dritte');
  assert.equal((await c.as(ANNA)('GET', `messages/${third.id}`)).json.text, 'Text drei');
  assert.equal(host.mailSessions.length, before, 'no session more');
  // new mail arrives, its sync step hangs at the server
  let release;
  c.mail.hold = new Promise((r) => { release = r; });
  c.mail.deliver('anna@gmx.de', { subject: 'Neu', text: 'neu' });
  await until(() => c.mail.held >= 1);
  const second = await bySubject(c, 'Zweite');
  const open = await timed(() => c.as(ANNA)('GET', `messages/${second.id}`));
  assert.ok(open.ms < 1000, `opened in ${open.ms} ms`);
  assert.equal(open.out.json.bodyMissing, false);
  assert.equal(open.out.json.text, 'Text zwei');
  const withFile = await bySubject(c, 'Mit Anhang');
  const full = (await c.as(ANNA)('GET', `messages/${withFile.id}`)).json;
  const file = await timed(() => c.as(ANNA)('GET', `messages/${withFile.id}/attachments/${full.attachments[0].id}`));
  assert.equal(file.out.status, 200, JSON.stringify(file.out.json));
  assert.ok(file.ms < 1000);
  assert.equal(host.media.get(file.out.json.mediaId).data.toString(), '%PDF-beleg');
  const side = host.mailSessions.slice(before);
  assert.equal(side.length, 3, 'a short session for each');
  assert.ok(side.every((x) => x.closed), 'and closed again');
  assert.ok(side.every((x) => !x.calls.some((k) => k.method === 'idle' || (k.method === 'open' && k.args[1] && k.args[1].readOnly === false))), 'read only, no IDLE');
  // flags go first in the line: right after the step
  const flags = c.as(ANNA)('POST', 'messages/flags', { ids: [second.id], flagged: true });
  await settle(100);
  release();
  assert.equal((await flags).status, 200);
  c.mail.hold = null;
  await settle(200);
  assert.ok(c.mail.box('anna@gmx.de', 'INBOX').msgs.get(2).flags.includes('\\Flagged'));
  assert.ok((await c.list(ANNA)).items.some((m) => m.subject === 'Neu'));
  assert.equal(host.mailSessions.filter((x) => !x.closed).length, 1, 'only the account\'s own session stays');
}));

test('a body that takes long: bodyMissing at once, the live event with the messageId follows; a slow attachment answers 409 busy, asking again joins it', () => {
  const w = graphWorld();
  const keep = { ...messages.timing };
  messages.timing.bodyMs = 150;
  messages.timing.fileMs = 150;
  return withMail({ fetch: w.fetch, settings: CLIENT }, async (host, c) => {
    const acc = await microsoft(c);
    await settle(200);
    await c.tick();
    await host.gc.db.run('DELETE FROM attachments');
    await host.gc.db.run('DELETE FROM bodies');
    await host.gc.db.run("UPDATE messages SET body_state = 'none'");
    w.bodyCalls = {};
    const m2 = await bySubject(c, 'Termin');
    w.bodyGate = gate();
    const first = await timed(() => c.as(ANNA)('GET', `messages/${m2.id}`));
    assert.equal(first.out.status, 200);
    assert.ok(first.ms < 1000, `answered in ${first.ms} ms`);
    assert.equal(first.out.json.bodyMissing, true);
    assert.equal(first.out.json.html, null);
    assert.equal(first.out.json.text, 'Vorschau Termin', 'the snippet meanwhile');
    // asked again while it loads: the same load
    assert.equal((await c.as(ANNA)('GET', `messages/${m2.id}`)).json.bodyMissing, true);
    // a conversation waits the same way (the thread's event follows too)
    const th = (await c.as(ANNA)('GET', `threads/${first.out.json.threadId}`)).json;
    assert.equal(th.items[0].bodyMissing, true);
    assert.equal(w.bodyCalls.g2, 1, 'loaded once');
    const mark = host.events.length;
    w.bodyGate.open();
    await until(() => host.events.slice(mark).some((e) => e.type === 'mail' && e.data.messageId === m2.id));
    const ev = host.events.slice(mark).find((e) => e.data.messageId === m2.id);
    assert.deepEqual(ev.users, [ANNA.id]);
    assert.equal(ev.data.kind, 'changed');
    assert.equal(ev.data.accountId, acc.id);
    assert.ok(ev.data.folderId);
    await until(() => host.events.slice(mark).some((e) => e.data.threadId === first.out.json.threadId));
    const again = (await c.as(ANNA)('GET', `messages/${m2.id}`)).json;
    assert.equal(again.bodyMissing, false);
    assert.match(again.html, /Hallo – Termin/);
    assert.equal(w.bodyCalls.g2, 1);
    w.bodyGate = null;
    // an attachment that takes long
    const m1 = await bySubject(c, 'Vertrag');
    const full = (await c.as(ANNA)('GET', `messages/${m1.id}`)).json;
    const downloads = w.downloads;
    w.fileGate = gate();
    const path = `messages/${m1.id}/attachments/${full.attachments[0].id}`;
    const busy = await timed(() => c.as(ANNA)('GET', path));
    assert.ok(busy.ms < 1000);
    assert.equal(busy.out.status, 409);
    assert.equal(busy.out.json.error.code, 'busy');
    assert.equal(busy.out.json.error.reason, 'loading');
    assert.equal(busy.out.json.error.retryAfter, 5);
    assert.equal((await c.as(ANNA)('GET', path)).status, 409);
    assert.equal(w.downloads, downloads + 1, 'asking again joins the download');
    const mark2 = host.events.length;
    w.fileGate.open();
    await until(() => host.events.slice(mark2).some((e) => e.data.attachmentId === full.attachments[0].id && e.data.messageId === m1.id));
    const ok = await c.as(ANNA)('GET', path);
    assert.equal(ok.status, 200);
    assert.ok(ok.json.mediaId);
    assert.equal(w.downloads, downloads + 1);
  }).finally(() => Object.assign(messages.timing, keep));
});

test('Microsoft: the access token is renewed once for everyone who asks at the same time (a 401 to several requests)', () => {
  const w = graphWorld();
  return withMail({ fetch: w.fetch, settings: CLIENT }, async (host, c) => {
    await microsoft(c);
    await settle(200);
    await c.tick();
    await host.gc.db.run('DELETE FROM bodies');
    await host.gc.db.run("UPDATE messages SET body_state = 'none'");
    assert.equal(w.renewals, 0, 'the token of the sign-in is used first');
    const items = (await c.list(ANNA)).items;
    // Microsoft ends the token: every request with it gets 401
    w.reject = 'AT-1';
    w.renewGate = gate();
    const asks = [
      ...items.map((m) => c.as(ANNA)('GET', `messages/${m.id}`)),
      c.as(ANNA)('POST', 'messages/flags', { ids: [items[0].id], flagged: true }),
      host.tick(),
    ];
    await until(() => w.renewals >= 1);
    await settle(100);
    w.renewGate.open();
    const out = await Promise.all(asks);
    for (const r of out.slice(0, items.length)) {
      assert.equal(r.status, 200);
      assert.equal(r.json.bodyMissing, false);
    }
    assert.equal(out[items.length].status, 200);
    assert.equal(w.renewals, 1, 'one renewal for all');
    assert.ok(w.unauthorized >= 2, 'several requests had the old token');
    assert.ok(w.tokens.slice(-3).every((t) => t === 'AT-2'), 'all go on with the renewed token');
    assert.equal(w.renewals, 1);
  });
});
