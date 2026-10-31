'use strict';

// Mail 1.3.3: the folder tree of GET folders — `name` the folder's own name, `parentId` its parent: IMAP by the parent
// path gc.mail lists (imapflow's parentPath / delimiter; INBOX case-insensitive, a parent not listed or \Noselect
// leaves the folder on top, a personal namespace "INBOX." is no parent), Microsoft by parentFolderId (a display name
// may hold "/").

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

/** A fake Microsoft with folders: id → { name, parent (id; 'ROOT' on top), kids }. */
function world(folders) {
  const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const entry = (id) => ({ id, displayName: folders[id].name, parentFolderId: folders[id].parent, childFolderCount: Object.values(folders).filter((f) => f.parent === id).length, totalItemCount: 0, unreadItemCount: 0 });
  const kidsOf = (pid) => Object.keys(folders).filter((id) => folders[id].parent === pid).map(entry);
  return async (url, o) => {
    const u = new URL(url);
    if (u.host === 'login.microsoftonline.com') {
      const f = o.form || {};
      if (f.grant_type === 'authorization_code') return json(200, { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, id_token: jwt({ email: 'anna@outlook.com', tid: '9188040d-6c67-4c5b-b112-36a304b66dad', name: 'Anna' }) });
      return json(200, { access_token: 'AT-2', expires_in: 3600 });
    }
    const p = decodeURIComponent(u.pathname.replace('/v1.0', ''));
    const wk = /^\/me\/mailFolders\/(inbox|sentitems|drafts|archive|junkemail|deleteditems)$/.exec(p);
    if (wk) return folders[`F-${wk[1]}`] ? json(200, { id: `F-${wk[1]}` }) : json(404, { error: { code: 'ErrorItemNotFound' } });
    if (p === '/me/mailFolders') return json(200, { value: kidsOf('ROOT') });
    const kids = /^\/me\/mailFolders\/([^/]+)\/childFolders$/.exec(p);
    if (kids) return json(200, { value: kidsOf(kids[1]) });
    if (/\/messages\/delta$/.test(p)) return json(200, { value: [], '@odata.deltaLink': `https://graph.microsoft.com/v1.0${u.pathname}?$deltatoken=t1` });
    if (/\/messages$/.test(p)) return json(200, { value: [] });
    return json(404, { error: { code: 'ErrorItemNotFound' } });
  };
}

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
