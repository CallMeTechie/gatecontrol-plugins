/* Mail (gatecontrol-mail) — free/busy, sharing and resources in the portal (since 1.9.0, mockups Planer, Teilen,
 * Ressource, Anfragen): window.MailPlanner.attach(ui, cal) → { section, resourcePicker, bookDialog, requestsDialog,
 * shareDialog, sharedMenu, loadRequests, onResources, resources }.
 *
 *   section    „Frei/Gebucht“ in the event form: a bar per person and resource for the day (working hours), the time
 *              chosen as a frame, who cannot then, „Vorschläge, bei denen alle können“ (a click takes the time over);
 *              never titles — the server sends none
 *   book       „Ressource buchen“: kinds, the day and time, each resource with its day as a bar, booked at once or as a
 *              request to the approvers („Anfrage an Fuhrpark senden“)
 *   requests   „Buchungsanfragen“: open ones (Freigeben / Ablehnen; „Trotzdem freigeben“ when a rule is broken), the
 *              decided ones, the person's own bookings (Absagen) — the first decision settles it for everybody
 *   share      „Kalender teilen“ of an own GateControl calendar: a person (search) or a group (GateControl's picker) at
 *              Frei/Gebucht, Lesen or Bearbeiten, the list with its state, „Frei/Gebucht für alle in GateControl“,
 *              „Mit mir geteilt“ with „Anzeigen“
 * Only self-service here: resources are kept on the plugin's page in GateControl.
 */
(function () {
  'use strict';

  var KIND_ICON = { room: 'M4 4h16v16H4z|M9 20v-5h6v5', vehicle: 'M5 17h14l-1.5-6h-11z|M8 18.5a1.5 1.5 0 1 0 0 .01|M16 18.5a1.5 1.5 0 1 0 0 .01', device: 'M3 6h14v10H3z|M17 10l4-2v8l-4-2', other: 'M12 3l9 5v8l-9 5-9-5V8z' };
  var NS = 'http://www.w3.org/2000/svg';

  function attach(ui, cal) {
    var T = ui.T; var h = ui.h; var add = ui.add; var clear = ui.clear; var icon = ui.icon; var btn = ui.btn;
    var api = ui.api; var L = ui.L; var CTX = ui.CTX; var LOCALE = ui.LOCALE;
    var P = { resources: null, resLoading: null, open: 0, reqTab: null, reqBox: null };

    function kindIcon(kind, color) {
      var s = document.createElementNS(NS, 'svg');
      s.setAttribute('width', '18'); s.setAttribute('height', '18'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
      s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
      (KIND_ICON[kind] || KIND_ICON.other).split('|').forEach(function (d) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); });
      return h('span', { class: 'mr-ic', style: 'background:color-mix(in srgb,' + (color || '#8C96A5') + ' 16%,transparent);color:' + (color || '#8C96A5') }, s);
    }
    function wh() { return (cal.C.prefs && cal.C.prefs.workHours) || { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }; }
    function dayShort(ms) { return new Date(ms).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'numeric' }); }

    /** A bar of [from, to) with blocks; `frame` [start, end] drawn as the chosen time; `cls` for the free part. */
    function bar(blocks, from, to, o) {
      var x = o || {};
      var b = h('div', { class: 'mr-bar' + (x.small ? ' is-small' : '') });
      L.barOf(blocks, from, to, x.gap).forEach(function (seg) { b.appendChild(h('span', { class: 'mr-' + seg.status, style: 'width:' + seg.pct.toFixed(3) + '%' })); });
      if (x.frame && x.frame[1] > from && x.frame[0] < to) {
        var a = Math.max(from, x.frame[0]); var z = Math.min(to, x.frame[1]);
        b.appendChild(h('span', { class: x.sel ? 'mr-selbox' : 'mr-win', style: 'left:' + ((a - from) / (to - from) * 100).toFixed(3) + '%;width:' + ((z - a) / (to - from) * 100).toFixed(3) + '%' }));
      }
      return b;
    }
    function scale(from, to) {
      var out = h('div', { class: 'mr-scale' });
      var a = new Date(from).getHours(); var z = Math.round((to - from) / 3600000) + a;
      var step = z - a > 12 ? 4 : 2;
      for (var hr = a; hr <= z; hr += step) out.appendChild(h('span', { text: String(hr % 24) }));
      return out;
    }
    function legend(kinds) {
      return h('div', { class: 'mr-legend' }, kinds.map(function (k) { return h('span', null, [h('span', { class: 'mr-sw mr-' + k }), T('p.fb.legend_' + k)]); }));
    }

    // ── resources ─────────────────────────────────────────

    function loadResources(force) {
      if (!ui.has('resources')) return Promise.resolve([]);
      if (P.resources && !force) return Promise.resolve(P.resources);
      if (P.resLoading) return P.resLoading;
      P.resLoading = api('GET', 'resources').then(function (r) { P.resources = r.items || []; P.resLoading = null; return P.resources; }, function (e) { P.resLoading = null; throw e; });
      return P.resLoading;
    }
    function resourceByAddress(email) { return (P.resources || []).filter(function (r) { return r.address === email; })[0] || null; }
    function isResource(a) { return a && (a.role === 'resource' || /^resource-\d+@resources\.gatecontrol\.invalid$/.test(a.email)); }
    function resSub(r) {
      var parts = [];
      if (r.location) parts.push(r.location);
      if (r.seats) parts.push(T('p.r.seats', { n: r.seats }));
      if (r.equipment) parts.push(r.equipment);
      parts.push(r.approval === 'approval' ? T('p.r.by', { who: (r.approvers || []).join(', ') || T('p.r.approvers') }) : T('p.r.auto'));
      if (r.rules && r.rules.maxMinutes) parts.push(T('p.r.max', { limit: maxText(r.rules.maxMinutes) }));
      return parts.join(' · ');
    }
    function maxText(m) { return m % 1440 === 0 ? (m === 1440 ? T('p.r.day') : T('p.r.days', { n: m / 1440 })) : T('p.r.hours', { n: Math.round(m / 6) / 10 }); }

    /** The select „Ressource hinzufügen …“ of the event form → adds the resource as an attendee. */
    function resourcePicker(onAdd) {
      if (!ui.has('resources')) return null;
      var sel = h('select', { class: 'dp-input', attrs: { 'aria-label': T('p.r.add') } }, [h('option', { value: '', text: T('p.r.add') })]);
      loadResources().then(function (list) {
        list.forEach(function (r) { sel.appendChild(h('option', { value: String(r.id), text: r.name + (r.approval === 'approval' ? ' · ' + T('p.r.needs_ok') : '') })); });
      }, function () {});
      sel.addEventListener('change', function () {
        var r = (P.resources || []).filter(function (x) { return String(x.id) === sel.value; })[0];
        sel.value = '';
        if (r) onAdd({ email: r.address, name: r.name, role: 'resource' });
      });
      return sel;
    }

    // ── the planner in the event form (mockup Planer) ─────

    /**
     * The section „Frei/Gebucht“: get() → { day, start, end, allDay, attendees: [{ email, name, role }] }; set(start, end)
     * takes a suggestion over. → { el, refresh() }
     */
    function section(get, set) {
      if (!ui.has('freeBusy')) return { el: null, refresh: function () {} };
      var box = h('div', { class: 'mr-fb', attrs: { 'aria-live': 'polite' } });
      var head = h('div', { class: 'mr-fbh' });
      var rowsBox = h('div', { class: 'mr-rows' });
      var msg = h('div', { class: 'mr-msg' });
      var sugg = h('div', { class: 'mr-sugg' });
      add(box, [head, h('div', { class: 'mr-card' }, [rowsBox, msg]), h('b', { class: 'mr-t', text: T('p.fb.suggestions') }), sugg,
        h('p', { class: 'dp-hint', text: T('p.fb.note') }), legend(['free', 'busy', 'tentative', 'unknown'])]);
      var timer = null;
      var seq = 0;
      var last = null;
      var draw = function (v, r, s) {
        var win = L.dayWindow(v.day, wh(), v.allDay ? null : v.start, v.allDay ? null : v.end);
        clear(head);
        add(head, [h('b', { class: 'mr-t', text: T('p.fb.title') }), h('span', { class: 'mp-sub', text: L.dateOf(v.day).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'numeric' }) + ' · ' + T('p.fb.hours', { from: L.hhmm(win.from), to: L.hhmm(win.to) }) })]);
        clear(rowsBox);
        (r.items || []).forEach(function (row) {
          var label = row.kind === 'self' ? T('p.fb.you') : (row.kind === 'person' || row.kind === 'resource') && row.name ? row.name : String(row.email || '').split('@')[0];
          var unknown = row.state !== 'ok';
          rowsBox.appendChild(h('div', { class: 'mr-row' + (unknown ? ' is-unknown' : '') + (row.kind === 'resource' ? ' is-res' : '') }, [
            h('span', { class: 'mr-who', attrs: { title: row.kind === 'self' ? '' : (row.name || row.email || '') + (unknown ? ' · ' + T('p.fb.legend_unknown') : '') } }, [h('span', { class: 'mp-av' }, row.kind === 'self' ? T('p.fb.you') : ui.initials(label)), h('span', { class: 'mp-tx', text: label })]),
            bar(unknown ? [] : row.blocks, win.from, win.to, { gap: unknown ? 'unknown' : 'free', frame: v.allDay ? null : [v.start, v.end] }),
          ]));
        });
        rowsBox.appendChild(h('div', { class: 'mr-row' }, [h('span'), scale(win.from, win.to)]));
        clear(msg);
        if (!v.allDay) {
          var bad = L.clashes(r.items, v.start, v.end).map(function (x) { return x.kind === 'self' ? Object.assign({}, x, { name: T('p.fb.you') }) : x; });
          var unk = (r.items || []).filter(function (x) { return x.state !== 'ok'; });
          if (bad.length) add(msg, [icon('warn'), h('span', { text: T('p.fb.clash', { time: L.hhmm(v.start), list: bad.map(function (x) { return x.name + ' (' + T('p.fb.legend_' + x.status) + ')'; }).join(', ') }) })]);
          else add(msg, [icon('check'), h('span', { text: unk.length ? T('p.fb.all_known_free', { list: unk.map(function (x) { return x.name || x.email; }).join(', ') }) : T('p.fb.all_free') })]);
        }
        clear(sugg);
        var items = (s && s.items) || [];
        if (!items.length) sugg.appendChild(h('span', { class: 'mp-sub', text: T('p.fb.no_suggestions') }));
        items.forEach(function (x) {
          var on = !v.allDay && x.start === v.start;
          sugg.appendChild(h('button', { type: 'button', class: 'mr-chip' + (on ? ' is-on' : ''), attrs: { 'aria-pressed': on ? 'true' : 'false' }, on: { click: function () { set(x.start, x.end); } } },
            (L.ymd(x.start) === v.day ? new Date(x.start).toLocaleDateString(LOCALE, { weekday: 'short' }) : dayShort(x.start)) + ' ' + L.hhmm(x.start)));
        });
      };
      var refresh = function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          var v = get();
          if (!v || !v.day) return;
          var my = ++seq;
          var people = (v.attendees || []).map(function (a) { return a.email; });
          var from = L.midnight(v.day);
          var to = L.midnight(L.addDays(v.day, 1));
          var dur = v.allDay ? 60 : Math.max(15, Math.round((v.end - v.start) / 60000));
          var key = JSON.stringify([v.day, people, v.allDay ? 0 : dur]);
          var q1 = api('POST', 'freebusy', { from: from, to: to, attendees: people });
          var q2 = key === (last && last.key) ? Promise.resolve(last.s) : api('POST', 'freebusy/suggest', { duration: Math.min(1440, dur), from: Math.max(Date.now(), from), attendees: people, limit: 4 }).then(null, function () { return { items: [] }; });
          Promise.all([q1, q2]).then(function (x) {
            if (my !== seq) return;
            last = { key: key, s: x[1] };
            draw(v, x[0], x[1]);
          }, function (e) { if (my === seq) { clear(msg); msg.appendChild(h('span', { class: 'dp-err', text: ui.errText(e) })); } });
        }, 250);
      };
      refresh();
      return { el: box, refresh: refresh };
    }

    // ── „Ressource buchen“ (mockup Ressource) ──────────────

    function bookDialog(pre) {
      var p = pre || {};
      var now = new Date();
      var hr = Math.min(22, now.getHours() + 1);
      var day0 = p.day || L.ymd(now);
      var st = { kind: 'all', sel: null, list: [] };
      var date = h('input', { class: 'dp-input', type: 'date', value: day0, attrs: { 'aria-label': T('p.r.day_field') } });
      var t1 = h('input', { class: 'dp-input', type: 'time', value: p.from || ((hr < 10 ? '0' : '') + hr + ':00'), attrs: { 'aria-label': T('p.c.start') } });
      var t2 = h('input', { class: 'dp-input', type: 'time', value: p.to || ((hr + 1 < 10 ? '0' : '') + (hr + 1) + ':00'), attrs: { 'aria-label': T('p.c.end') } });
      var title = h('input', { class: 'dp-input', type: 'text', placeholder: T('p.r.title_ph'), attrs: { 'aria-label': T('p.c.title_field'), maxlength: '255' } });
      var chips = h('div', { class: 'dp-chips', attrs: { role: 'group', 'aria-label': T('p.r.kinds') } });
      var listBox = h('div', { class: 'mr-list' });
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var span = function () { return { start: L.at(date.value, t1.value || '00:00'), end: L.at(date.value, t2.value || '00:00') }; };
      var drawChips = function () {
        clear(chips);
        ['all', 'room', 'vehicle', 'device', 'other'].forEach(function (k) {
          if (k !== 'all' && !st.list.some(function (r) { return r.kind === k; })) return;
          chips.appendChild(h('button', { type: 'button', attrs: { 'aria-pressed': st.kind === k ? 'true' : 'false' }, on: { click: function () { st.kind = k; drawChips(); drawList(); } } }, T('p.r.kind_' + k)));
        });
      };
      var drawList = function () {
        clear(listBox);
        var s = span();
        var win = L.dayWindow(date.value, { from: '08:00', to: '18:00' }, s.start, s.end);
        var shown = st.list.filter(function (r) { return st.kind === 'all' || r.kind === st.kind; });
        if (!shown.length) listBox.appendChild(h('p', { class: 'dp-hint', text: T('p.r.none') }));
        shown.forEach(function (r) {
          var on = st.sel === r.id;
          var blocks = (r.busy || []).map(function (b) { return { start: b.start, end: b.end, status: b.status === 'busy' ? 'busy' : 'tentative' }; });
          var card = h('div', { class: 'mr-res' + (on ? ' is-on' : '') }, [
            h('button', { type: 'button', class: 'mr-reshead', attrs: { 'aria-pressed': on ? 'true' : 'false' }, on: { click: function () { st.sel = on ? null : r.id; drawList(); } } }, [kindIcon(r.kind, r.color),
              h('span', { class: 'mp-two', style: 'flex:1;min-width:0' }, [h('b', { text: r.name }), h('span', { class: 'mp-sub', text: resSub(r) })])]),
            bar(blocks, win.from, win.to, { frame: on && s.end > s.start ? [s.start, s.end] : null, sel: true }), scale(win.from, win.to),
          ]);
          if (on) {
            var label = r.approval === 'approval' ? T('p.r.request_to', { who: (r.approvers || []).join(', ') || T('p.r.approvers') }) : T('p.r.book_now');
            add(card, [h('span', { class: 'mr-chosen', text: T('p.r.chosen', { from: t1.value, to: t2.value }) + (title.value.trim() ? ' · ' + title.value.trim() : '') }),
              btn(label, function () { book(r); }, { primary: true })]);
          }
          listBox.appendChild(card);
        });
      };
      var load = function () {
        if (!date.value) return;
        api('GET', 'resources', null, { from: L.midnight(date.value), to: L.midnight(L.addDays(date.value, 1)) }).then(function (r) {
          st.list = r.items || [];
          P.resources = st.list;
          drawChips(); drawList();
        }, function (e) { err.textContent = ui.errText(e); });
      };
      var book = function (r) {
        err.textContent = '';
        var s = span();
        if (!(s.end > s.start)) { err.textContent = T('p.c.date_missing'); return; }
        var zone = null;
        try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { zone = null; }
        api('POST', 'resources/' + r.id + '/book', { title: title.value.trim() || r.name, start: s.start, end: s.end, timeZone: zone || undefined }).then(function (x) {
          var b = (x.bookings || [])[0];
          ui.closeDialog();
          ui.toast(b && b.state === 'pending' ? T('p.r.requested', { name: r.name }) : T('p.r.booked', { name: r.name }));
          cal.fetchRange();
        }, function (e) { err.textContent = ui.errText(e) + ruleHint(e); });
      };
      [date].forEach(function (x) { x.addEventListener('change', load); });
      [t1, t2, title].forEach(function (x) { x.addEventListener('change', drawList); });
      ui.dialog(T('p.r.title'), [chips, h('div', { class: 'mc-dt' }, [date, t1, h('span', { class: 'mp-sub', text: '–' }), t2]), title, listBox,
        legend(['free', 'busy', 'tentative', 'sel']), err], { wide: true });
      load();
    }

    /** The rules a refusal names, in words. */
    function ruleHint(e) {
      var v = e && e.extra && e.extra.violations;
      if (!v || !v.length) return '';
      return ' (' + v.map(ruleText).join(', ') + ')';
    }
    function ruleText(v) {
      if (v.rule === 'max_duration') return T('p.r.rule_max', { limit: maxText(v.limit) });
      if (v.rule === 'horizon') return T('p.r.rule_horizon', { n: v.limit });
      return T('p.r.rule_hours', { from: v.from, to: v.to });
    }

    // ── „Buchungsanfragen“ (mockup Anfragen) ───────────────

    function loadRequests() {
      if (!ui.has('bookingRequests')) { P.open = 0; return Promise.resolve(0); }
      return api('GET', 'bookings', null, { state: 'open' }).then(function (r) { P.open = (r.counts && r.counts.open) || 0; return P.open; }, function () { return P.open; });
    }

    function whenOf(b) {
      if (b.allDay) {
        var a = L.dateOf(b.startDate).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'numeric' });
        return (b.endDate && b.endDate !== b.startDate ? a + ' – ' + L.dateOf(b.endDate).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'numeric' }) : a) + ' · ' + T('p.c.all_day');
      }
      return dayShort(b.start) + ' · ' + L.hhmm(b.start) + ' – ' + L.hhmm(b.end);
    }

    function requestsDialog(tab) {
      var tabs = ui.has('bookingRequests') ? ['open', 'done', 'mine'] : ['mine'];
      P.reqTab = tabs.indexOf(tab) >= 0 ? tab : tabs[0];
      var chips = h('div', { class: 'dp-chips', attrs: { role: 'tablist', 'aria-label': T('p.r.requests') } });
      var box = h('div', { class: 'mr-list' });
      P.reqBox = box;
      var draw = function () {
        clear(chips);
        tabs.forEach(function (k) {
          chips.appendChild(h('button', { type: 'button', attrs: { role: 'tab', 'aria-pressed': P.reqTab === k ? 'true' : 'false', 'aria-selected': P.reqTab === k ? 'true' : 'false' },
            on: { click: function () { P.reqTab = k; draw(); fill(); } } }, k === 'open' ? T('p.r.tab_open', { n: P.open }) : T('p.r.tab_' + k)));
        });
      };
      var fill = function () {
        var want = P.reqTab;
        api('GET', 'bookings', null, { state: want }).then(function (r) {
          if (want !== P.reqTab || P.reqBox !== box) return;
          if (want === 'open') P.open = (r.counts && r.counts.open) || 0;
          draw();
          clear(box);
          var items = r.items || [];
          if (!items.length) box.appendChild(h('p', { class: 'dp-hint', text: T('p.r.empty_' + want) }));
          items.forEach(function (b) { box.appendChild(requestCard(b, want, fill)); });
          cal.renderHead();
        }, function (e) { clear(box); box.appendChild(h('p', { class: 'dp-err', text: ui.errText(e) })); });
      };
      P.reqFill = fill;
      draw();
      ui.dialog(T('p.r.requests'), [chips, box, h('p', { class: 'dp-hint', text: T('p.r.requests_note') })], { wide: true, onClose: function () { P.reqBox = null; } });
      fill();
    }

    function requestCard(b, tab, reload) {
      var r = b.resource || { name: '', kind: 'other' };
      var problem = (b.violations || []).length || (b.conflicts || []).length;
      var pill = b.state === 'pending' ? (problem ? ['crit', T('p.r.pill_conflict')] : ['warn', T('p.r.pill_waiting')]) : b.state === 'confirmed' ? ['good', T('p.r.pill_confirmed')] : b.state === 'declined' ? ['crit', T('p.r.pill_declined')] : ['muted', T('p.r.pill_cancelled')];
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var card = h('div', { class: 'mr-req' + (b.state === 'pending' ? (problem ? ' is-crit' : ' is-warn') : '') });
      add(card, [h('div', { class: 'mr-reshead is-static' }, [kindIcon(r.kind, r.color), h('span', { class: 'mp-two', style: 'flex:1;min-width:0' }, [h('b', { text: r.name }),
        h('span', { class: 'mp-sub', text: tab === 'mine' ? (b.title || '') : [b.booker.name, b.title].filter(Boolean).join(' · ') })]), h('span', { class: 'mr-pill is-' + pill[0], text: pill[1] })]),
      h('span', { class: 'mr-when', text: whenOf(b) })]);
      if (!b.allDay && b.state === 'pending') {
        var day = L.ymd(b.start);
        var win = L.dayWindow(day, { from: '08:00', to: '18:00' }, b.start, b.end);
        card.appendChild(bar((b.day || []).map(function (x) { return { start: x.start, end: x.end, status: x.status === 'busy' ? 'busy' : 'tentative' }; }).concat([{ start: b.start, end: b.end, status: 'ask' }]), win.from, win.to, { small: true }));
      }
      var lines = [];
      if ((b.violations || []).length) lines.push(T('p.r.breaks', { list: b.violations.map(ruleText).join(', ') }));
      if ((b.conflicts || []).length) lines.push(T('p.r.taken', { list: b.conflicts.map(function (c) { return L.hhmm(c.start) + '–' + L.hhmm(c.end); }).join(', ') }));
      if (b.state === 'pending' && !lines.length) lines.push(T('p.r.free_ok'));
      if (b.state !== 'pending' && b.decidedBy) lines.push(T('p.r.decided_by', { name: b.decidedBy.name, when: ui.fmtFull(b.decidedAt) }) + (b.override ? ' · ' + T('p.r.override') : ''));
      if (b.comment) lines.push('„' + b.comment + '“');
      if (lines.length) card.appendChild(h('span', { class: 'mp-sub' + (problem && b.state === 'pending' ? ' mr-bad' : ''), text: lines.join(' · ') }));
      var decide = function (decision, override) {
        err.textContent = '';
        api('POST', 'bookings/' + b.id + '/decide', { decision: decision, override: override || undefined }).then(function () {
          ui.toast(decision === 'approve' ? T('p.r.approved') : T('p.r.declined'));
          reload();
        }, function (e) {
          if (e && e.code === 'already_decided') { ui.toast(T('p.r.already', { name: (e.extra && e.extra.decidedBy && e.extra.decidedBy.name) || '' }), 'error'); reload(); return; }
          err.textContent = ui.errText(e) + ruleHint(e);
        });
      };
      if (tab === 'open' && b.canDecide && b.state === 'pending') {
        var approve = (b.conflicts || []).length ? null : (b.violations || []).length ? btn(T('p.r.approve_anyway'), function () { decide('approve', true); }) : btn(T('p.r.approve'), function () { decide('approve'); }, { primary: true });
        card.appendChild(h('div', { class: 'mc-ans' }, [btn(T('p.r.decline'), function () { decide('decline'); }), approve]));
      }
      if (tab === 'mine' && (b.state === 'pending' || b.state === 'confirmed') && b.end > Date.now()) {
        card.appendChild(h('div', { class: 'dp-actions', style: 'justify-content:flex-start' }, btn(T('p.r.cancel'), function () {
          api('DELETE', 'bookings/' + b.id).then(function () { ui.toast(T('p.r.cancelled')); reload(); cal.fetchRange(); }, function (e) { err.textContent = ui.errText(e); });
        }, { small: true, danger: true })));
      }
      card.appendChild(err);
      return card;
    }

    /** Live event `resources`: requests and bookings changed — the counts, an open list, the calendar. */
    function onResources(d) {
      if (!d) return;
      if (d.kind === 'resources') { P.resources = null; return; }
      if (d.kind === 'booking') cal.fetchRange();
      loadRequests().then(function () { cal.renderHead(); if (P.reqBox && P.reqFill) P.reqFill(); }, function () {});
    }

    // ── „Kalender teilen“ (mockup Teilen) ─────────────────

    var LEVELS = ['freebusy', 'read', 'write'];

    function shareDialog(c) {
      var level = 'read';
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var listBox = h('div', { class: 'mr-sharelist' });
      var mineBox = h('div', { class: 'mr-sharelist' });
      var input = h('input', { class: 'dp-input', type: 'text', placeholder: T('p.s.search_ph'), attrs: { autocomplete: 'off', 'aria-label': T('p.s.add') } });
      var sugg = h('div', { class: 'mp-sugglist', hidden: true });
      var seg = h('div', { class: 'dp-seg', attrs: { role: 'group', 'aria-label': T('p.s.level') } });
      var drawSeg = function () {
        clear(seg);
        LEVELS.forEach(function (l) { seg.appendChild(h('button', { type: 'button', attrs: { 'aria-pressed': level === l ? 'true' : 'false' }, on: { click: function () { level = l; drawSeg(); } } }, T('p.s.level_' + l))); });
      };
      drawSeg();
      var fbSw = h('input', { type: 'checkbox', class: 'dp-sw', checked: !(cal.C.prefs && cal.C.prefs.freeBusy === false), attrs: { 'aria-label': T('p.s.fb_all') } });
      fbSw.addEventListener('change', function () {
        api('PUT', 'calendar/settings', { freeBusy: fbSw.checked }).then(function (r) { cal.C.prefs = r.prefs; ui.toast(T('p.saved')); }, function (e) { fbSw.checked = !fbSw.checked; err.textContent = ui.errText(e); });
      });
      var share = function (type, id) {
        err.textContent = '';
        api('POST', 'calendars/' + c.id + '/shares', { type: type, id: id, level: level }).then(function () { input.value = ''; sugg.hidden = true; loadShares(); }, function (e) { err.textContent = ui.errText(e); });
      };
      var timer = null;
      input.addEventListener('input', function () {
        if (timer) clearTimeout(timer);
        var q = input.value.trim();
        if (q.length < 2) { sugg.hidden = true; return; }
        timer = setTimeout(function () {
          api('GET', 'principals', null, { q: q }).then(function (r) {
            clear(sugg);
            (r.items || []).forEach(function (x) {
              sugg.appendChild(h('button', { type: 'button', on: { click: function () { share(x.type, x.id); } } }, x.type === 'group' ? T('p.s.group_entry', { name: x.sub || x.name }) : x.name));
            });
            sugg.hidden = !sugg.firstChild;
          }, function () { sugg.hidden = true; });
        }, 250);
      });
      var pickGroup = window.GC && typeof window.GC.pickPrincipals === 'function' ? btn(T('p.s.pick_group'), function () {
        window.GC.pickPrincipals({ groups: true, users: false, multiple: true, title: T('p.s.add') }).then(function (got) {
          (got || []).forEach(function (x) { if (x.type === 'group') share('group', x.id); });
        });
      }, { small: true, icon: 'people' }) : null;
      var loadShares = function () {
        api('GET', 'calendars/' + c.id + '/shares').then(function (r) {
          clear(listBox);
          if (r.freeBusy != null) fbSw.checked = r.freeBusy;
          if (!(r.items || []).length) listBox.appendChild(h('p', { class: 'dp-hint', style: 'padding:10px 14px', text: T('p.s.none') }));
          (r.items || []).forEach(function (s) {
            var sel = h('select', { class: 'dp-input mr-lvl', attrs: { 'aria-label': T('p.s.level_for', { name: s.name }) } }, LEVELS.map(function (l) { return h('option', { value: l, selected: s.level === l, text: T('p.s.level_' + l) }); })
              .concat([h('option', { value: 'remove', text: T('p.s.remove') })]));
            sel.addEventListener('change', function () {
              var call = sel.value === 'remove' ? api('DELETE', 'calendars/' + c.id + '/shares/' + s.id) : api('PATCH', 'calendars/' + c.id + '/shares/' + s.id, { level: sel.value });
              call.then(loadShares, function (e) { err.textContent = ui.errText(e); loadShares(); });
            });
            listBox.appendChild(h('div', { class: 'mr-share' }, [h('span', { class: 'mp-av' }, s.type === 'group' ? icon('people', 16) : ui.initials(s.name)),
              h('span', { class: 'mp-two', style: 'flex:1;min-width:0' }, [h('b', { text: s.name || '?' }),
                h('span', { class: 'mp-sub', text: s.type === 'group' ? T('p.s.members', { n: s.members || 0 }) : T('p.s.state_' + s.state) })]), sel]));
          });
        }, function (e) { err.textContent = ui.errText(e); });
      };
      var loadMine = function () {
        api('GET', 'shared').then(function (r) {
          clear(mineBox);
          var any = false;
          (r.items || []).forEach(function (x) {
            any = true;
            mineBox.appendChild(h('div', { class: 'mr-share' }, [h('span', { class: 'mc-sq', style: x.visible ? 'background:' + x.color : 'border:2px solid ' + x.color + ';box-sizing:border-box' }),
              h('span', { class: 'mp-two', style: 'flex:1;min-width:0' }, [h('b', { text: T('p.s.from', { name: x.name, owner: x.owner.name }) }), h('span', { class: 'mp-sub', text: T('p.s.level_' + x.level) + (x.group ? ' · ' + x.group : '') })]),
              h('button', { type: 'button', class: 'mr-show' + (x.visible ? ' is-on' : ''), attrs: { 'aria-pressed': x.visible ? 'true' : 'false' }, on: { click: function () {
                api('PATCH', 'shared/' + x.id, { visible: !x.visible }).then(function () { loadMine(); cal.reload(); }, function (e) { err.textContent = ui.errText(e); });
              } } }, T('p.s.show'))]));
          });
          (r.accounts || []).forEach(function (x) {
            any = true;
            var a = ui.accountOf(x.accountId);
            mineBox.appendChild(h('div', { class: 'mr-share' }, [h('span', { class: 'mc-sq', style: 'background:' + x.color }),
              h('span', { class: 'mp-two', style: 'flex:1;min-width:0' }, [h('b', { text: x.name + (a ? ' · ' + (a.name || a.email) : '') }), h('span', { class: 'mp-sub', text: x.owner.email + ' · ' + (x.writable ? T('p.s.level_write') : T('p.s.level_read')) })]),
              h('button', { type: 'button', class: 'mr-show' + (x.visible ? ' is-on' : ''), attrs: { 'aria-pressed': x.visible ? 'true' : 'false' }, on: { click: function () {
                api('PATCH', 'calendars/' + x.calendarId, { visible: !x.visible }).then(function () { loadMine(); cal.reload(); }, function (e) { err.textContent = ui.errText(e); });
              } } }, T('p.s.show'))]));
          });
          if (!any) mineBox.appendChild(h('p', { class: 'dp-hint', style: 'padding:10px 14px', text: T('p.s.mine_none') }));
        }, function () {});
      };
      ui.dialog(T('p.s.title'), [
        h('div', { class: 'mc-line' }, [h('span', { class: 'mc-sq', style: 'background:' + c.color }), h('b', { style: 'flex:1', text: c.name }), h('span', { class: 'mp-sub', text: T('p.s.gc_calendar') })]),
        h('div', { class: 'mr-card' }, [h('b', { text: T('p.s.add') }), h('div', { class: 'mc-dt' }, [input, pickGroup]), sugg, seg, h('p', { class: 'dp-hint', text: T('p.s.levels_note') })]),
        h('b', { class: 'mr-t', text: T('p.s.shared_with') }), h('div', { class: 'mr-card is-flush' }, listBox),
        h('div', { class: 'mr-card' }, h('label', { class: 'mp-swrow' }, [h('span', { class: 'mp-two', style: 'flex:1;min-width:0' }, [h('b', { text: T('p.s.fb_all') }), h('span', { class: 'mp-sub', text: T('p.s.fb_all_d') })]), fbSw])),
        h('b', { class: 'mr-t', text: T('p.s.with_me') }), h('div', { class: 'mr-card is-flush' }, mineBox),
        h('p', { class: 'dp-hint', text: T('p.s.accounts_note') }), err,
      ], { wide: false });
      loadShares();
      loadMine();
    }

    /** A calendar shared with the person (the menu's „…“): owner, level, colour, hide. */
    function sharedMenu(x) {
      var color = h('input', { class: 'dp-input', type: 'color', value: x.color, style: 'width:64px;padding:2px', attrs: { 'aria-label': T('p.c.color') } });
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      ui.dialog(x.name, [
        h('p', { class: 'dp-hint', text: T('p.s.info', { owner: x.owner.name, level: T('p.s.level_' + x.level) }) + (x.group ? ' · ' + T('p.s.via', { group: x.group }) : '') }),
        ui.field(T('p.c.color'), color), err,
        h('div', { class: 'dp-actions' }, [btn(x.visible ? T('p.s.hide') : T('p.s.show'), function () {
          api('PATCH', 'shared/' + x.id, { visible: !x.visible }).then(function () { ui.closeDialog(); cal.reload(); }, function (e) { err.textContent = ui.errText(e); });
        }), btn(T('p.save'), function () {
          api('PATCH', 'shared/' + x.id, { color: color.value.toUpperCase() }).then(function () { ui.closeDialog(); cal.reload(); }, function (e) { err.textContent = ui.errText(e); });
        }, { primary: true })]),
      ]);
    }

    return {
      section: section, resourcePicker: resourcePicker, isResource: isResource, resourceByAddress: resourceByAddress, bookDialog: bookDialog, requestsDialog: requestsDialog,
      shareDialog: shareDialog, sharedMenu: sharedMenu, loadRequests: loadRequests, onResources: onResources, loadResources: loadResources, state: P,
    };
  }

  window.MailPlanner = { attach: attach };
})();
