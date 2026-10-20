/* Shared helpers of the Schule frames (sandboxed frame; window.GC = host bridge). Data from the API
   only ever reaches the page through textContent / attributes (el()), never as HTML. */
(function () {
  'use strict';
  var CTX = window.SC_CTX || { texts: {}, lang: 'de' };
  function T(key, params) {
    var s = CTX.texts && CTX.texts[key] != null ? String(CTX.texts[key]) : key;
    if (params) Object.keys(params).forEach(function (k) { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  /** el('div', { class, text, on: { click }, style: { … }, attrs… }, [children]) — text only via textContent. */
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') n.textContent = String(v);
      else if (k === 'class') n.className = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { n.addEventListener(ev, v[ev]); });
      else if (k === 'style') Object.keys(v).forEach(function (p) { if (v[p] != null) n.style.setProperty(p, String(v[p])); });
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = !!v;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  /** API of this plugin through the parent page (session + CSRF are added there). */
  function api(method, path, body) {
    if (!window.GC) return Promise.reject(new Error('no bridge'));
    return window.GC.call(method, String(path).replace(/^\/+/, ''), body);
  }
  function errText(e) { return (e && e.data && e.data.error) || T('common.error'); }
  var toastTimer = null;
  function toast(msg, tone) {
    var t = $('#sc-toast');
    if (!t) { t = el('div', { id: 'sc-toast', class: 'toast', role: 'status' }); document.body.appendChild(t); }
    t.textContent = String(msg || '');
    t.setAttribute('data-tone', tone || 'good');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 5000);
  }
  function openModal(id) {
    var m = document.getElementById(id);
    if (!m) return;
    m.hidden = false;
    var f = m.querySelector('[data-autofocus],textarea,input:not([type=checkbox]),select,button.btn-primary');
    if (f) setTimeout(function () { f.focus(); }, 30);
  }
  var closeHooks = {};
  function closeModal(id) {
    var m = document.getElementById(id);
    if (m && !m.hidden) { m.hidden = true; if (closeHooks[id]) closeHooks[id](); }
  }
  function onClose(id, fn) { closeHooks[id] = fn; }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    $$('.modal-overlay').forEach(function (m) { if (!m.hidden && m.id) closeModal(m.id); else if (!m.id) m.remove(); });
  });
  document.addEventListener('click', function (e) {
    var c = e.target && e.target.closest ? e.target.closest('[data-close]') : null;
    if (c) closeModal(c.getAttribute('data-close'));
  });
  /** In-frame confirm (sandboxed frames have no window.confirm). */
  function confirmDialog(message, okLabel, danger) {
    return new Promise(function (resolve) {
      var ov;
      var done = function (v) { ov.remove(); resolve(v); };
      var ok = el('button', { type: 'button', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), text: okLabel || T('common.ok'), on: { click: function () { done(true); } } });
      ov = el('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' }, [
        el('div', { class: 'modal' }, [
          el('div', { class: 'modal-body', style: { 'padding-top': '18px' } }, [el('p', { class: 'modal-msg', text: message })]),
          el('div', { class: 'modal-foot' }, [el('button', { type: 'button', class: 'btn', text: T('common.cancel'), on: { click: function () { done(false); } } }), ok]),
        ]),
      ]);
      document.body.appendChild(ov);
      setTimeout(function () { ok.focus(); }, 30);
    });
  }
  /** Stroke icon from static path data (never data from the API). */
  function svg(d, size) {
    var NS = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size || 16); s.setAttribute('height', size || 16);
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    String(d).split('|').forEach(function (part) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', part); s.appendChild(p); });
    return s;
  }
  var ICON = {
    school: 'M2 9l10-5 10 5-10 5zM6 11v5c3 2 9 2 12 0v-5M22 9v6',
    camera: 'M4 8h3l2-3h6l2 3h3v11H4z|M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    image: 'M4 5h16v14H4z|M4 16l5-5 4 4 3-3 4 4|M15.5 9.5h.01',
    keyboard: 'M3 7h18v10H3z|M7 11h.01M11 11h.01M15 11h.01M7 14h10',
    link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1|M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
    plus: 'M12 5v14M5 12h14',
    gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
    refresh: 'M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    edit: 'M4 20h4L19 9l-4-4L4 16z',
    key: 'M15 7a4 4 0 1 1-3.87 5H3v3h3v2h3v-2h2.13A4 4 0 0 1 15 7z',
    exam: 'M9 4h6v3H9zM6 6h12v15H6zM9 12h6M9 16h4',
    book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z|M8 7h7',
    swap: 'M4 8h13l-3-3M20 16H7l3 3',
    x: 'M6 6l12 12M18 6L6 18',
    check: 'M5 12l5 5 9-10',
    wall: 'M4 5h16v11H4zM9 20h6M12 16v4',
    bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9|M10.3 21a1.94 1.94 0 0 0 3.4 0',
  };
  /**
   * The face of a child or a person: the picture (avatarUrl, /avatars/… of GateControl — allowed by
   * the frame's CSP) or the initials on the colour. f = { color, avatarUrl, initials, name }.
   */
  function avatar(f, cls) {
    var face = f || {};
    var a = el('span', { class: 'av' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true', style: { '--kid': face.color || face.colorHex || null } });
    if (face.avatarUrl && /^\/avatars\/[A-Za-z0-9_-]+\.(png|jpe?g|webp)$/.test(face.avatarUrl)) {
      var img = el('img', { src: face.avatarUrl, alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', function () { a.removeChild(img); a.textContent = face.initials || '?'; });
      a.appendChild(img);
    } else a.textContent = face.initials || '?';
    return a;
  }
  var WD = { de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };
  var WDL = { de: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'], en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] };
  function parts(date) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
    return m ? { y: +m[1], m: m[2], d: m[3], wd: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay() } : null;
  }
  /** "2026-10-21" → "Mi 21.10." / "Wed 21/10" */
  function dayLabel(date) {
    var p = parts(date);
    if (!p) return String(date || '');
    return CTX.lang === 'en' ? WD.en[p.wd] + ' ' + p.d + '/' + p.m : WD.de[p.wd] + ' ' + p.d + '.' + p.m + '.';
  }
  function weekday(date, long) { var p = parts(date); return p ? (long ? WDL : WD)[CTX.lang === 'en' ? 'en' : 'de'][p.wd] : ''; }
  function dayNum(date) { var p = parts(date); return p ? (CTX.lang === 'en' ? p.d + '/' + p.m : p.d + '.' + p.m + '.') : ''; }
  function when(ms) {
    if (!ms) return '–';
    try { return new Date(ms).toLocaleString(CTX.lang === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_) { return '–'; }
  }
  /** The plugin's settings: GateControl ≥ 1.185 opens its settings tab; older hosts the page „Konten & Kinder“. */
  function openSettings() {
    if (!window.GC) return;
    if (typeof window.GC.openSettings === 'function') window.GC.openSettings();
    else if (typeof window.GC.navigate === 'function') window.GC.navigate('setup');
  }
  window.SC = {
    CTX: CTX, T: T, $: $, $$: $$, el: el, clear: clear, api: api, errText: errText, toast: toast, openModal: openModal, closeModal: closeModal, onClose: onClose,
    confirm: confirmDialog, svg: svg, ICON: ICON, avatar: avatar, dayLabel: dayLabel, weekday: weekday, dayNum: dayNum, when: when, openSettings: openSettings,
  };
}());
