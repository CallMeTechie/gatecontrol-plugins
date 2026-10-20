/* Settings „Konten & Kinder“ (1.3.0, page 'setup' = plugin.json ui.settingsPage: GateControl shows it
   in Einstellungen › Plugins › Schule › Einstellungen). WebUntis accounts (add: scan the QR code,
   upload a picture of it, type it in — ui/scan.js; fetch now, renew the access, remove), the
   children (name, colour, GateControl user, recipients, wall tablet, on/off) and the diagnostics
   (change log, Familie). Everything goes through the plugin API (window.GC); credentials never
   come back. Codes are never shown — the API sends the texts. */
(function () {
  'use strict';
  var S = window.SC, T = S.T, $ = S.$, $$ = S.$$, el = S.el;
  var data = null;
  var editKid = null;
  var kidState = null;

  function warn(e) { S.toast(S.errText(e), 'error'); }

  function load() {
    return S.api('GET', 'status').then(function (r) { data = r; render(); }).catch(warn);
  }

  function render() {
    var c = data.config;
    var probs = (c.problems || []).map(function (p) { return T('problem.' + p); });
    $('#ss-problems').hidden = !probs.length;
    $('#ss-problems').textContent = probs.join(' ');
    renderAccounts();
    renderKids();
    renderDiag();
  }

  // ── accounts ─────────────────────────────────────────────────────────────
  function statusPill(a) {
    if (a.status === 'error') return el('span', { class: 'pill', 'data-tone': 'crit', text: T('status.error') });
    if (a.status === 'ok') return el('span', { class: 'pill', 'data-tone': 'good', text: T('status.ok') });
    return el('span', { class: 'pill', text: T('status.new') });
  }

  function accountCard(a) {
    var ic = el('span', { class: 'acc-ic', 'aria-hidden': 'true' }, [S.svg(S.ICON.school, 20)]);
    var role = a.person_type === 12 ? T('role.parent') : (a.person_type === 5 ? T('role.student') : null);
    var sub = [a.username, role, T(a.auth === 'secret' ? 'auth.secret' : 'auth.password')].filter(Boolean).join(' · ');
    var meta = [el('span', { text: a.last_success_at ? T('meta.last', { when: S.when(a.last_success_at) }) : T('meta.never') })];
    if (a.status !== 'error' && a.next_fetch_at) meta.push(el('span', { text: T('meta.next', { when: S.when(a.next_fetch_at) }) }));
    if (a.owner) meta.push(el('span', { text: T('account.owner', { name: a.owner.name }) }));
    var kids = a.students.map(function (s) {
      return el('span', { class: 'acc-kid', style: { '--kid': s.color } }, [S.avatar(s, 'av-sm'), el('span', { text: s.display })]);
    });
    return el('article', { class: 'card acc', 'data-id': String(a.id) }, [
      el('div', { class: 'acc-head' }, [ic, el('div', { class: 'acc-t' }, [el('div', { class: 'acc-name', text: a.school }), el('div', { class: 'acc-sub', text: sub })]), statusPill(a)]),
      a.status === 'error' && a.error_text ? el('div', { class: 'acc-err', text: a.error_text }) : null,
      el('div', { class: 'acc-meta' }, meta),
      kids.length ? el('div', { class: 'acc-kids' }, kids) : el('div', { class: 'hint', text: T('student.none') }),
    ].concat((a.extras_info || []).map(function (x) { return el('div', { class: 'acc-info', 'data-tone': x.tone, text: x.text }); })).concat([
      el('div', { class: 'acc-foot' }, [
        el('button', { type: 'button', class: 'btn btn-sm', on: { click: function (e) { refresh(a, e.currentTarget); } } }, [S.svg(S.ICON.refresh, 15), T('account.refresh')]),
        el('button', { type: 'button', class: 'btn btn-sm', on: { click: function () { reauth(a); } } }, [S.svg(S.ICON.key, 15), T('account.credentials')]),
        el('button', { type: 'button', class: 'btn btn-sm btn-ghost btn-danger', on: { click: function () { removeAccount(a); } } }, [S.svg(S.ICON.trash, 15), T('account.remove')]),
      ]),
    ]));
  }

  function renderAccounts() {
    var box = S.clear($('#ss-accounts'));
    if (!data.accounts.length) {
      box.appendChild(el('div', { class: 'ss-empty' }, [el('span', { class: 'ic', 'aria-hidden': 'true' }, [S.svg(S.ICON.school, 22)]), el('span', { text: T('account.empty') })]));
      return;
    }
    data.accounts.forEach(function (a) { box.appendChild(accountCard(a)); });
  }

  function addAccount() {
    window.SCScan.open({
      title: T('account.add'),
      intro: T('scan.intro_admin'),
      onSubmit: function (body) {
        return S.api('POST', 'accounts', body).then(function (r) {
          S.toast(T('account.added', { names: (r.students || []).map(function (s) { return s.name; }).join(', ') }));
          if (r.result && r.result.code) S.toast(T('refresh.failed', { error: r.result.error_text || '' }), 'error');
          return load();
        });
      },
    });
  }

  function reauth(a) {
    window.SCScan.open({
      title: T('account.credentials'),
      intro: T('scan.intro_reauth', { name: a.school + ' · ' + a.username }),
      submitLabel: T('common.save'),
      preset: { host: a.host, school: a.school, username: a.username },
      onSubmit: function (body) {
        return S.api('PUT', 'accounts/' + a.id, body).then(function (r) {
          S.toast(T('account.saved'));
          if (r.result && r.result.code) S.toast(T('refresh.failed', { error: r.result.error_text || '' }), 'error');
          return load();
        });
      },
    });
  }

  function refresh(a, btn) {
    btn.disabled = true;
    S.api('POST', 'accounts/' + a.id + '/refresh').then(function (r) {
      if (r.result && r.result.ok && !r.result.code) S.toast(T('refresh.ok', { n: r.result.students }));
      else S.toast(T('refresh.failed', { error: (r.result && r.result.error_text) || '' }), 'error');
      return load();
    }).catch(warn).then(function () { btn.disabled = false; });
  }

  function removeAccount(a) {
    S.confirm(T('account.remove_confirm', { name: a.school + ' · ' + a.username }), T('account.remove'), true).then(function (yes) {
      if (!yes) return null;
      return S.api('DELETE', 'accounts/' + a.id).then(function () { S.toast(T('account.removed')); return load(); });
    }).catch(warn);
  }

  // ── children ─────────────────────────────────────────────────────────────
  function allKids() {
    var out = [];
    data.accounts.forEach(function (a) { a.students.forEach(function (s) { out.push({ s: s, a: a }); }); });
    return out;
  }

  function kidRow(x) {
    var s = x.s;
    var tags = [];
    if (s.missing) tags.push(el('span', { class: 'pill', 'data-tone': 'crit', text: T('student.missing') }));
    else if (!s.enabled) tags.push(el('span', { class: 'pill', text: T('student.off') }));
    else if (!s.baseline_done) tags.push(el('span', { class: 'pill', 'data-tone': 'info', text: T('student.baseline') }));
    if (s.show_on_wall) tags.push(el('span', { class: 'pill no-dot', text: T('student.wall_tag') }));
    if (s.user) tags.push(el('span', { class: 'kidrow-who' }, [S.avatar(s.user, 'av-sm av-plain'), el('span', { text: s.link_source === 'self' ? T('student.linked_self', { name: s.user.name }) : T('student.child', { name: s.user.name }) })]));
    if (s.recipients.length) tags.push(el('span', { class: 'kidrow-who', text: T('student.push_more', { names: s.recipients.map(function (u) { return u.name; }).join(', ') }) }));
    var sub = [s.klasse ? T('view.class', { klasse: s.klasse }) : null, x.a.school, s.last_fetch_at ? T('student.fetched', { when: S.when(s.last_fetch_at) }) : null].filter(Boolean).join(' · ');
    return el('div', { class: 'kidrow' + (s.enabled && !s.missing ? '' : ' is-off'), style: { '--kid': s.color } }, [
      S.avatar(s, 'av-lg'),
      el('div', { class: 'kidrow-main' }, [
        el('div', { class: 'kidrow-name', text: s.display + (s.alias ? ' ' : '') }, s.alias ? [el('span', { class: 'hint', text: '(' + s.name + ')' })] : null),
        el('div', { class: 'kidrow-sub', text: sub }),
        s.error_text ? el('div', { class: 'kidrow-sub', style: { color: 'var(--crit)' }, text: s.error_text }) : null,
        tags.length ? el('div', { class: 'kidrow-tags' }, tags) : null,
      ]),
      el('div', { class: 'kidrow-actions' }, [
        el('button', { type: 'button', class: 'btn btn-sm', on: { click: function () { openKid(s); } } }, [S.svg(S.ICON.edit, 15), T('common.edit')]),
      ]),
    ]);
  }

  function renderKids() {
    var box = S.clear($('#ss-kids'));
    var list = allKids();
    if (!list.length) { box.appendChild(el('div', { class: 'ss-empty', text: T('setup.kids_empty') })); return; }
    list.forEach(function (x) { box.appendChild(kidRow(x)); });
  }

  function person(u) { return { color: u.colorHex, avatarUrl: u.avatarUrl, initials: u.initials }; }

  function kidAvatar() {
    var u = kidState.user ? data.users.filter(function (x) { return x.id === kidState.user; })[0] : null;
    var face = u && u.colorHex ? { color: u.colorHex, avatarUrl: u.avatarUrl, initials: u.initials } : { color: kidState.color || editKid.color, initials: editKid.initials };
    S.clear($('#ss-kid-av')).appendChild(S.avatar(face));
    renderSwatches(u);
  }

  function renderSwatches(u) {
    var box = S.clear($('#ss-k-colors'));
    var fromUser = !!(u && u.colorHex);
    (data.palette || []).forEach(function (c) {
      box.appendChild(el('button', { type: 'button', class: 'sw', role: 'radio', 'aria-checked': String(!fromUser && kidState.color === c), 'aria-label': c, disabled: fromUser, style: { '--c': c },
        on: { click: function () { kidState.color = c; kidAvatar(); } } }));
    });
    box.appendChild(el('button', { type: 'button', class: 'sw sw-auto', text: T('student.color_auto'), disabled: fromUser, on: { click: function () { kidState.color = null; kidState.auto = true; kidAvatar(); } } }));
    $('#ss-k-color-hint').textContent = fromUser ? T('student.color_from_user', { name: u.name }) : T('student.color_hint');
  }

  function openKid(s) {
    editKid = s;
    kidState = { color: s.own_color, user: s.user_id, auto: false };
    $('#ss-kid-title').textContent = s.display;
    $('#ss-k-alias').value = s.alias || '';
    $('#ss-k-alias').placeholder = s.name;
    $('#ss-k-alias-hint').textContent = T('student.alias_hint', { name: s.name });
    var sel = S.clear($('#ss-k-user'));
    sel.appendChild(el('option', { value: '', text: T('student.no_user') }));
    data.users.forEach(function (u) { sel.appendChild(el('option', { value: String(u.id), text: u.name })); });
    sel.value = s.user_id ? String(s.user_id) : '';
    sel.onchange = function () { kidState.user = sel.value ? Number(sel.value) : null; kidAvatar(); };
    $('#ss-k-user-hint').textContent = s.link_source === 'self' && s.user ? T('student.user_hint_self', { name: s.user.name }) : T('student.user_hint');
    var list = S.clear($('#ss-k-recipients'));
    var ids = s.recipients.map(function (u) { return u.id; });
    data.users.forEach(function (u) {
      list.appendChild(el('label', { class: 'person' }, [
        el('input', { type: 'checkbox', value: String(u.id), checked: ids.indexOf(u.id) >= 0 }),
        S.avatar(person(u), 'av-sm'),
        el('span', { text: u.name + (u.role === 'admin' ? ' (' + T('role.admin') + ')' : '') }),
      ]));
    });
    $('#ss-k-wall').checked = s.show_on_wall;
    $('#ss-k-enabled').checked = s.enabled;
    kidAvatar();
    S.openModal('ss-kid-modal');
  }

  $('#ss-kid-save').addEventListener('click', function () {
    if (!editKid) return;
    var btn = $('#ss-kid-save');
    btn.disabled = true;
    var user = $('#ss-k-user').value;
    var body = {
      enabled: $('#ss-k-enabled').checked,
      alias: $('#ss-k-alias').value.trim() || null,
      user_id: user ? Number(user) : null,
      recipients: $$('#ss-k-recipients input:checked').map(function (i) { return Number(i.value); }),
      show_on_wall: $('#ss-k-wall').checked,
    };
    if (kidState.auto && !kidState.color) body.color = null;
    else if (kidState.color && kidState.color !== editKid.own_color) body.color = kidState.color;
    S.api('PUT', 'students/' + editKid.id, body).then(function () {
      S.closeModal('ss-kid-modal');
      S.toast(T('student.saved'));
      return load();
    }).catch(warn).then(function () { btn.disabled = false; });
  });

  // ── diagnostics ──────────────────────────────────────────────────────────
  function renderDiag() {
    var c = data.config;
    var quiet = c.quiet_from ? T('info.quiet', { from: c.quiet_from, to: c.quiet_to }) : T('info.no_quiet');
    $('#ss-info').textContent = [T('info.poll', { n: c.poll_minutes }), T('info.days_' + (c.notify_days === 1 ? 'one' : (c.notify_days === 2 ? 'two' : 'n')), { n: c.notify_days }), quiet, T('info.tz', { tz: c.timezone }),
      c.reminder_time ? T('info.reminder', { time: c.reminder_time }) : T('info.no_reminder')].join(' · ');
    var r = data.rules;
    var rb = $('#ss-rules');
    rb.hidden = !(r && (r.available || r.last));
    if (!rb.hidden) {
      var l = r.last;
      rb.textContent = !l ? T('rules.info_ready') : (l.ok ? T('rules.info_ok', { when: S.when(l.at), events: l.events, fired: l.fired }) : T('rules.info_error', { when: S.when(l.at) }));
    }
    var d = data.dayEnds && data.dayEnds.last;
    var db = $('#ss-dayends');
    db.hidden = !d;
    if (d) db.textContent = d.ok ? T('dayend.info_ok', { when: S.when(d.at), events: d.events, notified: d.notified }) : T('dayend.info_error', { when: S.when(d.at) });
    $('#ss-diag-sum').textContent = data.changes.length ? T('setup.diag_sum', { n: data.changes.length }) : '';
    var faces = {};
    allKids().forEach(function (x) { faces[x.s.id] = x.s; });
    var box = S.clear($('#ss-log'));
    if (!data.changes.length) { box.appendChild(el('div', { class: 'hint', text: T('log.empty') })); return; }
    data.changes.forEach(function (ch) {
      var facts = [];
      if (ch.subjectOld) facts.push(T('fact.instead', { now: ch.subject || '–', old: ch.subjectOld }));
      if (ch.teacherOld) facts.push(T('fact.teacher', { now: ch.teacher || '–', old: ch.teacherOld }));
      if (ch.roomOld) facts.push(T('fact.room', { now: ch.room || '–', old: ch.roomOld }));
      if (ch.substText) facts.push(ch.substText);
      var f = faces[ch.studentId];
      box.appendChild(el('div', { class: 'log-row', 'data-kind': ch.kind }, [
        f ? S.avatar(f, 'av-sm') : null,
        el('div', { class: 'log-main' }, [
          el('div', { class: 'log-title', text: (ch.student || '–') + ' · ' + T('kind.' + ch.kind) + ' · ' + (ch.subject || '–') + ' · ' + S.dayLabel(ch.date) + (ch.period ? ' ' + T('period', { n: ch.period }) : '') + ' ' + ch.start }),
          facts.length ? el('div', { class: 'log-sub', text: facts.join(' · ') }) : null,
        ]),
        el('span', { class: 'log-status', text: T('pstatus.' + ch.status) + ' · ' + S.when(ch.detectedAt) }),
      ]));
    });
  }

  $('#ss-add').addEventListener('click', addAccount);
  load();
  setInterval(function () { if (!$$('.modal-overlay').some(function (m) { return !m.hidden; })) load(); }, 60000);
}());
