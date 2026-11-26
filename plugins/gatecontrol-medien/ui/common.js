/* Shared helpers of the "Medien" pages (sandboxed frame; window.GC = host bridge). Text only via textContent. */
(function () {
  'use strict';
  var CTX = window.MD_CTX || { texts: {}, lang: 'de' };
  function T(key, params) {
    var s = CTX.texts && CTX.texts[key] != null ? String(CTX.texts[key]) : key;
    if (params) Object.keys(params).forEach(function (k) { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  var $ = function (s, r) { return (r || document).querySelector(s); };
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') n.textContent = String(v);
      else if (k === 'class') n.className = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { n.addEventListener(ev, v[ev]); });
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = !!v;
      else if (k === 'selected') n.selected = !!v;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    (kids || []).forEach(function (c) { if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function api(method, path, body) {
    if (!window.GC) return Promise.reject(new Error('no bridge'));
    return window.GC.call(method, String(path).replace(/^\/+/, ''), body);
  }
  function errText(e) { return (e && e.data && e.data.error) || (e && e.message) || T('common.error'); }
  var toastTimer = null;
  function toast(msg, tone) {
    var t = $('#md-toast');
    if (!t) { t = el('div', { id: 'md-toast', class: 'md-toast', role: 'status' }); document.body.appendChild(t); }
    t.textContent = String(msg || '');
    t.setAttribute('data-tone', tone || 'good');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }
  function warn(e) { toast(errText(e), 'error'); }
  /** In-frame dialog (sandboxed frames have no window.confirm). buttons: [{ label, value, primary, danger, run }] — run may return a promise; false keeps it open. */
  function dialog(content, buttons) {
    return new Promise(function (resolve) {
      var ov;
      var done = function (v) { ov.remove(); resolve(v); };
      var foot = el('div', { class: 'modal-foot' }, (buttons || [{ label: T('common.close'), value: false }]).map(function (b) {
        var btn = el('button', { type: 'button', class: 'btn ' + (b.primary ? 'btn-primary' : '') + (b.danger ? ' btn-danger' : ''), text: b.label });
        btn.addEventListener('click', function () {
          if (!b.run) { done(b.value); return; }
          btn.disabled = true;
          Promise.resolve(b.run()).then(function (r) { btn.disabled = false; if (r !== false) done(r === undefined ? b.value : r); }).catch(function (e) { btn.disabled = false; warn(e); });
        });
        return btn;
      }));
      ov = el('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true', on: { keydown: function (ev) { if (ev.key === 'Escape') { ev.stopPropagation(); done(false); } } } }, [el('div', { class: 'modal' }, [el('div', { class: 'modal-body' }, [content]), foot])]);
      document.body.appendChild(ov);
      var first = ov.querySelector('input,select,textarea') || foot.querySelector('button:last-child');
      if (first) first.focus();
    });
  }
  function confirmDialog(message, okLabel, danger) {
    return dialog(el('p', { text: message }), [{ label: T('common.cancel'), value: false }, { label: okLabel || T('common.ok'), value: true, primary: !danger, danger: !!danger }]);
  }
  var LOCALE = CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  function when(v) {
    if (!v) return '–';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '–';
    return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' + d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  }
  function badge(text, tone) { return el('span', { class: 'md-badge', 'data-tone': tone || null, text: text }); }
  function avatar(u) {
    if (u.avatarUrl) return el('img', { class: 'md-av', src: u.avatarUrl, alt: '' });
    var av = el('span', { class: 'md-av', text: u.initials || (u.name || '?').slice(0, 1) });
    if (u.color) av.style.background = u.color;
    return av;
  }
  function field(label, input, hint) {
    return el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: label }), input, hint ? el('p', { class: 'md-hint', text: hint }) : null]);
  }
  function input(attrs) { return el('input', Object.assign({ class: 'form-input' }, attrs || {})); }
  function check(label, checked) {
    var box = el('input', { type: 'checkbox', checked: checked });
    return { box: box, node: el('label', { class: 'check' }, [box, el('span', { text: label })]) };
  }
  // ── Zugriffsziele from this page (GateControl ≥ 1.324.0, permissions.network.assignTargets: window.GC.targets) ──
  // The dialog offers the routes and VPN peers; saving assigns the home target itself (an assignment that is already
  // there is reused, a new one appended — the index of the others never changes). Without GC.targets (an older
  // GateControl) the dialog falls back to picking one of the targets an administrator assigned.
  var hostTargets = window.GC && window.GC.targets && typeof window.GC.targets.get === 'function' ? window.GC.targets : null;
  function targetsData() { return hostTargets ? hostTargets.get().catch(function () { return null; }) : Promise.resolve(null); }
  function strip(a) {
    if (a.kind === 'route') return { kind: 'route', routeId: a.routeId };
    if (a.kind === 'peer') return { kind: 'peer', peerId: a.peerId, port: a.port == null ? null : a.port, scheme: a.scheme || 'http' };
    return { kind: 'host', host: a.host, port: a.port == null ? null : a.port, scheme: a.scheme || 'http' };
  }
  function declaredOf(td, id) { return ((td && td.targets) || []).filter(function (t) { return t.id === id; })[0] || null; }
  /** The value of the "via" select for an assignment: r:<route> · p:<peer> · a:<index> (an address of the administrator). */
  function viaValue(a) { return a.kind === 'route' ? 'r:' + a.routeId : (a.kind === 'peer' ? 'p:' + a.peerId : 'a:' + a.index); }
  /**
   * The select "Erreichbar über": routes (HTTP), VPN peers, the administrator's own addresses already assigned.
   * td: GC.targets.get(); id: the declared target; index: the source's current assignment (or null); none: text of an empty choice.
   */
  function viaSelect(td, id, index, none) {
    var decl = declaredOf(td, id);
    var assigned = (decl && decl.assigned) || [];
    var cur = index == null ? null : assigned.filter(function (a) { return a.index === index; })[0] || null;
    var routes = ((td && td.routes) || []).filter(function (r) { return r.type === 'http'; });
    var peers = (td && td.peers) || [];
    var own = assigned.filter(function (a) { return a.kind === 'host'; });
    var kids = [el('option', { value: '', text: none || T('src.via_pick'), disabled: none ? null : true })];
    if (routes.length) kids.push(el('optgroup', { label: T('src.via_routes') }, routes.map(function (r) {
      return el('option', { value: 'r:' + r.id, text: r.label + (r.internal ? ' · ' + T('src.via_internal') : '') + (r.enabled ? '' : ' · ' + T('src.off')) });
    })));
    if (peers.length) kids.push(el('optgroup', { label: T('src.via_peers') }, peers.map(function (p) { return el('option', { value: 'p:' + p.id, text: p.label + ' (' + p.ip + ')' }); })));
    if (own.length) kids.push(el('optgroup', { label: T('src.via_assigned') }, own.map(function (a) { return el('option', { value: 'a:' + a.index, text: a.display }); })));
    var s = el('select', { class: 'form-select' }, kids);
    s.value = cur ? viaValue(cur) : '';
    return s;
  }
  function routeOf(td, value) {
    if (!value || value.indexOf('r:') !== 0) return null;
    var id = Number(value.slice(2));
    return ((td && td.routes) || []).filter(function (r) { return r.id === id; })[0] || null;
  }
  /** Suggestions from a route: the home address from its backend (not a peer's VPN address), https://<domain> for away. */
  function suggest(route) {
    if (!route) return { home: null, away: null };
    var b = route.backend;
    var home = b && b.host && b.via !== 'peer' ? b.scheme + '://' + (b.host.indexOf(':') >= 0 ? '[' + b.host + ']' : b.host) + (b.port ? ':' + b.port : '') : null;
    return { home: home, away: route.https && route.domain ? 'https://' + route.domain : null };
  }
  /**
   * The index of the home target `id` for the choice `value` — assigned now if needed (GC.targets.set).
   * peer: { port, scheme } of a VPN peer. Resolves null for an empty choice.
   */
  function ensureTarget(id, value, peer) {
    if (!value) return Promise.resolve(null);
    if (value.indexOf('a:') === 0) return Promise.resolve(Number(value.slice(2)));
    if (!hostTargets) return Promise.reject(new Error(T('src.via_unavailable')));
    return hostTargets.get().then(function (td) {
      var decl = declaredOf(td, id);
      if (!decl) throw new Error(T('src.via_unavailable'));
      var want = value.indexOf('r:') === 0 ? { kind: 'route', routeId: Number(value.slice(2)) }
        : { kind: 'peer', peerId: Number(value.slice(2)), port: (peer && peer.port) || null, scheme: (peer && peer.scheme) || 'http' };
      var found = decl.assigned.filter(function (a) {
        if (a.kind !== want.kind) return false;
        if (want.kind === 'route') return a.routeId === want.routeId;
        return a.peerId === want.peerId && (a.port == null ? null : a.port) === want.port && (a.scheme || 'http') === want.scheme;
      })[0];
      if (found) return found.index;
      var list = decl.multiple ? decl.assigned.map(strip).concat([want]) : [want];
      return hostTargets.set(id, list).then(function () { return list.length - 1; });
    });
  }
  /** Remove assignments at the end of target `id` that no source uses any more (routes and peers only — never shifts an index). */
  function pruneTargets(id, used) {
    if (!hostTargets) return Promise.resolve(false);
    return hostTargets.get().then(function (td) {
      var decl = declaredOf(td, id);
      if (!decl) return false;
      var list = decl.assigned.slice();
      var n = list.length;
      while (list.length && used.indexOf(list[list.length - 1].index) < 0 && list[list.length - 1].kind !== 'host') list.pop();
      return list.length === n ? false : hostTargets.set(id, list.map(strip)).then(function () { return true; });
    }).catch(function () { return false; });
  }
  // ── "Wo läuft Jellyfin?" / "Wo liegt die NAS?" (1.2.0): one choice, the access target follows from it ──
  function routeById(td, id) { return ((td && td.routes) || []).filter(function (r) { return r.id === id; })[0] || null; }
  function peerById(td, id) { return ((td && td.peers) || []).filter(function (p) { return p.id === id; })[0] || null; }
  /** The assignment `index` of target `id` (null without one). */
  function assignedAt(td, id, index) {
    var decl = declaredOf(td, id);
    if (!decl || index == null) return null;
    return decl.assigned.filter(function (a) { return a.index === index; })[0] || null;
  }
  /** How a choice (r:/p:/a:) or an assignment reads: a route's domain, a peer's name, an address. */
  function whereText(td, x, id) {
    if (!x) return null;
    var a = typeof x === 'string' ? (x.indexOf('a:') === 0 ? assignedAt(td, id, Number(x.slice(2))) : (x.indexOf('r:') === 0 ? { kind: 'route', routeId: Number(x.slice(2)) } : { kind: 'peer', peerId: Number(x.slice(2)) })) : x;
    if (!a) return null;
    if (a.kind === 'route') { var r = routeById(td, a.routeId); return r ? (r.domain || r.label) : (a.display || null); }
    if (a.kind === 'peer') { var p = peerById(td, a.peerId); return a.display || (p ? p.label + ' (' + p.ip + ')' : null); }
    return a.display || (a.host + (a.port ? ':' + a.port : ''));
  }
  function hostPort(h) { return (h.host.indexOf(':') >= 0 ? '[' + h.host + ']' : h.host) + (h.port ? ':' + h.port : ''); }
  /** Where a choice leads in the home network: { scheme, host, port } — a route's target (not a peer's VPN address), an assigned address; else null. */
  function homeOf(td, value, id) {
    if (!value) return null;
    if (value.indexOf('r:') === 0) {
      var r = routeById(td, Number(value.slice(2)));
      var b = r && r.backend;
      return b && b.host && b.via !== 'peer' ? { scheme: b.scheme || 'http', host: b.host, port: b.port || null } : null;
    }
    if (value.indexOf('a:') === 0) {
      var a = assignedAt(td, id, Number(value.slice(2)));
      return a && a.kind === 'host' ? { scheme: a.scheme || 'http', host: a.host, port: a.port || null } : null;
    }
    return null;
  }
  /** Suggestions for a Jellyfin choice: home address (http://host:port, port 8096 by default), https://<domain> for away. */
  function suggestJellyfin(td, value) {
    var h = homeOf(td, value, 'jellyfin');
    var r = value && value.indexOf('r:') === 0 ? routeById(td, Number(value.slice(2))) : null;
    return { home: h ? h.scheme + '://' + hostPort({ host: h.host, port: h.port || 8096 }) : null, away: r && r.https && r.domain ? 'https://' + r.domain : null };
  }
  /** Suggestions for a NAS choice and a share name: SMB on the host, WebDAV when the target speaks HTTPS, a name. */
  function suggestShare(td, value, share) {
    var f = String(share || '').trim().replace(/^[\\/]+|[\\/]+$/g, '');
    var h = homeOf(td, value, 'webdav');
    var r = value && value.indexOf('r:') === 0 ? routeById(td, Number(value.slice(2))) : null;
    var ok = f && /^[^\\/?#]+$/.test(f);
    return {
      smb: ok && h ? 'smb://' + hostPort({ host: h.host }) + '/' + f : null,
      webdav: ok && h && h.scheme === 'https' ? 'https://' + hostPort(h) + '/' + f : null,
      away: ok && r && r.https && r.domain ? 'https://' + r.domain + '/' + f : null,
      name: ok ? 'NAS ' + f.charAt(0).toUpperCase() + f.slice(1) : null,
    };
  }
  /** Routes that look like Jellyfin / a NAS (name or port) — offered first as choices. */
  function likelyJellyfin(r) { return r.type === 'http' && (/jellyfin|media|medien|film|kino/i.test((r.domain || '') + ' ' + (r.label || '')) || !!(r.backend && r.backend.port === 8096)); }
  function likelyNas(r) { return r.type === 'http' && (/nas|dav|dsm|synology|diskstation|ds\d|qnap|datei|files?\b/i.test((r.domain || '') + ' ' + (r.label || '')) || !!(r.backend && [5005, 5006, 5000, 5001].indexOf(r.backend.port) >= 0)); }
  /** "Route · Ziel 192.168.2.151:8096 über Gateway · HTTPS" */
  function routeHint(r) {
    var b = r.backend;
    var out = [T('where.route')];
    if (b && b.host) out.push(T(r.gateway ? 'where.to_gw' : 'where.to', { target: hostPort(b) }));
    out.push(r.https ? 'HTTPS' : 'HTTP');
    if (r.internal) out.push(T('src.via_internal'));
    if (!r.enabled) out.push(T('src.off'));
    return out.join(' · ');
  }
  var whereSeq = 0;
  /**
   * The choice "Wo läuft …?": the likely routes (and the current one) as cards, then "Andere Route oder Adresse …"
   * with every route, VPN peer and assigned address. → { node, value(), onChange(fn) }
   */
  function whereChoice(td, id, index, likely) {
    var sel = viaSelect(td, id, index);
    var cur = sel.value;
    var name = 'md-where-' + (++whereSeq);
    var fns = [];
    var cards = ((td && td.routes) || []).filter(function (r) { return r.type === 'http' && ('r:' + r.id === cur || likely(r)); });
    cards.sort(function (a, b) { return ('r:' + b.id === cur) - ('r:' + a.id === cur); });
    cards = cards.slice(0, 4);
    var radios = [];
    function card(value, title, hint) {
      var rb = el('input', { type: 'radio', name: name, value: value });
      radios.push(rb);
      var lab = el('label', { class: 'md-choice' }, [rb, el('span', { class: 'md-choice-t' }, [el('b', { text: title }), hint ? el('span', { class: 'md-hint', text: hint }) : null])]);
      rb.addEventListener('change', changed);
      return lab;
    }
    var nodes = cards.map(function (r) { return card('r:' + r.id, r.domain || r.label, routeHint(r)); });
    var other = card('', T('where.other'), T('where.other_hint'));
    var otherBox = el('div', { class: 'md-choice-other' }, [sel]);
    nodes.push(other, otherBox);
    sel.addEventListener('change', changed);
    function picked() { return radios.filter(function (x) { return x.checked; })[0] || null; }
    function value() { var p = picked(); return !p ? '' : (p.value || sel.value || ''); }
    function changed() {
      var p = picked();
      radios.forEach(function (x) { x.parentNode.setAttribute('data-on', x.checked ? '1' : '0'); });
      otherBox.hidden = !(p && !p.value);
      fns.forEach(function (f) { f(value()); });
    }
    var first = radios.filter(function (x) { return x.value && x.value === cur; })[0] || (cur ? radios[radios.length - 1] : radios[0]);
    first.checked = true;
    changed();
    return { node: el('div', { class: 'md-choices', role: 'radiogroup' }, nodes), value: value, onChange: function (f) { fns.push(f); } };
  }
  /** "unterwegs …": without VPN over the address, through the VPN over the address, or no way away (no address). */
  function awayText(s) {
    var a = (s && s.away) || {};
    if (a.mode === 'direct') return T('away.direct', { address: a.address });
    return a.address ? T('away.vpn_via', { address: a.address }) : T(s && s.kind === 'share' ? 'away.none_share' : 'away.none');
  }
  /** One line per check result: tone + text. */
  function checks(st) {
    var items = [];
    if (!st || !st.at) return el('p', { class: 'md-hint', text: T('check.never') });
    if (st.reachable != null) {
      items.push([st.reachable ? 'good' : 'crit', st.reachable ? T('check.reachable', { name: st.serverName || '', version: st.version || '?' }) : T('check.unreachable.' + (st.problem === 'no_target' ? 'no_target' : 'net'))]);
      if (st.reachable && st.versionOk === false) items.push(['crit', T('check.version_old', { version: st.version })]);
      if (st.keyValid != null) items.push([st.keyValid ? 'good' : 'crit', st.keyValid ? T('check.key_ok', { libs: (st.libraries || []).length, users: st.users || 0 }) : T('check.key_bad')]);
      if (st.quickConnect != null) items.push([st.quickConnect ? 'good' : 'warn', st.quickConnect ? T('check.qc_on') : T('check.qc_off')]);
    }
    if (st.webdav != null) items.push([st.webdav === 'ok' ? 'good' : 'crit', T('check.webdav.' + st.webdav)]);
    items.push(['', T('check.at', { when: when(st.at) })]);
    return el('ul', { class: 'md-checks' }, items.map(function (x) { return el('li', null, [el('span', { class: 'md-dot', 'data-tone': x[0] || null }), el('span', { text: x[1] })]); }));
  }
  window.MD = { CTX: CTX, T: T, $: $, el: el, clear: clear, api: api, toast: toast, warn: warn, errText: errText, dialog: dialog, confirmDialog: confirmDialog,
    when: when, badge: badge, avatar: avatar, field: field, input: input, check: check, checks: checks,
    hasTargets: !!hostTargets, targetsData: targetsData, viaSelect: viaSelect, routeOf: routeOf, suggest: suggest, ensureTarget: ensureTarget, pruneTargets: pruneTargets,
    assignedAt: assignedAt, whereText: whereText, homeOf: homeOf, suggestJellyfin: suggestJellyfin, suggestShare: suggestShare, likelyJellyfin: likelyJellyfin, likelyNas: likelyNas,
    routeHint: routeHint, whereChoice: whereChoice, awayText: awayText };
})();
