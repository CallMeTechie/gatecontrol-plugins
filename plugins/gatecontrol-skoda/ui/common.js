/* Shared helpers of the plugin pages (sandboxed frame; window.GC = host bridge). */
(function () {
  'use strict';
  var CTX = window.SK_CTX || { texts: {}, lang: 'de' };
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
      else if (k === 'disabled') n.disabled = !!v;
      else if (k === 'selected') n.selected = !!v;
      else if (k === 'open') n.open = !!v;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    [].concat(kids == null ? [] : kids).forEach(function (c) { if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  /** API of this plugin through the parent page (session + CSRF are added there). */
  function api(method, path, body) {
    if (!window.GC) return Promise.reject(new Error('no bridge'));
    return window.GC.call(method, String(path).replace(/^\/+/, ''), body);
  }
  /** The error code of a failed api() call (the plugin answers { ok:false, code, error }). */
  function codeOf(e) { return e && e.data && typeof e.data.code === 'string' ? e.data.code : null; }
  var toastTimer = null;
  function toast(msg, tone) {
    var t = $('#sk-toast');
    if (!t) { t = el('div', { id: 'sk-toast', class: 'sk-toast', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(t); }
    t.textContent = String(msg || '');
    t.setAttribute('data-tone', tone || 'good');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }
  function openModal(id) {
    var m = document.getElementById(id);
    if (!m) return;
    m.hidden = false;
    var d = m.querySelector('.modal');
    if (d && d.scrollIntoView) { try { d.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) { /* old browser */ } }
    var f = m.querySelector('input,select,button.btn-primary');
    if (f) setTimeout(function () { f.focus(); }, 30);
  }
  function closeModal(id) { var m = document.getElementById(id); if (m) m.hidden = true; }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    $$('.modal-overlay').forEach(function (m) { if (m.id) m.hidden = true; else m.remove(); });
  });
  /** In-frame confirm (sandboxed frames have no window.confirm). */
  function confirmDialog(o) {
    return new Promise(function (resolve) {
      var ov;
      var done = function (v) { ov.remove(); resolve(v); };
      var ok = el('button', { type: 'button', class: 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary'), text: o.okLabel || T('common.ok'), on: { click: function () { done(true); } } });
      ov = el('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' }, [
        el('div', { class: 'modal' }, [
          o.title ? el('div', { class: 'modal-head' }, [el('div', { class: 'modal-title', text: o.title })]) : null,
          el('div', { class: 'modal-body' }, [el('p', { class: 'modal-msg', text: o.message })]),
          el('div', { class: 'modal-foot' }, [el('button', { type: 'button', class: 'btn', text: T('common.cancel'), on: { click: function () { done(false); } } }), ok]),
        ]),
      ]);
      document.body.appendChild(ov);
      setTimeout(function () { ok.focus(); }, 30);
    });
  }
  function fmtNum(v, digits) {
    var n = Number(v);
    if (v === null || v === undefined || v === '' || !isFinite(n)) return '–';
    return n.toLocaleString(LOCALE, { maximumFractionDigits: digits == null ? 0 : digits });
  }
  /** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) or ISO → Date. */
  function toDate(v) {
    if (v == null || v === '') return null;
    var s = String(v);
    var d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? null : d;
  }
  var rtf = null;
  try { rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' }); } catch (_) { rtf = null; }
  function rel(v) {
    var d = toDate(v);
    if (!d) return '–';
    var sec = Math.round((d.getTime() - Date.now()) / 1000);
    var abs = Math.abs(sec);
    if (abs < 45) return T('time.now');
    if (!rtf) return d.toLocaleString(LOCALE);
    if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
    if (abs < 86400 * 45) return rtf.format(Math.round(sec / 86400), 'day');
    return d.toLocaleDateString(LOCALE);
  }
  /** Only a data: URL of the plugin's own image answer becomes an <img src>. */
  function safeImage(src) { return typeof src === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(src) ? src : null; }
  var IMAGE_MAX_PARTS = 32;
  /**
   * The vehicle render from the plugin's image answer, which comes in parts
   * (path?part=N → { type, part, parts, size, data }, data = a base64 slice;
   * one answer must stay under the host's 1 MB): every part in turn, joined
   * and checked by safeImage. Resolves to the data: URL or null (no usable
   * image); rejects when a part fails or the image changed in between, so the
   * caller can try again later.
   */
  function loadImage(path) {
    var chunks = [];
    var first = null;
    function part(n) {
      return api('GET', path + '?part=' + n).then(function (r) {
        if (!r || r.part !== n || typeof r.data !== 'string' || !r.data) throw new Error('bad image part');
        if (n === 0) {
          first = r;
          if (!(Number.isInteger(r.parts) && r.parts >= 1 && r.parts <= IMAGE_MAX_PARTS && Number.isInteger(r.size))) throw new Error('bad image');
        } else if (r.type !== first.type || r.parts !== first.parts || r.size !== first.size) {
          throw new Error('image changed');
        }
        chunks.push(r.data);
        return n + 1 < first.parts ? part(n + 1) : null;
      });
    }
    return part(0).then(function () {
      var b64 = chunks.join('');
      if (b64.length !== first.size) throw new Error('image incomplete');
      return safeImage('data:' + String(first.type) + ';base64,' + b64);
    });
  }
  /**
   * loadImage once per page view: cache[id] holds the data: URL, false (no
   * usable image) or the promise of a load in progress (a card rebuilt
   * meanwhile gets the image too). A failed load is forgotten, so the next
   * rebuild tries again. Resolves to the data: URL or null.
   */
  function cachedImage(cache, id, path) {
    var c = cache[id];
    if (typeof c === 'string') return Promise.resolve(c);
    if (c === false) return Promise.resolve(null);
    if (!c) {
      c = loadImage(path).then(function (src) {
        cache[id] = src || false;
        return src || null;
      }, function () {
        if (cache[id] === c) delete cache[id];
        return null;
      });
      cache[id] = c;
    }
    return c;
  }
  var DAYS = [['MONDAY', 'mon'], ['TUESDAY', 'tue'], ['WEDNESDAY', 'wed'], ['THURSDAY', 'thu'], ['FRIDAY', 'fri'], ['SATURDAY', 'sat'], ['SUNDAY', 'sun']];
  // timer save errors (codes of the plugin API) → text key
  var TIMER_ERRORS = { SKODA_TIMER_NOT_FOUND: 'timers.not_found', SKODA_TIMER_READONLY: 'timers.readonly', SKODA_VALIDATION: 'timers.invalid' };
  window.SK = {
    CTX: CTX, LOCALE: LOCALE, T: T, $: $, $$: $$, el: el, clear: clear, api: api, codeOf: codeOf, toast: toast,
    openModal: openModal, closeModal: closeModal, confirm: confirmDialog, fmtNum: fmtNum, toDate: toDate, rel: rel,
    safeImage: safeImage, loadImage: loadImage, cachedImage: cachedImage, DAYS: DAYS, TIMER_ERRORS: TIMER_ERRORS,
  };
  document.addEventListener('click', function (e) {
    var c = e.target && e.target.closest ? e.target.closest('[data-close]') : null;
    if (c) closeModal(c.getAttribute('data-close'));
  });
}());
