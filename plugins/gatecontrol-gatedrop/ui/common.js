/* Shared helpers of the GateDrop pages (sandboxed frame; window.GC = host bridge). */
(function () {
  'use strict';
  var CTX = window.GD_CTX || { texts: {}, lang: 'de' };
  function T(key, params) {
    var s = CTX.texts && CTX.texts[key] != null ? String(CTX.texts[key]) : key;
    if (params) Object.keys(params).forEach(function (k) { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  var $ = function (s, r) { return (r || document).querySelector(s); };
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
    (kids || []).forEach(function (c) { if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function api(method, path, body) {
    if (!window.GC) return Promise.reject(new Error('no bridge'));
    return window.GC.call(method, String(path).replace(/^\/+/, ''), body);
  }
  function errText(e) {
    var c = e && e.data && e.data.code;
    if (c && CTX.texts && CTX.texts['error.' + c]) return T('error.' + c);
    return (e && e.data && e.data.error) || T('error.internal');
  }
  var toastTimer = null;
  function toast(msg, tone) {
    var t = $('#gd-toast');
    if (!t) { t = el('div', { id: 'gd-toast', class: 'gd-toast', role: 'status' }); document.body.appendChild(t); }
    t.textContent = String(msg || '');
    t.setAttribute('data-tone', tone || 'good');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }
  /** In-frame confirm (sandboxed frames have no window.confirm). */
  function confirmDialog(message, okLabel) {
    return new Promise(function (resolve) {
      var ov;
      var done = function (v) { ov.remove(); resolve(v); };
      var okBtn = el('button', { type: 'button', class: 'btn btn-primary', text: okLabel, on: { click: function () { done(true); } } });
      ov = el('div', { class: 'gd-overlay', role: 'dialog', 'aria-modal': 'true' }, [
        el('div', { class: 'gd-modal' }, [el('p', { text: message }), el('div', { class: 'gd-modal-foot' }, [
          el('button', { type: 'button', class: 'btn', text: '×', 'aria-label': 'Abbrechen', on: { click: function () { done(false); } } }), okBtn])]),
      ]);
      document.body.appendChild(ov);
      setTimeout(function () { okBtn.focus(); }, 30);
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
  function bytes(n) {
    var v = Number(n) || 0;
    var u = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    var s = (i === 0 ? String(Math.round(v)) : v.toFixed(v < 10 ? 1 : 0));
    return (CTX.lang === 'de' ? s.replace('.', ',') : s) + ' ' + u[i];
  }
  /** "heute 10:12" / "gestern" / "Mo. 20.10." */
  function when(isoStr) {
    var d = new Date(isoStr);
    if (isNaN(d)) return '';
    var now = new Date();
    var day = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((day(now) - day(d)) / 86400000);
    var loc = CTX.lang === 'en' ? 'en-GB' : 'de-DE';
    if (diff === 0) return T('portal.today') + ' ' + d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
    if (diff === 1) return T('portal.yesterday');
    return d.toLocaleDateString(loc, { weekday: 'short', day: '2-digit', month: '2-digit' });
  }
  window.GD = { CTX: CTX, T: T, $: $, el: el, clear: clear, api: api, errText: errText, toast: toast, confirm: confirmDialog, svg: svg, bytes: bytes, when: when };
}());
