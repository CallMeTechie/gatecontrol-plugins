'use strict';

// A small Jellyfin admin client (10.9 – 10.11, tested against recorded answers of the spike M0). The server talks to
// Jellyfin only through the assigned home target "jellyfin" (gc.net.fetchTarget) and only with small JSON answers:
// server info, users, the configuration (Quick Connect), Quick Connect codes and the device list.
//
// The API key (Jellyfin › Dashboard › API-Schlüssel) counts as an administrator in Jellyfin (CustomAuthenticationHandler:
// IsApiKey → role Administrator), so it may confirm a Quick Connect code for another user
// (QuickConnectController.AuthorizeQuickConnect → RequestHelpers.GetUserId) and delete devices (Policy RequiresElevation).

const { fail, str } = require('./util');

const TARGET = 'jellyfin';
const MIN_VERSION = [10, 9, 0];
const SERVER_DEVICE_ID = 'gatecontrol-server';

/** The Authorization header of the server's own calls (values URL-encoded, as Jellyfin decodes them). */
function authHeader(key) {
  return 'MediaBrowser Client="GateControl", Device="GateControl%20Server", DeviceId="' + SERVER_DEVICE_ID + '", Version="1.0.0"'
    + (key ? ', Token="' + String(key).replace(/[^A-Za-z0-9]/g, '') + '"' : '');
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function versionOk(v) {
  const p = parseVersion(v);
  if (!p) return false;
  for (let i = 0; i < 3; i++) { if (p[i] !== MIN_VERSION[i]) return p[i] > MIN_VERSION[i]; }
  return true;
}

/** One request → { status, body (parsed JSON or text) }; network problems → jellyfin_unreachable. */
async function call(gc, index, method, path, o = {}) {
  let r;
  try {
    r = await gc.net.fetchTarget(TARGET, path, {
      index: index || 0,
      method,
      headers: { Authorization: authHeader(o.key), Accept: 'application/json' },
      ...(o.json !== undefined ? { json: o.json } : {}),
      timeoutMs: o.timeoutMs || 10000,
    });
  } catch (e) {
    const code = e && e.code;
    throw fail('jellyfin_unreachable', { reason: code === 'ERR_NET_DENIED' ? 'no_target' : (code === 'ERR_TIMEOUT' ? 'timeout' : 'network') });
  }
  let body = r.body;
  if (typeof body === 'string' && body) { try { body = JSON.parse(body); } catch { /* text */ } }
  return { status: r.status, body };
}

const ok2xx = (r) => r.status >= 200 && r.status < 300;
function expect2xx(r, what) {
  if (r.status === 401) throw fail('key_invalid');
  if (r.status === 403) throw fail('key_invalid', { reason: 'forbidden' });
  if (!ok2xx(r)) throw fail('jellyfin_error', { status: r.status, what });
  return r.body;
}

/** /System/Info/Public (no key) → { serverId, name, version, localAddress, versionOk } */
async function publicInfo(gc, index) {
  const r = await call(gc, index, 'GET', '/System/Info/Public');
  if (!ok2xx(r) || !r.body || typeof r.body !== 'object' || !r.body.Id) throw fail('jellyfin_unreachable', { reason: 'not_jellyfin' });
  return { serverId: str(r.body.Id, 64), name: str(r.body.ServerName, 80), version: str(r.body.Version, 20), localAddress: str(r.body.LocalAddress, 200) || null, versionOk: versionOk(r.body.Version) };
}

/** /System/Info with the key: the key is valid (else key_invalid). */
async function checkKey(gc, index, key) {
  const b = expect2xx(await call(gc, index, 'GET', '/System/Info', { key }), 'system');
  return { version: str(b && b.Version, 20) };
}

const userView = (u) => ({ id: str(u.Id, 64), name: str(u.Name, 80), admin: !!(u.Policy && u.Policy.IsAdministrator), disabled: !!(u.Policy && u.Policy.IsDisabled),
  downloads: !(u.Policy && u.Policy.EnableContentDownloading === false), maxRating: u.Policy && u.Policy.MaxParentalRating != null ? u.Policy.MaxParentalRating : null });

async function users(gc, index, key) {
  const b = expect2xx(await call(gc, index, 'GET', '/Users', { key }), 'users');
  return (Array.isArray(b) ? b : []).filter((u) => u && u.Id).map(userView);
}

async function user(gc, index, key, id) {
  const r = await call(gc, index, 'GET', '/Users/' + encodeURIComponent(id), { key });
  if (r.status === 404 || r.status === 400) return null;
  return userView(expect2xx(r, 'user'));
}

/** A new, normal user with a random password nobody sees (sign-in only through GateControl). */
async function createUser(gc, index, key, name) {
  const password = require('node:crypto').randomBytes(24).toString('base64url');
  const r = await call(gc, index, 'POST', '/Users/New', { key, json: { Name: name, Password: password } });
  if (r.status === 400) throw fail('name_taken');
  return userView(expect2xx(r, 'create'));
}

async function quickConnectEnabled(gc, index) {
  const r = await call(gc, index, 'GET', '/QuickConnect/Enabled');
  return ok2xx(r) ? r.body === true || r.body === 'true' : null;
}

/** Switch Quick Connect on/off in the server configuration (GET, change one key, POST the whole configuration). */
async function setQuickConnect(gc, index, key, on) {
  const cfg = expect2xx(await call(gc, index, 'GET', '/System/Configuration', { key }), 'config');
  if (!cfg || typeof cfg !== 'object') throw fail('jellyfin_error', { what: 'config' });
  expect2xx(await call(gc, index, 'POST', '/System/Configuration', { key, json: { ...cfg, QuickConnectAvailable: !!on } }), 'config');
  return !!on;
}

/**
 * Confirm a Quick Connect code for a user: 200 true. Jellyfin answers 404 for an unknown or expired code, 500 for a
 * code that was already confirmed, 401 when Quick Connect is off.
 */
async function authorize(gc, index, key, code, userId) {
  const r = await call(gc, index, 'POST', '/QuickConnect/Authorize?code=' + encodeURIComponent(code) + '&userId=' + encodeURIComponent(userId), { key });
  if (ok2xx(r)) return true;
  if (r.status === 401) {
    if (typeof r.body === 'string' && /quick connect/i.test(r.body)) throw fail('quick_connect_off');
    throw fail('key_invalid');
  }
  if (r.status === 404 || r.status === 500 || r.status === 400) throw fail('code_invalid');
  if (r.status === 403) throw fail('key_invalid', { reason: 'forbidden' });
  throw fail('jellyfin_error', { status: r.status, what: 'authorize' });
}

const deviceView = (d) => ({ id: str(d.Id, 100), name: str(d.Name, 120), userId: str(d.LastUserId, 64) || null, userName: str(d.LastUserName, 80) || null,
  app: str(d.AppName, 60) || null, lastActivity: str(d.DateLastActivity, 40) || null });

async function device(gc, index, key, id) {
  const r = await call(gc, index, 'GET', '/Devices/Info?id=' + encodeURIComponent(id), { key });
  if (r.status === 404 || r.status === 204) return null;
  const b = expect2xx(r, 'device');
  return b && b.Id ? deviceView(b) : null;
}

async function devices(gc, index, key, userId) {
  const b = expect2xx(await call(gc, index, 'GET', '/Devices' + (userId ? '?userId=' + encodeURIComponent(userId) : ''), { key }), 'devices');
  return ((b && Array.isArray(b.Items)) ? b.Items : []).filter((d) => d && d.Id).map(deviceView);
}

/** Delete a device: every session and token of it ends. → true (deleted) | false (unknown, 404). */
async function deleteDevice(gc, index, key, id) {
  const r = await call(gc, index, 'DELETE', '/Devices?id=' + encodeURIComponent(id), { key });
  if (r.status === 404) return false;
  expect2xx(r, 'delete');
  return true;
}

async function libraries(gc, index, key) {
  const b = expect2xx(await call(gc, index, 'GET', '/Library/VirtualFolders', { key }), 'libraries');
  return (Array.isArray(b) ? b : []).slice(0, 50).map((l) => ({ name: str(l && l.Name, 80), type: str(l && l.CollectionType, 30) || null }));
}

/**
 * One page of films and episodes with their media sources and streams ("Videos umwandeln", 1.5.0). The host takes an
 * answer of at most 5 MB from a home target, so the list comes in pages (StartIndex/Limit, oldest first so that
 * a file added during the scan lands at the end). `since` (ISO time) asks only for items changed since then (MinDateLastSaved).
 * → { items, total }
 */
async function itemsPage(gc, index, key, { start = 0, limit = 200, since = null } = {}) {
  const q = new URLSearchParams({
    Recursive: 'true', IncludeItemTypes: 'Movie,Episode', Fields: 'MediaSources,Path', SortBy: 'DateCreated,SortName', SortOrder: 'Ascending',
    StartIndex: String(Math.max(0, start | 0)), Limit: String(Math.max(1, Math.min(500, limit | 0))),
    EnableImages: 'false', EnableUserData: 'false', EnableTotalRecordCount: 'true', IsMissing: 'false',
  });
  if (since) q.set('MinDateLastSaved', since);
  const b = expect2xx(await call(gc, index, 'GET', '/Items?' + q.toString(), { key, timeoutMs: 30000 }), 'items');
  const items = b && Array.isArray(b.Items) ? b.Items.filter((x) => x && typeof x === 'object' && typeof x.Id === 'string') : [];
  return { items, total: b && Number.isSafeInteger(b.TotalRecordCount) ? b.TotalRecordCount : null };
}

/** The sessions active in the last few minutes (what is playing, whether Jellyfin converts it and how fast). */
async function sessions(gc, index, key) {
  const b = expect2xx(await call(gc, index, 'GET', '/Sessions?ActiveWithinSeconds=180', { key }), 'sessions');
  return Array.isArray(b) ? b.filter((x) => x && typeof x === 'object').slice(0, 200) : [];
}

module.exports = {
  TARGET, MIN_VERSION, authHeader, versionOk, parseVersion, publicInfo, checkKey, users, user, createUser, quickConnectEnabled, setQuickConnect,
  authorize, device, devices, deleteDevice, libraries, itemsPage, sessions,
};
