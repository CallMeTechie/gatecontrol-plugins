'use strict';

// Quick actions of Familie (1.9.0, the hooks quickActions / runQuickAction) — the buttons of the
// cards this plugin puts into the Messenger (and of its pushes). Each is listed only for the
// person it belongs to and only while it is open, so a button pressed by anyone else (a card in
// the family chat) finds nothing (404 at the host):
//
//   shop-take:<listId>     „Übernehmen“   the shopping list asked of the viewer (POST shopping/lists/<id>/assign)
//   shop-decline:<listId>  „Heute nicht“  — the one who asked is told either way
//   task-done:<taskId>     „Erledigt“     a task made in a chat (POST tasks/quick) that is the viewer's to do
//
// At most 16 (the host's limit), buttons only (kind 'button'), never for a wall tablet. A run checks
// everything again (the viewer: the person who pressed, also when the Messenger runs it for them).

const store = require('./store');
const tz = require('./tz');
const push = require('./push');
const members = require('./members');
const shopping = require('./shopping');
const tasks = require('./tasks');

const MAX = 16;
const ICON_CART = 'M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6M10 21h.01M18 21h.01';
const ICON_X = 'M6 6l12 12M18 6L6 18';
const ICON_CHECK = 'M5 12l5 5L20 7';
const ID_RE = /^(shop-take|shop-decline|task-done):(.+)$/;

async function context(gc, cfg, user, now) {
  if (!user || !Number.isSafeInteger(user.id)) return null;
  const today = tz.localDate(now, cfg.tz);
  const fam = await members.load(gc, today);
  const me = fam.byId.get(user.id);
  return me ? { fam, me, today } : null;
}

/** quickActions({ user, lang }) → [{ id, title, subtitle, icon, kind }] */
async function list(gc, cfg, args, now) {
  const a = args || {};
  const lang = a.lang === 'en' ? 'en' : 'de';
  const c = await context(gc, cfg, a.user, now);
  if (!c) return [];
  const out = [];
  if (cfg.modules.shopping) {
    for (const l of await shopping.requestsOf(gc, c.me.userId)) {
      const ids = shopping.requestIds(l.id);
      if (!ids) continue;
      const sub = shopping.itemsText(lang, l.open);
      out.push({ id: ids.take, title: push.t(lang, 'qa.shop_take', { list: l.name }).slice(0, 40), subtitle: sub, icon: ICON_CART, kind: 'button' });
      out.push({ id: ids.decline, title: push.t(lang, 'qa.shop_decline', { list: l.name }).slice(0, 40), subtitle: sub, icon: ICON_X, kind: 'button' });
    }
  }
  if (cfg.modules.tasks) {
    for (const t of await tasks.openChatTasks(gc, c.fam, c.today, c.me.userId)) {
      out.push({ id: `task-done:${t.id}`, title: push.t(lang, 'qa.task_done', { title: t.title }).slice(0, 40), subtitle: push.t(lang, 'qa.task_sub'), icon: ICON_CHECK, kind: 'button' });
    }
  }
  return out.slice(0, MAX);
}

/** runQuickAction({ user, lang, id }) → { ok, message } */
async function run(gc, cfg, args, now) {
  const a = args || {};
  const lang = a.lang === 'en' ? 'en' : 'de';
  const m = ID_RE.exec(String(a.id || ''));
  const c = await context(gc, cfg, a.user, now);
  if (!m || !c) return { ok: false, message: push.t(lang, 'qa.gone') };
  const pushes = [];
  let out;
  if (m[1] === 'task-done') {
    const id = Number(m[2]);
    if (!cfg.modules.tasks || !Number.isSafeInteger(id) || !(await tasks.openChatTasks(gc, c.fam, c.today, c.me.userId)).some((t) => t.id === id)) return { ok: false, message: push.t(lang, 'qa.gone') };
    const r = { cfg, now, today: c.today, fam: c.fam, me: c.me, body: {}, pushes, lang };
    await store.tx(gc, () => tasks.done(gc, r, id));
    out = { ok: true, message: push.t(lang, 'qa.task_done_msg') };
  } else {
    if (!cfg.modules.shopping) return { ok: false, message: push.t(lang, 'qa.gone') };
    const take = m[1] === 'shop-take';
    const row = await store.tx(gc, () => shopping.answer(gc, c.fam, cfg, now, m[2], c.me.userId, take, pushes));
    if (!row) return { ok: false, message: push.t(lang, 'qa.gone') };
    out = { ok: true, message: push.t(lang, take ? 'qa.shop_taken_msg' : 'qa.shop_declined_msg') };
  }
  await push.flush(gc, pushes);
  return out;
}

module.exports = { list, run, MAX };
