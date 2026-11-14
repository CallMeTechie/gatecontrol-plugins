/* Messenger portal, 1.13.0 — „Verknüpfte Dienste“ (window.MSBridges): a person links their OWN account at another
   messenger (first WhatsApp) with the bridge that runs next to GateControl. Opened from the chat settings, and only
   offered while the server has a bridge switched on (GET me features.linked_services).

   Views of the one dialog: the overview (per service: linked since / not linked / signed out / error / locked for a
   child, where the bridges run, „outdated“), the notes before the first link (confirmed once per service), and the
   link itself — a pairing code for the phone in the hand, or a QR code for a second screen. The page asks the
   server for the next step until the phone confirmed (the server waits up to 15 s per call).

   Server: bridges.js (GET bridges, POST bridges/:network/consent | login | login/:process/:step, DELETE
   bridges/:network/login/:process | logins/:id). The code and the QR content are shown and forgotten; the QR code
   is drawn from the modules the server sends (display.matrix), never from a picture address. */
(function () {
  'use strict';
  var M = window.MS;
  var T = M.T;
  var el = M.el;

  var NOTES = { whatsapp: ['unofficial', 'ban', 'phone', 'e2e'] };
  var FLOWS = ['phone', 'qr'];
  var open = null; // the open dialog: { body, close, run (the link in progress), alive }

  function dateOf(isoStr) {
    var d = isoStr ? new Date(isoStr) : null;
    if (!d || isNaN(d.getTime())) return '';
    return d.toLocaleDateString(M.LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function mark(id) { return el('span', { class: 'ms-br-mark', 'aria-hidden': 'true', text: T('admin.br_mark_' + id) }); }
  function name(id) { return T('admin.br_net_' + id); }
  function pill(text, tone) { return el('span', { class: 'ms-pill' + (tone ? ' is-' + tone : ''), text: text }); }
  function note(iconName, text, cls) { return el('p', { class: 'ms-note' + (cls ? ' ' + cls : '') }, [M.icon(iconName, 14), el('span', { text: text })]); }
  function busy(btn, on) { if (btn) btn.disabled = !!on; }

  function show(nodes) {
    if (!open) return;
    M.clear(open.body);
    nodes.forEach(function (n) { if (n) open.body.appendChild(n); });
    open.body.scrollTop = 0;
  }

  /** The login of a service that matters most: a linked one, else one that was signed out or failed. */
  function mainLogin(n) {
    var order = ['connected', 'connecting', 'error', 'logged_out', 'unknown'];
    var best = null;
    (n.logins || []).forEach(function (l) { if (!best || order.indexOf(l.state) < order.indexOf(best.state)) best = l; });
    return best;
  }

  // ── overview ──
  function row(n) {
    var l = mainLogin(n);
    var sub;
    var right = [];
    var relink = function (label) {
      return el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: label, on: { click: function () { begin(n); } } });
    };
    var unlink = function (label) {
      return el('button', { type: 'button', class: 'btn btn-sm', text: label, on: { click: function () { disconnect(n, l); } } });
    };
    if (n.state === 'unreachable' || n.state === 'starting' || n.state === 'failed') {
      sub = T(n.state === 'starting' ? 'br.sub_starting' : 'br.sub_unreachable');
      right.push(pill(T(n.state === 'starting' ? 'br.pill_starting' : 'br.pill_unreachable'), 'limit'));
    } else if (l && (l.state === 'connected' || l.state === 'connecting')) {
      sub = (l.since ? T('br.sub_linked_since', { date: dateOf(l.since) }) : T('br.sub_linked')) + (l.name ? ' · ' + l.name : '');
      right.push(n.outdated ? pill(T('br.pill_outdated'), 'limit') : pill(T('br.pill_linked')));
      right.push(unlink(T('br.unlink')));
    } else if (l && l.state === 'logged_out') {
      sub = (l.since ? T('br.sub_logged_out_at', { date: dateOf(l.since) }) : T('br.sub_logged_out')) + ' ' + T('br.sub_logged_out_' + n.id);
      right.push(pill(T('br.pill_logged_out'), 'error'));
    } else if (l) {
      sub = T('br.sub_error');
      right.push(pill(T('br.pill_error'), 'error'));
      right.push(unlink(T('br.unlink')));
    } else if (!n.allowed) {
      sub = T('br.sub_locked');
      right.push(pill(T('br.pill_locked'), 'off'));
    } else {
      sub = T('br.sub_none');
      right.push(relink(T('br.link')));
    }
    var out = [el('div', { class: 'ms-brp-row' }, [
      mark(n.id),
      el('span', { class: 'ms-brp-tx' }, [el('b', { text: name(n.id) }), el('small', { text: sub })]),
      el('span', { class: 'ms-brp-act' }, right),
    ])];
    // signed out or failed: a new code is enough (the notes were confirmed before)
    if (l && (l.state === 'logged_out' || l.state === 'error' || l.state === 'unknown') && n.state === 'running') {
      out.push(el('div', { class: 'ms-brp-again' }, [
        el('span', { class: 'ms-brp-tx' }, [el('b', { text: T('br.relink') }), el('small', { text: T(n.allowed ? 'br.relink_hint' : 'br.sub_locked') })]),
        n.allowed ? relink(T('br.relink_btn', { name: name(n.id) })) : null,
        l.state === 'logged_out' ? el('button', { type: 'button', class: 'btn btn-sm', text: T('br.forget'), on: { click: function () { disconnect(n, l, true); } } }) : null,
      ]));
    }
    return out;
  }

  function overview(b) {
    var nodes = [el('p', { class: 'ms-brp-lead', text: T('br.lead') })];
    var outdated = b.networks.filter(function (n) { return n.outdated; });
    if (outdated.length) nodes.push(note('info', T('br.outdated_banner', { name: name(outdated[0].id) }), 'ms-brp-warn'));
    var list = el('div', { class: 'ms-brp-list' });
    b.networks.forEach(function (n) { row(n).forEach(function (r) { list.appendChild(r); }); });
    if (!b.networks.length) list.appendChild(el('p', { class: 'ms-muted', text: T('br.none_offered') }));
    nodes.push(list);
    if (b.networks.length) {
      nodes.push(el('div', { class: 'ms-brp-row is-plain' }, [
        el('span', { class: 'ms-brp-tx' }, [el('b', { text: T('br.runs_on') }), el('small', { text: T('br.runs_on_' + (b.location === 'server' ? 'server' : 'gateway')) + ' · ' + T(outdated.length ? 'br.runs_outdated' : 'br.runs_current') })]),
        outdated.length ? pill(T('br.pill_outdated'), 'limit') : pill(T('br.pill_ok')),
      ]));
      if (outdated.length) nodes.push(el('p', { class: 'ms-brp-foot', text: T('br.outdated_hint') }));
      nodes.push(el('p', { class: 'ms-brp-foot', text: T('br.foot_unlink') }));
      nodes.push(note('lock', T('br.foot_preview')));
    }
    show(nodes);
  }

  function load() {
    if (!open) return;
    stopRun(false);
    show([el('p', { class: 'ms-muted', text: T('br.loading') })]);
    M.api('GET', 'bridges').then(function (r) {
      if (!open) return;
      var b = r.bridges || {};
      if (!b.available) { show([el('p', { class: 'ms-muted', text: T('br.none_offered') })]); return; }
      overview(b);
    }).catch(function (e) { show([el('p', { class: 'ms-muted', text: M.errText(e) })]); });
  }

  function disconnect(n, l, quiet) {
    var go = function () {
      M.api('DELETE', 'bridges/' + n.id + '/logins/' + encodeURIComponent(l.id)).then(function () {
        if (!quiet) M.toast(T('br.unlinked', { name: name(n.id) }));
        load();
      }).catch(function (e) { M.warn(e); load(); });
    };
    if (quiet) { go(); return; }
    M.confirm(T('br.unlink_confirm', { name: name(n.id) }), T('br.unlink'), true).then(function (ok) { if (ok) go(); });
  }

  // ── the notes before the first link ──
  function begin(n) {
    if (n.consent) { link(n, 'phone'); return; }
    var box = el('input', { type: 'checkbox', id: 'ms-brp-ok' });
    var next = el('button', { type: 'button', class: 'btn btn-primary', text: T('br.next'), disabled: true });
    box.addEventListener('change', function () { next.disabled = !box.checked; });
    next.addEventListener('click', function () {
      busy(next, true);
      M.api('POST', 'bridges/' + n.id + '/consent', { accept: true }).then(function () { n.consent = true; link(n, 'phone'); })
        .catch(function (e) { busy(next, false); M.warn(e); });
    });
    show([
      head(T('br.notes_title', { name: name(n.id) })),
      el('ul', { class: 'ms-brp-notes' }, (NOTES[n.id] || []).map(function (k) { return el('li', { text: T('br.note_' + n.id + '_' + k) }); })),
      el('label', { class: 'ms-brp-check', for: 'ms-brp-ok' }, [box, el('span', { text: T('br.notes_confirm') })]),
      el('div', { class: 'ms-brp-bar' }, [el('span', { class: 'ms-muted', text: T('br.notes_free') }), next]),
    ]);
  }

  function head(title) {
    return el('div', { class: 'ms-brp-head' }, [
      el('button', { type: 'button', class: 'ms-ib ms-ib-flat', 'aria-label': T('common.back'), title: T('common.back'), on: { click: load } }, [M.icon('back', 18)]),
      el('b', { text: title }),
    ]);
  }

  // ── the link itself ──
  /** End what is in progress; with tell: ask the bridge to drop the login as well. */
  function stopRun(tell) {
    var r = open && open.run;
    if (!r) return;
    open.run = null;
    r.stopped = true;
    clearTimeout(r.timer);
    if (tell && r.process) M.api('DELETE', 'bridges/' + r.net + '/login/' + encodeURIComponent(r.process)).catch(function () {});
  }

  function tabs(n, flow) {
    return el('div', { class: 'ms-brp-tabs', role: 'tablist' }, FLOWS.map(function (f) {
      return el('button', { type: 'button', role: 'tab', class: 'ms-chip', 'aria-pressed': f === flow ? 'true' : 'false', 'aria-selected': f === flow ? 'true' : 'false', text: T('br.flow_' + f),
        on: { click: function () { if (f !== flow) { stopRun(true); link(n, f); } } } });
    }));
  }

  function steps(keys) { return el('ol', { class: 'ms-brp-steps' }, keys.map(function (k) { return el('li', { text: T(k) }); })); }

  function failed(n, flow, e) {
    var code = M.errCode(e);
    var reason = e && e.data && e.data.reason;
    var text = code === 'bridge_failed' && /timeout|expired/.test(String(reason || '')) ? T('br.err_expired') : M.errText(e);
    show([
      head(T('br.link_title', { name: name(n.id) })), tabs(n, flow),
      note('info', text, 'ms-brp-warn'),
      el('div', { class: 'ms-brp-bar' }, [el('span'), el('button', { type: 'button', class: 'btn btn-primary', text: T(flow === 'phone' ? 'br.new_code' : 'br.new_qr'), on: { click: function () { link(n, flow); } } })]),
    ]);
  }

  function qrSvg(matrix) {
    var NS = 'http://www.w3.org/2000/svg';
    var q = 4; // quiet zone, in modules
    var size = matrix.size + 2 * q;
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    s.setAttribute('class', 'ms-brp-qr');
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', T('br.qr_alt'));
    s.setAttribute('shape-rendering', 'crispEdges');
    var bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', size); bg.setAttribute('height', size); bg.setAttribute('fill', '#fff');
    s.appendChild(bg);
    var d = '';
    matrix.rows.forEach(function (rowBits, y) {
      for (var x = 0; x < rowBits.length; x++) if (rowBits.charAt(x) === '1') d += 'M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z';
    });
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d); p.setAttribute('fill', '#000');
    s.appendChild(p);
    return s;
  }

  function codeBoxes(code) {
    var wrap = el('div', { class: 'ms-brp-code', role: 'group', 'aria-label': T('br.code_label') + ' ' + code });
    String(code).split('').forEach(function (ch) {
      wrap.appendChild(ch === '-' || ch === ' ' ? el('span', { class: 'ms-brp-dash', 'aria-hidden': 'true', text: '–' }) : el('span', { class: 'ms-brp-digit', 'aria-hidden': 'true', text: ch }));
    });
    return wrap;
  }

  /** Draw a step that shows something and wait for the phone. */
  function showWait(n, flow, run, step) {
    var d = step.display || {};
    var nodes = [head(T('br.link_title', { name: name(n.id) })), tabs(n, flow)];
    if (d.type === 'qr' && d.matrix && d.matrix.rows) {
      nodes.push(el('p', { class: 'ms-brp-lead', text: T('br.qr_lead_' + n.id) }));
      nodes.push(el('div', { class: 'ms-brp-qrbox' }, [qrSvg(d.matrix)]));
      nodes.push(steps(['br.qr_step1_' + n.id, 'br.qr_step2_' + n.id]));
      nodes.push(note('info', T('br.qr_one_phone')));
    } else if (d.type === 'code' && d.data) {
      nodes.push(el('p', { class: 'ms-brp-lead', text: T('br.code_lead', { name: name(n.id) }) }));
      nodes.push(codeBoxes(d.data));
      nodes.push(steps(['br.code_step1_' + n.id, 'br.code_step2_' + n.id, 'br.code_step3']));
      nodes.push(el('p', { class: 'ms-brp-foot', text: T('br.code_note') }));
    } else {
      failed(n, flow, { data: { code: 'bridge_unsupported' } });
      stopRun(true);
      return;
    }
    nodes.push(el('p', { class: 'ms-brp-wait', role: 'status' }, [el('span', { class: 'ms-brp-dot', 'aria-hidden': 'true' }), T('br.waiting')]));
    show(nodes);
    poll(n, flow, run, step.id);
  }

  function poll(n, flow, run, stepId) {
    if (run.stopped) return;
    M.api('POST', 'bridges/' + n.id + '/login/' + encodeURIComponent(run.process) + '/' + encodeURIComponent(stepId)).then(function (r) {
      if (run.stopped) return;
      var lg = r.login || {};
      if (lg.waiting) { run.timer = setTimeout(function () { poll(n, flow, run, stepId); }, 1500); return; }
      onStep(n, flow, run, lg);
    }).catch(function (e) {
      if (run.stopped) return;
      open.run = null; run.stopped = true;
      failed(n, flow, e);
    });
  }

  function onStep(n, flow, run, lg) {
    var step = lg.step || {};
    run.process = lg.processId || run.process;
    if (step.type === 'complete') {
      open.run = null; run.stopped = true;
      M.toast(T('br.linked', { name: name(n.id) }));
      load();
    } else if (step.type === 'display_and_wait') {
      showWait(n, flow, run, step); // WhatsApp renews the QR code a few times: each one is a new step
    } else if (step.type === 'user_input') {
      askPhone(n, flow, run, step);
    } else {
      stopRun(true);
      failed(n, flow, { data: { code: 'bridge_unsupported' } });
    }
  }

  function askPhone(n, flow, run, step) {
    var field = (step.fields || [])[0] || { id: 'phone_number' };
    var input = el('input', { type: 'tel', class: 'form-input', id: 'ms-brp-phone', inputmode: 'tel', autocomplete: 'tel', placeholder: T('br.phone_placeholder') });
    var err = el('p', { class: 'ms-brp-err', role: 'alert', hidden: true });
    var go = el('button', { type: 'button', class: 'btn btn-primary', text: T('br.get_code') });
    var submit = function () {
      var v = input.value.replace(/[\s()\/.-]/g, '');
      if (v.indexOf('00') === 0) v = '+' + v.slice(2);
      if (!/^\+[0-9]{6,15}$/.test(v)) { err.textContent = T('br.phone_invalid'); err.hidden = false; input.focus(); return; }
      err.hidden = true;
      busy(go, true);
      var body = { input: {} };
      body.input[field.id] = v;
      M.api('POST', 'bridges/' + n.id + '/login/' + encodeURIComponent(run.process) + '/' + encodeURIComponent(step.id), body).then(function (r) {
        if (run.stopped) return;
        onStep(n, flow, run, r.login || {});
      }).catch(function (e) {
        if (run.stopped) return;
        busy(go, false);
        // a number the service does not take: stay here; everything else ends this attempt
        if (M.errCode(e) === 'bridge_failed') { err.textContent = T('br.phone_refused'); err.hidden = false; return; }
        open.run = null; run.stopped = true;
        failed(n, flow, e);
      });
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    show([
      head(T('br.link_title', { name: name(n.id) })), tabs(n, flow),
      el('label', { class: 'ms-brp-label', for: 'ms-brp-phone', text: T('br.phone_label', { name: name(n.id) }) }),
      input, err,
      el('p', { class: 'ms-brp-foot', text: T('br.phone_hint') }),
      el('div', { class: 'ms-brp-bar' }, [el('span'), go]),
    ]);
    setTimeout(function () { input.focus(); }, 30);
  }

  function link(n, flow) {
    stopRun(true);
    var run = { net: n.id, process: null, stopped: false, timer: null };
    open.run = run;
    show([head(T('br.link_title', { name: name(n.id) })), tabs(n, flow), el('p', { class: 'ms-muted', text: T('br.loading') })]);
    M.api('POST', 'bridges/' + n.id + '/login', { flow: flow }).then(function (r) {
      if (run.stopped) {
        // closed while the bridge was still answering: drop what it started
        var pid = r.login && r.login.processId;
        if (pid) M.api('DELETE', 'bridges/' + n.id + '/login/' + encodeURIComponent(pid)).catch(function () {});
        return;
      }
      onStep(n, flow, run, r.login || {});
    }).catch(function (e) {
      if (run.stopped) return;
      open.run = null; run.stopped = true;
      failed(n, flow, e);
    });
  }

  function openDialog() {
    if (open) return;
    var body = el('div', { class: 'ms-brp' });
    open = { body: body, run: null };
    M.dialog(T('br.title'), body, [{ label: T('common.close'), value: null }], { wide: true }).then(function () {
      stopRun(true);
      open = null;
    });
    load();
  }

  window.MSBridges = { open: openDialog };
}());
