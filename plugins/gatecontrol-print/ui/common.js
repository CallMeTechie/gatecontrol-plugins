/* Shared helpers of the "Drucken & Scannen" pages and the portal tab (sandboxed frame; window.GC = host bridge). */
(function () {
  'use strict';
  var CTX = window.PR_CTX || { texts: {}, lang: 'de' };
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
    var t = $('#pr-toast');
    if (!t) { t = el('div', { id: 'pr-toast', class: 'pr-toast', role: 'status' }); document.body.appendChild(t); }
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
  /** A preview of the API (base64 JPEG) as a data: URL, null for anything else. */
  function thumbUrl(b64) {
    return typeof b64 === 'string' && /^[A-Za-z0-9+/=]+$/.test(b64) ? 'data:image/jpeg;base64,' + b64 : null;
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
    return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' }) + ' ' + hm;
  }
  function ago(isoStr) {
    var d = Date.parse(isoStr);
    if (!isFinite(d)) return null;
    var min = Math.max(0, Math.round((Date.now() - d) / 60000));
    return min < 1 ? T('rel.now') : (min < 60 ? T('rel.min', { n: min }) : when(isoStr));
  }
  /** Tone and text of a job state */
  var JOB_TONE = { done: 'good', queued: '', sending: '', printing: '', waiting: 'warn', failed: 'crit', expired: 'crit', canceled: '' };
  function jobBadge(j) { return el('span', { class: 'pr-badge', 'data-tone': JOB_TONE[j.state] || '', text: T('job.' + j.state) }); }
  function jobReason(j) {
    // the gateway turns a PDF into the printer's own format first (printer without PDF)
    if (j.state === 'sending' && j.message === 'converting') return T('job.converting');
    // … or makes a PDF of an office file (its service office)
    if (j.state === 'sending' && j.message === 'converting_office') return T('job.converting_office');
    // the printer stopped while printing (paper out, cover open …) — GateControl ≥ 1.247.0
    if (j.state === 'printing' && j.message && T('job.stop.' + j.message) !== 'job.stop.' + j.message) return T('job.stop.' + j.message);
    if (j.state === 'waiting') return T('job.waiting_why.' + (j.error || 'printer_offline'));
    if (j.state === 'failed' || j.state === 'expired') return T('jerr.' + (j.error || j.state));
    return null;
  }
  /** A paper size's name: "A4", "Foto 10 × 15 cm" … (PWG name → text; unknown: the name itself) */
  function paperName(m) { var k = 'paper.' + m; var s = T(k); return s === k ? m : s; }
  /** A tray's name: "Hauptfach", "Fotofach", "Fach 2" … */
  function trayName(s) {
    var k = 'tray.' + s;
    var x = T(k);
    if (x !== k) return x;
    var n = /^tray-(\d{1,2})$/.exec(s);
    return n ? T('tray.n', { n: n[1] }) : s;
  }
  /** "Drucker + Scanner", "Drucker", "Scanner" */
  function kindText(d) { return T(d.printer && d.scanner ? 'kind.both' : (d.printer ? 'kind.printer' : 'kind.scanner')); }
  window.PR = { CTX: CTX, T: T, $: $, el: el, clear: clear, api: api, toast: toast, warn: warn, errText: errText, dialog: dialog, confirmDialog: confirmDialog, thumbUrl: thumbUrl, when: when, ago: ago, jobBadge: jobBadge, jobReason: jobReason, kindText: kindText, paperName: paperName, trayName: trayName };
})();
