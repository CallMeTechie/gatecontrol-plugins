'use strict';

// Calendars shown in Mail's calendar, read only (C3 overlays): the family calendar of Familie (service calendar_range,
// Familie ≥ 1.16.0), the person's Alltag calendars (calendar_list / calendar_query, Alltag ≥ 1.4.0) and the birthdays of
// the person's contacts („Anna Lang (40)“ when the year is known). Familie and Alltag are read through gc.services per
// person and month and kept 10 minutes. The administrator switches each kind off (calendar.overlays), the person hides
// or colours each overlay (cal_prefs).

const store = require('./store');
const pimstore = require('./pimstore');
const tz = require('./tz');
const { fail } = require('./util');
const { t } = require('./text');

const FAMILIE = 'gatecontrol-familie';
const ALLTAG = 'gatecontrol-alltag';
const TTL = 10 * 60000;
const PAGES = 20;
const COLORS = { familie: '#F5B544', alltag: '#5FD4E8', birthdays: '#E58FD0' };

const cache = new Map(); // `${kind}:${userId}:${YYYY-MM}` → { at, items }
const subsCache = new Map(); // userId → { at, subs }

const servicesOk = (gc) => !!(gc.services && typeof gc.services.call === 'function');

async function available(gc, plugin, service) {
  if (!servicesOk(gc) || typeof gc.services.available !== 'function') return false;
  try { return (await gc.services.available(plugin, service)) === true; } catch { return false; }
}

/** GET me features: familyOverlay / alltagOverlay. */
const familyOn = (gc) => available(gc, FAMILIE, 'calendar_range');
const alltagOn = (gc) => available(gc, ALLTAG, 'calendar_query');

async function call(gc, userId, plugin, service, payload) {
  const r = await gc.services.call({ plugin, service, userId, payload });
  if (!r || r.ok !== true) throw Object.assign(new Error('overlay'), { code: (r && r.code) || 'failed' });
  return r;
}

/** The Alltag calendars the person sees (cached 10 minutes). */
async function alltagSubs(gc, userId) {
  const c = subsCache.get(userId);
  if (c && Date.now() - c.at < TTL) return c.subs;
  let subs = [];
  try { subs = ((await call(gc, userId, ALLTAG, 'calendar_list', {})).subscriptions || []).filter((s) => Number.isSafeInteger(s.id)); } catch { subs = c ? c.subs : []; }
  subsCache.set(userId, { at: Date.now(), subs });
  return subs;
}

/** The overlays of the person: [{ id, source, name, color, visible }]. */
async function list(gc, cfg, userId, lang) {
  const { overlays: own } = await pimstore.calPrefs(gc, userId, cfg);
  const view = (id, source, name) => {
    const o = own[id] || {};
    return { id, source, name, color: typeof o.color === 'string' && /^#[0-9A-F]{6}$/.test(o.color) ? o.color : COLORS[source], visible: o.visible !== false };
  };
  const out = [];
  if (cfg.calendar.overlays.familie && await familyOn(gc)) out.push(view('familie', 'familie', t(lang, 'cal.familie')));
  if (cfg.calendar.overlays.alltag && await alltagOn(gc)) for (const s of await alltagSubs(gc, userId)) out.push(view(`alltag:${s.id}`, 'alltag', String(s.name || 'Alltag').slice(0, 80)));
  const cp = await pimstore.cardPrefs(gc, userId);
  if (cfg.calendar.overlays.birthdays && cfg.contacts.enabled && cp.birthdays) out.push(view('birthdays', 'birthdays', t(lang, 'cal.birthdays')));
  return out;
}

/** The months (YYYY-MM) a range touches. */
function months(fromDate, toDate) {
  const out = [];
  let y = Number(fromDate.slice(0, 4));
  let m = Number(fromDate.slice(5, 7));
  const end = toDate.slice(0, 7);
  for (let i = 0; i < 4; i++) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    out.push(k);
    if (k >= end) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return tz.dateStr(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate()); };

/** The items of Familie for a month (cached). */
async function familieMonth(gc, userId, ym) {
  const k = `familie:${userId}:${ym}`;
  const c = cache.get(k);
  if (c && Date.now() - c.at < TTL) return c.items;
  const items = [];
  let cursor = null;
  for (let i = 0; i < PAGES; i++) {
    const r = await call(gc, userId, FAMILIE, 'calendar_range', { from: `${ym}-01`, to: lastDay(ym), ...(cursor ? { cursor } : {}) });
    const zone = tz.valid(r.tz) ? r.tz : 'Europe/Berlin';
    for (const e of r.events || []) {
      const allDay = e.allDay || !e.time;
      const endDate = e.endDate || e.date;
      const tm = (s) => tz.parseTime(s) || { hh: 0, mm: 0 };
      const start = allDay ? tz.at(e.date, { hh: 0, mm: 0 }, zone) : tz.at(e.date, tm(e.time), zone);
      let end = allDay ? tz.at(tz.addDays(endDate, 1), { hh: 0, mm: 0 }, zone) : (e.endTime ? tz.at(endDate, tm(e.endTime), zone) : start + 3600000);
      if (end < start) end = start + 3600000;
      items.push({
        key: `familie:${e.id}:${e.date}`, overlayId: 'familie', title: String(e.title || '').slice(0, 255), start, end, allDay: !!allDay,
        ...(allDay ? { startDate: e.date, endDate } : {}), location: e.place || null, readOnly: true,
      });
    }
    cursor = r.next || null;
    if (!cursor) break;
  }
  cache.set(k, { at: Date.now(), items });
  return items;
}

/** The items of the Alltag calendars `subIds` for a month (cached per person and month, all their calendars). */
async function alltagMonth(gc, userId, ym, subIds) {
  const k = `alltag:${userId}:${ym}`;
  let c = cache.get(k);
  if (!c || Date.now() - c.at >= TTL) {
    const items = [];
    let cursor = null;
    for (let i = 0; i < PAGES; i++) {
      const r = await call(gc, userId, ALLTAG, 'calendar_query', { from: `${ym}-01`, to: lastDay(ym), ...(cursor ? { cursor } : {}) });
      for (const e of r.events || []) {
        const start = Number(e.startMs);
        if (!Number.isFinite(start)) continue;
        const end = Number.isFinite(Number(e.endMs)) && e.endMs > start ? Number(e.endMs) : start + (e.allDay ? 86400000 : 3600000);
        const uid = e.uid || `${start}:${String(e.title || '').slice(0, 40)}`;
        items.push({
          key: `alltag:${e.subId}:${uid}`, overlayId: `alltag:${e.subId}`, title: String(e.title || '').slice(0, 255), start, end, allDay: !!e.allDay,
          ...(e.allDay ? { startDate: e.date, endDate: tz.addDays(e.date, Math.max(0, Math.round((end - start) / 86400000) - 1)) } : {}), location: e.location || null, readOnly: true,
        });
      }
      cursor = r.next || null;
      if (!cursor) break;
    }
    c = { at: Date.now(), items };
    cache.set(k, c);
  }
  const want = new Set(subIds.map((id) => `alltag:${id}`));
  return c.items.filter((x) => want.has(x.overlayId));
}

/** The birthdays of the person's contacts between two dates (`zone`: midnight of the person). */
async function birthdays(gc, userId, fromDate, toDate, zone) {
  const rows = await store.all(gc, `SELECT c.id, c.display, c.birthday FROM cards c JOIN addressbooks b ON b.id = c.addressbook_id
    WHERE c.user_id = ? AND c.birthday IS NOT NULL AND b.visible = 1 AND c.link_id IS NULL`, [userId]);
  const out = [];
  const y0 = Number(fromDate.slice(0, 4));
  const y1 = Number(toDate.slice(0, 4));
  for (const r of rows) {
    const m = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(r.birthday);
    if (!m) continue;
    for (let y = y0; y <= y1; y++) {
      const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      const d = m[2] === '02' && m[3] === '29' && !leap ? '28' : m[3];
      const date = `${y}-${m[2]}-${d}`;
      if (date < fromDate || date > toDate) continue;
      const age = m[1] !== '-' && Number(m[1]) <= y ? y - Number(m[1]) : null;
      out.push({
        key: `bday:${r.id}:${y}`, overlayId: 'birthdays', title: age != null && age > 0 ? `${r.display} (${age})` : r.display, start: tz.at(date, { hh: 0, mm: 0 }, zone),
        end: tz.at(tz.addDays(date, 1), { hh: 0, mm: 0 }, zone), allDay: true, startDate: date, endDate: date, location: null, readOnly: true,
      });
    }
  }
  return out;
}

/**
 * The OverlayItems of overlays `ids` (visible ones when null) in [from, to) ms → items (a failing source is left out).
 */
async function items(gc, cfg, userId, ids, from, to, lang) {
  const all = await list(gc, cfg, userId, lang);
  const want = all.filter((o) => (ids ? ids.includes(o.id) : o.visible));
  if (!want.length) return [];
  const zone = await pimstore.zoneOf(gc, userId);
  const fromDate = tz.localDate(from, zone);
  const toDate = tz.localDate(to - 1, zone);
  const out = [];
  const inRange = (x) => x.end > from && x.start < to;
  if (want.some((o) => o.id === 'familie')) {
    for (const ym of months(fromDate, toDate)) { try { out.push(...(await familieMonth(gc, userId, ym)).filter(inRange)); } catch { /* Familie answers later */ } }
  }
  const subs = want.filter((o) => o.source === 'alltag').map((o) => Number(o.id.slice(7)));
  if (subs.length) {
    for (const ym of months(fromDate, toDate)) { try { out.push(...(await alltagMonth(gc, userId, ym, subs)).filter(inRange)); } catch { /* Alltag answers later */ } }
  }
  if (want.some((o) => o.id === 'birthdays')) out.push(...(await birthdays(gc, userId, fromDate, toDate, zone)));
  const seen = new Set();
  return out.filter((x) => (seen.has(x.key) ? false : seen.add(x.key))).sort((a, b) => a.start - b.start);
}

/** PATCH overlays/<id> { visible?, color? } → { overlay } */
async function patch(gc, cfg, userId, id, b, lang) {
  const all = await list(gc, cfg, userId, lang);
  const o = all.find((x) => x.id === id);
  if (!o) throw fail('not_found');
  const cur = await pimstore.calPrefs(gc, userId, cfg);
  const own = { ...cur.overlays };
  const x = { ...(own[id] || {}) };
  if (b.visible !== undefined) { if (typeof b.visible !== 'boolean') throw fail('invalid', { field: 'visible' }); x.visible = b.visible; }
  if (b.color !== undefined) { const c = pimstore.colorArg(b.color); if (!c) throw fail('invalid', { field: 'color' }); x.color = c; }
  own[id] = x;
  await pimstore.saveCalPrefs(gc, userId, cur.prefs, own, cur.setup);
  return { overlay: (await list(gc, cfg, userId, lang)).find((y) => y.id === id) };
}

function reset() { cache.clear(); subsCache.clear(); }

module.exports = { list, items, patch, familyOn, alltagOn, birthdays, months, reset, COLORS };
