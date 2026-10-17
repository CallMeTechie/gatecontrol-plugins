/* Shared helpers of the Tür & Kamera pages and the portal tab (sandboxed frame; window.GC = host bridge). */
(function () {
  'use strict';
  var CTX = window.DOOR_CTX || { texts: {}, lang: 'de' };
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
    var t = $('#dr-toast');
    if (!t) { t = el('div', { id: 'dr-toast', class: 'dr-toast', role: 'status' }); document.body.appendChild(t); }
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
    });
  }
  function confirmDialog(message, okLabel) {
    return dialog(el('p', { text: message }), [{ label: T('common.cancel'), value: false }, { label: okLabel || T('common.ok'), value: true, primary: true }]);
  }
  /** A picture of the API ({ mime, data }) as a data: URL — JPEG/PNG/WebP only. */
  function imgUrl(img) {
    if (!img || !/^image\/(jpeg|png|webp)$/.test(String(img.mime)) || !/^[A-Za-z0-9+/=]+$/.test(String(img.data || ''))) return null;
    return 'data:' + img.mime + ';base64,' + img.data;
  }
  function showImage(img) {
    var u = imgUrl(img);
    if (u) dialog(el('img', { src: u, alt: '' }));
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
  /** Badge tone of a lock state. */
  function tone(lock) {
    var s = lock.state || {};
    if (!s.reachable || s.lock === 'jammed') return 'crit';
    if (s.stale) return 'warn';
    if (s.lock === 'locked') return 'good';
    if (s.lock === 'unlocked' || s.lock === 'unlatched' || s.door === 'open') return 'warn';
    return '';
  }
  /** The badge: the state; "Zustand unklar" when a transitional state did not end (stale). */
  function badgeText(lock) {
    var s = lock.state || {};
    if (!s.reachable) return T('portal.unreachable');
    return s.stale ? T('state.unclear') : T('state.' + s.lock);
  }
  function stateText(lock) {
    var s = lock.state || {};
    var parts = [!s.reachable ? T('portal.unreachable') : (!s.stale ? T('state.' + s.lock) : (s.lock === 'unknown' ? T('state.unclear') : T('state.stale', { state: T('state.' + s.lock) })))];
    if (s.door) parts.push(T('door.' + s.door));
    if (s.batteryCritical) parts.push(T('portal.battery_low'));
    else if (s.batteryPercent != null) parts.push(s.batteryPercent + ' %');
    return parts.join(' · ');
  }
  function actLabel(lock, a) { return T(a === 'open' && lock.type === 'opener' ? 'act.buzz' : 'act.' + a); }
  /** A 24×24 stroke icon (SVG path data from the server). */
  function icon(d) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', String(d || ''));
    svg.appendChild(p);
    return svg;
  }
  var MODES = ['disarmed', 'home', 'away'];
  /** The name of a Ring mode ("Zuhause"); unknown values → "Unbekannt". */
  function modeText(mode) { return mode && T('mode.' + mode) !== 'mode.' + mode ? T('mode.' + mode) : T('mode.unknown'); }
  function modeTone(mode) { return mode === 'home' || mode === 'away' ? 'good' : ''; }
  /**
   * The three mode buttons like the Ring app (Inaktiv / Zuhause / Abwesend); the current one pressed.
   * onPick(mode) → a promise; the buttons wait for it.
   */
  function modeSeg(name, current, disabled, onPick) {
    var icons = CTX.modeIcons || {};
    var box = el('div', { class: 'dr-seg', role: 'group', 'aria-label': T('mode.title') + ' – ' + name });
    var buttons = MODES.map(function (m) {
      return el('button', { type: 'button', 'data-mode': m, 'aria-pressed': m === current ? 'true' : 'false', disabled: !!disabled, on: { click: function () {
        buttons.forEach(function (b) { b.disabled = true; });
        box.setAttribute('aria-busy', 'true');
        Promise.resolve(onPick(m)).catch(warn).then(function () { box.removeAttribute('aria-busy'); buttons.forEach(function (b) { b.disabled = !!disabled; }); });
      } } }, [icon(icons[m]), el('span', { text: modeText(m) })]);
    });
    buttons.forEach(function (b) { box.appendChild(b); });
    return box;
  }
  window.DOOR = { CTX: CTX, T: T, $: $, el: el, clear: clear, api: api, toast: toast, warn: warn, errText: errText, dialog: dialog, confirmDialog: confirmDialog, imgUrl: imgUrl, showImage: showImage, when: when, tone: tone, badgeText: badgeText, stateText: stateText, actLabel: actLabel, icon: icon, MODES: MODES, modeText: modeText, modeTone: modeTone, modeSeg: modeSeg };
})();
