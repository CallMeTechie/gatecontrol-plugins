'use strict';

// Event reminders (C7): every background run (15 s) the occurrences whose reminder is due — start − minutes within [now −
// 10 min, now + 15 s]; all-day ones against midnight in the person's zone — in calendars with `notify`, for people with
// CalPrefs.reminders, not cancelled, not declined; each exactly once (reminders_sent). Older ones than 10 minutes are
// dropped. A push like mail (topic calendar_reminder): title = the event's title, text „14:00–15:00 · Raum 1“ („Morgen,
// ganztägig“); several of one person in the same minute → one push („3 Termine um 9:00“). Quiet hours and the topic
// switch are GateControl's.

const store = require('./store');
const config = require('./config');
const pimstore = require('./pimstore');
const push = require('./push');
const tz = require('./tz');
const { t } = require('./text');
const { parse, clip } = require('./util');

const LATE_MS = 10 * 60000;
const AHEAD_MS = 15000;
const LOOK_MS = 28 * 86400000 + 86400000;
const ROWS_MAX = 3000;
const KEEP_MS = 45 * 86400000;

let lastClean = 0;

/** The text of a reminder: „14:00–15:00 · Raum 1“, „Morgen, ganztägig“. */
function textOf(lang, o, zone, now) {
  const loc = lang === 'en' ? 'en-GB' : 'de-DE';
  if (o.allDay) {
    const d = tz.localDate(o.start, zone);
    const today = tz.localDate(now, zone);
    const day = d === today ? t(lang, 'push.reminder_today') : d === tz.addDays(today, 1) ? t(lang, 'push.reminder_tomorrow')
      : new Date(o.start).toLocaleDateString(loc, { timeZone: zone, weekday: 'short', day: 'numeric', month: 'numeric' });
    return t(lang, 'push.reminder_allday', { day }) + (o.location ? ` · ${o.location}` : '');
  }
  const h = (ms0) => new Date(ms0).toLocaleTimeString(loc, { timeZone: zone, hour: '2-digit', minute: '2-digit' });
  return `${h(o.start)}–${h(o.end)}${o.location ? ` · ${o.location}` : ''}`;
}

/** The due reminders of the occurrences → pushes. skipUsers: people whose Mail rests (licence, switched off). */
async function tick(gc, now = Date.now(), skipUsers = new Set()) {
  const cfg = await config.get(gc);
  if (!cfg.calendar.enabled) return 0;
  const rows = await store.all(gc, `SELECT o.event_id, o.occ, o.user_id, o.start, o.end, o.all_day, o.override_json, e.title, e.location, e.status, e.my_response,
      e.reminders_json, c.account_id
    FROM occurrences o JOIN events e ON e.id = o.event_id JOIN calendars c ON c.id = o.calendar_id
    WHERE c.notify = 1 AND o.start >= ? AND o.start <= ? ORDER BY o.start LIMIT ?`, [now - LATE_MS - 86400000, now + LOOK_MS, ROWS_MAX]);
  const due = new Map(); // user → [{ …, minutes }]
  const prefsOf = new Map();
  const accountsOn = new Map();
  for (const r of rows) {
    if (skipUsers.has(r.user_id)) continue;
    if (r.account_id) {
      if (!accountsOn.has(r.account_id)) {
        const a = await store.one(gc, 'SELECT calendar_sync FROM accounts WHERE id = ?', [r.account_id]);
        accountsOn.set(r.account_id, !!(a && a.calendar_sync !== 0 && cfg.calendar.accounts));
      }
      if (!accountsOn.get(r.account_id)) continue;
    }
    if (!prefsOf.has(r.user_id)) prefsOf.set(r.user_id, (await pimstore.calPrefs(gc, r.user_id, cfg)).prefs);
    const p = prefsOf.get(r.user_id);
    if (!p.reminders) continue;
    const ov = parse(r.override_json, null) || {};
    const status = ov.status || r.status;
    const mine = ov.myResponse !== undefined ? ov.myResponse : r.my_response;
    if (status === 'cancelled' || mine === 'declined') continue;
    const mins = ov.reminders || parse(r.reminders_json, []);
    const base = r.all_day ? pimstore.midnight(tz.localDate(r.start, p.timeZone), p.timeZone) : r.start;
    for (const m of mins) {
      const at = base - m * 60000;
      if (at < now - LATE_MS || at > now + AHEAD_MS) continue;
      if (!due.has(r.user_id)) due.set(r.user_id, []);
      due.get(r.user_id).push({ ...r, minutes: m, at, title: ov.title != null ? ov.title : r.title, location: ov.location !== undefined ? ov.location : r.location, zone: p.timeZone });
    }
  }
  let sent = 0;
  for (const [userId, list] of due) {
    // exactly once: what is marked here first is sent
    const fresh = [];
    for (const x of list) {
      const r = await store.run(gc, 'INSERT OR IGNORE INTO reminders_sent (event_id, occ, minutes, at) VALUES (?, ?, ?, ?)', [x.event_id, x.occ, x.minutes, now]);
      if (r.changes) fresh.push(x);
    }
    if (!fresh.length) continue;
    const lang = await push.langOf(gc, userId);
    // by minute: one push per minute with more than one
    const byMinute = new Map();
    for (const x of fresh) { const k = Math.floor(x.at / 60000); if (!byMinute.has(k)) byMinute.set(k, []); byMinute.get(k).push(x); }
    for (const group of byMinute.values()) {
      const one = group.length === 1;
      const x = group[0];
      const o = { allDay: x.all_day === 1, start: x.start, end: x.end, location: x.location };
      const time = new Date(x.start).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'de-DE', { timeZone: x.zone, hour: '2-digit', minute: '2-digit' });
      try {
        await gc.notify({
          topic: 'calendar_reminder', users: [userId], collapseKey: one ? `cal:${x.event_id}:${x.occ}` : `cal:many:${Math.floor(x.at / 60000)}`,
          title: clip(one ? (x.title || '…') : t(lang, 'push.reminders_many', { count: group.length, time }), 120),
          body: clip(one ? textOf(lang, o, x.zone, now) : group.map((g) => g.title).join('\n'), 1000),
          data: { calendar: { eventId: x.event_id, occurrence: x.occ || null }, ...(one && x.location ? { facts: [{ label: t(lang, 'push.place'), value: clip(x.location, 120) }] } : {}) },
        });
        sent += group.length;
      } catch (e) { gc.log.warn('reminder push failed', (e && e.code) || 'error'); }
    }
  }
  if (now - lastClean > 3600000) {
    lastClean = now;
    await store.run(gc, 'DELETE FROM reminders_sent WHERE at < ?', [now - KEEP_MS]);
  }
  return sent;
}

module.exports = { tick, textOf };
