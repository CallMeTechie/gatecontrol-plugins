'use strict';

// The admin API (GateControl's admin UI, administrators only — the page "Einstellungen" of the plugin):
//   GET admin/settings → { settings, usage: { bytes, quotaBytes, people: [{ userId, name, bytes, accounts }] },
//                          microsoft: { clientId, consentUrl, accounts, lastSignIn }, ai: { ready }, version }
//   PUT admin/settings (a part of settings) → the same
//   GET admin/overview → { people, accounts, byState: { ok, syncing, auth_failed, unreachable }, bytes, seats }
//   PUT admin/seats/<userId> { kind: 'family' | 'business' | null } → { seat, seats } — a person's place in the licence
//                       (null: switched off) — since 1.1.0, like Drive (seats.js); GET admin/settings carries `seats` too
//   POST admin/license/refresh → { refreshed, seats } — fetch the licence now (after "Personen hinzubuchen")
// Since 1.2.0 also the numbers of calendars and contacts (calendars, events, contacts and their bytes, in all and per
// person) and the settings `calendar` / `contacts` (config.js); never an event or a contact of anyone.
// Administrators see numbers only — never mail, subjects or addresses of other people.

const store = require('./store');
const config = require('./config');
const mailstore = require('./mailstore');
const ai = require('./ai');
const seats = require('./seats');
const pimstore = require('./pimstore');
const { fail, posInt } = require('./util');

/** Numbers of the calendars and contacts of a person (or of everybody: userId null). */
async function pimCounts(gc, userId) {
  const w = userId == null ? '' : ' WHERE user_id = ?';
  const args = userId == null ? [] : [userId];
  const c = await store.one(gc, `SELECT COUNT(*) AS n FROM calendars${w}`, args);
  const e = await store.one(gc, `SELECT COUNT(*) AS n FROM events${w}`, args);
  const k = await store.one(gc, `SELECT COUNT(*) AS n FROM cards${w}`, args);
  return { calendars: c.n, events: e.n, contacts: k.n };
}

async function usage(gc, cfg) {
  const rows = await store.all(gc, `SELECT u.user_id, (SELECT COUNT(*) FROM accounts a WHERE a.user_id = u.user_id) AS n FROM
    (SELECT user_id FROM accounts UNION SELECT user_id FROM calendars UNION SELECT user_id FROM cards) u`);
  let users = [];
  try { users = await gc.users.list(); } catch { users = []; }
  const names = new Map(users.map((u) => [u.id, u.name]));
  const people = [];
  let bytes = 0;
  for (const r of rows) {
    const mail = await mailstore.usage(gc, r.user_id);
    const pim = await pimstore.usage(gc, r.user_id);
    const b = mail + pim;
    bytes += b;
    people.push({ userId: r.user_id, name: names.get(r.user_id) || String(r.user_id), bytes: b, accounts: r.n, pimBytes: pim, ...(await pimCounts(gc, r.user_id)) });
  }
  people.sort((x, y) => y.bytes - x.bytes);
  return { bytes, quotaBytes: config.quotaBytes(cfg), people };
}

async function settingsView(gc, cfg) {
  const ms = await store.one(gc, "SELECT COUNT(*) AS n, MAX(created_at) AS last FROM accounts WHERE provider IN ('outlook', 'm365')");
  const clientId = config.msClientId(cfg);
  return {
    settings: cfg, usage: await usage(gc, cfg),
    microsoft: { clientId, defaultClientId: config.DEFAULT_MS_CLIENT_ID, consentUrl: config.adminConsentUrl(clientId), accounts: ms.n, lastSignIn: ms.last || null,
      // since 1.2.0: what a sign-in asks for, and what the app registration needs besides the mail (the note of the page)
      scopes: config.msScopes(cfg), registrationNeeds: [config.MS_CALENDAR_SCOPE, config.MS_CONTACTS_SCOPE] },
    ai: { ready: await ai.ready(gc) }, version: gc.plugin.version,
    // since 1.1.0: the licence and its people (seats.js)
    seats: await seats.summary(gc, cfg),
  };
}

async function overview(gc) {
  const st = await store.all(gc, 'SELECT state, COUNT(*) AS n FROM accounts GROUP BY state');
  const byState = { ok: 0, syncing: 0, auth_failed: 0, unreachable: 0 };
  for (const r of st) byState[r.state] = r.n;
  const people = await store.one(gc, 'SELECT COUNT(DISTINCT user_id) AS n FROM accounts');
  const cfg = await config.get(gc);
  const u = await usage(gc, cfg);
  const s = await seats.summary(gc, cfg);
  const pc = await pimCounts(gc, null);
  const pb = u.people.reduce((x, p) => x + (p.pimBytes || 0), 0);
  return { people: people.n, accounts: Object.values(byState).reduce((x, n) => x + n, 0), byState, bytes: u.bytes,
    // since 1.2.0: calendars and contacts in numbers
    pim: { ...pc, bytes: pb },
    seats: { licence: s.licence, limits: s.limits, counts: s.counts, exceeded: s.exceeded } };
}

async function route(gc, req, seg) {
  const m = req.method;
  if (seg[1] === 'settings' && seg.length === 2) {
    if (m === 'GET') return settingsView(gc, await config.get(gc));
    if (m === 'PUT') return settingsView(gc, await config.put(gc, req.body));
  }
  if (seg[1] === 'overview' && seg.length === 2 && m === 'GET') return overview(gc);
  if (seg[1] === 'seats' && seg.length === 3 && m === 'PUT') {
    const uid = posInt(seg[2]);
    if (!uid) throw fail('invalid', { field: 'userId' });
    const cfg = await config.get(gc);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const seat = await seats.set(gc, cfg, uid, body.kind == null ? null : String(body.kind), req.user.id, Date.now());
    gc.log.info(seat ? `seat on (${seat.kind})` : 'seat off', uid);
    return { seat: seat ? { userId: seat.user_id, kind: seat.kind } : null, seats: await seats.summary(gc, cfg) };
  }
  if (seg[1] === 'license' && seg[2] === 'refresh' && seg.length === 3 && m === 'POST') {
    if (!gc.license || typeof gc.license.refresh !== 'function') throw fail('invalid');
    const r = await gc.license.refresh();
    return { refreshed: r.refreshed === true, seats: await seats.summary(gc, await config.get(gc)) };
  }
  throw fail('not_found');
}

module.exports = { route, usage };
