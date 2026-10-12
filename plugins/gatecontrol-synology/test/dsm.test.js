'use strict';

// The DSM Web API client (server/dsm.js) against the fake DSM: API info and
// versions, login form (SYNO.API.Auth v6), every login error code, relogin
// on a stale session, the 2-step verification path with the device token,
// logout, requestFormat JSON and the connection errors.

const test = require('node:test');
const assert = require('node:assert/strict');
const dsm = require('../server/dsm');
const { fakeDsm, ACCOUNT, PASSWORD, netError, json } = require('./helpers');

function client(d, creds = {}) {
  const c = { account: ACCOUNT, password: PASSWORD, device: null, ...creds };
  return dsm.createClient({ send: d.fetch, credentials: async () => c, session: dsm.newSession() });
}

async function rejects(p, code, dsmCode) {
  await assert.rejects(p, (e) => {
    assert.equal(e.code, code);
    if (dsmCode !== undefined) assert.equal(e.dsm, dsmCode);
    return true;
  });
}

test('login: SYNO.API.Info first, then SYNO.API.Auth v6 on its path; password only in the POST body', async () => {
  const d = fakeDsm('dsm72.json');
  const c = client(d);
  const r = await c.login();
  assert.equal(r.did, null);
  assert.equal(d.state.requests[0].method, 'GET');
  assert.match(d.state.requests[0].path, /^\/webapi\/query\.cgi\?api=SYNO\.API\.Info&version=1&method=query&query=SYNO\.API\.Auth%2C/);
  const login = d.state.logins[0];
  assert.equal(login.url, '/webapi/entry.cgi');
  assert.deepEqual({ v: login.version, m: login.method, s: login.session, f: login.format, t: login.enable_syno_token }, { v: '6', m: 'login', s: 'webui', f: 'sid', t: 'yes' });
  assert.equal(login.account, ACCOUNT);
  assert.equal(login.passwd, PASSWORD);
  for (const q of d.state.requests) assert.ok(!q.path.includes(encodeURIComponent(PASSWORD)) && !q.path.includes(PASSWORD), 'never in a URL');
  assert.ok(c.session.sid && c.session.token);
  // later calls carry _sid and X-SYNO-TOKEN
  await c.call('SYNO.DSM.Info', 'getinfo', {}, { version: 2 });
  const last = d.state.requests.at(-1);
  assert.equal(last.form._sid, c.session.sid);
  assert.equal(last.headers['X-SYNO-TOKEN'], c.session.token);
  assert.equal(d.state.calls[0].version, 2);
});

test('DSM 6.2: SYNO.API.Auth lives at auth.cgi; versions are clamped to what the NAS offers', async () => {
  const d = fakeDsm('dsm62.json');
  const c = client(d);
  await c.login();
  assert.equal(d.state.logins[0].url, '/webapi/auth.cgi');
  assert.equal(d.state.logins[0].version, '6');
  await c.call('SYNO.Core.Upgrade.Server', 'check', {}, { version: 9 });
  assert.equal(d.state.calls.at(-1).version, 2);
  assert.equal(dsm.pickVersion({ minVersion: 3, maxVersion: 7 }, 1), 3);
  assert.equal(dsm.pickVersion({ minVersion: 1, maxVersion: 7 }, 6), 6);
  assert.equal(dsm.pickVersion({ minVersion: 1, maxVersion: 4 }, 6), 4);
});

test('login error codes 400/401/402/403/404/406/407/408–410 → own codes', async () => {
  const cases = { 400: 'AUTH_FAILED', 401: 'ACCOUNT_DISABLED', 402: 'AUTH_DENIED', 403: 'OTP_REQUIRED', 404: 'OTP_INVALID', 406: 'OTP_ENFORCED', 407: 'IP_BLOCKED', 408: 'PASSWORD_EXPIRED', 409: 'PASSWORD_EXPIRED', 410: 'PASSWORD_EXPIRED' };
  for (const [code, want] of Object.entries(cases)) {
    const d = fakeDsm('dsm72.json');
    d.state.loginError = Number(code);
    await rejects(client(d).login(), want, Number(code));
    assert.ok(dsm.AUTH_CODES.has(want), want);
  }
  // wrong password from the fake itself
  await rejects(client(fakeDsm('dsm72.json'), { password: 'nope' }).login(), 'AUTH_FAILED', 400);
  await rejects(client(fakeDsm('dsm72.json'), { password: null }).login(), 'NO_CREDENTIALS');
  // the same numbers outside a login are API codes, not login codes
  assert.equal(dsm.dsmFail(400).code, 'DSM_ERROR');
  assert.equal(dsm.dsmFail(105).code, 'PERMISSION');
});

test('stale session (119, 106) → one new login, the call is repeated; the session is reused otherwise', async () => {
  const d = fakeDsm('dsm72.json');
  const c = client(d);
  await c.call('SYNO.DSM.Info', 'getinfo', {}, { version: 2 });
  await c.call('SYNO.DSM.Info', 'getinfo', {}, { version: 2 });
  assert.equal(d.state.logins.length, 1, 'session reused');
  d.state.sessions.clear(); // DSM forgot the session → 119
  const info = await c.call('SYNO.DSM.Info', 'getinfo', {}, { version: 2 });
  assert.equal(info.model, 'DS920+');
  assert.equal(d.state.logins.length, 2);
  // 106 (timeout) once, then fine
  const orig = d.fetch;
  let first = true;
  const d2 = { fetch: async (p, o) => { if (o.form && o.form.api === 'SYNO.DSM.Info' && first) { first = false; return json({ success: false, error: { code: 106 } }); } return orig(p, o); } };
  const c2 = dsm.createClient({ send: d2.fetch, credentials: async () => ({ account: ACCOUNT, password: PASSWORD }), session: c.session });
  assert.equal((await c2.call('SYNO.DSM.Info', 'getinfo', {}, { version: 2 })).model, 'DS920+');
  assert.equal(d.state.logins.length, 3);
});

test('105: a session that worked before logs in once more; still 105 after that → PERMISSION (no loop)', async () => {
  const d = fakeDsm('dsm72.json', { denied: ['SYNO.Storage.CGI.Storage'] });
  const c = client(d);
  await c.call('SYNO.DSM.Info', 'getinfo', {}, { version: 2 });
  await rejects(c.call('SYNO.Storage.CGI.Storage', 'load_info'), 'PERMISSION', 105);
  assert.equal(d.state.logins.length, 2, 'one relogin, then the error');
  // a session just made (nothing worked with it yet): 105 is the answer, no relogin
  const c2 = client(d);
  await c2.login();
  await rejects(c2.call('SYNO.Storage.CGI.Storage', 'load_info'), 'PERMISSION', 105);
  await rejects(client(d).call('SYNO.Storage.CGI.Storage', 'load_info'), 'PERMISSION', 105);
  assert.equal(d.state.logins.length, 4);
});

test('2-step verification: 403 → code with enable_device_token → device token → later logins without a code', async () => {
  const d = fakeDsm('dsm72.json', { otp: '123456' });
  await rejects(client(d).login(), 'OTP_REQUIRED', 403);
  await rejects(client(d).login({ otp: '654321' }), 'OTP_INVALID', 404);
  const r = await client(d).login({ otp: '123456' });
  assert.match(r.did, /^did-/);
  const withCode = d.state.logins.at(-1);
  assert.deepEqual({ code: withCode.otp_code, dev: withCode.enable_device_token, name: withCode.device_name }, { code: '123456', dev: 'yes', name: 'GateControl' });
  // next login: device_id + device_name, no code
  const c = client(d, { device: r.did });
  await c.call('SYNO.DSM.Info', 'getinfo', {}, { version: 2 });
  const later = d.state.logins.at(-1);
  assert.equal(later.device_id, r.did);
  assert.equal(later.device_name, 'GateControl');
  assert.equal(later.otp_code, undefined);
  // the session that got the token logs in again without a code as well
  const c3 = dsm.createClient({ send: d.fetch, credentials: async () => ({ account: ACCOUNT, password: PASSWORD }), session: dsm.newSession() });
  await c3.login({ otp: '123456' });
  c3.session.sid = 'gone';
  await c3.call('SYNO.DSM.Info', 'getinfo', {}, { version: 2 });
  assert.ok(d.state.logins.at(-1).device_id && !d.state.logins.at(-1).otp_code);
  // a revoked token: the code is asked for again
  d.state.devices.clear();
  await rejects(client(d, { device: r.did }).login(), 'OTP_REQUIRED', 403);
});

test('logout ends the session on the NAS', async () => {
  const d = fakeDsm('dsm72.json');
  const c = client(d);
  await c.login();
  assert.equal(d.state.sessions.size, 1);
  await c.logout();
  assert.equal(d.state.sessions.size, 0);
  assert.equal(d.state.logouts, 1);
  assert.equal(c.session.sid, null);
  await c.logout(); // nothing to do
  assert.equal(d.state.logouts, 1);
});

test('requestFormat JSON: parameters JSON-encoded (strings quoted); plain APIs get strings', () => {
  assert.deepEqual(dsm.encodeParams({ requestFormat: 'JSON' }, { type: 'storage', task_id: 3, additional: ['a'] }), { type: '"storage"', task_id: '3', additional: '["a"]' });
  assert.deepEqual(dsm.encodeParams({}, { type: 'storage', task_id: 3, additional: ['a'] }), { type: 'storage', task_id: '3', additional: '["a"]' });
});

test('connection errors: refused, timeout, self-signed certificate, unassigned target, HTTPS redirect, HTTP to the HTTPS port, not a DSM', async () => {
  const at = (fetch) => client({ fetch }).login();
  await rejects(at(async () => { throw netError('connect ECONNREFUSED 10.0.0.5:5000'); }), 'UNREACHABLE');
  await rejects(at(async () => { throw netError('timeout'); }), 'TIMEOUT');
  await rejects(at(async () => { throw netError('self-signed certificate'); }), 'TLS_CERT');
  await rejects(at(async () => { throw netError("Hostname/IP does not match certificate's altnames: IP: 10.0.0.5 is not in the cert's list: "); }), 'TLS_CERT');
  await rejects(at(async () => { throw netError('no target assigned for nas — an administrator assigns it in Settings → Plugins', 'ERR_NET_DENIED'); }), 'TARGET_UNASSIGNED');
  await rejects(at(async () => ({ status: 301, headers: { location: 'https://nas.home.example:5001/webapi/query.cgi' }, body: '' })), 'HTTPS_REDIRECT');
  await rejects(at(async () => ({ status: 400, headers: {}, body: '<html><center>The plain HTTP request was sent to HTTPS port</center></html>' })), 'HTTP_TO_HTTPS_PORT');
  await rejects(at(async () => ({ status: 404, headers: {}, body: 'not found' })), 'HTTP_ERROR');
  await rejects(at(async () => ({ status: 200, headers: {}, body: '<html>router</html>' })), 'NOT_DSM');
  await rejects(at(async () => json({ success: true, data: {} })), 'NOT_DSM'); // no SYNO.API.Auth in the API list
  for (const c of ['UNREACHABLE', 'TIMEOUT', 'TLS_CERT', 'HTTPS_REDIRECT', 'NOT_DSM']) assert.ok(dsm.NET_CODES.has(c));
});
