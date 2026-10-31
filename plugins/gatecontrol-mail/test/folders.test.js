'use strict';

// Mail 1.3.3: the folder tree of GET folders — `name` the folder's own name, `parentId` its parent: IMAP by the parent
// path gc.mail lists (imapflow's parentPath / delimiter; INBOX case-insensitive, a parent not listed or \Noselect
// leaves the folder on top, a personal namespace "INBOX." is no parent), Microsoft by parentFolderId (a display name
// may hold "/").
//
// Mail 1.3.5: Microsoft lists 10 levels (level by level, children only where childFolderCount says so, every page
// through @odata.nextLink); at most 1000 folders per account, IMAP the same — the rest is a hint in the log, no error.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, ANNA } = require('./helpers');

const CLIENT = { microsoft: { registration: 'custom', customClientId: '11111111-2222-3333-4444-555555555555' } };
const PKCE = { code: 'CODE-OK', codeVerifier: 'v'.repeat(43), redirectUri: 'msauth://com.gatecontrol.client/abc%3D' };

/** GET folders of the first account → Map path → { name, role, parent (the parent's path) }. */
async function tree(c) {
  const list = (await c.as(ANNA)('GET', 'folders')).json.accounts[0].folders;
  const byId = new Map(list.map((f) => [f.id, f]));
  return new Map(list.map((f) => [f.path, { name: f.name, role: f.role, parent: f.parentId ? byId.get(f.parentId).path : null }]));
}

test('IMAP "/": the own name, the parent by path, "Inbox/…" below INBOX, below a \\Noselect parent on top', () => withMail({}, async (host, c) => {
  await c.addGmx(ANNA, { login: { folders: {
    Gesendet: '\\Sent', Papierkorb: '\\Trash', Projekte: null, 'Projekte/Alpha': null, 'Projekte/Alpha/2025': null,
    'Inbox/Kunden': null, '[Gmail]': '\\Noselect', '[Gmail]/Wichtig': null,
  } } });
  await c.tick();
  const t = await tree(c);
  assert.deepEqual(t.get('Projekte'), { name: 'Projekte', role: null, parent: null });
  assert.deepEqual(t.get('Projekte/Alpha'), { name: 'Alpha', role: null, parent: 'Projekte' });
  assert.deepEqual(t.get('Projekte/Alpha/2025'), { name: '2025', role: null, parent: 'Projekte/Alpha' });
  assert.deepEqual(t.get('Inbox/Kunden'), { name: 'Kunden', role: null, parent: 'INBOX' }, 'INBOX is case-insensitive');
  assert.equal(t.has('[Gmail]'), false, '\\Noselect is no folder');
  assert.deepEqual(t.get('[Gmail]/Wichtig'), { name: 'Wichtig', role: null, parent: null }, 'its parent is not listed: on top');
  assert.deepEqual(t.get('Gesendet'), { name: 'Gesendet', role: 'sent', parent: null });
  assert.equal(t.get('INBOX').parent, null);
}));

test('IMAP ".": a personal namespace "INBOX." — the well-known and own folders on top, their children below them', () => withMail({}, async (host, c) => {
  await c.addGmx(ANNA, { login: { delimiter: '.', folders: {
    'INBOX.Sent': '\\Sent', 'INBOX.Trash': '\\Trash', 'INBOX.Drafts': null, 'INBOX.Kunden': null, 'INBOX.Kunden.Alpha': null,
  } } });
  await c.tick();
  const t = await tree(c);
  assert.deepEqual(t.get('INBOX.Sent'), { name: 'Sent', role: 'sent', parent: null });
  assert.deepEqual(t.get('INBOX.Drafts'), { name: 'Drafts', role: 'drafts', parent: null });
  assert.deepEqual(t.get('INBOX.Kunden'), { name: 'Kunden', role: null, parent: null });
  assert.deepEqual(t.get('INBOX.Kunden.Alpha'), { name: 'Alpha', role: null, parent: 'INBOX.Kunden' });
}));

test('IMAP ".": without the well-known ones below INBOX it is no namespace — "INBOX.Kunden" stays below the inbox', () => withMail({}, async (host, c) => {
  await c.addGmx(ANNA, { login: { delimiter: '.', folders: { Sent: '\\Sent', 'INBOX.Kunden': null } } });
  await c.tick();
  const t = await tree(c);
  assert.deepEqual(t.get('INBOX.Kunden'), { name: 'Kunden', role: null, parent: 'INBOX' });
  assert.deepEqual(t.get('Sent'), { name: 'Sent', role: 'sent', parent: null });
}));

test('IMAP without a hierarchy (no delimiter): every folder on top with its whole name', () => withMail({}, async (host, c) => {
  await c.addGmx(ANNA, { login: { delimiter: null, folders: { Sent: '\\Sent', 'Rechnungen/2025': null, Rechnungen: null } } });
  await c.tick();
  const t = await tree(c);
  assert.deepEqual(t.get('Rechnungen/2025'), { name: 'Rechnungen/2025', role: null, parent: null });
  assert.deepEqual(t.get('Rechnungen'), { name: 'Rechnungen', role: null, parent: null });
}));

/**
 * A fake Microsoft with folders: id → { name, parent (id; 'ROOT' on top), kids } (insertion order is Microsoft's).
 * o.page: folders per page (more → @odata.nextLink with $skiptoken). → fetch, with .calls (the folder lists asked for:
 * { path, query }).
 */
function world(folders, o = {}) {
  const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const entry = (id) => ({ id, displayName: folders[id].name, parentFolderId: folders[id].parent, childFolderCount: Object.values(folders).filter((f) => f.parent === id).length, totalItemCount: 0, unreadItemCount: 0 });
  const kidsOf = (pid) => Object.keys(folders).filter((id) => folders[id].parent === pid).map(entry);
  const calls = [];
  const paged = (u, list) => {
    const size = o.page || 1000;
    const from = Number(u.searchParams.get('$skiptoken')) || 0;
    const next = from + size < list.length ? new URL(u.href) : null;
    if (next) next.searchParams.set('$skiptoken', String(from + size));
    return json(200, { value: list.slice(from, from + size), ...(next ? { '@odata.nextLink': next.href } : {}) });
  };
  const fetch = async (url, opt) => {
    const u = new URL(url);
    if (u.host === 'login.microsoftonline.com') {
      const f = opt.form || {};
      if (f.grant_type === 'authorization_code') return json(200, { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, id_token: jwt({ email: 'anna@outlook.com', tid: '9188040d-6c67-4c5b-b112-36a304b66dad', name: 'Anna' }) });
      return json(200, { access_token: 'AT-2', expires_in: 3600 });
    }
    const p = decodeURIComponent(u.pathname.replace('/v1.0', ''));
    const wk = /^\/me\/mailFolders\/(inbox|sentitems|drafts|archive|junkemail|deleteditems)$/.exec(p);
    if (wk) return folders[`F-${wk[1]}`] ? json(200, entry(`F-${wk[1]}`)) : json(404, { error: { code: 'ErrorItemNotFound' } });
    if (p === '/me/mailFolders') { calls.push({ path: p, query: u.search }); return paged(u, kidsOf('ROOT')); }
    const kids = /^\/me\/mailFolders\/([^/]+)\/childFolders$/.exec(p);
    if (kids) { calls.push({ path: p, query: u.search }); return paged(u, kidsOf(kids[1])); }
    if (/\/messages\/delta$/.test(p)) return json(200, { value: [], '@odata.deltaLink': `https://graph.microsoft.com/v1.0${u.pathname}?$deltatoken=t1` });
    if (/\/messages$/.test(p)) return json(200, { value: [] });
    return json(404, { error: { code: 'ErrorItemNotFound' } });
  };
  fetch.calls = calls;
  return fetch;
}

/** Sign in Anna's Microsoft account and run the sync once. */
async function signIn(c) {
  const r = await c.as(ANNA)('POST', 'accounts/microsoft', PKCE);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await settle(200);
  await c.tick();
}

/** GET folders of the first account → { list, byName, parentName(name) }. */
async function folderList(c) {
  const list = (await c.as(ANNA)('GET', 'folders')).json.accounts[0].folders;
  const byName = new Map(list.map((f) => [f.name, f]));
  const parentName = (n) => { const f = byName.get(n); const p = list.find((x) => x.id === f.parentId); return p ? p.name : null; };
  return { list, byName, parentName };
}

const hints = (host) => host.logs.filter((l) => /folders left out/.test(l.message));

test('Microsoft: the parent by parentFolderId — a "/" in a display name makes no parent, the children of such a folder stay below it', () => withMail({
  settings: CLIENT,
  fetch: world({
    'F-inbox': { name: 'Posteingang', parent: 'ROOT' },
    'F-sentitems': { name: 'Gesendete Elemente', parent: 'ROOT' },
    K: { name: 'Kunden', parent: 'F-inbox' },
    KA: { name: 'Alpha', parent: 'K' },
    R: { name: 'Rechnungen', parent: 'ROOT' },
    RS: { name: 'Rechnungen/2025', parent: 'ROOT' },
    Q: { name: 'Q1', parent: 'RS' },
  }),
}, async (host, c) => {
  const r = await c.as(ANNA)('POST', 'accounts/microsoft', PKCE);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await settle(200);
  await c.tick();
  const list = (await c.as(ANNA)('GET', 'folders')).json.accounts[0].folders;
  const byName = new Map(list.map((f) => [f.name, f]));
  const parentName = (n) => { const f = byName.get(n); const p = list.find((x) => x.id === f.parentId); return p ? p.name : null; };
  assert.equal(byName.get('Posteingang').role, 'inbox');
  assert.equal(parentName('Posteingang'), null, 'the mailbox root is no folder');
  assert.equal(parentName('Kunden'), 'Posteingang');
  assert.equal(parentName('Alpha'), 'Kunden');
  assert.equal(parentName('Rechnungen/2025'), null, 'not below "Rechnungen"');
  assert.equal(parentName('Q1'), 'Rechnungen/2025');
  assert.equal(parentName('Rechnungen'), null);
}));

test('Microsoft: 6 levels deep, each below its parent — children asked for only where childFolderCount says so', () => {
  const fetch = world({
    'F-inbox': { name: 'Posteingang', parent: 'ROOT' },
    'F-sentitems': { name: 'Gesendete Elemente', parent: 'ROOT' },
    L1: { name: 'Ebene 1', parent: 'ROOT' },
    L2: { name: 'Ebene 2', parent: 'L1' },
    L3: { name: 'Ebene 3', parent: 'L2' },
    L4: { name: 'Ebene 4', parent: 'L3' },
    L5: { name: 'Ebene 5', parent: 'L4' },
    L6: { name: 'Ebene 6', parent: 'L5' },
    K: { name: 'Kunden', parent: 'F-inbox' },
  });
  return withMail({ settings: CLIENT, fetch }, async (host, c) => {
    await signIn(c);
    const { byName, parentName } = await folderList(c);
    for (let i = 2; i <= 6; i++) assert.equal(parentName(`Ebene ${i}`), `Ebene ${i - 1}`, `level ${i}`);
    assert.equal(parentName('Ebene 1'), null);
    assert.equal(byName.get('Ebene 6').path, 'Ebene 1/Ebene 2/Ebene 3/Ebene 4/Ebene 5/Ebene 6');
    assert.equal(parentName('Kunden'), 'Posteingang');
    const asked = new Set(fetch.calls.map((x) => x.path));
    for (const id of ['L1', 'L2', 'L3', 'L4', 'L5', 'F-inbox']) assert.ok(asked.has(`/me/mailFolders/${id}/childFolders`), id);
    for (const id of ['L6', 'K', 'F-sentitems']) assert.equal(asked.has(`/me/mailFolders/${id}/childFolders`), false, `${id} has no children: no request`);
    assert.ok(fetch.calls.every((x) => /\$select=id,displayName,parentFolderId,childFolderCount/.test(decodeURIComponent(x.query))), 'only the fields it needs');
    assert.deepEqual(hints(host), [], 'nothing left out');
  });
});

test('Microsoft: every page through @odata.nextLink, on top and below a folder', () => {
  const folders = { 'F-inbox': { name: 'Posteingang', parent: 'ROOT' } };
  for (let i = 1; i <= 7; i++) folders[`T${i}`] = { name: `Oben ${i}`, parent: 'ROOT' };
  for (let i = 1; i <= 5; i++) folders[`U${i}`] = { name: `Unter ${i}`, parent: 'T3' };
  for (let i = 1; i <= 3; i++) folders[`V${i}`] = { name: `Tiefer ${i}`, parent: 'U5' };
  const fetch = world(folders, { page: 2 });
  return withMail({ settings: CLIENT, fetch }, async (host, c) => {
    await signIn(c);
    const { list, parentName } = await folderList(c);
    assert.equal(list.length, 16);
    for (let i = 1; i <= 7; i++) assert.equal(parentName(`Oben ${i}`), null);
    for (let i = 1; i <= 5; i++) assert.equal(parentName(`Unter ${i}`), 'Oben 3');
    for (let i = 1; i <= 3; i++) assert.equal(parentName(`Tiefer ${i}`), 'Unter 5');
    const top = fetch.calls.filter((x) => x.path === '/me/mailFolders');
    assert.ok(top.length >= 4 && top.some((x) => /skiptoken=6/.test(x.query)), 'the top level in pages of 2');
    assert.ok(fetch.calls.some((x) => x.path === '/me/mailFolders/T3/childFolders' && /skiptoken=4/.test(x.query)), 'below a folder too');
  });
});

test('Microsoft: 10 levels — deeper ones stay out with a hint in the log, the account syncs', () => {
  const folders = { 'F-inbox': { name: 'Posteingang', parent: 'ROOT' } };
  for (let i = 1; i <= 12; i++) folders[`L${i}`] = { name: `Ebene ${i}`, parent: i === 1 ? 'ROOT' : `L${i - 1}` };
  const fetch = world(folders);
  return withMail({ settings: CLIENT, fetch }, async (host, c) => {
    await signIn(c);
    const { byName, parentName } = await folderList(c);
    assert.equal(parentName('Ebene 10'), 'Ebene 9');
    assert.equal(byName.has('Ebene 11'), false);
    assert.equal(byName.has('Ebene 12'), false);
    assert.equal(fetch.calls.some((x) => x.path === '/me/mailFolders/L10/childFolders'), false, 'level 11 is not asked for');
    const a = await require('../server/store').one(host.gc, 'SELECT state, error_code FROM accounts');
    assert.deepEqual({ ...a }, { state: 'ok', error_code: null });
    const h = hints(host);
    assert.equal(h.length, 1, JSON.stringify(host.logs));
    assert.equal(h[0].level, 'info');
    assert.match(h[0].message, /11 kept, 1 too deep/);
    await c.tick();
    assert.equal(hints(host).length, 1, 'once, not every run');
  });
});

test('Microsoft: at most 1000 folders — no page beyond, the well-known ones stay, the ones known from before too', () => {
  const graph = require('../server/graph');
  const store = require('../server/store');
  const top = (n, prefix) => Array.from({ length: n }, (_, i) => [`${prefix}${i + 1}`, { name: `${prefix} ${String(i + 1).padStart(4, '0')}`, parent: 'ROOT' }]);
  const mailbox = (...parts) => Object.fromEntries(parts.flat());
  const folders = {};
  const replace = (next) => { for (const id of Object.keys(folders)) delete folders[id]; Object.assign(folders, next); };
  const tail = [['S', { name: 'Unter', parent: 'T1' }], ['F-inbox', { name: 'Posteingang', parent: 'ROOT' }], ['F-sentitems', { name: 'Gesendete Elemente', parent: 'ROOT' }]];
  replace(mailbox(top(990, 'T'), tail));   // the well-known ones listed last
  const fetch = world(folders, { page: 100 });
  return withMail({ settings: CLIENT, fetch }, async (host, c) => {
    await signIn(c);
    assert.equal((await folderList(c)).list.length, 993);
    assert.deepEqual(hints(host), []);
    const account = await store.one(host.gc, 'SELECT * FROM accounts');

    // 20 new ones listed ahead: 1000 are walked, the rest stays out — no error, a hint
    replace(mailbox(top(20, 'N'), top(990, 'T'), tail));
    fetch.calls.length = 0;
    await graph.syncFolders(host.gc, account);
    assert.equal(fetch.calls.some((x) => /skiptoken=1000/.test(x.query)), false, 'no page beyond 1000');
    assert.equal(fetch.calls.some((x) => x.path === '/me/mailFolders/T1/childFolders'), false, 'no children beyond 1000');
    let f = await folderList(c);
    assert.ok(f.byName.has('N 0020') && f.byName.has('T 0980'));
    assert.equal(f.byName.get('Posteingang').role, 'inbox', 'the well-known ones stay');
    assert.equal(f.byName.get('Gesendete Elemente').role, 'sent');
    assert.ok(f.byName.has('T 0990'), 'known from before: stays with its mail');
    assert.equal(f.parentName('Unter'), 'T 0001', 'and below its parent');
    assert.equal(f.list.length, 1000 + 2 + 10 + 1);
    const h = hints(host);
    assert.equal(h.length, 1);
    assert.equal(h[0].level, 'info');
    assert.match(h[0].message, /folders left out \d+ 1002 kept, 1\+ beyond 1000/);

    // fewer again: all of them walked, a folder gone at Microsoft goes here too
    replace(mailbox(top(989, 'T'), tail));
    await graph.syncFolders(host.gc, account);
    f = await folderList(c);
    assert.equal(f.byName.has('T 0990'), false);
    assert.equal(f.byName.has('N 0001'), false);
    assert.equal(f.list.length, 992);
    assert.equal(hints(host).length, 1, 'no new hint');
  });
});

test('IMAP: at most 1000 folders — the well-known ones and the ones known from before first, then the shallow ones', () => {
  const imap = require('../server/imap');
  const store = require('../server/store');
  return withMail({}, async (host, c) => {
    await c.addGmx(ANNA, { login: { folders: { Gesendet: '\\Sent', Alt: null, 'Alt/Kind': null } } });
    await c.tick();
    const account = await store.one(host.gc, 'SELECT * FROM accounts');
    const listed = [{ path: 'INBOX', name: 'INBOX', delimiter: '/', flags: [] }, { path: 'Alt/Kind', name: 'Kind', delimiter: '/', flags: [], parent: 'Alt' }];
    for (let i = 1; i <= 1000; i++) listed.push({ path: `P${i}`, name: `P${i}`, delimiter: '/', flags: [] });
    listed.push({ path: 'Alt', name: 'Alt', delimiter: '/', flags: [] }, { path: 'Gesendet', name: 'Gesendet', delimiter: '/', flags: [], specialUse: '\\Sent' });
    await imap.syncFolders(host.gc, account, { list: async () => listed }, Date.now());
    const { byName, list, parentName } = await folderList(c);
    assert.equal(list.length, 1000);
    assert.equal(byName.get('Gesendet').role, 'sent');
    assert.equal(parentName('Kind'), 'Alt', 'known from before: stays, below its parent');
    assert.ok(byName.has('P996') && !byName.has('P997'), 'new ones in the order listed');
    const h = hints(host);
    assert.equal(h.length, 1);
    assert.match(h[0].message, /1000 kept, 4 beyond 1000/);
  });
});
