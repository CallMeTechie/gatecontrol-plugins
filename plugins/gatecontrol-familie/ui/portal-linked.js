/* Portal tab "Familie" — 1.23.0: „Andere Messenger“ (API messengers/…, server/linked.js). Parents only, signed in:
   per child and service (WhatsApp first) a switch — may this child link its own account at that messenger with the
   bridges of the Messenger plugin? Off until a parent allows it. Taking it back also ends the child's link (asked
   first; the answer says when the link could not be ended). Hidden without the Messenger's bridges (no Messenger, an
   older one, no bridge switched on), for children and without children. */
(function () {
  'use strict';
  var A = window.FA, T = A.T, $ = A.$, el = A.el, CTX = A.CTX;
  var writable = CTX.loggedIn === true;
  var box = $('#fa-linked');
  if (!box) return;
  var data = null; // { available, manage, networks, children }
  var busy = false;

  function netName(n) { return T('linked.net_' + n); }

  function change(c, n, on, sw) {
    if (busy) { A.setSwitch(sw, !on); return; }
    var send = function () {
      busy = true;
      var nets = {};
      nets[n] = on;
      A.api('PUT', 'messengers/' + encodeURIComponent(c.userId), { networks: nets }).then(function (x) {
        busy = false;
        if (x.child) data.children = data.children.map(function (k) { return k.userId === x.child.userId ? x.child : k; });
        render();
        if (on) A.toast(T('linked.allowed', { name: c.name, service: netName(n) }));
        else if (x.unlinked && x.unlinked[n] === false) A.toast(T('linked.revoked_kept', { name: c.name, service: netName(n) }), 'error');
        else if (x.unlinked && x.unlinked[n] === true) A.toast(T('linked.revoked_unlinked', { name: c.name, service: netName(n) }));
        else A.toast(T('linked.revoked', { name: c.name, service: netName(n) }));
      }).catch(function (e) { busy = false; A.setSwitch(sw, !on); A.warn(e); });
    };
    if (on) { A.setSwitch(sw, true); send(); return; }
    // taking it back ends the child's link as well: ask first
    A.confirm(T(c.linked && c.linked[n] ? 'linked.confirm_linked' : 'linked.confirm', { name: c.name, service: netName(n) }), T('linked.confirm_ok'), true).then(function (ok) {
      if (!ok) { A.setSwitch(sw, true); return; }
      A.setSwitch(sw, false);
      send();
    });
  }

  function row(c) {
    var lines = data.networks.map(function (n) {
      var on = !!(c.networks && c.networks[n]);
      var isLinked = !!(c.linked && c.linked[n]);
      var state = on ? (isLinked ? T('linked.state_linked') : T('linked.state_allowed')) : (isLinked ? T('linked.state_locked_linked') : T('linked.state_locked'));
      return el('div', { class: 'fa-lk-net' }, [
        el('span', { class: 'fa-lk-tx' }, [el('b', { text: netName(n) }), el('span', { class: 'fa-sub', text: state })]),
        isLinked ? el('span', { class: 'fa-pill fa-net-pill' + (on ? '' : ' is-warn'), text: T('linked.pill_linked') }) : null,
        A.switchBtn(on, T('linked.switch', { name: c.name, service: netName(n) }), function (v, b) { change(c, n, v, b); }),
      ]);
    });
    return el('div', { class: 'fa-net-item' }, [el('div', { class: 'fa-net-kid' }, [
      A.avatar(c, 40),
      el('span', { class: 'fa-net-main' }, [el('strong', { class: 'fa-net-name' }, [el('span', { text: c.name })])]),
      el('div', { class: 'fa-lk-nets' }, lines),
    ])]);
  }
  function render() {
    var list = A.clear($('#fa-lk-list'));
    data.children.forEach(function (c) { list.appendChild(row(c)); });
  }
  function load() {
    if (busy) return Promise.resolve();
    return A.api('GET', 'messengers').then(function (x) {
      data = x.messengers;
      // parents, signed in, with a bridge switched on in the Messenger and at least one child
      box.hidden = !(data && data.available && data.manage && writable && data.children.length && data.networks.length);
      if (!box.hidden) render();
    }).catch(function () { box.hidden = true; });
  }
  if (!writable) return;
  load();
}());
