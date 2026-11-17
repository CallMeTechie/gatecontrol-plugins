/* 1.8: „Linux-Gerät mit Agent“ — a code for gatecontrol-agent from the admin page (GateControl with gc.remote version 9):
   left for whom and how (name, owner, SSH account, tmux, desktop, who may connect — every change builds the command again,
   the code stays), right the code with its countdown, the finished command and the live state in four steps (asked every
   3 seconds while it is shown). Closing is fine: the code stays a placeholder in the list. With adopt (5b) the device made
   by hand is taken over when the agent registers. Without version 9: the way through „Benutzer › Gerät hinzufügen“.
   window.RMA.panel(box, { adopt?, enrollment?, me, name?, user?, onRegistered?, onChange?, auto? }) → { stop(), get() } */
(function () {
  'use strict';
  var P = window.RM;
  var T = P.T, el = P.el;
  var LINUX_USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/;
  var STEPS = ['created', 'redeemed', 'vpn', 'registered'];
  var people = null;

  function loadPeople() {
    if (people) return Promise.resolve(people);
    return P.api('GET', 'admin/rights').then(function (r) { people = (r.people || []).map(function (p) { return { id: p.id, name: p.name, role: p.role, share: p.effective ? p.effective.share : true }; }); return people; })
      .catch(function () { people = []; return people; });
  }

  function cmdBox(text, label) {
    var cb = P.iconBtn({ icon: 'copy', label: label || T('ag.copy_cmd'), cls: 'rm-copy', onClick: function () { P.copy(text, cb); } });
    return el('div', { class: 'rm-cmdbox' }, [el('pre', { class: 'rm-cmd' }, [el('code', { text: text })]), cb]);
  }

  /** Without version 9: the way through the user (Weg A) and the commands typed by hand. */
  function fallback(box, name) {
    P.clear(box);
    box.appendChild(el('div', { class: 'rmx-note info' }, [P.icon('info', 18), el('div', null, [el('b', { text: T('ag.old_head') }), el('span', { class: 'rmx-small', text: T('ag.old_text') })])]));
    var ol = el('ol', { class: 'rm-howto' });
    ['ag.weg_a1', 'ag.weg_a2', 'ag.weg_a3', 'ag.weg_a4', 'ag.weg_a5'].forEach(function (k) { ol.appendChild(el('li', { text: T(k) })); });
    box.appendChild(el('b', { text: T('ag.weg_a') }));
    box.appendChild(ol);
    box.appendChild(el('span', { class: 'rmx-flabel', text: T('ag.on_device') }));
    box.appendChild(cmdBox('sudo gatecontrol-agent enroll https://<server> <code> --name ' + (name || 'linux') + '\nsudo gatecontrol-agent share ssh --as <konto> --tmux\nsudo gatecontrol-agent share open'));
    box.appendChild(el('p', { class: 'rmx-small', text: T('ag.old_more') }));
  }

  function panel(box, opts) {
    var o = opts || {};
    var adopt = o.adopt || null;
    var S = {
      e: o.enrollment || null, name: o.name || (adopt ? adopt.name : ''), owner: o.me, user: o.user || '', ssh: true, tmux: true, install: true, desktop: false,
      open: true, openTouched: false, err: null, busy: false, stopped: false, timer: null, putTimer: null, tick: null,
    };
    if (S.e) {
      var op = S.e.options || {};
      S.name = S.e.name; S.owner = S.e.ownerId; S.ssh = !!op.ssh; S.user = op.ssh ? op.ssh.user : S.user; S.tmux = !!(op.ssh && op.ssh.tmux); S.install = !!(op.ssh && op.ssh.install);
      S.desktop = !!op.desktop; S.open = !!op.open; S.openTouched = true;
    }
    var left = el('div', { class: 'rm-ag-left' });
    var right = el('div', { class: 'rm-ag-right', 'aria-live': 'polite' });
    P.clear(box);
    box.appendChild(el('div', { class: 'rm-ag' }, [left, right]));

    function body() {
      var b = { name: S.name.trim(), ownerId: S.owner, ssh: S.ssh ? { user: S.user.trim(), tmux: S.tmux, install: S.tmux && S.install } : null, desktop: S.desktop, open: S.open };
      if (adopt) b.adoptDeviceId = adopt.id;
      return b;
    }
    function valid() {
      if (!S.name.trim()) return T('ag.need_name');
      if (S.ssh && S.user.trim() === 'root') return T('ag.no_root');
      if (S.ssh && !LINUX_USER_RE.test(S.user.trim())) return T('ag.need_user');
      if (!S.ssh && !S.desktop) return T('ag.need_share');
      return null;
    }
    function create(replaces) {
      var v = valid();
      if (v) { S.err = v; drawRight(); return Promise.resolve(); }
      S.busy = true; S.err = null; drawRight();
      var b = body();
      if (replaces) b.replaces = replaces;
      return P.api('POST', 'admin/enroll', b).then(function (r) { S.e = r.enrollment; if (o.onChange) o.onChange(S.e); poll(); })
        .catch(function (e) { S.err = P.errText(e); }).then(function () { S.busy = false; drawRight(); });
    }
    function update() {
      clearTimeout(S.putTimer);
      if (!S.e || S.e.state !== 'waiting') { drawRight(); return; }
      var v = valid();
      if (v) { S.err = v; drawRight(); return; }
      S.err = null;
      drawRight();
      S.putTimer = setTimeout(function () {
        var b = body();
        delete b.ownerId; delete b.adoptDeviceId;
        P.api('PUT', 'admin/enroll/' + encodeURIComponent(S.e.ticket), b).then(function (r) { S.e = r.enrollment; drawRight(); }).catch(function (e) { S.err = P.errText(e); drawRight(); });
      }, 350);
    }
    function poll() {
      clearTimeout(S.timer);
      if (S.stopped || !S.e || !box.isConnected) return;
      if (['waiting', 'redeemed'].indexOf(S.e.state) < 0) return;
      S.timer = setTimeout(function () {
        if (S.stopped || !box.isConnected) return;
        P.api('GET', 'admin/enroll/' + encodeURIComponent(S.e.ticket)).then(function (r) {
          var was = S.e.state;
          S.e = r.enrollment;
          drawRight();
          if (o.onChange) o.onChange(S.e);
          if (S.e.state === 'registered' && was !== 'registered' && o.onRegistered) o.onRegistered(S.e);
        }).catch(function () { /* next time */ }).then(poll);
      }, 3000);
    }

    // ── left: for whom and how ──
    function drawLeft() {
      P.clear(left);
      if (adopt) left.appendChild(adoptInfo());
      left.appendChild(el('div', { class: 'rm-ctitle', text: T('ag.device') }));
      var nm = el('input', { class: 'form-input', type: 'text', id: 'rma-name', maxlength: '100', value: S.name, autocomplete: 'off', spellcheck: 'false', disabled: !!adopt });
      nm.addEventListener('input', function () { S.name = nm.value; update(); });
      left.appendChild(el('div', { class: 'rmx-field' }, [el('label', { for: 'rma-name', text: T('f.name') }), nm, el('span', { class: 'rmx-small', text: T(adopt ? 'ag.name_kept' : 'ag.name_hint') })]));
      var ow = el('select', { class: 'form-select', id: 'rma-owner' });
      var list = people && people.length ? people : [{ id: o.me, name: T('ag.me'), role: 'admin', share: true }];
      list.forEach(function (p) {
        ow.appendChild(el('option', { value: String(p.id), text: p.id === o.me ? T('ag.me_name', { name: p.name }) : p.name + (p.share === false ? ' · ' + T('ag.no_share') : ''), disabled: p.share === false && p.role !== 'admin', selected: p.id === S.owner }));
      });
      ow.addEventListener('change', function () {
        S.owner = parseInt(ow.value, 10);
        if (!S.openTouched) S.open = !(S.owner !== o.me && S.desktop);
        drawLeft();
        // the code belongs to the person: another owner needs a new code
        if (S.e && S.e.state === 'waiting') create(S.e.ticket);
      });
      left.appendChild(el('div', { class: 'rmx-field' }, [el('label', { for: 'rma-owner', text: T('ag.owner') }), ow, el('span', { class: 'rmx-small', text: T('ag.owner_hint') })]));
      left.appendChild(el('div', { class: 'rm-ctitle', text: T('ag.share') }));
      left.appendChild(chk('ssh', T('ag.ssh'), T('ag.ssh_sub')));
      if (S.ssh) {
        var u = el('input', { class: 'form-input', type: 'text', id: 'rma-user', maxlength: '32', value: S.user, autocomplete: 'off', spellcheck: 'false' });
        u.addEventListener('input', function () { S.user = u.value; update(); });
        left.appendChild(el('div', { class: 'rmx-field rm-indent' }, [el('label', { for: 'rma-user', text: T('ag.account') }), u, el('span', { class: 'rmx-small', text: T(adopt && o.user ? 'ag.account_taken' : 'ag.account_hint') })]));
        left.appendChild(el('div', { class: 'rm-indent' }, [chk('tmux', T('ag.tmux'), T('ag.tmux_sub'))]));
        if (S.tmux) left.appendChild(el('div', { class: 'rm-indent' }, [chk('install', T('ag.install_tmux'), T('ag.install_tmux_sub'))]));
      }
      if (!adopt) left.appendChild(chk('desktop', T('ag.desktop'), T('ag.desktop_sub')));
      left.appendChild(el('div', { class: 'rm-ctitle', text: T('ag.who') }));
      var radio = el('div', { class: 'rmx-radio', role: 'radiogroup', 'aria-label': T('ag.who') });
      [[true, T('ag.open'), T(adopt ? 'ag.open_adopt' : 'ag.open_sub')], [false, T('ag.code'), T('ag.code_sub')]].forEach(function (x) {
        radio.appendChild(el('button', { type: 'button', class: 'rmx-ropt', role: 'radio', 'aria-checked': S.open === x[0] ? 'true' : 'false', 'aria-pressed': S.open === x[0] ? 'true' : 'false',
          on: { click: function () { S.open = x[0]; S.openTouched = true; drawLeft(); update(); } } }, [el('span', { class: 'dot' }), el('div', null, [el('b', { text: x[1] }), el('span', { text: x[2] })])]));
      });
      left.appendChild(radio);
    }
    function chk(key, title, sub) {
      var c = el('input', { type: 'checkbox', id: 'rma-' + key, checked: S[key] });
      c.addEventListener('change', function () {
        S[key] = c.checked;
        if (key === 'desktop' && !S.openTouched) S.open = !(S.owner !== o.me && S.desktop);
        drawLeft();
        update();
      });
      return el('label', { class: 'rmx-chk rm-chk2', for: 'rma-' + key }, [c, el('span', null, [el('b', { text: title }), el('small', { text: sub })])]);
    }
    function adoptInfo() {
      var c = adopt.config || {};
      var wayNow = adopt.way === 'home' ? T('ag.now_home', { addr: c.host + ':' + c.port }) : c.host + ':' + c.port;
      var authNow = adopt.auth === 'gc_key' ? T('auth.gc_key') : (adopt.auth === 'own_key' ? T('auth.own_key') : T('auth.password'));
      var kept = el('ul', { class: 'rm-kept' });
      [T('ag.kept_id', { name: adopt.name }), T('ag.kept_rights'), T('ag.kept_history'), T('ag.kept_tmux')].forEach(function (t) { kept.appendChild(el('li', null, [P.icon('ok', 14), t])); });
      kept.appendChild(el('li', { class: 'warn' }, [P.icon('warn', 14), T('ag.kept_pw')]));
      return el('div', { class: 'rm-adopt' }, [
        el('p', { class: 'rmx-small', text: T('ag.adopt_text') }),
        el('div', { class: 'rm-adopt-cols' }, [
          el('div', null, [el('span', { class: 'rmx-flabel', text: T('ag.today') }), el('b', { text: wayNow }), el('span', { text: T('ag.login', { v: authNow }) })]),
          el('div', null, [el('span', { class: 'rmx-flabel', text: T('ag.after') }), el('b', { text: T('ag.after_way') }), el('span', { text: T('ag.after_login') })]),
        ]),
        kept,
      ]);
    }

    // ── right: the code, the command, the live state ──
    function countdown() {
      var exp = S.e ? Date.parse(S.e.expiresAt) : NaN;
      var left2 = Math.max(0, Math.round((exp - Date.now()) / 1000));
      return { s: left2, text: Math.floor(left2 / 60) + ':' + ('0' + (left2 % 60)).slice(-2) };
    }
    function ownerName() {
      var p = (people || []).filter(function (x) { return x.id === S.owner; })[0];
      return S.owner === o.me ? T('ag.me_name', { name: p ? p.name : T('ag.me') }) : (p ? p.name : '#' + S.owner);
    }
    function drawRight() {
      P.hideTip();
      P.clear(right);
      if (S.err) right.appendChild(el('p', { class: 'rm-field-error', role: 'alert', text: S.err }));
      if (!S.e) {
        right.appendChild(el('div', { class: 'rm-ctitle', text: T('ag.code_title') }));
        right.appendChild(el('p', { class: 'rmx-small', text: T(adopt ? 'ag.adopt_before' : 'ag.make_hint') }));
        right.appendChild(el('div', { class: 'acts' }, [el('button', { type: 'button', class: 'btn btn-primary', disabled: S.busy, on: { click: function () { create(null); } } }, [S.busy ? el('span', { class: 'rm-spin' }) : P.icon('code'), T('ag.make')])]));
        return;
      }
      var e = S.e;
      var cd = countdown();
      var expired = e.state === 'expired' || (e.state === 'waiting' && cd.s <= 0);
      if (e.state === 'waiting' || expired) {
        right.appendChild(el('div', { class: 'rm-ctitle', text: T('ag.code_title') }));
        var codeEl = el('div', { class: 'rm-bigcode' + (expired ? ' gone' : ''), text: e.code || '––––-––––-––––-––––' });
        var cpy = e.code && !expired ? P.iconBtn({ icon: 'copy', label: T('ag.copy_code'), cls: 'rm-copy', onClick: function () { P.copy(e.code, cpy); } }) : null;
        var renew = P.iconBtn({ icon: 'renew', label: T('ag.renew'), tip: T('ag.renew_tip'), onClick: function () { create(e.ticket); } });
        right.appendChild(el('div', { class: 'rm-coderow' }, [codeEl, cpy, renew]));
        var tick = el('span', { class: 'rmx-small rm-tick', text: expired ? T('ag.expired') : T('ag.valid', { t: cd.text, owner: ownerName() }) });
        right.appendChild(tick);
        clearInterval(S.tick);
        if (!expired) S.tick = setInterval(function () { if (!tick.isConnected) { clearInterval(S.tick); return; } var c = countdown(); if (c.s <= 0) { clearInterval(S.tick); drawRight(); return; } tick.textContent = T('ag.valid', { t: c.text, owner: ownerName() }); }, 1000);
        if (expired) right.appendChild(el('div', { class: 'acts' }, [el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: T('ag.new_code'), on: { click: function () { create(e.ticket); } } })]));
      }
      if (e.command && !expired) {
        right.appendChild(el('span', { class: 'rmx-flabel', text: T('ag.on_device') }));
        right.appendChild(cmdBox(e.command));
        right.appendChild(el('p', { class: 'rmx-small', text: e.url ? T('ag.server_hint') : T('ag.server_missing') }));
        right.appendChild(el('details', { class: 'rm-inst' }, [el('summary', { text: T('ag.install') }), cmdBox('# Debian, Ubuntu, Raspberry Pi OS\ncurl -LO https://github.com/CallMeTechie/gatecontrol-linux-agent/releases/latest/download/gatecontrol-agent_$(dpkg --print-architecture).deb\nsudo apt install ./gatecontrol-agent_$(dpkg --print-architecture).deb\n# CachyOS, Arch\ncurl -LO https://github.com/CallMeTechie/gatecontrol-linux-agent/releases/latest/download/gatecontrol-agent_x86_64.pkg.tar.zst\nsudo pacman -U gatecontrol-agent_x86_64.pkg.tar.zst')]));
      }
      right.appendChild(el('div', { class: 'rm-ctitle', text: T('ag.live') }));
      right.appendChild(liveList(e));
      if (e.hint) right.appendChild(el('div', { class: 'rmx-note warn' }, [P.icon('warn', 18), el('div', null, [el('b', { text: T('ag.h.' + e.hint) }), el('span', { class: 'rmx-small', text: T('ag.h.' + e.hint + '_text', { user: S.user || '<konto>' }) })])]));
      if (e.state === 'conflict' && e.conflict) right.appendChild(conflictBox(e));
    }
    function liveList(e) {
      var ol = el('ol', { class: 'rm-steps-list live' });
      var cur = STEPS.filter(function (k) { return !e.steps[k]; })[0];
      STEPS.forEach(function (k, i) {
        var at = e.steps[k];
        var state = at ? 'done' : (k === cur && e.state !== 'expired' ? 'run' : 'wait');
        if (e.state === 'conflict' && k === 'registered') state = 'ask';
        var detail = null;
        if (k === 'created') detail = T('ag.s_created_by', { name: e.createdByName || '' });
        if (k === 'redeemed') detail = at ? T('ag.s_redeemed', { name: e.peerName || e.name, ip: e.vpnIp || '' }) : T('ag.s_redeem_wait');
        if (k === 'vpn') detail = at ? (e.vpnIp || '') : T('ag.s_vpn_wait');
        if (k === 'registered') detail = at ? T(adopt ? 'ag.s_merged' : 'ag.s_registered', { user: S.user }) : (e.state === 'conflict' ? T('ag.s_conflict') : T(adopt ? 'ag.s_merge_wait' : 'ag.s_register_wait'));
        var mark = state === 'done' ? P.icon('ok', 14, 2.6) : (state === 'run' ? el('span', { class: 'rm-spin' }) : el('b', { text: state === 'ask' ? '!' : String(i + 1) }));
        ol.appendChild(el('li', { class: 'st-' + state }, [el('span', { class: 'mk' }, [mark]), el('div', null, [el('b', { text: T('ag.s.' + k + (adopt && k === 'registered' ? '_adopt' : '')) }), detail ? el('small', { text: detail }) : null]),
          at ? el('span', { class: 'ms', text: new Date(at).toLocaleTimeString(P.CTX.lang === 'en' ? 'en-GB' : 'de-DE', { hour: '2-digit', minute: '2-digit' }) }) : null]));
      });
      return ol;
    }
    function conflictBox(e) {
      var c = e.conflict;
      var short = function (s) { return 'SHA256:' + String(s || '').slice(0, 4) + '…' + String(s || '').slice(-4); };
      var decide = function (what, b) {
        b.disabled = true;
        P.api('POST', 'admin/enroll/' + encodeURIComponent(e.ticket) + '/' + what).then(function (r) { S.e = r.enrollment; drawRight(); if (o.onRegistered) o.onRegistered(S.e); })
          .catch(P.warn).then(function () { b.disabled = false; });
      };
      var keep = el('button', { type: 'button', class: 'btn btn-sm', text: T('ag.keep'), on: { click: function () { decide('keep', keep); } } });
      var merge = el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: T('ag.merge'), on: { click: function () { decide('merge', merge); } } });
      return el('div', { class: 'rmx-note err' }, [P.icon('warn', 18), el('div', null, [el('b', { text: T('ag.conflict_head') }),
        el('code', { class: 'rm-fp', text: T('ag.pinned') + ' ' + short(c.pinned.sha256) + '\n' + T('ag.from_agent') + ' ' + short(c.agent.sha256) }),
        el('span', { class: 'rmx-small', text: T('ag.conflict_text') }), el('div', { class: 'acts' }, [keep, merge])])]);
    }

    loadPeople().then(function () { drawLeft(); drawRight(); });
    drawLeft();
    drawRight();
    if (S.e) poll();
    else if (o.auto) create(null);
    return {
      stop: function () { S.stopped = true; clearTimeout(S.timer); clearTimeout(S.putTimer); clearInterval(S.tick); },
      get: function () { return S.e; },
    };
  }

  window.RMA = { panel: panel, fallback: fallback, cmdBox: cmdBox, loadPeople: loadPeople };
})();
