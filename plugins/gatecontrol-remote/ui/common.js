/* Shared helpers of the "Fernzugriff" pages, the portal tab and the profile section (sandboxed frame; window.GC = host bridge). */
(function () {
  'use strict';
  var CTX = window.RM_CTX || { texts: {}, lang: 'de' };
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
      else if (k === 'selected') n.selected = !!v;
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
  function errText(e) { return (e && e.data && e.data.error) || (e && e.message) || T('common.error'); }
  var toastTimer = null;
  function toast(msg, tone) {
    var t = $('#rm-toast');
    if (!t) { t = el('div', { id: 'rm-toast', class: 'rm-toast', role: 'status' }); document.body.appendChild(t); }
    t.textContent = String(msg || '');
    t.setAttribute('data-tone', tone || 'good');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }
  function warn(e) { toast(errText(e), 'error'); }
  /** In-frame dialog (sandboxed frames have no window.confirm). */
  function dialog(content, buttons) {
    return new Promise(function (resolve) {
      var ov;
      var done = function (v) { ov.remove(); resolve(v); };
      var foot = el('div', { class: 'modal-foot' }, (buttons || [{ label: T('common.close'), value: false }]).map(function (b) {
        return el('button', { type: 'button', class: 'btn ' + (b.primary ? 'btn-primary' : ''), text: b.label, on: { click: function () { done(b.value); } } });
      }));
      ov = el('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' }, [el('div', { class: 'modal' }, [el('div', { class: 'modal-body' }, [content]), foot])]);
      document.body.appendChild(ov);
      var first = foot.querySelector('button:last-child');
      if (first) first.focus();
    });
  }
  function confirmDialog(message, okLabel) {
    return dialog(el('p', { text: message }), [{ label: T('common.cancel'), value: false }, { label: okLabel || T('common.ok'), value: true, primary: true }]);
  }
  var LOCALE = CTX.lang === 'en' ? 'en-GB' : 'de-DE';
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
    return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' + hm;
  }
  function ago(isoStr) {
    var d = Date.parse(isoStr);
    if (!isFinite(d)) return null;
    var min = Math.max(0, Math.round((Date.now() - d) / 60000));
    return min < 1 ? T('rel.now') : (min < 60 ? T('rel.min', { n: min }) : when(isoStr));
  }
  /** "1 h 5 min", "42 s" */
  function duration(sec) {
    if (sec == null || !isFinite(sec)) return '–';
    var s = Math.max(0, Math.round(sec));
    if (s < 60) return T('dur.s', { n: s });
    var m = Math.floor(s / 60);
    if (m < 60) return T('dur.m', { n: m });
    return T('dur.hm', { h: Math.floor(m / 60), m: m % 60 });
  }
  /** State of a device: online / offline / not checked, maintenance */
  function stateBadge(d) {
    if (d.enabled === false) return el('span', { class: 'rm-badge', text: T('state.disabled') });
    if (d.maintenance) return el('span', { class: 'rm-badge', 'data-tone': 'warn', text: T('state.maintenance') });
    var on = d.online != null ? d.online : (d.status ? d.status.online : null);
    if (on === true) return el('span', { class: 'rm-badge', 'data-tone': 'good', text: T('state.online') });
    if (on === false) return el('span', { class: 'rm-badge', 'data-tone': 'crit', text: T('state.offline') });
    return el('span', { class: 'rm-badge', text: T('state.unknown') });
  }
  function protoBadge(p) { return el('span', { class: 'rm-badge rm-proto', text: T('proto.' + p) }); }
  /**
   * Open a ticket of GateControl's session page. GC.openSession needs the click; when the answer took too long
   * (no_gesture) a second button opens it within its own click.
   */
  function openSession(ref, host) {
    if (!window.GC || typeof window.GC.openSession !== 'function') { toast(T('connect.no_bridge'), 'error'); return Promise.resolve(false); }
    return window.GC.openSession(ref).then(function (r) {
      if (r && r.ok) { toast(T('connect.opened')); return true; }
      if (r && r.code === 'no_gesture' && host) {
        var b = el('button', { type: 'button', class: 'btn btn-primary', text: T('connect.open_now'), on: { click: function () {
          window.GC.openSession(ref).then(function (x) { if (x && x.ok) { b.remove(); toast(T('connect.opened')); } else toast(T('connect.failed.' + ((x && x.code) || 'failed')), 'error'); });
        } } });
        host.appendChild(b);
        b.focus();
        return false;
      }
      toast(T('connect.failed.' + ((r && r.code) || 'failed')), 'error');
      return false;
    });
  }
  window.RM = { CTX: CTX, T: T, $: $, el: el, clear: clear, api: api, toast: toast, warn: warn, errText: errText, dialog: dialog, confirmDialog: confirmDialog, when: when, ago: ago, duration: duration, stateBadge: stateBadge, protoBadge: protoBadge, openSession: openSession };
})();
