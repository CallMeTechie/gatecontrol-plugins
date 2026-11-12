/* The settings page "DNS-Schutz": the tabs Übersicht, Listen & Ausnahmen, Profile, Geräte, Protokoll, Einstellungen
   and the set-up dialog (also the move from Pi-hole). Everything comes from admin/all, what changes by itself from
   admin/live every 10 s. */
(function () {
  'use strict';
  var D = window.DN;
  var T = D.T, $ = D.$, el = D.el, icon = D.icon, btn = D.btn, tag = D.tag;
  var TABS = ['overview', 'lists', 'profiles', 'devices', 'log', 'settings'];
  var S = null;                 // the answer of admin/all, kept current
  var tab = 'overview';
  var ui = { test: null, testDomain: '', testWho: '', devQ: '', devProfile: '', devState: '', logQ: '', logPeer: '', logBlocked: '', logScope: '', logDays: '1', log: null, form: null, wizard: false };

  function panel(id) { return $('#dn-p-' + id); }
  function profile(id) { return S.settings.profiles.filter(function (p) { return p.id === id; })[0] || null; }
  function profileName(id) { var p = profile(id); return p ? p.name : id; }
  function quoted(name) { return T('q', { name: name }); }
  function card(cls, title, ic, extra, kids) {
    return el('div', { class: 'card ' + (cls || '') }, [el('h2', { class: 'card-title' }, [el('span', { class: 'ic' }, [icon(ic, 's16')]), title].concat(extra ? [extra] : []))].concat(kids || []));
  }
  function grid(kids) { return el('div', { class: 's-grid' }, kids); }
  function hint(text) { return el('div', { class: 's-hint', text: text }); }
  function busy(b, p) { b.disabled = true; return p.catch(D.warn).then(function (r) { b.disabled = false; return r; }); }
  function act(b, method, path, body, done) {
    return busy(b, D.api(method, path, body).then(function (r) { merge(r); if (done) done(r); render(); return r; }));
  }
  /** Take over what an answer brings (settings, config, status, devices …). */
  function merge(r) {
    if (!r || !S) return;
    ['settings', 'config', 'devices', 'pauses', 'lists', 'catalog', 'homes'].forEach(function (k) { if (r[k] && k !== 'lists') S[k] = r[k]; });
    if (r.lists && r.lists.lists) S.lists = r.lists;
    if (r.status && r.status.peers) S.status = r.status;
    if (r.today && S.stats) S.stats.today = r.today;
  }
  function refresh() { return D.api('GET', 'admin/live').then(function (r) { merge(r); if (tab === 'overview' || tab === 'devices') render(); }); }
  function reload() { return D.api('GET', 'admin/all').then(function (r) { S = r; render(); }); }

  // ─── Übersicht ───

  /** The people whose internet is paused (Familie) and who have a filtered VPN device: [{ name, until }] */
  function internetPaused() {
    var by = {};
    S.devices.forEach(function (d) { if (d.internetPaused && d.state === 'filtered' && d.user && !by[d.user.id]) by[d.user.id] = { name: d.user.name, until: d.internetPaused }; });
    return Object.keys(by).map(function (k) { return by[k]; });
  }
  function pauseAll(b, body) { return act(b, 'POST', 'admin/pause', body).then(refresh); }
  function renderOverview() {
    var p = D.clear(panel('overview'));
    var st = S.status;
    var state = st.state;
    if (st.blockedBy === 'internal_dns_off') p.appendChild(D.banner('crit', 'warn', T('ov.nodns_title'), T('ov.nodns_text'), null, 'alert'));
    if (state === 'off' && !st.blockedBy) {
      p.appendChild(D.banner('info', 'shield', T('ov.off_title'), T(S.config.setupDone ? 'ov.off_text' : 'ov.off_text_new'), [
        btn(T(S.config.setupDone ? 'ov.switch_on' : 'ov.setup'), 'btn-primary btn-sm', function () { openWizard(); }),
      ]));
    }
    if (state === 'starting') p.appendChild(D.banner('info', 'clock', T('ov.starting_title'), T('ov.starting_text')));
    if (state === 'filtering' && st.pause) {
      var pa = st.pause;
      var who = pa.by ? T('ov.paused_by', { name: pa.by.name, time: D.clock(pa.since) }) : '';
      var line = el('span', {}, pa.openEnd
        ? [T('ov.paused_open', { who: who })]
        : [T('ov.paused_left') + ' ', el('b', { class: 'num cd', 'data-until': pa.until, text: D.countdown(pa.until) }), ' · ' + T('ov.paused_all') + (who ? ' · ' + who : '') + '. ' + T('ov.paused_auto')]);
      p.appendChild(D.banner('warn', 'pause', pa.openEnd ? T('ov.paused_title_open') : T('ov.paused_title', { time: D.clock(pa.until) }), line, [
        pa.openEnd ? null : btn(T('ov.plus30'), 'btn-sm', function (ev) { pauseAll(ev.currentTarget, { extend: 30 }); }),
        btn(T('ov.resume'), 'btn-primary btn-sm', function (ev) { act(ev.currentTarget, 'POST', 'admin/resume').then(refresh); }, 'play'),
      ]));
    }
    if (state === 'fallback') {
      p.appendChild(D.banner('crit', 'warn', T('ov.fallback_title'), T('ov.fallback_text', { time: D.clock(st.since) }), [
        btn(T('ov.restart'), 'btn-sm', function (ev) { busy(ev.currentTarget, D.api('POST', 'admin/restart').then(function () { D.toast(T('ov.restarted')); return refresh(); })); }),
      ], 'alert'));
    }
    var fd = st.foreignDns;
    if (fd && fd.enabled && fd.error && state === 'filtering') p.appendChild(D.banner('warn', 'lock', T('se.fd_error_title'), T('se.fd_error_text', { error: fd.error }), [btn(T('tab.settings'), 'btn-sm', function () { show('settings'); })]));
    var paused = internetPaused();
    if (paused.length && state === 'filtering') p.appendChild(D.banner('warn', 'pause', T(paused.length === 1 ? 'ov.internet_title_one' : 'ov.internet_title', { n: paused.length }), T('ov.internet_text', { names: paused.map(function (x) { return T('ov.internet_who', { name: x.name, time: D.clock(x.until) }); }).join(', ') })));
    var tone = state === 'filtering' ? (st.pause ? 'warn' : 'good') : (state === 'fallback' ? 'crit' : 'grey');
    var label = state === 'filtering' ? (st.pause ? T('st.paused') : T('st.active')) : T('st.' + state);
    var t = st.today;
    var c = card('s5', T('ov.title'), 'shield', el('span', { class: 'tag sp ' + tone, text: label }));
    if (state === 'filtering' && !st.pause) {
      c.appendChild(el('div', { class: 'btns', role: 'group', 'aria-label': T('ov.pause_label') }, [el('span', { class: 's-hint', style: 'flex:1 1 100%', text: T('ov.pause_label') })].concat(
        [5, 30, 60].map(function (m) { return btn(D.duration(m), 'btn-sm', function (ev) { pauseAll(ev.currentTarget, { minutes: m }); }, 'clock'); }),
        [btn(T('ov.forever'), 'btn-sm', function (ev) { pauseAll(ev.currentTarget, { forever: true }); })])));
    } else if (state === 'filtering') {
      c.appendChild(el('div', { class: 'btns' }, [el('span', { class: 's-hint', style: 'flex:1 1 100%', text: T('ov.paused_hint') }),
        btn(T('ov.resume'), 'btn-primary btn-sm', function (ev) { act(ev.currentTarget, 'POST', 'admin/resume').then(refresh); }, 'shield')]));
    } else if (state === 'fallback') c.appendChild(hint(T('ov.fallback_hint', { time: D.clock(st.since) })));
    var share = t.queries > 0 ? t.blocked / t.queries : 0;
    var CIRC = 326.7;
    var donut = el('div', { class: 'donut-host' });
    donut.innerHTML = '<svg class="donut' + (state === 'filtering' && !st.pause ? '' : ' off') + '" viewBox="0 0 120 120" role="img"><circle class="track" cx="60" cy="60" r="52" fill="none" stroke-width="15"/><circle class="val" cx="60" cy="60" r="52" fill="none" stroke-width="15" stroke-linecap="round" stroke-dasharray="' + CIRC + '" stroke-dashoffset="' + (CIRC * (1 - share)).toFixed(1) + '" transform="rotate(-90 60 60)"/></svg>';
    donut.firstChild.setAttribute('aria-label', T('ov.donut', { percent: D.pct(t.blocked, t.queries) }));
    donut.appendChild(el('div', { class: 'donut-center' }, [el('div', {}, [el('span', { class: 'big', text: D.pct(t.blocked, t.queries) }), el('div', { class: 'cap', text: T('ov.blocked_today') })])]));
    c.appendChild(el('div', { class: 'pi-wrap' }, [donut, el('div', { class: 'pi-stats' }, [
      el('div', { class: 's' }, [el('span', { class: 'n', text: D.num(t.queries) }), el('span', { class: 't', text: T('ov.queries') })]),
      el('div', { class: 's' }, [el('span', { class: 'n blk', text: D.num(t.blocked) }), el('span', { class: 't', text: T('ov.blocked') })]),
      el('div', { class: 's' }, [el('span', { class: 'n ok', text: D.num(Math.max(0, t.queries - t.blocked)) }), el('span', { class: 't', text: T('ov.allowed') })]),
    ])]));
    // what blocked today's queries (counted since GateControl 1.265.0; days before that have no split)
    var by = t.blockedBy || {};
    var kinds = Object.keys(by).filter(function (k) { return by[k] > 0; });
    if (kinds.length) {
      c.appendChild(el('div', { class: 'dn-by', role: 'group', 'aria-label': T('ov.by_label') }, [el('span', { class: 's-hint', text: T('ov.by_label') })].concat(kinds.map(function (k) {
        return el('span', { class: 'pl txt', text: D.TO('by.' + k, k) + ' ' + D.num(by[k]) });
      }))));
    }
    var loaded = st.lists.filter(function (l) { return l.loaded; });
    var entries = loaded.reduce(function (n, l) { return n + l.entries; }, 0);
    var kpi = function (lab, val, sub) { return el('div', { class: 'kpi' }, [el('div', { class: 'lab', text: lab }), el('div', { class: 'val', text: val }), el('small', { text: sub })]); };
    c.appendChild(el('div', { class: 'kpis' }, [
      kpi(T('ov.kpi_filtered'), D.num(st.peers.filtered), T('ov.kpi_devices')),
      kpi(T('ov.kpi_owndns'), D.num(st.peers.ownDns), T('ov.kpi_unfiltered')),
      kpi(T('ov.kpi_entries'), D.num(entries), T(st.lists.length === 1 ? 'ov.kpi_lists_one' : 'ov.kpi_lists', { n: st.lists.length })),
    ]));
    var top = (S.stats.today && S.stats.today.top) || [];
    var max = top.length ? top[0].count : 1;
    var c2 = card('s7', T('ov.top_title'), 'bars', el('span', { class: 's-hint sp', text: T('rel.today') }));
    if (top.length) {
      c2.appendChild(el('ul', { class: 'toplist' }, top.slice(0, 7).map(function (x) {
        return el('li', {}, [el('button', { type: 'button', title: T('ov.top_check', { domain: x.domain }), on: { click: function () { ui.testDomain = x.domain; ui.testWho = ''; ui.test = null; show('lists'); runTest(); } } }, [
          el('span', { class: 'd', text: x.domain }), el('span', { class: 'c', text: D.num(x.count) }), el('span', { class: 'b' }, [el('i', { style: 'width:' + Math.max(3, Math.round((x.count / max) * 100)) + '%' })]),
        ])]);
      })));
      c2.appendChild(hint(T('ov.top_hint')));
    } else c2.appendChild(hint(T('ov.top_none')));
    var c3 = card('s12', T('ov.lists_title'), 'list', btn(T('ov.lists_manage'), 'btn-sm sp', function () { show('lists'); }));
    c3.appendChild(st.lists.length ? el('div', { class: 'rows' }, st.lists.map(function (l) {
      var only = l.profiles.indexOf('default') < 0 ? T('ov.list_only', { profiles: l.profiles.map(function (id) { return quoted(profileName(id)); }).join(', ') }) : D.TO('listd.' + l.id, l.source);
      return el('div', { class: 'rw' }, [el('div', { class: 't' }, [el('b', { text: D.listName(l.id) }), el('small', { text: only })]),
        el('span', { class: 'm', text: T(l.estimated ? 'li.entries_est' : 'li.entries', { n: D.num(l.entries) }) }),
        el('span', { class: 'm', text: l.updatedAt ? T('li.updated', { when: D.when(l.updatedAt) }) : T('li.never') }),
        l.error ? tag(T('li.failed'), 'warn') : (l.loaded ? tag(T('li.loaded'), 'good') : tag(T(state === 'off' ? 'st.off' : 'li.loading'), 'grey'))]);
    })) : hint(T('ov.lists_none')));
    c3.appendChild(hint(T('ov.lists_hint')));
    p.appendChild(grid([c, c2, c3]));
  }

  // ─── Listen & Ausnahmen ───

  function listRow(l, on, onChange, extra) {
    var where = l.updatedAt ? D.when(l.updatedAt) : (l.used ? T('li.loading') : T('li.never'));
    var others = l.profiles.filter(function (id) { return id !== 'default'; });
    var sub = D.TO('listd.' + l.id, l.source) + ' · ' + (!on && others.length ? T('li.on_in', { profiles: others.map(function (id) { return quoted(profileName(id)); }).join(', ') }) : where) + (extra ? ' · ' + extra : '');
    return el('div', { class: 'rw' }, [D.sw(on, onChange, D.listName(l.id)), el('div', { class: 't' }, [el('b', { text: D.listName(l.id) }), el('small', { text: sub })]),
      el('span', { class: 'm', text: (l.estimated ? T('li.about') + ' ' : '') + D.num(l.entries) })]);
  }
  function splitDomains(s) { return String(s || '').split(/[\s,;]+/).map(function (x) { return x.trim(); }).filter(Boolean); }
  function entryCard(kind, ic) {
    var list = S.settings[kind];
    var input = el('input', { class: 'inp mono grow', placeholder: T('li.placeholder'), 'aria-label': T('li.' + kind + '_title'), autocomplete: 'off', spellcheck: 'false' });
    var add = btn(T('common.add'), '', function () {
      var d = splitDomains(input.value);
      if (!d.length) return;
      act(add, 'POST', 'admin/entries', { list: kind, domains: d });
    });
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') add.click(); });
    var c = card('s6', T('li.' + kind + '_title'), ic, el('span', { class: 'tag grey plain sp', text: T(list.length === 1 ? 'li.count_one' : 'li.count', { n: list.length }) }));
    c.appendChild(el('div', { class: 'btns' }, [input, add]));
    c.appendChild(el('div', { class: 'pills' }, list.map(function (d) {
      return el('span', { class: 'pl' }, [d, el('button', { type: 'button', 'aria-label': T('common.remove_x', { name: d }), on: { click: function (ev) { act(ev.currentTarget, 'POST', 'admin/entries', { list: kind, domains: [d], remove: true }); } } }, [icon('x', 's12')])]);
    })));
    c.appendChild(hint(T('li.' + kind + '_hint')));
    return c;
  }
  function runTest() {
    var domain = ui.testDomain.trim();
    if (!domain) return Promise.resolve();
    var body = { domain: domain };
    if (/^peer:/.test(ui.testWho)) body.peerId = Number(ui.testWho.slice(5));
    else if (/^profile:/.test(ui.testWho)) body.profileId = ui.testWho.slice(8);
    return D.api('POST', 'admin/test', body).then(function (r) { ui.test = r.result; if (tab === 'lists') renderLists(); }).catch(function (e) { ui.test = { error: D.errText(e) }; if (tab === 'lists') renderLists(); });
  }
  function entryAction(label, kind, domain, profileId) {
    return btn(label, 'btn-sm', function (ev) {
      act(ev.currentTarget, 'POST', 'admin/entries', { list: kind, domains: [domain], profileId: profileId || undefined }, function () { D.toast(T('common.saved')); }).then(function () { if (ui.test) runTest(); });
    });
  }
  function testResult() {
    var r = ui.test;
    if (!r) return null;
    if (r.error) return el('div', { class: 'res blk' }, [icon('warn', 's18'), el('div', { text: r.error })]);
    var blocked = r.action === 'block';
    var target = r.device ? r.device.name : (r.profile ? T('test.profile', { name: r.profile.name }) : T('test.default'));
    var parts = [];
    if (r.profile) parts.push(T('test.profile', { name: r.profile.name }));
    parts.push(D.reasonText(r, true));
    if (D.matchText(r.match)) parts.push(D.matchText(r.match));
    if (r.safeSearch) parts.push(T('test.safe', { host: r.safeSearch }));
    var prof = r.profile && r.profile.id !== 'default' ? r.profile : null;
    var buttons = [];
    if (r.reason !== 'no_profile' && r.reason !== 'suspended' && r.reason !== 'paused' && r.reason !== 'internal' && r.reason !== 'local' && r.reason !== 'canary') {
      if (blocked) { buttons.push(entryAction(T('test.allow_all'), 'allow', r.domain)); if (prof) buttons.push(entryAction(T('test.allow_profile', { name: prof.name }), 'allow', r.domain, prof.id)); } else {
        buttons.push(entryAction(T('test.deny_all'), 'deny', r.domain));
        if (prof) buttons.push(entryAction(T('test.deny_profile', { name: prof.name }), 'deny', r.domain, prof.id));
      }
    }
    return el('div', { class: 'res ' + (blocked ? 'blk' : 'ok') }, [icon(blocked ? 'shield-x' : 'check', 's18'), el('div', {}, [
      el('b', { text: T(blocked ? 'test.blocked' : 'test.allowed') }), ' ' + T('test.for', { name: target }), el('br'),
      el('code', { text: r.domain }), ' · ' + parts.join(' · '),
      buttons.length ? el('div', { class: 'btns', style: 'margin-top:8px' }, buttons) : null,
    ])]);
  }
  function renderLists() {
    var p = D.clear(panel('lists'));
    var def = S.settings.profiles[0];
    var c1 = card('s7', T('li.title'), 'list', btn(T('li.refresh'), 'btn-sm sp', function (ev) {
      busy(ev.currentTarget, D.api('POST', 'admin/lists/refresh').then(function () { D.toast(T('li.refreshing')); }));
    }));
    c1.appendChild(hint(T('li.hint')));
    c1.appendChild(el('div', { class: 'rows' }, S.lists.lists.map(function (l) {
      return listRow(l, def.lists.indexOf(l.id) >= 0, function (on, b) {
        var lists = S.settings.profiles[0].lists.filter(function (x) { return x !== l.id; });
        if (on) lists.push(l.id);
        busy(b, D.api('PUT', 'admin/profiles/default', { profile: { lists: lists } }).then(function (r) { merge(r); return D.api('GET', 'admin/all'); }).then(function (r) { S = r; render(); }));
      });
    })));
    c1.appendChild(hint(S.lists.memoryBytes != null ? T('li.memory', { size: D.bytes(S.lists.memoryBytes), n: D.num(S.lists.entries) }) : T('li.daily')));
    var input = el('input', { class: 'inp mono grow', placeholder: T('li.placeholder'), value: ui.testDomain, 'aria-label': T('test.domain'), autocomplete: 'off', spellcheck: 'false', on: { input: function () { ui.testDomain = input.value; } } });
    var sel = el('select', { class: 'inp', 'aria-label': T('test.who'), on: { change: function () { ui.testWho = sel.value; } } }, [el('option', { value: '', text: T('test.default') })].concat(
      S.settings.profiles.slice(1).map(function (x) { return el('option', { value: 'profile:' + x.id, text: T('test.profile', { name: x.name }), selected: ui.testWho === 'profile:' + x.id }); }),
      S.devices.filter(function (d) { return d.type === 'peer'; }).map(function (d) { return el('option', { value: 'peer:' + d.peerId, text: d.name, selected: ui.testWho === 'peer:' + d.peerId }); })));
    var go = btn(T('test.go'), 'btn-primary', function () { busy(go, runTest()); });
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go.click(); });
    var c2 = card('s5', T('test.title'), 'search', null, [el('div', { class: 'btns' }, [input, sel, go]), testResult(), S.status.state !== 'filtering' ? hint(T('test.needs_filter')) : null]);
    p.appendChild(grid([c1, c2, entryCard('allow', 'check'), entryCard('deny', 'shield-x')]));
  }

  // ─── Profile ───

  var DAYS = [1, 2, 3, 4, 5, 6, 7];
  function daysText(days) {
    var names = days.map(function (d) { return T('day.' + d); });
    var run = days.length > 2 && days.every(function (d, i) { return i === 0 || d === days[i - 1] + 1; });
    return run ? names[0] + '–' + names[names.length - 1] : names.join(', ');
  }
  function scheduleTitle(s) { return daysText(s.days) + ' · ' + (s.from === '00:00' && s.to === '24:00' ? T('pf.all_day') : s.from + '–' + s.to); }
  function scheduleSub(s) { return T('pf.blocked') + ' ' + (s.block === 'all' ? T('pf.block_all') : s.categories.map(D.categoryName).join(', ')); }
  function nameOf(list, id) { var x = list.filter(function (y) { return y.id === id; })[0]; return x ? x.name : '#' + id; }
  function deviceName(id) { var d = S.devices.filter(function (x) { return x.peerId === id; })[0]; return d ? d.name : '#' + id; }
  function membersText(p) {
    var parts = [];
    var groups = p.groups.map(function (id) { return nameOf(S.groups, id); }).concat(p.peerGroups.map(function (id) { return nameOf(S.peerGroups, id); }));
    if (groups.length) parts.push(T(groups.length === 1 ? 'pf.m_group' : 'pf.m_groups') + ' ' + groups.join(', '));
    if (p.users.length) parts.push(T(p.users.length === 1 ? 'pf.m_user' : 'pf.m_users') + ' ' + p.users.map(function (id) { return nameOf(S.users, id); }).join(', '));
    if (p.peers.length) parts.push(T(p.peers.length === 1 ? 'pf.m_peer' : 'pf.m_peers') + ' ' + p.peers.map(deviceName).join(', '));
    return parts.join(' · ');
  }
  function devicesOf(id) { return S.devices.filter(function (d) { return d.profile && d.profile.id === id && (d.state === 'filtered' || d.state === 'ownDns'); }); }
  function countText(n) { return n === 0 ? T('pf.dev_none') : T(n === 1 ? 'pf.dev_one' : 'pf.dev_n', { n: n }); }
  function renderProfiles() {
    var p = D.clear(panel('profiles'));
    var rank = el('div', { class: 'rank' }, [el('span', { class: 'w', text: T('pf.r_device') }), el('i', { text: T('pf.beats') }), el('span', { text: T('pf.r_person') }), el('i', { text: T('pf.beats') }), el('span', { text: T('pf.r_group') }), el('i', { text: T('pf.beats') }), el('span', { text: T('pf.r_default') })]);
    p.appendChild(el('div', { class: 'banner' }, [el('span', { class: 'bi' }, [icon('info', 's18')]), el('div', { class: 'bt' }, [el('b', { text: T('pf.which_title') }), el('span', { text: T('pf.which_text') }), rank])]));
    var perProfile = S.config.pause.who === 'profile';
    var c = card('', T('pf.title'), 'users', btn(T('pf.new'), 'btn-primary btn-sm sp', function () { openProfile(null); }, 'plus'));
    c.appendChild(el('div', { class: 'rows' }, S.settings.profiles.map(function (pr, i) {
      var n = devicesOf(pr.id).length;
      var sub = (i === 0 ? T('pf.default_sub') : (membersText(pr) || T('pf.no_members'))) + ' · ' + countText(n);
      if (pr.schedules.length) sub += ' · ' + T('pf.times') + ' ' + scheduleTitle(pr.schedules[0]) + (pr.schedules.length > 1 ? ' (+' + (pr.schedules.length - 1) + ')' : '');
      var pills = pr.lists.length > 2 ? [el('span', { class: 'pl txt', text: T('pf.n_lists', { n: pr.lists.length }) })] : pr.lists.map(function (id) { return el('span', { class: 'pl txt', text: D.listName(id) }); });
      if (!pr.lists.length) pills.push(el('span', { class: 'pl txt', text: T('pf.no_lists') }));
      if (pr.safeSearch) pills.push(el('span', { class: 'pl txt', text: T('pf.safe') }));
      if (pr.home) pills.push(el('span', { class: 'pl txt on', title: T('pf.home_pill_title', { home: pr.home.gatewayName }) }, [icon('home', 's12'), T('pf.home_pill')]));
      if (pr.allow.length) pills.push(el('span', { class: 'pl txt', text: T('pf.n_allow', { n: pr.allow.length }) }));
      if (pr.deny.length) pills.push(el('span', { class: 'pl txt', text: T('pf.n_deny', { n: pr.deny.length }) }));
      var allowed = S.config.pause.profiles[pr.id] !== false;
      return el('div', { class: 'rw' }, [el('div', { class: 't' }, [el('b', { text: pr.name }), el('small', { text: sub }), el('div', { class: 'pills', style: 'margin-top:6px' }, pills)]),
        perProfile ? tag(T(allowed ? 'pf.pause_ok' : 'pf.pause_no'), allowed ? 'good' : 'grey', true) : null,
        btn(T(i === 0 ? 'pf.change' : 'pf.edit'), 'btn-sm', function () { openProfile(pr.id); })]);
    })));
    p.appendChild(c);
  }

  /** A picker in the frame: pick(title, [{ id, label, sub }], [selected ids]) → ids | null */
  function pick(title, items, selected) {
    return new Promise(function (resolve) {
      var chosen = {};
      selected.forEach(function (id) { chosen[id] = true; });
      var done = false;
      var box = el('div', { class: 'dn-pick' });
      function draw(q) {
        D.clear(box);
        var shown = items.filter(function (x) { return !q || (x.label + ' ' + (x.sub || '')).toLowerCase().indexOf(q) >= 0; });
        if (!shown.length) box.appendChild(el('p', { class: 's-hint', text: T('pick.none') }));
        shown.forEach(function (x) {
          box.appendChild(el('label', { class: 'chk' }, [el('input', { type: 'checkbox', checked: !!chosen[x.id], on: { change: function (ev) { chosen[x.id] = ev.target.checked; } } }), el('span', { text: x.label }), x.sub ? el('small', { text: x.sub }) : null]));
        });
      }
      var search = el('input', { type: 'search', 'aria-label': T('pick.search'), placeholder: T('pick.search'), on: { input: function () { draw(search.value.trim().toLowerCase()); } } });
      draw('');
      var m = D.modal({
        title: title, small: true, body: [items.length > 8 ? el('div', { class: 'inp-ic' }, [icon('search', 's14'), search]) : null, box], onClose: function () { if (!done) resolve(null); },
        foot: [btn(T('common.cancel'), 'btn-ghost', function () { m.close(); }), btn(T('common.apply'), 'btn-primary', function () { done = true; m.close(); resolve(items.filter(function (x) { return chosen[x.id]; }).map(function (x) { return x.id; })); })],
      });
    });
  }
  /** GateControl's own picker for groups and people where the page has it, else the picker in the frame. */
  function pickPrincipals(kind, title, items, selected) {
    if (window.GC && typeof window.GC.pickPrincipals === 'function') {
      return window.GC.pickPrincipals({ groups: kind === 'group', users: kind === 'user', multiple: true, title: title }).then(function (list) {
        if (!list) return null;
        var ids = selected.slice();
        list.forEach(function (x) { if (x.type === kind && ids.indexOf(x.id) < 0) ids.push(x.id); });
        return ids;
      });
    }
    return pick(title, items, selected);
  }
  function openSchedule(onDone) {
    var days = { 1: true, 2: true, 3: true, 4: true, 5: true };
    var dayBtns = el('div', { class: 'dn-days', role: 'group', 'aria-label': T('sc.days') }, DAYS.map(function (d) {
      return el('button', { type: 'button', class: 'btn btn-sm', 'aria-pressed': days[d] ? 'true' : 'false', text: T('day.' + d), on: { click: function (ev) { days[d] = !days[d]; ev.currentTarget.setAttribute('aria-pressed', days[d] ? 'true' : 'false'); } } });
    }));
    var from = el('input', { type: 'time', class: 'inp', value: '21:00', id: 'dn-sc-from' });
    var to = el('input', { type: 'time', class: 'inp', value: '07:00', id: 'dn-sc-to' });
    var whole = el('input', { type: 'checkbox', on: { change: function () { from.disabled = to.disabled = whole.checked; } } });
    var cats = S.catalog.categories.map(function (c) { return { id: c.id, box: el('input', { type: 'checkbox', checked: true }) }; });
    var catBox = el('div', { class: 'fg' }, cats.map(function (c) { return el('label', { class: 'chk' }, [c.box, el('span', { text: D.categoryName(c.id) })]); }));
    var all = el('input', { type: 'radio', name: 'dn-sc-block', value: 'all', on: { change: function () { catBox.hidden = true; } } });
    var some = el('input', { type: 'radio', name: 'dn-sc-block', value: 'categories', checked: true, on: { change: function () { catBox.hidden = false; } } });
    var m = D.modal({
      title: T('sc.title'), small: true,
      body: [
        el('div', { class: 'fg' }, [el('span', { class: 'lbl', text: T('sc.days') }), dayBtns]),
        el('div', { class: 'btns' }, [el('div', { class: 'fg' }, [el('label', { for: 'dn-sc-from', text: T('sc.from') }), from]), el('div', { class: 'fg' }, [el('label', { for: 'dn-sc-to', text: T('sc.to') }), to])]),
        el('label', { class: 'chk' }, [whole, el('span', { text: T('sc.whole') })]),
        el('div', { class: 'fg' }, [el('span', { class: 'lbl', text: T('sc.block') }),
          el('label', { class: 'radio' }, [some, el('span', { class: 't' }, [el('b', { text: T('sc.block_some') })])]), catBox,
          el('label', { class: 'radio' }, [all, el('span', { class: 't' }, [el('b', { text: T('sc.block_all') }), el('small', { text: T('sc.block_all_hint') })])])]),
        hint(T('sc.hint')),
      ],
      foot: [btn(T('common.cancel'), 'btn-ghost', function () { m.close(); }), btn(T('common.add'), 'btn-primary', function () {
        var d = DAYS.filter(function (x) { return days[x]; });
        var s = { days: d, from: whole.checked ? '00:00' : from.value, to: whole.checked ? '24:00' : to.value, block: all.checked ? 'all' : 'categories', categories: all.checked ? [] : cats.filter(function (c) { return c.box.checked; }).map(function (c) { return c.id; }), allowAlways: [] };
        if (!d.length || !s.from || !s.to || (s.from === s.to) || (s.block === 'categories' && !s.categories.length)) { D.toast(T('sc.invalid'), 'error'); return; }
        m.close();
        onDone(s);
      })],
    });
  }
  function openProfile(id) {
    var isNew = id === null;
    var src = isNew ? { id: null, name: '', lists: S.catalog.lists.filter(function (l) { return l.defaultOn; }).map(function (l) { return l.id; }), safeSearch: false, allow: [], deny: [], schedules: [], groups: [], peerGroups: [], users: [], peers: [], home: null } : profile(id);
    if (!src) return;
    var f = JSON.parse(JSON.stringify(src));
    var isDefault = id === 'default';
    var pauseAllowed = isNew ? true : S.config.pause.profiles[id] !== false;
    // shared with a home network: `pick` = '' | 'g:<gateway>:<home profile>' (take that profile over) | 'c:<gateway>' (the
    // home gets this profile); `unlink` ends a link that exists
    var link = { pick: '', unlink: false };
    var homes = S.homes || [];
    function linked() { return !!(src.home && !link.unlink); }
    function adopting() { return /^g:/.test(link.pick); }
    function shares() { return linked() || !!link.pick; }
    /** A label; what a shared profile has in common with the home's profile carries the mark "Heimnetz". */
    function lbl(text, cls) {
      return el(cls ? 'div' : 'span', { class: cls || 'lbl' }, [text, shares() ? el('span', { class: 'pl txt on', style: 'margin-left:8px;min-height:20px;text-transform:none;letter-spacing:0', title: T('pf.home_field') }, [icon('home', 's12'), T('pf.home_field_short')]) : null]);
    }
    var name = el('input', { class: 'inp', id: 'dn-pf-name', maxlength: '40', value: f.name, autocomplete: 'off' });
    function listBox() {
      return el('div', { class: 'fg' }, [lbl(T('pf.lists'))].concat(S.lists.lists.map(function (l) {
        return el('label', { class: 'chk' }, [el('input', { type: 'checkbox', checked: f.lists.indexOf(l.id) >= 0, on: { change: function (ev) { f.lists = f.lists.filter(function (x) { return x !== l.id; }); if (ev.target.checked) f.lists.push(l.id); } } }),
          el('span', { text: D.listName(l.id) }), el('small', { text: (l.estimated ? T('li.about') + ' ' : '') + D.num(l.entries) })]);
      })));
    }
    var times = el('div', { class: 'fg' });
    function drawTimes() {
      D.clear(times);
      times.appendChild(lbl(T('pf.times_label')));
      f.schedules.forEach(function (s, i) {
        times.appendChild(el('div', { class: 'rw box' }, [el('div', { class: 't' }, [el('b', { text: scheduleTitle(s) }), el('small', { text: scheduleSub(s) })]),
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': T('common.remove_x', { name: scheduleTitle(s) }), on: { click: function () { f.schedules.splice(i, 1); drawTimes(); } } }, [icon('x', 's16')])]));
      });
      times.appendChild(el('div', {}, [btn(T('pf.add_time'), 'btn-sm', function () { openSchedule(function (s) { f.schedules.push(s); drawTimes(); }); }, 'plus')]));
    }
    function entryBox(kind) {
      var box = el('div', { class: 'fg' });
      function draw() {
        D.clear(box);
        box.appendChild(lbl(T('pf.' + kind + '_label')));
        var input = el('input', { class: 'inp mono', placeholder: T('li.placeholder'), 'aria-label': T('pf.' + kind + '_label'), autocomplete: 'off', spellcheck: 'false', hidden: true, style: 'min-height:28px' });
        var add = el('button', { type: 'button', class: 'pl add', on: { click: function () { input.hidden = false; add.hidden = true; input.focus(); } } }, [icon('plus', 's12'), T('pf.entry')]);
        function commit() { splitDomains(input.value).forEach(function (d) { d = d.toLowerCase(); if (f[kind].indexOf(d) < 0) f[kind].push(d); }); draw(); }
        input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); commit(); } });
        input.addEventListener('blur', commit);
        box.appendChild(el('div', { class: 'pills' }, f[kind].map(function (d, i) {
          return el('span', { class: 'pl' }, [d, el('button', { type: 'button', 'aria-label': T('common.remove_x', { name: d }), on: { click: function () { f[kind].splice(i, 1); draw(); } } }, [icon('x', 's12')])]);
        }).concat([add, input])));
      }
      draw();
      return box;
    }
    var members = el('div', { class: 'fg' });
    function memberPills(key, list, labelOf, ic, addLabel, onAdd) {
      return el('div', { class: 'pills' }, list.map(function (mid, i) {
        return el('span', { class: 'pl txt' }, [icon(ic, 's12'), labelOf(mid), el('button', { type: 'button', 'aria-label': T('common.remove_x', { name: labelOf(mid) }), on: { click: function () { f[key].splice(i, 1); drawMembers(); } } }, [icon('x', 's12')])]);
      }).concat([el('button', { type: 'button', class: 'pl add', on: { click: onAdd } }, [icon('plus', 's12'), addLabel])]));
    }
    function drawMembers() {
      D.clear(members);
      members.appendChild(el('span', { class: 'lbl', text: T('pf.members') }));
      members.appendChild(el('div', { class: 's-sub', text: T('pf.groups') }));
      members.appendChild(memberPills('groups', f.groups, function (x) { return nameOf(S.groups, x); }, 'users', T('pf.pick_group'), function () {
        pickPrincipals('group', T('pf.pick_group'), S.groups.map(function (g) { return { id: g.id, label: g.name }; }), f.groups).then(function (ids) { if (ids) { f.groups = ids; drawMembers(); } });
      }));
      if (S.peerGroups.length || f.peerGroups.length) {
        members.appendChild(memberPills('peerGroups', f.peerGroups, function (x) { return nameOf(S.peerGroups, x); }, 'phone', T('pf.pick_peergroup'), function () {
          pick(T('pf.pick_peergroup'), S.peerGroups.map(function (g) { return { id: g.id, label: g.name }; }), f.peerGroups).then(function (ids) { if (ids) { f.peerGroups = ids; drawMembers(); } });
        }));
      }
      // the people of a profile that is taken over from the home come from there
      if (!adopting()) {
        members.appendChild(lbl(T('pf.persons'), 's-sub'));
        members.appendChild(memberPills('users', f.users, function (x) { return nameOf(S.users, x); }, 'user', T('pf.pick_user'), function () {
          pickPrincipals('user', T('pf.pick_user'), S.users.map(function (u) { return { id: u.id, label: u.name }; }), f.users).then(function (ids) { if (ids) { f.users = ids; drawMembers(); } });
        }));
      }
      members.appendChild(el('div', { class: 's-sub', text: T('pf.devices') }));
      members.appendChild(memberPills('peers', f.peers, deviceName, 'phone', T('pf.pick_peer'), function () {
        pick(T('pf.pick_peer'), S.devices.filter(function (d) { return d.type === 'peer'; }).map(function (d) { return { id: d.peerId, label: d.name, sub: d.user ? d.user.name : '' }; }), f.peers).then(function (ids) { if (ids) { f.peers = ids; drawMembers(); } });
      }));
      var names = S.devices.filter(function (d) { return d.type === 'peer' && (f.peers.indexOf(d.peerId) >= 0 || (d.user && f.users.indexOf(d.user.id) >= 0)); }).map(function (d) { return d.name; });
      members.appendChild(hint((names.length ? T('pf.applies', { devices: names.join(', ') }) + ' ' : '') + T('pf.applies_rule')));
    }
    /** "Gilt zu Hause und unterwegs" (a link that exists) or the choice "Mit Heimnetz-Profil verbinden". */
    function homeBox() {
      if (src.home && !link.unlink) {
        return el('div', { class: 'res home' }, [icon('home', 's18'), el('div', {}, [
          el('b', { text: T('pf.home_title') }), ' ' + T('pf.home_text', { home: src.home.gatewayName, name: src.home.name }), el('br'),
          el('small', { text: T(isDefault ? 'pf.home_fields_default' : 'pf.home_fields') }),
          el('div', { class: 'btns', style: 'margin-top:8px' }, [btn(T('pf.home_unlink'), 'btn-sm', function () { link.unlink = true; fill(); })]),
        ])]);
      }
      if (src.home) {
        return el('div', { class: 'fg' }, [el('span', { class: 'lbl', text: T('pf.home_label') }), hint(T('pf.home_unlink_note', { home: src.home.gatewayName })),
          el('div', {}, [btn(T('pf.home_keep'), 'btn-sm', function () { link.unlink = false; fill(); })])]);
      }
      var opts = [el('option', { value: '', text: T('pf.home_none') })];
      homes.forEach(function (h) {
        h.profiles.forEach(function (hp) {
          if (hp.linkedTo || (hp.id === 'default') !== isDefault) return;
          var v = 'g:' + h.gateway.peerId + ':' + hp.id;
          opts.push(el('option', { value: v, text: T('pf.home_opt', { home: h.gateway.name, name: hp.name }), selected: link.pick === v }));
        });
        if (!isDefault) opts.push(el('option', { value: 'c:' + h.gateway.peerId, text: T('pf.home_create', { home: h.gateway.name }), selected: link.pick === 'c:' + h.gateway.peerId }));
      });
      if (opts.length < 2) return null;
      var sel = el('select', { class: 'inp', id: 'dn-pf-home', on: { change: function () { link.pick = sel.value; fill(); } } }, opts);
      return el('div', { class: 'fg' }, [el('label', { for: 'dn-pf-home', text: T('pf.home_label') }), sel,
        hint(T(adopting() ? (isDefault ? 'pf.home_adopt_hint_default' : 'pf.home_adopt_hint') : (link.pick ? 'pf.home_create_hint' : 'pf.home_hint')))]);
    }
    var m;
    /** (Re)build the dialog: what a profile takes over from the home's profile is not asked here. */
    function fill() {
      drawTimes();
      if (!isDefault) drawMembers();
      var own = !adopting();
      var body = [
        el('div', { class: 'fg' }, [el('label', { for: 'dn-pf-name', text: T('pf.name') }), name, shares() ? hint(T('pf.home_name_hint')) : null]),
        isDefault ? hint(T('pf.default_hint')) : null,
        homeBox(),
        own ? listBox() : null,
        own ? D.row(T('pf.safe'), T('pf.safe_hint') + (shares() ? ' ' + T('pf.home_field') : ''), D.sw(f.safeSearch, function (on) { f.safeSearch = on; }, T('pf.safe')), 'flat') : null,
        own ? times : null, own ? entryBox('allow') : null, own ? entryBox('deny') : null,
        isDefault ? null : members,
        S.config.pause.who === 'profile' ? D.row(T('pf.pause_switch'), T('pf.pause_switch_hint'), D.sw(pauseAllowed, function (on) { pauseAllowed = on; }, T('pf.pause_switch')), 'flat') : null,
      ];
      D.clear(m.body);
      body.forEach(function (x) { if (x) m.body.appendChild(x); });
    }
    var save = btn(T('common.save'), 'btn-primary', function () {
      var prof = { name: name.value.trim() };
      // a profile taken over from the home: its lists, safe search, times, own entries and people come from there
      if (!adopting()) { prof.lists = f.lists; prof.safeSearch = f.safeSearch; prof.allow = f.allow; prof.deny = f.deny; prof.schedules = f.schedules; }
      if (!isDefault) { prof.groups = f.groups; prof.peerGroups = f.peerGroups; prof.peers = f.peers; if (!adopting()) prof.users = f.users; }
      if (src.home && link.unlink) prof.home = null;
      else if (adopting()) { var g = link.pick.split(':'); prof.home = { gateway: Number(g[1]), profile: g.slice(2).join(':') }; } else if (link.pick) prof.home = { gateway: Number(link.pick.slice(2)), create: true };
      if (!prof.name) { D.toast(T('pf.name_needed'), 'error'); name.focus(); return; }
      var body2 = { profile: prof };
      if (S.config.pause.who === 'profile') body2.pauseAllowed = pauseAllowed;
      busy(save, D.api(isNew ? 'POST' : 'PUT', 'admin/profiles' + (isNew ? '' : '/' + encodeURIComponent(id)), body2).then(function () { m.close(); D.toast(T('common.saved')); return reload(); }));
    });
    var del = isNew || isDefault ? null : btn(T('pf.delete'), 'btn-danger', function () {
      D.confirmDialog(T('pf.delete_title', { name: src.name }), T(src.home ? 'pf.delete_text_home' : 'pf.delete_text'), T('pf.delete'), true).then(function (ok) {
        if (!ok) return;
        busy(del, D.api('DELETE', 'admin/profiles/' + encodeURIComponent(id)).then(function () { m.close(); return reload(); }));
      });
    });
    m = D.modal({ title: isNew ? T('pf.new_title') : T('pf.edit_title', { name: src.name }), body: [], foot: [del, el('span', { class: 'g' }), btn(T('common.cancel'), 'btn-ghost', function () { m.close(); }), save] });
    fill();
    name.focus();
  }

  // ─── Geräte ───

  function viaText(d) {
    if (!d.profile) return d.state === 'ownDns' ? T('dv.owndns', { dns: d.ownDns }) : (d.type === 'gateway' ? T('dv.gateway') : (d.state === 'excluded' ? T('dv.excluded_sub') : T('dv.disabled_sub')));
    if (d.state === 'ownDns') return T('dv.owndns', { dns: d.ownDns });
    if (d.via === 'peer') return T('dv.via_peer');
    if (d.via === 'user') return T('dv.via_user', { name: d.user ? d.user.name : '' });
    if (d.via === 'peerGroup') return T('dv.via_peergroup', { name: d.peerGroup ? d.peerGroup.name : '' });
    if (d.via === 'group') return T('dv.via_group', { name: nameOf(S.groups, d.viaId) });
    return T('dv.via_default');
  }
  function platformText(d) { return d.type === 'gateway' ? T('dv.p_gateway') : D.TO('dv.p_' + d.platform, d.platform || T('dv.p_other')); }
  function stateTag(d) {
    if (d.type === 'gateway') return tag(T('dv.s_excluded'), 'grey');
    if (d.state === 'ownDns') return tag(T('dv.s_owndns'), 'warn');
    if (d.state === 'excluded') return tag(T('dv.s_excluded'), 'grey');
    if (d.state === 'disabled') return tag(T('dv.s_disabled'), 'grey');
    if (S.status.state === 'fallback') return tag(T('dv.s_unfiltered'), 'crit');
    if (S.status.state !== 'filtering') return tag(T('dv.s_off'), 'grey');
    if (d.internetPaused) return tag(T('dv.s_internet_until', { time: D.clock(d.internetPaused) }), 'crit');
    if (d.suspended) return tag(d.suspendedUntil ? T('dv.s_paused_until', { time: D.clock(d.suspendedUntil) }) : T('dv.s_paused'), 'warn');
    return tag(T('dv.s_filtered'), 'good');
  }
  function openDevice(d) {
    var cur = d.via === 'peer' && d.profile ? d.profile.id : '';
    var sel = el('select', { class: 'inp', id: 'dn-dv-profile' }, [el('option', { value: '', text: T('dv.no_own') })].concat(S.settings.profiles.slice(1).map(function (p) { return el('option', { value: p.id, text: p.name, selected: p.id === cur }); })));
    var excluded = S.settings.excluded.indexOf(d.peerId) >= 0;
    var save = btn(T('common.save'), 'btn-primary', function () {
      busy(save, D.api('PUT', 'admin/devices/' + d.peerId, { profileId: sel.value || null, excluded: excluded }).then(function (r) { merge(r); m.close(); D.toast(T('common.saved')); return reload(); }));
    });
    var m = D.modal({
      title: T('dv.change_title', { name: d.name }), small: true,
      body: [el('div', { class: 'fg' }, [el('label', { for: 'dn-dv-profile', text: T('dv.own_profile') }), sel, hint(T('dv.own_profile_hint'))]),
        D.row(T('dv.exclude'), T('dv.exclude_hint'), D.sw(excluded, function (on) { excluded = on; }, T('dv.exclude')), 'flat')],
      foot: [btn(T('common.cancel'), 'btn-ghost', function () { m.close(); }), save],
    });
  }
  function deviceRows() {
    var q = ui.devQ.trim().toLowerCase();
    var list = S.devices.filter(function (d) {
      if (q && (d.name + ' ' + (d.user ? d.user.name : '')).toLowerCase().indexOf(q) < 0) return false;
      if (ui.devProfile && (!d.profile || d.profile.id !== ui.devProfile)) return false;
      if (ui.devState && d.state !== ui.devState) return false;
      return true;
    });
    if (!list.length) return [el('tr', {}, [el('td', { class: 'empty', colspan: '7', text: T('dv.none') })])];
    return list.map(function (d) {
      var dim = d.state !== 'filtered';
      var filtered = d.state === 'filtered';
      var t = d.today;
      var action = d.type === 'gateway' ? null : btn(T('dv.change'), 'btn-ghost btn-sm', function () { openDevice(d); });
      var on = filtered && d.suspended && d.suspendedBy !== 'all' && S.status.state === 'filtering'
        ? btn(T('dv.resume'), 'btn-ghost btn-sm', function (ev) { busy(ev.currentTarget, D.api('POST', 'admin/devices/' + d.peerId + '/resume').then(refresh)); }) : null;
      return el('tr', { class: dim ? 'dim' : '' }, [
        el('td', {}, [el('b', { text: d.name }), el('small', { text: platformText(d) + (d.ip ? ' · ' + d.ip : '') })]),
        el('td', { text: d.user ? d.user.name : '–' }),
        el('td', {}, [d.profile && d.state !== 'ownDns' ? d.profile.name : '–', el('small', { text: viaText(d) })]),
        el('td', { class: 'r mono', text: filtered && t ? D.num(t.queries) : '–' }),
        el('td', { class: 'r mono', text: filtered && t ? D.num(t.blocked) + ' · ' + D.pct(t.blocked, t.queries) : '–' }),
        el('td', {}, [stateTag(d), filtered && d.timesSuspended && S.status.state === 'filtering' ? el('small', { text: T('dv.times_suspended', { time: D.clock(d.timesSuspended) }) }) : null,
          filtered && d.internetPaused && d.suspended && S.status.state === 'filtering' ? el('small', { text: T('dv.also_paused') }) : null]),
        el('td', {}, [el('div', { class: 'btns' }, [on, action])]),
      ]);
    });
  }
  function renderDevices() {
    var p = D.clear(panel('devices'));
    var own = S.devices.filter(function (d) { return d.state === 'ownDns'; });
    if (own.length) {
      p.appendChild(D.banner('warn', 'warn', T(own.length === 1 ? 'dv.own_title_one' : 'dv.own_title', { n: own.length }),
        T(own.length === 1 ? 'dv.own_text_one' : 'dv.own_text', { name: own[0].name, dns: own[0].ownDns, names: own.map(function (d) { return d.name; }).join(', ') })));
    }
    var body = el('tbody', {}, deviceRows());
    var redraw = function () { D.clear(body); deviceRows().forEach(function (r) { body.appendChild(r); }); };
    var search = el('input', { type: 'search', value: ui.devQ, placeholder: T('dv.search'), 'aria-label': T('dv.search'), on: { input: function () { ui.devQ = search.value; redraw(); } } });
    var selP = el('select', { class: 'inp', 'aria-label': T('dv.f_profile'), on: { change: function () { ui.devProfile = selP.value; redraw(); } } }, [el('option', { value: '', text: T('dv.all_profiles') })].concat(S.settings.profiles.map(function (x) { return el('option', { value: x.id, text: x.name, selected: ui.devProfile === x.id }); })));
    var selS = el('select', { class: 'inp', 'aria-label': T('dv.f_state'), on: { change: function () { ui.devState = selS.value; redraw(); } } }, [el('option', { value: '', text: T('dv.all_states') })].concat(['filtered', 'ownDns', 'excluded', 'gateway', 'disabled'].map(function (x) { return el('option', { value: x, text: T('dv.f_' + x), selected: ui.devState === x }); })));
    p.appendChild(el('div', { class: 'btns' }, [el('div', { class: 'inp-ic' }, [icon('search', 's14'), search]), selP, selS]));
    var head = [T('dv.h_device'), T('dv.h_person'), T('dv.h_profile'), T('dv.h_queries'), T('dv.h_blocked'), T('dv.h_state'), ''];
    p.appendChild(el('div', { class: 'tw', tabindex: '0', role: 'region', 'aria-label': T('dv.table') }, [el('table', { class: 'tb' }, [
      el('thead', {}, [el('tr', {}, head.map(function (h, i) { return el('th', { class: i === 3 || i === 4 ? 'r' : '', text: h }); }))]), body])]));
    if (S.status.state === 'filtering' && S.status.pause) p.appendChild(hint(S.status.pause.openEnd ? T('dv.paused_open') : T('dv.paused_until', { time: D.clock(S.status.pause.until) })));
    if (S.devices.some(function (d) { return d.internetPaused && d.state === 'filtered'; })) p.appendChild(hint(T('dv.internet_hint')));
    p.appendChild(hint(T(S.status.log.enabled ? 'dv.hint' : 'dv.hint_nolog')));
  }

  // ─── Protokoll ───

  function setLog(patch, b) { return busy(b, D.api('PUT', 'admin/settings', { log: patch }).then(function (r) { merge(r); ui.log = null; render(); })); }
  function loadLog(more) {
    var q = [];
    if (ui.logQ.trim()) q.push('search=' + encodeURIComponent(ui.logQ.trim()));
    if (ui.logPeer) q.push('peerId=' + encodeURIComponent(ui.logPeer));
    if (ui.logBlocked) q.push('blockedOnly=1');
    if (ui.logScope) q.push('scope=' + encodeURIComponent(ui.logScope));
    if (ui.logDays) q.push('days=' + encodeURIComponent(ui.logDays));
    if (more && ui.log && ui.log.next) q.push('before=' + ui.log.next);
    return D.api('GET', 'admin/log' + (q.length ? '?' + q.join('&') : '')).then(function (r) {
      ui.log = { entries: more && ui.log ? ui.log.entries.concat(r.entries) : r.entries, next: r.next };
      if (tab === 'log') drawLog();
    }).catch(D.warn);
  }
  function entryDialog(e, kind) {
    var prof = e.profile && e.profile.id !== 'default' ? e.profile : null;
    var send = function (b, profileId) { busy(b, D.api('POST', 'admin/entries', { list: kind, domains: [e.domain], profileId: profileId }).then(function (r) { merge(r); m.close(); D.toast(T('common.saved')); })); };
    var m = D.modal({
      title: T(kind === 'allow' ? 'lg.allow_title' : 'lg.deny_title', { domain: e.domain }), small: true, body: [el('p', { text: T(kind === 'allow' ? 'lg.allow_text' : 'lg.deny_text') })],
      foot: [btn(T('common.cancel'), 'btn-ghost', function () { m.close(); }),
        prof ? btn(T('lg.only_profile', { name: prof.name }), '', function (ev) { send(ev.currentTarget, prof.id); }) : null,
        btn(T('lg.for_all'), 'btn-primary', function (ev) { send(ev.currentTarget); })],
    });
  }
  var RESULT_TONE = { blocked: 'crit', allowed: 'good', allowed_paused: 'warn', safe_search: 'blue' };
  function drawLog() {
    var box = $('#dn-log-box');
    if (!box) return;
    D.clear(box);
    var rows = ui.log ? ui.log.entries : null;
    var body = el('tbody', {}, !rows ? [el('tr', {}, [el('td', { class: 'empty', colspan: '6', text: T('common.loading') })])] : (!rows.length ? [el('tr', {}, [el('td', { class: 'empty', colspan: '6', text: T('lg.none') })])] : rows.map(function (e) {
      var canAct = e.result === 'blocked' || e.result === 'allowed';
      return el('tr', {}, [
        el('td', { class: 'mono nw', text: D.clock(e.at, true), title: D.when(e.at) }),
        el('td', {}, [e.device || '#' + e.peerId, el('small', { text: [e.person, e.profile && e.profile.name].filter(Boolean).join(' · ') })]),
        el('td', { class: 'mono', text: e.domain }),
        el('td', {}, [tag(T('lg.r_' + e.result), RESULT_TONE[e.result] || 'grey', e.result === 'safe_search')]),
        el('td', { text: D.reasonText(e) }),
        el('td', {}, [canAct ? btn(T(e.result === 'blocked' ? 'lg.allow' : 'lg.deny'), 'btn-ghost btn-sm', function () { entryDialog(e, e.result === 'blocked' ? 'allow' : 'deny'); }) : null]),
      ]);
    })));
    var head = [T('lg.h_time'), T('dv.h_device'), T('lg.h_domain'), T('lg.h_result'), T('lg.h_reason'), ''];
    box.appendChild(el('div', { class: 'tw', tabindex: '0', role: 'region', 'aria-label': T('lg.table') }, [el('table', { class: 'tb' }, [el('thead', {}, [el('tr', {}, head.map(function (h) { return el('th', { text: h }); }))]), body])]));
    if (ui.log && ui.log.next) box.appendChild(el('div', {}, [btn(T('lg.more'), 'btn-sm', function (ev) { busy(ev.currentTarget, loadLog(true)); })]));
  }
  function renderLog() {
    var p = D.clear(panel('log'));
    var lg = S.settings.log;
    var c = el('div', { class: 'card' });
    c.appendChild(D.row(T('lg.keep'), T('lg.keep_hint'), D.sw(lg.enabled, function (on, b) {
      b.setAttribute('aria-checked', on ? 'false' : 'true'); // decided in the dialog
      D.confirmDialog(T(on ? 'lg.on_title' : 'lg.off_title'), T(on ? 'lg.on_text' : 'lg.off_text'), T(on ? 'lg.on_ok' : 'lg.off_ok'), !on).then(function (ok) { if (ok) setLog({ enabled: on }, b); });
    }, T('lg.keep')), 'flat'));
    var days = [1, 3, 7, 30];
    if (days.indexOf(lg.retentionDays) < 0) days.push(lg.retentionDays);
    var ret = el('select', { class: 'inp', id: 'dn-lg-ret', on: { change: function () { setLog({ retentionDays: Number(ret.value) }, ret); } } }, days.sort(function (a, b) { return a - b; }).map(function (d) {
      return el('option', { value: d, text: d === 1 ? T('lg.ret_1') : T(d === 7 ? 'lg.ret_default' : 'lg.ret_n', { n: d }), selected: d === lg.retentionDays });
    }));
    var view = function (value, title, sub) {
      return el('label', { class: 'radio' }, [el('input', { type: 'radio', name: 'dn-logview', value: value, checked: S.config.logView === value, on: { change: function (ev) { act(ev.target, 'PUT', 'admin/config', { logView: value }); } } }),
        el('span', { class: 't' }, [el('b', { text: title }), el('small', { text: sub })])]);
    };
    c.appendChild(grid([
      el('div', { class: 'fg s4' }, [el('label', { for: 'dn-lg-ret', text: T('lg.retention') }), ret]),
      el('div', { class: 'fg s8' }, [el('span', { class: 'lbl', text: T('lg.who') }), el('div', { class: 'radios' }, [view('admins', T('lg.who_admins'), T('lg.who_admins_hint')), view('own', T('lg.who_own'), T('lg.who_own_hint'))])]),
    ]));
    p.appendChild(c);
    if (!lg.enabled) { p.appendChild(hint(T('lg.off_hint'))); return; }
    var search = el('input', { type: 'search', value: ui.logQ, placeholder: T('lg.search'), 'aria-label': T('lg.search'), on: { change: function () { ui.logQ = search.value; loadLog(); } } });
    search.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ui.logQ = search.value; loadLog(); } });
    var selD = el('select', { class: 'inp', 'aria-label': T('lg.f_device'), on: { change: function () { ui.logPeer = selD.value; loadLog(); } } }, [el('option', { value: '', text: T('lg.all_devices') })].concat(
      S.devices.filter(function (d) { return d.type === 'peer'; }).map(function (d) { return el('option', { value: d.peerId, text: d.name, selected: String(d.peerId) === ui.logPeer }); })));
    var selB = el('select', { class: 'inp', 'aria-label': T('lg.f_result'), on: { change: function () { ui.logBlocked = selB.value; loadLog(); } } }, [el('option', { value: '', text: T('lg.all_results') }), el('option', { value: '1', text: T('lg.only_blocked'), selected: ui.logBlocked === '1' })]);
    var selS = el('select', { class: 'inp', 'aria-label': T('lg.f_scope'), on: { change: function () { ui.logScope = selS.value; loadLog(); } } }, [['', T('lg.all_reasons')], ['all', T('lg.scope_all')], ['profile', T('lg.scope_profile')]].map(function (x) { return el('option', { value: x[0], text: x[1], selected: ui.logScope === x[0] }); }));
    var selT = el('select', { class: 'inp', 'aria-label': T('lg.f_time'), on: { change: function () { ui.logDays = selT.value; loadLog(); } } }, [['1', T('lg.today')], ['7', T('lg.days7')], ['', T('lg.all_time')]].map(function (x) { return el('option', { value: x[0], text: x[1], selected: ui.logDays === x[0] }); }));
    p.appendChild(el('div', { class: 'btns' }, [el('div', { class: 'inp-ic' }, [icon('search', 's14'), search]), selD, selB, selS, selT, btn(T('lg.clear'), 'btn-ghost btn-sm', function (ev) {
      var b = ev.currentTarget;
      D.confirmDialog(T('lg.clear_title'), T('lg.clear_text'), T('lg.clear'), true).then(function (ok) { if (ok) busy(b, D.api('POST', 'admin/log/clear').then(function () { ui.log = null; return loadLog(); })); });
    })]));
    p.appendChild(el('div', { id: 'dn-log-box', class: 'dn-panel' }));
    drawLog();
    if (!ui.log) loadLog();
    var st = S.status;
    if (st.state === 'filtering' && st.pause) p.appendChild(hint(T('lg.paused', { name: st.pause.by ? st.pause.by.name : '–' })));
    if (st.state === 'fallback') p.appendChild(hint(T('lg.fallback', { time: D.clock(st.since) })));
    p.appendChild(hint(T(lg.retentionDays === 1 ? 'lg.retention_hint_one' : 'lg.retention_hint', { n: lg.retentionDays })));
  }

  // ─── Einstellungen ───

  function renderSettings() {
    var p = D.clear(panel('settings'));
    var s = S.settings;
    var f = ui.form || (ui.form = { provider: s.upstream.provider, url: s.upstream.url || '', fallbackRouter: s.upstream.fallbackRouter, who: S.config.pause.who, maxMinutes: S.config.pause.maxMinutes, forever: S.config.pause.forever, outage: S.config.notify.outage, weekly: S.config.notify.weekly, outageUsers: S.config.notify.outageUsers, blockForeignDns: s.blockForeignDns === true, homeInternet: s.homeInternet !== false });
    var on = s.enabled;
    p.appendChild(el('div', { class: 'card' }, [D.row(T(on ? 'se.on_title' : 'se.off_title'), T(on ? 'se.on_hint' : 'se.off_hint'), on
      ? btn(T('se.switch_off'), 'btn-danger btn-sm', function (ev) {
        var b = ev.currentTarget;
        D.confirmDialog(T('se.switch_off_title'), T('se.switch_off_text'), T('se.switch_off'), true).then(function (ok) { if (ok) busy(b, D.api('PUT', 'admin/settings', { enabled: false }).then(reload)); });
      })
      : btn(T(S.config.setupDone ? 'ov.switch_on' : 'ov.setup'), 'btn-primary btn-sm', function () { openWizard(); }), 'flat')]));
    var url = el('input', { class: 'inp mono', type: 'url', placeholder: 'https://dns.example.org/dns-query', value: f.url, 'aria-label': T('se.custom_url'), hidden: f.provider !== 'custom', on: { input: function () { f.url = url.value; } } });
    var prov = function (id, title, sub) {
      return el('label', { class: 'radio' }, [el('input', { type: 'radio', name: 'dn-prov', value: id, checked: f.provider === id, on: { change: function () { f.provider = id; url.hidden = id !== 'custom'; } } }), el('span', { class: 't' }, [el('b', { text: title }), el('small', { text: sub })])]);
    };
    var c1 = card('s6', T('se.forward'), 'swap', null, [hint(T('se.forward_hint'))].concat(S.catalog.providers.map(function (x) { return prov(x.id, x.label || T('se.prov_' + x.id), T('se.prov_' + x.id + '_hint')); }), [url,
      D.row(T('se.fallback'), T('se.fallback_hint'), D.sw(f.fallbackRouter, function (v) { f.fallbackRouter = v; }, T('se.fallback')), 'flat')]));
    var c4 = card('s6', T('se.notify'), 'bell', null, [el('div', { class: 'rows' }, [
      D.row(T('se.n_outage'), T('se.n_outage_hint'), D.sw(f.outage, function (v) { f.outage = v; }, T('se.n_outage'))),
      D.row(T('se.n_outage_users'), T('se.n_outage_users_hint'), D.sw(f.outageUsers, function (v) { f.outageUsers = v; }, T('se.n_outage_users'))),
      D.row(T('se.n_weekly'), T('se.n_weekly_hint'), D.sw(f.weekly, function (v) { f.weekly = v; }, T('se.n_weekly'))),
    ])]);
    var perProfile = S.settings.profiles.map(function (x) { return x.name + ': ' + T(S.config.pause.profiles[x.id] !== false ? 'se.allowed' : 'se.locked'); }).join(' · ');
    var who = function (id, title, sub) {
      return el('label', { class: 'radio' }, [el('input', { type: 'radio', name: 'dn-who', value: id, checked: f.who === id, on: { change: function () { f.who = id; } } }), el('span', { class: 't' }, [el('b', { text: title }), el('small', { text: sub })])]);
    };
    var max = el('select', { class: 'inp', id: 'dn-se-max', on: { change: function () { f.maxMinutes = Number(max.value); } } }, S.maxMinutes.map(function (m) { return el('option', { value: m, text: D.duration(m), selected: m === f.maxMinutes }); }));
    var c3 = card('s12', T('se.pause'), 'pause', null, [
      el('div', { class: 'fg' }, [el('span', { class: 'lbl', text: T('se.who') }), el('div', { class: 'radios' }, [who('admins', T('se.who_admins'), T('se.who_admins_hint')), who('all', T('se.who_all'), T('se.who_all_hint')), who('profile', T('se.who_profile'), perProfile)])]),
      grid([el('div', { class: 'fg s4' }, [el('label', { for: 'dn-se-max', text: T('se.max') }), max]),
        el('div', { class: 'fg s8' }, [el('span', { class: 'lbl', text: T('se.forever') }), D.row(T('se.forever_switch'), T('se.forever_hint'), D.sw(f.forever, function (v) { f.forever = v; }, T('se.forever_switch')), 'flat')])]),
      hint(T('se.pause_hint')),
    ]);
    // "Umgehung erschweren": foreign DNS servers and DNS over TLS — the state comes from GateControl's firewall rules
    var fd = S.status.foreignDns || { enabled: false, active: false, devices: 0, error: null };
    var fdTag = null;
    var fdNote = null;
    if (fd.enabled && fd.error) { fdTag = tag(T('se.fd_failed'), 'crit'); fdNote = D.banner('warn', 'warn', T('se.fd_error_title'), T('se.fd_error_text', { error: fd.error })); } else if (fd.enabled && fd.active) fdTag = tag(T(fd.devices === 1 ? 'se.fd_active_one' : 'se.fd_active', { n: fd.devices }), 'good');
    else if (fd.enabled) { fdTag = tag(T('se.fd_idle'), 'grey'); fdNote = hint(T(S.status.state !== 'filtering' ? 'se.fd_idle_filter' : (S.status.pause ? 'se.fd_idle_pause' : 'se.fd_idle_wait'))); }
    if (fdTag) fdTag.className += ' sp';
    var c5 = card('s6', T('se.fd_title'), 'lock', fdTag, [
      D.row(T('se.fd_switch'), T('se.fd_switch_hint'), D.sw(f.blockForeignDns, function (v) { f.blockForeignDns = v; }, T('se.fd_switch')), 'flat'),
      fdNote, hint(T('se.fd_scope')), hint(T('se.fd_doh')),
    ]);
    // "Heimnetz und Familie": the family plugin's "Internet pausieren" reaches the VPN devices; profiles shared with a home
    var shared = S.settings.profiles.filter(function (x) { return x.home; });
    var c6 = card('s6', T('se.home_title'), 'home', null, [
      D.row(T('se.hi_switch'), T('se.hi_switch_hint'), D.sw(f.homeInternet, function (v) { f.homeInternet = v; }, T('se.hi_switch')), 'flat'),
      el('div', { class: 's-sub', text: T('se.home_profiles') }),
      hint(!(S.homes || []).length ? T('se.home_none') : (shared.length
        ? T('se.home_shared', { list: shared.map(function (x) { return T('se.home_shared_item', { name: x.name, home: x.home.gatewayName }); }).join(', ') })
        : T('se.home_not_shared'))),
      (S.homes || []).length ? el('div', {}, [btn(T('se.home_open'), 'btn-sm', function () { show('profiles'); }, 'home')]) : null,
    ]);
    p.appendChild(grid([c1, c4, c5, c6, c3]));
    var save = btn(T('common.save'), 'btn-primary', function () {
      var up = { provider: f.provider, fallbackRouter: f.fallbackRouter };
      if (f.provider === 'custom') up.url = f.url.trim();
      busy(save, D.api('PUT', 'admin/settings', { upstream: up, blockForeignDns: f.blockForeignDns, homeInternet: f.homeInternet }).then(function (r) {
        merge(r);
        return D.api('PUT', 'admin/config', { pause: { who: f.who, maxMinutes: f.maxMinutes, forever: f.forever }, notify: { outage: f.outage, outageUsers: f.outageUsers, weekly: f.weekly } });
      }).then(function (r) { merge(r); ui.form = null; D.toast(T('common.saved')); render(); return refresh(); }));
    });
    p.appendChild(el('div', { class: 'dn-savebar' }, [btn(T('common.discard'), 'btn-ghost', function () { ui.form = null; renderSettings(); }), save]));
  }

  // ─── Einrichten / Umzug von Pi-hole ───

  /** Where the VPN devices reach Pi-hole today (status().pihole.targets): one sentence per instance. */
  function piholeWhere() {
    return ((S.status.pihole && S.status.pihole.targets) || []).map(function (x) {
      var addr = x.ip + (x.port && x.port !== 53 ? ':' + x.port : '');
      var name = x.name ? ' ' + quoted(x.name) : '';
      if (x.gateway && x.gateway.via === 'tunnel') return T('wz.pihole_on_gateway', { name: name, gateway: x.gateway.name, addr: addr });
      if (x.gateway) return T('wz.pihole_via_gateway', { name: name, gateway: x.gateway.name, addr: addr });
      return T('wz.pihole_at', { name: name, addr: addr });
    });
  }
  function openWizard(resume) {
    if (ui.wizard) return;
    ui.wizard = true;
    var pihole = !!(S.status.pihole && S.status.pihole.wantsChain);
    var step = resume ? 3 : 1;
    var lists = S.settings.enabled || S.config.setupDone ? S.settings.profiles[0].lists.slice() : S.catalog.lists.filter(function (l) { return l.defaultOn || (pihole && l.id === 'ads_stevenblack'); }).map(function (l) { return l.id; });
    var allowText = '';
    var timer = null;
    var started = Date.now();
    var failed = null;
    var failedText = null;
    var done = null;
    var m = D.modal({ title: T('wz.title'), body: [], foot: [], onClose: function () { ui.wizard = false; clearTimeout(timer); if (step < 3 && !S.config.setupDone) D.api('POST', 'admin/setup/later').then(merge).catch(function () {}); reload().catch(function () {}); } });
    var names = [T(pihole ? 'wz.s1' : 'wz.s1_new'), T('wz.s2'), T(pihole ? 'wz.s3' : 'wz.s3_new'), T('wz.s4')];
    function steps() { return el('div', { class: 'steps' }, names.map(function (n, i) { return el('span', { class: i + 1 === step ? 'on' : (i + 1 < step ? 'done' : ''), text: (i + 1) + ' ' + n }); })); }
    function check(cls, title, sub) { return el('li', { class: cls }, [el('span', { class: 'ic' }, [icon(cls === 'fail' ? 'x' : 'check', 's12')]), el('div', {}, [title, sub ? el('small', { text: sub }) : null])]); }
    function set(body, foot) { D.clear(m.body); body.forEach(function (x) { if (x) m.body.appendChild(x); }); D.clear(m.foot); foot.forEach(function (x) { if (x) m.foot.appendChild(x); }); }
    function draw() {
      if (step === 1) {
        set([steps(),
          pihole ? D.banner('warn', 'info', T('wz.pihole_title'), [T('wz.pihole_text')].concat(piholeWhere()).join(' ')) : D.banner('info', 'shield', T('wz.welcome_title'), T('wz.welcome_text')),
          el('ul', { class: 'checks' }, [check('', T('wz.c1'), T('wz.c1_sub')), check('', T('wz.c2'), T('wz.c2_sub')), check('', T(pihole ? 'wz.c3' : 'wz.c3_new'), T(pihole ? 'wz.c3_sub' : 'wz.c3_new_sub'))]),
        ], [btn(T('wz.later'), 'btn-ghost', function () { m.close(); }), btn(T(pihole ? 'wz.replace' : 'wz.next'), 'btn-primary', function () { step = 2; draw(); })]);
      } else if (step === 2) {
        var area = el('textarea', { class: 'inp mono', id: 'dn-wz-allow', rows: '4', spellcheck: 'false', on: { input: function () { allowText = area.value; count.textContent = T('wz.allow_count', { n: splitDomains(allowText).length }); } } });
        area.value = allowText;
        var count = el('span', { class: 's-hint', text: T('wz.allow_count', { n: splitDomains(allowText).length }) });
        set([steps(), hint(T(pihole ? 'wz.lists_hint' : 'wz.lists_hint_new')),
          el('div', { class: 'fg' }, S.catalog.lists.map(function (l) {
            return el('label', { class: 'chk' }, [el('input', { type: 'checkbox', checked: lists.indexOf(l.id) >= 0, on: { change: function (ev) { lists = lists.filter(function (x) { return x !== l.id; }); if (ev.target.checked) lists.push(l.id); } } }),
              el('span', { text: D.listName(l.id) }), el('small', { text: T('li.about') + ' ' + D.num(l.entries) + (pihole && l.id === 'ads_stevenblack' ? ' · ' + T('wz.pihole_default') : '') })]);
          })),
          pihole ? el('div', { class: 'fg' }, [el('label', { for: 'dn-wz-allow', text: T('wz.allow_label') }), area, el('span', { class: 's-hint', text: T('wz.allow_hint') }), count]) : null,
        ], [btn(T('wz.back'), 'btn-ghost', function () { step = 1; draw(); }), el('span', { class: 'g' }), btn(T('wz.next'), 'btn-primary', function (ev) {
          busy(ev.currentTarget, D.api('POST', 'admin/setup/start', { lists: lists, allow: splitDomains(allowText) }).then(function (r) { merge(r); step = 3; started = Date.now(); failed = null; failedText = null; done = null; draw(); poll(); return refresh(); }));
        })]);
      } else if (step === 3) {
        var st = (done && done.status) || S.status;
        var ls = (done && done.lists) || S.lists;
        var loaded = ls.lists.filter(function (l) { return l.used && l.loaded; });
        var ready = !!(st.service && st.service.ready) || st.state === 'filtering';
        var probe = done && done.probe;
        var filtering = st.state === 'filtering';
        var word = function (x) { return T(x.action === 'block' ? 'wz.word_blocked' : 'wz.word_allowed'); };
        var c1 = check(ready ? '' : (failed ? 'fail' : 'wait'), T('wz.k_lists'), ready ? T('wz.k_lists_sub', { n: D.num(loaded.reduce(function (n, l) { return n + l.entries; }, 0)), lists: loaded.length, size: D.bytes(ls.memoryBytes) }) : null);
        var c2 = check(probe ? '' : (ready && !failed ? 'wait' : (failed ? 'fail' : 'todo')), T('wz.k_answers'), probe ? T('wz.k_answers_sub', { a: probe.block.domain, aw: word(probe.block), b: probe.allow.domain, bw: word(probe.allow), ms: probe.ms }) : null);
        var c3 = check(filtering ? '' : (failed ? 'fail' : (ready ? 'wait' : 'todo')), T(pihole ? 'wz.k_switch' : 'wz.k_switch_new'), T(pihole ? 'wz.k_switch_sub' : 'wz.k_switch_new_sub'));
        var c4 = check(filtering && probe ? 'wait' : 'todo', T('wz.k_verify'));
        set([steps(), el('ul', { class: 'checks' }, [c1, c2, c3, c4]),
          failed ? D.banner('crit', 'warn', T('wz.failed_title'), failedText || T(pihole ? 'wz.failed_' + failed + '_pihole' : 'wz.failed_' + failed), null, 'alert') : hint(T(pihole ? 'wz.switch_hint' : 'wz.switch_hint_new'))],
        [failed ? btn(T('wz.back'), 'btn-ghost', function (ev) { busy(ev.currentTarget, D.api('POST', 'admin/setup/cancel').then(function (r) { merge(r); step = 2; draw(); })); }) : el('button', { type: 'button', class: 'btn btn-ghost', disabled: true, text: T('wz.back') }),
          el('span', { class: 'g' }),
          failed ? btn(T('wz.retry'), 'btn-primary', function () { failed = null; failedText = null; started = Date.now(); draw(); poll(); }) : el('button', { type: 'button', class: 'btn btn-primary', disabled: true, text: T('wz.switching') })]);
      } else {
        var s4 = S.status;
        set([steps(),
          el('div', { class: 'bigok' }, [el('span', { class: 'ring' }, [icon('shield', 's22')]), el('div', {}, [el('b', { text: T('wz.done_title') }), el('span', { text: T('wz.done_sub', { devices: s4.peers.filtered, lists: s4.lists.length, time: D.clock(s4.since) }) })])]),
          pihole ? D.banner('', 'info', T('wz.done_pihole_title'), T('wz.done_pihole_text')) : null,
          hint(T(pihole ? 'wz.done_back_pihole' : 'wz.done_back')),
        ], [btn(T('wz.profiles'), '', function () { m.close(); show('profiles'); }), el('span', { class: 'g' }), btn(T('wz.overview'), 'btn-primary', function () { m.close(); show('overview'); })]);
      }
    }
    function poll() {
      clearTimeout(timer);
      if (!ui.wizard || step !== 3) return;
      D.api('GET', 'admin/setup/state').then(function (r) {
        done = r;
        merge(r);
        if (r.status.state === 'filtering' && r.probe) {
          return D.api('POST', 'admin/setup/finish').then(function (x) { merge(x); step = 4; draw(); return refresh(); });
        }
        if (r.status.blockedBy) failed = 'nodns';
        else if (r.status.state === 'fallback') failed = 'fallback';
        else if (Date.now() - started > 90000) failed = 'timeout';
        draw();
        if (!failed) timer = setTimeout(poll, 1500);
      }).catch(function (e) { failed = 'timeout'; failedText = D.errText(e); draw(); });
    }
    draw();
    if (resume) poll();
  }

  // ─── Rahmen ───

  var RENDER = { overview: renderOverview, lists: renderLists, profiles: renderProfiles, devices: renderDevices, log: renderLog, settings: renderSettings };
  function render() {
    if (!S) return;
    $('#dn-loading').hidden = true;
    TABS.forEach(function (id) { panel(id).hidden = id !== tab; $('#dn-t-' + id).setAttribute('aria-selected', id === tab ? 'true' : 'false'); });
    var count = $('#dn-t-devices i') || $('#dn-t-devices').appendChild(el('i'));
    count.textContent = String(S.devices.filter(function (d) { return d.type === 'peer'; }).length);
    // never redraw a tab somebody is typing in
    var a = document.activeElement;
    if (a && panel(tab).contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'radio' && a.type !== 'checkbox') return;
    RENDER[tab]();
  }
  function show(id) {
    if (TABS.indexOf(id) < 0) return;
    tab = id;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    render();
  }
  $('#dn-tabs').addEventListener('click', function (ev) { var b = ev.target.closest('button[data-tab]'); if (b) show(b.getAttribute('data-tab')); });
  setInterval(function () {
    var nodes = document.querySelectorAll('.cd[data-until]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = D.countdown(nodes[i].getAttribute('data-until'));
  }, 1000);
  setInterval(function () { if (S && !ui.wizard && !document.hidden) refresh().catch(function () {}); }, 10000);
  D.api('GET', 'admin/all').then(function (r) {
    S = r;
    render();
    // the first visit: the set-up dialog (also the move from Pi-hole)
    // (switched on but never finished — the page was closed while switching over: carry on with the checks)
    if (!S.config.setupDone && !S.status.blockedBy) openWizard(S.settings.enabled);
  }).catch(function (e) {
    var l = $('#dn-loading');
    l.textContent = D.errText(e);
    l.className = 'banner crit';
  });
})();
