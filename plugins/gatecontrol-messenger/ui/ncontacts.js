/* Messenger portal, 1.18.0 — „Neuer Chat“ with contacts (window.MSContacts; GET me features.bridge_contacts). One search
   field, three sections — GateControl, WhatsApp, „Aus deinem Adressbuch“ — and at the bottom „Nicht dabei? Nummer
   eingeben“ (the dialog of 1.16.0, ui/newchat.js). Used by portal.js newChat() in the mode „Person“.

   Server: contactchat.js (GET contacts/new-chat?q=&network=) and bridges.js (POST bridges/:network/chats { ref } |
   { contactId, phoneKind }). A WhatsApp contact starts its chat at once; an address book number is checked only when it
   is tapped (one number, counted in the brake) — never while typing. Long sections show three rows and „Alle …
   anzeigen“. A row of the address book shows its states in place: which number (several), checking, not at WhatsApp,
   too many checks, the bridge not reachable. */
(function () {
  'use strict';
  var M = window.MS;
  var T = M.T;
  var el = M.el;
  var NET = 'whatsapp';
  var FIRST = 3;
  var QUERY_MAX = 40;
  var BOOK_ICON = 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z|M5 17a3 3 0 0 1 3-3h11';
  var CHEV = 'M7 10l5 5 5-5';

  function svg(d, size) {
    var NS = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    d.split('|').forEach(function (part) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', part); s.appendChild(p); });
    return s;
  }
  function spin() { return el('span', { class: 'ms-nc-spin', 'aria-hidden': 'true' }); }
  function label() { return T('admin.br_net_' + NET); }
  function kindText(k) { return T('ncc.kind_' + String(k || 'other').replace(/-.*/, '')); }
  function hm(ms) { return M.hm(new Date(ms).toISOString()); }

  /**
   * create(host) — host: { people: [...] (GET people, shown until the first answer), openConv(id), started(conversation,
   * info), gcChat(person), numberDialog(network, opts), close() } → { box, foot, setQuery(q), show(on) }
   */
  function create(host) {
    var st = { q: null, data: null, seq: 0, timer: null, more: { wa: false, ab: false }, pick: null, rows: {}, busy: false };
    var box = el('div', { class: 'ms-people ms-ncc', role: 'list' });
    var priv = el('p', { class: 'ms-note ms-ncc-priv', hidden: true }, [M.icon('lock', 13), el('span', { text: T('ncc.privacy', { network: label() }) })]);
    var footRow = el('button', { type: 'button', class: 'ms-ncc-nfoot' }, [M.icon('dial', 17), el('span', {}, [el('span', { class: 'ms-ncc-lead', text: T('ncc.not_here') + ' ' }), T('ncc.enter_number')]), svg(CHEV, 15)]);
    footRow.addEventListener('click', function () { host.numberDialog(netState(), {}); });
    var foot = el('div', { class: 'ms-ncc-foot', hidden: true }, [priv, footRow]);

    function netState() {
      var d = st.data || {};
      var wa = d.whatsapp || {};
      var reason = wa.state === 'logged_out' ? 'logged_out' : (wa.state === 'unreachable' ? 'unreachable' : null);
      return { id: NET, newChat: { available: !reason, reason: reason, limit: d.limit || { perHour: 10, left: 10, retryAfterS: 0 } } };
    }

    function load() {
      var my = ++st.seq;
      var q = st.q || '';
      M.api('GET', 'contacts/new-chat?network=' + NET + (q ? '&q=' + encodeURIComponent(q) : '')).then(function (r) {
        if (my !== st.seq) return;
        st.data = r;
        draw();
      }).catch(function (e) {
        if (my !== st.seq) return;
        st.data = { gatecontrol: [], whatsapp: null, addressBook: null, error: M.errText(e) };
        draw();
      });
    }
    function setQuery(q) {
      var v = String(q || '').trim().slice(0, QUERY_MAX);
      if (v === st.q) return;
      var first = st.q === null;
      st.q = v;
      st.pick = null;
      st.rows = {};
      clearTimeout(st.timer);
      if (first) { draw(); load(); } else st.timer = setTimeout(load, 250);
    }

    // ── pieces ──
    function cap(icon, text, extra) {
      return el('div', { class: 'ms-ncc-cap', role: 'presentation' }, [icon, el('span', { text: text }), extra || null]);
    }
    function waMark() { return M.netLogo(NET, T('admin.br_net_' + NET), 12, 'ms-ncc-svc'); }
    function pill(text, cls) { return el('span', { class: 'ms-ncc-pill' + (cls ? ' is-' + cls : ''), text: text }); }
    function row(av, name, sub, right, opts) {
      var o = opts || {};
      var b = el(o.static ? 'div' : 'button', { class: 'ms-person ms-ncc-row' + (o.cls ? ' ' + o.cls : ''), role: 'listitem' }, [
        av, el('span', { class: 'ms-ncc-rt' }, [el('span', { class: 'ms-ncc-name', text: name }), sub ? el('small', { text: sub }) : null]), right || null,
      ]);
      if (!o.static) { b.type = 'button'; if (o.disabled) b.disabled = true; if (o.onClick) b.addEventListener('click', o.onClick); }
      return b;
    }
    function avatar(p, wa) {
      var a = el('span', { class: 'ms-av-wrap' }, [M.avatar(p, 38)]);
      if (wa) a.appendChild(M.netLogo(NET, null, 11));
      return a;
    }
    function moreRow(text, key) {
      var b = el('button', { type: 'button', class: 'ms-ncc-more' }, [el('span', { text: text }), svg(CHEV, 15)]);
      b.addEventListener('click', function () { st.more[key] = true; draw(); });
      return b;
    }
    function card(kind, icon, title, text, link, onLink) {
      var kids = [el('b', { text: title }), el('span', { text: text })];
      if (link) { var u = el('button', { type: 'button', class: 'ms-ncc-link', text: link }); u.addEventListener('click', onLink); kids.push(u); }
      return el('div', { class: 'ms-nc-res ms-ncc-res' + (kind ? ' is-' + kind : '') }, [el('span', { class: 'ms-nc-ri' }, [M.icon(icon, 16)]), el('div', { class: 'ms-nc-rb' }, kids)]);
    }
    function note(text, cls) { return el('div', { class: 'ms-ncc-note' + (cls ? ' is-' + cls : ''), text: text }); }
    function skeleton() { return el('div', { class: 'ms-ncc-sk', 'aria-hidden': 'true' }, [el('i'), el('span', {}, [el('em'), el('em')])]); }

    // ── actions ──
    function openConv(id) { host.close(); host.openConv(id); }
    function startWa(c) {
      if (st.busy) return;
      st.busy = true;
      st.rows['wa:' + c.ref] = { view: 'starting' };
      draw();
      M.api('POST', 'bridges/' + NET + '/chats', { ref: c.ref }).then(function (x) {
        st.busy = false;
        host.close();
        host.started(x.conversation, x.created ? { name: c.name, kind: 'contact' } : null);
      }).catch(function (e) {
        st.busy = false;
        delete st.rows['wa:' + c.ref];
        // the reference ran out (or the bridge forgot the contact): the list anew
        if (M.errCode(e) === 'contact_expired' || M.errCode(e) === 'not_found') { load(); return; }
        M.warn(e);
        draw();
      });
    }
    function tapBook(x, p) {
      if (st.busy) return;
      st.busy = true;
      st.pick = null;
      st.rows[x.contactId] = { view: 'checking', key: p.key };
      draw();
      M.api('POST', 'bridges/' + NET + '/chats', { contactId: x.contactId, phoneKind: p.key }).then(function (r) {
        st.busy = false;
        host.close();
        host.started(r.conversation, r.created ? { name: x.name, number: p.number, kind: 'book' } : null);
      }).catch(function (e) {
        st.busy = false;
        var c = M.errCode(e);
        var d = e && e.data ? e.data : {};
        if (c === 'not_found' && d.reason === 'not_on_network') { p.notOnNetwork = true; st.rows[x.contactId] = { view: 'none', key: p.key }; }
        else if (c === 'rate_limited') { st.rows[x.contactId] = { view: 'rate', key: p.key, at: Date.now() + (d.retryAfterS || 3600) * 1000, n: d.perHour || ((st.data && st.data.limit && st.data.limit.perHour) || 10) }; }
        else if (c === 'bridge_unreachable' || c === 'bridge_off') st.rows[x.contactId] = { view: 'unreach', key: p.key };
        else if (c === 'bridge_logged_out' || (c === 'not_found' && d.reason === 'contact_gone') || c === 'contact_expired') { st.rows = {}; load(); return; }
        else st.rows[x.contactId] = { view: 'failed', key: p.key, text: M.errText(e) };
        draw();
      });
    }

    // ── sections ──
    function gcSection(list, q) {
      if (!list.length) return null;
      var s = el('div', { class: 'ms-ncc-sec' }, [cap(M.icon('shield', 13), T('ncc.sec_gc') + ' · ' + list.length)]);
      list.forEach(function (p) {
        s.appendChild(row(avatar(p), p.name, null, p.conversationId ? pill(T('ncc.open')) : null, { onClick: function () {
          if (p.conversationId) openConv(p.conversationId); else host.gcChat(p);
        } }));
      });
      void q;
      return s;
    }
    function waSection(wa, q) {
      var s = el('div', { class: 'ms-ncc-sec' });
      var loading = !wa;
      var head = label() + (!q && wa && wa.state === 'ok' ? ' · ' + wa.total : '');
      s.appendChild(cap(waMark(), head, loading ? el('em', {}, [spin()]) : null));
      if (loading) { s.appendChild(skeleton()); s.appendChild(skeleton()); s.appendChild(skeleton()); return s; }
      if (wa.state === 'unreachable') {
        s.appendChild(card('err', 'plug', T('ncc.wa_down_title', { network: label() }), T('ncc.wa_down_text'), T('nc.retry'), function () { st.rows = {}; load(); }));
        return s;
      }
      if (wa.state === 'logged_out') {
        s.appendChild(card('warn', 'logout', T('ncc.wa_out_title', { network: label() }), T('ncc.wa_out_text', { network: label() }), T('nc.relink'), function () { host.close(); if (window.MSBridges) window.MSBridges.open(); }));
        return s;
      }
      if (!wa.items.length) return null;
      var list = q || st.more.wa ? wa.items : wa.items.slice(0, FIRST);
      list.forEach(function (c) {
        var busy = st.rows['wa:' + c.ref];
        s.appendChild(row(avatar({ name: c.name, avatarUrl: c.avatarUrl }, true), c.name, c.alsoInAddressBook ? T('ncc.also_book') : T('ncc.wa_contact', { network: label() }),
          busy ? spin() : (c.conversationId ? pill(T('ncc.open')) : null), { onClick: function () { if (c.conversationId) openConv(c.conversationId); else startWa(c); } }));
      });
      if (!q && !st.more.wa && wa.items.length > FIRST) s.appendChild(moreRow(T('ncc.all_wa', { n: wa.items.length, network: label() }), 'wa'));
      return s;
    }
    function bookSection(ab, waState, q) {
      if (!ab || !ab.items.length) return null;
      var off = waState !== 'ok';
      var s = el('div', { class: 'ms-ncc-sec' }, [cap(svg(BOOK_ICON, 13), T('ncc.sec_book') + (q ? '' : ' · ' + ab.total))]);
      if (off) s.appendChild(note(waState === 'logged_out' ? T('ncc.book_off_out', { network: label() }) : T('ncc.book_off_down', { network: label() })));
      var list = q || st.more.ab ? ab.items : ab.items.slice(0, FIRST);
      list.forEach(function (x) {
        var rs = st.rows[x.contactId] || null;
        var usable = x.phones.filter(function (p) { return !p.notOnNetwork; });
        var one = x.phones.length === 1 ? x.phones[0] : null;
        var sub = one ? kindText(one.kind) + ' · ' + one.number : T('ncc.numbers', { n: x.phones.length });
        var right = x.conversationId ? pill(T('ncc.open')) : null;
        var cls = off ? 'is-off' : '';
        var after = null;
        if (one && one.notOnNetwork && !rs) { cls = 'is-off'; right = pill(T('ncc.not_on', { network: label() }), 'gray'); }
        if (rs && rs.view === 'checking') { cls = 'is-tap'; sub = T('ncc.checking', { network: label() }); right = spin(); }
        else if (rs && rs.view === 'none') {
          var p0 = x.phones.filter(function (p) { return p.key === rs.key; })[0] || {};
          cls = 'is-off'; right = pill(T('ncc.not_on', { network: label() }), 'gray');
          after = note(T('ncc.none_text', { number: p0.number || '', name: String(x.name || '').split(' ')[0], network: label() }));
        } else if (rs && rs.view === 'rate') {
          cls = 'is-tap'; right = pill(T('ncc.from', { time: hm(rs.at) }), 'warn');
          after = note(T('ncc.rate_text', { n: rs.n, network: label() }), 'warn');
        } else if (rs && rs.view === 'unreach') { after = note(T('ncc.unreach', { network: label() }), 'err'); }
        else if (rs && rs.view === 'failed') { after = note(rs.text || T('common.error'), 'err'); }
        var picking = st.pick === x.contactId && !off;
        if (picking) { cls = 'is-tap'; right = null; }
        s.appendChild(row(avatar({ name: x.name }), x.name, sub, right, { cls: cls, disabled: off, onClick: function () {
          if (x.conversationId) { openConv(x.conversationId); return; }
          if (x.phones.length > 1) {
            st.pick = st.pick === x.contactId ? null : x.contactId;
            delete st.rows[x.contactId];
            draw();
            var pk = box.querySelector('.ms-ncc-pick');
            if (pk && pk.scrollIntoView) pk.scrollIntoView({ block: 'nearest' });
            return;
          }
          tapBook(x, usable[0] || x.phones[0]);
        } }));
        if (picking) {
          var pk = el('div', { class: 'ms-ncc-pick', role: 'group', 'aria-label': T('ncc.which') }, [el('div', { class: 'ms-ncc-pkh', text: T('ncc.which') })]);
          x.phones.forEach(function (p) {
            var dim = p.landline || p.notOnNetwork;
            var b = el('button', { type: 'button', class: 'ms-ncc-pk' + (dim ? ' is-dim' : '') }, [
              el('span', {}, [el('b', { text: kindText(p.kind) }), el('span', { class: 'ms-nc-num', text: p.number })]),
              p.notOnNetwork ? el('small', { text: T('ncc.not_on', { network: label() }) }) : (p.landline ? el('small', { text: T('ncc.landline') }) : svg(CHEV, 14)),
            ]);
            b.addEventListener('click', function () { tapBook(x, p); });
            pk.appendChild(b);
          });
          s.appendChild(pk);
        }
        if (after) s.appendChild(after);
      });
      if (!q && !st.more.ab && ab.items.length > FIRST) s.appendChild(moreRow(T('ncc.all_book', { n: ab.items.length }), 'ab'));
      return s;
    }

    function draw() {
      M.clear(box);
      var d = st.data;
      var q = st.q || '';
      var loading = !d;
      var gc = d ? d.gatecontrol || [] : (host.people || []).filter(function (p) { return !q || String(p.name).toLowerCase().indexOf(q.toLowerCase()) >= 0; }).map(function (p) {
        return { userId: p.id, name: p.name, avatarUrl: p.avatarUrl, initials: p.initials, colorHex: p.colorHex, conversationId: null };
      });
      var parts = [gcSection(gc, q)];
      if (loading) parts.push(waSection(null, q));
      else if (d.whatsapp) parts.push(waSection(d.whatsapp, q));
      if (d && d.whatsapp) parts.push(bookSection(d.addressBook, d.whatsapp.state, q));
      if (d && d.number) {
        var n = d.number;
        parts.push(el('div', { class: 'ms-ncc-sec' }, [row(el('span', { class: 'ms-av-wrap' }, [el('span', { class: 'ms-av ms-ncc-dial', 'aria-hidden': 'true' }, [M.icon('dial', 18)])]),
          n.conversationId ? n.show : T('ncc.check_number', { number: n.show, network: label() }), null, n.conversationId ? pill(T('ncc.open')) : null, { onClick: function () {
            if (n.conversationId) openConv(n.conversationId); else host.numberDialog(netState(), { number: n.e164 });
          } })]));
      }
      parts = parts.filter(Boolean);
      var empty = !loading && !parts.length;
      if (empty && q) {
        var kids = [el('div', { class: 'ms-ncc-bub' }, [M.icon('search', 22)]), el('b', { text: T('ncc.empty_title', { q: q }) }),
          el('span', { text: d.whatsapp ? T('ncc.empty_text', { network: label() }) : T('ncc.empty_text_gc') })];
        if (d.numberEntry) {
          var b = el('button', { type: 'button', class: 'btn btn-primary btn-sm' }, [M.icon('dial', 16), T('ncc.enter_number')]);
          b.addEventListener('click', function () { host.numberDialog(netState(), {}); });
          kids.push(b);
        }
        box.appendChild(el('div', { class: 'ms-ncc-empty' }, kids));
      } else if (empty) box.appendChild(el('p', { class: 'ms-list-empty', text: d && d.error ? d.error : T('portal.no_people') }));
      parts.forEach(function (p) { box.appendChild(p); });
      var showFoot = !!(d && d.numberEntry) && !empty;
      foot.hidden = !showFoot || !st.on;
      priv.hidden = !(d && d.whatsapp);
      footRow.className = 'ms-ncc-nfoot' + (d && d.whatsapp && d.whatsapp.state !== 'ok' ? ' is-off' : '');
    }
    function show(on) { st.on = !!on; box.hidden = !on; draw(); }

    st.on = true;
    return { box: box, foot: foot, setQuery: setQuery, show: show, reload: load };
  }

  window.MSContacts = { create: create };
}());
