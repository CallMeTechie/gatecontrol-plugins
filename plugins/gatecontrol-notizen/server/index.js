'use strict';

// Notizen & Aufgaben (gatecontrol-notizen) — the hub of tasks and notes. README.md describes it all; the contract with
// the other plugins is docs/notes-sources-contract.md of this repository.

const clock = require('./clock');
const tz = require('./tz');
const config = require('./config');
const people = require('./people');
const api = require('./api');
const services = require('./services');
const housekeeping = require('./housekeeping');
const attachments = require('./attachments');
const sources = require('./sources');
const ui = require('./ui');
const calsync = require('./calsync');
const yesterday = require('./yesterday');
const shopping = require('./shopping');
const places = require('./places');
const placesearch = require('./placesearch');
const profileplaces = require('./profileplaces');
const famtasks = require('./famtasks');
const drivedue = require('./drivedue');
const { t } = require('./text');

const CART = 'M6 6h15l-1.5 9h-12zM6 6L5 3H2M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM18 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z';

/** The context of a call: who, which language, now and today in the hub's zone. */
async function context(gc, user, lang) {
  const cfg = await config.get(gc);
  const now = clock.now();
  const p = tz.parts(now, cfg.timezone);
  return {
    userId: user && Number.isSafeInteger(user.id) ? user.id : null, userName: (user && user.name) || '', lang: lang === 'en' ? 'en' : 'de',
    notifyLang: cfg.notify_lang, tz: cfg.timezone, now, today: tz.dateStr(p.y, p.m, p.d), time: `${tz.pad(p.hh)}:${tz.pad(p.mm)}`,
    readOnly: !!(user && user.portal && user.loggedIn === false),
    // 1.3.0: are tasks with a time written into Mail's calendar now (Task.calendar 'pending')?
    calendar: cfg.calendar_tasks !== false && await calsync.available(gc, now),
  };
}

module.exports = {
  async start(gc) {
    config.reset();
    calsync.reset();
    require('./termine').reset();
    yesterday.reset();
    shopping.reset();
    places.reset();
    famtasks.reset();
    drivedue.reset();
    placesearch.state.version = require('../plugin.json').version;
    profileplaces.reset();
    // 1.8.0: „Meine Orte“ move into the user profile (once; until it is done the background run tries again)
    try { await profileplaces.move(gc, clock.now()); } catch (e) { gc.log.warn('places move failed', (e && (e.code || e.message)) || 'error'); }
    gc.log.info('Notizen & Aufgaben started');
  },

  async stop() { shopping.stop(); famtasks.reset(); },

  async settingsChanged(values, gc) {
    config.reset();
    people.reset();
    // 1.5.0: another search service (or none): what was found through the old one is forgotten
    places.reset();
    // 1.3.0: „Aufgaben mit Uhrzeit in den Kalender eintragen“ switched: the events come or go with the next runs
    try { calsync.reset(); const ctx = await context(gc, null, 'de'); await calsync.touchAll(gc, ctx.today); } catch (e) { gc.log.warn('calendar marks failed', (e && (e.code || e.message)) || 'error'); }
  },

  /** 1.8.0 (permissions.places): a person's places of the profile changed — the copies follow, a deleted one stays the tasks' copy. */
  async placesChanged(payload, gc) {
    try { return await profileplaces.changed(gc, payload || {}, clock.now()); } catch (e) { gc.log.warn('places changed failed', (e && (e.code || e.message)) || 'error'); return null; }
  },

  async settingsStatus({ lang }, gc) {
    const l = lang === 'en' ? 'en' : 'de';
    const st = await sources.status(gc, { userId: 0 });
    const there = st.filter((s) => s.enabled && s.available).map((s) => t(l, 'src.' + s.plugin));
    const off = st.filter((s) => s.enabled && !s.available).map((s) => t(l, 'src.' + s.plugin));
    const out = [{ group: 'sources', tone: there.length ? 'ok' : 'info', text: there.length ? t(l, 'st.sources', { list: there.join(', ') }) : t(l, 'st.no_sources') }];
    if (off.length) out.push({ group: 'sources', tone: 'info', text: t(l, 'st.sources_missing', { list: off.join(', ') }) });
    // 1.7.0: the reminders of Drive's deadlines — from here (how many), ready, or not possible with this Drive
    const dl = (await require('./store').one(gc, 'SELECT COUNT(*) AS n FROM drive_due WHERE task_id IS NOT NULL')).n;
    const dlCan = await drivedue.claimable(gc);
    if (st.some((s) => s.plugin === drivedue.DRIVE && s.enabled && s.available)) out.push({ group: 'sources', tone: dl ? 'ok' : 'info', text: dl ? t(l, 'st.dl_on', { n: dl }) : t(l, dlCan ? 'st.dl_ready' : 'st.dl_missing') });
    // 1.3.0: the calendar „Aufgaben“ of Mail
    const cfg = await config.get(gc);
    const mail = await calsync.available(gc, clock.now());
    out.push({ group: 'calendar', tone: cfg.calendar_tasks !== false && mail ? 'ok' : 'info', text: t(l, cfg.calendar_tasks === false ? 'st.cal_off' : mail ? 'st.cal_ok' : 'st.cal_missing') });
    // 1.5.0: the place search — off, the public service (with its rules), or a service of one's own (assigned or not)
    const mode = placesearch.modeOf(cfg);
    const target = mode === 'own' && await placesearch.targetAssigned(gc);
    out.push({ group: 'places', tone: mode === 'off' ? 'info' : mode === 'own' && !target ? 'warn' : 'ok', text: t(l, mode === 'off' ? 'st.place_off' : mode === 'osm' ? 'st.place_osm' : target ? 'st.place_own' : 'st.place_own_missing') });
    // 1.8.0: the move of „Meine Orte“ into the profile — how many, and what the profile refused (the tasks keep it)
    const mv = await profileplaces.summary(gc);
    if (mv.moved || mv.family || mv.invalid || mv.limit || mv.failed) {
      const bad = mv.invalid + mv.limit;
      out.push({ group: 'places', tone: bad || mv.failed ? 'warn' : 'ok', text: t(l, mv.failed && !mv.done ? 'st.place_move_failed' : bad ? 'st.place_moved_some' : 'st.place_moved', { n: mv.moved, bad, family: mv.family }) });
    }
    return out;
  },

  async request(req, gc) {
    const user = req.user;
    if (!user || !Number.isSafeInteger(user.id)) return { status: 401, json: { ok: false, code: 'login' } };
    if (user.kiosk) return { status: 403, json: { ok: false, code: 'forbidden' } };
    const ctx = await context(gc, user, req.lang);
    return api.request(gc, ctx, req);
  },

  async render(view, gc) {
    return { html: ui.render(view) };
  },

  async portalVisible({ user }) {
    return !!(user && !user.kiosk);
  },

  async portalTiles({ user, lang }, gc) {
    if (!user || user.kiosk || user.loggedIn !== true) return [];
    const ctx = await context(gc, user, lang);
    const views = require('./views');
    const md = await views.myDay(gc, ctx, 'private', { yesterday: false });
    const open = md.sections.filter((s) => ['events', 'overdue', 'today'].includes(s.id)).reduce((n, s) => n + s.items.length, 0);
    const over = md.sections.find((s) => s.id === 'overdue').items.length;
    const out = [{ title: t(ctx.lang, 'v.myday'), value: open, state: over ? 'warn' : open ? 'on' : 'good', icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11' }];
    // 1.2.0: the list day card of „Mein Tag“ (Einkaufstag) as a tile of its own
    for (const d of (md.listdays || []).slice(0, 2)) {
      out.push({ title: d.title, value: d.list.name.slice(0, 40), unit: t(ctx.lang, 'v.listday_open', { n: d.open }).slice(0, 12), state: d.open ? 'on' : 'good', icon: CART });
    }
    return out;
  },

  async portalSearch({ user, lang, q }, gc) {
    if (!user || user.kiosk || user.loggedIn !== true) return [];
    const ctx = await context(gc, user, lang);
    try {
      const r = await require('./search').run(gc, ctx, { q, area: 'private' });
      return [...r.tasks.slice(0, 5).map((x) => ({ title: x.title, subtitle: t(ctx.lang, 'p.task') })), ...r.notes.filter((x) => x.title).slice(0, 5).map((x) => ({ title: x.title, subtitle: t(ctx.lang, 'p.note') }))].slice(0, 10);
    } catch { return []; }
  },

  async tick(gc) {
    const ctx = await context(gc, null, 'de');
    await housekeeping.tick(gc, ctx);
  },

  /**
   * 1.3.0: a button of one of our pushes was pressed (GateControl ≥ 1.181.0: once per push and button) — „Erledigt“,
   * „In 1 Std.“, „Heute Abend“ of a reminder, „Erledigt“ / „Heute“ of the morning hint. The push is no permission: what
   * the person may do is checked again (server/remind.js, server/yesterday.js).
   */
  async notifyAction(args, gc) {
    try {
      const uid = args && args.userId;
      if (!Number.isSafeInteger(uid) || uid <= 0 || typeof args.action !== 'string') return { ok: false, code: 'invalid' };
      const ctx = await context(gc, { id: uid, name: (await people.name(gc, uid)) || '' }, 'de');
      return await api.notifyAction(gc, ctx, args.action, args.data);
    } catch (e) {
      gc.log.warn('notify action failed', (e && (e.code || e.message)) || 'error');
      return { ok: false, code: 'failed' };
    }
  },

  async service(call, gc) {
    const ctx = await context(gc, call && call.user, 'de');
    return services.handle(gc, ctx, call);
  },

  async mediaAccess({ user, mediaId }, gc) {
    if (!user || !Number.isSafeInteger(user.id)) return false;
    const ctx = await context(gc, user, 'de');
    return attachments.mayRead(gc, ctx, mediaId);
  },
};

module.exports._context = context;
