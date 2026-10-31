'use strict';

// gatecontrol-mail — "Mail": every mail account of a person in one place (GMX, WEB.DE, T-Online, Gmail with an app
// password, Outlook.com and Microsoft 365 with the Microsoft sign-in, any IMAP account), synced by the server — IMAP and
// SMTP through GateControl's gc.mail (≥ 1.216.0), Microsoft through Graph — with push, protection from tracking
// pixels, AI (gc.ai) and Drive / Familie (gc.services).
//
//   app API   /api/v1/client/plugins/gatecontrol-mail/api/…   (the device token's owner)       api.js, README "API"
//   portal    /api/v1/portal/plugins/gatecontrol-mail/api/…   (a signed-in portal viewer)      the same routes
//   admin     admin/settings · admin/overview                   (administrators, admin.js)
//
// Since 1.2.0 also calendars and contacts (C3: calendars.js, events.js, invites.js, cards.js; the sync pim.js beside the
// mail's engine.js, reminders.js).
//
// Hooks: start/stop (the sync engine), tick (every 15 s: syncing — mail first, then a calendar / contact step per
// account in what is left of the run —, the outbox, reminders, account pictures, AI sorting, filing, quota and retention), render (the portal tab, the admin pages), appVisible / portalVisible (who may use Mail), mediaAccess
// (attachments, draft files and account pictures of the person), service (new_draft for Drive), settingsChanged.

const store = require('./store');
const config = require('./config');
const engine = require('./engine');
const compose = require('./compose');
const mailstore = require('./mailstore');
const ai = require('./ai');
const messages = require('./messages');
const drive = require('./drive');
const api = require('./api');
const admin = require('./admin');
const seats = require('./seats');
const avatars = require('./avatars');
const push = require('./push');
const ui = require('./ui');
const pim = require('./pim');
const overlays = require('./overlays');
const reminders = require('./reminders');
const { t } = require('./text');
const { STATUS, fail, isKnown } = require('./util');

const HOST_CODES = { ERR_MEDIA_QUOTA: 'too_large', ERR_RATE_LIMIT: 'rate_limited' };
const CLEAN_MS = 5 * 60000;
let lastClean = 0;

function errorResponse(e, lang) {
  const code = isKnown(e) ? e.code : (e && HOST_CODES[e.code]) || 'internal';
  const extra = isKnown(e) && e.extra ? e.extra : {};
  // the SMTP check of a new account (accounts.js) has its own words: the IMAP login worked
  const key = extra.server === 'smtp' && ['auth_failed', 'unreachable', 'tls'].includes(code) ? `error.smtp_${code}` : `error.${code}`;
  return { status: STATUS[code] || 500, json: { error: { code, message: t(lang, key), ...extra } } };
}

/** A person: a signed-in portal viewer or an app user — never a kiosk device, never the admin UI. */
function refusal(user) {
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return 'forbidden';
  if (user.portal !== true && user.app !== true) return 'forbidden';
  if (user.kiosk === true) return 'forbidden';
  if (user.loggedIn !== true) return 'login_required';
  return null;
}

/** Quota and retention (every few minutes). */
async function clean(gc, now) {
  if (now - lastClean < CLEAN_MS) return;
  lastClean = now;
  const cfg = await config.get(gc);
  try { await engine.retention(gc, cfg, now); } catch (e) { gc.log.warn('retention failed', (e && e.code) || 'error'); }
  for (const r of await store.all(gc, 'SELECT DISTINCT user_id FROM accounts')) {
    // events and contacts count too (1.2.0) — only mail is cleared up
    try { await mailstore.evict(gc, r.user_id, Math.max(0, config.quotaBytes(cfg) - await require('./pimstore').usage(gc, r.user_id)), now); } catch (e) { gc.log.warn('quota failed', (e && e.code) || 'error'); }
  }
  // device sign-ins nobody finished, drafts' uploads that never became a draft are GateControl's (24 h unclaimed)
  await store.run(gc, 'DELETE FROM ms_device WHERE expires_at < ?', [now - 86400000]);
}

module.exports = {
  async start(gc) {
    // a fresh process state (one plugin process — and in tests one per mock host)
    config.reset();
    messages.reset();
    drive.reset();
    ai.reset();
    pim.reset();
    overlays.reset();
    engine.start(gc);
  },

  async stop() {
    compose.stop();
    await engine.stop();
  },

  async request(req, gc) {
    const lang = req && req.lang === 'en' ? 'en' : 'de';
    try {
      const seg = String(req.path || '/').split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
      if (!seg.length) throw fail('not_found');
      if (seg[0] === 'admin') {
        if (!req.user || req.user.portal || req.user.app || req.user.role !== 'admin') throw fail('forbidden');
        return { status: 200, json: await admin.route(gc, req, seg) };
      }
      const s = seg[0] === 'portal' && seg.length > 1 ? seg.slice(1) : seg;
      const no = refusal(req.user);
      if (no) throw fail(no);
      const cfg = await config.get(gc);
      if (!(await config.allowed(gc, cfg, req.user.id))) throw fail('not_allowed');
      // the licence's people (seats.js, like Drive): GET me answers also without a place (seat: null), the rest needs one
      const { licence, seat } = await seats.access(gc, cfg, req.user.id, Date.now());
      const isMe = s.length === 1 && s[0] === 'me' && String(req.method || 'GET').toUpperCase() === 'GET';
      if (!isMe && !licence.valid) throw fail('not_licensed');
      if (!isMe && !seat) throw fail('no_seat');
      const ctx = { userId: req.user.id, userName: req.user.name || '', lang, seat, licence };
      return { status: 200, json: await api.route(gc, ctx, req, s) };
    } catch (e) {
      if (!isKnown(e) && !(e && HOST_CODES[e.code])) gc.log.warn('request failed', req && req.method, String((req && req.path) || '').split('/').slice(0, 2).join('/'), (e && (e.code || e.message)) || 'error');
      return errorResponse(e, lang);
    }
  },

  async render(view, gc) {
    const v = view || {};
    let allowed = false;
    if (v.user && Number.isSafeInteger(v.user.id)) { try { allowed = await config.allowed(gc, await config.get(gc), v.user.id); } catch { allowed = false; } }
    return { html: ui.render({ ...v, allowed }, t) };
  },

  async tick(gc) {
    const now = Date.now();
    // without a valid licence nothing is synced or sent; people an administrator switched off neither (seats.js)
    let off;
    try { off = await seats.idle(gc); } catch { off = null; }
    if (off && off.all) { try { await clean(gc, Date.now()); } catch (e) { gc.log.warn('clean failed', (e && e.code) || 'error'); } return; }
    const skip = (off && off.users) || new Set();
    try { await compose.due(gc, now, skip); } catch (e) { gc.log.warn('outbox failed', (e && e.code) || 'error'); }
    try { await engine.tick(gc, now, 70000, skip); } catch (e) { gc.log.warn('sync run failed', (e && e.code) || 'error'); }
    // calendars and contacts: after the mail, in what is left of the run (1.2.0)
    try { await pim.tick(gc, Date.now(), now, 70000, skip); } catch (e) { gc.log.warn('calendar sync failed', (e && e.code) || 'error'); }
    try { await reminders.tick(gc, Date.now(), skip); } catch (e) { gc.log.warn('reminders failed', (e && e.code) || 'error'); }
    try { for (const a of await avatars.tick(gc, Date.now(), skip)) await push.changed(gc, a.user_id, a.id, null); } catch (e) { gc.log.warn('pictures failed', (e && e.code) || 'error'); }
    try { await compose.due(gc, Date.now(), skip); } catch { /* next run */ }
    try { await ai.tick(gc); } catch (e) { gc.log.warn('ai sorting failed', (e && e.code) || 'error'); }
    try { await drive.tick(gc, Date.now()); } catch (e) { gc.log.warn('filing failed', (e && e.code) || 'error'); }
    try { await clean(gc, Date.now()); } catch (e) { gc.log.warn('clean failed', (e && e.code) || 'error'); }
  },

  /** The app tab: only for people the administrator allows. */
  async appVisible(user, gc) {
    if (!user || !Number.isSafeInteger(user.id)) return false;
    return config.allowed(gc, await config.get(gc), user.id);
  },

  async portalVisible({ user, section } = {}, gc) {
    if (section || !user || !Number.isSafeInteger(user.id) || user.kiosk === true) return false;
    return config.allowed(gc, await config.get(gc), user.id);
  },

  /** Who may read a file: attachments of the person's mail, the files of the person's drafts, the pictures of their accounts. */
  async mediaAccess({ user, mediaId } = {}, gc) {
    if (!user || !Number.isSafeInteger(user.id) || user.kiosk === true || typeof mediaId !== 'string') return false;
    if (await store.one(gc, 'SELECT 1 AS x FROM accounts WHERE avatar_media = ? AND user_id = ?', [mediaId, user.id])) return true;
    if (await store.one(gc, 'SELECT 1 AS x FROM attachments t JOIN messages m ON m.id = t.message_id WHERE t.media_id = ? AND m.user_id = ?', [mediaId, user.id])) return true;
    return !!(await store.one(gc, 'SELECT 1 AS x FROM draft_atts x JOIN drafts d ON d.id = x.draft_id WHERE x.media_id = ? AND d.user_id = ?', [mediaId, user.id]));
  },

  /** For Drive: new_draft { files: [{ mediaId, name? }], subject? } — files handed over first. */
  async service({ name, user, payload } = {}, gc) {
    if (name !== 'new_draft') return { ok: false, code: 'not_found' };
    const cfg = await config.get(gc);
    if (!user || !(await config.allowed(gc, cfg, user.id))) return { ok: false, code: 'forbidden' };
    const { licence, seat } = await seats.access(gc, cfg, user.id, Date.now());
    if (!licence.valid) return { ok: false, code: 'not_licensed' };
    if (!seat) return { ok: false, code: 'no_seat' };
    return compose.serviceDraft(gc, user, payload);
  },

  async settingsChanged() {
    config.reset();
  },
};
