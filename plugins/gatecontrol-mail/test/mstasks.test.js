'use strict';

// Microsoft To Do for GateControl Notizen & Aufgaben (1.12.0, services.js ms_accounts / ms_tasks_consent / ms_tasks_token,
// microsoft.js tasksToken): only that plugin may call them, only for the person's own Microsoft accounts; the consent
// is a device-code sign-in with Tasks.ReadWrite added (the account's mail and calendars stay granted); the token is
// asked for with the single scope Tasks.ReadWrite — never Mail's own token; a rotated refresh token is kept.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMail, settle, ANNA, MARC } = require('./helpers');

const NOTIZEN = 'gatecontrol-notizen';
const CLIENT = { microsoft: { registration: 'custom', customClientId: '11111111-2222-3333-4444-555555555555' } };
const PKCE = { codeVerifier: 'v'.repeat(43), redirectUri: 'msauth://com.gatecontrol.client/abc%3D' };
const PHASE1 = 'openid profile email offline_access User.Read Mail.ReadWrite Mail.Send';
const as = (u) => ({ id: u.id, name: u.name, role: 'user' });
const call = (host, name, user, payload, caller = NOTIZEN) => host.callService(name, { caller, user: user ? as(user) : null, payload });

function world() {
  const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const st = { granted: PHASE1, deviceScopes: [], refresh: [], rt: 'RT-1' };
  const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const id = jwt({ email: 'anna@outlook.com', tid: '9188040d-6c67-4c5b-b112-36a304b66dad', name: 'Anna' });
  st.fetch = async (url, o) => {
    const u = new URL(url);
    if (u.host === 'login.microsoftonline.com') {
      const f = o.form || {};
      if (u.pathname.endsWith('/devicecode')) { st.deviceScopes.push(f.scope); return json(200, { device_code: 'DEV', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 }); }
      if (f.grant_type === 'authorization_code') return json(200, { access_token: 'AT-MAIL', refresh_token: 'RT-1', expires_in: 3600, scope: st.granted, id_token: id });
      if (f.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        st.granted = st.deviceScopes[st.deviceScopes.length - 1];
        return json(200, { access_token: 'AT-MAIL-2', refresh_token: 'RT-2', expires_in: 3600, scope: st.granted, id_token: id });
      }
      if (f.grant_type === 'refresh_token') {
        st.refresh.push({ scope: f.scope, rt: f.refresh_token });
        if (/Tasks\.ReadWrite/.test(f.scope) && !/Tasks\.ReadWrite/.test(st.granted)) return json(400, { error: 'invalid_grant', error_description: 'AADSTS65001: consent' });
        if (/Tasks\.ReadWrite/.test(f.scope)) return json(200, { access_token: 'AT-TASKS', refresh_token: 'RT-3', expires_in: 3600, scope: 'https://graph.microsoft.com/Tasks.ReadWrite' });
        return json(200, { access_token: 'AT-MAIL-R', expires_in: 3600 });
      }
      return json(400, { error: 'unsupported' });
    }
    const p = u.pathname.replace('/v1.0', '');
    const wk = /^\/me\/mailFolders\/(inbox|sentitems|drafts|archive|junkemail|deleteditems)$/.exec(p);
    if (wk) return json(200, { id: `F-${wk[1]}` });
    if (p === '/me/mailFolders') return json(200, { value: [] });
    if (/^\/me\/photos?/.test(p)) return json(404, { error: { code: 'ErrorItemNotFound' } });
    if (p === '/me') return json(200, { mail: 'anna@outlook.com' });
    return json(200, { value: [] });
  };
  return st;
}

test('ms_tasks_*: consent by device code with Tasks.ReadWrite added, then a token for To Do only; only Notizen, only own accounts', async () => {
  const w = world();
  await withMail({ gatecontrol: '1.219.0', fetch: w.fetch, settings: CLIENT }, async (host, c) => {
    const r = await c.as(ANNA)('POST', 'accounts/microsoft', { code: 'X', ...PKCE });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const acc = r.json.account;
    assert.equal(acc.tasks, false);
    await settle();
    // only Notizen & Aufgaben
    const other = await call(host, 'ms_accounts', ANNA, {}, 'gatecontrol-drive');
    assert.equal(other.code, 'forbidden', JSON.stringify(other));
    const list = await call(host, 'ms_accounts', ANNA, {});
    assert.deepEqual(list.accounts.map((a) => [a.id, a.email, a.kind, a.tasks]), [[acc.id, 'anna@outlook.com', 'personal', false]]);
    const marc = await call(host, 'ms_accounts', MARC, {});
    assert.ok(!marc.accounts || marc.accounts.length === 0, JSON.stringify(marc));
    assert.equal((await call(host, 'ms_tasks_token', ANNA, { accountId: acc.id })).code, 'consent_required');
    assert.equal((await call(host, 'ms_tasks_token', ANNA, { accountId: 999 })).code, 'not_found');
    const mt = await call(host, 'ms_tasks_token', MARC, { accountId: acc.id });
    assert.ok(mt.ok === false && ['not_found', 'unavailable'].includes(mt.code) && !mt.token, JSON.stringify(mt));
    // the consent: a device code asking for Mail's scopes plus Tasks.ReadWrite
    const start = await call(host, 'ms_tasks_consent', ANNA, { accountId: acc.id });
    assert.equal(start.ok, true);
    assert.equal(start.userCode, 'ABCD-EFGH');
    assert.match(w.deviceScopes[0], /Mail\.ReadWrite/);
    assert.match(w.deviceScopes[0], /Tasks\.ReadWrite/);
    assert.equal((await call(host, 'ms_tasks_consent', ANNA, { accountId: acc.id, deviceId: start.deviceId })).status, 'pending', 'not before the interval');
    await c.db('UPDATE ms_device SET next_at = 0');
    const done = await call(host, 'ms_tasks_consent', ANNA, { accountId: acc.id, deviceId: start.deviceId });
    assert.deepEqual([done.status, done.tasks], ['done', true]);
    await settle();
    assert.equal((await call(host, 'ms_accounts', ANNA, {})).accounts[0].tasks, true);
    // the token: asked with Tasks.ReadWrite alone, the rotated refresh token kept
    const tk = await call(host, 'ms_tasks_token', ANNA, { accountId: acc.id });
    assert.equal(tk.ok, true);
    assert.equal(tk.token, 'AT-TASKS');
    assert.ok(tk.expiresAt > Date.now());
    const asked = w.refresh.filter((x) => /Tasks/.test(x.scope));
    assert.deepEqual(asked.map((x) => x.scope), ['offline_access https://graph.microsoft.com/Tasks.ReadWrite']);
    assert.equal(asked[0].rt, 'RT-2');
    // cached: no second refresh within its lifetime
    await call(host, 'ms_tasks_token', ANNA, { accountId: acc.id });
    assert.equal(w.refresh.filter((x) => /Tasks/.test(x.scope)).length, 1);
    // Mail's own renewal now uses the refresh token Microsoft rotated
    const next = w.refresh.length;
    require('../server/microsoft').forget(acc.id);
    await require('../server/microsoft').accessToken(host.gc, (await c.db('SELECT * FROM accounts WHERE id = ?', [acc.id]))[0]);
    assert.equal(w.refresh[next].rt, 'RT-3');
    assert.match(w.refresh[next].scope, /Tasks\.ReadWrite/, 'a renewal asks for every granted scope');
    // signing in anew keeps To Do
    const again = await c.as(ANNA)('POST', 'accounts/microsoft/device', { accountId: acc.id });
    assert.equal(again.status, 200);
    assert.match(w.deviceScopes[w.deviceScopes.length - 1], /Tasks\.ReadWrite/);
    // GET me tells the apps the scope
    assert.equal((await c.as(ANNA)('GET', 'me')).json.microsoft.tasksScope, 'Tasks.ReadWrite');
  });
});
