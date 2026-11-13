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
// account in what is left of the run —, the outbox, reminders, account pictures, AI sorting, filing, quota and retention,
// since 1.5.0 the attachments of 1.4 into their media area — storage.js), render (the portal tab, the admin pages), appVisible / portalVisible (who may use Mail), mediaAccess
// (attachments, draft files and account pictures of the person), service (new_draft, since 1.6.0 calendar_list and
// calendar_add, since 1.7.0 tofile_count for Drive — services.js; since 1.11.0 todo_items / todo_complete for „Notizen &
// Aufgaben“ — notizen.js), settingsChanged. Since 1.11.0 the AI's „Zu tun“ and flagged mails go to that hub
// (gatecontrol-notizen:todo_changed, only what changed — notizen.js, todohub.js).

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
const cardmerge = require('./cardmerge');
const overlays = require('./overlays');
const reminders = require('./reminders');
const storage = require('./storage');
const services = require('./services');
const notizen = require('./notizen');
const scan = require('./scan');
const searchIndex = require('./search');
const { t } = require('./text');
const { STATUS, fail, isKnown } = require('./util');

const HOST_CODES = { ERR_MEDIA_QUOTA: 'too_large', ERR_RATE_LIMIT: 'rate_limited',
  // 1.8.0: GateControl's virus scan holds a file back / deleted it at once
  ERR_MEDIA_QUARANTINED: 'quarantined', ERR_MEDIA_SCAN_PENDING: 'scan_pending', ERR_MEDIA_BLOCKED: 'scan_blocked', ERR_MEDIA_INFECTED: 'attachment_removed' };
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
  try { await engine.retention(gc, cfg, now); } catch (e) { gc.log.warn('retention failed', (e && (e.code || e.message)) || 'error'); }
  for (const r of await store.all(gc, 'SELECT DISTINCT user_id FROM accounts')) {
    // events and contacts count too (1.2.0) — only mail is cleared up
    try { await mailstore.evict(gc, r.user_id, Math.max(0, config.quotaBytes(cfg) - await require('./pimstore').usage(gc, r.user_id)), now); } catch (e) { gc.log.warn('quota failed', (e && (e.code || e.message)) || 'error'); }
  }
  // device sign-ins nobody finished, drafts' uploads that never became a draft are GateControl's (24 h unclaimed)
  await store.run(gc, 'DELETE FROM ms_device WHERE expires_at < ?', [now - 86400000]);
  // 1.11.0: ticks of mails that are gone („Notizen & Aufgaben“)
  try { await notizen.purge(gc, now); } catch (e) { gc.log.warn('to-do retention failed', (e && (e.code || e.message)) || 'error'); }
}

// the background run's own budget (1.13.1) — GateControl's limit is 120 s (engine.limits.totalMs / hardMs)
const budget = engine.limits;
const LATE = Symbol('late');
let pending = null; // the background run that still works (tick)

/** The parts of a background run in order — each only while the run's budget lasts (`run.part`: the one at work). */
async function parts(gc, run) {
  const now = run.since;
  const left = () => budget.totalMs - (Date.now() - now);
  const part = async (name, fn, warn) => {
    run.part = name;
    try { await fn(); } catch (e) { if (warn) gc.log.warn(warn, (e && (e.code || e.message)) || 'error'); }
  };
  // without a valid licence nothing is synced or sent; people an administrator switched off neither (seats.js)
  let off;
  run.part = 'seats';
  try { off = await seats.idle(gc); } catch { off = null; }
  if (off && off.all) { await part('clean', () => clean(gc, Date.now()), 'clean failed'); return; }
  const skip = (off && off.users) || new Set();
  await part('outbox', () => compose.due(gc, now, skip), 'outbox failed');
  // the mail: two thirds of the run at most
  await part('mail', () => engine.tick(gc, now, Math.min(engine.limits.runMs, Math.max(0, left())), skip), 'sync run failed');
  // calendars and contacts: after the mail, in what is left of the run (1.2.0)
  if (left() > 0) await part('calendar', () => pim.tick(gc, Date.now(), now, budget.totalMs, skip), 'calendar sync failed');
  // contacts: the one run per person after 1.4.0 (duplicates become one GC contact), one person per run
  if (left() > 0) await part('contacts', () => cardmerge.tick(gc, skip), 'contacts merge failed');
  // reminders and the outbox are due at their time: always
  await part('reminders', () => reminders.tick(gc, Date.now(), skip), 'reminders failed');
  if (left() > 0) await part('pictures', async () => { for (const a of await avatars.tick(gc, Date.now(), skip)) await push.changed(gc, a.user_id, a.id, null); }, 'pictures failed');
  await part('outbox', () => compose.due(gc, Date.now(), skip), null);
  // 1.14.0: the full-text search when it is on — its build, or its removal after it was switched off, a few seconds
  // per run (search.js); off and nothing there: no statement
  if (left() > 0) await part('search index', async () => searchIndex.tick(gc, (await config.get(gc)).search.fulltext, left), 'search index failed');
  if (left() > 0) await part('ai', () => ai.tick(gc, left), 'ai sorting failed');
  if (left() > 0) await part('filing', () => drive.tick(gc, Date.now(), left), 'filing failed');
  // since 1.5.0 (Speicherorte, storage.js): the prefetch that waited for room at GateControl; the attachments of 1.4
  // and older into the area `attachments`, a batch per run
  if (left() > 0) await part('attachments', () => engine.filesLater(gc), 'attachments later failed');
  if (left() > 0) await part('areas', () => storage.adopt(gc, Date.now()), 'area move failed');
  if (left() > 0) await part('clean', () => clean(gc, Date.now()), 'clean failed');
  // 1.11.0: „Zu tun“ and flagged mails to „Notizen & Aufgaben“ — only what changed, at most once a minute (never throws)
  if (left() > 0) { run.part = 'notes'; await notizen.source.tick(gc, Date.now()); }
  run.part = 'done';
}

module.exports = {
  async start(gc) {
    // a fresh process state (one plugin process — and in tests one per mock host)
    pending = null;
    config.reset();
    messages.reset();
    drive.reset();
    ai.reset();
    pim.reset();
    cardmerge.reset();
    overlays.reset();
    storage.reset();
    // 1.11.0: „Notizen & Aufgaben“ — a fresh push state; is the hub there (asks nobody)?
    notizen.source.reset();
    await notizen.source.available(gc);
    engine.start(gc);
    // 1.14.0: the search index — its table and triggers before the first mail comes (never fails the start)
    searchIndex.reset();
    try { await searchIndex.apply(gc, (await config.get(gc)).search.fulltext); } catch (e) { gc.log.warn('search index failed', (e && (e.code || e.message)) || 'error'); }
  },

  async stop() {
    notizen.source.stop();
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
      const json = await api.route(gc, ctx, req, s);
      // 1.11.0: a flag, a to-do or a mail changed — „Notizen & Aufgaben“ gets the difference in a few seconds
      if (String(req.method || 'GET').toUpperCase() !== 'GET' && (s[0] === 'messages' || s[0] === 'ai')) notizen.source.soon(gc);
      return { status: 200, json };
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

  /**
   * 1.8.0: GateControl's virus scan changed a file after it was stored (the check of a big attachment ended, the nightly
   * re-check, an administrator released or deleted it): the attachment's or the draft file's state, the live event 'mail'
   * { kind: 'changed', messageId, attachmentId } to its person (scan.js). A deleted copy: the attachment stays removed.
   */
  async mediaScanned(arg, gc) {
    const id = arg && typeof arg.mediaId === 'string' && /^[0-9a-f]{32}$/.test(arg.mediaId) ? arg.mediaId : null;
    if (!id) return;
    try {
      const gone = arg.state === 'deleted';
      const sc = scan.norm(gone ? { state: 'infected', blocked: true, finding: arg.finding || null } : arg);
      if (!sc) return;
      for (const t of await store.all(gc, 'SELECT t.id, t.message_id, m.user_id, m.account_id, m.folder_id FROM attachments t JOIN messages m ON m.id = t.message_id WHERE t.media_id = ?', [id])) {
        if (gone) await scan.removed(gc, t.id, sc.finding);
        else await scan.keepAttachment(gc, t.id, sc);
        await push.changed(gc, t.user_id, t.account_id, t.folder_id, { messageId: t.message_id, attachmentId: t.id });
      }
      for (const x of await store.all(gc, 'SELECT x.id, x.draft_id, d.user_id, d.account_id FROM draft_atts x JOIN drafts d ON d.id = x.draft_id WHERE x.media_id = ?', [id])) {
        await store.run(gc, 'UPDATE draft_atts SET scan_state = ?, scan_blocked = ?, scan_finding = ? WHERE id = ?', [...scan.cols(sc), x.id]);
        await push.changed(gc, x.user_id, x.account_id, null, { draftId: x.draft_id });
      }
    } catch (e) { gc.log.warn('scan state failed', (e && e.code) || 'error'); }
  },

  /**
   * The background run. GateControl gives it 120 s („background run failed: plugin did not answer in time“ after that)
   * — since 1.13.1 it keeps to a budget of its own: the parts run in order while RUN_MS are not used up (what does not
   * fit comes in the next run, 15 s later), and after HARD_MS the run answers even when a part still hangs (it goes on
   * alone; no new run starts beside it, and the log names the part once).
   */
  async tick(gc) {
    if (pending) return;
    const run = { part: 'start', since: Date.now() };
    const work = parts(gc, run).catch((e) => { gc.log.warn('background run failed', run.part, (e && (e.code || e.message)) || 'error'); }).finally(() => { if (pending === work) pending = null; });
    pending = work;
    let t;
    const late = new Promise((resolve) => { t = setTimeout(resolve, budget.hardMs, LATE); });
    const out = await Promise.race([work, late]);
    clearTimeout(t);
    if (out === LATE) gc.log.warn('background run takes long', `part ${run.part}`, `${Math.round((Date.now() - run.since) / 1000)} s`, '— the next run waits for it');
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

  /**
   * For Drive (services.js): new_draft { files: [{ mediaId, name? }], subject? } — files handed over first; since 1.6.0
   * calendar_list and calendar_add (deadlines into a calendar of Mail); since 1.7.0 tofile_count ("Zum Ablegen" in
   * Drive's overview).
   */
  async service(call, gc) {
    // 1.11.0: todo_items / todo_complete for „Notizen & Aufgaben“ (gatecontrol-notizen only) — notizen.js
    const hub = await notizen.source.service(gc, call);
    if (hub !== undefined) return hub;
    return services.handle(gc, call);
  },

  async settingsChanged() {
    config.reset();
  },
};
