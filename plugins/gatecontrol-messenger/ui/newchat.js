/* Messenger portal, 1.16.0 — „Neuer WhatsApp-Chat“ (window.MSNewChat): a person who linked their own account at another
   messenger starts a chat there by phone number. Entered from „Neuer Chat“ (the line „WhatsApp-Chat mit Nummer“ under
   the tabs), only while GET bridges says the line belongs there (networks[].newChat: linked, and for a child the
   parents' second switch).

   One dialog, its states: input (country code +49 preset, „Wird geprüft als …“), checking, found, a chat that exists
   („Chat öffnen“), not at the service, invalid, too many checks (with the time of the next), the bridge not reachable,
   signed out („Neu verknüpfen“), locked for a child. Checked only on the button — every check asks the service. At
   phone width the dialog is a sheet from the bottom.

   Server: bridges.js (POST bridges/:network/resolve | chats { number }). The number is normalised here as well
   (a leading 0 goes, spaces and dashes too, a + is taken as it is) and never logged or kept by this page. */
(function () {
  'use strict';
  var M = window.MS;
  var T = M.T;
  var el = M.el;

  // country codes offered in front of the field (the first is the preset); other countries: paste the number with +
  var CODES = [['DE', '49'], ['AT', '43'], ['CH', '41'], ['NL', '31'], ['BE', '32'], ['LU', '352'], ['FR', '33'], ['IT', '39'], ['ES', '34'], ['PL', '48'], ['CZ', '420'], ['DK', '45'], ['GB', '44'], ['TR', '90'], ['US', '1']];
  var ALLOWED = /^[+0-9\s\-./()]*$/;

  /** The field and the code → { ok, e164, show, why } (why: empty | chars | short | short_de | long) */
  function parse(raw, cc) {
    var v = String(raw || '').trim();
    if (!v) return { ok: false, why: 'empty' };
    if (!ALLOWED.test(v) || v.indexOf('+', 1) > 0) return { ok: false, why: 'chars' };
    var x = v.replace(/\(0\)/g, '').replace(/[\s\-./()]/g, '');
    var code = cc;
    var rest;
    if (x.charAt(0) === '+' || x.indexOf('00') === 0) {
      x = x.charAt(0) === '+' ? x.slice(1) : x.slice(2);
      var hit = CODES.filter(function (c) { return x.indexOf(c[1]) === 0; }).sort(function (a, b) { return b[1].length - a[1].length; })[0];
      code = hit ? hit[1] : null;
      rest = hit ? x.slice(hit[1].length) : x;
    } else {
      rest = x.replace(/^0/, '');
    }
    if (code === '49') rest = rest.replace(/^0/, '');
    var all = (code || '') + rest;
    if (!/^[0-9]*$/.test(all) || !rest) return { ok: false, why: 'chars' };
    if (all.length > 15) return { ok: false, why: 'long' };
    // a German mobile number (15x, 16x, 17x) has 10 or 11 digits after +49
    if (code === '49' && /^1[5-7]/.test(rest) && rest.length < 10) return { ok: false, why: 'short_de' };
    if (all.length < 8 || rest.length < 5) return { ok: false, why: 'short' };
    var show = code ? '+' + code + ' ' + rest.slice(0, 3) + ' ' + rest.slice(3) : '+' + rest;
    return { ok: true, e164: '+' + all, show: show.trim() };
  }

  function name(n) { return T('admin.br_net_' + n); }
  function card(kind, iconNode, title, text) {
    return el('div', { class: 'ms-nc-res' + (kind ? ' is-' + kind : '') }, [
      el('span', { class: 'ms-nc-ri' }, [iconNode]),
      el('div', { class: 'ms-nc-rb' }, [el('b', { text: title }), el('span', { text: text })]),
    ]);
  }
  function spin() { return el('span', { class: 'ms-nc-spin', 'aria-hidden': 'true' }); }

  /**
   * open(n, host, opts) — n: a network of GET bridges ({ id, newChat }), host: { open(conversation, info) } where info is
   * { number, name } of a chat just started (the chat shows where it runs). 1.18.0: opts.number — a number typed into
   * the search of „Neuer Chat“ (contacts): filled in and checked at once (the person tapped „… bei WhatsApp prüfen“).
   */
  function open(n, host, opts) {
    var net = n.id;
    var label = name(net);
    var st = { view: 'input', res: null, err: null, retryAt: null, perHour: (n.newChat && n.newChat.limit && n.newChat.limit.perHour) || 10 };
    var reason = n.newChat && n.newChat.reason;
    if (reason === 'logged_out') st.view = 'loggedout';
    else if (reason === 'child_locked') st.view = 'locked';
    else if (reason === 'unreachable') st.view = 'unreach';
    else if (n.newChat && n.newChat.limit && n.newChat.limit.left === 0) { st.view = 'rate'; st.retryAt = Date.now() + n.newChat.limit.retryAfterS * 1000; }

    var closeFn = null;
    var sel = el('select', { class: 'ms-nc-cc', 'aria-label': T('nc.country') }, CODES.map(function (c) { return el('option', { value: c[1], text: c[0] + ' +' + c[1] }); }));
    var input = el('input', { class: 'form-input ms-nc-in', type: 'tel', inputmode: 'tel', autocomplete: 'tel-national', maxlength: '40', placeholder: T('nc.placeholder'), 'aria-label': T('nc.label'), id: 'ms-nc-in' });
    var okMark = el('span', { class: 'ms-nc-ok', hidden: true }, [M.icon('check', 17)]);
    var fieldWrap = el('span', { class: 'ms-nc-fi' }, [input, okMark]);
    var hint = el('p', { class: 'ms-nc-fh', id: 'ms-nc-fh', role: 'status' });
    input.setAttribute('aria-describedby', 'ms-nc-fh');
    var field = el('div', { class: 'ms-nc-fld' }, [
      el('label', { class: 'ms-nc-lb', for: 'ms-nc-in', text: T('nc.label') }),
      el('div', { class: 'ms-nc-fr' }, [sel, fieldWrap]),
      hint,
    ]);
    var resBox = el('div', { class: 'ms-nc-resbox', 'aria-live': 'polite' });
    var priv = el('p', { class: 'ms-note ms-nc-priv' }, [M.icon('lock', 14), el('span', { text: T('nc.privacy', { network: label }) })]);
    var body = el('div', { class: 'ms-nc' }, [field, resBox, priv]);
    var foot = el('div', { class: 'ms-modal-foot ms-nc-foot' });

    function cur() { return parse(input.value, sel.value); }
    function btn(text, opts) {
      var o = opts || {};
      var b = el('button', { type: 'button', class: 'btn' + (o.primary ? ' btn-primary' : '') + (o.busy ? ' is-busy' : ''), disabled: !!o.disabled }, [o.busy ? spin() : (o.icon ? M.icon(o.icon, 16) : null), text]);
      if (o.onClick && !o.disabled) b.addEventListener('click', o.onClick);
      return b;
    }
    function hintText() {
      var p = cur();
      if (st.view === 'invalid' && st.err) return { cls: 'is-err', text: st.err };
      if (st.view === 'input' && p.ok) return { cls: 'is-ok', text: T('nc.as', { number: p.show }) };
      return { cls: '', text: T('nc.hint') };
    }
    function invalidText(why) {
      if (why === 'short_de') return T('nc.invalid_short_de');
      if (why === 'short') return T('nc.invalid_short');
      if (why === 'long') return T('nc.invalid_long');
      return T('nc.invalid');
    }
    function person(tag) {
      var r = st.res || {};
      return el('div', { class: 'ms-nc-res is-ok' }, [
        el('span', { class: 'ms-av-wrap' }, [M.avatar({ name: r.name || r.show, avatarUrl: r.avatarUrl }, 64)]),
        el('div', { class: 'ms-nc-rb' }, [el('b', { text: r.name || r.show }), el('span', { class: 'ms-nc-num', text: r.show }), el('span', { class: 'ms-nc-tag', text: tag })]),
      ]);
    }
    function draw() {
      var v = st.view;
      var noField = v === 'loggedout' || v === 'locked';
      field.hidden = noField;
      priv.hidden = noField;
      var disabled = v === 'checking' || v === 'rate';
      input.disabled = disabled;
      sel.disabled = disabled;
      fieldWrap.className = 'ms-nc-fi' + (v === 'invalid' ? ' is-err' : '') + (disabled ? ' is-dis' : '') + (v === 'found' || v === 'exists' ? ' is-found' : '');
      okMark.hidden = !(v === 'found' || v === 'exists');
      // the hint goes while a result speaks for the field (as in the draft: only while typing, wrong or not found)
      var h = hintText();
      hint.hidden = ['input', 'none', 'invalid', 'failed'].indexOf(v) < 0;
      hint.className = 'ms-nc-fh' + (h.cls ? ' ' + h.cls : '');
      hint.textContent = h.text;
      M.clear(resBox);
      var p = cur();
      if (v === 'checking') resBox.appendChild(card('', spin(), T('nc.asking', { network: label }), T('nc.asking_sub')));
      else if (v === 'found') resBox.appendChild(person(T('nc.has', { network: label })));
      else if (v === 'exists') resBox.appendChild(person(T('nc.exists_tag')));
      else if (v === 'none') resBox.appendChild(card('', M.icon('userx', 18), T('nc.none_title', { network: label }), T('nc.none_text', { network: label, number: st.res ? st.res.show : p.show })));
      else if (v === 'rate') resBox.appendChild(card('warn', M.icon('clock', 18), T('nc.rate_title'), T('nc.rate_text', { n: st.perHour, network: label, time: M.hm(new Date(st.retryAt || Date.now()).toISOString()) })));
      else if (v === 'unreach') resBox.appendChild(card('err', M.icon('plug', 18), T('nc.unreach_title'), T('nc.unreach_text', { network: label })));
      else if (v === 'loggedout') resBox.appendChild(card('warn', M.icon('logout', 18), T('nc.out_title', { network: label }), T('nc.out_text', { network: label })));
      else if (v === 'locked') resBox.appendChild(card('', M.icon('lock', 18), T('nc.locked_title'), T('nc.locked_text', { network: label })));
      else if (v === 'failed') resBox.appendChild(card('err', M.icon('info', 18), T('nc.failed_title'), st.err || T('common.error')));
      M.clear(foot);
      var cancel = btn(T('common.cancel'), { onClick: function () { closeFn(null); } });
      var again = btn(T('nc.other'), { onClick: function () { st.view = 'input'; st.res = null; draw(); input.focus(); input.select(); } });
      if (v === 'checking') { foot.appendChild(cancel); foot.appendChild(btn(T('nc.checking'), { primary: true, busy: true, disabled: true })); }
      else if (v === 'found') { foot.appendChild(again); foot.appendChild(btn(T('nc.start'), { primary: true, onClick: start })); }
      else if (v === 'starting') { foot.appendChild(again); foot.appendChild(btn(T('nc.start'), { primary: true, busy: true, disabled: true })); }
      else if (v === 'exists') { foot.appendChild(again); foot.appendChild(btn(T('nc.open'), { primary: true, onClick: openExisting })); }
      else if (v === 'unreach') { foot.appendChild(cancel); foot.appendChild(btn(T('nc.retry'), { primary: true, icon: 'refresh', onClick: retry })); }
      else if (v === 'loggedout') { foot.appendChild(cancel); foot.appendChild(btn(T('nc.relink'), { primary: true, onClick: relink })); }
      else if (v === 'locked') foot.appendChild(btn(T('common.close'), { onClick: function () { closeFn(null); } }));
      else {
        foot.appendChild(cancel);
        foot.appendChild(btn(T('nc.check'), { primary: true, disabled: v === 'rate' || v === 'invalid' || p.why === 'empty', onClick: check }));
      }
    }
    function fail(e) {
      var c = M.errCode(e);
      if (c === 'invalid_number') { st.view = 'invalid'; st.err = T('nc.invalid'); }
      else if (c === 'rate_limited') {
        st.view = 'rate';
        st.retryAt = Date.now() + ((e.data && e.data.retryAfterS) || 3600) * 1000;
        if (e.data && e.data.perHour) st.perHour = e.data.perHour;
      }
      else if (c === 'bridge_unreachable' || c === 'bridge_off') st.view = 'unreach';
      else if (c === 'bridge_logged_out') st.view = 'loggedout';
      else if (c === 'bridge_locked' || c === 'child_new_chat_off') st.view = 'locked';
      else if (c === 'not_found' && st.view === 'starting') st.view = 'none';
      else { st.view = 'failed'; st.err = M.errText(e); }
      draw();
    }
    function check() {
      var p = cur();
      if (!p.ok) { st.view = 'invalid'; st.err = invalidText(p.why); draw(); return; }
      st.view = 'checking';
      st.res = null;
      draw();
      M.api('POST', 'bridges/' + net + '/resolve', { number: p.e164 }).then(function (r) {
        if (st.view !== 'checking') return;
        st.res = { e164: p.e164, show: p.show, name: r.name || null, avatarUrl: r.avatarUrl || null, existing: r.existing || null };
        st.view = !r.found ? 'none' : (r.existing ? 'exists' : 'found');
        draw();
      }).catch(fail);
    }
    function start() {
      var r = st.res;
      st.view = 'starting';
      draw();
      M.api('POST', 'bridges/' + net + '/chats', { number: r.e164 }).then(function (x) {
        closeFn(null);
        host.open(x.conversation, x.created ? { number: r.show, name: r.name } : null);
      }).catch(fail);
    }
    function openExisting() {
      var id = st.res && st.res.existing && st.res.existing.conversationId;
      M.api('GET', 'conversations/' + id).then(function (x) { closeFn(null); host.open(x.conversation, null); }).catch(fail);
    }
    /** „Erneut versuchen“: with a number check it again; opened in this state, ask whether the bridge is back. */
    function retry() {
      if (cur().why !== 'empty') { check(); return; }
      M.api('GET', 'bridges').then(function (r) {
        var x = ((r.bridges && r.bridges.networks) || []).filter(function (k) { return k.id === net; })[0];
        var why = x && x.newChat ? x.newChat.reason : 'unreachable';
        st.view = why === 'logged_out' ? 'loggedout' : (why === 'child_locked' || why === 'child_new_chat_off' ? 'locked' : (why === 'unreachable' || why === 'off' || why === 'unlinked' ? 'unreach' : 'input'));
        draw();
        if (st.view === 'input') input.focus();
      }).catch(fail);
    }
    function relink() {
      closeFn(null);
      if (window.MSBridges) window.MSBridges.open();
    }
    function typed() {
      if (st.view === 'invalid' || st.view === 'none' || st.view === 'failed') st.view = 'input';
      if (st.view === 'input') draw();
    }
    input.addEventListener('input', typed);
    sel.addEventListener('change', typed);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (st.view === 'input' || st.view === 'invalid' || st.view === 'none')) { e.preventDefault(); check(); } });
    input.addEventListener('blur', function () {
      var p = cur();
      if (st.view === 'input' && !p.ok && p.why !== 'empty') { st.view = 'invalid'; st.err = invalidText(p.why); draw(); }
    });

    var head = el('div', { class: 'ms-nc-head' }, [
      el('span', { class: 'ms-nc-hico', 'aria-hidden': 'true' }, [M.icon('dial', 20), el('span', { class: 'ms-net ms-net-' + net, text: T('admin.br_mark_' + net) })]),
      el('div', { class: 'ms-nc-ht' }, [el('b', { class: 'ms-modal-title', text: T('nc.title', { network: label }) }), el('small', { text: T('nc.sub') })]),
    ]);
    draw();
    M.dialog(T('nc.title', { network: label }), body, [], { head: head, foot: foot, sheet: true, cls: 'ms-nc-modal', onOpen: function (done) { closeFn = done; } });
    if (opts && typeof opts.number === 'string' && st.view === 'input') { input.value = opts.number; check(); }
    else if (!field.hidden && !input.disabled) setTimeout(function () { input.focus(); }, 40);
  }

  window.MSNewChat = { open: open, parse: parse };
}());
