/* 1.8: „Schlüssel automatisch einrichten“ (GateControl with gc.remote version 9): user and password once → the fingerprint of
   the host key (confirmed when nothing is pinned yet, before the password is sent) → GateControl puts its key in, tests it
   and switches the device to the key. The password stays in this dialog only and goes with the one request; it is never
   stored. Errors name their step; „Passwort-Anmeldung aus“ and Windows get the copy way and the agent.
   window.RMK.open(device, { onAgent }) → Promise<device | null> */
(function () {
  'use strict';
  var P = window.RM;
  var T = P.T, el = P.el;
  var STEPS = ['connect', 'hostkey', 'install', 'test'];

  function open(dev, opts) {
    var o = opts || {};
    var resolveFn;
    var done = new Promise(function (r) { resolveFn = r; });
    var gw = dev.way === 'home';
    var S = {
      view: 'form', user: (dev.key && dev.key.account !== 'root' && dev.key.account) || (dev.lastAuthFailed && dev.lastAuthFailed.username) || '', password: '', account: 'self', sudo: '',
      restrictFrom: true, clearPassword: true, replaceOwnKey: false, showPw: false, scan: null, confirm: null, steps: null, running: null, error: null, result: null, line: null, attemptsLeft: null, pwBad: false,
    };
    var ownKey = !!(dev.auth === 'own_key' || (dev.ssh && dev.ssh.ownKey));
    var dlg = P.bigDialog({ title: T('key.title'), sub: subLine(), size: 'md', onClose: function (v) { resolveFn(v || S.saved || null); } });
    function subLine() { return dev.name + ' · ' + (dev.config ? dev.config.host + ':' + dev.config.port : '') + (S && S.view !== 'form' ? ' · ' + T('key.as', { name: S.account === 'root' ? 'root' : S.user }) : ''); }

    function note(tone, head, text, acts) {
      return el('div', { class: 'rmx-note ' + tone, role: tone === 'err' || tone === 'warn' ? 'alert' : 'status' }, [P.icon(tone === 'ok' ? 'ok' : (tone === 'info' ? 'info' : 'warn'), 18), el('div', null, [
        head ? el('b', { text: head }) : null, text ? el('span', { class: 'rmx-small', text: text }) : null, acts && acts.length ? el('div', { class: 'acts' }, acts) : null])]);
    }
    function btn(label, fn, cls) { return el('button', { type: 'button', class: 'btn' + (cls ? ' ' + cls : ''), text: label, on: { click: fn } }); }
    function radio(val, title, sub) {
      return el('button', { type: 'button', class: 'rmx-ropt', role: 'radio', 'aria-checked': S.account === val ? 'true' : 'false', 'aria-pressed': S.account === val ? 'true' : 'false',
        on: { click: function () { S.account = val; render(); } } }, [el('span', { class: 'dot' }), el('div', null, [el('b', { text: title }), el('span', { text: sub })])]);
    }
    function check(key, title, sub) {
      var c = el('input', { type: 'checkbox', id: 'rmk-' + key, checked: S[key] });
      c.addEventListener('change', function () { S[key] = c.checked; });
      return el('label', { class: 'rmx-chk rm-chk2', for: 'rmk-' + key }, [c, el('span', null, [el('b', { text: title }), el('small', { text: sub })])]);
    }
    function user() { return S.account === 'root' ? 'root' : (S.user || '…'); }

    // ── the form (screen 2, 5a) ──
    function form() {
      var b = dlg.body;
      if (S.error) b.appendChild(errorNote());
      else b.appendChild(el('p', { class: 'rmx-small', text: T('key.intro') }));
      var u = el('input', { class: 'form-input', type: 'text', id: 'rmk-user', maxlength: '64', autocomplete: 'off', spellcheck: 'false', value: S.user });
      u.addEventListener('input', function () { S.user = u.value.trim(); P.clear(acc); acc.appendChild(radio('self', T('key.self', { name: S.user || '…' }), T('key.self_sub', { name: S.user || '…' }))); acc.appendChild(radio('root', T('key.root'), T('key.root_sub', { name: S.user || '…' }))); });
      var pw = el('input', { class: 'form-input' + (S.pwBad ? ' rm-bad' : ''), type: S.showPw ? 'text' : 'password', id: 'rmk-pw', maxlength: '1024', autocomplete: 'off', value: S.password, 'aria-invalid': S.pwBad ? 'true' : null });
      pw.addEventListener('input', function () { S.password = pw.value; });
      pw.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); start(); } });
      var show = el('button', { type: 'button', class: 'btn btn-sm rmx-ghost', text: T(S.showPw ? 'key.hide' : 'key.show'), 'aria-pressed': S.showPw ? 'true' : 'false', on: { click: function () { S.showPw = !S.showPw; pw.type = S.showPw ? 'text' : 'password'; show.textContent = T(S.showPw ? 'key.hide' : 'key.show'); } } });
      b.appendChild(el('div', { class: 'rmx-g2 rmx-g2-even' }, [
        el('div', { class: 'rmx-field' }, [el('label', { for: 'rmk-user', text: T('f.username') }), u]),
        el('div', { class: 'rmx-field' }, [el('label', { for: 'rmk-pw', text: T('f.password') }), el('div', { class: 'rm-pwrow' }, [pw, show]),
          S.pwBad ? el('span', { class: 'rm-field-error', text: T('key.pw_again') }) : null]),
      ]));
      var acc = el('div', { class: 'rmx-radio', role: 'radiogroup', 'aria-label': T('key.for') }, [radio('self', T('key.self', { name: S.user || '…' }), T('key.self_sub', { name: S.user || '…' })), radio('root', T('key.root'), T('key.root_sub', { name: S.user || '…' }))]);
      b.appendChild(el('span', { class: 'rmx-flabel', text: T('key.for') }));
      b.appendChild(acc);
      var adv = el('details', { class: 'rmx-adv' }, [el('summary', null, [T('wz.advanced'), el('span', { class: 'rmx-head-tags' }, [el('span', { class: 'rmx-tag', text: T('key.adv_sum') })])]), el('div', { class: 'advb' }, [
        check('restrictFrom', T('key.restrict'), gw ? T('key.restrict_gw') : T('key.restrict_sub')),
        check('clearPassword', T('key.clear_pw'), T('key.clear_pw_sub')),
        ownKey ? check('replaceOwnKey', T('key.replace_own'), T('key.replace_own_sub')) : null,
      ])]);
      b.appendChild(adv);
      b.appendChild(el('div', { class: 'rmx-vault' }, [P.icon('lock', 14), T('key.never_stored')]));
      foot([btn(T('common.cancel'), function () { dlg.close(null); }, 'rmx-ghost'), sp(), btn(S.error ? T('key.retry') : T('key.go'), start, 'btn-primary')]);
      setTimeout(function () { try { (S.user ? pw : u).focus(); } catch (e) { /* gone */ } }, 0);
    }
    function sp() { return el('span', { class: 'rmx-sp' }); }
    function foot(nodes) { P.clear(dlg.foot); nodes.forEach(function (n) { if (n) dlg.foot.appendChild(n); }); }

    function errorNote() {
      var e = S.error;
      if (e.code === 'auth_failed') {
        return note('err', T('key.e_auth_head', { name: user() }), T('key.e_auth', { left: S.attemptsLeft == null ? '?' : S.attemptsLeft }));
      }
      var stepN = e.step ? STEPS.indexOf(e.step) + 1 : null;
      var head = T('key.e.' + e.code) !== 'key.e.' + e.code ? T('key.e.' + e.code) : (e.text || T('error.' + e.code));
      var text = stepN ? T('key.at_step', { n: stepN, step: T('key.step.' + e.step) }) : null;
      var acts = [];
      if (e.code === 'host_key_mismatch') text = (text ? text + ' ' : '') + T('key.e_mismatch_text');
      if (e.code === 'key_test_failed') text = (text ? text + ' ' : '') + T('key.e_test_text') + (e.rolledBack !== false ? ' ' + T('key.rolled_back') : '');
      if (e.code === 'rate_limited') text = T('key.e_rate');
      if (e.code === 'own_key') acts.push(btn(T('key.replace_own'), function () { S.replaceOwnKey = true; S.error = null; render(); }, 'btn-sm'));
      return note('err', head, text, acts);
    }

    // ── progress (3a, 3b), success (4) ──
    function stepList() {
      var box = el('ol', { class: 'rm-steps-list' });
      STEPS.forEach(function (id, i) {
        var st = S.steps && S.steps[id] ? S.steps[id] : { state: S.running === id ? 'run' : 'wait' };
        var state = st.state === 'done' ? 'done' : (st.state === 'fail' ? 'fail' : (st.state === 'run' ? 'run' : (st.state === 'ask' ? 'ask' : 'wait')));
        var mark = state === 'done' ? P.icon('ok', 14, 2.6) : (state === 'fail' ? P.icon('x', 14, 2.6) : (state === 'run' ? el('span', { class: 'rm-spin' }) : (state === 'ask' ? el('b', { text: '!' }) : el('b', { text: String(i + 1) }))));
        var right = state === 'done' && st.ms != null ? el('span', { class: 'ms', text: T('key.ms', { s: (st.ms / 1000).toLocaleString(P.CTX.lang === 'en' ? 'en-GB' : 'de-DE', { maximumFractionDigits: 1 }) }) })
          : (state === 'wait' ? el('span', { class: 'ms', text: T('key.waiting') }) : (state === 'run' ? el('span', { class: 'ms', text: T('key.running') }) : null));
        var li = el('li', { class: 'st-' + state }, [el('span', { class: 'mk' }, [mark]), el('div', null, [el('b', { text: T('key.step.' + id) }), st.detail ? el('small', { text: st.detail }) : null, st.extra || null]), right]);
        box.appendChild(li);
      });
      return box;
    }
    function detailOf(id) {
      if (id === 'connect') return T('key.d_connect', { addr: dev.config.host + ':' + dev.config.port }) + (gw ? ' · ' + T('key.d_gw') : '');
      if (id === 'hostkey') return S.scan ? S.scan.alg + ' SHA256:' + short(S.scan.sha256) + ' · ' + T(S.confirm ? 'key.d_confirmed' : 'key.d_pinned') : null;
      if (id === 'install') return (S.account === 'root' ? '/root' : '/home/' + user()) + '/.ssh/authorized_keys · ' + T('key.d_perm') + (S.restrictFrom ? ' · ' + T('key.d_from') : '');
      return T('key.d_test');
    }
    function short(sha) { return sha && sha.length > 12 ? sha.slice(0, 4) + '…' + sha.slice(-4) : sha; }

    function confirmView() {
      var b = dlg.body;
      var k = S.scan;
      var extra = el('div', { class: 'rm-hk' }, [el('span', { class: 'rmx-small', text: T('key.hk_text') }), el('code', { class: 'rm-cmd1', text: 'ssh-keygen -lf /etc/ssh/ssh_host_' + (k.alg === 'ssh-ed25519' ? 'ed25519' : (/ecdsa/.test(k.alg) ? 'ecdsa' : 'rsa')) + '_key.pub' }),
        el('code', { class: 'rm-fp', text: k.alg + ' SHA256:' + k.sha256 }), el('div', { class: 'acts' }, [btn(T('key.hk_ok'), function () { S.confirm = k.sha256; install(); }, 'btn-sm btn-primary'), btn(T('common.cancel'), function () { dlg.close(null); }, 'btn-sm rmx-ghost')])]);
      S.steps = { connect: { state: 'done', ms: k.ms || null, detail: detailOf('connect') }, hostkey: { state: 'ask', detail: T('key.hk_first'), extra: extra } };
      b.appendChild(stepList());
      b.appendChild(el('p', { class: 'rmx-small', text: T('key.hk_nothing') }));
      foot([btn(T('common.cancel'), function () { dlg.close(null); }, 'rmx-ghost')]);
    }
    function runningView() {
      dlg.body.appendChild(stepList());
      foot([btn(T('common.cancel'), function () { dlg.close(null); }, 'rmx-ghost')]);
      dlg.foot.lastChild.disabled = S.running === 'install';
    }
    function doneView() {
      var r = S.result;
      var b = dlg.body;
      var at = new Date().toLocaleTimeString(P.CTX.lang === 'en' ? 'en-GB' : 'de-DE', { hour: '2-digit', minute: '2-digit' });
      b.appendChild(note('ok', T('key.ok_head'), T('key.ok_text', { at: at }) + ' ' + T(S.clearPassword ? 'key.ok_pw_gone' : 'key.ok_pw_kept')));
      var kv = el('div', { class: 'rmx-kv rm-kv-left' });
      var add = function (k, v, mono) { kv.appendChild(el('span', { text: k })); kv.appendChild(el('b', { class: mono ? 'mono' : null, text: v })); };
      add(T('key.kv_account'), r.account || user());
      if (r.fingerprint) add(T('key.kv_key'), String(r.fingerprint.alg || '').replace(/^ssh-/, '').toUpperCase() + ' SHA256:' + r.fingerprint.sha256, true);
      add(T('key.kv_path'), r.path || '–', true);
      add(T('key.kv_from'), r.from && r.from.length ? T('key.only_from', { list: r.from.join(', ') }) : T('key.from_any'));
      if (r.hostKey) add(T('key.kv_host'), T('key.host_pinned', { alg: r.hostKey.alg }));
      add(T('key.kv_vault'), T(S.clearPassword ? 'key.vault_cleared' : 'key.vault_kept'));
      b.appendChild(kv);
      b.appendChild(stepList());
      var connect = o.connect ? btn(T('key.connect_now'), function () { dlg.close(S.saved); o.connect(S.saved); }, 'btn-primary') : null;
      foot([sp(), btn(T('key.finish'), function () { dlg.close(S.saved); }, connect ? '' : 'btn-primary'), connect]);
    }

    // ── sudo (5b) ──
    function sudoView() {
      var b = dlg.body;
      var denied = S.error.code === 'sudo_denied';
      S.steps = Object.assign({}, S.steps || {});
      S.steps.install = { state: 'fail', detail: T(denied ? 'key.sudo_denied_step' : 'key.sudo_pw_step', { name: S.user }) };
      b.appendChild(stepList());
      var alt = el('div', { class: 'rm-alt' }, [el('b', { text: T('key.sudo_other_head', { name: S.user }) }), el('span', { class: 'rmx-small', text: T('key.sudo_other', { name: S.user }) }),
        el('div', { class: 'acts' }, [btn(T('key.instead_self', { name: S.user }), function () { S.account = 'self'; S.error = null; S.sudo = ''; install(); }, 'btn-sm')])]);
      if (!denied) {
        var sp2 = el('input', { class: 'form-input', type: 'password', id: 'rmk-sudo', maxlength: '1024', autocomplete: 'off', value: S.sudo });
        sp2.addEventListener('input', function () { S.sudo = sp2.value; });
        sp2.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); if (S.sudo) install(); } });
        b.appendChild(note('warn', T('key.sudo_pw_head'), T('key.sudo_pw_text')));
        b.appendChild(el('div', { class: 'rmx-field' }, [el('label', { for: 'rmk-sudo', text: T('key.sudo_pw') }), sp2]));
        b.appendChild(alt);
        foot([btn(T('common.cancel'), function () { dlg.close(null); }, 'rmx-ghost'), sp(), btn(T('key.sudo_go'), function () { if (S.sudo) install(); else sp2.focus(); }, 'btn-primary')]);
        setTimeout(function () { try { sp2.focus(); } catch (e) { /* gone */ } }, 0);
        return;
      }
      b.appendChild(note('err', T('error.sudo_denied'), T('key.sudo_denied_text', { name: S.user })));
      b.appendChild(alt);
      foot([btn(T('common.cancel'), function () { dlg.close(null); }, 'rmx-ghost')]);
    }

    // ── the copy way and the agent (5c) ──
    function copyView() {
      var b = dlg.body;
      var posix = S.error.code !== 'not_posix';
      dlg.setTitle(T('key.manual_title'), subLine());
      b.appendChild(note('warn', T(posix ? 'key.pwoff_head' : 'key.notposix_head'), T(posix ? 'key.pwoff_text' : 'key.notposix_text')));
      var lineBox = el('div', { class: 'rm-line' }, [el('span', { class: 'rm-hint' }, [el('span', { class: 'rm-spin' }), ' ', T('common.loading')])]);
      var w1 = el('div', { class: 'rm-way1' }, [el('b', { text: T('key.way1') }), lineBox,
        el('p', { class: 'rmx-small', text: posix ? T('key.way1_text', { name: user() }) : T('key.way1_windows') })]);
      var test = btn(T('key.way1_test'), function () {
        test.disabled = true;
        P.api('POST', 'admin/devices/' + dev.id + '/test-key').then(function (r) {
          S.saved = r.device;
          if (r.result && r.result.ok) { P.toast(T('key.way1_ok')); dlg.close(r.device); return; }
          var c = r.result && r.result.error ? r.result.error.code : 'key_test_failed';
          P.toast(T('key.e.' + c) !== 'key.e.' + c ? T('key.e.' + c) : T('error.' + c), 'error');
        }).catch(P.warn).then(function () { test.disabled = false; });
      }, 'btn-sm');
      w1.appendChild(el('div', { class: 'acts' }, [test]));
      b.appendChild(w1);
      if (posix) {
        b.appendChild(el('div', { class: 'rm-way2' }, [el('b', { text: T('key.way2') }), el('p', { class: 'rmx-small', text: T('key.way2_text') }),
          o.onAgent ? el('div', { class: 'acts' }, [btn(T('key.way2_go'), function () { dlg.close(S.saved); o.onAgent(dev); }, 'btn-sm')]) : null]));
      }
      foot([sp(), btn(T('common.close'), function () { dlg.close(S.saved); }, 'btn-primary')]);
      var show = function (line) {
        P.clear(lineBox);
        var cb = P.iconBtn({ icon: 'copy', label: T('key.copy_line'), cls: 'rm-copy', onClick: function () { P.copy(line, cb); } });
        lineBox.appendChild(el('code', { class: 'rm-fp', text: line }));
        lineBox.appendChild(cb);
      };
      if (S.line) { show(S.line); return; }
      P.api('POST', 'admin/devices/' + dev.id + '/key', { username: S.user || undefined }).then(function (r) { S.line = r.line || r.publicKey; S.saved = r.device; show(S.line); })
        .catch(function (e) { P.clear(lineBox).appendChild(el('span', { class: 'rm-field-error', text: P.errText(e) })); });
    }

    // ── the calls ──
    function start() {
      if (!S.user && S.account !== 'root') { var u = dlg.body.querySelector('#rmk-user'); if (u) u.focus(); return; }
      if (!S.user) { var u2 = dlg.body.querySelector('#rmk-user'); if (u2) u2.focus(); return; }
      if (!S.password) { var p = dlg.body.querySelector('#rmk-pw'); if (p) p.focus(); return; }
      S.error = null; S.pwBad = false; S.confirm = null;
      S.steps = null; S.running = 'connect';
      S.view = 'running';
      render();
      var t0 = Date.now();
      P.api('POST', 'admin/devices/' + dev.id + '/hostkey-scan').then(function (r) {
        S.scan = Object.assign({ ms: Date.now() - t0 }, r.hostKey);
        if (!r.hostKey.pinned) { S.view = 'confirm'; render(); return; }
        if (r.hostKey.matches === false) { fail({ code: 'host_key_mismatch', step: 'hostkey' }); return; }
        install();
      }).catch(function (e) { fail({ code: (e && e.data && e.data.code) || 'unreachable', step: 'connect', text: P.errText(e) }); });
    }
    function install() {
      S.view = 'running';
      S.steps = { connect: { state: 'done', ms: S.scan && S.scan.ms, detail: detailOf('connect') }, hostkey: { state: 'done', detail: detailOf('hostkey') } };
      S.running = 'install';
      render();
      var body = { username: S.user, password: S.password, account: S.account, restrictFrom: S.restrictFrom, clearPassword: S.clearPassword, replaceOwnKey: S.replaceOwnKey };
      if (S.confirm) body.confirm = S.confirm;
      if (S.account === 'root' && S.sudo) body.sudoPassword = S.sudo;
      P.api('POST', 'admin/devices/' + dev.id + '/install-key', body).then(function (r) {
        S.saved = r.device;
        S.result = r.result;
        S.steps = {};
        (r.result.steps || []).forEach(function (s) { S.steps[s.id] = { state: s.state, ms: s.ms, detail: detailOf(s.id) + (s.id === 'connect' && s.detail ? ' · ' + s.detail : '') }; });
        if (S.steps.install) S.steps.install.detail = (r.result.path || detailOf('install')) + (r.result.from && r.result.from.length ? ' · ' + T('key.only_from', { list: r.result.from.join(', ') }) : '');
        S.password = ''; S.sudo = '';
        S.running = null;
        S.view = 'done';
        if (o.onSaved) o.onSaved(r.device);
        render();
      }).catch(function (e) {
        var d = (e && e.data) || {};
        if (d.line) S.line = d.line;
        fail({ code: d.code || 'internal', step: d.step || null, text: P.errText(e), steps: d.steps, rolledBack: d.rolledBack }, d.attemptsLeft);
      });
    }
    function fail(err, left) {
      S.running = null;
      S.error = err;
      if (left != null) S.attemptsLeft = left;
      if (err.steps && err.steps.length) { S.steps = {}; err.steps.forEach(function (s) { S.steps[s.id] = { state: s.state, ms: s.ms, detail: s.state === 'fail' ? null : detailOf(s.id) }; }); }
      if (err.code === 'auth_failed') { S.password = ''; S.pwBad = true; S.view = 'form'; }
      else if (err.code === 'sudo_password' || err.code === 'sudo_denied') S.view = 'sudo';
      else if (err.code === 'password_auth_off' || err.code === 'not_posix') S.view = 'copy';
      else S.view = 'form';
      render();
    }

    function render() {
      P.hideTip();
      P.clear(dlg.body);
      if (S.view !== 'copy') dlg.setTitle(S.view === 'done' ? T('key.done_title') : T('key.title'), subLine());
      if (S.view === 'form') form();
      else if (S.view === 'confirm') confirmView();
      else if (S.view === 'running') runningView();
      else if (S.view === 'done') doneView();
      else if (S.view === 'sudo') sudoView();
      else copyView();
    }
    render();
    return done;
  }

  window.RMK = { open: open };
})();
