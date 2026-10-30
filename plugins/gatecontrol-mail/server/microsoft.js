'use strict';

// Microsoft accounts (outlook.com, Microsoft 365): sign-in as a public client (no secret) with PKCE — the apps open the
// sign-in in the system browser and send the code here (POST accounts/microsoft), the portal uses the device code
// (POST accounts/microsoft/device). The server redeems the code at the token endpoint and keeps the refresh token as a
// secret; access tokens live in memory and are renewed before they end. Mail itself goes through Microsoft Graph
// (graph.microsoft.com, gc.http.fetch).

const config = require('./config');
const secrets = require('./secrets');
const { fail } = require('./util');

const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const TIMEOUT = 30000;

const tokens = new Map(); // account id → { token, until }

function scope() { return config.MS_SCOPES.join(' '); }

async function post(gc, tenant, path, form) {
  let r;
  try {
    r = await gc.http.fetch(`${LOGIN}/${tenant || 'common'}/oauth2/v2.0/${path}`, { method: 'POST', form, timeoutMs: TIMEOUT });
  } catch (e) {
    throw fail('unreachable', { reason: (e && e.code) || 'network' });
  }
  let body = {};
  try { body = typeof r.body === 'string' ? JSON.parse(r.body || '{}') : (r.body || {}); } catch { body = {}; }
  return { status: r.status, body };
}

/** The claims of an id_token (it came from Microsoft's token endpoint over TLS — read, not verified again). */
function claims(idToken) {
  try {
    const p = String(idToken || '').split('.')[1];
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) || {};
  } catch { return {}; }
}

/** A token answer → { refreshToken, accessToken, expiresIn, email, name, tenant, business }. */
function tokenInfo(body) {
  const c = claims(body.id_token);
  const addr = String(c.email || c.preferred_username || '').toLowerCase();
  return {
    refreshToken: body.refresh_token || null, accessToken: body.access_token || null, expiresIn: Number(body.expires_in) || 3600,
    email: addr, name: typeof c.name === 'string' ? c.name : '', tenant: typeof c.tid === 'string' ? c.tid : null,
    business: !!(c.tid && c.tid !== CONSUMER_TENANT),
  };
}

function clientIdOr(cfg) {
  const id = config.msClientId(cfg);
  if (!id) throw fail('microsoft_off');
  return id;
}

/** POST accounts/microsoft — the code of the apps' sign-in (PKCE). */
async function redeem(gc, cfg, b) {
  const clientId = clientIdOr(cfg);
  const code = typeof b.code === 'string' ? b.code : '';
  const verifier = typeof b.codeVerifier === 'string' ? b.codeVerifier : '';
  const redirect = typeof b.redirectUri === 'string' ? b.redirectUri : '';
  if (!code || code.length > 4096) throw fail('invalid', { field: 'code' });
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw fail('invalid', { field: 'codeVerifier' });
  if (!/^(msauth:\/\/com\.gatecontrol\.client\/[A-Za-z0-9%._~+=-]{1,200}|http:\/\/localhost(:\d{1,5})?(\/[A-Za-z0-9._~/-]{0,100})?)$/.test(redirect)) throw fail('invalid', { field: 'redirectUri' });
  const r = await post(gc, 'common', 'token', {
    client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, scope: scope(),
  });
  if (r.status !== 200 || !r.body.refresh_token) throw fail('auth_failed', { reason: String(r.body.error || 'token').slice(0, 60) });
  return tokenInfo(r.body);
}

/** POST accounts/microsoft/device → Microsoft's device code. */
async function deviceStart(gc, cfg) {
  const clientId = clientIdOr(cfg);
  const r = await post(gc, 'common', 'devicecode', { client_id: clientId, scope: scope() });
  if (r.status !== 200 || !r.body.device_code) throw fail('unreachable', { reason: String(r.body.error || 'devicecode').slice(0, 60) });
  return {
    deviceCode: r.body.device_code, userCode: String(r.body.user_code || ''), verificationUri: String(r.body.verification_uri || 'https://microsoft.com/devicelogin'),
    expiresIn: Number(r.body.expires_in) || 900, interval: Math.max(5, Number(r.body.interval) || 5),
  };
}

/** One poll of a device code → { status: 'pending'|'done'|'expired'|'denied', info? , slowDown? }. */
async function devicePoll(gc, cfg, deviceCode) {
  const clientId = clientIdOr(cfg);
  const r = await post(gc, 'common', 'token', { client_id: clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode });
  if (r.status === 200 && r.body.refresh_token) return { status: 'done', info: tokenInfo(r.body) };
  const err = String(r.body.error || '');
  if (err === 'authorization_pending') return { status: 'pending' };
  if (err === 'slow_down') return { status: 'pending', slowDown: true };
  if (err === 'expired_token') return { status: 'expired' };
  return { status: 'denied' };
}

/** A valid access token for account `a` (renewed with the refresh token when needed); auth_failed when it is gone. */
async function accessToken(gc, a, force = false) {
  const have = tokens.get(a.id);
  if (!force && have && have.until > Date.now() + 60000) return have.token;
  const cfg = await config.get(gc);
  const clientId = config.msClientId(cfg);
  const cred = await secrets.get(gc, a.id);
  if (!clientId || !cred || !cred.refreshToken) throw Object.assign(fail('auth_failed'), { auth: true });
  const r = await post(gc, a.ms_tenant || 'common', 'token', { client_id: clientId, grant_type: 'refresh_token', refresh_token: cred.refreshToken, scope: scope() });
  if (r.status !== 200 || !r.body.access_token) {
    const e = String(r.body.error || '');
    if (e === 'invalid_grant' || e === 'interaction_required' || e === 'invalid_client' || e === 'unauthorized_client') throw Object.assign(fail('auth_failed'), { auth: true });
    throw fail('unreachable', { reason: e || String(r.status) });
  }
  if (r.body.refresh_token && r.body.refresh_token !== cred.refreshToken) await secrets.set(gc, a.id, { refreshToken: r.body.refresh_token });
  tokens.set(a.id, { token: r.body.access_token, until: Date.now() + (Number(r.body.expires_in) || 3600) * 1000 });
  return r.body.access_token;
}

function forget(accountId) { tokens.delete(accountId); }

/** Remember a fresh token of a sign-in (no refresh needed right after it). */
function remember(accountId, info) {
  if (info && info.accessToken) tokens.set(accountId, { token: info.accessToken, until: Date.now() + info.expiresIn * 1000 });
}

/**
 * A Graph request for account `a` → { status, json, headers }. `path` relative to v1.0 or an absolute graph URL (a nextLink).
 * 401 renews the token once; 429 / 503 → fail('busy', { retryAfter }). extra: { headers, bodyMedia, timeoutMs } — bodyMedia
 * (GateControl ≥ 1.217.0) sends a media file of the plugin with `body` as the JSON around it (graph.js attachments).
 */
async function graph(gc, a, method, path, body, extra = {}) {
  const url = /^https:\/\/graph\.microsoft\.com\//.test(path) ? path : GRAPH + path;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(gc, a, attempt > 0);
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json', ...(extra.headers || {}) };
    let r;
    try {
      r = await gc.http.fetch(url, { method, headers, ...(body !== undefined ? { json: body } : {}), ...(extra.bodyMedia ? { bodyMedia: extra.bodyMedia } : {}),
        timeoutMs: extra.timeoutMs || TIMEOUT });
    } catch (e) {
      throw fail('unreachable', { reason: (e && e.code) || 'network' });
    }
    if (r.status === 401 && attempt === 0) continue;
    if (r.status === 401 || r.status === 403) throw Object.assign(fail('auth_failed'), { auth: r.status === 401 });
    if (r.status === 429 || r.status === 503) throw fail('busy', { retryAfter: Number((r.headers || {})['retry-after']) || 30 });
    let json = null;
    if (r.body) { try { json = typeof r.body === 'string' ? JSON.parse(r.body) : r.body; } catch { json = null; } }
    return { status: r.status, json, headers: r.headers || {} };
  }
  throw fail('auth_failed');
}

/** Graph's own error code of an answer (for logs; never its text). */
const graphError = (r) => (r && r.json && r.json.error && typeof r.json.error.code === 'string' ? r.json.error.code.slice(0, 60) : String(r && r.status));

module.exports = { redeem, deviceStart, devicePoll, accessToken, graph, graphError, forget, remember, claims, tokenInfo, GRAPH, CONSUMER_TENANT };
