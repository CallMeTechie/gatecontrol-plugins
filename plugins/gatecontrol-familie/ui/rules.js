/* Presence rules (1.2.0) — shared by the admin page "Anwesenheit & Smart Home"
   (API admin/presence/…) and the portal tab for parents (API presence/…):
   a rule row like the mockup AdminAutomations (trigger → actions, "zuletzt …"),
   the rule editor (trigger, person, grace time, time window, after sunset,
   quick actions of the other plugins, a notification) and the run log.
   A quick action the owner no longer has shows "Aktion nicht mehr verfügbar". */
(function () {
  'use strict';
  var A = window.FA, T = A.T, el = A.el;
  var TRIGGERS = ['all_away', 'first_home', 'child_home_alone', 'person_home', 'person_away'];
  var ICON_ARROW = 'M5 12h14M13 6l6 6-6 6';

  function nameOf(data, id) {
    var m = (data.members || []).filter(function (x) { return x.userId === id; })[0];
    return m ? m.name : '–';
  }

  function triggerText(rule, data) {
    if (rule.trigger === 'person_home' || rule.trigger === 'person_away') return T('rule.trigger_' + rule.trigger, { name: nameOf(data, rule.userId) });
    return T('rule.trigger_' + rule.trigger);
  }

  function actionText(a, data) {
    if (a.type === 'quick_action') return a.title || (a.plugin + ' · ' + a.id);
    var to = a.to === 'parents' ? T('rule.to_parents') : (a.to === 'all' ? T('rule.to_all') : (a.to || []).map(function (id) { return nameOf(data, id); }).join(', '));
    return T('rule.notify_chip', { to: to, text: a.text || T('rule.text_default') });
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
        return el('span', { class: 'fa-rule-act' + (gone ? ' is-gone' : ''), text: actionText(a, data) + (gone ? ' – ' + T('rule.action_gone') : ''), title: gone ? T('rule.action_gone_hint') : null });
      });
      var meta = [];
      if (!rule.active) meta.push(T('rule.paused'));
      if (rule.actions.some(function (a) { return a.type === 'quick_action'; }) && rule.ownerName) meta.push(T('rule.as', { name: rule.ownerName }));
      meta.push(rule.lastRunAt ? T('rule.last', { when: A.when(rule.lastRunAt) }) : T('rule.never'));
      if (rule.lastResult && !rule.lastResult.ok) meta.push(T('rule.failed'));
      var cond = conditionText(rule);
      var row = el('div', { class: 'fa-rule' + (rule.active ? '' : ' is-off') }, [
        el('span', { class: 'fa-rule-when' }, [rule.name ? el('b', { text: rule.name }) : null, rule.name ? ' · ' : null, triggerText(rule, data), cond ? el('span', { class: 'fa-sub', text: ' (' + cond + ')' }) : null]),
        A.svg(ICON_ARROW, 18),
      ].concat(chips).concat([el('span', { class: 'fa-rule-meta' + (rule.lastResult && !rule.lastResult.ok ? ' fa-bad' : ''), text: meta.join(' · ') })]));
      if (opts.editable) {
        row.appendChild(A.switchBtn(rule.active, T('rule.active'), function (on, b) {
          A.api('PATCH', opts.base + '/rules/' + rule.id, { active: on }).then(opts.reload).catch(function (e) { A.setSwitch(b, !on); A.warn(e); });
        }));
        row.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('common.edit'), on: { click: function () { edit(rule, data, opts); } } }));
      }
      box.appendChild(row);
    });
  }

  /** The editor (rule null = new). */
  function edit(rule, data, opts) {
    var r = rule || { trigger: 'all_away', graceMinutes: 10, conditions: { time: null, afterSunset: false }, actions: [], active: true, name: '', userId: null };
    var quick = (data.actions || []).map(function (a) { return { value: a.plugin + '|' + a.id, label: a.title + ' · ' + a.pluginName + (a.subtitle ? ' (' + a.subtitle + ')' : '') }; });
    var had = r.actions.filter(function (a) { return a.type === 'quick_action'; });
    had.forEach(function (a) {
      var key = a.plugin + '|' + a.id;
      if (!quick.some(function (q) { return q.value === key; })) quick.push({ value: key, label: (a.title || key) + ' – ' + T('rule.action_gone') });
    });
    var notify = r.actions.filter(function (a) { return a.type === 'notify'; })[0] || null;
    var people = (data.members || []).map(function (m) { return { value: String(m.userId), label: m.name }; });
    var person = function (v) { return v.trigger === 'person_home' || v.trigger === 'person_away'; };
    A.form(rule ? T('rule.edit') : T('rule.add'), [
      { key: 'name', label: T('rule.name'), max: 60, value: r.name },
      { key: 'trigger', label: T('rule.trigger'), type: 'select', value: r.trigger, options: TRIGGERS.map(function (t) { return { value: t, label: T('rule.trigger_' + t, { name: '…' }) }; }) },
      { key: 'userId', label: T('rule.person'), type: 'select', value: r.userId != null ? String(r.userId) : (people[0] && people[0].value), options: people, show: person },
      { key: 'grace', label: T('rule.grace'), type: 'number', min: 0, maxValue: 120, step: 1, value: r.graceMinutes, hint: T('rule.grace_hint'), show: function (v) { return v.trigger === 'all_away'; } },
      { key: 'from', label: T('rule.from'), type: 'time', value: r.conditions.time ? r.conditions.time.from : '' },
      { key: 'to', label: T('rule.to'), type: 'time', value: r.conditions.time ? r.conditions.time.to : '', hint: T('rule.window_hint') },
      { key: 'afterSunset', label: T('rule.after_sunset_only'), type: 'checkbox', value: r.conditions.afterSunset },
      { key: 'quick', label: T('rule.quick'), type: 'checks', options: quick, value: had.map(function (a) { return a.plugin + '|' + a.id; }), empty: data.actionsAvailable === false ? T('rule.quick_unavailable') : T('rule.quick_none') },
      { key: 'notify', label: T('rule.notify'), type: 'checkbox', value: !!notify },
      { key: 'notifyTo', label: T('rule.notify_to'), type: 'select', value: notify && typeof notify.to === 'string' ? notify.to : 'parents',
        options: [{ value: 'parents', label: T('rule.to_parents') }, { value: 'all', label: T('rule.to_all') }], show: function (v) { return v.notify; } },
      { key: 'text', label: T('rule.text'), max: 120, value: notify ? notify.text || '' : '', hint: T('rule.text_hint'), show: function (v) { return v.notify; } },
      { key: 'active', label: T('rule.active'), type: 'checkbox', value: r.active },
    ], {
      wide: true,
      check: function (v) {
        if (!v.quick.length && !v.notify) return T('rule.actions_required');
        if ((v.from && !v.to) || (!v.from && v.to)) return T('rule.window_both');
        if (v.trigger === 'all_away' && (v.grace == null || v.grace < 0 || v.grace > 120)) return T('rule.grace_invalid');
        return null;
      },
      submit: function (v) {
        var actions = v.quick.map(function (key) {
          var i = key.indexOf('|');
          var plugin = key.slice(0, i);
          var id = key.slice(i + 1);
          var a = (data.actions || []).filter(function (x) { return x.plugin === plugin && x.id === id; })[0];
          var old = had.filter(function (x) { return x.plugin === plugin && x.id === id; })[0];
          return { type: 'quick_action', plugin: plugin, id: id, title: ((a && a.title) || (old && old.title) || '').slice(0, 60) || null };
        });
        if (v.notify) actions.push({ type: 'notify', to: v.notifyTo, text: v.text.trim() || null });
        var body = {
          name: v.name.trim(), trigger: v.trigger, graceMinutes: v.trigger === 'all_away' ? v.grace : r.graceMinutes,
          conditions: { time: v.from && v.to ? { from: v.from, to: v.to } : null, afterSunset: v.afterSunset }, actions: actions, active: v.active,
        };
        if (person(v)) body.userId = parseInt(v.userId, 10);
        var p = rule ? A.api('PATCH', opts.base + '/rules/' + rule.id, body) : A.api('POST', opts.base + '/rules', body);
        return p.then(function () { A.toast(T('common.saved')); opts.reload(); });
      },
      onDelete: rule ? function () {
        A.confirm(T('rule.delete_confirm'), T('common.delete'), true).then(function (ok) {
          if (ok) A.api('DELETE', opts.base + '/rules/' + rule.id).then(opts.reload).catch(A.warn);
        });
      } : null,
    });
  }

  /** The run log (newest first) as a table into `box`. */
  function log(box, data) {
    A.clear(box);
    if (!data.log.length) { box.appendChild(el('p', { class: 'fa-empty', text: T('rule.log_empty') })); return; }
    var tb = el('tbody');
    data.log.forEach(function (x) {
      var res = x.results.map(function (y) {
        var what = y.type === 'quick_action' ? (y.title || y.id) : T('rule.notify');
        return what + ': ' + (y.ok ? (y.message || T('rule.ok')) : T('rule.err.' + (y.error || 'failed')));
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
