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
        return el('button', { type: 'button', class: 'btn ' + (b.primary ? 'btn-primary' : '') + (b.danger ? 'btn-danger-fill' : ''), text: b.label, on: { click: function () { done(b.value); } } });
      }));
      ov = el('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true', on: { keydown: function (ev) { if (ev.key === 'Escape') { ev.stopPropagation(); done(false); } } } }, [el('div', { class: 'modal' }, [el('div', { class: 'modal-body' }, [content]), foot])]);
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

  // ─── 1.8: icons, tooltips, the menu ⋮, the sheet on phones, the large dialog, the tmux list (admin page and portal) ───
  var NS = 'http://www.w3.org/2000/svg';
  var ICONS = {
    connect: [['path', { d: 'M8 5v14l11-7z' }]],
    check: [['path', { d: 'M3 12h4l3-7 4 14 3-7h4' }]],
    edit: [['path', { d: 'M4 20h4L19 9l-4-4L4 16z' }], ['path', { d: 'm13.5 6.5 4 4' }]],
    power: [['path', { d: 'M12 3v8' }], ['path', { d: 'M6.3 7.3a8 8 0 1 0 11.4 0' }]],
    trash: [['path', { d: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3' }]],
    key: [['circle', { cx: 8, cy: 15, r: 4 }], ['path', { d: 'm11 12 9-9M17 6l3 3M15 8l2 2' }]],
    tmux: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'm7 9 3 3-3 3M12 15h5' }]],
    agent: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }], ['path', { d: 'M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4' }]],
    code: [['rect', { x: 3, y: 6, width: 18, height: 12, rx: 2 }], ['path', { d: 'M7 12h.01M11 12h.01M15 12h2' }]],
    renew: [['path', { d: 'M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4' }]],
    copy: [['rect', { x: 8, y: 8, width: 12, height: 12, rx: 2 }], ['path', { d: 'M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3' }]],
    wake: [['circle', { cx: 12, cy: 12, r: 4 }], ['path', { d: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' }]],
    lock: [['rect', { x: 5, y: 11, width: 14, height: 9, rx: 2 }], ['path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' }]],
    unlock: [['rect', { x: 5, y: 11, width: 14, height: 9, rx: 2 }], ['path', { d: 'M8 11V8a4 4 0 0 1 7.7-1.5' }]],
    more: [['circle', { cx: 12, cy: 5, r: 1.4 }], ['circle', { cx: 12, cy: 12, r: 1.4 }], ['circle', { cx: 12, cy: 19, r: 1.4 }]],
    cards: [['rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }]],
    table: [['path', { d: 'M3 5h18M3 12h18M3 19h18' }]],
    search: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'm20 20-3.5-3.5' }]],
    filter: [['path', { d: 'M3 5h18l-7 8v6l-4-2v-4z' }]],
    sort: [['path', { d: 'M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4' }]],
    home: [['path', { d: 'm3 11 9-7 9 7M5 10v10h14V10' }]],
    shield: [['path', { d: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z' }]],
    globe: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18' }]],
    server: [['rect', { x: 3, y: 4, width: 18, height: 7, rx: 2 }], ['rect', { x: 3, y: 13, width: 18, height: 7, rx: 2 }]],
    pc: [['rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }], ['path', { d: 'M8 20h8M12 16v4' }]],
    phone: [['rect', { x: 7, y: 2, width: 10, height: 20, rx: 2 }], ['path', { d: 'M11 18h2' }]],
    shell: [['path', { d: 'm5 8 4 4-4 4M12 16h7' }]],
    history: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7v5l3 2' }]],
    dup: [['rect', { x: 8, y: 8, width: 12, height: 12, rx: 2 }], ['path', { d: 'M4 16V5a1 1 0 0 1 1-1h11' }]],
    hostkey: [['path', { d: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z' }], ['path', { d: 'M9 12h6' }]],
    x: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
    ok: [['path', { d: 'm5 12 5 5 9-10' }]],
    err: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7v6M12 16.5v.5' }]],
    warn: [['path', { d: 'M12 3 2 20h20L12 3Z' }], ['path', { d: 'M12 10v4M12 17v.5' }]],
    info: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v6M12 7.5v.5' }]],
    chev: [['path', { d: 'm9 6 6 6-6 6' }]],
    down: [['path', { d: 'm6 9 6 6 6-6' }]],
    plus: [['path', { d: 'M12 5v14M5 12h14' }]],
    eye: [['path', { d: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
    switch: [['path', { d: 'M4 7h13l-3-3M20 17H7l3 3' }]],
  };
  function icon(name, size, width) {
    var sv = document.createElementNS(NS, 'svg');
    sv.setAttribute('width', String(size || 16));
    sv.setAttribute('height', String(size || 16));
    sv.setAttribute('viewBox', '0 0 24 24');
    sv.setAttribute('fill', 'none');
    sv.setAttribute('stroke', 'currentColor');
    sv.setAttribute('stroke-width', String(width || 2));
    sv.setAttribute('stroke-linecap', 'round');
    sv.setAttribute('stroke-linejoin', 'round');
    sv.setAttribute('aria-hidden', 'true');
    sv.setAttribute('focusable', 'false');
    (ICONS[name] || []).forEach(function (x) {
      var n = document.createElementNS(NS, x[0]);
      Object.keys(x[1]).forEach(function (k) { n.setAttribute(k, String(x[1][k])); });
      sv.appendChild(n);
    });
    return sv;
  }

  /** One tooltip for the page: on hover and on keyboard focus of an element with data-tip (not only title). */
  var tipEl = null;
  var tipFor = null;
  function hideTip() { if (tipEl) tipEl.hidden = true; tipFor = null; }
  function showTip(t) {
    var text = t.getAttribute('data-tip');
    if (!text) return;
    if (!tipEl) { tipEl = el('div', { class: 'rm-tip', role: 'tooltip', id: 'rm-tip', hidden: true }); document.body.appendChild(tipEl); }
    tipEl.textContent = text;
    tipEl.hidden = false;
    tipFor = t;
    var r = t.getBoundingClientRect();
    var w = tipEl.offsetWidth;
    var h = tipEl.offsetHeight;
    var left = Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2));
    var top = r.top - h - 8;
    tipEl.setAttribute('data-below', top < 4 ? '1' : '0');
    if (top < 4) top = r.bottom + 8;
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
  }
  function tipTarget(ev) { return ev.target && ev.target.closest ? ev.target.closest('[data-tip]') : null; }
  document.addEventListener('mouseover', function (ev) { var t = tipTarget(ev); if (t && t !== tipFor) showTip(t); else if (!t && tipFor) hideTip(); });
  document.addEventListener('focusin', function (ev) { var t = tipTarget(ev); if (t && t.matches(':focus-visible')) showTip(t); else hideTip(); });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('click', hideTip, true);
  document.addEventListener('scroll', hideTip, true);
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') hideTip(); });

  /** An icon button: aria-label (with the device's name) and a tooltip; o.tone: danger | key | prim | ok */
  function iconBtn(o) {
    var b = el('button', { type: 'button', class: 'rm-ib' + (o.tone ? ' ' + o.tone : '') + (o.cls ? ' ' + o.cls : ''), 'aria-label': o.label, 'data-tip': o.tip || o.label,
      'data-act': o.act || null, on: o.onClick ? { click: o.onClick } : null }, [icon(o.icon, o.size || 16)]);
    if (o.pressed != null) b.setAttribute('aria-pressed', o.pressed ? 'true' : 'false');
    return b;
  }

  /** The menu ⋮ under its button: items [{ icon, label, run, danger, sep }] — keyboard: arrows, Escape. */
  var openMenu = null;
  function closeMenu() { if (openMenu) { var m = openMenu; openMenu = null; m.box.remove(); document.removeEventListener('mousedown', m.outside, true); if (m.anchor && m.anchor.isConnected) { m.anchor.setAttribute('aria-expanded', 'false'); if (m.refocus) m.anchor.focus(); } } }
  function menu(anchor, items) {
    var again = openMenu && openMenu.anchor === anchor;
    closeMenu();
    if (again) return;
    var list = items.filter(function (x) { return x && !x.hidden; });
    var box = el('div', { class: 'rm-menu', role: 'menu' });
    list.forEach(function (x) {
      if (x.sep) { box.appendChild(el('hr', { role: 'separator' })); return; }
      box.appendChild(el('button', { type: 'button', role: 'menuitem', class: x.danger ? 'red' : null, on: { click: function () { closeMenu(); x.run(); } } }, [icon(x.icon || 'chev'), el('span', { text: x.label }), x.small ? el('small', { text: x.small }) : null]));
    });
    document.body.appendChild(box);
    var r = anchor.getBoundingClientRect();
    var w = box.offsetWidth;
    var h = box.offsetHeight;
    box.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, r.right - w)) + 'px';
    box.style.top = (r.bottom + 6 + h > window.innerHeight && r.top - 6 - h > 0 ? r.top - 6 - h : r.bottom + 6) + 'px';
    var outside = function (ev) { if (!box.contains(ev.target) && ev.target !== anchor && !anchor.contains(ev.target)) closeMenu(); };
    document.addEventListener('mousedown', outside, true);
    openMenu = { box: box, anchor: anchor, outside: outside, refocus: true };
    anchor.setAttribute('aria-expanded', 'true');
    var btns = Array.prototype.slice.call(box.querySelectorAll('button'));
    box.addEventListener('keydown', function (ev) {
      var i = btns.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); btns[(i + 1) % btns.length].focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); closeMenu(); }
      else if (ev.key === 'Tab') { openMenu.refocus = false; closeMenu(); }
    });
    if (btns[0]) btns[0].focus();
  }
  window.addEventListener('resize', closeMenu);

  /** The sheet from below (phones: no tooltips — icon and text, large targets, the dangerous ones last in red). */
  function sheet(title, sub, items) {
    var ov;
    var close = function () { ov.remove(); };
    var list = items.filter(function (x) { return x && !x.hidden; });
    var box = el('div', { class: 'rm-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [el('span', { class: 'grab', 'aria-hidden': 'true' }),
      el('div', { class: 'shd' }, [el('div', null, [el('b', { text: title }), sub ? el('small', { text: sub }) : null]),
        el('button', { type: 'button', class: 'rm-ib flat', 'aria-label': T('common.close'), on: { click: close } }, [icon('x')])])]);
    list.forEach(function (x) {
      box.appendChild(el('button', { type: 'button', class: 'it' + (x.danger ? ' red' : '') + (x.primary ? ' pri' : ''), on: { click: function () { close(); x.run(); } } }, [icon(x.icon || 'chev', 18), el('span', { text: x.label })]));
    });
    ov = el('div', { class: 'rm-sheet-ov', on: { click: function (ev) { if (ev.target === ov) close(); }, keydown: function (ev) { if (ev.key === 'Escape') close(); } } }, [box]);
    document.body.appendChild(ov);
    var f = box.querySelector('.it');
    if (f) f.focus();
  }

  /**
   * The large dialog (1.8: „Gerät hinzufügen“, „Bearbeiten“, the key set-up): min(1100px, 100% − 32px), as high as the frame
   * allows without the page scrolling (--gc-viewport-height); head and foot stay, the columns scroll each on their own.
   * o: { title, sub, label, size: 'xl' | 'md' | 'sm', onClose } → { ov, modal, head, steps, body, foot, close, setTitle }
   */
  function bigDialog(o) {
    var ov;
    var closed = false;
    var titleB = el('b', { text: o.title || '' });
    var subS = el('small', { text: o.sub || '' });
    var tools = el('span', { class: 'rm-dlg-tools' });
    var x = el('button', { type: 'button', class: 'rm-ib flat lg', 'aria-label': T('common.close'), 'data-tip': T('common.close') }, [icon('x', 18)]);
    var head = el('div', { class: 'rm-dlg-head' }, [el('div', { class: 'rm-dlg-title' }, [titleB, subS]), tools, x]);
    var steps = el('div', { class: 'rm-dlg-steps', hidden: true });
    var body = el('div', { class: 'rm-dlg-body' });
    var foot = el('div', { class: 'rm-dlg-foot' });
    var modal = el('div', { class: 'modal rm-dlg ' + (o.size || 'xl') }, [head, steps, body, foot]);
    ov = el('div', { class: 'modal-overlay rm-dlg-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.label || o.title || '' }, [modal]);
    var api2 = {
      ov: ov, modal: modal, head: head, tools: tools, steps: steps, body: body, foot: foot,
      close: function (v) { if (closed) return; closed = true; hideTip(); closeMenu(); ov.remove(); document.removeEventListener('keydown', onKey); if (o.onClose) o.onClose(v); },
      setTitle: function (t, sub2) { titleB.textContent = t || ''; subS.textContent = sub2 || ''; subS.hidden = !sub2; },
      isOpen: function () { return !closed; },
    };
    function onKey(ev) {
      var all = document.querySelectorAll('.modal-overlay');
      if (ev.key === 'Escape' && !openMenu && !document.querySelector('.rm-sheet-ov') && all[all.length - 1] === ov) api2.close(null);
    }
    subS.hidden = !o.sub;
    x.addEventListener('click', function () { api2.close(null); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
    return api2;
  }

  /** Copy a text (the frame may not have the clipboard: then select it for the person). */
  function copy(text, btn) {
    var ok = function () {
      toast(T('common.copied'));
      if (btn) { btn.setAttribute('data-done', '1'); setTimeout(function () { btn.removeAttribute('data-done'); }, 1600); }
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(ok, function () { toast(T('common.copy_failed'), 'error'); });
    } catch (e) { /* no clipboard */ }
    toast(T('common.copy_failed'), 'error');
    return Promise.resolve();
  }

  /** A confirmation with its own content (T2–T4 of the tmux design). */
  function ask(title, nodes, okLabel, danger) {
    return dialog(el('div', { class: 'rm-ask' }, [el('h3', { class: 'rm-card-title', text: title })].concat(nodes)),
      [{ label: T('common.cancel'), value: false }, { label: okLabel, value: true, primary: !danger, danger: !!danger }]);
  }

  /**
   * 1.8: before connecting a terminal with tmux — the sessions on the device with their windows; resume, start a new one,
   * end a session, close a window, end every detached one (T1–T4). o: { device: { id, name, tmux, recording }, base:
   * 'devices/<id>' | 'admin/devices/<id>', sub, connect(body) → Promise<boolean> (true: opened, the dialog closes) }
   */
  function tmuxDialog(o) {
    var d = o.device;
    var dlg = bigDialog({ title: T('portal.connect_to', { name: d.name }), sub: o.sub || null, size: 'md' });
    var status = el('p', { class: 'rm-hint', role: 'status', 'aria-live': 'polite' });
    var host = el('div', { class: 'rm-actions' });
    var list = el('div', { class: 'rm-tx-list' });
    var killAll = el('div');
    var rec = null;
    var open = {};
    var data = null;
    var name = el('input', { class: 'form-input', type: 'text', id: 'rm-tmux-new', maxlength: '32', autocomplete: 'off', spellcheck: 'false', value: d.tmux || '' });
    function busyAll(on) { Array.prototype.forEach.call(dlg.modal.querySelectorAll('button'), function (b) { if (!b.classList.contains('lg')) b.disabled = on; }); }
    function go(tmux) {
      var body = {};
      if (tmux) body.tmux = tmux;
      if (rec) body.record = rec.checked;
      busyAll(true);
      status.textContent = '';
      return Promise.resolve(o.connect(body, host)).then(function (ok) { if (ok) dlg.close(true); }).catch(function (e) { status.textContent = errText(e); })
        .then(function () { if (dlg.isOpen()) busyAll(false); });
    }
    function when2(v) {
      if (v == null) return null;
      var n = typeof v === 'number' ? v * (v < 1e12 ? 1000 : 1) : Date.parse(v);
      return isFinite(n) ? ago(new Date(n).toISOString()) : null;
    }
    function detached() { return ((data && data.sessions) || []).filter(function (s) { return !s.attached; }); }
    function ref(s) { return { id: s.id, name: s.name, created: s.created }; }
    function quiet(e) {
      var c = e && e.data && e.data.code;
      if (c === 'tmux_gone' || c === 'tmux_changed') { toast(T('tmux.' + c)); load(); return; }
      warn(e);
    }
    function endSession(s) {
      var nodes = [el('p', { text: T('tmux.end_text') })];
      if (s.attached) nodes.push(el('div', { class: 'rmx-note err' }, [icon('warn', 18), el('div', null, [el('b', { text: T('tmux.attached_head') }), el('span', { class: 'rmx-small', text: T('tmux.attached_text', { n: s.attached }) })])]));
      var w = (s.windowList || []).map(function (x) { return x.index + ' · ' + (x.command || x.name || ''); }).join(', ');
      nodes.push(el('div', { class: 'rmx-kv' }, [el('span', { text: T('tmux.windows') }), el('b', { text: w || String(s.windows || 1) }),
        el('span', { text: T('tmux.created') }), el('b', { text: when2(s.created) || '–' }), el('span', { text: T('tmux.activity') }), el('b', { text: when2(s.activity) || '–' })]));
      return ask(T('tmux.end_q', { name: s.name }), nodes, s.attached ? T('tmux.end_anyway') : T('tmux.end'), true).then(function (yes) {
        if (!yes) return null;
        return api('POST', o.base + '/tmux/kill', { session: ref(s) }).then(function (r) { toast(T('tmux.ended', { name: s.name })); draw(r); });
      }).catch(quiet);
    }
    function closeWindow(s, w) {
      var last = (s.windowList || []).length <= 1;
      var nodes = [el('p', { text: T('tmux.win_text', { cmd: w.command || w.name || '', n: Math.max(0, (s.windowList || []).length - 1) }) })];
      if (last) nodes.push(el('p', { class: 'rm-note', text: T('tmux.win_last') }));
      return ask(T('tmux.win_q', { name: w.name || String(w.index) }), nodes, T('tmux.win_close'), true).then(function (yes) {
        if (!yes) return null;
        return api('POST', o.base + '/tmux/kill', { session: ref(s), window: { id: w.id, index: w.index } }).then(function (r) { toast(T('tmux.win_closed')); draw(r); });
      }).catch(quiet);
    }
    function endDetached() {
      var cands = detached();
      var boxes = cands.map(function (s) { return el('input', { type: 'checkbox', checked: true, 'data-id': s.id }); });
      var rows = cands.map(function (s, i) {
        var cmds = (s.windowList || []).map(function (w) { return w.command || w.name; }).filter(Boolean).join(', ');
        return el('label', { class: 'rm-tx-pick' }, [boxes[i], el('span', null, [el('b', { text: s.name }), el('small', { text: T('portal.tmux_windows', { n: s.windows || 1 }) + (cmds ? ' · ' + cmds : '') + (when2(s.activity) ? ' · ' + when2(s.activity) : '') })])]);
      });
      var att = ((data && data.sessions) || []).filter(function (s) { return s.attached; }).map(function (s) { return '„' + s.name + '“'; });
      var nodes = [el('p', { text: T('tmux.end_text') + (att.length ? ' ' + T('tmux.stays', { list: att.join(', ') }) : '') })].concat(rows);
      return ask(T('tmux.all_q', { n: cands.length }), nodes, T('tmux.all_go', { n: cands.length }), true).then(function (yes) {
        if (!yes) return null;
        var pick = cands.filter(function (s, i) { return boxes[i].checked; });
        if (!pick.length) return null;
        return api('POST', o.base + '/tmux/kill-detached', { sessions: pick.map(ref) }).then(function (r) { toast(T('tmux.all_done', { n: (r.killed || []).length })); draw(r); });
      }).catch(quiet);
    }
    function row(s) {
      var sub = [T('portal.tmux_windows', { n: s.windows || 1 })];
      if (s.attached) sub.push(T('portal.tmux_attached'));
      else if (when2(s.activity)) sub.push(T('tmux.last_active', { ago: when2(s.activity) }));
      if (!s.attachable) sub.push(T('tmux.not_resumable'));
      var hasWin = !!(s.windowList && s.windowList.length);
      var exp = hasWin ? el('button', { type: 'button', class: 'rm-ib flat', 'aria-expanded': open[s.id] ? 'true' : 'false', 'aria-label': T(open[s.id] ? 'tmux.hide_windows' : 'tmux.show_windows', { name: s.name }),
        'data-tip': T(open[s.id] ? 'tmux.hide_windows' : 'tmux.show_windows', { name: s.name }), on: { click: function () { open[s.id] = !open[s.id]; draw(data); } } }, [icon(open[s.id] ? 'down' : 'chev')]) : el('span', { class: 'rm-tx-sp' });
      var acts = el('div', { class: 'rm-tx-acts' });
      if (s.attachable) acts.appendChild(el('button', { type: 'button', class: 'btn btn-sm' + (s.name === d.tmux ? ' btn-primary' : ''), text: T('tmux.resume'), 'aria-label': T('portal.tmux_resume', { name: s.name }), on: { click: function () { go({ attach: s.name }); } } }));
      if (data.kill && s.id) acts.appendChild(el('button', { type: 'button', class: 'btn btn-sm rm-danger-soft', text: T('tmux.end'), 'aria-label': T('tmux.end_q', { name: s.name }), on: { click: function () { endSession(s); } } }));
      var wrap = el('div', { class: 'rm-tx' + (s.attached ? ' att' : '') }, [el('div', { class: 'rm-tx-row' }, [exp, el('div', { class: 'rm-tx-main' }, [el('b', { text: s.name }), el('small', { text: sub.join(' · ') })]), acts])]);
      if (hasWin && open[s.id]) {
        var wl = el('div', { class: 'rm-tx-wins' });
        s.windowList.forEach(function (w) {
          wl.appendChild(el('div', { class: 'rm-tx-win' }, [el('span', { class: 'idx', text: String(w.index) }), el('span', { class: 'nm', text: w.name || '' }), el('span', { class: 'cmd', text: w.command || '' }),
            w.active ? el('span', { class: 'rmx-tag ok', text: T('tmux.active') }) : null,
            data.kill ? el('button', { type: 'button', class: 'btn btn-sm rmx-ghost', text: T('tmux.win_close_short'), 'aria-label': T('tmux.win_q', { name: w.name || String(w.index) }), on: { click: function () { closeWindow(s, w); } } }) : null]));
        });
        wrap.appendChild(wl);
      }
      return wrap;
    }
    function draw(r) {
      data = r;
      clear(list);
      clear(killAll);
      var ss = r.sessions || [];
      if (r.hostKey === 'unpinned') list.appendChild(el('p', { class: 'rm-hint', text: T('portal.tmux_first') }));
      else if (!ss.length) list.appendChild(el('p', { class: 'rm-hint', text: T('portal.tmux_none') }));
      ss.forEach(function (s) { list.appendChild(row(s)); });
      var det = detached();
      if (r.kill && det.length >= 2) killAll.appendChild(el('button', { type: 'button', class: 'btn btn-sm rm-danger-soft', text: T('tmux.all', { n: det.length }), on: { click: endDetached } }));
      if (ss.some(function (s) { return s.name === name.value.trim(); })) {
        var n = 2;
        var base = (d.tmux || 'gc').slice(0, 29);
        while (ss.some(function (s) { return s.name === base + '-' + n; })) n++;
        name.value = (base + '-' + n).slice(0, 32);
      }
      var own = ss.filter(function (s) { return s.name === d.tmux && s.attachable; })[0];
      resume.hidden = !own;
      if (own) resume.textContent = T('portal.tmux_resume', { name: own.name });
    }
    function load() {
      clear(list).appendChild(el('p', { class: 'rm-hint' }, [el('span', { class: 'rm-spin' }), ' ', T('common.loading')]));
      return api('GET', o.base + '/tmux?windows=1').then(draw).catch(function (e) { clear(list).appendChild(el('p', { class: 'rm-hint', text: errText(e) })); });
    }
    var parts = [el('p', { class: 'rm-hint', text: T('portal.tmux_hint') }), list, killAll,
      el('label', { class: 'form-label', for: 'rm-tmux-new', text: T('portal.tmux_new_name') }), name];
    if (d.recording === 'optional') {
      rec = el('input', { type: 'checkbox', id: 'rm-rec-opt' });
      parts.push(el('label', { class: 'check' }, [rec, el('span', { text: T('portal.rec_optional') })]));
    } else if (d.recording === 'always') parts.push(el('p', { class: 'rm-note' }, [el('span', { class: 'rm-rec-dot', 'aria-hidden': 'true' }), T('portal.rec_always')]));
    parts.push(status, host);
    parts.forEach(function (n) { dlg.body.appendChild(n); });
    var resume = el('button', { type: 'button', class: 'btn btn-primary', hidden: true, on: { click: function () { go({ attach: d.tmux }); } } });
    dlg.foot.appendChild(el('button', { type: 'button', class: 'btn rmx-ghost', text: T('common.cancel'), on: { click: function () { dlg.close(null); } } }));
    dlg.foot.appendChild(el('span', { class: 'rmx-sp' }));
    dlg.foot.appendChild(el('button', { type: 'button', class: 'btn', text: T('portal.tmux_new'), on: { click: function () {
      var v = name.value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(v)) { status.textContent = T('portal.tmux_bad_name'); name.focus(); return; }
      go({ create: v });
    } } }));
    dlg.foot.appendChild(resume);
    load();
    return dlg;
  }

  window.RM = { CTX: CTX, T: T, $: $, el: el, clear: clear, api: api, toast: toast, warn: warn, errText: errText, dialog: dialog, confirmDialog: confirmDialog, when: when, ago: ago, duration: duration, stateBadge: stateBadge, protoBadge: protoBadge, openSession: openSession,
    icon: icon, iconBtn: iconBtn, menu: menu, closeMenu: closeMenu, sheet: sheet, bigDialog: bigDialog, copy: copy, ask: ask, tmuxDialog: tmuxDialog, hideTip: hideTip };
})();
