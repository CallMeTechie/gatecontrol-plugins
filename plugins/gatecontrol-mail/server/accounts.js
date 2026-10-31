'use strict';

// Accounts of a person (C2 "Konto, Status"): add one with a password (IMAP/SMTP — the login is tried first: IMAP, and
// SMTP with gc.mail.smtp.verify on GateControl ≥ 1.217.0) or with the Microsoft sign-in (code of the apps, device code of
// the portal), change it, sign in again, remove it with its copy.

const crypto = require('node:crypto');
const store = require('./store');
const config = require('./config');
const secrets = require('./secrets');
const providers = require('./providers');
const engine = require('./engine');
const ms = require('./microsoft');
const graph = require('./graph');
const mailstore = require('./mailstore');
const push = require('./push');
const avatars = require('./avatars');
const dav = require('./dav');
const pim = require('./pim');
const pimdav = require('./pimdav');
const pimstore = require('./pimstore');
const cardstore = require('./cardstore');
const { fail, email, line, clip, COLOR_RE, PALETTE } = require('./util');

const PUSH = ['off', 'relevant', 'all'];
const ATTS = ['off', 'suggest', 'auto'];
const DEVICE_RE = /^[0-9a-f]{24}$/;

/** A row → the Account of the API (avatar since 1.1.2: the picture at the provider, the plugin's media — or null). */
function view(a) {
  return {
    id: a.id, provider: a.provider, email: a.email, name: a.name || '', color: a.color, kind: a.kind === 'business' ? 'business' : 'personal',
    state: a.state, error: a.error_code ? { code: a.error_code, at: a.error_at } : null, push: a.push, ai: a.ai === 1,
    attachments: a.attachments, signature: a.signature || '', avatar: avatars.view(a),
  };
}

async function list(gc, userId) {
  return store.all(gc, 'SELECT * FROM accounts WHERE user_id = ? ORDER BY id', [userId]);
}

async function own(gc, userId, id) {
  const a = Number.isSafeInteger(id) ? await store.one(gc, 'SELECT * FROM accounts WHERE id = ? AND user_id = ?', [id, userId]) : null;
  if (!a) throw fail('not_found');
  return a;
}

const colorArg = (v, used) => (typeof v === 'string' && COLOR_RE.test(v) ? v.toUpperCase() : (PALETTE.find((c) => !used.includes(c)) || PALETTE[used.length % PALETTE.length]));
const kindArg = (v, dflt) => (v === 'business' || v === 'personal' ? v : dflt);
const nameArg = (v) => clip(line(v || ''), 80);

async function limitCheck(gc, cfg, userId) {
  const n = await store.one(gc, 'SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?', [userId]);
  if (n.n >= cfg.accountsMax) throw fail('limit', { max: cfg.accountsMax });
}

/**
 * gc.mail's refusal of a login → the API's code (409 auth_failed { hint } | imap_disabled | unreachable | tls). `server`
 * 'smtp': the SMTP check failed (the IMAP login worked) — the error names it ({ server: 'smtp' }).
 */
function loginFail(e, provider, lang, server = 'imap') {
  const code = e && e.code;
  const text = String((e && (e.serverText || e.message)) || '');
  const p = providers.get(provider);
  const hint = p && p.hint ? p.hint[lang === 'en' ? 'en' : 'de'] : null;
  const which = server === 'smtp' ? { server: 'smtp' } : {};
  if (code === 'ERR_MAIL_AUTH') {
    if (server === 'imap' && /imap.{0,40}(disabled|not enabled|nicht (aktiviert|freigeschaltet)|deaktiviert)|enable imap|web ?mail/i.test(text)) return fail('imap_disabled', { hint });
    return fail('auth_failed', { hint, ...which });
  }
  if (code === 'ERR_MAIL_NET' && /certificate|tls|ssl|handshake/i.test(text)) return fail('tls', which);
  if (code === 'ERR_MAIL_NET' || code === 'ERR_NETWORK_DENIED' || code === 'ERR_MAIL_PROTOCOL' || code === 'ERR_MAIL_LIMIT' || code === 'ERR_MAIL_REJECTED') {
    return fail('unreachable', { reason: code === 'ERR_NETWORK_DENIED' ? 'network_denied' : code === 'ERR_MAIL_LIMIT' ? 'busy' : 'network', ...which });
  }
  if (code === 'ERR_INVALID') return fail('invalid', { field: server });
  return e;
}

/** Can this GateControl check an SMTP login without sending (gc.mail.smtp.verify, ≥ 1.217.0)? */
const canVerify = (gc) => !!(gc.mail && gc.mail.smtp && typeof gc.mail.smtp.verify === 'function');

/**
 * The SMTP login with `pass` (GateControl ≥ 1.217.0; older hosts: checked with the first send) — closes the probed IMAP
 * session `s` when it fails, then throws the API's error.
 */
async function verifySmtp(gc, srv, user, pass, provider, lang, s) {
  if (!canVerify(gc)) return;
  try {
    await gc.mail.smtp.verify({ host: srv.host, port: srv.port, security: srv.security, auth: { user, pass }, timeoutMs: 30000 });
  } catch (e) {
    try { await s.close(); } catch { /* gone */ }
    throw loginFail(e, provider, lang, 'smtp');
  }
}

/** POST accounts { provider, email, password, username?, name?, color?, kind?, imap?, smtp? } → { account } */
async function add(gc, ctx, b) {
  const cfg = await config.get(gc);
  if (!gc.mail || !gc.mail.imap) throw fail('unreachable', { reason: 'no_mail_api' });
  const provider = typeof b.provider === 'string' ? b.provider : 'imap';
  const p = providers.get(provider);
  if (!p || providers.isMicrosoft(provider)) throw fail('invalid', { field: 'provider' });
  const addr = email(b.email);
  if (!addr) throw fail('invalid', { field: 'email' });
  if (typeof b.password !== 'string' || !b.password || b.password.length > 1000) throw fail('invalid', { field: 'password' });
  const username = b.username == null || b.username === '' ? null : clip(String(b.username).trim(), 254);
  const imapSrv = providers.server('imap', b.imap) || (provider !== 'imap' ? p.imap : null);
  const smtpSrv = providers.server('smtp', b.smtp) || (provider !== 'imap' ? p.smtp : null);
  if (!imapSrv) throw fail('invalid', { field: 'imap' });
  if (!smtpSrv) throw fail('invalid', { field: 'smtp' });
  await limitCheck(gc, cfg, ctx.userId);
  if (await store.one(gc, 'SELECT 1 AS x FROM accounts WHERE user_id = ? AND email = ?', [ctx.userId, addr])) throw fail('exists');
  // the login first (IMAP; SMTP with gc.mail.smtp.verify where GateControl has it)
  let s;
  const opts = { ...imapSrv, auth: { user: username || addr, pass: b.password }, timeoutMs: 30000 };
  try { s = await engine.probe(gc, opts); } catch (e) { throw loginFail(e, provider, ctx.lang); }
  await verifySmtp(gc, smtpSrv, username || addr, b.password, provider, ctx.lang, s);
  const used = (await list(gc, ctx.userId)).map((x) => x.color);
  const now = Date.now();
  const r = await store.run(gc, `INSERT INTO accounts (user_id, provider, email, name, color, kind, username, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security,
      state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'syncing', ?)`,
  [ctx.userId, provider, addr, nameArg(b.name) || ctx.userName || '', colorArg(b.color, used), kindArg(b.kind, 'personal'), username,
    imapSrv.host, imapSrv.port, imapSrv.security, smtpSrv.host, smtpSrv.port, smtpSrv.security, now]);
  const id = Number(r.lastInsertRowid);
  await secrets.set(gc, id, { password: b.password });
  const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [id]);
  engine.adopt(gc, a, s);
  kick(gc, a);
  return { account: view(a) };
}

/** The first sync in the background (the answer does not wait); Microsoft: the account's picture too (the lists follow). */
function kick(gc, a) {
  engine.syncInbox(gc, a).catch(() => {});
  // calendars and contacts with the next background run (1.2.0)
  pim.soon(a.id);
  if (providers.isMicrosoft(a.provider)) {
    avatars.refresh(gc, a).then((changed) => (changed ? push.changed(gc, a.user_id, a.id, null) : null)).catch(() => {});
  }
}

/** A Microsoft sign-in's tokens → a new account (or the same address again: signed in anew). */
async function fromMicrosoft(gc, ctx, info, b) {
  const cfg = await config.get(gc);
  if (!info.refreshToken) throw fail('auth_failed');
  const addr = email(info.email);
  const provider = info.business ? 'm365' : 'outlook';
  const kind = kindArg(b.kind, info.business ? 'business' : 'personal');
  const have = addr ? await store.one(gc, 'SELECT * FROM accounts WHERE user_id = ? AND email = ?', [ctx.userId, addr]) : null;
  // the scopes Microsoft granted (1.2.0): tokens are only ever renewed with these
  const scopes = (info.scopes || config.msScopes(cfg)).join(' ');
  if (have) {
    await secrets.set(gc, have.id, { refreshToken: info.refreshToken });
    await engine.forget(have.id);
    ms.remember(have.id, info);
    await store.run(gc, "UPDATE accounts SET state = 'syncing', error_code = NULL, error_at = NULL, ms_tenant = ?, ms_scopes = ? WHERE id = ?", [info.business ? info.tenant : null, scopes, have.id]);
    const a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [have.id]);
    kick(gc, a);
    return a;
  }
  await limitCheck(gc, cfg, ctx.userId);
  const used = (await list(gc, ctx.userId)).map((x) => x.color);
  const r = await store.run(gc, `INSERT INTO accounts (user_id, provider, email, name, color, kind, ms_tenant, ms_scopes, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'syncing', ?)`,
    [ctx.userId, provider, addr || 'unknown@outlook.com', nameArg(b.name) || clip(line(info.name), 80) || ctx.userName || '', colorArg(b.color, used), kind,
      info.business ? info.tenant : null, scopes, Date.now()]);
  const id = Number(r.lastInsertRowid);
  await secrets.set(gc, id, { refreshToken: info.refreshToken });
  ms.remember(id, info);
  let a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [id]);
  if (!addr) {
    // no address in the id token: ask Graph
    try { const me = await graph.me(gc, a); if (email(me.email)) await store.run(gc, 'UPDATE accounts SET email = ? WHERE id = ?', [email(me.email), id]); } catch { /* keep */ }
    a = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [id]);
  }
  kick(gc, a);
  return a;
}

/** POST accounts/microsoft { code, codeVerifier, redirectUri, name?, color?, kind? } → { account } */
async function addMicrosoft(gc, ctx, b) {
  // the limit is checked in fromMicrosoft: an address that is there already may always sign in anew
  const cfg = await config.get(gc);
  const info = await ms.redeem(gc, cfg, b);
  return { account: view(await fromMicrosoft(gc, ctx, info, b)) };
}

/** POST accounts/<id>/microsoft { code, codeVerifier, redirectUri } → { account } (signed in anew) */
async function reMicrosoft(gc, ctx, id, b) {
  const a = await own(gc, ctx.userId, id);
  if (!providers.isMicrosoft(a.provider)) throw fail('invalid', { field: 'provider' });
  const cfg = await config.get(gc);
  const info = await ms.redeem(gc, cfg, b);
  if (info.email && email(info.email) !== a.email) throw fail('invalid', { field: 'email', reason: 'other_account' });
  await secrets.set(gc, a.id, { refreshToken: info.refreshToken });
  await engine.forget(a.id);
  ms.remember(a.id, info);
  // the scopes granted now (1.2.0: a sign-in anew for calendars and contacts)
  await store.run(gc, "UPDATE accounts SET state = 'syncing', error_code = NULL, error_at = NULL, ms_scopes = ? WHERE id = ?", [(info.scopes || config.msScopes(cfg)).join(' '), a.id]);
  const now = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [a.id]);
  kick(gc, now);
  return { account: view(now) };
}

/**
 * POST accounts/microsoft/device { kind?, accountId? } → { deviceId, userCode, verificationUri, expiresIn, interval }.
 * `accountId` (1.3.0): an own Microsoft account signs in anew (the portal's „Neu anmelden“ for calendars and contacts) —
 * no new account, so the limit of accounts is not asked here (a new address still is, when it arrives).
 */
async function deviceStart(gc, ctx, b) {
  const cfg = await config.get(gc);
  const again = b && b.accountId != null ? await own(gc, ctx.userId, Number(b.accountId)) : null;
  if (again && !providers.isMicrosoft(again.provider)) throw fail('invalid', { field: 'accountId' });
  if (!again) await limitCheck(gc, cfg, ctx.userId);
  const d = await ms.deviceStart(gc, cfg);
  const id = crypto.randomBytes(12).toString('hex');
  const now = Date.now();
  await secrets.setDevice(gc, id, d.deviceCode);
  await store.run(gc, 'INSERT INTO ms_device (id, user_id, kind, interval_s, expires_at, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, ctx.userId, kindArg(b && b.kind, null), d.interval, now + d.expiresIn * 1000, now + d.interval * 1000, now]);
  return { deviceId: id, userCode: d.userCode, verificationUri: d.verificationUri, expiresIn: d.expiresIn, interval: d.interval };
}

/** GET accounts/microsoft/device/<id> → { status, account? } — asks Microsoft at most every `interval` seconds. */
async function devicePoll(gc, ctx, id) {
  if (!DEVICE_RE.test(String(id))) throw fail('not_found');
  const r = await store.one(gc, 'SELECT * FROM ms_device WHERE id = ? AND user_id = ?', [id, ctx.userId]);
  if (!r) throw fail('not_found');
  const now = Date.now();
  if (r.status === 'done') {
    const a = r.account_id ? await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [r.account_id]) : null;
    return { status: 'done', ...(a ? { account: view(a) } : {}) };
  }
  if (r.status !== 'pending') return { status: r.status };
  if (now > r.expires_at) {
    await store.run(gc, "UPDATE ms_device SET status = 'expired' WHERE id = ?", [id]);
    await secrets.removeDevice(gc, id);
    return { status: 'expired' };
  }
  if (now < r.next_at) return { status: 'pending' };
  const code = await secrets.getDevice(gc, id);
  if (!code) return { status: 'expired' };
  const cfg = await config.get(gc);
  const res = await ms.devicePoll(gc, cfg, code);
  if (res.status === 'pending') {
    const interval = res.slowDown ? r.interval_s + 5 : r.interval_s;
    await store.run(gc, 'UPDATE ms_device SET next_at = ?, interval_s = ? WHERE id = ?', [now + interval * 1000, interval, id]);
    return { status: 'pending' };
  }
  await secrets.removeDevice(gc, id);
  if (res.status !== 'done') {
    await store.run(gc, 'UPDATE ms_device SET status = ? WHERE id = ?', [res.status, id]);
    return { status: res.status };
  }
  const a = await fromMicrosoft(gc, ctx, res.info, { kind: r.kind });
  await store.run(gc, "UPDATE ms_device SET status = 'done', account_id = ? WHERE id = ?", [a.id, id]);
  return { status: 'done', account: view(a) };
}

/** PATCH accounts/<id> { name?, color?, kind?, push?, ai?, attachments?, signature?, password? } → { account } */
async function patch(gc, ctx, id, b) {
  const a = await own(gc, ctx.userId, id);
  const sets = [];
  const args = [];
  const set = (col, v) => { sets.push(`${col} = ?`); args.push(v); };
  if (b.name !== undefined) set('name', nameArg(b.name));
  if (b.color !== undefined) { if (!(typeof b.color === 'string' && COLOR_RE.test(b.color))) throw fail('invalid', { field: 'color' }); set('color', b.color.toUpperCase()); }
  if (b.kind !== undefined) { if (b.kind !== 'business' && b.kind !== 'personal') throw fail('invalid', { field: 'kind' }); set('kind', b.kind); }
  if (b.push !== undefined) { if (!PUSH.includes(b.push)) throw fail('invalid', { field: 'push' }); set('push', b.push); }
  if (b.ai !== undefined) { if (typeof b.ai !== 'boolean') throw fail('invalid', { field: 'ai' }); set('ai', b.ai ? 1 : 0); }
  if (b.attachments !== undefined) { if (!ATTS.includes(b.attachments)) throw fail('invalid', { field: 'attachments' }); set('attachments', b.attachments); }
  if (b.signature !== undefined) { if (typeof b.signature !== 'string' || b.signature.length > 4000) throw fail('invalid', { field: 'signature' }); set('signature', b.signature); }
  if (b.password !== undefined) {
    if (providers.isMicrosoft(a.provider) || typeof b.password !== 'string' || !b.password || b.password.length > 1000) throw fail('invalid', { field: 'password' });
    // the new password is tried first
    let s;
    try { s = await engine.probe(gc, { host: a.imap_host, port: a.imap_port, security: a.imap_security, auth: { user: a.username || a.email, pass: b.password }, timeoutMs: 30000 }); } catch (e) { throw loginFail(e, a.provider, ctx.lang); }
    if (a.smtp_host) await verifySmtp(gc, { host: a.smtp_host, port: a.smtp_port, security: a.smtp_security }, a.username || a.email, b.password, a.provider, ctx.lang, s);
    const old = await secrets.get(gc, a.id);
    await secrets.set(gc, a.id, { password: b.password, ...(old && old.davPassword ? { davPassword: old.davPassword } : {}) });
    await engine.forget(a.id);
    set('state', 'syncing'); set('error_code', null); set('error_at', null);
    if (sets.length) await store.run(gc, `UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, [...args, a.id]);
    const now = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [a.id]);
    engine.adopt(gc, now, s);
    kick(gc, now);
    return { account: view(now) };
  }
  await davPatch(gc, ctx, a, b, set);
  if (sets.length) await store.run(gc, `UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, [...args, a.id]);
  return { account: view(await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [a.id])) };
}

const DAV_KEYS = ['calendarSync', 'contactsSync', 'caldavUrl', 'carddavUrl', 'davUsername', 'davPassword', 'icsUrl'];

/**
 * PATCH accounts/<id> — the calendar and contact side (1.2.0): { calendarSync?, contactsSync?, caldavUrl?, carddavUrl?,
 * davUsername?, davPassword?, icsUrl? }. A new address or login is tried at once (PROPFIND / GET) → 409 auth_failed |
 * unreachable | dav_unavailable { reason }; the iCal address (Gmail, IMAP accounts) is a secret of the plugin.
 */
async function davPatch(gc, ctx, a, b, set) {
  if (!DAV_KEYS.some((k) => b[k] !== undefined)) return;
  const isMs = providers.isMicrosoft(a.provider);
  for (const k of ['calendarSync', 'contactsSync']) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw fail('invalid', { field: k });
  const url = (k) => {
    if (b[k] === undefined) return undefined;
    if (b[k] === null || b[k] === '') return null;
    if (isMs) throw fail('invalid', { field: k });
    const u = dav.httpsUrl(b[k]);
    if (!u) throw fail('invalid', { field: k });
    return u;
  };
  const caldav = url('caldavUrl');
  const carddav = url('carddavUrl');
  if (b.davUsername !== undefined && (isMs || (b.davUsername !== null && (typeof b.davUsername !== 'string' || b.davUsername.length > 254)))) throw fail('invalid', { field: 'davUsername' });
  if (b.davPassword !== undefined && (isMs || (b.davPassword !== null && (typeof b.davPassword !== 'string' || !b.davPassword || b.davPassword.length > 1000)))) throw fail('invalid', { field: 'davPassword' });
  if (b.icsUrl !== undefined && !['gmail', 'imap', 'tonline'].includes(a.provider)) throw fail('invalid', { field: 'icsUrl' });
  const ics = url('icsUrl');
  const t = { ...a };
  if (caldav !== undefined) t.caldav_url = caldav;
  if (carddav !== undefined) t.carddav_url = carddav;
  if (b.davUsername !== undefined) t.dav_username = b.davUsername ? clip(String(b.davUsername).trim(), 254) : null;
  const cred = (await secrets.get(gc, a.id)) || {};
  const pass = b.davPassword !== undefined ? (b.davPassword || cred.password) : (cred.davPassword || cred.password);
  const loginChanged = b.davUsername !== undefined || b.davPassword !== undefined;
  // the check: the addresses and the login that changed
  if (caldav || carddav || loginChanged) {
    if (!dav.can(gc)) throw fail('dav_unavailable', { reason: 'host_old' });
    const auth = { user: t.dav_username || t.username || t.email, pass };
    const kinds = [];
    if (caldav || (loginChanged && (t.caldav_url || pimdav.KNOWN[a.provider]))) kinds.push('caldav');
    if (carddav || (loginChanged && (t.carddav_url || pimdav.KNOWN[a.provider]))) kinds.push('carddav');
    for (const kind of kinds) {
      const base = kind === 'caldav' ? (caldav || t.caldav_url) : (carddav || t.carddav_url);
      await pimdav.discover(gc, t, kind, base || undefined, auth);
    }
  }
  let icsText = null;
  if (ics !== undefined && ics) {
    icsText = (await pimdav.fetchIcs(gc, ics)).text;
    require('./ics').split(icsText);
  }
  if (caldav !== undefined) set('caldav_url', caldav);
  if (carddav !== undefined) set('carddav_url', carddav);
  if (b.davUsername !== undefined) set('dav_username', t.dav_username);
  if (b.davPassword !== undefined) {
    const next = { ...cred };
    if (b.davPassword && b.davPassword !== cred.password) next.davPassword = b.davPassword; else delete next.davPassword;
    await secrets.set(gc, a.id, next);
  }
  if (b.calendarSync !== undefined) {
    set('calendar_sync', b.calendarSync ? 1 : 0);
    if (!b.calendarSync) for (const c of await store.all(gc, "SELECT * FROM calendars WHERE account_id = ? AND source <> 'ics'", [a.id])) await pimstore.dropCalendar(gc, c);
  }
  if (b.contactsSync !== undefined) {
    set('contacts_sync', b.contactsSync ? 1 : 0);
    if (!b.contactsSync) for (const x of await store.all(gc, 'SELECT * FROM addressbooks WHERE account_id = ?', [a.id])) await cardstore.dropBook(gc, x);
  }
  if (ics !== undefined) {
    for (const c of await store.all(gc, "SELECT * FROM calendars WHERE account_id = ? AND source = 'ics'", [a.id])) await pimstore.dropCalendar(gc, c);
    if (ics) await require('./calendars').createSubscription(gc, a.user_id, a.id, ics, { text: icsText });
  }
  if (caldav !== undefined || carddav !== undefined || loginChanged) await store.run(gc, 'DELETE FROM pim_state WHERE account_id = ?', [a.id]);
  pim.soon(a.id);
  await pimstore.live(gc, a.user_id, 'calendar', { kind: 'calendars' });
}

/** DELETE accounts/<id> → { ok } — the server's copy of the account goes (not the mail on the provider's server). */
async function remove(gc, ctx, id) {
  const a = await own(gc, ctx.userId, id);
  await engine.forget(a.id);
  // its calendars, address books, events, contacts and invitations here (the provider keeps everything) — 1.2.0
  await pim.dropAccount(gc, a);
  await secrets.remove(gc, a.id);
  await avatars.drop(gc, a);
  const ids = (await store.all(gc, 'SELECT id FROM messages WHERE account_id = ?', [a.id])).map((r) => r.id);
  await mailstore.remove(gc, ids);
  for (const d of await store.all(gc, 'SELECT id FROM drafts WHERE account_id = ?', [a.id])) {
    for (const t of await store.all(gc, 'SELECT media_id FROM draft_atts WHERE draft_id = ? AND media_id IS NOT NULL', [d.id])) { try { await gc.media.delete(t.media_id); } catch { /* gone */ } }
    await store.run(gc, 'DELETE FROM draft_atts WHERE draft_id = ?', [d.id]);
  }
  await store.run(gc, 'DELETE FROM drafts WHERE account_id = ?', [a.id]);
  await store.run(gc, 'DELETE FROM outbox WHERE account_id = ?', [a.id]);
  await store.run(gc, 'DELETE FROM folders WHERE account_id = ?', [a.id]);
  await store.run(gc, 'DELETE FROM accounts WHERE id = ?', [a.id]);
  await push.changed(gc, ctx.userId, a.id, null);
  return { ok: true };
}

module.exports = { view, list, own, add, addMicrosoft, reMicrosoft, deviceStart, devicePoll, patch, remove, loginFail };
