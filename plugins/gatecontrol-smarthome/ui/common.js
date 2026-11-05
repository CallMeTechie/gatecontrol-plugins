/* Shared helpers of the plugin pages (sandboxed frame; window.GC = host bridge). */
(function () {
  'use strict';
  var CTX = window.SH_CTX || { texts: {}, lang: 'de' };
  function T(key, params) {
    var s = CTX.texts && CTX.texts[key] != null ? String(CTX.texts[key]) : key;
    if (params) Object.keys(params).forEach(function (k) { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  /** el('div', { class, text, on: { click } , attrs… }, [children]) — text only via textContent. */
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
    var t = $('#sh-toast');
    if (!t) { t = el('div', { id: 'sh-toast', class: 'sh-toast', role: 'status' }); document.body.appendChild(t); }
    t.textContent = String(msg || '');
    t.setAttribute('data-tone', tone || 'good');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }
  // dialogs: focus moves in (first field), stays in (Tab wraps) and goes back to the opener when closed
  var openers = {};
  function focusables(m) {
    return $$('input,select,textarea,button,a[href],summary,[tabindex]:not([tabindex="-1"])', m).filter(function (n) {
      return !n.disabled && !n.hidden && n.offsetParent !== null && n.getAttribute('tabindex') !== '-1';
    });
  }
  function openModal(id, focusSel) {
    var m = document.getElementById(id);
    if (!m) return;
    if (m.hidden && document.activeElement && document.activeElement !== document.body) openers[id] = document.activeElement;
    m.hidden = false;
    var d = m.querySelector('.modal');
    if (d && d.scrollIntoView) { try { d.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) { /* old browser */ } }
    var f = (focusSel && m.querySelector(focusSel)) || m.querySelector('input:not([type=radio]):not([disabled]),select:not([disabled]),button.btn-primary:not([disabled])') || focusables(m)[0];
    if (f) setTimeout(function () { f.focus(); }, 30);
  }
  function closeModal(id) {
    var m = document.getElementById(id);
    if (!m || m.hidden) return;
    m.hidden = true;
    m.dispatchEvent(new CustomEvent('sh:close'));
    var o = openers[id];
    delete openers[id];
    if (o && document.contains(o) && !$$('.modal-overlay').some(function (x) { return !x.hidden; })) { try { o.focus(); } catch (_) { /* gone */ } }
  }
  function topModal() {
    var open = $$('.modal-overlay').filter(function (m) { return !m.hidden; });
    return open.length ? open[open.length - 1] : null;
  }
  document.addEventListener('keydown', function (e) {
    var m = topModal();
    if (!m) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (m.id) closeModal(m.id); else m.hidden = true;
      return;
    }
    if (e.key !== 'Tab') return;
    var f = focusables(m);
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !m.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !m.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  });
  /** A text with [[key words]] → nodes, the marked parts as <span class="kb"> (never HTML from data). */
  function kbText(text) {
    var out = [];
    String(text).split(/(\[\[[^\]]+\]\])/).forEach(function (part) {
      if (!part) return;
      var m = /^\[\[([^\]]+)\]\]$/.exec(part);
      out.push(m ? el('span', { class: 'kb', text: m[1] }) : document.createTextNode(part));
    });
    return out;
  }
  /** Copy a text: the clipboard API where the frame may use it, else a selection + execCommand. */
  function copyText(text) {
    var fallback = function () {
      var ta = el('textarea', { class: 'sh-copy-buffer', readonly: 'readonly', 'aria-hidden': 'true' });
      ta.value = String(text);
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(String(text)).then(function () { return true; }, function () { return fallback(); });
    } catch (_) { /* no clipboard */ }
    return Promise.resolve(fallback());
  }
  /** "vor 9 Min." (ago) or "2 Std." (a duration) since an ISO time. */
  function since(iso, dur) {
    var ms = Date.now() - Date.parse(iso);
    if (!isFinite(ms)) return '';
    var min = Math.max(0, Math.round(ms / 60000));
    if (!dur && min < 1) return T('time.now');
    if (min < 60) return T(dur ? 'time.dur_min' : 'time.ago_min', { n: Math.max(1, min) });
    var h = Math.round(min / 60);
    if (h < 48) return T(dur ? 'time.dur_h' : 'time.ago_h', { n: h });
    return T(dur ? 'time.dur_d' : 'time.ago_d', { n: Math.round(h / 24) });
  }
  /** In-frame confirm (sandboxed frames have no window.confirm). */
  function confirmDialog(message, okLabel, danger) {
    return new Promise(function (resolve) {
      var ov;
      var settled = false;
      var done = function (v) { if (settled) return; settled = true; if (ov.parentNode) ov.parentNode.removeChild(ov); resolve(v); };
      var ok = el('button', { type: 'button', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), text: okLabel || T('common.ok'), on: { click: function () { done(true); } } });
      ov = el('div', { class: 'modal-overlay', id: 'sh-confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': message }, [
        el('div', { class: 'modal' }, [
          el('div', { class: 'modal-body' }, [el('p', { class: 'modal-msg', text: message })]),
          el('div', { class: 'modal-foot' }, [el('button', { type: 'button', class: 'btn', text: T('common.cancel'), on: { click: function () { done(false); } } }), ok]),
        ]),
      ]);
      ov.addEventListener('sh:close', function () { done(false); });
      document.body.appendChild(ov);
      setTimeout(function () { ok.focus(); }, 30);
    });
  }
  // 8 colour presets → hue/sat (deCONZ hue 0–65535, sat 0–254); the plugin
  // converts them for lights that only take xy
  var SWATCHES = [
    { c: '#ff7a59', hue: 2000, sat: 200 }, { c: '#ff5d8f', hue: 60000, sat: 200 },
    { c: '#9d7bff', hue: 47000, sat: 180 }, { c: '#5b8cff', hue: 44000, sat: 200 },
    { c: '#36d6c3', hue: 33000, sat: 200 }, { c: '#8be36b', hue: 23000, sat: 200 },
    { c: '#ffd27a', hue: 8000, sat: 160 }, { c: '#ffffff', hue: 0, sat: 0 },
  ];
  function hasColour(caps) { return !!caps && (caps.color === 'hs' || caps.color === 'xy'); }
  function hasWarmth(caps) { return !!caps && (caps.color === 'ct' || caps.ct === true); }
  window.SH = { CTX: CTX, T: T, esc: esc, $: $, $$: $$, el: el, clear: clear, api: api, toast: toast, openModal: openModal, closeModal: closeModal, confirm: confirmDialog,
    SWATCHES: SWATCHES, hasColour: hasColour, hasWarmth: hasWarmth, kbText: kbText, copyText: copyText, since: since };
  document.addEventListener('click', function (e) {
    var c = e.target && e.target.closest ? e.target.closest('[data-close]') : null;
    if (c) closeModal(c.getAttribute('data-close'));
    var n = e.target && e.target.closest ? e.target.closest('[data-nav]') : null;
    if (n && window.GC) { e.preventDefault(); window.GC.navigate(n.getAttribute('data-nav')); }
  });
}());
