'use strict';

// 1.8 (gc.remote version 9): „Schlüssel automatisch einrichten“ — GateControl signs in once with a user and a password,
// puts its own key into authorized_keys (restricted with from="…" and no forwarding), tests it and switches the device to
// the key. The password goes from the administrator's browser through the plugin to GateControl and is dropped after
// the call: never in the vault, the plugin's database or a log, not even on an error. Only administrators, at most 5
// attempts per device in 10 minutes (GateControl counts the same).
//
//   POST   admin/devices/<id>/hostkey-scan   → { hostKey: { alg, sha256, pinned, matches? } } — the fingerprint first (3a)
//   POST   admin/devices/<id>/install-key    { username, password, account: self|root, sudoPassword?, confirm?, restrictFrom,
//                                              clearPassword, replaceOwnKey } → { result: { ok, steps, account, path, from,
//                                              fingerprint }, device }; an error → its code with { step, steps, attemptsLeft }
//   POST   admin/devices/<id>/test-key       → { result: { ok, steps, attemptsLeft, error? } } — a login with the key only (the copy way)
//   DELETE admin/devices/<id>/key            → { removedRemote, reason?, device } — the own line on the device, then the key in the vault
//
// Without version 9 the page offers „SSH-Schlüssel erzeugen“ as before (the public half to copy).

const devices = require('./devices');
const log = require('./log');
const { fail, fromHost, iso } = require('./util');

const SHA_RE = /^[A-Za-z0-9+/]{43}$/;
// the user name GateControl accepts (gc.remote.installKey)
const USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._@-]{0,63}$/;
const WINDOW_MS = 600000;
const MAX_TRIES = 5;
const tries = new Map(); // device id → timestamps of the attempts (this process)

const v9 = (gc) => !!(gc.remote && gc.remote.version >= 9 && typeof gc.remote.installKey === 'function');

function reset() { tries.clear(); }

function sshTarget(d) {
  if (d.protocol !== 'ssh' || d.kind !== 'target') throw fail('invalid', { field: 'protocol' });
  return devices.targetOf(d);
}

function attemptsLeft(id, now) {
  const list = (tries.get(id) || []).filter((t) => now - t < WINDOW_MS);
  tries.set(id, list);
  return Math.max(0, MAX_TRIES - list.length);
}

/** POST admin/devices/<id>/hostkey-scan */
async function scan(gc, id) {
  if (!v9(gc)) throw fail('offline');
  const d = await devices.need(gc, id);
  let k;
  try { k = await gc.remote.hostKeys.scan(sshTarget(d)); } catch (e) { throw fromHost(e); }
  if (!k || !SHA_RE.test(String(k.sha256 || '').replace(/^SHA256:/, ''))) throw fail('unreachable');
  return { alg: String(k.alg || ''), sha256: String(k.sha256).replace(/^SHA256:/, ''), pinned: !!k.pinned, ...(k.pinned ? { matches: k.matches !== false } : {}) };
}

/** The body of install-key, checked (the password is only passed on). */
function input(b) {
  const x = b && typeof b === 'object' ? b : {};
  const username = typeof x.username === 'string' ? x.username.trim() : '';
  if (!USER_RE.test(username)) throw fail('invalid', { field: 'username' });
  if (typeof x.password !== 'string' || !x.password || x.password.length > 1024) throw fail('invalid', { field: 'password' });
  const account = x.account === 'root' ? 'root' : 'self';
  if (x.account != null && x.account !== 'self' && x.account !== 'root') throw fail('invalid', { field: 'account' });
  if (x.sudoPassword != null && (typeof x.sudoPassword !== 'string' || !x.sudoPassword || x.sudoPassword.length > 1024)) throw fail('invalid', { field: 'sudoPassword' });
  const confirm = x.confirm == null ? null : String(x.confirm).replace(/^SHA256:/, '');
  if (confirm != null && !SHA_RE.test(confirm)) throw fail('invalid', { field: 'confirm' });
  return { username, password: x.password, account, sudoPassword: account === 'root' && x.sudoPassword ? x.sudoPassword : null, confirm,
    restrictFrom: x.restrictFrom !== false, clearPassword: x.clearPassword !== false, replaceOwnKey: x.replaceOwnKey === true };
}

const stepsOf = (r) => (Array.isArray(r && r.steps) ? r.steps.slice(0, 8).map((s) => ({ id: String(s.id || ''), state: String(s.state || ''), ms: Number.isFinite(s.ms) ? Math.round(s.ms) : null,
  detail: s.detail == null ? null : String(s.detail).slice(0, 200) })) : []);

/** POST admin/devices/<id>/install-key */
async function install(gc, user, id, b, now = Date.now()) {
  if (!v9(gc)) throw fail('offline');
  const d = await devices.need(gc, id);
  const target = sshTarget(d);
  const x = input(b);
  if (attemptsLeft(d.id, now) <= 0) throw fail('rate_limited', { attemptsLeft: 0 });
  tries.get(d.id).push(now);
  let r;
  try {
    r = await gc.remote.installKey(target, {
      ...(d.credential ? { credential: d.credential } : {}), login: { username: x.username, password: x.password }, account: x.account,
      ...(x.sudoPassword ? { sudoPassword: x.sudoPassword } : {}), ...(x.confirm ? { hostKey: { confirm: x.confirm } } : {}),
      restrictFrom: x.restrictFrom, replaceOwnKey: x.replaceOwnKey, keepPassword: !x.clearPassword,
    });
  } catch (e) {
    const err = fromHost(e);
    await log.write(gc, 'remote_key_install_failed', { device: d, userId: user.id, details: { code: err.code, step: null, sudo: x.account === 'root' } }, now);
    err.extra = { ...(err.extra || {}), attemptsLeft: attemptsLeft(d.id, now) };
    delete err.extra.message;
    throw err;
  }
  if (!r || r.ok !== true) {
    const code = r && r.error && typeof r.error.code === 'string' && /^[a-z_]{2,40}$/.test(r.error.code) ? r.error.code : 'internal';
    const step = r && r.error && typeof r.error.step === 'string' ? r.error.step.slice(0, 20) : null;
    await log.write(gc, 'remote_key_install_failed', { device: d, userId: user.id, details: { code, step, sudo: x.account === 'root' } }, now);
    // password_auth_off / not_posix: GateControl's key is in the vault now, the line comes for the copy way
    if (r && typeof r.credential === 'string' && r.credential && r.credential !== d.credential) {
      const fresh0 = await devices.need(gc, id);
      fresh0.credential = r.credential;
      fresh0.credentialUnreadable = false;
      await devices.write(gc, fresh0, now);
    }
    throw fail(code, { step, steps: stepsOf(r), attemptsLeft: left(r, d.id, now), ...(r && r.rolledBack ? { rolledBack: true } : {}),
      ...(r && typeof r.line === 'string' && r.line.length < 2000 ? { line: r.line } : {}), ...(r && r.fromGuessed ? { fromGuessed: true } : {}),
      ...(r && Number.isFinite(r.retryAfter) ? { retryAfter: Math.round(r.retryAfter) } : {}) });
  }
  const fresh = await devices.need(gc, id);
  if (typeof r.credential === 'string' && r.credential && r.credential !== fresh.credential) { fresh.credential = r.credential; fresh.credentialUnreadable = false; }
  const from = Array.isArray(r.from) ? r.from.filter((a) => typeof a === 'string' && /^[0-9a-fA-F.:/]{2,50}$/.test(a)).slice(0, 8) : [];
  const fp = r.fingerprint && typeof r.fingerprint === 'object' ? { alg: String(r.fingerprint.alg || ''), sha256: String(r.fingerprint.sha256 || '') } : null;
  const account = typeof r.user === 'string' && r.user ? r.user.slice(0, 64) : (x.account === 'root' ? 'root' : x.username);
  fresh.config.key = { auto: true, account, sudo: x.account === 'root',
    path: typeof r.path === 'string' ? r.path.slice(0, 200) : null, from, fingerprint: fp, installedAt: iso(now), installedBy: user.id, passwordCleared: x.clearPassword };
  delete fresh.config.last_auth_failed;
  await devices.write(gc, fresh, now);
  let hostKey = r.hostKey && typeof r.hostKey === 'object' ? { alg: String(r.hostKey.alg || ''), sha256: String(r.hostKey.sha256 || '') } : null;
  if (!hostKey) { try { const p = ((await gc.remote.hostKeys.list()) || []).find((k) => k.targetId === 'dev-' + d.id); hostKey = p ? { alg: p.alg, sha256: p.sha256 } : null; } catch { hostKey = null; } }
  await log.write(gc, 'remote_key_installed', { device: fresh, userId: user.id, details: { account: fresh.config.key.account, sudo: x.account === 'root', from, key: fp, host: hostKey } }, now);
  tries.delete(d.id);
  return { ok: true, steps: stepsOf(r), account: fresh.config.key.account, path: fresh.config.key.path, from, fingerprint: fp, hostKey };
}

/** DELETE admin/devices/<id>/key — the own line goes on the device (signed in with the key), then the key in the vault. */
async function remove(gc, user, id, now = Date.now()) {
  if (!v9(gc)) throw fail('offline');
  const d = await devices.need(gc, id);
  const target = sshTarget(d);
  if (!d.credential) throw fail('key_missing');
  let removedRemote = false;
  let reason = null;
  try {
    const r = await gc.remote.removeKey(target, { credential: d.credential });
    removedRemote = !!(r && r.removedRemote);
    if (!removedRemote) reason = r && typeof r.reason === 'string' ? r.reason.slice(0, 40) : 'unreachable';
  } catch (e) { gc.log.info('key not removed on the device', (e && e.code) || 'error'); reason = fromHost(e).code; }
  try { await gc.remote.vault.put({ handle: d.credential, privateKey: null, passphrase: null }); } catch (e) { throw fromHost(e); }
  const fresh = await devices.need(gc, id);
  const before = fresh.config.key || null;
  delete fresh.config.key;
  await devices.write(gc, fresh, now);
  await log.write(gc, 'remote_key_removed', { device: fresh, userId: user.id, details: { removedRemote, reason, account: before ? before.account : null } }, now);
  return { removedRemote, reason, comment: 'gatecontrol:dev-' + d.id };
}

/** POST admin/devices/<id>/test-key — a login with GateControl's key only (after the line was put in by hand). */
async function test(gc, user, id, now = Date.now()) {
  if (!v9(gc) || typeof gc.remote.testKey !== 'function') throw fail('offline');
  const d = await devices.need(gc, id);
  const target = sshTarget(d);
  if (!d.credential) throw fail('key_missing');
  let r;
  try { r = await gc.remote.testKey(target, { credential: d.credential }); } catch (e) { throw fromHost(e); }
  const ok = !!(r && r.ok === true);
  if (ok && d.config.last_auth_failed) { delete d.config.last_auth_failed; await devices.write(gc, d, now); }
  const code = !ok && r && r.error && typeof r.error.code === 'string' && /^[a-z_]{2,40}$/.test(r.error.code) ? r.error.code : null;
  return { ok, steps: stepsOf(r), attemptsLeft: Number.isInteger(r && r.attemptsLeft) ? r.attemptsLeft : null, ...(ok ? {} : { error: { code: code || 'internal', step: r && r.error ? r.error.step || null : null } }) };
}

/** The attempts left: GateControl's count when it says so, else this process's. */
function left(r, id, now) {
  return r && Number.isInteger(r.attemptsLeft) ? r.attemptsLeft : attemptsLeft(id, now);
}

/** The line for authorized_keys of the copy way (password login off, Windows): from the hub inside the VPN. */
async function lineFor(gc, d, publicKey) {
  if (!publicKey) return null;
  let from = null;
  if (d.config.access_mode !== 'gateway' && typeof gc.remote.hubAddress === 'function') { try { from = await gc.remote.hubAddress(); } catch { from = null; } }
  const opts = (from ? 'from="' + from + '",' : '') + 'no-agent-forwarding,no-X11-forwarding,no-port-forwarding';
  const key = String(publicKey).trim().split(/\s+/).slice(0, 2).join(' ');
  return opts + ' ' + key + ' gatecontrol:dev-' + d.id;
}

module.exports = { v9, scan, install, remove, test, lineFor, reset, attemptsLeft, MAX_TRIES };
