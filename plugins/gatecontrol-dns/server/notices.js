'use strict';

// Notices through GateControl's notification center (plugin.json notifyTopics):
//   outage     the filter fell back / answers again → every administrator (switch "Bei Ausfall des Filters"); with the
//              switch "Auch Benutzer benachrichtigen" also everybody else whose VPN device is filtered
//   pause_end  a suspension for a device or a person ran out → that person
//   weekly     Mondays: queries, blocked and the top domains of the last seven days → every administrator (switch
//              "Wochenbericht")
// The events come from gc.vpnDns.on (registered in start); they are not replayed after a restart.

const config = require('./config');
const { percent } = require('./util');

const WEEKLY_FROM_HOUR = 7;
const langOf = (u) => (u && u.lang === 'en' ? 'en' : 'de');

async function admins(gc) {
  try { return ((await gc.users.list()) || []).filter((u) => u.role === 'admin'); } catch { return []; }
}

/** The administrators by language: [[lang, [userId]]] — one notice (and one activity entry) per language. */
async function adminsByLang(gc) {
  const by = new Map();
  for (const u of await admins(gc)) { const l = langOf(u); if (!by.has(l)) by.set(l, []); by.get(l).push(u.id); }
  return [...by.entries()];
}

/** Everybody but the administrators whose VPN device is filtered, by language (the notice "Filter ausgefallen" for users). */
async function filteredUsersByLang(gc) {
  const by = new Map();
  let devices = [];
  let users = [];
  try { devices = (await gc.vpnDns.devices()) || []; users = (await gc.users.list()) || []; } catch { return []; }
  const ids = new Set(devices.filter((d) => d.type === 'peer' && d.state === 'filtered' && d.user && d.user.role !== 'admin').map((d) => d.user.id));
  for (const u of users) { if (!ids.has(u.id) || u.role === 'admin' || u.disabled === true || u.enabled === false) continue; const l = langOf(u); if (!by.has(l)) by.set(l, []); by.get(l).push(u.id); }
  return [...by.entries()];
}

const num = (n, lang) => Number(n || 0).toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE');
const clock = (iso, lang) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(lang === 'en' ? 'en-GB' : 'de-DE', { hour: '2-digit', minute: '2-digit' }); };

async function send(gc, n) {
  if (typeof gc.notify !== 'function') return false;
  try { await gc.notify(n); return true; } catch (e) { gc.log.debug('notice not sent', n.topic, (e && e.code) || 'error'); return false; }
}

/** One event of gc.vpnDns.on. */
async function onEvent(gc, t, ev) {
  if (!ev || typeof ev.type !== 'string') return;
  if (ev.type === 'fallback' || ev.type === 'restored') {
    const cfg = await config.load(gc);
    if (!cfg.notify.outage) return;
    const down = ev.type === 'fallback';
    for (const [lang, users] of await adminsByLang(gc)) {
      await send(gc, {
        topic: 'outage', users, collapseKey: 'dns-outage', priority: down ? 'high' : 'normal',
        title: t(lang, down ? 'notify.outage_title' : 'notify.restored_title'),
        body: t(lang, down ? 'notify.outage_body' : 'notify.restored_body', { time: clock(ev.at, lang) }),
      });
    }
    if (cfg.notify.outageUsers) {
      for (const [lang, users] of await filteredUsersByLang(gc)) {
        await send(gc, {
          topic: 'outage', users, collapseKey: 'dns-outage', priority: 'normal',
          title: t(lang, down ? 'notify.outage_title' : 'notify.restored_title'),
          body: t(lang, down ? 'notify.outage_user_body' : 'notify.restored_user_body', { time: clock(ev.at, lang) }),
        });
      }
    }
    return;
  }
  if (ev.type === 'resumed' && ev.reason === 'expired' && (ev.scope === 'peer' || ev.scope === 'user')) {
    let userId = ev.scope === 'user' ? ev.id : null;
    let device = null;
    if (ev.scope === 'peer') {
      try { device = ((await gc.vpnDns.devices()) || []).find((d) => d.peerId === ev.id) || null; } catch { device = null; }
      userId = device && device.user ? device.user.id : null;
    }
    if (!userId) return;
    let u = null;
    try { u = await gc.users.get(userId); } catch { u = null; }
    const lang = langOf(u);
    await send(gc, {
      topic: 'pause_end', users: [userId], collapseKey: `dns-pause-${ev.scope}-${ev.id}`, priority: 'info', ttl: 3600,
      title: t(lang, 'notify.pause_end_title'),
      body: device ? t(lang, 'notify.pause_end_device', { device: device.name }) : t(lang, 'notify.pause_end_body'),
    });
  }
}

/** The Monday (local date key) of the week `now` lies in. */
function mondayKey(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The weekly report: once per week, on Monday from 7 o'clock (or later in the week when the server was off). */
async function weekly(gc, t, now = Date.now()) {
  const cfg = await config.load(gc);
  if (!cfg.notify.weekly || !gc.vpnDns) return false;
  const d = new Date(now);
  const key = mondayKey(now);
  if (d.getDay() === 1 && d.getHours() < WEEKLY_FROM_HOUR) return false;
  const state = await config.loadState(gc);
  if (state.weekly === key) return false;
  // the first run only remembers the week: no report about a week the plugin did not see
  if (!state.weekly) { await config.saveState(gc, { ...state, weekly: key }); return false; }
  const st = await gc.vpnDns.status();
  if (!st.enabled) return false;
  const stats = await gc.vpnDns.stats({ days: 8 });
  const days = (stats.days || []).filter((x) => x.day < key).slice(-7);
  const queries = days.reduce((n, x) => n + x.queries, 0);
  const blocked = days.reduce((n, x) => n + x.blocked, 0);
  await config.saveState(gc, { ...state, weekly: key });
  if (!queries) return false;
  for (const [lang, users] of await adminsByLang(gc)) {
    const top = (stats.top || []).slice(0, 3).map((x) => x.domain).join(', ');
    await send(gc, {
      topic: 'weekly', users, collapseKey: 'dns-weekly', priority: 'info',
      title: t(lang, 'notify.weekly_title'),
      body: t(lang, top ? 'notify.weekly_body_top' : 'notify.weekly_body', { queries: num(queries, lang), blocked: num(blocked, lang), percent: String(percent(blocked, queries)).replace('.', lang === 'en' ? '.' : ','), top }),
      data: { facts: [{ label: t(lang, 'notify.fact_queries'), value: num(queries, lang) }, { label: t(lang, 'notify.fact_blocked'), value: num(blocked, lang) }] },
    });
  }
  return true;
}

module.exports = { onEvent, weekly, mondayKey };
