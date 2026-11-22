/* Heizung (1.14.0): what the page "Heizung" and the portal share — the room page (actual / target, Betrieb, presets,
   boost, today's plan, devices), the room cards of the overview, the day bars. Data from GET heating (page) or
   GET portal/heating (portal), changes with POST …/rooms/<id> { action, … }. Markup only from constants; data only as
   text. */
(function () {
  'use strict';
  var S = window.SH, T = S.T, el = S.el;
  var LOC = S.CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  var PRESETS = ['comfort', 'eco', 'night', 'frost'];
  var PATHS = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z"/><path d="M2 21c0-3 1.9-5.4 5.1-6"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    snow: '<path d="M12 2v20M4.9 7l14.2 10M4.9 17L19.1 7M9 4l3 2 3-2M9 20l3-2 3 2"/>',
    flame: '<path d="M12 22c4 0 7-2.7 7-7 0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-3 3-5 5.5-5 8 0 4.3 3 7 7 7z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    alert: '<path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="10"/>',
    window: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M12 3v18M4 12h16"/>',
    thermo: '<path d="M10 13V5a2 2 0 1 1 4 0v8a4 4 0 1 1-4 0z"/><path d="M12 9v6"/>',
    away: '<path d="M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/><path d="M16 3l5 5"/>',
  };
  var PRESET_ICON = { comfort: 'sun', eco: 'leaf', night: 'moon', frost: 'snow' };
  /** A 24×24 stroke icon from the constants above (never from data). */
  function icon(name, size) {
    var holder = el('span');
    holder.innerHTML = '<svg viewBox="0 0 24 24" width="' + (size || 16) + '" height="' + (size || 16) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (PATHS[name] || '') + '</svg>';
    return holder.firstChild;
  }
  function n1(v) { var n = Number(v); return isFinite(n) ? n.toLocaleString(LOC, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '–'; }
  function deg(v) { return v == null ? '–' : n1(v) + ' °C'; }
  function hm(min) { var m = Math.round(min); if (m >= 1440) return '24:00'; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
  function clock(ms) { var d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function day(ms) { return new Date(ms).toLocaleDateString(LOC, { day: '2-digit', month: '2-digit' }); }
  function when(ms, now) { var a = new Date(ms), b = new Date(now); return a.toDateString() === b.toDateString() ? clock(ms) : day(ms) + ' ' + clock(ms); }
  function pname(p) { return T('heat.preset.' + p); }
  function pshort(p) { return T('heat.preset_short.' + p); }
  function then(x) { if (!x) return '–'; return x.preset ? pname(x.preset) + ' ' + deg(x.setpoint) : deg(x.setpoint); }

  /** The colour class of what applies in a room. */
  function toneOf(v) {
    var s = v.status;
    if (s.kind === 'boost') return 'pc-boost';
    if (s.kind === 'override' && !s.preset) return 'pc-manual';
    if (s.kind === 'manual' || s.kind === 'hold') return 'pc-manual';
    if (s.kind === 'window') return 'pc-frost';
    return s.preset ? 'pc-' + s.preset : '';
  }

  /** A day bar: sections [{ from, to (minutes), preset }]; opts { now (minutes), thin, interactive, label, onPick(i, btn) }. */
  function bar(sections, opts) {
    opts = opts || {};
    var b = el('div', { class: 'ht-bar' + (opts.thin ? ' thin' : '') + (!sections || !sections.length ? ' is-none' : ''), role: opts.interactive ? 'group' : 'img', 'aria-label': opts.label || null });
    (sections || []).forEach(function (s, i) {
      var preset = s.preset || 'manual';
      var sg = el(opts.interactive ? 'button' : 'div', { class: 'ht-sg pc-' + preset, style: 'left:' + (s.from / 1440 * 100) + '%;width:' + ((s.to - s.from) / 1440 * 100) + '%' });
      if (opts.interactive) {
        sg.type = 'button';
        sg.setAttribute('aria-label', (opts.dayName || '') + ' ' + hm(s.from) + '–' + hm(s.to) + ' ' + pname(preset));
        sg.addEventListener('click', function () { if (opts.onPick) opts.onPick(i, sg); });
      }
      if (!opts.thin && s.to - s.from >= 150) sg.appendChild(el('span', { text: s.preset ? pshort(s.preset) : T('heat.ui.by_hand') }));
      b.appendChild(sg);
    });
    if (opts.now != null) b.appendChild(el('i', { class: 'ht-now', style: 'left:calc(' + (opts.now / 1440 * 100) + '% - 1px)' }));
    return b;
  }
  function ticks() {
    var t = el('div', { class: 'ht-ticks', 'aria-hidden': 'true' });
    [0, 6, 12, 18, 24].forEach(function (h) { t.appendChild(el('span', { style: 'left:' + (h / 24 * 100) + '%', text: String(h) })); });
    return t;
  }
  function legend() {
    var l = el('div', { class: 'ht-legend' });
    PRESETS.forEach(function (p) { l.appendChild(el('span', null, [el('i', { class: 'ht-dot pc-' + p }), el('b', { text: pshort(p) })])); });
    return l;
  }

  /** The pill of a room: what applies now. */
  function pillOf(v, now) {
    var s = v.status;
    if (v.reachable === 'none') return { cls: 'is-warn', text: T('heat.ui.unreachable') };
    switch (s.kind) {
      case 'off': return { cls: '', text: T('heat.st.off') };
      case 'window': return { cls: 'is-warn', text: T('heat.ui.pill_window') };
      case 'boost': return { cls: 'is-crit', text: T('heat.ui.pill_boost', { min: Math.max(1, Math.ceil((s.until - now) / 60000)) }) };
      case 'override': return s.preset ? { cls: 'is-preset pc-' + s.preset, text: pname(s.preset) + ' ' + deg(s.setpoint) } : { cls: 'is-manual', text: T('heat.ui.pill_manual', { sp: deg(s.setpoint) }) };
      case 'manual': return { cls: 'is-manual', text: T('heat.ui.pill_manual', { sp: deg(s.setpoint) }) };
      case 'hold': return { cls: 'is-manual', text: T('heat.ui.pill_hold', { sp: deg(s.setpoint) }) };
      case 'vacation': return { cls: 'is-info', text: T('heat.ui.pill_vacation', { p: pname(s.preset) }) };
      case 'plan': return { cls: 'is-preset pc-' + s.preset, text: pname(s.preset) + ' ' + deg(s.setpoint) };
      default: return { cls: '', text: T('heat.st.none') };
    }
  }
  /** The line beside the pill: until when, what comes after. */
  function capOf(v, now) {
    var s = v.status;
    if (v.reachable === 'none') return v.last_seen ? T('heat.ui.cap_last', { ago: S.since(v.last_seen) }) : '';
    if (s.kind === 'window') return T('heat.ui.cap_window', { min: v.window.since ? Math.max(0, Math.round((now - v.window.since) / 60000)) : 0, then: then(v.after) });
    if (s.kind === 'boost') return T('heat.ui.cap_after', { then: then(v.after) });
    if (v.next) return T('heat.st.then', { at: when(v.next.at, now), what: then(v.next) });
    if (s.kind === 'hold' || s.kind === 'none') return T('heat.ui.cap_no_plan');
    return '';
  }

  function subOf(v) {
    var n = v.thermostats.length;
    return (n === 1 ? T('heat.ui.one_thermostat') : T('heat.ui.n_thermostats', { n: n })) + ' · ' + (v.plan ? v.plan.name : T('heat.ui.no_plan'));
  }

  /** A room as a card of the overview. */
  function roomCard(v, now, onOpen) {
    var warn = v.reachable === 'none' || v.status.kind === 'window' || v.reachable === 'some';
    var p = pillOf(v, now);
    var c = el('div', { class: 'sh-card ht-room' + (warn ? ' is-warn' : '') });
    c.appendChild(el('div', { class: 'ht-room-name' }, [el('span', { text: v.name }), el('small', { text: subOf(v) })]));
    var mid = el('div', { class: 'ht-room-mid' }, [el('div', { class: 'cap' }, [el('b', { text: deg(v.actual) }), el('span', { class: 'sh-pill ' + p.cls, text: p.text }), el('span', { text: capOf(v, now) })])]);
    mid.appendChild(bar(v.plan || v.today.some(function (s) { return s.preset; }) ? v.today.filter(function (s) { return s.preset; }) : [], { thin: true, now: v.now_min, label: T('heat.ui.today_of', { name: v.name }) }));
    c.appendChild(mid);
    c.appendChild(el('div', { class: 'ht-room-r' }, [el('button', { type: 'button', class: 'btn btn-sm', text: T('heat.ui.open'), 'aria-label': T('heat.ui.open_room', { name: v.name }), on: { click: function () { onOpen(v.id); } } })]));
    return c;
  }

  /**
   * The room page. ctx: { host (element), view, now, admin, base ('heating' | 'portal/heating'), back(), reload(),
   * openPlan(id)? } — every change answers with the room's new view, which is drawn again.
   */
  function roomPage(ctx) {
    var v = ctx.view;
    var host = S.clear(ctx.host);
    var now = ctx.now;
    var busy = false;
    function send(body) {
      if (ctx.readOnly) { S.toast(T('portal.login_hint'), 'error'); return Promise.resolve(null); }
      if (busy) return Promise.resolve(null);
      busy = true;
      return S.api('POST', ctx.base + '/rooms/' + Number(v.id), body).then(function (r) {
        busy = false;
        if (r && r.room) { ctx.view = r.room; ctx.view.status_text = r.room.status_text; roomPage(ctx); }
        return r;
      }, function (e) { busy = false; S.toast((e && e.message) || T('portal.error'), 'error'); return null; });
    }
    var s = v.status;
    var off = s.kind === 'off';
    var gone = v.reachable === 'none';
    host.appendChild(el('div', { class: 'ht-crumb' }, [
      el('button', { type: 'button', class: 'btn btn-sm', text: '‹ ' + T('heat.title'), on: { click: ctx.back } }),
      el('span', { text: v.name }), el('span', { class: 'sh-spacer' }), el('span', { class: 'sh-pill is-warn', text: T('heat.ui.runs_on_server') }),
    ]));
    var grid = el('div', { class: 'ht-detail' });
    host.appendChild(grid);
    // left: actual / target, Betrieb, by hand, presets, boost
    var left = el('div', { class: 'sh-card ' + toneOf(v) });
    grid.appendChild(left);
    var target = v.setpoint;
    var tgt = el('b', null, [s.kind === 'boost' ? T('heat.choice.boost') : (target == null ? '–' : n1(target)), s.kind === 'boost' || target == null ? null : el('sup', { text: '°C' })]);
    var shown = target;
    var timer = null;
    function nudge(dir) {
      var lim = v.limits;
      var cur = shown != null ? shown : (v.device_setpoint != null ? v.device_setpoint : lim.min);
      var next = Math.max(lim.min, Math.min(lim.max, Math.round((cur + dir * 0.5) * 2) / 2));
      if (next === cur) { if (lim.capped && dir > 0) S.toast(T('error.heat_limit'), 'error'); return; }
      shown = next;
      S.clear(tgt).appendChild(document.createTextNode(n1(next)));
      tgt.appendChild(el('sup', { text: '°C' }));
      clearTimeout(timer);
      timer = setTimeout(function () { send({ action: 'setpoint', setpoint: shown }); }, 700);
    }
    var ctl = el('div', { class: 'ctl' }, [
      el('button', { type: 'button', class: 'btn', text: '−', 'aria-label': T('thermo.colder'), disabled: off || gone || s.kind === 'window', on: { click: function () { nudge(-1); } } }),
      el('button', { type: 'button', class: 'btn', text: '+', 'aria-label': T('thermo.warmer'), disabled: off || gone || s.kind === 'window', on: { click: function () { nudge(1); } } }),
    ]);
    left.appendChild(el('div', { class: 'ht-big' }, [
      el('div', { class: 'm' }, [el('small', { text: v.actual_count > 1 ? T('heat.ui.actual_mean', { n: v.actual_count }) : T('heat.actual') }), el('b', null, [v.actual == null ? '–' : n1(v.actual), v.actual == null ? null : el('sup', { text: '°C' })])]),
      el('div', { class: 'm target' }, [el('small', { text: T('heat.target') }), tgt]), ctl,
    ]));
    if (v.limits.capped) left.appendChild(el('p', { class: 'form-hint', text: T('heat.ui.capped', { max: deg(v.limits.max) }) }));
    // Betrieb (administrators)
    var seg = el('div', { class: 'seg', role: 'group', 'aria-label': T('heat.ui.mode'), style: 'margin-left:0' });
    ['plan', 'manual', 'off'].forEach(function (m) {
      seg.appendChild(el('button', { type: 'button', 'aria-pressed': v.mode === m ? 'true' : 'false', text: T('heat.ui.mode_' + m), disabled: !ctx.admin, on: { click: function () { if (v.mode !== m) send({ action: 'mode', mode: m }); } } }));
    });
    left.appendChild(el('div', { class: 'row', style: 'margin-bottom:14px' }, [el('span', { class: 'form-label', text: T('heat.ui.mode') }), seg, ctx.admin ? null : el('span', { class: 'form-hint', text: T('heat.ui.mode_admin') })]));
    // what applies instead of the plan
    var ov = null;
    if (s.kind === 'override') ov = [s.preset ? T('heat.ui.ov_preset', { p: pname(s.preset), sp: deg(s.setpoint) }) : T('heat.ui.ov_manual', { sp: deg(s.setpoint) }), v.next ? T('heat.ui.ov_until', { at: when(v.next.at, now), what: then(v.next) }) : ''];
    else if (s.kind === 'manual') ov = [T('heat.ui.ov_permanent', { sp: deg(s.setpoint) }), ''];
    else if (s.kind === 'boost') ov = [T('heat.ui.ov_boost', { min: Math.max(1, Math.ceil((s.until - now) / 60000)) }), T('heat.ui.ov_after', { what: then(v.after) })];
    else if (s.kind === 'window') ov = [T('heat.ui.ov_window'), T('heat.ui.ov_after', { what: then(v.after) })];
    else if (s.kind === 'vacation') ov = [T('heat.ui.ov_vacation', { p: pname(s.preset), sp: deg(s.setpoint) }), v.next ? T('heat.ui.ov_vacation_end', { at: when(v.next.at, now) }) : ''];
    else if (s.kind === 'off') ov = [T('heat.ui.ov_off'), ''];
    if (ov) {
      var back = null;
      if (s.kind === 'override' || s.kind === 'boost' || ((s.kind === 'manual' || s.kind === 'off') && ctx.admin)) {
        back = el('button', { type: 'button', class: 'btn btn-sm', text: s.kind === 'boost' ? T('heat.boost_stop') : T('heat.resume'), on: { click: function () { send({ action: s.kind === 'boost' ? 'boost_stop' : 'resume' }); } } });
      }
      left.appendChild(el('div', { class: 'ht-override ' + toneOf(v), role: 'status' }, [icon(s.kind === 'boost' ? 'flame' : (s.kind === 'window' ? 'window' : 'clock')), el('span', null, [el('b', { text: ov[0] }), ov[1] ? ' ' + ov[1] : null]), el('span', { class: 'sh-spacer' }), back]));
    }
    if (v.pending && s.kind !== 'none') left.appendChild(el('p', { class: 'form-hint', role: 'status', text: T('heat.ui.pending', { n: v.pending }) }));
    // presets
    left.appendChild(el('div', { class: 'form-label', style: 'margin-bottom:6px', text: T('heat.preset') }));
    var ps = el('div', { class: 'ht-presets', role: 'group', 'aria-label': T('heat.ui.pick_preset') });
    PRESETS.forEach(function (p) {
      var on = s.preset === p && s.kind !== 'window';
      var b = el('button', { type: 'button', class: 'ht-preset pc-' + p, 'aria-pressed': on ? 'true' : 'false', disabled: off || gone || s.kind === 'window' },
        [el('span', { class: 'h' }, [icon(PRESET_ICON[p]), pname(p)]), el('b', { text: deg(v.presets[p]) })]);
      b.addEventListener('click', function () { send({ action: 'preset', preset: p }); });
      ps.appendChild(b);
    });
    left.appendChild(ps);
    // boost
    var dur = el('select', { class: 'form-select', 'aria-label': T('heat.ui.boost_for') });
    [15, 30, 60].forEach(function (m) { var o = el('option', { value: String(m), text: T('heat.ui.minutes', { n: m }) }); if (m === 30) o.selected = true; dur.appendChild(o); });
    var boosting = s.kind === 'boost';
    var bbtn = el('button', { type: 'button', class: 'btn btn-sm', text: boosting ? T('heat.boost_stop') : T('heat.ui.boost_start'), disabled: off || gone || s.kind === 'window' || (!boosting && !v.boost_allowed) });
    bbtn.addEventListener('click', function () { send(boosting ? { action: 'boost_stop' } : { action: 'boost', minutes: Number(dur.value) }); });
    var own = v.thermostats.some(function (x) { return x.device_boost; });
    left.appendChild(el('div', { class: 'ht-boost' }, [el('span', { class: 't' }, [icon('flame', 18), T('heat.choice.boost')]),
      el('span', { class: 'form-hint', text: !v.boost_allowed ? T('heat.ui.boost_capped') : (own ? T('heat.ui.boost_own') : T('heat.ui.boost_hint')) }), el('span', { class: 'sh-spacer' }), boosting ? null : dur, bbtn]));
    left.appendChild(el('div', { class: 'form-hint', text: T('heat.ui.preset_hint') }));
    // right: today, devices, where it runs
    var right = el('div', { class: 'ht-stack' });
    grid.appendChild(right);
    var today = el('div', { class: 'sh-card' });
    today.appendChild(el('div', { class: 'panel-title', text: v.plan ? T('heat.ui.today_plan', { name: v.plan.name }) : T('heat.ui.today') }));
    today.appendChild(el('div', { class: 'panel-sub', text: v.plan ? (ctx.admin && ctx.planRooms ? T('heat.ui.plan_for', { rooms: ctx.planRooms(v.plan.id) }) : T('heat.ui.plan_edit_hint')) : T('heat.ui.no_plan_hint') }));
    var secs = v.today.filter(function (x) { return x.preset; });
    today.appendChild(bar(secs, { now: v.now_min, label: T('heat.ui.today_of', { name: v.name }) }));
    today.appendChild(ticks());
    var next = el('ul', { class: 'ht-next' });
    v.today.filter(function (x) { return x.from > v.now_min && x.preset; }).slice(0, 6).forEach(function (x) {
      next.appendChild(el('li', null, [el('span', { class: 'tm', text: hm(x.from) }), el('span', { class: 'ht-dot pc-' + x.preset }), pname(x.preset), el('span', { class: 'v', text: deg(x.setpoint) })]));
    });
    if (next.children.length) today.appendChild(next);
    if (ctx.admin) {
      var acts = el('div', { class: 'row', style: 'margin-top:10px' });
      if (ctx.openPlan) acts.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: v.plan ? T('heat.ui.open_plan') : T('heat.ui.new_plan'), on: { click: function () { ctx.openPlan(v.plan ? v.plan.id : null, v.id); } } }));
      if (v.plan) acts.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('heat.ui.skip_today'), disabled: off, on: { click: function () { send({ action: 'skip_today' }); } } }));
      if (ctx.roomSettings) acts.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('heat.ui.room_settings'), on: { click: function () { ctx.roomSettings(v); } } }));
      today.appendChild(acts);
    }
    right.appendChild(today);
    var devs = el('div', { class: 'sh-card' }, [el('div', { class: 'panel-title', text: T('heat.ui.devices') })]);
    var list = el('div', { class: 'ht-devs' });
    v.thermostats.forEach(function (x) {
      var vals = el('div', { class: 'vals' });
      if (!x.reachable) vals.appendChild(el('span', { class: 'sh-pill is-warn', text: T('heat.ui.unreachable') }));
      else {
        vals.appendChild(el('span', { text: deg(x.value) }));
        if (x.setpoint != null) vals.appendChild(el('span', { text: T('heat.target') + ' ' + deg(x.setpoint) }));
        if (x.valve != null) vals.appendChild(el('span', { text: T('heat.valve') + ' ' + x.valve + ' %' }));
      }
      var chip = S.batteryChip({ battery: x.battery, lowbattery: x.lowbattery }, x.battery_level);
      if (chip) vals.appendChild(chip);
      var sub = [x.source === 'deconz' ? 'deCONZ' : 'zigbee2mqtt'];
      if (x.gateway) sub.push(x.gateway);
      if (x.own_schedule) sub.push(T('heat.ui.own_schedule'));
      list.appendChild(el('div', { class: 'ht-devrow' }, [el('div', { class: 'grow' }, [el('b', { text: x.name }), el('small', { text: sub.join(' · ') })]), vals]));
    });
    v.window.contacts.forEach(function (c) {
      var sub = v.window.on ? T('heat.ui.contact_rule', { min: v.window.minutes }) : T('heat.ui.contact_off');
      list.appendChild(el('div', { class: 'ht-devrow' }, [el('div', { class: 'grow' }, [el('b', { text: c.name }), el('small', { text: sub })]),
        el('span', { class: 'sh-pill ' + (!c.reachable ? 'is-warn' : (c.open ? 'is-warn' : 'is-good')), text: !c.reachable ? T('heat.ui.unreachable') : T(c.open ? 'heat.window_open' : 'heat.window_closed') })]));
    });
    devs.appendChild(list);
    right.appendChild(devs);
    var where = el('div', { class: 'where is-server' }, [icon('alert', 18), el('div', null, [el('b', { text: T('heat.ui.server_title') }), ' ' + T('heat.ui.server_text')])]);
    right.appendChild(where);
  }

  window.SHH = { PRESETS: PRESETS, icon: icon, n1: n1, deg: deg, hm: hm, clock: clock, day: day, when: when, pname: pname, pshort: pshort, bar: bar, ticks: ticks, legend: legend,
    roomCard: roomCard, roomPage: roomPage, pillOf: pillOf, capOf: capOf, toneOf: toneOf, PRESET_ICON: PRESET_ICON };
}());
