'use strict';

// The admin API (GateControl's admin UI, administrators only — the page "Einstellungen" of the plugin):
//   GET admin/settings → { settings, usage: { bytes, quotaBytes, people: [{ userId, name, bytes, accounts }] },
//                          microsoft: { clientId, consentUrl, accounts, lastSignIn }, ai: { ready }, version }
//   PUT admin/settings (a part of settings) → the same
//   GET admin/overview → { people, accounts, byState: { ok, syncing, auth_failed, unreachable }, bytes, seats }
//   PUT admin/seats/<userId> { kind: 'family' | 'business' | null } → { seat, seats } — a person's place in the licence
//                       (null: switched off) — since 1.1.0, like Drive (seats.js); GET admin/settings carries `seats` too
//   POST admin/license/refresh → { refreshed, seats } — fetch the licence now (after "Personen hinzubuchen")
// Administrators see numbers only — never mail, subjects or addresses of other people.

const store = require('./store');
const config = require('./config');
const mailstore = require('./mailstore');
const ai = require('./ai');
const seats = require('./seats');
const { fail, posInt } = require('./util');

async function usage(gc, cfg) {
  const rows = await store.all(gc, 'SELECT user_id, COUNT(*) AS n FROM accounts GROUP BY user_id');
  let users = [];
  try { users = await gc.users.list(); } catch { users = []; }
  const names = new Map(users.map((u) => [u.id, u.name]));
  const people = [];
  let bytes = 0;
  for (const r of rows) {
    const b = await mailstore.usage(gc, r.user_id);
    bytes += b;
    people.push({ userId: r.user_id, name: names.get(r.user_id) || String(r.user_id), bytes: b, accounts: r.n });
  }
  people.sort((x, y) => y.bytes - x.bytes);
  return { bytes, quotaBytes: config.quotaBytes(cfg), people };
}

async function settingsView(gc, cfg) {
  const ms = await store.one(gc, "SELECT COUNT(*) AS n, MAX(created_at) AS last FROM accounts WHERE provider IN ('outlook', 'm365')");
  const clientId = config.msClientId(cfg);
  return {
    settings: cfg, usage: await usage(gc, cfg),
    microsoft: { clientId, defaultClientId: config.DEFAULT_MS_CLIENT_ID, consentUrl: config.adminConsentUrl(clientId), accounts: ms.n, lastSignIn: ms.last || null },
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
  return { people: people.n, accounts: Object.values(byState).reduce((x, n) => x + n, 0), byState, bytes: u.bytes,
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
