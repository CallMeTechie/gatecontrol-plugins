/* Shared helpers of the Proxmox page (sandboxed frame; window.GC = host bridge). */
(function () {
  'use strict';
  var CTX = window.PX_CTX || { texts: {}, lang: 'de' };
  var LOCALE = CTX.lang === 'en' ? 'en-GB' : 'de-DE';
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
  var toastTimer = null;
  function toast(msg, tone) {
    var t = $('#px-toast');
    if (!t) { t = el('div', { id: 'px-toast', class: 'px-toast', role: 'status' }); document.body.appendChild(t); }
    t.textContent = String(msg || '');
    t.setAttribute('data-tone', tone || 'good');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4500);
  }
  function openModal(id) {
    var m = document.getElementById(id);
    if (!m) return;
    m.hidden = false;
    var d = m.querySelector('.modal');
    if (d && d.scrollIntoView) { try { d.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) { /* old browser */ } }
    var f = m.querySelector('input:not([type=checkbox]),select,button.btn-primary');
    if (f) setTimeout(function () { try { f.focus(); } catch (_) { /* hidden */ } }, 30);
  }
  function closeModal(id) {
    var m = document.getElementById(id);
    if (!m) return;
    m.hidden = true;
    m.dispatchEvent(new CustomEvent('px-close'));
  }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    $$('.modal-overlay').forEach(function (m) { if (!m.hidden) closeModal(m.id); });
  });
  /** In-frame confirm (sandboxed frames have no window.confirm). */
  function confirmDialog(message, okLabel, danger) {
    return new Promise(function (resolve) {
      var ov;
      var done = function (v) { ov.remove(); resolve(v); };
      var ok = el('button', { type: 'button', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), text: okLabel || T('common.ok'), on: { click: function () { done(true); } } });
      ov = el('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' }, [
        el('div', { class: 'modal' }, [
          el('div', { class: 'modal-body' }, [el('p', { class: 'modal-msg', text: message })]),
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
    var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p);
    return s;
  }
  // ── formatting ──────────────────────────────────────────────────────────
  function num(v, digits) {
    var n = Number(v);
    if (v == null || !isFinite(n)) return '–';
    try { return n.toLocaleString(LOCALE, { maximumFractionDigits: digits == null ? 0 : digits }); } catch (_) { return String(Math.round(n)); }
  }
  /** "40,2 GiB" */
  function bytes(v) {
    var n = Number(v);
    if (v == null || !isFinite(n) || n < 0) return '–';
    var u = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return num(n, n >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
  }
  function pct(used, total) {
    var u = Number(used), t = Number(total);
    if (used == null || total == null || !isFinite(u) || !isFinite(t) || t <= 0) return null;
    return Math.max(0, Math.min(100, (u / t) * 100));
  }
  /** seconds → "12 T 3 Std" / "12 d 3 h" / "5 Min" */
  function duration(sec) {
    var s = Number(sec);
    if (sec == null || !isFinite(s) || s <= 0) return '–';
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return T('dur.dh', { d: d, h: h });
    if (h) return T('dur.hm', { h: h, m: m });
    return T('dur.m', { m: Math.max(1, m) });
  }
  /** ms → "12.10., 14:30" */
  function when(ms) {
    if (!ms) return '–';
    try { return new Date(ms).toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_) { return '–'; }
  }
  /** a progress bar with label "CPU 23 %" and a detail text */
  function bar(label, percent, detail) {
    var p = percent == null ? null : Math.round(percent);
    var tone = p == null ? '' : (p >= 90 ? 'crit' : (p >= 75 ? 'warn' : 'good'));
    var fill = el('span', { class: 'px-bar-fill', 'data-tone': tone || null });
    fill.style.width = (p == null ? 0 : p) + '%';
    return el('div', { class: 'px-meter' }, [
      el('div', { class: 'px-meter-head' }, [el('span', { class: 'px-meter-l', text: label }), el('span', { class: 'px-meter-v', text: (p == null ? '–' : num(percent, 1) + ' %') + (detail ? ' · ' + detail : '') })]),
      el('div', { class: 'px-bar-track', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': p == null ? null : String(p) }, [fill]),
    ]);
  }
  window.PX = {
    CTX: CTX, T: T, $: $, $$: $$, el: el, clear: clear, api: api, toast: toast, openModal: openModal, closeModal: closeModal,
    confirm: confirmDialog, svg: svg, num: num, bytes: bytes, pct: pct, duration: duration, when: when, bar: bar,
  };
  document.addEventListener('click', function (e) {
    var c = e.target && e.target.closest ? e.target.closest('[data-close]') : null;
    if (c) closeModal(c.getAttribute('data-close'));
  });
}());
