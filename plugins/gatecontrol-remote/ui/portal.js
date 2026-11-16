/* Portal tab "Fernzugriff" (phone first, targets ≥ 44 px): the devices I may reach, their state, "Verbinden", "Aufwecken",
   and (1.1) "Code eingeben" for a Windows PC: the code from the PC → wait for the confirmation there → the session.
   1.2: SSH in GateControl's terminal — "Fortsetzen <tmux session>" / "Neue Sitzung"; the recording of a session
   ("optional": the person asks for it, "always": the hint here and on GateControl's page before the start).
   1.3: the screen of an Android phone — only watching; "Code eingeben" (or "Verbinden" ohne Code) → the person at the
   phone confirms, Android asks again → GateControl's viewer page.
   1.4: "Ansehen und steuern" for a phone whose app can be controlled (screen.control); the person at the phone chooses
   for every request — the answer may be "Nur ansehen", which the dialog says before the page opens.
   1.5: the screen of a Windows PC ("Bildschirm teilen", also Windows Home) like a phone — "Ansehen und steuern" / "Nur
   ansehen", always confirmed at the PC; a PC that also offers Remote Desktop lets the helper choose the kind. */
(function () {
  'use strict';
  var P = window.RM;
  var T = P.T, el = P.el, $ = P.$;
  var S = null;

  function busy(b, p) { b.disabled = true; return p.catch(P.warn).then(function () { b.disabled = false; }); }

  /**
   * "Code eingeben": code and kind → the request → "Warte auf Bestätigung am Gerät …" → the session (dev: a PC or phone of
   * the list, or none). pending (1.3): a request that exists already ("Verbinden" of a phone ohne Code) — straight to waiting.
   */
  function codeDialog(dev, pending, pendingMode, pendingKind) {
    var phone = !!(dev && dev.platform === 'android');
    // 1.5: a PC that shares its screen; with Remote Desktop besides it the helper chooses the kind
    var pcScreen = !!(dev && dev.platform === 'windows' && dev.screen);
    var both = pcScreen && dev.rdp === true;
    var kindSel = both ? el('select', { class: 'form-select', id: 'rm-code-kind' }, [
      el('option', { value: 'screen', text: T('portal.kind_screen') }), el('option', { value: 'rdp', text: T('portal.kind_rdp') })]) : null;
    var kindOf = function () { return kindSel ? kindSel.value : (pcScreen ? 'screen' : null); };
    // 1.4: a phone (1.5: a PC's screen) that can only be viewed (Play build, older app or GateControl) offers only that
    var screenViewOnly = (phone || pcScreen) && !(dev.screen && dev.screen.control);
    var input = el('input', { class: 'form-input rm-code-input', type: 'text', id: 'rm-code-in', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '11', placeholder: '000-000-000' });
    var mode = el('select', { class: 'form-select', id: 'rm-code-mode' });
    var hint = el('p', { class: 'rm-hint' });
    function modes() {
      var screenKind = phone || kindOf() === 'screen';
      var viewOnly = screenKind && screenViewOnly;
      P.clear(mode);
      if (!viewOnly) mode.appendChild(el('option', { value: 'control', text: T('portal.mode_control') }));
      mode.appendChild(el('option', { value: 'view', text: T('portal.mode_view') }));
      hint.textContent = phone ? T(viewOnly ? 'portal.phone_view_only' : 'portal.phone_hint') : (screenKind && pcScreen ? T(viewOnly ? 'portal.pc_view_only' : 'portal.pc_screen_hint') : '');
      hint.hidden = !hint.textContent;
    }
    modes();
    if (kindSel) kindSel.addEventListener('change', modes);
    var asked = null;
    var status = el('p', { class: 'rm-hint', role: 'status', 'aria-live': 'polite' });
    var host = el('div', { class: 'rm-actions' });
    var ask = el('button', { class: 'btn btn-primary', type: 'button', text: T('portal.redeem') });
    var cancel = el('button', { class: 'btn', type: 'button', text: T('common.close') });
    var form = el('div', { class: 'rm-code-form' }, [
      el('label', { class: 'form-label', for: 'rm-code-in', text: T('portal.code_label') }), input,
      el('p', { class: 'rm-hint', text: T('portal.code_hint') }),
      kindSel ? el('label', { class: 'form-label', for: 'rm-code-kind', text: T('portal.kind') }) : null, kindSel,
      el('label', { class: 'form-label', for: 'rm-code-mode', text: T('portal.mode') }), mode, hint,
    ]);
    var body = el('div', { class: 'modal-body' }, [el('h3', { class: 'rm-card-title', text: dev ? T('portal.code_title_dev', { name: dev.name }) : T('portal.code_title') }), form, status, host]);
    var ov = el('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' }, [el('div', { class: 'modal' }, [body, el('div', { class: 'modal-foot' }, [cancel, ask])])]);
    var timer = null;
    var closed = false;
    function done() { closed = true; clearTimeout(timer); ov.remove(); }
    cancel.addEventListener('click', done);
    function poll(id) {
      if (closed) return;
      P.api('GET', 'requests/' + encodeURIComponent(id)).then(function (r) {
        var st = r.request.state;
        if (st === 'waiting') { timer = setTimeout(function () { poll(id); }, 1500); return null; }
        if (st === 'allowed') {
          // a phone may allow less than asked: say so before the page opens
          status.textContent = (r.request.kind === 'screen' && asked === 'control' && r.request.mode === 'view' ? T('portal.granted_view') + ' ' : '') + T('portal.allowed');
          return P.api('POST', 'requests/' + encodeURIComponent(id) + '/connect', {}).then(function (c) {
            return P.openSession(c.session.ref, host).then(function (ok) { if (ok) done(); });
          });
        }
        var screen = r.request.kind === 'screen';
        if (st === 'ended') status.textContent = T('portal.ended');
        else if (st === 'denied') status.textContent = T(screen ? 'portal.denied_device' : 'portal.denied');
        else status.textContent = T(screen ? 'portal.expired_device' : 'portal.expired');
        ask.disabled = false;
        form.hidden = false;
        return null;
      }).catch(function (e) { status.textContent = P.errText(e); ask.disabled = false; form.hidden = false; });
    }
    ask.addEventListener('click', function () {
      ask.disabled = true;
      status.textContent = '';
      P.clear(host);
      var b = { code: input.value, mode: mode.value, via: 'browser' };
      if (dev) b.deviceId = dev.id;
      if (kindOf()) b.kind = kindOf();
      asked = mode.value;
      P.api('POST', 'code/redeem', b).then(function (r) {
        form.hidden = true;
        // a phone or PC that turned out to be view only (its app, GateControl): the helper knows before the answer
        var why = r.request.modeReason === 'pc_view_only' ? 'portal.pc_view_only' : 'portal.phone_view_only';
        status.textContent = (r.request.modeReason ? T(why) + ' ' : '') + T('portal.waiting');
        poll(r.request.id);
      }).catch(function (e) { status.textContent = P.errText(e); ask.disabled = false; });
    });
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') ask.click(); });
    document.body.appendChild(ov);
    if (pending) {
      asked = pendingMode || null;
      if (kindSel && pendingKind) kindSel.value = pendingKind;
      ask.disabled = true;
      form.hidden = true;
      status.textContent = T('portal.waiting');
      poll(pending);
      cancel.focus();
      return;
    }
    input.focus();
  }

  /** Before "Verbinden" of a terminal or a recorded device: tmux sessions to resume, a new one, the recording. */
  function connectDialog(d) {
    var status = el('p', { class: 'rm-hint', role: 'status', 'aria-live': 'polite' });
    var host = el('div', { class: 'rm-actions' });
    var list = el('div', { class: 'rm-tmux-list' });
    var rec = null;
    var parts = [el('h3', { class: 'rm-card-title', text: T('portal.connect_to', { name: d.name }) })];
    var ov;
    var done = function () { ov.remove(); };
    function go(tmux) {
      var body = {};
      if (tmux) body.tmux = tmux;
      if (rec) body.record = rec.checked;
      Array.prototype.forEach.call(ov.querySelectorAll('button'), function (b) { b.disabled = true; });
      status.textContent = '';
      P.api('POST', 'devices/' + d.id + '/connect', body).then(function (r) {
        return P.openSession(r.session.ref, host).then(function (ok) { if (ok) done(); });
      }).catch(function (e) { status.textContent = P.errText(e); }).then(function () {
        if (ov.isConnected) Array.prototype.forEach.call(ov.querySelectorAll('button'), function (b) { b.disabled = false; });
      });
    }
    if (d.tmux) {
      parts.push(el('p', { class: 'rm-hint', text: T('portal.tmux_hint') }), list);
      var name = el('input', { class: 'form-input', type: 'text', id: 'rm-tmux-new', maxlength: '32', autocomplete: 'off', spellcheck: 'false', value: d.tmux });
      parts.push(el('label', { class: 'form-label', for: 'rm-tmux-new', text: T('portal.tmux_new_name') }), name,
        el('div', { class: 'rm-actions' }, [el('button', { class: 'btn', type: 'button', text: T('portal.tmux_new'), on: { click: function () {
          var v = name.value.trim();
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(v)) { status.textContent = T('portal.tmux_bad_name'); name.focus(); return; }
          go({ create: v });
        } } })]));
      list.appendChild(el('p', { class: 'rm-hint', text: T('common.loading') }));
      P.api('GET', 'devices/' + d.id + '/tmux').then(function (r) {
        P.clear(list);
        var resumable = (r.sessions || []).filter(function (s) { return s.attachable; });
        if (r.hostKey === 'unpinned') list.appendChild(el('p', { class: 'rm-hint', text: T('portal.tmux_first') }));
        else if (!resumable.length) list.appendChild(el('p', { class: 'rm-hint', text: T('portal.tmux_none') }));
        resumable.forEach(function (s) {
          var sub = [T('portal.tmux_windows', { n: s.windows || 1 })];
          if (s.attached) sub.push(T('portal.tmux_attached'));
          if (s.activity) sub.push(P.ago(s.activity));
          list.appendChild(el('button', { class: 'btn btn-primary', type: 'button', text: T('portal.tmux_resume', { name: s.name }) + ' · ' + sub.join(' · '), on: { click: function () { go({ attach: s.name }); } } }));
        });
        if (resumable.some(function (s) { return s.name === d.tmux; })) name.value = (d.tmux + '-2').slice(0, 32);
      }).catch(function (e) { P.clear(list).appendChild(el('p', { class: 'rm-hint', text: P.errText(e) })); });
    }
    if (d.recording === 'optional') {
      rec = el('input', { type: 'checkbox', id: 'rm-rec-opt' });
      parts.push(el('label', { class: 'check' }, [rec, el('span', { text: T('portal.rec_optional') })]));
    } else if (d.recording === 'always') {
      parts.push(el('p', { class: 'rm-note' }, [el('span', { class: 'rm-rec-dot', 'aria-hidden': 'true' }), T('portal.rec_always')]));
    }
    parts.push(status, host);
    var foot = [el('button', { class: 'btn', type: 'button', text: T('common.close'), on: { click: done } })];
    if (!d.tmux) foot.push(el('button', { class: 'btn btn-primary', type: 'button', text: T('dev.connect'), on: { click: function () { go(null); } } }));
    ov = el('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' }, [el('div', { class: 'modal' }, [el('div', { class: 'modal-body' }, parts), el('div', { class: 'modal-foot' }, foot)])]);
    document.body.appendChild(ov);
    var first = ov.querySelector('.modal-foot .btn-primary') || ov.querySelector('input');
    if (first) first.focus();
  }

  function card(d) {
    var acts = el('div', { class: 'rm-actions' });
    var pc = d.kind === 'host';
    if (pc && d.ready && d.connect && d.connect.mode === 'code') {
      acts.appendChild(el('button', { class: 'btn btn-primary', type: 'button', text: T('portal.code_enter'), 'aria-label': T('portal.code_title_dev', { name: d.name }), on: { click: function () { codeDialog(d); } } }));
    } else if (d.browser && !d.maintenance && !d.credentialUnreadable && (!pc || d.ready)) {
      // 1.4: a phone that can be controlled ohne Code — "Ansehen und steuern" or "Nur ansehen" (the phone asks either way)
      // 1.5: the same for the screen of a PC; a PC with Remote Desktop besides it keeps "Remote Desktop"
      var screenDev = pc && !!d.screen;
      var screenControl = screenDev && d.screen.control;
      var connectWith = function (btn, mode, kind) {
        var body = {};
        if (mode) body.mode = mode;
        if (kind) body.kind = kind;
        busy(btn, P.api('POST', 'devices/' + d.id + '/connect', body).then(function (r) {
          // a phone or a PC's screen ohne Code: it still asks its person — wait for the answer like after a code
          if (r.request) { codeDialog(d, r.request.id, mode, kind); return null; }
          return P.openSession(r.session.ref, acts);
        }));
      };
      var screenKind = screenDev && d.platform === 'windows' ? 'screen' : null;
      var c = el('button', { class: 'btn btn-primary', type: 'button', text: screenDev ? T(screenControl ? 'portal.mode_control' : 'portal.view_screen') : T('dev.connect'), 'aria-label': T('portal.connect_to', { name: d.name }) });
      c.addEventListener('click', function () {
        // a terminal with tmux, or a recording to ask for / to announce: the dialog first
        if (!screenDev && (d.tmux || d.recording === 'optional' || d.recording === 'always')) { connectDialog(d); return; }
        connectWith(c, screenDev ? (screenControl ? 'control' : 'view') : null, screenKind);
      });
      acts.appendChild(c);
      if (screenControl) {
        var v = el('button', { class: 'btn', type: 'button', text: T('portal.view_only_btn') });
        v.addEventListener('click', function () { connectWith(v, 'view', screenKind); });
        acts.appendChild(v);
      }
      if (screenKind && d.rdp) {
        var rd = el('button', { class: 'btn', type: 'button', text: T('portal.kind_rdp') });
        rd.addEventListener('click', function () { connectWith(rd, null, 'rdp'); });
        acts.appendChild(rd);
      }
    }
    if (d.wake) {
      var w = el('button', { class: 'btn', type: 'button', text: T('dev.wake') });
      w.addEventListener('click', function () { busy(w, P.api('POST', 'devices/' + d.id + '/wake').then(function () { P.toast(T('dev.woken')); })); });
      acts.appendChild(w);
    }
    var note = null;
    if (pc && d.state === 'rdp_off' && !d.screen) note = T('portal.host_rdp_off');
    else if (d.maintenance) note = T('portal.maintenance');
    else if (d.credentialUnreadable) note = T('portal.cred_unreadable');
    else if (!d.browser) note = d.protocol === 'rdp' ? T('portal.app_only') : T('portal.no_browser');
    var sub = [];
    if (d.recording === 'always') sub.push(T('portal.rec_badge'));
    if (pc && d.platform === 'android') sub.push(T('dev.phone') + ' · ' + T(d.screen && d.screen.control ? 'portal.mode_control' : 'portal.mode_view'));
    if (pc && d.platform === 'windows' && d.screen) sub.push(T('dev.pc_screen') + ' · ' + T(d.screen.control ? 'portal.mode_control' : 'portal.mode_view'));
    if (pc && d.owner && d.owner.name) sub.push(T('portal.owner', { name: d.owner.name }));
    if (pc && d.connect) sub.push(T(d.connect.mode === 'open' ? 'portal.no_code' : 'portal.with_code'));
    if (!pc && d.lastCheck) sub.push(T('dev.checked', { ago: P.ago(d.lastCheck) }));
    return el('div', { class: 'rm-item', 'data-device': String(d.id) }, [
      el('div', { class: 'rm-item-main' }, [
        el('div', { class: 'rm-item-title', text: d.name }),
        d.description ? el('div', { class: 'rm-item-sub', text: d.description }) : null,
        sub.length ? el('div', { class: 'rm-item-sub', text: sub.join(' · ') }) : null,
        note ? el('div', { class: 'rm-item-sub', text: note }) : null,
      ]),
      el('div', { class: 'rm-badges' }, [P.protoBadge(d.protocol), P.stateBadge(d)]),
      acts,
    ]);
  }

  function draw() {
    var q = $('#rm-search').value.trim().toLowerCase();
    var box = P.clear($('#rm-list'));
    S.devices.filter(function (d) { return !q || (d.name + ' ' + (d.description || '') + ' ' + (d.tags || []).join(' ')).toLowerCase().indexOf(q) >= 0; })
      .forEach(function (d) { box.appendChild(card(d)); });
    $('#rm-none').hidden = S.devices.length > 0;
    $('#rm-search').hidden = S.devices.length < 8;
  }

  function load() {
    return P.api('GET', 'overview').then(function (r) {
      S = r;
      $('#rm-loading').hidden = true;
      $('#rm-p-card').hidden = false;
      $('#rm-code').hidden = !r.codeEntry;
      draw();
    }).catch(function (e) { $('#rm-loading').textContent = P.errText(e); });
  }

  $('#rm-search').addEventListener('input', draw);
  $('#rm-reload').addEventListener('click', load);
  $('#rm-code').addEventListener('click', function () { codeDialog(null); });
  // live: a device went online or offline (GateControl's events of this plugin)
  if (window.GC && typeof window.GC.on === 'function') {
    try { window.GC.on('event', function (ev) { if (ev && ev.type === 'devices') load(); }); } catch (e) { /* no live updates */ }
  }
  load();
})();
