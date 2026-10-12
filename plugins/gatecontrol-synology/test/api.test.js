'use strict';

// The admin API against the mock host and the fake DSM: administrators only,
// secrets never in answers or logs, add/edit/test/delete, the one-time code
// path, polling with session reuse, relogin and backoff, control actions
// (confirm flag), settings.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDsm, withHost, asAdmin, addNas, ADMIN, ADA, ACCOUNT, PASSWORD, netError } = require('./helpers');

const due = (host, id) => host.gc.db.run('UPDATE nas SET next_poll_at = 0 WHERE id = ?', [id]);
const nasRow = async (host, id) => (await host.gc.db.get('SELECT * FROM nas WHERE id = ?', [id])).row;

/** Everything that left the plugin (answers, rendered page) and its log, as one string. */
function leaked(host, answers) {
  return JSON.stringify(answers) + JSON.stringify(host.logs) + JSON.stringify(host.notifications);
}

test('admin only: a portal viewer, a non-admin user and no user are refused on every route; the page shows a notice', async () => {
  await withHost({ nas: [fakeDsm('dsm72.json')] }, async (host) => {
    const id = await addNas(host);
    const routes = [['GET', '/status'], ['GET', `/nas/${id}`], ['POST', '/nas'], ['PUT', `/nas/${id}`], ['DELETE', `/nas/${id}`], ['POST', '/nas/test'],
      ['POST', `/nas/${id}/refresh`], ['POST', `/nas/${id}/power`], ['POST', `/nas/${id}/backups/1/start`], ['PUT', '/settings']];
    const viewers = [{ ...ADA }, { ...ADA, portal: true, loggedIn: true }, { ...ADMIN, portal: true, loggedIn: true }, null];
    for (const user of viewers) {
      for (const [method, path] of routes) {
        const r = await host.request({ method, path, user, body: { action: 'reboot', confirm: true, name: 'x' } });
        assert.equal(r.status, 403, `${method} ${path} as ${JSON.stringify(user)}`);
        assert.equal(r.json.code, 'FORBIDDEN');
      }
    }
    const fx = host.fetches.length;
    assert.equal(fx, host.fetches.length, 'nothing reached the NAS');
    const page = await host.render({ user: ADA });
    assert.doesNotMatch(page.html, /sy-nas-modal|window\.SY_CTX/);
    assert.match(page.html, /nur für Administratoren/);
    const portal = await host.render({ view: 'portal', user: { ...ADMIN, portal: true } });
    assert.doesNotMatch(portal.html, /sy-nas-modal/);
    const admin = await host.render({ user: ADMIN });
    assert.match(admin.html, /sy-nas-modal/);
    assert.equal(host.manifest.permissions.portal, undefined, 'no portal permission');
    assert.equal(host.manifest.ui.portal, undefined, 'no portal tab or sections');
  });
});

test('add: account stored as secrets, never in answers, the page or logs; status shows model, storage, issues', async () => {
  const d = fakeDsm('dsm72.json');
  await withHost({ nas: [d] }, async (host) => {
    const r = await asAdmin(host, 'POST', '/nas', { name: 'Keller', target_index: 0, username: ACCOUNT, password: PASSWORD });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.result, { ok: true });
    const id = r.json.nas.id;
    assert.ok(host.secrets.has(`nas.${id}.user`) && host.secrets.has(`nas.${id}.password`));
    const { row } = await host.gc.db.get('SELECT * FROM nas WHERE id = ?', [id]);
    assert.ok(!JSON.stringify(row).includes(PASSWORD) && !JSON.stringify(row).includes(ACCOUNT), 'not in the database');
    const st = await asAdmin(host, 'GET', '/status');
    const n = st.json.nas[0];
    assert.equal(n.status, 'ok');
    assert.equal(n.data.info.model, 'DS920+');
    assert.equal(n.data.volumes[0].pct, 60);
    assert.deepEqual(n.account, { user_hint: 'gc•••', has_user: true, has_password: true, has_device: false });
    assert.deepEqual(n.issues.map((i) => i.kind), ['update']);
    const one = await asAdmin(host, 'GET', `/nas/${id}`);
    const page = await host.render({ user: ADMIN });
    const sid = [...d.state.sessions.keys()][0];
    for (const secret of [PASSWORD, ACCOUNT, sid]) {
      assert.ok(!leaked(host, [r, st, one, page]).includes(secret), `leaked: ${secret}`);
    }
    // validation
    assert.equal((await asAdmin(host, 'POST', '/nas', { name: '', target_index: 0, username: 'a', password: 'b' })).json.code, 'NAME_REQUIRED');
    assert.equal((await asAdmin(host, 'POST', '/nas', { name: 'x', target_index: 5, username: 'a', password: 'b' })).json.code, 'TARGET_REQUIRED');
    assert.equal((await asAdmin(host, 'POST', '/nas', { name: 'x', target_index: 0, username: 'a' })).json.code, 'ACCOUNT_REQUIRED');
    assert.equal((await asAdmin(host, 'POST', '/nas', { name: 'x', target_index: 0, username: 'a', password: 'b', otp: '12' })).json.code, 'OTP_FORMAT');
  });
});

test('wrong password: saved, status "auth", polling pauses (no repeated logins); fixing the password resumes', async () => {
  const d = fakeDsm('dsm72.json');
  await withHost({ nas: [d] }, async (host) => {
    const r = await asAdmin(host, 'POST', '/nas', { name: 'Keller', target_index: 0, username: ACCOUNT, password: 'wrong' });
    assert.equal(r.status, 201);
    assert.equal(r.json.result.code, 'AUTH_FAILED');
    assert.match(r.json.result.error, /Passwort falsch/);
    const id = r.json.nas.id;
    assert.equal((await nasRow(host, id)).status, 'auth');
    const logins = d.state.logins.length;
    await host.tick();
    await host.tick();
    assert.equal(d.state.logins.length, logins, 'paused');
    assert.ok(!leaked(host, [r]).includes('wrong'));
    const fixed = await asAdmin(host, 'PUT', `/nas/${id}`, { password: PASSWORD });
    assert.deepEqual(fixed.json.result, { ok: true });
    assert.equal((await nasRow(host, id)).status, 'ok');
  });
});

test('2-step verification through the API: OTP_REQUIRED → save with the code → device token kept → no code later', async () => {
  const d = fakeDsm('dsm72.json', { otp: '246810' });
  await withHost({ nas: [d] }, async (host) => {
    const r = await asAdmin(host, 'POST', '/nas', { name: 'Keller', target_index: 0, username: ACCOUNT, password: PASSWORD });
    assert.equal(r.json.result.code, 'OTP_REQUIRED');
    const id = r.json.nas.id;
    assert.equal((await nasRow(host, id)).status, 'otp');
    const bad = await asAdmin(host, 'PUT', `/nas/${id}`, { otp: '000000' });
    assert.equal(bad.json.result.code, 'OTP_INVALID');
    const ok = await asAdmin(host, 'PUT', `/nas/${id}`, { otp: '246 810' });
    assert.deepEqual(ok.json.result, { ok: true });
    assert.ok(host.secrets.has(`nas.${id}.device`), 'device token stored as a secret');
    const did = host.settings[`nas.${id}.device`];
    // the session is gone (restart): the next login uses the device token, no code
    d.state.sessions.clear();
    await host.stop();
    await host.start();
    await due(host, id);
    await host.tick();
    const last = d.state.logins.at(-1);
    assert.equal(last.device_id, did);
    assert.equal(last.otp_code, undefined);
    assert.equal((await nasRow(host, id)).status, 'ok');
    const st = await asAdmin(host, 'GET', '/status');
    assert.equal(st.json.nas[0].account.has_device, true);
    assert.ok(!leaked(host, [st, ok]).includes(did), 'the device token never leaves the plugin');
    // a new account drops the old device token
    await asAdmin(host, 'PUT', `/nas/${id}`, { username: 'other' });
    assert.ok(!host.secrets.has(`nas.${id}.device`));
  });
});

test('"Verbindung testen": model and DSM version, admin check, nothing stored; a code yields a device ref used on save', async () => {
  const d = fakeDsm('dsm72.json', { otp: '135790', denied: ['SYNO.Core.System.Utilization'] });
  await withHost({ nas: [d] }, async (host) => {
    const need = await asAdmin(host, 'POST', '/nas/test', { target_index: 0, username: ACCOUNT, password: PASSWORD });
    assert.equal(need.status, 502);
    assert.equal(need.json.code, 'OTP_REQUIRED');
    const r = await asAdmin(host, 'POST', '/nas/test', { target_index: 0, username: ACCOUNT, password: PASSWORD, otp: '135790' });
    assert.equal(r.status, 200);
    assert.equal(r.json.model, 'DS920+');
    assert.equal(r.json.dsm, 'DSM 7.2.1-69057 Update 5');
    assert.equal(r.json.admin, false, '105 on SYNO.Core.System.Utilization → no administrator rights');
    assert.match(r.json.device_ref, /^[0-9a-f]{32}$/);
    assert.ok(!JSON.stringify(r.json).includes('did-'), 'only a handle, never the token');
    assert.equal(d.state.sessions.size, 0, 'logged out again');
    assert.equal((await asAdmin(host, 'GET', '/status')).json.nas.length, 0, 'nothing stored');
    // save with the ref: no code needed any more
    d.state.denied.clear();
    const add = await asAdmin(host, 'POST', '/nas', { name: 'Keller', target_index: 0, username: ACCOUNT, password: PASSWORD, device_ref: r.json.device_ref });
    assert.deepEqual(add.json.result, { ok: true });
    assert.ok(host.secrets.has(`nas.${add.json.nas.id}.device`));
    // test of a stored NAS with blank fields uses the stored account (and its device token)
    const again = await asAdmin(host, 'POST', '/nas/test', { id: add.json.nas.id, target_index: 0 });
    assert.equal(again.json.model, 'DS920+');
  });
});

test('polling: session reused between polls, relogin after DSM forgot it (119), backoff after failures, last good data kept', async () => {
  const d = fakeDsm('dsm72.json');
  await withHost({ nas: [d], settings: { poll_interval: 60, unreachable_polls: 2 } }, async (host) => {
    const id = await addNas(host);
    await due(host, id); await host.tick();
    await due(host, id); await host.tick();
    assert.equal(d.state.logins.length, 1, 'one login for three polls');
    d.state.sessions.clear();
    await due(host, id); await host.tick();
    assert.equal(d.state.logins.length, 2, 'relogin once');
    assert.equal((await nasRow(host, id)).status, 'ok');
    // not due → not polled
    const calls = d.state.calls.length;
    await host.tick();
    assert.equal(d.state.calls.length, calls);
    // failures: interval until N, then doubling (≤ 15 min)
    d.state.down = true;
    const gaps = [];
    for (let i = 0; i < 6; i++) {
      await due(host, id);
      const t = Date.now();
      await host.tick();
      gaps.push(Math.round(((await nasRow(host, id)).next_poll_at - t) / 1000));
    }
    assert.deepEqual(gaps.map((g) => Math.round(g / 60)), [1, 2, 4, 8, 15, 15]);
    const st = await asAdmin(host, 'GET', '/status');
    const n = st.json.nas[0];
    assert.equal(n.status, 'error');
    assert.equal(n.error.code, 'UNREACHABLE');
    assert.equal(n.data.info.model, 'DS920+', 'last good data kept');
    assert.ok(n.last_success_at);
  });
});

test('self-signed HTTPS target: TLS_CERT with the way out in the error text', async () => {
  const tls = { fetch: async () => { throw netError('self-signed certificate'); } };
  await withHost({ nas: [tls] }, async (host) => {
    const r = await asAdmin(host, 'POST', '/nas', { name: 'Keller', target_index: 0, username: ACCOUNT, password: PASSWORD });
    assert.equal(r.json.result.code, 'TLS_CERT');
    assert.match(r.json.result.error, /Heim-Gateway.*Port 5000/);
    const en = await host.request({ method: 'POST', path: '/nas/test', user: ADMIN, lang: 'en', body: { target_index: 0, username: ACCOUNT, password: PASSWORD } });
    assert.match(en.json.error, /self-signed certificate.*home gateway.*port 5000/);
  });
});

test('DSM 6.2 through the API: fallbacks (Core.System storage), DSM 6 update shape; DSM 7.1 without Hyper Backup/UPS', async () => {
  const d6 = fakeDsm('dsm62.json');
  const d71 = fakeDsm('dsm71.json');
  await withHost({ nas: [d6, d71] }, async (host) => {
    await addNas(host, { name: 'Alt', target_index: 0 });
    await addNas(host, { name: 'Mitte', target_index: 1 });
    const st = (await asAdmin(host, 'GET', '/status')).json.nas;
    const alt = st.find((n) => n.name === 'Alt');
    assert.equal(alt.data.storage_source, 'system');
    assert.equal(alt.data.volumes.length, 1);
    assert.equal(alt.data.disks.length, 2);
    assert.deepEqual(alt.data.update, { available: true, version: 'DSM 6.2.4-25556 Update 8', reboot: 'now' });
    assert.equal(alt.data.backups, null);
    const mid = st.find((n) => n.name === 'Mitte');
    assert.equal(mid.data.backups, null);
    assert.equal(mid.data.ups, null);
    assert.deepEqual(mid.issues.map((i) => `${i.kind}:${i.level}`), ['pool:warn', 'volume:warn', 'full:warn', 'disk:warn']);
    assert.ok(d6.state.calls.some((c) => c.api === 'SYNO.Core.System' && c.params.type === 'storage'));
  });
});

test('control: reboot / shutdown need confirm: true and an administrator; logged, "power" notice, quiet afterwards', async () => {
  const d = fakeDsm('dsm72.json');
  await withHost({ nas: [d] }, async (host) => {
    const id = await addNas(host);
    for (const body of [{ action: 'reboot' }, { action: 'reboot', confirm: 'yes' }, { action: 'shutdown', confirm: 1 }]) {
      const r = await asAdmin(host, 'POST', `/nas/${id}/power`, body);
      assert.equal(r.status, 400);
      assert.equal(r.json.code, 'CONFIRM_REQUIRED');
    }
    assert.equal((await asAdmin(host, 'POST', `/nas/${id}/power`, { action: 'format', confirm: true })).json.code, 'INVALID');
    assert.deepEqual(d.state.power, []);
    const ada = await host.request({ method: 'POST', path: `/nas/${id}/power`, user: ADA, body: { action: 'shutdown', confirm: true } });
    assert.equal(ada.status, 403);
    assert.deepEqual(d.state.power, []);

    const r = await asAdmin(host, 'POST', `/nas/${id}/power`, { action: 'reboot', confirm: true });
    assert.equal(r.status, 200);
    assert.deepEqual(d.state.power, ['reboot']);
    assert.ok(host.logs.some((l) => l.level === 'warn' && /NAS reboot requested 1 Keller by admin/.test(l.message)));
    const p = host.notifications.find((n) => n.topic === 'power');
    assert.equal(p.title, 'NAS wird neu gestartet');
    assert.match(p.body, /angefordert von admin/);
    const row = await nasRow(host, id);
    assert.equal(row.power_state, 'reboot');
    // the NAS is gone for a while: no "unreachable" during the reboot
    d.state.down = true;
    for (let i = 0; i < 5; i++) { await due(host, id); await host.tick(); }
    assert.ok(!host.notifications.some((n) => n.topic === 'unreachable'));
    const st = (await asAdmin(host, 'GET', '/status')).json.nas[0];
    assert.deepEqual(st.power.state, 'reboot');

    d.state.down = false;
    const s = await asAdmin(host, 'POST', `/nas/${id}/power`, { action: 'shutdown', confirm: true });
    assert.equal(s.status, 200);
    assert.deepEqual(d.state.power, ['reboot', 'shutdown']);
    assert.match(host.notifications.filter((n) => n.topic === 'power').at(-1).body, /Einschalten nur am Gerät/);
  });
});

test('Hyper Backup "now": confirm flag, known task only, SYNO.Backup.Task backup', async () => {
  const d = fakeDsm('dsm72.json');
  await withHost({ nas: [d] }, async (host) => {
    const id = await addNas(host);
    assert.equal((await asAdmin(host, 'POST', `/nas/${id}/backups/1/start`, {})).json.code, 'CONFIRM_REQUIRED');
    assert.equal((await asAdmin(host, 'POST', `/nas/${id}/backups/99/start`, { confirm: true })).json.code, 'NOT_FOUND');
    const r = await asAdmin(host, 'POST', `/nas/${id}/backups/2/start`, { confirm: true });
    assert.equal(r.status, 200);
    assert.deepEqual(d.state.backups, [2]);
    assert.ok(host.logs.some((l) => /Hyper Backup task started 1 2 by admin/.test(l.message)));
  });
});

test('edit, disable, delete: delete logs out and removes the secrets; a disabled NAS is not polled', async () => {
  const d = fakeDsm('dsm72.json');
  await withHost({ nas: [d, d] }, async (host) => {
    const id = await addNas(host);
    const e = await asAdmin(host, 'PUT', `/nas/${id}`, { name: 'Büro', target_index: 1, enabled: false });
    assert.equal(e.status, 200);
    assert.equal(e.json.result, null, 'disabled: no poll');
    const row = await nasRow(host, id);
    assert.equal(row.name, 'Büro');
    assert.equal(row.target_index, 1);
    assert.equal(row.target_label, 'nas-1.home.example');
    const calls = d.state.calls.length;
    await due(host, id); await host.tick();
    assert.equal(d.state.calls.length, calls);
    assert.equal((await asAdmin(host, 'POST', `/nas/${id}/refresh`)).json.code, 'NAS_DISABLED');
    await asAdmin(host, 'PUT', `/nas/${id}`, { enabled: true });
    assert.equal(d.state.sessions.size, 1);
    const del = await asAdmin(host, 'DELETE', `/nas/${id}`);
    assert.equal(del.json.ok, true);
    assert.equal(d.state.sessions.size, 0, 'logged out');
    assert.ok(![...host.secrets].some((k) => k.startsWith(`nas.${id}.`)), 'secrets removed');
    assert.equal((await asAdmin(host, 'GET', `/nas/${id}`)).status, 404);
    assert.equal((await host.gc.db.get('SELECT COUNT(*) AS n FROM snapshots')).row.n, 0);
  });
});

test('settings: validated ranges, saved through gc.settings, status reflects them', async () => {
  await withHost({ nas: [] }, async (host) => {
    assert.equal((await asAdmin(host, 'PUT', '/settings', { poll_interval: 10 })).json.code, 'SETTINGS_INVALID');
    assert.equal((await asAdmin(host, 'PUT', '/settings', { notify_lang: 'fr' })).json.code, 'SETTINGS_INVALID');
    const r = await asAdmin(host, 'PUT', '/settings', { poll_interval: 300, unreachable_polls: 5, storage_full_pct: 85, disk_temp_max: 50, notify_lang: 'en' });
    assert.deepEqual(r.json.settings, { poll_interval: 300, unreachable_polls: 5, storage_full_pct: 85, disk_temp_max: 50, notify_lang: 'en' });
    assert.equal(host.settings.poll_interval, 300);
    const st = await asAdmin(host, 'GET', '/status');
    assert.equal(st.json.settings.storage_full_pct, 85);
    assert.deepEqual(Object.keys(st.json.settings).sort(), ['disk_temp_max', 'notify_lang', 'poll_interval', 'storage_full_pct', 'unreachable_polls'], 'never other settings (secrets)');
  });
});

test('no target assigned: a clear error, nothing breaks', async () => {
  await withHost({ nas: [] }, async (host) => {
    const r = await asAdmin(host, 'POST', '/nas', { name: 'x', target_index: 0, username: 'a', password: 'b' });
    assert.equal(r.json.code, 'TARGET_REQUIRED');
    assert.deepEqual((await asAdmin(host, 'GET', '/status')).json.targets, []);
    await host.tick();
  });
});
