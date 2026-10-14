/* Shared helpers of the Familie pages and the portal tab (sandboxed frame; window.GC = host bridge). */
(function () {
  'use strict';
  var CTX = window.FA_CTX || { texts: {}, lang: 'de' };
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
  function errText(e) { return (e && e.data && e.data.error) || (e && e.message) || T('common.error'); }
  function errCode(e) { return (e && e.data && e.data.code) || null; }
  var toastTimer = null;
  function toast(msg, tone) {
    var t = $('#fa-toast');
    if (!t) { t = el('div', { id: 'fa-toast', class: 'fa-toast', role: 'status' }); document.body.appendChild(t); }
    t.textContent = String(msg || '');
    t.setAttribute('data-tone', tone || 'good');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }
  function warn(e) { toast(errText(e), 'error'); }
  function openModal(id) {
    var m = document.getElementById(id);
    if (!m) return;
    m.hidden = false;
    var d = m.querySelector('.modal');
    if (d && d.scrollIntoView) { try { d.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) { /* old browser */ } }
    var f = m.querySelector('input:not([type=hidden]),select,button.btn-primary');
    if (f) setTimeout(function () { f.focus(); }, 30);
  }
  function closeModal(id) { var m = document.getElementById(id); if (m) m.hidden = true; }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    $$('.modal-overlay').forEach(function (m) { m.hidden = true; });
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
  var COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  function safeColor(c, fallback) { return COLOR_RE.test(String(c || '')) ? c : (fallback || '#64748b'); }
  var LOCALE = CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  /** ISO time → "heute 16:42" / "gestern 17:48" / "Sa 11:02" / "12.10. 09:10" in the browser's zone. */
  function when(isoStr) {
    if (!isoStr) return '–';
    var d = new Date(isoStr);
    if (isNaN(d.getTime())) return '–';
    var now = new Date();
    var hm = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
    var day = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff === 0) return T('rel.today') + ' ' + hm;
    if (diff === 1) return T('rel.yesterday') + ' ' + hm;
    if (diff > 1 && diff < 7) return d.toLocaleDateString(LOCALE, { weekday: 'short' }) + ' ' + hm;
    return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' }) + ' ' + hm;
  }
  /** "YYYY-MM-DD" → "Mi, 15.10." / "Wed 15 Oct" */
  function day(dateStr, opts) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!m) return '';
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.toLocaleDateString(LOCALE, opts || { weekday: 'short', day: '2-digit', month: '2-digit' });
  }
  function dateLong(dateStr) {
    return day(dateStr, { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  /** Days from today (local) to dateStr. */
  function daysUntil(dateStr) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!m) return null;
    var now = new Date();
    var a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return Math.round((new Date(+m[1], +m[2] - 1, +m[3]).getTime() - a) / 86400000);
  }
  function todayStr() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  /** Client id for offline-capable records (shopping). */
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
  function avatar(m, size) {
    var a = el('span', { class: 'fa-avatar', text: initials(m && m.name), 'aria-hidden': 'true' });
    a.style.setProperty('--c', safeColor(m && m.color, '#0F766E'));
    if (size) { a.style.width = size + 'px'; a.style.height = size + 'px'; }
    return a;
  }
  /** A switch button (role=switch). */
  function switchBtn(on, label, onChange, disabled) {
    var b = el('button', { type: 'button', class: 'fa-switch', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label, disabled: !!disabled });
    b.appendChild(el('span', { class: 'fa-knob' }));
    if (!disabled) b.addEventListener('click', function () { onChange(b.getAttribute('aria-checked') !== 'true', b); });
    return b;
  }
  function setSwitch(b, on) { b.setAttribute('aria-checked', on ? 'true' : 'false'); }

  /**
   * A small form in a modal (1.2.0 sections): fields [{ key, label, type: 'text'|'textarea'|'number'|'money'|'date'|'time'|
   * 'select'|'checkbox'|'checks', value, options: [{ value, label }], max, min, step, hint, show: (values) => bool }].
   * check(values) → error text or null. Resolves the values (money in cents) or null when cancelled.
   */
  function form(title, fields, opts) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var ov;
      var inputs = {};
      var groups = {};
      var msg = el('p', { class: 'fa-msg', role: 'status' });
      function values() {
        var v = {};
        fields.forEach(function (f) {
          var i = inputs[f.key];
          if (f.type === 'checkbox') v[f.key] = i.checked;
          else if (f.type === 'checks') v[f.key] = $$('input:checked', i).map(function (x) { return x.value; });
          else if (f.type === 'number') v[f.key] = i.value === '' ? null : Number(i.value);
          else if (f.type === 'money') v[f.key] = i.value.trim() === '' ? null : (parseMoney(i.value) == null ? NaN : parseMoney(i.value)); // NaN = not a number
          else v[f.key] = i.value;
        });
        return v;
      }
      function sync() { var v = values(); fields.forEach(function (f) { if (f.show) groups[f.key].hidden = !f.show(v); }); }
      var body = el('div', { class: 'modal-body' });
      fields.forEach(function (f, n) {
        var id = 'fa-form-' + n;
        var input;
        if (f.type === 'textarea') input = el('textarea', { class: 'form-input', id: id, rows: '3', maxlength: f.max ? String(f.max) : null });
        else if (f.type === 'select') input = el('select', { class: 'form-select', id: id }, (f.options || []).map(function (x) { return el('option', { value: String(x.value), text: x.label }); }));
        else if (f.type === 'checks') {
          input = el('div', { class: 'fa-check-list', id: id }, (f.options || []).map(function (x) {
            return el('label', { class: 'fa-check-row' }, [el('input', { type: 'checkbox', value: String(x.value), checked: (f.value || []).indexOf(String(x.value)) >= 0 }), x.label]);
          }));
          if (!(f.options || []).length) input.appendChild(el('p', { class: 'fa-empty', text: f.empty || '–' }));
        } else if (f.type === 'checkbox') input = el('input', { type: 'checkbox', id: id, checked: !!f.value });
        else {
          var type = f.type === 'money' ? 'text' : (f.type || 'text');
          input = el('input', { class: 'form-input', id: id, type: type, maxlength: f.max && type === 'text' ? String(f.max) : null, min: f.min != null ? String(f.min) : null,
            max: f.type === 'number' && f.maxValue != null ? String(f.maxValue) : null, step: f.step != null ? String(f.step) : null, inputmode: f.type === 'money' ? 'decimal' : null, autocomplete: 'off' });
        }
        if (f.type !== 'checkbox' && f.type !== 'checks') input.value = f.value == null ? '' : (f.type === 'money' ? moneyInput(f.value) : String(f.value));
        inputs[f.key] = input;
        input.addEventListener('change', sync);
        var g = f.type === 'checkbox'
          ? el('label', { class: 'check form-group' }, [input, ' ' + f.label])
          : el('div', { class: 'form-group' }, [f.type === 'checks' ? el('div', { class: 'form-label', text: f.label }) : el('label', { class: 'form-label', for: id, text: f.label }), input, f.hint ? el('p', { class: 'fa-hint', text: f.hint }) : null]);
        groups[f.key] = g;
        body.appendChild(g);
      });
      body.appendChild(msg);
      var done = function (v) { ov.remove(); resolve(v); };
      var save = el('button', { type: 'button', class: 'btn btn-primary', text: o.okLabel || T('common.save') });
      save.addEventListener('click', function () {
        var v = values();
        var err = o.check ? o.check(v) : null;
        if (err) { msg.textContent = err; return; }
        if (o.submit) {
          save.disabled = true;
          Promise.resolve(o.submit(v)).then(function () { done(v); }).catch(function (e) { save.disabled = false; msg.textContent = errText(e); });
        } else done(v);
      });
      var foot = [o.onDelete ? el('button', { type: 'button', class: 'btn btn-danger', text: T('common.delete'), on: { click: function () { done(null); o.onDelete(); } } }) : null,
        el('span', { class: 'fa-spacer' }), el('button', { type: 'button', class: 'btn', text: T('common.cancel'), on: { click: function () { done(null); } } }), save];
      ov = el('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
        el('div', { class: 'modal' + (o.wide ? ' modal-wide' : '') }, [
          el('div', { class: 'modal-head' }, [el('div', { class: 'modal-title', text: title }), el('button', { type: 'button', class: 'btn modal-close', 'aria-label': T('common.close'), text: '×', on: { click: function () { done(null); } } })]),
          body,
          el('div', { class: 'modal-foot' }, foot),
        ]),
      ]);
      document.body.appendChild(ov);
      sync();
      var first = body.querySelector('input:not([type=checkbox]),select,textarea');
      if (first) setTimeout(function () { first.focus(); }, 30);
    });
  }
  /** "5,50" / "5.50" / "5" → 550 (null when not a number). */
  function parseMoney(s) {
    var t = String(s == null ? '' : s).trim().replace(/[€\s]/g, '').replace(',', '.');
    if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
    return Math.round(Number(t) * 100);
  }
  function moneyInput(cents) {
    var n = Number(cents) || 0;
    var a = Math.abs(n);
    return (n < 0 ? '-' : '') + Math.floor(a / 100) + (CTX.lang === 'en' ? '.' : ',') + String(a % 100).padStart(2, '0');
  }
  /** 550 → "5,50 €" / "€5.50" */
  function money(cents) {
    var n = Number(cents) || 0;
    try { return (n / 100).toLocaleString(LOCALE, { style: 'currency', currency: 'EUR' }); } catch (_) { return moneyInput(n) + ' €'; }
  }

  window.FA = {
    CTX: CTX, T: T, $: $, $$: $$, el: el, clear: clear, api: api, errText: errText, errCode: errCode, toast: toast, warn: warn,
    openModal: openModal, closeModal: closeModal, confirm: confirmDialog, svg: svg, safeColor: safeColor,
    when: when, day: day, dateLong: dateLong, daysUntil: daysUntil, todayStr: todayStr, uuid: uuid, initials: initials, avatar: avatar,
    switchBtn: switchBtn, setSwitch: setSwitch, form: form, parseMoney: parseMoney, money: money,
  };
  document.addEventListener('click', function (e) {
    var c = e.target && e.target.closest ? e.target.closest('[data-close]') : null;
    if (c) closeModal(c.getAttribute('data-close'));
    var n = e.target && e.target.closest ? e.target.closest('[data-nav]') : null;
    if (n && window.GC) { e.preventDefault(); window.GC.navigate(n.getAttribute('data-nav')); }
  });
}());
