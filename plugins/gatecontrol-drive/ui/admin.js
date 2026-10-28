/* Drive (gatecontrol-drive) — the admin pages (mockup "Plugin-Einstellungen – Speicher, Sicherung, Lizenz"):
 *
 *   overview  devices the ransomware protection stopped (since 1.6.0: "Rückgängig machen", "Freigeben"), the backup
 *             hint ("Das GateControl-Backup sichert keine Drive-Dateien", hidable), the licence with its
 *             people (tier, x of y, exceeded, "Lizenz jetzt abrufen"), the areas with their storage; since 1.7.0 the
 *             storage in short (files, versions, trash, what duplicates waste — the details: portal › Drive › Speicher)
 *   people    every account with its seat: none, family or business (as the licence allows)
 *   teams     team folders: name, members (people and groups — GateControl's own picker GC.pickPrincipals) with
 *             read / write / manage, space, archive, remove (an empty one)
 *
 * The admin API (admin/…) through GC.call. Text only through textContent / attributes.
 */
(function () {
  'use strict';

  var CTX = window.DA_CTX || { texts: {}, lang: 'de', page: 'overview' };
  var LOCALE = CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  var NS = 'http://www.w3.org/2000/svg';

  function T(k, p) {
    var s = CTX.texts && CTX.texts[k] != null ? String(CTX.texts[k]) : k;
    if (p) Object.keys(p).forEach(function (x) { s = s.split('{{' + x + '}}').join(String(p[x])); });
    return s;
  }

  var ICONS = {
    alert: 'M12 3l10 18H2z|M12 10v4M12 17h.01',
    plus: 'M12 5v14M5 12h14',
    close: 'M6 6l12 12M18 6L6 18',
    refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8|M21 3v5h-5',
    users: 'M9 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8|M2 21a7 7 0 0 1 14 0|M17 3.5a4 4 0 0 1 0 7|M22 21a7 7 0 0 0-4-6.3',
  };
  function icon(name, size) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', String(size || 16));
    s.setAttribute('height', String(size || 16));
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.9');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    (ICONS[name] || '').split('|').forEach(function (d) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); });
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
      else if (k === 'attrs') Object.keys(v).forEach(function (a) { if (v[a] !== undefined && v[a] !== null && v[a] !== false) n.setAttribute(a, v[a] === true ? '' : String(v[a])); });
      else if (k === 'on') Object.keys(v).forEach(function (e) { n.addEventListener(e, v[e]); });
      else if (k === 'hidden' || k === 'disabled' || k === 'checked' || k === 'selected') n[k] = !!v;
      else if (k === 'value' || k === 'type' || k === 'placeholder' || k === 'id' || k === 'title') n[k] = v;
      else n.setAttribute(k, String(v));
    });
    add(n, kids);
    return n;
  }
  function add(n, kids) {
    (Array.isArray(kids) ? kids : kids == null ? [] : [kids]).forEach(function (c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) add(n, c);
      else n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  var $ = function (id) { return document.getElementById(id); };
  function btn(label, onClick, o) {
    var x = o || {};
    return h('button', { type: 'button', class: 'dp-btn' + (x.primary ? ' dp-btn-primary' : '') + (x.danger ? ' dp-btn-danger' : '') + (x.small ? ' dp-btn-sm' : ''), disabled: x.disabled, on: { click: onClick } },
      [x.icon ? icon(x.icon) : null, h('span', { text: label })]);
  }
  var toastTimer = null;
  function toast(text, kind) {
    var t = $('dp-toast');
    t.textContent = text;
    t.className = 'dp-toast' + (kind === 'error' ? ' is-error' : '');
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, kind === 'error' ? 6000 : 3000);
  }
  function fmtSize(n) {
    var b = Number(n) || 0;
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
    return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: i === 0 || b >= 100 ? 0 : 1 }).format(b) + ' ' + units[i];
  }

  function codeErr(code, extra) { var e = new Error(code); e.code = code; e.extra = extra || null; return e; }
  function api(method, path, body) {
    if (!window.GC || typeof window.GC.call !== 'function') return Promise.reject(codeErr('network'));
    return window.GC.call(method, path, body).then(function (r) {
      if (!r || r.ok !== true) throw codeErr((r && r.code) || 'failed', r);
      return r;
    }, function (e) {
      var d = e && e.data;
      throw codeErr((d && typeof d.code === 'string' && d.code) || 'failed', d || null);
    });
  }
  function errText(e) {
    if (e && e.extra && typeof e.extra.error === 'string' && e.extra.error) return e.extra.error;
    var k = 'err.' + ((e && e.code) || 'failed');
    return CTX.texts && CTX.texts[k] ? T(k) : T('err.generic', { code: (e && e.code) || 'failed' });
  }
  function fail(e) { toast(errText(e), 'error'); }

  function dialog(title, body) {
    var back = $('dp-dialog');
    clear(back);
    back.appendChild(h('div', { class: 'dp-dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title } }, [
      h('div', { attrs: { style: 'display:flex;align-items:flex-start;gap:12px' } }, [h('h3', { text: title, attrs: { style: 'flex:1' } }),
        h('button', { type: 'button', class: 'dp-ib', on: { click: closeDialog }, attrs: { 'aria-label': T('a.close') } }, icon('close', 18))]),
    ].concat(body || [])));
    back.hidden = false;
  }
  function closeDialog() { var b = $('dp-dialog'); b.hidden = true; clear(b); }

  var page = $('da-page');

  // ── overview ─────────────────────────────────────────────

  var TIERS = { family: 'a.tier_family', business: 'a.tier_business', combo: 'a.tier_combo' };
  var KIND = { mine: 'a.kind_mine', family: 'a.kind_family', child: 'a.kind_child', team: 'a.kind_team' };

  function storeLabel(st) {
    if (!st || !st.target) return '—';
    var k = st.target.kind;
    var base = k === 'server' ? T('a.store_server') : (st.target.label || T('a.store_' + k));
    return base + (st.form === 'files' ? ' · ' + T('a.form_files') : '');
  }

  function fmtDate(iso) {
    var d = iso ? new Date(iso) : null;
    return d && !isNaN(d.getTime()) ? d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }) : '';
  }

  /** The open incidents of the ransomware protection (admin/guard/incidents): a box above everything else. */
  function incidents() {
    var box = h('div');
    api('GET', 'admin/guard/incidents').then(function (r) {
      var open = (r.incidents || []).filter(function (x) { return x.state === 'open'; });
      if (!open.length) return;
      box.appendChild(h('div', { class: 'da-alert is-crit', attrs: { role: 'alert' } }, [icon('alert', 22),
        h('div', { class: 'da-alert-tx' }, [h('b', { text: T('a.guard_title') }), h('span', { text: T('a.guard_text') })].concat(open.map(function (x) {
          return h('div', { class: 'da-incident' }, [
            h('span', { text: T('a.guard_line', { device: x.deviceName || x.device, name: x.userName || String(x.user), count: x.files, date: fmtDate(x.at) }) }),
            x.sample && x.sample.length ? h('span', { class: 'da-sub', text: x.sample.join(' · ') }) : null,
            h('div', { class: 'dp-actions', attrs: { style: 'justify-content:flex-start' } }, [
              btn(T('a.guard_undo'), function () { api('POST', 'admin/guard/incidents/' + x.id + '/undo').then(function (u) { toast(T('a.guard_undone', { restored: u.restored || 0, trashed: u.trashed || 0 })); overview(); }, fail); }, { small: true, primary: true }),
              btn(T('a.guard_release'), function () { api('POST', 'admin/guard/incidents/' + x.id + '/release').then(function () { toast(T('a.guard_released')); overview(); }, fail); }, { small: true }),
            ]),
          ]);
        }))),
      ]));
    }, function () { /* nothing to show */ });
    return box;
  }

  function overview() {
    api('GET', 'admin/overview').then(function (r) {
      var o = r.overview;
      clear(page);
      page.appendChild(incidents());
      // the backup hint
      var b = o.backup || { level: 'off', areas: [] };
      if (b.level === 'strong') {
        page.appendChild(h('div', { class: 'da-alert', attrs: { role: 'alert' } }, [icon('alert', 22),
          h('div', { class: 'da-alert-tx' }, [h('b', { text: T('a.backup_title') }), h('span', { text: T('a.backup_strong', { areas: b.areas.map(function (a) { return a.label; }).join(', ') }) })]),
          btn(T('a.backup_hide'), function () { api('PUT', 'admin/backup-hint', { on: false }).then(overview, fail); }, { small: true }),
        ]));
      } else if (b.level === 'subtle') {
        page.appendChild(h('p', { class: 'da-line', text: T('a.backup_subtle') }));
      }
      // licence and people
      var l = o.licence || {};
      var lim = o.limits || {};
      var c = o.counts || { family: 0, business: 0, total: 0 };
      var used = lim.total == null ? T('a.people_unlimited', { n: c.total }) : T('a.people_of', { n: c.total, total: lim.total });
      var kinds = [];
      if (lim.family != null && lim.kinds.indexOf('family') >= 0) kinds.push(T('a.count_family', { n: c.family, max: lim.family }));
      if (lim.business != null && lim.kinds.indexOf('business') >= 0) kinds.push(T('a.count_business', { n: c.business, max: lim.business }));
      page.appendChild(h('div', { class: 'da-grid2' }, [
        h('section', { class: 'da-card', attrs: { 'aria-label': T('a.licence') } }, [
          h('div', { class: 'da-head' }, [h('h2', { text: T('a.licence') + (l.tier ? ' · ' + T(TIERS[l.tier]) : '') }),
            h('span', { class: 'da-pill ' + (l.valid ? (o.exceeded ? 'is-warn' : 'is-good') : 'is-crit'), text: l.valid ? (o.exceeded ? T('a.exceeded') : T('a.valid')) : T('a.invalid') })]),
          h('div', { class: 'da-big', text: used }),
          kinds.length ? h('p', { class: 'da-line', text: kinds.join(' · ') }) : null,
          o.exceeded ? h('p', { class: 'da-line', text: T('a.exceeded_text') }) : null,
          h('p', { class: 'da-line', text: lim.total == null ? T('a.no_tier_text') : T('a.book_text') }),
          h('div', { class: 'dp-actions', attrs: { style: 'justify-content:flex-start' } }, [
            btn(T('a.refresh'), function () { api('POST', 'admin/license/refresh').then(function (x) { toast(x.refreshed ? T('a.refreshed') : T('a.refresh_later')); overview(); }, fail); }, { icon: 'refresh', small: true }),
          ]),
        ]),
        h('section', { class: 'da-card', attrs: { 'aria-label': T('a.people') } }, [
          h('h2', { text: T('a.people') }),
          h('p', { class: 'da-line', text: T('a.people_text') }),
          h('ul', { attrs: { style: 'margin:0;padding-left:18px;font-size:14px' } }, (o.people || []).filter(function (p) { return p.seat; }).slice(0, 8).map(function (p) {
            return h('li', { text: p.name + ' · ' + T('a.seat_' + p.seat) });
          })),
        ]),
      ]));
      // the storage in short (since 1.7.0)
      var sg = o.storage;
      if (sg) {
        page.appendChild(h('section', { class: 'da-card', attrs: { 'aria-label': T('a.storage') } }, [
          h('h2', { text: T('a.storage') }),
          h('div', { class: 'da-stats' }, [
            h('div', null, [h('span', { class: 'da-sub', text: T('a.st_files') }), h('b', { text: fmtSize(sg.bytes) }), h('span', { class: 'da-sub', text: T('a.st_files_n', { n: sg.files }) })]),
            h('div', null, [h('span', { class: 'da-sub', text: T('a.st_versions') }), h('b', { text: fmtSize(sg.versionsBytes) })]),
            h('div', null, [h('span', { class: 'da-sub', text: T('a.st_trash') }), h('b', { text: fmtSize(sg.trashBytes) })]),
            h('div', null, [h('span', { class: 'da-sub', text: T('a.st_dups') }), h('b', { text: fmtSize(sg.duplicates ? sg.duplicates.wastedBytes : 0) }),
              h('span', { class: 'da-sub', text: T('a.st_dups_n', { n: sg.duplicates ? sg.duplicates.groups : 0 }) })]),
          ]),
          h('p', { class: 'da-line', text: T('a.st_text') }),
        ]));
      }
      // the areas
      var rows = (o.areas || []).map(function (a) {
        var st = a.storage;
        return h('tr', null, [
          h('td', null, [h('span', { text: a.label }), h('span', { class: 'da-sub', text: T(KIND[a.kind]) + (a.archived ? ' · ' + T('a.archived') : '') })]),
          h('td', { text: storeLabel(st) }),
          h('td', { text: st ? (st.quota ? T('a.used_of', { used: fmtSize(st.bytes), quota: fmtSize(st.quota) }) : fmtSize(st.bytes)) : '—' }),
          h('td', { text: String(a.files) }),
          h('td', { text: st ? (st.encrypted ? T('a.yes') : T('a.no')) : '—' }),
          h('td', null, st && st.state && st.state !== 'ok' ? h('span', { class: 'da-pill ' + (st.state === 'unreachable' ? 'is-crit' : 'is-warn'), text: T('a.state_' + st.state) }) : h('span', { class: 'da-pill is-good', text: T('a.state_ok') })),
        ]);
      });
      page.appendChild(h('section', { class: 'da-card', attrs: { 'aria-label': T('a.areas') } }, [
        h('h2', { text: T('a.areas') }),
        h('p', { class: 'da-line', text: T('a.areas_text') }),
        rows.length ? h('div', { class: 'da-scroll' }, h('table', { class: 'da-table' }, [
          h('thead', null, h('tr', null, [T('a.col_area'), T('a.col_store'), T('a.col_used'), T('a.col_files'), T('a.col_encrypted'), T('a.col_state')].map(function (x) { return h('th', { text: x }); }))),
          h('tbody', null, rows)])) : h('p', { class: 'da-line', text: T('a.areas_none') }),
      ]));
    }, function (e) { clear(page); page.appendChild(h('p', { class: 'dp-err', text: errText(e) })); });
  }

  // ── people ───────────────────────────────────────────────

  function peoplePage() {
    api('GET', 'admin/overview').then(function (r) {
      var o = r.overview;
      var kinds = (o.limits && o.limits.kinds) || [];
      clear(page);
      var c = o.counts || {};
      var lim = o.limits || {};
      page.appendChild(h('p', { class: 'da-line', text: (lim.total == null ? T('a.people_unlimited', { n: c.total }) : T('a.people_of', { n: c.total, total: lim.total })) + ' · ' + T('a.people_text') }));
      var rows = (o.people || []).map(function (p) {
        var sel = h('select', { class: 'dp-input da-select', attrs: { 'aria-label': T('a.seat_for', { name: p.name }) }, on: {
          change: function (ev) {
            var v = ev.target.value;
            api('PUT', 'admin/seats/' + p.id, { kind: v || null }).then(function () { toast(v ? T('a.seat_on', { name: p.name }) : T('a.seat_off', { name: p.name })); peoplePage(); },
              function (e) { fail(e); peoplePage(); });
          },
        } }, [h('option', { value: '', text: T('a.seat_none'), selected: !p.seat })].concat(['family', 'business'].map(function (k) {
          return h('option', { value: k, text: T('a.seat_' + k), selected: p.seat === k, disabled: kinds.indexOf(k) < 0 && p.seat !== k });
        })));
        return h('tr', null, [h('td', null, [h('span', { text: p.name }), h('span', { class: 'da-sub', text: p.role === 'admin' ? T('a.role_admin') : T('a.role_user') })]), h('td', null, sel)]);
      });
      page.appendChild(h('section', { class: 'da-card', attrs: { 'aria-label': T('a.people') } }, [
        h('div', { class: 'da-scroll' }, h('table', { class: 'da-table' }, [h('thead', null, h('tr', null, [h('th', { text: T('a.col_person') }), h('th', { text: T('a.col_seat') })])), h('tbody', null, rows)])),
        h('p', { class: 'da-line', text: T('a.seat_text') }),
      ]));
    }, function (e) { clear(page); page.appendChild(h('p', { class: 'dp-err', text: errText(e) })); });
  }

  // ── team folders ─────────────────────────────────────────

  var ROLES = ['read', 'write', 'manage'];

  function teamsPage() {
    api('GET', 'admin/teams').then(function (r) {
      clear(page);
      page.appendChild(h('div', { class: 'da-head' }, [h('p', { class: 'da-line', text: T('a.teams_text'), attrs: { style: 'flex:1' } }),
        btn(T('a.team_new'), function () { editTeam(null); }, { icon: 'plus', primary: true })]));
      var teams = r.teams || [];
      if (!teams.length) { page.appendChild(h('div', { class: 'dp-empty', text: T('a.teams_none') })); return; }
      teams.forEach(function (tm) {
        page.appendChild(h('section', { class: 'da-card', attrs: { 'aria-label': tm.label } }, [
          h('div', { class: 'da-head' }, [h('h2', { text: tm.label }), tm.archived ? h('span', { class: 'da-pill is-warn', text: T('a.archived') }) : null,
            h('span', { class: 'da-line', text: T('a.team_files', { n: tm.files }) + (tm.quota ? ' · ' + T('a.team_quota', { quota: fmtSize(tm.quota) }) : '') })]),
          h('div', { class: 'da-chips' }, tm.members.length ? tm.members.map(function (m) {
            return h('span', { class: 'da-pill', text: (m.label || T('a.member_gone')) + ' · ' + T('a.role_' + m.role) });
          }) : [h('span', { class: 'da-line', text: T('a.members_none') })]),
          h('div', { class: 'dp-actions', attrs: { style: 'justify-content:flex-start' } }, [
            btn(T('a.edit'), function () { editTeam(tm); }, { small: true }),
            btn(tm.archived ? T('a.unarchive') : T('a.archive'), function () { api('PUT', 'admin/teams/' + tm.id, { archived: !tm.archived }).then(teamsPage, fail); }, { small: true }),
            btn(T('a.remove'), function () { api('DELETE', 'admin/teams/' + tm.id).then(function () { toast(T('a.team_removed')); teamsPage(); }, fail); }, { small: true, danger: true }),
          ]),
        ]));
      });
    }, function (e) { clear(page); page.appendChild(h('p', { class: 'dp-err', text: errText(e) })); });
  }

  function editTeam(tm) {
    var members = (tm ? tm.members : []).map(function (m) { return { principal: m.principal, role: m.role, label: m.label || T('a.member_gone') }; });
    var label = h('input', { class: 'dp-input', type: 'text', value: tm ? tm.label : '', attrs: { maxlength: '80', 'aria-label': T('a.team_name') } });
    var quota = h('input', { class: 'dp-input', type: 'number', value: tm && tm.quota ? String(Math.round(tm.quota / 1073741824)) : '', attrs: { min: '0', 'aria-label': T('a.team_quota_gb') } });
    var list = h('div', { class: 'da-members' });
    var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    var draw = function () {
      clear(list);
      if (!members.length) list.appendChild(h('p', { class: 'da-line', text: T('a.members_none') }));
      members.forEach(function (m, i) {
        list.appendChild(h('div', { class: 'da-member' }, [h('span', { text: m.label }),
          h('select', { class: 'dp-input da-select', attrs: { 'aria-label': T('a.role_for', { name: m.label }) }, on: { change: function (ev) { m.role = ev.target.value; } } },
            ROLES.map(function (r) { return h('option', { value: r, text: T('a.role_' + r), selected: m.role === r }); })),
          h('button', { type: 'button', class: 'dp-ib', on: { click: function () { members.splice(i, 1); draw(); } }, attrs: { 'aria-label': T('a.remove_member', { name: m.label }) } }, icon('close')),
        ]));
      });
    };
    var pick = function () {
      if (!window.GC || typeof window.GC.pickPrincipals !== 'function') { err.textContent = T('a.picker_missing'); return; }
      window.GC.pickPrincipals({ groups: true, users: true, multiple: true, title: T('a.pick_title') }).then(function (got) {
        (got || []).forEach(function (p) {
          var principal = (p.type === 'group' ? 'g:' : 'u:') + p.id;
          if (!members.some(function (m) { return m.principal === principal; })) members.push({ principal: principal, role: 'write', label: p.label });
        });
        draw();
      });
    };
    var save = function () {
      err.textContent = '';
      var gb = Number(quota.value);
      var body = { label: label.value, members: members.map(function (m) { return { principal: m.principal, role: m.role }; }), quota: gb > 0 ? Math.round(gb * 1073741824) : null };
      (tm ? api('PUT', 'admin/teams/' + tm.id, body) : api('POST', 'admin/teams', body)).then(function () { closeDialog(); toast(T('a.team_saved')); teamsPage(); }, function (e) { err.textContent = errText(e); });
    };
    dialog(tm ? T('a.team_edit', { name: tm.label }) : T('a.team_new'), [
      h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('a.team_name') }), label]),
      h('div', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('a.members') }), list, h('div', null, btn(T('a.member_add'), pick, { icon: 'users', small: true }))]),
      h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('a.team_quota_gb') }), quota]),
      h('p', { class: 'dp-hint', text: T('a.team_hint') }),
      err,
      h('div', { class: 'dp-actions' }, [btn(T('a.cancel'), closeDialog), btn(T('a.save'), save, { primary: true })]),
    ]);
    draw();
  }

  if (CTX.page === 'people') peoplePage();
  else if (CTX.page === 'teams') teamsPage();
  else overview();
}());
