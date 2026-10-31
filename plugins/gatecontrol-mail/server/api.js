'use strict';

// The API of the apps and the portal (C2): /api/v1/client/plugins/gatecontrol-mail/api/<path> (device token) and
// /api/v1/portal/plugins/gatecontrol-mail/api/<path> (a signed-in portal viewer). IDs are positive integers, times ms.
// Errors: { error: { code, … } } with 400 / 403 / 404 / 409 / 413 / 429 (util.js STATUS).

const store = require('./store');
const config = require('./config');
const providers = require('./providers');
const accounts = require('./accounts');
const messages = require('./messages');
const compose = require('./compose');
const ai = require('./ai');
const drive = require('./drive');
const mailstore = require('./mailstore');
const avatars = require('./avatars');
const dav = require('./dav');
const pim = require('./pim');
const pimstore = require('./pimstore');
const overlays = require('./overlays');
const calendars = require('./calendars');
const events = require('./events');
const invites = require('./invites');
const cards = require('./cards');
const cardmerge = require('./cardmerge');
const { fail } = require('./util');

// since 1.2.0: the paths of calendars and contacts (403 feature_off when the administrator switched them off)
const CALENDAR_PATHS = new Set(['calendars', 'overlays', 'calendar', 'events', 'invitations']);
const CONTACT_PATHS = new Set(['addressbooks', 'cards', 'groups']);

const SWIPES = ['archive', 'delete', 'read', 'none'];

async function prefs(gc, userId) {
  const p = await store.one(gc, 'SELECT * FROM prefs WHERE user_id = ?', [userId]);
  return { threads: p ? p.threads === 1 : true, swipeLeft: p ? p.swipe_left : 'archive', swipeRight: p ? p.swipe_right : 'read' };
}

/** PUT settings { threads?, swipeLeft?, swipeRight? } → { settings } */
async function putPrefs(gc, userId, b) {
  const cur = await prefs(gc, userId);
  const x = b && typeof b === 'object' ? b : {};
  if (x.threads !== undefined) { if (typeof x.threads !== 'boolean') throw fail('invalid', { field: 'threads' }); cur.threads = x.threads; }
  for (const k of ['swipeLeft', 'swipeRight']) if (x[k] !== undefined) { if (!SWIPES.includes(x[k])) throw fail('invalid', { field: k }); cur[k] = x[k]; }
  await store.run(gc, `INSERT INTO prefs (user_id, threads, swipe_left, swipe_right, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET threads = excluded.threads, swipe_left = excluded.swipe_left, swipe_right = excluded.swipe_right, updated_at = excluded.updated_at`,
  [userId, cur.threads ? 1 : 0, cur.swipeLeft, cur.swipeRight, Date.now()]);
  return { settings: cur };
}

/** The features of GET me for this person. */
async function features(gc, cfg, userId) {
  const out = ['mail'];
  if (cfg.ai.bar && await ai.ready(gc)) out.push('ai');
  if (config.msClientId(cfg)) out.push('microsoft');
  if (await drive.hasSeat(gc, userId)) out.push('drive');
  if (await ai.familyCalendar(gc)) out.push('familyCalendar');
  if (gc.http && typeof gc.http.fetchImage === 'function') out.push('images');
  // since 1.2.0: calendars and contacts (the administrator), CalDAV/CardDAV of the host, the overlays of Familie / Alltag
  if (cfg.calendar.enabled) out.push('calendar');
  if (cfg.contacts.enabled) out.push('contacts');
  if (dav.can(gc)) out.push('dav');
  if (cfg.calendar.enabled && cfg.calendar.overlays.familie && await overlays.familyOn(gc)) out.push('familyOverlay');
  if (cfg.calendar.enabled && cfg.calendar.overlays.alltag && await overlays.alltagOn(gc)) out.push('alltagOverlay');
  return out;
}

/** An account row → the Account of the API with its calendar and contact side (C2). */
async function accountOut(gc, cfg, a) {
  return { ...accounts.view(a), ...(await pim.accountView(gc, cfg, a)) };
}

/** GET me */
async function me(gc, ctx) {
  const cfg = await config.get(gc);
  const list = await accounts.list(gc, ctx.userId);
  const out = [];
  for (const a of list) out.push(await accountOut(gc, cfg, a));
  const clientId = config.msClientId(cfg);
  return {
    features: await features(gc, cfg, ctx.userId),
    // usedBytes: mail plus the bytes of events, contacts and their photos (1.2.0; only mail is cleared up)
    limits: { accountsMax: cfg.accountsMax, quotaBytes: config.quotaBytes(cfg), usedBytes: await mailstore.usage(gc, ctx.userId) + await pimstore.usage(gc, ctx.userId), retentionMonths: cfg.retentionMonths },
    microsoft: { clientId, authority: config.MS_AUTHORITY, scopes: config.msScopes(cfg), adminConsentUrl: config.adminConsentUrl(clientId) },
    accounts: out, unread: await messages.unread(gc, ctx.userId), settings: await prefs(gc, ctx.userId),
    // since 1.1.0 (like Drive): the person's place in the licence — without one (null) every other call answers 403
    // no_seat, without a valid licence not_licensed
    seat: ctx.seat ? ctx.seat.kind : null, licence: { valid: !!(ctx.licence && ctx.licence.valid), tier: (ctx.licence && ctx.licence.tier) || null },
  };
}

/** The route of one request (seg: the path's segments) → the answer's JSON. */
async function route(gc, ctx, req, seg) {
  const m = req.method;
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const q = req.query || {};
  const [s0, s1, s2, s3, s4, s5] = seg;
  const n = seg.length;
  const id = (v) => Number(v);
  // an answer with `account` (1.2.0): with its calendar and contact side
  const full = async (p) => {
    const r = await p;
    if (r && r.account && r.account.id) {
      const row = await store.one(gc, 'SELECT * FROM accounts WHERE id = ?', [r.account.id]);
      if (row) r.account = await accountOut(gc, await config.get(gc), row);
    }
    return r;
  };
  if (CALENDAR_PATHS.has(s0) || CONTACT_PATHS.has(s0)) {
    const cfg = await config.get(gc);
    if (CALENDAR_PATHS.has(s0) && !cfg.calendar.enabled) throw fail('feature_off', { feature: 'calendar' });
    if (CONTACT_PATHS.has(s0) && !cfg.contacts.enabled) throw fail('feature_off', { feature: 'contacts' });
  }
  switch (s0) {
    case 'me': if (n === 1 && m === 'GET') return me(gc, ctx); break;
    case 'settings': if (n === 1 && m === 'PUT') return putPrefs(gc, ctx.userId, b); break;
    case 'providers': if (n === 1 && m === 'GET') return providers.list(ctx.lang); break;
    case 'accounts':
      if (n === 1 && m === 'POST') return full(accounts.add(gc, ctx, b));
      if (n === 2 && s1 === 'discover' && m === 'POST') return providers.discover(gc, b);
      if (n === 2 && s1 === 'microsoft' && m === 'POST') return full(accounts.addMicrosoft(gc, ctx, b));
      if (n === 3 && s1 === 'microsoft' && s2 === 'device' && m === 'POST') return accounts.deviceStart(gc, ctx, b);
      if (n === 4 && s1 === 'microsoft' && s2 === 'device' && m === 'GET') return full(accounts.devicePoll(gc, ctx, s3));
      if (n === 2 && m === 'PATCH') return full(accounts.patch(gc, ctx, id(s1), b));
      if (n === 2 && m === 'DELETE') return accounts.remove(gc, ctx, id(s1));
      if (n === 3 && s2 === 'microsoft' && m === 'POST') return full(accounts.reMicrosoft(gc, ctx, id(s1), b));
      if (n === 3 && s2 === 'avatar' && m === 'GET') return avatars.get(gc, ctx.userId, id(s1));
      break;
    case 'folders': if (n === 1 && m === 'GET') return messages.folders(gc, ctx.userId); break;
    case 'messages':
      if (n === 1 && m === 'GET') return messages.list(gc, ctx.userId, q);
      if (n === 2 && m === 'POST') {
        if (s1 === 'flags') return messages.flags(gc, ctx.userId, b);
        if (s1 === 'move') return messages.move(gc, ctx.userId, b);
        if (s1 === 'archive') return messages.archive(gc, ctx.userId, b);
        if (s1 === 'delete') return messages.remove(gc, ctx.userId, b);
        if (s1 === 'junk') return messages.junk(gc, ctx.userId, b);
        if (s1 === 'tab') return messages.tab(gc, ctx.userId, b);
      }
      if (n === 2 && m === 'GET') return messages.get(gc, ctx.userId, s1);
      if (n === 3 && s2 === 'images' && m === 'POST') return messages.allowImages(gc, ctx.userId, s1, b);
      if (n === 4 && s2 === 'attachments' && m === 'GET') return messages.attachment(gc, ctx.userId, s1, s3);
      if (n === 6 && s2 === 'attachments' && s4 === 'drive' && s5 === 'suggest' && m === 'POST') return drive.suggest(gc, ctx.userId, s1, s3);
      if (n === 6 && s2 === 'attachments' && s4 === 'drive' && s5 === 'save' && m === 'POST') return drive.save(gc, ctx.userId, ctx.lang, s1, s3, b);
      if (n === 4 && s2 === 'drive' && s3 === 'save-all' && m === 'POST') return drive.saveAll(gc, ctx.userId, ctx.lang, s1);
      break;
    case 'search': if (n === 1 && m === 'GET') return messages.search(gc, ctx.userId, q); break;
    case 'threads': if (n === 2 && m === 'GET') return messages.thread(gc, ctx.userId, s1); break;
    case 'img': if (n === 2 && m === 'GET') return messages.image(gc, ctx.userId, s1); break;
    case 'cid': if (n === 3 && m === 'GET') return messages.cid(gc, ctx.userId, s1, s2); break;
    case 'drafts':
      if (n === 1 && m === 'POST') return compose.create(gc, ctx, b);
      if (n === 2 && m === 'GET') return compose.get(gc, ctx, s1);
      if (n === 2 && m === 'PUT') return compose.update(gc, ctx, s1, b);
      if (n === 2 && m === 'DELETE') return compose.remove(gc, ctx, s1);
      if (n === 3 && s2 === 'send' && m === 'POST') return compose.send(gc, ctx, s1, b);
      break;
    case 'outbox':
      if (n === 1 && m === 'GET') return compose.outbox(gc, ctx);
      if (n === 3 && s2 === 'cancel' && m === 'POST') return compose.cancel(gc, ctx, s1);
      break;
    case 'contacts': if (n === 1 && m === 'GET') return compose.contacts(gc, ctx, q.q); break;
    case 'ai':
      if (n === 2 && m === 'GET') return ai.get(gc, ctx.userId, s1);
      if (n === 2 && m === 'POST') return ai.run(gc, ctx.userId, s1, b);
      if (n === 4 && s2 === 'todo' && m === 'POST') {
        // since 1.2.0: { action: 'calendar', calendarId? } into the own calendar
        if (b.action === 'calendar') {
          const cfg = await config.get(gc);
          if (!cfg.calendar.enabled) throw fail('feature_off', { feature: 'calendar' });
          return ai.todoCalendar(gc, ctx, s1, s3, b, events.fromTodo);
        }
        return ai.todo(gc, ctx.userId, ctx.lang, s1, s3, b);
      }
      break;
    // ─── calendars (1.2.0) ─────────────
    case 'calendars':
      if (n === 1 && m === 'GET') return calendars.list(gc, ctx);
      if (n === 1 && m === 'POST') return calendars.create(gc, ctx, b);
      if (n === 2 && s1 === 'subscribe' && m === 'POST') return calendars.subscribe(gc, ctx, b);
      if (n === 2 && m === 'PATCH') return calendars.patch(gc, ctx, id(s1), b);
      if (n === 2 && m === 'DELETE') return calendars.remove(gc, ctx, id(s1));
      break;
    case 'overlays': if (n === 2 && m === 'PATCH') return overlays.patch(gc, await config.get(gc), ctx.userId, s1, b, ctx.lang); break;
    case 'calendar': if (n === 2 && s1 === 'settings' && m === 'PUT') return calendars.settings(gc, ctx, b); break;
    case 'events':
      if (n === 1 && m === 'GET') return calendars.events(gc, ctx, q);
      if (n === 1 && m === 'POST') return events.create(gc, ctx, b);
      if (n === 2 && s1 === 'upcoming' && m === 'GET') return calendars.upcoming(gc, ctx, q);
      if (n === 2 && m === 'GET') return calendars.get(gc, ctx, id(s1), q);
      if (n === 2 && m === 'PATCH') return events.update(gc, ctx, id(s1), b);
      if (n === 2 && m === 'DELETE') return events.remove(gc, ctx, id(s1), q);
      if (n === 3 && s2 === 'respond' && m === 'POST') return events.respond(gc, ctx, id(s1), b);
      break;
    case 'invitations':
      if (n === 1 && m === 'GET') return invites.list(gc, ctx, q);
      if (n === 2 && m === 'GET') return invites.get(gc, ctx, id(s1));
      if (n === 3 && s2 === 'respond' && m === 'POST') return invites.respond(gc, ctx, id(s1), b);
      if (n === 3 && s2 === 'apply' && m === 'POST') return invites.apply(gc, ctx, id(s1));
      if (n === 3 && s2 === 'dismiss' && m === 'POST') return invites.dismiss(gc, ctx, id(s1), b);
      break;
    // ─── contacts (1.2.0) ──────────────
    case 'addressbooks':
      if (n === 1 && m === 'GET') return cards.addressbooks(gc, ctx);
      if (n === 2 && m === 'PATCH') return cards.patchBook(gc, ctx, id(s1), b);
      break;
    case 'cards':
      if (n === 1 && m === 'GET') return cards.list(gc, ctx, q);
      if (n === 1 && m === 'POST') return cards.create(gc, ctx, b);
      if (n === 2 && s1 === 'settings' && m === 'PUT') return cards.settings(gc, ctx, b);
      if (n === 2 && s1 === 'lookup' && m === 'GET') return cards.lookup(gc, ctx, q);
      if (n === 2 && s1 === 'draft' && m === 'GET') return cards.draft(gc, ctx, q);
      if (n === 2 && s1 === 'duplicates' && m === 'GET') return cards.duplicates(gc, ctx, q);
      if (n === 3 && s1 === 'duplicates' && s2 === 'ignore' && m === 'POST') return cards.ignore(gc, ctx, b);
      if (n === 2 && s1 === 'merge' && m === 'POST') return cards.merge(gc, ctx, b);
      // 1.4.0: the GC contact as the master — preview, automatic merges and their protocol, undo, conflicts, favourites
      if (n === 3 && s1 === 'merge' && s2 === 'preview' && m === 'POST') return cardmerge.preview(gc, ctx, b);
      if (n === 3 && s1 === 'merge' && s2 === 'auto' && m === 'POST') return cardmerge.autoNow(gc, ctx);
      if (n === 2 && s1 === 'merges' && m === 'GET') return cardmerge.merges(gc, ctx, q);
      if (n === 4 && s1 === 'merges' && s3 === 'undo' && m === 'POST') return cardmerge.undo(gc, ctx, id(s2), b);
      if (n === 2 && s1 === 'conflicts' && m === 'GET') return cardmerge.conflicts(gc, ctx);
      if (n === 2 && s1 === 'favorites' && m === 'GET') return cardmerge.favorites(gc, ctx);
      if (n === 2 && s1 === 'favorites' && m === 'PUT') return cardmerge.putFavorites(gc, ctx, b);
      if (n === 3 && s2 === 'unmerge' && m === 'POST') return cardmerge.unmerge(gc, ctx, id(s1), b);
      if (n === 5 && s2 === 'conflicts' && s4 === 'accept' && m === 'POST') return cardmerge.accept(gc, ctx, id(s1), id(s3), b);
      if (n === 5 && s2 === 'conflicts' && s4 === 'dismiss' && m === 'POST') return cardmerge.dismiss(gc, ctx, id(s1), id(s3));
      if (n === 2 && s1 === 'import' && m === 'POST') return cards.importVcf(gc, ctx, b);
      if (n === 2 && s1 === 'export' && m === 'GET') return cards.exportVcf(gc, ctx, q);
      if (n === 2 && m === 'GET') return cards.get(gc, ctx, id(s1));
      if (n === 2 && m === 'PATCH') return cards.patch(gc, ctx, id(s1), b);
      if (n === 2 && m === 'DELETE') return cards.remove(gc, ctx, id(s1), q);
      if (n === 3 && s2 === 'photo' && m === 'GET') return cards.photo(gc, ctx, id(s1));
      if (n === 3 && s2 === 'photo' && m === 'PUT') return cards.putPhoto(gc, ctx, id(s1), b);
      if (n === 3 && s2 === 'photo' && m === 'DELETE') return cards.deletePhoto(gc, ctx, id(s1));
      if (n === 3 && s2 === 'activity' && m === 'GET') return cards.activity(gc, ctx, id(s1));
      break;
    case 'groups':
      if (n === 1 && m === 'POST') return cards.createGroup(gc, ctx, b);
      if (n === 2 && m === 'GET') return cards.getGroup(gc, ctx, id(s1));
      if (n === 2 && m === 'PATCH') return cards.patchGroup(gc, ctx, id(s1), b);
      if (n === 2 && m === 'DELETE') return cards.removeGroup(gc, ctx, id(s1));
      if (n === 3 && s2 === 'members' && m === 'POST') return cards.groupMembers(gc, ctx, id(s1), b);
      break;
    case 'drive':
      // the pickers of the portal (the apps use Drive's own API)
      if (n === 2 && s1 === 'areas' && m === 'GET') return drive.areas(gc, ctx.userId);
      if (n === 2 && s1 === 'browse' && m === 'GET') return drive.browse(gc, ctx.userId, q);
      break;
    case 'filing':
      if (n === 1 && m === 'GET') return drive.filing(gc, ctx.userId);
      if (n === 3 && s2 === 'confirm' && m === 'POST') return drive.confirm(gc, ctx.userId, ctx.lang, s1, b);
      if (n === 3 && s2 === 'dismiss' && m === 'POST') return drive.dismiss(gc, ctx.userId, s1);
      break;
    default: break;
  }
  throw fail('not_found');
}

module.exports = { route, me, features, prefs, accountOut };
