'use strict';

// The family API for the app and the portal (and any member through the
// plugin API). Paths relative to the plugin's /api/:
//
//   GET  me · overview
//   GET  shopping[?since=]       POST shopping/ops            POST shopping/lists/<id>/going
//   GET  tasks   POST tasks      GET|PATCH|DELETE tasks/<id>  POST tasks/<id>/done · /snooze
//   GET  dates?from=&to=         POST dates                   PATCH|DELETE dates/<id>
//   POST locate/<childUserId>    GET locate/requests[?childId=&limit=]   GET locate/requests/<id>
//   POST locate/requests/<id>/answer · /decline · /fail
//   POST arrival                 POST sos   POST sos/<id>/ack   GET sos[?limit=]   GET sos/<id>
//   GET  places  POST places     PATCH|DELETE places/<id>     POST places/<id>/consent · /triggered
//
// Every response is { ok: true, … } or { ok: false, code, error }. Callers
// that are no member get 403 not_member, a switched-off module 403
// module_off. App callers (req.user.app) and portal viewers after a real
// login may change things; a portal viewer recognised only by device trust
// (loggedIn false) may read the everyday parts — never positions, SOS or
// place reminders — and change nothing (403 login_required).

const store = require('./store');
const tz = require('./tz');
const push = require('./push');
const members = require('./members');
const shopping = require('./shopping');
const tasks = require('./tasks');
const dates = require('./dates');
const locate = require('./locate');
const safety = require('./safety');
const places = require('./places');
const { fail, posInt, iso } = require('./util');

/** GET me */
function me(r) {
  return {
    me: members.meView(r.me),
    modules: { ...r.cfg.modules },
    members: r.fam.list.map((m) => members.memberView(r.me, m, r.cfg)),
    serverTime: iso(r.now),
  };
}

/** GET overview: the cards of the family start screen; a module that is off is null. */
async function overview(gc, r) {
  const mod = r.cfg.modules;
  const out = { shopping: null, tasks: null, stars: null, dates: null, locate: null };
  if (mod.shopping) out.shopping = { lists: await shopping.summary(gc), going: await shopping.goingNow(gc, r.now) };
  if (mod.tasks) out.tasks = await tasks.mine(gc, r);
  if (mod.tasks && mod.stars && r.me.role === 'child') {
    const s = await tasks.starsOf(gc, r.fam, r.cfg, r.today);
    out.stars = { week: s.week[r.me.userId] || 0, goal: s.goal[r.me.userId] || r.me.starGoal };
  }
  if (mod.dates) out.dates = { next: await dates.next(gc, r) };
  if (mod.locate && !(r.user.portal === true && r.user.loggedIn !== true)) out.locate = { last: await locate.last(gc, r) };
  // addition: the latest "Bin angekommen" per member (24 h)
  out.arrivals = mod.arrival_sos ? await safety.recentArrivals(gc, r.now) : null;
  out.serverTime = iso(r.now);
  return out;
}

const parentsOnly = (r) => { if (r.me.role !== 'parent') throw fail('parents_only'); };

/**
 * Resolve the handler for a request → { handler: async () => result, write } or throws not_found.
 */
function dispatch(gc, r, seg, method) {
  const [a, b, c, d] = seg;
  const n = seg.length;
  const mod = r.cfg.modules;
  const need = (m) => { if (!mod[m]) throw fail('module_off'); };
  const sensitive = () => { if (r.trustOnly) throw fail('login_required'); };
  const GET = method === 'GET';
  const POST = method === 'POST';
  const PATCH = method === 'PATCH' || method === 'PUT';
  const DELETE = method === 'DELETE';

  if (a === 'me' && n === 1 && GET) return () => me(r);
  if (a === 'overview' && n === 1 && GET) return () => overview(gc, r);

  if (a === 'shopping') {
    need('shopping');
    if (n === 1 && GET) return () => shopping.get(gc, r.query, r.now);
    if (n === 2 && b === 'ops' && POST) return () => shopping.applyOps(gc, r.body, { id: r.me.userId }, r.now);
    if (n === 4 && b === 'lists' && d === 'going' && POST) return () => shopping.going(gc, r, c);
  }

  if (a === 'tasks') {
    need('tasks');
    if (n === 1 && GET) return () => tasks.get(gc, r);
    if (n === 1 && POST) { parentsOnly(r); return async () => ({ task: await tasks.create(gc, r) }); }
    const id = posInt(b);
    if (n >= 2 && !id) throw fail('not_found');
    if (n === 2 && GET) return async () => ({ task: await tasks.one(gc, r, id) });
    if (n === 2 && PATCH) { parentsOnly(r); return async () => ({ task: await tasks.update(gc, r, id) }); }
    if (n === 2 && DELETE) { parentsOnly(r); return async () => { await tasks.remove(gc, id); return {}; }; }
    if (n === 3 && c === 'done' && POST) return () => tasks.done(gc, r, id);
    if (n === 3 && c === 'snooze' && POST) return () => tasks.snooze(gc, r, id);
  }

  if (a === 'dates') {
    need('dates');
    if (n === 1 && GET) return () => dates.get(gc, r);
    if (n === 1 && POST) return async () => ({ event: await dates.create(gc, r) });
    if (n === 2 && PATCH) return async () => ({ event: await dates.update(gc, r, b) });
    if (n === 2 && DELETE) return async () => { await dates.remove(gc, b); return {}; };
  }

  if (a === 'locate') {
    need('locate');
    sensitive();
    if (b === 'requests') {
      if (n === 2 && GET) return () => locate.list(gc, r);
      if (n === 3 && GET) return () => locate.one(gc, r, c);
      if (n === 4 && POST && d === 'answer') return () => locate.answer(gc, r, c);
      if (n === 4 && POST && d === 'decline') return () => locate.decline(gc, r, c);
      if (n === 4 && POST && d === 'fail') return () => locate.failRequest(gc, r, c);
    } else if (n === 2 && POST) return () => locate.request(gc, r, b);
  }

  if (a === 'arrival' && n === 1 && POST) { need('arrival_sos'); return () => safety.arrival(gc, r); }

  if (a === 'sos') {
    need('arrival_sos');
    sensitive();
    if (n === 1 && POST) return () => safety.sos(gc, r);
    if (n === 1 && GET) return () => safety.list(gc, r);
    if (n === 2 && GET) return () => safety.one(gc, r, b);
    if (n === 3 && c === 'ack' && POST) return () => safety.ack(gc, r, b);
  }

  if (a === 'places') {
    need('places');
    sensitive();
    if (n === 1 && GET) return () => places.list(gc, r);
    if (n === 1 && POST) return () => places.create(gc, r);
    if (n === 2 && PATCH) return () => places.update(gc, r, b);
    if (n === 2 && DELETE) return () => places.remove(gc, r, b);
    if (n === 3 && c === 'consent' && POST) return () => places.consent(gc, r, b);
    if (n === 3 && c === 'triggered' && POST) return () => places.triggered(gc, r, b);
  }
  throw fail('not_found');
}

/** The API for members (app, portal, plugin API). */
async function route(req, gc, seg, cfg, now) {
  const user = req.user;
  if (!user || !Number.isSafeInteger(user.id)) throw fail('forbidden');
  const today = tz.localDate(now, cfg.tz);
  const fam = await members.load(gc, today);
  const m = fam.byId.get(user.id);
  if (!m) throw fail('not_member');
  const method = String(req.method || 'GET').toUpperCase();
  const write = method !== 'GET';
  const trustOnly = user.portal === true && user.loggedIn !== true;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const r = { req, cfg, now, today, fam, me: m, user, body, query: req.query || {}, trustOnly, pushes: [] };
  const handler = dispatch(gc, r, seg, method);
  if (write && trustOnly) throw fail('login_required');
  const out = write ? await store.tx(gc, handler) : await handler();
  if (r.pushes.length) await push.flush(gc, r.pushes);
  return { status: 200, json: { ok: true, ...out } };
}

module.exports = { route, me, overview };
