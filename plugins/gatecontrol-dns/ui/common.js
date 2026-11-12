/* Shared helpers of the "DNS-Schutz" settings page and the portal tab (sandboxed frame; window.GC = host bridge). */
(function () {
  'use strict';
  var CTX = window.DNS_CTX || { texts: {}, lang: 'de' };
  function T(key, params) {
    var s = CTX.texts && CTX.texts[key] != null ? String(CTX.texts[key]) : key;
    if (params) Object.keys(params).forEach(function (k) { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  /** T(key) when there is such a text, else the fallback (names the catalogue adds later). */
  function TO(key, fallback) { return CTX.texts && CTX.texts[key] != null ? String(CTX.texts[key]) : fallback; }
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var SVG = 'http://www.w3.org/2000/svg';
  /** An icon of ui/icons.html: icon('shield', 's16') */
  function icon(name, size) {
    var s = document.createElementNS(SVG, 'svg');
    s.setAttribute('class', 'i' + (size ? ' ' + size : ''));
    s.setAttribute('aria-hidden', 'true');
    var u = document.createElementNS(SVG, 'use');
    u.setAttribute('href', '#i-' + name);
    s.appendChild(u);
    return s;
  }
  /** el('div', { class, text, on: { click }, attrs… }, [children]) — text only via textContent. */
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
      else if (k === 'disabled') n.disabled = !!v;
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
  function errText(e) {
    var d = e && e.data;
    if (d && d.error) return d.detail && d.code === 'invalid' ? d.error + ' (' + d.detail + ')' : d.error;
    return (e && e.message) || T('common.error');
  }
  var toastTimer = null;
  function toast(msg, tone) {
    var t = $('#dn-toast');
    if (!t) { t = el('div', { id: 'dn-toast', class: 'dn-toast', role: 'status' }); document.body.appendChild(t); }
    t.textContent = String(msg || '');
    t.setAttribute('data-tone', tone || 'good');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }
  function warn(e) { toast(errText(e), 'error'); }
  /**
   * In-frame dialog (sandboxed frames have no window.confirm): modal({ title, body: [nodes], foot: [nodes], small })
   * → { close, node }. Escape and the × close it (onClose).
   */
  function modal(o) {
    var ov;
    var closed = false;
    function close() { if (closed) return; closed = true; document.removeEventListener('keydown', onKey); ov.remove(); if (o.onClose) o.onClose(); }
    function onKey(ev) { if (ev.key === 'Escape' && !o.sticky) close(); }
    var id = 'dn-m-' + Math.random().toString(36).slice(2, 8);
    var head = el('div', { class: 'modal-head' }, [el('h2', { id: id, text: o.title }), o.sticky ? null : el('button', { type: 'button', 'aria-label': T('common.close'), on: { click: close } }, [icon('x', 's18')])]);
    var body = el('div', { class: 'modal-body' }, o.body || []);
    var foot = el('div', { class: 'modal-foot' }, o.foot || []);
    ov = el('div', { class: 'modal-overlay' }, [el('div', { class: 'modal' + (o.small ? ' sm' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id }, [head, body, foot])]);
    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey);
    var f = body.querySelector('input,select,textarea,button') || foot.querySelector('button');
    if (f) f.focus();
    return { close: close, node: ov, body: body, foot: foot };
  }
  function confirmDialog(title, message, okLabel, danger) {
    return new Promise(function (resolve) {
      var done = false;
      var m = modal({
        title: title, small: true, body: [el('p', { text: message })], onClose: function () { if (!done) resolve(false); },
        foot: [
          el('button', { type: 'button', class: 'btn btn-ghost', text: T('common.cancel'), on: { click: function () { m.close(); } } }),
          el('button', { type: 'button', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), text: okLabel || T('common.ok'), on: { click: function () { done = true; m.close(); resolve(true); } } }),
        ],
      });
    });
  }
  var LOCALE = CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  function num(n) { return Number(n || 0).toLocaleString(LOCALE); }
  function pct(blocked, queries) { return queries > 0 ? (Math.round((blocked / queries) * 1000) / 10).toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %' : '0 %'; }
  function clock(isoStr, sec) {
    var d = new Date(isoStr);
    if (!isoStr || isNaN(d.getTime())) return '–';
    return d.toLocaleTimeString(LOCALE, sec ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  }
  /** "heute 04:12", "gestern 04:11", "05.11. 04:12" */
  function when(isoStr) {
    if (!isoStr) return '–';
    var d = new Date(isoStr);
    if (isNaN(d.getTime())) return '–';
    var now = new Date();
    var day = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff === 0) return T('rel.today') + ' ' + clock(isoStr);
    if (diff === 1) return T('rel.yesterday') + ' ' + clock(isoStr);
    return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' }) + ' ' + clock(isoStr);
  }
  /** "24:10" / "1:05:00" until an ISO time (never negative) */
  function countdown(isoStr) {
    var s = Math.max(0, Math.round((Date.parse(isoStr) - Date.now()) / 1000));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var two = function (x) { return (x < 10 ? '0' : '') + x; };
    return h ? h + ':' + two(m) + ':' + two(s % 60) : m + ':' + two(s % 60);
  }
  function duration(min) {
    if (min === 240) return T('dur.240');
    if (min === 60) return T('dur.60');
    return T('dur.min', { n: min });
  }
  function bytes(n) {
    if (n == null) return '–';
    return (n / 1048576).toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' MB';
  }
  function listName(id) { return TO('list.' + id, id); }
  /** The entry that hit ("Domain prüfen"): "Treffer tiktok.com mit allen Unterseiten" — null without one. */
  function matchText(m) {
    if (!m || !m.entry) return null;
    return T(m.kind === 'exact' ? 'test.match_exact' : (m.kind === 'subdomains' ? 'test.match_subdomains' : 'test.match_domain'), { entry: m.entry });
  }
  function categoryName(id) { return TO('cat.' + id, id); }
  /**
   * Why a query was allowed or blocked, in words. Own entries say for whom they hold (`scope`: 'all' = for everybody,
   * 'profile' = an entry of the profile; null = an entry written by an older server). `short`: without the profile's name.
   */
  function reasonText(e, short) {
    var list = e.list;
    var own = function (key) {
      if (e.scope === 'all') return T('reason.' + key + '_all');
      if (e.scope === 'profile') return !short && e.profile && e.profile.name ? T('reason.' + key + '_in', { profile: e.profile.name }) : T('reason.' + key + '_profile');
      return T('reason.' + key);
    };
    switch (e.reason) {
      case 'list': return T('reason.list', { list: listName(list) });
      case 'profile_deny': return own('profile_deny');
      case 'profile_allow': return own('profile_allow');
      case 'paused': return T('reason.paused');
      case 'schedule': return T('reason.schedule');
      case 'schedule_category': return T('reason.schedule_category', { category: categoryName(e.category || list) });
      case 'safe_search': return T('reason.safe_search');
      case 'suspended': return T('reason.suspended');
      case 'no_profile': return T('reason.no_profile');
      case 'internal': case 'local': return T('reason.internal');
      case 'canary': return T('reason.canary');
      default: return '–';
    }
  }
  /** A switch: sw(checked, onChange(checked), label) */
  function sw(checked, onChange, label, disabled) {
    var b = el('button', { type: 'button', class: 'sw', role: 'switch', 'aria-checked': checked ? 'true' : 'false', 'aria-label': label, disabled: disabled });
    b.addEventListener('click', function () {
      var next = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', next ? 'true' : 'false');
      if (onChange) onChange(next, b);
    });
    return b;
  }
  /** A row with a title, a hint and something at the end. */
  function row(title, hint, end, cls) {
    return el('div', { class: 'rw' + (cls ? ' ' + cls : '') }, [el('div', { class: 't' }, [el('b', { text: title }), hint ? el('small', { text: hint }) : null]), end]);
  }
  function tag(text, tone, plain) { return el('span', { class: 'tag ' + (tone || 'grey') + (plain ? ' plain' : ''), text: text }); }
  function banner(tone, ic, title, text, buttons, role) {
    return el('div', { class: 'banner ' + (tone || ''), role: role || 'status' }, [
      el('span', { class: 'bi' }, [icon(ic, 's18')]),
      el('div', { class: 'bt' }, [el('b', { text: title }), text ? (typeof text === 'string' ? el('span', { text: text }) : text) : null]),
      buttons && buttons.length ? el('div', { class: 'btns' }, buttons) : null,
    ]);
  }
  function btn(label, cls, onClick, ic) {
    return el('button', { type: 'button', class: 'btn ' + (cls || ''), on: { click: onClick } }, [ic ? icon(ic, 's14') : null, label]);
  }
  window.DN = { CTX: CTX, T: T, TO: TO, $: $, el: el, icon: icon, clear: clear, api: api, toast: toast, warn: warn, errText: errText, modal: modal, confirmDialog: confirmDialog,
    num: num, pct: pct, clock: clock, when: when, countdown: countdown, duration: duration, bytes: bytes, listName: listName, categoryName: categoryName, reasonText: reasonText, matchText: matchText,
    sw: sw, row: row, tag: tag, banner: banner, btn: btn, LOCALE: LOCALE };
})();
