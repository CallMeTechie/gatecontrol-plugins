'use strict';

// Alltag as a source of „Notizen & Aufgaben“ (1.5.0, gatecontrol-notizen; contract v1, server/todohub.js): the waste
// collections of today and the next NEXT_DAYS days — one item per plan, day and fraction:
//
//   { id: 'waste:<planId>:<date>:<fractionId>', kind: 'event', title: „Gelbe Tonne rausstellen“, subtitle: „Zuhause ·
//     Abholung Do, 12.11.“, due: the collection day (allDay), lead: 'evening' (the hub shows it the evening before),
//     users: the plan's people (a plan for everyone: every account, at most 50), group: the plan, meta.type: the
//     fraction's type, canComplete: false (Alltag has no „rausgestellt“), open: waste/<date> }
//
// Hidden fractions, switched-off plans and a switched-off waste area report nothing. Without the hub nothing is sent.

const store = require('./store');
const config = require('./config');
const tz = require('./tz');
const format = require('./format');
const fractions = require('./fractions');
const texts = require('./texts.json');
const todohub = require('./todohub');

const NEXT_DAYS = 14;
const PLUGIN = 'gatecontrol-alltag';

function t(lang, key, params) {
  let s = (texts[lang === 'en' ? 'en' : 'de'] || {})[key] || texts.de[key] || key;
  for (const [k, v] of Object.entries(params || {})) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

async function everyone(gc) {
  try { return (await gc.users.list()).filter((u) => u && !u.disabled && Number.isSafeInteger(u.id)).map((u) => u.id).slice(0, 50); } catch { return []; }
}

/** Every waste item of the next days (all people). */
async function collect(gc, now) {
  const cfg = await config.load(gc);
  if (!cfg.wasteEnabled) return [];
  const plans = (await store.listPlans(gc)).filter((p) => p.enabled);
  if (!plans.length) return [];
  const byId = new Map(plans.map((p) => [p.id, p]));
  const today = tz.localDate(now, cfg.tz);
  let all = null;
  const out = [];
  for (const r of await store.datesBetween(gc, null, today, tz.addDays(today, NEXT_DAYS))) {
    const p = byId.get(r.plan_id);
    if (!p || r.hidden) continue;
    let users = p.users;
    if (users == null) users = all || (all = await everyone(gc));
    if (!users.length) continue;
    const f = fractions.present({ id: r.fraction_id, source_name: r.source_name, type: r.type, name: r.name, color: r.color || null, hidden: r.hidden });
    out.push({
      id: `waste:${p.id}:${r.date}:${r.fraction_id}`, kind: 'event',
      title: t(cfg.lang, 'notizen.waste_title', { name: f.name }),
      subtitle: t(cfg.lang, 'notizen.waste_subtitle', { plan: p.name, day: format.dayShort(r.date, cfg.lang) }),
      due: r.date, allDay: true, lead: 'evening', area: 'private', users,
      important: false, done: false, canComplete: false,
      group: { id: `plan:${p.id}`, label: p.name }, meta: { type: f.type },
      open: { plugin: PLUGIN, route: `waste/${r.date}` },
    });
  }
  return out;
}

const source = todohub.create({
  plugin: PLUGIN,
  collect,
  // nothing to tick off in Alltag (canComplete false — the hub only shows the items)
  complete: async () => ({ ok: false, code: 'read_only' }),
  tx: (gc, fn) => store.tx(gc, fn),
  intervalMs: 60000,
});

module.exports = { source, collect, NEXT_DAYS };
