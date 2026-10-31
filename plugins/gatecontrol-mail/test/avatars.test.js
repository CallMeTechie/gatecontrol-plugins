'use strict';

// Mail 1.1.2: the picture of an account at its provider (Microsoft: Graph /me/photos/96x96, else /me/photo) as the
// plugin's media — Account.avatar { mediaId, mime } | null, loaded through the plugin's media (mediaAccess) or, for the
// portal, GET accounts/<id>/avatar (a signed url). On the sign-in, then at most once a day (an unchanged mediaEtag is not
// loaded again); 404 = none; a failure → null (again within the hour); IMAP accounts have none.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, ANNA, MARC } = require('./helpers');

const CLIENT = { microsoft: { registration: 'custom', customClientId: '11111111-2222-3333-4444-555555555555' } };
const PKCE = { code: 'CODE-OK', codeVerifier: 'v'.repeat(43), redirectUri: 'msauth://com.gatecontrol.client/abc%3D' };
const DAY = 86400000;

async function until(fn, n = 1500) {
  for (let i = 0; i < n; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 2)); }
  throw new Error('timed out waiting');
}

/** A fake Microsoft with a picture: photo 'small' (96×96 and original) | 'original' (only /me/photo) | 'none' | 'error'. */
function world(photo) {
  const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const w = { photo, etag: 'W/"e1"', meta: [], files: [], graph: 0 };
  w.fetch = async (url, o) => {
    const u = new URL(url);
    if (u.host === 'login.microsoftonline.com') {
      const f = o.form || {};
      if (f.grant_type === 'authorization_code') return json(200, { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, id_token: jwt({ email: 'anna@outlook.com', tid: '9188040d-6c67-4c5b-b112-36a304b66dad', name: 'Anna' }) });
      return json(200, { access_token: 'AT-2', expires_in: 3600 });
    }
    w.graph++;
    assert.match((o.headers || {}).authorization, /^Bearer AT-/);
    const p = u.pathname.replace('/v1.0', '');
    if (p === '/me/photos/96x96' || p === '/me/photo') {
      w.meta.push(p);
      if (w.photo === 'error') return json(500, { error: { code: 'ServiceUnavailable' } });
      if (w.photo === 'none' || (w.photo === 'original' && p !== '/me/photo')) return json(404, { error: { code: 'ImageNotFound' } });
      return json(200, { id: p.endsWith('96x96') ? '96X96' : '240X240', width: 96, height: 96, '@odata.mediaContentType': 'image/jpeg', '@odata.mediaEtag': w.etag });
    }
    if (/^\/me\/(photos\/96x96|photo)\/\$value$/.test(p)) {
      w.files.push(p);
      return { status: 200, headers: { 'content-type': 'image/jpeg' }, body: Buffer.from(`JPEG ${w.etag} ${p}`) };
    }
    const wk = /^\/me\/mailFolders\/(inbox|sentitems|drafts|archive|junkemail|deleteditems)$/.exec(p);
    if (wk) return json(200, { id: `F-${wk[1]}` });
    if (p === '/me/mailFolders') return json(200, { value: ['inbox', 'sentitems'].map((x) => ({ id: `F-${x}`, displayName: x, childFolderCount: 0, totalItemCount: 0, unreadItemCount: 0 })) });
    if (/\/messages\/delta$/.test(p)) return json(200, { value: [], '@odata.deltaLink': `https://graph.microsoft.com/v1.0${p}?$deltatoken=t1` });
    if (/\/messages$/.test(p)) return json(200, { value: [] });
    return json(404, { error: { code: 'ErrorItemNotFound' } });
  };
  return w;
}

async function signIn(c) {
  const r = await c.as(ANNA)('POST', 'accounts/microsoft', PKCE);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await settle(200);
  return r.json.account;
}

const accountOf = async (c, id) => (await c.as(ANNA)('GET', 'me')).json.accounts.find((a) => a.id === id);

test('Microsoft: the 96×96 picture comes with the sign-in — Account.avatar, the plugin\'s media (only the person), GET accounts/<id>/avatar; once a day, unchanged not again', () => {
  const w = world('small');
  return withMail({ fetch: w.fetch, settings: CLIENT }, async (host, c) => {
    const acc = await signIn(c);
    const a = await accountOf(c, acc.id);
    assert.deepEqual(Object.keys(a.avatar), ['mediaId', 'mime']);
    assert.equal(a.avatar.mime, 'image/jpeg');
    assert.equal(a.provider, 'outlook');
    assert.equal(a.email, 'anna@outlook.com');
    assert.deepEqual(w.files, ['/me/photos/96x96/$value']);
    const file = host.media.get(a.avatar.mediaId);
    assert.ok(file && file.claimed, 'claimed');
    assert.equal(file.area, undefined, 'since 1.5.0: on this server, in no media area (Speicherorte)');
    assert.match(file.data.toString(), /^JPEG/);
    // the apps load it as the plugin's media — the person only
    assert.equal((await host.mediaGet({ id: ANNA.id, app: true }, a.avatar.mediaId)).status, 200);
    assert.equal((await host.mediaGet({ id: MARC.id, app: true }, a.avatar.mediaId)).status, 404);
    // the portal: a signed url
    const r = (await c.as(ANNA)('GET', `accounts/${acc.id}/avatar`)).json;
    assert.equal(r.mediaId, a.avatar.mediaId);
    assert.equal(r.mime, 'image/jpeg');
    assert.ok(r.size > 0 && /^\/plugin-media\//.test(r.url));
    assert.equal((await c.as(MARC)('GET', `accounts/${acc.id}/avatar`)).status, 404);
    // the background runs of the same day: no look again
    const looks = w.meta.length;
    await c.tick();
    await c.tick();
    assert.equal(w.meta.length, looks, 'not again the same day');
    // a day later: the same picture (mediaEtag) → not loaded again
    await host.gc.db.run('UPDATE accounts SET avatar_at = ?', [Date.now() - DAY - 1000]);
    await c.tick();
    assert.equal(w.meta.length, looks + 1);
    assert.equal(w.files.length, 1, 'unchanged: not loaded again');
    assert.equal((await accountOf(c, acc.id)).avatar.mediaId, a.avatar.mediaId);
    // a new picture at Microsoft: loaded, the old file goes, the lists hear of it
    w.etag = 'W/"e2"';
    await host.gc.db.run('UPDATE accounts SET avatar_at = ?', [Date.now() - DAY - 1000]);
    const mark = host.events.length;
    await c.tick();
    const b = await accountOf(c, acc.id);
    assert.notEqual(b.avatar.mediaId, a.avatar.mediaId);
    assert.equal(host.media.has(a.avatar.mediaId), false, 'the old picture is gone');
    assert.match(host.media.get(b.avatar.mediaId).data.toString(), /e2/);
    assert.ok(host.events.slice(mark).some((e) => e.type === 'mail' && e.data.accountId === acc.id && e.data.folderId === null));
    // the account goes: its picture too
    assert.equal((await c.as(ANNA)('DELETE', `accounts/${acc.id}`)).json.ok, true);
    assert.equal(host.media.has(b.avatar.mediaId), false);
  });
});

test('Microsoft: no 96×96 picture → the original; none at all (404) → avatar null, not asked again the same day', () => {
  const w = world('original');
  return withMail({ fetch: w.fetch, settings: CLIENT }, async (host, c) => {
    const acc = await signIn(c);
    assert.deepEqual(w.meta, ['/me/photos/96x96', '/me/photo']);
    assert.deepEqual(w.files, ['/me/photo/$value']);
    const a = await accountOf(c, acc.id);
    assert.ok(a.avatar && a.avatar.mediaId);
    // Microsoft removed it: 404 → null, the file goes
    w.photo = 'none';
    await host.gc.db.run('UPDATE accounts SET avatar_at = ?', [Date.now() - DAY - 1000]);
    await c.tick();
    assert.equal((await accountOf(c, acc.id)).avatar, null);
    assert.equal(host.media.has(a.avatar.mediaId), false);
    assert.equal((await c.as(ANNA)('GET', `accounts/${acc.id}/avatar`)).json.error.code, 'not_found');
    const looks = w.meta.length;
    await c.tick();
    assert.equal(w.meta.length, looks, 'none: asked again tomorrow');
  });
});

test('Microsoft: a failing picture → avatar null, asked again within the hour (not on every run); IMAP accounts have none', () => {
  const w = world('error');
  return withMail({ fetch: w.fetch, settings: CLIENT }, async (host, c) => {
    const acc = await signIn(c);
    const a = await accountOf(c, acc.id);
    assert.equal(a.avatar, null);
    assert.equal(a.state === 'auth_failed', false, 'the account is not marked for it');
    const looks = w.meta.length;
    assert.ok(looks >= 1);
    await c.tick();
    await c.tick();
    assert.equal(w.meta.length, looks, 'not on every run');
    const row = (await c.db('SELECT avatar_at FROM accounts WHERE id = ?', [acc.id]))[0];
    assert.ok(row.avatar_at <= Date.now() - DAY + 3600000 && row.avatar_at > Date.now() - DAY, 'again within the hour');
    // an hour later it works
    w.photo = 'small';
    await host.gc.db.run('UPDATE accounts SET avatar_at = ?', [Date.now() - DAY - 1]);
    await c.tick();
    assert.ok((await accountOf(c, acc.id)).avatar);
    // IMAP: no picture, no Graph call
    const looks2 = w.meta.length;
    const gmx = await c.addGmx(ANNA);
    await c.tick();
    assert.equal((await accountOf(c, gmx.id)).avatar, null);
    assert.equal(w.meta.length, looks2, 'no picture asked for an IMAP account');
    assert.equal((await c.db('SELECT avatar_at FROM accounts WHERE id = ?', [gmx.id]))[0].avatar_at, null);
  });
});

test('portal smoke: the account list shows the picture (a signed url) or the provider\'s mark, with the address under the name', () => {
  const ui = require('../server/ui');
  const { t } = require('../server/text');
  const { createWindow } = require('./fake-dom');
  const { app } = require('./helpers');
  const w = world('small');
  return withMail({ fetch: w.fetch, settings: CLIENT }, async (host, c) => {
    await signIn(c);
    await c.addGmx(ANNA, { name: 'Anna GMX' });
    const gc = {
      async call(method, p, body) {
        const [path, qs] = String(p).split('?');
        const query = Object.fromEntries(new URLSearchParams(qs || ''));
        const r = await host.request({ method, path, body: body === undefined ? null : body, query, user: app(ANNA), lang: 'de' });
        if (r.status !== 200) throw Object.assign(new Error('http ' + r.status), { status: r.status, data: r.json });
        return r.json;
      },
      on() {},
    };
    const f = createWindow(ui.render({ view: 'portal', lang: 'de', user: { id: ANNA.id, loggedIn: true }, allowed: true }, t), gc);
    const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));
    try {
      f.run();
      const nav = () => f.document.getElementById('mp-nav');
      await until(() => nav() && f.document.querySelectorAll('img').some((i) => /^\/plugin-media\//.test(i.getAttribute('src') || '')));
      const text = textOf(nav());
      assert.ok(text.includes('anna@outlook.com'), 'the address of the Microsoft account');
      assert.ok(text.includes('Anna GMX') && text.includes('anna@gmx.de'), 'name and address');
      assert.ok(f.document.querySelectorAll('span').some((s) => s.className.includes('mp-acc') && textOf(s) === 'GMX'), 'GMX: its mark');
    } finally { f.stop(); }
  });
});
