/* Mail (gatecontrol-mail) — the admin pages (mockup AdminEinstellungen):
 *
 *   overview  accounts by state, people, storage used
 *   settings  who may use Mail (everybody, or people and groups — GateControl's picker GC.pickPrincipals), accounts per
 *             person, storage (retention, attachments, quota per person, what is used — in all and per person), AI (bar,
 *             sorting, filing on its own, blocked for business accounts), Microsoft (the app registration: GateControl's or
 *             an own client id, the consent link for a company's Microsoft administrator)
 *
 * The admin API (admin/…) through GC.call; every change is saved at once. Numbers only — never anybody's mail.
 */
(function () {
  'use strict';

  var CTX = window.MA_CTX || { texts: {}, lang: 'de', page: 'overview' };
  var $ = function (id) { return document.getElementById(id); };
  function T(k, p) {
    var s = CTX.texts && CTX.texts[k] != null ? String(CTX.texts[k]) : k;
    if (p) Object.keys(p).forEach(function (x) { s = s.split('{{' + x + '}}').join(String(p[x])); });
    return s;
  }
  function h(tag, o, kids) {
    var n = document.createElement(tag);
    var opts = o || {};
    Object.keys(opts).forEach(function (k) {
      var v = opts[k];
      if (v === undefined || v === null) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = String(v);
      else if (k === 'attrs') Object.keys(v).forEach(function (a) { if (v[a] != null && v[a] !== false) n.setAttribute(a, v[a] === true ? '' : String(v[a])); });
      else if (k === 'on') Object.keys(v).forEach(function (e) { n.addEventListener(e, v[e]); });
      else if (k === 'style') n.setAttribute('style', v);
      else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'hidden') n[k] = !!v;
      else if (k === 'value' || k === 'type' || k === 'placeholder') n[k] = v;
      else n.setAttribute(k, String(v));
    });
    (Array.isArray(kids) ? kids : kids == null ? [] : [kids]).forEach(function (c) {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  var toastTimer = null;
  function toast(text, kind) {
    var t = $('mp-toast');
    t.textContent = text;
    t.className = 'dp-toast' + (kind === 'error' ? ' is-error' : '');
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3000);
  }
  function api(method, path, body) {
    return window.GC.call(method, path, body).catch(function (e) {
      var er = e && e.data && e.data.error;
      var err = new Error((er && er.code) || 'failed');
      err.code = (er && er.code) || 'failed';
      throw err;
    });
  }
  function errText(e) { var k = 'err.' + ((e && e.code) || 'failed'); return CTX.texts[k] ? T(k) : T('a.err_generic', { code: (e && e.code) || '' }); }
  function fmtGB(b) {
    var n = (Number(b) || 0) / 1073741824;
    return (n < 10 ? n.toFixed(1) : String(Math.round(n))).replace('.', CTX.lang === 'en' ? '.' : ',') + ' GB';
  }
  function copyText(text) {
    var ta = h('textarea', { style: 'position:fixed;left:-9999px' });
    ta.value = text;
    document.body.appendChild(ta);
    var ok = false;
    try { ta.select(); ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    toast(ok ? T('a.copied') : T('a.copy_failed'), ok ? null : 'error');
  }

  var V = null;

  function row(title, desc, control) {
    return h('div', { class: 'ma-row' }, [h('div', { class: 'ma-lbl' }, [h('span', { class: 'ma-t', text: title }), desc ? h('span', { class: 'ma-d', text: desc }) : null]), control]);
  }
  function select(value, options, onChange) {
    var s = h('select', { class: 'dp-input' }, options.map(function (o) { return h('option', { value: String(o[0]), selected: String(o[0]) === String(value), text: o[1] }); }));
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }
  function sw(on, onChange) {
    var c = h('input', { type: 'checkbox', class: 'dp-sw', checked: on });
    c.addEventListener('change', function () { onChange(c.checked); });
    return c;
  }
  function put(part) {
    return api('PUT', 'admin/settings', part).then(function (r) { V = r; toast(T('a.saved')); render(); }, function (e) { toast(errText(e), 'error'); render(); });
  }

  function settingsPage() {
    var s = V.settings;
    var page = $('ma-page');
    clear(page);
    page.appendChild(h('div', { class: 'ma-d', text: T('a.version', { version: V.version }) }));
    // who may use Mail
    var who = h('div', { class: 'ma-chips' }, s.allowed.all ? h('span', { class: 'ma-chip', text: T('a.everybody') }) : s.allowed.principals.map(function (p) {
      return h('span', { class: 'ma-chip', text: p.label || (p.type + ' ' + p.id) });
    }));
    var pick = h('button', { type: 'button', class: 'dp-btn dp-btn-sm', text: T('a.choose'), on: { click: function () {
      if (!window.GC.pickPrincipals) { toast(T('a.no_picker'), 'error'); return; }
      window.GC.pickPrincipals({ groups: true, users: true, multiple: true, title: T('a.who_title') }).then(function (list) {
        if (!list) return;
        put({ allowed: { all: false, principals: list.map(function (p) { return { type: p.type, id: p.id, label: p.label }; }) } });
      });
    } } });
    page.appendChild(h('div', { class: 'ma-card' }, [h('h2', { text: T('a.who_title') }),
      row(T('a.allowed'), T('a.allowed_d'), h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, [
        select(s.allowed.all ? 'all' : 'some', [['all', T('a.everybody')], ['some', T('a.chosen')]], function (v) { put({ allowed: { all: v === 'all', principals: s.allowed.principals } }); }), s.allowed.all ? null : pick])),
      s.allowed.all ? null : who,
      row(T('a.accounts_max'), null, select(s.accountsMax, [1, 2, 3, 4, 5, 6, 8, 10, 15, 20].map(function (n) { return [n, T('a.up_to', { n: n })]; }), function (v) { put({ accountsMax: Number(v) }); })),
    ]));
    // the licence and its people (since 1.1.0, like Drive)
    if (V.seats) page.appendChild(seatsCard(V.seats));
    // storage
    var u = V.usage;
    var total = u.quotaBytes * Math.max(1, u.people.length);
    var used = h('div', { style: 'display:flex;flex-direction:column;gap:6px;flex:1 1 100%' }, [
      h('span', { class: 'ma-d', text: T('a.used', { used: fmtGB(u.bytes), total: fmtGB(total), n: u.people.length }) }),
      h('div', { class: 'ma-bar' }, h('span', { style: 'width:' + Math.min(100, Math.round(u.bytes / Math.max(1, total) * 100)) + '%' })),
    ]);
    var table = u.people.length ? h('table', { class: 'ma-table' }, [h('tr', null, [h('th', { text: T('a.person') }), h('th', { class: 'ma-num', text: T('a.accounts') }), h('th', { class: 'ma-num', text: T('a.storage') })])]
      .concat(u.people.map(function (p) { return h('tr', null, [h('td', { text: p.name }), h('td', { class: 'ma-num', text: String(p.accounts) }), h('td', { class: 'ma-num', text: fmtGB(p.bytes) + ' / ' + fmtGB(u.quotaBytes) })]); }))) : null;
    page.appendChild(h('div', { class: 'ma-card' }, [h('h2', { text: T('a.storage_title') }),
      row(T('a.retention'), T('a.retention_d'), select(s.retentionMonths, [[1, T('a.months', { n: 1 })], [3, T('a.months', { n: 3 })], [6, T('a.months', { n: 6 })], [12, T('a.months', { n: 12 })], [24, T('a.months', { n: 24 })], [0, T('a.all_mail')]], function (v) { put({ retentionMonths: Number(v) }); })),
      row(T('a.attachments'), null, select(s.attachments, [['on_demand', T('a.on_demand')], ['always', T('a.always')]], function (v) { put({ attachments: v }); })),
      row(T('a.quota'), null, select(s.quotaGB, [1, 2, 5, 10, 20, 50, 100].map(function (n) { return [n, T('a.gb', { n: n })]; }), function (v) { put({ quotaGB: Number(v) }); })),
      used, table,
    ]));
    // AI
    var aiRow = function (k, title, desc) { return row(title, desc, sw(s.ai[k], function (on) { var o = {}; o[k] = on; put({ ai: o }); })); };
    page.appendChild(h('div', { class: 'ma-card' }, [h('h2', { text: T('a.ai_title') }),
      V.ai.ready ? null : h('p', { class: 'ma-d', text: T('a.ai_not_ready') }),
      aiRow('bar', T('a.ai_bar'), null), aiRow('sort', T('a.ai_sort'), null), aiRow('autoFile', T('a.ai_autofile'), T('a.ai_autofile_d')), aiRow('blockBusiness', T('a.ai_block'), T('a.ai_block_d'))]));
    // Microsoft
    var ms = V.microsoft;
    var custom = h('input', { class: 'dp-input', type: 'text', value: s.microsoft.customClientId || '', placeholder: '00000000-0000-0000-0000-000000000000', style: 'max-width:340px' });
    custom.addEventListener('change', function () { put({ microsoft: { customClientId: custom.value.trim() || null } }); });
    page.appendChild(h('div', { class: 'ma-card' }, [h('h2', { text: T('a.ms_title') }),
      row(T('a.ms_registration'), ms.defaultClientId ? null : T('a.ms_no_default'), select(s.microsoft.registration, [['default', T('a.ms_default')], ['custom', T('a.ms_custom')]], function (v) { put({ microsoft: { registration: v } }); })),
      s.microsoft.registration === 'custom' ? row(T('a.ms_client_id'), T('a.ms_client_id_d'), custom) : null,
      ms.consentUrl ? row(T('a.ms_consent'), T('a.ms_consent_d'), h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, [h('span', { class: 'ma-mono', text: ms.consentUrl }),
        h('button', { type: 'button', class: 'dp-btn dp-btn-sm', text: T('a.copy'), on: { click: function () { copyText(ms.consentUrl); } } })])) : row(T('a.ms_state'), null, h('span', { class: 'ma-d', text: T('a.ms_off') })),
      row(T('a.ms_state'), null, h('span', { class: 'ma-d', text: T('a.ms_accounts', { n: ms.accounts }) })),
    ]));
  }

  /** "x of y people" of a seats summary (null limits: no number). */
  function seatsLine(x) {
    var c = x.counts || { total: 0 }; var l = x.limits || {};
    return l.total == null ? T('a.people_unlimited', { n: c.total }) : T('a.people_of', { n: c.total, total: l.total });
  }

  /** The card "Personen und Lizenz": tier, x of y, exceeded / full, "Lizenz jetzt abrufen", every person with their place. */
  function seatsCard(x) {
    var l = x.licence || {}; var lim = x.limits || {}; var c = x.counts || {};
    var kinds = lim.kinds || [];
    var head = [h('span', { class: 'ma-chip', text: T('a.licence') + (l.tier ? ' · ' + T('a.tier_' + l.tier) : '') }), h('span', { class: 'ma-d', text: seatsLine(x) })];
    if (x.exceeded) head.push(h('span', { class: 'ma-chip ma-warn', text: T('a.exceeded') }));
    var full = lim.total != null && !x.exceeded && kinds.every(function (k) { return (lim[k] != null && c[k] >= lim[k]) || (lim.total != null && c.total >= lim.total); });
    var notes = [];
    if (!l.valid) notes.push(h('p', { class: 'dp-err', text: T('a.licence_invalid') }));
    else if (!l.tier) notes.push(h('p', { class: 'ma-d', text: T('a.no_tier_text') }));
    else {
      if (l.tier === 'combo') notes.push(h('p', { class: 'ma-d', text: T('a.people_kinds', { family: c.family, familyMax: lim.family, business: c.business, businessMax: lim.business }) }));
      if (x.exceeded) notes.push(h('p', { class: 'dp-err', text: T('a.exceeded_text') }));
      else if (full) notes.push(h('p', { class: 'dp-err', text: T('a.full_text') }));
      notes.push(h('p', { class: 'ma-d', text: T('a.book_text') }));
    }
    var refresh = h('button', { type: 'button', class: 'dp-btn dp-btn-sm', text: T('a.refresh'), on: { click: function () {
      api('POST', 'admin/license/refresh').then(function (r) { V.seats = r.seats; toast(r.refreshed ? T('a.refreshed') : T('a.refresh_later')); render(); }, function (e) { toast(errText(e), 'error'); });
    } } });
    var rows = (x.people || []).map(function (p) {
      var cell;
      if (!p.allowed) cell = h('span', { class: 'ma-d', text: T('a.seat_not_allowed') });
      else {
        var opts = [h('option', { value: '', text: p.seat ? T('a.seat_none') : T('a.seat_unused'), selected: !p.seat || p.seat === 'none' })].concat(['family', 'business'].map(function (k) {
          return h('option', { value: k, text: T('a.seat_' + k), selected: p.seat === k, disabled: kinds.indexOf(k) < 0 && p.seat !== k });
        }));
        cell = h('select', { class: 'dp-input', attrs: { 'aria-label': T('a.seat_for', { name: p.name || '' }) } }, opts);
        cell.addEventListener('change', function () {
          var v = cell.value;
          api('PUT', 'admin/seats/' + p.userId, { kind: v || null }).then(function (r) { V.seats = r.seats; toast(v ? T('a.seat_on', { name: p.name || '' }) : T('a.seat_off', { name: p.name || '' })); render(); },
            function (e) { toast(errText(e), 'error'); render(); });
        });
      }
      return h('tr', null, [h('td', { text: p.name || String(p.userId) }), h('td', null, cell)]);
    });
    return h('div', { class: 'ma-card', attrs: { 'aria-label': T('a.seats_title') } }, [h('h2', { text: T('a.seats_title') }),
      h('div', { class: 'ma-chips', style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, head.concat([refresh]))].concat(notes).concat([
      h('p', { class: 'ma-d', text: T('a.seats_text') }),
      rows.length ? h('table', { class: 'ma-table' }, [h('tr', null, [h('th', { text: T('a.person') }), h('th', { text: T('a.col_seat') })])].concat(rows)) : null,
    ]));
  }

  function overviewPage(o) {
    var page = $('ma-page');
    clear(page);
    var stat = function (n, label) { return h('div', { class: 'ma-stat' }, [h('span', { class: 'ma-big', text: String(n) }), h('span', { class: 'ma-d', text: label })]); };
    page.appendChild(h('div', { class: 'ma-card' }, [h('h2', { text: T('a.overview') }), h('div', { class: 'ma-stats' }, [
      stat(o.people, T('a.people')), stat(o.accounts, T('a.accounts')), stat(o.byState.ok, T('a.state_ok')), stat(o.byState.auth_failed, T('a.state_auth_failed')),
      stat(o.byState.unreachable, T('a.state_unreachable')), stat(fmtGB(o.bytes), T('a.storage')),
    ])]));
    if (o.seats) {
      var x = o.seats; var l = x.licence || {};
      page.appendChild(h('div', { class: 'ma-card' }, [h('h2', { text: T('a.licence') + (l.tier ? ' · ' + T('a.tier_' + l.tier) : '') }),
        h('p', { class: x.exceeded || !l.valid ? 'dp-err' : 'ma-d', text: !l.valid ? T('a.licence_invalid') : seatsLine(x) + (x.exceeded ? ' · ' + T('a.exceeded') : '') })]));
    }
    page.appendChild(h('p', { class: 'ma-d', text: T('a.privacy') }));
  }

  function render() {
    if (CTX.page === 'settings') { if (V) settingsPage(); return; }
  }

  function boot() {
    var page = $('ma-page');
    page.appendChild(h('p', { class: 'ma-d', text: T('a.loading') }));
    if (CTX.page === 'settings') api('GET', 'admin/settings').then(function (r) { V = r; render(); }, function (e) { clear(page); page.appendChild(h('p', { class: 'dp-err', text: errText(e) })); });
    else api('GET', 'admin/overview').then(overviewPage, function (e) { clear(page); page.appendChild(h('p', { class: 'dp-err', text: errText(e) })); });
  }

  boot();
})();
