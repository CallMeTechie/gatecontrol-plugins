/* Shared helpers of the "Medien" pages (sandboxed frame; window.GC = host bridge). Text only via textContent. */
(function () {
  'use strict';
  var CTX = window.MD_CTX || { texts: {}, lang: 'de' };
  function T(key, params) {
    var s = CTX.texts && CTX.texts[key] != null ? String(CTX.texts[key]) : key;
    if (params) Object.keys(params).forEach(function (k) { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  var $ = function (s, r) { return (r || document).querySelector(s); };
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
    var t = $('#md-toast');
    if (!t) { t = el('div', { id: 'md-toast', class: 'md-toast', role: 'status' }); document.body.appendChild(t); }
    t.textContent = String(msg || '');
    t.setAttribute('data-tone', tone || 'good');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }
  function warn(e) { toast(errText(e), 'error'); }
  /** In-frame dialog (sandboxed frames have no window.confirm). buttons: [{ label, value, primary, danger, run }] — run may return a promise; false keeps it open. */
  function dialog(content, buttons) {
    return new Promise(function (resolve) {
      var ov;
      var done = function (v) { ov.remove(); resolve(v); };
      var foot = el('div', { class: 'modal-foot' }, (buttons || [{ label: T('common.close'), value: false }]).map(function (b) {
        var btn = el('button', { type: 'button', class: 'btn ' + (b.primary ? 'btn-primary' : '') + (b.danger ? ' btn-danger' : ''), text: b.label });
        btn.addEventListener('click', function () {
          if (!b.run) { done(b.value); return; }
          btn.disabled = true;
          Promise.resolve(b.run()).then(function (r) { btn.disabled = false; if (r !== false) done(r === undefined ? b.value : r); }).catch(function (e) { btn.disabled = false; warn(e); });
        });
        return btn;
      }));
      ov = el('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true', on: { keydown: function (ev) { if (ev.key === 'Escape') { ev.stopPropagation(); done(false); } } } }, [el('div', { class: 'modal' }, [el('div', { class: 'modal-body' }, [content]), foot])]);
      document.body.appendChild(ov);
      var first = ov.querySelector('input,select,textarea') || foot.querySelector('button:last-child');
      if (first) first.focus();
    });
  }
  function confirmDialog(message, okLabel, danger) {
    return dialog(el('p', { text: message }), [{ label: T('common.cancel'), value: false }, { label: okLabel || T('common.ok'), value: true, primary: !danger, danger: !!danger }]);
  }
  var LOCALE = CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  function when(v) {
    if (!v) return '–';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '–';
    return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' + d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  }
  function badge(text, tone) { return el('span', { class: 'md-badge', 'data-tone': tone || null, text: text }); }
  function avatar(u) {
    if (u.avatarUrl) return el('img', { class: 'md-av', src: u.avatarUrl, alt: '' });
    var av = el('span', { class: 'md-av', text: u.initials || (u.name || '?').slice(0, 1) });
    if (u.color) av.style.background = u.color;
    return av;
  }
  function field(label, input, hint) {
    return el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: label }), input, hint ? el('p', { class: 'md-hint', text: hint }) : null]);
  }
  function input(attrs) { return el('input', Object.assign({ class: 'form-input' }, attrs || {})); }
  function check(label, checked) {
    var box = el('input', { type: 'checkbox', checked: checked });
    return { box: box, node: el('label', { class: 'check' }, [box, el('span', { text: label })]) };
  }
  function targetSelect(list, value, allowNone) {
    var s = el('select', { class: 'form-select' }, (allowNone ? [el('option', { value: '', text: T('common.none') })] : []).concat((list || []).map(function (t) {
      return el('option', { value: String(t.index), text: (t.label || T('src.target_n', { n: t.index + 1 })) });
    })));
    if (!(list || []).length && !allowNone) s.appendChild(el('option', { value: '0', text: T('src.no_target') }));
    s.value = value == null ? '' : String(value);
    return s;
  }
  /** The home targets are assigned by the administrator only (Einstellungen › Plugins › Medien › Zugriffsziele). */
  function targetsLink() {
    return el('button', { type: 'button', class: 'btn btn-sm', text: T('src.targets_open'), on: { click: function () {
      if (window.GC && typeof window.GC.openSettings === 'function') window.GC.openSettings(); else toast(T('src.targets_where'));
    } } });
  }
  /** One line per check result: tone + text. */
  function checks(st) {
    var items = [];
    if (!st || !st.at) return el('p', { class: 'md-hint', text: T('check.never') });
    if (st.reachable != null) {
      items.push([st.reachable ? 'good' : 'crit', st.reachable ? T('check.reachable', { name: st.serverName || '', version: st.version || '?' }) : T('check.unreachable.' + (st.problem === 'no_target' ? 'no_target' : 'net'))]);
      if (st.reachable && st.versionOk === false) items.push(['crit', T('check.version_old', { version: st.version })]);
      if (st.keyValid != null) items.push([st.keyValid ? 'good' : 'crit', st.keyValid ? T('check.key_ok', { libs: (st.libraries || []).length, users: st.users || 0 }) : T('check.key_bad')]);
      if (st.quickConnect != null) items.push([st.quickConnect ? 'good' : 'warn', st.quickConnect ? T('check.qc_on') : T('check.qc_off')]);
    }
    if (st.webdav != null) items.push([st.webdav === 'ok' ? 'good' : 'crit', T('check.webdav.' + st.webdav)]);
    items.push(['', T('check.at', { when: when(st.at) })]);
    return el('ul', { class: 'md-checks' }, items.map(function (x) { return el('li', null, [el('span', { class: 'md-dot', 'data-tone': x[0] || null }), el('span', { text: x[1] })]); }));
  }
  window.MD = { CTX: CTX, T: T, $: $, el: el, clear: clear, api: api, toast: toast, warn: warn, errText: errText, dialog: dialog, confirmDialog: confirmDialog,
    when: when, badge: badge, avatar: avatar, field: field, input: input, targetsLink: targetsLink, check: check, targetSelect: targetSelect, checks: checks };
})();
