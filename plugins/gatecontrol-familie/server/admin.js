'use strict';

// The admin pages' API (administrators only, never a portal or app caller):
//
//   GET    admin/status                        members, users, modules, settings
//   POST   admin/members                       { userId, role, birthdate, locateMode, starGoal }
//                                              (1.3.0: colour and picture come from the GateControl account —
//                                              avatarUrl, color, colorHex, initials and presence in every member;
//                                              a `color` in the body is ignored)
//   PATCH  admin/members/<userId>              same fields, partial
//   DELETE admin/members/<userId>
//                                              (a role 'wall' member is a kiosk user — server/kiosk.js)
//   PUT    admin/modules                       { shopping: bool, … } (partial)
//   PUT    admin/wall                          { listId } — the wall tablet's shopping list ('' = the first)
//   GET    admin/log?days=&kind=&userId=       locate requests, arrivals, SOS, place transitions
//                                              + the last answered position per child
//   GET    admin/presence                      page "Anwesenheit & Smart Home" (1.2.0): who is home,
//                                              rules (with `available` per quick action), the rule log,
//                                              the administrator's own quick actions, the home location
//   GET    admin/presence/actions              the quick actions of the other plugins for the administrator
//   POST   admin/presence/rules                PATCH|DELETE admin/presence/rules/<id>
//                                              (quick actions of a rule saved here run as the administrator)
//   GET    admin/presence/places               1.5.0: the rule places (also in GET admin/presence: places, home)
//   POST   admin/presence/places               PATCH|DELETE admin/presence/places/<id>   (server/ruleplaces.js)
//   1.6.0 — the Messenger plugin (server/messenger.js; also `messenger` in GET admin/status, GET admin/presence
//                                              and GET presence/rules):
//   GET    admin/messenger                     { messenger: { api, available, reason, group, title, sync, release (1.7.0), checkedAt } }
//   PUT    admin/messenger                     { group: bool } — the group „Familie“ on / off (on: synced at once;
//                                              off, 1.7.0: handed back at once — release_group, a normal group)
//   POST   admin/messenger/sync                sync the group now (also after every member change here)
//   1.9.0 — page „Regeln & Erinnerungen“ (server/rules.js; every rule, quick actions of a rule saved here run as
//   the administrator, house rules only):
//   GET    admin/rules                         { rules, log, can, open: [] }
//   POST   admin/rules                         PATCH|DELETE admin/rules/<id>   POST admin/rules/<id>/test · admin/rules/test
//   GET    admin/rules/options
//   GET    admin/status also: settings.childrenOwnRules / shoppingNotify / shoppingChat

const store = require('./store');
const tz = require('./tz');
const members = require('./members');
const config = require('./config');
const locate = require('./locate');
const shopping = require('./shopping');
const kiosk = require('./kiosk');
const presence = require('./presence');
const ruleplaces = require('./ruleplaces');
const messenger = require('./messenger');
const rules = require('./rules');
const { fail, posInt, iso } = require('./util');

const DAY = 86400000;
const LOG_KINDS = ['locate', 'arrival', 'sos', 'place'];

function adminMember(m, cfg, rings) {
  return {
    userId: m.userId, name: m.name, gcRole: m.gcRole, role: m.role, birthdate: m.birthdate, age: m.age, adult: m.adult,
    locateMode: m.locateMode, effectiveMode: members.effectiveMode(m), locatable: m.role === 'child' && members.locateRefusal(m, cfg) === null,
    starGoal: m.starGoal, ...members.faceOf(m), presence: rings.get(m.userId) || null,
    // 1.1.0: a child of 14+ on "Automatisch" — the pages recommend "Kind bestätigt"
    ageHint: members.ageHint(m),
  };
}

async function status(gc, cfg, now) {
  const today = tz.localDate(now, cfg.tz);
  const fam = await members.load(gc, today);
  const rings = await presence.rings(gc, fam, cfg, false);
  return {
    members: fam.all.map((m) => adminMember(m, cfg, rings)),
    users: [...fam.users.values()].map((u) => ({ id: u.id, name: u.name, role: u.role, member: fam.byId.has(u.id) || fam.walls.has(u.id) })),
    modules: { ...cfg.modules },
    settings: {
      timezone: cfg.tz, timezoneSetting: cfg.tzSetting, notifyLang: cfg.lang, problems: cfg.problems, location: cfg.location,
      childrenOwnRules: cfg.childrenOwnRules, shoppingNotify: cfg.shoppingNotify, shoppingChat: cfg.shoppingChat,
    },
    wall: { listId: cfg.wallList || null, lists: (await shopping.summary(gc)).map((l) => ({ id: l.id, name: l.name })) },
    messenger: await messenger.info(gc, cfg),
    today,
  };
}

async function log(gc, cfg, query, now) {
  const q = query || {};
  const days = q.days == null || q.days === '' ? 7 : posInt(String(q.days));
  if (!days || days > 90) throw fail('invalid');
  const kinds = q.kind == null || q.kind === '' || q.kind === 'all' ? LOG_KINDS : String(q.kind).split(',').filter((k) => LOG_KINDS.includes(k));
  if (!kinds.length) throw fail('invalid');
  const userId = q.userId == null || q.userId === '' ? null : posInt(String(q.userId));
  const today = tz.localDate(now, cfg.tz);
  const fam = await members.load(gc, today);
  const name = (id) => { const m = fam.byId.get(id); if (m) return m.name; const u = fam.users.get(id); return u ? u.name : `#${id}`; };
  const from = now - days * DAY;
  const out = [];
  const pos = (r) => (r.lat != null && !r.purged ? { lat: r.lat, lon: r.lon, accuracy: r.accuracy } : null);
  if (kinds.includes('locate')) {
    const rows = await store.all(gc, 'SELECT * FROM locate_requests WHERE created_at >= ? ORDER BY created_at DESC LIMIT 1000', [from]);
    for (const r of rows) {
      if (userId && r.child_id !== userId && r.requested_by !== userId) continue;
      const status = r.status === 'pending' && r.expires_at <= now ? 'expired' : r.status;
      out.push({ kind: 'locate', id: r.id, at: iso(r.created_at), by: name(r.requested_by), byId: r.requested_by, subject: name(r.child_id), subjectId: r.child_id,
        status, mode: r.mode, reason: r.reason || null, answeredAt: iso(r.answered_at), position: status === 'answered' ? pos(r) : null, purged: !!r.purged });
    }
  }
  if (kinds.includes('arrival')) {
    const rows = await store.all(gc, 'SELECT * FROM arrivals WHERE at >= ? ORDER BY at DESC LIMIT 1000', [from]);
    for (const r of rows) {
      if (userId && r.user_id !== userId) continue;
      out.push({ kind: 'arrival', id: r.id, at: iso(r.at), by: name(r.user_id), byId: r.user_id, subject: name(r.user_id), subjectId: r.user_id, label: r.label || null, position: pos(r), purged: !!r.purged });
    }
  }
  if (kinds.includes('sos')) {
    const rows = await store.all(gc, 'SELECT * FROM sos WHERE at >= ? ORDER BY at DESC LIMIT 1000', [from]);
    const ids = rows.map((r) => r.id);
    const acks = ids.length ? await store.all(gc, `SELECT * FROM sos_acks WHERE sos_id IN (${store.marks(Math.min(ids.length, 90))})`, ids.slice(0, 90)) : [];
    for (const r of rows) {
      if (userId && r.user_id !== userId) continue;
      out.push({ kind: 'sos', id: r.id, at: iso(r.at), by: name(r.user_id), byId: r.user_id, subject: name(r.user_id), subjectId: r.user_id, position: pos(r), purged: !!r.purged,
        acks: acks.filter((a) => a.sos_id === r.id).map((a) => ({ name: name(a.user_id), at: iso(a.at) })) });
    }
  }
  if (kinds.includes('place')) {
    const rows = await store.all(gc, 'SELECT * FROM place_events WHERE at >= ? ORDER BY at DESC LIMIT 1000', [from]);
    for (const r of rows) {
      if (userId && r.user_id !== userId) continue;
      out.push({ kind: 'place', id: r.id, at: iso(r.at), by: name(r.user_id), byId: r.user_id, subject: name(r.user_id), subjectId: r.user_id, label: r.title, transition: r.transition, told: r.told });
    }
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const kids = members.children(fam);
  return {
    days, entries: out.slice(0, 1000),
    positions: await locate.lastPositions(gc, fam, kids.map((k) => k.userId)),
    children: kids.map((k) => ({ userId: k.userId, name: k.name, ...members.faceOf(k) })),
    members: fam.list.map((m) => ({ userId: m.userId, name: m.name, role: m.role, ...members.faceOf(m) })),
  };
}

/** The page "Anwesenheit & Smart Home". */
async function presenceRoute(req, gc, seg, cfg, now, m, body) {
  const [, , b, c] = seg;
  const fam = await members.load(gc, tz.localDate(now, cfg.tz));
  const lang = req.lang === 'en' ? 'en' : 'de';
  const ctx = { fam, cfg, now, ownerId: req.user.id, lang };
  if (seg.length === 2 && m === 'GET') {
    const map = await presence.load(gc, fam);
    const own = await presence.actions(gc, req.user.id, lang);
    return {
      modules: { presence: cfg.modules.presence }, location: cfg.location, members: presence.membersView(fam, map),
      ...(await presence.listRules(gc, ctx)), actions: own.actions, actionsAvailable: own.available,
      ...(await ruleplaces.list(gc, ctx)),
    };
  }
  if (b === 'actions' && seg.length === 3 && m === 'GET') return presence.actions(gc, req.user.id, lang);
  if (b === 'rules') {
    if (seg.length === 3 && m === 'POST') return store.tx(gc, () => presence.createRule(gc, ctx, body));
    if (seg.length === 4 && (m === 'PATCH' || m === 'PUT')) return store.tx(gc, () => presence.updateRule(gc, ctx, c, body));
    if (seg.length === 4 && m === 'DELETE') return store.tx(gc, () => presence.removeRule(gc, c));
  }
  if (b === 'places') {
    if (seg.length === 3 && m === 'GET') return ruleplaces.list(gc, ctx);
    if (seg.length === 3 && m === 'POST') return store.tx(gc, () => ruleplaces.create(gc, ctx, body));
    if (seg.length === 4 && (m === 'PATCH' || m === 'PUT')) return store.tx(gc, () => ruleplaces.update(gc, ctx, c, body));
    if (seg.length === 4 && m === 'DELETE') return store.tx(gc, () => ruleplaces.remove(gc, c));
  }
  throw fail('not_found');
}

/** 1.6.0: the group „Familie“ in the Messenger plugin. */
async function messengerRoute(gc, seg, cfg, now, m, body) {
  const [, , b] = seg;
  if (seg.length === 2 && m === 'GET') return { messenger: await messenger.info(gc, cfg) };
  if (seg.length === 2 && (m === 'PUT' || m === 'PATCH')) {
    if (typeof body.group !== 'boolean') throw fail('invalid', { field: 'group' });
    await messenger.setGroup(gc, body.group);
    const next = await config.load(gc);
    const fam = await members.load(gc, tz.localDate(now, next.tz));
    // on: synced at once; off (1.7.0): the group is handed back at once (a normal group in the messenger)
    if (next.messengerGroup) await messenger.sync(gc, fam, next, now, { force: true });
    else await messenger.release(gc, fam, next, now);
    return { messenger: await messenger.info(gc, next) };
  }
  if (b === 'sync' && seg.length === 3 && m === 'POST') {
    if (!cfg.messengerGroup) throw fail('invalid', { field: 'group' });
    await messenger.sync(gc, await members.load(gc, tz.localDate(now, cfg.tz)), cfg, now, { force: true });
    return { messenger: await messenger.info(gc, cfg) };
  }
  throw fail('not_found');
}

/** 1.9.0: the page „Regeln & Erinnerungen“. */
async function rulesRoute(req, gc, seg, cfg, now, m, body) {
  const [, , b, c] = seg;
  const fam = await members.load(gc, tz.localDate(now, cfg.tz));
  const ctx = { fam, cfg, now, lang: req.lang === 'en' ? 'en' : 'de', me: null, userId: req.user.id, admin: true };
  const n = seg.length;
  if (n === 2 && m === 'GET') return { modules: { rules: cfg.modules.rules, presence: cfg.modules.presence }, ...(await rules.list(gc, ctx)) };
  if (n === 2 && m === 'POST') return store.tx(gc, () => rules.create(gc, ctx, { ...body, scope: 'house' }));
  if (n === 3 && b === 'options' && m === 'GET') return rules.options(gc, ctx);
  if (n === 3 && b === 'test' && m === 'POST') return rules.testBody(gc, ctx, { ...body, scope: 'house' });
  if (n === 3 && (m === 'PATCH' || m === 'PUT')) return store.tx(gc, () => rules.update(gc, ctx, b, body));
  if (n === 3 && m === 'DELETE') return store.tx(gc, () => rules.remove(gc, ctx, b));
  if (n === 4 && c === 'test' && m === 'POST') return rules.test(gc, ctx, b);
  throw fail('not_found');
}

/** After a member change: the messenger group follows at once (when on; never fails the change). */
async function memberChanged(gc, cfg, now) {
  if (!cfg.messengerGroup) return;
  try {
    await messenger.sync(gc, await members.load(gc, tz.localDate(now, cfg.tz)), cfg, now);
  } catch (e) { gc.log.warn('messenger sync after member change failed', (e && (e.code || e.message)) || 'error'); }
}

async function route(req, gc, seg, cfg, now) {
  const m = String(req.method || 'GET').toUpperCase();
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const [, a, b] = seg;
  if (a === 'presence') return presenceRoute(req, gc, seg, cfg, now, m, body);
  if (a === 'rules') return rulesRoute(req, gc, seg, cfg, now, m, body);
  if (a === 'status' && seg.length === 2 && m === 'GET') return status(gc, cfg, now);
  if (a === 'messenger') return messengerRoute(gc, seg, cfg, now, m, body);
  if (a === 'log' && seg.length === 2 && m === 'GET') return log(gc, cfg, req.query, now);
  if (a === 'modules' && seg.length === 2 && (m === 'PUT' || m === 'PATCH')) {
    const patch = {};
    for (const [k, v] of Object.entries(body)) {
      if (!config.MODULES.includes(k) || typeof v !== 'boolean') throw fail('invalid');
      patch[k] = v;
    }
    if (!Object.keys(patch).length) throw fail('invalid');
    await config.saveModules(gc, patch);
    if (patch.locate === false) {
      await store.tx(gc, () => store.run(gc, "UPDATE locate_requests SET status = 'expired' WHERE status = 'pending'"));
    }
    return { modules: (await config.load(gc)).modules };
  }
  if (a === 'wall' && seg.length === 2 && (m === 'PUT' || m === 'PATCH')) {
    const id = body.listId == null || body.listId === '' ? '' : body.listId;
    if (id) {
      if (typeof id !== 'string' || !shopping.ID_RE.test(id)) throw fail('invalid');
      const l = await store.one(gc, 'SELECT deleted FROM shop_lists WHERE id = ?', [id]);
      if (!l || l.deleted) throw fail('invalid');
    }
    await config.saveWallList(gc, id);
    return { wall: { listId: id || null } };
  }
  if (a === 'members') {
    const today = tz.localDate(now, cfg.tz);
    const fam = await members.load(gc, today);
    if (seg.length === 2 && m === 'POST') {
      const id = await store.tx(gc, () => members.add(gc, fam, body, now));
      await kiosk.roleChanged(gc, id, null, await kiosk.roleOf(gc, id));
      await memberChanged(gc, cfg, now);
      const fresh = await members.load(gc, today);
      return { member: adminMember(fresh.byId.get(id) || fresh.walls.get(id), cfg, await presence.rings(gc, fresh, cfg, false)) };
    }
    const id = posInt(b);
    if (!id || seg.length !== 3) throw fail('not_found');
    if (m === 'PATCH' || m === 'PUT') {
      const before = await kiosk.roleOf(gc, id);
      await store.tx(gc, () => members.update(gc, fam, id, body));
      await kiosk.roleChanged(gc, id, before, await kiosk.roleOf(gc, id));
      await memberChanged(gc, cfg, now);
      const fresh = await members.load(gc, today);
      const mm = fresh.byId.get(id) || fresh.walls.get(id);
      if (!mm) throw fail('not_found');
      return { member: adminMember(mm, cfg, await presence.rings(gc, fresh, cfg, false)) };
    }
    if (m === 'DELETE') {
      const before = await kiosk.roleOf(gc, id);
      await store.tx(gc, () => members.remove(gc, id));
      await kiosk.roleChanged(gc, id, before, null);
      await memberChanged(gc, cfg, now);
      return {};
    }
  }
  throw fail('not_found');
}

module.exports = { route, status, log, adminMember };
