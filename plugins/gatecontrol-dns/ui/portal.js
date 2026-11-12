/* The portal tab "DNS-Schutz": the state of the protection for the viewer's own devices, suspending it and switching
   it back on, for administrators and parents also for the people they decide for, and the own query log (when the
   administrator shows it to users). The server decides what is allowed (`may`), this page only draws it. */
(function () {
  'use strict';
  var D = window.DN;
  var T = D.T, $ = D.$, el = D.el, icon = D.icon, btn = D.btn, tag = D.tag;
  var st = null;
  var people = null;
  var log = null;
  var logBlocked = false;

  function busy(b, p) { b.disabled = true; return p.catch(D.warn).then(function (r) { b.disabled = false; return r; }); }
  function change(b, path, body) {
    return busy(b, D.api('POST', path, body).then(function (r) { if (r.status) st = r.status; return st.manage ? loadPeople() : null; }).then(render));
  }
  function loadPeople() { return D.api('GET', 'people').then(function (r) { people = r; }).catch(function () { people = null; }); }
  function untilText(p) { return p.openEnd ? T('po.open_end') : T('po.until', { time: D.clock(p.until) }); }
  function durationButtons(may, target, cls) {
    var out = may.durations.map(function (m) { return btn(D.duration(m), cls || '', function (ev) { change(ev.currentTarget, 'pause', Object.assign({ minutes: m }, target)); }, 'clock'); });
    if (may.forever) out.push(btn(T('po.forever'), cls || '', function (ev) { change(ev.currentTarget, 'pause', Object.assign({ forever: true }, target)); }));
    return out;
  }

  function renderMe() {
    var c = D.clear($('#dn-me'));
    c.hidden = false;
    var s = st.state;
    var title = { active: T('po.active'), paused: T('po.paused'), fallback: T('po.fallback'), off: T('po.off'), starting: T('po.starting'), unfiltered: T('po.unfiltered') }[s];
    var sub;
    if (s === 'active') sub = T('po.active_sub');
    else if (s === 'paused' && st.pause) sub = st.pause.openEnd ? T('po.paused_open') : T('po.paused_sub', { time: D.clock(st.pause.until) });
    else if (s === 'fallback') sub = T('po.fallback_sub', { time: st.outage ? D.clock(st.outage.since) : '–' });
    else if (s === 'unfiltered') sub = T(st.devices.length ? 'po.unfiltered_sub' : 'po.no_device_sub');
    else sub = T('po.off_sub');
    var head = el('div', { class: 'dn-state', 'data-st': s === 'starting' ? 'off' : s }, [el('span', { class: 'ring' }, [icon(s === 'paused' ? 'pause' : (s === 'fallback' ? 'warn' : 'shield'), 's22')]),
      el('div', {}, [el('b', { text: title }), s === 'paused' && st.pause && !st.pause.openEnd
        ? el('span', {}, [el('strong', { class: 'num cd', 'data-until': st.pause.until, text: D.countdown(st.pause.until) }), ' · ' + sub])
        : el('span', { text: sub })])]);
    c.appendChild(head);
    if (st.profile) c.appendChild(el('div', { class: 's-hint', text: T('po.profile', { name: st.profile.name }) + (st.profile.safeSearch ? ' · ' + T('pf.safe') : '') }));
    var k = st.counters;
    var kpi = function (lab, val, sub2) { return el('div', { class: 'kpi' }, [el('div', { class: 'lab', text: lab }), el('div', { class: 'val', text: val }), el('small', { text: sub2 })]); };
    c.appendChild(el('div', { class: 'kpis' }, [kpi(T('po.queries'), D.num(k.queries), T('po.scope_' + k.scope)), kpi(T('po.blocked'), D.num(k.blocked), D.pct(k.blocked, k.queries))]));
    var m = st.may;
    if (s === 'fallback') c.appendChild(el('p', { class: 's-hint', text: T('po.fallback_text') }));
    else if (m.pause) {
      c.appendChild(el('div', { class: 'fg' }, [el('span', { class: 'lbl', text: T('po.pause_title') }), el('div', { class: 'btns', role: 'group', 'aria-label': T('po.pause_title') }, durationButtons(m, {}))]));
      c.appendChild(el('p', { class: 's-hint', text: T(st.device ? 'po.pause_hint_device' : 'po.pause_hint') + (m.forever ? '' : ' ' + T('po.no_forever')) }));
    } else if (s === 'paused') {
      var p = st.pause;
      c.appendChild(el('div', { class: 'btns' }, [
        m.resume ? btn(T('po.resume'), 'btn-primary', function (ev) { change(ev.currentTarget, 'resume', {}); }, 'shield') : null,
        m.extend && p && !p.openEnd && p.scope !== 'all' ? btn(T('ov.plus30'), '', function (ev) { change(ev.currentTarget, 'pause', { extend: 30 }); }) : null,
      ]));
      if (p) c.appendChild(el('p', { class: 's-hint', text: (p.byMe ? T('po.by_me', { time: D.clock(p.since) }) : T('po.by_other', { name: p.by ? p.by.name : '–', time: D.clock(p.since) })) + ' ' + T(p.scope === 'all' ? 'po.paused_all' : 'po.paused_hint') }));
    } else if (m.reason && s !== 'off' && s !== 'starting') {
      c.appendChild(D.banner('', 'lock', T('po.not_allowed'), D.TO('reason.' + m.reason, T('po.not_allowed_text'))));
    }
    if (st.today && st.today.length) {
      c.appendChild(el('div', { class: 'fg' }, [el('span', { class: 'lbl', text: T('po.times_today') })].concat(st.today.map(function (x) {
        return el('div', { class: 's-hint', text: (x.from === '00:00' && x.to === '24:00' ? T('pf.all_day') : x.from + '–' + x.to) + ' · ' + T('pf.blocked') + ' ' + (x.block === 'all' ? T('pf.block_all') : x.categories.map(D.categoryName).join(', ')) });
      }))));
    }
    if (st.top && st.top.length) {
      var max = st.top[0].count;
      c.appendChild(el('div', { class: 'fg' }, [el('span', { class: 'lbl', text: T('ov.top_title') }), el('ul', { class: 'toplist' }, st.top.map(function (x) {
        return el('li', {}, [el('div', { style: 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:7px 0' }, [el('span', { class: 'd', text: x.domain }), el('span', { class: 'c', text: D.num(x.count) }), el('span', { class: 'b' }, [el('i', { style: 'width:' + Math.max(3, Math.round((x.count / max) * 100)) + '%' })])])]);
      }))]));
    }
  }

  function deviceTag(d) {
    if (d.state === 'ownDns') return tag(T('dv.s_owndns'), 'warn');
    if (d.state === 'disabled') return tag(T('dv.s_disabled'), 'grey');
    if (d.state !== 'filtered') return tag(T('dv.s_excluded'), 'grey');
    if (st.state === 'fallback') return tag(T('dv.s_unfiltered'), 'crit');
    if (d.suspended) return tag(d.pause && d.pause.until ? T('dv.s_paused_until', { time: D.clock(d.pause.until) }) : T('dv.s_paused'), 'warn');
    return tag(T('dv.s_filtered'), 'good');
  }
  function renderDevices() {
    var c = D.clear($('#dn-devices'));
    c.hidden = !st.devices.length;
    if (!st.devices.length) return;
    c.appendChild(el('h2', { class: 'card-title' }, [el('span', { class: 'ic' }, [icon('phone', 's16')]), T('po.my_devices')]));
    c.appendChild(el('div', { class: 'rows' }, st.devices.map(function (d) {
      var on = d.state === 'filtered';
      var sub = [on && d.profile ? T('po.profile', { name: d.profile.name }) : null, on && d.today ? T('po.dev_counts', { queries: D.num(d.today.queries), blocked: D.num(d.today.blocked) }) : null, d.state === 'ownDns' ? T('dv.owndns', { dns: d.ownDns }) : null].filter(Boolean).join(' · ');
      return el('div', { class: 'rw' }, [el('div', { class: 't' }, [el('b', { text: d.name }), sub ? el('small', { text: sub }) : null]), deviceTag(d)]);
    })));
  }

  function renderPeople() {
    var c = D.clear($('#dn-people'));
    var list = people ? people.people.filter(function (p) { return !p.self; }) : [];
    c.hidden = !list.length;
    if (!list.length) return;
    c.appendChild(el('h2', { class: 'card-title' }, [el('span', { class: 'ic' }, [icon('users', 's16')]), T('po.others')]));
    c.appendChild(el('p', { class: 's-hint', text: T('po.others_hint') }));
    c.appendChild(el('div', { class: 'rows' }, list.map(function (p) {
      var paused = p.devices.filter(function (d) { return d.suspended; });
      var first = paused[0] && paused[0].pause;
      var sub = p.devices.map(function (d) { return d.name; }).join(', ') + (first ? ' · ' + T('po.paused') + ' ' + untilText(first) : '');
      var buttons = [];
      if (p.may.pause) buttons = durationButtons({ durations: p.may.durations.filter(function (m) { return m <= 60; }), forever: false }, { userId: p.userId }, 'btn-sm');
      else if (p.may.resume) buttons = [btn(T('po.resume'), 'btn-primary btn-sm', function (ev) { change(ev.currentTarget, 'resume', { userId: p.userId }); })];
      else if (p.may.reason) buttons = [el('span', { class: 's-hint', text: D.TO('reason.' + p.may.reason, '') })];
      return el('div', { class: 'rw' }, [el('div', { class: 't' }, [el('b', { text: p.name }), el('small', { text: sub })]), el('div', { class: 'btns', role: 'group', 'aria-label': T('po.pause_for', { name: p.name }) }, buttons)]);
    })));
  }

  var RESULT_TONE = { blocked: 'crit', allowed: 'good', allowed_paused: 'warn', safe_search: 'blue' };
  function loadLog(more) {
    var q = ['limit=50'];
    if (logBlocked) q.push('blockedOnly=1');
    if (more && log && log.next) q.push('before=' + log.next);
    return D.api('GET', 'log?' + q.join('&')).then(function (r) { log = { entries: more && log ? log.entries.concat(r.entries) : r.entries, next: r.next }; renderLog(); }).catch(function () { log = null; });
  }
  function renderLog() {
    var c = D.clear($('#dn-log'));
    c.hidden = !st.log.visible;
    if (!st.log.visible) return;
    var only = el('input', { type: 'checkbox', checked: logBlocked, on: { change: function () { logBlocked = only.checked; loadLog(); } } });
    c.appendChild(el('h2', { class: 'card-title' }, [el('span', { class: 'ic' }, [icon('list', 's16')]), T('po.log_title'), el('label', { class: 'chk sp' }, [only, el('span', { text: T('lg.only_blocked') })])]));
    c.appendChild(el('p', { class: 's-hint', text: T('po.log_hint') }));
    var rows = log ? log.entries : [];
    var body = el('tbody', {}, rows.length ? rows.map(function (e) {
      return el('tr', {}, [el('td', { class: 'mono nw', text: D.clock(e.at, true), title: D.when(e.at) }), el('td', { text: e.device || '–' }), el('td', { class: 'mono', text: e.domain }),
        el('td', {}, [tag(T('lg.r_' + e.result), RESULT_TONE[e.result] || 'grey', e.result === 'safe_search')]), el('td', { text: D.reasonText(e, null) })]);
    }) : [el('tr', {}, [el('td', { class: 'empty', colspan: '5', text: T(log ? 'lg.none' : 'common.loading') })])]);
    c.appendChild(el('div', { class: 'tw', tabindex: '0', role: 'region', 'aria-label': T('lg.table') }, [el('table', { class: 'tb', style: 'min-width:560px' }, [
      el('thead', {}, [el('tr', {}, [T('lg.h_time'), T('dv.h_device'), T('lg.h_domain'), T('lg.h_result'), T('lg.h_reason')].map(function (h) { return el('th', { text: h }); }))]), body])]));
    if (log && log.next) c.appendChild(el('div', {}, [btn(T('lg.more'), '', function (ev) { busy(ev.currentTarget, loadLog(true)); })]));
  }

  function render() {
    if (!st) return;
    $('#dn-loading').hidden = true;
    renderMe();
    renderDevices();
    renderPeople();
    renderLog();
  }
  function load() {
    return D.api('GET', 'status').then(function (r) {
      st = r;
      return Promise.all([st.manage ? loadPeople() : null, st.log.visible && !log ? loadLog() : null]);
    }).then(render);
  }
  setInterval(function () {
    var nodes = document.querySelectorAll('.cd[data-until]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = D.countdown(nodes[i].getAttribute('data-until'));
    // a suspension that ran out: ask again
    if (st && st.pause && st.pause.until && Date.parse(st.pause.until) < Date.now() - 1500) { st.pause = null; load().catch(function () {}); }
  }, 1000);
  setInterval(function () { if (!document.hidden) load().catch(function () {}); }, 30000);
  load().catch(function (e) {
    var l = $('#dn-loading');
    l.textContent = D.errText(e);
    l.className = 'banner crit';
  });
})();
