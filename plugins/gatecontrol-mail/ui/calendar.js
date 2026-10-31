/* Mail (gatecontrol-mail) — the area Kalender of the portal tab (since 1.3.0, mockups Kalender, Einladung, MenueNeu):
 * window.MailCalendar.attach(ui) → { nav, show, onEvent, openEvent, invitationCard, newEvent }.
 *
 *   menu      the calendars with a tick (shown) and their colour — GateControl, each account, Eingeblendet (Familie,
 *             Alltag, Geburtstage, only to look at) —, their state (sync, error, „Neu anmelden“), per calendar colour,
 *             reminders on/off, rename and delete (own ones); „Kalender hinzufügen“, „iCal-Abo“
 *   view      Tag / Woche (work week) / Monat / Liste with „Heute“ and ‹ ›, the chips of the shown calendars, the all-day
 *             row, hours 0–24 (scrolled to 7:00), overlapping events beside each other, open invitations dashed,
 *             cancelled ones struck through, the now line; a click on free time → a new event at that hour
 *   event     looking at it (time with its zone, repetition, calendar, place, online link, reminders, attendees with
 *             their answers, description), answering it, editing it (series: „Nur dieser Termin“ / „Alle Termine der
 *             Serie“; only what changed is sent), deleting it; 409 conflict → „Neu laden“ / „Meine Änderung erneut anwenden“
 *   card      the invitation in a mail: time, place, the day around it with conflicts, Zusagen / Mit Vorbehalt /
 *             Absagen with a comment, „Neue Zeit vorschlagen“, „Eintragen in“, the attendees; cancelled, answered,
 *             replies, counter proposals, outdated; Microsoft without the calendar right: „Kalender freigeben“
 *
 * Times are shown in the browser's zone; the person's zone (prefs.timeZone) is set to it on opening, like the apps do.
 */
(function () {
  'use strict';

  var HOUR = 44; // px of an hour in the day and week view
  var SCOPE = 'Calendars.ReadWrite';
  var REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];

  function attach(ui) {
    var T = ui.T; var h = ui.h; var add = ui.add; var clear = ui.clear; var icon = ui.icon; var btn = ui.btn; var ibtn = ui.ibtn;
    var api = ui.api; var L = ui.L; var S = ui.S; var CTX = ui.CTX; var LOCALE = ui.LOCALE;
    var $ = function (id) { return document.getElementById(id); };
    var C = {
      loaded: false, loading: null, calendars: [], overlays: [], prefs: null, consent: [], view: null, anchor: L.ymd(new Date()),
      items: [], overlayItems: [], pending: [], listDays: 30, seq: 0,
    };

    function deviceZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; } }
    function calOf(id) { for (var i = 0; i < C.calendars.length; i++) if (C.calendars[i].id === id) return C.calendars[i]; return null; }
    function overlayOf(id) { for (var i = 0; i < C.overlays.length; i++) if (C.overlays[i].id === id) return C.overlays[i]; return null; }
    function colorOf(it) {
      if (it.overlayId) { var o = overlayOf(it.overlayId); return o ? o.color : '#8C96A5'; }
      var c = calOf(it.calendarId);
      return c ? c.color : '#8C96A5';
    }
    function calName(c) {
      if (!c) return '';
      var a = c.accountId ? ui.accountOf(c.accountId) : null;
      return a ? c.name + ' · ' + (a.name || a.email) : c.name;
    }
    function fail(e) { ui.toast(ui.errText(e), 'error'); }

    // ── loading ──────────────────────────────────────────

    function load() {
      if (C.loading) return C.loading;
      C.loading = api('GET', 'calendars').then(function (r) {
        C.calendars = r.calendars || [];
        C.overlays = r.overlays || [];
        C.prefs = r.prefs || {};
        C.consent = r.consent || [];
        C.loaded = true;
        if (!C.view) C.view = C.prefs.view === 'day' || C.prefs.view === 'month' || C.prefs.view === 'list' ? C.prefs.view : 'week';
        C.workWeek = !!C.prefs.workWeek;
        // the person's zone follows the browser's, like the apps (reminders and all-day events use it)
        var z = deviceZone();
        if (z && C.prefs.timeZone && z !== C.prefs.timeZone) api('PUT', 'calendar/settings', { timeZone: z }).then(function (x) { C.prefs = x.prefs; }, function () {});
      }).then(function () { C.loading = null; }, function (e) { C.loading = null; throw e; });
      return C.loading;
    }

    function fetchRange() {
      var r = range();
      var seq = ++C.seq;
      return api('GET', 'events', null, { from: r.from, to: r.to }).then(function (x) {
        if (seq !== C.seq) return;
        C.items = x.items || [];
        C.overlayItems = (x.overlays || []).map(function (o) { return Object.assign({}, o, { readOnly: true }); });
        C.pending = x.pending || [];
        renderHead();
        renderView();
      }, function (e) { if (seq === C.seq) { renderView(); fail(e); } });
    }

    function range() { return L.rangeOf(C.view, C.anchor, { weekStart: C.prefs ? C.prefs.weekStart : 1, workWeek: C.workWeek, listDays: C.listDays }); }

    // ── the menu ─────────────────────────────────────────

    function tick(color, on) {
      return h('span', { class: 'mc-ck', style: on ? 'background:' + color + ';border-color:' + color : 'border-color:' + color }, on ? icon('check', 12) : null);
    }
    function stateNote(c) {
      if (!c || c.source === 'local') return null;
      if (c.state === 'consent_required') return h('span', { class: 'mp-warn', text: T('p.relogin') });
      if (c.state === 'auth_failed' || c.state === 'unreachable') return h('span', { class: 'mp-warn', text: '!', attrs: { title: T('p.side_' + c.state) } });
      if (c.state === 'syncing') return h('span', { class: 'mp-sub', text: '…', attrs: { title: T('p.side_syncing') } });
      return null;
    }

    function nav(el) {
      el.appendChild(ui.toMailRow());
      if (!C.loaded) {
        el.appendChild(h('p', { class: 'dp-hint', style: 'padding:10px', text: T('p.loading') }));
        load().then(ui.renderNav, fail);
        return;
      }
      L.calendarGroups(C.calendars, C.overlays, S.accounts).forEach(function (g) {
        var label = g.key === 'gc' ? T('p.c.group_gc') : g.key === 'overlays' ? T('p.c.group_overlays') : ui.accountLabel(g.account);
        el.appendChild(h('div', { class: 'mp-lab', text: label }));
        g.items.forEach(function (x) {
          var it = x.it;
          var c = x.kind === 'calendar' ? it : null;
          var row = h('div', { class: 'mc-navrow' }, [
            h('button', { type: 'button', class: 'mp-row', attrs: { 'aria-pressed': it.visible ? 'true' : 'false' }, on: { click: function () { setVisible(x.kind, it, !it.visible); } } },
              [tick(it.color, it.visible), h('span', { class: 'mp-tx', text: it.name }), c && c.isDefault ? h('span', { class: 'mp-sub', text: T('p.c.default') }) : null, stateNote(c)]),
            ibtn('more', T('p.c.calendar_menu', { name: it.name }), function () { calendarMenu(x.kind, it); }, 'mc-more'),
          ]);
          row.addEventListener('contextmenu', function (ev) { if (ev.preventDefault) ev.preventDefault(); calendarMenu(x.kind, it); });
          el.appendChild(row);
        });
      });
      el.appendChild(h('button', { type: 'button', class: 'mp-row is-accent', on: { click: addCalendar } }, [icon('plus'), h('span', { class: 'mp-tx', text: T('p.c.add_calendar') })]));
      el.appendChild(h('button', { type: 'button', class: 'mp-row is-accent', on: { click: subscribe } }, [icon('link'), h('span', { class: 'mp-tx', text: T('p.c.subscribe') })]));
    }

    function setVisible(kind, it, on) {
      var path = kind === 'overlay' ? 'overlays/' + encodeURIComponent(it.id) : 'calendars/' + it.id;
      it.visible = on;
      ui.renderNav();
      if (S.area === 'calendar') renderHead();
      api('PATCH', path, { visible: on }).then(function (r) {
        var x = r.calendar || r.overlay;
        if (x) Object.assign(it, x);
        ui.renderNav();
        if (S.area === 'calendar') { renderHead(); fetchRange(); }
      }, function (e) { it.visible = !on; ui.renderNav(); fail(e); });
    }

    function calendarMenu(kind, it) {
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var color = h('input', { class: 'dp-input', type: 'color', value: it.color, style: 'width:64px;padding:2px', attrs: { 'aria-label': T('p.c.color') } });
      var c = kind === 'calendar' ? it : null;
      var local = c && c.source === 'local';
      var name = local ? h('input', { class: 'dp-input', type: 'text', value: it.name }) : null;
      var notify = c ? h('input', { type: 'checkbox', class: 'dp-sw', checked: c.notify }) : null;
      var save = function () {
        var b = {};
        if (color.value.toUpperCase() !== String(it.color).toUpperCase()) b.color = color.value.toUpperCase();
        if (name && name.value.trim() && name.value.trim() !== it.name) b.name = name.value.trim();
        if (notify && notify.checked !== c.notify) b.notify = notify.checked;
        if (!Object.keys(b).length) { ui.closeDialog(); return; }
        api('PATCH', (kind === 'overlay' ? 'overlays/' + encodeURIComponent(it.id) : 'calendars/' + it.id), b).then(function (r) {
          Object.assign(it, r.calendar || r.overlay || {});
          ui.closeDialog();
          ui.toast(T('p.saved'));
          ui.renderNav();
          if (S.area === 'calendar') { renderHead(); renderView(); }
        }, function (e) { err.textContent = ui.errText(e); });
      };
      var remove = function () {
        if (!window.confirm(T('p.c.delete_calendar_q', { name: it.name }))) return;
        api('DELETE', 'calendars/' + it.id).then(function () {
          ui.closeDialog();
          C.calendars = C.calendars.filter(function (x) { return x.id !== it.id; });
          ui.renderNav();
          if (S.area === 'calendar') { renderHead(); fetchRange(); }
        }, function (e) { err.textContent = ui.errText(e); });
      };
      var acc = c && c.accountId ? ui.accountOf(c.accountId) : null;
      var stateText = c && c.source !== 'local' ? T('p.side_' + (c.state === 'ok' || c.state === 'syncing' || c.state === 'auth_failed' || c.state === 'unreachable' || c.state === 'consent_required' ? c.state : 'syncing')) : null;
      ui.dialog(it.name, [
        stateText ? h('p', { class: 'dp-hint', text: stateText + (c.syncedAt ? ' · ' + T('p.c.synced_at', { when: ui.fmtFull(c.syncedAt) }) : '') }) : null,
        c && c.state === 'consent_required' && acc ? btn(T('p.relogin'), function () { ui.closeDialog(); ui.relogin(acc); }, { small: true }) : null,
        name ? ui.field(T('p.c.name'), name) : null,
        ui.field(T('p.c.color'), color),
        notify ? h('label', { class: 'dp-check' }, [notify, h('span', { text: T('p.c.notify') })]) : null,
        c && !local && c.source !== 'ics' ? h('p', { class: 'dp-hint', text: T('p.c.only_here') }) : null,
        err,
        h('div', { class: 'dp-actions' }, [
          c && (local || c.source === 'ics') ? btn(T('p.c.delete_calendar'), remove, { danger: true }) : null,
          btn(T('p.cancel'), ui.closeDialog), btn(T('p.save'), save, { primary: true }),
        ]),
      ]);
    }

    function addCalendar() {
      var name = h('input', { class: 'dp-input', type: 'text' });
      var color = h('input', { class: 'dp-input', type: 'color', value: '#B79CFF', style: 'width:64px;padding:2px' });
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var go = function () {
        api('POST', 'calendars', { name: name.value.trim(), color: color.value.toUpperCase() }).then(function (r) {
          C.calendars.push(r.calendar);
          ui.closeDialog();
          ui.renderNav();
          if (S.area === 'calendar') renderHead();
        }, function (e) { err.textContent = ui.errText(e); });
      };
      ui.dialog(T('p.c.add_calendar'), [ui.field(T('p.c.name'), name), ui.field(T('p.c.color'), color), err,
        h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), ui.closeDialog), btn(T('p.c.create'), go, { primary: true })])]);
      name.focus();
    }

    function subscribe() {
      var url = h('input', { class: 'dp-input', type: 'url', placeholder: 'https:// · webcal://' });
      var name = h('input', { class: 'dp-input', type: 'text' });
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var go = function () {
        var b = { url: url.value.trim() };
        if (name.value.trim()) b.name = name.value.trim();
        err.textContent = T('p.loading');
        api('POST', 'calendars/subscribe', b).then(function (r) {
          C.calendars.push(r.calendar);
          ui.closeDialog();
          ui.toast(T('p.c.subscribed'));
          ui.renderNav();
          if (S.area === 'calendar') { renderHead(); fetchRange(); }
        }, function (e) { err.textContent = ui.errText(e); });
      };
      ui.dialog(T('p.c.subscribe'), [h('p', { class: 'dp-hint', text: T('p.c.subscribe_hint') }), ui.field(T('p.c.address'), url), ui.field(T('p.c.name_optional'), name), err,
        h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), ui.closeDialog), btn(T('p.c.subscribe_go'), go, { primary: true })])]);
      url.focus();
    }

    // ── the view ─────────────────────────────────────────

    function show() {
      var el = $('mp-list');
      clear(el);
      el.appendChild(h('div', { class: 'mp-card' }, h('div', { class: 'mp-empty', text: T('p.loading') })));
      load().then(function () {
        if (S.area !== 'calendar') return;
        ui.renderNav();
        renderFrame();
        fetchRange();
      }, function (e) { clear(el); el.appendChild(h('div', { class: 'mp-card' }, h('p', { class: 'dp-err', text: ui.errText(e) }))); });
    }

    function title() {
      var r = range();
      var first = L.dateOf(r.days[0]);
      var last = L.dateOf(r.days[r.days.length - 1]);
      if (C.view === 'day') return first.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      if (C.view === 'month') return L.dateOf(C.anchor).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
      if (C.view === 'list') return T('p.c.from_day', { day: first.toLocaleDateString(LOCALE, { day: 'numeric', month: 'long' }) });
      if (first.getMonth() === last.getMonth()) return first.toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
      return first.toLocaleDateString(LOCALE, { month: 'short' }) + ' – ' + last.toLocaleDateString(LOCALE, { month: 'short', year: 'numeric' });
    }

    function step(dir) {
      if (C.view === 'day') C.anchor = L.addDays(C.anchor, dir);
      else if (C.view === 'week') C.anchor = L.addDays(C.anchor, 7 * dir);
      else if (C.view === 'month') C.anchor = L.addMonths(C.anchor, dir);
      else { C.anchor = L.addDays(C.anchor, 30 * dir); C.listDays = 30; }
      renderHead();
      fetchRange();
    }
    function setView(v) {
      C.view = v;
      if (v === 'list') C.listDays = 30;
      renderHead();
      fetchRange();
      if (C.prefs && C.prefs.view !== v) api('PUT', 'calendar/settings', { view: v }).then(function (x) { C.prefs = x.prefs; }, function () {});
    }

    function renderFrame() {
      var el = $('mp-list');
      clear(el);
      el.appendChild(h('div', { id: 'mc-head', class: 'mc-head-wrap' }));
      el.appendChild(h('div', { id: 'mc-view', class: 'mc-view' }));
      renderHead();
      renderView();
    }

    function renderHead() {
      var head = $('mc-head');
      if (!head) return;
      clear(head);
      var seg = h('div', { class: 'mc-seg', attrs: { role: 'group', 'aria-label': T('p.c.view') } }, ['day', 'week', 'month', 'list'].map(function (v) {
        return h('button', { type: 'button', attrs: { 'aria-pressed': C.view === v ? 'true' : 'false' }, on: { click: function () { setView(v); } } }, T('p.c.view_' + v));
      }));
      add(head, [
        h('div', { class: 'mp-head' }, [
          ui.ibtn('menu', T('p.menu'), function () { ui.showPane('nav'); }, 'mp-menu-btn'),
          h('div', { class: 'mp-head-tx' }, [h('h2', { text: title() })]),
          ibtn('gear', T('p.c.settings'), settingsDialog),
          btn(T('p.c.new_event'), function () { newEvent(null); }, { icon: 'plus', primary: true, small: true }),
        ]),
        h('div', { class: 'mc-bar' }, [seg,
          C.view === 'week' ? h('label', { class: 'dp-check mc-ww' }, [h('input', { type: 'checkbox', checked: C.workWeek, on: { change: function (ev) { C.workWeek = !!ev.target.checked; renderHead(); fetchRange(); } } }), h('span', { text: T('p.c.work_week') })]) : null,
          h('span', { style: 'flex:1' }),
          btn(T('p.c.today'), function () { C.anchor = L.ymd(new Date()); C.listDays = 30; renderHead(); fetchRange(); }, { small: true }),
          ibtn('left', T('p.c.prev'), function () { step(-1); }), ibtn('right', T('p.c.next'), function () { step(1); }),
        ]),
        chips(),
        ui.consentBand(SCOPE),
        C.pending.length ? h('p', { class: 'dp-hint', text: T('p.c.pending') }) : null,
      ]);
    }

    /** The chips of the shown calendars (mockup): a click hides one. */
    function chips() {
      var list = C.calendars.filter(function (c) { return c.visible; }).map(function (c) { return { kind: 'calendar', it: c }; })
        .concat(C.overlays.filter(function (o) { return o.visible; }).map(function (o) { return { kind: 'overlay', it: o }; }));
      if (!list.length) return h('p', { class: 'dp-hint', text: T('p.c.none_shown') });
      return h('div', { class: 'mc-chips' }, list.map(function (x) {
        return h('button', { type: 'button', class: 'mc-chip', attrs: { title: T('p.c.hide', { name: x.it.name }) }, on: { click: function () { setVisible(x.kind, x.it, false); } } },
          [h('span', { class: 'mc-sq', style: 'background:' + x.it.color }), x.kind === 'calendar' ? calName(x.it) : x.it.name]);
      }));
    }

    function allItems() { return C.items.concat(C.overlayItems); }

    function renderView() {
      var v = $('mc-view');
      if (!v) return;
      clear(v);
      if (C.view === 'month') v.appendChild(monthView());
      else if (C.view === 'list') v.appendChild(listView());
      else v.appendChild(timeView());
    }

    function evClass(it) {
      return 'mc-ev' + (it.myResponse === 'needs_action' ? ' is-open' : '') + (it.status === 'cancelled' ? ' is-cancelled' : '') + (it.overlayId ? ' is-overlay' : '') + (it.status === 'tentative' || it.myResponse === 'tentative' ? ' is-tentative' : '');
    }
    function evStyle(it) {
      var c = colorOf(it);
      return it.myResponse === 'needs_action' ? 'border-color:' + c + ';color:' + c : 'background:color-mix(in srgb,' + c + ' 20%,transparent);border-left-color:' + c;
    }
    function timeText(it) {
      if (it.allDay) return T('p.c.all_day');
      return L.hhmm(it.start) + '–' + L.hhmm(it.end);
    }

    function dayHead(s, today) {
      var d = L.dateOf(s);
      return h('button', { type: 'button', class: 'mc-dh' + (s === today ? ' is-today' : ''), on: { click: function () { C.anchor = s; setView('day'); } } },
        [h('span', { class: 'mp-sub', text: d.toLocaleDateString(LOCALE, { weekday: 'short' }) }), h('b', { text: String(d.getDate()) })]);
    }

    /** Tag and Woche: the all-day row, then hours 0–24 with the events. */
    function timeView() {
      var r = range();
      var today = L.ymd(new Date());
      var items = allItems();
      var cols = 'grid-template-columns:48px repeat(' + r.days.length + ',minmax(0,1fr))';
      var wrap = h('div', { class: 'mc-time' });
      wrap.appendChild(h('div', { class: 'mc-row', style: cols }, [h('span')].concat(r.days.map(function (s) { return dayHead(s, today); }))));
      var allDay = r.days.map(function (s) { return L.allDayOn(items, s); });
      if (allDay.some(function (x) { return x.length; })) {
        wrap.appendChild(h('div', { class: 'mc-row mc-allday', style: cols }, [h('span', { class: 'mc-gut', text: T('p.c.all_day_short') })].concat(allDay.map(function (list) {
          return h('div', { class: 'mc-adcell' }, list.map(function (it) {
            return h('button', { type: 'button', class: evClass(it) + ' is-allday', style: evStyle(it), attrs: { title: it.title }, on: { click: function () { openEvent(it); } } }, it.title);
          }));
        }))));
      }
      var scroll = h('div', { class: 'mc-scroll' });
      var body = h('div', { class: 'mc-row mc-body', style: cols + ';height:' + (24 * HOUR) + 'px' });
      var gut = h('div', { class: 'mc-hours' });
      for (var hr = 0; hr < 24; hr++) gut.appendChild(h('span', { class: 'mc-hr', style: 'top:' + (hr * HOUR) + 'px', text: hr ? String(hr) : '' }));
      body.appendChild(gut);
      r.days.forEach(function (s) {
        var col = h('div', { class: 'mc-col' + (s === today ? ' is-today' : '') });
        for (var k = 0; k < 24; k++) {
          (function (hour) {
            col.appendChild(h('div', { class: 'mc-slot', style: 'top:' + (hour * HOUR) + 'px;height:' + HOUR + 'px', attrs: { 'data-hour': String(hour) },
              on: { click: function () { newEvent({ startDate: s, hour: hour }); } } }));
          })(k);
        }
        L.layoutDay(items, s).forEach(function (x) {
          var it = x.item;
          var w = 100 / x.cols;
          col.appendChild(h('button', { type: 'button', class: evClass(it), attrs: { title: it.title },
            style: 'top:' + (x.top * HOUR / 60) + 'px;height:' + Math.max(18, x.height * HOUR / 60 - 2) + 'px;left:calc(' + (x.col * w) + '% + 2px);width:calc(' + w + '% - 4px);' + evStyle(it),
            on: { click: function (ev) { if (ev.stopPropagation) ev.stopPropagation(); openEvent(it); } } }, [
            h('b', { text: it.title || T('p.c.no_title') }),
            h('span', { class: 'mc-evsub', text: [timeText(it), it.location, it.overlayId ? T('p.c.read_only') : null].filter(Boolean).join(' · ') }),
          ]));
        });
        if (s === today) {
          var now = new Date();
          col.appendChild(h('div', { class: 'mc-now', style: 'top:' + ((now.getHours() * 60 + now.getMinutes()) * HOUR / 60) + 'px' }));
        }
        body.appendChild(col);
      });
      scroll.appendChild(body);
      wrap.appendChild(scroll);
      setTimeout(function () { scroll.scrollTop = 7 * HOUR; }, 0);
      return wrap;
    }

    /** Monat: six weeks, up to three lines a day, a click on a day → that day. */
    function monthView() {
      var r = range();
      var today = L.ymd(new Date());
      var month = C.anchor.slice(0, 7);
      var items = allItems();
      var grid = h('div', { class: 'mc-month' });
      r.days.slice(0, 7).forEach(function (s) { grid.appendChild(h('span', { class: 'mc-wd', text: L.dateOf(s).toLocaleDateString(LOCALE, { weekday: 'short' }) })); });
      r.days.forEach(function (s) {
        var list = items.filter(function (it) { return L.onDay(it, s); }).sort(function (a, b) { return (L.wholeDay(b) ? 1 : 0) - (L.wholeDay(a) ? 1 : 0) || a.start - b.start; });
        var cell = h('div', { class: 'mc-day' + (s.slice(0, 7) !== month ? ' is-out' : '') + (s === today ? ' is-today' : '') }, [
          h('button', { type: 'button', class: 'mc-dnum', attrs: { 'aria-label': L.dateOf(s).toLocaleDateString(LOCALE, { dateStyle: 'full' }) }, on: { click: function () { C.anchor = s; setView('day'); } } }, String(L.dateOf(s).getDate())),
        ]);
        list.slice(0, 3).forEach(function (it) {
          cell.appendChild(h('button', { type: 'button', class: 'mc-mline' + (it.status === 'cancelled' ? ' is-cancelled' : '') + (it.myResponse === 'needs_action' ? ' is-open' : ''), on: { click: function () { openEvent(it); } } },
            [h('span', { class: 'mp-dot', style: 'background:' + colorOf(it) }), L.wholeDay(it) ? '' : h('span', { class: 'mp-sub', text: L.hhmm(it.start) }), h('span', { class: 'mp-tx', text: it.title })]));
        });
        if (list.length > 3) cell.appendChild(h('button', { type: 'button', class: 'mc-more-n', on: { click: function () { C.anchor = s; setView('day'); } } }, T('p.c.more', { n: list.length - 3 })));
        grid.appendChild(cell);
      });
      return grid;
    }

    /** Liste: from the day shown on, by days; „Weitere Termine“ loads 30 days more (each request ≤ 62 days). */
    function listView() {
      var r = range();
      var groups = L.agenda(allItems(), r.days);
      var box = h('div', { class: 'mc-list' });
      if (!groups.length) box.appendChild(h('div', { class: 'mp-items' }, h('div', { class: 'mp-empty', text: T('p.c.no_events') })));
      groups.forEach(function (g) {
        box.appendChild(h('div', { class: 'mp-lab', text: L.dateOf(g.day).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' }) }));
        box.appendChild(h('div', { class: 'mp-items' }, g.items.map(function (it) {
          return h('button', { type: 'button', class: 'mc-lrow' + (it.status === 'cancelled' ? ' is-cancelled' : ''), on: { click: function () { openEvent(it); } } }, [
            h('span', { class: 'mc-ltime', text: L.wholeDay(it) ? T('p.c.all_day') : L.hhmm(it.start) }),
            h('span', { class: 'mc-lbar' + (it.myResponse === 'needs_action' ? ' is-open' : ''), style: 'background:' + colorOf(it) + ';border-color:' + colorOf(it) }),
            h('span', { class: 'mp-it' }, [h('b', { text: it.title || T('p.c.no_title') }),
              h('span', { class: 'mp-sub', text: [L.wholeDay(it) ? null : L.hhmm(it.start) + '–' + L.hhmm(it.end), it.location, it.myResponse === 'needs_action' ? T('p.c.invite_open') : null, it.overlayId ? T('p.c.read_only') : null].filter(Boolean).join(' · ') })]),
          ]);
        })));
      });
      if (C.listDays < 62) {
        box.appendChild(h('div', { style: 'display:flex;justify-content:center;padding:8px' }, btn(T('p.c.more_events'), function () { C.listDays = Math.min(62, C.listDays + 30); fetchRange(); }, { small: true })));
      } else {
        box.appendChild(h('div', { style: 'display:flex;justify-content:center;padding:8px' }, btn(T('p.c.next_range'), function () { C.anchor = L.addDays(C.anchor, 62); C.listDays = 30; renderHead(); fetchRange(); }, { small: true })));
      }
      return box;
    }

    // ── settings ─────────────────────────────────────────

    function settingsDialog() {
      var p = C.prefs || {};
      var sel = function (v, opts) { return h('select', { class: 'dp-input' }, opts.map(function (o) { return h('option', { value: String(o[0]), selected: String(o[0]) === String(v), text: o[1] }); })); };
      var weekStart = sel(p.weekStart, [[1, T('p.c.monday')], [0, T('p.c.sunday')]]);
      var reminders = h('input', { type: 'checkbox', class: 'dp-sw', checked: p.reminders !== false });
      var rem = sel(p.defaultReminder == null ? '' : p.defaultReminder, [['', T('p.c.rem_none')]].concat(REMINDER_CHOICES.map(function (m) { return [m, L.reminderText(m, T)]; })));
      var writable = C.calendars.filter(function (c) { return c.writable; });
      var def = sel(p.defaultCalendarId, writable.map(function (c) { return [c.id, calName(c)]; }));
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var go = function () {
        var b = { weekStart: Number(weekStart.value), reminders: reminders.checked, defaultReminder: rem.value === '' ? null : Number(rem.value) };
        if (def.value) b.defaultCalendarId = Number(def.value);
        api('PUT', 'calendar/settings', b).then(function (r) { C.prefs = r.prefs; ui.closeDialog(); ui.toast(T('p.saved')); renderHead(); fetchRange(); }, function (e) { err.textContent = ui.errText(e); });
      };
      ui.dialog(T('p.c.settings'), [
        ui.field(T('p.c.week_start'), weekStart), ui.field(T('p.c.default_calendar'), def),
        h('label', { class: 'dp-check' }, [reminders, h('span', { text: T('p.c.reminders_on') })]), ui.field(T('p.c.default_reminder'), rem),
        h('p', { class: 'dp-hint', text: T('p.c.zone_note', { zone: p.timeZone || '' }) }), err,
        h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), ui.closeDialog), btn(T('p.save'), go, { primary: true })]),
      ]);
    }

    // ── one event ────────────────────────────────────────

    function whenText(it) {
      var d1 = it.allDay && it.startDate ? L.dateOf(it.startDate) : new Date(it.start);
      if (it.allDay) {
        var d2 = it.endDate ? L.dateOf(it.endDate) : d1;
        var a = d1.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' });
        return (it.endDate && it.endDate !== it.startDate ? a + ' – ' + d2.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' }) : a) + ' · ' + T('p.c.all_day');
      }
      var e = new Date(it.end);
      var same = L.ymd(d1) === L.ymd(e);
      var s = d1.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' }) + ' · ' + L.hhmm(it.start) + ' – ' + (same ? '' : e.toLocaleDateString(LOCALE, { day: 'numeric', month: 'numeric' }) + ' ') + L.hhmm(it.end);
      var z = deviceZone();
      if (it.timeZone && z && it.timeZone !== z) s += ' (' + T('p.c.your_time') + '; ' + it.timeZone + ')';
      return s;
    }

    function openEvent(it) {
      if (it.overlayId) { overlayDialog(it); return; }
      api('GET', 'events/' + it.eventId, null, { occurrence: it.occurrence || null }).then(viewDialog, fail);
    }

    function overlayDialog(it) {
      var o = overlayOf(it.overlayId);
      ui.dialog(it.title, [
        line('clock', whenText(it)), it.location ? line('pin', it.location) : null,
        h('div', { class: 'mc-line' }, [h('span', { class: 'mc-sq', style: 'background:' + colorOf(it) }), h('span', { text: (o ? o.name : '') + ' · ' + T('p.c.read_only') })]),
      ]);
    }

    function line(ic, text, extra) { return h('div', { class: 'mc-line' }, [icon(ic), h('span', { class: 'mp-tx', style: 'white-space:normal', text: text }), extra || null]); }

    var RESPONSE_COLOR = { accepted: 'var(--good)', tentative: 'var(--warn)', declined: 'var(--crit)', needs_action: 'var(--muted)' };
    function attendeeRow(a, organizer) {
      var label = organizer ? T('p.c.organizer') : T('p.c.resp_' + (a.response || 'needs_action'));
      return h('button', { type: 'button', class: 'mc-who', attrs: { title: a.email }, on: { click: function () { personClick(a); } } }, [
        h('span', { class: 'mp-av', text: ui.initials(a.name || a.email) }), h('span', { class: 'mp-tx', text: a.name || a.email }),
        h('span', { class: 'mp-sub', style: organizer ? null : 'color:' + (RESPONSE_COLOR[a.response] || 'var(--muted)'), text: label }),
      ]);
    }
    /** An attendee → their contact, or „Als Kontakt speichern“. */
    function personClick(a) {
      var con = ui.contacts();
      if (!con || !ui.has('contacts')) { ui.compose({ to: [a.email] }); return; }
      ui.closeDialog();
      if (a.contactId) con.openCard(a.contactId); else con.newFrom({ name: a.name || '', email: a.email });
    }
    function attendeesBox(ev) {
      if (!ev.attendees || !ev.attendees.length) return null;
      var counts = { accepted: 0, tentative: 0, declined: 0, needs_action: 0 };
      ev.attendees.forEach(function (a) { counts[a.response] = (counts[a.response] || 0) + 1; });
      var c = L.countOf(counts);
      var rows = [];
      if (ev.organizer) rows.push(attendeeRow(ev.organizer, true));
      ev.attendees.filter(function (a) { return !ev.organizer || a.email !== ev.organizer.email; }).forEach(function (a) { rows.push(attendeeRow(a, false)); });
      return h('div', { class: 'mc-att' }, [h('div', { class: 'mp-sub', text: T('p.c.attendees_n', { yes: c.yes, all: c.all }) })].concat(rows));
    }

    function viewDialog(ev) {
      var cal = calOf(ev.calendarId);
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var body = [
        line('clock', whenText(ev)),
        ev.recurrence ? line('repeat', L.recurrenceText(ev.recurrence, T, CTX.lang)) : null,
        cal ? h('div', { class: 'mc-line' }, [h('span', { class: 'mc-sq', style: 'background:' + cal.color }), h('span', { text: calName(cal) + (ev.readOnly ? ' · ' + T('p.c.read_only') : '') })]) : null,
        ev.location ? line('pin', ev.location, btn(T('p.c.map'), function () { ui.linkDialog('https://www.openstreetmap.org/search?query=' + encodeURIComponent(ev.location), T('p.c.map')); }, { small: true })) : null,
        ev.online ? line('video', T('p.c.online_' + (ev.online.provider || 'other')), btn(T('p.c.join'), function () { ui.linkDialog(ev.online.url, T('p.c.join')); }, { small: true, primary: true })) : null,
        ev.reminders && ev.reminders.length ? line('bell', ev.reminders.map(function (m) { return L.reminderText(m, T); }).join(', ')) : null,
        ev.status === 'cancelled' ? h('div', { class: 'dp-note is-warn' }, [icon('warn'), h('span', { text: T('p.c.cancelled') })]) : null,
        ev.myResponse && ev.myResponse !== 'organizer' && ev.myResponse !== 'needs_action' ? h('p', { class: 'dp-hint', text: T('p.c.you_' + ev.myResponse) }) : null,
        attendeesBox(ev),
      ];
      if (ev.descriptionHtml || ev.description) {
        var host = h('div', { class: 'mp-body mc-desc' });
        var wrap = ui.shadowHtml(host, ev.descriptionHtml, ev.description);
        wrap.addEventListener('click', function (x) {
          var a = x.target && x.target.closest ? x.target.closest('a') : null;
          if (!a) return;
          if (x.preventDefault) x.preventDefault();
          var href = a.getAttribute('href') || '';
          if (/^https?:/i.test(href)) ui.linkDialog(href);
        });
        body.push(host);
      }
      if (ev.canRespond) {
        var comment = h('input', { class: 'dp-input', type: 'text', placeholder: T('p.c.comment') });
        var answer = function (response) {
          err.textContent = '';
          api('POST', 'events/' + ev.eventId + '/respond', { response: response, comment: comment.value.trim() || undefined, occurrence: ev.occurrence || undefined }).then(function () {
            ui.closeDialog();
            ui.toast(T('p.c.answered_' + response));
            fetchRange();
          }, function (e) { err.textContent = ui.errText(e); });
        };
        body.push(comment, h('div', { class: 'mc-ans' }, [btn(T('p.c.accept'), function () { answer('accepted'); }, { primary: true }), btn(T('p.c.tentative'), function () { answer('tentative'); }),
          btn(T('p.c.decline'), function () { answer('declined'); }, { danger: true })]));
      }
      body.push(err);
      body.push(h('div', { class: 'dp-actions' }, [
        ev.canDelete ? btn(T('p.c.delete'), function () { deleteEvent(ev); }, { danger: true, icon: 'trash' }) : null,
        ev.canEdit ? btn(T('p.c.edit'), function () { editEvent(ev); }, { icon: 'edit', primary: !ev.canRespond }) : null,
      ]));
      ui.dialog(ev.title || T('p.c.no_title'), body, { wide: true });
    }

    function deleteEvent(ev) {
      var series = !!ev.occurrence || !!ev.recurring;
      var withPeople = ev.attendees && ev.attendees.length > 0;
      var notify = withPeople ? h('input', { type: 'checkbox', checked: true }) : null;
      var comment = withPeople ? h('input', { class: 'dp-input', type: 'text', placeholder: T('p.c.comment') }) : null;
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var go = function (scope) {
        api('DELETE', 'events/' + ev.eventId, null, { scope: scope, occurrence: scope === 'occurrence' ? ev.occurrence : null, notify: notify && notify.checked ? '1' : null,
          comment: comment && comment.value.trim() ? comment.value.trim() : null }).then(function () {
          ui.closeDialog();
          ui.toast(T('p.c.deleted'));
          fetchRange();
        }, function (e) { err.textContent = ui.errText(e); });
      };
      ui.dialog(T('p.c.delete_q', { title: ev.title }), [
        notify ? h('label', { class: 'dp-check' }, [notify, h('span', { text: ev.myResponse === 'organizer' || (ev.organizer && ev.organizer.self) ? T('p.c.notify_attendees') : T('p.c.notify_organizer') })]) : null,
        comment, err,
        h('div', { class: 'dp-actions' }, series && ev.occurrence ? [btn(T('p.cancel'), ui.closeDialog), btn(T('p.c.only_this'), function () { go('occurrence'); }, { danger: true }), btn(T('p.c.whole_series'), function () { go('series'); }, { danger: true })]
          : [btn(T('p.cancel'), ui.closeDialog), btn(T('p.c.delete'), function () { go('series'); }, { danger: true })]),
      ]);
    }

    /** A new event: at a slot ({ startDate, hour }), else the next full hour of the day shown. */
    function newEvent(at) {
      load().then(function () {
        var now = new Date();
        var day = at && at.startDate ? at.startDate : (C.view === 'day' ? C.anchor : L.ymd(now));
        var hour = at && at.hour != null ? at.hour : Math.min(23, now.getHours() + 1);
        editEvent(null, { startDate: day, startTime: (hour < 10 ? '0' : '') + hour + ':00', endDate: hour === 23 ? L.addDays(day, 1) : day, endTime: hour === 23 ? '00:00' : ((hour + 1) < 10 ? '0' : '') + (hour + 1) + ':00' });
      }, fail);
    }

    function zonesList(cur) {
      var list = [];
      try { if (Intl.supportedValuesOf) list = Intl.supportedValuesOf('timeZone'); } catch (e) { list = []; }
      if (!list.length) list = ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'UTC'];
      [cur, deviceZone()].forEach(function (z) { if (z && list.indexOf(z) < 0) list = [z].concat(list); });
      return list;
    }

    /**
     * The event form: a new one (`ev` null; `pre` with the time) or a change of `ev` (an Event). Only writable calendars;
     * a series asks „Nur dieser Termin“ / „Alle Termine der Serie“ before saving; only changed fields go out.
     */
    function editEvent(ev, pre) {
      var p = pre || {};
      var writable = C.calendars.filter(function (c) { return c.writable; });
      var defCal = ev ? calOf(ev.calendarId) : (calOf(C.prefs && C.prefs.defaultCalendarId) || writable[0]);
      if (!defCal) { ui.toast(T('p.c.no_writable'), 'error'); return; }
      var startMs = ev ? ev.start : L.at(p.startDate, p.startTime);
      var endMs = ev ? ev.end : L.at(p.endDate, p.endTime);
      var allDay0 = ev ? !!ev.allDay : false;
      var title = h('input', { class: 'dp-input', type: 'text', value: ev ? ev.title : '', attrs: { 'aria-label': T('p.c.title_field'), maxlength: '255' } });
      var calSel = h('select', { class: 'dp-input', disabled: !!ev }, (ev ? [defCal] : writable).map(function (c) { return h('option', { value: String(c.id), selected: c.id === defCal.id, text: calName(c) }); }));
      var allDay = h('input', { type: 'checkbox', class: 'dp-sw', checked: allDay0, attrs: { 'aria-label': T('p.c.all_day') } });
      var sd = h('input', { class: 'dp-input', type: 'date', value: allDay0 && ev.startDate ? ev.startDate : L.ymd(startMs) });
      var st = h('input', { class: 'dp-input', type: 'time', value: L.hhmm(startMs) });
      var ed = h('input', { class: 'dp-input', type: 'date', value: allDay0 && ev.endDate ? ev.endDate : L.ymd(endMs) });
      var et = h('input', { class: 'dp-input', type: 'time', value: L.hhmm(endMs) });
      var zone0 = ev && ev.timeZone ? ev.timeZone : (deviceZone() || (C.prefs && C.prefs.timeZone) || 'Europe/Berlin');
      var zone = h('select', { class: 'dp-input' }, zonesList(zone0).map(function (z) { return h('option', { value: z, selected: z === zone0, text: z }); }));
      var zoneBox = h('div', { class: 'mp-col', hidden: true }, [ui.field(T('p.c.zone'), zone), h('p', { class: 'dp-hint', text: T('p.c.zone_hint') })]);
      var zoneBtn = h('button', { type: 'button', class: 'mc-link', on: { click: function () { zoneBox.hidden = !zoneBox.hidden; } } }, T('p.c.zone_btn', { zone: zone0 }));
      // keep the length when the start moves
      var len = endMs - startMs;
      var dlen = allDay0 && ev && ev.startDate ? Math.round((L.midnight(ev.endDate || ev.startDate) - L.midnight(ev.startDate)) / L.DAY) : 0;
      var moveEnd = function () {
        if (allDay.checked) { if (sd.value) ed.value = L.addDays(sd.value, Math.max(0, dlen)); return; }
        if (!sd.value || !st.value) return;
        var e = L.at(sd.value, st.value) + Math.max(0, len);
        ed.value = L.ymd(e); et.value = L.hhmm(e);
      };
      sd.addEventListener('change', moveEnd); st.addEventListener('change', moveEnd);
      var keepLen = function () {
        if (allDay.checked) { if (sd.value && ed.value) dlen = Math.round((L.midnight(ed.value) - L.midnight(sd.value)) / L.DAY); return; }
        if (sd.value && st.value && ed.value && et.value) len = L.at(ed.value, et.value) - L.at(sd.value, st.value);
      };
      ed.addEventListener('change', keepLen); et.addEventListener('change', keepLen);
      var timeRow = h('div', { class: 'mc-when' }, [ui.field(T('p.c.start'), h('div', { class: 'mc-dt' }, [sd, st])), ui.field(T('p.c.end'), h('div', { class: 'mc-dt' }, [ed, et]))]);
      var syncAllDay = function () { st.hidden = allDay.checked; et.hidden = allDay.checked; zoneBtn.hidden = allDay.checked; if (allDay.checked) zoneBox.hidden = true; };
      allDay.addEventListener('change', syncAllDay);
      syncAllDay();

      // repetition
      var rep = L.repeatOf(ev ? ev.recurrence : null, sd.value);
      var canRepeat = !ev || !ev.occurrence;
      var fixedRule = ev && ev.recurrence && ev.recurrence.editable === false;
      var nth = L.nthOf(sd.value);
      var kindSel = h('select', { class: 'dp-input' }, ['none', 'daily', 'weekly', 'monthly_day', 'monthly_nth', 'yearly'].map(function (k) {
        var label = k === 'monthly_day' ? T('p.c.rep_monthly_day', { n: L.dateOf(sd.value).getDate() }) : k === 'monthly_nth' ? T('p.c.rep_monthly_nth', { n: nth.pos === -1 ? T('p.c.last') : nth.pos + '.', day: T('p.c.wd_' + nth.day) }) : T('p.c.rep_' + k);
        return h('option', { value: k, selected: rep.kind === k, text: label });
      }));
      var interval = h('input', { class: 'dp-input', type: 'number', value: String(rep.interval), attrs: { min: '1', max: '999', 'aria-label': T('p.c.interval') }, style: 'width:90px' });
      var days = rep.byDay.slice();
      var dayChips = h('div', { class: 'dp-chips' });
      var drawDays = function () {
        clear(dayChips);
        ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].forEach(function (d) {
          dayChips.appendChild(h('button', { type: 'button', attrs: { 'aria-pressed': days.indexOf(d) >= 0 ? 'true' : 'false' }, on: { click: function () {
            var i = days.indexOf(d); if (i >= 0) days.splice(i, 1); else days.push(d); rep.touched = true; drawDays();
          } } }, T('p.c.wd_' + d)));
        });
      };
      drawDays();
      var endSel = h('select', { class: 'dp-input' }, ['never', 'until', 'count'].map(function (k) { return h('option', { value: k, selected: rep.end === k, text: T('p.c.end_' + k) }); }));
      var until = h('input', { class: 'dp-input', type: 'date', value: rep.until || '' });
      var count = h('input', { class: 'dp-input', type: 'number', value: String(rep.count || 10), attrs: { min: '1', max: '1000' }, style: 'width:90px' });
      var repBox = h('div', { class: 'mp-col' });
      var drawRep = function () {
        clear(repBox);
        var k = kindSel.value;
        add(repBox, [kindSel]);
        if (k === 'none') return;
        add(repBox, [h('div', { class: 'mc-dt' }, [h('span', { class: 'mp-sub', text: T('p.c.every') }), interval, h('span', { class: 'mp-sub', text: T('p.c.unit_' + (k.indexOf('monthly') === 0 ? 'monthly' : k)) })]),
          k === 'weekly' ? dayChips : null, h('div', { class: 'mc-dt' }, [endSel, endSel.value === 'until' ? until : endSel.value === 'count' ? count : null])]);
      };
      [kindSel, endSel].forEach(function (x) { x.addEventListener('change', function () { rep.touched = true; drawRep(); }); });
      [interval, until, count].forEach(function (x) { x.addEventListener('change', function () { rep.touched = true; }); });
      drawRep();

      var location = h('input', { class: 'dp-input', type: 'text', value: ev && ev.location ? ev.location : '' });
      var canOnline = calOf(Number(calSel.value)) ? calOf(Number(calSel.value)).canOnline : false;
      var online0 = ev && ev.online ? (ev.online.provider === 'teams' && canOnline ? 'teams' : 'link') : 'none';
      var onlineSel = h('select', { class: 'dp-input' });
      var onlineUrl = h('input', { class: 'dp-input', type: 'url', value: ev && ev.online && ev.online.url ? ev.online.url : '', placeholder: 'https://' });
      var drawOnline = function () {
        var c = calOf(Number(calSel.value));
        var cur = onlineSel.value || online0;
        clear(onlineSel);
        ['none', 'link'].concat(c && c.canOnline ? ['teams'] : []).forEach(function (k) { onlineSel.appendChild(h('option', { value: k, selected: k === cur, text: T('p.c.online_choice_' + k) })); });
        onlineUrl.hidden = onlineSel.value !== 'link';
      };
      onlineSel.addEventListener('change', function () { onlineUrl.hidden = onlineSel.value !== 'link'; });
      drawOnline();

      // reminders: up to the calendar's maximum (Graph: one)
      var reminderBox = h('div', { class: 'mc-rems' });
      var remSels = [];
      var drawRems = function () {
        var c = calOf(Number(calSel.value));
        var max = c ? c.maxReminders || 3 : 3;
        var cur = remSels.length ? remSels.map(function (x) { return x.value; }) : (ev ? (ev.reminders || []).map(String) : (C.prefs && C.prefs.defaultReminder != null ? [String(C.prefs.defaultReminder)] : []));
        clear(reminderBox);
        remSels = [];
        for (var i = 0; i < max; i++) {
          var v = cur[i] != null ? cur[i] : '';
          var opts = REMINDER_CHOICES.slice();
          if (v !== '' && opts.indexOf(Number(v)) < 0) opts.push(Number(v));
          var s = h('select', { class: 'dp-input', attrs: { 'aria-label': T('p.c.reminder_n', { n: i + 1 }) } }, [h('option', { value: '', selected: v === '', text: T('p.c.rem_none') })].concat(opts.map(function (m) { return h('option', { value: String(m), selected: String(m) === v, text: L.reminderText(m, T) }); })));
          remSels.push(s);
          reminderBox.appendChild(s);
        }
      };
      drawRems();

      // attendees with suggestions (contacts, groups → their members)
      var people = (ev ? ev.attendees || [] : []).filter(function (a) { return !(ev && ev.organizer && a.email === ev.organizer.email); })
        .map(function (a) { return { email: a.email, name: a.name || '', role: a.role || 'required' }; });
      var peopleBox = h('div', { class: 'mp-chips' });
      var peopleIn = h('input', { class: 'dp-input', type: 'text', placeholder: T('p.c.add_attendee'), attrs: { autocomplete: 'off', 'aria-label': T('p.c.attendees') } });
      var sugg = h('div', { class: 'mp-sugglist', hidden: true });
      var senderHint = h('p', { class: 'dp-hint' });
      var fromSel = h('select', { class: 'dp-input', hidden: true }, S.accounts.map(function (a) { return h('option', { value: String(a.id), text: ui.accountLabel(a) }); }));
      var drawSender = function () {
        var c = calOf(Number(calSel.value));
        fromSel.hidden = true;
        if (!people.length) { senderHint.textContent = ''; return; }
        if (c && c.source === 'graph') { senderHint.textContent = T('p.c.invites_exchange'); return; }
        if (c && c.accountId) { var a = ui.accountOf(c.accountId); senderHint.textContent = T('p.c.invites_via', { account: a ? a.email : '' }); return; }
        if (ev && ev.organizer) { senderHint.textContent = T('p.c.invites_via', { account: ev.organizer.email }); return; }
        if (!S.accounts.length) { senderHint.textContent = T('p.c.invites_no_account'); return; }
        senderHint.textContent = T('p.c.invites_from');
        fromSel.hidden = false;
        var kind = c && c.kind === 'business' ? 'business' : 'personal';
        var first = S.accounts.filter(function (a) { return a.kind === kind; })[0] || S.accounts[0];
        if (!fromSel.getAttribute('data-touched')) fromSel.value = String(first.id);
      };
      fromSel.addEventListener('change', function () { fromSel.setAttribute('data-touched', '1'); });
      var drawPeople = function () {
        clear(peopleBox);
        people.forEach(function (a, i) {
          peopleBox.appendChild(h('span', { class: 'mp-chip mc-pchip', attrs: { title: a.email } }, [a.name || a.email,
            h('button', { type: 'button', class: 'mc-x', attrs: { 'aria-label': T('p.remove') + ' ' + (a.name || a.email) }, on: { click: function () { people.splice(i, 1); drawPeople(); } } }, icon('close', 12))]));
        });
        drawSender();
      };
      var addPeople = function (list) {
        list.forEach(function (p2) { if (p2 && p2.email && !people.some(function (x) { return x.email === p2.email; })) people.push({ email: p2.email.toLowerCase(), name: p2.name || '', role: 'required' }); });
        drawPeople();
      };
      var timer = null;
      peopleIn.addEventListener('keydown', function (x) {
        if (x.key !== 'Enter' && x.key !== ',') return;
        if (x.preventDefault) x.preventDefault();
        var got = L.addressesOf(peopleIn.value);
        if (got.length) { addPeople(got); peopleIn.value = ''; sugg.hidden = true; }
      });
      peopleIn.addEventListener('input', function () {
        if (timer) clearTimeout(timer);
        var q = peopleIn.value.trim();
        if (q.length < 2) { sugg.hidden = true; return; }
        timer = setTimeout(function () {
          api('GET', 'contacts', null, { q: q }).then(function (r) {
            clear(sugg);
            (r.items || []).forEach(function (c) {
              var group = c.source === 'group';
              sugg.appendChild(h('button', { type: 'button', on: { click: function () {
                addPeople(group ? (c.members || []) : [c]);
                peopleIn.value = '';
                sugg.hidden = true;
                peopleIn.focus();
              } } }, group ? T('p.k.group_entry', { name: c.name, n: (c.members || []).length }) : (c.name ? c.name + ' · ' : '') + c.email));
            });
            sugg.hidden = !sugg.firstChild;
          }, function () { sugg.hidden = true; });
        }, 250);
      });
      drawPeople();
      calSel.addEventListener('change', function () { drawOnline(); drawRems(); drawSender(); });

      var busy = h('select', { class: 'dp-input' }, ['busy', 'free', 'tentative', 'oof'].map(function (k) { return h('option', { value: k, selected: (ev ? ev.busy : 'busy') === k, text: T('p.c.busy_' + k) }); }));
      var priv = h('input', { type: 'checkbox', checked: ev ? !!ev.private : false });
      var desc = h('textarea', { class: 'dp-input', attrs: { rows: '4' } });
      desc.value = ev ? ev.description || '' : '';
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });

      var values = function () {
        return {
          title: title.value.trim(), calendarId: Number(calSel.value), allDay: allDay.checked, startDate: sd.value, startTime: st.value || '00:00', endDate: ed.value || sd.value, endTime: et.value || st.value || '00:00',
          timeZone: allDay.checked ? null : zone.value, location: location.value.trim(), description: desc.value,
          reminders: remSels.map(function (x) { return x.value; }).filter(function (v) { return v !== ''; }).map(Number).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; }),
          repeat: canRepeat && !fixedRule ? { kind: kindSel.value, interval: Number(interval.value) || 1, byDay: days.slice(), end: endSel.value, until: until.value, count: Number(count.value) || 1, touched: !ev || rep.touched } : null,
          online: { kind: onlineSel.value, url: onlineUrl.value.trim() }, attendees: people.slice(), busy: busy.value, private: priv.checked,
        };
      };
      var save = function () {
        err.textContent = '';
        var f = values();
        if (!f.title) { err.textContent = T('p.c.title_missing'); title.focus(); return; }
        if (!f.startDate) { err.textContent = T('p.c.date_missing'); return; }
        if (!ev) {
          var b = L.eventFields(f, null);
          if (people.length && !fromSel.hidden) b.fromAccountId = Number(fromSel.value);
          api('POST', 'events', b).then(saved, function (e) { err.textContent = ui.errText(e); });
          return;
        }
        var ask = !!ev.occurrence && !(f.repeat && f.repeat.touched);
        var send = function (scope) {
          // the organizer is no attendee of the form (an own event lists them as ORGANIZER only)
          var orig = Object.assign({}, ev, { attendees: (ev.attendees || []).filter(function (a) { return !(ev.organizer && a.email === ev.organizer.email); }) });
          var x = L.eventFields(f, orig, { occurrence: scope === 'occurrence' });
          if (!Object.keys(x).length) { ui.closeDialog(); return; }
          x.scope = scope;
          if (scope === 'occurrence') x.occurrence = ev.occurrence;
          x.etag = ev.etag;
          if (people.length && !fromSel.hidden) x.fromAccountId = Number(fromSel.value);
          // the whole series from one of its events: a new time moves the series by as much as this event moved
          if (scope === 'series' && ev.occurrence && (x.start !== undefined || x.startDate !== undefined)) {
            api('GET', 'events/' + ev.eventId).then(function (base) { patch(ev, shiftSeries(x, ev, base)); }, function (e) { err.textContent = ui.errText(e); });
            return;
          }
          patch(ev, x);
        };
        if (!ask) { send('series'); return; }
        ui.dialog(T('p.c.which_q'), [h('p', { class: 'dp-hint', text: T('p.c.which_text') }), h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), function () { editEvent(ev); }),
          btn(T('p.c.only_this'), function () { send('occurrence'); }), btn(T('p.c.whole_series'), function () { send('series'); }, { primary: true })])]);
      };
      var form = [
        ui.field(T('p.c.title_field'), title), ui.field(T('p.c.calendar'), calSel),
        h('label', { class: 'mp-swrow' }, [h('span', { style: 'flex:1', text: T('p.c.all_day') }), allDay]),
        timeRow, zoneBtn, zoneBox,
        canRepeat ? (fixedRule ? h('p', { class: 'dp-hint', text: T('p.c.rule_fixed', { rule: L.recurrenceText(ev.recurrence, T, CTX.lang) }) }) : ui.field(T('p.c.repeat'), repBox)) : null,
        ui.field(T('p.c.location'), location), ui.field(T('p.c.online'), h('div', { class: 'mc-dt' }, [onlineSel, onlineUrl])),
        ui.field(T('p.c.reminders'), reminderBox),
        ui.field(T('p.c.attendees'), h('div', { class: 'mp-col' }, [peopleBox, peopleIn, sugg, senderHint, fromSel])),
        h('div', { class: 'mc-dt' }, [ui.field(T('p.c.show_as'), busy), h('label', { class: 'dp-check', style: 'margin-top:20px' }, [priv, h('span', { text: T('p.c.private') })])]),
        ui.field(T('p.c.description'), desc), err,
        h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), ui.closeDialog), btn(T('p.save'), save, { primary: true })]),
      ];
      ui.dialog(ev ? T('p.c.edit_title') : T('p.c.new_event'), form, { wide: true });
      title.focus();
    }

    /** The time fields `x` (set for occurrence `occ`) moved onto the series `base`: by the same shift. */
    function shiftSeries(x, occ, base) {
      var out = Object.assign({}, x);
      if (x.allDay && occ.allDay && base.allDay && base.startDate) {
        var d1 = Math.round((L.midnight(x.startDate) - L.midnight(occ.startDate)) / L.DAY);
        var d2 = Math.round((L.midnight(x.endDate) - L.midnight(occ.endDate || occ.startDate)) / L.DAY);
        out.startDate = L.addDays(base.startDate, d1);
        out.endDate = L.addDays(base.endDate || base.startDate, d2);
        if (out.endDate < out.startDate) out.endDate = out.startDate;
      } else if (!x.allDay && !occ.allDay && !base.allDay) {
        out.start = base.start + (x.start - occ.start);
        out.end = base.end + (x.end - occ.end);
        if (out.end < out.start) out.end = out.start;
      }
      return out;
    }

    function saved(r) {
      ui.closeDialog();
      var n = r.sent ? (r.sent.mail || 0) + (r.sent.internal || 0) : 0;
      ui.toast(n ? T('p.c.saved_sent', { n: n }) : T('p.saved'));
      if (S.area === 'calendar') fetchRange();
    }

    /** PATCH with the etag; 409 conflict → „Neu laden“ or „Meine Änderung erneut anwenden“. */
    function patch(ev, x) {
      api('PATCH', 'events/' + ev.eventId, x).then(saved, function (e) {
        if (e && e.code === 'conflict' && e.extra && e.extra.current) { conflictDialog(e.extra.current, x); return; }
        ui.toast(ui.errText(e), 'error');
      });
    }
    function conflictDialog(current, x) {
      ui.dialog(T('p.c.conflict_title'), [h('p', { class: 'dp-hint', text: T('p.c.conflict_text') }), h('div', { class: 'dp-actions' }, [
        btn(T('p.c.reload'), function () { viewDialog(current); }),
        btn(T('p.c.apply_mine'), function () { patch(current, Object.assign({}, x, { etag: current.etag })); }, { primary: true }),
      ])]);
    }

    // ── the invitation card in a mail ───────────────────

    /** The card of mail `m` (Message) — the invitation, or (Microsoft without the calendar right) „Kalender freigeben“. */
    function invitationCard(m, summary) {
      if (m.invite) return card(m.invite, m);
      var acc = ui.accountOf(m.accountId);
      if (summary && summary.invite && acc && (acc.missingScopes || []).indexOf(SCOPE) >= 0) {
        return h('div', { class: 'mp-card mc-inv' }, [h('div', { class: 'mc-inv-h' }, [icon('cal'), h('span', { text: T('p.c.invitation') })]),
          h('p', { class: 'dp-hint', text: T('p.c.consent_card') }), h('div', { class: 'dp-actions', style: 'justify-content:flex-start' }, btn(T('p.c.allow_calendar'), function () { ui.relogin(acc); }, { primary: true, small: true }))]);
      }
      return null;
    }

    function card(inv, m) {
      var box = h('div', { class: 'mp-card mc-inv', attrs: { 'aria-label': T('p.c.invitation') } });
      drawCard(box, inv, m, false);
      return box;
    }

    /** The small grid of the day around the invitation (± 1 h), with the events there and the conflicts. */
    function miniDay(inv) {
      if (inv.allDay) return null;
      var from = new Date(inv.start); from.setMinutes(0, 0, 0); from = from.getTime() - 3600000;
      var to = new Date(inv.end); if (to.getMinutes()) to.setHours(to.getHours() + 1, 0, 0, 0); to = to.getTime() + 3600000;
      var hours = Math.min(10, Math.max(2, Math.round((to - from) / 3600000)));
      to = from + hours * 3600000;
      var px = 30;
      var grid = h('div', { class: 'mc-mini', style: 'height:' + (hours * px) + 'px' });
      for (var i = 0; i < hours; i++) grid.appendChild(h('div', { class: 'mc-mslot', style: 'top:' + (i * px) + 'px', text: L.hhmm(from + i * 3600000).slice(0, 2) }));
      var block = function (it, mine) {
        var a = Math.max(it.start, from); var b = Math.min(it.end, to);
        if (b <= a) return null;
        var c = mine ? 'var(--accent)' : colorOf(it);
        return h('div', { class: 'mc-mblk' + (mine ? ' is-mine' : ''), style: 'top:' + ((a - from) / 3600000 * px + 1) + 'px;height:' + Math.max(14, (b - a) / 3600000 * px - 2) + 'px;' + (mine ? 'border-color:' + c + ';color:' + c : 'background:color-mix(in srgb,' + c + ' 20%,transparent)') },
          (mine ? T('p.c.this_invitation', { title: it.title }) : it.title));
      };
      (inv.day || []).forEach(function (it) { if (!it.allDay) { var b = block(it, false); if (b) grid.appendChild(b); } });
      var mine = block(inv, true);
      if (mine) grid.appendChild(mine);
      return grid;
    }

    function responseOf(inv) {
      var a = (inv.attendees || []).filter(function (x) { return x.email === inv.from.email; })[0];
      return a ? a.response : null;
    }

    function drawCard(box, inv, m, changing) {
      clear(box);
      var lang = CTX.lang === 'en' ? 'en' : 'de';
      var head = h('div', { class: 'mc-inv-h' }, [icon('cal'), h('span', { text: T('p.c.kind_' + inv.method) })]);
      var who = inv.method === 'reply' || inv.method === 'counter' ? inv.from : inv.organizer;
      add(box, [head, h('b', { class: 'mc-inv-t', text: inv.title || T('p.c.no_title') }),
        h('div', { class: 'mp-sub', text: (who.name || who.email) + (who.name ? ' <' + who.email + '>' : '') }),
        line('clock', whenText(inv)), inv.location ? line('pin', inv.location) : null,
        inv.recurrence && inv.recurrence.summary ? line('repeat', inv.recurrence.summary[lang] || inv.recurrence.summary.de) : null,
        inv.online ? line('video', T('p.c.online_' + (inv.online.provider || 'other')), btn(T('p.c.join'), function () { ui.linkDialog(inv.online.url, T('p.c.join')); }, { small: true })) : null]);
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var redraw = function (x) { drawCard(box, x, m, false); };
      var act = function (path, body, okText) {
        err.textContent = '';
        return api('POST', 'invitations/' + inv.id + '/' + path, body || {}).then(function (r) {
          if (okText) ui.toast(okText);
          if (r && r.invitation) redraw(r.invitation);
          else api('GET', 'invitations/' + inv.id).then(redraw, function () {});
          if (S.area === 'calendar') fetchRange();
        }, function (e) { err.textContent = ui.errText(e); });
      };
      if (inv.state === 'outdated') {
        box.appendChild(h('div', { class: 'dp-note is-warn' }, [icon('warn'), h('span', { text: T('p.c.outdated') })]));
      } else if (inv.method === 'cancel') {
        box.appendChild(h('div', { class: 'dp-note is-warn' }, [icon('warn'), h('span', { text: inv.state === 'applied' ? T('p.c.cancel_applied') : T('p.c.cancel_text') })]));
        if (inv.state !== 'applied' && inv.eventId) box.appendChild(h('div', { class: 'dp-actions', style: 'justify-content:flex-start' }, btn(T('p.c.remove_from_calendar'), function () { act('apply', null, T('p.c.removed')); }, { small: true, danger: true })));
      } else if (inv.method === 'reply') {
        var resp = responseOf(inv) || 'accepted';
        box.appendChild(h('p', { class: 'mc-inv-state', text: T('p.c.reply_' + resp, { name: inv.from.name || inv.from.email }) }));
      } else if (inv.method === 'counter') {
        if (inv.proposed) box.appendChild(h('p', { class: 'mc-inv-state', text: T('p.c.counter_text', { name: inv.from.name || inv.from.email, when: whenText({ start: inv.proposed.start, end: inv.proposed.end }) }) }));
        if (inv.state === 'open') {
          box.appendChild(h('div', { class: 'mc-ans' }, [btn(T('p.c.counter_apply'), function () { act('apply', null, T('p.c.counter_applied')); }, { primary: true }),
            btn(T('p.c.counter_decline'), function () { act('dismiss', { decline: true }, T('p.c.counter_declined')); })]));
        } else box.appendChild(h('p', { class: 'dp-hint', text: T('p.c.state_' + inv.state) }));
      } else if (inv.state === 'answered' && !changing && inv.myResponse && inv.myResponse !== 'needs_action') {
        box.appendChild(h('div', { class: 'mc-inv-done' }, [h('span', { text: T('p.c.you_' + inv.myResponse) }), h('button', { type: 'button', class: 'mc-link', on: { click: function () { drawCard(box, inv, m, true); } } }, T('p.c.change'))]));
      } else if (inv.state === 'open' || inv.state === 'answered') {
        var grid = miniDay(inv);
        if (grid) box.appendChild(grid);
        if ((inv.conflicts || []).length) box.appendChild(h('p', { class: 'dp-hint mc-conflict', text: T('p.c.conflicts', { list: inv.conflicts.map(function (c) { return c.title; }).join(', ') }) }));
        else if (!inv.allDay) box.appendChild(h('p', { class: 'dp-hint', text: T('p.c.no_conflicts') }));
        var comment = h('input', { class: 'dp-input', type: 'text', placeholder: T('p.c.add_comment') });
        var target = h('select', { class: 'dp-input', attrs: { 'aria-label': T('p.c.enter_in') } });
        var fillTarget = function () {
          clear(target);
          (inv.calendarChoices || []).forEach(function (id) { var c = calOf(id); target.appendChild(h('option', { value: String(id), selected: id === inv.calendarId, text: c ? calName(c) : String(id) })); });
        };
        fillTarget();
        if (!C.loaded) load().then(fillTarget, function () {});
        var ps = h('input', { class: 'dp-input', type: 'datetime-local' });
        var pe = h('input', { class: 'dp-input', type: 'datetime-local' });
        var local = function (ms) { return L.ymd(ms) + 'T' + L.hhmm(ms); };
        ps.value = local(inv.start); pe.value = local(inv.end);
        var propose = h('div', { class: 'mp-col', hidden: true }, [h('div', { class: 'mc-dt' }, [ui.field(T('p.c.start'), ps), ui.field(T('p.c.end'), pe)]),
          h('div', { class: 'dp-actions', style: 'justify-content:flex-start' }, btn(T('p.c.propose_send'), function () {
            var a = new Date(ps.value).getTime(); var b = new Date(pe.value).getTime();
            if (!isFinite(a) || !isFinite(b) || b < a) { err.textContent = T('p.c.date_missing'); return; }
            answer('tentative', { proposeStart: a, proposeEnd: b });
          }, { small: true, primary: true }))]);
        var answer = function (response, extra) {
          var b = Object.assign({ response: response }, extra || {});
          if (comment.value.trim()) b.comment = comment.value.trim();
          if (target.value && Number(target.value) !== inv.calendarId) b.calendarId = Number(target.value);
          act('respond', b, T('p.c.answered_' + response));
        };
        add(box, [
          h('div', { class: 'mc-ans' }, [btn(T('p.c.accept'), function () { answer('accepted'); }, { primary: true }), btn(T('p.c.tentative'), function () { answer('tentative'); }),
            btn(T('p.c.decline'), function () { answer('declined'); }, { danger: true })]),
          comment,
          h('button', { type: 'button', class: 'mc-link', on: { click: function () { propose.hidden = !propose.hidden; } } }, T('p.c.propose')), propose,
          (inv.calendarChoices || []).length ? h('div', { class: 'mc-dt' }, [h('span', { class: 'mp-sub', text: T('p.c.enter_in') }), target]) : null,
        ]);
      } else box.appendChild(h('p', { class: 'dp-hint', text: T('p.c.state_' + inv.state) }));
      if (inv.comment && inv.method !== 'request') box.appendChild(h('p', { class: 'mc-quote', text: '„' + inv.comment + '“' }));
      if ((inv.attendees || []).length && inv.method === 'request') {
        var c = L.countOf(inv.counts);
        var list = h('div', { class: 'mc-att', hidden: true }, [attendeeRow({ name: inv.organizer.name, email: inv.organizer.email, contactId: inv.organizer.contactId }, true)]
          .concat(inv.attendees.filter(function (a) { return a.email !== inv.organizer.email; }).map(function (a) { return attendeeRow(a, false); })));
        box.appendChild(h('button', { type: 'button', class: 'mc-link', on: { click: function () { list.hidden = !list.hidden; } } }, T('p.c.attendees_n', { yes: c.yes, all: c.all })));
        box.appendChild(list);
      }
      box.appendChild(err);
    }

    // ── live ─────────────────────────────────────────────

    var liveTimer = null;
    function onEvent(d) {
      if (!d) return;
      if (d.kind === 'calendars') { C.loaded = false; C.loading = null; }
      if (S.area !== 'calendar') { if (d.kind === 'calendars') C.loaded = false; return; }
      if (liveTimer) clearTimeout(liveTimer);
      liveTimer = setTimeout(function () {
        if (d.kind === 'calendars' || !C.loaded) load().then(function () { ui.renderNav(); renderHead(); fetchRange(); }, function () {});
        else if (d.kind === 'changed' || d.kind === 'invitation' || d.kind === 'conflict') fetchRange();
      }, 500);
    }

    return { nav: nav, show: show, onEvent: onEvent, openEvent: openEvent, invitationCard: invitationCard, newEvent: newEvent, load: load, state: C };
  }

  window.MailCalendar = { attach: attach };
})();
