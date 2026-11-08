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
const { t } = require('./text');

/** The context of a call: who, which language, now and today in the hub's zone. */
async function context(gc, user, lang) {
  const cfg = await config.get(gc);
  const now = clock.now();
  const p = tz.parts(now, cfg.timezone);
  return {
    userId: user && Number.isSafeInteger(user.id) ? user.id : null, userName: (user && user.name) || '', lang: lang === 'en' ? 'en' : 'de',
    notifyLang: cfg.notify_lang, tz: cfg.timezone, now, today: tz.dateStr(p.y, p.m, p.d), time: `${tz.pad(p.hh)}:${tz.pad(p.mm)}`,
    readOnly: !!(user && user.portal && user.loggedIn === false),
  };
}

module.exports = {
  async start(gc) {
    config.reset();
    gc.log.info('Notizen & Aufgaben started');
  },

  async stop() {},

  async settingsChanged(values, gc) {
    config.reset();
    people.reset();
  },

  async settingsStatus({ lang }, gc) {
    const l = lang === 'en' ? 'en' : 'de';
    const st = await sources.status(gc, { userId: 0 });
    const there = st.filter((s) => s.enabled && s.available).map((s) => t(l, 'src.' + s.plugin));
    const off = st.filter((s) => s.enabled && !s.available).map((s) => t(l, 'src.' + s.plugin));
    const out = [{ group: 'sources', tone: there.length ? 'ok' : 'info', text: there.length ? t(l, 'st.sources', { list: there.join(', ') }) : t(l, 'st.no_sources') }];
    if (off.length) out.push({ group: 'sources', tone: 'info', text: t(l, 'st.sources_missing', { list: off.join(', ') }) });
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
    const md = await views.myDay(gc, ctx, 'private');
    const open = md.sections.filter((s) => ['events', 'overdue', 'today'].includes(s.id)).reduce((n, s) => n + s.items.length, 0);
    const over = md.sections.find((s) => s.id === 'overdue').items.length;
    return [{ title: t(ctx.lang, 'v.myday'), value: open, state: over ? 'warn' : open ? 'on' : 'good', icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11' }];
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
