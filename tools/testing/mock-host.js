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
//     // GateControl ≥ 1.184.0: gc.http.websocket — peer.send(text | Buffer) / peer.close(code, reason)
//     // reach the plugin; the returned { message(data), close(code) } get what the plugin sends
//     websocket: async (url, opts, peer) => ({ message: (data) => peer.send(data) }),
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
//   `power` (boolean, answer always a boolean, default true). Badge (GateControl ≥ 1.175.0): a
//   widget's optional `badge` { icon, value?, unit?, state?, label? } (icon SVG path data, value a
//   text ≤ 8 or a number, unit ≤ 4 and only with a value, state good|warn|crit, label ≤ 20; the
//   widget's last key, always in the answer, null without one; where the host nulls the badge or a
//   part of it this throws) — shown right of the device name in the widget head.
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
//   gc.actions.run({ userId, plugin, id, lang, state? }) — the quick actions of OTHER plugins, given by the test
//   (opts.actionsApi: false → no gc.actions at all. GateControl ≥ 1.180.0 via opts.gatecontrol: permissions.actions may be
//   { interactive: true }; list items also carry actionId, label, needsConfirm, confirmWhen; run takes actionId
//   '<plugin>/<id>' (not with plugin + id), via, interactive (with { interactive: true } only, else ERR_ACTIONS_DENIED:
//   the target gets the viewer { …, automation: false, interactive: true, via }) and answers { ok, result, code };
//   60 runs per minute; gc.services.call payloads up to 512 KB):
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
//
// Messenger foundations (GateControl ≥ 1.177.0, src/services/plugins/{media,events}.js, hostApi.js):
//   Media — plugin.json `media` { maxBytes (1024…100 MB), types (1–32 MIME types, never HTML/XML/SVG/JS/CSS/JSON/form),
//   quotaDefault ("10GB", "500 MB" or bytes; 1 MB…1 TB, ≥ maxBytes; default 1 GB) } is validated like the host.
//   host.upload(user, Buffer, mime) is the upload of an app or a frame (PUT …/plugins/<id>/media) →
//   { status: 200, body: { ok: true, mediaId (32 hex), mime, bytes } } or the host's refusals { status, body: { ok: false,
//   code } }: 404 not_found (no `media`), 415 unsupported_type, 411 length_required (empty), 413 too_large,
//   507 quota_exceeded (opts.mediaQuota overrides quotaDefault, as an administrator would). host.media is the store
//   (Map id → { mime, bytes, owner, data, claimed, createdAt }). gc.media.info(id) → { mediaId, mime, bytes, sha256,
//   owner, createdAt, claimed } | null; claim(id) (idempotent; unknown → ERR_INVALID); delete(id) → boolean;
//   usage() → { bytes, count, quota, maxBytes, types }; url(id, { user, ttlS }) → '/plugin-media/<id>.<exp>.<uid>.<sig>'
//   (ttlS 60…86400, default 3600, exp rounded up to 5 minutes; unknown id / bad user / ttlS → ERR_INVALID); without
//   `media` every call → ERR_MEDIA_DENIED. host.mediaGet(user, mediaId, { range: 'bytes=a-b' }) answers like GET
//   /api/v1/client/plugins/<id>/media/<mediaId>: the hook mediaAccess({ user (app viewer), mediaId, owner, mime })
//   decides (true only; no hook → the uploader only; a throwing hook → no) → { status: 200|206|404|416, headers, body }.
//   host.mediaFromUrl(url, { range, now }) answers like /plugin-media/<token> (404 once expired, deleted or unknown).
//   host.mediaCleanup(now) removes unclaimed files older than 24 h (as the host's hourly job) → count.
//   GateControl ≥ 1.190.0 (opts.gatecontrol): gc.media.fetch(url, { headers, mime, name, maxBytes, timeoutMs }) — a file
//   from the internet straight into the store (allowlist like http.fetch → ERR_NET_DENIED; opts.fetch(url, { method:
//   'GET', headers, binary: true }) answers { status, headers, body (Buffer | string) }; not 2xx → ERR_HTTP (status);
//   > min(maxBytes, media.maxBytes) → ERR_MEDIA_TOO_LARGE; type = mime || the answer's content-type, not in media.types
//   → ERR_MEDIA_TYPE; quota → ERR_MEDIA_QUOTA; an empty body → ERR_MEDIA_EMPTY) → { mediaId, mime, bytes, name }: unclaimed, no owner (only mediaAccess
//   lets anybody read it); `name` (cleaned file name) comes back in info() and as the filename of Content-Disposition.
//   media.uploads: false (≥ 1.190.0) → host.upload answers 403 uploads_disabled.
//   Realtime events — permissions.events: gc.events.emit({ users (1–500 ids), type ([a-z][a-z0-9._-]{0,63}), data
//   (JSON ≤ 4 KB) }) → { delivered } (one stream per listed user, or opts.connected(userId) → number of streams);
//   ERR_EVENTS_DENIED / ERR_INVALID / ERR_RATE_LIMIT (600 per minute). host.events records { users, type, data }.
//   Chat notifications — a notifyTopics entry with chat: true (never with allowCritical, never 'default'):
//   gc.notify({ topic, title, body, users (1–100, required), conversation { id, title?, isGroup? }, sender { id,
//   name, avatarUrl? (/avatars/ or /plugin-media/ path) }, priority (critical → high), collapseKey (default
//   'chat:<conversation.id>'), ttl, data, image }) → { pushed: true, id, skipped }; data.actions may carry
//   { type: 'reply'|'mark_read', label (1–24), path (the plugin's client API, relative, no '..'; needs
//   permissions.app), body? (object ≤ 1 KB) }. Own budget: 1200 per (mocked) hour and plugin (ERR_RATE_LIMIT),
//   120 per recipient (skipped, all skipped → ERR_RATE_LIMIT) — not counted against permissions.notify. Recorded
//   in host.notifications with kind: 'message' and data.conversation / data.sender as the host stores them.
//   Services — services.provides { <name>: { label } } and permissions.services ["<plugin>:<service>"] are validated.
//   opts.services: [{ plugin: 'gatecontrol-messenger', provides: ['send_message'] (or an object like plugin.json),
//   service: async ({ name, caller, user, payload }) => result }] are the other plugins.
//   gc.services.call({ plugin, service, userId, payload }) → the provider's result, checked like the host:
//   ERR_SERVICES_DENIED (not in permissions.services), ERR_SERVICE_UNAVAILABLE (no such provider/service),
//   ERR_INVALID (ids, a userId that is not an enabled user, payload over 16 KB, own plugin), ERR_RATE_LIMIT
//   (60 per hour), ERR_SERVICE_FAILED (the provider threw, or answered over 16 KB). The provider gets user
//   { id, name, role } or null. host.serviceCalls records { plugin, service, userId, payload, ok }.
//   host.callService(name, { caller, user, payload }) calls this plugin's own hook service(…) as another plugin
//   would (the service must be in services.provides; no hook → ERR_SERVICE_FAILED) → its result.
//
// GateControl 1.191.0 (opt-in: opts.gatecontrol: '1.191.0') — the chat sink of the notification center:
//   permissions.notifySink: a boolean (ERR_INVALID otherwise; ignored by older hosts). host.deliverNotice(payload)
//   calls the hook deliverNotice(payload) as hub.js does (→ { covered, fallback, answer, error }, host.sinkCalls),
//   host.mayRouteToFamily(user) like chatRoutes.js (administrators without asking; others the hook with { user: { id,
//   name, role } }, 3 s). gc.notify.routes.get({ userId, lang }) / .set({ userId, topic, dest }) → { ok, sink, canFamily,
//   groups } with the host's refusals (ERR_NOTIFY_SINK_DENIED, ERR_INVALID invalid_user|invalid_topic|invalid_dest,
//   ERR_NOT_FOUND unknown_topic, ERR_CONFLICT locked|no_sink, ERR_FORBIDDEN family_not_allowed); topics from
//   opts.routeTopics, opts.sinkActive: false = no active sink, stored routes in host.routes.
//   gc.notify({ …, card: { text (required) ≤ 4000, link?: { label ≤ 40, route }, actions? } }) is checked and cut like the
//   host and recorded as `card` ({ text, link?, actions? }) in host.notifications (an older host ignores `card`).
//
// GateControl 1.178.0 (opt-in: opts.gatecontrol: '1.178.0'; default is the behaviour of 1.177.0 — gc.services
// has no `available`, a push picture must be { data, mime }):
//   gc.services.available(plugin, service) (or ({ plugin, service })) → boolean: listed in permissions.services,
//   not the plugin itself, a provider of opts.services offering it with a service hook; malformed id/name →
//   ERR_INVALID; never runs the provider, not counted, not recorded in host.serviceCalls.
//   gc.notify({ …, image: { mediaId } }) (any topic, chat topics included): one of the plugin's own media files
//   (nothing else in `image`; needs `media` → else ERR_MEDIA_DENIED; unknown id, a type other than PNG/JPEG/WebP,
//   over 300 KB → ERR_INVALID "invalid image: …") is read and checked like a sent picture.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');

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
const NOTIFY_ACTIONS = new Set(['open_app_route', 'open_portal', 'mute_1h', 'ack', 'done', 'quick_action', 'callback']);
// GateControl ≥ 1.169.0: a picture on a push (notify_media), checked like services/avatars.js
const NOTIFY_IMAGE_MAX = 300 * 1024;
const NOTIFY_IMAGE_TTL_MAX = 7 * 86400;
const NOTIFY_IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const BACKGROUND_MIN_S = 5;
const QA_MAX = 16;
const QA_ID_RE = /^[A-Za-z0-9:._-]{1,64}$/;
// GateControl ≥ 1.191.0: the app routes of a push button / a card link, the longest card text
const APP_ROUTE_RE = /^(?:vpn|services|gateways|inbox|plg-[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const CARD_TEXT_MAX = 4000;
const SINK_TIMEOUT_MS = 10000;
const ASK_TIMEOUT_MS = 3000;
const QA_ICON_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,2000}$/;
const QA_STATES = new Set(['on', 'off']);
const QA_WIDGET_STATES = new Set(['on', 'off', 'good', 'warn', 'crit']);
const QA_BADGE_STATES = new Set(['good', 'warn', 'crit']);
const QA_CONTROL_ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const QA_CONTROL_KINDS = new Set(['stepper', 'slider', 'choice']);
const QA_WIDGET_CONTROLS = 4;
const QA_TONES = new Set(['good', 'warn', 'crit', 'neutral']);
const QA_READINGS = 4;
const TILE_ITEMS = 4;
const TILE_STATES = new Set(['on', 'off', 'good', 'warn', 'crit']);
const PLUGIN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTIONS_PER_HOUR = 60;
// GateControl ≥ 1.177.0 (manifest.js, media.js, events.js, hostApi.js)
const MEDIA_MAX_BYTES = 100 * 1024 * 1024;
const MEDIA_QUOTA_DEFAULT = 1024 * 1024 * 1024;
const MEDIA_MIME_RE = /^(?:image|audio|video|application|text)\/[a-z0-9][a-z0-9.+-]{0,99}$/;
const MEDIA_MIME_DENY_RE = /^(?:text\/(?:html|xml|css|javascript|ecmascript|x-javascript)|application\/(?:xhtml\+xml|xml|javascript|x-javascript|ecmascript|json|x-www-form-urlencoded)|image\/svg\+xml)$|\+(?:xml|json)$/;
const MEDIA_QUOTA_RE = /^(\d{1,7})\s?(KB|MB|GB|TB)$/i;
const MEDIA_UNIT = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
const MEDIA_UNCLAIMED_MS = 24 * 3600 * 1000;
const EVENT_TYPE_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const EVENTS_PER_MINUTE = 600;
const CHAT_PER_HOUR = 1200;
const CHAT_PER_USER_HOUR = 120;
const CHAT_CONV_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const CHAT_SENDER_ID_RE = /^[A-Za-z0-9_.:@-]{1,64}$/;
const CHAT_AVATAR_RE = /^\/(?:avatars|plugin-media)\/[A-Za-z0-9._-]{1,200}$/;
const CHAT_PATH_RE = /^[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,300}$/;
const SERVICE_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SERVICE_REF_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*):([a-z][a-z0-9_]{0,31})$/;
const SERVICES_PER_HOUR = 60;
const SERVICE_JSON_MAX = 16 * 1024;
const SERVICE_PAYLOAD_MAX_180 = 512 * 1024;

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
    badge: checkQuickBadge(w.badge, what),
  };
}

/**
 * A widget's badge → { icon, value, unit, state, label } as the host passes it on (GateControl ≥ 1.175.0,
 * quickActions.js; the widget's last key, shown in its head right of the device name); null without one.
 * Throws where the host nulls the badge or one of its parts (the host never drops the widget for it):
 * icon (required) SVG path data, value a trimmed text of 1–8 or a finite number, unit 1–4 and only with
 * a value, state good|warn|crit (not on/off), label 1–20 (for screen readers).
 */
function checkQuickBadge(b, what) {
  if (b == null) return null;
  if (typeof b !== 'object' || Array.isArray(b)) throw hostError('ERR_INVALID', `${what}: widget badge must be an object`);
  if (typeof b.icon !== 'string' || !QA_ICON_RE.test(b.icon)) throw hostError('ERR_INVALID', `${what}: widget badge icon is not SVG path data`);
  const value = b.value == null ? null : (typeof b.value === 'number' ? qaNumber(b.value, `${what}: widget badge value`) : qaText(b.value, 8, `${what} widget badge value`));
  if (b.state != null && !QA_BADGE_STATES.has(b.state)) throw hostError('ERR_INVALID', `${what}: widget badge state ${JSON.stringify(b.state)}`);
  if (b.unit != null && value == null) throw hostError('ERR_INVALID', `${what}: widget badge unit without a value`);
  return {
    icon: b.icon, value, unit: qaText(b.unit, 4, `${what} widget badge unit`, true),
    state: b.state == null ? null : b.state, label: qaText(b.label, 20, `${what} widget badge label`, true),
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
/** plugin.json `media` → { maxBytes, types, quotaDefault } like GateControl's manifest.js (throws ERR_INVALID). */
function mediaDecl(m, gc190 = false) {
  if (m == null) return null;
  const bad = (what) => { throw hostError('ERR_INVALID', `plugin.json: ${what}: invalid`); };
  const keys = gc190 ? ['maxBytes', 'types', 'quotaDefault', 'uploads'] : ['maxBytes', 'types', 'quotaDefault'];
  if (typeof m !== 'object' || Array.isArray(m) || Object.keys(m).some((k) => !keys.includes(k))) bad('media');
  if (m.uploads != null && typeof m.uploads !== 'boolean') bad('media.uploads');
  if (!Number.isSafeInteger(m.maxBytes) || m.maxBytes < 1024 || m.maxBytes > MEDIA_MAX_BYTES) bad('media.maxBytes');
  const types = Array.isArray(m.types) ? [...new Set(m.types.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : '')))] : null;
  if (!types || !types.length || types.length > 32 || !types.every((x) => MEDIA_MIME_RE.test(x) && !MEDIA_MIME_DENY_RE.test(x))) bad('media.types');
  let quota = MEDIA_QUOTA_DEFAULT;
  if (m.quotaDefault != null) {
    const q = Number.isSafeInteger(m.quotaDefault) ? null : MEDIA_QUOTA_RE.exec(String(m.quotaDefault).trim());
    quota = Number.isSafeInteger(m.quotaDefault) ? m.quotaDefault : (q ? Number(q[1]) * MEDIA_UNIT[q[2].toUpperCase()] : null);
  }
  if (quota == null || quota < 1024 * 1024 || quota > 1024 ** 4 || quota < m.maxBytes) bad('media.quotaDefault');
  return { maxBytes: m.maxBytes, types, quotaDefault: quota, uploads: m.uploads !== false };
}

/** Plain JSON ≤ max bytes, else the error code. */
function boundedJson(v, max, codeOver, what) {
  let s;
  try { s = JSON.stringify(v === undefined ? null : v); } catch { s = undefined; }
  if (s === undefined || Buffer.byteLength(s, 'utf8') > max) throw hostError(codeOver, `${what} must be JSON ≤ ${Math.round(max / 1024)} KB`);
  return JSON.parse(s);
}

async function createHost(pluginDir, opts = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
  const perms = manifest.permissions || {};
  const net = networkOf(manifest);
  // permissions.kiosk: a boolean (GateControl ≥ 1.165.0, manifest.js)
  if (perms.kiosk != null && typeof perms.kiosk !== 'boolean') throw hostError('ERR_INVALID', 'plugin.json: permissions.kiosk: invalid');
  // permissions.actions: a boolean (GateControl ≥ 1.166.0, manifest.js)
  // GateControl ≥ 1.180.0 also { interactive: boolean } (gc.actions runs as a person's tap)
  if (perms.actions != null && typeof perms.actions !== 'boolean'
    && !(perms.actions && typeof perms.actions === 'object' && !Array.isArray(perms.actions) && Object.keys(perms.actions).length === 1 && typeof perms.actions.interactive === 'boolean')) {
    throw hostError('ERR_INVALID', 'plugin.json: permissions.actions: invalid');
  }
  // permissions.background.intervalSeconds: 5 … 86400 (GateControl ≥ 1.169.0; 10 before)
  if (perms.background != null) {
    const iv = perms.background && perms.background.intervalSeconds;
    if (!Number.isInteger(iv) || iv < BACKGROUND_MIN_S || iv > 86400) throw hostError('ERR_INVALID', 'plugin.json: permissions.background.intervalSeconds: invalid');
  }
  // GateControl ≥ 1.177.0: media, permissions.events, services, permissions.services, notifyTopics[].chat
  const gcVersion = String(opts.gatecontrol || '1.177.0').split('.').map((n) => Number(n) || 0);
  const gc190 = gcVersion[0] > 1 || (gcVersion[0] === 1 && gcVersion[1] >= 190);
  // GateControl ≥ 1.191.0: permissions.notifySink (a boolean) — the plugin is the chat sink of the notification center
  // (hooks deliverNotice / mayRouteToFamily). An older host does not know the key and ignores it (like manifest.js).
  const gc191 = gcVersion[0] > 1 || (gcVersion[0] === 1 && gcVersion[1] >= 191);
  if (gc191 && perms.notifySink != null && typeof perms.notifySink !== 'boolean') throw hostError('ERR_INVALID', 'plugin.json: permissions.notifySink: invalid');
  const notifySink = gc191 && perms.notifySink === true;
  const media = mediaDecl(manifest.media, gc190);
  if (perms.events != null && typeof perms.events !== 'boolean') throw hostError('ERR_INVALID', 'plugin.json: permissions.events: invalid');
  if (perms.services != null && (!Array.isArray(perms.services) || perms.services.length > 32 || !perms.services.every((x) => typeof x === 'string' && SERVICE_REF_RE.test(x)))) {
    throw hostError('ERR_INVALID', 'plugin.json: permissions.services: invalid');
  }
  if ((perms.services || []).some((x) => SERVICE_REF_RE.exec(x)[1] === manifest.id)) throw hostError('ERR_INVALID', 'plugin.json: permissions.services: own service');
  const provides = {};
  if (manifest.services != null) {
    const sv = manifest.services;
    const prov = sv && typeof sv === 'object' && !Array.isArray(sv) && Object.keys(sv).every((k) => k === 'provides') ? sv.provides : null;
    if (!prov || typeof prov !== 'object' || Array.isArray(prov) || Object.keys(prov).length > 32) throw hostError('ERR_INVALID', 'plugin.json: services: invalid');
    for (const [name, def] of Object.entries(prov)) {
      const label = def && def.label;
      const okLabel = (typeof label === 'string' && label.trim() && label.length <= 60) || (label && typeof label === 'object' && (label.de || label.en));
      if (!SERVICE_NAME_RE.test(name) || !okLabel || Object.keys(def).some((k) => k !== 'label')) throw hostError('ERR_INVALID', 'plugin.json: services.provides: invalid');
      provides[name] = { label };
    }
  }
  for (const t of Array.isArray(manifest.notifyTopics) ? manifest.notifyTopics : []) {
    if (t && t.chat != null && typeof t.chat !== 'boolean') throw hostError('ERR_INVALID', 'plugin.json: notifyTopics: invalid');
    if (t && t.chat === true && (t.allowCritical === true || t.id === 'default')) throw hostError('ERR_INVALID', 'plugin.json: notifyTopics: chat topic cannot be critical or default');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `gcmock-${manifest.id}-`));
  const filesDir = path.join(tmp, 'files');
  fs.mkdirSync(filesDir);

  const logs = [];
  const notifications = [];
  const fetches = [];
  const websockets = [];
  const kv = new Map();
  const settings = { ...settingDefaults(manifest), ...(opts.settings || {}) };
  const secrets = new Set(); // keys stored with gc.settings.setSecret (encrypted on the real host)
  const allUsers = (opts.users || [DEFAULT_USER]).map((u) => ({ id: u.id, name: u.name, role: u.role, disabled: u.disabled === true, ...userFace(u) }));
  // gc.users lists enabled accounts only (GateControl ≥ 1.168.0: with avatarUrl, color, colorHex, initials)
  const users = allUsers.filter((u) => !u.disabled).map(({ id, name, role, avatarUrl, color, colorHex, initials }) => ({ id, name, role, avatarUrl, color, colorHex, initials }));
  const license = { required: !!(manifest.license && manifest.license.required), licensed: true, state: 'valid', expiresAt: null, ...(opts.license || {}) };
  // permissions.notify: true (30 per hour) or { perHour: 1–120 } (GateControl ≥ 1.164.0); the mock counts all of a test
  const notifyLimit = perms.notify && typeof perms.notify === 'object' && Number.isInteger(perms.notify.perHour) ? perms.notify.perHour : 30;
  // chat notifications (GateControl ≥ 1.177.0) have a budget of their own
  const notifyCount = () => notifications.filter((x) => x.kind !== 'message').length;
  const kiosk = new Set((opts.kiosk || []).map(Number));
  const actionPlugins = (opts.actions || []).filter((p) => p && p.plugin !== manifest.id);
  const actionRuns = [];
  const actionRunAt = [];
  // GateControl ≥ 1.177.0
  const mediaStore = new Map(); // id → { mime, bytes, owner, data, claimed, createdAt (ms) }
  const mediaQuota = Number.isSafeInteger(opts.mediaQuota) && opts.mediaQuota > 0 ? opts.mediaQuota : (media ? media.quotaDefault : 0);
  const events = [];
  const eventAt = [];
  const chatAt = [];
  const chatUserAt = new Map();
  const serviceCalls = [];
  const sinkCalls = []; // GateControl ≥ 1.191.0: host.deliverNotice
  const serviceAt = [];
  const providers = (opts.services || []).filter((p) => p && typeof p.plugin === 'string' && p.plugin !== manifest.id);
  // the GateControl version emulated for features newer than 1.177.0 (opt-in)
  const hostAtLeast = (v) => {
    const parse = (x) => String(x).split('.').map((n) => Number(n) || 0);
    const [a, b] = [parse(opts.gatecontrol || '1.177.0'), parse(v)];
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    return true;
  };

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
    'ws.connect': async ({ url, opts: o }) => {
      const u = String(url);
      if (!/^wss?:/i.test(u) || !internetAllowed(net.internet, u.replace(/^ws/i, 'http'))) throw hostError('ERR_NET_DENIED', `host not allowed: ${u}`);
      if (!opts.websocket) throw hostError('ERR_NET', 'no websocket handler in this test');
      return { url: u, opts: o || {} };
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
      if (n && typeof n === 'object' && !Array.isArray(n) && hostAtLeast('1.178.0') && n.image && typeof n.image === 'object' && !Array.isArray(n.image)
        && Object.prototype.hasOwnProperty.call(n.image, 'mediaId')) {
        // GateControl ≥ 1.178.0 (hostApi.js notifyImageFromMedia): a picture from the plugin's own media
        const im = n.image;
        if (Object.keys(im).length !== 1) throw hostError('ERR_INVALID', 'invalid image: mediaId cannot be combined with data or mime');
        if (typeof im.mediaId !== 'string' || !/^[0-9a-f]{32}$/.test(im.mediaId)) throw hostError('ERR_INVALID', 'invalid image: invalid media id');
        if (!media) throw hostError('ERR_MEDIA_DENIED', 'plugin.json declares no media');
        const f = mediaStore.get(im.mediaId);
        if (!f) throw hostError('ERR_INVALID', 'invalid image: unknown media id');
        if (!NOTIFY_IMAGE_EXT[f.mime]) throw hostError('ERR_INVALID', 'invalid image: mime');
        if (f.bytes > NOTIFY_IMAGE_MAX) throw hostError('ERR_INVALID', 'invalid image: too_large');
        n = { ...n, image: { data: Buffer.from(f.data).toString('base64'), mime: f.mime } };
      }
      if (n && typeof n === 'object' && !Array.isArray(n)) {
        // GateControl ≥ 1.154.0 (src/services/plugins/hostApi.js notify): same checks and codes
        const topic = n.topic == null ? 'default' : String(n.topic);
        const declared = Array.isArray(manifest.notifyTopics) ? manifest.notifyTopics : [];
        if (topic !== 'default' && !declared.some((t) => t && t.id === topic)) throw hostError('ERR_INVALID', 'topic not declared in notifyTopics');
        if (declared.some((t) => t && t.id === topic && t.chat === true)) return notifyChat(topic, n);
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
        if (data.actions != null) checkNotifyActions(data.actions);
        // GateControl ≥ 1.191.0: `card` — the long form for a chat sink (deliverNotice); older hosts ignore it
        const card = hostAtLeast('1.191.0') && n.card != null ? notifyCard(n.card) : null;
        const image = n.image == null ? null : notifyImage(n.image);
        if (notifyCount() >= notifyLimit) throw hostError('ERR_RATE_LIMIT', 'too many notifications');
        // 'critical' is capped to 'high' unless the topic declares allowCritical (GateControl ≥ 1.164.0)
        const critical = priority === 'critical' && declared.some((t) => t && t.id === topic && t.allowCritical === true);
        const rec = {
          topic, title, body, priority: priority === 'critical' && !critical ? 'high' : priority,
          users: n.users == null ? null : [...new Set(n.users)], collapseKey: n.collapseKey == null ? null : String(n.collapseKey), ttl: n.ttl == null ? null : n.ttl, data,
        };
        if (card) rec.card = card;
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
      if (notifyCount() >= notifyLimit) throw hostError('ERR_RATE_LIMIT', 'too many notifications');
      notifications.push({ message: msg, severity: (o && o.severity) || 'info' });
      return {};
    },
    'license.status': async () => ({ ...license }),
    // GateControl ≥ 1.191.0 (permissions.notifySink): where a person's notifications appear
    'notify.routes.get': async (a) => notifyRoutes('get', a || {}),
    'notify.routes.set': async (a) => notifyRoutes('set', a || {}),
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

  /** The buttons of a push (data.actions; GateControl ≥ 1.191.0 also card.actions), checked like the host. */
  function checkNotifyActions(list) {
    if (!Array.isArray(list) || list.length > 4) throw hostError('ERR_INVALID', 'invalid actions (test)');
    for (const a of list) {
      if (!a || !NOTIFY_ACTIONS.has(a.type)) throw hostError('ERR_INVALID', 'unknown action type (test: the host would drop it)');
      if (a.type === 'open_app_route' && !/^(?:vpn|services|gateways|inbox|plg-[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(String(a.target))) throw hostError('ERR_INVALID', 'invalid app route (test)');
      // GateControl ≥ 1.181.0: a button whose press comes back to the plugin (hook notifyAction)
      if (a.type === 'callback') {
        if (!hostAtLeast('1.181.0')) throw hostError('ERR_INVALID', 'callback buttons need GateControl 1.181.0 (test)');
        if (typeof a.id !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(a.id)) throw hostError('ERR_INVALID', 'callback: invalid id');
        const label = typeof a.label === 'string' ? a.label.replace(/[\0-\x1f\x7f]/g, '').trim() : '';
        if (!label || label.length > 24) throw hostError('ERR_INVALID', 'callback: label must be 1–24 characters');
        if (list.filter((x) => x && x.type === 'callback' && x.id === a.id).length > 1) throw hostError('ERR_INVALID', 'callback: duplicate id');
      }
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

  /**
   * GateControl ≥ 1.191.0 (hostApi.js notifyCard): gc.notify({ …, card }) — { text, link?: { label, route }, actions? }.
   * Not an object, text not a string or empty after cleaning (control characters out, \n kept), a link that is no object,
   * without a label or whose route is no app route, actions not a list → ERR_INVALID; text cut to 4000, label to 40;
   * actions checked like data.actions. → { text, link?, actions? } (absent parts left out, like the host).
   */
  function notifyCard(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw hostError('ERR_INVALID', 'invalid card');
    if (typeof c.text !== 'string') throw hostError('ERR_INVALID', 'card.text required');
    const text = c.text.replace(/\r\n?/g, '\n').replace(/[\0-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, CARD_TEXT_MAX).trim();
    if (!text) throw hostError('ERR_INVALID', 'card.text empty');
    const out = { text };
    if (c.link != null) {
      const l = c.link;
      if (typeof l !== 'object' || Array.isArray(l)) throw hostError('ERR_INVALID', 'invalid card.link');
      const label = typeof l.label === 'string' ? l.label.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim() : '';
      if (!label) throw hostError('ERR_INVALID', 'card.link.label required');
      if (typeof l.route !== 'string' || !APP_ROUTE_RE.test(l.route)) throw hostError('ERR_INVALID', 'card.link.route must be an app route');
      out.link = { label, route: l.route };
    }
    if (c.actions != null) {
      if (!Array.isArray(c.actions)) throw hostError('ERR_INVALID', 'invalid card.actions');
      checkNotifyActions(c.actions);
      if (c.actions.length) out.actions = c.actions.slice(0, 4);
    }
    return out;
  }

  // ─── GateControl ≥ 1.191.0: where a person's notifications appear (chatRoutes.js, hostApi.js notifyRoutes) ───
  // opts.routeTopics: the routable topics of every person [{ id, label ('…' | { de, en }), source, sourceLabel }]
  // (default: GateControl's vpn_down and security, this plugin's non-chat notifyTopics); opts.sinkActive: false → the
  // sink is not active (sink: false, every dest 'inbox', own/family → no_sink). host.routes = { own: Map(userId →
  // Set(topic)), family: Map(topic → setBy userId) } — the stored routes.
  const ROUTE_LOCKED = new Set(['security', 'admin_notice']);
  const routes = { own: new Map(), family: new Map() };
  const routeTopicList = () => (Array.isArray(opts.routeTopics) ? opts.routeTopics : [
    { id: 'vpn_down', label: { de: 'VPN getrennt', en: 'VPN down' }, source: 'core', sourceLabel: 'GateControl' },
    { id: 'security', label: { de: 'Sicherheit', en: 'Security' }, source: 'core', sourceLabel: 'GateControl' },
    ...(Array.isArray(manifest.notifyTopics) ? manifest.notifyTopics : []).filter((t) => t && t.chat !== true).map((t) => ({
      id: `plugin:${manifest.id}:${t.id}`, label: t.label || t.id, source: `plugin:${manifest.id}`, sourceLabel: manifest.name || manifest.id })),
  ]);
  const loc = (v, lang) => (v && typeof v === 'object' ? (v[lang] || v.de || v.en || '') : String(v == null ? '' : v));
  const sinkActive = () => notifySink && opts.sinkActive !== false;
  /** chatRoutes.mayRouteToFamily: no sink → no; administrators without asking; else the hook { allowed } within 3 s. */
  async function mayRouteToFamilyOf(userId) {
    if (!sinkActive()) return false;
    const u = users.find((x) => x.id === userId);
    if (!u) return false;
    if (u.role === 'admin') return true;
    if (typeof plugin.mayRouteToFamily !== 'function') return false;
    let timer = null;
    try {
      const out = await Promise.race([hook('mayRouteToFamily', { user: { id: u.id, name: u.name, role: u.role } }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(hostError('ERR_TIMEOUT', 'mayRouteToFamily took over 3 s')), ASK_TIMEOUT_MS); })]);
      return out === true;
    } catch { return false; } finally { clearTimeout(timer); }
  }
  async function routesView(userId, lang) {
    const canFamily = sinkActive() ? await mayRouteToFamilyOf(userId) : false;
    const groups = [];
    for (const t of routeTopicList()) {
      let g = groups.find((x) => x.source === t.source);
      if (!g) { g = { source: t.source, label: loc(t.sourceLabel, lang), topics: [] }; groups.push(g); }
      const locked = ROUTE_LOCKED.has(t.id);
      let dest = 'inbox';
      let familySetBy = null;
      if (!locked && sinkActive()) {
        if (routes.family.has(t.id)) { dest = 'family'; const by = users.find((x) => x.id === routes.family.get(t.id)); familySetBy = by ? by.name : null; }
        else if ((routes.own.get(userId) || new Set()).has(t.id)) dest = 'own';
      }
      g.topics.push({ id: t.id, label: loc(t.label, lang), dest, locked, familySetBy });
    }
    return { ok: true, sink: sinkActive(), canFamily, groups };
  }
  async function notifyRoutes(op, a) {
    if (!gc191) throw hostError('ERR_INVALID', 'gc.notify.routes needs GateControl 1.191.0 (test)');
    if (!notifySink) throw hostError('ERR_NOTIFY_SINK_DENIED', 'this plugin is no notification sink (permissions.notifySink)');
    const uid = a && a.userId;
    if (!Number.isSafeInteger(uid) || uid <= 0 || !users.some((u) => u.id === uid)) throw hostError('ERR_INVALID', 'invalid_user');
    const lang = a.lang === 'de' || a.lang === 'en' ? a.lang : 'de';
    if (op === 'set') {
      const { topic, dest } = a;
      const refuse = (code, msg) => { throw hostError(code, msg); };
      if (!['inbox', 'own', 'family'].includes(dest)) refuse('ERR_INVALID', 'invalid_dest');
      if (typeof topic !== 'string' || !topic || topic.length > 120) refuse('ERR_INVALID', 'invalid_topic');
      if (!routeTopicList().some((t) => t.id === topic)) refuse('ERR_NOT_FOUND', 'unknown_topic');
      if (ROUTE_LOCKED.has(topic)) refuse('ERR_CONFLICT', 'locked');
      if (!sinkActive() && dest !== 'inbox') refuse('ERR_CONFLICT', 'no_sink');
      if (dest === 'family') {
        if (!(await mayRouteToFamilyOf(uid))) refuse('ERR_FORBIDDEN', 'family_not_allowed');
        routes.family.set(topic, uid);
      } else {
        const lift = sinkActive() && routes.family.has(topic);
        if (lift && !(await mayRouteToFamilyOf(uid))) refuse('ERR_FORBIDDEN', 'family_not_allowed');
        if (lift) routes.family.delete(topic);
        if (!routes.own.has(uid)) routes.own.set(uid, new Set());
        if (dest === 'own') routes.own.get(uid).add(topic); else routes.own.get(uid).delete(topic);
      }
    }
    return routesView(uid, lang);
  }

  // ─── GateControl ≥ 1.177.0: chat notifications, media, realtime events, services ───

  const recentAt = (list, now) => { while (list.length && now - list[0] >= 3600000) list.shift(); return list; };

  // gc.notify on a chat topic (hostApi.js notifyChat)
  function notifyChat(topic, n) {
    const title = String(n.title == null ? '' : n.title).replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!title) throw hostError('ERR_INVALID', 'empty title');
    const body = String(n.body == null ? '' : n.body).trim().slice(0, 1000);
    let priority = n.priority == null ? 'normal' : n.priority;
    if (!NOTIFY_PRIORITIES.includes(priority)) throw hostError('ERR_INVALID', 'invalid priority');
    if (priority === 'critical') priority = 'high';
    if (!(Array.isArray(n.users) && n.users.length >= 1 && n.users.length <= 100 && n.users.every((u) => Number.isSafeInteger(u) && u > 0))) throw hostError('ERR_INVALID', 'users (1…100 ids) required on a chat topic');
    const c = n.conversation;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw hostError('ERR_INVALID', 'conversation required on a chat topic');
    const convId = typeof c.id === 'number' && Number.isSafeInteger(c.id) ? String(c.id) : c.id;
    if (typeof convId !== 'string' || !CHAT_CONV_ID_RE.test(convId)) throw hostError('ERR_INVALID', 'invalid conversation.id');
    if (c.title != null && typeof c.title !== 'string') throw hostError('ERR_INVALID', 'invalid conversation.title');
    if (c.isGroup != null && typeof c.isGroup !== 'boolean') throw hostError('ERR_INVALID', 'invalid conversation.isGroup');
    const conversation = { id: convId, title: c.title == null ? null : (c.title.replace(/\s+/g, ' ').trim().slice(0, 80) || null), isGroup: c.isGroup === true };
    const sd = n.sender;
    if (!sd || typeof sd !== 'object' || Array.isArray(sd)) throw hostError('ERR_INVALID', 'sender required on a chat topic');
    const sid = typeof sd.id === 'number' && Number.isSafeInteger(sd.id) ? sd.id : (typeof sd.id === 'string' && CHAT_SENDER_ID_RE.test(sd.id) ? sd.id : null);
    if (sid === null) throw hostError('ERR_INVALID', 'invalid sender.id');
    const name = typeof sd.name === 'string' ? sd.name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    if (!name) throw hostError('ERR_INVALID', 'sender.name required');
    if (sd.avatarUrl != null && !(typeof sd.avatarUrl === 'string' && CHAT_AVATAR_RE.test(sd.avatarUrl))) throw hostError('ERR_INVALID', 'sender.avatarUrl must be a /avatars/ or /plugin-media/ path');
    const sender = { id: sid, name, avatarUrl: sd.avatarUrl == null ? null : sd.avatarUrl };
    let collapseKey = `chat:${convId}`;
    if (n.collapseKey != null) {
      if (!/^[A-Za-z0-9_.:@/-]{1,120}$/.test(String(n.collapseKey))) throw hostError('ERR_INVALID', 'invalid collapseKey');
      collapseKey = String(n.collapseKey);
    }
    if (n.ttl != null && !(Number.isSafeInteger(n.ttl) && n.ttl >= 60 && n.ttl <= 30 * 86400)) throw hostError('ERR_INVALID', 'invalid ttl');
    if (n.data != null && (typeof n.data !== 'object' || Array.isArray(n.data))) throw hostError('ERR_INVALID', 'invalid data');
    const data = { route: `plg-${manifest.id}`, ...(n.data || {}), conversation, sender };
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 4096) throw hostError('ERR_INVALID', 'data too large (max 4 KB)');
    if (data.actions != null) {
      if (!Array.isArray(data.actions) || data.actions.length > 4) throw hostError('ERR_INVALID', 'invalid actions (test)');
      data.actions = data.actions.map((a) => {
        if (!a || !(NOTIFY_ACTIONS.has(a.type) || a.type === 'reply' || a.type === 'mark_read')) throw hostError('ERR_INVALID', 'unknown action type (test: the host would drop it)');
        if (a.type !== 'reply' && a.type !== 'mark_read') return a;
        if (perms.app !== true) throw hostError('ERR_INVALID', `${a.type}: needs permissions.app (the app posts to the plugin's client API)`);
        const p2 = typeof a.path === 'string' ? a.path.replace(/^\/+/, '') : '';
        if (!CHAT_PATH_RE.test(p2) || p2.split('/').some((x) => x === '..' || x === '.')) throw hostError('ERR_INVALID', `${a.type}: invalid path`);
        if (typeof a.label !== 'string' || !a.label.trim() || a.label.trim().length > 24) throw hostError('ERR_INVALID', `${a.type}: label must be 1…24 characters`);
        if (a.body != null && (typeof a.body !== 'object' || Array.isArray(a.body) || Buffer.byteLength(JSON.stringify(a.body)) > 1024)) throw hostError('ERR_INVALID', `${a.type}: body must be an object ≤ 1 KB`);
        return { id: a.id || a.type, label: a.label.trim(), type: a.type, path: p2, ...(a.body != null ? { body: a.body } : {}) };
      });
    }
    const image = n.image == null ? null : notifyImage(n.image);
    const now = Date.now();
    if (recentAt(chatAt, now).length >= CHAT_PER_HOUR) throw hostError('ERR_RATE_LIMIT', `too many chat notifications (${CHAT_PER_HOUR} per hour)`);
    const to = [];
    const skipped = [];
    for (const u of [...new Set(n.users)]) {
      if (!chatUserAt.has(u)) chatUserAt.set(u, []);
      if (recentAt(chatUserAt.get(u), now).length >= CHAT_PER_USER_HOUR) skipped.push(u); else to.push(u);
    }
    if (!to.length) throw hostError('ERR_RATE_LIMIT', `too many chat notifications for these recipients (${CHAT_PER_USER_HOUR} per hour each)`);
    chatAt.push(now);
    for (const u of to) chatUserAt.get(u).push(now);
    const rec = { kind: 'message', topic, title, body, priority, users: to, collapseKey, ttl: n.ttl == null ? null : n.ttl, data };
    if (image) rec.image = image;
    notifications.push(rec);
    return { pushed: true, id: notifications.length, skipped };
  }

  const needMedia = () => { if (!media) throw hostError('ERR_MEDIA_DENIED', 'plugin.json declares no media'); };
  const mediaIdOf = (args) => {
    const id = args && args.id;
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw hostError('ERR_INVALID', 'invalid media id');
    return id;
  };
  const mediaInfo = (id) => {
    const m = mediaStore.get(id);
    return m ? { mediaId: id, mime: m.mime, bytes: m.bytes, sha256: require('node:crypto').createHash('sha256').update(m.data).digest('hex'),
      owner: m.owner, createdAt: new Date(m.createdAt).toISOString(), claimed: m.claimed, ...(gc190 ? { name: m.name || null } : {}) } : null;
  };
  const mediaUsage = () => { let bytes = 0; for (const m of mediaStore.values()) bytes += m.bytes; return { bytes, count: mediaStore.size }; };
  const urlSecret = require('node:crypto').randomBytes(16).toString('hex');
  const urlSig = (id, exp, uid) => require('node:crypto').createHmac('sha256', urlSecret).update(`plugin-media:${id}:${manifest.id}:${exp}:${uid}`).digest('base64url').slice(0, 22);
  api['media.info'] = async (args) => { needMedia(); return mediaInfo(mediaIdOf(args)); };
  api['media.claim'] = async (args) => {
    needMedia();
    const id = mediaIdOf(args);
    const m = mediaStore.get(id);
    if (!m) throw hostError('ERR_INVALID', 'unknown media id');
    m.claimed = true;
    return mediaInfo(id);
  };
  api['media.delete'] = async (args) => { needMedia(); return mediaStore.delete(mediaIdOf(args)); };
  api['media.usage'] = async () => { needMedia(); return { ...mediaUsage(), quota: mediaQuota, maxBytes: media.maxBytes, types: media.types }; };
  // GateControl ≥ 1.190.0: a file from the internet straight into the store (no owner, unclaimed)
  const mediaName = (v) => {
    const x = String(v == null ? '' : v).replace(/[\0-\x1f\x7f]/g, '').split(/[\\/]/).pop().trim().slice(0, 200);
    return x || null;
  };
  api['media.fetch'] = async ({ url, opts: o }) => {
    needMedia();
    const x = o && typeof o === 'object' ? o : {};
    if (!internetAllowed(net.internet, url)) throw hostError('ERR_NET_DENIED', `host not allowed: ${url}`);
    fetches.push({ url, opts: { ...x, media: true } });
    if (!opts.fetch) throw hostError('ERR_NET', 'no fetch handler in this test');
    const r = await opts.fetch(url, { method: 'GET', headers: x.headers || {}, binary: true });
    const status = Number(r && r.status != null ? r.status : 200);
    if (!(status >= 200 && status < 300)) throw Object.assign(hostError('ERR_HTTP', `status ${status}`), { status });
    const buf = Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body == null ? '' : r.body));
    const limit = Math.min(Number.isSafeInteger(x.maxBytes) && x.maxBytes > 0 ? x.maxBytes : media.maxBytes, media.maxBytes);
    if (buf.length > limit) throw hostError('ERR_MEDIA_TOO_LARGE', 'file too large');
    if (!buf.length) throw hostError('ERR_MEDIA_EMPTY', 'the response is empty');
    const ct = String((r.headers && (r.headers['content-type'] || r.headers['Content-Type'])) || '').split(';')[0].trim().toLowerCase();
    const type = typeof x.mime === 'string' && x.mime ? x.mime.trim().toLowerCase() : ct;
    if (!media.types.includes(type)) throw hostError('ERR_MEDIA_TYPE', `type not allowed: ${type}`);
    if (mediaUsage().bytes + buf.length > mediaQuota) throw hostError('ERR_MEDIA_QUOTA', 'quota exceeded');
    const id = require('node:crypto').randomBytes(16).toString('hex');
    const name = mediaName(x.name);
    mediaStore.set(id, { mime: type, bytes: buf.length, owner: null, data: Buffer.from(buf), claimed: false, createdAt: Date.now(), name });
    return { mediaId: id, mime: type, bytes: buf.length, name };
  };
  api['media.url'] = async (args) => {
    needMedia();
    const id = mediaIdOf(args);
    if (!mediaStore.has(id)) throw hostError('ERR_INVALID', 'unknown media id');
    const user = args.user == null ? null : args.user;
    if (!(user === null || (Number.isSafeInteger(user) && user > 0))) throw hostError('ERR_INVALID', 'invalid user id');
    const ttl = args.ttlS == null ? 3600 : args.ttlS;
    if (!(Number.isSafeInteger(ttl) && ttl >= 60 && ttl <= 86400)) throw hostError('ERR_INVALID', 'ttlS must be 60…86400');
    const exp = Math.ceil((Math.floor((args.now || Date.now()) / 1000) + ttl) / 300) * 300;
    const uid = user == null ? 0 : user;
    return `/plugin-media/${id}.${exp}.${uid}.${urlSig(id, exp, uid)}`;
  };

  // gc.events.emit (events.js)
  api['events.emit'] = async (args) => {
    if (perms.events !== true) throw hostError('ERR_EVENTS_DENIED', 'this plugin has no events permission');
    const a = args && typeof args === 'object' ? args : {};
    if (!Array.isArray(a.users) || !a.users.length || a.users.length > 500 || !a.users.every((u) => Number.isSafeInteger(u) && u > 0)) throw hostError('ERR_INVALID', 'users must be 1…500 user ids');
    if (typeof a.type !== 'string' || !EVENT_TYPE_RE.test(a.type)) throw hostError('ERR_INVALID', 'invalid type');
    const data = boundedJson(a.data, 4096, 'ERR_INVALID', 'data');
    const now = Date.now();
    while (eventAt.length && now - eventAt[0] >= 60000) eventAt.shift();
    if (eventAt.length >= EVENTS_PER_MINUTE) throw hostError('ERR_RATE_LIMIT', 'too many events (600 per minute)');
    eventAt.push(now);
    const users2 = [...new Set(a.users)];
    events.push({ users: users2, type: a.type, data });
    const delivered = users2.reduce((sum, u) => sum + (typeof opts.connected === 'function' ? Number(opts.connected(u)) || 0 : 1), 0);
    return { delivered };
  };

  // gc.services.call (hostApi.js servicesCall)
  api['services.call'] = async (args) => {
    const a = args && typeof args === 'object' ? args : {};
    if (typeof a.plugin !== 'string' || a.plugin.length < 2 || a.plugin.length > 64 || !PLUGIN_ID_RE.test(a.plugin)) throw hostError('ERR_INVALID', 'invalid plugin id');
    if (typeof a.service !== 'string' || !SERVICE_NAME_RE.test(a.service)) throw hostError('ERR_INVALID', 'invalid service name');
    if (!(perms.services || []).includes(`${a.plugin}:${a.service}`)) throw hostError('ERR_SERVICES_DENIED', 'service not listed in permissions.services');
    if (a.plugin === manifest.id) throw hostError('ERR_INVALID', 'a plugin cannot call its own services');
    let user = null;
    if (a.userId != null) {
      if (!Number.isSafeInteger(a.userId) || a.userId <= 0) throw hostError('ERR_INVALID', 'invalid user id');
      const u = allUsers.find((x) => x.id === a.userId);
      if (!u || u.disabled) throw hostError('ERR_INVALID', 'unknown or disabled user');
      user = { id: u.id, name: u.name, role: u.role };
    }
    // GateControl ≥ 1.180.0: a payload may be up to 512 KB (the answer stays ≤ 16 KB)
    const payload = boundedJson(a.payload, hostAtLeast('1.180.0') ? SERVICE_PAYLOAD_MAX_180 : SERVICE_JSON_MAX, 'ERR_INVALID', 'payload');
    const p = providers.find((x) => x.plugin === a.plugin);
    const offered = p ? (Array.isArray(p.provides) ? p.provides : Object.keys(p.provides || {})) : [];
    if (!p || !offered.includes(a.service) || typeof p.service !== 'function') throw hostError('ERR_SERVICE_UNAVAILABLE', 'the providing plugin or service is not available');
    const now = Date.now();
    if (recentAt(serviceAt, now).length >= SERVICES_PER_HOUR) throw hostError('ERR_RATE_LIMIT', `too many service calls (${SERVICES_PER_HOUR} per hour)`);
    serviceAt.push(now);
    let result;
    try {
      result = wire(await p.service(wire({ name: a.service, caller: manifest.id, user, payload })));
    } catch (e) {
      serviceCalls.push({ plugin: a.plugin, service: a.service, userId: user ? user.id : null, payload, ok: false });
      throw hostError('ERR_SERVICE_FAILED', String((e && e.message) || 'service failed').slice(0, 200));
    }
    let out;
    try { out = boundedJson(result === undefined ? null : result, SERVICE_JSON_MAX, 'ERR_SERVICE_FAILED', 'result'); } catch (e) {
      serviceCalls.push({ plugin: a.plugin, service: a.service, userId: user ? user.id : null, payload, ok: false });
      throw e;
    }
    serviceCalls.push({ plugin: a.plugin, service: a.service, userId: user ? user.id : null, payload, ok: true });
    return out;
  };

  // gc.services.available (GateControl ≥ 1.178.0, hostApi.js servicesAvailable)
  api['services.available'] = async (args) => {
    if (!hostAtLeast('1.178.0')) throw hostError('ERR_UNKNOWN_API', 'services.available needs GateControl 1.178.0 (test)');
    const a = args && typeof args === 'object' ? args : {};
    if (typeof a.plugin !== 'string' || a.plugin.length < 2 || a.plugin.length > 64 || !PLUGIN_ID_RE.test(a.plugin)) throw hostError('ERR_INVALID', 'invalid plugin id');
    if (typeof a.service !== 'string' || !SERVICE_NAME_RE.test(a.service)) throw hostError('ERR_INVALID', 'invalid service name');
    if (a.plugin === manifest.id || !(perms.services || []).includes(`${a.plugin}:${a.service}`)) return false;
    const p = providers.find((x) => x.plugin === a.plugin);
    const offered = p ? (Array.isArray(p.provides) ? p.provides : Object.keys(p.provides || {})) : [];
    return !!p && offered.includes(a.service) && typeof p.service === 'function';
  };

  // gc.actions.* (GateControl ≥ 1.166.0, hostApi.js actionsList / actionsRun; 1.180.0: actionId, interactive,
  // { ok, result, code } answers, 60 runs per minute)
  const actionsOn = perms.actions === true || !!(perms.actions && typeof perms.actions === 'object');
  const actionsInteractive = !!(perms.actions && typeof perms.actions === 'object' && perms.actions.interactive === true);
  const automationViewer = (args) => {
    if (!actionsOn) throw hostError('ERR_ACTIONS_DENIED', 'this plugin has no actions permission');
    if (args && args.interactive != null && args.interactive !== false) {
      if (args.interactive !== true) throw hostError('ERR_INVALID', 'interactive must be a boolean');
      if (!actionsInteractive) throw hostError('ERR_ACTIONS_DENIED', 'this plugin may not run actions interactively (permissions.actions { interactive: true })');
    }
    const userId = args && args.userId;
    if (!Number.isSafeInteger(userId) || userId <= 0) throw hostError('ERR_INVALID', 'invalid user id');
    const lang = args.lang;
    if (!(lang == null || lang === 'de' || lang === 'en')) throw hostError('ERR_INVALID', "lang must be 'de' or 'en'");
    const u = allUsers.find((x) => x.id === userId);
    if (!u || u.disabled) throw hostError('ERR_INVALID', 'unknown or disabled user');
    if (args.interactive === true) return { user: { id: u.id, name: u.name, role: u.role, portal: true, loggedIn: true, automation: false, interactive: true, via: manifest.id }, lang: lang || 'de' };
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
        const item = {
          plugin: p.plugin, pluginName: p.pluginName || p.plugin, id: a.id, title: a.title, subtitle: a.subtitle, icon: a.icon, kind: a.kind, state: a.state,
          verbs: a.verbs, targets: a.targets, device: a.device,
        };
        // GateControl ≥ 1.180.0 (opt-in): actionId '<plugin>/<id>', label (= title), needsConfirm, confirmWhen
        if (hostAtLeast('1.180.0')) Object.assign(item, { actionId: `${p.plugin}/${a.id}`, label: a.title, needsConfirm: a.confirm === true || (a.kind === 'toggle' && a.confirmWhen != null && (a.state == null || a.state !== a.confirmWhen)), confirmWhen: a.confirmWhen == null ? null : a.confirmWhen });
        out.push(item);
      }
    }
    return out;
  };
  api['actions.run'] = async (args) => {
    if (!actionsOn) throw hostError('ERR_ACTIONS_DENIED', 'this plugin has no actions permission');
    let target = args && args.plugin;
    let actionId = args && args.id;
    if (hostAtLeast('1.180.0') && args && args.actionId != null) {
      if (args.plugin != null || args.id != null) throw hostError('ERR_INVALID', 'actionId or plugin + id, not both');
      const ref = String(args.actionId);
      const slash = ref.indexOf('/');
      if (slash <= 0) throw hostError('ERR_INVALID', "actionId must be '<plugin>/<id>'");
      target = ref.slice(0, slash);
      actionId = ref.slice(slash + 1);
    }
    if (typeof target !== 'string' || target.length < 2 || target.length > 64 || !PLUGIN_ID_RE.test(target)) throw hostError('ERR_INVALID', 'invalid plugin id');
    if (target === manifest.id) throw hostError('ERR_INVALID', 'a plugin cannot run its own quick actions');
    if (typeof actionId !== 'string' || !QA_ID_RE.test(actionId)) throw hostError('ERR_INVALID', 'invalid action id');
    const { user, lang } = automationViewer(args);
    const now = Date.now();
    const win = hostAtLeast('1.180.0') ? 60000 : 3600000;
    while (actionRunAt.length && now - actionRunAt[0] >= win) actionRunAt.shift();
    if (actionRunAt.length >= ACTIONS_PER_HOUR) throw hostError('ERR_RATE_LIMIT', `too many quick action runs (60 per ${win === 60000 ? 'minute' : 'hour'})`);
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
    actionRuns.push({ plugin: target, id: actionId, userId: user.id, lang, viewer: user, state: state === undefined ? null : state, target: target2, result, interactive: args.interactive === true });
    if (hostAtLeast('1.180.0')) {
      if (result.error) return { ...result, code: { not_found: 'ERR_NOT_FOUND', invalid_state: 'ERR_INVALID_STATE', state_unknown: 'ERR_STATE_UNKNOWN' }[result.error] || 'ERR_PLUGIN_FAILED' };
      const r2 = { message: result.message, state: result.state, unchanged: result.unchanged };
      return { ...result, result: r2, ...(result.ok ? {} : { code: 'ERR_ACTION_FAILED' }) };
    }
    return result;
  };

  const call = async (name, args) => wire(await api[name](wire(args)));

  /** A WebSocket like the host's (EventEmitter: message, close, error; send, close) wired to opts.websocket. */
  async function openWebSocket(url, o) {
    const { url: u, opts: wo } = await call('ws.connect', { url: String(url), opts: { headers: o && o.headers, protocols: o && o.protocols, timeoutMs: o && o.timeoutMs } });
    const sock = new EventEmitter();
    sock.protocol = '';
    sock.closed = false;
    const end = (code, reason) => {
      if (sock.closed) return;
      sock.closed = true;
      setImmediate(() => sock.emit('close', code, reason || ''));
    };
    const peer = {
      url: u, opts: wo,
      send: (m) => { if (!sock.closed) setImmediate(() => { if (!sock.closed) sock.emit('message', Buffer.isBuffer(m) ? Buffer.from(m) : String(m)); }); },
      close: (code = 1000, reason = '') => end(code, reason),
      get closed() { return sock.closed; },
    };
    const h = (await opts.websocket(u, wo, peer)) || {};
    websockets.push(peer);
    sock.send = async (data) => {
      if (sock.closed) throw hostError('ERR_NET', 'websocket is not open');
      if (h.message) await h.message(Buffer.isBuffer(data) ? Buffer.from(data) : String(data));
      return null;
    };
    sock.close = async (code = 1000, reason = '') => {
      if (!sock.closed && h.close) h.close(code, reason);
      end(code, reason);
      return null;
    };
    return sock;
  }
  const log = (level) => (...a) => logs.push({ level, message: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') });

  const gc = Object.freeze({
    plugin: Object.freeze({ id: manifest.id, version: manifest.version, filesDir }),
    log: Object.freeze({ debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') }),
    http: Object.freeze({
      fetch: (url, o) => call('http.fetch', { url: String(url), opts: o || {} }),
      /** GateControl ≥ 1.184.0 (only when the test passes a websocket handler, like an older host without it otherwise) */
      ...(opts.websocket ? { websocket: (url, o) => openWebSocket(url, o) } : {}),
    }),
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
    notify: Object.assign((message, o) => (opts.notifyApi !== 'legacy' && message && typeof message === 'object' && !Array.isArray(message)
      ? call('notify', { notification: message })
      : call('notify', { message: String(message), opts: o || {} })),
    // GateControl ≥ 1.191.0: gc.notify.routes (every plugin has it; the host refuses it without permissions.notifySink)
    gc191 ? { routes: Object.freeze({
      get: (x) => { const a = x && typeof x === 'object' ? x : {}; return call('notify.routes.get', { userId: a.userId, lang: a.lang }); },
      set: (x) => { const a = x && typeof x === 'object' ? x : {}; return call('notify.routes.set', { userId: a.userId, topic: a.topic, dest: a.dest }); },
    }) } : {}),
    license: Object.freeze({ status: () => call('license.status', {}) }),
    kiosk: Object.freeze({ allow: (userId, allowed) => call('kiosk.allow', { userId, allowed }), list: () => call('kiosk.list', {}) }),
    // opts.actionsApi: false emulates a host whose child has no gc.actions (feature detection in plugins);
    // GateControl ≥ 1.180.0 (opts.gatecontrol) passes actionId, params, via and interactive on — older child
    // bootstraps drop them like the real ones did
    ...(opts.actionsApi === false ? {} : {
      actions: Object.freeze({
        list: (o) => {
          const x = o && typeof o === 'object' ? o : {};
          return call('actions.list', { userId: x.userId, lang: x.lang, ...(hostAtLeast('1.180.0') ? { interactive: x.interactive } : {}) });
        },
        run: (o) => {
          const x = o && typeof o === 'object' ? o : {};
          return call('actions.run', hostAtLeast('1.180.0')
            ? { userId: x.userId, actionId: x.actionId, plugin: x.plugin, id: x.id, params: x.params, lang: x.lang, state: x.state, via: x.via, interactive: x.interactive }
            : { userId: x.userId, plugin: x.plugin, id: x.id, lang: x.lang, state: x.state });
        },
      }),
    }),
    // GateControl ≥ 1.177.0
    media: Object.freeze({
      info: (id) => call('media.info', { id }),
      claim: (id) => call('media.claim', { id }),
      delete: (id) => call('media.delete', { id }),
      usage: () => call('media.usage', {}),
      url: (id, o) => { const x = o && typeof o === 'object' ? o : {}; return call('media.url', { id, user: x.user, ttlS: x.ttlS }); },
      ...(gc190 ? { fetch: (url, o) => call('media.fetch', { url, opts: o || {} }) } : {}),
    }),
    events: Object.freeze({
      emit: (o) => { const x = o && typeof o === 'object' ? o : {}; return call('events.emit', { users: x.users, type: x.type, data: x.data }); },
    }),
    services: Object.freeze({
      call: (o) => { const x = o && typeof o === 'object' ? o : {}; return call('services.call', { plugin: x.plugin, service: x.service, userId: x.userId, payload: x.payload }); },
      // GateControl ≥ 1.178.0 only (like the child bootstrap of an older host, the function is missing before)
      ...(hostAtLeast('1.178.0') ? {
        available: (pluginId, service) => {
          const x = pluginId && typeof pluginId === 'object' ? pluginId : { plugin: pluginId, service };
          return call('services.available', { plugin: x.plugin, service: x.service });
        },
      } : {}),
    }),
  });

  const entry = path.join(pluginDir, manifest.entry);
  delete require.cache[require.resolve(entry)];
  const plugin = require(entry);
  const hook = async (name, ...a) => (typeof plugin[name] === 'function' ? wire(await plugin[name](...a.map(wire), gc)) : undefined);

  // the default req.user: the first user as a session knows it (no gc.users face fields)
  const sessionUser = () => (users[0] ? { id: users[0].id, name: users[0].name, role: users[0].role } : DEFAULT_USER);

  // ─── GateControl ≥ 1.177.0: the routes around media, services of this plugin ───
  const mediaRange = (m, range) => {
    if (range == null || range === '') return null;
    const r = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(String(range).trim());
    if (!r || (r[1] === '' && r[2] === '')) return null;
    let start;
    let end;
    if (r[1] === '') { const nn = Number(r[2]); if (nn === 0) return false; start = Math.max(0, m.bytes - nn); end = m.bytes - 1; } else { start = Number(r[1]); end = r[2] === '' ? m.bytes - 1 : Math.min(Number(r[2]), m.bytes - 1); }
    return start >= m.bytes || end < start ? false : { start, end };
  };
  const mediaAnswer = (m, range) => {
    const rg = mediaRange(m, range);
    if (rg === false) return { status: 416, headers: { 'content-range': `bytes */${m.bytes}` }, body: Buffer.alloc(0) };
    const { start, end } = rg || { start: 0, end: m.bytes - 1 };
    const headers = { 'content-type': m.mime, 'accept-ranges': 'bytes', 'content-length': String(end - start + 1) };
    if (rg) headers['content-range'] = `bytes ${start}-${end}/${m.bytes}`;
    const inline = /^(?:image|audio|video)\//.test(m.mime);
    if (m.name) {
      const ascii = m.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
      headers['content-disposition'] = `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(m.name)}`;
    } else if (!inline) headers['content-disposition'] = 'attachment';
    return { status: rg ? 206 : 200, headers, body: m.data.subarray(start, end + 1) };
  };
  const notFound = () => ({ status: 404, headers: {}, body: Buffer.alloc(0) });

  return {
    manifest, gc, plugin, logs, notifications, fetches, websockets, kv, settings, filesDir, kiosk, actionRuns,
    media: mediaStore, events, serviceCalls,
    /** GateControl ≥ 1.177.0: an upload of an app or a frame (PUT …/plugins/<id>/media) → { status, body } */
    async upload(user, data, mime) {
      if (!media) return { status: 404, body: { ok: false, code: 'not_found' } };
      if (gc190 && media.uploads === false) return { status: 403, body: { ok: false, code: 'uploads_disabled' } };
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data == null ? '' : data));
      const type = String(mime || '').split(';')[0].trim().toLowerCase();
      if (!media.types.includes(type)) return { status: 415, body: { ok: false, code: 'unsupported_type' } };
      if (!buf.length) return { status: 411, body: { ok: false, code: 'length_required' } };
      if (buf.length > media.maxBytes) return { status: 413, body: { ok: false, code: 'too_large' } };
      if (mediaUsage().bytes + buf.length > mediaQuota) return { status: 507, body: { ok: false, code: 'quota_exceeded' } };
      const id = require('node:crypto').randomBytes(16).toString('hex');
      mediaStore.set(id, { mime: type, bytes: buf.length, owner: user && user.id != null ? user.id : null, data: Buffer.from(buf), claimed: false, createdAt: Date.now() });
      return { status: 200, body: { ok: true, mediaId: id, mime: type, bytes: buf.length } };
    },
    /** GateControl ≥ 1.177.0: GET /api/v1/client/plugins/<id>/media/<mediaId> for this app user → { status, headers, body } */
    async mediaGet(user, mediaId, o = {}) {
      const m = media && typeof mediaId === 'string' ? mediaStore.get(mediaId) : null;
      if (!m) return notFound();
      const viewer = { portal: true, loggedIn: true, app: true, ...user };
      let allowed;
      if (typeof plugin.mediaAccess !== 'function') allowed = m.owner != null && m.owner === viewer.id;
      else { try { allowed = (await hook('mediaAccess', { user: viewer, mediaId, owner: m.owner, mime: m.mime })) === true; } catch { allowed = false; } }
      return allowed ? mediaAnswer(m, o.range) : notFound();
    },
    /** GateControl ≥ 1.177.0: GET /plugin-media/<token> (a gc.media.url) → { status, headers, body } */
    async mediaFromUrl(url, o = {}) {
      const r = /^\/plugin-media\/([0-9a-f]{32})\.(\d{1,12})\.(\d{1,12})\.([A-Za-z0-9_-]{22})$/.exec(String(url || ''));
      if (!r) return notFound();
      const s2 = Math.floor((o.now || Date.now()) / 1000);
      const exp = Number(r[2]);
      if (!(s2 < exp && exp <= s2 + 86400 + 300) || urlSig(r[1], exp, Number(r[3])) !== r[4]) return notFound();
      const m = mediaStore.get(r[1]);
      return m ? mediaAnswer(m, o.range) : notFound();
    },
    /** GateControl ≥ 1.177.0: the hourly clean-up — unclaimed files older than 24 h at `now` go → count */
    mediaCleanup(now = Date.now()) {
      let n = 0;
      for (const [id, m] of mediaStore) if (!m.claimed && m.createdAt <= now - MEDIA_UNCLAIMED_MS) { mediaStore.delete(id); n++; }
      return n;
    },
    /** GateControl ≥ 1.177.0: another plugin calls this plugin's service `name` (services.provides) → the hook's result */
    async callService(name, o = {}) {
      if (!Object.prototype.hasOwnProperty.call(provides, name)) throw hostError('ERR_SERVICE_UNAVAILABLE', 'not in services.provides');
      if (typeof plugin.service !== 'function') throw hostError('ERR_SERVICE_FAILED', 'this plugin offers no services');
      const payload = boundedJson(o.payload, hostAtLeast('1.180.0') ? SERVICE_PAYLOAD_MAX_180 : SERVICE_JSON_MAX, 'ERR_INVALID', 'payload');
      const out = await hook('service', { name, caller: o.caller || 'gatecontrol-other', user: o.user == null ? null : o.user, payload });
      return boundedJson(out === undefined ? null : out, SERVICE_JSON_MAX, 'ERR_SERVICE_FAILED', 'result');
    },
    /**
     * GateControl ≥ 1.191.0: the notification center hands a notification to this plugin as the chat sink (hub.js →
     * hook deliverNotice(payload)). Needs permissions.notifySink: true and opts.gatecontrol ≥ 1.191.0 (else
     * ERR_SINK_DENIED (test)). `p` is filled with defaults: { id, topic, source, sourceLabel, topicLabel, title, body,
     * priority, createdAt, data, imageUrl?, card?, family: [ids], own: [ids], lang }. The answer { covered: [ids] } is
     * read like the host: only ids of family ∪ own count; a throwing hook, a bad answer or one after 10 s covers nobody.
     * → { covered, fallback (the ids the host delivers to the inbox instead), answer, error }; recorded in host.sinkCalls.
     */
    async deliverNotice(p = {}) {
      if (!notifySink) throw hostError('ERR_SINK_DENIED', 'not a chat sink (permissions.notifySink, GateControl 1.191.0) (test)');
      const ids = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => Number.isSafeInteger(x) && x > 0))] : []);
      const payload = {
        id: p.id == null ? sinkCalls.length + 1 : p.id, topic: p.topic || 'plugin:gatecontrol-schule:messages', source: p.source || 'plugin:gatecontrol-schule',
        sourceLabel: p.sourceLabel || 'Schule', topicLabel: p.topicLabel || 'Nachrichten der Schule', title: p.title == null ? 'Mitteilung' : p.title,
        body: p.body == null ? '' : p.body, priority: p.priority || 'normal', createdAt: p.createdAt || new Date().toISOString(), data: p.data || {},
        ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}), ...(p.card ? { card: p.card } : {}),
        family: ids(p.family), own: ids(p.own), lang: p.lang === 'en' ? 'en' : 'de',
      };
      const wanted = new Set([...payload.family, ...payload.own]);
      let answer = null;
      let error = null;
      if (typeof plugin.deliverNotice !== 'function') error = 'no_hook';
      else {
        let timer = null;
        try {
          answer = await Promise.race([hook('deliverNotice', payload), new Promise((_, rej) => { timer = setTimeout(() => rej(hostError('ERR_TIMEOUT', 'deliverNotice took over 10 s')), SINK_TIMEOUT_MS); })]);
        } catch (e) { error = (e && e.code) || 'error'; } finally { clearTimeout(timer); }
      }
      const covered = answer && typeof answer === 'object' && Array.isArray(answer.covered) ? ids(answer.covered).filter((u) => wanted.has(u)) : [];
      const out = { covered, fallback: [...wanted].filter((u) => !covered.includes(u)), answer: answer === undefined ? null : answer, error };
      sinkCalls.push({ payload, ...out });
      return out;
    },
    /**
     * GateControl ≥ 1.191.0: may `user` (an id or { id }, one of opts.users) set family routes? Like chatRoutes.js: no
     * active sink → false; administrators without asking; others: the hook mayRouteToFamily({ user: { id, name, role } })
     * === true within 3 s (a throwing or slow hook, no hook → false).
     */
    async mayRouteToFamily(user) {
      return mayRouteToFamilyOf(user && typeof user === 'object' ? user.id : user);
    },
    /** GateControl ≥ 1.191.0: the stored routes { own: Map(userId → Set(topic)), family: Map(topic → setBy) } */
    routes,
    /** GateControl ≥ 1.191.0: the deliverNotice calls { payload, covered, fallback, answer, error } */
    sinkCalls,
    start: () => hook('start'),
    stop: () => hook('stop'),
    tick: () => hook('tick'),
    settingsChanged: (values) => hook('settingsChanged', values),
    /** GateControl ≥ 1.181.0: a callback button of a push was pressed → hook notifyAction({ userId, notificationId, action, data }) */
    async notifyAction(o) {
      if (typeof plugin.notifyAction !== 'function') return undefined;
      return hook('notifyAction', { userId: o.userId, notificationId: o.notificationId == null ? 1 : o.notificationId, action: o.action, data: o.data || {} });
    },
    /**
     * GateControl ≥ 1.185.0: the status lines of the settings page (settingsStatus hook), checked like the
     * host: at most 10, text without control characters (≤ 200), unknown group → null, unknown tone → 'info'
     */
    async settingsStatus(lang = 'de') {
      if (typeof plugin.settingsStatus !== 'function') return [];
      const out = await hook('settingsStatus', { lang: lang === 'en' ? 'en' : 'de' });
      if (!Array.isArray(out)) return [];
      const groups = new Set(((manifest.ui && manifest.ui.settingsGroups) || []).map((g) => g.id));
      const lines = [];
      for (const x of out.slice(0, 10)) {
        if (!x || typeof x !== 'object' || typeof x.text !== 'string') continue;
        const text = x.text.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 200);
        if (!text) continue;
        lines.push({ group: typeof x.group === 'string' && groups.has(x.group) ? x.group : null, tone: ['ok', 'info', 'warn', 'error'].includes(x.tone) ? x.tone : 'info', text });
      }
      return lines;
    },
    /**
     * An administrator saves the settings page (declared keys only; '' clears a secret, an omitted
     * secret stays): the values are stored, settingsChanged runs, the answer carries the status lines.
     */
    async saveSettings(values, lang = 'de') {
      const defs = new Map(((manifest.ui && manifest.ui.settings) || []).map((d) => [d.key, d]));
      for (const [k, v] of Object.entries(values || {})) {
        const def = defs.get(k);
        if (!def) throw hostError('ERR_INVALID', 'unknown setting ' + k);
        if (def.type === 'secret') {
          if (v == null || v === '') { delete settings[k]; secrets.delete(k); } else { settings[k] = String(v); secrets.add(k); }
        } else settings[k] = v;
      }
      await hook('settingsChanged', values);
      return this.settingsStatus(lang);
    },
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
