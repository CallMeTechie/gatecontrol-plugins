/* Mail (gatecontrol-mail) — the plain logic of the calendar and the contacts in the portal tab (since 1.3.0):
 * window.MailPimLogic in the page, module.exports in the tests (test/portal-pim.test.js). No DOM here.
 *
 *   days        local dates 'YYYY-MM-DD' (the browser's zone — the portal sets the person's zone to it), adding days,
 *               the range of a view (day, week or work week, month as 6 weeks, list)
 *   layout      the events of a day in columns (overlapping ones beside each other), the all-day ones of a day
 *   texts       the repetition in words, reminders, a birthday with the age, "3 von 5 zugesagt"
 *   forms       an event's form ↔ the API (recurrence, the changed fields only — a PATCH sends what changed)
 *   groups      the calendars grouped (GateControl, per account, Eingeblendet)
 */
(function (root) {
  'use strict';

  var DAY = 86400000;
  var WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  /** A Date → its local date 'YYYY-MM-DD'. */
  function ymd(d) { var x = d instanceof Date ? d : new Date(d); return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()); }
  /** 'YYYY-MM-DD' → local midnight (a Date). */
  function dateOf(s) { var p = String(s).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
  function midnight(s) { return dateOf(s).getTime(); }
  function addDays(s, n) { var d = dateOf(s); d.setDate(d.getDate() + n); return ymd(d); }
  function addMonths(s, n) { var d = dateOf(s); var day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n); var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); d.setDate(Math.min(day, last)); return ymd(d); }
  function weekday(s) { return dateOf(s).getDay(); }
  /** The first day of the week of `s` (weekStart 1 = Monday, 0 = Sunday). */
  function weekStartOf(s, weekStart) { var w = weekday(s); var back = (w - (weekStart === 0 ? 0 : 1) + 7) % 7; return addDays(s, -back); }
  /** 'HH:MM' of a time (local). */
  function hhmm(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  /** A local date and 'HH:MM' → ms. */
  function at(dateStr, time) { var d = dateOf(dateStr); var t = String(time || '00:00').split(':'); d.setHours(Number(t[0]) || 0, Number(t[1]) || 0, 0, 0); return d.getTime(); }

  /**
   * The days and the range of a view: view 'day' | 'week' | 'month' | 'list' around `anchor` ('YYYY-MM-DD').
   * → { days: ['YYYY-MM-DD'], from, to (ms, to exclusive), month (the month shown: 'YYYY-MM') }
   */
  function rangeOf(view, anchor, o) {
    var x = o || {};
    var days = [];
    var first;
    var n;
    if (view === 'day') { first = anchor; n = 1; } else if (view === 'week') {
      first = weekStartOf(anchor, x.weekStart);
      n = 7;
      if (x.workWeek) { var w = weekday(first); if (w === 0) first = addDays(first, 1); n = 5; }
    } else if (view === 'month') {
      first = weekStartOf(anchor.slice(0, 8) + '01', x.weekStart);
      n = 42;
    } else { first = anchor; n = x.listDays || 30; }
    for (var i = 0; i < n; i++) days.push(addDays(first, i));
    return { days: days, from: midnight(days[0]), to: midnight(addDays(days[days.length - 1], 1)), month: anchor.slice(0, 7) };
  }

  /** Is an item (Occurrence or OverlayItem) on local day `s`? */
  function onDay(it, s) {
    if (it.allDay && it.startDate) return it.startDate <= s && (it.endDate || it.startDate) >= s;
    var from = midnight(s);
    var to = midnight(addDays(s, 1));
    return it.start < to && (it.end > from || (it.end === it.start && it.start >= from));
  }
  /** Does an item fill whole days (all-day, or 24 h and more)? */
  function wholeDay(it) { return !!it.allDay || (it.end - it.start >= DAY); }

  /**
   * The timed items of day `s` in columns: → [{ item, top, height (minutes from midnight), col, cols }]. Overlapping
   * items form a cluster; each gets the first free column, all of a cluster share the number of columns.
   */
  function layoutDay(items, s) {
    var from = midnight(s);
    var to = midnight(addDays(s, 1));
    var list = items.filter(function (it) { return !wholeDay(it) && onDay(it, s); }).map(function (it) {
      var a = Math.max(it.start, from);
      var b = Math.min(Math.max(it.end, it.start + 15 * 60000), to);
      return { item: it, a: a, b: b, top: Math.round((a - from) / 60000), height: Math.max(15, Math.round((b - a) / 60000)), col: 0, cols: 1 };
    }).sort(function (p, q) { return p.a - q.a || (q.b - q.a) - (p.b - p.a); });
    var out = [];
    var cluster = [];
    var colsEnd = [];
    var clusterEnd = -1;
    function close() {
      var n = colsEnd.length || 1;
      cluster.forEach(function (x) { x.cols = n; });
      cluster = [];
      colsEnd = [];
    }
    list.forEach(function (x) {
      // the shown height counts (a 5-minute event takes 15 minutes of room)
      var end = x.a + x.height * 60000;
      if (cluster.length && x.a >= clusterEnd) close();
      if (!cluster.length) clusterEnd = -1;
      var c = 0;
      while (c < colsEnd.length && colsEnd[c] > x.a) c++;
      colsEnd[c] = end;
      x.col = c;
      cluster.push(x);
      out.push(x);
      clusterEnd = Math.max(clusterEnd, end);
    });
    close();
    return out.map(function (x) { return { item: x.item, top: x.top, height: x.height, col: x.col, cols: x.cols }; });
  }

  /** The all-day (or whole-day) items of day `s`. */
  function allDayOn(items, s) { return items.filter(function (it) { return wholeDay(it) && onDay(it, s); }); }

  /** The items of the list view grouped by day (only days with items) → [{ day, items }]. */
  function agenda(items, days) {
    var out = [];
    days.forEach(function (s) {
      var x = items.filter(function (it) { return onDay(it, s); }).sort(function (p, q) { return (wholeDay(q) ? 1 : 0) - (wholeDay(p) ? 1 : 0) || p.start - q.start; });
      if (x.length) out.push({ day: s, items: x });
    });
    return out;
  }

  // ── texts ──────────────────────────────────────────

  function T0(T, k, p) { return T ? T(k, p) : k; }

  /** A reminder in words ("15 Minuten vorher", "1 Tag vorher", "Zu Beginn"). */
  function reminderText(min, T) {
    if (min == null) return T0(T, 'p.c.rem_none');
    if (min === 0) return T0(T, 'p.c.rem_at');
    if (min % 1440 === 0) return T0(T, min === 1440 ? 'p.c.rem_day' : 'p.c.rem_days', { n: min / 1440 });
    if (min % 60 === 0) return T0(T, min === 60 ? 'p.c.rem_hour' : 'p.c.rem_hours', { n: min / 60 });
    return T0(T, 'p.c.rem_min', { n: min });
  }

  /** The repetition of an event in words (Recurrence of the API, or the form's). */
  function recurrenceText(r, T, lang) {
    if (!r || !r.freq) return '';
    var n = Number(r.interval) || 1;
    var f = r.freq;
    var base = n > 1 ? T0(T, 'p.c.every_' + f, { n: n }) : T0(T, 'p.c.freq_' + f);
    var parts = [base];
    var names = (r.byDay || []).map(function (d) { return T0(T, 'p.c.wd_' + String(d).replace(/^[+-]?\d+/, '')); });
    if (r.bySetPos && names.length) parts.push(T0(T, 'p.c.on_nth', { n: r.bySetPos === -1 ? T0(T, 'p.c.last') : r.bySetPos + '.', day: names[0] }));
    else if (names.length) parts.push(names.join(', '));
    else if (r.byMonthDay && r.byMonthDay.length && f === 'monthly') parts.push(T0(T, 'p.c.on_day', { n: r.byMonthDay.join(', ') }));
    var s = parts.join(' · ');
    if (r.until) s += ' · ' + T0(T, 'p.c.until', { date: dateOf(r.until).toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE') });
    else if (r.count) s += ' · ' + T0(T, 'p.c.times', { n: r.count });
    return s;
  }

  /** A birthday ('YYYY-MM-DD' or '--MM-DD') → { text, age } — "14. März 1981 · wird 46". */
  function birthdayText(b, lang, today) {
    if (!b) return null;
    var m = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(b);
    if (!m) return null;
    var year = m[1] === '-' ? null : Number(m[1]);
    var d = new Date(year || 2000, Number(m[2]) - 1, Number(m[3]));
    var text = d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE', year ? { day: 'numeric', month: 'long', year: 'numeric' } : { day: 'numeric', month: 'long' });
    var now = today ? dateOf(today) : new Date();
    var next = null;
    if (year) {
      var age = now.getFullYear() - year;
      var thisYear = new Date(now.getFullYear(), Number(m[2]) - 1, Number(m[3]));
      next = thisYear >= new Date(now.getFullYear(), now.getMonth(), now.getDate()) ? age : age + 1;
    }
    return { text: text, turns: next };
  }

  /** Accepted of all (organizer not counted): { yes, all }. */
  function countOf(counts) {
    var c = counts || {};
    var all = (c.accepted || 0) + (c.tentative || 0) + (c.declined || 0) + (c.needs_action || 0);
    return { yes: c.accepted || 0, all: all };
  }

  // ── the event form ─────────────────────────────────

  /** The form's choice of repetition from a Recurrence (null: never). */
  function repeatOf(r, startDate) {
    if (!r || !r.freq) return { kind: 'none', interval: 1, byDay: [], end: 'never', until: '', count: 10 };
    var kind = r.freq;
    if (r.freq === 'monthly') kind = r.bySetPos ? 'monthly_nth' : 'monthly_day';
    return {
      kind: kind, interval: Number(r.interval) || 1, byDay: (r.byDay || []).map(function (d) { return String(d).replace(/^[+-]?\d+/, ''); }),
      end: r.until ? 'until' : r.count ? 'count' : 'never', until: r.until || '', count: r.count || 10, startDate: startDate,
    };
  }

  /** The n-th weekday of a date: { pos: 1…4, or -1 for a fifth (the last), day: 'MO' }. */
  function nthOf(s) {
    var d = dateOf(s);
    var pos = Math.ceil(d.getDate() / 7);
    return { pos: pos > 4 ? -1 : pos, day: WEEKDAYS[d.getDay()] };
  }

  /** The form's repetition → the API's recurrence ({ freq, interval, byDay, byMonthDay, bySetPos, until, count }) or null. */
  function recurrenceOf(rep, startDate) {
    if (!rep || rep.kind === 'none') return null;
    var out = { freq: rep.kind === 'monthly_day' || rep.kind === 'monthly_nth' ? 'monthly' : rep.kind, interval: Math.max(1, Math.min(999, Number(rep.interval) || 1)), byDay: null, byMonthDay: null, bySetPos: null, until: null, count: null };
    if (rep.kind === 'weekly') out.byDay = rep.byDay && rep.byDay.length ? rep.byDay.slice() : [WEEKDAYS[weekday(startDate)]];
    if (rep.kind === 'monthly_day') out.byMonthDay = [dateOf(startDate).getDate()];
    if (rep.kind === 'monthly_nth') { var n = nthOf(startDate); out.byDay = [n.day]; out.bySetPos = n.pos; }
    if (rep.end === 'until' && rep.until) out.until = rep.until;
    if (rep.end === 'count') out.count = Math.max(1, Math.min(1000, Number(rep.count) || 1));
    return out;
  }

  function sameRecurrence(a, b) {
    var norm = function (r) {
      if (!r || !r.freq) return null;
      return JSON.stringify([r.freq, Number(r.interval) || 1, (r.byDay || []).map(function (d) { return String(d).replace(/^[+-]?\d+/, ''); }).sort(), r.byMonthDay || null, r.bySetPos || null, r.until || null, r.count || null]);
    };
    return norm(a) === norm(b);
  }
  function sameList(a, b, key) {
    var x = (a || []).map(key);
    var y = (b || []).map(key);
    return x.length === y.length && x.every(function (v, i) { return v === y[i]; });
  }

  /**
   * The fields of POST / PATCH events from form values `f` — for a PATCH (`orig`: the Event) only what changed (time
   * and place mean new invitations to everybody, so nothing unchanged is sent).
   * f = { title, calendarId, allDay, startDate, startTime, endDate, endTime, timeZone, location, description, reminders,
   *       repeat, online: { kind: 'none'|'teams'|'link', url }, attendees: [{ email, name, role }], busy, private }
   */
  function eventFields(f, orig, o) {
    var x = o || {};
    var out = {};
    var allDay = !!f.allDay;
    var time = allDay ? { allDay: true, startDate: f.startDate, endDate: f.endDate < f.startDate ? f.startDate : f.endDate }
      : { allDay: false, start: at(f.startDate, f.startTime), end: at(f.endDate, f.endTime) };
    if (!allDay && time.end < time.start) time.end = time.start;
    var put = function (k, v) { out[k] = v; };
    if (!orig) {
      put('calendarId', f.calendarId);
      put('title', f.title);
      Object.keys(time).forEach(function (k) { put(k, time[k]); });
      if (f.timeZone) put('timeZone', f.timeZone);
      if (f.location) put('location', f.location);
      if (f.description) put('description', f.description);
      put('reminders', f.reminders || []);
      var rec = recurrenceOf(f.repeat, f.startDate);
      if (rec) put('recurrence', rec);
      if (f.online && f.online.kind === 'teams') put('online', { create: 'teams' });
      else if (f.online && f.online.kind === 'link' && f.online.url) put('online', { url: f.online.url });
      if (f.attendees && f.attendees.length) put('attendees', f.attendees);
      if (f.busy && f.busy !== 'busy') put('busy', f.busy);
      if (f.private) put('private', true);
      return out;
    }
    if (f.title !== orig.title) put('title', f.title);
    var timeChanged = allDay !== !!orig.allDay || (allDay ? (time.startDate !== orig.startDate || time.endDate !== orig.endDate) : (time.start !== orig.start || time.end !== orig.end));
    if (timeChanged) Object.keys(time).forEach(function (k) { put(k, time[k]); });
    if (f.timeZone && f.timeZone !== orig.timeZone) put('timeZone', f.timeZone);
    if ((f.location || null) !== (orig.location || null)) put('location', f.location || null);
    if ((f.description || '') !== (orig.description || '')) put('description', f.description || '');
    if (!sameList(f.reminders, orig.reminders, String)) put('reminders', f.reminders || []);
    if (!x.occurrence && f.repeat && f.repeat.touched) {
      var r = recurrenceOf(f.repeat, f.startDate);
      if (!sameRecurrence(r, orig.recurrence)) put('recurrence', r);
    }
    var was = orig.online ? 'link' : 'none';
    if (f.online && f.online.kind === 'teams' && !(orig.online && orig.online.provider === 'teams')) put('online', { create: 'teams' });
    else if (f.online && f.online.kind === 'link' && f.online.url && (!orig.online || orig.online.url !== f.online.url)) put('online', { url: f.online.url });
    else if (f.online && f.online.kind === 'none' && was !== 'none') put('online', null);
    if (!sameList(f.attendees, orig.attendees, function (a) { return a.email + '|' + (a.role || 'required'); })) put('attendees', f.attendees || []);
    if ((f.busy || 'busy') !== (orig.busy || 'busy')) put('busy', f.busy || 'busy');
    if (!!f.private !== !!orig.private) put('private', !!f.private);
    return out;
  }

  // ── calendars and books ────────────────────────────

  /**
   * The calendars in the menu's groups: GateControl (own ones and subscriptions of no account), each account, the
   * overlays → [{ key, account | null, items: [{ kind: 'calendar'|'overlay', it }] }].
   */
  function calendarGroups(calendars, overlays, accounts) {
    var out = [{ key: 'gc', account: null, items: [] }];
    var byAcc = {};
    (calendars || []).forEach(function (c) {
      if (!c.accountId) { out[0].items.push({ kind: 'calendar', it: c }); return; }
      if (!byAcc[c.accountId]) {
        var a = (accounts || []).filter(function (x) { return x.id === c.accountId; })[0] || { id: c.accountId, email: '' };
        byAcc[c.accountId] = { key: 'acc:' + c.accountId, account: a, items: [] };
        out.push(byAcc[c.accountId]);
      }
      byAcc[c.accountId].items.push({ kind: 'calendar', it: c });
    });
    if ((overlays || []).length) out.push({ key: 'overlays', account: null, items: overlays.map(function (o) { return { kind: 'overlay', it: o }; }) });
    return out.filter(function (g) { return g.items.length; });
  }

  /** The letters present in a list of CardSummaries, in order. */
  function letters(items) {
    var seen = {};
    var out = [];
    (items || []).forEach(function (c) { var l = c.letter || '#'; if (!seen[l]) { seen[l] = true; out.push(l); } });
    return out;
  }

  /** "Name <adresse>, …" of a text field → [{ email, name }] (whatever has no address is left out). */
  function addressesOf(text) {
    return String(text || '').split(/[,;\n]/).map(function (s) {
      var t = s.trim();
      if (!t) return null;
      var m = /^(.*)<([^<>@\s]+@[^<>\s]+)>$/.exec(t);
      if (m) return { email: m[2].trim().toLowerCase(), name: m[1].trim().replace(/^"|"$/g, '') };
      return /^[^\s@<>]+@[^\s@<>]+$/.test(t) ? { email: t.toLowerCase(), name: '' } : null;
    }).filter(Boolean);
  }

  var api = {
    DAY: DAY, WEEKDAYS: WEEKDAYS, ymd: ymd, dateOf: dateOf, midnight: midnight, addDays: addDays, addMonths: addMonths, weekday: weekday, weekStartOf: weekStartOf,
    hhmm: hhmm, at: at, rangeOf: rangeOf, onDay: onDay, wholeDay: wholeDay, layoutDay: layoutDay, allDayOn: allDayOn, agenda: agenda,
    reminderText: reminderText, recurrenceText: recurrenceText, birthdayText: birthdayText, countOf: countOf,
    repeatOf: repeatOf, nthOf: nthOf, recurrenceOf: recurrenceOf, eventFields: eventFields, calendarGroups: calendarGroups, letters: letters, addressesOf: addressesOf,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MailPimLogic = api;
})(typeof window !== 'undefined' ? window : this);
