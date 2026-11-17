/* 1.21.0 (GET me features.chat_people): persons in the portal tab "Chats" — window.MSPersons, used by portal.js.
   One chat per human over several ways (GateControl, WhatsApp, later Signal and Telegram), only in the viewer's own
   view: the suggestion card above the list ("„Schatzimausi 💕“ bei WhatsApp ist vielleicht Jenny Backes."), the dialog
   „Zu einer Person zusammenführen?“ with the choice of the name (the account's by default), „Nicht jetzt“ and „Nicht mehr
   vorschlagen“; „Mit Person zusammenführen …“ in the chat info (an account or another chat — never guessed by name);
   „Wege von …“ with „Trennen“ (nothing is lost); the source chips of the shared history (1.27.0: no line above the
   composer any more — the placeholder names the way). The way of an answer is never chosen in the composer: the server takes the way of
   the newest incoming message — 1.27.0: unless „Nachrichten senden über“ in the chat info holds one (replySection: PUT
   persons/:id { replyPref }). Built from elements and text nodes only. */
(function () {
  'use strict';
  var M = window.MS;
  var T = M.T;
  var el = M.el;

  /** The logo of a way (GateControl's shield, WhatsApp's glyph, a speech bubble for an unknown one). */
  function mark(way, label, size) { return M.netLogo(way, label || null, size || 11, 'ms-way'); }
  function labelOf(way) { return way === 'gatecontrol' ? 'GateControl' : (way === 'whatsapp' ? 'WhatsApp' : (way === 'signal' ? 'Signal' : (way === 'telegram' ? 'Telegram' : way))); }

  /** The logos of a person's ways, in a row (behind the name in the list, under it in the head). */
  function marks(p, size) {
    var seen = {};
    var box = el('span', { class: 'ms-ways' });
    (p.ways || []).forEach(function (w) {
      if (seen[w.way]) return;
      seen[w.way] = true;
      box.appendChild(mark(w.way, T('bc.via', { network: w.label }), size));
    });
    return box;
  }

  function face(name, avatarUrl, way, label) {
    return el('span', { class: 'ms-av-wrap' }, [M.avatar({ name: name, avatarUrl: avatarUrl }, 40), way ? M.netLogo(way, T('bc.via', { network: label }), 11) : null]);
  }

  /** The suggestion card above the list (the first open suggestion). */
  function card(s, host) {
    var b = el('div', { class: 'ms-sugg', role: 'region', 'aria-label': T('person.merge_title') }, [
      face(s.contact.name, s.contact.avatarUrl, s.network, s.label),
      el('span', { class: 'ms-sugg-tx' }, [el('b', { text: s.text }), el('span', { class: 'ms-muted', text: T('person.card_sub') })]),
      el('button', { type: 'button', class: 'btn btn-sm', text: T('person.card_open'), on: { click: function () { mergeDialog(s, host); } } }),
    ]);
    return b;
  }

  /** The choice of the name (radio buttons): [{ value, label }] → { node, value() }. */
  function nameChoice(options, current) {
    var name = 'ms-pn-' + Math.random().toString(36).slice(2, 8);
    var box = el('div', { class: 'ms-pn', role: 'radiogroup', 'aria-label': T('person.merge_name') }, [el('div', { class: 'ms-sec', text: T('person.merge_name') })]);
    var radios = options.map(function (o, i) {
      var r = el('input', { type: 'radio', name: name, value: String(o.value), checked: current != null ? String(o.value) === String(current) : i === 0 });
      box.appendChild(el('label', { class: 'ms-pn-opt' }, [r, el('span', { text: o.label })]));
      return r;
    });
    return { node: box, value: function () { for (var i = 0; i < radios.length; i++) if (radios[i].checked) return options[i].value; return options[0].value; } };
  }

  /** „Zu einer Person zusammenführen?“ for a suggestion. */
  function mergeDialog(s, host) {
    var choice = nameChoice([{ value: 'account', label: s.account.name }, { value: s.conversationId, label: s.contact.name }], 'account');
    var body = el('div', { class: 'ms-merge' }, [
      el('div', { class: 'ms-pair' }, [
        face(s.contact.name, s.contact.avatarUrl, s.network, s.label),
        el('span', { class: 'ms-pair-who' }, [el('b', { text: s.contact.name }), el('small', { text: T('person.way_chat', { network: s.label }) })]),
        el('span', { class: 'ms-pair-plus', 'aria-hidden': 'true', text: '+' }),
        el('span', { class: 'ms-av-wrap' }, [M.avatar({ name: s.account.name, avatarUrl: s.account.avatarUrl, initials: s.account.initials, colorHex: s.account.colorHex }, 40), mark('gatecontrol', T('bc.via', { network: 'GateControl' }), 11)]),
        el('span', { class: 'ms-pair-who' }, [el('b', { text: s.account.name }), el('small', { text: 'GateControl' })]),
      ]),
      el('p', { class: 'ms-why' + (s.strength === 'medium' ? ' is-medium' : '') }, [M.icon(s.strength === 'medium' ? 'info' : 'check', 15), el('span', { text: s.reason })]),
      el('p', { class: 'ms-modal-msg', text: T('person.merge_text') }),
      choice.node,
    ]);
    return M.dialog(T('person.merge_title'), body, [
      { label: T('person.never'), value: 'never' },
      { label: T('person.later'), value: 'later' },
      { label: T('person.merge'), primary: true, value: 'merge' },
    ], { sheet: true }).then(function (v) {
      if (v === 'merge') {
        return host.api('POST', 'persons', { conversationIds: [s.conversationId], userId: s.userId, name: choice.value() }).then(function (r) {
          M.toast(T('person.merged'));
          host.merged(r.conversation, true);
        }).catch(M.warn);
      }
      if (v === 'later' || v === 'never') {
        return host.api('POST', 'persons/suggestions/' + encodeURIComponent(s.id), { action: v }).then(function () { host.answered(s); }).catch(M.warn);
      }
      return null;
    });
  }

  /** The name dialog of a merge by hand: the account's name and the names of the chats. */
  function confirmMerge(c, pick, host) {
    var opts = [];
    var me = c.person || null;
    if (pick.account) opts.push({ value: 'account', label: pick.account.name });
    else if (me && me.userId != null) opts.push({ value: 'account', label: (me.ways.filter(function (w) { return w.way === 'gatecontrol'; })[0] || {}).title || me.name });
    else if (!c.bridge && c.peer) opts.push({ value: 'account', label: c.peer.name || c.title });
    if (me) me.ways.forEach(function (w) { if (w.way !== 'gatecontrol') opts.push({ value: w.conversationId, label: w.title }); });
    else if (c.bridge) opts.push({ value: c.id, label: c.title });
    if (pick.chat) opts.push({ value: pick.chat.conversationId, label: pick.chat.title });
    var seen = {};
    opts = opts.filter(function (o) { if (!o.label || seen[o.label]) return false; seen[o.label] = true; return true; });
    var choice = nameChoice(opts, me ? me.nameFrom : null);
    var body = el('div', { class: 'ms-merge' }, [el('p', { class: 'ms-modal-msg', text: T('person.merge_text') }), opts.length > 1 ? choice.node : null]);
    return M.dialog(T('person.merge_title'), body, [{ label: T('common.cancel'), value: null }, { label: T('person.merge'), primary: true, value: 'merge' }]).then(function (v) {
      if (v !== 'merge') return null;
      var ids = me ? [me.conversationId] : [c.id];
      if (pick.chat) ids.push(pick.chat.conversationId);
      var req = { conversationIds: ids };
      if (pick.account) req.userId = pick.account.userId;
      if (opts.length) req.name = choice.value();
      return host.api('POST', 'persons', req).then(function (r) { M.toast(T('person.merged')); host.merged(r.conversation, true); }).catch(M.warn);
    });
  }

  /** „Mit Person zusammenführen …“: an account (when the chat has none) or another chat with one person. */
  function pickDialog(c, host) {
    var cid = c.person ? c.person.conversationId : c.id;
    return host.api('GET', 'persons/candidates?conversationId=' + encodeURIComponent(cid)).then(function (r) {
      var q = el('input', { class: 'form-input', type: 'search', placeholder: T('portal.search_people'), 'aria-label': T('portal.search_people') });
      var list = el('div', { class: 'ms-people' });
      var closeFn = null;
      var draw = function () {
        M.clear(list);
        var s = q.value.trim().toLowerCase();
        var hit = function (n) { return !s || String(n || '').toLowerCase().indexOf(s) >= 0; };
        var accs = (r.accounts || []).filter(function (a) { return hit(a.name); });
        var chats = (r.chats || []).filter(function (x) { return hit(x.title); });
        if (accs.length) list.appendChild(el('div', { class: 'ms-sec', text: T('person.pick_accounts') }));
        accs.forEach(function (a) {
          list.appendChild(el('button', { type: 'button', class: 'ms-person', on: { click: function () { if (closeFn) closeFn(null); confirmMerge(c, { account: a }, host); } } }, [
            el('span', { class: 'ms-av-wrap' }, [M.avatar({ name: a.name, avatarUrl: a.avatarUrl, initials: a.initials, colorHex: a.colorHex }, 34), mark('gatecontrol', T('bc.via', { network: 'GateControl' }), 10)]),
            el('span', { class: 'ms-person-tx' }, [el('b', { text: a.name }), el('small', { text: 'GateControl' })]),
          ]));
        });
        if (chats.length) list.appendChild(el('div', { class: 'ms-sec', text: T('person.pick_chats') }));
        chats.forEach(function (x) {
          list.appendChild(el('button', { type: 'button', class: 'ms-person', on: { click: function () { if (closeFn) closeFn(null); confirmMerge(c, { chat: x }, host); } } }, [
            el('span', { class: 'ms-av-wrap' }, [M.avatar({ name: x.title, avatarUrl: x.avatarUrl }, 34), M.netLogo(x.network, T('bc.via', { network: x.label }), 10)]),
            el('span', { class: 'ms-person-tx' }, [el('b', { text: x.title }), el('small', { text: T('person.way_chat', { network: x.label }) })]),
          ]));
        });
        if (!accs.length && !chats.length) list.appendChild(el('p', { class: 'ms-list-empty', text: T('person.pick_none') }));
      };
      q.addEventListener('input', draw);
      draw();
      return M.dialog(T('person.pick_title'), el('div', {}, [el('p', { class: 'ms-note', text: T('person.pick_hint') }), q, list]), [], { onOpen: function (done) { closeFn = done; } });
    }).catch(M.warn);
  }

  /** „Wege von …“ in the chat info: each way with its logo and „Trennen“; the name; „Mit Person zusammenführen …“. */
  function waysSection(c, host) {
    var p = c.person;
    var sec = el('div', { class: 'ms-info-sec ms-ways-sec' }, [el('div', { class: 'ms-sec', text: T('person.ways_title', { name: p.name || c.title }) })]);
    p.ways.forEach(function (w) {
      var sub = w.way === 'gatecontrol' ? T('person.way_account', { name: w.title || '' }) : T('person.way_as', { name: w.title || '' });
      sec.appendChild(el('div', { class: 'ms-wrow' }, [
        mark(w.way, null, 16),
        el('span', { class: 'ms-wrow-tx' }, [el('b', { text: w.label }), el('small', { text: sub })]),
        el('button', { type: 'button', class: 'ms-linkbtn', text: T('person.split'), on: { click: function () {
          M.confirm(T('person.split_q', { network: w.label }), T('person.split')).then(function (ok) {
            if (!ok) return;
            host.api('DELETE', 'persons/' + p.id + '/ways/' + w.conversationId).then(function (r) { M.toast(T('person.split_done')); host.split(r); }).catch(M.warn);
          });
        } } }),
      ]));
    });
    // the name in the list: the account's or a way's
    var opts = [];
    if (p.userId != null) opts.push({ value: 'account', label: (p.ways.filter(function (w) { return w.way === 'gatecontrol'; })[0] || {}).title || p.name });
    p.ways.forEach(function (w) { if (w.way !== 'gatecontrol') opts.push({ value: String(w.conversationId), label: w.title }); });
    if (opts.length > 1) {
      var sel = el('select', { class: 'form-select', 'aria-label': T('person.merge_name') }, opts.map(function (o) { return el('option', { value: o.value, text: o.label }); }));
      sel.value = p.nameFrom == null ? opts[0].value : String(p.nameFrom);
      sel.addEventListener('change', function () {
        host.api('PATCH', 'persons/' + p.id, { name: sel.value === 'account' ? 'account' : Number(sel.value) }).then(function (r) { host.merged(r.conversation, true); }).catch(M.warn);
      });
      sec.appendChild(el('div', { class: 'ms-kv' }, [el('span', {}, [M.icon('pen', 16), T('person.merge_name')]), sel]));
    }
    sec.appendChild(el('p', { class: 'ms-note', text: T('person.split_note') }));
    sec.appendChild(el('button', { type: 'button', class: 'btn btn-sm', on: { click: function () { pickDialog(c, host); } } }, [M.icon('plus', 14), T('person.add_way')]));
    return sec;
  }

  /**
   * 1.27.0: „Nachrichten senden über“ in the chat info — Automatisch (· gerade <Weg>), Immer GateControl, Immer <Netz>:
   * only the ways the person has. An answer to a message still goes back over that message's way.
   */
  function replySection(c, host) {
    var p = c.person;
    var pref = p.replyPref || 'auto';
    var hasGc = p.ways.some(function (w) { return w.way === 'gatecontrol'; });
    var name = 'ms-rp-' + Math.random().toString(36).slice(2, 8);
    var sec = el('div', { class: 'ms-info-sec ms-reply-sec', role: 'radiogroup', 'aria-label': T('reply.title') }, [el('div', { class: 'ms-sec', text: T('reply.title') })]);
    var opts = [{ value: 'auto', label: T('reply.auto'), sub: pref === 'auto' && p.reply ? T('reply.auto_sub', { name: p.name || c.title, way: p.reply.label }) : T('reply.auto_sub_plain', { name: p.name || c.title }) }];
    var seen = {};
    p.ways.forEach(function (w) {
      if (seen[w.way]) return;
      seen[w.way] = true;
      opts.push({ value: w.way, way: w.way, label: T('reply.always', { way: w.label }), sub: w.way === 'gatecontrol' ? T('reply.gc_sub') : (hasGc ? T('reply.net_sub', { network: w.label }) : null) });
    });
    opts.forEach(function (o) {
      var r = el('input', { type: 'radio', name: name, value: o.value, checked: o.value === pref });
      r.addEventListener('change', function () {
        if (!r.checked) return;
        host.api('PUT', 'persons/' + p.id, { replyPref: o.value }).then(function (res) { host.merged(res.conversation, true); }).catch(M.warn);
      });
      sec.appendChild(el('label', { class: 'ms-rp-opt' }, [r, o.way ? mark(o.way, null, 14) : null, el('span', { class: 'ms-rp-tx' }, [el('b', { text: o.label }), o.sub ? el('small', { text: o.sub }) : null])]));
    });
    sec.appendChild(el('p', { class: 'ms-note', text: T('reply.note') }));
    return sec;
  }

  /** 1.27.0: under the composer when „Immer <Netz>“ cannot send right now and GateControl took over. */
  function fallbackHint(network) {
    return el('div', { class: 'ms-wayhint is-fallback' }, [M.icon('info', 13), el('span', { text: T('reply.fallback', { network: network }) })]);
  }

  /** The source chips of the shared history: Alle · GateControl · WhatsApp (later Signal, Telegram). */
  function srcChips(c, current, onPick) {
    var box = el('div', { class: 'ms-chips ms-srcchips', role: 'group', 'aria-label': T('person.src') });
    var seen = {};
    var ways = [];
    c.person.ways.forEach(function (w) { if (!seen[w.way]) { seen[w.way] = true; ways.push(w); } });
    var chip = function (label, way, on) {
      box.appendChild(el('button', { type: 'button', class: 'ms-chip', 'aria-pressed': on ? 'true' : 'false', on: { click: function () { onPick(way); } } }, [way ? mark(way, null, 10) : null, label]));
    };
    chip(T('person.src_all'), null, !current);
    ways.forEach(function (w) { chip(w.label, w.way, current === w.way); });
    return box;
  }

  window.MSPersons = { mark: mark, marks: marks, labelOf: labelOf, card: card, mergeDialog: mergeDialog, pickDialog: pickDialog, waysSection: waysSection, srcChips: srcChips, replySection: replySection, fallbackHint: fallbackHint };
}());
