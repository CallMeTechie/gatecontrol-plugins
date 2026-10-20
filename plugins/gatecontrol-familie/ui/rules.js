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
   switch has none shows „Zielzustand fehlt – Regel bearbeiten“ and is not run.
   1.5.0: places as triggers — „Kommt an einem Ort an“ / „Verlässt einen Ort“
   in Wann? (a person or „Jemand“, a place, „Orte verwalten“, who shares
   places), the section „Orte“ (cards, the editor with the OpenStreetMap map,
   ui/map.js pick()) on the admin page and in the portal; dialogs opened from
   the rule dialog stack on top of it (Escape closes the top one).
   1.6.0: „Messenger-Nachricht senden“ as its own tab next to the notification —
   into the group „Familie“ or to single people (the person chips of the
   notification) — only while the Messenger plugin is available
   (data.messenger.available); a rule that already has one keeps it and shows
   „Messenger nicht verfügbar“ meanwhile.
   1.9.0: the rule log also shows reminders (trigger 'schedule'), presses of a notification's button and
   runs held back by a device or calendar condition.
   1.10.0: the one editor of every rule (the page „Regeln & Erinnerungen“ and ui/reminders.js are gone):
   rules are read and saved through the rules API (opts.rulesBase: admin/rules, in the portal rules —
   server/rules.js), places still through opts.base (…/places). New in this dialog: the trigger group
   „Zeit“ (weekdays and a time), „Nur wenn“ a device value and an event today / tomorrow, the notification
   with values and up to three buttons, „Gehört zu“ (house rule or one's own reminder, portal), the dry run
   („Probelauf“); the list filters Alle / Erinnerungen / Anwesenheit / Orte.
   1.12.0: the trigger „Stunde fällt aus“ (school_change, group „Schule“) — which child (or every child),
   which changes, the lesson's day — offered only while the server lists it in options.triggers (the
   Schule plugin is there; its students in options.school.students); the list filter „Schule“ shows
   when there is such a rule; a log row of it shows the event's text. */
(function () {
  'use strict';
  var A = window.FA, T = A.T, el = A.el;
  var TRIGGERS = ['schedule', 'all_away', 'first_home', 'child_home_alone', 'person_home', 'person_away', 'place_enter', 'place_exit', 'school_change'];
  var SCHOOL = 'school_change';
  var SCHOOL_KINDS = ['cancelled', 'changed', 'extra', 'restored'];
  var SCHOOL_DAYS = ['today', 'tomorrow', 'any'];
  var WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
  var OPS = ['<', '<=', '>', '>=', '='];
  var FILTERS = ['all', 'reminder', 'presence', 'place', 'school'];
  var MAX_DEVICE_CONDS = 4;
  var MAX_BUTTONS = 3;
  var PLACE_TRIGGERS = ['place_enter', 'place_exit'];
  var MAX_PLACES = 20;
  var RADIUS = { min: 50, max: 5000, step: 50, def: 200 };
  var ICON_ARROW = 'M5 12h14M13 6l6 6-6 6';
  var MAX_STEPS = 10;
  var MSG_ERRORS = ['unavailable', 'group_off', 'not_found', 'forbidden', 'invalid', 'rate_limit', 'timeout', 'failed', 'no_recipients'];
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
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    power: 'M12 3v8M6.3 7.3a8 8 0 1 0 11.4 0',
    play: 'M7 4l12 8-12 8z',
    plugin: 'M9 3v4M15 3v4M6 7h12v4a6 6 0 0 1-12 0zM12 17v4',
    pin: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11zM12 12.5a2.5 2.5 0 1 0 0-5a2.5 2.5 0 0 0 0 5',
    pinIn: 'M10 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 1-.3 2.1-.8 3.1M10 13a2 2 0 1 0 0-4a2 2 0 0 0 0 4M14 19h7M18 16l3 3-3 3',
    pinOut: 'M10 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 1-.3 2.1-.8 3.1M10 13a2 2 0 1 0 0-4a2 2 0 0 0 0 4M21 19h-7M17 16l-3 3 3 3',
    chat: 'M4 5h16v11H9l-5 4z',
    group: 'M9 11a3.5 3.5 0 1 0 0-7a3.5 3.5 0 0 0 0 7M2.5 20a6.5 6.5 0 0 1 13 0M16 4.2a3.5 3.5 0 0 1 0 6.6M18 14a6.5 6.5 0 0 1 3.5 6',
    alarm: 'M12 21a8 8 0 1 0 0-16a8 8 0 0 0 0 16M12 9v4l2.5 1.5M5 3L2 6M22 6l-3-3',
    gauge: 'M4 18a9 9 0 1 1 16 0M12 14l4-5M12 15a1 1 0 1 0 0-2a1 1 0 0 0 0 2',
    cal: 'M4 6h16v15H4zM4 10h16M8 3v4M16 3v4',
    school: 'M2 9l10-5 10 5-10 5zM6 11v5c3 2 9 2 12 0v-5M22 9v6',
  };
  var TRIGGER_ICON = { schedule: ICON.alarm, all_away: ICON.away, first_home: ICON.home, child_home_alone: ICON.child, person_home: ICON.personIn, person_away: ICON.personOut, place_enter: ICON.pinIn, place_exit: ICON.pinOut, school_change: ICON.school };
  // dialogs opened from the rule dialog (places) stack on top of it: Escape and Tab belong to the top one
  var stack = [];

  /** The family (data.members of the presence API, else the people of …/options). */
  function peopleOf(data) { return data.members || (data.options && data.options.people) || []; }

  function nameOf(data, id) {
    var m = peopleOf(data).filter(function (x) { return x.userId === id; })[0];
    return m ? m.name : '–';
  }

  /**
   * 1.10.0: a rule of the rules API ({ title, trigger: { type, … } }) → the flat fields the rows and the
   * editor read (name, trigger as a string, userId, placeId, placeName, graceMinutes, schedule); a rule
   * that is flat already stays as it is.
   */
  function flat(r) {
    if (!r.trigger || typeof r.trigger !== 'object') return r;
    var t = r.trigger;
    var out = {};
    Object.keys(r).forEach(function (k) { out[k] = r[k]; });
    out.name = r.title != null ? r.title : r.name;
    out.trigger = t.type;
    out.userId = t.userId != null ? t.userId : null;
    out.placeId = t.placeId != null ? t.placeId : null;
    out.placeName = t.placeName || null;
    out.graceMinutes = t.graceMinutes != null ? t.graceMinutes : 10;
    out.schedule = t.type === 'schedule' ? { weekdays: (t.weekdays || []).slice(), time: t.time || '' } : null;
    out.school = t.type === SCHOOL ? { kinds: (t.kinds || ['cancelled']).slice(), days: t.days || 'any' } : null;
    return out;
  }

  /** The list's filter of a rule: reminder (schedule), place or presence. */
  function kindOf(rule) { return rule.kind || (rule.trigger === 'schedule' ? 'reminder' : (isPlace(rule.trigger) ? 'place' : (rule.trigger === SCHOOL ? 'school' : 'presence'))); }

  /** „Schule Lena: fällt aus, Vertretung · heute“ (child null = every child). */
  function schoolText(userId, school, data) {
    var o = school || { kinds: ['cancelled'], days: 'any' };
    return T('rule.trigger_school_change', {
      name: userId != null ? nameOf(data, userId) : T('rule.all_children'),
      kinds: o.kinds.map(function (k) { return T('school.kind_' + k); }).join(', '), days: T('school.days_' + o.days),
    });
  }

  /** „Mo–Fr“, „täglich“, „Sa, So“ */
  function daysText(w) {
    if (!w || !w.length) return '–';
    if (w.length === 7) return T('rr.daily');
    if (w.join(',') === '1,2,3,4,5') return T('rr.wd_1') + '–' + T('rr.wd_5');
    return w.map(function (d) { return T('rr.wd_' + d); }).join(', ');
  }

  /** The device of a device-value condition by its action („Elroq“). */
  function deviceName(data, actionId) {
    var o = data.options || {};
    var d = (o.devices || []).filter(function (x) { return x.actionId === actionId; })[0];
    return d ? d.label : String(actionId || '').split('/')[1] || '–';
  }

  function isPlace(trigger) { return PLACE_TRIGGERS.indexOf(trigger) >= 0; }
  function placeOf(data, id) { return (data.places || []).filter(function (p) { return p.id === id; })[0] || null; }
  /** "150 m" / "1,5 km" */
  function radiusText(m) {
    return m < 1000 ? m + ' m' : (m / 1000).toLocaleString(A.CTX.lang === 'en' ? 'en-GB' : 'de-DE', { maximumFractionDigits: 2 }) + ' km';
  }

  function triggerText(rule, data) {
    if (rule.trigger === 'schedule') return T('rule.trigger_schedule', { days: daysText(rule.schedule && rule.schedule.weekdays), time: (rule.schedule && rule.schedule.time) || '–' });
    if (rule.trigger === 'person_home' || rule.trigger === 'person_away') return T('rule.trigger_' + rule.trigger, { name: nameOf(data, rule.userId) });
    if (isPlace(rule.trigger)) return T('rule.trigger_' + rule.trigger, { name: rule.userId ? nameOf(data, rule.userId) : T('rule.someone'), place: rule.placeName || '–' });
    if (rule.trigger === SCHOOL) return schoolText(rule.userId, rule.school, data);
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

  function msgTo(a, data) {
    return a.to === 'family' ? T('rule.msg_to_family') : (a.to || []).map(function (id) { return nameOf(data, id); }).join(', ');
  }

  function actionText(a, data) {
    if (a.type === 'quick_action') return quickText(a);
    if (a.type === 'messenger') return T('rule.messenger_chip', { to: msgTo(a, data), text: a.text || T('rule.text_default') });
    return T('rule.notify_chip', { to: notifyTo(a, data), text: a.text || T('rule.text_default') });
  }

  /** 1.6.0: is the Messenger there (data.messenger from the server; missing = an older server → no)? */
  function msgAvailable(data) { return !!(data.messenger && data.messenger.available === true); }
  /** A messenger action that cannot run now: 'gone' (no messenger), 'group_off' (the group is switched off) or null. */
  function msgProblem(a, data) {
    if (a.type !== 'messenger') return null;
    if (!msgAvailable(data)) return 'gone';
    if (a.to === 'family' && !(data.messenger && data.messenger.group)) return 'group_off';
    return null;
  }

  /** „Ladestand Elroq < 50 %“ */
  function deviceCondText(d, data) {
    return (d.label ? d.label + ' ' : '') + deviceName(data, d.actionId) + ' ' + d.op + ' ' + d.value + (d.unit ? ' ' + d.unit : '');
  }

  function conditionText(rule, data) {
    var c = [];
    var k = rule.conditions || {};
    if (rule.trigger === 'all_away' && rule.graceMinutes) c.push(T('rule.after_minutes', { n: rule.graceMinutes }));
    if (k.time) c.push(k.time.from + '–' + k.time.to);
    if (k.afterSunset) c.push(T('rule.after_sunset'));
    (k.device || []).forEach(function (d) { c.push(deviceCondText(d, data)); });
    if (k.calendar) c.push(T(k.calendar.dayOffset ? 'rr.cal_tomorrow_s' : 'rr.cal_today_s', { match: k.calendar.match || T('rr.cal_any') }));
    return c.join(' · ');
  }

  /** Where rules are read and saved: the rules API (1.10.0), else the presence API of before. */
  function rulesBase(opts) { return opts.rulesBase || opts.base + '/rules'; }

  /** The list filter (Alle / Erinnerungen / Anwesenheit / Orte) above the rows; opts.filter keeps the choice. */
  function filterBar(data, opts, redraw) {
    var f = opts.filter || 'all';
    var count = function (x) { return x === 'all' ? data.rules.length : data.rules.filter(function (r) { return kindOf(r) === x; }).length; };
    // „Schule“ only when there is such a rule (or it is the choice)
    var bar = el('div', { class: 'fa-rm-tabs fa-rule-filter', role: 'tablist', 'aria-label': T('rr.filter') }, FILTERS.filter(function (x) { return x !== 'school' || f === x || count(x); }).map(function (x) {
      var n = count(x);
      return el('button', { type: 'button', role: 'tab', class: 'fa-rm-tab', 'aria-selected': f === x ? 'true' : 'false', 'data-filter': x, on: { click: function () { opts.filter = x; redraw(); } } },
        [el('span', { text: T('rr.filter_' + x) }), n ? el('span', { class: 'fa-rm-count', text: String(n) }) : null]);
    }));
    return bar;
  }

  /**
   * The rule rows into `box`; opts = { base, rulesBase, editable, reload, filter }. A rule the viewer may
   * only pause (a child's own reminder for a parent, portal) has the switch and „Löschen“, no „Bearbeiten“.
   */
  function render(box, data, opts) {
    A.clear(box);
    if (!data.rules.length) { box.appendChild(el('p', { class: 'fa-empty', text: T('rule.none') })); return; }
    box.appendChild(filterBar(data, opts, function () { render(box, data, opts); }));
    var shown = data.rules.filter(function (r) { return !opts.filter || opts.filter === 'all' || kindOf(r) === opts.filter; });
    if (!shown.length) box.appendChild(el('p', { class: 'fa-empty', text: T('rr.none_filter') }));
    shown.forEach(function (rule) {
      var chips = rule.actions.map(function (a) {
        var gone = a.type === 'quick_action' && a.available === false;
        var needs = a.type === 'quick_action' && !gone && a.needsTarget === true;
        var mp = msgProblem(a, data);
        if (mp) {
          return el('span', { class: 'fa-rule-act is-gone', text: actionText(a, data) + ' – ' + T(mp === 'gone' ? 'rule.msg_gone' : 'rule.msg_group_off'),
            title: T(mp === 'gone' ? 'rule.msg_gone_hint' : 'rule.msg_group_off_hint') });
        }
        var text = actionText(a, data) + (gone ? ' – ' + T('rule.action_gone') : (needs ? ' – ' + T('rule.needs_target') : ''));
        return el('span', { class: 'fa-rule-act' + (gone ? ' is-gone' : '') + (needs ? ' is-needs' : ''), text: text, title: gone ? T('rule.action_gone_hint') : (needs ? T('rule.needs_target_hint') : null) });
      });
      var meta = [];
      if (!rule.active) meta.push(T('rule.paused'));
      if (rule.scope === 'personal') meta.push(T('rr.personal_of', { name: rule.ownerName || '–' }));
      else if (rule.actions.some(function (a) { return a.type === 'quick_action'; }) && rule.ownerName) meta.push(T('rule.as', { name: rule.ownerName }));
      meta.push(rule.lastRunAt ? T('rule.last', { when: A.when(rule.lastRunAt) }) : T('rule.never'));
      var failed = rule.lastResult && !rule.lastResult.ok && !rule.lastResult.skipped;
      if (failed) meta.push(T('rule.failed'));
      var cond = conditionText(rule, data);
      // left: the summary and the action chips (they wrap); right, at the top: meta, switch, „Bearbeiten“ (own line, right-aligned, when it must wrap)
      var main = el('div', { class: 'fa-rule-main' }, [
        el('span', { class: 'fa-rule-when' }, [rule.name ? el('b', { text: rule.name }) : null, rule.name ? ' · ' : null, triggerText(rule, data), cond ? el('span', { class: 'fa-sub', text: ' (' + cond + ')' }) : null]),
        A.svg(ICON_ARROW, 18),
      ].concat(chips));
      var side = el('div', { class: 'fa-rule-side' }, [el('span', { class: 'fa-rule-meta' + (failed ? ' fa-bad' : ''), text: meta.join(' · ') })]);
      if (opts.editable && rule.pausable !== false) {
        side.appendChild(A.switchBtn(rule.active, T('rule.active'), function (on, b) {
          A.api('PATCH', rulesBase(opts) + '/' + rule.id, { active: on }).then(opts.reload).catch(function (e) { A.setSwitch(b, !on); A.warn(e); });
        }));
        if (rule.editable !== false) side.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('common.edit'), on: { click: function () { edit(rule, data, opts); } } }));
        else {
          side.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('common.delete'), on: { click: function () {
            A.confirm(T('rule.delete_confirm'), T('common.delete'), true).then(function (ok) { if (ok) A.api('DELETE', rulesBase(opts) + '/' + rule.id).then(opts.reload).catch(A.warn); });
          } } }));
        }
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
    var opt = data.options || {};
    var can = opt.can || { house: true, personal: false };
    var trigAvail = function (t) {
      var x = (opt.triggers || []).filter(function (y) { return y.type === t; })[0];
      // 1.12.0: the school trigger only when the server offers it (the Schule plugin is there)
      if (t === SCHOOL) return !!x && x.available !== false;
      return x ? x.available !== false : t !== 'schedule' || !!opt.triggers;
    };
    var r = rule || { trigger: trigAvail('all_away') ? 'all_away' : 'schedule', graceMinutes: 10, conditions: { time: null, afterSunset: false }, actions: [], active: true, name: '', userId: null, placeId: null };
    var listed = (data.actions || []).filter(function (a) { return a && a.plugin && a.id; });
    var byKey = {};
    listed.forEach(function (a) { byKey[keyOf(a.plugin, a.id)] = a; });
    var people = peopleOf(data);
    var oldNotify = r.actions.filter(function (a) { return a.type === 'notify'; })[0] || null;
    var oldMsg = r.actions.filter(function (a) { return a.type === 'messenger'; })[0] || null;
    var msgOn = msgAvailable(data);
    var msgGroup = !!(data.messenger && data.messenger.group);
    var cond = r.conditions || {};
    var clone = function (v) { return v == null ? v : JSON.parse(JSON.stringify(v)); };
    var st = {
      // 1.10.0: house rule or the viewer's own reminder (fixed once saved; a new one: what the viewer may)
      scope: r.scope || (can.house ? 'house' : 'personal'),
      days: r.schedule ? r.schedule.weekdays.slice() : [1, 2, 3, 4, 5], at: r.schedule && r.schedule.time ? r.schedule.time : '07:00',
      device: clone(cond.device) || [], calendar: clone(cond.calendar) || null,
      facts: oldNotify ? oldNotify.facts === true : false, buttons: oldNotify && Array.isArray(oldNotify.buttons) ? oldNotify.buttons.slice() : [],
      probe: null,
      name: r.name || '', trigger: r.trigger, userId: r.userId != null && !isPlace(r.trigger) ? r.userId : (people[0] ? people[0].userId : null),
      // a place rule: the person (null = anyone who shares places) and the place
      placeUser: isPlace(r.trigger) ? r.userId : null, placeId: r.placeId != null ? r.placeId : ((data.places || [])[0] ? data.places[0].id : null),
      grace: r.graceMinutes == null ? 10 : r.graceMinutes, active: r.active !== false,
      window: !!(r.conditions && r.conditions.time), from: r.conditions && r.conditions.time ? r.conditions.time.from : '22:00', to: r.conditions && r.conditions.time ? r.conditions.time.to : '06:00',
      sun: !!(r.conditions && r.conditions.afterSunset),
      steps: r.actions.filter(function (a) { return a.type === 'quick_action'; }).map(function (a) {
        return { key: keyOf(a.plugin, a.id), plugin: a.plugin, id: a.id, state: a.state === 'on' || a.state === 'off' ? a.state : null, title: a.title || null, verb: a.verb || null };
      }),
      notify: !!oldNotify, notifyTo: oldNotify ? oldNotify.to : 'parents', text: oldNotify && oldNotify.text ? oldNotify.text : '',
      // 1.6.0: the messenger message (one per rule): 'family' or [userId]
      msg: !!oldMsg, msgTo: oldMsg ? oldMsg.to : (msgGroup ? 'family' : []), msgText: oldMsg && oldMsg.text ? oldMsg.text : '',
      query: '', tab: null,
      // 1.12.0: „Stunde fällt aus“ — the child (null = every child), the kinds, the lesson's day
      schoolUser: r.trigger === SCHOOL && r.userId != null ? r.userId : null,
      kinds: r.school ? r.school.kinds.slice() : ['cancelled'], schoolDays: r.school ? r.school.days : 'any',
    };
    // plugin tabs in the order of the list, then the notification
    var tabs = [];
    listed.forEach(function (a) { if (!tabs.some(function (t) { return t.id === a.plugin; })) tabs.push({ id: a.plugin, label: a.pluginName || a.plugin }); });
    tabs.push({ id: '@notify', label: T('rule.m_notify_tab') });
    // only with the Messenger plugin — or to keep / remove the message of a rule that already has one
    if (msgOn || oldMsg) tabs.push({ id: '@messenger', label: T('rule.m_msg_tab') });
    var firstNeeds = st.steps.filter(function (s) { return needsTarget(s); })[0];
    st.tab = firstNeeds ? firstNeeds.plugin : (st.steps[0] && byKey[st.steps[0].key] ? st.steps[0].plugin : tabs[0].id);

    var opener = document.activeElement;
    var uid = 'fa-rm-' + Math.random().toString(36).slice(2, 8);
    var person = function () { return st.trigger === 'person_home' || st.trigger === 'person_away'; };
    var place = function () { return isPlace(st.trigger); };
    var personal = function () { return st.scope === 'personal'; };
    function needsTarget(s) { var a = byKey[s.key]; return !s.state && !!a && a.kind === 'toggle'; }
    function stepCount() { return st.steps.length + (st.notify ? 1 : 0) + (st.msg ? 1 : 0); }

    // ── header ──
    var nameInput = el('input', { class: 'fa-rm-name-input', type: 'text', maxlength: '60', value: st.name, 'aria-label': T('rule.m_name_aria'), placeholder: T('rule.m_name_ph'), autocomplete: 'off', 'data-k': 'name' });
    nameInput.addEventListener('input', function () { st.name = nameInput.value; });
    var activeBtn = el('button', { type: 'button', class: 'fa-rm-pill', 'aria-pressed': st.active ? 'true' : 'false', 'data-k': 'active' }, [el('span', { class: 'fa-rm-track' }, [el('span', { class: 'fa-rm-knob' })]), T('rule.active')]);
    activeBtn.addEventListener('click', function () { st.active = !st.active; activeBtn.setAttribute('aria-pressed', st.active ? 'true' : 'false'); });
    // „Gehört zu“: a new rule of someone who may make both (a parent in the portal); else what it is
    var scopeNode = null;
    if (!rule && can.house && can.personal) {
      var scopeSel = el('select', { class: 'form-select fa-rm-select', 'data-k': 'scope', 'aria-label': T('rr.scope') }, [
        el('option', { value: 'house', text: T('rr.scope_house') }), el('option', { value: 'personal', text: T('rr.scope_personal') }),
      ]);
      scopeSel.value = st.scope;
      scopeSel.addEventListener('change', function () { st.scope = scopeSel.value; renderWhat(); renderFlow(); });
      scopeNode = el('label', { class: 'fa-rm-name fa-rm-scope' }, [el('span', { text: T('rr.scope') }), scopeSel]);
    } else if (st.scope === 'personal') {
      scopeNode = el('span', { class: 'fa-rm-scope-tag', text: rule && rule.ownerName ? T('rr.scope_personal_of', { name: rule.ownerName }) : T('rr.scope_personal') });
    }
    var head = el('div', { class: 'fa-rm-head' }, [
      el('div', { class: 'fa-rm-titles' }, [el('span', { class: 'fa-rm-kicker', text: T('rule.m_kicker') }), el('h2', { id: uid + '-title', class: 'fa-rm-title', text: rule ? T('rule.edit') : T('rule.add') })]),
      el('label', { class: 'fa-rm-name' }, [el('span', { text: T('rule.m_name') }), nameInput]),
      scopeNode,
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
    var atInput = el('input', { type: 'time', class: 'fa-rm-time', value: st.at, 'data-k': 'at', id: uid + '-at' });
    atInput.addEventListener('input', function () { st.at = atInput.value; renderFlow(); });
    function switchBox(on) { return el('span', { class: 'fa-rm-track' + (on ? ' is-on' : '') }, [el('span', { class: 'fa-rm-knob' })]); }
    // the triggers the dialog offers: those that can run now, and the rule's own (a presence rule while „Anwesenheit“ is off)
    var offered = TRIGGERS.filter(function (t) { return trigAvail(t) || t === r.trigger; });
    function renderWhen() {
      var focus = focusKey();
      st.probe = null; // a change: the last dry run no longer holds
      A.clear(colWhen);
      colWhen.appendChild(colHead('1', T('rule.m_when'), uid + '-when'));
      var radios = [];
      var shownGroups = {};
      offered.forEach(function (t) {
        // three groups: a time (reminders), home / away from the home Wi-Fi, places (the phone's location)
        var g = t === 'schedule' ? 'time' : (isPlace(t) ? 'places' : (t === SCHOOL ? 'school' : 'home'));
        if (!shownGroups[g]) { shownGroups[g] = true; radios.push(el('span', { class: 'fa-rm-group-label', 'aria-hidden': 'true', text: T('rule.m_group_' + g) })); }
        radios.push(trigger(t));
      });
      function trigger(t) {
        var on = st.trigger === t;
        var avail = trigAvail(t);
        return el('button', {
          type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', tabindex: on ? '0' : '-1', class: 'fa-rm-trigger', 'data-k': 'trigger-' + t,
          on: { click: function () { setTrigger(t); } },
        }, [
          el('span', { class: 'fa-rm-trigger-ico' }, [A.svg(TRIGGER_ICON[t], 18)]),
          el('span', { class: 'fa-rm-trigger-text' }, [el('b', { text: T('rule.m_trig_' + t) }), el('span', { text: avail ? T('rule.m_trig_' + t + '_hint') : T(t === SCHOOL ? 'rule.m_needs_school' : 'rule.m_needs_presence') })]),
        ]);
      }
      var group = el('div', { class: 'fa-rm-triggers', role: 'radiogroup', 'aria-label': T('rule.m_triggers') }, radios);
      group.addEventListener('keydown', function (e) {
        var i = offered.indexOf(st.trigger);
        var d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : (e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0);
        if (!d) return;
        e.preventDefault();
        setTrigger(offered[(i + d + offered.length) % offered.length], true);
      });
      colWhen.appendChild(group);
      if (st.trigger === 'schedule') {
        colWhen.appendChild(el('div', { class: 'fa-rm-block' }, [
          el('span', { class: 'fa-rm-label', id: uid + '-days', text: T('rr.days') }),
          el('div', { class: 'fa-rm-chips fa-rm-days', role: 'group', 'aria-labelledby': uid + '-days' }, WEEKDAYS.map(function (d) {
            var on = st.days.indexOf(d) >= 0;
            return el('button', { type: 'button', class: 'fa-rm-chip fa-rm-day', 'aria-pressed': on ? 'true' : 'false', 'data-k': 'day-' + d, text: T('rr.wd_' + d), on: { click: function () {
              st.days = on ? st.days.filter(function (x) { return x !== d; }) : st.days.concat([d]).sort();
              renderWhen(); renderFlow();
            } } });
          })),
          el('div', { class: 'fa-rm-times' }, [el('label', { for: uid + '-at' }, [el('span', { text: T('rr.time') })]), atInput]),
        ]));
      }
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
      if (place()) placeBlocks();
      if (st.trigger === SCHOOL) schoolBlocks();
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
      // data.location: the coordinates (admin page), true (portal: set, not shown), null / false: none
      var loc = data.location !== undefined ? data.location : (opt.location === undefined ? undefined : opt.location);
      var sunHint = loc === null || loc === false ? T('rule.m_sun_none') : (loc && loc.lat != null ? T('rule.m_sun_at', { lat: loc.lat, lon: loc.lon }) : T('rule.m_sun_hint'));
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
        deviceBlock(),
        calendarBlock(),
      ]));
      restore(focus);
    }
    /** „Nur wenn“ a device value (1.9.0): the box switches the first condition on / all off; up to 4 rows. */
    function deviceBlock() {
      var devices = opt.devices || [];
      var on = st.device.length > 0;
      var none = !devices.length && !on;
      var hint = none ? (opt.features && opt.features.deviceValues === false ? T('rr.values_old') : T('rr.no_devices')) : T('rule.m_device_hint');
      var box = el('button', { type: 'button', class: 'fa-rm-box fa-rm-cond', 'aria-pressed': on ? 'true' : 'false', disabled: none, 'data-k': 'device', on: { click: function () {
        if (on) st.device = [];
        else { var d0 = devices[0]; st.device.push({ actionId: d0.actionId, field: d0.fields[0].id, op: '<', value: 50, label: d0.fields[0].label, unit: d0.fields[0].unit || null }); }
        renderWhen(); renderFlow();
      } } }, [A.svg(ICON.gauge, 18), el('span', { class: 'fa-rm-box-text' }, [el('b', { text: T('rr.c_device') }), el('span', { text: hint })]), switchBox(on)]);
      if (!on) return box;
      var rows = st.device.map(function (d, i) {
        var dev = devices.filter(function (x) { return x.actionId === d.actionId; })[0];
        var fields = dev ? dev.fields : [{ id: d.field, label: d.label || d.field, unit: d.unit, current: null }];
        var f = fields.filter(function (x) { return x.id === d.field; })[0] || fields[0];
        var devSel = el('select', { class: 'form-select fa-rm-select', 'aria-label': T('rr.device'), 'data-k': 'dev-' + i }, (dev ? [] : [el('option', { value: d.actionId, text: deviceName(data, d.actionId) + ' – ' + T('rr.gone') })])
          .concat(devices.map(function (x) { return el('option', { value: x.actionId, text: x.label }); })));
        devSel.value = d.actionId;
        devSel.addEventListener('change', function () {
          var nd = devices.filter(function (x) { return x.actionId === devSel.value; })[0];
          d.actionId = nd.actionId; d.field = nd.fields[0].id; d.label = nd.fields[0].label; d.unit = nd.fields[0].unit || null;
          renderWhen(); renderFlow();
        });
        var fieldSel = el('select', { class: 'form-select fa-rm-select', 'aria-label': T('rr.field'), 'data-k': 'dev-field-' + i }, fields.map(function (x) { return el('option', { value: x.id, text: x.label }); }));
        fieldSel.value = f.id;
        fieldSel.addEventListener('change', function () {
          var nf = fields.filter(function (x) { return x.id === fieldSel.value; })[0];
          d.field = nf.id; d.label = nf.label; d.unit = nf.unit || null;
          renderWhen(); renderFlow();
        });
        var opSel = el('select', { class: 'form-select fa-rm-select fa-rm-op', 'aria-label': T('rr.op'), 'data-k': 'dev-op-' + i }, OPS.map(function (x) { return el('option', { value: x, text: x }); }));
        opSel.value = d.op;
        opSel.addEventListener('change', function () { d.op = opSel.value; renderFlow(); });
        var val = el('input', { type: 'number', step: 'any', class: 'form-input fa-rm-num-input', value: String(d.value), 'aria-label': T('rr.value'), 'data-k': 'dev-val-' + i });
        val.addEventListener('input', function () { var n = parseFloat(val.value); d.value = isFinite(n) ? n : 0; renderFlow(); });
        return el('div', { class: 'fa-rm-cond-row' }, [
          el('div', { class: 'fa-rm-cond-line' }, [devSel, el('button', { type: 'button', class: 'fa-rm-icon-btn', 'aria-label': T('rr.remove', { name: T('rr.c_device') }), 'data-k': 'dev-x-' + i,
            on: { click: function () { st.device.splice(i, 1); renderWhen(); renderFlow(); } } }, [A.svg(ICON.x, 16)])]),
          el('div', { class: 'fa-rm-cond-line' }, [fieldSel, opSel, val, f && f.unit ? el('span', { class: 'fa-rm-unit', text: f.unit }) : null]),
          el('span', { class: 'fa-hint', text: f && f.current ? T('rr.now', { value: f.current }) : (opt.features && opt.features.deviceValues === false ? T('rr.values_old') : T('rr.now_unknown')) }),
        ]);
      });
      var more = st.device.length < MAX_DEVICE_CONDS && devices.length ? el('button', { type: 'button', class: 'fa-rm-link', 'data-k': 'dev-more', on: { click: function () {
        var d0 = devices[0];
        st.device.push({ actionId: d0.actionId, field: d0.fields[0].id, op: '<', value: 50, label: d0.fields[0].label, unit: d0.fields[0].unit || null });
        renderWhen(); renderFlow();
      } } }, [T('rule.m_device_more')]) : null;
      return el('div', { class: 'fa-rm-cond-wrap' }, [box].concat(rows).concat([more]));
    }
    /** „Nur wenn“ an event today / tomorrow (Familie dates, Alltag calendars). */
    function calendarBlock() {
      var cals = opt.calendars || [];
      var on = !!st.calendar;
      var none = !cals.length && !on;
      var box = el('button', { type: 'button', class: 'fa-rm-box fa-rm-cond', 'aria-pressed': on ? 'true' : 'false', disabled: none, 'data-k': 'calendar', on: { click: function () {
        st.calendar = on ? null : { dayOffset: 1, sources: [cals[0].source], match: '', memberIds: null };
        renderWhen(); renderFlow();
      } } }, [A.svg(ICON.cal, 18), el('span', { class: 'fa-rm-box-text' }, [el('b', { text: T('rr.c_calendar') }), el('span', { text: none ? T('rule.m_calendar_none') : T('rule.m_calendar_hint') })]), switchBox(on)]);
      if (!on) return box;
      var c = st.calendar;
      var day = el('div', { class: 'fa-rm-chips', role: 'group', 'aria-label': T('rr.day') }, [0, 1].map(function (n) {
        return el('button', { type: 'button', class: 'fa-rm-chip', 'aria-pressed': c.dayOffset === n ? 'true' : 'false', 'data-k': 'cal-day-' + n, text: T(n ? 'rr.tomorrow' : 'rr.today'),
          on: { click: function () { c.dayOffset = n; renderWhen(); renderFlow(); } } });
      }));
      var srcs = el('div', { class: 'fa-rm-chips', role: 'group', 'aria-label': T('rule.m_calendars') }, cals.map(function (s) {
        var picked = c.sources.indexOf(s.source) >= 0;
        return el('button', { type: 'button', class: 'fa-rm-chip', 'aria-pressed': picked ? 'true' : 'false', 'data-k': 'cal-src-' + s.source, text: s.label, on: { click: function () {
          c.sources = picked ? c.sources.filter(function (x) { return x !== s.source; }) : c.sources.concat([s.source]);
          renderWhen(); renderFlow();
        } } });
      }));
      var match = el('input', { type: 'text', class: 'form-input', maxlength: '60', value: c.match || '', placeholder: T('rr.match_ph'), 'data-k': 'cal-match', id: uid + '-cal-match' });
      match.addEventListener('input', function () { c.match = match.value; renderFlow(); });
      return el('div', { class: 'fa-rm-cond-wrap' }, [box, el('div', { class: 'fa-rm-cond-row' }, [
        day, el('span', { class: 'fa-rm-label', text: T('rule.m_calendars') }), srcs,
        el('label', { class: 'fa-rm-label', for: uid + '-cal-match', text: T('rr.match') }), match,
      ])]);
    }
    /** Wann? for a place trigger: who („Jemand“ or a person), which place (+ „Orte verwalten“), who shares places. */
    function placeBlocks() {
      var chip = function (key, on, kids, extra, pick) {
        return el('button', { type: 'button', class: 'fa-rm-person' + (extra || ''), 'aria-pressed': on ? 'true' : 'false', 'data-k': key, on: { click: function () { pick(); renderWhen(); renderFlow(); } } }, kids);
      };
      var chips = [chip('pwho-any', st.placeUser == null, [el('span', { class: 'fa-rm-any' }, [A.svg(ICON.group, 16)]), el('span', { text: T('rule.m_who_any') })], '', function () { st.placeUser = null; })];
      people.forEach(function (m) {
        chips.push(chip('pwho-' + m.userId, st.placeUser === m.userId, [A.avatar({ name: m.name, initials: m.initials, colorHex: m.colorHex, avatarUrl: m.avatarUrl }, 28), el('span', { text: m.name })],
          m.placesShared ? '' : ' is-dim', function () { st.placeUser = m.userId; }));
      });
      colWhen.appendChild(el('div', { class: 'fa-rm-block' }, [
        el('span', { class: 'fa-rm-label', id: uid + '-pwho', text: T('rule.m_who') }),
        el('div', { class: 'fa-rm-people', role: 'group', 'aria-labelledby': uid + '-pwho' }, chips),
      ]));
      var list = data.places || [];
      // „Orte verwalten“ only for who may (the admin page, parents in the portal)
      var manage = opts.managePlaces === false ? null : el('button', { type: 'button', class: 'fa-rm-link', 'data-k': 'places-manage', on: { click: function () { managePlaces(data, opts, placesChanged); } } }, [A.svg(ICON.pin, 14), T('rule.m_places_manage')]);
      var row;
      if (list.length) {
        var sel = el('select', { class: 'form-select fa-rm-select', id: uid + '-place', 'data-k': 'place' }, list.map(function (p) {
          return el('option', { value: String(p.id), text: p.name + ' · ' + radiusText(p.radius) });
        }));
        if (!placeOf(data, st.placeId)) st.placeId = list[0].id;
        sel.value = String(st.placeId);
        sel.addEventListener('change', function () { st.placeId = Number(sel.value); renderFlow(); });
        row = sel;
      } else {
        st.placeId = null;
        row = el('div', { class: 'fa-rm-box fa-rm-place-none' }, [el('span', { class: 'fa-rm-box-text' }, [el('b', { text: T('rule.m_place_none') }), el('span', { text: T('rule.m_place_none_hint') })])]);
      }
      var sharing = people.filter(function (m) { return m.placesShared; }).map(function (m) { return m.name; });
      var who = st.placeUser != null ? people.filter(function (m) { return m.userId === st.placeUser; })[0] : null;
      var off = who && !who.placesShared;
      colWhen.appendChild(el('div', { class: 'fa-rm-block', 'data-place-block': '1' }, [
        el('div', { class: 'fa-rm-label-row' }, [el('label', { class: 'fa-rm-label', for: list.length ? uid + '-place' : null, text: T('rule.m_place') }), manage]),
        row,
        el('div', { class: 'fa-rm-info fa-rm-places-info' + (off ? ' is-warn' : '') }, [A.svg(ICON.info, 18), el('span', null, [
          T('rule.m_places_hint') + ' ',
          el('b', { text: sharing.length ? T('rule.m_places_on', { names: sharing.join(', ') }) : T('rule.m_places_nobody') }),
          off ? el('span', { class: 'fa-rm-warn-line', text: T('rule.m_places_off_person', { name: who.name }) }) : null,
        ])]),
      ]));
    }
    /** Wann? for „Stunde fällt aus“ (1.12.0): which child (or every child), which changes, the lesson's day. */
    function schoolBlocks() {
      var kids = ((opt.school && opt.school.students) || []).slice();
      // the rule's own child stays choosable when the Schule plugin no longer lists it
      if (st.schoolUser != null && !kids.some(function (k) { return k.userId === st.schoolUser; })) kids.push({ userId: st.schoolUser, name: nameOf(data, st.schoolUser) });
      var face = function (id, name) {
        var m = people.filter(function (x) { return x.userId === id; })[0] || { name: name };
        return A.avatar({ name: m.name || name, initials: m.initials, colorHex: m.colorHex, avatarUrl: m.avatarUrl }, 28);
      };
      var chip = function (key, on, kids2, pick) {
        return el('button', { type: 'button', class: 'fa-rm-person', 'aria-pressed': on ? 'true' : 'false', 'data-k': key, on: { click: function () { pick(); renderWhen(); renderFlow(); } } }, kids2);
      };
      var who = [chip('swho-any', st.schoolUser == null, [el('span', { class: 'fa-rm-any' }, [A.svg(ICON.group, 16)]), el('span', { text: T('rule.m_school_any') })], function () { st.schoolUser = null; })];
      kids.forEach(function (k) {
        who.push(chip('swho-' + k.userId, st.schoolUser === k.userId, [face(k.userId, k.name), el('span', { text: k.name })], function () { st.schoolUser = k.userId; }));
      });
      colWhen.appendChild(el('div', { class: 'fa-rm-block' }, [
        el('span', { class: 'fa-rm-label', id: uid + '-swho', text: T('rule.m_school_who') }),
        el('div', { class: 'fa-rm-people', role: 'group', 'aria-labelledby': uid + '-swho' }, who),
      ]));
      colWhen.appendChild(el('div', { class: 'fa-rm-block' }, [
        el('span', { class: 'fa-rm-label', id: uid + '-skinds', text: T('rule.m_school_kinds') }),
        el('div', { class: 'fa-rm-chips', role: 'group', 'aria-labelledby': uid + '-skinds' }, SCHOOL_KINDS.map(function (k) {
          var on = st.kinds.indexOf(k) >= 0;
          return el('button', { type: 'button', class: 'fa-rm-chip', 'aria-pressed': on ? 'true' : 'false', 'data-k': 'skind-' + k, text: T('school.kind_' + k), on: { click: function () {
            st.kinds = on ? st.kinds.filter(function (x) { return x !== k; }) : SCHOOL_KINDS.filter(function (x) { return x === k || st.kinds.indexOf(x) >= 0; });
            renderWhen(); renderFlow();
          } } });
        })),
        el('span', { class: 'fa-rm-label', id: uid + '-sdays', text: T('rule.m_school_days') }),
        el('div', { class: 'fa-rm-chips', role: 'radiogroup', 'aria-labelledby': uid + '-sdays' }, SCHOOL_DAYS.map(function (d) {
          var on = st.schoolDays === d;
          return el('button', { type: 'button', class: 'fa-rm-chip', role: 'radio', 'aria-checked': on ? 'true' : 'false', 'aria-pressed': on ? 'true' : 'false', 'data-k': 'sday-' + d, text: T('school.days_' + d),
            on: { click: function () { st.schoolDays = d; renderWhen(); renderFlow(); } } });
        })),
        el('div', { class: 'fa-rm-info' }, [A.svg(ICON.info, 18), el('span', { text: T('rule.m_school_hint') })]),
      ]));
    }
    /** After a change in „Orte verwalten“: the new list; a place just added or edited becomes the rule's place. */
    function placesChanged(saved) {
      if (saved) st.placeId = saved.id;
      renderWhen();
      renderFlow();
    }
    function setTrigger(t, keyboard) {
      st.trigger = t;
      renderWhen();
      renderFlow();
      if (keyboard) { var b = colWhen.querySelector('[data-k="trigger-' + t + '"]'); if (b) b.focus(); }
      if (place()) showPlace();
    }
    /** The place blocks sit below the triggers: scroll Wann? so the place can be seen. */
    function showPlace() {
      var blk = colWhen.querySelector('[data-place-block]');
      if (!blk || window.matchMedia('(max-width: 760px)').matches) return;
      var over = blk.getBoundingClientRect().bottom - colWhen.getBoundingClientRect().bottom + 16;
      if (over > 0) colWhen.scrollTop += over;
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
      if (tabId === '@messenger') return st.msg ? 1 : 0;
      return st.steps.filter(function (s) { return s.plugin === tabId; }).length;
    }
    function renderWhat() {
      var focus = focusKey();
      st.probe = null;
      A.clear(tabBar);
      var q = st.query.trim().toLowerCase();
      tabs.forEach(function (t, i) {
        var on = !q && st.tab === t.id;
        var n = countOf(t.id);
        tabBar.appendChild(el('button', {
          type: 'button', role: 'tab', class: 'fa-rm-tab', 'aria-selected': on ? 'true' : 'false', 'aria-controls': uid + '-panel', tabindex: on || (q && i === 0) ? '0' : '-1', 'data-k': 'tab-' + t.id,
          on: { click: function () { selectTab(t.id); } },
        }, [t.id === '@notify' ? A.svg(ICON.bell, 16) : (t.id === '@messenger' ? A.svg(ICON.chat, 16) : null), el('span', { text: t.label }), n ? el('span', { class: 'fa-rm-count', text: String(n) }) : null,
          n ? el('span', { class: 'fa-sr', text: ' – ' + T('rule.m_tab_count', { n: n }) }) : null]));
      });
      A.clear(cards);
      if (!q && st.tab === '@notify') { cards.appendChild(notifyPanel()); restore(focus); return; }
      if (!q && st.tab === '@messenger') { cards.appendChild(messengerPanel()); restore(focus); return; }
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
      var groups = [{ id: 'parents', label: T('rule.to_parents') }, { id: 'all', label: T('rule.to_all') }];
      var picked = Array.isArray(st.notifyTo) ? st.notifyTo : [];
      // single people (any number) instead of a group; none left → back to the parents
      function togglePerson(id) {
        var next = picked.indexOf(id) >= 0 ? picked.filter(function (x) { return x !== id; }) : picked.concat([id]);
        st.notifyTo = next.length ? next : 'parents';
        renderWhat(); renderFlow();
      }
      var text = el('input', { type: 'text', class: 'form-input', maxlength: '120', value: st.text, placeholder: T('rule.text_default'), 'data-k': 'notify-text', id: uid + '-text' });
      text.addEventListener('input', function () { st.text = text.value; });
      var add = el('button', { type: 'button', class: 'fa-rm-run fa-rm-notify-add', 'aria-pressed': st.notify ? 'true' : 'false', 'data-k': 'notify-add', text: st.notify ? T('rule.m_notify_added') : T('rule.m_notify_add'), on: { click: function () {
        if (!st.notify && stepCount() >= MAX_STEPS) { msg.textContent = T('rule.m_max', { n: MAX_STEPS }); return; }
        st.notify = !st.notify; renderWhat(); renderFlow();
      } } });
      // 1.10.0: values and event under the text, and up to 3 buttons (snooze, done, a device's button)
      var factsBtn = el('button', { type: 'button', class: 'fa-rm-box fa-rm-cond', 'aria-pressed': st.facts ? 'true' : 'false', 'data-k': 'facts', on: { click: function () { st.facts = !st.facts; renderWhat(); } } },
        [el('span', { class: 'fa-rm-box-text' }, [el('b', { text: T('rr.facts') }), el('span', { text: T('rule.m_facts_hint') })]), switchBox(st.facts)]);
      var hasBtn = function (b) { return st.buttons.indexOf(b) >= 0; };
      var toggleBtn = function (b) {
        if (hasBtn(b)) st.buttons = st.buttons.filter(function (x) { return x !== b; });
        else if (st.buttons.length < MAX_BUTTONS) st.buttons.push(b);
        else { msg.textContent = T('rule.m_buttons_max', { n: MAX_BUTTONS }); return; }
        renderWhat();
      };
      var qaNow = st.buttons.filter(function (b) { return b.indexOf('quick_action:') === 0; })[0] || '';
      var qaSel = el('select', { class: 'form-select fa-rm-select', id: uid + '-qa-btn', 'data-k': 'qa-btn' }, [el('option', { value: '', text: T('rr.btn_none') })]
        .concat(listed.filter(function (a) { return a.kind !== 'toggle'; }).map(function (a) { return el('option', { value: 'quick_action:' + a.plugin + '/' + a.id, text: labelOf(a) }); })));
      if (qaNow && !qaSel.querySelector('option[value="' + qaNow.replace(/"/g, '') + '"]')) qaSel.appendChild(el('option', { value: qaNow, text: qaNow.slice(13) + ' – ' + T('rr.gone') }));
      qaSel.value = qaNow;
      qaSel.addEventListener('change', function () {
        var rest = st.buttons.filter(function (b) { return b.indexOf('quick_action:') !== 0; });
        if (qaSel.value && rest.length >= MAX_BUTTONS) { qaSel.value = qaNow; msg.textContent = T('rule.m_buttons_max', { n: MAX_BUTTONS }); return; }
        st.buttons = qaSel.value ? rest.concat([qaSel.value]) : rest;
        renderWhat();
      });
      var buttons = [
        el('div', { class: 'fa-rm-label', id: uid + '-btns', text: T('rr.buttons') }),
        el('div', { class: 'fa-rm-chips', role: 'group', 'aria-labelledby': uid + '-btns' }, [['snooze_1h', 'rule.m_btn_snooze'], ['done', 'rule.m_btn_done']].map(function (x) {
          return el('button', { type: 'button', class: 'fa-rm-chip', 'aria-pressed': hasBtn(x[0]) ? 'true' : 'false', 'data-k': 'btn-' + x[0], text: T(x[1]), on: { click: function () { toggleBtn(x[0]); } } });
        })),
        el('label', { class: 'fa-rm-label', for: uid + '-qa-btn', text: T('rr.btn_device') }), qaSel,
        opt.features && opt.features.buttons === false ? el('p', { class: 'fa-hint', text: T('rr.buttons_old') }) : null,
      ];
      // an own reminder tells only its owner
      var recipients = personal() ? [
        el('div', { class: 'fa-rm-label', text: T('rule.notify_to') }),
        el('div', { class: 'fa-rm-chips' }, [el('span', { class: 'fa-rm-chip', 'aria-pressed': 'true', text: T('rr.to_me') })]),
      ] : [
        el('div', { class: 'fa-rm-label', id: uid + '-to', text: T('rule.notify_to') }),
        el('div', { class: 'fa-rm-chips', role: 'group', 'aria-labelledby': uid + '-to' }, groups.map(function (c) {
          return el('button', { type: 'button', class: 'fa-rm-chip', 'aria-pressed': st.notifyTo === c.id ? 'true' : 'false', 'data-k': 'to-' + c.id, text: c.label, on: { click: function () { st.notifyTo = c.id; renderWhat(); renderFlow(); } } });
        })),
        el('div', { class: 'fa-rm-label', id: uid + '-to-people', text: T('rule.m_notify_people') }),
        el('div', { class: 'fa-rm-people', role: 'group', 'aria-labelledby': uid + '-to-people' }, people.map(function (m) {
          return el('button', { type: 'button', class: 'fa-rm-person', 'aria-pressed': picked.indexOf(m.userId) >= 0 ? 'true' : 'false', 'data-k': 'to-person-' + m.userId, on: { click: function () { togglePerson(m.userId); } } },
            [A.avatar({ name: m.name, initials: m.initials, colorHex: m.colorHex, avatarUrl: m.avatarUrl }, 28), el('span', { text: m.name })]);
        })),
        el('p', { class: 'fa-hint', text: T('rule.m_notify_self') }),
      ];
      return el('div', { class: 'fa-rm-notify' + (st.notify ? ' is-on' : '') }, [
        el('div', { class: 'fa-rm-card-top' }, [
          el('span', { class: 'fa-rm-card-ico' }, [A.svg(ICON.bell, 20)]),
          el('span', { class: 'fa-rm-card-text' }, [el('b', { text: T('rule.m_notify_title') }), el('span', { text: T('rule.m_notify_hint') })]),
          add,
        ]),
      ].concat(recipients).concat([
        el('label', { class: 'fa-rm-label', for: uid + '-text', text: T('rule.m_text') }),
        text,
        el('p', { class: 'fa-hint', text: T('rr.text_hint') }),
        factsBtn,
      ]).concat(buttons));
    }

    /** 1.6.0: „Messenger-Nachricht senden“ — the group „Familie“ or single people (the chips of the notification). */
    function messengerPanel() {
      var picked = Array.isArray(st.msgTo) ? st.msgTo : [];
      function togglePerson(id) {
        var next = picked.indexOf(id) >= 0 ? picked.filter(function (x) { return x !== id; }) : picked.concat([id]);
        // none left → back to the group (when it is on)
        st.msgTo = next.length ? next : (msgGroup ? 'family' : []);
        renderWhat(); renderFlow();
      }
      var text = el('input', { type: 'text', class: 'form-input', maxlength: '500', value: st.msgText, placeholder: T('rule.text_default'), 'data-k': 'msg-text', id: uid + '-msg-text' });
      text.addEventListener('input', function () { st.msgText = text.value; });
      var add = el('button', { type: 'button', class: 'fa-rm-run fa-rm-notify-add', 'aria-pressed': st.msg ? 'true' : 'false', 'data-k': 'msg-add', text: st.msg ? T('rule.m_notify_added') : T('rule.m_notify_add'), disabled: !msgOn && !st.msg, on: { click: function () {
        if (!st.msg && stepCount() >= MAX_STEPS) { msg.textContent = T('rule.m_max', { n: MAX_STEPS }); return; }
        st.msg = !st.msg; renderWhat(); renderFlow();
      } } });
      var groupOn = st.msgTo === 'family';
      return el('div', { class: 'fa-rm-notify' + (st.msg ? ' is-on' : '') }, [
        el('div', { class: 'fa-rm-card-top' }, [
          el('span', { class: 'fa-rm-card-ico' }, [A.svg(ICON.chat, 20)]),
          el('span', { class: 'fa-rm-card-text' }, [el('b', { text: T('rule.m_msg_title') }), el('span', { text: T('rule.m_msg_hint') })]),
          add,
        ]),
        msgOn ? null : el('div', { class: 'fa-rm-info is-warn' }, [A.svg(ICON.info, 18), el('span', { text: T('rule.m_msg_unavailable') })]),
      ].concat(personal() ? [
        el('div', { class: 'fa-rm-label', text: T('rule.notify_to') }),
        el('div', { class: 'fa-rm-chips' }, [el('span', { class: 'fa-rm-chip', 'aria-pressed': 'true', text: T('rr.to_me') })]),
      ] : [
        el('div', { class: 'fa-rm-label', id: uid + '-msg-to', text: T('rule.notify_to') }),
        el('div', { class: 'fa-rm-chips', role: 'group', 'aria-labelledby': uid + '-msg-to' }, [
          el('button', { type: 'button', class: 'fa-rm-chip', 'aria-pressed': groupOn ? 'true' : 'false', disabled: !msgGroup && !groupOn, 'data-k': 'msg-to-family', text: T('rule.m_msg_group'),
            on: { click: function () { st.msgTo = 'family'; renderWhat(); renderFlow(); } } }),
        ]),
        msgGroup ? null : el('p', { class: 'fa-hint', text: T('rule.m_msg_group_off') }),
        el('div', { class: 'fa-rm-label', id: uid + '-msg-people', text: T('rule.m_msg_people') }),
        el('div', { class: 'fa-rm-people', role: 'group', 'aria-labelledby': uid + '-msg-people' }, people.map(function (m) {
          return el('button', { type: 'button', class: 'fa-rm-person', 'aria-pressed': picked.indexOf(m.userId) >= 0 ? 'true' : 'false', 'data-k': 'msg-person-' + m.userId, on: { click: function () { togglePerson(m.userId); } } },
            [A.avatar({ name: m.name, initials: m.initials, colorHex: m.colorHex, avatarUrl: m.avatarUrl }, 28), el('span', { text: m.name })]);
        })),
        el('p', { class: 'fa-hint', text: T('rule.m_msg_people_hint') }),
      ]).concat([
        el('label', { class: 'fa-rm-label', for: uid + '-msg-text', text: T('rule.m_text') }),
        text,
        el('p', { class: 'fa-hint', text: T('rr.text_hint') }),
      ]));
    }

    // ── column 3: Ablauf ──
    var flowCount = el('span', { class: 'fa-rm-mono fa-rm-muted' });
    var flowList = el('div', { class: 'fa-rm-scroll fa-rm-flow-list' });
    function sentence() {
      var pl = place() ? placeOf(data, st.placeId) : null;
      var who = st.trigger === 'schedule' ? T('rule.trigger_schedule', { days: daysText(st.days.slice().sort()), time: st.at || '–' })
        : (person() ? T('rule.trigger_' + st.trigger, { name: nameOf(data, st.userId) })
          : (place() ? T('rule.trigger_' + st.trigger, { name: st.placeUser == null ? T('rule.someone') : nameOf(data, st.placeUser), place: pl ? pl.name + ' (' + radiusText(pl.radius) + ')' : '…' })
            : (st.trigger === SCHOOL ? schoolText(st.schoolUser, { kinds: st.kinds.length ? st.kinds : ['cancelled'], days: st.schoolDays }, data) : T('rule.trigger_' + st.trigger))));
      var parts = [who + (st.trigger === 'all_away' && st.grace > 0 ? ' (' + T('rule.m_s_grace', { n: st.grace }) + ')' : '')];
      if (st.window && st.from && st.to) parts.push(T('rule.m_s_window', { from: st.from, to: st.to }));
      if (st.sun) parts.push(T('rule.after_sunset'));
      st.device.forEach(function (d) { parts.push(deviceCondText(d, data)); });
      if (st.calendar) parts.push(T(st.calendar.dayOffset ? 'rr.cal_tomorrow_s' : 'rr.cal_today_s', { match: st.calendar.match || T('rr.cal_any') }));
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
        var to = personal() ? T('rr.to_me') : st.notifyTo === 'parents' ? T('rule.m_to_parents') : (st.notifyTo === 'all' ? T('rule.m_to_all') : T('rule.m_to_people', { names: (st.notifyTo || []).map(function (id) { return nameOf(data, id); }).join(', ') }));
        flowList.appendChild(stepRow(++n, T('rule.notify'), to, T('rule.m_push'), 'neutral', function () { st.notify = false; renderWhat(); renderFlow(); }, 'step-notify'));
      }
      if (st.msg) {
        var mto = personal() ? T('rr.to_me') : st.msgTo === 'family' ? T('rule.m_msg_to_family') : T('rule.m_to_people', { names: (st.msgTo || []).map(function (id) { return nameOf(data, id); }).join(', ') });
        flowList.appendChild(stepRow(++n, T('rule.messenger'), msgOn ? mto : T('rule.msg_gone'), T('rule.m_msg_chip'), msgOn ? 'neutral' : 'gone', function () { st.msg = false; renderWhat(); renderFlow(); }, 'step-msg'));
      }
      if (!n) flowList.appendChild(el('div', { class: 'fa-rm-flow-empty', text: T('rule.m_empty') }));
      if (st.probe) flowList.appendChild(probeBox(st.probe));
      flowList.appendChild(el('div', { class: 'fa-rm-info' }, [A.svg(ICON.info, 18), el('span', { text: T('rule.m_hint_fixed') })]));
      footHint.textContent = n ? T(st.trigger === 'schedule' ? 'rule.m_foot_ok_schedule' : 'rule.m_foot_ok') : T('rule.actions_required');
      restore(focus);
    }
    function stepRow(n, title, where, target, tone, remove, k) {
      return el('div', { class: 'fa-rm-step' }, [
        el('span', { class: 'fa-rm-step-n', text: String(n) }),
        el('span', { class: 'fa-rm-step-text' }, [el('b', { text: title }), el('span', { class: 'fa-rm-step-meta' }, [el('span', { class: 'fa-rm-step-chip is-' + tone, text: target }), where ? el('span', { text: where }) : null])]),
        el('button', { type: 'button', class: 'fa-rm-icon-btn fa-rm-step-x', 'aria-label': T('rule.m_remove', { name: title }), 'data-k': k, on: { click: remove } }, [A.svg(ICON.x, 16)]),
      ]);
    }
    /** The dry run's answer (1.10.0): would it fire today, and each check. */
    function probeBox(p) {
      return el('div', { class: 'fa-rm-probe' + (p.wouldFire ? ' is-ok' : ' is-no'), role: 'status' }, [
        el('b', { text: p.wouldFire ? T('rr.would_fire') : T('rr.would_not') }),
        el('ul', { class: 'fa-rm-probe-list' }, (p.details || []).map(function (d) {
          return el('li', { class: d.ok === false ? 'fa-bad' : (d.ok ? 'fa-ok' : null), text: d.text });
        })),
      ]);
    }
    var runsAs = el('div', { class: 'fa-rm-runs', text: opts.base === 'admin/presence' ? T('rule.m_runs_admin') : T('rule.m_runs_you') });

    // ── footer ──
    var footHint = el('span', { class: 'fa-rm-foot-hint' });
    var msg = el('span', { class: 'fa-rm-msg', role: 'status', 'aria-live': 'polite' });
    var save = el('button', { type: 'button', class: 'btn btn-primary fa-rm-save', text: T('rule.m_save'), on: { click: submit } });
    var probeBtn = opts.rulesBase ? el('button', { type: 'button', class: 'btn', text: T('rule.m_test'), title: T('rr.probe_hint'), on: { click: probe } }) : null;
    var foot = el('div', { class: 'fa-rm-foot' }, [
      el('span', { class: 'fa-rm-foot-text' }, [msg, footHint]),
      el('span', { class: 'fa-spacer' }),
      probeBtn,
      rule ? el('button', { type: 'button', class: 'btn btn-danger', text: T('common.delete'), on: { click: function () {
        close();
        A.confirm(T('rule.delete_confirm'), T('common.delete'), true).then(function (ok) { if (ok) A.api('DELETE', rulesBase(opts) + '/' + rule.id).then(opts.reload).catch(A.warn); });
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
      if (stack.indexOf(ov) >= 0) stack.splice(stack.indexOf(ov), 1);
      ov.remove();
      if (opener && opener.focus && document.body.contains(opener)) opener.focus();
    }
    // keyboard: Escape closes, Tab stays inside the dialog
    function onKey(e) {
      if (closed || stack[stack.length - 1] !== ov) return;
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

    /** The checks before saving or a dry run: null, or the message (and the tab to show). */
    function check(forTest) {
      if (!forTest && !stepCount()) return T('rule.actions_required');
      var missing = st.steps.filter(needsTarget)[0];
      if (missing) { selectTab(missing.plugin); return T('rule.m_target_missing', { name: byKey[missing.key].title }); }
      if (st.trigger === 'schedule' && (!st.days.length || !st.at)) return T('rr.err_schedule');
      if (st.window && (!st.from || !st.to)) return T('rule.window_both');
      if (st.window && st.from === st.to) return T('rule.m_window_same');
      if (st.calendar && !st.calendar.sources.length) return T('rr.err_sources');
      if (person() && !st.userId) return T('rule.m_who_missing');
      if (place() && !placeOf(data, st.placeId)) return T('rule.m_place_missing');
      if (st.trigger === SCHOOL && !st.kinds.length) return T('rule.m_school_kinds_missing');
      if (st.msg && !personal()) {
        // people who are no members any more drop out
        if (Array.isArray(st.msgTo)) st.msgTo = st.msgTo.filter(function (id) { return people.some(function (m) { return m.userId === id; }); });
        if (Array.isArray(st.msgTo) && !st.msgTo.length) { selectTab('@messenger'); return T('rule.m_msg_to_missing'); }
      }
      return null;
    }

    /** The rule as the rules API takes it (1.10.0: the trigger as an object, title, the new conditions and notify fields). */
    function body() {
      var actions = st.steps.map(function (s) {
        var a = byKey[s.key];
        var out = { type: 'quick_action', plugin: s.plugin, id: s.id, title: (a ? labelOf(a) : s.title) || null };
        if (s.state) out.state = s.state;
        return out;
      });
      if (st.notify) actions.push({ type: 'notify', to: personal() ? 'me' : st.notifyTo, text: st.text.trim() || null, facts: st.facts, buttons: st.buttons.slice(0, MAX_BUTTONS) });
      if (st.msg) actions.push({ type: 'messenger', to: personal() ? 'me' : st.msgTo, text: st.msgText.trim() || null });
      var trig = { type: st.trigger };
      if (st.trigger === 'schedule') { trig.weekdays = st.days.slice().sort(); trig.time = st.at; }
      if (st.trigger === 'all_away') trig.graceMinutes = st.grace;
      if (person()) trig.userId = st.userId;
      if (place()) { trig.userId = st.placeUser; trig.placeId = st.placeId; }
      if (st.trigger === SCHOOL) { trig.userId = st.schoolUser; trig.kinds = st.kinds.slice(); trig.days = st.schoolDays; }
      var b = {
        title: st.name.trim(), trigger: trig, active: st.active, actions: actions,
        conditions: {
          time: st.window ? { from: st.from, to: st.to } : null, afterSunset: st.sun,
          device: st.device.map(function (d) { return { actionId: d.actionId, field: d.field, op: d.op, value: d.value, label: d.label || null, unit: d.unit || null }; }),
          calendar: st.calendar ? { dayOffset: st.calendar.dayOffset, sources: st.calendar.sources.slice(), match: (st.calendar.match || '').trim(), memberIds: st.calendar.memberIds || null } : null,
        },
      };
      if (!rule) b.scope = st.scope;
      return b;
    }

    function submit() {
      msg.textContent = '';
      var bad = check(false);
      if (bad) { msg.textContent = bad; return; }
      save.disabled = true;
      var p = rule ? A.api('PATCH', rulesBase(opts) + '/' + rule.id, body()) : A.api('POST', rulesBase(opts), body());
      p.then(function () { close(); A.toast(T('common.saved')); opts.reload(); })
        .catch(function (e) { save.disabled = false; msg.textContent = A.errText(e); });
    }

    /** „Probelauf“: would the rule as it stands fire today? Nothing runs, nothing is saved. */
    function probe() {
      msg.textContent = '';
      var bad = check(true);
      if (bad) { msg.textContent = bad; return; }
      probeBtn.disabled = true;
      var b = body();
      if (rule) b.scope = rule.scope || 'house';
      A.api('POST', rulesBase(opts) + '/test', b).then(function (res) { st.probe = res; renderFlow(); })
        .catch(function (e) { msg.textContent = A.errText(e); })
        .then(function () { probeBtn.disabled = false; });
    }

    renderWhen();
    renderWhat();
    renderFlow();
    document.body.appendChild(ov);
    stack.push(ov);
    document.addEventListener('keydown', onKey, true);
    if (place()) showPlace();
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
        // 1.9.0: not run — a device or calendar condition (the text comes from the server)
        if (y.type === 'condition') return y.text || '–';
        if (y.type === 'messenger') return T('rule.messenger') + ' → ' + (y.ok ? T('rule.ok') : T('rule.msg_err.' + (MSG_ERRORS.indexOf(y.error) >= 0 ? y.error : 'failed')));
        var what = y.type === 'quick_action' ? quickText({ title: y.title || y.id, verb: y.verb }) : T('rule.notify');
        return what + ' → ' + (y.ok ? (y.unchanged ? T('rule.unchanged') : (y.message || T('rule.ok'))) : T('rule.err.' + (y.error || 'failed')));
      }).join(' · ');
      var title = x.ruleTitle || x.ruleName;
      var what = isPlace(x.trigger) ? T('rule.log_' + x.trigger, { name: x.userId ? nameOf(data, x.userId) : '–', place: x.placeName || '–' }) // „Marc · kommt an: Schule“
        : (x.trigger === 'schedule' ? T('rr.trig_schedule') : (x.trigger === 'button' ? T('rr.log_button')
          // 1.12.0: a school event — its text („Lena: Mathe 3. Std. (09:50) fällt aus“)
          : (x.trigger === SCHOOL ? (x.event || T('rr.trig_school_change')) : T('rule.trigger_' + x.trigger, { name: x.userId ? nameOf(data, x.userId) : '' }))));
      tb.appendChild(el('tr', null, [
        el('td', { class: 'fa-time', text: A.when(x.at) }),
        el('td', { text: (title ? title + ' · ' : '') + what }),
        el('td', { class: x.ok ? 'fa-ok' : (x.skipped ? 'fa-sub' : 'fa-bad'), text: (x.skipped ? T('rr.skipped') + ' – ' : '') + (res || '–') }),
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
      box.appendChild(el('div', { class: 'fa-pres is-' + m.state }, [A.avatar(m, 34), el('div', { class: 'fa-pres-main' }, [el('b', { text: m.name }), el('span', { class: 'fa-sub', text: sub }),
        // 1.5.0: switched on „Orte für Regeln teilen“ in the app
        m.placesShared ? el('span', { class: 'fa-pres-tag', title: T('presence.places_shared_hint') }, [A.svg(ICON.pin, 12), T('presence.places_shared')]) : null])]));
    });
    if (!members.length) box.appendChild(el('p', { class: 'fa-empty', text: T('presence.nobody') }));
  }

  // ── places (1.5.0) ────────────────────────────────────────────────────────

  /** A dialog on top of the others: { title, kicker, body: [nodes], foot: [nodes], cls } → { close, dialog }. */
  function sheet(o) {
    var opener = document.activeElement;
    var id = 'fa-pl-' + Math.random().toString(36).slice(2, 8);
    var closed = false;
    var dlg = el('div', { class: 'fa-pl' + (o.cls ? ' ' + o.cls : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id }, [
      el('div', { class: 'fa-pl-head' }, [
        el('div', { class: 'fa-rm-titles' }, [o.kicker ? el('span', { class: 'fa-rm-kicker', text: o.kicker }) : null, el('h2', { id: id, class: 'fa-pl-title', text: o.title })]),
        el('span', { class: 'fa-spacer' }),
        el('button', { type: 'button', class: 'fa-rm-icon-btn', 'aria-label': T('common.close'), on: { click: function () { close(); } } }, [A.svg(ICON.x, 18)]),
      ]),
      el('div', { class: 'fa-pl-body' }, o.body),
      el('div', { class: 'fa-pl-foot' }, o.foot),
    ]);
    var ov = el('div', { class: 'modal-overlay fa-pl-overlay' }, [dlg]);
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      if (stack.indexOf(ov) >= 0) stack.splice(stack.indexOf(ov), 1);
      ov.remove();
      if (o.onClose) o.onClose();
      if (opener && opener.focus && document.body.contains(opener)) opener.focus();
    }
    function onKey(e) {
      if (closed || stack[stack.length - 1] !== ov) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      var f = Array.prototype.filter.call(dlg.querySelectorAll('button,input,select,textarea,a[href],[tabindex]'), function (x) {
        return !x.disabled && x.getAttribute('tabindex') !== '-1' && x.offsetParent !== null;
      });
      if (!f.length) return;
      if (e.shiftKey && (document.activeElement === f[0] || !dlg.contains(document.activeElement))) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (document.activeElement === f[f.length - 1] || !dlg.contains(document.activeElement))) { e.preventDefault(); f[0].focus(); }
    }
    document.body.appendChild(ov);
    stack.push(ov);
    document.addEventListener('keydown', onKey, true);
    return { close: close, dialog: dlg };
  }

  function rulesText(n) { return n ? (n === 1 ? T('places.rules_1') : T('places.rules_n', { n: n })) : T('places.rules_0'); }

  /** Reload the places into `data` (data.places, data.home) through opts.base. */
  function reloadPlaces(data, opts) {
    return A.api('GET', opts.base + '/places').then(function (r) { data.places = r.places; data.home = r.home; return r; });
  }

  /**
   * The place cards into `box` (section „Orte“ of the admin page and the portal, the dialog
   * „Orte verwalten“): name, radius, how many rules use it, edit / delete (not while in use).
   * after(created?) runs after a change.
   */
  function places(box, data, opts, after) {
    A.clear(box);
    var list = data.places || [];
    var done = after || opts.reload;
    if (!list.length) { box.appendChild(el('p', { class: 'fa-empty', text: T('places.none') })); return; }
    var grid = el('div', { class: 'fa-places' });
    list.forEach(function (p) {
      var used = p.rules > 0;
      var btns = opts.editable ? el('div', { class: 'fa-place-btns' }, [
        el('button', { type: 'button', class: 'btn btn-sm', text: T('common.edit'), on: { click: function () { editPlace(p, data, opts, done); } } }),
        el('button', { type: 'button', class: 'fa-rm-icon-btn fa-place-del', disabled: used, title: used ? T('places.in_use_hint') : T('places.delete_aria', { name: p.name }),
          'aria-label': T('places.delete_aria', { name: p.name }), on: { click: function () {
            A.confirm(T('places.delete_confirm', { name: p.name }), T('common.delete'), true).then(function (ok) {
              if (ok) A.api('DELETE', opts.base + '/places/' + p.id).then(function () { A.toast(T('places.deleted')); done(); }).catch(A.warn);
            });
          } } }, [A.svg(ICON.trash, 16)]),
      ]) : null;
      grid.appendChild(el('div', { class: 'fa-place' + (used ? ' is-used' : '') }, [
        el('span', { class: 'fa-place-ico' }, [A.svg(ICON.pin, 20)]),
        el('div', { class: 'fa-place-main' }, [el('b', { text: p.name }),
          el('span', { class: 'fa-sub fa-place-radius', text: T('places.radius', { r: radiusText(p.radius) }) }), el('span', { class: 'fa-sub', text: rulesText(p.rules) })]),
        btns,
      ]));
    });
    box.appendChild(grid);
    if (opts.editable && list.some(function (p) { return p.rules > 0; })) box.appendChild(el('p', { class: 'fa-hint fa-places-note', text: T('places.in_use_hint') }));
  }

  /** The dialog „Orte verwalten“ (from the rule dialog): the cards and „+ Ort“; changed(created) after every change. */
  function managePlaces(data, opts, changed) {
    var box = el('div', { class: 'fa-pl-list' });
    var add = el('button', { type: 'button', class: 'btn', text: T('places.add') });
    function refresh(created) {
      return reloadPlaces(data, opts).then(function () {
        places(box, data, opts, refresh);
        add.disabled = (data.places || []).length >= MAX_PLACES;
        changed(created || null);
        if (opts.reload) opts.reload();
      }).catch(A.warn);
    }
    add.addEventListener('click', function () { editPlace(null, data, opts, refresh); });
    var s = sheet({
      title: T('places.manage_title'), kicker: T('places.title'), cls: 'fa-pl-manage',
      body: [el('p', { class: 'fa-hint', text: T('places.intro') }), box],
      foot: [add, el('span', { class: 'fa-spacer' }), el('button', { type: 'button', class: 'btn btn-primary', text: T('places.done'), on: { click: function () { s.close(); } } })],
    });
    places(box, data, opts, refresh);
    add.disabled = (data.places || []).length >= MAX_PLACES;
    setTimeout(function () { add.focus(); }, 30);
  }

  /**
   * The place editor (p null = new): name, the position on the map (tap / drag; latitude and
   * longitude below, the only way without Leaflet), the radius 50–5000 m with the circle drawn,
   * „Zuhause übernehmen“ (the settings location). done(place) after saving or deleting.
   */
  function editPlace(p, data, opts, done) {
    var home = data.home || null;
    var st = { name: p ? p.name : '', lat: p ? p.lat : null, lon: p ? p.lon : null, radius: p ? p.radius : RADIUS.def };
    var picker = null;
    var uid = 'fa-pe-' + Math.random().toString(36).slice(2, 8);
    var fmt = function (n) { return n == null ? '' : String(Math.round(n * 1e6) / 1e6); };
    var msg = el('p', { class: 'fa-msg', role: 'status', 'aria-live': 'polite' });

    var name = el('input', { class: 'form-input', id: uid + '-name', type: 'text', maxlength: '40', value: st.name, placeholder: T('places.name_ph'), autocomplete: 'off' });
    name.addEventListener('input', function () { st.name = name.value; });
    var lat = el('input', { class: 'form-input fa-rm-mono', id: uid + '-lat', type: 'number', step: 'any', min: '-90', max: '90', inputmode: 'decimal', value: fmt(st.lat) });
    var lon = el('input', { class: 'form-input fa-rm-mono', id: uid + '-lon', type: 'number', step: 'any', min: '-180', max: '180', inputmode: 'decimal', value: fmt(st.lon) });
    function typed() {
      var a = lat.value === '' ? NaN : Number(lat.value), b = lon.value === '' ? NaN : Number(lon.value);
      if (isFinite(a) && isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180) { st.lat = a; st.lon = b; if (picker) picker.set(a, b); }
    }
    lat.addEventListener('change', typed);
    lon.addEventListener('change', typed);
    function setPos(a, b) { st.lat = a; st.lon = b; lat.value = fmt(a); lon.value = fmt(b); osm.href = A.map.osmUrl({ lat: a, lon: b }); }

    var homeBtn = el('button', { type: 'button', class: 'btn fa-pe-home', disabled: !home, title: home ? null : T('places.home_none'), on: { click: function () {
      setPos(home.lat, home.lon);
      if (picker) picker.set(home.lat, home.lon);
      if (!name.value.trim()) { name.value = T('places.home_name'); st.name = name.value; }
    } } }, [A.svg(ICON.home, 16), T('places.home')]);

    var out = el('output', { class: 'fa-pe-radius-val', for: uid + '-radius', text: radiusText(st.radius) });
    var range = el('input', { type: 'range', class: 'fa-pe-range', id: uid + '-radius', min: String(RADIUS.min), max: String(RADIUS.max), step: String(RADIUS.step), value: String(st.radius) });
    range.addEventListener('input', function () { st.radius = Number(range.value); out.textContent = radiusText(st.radius); if (picker) picker.radius(st.radius); });
    range.addEventListener('change', function () { if (picker) picker.fit(); });

    // the map, else (no Leaflet) the coordinates with „Position auf Karte wählen“ (openstreetmap.org)
    var mapBox = el('div', { class: 'fa-pe-map' }, [el('div', { class: 'fa-pe-map-wait', text: '…' })]);
    var at = st.lat != null ? { lat: st.lat, lon: st.lon } : (home || A.map.GERMANY);
    var osm = A.map.osmLink(at, T('places.pick_osm'));
    var fallback = el('p', { class: 'fa-hint fa-pe-fallback', hidden: true }, [T('places.map_unavailable') + ' ', osm]);

    var foot = [
      p ? el('button', { type: 'button', class: 'btn btn-danger', text: T('common.delete'), disabled: p.rules > 0, title: p.rules > 0 ? T('places.in_use_hint') : null, on: { click: function () {
        A.confirm(T('places.delete_confirm', { name: p.name }), T('common.delete'), true).then(function (ok) {
          if (ok) A.api('DELETE', opts.base + '/places/' + p.id).then(function () { s.close(); A.toast(T('places.deleted')); done(); }).catch(function (e) { msg.textContent = A.errText(e); });
        });
      } } }) : null,
      el('span', { class: 'fa-spacer' }),
      el('button', { type: 'button', class: 'btn', text: T('common.cancel'), on: { click: function () { s.close(); } } }),
    ];
    var save = el('button', { type: 'button', class: 'btn btn-primary', text: T('places.save'), on: { click: submit } });
    foot.push(save);
    var s = sheet({
      title: p ? T('places.edit') : T('places.new'), kicker: T('places.title'), cls: 'fa-pl-edit', foot: foot,
      body: [el('div', { class: 'fa-pe' }, [
        el('div', { class: 'fa-pe-mapcol' }, [mapBox, el('p', { class: 'fa-hint', text: T('places.position_hint') }), fallback]),
        el('div', { class: 'fa-pe-side' }, [
          el('div', { class: 'form-group' }, [el('label', { class: 'form-label', for: uid + '-name', text: T('places.name') }), name]),
          el('div', { class: 'form-group' }, [
            el('div', { class: 'fa-pe-radius-head' }, [el('label', { class: 'form-label', for: uid + '-radius', text: T('places.radius_label') }), out]),
            range,
            el('div', { class: 'fa-pe-scale', 'aria-hidden': 'true' }, [el('span', { text: radiusText(RADIUS.min) }), el('span', { text: radiusText(RADIUS.max) })]),
          ]),
          homeBtn,
          el('div', { class: 'fa-rm-info' }, [A.svg(ICON.info, 18), el('span', { text: T('places.tip') })]),
          el('div', { class: 'fa-pe-coords' }, [
            el('div', { class: 'form-group' }, [el('label', { class: 'form-label', for: uid + '-lat', text: T('places.lat') }), lat]),
            el('div', { class: 'form-group' }, [el('label', { class: 'form-label', for: uid + '-lon', text: T('places.lon') }), lon]),
          ]),
          msg,
        ]),
      ])],
    });
    A.map.pick(mapBox, { lat: st.lat, lon: st.lon, radius: st.radius, center: home, onPick: setPos }).then(function (c) {
      picker = c;
      if (!c) { A.clear(mapBox); mapBox.hidden = true; fallback.hidden = false; }
    });
    setTimeout(function () { name.focus(); }, 30);

    function submit() {
      msg.textContent = '';
      var n = name.value.trim();
      if (!n) { msg.textContent = T('places.name_required'); name.focus(); return; }
      if (st.lat == null || st.lon == null) { msg.textContent = T('places.position_required'); return; }
      var body = { name: n, lat: st.lat, lon: st.lon, radius: st.radius };
      save.disabled = true;
      (p ? A.api('PATCH', opts.base + '/places/' + p.id, body) : A.api('POST', opts.base + '/places', body)).then(function (r) {
        s.close();
        A.toast(T('common.saved'));
        done(r.place);
      }).catch(function (e) { save.disabled = false; msg.textContent = A.errText(e); });
    }
  }

  A.rules = { render: render, edit: edit, log: log, people: people, places: places, editPlace: editPlace, flat: flat, TRIGGERS: TRIGGERS, MAX_PLACES: MAX_PLACES };
}());
