/* Shared helpers of the Messenger pages and the portal tab (sandboxed frame; window.GC = host bridge). */
(function () {
  'use strict';
  var CTX = window.MS_CTX || { texts: {}, lang: 'de' };
  function T(key, params) {
    var s = CTX.texts && CTX.texts[key] != null ? String(CTX.texts[key]) : key;
    if (params) Object.keys(params).forEach(function (k) { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
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
      else if (k === 'style') n.setAttribute('style', v);
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    (kids || []).forEach(function (c) { if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  /** API of this plugin through the parent page (session + CSRF are added there). */
  function api(method, path, body) {
    if (!window.GC) return Promise.reject(new Error('no bridge'));
    return window.GC.call(method, String(path).replace(/^\/+/, ''), body);
  }
  function errCode(e) { return (e && e.data && e.data.code) || null; }
  function errText(e) {
    var c = errCode(e);
    if (c && CTX.texts && CTX.texts['error.' + c]) return T('error.' + c);
    return (e && e.data && e.data.error) || T('common.error');
  }
  var toastTimer = null;
  function toast(msg, tone) {
    var t = $('#ms-toast');
    if (!t) { t = el('div', { id: 'ms-toast', class: 'ms-toast', role: 'status' }); document.body.appendChild(t); }
    t.textContent = String(msg || '');
    t.setAttribute('data-tone', tone || 'good');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }
  function warn(e) { toast(errText(e), 'error'); }
  /** Stroke icon from static path data (never data from the API). */
  function svg(d, size, opts) {
    var o = opts || {};
    var NS = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size || 16); s.setAttribute('height', size || 16);
    s.setAttribute('fill', o.fill ? 'currentColor' : 'none'); s.setAttribute('stroke', o.fill ? 'none' : 'currentColor'); s.setAttribute('stroke-width', o.stroke || '2');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    String(d).split('|').forEach(function (part) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', part); s.appendChild(p); });
    return s;
  }
  var ICONS = {
    search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14|M20 20l-3.5-3.5',
    pen: 'M4 20h4L19 9l-4-4L4 16v4z',
    gear: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6|M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    attach: 'M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8',
    mic: 'M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0z|M5 11a7 7 0 0 0 14 0M12 18v3',
    send: 'M4 12l16-8-6 16-3-7z',
    back: 'M15 18l-6-6 6-6',
    info: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18|M12 11v5M12 8h.01',
    close: 'M6 6l12 12M18 6L6 18',
    reply: 'M9 14L4 9l5-5|M4 9h10a6 6 0 0 1 6 6v4',
    smile: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18|M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01',
    trash: 'M4 7h16M10 11v6M14 11v6|M6 7l1 13h10l1-13M9 7V4h6v3',
    more: 'M12 5h.01M12 12h.01M12 19h.01',
    file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z|M14 3v5h5',
    pin: 'M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z|M12 7.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5',
    group: 'M9 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7|M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a5.5 5.5 0 0 1 3.5 6',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
    lock: 'M6 11h12v10H6z|M8 11V8a4 4 0 0 1 8 0v3',
    bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8|M10 20a2 2 0 0 0 4 0',
    bellOff: 'M6 8a6 6 0 0 1 9.3-5M18 8c0 7 3 8 3 8H8|M10 20a2 2 0 0 0 4 0M3 3l18 18',
    timer: 'M12 7v5l3 2|M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18',
    plus: 'M12 5v14M5 12h14',
    check: 'M4 12l5 5L20 6',
    checks: 'M2 13l4 4 8-9M10 16l1 1 9-10',
    play: 'M8 5v14l11-7z',
    pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
    image: 'M4 5h16v14H4z|M4 16l5-5 4 4 3-3 4 4|M15 8.5h.01',
    down: 'M12 5v14M6 13l6 6 6-6',
    clock: 'M12 7v5l3 2|M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18',
  };
  function icon(name, size, opts) { return svg(ICONS[name] || ICONS.info, size, opts); }
  var COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  function safeColor(c, fallback) { return COLOR_RE.test(String(c || '')) ? c : (fallback || '#64748b'); }
  var LOCALE = CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  function dayKey(d) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
  function hm(isoStr) {
    var d = new Date(isoStr);
    return isNaN(d.getTime()) ? '' : d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  }
  /** List time: "17:44" today, "Gestern", weekday within a week, else "12.10.". */
  function listTime(isoStr) {
    if (!isoStr) return '';
    var d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var day = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff === 0) return hm(isoStr);
    if (diff === 1) return T('rel.yesterday');
    if (diff > 1 && diff < 7) return d.toLocaleDateString(LOCALE, { weekday: 'short' });
    return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' });
  }
  /** Day separator: "Heute", "Gestern", "Mittwoch, 14. Oktober". */
  function dayLabel(isoStr) {
    var d = new Date(isoStr);
    var now = new Date();
    var day = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff === 0) return T('rel.today');
    if (diff === 1) return T('rel.yesterday');
    return d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }
  function when(isoStr) {
    if (!isoStr) return '–';
    var d = new Date(isoStr);
    if (isNaN(d.getTime())) return '–';
    return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + hm(isoStr);
  }
  function bytes(n) {
    var v = Number(n) || 0;
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    var s = i === 0 ? String(Math.round(v)) : v.toLocaleString(LOCALE, { maximumFractionDigits: v < 10 ? 1 : 0 });
    return s + ' ' + units[i];
  }
  function duration(ms) {
    var s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function uuid() {
    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (_) { /* not a secure context */ }
    var b = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function initials(name) {
    var parts = String(name || '?').trim().split(/\s+/);
    return ((parts[0] || '?').charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : (parts[0] || '').charAt(1) || '')).toUpperCase();
  }
  var AVATAR_RE = /^\/avatars\/[A-Za-z0-9_-]{16,128}\.(?:png|jpe?g|webp)$/;
  var MEDIA_RE = /^\/plugin-media\/[A-Za-z0-9._-]{20,200}$/;
  /**
   * An avatar: the picture (a /avatars/ path of the account or a signed /plugin-media/ group picture),
   * else the initials on the account's colour, else an icon (groups, plugin channels, deleted accounts).
   * p: { name, initials, colorHex, avatarUrl, icon }.
   */
  function avatar(p, size, opts) {
    var o = opts || {};
    var hex = safeColor(p && p.colorHex, o.group ? '' : '#64748B');
    var a = el('span', { class: 'ms-av' + (o.cls ? ' ' + o.cls : '') + (p && p.icon ? ' is-icon' : ''), 'aria-hidden': 'true' });
    if (p && p.icon) a.classList.add('ms-av-' + p.icon);
    else a.style.setProperty('--c', hex);
    if (size) { a.style.width = size + 'px'; a.style.height = size + 'px'; a.style.fontSize = Math.max(10, Math.round(size * 0.34)) + 'px'; }
    if (p && p.icon) a.appendChild(icon(p.icon === 'system' ? 'shield' : (p.icon === 'gone' ? 'lock' : 'group'), Math.round((size || 40) * 0.46)));
    else a.appendChild(el('span', { class: 'ms-av-ini', text: (p && p.initials) || initials(p && p.name) }));
    var url = p && p.avatarUrl;
    if (typeof url === 'string' && (AVATAR_RE.test(url) || MEDIA_RE.test(url))) {
      var img = el('img', { class: 'ms-av-img', src: url, alt: '', decoding: 'async', draggable: 'false' });
      img.addEventListener('load', function () { a.classList.add('has-img'); });
      img.addEventListener('error', function () { if (img.parentNode) img.parentNode.removeChild(img); });
      a.appendChild(img);
    }
    return a;
  }
  function switchBtn(on, label, onChange, disabled) {
    var b = el('button', { type: 'button', class: 'ms-switch', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label, disabled: !!disabled });
    b.appendChild(el('span', { class: 'ms-knob' }));
    if (!disabled) b.addEventListener('click', function () { var v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', v ? 'true' : 'false'); onChange(v, b); });
    return b;
  }
  /** A dialog drawn in the frame (sandboxed frames have no alert/confirm). Resolves when closed. */
  function dialog(title, body, buttons, opts) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var ov;
      var done = function (v) { if (!ov.parentNode) return; ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      var onKey = function (e) { if (e.key === 'Escape') done(null); };
      var foot = el('div', { class: 'ms-modal-foot' }, (buttons || []).map(function (b) {
        return el('button', { type: 'button', class: 'btn' + (b.primary ? ' btn-primary' : '') + (b.danger ? ' btn-danger' : ''), text: b.label, on: { click: function () {
          if (b.onClick) { var r = b.onClick(); if (r === false) return; Promise.resolve(r).then(function (v) { if (v !== false) done(b.value !== undefined ? b.value : v); }); } else done(b.value);
        } } });
      }));
      ov = el('div', { class: 'ms-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
        el('div', { class: 'ms-modal' + (o.wide ? ' is-wide' : '') }, [
          el('div', { class: 'ms-modal-head' }, [el('div', { class: 'ms-modal-title', text: title }), el('button', { type: 'button', class: 'ms-ib ms-ib-flat', 'aria-label': T('common.close'), on: { click: function () { done(null); } } }, [icon('close', 18)])]),
          el('div', { class: 'ms-modal-body' }, [body]),
          (buttons && buttons.length) ? foot : null,
        ]),
      ]);
      ov.addEventListener('click', function (e) { if (e.target === ov) done(null); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(ov);
      var f = ov.querySelector('input:not([type=checkbox]),textarea,select');
      if (f) setTimeout(function () { f.focus(); }, 30);
      if (o.onOpen) o.onOpen(done);
    });
  }
  function confirmDialog(message, okLabel, danger) {
    return dialog(T('common.confirm'), el('p', { class: 'ms-modal-msg', text: message }), [
      { label: T('common.cancel'), value: false }, { label: okLabel || T('common.ok'), primary: !danger, danger: !!danger, value: true },
    ]).then(function (v) { return v === true; });
  }

  window.MS = {
    CTX: CTX, T: T, $: $, $$: $$, el: el, clear: clear, api: api, errText: errText, errCode: errCode, toast: toast, warn: warn,
    svg: svg, icon: icon, safeColor: safeColor, hm: hm, listTime: listTime, dayLabel: dayLabel, dayKey: dayKey, when: when, bytes: bytes, duration: duration,
    uuid: uuid, initials: initials, avatar: avatar, switchBtn: switchBtn, dialog: dialog, confirm: confirmDialog, LOCALE: LOCALE,
  };
}());
