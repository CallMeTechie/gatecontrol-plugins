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
    // 1.14.0: this page knows chats over a bridge — without the mark the API leaves them out (README "App-API")
    var p = String(path).replace(/^\/+/, '');
    if (p.indexOf('admin/') !== 0 && p.indexOf('bridged=') < 0) p += (p.indexOf('?') < 0 ? '?' : '&') + 'bridged=1';
    // 1.20.0: … and channels — GET conversations leaves them out, they are on GET channels (the page „Kanäle“)
    if (p.indexOf('admin/') !== 0 && p.indexOf('channels=') < 0) p += '&channels=1';
    return window.GC.call(method, p, body);
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

  /**
   * 1.20.0: a text with its format (`marks` of a bridged message: bold, italic, strike, code, link — UTF-16 offsets) and
   * clickable addresses (in every chat) → a fragment built from text nodes and elements; never HTML of anybody else.
   */
  var URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"]{2,2000}/gi;
  var TRAIL_RE = /[.,;:!?)\]}'"»“”]+$/;
  function safeHref(u) {
    // an address written without its scheme ("www.…") is taken as https (no address in this file: the frame loads nothing)
    var s = /^www\./i.test(u) ? 'https:' + '//' + u : u;
    try { var x = new URL(s); return (x.protocol === 'http:' || x.protocol === 'https:') && !x.username && !x.password ? x.href : null; } catch (e) { return null; }
  }
  function linkEl(text, href) {
    return el('a', { class: 'ms-link', href: href, target: '_blank', rel: 'noopener noreferrer nofollow', text: text, on: { click: function (e) { e.stopPropagation(); } } });
  }
  /** Plain text with its http(s) addresses as links. */
  function linkify(text, into) {
    var t = String(text || '');
    var last = 0;
    URL_RE.lastIndex = 0;
    var m;
    while ((m = URL_RE.exec(t))) {
      var raw = m[0].replace(TRAIL_RE, '');
      var href = safeHref(raw);
      if (!href) continue;
      if (m.index > last) into.appendChild(document.createTextNode(t.slice(last, m.index)));
      into.appendChild(linkEl(raw, href));
      last = m.index + raw.length;
      URL_RE.lastIndex = last;
    }
    if (last < t.length) into.appendChild(document.createTextNode(t.slice(last)));
    return into;
  }
  var MARK_TAG = { bold: 'b', italic: 'i', strike: 's', code: 'code' };
  function richText(text, marks) {
    var t = String(text || '');
    var frag = document.createDocumentFragment();
    var list = (Array.isArray(marks) ? marks : []).filter(function (k) {
      return k && (MARK_TAG[k.type] || k.type === 'link') && k.start >= 0 && k.end <= t.length && k.end > k.start;
    });
    if (!list.length) return linkify(t, frag);
    // cut the text where a mark begins or ends; each piece gets the elements of the marks that cover it
    var cuts = [0, t.length];
    list.forEach(function (k) { cuts.push(k.start, k.end); });
    cuts = cuts.filter(function (x, i, a) { return a.indexOf(x) === i; }).sort(function (a, b) { return a - b; });
    for (var i = 0; i < cuts.length - 1; i++) {
      var a = cuts[i];
      var b = cuts[i + 1];
      var piece = t.slice(a, b);
      var on = list.filter(function (k) { return k.start <= a && k.end >= b; });
      var link = on.filter(function (k) { return k.type === 'link'; })[0];
      var href = link ? safeHref(String(link.url || '')) : null;
      var node = href ? linkEl(piece, href) : linkify(piece, document.createDocumentFragment());
      on.forEach(function (k) { if (MARK_TAG[k.type]) { var w = el(MARK_TAG[k.type], { class: 'ms-mk-' + k.type }); w.appendChild(node); node = w; } });
      frag.appendChild(node);
    }
    return frag;
  }

  /**
   * 1.20.0: the mark of a messenger at a picture or a row — its logo as a small glyph (only to say which service it is),
   * GateControl's shield, a speech bubble for a network this page does not know.
   */
  var NET_GLYPH = {
    whatsapp: { fill: 'M12 2.6a9.3 9.3 0 0 0-8 14l-1.3 4.8 4.9-1.3A9.3 9.3 0 1 0 12 2.6zm0 1.7a7.6 7.6 0 1 1-3.9 14.1l-.3-.2-2.9.8.8-2.8-.2-.3A7.6 7.6 0 0 1 12 4.3z|M9.2 7.6c.2-.4.4-.4.7-.4h.5c.2 0 .4 0 .6.5l.8 1.9c.1.2.1.4 0 .6l-.5.7c-.1.2-.2.3 0 .6.6 1 1.4 1.8 2.5 2.4.3.1.4.1.6-.1l.7-.8c.2-.2.4-.2.6-.1l1.8.9c.2.1.4.2.4.4.1.3 0 1-.3 1.4-.4.5-1.3 1-2 1-1 .1-2.3-.4-4-1.6-1.5-1.2-2.5-2.6-2.9-3.6-.4-1-.2-2 .5-2.8z' },
    gatecontrol: { fill: 'M12 2.5l7.5 2.8v5.9c0 4.8-3.2 8.6-7.5 10.3-4.3-1.7-7.5-5.5-7.5-10.3V5.3z' },
  };
  function netGlyph(network, size) {
    var NS = 'http://www.w3.org/2000/svg';
    var g = NET_GLYPH[network] || { fill: 'M4 5h16v11H9l-5 4z' };
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size || 12));
    s.setAttribute('height', String(size || 12));
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    g.fill.split('|').forEach(function (d) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); p.setAttribute('fill', 'currentColor'); p.setAttribute('fill-rule', 'evenodd'); s.appendChild(p); });
    return s;
  }
  /** The mark at a picture: the logo on the service's colour (`cls`: another class than ms-net, e.g. a mark in a row). */
  function netLogo(network, label, size, cls) {
    var known = !!NET_GLYPH[network];
    return el('span', { class: (cls || 'ms-net') + ' ' + (cls || 'ms-net') + '-' + (known ? network : 'other'), title: label || null, 'aria-label': label || null, role: label ? 'img' : null, 'aria-hidden': label ? null : 'true' }, [netGlyph(network, size)]);
  }
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
    // 1.20.0: channels (the TV symbol), read only (the eye), a bell switched off
    tv: 'M3 7h18v12H3z|M8 3l4 4 4-4',
    eye: 'M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z|M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
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
    drive: 'M7 19a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 17.8 9a4.5 4.5 0 0 1-.3 10z|M12 10v6M9.5 13.5L12 16l2.5-2.5',
    // 1.16.0: a new chat by number
    dial: 'M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2',
    userx: 'M10 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8|M3 21c0-4 3-6 7-6s7 2 7 6|M17 8l4 4M21 8l-4 4',
    plug: 'M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0z|M12 17v5|M3 3l18 18',
    logout: 'M15 4h4v16h-4|M10 8l-4 4 4 4M6 12h10',
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7|M20 5v6h-6',
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
  /**
   * A dialog drawn in the frame (sandboxed frames have no alert/confirm). Resolves when closed.
   * opts: wide, onOpen(done); 1.16.0: head (a node in place of the title), foot (a node the caller fills, in place of
   * buttons), sheet (a sheet from the bottom at phone width), cls (a class of the box).
   */
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
      ov = el('div', { class: 'ms-overlay' + (o.sheet ? ' is-sheet' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
        el('div', { class: 'ms-modal' + (o.wide ? ' is-wide' : '') + (o.cls ? ' ' + o.cls : '') }, [
          el('div', { class: 'ms-modal-head' }, [o.head || el('div', { class: 'ms-modal-title', text: title }), el('button', { type: 'button', class: 'ms-ib ms-ib-flat', 'aria-label': T('common.close'), on: { click: function () { done(null); } } }, [icon('close', 18)])]),
          el('div', { class: 'ms-modal-body' }, [body]),
          o.foot || ((buttons && buttons.length) ? foot : null),
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
    richText: richText, linkify: linkify, netLogo: netLogo, netGlyph: netGlyph,
  };
}());
