/* Portal tab "Familie" — 1.18.0: „Internet zu Hause“ (GateControl ≥ 1.231.0, API internet/…, server/internet.js).
   Parents only, signed in: per minor child the state (normal with the next blocked time / paused until … / longer today
   until … / not filtered), who did it and when (Familie's own log), the buttons „Pause …“ (30 Min., 1 Std., bis morgen
   7 Uhr, bis Uhrzeit …), „Pause beenden“, „Heute länger …“ (+30 / +60 Min.) and „+30 Min.“ (a running pause or extra
   time 30 minutes longer). Hidden without the API (an older GateControl), for children and without children. */
(function () {
  'use strict';
  var A = window.FA, T = A.T, $ = A.$, el = A.el, CTX = A.CTX;
  var LOCALE = CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  var writable = CTX.loggedIn === true;
  var box = $('#fa-internet');
  if (!box) return;
  var data = null;     // { available, manage, children }
  var open = null;     // { userId, kind: 'pause' | 'longer' } — the open choice panel
  var busy = false;

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
  /** ISO → "18:30" (today), "morgen 07:00", "Sa 07:00" / "08.11. 07:00" — the browser's zone, like A.when. */
  function clock(isoStr) {
    var d = new Date(isoStr);
    if (!isoStr || isNaN(d.getTime())) return '–';
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var diff = Math.round((dayStart(d) - dayStart(new Date())) / 86400000);
    if (diff === 0) return hm;
    if (diff === 1) return T('rel.tomorrow') + ' ' + hm;
    if (diff > 1 && diff < 7) return d.toLocaleDateString(LOCALE, { weekday: 'short' }) + ' ' + hm;
    return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' }) + ' ' + hm;
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  /** "Soziale Netzwerke, Spiele und Videos" / "Internet" */
  function what(s) {
    if (s.block === 'all') return T('internet.what_all');
    var c = (s.categories || []).filter(function (x) { return x === 'social' || x === 'games' || x === 'video'; }).map(function (x) { return T('internet.cat_' + x); });
    if (!c.length) return T('internet.what_all');
    return c.length === 1 ? c[0] : c.slice(0, -1).join(', ') + T('internet.and') + c[c.length - 1];
  }
  function schedText(s) {
    if (!s) return T('internet.no_schedule');
    var key = s.active ? 'internet.sched_active' : 'internet.sched_ahead';
    var out = T(key, { what: what(s), from: clock(s.from), to: clock(s.to) });
    // „Soziale Netzwerke … gesperrt bis 07:00“ / “Games … blocked from 21:00”: capital only at the start of the text
    return T(key).indexOf('{{what}}') === 0 ? cap(out) : out;
  }
  /** "von Anna um 17:52" (today) / "von Anna, gestern 17:52" */
  function byText(by) {
    if (!by || !by.name) return null;
    var d = new Date(by.at);
    if (!isNaN(d.getTime()) && dayStart(d) === dayStart(new Date())) return T('internet.by_today', { name: by.name, time: pad(d.getHours()) + ':' + pad(d.getMinutes()) });
    return T('internet.by_other', { name: by.name, when: A.when(by.at) });
  }
  function running(isoStr) { var t = isoStr ? new Date(isoStr).getTime() : NaN; return !isNaN(t) && t > Date.now(); }

  /** POST internet/<id>/<op> → re-render that child, a toast. */
  function act(c, op, body, doneKey) {
    if (busy) return Promise.resolve();
    busy = true;
    return A.api('POST', 'internet/' + encodeURIComponent(c.userId) + '/' + op, body || {}).then(function (x) {
      var n = x.child;
      data.children = data.children.map(function (k) { return k.userId === n.userId ? n : k; });
      open = null;
      var key = doneKey || (op === 'pause' ? 'internet.toast_paused' : (op === 'resume' ? 'internet.toast_resumed' : 'internet.toast_extended'));
      A.toast(T(key, { name: n.name, until: clock(op === 'pause' ? n.paused : n.extended) }));
      render();
    }).catch(function (e) { A.warn(e); throw e; }).then(function () { busy = false; }, function (e) { busy = false; throw e; });
  }
  function btn(label, onClick, o) {
    var x = o || {};
    return el('button', { type: 'button', class: 'btn' + (x.cls ? ' ' + x.cls : ''), text: label, 'aria-label': x.aria || null, 'aria-expanded': x.expanded == null ? null : (x.expanded ? 'true' : 'false'), disabled: !writable, on: { click: onClick } });
  }
  function toggle(c, kind) {
    open = open && open.userId === c.userId && open.kind === kind ? null : { userId: c.userId, kind: kind };
    render();
    if (open) { var f = $('#fa-net-panel-' + c.userId + ' button'); if (f) f.focus(); }
  }
  function untilTime(c) {
    return A.form(T('internet.until_title', { name: c.name }), [
      { key: 'time', label: T('internet.until_label'), type: 'time', value: '', hint: T('internet.until_hint') },
    ], {
      okLabel: T('internet.until_ok'),
      check: function (v) { return /^\d{2}:\d{2}$/.test(v.time) ? null : T('internet.until_required'); },
      submit: function (v) { return act(c, 'pause', { until: v.time }); },
    });
  }
  function panel(c) {
    var pause = open.kind === 'pause';
    var morning = new Date().getHours() < 7 ? 'internet.p_morning_today' : 'internet.p_morning';
    var choices = pause ? [
      btn(T('internet.p30'), function () { act(c, 'pause', { minutes: 30 }).catch(function () {}); }),
      btn(T('internet.p60'), function () { act(c, 'pause', { minutes: 60 }).catch(function () {}); }),
      btn(T(morning), function () { act(c, 'pause', { until: '07:00' }).catch(function () {}); }),
      btn(T('internet.p_until'), function () { untilTime(c); }),
    ] : [
      btn(T('internet.l30'), function () { act(c, 'extend', { minutes: 30 }).catch(function () {}); }),
      btn(T('internet.l60'), function () { act(c, 'extend', { minutes: 60 }).catch(function () {}); }),
    ];
    var title = T(pause ? 'internet.pause_for' : 'internet.longer_for', { name: c.name });
    return el('div', { class: 'fa-net-panel', id: 'fa-net-panel-' + c.userId, role: 'group', 'aria-label': title }, [
      el('span', { class: 'fa-net-panel-title', text: title }),
      el('div', { class: 'fa-net-btns' }, choices),
      el('span', { class: 'fa-sub', text: T(pause ? 'internet.pause_hint' : 'internet.longer_hint', { name: c.name }) }),
    ]);
  }
  function row(c) {
    var paused = running(c.paused);
    var longer = running(c.extended);
    var pills = [];
    var desc = [];
    var buttons = [];
    if (paused) {
      pills.push(el('span', { class: 'fa-pill fa-net-pill is-paused', text: T('internet.paused_pill', { until: clock(c.paused) }) }));
      if (c.devices) desc.push(T(c.devices === 1 ? 'internet.paused_desc_1' : 'internet.paused_desc_n', { n: c.devices }));
      desc.push(T('internet.still_allowed'));
      if (byText(c.pausedBy)) desc.push(byText(c.pausedBy));
    }
    if (longer) {
      pills.push(el('span', { class: 'fa-pill fa-net-pill is-longer', text: T('internet.extended_pill', { until: clock(c.extended) }) }));
      if (!paused) {
        desc.push(T('internet.extended_desc'));
        if (byText(c.extendedBy)) desc.push(byText(c.extendedBy));
      }
    }
    var state = paused ? 'paused' : (longer ? 'longer' : (c.error ? 'error' : (c.filtered ? 'normal' : 'off')));
    if (state === 'normal') desc.push(T('internet.normal'), schedText(c.nextSchedule));
    else if (state === 'off') desc.push(T('internet.unfiltered'));
    else if (state === 'error') desc.push(T('internet.error'));
    var isOpen = function (k) { return !!(open && open.userId === c.userId && open.kind === k); };
    if (paused) {
      buttons.push(btn(T('internet.btn_resume'), function () { act(c, 'resume').catch(function () {}); }));
      buttons.push(btn(T('internet.btn_plus30'), function () { act(c, 'pause', { add: 30 }).catch(function () {}); }, { aria: T('internet.btn_plus30_pause') }));
    } else if (longer) {
      buttons.push(btn(T('internet.btn_pause'), function () { toggle(c, 'pause'); }, { expanded: isOpen('pause') }));
      buttons.push(btn(T('internet.btn_plus30'), function () { act(c, 'extend', { minutes: 30 }).catch(function () {}); }, { aria: T('internet.btn_plus30_longer') }));
      buttons.push(btn(T('internet.btn_end_longer'), function () { act(c, 'extend', { minutes: 0 }, 'internet.toast_extend_ended').catch(function () {}); }));
    } else if (state === 'normal') {
      buttons.push(btn(T('internet.btn_pause'), function () { toggle(c, 'pause'); }, { expanded: isOpen('pause') }));
      buttons.push(btn(T('internet.btn_longer'), function () { toggle(c, 'longer'); }, { expanded: isOpen('longer') }));
    }
    var name = el('strong', { class: 'fa-net-name' }, [el('span', { text: c.name })].concat(pills));
    var kid = el('div', { class: 'fa-net-kid is-' + state }, [
      A.avatar(c, 40),
      el('span', { class: 'fa-net-main' }, [name, el('span', { class: 'fa-sub', text: desc.join(' · ') })]),
      buttons.length ? el('div', { class: 'fa-net-btns' }, buttons) : null,
    ]);
    var out = el('div', { class: 'fa-net-item' }, [kid]);
    if (open && open.userId === c.userId && (state === 'normal' || (state === 'longer' && open.kind === 'pause'))) out.appendChild(panel(c));
    return out;
  }
  function render() {
    var list = A.clear($('#fa-net-list'));
    data.children.forEach(function (c) { list.appendChild(row(c)); });
  }
  function load() {
    if (busy) return Promise.resolve();
    return A.api('GET', 'internet').then(function (x) {
      data = x.internet;
      // parents, signed in, with GateControl ≥ 1.231.0 and at least one child
      box.hidden = !(data && data.available && data.manage && writable && data.children.length);
      if (!box.hidden) render();
    }).catch(function () { box.hidden = true; });
  }
  if (!writable) return;
  load();
  setInterval(function () { if (!box.hidden && !document.querySelector('.modal-overlay:not([hidden])')) load(); }, 60000);
}());
