'use strict';

// gatecontrol-messenger — chats between the GateControl accounts: the apps
// (own tab "Chats", permissions.app + ui.app — the apps draw it natively from
// the API), the Windows client, the portal (own tab "Chats", a sandboxed frame)
// and two admin pages without any message content (Übersicht, Protokoll).
//
//   chat API   (apps, portal)              server/api.js — contract in README.md "App-API"
//   admin API  admin/* (administrators)    server/admin.js
//   services   send_message, sync_group, release_group (1.1.0)    server/services.js (for Familie)
//   media      gc.media (uploads by the apps / GC.upload), hook mediaAccess: members only
//   live       gc.events (message.new, …), chat pushes (notifyTopics[].chat) — server/live.js, server/push.js
//   background disappearing messages, retention, file clean-up — server/jobs.js
//   1.4.0      status and stories (status.js), privacy / blocks / last seen (social.js), chat tools (tools.js,
//              suggest.js), polls, events, live arrival, home actions and plugin cards (polls.js, eventmsg.js,
//              arrival.js, homeactions.js, rich.js), Familie's services (familie.js), routes in api14.js;
//              service set_place_status (services.js)
//   1.5.0      home actions for families: GET actions/requestable, request approvers (Familie's family_roles),
//              request time, grant offAtEnd, send_message target direct:<id>, GET me homeActions (homeactions.js,
//              services.js, familie.js)
//   1.6.0      the chat sink of GateControl's notification center (permissions.notifySink, GateControl ≥ 1.191.0):
//              hooks deliverNotice (family group / own notice channels per source) and mayRouteToFamily, conversation
//              fields listPinned and notice (notices.js, conversations.js)
//   1.7.0      hook ensureNoticeChat (GateControl ≥ 1.192.0): choosing "own chat" creates the source's notice channel at
//              once (or finds the existing one); portal/notify-routes PUT answers `chat` (notices.js)
//
// Needs GateControl ≥ 1.177.0 (media, realtime events, chat notifications, services); Familie integration
// needs gc.services.available (1.178.0); home actions use gc.actions (1.166.0+, interactive runs 1.180.0).

const ui = require('./ui');
const api = require('./api');
const admin = require('./admin');
const config = require('./config');
const people = require('./people');
const seal = require('./seal');
const store = require('./store');
const live = require('./live');
const jobs = require('./jobs');
const services = require('./services');
const social = require('./social');
const status = require('./status');
const homeactions = require('./homeactions');
const notices = require('./notices');
const texts = require('./texts.json');
const { STATUS, isKnown } = require('./util');

function t(lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

function errorResponse(e, lang) {
  const code = isKnown(e) ? e.code : 'internal';
  return { status: STATUS[code], json: { ok: false, code, error: t(lang, 'error.' + code) } };
}

/** The request context of a chat call. */
async function context(gc, user, now, lang) {
  const ctx = { gc, viewer: user ? user.id : null, now, lang: lang === 'en' ? 'en' : 'de', users: await people.users(gc, now), cfg: await config.load(gc), portal: !(user && user.app === true), box: live.outbox() };
  // 1.4.0: pictures of people whose avatar privacy leaves the viewer out are not handed out
  if (ctx.viewer != null) ctx.users = social.maskUsers(await social.load(ctx), ctx.users, ctx.viewer);
  return ctx;
}

async function ensureKey(gc) {
  if (!seal.ready()) await seal.init(gc);
}

/** A person who may chat: a signed-in portal viewer or an app user — never a kiosk device, never the admin UI. */
function chatViewer(user) {
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return 'forbidden';
  if (user.portal !== true && user.app !== true) return 'forbidden';
  if (user.kiosk === true) return 'forbidden';
  if (user.loggedIn !== true) return 'login_required';
  return null;
}

module.exports = {
  async start(gc) {
    live.reset();
    jobs.reset();
    config.reset();
    people.reset();
    homeactions.reset();
    require('./familie').reset();
    seal._reset();
    await seal.init(gc);
    gc.log.info('messenger started', gc.plugin.version);
  },

  async request(req, gc) {
    const lang = req && req.lang;
    try {
      await ensureKey(gc);
      const seg = String(req.path || '/').split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
      if (!seg.length) return errorResponse({ code: 'not_found' }, lang);
      const now = Date.now();
      if (seg[0] === 'admin') {
        // admin pages only: an administrator in GateControl's admin UI, never a portal or app caller
        if (!req.user || req.user.portal || req.user.app || req.user.role !== 'admin') return errorResponse({ code: 'forbidden' }, lang);
        return { status: 200, json: { ok: true, ...(await admin.route(req, gc, seg, now)) } };
      }
      const refusal = chatViewer(req.user);
      if (refusal) {
        if (req.user && req.user.kiosk === true && Number.isSafeInteger(req.user.id)) await store.tx(gc, () => people.markKiosk(gc, req.user.id, now));
        return errorResponse({ code: refusal }, lang);
      }
      const ctx = await context(gc, req.user, now, lang);
      if (!ctx.users.has(ctx.viewer)) return errorResponse({ code: 'forbidden' }, lang);
      await store.tx(gc, () => people.touch(gc, req.user, lang, now));
      let res;
      try {
        res = await api.route(ctx, req, seg);
      } catch (e) {
        ctx.box = live.outbox(); // nothing of a failed request goes out
        throw e;
      }
      await api.flush(ctx);
      return res;
    } catch (e) {
      if (!isKnown(e)) gc.log.warn('request failed', req && req.method, String((req && req.path) || '').split('/').slice(0, 2).join('/'), (e && (e.code || e.message)) || 'error');
      return errorResponse(e, lang);
    }
  },

  async render(view, gc) {
    return { html: ui.render(view || {}, t) };
  },

  /** The portal tab "Chats": every signed-in account — not a kiosk device (a wall tablet is no person). */
  async portalVisible({ user, section } = {}, gc) {
    if (section) return false;
    if (user && user.kiosk === true && Number.isSafeInteger(user.id)) {
      try { await store.tx(gc, () => people.markKiosk(gc, user.id)); } catch { /* shown or not, nothing else depends on it */ }
      return false;
    }
    return !!user;
  },

  /** The app tab "Chats": every account. */
  async appVisible(arg) {
    const user = arg && typeof arg === 'object' && arg.user && typeof arg.user === 'object' ? arg.user : arg;
    return !!(user && Number.isSafeInteger(user.id));
  },

  /**
   * May this viewer read a file (GET …/media/<id> of the apps)? Members of the conversation the file
   * belongs to (message, preview picture or group picture) — only from the message on that they see.
   * A file not (yet) part of a message: its uploader only.
   */
  async mediaAccess({ user, mediaId, owner } = {}, gc) {
    if (!user || !Number.isSafeInteger(user.id) || user.kiosk === true) return false;
    const m = await store.one(gc, 'SELECT * FROM media WHERE media_id = ?', [mediaId]);
    if (!m) return owner != null && owner === user.id;
    if (m.orphan) return false;
    // 1.4.0: story files — the story's audience while it lasts (and the owner)
    if (m.role === 'story' || m.role === 'story_thumb') {
      await ensureKey(gc);
      const ctx = { gc, viewer: user.id, now: Date.now(), users: await people.users(gc), cfg: await config.load(gc) };
      return status.mediaAllowed(ctx, m);
    }
    const me = await store.one(gc, 'SELECT * FROM members WHERE conv_id = ? AND user_id = ? AND left_at IS NULL', [m.conv_id, user.id]);
    if (!me) return false;
    if (m.role === 'avatar') return true;
    const msg = m.msg_id == null ? null : await store.one(gc, 'SELECT id, conv_id, deleted_at FROM messages WHERE id = ?', [m.msg_id]);
    if (!msg || msg.conv_id !== m.conv_id || msg.deleted_at || msg.id <= me.joined_msg_id) return false;
    const hidden = await store.one(gc, 'SELECT 1 AS x FROM hidden WHERE msg_id = ? AND user_id = ?', [msg.id, user.id]);
    return !hidden;
  },

  /** Services for other plugins (services.provides): send_message, sync_group, release_group — server/services.js. */
  async service(call, gc) {
    await ensureKey(gc);
    const now = Date.now();
    const ctx = await context(gc, call && call.user, now);
    ctx.portal = false;
    return services.handle(ctx, call || {}, () => api.flush(ctx));
  },

  /**
   * 1.6.0 (GateControl ≥ 1.191.0, permissions.notifySink): a notification people routed into chats → { covered: [ids] }
   * (the others get it in GateControl's inbox) — server/notices.js. Never throws: whatever fails is not covered.
   */
  async deliverNotice(payload, gc) {
    const now = Date.now();
    try {
      await ensureKey(gc);
      const ctx = await context(gc, null, now, payload && payload.lang);
      ctx.portal = false;
      const covered = await notices.deliver(ctx, payload);
      await api.flush(ctx);
      return { covered };
    } catch (e) {
      gc.log.warn('deliverNotice failed', (e && (e.code || e.message)) || 'error');
      return { covered: [] };
    }
  },

  /**
   * 1.7.0 (GateControl ≥ 1.192.0): someone chose "own chat" for a topic → that source's notice channel of the person
   * exists from now on (the existing one, else created) → { conversationId, created } or null. Never throws.
   */
  async ensureNoticeChat(arg, gc) {
    const now = Date.now();
    try {
      await ensureKey(gc);
      const ctx = await context(gc, null, now, arg && arg.lang);
      ctx.portal = false;
      const out = await notices.ensure(ctx, arg);
      await api.flush(ctx);
      return out;
    } catch (e) {
      gc.log.warn('ensureNoticeChat failed', (e && (e.code || e.message)) || 'error');
      return null;
    }
  },

  /** 1.6.0: may this person send a topic into the family chat (a household setting)? Administrators and Familie's parents. */
  async mayRouteToFamily(arg, gc) {
    const user = arg && typeof arg === 'object' && arg.user && typeof arg.user === 'object' ? arg.user : null;
    try { return await notices.mayRouteToFamily(gc, user); } catch { return false; }
  },

  async tick(gc) {
    await ensureKey(gc);
    return jobs.tick(gc, Date.now());
  },
};
