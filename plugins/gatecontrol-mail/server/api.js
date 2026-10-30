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
const { fail } = require('./util');

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
  return out;
}

/** GET me */
async function me(gc, ctx) {
  const cfg = await config.get(gc);
  const list = await accounts.list(gc, ctx.userId);
  return {
    features: await features(gc, cfg, ctx.userId),
    limits: { accountsMax: cfg.accountsMax, quotaBytes: config.quotaBytes(cfg), usedBytes: await mailstore.usage(gc, ctx.userId), retentionMonths: cfg.retentionMonths },
    microsoft: { clientId: config.msClientId(cfg), authority: config.MS_AUTHORITY, scopes: [...config.MS_SCOPES] },
    accounts: list.map(accounts.view), unread: await messages.unread(gc, ctx.userId), settings: await prefs(gc, ctx.userId),
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
  switch (s0) {
    case 'me': if (n === 1 && m === 'GET') return me(gc, ctx); break;
    case 'settings': if (n === 1 && m === 'PUT') return putPrefs(gc, ctx.userId, b); break;
    case 'providers': if (n === 1 && m === 'GET') return providers.list(ctx.lang); break;
    case 'accounts':
      if (n === 1 && m === 'POST') return accounts.add(gc, ctx, b);
      if (n === 2 && s1 === 'discover' && m === 'POST') return providers.discover(gc, b);
      if (n === 2 && s1 === 'microsoft' && m === 'POST') return accounts.addMicrosoft(gc, ctx, b);
      if (n === 3 && s1 === 'microsoft' && s2 === 'device' && m === 'POST') return accounts.deviceStart(gc, ctx, b);
      if (n === 4 && s1 === 'microsoft' && s2 === 'device' && m === 'GET') return accounts.devicePoll(gc, ctx, s3);
      if (n === 2 && m === 'PATCH') return accounts.patch(gc, ctx, id(s1), b);
      if (n === 2 && m === 'DELETE') return accounts.remove(gc, ctx, id(s1));
      if (n === 3 && s2 === 'microsoft' && m === 'POST') return accounts.reMicrosoft(gc, ctx, id(s1), b);
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
      if (n === 4 && s2 === 'todo' && m === 'POST') return ai.todo(gc, ctx.userId, ctx.lang, s1, s3, b);
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

module.exports = { route, me, features, prefs };
