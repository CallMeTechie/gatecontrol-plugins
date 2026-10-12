/* Helpers of the plugin page (sandboxed frame; window.GC = host bridge). */
(function () {
  'use strict';
  var CTX = window.SY_CTX || { texts: {}, lang: 'de' };
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
    var t = $('#sy-toast');
    if (!t) { t = el('div', { id: 'sy-toast', class: 'sy-toast', role: 'status' }); document.body.appendChild(t); }
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
    var f = m.querySelector('input:not([type=hidden]):not([disabled]),select,button.btn-primary');
    if (f) setTimeout(function () { try { f.focus(); } catch (_) { /* hidden */ } }, 30);
  }
  function closeModal(id) { var m = document.getElementById(id); if (m) m.hidden = true; }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    $$('.modal-overlay').forEach(function (m) { if (m.hasAttribute('data-dynamic')) m.remove(); else m.hidden = true; });
  });
  /**
   * In-frame confirm (sandboxed frames have no window.confirm).
   * opts: { title, detail, danger, ack } — ack: a checkbox text that has to be ticked first.
   */
  function confirmDialog(message, okLabel, opts) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var ov;
      var done = function (v) { if (ov.parentNode) ov.remove(); resolve(v); };
      var ok = el('button', { type: 'button', class: 'btn ' + (o.danger ? 'btn-danger-solid' : 'btn-primary'), text: okLabel || T('common.ok'), on: { click: function () { done(true); } } });
      var body = [el('p', { class: 'modal-msg', text: message })];
      if (o.detail) body.push(el('p', { class: 'modal-detail' + (o.danger ? ' is-danger' : ''), text: o.detail }));
      if (o.ack) {
        ok.disabled = true;
        var cb = el('input', { type: 'checkbox', id: 'sy-ack' });
        cb.addEventListener('change', function () { ok.disabled = !cb.checked; });
        body.push(el('label', { class: 'check sy-ack', for: 'sy-ack' }, [cb, ' ' + o.ack]));
      }
      ov = el('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true', 'data-dynamic': '1' }, [
        el('div', { class: 'modal' }, [
          o.title ? el('div', { class: 'modal-head' }, [el('div', { class: 'modal-title', text: o.title })]) : null,
          el('div', { class: 'modal-body' }, body),
          el('div', { class: 'modal-foot' }, [el('button', { type: 'button', class: 'btn', text: T('common.cancel'), on: { click: function () { done(false); } } }), ok]),
        ]),
      ]);
      document.body.appendChild(ov);
      setTimeout(function () { try { (o.ack ? ov.querySelector('input') : ok).focus(); } catch (_) { /* gone */ } }, 30);
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
  var LOC = CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  function num(v, digits) {
    if (v == null || !isFinite(v)) return '–';
    try { return Number(v).toLocaleString(LOC, { maximumFractionDigits: digits || 0 }); } catch (_) { return String(v); }
  }
  /** Bytes → "3,64 TB" / "512 GB" (decimal, like DSM). */
  function bytes(v) {
    if (v == null || !isFinite(v)) return '–';
    if (v >= 1e12) return num(v / 1e12, 2) + ' TB';
    if (v >= 1e9) return num(v / 1e9, v >= 1e11 ? 0 : 1) + ' GB';
    return num(v / 1e6, 0) + ' MB';
  }
  function when(ms) {
    if (!ms) return '–';
    try { return new Date(ms).toLocaleString(LOC, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_) { return '–'; }
  }
  /** Seconds → "12 T 4 Std" / "12 d 4 h" */
  function duration(s) {
    if (s == null || !isFinite(s)) return '–';
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return T('dur.dh', { d: d, h: h });
    if (h) return T('dur.hm', { h: h, m: m });
    return T('dur.m', { m: m });
  }
  window.SY = { CTX: CTX, T: T, $: $, $$: $$, el: el, clear: clear, api: api, toast: toast, openModal: openModal, closeModal: closeModal, confirm: confirmDialog, svg: svg, num: num, bytes: bytes, when: when, duration: duration };
  document.addEventListener('click', function (e) {
    var c = e.target && e.target.closest ? e.target.closest('[data-close]') : null;
    if (c) closeModal(c.getAttribute('data-close'));
  });
}());
