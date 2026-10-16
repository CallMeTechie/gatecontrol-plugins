/* Presence rules (1.2.0) — shared by the admin page "Anwesenheit & Smart Home"
   (API admin/presence/…) and the portal tab for parents (API presence/…):
   a rule row like the mockup AdminAutomations (trigger → actions, "zuletzt …"),
   the rule editor and the run log. A quick action the owner no longer has shows
   "Aktion nicht mehr verfügbar".
   1.4.0: the editor is one wide dialog in three columns (mockup "Neue Regel"):
   Wann? (trigger, person, grace time, time window, after sunset) · Was soll
   passieren? (the owner's quick actions in plugin tabs, grouped by device; a
   switch is a card with two target buttons named with the plugin's verbs, a
   button a card with „Ausführen“; search over all plugins; the notification
   as its own tab) · Ablauf (the rule as a sentence, the numbered steps). A
   switch always gets a fixed target state; a rule from before 1.4.0 whose
   switch has none shows „Zielzustand fehlt – Regel bearbeiten“ and is not run. */
(function () {
  'use strict';
  var A = window.FA, T = A.T, el = A.el;
  var TRIGGERS = ['all_away', 'first_home', 'child_home_alone', 'person_home', 'person_away'];
  var ICON_ARROW = 'M5 12h14M13 6l6 6-6 6';
  var MAX_STEPS = 10;
  var ICON_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,2000}$/;
  var ICON = {
    away: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
    child: 'M12 7a3 3 0 1 0 0-6a3 3 0 0 0 0 6M8 22v-6l-2-1 2-6h8l2 6-2 1v6',
    personIn: 'M10 17l5-5-5-5M15 12H3M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4',
    personOut: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0a9 9 0 0 1 18 0',
    sun: 'M3 18h18M7 18a5 5 0 0 1 10 0M12 8V5M5.6 11.6L4 10M18.4 11.6L20 10',
    search: 'M11 18a7 7 0 1 0 0-14a7 7 0 0 0 0 14M20 20l-4-4',
    bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
    info: 'M12 8h.01M11 12h1v5h1M21 12a9 9 0 1 1-18 0a9 9 0 0 1 18 0',
    x: 'M6 6l12 12M18 6L6 18',
    power: 'M12 3v8M6.3 7.3a8 8 0 1 0 11.4 0',
    play: 'M7 4l12 8-12 8z',
    plugin: 'M9 3v4M15 3v4M6 7h12v4a6 6 0 0 1-12 0zM12 17v4',
  };
  var TRIGGER_ICON = { all_away: ICON.away, first_home: ICON.home, child_home_alone: ICON.child, person_home: ICON.personIn, person_away: ICON.personOut };

  function nameOf(data, id) {
    var m = (data.members || []).filter(function (x) { return x.userId === id; })[0];
    return m ? m.name : '–';
  }

  function triggerText(rule, data) {
    if (rule.trigger === 'person_home' || rule.trigger === 'person_away') return T('rule.trigger_' + rule.trigger, { name: nameOf(data, rule.userId) });
    return T('rule.trigger_' + rule.trigger);
  }

  /** „Elroq – Schloss: Verriegeln“ — a quick action with the word for its target state. */
  function quickText(a) {
    var title = a.title || (a.plugin + ' · ' + a.id);
    return a.verb ? title + ': ' + a.verb : title;
  }

  function notifyTo(a, data) {
    return a.to === 'parents' ? T('rule.to_parents') : (a.to === 'all' ? T('rule.to_all') : (a.to || []).map(function (id) { return nameOf(data, id); }).join(', '));
  }

  function actionText(a, data) {
    if (a.type === 'quick_action') return quickText(a);
    return T('rule.notify_chip', { to: notifyTo(a, data), text: a.text || T('rule.text_default') });
  }

  function conditionText(rule) {
    var c = [];
    if (rule.trigger === 'all_away' && rule.graceMinutes) c.push(T('rule.after_minutes', { n: rule.graceMinutes }));
    if (rule.conditions && rule.conditions.time) c.push(rule.conditions.time.from + '–' + rule.conditions.time.to);
    if (rule.conditions && rule.conditions.afterSunset) c.push(T('rule.after_sunset'));
    return c.join(' · ');
  }

  /** The rule rows into `box`; opts = { base, editable, reload, data }. */
  function render(box, data, opts) {
    A.clear(box);
    if (!data.rules.length) { box.appendChild(el('p', { class: 'fa-empty', text: T('rule.none') })); return; }
    data.rules.forEach(function (rule) {
      var chips = rule.actions.map(function (a) {
        var gone = a.type === 'quick_action' && a.available === false;
        var needs = a.type === 'quick_action' && !gone && a.needsTarget === true;
        var text = actionText(a, data) + (gone ? ' – ' + T('rule.action_gone') : (needs ? ' – ' + T('rule.needs_target') : ''));
        return el('span', { class: 'fa-rule-act' + (gone ? ' is-gone' : '') + (needs ? ' is-needs' : ''), text: text, title: gone ? T('rule.action_gone_hint') : (needs ? T('rule.needs_target_hint') : null) });
      });
      var meta = [];
      if (!rule.active) meta.push(T('rule.paused'));
      if (rule.actions.some(function (a) { return a.type === 'quick_action'; }) && rule.ownerName) meta.push(T('rule.as', { name: rule.ownerName }));
      meta.push(rule.lastRunAt ? T('rule.last', { when: A.when(rule.lastRunAt) }) : T('rule.never'));
      if (rule.lastResult && !rule.lastResult.ok) meta.push(T('rule.failed'));
      var cond = conditionText(rule);
      // left: the summary and the action chips (they wrap); right, at the top: meta, switch, „Bearbeiten“ (own line, right-aligned, when it must wrap)
      var main = el('div', { class: 'fa-rule-main' }, [
        el('span', { class: 'fa-rule-when' }, [rule.name ? el('b', { text: rule.name }) : null, rule.name ? ' · ' : null, triggerText(rule, data), cond ? el('span', { class: 'fa-sub', text: ' (' + cond + ')' }) : null]),
        A.svg(ICON_ARROW, 18),
      ].concat(chips));
      var side = el('div', { class: 'fa-rule-side' }, [el('span', { class: 'fa-rule-meta' + (rule.lastResult && !rule.lastResult.ok ? ' fa-bad' : ''), text: meta.join(' · ') })]);
      if (opts.editable) {
        side.appendChild(A.switchBtn(rule.active, T('rule.active'), function (on, b) {
          A.api('PATCH', opts.base + '/rules/' + rule.id, { active: on }).then(opts.reload).catch(function (e) { A.setSwitch(b, !on); A.warn(e); });
        }));
        side.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('common.edit'), on: { click: function () { edit(rule, data, opts); } } }));
      }
      box.appendChild(el('div', { class: 'fa-rule' + (rule.active ? '' : ' is-off') }, [main, side]));
    });
  }

  // ── the editor ────────────────────────────────────────────────────────────

  var keyOf = function (plugin, id) { return plugin + '|' + id; };
  var icon = function (d, fallback) { return typeof d === 'string' && ICON_RE.test(d) ? d : fallback; };

  /** The words of a toggle's two states: the plugin's verbs, else „Ein“ / „Aus“. */
  function verbsOf(a) {
    var v = a && a.verbs;
    return v && v.on && v.off ? v : { on: T('rule.m_on'), off: T('rule.m_off') };
  }

  /** The title stored with a step: „Elroq – Schloss“ (device and action), the action alone when it already names the device. */
  function labelOf(a) {
    var d = a.device && a.device.title;
    return (d && d !== a.title && a.title.indexOf(d) !== 0 ? d + ' – ' + a.title : a.title).slice(0, 60);
  }

  /** The editor (rule null = new): one dialog, three columns; saves through opts.base. */
  function edit(rule, data, opts) {
    var r = rule || { trigger: 'all_away', graceMinutes: 10, conditions: { time: null, afterSunset: false }, actions: [], active: true, name: '', userId: null };
    var listed = (data.actions || []).filter(function (a) { return a && a.plugin && a.id; });
    var byKey = {};
    listed.forEach(function (a) { byKey[keyOf(a.plugin, a.id)] = a; });
    var people = data.members || [];
    var oldNotify = r.actions.filter(function (a) { return a.type === 'notify'; })[0] || null;
    var st = {
      name: r.name || '', trigger: r.trigger, userId: r.userId != null ? r.userId : (people[0] ? people[0].userId : null),
      grace: r.graceMinutes == null ? 10 : r.graceMinutes, active: r.active !== false,
      window: !!(r.conditions && r.conditions.time), from: r.conditions && r.conditions.time ? r.conditions.time.from : '22:00', to: r.conditions && r.conditions.time ? r.conditions.time.to : '06:00',
      sun: !!(r.conditions && r.conditions.afterSunset),
      steps: r.actions.filter(function (a) { return a.type === 'quick_action'; }).map(function (a) {
        return { key: keyOf(a.plugin, a.id), plugin: a.plugin, id: a.id, state: a.state === 'on' || a.state === 'off' ? a.state : null, title: a.title || null, verb: a.verb || null };
      }),
      notify: !!oldNotify, notifyTo: oldNotify ? oldNotify.to : 'parents', text: oldNotify && oldNotify.text ? oldNotify.text : '',
      query: '', tab: null,
    };
    // plugin tabs in the order of the list, then the notification
    var tabs = [];
    listed.forEach(function (a) { if (!tabs.some(function (t) { return t.id === a.plugin; })) tabs.push({ id: a.plugin, label: a.pluginName || a.plugin }); });
    tabs.push({ id: '@notify', label: T('rule.m_notify_tab') });
    var firstNeeds = st.steps.filter(function (s) { return needsTarget(s); })[0];
    st.tab = firstNeeds ? firstNeeds.plugin : (st.steps[0] && byKey[st.steps[0].key] ? st.steps[0].plugin : tabs[0].id);

    var opener = document.activeElement;
    var uid = 'fa-rm-' + Math.random().toString(36).slice(2, 8);
    var person = function () { return st.trigger === 'person_home' || st.trigger === 'person_away'; };
    function needsTarget(s) { var a = byKey[s.key]; return !s.state && !!a && a.kind === 'toggle'; }
    function stepCount() { return st.steps.length + (st.notify ? 1 : 0); }

    // ── header ──
    var nameInput = el('input', { class: 'fa-rm-name-input', type: 'text', maxlength: '60', value: st.name, 'aria-label': T('rule.m_name_aria'), placeholder: T('rule.m_name_ph'), autocomplete: 'off', 'data-k': 'name' });
    nameInput.addEventListener('input', function () { st.name = nameInput.value; });
    var activeBtn = el('button', { type: 'button', class: 'fa-rm-pill', 'aria-pressed': st.active ? 'true' : 'false', 'data-k': 'active' }, [el('span', { class: 'fa-rm-track' }, [el('span', { class: 'fa-rm-knob' })]), T('rule.active')]);
    activeBtn.addEventListener('click', function () { st.active = !st.active; activeBtn.setAttribute('aria-pressed', st.active ? 'true' : 'false'); });
    var head = el('div', { class: 'fa-rm-head' }, [
      el('div', { class: 'fa-rm-titles' }, [el('span', { class: 'fa-rm-kicker', text: T('rule.m_kicker') }), el('h2', { id: uid + '-title', class: 'fa-rm-title', text: rule ? T('rule.edit') : T('rule.add') })]),
      el('label', { class: 'fa-rm-name' }, [el('span', { text: T('rule.m_name') }), nameInput]),
      el('span', { class: 'fa-spacer' }),
      activeBtn,
      el('button', { type: 'button', class: 'fa-rm-icon-btn', 'aria-label': T('common.close'), on: { click: function () { close(); } } }, [A.svg(ICON.x, 18)]),
    ]);

    // ── column 1: Wann? ──
    var colWhen = el('div', { class: 'fa-rm-scroll' });
    var fromInput = el('input', { type: 'time', class: 'fa-rm-time', value: st.from, 'data-k': 'from', id: uid + '-from' });
    var toInput = el('input', { type: 'time', class: 'fa-rm-time', value: st.to, 'data-k': 'to', id: uid + '-to' });
    fromInput.addEventListener('input', function () { st.from = fromInput.value; renderFlow(); });
    toInput.addEventListener('input', function () { st.to = toInput.value; renderFlow(); });
    function switchBox(on) { return el('span', { class: 'fa-rm-track' + (on ? ' is-on' : '') }, [el('span', { class: 'fa-rm-knob' })]); }
    function renderWhen() {
      var focus = focusKey();
      A.clear(colWhen);
      colWhen.appendChild(colHead('1', T('rule.m_when'), uid + '-when'));
      var radios = TRIGGERS.map(function (t) {
        var on = st.trigger === t;
        return el('button', {
          type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', tabindex: on ? '0' : '-1', class: 'fa-rm-trigger', 'data-k': 'trigger-' + t,
          on: { click: function () { setTrigger(t); } },
        }, [
          el('span', { class: 'fa-rm-trigger-ico' }, [A.svg(TRIGGER_ICON[t], 18)]),
          el('span', { class: 'fa-rm-trigger-text' }, [el('b', { text: T('rule.m_trig_' + t) }), el('span', { text: T('rule.m_trig_' + t + '_hint') })]),
        ]);
      });
      var group = el('div', { class: 'fa-rm-triggers', role: 'radiogroup', 'aria-label': T('rule.m_triggers') }, radios);
      group.addEventListener('keydown', function (e) {
        var i = TRIGGERS.indexOf(st.trigger);
        var d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : (e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0);
        if (!d) return;
        e.preventDefault();
        setTrigger(TRIGGERS[(i + d + TRIGGERS.length) % TRIGGERS.length], true);
      });
      colWhen.appendChild(group);
      if (person()) {
        colWhen.appendChild(el('div', { class: 'fa-rm-block' }, [
          el('span', { class: 'fa-rm-label', id: uid + '-who', text: T('rule.m_who') }),
          el('div', { class: 'fa-rm-people', role: 'group', 'aria-labelledby': uid + '-who' }, people.map(function (m) {
            var on = st.userId === m.userId;
            return el('button', { type: 'button', class: 'fa-rm-person', 'aria-pressed': on ? 'true' : 'false', 'data-k': 'who-' + m.userId, on: { click: function () { st.userId = m.userId; renderWhen(); renderFlow(); } } },
              [A.avatar({ name: m.name, initials: m.initials, colorHex: m.colorHex, avatarUrl: m.avatarUrl }, 28), el('span', { text: m.name })]);
          })),
        ]));
      }
      if (st.trigger === 'all_away') {
        var step = function (d) { return function () { st.grace = Math.max(0, Math.min(120, d > 0 ? Math.floor(st.grace / 5) * 5 + 5 : Math.ceil(st.grace / 5) * 5 - 5)); renderWhen(); renderFlow(); }; };
        colWhen.appendChild(el('div', { class: 'fa-rm-box fa-rm-grace' }, [
          el('span', { class: 'fa-rm-box-text' }, [el('b', { text: T('rule.m_grace') }), el('span', { text: T('rule.m_grace_hint') })]),
          el('span', { class: 'fa-rm-stepper' }, [
            el('button', { type: 'button', class: 'fa-rm-step-btn', 'aria-label': T('rule.m_grace_down'), disabled: st.grace <= 0, text: '−', 'data-k': 'grace-down', on: { click: step(-1) } }),
            el('output', { class: 'fa-rm-grace-val', 'aria-live': 'polite', text: T('rule.m_minutes', { n: st.grace }) }),
            el('button', { type: 'button', class: 'fa-rm-step-btn', 'aria-label': T('rule.m_grace_up'), disabled: st.grace >= 120, text: '+', 'data-k': 'grace-up', on: { click: step(1) } }),
          ]),
        ]));
      }
      var winBtn = el('button', { type: 'button', class: 'fa-rm-box fa-rm-cond', 'aria-pressed': st.window ? 'true' : 'false', 'data-k': 'window', on: { click: function () { st.window = !st.window; renderWhen(); renderFlow(); } } }, [
        A.svg(ICON.clock, 18),
        el('span', { class: 'fa-rm-box-text' }, [el('b', { text: T('rule.m_window') }), el('span', { class: 'fa-rm-mono', text: st.window ? (st.from || '–') + ' – ' + (st.to || '–') : T('rule.m_window_always') })]),
        switchBox(st.window),
      ]);
      var sunHint = data.location === null ? T('rule.m_sun_none') : (data.location ? T('rule.m_sun_at', { lat: data.location.lat, lon: data.location.lon }) : T('rule.m_sun_hint'));
      var sunBtn = el('button', { type: 'button', class: 'fa-rm-box fa-rm-cond', 'aria-pressed': st.sun ? 'true' : 'false', 'data-k': 'sun', on: { click: function () { st.sun = !st.sun; renderWhen(); renderFlow(); } } }, [
        A.svg(ICON.sun, 18),
        el('span', { class: 'fa-rm-box-text' }, [el('b', { text: T('rule.m_sun') }), el('span', { text: sunHint })]),
        switchBox(st.sun),
      ]);
      colWhen.appendChild(el('div', { class: 'fa-rm-block' }, [
        el('span', { class: 'fa-rm-label', text: T('rule.m_only_if') }),
        winBtn,
        st.window ? el('div', { class: 'fa-rm-times' }, [
          el('label', { for: uid + '-from' }, [el('span', { text: T('rule.m_from') })]), fromInput,
          el('label', { for: uid + '-to' }, [el('span', { text: T('rule.m_to') })]), toInput,
        ]) : null,
        sunBtn,
      ]));
      restore(focus);
    }
    function setTrigger(t, keyboard) {
      st.trigger = t;
      renderWhen();
      renderFlow();
      if (keyboard) { var b = colWhen.querySelector('[data-k="trigger-' + t + '"]'); if (b) b.focus(); }
    }

    // ── column 2: Was soll passieren? ──
    var search = el('input', { type: 'search', class: 'fa-rm-search-input', placeholder: T('rule.m_search'), 'aria-label': T('rule.m_search'), autocomplete: 'off', 'data-k': 'search' });
    search.addEventListener('input', function () { st.query = search.value; renderWhat(); });
    var tabBar = el('div', { class: 'fa-rm-tabs', role: 'tablist', 'aria-label': T('rule.m_plugins') });
    var cards = el('div', { class: 'fa-rm-cards', role: 'tabpanel', id: uid + '-panel', 'aria-labelledby': uid + '-what' });
    tabBar.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' ? 1 : (e.key === 'ArrowLeft' ? -1 : 0);
      if (!d) return;
      e.preventDefault();
      var i = tabs.map(function (t) { return t.id; }).indexOf(st.tab);
      selectTab(tabs[(i + d + tabs.length) % tabs.length].id);
      var b = tabBar.querySelector('[aria-selected="true"]');
      if (b) b.focus();
    });
    function selectTab(id) { st.tab = id; st.query = ''; search.value = ''; renderWhat(); }
    var colWhat = el('div', { class: 'fa-rm-what-head' }, [
      el('div', { class: 'fa-rm-col-head' }, [
        el('span', { class: 'fa-rm-num', text: '2' }), el('h3', { id: uid + '-what', text: T('rule.m_what') }), el('span', { class: 'fa-spacer' }),
        el('label', { class: 'fa-rm-search' }, [A.svg(ICON.search, 16), search]),
      ]),
      tabBar,
    ]);
    function countOf(tabId) {
      if (tabId === '@notify') return st.notify ? 1 : 0;
      return st.steps.filter(function (s) { return s.plugin === tabId; }).length;
    }
    function renderWhat() {
      var focus = focusKey();
      A.clear(tabBar);
      var q = st.query.trim().toLowerCase();
      tabs.forEach(function (t, i) {
        var on = !q && st.tab === t.id;
        var n = countOf(t.id);
        tabBar.appendChild(el('button', {
          type: 'button', role: 'tab', class: 'fa-rm-tab', 'aria-selected': on ? 'true' : 'false', 'aria-controls': uid + '-panel', tabindex: on || (q && i === 0) ? '0' : '-1', 'data-k': 'tab-' + t.id,
          on: { click: function () { selectTab(t.id); } },
        }, [t.id === '@notify' ? A.svg(ICON.bell, 16) : null, el('span', { text: t.label }), n ? el('span', { class: 'fa-rm-count', text: String(n) }) : null,
          n ? el('span', { class: 'fa-sr', text: ' – ' + T('rule.m_tab_count', { n: n }) }) : null]));
      });
      A.clear(cards);
      if (!q && st.tab === '@notify') { cards.appendChild(notifyPanel()); restore(focus); return; }
      var visible = listed.filter(function (a) {
        if (!q) return a.plugin === st.tab;
        var hay = [a.title, a.subtitle, a.pluginName, a.device && a.device.title, a.device && a.device.subtitle, a.verbs && a.verbs.on, a.verbs && a.verbs.off].join(' ').toLowerCase();
        return hay.indexOf(q) >= 0;
      });
      if (!listed.length) cards.appendChild(el('p', { class: 'fa-rm-empty', text: data.actionsAvailable === false ? T('rule.quick_unavailable') : T('rule.quick_none') }));
      else if (!visible.length) cards.appendChild(el('p', { class: 'fa-rm-empty', text: T('rule.m_no_match') }));
      var groups = [];
      visible.forEach(function (a) {
        var gk = a.plugin + '|' + (a.device ? 'd:' + a.device.id : 'a:' + a.id);
        var g = groups.filter(function (x) { return x.key === gk; })[0];
        if (!g) {
          var d = a.device || { title: a.title, subtitle: a.subtitle, icon: null };
          var sub = d.subtitle && d.subtitle !== d.title ? d.subtitle : '';
          if (q) sub = sub ? a.pluginName + ' · ' + sub : a.pluginName;
          g = { key: gk, title: d.title, sub: sub, icon: icon(d.icon, ICON.plugin), list: [] };
          groups.push(g);
        }
        g.list.push(a);
      });
      groups.forEach(function (g) {
        cards.appendChild(el('section', { class: 'fa-rm-group', 'aria-label': g.title }, [
          el('div', { class: 'fa-rm-group-head' }, [el('span', { class: 'fa-rm-group-ico' }, [A.svg(g.icon, 18)]), el('h4', { text: g.title }), g.sub ? el('span', { class: 'fa-rm-group-sub', text: g.sub }) : null, el('span', { class: 'fa-rm-rule' })]),
          el('div', { class: 'fa-rm-grid' }, g.list.map(card)),
        ]));
      });
      restore(focus);
    }
    function card(a) {
      var key = keyOf(a.plugin, a.id);
      var s = st.steps.filter(function (x) { return x.key === key; })[0];
      var pos = s ? st.steps.indexOf(s) + 1 : 0;
      var toggle = a.kind === 'toggle';
      var deviceTitle = a.device && a.device.title;
      var sub = a.subtitle && a.subtitle !== a.title && a.subtitle !== deviceTitle ? a.subtitle : '';
      var top = el('div', { class: 'fa-rm-card-top' }, [
        el('span', { class: 'fa-rm-card-ico' }, [A.svg(icon(a.icon, toggle ? ICON.power : ICON.play), 18)]),
        el('span', { class: 'fa-rm-card-text' }, [el('b', { text: a.title }), sub ? el('span', { text: sub }) : null]),
        pos ? el('span', { class: 'fa-rm-badge', text: String(pos), title: T('rule.m_step_no', { n: pos }) }) : null,
      ]);
      var body;
      if (toggle) {
        var v = verbsOf(a);
        var opt = function (state) {
          var pressed = !!s && s.state === state;
          var now = a.state === state;
          return el('button', {
            type: 'button', class: 'fa-rm-target', 'aria-pressed': pressed ? 'true' : 'false', 'data-k': 'target-' + key + '-' + state,
            title: now ? T('rule.m_now_title') : null, on: { click: function () { pick(a, state); } },
          }, [now ? el('span', { class: 'fa-rm-now', 'aria-hidden': 'true' }) : null, el('span', { text: v[state] }), now ? el('span', { class: 'fa-sr', text: ' (' + T('rule.m_now') + ')' }) : null]);
        };
        body = el('div', { class: 'fa-rm-seg', role: 'group', 'aria-label': T('rule.m_target_group', { name: a.title }) }, [opt('on'), opt('off')]);
      } else {
        body = el('button', { type: 'button', class: 'fa-rm-run', 'aria-pressed': s ? 'true' : 'false', 'data-k': 'run-' + key, text: s ? T('rule.m_run_on') : T('rule.m_run'), on: { click: function () { pick(a, null); } } });
      }
      var needs = !!s && toggle && !s.state;
      return el('div', { class: 'fa-rm-card' + (s ? ' is-on' : '') + (needs ? ' is-needs' : '') }, [top, body, needs ? el('span', { class: 'fa-rm-card-warn', text: T('rule.m_target_choose') }) : null]);
    }
    /** A target (or „Ausführen“) picked on a card: add the step, change its target, or remove it when picked again. */
    function pick(a, state) {
      var key = keyOf(a.plugin, a.id);
      var s = st.steps.filter(function (x) { return x.key === key; })[0];
      msg.textContent = '';
      if (s && (state === null || s.state === state)) st.steps.splice(st.steps.indexOf(s), 1);
      else if (s) { s.state = state; s.title = labelOf(a); }
      else {
        if (stepCount() >= MAX_STEPS) { msg.textContent = T('rule.m_max', { n: MAX_STEPS }); return; }
        st.steps.push({ key: key, plugin: a.plugin, id: a.id, state: state, title: labelOf(a), verb: null });
      }
      renderWhat();
      renderFlow();
    }
    function notifyPanel() {
      var choices = [{ id: 'parents', label: T('rule.to_parents') }, { id: 'all', label: T('rule.to_all') }];
      var custom = oldNotify && Array.isArray(oldNotify.to) ? oldNotify.to : null;
      if (custom) choices.push({ id: 'custom', value: custom, label: custom.map(function (id) { return nameOf(data, id); }).join(', ') });
      var text = el('input', { type: 'text', class: 'form-input', maxlength: '120', value: st.text, placeholder: T('rule.text_default'), 'data-k': 'notify-text', id: uid + '-text' });
      text.addEventListener('input', function () { st.text = text.value; });
      var add = el('button', { type: 'button', class: 'fa-rm-run fa-rm-notify-add', 'aria-pressed': st.notify ? 'true' : 'false', 'data-k': 'notify-add', text: st.notify ? T('rule.m_notify_added') : T('rule.m_notify_add'), on: { click: function () {
        if (!st.notify && stepCount() >= MAX_STEPS) { msg.textContent = T('rule.m_max', { n: MAX_STEPS }); return; }
        st.notify = !st.notify; renderWhat(); renderFlow();
      } } });
      return el('div', { class: 'fa-rm-notify' + (st.notify ? ' is-on' : '') }, [
        el('div', { class: 'fa-rm-card-top' }, [
          el('span', { class: 'fa-rm-card-ico' }, [A.svg(ICON.bell, 20)]),
          el('span', { class: 'fa-rm-card-text' }, [el('b', { text: T('rule.m_notify_title') }), el('span', { text: T('rule.m_notify_hint') })]),
          add,
        ]),
        el('div', { class: 'fa-rm-label', id: uid + '-to', text: T('rule.notify_to') }),
        el('div', { class: 'fa-rm-chips', role: 'group', 'aria-labelledby': uid + '-to' }, choices.map(function (c) {
          var on = c.id === 'custom' ? Array.isArray(st.notifyTo) : st.notifyTo === c.id;
          return el('button', { type: 'button', class: 'fa-rm-chip', 'aria-pressed': on ? 'true' : 'false', 'data-k': 'to-' + c.id, text: c.label, on: { click: function () { st.notifyTo = c.id === 'custom' ? c.value : c.id; renderWhat(); renderFlow(); } } });
        })),
        el('label', { class: 'fa-rm-label', for: uid + '-text', text: T('rule.m_text') }),
        text,
        el('p', { class: 'fa-hint', text: T('rule.text_hint') }),
      ]);
    }

    // ── column 3: Ablauf ──
    var flowCount = el('span', { class: 'fa-rm-mono fa-rm-muted' });
    var flowList = el('div', { class: 'fa-rm-scroll fa-rm-flow-list' });
    function sentence() {
      var who = person() ? T('rule.trigger_' + st.trigger, { name: nameOf(data, st.userId) }) : T('rule.trigger_' + st.trigger);
      var parts = [who + (st.trigger === 'all_away' && st.grace > 0 ? ' (' + T('rule.m_s_grace', { n: st.grace }) + ')' : '')];
      if (st.window && st.from && st.to) parts.push(T('rule.m_s_window', { from: st.from, to: st.to }));
      if (st.sun) parts.push(T('rule.after_sunset'));
      var n = stepCount();
      return parts.join(', ') + ' – ' + (n ? (n === 1 ? T('rule.m_s_one') : T('rule.m_s_many', { n: n })) : T('rule.m_s_none'));
    }
    function renderFlow() {
      var focus = focusKey();
      flowCount.textContent = stepCount() + ' / ' + MAX_STEPS;
      A.clear(flowList);
      flowList.appendChild(el('div', { class: 'fa-rm-sentence' }, [el('span', { class: 'fa-rm-kicker', text: T('rule.m_if') }), el('span', { text: sentence() })]));
      var n = 0;
      st.steps.forEach(function (s) {
        n++;
        var a = byKey[s.key];
        var gone = !a && data.actionsAvailable !== false;
        var needs = needsTarget(s);
        var target = a ? (a.kind === 'toggle' ? (s.state ? verbsOf(a)[s.state] : T('rule.m_target_missing_chip')) : T('rule.m_run_chip')) : (s.verb || (s.state ? T('rule.m_' + s.state) : T('rule.m_run_chip')));
        var title = a ? labelOf(a) : (s.title || s.id);
        var where = a ? a.pluginName : (gone ? T('rule.action_gone') : s.plugin);
        flowList.appendChild(stepRow(n, title, where, target, needs ? 'warn' : (gone ? 'gone' : (s.state === 'off' ? 'off' : 'on')), function () {
          st.steps.splice(st.steps.indexOf(s), 1); renderWhat(); renderFlow();
        }, 'step-' + s.key));
      });
      if (st.notify) {
        var to = st.notifyTo === 'parents' ? T('rule.m_to_parents') : (st.notifyTo === 'all' ? T('rule.m_to_all') : T('rule.m_to_people', { names: (st.notifyTo || []).map(function (id) { return nameOf(data, id); }).join(', ') }));
        flowList.appendChild(stepRow(++n, T('rule.notify'), to, T('rule.m_push'), 'neutral', function () { st.notify = false; renderWhat(); renderFlow(); }, 'step-notify'));
      }
      if (!n) flowList.appendChild(el('div', { class: 'fa-rm-flow-empty', text: T('rule.m_empty') }));
      flowList.appendChild(el('div', { class: 'fa-rm-info' }, [A.svg(ICON.info, 18), el('span', { text: T('rule.m_hint_fixed') })]));
      footHint.textContent = n ? T('rule.m_foot_ok') : T('rule.actions_required');
      restore(focus);
    }
    function stepRow(n, title, where, target, tone, remove, k) {
      return el('div', { class: 'fa-rm-step' }, [
        el('span', { class: 'fa-rm-step-n', text: String(n) }),
        el('span', { class: 'fa-rm-step-text' }, [el('b', { text: title }), el('span', { class: 'fa-rm-step-meta' }, [el('span', { class: 'fa-rm-step-chip is-' + tone, text: target }), where ? el('span', { text: where }) : null])]),
        el('button', { type: 'button', class: 'fa-rm-icon-btn fa-rm-step-x', 'aria-label': T('rule.m_remove', { name: title }), 'data-k': k, on: { click: remove } }, [A.svg(ICON.x, 16)]),
      ]);
    }
    var runsAs = el('div', { class: 'fa-rm-runs', text: opts.base === 'admin/presence' ? T('rule.m_runs_admin') : T('rule.m_runs_you') });

    // ── footer ──
    var footHint = el('span', { class: 'fa-rm-foot-hint' });
    var msg = el('span', { class: 'fa-rm-msg', role: 'status', 'aria-live': 'polite' });
    var save = el('button', { type: 'button', class: 'btn btn-primary fa-rm-save', text: T('rule.m_save'), on: { click: submit } });
    var foot = el('div', { class: 'fa-rm-foot' }, [
      el('span', { class: 'fa-rm-foot-text' }, [msg, footHint]),
      el('span', { class: 'fa-spacer' }),
      rule ? el('button', { type: 'button', class: 'btn btn-danger', text: T('common.delete'), on: { click: function () {
        close();
        A.confirm(T('rule.delete_confirm'), T('common.delete'), true).then(function (ok) { if (ok) A.api('DELETE', opts.base + '/rules/' + rule.id).then(opts.reload).catch(A.warn); });
      } } }) : null,
      el('button', { type: 'button', class: 'btn', text: T('common.cancel'), on: { click: function () { close(); } } }),
      save,
    ]);

    function colHead(n, title, id) { return el('div', { class: 'fa-rm-col-head' }, [el('span', { class: 'fa-rm-num', text: n }), el('h3', { id: id, text: title })]); }
    var dialog = el('div', { class: 'fa-rm', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': uid + '-title' }, [
      head,
      el('div', { class: 'fa-rm-body' }, [
        el('section', { class: 'fa-rm-col fa-rm-when', 'aria-labelledby': uid + '-when' }, [colWhen]),
        el('section', { class: 'fa-rm-col fa-rm-what', 'aria-labelledby': uid + '-what' }, [colWhat, cards]),
        el('section', { class: 'fa-rm-col fa-rm-flow', 'aria-labelledby': uid + '-flow' }, [
          el('div', { class: 'fa-rm-col-head fa-rm-flow-head' }, [el('span', { class: 'fa-rm-num', text: '3' }), el('h3', { id: uid + '-flow', text: T('rule.m_flow') }), el('span', { class: 'fa-spacer' }), flowCount]),
          flowList, runsAs,
        ]),
      ]),
      foot,
    ]);
    var ov = el('div', { class: 'modal-overlay fa-rm-overlay' }, [dialog]);

    function focusKey() { var f = document.activeElement; return f && ov.contains(f) ? f.getAttribute('data-k') : null; }
    function restore(k) {
      if (!k || !ov.parentNode) return;
      var f = document.activeElement;
      if (f && ov.contains(f) && f.getAttribute('data-k') === k) return;
      var n = Array.prototype.filter.call(ov.querySelectorAll('[data-k]'), function (x) { return x.getAttribute('data-k') === k; })[0];
      if (n) n.focus();
    }
    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      if (opener && opener.focus && document.body.contains(opener)) opener.focus();
    }
    // keyboard: Escape closes, Tab stays inside the dialog
    function onKey(e) {
      if (closed) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      var f = Array.prototype.filter.call(dialog.querySelectorAll('button,input,select,textarea,[tabindex]'), function (x) {
        return !x.disabled && x.getAttribute('tabindex') !== '-1' && x.offsetParent !== null;
      });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }

    function submit() {
      msg.textContent = '';
      if (!stepCount()) { msg.textContent = T('rule.actions_required'); return; }
      var missing = st.steps.filter(needsTarget)[0];
      if (missing) {
        selectTab(missing.plugin);
        msg.textContent = T('rule.m_target_missing', { name: byKey[missing.key].title });
        return;
      }
      if (st.window && (!st.from || !st.to)) { msg.textContent = T('rule.window_both'); return; }
      if (st.window && st.from === st.to) { msg.textContent = T('rule.m_window_same'); return; }
      if (person() && !st.userId) { msg.textContent = T('rule.m_who_missing'); return; }
      var actions = st.steps.map(function (s) {
        var a = byKey[s.key];
        var out = { type: 'quick_action', plugin: s.plugin, id: s.id, title: (a ? labelOf(a) : s.title) || null };
        if (s.state) out.state = s.state;
        return out;
      });
      if (st.notify) actions.push({ type: 'notify', to: st.notifyTo, text: st.text.trim() || null });
      var body = {
        name: st.name.trim(), trigger: st.trigger, graceMinutes: st.trigger === 'all_away' ? st.grace : r.graceMinutes,
        conditions: { time: st.window ? { from: st.from, to: st.to } : null, afterSunset: st.sun }, actions: actions, active: st.active,
      };
      if (person()) body.userId = st.userId;
      save.disabled = true;
      var p = rule ? A.api('PATCH', opts.base + '/rules/' + rule.id, body) : A.api('POST', opts.base + '/rules', body);
      p.then(function () { close(); A.toast(T('common.saved')); opts.reload(); })
        .catch(function (e) { save.disabled = false; msg.textContent = A.errText(e); });
    }

    renderWhen();
    renderWhat();
    renderFlow();
    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey, true);
    setTimeout(function () { if (!closed) nameInput.focus(); }, 30);
    return { close: close, state: st };
  }

  /** The run log (newest first) as a table into `box`. */
  function log(box, data) {
    A.clear(box);
    if (!data.log.length) { box.appendChild(el('p', { class: 'fa-empty', text: T('rule.log_empty') })); return; }
    var tb = el('tbody');
    data.log.forEach(function (x) {
      var res = x.results.map(function (y) {
        var what = y.type === 'quick_action' ? quickText({ title: y.title || y.id, verb: y.verb }) : T('rule.notify');
        return what + ' → ' + (y.ok ? (y.unchanged ? T('rule.unchanged') : (y.message || T('rule.ok'))) : T('rule.err.' + (y.error || 'failed')));
      }).join(' · ');
      tb.appendChild(el('tr', null, [
        el('td', { class: 'fa-time', text: A.when(x.at) }),
        el('td', { text: (x.ruleName ? x.ruleName + ' · ' : '') + T('rule.trigger_' + x.trigger, { name: x.userId ? nameOf(data, x.userId) : '' }) }),
        el('td', { class: x.ok ? 'fa-ok' : 'fa-bad', text: res || '–' }),
      ]));
    });
    box.appendChild(el('div', { class: 'fa-table-wrap' }, [el('table', { class: 'fa-table' }, [
      el('thead', null, [el('tr', null, [el('th', { text: T('log.col_time') }), el('th', { text: T('rule.col_rule') }), el('th', { text: T('log.col_result') })])]),
      tb,
    ])]));
  }

  /** Who is home: a grid of people (mockup "Gerade zuhause"). */
  function people(box, members) {
    A.clear(box);
    members.forEach(function (m) {
      var sub = m.state === 'home' ? T('presence.home_since', { when: A.when(m.since) }) : T('presence.' + m.state);
      box.appendChild(el('div', { class: 'fa-pres is-' + m.state }, [A.avatar(m, 34), el('div', { class: 'fa-pres-main' }, [el('b', { text: m.name }), el('span', { class: 'fa-sub', text: sub })])]));
    });
    if (!members.length) box.appendChild(el('p', { class: 'fa-empty', text: T('presence.nobody') }));
  }

  A.rules = { render: render, edit: edit, log: log, people: people, TRIGGERS: TRIGGERS };
}());
