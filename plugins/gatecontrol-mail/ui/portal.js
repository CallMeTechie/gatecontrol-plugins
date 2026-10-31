/* Mail (gatecontrol-mail) — the portal tab (mockups Main, Menue, MenueNeu, Lesen, Schreiben, Ablegen, Konto, Einladung):
 *
 *   menu     Alle Posteingänge, Zum Ablegen, Ausgang, the accounts with their folders; at its foot (since 1.3.0) the
 *            settings on the left, Kontakte and Kalender on the right (an account is added in the settings)
 *   list     Relevant / Sonstige in posteingänge, search, more on scrolling; live reload on the event 'mail' (and of the open
 *            mail whose body was still loading: the event names its messageId)
 *   mail     AI bar (Kurz gesagt, Zu tun — into the family calendar —, reply suggestions), attachments (download, "In Drive
 *            speichern" with Drive's suggestion, another folder, "Immer für diesen Absender"), pictures only on request,
 *            the conversation, answer / forward / archive / delete / move to Sonstige
 *   write    from which account, recipients with suggestions, attachments from the device (GC.upload) or from Drive (a copy
 *            or a link), warnings, send with 10 s to undo, send later
 *   accounts add one (password, app password, IMAP, Microsoft by device code), change it, sign in again, remove it;
 *            calendar and contacts of an account on or off; Microsoft without the calendar / contact rights: „Neu anmelden“
 *   areas    since 1.3.0 also Kalender (ui/calendar.js) and Kontakte (ui/contacts.js) — the same menu, its content per
 *            area; the invitation card of a mail comes from ui/calendar.js. Both get this file's helpers (attach(ui)).
 *
 * The plugin API through GC.call (answers JSON, errors { error: { code } }). The mail's HTML (sanitized by GateControl)
 * is shown in a shadow root; its pictures load only when allowed (as data: URLs — the frame has no network of its own).
 * Text only through textContent / attributes, never innerHTML — except the sanitized mail and the editor's own text.
 */
(function () {
  'use strict';

  var CTX = window.MP_CTX || { texts: {}, lang: 'de' };
  var LOCALE = CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  var NS = 'http://www.w3.org/2000/svg';
  var $ = function (id) { return document.getElementById(id); };

  function T(k, p) {
    var s = CTX.texts && CTX.texts[k] != null ? String(CTX.texts[k]) : k;
    if (p) Object.keys(p).forEach(function (x) { s = s.split('{{' + x + '}}').join(String(p[x])); });
    return s;
  }

  var ICONS = {
    inbox: 'M3 13h5l2 3h4l2-3h5|M5 5h14l2 8v6H3v-6z',
    mail: 'M4 6h16v12H4z|M4 7l8 6 8-6',
    pen: 'M4 20h4L19 9l-4-4L4 16z',
    search: 'M11 18a7 7 0 1 0 0-14a7 7 0 1 0 0 14|M21 21l-5-5',
    plus: 'M12 5v14M5 12h14',
    close: 'M6 6l12 12M18 6L6 18',
    back: 'M15 6l-6 6 6 6',
    menu: 'M4 7h16M4 12h16M4 17h16',
    reply: 'M10 9V5l-7 7 7 7v-4c5 0 8 1 11 5-1-6-4-10-11-11',
    replyAll: 'M7 9V5L0 12l7 7v-4|M13 9V5l-7 7 7 7v-4c5 0 8 1 11 5-1-6-4-10-11-11',
    forward: 'M14 9V5l7 7-7 7v-4c-5 0-8 1-11 5 1-6 4-10 11-11',
    archive: 'M3 5h18v4H3z|M5 9v10h14V9|M10 13h4',
    trash: 'M4 7h16|M10 11v6M14 11v6|M6 7l1 13h10l1-13|M9 7V4h6v3',
    flag: 'M5 21V4h11l-2 4 2 4H5',
    unread: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8',
    clip: 'M21 12l-8.5 8.5a5 5 0 0 1-7-7L14 5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 8',
    spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
    drive: 'M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z',
    folder: 'M3 6h6l2 2h10v11H3z',
    file: 'M6 3h9l4 4v14H6z|M14 3v5h5',
    image: 'M4 5h16v14H4z|M4 16l5-5 4 4 3-3 4 4',
    cal: 'M4 6h16v14H4z|M4 10h16|M8 3v4M16 3v4',
    other: 'M4 6h16|M4 12h10|M4 18h6',
    gear: 'M12 15a3 3 0 1 0 0-6a3 3 0 1 0 0 6|M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2',
    send: 'M3 11l18-8-8 18-2-8z',
    clock: 'M12 21a9 9 0 1 0 0-18a9 9 0 1 0 0 18|M12 7v5l3 3',
    link: 'M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1|M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
    warn: 'M12 3l10 18H2z|M12 10v4M12 17h.01',
    person: 'M12 12a4 4 0 1 0 0-8a4 4 0 1 0 0 8|M4 21c0-4 4-6 8-6s8 2 8 6',
    people: 'M9 11a3.5 3.5 0 1 0 0-7a3.5 3.5 0 1 0 0 7|M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5|M16 4.5a3.5 3.5 0 0 1 0 6.5|M18 14.5c2.4.6 4 2.4 4 5.5',
    phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
    edit: 'M4 20h4L19 9l-4-4L4 16z|M13 7l4 4',
    pin: 'M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z|M12 11a2 2 0 1 0 0-4a2 2 0 1 0 0 4',
    video: 'M3 7h12v10H3z|M15 10l6-3v10l-6-3',
    bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4z|M10 21h4',
    check: 'M5 12l5 5 9-10',
    left: 'M15 6l-6 6 6 6',
    right: 'M9 6l6 6-6 6',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    upload: 'M12 16V4|M7 9l5-5 5 5|M4 20h16',
    download: 'M12 4v12|M7 11l5 5 5-5|M4 20h16',
    merge: 'M6 4v5a6 6 0 0 0 6 6h0a6 6 0 0 1 6 6|M18 4v5a6 6 0 0 1-6 6',
    repeat: 'M17 2l3 3-3 3|M4 11V9a4 4 0 0 1 4-4h12|M7 22l-3-3 3-3|M20 13v2a4 4 0 0 1-4 4H4',
  };
  function icon(name, size) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', String(size || 16));
    s.setAttribute('height', String(size || 16));
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.9');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    (ICONS[name] || '').split('|').forEach(function (d) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); });
    return s;
  }
  function h(tag, o, kids) {
    var n = document.createElement(tag);
    var opts = o || {};
    Object.keys(opts).forEach(function (k) {
      var v = opts[k];
      if (v === undefined || v === null) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = String(v);
      else if (k === 'attrs') Object.keys(v).forEach(function (a) { if (v[a] !== undefined && v[a] !== null && v[a] !== false) n.setAttribute(a, v[a] === true ? '' : String(v[a])); });
      else if (k === 'on') Object.keys(v).forEach(function (e) { n.addEventListener(e, v[e]); });
      else if (k === 'style') n.setAttribute('style', v);
      else if (k === 'hidden' || k === 'disabled' || k === 'checked' || k === 'selected') n[k] = !!v;
      else if (k === 'value' || k === 'type' || k === 'placeholder' || k === 'id' || k === 'title') n[k] = v;
      else n.setAttribute(k, String(v));
    });
    add(n, kids);
    return n;
  }
  function add(n, kids) {
    (Array.isArray(kids) ? kids : kids == null ? [] : [kids]).forEach(function (c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) add(n, c);
      else n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function btn(label, onClick, o) {
    var x = o || {};
    return h('button', { type: 'button', class: 'dp-btn' + (x.primary ? ' dp-btn-primary' : '') + (x.danger ? ' dp-btn-danger' : '') + (x.small ? ' dp-btn-sm' : '') + (x.cls ? ' ' + x.cls : ''), disabled: x.disabled, on: { click: onClick } },
      [x.icon ? icon(x.icon) : null, label ? h('span', { text: label }) : null]);
  }
  function ibtn(name, label, onClick, cls) {
    return h('button', { type: 'button', class: 'dp-ib' + (cls ? ' ' + cls : ''), attrs: { 'aria-label': label, title: label }, on: { click: onClick } }, icon(name));
  }
  var toastTimer = null;
  function toast(text, kind) {
    var t = $('mp-toast');
    t.textContent = text;
    t.className = 'dp-toast' + (kind === 'error' ? ' is-error' : '');
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, kind === 'error' ? 6000 : 3000);
  }
  var snackTimer = null;
  function snack(text, undoLabel, onUndo, ms) {
    var s = $('mp-snack');
    clear(s);
    add(s, [h('span', { text: text }), undoLabel ? h('button', { type: 'button', class: 'dp-snack-undo', text: undoLabel, on: { click: function () { s.hidden = true; onUndo(); } } }) : null]);
    s.hidden = false;
    if (snackTimer) clearTimeout(snackTimer);
    snackTimer = setTimeout(function () { s.hidden = true; }, ms || 4000);
  }
  function copyText(text) {
    var value = String(text == null ? '' : text);
    var ok = false;
    var ta = h('textarea', { attrs: { readonly: true, 'aria-hidden': 'true', tabindex: '-1', style: 'position:fixed;left:-9999px' } });
    ta.value = value;
    document.body.appendChild(ta);
    try { ta.select(); ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (ok) { toast(T('p.copied')); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(function () { toast(T('p.copied')); }, function () { toast(T('p.copy_failed'), 'error'); });
    else toast(T('p.copy_failed'), 'error');
  }

  // ── formats ──────────────────────────────────────────────

  function fmtSize(n) {
    var b = Number(n) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1048576) return Math.round(b / 1024) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(b < 10485760 ? 1 : 0).replace('.', CTX.lang === 'en' ? '.' : ',') + ' MB';
    return (b / 1073741824).toFixed(1).replace('.', CTX.lang === 'en' ? '.' : ',') + ' GB';
  }
  function fmtTime(ms) {
    var d = new Date(ms);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
    var y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return T('p.yesterday');
    if (now - d < 6 * 86400000) return d.toLocaleDateString(LOCALE, { weekday: 'short' });
    return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: d.getFullYear() === now.getFullYear() ? undefined : '2-digit' });
  }
  function fmtFull(ms) { return new Date(ms).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }); }
  function initials(s) {
    var w = String(s || '').replace(/[<>"@].*$/, '').trim().split(/\s+/).filter(Boolean);
    return ((w[0] || '?').charAt(0) + (w.length > 1 ? w[w.length - 1].charAt(0) : '')).toUpperCase();
  }
  function extOf(name) { var i = String(name || '').lastIndexOf('.'); return i > 0 ? String(name).slice(i + 1, i + 5).toUpperCase() : 'FILE'; }

  // ── the API ──────────────────────────────────────────────

  function qs(q) {
    var parts = [];
    Object.keys(q || {}).forEach(function (k) { if (q[k] !== undefined && q[k] !== null && q[k] !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(q[k])); });
    return parts.length ? '?' + parts.join('&') : '';
  }
  function codeErr(code, extra) { var e = new Error(code); e.code = code; e.extra = extra || null; return e; }
  function api(method, path, body, query) {
    return window.GC.call(method, path + qs(query), body).then(function (r) { return r; }, function (e) {
      var d = e && e.data;
      var er = d && d.error && typeof d.error === 'object' ? d.error : null;
      throw codeErr((er && er.code) || (e && e.status === 0 ? 'network' : 'failed'), er);
    });
  }
  function errText(e) {
    var code = (e && e.code) || 'failed';
    var k = 'err.' + code;
    var base = CTX.texts && CTX.texts[k] ? T(k) : T('p.err_generic', { code: code });
    return e && e.extra && e.extra.hint ? base + ' ' + e.extra.hint : base;
  }
  function fail(e) { toast(errText(e), 'error'); }
  function has(f) { return S.features.indexOf(f) >= 0; }

  // ── state ────────────────────────────────────────────────

  var S = {
    me: null, features: [], accounts: [], folders: {}, unread: { all: 0, byAccount: {} }, settings: {},
    view: 'box', box: 'all', folderId: null, tab: 'relevant', q: '', items: [], next: null, counts: {}, loading: false,
    openId: null, open: null, filing: [], outbox: [], expanded: {}, avatars: {},
    area: 'mail', // since 1.3.0: 'mail' | 'calendar' | 'contacts'
  };
  var CAL = null; // ui/calendar.js (attach below)
  var CON = null; // ui/contacts.js
  var lastFocus = null;

  function message(title, text) {
    $('mp-app').hidden = true;
    var m = $('mp-msg');
    clear(m);
    add(m, [h('b', { text: title }), text ? h('span', { class: 'dp-muted', text: text }) : null]);
    m.hidden = false;
  }

  function boot() {
    if (!CTX.loggedIn) { message(T('p.login_title'), T('p.login_text')); return; }
    if (!CTX.allowed) { message(T('p.not_allowed_title'), T('p.not_allowed_text')); return; }
    message(T('p.loading'), '');
    loadMe().then(function () {
      // the licence's people (since 1.1.0, like Drive): without a licence or a place only the note
      var lic = S.me.licence;
      if (lic && lic.valid === false) { message(T('p.unlicensed_title'), T('p.unlicensed_text')); return; }
      if (lic && !S.me.seat) { message(T('p.no_seat_title'), T('p.no_seat_text')); return; }
      $('mp-msg').hidden = true;
      $('mp-app').hidden = false;
      live();
      if (!S.accounts.length) { renderNav(); renderEmpty(); return; }
      reloadAll();
    }, function (e) { message(T('p.failed_title'), errText(e)); });
  }

  function loadMe() {
    return api('GET', 'me').then(function (r) {
      S.me = r;
      S.features = r.features || [];
      S.accounts = r.accounts || [];
      S.unread = r.unread || { all: 0, byAccount: {} };
      S.settings = r.settings || {};
      S.limits = r.limits || {};
      loadAvatars();
    });
  }

  // the pictures of the accounts (signed urls of the plugin's media, kept while the picture stays the same)
  function loadAvatars() {
    S.accounts.forEach(function (a) {
      if (!a.avatar) return;
      var have = S.avatars[a.id];
      if (have && have.mediaId === a.avatar.mediaId) return;
      S.avatars[a.id] = { mediaId: a.avatar.mediaId, url: null };
      api('GET', 'accounts/' + a.id + '/avatar').then(function (r) {
        S.avatars[a.id] = { mediaId: a.avatar.mediaId, url: r.url || null };
        if (r.url) renderNav();
      }, function () {});
    });
  }

  function reloadAll() {
    var jobs = [api('GET', 'folders').then(function (r) { S.folders = {}; (r.accounts || []).forEach(function (a) { S.folders[a.accountId] = a.folders || []; }); }, function () {})];
    if (has('drive')) jobs.push(api('GET', 'filing').then(function (r) { S.filing = r.items || []; }, function () { S.filing = []; }));
    jobs.push(api('GET', 'outbox').then(function (r) { S.outbox = r.items || []; }, function () { S.outbox = []; }));
    return Promise.all(jobs).then(function () { renderNav(); return loadList(); });
  }

  var liveTimer = null;
  function live() {
    if (!window.GC || typeof window.GC.on !== 'function') return;
    window.GC.on('event', function (ev) {
      if (!ev) return;
      // since 1.3.0: calendars and contacts (their own areas reload what they show)
      if (ev.type === 'calendar') { if (CAL) CAL.onEvent(ev.data || {}); return; }
      if (ev.type === 'contacts') { if (CON) CON.onEvent(ev.data || {}); return; }
      if (ev.type !== 'mail') return;
      var d = ev.data || {};
      // the body of the open mail came after the answer: show it now
      if (S.open && S.open.bodyMissing && d.messageId === S.open.id) reloadOpen();
      if (liveTimer) clearTimeout(liveTimer);
      liveTimer = setTimeout(function () {
        loadMe().then(function () { renderNav(); if (S.area === 'mail' && S.view === 'box') loadList(true); }, function () {});
      }, 600);
    });
  }

  function accountOf(id) { for (var i = 0; i < S.accounts.length; i++) if (S.accounts[i].id === id) return S.accounts[i]; return null; }
  function accountLabel(a) { return a ? (a.name ? a.name + ' · ' + a.email : a.email) : ''; }

  // an account as a small circle: its picture at the provider, else the provider's mark (like the Outlook app); the dot: its colour
  var MARKS = {
    outlook: ['O', '#0F6CBD'], m365: ['M', '#0F6CBD'], gmail: ['G', '#EA4335'], gmx: ['GMX', '#1C449B'], webde: ['W', '#F4C400', '#1D1D1F'], tonline: ['T', '#E20074'],
  };
  function accAvatar(a, big) {
    var pic = a.avatar && S.avatars[a.id] && S.avatars[a.id].mediaId === a.avatar.mediaId ? S.avatars[a.id].url : null;
    var mark = MARKS[a.provider] || ['@', a.color];
    var box = h('span', { class: 'mp-acc' + (big ? ' is-big' : '') + (mark[0].length > 2 ? ' is-long' : ''), style: pic ? null : 'background:' + mark[1] + ';color:' + (mark[2] || '#fff') });
    if (pic) box.appendChild(h('img', { attrs: { src: pic, alt: '' } }));
    else box.appendChild(h('span', { text: mark[0], attrs: { 'aria-hidden': 'true' } }));
    box.appendChild(h('span', { class: 'mp-dot', attrs: { style: 'background:' + a.color } }));
    return box;
  }
  // name and address in two lines (the address alone when there is no name)
  function accText(a) {
    return h('span', { class: 'mp-tx mp-two' }, [h('span', { text: a.name || a.email }), a.name ? h('span', { class: 'mp-sub', text: a.email }) : null]);
  }
  function folderOf(id) { var out = null; Object.keys(S.folders).forEach(function (k) { S.folders[k].forEach(function (f) { if (f.id === id) out = f; }); }); return out; }
  function roleName(f) { return f.role ? T('p.role_' + f.role) : f.name; }

  // ── the menu ─────────────────────────────────────────────

  function navRow(ic, label, current, onClick, count, extra) {
    return h('button', { type: 'button', class: 'mp-row' + (extra && extra.sub ? ' is-sub' : '') + (extra && extra.account ? ' is-acc' : ''), attrs: { 'aria-current': current ? 'page' : null }, on: { click: function () { showPane('list'); onClick(); } } },
      [ic, extra && extra.account ? accText(extra.account) : h('span', { class: 'mp-tx', text: label }), extra && extra.warn ? h('span', { class: 'mp-warn', text: '!' , attrs: { title: extra.warn } }) : null,
        count ? h('span', { class: 'mp-count', text: String(count) }) : null]);
  }

  function renderNav() {
    var nav = $('mp-nav');
    clear(nav);
    nav.appendChild(h('div', { class: 'mp-nav-title' }, h('span', { text: S.area === 'calendar' ? T('p.c.title') : S.area === 'contacts' ? T('p.k.title') : T('p.title') })));
    var body = h('div', { class: 'mp-nav-body' });
    nav.appendChild(body);
    if (S.area === 'calendar' && CAL) CAL.nav(body);
    else if (S.area === 'contacts' && CON) CON.nav(body);
    else mailNav(body);
    nav.appendChild(navFoot());
  }

  /** The menu's foot (mockup MenueNeu): storage, the settings on the left, Kontakte and Kalender on the right. */
  function navFoot() {
    var foot = h('div', { class: 'mp-foot' });
    if (S.limits && S.limits.quotaBytes) {
      var pct = Math.min(100, Math.round((S.limits.usedBytes || 0) / S.limits.quotaBytes * 100));
      add(foot, [h('span', { class: 'mp-sub', text: T('p.storage', { used: fmtSize(S.limits.usedBytes), max: fmtSize(S.limits.quotaBytes) }) }),
        h('span', { class: 'mp-bar' }, h('span', { style: 'width:' + pct + '%' }))]);
    }
    var areaBtn = function (area, ic, label) {
      var on = S.area === area;
      return h('button', { type: 'button', class: 'mp-ibx' + (on ? ' is-on' : ''), attrs: { 'aria-label': label, title: label, 'aria-pressed': on ? 'true' : 'false' },
        on: { click: function () { setArea(on ? 'mail' : area); } } }, icon(ic, 20));
    };
    foot.appendChild(h('div', { class: 'mp-foot-row' }, [
      h('button', { type: 'button', class: 'mp-ibx', attrs: { 'aria-label': T('p.mail_settings'), title: T('p.settings') }, on: { click: settingsDialog } }, icon('gear', 20)),
      h('span', { style: 'flex:1' }),
      has('contacts') && CON ? areaBtn('contacts', 'person', T('p.k.title')) : null,
      has('calendar') && CAL ? areaBtn('calendar', 'cal', T('p.c.title')) : null,
    ]));
    return foot;
  }

  /** The first row of the calendar's and the contacts' menu: back to the mail. */
  function toMailRow() {
    return h('button', { type: 'button', class: 'mp-row', on: { click: function () { setArea('mail'); } } },
      [icon('inbox'), h('span', { class: 'mp-tx', text: T('p.inboxes') }), S.unread.all ? h('span', { class: 'mp-count', text: String(S.unread.all) }) : null]);
  }

  /** Switch the area: Mail, Kalender, Kontakte. */
  function setArea(area) {
    S.area = area === 'calendar' && CAL && has('calendar') ? 'calendar' : area === 'contacts' && CON && has('contacts') ? 'contacts' : 'mail';
    showPane('list');
    renderNav();
    if (S.area === 'calendar') { CAL.show(); return; }
    if (S.area === 'contacts') { CON.show(); return; }
    if (!S.accounts.length) { renderEmpty(); return; }
    renderList();
    if (S.open) renderRead(S.open); else renderReadEmpty();
    loadList(true);
  }

  function mailNav(nav) {
    nav.appendChild(navRow(icon('inbox'), T('p.all_inboxes'), S.view === 'box' && S.box === 'all' && !S.folderId, function () { go({ box: 'all', folderId: null }); }, S.unread.all));
    if (has('drive') && S.filing.length) nav.appendChild(navRow(icon('drive'), T('p.filing'), S.view === 'filing', showFiling, S.filing.length));
    if (S.outbox.length) nav.appendChild(navRow(icon('send'), T('p.outbox'), S.view === 'outbox', showOutbox, S.outbox.length));
    nav.appendChild(h('div', { class: 'mp-lab', text: T('p.accounts') }));
    S.accounts.forEach(function (a) {
      var bad = a.state === 'auth_failed' ? T('p.state_auth_failed') : a.state === 'unreachable' ? T('p.state_unreachable') : null;
      nav.appendChild(navRow(accAvatar(a), a.name || a.email, S.view === 'box' && S.box === a.id && !S.folderId, function () { S.expanded[a.id] = true; go({ box: a.id, folderId: null }); },
        (S.unread.byAccount || {})[a.id], { warn: bad, account: a }));
      if (S.expanded[a.id] || S.box === a.id) {
        (S.folders[a.id] || []).filter(function (f) { return f.role !== 'inbox'; }).forEach(function (f) {
          nav.appendChild(navRow(icon(f.role === 'sent' ? 'send' : f.role === 'trash' ? 'trash' : f.role === 'archive' ? 'archive' : 'folder'), roleName(f), S.folderId === f.id,
            function () { go({ box: a.id, folderId: f.id }); }, f.unread, { sub: true }));
        });
      }
    });
  }

  function showPane(p) {
    var app = $('mp-app');
    app.className = 'mp-app' + (S.area !== 'mail' ? ' is-' + S.area : '') + (p === 'nav' ? ' show-nav' : p === 'read' ? ' show-read' : '');
  }

  function go(o) {
    S.area = 'mail';
    S.view = 'box';
    S.box = o.box;
    S.folderId = o.folderId;
    S.q = '';
    S.tab = 'relevant';
    renderNav();
    loadList();
  }

  // ── the list ─────────────────────────────────────────────

  function scopeIsInbox() { return !S.folderId; }

  function loadList(keepOpen) {
    if (S.area !== 'mail') return Promise.resolve();
    S.loading = true;
    var q = S.view === 'search'
      ? api('GET', 'search', null, { q: S.q, box: S.box })
      : api('GET', 'messages', null, { box: S.box, folder: S.folderId, tab: scopeIsInbox() ? S.tab : null, limit: 50 });
    return q.then(function (r) {
      S.items = r.items || [];
      S.next = r.next || null;
      S.counts = r.counts || {};
      S.loading = false;
      if (S.area !== 'mail') return;
      renderList();
      if (!keepOpen && !S.open) renderReadEmpty();
    }, function (e) { S.loading = false; fail(e); });
  }

  function loadMore() {
    if (!S.next) return;
    var q = S.view === 'search'
      ? api('GET', 'search', null, { q: S.q, box: S.box, cursor: S.next })
      : api('GET', 'messages', null, { box: S.box, folder: S.folderId, tab: scopeIsInbox() ? S.tab : null, before: S.next, limit: 50 });
    q.then(function (r) { S.items = S.items.concat(r.items || []); S.next = r.next || null; renderList(); }, fail);
  }

  function listTitle() {
    if (S.view === 'search') return T('p.search_results');
    if (S.folderId) { var f = folderOf(S.folderId); return f ? roleName(f) : ''; }
    return S.box === 'all' ? T('p.all_inboxes') : T('p.inbox');
  }
  function listSub() {
    if (S.box === 'all') return T('p.sub_all', { n: S.accounts.length, unread: S.unread.all || 0 });
    var a = accountOf(S.box);
    return accountLabel(a) + ' · ' + T('p.sub_unread', { unread: (S.unread.byAccount || {})[S.box] || 0 });
  }

  function renderList() {
    var el = $('mp-list');
    clear(el);
    var search = h('input', { type: 'search', placeholder: T('p.search'), value: S.q, attrs: { 'aria-label': T('p.search') } });
    search.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      S.q = search.value.trim();
      S.view = S.q ? 'search' : 'box';
      loadList();
    });
    el.appendChild(h('div', { class: 'mp-head' }, [
      ibtn('menu', T('p.menu'), function () { showPane('nav'); }, 'mp-menu-btn'),
      h('div', { class: 'mp-head-tx' }, [h('h2', { text: listTitle() }), h('div', { class: 'mp-sub', text: listSub() })]),
      btn(T('p.new_mail'), function () { compose({}); }, { icon: 'pen', primary: true, small: true }),
    ]));
    el.appendChild(h('label', { class: 'mp-search' }, [icon('search'), search]));
    if (S.view === 'box' && scopeIsInbox()) {
      var tabBtn = function (id, label) {
        return h('button', { type: 'button', attrs: { role: 'tab', 'aria-selected': S.tab === id ? 'true' : 'false' }, on: { click: function () { S.tab = id; loadList(); } } }, label);
      };
      el.appendChild(h('div', { class: 'mp-tabs', attrs: { role: 'tablist' } }, [
        tabBtn('relevant', T('p.relevant') + (S.counts.relevant ? ' · ' + S.counts.relevant : '')),
        tabBtn('other', T('p.other') + (S.counts.other ? ' · ' + S.counts.other : '')),
      ]));
    }
    if (!S.items.length) { el.appendChild(h('div', { class: 'mp-items' }, h('div', { class: 'mp-empty', text: S.loading ? T('p.loading') : T('p.empty') }))); return; }
    var list = h('div', { class: 'mp-items', attrs: { role: 'list' } });
    S.items.forEach(function (m) { list.appendChild(itemRow(m)); });
    el.appendChild(list);
    if (S.next) el.appendChild(h('div', { style: 'display:flex;justify-content:center' }, btn(T('p.more'), loadMore, { small: true })));
  }

  function itemRow(m) {
    var a = accountOf(m.accountId);
    var who = m.from.name || m.from.email;
    return h('button', { type: 'button', class: 'mp-item' + (m.unread ? ' is-unread' : '') + (S.openId === m.id ? ' is-open' : ''), attrs: { role: 'listitem' }, on: { click: function () { openMessage(m.id); } } }, [
      h('span', { class: 'mp-av' }, [initials(who), h('span', { class: 'mp-dot', attrs: { style: 'background:' + (a ? a.color : 'var(--muted)') } })]),
      h('span', { class: 'mp-it' }, [
        h('span', { class: 'mp-l1' }, [h('span', { class: 'mp-from', text: who }), m.threadCount > 1 ? h('span', { class: 'mp-count-n', text: String(m.threadCount) }) : null,
          h('span', { class: 'mp-marks' }, [m.hasAttachments ? icon('clip', 13) : null, m.flagged ? h('span', { class: 'is-flag' }, icon('flag', 13)) : null]),
          h('span', { class: 'mp-time', text: fmtTime(m.date) })]),
        h('span', { class: 'mp-subj' }, [m.invite ? h('span', { class: 'mp-tag', text: T('p.c.invitation') }) : null, m.subject || T('p.no_subject')]),
        h('span', { class: 'mp-snip', text: m.ai && m.ai.summary ? m.ai.summary : m.snippet }),
      ]),
    ]);
  }

  function renderEmpty() {
    var el = $('mp-list');
    clear(el);
    el.appendChild(h('div', { class: 'mp-card' }, [h('h2', { text: T('p.welcome_title') }), h('p', { class: 'dp-hint', text: T('p.welcome_text') }),
      h('div', { class: 'dp-actions', style: 'justify-content:flex-start' }, btn(T('p.add_account'), addAccount, { primary: true, icon: 'plus' }))]));
    renderReadEmpty();
  }

  function renderReadEmpty() {
    var el = $('mp-read');
    clear(el);
    el.appendChild(h('div', { class: 'mp-card' }, h('div', { class: 'mp-empty', text: T('p.pick_mail') })));
  }

  // ── reading ──────────────────────────────────────────────

  function openMessage(id) {
    S.openId = id;
    renderList();
    api('GET', 'messages/' + id).then(function (m) {
      S.open = m;
      renderRead(m);
      showPane('read');
      if (m.unread) api('POST', 'messages/flags', { ids: [m.id], unread: false }).then(function () { m.unread = false; loadMe().then(renderNav, function () {}); markRead(m.id); }, function () {});
    }, fail);
  }

  function reloadOpen() {
    var id = S.openId;
    api('GET', 'messages/' + id).then(function (m) { if (S.openId !== id) return; S.open = m; renderRead(m); }, function () {});
  }

  function markRead(id) { S.items.forEach(function (x) { if (x.id === id) x.unread = false; }); renderList(); }

  function act(path, body, okText, after) {
    return api('POST', path, body).then(function () { if (okText) toast(okText); if (after) after(); loadMe().then(renderNav, function () {}); loadList(true); }, fail);
  }

  function renderRead(m) {
    var el = $('mp-read');
    clear(el);
    var a = accountOf(m.accountId);
    var tools = h('div', { class: 'mp-tools' }, [
      ibtn('back', T('p.back'), function () { showPane('list'); }, 'mp-back'),
      btn(T('p.reply'), function () { compose({ mode: 'reply', replyTo: m.id }); }, { icon: 'reply', small: true }),
      btn(T('p.reply_all'), function () { compose({ mode: 'replyAll', replyTo: m.id }); }, { icon: 'replyAll', small: true }),
      btn(T('p.forward'), function () { compose({ mode: 'forward', replyTo: m.id }); }, { icon: 'forward', small: true }),
      ibtn('archive', T('p.archive'), function () { act('messages/archive', { ids: [m.id] }, T('p.archived'), closeRead); }),
      ibtn('trash', T('p.delete'), function () { act('messages/delete', { ids: [m.id] }, T('p.deleted'), closeRead); }),
      ibtn('unread', T('p.mark_unread'), function () { act('messages/flags', { ids: [m.id], unread: true }, T('p.marked_unread')); }),
      ibtn('flag', m.flagged ? T('p.unflag') : T('p.flag'), function () { act('messages/flags', { ids: [m.id], flagged: !m.flagged }, null, function () { m.flagged = !m.flagged; renderRead(m); }); }, m.flagged ? 'is-on' : ''),
      ibtn('other', m.tab === 'other' ? T('p.to_relevant') : T('p.to_other'), function () { act('messages/tab', { ids: [m.id], tab: m.tab === 'other' ? 'relevant' : 'other' }, T('p.sorted')); }),
    ]);
    var head = h('div', { class: 'mp-card' }, [
      tools,
      h('h2', { text: m.subject || T('p.no_subject') }),
      h('div', { class: 'mp-meta' }, [
        h('span', { class: 'mp-av' }, [initials(m.from.name || m.from.email), h('span', { class: 'mp-dot', attrs: { style: 'background:' + (a ? a.color : 'var(--muted)') } })]),
        h('span', null, [h('b', { text: m.from.name || m.from.email }), ' ', m.from.name ? '<' + m.from.email + '>' : '']),
        // since 1.3.0: the sender as a contact („Kontakt öffnen“ / „Als Kontakt speichern“)
        has('contacts') && CON && m.from.email ? btn(T('p.k.sender'), function () { CON.fromSender(m); }, { small: true, icon: 'person' }) : null,
      ]),
      h('div', { class: 'mp-meta', text: T('p.to_line', { to: (m.to || []).map(function (p) { return p.name || p.email; }).join(', '), account: a ? (a.name || a.email) : '', date: fmtFull(m.date) }) }),
      m.threadCount > 1 ? btn(T('p.thread', { n: m.threadCount }), function () { showThread(m.threadId); }, { small: true }) : null,
    ]);
    el.appendChild(head);
    // since 1.3.0: the invitation card (mockup Einladung) above the AI bar and the text
    if (has('calendar') && CAL) { var inv = CAL.invitationCard(m, S.items.filter(function (x) { return x.id === m.id; })[0] || null); if (inv) el.appendChild(inv); }
    if (has('ai')) el.appendChild(aiBar(m));
    if ((m.attachments || []).some(function (t) { return !t.inline; })) el.appendChild(attachmentsCard(m));
    el.appendChild(bodyCard(m));
  }

  function closeRead() { S.open = null; S.openId = null; renderReadEmpty(); showPane('list'); }

  function showThread(threadId) {
    api('GET', 'threads/' + threadId).then(function (r) {
      var body = (r.items || []).map(function (x) {
        return h('button', { type: 'button', class: 'mp-item', on: { click: function () { closeDialog(); openMessage(x.id); } } }, [
          h('span', { class: 'mp-av', text: initials(x.from.name || x.from.email) }),
          h('span', { class: 'mp-it' }, [h('span', { class: 'mp-l1' }, [h('span', { class: 'mp-from', text: x.from.name || x.from.email }), h('span', { class: 'mp-time', text: fmtFull(x.date) })]),
            h('span', { class: 'mp-snip', text: x.snippet })]),
        ]);
      });
      dialog(T('p.thread_title'), [h('div', { class: 'mp-items' }, body)], { wide: true });
    }, fail);
  }

  // the AI bar: "Kurz gesagt", "Zu tun" as chips, reply suggestions
  function aiBar(m) {
    var box = h('div', { class: 'mp-ai' }, [h('div', { class: 'mp-ai-h' }, [icon('spark'), h('span', { text: T('p.ai_title') })])]);
    var body = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
    box.appendChild(body);
    var show = function (r) {
      clear(body);
      if (!r || r.status !== 'done') {
        body.appendChild(btn(T('p.ai_run'), function () { body.textContent = T('p.ai_working'); api('POST', 'ai/' + m.id).then(show, function (e) { clear(body); body.appendChild(h('p', { class: 'dp-hint', text: errText(e) })); }); }, { small: true, icon: 'spark' }));
        return;
      }
      if (r.summary) body.appendChild(h('p', { style: 'margin:0', text: r.summary }));
      if (r.todos && r.todos.length) {
        body.appendChild(h('div', { class: 'mp-chips' }, r.todos.map(function (td, i) {
          var label = td.text + (td.amount != null ? ' · ' + td.amount + ' ' + (td.currency || '') : '');
          return h('button', { type: 'button', class: 'mp-chip', on: { click: function () { todoDialog(m, td, i); } } }, [icon(td.kind === 'event' || td.kind === 'deadline' ? 'cal' : 'spark', 13), label]);
        })));
      }
      if (r.replies && r.replies.length) {
        body.appendChild(h('div', { class: 'mp-sub', text: T('p.ai_replies') }));
        body.appendChild(h('div', { class: 'mp-chips' }, r.replies.map(function (rp) {
          return h('button', { type: 'button', class: 'mp-chip', on: { click: function () { compose({ mode: 'reply', replyTo: m.id, text: rp.text }); } } }, rp.label);
        })));
      }
      if (!r.summary && !(r.todos || []).length && !(r.replies || []).length) body.appendChild(h('p', { class: 'dp-hint', text: T('p.ai_nothing') }));
    };
    api('GET', 'ai/' + m.id).then(show, function () { show(null); });
    return box;
  }

  function todoDialog(m, td, i) {
    var err = h('p', { class: 'dp-err' });
    var acts = [btn(T('p.close'), closeDialog)];
    if (has('familyCalendar') && td.date) {
      acts.push(btn(T('p.to_family_calendar'), function () {
        api('POST', 'ai/' + m.id + '/todo/' + i, { action: 'family_calendar' }).then(function (r) { closeDialog(); toast(T('p.saved_in', { where: r.where })); }, function (e) { err.textContent = errText(e); });
      }, { primary: true, icon: 'cal' }));
    }
    dialog(td.text, [h('p', { class: 'dp-hint', text: [T('p.todo_' + td.kind), td.date ? new Date(td.date + 'T12:00:00').toLocaleDateString(LOCALE) : '', td.time || ''].filter(Boolean).join(' · ') }), err, h('div', { class: 'dp-actions' }, acts)]);
  }

  // attachments: download, "In Drive speichern" with Drive's suggestion
  function attachmentsCard(m) {
    var card = h('div', { class: 'mp-card' }, [h('div', { class: 'mp-ai-h', style: 'color:var(--text)' }, [icon('clip'), h('span', { text: T('p.attachments') })])]);
    var list = h('div', { class: 'mp-atts' });
    card.appendChild(list);
    var real = m.attachments.filter(function (t) { return !t.inline; });
    real.forEach(function (t) { list.appendChild(attRow(m, t)); });
    if (has('drive') && real.filter(function (t) { return !t.savedTo; }).length > 1) {
      card.appendChild(h('div', { class: 'dp-actions', style: 'justify-content:flex-start' }, btn(T('p.save_all'), function () {
        api('POST', 'messages/' + m.id + '/drive/save-all').then(function (r) { toast(T('p.saved_n', { n: (r.saved || []).length })); openMessage(m.id); }, fail);
      }, { small: true, icon: 'drive' })));
    }
    return card;
  }

  function attRow(m, t) {
    var sugg = h('div', { class: 'mp-sugg' });
    var row = h('div', { class: 'mp-att' }, [
      h('span', { class: 'mp-att-ic', text: extOf(t.name) }),
      h('div', { class: 'mp-att-tx' }, [h('b', { text: t.name, attrs: { title: t.name } }), h('span', { class: 'mp-sub', text: fmtSize(t.size) }), sugg]),
    ]);
    var acts = h('div', { class: 'mp-tools' });
    row.appendChild(acts);
    acts.appendChild(btn(T('p.download'), function () { download(0); }, { small: true }));
    // a large attachment still loading at the provider: 409 busy (reason loading) — asked again a few times
    function download(n) {
      api('GET', 'messages/' + m.id + '/attachments/' + t.id).then(function (r) {
        if (!r.url) { toast(T('p.no_download'), 'error'); return; }
        var link = h('a', { attrs: { href: r.url, download: t.name } });
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }, function (e) {
        if (e && e.code === 'busy' && e.extra && e.extra.reason === 'loading' && n < 12) {
          if (n === 0) toast(T('p.att_loading'));
          setTimeout(function () { download(n + 1); }, Math.min(Math.max(Number(e.extra.retryAfter) || 5, 2), 30) * 1000);
          return;
        }
        fail(e);
      });
    }
    if (!has('drive')) return row;
    if (t.savedTo) { add(sugg, [T('p.in_drive') + ' ', h('b', { text: t.savedTo.where })]); return row; }
    var remember = h('input', { type: 'checkbox' });
    var showSugg = function (s, dup) {
      clear(sugg);
      if (dup) sugg.appendChild(h('span', { text: T('p.duplicate') + ' ' }));
      if (s) add(sugg, [T('p.suggest_as') + ' ', h('b', { text: s.name }), ' ' + T('p.suggest_in') + ' ', h('b', { text: s.where }), s.reason === 'learned' || s.reason === 'rule' ? ' · ' + T('p.reason_' + s.reason) : '']);
      else if (s === null) sugg.appendChild(h('span', { text: T('p.no_suggestion') }));
    };
    if (t.suggestion) showSugg(t.suggestion, false);
    var save = function (folderId) {
      var body = { remember: remember.checked };
      if (folderId) body.folderId = folderId;
      api('POST', 'messages/' + m.id + '/attachments/' + t.id + '/drive/save', body).then(function (r) { t.savedTo = r.savedTo; toast(T('p.saved_in', { where: r.savedTo.where })); renderRead(m); }, fail);
    };
    acts.appendChild(btn(T('p.save_drive'), function () {
      if (t.suggestion) { save(null); return; }
      api('POST', 'messages/' + m.id + '/attachments/' + t.id + '/drive/suggest').then(function (r) {
        t.suggestion = r.suggestion;
        showSugg(r.suggestion, r.duplicate);
        if (r.suggestion) save(null); else drivePicker('folder', function (f) { save(f.id); });
      }, fail);
    }, { small: true, primary: true, icon: 'drive' }));
    acts.appendChild(btn(T('p.other_folder'), function () { drivePicker('folder', function (f) { save(f.id); }); }, { small: true }));
    row.appendChild(h('label', { class: 'dp-check', style: 'flex-basis:100%;font-size:12.5px' }, [remember, h('span', { text: T('p.always_sender', { sender: m.from.name || m.from.email }) })]));
    if (!t.suggestion) {
      api('POST', 'messages/' + m.id + '/attachments/' + t.id + '/drive/suggest').then(function (r) { t.suggestion = r.suggestion; showSugg(r.suggestion, r.duplicate); }, function () {});
    }
    return row;
  }

  /** Sanitized HTML (GateControl's) in a shadow root of `host` → the wrapping element (links and pictures are the caller's). */
  function shadowHtml(host, html, text) {
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var wrap = document.createElement('div');
    if (html) wrap.innerHTML = html; // sanitized by GateControl (gc.mail.sanitize): no script, no handlers
    else wrap.appendChild(h('pre', { style: 'white-space:pre-wrap;font:14px/1.5 system-ui,sans-serif;margin:0', text: text || '' }));
    var style = document.createElement('style');
    style.textContent = ':host{all:initial;display:block;font:14px/1.5 system-ui,sans-serif;color:#111}img{max-width:100%;height:auto}a{color:#0b6bcb}table{max-width:100%}';
    root.appendChild(style);
    root.appendChild(wrap);
    return wrap;
  }

  // the body: sanitized HTML in a shadow root, pictures only when allowed
  function bodyCard(m) {
    var card = h('div', { class: 'mp-card' });
    if (m.bodyMissing) {
      // the provider is slow (a first sync, a large mail): the snippet meanwhile, the body follows (live event)
      card.appendChild(h('div', { class: 'mp-note' }, [icon('mail'), h('span', { text: T('p.body_loading') }), btn(T('p.body_retry'), reloadOpen, { small: true })]));
    }
    if (m.imagesBlocked || m.trackers) {
      var note = h('div', { class: 'mp-note' }, [icon('shield'), h('span', { text: m.imagesBlocked ? T('p.images_blocked', { n: m.trackers || 0 }) : T('p.trackers', { n: m.trackers }) })]);
      if (m.imagesBlocked && has('images')) {
        note.appendChild(btn(T('p.images_once'), function () { api('POST', 'messages/' + m.id + '/images', { allow: 'once' }).then(function (x) { S.open = x; renderRead(x); }, fail); }, { small: true }));
        note.appendChild(btn(T('p.images_sender'), function () { api('POST', 'messages/' + m.id + '/images', { allow: 'sender' }).then(function (x) { S.open = x; renderRead(x); }, fail); }, { small: true }));
      }
      card.appendChild(note);
    }
    var host = h('div', { class: 'mp-body' });
    card.appendChild(host);
    var wrap = shadowHtml(host, m.html, m.text);
    Array.prototype.forEach.call(wrap.querySelectorAll('img'), function (img) {
      var src = img.getAttribute('src') || '';
      if (/^img\//.test(src)) {
        img.removeAttribute('src');
        if (m.imagesBlocked) { img.setAttribute('alt', img.getAttribute('alt') || T('p.image')); return; }
        api('GET', src).then(function (r) { img.setAttribute('src', 'data:' + r.mime + ';base64,' + r.data); }, function () {});
      } else if (/^cid:/i.test(src)) {
        img.removeAttribute('src');
        var cid = src.slice(4).replace(/^<|>$/g, '');
        var att = (m.attachments || []).filter(function (t) { return t.cid === cid; })[0];
        if (att) api('GET', 'cid/' + m.id + '/' + att.id).then(function (r) { if (r.url) img.setAttribute('src', r.url); }, function () {});
      } else if (!/^data:/i.test(src)) img.removeAttribute('src');
    });
    // links: the frame opens no window — show the address to copy
    wrap.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
      if (!a) return;
      ev.preventDefault();
      var href = a.getAttribute('href') || '';
      if (!/^(https?:|mailto:)/i.test(href)) return;
      if (/^mailto:/i.test(href)) { compose({ to: [href.slice(7).split('?')[0]] }); return; }
      linkDialog(href);
    });
    return card;
  }

  /** A link the frame cannot open: the address to copy. */
  function linkDialog(href, title) {
    dialog(title || T('p.link_title'), [h('div', { class: 'dp-url' }, [h('span', { text: href }), btn(T('p.copy'), function () { copyText(href); }, { small: true })]), h('p', { class: 'dp-hint', text: T('p.link_hint') })]);
  }

  // ── dialogs ──────────────────────────────────────────────

  function dialog(title, body, o) {
    var x = o || {};
    var back = $('mp-dialog');
    clear(back);
    lastFocus = document.activeElement;
    var box = h('div', { class: 'dp-dialog' + (x.wide ? ' is-wide' : ''), attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title } }, [
      h('div', { style: 'display:flex;align-items:flex-start;gap:12px' }, [
        h('div', { style: 'flex:1;min-width:0;display:flex;flex-direction:column;gap:12px' }, [h('h3', { text: title }), x.sub ? h('p', { class: 'dp-dialog-sub', text: x.sub }) : null]),
        ibtn('close', T('p.close'), function () { if (x.onClose) x.onClose(); closeDialog(); }),
      ]),
    ].concat(body || []));
    back.appendChild(box);
    back.hidden = false;
    return box;
  }
  function closeDialog() {
    var back = $('mp-dialog');
    back.hidden = true;
    clear(back);
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* gone */ } }
  }
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !$('mp-dialog').hidden) closeDialog(); });

  function field(label, input) { return h('label', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: label }), input]); }

  // a Drive folder or file: areas, then folders (Drive's browse through this plugin)
  function drivePicker(mode, onPick) {
    var listEl = h('div', { class: 'mp-pick' });
    var where = h('p', { class: 'dp-hint' });
    var err = h('p', { class: 'dp-err' });
    var stack = [];
    var cur = null;
    var here = btn(T('p.save_here'), function () { if (cur && cur.folder.writable) { closeDialog(); onPick(cur.folder); } }, { primary: true });
    var load = function (q) {
      api('GET', 'drive/browse', null, q).then(function (r) {
        cur = r;
        where.textContent = r.folder.where;
        here.disabled = !r.folder.writable;
        clear(listEl);
        if (stack.length) listEl.appendChild(h('button', { type: 'button', on: { click: function () { stack.pop(); load(stack.length ? stack[stack.length - 1] : q0); } } }, [icon('back'), T('p.up')]));
        (r.items || []).forEach(function (x) {
          if (!x.isDir && mode === 'folder') return;
          listEl.appendChild(h('button', { type: 'button', on: { click: function () {
            if (x.isDir) { var nq = { folder: x.id, dirs: mode === 'folder' ? '1' : '' }; stack.push(nq); load(nq); } else { closeDialog(); onPick(x); }
          } } }, [icon(x.isDir ? 'folder' : 'file'), h('span', { class: 'mp-tx', text: x.name }), x.isDir ? null : h('span', { class: 'mp-sub', text: fmtSize(x.size) })]));
        });
        if (!listEl.firstChild) listEl.appendChild(h('div', { class: 'mp-empty', text: T('p.empty_folder') }));
      }, function (e) { err.textContent = errText(e); });
    };
    var q0 = { dirs: mode === 'folder' ? '1' : '' };
    var areasEl = h('div', { class: 'dp-chips' });
    api('GET', 'drive/areas').then(function (r) {
      (r.areas || []).forEach(function (a) {
        areasEl.appendChild(h('button', { type: 'button', on: { click: function () { stack = []; q0 = { area: a.id, dirs: mode === 'folder' ? '1' : '' }; load(q0); } } }, a.label));
      });
    }, function () {});
    dialog(mode === 'folder' ? T('p.pick_folder') : T('p.pick_file'), [areasEl, where, listEl, err, mode === 'folder' ? h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), here]) : null], { wide: true });
    load(q0);
  }

  // ── writing ──────────────────────────────────────────────

  function people(text) {
    return String(text || '').split(/[,;]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function peopleText(list) { return (list || []).map(function (p) { return p.name ? p.name + ' <' + p.email + '>' : p.email; }).join(', '); }

  function compose(o) {
    var body = { attachments: [] };
    if (o.mode) { body.mode = o.mode; body.replyTo = o.replyTo; }
    if (o.to) body.to = o.to;
    if (!o.mode && S.box !== 'all') body.accountId = S.box;
    api('POST', 'drafts', body).then(function (r) { editDraft(r.draft, o.text, true); }, fail);
  }

  function suggestBox(input) {
    var box = h('div', { class: 'mp-sugglist', hidden: true });
    var timer = null;
    input.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      var parts = input.value.split(/[,;]/);
      var q = parts[parts.length - 1].trim();
      if (q.length < 2) { box.hidden = true; return; }
      timer = setTimeout(function () {
        api('GET', 'contacts', null, { q: q }).then(function (r) {
          clear(box);
          (r.items || []).forEach(function (c) {
            box.appendChild(h('button', { type: 'button', on: { click: function () {
              parts[parts.length - 1] = ' ' + (c.name ? c.name + ' <' + c.email + '>' : c.email);
              input.value = parts.join(',').replace(/^\s+/, '') + ', ';
              box.hidden = true;
              input.focus();
            } } }, (c.name ? c.name + ' · ' : '') + c.email));
          });
          box.hidden = !box.firstChild;
        }, function () { box.hidden = true; });
      }, 250);
    });
    return box;
  }

  function editDraft(d, text, fresh) {
    var from = h('select', { class: 'dp-input' }, S.accounts.map(function (a) { return h('option', { value: String(a.id), selected: a.id === d.accountId, text: accountLabel(a) }); }));
    var to = h('input', { class: 'dp-input', type: 'text', value: peopleText(d.to), attrs: { autocomplete: 'off' } });
    var cc = h('input', { class: 'dp-input', type: 'text', value: peopleText(d.cc), attrs: { autocomplete: 'off' } });
    var bcc = h('input', { class: 'dp-input', type: 'text', value: peopleText(d.bcc), attrs: { autocomplete: 'off' } });
    var subject = h('input', { class: 'dp-input', type: 'text', value: d.subject || '' });
    var editor = h('div', { class: 'mp-editor', attrs: { contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': T('p.text') } });
    editor.innerHTML = d.html || ''; // the person's own draft (the server keeps no script in it)
    // a new draft: the account's signature on top (the server never adds it)
    var acc = accountOf(d.accountId);
    if (fresh && acc && acc.signature) {
      var sg = document.createElement('p');
      sg.appendChild(document.createTextNode('-- '));
      acc.signature.split('\n').forEach(function (l) { sg.appendChild(document.createElement('br')); sg.appendChild(document.createTextNode(l)); });
      editor.insertBefore(sg, editor.firstChild);
      editor.insertBefore(document.createElement('p'), editor.firstChild);
    }
    if (text) { var p = document.createElement('p'); p.textContent = text; editor.insertBefore(p, editor.firstChild); }
    var atts = h('div', { class: 'mp-atts' });
    var warns = h('div', { class: 'mp-warns' });
    var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    var later = h('input', { class: 'dp-input', type: 'datetime-local', style: 'width:auto' });
    var current = d;
    var fields = function (extra) {
      return Object.assign({ accountId: Number(from.value), to: people(to.value), cc: people(cc.value), bcc: people(bcc.value), subject: subject.value, html: editor.innerHTML,
        attachments: current.attachments.map(function (x) { return { id: x.id }; }) }, extra || {});
    };
    var show = function (x) {
      current = x;
      clear(atts);
      x.attachments.forEach(function (t) {
        atts.appendChild(h('div', { class: 'mp-att' }, [h('span', { class: 'mp-att-ic', text: t.as === 'link' ? 'LINK' : extOf(t.name) }),
          h('div', { class: 'mp-att-tx' }, [h('b', { text: t.name }), h('span', { class: 'mp-sub', text: t.as === 'link' ? T('p.as_link') : fmtSize(t.size) })]),
          ibtn('close', T('p.remove'), function () {
            current.attachments = current.attachments.filter(function (y) { return y.id !== t.id; });
            save().then(show, function (e) { err.textContent = errText(e); });
          })]));
      });
      clear(warns);
      (x.warnings || []).forEach(function (w) { warns.appendChild(h('p', { text: w.text })); });
    };
    var save = function (extra) { return api('PUT', 'drafts/' + current.id, fields(extra)).then(function (r) { return r.draft; }); };
    var addFiles = function (list) { save({ attachments: fields().attachments.concat(list) }).then(show, function (e) { err.textContent = errText(e); }); };
    var fileInput = $('mp-file');
    var onFiles = function () {
      var files = Array.prototype.slice.call(fileInput.files || []);
      fileInput.value = '';
      if (!files.length || !window.GC.upload) return;
      Promise.all(files.map(function (f) { return window.GC.upload(f).then(function (r) { return { mediaId: r.mediaId, name: f.name }; }); }))
        .then(addFiles, function (e) { err.textContent = errText({ code: (e && e.code) || 'upload_failed' }); });
    };
    fileInput.onchange = onFiles;
    var send = function (sendAt) {
      err.textContent = '';
      save().then(function (x) {
        show(x);
        return api('POST', 'drafts/' + x.id + '/send', sendAt ? { sendAt: sendAt } : {});
      }).then(function (r) {
        closeDialog();
        if (sendAt) { toast(T('p.planned', { when: fmtFull(r.sendAt) })); reloadAll(); return; }
        snack(T('p.sending'), T('p.undo'), function () {
          api('POST', 'outbox/' + r.outboxId + '/cancel').then(function (c) { api('GET', 'drafts/' + c.draftId).then(function (g) { editDraft(g.draft); }, fail); }, fail);
        }, Math.max(1000, r.undoUntil - Date.now()));
        setTimeout(reloadAll, Math.max(1000, r.undoUntil - Date.now()) + 1500);
      }, function (e) { err.textContent = errText(e); });
    };
    show(d);
    var rows = [
      h('div', { class: 'mp-frow' }, [h('span', { text: T('p.from') }), from]),
      h('div', { class: 'mp-frow' }, [h('span', { text: T('p.to') }), h('div', null, [to, suggestBox(to)])]),
      h('div', { class: 'mp-frow' }, [h('span', { text: T('p.cc') }), h('div', null, [cc, suggestBox(cc)])]),
      h('div', { class: 'mp-frow' }, [h('span', { text: T('p.bcc') }), h('div', null, [bcc, suggestBox(bcc)])]),
      h('div', { class: 'mp-frow' }, [h('span', { text: T('p.subject') }), subject]),
      editor, atts,
      h('div', { class: 'mp-tools' }, [
        btn(T('p.from_device'), function () { fileInput.click(); }, { small: true, icon: 'clip' }),
        has('drive') ? btn(T('p.from_drive'), function () {
          drivePicker('file', function (f) {
            var asLink = f.size > 20 * 1024 * 1024 && window.confirm(T('p.as_link_q'));
            addFiles([{ driveNodeId: f.id, as: asLink ? 'link' : 'copy' }]);
          });
        }, { small: true, icon: 'drive' }) : null,
      ]),
      warns, err,
      h('div', { class: 'dp-actions' }, [
        btn(T('p.discard'), function () { api('DELETE', 'drafts/' + current.id).then(closeDialog, fail); }, { danger: true }),
        later,
        btn(T('p.send_later'), function () { var t = later.value ? new Date(later.value).getTime() : NaN; if (!isFinite(t)) { later.focus(); return; } send(t); }, { icon: 'clock' }),
        btn(T('p.save_draft'), function () { save().then(function (x) { show(x); toast(T('p.draft_saved')); }, function (e) { err.textContent = errText(e); }); }),
        btn(T('p.send'), function () { send(null); }, { primary: true, icon: 'send' }),
      ]),
    ];
    dialog(d.subject || T('p.new_mail'), rows, { wide: true });
    (d.to && d.to.length ? editor : to).focus();
  }

  // ── accounts ─────────────────────────────────────────────

  function addAccount() {
    api('GET', 'providers').then(function (list) {
      var grid = h('div', { class: 'mp-providers' }, list.map(function (p) {
        var sub = p.auth === 'microsoft' ? T('p.auth_microsoft') : p.auth === 'app_password' ? T('p.auth_app_password') : p.auth === 'imap' ? 'IMAP' : T('p.auth_password');
        return h('button', { type: 'button', class: 'mp-provider', on: { click: function () { p.auth === 'microsoft' ? microsoftDialog(p) : passwordDialog(p); } } },
          [h('span', { class: 'mp-av', text: initials(p.label) }), h('span', { class: 'mp-it' }, [h('b', { text: p.label }), h('span', { class: 'mp-sub', text: sub })])]);
      }));
      dialog(T('p.add_account'), [grid], { wide: true });
    }, fail);
  }

  function passwordDialog(p) {
    var email = h('input', { class: 'dp-input', type: 'email', attrs: { autocomplete: 'off' } });
    var pass = h('input', { class: 'dp-input', type: 'password', attrs: { autocomplete: 'new-password' } });
    var name = h('input', { class: 'dp-input', type: 'text', value: '' });
    var color = h('input', { class: 'dp-input', type: 'color', value: '#46E0A0', style: 'width:64px;padding:2px' });
    var user = h('input', { class: 'dp-input', type: 'text', attrs: { autocomplete: 'off' } });
    var ih = h('input', { class: 'dp-input', type: 'text' }); var ip = h('select', { class: 'dp-input' }, [h('option', { value: '993', text: '993 (TLS)' }), h('option', { value: '143', text: '143 (STARTTLS)' })]);
    var sh = h('input', { class: 'dp-input', type: 'text' }); var sp = h('select', { class: 'dp-input' }, [h('option', { value: '465', text: '465 (TLS)' }), h('option', { value: '587', text: '587 (STARTTLS)' })]);
    var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    var imap = p.id === 'imap';
    var servers = imap ? h('div', { style: 'display:flex;flex-direction:column;gap:10px' }, [field(T('p.username'), user),
      h('div', { class: 'mp-frow' }, [h('span', { text: 'IMAP' }), h('div', { style: 'display:flex;gap:8px' }, [ih, ip])]),
      h('div', { class: 'mp-frow' }, [h('span', { text: 'SMTP' }), h('div', { style: 'display:flex;gap:8px' }, [sh, sp])])]) : null;
    if (imap) {
      email.addEventListener('change', function () {
        if (!email.value || ih.value) return;
        api('POST', 'accounts/discover', { email: email.value }).then(function (r) {
          if (r.imap) { ih.value = r.imap.host; ip.value = String(r.imap.port); }
          if (r.smtp) { sh.value = r.smtp.host; sp.value = String(r.smtp.port); }
          if (r.auth === 'microsoft') err.textContent = T('p.use_microsoft');
        }, function () {});
      });
    }
    var go = function () {
      err.textContent = '';
      var b = { provider: p.id, email: email.value.trim(), password: pass.value, name: name.value.trim(), color: color.value };
      if (imap) {
        b.username = user.value.trim() || undefined;
        b.imap = { host: ih.value.trim(), port: Number(ip.value), security: ip.value === '993' ? 'tls' : 'starttls' };
        b.smtp = { host: sh.value.trim(), port: Number(sp.value), security: sp.value === '465' ? 'tls' : 'starttls' };
      }
      connect.disabled = true;
      api('POST', 'accounts', b).then(function () { closeDialog(); toast(T('p.account_added')); loadMe().then(reloadAll); }, function (e) { connect.disabled = false; err.textContent = errText(e); });
    };
    var connect = btn(T('p.connect'), go, { primary: true });
    dialog(T('p.setup', { provider: p.label }), [
      p.hint ? h('div', { class: 'dp-note' }, [icon('warn'), h('span', { text: p.hint[CTX.lang] || p.hint.de })]) : null,
      field(T('p.email'), email), field(p.auth === 'app_password' ? T('p.app_password') : T('p.password'), pass), servers,
      h('div', { class: 'mp-frow' }, [h('span', { text: T('p.name_color') }), h('div', { style: 'display:flex;gap:8px' }, [name, color])]),
      h('p', { class: 'dp-hint', text: T('p.password_note') }), err,
      h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), closeDialog), connect]),
    ]);
    email.focus();
  }

  /**
   * Microsoft by device code: a new account, or (`again`, an Account) signed in anew — since 1.3.0 for the calendar and
   * contact rights (the scopes of GET me); afterwards still without them → the company must allow them.
   */
  function microsoftDialog(p, again) {
    if (!has('microsoft')) { dialog(p.label, [h('p', { class: 'dp-hint', text: T('p.microsoft_off') })]); return; }
    var box = h('div', { style: 'display:flex;flex-direction:column;gap:12px' }, h('p', { class: 'dp-hint', text: T('p.loading') }));
    var stopped = false;
    var title = again ? T('p.relogin_title', { account: again.email }) : T('p.setup', { provider: p.label });
    var note = again ? T('p.relogin_text', { account: again.email }) : p.hint ? (p.hint[CTX.lang] || p.hint.de) : '';
    dialog(title, [h('p', { class: 'dp-hint', text: note }), box], { onClose: function () { stopped = true; } });
    var start = { kind: p.id === 'm365' ? 'business' : 'personal' };
    if (again) start.accountId = again.id;
    api('POST', 'accounts/microsoft/device', start).then(function (d) {
      clear(box);
      add(box, [h('p', { text: T('p.device_step1') }), h('div', { class: 'dp-url' }, [h('span', { text: d.verificationUri }), btn(T('p.copy'), function () { copyText(d.verificationUri); }, { small: true })]),
        h('p', { text: T('p.device_step2') }), h('div', { class: 'mp-code', text: d.userCode }), btn(T('p.copy_code'), function () { copyText(d.userCode); }, { small: true }),
        h('p', { class: 'dp-hint', text: T('p.device_wait') })]);
      var poll = function () {
        if (stopped || $('mp-dialog').hidden) return;
        api('GET', 'accounts/microsoft/device/' + d.deviceId).then(function (r) {
          if (r.status === 'pending') { setTimeout(poll, d.interval * 1000); return; }
          if (r.status === 'done') {
            closeDialog();
            toast(again ? T('p.relogged') : T('p.account_added'));
            loadMe().then(function () { renderNav(); if (again) afterRelogin(again.id); else reloadAll(); });
            return;
          }
          clear(box); box.appendChild(h('p', { class: 'dp-err', text: T('p.device_' + r.status) }));
        }, function (e) { clear(box); box.appendChild(h('p', { class: 'dp-err', text: errText(e) })); });
      };
      setTimeout(poll, d.interval * 1000);
    }, function (e) { clear(box); box.appendChild(h('p', { class: 'dp-err', text: errText(e) })); });
  }

  /** Signed in anew: the rights are there (the area reloads), or the company has to allow them (its consent link). */
  function afterRelogin(id) {
    var a = accountOf(id);
    if (!a || !(a.missingScopes || []).length) { refreshArea(); return; }
    var url = S.me && S.me.microsoft ? S.me.microsoft.adminConsentUrl : null;
    dialog(T('p.consent_title'), [h('p', { class: 'dp-hint', text: T('p.consent_company', { account: a.email }) }),
      url ? h('div', { class: 'dp-url' }, [h('span', { class: 'mp-mono', text: url }), btn(T('p.copy'), function () { copyText(url); }, { small: true })]) : null,
      h('div', { class: 'dp-actions' }, btn(T('p.close'), closeDialog))]);
  }
  function relogin(a) { microsoftDialog({ id: a.provider, label: a.email, hint: null }, a); }
  function refreshArea() {
    if (S.area === 'calendar' && CAL) CAL.show();
    else if (S.area === 'contacts' && CON) CON.show();
    else reloadAll();
  }

  /**
   * The band „Kalender und Kontakte von <Konto> freigeben“ with „Neu anmelden“ for every Microsoft account without
   * `scope` (Calendars.ReadWrite / Contacts.ReadWrite) — or null.
   */
  function consentBand(scope) {
    var list = S.accounts.filter(function (a) { return (a.missingScopes || []).indexOf(scope) >= 0; });
    if (!list.length) return null;
    return h('div', { class: 'mp-bands' }, list.map(function (a) {
      return h('div', { class: 'dp-note is-warn' }, [icon('warn'), h('span', { style: 'flex:1', text: T('p.consent_band', { account: a.name ? a.name + ' · ' + a.email : a.email }) }),
        btn(T('p.relogin'), function () { relogin(a); }, { small: true })]);
    }));
  }

  function settingsDialog() {
    var threads = h('input', { type: 'checkbox', class: 'dp-sw', checked: S.settings.threads !== false });
    threads.addEventListener('change', function () { api('PUT', 'settings', { threads: threads.checked }).then(function (r) { S.settings = r.settings; loadList(); }, fail); });
    var rows = [h('label', { class: 'dp-check' }, [threads, h('span', { text: T('p.threads') })]), h('div', { class: 'mp-lab', text: T('p.accounts') })];
    S.accounts.forEach(function (a) {
      rows.push(h('button', { type: 'button', class: 'mp-row is-acc', on: { click: function () { accountDialog(a); } } }, [accAvatar(a, true), accText(a),
        a.state !== 'ok' && a.state !== 'syncing' ? h('span', { class: 'mp-warn', text: T('p.state_' + a.state) }) : null]));
    });
    rows.push(h('div', { class: 'dp-actions', style: 'justify-content:flex-start' }, btn(T('p.add_account'), addAccount, { icon: 'plus', small: true })));
    dialog(T('p.settings'), rows);
  }

  function accountDialog(a) {
    var name = h('input', { class: 'dp-input', type: 'text', value: a.name || '' });
    var color = h('input', { class: 'dp-input', type: 'color', value: a.color, style: 'width:64px;padding:2px' });
    var sel = function (v, opts) { return h('select', { class: 'dp-input' }, opts.map(function (o) { return h('option', { value: o, selected: o === v, text: T('p.opt_' + o) }); })); };
    var push = sel(a.push, ['off', 'relevant', 'all']);
    var atts = sel(a.attachments, ['off', 'suggest', 'auto']);
    var kind = sel(a.kind, ['personal', 'business']);
    var aiSw = h('input', { type: 'checkbox', class: 'dp-sw', checked: a.ai });
    var sig = h('textarea', { class: 'dp-input', attrs: { rows: '3' } });
    sig.value = a.signature || '';
    var pass = h('input', { class: 'dp-input', type: 'password', attrs: { autocomplete: 'new-password', placeholder: T('p.password_keep') } });
    var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
    var ms = a.provider === 'outlook' || a.provider === 'm365';
    // since 1.3.0: the account's calendar and contacts (sync on/off, their state; own servers, the iCal address of Gmail)
    var pim = pimSection(a, ms);
    var save = function () {
      err.textContent = '';
      var b = { name: name.value.trim(), color: color.value.toUpperCase(), push: push.value, attachments: atts.value, kind: kind.value, ai: aiSw.checked, signature: sig.value };
      if (!ms && pass.value) b.password = pass.value;
      pim.fill(b);
      api('PATCH', 'accounts/' + a.id, b).then(function () { closeDialog(); toast(T('p.saved')); loadMe().then(renderNav); }, function (e) { err.textContent = errText(e); });
    };
    var remove = function () {
      if (!window.confirm(T('p.remove_q', { account: accountLabel(a) }))) return;
      api('DELETE', 'accounts/' + a.id).then(function () { closeDialog(); loadMe().then(function () { S.box = 'all'; S.folderId = null; if (S.accounts.length) reloadAll(); else { renderNav(); renderEmpty(); } }); }, fail);
    };
    dialog(accountLabel(a), [
      a.error ? h('div', { class: 'dp-note is-warn' }, [icon('warn'), h('span', { text: T('p.state_' + a.state) })]) : null,
      h('div', { class: 'mp-frow' }, [h('span', { text: T('p.name_color') }), h('div', { style: 'display:flex;gap:8px' }, [name, color])]),
      field(T('p.push'), push), has('drive') ? field(T('p.attachments_mode'), atts) : null, field(T('p.kind'), kind),
      has('ai') ? h('label', { class: 'dp-check' }, [aiSw, h('span', { text: T('p.ai_account') })]) : null,
      field(T('p.signature'), sig), ms ? btn(T('p.relogin'), function () { relogin(a); }, { small: true }) : field(T('p.new_password'), pass),
      pim.el,
      err, h('div', { class: 'dp-actions' }, [btn(T('p.remove_account'), remove, { danger: true }), btn(T('p.cancel'), closeDialog), btn(T('p.save'), save, { primary: true })]),
    ]);
  }

  /** The calendar and contacts part of the account dialog → { el, fill(body) } (nothing without the features). */
  function pimSection(a, ms) {
    var parts = [];
    var sws = {};
    var side = function (what, feature, label) {
      var x = a[what];
      if (!x || !has(feature)) return;
      var sw = h('input', { type: 'checkbox', class: 'dp-sw', checked: x.sync !== false, attrs: { 'aria-label': label } });
      sws[what] = sw;
      var state = x.state === 'consent_required' || x.state === 'none' || x.state === 'off' || x.state === 'ok' || x.state === 'syncing' || x.state === 'auth_failed' || x.state === 'unreachable' ? x.state : 'syncing';
      parts.push(h('div', { class: 'mp-swrow' }, [h('span', { class: 'mp-two', style: 'flex:1;min-width:0' }, [h('span', { text: label }),
        h('span', { class: 'mp-sub', text: T('p.side_' + state) + (x.server && state !== 'off' && state !== 'none' ? ' · ' + x.server : '') + (x.readOnly ? ' · ' + T('p.side_read_only') : '') })]), sw]));
    };
    side('calendar', 'calendar', T('p.sync_calendar'));
    side('contacts', 'contacts', T('p.sync_contacts'));
    if (ms && (a.missingScopes || []).length) parts.push(h('div', { class: 'dp-note is-warn' }, [icon('warn'), h('span', { text: T('p.consent_band', { account: a.email }) })]));
    var inputs = {};
    if (!ms && parts.length) {
      var inp = function (k, type, ph) { inputs[k] = h('input', { class: 'dp-input', type: type, placeholder: ph || '', attrs: { autocomplete: type === 'password' ? 'new-password' : 'off' } }); return inputs[k]; };
      var box = h('div', { class: 'mp-col', hidden: true });
      if (a.provider === 'gmail' || a.provider === 'imap') box.appendChild(field(T('p.ics_url'), inp('icsUrl', 'url', 'https://calendar.google.com/calendar/ical/…/basic.ics')));
      if (a.provider === 'gmail') box.appendChild(h('p', { class: 'dp-hint', text: T('p.ics_hint') }));
      if (a.provider !== 'gmail') {
        box.appendChild(field(T('p.caldav_url'), inp('caldavUrl', 'url', 'https://')));
        box.appendChild(field(T('p.carddav_url'), inp('carddavUrl', 'url', 'https://')));
        box.appendChild(field(T('p.dav_password'), inp('davPassword', 'password', T('p.dav_password_ph'))));
      }
      parts.push(btn(T('p.dav_servers'), function () { box.hidden = !box.hidden; }, { small: true }));
      parts.push(box);
    }
    return {
      el: parts.length ? h('div', { class: 'mp-col' }, [h('div', { class: 'mp-lab', style: 'padding-left:0', text: T('p.pim_title') })].concat(parts)) : null,
      fill: function (b) {
        if (sws.calendar && sws.calendar.checked !== (a.calendar.sync !== false)) b.calendarSync = sws.calendar.checked;
        if (sws.contacts && sws.contacts.checked !== (a.contacts.sync !== false)) b.contactsSync = sws.contacts.checked;
        Object.keys(inputs).forEach(function (k) { var v = inputs[k].value.trim(); if (v) b[k] = v; });
      },
    };
  }

  // ── Zum Ablegen, Ausgang ─────────────────────────────────

  function showFiling() {
    S.view = 'filing';
    renderNav();
    api('GET', 'filing').then(function (r) {
      S.filing = r.items || [];
      var el = $('mp-list');
      clear(el);
      el.appendChild(h('div', { class: 'mp-head' }, [ibtn('menu', T('p.menu'), function () { showPane('nav'); }, 'mp-menu-btn'),
        h('div', { class: 'mp-head-tx' }, [h('h2', { text: T('p.filing') }), h('div', { class: 'mp-sub', text: T('p.filing_sub') })])]));
      if (!S.filing.length) { el.appendChild(h('div', { class: 'mp-items' }, h('div', { class: 'mp-empty', text: T('p.filing_empty') }))); return; }
      var list = h('div', { class: 'mp-atts' });
      S.filing.forEach(function (it) {
        var s = it.suggestion;
        list.appendChild(h('div', { class: 'mp-att' }, [h('span', { class: 'mp-att-ic', text: extOf(it.name) }),
          h('div', { class: 'mp-att-tx' }, [h('b', { text: it.name }), h('span', { class: 'mp-sub', text: (it.from.name || it.from.email) + ' · ' + fmtTime(it.date) }),
            s ? h('span', { class: 'mp-sugg', text: T('p.suggestion_pct', { where: s.where, pct: Math.round((s.confidence || 0) * 100) }) }) : null]),
          h('div', { class: 'mp-tools' }, [
            s ? btn(T('p.file_it'), function () { api('POST', 'filing/' + it.id + '/confirm', {}).then(function (x) { toast(T('p.saved_in', { where: x.savedTo.where })); showFiling(); }, fail); }, { small: true, primary: true }) : null,
            btn(T('p.other_folder'), function () { drivePicker('folder', function (f) { api('POST', 'filing/' + it.id + '/confirm', { folderId: f.id }).then(function (x) { toast(T('p.saved_in', { where: x.savedTo.where })); showFiling(); }, fail); }); }, { small: true }),
            btn(T('p.dont_file'), function () { api('POST', 'filing/' + it.id + '/dismiss').then(showFiling, fail); }, { small: true }),
          ])]));
      });
      el.appendChild(list);
    }, fail);
  }

  function showOutbox() {
    S.view = 'outbox';
    renderNav();
    api('GET', 'outbox').then(function (r) {
      S.outbox = r.items || [];
      var el = $('mp-list');
      clear(el);
      el.appendChild(h('div', { class: 'mp-head' }, [ibtn('menu', T('p.menu'), function () { showPane('nav'); }, 'mp-menu-btn'), h('div', { class: 'mp-head-tx' }, h('h2', { text: T('p.outbox') }))]));
      var list = h('div', { class: 'mp-atts' });
      S.outbox.forEach(function (o) {
        list.appendChild(h('div', { class: 'mp-att' }, [icon(o.state === 'failed' ? 'warn' : 'clock'),
          h('div', { class: 'mp-att-tx' }, [h('b', { text: o.subject || T('p.no_subject') }), h('span', { class: 'mp-sub', text: o.state === 'failed' ? T('p.send_failed', { code: o.error || '' }) : T('p.planned', { when: fmtFull(o.sendAt) }) })]),
          h('div', { class: 'mp-tools' }, [
            btn(T('p.edit'), function () { api('POST', 'outbox/' + o.id + '/cancel').then(function (c) { api('GET', 'drafts/' + c.draftId).then(function (g) { editDraft(g.draft); showOutbox(); }, fail); }, fail); }, { small: true }),
          ])]));
      });
      if (!S.outbox.length) list.appendChild(h('div', { class: 'mp-empty', text: T('p.empty') }));
      el.appendChild(list);
    }, fail);
  }

  // ── calendar and contacts (since 1.3.0) ─────────────────

  /** A file to keep: GateControl's GC.saveFile, else a download link. */
  function saveFile(b64, mime, name) {
    var bin = atob(b64 || '');
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var blob = new Blob([bytes], { type: mime });
    if (window.GC && typeof window.GC.saveFile === 'function') return window.GC.saveFile(blob, name);
    var link = h('a', { attrs: { href: 'data:' + mime + ';base64,' + b64, download: name } });
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return Promise.resolve();
  }
  /** Open a mail of the list's kind (from the contacts or the calendar). */
  function openMail(id) { setArea('mail'); openMessage(id); }
  /** The mails of an address (the sender view: a search). */
  function mailsOf(address) { S.area = 'mail'; S.box = 'all'; S.folderId = null; S.q = address; S.view = 'search'; showPane('list'); renderNav(); loadList(); }

  var UI = {
    CTX: CTX, LOCALE: LOCALE, S: S, L: window.MailPimLogic, T: T, h: h, add: add, clear: clear, icon: icon, btn: btn, ibtn: ibtn, toast: toast, api: api, errText: errText, fail: fail,
    has: has, dialog: dialog, closeDialog: closeDialog, field: field, accountOf: accountOf, accountLabel: accountLabel, accAvatar: accAvatar, initials: initials,
    fmtTime: fmtTime, fmtFull: fmtFull, copyText: copyText, linkDialog: linkDialog, compose: compose, openMail: openMail, mailsOf: mailsOf, showPane: showPane,
    renderNav: renderNav, toMailRow: toMailRow, setArea: setArea, relogin: relogin, consentBand: consentBand, saveFile: saveFile, suggestBox: suggestBox,
    shadowHtml: shadowHtml, loadMe: loadMe,
    calendar: function () { return CAL; }, contacts: function () { return CON; },
  };
  if (window.MailCalendar) CAL = window.MailCalendar.attach(UI);
  if (window.MailContacts) CON = window.MailContacts.attach(UI);

  boot();
})();
