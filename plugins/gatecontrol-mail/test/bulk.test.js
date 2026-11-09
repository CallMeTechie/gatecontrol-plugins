'use strict';

// Mail 1.13.0 „Mehrfachauswahl + Wischaktionen“ (server): copying (IMAP UID COPY, Graph copy; one account only), the
// seven swipe actions beside the old fields (older apps never see a new value there), confirmDelete, undo of a move,
// an archive, a delete and a copy (IMAP with and without new UIDs, Microsoft), `threads: true` (the conversation in its
// folder), `all: true` with `except` and GET messages/ids, the limits; the features of GET me.

const test = require('node:test');
const assert = require('node:assert/strict');
const messages = require('../server/messages');
const { withMail, settle, ANNA, MARC } = require('./helpers');

const CLIENT = { microsoft: { registration: 'custom', customClientId: '11111111-2222-3333-4444-555555555555' } };
const PKCE = { code: 'CODE-OK', codeVerifier: 'v'.repeat(43), redirectUri: 'msauth://com.gatecontrol.client/abc%3D' };
const DAY = 86400000;

/** Five mails in Anna's GMX posteingang (newest last), one in Archiv. */
async function gmx(c, extra) {
  c.mail.login('anna@gmx.de', 'geheim-123', extra || {});
  const now = Date.now();
  ['Eins', 'Zwei', 'Drei', 'Vier', 'Fünf'].forEach((s, i) => c.mail.mail('anna@gmx.de', 'INBOX', { from: { name: 'Tim', address: `tim${i}@example.com` }, subject: s, text: s, date: now - (10 - i) * 60000, messageId: `<m-${s}@example.com>` }));
  c.mail.mail('anna@gmx.de', 'Archiv', { subject: 'Alt', text: 'alt', date: now - 5 * DAY, messageId: '<m-alt@example.com>' });
  const acc = await c.addGmx(ANNA);
  await c.tick();
  const fs = (await c.as(ANNA)('GET', 'folders')).json.accounts.find((x) => x.accountId === acc.id).folders;
  const folder = (role) => fs.find((f) => f.role === role);
  return { acc, fs, folder };
}
const subjects = (box) => [...box.msgs.values()].map((m) => m.envelope.subject).sort();
const bySubject = async (c, q, s) => (await c.list(ANNA, q)).items.find((m) => m.subject === s);

test('features of 1.13.0; settings: seven swipe actions in swipe {left, right}, the old fields only the old four, confirmDelete', () => withMail({}, async (host, c) => {
  const anna = c.as(ANNA);
  const me = (await anna('GET', 'me')).json;
  for (const f of ['copy', 'swipeV2', 'undo', 'bulkAll', 'threadScope']) assert.ok(me.features.includes(f), f);
  assert.deepEqual(me.settings, { threads: true, swipeLeft: 'archive', swipeRight: 'read', swipe: { left: 'archive', right: 'read' }, confirmDelete: false });
  // the new actions: never in swipeLeft / swipeRight (older apps would take an unknown value for „archive“)
  let s = (await anna('PUT', 'settings', { swipe: { left: 'flag', right: 'move' }, confirmDelete: true })).json.settings;
  assert.deepEqual(s, { threads: true, swipeLeft: 'none', swipeRight: 'none', swipe: { left: 'flag', right: 'move' }, confirmDelete: true });
  assert.deepEqual((await anna('GET', 'me')).json.settings, s, 'stored');
  // an old app sends both of its fields back: "none" for a side it cannot show keeps the new action
  s = (await anna('PUT', 'settings', { swipeLeft: 'none', swipeRight: 'delete' })).json.settings;
  assert.deepEqual([s.swipe, s.swipeLeft, s.swipeRight], [{ left: 'flag', right: 'delete' }, 'none', 'delete']);
  // a real choice in an old app counts
  s = (await anna('PUT', 'settings', { swipeLeft: 'archive' })).json.settings;
  assert.deepEqual(s.swipe, { left: 'archive', right: 'delete' });
  // "none" over an old action is a real "none"
  s = (await anna('PUT', 'settings', { swipeRight: 'none' })).json.settings;
  assert.deepEqual([s.swipe.right, s.swipeRight], ['none', 'none']);
  // the old fields take the new values too (stored, shown as none there); swipe wins over them
  s = (await anna('PUT', 'settings', { swipeLeft: 'junk' })).json.settings;
  assert.deepEqual([s.swipe.left, s.swipeLeft], ['junk', 'none']);
  s = (await anna('PUT', 'settings', { swipeLeft: 'delete', swipe: { left: 'read' } })).json.settings;
  assert.deepEqual([s.swipe.left, s.swipeLeft], ['read', 'read']);
  // only what is named changes
  s = (await anna('PUT', 'settings', { confirmDelete: false })).json.settings;
  assert.deepEqual(s, { threads: true, swipeLeft: 'read', swipeRight: 'none', swipe: { left: 'read', right: 'none' }, confirmDelete: false });
  for (const [bad, field] of [[{ swipe: { left: 'fly' } }, 'swipe.left'], [{ swipe: 'flag' }, 'swipe'], [{ swipeRight: 'x' }, 'swipeRight'], [{ confirmDelete: 'yes' }, 'confirmDelete'], [{ swipe: [] }, 'swipe']]) {
    const r = await anna('PUT', 'settings', bad);
    assert.deepEqual([r.status, r.json.error.code, r.json.error.field], [400, 'invalid', field], JSON.stringify(bad));
  }
  // per person
  assert.deepEqual((await c.as(MARC)('GET', 'me')).json.settings.swipe, { left: 'archive', right: 'read' });
}));

test('IMAP: move and undo (with new UIDs) — the same ids back in the posteingang; a token works once, for its person, for two minutes', () => withMail({}, async (host, c) => {
  const anna = c.as(ANNA);
  const { acc, folder } = await gmx(c);
  const list = (await c.list(ANNA, { box: String(acc.id) })).items;
  const pick = list.filter((m) => m.subject === 'Eins' || m.subject === 'Zwei').map((m) => m.id);
  const r = (await anna('POST', 'messages/move', { ids: pick, folderId: folder('archive').id })).json;
  assert.equal(r.ok, true);
  assert.deepEqual([r.count, r.ids.sort()], [2, [...pick].sort()]);
  assert.deepEqual(r.items.map((m) => m.folderId), [folder('archive').id, folder('archive').id]);
  assert.equal(r.undo.kind, 'move');
  assert.equal(r.undo.count, 2);
  assert.ok(r.undo.expiresAt > Date.now() + 100000 && r.undo.expiresAt <= Date.now() + 120000);
  assert.deepEqual(r.undo.items.map((x) => [x.id === x.newId, x.accountId, x.fromFolderId, x.toFolderId]), [[true, acc.id, folder('inbox').id, folder('archive').id], [true, acc.id, folder('inbox').id, folder('archive').id]]);
  assert.deepEqual(subjects(c.mail.box('anna@gmx.de', 'Archiv')), ['Alt', 'Eins', 'Zwei']);
  // someone else's token: not found
  assert.equal((await c.as(MARC)('POST', 'messages/undo', { token: r.undo.token })).status, 404);
  for (const bad of [{}, { token: 'x' }, { token: 7 }]) assert.deepEqual([(await anna('POST', 'messages/undo', bad)).status], [400]);
  const u = (await anna('POST', 'messages/undo', { token: r.undo.token })).json;
  assert.deepEqual([u.ok, u.kind, u.restored, u.failed], [true, 'move', 2, 0]);
  assert.deepEqual(u.items.map((m) => m.id).sort(), [...pick].sort(), 'the same rows');
  assert.deepEqual(u.items.map((m) => m.folderId), [folder('inbox').id, folder('inbox').id]);
  assert.deepEqual(subjects(c.mail.box('anna@gmx.de', 'Archiv')), ['Alt']);
  assert.deepEqual(subjects(c.mail.box('anna@gmx.de', 'INBOX')), ['Drei', 'Eins', 'Fünf', 'Vier', 'Zwei']);
  // once only
  assert.deepEqual([(await anna('POST', 'messages/undo', { token: r.undo.token })).status], [404]);
  // two minutes
  const r2 = (await anna('POST', 'messages/archive', { ids: [pick[0]] })).json;
  assert.equal(r2.undo.kind, 'archive');
  await c.db('UPDATE undo_log SET expires_at = ? WHERE token = ?', [Date.now() - 1, r2.undo.token]);
  const late = await anna('POST', 'messages/undo', { token: r2.undo.token });
  assert.deepEqual([late.status, late.json.error.code], [410, 'undo_expired']);
  // flags and tab: no undo (the client sends the opposite)
  const fl = (await anna('POST', 'messages/flags', { ids: [pick[1]], flagged: true })).json;
  assert.equal(fl.undo, undefined);
  assert.equal(fl.count, 1);
}));

test('IMAP: delete into the trash and undo back to where each came from; in the trash: for good (purged, no undo)', () => withMail({}, async (host, c) => {
  const anna = c.as(ANNA);
  const { acc, folder } = await gmx(c);
  const inbox = (await c.list(ANNA, { box: String(acc.id) })).items;
  const alt = (await c.list(ANNA, { folder: String(folder('archive').id) })).items[0];
  const ids = [inbox.find((m) => m.subject === 'Drei').id, alt.id];
  const r = (await anna('POST', 'messages/delete', { ids })).json;
  assert.deepEqual([r.count, r.purged, r.undo.kind, r.undo.count], [2, [], 'delete', 2]);
  assert.deepEqual(subjects(c.mail.box('anna@gmx.de', 'Papierkorb')), ['Alt', 'Drei']);
  const u = (await anna('POST', 'messages/undo', { token: r.undo.token })).json;
  assert.equal(u.restored, 2);
  assert.deepEqual(subjects(c.mail.box('anna@gmx.de', 'Papierkorb')), []);
  assert.ok(subjects(c.mail.box('anna@gmx.de', 'INBOX')).includes('Drei'));
  assert.deepEqual(subjects(c.mail.box('anna@gmx.de', 'Archiv')), ['Alt'], 'each back into its own folder');
  // deleting in the trash: for good — purged, nothing to take back
  const d1 = (await anna('POST', 'messages/delete', { ids: [ids[0]] })).json;
  const trashed = d1.items[0];
  assert.equal(trashed.folderId, folder('trash').id);
  const d2 = (await anna('POST', 'messages/delete', { ids: [trashed.id] })).json;
  assert.deepEqual([d2.purged, d2.undo, d2.items], [[trashed.id], null, []]);
  assert.deepEqual(subjects(c.mail.box('anna@gmx.de', 'Papierkorb')), []);
}));

test('IMAP without new UIDs (no UIDPLUS): the moved mail is found again by its Message-ID from UIDNEXT on — undo of move and copy', () => withMail({}, async (host, c) => {
  const anna = c.as(ANNA);
  const { acc, folder } = await gmx(c);
  c.mail.noUidPlus = true;
  const vier = await bySubject(c, { box: String(acc.id) }, 'Vier');
  // a mail with the same Message-ID that was in Spam before is never taken along (only uids from UIDNEXT of before on)
  c.mail.mail('anna@gmx.de', 'Spam', { subject: 'Vier (alt)', messageId: '<m-Vier@example.com>' });
  const r = (await anna('POST', 'messages/junk', { ids: [vier.id] })).json;
  assert.deepEqual([r.count, r.items, r.undo.kind, r.undo.items[0].newId], [1, [], 'junk', null], 'the row went (it comes back with the sync)');
  assert.deepEqual(subjects(c.mail.box('anna@gmx.de', 'Spam')), ['Vier', 'Vier (alt)']);
  const u = (await anna('POST', 'messages/undo', { token: r.undo.token })).json;
  assert.deepEqual([u.kind, u.restored, u.failed], ['junk', 1, 0]);
  assert.deepEqual(subjects(c.mail.box('anna@gmx.de', 'Spam')), ['Vier (alt)']);
  assert.ok(subjects(c.mail.box('anna@gmx.de', 'INBOX')).includes('Vier'));
  const back = (await c.list(ANNA, { box: String(acc.id) })).items.find((m) => m.subject === 'Vier');
  assert.ok(back && back.id !== vier.id, 'here again with a new id');
  assert.ok(u.items.some((m) => m.id === back.id), 'the answer names it');
  // copy without COPYUID; undo deletes only the copy (the mail that was in the target before stays)
  c.mail.mail('anna@gmx.de', 'Archiv', { subject: 'Fünf (schon da)', messageId: '<m-Fünf@example.com>' });
  const fuenf = await bySubject(c, { box: String(acc.id) }, 'Fünf');
  const cp = (await anna('POST', 'messages/copy', { ids: [fuenf.id], folderId: folder('archive').id })).json;
  assert.equal(cp.undo.kind, 'copy');
  assert.deepEqual(subjects(c.mail.box('anna@gmx.de', 'Archiv')), ['Alt', 'Fünf', 'Fünf (schon da)']);
  const cu = (await anna('POST', 'messages/undo', { token: cp.undo.token })).json;
  assert.deepEqual([cu.kind, cu.restored, cu.items], ['copy', 1, []]);
  assert.deepEqual(subjects(c.mail.box('anna@gmx.de', 'Archiv')), ['Alt', 'Fünf (schon da)']);
  assert.ok(subjects(c.mail.box('anna@gmx.de', 'INBOX')).includes('Fünf'), 'the original stays');
}));

test('copy: into a folder of the same account (COPYUID), the copies in the answer; undo deletes them; never across accounts', () => withMail({}, async (host, c) => {
  const anna = c.as(ANNA);
  const { acc, folder } = await gmx(c);
  const list = (await c.list(ANNA, { box: String(acc.id) })).items;
  const pick = list.filter((m) => ['Eins', 'Zwei'].includes(m.subject)).map((m) => m.id);
  const r = (await anna('POST', 'messages/copy', { ids: pick, folderId: folder('archive').id })).json;
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.deepEqual(r.items.map((m) => [m.subject, m.folderId]).sort(), [['Eins', folder('archive').id], ['Zwei', folder('archive').id]]);
  assert.ok(r.items.every((m) => !pick.includes(m.id)), 'new rows');
  assert.deepEqual(r.undo.items.map((x) => x.newId).sort(), r.items.map((m) => m.id).sort());
  assert.deepEqual(subjects(c.mail.box('anna@gmx.de', 'Archiv')), ['Alt', 'Eins', 'Zwei']);
  assert.deepEqual(subjects(c.mail.box('anna@gmx.de', 'INBOX')).length, 5, 'the originals stay');
  const u = (await anna('POST', 'messages/undo', { token: r.undo.token })).json;
  assert.deepEqual([u.restored, u.failed], [2, 0]);
  assert.deepEqual(subjects(c.mail.box('anna@gmx.de', 'Archiv')), ['Alt']);
  assert.equal((await c.list(ANNA, { folder: String(folder('archive').id) })).items.length, 1, 'the copies are gone here too');
  // a second account: mail of two accounts or a target of another account → invalid, reason account
  c.mail.login('anna2@web.de', 'geheim-123');
  c.mail.mail('anna2@web.de', 'INBOX', { subject: 'Web', text: 'x' });
  const web = await c.addGmx(ANNA, { email: 'anna2@web.de' });
  await c.tick();
  const webMail = (await c.list(ANNA, { box: String(web.id) })).items[0];
  for (const [path, body] of [['messages/copy', { ids: [pick[0], webMail.id], folderId: folder('archive').id }], ['messages/copy', { ids: [webMail.id], folderId: folder('archive').id }], ['messages/move', { ids: [webMail.id, pick[0]], folderId: folder('archive').id }]]) {
    const x = await anna('POST', path, body);
    assert.deepEqual([x.status, x.json.error.code, x.json.error.field, x.json.error.reason], [400, 'invalid', 'folderId', 'account'], path);
  }
  assert.equal((await anna('POST', 'messages/copy', { ids: pick, folderId: 999999 })).status, 404);
  assert.equal((await anna('POST', 'messages/copy', { ids: pick })).status, 404);
}));

test('threads: true — the conversation in its folder goes along (the row of the conversation view does not come back)', () => withMail({}, async (host, c) => {
  const anna = c.as(ANNA);
  c.mail.login('anna@gmx.de', 'geheim-123');
  const now = Date.now();
  c.mail.mail('anna@gmx.de', 'INBOX', { subject: 'Grillen', text: 'a', messageId: '<g1@x>', date: now - 30000 });
  c.mail.mail('anna@gmx.de', 'INBOX', { subject: 'Re: Grillen', text: 'b', messageId: '<g2@x>', inReplyTo: '<g1@x>', date: now - 20000 });
  c.mail.mail('anna@gmx.de', 'INBOX', { subject: 'Re: Re: Grillen', text: 'c', messageId: '<g3@x>', inReplyTo: '<g2@x>', date: now - 10000 });
  c.mail.mail('anna@gmx.de', 'INBOX', { subject: 'Anderes', text: 'd', messageId: '<o1@x>', date: now - 40000 });
  const acc = await c.addGmx(ANNA);
  await c.tick();
  let list = (await c.list(ANNA, { box: String(acc.id) })).items;
  assert.deepEqual(list.map((m) => [m.subject, m.threadCount]), [['Re: Re: Grillen', 3], ['Anderes', 1]]);
  // without threads: only the newest goes, the next one takes its place
  const r1 = (await anna('POST', 'messages/flags', { ids: [list[0].id], unread: false })).json;
  assert.equal(r1.count, 1);
  // with threads
  const r = (await anna('POST', 'messages/archive', { ids: [list[0].id], threads: true })).json;
  assert.equal(r.count, 3);
  assert.equal(r.undo.count, 3);
  list = (await c.list(ANNA, { box: String(acc.id) })).items;
  assert.deepEqual(list.map((m) => m.subject), ['Anderes']);
  assert.deepEqual(subjects(c.mail.box('anna@gmx.de', 'Archiv')), ['Grillen', 'Re: Grillen', 'Re: Re: Grillen']);
  const u = (await anna('POST', 'messages/undo', { token: r.undo.token })).json;
  assert.equal(u.restored, 3);
  assert.deepEqual((await c.list(ANNA, { box: String(acc.id) })).items.map((m) => m.subject), ['Re: Re: Grillen', 'Anderes']);
  assert.equal((await anna('POST', 'messages/archive', { ids: [list[0].id], threads: 'yes' })).json.error.field, 'threads');
}));

test('all: true — the whole range of a list (every mail, also not loaded), except some; GET messages/ids; the limit', () => withMail({}, async (host, c) => {
  const anna = c.as(ANNA);
  const { acc, folder } = await gmx(c);
  const ids = (await anna('GET', 'messages/ids', null, { box: String(acc.id), tab: 'all' })).json;
  assert.deepEqual([ids.total, ids.ids.length, ids.max, ids.truncated], [5, 5, 2000, false]);
  const fuenf = await bySubject(c, { box: String(acc.id) }, 'Fünf');
  assert.equal(ids.ids[0], fuenf.id, 'newest first');
  const r = (await anna('POST', 'messages/flags', { all: true, box: acc.id, tab: 'all', except: [fuenf.id], unread: false })).json;
  assert.equal(r.count, 4);
  const items = (await c.list(ANNA, { box: String(acc.id) })).items;
  assert.deepEqual(items.filter((m) => m.unread).map((m) => m.subject), ['Fünf']);
  assert.equal([...c.mail.box('anna@gmx.de', 'INBOX').msgs.values()].filter((m) => m.flags.includes('\\Seen')).length, 4, 'on the server too');
  // a folder as the range; move with all
  const mv = (await anna('POST', 'messages/move', { all: true, folder: folder('archive').id, folderId: folder('inbox').id })).json;
  assert.deepEqual([mv.count, mv.undo.count], [1, 1]);
  assert.ok(subjects(c.mail.box('anna@gmx.de', 'INBOX')).includes('Alt'));
  // filters: unread only (Fünf and Alt, which came in from the archive)
  const un = (await anna('GET', 'messages/ids', null, { box: String(acc.id), unread: '1' })).json;
  assert.deepEqual([un.total, un.ids[0], un.ids.length], [2, fuenf.id, 2]);
  // the list's filters in `filter` (unread / flagged at the top are what flags sets): mark the unread ones flagged
  const fu = (await anna('POST', 'messages/flags', { all: true, box: acc.id, filter: { unread: true }, flagged: true })).json;
  assert.equal(fu.count, 2);
  assert.deepEqual((await c.list(ANNA, { box: String(acc.id) })).items.filter((m) => m.flagged).map((m) => m.subject).sort(), ['Alt', 'Fünf']);
  await anna('POST', 'messages/flags', { all: true, box: acc.id, flagged: false });
  // nothing in the range: ok, nothing done
  const none = (await anna('POST', 'messages/archive', { all: true, folder: folder('junk').id })).json;
  assert.deepEqual([none.ok, none.count, none.undo], [true, 0, null]);
  // bad requests
  for (const [body, field] of [[{ all: true, ids: [1] }, 'all'], [{ all: 'yes' }, 'all'], [{ all: true, except: [0] }, 'except'], [{ all: true, except: 'x' }, 'except'], [{ all: true, filter: 'x' }, 'filter']]) {
    const x = await anna('POST', 'messages/archive', body);
    assert.deepEqual([x.status, x.json.error.field], [400, field], JSON.stringify(body));
  }
  assert.equal((await anna('POST', 'messages/archive', { all: true, folder: 999999 })).status, 404);
  // the limit (lowered here): too_large { max, count }; except brings it under
  const keep = messages.bulk.allMax;
  messages.bulk.allMax = 3;
  try {
    const big = await anna('POST', 'messages/archive', { all: true, box: acc.id });
    assert.deepEqual([big.status, big.json.error.code, big.json.error.max, big.json.error.count], [413, 'too_large', 3, 6]);
    const t = (await anna('GET', 'messages/ids', null, { box: String(acc.id) })).json;
    assert.deepEqual([t.ids.length, t.total, t.truncated, t.max], [3, 6, true, 3]);
    const ok = await anna('POST', 'messages/flags', { all: true, box: acc.id, except: t.ids, flagged: true });
    assert.deepEqual([ok.status, ok.json.count], [200, 3]);
  } finally { messages.bulk.allMax = keep; }
}));

/** A stateful fake Microsoft mailbox: folders, messages that move (new id) and copy, delta with @removed. */
function graphWorld() {
  const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const FOLDERS = ['inbox', 'sentitems', 'drafts', 'archive', 'junkemail', 'deleteditems'];
  const w = { msgs: new Map(), seq: 0, calls: [], seen: new Map() };
  const now = Date.now();
  const add = (folder, subject, ago) => {
    const id = `g${++w.seq}`;
    w.msgs.set(id, { id, folder, internetMessageId: `<${subject}@outlook>`, conversationId: `c-${subject}`, subject, bodyPreview: subject,
      from: { emailAddress: { name: 'Chef', address: 'chef@firma.example' } }, toRecipients: [{ emailAddress: { address: 'anna@outlook.com' } }],
      receivedDateTime: new Date(now - ago).toISOString(), isRead: false, flag: { flagStatus: 'notFlagged' }, hasAttachments: false, inferenceClassification: 'focused' });
    return id;
  };
  add('F-inbox', 'Rechnung', 3000);
  add('F-inbox', 'Termin', 2000);
  add('F-inbox', 'Vertrag', 1000);
  const out = (m) => { const { folder, ...rest } = m; return { ...rest, parentFolderId: folder }; };
  w.inFolder = (f) => [...w.msgs.values()].filter((m) => m.folder === f).map((m) => m.subject).sort();
  w.fetch = async (url, o) => {
    const u = new URL(url);
    if (u.host === 'login.microsoftonline.com') {
      const f = o.form || {};
      if (f.grant_type === 'authorization_code') return json(200, { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, id_token: jwt({ email: 'anna@outlook.com', tid: '9188040d-6c67-4c5b-b112-36a304b66dad', name: 'Anna' }) });
      return json(200, { access_token: 'AT-2', expires_in: 3600 });
    }
    const p = u.pathname.replace('/v1.0', '');
    const method = o.method || 'GET';
    w.calls.push({ method, path: p, json: o.json });
    const wk = /^\/me\/mailFolders\/(inbox|sentitems|drafts|archive|junkemail|deleteditems)$/.exec(p);
    if (wk) return json(200, { id: `F-${wk[1]}` });
    if (p === '/me/mailFolders') return json(200, { value: FOLDERS.map((x) => ({ id: `F-${x}`, displayName: x, childFolderCount: 0, totalItemCount: 1, unreadItemCount: 0 })) });
    const latest = /^\/me\/mailFolders\/([^/]+)\/messages$/.exec(p);
    if (latest) return json(200, { value: [...w.msgs.values()].filter((m) => m.folder === latest[1]).map(out) });
    const delta = /^\/me\/mailFolders\/([^/]+)\/messages\/delta$/.exec(p);
    if (delta) {
      const now2 = [...w.msgs.values()].filter((m) => m.folder === delta[1]);
      const before = w.seen.get(delta[1]) || new Set();
      const removed = [...before].filter((id) => !now2.some((m) => m.id === id)).map((id) => ({ id, '@removed': { reason: 'deleted' } }));
      w.seen.set(delta[1], new Set(now2.map((m) => m.id)));
      return json(200, { value: [...now2.map(out), ...removed], '@odata.deltaLink': `https://graph.microsoft.com/v1.0${p}?$deltatoken=t${w.seq}` });
    }
    const act = /^\/me\/messages\/([^/]+)\/(move|copy)$/.exec(p);
    if (act && method === 'POST') {
      const m = w.msgs.get(act[1]);
      if (!m) return json(404, { error: { code: 'ErrorItemNotFound' } });
      const id = `g${++w.seq}`;
      const n = { ...m, id, folder: o.json.destinationId };
      if (act[2] === 'move') w.msgs.delete(m.id);
      w.msgs.set(id, n);
      return json(201, out(n));
    }
    const one = /^\/me\/messages\/([^/]+)$/.exec(p);
    if (one && method === 'DELETE') { w.msgs.delete(one[1]); return { status: 204, headers: {}, body: '' }; }
    if (one && method === 'PATCH') return json(200, {});
    if (one) return json(200, { body: { contentType: 'html', content: '<p>x</p>' }, internetMessageHeaders: [], hasAttachments: false });
    return json(404, { error: { code: 'ErrorItemNotFound' } });
  };
  return w;
}

test('Microsoft: move, delete and copy with undo — the new Graph ids from move / copy, back into the folder it came from', () => {
  const w = graphWorld();
  return withMail({ fetch: w.fetch, settings: CLIENT }, async (host, c) => {
    const anna = c.as(ANNA);
    const acc = (await anna('POST', 'accounts/microsoft', PKCE)).json.account;
    await settle(200);
    await c.tick();
    const fs = (await anna('GET', 'folders')).json.accounts.find((x) => x.accountId === acc.id).folders;
    const folder = (role) => fs.find((f) => f.role === role);
    const list = (await c.list(ANNA, { box: String(acc.id) })).items;
    assert.equal(list.length, 3);
    const vertrag = list.find((m) => m.subject === 'Vertrag');
    const termin = list.find((m) => m.subject === 'Termin');
    // move + undo: the row follows with the new Graph id, the undo moves that id back
    const r = (await anna('POST', 'messages/move', { ids: [vertrag.id], folderId: folder('archive').id })).json;
    assert.deepEqual([r.count, r.items[0].id, r.items[0].folderId, r.undo.items[0].newId], [1, vertrag.id, folder('archive').id, vertrag.id]);
    assert.deepEqual(w.inFolder('F-archive'), ['Vertrag']);
    const moved = [...w.msgs.values()].find((m) => m.subject === 'Vertrag').id;
    const u = (await anna('POST', 'messages/undo', { token: r.undo.token })).json;
    assert.deepEqual([u.restored, u.items.map((m) => [m.id, m.folderId])], [1, [[vertrag.id, folder('inbox').id]]]);
    assert.ok(w.calls.some((x) => x.method === 'POST' && x.path === `/me/messages/${moved}/move` && x.json.destinationId === 'F-inbox'), 'the new id moved back');
    assert.deepEqual(w.inFolder('F-inbox'), ['Rechnung', 'Termin', 'Vertrag']);
    // delete (into deleteditems) + undo
    const d = (await anna('POST', 'messages/delete', { ids: [termin.id] })).json;
    assert.deepEqual(w.inFolder('F-deleteditems'), ['Termin']);
    assert.equal((await anna('POST', 'messages/undo', { token: d.undo.token })).json.restored, 1);
    assert.deepEqual(w.inFolder('F-deleteditems'), []);
    assert.deepEqual(w.inFolder('F-inbox'), ['Rechnung', 'Termin', 'Vertrag']);
    // copy + undo: Graph's copy, the copy's id deleted again
    const cp = (await anna('POST', 'messages/copy', { ids: [vertrag.id], folderId: folder('archive').id })).json;
    assert.deepEqual(w.inFolder('F-archive'), ['Vertrag']);
    assert.deepEqual(w.inFolder('F-inbox'), ['Rechnung', 'Termin', 'Vertrag']);
    assert.equal(cp.undo.kind, 'copy');
    assert.ok(cp.items.length === 1 && cp.items[0].folderId === folder('archive').id && cp.items[0].id !== vertrag.id, 'the copy synced into the answer');
    const cu = (await anna('POST', 'messages/undo', { token: cp.undo.token })).json;
    assert.deepEqual([cu.kind, cu.restored], ['copy', 1]);
    assert.deepEqual(w.inFolder('F-archive'), []);
    assert.ok(w.calls.some((x) => x.method === 'DELETE'), 'the copy deleted');
    assert.equal((await c.list(ANNA, { folder: String(folder('archive').id) })).items.length, 0);
  });
});
