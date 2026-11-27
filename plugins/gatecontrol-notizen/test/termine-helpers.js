'use strict';

// Stand-ins for the tests of „Termin“ (1.9.0): Mail 1.18.0 with its calendar services for the hub (calendar_list,
// calendar_add / calendar_update / calendar_delete with `items`), the calendars of a person and an event as Mail reports
// it to the hub (docs/notes-sources-contract.md § 6b).

const { fakeSource, item, ANNA } = require('./helpers');

const MAIL = 'gatecontrol-mail';
const HUB = 'gatecontrol-notizen';
const CALS = [
  { id: 7, key: 'cal:7', name: 'Privat', color: '#4F8DF5', kind: 'own', writable: true, isDefault: true, area: 'private', account: { label: 'GateControl', kind: 'local' } },
  { id: 8, key: 'cal:8', name: 'Firma', color: '#22AA55', kind: 'own', writable: true, isDefault: false, area: 'work', account: { label: 'GateControl', kind: 'local' } },
  { id: 9, key: 'cal:9', name: 'Feiertage', color: '#999999', kind: 'subscribed', writable: false, isDefault: false, area: 'private', account: { label: 'GateControl', kind: 'local' } },
  { id: 10, key: 'cal:10', name: 'Aufgaben', color: '#112233', kind: 'tasks', writable: true, isDefault: false, area: 'private', account: { label: 'GateControl', kind: 'local' } },
  { id: null, key: 'overlay:familie', name: 'Familie', color: '#F5B544', kind: 'family', writable: false, isDefault: false, area: 'private', account: { label: 'GateControl', kind: 'local' } },
];

/** An item as Mail reports an event (docs/notes-sources-contract.md § 6b). */
function eventItem(id, o = {}) {
  const cal = CALS.find((c) => c.key === (o.cal || 'cal:7'));
  return item(MAIL, id, {
    kind: 'event', title: o.title || 'Termin ' + id, subtitle: o.location || null, due: o.due || '2026-11-08', allDay: !/T/.test(o.due || '2026-11-08'), canComplete: false, area: cal.area,
    group: { id: cal.key, label: cal.name }, users: o.users || [ANNA.id],
    meta: { type: 'calendar', cal: cal.kind, color: cal.color, ...(o.location ? { location: o.location } : {}), ...(o.end ? { end: o.end } : {}), ...(o.endDate ? { endDate: o.endDate } : {}),
      ...(o.eventId ? { eventId: o.eventId } : {}), recurring: !!o.recurring, writable: cal.writable },
    open: { plugin: MAIL, route: o.eventId ? 'event/' + o.eventId : 'calendar/' + String(o.due || '2026-11-08').slice(0, 10) },
  });
}

/** Mail 1.18.0 as a stand-in: m.events (id → what calendar_add got), m.calls, m.reason (the person cannot use the calendars), m.old, m.down. */
function fakeMail() {
  const m = { events: new Map(), calls: [], reason: null, old: false, down: false, next: 500, calendars: CALS };
  const names = ['calendar_list', 'calendar_tasks', 'calendar_add', 'calendar_update', 'calendar_delete'];
  const provides = Object.fromEntries(names.map((s) => [s, { label: { de: 'x', en: 'x' }, maxPerHour: 3600 }]));
  const itemsOf = (ev) => [eventItem('ev:' + ev.id, { title: ev.title, due: ev.allDay ? ev.startsAt : new Date(ev.start).toISOString().replace('.000Z', '+00:00'), end: ev.allDay ? undefined : new Date(ev.end).toISOString().replace('.000Z', '+00:00'),
    endDate: ev.endsAt, location: ev.location, eventId: ev.id, cal: 'cal:' + ev.calendarId, users: [ev.user], recurring: !!ev.recurrence })];
  const service = async ({ name, caller, user, payload }) => {
    if (m.down) throw Object.assign(new Error('down'), { code: 'ERR_TIMEOUT' });
    m.calls.push({ name, user: user && user.id, payload });
    if (caller !== HUB || !user || payload.userId !== user.id) return { ok: false, code: 'forbidden' };
    if (name === 'calendar_list') {
      if (m.old) return { ok: false, code: 'forbidden' };
      if (m.reason) return { ok: true, calendars: [], reason: m.reason };
      return { ok: true, calendars: m.calendars, defaultId: (m.calendars.find((c) => c.isDefault) || {}).id || null, reminders: { timed: 15, allDay: 360 }, timeZone: 'Europe/Berlin' };
    }
    if (m.reason) return { ok: false, code: 'unavailable', reason: m.reason };
    if (name === 'calendar_add') {
      const calendarId = payload.calendarId == null ? 7 : payload.calendarId;
      if (!m.calendars.some((c) => c.id === calendarId && c.writable)) return { ok: false, code: 'not_found' };
      const have = [...m.events.values()].find((e) => e.user === user.id && e.key === payload.key);
      if (have) return { ok: true, eventId: have.id, calendarId: have.calendarId, items: itemsOf(have), replayed: true };
      if (payload.title === 'kaputt') return { ok: false, code: 'invalid' };
      const { userId, lang, items, ...rest } = payload;
      const ev = { ...rest, id: m.next++, user: user.id, calendarId };
      m.events.set(ev.id, ev);
      return m.old ? { ok: true, eventId: ev.id } : { ok: true, eventId: ev.id, calendarId, items: itemsOf(ev) };
    }
    const ev = m.events.get(payload.eventId);
    if (name === 'calendar_update') {
      if (!ev || ev.user !== user.id) return { ok: false, code: 'not_found' };
      const { userId, lang, items, eventId, ...rest } = payload;
      if (rest.allDay === true) { delete ev.start; delete ev.end; }
      if (rest.allDay === false) { delete ev.startsAt; delete ev.endsAt; }
      Object.assign(ev, rest);
      for (const k of ['location', 'recurrence']) if (ev[k] === null) delete ev[k];
      return { ok: true, eventId: ev.id, calendarId: ev.calendarId, items: itemsOf(ev) };
    }
    if (name === 'calendar_delete') {
      if (!ev || ev.user !== user.id) return { ok: true, removed: false };
      m.events.delete(ev.id);
      return { ok: true, removed: true };
    }
    return { ok: false, code: 'not_found' };
  };
  return { m, source: fakeSource(MAIL, { provides, service }) };
}


module.exports = { MAIL, HUB, CALS, eventItem, fakeMail };
