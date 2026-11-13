/* Mail (gatecontrol-mail) — the admin pages (mockups AdminEinstellungen, AdminRessourcen):
 *
 *   overview  accounts by state, people, storage used
 *   resources since 1.9.0 (ui.settingsPages: a tab under Einstellungen › Plugins › Mail; before GateControl 1.225.0 a tab of
 *             the plugin's page): the list of resources and one in the editor — name, kind,
 *             place, seats, equipment, who may book (everybody or people and groups — GC.pickPrincipals), the answer
 *             (automatic or after approval by people and groups), the rules (longest booking, days ahead, bookable
 *             times), what happened (the log, overrides included); „Skoda“ and „Microsoft 365“ only as „kommt später“
 *   settings  who may use Mail (everybody, or people and groups — GateControl's picker GC.pickPrincipals), accounts per
 *             person, storage (retention, attachments, quota per person, since 1.5.0 where the attachments lie — a note
 *             pointing to GateControl's „Speicherorte“ —, what is used — in all and per person), AI (bar,
 *             sorting, filing on its own, blocked for business accounts), Microsoft (the app registration: GateControl's or
 *             an own client id, the consent link for a company's Microsoft administrator, since 1.3.0 the rights the app
 *             registration needs for calendars and contacts); since 1.3.0 Kalender (on/off, the accounts' calendars, the
 *             business calendar, the default reminder, internal invitations, what is shown alongside) and Kontakte (on/off,
 *             the accounts' address books, the AI for the signature); calendars, events and contacts in numbers
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
  function fmtSize(b) {
    var n = Number(b) || 0;
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0).replace('.', CTX.lang === 'en' ? '.' : ',') + ' MB';
    return fmtGB(n);
  }
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

  /**
   * Since 1.5.0: where the attachments lie (GateControl's media area) — only a note: the place is chosen in GateControl
   * (Einstellungen › Plugins › Mail › Übersicht › Speicherorte), storage targets under Einstellungen › Plugins › Speicher.
   */
  function placeRow(st) {
    if (!st) return null;
    var where = st.target && st.target.kind !== 'server' ? (st.target.label || st.target.kind) : T('a.place_server');
    var state = st.paused ? T('a.place_full') : st.state === 'unreachable' ? T('a.place_unreachable') : st.state === 'moving' ? T('a.place_moving')
      : st.state === 'pending' ? T('a.place_pending') : null;
    return row(T('a.place'), T('a.place_d'), h('div', { class: 'ma-place' }, [h('span', { class: 'ma-chip', text: where }),
      state ? h('span', { class: 'ma-d' + (st.state === 'unreachable' || st.paused ? ' is-warn' : ''), text: state }) : null]));
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
    // since 1.3.0: calendars, events and contacts per person (numbers only), what of the storage they take
    var pimCols = u.people.some(function (p) { return p.calendars != null; });
    var num = function (n) { return h('td', { class: 'ma-num', text: String(n || 0) }); };
    var table = u.people.length ? h('table', { class: 'ma-table' }, [h('tr', null, [h('th', { text: T('a.person') }), h('th', { class: 'ma-num', text: T('a.accounts') }),
      pimCols ? h('th', { class: 'ma-num', text: T('a.calendars') }) : null, pimCols ? h('th', { class: 'ma-num', text: T('a.events') }) : null, pimCols ? h('th', { class: 'ma-num', text: T('a.contacts') }) : null,
      h('th', { class: 'ma-num', text: T('a.storage') })])]
      .concat(u.people.map(function (p) {
        return h('tr', null, [h('td', { text: p.name }), num(p.accounts), pimCols ? num(p.calendars) : null, pimCols ? num(p.events) : null, pimCols ? num(p.contacts) : null,
          h('td', { class: 'ma-num' }, [fmtGB(p.bytes) + ' / ' + fmtGB(u.quotaBytes), p.pimBytes ? h('div', { class: 'ma-d', text: T('a.pim_part', { size: fmtSize(p.pimBytes) }) }) : null])]);
      }))) : null;
    page.appendChild(h('div', { class: 'ma-card' }, [h('h2', { text: T('a.storage_title') }),
      row(T('a.retention'), T('a.retention_d'), select(s.retentionMonths, [[1, T('a.months', { n: 1 })], [3, T('a.months', { n: 3 })], [6, T('a.months', { n: 6 })], [12, T('a.months', { n: 12 })], [24, T('a.months', { n: 24 })], [0, T('a.all_mail')]], function (v) { put({ retentionMonths: Number(v) }); })),
      row(T('a.attachments'), null, select(s.attachments, [['on_demand', T('a.on_demand')], ['always', T('a.always')]], function (v) { put({ attachments: v }); })),
      row(T('a.quota'), null, select(s.quotaGB, [1, 2, 5, 10, 20, 50, 100].map(function (n) { return [n, T('a.gb', { n: n })]; }), function (v) { put({ quotaGB: Number(v) }); })),
      placeRow(V.storage),
      used, table,
    ]));
    // since 1.3.0: Kalender and Kontakte (C9)
    page.appendChild(calendarCard(s.calendar || {}));
    page.appendChild(resourcesCard(s.resources || {}));
    page.appendChild(contactsCard(s.contacts || {}));
    // since 1.14.0: the full-text search (an option, off unless switched on)
    page.appendChild(searchCard(s.search || {}, V.search || {}));
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
      row(T('a.ms_connected'), null, h('span', { class: 'ma-d', text: T('a.ms_accounts', { n: ms.accounts }) })),
      // since 1.3.0: what the app registration needs besides the mail (Calendars.ReadWrite, Contacts.ReadWrite)
      (ms.registrationNeeds || []).length ? row(T('a.ms_needs'), T('a.ms_needs_d', { list: ms.registrationNeeds.join(T('a.and')) }),
        h('div', { class: 'ma-chips' }, ms.registrationNeeds.map(function (x) { return h('span', { class: 'ma-chip ma-mono', text: x }); }))) : null,
    ]));
  }

  var REMINDERS = [null, 0, 5, 10, 15, 30, 60, 1440];
  function reminderLabel(m) {
    if (m == null) return T('a.rem_none');
    if (m === 0) return T('a.rem_at');
    if (m === 1440) return T('a.rem_day');
    if (m === 60) return T('a.rem_hour');
    return T('a.rem_min', { n: m });
  }

  /** The card „Kalender“ (C9): on/off, the accounts' calendars, the business calendar, the default reminder, internal invitations, overlays. */
  function calendarCard(c) {
    var set = function (part) { put({ calendar: part }); };
    var on = c.enabled !== false;
    var ov = c.overlays || {};
    var ovRow = function (k) { return row(T('a.cal_ov_' + k), null, sw(ov[k] !== false, function (x) { var o = {}; o[k] = x; set({ overlays: o }); })); };
    return h('div', { class: 'ma-card' }, [h('h2', { text: T('a.cal_title') }),
      row(T('a.cal_enabled'), T('a.cal_enabled_d'), sw(on, function (x) { set({ enabled: x }); })),
      on ? row(T('a.cal_accounts'), T('a.cal_accounts_d'), sw(c.accounts !== false, function (x) { set({ accounts: x }); })) : null,
      on ? row(T('a.cal_business'), T('a.cal_business_d'), select(c.business || 'gatecontrol', [['gatecontrol', T('a.cal_business_gatecontrol')], ['exchange', T('a.cal_business_exchange')]], function (v) { set({ business: v }); })) : null,
      on ? row(T('a.cal_reminder'), T('a.cal_reminder_d'), select(c.defaultReminder == null ? 'none' : c.defaultReminder, REMINDERS.map(function (m) { return [m == null ? 'none' : m, reminderLabel(m)]; }),
        function (v) { set({ defaultReminder: v === 'none' ? null : Number(v) }); })) : null,
      on ? row(T('a.cal_internal'), T('a.cal_internal_d'), sw(c.internalInvites !== false, function (x) { set({ internalInvites: x }); })) : null,
      // since 1.9.0: free/busy within GateControl (each person may switch theirs off) and sharing own calendars
      on ? row(T('a.cal_freebusy'), T('a.cal_freebusy_d'), sw(c.freeBusy !== false, function (x) { set({ freeBusy: x }); })) : null,
      on ? row(T('a.cal_sharing'), T('a.cal_sharing_d'), sw(c.sharing !== false, function (x) { set({ sharing: x }); })) : null,
      on ? h('div', { class: 'ma-d', style: 'padding-top:6px', text: T('a.cal_overlays') }) : null,
      on ? ovRow('familie') : null, on ? ovRow('alltag') : null, on ? ovRow('birthdays') : null,
    ]);
  }

  /**
   * Since 1.9.0 the card „Ressourcen“: on/off and the way to the tab „Ressourcen“ (GC.navigate) — on GateControl ≥ 1.225.0
   * a tab of its own under Einstellungen › Plugins › Mail (ui.settingsPages), before that on Mail's page beside „Übersicht“.
   */
  function resourcesCard(r) {
    var on = r.enabled !== false;
    var go = window.GC && typeof window.GC.navigate === 'function' ? h('button', { type: 'button', class: 'dp-btn dp-btn-sm', text: T('a.res_manage'), on: { click: function () { window.GC.navigate('resources'); } } }) : null;
    return h('div', { class: 'ma-card' }, [h('h2', { text: T('a.res_title') }),
      row(T('a.res_enabled'), T('a.res_enabled_d'), sw(on, function (x) { put({ resources: { enabled: x } }); })),
      on ? row(T('a.res_where'), T('a.res_where_d'), go || h('span', { class: 'ma-d', text: T('a.res_where_tab') })) : null,
    ]);
  }

  /**
   * Since 1.14.0 the card „Suche“: the full-text search on/off, what it costs, and its state — off, being built (how
   * many mails are left), ready, being removed — with the size of the database file and its free room.
   */
  function searchCard(c, v) {
    var on = c.fulltext === true;
    var state = v.state === 'building' ? T('a.fts_building', { n: v.pending || 0 }) : v.state === 'ready' ? T('a.fts_ready') : v.state === 'removing' ? T('a.fts_removing')
      : v.state === 'unavailable' ? T('a.fts_unavailable') : T('a.fts_off');
    var db = v.db ? T('a.fts_db', { size: fmtSize(v.db.bytes), free: fmtSize(v.db.freeBytes) }) : null;
    return h('div', { class: 'ma-card' }, [h('h2', { text: T('a.fts_title') }),
      row(T('a.fts_enabled'), T('a.fts_enabled_d'), sw(on, function (x) { put({ search: { fulltext: x } }); })),
      row(T('a.fts_state'), db, h('span', { class: 'ma-d', text: state })),
    ]);
  }

  /** The card „Kontakte“ (C9): on/off, the accounts' address books, the AI for the signature. */
  function contactsCard(c) {
    var set = function (part) { put({ contacts: part }); };
    var on = c.enabled !== false;
    return h('div', { class: 'ma-card' }, [h('h2', { text: T('a.con_title') }),
      row(T('a.con_enabled'), T('a.con_enabled_d'), sw(on, function (x) { set({ enabled: x }); })),
      on ? row(T('a.con_accounts'), T('a.con_accounts_d'), sw(c.accounts !== false, function (x) { set({ accounts: x }); })) : null,
      on ? row(T('a.con_ai'), T('a.con_ai_d'), sw(c.ai !== false, function (x) { set({ ai: x }); })) : null,
    ]);
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
    // since 1.3.0: calendars and contacts in numbers (never their content)
    if (o.pim) {
      page.appendChild(h('div', { class: 'ma-card' }, [h('h2', { text: T('a.pim_title') }), h('div', { class: 'ma-stats' }, [
        stat(o.pim.calendars, T('a.calendars')), stat(o.pim.events, T('a.events')), stat(o.pim.contacts, T('a.contacts')), stat(fmtSize(o.pim.bytes), T('a.pim_bytes')),
      ])]));
    }
    if (o.seats) {
      var x = o.seats; var l = x.licence || {};
      page.appendChild(h('div', { class: 'ma-card' }, [h('h2', { text: T('a.licence') + (l.tier ? ' · ' + T('a.tier_' + l.tier) : '') }),
        h('p', { class: x.exceeded || !l.valid ? 'dp-err' : 'ma-d', text: !l.valid ? T('a.licence_invalid') : seatsLine(x) + (x.exceeded ? ' · ' + T('a.exceeded') : '') })]));
    }
    page.appendChild(h('p', { class: 'ma-d', text: T('a.privacy') }));
  }

  // ── Ressourcen (since 1.9.0, mockup AdminRessourcen) ──────────

  var R = { items: [], kinds: [], sel: null, draft: null, log: null, settings: null };
  var KIND_ICON = { room: 'M4 4h16v16H4zM9 20v-5h6v5', vehicle: 'M5 17h14l-1.5-6h-11zM8 18.5a1.5 1.5 0 1 0 0 .01M16 18.5a1.5 1.5 0 1 0 0 .01', device: 'M3 6h14v10H3zM17 10l4-2v8l-4-2', other: 'M12 3l9 5v8l-9 5-9-5V8z' };
  var MAX_CHOICES = [null, 60, 120, 240, 480, 1440, 2880, 10080];
  var AHEAD_CHOICES = [null, 7, 14, 30, 60, 90, 180, 365];
  var HOURS_CHOICES = [null, { days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' }, { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }, { days: [1, 2, 3, 4, 5, 6], from: '07:00', to: '20:00' }, { days: [1, 2, 3, 4, 5, 6, 7], from: '07:00', to: '22:00' }];

  function kindIcon(kind, color) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('width', '18'); s.setAttribute('height', '18'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', KIND_ICON[kind] || KIND_ICON.other); s.appendChild(p);
    return h('span', { class: 'ma-ic', style: 'background:color-mix(in srgb,' + color + ' 16%,transparent);color:' + color }, s);
  }
  function maxLabel(m) {
    if (m == null) return T('a.res_no_limit');
    if (m % 1440 === 0) return m === 1440 ? T('a.res_day') : m === 10080 ? T('a.res_week') : T('a.res_days', { n: m / 1440 });
    return T('a.res_hours', { n: m / 60 });
  }
  var WD = ['', 'mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
  function hoursLabel(x) {
    if (!x) return T('a.res_always');
    var d = x.days;
    var run = d.length > 1 && d[d.length - 1] - d[0] === d.length - 1;
    var days = run ? T('a.wd_' + WD[d[0]]) + ' ' + T('a.res_to') + ' ' + T('a.wd_' + WD[d[d.length - 1]]) : d.map(function (n) { return T('a.wd_' + WD[n]); }).join(', ');
    return T('a.res_hours_text', { days: days, from: String(Number(x.from.slice(0, 2))) + (x.from.slice(3) !== '00' ? ':' + x.from.slice(3) : ''), to: String(Number(x.to.slice(0, 2))) + (x.to.slice(3) !== '00' ? ':' + x.to.slice(3) : '') });
  }
  function sub(r) {
    var parts = [T('a.kind_' + r.kind)];
    if (r.seats) parts.push(T('a.res_seats_n', { n: r.seats }));
    else if (r.location) parts.push(r.location);
    return parts.join(' · ');
  }
  function blank() { return { name: '', kind: 'room', location: '', seats: null, equipment: '', bookers: { all: true, principals: [] }, approval: 'auto', approvers: [], rules: { maxMinutes: null, horizonDays: null, hours: null } }; }
  function copy(r) { return JSON.parse(JSON.stringify({ name: r.name, kind: r.kind, location: r.location || '', seats: r.seats, equipment: r.equipment || '', bookers: r.bookers, approval: r.approval, approvers: r.approvers || [], rules: r.rules })); }

  function loadResources(selectId) {
    return api('GET', 'admin/resources').then(function (x) {
      R.items = x.items || [];
      R.kinds = x.kinds || ['room', 'vehicle', 'device', 'other'];
      var cur = selectId != null ? selectId : (R.sel && R.sel !== 'new' ? R.sel : (R.items[0] ? R.items[0].id : 'new'));
      pick(cur);
    }, function (e) { var page = $('ma-page'); clear(page); page.appendChild(h('p', { class: 'dp-err', text: errText(e) })); });
  }
  function pick(id) {
    R.sel = id;
    var r = R.items.filter(function (x) { return x.id === id; })[0];
    if (!r && id !== 'new') { R.sel = 'new'; r = null; }
    R.draft = r ? copy(r) : blank();
    R.log = null;
    if (r) api('GET', 'admin/resources/' + r.id + '/log').then(function (x) { if (R.sel === r.id) { R.log = x.items || []; resourcesPage(); } }, function () {});
    resourcesPage();
  }

  function principalChips(list, onPick, title, onRemove) {
    var box = h('div', { class: 'ma-chips' }, list.map(function (p, i) {
      return h('span', { class: 'ma-chip' }, [p.label || (p.type + ' ' + p.id), h('button', { type: 'button', class: 'ma-x', attrs: { 'aria-label': T('a.remove') + ' ' + (p.label || '') }, on: { click: function () { onRemove(i); } } }, '×')]);
    }));
    box.appendChild(h('button', { type: 'button', class: 'dp-btn dp-btn-sm', text: T('a.choose'), on: { click: function () {
      if (!window.GC || !window.GC.pickPrincipals) { toast(T('a.no_picker'), 'error'); return; }
      window.GC.pickPrincipals({ groups: true, users: true, multiple: true, title: title }).then(function (got) {
        if (!got) return;
        onPick(got.map(function (p) { return { type: p.type, id: p.id, label: p.label }; }));
      });
    } } }));
    return box;
  }
  function merged(list, add) {
    var out = list.slice();
    add.forEach(function (p) { if (!out.some(function (x) { return x.type === p.type && x.id === p.id; })) out.push(p); });
    return out;
  }

  function resourcesPage() {
    var page = $('ma-page');
    clear(page);
    page.className = 'ma-page ma-wide';
    var listBox = h('div', { class: 'ma-card ma-rlist' }, R.items.length ? R.items.map(function (r) {
      var on = R.sel === r.id;
      return h('button', { type: 'button', class: 'ma-ritem' + (on ? ' is-on' : ''), attrs: { 'aria-pressed': on ? 'true' : 'false' }, on: { click: function () { pick(r.id); } } }, [
        kindIcon(r.kind, r.color), h('span', { class: 'ma-lbl' }, [h('span', { class: 'ma-t', text: r.name }), h('span', { class: 'ma-d', text: sub(r) + (r.active ? '' : ' · ' + T('a.res_inactive')) })]),
        h('span', { class: 'ma-pill' + (r.approval === 'approval' ? ' is-warn' : ''), text: r.approval === 'approval' ? T('a.res_pill_approval') : T('a.res_pill_auto') }),
        r.counts && r.counts.pending ? h('span', { class: 'ma-pill is-warn', text: T('a.res_pending_n', { n: r.counts.pending }) }) : null,
      ]);
    }) : [h('p', { class: 'ma-d', text: T('a.res_none') })]);
    var left = h('section', { class: 'ma-rleft' }, [listBox,
      h('button', { type: 'button', class: 'ma-add' + (R.sel === 'new' ? ' is-on' : ''), text: T('a.res_new'), on: { click: function () { pick('new'); } } }),
      h('p', { class: 'ma-d', text: T('a.res_note') })]);
    page.appendChild(h('div', { class: 'ma-rgrid' }, [left, editor()]));
  }

  function editor() {
    var d = R.draft;
    var cur = R.items.filter(function (x) { return x.id === R.sel; })[0] || null;
    var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    var inp = function (k, label, type) {
      var x = h('input', { class: 'dp-input', type: type || 'text', value: d[k] == null ? '' : String(d[k]), attrs: { 'aria-label': label } });
      x.addEventListener('input', function () { d[k] = type === 'number' ? (x.value === '' ? null : Number(x.value)) : x.value; });
      return h('label', { class: 'dp-field' }, [h('span', { class: 'ma-d', text: label }), x]);
    };
    var kinds = h('div', { class: 'dp-chips', attrs: { role: 'group', 'aria-label': T('a.res_kind') } }, R.kinds.map(function (k) {
      return h('button', { type: 'button', attrs: { 'aria-pressed': d.kind === k ? 'true' : 'false' }, on: { click: function () { d.kind = k; resourcesPage(); } } }, T('a.kind_' + k));
    }));
    var who = h('div', { class: 'ma-col' }, [
      select(d.bookers.all ? 'all' : 'some', [['all', T('a.everybody')], ['some', T('a.chosen')]], function (v) { d.bookers = { all: v === 'all', principals: d.bookers.principals || [] }; resourcesPage(); }),
      d.bookers.all ? null : principalChips(d.bookers.principals, function (got) { d.bookers.principals = merged(d.bookers.principals, got); resourcesPage(); }, T('a.res_bookers'),
        function (i) { d.bookers.principals.splice(i, 1); resourcesPage(); }),
    ]);
    var answer = h('div', { class: 'dp-chips', attrs: { role: 'group', 'aria-label': T('a.res_answer') } }, [['auto', T('a.res_auto')], ['approval', T('a.res_approval')]].map(function (o) {
      return h('button', { type: 'button', attrs: { 'aria-pressed': d.approval === o[0] ? 'true' : 'false' }, on: { click: function () { d.approval = o[0]; resourcesPage(); } } }, o[1]);
    }));
    var rules = d.rules || { maxMinutes: null, horizonDays: null, hours: null };
    var maxSel = select(rules.maxMinutes == null ? '' : rules.maxMinutes, MAX_CHOICES.concat(MAX_CHOICES.indexOf(rules.maxMinutes) < 0 ? [rules.maxMinutes] : []).map(function (m) { return [m == null ? '' : m, maxLabel(m)]; }),
      function (v) { rules.maxMinutes = v === '' ? null : Number(v); });
    maxSel.setAttribute('aria-label', T('a.res_max'));
    var aheadSel = select(rules.horizonDays == null ? '' : rules.horizonDays, AHEAD_CHOICES.concat(AHEAD_CHOICES.indexOf(rules.horizonDays) < 0 ? [rules.horizonDays] : []).map(function (n) { return [n == null ? '' : n, n == null ? T('a.res_no_limit') : T('a.res_days', { n: n })]; }),
      function (v) { rules.horizonDays = v === '' ? null : Number(v); });
    aheadSel.setAttribute('aria-label', T('a.res_ahead'));
    var hoursList = HOURS_CHOICES.slice();
    var key = function (x) { return x ? x.days.join(',') + ' ' + x.from + '-' + x.to : ''; };
    if (rules.hours && !hoursList.some(function (x) { return key(x) === key(rules.hours); })) hoursList.push(rules.hours);
    var hoursSel = select(key(rules.hours), hoursList.map(function (x) { return [key(x), hoursLabel(x)]; }), function (v) { rules.hours = hoursList.filter(function (x) { return key(x) === v; })[0] || null; });
    hoursSel.setAttribute('aria-label', T('a.res_bookable'));
    d.rules = rules;
    var save = function () {
      err.textContent = '';
      var b = { name: (d.name || '').trim(), kind: d.kind, location: (d.location || '').trim() || null, seats: d.seats == null || d.seats === '' ? null : Number(d.seats), equipment: (d.equipment || '').trim() || null,
        bookers: d.bookers, approval: d.approval, approvers: d.approval === 'approval' ? d.approvers : [], rules: rules };
      if (!b.name) { err.textContent = T('a.res_name_missing'); return; }
      if (b.approval === 'approval' && !b.approvers.length) { err.textContent = T('a.res_approvers_missing'); return; }
      var call = cur ? api('PUT', 'admin/resources/' + cur.id, b) : api('POST', 'admin/resources', b);
      call.then(function (x) { toast(T('a.saved')); loadResources(x.resource.id); }, function (e) { err.textContent = errText(e); });
    };
    var remove = function () {
      if (!cur || !window.confirm(T('a.res_delete_q', { name: cur.name }))) return;
      api('DELETE', 'admin/resources/' + cur.id).then(function (x) { toast(x.cancelled ? T('a.res_deleted_n', { n: x.cancelled }) : T('a.res_deleted')); R.sel = null; loadResources(); }, function (e) { err.textContent = errText(e); });
    };
    var later = function (title, desc) {
      return h('div', { class: 'ma-row' }, [h('div', { class: 'ma-lbl' }, [h('span', { class: 'ma-t', text: title }), h('span', { class: 'ma-d', text: desc })]), h('span', { class: 'ma-pill', text: T('a.later') })]);
    };
    return h('section', { class: 'ma-card ma-redit', attrs: { 'aria-label': cur ? cur.name : T('a.res_new') } }, [
      h('div', { class: 'ma-rhead' }, [h('h2', { text: cur ? cur.name : T('a.res_new_title') }), h('span', { style: 'flex:1' }),
        h('button', { type: 'button', class: 'dp-btn dp-btn-sm', text: T('a.discard'), on: { click: function () { pick(R.sel); } } }),
        h('button', { type: 'button', class: 'dp-btn dp-btn-sm dp-btn-primary', text: T('a.save'), on: { click: save } })]),
      h('div', { class: 'ma-fgrid' }, [inp('name', T('a.res_name')), h('div', { class: 'dp-field' }, [h('span', { class: 'ma-d', text: T('a.res_kind') }), kinds]),
        inp('location', T('a.res_location')), inp('seats', T('a.res_seats'), 'number'), h('div', { class: 'ma-span' }, inp('equipment', T('a.res_equipment')))]),
      row(T('a.res_bookers'), T('a.res_bookers_d'), who),
      row(T('a.res_answer'), T('a.res_answer_d'), answer),
      d.approval === 'approval' ? row(T('a.res_approvers'), T('a.res_approvers_d'), principalChips(d.approvers, function (got) { d.approvers = merged(d.approvers, got); resourcesPage(); }, T('a.res_approvers'),
        function (i) { d.approvers.splice(i, 1); resourcesPage(); })) : null,
      row(T('a.res_rules'), null, h('div', { class: 'ma-inline' }, [h('span', { class: 'ma-d', text: T('a.res_at_most') }), maxSel, h('span', { class: 'ma-d', text: T('a.res_up_to') }), aheadSel, h('span', { class: 'ma-d', text: T('a.res_ahead_suffix') })])),
      row(T('a.res_bookable'), T('a.res_bookable_d'), hoursSel),
      later(T('a.res_skoda'), T('a.res_skoda_d')),
      later(T('a.res_m365'), T('a.res_m365_d')),
      err,
      cur ? h('div', { class: 'dp-actions', style: 'justify-content:flex-start' }, h('button', { type: 'button', class: 'dp-btn dp-btn-sm dp-btn-danger', text: T('a.res_delete'), on: { click: remove } })) : null,
      cur ? logBox() : null,
    ]);
  }

  function logBox() {
    if (!R.log) return null;
    var rows = R.log.slice(0, 30).map(function (x) {
      var text = T('a.log_' + x.action) + (x.detail && x.detail.violations && x.detail.violations.length ? ' · ' + T('a.log_rules', { n: x.detail.violations.length }) : '');
      return h('tr', null, [h('td', { text: new Date(x.at).toLocaleString(CTX.lang === 'en' ? 'en-GB' : 'de-DE', { dateStyle: 'short', timeStyle: 'short' }) }), h('td', { text: x.user ? x.user.name : '–' }),
        h('td', { class: x.action === 'confirmed_override' ? 'is-warn' : null, text: text })]);
    });
    return h('div', { class: 'ma-col' }, [h('span', { class: 'ma-t', text: T('a.res_log') }), rows.length ? h('table', { class: 'ma-table' }, rows) : h('p', { class: 'ma-d', text: T('a.res_log_none') })]);
  }

  function render() {
    if (CTX.page === 'settings') { if (V) settingsPage(); return; }
  }

  function boot() {
    var page = $('ma-page');
    page.appendChild(h('p', { class: 'ma-d', text: T('a.loading') }));
    if (CTX.page === 'resources') { loadResources(); return; }
    if (CTX.page === 'settings') api('GET', 'admin/settings').then(function (r) { V = r; render(); }, function (e) { clear(page); page.appendChild(h('p', { class: 'dp-err', text: errText(e) })); });
    else api('GET', 'admin/overview').then(overviewPage, function (e) { clear(page); page.appendChild(h('p', { class: 'dp-err', text: errText(e) })); });
  }

  boot();
})();
