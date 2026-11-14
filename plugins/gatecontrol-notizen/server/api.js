'use strict';

// The plugin's API — the same for the portal (/api/v1/portal/plugins/gatecontrol-notizen/api/…), the apps
// (/api/v1/client/plugins/gatecontrol-notizen/api/…) and the admin page. README "API" lists every route.

const config = require('./config');
const people = require('./people');
const prefs = require('./prefs');
const lists = require('./lists');
const tasks = require('./tasks');
const views = require('./views');
const sources = require('./sources');
const notes = require('./notes');
const attachments = require('./attachments');
const search = require('./search');
const vault = require('./vault');
const mstodo = require('./mstodo');
const dsnote = require('./dsnote');
const remind = require('./remind');
const yesterday = require('./yesterday');
const calsync = require('./calsync');
const Q = require('../ui/quickparse');
const { t } = require('./text');
const { fail, isKnown, statusOf, posInt } = require('./util');

// 1.1.0: `offlineEdits` — creates take a clientId (sent again: the same object), PATCH tasks/lists/notebooks take `base`,
// a change sent twice is harmless, a delete sent twice is ok (README "Offline on a device"); `pushTargets` — every push
// carries data.notizen.kind and the ids to open (README "Pushes").
// 1.2.0 (README "1.2.0"): `listDays` — lists have days/remind/mydayOff, „Mein Tag“ has `listdays`, push kind listday;
// `shareRoles` — members read | write; `groupEdit` — POST groups { lists }, groups with `open`; `deleteKeep` — DELETE
// lists|notebooks ?tasks|notes=move|delete, …/usage, …/restore; `listIcons` — lists have an icon of me.listIcons.
const FEATURES = ['tasks', 'notes', 'sources', 'vault', 'mstodo', 'dsnote', 'search', 'quickparse', 'attachments', 'ocrText', 'offlineEdits', 'pushTargets',
  'listDays', 'shareRoles', 'groupEdit', 'deleteKeep', 'listIcons',
  // 1.3.0 (README "1.3.0"): `reminderActions` — the reminder push has buttons and a tag, POST tasks/<id>/snooze, Task.reminder,
  // GET reminders; `yesterdayOpen` — „Gestern offen geblieben“: GET/POST yesterday, POST tasks/<id>/move, `yesterday` of
  // „Mein Tag“, the push kind yesterday; `taskCalendar` — Task.calendar, me.calendar, prefs.calendar.
  'reminderActions', 'yesterdayOpen', 'taskCalendar'];

const ok = (json) => ({ status: 200, json: { ok: true, ...json } });

/** Hooks between modules (kept here so the modules do not require each other in a circle). */
const taskOpts = {
  attachments: (gc, ctx, kind, id) => attachments.listOf(gc, ctx, kind, id),
  sourceItem: async (gc, ctx, plugin, extId) => {
    const r = await require('./store').one(gc, 'SELECT i.* FROM src_items i JOIN src_item_users u ON u.item_id = i.id AND u.user_id = ? WHERE i.plugin = ? AND i.ext_id = ?', [ctx.userId, plugin, extId]);
    if (!r) return null;
    const p = await prefs.get(gc, ctx.userId);
    return sources.view(ctx, { row: r, area: r.area, meta: JSON.parse(r.meta_json || '{}') }, p, (x) => t(ctx.lang, 'src.' + x));
  },
  completeSource: (gc, ctx, plugin, extId, done) => sources.complete(gc, ctx, plugin, extId, done),
  sourceOf: async (gc, ctx, s) => {
    if (!s || typeof s.plugin !== 'string' || typeof s.id !== 'string') throw fail('invalid', { field: 'source' });
    const r = await require('./store').one(gc, 'SELECT i.* FROM src_items i JOIN src_item_users u ON u.item_id = i.id AND u.user_id = ? WHERE i.plugin = ? AND i.ext_id = ?', [ctx.userId, s.plugin, s.id]);
    if (!r) throw fail('not_found', { field: 'source' });
    return { plugin: r.plugin, id: r.ext_id, row: r };
  },
};
notes.opts.completeTask = (gc, ctx, id, done) => tasks.complete(gc, ctx, id, { done }, taskOpts);
// 1.3.0: a person's choice changed — their events in the calendar follow, the plan of the morning hint is made anew
prefs.hooks.changed = async (gc, ctx, before, after) => {
  if (before.calendar.tasks !== after.calendar.tasks) await calsync.touchAll(gc, ctx.today, ctx.userId);
  if (before.yesterdayAt !== after.yesterdayAt || before.notify.yesterday !== after.notify.yesterday) yesterday.reset();
};

/** A button of one of the plugin's pushes (hook notifyAction): the reminder of a task, the morning hint. */
async function notifyAction(gc, ctx, action, data) {
  const d = data && data.notizen;
  if (!d || typeof d !== 'object') return { ok: false, code: 'invalid' };
  if (d.kind === 'reminder') return remind.onAction(gc, ctx, action, d, taskOpts);
  if (d.kind === 'yesterday') return yesterday.onAction(gc, ctx, action, d, taskOpts);
  return { ok: false, code: 'invalid' };
}

async function me(gc, ctx) {
  const cfg = await config.get(gc);
  const p = await prefs.get(gc, ctx.userId);
  if (await prefs.touch(gc, ctx.userId, ctx.now)) await sources.schedule(gc, ctx.userId, null, ctx.now);
  return {
    user: { id: ctx.userId, name: ctx.userName }, lang: ctx.lang, today: ctx.today, time: ctx.time, timezone: ctx.tz, features: FEATURES,
    prefs: p, sharing: cfg.sharing, vaults: cfg.vaults, imports: { mstodo: cfg.import_mstodo, mstodoSync: cfg.mstodo_sync, dsnote: cfg.import_dsnote },
    attachMB: cfg.attach_mb, readOnly: !!ctx.readOnly, listIcons: lists.ICONS,
    // 1.3.0: tasks with a time in Mail's calendar „Aufgaben“ (available: Mail offers it; enabled: the administrator's
    // switch; mine: the person's own), and the morning hint
    calendar: { available: await calsync.available(gc, ctx.now), enabled: cfg.calendar_tasks !== false, mine: p.calendar.tasks !== false, name: t(ctx.lang, 'cal.name') },
    yesterday: { push: p.notify.yesterday !== false, at: p.yesterdayAt },
  };
}

/** POST items/<id>/carry — the item gets a hub task of its own (sub tasks, note, reminder; completing ticks it off there). */
async function carry(gc, ctx, id) {
  const r = await sources.access(gc, ctx, id);
  const have = await tasks.carrying(gc, ctx, r.plugin, r.ext_id);
  if (have) return tasks.get(gc, ctx, have.id, taskOpts);
  const made = await tasks.create(gc, ctx, {
    title: r.title, area: r.area, important: !!r.important, due: r.due_date ? { date: r.due_date, time: r.all_day ? null : r.due_time } : undefined,
    source: { plugin: r.plugin, id: r.ext_id },
  }, taskOpts);
  return tasks.get(gc, ctx, made.task.id, taskOpts);
}

async function itemGet(gc, ctx, id) {
  const r = await sources.access(gc, ctx, id);
  const p = await prefs.get(gc, ctx.userId);
  const carried = await tasks.carrying(gc, ctx, r.plugin, r.ext_id);
  return { item: sources.view(ctx, { row: r, area: r.area, meta: JSON.parse(r.meta_json || '{}') }, p, (x) => t(ctx.lang, 'src.' + x)), taskId: carried ? carried.id : null };
}

async function itemComplete(gc, ctx, id, b) {
  const r = await sources.access(gc, ctx, id);
  if (!r.can_complete) throw fail('forbidden', { reason: 'read_only' });
  const done = !b || b.done !== false;
  await sources.complete(gc, ctx, r.plugin, r.ext_id, done);
  return itemGet(gc, ctx, r.id);
}

async function parseText(gc, ctx, b) {
  if (!b || typeof b.text !== 'string' || b.text.length > 1000) throw fail('invalid', { field: 'text' });
  return { parsed: await tasks.fromText(gc, ctx, b.text, b.area) };
}

async function sync(gc, ctx, plugin) {
  if (!sources.SOURCES.includes(plugin)) throw fail('not_found');
  const s = await require('./store').one(gc, 'SELECT last_at FROM src_sync WHERE plugin = ? AND user_id = ?', [plugin, ctx.userId]);
  if (s && s.last_at && ctx.now - s.last_at < 600000) return { scheduled: false, reason: 'recent' };
  await sources.schedule(gc, ctx.userId, plugin, ctx.now);
  return { scheduled: true };
}

async function peopleList(gc, ctx) {
  return { people: (await people.pickable(gc, ctx.userId)).map((u) => ({ id: u.id, name: u.name, avatarUrl: u.avatarUrl, colorHex: u.colorHex, initials: u.initials, me: u.id === ctx.userId })) };
}

/** req → { status, json } */
async function handle(gc, ctx, req) {
  const m = req.method;
  const parts = String(req.path || '').replace(/^\/+|\/+$/g, '').split('/').map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const q = req.query || {};
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const [a, x, y, z, w] = parts;
  const n = parts.length;
  if (ctx.readOnly && m !== 'GET') throw fail('forbidden', { reason: 'login' });
  const is = (meth, len, first) => m === meth && n === len && a === first;

  if (is('GET', 1, 'me')) return ok(await me(gc, ctx));
  if (is('GET', 1, 'nav')) return ok(await views.nav(gc, ctx, q, notes.nav));
  if (is('GET', 2, 'views')) return ok(await views.get(gc, ctx, x, q));
  if (is('POST', 1, 'parse')) return ok(await parseText(gc, ctx, b));
  if (is('GET', 1, 'people')) return ok(await peopleList(gc, ctx));
  if (is('GET', 1, 'search')) return ok(await search.run(gc, ctx, q));
  if (is('GET', 1, 'prefs')) return ok({ prefs: await prefs.get(gc, ctx.userId) });
  if (is('PUT', 1, 'prefs')) return ok(await prefs.put(gc, ctx, b));
  if (is('GET', 1, 'sources')) return ok({ sources: (await sources.status(gc, ctx)).map((s) => ({ ...s, label: t(ctx.lang, 'src.' + s.plugin), hint: t(ctx.lang, 'srch.' + s.plugin) })) });
  if (m === 'POST' && n === 3 && a === 'sources' && y === 'sync') return ok(await sync(gc, ctx, x));

  // lists and groups
  if (is('GET', 1, 'lists')) return ok(await lists.all(gc, ctx, q.area));
  if (is('POST', 1, 'lists')) return ok(await lists.create(gc, ctx, b));
  if (m === 'PATCH' && n === 2 && a === 'lists') return ok(await lists.update(gc, ctx, x, b));
  if (m === 'DELETE' && n === 2 && a === 'lists') return ok(await lists.remove(gc, ctx, x, q));
  if (m === 'GET' && n === 3 && a === 'lists' && y === 'usage') return ok(await lists.usage(gc, ctx, x));
  if (m === 'POST' && n === 3 && a === 'lists' && y === 'restore') return ok(await lists.restore(gc, ctx, x));
  if (m === 'PUT' && n === 3 && a === 'lists' && y === 'members') return ok(await lists.setMembers(gc, ctx, x, b));
  if (is('POST', 1, 'groups')) return ok(await lists.createGroup(gc, ctx, b));
  if (m === 'PATCH' && n === 2 && a === 'groups') return ok(await lists.updateGroup(gc, ctx, x, b));
  if (m === 'DELETE' && n === 2 && a === 'groups') return ok(await lists.removeGroup(gc, ctx, x));

  // tasks
  if (is('POST', 1, 'tasks')) return ok(await tasks.create(gc, ctx, b, taskOpts));
  if (m === 'GET' && n === 2 && a === 'tasks') return ok(await tasks.get(gc, ctx, x, taskOpts));
  if (m === 'PATCH' && n === 2 && a === 'tasks') { await tasks.update(gc, ctx, x, b); return ok(await tasks.get(gc, ctx, x, taskOpts)); }
  if (m === 'DELETE' && n === 2 && a === 'tasks') return ok(await tasks.remove(gc, ctx, x));
  if (m === 'POST' && n === 3 && a === 'tasks' && y === 'complete') return ok(await tasks.complete(gc, ctx, x, b, taskOpts));
  // 1.3.0: „Später“, „Heute“ / „Verschieben“, „Gestern offen geblieben“, the reminders to come (for a device's own alarms)
  if (m === 'POST' && n === 3 && a === 'tasks' && y === 'snooze') return ok(await remind.snooze(gc, ctx, x, b, taskOpts));
  if (m === 'POST' && n === 3 && a === 'tasks' && y === 'move') return ok(await yesterday.move(gc, ctx, x, b, taskOpts));
  if (is('GET', 1, 'yesterday')) return ok(await yesterday.get(gc, ctx, q));
  if (is('POST', 1, 'yesterday')) return ok(await yesterday.post(gc, ctx, b, taskOpts));
  if (is('GET', 1, 'reminders')) return ok(await remind.feed(gc, ctx));

  // items of the other plugins
  if (m === 'GET' && n === 2 && a === 'items') return ok(await itemGet(gc, ctx, x));
  if (m === 'POST' && n === 3 && a === 'items' && y === 'complete') return ok(await itemComplete(gc, ctx, x, b));
  if (m === 'POST' && n === 3 && a === 'items' && y === 'carry') return ok(await carry(gc, ctx, x));

  // notebooks and notes
  if (is('GET', 1, 'notebooks')) return ok(await notes.notebooks(gc, ctx, q.area));
  if (is('POST', 1, 'notebooks')) return ok(await notes.createNotebook(gc, ctx, b));
  if (m === 'PATCH' && n === 2 && a === 'notebooks') return ok(await notes.updateNotebook(gc, ctx, x, b));
  if (m === 'DELETE' && n === 2 && a === 'notebooks') return ok(await notes.removeNotebook(gc, ctx, x, q));
  if (m === 'GET' && n === 3 && a === 'notebooks' && y === 'usage') return ok(await notes.usage(gc, ctx, x));
  if (m === 'POST' && n === 3 && a === 'notebooks' && y === 'restore') return ok(await notes.restoreNotebook(gc, ctx, x));
  if (m === 'PUT' && n === 3 && a === 'notebooks' && y === 'members') return ok(await notes.setMembers(gc, ctx, x, b));
  if (is('GET', 1, 'notes')) return ok(await notes.list(gc, ctx, q));
  if (is('POST', 1, 'notes')) {
    const r = await notes.create(gc, ctx, b);
    return ok({ ...(await notes.get(gc, ctx, r.id, taskOpts)), ...(r.clientId ? { clientId: r.clientId } : {}), ...(r.replayed ? { replayed: true } : {}) });
  }
  if (m === 'GET' && n === 2 && a === 'notes') return ok(await notes.get(gc, ctx, x, taskOpts));
  if (m === 'PATCH' && n === 2 && a === 'notes') { await notes.update(gc, ctx, x, b); return ok(await notes.get(gc, ctx, x, taskOpts)); }
  if (m === 'DELETE' && n === 2 && a === 'notes') return ok(await notes.remove(gc, ctx, x));
  if (m === 'POST' && n === 3 && a === 'notes' && y === 'check') { await notes.check(gc, ctx, x, b); return ok(await notes.get(gc, ctx, x, taskOpts)); }
  if (m === 'POST' && n === 3 && a === 'notes' && y === 'task') return ok(await notes.lineToTask(gc, ctx, x, b, { create: (g, c, body) => tasks.create(g, c, body, taskOpts) }));

  // attachments
  if (is('POST', 1, 'attachments')) return ok(await attachments.add(gc, ctx, b));
  if (m === 'GET' && n === 2 && a === 'attachments') return ok(await attachments.get(gc, ctx, x));
  if (m === 'DELETE' && n === 2 && a === 'attachments') return ok(await attachments.remove(gc, ctx, x));
  if (m === 'PUT' && n === 3 && a === 'attachments' && y === 'text') return ok(await attachments.setText(gc, ctx, x, b));

  // Tresor notebooks
  if (a === 'vaults') {
    if (m === 'POST' && n === 1) return ok(await vault.create(gc, ctx, b));
    if (m === 'GET' && n === 1) return ok(await vault.list(gc, ctx));
    if (m === 'GET' && n === 2) return ok(await vault.get(gc, ctx, x));
    if (m === 'GET' && n === 3 && y === 'keys') return ok(await vault.keys(gc, ctx, x, q));
    if (m === 'GET' && n === 3 && y === 'recovery') return ok(await vault.recovery(gc, ctx, x));
    if (m === 'PUT' && n === 3 && y === 'recovery') return ok(await vault.setRecovery(gc, ctx, x, b));
    if (m === 'GET' && n === 3 && y === 'devices') return ok(await vault.devices(gc, ctx, x));
    if (m === 'POST' && n === 3 && y === 'devices') return ok(await vault.ask(gc, ctx, x, b));
    if (m === 'POST' && n === 5 && y === 'devices' && w === 'approve') return ok(await vault.approve(gc, ctx, x, z, b));
    if (m === 'DELETE' && n === 4 && y === 'devices') return ok(await vault.revoke(gc, ctx, x, z));
    if (m === 'POST' && n === 3 && y === 'rotate') return ok(await vault.rotate(gc, ctx, x, b));
  }

  // moving over
  if (a === 'import') {
    if (m === 'GET' && n === 3 && x === 'mstodo' && y === 'accounts') return ok(await mstodo.accounts(gc, ctx));
    if (m === 'POST' && n === 3 && x === 'mstodo' && y === 'consent') return ok(await mstodo.consent(gc, ctx, b));
    if (m === 'GET' && n === 3 && x === 'mstodo' && y === 'preview') return ok(await mstodo.preview(gc, ctx, q));
    if (m === 'POST' && n === 3 && x === 'mstodo' && y === 'start') return ok(await mstodo.start(gc, ctx, b));
    if (m === 'GET' && n === 3 && x === 'mstodo' && y === 'links') return ok(await mstodo.links(gc, ctx));
    if (m === 'DELETE' && n === 4 && x === 'mstodo' && y === 'links') return ok(await mstodo.unlink(gc, ctx, z));
    if (m === 'GET' && n === 3 && x === 'jobs') return ok(await mstodo.job(gc, ctx, y));
    if (m === 'POST' && n === 3 && x === 'dsnote' && y === 'start') return ok(await dsnote.start(gc, ctx, b));
    if (m === 'POST' && n === 4 && x === 'dsnote' && posInt(y) && z === 'notebook') return ok(await dsnote.notebook(gc, ctx, y, b));
    if (m === 'POST' && n === 4 && x === 'dsnote' && posInt(y) && z === 'notes') return ok(await dsnote.batch(gc, ctx, y, b));
    if (m === 'POST' && n === 4 && x === 'dsnote' && posInt(y) && z === 'finish') return ok(await dsnote.finish(gc, ctx, y, b));
  }
  throw fail('not_found');
}

/** The request hook's answer: errors with a code → { status, json: { ok: false, code, … } }. */
async function request(gc, ctx, req) {
  try {
    return await handle(gc, ctx, req);
  } catch (e) {
    if (isKnown(e)) return { status: statusOf(e.code), json: { ok: false, code: e.code, ...(e.extra || {}) } };
    gc.log.error('request failed', req && req.method, req && req.path, (e && (e.stack || e.message)) || e);
    return { status: 500, json: { ok: false, code: 'failed' } };
  }
}

module.exports = { request, notifyAction, taskOpts, FEATURES, Q };
