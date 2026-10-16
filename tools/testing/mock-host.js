'use strict';

// A mock of the GateControl plugin host for plugin unit tests (node:test).
//
// It loads the plugin's entry in-process and hands it a `gc` object with the
// shape of the real one (docs/plugins.md "Plugin code (host API)"). Like the
// real IPC every argument and result goes through JSON, and the host checks
// the permissions of plugin.json, throwing errors with the host's codes
// (ERR_NET_DENIED, ERR_STORAGE_DENIED, ERR_USERS_DENIED, ERR_NOTIFY_DENIED,
// ERR_RATE_LIMIT, ERR_INVALID). Database parameters follow the host's rules
// (a string at most 1 MB, a BLOB as { b64 } in parameters and rows). It does
// NOT reproduce the process sandbox, the network checks on resolved addresses
// or the real HTTP stack: network answers come from the handlers a test
// passes in.
//
//   const { createHost } = require('../../../tools/testing/mock-host');
//   const host = await createHost(path.join(__dirname, '..'), {
//     settings: { greeting: 'Hi' },                 // values (defaults from plugin.json are applied)
//     users: [{ id: 1, name: 'Ada', role: 'admin' }],
//     license: { required: false, licensed: true, state: 'valid', expiresAt: null },
//     fetch: async (url, opts) => ({ status: 200, body: '…' }),            // internet
//     targets: { gateway: [{ label: 'deCONZ', fetch: async (path, opts) => ({ status: 200, body: '{}' }) }] },
//     discover: async (data, opts) => [{ address: '192.168.1.5', port: 6445, data: Buffer }],
//   });
//   await host.start();
//   const res = await host.request({ method: 'GET', path: '/ping' });
//   host.logs, host.notifications, host.fetches; await host.close();
//   notifications: legacy gc.notify(message, { severity }) → { message, severity };
//   gc.notify({ topic, title, … }) (GateControl ≥ 1.154.0) → { topic, title, body,
//   priority, users, collapseKey, ttl, data } with the host's checks. Options:
//   notifyApi: 'legacy' emulates a GateControl < 1.154.0 (the child turns every
//   argument into a string), notifyFail: (n) => error code to throw instead.
//   await host.legacyImport(snapshot); await host.portalVisible({ id: 2, name: 'Ada', role: 'user' }, 'section-id');
//   await host.portalTiles(user); await host.portalSearch(user, 'lamp');
//   await host.quickActions(user); await host.runQuickAction(user, 'light:3');
//   quick actions of the apps (GateControl's src/services/plugins/quickActions.js):
//   the viewer is { portal: true, loggedIn: true, app: true, ...user }. Stricter
//   than the host, which drops or cuts what does not fit: an entry the host
//   would change throws ERR_INVALID here. runQuickAction lists again first
//   and answers like the host's route: { status: 404 } for an id that is not
//   listed for this viewer, else { status: 200, body: { ok, message, state, widget, unchanged } }.
//   Widgets (GateControl ≥ 1.171.0): an entry's optional `widget` { value, unit, status,
//   state, controls: [stepper | slider | choice] } is checked like the host's sanitizer
//   (which nulls a bad widget; here it throws) and comes back as `widget` (null without
//   one). host.runQuickAction(user, id, lang, { control, value }) runs a control as the
//   route does: an id the action's widget has no control for → { status: 400, body:
//   { ok: false, error: 'invalid_control' } }, a value outside min…max (stepper, slider)
//   or not an option id (choice) → 400 invalid_value; else the hook gets control/value.
//   Devices (GateControl ≥ 1.172.0): an entry's optional `device` { id, title, subtitle?, icon? }
//   (always in the answer, null without one), on a toggle `look` { on?: { icon?, tone? }, off? }
//   (tone good|warn|crit|neutral; answer { on, off } with null for a missing part, null without
//   one) and `confirmWhen` 'on'|'off' (null without); a button carrying look or confirmWhen
//   throws (the host nulls them). A widget may carry `label` (≤ 24), `readings` (≤ 4, each
//   { id, label, value?, unit?, icon?, state? } with value or icon; answer always a list) and
//   `power` (boolean, answer always a boolean, default true).
//   Start tiles: host.portalTiles(user) answers what the hook returned (the portal ignores
//   `items`), but a tile's `items` (≤ 4, { label, icon?, value?, unit?, state? } with value or
//   icon) are checked like the host; host.clientTiles(user) answers like the apps' GET
//   /api/v1/client/tiles: { section, title, value, unit, state, icon, items } (items [] without).
//   await host.appVisible(user)   (the app tab hook appVisible(user, gc); viewer { …user, portal, loggedIn, app: true })
//   permissions.notify { perHour } raises the mock's notification limit; a notifyTopics entry with
//   allowCritical keeps priority 'critical' (otherwise capped to 'high'), as GateControl ≥ 1.164.0.
//   permissions.kiosk (GateControl ≥ 1.165.0): gc.kiosk.allow(userId, allowed) and gc.kiosk.list()
//   (ERR_KIOSK_DENIED without the permission; ERR_INVALID for an unknown user, an administrator or a
//   user given as { disabled: true }, and for allowed not a boolean). host.kiosk is the plugin's set
//   of kiosk users; opts.kiosk: [userId] pre-fills it (what an earlier run left behind).
//   permissions.actions (GateControl ≥ 1.166.0): gc.actions.list({ userId, lang }) and
//   gc.actions.run({ userId, plugin, id, lang, state? }) — the quick actions of OTHER plugins, given by the test:
//     opts.actions: [{ plugin: 'gatecontrol-smarthome', pluginName: 'Smart Home',
//       quickActions: (viewer, lang) => [{ id, title, subtitle, kind, state, … }]   (or actions: [ … ])
//       runQuickAction: (viewer, id, lang) => ({ ok, message, state }) }]          (default { ok: true })
//   Checked like the host (src/services/plugins/hostApi.js): ERR_ACTIONS_DENIED without the
//   permission; ERR_INVALID for a userId that is not a positive integer of an enabled user, a lang
//   other than de/en, a bad or the caller's own plugin id, a bad action id; ERR_RATE_LIMIT after 60
//   runs per (mocked) hour. The target gets the viewer { id, name, role, portal: true, loggedIn: true,
//   automation: true, via: '<caller id>' }; a run that did not happen resolves { ok: false, message:
//   null, state: null, error: 'not_found'|'plugin_error' } (an id not listed for that viewer, an
//   unknown plugin, a hook that throws). host.actionRuns records { plugin, id, userId, lang, viewer, state, target, result }.
//   gc.users (GateControl ≥ 1.168.0): every user also has avatarUrl (string|null, a capability path
//   /avatars/<id>.<ext>), color (a key of the favourite colour palette, never red; default
//   palette[id % 10]), colorHex and initials (like GateControl: two words → first letters, one word →
//   its first two letters). A test sets them per user: { id, name, role, color: 'pink', avatarUrl:
//   '/avatars/…webp' }; an unknown colour key falls back to the default. host.setUserFace(id, { color,
//   avatarUrl }) changes them while the plugin runs (what the GateControl app's profile does).
//   Target states (GateControl ≥ 1.173.0): a toggle may declare `verbs` { on, off } (each 1–20 characters,
//   trimmed, no control characters, both — what setting each state is called as a command) and `targets`
//   (boolean: the hook honours an explicit `target`); a button carrying either throws (the host nulls them).
//   Every listed action carries verbs (object or null) and targets (boolean) — the hook's list, gc.actions.list
//   (whose items are { plugin, pluginName, id, title, subtitle, icon, kind, state, verbs, targets, device }).
//   host.runQuickAction(user, id, lang, { state: 'on'|'off' }) and gc.actions.run({ …, state }) run as the
//   host does (an unlisted id → 404 first; null / absent = a plain run): state with a control, on a button or
//   any other value → 400 invalid_state (gc.actions.run: { ok: false, …, error: 'invalid_state' }); on a toggle with targets: true the hook gets `target`; with
//   targets: false the listed state decides — the same → no hook call, 200 { ok: true, message: null, state,
//   widget (the listed one), unchanged: true }; the other → the hook runs as without state (it flips);
//   unknown (null) → 409 { ok: false, error: 'state_unknown' }. Every 200 answer and every gc.actions.run
//   result carries `unchanged` (false unless the no-op; a run that did not happen: { ok: false, message: null,
//   state: null, unchanged: false, error }). A test plugin of
//   opts.actions gets the target as runQuickAction(viewer, id, lang, { target }).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// GateControl's favourite colour palette (services/avatars.js PALETTE, GateControl ≥ 1.168.0)
const PALETTE = Object.freeze([
  ['blue', '#3B82F6'], ['teal', '#14B8A6'], ['green', '#22C55E'], ['lime', '#84CC16'], ['yellow', '#EAB308'],
  ['orange', '#F97316'], ['pink', '#EC4899'], ['purple', '#A855F7'], ['indigo', '#6366F1'], ['slate', '#64748B'],
].map(([key, hex]) => Object.freeze({ key, hex })));
const AVATAR_PATH_RE = /^\/avatars\/[A-Za-z0-9_-]{22,}\.(?:png|jpg|webp)$/;

function userInitials(name) {
  const words = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  const chars = words.length > 1 ? [Array.from(words[0])[0], Array.from(words[1])[0]] : Array.from(words[0]).slice(0, 2);
  return chars.join('').toUpperCase();
}

/** The face fields gc.users adds (GateControl ≥ 1.168.0). */
function userFace(u) {
  const p = PALETTE.find((x) => x.key === u.color) || PALETTE[u.id % PALETTE.length];
  if (u.avatarUrl != null && !AVATAR_PATH_RE.test(String(u.avatarUrl))) throw hostError('ERR_INVALID', 'mock host: avatarUrl must be /avatars/<22+ url-safe chars>.<png|jpg|webp>');
  return { avatarUrl: u.avatarUrl == null ? null : String(u.avatarUrl), color: p.key, colorHex: p.hex, initials: userInitials(u.name) };
}

const SQL_DENY = /\b(attach|detach|vacuum|pragma|load_extension|sqlite_dbpage|fts3_tokenizer)\b|_gc_/i;
const DEFAULT_USER = Object.freeze({ id: 1, name: 'admin', role: 'admin' });
const NOTIFY_PRIORITIES = ['info', 'normal', 'high', 'critical'];
const NOTIFY_ACTIONS = new Set(['open_app_route', 'open_portal', 'mute_1h', 'ack', 'done', 'quick_action']);
// GateControl ≥ 1.169.0: a picture on a push (notify_media), checked like services/avatars.js
const NOTIFY_IMAGE_MAX = 300 * 1024;
const NOTIFY_IMAGE_TTL_MAX = 7 * 86400;
const NOTIFY_IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const BACKGROUND_MIN_S = 5;
const QA_MAX = 16;
const QA_ID_RE = /^[A-Za-z0-9:._-]{1,64}$/;
const QA_ICON_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,2000}$/;
const QA_STATES = new Set(['on', 'off']);
const QA_WIDGET_STATES = new Set(['on', 'off', 'good', 'warn', 'crit']);
const QA_CONTROL_ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const QA_CONTROL_KINDS = new Set(['stepper', 'slider', 'choice']);
const QA_WIDGET_CONTROLS = 4;
const QA_TONES = new Set(['good', 'warn', 'crit', 'neutral']);
const QA_READINGS = 4;
const TILE_ITEMS = 4;
const TILE_STATES = new Set(['on', 'off', 'good', 'warn', 'crit']);
const PLUGIN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTIONS_PER_HOUR = 60;

function hostError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Width, height and animation of a JPEG / PNG / WebP picture from its header, or null when the bytes are not
 * a picture of that type (the checks of GateControl's services/avatars.js, GateControl ≥ 1.169.0 notify image).
 */
function imageInfo(buf, mime) {
  if (mime === 'image/png') {
    if (buf.length < 33 || buf.toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n' || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
    let animated = false;
    for (let i = 8; i + 8 <= buf.length;) {
      const len = buf.readUInt32BE(i);
      const type = buf.toString('latin1', i + 4, i + 8);
      if (type === 'acTL') animated = true;
      if (type === 'IDAT' || type === 'IEND') break;
      i += 12 + len;
    }
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), animated };
  }
  if (mime === 'image/jpeg') {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), animated: false };
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      i += 2 + len;
    }
    return null;
  }
  if (mime === 'image/webp') {
    if (buf.length < 30 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, animated: false };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, animated: false };
    }
    if (chunk === 'VP8X') {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), animated: (buf[20] & 0x02) !== 0 };
    }
    return null;
  }
  return null;
}

/** The checked picture of a push → { mime, size, width, height } or throws ERR_INVALID. */
function notifyImage(img) {
  if (!img || typeof img !== 'object' || Array.isArray(img) || typeof img.data !== 'string' || !NOTIFY_IMAGE_EXT[img.mime]) throw hostError('ERR_INVALID', 'invalid image');
  // a data: URL prefix is accepted as well
  const data = img.data.replace(/^data:[a-z/+.-]{1,40};base64,/i, '');
  if (data.length > Math.ceil(NOTIFY_IMAGE_MAX / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw hostError('ERR_INVALID', 'invalid image');
  const buf = Buffer.from(data, 'base64');
  if (!buf.length || buf.length > NOTIFY_IMAGE_MAX) throw hostError('ERR_INVALID', 'image too large (max 300 KB)');
  const info = imageInfo(buf, img.mime);
  if (!info) throw hostError('ERR_INVALID', 'image does not match its type');
  if (info.animated) throw hostError('ERR_INVALID', 'animated images are not allowed');
  if (![info.width, info.height].every((x) => Number.isInteger(x) && x >= 32 && x <= 2560)) throw hostError('ERR_INVALID', 'image size out of range (32…2560 px)');
  return { mime: img.mime, size: buf.length, width: info.width, height: info.height };
}

/** JSON round trip, as over the IPC channel (Buffers become { type, data }). */
function wire(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function parseHostEntry(raw) {
  const s = String(raw).trim().toLowerCase();
  const i = s.lastIndexOf(':');
  const hasPort = i >= 0 && (s.match(/:/g) || []).length === 1;
  const host = hasPort ? s.slice(0, i) : s;
  const ports = hasPort ? s.slice(i + 1).split(',').map((p) => {
    const [a, b] = p.trim().split('-').map(Number);
    return [a, b || a];
  }) : null;
  return host.startsWith('*.') ? { wildcard: true, host: host.slice(2), ports } : { wildcard: false, host, ports };
}

/** Is `url` allowed by permissions.network.internet? */
function internetAllowed(list, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return list.map(parseHostEntry).some((e) => {
    const hostOk = e.wildcard ? host.endsWith('.' + e.host) : host === e.host;
    return hostOk && (!e.ports || e.ports.some(([a, b]) => port >= a && port <= b));
  });
}

function networkOf(manifest) {
  const n = (manifest.permissions && manifest.permissions.network) || {};
  const obj = Array.isArray(n) ? { internet: n } : n;
  return { internet: obj.internet || [], homeTargets: obj.homeTargets || [], localDiscovery: obj.localDiscovery || null };
}

function settingDefaults(manifest) {
  const out = {};
  for (const s of (manifest.ui && manifest.ui.settings) || []) out[s.key] = s.default === undefined ? null : s.default;
  return out;
}

const SETTING_KEY_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
function settingKey(k) {
  return typeof k === 'string' && SETTING_KEY_RE.test(k) && !['__proto__', 'constructor', 'prototype'].includes(k);
}

// Statement parameters and result rows as in the host's database worker
// (src/services/plugins/dbWorker.js): a string parameter may be at most 1 MB,
// a BLOB travels as { b64: '<base64>' } both ways (no size limit of its own).
const DB_MAX_VALUE = 1024 * 1024;
function dbParam(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw hostError('ERR_INVALID', 'invalid parameter'); return v; }
  if (typeof v === 'string') { if (v.length > DB_MAX_VALUE) throw hostError('ERR_INVALID', 'parameter too long'); return v; }
  if (v && typeof v === 'object' && typeof v.b64 === 'string') return Buffer.from(v.b64, 'base64');
  throw hostError('ERR_INVALID', 'invalid parameter');
}
function dbParams(p) {
  if (p == null) return [];
  if (Array.isArray(p)) {
    if (p.length > 100) throw hostError('ERR_INVALID', 'too many parameters');
    return p.map(dbParam);
  }
  if (typeof p === 'object') {
    const keys = Object.keys(p);
    if (keys.length > 100) throw hostError('ERR_INVALID', 'too many parameters');
    const out = {};
    for (const k of keys) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw hostError('ERR_INVALID', 'invalid parameter name');
      out[k] = dbParam(p[k]);
    }
    return [out];
  }
  throw hostError('ERR_INVALID', 'invalid parameters');
}
function dbRow(row) {
  if (!row || typeof row !== 'object') return row;
  const o = {};
  for (const [k, v] of Object.entries(row)) o[k] = v instanceof Uint8Array ? { b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') } : (typeof v === 'bigint' ? Number(v) : v);
  return o;
}

function openDb(file) {
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch { return null; }
  return new sqlite.DatabaseSync(file);
}

// A text the host accepts unchanged (src/services/plugins/portal.js text()).
function qaText(v, max, what, optional) {
  if (v == null && optional) return null;
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\0-\x1f\x7f]/.test(v) || v !== v.trim()) {
    throw hostError('ERR_INVALID', `quick action: ${what} must be a trimmed string of 1–${max} characters, got ${JSON.stringify(v)}`);
  }
  return v;
}

function qaNumber(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw hostError('ERR_INVALID', `${what} must be a finite number, got ${JSON.stringify(v)}`);
  return v;
}

/**
 * A quick action's widget → what the host passes on (GateControl ≥ 1.171.0, quickActions.js
 * sanitizeWidget); null without one. The host nulls the whole widget where this throws ERR_INVALID
 * (and clamps a stepper/slider value into min…max, falls back to the first option of a choice).
 */
function checkQuickWidget(w, what) {
  if (w == null) return null;
  if (typeof w !== 'object' || Array.isArray(w)) throw hostError('ERR_INVALID', `${what}: widget must be an object`);
  const value = w.value == null ? null : (typeof w.value === 'number' ? qaNumber(w.value, `${what}: widget value`) : qaText(w.value, 24, `${what} widget value`));
  if (w.state != null && !QA_WIDGET_STATES.has(w.state)) throw hostError('ERR_INVALID', `${what}: widget state ${JSON.stringify(w.state)}`);
  const controls = [];
  if (w.controls != null) {
    if (!Array.isArray(w.controls) || w.controls.length > QA_WIDGET_CONTROLS) throw hostError('ERR_INVALID', `${what}: widget controls must be a list of at most ${QA_WIDGET_CONTROLS}`);
    const ids = new Set();
    for (const c of w.controls) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) throw hostError('ERR_INVALID', `${what}: control is not an object`);
      if (typeof c.id !== 'string' || !QA_CONTROL_ID_RE.test(c.id)) throw hostError('ERR_INVALID', `${what}: bad control id ${JSON.stringify(c.id)}`);
      if (ids.has(c.id)) throw hostError('ERR_INVALID', `${what}: duplicate control id ${c.id}`);
      ids.add(c.id);
      if (!QA_CONTROL_KINDS.has(c.kind)) throw hostError('ERR_INVALID', `${what}: control ${c.id}: bad kind ${JSON.stringify(c.kind)}`);
      const label = qaText(c.label, 20, `${what} control ${c.id} label`, true);
      if (c.kind === 'choice') {
        if (!Array.isArray(c.options) || c.options.length < 2 || c.options.length > 8) throw hostError('ERR_INVALID', `${what}: control ${c.id}: 2–8 options`);
        const oids = new Set();
        const options = c.options.map((o) => {
          if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !QA_CONTROL_ID_RE.test(o.id)) throw hostError('ERR_INVALID', `${what}: control ${c.id}: bad option id`);
          if (oids.has(o.id)) throw hostError('ERR_INVALID', `${what}: control ${c.id}: duplicate option ${o.id}`);
          oids.add(o.id);
          return { id: o.id, label: qaText(o.label, 20, `${what} control ${c.id} option ${o.id} label`) };
        });
        if (typeof c.value !== 'string' || !oids.has(c.value)) throw hostError('ERR_INVALID', `${what}: control ${c.id}: value ${JSON.stringify(c.value)} is no option`);
        controls.push({ id: c.id, kind: c.kind, label, value: c.value, options });
      } else {
        const [value, min, max, step] = ['value', 'min', 'max', 'step'].map((k) => qaNumber(c[k], `${what}: control ${c.id} ${k}`));
        if (!(min < max) || !(step > 0)) throw hostError('ERR_INVALID', `${what}: control ${c.id}: min < max and step > 0`);
        if (value < min || value > max) throw hostError('ERR_INVALID', `${what}: control ${c.id}: value ${value} outside ${min}…${max}`);
        controls.push({ id: c.id, kind: c.kind, label, value, min, max, step, unit: qaText(c.unit, 8, `${what} control ${c.id} unit`, true) });
      }
    }
  }
  if (w.power != null && typeof w.power !== 'boolean') throw hostError('ERR_INVALID', `${what}: widget power must be a boolean`);
  const readings = [];
  if (w.readings != null) {
    if (!Array.isArray(w.readings) || w.readings.length > QA_READINGS) throw hostError('ERR_INVALID', `${what}: widget readings must be a list of at most ${QA_READINGS}`);
    const ids = new Set();
    for (const r of w.readings) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw hostError('ERR_INVALID', `${what}: reading is not an object`);
      if (typeof r.id !== 'string' || !QA_CONTROL_ID_RE.test(r.id)) throw hostError('ERR_INVALID', `${what}: bad reading id ${JSON.stringify(r.id)}`);
      if (ids.has(r.id)) throw hostError('ERR_INVALID', `${what}: duplicate reading id ${r.id}`);
      ids.add(r.id);
      readings.push({ id: r.id, ...checkValueItem(r, 16, `${what} reading ${r.id}`) });
    }
  }
  return {
    label: qaText(w.label, 24, `${what} widget label`, true), value, unit: qaText(w.unit, 8, `${what} widget unit`, true),
    status: qaText(w.status, 60, `${what} widget status`, true), state: w.state == null ? null : w.state, controls, readings, power: w.power !== false,
  };
}

/**
 * A widget reading (without its id) or a Start tile item → { label, value, unit, icon, state } as the host passes it on
 * (GateControl ≥ 1.172.0); throws where the host drops it: label 1–20, value a text ≤ `valueMax` or a finite number,
 * unit ≤ 8, icon SVG path data, state on|off|good|warn|crit; a value or an icon.
 */
function checkValueItem(r, valueMax, what) {
  const label = qaText(r.label, 20, `${what} label`);
  const value = r.value == null ? null : (typeof r.value === 'number' ? qaNumber(r.value, `${what} value`) : qaText(r.value, valueMax, `${what} value`));
  if (r.icon != null && (typeof r.icon !== 'string' || !QA_ICON_RE.test(r.icon))) throw hostError('ERR_INVALID', `${what}: icon is not SVG path data`);
  if (r.state != null && !TILE_STATES.has(r.state)) throw hostError('ERR_INVALID', `${what}: state ${JSON.stringify(r.state)}`);
  if (value == null && r.icon == null) throw hostError('ERR_INVALID', `${what}: needs a value or an icon`);
  return { label, value, unit: qaText(r.unit, 8, `${what} unit`, true), icon: r.icon == null ? null : r.icon, state: r.state == null ? null : r.state };
}

/** A quick action's device → { id, title, subtitle, icon } (GateControl ≥ 1.172.0); null without one. */
function checkQuickDevice(d, what) {
  if (d == null) return null;
  if (typeof d !== 'object' || Array.isArray(d)) throw hostError('ERR_INVALID', `${what}: device must be an object`);
  if (typeof d.id !== 'string' || !QA_ID_RE.test(d.id)) throw hostError('ERR_INVALID', `${what}: bad device id ${JSON.stringify(d.id)}`);
  if (d.icon != null && (typeof d.icon !== 'string' || !QA_ICON_RE.test(d.icon))) throw hostError('ERR_INVALID', `${what}: device icon is not SVG path data`);
  return { id: d.id, title: qaText(d.title, 40, `${what} device title`), subtitle: qaText(d.subtitle, 60, `${what} device subtitle`, true), icon: d.icon == null ? null : d.icon };
}

/** A toggle's look → { on, off } (each { icon, tone } or null; GateControl ≥ 1.172.0); null without one. */
function checkQuickLook(l, what) {
  if (l == null) return null;
  if (typeof l !== 'object' || Array.isArray(l)) throw hostError('ERR_INVALID', `${what}: look must be an object`);
  const part = (p, k) => {
    if (p == null) return null;
    if (typeof p !== 'object' || Array.isArray(p)) throw hostError('ERR_INVALID', `${what}: look.${k} must be an object`);
    if (p.icon != null && (typeof p.icon !== 'string' || !QA_ICON_RE.test(p.icon))) throw hostError('ERR_INVALID', `${what}: look.${k}.icon is not SVG path data`);
    if (p.tone != null && !QA_TONES.has(p.tone)) throw hostError('ERR_INVALID', `${what}: look.${k}.tone ${JSON.stringify(p.tone)}`);
    if (p.icon == null && p.tone == null) throw hostError('ERR_INVALID', `${what}: look.${k} needs an icon or a tone`);
    return { icon: p.icon == null ? null : p.icon, tone: p.tone == null ? null : p.tone };
  };
  const out = { on: part(l.on, 'on'), off: part(l.off, 'off') };
  if (!out.on && !out.off) throw hostError('ERR_INVALID', `${what}: look without on or off`);
  return out;
}

/** A tile's text as the portal takes it (src/services/plugins/portal.js text()). */
function tileText(v, max) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\0-\x1f\x7f]/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/** A Start tile's items (GateControl ≥ 1.172.0) → what the client API passes on ([] without); throws where the host drops. */
function checkTileItems(items, what) {
  if (items == null) return [];
  if (!Array.isArray(items) || items.length > TILE_ITEMS) throw hostError('ERR_INVALID', `${what}: items must be a list of at most ${TILE_ITEMS}`);
  return items.map((it, i) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw hostError('ERR_INVALID', `${what}: item ${i} is not an object`);
    return checkValueItem(it, 16, `${what} item ${i}`);
  });
}

/** The checked `value` of a control run, or undefined where the route answers 400 invalid_value. */
function controlValue(c, v) {
  if (c.kind === 'choice') return typeof v === 'string' && c.options.some((o) => o.id === v) ? v : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= c.min && v <= c.max ? v : undefined;
}

/** A toggle's verbs → { on, off } (GateControl ≥ 1.173.0); null without; throws where the host nulls them. */
function checkQuickVerbs(v, what) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw hostError('ERR_INVALID', `${what}: verbs must be an object`);
  return { on: qaText(v.on, 20, `${what} verbs.on`), off: qaText(v.off, 20, `${what} verbs.off`) };
}

/** quickActions answer → the list the host passes on; throws ERR_INVALID where the host would drop or cut. */
function checkQuickActions(out) {
  if (!Array.isArray(out)) throw hostError('ERR_INVALID', 'quickActions must return an array');
  if (out.length > QA_MAX) throw hostError('ERR_INVALID', `quickActions: ${out.length} entries, at most ${QA_MAX}`);
  const seen = new Set();
  return out.map((a) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw hostError('ERR_INVALID', 'quick action: not an object');
    if (typeof a.id !== 'string' || !QA_ID_RE.test(a.id)) throw hostError('ERR_INVALID', `quick action: bad id ${JSON.stringify(a.id)}`);
    if (seen.has(a.id)) throw hostError('ERR_INVALID', `quick action: duplicate id ${a.id}`);
    seen.add(a.id);
    const kind = a.kind == null ? 'button' : a.kind;
    if (kind !== 'button' && kind !== 'toggle') throw hostError('ERR_INVALID', `quick action ${a.id}: bad kind ${JSON.stringify(a.kind)}`);
    if (a.state != null && (kind !== 'toggle' || !QA_STATES.has(a.state))) throw hostError('ERR_INVALID', `quick action ${a.id}: state ${JSON.stringify(a.state)} (only 'on'|'off' on a toggle)`);
    if (a.icon != null && (typeof a.icon !== 'string' || !QA_ICON_RE.test(a.icon))) throw hostError('ERR_INVALID', `quick action ${a.id}: icon is not SVG path data`);
    if (a.confirm != null && typeof a.confirm !== 'boolean') throw hostError('ERR_INVALID', `quick action ${a.id}: confirm must be a boolean`);
    // GateControl ≥ 1.172.0: look and confirmWhen only on a toggle (the host nulls them on a button)
    if (kind !== 'toggle' && (a.look != null || a.confirmWhen != null)) throw hostError('ERR_INVALID', `quick action ${a.id}: look/confirmWhen only on a toggle`);
    if (a.confirmWhen != null && !QA_STATES.has(a.confirmWhen)) throw hostError('ERR_INVALID', `quick action ${a.id}: confirmWhen ${JSON.stringify(a.confirmWhen)}`);
    // GateControl ≥ 1.173.0: verbs and targets only on a toggle (the host gives a button null / false)
    if (kind !== 'toggle' && (a.verbs != null || a.targets != null)) throw hostError('ERR_INVALID', `quick action ${a.id}: verbs/targets only on a toggle`);
    if (a.targets != null && typeof a.targets !== 'boolean') throw hostError('ERR_INVALID', `quick action ${a.id}: targets must be a boolean`);
    return {
      id: a.id, title: qaText(a.title, 40, `${a.id} title`), subtitle: qaText(a.subtitle, 60, `${a.id} subtitle`, true),
      icon: a.icon == null ? null : a.icon, kind, state: kind === 'toggle' && a.state != null ? a.state : null, confirm: a.confirm === true,
      confirmWhen: a.confirmWhen == null ? null : a.confirmWhen, look: checkQuickLook(a.look, `quick action ${a.id}`),
      verbs: checkQuickVerbs(a.verbs, `quick action ${a.id}`), targets: a.targets === true,
      device: checkQuickDevice(a.device, `quick action ${a.id}`),
      widget: checkQuickWidget(a.widget, `quick action ${a.id}`),
    };
  });
}

/**
 * @param {string} pluginDir  folder with plugin.json
 * @param {object} [opts]     see the header
 */
async function createHost(pluginDir, opts = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
  const perms = manifest.permissions || {};
  const net = networkOf(manifest);
  // permissions.kiosk: a boolean (GateControl ≥ 1.165.0, manifest.js)
  if (perms.kiosk != null && typeof perms.kiosk !== 'boolean') throw hostError('ERR_INVALID', 'plugin.json: permissions.kiosk: invalid');
  // permissions.actions: a boolean (GateControl ≥ 1.166.0, manifest.js)
  if (perms.actions != null && typeof perms.actions !== 'boolean') throw hostError('ERR_INVALID', 'plugin.json: permissions.actions: invalid');
  // permissions.background.intervalSeconds: 5 … 86400 (GateControl ≥ 1.169.0; 10 before)
  if (perms.background != null) {
    const iv = perms.background && perms.background.intervalSeconds;
    if (!Number.isInteger(iv) || iv < BACKGROUND_MIN_S || iv > 86400) throw hostError('ERR_INVALID', 'plugin.json: permissions.background.intervalSeconds: invalid');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `gcmock-${manifest.id}-`));
  const filesDir = path.join(tmp, 'files');
  fs.mkdirSync(filesDir);

  const logs = [];
  const notifications = [];
  const fetches = [];
  const kv = new Map();
  const settings = { ...settingDefaults(manifest), ...(opts.settings || {}) };
  const secrets = new Set(); // keys stored with gc.settings.setSecret (encrypted on the real host)
  const allUsers = (opts.users || [DEFAULT_USER]).map((u) => ({ id: u.id, name: u.name, role: u.role, disabled: u.disabled === true, ...userFace(u) }));
  // gc.users lists enabled accounts only (GateControl ≥ 1.168.0: with avatarUrl, color, colorHex, initials)
  const users = allUsers.filter((u) => !u.disabled).map(({ id, name, role, avatarUrl, color, colorHex, initials }) => ({ id, name, role, avatarUrl, color, colorHex, initials }));
  const license = { required: !!(manifest.license && manifest.license.required), licensed: true, state: 'valid', expiresAt: null, ...(opts.license || {}) };
  // permissions.notify: true (30 per hour) or { perHour: 1–120 } (GateControl ≥ 1.164.0); the mock counts all of a test
  const notifyLimit = perms.notify && typeof perms.notify === 'object' && Number.isInteger(perms.notify.perHour) ? perms.notify.perHour : 30;
  const kiosk = new Set((opts.kiosk || []).map(Number));
  const actionPlugins = (opts.actions || []).filter((p) => p && p.plugin !== manifest.id);
  const actionRuns = [];
  const actionRunAt = [];

  // Storage: the plugin's own SQLite database with its migrations applied.
  let db = null;
  if (perms.storage) {
    db = openDb(path.join(tmp, 'plugin.db'));
    if (db) {
      const mdir = path.join(pluginDir, manifest.migrations || 'migrations');
      if (fs.existsSync(mdir)) {
        const list = fs.readdirSync(mdir).map((f) => [f, /^(\d{1,6})_[A-Za-z0-9_-]{1,80}\.sql$/.exec(f)]).filter(([, m]) => m)
          .sort((a, b) => Number(a[1][1]) - Number(b[1][1]));
        for (const [f] of list) db.exec('BEGIN;' + fs.readFileSync(path.join(mdir, f), 'utf8') + ';COMMIT;');
      }
    }
  }
  const needStorage = () => {
    if (!perms.storage) throw hostError('ERR_STORAGE_DENIED', 'this plugin has no storage permission');
  };
  const needDb = (sql) => {
    needStorage();
    if (!db) throw hostError('ERR_INVALID', 'node:sqlite is not available in this Node.js version');
    if (typeof sql !== 'string' || !sql.trim() || SQL_DENY.test(sql)) throw hostError('ERR_INVALID', 'statement not allowed');
  };
  const declaredTarget = (id) => {
    const t = net.homeTargets.find((x) => x.id === id);
    if (!t) throw hostError('ERR_NET_DENIED', `target ${id} is not declared in plugin.json`);
    const assigned = (opts.targets && opts.targets[id]) || [];
    return { t, assigned };
  };
  const pickAssigned = (id, index) => {
    const { assigned } = declaredTarget(id);
    const a = assigned[Number(index) || 0];
    if (!a) throw hostError('ERR_NET_DENIED', `target ${id} is not assigned`);
    return a;
  };

  const api = {
    'http.fetch': async ({ url, opts: o }) => {
      if (!internetAllowed(net.internet, url)) throw hostError('ERR_NET_DENIED', `host not allowed: ${url}`);
      fetches.push({ url, opts: o });
      if (!opts.fetch) throw hostError('ERR_NET', 'no fetch handler in this test');
      const r = await opts.fetch(url, o);
      return { status: 200, headers: {}, url, redirects: [], ...r };
    },
    'targets.list': async () => net.homeTargets.map((t) => ({
      id: t.id, protocols: t.protocols, assigned: ((opts.targets && opts.targets[t.id]) || []).map((a, index) => ({ index, label: a.label || `${t.id} ${index}` })),
    })),
    'target.fetch': async ({ target, index, path: p, opts: o }) => {
      const { t } = declaredTarget(target);
      if (!t.protocols.includes('http')) throw hostError('ERR_NET_DENIED', `target ${target} has no http protocol`);
      const a = pickAssigned(target, index);
      fetches.push({ target, index: Number(index) || 0, path: p, opts: o });
      if (!a.fetch) throw hostError('ERR_NET', 'no fetch handler for this target');
      const r = await a.fetch(p, o);
      return { status: 200, headers: {}, redirects: [], ...r };
    },
    'target.udp': async ({ target, index, dataBase64, port }) => {
      const a = pickAssigned(target, index);
      if (!a.udp) throw hostError('ERR_NET', 'no udp handler for this target');
      const answers = await a.udp(Buffer.from(dataBase64, 'base64'), { port });
      return answers.map((x) => ({ address: x.address, port: x.port, dataBase64: Buffer.from(x.data).toString('base64') }));
    },
    discover: async ({ dataBase64, ports }) => {
      const allowed = (net.localDiscovery && net.localDiscovery.udp) || [];
      if (!allowed.length) throw hostError('ERR_NET_DENIED', 'no localDiscovery permission');
      for (const p of ports || []) if (!allowed.map(Number).includes(Number(p))) throw hostError('ERR_NET_DENIED', `port ${p} not declared`);
      if (!opts.discover) return [];
      const answers = await opts.discover(Buffer.from(dataBase64, 'base64'), { ports });
      return answers.map((x) => ({ address: x.address, port: x.port, dataBase64: Buffer.from(x.data).toString('base64') }));
    },
    'storage.get': async ({ key }) => { needStorage(); return kv.has(String(key)) ? wire(kv.get(String(key))) : null; },
    'storage.set': async ({ key, value }) => { needStorage(); kv.set(String(key), wire(value)); return null; },
    'storage.delete': async ({ key }) => { needStorage(); return kv.delete(String(key)); },
    'storage.list': async ({ prefix }) => { needStorage(); return [...kv.keys()].filter((k) => k.startsWith(prefix || '')).sort(); },
    'db.query': async ({ sql, params, mode }) => {
      needDb(sql);
      const stmt = db.prepare(sql);
      const args = dbParams(params);
      if (mode === 'run') {
        const r = stmt.run(...args);
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      }
      if (mode === 'get') return { row: dbRow(stmt.get(...args)) || null };
      return { rows: stmt.all(...args).map(dbRow), truncated: false };
    },
    'db.exec': async ({ sql }) => { needDb(sql); db.exec(sql); return null; },
    'settings.all': async () => ({ ...settings }),
    'settings.get': async ({ key }) => (Object.prototype.hasOwnProperty.call(settings, key) && settings[key] !== undefined ? settings[key] : null),
    'settings.set': async ({ key, value }) => {
      // like the host: declared keys plus the plugin's own (JSON) keys; no prototype names
      if (!settingKey(key)) throw hostError('ERR_INVALID', 'invalid setting');
      settings[key] = value === undefined ? null : value;
      return null;
    },
    'settings.setSecret': async ({ key, value }) => {
      if (!settingKey(key)) throw hostError('ERR_INVALID', 'invalid setting');
      const def = ((manifest.ui && manifest.ui.settings) || []).find((d) => d.key === key);
      if (def && def.type !== 'secret') throw hostError('ERR_INVALID', 'invalid setting');
      if (value != null && (typeof value !== 'string' || value.length > 4000)) throw hostError('ERR_INVALID', 'invalid secret');
      if (value == null || value === '') { delete settings[key]; secrets.delete(key); } else { settings[key] = value; secrets.add(key); }
      return null;
    },
    'users.list': async () => {
      if (!perms.users) throw hostError('ERR_USERS_DENIED', 'this plugin has no users permission');
      return users;
    },
    'users.get': async ({ id }) => {
      if (!perms.users) throw hostError('ERR_USERS_DENIED', 'this plugin has no users permission');
      return users.find((u) => u.id === Number(id)) || null;
    },
    notify: async ({ message, opts: o, notification: n }) => {
      if (!perms.notify) throw hostError('ERR_NOTIFY_DENIED', 'this plugin has no notify permission');
      if (opts.notifyFail) {
        const code = opts.notifyFail(n || { message });
        if (code) throw hostError(code, 'notify failed (test)');
      }
      if (n && typeof n === 'object' && !Array.isArray(n)) {
        // GateControl ≥ 1.154.0 (src/services/plugins/hostApi.js notify): same checks and codes
        const topic = n.topic == null ? 'default' : String(n.topic);
        const declared = Array.isArray(manifest.notifyTopics) ? manifest.notifyTopics : [];
        if (topic !== 'default' && !declared.some((t) => t && t.id === topic)) throw hostError('ERR_INVALID', 'topic not declared in notifyTopics');
        const title = String(n.title == null ? '' : n.title).replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!title) throw hostError('ERR_INVALID', 'empty title');
        const body = String(n.body == null ? '' : n.body).trim().slice(0, 1000);
        const priority = n.priority == null ? 'normal' : n.priority;
        if (!NOTIFY_PRIORITIES.includes(priority)) throw hostError('ERR_INVALID', 'invalid priority');
        if (n.users != null && !(Array.isArray(n.users) && n.users.length <= 100 && n.users.every((u) => Number.isSafeInteger(u) && u > 0))) throw hostError('ERR_INVALID', 'invalid users');
        if (n.collapseKey != null && !/^[A-Za-z0-9_.:@/-]{1,120}$/.test(String(n.collapseKey))) throw hostError('ERR_INVALID', 'invalid collapseKey');
        if (n.ttl != null && !(Number.isSafeInteger(n.ttl) && n.ttl >= 60 && n.ttl <= 30 * 86400)) throw hostError('ERR_INVALID', 'invalid ttl');
        if (n.data != null && (typeof n.data !== 'object' || Array.isArray(n.data))) throw hostError('ERR_INVALID', 'invalid data');
        const data = { route: `plg-${manifest.id}`, ...(n.data || {}) };
        if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 4096) throw hostError('ERR_INVALID', 'data too large (max 4 KB)');
        if (data.actions != null) {
          if (!Array.isArray(data.actions) || data.actions.length > 4) throw hostError('ERR_INVALID', 'invalid actions (test)');
          for (const a of data.actions) {
            if (!a || !NOTIFY_ACTIONS.has(a.type)) throw hostError('ERR_INVALID', 'unknown action type (test: the host would drop it)');
            if (a.type === 'open_app_route' && !/^(?:vpn|services|gateways|inbox|plg-[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(String(a.target))) throw hostError('ERR_INVALID', 'invalid app route (test)');
            // GateControl ≥ 1.169.0: run one of this plugin's own quick actions from the push
            if (a.type === 'quick_action') {
              if (typeof a.label !== 'string' || !a.label.trim() || a.label.length > 24) throw hostError('ERR_INVALID', 'quick_action: label must be 1–24 characters');
              if (a.plugin !== manifest.id) throw hostError('ERR_INVALID', 'quick_action: plugin must be the calling plugin');
              if (typeof a.id !== 'string' || !QA_ID_RE.test(a.id)) throw hostError('ERR_INVALID', 'quick_action: invalid id');
              if (a.confirm != null && typeof a.confirm !== 'boolean') throw hostError('ERR_INVALID', 'quick_action: confirm must be a boolean');
              if (a.auth != null && a.auth !== 'device') throw hostError('ERR_INVALID', "quick_action: auth must be 'device'");
            }
          }
        }
        const image = n.image == null ? null : notifyImage(n.image);
        if (notifications.length >= notifyLimit) throw hostError('ERR_RATE_LIMIT', 'too many notifications');
        // 'critical' is capped to 'high' unless the topic declares allowCritical (GateControl ≥ 1.164.0)
        const critical = priority === 'critical' && declared.some((t) => t && t.id === topic && t.allowCritical === true);
        const rec = {
          topic, title, body, priority: priority === 'critical' && !critical ? 'high' : priority,
          users: n.users == null ? null : [...new Set(n.users)], collapseKey: n.collapseKey == null ? null : String(n.collapseKey), ttl: n.ttl == null ? null : n.ttl, data,
        };
        if (image) {
          // notify_media: a capability URL (≥ 22 url-safe characters), expires with the push (24 h default, ≤ 7 days)
          const mediaId = require('node:crypto').randomBytes(18).toString('base64url');
          Object.assign(rec, { image, imageUrl: `/notify-media/${mediaId}.${NOTIFY_IMAGE_EXT[image.mime]}`, imageTtl: Math.min(n.ttl == null ? 86400 : n.ttl, NOTIFY_IMAGE_TTL_MAX) });
        }
        notifications.push(rec);
        return { pushed: true, id: notifications.length };
      }
      const msg = String(message || '').trim();
      if (!msg) throw hostError('ERR_INVALID', 'empty message');
      if (notifications.length >= notifyLimit) throw hostError('ERR_RATE_LIMIT', 'too many notifications');
      notifications.push({ message: msg, severity: (o && o.severity) || 'info' });
      return {};
    },
    'license.status': async () => ({ ...license }),
    // GateControl ≥ 1.165.0: users this plugin marks as kiosk devices (wall tablet …); never administrators or disabled users
    'kiosk.allow': async ({ userId, allowed }) => {
      if (perms.kiosk !== true) throw hostError('ERR_KIOSK_DENIED', 'this plugin has no kiosk permission');
      if (typeof allowed !== 'boolean') throw hostError('ERR_INVALID', 'allowed must be a boolean');
      const u = Number.isSafeInteger(userId) && userId > 0 ? allUsers.find((x) => x.id === userId) : null;
      if (!u || u.disabled || u.role === 'admin') throw hostError('ERR_INVALID', 'not a user that can be a kiosk device');
      if (allowed) kiosk.add(userId); else kiosk.delete(userId);
      return null;
    },
    'kiosk.list': async () => {
      if (perms.kiosk !== true) throw hostError('ERR_KIOSK_DENIED', 'this plugin has no kiosk permission');
      return [...kiosk].sort((a, b) => a - b);
    },
  };

  // gc.actions.* (GateControl ≥ 1.166.0, hostApi.js actionsList / actionsRun)
  const automationViewer = (args) => {
    if (perms.actions !== true) throw hostError('ERR_ACTIONS_DENIED', 'this plugin has no actions permission');
    const userId = args && args.userId;
    if (!Number.isSafeInteger(userId) || userId <= 0) throw hostError('ERR_INVALID', 'invalid user id');
    const lang = args.lang;
    if (!(lang == null || lang === 'de' || lang === 'en')) throw hostError('ERR_INVALID', "lang must be 'de' or 'en'");
    const u = allUsers.find((x) => x.id === userId);
    if (!u || u.disabled) throw hostError('ERR_INVALID', 'unknown or disabled user');
    return { user: { id: u.id, name: u.name, role: u.role, portal: true, loggedIn: true, automation: true, via: manifest.id }, lang: lang || 'de' };
  };
  const listOf = async (p, viewer, lang) => checkQuickActions(wire(typeof p.quickActions === 'function' ? await p.quickActions(wire(viewer), lang) : (p.actions || [])));
  api['actions.list'] = async (args) => {
    const { user, lang } = automationViewer(args);
    const out = [];
    for (const p of actionPlugins) {
      let list;
      try { list = await listOf(p, user, lang); } catch { continue; }
      for (const a of list) {
        out.push({
          plugin: p.plugin, pluginName: p.pluginName || p.plugin, id: a.id, title: a.title, subtitle: a.subtitle, icon: a.icon, kind: a.kind, state: a.state,
          verbs: a.verbs, targets: a.targets, device: a.device,
        });
      }
    }
    return out;
  };
  api['actions.run'] = async (args) => {
    if (perms.actions !== true) throw hostError('ERR_ACTIONS_DENIED', 'this plugin has no actions permission');
    const target = args && args.plugin;
    const actionId = args && args.id;
    if (typeof target !== 'string' || target.length < 2 || target.length > 64 || !PLUGIN_ID_RE.test(target)) throw hostError('ERR_INVALID', 'invalid plugin id');
    if (target === manifest.id) throw hostError('ERR_INVALID', 'a plugin cannot run its own quick actions');
    if (typeof actionId !== 'string' || !QA_ID_RE.test(actionId)) throw hostError('ERR_INVALID', 'invalid action id');
    const { user, lang } = automationViewer(args);
    const now = Date.now();
    while (actionRunAt.length && now - actionRunAt[0] >= 3600000) actionRunAt.shift();
    if (actionRunAt.length >= ACTIONS_PER_HOUR) throw hostError('ERR_RATE_LIMIT', 'too many quick action runs (60 per hour)');
    actionRunAt.push(now);
    const p = actionPlugins.find((x) => x.plugin === target);
    const state = args.state == null ? undefined : args.state;
    const failed = (error) => ({ ok: false, message: null, state: null, unchanged: false, error });
    let result;
    let target2 = null;
    if (!p) result = failed('not_found');
    else {
      try {
        const listed = await listOf(p, user, lang);
        const action = listed.find((a) => a.id === actionId);
        if (!action) result = failed('not_found');
        else if (state !== undefined && (!QA_STATES.has(state) || action.kind !== 'toggle')) result = failed('invalid_state');
        else if (state !== undefined && !action.targets && action.state === state) result = { ok: true, message: null, state, unchanged: true };
        else if (state !== undefined && !action.targets && action.state == null) result = failed('state_unknown');
        else {
          if (state !== undefined && action.targets) target2 = state;
          const extra = target2 ? [{ target: target2 }] : [];
          const out = wire(typeof p.runQuickAction === 'function' ? await p.runQuickAction(wire(user), actionId, lang, ...extra) : { ok: true });
          if (!out || typeof out !== 'object' || Array.isArray(out)) result = failed('plugin_error');
          else result = { ok: out.ok !== false, message: typeof out.message === 'string' ? out.message.slice(0, 120) : null, state: QA_STATES.has(out.state) ? out.state : null, unchanged: false };
        }
      } catch { result = failed('plugin_error'); }
    }
    actionRuns.push({ plugin: target, id: actionId, userId: user.id, lang, viewer: user, state: state === undefined ? null : state, target: target2, result });
    return result;
  };

  const call = async (name, args) => wire(await api[name](wire(args)));
  const log = (level) => (...a) => logs.push({ level, message: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') });

  const gc = Object.freeze({
    plugin: Object.freeze({ id: manifest.id, version: manifest.version, filesDir }),
    log: Object.freeze({ debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') }),
    http: Object.freeze({ fetch: (url, o) => call('http.fetch', { url: String(url), opts: o || {} }) }),
    net: Object.freeze({
      targets: () => call('targets.list', {}),
      fetchTarget: (id, p, o) => call('target.fetch', { target: String(id), index: o && o.index, path: String(p || '/'), opts: o || {} }),
      tcpTarget: async () => { throw hostError('ERR_NET', 'tcpTarget is not mocked; test it against a real GateControl'); },
      udpTarget: async (id, data, o) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        const list = await call('target.udp', { target: String(id), index: o && o.index, port: o && o.port, dataBase64: buf.toString('base64') });
        return list.map((x) => ({ address: x.address, port: x.port, data: Buffer.from(x.dataBase64, 'base64') }));
      },
      discover: async (data, o) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        const list = await call('discover', { dataBase64: buf.toString('base64'), ports: o && o.ports });
        return list.map((x) => ({ address: x.address, port: x.port, data: Buffer.from(x.dataBase64, 'base64') }));
      },
    }),
    storage: Object.freeze({
      get: (key) => call('storage.get', { key }),
      set: (key, value) => call('storage.set', { key, value }),
      delete: (key) => call('storage.delete', { key }),
      list: (prefix) => call('storage.list', { prefix }),
    }),
    db: Object.freeze({
      query: (sql, params) => call('db.query', { sql, params, mode: 'all' }),
      get: (sql, params) => call('db.query', { sql, params, mode: 'get' }),
      run: (sql, params) => call('db.query', { sql, params, mode: 'run' }),
      exec: (sql) => call('db.exec', { sql }),
    }),
    settings: Object.freeze({
      get: (key) => call('settings.get', { key }),
      all: () => call('settings.all', {}),
      set: (key, value) => call('settings.set', { key, value }),
      setSecret: (key, value) => call('settings.setSecret', { key, value: value == null ? null : String(value) }),
    }),
    users: Object.freeze({ list: () => call('users.list', {}), get: (id) => call('users.get', { id }) }),
    // like the child bootstrap: GateControl ≥ 1.154.0 passes an object on; older ones String() it
    notify: (message, o) => (opts.notifyApi !== 'legacy' && message && typeof message === 'object' && !Array.isArray(message)
      ? call('notify', { notification: message })
      : call('notify', { message: String(message), opts: o || {} })),
    license: Object.freeze({ status: () => call('license.status', {}) }),
    kiosk: Object.freeze({ allow: (userId, allowed) => call('kiosk.allow', { userId, allowed }), list: () => call('kiosk.list', {}) }),
    actions: Object.freeze({
      list: (o) => { const x = o && typeof o === 'object' ? o : {}; return call('actions.list', { userId: x.userId, lang: x.lang }); },
      run: (o) => { const x = o && typeof o === 'object' ? o : {}; return call('actions.run', { userId: x.userId, plugin: x.plugin, id: x.id, lang: x.lang, state: x.state }); },
    }),
  });

  const entry = path.join(pluginDir, manifest.entry);
  delete require.cache[require.resolve(entry)];
  const plugin = require(entry);
  const hook = async (name, ...a) => (typeof plugin[name] === 'function' ? wire(await plugin[name](...a.map(wire), gc)) : undefined);

  // the default req.user: the first user as a session knows it (no gc.users face fields)
  const sessionUser = () => (users[0] ? { id: users[0].id, name: users[0].name, role: users[0].role } : DEFAULT_USER);

  return {
    manifest, gc, plugin, logs, notifications, fetches, kv, settings, filesDir, kiosk, actionRuns,
    start: () => hook('start'),
    stop: () => hook('stop'),
    tick: () => hook('tick'),
    settingsChanged: (values) => hook('settingsChanged', values),
    /** portalVisible hook: false hides the portal tab (section = null) or a section for this viewer (no hook → true) */
    async portalVisible(user, section = null) {
      if (typeof plugin.portalVisible !== 'function') return true;
      return (await hook('portalVisible', { user: { portal: true, ...user }, lang: 'de', section })) !== false;
    },
    /** portalTiles hook: declarative Start tiles for this viewer (no hook → []) */
    // a tile's items are checked like the host (GateControl ≥ 1.172.0), the answer is the hook's own
    async portalTiles(user, lang = 'de') {
      if (typeof plugin.portalTiles !== 'function') return [];
      const out = await hook('portalTiles', { user: { portal: true, ...user }, lang });
      if (Array.isArray(out)) for (const t of out) if (t && typeof t === 'object') checkTileItems(t.items, `tile ${JSON.stringify(t.title)}`);
      return out;
    },
    /** the Start tiles as the apps get them (GET /api/v1/client/tiles, without key/plugin): items always a list */
    async clientTiles(user, lang = 'de') {
      const out = typeof plugin.portalTiles === 'function' ? await hook('portalTiles', { user: { portal: true, loggedIn: true, app: true, ...user }, lang }) : [];
      if (!Array.isArray(out)) return [];
      return out.slice(0, 8).filter((t) => t && typeof t === 'object' && tileText(t.title, 60)).map((t) => ({
        section: typeof t.section === 'string' ? t.section : null, title: tileText(t.title, 60), value: tileText(t.value, 40), unit: tileText(t.unit, 12),
        state: TILE_STATES.has(t.state) ? t.state : null, icon: typeof t.icon === 'string' && QA_ICON_RE.test(t.icon) ? t.icon : null,
        items: checkTileItems(t.items, `tile ${JSON.stringify(t.title)}`),
      }));
    },
    /** portalSearch hook: declarative search results for this viewer (no hook → []) */
    portalSearch: async (user, q, lang = 'de') => (typeof plugin.portalSearch === 'function' ? hook('portalSearch', { user: { portal: true, ...user }, lang, q }) : []),
    /** quickActions hook: the app's quick actions for this viewer, checked like the host (no hook → []) */
    async quickActions(user, lang = 'de') {
      if (!perms.portal || typeof plugin.quickActions !== 'function') return [];
      return checkQuickActions(await hook('quickActions', { user: { portal: true, loggedIn: true, app: true, ...user }, lang }));
    },
    /**
     * runQuickAction hook as the host's route runs it: only an id listed for this viewer → { status, body }.
     * o.via: 'app' (default) | 'notification' (GateControl ≥ 1.169.0: run from a push action); o.automation with
     * o.via '<plugin id>': as another plugin's gc.actions.run (viewer without app, automation: true, via).
     * o.state 'on'|'off' (GateControl ≥ 1.173.0): the target state of a toggle (see the header).
     */
    async runQuickAction(user, id, lang = 'de', o = {}) {
      const auto = o.automation === true;
      const via = auto ? String(o.via || 'gatecontrol-other') : (o.via === 'notification' ? 'notification' : 'app');
      if (auto && (!PLUGIN_ID_RE.test(via) || via === manifest.id)) throw hostError('ERR_INVALID', 'automation via must be another plugin id');
      const viewer = auto
        ? { id: user.id, name: user.name, role: user.role, portal: true, loggedIn: true, automation: true, via }
        : { portal: true, loggedIn: true, app: true, ...user };
      if (!perms.portal || typeof plugin.runQuickAction !== 'function' || typeof id !== 'string' || !QA_ID_RE.test(id)) return { status: 404, body: { ok: false, error: 'not_found' } };
      const listed = checkQuickActions(await hook('quickActions', { user: viewer, lang }));
      const action = listed.find((a) => a.id === id);
      if (!action) return { status: 404, body: { ok: false, error: 'not_found' } };
      const args = { user: viewer, lang, id, via, automation: auto };
      // GateControl ≥ 1.173.0: a target state for a toggle
      if (o.state != null) {
        if (!QA_STATES.has(o.state) || o.control !== undefined || action.kind !== 'toggle') return { status: 400, body: { ok: false, error: 'invalid_state' } };
        if (action.targets) args.target = o.state;
        else if (action.state === o.state) return { status: 200, body: { ok: true, message: null, state: o.state, widget: action.widget, unchanged: true } };
        else if (action.state == null) return { status: 409, body: { ok: false, error: 'state_unknown' } };
      }
      if (o.control !== undefined) {
        // GateControl ≥ 1.171.0: a control of the action's widget; never through gc.actions.run
        if (auto) throw hostError('ERR_INVALID', 'an automation run carries no control');
        const c = typeof o.control === 'string' && action.widget ? action.widget.controls.find((x) => x.id === o.control) : null;
        if (!c) return { status: 400, body: { ok: false, error: 'invalid_control' } };
        const value = controlValue(c, o.value);
        if (value === undefined) return { status: 400, body: { ok: false, error: 'invalid_value' } };
        args.control = c.id;
        args.value = value;
      }
      const out = await hook('runQuickAction', args);
      if (!out || typeof out !== 'object' || Array.isArray(out)) throw hostError('ERR_INVALID', 'runQuickAction must return an object');
      if (out.state != null && !QA_STATES.has(out.state)) throw hostError('ERR_INVALID', `runQuickAction: state ${JSON.stringify(out.state)}`);
      return {
        status: 200,
        body: { ok: out.ok !== false, message: qaText(out.message, 120, 'message', true), state: out.state == null ? null : out.state, widget: checkQuickWidget(out.widget, 'runQuickAction'), unchanged: false },
      };
    },
    /** appVisible hook (permissions.app + ui.app, GateControl ≥ 1.164.0): called as appVisible(user, gc) with the
        token owner; false (or an error) = no app tab for this person (no hook → true) */
    async appVisible(user) {
      if (typeof plugin.appVisible !== 'function') return true;
      try { return (await hook('appVisible', { portal: true, loggedIn: true, app: true, ...user })) !== false; } catch { return false; }
    },
    /** GateControl ≥ 1.168.0: change a user's colour / picture (as the app's profile does); gc.users answers with it from now on */
    setUserFace(id, face) {
      const i = users.findIndex((u) => u.id === id);
      if (i < 0) throw hostError('ERR_INVALID', 'mock host: unknown user');
      const f = face || {};
      const cur = users[i];
      const next = { ...cur, color: f.color === undefined ? cur.color : f.color, avatarUrl: f.avatarUrl === undefined ? cur.avatarUrl : f.avatarUrl };
      users[i] = { ...cur, ...userFace(next) };
    },
    /** legacyImport hook: the host hands over the built-in data (first-party plugins only) */
    legacyImport: (snapshot) => hook('legacyImport', snapshot),
    /** keys stored with gc.settings.setSecret */
    secrets,
    /** req = { method, path, query, body, user, lang } (defaults filled in); returns { status, json | html … } */
    async request(req) {
      const r = await hook('request', { method: 'GET', query: {}, body: null, user: sessionUser(), lang: 'de', ...req });
      return { status: 200, ...r };
    },
    /** view = { view: 'page'|'portal', page, section, user, lang, loggedIn } */
    render: (view) => hook('render', { view: 'page', page: 'main', user: sessionUser(), lang: 'de', ...view }),
    async close() {
      if (db) { db.close(); db = null; }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

module.exports = { createHost, internetAllowed, hostError, PALETTE };
