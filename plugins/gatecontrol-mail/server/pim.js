'use strict';

// The calendar and contact side of the accounts (C5.5): a line of its own per account ("pim", beside the mail line of
// engine.js, the same run pattern: `prio` before `queue`, one step at a time) — CalDAV/CardDAV need no IMAP session and
// never wait behind IMAP steps. Mail goes first: the background run (index.js tick) syncs the posteingänge first, then
// at most ONE calendar or contact step per account and run, within what is left of the run's budget; calendars before
// contacts. Graph: background steps only while the person's own Graph work (engine.js `direct`) uses fewer than 2 of
// the 4 requests Graph allows per mailbox; a 429 / 503 pauses mail and calendar of the account alike.
//
//   what                                   background     while the person has the area open ("active", 10 min)
//   Graph default calendar (delta)         5 min          1 min
//   Graph other calendars                  15 min         5 min
//   CalDAV calendars (ctag / sync-token)   15 min         2 min
//   iCal subscriptions                     30 min         30 min
//   contacts (Graph delta, CardDAV)        60 min         5 min
//   calendar / address book lists          6 h            when opened, at most every 5 min
//
// What a person does (save an event, answer, change a contact) goes into `prio` of the line (CalDAV) or beside it in
// the account's direct pool (Graph) and never waits behind a background step; the API answers once the provider took it.

const store = require('./store');
const config = require('./config');
const providers = require('./providers');
const engine = require('./engine');
const ms = require('./microsoft');
const dav = require('./dav');
const pimstore = require('./pimstore');
const pimgraph = require('./pimgraph');
const pimdav = require('./pimdav');
const cardstore = require('./cardstore');
const { fail } = require('./util');

const MIN = 60000;
const ACTIVE_MS = 10 * MIN;
const EVERY = {
  graphDefault: [5 * MIN, MIN], graphOther: [15 * MIN, 5 * MIN], caldav: [15 * MIN, 2 * MIN], ics: [30 * MIN, 30 * MIN], contacts: [60 * MIN, 5 * MIN],
  lists: [6 * 60 * MIN, 5 * MIN],
};
const MASS_MIN = 200;
const DIRECT_MAX = 3;      // engine.js DIRECT_PER_ACCOUNT
const BACKGROUND_DIRECT = 2;

const lines = new Map();   // account id → { prio, queue, busy, last: {}, retryAt, pause }
const active = new Map();  // user id → { calendar: ms, contacts: ms } of the last GET events / GET cards

function lineOf(id) {
  let x = lines.get(id);
  if (!x) { x = { prio: [], queue: [], busy: false, last: {}, retryAt: 0, pause: 0 }; lines.set(id, x); }
  return x;
}

/** fn() in the pim line of account `a`: `prio` (a person waits) before the waiting background steps. */
function run(a, fn, o = {}) {
  const x = lineOf(a.id);
  return new Promise((resolve, reject) => {
    (o.prio ? x.prio : x.queue).push({ fn, resolve, reject });
    pump(x);
  });
}

async function pump(x) {
  if (x.busy) return;
  x.busy = true;
  let job;
  while ((job = x.prio.shift() || x.queue.shift())) {
    try { job.resolve(await job.fn(x)); } catch (e) { job.reject(e); }
  }
  x.busy = false;
}

/** Graph work of a person: a turn of the account's direct pool (shared with the mail of engine.js). */
async function direct(gc, a, fn) {
  const x = engine.stateOf(a.id);
  if (x.direct >= DIRECT_MAX) await new Promise((r) => x.directWait.push(r)); else x.direct++;
  try { return await fn(); } finally {
    const next = x.directWait.shift();
    if (next) next(); else x.direct--;
  }
}

/** A person's change through the provider of account `a` (Graph: the direct pool; CalDAV: first in the pim line). */
function forPerson(gc, a, fn) {
  if (engine.isGraph(a)) return direct(gc, a, fn);
  return run(a, fn, { prio: true });
}

/** The person opened the calendar / contacts (GET events, GET cards): shorter intervals for 10 minutes. */
function touch(userId, what) {
  const t = active.get(userId) || {};
  t[what] = Date.now();
  active.set(userId, t);
}

const isActive = (userId, what, now) => { const t = active.get(userId); return !!(t && t[what] && now - t[what] < ACTIVE_MS); };
const every = (k, act) => EVERY[k][act ? 1 : 0];

// ─── the account side: states ───────────────────

async function pimState(gc, accountId, what) {
  return store.one(gc, 'SELECT * FROM pim_state WHERE account_id = ? AND what = ?', [accountId, what]);
}

async function setPim(gc, a, what, state, code, extra = {}) {
  const now = Date.now();
  await store.run(gc, `INSERT INTO pim_state (account_id, what, state, error_code, error_at, server, home, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, what) DO UPDATE SET state = excluded.state, error_code = excluded.error_code, error_at = excluded.error_at,
    server = COALESCE(excluded.server, server), home = COALESCE(excluded.home, home), checked_at = excluded.checked_at`,
  [a.id, what, state, code || null, code ? now : null, extra.server || null, extra.home || null, now]);
}

/** The kind of calendar / contacts an account has: 'graph' | 'dav' | 'ics' (Gmail: iCal only) | 'none'. */
function sourceOf(a, what) {
  if (providers.isMicrosoft(a.provider)) return 'graph';
  if (a.provider === 'gmail') return what === 'calendar' ? 'ics' : 'none';
  if (a.provider === 'tonline' && !(what === 'calendar' ? a.caldav_url : a.carddav_url)) return 'none';
  return 'dav';
}

/** The state of rows (calendars / address books) together: the worst one wins. */
function worst(rows) {
  const order = ['auth_failed', 'consent_required', 'unreachable', 'syncing', 'ok'];
  let s = null;
  for (const r of rows) if (s == null || order.indexOf(r.state) < order.indexOf(s)) s = r.state;
  return s;
}

/**
 * Account.calendar / Account.contacts / Account.missingScopes of account row `a` (C2):
 * { sync, state: ok|syncing|auth_failed|unreachable|consent_required|none|off, readOnly, server }.
 */
async function accountView(gc, cfg, a) {
  const missing = providers.isMicrosoft(a.provider) ? ms.missingScopes(a, cfg) : [];
  const side = async (what) => {
    const on = what === 'calendar' ? cfg.calendar.enabled && cfg.calendar.accounts : cfg.contacts.enabled && cfg.contacts.accounts;
    const sync = (what === 'calendar' ? a.calendar_sync : a.contacts_sync) !== 0;
    const src = sourceOf(a, what);
    const ps = await pimState(gc, a.id, what);
    const table = what === 'calendar' ? 'calendars' : 'addressbooks';
    const rows = await store.all(gc, `SELECT state FROM ${table} WHERE account_id = ?`, [a.id]);
    let state;
    if (!on || !sync) state = 'off';
    else if (src === 'none') state = 'none';
    else if (src === 'graph' && missing.includes(what === 'calendar' ? config.MS_CALENDAR_SCOPE : config.MS_CONTACTS_SCOPE)) state = 'consent_required';
    else if (src === 'ics' && !rows.length) state = 'none';
    else if (ps && ['none', 'auth_failed', 'unreachable', 'consent_required'].includes(ps.state) && (!rows.length || ps.state === 'auth_failed')) state = ps.state;
    else state = worst(rows) || (src === 'dav' && !dav.can(gc) ? 'none' : 'syncing');
    let server = ps && ps.server ? ps.server : null;
    if (src === 'graph') server = 'graph.microsoft.com';
    if (src === 'ics') server = null;
    return { sync, state, readOnly: src === 'ics', server };
  };
  return { calendar: await side('calendar'), contacts: await side('contacts'), missingScopes: missing };
}

// ─── the steps ──────────────────────────────────

/** Mass delete guard: more than 50 % and more than MASS_MIN of a collection gone → held once (state unreachable / mass_delete). */
function guardOf(gc, table) {
  return async (col, gone, total) => {
    if (gone <= MASS_MIN || gone * 2 <= total) return true;
    const cur = await store.one(gc, `SELECT error_code FROM ${table} WHERE id = ?`, [col.id]);
    if (cur && cur.error_code === 'mass_delete') return true; // confirmed by a second sync
    await store.run(gc, `UPDATE ${table} SET state = 'unreachable', error_code = 'mass_delete', error_at = ? WHERE id = ?`, [Date.now(), col.id]);
    return false;
  };
}

/** A failure of a step → the states of the rows (and the account side), the API code thrown on. */
async function stepError(gc, a, what, rows, e) {
  const code = e && e.code;
  const table = what === 'calendar' ? 'calendars' : 'addressbooks';
  let state = 'unreachable';
  let err = (e && e.extra && e.extra.reason) || code || 'error';
  if (code === 'auth_failed') { state = 'auth_failed'; err = 'auth'; }
  if (code === 'consent_required') { state = 'consent_required'; err = 'consent'; }
  if (code === 'dav_unavailable') { state = 'unreachable'; err = (e.extra && e.extra.reason) || 'not_found'; }
  if (code === 'busy') return;
  for (const r of rows) await store.run(gc, `UPDATE ${table} SET state = ?, error_code = ?, error_at = ? WHERE id = ?`, [state, String(err).slice(0, 40), Date.now(), r.id]);
  await setPim(gc, a, what, state, String(err).slice(0, 40));
}

const userTzCtx = async (gc, userId) => ({ userTz: await pimstore.zoneOf(gc, userId), own: await pimstore.ownAddresses(gc, userId) });

/** The calendar list (and discovery) of account `a` → rows. */
async function calendarList(gc, a) {
  const x = lineOf(a.id);
  x.last.calList = Date.now();
  const src = sourceOf(a, 'calendar');
  if (src === 'graph') {
    const rows = await pimgraph.syncCalendars(gc, a);
    if (rows === 'consent') { await setPim(gc, a, 'calendar', 'consent_required', 'consent'); return []; }
    await setPim(gc, a, 'calendar', 'ok', null, { server: 'graph.microsoft.com' });
    await pimstore.live(gc, a.user_id, 'calendar', { kind: 'calendars' });
    return rows;
  }
  if (src !== 'dav') return [];
  if (!dav.can(gc)) { await setPim(gc, a, 'calendar', 'none', 'host_old'); return []; }
  try {
    const found = await pimdav.discover(gc, a, 'caldav');
    const rows = await pimdav.syncCalendarList(gc, a, found);
    await setPim(gc, a, 'calendar', 'ok', null, { server: found.server, home: found.home });
    await pimstore.live(gc, a.user_id, 'calendar', { kind: 'calendars' });
    return rows;
  } catch (e) {
    if (e && e.code === 'dav_unavailable' && ['not_found', 'no_calendar'].includes(e.extra && e.extra.reason) && !a.caldav_url) {
      await setPim(gc, a, 'calendar', 'none', e.extra.reason);
      return [];
    }
    await stepError(gc, a, 'calendar', await store.all(gc, 'SELECT id FROM calendars WHERE account_id = ?', [a.id]), e);
    throw e;
  }
}

async function bookList(gc, a) {
  const x = lineOf(a.id);
  x.last.bookList = Date.now();
  const src = sourceOf(a, 'contacts');
  if (src === 'graph') {
    const rows = await pimgraph.syncBooks(gc, a);
    if (rows === 'consent') { await setPim(gc, a, 'contacts', 'consent_required', 'consent'); return []; }
    await setPim(gc, a, 'contacts', 'ok', null, { server: 'graph.microsoft.com' });
    await pimstore.live(gc, a.user_id, 'contacts', { kind: 'addressbooks' });
    return rows;
  }
  if (src !== 'dav') return [];
  if (!dav.can(gc)) { await setPim(gc, a, 'contacts', 'none', 'host_old'); return []; }
  try {
    const found = await pimdav.discover(gc, a, 'carddav');
    const rows = await pimdav.syncBookList(gc, a, found);
    await setPim(gc, a, 'contacts', 'ok', null, { server: found.server, home: found.home });
    await pimstore.live(gc, a.user_id, 'contacts', { kind: 'addressbooks' });
    return rows;
  } catch (e) {
    if (e && e.code === 'dav_unavailable' && !a.carddav_url) { await setPim(gc, a, 'contacts', 'none', (e.extra && e.extra.reason) || 'not_found'); return []; }
    await stepError(gc, a, 'contacts', await store.all(gc, 'SELECT id FROM addressbooks WHERE account_id = ?', [a.id]), e);
    throw e;
  }
}

/** One calendar step (a Graph delta page, a Graph calendar view, a CalDAV collection) → did anything change. */
async function calendarStep(gc, a, cal) {
  const ctx = await userTzCtx(gc, a.user_id);
  const x = lineOf(a.id);
  x.last[`cal:${cal.id}`] = Date.now();
  try {
    let r;
    if (cal.source === 'graph') {
      r = cal.is_default ? await pimgraph.deltaStep(gc, a, cal, ctx) : await pimgraph.viewRound(gc, a, cal, ctx, guardOf(gc, 'calendars'));
      if (r.consent) { await stepError(gc, a, 'calendar', [cal], fail('consent_required')); return false; }
      if (r.more) x.last[`cal:${cal.id}`] = 0; // the round goes on in the next run
      if (r.changed) await pimstore.touchCalendar(gc, cal, null, { throttle: !!r.more });
      return !!r.changed;
    }
    if (cal.source === 'caldav') {
      r = await pimdav.syncCollection(gc, a, cal, 'caldav', guardOf(gc, 'calendars'));
      if (r.changed.length || r.removed) await pimstore.touchCalendar(gc, cal);
      return !!(r.changed.length || r.removed);
    }
    return false;
  } catch (e) {
    await stepError(gc, a, 'calendar', [cal], e);
    throw e;
  }
}

/** After a contact sync step: the GC contacts of the changed cards up to date, new certain duplicates merged (1.4.0). */
async function mergeAfter(gc, userId, changed) {
  if (!changed || !changed.length) return;
  try { await require('./cardmerge').afterSync(gc, userId, changed); } catch (e) { gc.log.warn('contacts merge after sync failed', (e && e.code) || 'error'); }
}

async function bookStep(gc, a, book) {
  const x = lineOf(a.id);
  x.last[`book:${book.id}`] = Date.now();
  try {
    if (book.source === 'graph') {
      const put = async (gx, f) => {
        const have = await store.one(gc, 'SELECT * FROM cards WHERE addressbook_id = ? AND remote_id = ?', [book.id, gx.id]);
        let photo;
        if (!have || have.change_key !== gx.changeKey) { try { photo = await pimgraph.contactPhoto(gc, a, gx.id); } catch { photo = undefined; } }
        const c = await cardstore.storeCard(gc, book, { uid: have ? have.uid : `graph:${gx.id}`, fields: f, vcard: null, remoteId: gx.id, changeKey: gx.changeKey || null, photo, id: have ? have.id : undefined });
        return c.id;
      };
      const drop = async (rid) => { const c = await store.one(gc, 'SELECT * FROM cards WHERE addressbook_id = ? AND remote_id = ?', [book.id, rid]); if (c) { await cardstore.dropCard(gc, c); return true; } return false; };
      const r = await pimgraph.contactsStep(gc, a, book, put, drop);
      if (r.consent) { await stepError(gc, a, 'contacts', [book], fail('consent_required')); return false; }
      if (r.more) x.last[`book:${book.id}`] = 0;
      if ((r.changed || []).length || r.removed) await pimstore.live(gc, a.user_id, 'contacts', { kind: 'changed', addressbookId: book.id, ...(r.changed.length <= 50 ? { contactIds: r.changed } : {}) });
      await mergeAfter(gc, a.user_id, r.changed);
      return true;
    }
    if (book.source === 'carddav') {
      const r = await pimdav.syncCollection(gc, a, book, 'carddav', guardOf(gc, 'addressbooks'));
      if (r.changed.length || r.removed) await pimstore.live(gc, a.user_id, 'contacts', { kind: 'changed', addressbookId: book.id, ...(r.changed.length <= 50 ? { contactIds: r.changed } : {}) });
      await mergeAfter(gc, a.user_id, r.changed);
      return true;
    }
    return false;
  } catch (e) {
    await stepError(gc, a, 'contacts', [book], e);
    throw e;
  }
}

/** The step that is due most for account `a` (calendars before contacts) → a function, or null. */
async function dueStep(gc, cfg, a, now) {
  const x = lineOf(a.id);
  const graph = engine.isGraph(a);
  const missing = graph ? ms.missingScopes(a, cfg) : [];
  if (cfg.calendar.enabled && cfg.calendar.accounts && a.calendar_sync !== 0 && sourceOf(a, 'calendar') !== 'none' && !missing.includes(config.MS_CALENDAR_SCOPE)) {
    const act = isActive(a.user_id, 'calendar', now);
    if (sourceOf(a, 'calendar') !== 'ics') {
      if (now - (x.last.calList || 0) >= every('lists', false) || (x.last.openAsk && now - (x.last.calList || 0) >= every('lists', true))) {
        x.last.openAsk = false;
        return () => calendarList(gc, a);
      }
      const cals = await store.all(gc, 'SELECT * FROM calendars WHERE account_id = ? AND source IN (\'graph\', \'caldav\') ORDER BY COALESCE(synced_at, 0)', [a.id]);
      for (const c of cals) {
        const k = c.source === 'graph' ? (c.is_default ? 'graphDefault' : 'graphOther') : 'caldav';
        if (c.error_code === 'consent') continue;
        if (now - (x.last[`cal:${c.id}`] || 0) >= every(k, act)) return () => calendarStep(gc, a, c);
      }
    }
  } else if (graph && missing.includes(config.MS_CALENDAR_SCOPE)) {
    await markConsent(gc, a, 'calendar');
  }
  if (cfg.contacts.enabled && cfg.contacts.accounts && a.contacts_sync !== 0 && sourceOf(a, 'contacts') !== 'none' && !missing.includes(config.MS_CONTACTS_SCOPE)) {
    const act = isActive(a.user_id, 'contacts', now);
    if (now - (x.last.bookList || 0) >= every('lists', false) || (x.last.openBooks && now - (x.last.bookList || 0) >= every('lists', true))) {
      x.last.openBooks = false;
      return () => bookList(gc, a);
    }
    const books = await store.all(gc, "SELECT * FROM addressbooks WHERE account_id = ? AND source IN ('graph', 'carddav') ORDER BY COALESCE(synced_at, 0)", [a.id]);
    for (const b of books) if (b.error_code !== 'consent' && now - (x.last[`book:${b.id}`] || 0) >= every('contacts', act)) return () => bookStep(gc, a, b);
  } else if (graph && missing.includes(config.MS_CONTACTS_SCOPE)) {
    await markConsent(gc, a, 'contacts');
  }
  return null;
}

/** A Microsoft account without the scope: its rows show consent_required (the mail runs on). */
async function markConsent(gc, a, what) {
  const table = what === 'calendar' ? 'calendars' : 'addressbooks';
  await store.run(gc, `UPDATE ${table} SET state = 'consent_required', error_code = 'consent' WHERE account_id = ? AND state <> 'consent_required'`, [a.id]);
  const ps = await pimState(gc, a.id, what);
  if (!ps || ps.state !== 'consent_required') await setPim(gc, a, what, 'consent_required', 'consent');
}

/**
 * The background run's calendar and contact part (after the mail, within `budgetMs` of the run that started at
 * `started`): one step per account; then the iCal subscriptions due.
 */
async function tick(gc, now, started, budgetMs, skipUsers = new Set()) {
  const cfg = await config.get(gc);
  if (!cfg.calendar.enabled && !cfg.contacts.enabled) return 0;
  const accounts = await store.all(gc, "SELECT * FROM accounts WHERE state <> 'auth_failed' ORDER BY id");
  let steps = 0;
  for (const a of accounts) {
    if (Date.now() - started > budgetMs) break;
    if (skipUsers.has(a.user_id)) continue;
    const x = lineOf(a.id);
    const ex = engine.stateOf(a.id);
    if (x.retryAt > now || ex.retryAt > now) continue;
    if (engine.isGraph(a) && ex.direct >= BACKGROUND_DIRECT) continue;
    let step;
    try { step = await dueStep(gc, cfg, a, now); } catch { step = null; }
    if (!step) continue;
    try {
      await run(a, step);
      x.pause = 0;
      steps++;
    } catch (e) {
      if (e && e.code === 'busy') {
        // Graph / the server asks for a pause: mail and calendar of the account wait
        const until = Date.now() + ((e.extra && e.extra.retryAfter) || 30) * 1000;
        x.retryAt = until;
        ex.retryAt = Math.max(ex.retryAt || 0, until);
      } else {
        x.pause = Math.min(x.pause ? x.pause * 2 : 60000, 30 * MIN);
        x.retryAt = Date.now() + x.pause;
        if (e && !['auth_failed', 'unreachable', 'dav_unavailable', 'consent_required'].includes(e.code)) gc.log.warn('pim step failed', a.id, (e && e.code) || 'error');
      }
    }
  }
  // the iCal subscriptions (Gmail and any https address), a few per run
  if (cfg.calendar.enabled && Date.now() - started <= budgetMs) {
    const subs = await store.all(gc, "SELECT * FROM calendars WHERE source = 'ics' AND (synced_at IS NULL OR synced_at < ?) ORDER BY COALESCE(synced_at, 0) LIMIT 3", [now - every('ics', false)]);
    for (const c of subs) {
      if (Date.now() - started > budgetMs || skipUsers.has(c.user_id)) continue;
      if (c.account_id) { const a = await store.one(gc, 'SELECT calendar_sync FROM accounts WHERE id = ?', [c.account_id]); if (a && a.calendar_sync === 0) continue; }
      try {
        const r = await pimdav.syncIcs(gc, c, guardOf(gc, 'calendars'), now);
        if (r && (r.changed || r.removed)) await pimstore.touchCalendar(gc, c);
        steps++;
      } catch { /* the backoff of syncIcs */ }
    }
  }
  return steps;
}

/** The calendars were opened (GET calendars): the lists again when older than 5 minutes (in the background). */
function opened(gc, userId, what) {
  touch(userId, what);
  store.all(gc, 'SELECT * FROM accounts WHERE user_id = ?', [userId]).then((list) => {
    for (const a of list) {
      const x = lineOf(a.id);
      if (what === 'calendar') x.last.openAsk = true; else x.last.openBooks = true;
      const last = what === 'calendar' ? x.last.calList : x.last.bookList;
      if (last && Date.now() - last >= every('lists', true)) { if (what === 'calendar') x.last.calList = 0; else x.last.bookList = 0; }
    }
  }).catch(() => {});
}

/** A sync of account `a` now (after a new account, a sign-in anew, PATCH with new addresses) — the next run does it. */
function soon(accountId) {
  const x = lineOf(accountId);
  x.last = {};
  x.retryAt = 0;
  x.pause = 0;
}

/** The account was removed: its calendars, address books, events, contacts and invitations go (the provider keeps all). */
async function dropAccount(gc, a) {
  for (const c of await store.all(gc, 'SELECT * FROM calendars WHERE account_id = ?', [a.id])) await pimstore.dropCalendar(gc, c);
  for (const b of await store.all(gc, 'SELECT * FROM addressbooks WHERE account_id = ?', [a.id])) await cardstore.dropBook(gc, b);
  await store.run(gc, 'DELETE FROM invitations WHERE account_id = ?', [a.id]);
  await store.run(gc, 'DELETE FROM pim_state WHERE account_id = ?', [a.id]);
  lines.delete(a.id);
  await pimstore.live(gc, a.user_id, 'calendar', { kind: 'calendars' });
  await pimstore.live(gc, a.user_id, 'contacts', { kind: 'addressbooks' });
}

function reset() { lines.clear(); active.clear(); }

module.exports = {
  run, direct, forPerson, touch, isActive, accountView, sourceOf, setPim, pimState, calendarList, bookList, calendarStep, bookStep, tick, opened, soon, dropAccount,
  guardOf, reset, lineOf, EVERY,
};
