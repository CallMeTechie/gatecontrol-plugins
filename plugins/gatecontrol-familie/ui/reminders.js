/* Rules and reminders (1.9.0, mockup ReminderServer) — the admin page „Regeln & Erinnerungen“
   (API admin/rules/…) and the portal section of the same name (API rules/…): on the left the rules
   with the filter Alle / Erinnerungen / Anwesenheit / Orte (icon, title, a summary, the switch to
   pause), the run log below; on the right the editor in three columns 1 · Wann (trigger: schedule
   with weekdays and time, presence, places) · 2 · Nur wenn (all of: time window, after sunset, a
   device value with its current value, an event today / tomorrow) · 3 · Dann (notification with
   facts and buttons, chat message, switching devices), the title and „Gehört zu“ above, the dry run
   („Probelauf“, POST …/test) and „Speichern“ below. What the editor offers comes from …/options. */
(function () {
  'use strict';
  var A = window.FA, T = A.T, el = A.el;
  var WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
  var FILTERS = ['all', 'reminder', 'presence', 'place'];
  var OPS = ['<', '<=', '>', '>=', '='];
  var ICON = {
    reminder: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21a2 2 0 0 0 4 0',
    presence: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
    place: 'M12 3a6 6 0 0 0-6 6c0 4.5 6 12 6 12s6-7.5 6-12a6 6 0 0 0-6-6zM12 11a2 2 0 1 0 0-4a2 2 0 0 0 0 4',
    x: 'M6 6l12 12M18 6L6 18',
  };

  function name(opts, id) {
    var m = (opts.people || []).filter(function (p) { return p.userId === id; })[0];
    return m ? m.name : '–';
  }
  function dayName(d) { return T('rr.wd_' + d); }
  function weekdaysText(w) {
    if (!w || !w.length) return '–';
    if (w.length === 7) return T('rr.daily');
    if (w.join(',') === '1,2,3,4,5') return dayName(1) + '–' + dayName(5);
    return w.map(dayName).join(', ');
  }
  function deviceLabel(opts, actionId) {
    var d = (opts.devices || []).filter(function (x) { return x.actionId === actionId; })[0];
    if (d) return d.label;
    var a = (opts.actions || []).filter(function (x) { return x.actionId === actionId; })[0];
    return a ? a.title : actionId.split('/')[1];
  }

  /** „So 18:00 · Elroq < 50 % · morgen „Arbeit““ — the summary of a rule row. */
  function summary(rule, opts) {
    var t = rule.trigger;
    var parts = [];
    if (t.type === 'schedule') parts.push(weekdaysText(t.weekdays) + ' ' + (t.time || ''));
    else if (t.type === 'person_home' || t.type === 'person_away') parts.push(T('rr.trig_' + t.type + '_s', { name: name(opts, t.userId) }));
    else if (t.type === 'place_enter' || t.type === 'place_exit') parts.push(T('rr.trig_' + t.type + '_s', { name: t.userId ? name(opts, t.userId) : T('rr.someone'), place: t.placeName || '–' }));
    else if (t.type === 'all_away') parts.push(T('rr.trig_all_away_s', { n: t.graceMinutes || 0 }));
    else parts.push(T('rr.trig_' + t.type));
    var c = rule.conditions || {};
    if (c.time) parts.push(c.time.from + '–' + c.time.to);
    if (c.afterSunset) parts.push(T('rr.sunset_short'));
    (c.device || []).forEach(function (d) { parts.push((d.label || deviceLabel(opts, d.actionId)) + ' ' + d.op + ' ' + d.value + (d.unit ? ' ' + d.unit : '')); });
    if (c.calendar) parts.push(T(c.calendar.dayOffset ? 'rr.cal_tomorrow_s' : 'rr.cal_today_s', { match: c.calendar.match || T('rr.cal_any') }));
    var n = rule.actions.length;
    parts.push(n === 1 ? T('rr.actions_1') : T('rr.actions_n', { n: n }));
    return parts.join(' · ');
  }

  /**
   * Mount into `root`; o = { base: 'admin/rules' | 'rules', add: button, banner: node | null, writable }.
   * → { reload }
   */
  function mount(root, o) {
    var data = null;
    var opts = null;
    var filter = 'all';
    var selected = null; // rule id, or 'new'
    var list = el('div', { class: 'fa-rr-list', role: 'list' });
    var tabs = el('div', { class: 'fa-rr-tabs', role: 'tablist', 'aria-label': T('rr.filter') });
    var logBox = el('div', { class: 'fa-rr-log' });
    var editor = el('section', { class: 'fa-rr-editor', 'aria-label': T('rr.editor') });
    A.clear(root).appendChild(el('div', { class: 'fa-rr' }, [
      el('section', { class: 'fa-rr-side', 'aria-label': T('rr.title') }, [tabs, list, el('details', { class: 'fa-rr-logwrap' }, [el('summary', { class: 'fa-opt-title', text: T('rr.log') }), logBox])]),
      editor,
    ]));

    function renderTabs() {
      A.clear(tabs);
      FILTERS.forEach(function (f) {
        tabs.appendChild(el('button', { type: 'button', role: 'tab', class: 'fa-rr-tab' + (filter === f ? ' is-on' : ''), 'aria-selected': filter === f ? 'true' : 'false', text: T('rr.filter_' + f),
          on: { click: function () { filter = f; renderTabs(); renderList(); } } }));
      });
    }

    function renderList() {
      A.clear(list);
      var rules = data.rules.filter(function (r) { return filter === 'all' || r.kind === filter; });
      if (!rules.length) list.appendChild(el('p', { class: 'fa-empty', text: data.rules.length ? T('rr.none_filter') : T('rr.none') }));
      rules.forEach(function (r) {
        var row = el('div', { class: 'fa-rr-rule' + (selected === r.id ? ' is-sel' : '') + (r.active ? '' : ' is-off'), role: 'listitem' }, [
          el('button', { type: 'button', class: 'fa-rr-rule-main', 'aria-pressed': selected === r.id ? 'true' : 'false', on: { click: function () { select(r.id); } } }, [
            el('span', { class: 'fa-rr-ic is-' + r.kind }, [A.svg(ICON[r.kind] || ICON.reminder, 20)]),
            el('span', { class: 'fa-rr-t' }, [
              el('b', { text: r.title || T('rr.untitled') }),
              el('small', { text: summary(r, opts) }),
              el('small', { class: 'fa-rr-meta' + (r.lastResult && !r.lastResult.ok && !r.lastResult.skipped ? ' fa-bad' : ''), text: [
                r.scope === 'personal' ? T('rr.personal_of', { name: r.ownerName || '–' }) : T('rr.house'),
                r.lastRunAt ? T('rr.last', { when: A.when(r.lastRunAt) }) : T('rr.never'),
              ].join(' · ') }),
            ]),
          ]),
        ]);
        if (r.pausable && o.writable) {
          row.appendChild(A.switchBtn(r.active, T('rr.active_aria', { name: r.title || T('rr.untitled') }), function (on, b) {
            A.api('PATCH', o.base + '/' + r.id, { active: on }).then(load).catch(function (e) { A.setSwitch(b, !on); A.warn(e); });
          }));
        }
        list.appendChild(row);
      });
    }

    function renderLog() {
      A.clear(logBox);
      if (!data.log.length) { logBox.appendChild(el('p', { class: 'fa-empty', text: T('rr.log_empty') })); return; }
      data.log.slice(0, 20).forEach(function (x) {
        var res = x.results.map(function (y) {
          if (y.type === 'condition') return y.text || T('rr.not_met');
          if (y.type === 'quick_action') return (y.title || y.id) + ': ' + (y.ok ? T('rr.ok') : (y.error || T('rr.failed')));
          if (y.type === 'notify') return T('rr.notify') + ': ' + (y.ok ? T('rr.sent_n', { n: y.sent || 0 }) : (y.error || T('rr.failed')));
          return T('rr.messenger') + ': ' + (y.ok ? T('rr.ok') : (y.error || T('rr.failed')));
        }).join(' · ');
        logBox.appendChild(el('div', { class: 'fa-rr-logrow' }, [
          el('span', { class: 'fa-time', text: A.when(x.at) }),
          el('span', { text: (x.ruleTitle || x.ruleName || '#' + x.ruleId) + (x.trigger === 'button' ? ' · ' + T('rr.log_button') : '') }),
          el('span', { class: x.ok ? 'fa-ok' : (x.skipped ? 'fa-muted' : 'fa-bad'), text: x.skipped ? T('rr.skipped') + ' – ' + res : (res || '–') }),
        ]));
      });
    }

    function select(id) {
      selected = id;
      renderList();
      renderEditor();
    }

    // ── the editor ──────────────────────────────────────────────────────────

    function blank() {
      var house = data.can.house;
      return {
        id: null, title: '', scope: house ? 'house' : 'personal', active: true, editable: true,
        trigger: { type: 'schedule', weekdays: [1, 2, 3, 4, 5], time: '07:00' },
        conditions: { time: null, afterSunset: false, device: [], calendar: null },
        actions: [{ type: 'notify', to: house ? 'parents' : 'me', text: null, facts: true, buttons: ['snooze_1h', 'done'] }],
      };
    }

    function renderEditor() {
      A.clear(editor);
      var rule = selected === 'new' ? blank() : data.rules.filter(function (r) { return r.id === selected; })[0];
      if (!rule) {
        editor.appendChild(el('div', { class: 'fa-rr-empty' }, [el('p', { class: 'fa-empty', text: (data.can.house || data.can.personal) ? T('rr.pick') : T('rr.cannot') })]));
        return;
      }
      var canEdit = o.writable && rule.editable !== false;
      var st = JSON.parse(JSON.stringify(rule));
      if (st.trigger.type === 'schedule' && !st.trigger.weekdays) st.trigger.weekdays = [];
      var uid = 'fa-rr-' + Math.random().toString(36).slice(2, 8);
      var msg = el('span', { class: 'fa-msg', role: 'status', 'aria-live': 'polite' });
      var probe = el('span', { class: 'fa-rr-probe-text' }, [el('b', { text: T('rr.probe') + ' ' }), el('span', { text: T('rr.probe_hint') })]);

      // header: title and owner
      var title = el('input', { class: 'form-input', type: 'text', maxlength: '60', id: uid + '-title', value: st.title, placeholder: T('rr.title_ph'), disabled: !canEdit });
      title.addEventListener('input', function () { st.title = title.value; });
      var scopeSel = el('select', { class: 'form-select', id: uid + '-scope', disabled: !canEdit || !!st.id }, [
        data.can.house || st.scope === 'house' ? el('option', { value: 'house', text: T('rr.scope_house') }) : null,
        data.can.personal || st.scope === 'personal' ? el('option', { value: 'personal', text: st.id && st.ownerName ? T('rr.scope_personal_of', { name: st.ownerName }) : T('rr.scope_personal') }) : null,
      ]);
      scopeSel.value = st.scope;
      scopeSel.addEventListener('change', function () {
        st.scope = scopeSel.value;
        if (st.scope === 'personal') st.actions.forEach(function (a) { if (a.type === 'notify' || a.type === 'messenger') a.to = 'me'; });
        renderThen();
      });
      editor.appendChild(el('div', { class: 'fa-rr-top' }, [
        el('label', { class: 'fa-rr-f fa-rr-grow', for: uid + '-title' }, [el('span', { text: T('rr.title_label') }), title]),
        el('label', { class: 'fa-rr-f', for: uid + '-scope' }, [el('span', { text: T('rr.scope') }), scopeSel]),
      ]));

      var colWhen = el('div', { class: 'fa-rr-col' });
      var colIf = el('div', { class: 'fa-rr-col' });
      var colThen = el('div', { class: 'fa-rr-col' });
      editor.appendChild(el('div', { class: 'fa-rr-cols' }, [colWhen, colIf, colThen]));

      function sel(options, value, onChange, label, k) {
        var s = el('select', { class: 'form-select', 'aria-label': label, disabled: !canEdit, 'data-k': k || null }, options.map(function (x) {
          return el('option', { value: String(x.value), text: x.label, disabled: x.disabled || null });
        }));
        s.value = String(value == null ? '' : value);
        s.addEventListener('change', function () { onChange(s.value); });
        return s;
      }
      function field(label, node) { return el('label', { class: 'fa-rr-f' }, [el('span', { text: label }), node]); }
      function box(head, kids, remove) {
        return el('div', { class: 'fa-rr-box' }, [
          el('div', { class: 'fa-rr-box-head' }, [el('b', { text: head }), el('span', { class: 'fa-spacer' }),
            remove && canEdit ? el('button', { type: 'button', class: 'fa-rr-x', 'aria-label': T('rr.remove', { name: head }), on: { click: remove } }, [A.svg(ICON.x, 14)]) : null]),
        ].concat(kids));
      }

      // ── 1 · Wann ──
      function renderWhen() {
        A.clear(colWhen);
        colWhen.appendChild(el('span', { class: 'fa-rr-lbl', text: T('rr.col_when') }));
        var t = st.trigger;
        colWhen.appendChild(field(T('rr.trigger'), sel((opts.triggers || []).map(function (x) {
          return { value: x.type, label: T('rr.trig_' + x.type) + (x.available ? '' : ' – ' + T('rr.needs_presence')), disabled: !x.available && x.type !== t.type };
        }), t.type, function (v) {
          st.trigger = v === 'schedule' ? { type: v, weekdays: [1, 2, 3, 4, 5], time: '07:00' } : (v === 'all_away' ? { type: v, graceMinutes: 10 } : { type: v, userId: null, placeId: null });
          if ((v === 'person_home' || v === 'person_away') && opts.people.length) st.trigger.userId = opts.people[0].userId;
          if ((v === 'place_enter' || v === 'place_exit') && opts.places.length) st.trigger.placeId = opts.places[0].id;
          renderWhen();
        }, T('rr.trigger'), 'trigger')));
        if (t.type === 'schedule') {
          colWhen.appendChild(el('div', { class: 'fa-rr-days', role: 'group', 'aria-label': T('rr.days') }, WEEKDAYS.map(function (d) {
            var on = t.weekdays.indexOf(d) >= 0;
            return el('button', { type: 'button', class: 'fa-rr-day' + (on ? ' is-on' : ''), 'aria-pressed': on ? 'true' : 'false', disabled: !canEdit, text: dayName(d),
              on: { click: function () { t.weekdays = on ? t.weekdays.filter(function (x) { return x !== d; }) : t.weekdays.concat([d]).sort(); renderWhen(); } } });
          })));
          var time = el('input', { class: 'form-input', type: 'time', value: t.time || '', disabled: !canEdit });
          time.addEventListener('input', function () { t.time = time.value; });
          colWhen.appendChild(field(T('rr.time'), time));
        } else if (t.type === 'person_home' || t.type === 'person_away') {
          colWhen.appendChild(field(T('rr.who'), sel(opts.people.map(function (p) { return { value: p.userId, label: p.name }; }), t.userId, function (v) { t.userId = Number(v); }, T('rr.who'))));
        } else if (t.type === 'place_enter' || t.type === 'place_exit') {
          colWhen.appendChild(field(T('rr.place'), opts.places.length ? sel(opts.places.map(function (p) { return { value: p.id, label: p.name }; }), t.placeId, function (v) { t.placeId = Number(v); }, T('rr.place'))
            : el('span', { class: 'fa-hint', text: T('rr.no_places') })));
          colWhen.appendChild(field(T('rr.who'), sel([{ value: '', label: T('rr.someone') }].concat(opts.people.map(function (p) { return { value: p.userId, label: p.name }; })), t.userId || '',
            function (v) { t.userId = v ? Number(v) : null; }, T('rr.who'))));
        } else if (t.type === 'all_away') {
          var grace = el('input', { class: 'form-input', type: 'number', min: '0', max: '120', step: '5', value: String(t.graceMinutes == null ? 10 : t.graceMinutes), disabled: !canEdit });
          grace.addEventListener('input', function () { t.graceMinutes = Math.max(0, Math.min(120, parseInt(grace.value, 10) || 0)); });
          colWhen.appendChild(field(T('rr.grace'), grace));
        }
        colWhen.appendChild(el('span', { class: 'fa-hint', text: T('rr.when_hint') }));
      }

      // ── 2 · Nur wenn ──
      function renderIf() {
        A.clear(colIf);
        colIf.appendChild(el('span', { class: 'fa-rr-lbl', text: T('rr.col_if') }));
        var c = st.conditions;
        if (c.time) {
          var from = el('input', { class: 'form-input', type: 'time', value: c.time.from, disabled: !canEdit });
          var to = el('input', { class: 'form-input', type: 'time', value: c.time.to, disabled: !canEdit });
          from.addEventListener('input', function () { c.time.from = from.value; });
          to.addEventListener('input', function () { c.time.to = to.value; });
          colIf.appendChild(box(T('rr.c_time'), [el('div', { class: 'fa-rr-pair' }, [field(T('rr.from'), from), field(T('rr.to'), to)])], function () { c.time = null; renderIf(); }));
        }
        if (c.afterSunset) colIf.appendChild(box(T('rr.c_sunset'), [el('span', { class: 'fa-hint', text: opts.location ? T('rr.sunset_hint') : T('rr.sunset_none') })], function () { c.afterSunset = false; renderIf(); }));
        c.device.forEach(function (d, i) {
          var dev = (opts.devices || []).filter(function (x) { return x.actionId === d.actionId; })[0];
          var fields = dev ? dev.fields : [{ id: d.field, label: d.label || d.field, unit: d.unit, current: null }];
          var fdef = fields.filter(function (x) { return x.id === d.field; })[0] || fields[0];
          var value = el('input', { class: 'form-input', type: 'number', step: 'any', value: String(d.value), disabled: !canEdit, 'aria-label': T('rr.value') });
          value.addEventListener('input', function () { var n = parseFloat(value.value); d.value = isFinite(n) ? n : 0; });
          var devOptions = (opts.devices || []).map(function (x) { return { value: x.actionId, label: x.label }; });
          if (!dev) devOptions.unshift({ value: d.actionId, label: d.label || deviceLabel(opts, d.actionId) });
          colIf.appendChild(box(T('rr.c_device'), [
            sel(devOptions, d.actionId, function (v) {
              var nd = opts.devices.filter(function (x) { return x.actionId === v; })[0];
              d.actionId = v; d.field = nd.fields[0].id; d.label = nd.fields[0].label; d.unit = nd.fields[0].unit;
              renderIf();
            }, T('rr.device')),
            el('div', { class: 'fa-rr-pair' }, [
              sel(fields.map(function (f) { return { value: f.id, label: f.label }; }), d.field, function (v) {
                var f = fields.filter(function (x) { return x.id === v; })[0];
                d.field = v; d.label = f ? f.label : null; d.unit = f ? f.unit : null; renderIf();
              }, T('rr.field')),
              sel(OPS.map(function (x) { return { value: x, label: x }; }), d.op, function (v) { d.op = v; }, T('rr.op')),
              value,
              fdef && fdef.unit ? el('span', { class: 'fa-rr-unit', text: fdef.unit }) : null,
            ]),
            el('span', { class: 'fa-hint', text: fdef && fdef.current ? T('rr.now', { value: fdef.current }) : (opts.features && opts.features.deviceValues ? T('rr.now_unknown') : T('rr.values_old')) }),
          ], function () { c.device.splice(i, 1); renderIf(); }));
        });
        if (c.calendar) {
          var cal = c.calendar;
          var match = el('input', { class: 'form-input', type: 'text', maxlength: '60', value: cal.match || '', placeholder: T('rr.match_ph'), disabled: !canEdit });
          match.addEventListener('input', function () { cal.match = match.value; });
          var srcs = el('div', { class: 'fa-rr-checks' }, (opts.calendars || []).map(function (s) {
            var cb = el('input', { type: 'checkbox', checked: cal.sources.indexOf(s.source) >= 0, disabled: !canEdit });
            cb.addEventListener('change', function () {
              cal.sources = cb.checked ? cal.sources.concat([s.source]) : cal.sources.filter(function (x) { return x !== s.source; });
            });
            return el('label', { class: 'check' }, [cb, s.label]);
          }));
          colIf.appendChild(box(T('rr.c_calendar'), [
            sel([{ value: 0, label: T('rr.today') }, { value: 1, label: T('rr.tomorrow') }], cal.dayOffset, function (v) { cal.dayOffset = Number(v); }, T('rr.day')),
            srcs, field(T('rr.match'), match),
          ], function () { c.calendar = null; renderIf(); }));
        }
        if (canEdit) {
          var add = [{ value: '', label: T('rr.add_condition') }];
          if (!c.time) add.push({ value: 'time', label: T('rr.c_time') });
          if (!c.afterSunset) add.push({ value: 'sunset', label: T('rr.c_sunset') });
          if (c.device.length < 4) add.push({ value: 'device', label: T('rr.c_device'), disabled: !(opts.devices || []).length });
          if (!c.calendar) add.push({ value: 'calendar', label: T('rr.c_calendar'), disabled: !(opts.calendars || []).length });
          colIf.appendChild(sel(add, '', function (v) {
            if (v === 'time') c.time = { from: '06:00', to: '22:00' };
            if (v === 'sunset') c.afterSunset = true;
            if (v === 'device' && opts.devices.length) { var d0 = opts.devices[0]; c.device.push({ actionId: d0.actionId, field: d0.fields[0].id, op: '<', value: 50, label: d0.fields[0].label, unit: d0.fields[0].unit }); }
            if (v === 'calendar') c.calendar = { dayOffset: 1, sources: [opts.calendars[0].source], match: '', memberIds: null };
            renderIf();
          }, T('rr.add_condition'), 'add-condition'));
          if (!(opts.devices || []).length) colIf.appendChild(el('span', { class: 'fa-hint', text: opts.features && opts.features.deviceValues ? T('rr.no_devices') : T('rr.values_old') }));
        }
        if (!c.time && !c.afterSunset && !c.device.length && !c.calendar) colIf.appendChild(el('span', { class: 'fa-hint', text: T('rr.always') }));
      }

      // ── 3 · Dann ──
      function renderThen() {
        A.clear(colThen);
        colThen.appendChild(el('span', { class: 'fa-rr-lbl', text: T('rr.col_then') }));
        var personal = st.scope === 'personal';
        var toOptions = function (msgr) {
          var out = [{ value: 'me', label: T('rr.to_me') }];
          if (!personal) {
            if (msgr) out.push({ value: 'family', label: T('rr.to_family') });
            else out.push({ value: 'parents', label: T('rr.to_parents') }, { value: 'all', label: T('rr.to_all') });
            opts.people.forEach(function (p) { out.push({ value: 'u' + p.userId, label: p.name }); });
          }
          return out;
        };
        var toValue = function (to) {
          if (Array.isArray(to)) return to.length === 1 && to[0] === meId() ? 'me' : 'u' + to[0];
          return to;
        };
        var fromValue = function (v) { return v === 'me' ? 'me' : (v.charAt(0) === 'u' ? [Number(v.slice(1))] : v); };
        st.actions.forEach(function (a, i) {
          var remove = function () { st.actions.splice(i, 1); renderThen(); };
          if (a.type === 'notify') {
            var text = el('input', { class: 'form-input', type: 'text', maxlength: '120', value: a.text || '', placeholder: T('rr.text_ph'), disabled: !canEdit });
            text.addEventListener('input', function () { a.text = text.value; });
            var check = function (label, on, set) {
              var cb = el('input', { type: 'checkbox', checked: on, disabled: !canEdit });
              cb.addEventListener('change', function () { set(cb.checked); });
              return el('label', { class: 'check' }, [cb, label]);
            };
            var buttons = a.buttons || (a.buttons = []);
            var has = function (b) { return buttons.indexOf(b) >= 0; };
            var toggleBtn = function (b, on) { if (on && !has(b) && buttons.length < 3) buttons.push(b); if (!on) a.buttons = buttons = buttons.filter(function (x) { return x !== b; }); };
            var qa = buttons.filter(function (b) { return b.indexOf('quick_action:') === 0; })[0] || '';
            var qaOptions = [{ value: '', label: T('rr.btn_none') }].concat((opts.actions || []).filter(function (x) { return x.kind !== 'toggle'; }).map(function (x) {
              return { value: 'quick_action:' + x.actionId, label: (x.device && x.device.title && x.device.title !== x.title ? x.device.title + ' – ' : '') + x.title };
            }));
            colThen.appendChild(box(T('rr.a_notify'), [
              field(T('rr.to'), sel(toOptions(false), toValue(a.to), function (v) { a.to = fromValue(v); }, T('rr.to'))),
              field(T('rr.text'), text),
              el('span', { class: 'fa-hint', text: T('rr.text_hint') }),
              check(T('rr.facts'), a.facts === true, function (v) { a.facts = v; }),
              el('span', { class: 'fa-rr-sub', text: T('rr.buttons') }),
              check(T('rr.btn_snooze'), has('snooze_1h'), function (v) { toggleBtn('snooze_1h', v); }),
              check(T('rr.btn_done'), has('done'), function (v) { toggleBtn('done', v); }),
              field(T('rr.btn_device'), sel(qaOptions, qa, function (v) {
                a.buttons = buttons = buttons.filter(function (x) { return x.indexOf('quick_action:') !== 0; });
                if (v) buttons.unshift(v);
                a.buttons = buttons = buttons.slice(0, 3);
              }, T('rr.btn_device'))),
              opts.features && opts.features.buttons ? null : el('span', { class: 'fa-hint', text: T('rr.buttons_old') }),
            ], remove));
          } else if (a.type === 'messenger') {
            var mtext = el('input', { class: 'form-input', type: 'text', maxlength: '500', value: a.text || '', placeholder: T('rr.text_ph'), disabled: !canEdit });
            mtext.addEventListener('input', function () { a.text = mtext.value; });
            colThen.appendChild(box(T('rr.a_messenger'), [
              field(T('rr.to'), sel(toOptions(true), toValue(a.to), function (v) { a.to = fromValue(v); }, T('rr.to'))),
              field(T('rr.text'), mtext),
              opts.messenger && opts.messenger.available ? null : el('span', { class: 'fa-hint', text: T('rr.messenger_gone') }),
            ], remove));
          } else if (a.type === 'quick_action') {
            var act = (opts.actions || []).filter(function (x) { return x.actionId === a.actionId; })[0];
            var actOptions = (opts.actions || []).map(function (x) { return { value: x.actionId, label: (x.pluginName ? x.pluginName + ' · ' : '') + (x.device && x.device.title && x.device.title !== x.title ? x.device.title + ' – ' : '') + x.title }; });
            if (!act) actOptions.unshift({ value: a.actionId, label: (a.title || a.actionId) + ' – ' + T('rr.gone') });
            var kids = [sel(actOptions, a.actionId, function (v) {
              var x = opts.actions.filter(function (y) { return y.actionId === v; })[0];
              a.actionId = v; a.title = x ? x.title : null; a.state = x && x.kind === 'toggle' ? 'on' : null; renderThen();
            }, T('rr.a_device'))];
            if (act && act.kind === 'toggle') {
              var v = act.verbs && act.verbs.on ? act.verbs : { on: T('rr.on'), off: T('rr.off') };
              kids.push(sel([{ value: 'on', label: v.on }, { value: 'off', label: v.off }], a.state || 'on', function (val) { a.state = val; }, T('rr.state')));
              if (!a.state) a.state = 'on';
            }
            colThen.appendChild(box(T('rr.a_device'), kids, remove));
          }
        });
        if (canEdit) {
          var add = [{ value: '', label: T('rr.add_action') }];
          if (!st.actions.some(function (a) { return a.type === 'notify'; })) add.push({ value: 'notify', label: T('rr.a_notify') });
          if (!st.actions.some(function (a) { return a.type === 'messenger'; })) add.push({ value: 'messenger', label: T('rr.a_messenger'), disabled: !(opts.messenger && opts.messenger.available) });
          add.push({ value: 'quick_action', label: T('rr.a_device'), disabled: !(opts.actions || []).length });
          colThen.appendChild(sel(add, '', function (v) {
            if (v === 'notify') st.actions.push({ type: 'notify', to: personal ? 'me' : 'parents', text: null, facts: true, buttons: ['snooze_1h', 'done'] });
            if (v === 'messenger') st.actions.push({ type: 'messenger', to: personal ? 'me' : 'family', text: null });
            if (v === 'quick_action' && opts.actions.length) { var x = opts.actions[0]; st.actions.push({ type: 'quick_action', actionId: x.actionId, title: x.title, state: x.kind === 'toggle' ? 'on' : null }); }
            renderThen();
          }, T('rr.add_action'), 'add-action'));
        }
        if (!st.actions.length) colThen.appendChild(el('span', { class: 'fa-hint', text: T('rr.actions_required') }));
      }

      function meId() { return st.ownerId || (o.me && o.me.userId) || null; }

      function body() {
        var b = {
          title: st.title.trim(), active: st.active, trigger: st.trigger,
          conditions: { time: st.conditions.time, afterSunset: st.conditions.afterSunset, device: st.conditions.device.map(function (d) { return { actionId: d.actionId, field: d.field, op: d.op, value: d.value, label: d.label || null, unit: d.unit || null }; }), calendar: st.conditions.calendar },
          actions: st.actions.map(function (a) {
            if (a.type === 'quick_action') return { type: 'quick_action', actionId: a.actionId, title: a.title || null, state: a.state || null };
            if (a.type === 'notify') return { type: 'notify', to: a.to, text: a.text ? a.text.trim() || null : null, facts: a.facts === true, buttons: a.buttons || [] };
            return { type: 'messenger', to: a.to, text: a.text ? a.text.trim() || null : null };
          }),
        };
        if (!st.id) b.scope = st.scope;
        return b;
      }

      function check() {
        if (st.trigger.type === 'schedule' && (!st.trigger.weekdays.length || !st.trigger.time)) return T('rr.err_schedule');
        if (st.conditions.time && (!st.conditions.time.from || !st.conditions.time.to || st.conditions.time.from === st.conditions.time.to)) return T('rr.err_window');
        if (st.conditions.calendar && !st.conditions.calendar.sources.length) return T('rr.err_sources');
        if (!st.actions.length) return T('rr.actions_required');
        return null;
      }

      function test() {
        msg.textContent = '';
        var p = st.id && !dirty() ? A.api('POST', o.base + '/' + st.id + '/test') : A.api('POST', o.base + '/test', body());
        p.then(function (r) {
          A.clear(probe);
          probe.appendChild(el('b', { text: T('rr.probe') + ' ' }));
          probe.appendChild(el('span', { text: (r.wouldFire ? T('rr.would_fire') : T('rr.would_not')) + ' ' }));
          probe.appendChild(el('span', { class: 'fa-rr-details' }, r.details.map(function (d) {
            return el('span', { class: 'fa-rr-detail' + (d.ok === false ? ' fa-bad' : (d.ok ? ' fa-ok' : '')), text: d.text });
          })));
        }).catch(function (e) { msg.textContent = A.errText(e); });
      }
      var initial = JSON.stringify(body());
      function dirty() { return JSON.stringify(body()) !== initial; }

      function save() {
        msg.textContent = '';
        var bad = check();
        if (bad) { msg.textContent = bad; return; }
        saveBtn.disabled = true;
        var p = st.id ? A.api('PATCH', o.base + '/' + st.id, body()) : A.api('POST', o.base, body());
        p.then(function (r) { A.toast(T('common.saved')); selected = r.rule.id; return load(); })
          .catch(function (e) { saveBtn.disabled = false; msg.textContent = A.errText(e); });
      }

      var saveBtn = el('button', { type: 'button', class: 'btn btn-primary', text: T('rr.save'), disabled: !canEdit, on: { click: save } });
      var foot = el('div', { class: 'fa-rr-foot' }, [
        probe,
        el('button', { type: 'button', class: 'btn', text: T('rr.test'), on: { click: test } }),
        st.id && o.writable && rule.pausable ? el('button', { type: 'button', class: 'btn btn-danger', text: T('common.delete'), on: { click: function () {
          A.confirm(T('rr.delete_confirm'), T('common.delete'), true).then(function (ok) {
            if (ok) A.api('DELETE', o.base + '/' + st.id).then(function () { selected = null; return load(); }).catch(A.warn);
          });
        } } }) : null,
        canEdit ? saveBtn : null,
      ]);
      editor.appendChild(foot);
      editor.appendChild(msg);
      if (!canEdit) editor.appendChild(el('p', { class: 'fa-hint', text: T('rr.read_only') }));
      renderWhen();
      renderIf();
      renderThen();
    }

    function render() {
      if (o.banner) {
        var off = data.modules && data.modules.rules === false;
        o.banner.textContent = off ? T('rr.module_off') : '';
        o.banner.hidden = !off;
      }
      if (o.add) o.add.disabled = !o.writable || !(data.can.house || data.can.personal);
      renderTabs();
      renderLog();
      if (selected !== 'new' && selected != null && !data.rules.some(function (r) { return r.id === selected; })) selected = null;
      if (selected == null && data.rules.length) selected = data.rules[0].id;
      renderList();
      renderEditor();
    }

    function load() {
      return Promise.all([A.api('GET', o.base), opts ? Promise.resolve(opts) : A.api('GET', o.base + '/options')]).then(function (x) {
        data = x[0];
        opts = x[1];
        render();
        return data;
      }).catch(A.warn);
    }

    if (o.add) o.add.addEventListener('click', function () { if (data) select('new'); });
    return { reload: load, data: function () { return data; } };
  }

  A.reminders = { mount: mount, summary: summary };
}());
