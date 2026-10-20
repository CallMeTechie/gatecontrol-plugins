/* Schule page: WebUntis accounts (add by QR link or password, diagnostics, fetch now, remove),
   their students (enable, map to a GateControl user, recipients, wall tablet) and the change
   log. Everything goes through the plugin API (window.GC); credentials never come back. */
(function () {
  'use strict';
  var S = window.SC, T = S.T, $ = S.$, $$ = S.$$, el = S.el;
  var ICON_SCHOOL = 'M2 9l10-5 10 5-10 5zM6 11v5c3 2 9 2 12 0v-5M22 9v6';
  var ICON_USER = 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0';

  var data = null;        // GET /status
  var editAcc = null;     // account whose credentials are changed (null = new)
  var editSt = null;      // student being edited
  var mode = 'qr';

  function errText(e) { return (e && e.data && e.data.error) || (e && e.message) || T('common.error'); }
  function warn(e) { S.toast(errText(e), 'error'); }
  function setMsg(text, tone) { var m = $('#sc-acc-msg'); m.textContent = text || ''; m.style.color = tone === 'error' ? 'var(--crit)' : ''; }

  function load() {
    return S.api('GET', 'status').then(function (r) { data = r; render(); }).catch(warn);
  }

  function render() {
    var c = data.config;
    var probs = (c.problems || []).map(function (p) { return T('problem.' + p); });
    $('#sc-problems').hidden = !probs.length;
    $('#sc-problems').textContent = probs.join(' ');
    var quiet = c.quiet_from ? T('info.quiet', { from: c.quiet_from, to: c.quiet_to }) : T('info.no_quiet');
    $('#sc-info').textContent = [T('info.poll', { n: c.poll_minutes }), T('info.days_' + (c.notify_days === 1 ? 'one' : (c.notify_days === 2 ? 'two' : 'n')), { n: c.notify_days }), quiet, T('info.tz', { tz: c.timezone })].join(' · ');
    renderRules();
    renderDayEnds();
    renderAccounts();
    renderUpcoming();
    renderLog();
  }

  /** 1.2.0: early ends handed to the Familie plugin's rides — shown after a call. */
  function renderDayEnds() {
    var r = data.dayEnds;
    var box = $('#sc-dayends');
    var l = r && r.last;
    box.hidden = !l;
    if (!l) return;
    box.textContent = l.ok ? T('dayend.info_ok', { when: S.when(l.at), events: l.events, notified: l.notified }) : T('dayend.info_error', { when: S.when(l.at), code: l.code || 'failed' });
  }

  /** 1.2.0: exams and homework of the next 14 days, by date. */
  function renderUpcoming() {
    var u = data.upcoming || { exams: [], homework: [] };
    var c = data.config;
    $('#sc-upcoming-hint').textContent = c.reminder_time ? T('upcoming.hint', { time: c.reminder_time }) : T('upcoming.hint_off');
    var box = S.clear($('#sc-upcoming'));
    var rows = [];
    u.exams.forEach(function (x) { rows.push({ date: x.date, k: 0, x: x }); });
    u.homework.forEach(function (h) { rows.push({ date: h.date, k: 1, x: h }); });
    rows.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : a.k - b.k); });
    if (!rows.length) { box.appendChild(el('div', { class: 'sc-empty', text: T('upcoming.empty') })); return; }
    rows.forEach(function (r) {
      var x = r.x;
      var subj = (x.subjectLong && x.subjectLong.length <= 24 ? x.subjectLong : x.subject) || '–';
      var title = (x.student || '–') + ' · ' + subj + ' · ' + S.dayLabel(r.date) + (r.k === 0 && x.start ? ' ' + x.start + (x.end ? '–' + x.end : '') : '');
      var sub = r.k === 0 ? [x.name, x.type, x.text].filter(Boolean).join(' · ') : (x.text || '');
      box.appendChild(el('div', { class: 'sc-log-row', 'data-kind': r.k === 0 ? 'exam' : 'homework' }, [
        el('span', { class: 'sc-log-kind', text: T(r.k === 0 ? 'upcoming.exam' : 'upcoming.homework') }),
        el('div', { class: 'sc-log-main' }, [el('div', { class: 'sc-log-title', text: title }), sub ? el('div', { class: 'sc-log-sub', text: sub }) : null]),
        r.k === 1 && x.completed ? el('span', { class: 'sc-log-status', text: T('upcoming.done') }) : null,
      ]));
    });
  }

  /** 1.1.0: the Familie plugin's rules — shown while it is reachable or after a call. */
  function renderRules() {
    var r = data.rules;
    var box = $('#sc-rules');
    if (!r || (!r.available && !r.last)) { box.hidden = true; return; }
    box.hidden = false;
    var l = r.last;
    box.textContent = !l ? T('rules.info_ready')
      : (l.ok ? T('rules.info_ok', { when: S.when(l.at), events: l.events, fired: l.fired }) : T('rules.info_error', { when: S.when(l.at), code: l.code || 'failed' }));
  }

  function userName(u) { return u ? u.name : ''; }

  function studentRow(acc, s) {
    var tags = [];
    if (s.missing) tags.push(el('span', { class: 'tag', 'data-tone': 'error', text: T('student.missing') }));
    else if (!s.enabled) tags.push(el('span', { class: 'tag', text: T('student.off') }));
    else if (!s.baseline_done) tags.push(el('span', { class: 'tag', text: T('student.baseline') }));
    if (s.show_on_wall) tags.push(el('span', { class: 'tag tag-blue', text: T('student.wall_tag') }));
    var people = [];
    if (s.user) people.push(el('span', { class: 'sc-person', text: T('student.child', { name: userName(s.user) }) }));
    s.recipients.forEach(function (u) { people.push(el('span', { class: 'sc-person', text: userName(u) })); });
    if (!people.length) people.push(el('span', { class: 'muted', text: T('student.nobody') }));
    var meta = [el('span', { text: T('student.lessons', { n: s.lesson_count }) })];
    if (s.last_fetch_at) meta.push(el('span', { text: T('student.fetched', { when: S.when(s.last_fetch_at) }) }));
    meta.push(el('span', { text: s.last_change_at ? T('student.last_change', { when: S.when(s.last_change_at) }) : T('student.no_change') }));
    if (s.last_error) meta.push(el('span', { class: 'is-error', text: T('student.error', { error: s.error_text || s.last_error }) }));
    var ic = el('div', { class: 'sc-ic sc-ic-sm' }); ic.appendChild(S.svg(ICON_USER, 16));
    return el('div', { class: 'sc-student' + (s.enabled && !s.missing ? '' : ' is-disabled') }, [
      el('div', { class: 'sc-head' }, [
        ic,
        el('div', { class: 'sc-head-text' }, [
          el('div', { class: 'sc-sname', text: s.display + (s.klasse ? ' · ' + s.klasse : '') }),
          s.alias ? el('div', { class: 'sc-sub', text: T('student.webuntis_name', { name: s.name }) }) : null,
        ]),
        el('div', { class: 'sc-tags' }, tags),
      ]),
      el('div', { class: 'sc-people' }, [el('span', { class: 'sc-lbl', text: T('student.push_to') })].concat(people)),
      el('div', { class: 'sc-meta' }, meta),
      el('div', null, [el('button', { type: 'button', class: 'btn btn-sm', text: T('common.edit'), on: { click: function () { openStudent(s); } } })]),
    ]);
  }

  function accountCard(a) {
    var status = a.status === 'error' ? el('span', { class: 'tag', 'data-tone': 'error', text: T('status.error') })
      : el('span', { class: 'tag', 'data-tone': a.status === 'ok' ? 'good' : null, text: T(a.status === 'ok' ? 'status.ok' : 'status.new') });
    var ic = el('div', { class: 'sc-ic' }); ic.appendChild(S.svg(ICON_SCHOOL, 20));
    var meta = [];
    meta.push(el('span', { text: a.last_success_at ? T('meta.last', { when: S.when(a.last_success_at) }) : T('meta.never') }));
    if (a.last_error) meta.push(el('span', { class: 'is-error', text: T('meta.error', { when: S.when(a.last_error_at || a.last_attempt_at), error: a.error_text || a.last_error }) }));
    if (a.next_fetch_at) meta.push(el('span', { text: T('meta.next', { when: S.when(a.next_fetch_at) }) }));
    ['homework', 'exams'].forEach(function (k) {
      var x = a.extras && a.extras[k];
      if (x) meta.push(el('span', { class: 'is-error', text: T('extras.skipped', { what: T('extras.' + k), error: x.code, when: S.when(x.until) }) }));
    });
    var kind = T(a.auth === 'secret' ? 'auth.secret' : 'auth.password');
    var role = a.person_type === 12 ? T('role.parent') : (a.person_type === 5 ? T('role.student') : null);
    return el('div', { class: 'sc-card', 'data-id': String(a.id) }, [
      el('div', { class: 'sc-head' }, [ic,
        el('div', { class: 'sc-head-text' }, [
          el('div', { class: 'sc-name', text: a.school + ' · ' + a.username }),
          el('div', { class: 'sc-sub', text: [a.host, kind, role].filter(Boolean).join(' · ') }),
        ]), status]),
      el('div', { class: 'sc-meta' }, meta),
      el('div', { class: 'sc-students' }, a.students.length ? a.students.map(function (s) { return studentRow(a, s); }) : [el('div', { class: 'sc-empty', text: T('student.none') })]),
      el('div', { class: 'sc-foot' }, [
        el('button', { type: 'button', class: 'btn btn-sm', text: T('account.refresh'), on: { click: function (e) { refresh(a, e.currentTarget); } } }),
        el('button', { type: 'button', class: 'btn btn-sm', text: T('account.credentials'), on: { click: function () { openAccount(a); } } }),
        el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: T('account.remove'), on: { click: function () { removeAccount(a); } } }),
      ]),
    ]);
  }

  function renderAccounts() {
    var box = S.clear($('#sc-accounts'));
    if (!data.accounts.length) { box.appendChild(el('div', { class: 'sc-empty', text: T('account.empty') })); return; }
    data.accounts.forEach(function (a) { box.appendChild(accountCard(a)); });
  }

  function renderLog() {
    var box = S.clear($('#sc-log'));
    if (!data.changes.length) { box.appendChild(el('div', { class: 'sc-empty', text: T('log.empty') })); return; }
    data.changes.forEach(function (c) {
      var facts = [];
      if (c.subjectOld) facts.push(T('fact.instead', { now: c.subject || '–', old: c.subjectOld }));
      if (c.teacherOld) facts.push(T('fact.teacher', { now: c.teacher || '–', old: c.teacherOld }));
      if (c.roomOld) facts.push(T('fact.room', { now: c.room || '–', old: c.roomOld }));
      if (c.substText) facts.push(c.substText);
      box.appendChild(el('div', { class: 'sc-log-row', 'data-kind': c.kind }, [
        el('span', { class: 'sc-log-kind', text: T('kind.' + c.kind) }),
        el('div', { class: 'sc-log-main' }, [
          el('div', { class: 'sc-log-title', text: (c.student || '–') + ' · ' + (c.subject || '–') + ' · ' + S.dayLabel(c.date) + (c.period ? ' ' + T('period', { n: c.period }) : '') + ' ' + c.start }),
          facts.length ? el('div', { class: 'sc-log-sub', text: facts.join(' · ') }) : null,
        ]),
        el('span', { class: 'sc-log-status', text: T('pstatus.' + c.status) + ' · ' + S.when(c.detectedAt) }),
      ]));
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

  // ── account dialog ───────────────────────────────────────────────────────
  function setMode(m) {
    mode = m;
    $$('#sc-mode .sc-seg-btn').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-mode') === m); });
    $('#sc-qr-box').hidden = m !== 'qr';
    $('#sc-pw-box').hidden = m !== 'password';
  }
  $$('#sc-mode .sc-seg-btn').forEach(function (b) { b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); }); });

  function openAccount(a) {
    editAcc = a || null;
    $('#sc-acc-title').textContent = a ? T('account.credentials') : T('account.add');
    $('#sc-acc-save').textContent = a ? T('common.save') : T('account.connect');
    ['#sc-qr-link', '#sc-k-key', '#sc-p-pass'].forEach(function (id) { $(id).value = ''; });
    $('#sc-k-host').value = a ? a.host : ''; $('#sc-p-host').value = a ? a.host : '';
    $('#sc-k-school').value = a ? a.school : ''; $('#sc-p-school').value = a ? a.school : '';
    $('#sc-k-user').value = a ? a.username : ''; $('#sc-p-user').value = a ? a.username : '';
    setMode(a && a.auth === 'password' ? 'password' : 'qr');
    setMsg('');
    S.openModal('sc-acc-modal');
  }
  $('#sc-add').addEventListener('click', function () { openAccount(null); });

  function accountBody() {
    if (mode === 'password') {
      return { mode: 'password', host: $('#sc-p-host').value, school: $('#sc-p-school').value, username: $('#sc-p-user').value, password: $('#sc-p-pass').value };
    }
    var link = $('#sc-qr-link').value.trim();
    if (link) return { mode: 'qr', link: link };
    return { mode: 'secret', host: $('#sc-k-host').value, school: $('#sc-k-school').value, username: $('#sc-k-user').value, secret: $('#sc-k-key').value };
  }

  $('#sc-acc-save').addEventListener('click', function () {
    var btn = $('#sc-acc-save');
    btn.disabled = true;
    setMsg(T('account.checking'));
    var req = editAcc ? S.api('PUT', 'accounts/' + editAcc.id, accountBody()) : S.api('POST', 'accounts', accountBody());
    req.then(function (r) {
      S.closeModal('sc-acc-modal');
      if (r.students) S.toast(T('account.added', { names: r.students.map(function (s) { return s.name; }).join(', ') }));
      else S.toast(T('account.saved'));
      if (r.result && r.result.code) S.toast(T('refresh.failed', { error: r.result.error_text || '' }), 'error');
      return load();
    }).catch(function (e) { setMsg(errText(e), 'error'); }).then(function () { btn.disabled = false; });
  });

  // ── student dialog ───────────────────────────────────────────────────────
  function openStudent(s) {
    editSt = s;
    $('#sc-st-title').textContent = s.display;
    $('#sc-s-enabled').checked = s.enabled;
    $('#sc-s-alias').value = s.alias || '';
    $('#sc-s-alias').placeholder = s.name;
    $('#sc-s-alias-hint').textContent = T('student.alias_hint', { name: s.name });
    var sel = S.clear($('#sc-s-user'));
    sel.appendChild(el('option', { value: '', text: T('student.no_user') }));
    data.users.forEach(function (u) { sel.appendChild(el('option', { value: String(u.id), text: u.name })); });
    sel.value = s.user_id ? String(s.user_id) : '';
    var list = S.clear($('#sc-s-recipients'));
    var ids = s.recipients.map(function (u) { return u.id; });
    data.users.forEach(function (u) {
      list.appendChild(el('label', { class: 'sc-check-row' }, [
        el('input', { type: 'checkbox', value: String(u.id), checked: ids.indexOf(u.id) >= 0 }),
        el('span', { text: u.name + (u.role === 'admin' ? ' (' + T('role.admin') + ')' : '') }),
      ]));
    });
    $('#sc-s-wall').checked = s.show_on_wall;
    S.openModal('sc-st-modal');
  }

  $('#sc-st-save').addEventListener('click', function () {
    if (!editSt) return;
    var btn = $('#sc-st-save');
    btn.disabled = true;
    var user = $('#sc-s-user').value;
    var body = {
      enabled: $('#sc-s-enabled').checked,
      alias: $('#sc-s-alias').value.trim() || null,
      user_id: user ? Number(user) : null,
      recipients: $$('#sc-s-recipients input:checked').map(function (i) { return Number(i.value); }),
      show_on_wall: $('#sc-s-wall').checked,
    };
    S.api('PUT', 'students/' + editSt.id, body).then(function () {
      S.closeModal('sc-st-modal');
      S.toast(T('student.saved'));
      return load();
    }).catch(warn).then(function () { btn.disabled = false; });
  });

  load();
  setInterval(function () { if (!$$('.modal-overlay').some(function (m) { return !m.hidden; })) load(); }, 60000);
}());
