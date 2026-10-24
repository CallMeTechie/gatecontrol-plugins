/* Vault (gatecontrol-vault) — the portal tab "Vault" (mockup P1-Portal).
 *
 * The whole password manager in the browser, end-to-end encrypted like the apps: set up (master password, recovery
 * key shown, copied or saved as a text file, "Ich habe ihn sicher aufbewahrt" before the account is sent), unlock
 * (master password, or the recovery key → a new password and a new recovery key), the vaults with counts, entries
 * with search and favourites, the detail per type (secrets masked until revealed, copy, 2FA code with countdown,
 * Wi-Fi QR code), edit and create all six types with custom fields and the password generator, trash and history,
 * vaults and sharing (roles, safety number before adding someone), emergency access (trusted people, requests,
 * opening a released vault read-only), a new master password, import and a plaintext CSV export; 1.2.0: a 2FA key
 * read from a QR code in a picture (chosen, pasted or dropped — decoded in this frame, never sent or kept).
 *
 * Keys and decrypted data live only in this script's memory: nothing is stored (the frame has no storage), the tab
 * locks after 5 minutes without input and on "Jetzt sperren" — keys are zeroed, every decrypted value and the DOM
 * that showed it are dropped. Online only: GET sync pages fill the copy, saves go straight to the server
 * (conflict → the newer version is loaded and the person decides; stale_key → sync, encrypt again, retry once).
 * Key changes (rekey) are left to the apps; a save during one uses the new key (pending.keyRev).
 *
 * Server and user text only ever goes into textContent or attributes — never innerHTML. No secrets in the console.
 */
(function () {
  'use strict';

  var CTX = window.VA_CTX || { texts: {}, lang: 'de' };
  var VC = window.VaultCrypto;
  var L = window.VaultLogic;
  var LOCK_MS = 5 * 60000;
  var SYNC_EVERY_MS = 60000;
  var DEVICE = 'Portal';
  var MAX_IMPORT_BYTES = 20 * 1024 * 1024;
  var LOCALE = CTX.lang === 'en' ? 'en-GB' : 'de-DE';
  var NS = 'http://www.w3.org/2000/svg';

  // ── texts ────────────────────────────────────────────────

  function T(k, p) {
    var s = CTX.texts && CTX.texts[k] != null ? String(CTX.texts[k]) : k;
    if (p) Object.keys(p).forEach(function (x) { s = s.split('{{' + x + '}}').join(String(p[x])); });
    return s;
  }
  function P(k, n, p) { return T(k + (n === 1 ? '.one' : '.other'), Object.assign({ count: n }, p || {})); }

  // ── DOM helpers (text only through textContent / attributes) ──

  var ICONS = {
    lock: 'M5 11h14v10H5z|M8 11V8a4 4 0 0 1 8 0v3',
    shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
    search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14|M20 20l-3.5-3.5',
    plus: 'M12 5v14M5 12h14',
    star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
    eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z|M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
    eyeOff: 'M3 3l18 18|M10.6 6.1A9.8 9.8 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.8|M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4.4-1.1|M9.9 9.9a3 3 0 0 0 4.2 4.2',
    copy: 'M9 9h11v11H9z|M5 15H4V4h11v1',
    trash: 'M4 7h16|M10 11v6M14 11v6|M6 7l1 13h10l1-13|M9 7V4h6v3',
    history: 'M3 12a9 9 0 1 0 3-6.7L3 8|M3 3v5h5|M12 7v5l3 3',
    users: 'M9 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8|M2 21a7 7 0 0 1 14 0|M17 3.5a4 4 0 0 1 0 7|M22 21a7 7 0 0 0-4-6.3',
    lifebuoy: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20|M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8|M4.9 4.9l4.3 4.3M14.8 14.8l4.3 4.3M19.1 4.9l-4.3 4.3M9.2 14.8l-4.3 4.3',
    swap: 'M7 4v14|M3 14l4 4 4-4|M17 20V6|M13 10l4-4 4 4',
    key: 'M8 14a4 4 0 1 0 0-8a4 4 0 1 0 0 8|M11 10h10M17 10v4M20 10v3',
    back: 'M15 18l-6-6 6-6',
    close: 'M6 6l12 12M18 6L6 18',
    alert: 'M12 3l10 18H2z|M12 10v4M12 17h.01',
    refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8|M21 3v5h-5',
    dice: 'M4 4h16v16H4z|M9 9h.01M15 15h.01M15 9h.01M9 15h.01',
    edit: 'M4 20h4L19 9l-4-4L4 16z|M14 6l4 4',
    grid: 'M4 4h7v7H4z|M13 4h7v7h-7z|M4 13h7v7H4z|M13 13h7v7h-7z',
    qr: 'M4 4h6v6H4z|M14 4h6v6h-6z|M4 14h6v6H4z|M14 14h2v2h-2z|M18 18h2v2h-2z|M14 18h2|M18 14h2',
    image: 'M4 5h16v14H4z|M4 16l5-5 4 4 2-2 5 5|M15 9h.01',
    camera: 'M4 8h3l2-3h6l2 3h3v11H4z|M12 16.5a3.5 3.5 0 1 0 0-7a3.5 3.5 0 1 0 0 7',
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
    (ICONS[name] || '').split('|').forEach(function (d) {
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
    });
    return s;
  }

  /** h('div', { class, text, attrs: {}, on: {}, hidden, value, type, … }, [children]) */
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
      else if (k === 'hidden' || k === 'disabled' || k === 'checked' || k === 'readOnly' || k === 'selected') n[k] = !!v;
      else if (k === 'value' || k === 'type' || k === 'placeholder' || k === 'id' || k === 'name' || k === 'min' || k === 'max' || k === 'rows' || k === 'title') n[k] = v;
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
  var $ = function (id) { return document.getElementById(id); };

  function btn(label, onClick, o) {
    var x = o || {};
    return h('button', {
      type: 'button', class: 'vp-btn' + (x.primary ? ' vp-btn-primary' : '') + (x.danger ? ' vp-btn-danger' : '') + (x.small ? ' vp-btn-sm' : '') + (x.ghost ? ' vp-btn-ghost' : ''),
      disabled: x.disabled, on: { click: onClick }, attrs: { 'aria-label': x.aria || null, title: x.title || null },
    }, [x.icon ? icon(x.icon, 16) : null, label]);
  }
  function ibtn(name, label, onClick, o) {
    var x = o || {};
    return h('button', { type: 'button', class: 'vp-ib' + (x.on ? ' is-on' : ''), on: { click: onClick }, attrs: { 'aria-label': label, title: label, 'aria-pressed': x.pressed == null ? null : String(!!x.pressed) } }, [icon(name, 16)]);
  }
  function inputRow(label, input, hint) {
    return h('label', { class: 'vp-field' }, [h('span', { class: 'vp-label', text: label }), input, hint ? h('span', { class: 'vp-hint', text: hint }) : null]);
  }
  function section(title, kids, cls) {
    return h('div', { class: 'vp-sec' + (cls ? ' ' + cls : '') }, [title ? h('h3', { class: 'vp-sec-h', text: title }) : null, kids]);
  }
  function notice(kind, text, kids) {
    return h('div', { class: 'vp-note vp-note-' + kind, attrs: { role: kind === 'error' ? 'alert' : null } }, [icon(kind === 'info' ? 'shield' : 'alert', 16), h('div', { class: 'vp-note-tx' }, [h('span', { text: text }), kids])]);
  }

  function fmtWhen(iso) {
    var ms = Date.parse(String(iso || ''));
    if (!Number.isFinite(ms)) return '';
    var d = new Date(ms);
    var now = new Date();
    var y = new Date(); y.setDate(y.getDate() - 1);
    var same = function (a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); };
    var time = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
    if (same(d, now)) return T('p.today', { time: time });
    if (same(d, y)) return T('p.yesterday', { time: time });
    return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  var today = function () { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  // ── toast, dialog, clipboard ─────────────────────────────

  var toastTimer = null;
  function toast(text, kind) {
    var t = $('vp-toast');
    t.textContent = text;
    t.className = 'vp-toast' + (kind ? ' is-' + kind : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, kind === 'error' ? 6000 : 3200);
  }

  /** An own dialog (sandboxed frames have no modals) → Promise<boolean>. */
  function ask(text, okLabel, o) {
    var x = o || {};
    return new Promise(function (resolve) {
      var back = $('vp-dialog');
      clear(back);
      back.onclick = null;
      var done = function (v) { back.hidden = true; clear(back); document.removeEventListener('keydown', onKey, true); resolve(v); };
      var onKey = function (e) { if (e.key === 'Escape') { e.preventDefault(); done(false); } };
      var ok = btn(okLabel, function () { done(true); }, { primary: !x.danger, danger: !!x.danger });
      back.appendChild(h('div', { class: 'vp-dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': x.title || text } }, [
        x.title ? h('h3', { text: x.title }) : null,
        h('p', { text: text }),
        h('div', { class: 'vp-actions' }, [btn(T('p.cancel'), function () { done(false); }), ok]),
      ]));
      back.hidden = false;
      document.addEventListener('keydown', onKey, true);
      ok.focus();
    });
  }

  /**
   * Copies text: first the old way (a hidden text area + execCommand, which works in a sandboxed frame during the
   * click), then navigator.clipboard (needs the host's permission). The frame cannot clear the clipboard later.
   */
  function copyText(text, label) {
    var value = String(text == null ? '' : text);
    if (!value) { toast(T('err.empty'), 'error'); return; }
    var ok = false;
    var ta = h('textarea', { class: 'vp-clip', attrs: { readonly: true, 'aria-hidden': 'true', tabindex: '-1' } });
    ta.value = value;
    document.body.appendChild(ta);
    try {
      ta.select();
      ta.setSelectionRange(0, value.length);
      ok = document.execCommand('copy');
    } catch (e) { ok = false; }
    ta.value = '';
    document.body.removeChild(ta);
    if (ok) { toast(T('p.copied', { label: label })); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () { toast(T('p.copied', { label: label })); }, function () { toast(T('p.copy_failed'), 'error'); });
      return;
    }
    toast(T('p.copy_failed'), 'error');
  }

  function saveFile(text, type, name) {
    if (!window.GC || typeof window.GC.saveFile !== 'function') { toast(T('p.save_unsupported'), 'error'); return Promise.resolve(false); }
    return window.GC.saveFile(new Blob([text], { type: type }), name).then(function () { return true; }, function () { toast(T('p.save_failed'), 'error'); return false; });
  }

  // ── API ──────────────────────────────────────────────────

  function codeErr(code, extra) { var e = new Error(code); e.code = code; e.extra = extra || null; return e; }

  function api(method, path, body) {
    if (!window.GC || typeof window.GC.call !== 'function') return Promise.reject(codeErr('network'));
    return window.GC.call(method, path, body).then(function (r) {
      if (!r || r.ok !== true) throw codeErr(L.errorCode(r) || 'invalid_answer', r);
      return r;
    }, function (e) {
      throw codeErr(L.failureCode(e), e && e.data);
    });
  }

  function errText(e) {
    var code = (e && e.code) || 'failed';
    var k = 'err.' + code;
    return CTX.texts && CTX.texts[k] ? T(k) : T('err.generic', { code: code });
  }

  // ── state ────────────────────────────────────────────────

  var S = {
    phase: 'loading',     // loading · login · failed · intro · setup · setup_key · locked · recover · recover_pw · recover_key · open
    account: null,
    keys: null,           // { userKey, publicKey, secretKey } — memory only
    vaultKeys: new Map(), // vault id → Map(keyRev → key)
    data: L.emptyState(),
    entries: [],          // decrypted: { id, vaultId, rev, keyRev, trashed, trashedAt, updatedAt, updatedBy, device, data }
    views: [],            // [{ vault, name }]
    unreadable: 0,
    decrypted: new Map(),
    epoch: 0,             // +1 on every lock / unlock: late answers of an earlier session are dropped
    lastInput: Date.now(),
    filter: { vaultId: 'all', query: '' },
    selected: null,
    pane: { kind: 'none' },
    reveal: {},
    setup: null,          // { body, keys, recoveryKey } before POST account
    newKey: null,         // a recovery key to show (after a recovery)
    people: null,
    emergency: null,      // an opened emergency access: { id, grantor, vaults, entries }
    busy: false,
    syncing: null,
  };

  var me = function () { var p = S.data.vaults.filter(function (v) { return v.kind === 'personal'; })[0]; return p ? p.ownerId : null; };
  var vaultOf = function (id) { return S.data.vaults.filter(function (v) { return v.id === id; })[0] || null; };
  var viewOf = function (id) { return S.views.filter(function (x) { return x.vault.id === id; })[0] || null; };
  function vaultName(id) {
    var x = viewOf(id);
    if (!x) return '…';
    return x.name || (x.vault.kind === 'personal' ? T('p.personal') : '…');
  }
  var entryOf = function (id) { return S.entries.filter(function (e) { return e.id === id; })[0] || null; };

  function keysOf(v) {
    if (!S.keys || !v) return new Map();
    var m = S.vaultKeys.get(v.id);
    if (!m) { m = new Map(); S.vaultKeys.set(v.id, m); }
    if (!m.has(v.keyRev)) { try { m.set(v.keyRev, VC.openSealed(v.sealedKey, S.keys.publicKey, S.keys.secretKey)); } catch (e) { /* not ours */ } }
    if (v.pending && v.pending.sealedKey && !m.has(v.pending.keyRev)) {
      try { m.set(v.pending.keyRev, VC.openSealed(v.pending.sealedKey, S.keys.publicKey, S.keys.secretKey)); } catch (e) { /* not ours */ }
    }
    return m;
  }
  function putKey(vaultId, keyRev, key) {
    var m = S.vaultKeys.get(vaultId);
    if (!m) { m = new Map(); S.vaultKeys.set(vaultId, m); }
    m.set(keyRev, Uint8Array.from(key));
  }

  function decryptBlob(v, id, rev, keyRev, blob) {
    var key = keysOf(v).get(keyRev);
    if (!key || !blob) return null;
    try { return L.normalizeEntry(VC.decryptItem(key, { id: id, vaultId: v.id, rev: rev, blob: blob })); } catch (e) { return null; }
  }

  /** The decrypted lists from the encrypted copy (an unchanged blob is not decrypted again). */
  function rebuild() {
    if (!S.keys) { S.entries = []; S.views = []; S.decrypted.clear(); S.unreadable = 0; return; }
    var byId = new Map(S.data.vaults.map(function (v) { return [v.id, v]; }));
    var views = [];
    S.data.vaults.forEach(function (v) {
      var key = keysOf(v).get(v.keyRev);
      if (!key) return;
      var name = null;
      try { name = VC.decryptName(key, v.id, v.nameEnc); } catch (e) { /* shown as … */ }
      views.push({ vault: v, name: name });
    });
    var out = [];
    var unreadable = 0;
    S.data.items.forEach(function (it) {
      var v = byId.get(it.vaultId);
      if (it.state === 'purged' || !v) return;
      var c = S.decrypted.get(it.id);
      var data = c && c.blob === it.blob ? c.data : decryptBlob(v, it.id, it.rev, it.keyRev, it.blob);
      if (!data) { unreadable++; return; }
      S.decrypted.set(it.id, { blob: it.blob, data: data });
      out.push({ id: it.id, vaultId: it.vaultId, rev: it.rev, keyRev: it.keyRev, trashed: it.state === 'trash', trashedAt: it.trashedAt, updatedAt: it.updatedAt, updatedBy: it.updatedBy, device: it.device, data: data });
    });
    var keep = new Set(out.map(function (e) { return e.id; }));
    Array.from(S.decrypted.keys()).forEach(function (id) { if (!keep.has(id)) S.decrypted.delete(id); });
    var coll = function (a, b) { return String(a || '').localeCompare(String(b || ''), 'de', { sensitivity: 'base' }); };
    S.views = views.sort(function (a, b) { return a.vault.kind === b.vault.kind ? coll(a.name, b.name) : a.vault.kind === 'personal' ? -1 : 1; });
    S.entries = out.sort(function (a, b) { return coll(a.data.title, b.data.title); });
    S.unreadable = unreadable;
    if (S.filter.vaultId && ['all', 'favorites', 'trash'].indexOf(S.filter.vaultId) < 0 && !byId.has(S.filter.vaultId)) S.filter.vaultId = 'all';
  }

  // ── session: lock, activity ──────────────────────────────

  function wipeAll() {
    if (S.keys) VC.wipe(S.keys);
    S.keys = null;
    S.vaultKeys.forEach(function (m) { VC.wipe(m); });
    S.vaultKeys.clear();
    if (S.setup) { VC.wipe(S.setup.keys); S.setup = null; }
    if (S.emergency) S.emergency = null;
    S.newKey = null;
    S.recovery = null;
    S.syncing = null;
    S.decrypted.clear();
    S.entries = [];
    S.views = [];
    S.data = L.emptyState();
    S.people = null;
    S.selected = null;
    S.pane = { kind: 'none' };
    S.reveal = {};
    S.filter = { vaultId: 'all', query: '' };
    S.epoch++;
  }

  /** Forget every key and everything decrypted; the DOM that showed it is emptied. */
  function lock(reason) {
    var had = !!(S.keys || S.setup);
    stopTicker();
    stopQr();
    wipeAll();
    ['vp-nav', 'vp-rows', 'vp-detail', 'vp-screen', 'vp-dialog'].forEach(function (id) { clear($(id)); });
    $('vp-dialog').hidden = true;
    $('vp-q').value = '';
    // a toast may name an entry or a person: gone with the rest
    clearTimeout(toastTimer);
    $('vp-toast').hidden = true;
    $('vp-toast').textContent = '';
    if (S.phase !== 'loading' && S.phase !== 'login' && S.phase !== 'failed') S.phase = S.account ? 'locked' : 'intro';
    S.lockReason = had ? reason : null;
    render();
  }

  function touch() { S.lastInput = Date.now(); }
  ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, touch, { capture: true, passive: true }); });
  setInterval(function () {
    // not while a recovery key is on screen: copying it down by hand may take longer (nothing is sent before
    // "Ich habe ihn sicher aufbewahrt"; closing the tab still locks)
    if (S.phase === 'setup_key' || S.phase === 'recover_key') return;
    if ((S.keys || S.setup) && Date.now() - S.lastInput >= LOCK_MS) lock('timeout');
  }, 5000);
  window.addEventListener('pagehide', function () { if (S.keys || S.setup) lock('closed'); });

  // ── sync ─────────────────────────────────────────────────

  /** Every page of GET sync from `since` (smaller pages when an answer is too large for the host). */
  function pull(vaultId, since, epoch) {
    var from = since;
    var limit = 200;
    var guard = 0;
    function step() {
      if (epoch !== S.epoch) return Promise.resolve(false);
      if (++guard > 1000) return Promise.reject(codeErr('failed'));
      var q = 'sync?since=' + from + '&limit=' + limit + (vaultId ? '&vault=' + encodeURIComponent(vaultId) : '');
      return api('GET', q).then(function (raw) {
        if (epoch !== S.epoch) return false;
        var page = L.parseSync(raw);
        if (!page) throw codeErr('invalid_answer');
        S.data = L.mergePage(S.data, page);
        if (page.account) S.account = page.account;
        if (!page.more && !vaultId) S.data.seq = page.next;
        if (!page.more) return true;
        from = page.next;
        return step();
      }, function (e) {
        if ((e.code === 'plugin_error' || e.code === 'failed') && limit > 5) { limit = Math.max(5, Math.floor(limit / 4)); return step(); }
        throw e;
      });
    }
    return step();
  }

  /** Fetch what changed (and the entries of vaults shared since), then redraw. One at a time. */
  function syncAll() {
    // a sync started before a lock belongs to that session: a new one runs for this one
    if (S.syncing && S.syncing.epoch === S.epoch) return S.syncing.promise;
    var epoch = S.epoch;
    var run = { epoch: epoch, promise: null };
    S.syncing = run;
    run.promise = pull(null, S.data.seq, epoch).then(function (ok) {
      if (!ok) return false;
      var fresh = (S.data.fresh || []).slice();
      return fresh.reduce(function (p, id) {
        return p.then(function (go) {
          if (!go || !vaultOf(id)) return go;
          return pull(id, 0, epoch).then(function (done) {
            if (done) S.data = Object.assign({}, S.data, { fresh: S.data.fresh.filter(function (x) { return x !== id; }) });
            return done;
          });
        });
      }, Promise.resolve(true));
    }).then(function (ok) {
      if (ok && epoch === S.epoch) { rebuild(); refresh(); }
      return ok;
    }, function (e) {
      if (epoch === S.epoch && e.code === 'no_account') { S.account = null; lock('account'); }
      throw e;
    }).finally(function () { if (S.syncing === run) S.syncing = null; });
    return run.promise;
  }

  setInterval(function () { if (S.keys && S.phase === 'open' && !document.hidden) syncAll().catch(function () { /* next round */ }); }, SYNC_EVERY_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S.keys && S.phase === 'open') syncAll().catch(function () {}); });

  // ── entries: save, trash, history ────────────────────────

  /**
   * Saves `data` as entry `id` on top of `baseRev` into `vaultId` (another vault moves it), encrypted with the key
   * a save must use now. stale_key → sync and encrypt again, once. conflict → the newer version goes into the copy
   * and the error carries it (extra.current).
   */
  function saveEntry(id, vaultId, data, baseRev) {
    var epoch = S.epoch;
    var tries = 0;
    function attempt() {
      if (epoch !== S.epoch) return Promise.reject(codeErr('locked'));
      var v = vaultOf(vaultId);
      if (!v) return Promise.reject(codeErr('not_found'));
      if (!L.canWrite(v)) return Promise.reject(codeErr('read_only'));
      var keyRev = L.wantedKeyRev(v);
      var key = keysOf(v).get(keyRev);
      if (!key) {
        if (tries++ === 0) return syncAll().then(attempt);
        return Promise.reject(codeErr('locked'));
      }
      var blob;
      try { blob = VC.encryptItem(key, { vaultId: vaultId, itemId: id, rev: baseRev + 1 }, data); } catch (e) { return Promise.reject(codeErr(e.code === 'too_large' ? 'too_large' : 'invalid')); }
      var sent = { id: id, vaultId: vaultId, blob: blob, keyRev: keyRev, baseRev: baseRev };
      return api('POST', 'items', { items: [sent], device: DEVICE }).then(function (raw) {
        if (epoch !== S.epoch) throw codeErr('locked');
        var res = (L.parseSaveResults(raw) || [])[0];
        if (!res) throw codeErr('invalid_answer');
        var echoed = !res.ok && res.code === 'conflict' && res.current && res.current.blob === blob;
        if (res.ok || echoed) {
          S.data = L.savedItem(S.data, sent, echoed ? { rev: res.current.rev, seq: res.current.seq } : res, { updatedAt: new Date().toISOString(), updatedBy: me(), device: DEVICE });
          rebuild();
          return { id: id };
        }
        if (res.code === 'stale_key' && tries++ === 0) return syncAll().then(attempt);
        if (res.code === 'conflict' && res.current) {
          S.data = L.putItem(S.data, res.current);
          rebuild();
          throw codeErr('conflict', { current: res.current });
        }
        throw codeErr(res.code || 'failed');
      });
    }
    return attempt();
  }

  /** New entries (import) in batches ≤ 48 KB / ≤ 100 → { saved, failed }; stale_key → sync, encrypt again, once. */
  function saveMany(vaultId, list, onProgress) {
    var epoch = S.epoch;
    var saved = 0;
    var failed = 0;
    var total = list.length;
    function encryptAll(items) {
      var v = vaultOf(vaultId);
      if (!v || !L.canWrite(v)) throw codeErr('read_only');
      var keyRev = L.wantedKeyRev(v);
      var key = keysOf(v).get(keyRev);
      if (!key) throw codeErr('locked');
      var out = [];
      items.forEach(function (x) {
        try { out.push({ data: x.data, save: { id: x.id, vaultId: vaultId, blob: VC.encryptItem(key, { vaultId: vaultId, itemId: x.id, rev: 1 }, x.data), keyRev: keyRev, baseRev: 0 } }); } catch (e) { failed++; }
      });
      return out;
    }
    function run(items, again) {
      var prepared = encryptAll(items);
      var stale = [];
      var groups = L.batches(prepared.map(function (p) { return p.save; }));
      var byId = new Map(prepared.map(function (p) { return [p.save.id, p]; }));
      return groups.reduce(function (p, batch) {
        return p.then(function () {
          if (epoch !== S.epoch) throw codeErr('locked');
          return api('POST', 'items', { items: batch, device: DEVICE }).then(function (raw) {
            var results = L.parseSaveResults(raw) || [];
            var got = new Map(results.map(function (r) { return [r.id, r]; }));
            batch.forEach(function (sent) {
              var r = got.get(sent.id);
              if (r && r.ok) { saved++; S.data = L.savedItem(S.data, sent, r, { updatedAt: new Date().toISOString(), updatedBy: me(), device: DEVICE }); }
              else if (r && r.code === 'stale_key' && !again) stale.push({ id: sent.id, data: byId.get(sent.id).data });
              else failed++;
            });
            if (onProgress) onProgress(saved + failed, total);
          }, function (e) {
            if (e.code === 'locked') throw e;
            failed += batch.length;
            if (onProgress) onProgress(saved + failed, total);
          });
        });
      }, Promise.resolve()).then(function () {
        if (!stale.length) return null;
        return syncAll().then(function () { return run(stale, true); });
      });
    }
    return run(list.map(function (d) { return { id: VC.newId(), data: d }; }), false).then(function () {
      rebuild();
      return { saved: saved, failed: failed };
    });
  }

  function itemCall(method, path) {
    var epoch = S.epoch;
    return api(method, path, method === 'POST' ? {} : undefined).then(function (raw) {
      if (epoch !== S.epoch) throw codeErr('locked');
      var item = L.parseItem(raw.item);
      if (!item) throw codeErr('invalid_answer');
      S.data = L.putItem(S.data, item);
      rebuild();
      return item;
    });
  }

  /** The earlier versions (≤ 10), decrypted → [{ rev, updatedAt, updatedBy, device, data }]. */
  function history(id) {
    var it = S.data.items.get(id);
    var v = it ? vaultOf(it.vaultId) : null;
    if (!it || !v) return Promise.reject(codeErr('not_found'));
    var epoch = S.epoch;
    return api('GET', 'items/' + encodeURIComponent(id) + '/history').then(function (raw) {
      if (epoch !== S.epoch) throw codeErr('locked');
      var list = L.parseHistory(raw);
      if (!list) throw codeErr('invalid_answer');
      return list.map(function (x) { return { rev: x.rev, updatedAt: x.updatedAt, updatedBy: x.updatedBy, device: x.device, data: decryptBlob(v, id, x.rev, x.keyRev, x.blob) }; })
        .filter(function (x) { return x.data; });
    });
  }

  // ── vaults, people ───────────────────────────────────────

  function applyVault(raw) {
    var v = L.parseVault(raw);
    if (!v) throw codeErr('invalid_answer');
    S.data = L.putVault(S.data, v);
    rebuild();
    return v;
  }

  function dropVault(id) {
    var m = S.vaultKeys.get(id);
    if (m) VC.wipe(m);
    S.vaultKeys.delete(id);
    S.data = L.dropVault(S.data, id);
    rebuild();
  }

  function cleanName(name) {
    var n = String(name || '').trim();
    if (!n || n.length > 200) throw codeErr('invalid');
    return n;
  }

  function createVault(name) {
    var n = cleanName(name);
    var id = VC.newId();
    var key = VC.newVaultKey();
    var epoch = S.epoch;
    return api('POST', 'vaults', { id: id, nameEnc: VC.encryptName(key, id, n), sealedKey: VC.sealKey(key, S.keys.publicKey) }).then(function (raw) {
      if (epoch !== S.epoch) throw codeErr('locked');
      var v = L.parseVault(raw.vault);
      if (!v) throw codeErr('invalid_answer');
      putKey(id, v.keyRev, key);
      S.data = L.putVault(S.data, v);
      rebuild();
      return v;
    }).finally(function () { VC.wipe(key); });
  }

  function renameVault(id, name) {
    var n = cleanName(name);
    var v = vaultOf(id);
    var key = v ? keysOf(v).get(v.keyRev) : null;
    if (!key) return Promise.reject(codeErr('locked'));
    if (v.pending) return Promise.reject(codeErr('rekeying'));
    return api('PUT', 'vaults/' + encodeURIComponent(id), { nameEnc: VC.encryptName(key, id, n) }).then(function (raw) { return applyVault(raw.vault); });
  }

  /** Everyone one could share with → [{ id, name, publicKey, safety }] (the safety number of their key). */
  function loadPeople() {
    return api('GET', 'people').then(function (raw) {
      var list = L.parsePeople(raw);
      if (!list) throw codeErr('invalid_answer');
      S.people = list.map(function (p) {
        var safety = null;
        if (p.publicKey) { try { safety = VC.safetyNumber(p.publicKey); } catch (e) { safety = null; } }
        return { id: p.id, name: p.name, publicKey: safety ? p.publicKey : null, safety: safety };
      });
      return S.people;
    });
  }

  function addMember(vaultId, person, role) {
    var v = vaultOf(vaultId);
    var key = v ? keysOf(v).get(v.keyRev) : null;
    if (!key) return Promise.reject(codeErr('locked'));
    if (v.pending) return Promise.reject(codeErr('rekeying'));
    if (!person.publicKey) return Promise.reject(codeErr('no_account'));
    return api('POST', 'vaults/' + encodeURIComponent(vaultId) + '/members', { userId: person.id, role: role, sealedKey: VC.sealKey(key, person.publicKey) })
      .then(function (raw) { return applyVault(raw.vault); });
  }

  // ── account: setup, unlock, recovery, password ───────────

  function loadAccount() {
    return api('GET', 'account').then(function (raw) {
      var a = L.parseAccountAnswer(raw);
      if (!a) throw codeErr('invalid_answer');
      S.account = a.account;
      return a.account;
    });
  }

  /** Keys are open: fetch everything, show the app. */
  function opened(keys) {
    wipeAll();
    S.keys = keys;
    S.lastInput = Date.now();
    S.phase = 'open';
    S.data = Object.assign(L.emptyState(), { account: S.account });
    render();
    return syncAll().catch(function (e) { toast(errText(e), 'error'); });
  }

  /**
   * A copy of the user key for a KDF path (changePassword, recover): lock() zeroes S.keys in place while Argon2id
   * runs (the page stays responsive), and a body wrapping 32 zero bytes must never be sent. The caller wipes it.
   */
  function userKeyCopy() {
    if (!S.keys) throw codeErr('locked');
    return { userKey: S.keys.userKey.slice() };
  }

  /**
   * PUT account with a body made in the session `epoch` — refused (locked) when the tab was locked meanwhile. A
   * stale rev (another device changed the account): once more on top of the current one; the wrapping does not
   * depend on rev.
   */
  function putAccount(body, epoch) {
    var tries = 0;
    function attempt(b) {
      if (epoch !== S.epoch || !S.keys || !S.account) return Promise.reject(codeErr('locked'));
      return api('PUT', 'account', b).then(function (raw) {
        var acc = L.parseAccount(raw.account);
        if (!acc) throw codeErr('invalid_answer');
        S.account = acc;
        if (epoch !== S.epoch) throw codeErr('locked');
        return acc;
      }, function (e) {
        var cur = e.code === 'conflict' && e.extra ? L.parseAccount(e.extra.account) : null;
        if (!cur || tries++ > 0) throw e;
        S.account = cur;
        return attempt(Object.assign({}, b, { rev: cur.rev }));
      });
    }
    return attempt(body);
  }

  // ── rendering: top level ─────────────────────────────────

  var appHeight = function () {
    var sh = (window.screen && window.screen.availHeight) || 900;
    return Math.max(560, Math.min(980, sh - 230));
  };

  function render() {
    var phase = S.phase;
    $('vp-login').hidden = phase !== 'login';
    var screen = $('vp-screen');
    var app = $('vp-app');
    if (phase === 'open') {
      screen.hidden = true;
      clear(screen);
      app.hidden = false;
      app.style.setProperty('--vp-h', appHeight() + 'px');
      $('vp-cols').setAttribute('data-pane', S.pane.kind === 'none' ? 'list' : 'detail');
      refresh();
      return;
    }
    app.hidden = true;
    clear($('vp-nav')); clear($('vp-rows')); clear($('vp-detail'));
    screen.hidden = phase === 'login';
    clear(screen);
    var body = ({
      loading: screenLoading, failed: screenFailed, intro: screenIntro, setup: screenSetup, setup_key: screenSetupKey,
      locked: screenLocked, recover: screenRecover, recover_pw: screenRecoverPw, recover_key: screenRecoverKey,
    }[phase] || screenLoading)();
    screen.appendChild(body);
    var f = screen.querySelector('[data-autofocus]');
    if (f) f.focus();
  }

  function card(kids, cls) { return h('div', { class: 'vp-card' + (cls ? ' ' + cls : '') }, kids); }
  function heroIcon(name) { return h('div', { class: 'vp-hero-ic' }, [icon(name, 30)]); }

  function screenLoading() { return card([h('p', { class: 'vp-muted', text: T('p.loading') })], 'vp-center'); }

  function screenFailed() {
    return card([heroIcon('alert'), h('h2', { text: T('p.unavailable') }), h('p', { class: 'vp-muted', text: S.failText || '' }), btn(T('p.retry'), boot, { primary: true })], 'vp-center');
  }

  function screenIntro() {
    return card([
      heroIcon('shield'),
      h('h2', { text: T('p.intro_title') }),
      h('p', { class: 'vp-muted', text: T('p.intro_text') }),
      btn(T('p.intro_start'), function () { S.phase = 'setup'; render(); }, { primary: true }),
    ], 'vp-center');
  }

  /** Password + repeat with the strength meter; → { node, value(), ok() } */
  function masterFields(labels, onChange) {
    var pw = h('input', { type: 'password', class: 'vp-input', attrs: { autocomplete: 'new-password', 'data-autofocus': true, spellcheck: 'false' } });
    var rep = h('input', { type: 'password', class: 'vp-input', attrs: { autocomplete: 'new-password', spellcheck: 'false' } });
    var meter = h('div', { class: 'vp-meter', attrs: { 'aria-hidden': 'true' } }, [h('span'), h('span'), h('span'), h('span')]);
    var strengthTx = h('span', { class: 'vp-hint' });
    var hint = h('span', { class: 'vp-hint' });
    var showBtn = ibtn('eye', T('p.reveal'), function () {
      var show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      rep.type = pw.type;
    });
    function update() {
      var v = pw.value;
      var s = v ? L.passwordStrength(v) : null;
      var level = { weak: 1, fair: 2, strong: 3, very_strong: 4 }[s] || 0;
      meter.className = 'vp-meter is-' + level;
      strengthTx.textContent = v ? T('strength.' + s) + ' · ' + T('strength.chars', { chars: Array.from(v).length }) : '';
      var c = L.masterCheck(v, rep.value);
      hint.textContent = c.hint ? T('setup.' + c.hint) : '';
      hint.className = 'vp-hint' + (c.hint === 'pw_match' ? ' is-good' : c.hint ? ' is-bad' : '');
      if (onChange) onChange(c.ok);
    }
    pw.addEventListener('input', update);
    rep.addEventListener('input', update);
    var node = h('div', { class: 'vp-form' }, [
      h('label', { class: 'vp-field' }, [h('span', { class: 'vp-label', text: labels[0] }), h('span', { class: 'vp-pw' }, [pw, showBtn]), meter, strengthTx]),
      inputRow(labels[1], rep, null),
      hint,
    ]);
    return { node: node, value: function () { return pw.value; }, ok: function () { return L.masterCheck(pw.value, rep.value).ok; }, clear: function () { pw.value = ''; rep.value = ''; } };
  }

  function progressBar() {
    var bar = h('div', { class: 'vp-progress', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' } }, [h('span')]);
    bar.set = function (f) {
      var pct = Math.round(Math.max(0, Math.min(1, f)) * 100);
      bar.firstChild.style.width = pct + '%';
      bar.setAttribute('aria-valuenow', String(pct));
    };
    return bar;
  }

  function screenSetup() {
    var err = h('p', { class: 'vp-err', attrs: { role: 'alert' } });
    var status = h('p', { class: 'vp-muted', hidden: true });
    var bar = progressBar();
    bar.hidden = true;
    var next;
    var m = masterFields([T('setup.pw_label'), T('setup.pw_repeat')], function (ok) { next.disabled = !ok || S.busy; });
    next = btn(T('p.next'), function () {
      if (!m.ok() || S.busy) return;
      S.busy = true;
      next.disabled = true;
      err.textContent = '';
      status.hidden = false;
      status.textContent = T('setup.creating');
      bar.hidden = false;
      var epoch = S.epoch;
      VC.createAccount(m.value(), T('p.personal'), { onProgress: bar.set }).then(function (made) {
        S.busy = false;
        m.clear();
        if (epoch !== S.epoch) { VC.wipe(made.keys); return; }
        S.setup = made;
        S.phase = 'setup_key';
        render();
      }, function (e) {
        S.busy = false;
        status.hidden = true;
        bar.hidden = true;
        next.disabled = false;
        err.textContent = errText(e);
      });
    }, { primary: true, disabled: true });
    return card([
      h('span', { class: 'vp-step', text: T('setup.step', { n: 1, total: 2 }) }),
      h('h2', { text: T('setup.pw_title') }),
      h('p', { class: 'vp-muted', text: T('setup.pw_text') }),
      m.node,
      notice('warn', T('setup.warn_title'), h('span', { class: 'vp-muted', text: ' ' + T('setup.warn_text') })),
      status, bar, err,
      h('div', { class: 'vp-actions' }, [btn(T('p.cancel'), function () { if (!S.busy) { S.phase = 'intro'; render(); } }), next]),
    ], 'vp-narrow');
  }

  /** The recovery key with Kopieren, Als Textdatei speichern and the "kept it" check → { node } */
  function recoveryKeyBlock(key, onConfirm, confirmLabel) {
    var groups = L.recoveryGroups(key);
    var done = btn(confirmLabel, function () { if (check.checked) onConfirm(done); }, { primary: true, disabled: true });
    var check = h('input', { type: 'checkbox', on: { change: function () { done.disabled = !check.checked; } } });
    var fileText = [
      T('rk.file_title'), '', key, '', T('rk.file_text'), T('rk.file_date', { date: new Date().toLocaleDateString(LOCALE) }), '',
    ].join('\r\n');
    return h('div', { class: 'vp-form' }, [
      h('div', { class: 'vp-rk', attrs: { 'aria-label': T('rk.label') } }, groups.map(function (g) { return h('span', { text: g }); })),
      h('div', { class: 'vp-actions vp-actions-left' }, [
        btn(T('p.copy'), function () { copyText(key, T('rk.label')); }, { icon: 'copy' }),
        btn(T('rk.save_file'), function () { saveFile(fileText, 'text/plain', T('rk.file_name')); }, { icon: 'key' }),
      ]),
      h('ul', { class: 'vp-tips' }, [h('li', { text: T('rk.tip1') }), h('li', { text: T('rk.tip2') }), h('li', { text: T('rk.tip3') })]),
      h('label', { class: 'vp-check' }, [check, h('span', { text: T('rk.confirm') })]),
      h('div', { class: 'vp-actions' }, [done]),
    ]);
  }

  function screenSetupKey() {
    var made = S.setup;
    if (!made) { S.phase = 'intro'; return screenIntro(); }
    var err = h('p', { class: 'vp-err', attrs: { role: 'alert' } });
    return card([
      h('span', { class: 'vp-step', text: T('setup.step', { n: 2, total: 2 }) }),
      h('h2', { text: T('rk.title') }),
      h('p', { class: 'vp-muted', text: T('rk.text') }),
      recoveryKeyBlock(made.recoveryKey, function (button) {
        if (S.busy) return;
        S.busy = true;
        button.disabled = true;
        err.textContent = '';
        var epoch = S.epoch;
        api('POST', 'account', made.body).then(function (raw) {
          S.busy = false;
          if (epoch !== S.epoch) return;
          var acc = L.parseAccount(raw.account);
          if (!acc) throw codeErr('invalid_answer');
          S.account = acc;
          S.setup = null;
          var k = made.keys;
          opened({ userKey: k.userKey, publicKey: k.publicKey, secretKey: k.secretKey }).then(function () {
            VC.wipe(k.personalKey);
          });
          putKey(made.body.personal.id, 1, k.personalKey);
        }).catch(function (e) {
          S.busy = false;
          button.disabled = false;
          if (e.code === 'exists') {
            VC.wipe(made.keys);
            S.setup = null;
            toast(T('setup.exists'), 'error');
            loadAccount().then(function () { S.phase = S.account ? 'locked' : 'intro'; render(); }, function () { S.phase = 'intro'; render(); });
            return;
          }
          err.textContent = errText(e);
        });
      }, T('setup.finish')),
      err,
      h('div', { class: 'vp-actions' }, [btn(T('p.cancel'), function () { if (!S.busy) { lock('cancel'); } })]),
    ], 'vp-narrow');
  }

  function screenLocked() {
    var pw = h('input', { type: 'password', class: 'vp-input', attrs: { autocomplete: 'current-password', 'data-autofocus': true, 'aria-label': T('unlock.password') } });
    var err = h('p', { class: 'vp-err', attrs: { role: 'alert' } });
    var bar = progressBar();
    bar.hidden = true;
    var go = btn(T('unlock.button'), submit, { primary: true });
    function submit() {
      if (S.busy || !pw.value) return;
      S.busy = true;
      go.disabled = true;
      err.textContent = '';
      bar.hidden = false;
      bar.set(0);
      var value = pw.value;
      var acc = S.account;
      var epoch = S.epoch;
      VC.unlock(acc, value, { onProgress: bar.set }).catch(function (e) {
        if (!e || e.code !== 'decrypt') throw e;
        // changed on another device meanwhile? ask once
        return loadAccount().then(function (a) {
          if (!a) throw codeErr('no_account');
          if (a.rev === acc.rev) throw codeErr('wrong_password');
          bar.set(0);
          return VC.unlock(a, value, { onProgress: bar.set }).catch(function () { throw codeErr('wrong_password'); });
        });
      }).then(function (keys) {
        S.busy = false;
        pw.value = '';
        value = '';
        if (epoch !== S.epoch) { VC.wipe(keys); return; }
        opened(keys);
      }, function (e) {
        S.busy = false;
        value = '';
        go.disabled = false;
        bar.hidden = true;
        if (e.code === 'no_account') { S.account = null; S.phase = 'intro'; render(); return; }
        err.textContent = errText(e);
        pw.select();
      });
    }
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    return card([
      heroIcon('lock'),
      h('h2', { text: T('unlock.title') }),
      S.lockReason === 'timeout' ? h('p', { class: 'vp-muted', text: T('unlock.timed_out') }) : null,
      h('p', { class: 'vp-muted', text: T('p.session_note') }),
      h('div', { class: 'vp-form' }, [inputRow(T('unlock.password'), pw, null), bar, err, h('div', { class: 'vp-actions' }, [go])]),
      h('button', { type: 'button', class: 'vp-link', text: T('unlock.forgot'), on: { click: function () { if (!S.busy) { S.phase = 'recover'; render(); } } } }),
    ], 'vp-center vp-narrow');
  }

  function screenRecover() {
    var input = h('textarea', { class: 'vp-input vp-mono', rows: 3, attrs: { autocomplete: 'off', spellcheck: 'false', 'data-autofocus': true, 'aria-label': T('recover.key') } });
    var err = h('p', { class: 'vp-err', attrs: { role: 'alert' } });
    var go = btn(T('p.next'), function () {
      err.textContent = '';
      if (!L.recoveryComplete(input.value)) { err.textContent = T('recover.typo'); return; }
      var keys;
      try { keys = VC.unlockWithRecovery(S.account, input.value); } catch (e) {
        err.textContent = T(e && e.code === 'recovery_key' ? 'err.recovery_key' : 'err.wrong_recovery');
        return;
      }
      input.value = '';
      wipeAll();
      S.keys = keys;
      S.lastInput = Date.now();
      S.phase = 'recover_pw';
      render();
    }, { primary: true });
    return card([
      h('h2', { text: T('recover.title') }),
      h('p', { class: 'vp-muted', text: T('recover.text') }),
      h('div', { class: 'vp-form' }, [inputRow(T('recover.key'), input, null), err]),
      h('div', { class: 'vp-actions' }, [btn(T('p.back'), function () { S.phase = 'locked'; render(); }), go]),
    ], 'vp-narrow');
  }

  function screenRecoverPw() {
    var err = h('p', { class: 'vp-err', attrs: { role: 'alert' } });
    var bar = progressBar();
    bar.hidden = true;
    var go;
    var m = masterFields([T('recover.new_pw'), T('setup.pw_repeat')], function (ok) { go.disabled = !ok || S.busy; });
    go = btn(T('p.save'), function () {
      if (!m.ok() || S.busy) return;
      S.busy = true;
      go.disabled = true;
      err.textContent = '';
      bar.hidden = false;
      var value = m.value();
      var epoch = S.epoch;
      var k;
      // only made here: PUT account follows once the new recovery key was shown and kept (screenRecoverKey) —
      // the old one stays valid until then
      Promise.resolve().then(function () {
        k = userKeyCopy();
        bar.set(0);
        return VC.recover(S.account, k, value, { onProgress: bar.set });
      }).finally(function () { if (k) VC.wipe(k); }).then(function (r) {
        S.busy = false;
        value = '';
        m.clear();
        if (epoch !== S.epoch || !S.keys) return;
        S.recovery = { body: r.body };
        S.newKey = r.recoveryKey;
        S.phase = 'recover_key';
        render();
      }, function (e) {
        S.busy = false;
        go.disabled = false;
        bar.hidden = true;
        err.textContent = errText(e);
      });
    }, { primary: true, disabled: true });
    return card([
      h('h2', { text: T('recover.new_pw') }),
      h('p', { class: 'vp-muted', text: T('recover.new_pw_text') }),
      m.node, bar, err,
      h('div', { class: 'vp-actions' }, [btn(T('p.cancel'), function () { if (!S.busy) lock('cancel'); }), go]),
    ], 'vp-narrow');
  }

  function screenRecoverKey() {
    var key = S.newKey;
    if (!key || !S.keys || !S.recovery) { S.phase = 'locked'; return screenLocked(); }
    var err = h('p', { class: 'vp-err', attrs: { role: 'alert' } });
    return card([
      h('h2', { text: T('recover.new_key_title') }),
      h('p', { class: 'vp-muted', text: T('rk.text') }),
      recoveryKeyBlock(key, function (button) {
        if (S.busy) return;
        S.busy = true;
        button.disabled = true;
        err.textContent = '';
        var epoch = S.epoch;
        // now the new password and the new recovery key take effect (the old key stops working)
        putAccount(S.recovery.body, epoch).then(function () {
          S.busy = false;
          if (epoch !== S.epoch) return;
          S.newKey = null;
          S.recovery = null;
          var keys = S.keys;
          S.keys = null;
          opened(keys);
        }, function (e) {
          S.busy = false;
          button.disabled = false;
          err.textContent = errText(e);
        });
      }, T('rk.done')),
      err,
      h('div', { class: 'vp-actions' }, [btn(T('p.cancel'), function () { if (!S.busy) lock('cancel'); })]),
    ], 'vp-narrow');
  }

  // ── rendering: the app ───────────────────────────────────

  /** Redraw nav and list; the detail pane only when it shows an entry (forms keep what is typed). */
  function refresh() {
    if (S.phase !== 'open') return;
    renderNav();
    renderList();
    if (['none', 'entry'].indexOf(S.pane.kind) >= 0) renderDetail();
  }

  function setPane(kind, extra) {
    S.pane = Object.assign({ kind: kind }, extra || {});
    S.reveal = {};
    $('vp-cols').setAttribute('data-pane', kind === 'none' ? 'list' : 'detail');
    renderDetail();
    renderNav();
    var d = $('vp-detail');
    if (d.scrollTop) d.scrollTop = 0;
  }

  function navItem(label, count, active, onClick, ic) {
    return h('button', { type: 'button', class: 'vp-nav-it', attrs: { 'aria-current': active ? 'true' : null }, on: { click: onClick } }, [
      ic ? icon(ic, 16) : null, h('span', { class: 'vp-nav-l', text: label }), count == null ? null : h('span', { class: 'vp-nav-c', text: String(count) }),
    ]);
  }

  function counts() {
    var c = { all: 0, favorites: 0, trash: 0, byVault: {} };
    S.entries.forEach(function (e) {
      if (e.trashed) { c.trash++; return; }
      c.all++;
      if (e.data.fav) c.favorites++;
      c.byVault[e.vaultId] = (c.byVault[e.vaultId] || 0) + 1;
    });
    return c;
  }

  function pickFilter(id) {
    S.filter.vaultId = id;
    S.selected = null;
    S.emergency = null;
    setPane('none');
    renderList();
  }

  function renderNav() {
    var nav = $('vp-nav');
    clear(nav);
    if (S.emergency) {
      var em = S.emergency;
      nav.appendChild(h('div', { class: 'vp-nav-h', text: T('em.view_title', { name: em.grantor.name }) }));
      nav.appendChild(navItem(T('p.all'), em.entries.filter(function (e) { return !e.trashed; }).length, S.filter.vaultId === 'all', function () { S.filter.vaultId = 'all'; renderNav(); renderList(); }));
      em.vaults.forEach(function (v) {
        nav.appendChild(navItem(v.name || (v.kind === 'personal' ? T('p.personal') : '…'), em.entries.filter(function (e) { return !e.trashed && e.vaultId === v.id; }).length, S.filter.vaultId === v.id, function () { S.filter.vaultId = v.id; renderNav(); renderList(); }));
      });
      nav.appendChild(h('div', { class: 'vp-nav-sep' }));
      nav.appendChild(navItem(T('em.close_view'), null, false, function () { closeEmergencyView(); }, 'back'));
      return;
    }
    var c = counts();
    var f = S.filter.vaultId;
    nav.appendChild(h('div', { class: 'vp-nav-h', text: T('p.vaults') }));
    nav.appendChild(navItem(T('p.all'), c.all, f === 'all', function () { pickFilter('all'); }));
    if (c.favorites) nav.appendChild(navItem(T('p.favorites'), c.favorites, f === 'favorites', function () { pickFilter('favorites'); }));
    S.views.forEach(function (x) {
      nav.appendChild(navItem(vaultName(x.vault.id), c.byVault[x.vault.id] || 0, f === x.vault.id, function () { pickFilter(x.vault.id); }));
    });
    nav.appendChild(navItem(T('p.trash'), c.trash, f === 'trash', function () { pickFilter('trash'); }, 'trash'));
    nav.appendChild(h('div', { class: 'vp-nav-sep' }));
    var k = S.pane.kind;
    nav.appendChild(navItem(T('p.manage_vaults'), null, k === 'vaults' || k === 'vault', function () { setPane('vaults'); }, 'users'));
    nav.appendChild(navItem(T('p.emergency'), null, k === 'emergency', function () { setPane('emergency'); }, 'lifebuoy'));
    nav.appendChild(navItem(T('p.import_export'), null, k === 'transfer', function () { setPane('transfer'); }, 'swap'));
    nav.appendChild(navItem(T('p.change_pw'), null, k === 'password', function () { setPane('password'); }, 'key'));
  }

  function avatar(title, big) {
    return h('span', { class: 'vp-av vp-tone-' + L.tone(title) + (big ? ' is-big' : ''), attrs: { 'aria-hidden': 'true' }, text: L.letter(title) });
  }

  function currentList() {
    if (S.emergency) {
      return S.emergency.entries.map(L.entrySummary).filter(function (e) { return !e.trashed; });
    }
    return S.entries.map(L.entrySummary);
  }

  function renderList() {
    var rows = $('vp-rows');
    clear(rows);
    var q = $('vp-q');
    var f = S.filter.vaultId;
    var placeholder = f === 'all' || f === 'favorites' || S.emergency ? T('p.search') : f === 'trash' ? T('p.search_in', { name: T('p.trash') }) : T('p.search_in', { name: vaultName(f) });
    q.placeholder = placeholder;
    q.setAttribute('aria-label', placeholder);
    var writable = S.views.some(function (x) { return L.canWrite(x.vault); });
    $('vp-new').hidden = !!S.emergency || !writable || f === 'trash';
    var banner = $('vp-list-banner');
    clear(banner);
    banner.hidden = true;
    if (S.emergency) {
      banner.hidden = false;
      banner.appendChild(notice('info', T('em.read_only')));
    } else if (S.unreadable) {
      banner.hidden = false;
      banner.appendChild(notice('warn', P('p.unreadable', S.unreadable)));
    }
    var sections = L.listSections(currentList(), { vaultId: S.emergency && ['all'].indexOf(f) < 0 && !S.emergency.vaults.some(function (v) { return v.id === f; }) ? 'all' : f, query: S.filter.query });
    var total = sections.reduce(function (n, s) { return n + s.items.length; }, 0);
    if (!total) {
      rows.appendChild(h('p', { class: 'vp-empty', text: S.filter.query ? T('p.no_results') : f === 'trash' ? T('trash.empty') : T('p.empty') }));
      return;
    }
    sections.forEach(function (s) {
      if (sections.length > 1 || s.key === 'favorites') rows.appendChild(h('div', { class: 'vp-rows-h', text: T('p.section_' + s.key) }));
      var box = h('div', { class: 'vp-rows-box' });
      s.items.forEach(function (e) {
        box.appendChild(h('button', {
          type: 'button', class: 'vp-row', attrs: { role: 'listitem', 'aria-current': S.selected === e.id && S.pane.kind !== 'none' ? 'true' : null },
          on: { click: function () { S.selected = e.id; setPane('entry', { id: e.id }); renderList(); } },
        }, [
          avatar(e.title),
          h('span', { class: 'vp-row-tx' }, [h('span', { class: 'vp-row-t', text: e.title || T('p.untitled') }), h('span', { class: 'vp-row-s', text: e.sub || T('type.' + e.type) })]),
          e.fav ? h('span', { class: 'vp-row-fav', attrs: { 'aria-label': T('fav.on') } }, [icon('star', 14)]) : null,
        ]));
      });
      rows.appendChild(box);
    });
  }

  function paneHead(title, back) {
    return h('div', { class: 'vp-pane-head' }, [
      h('button', { type: 'button', class: 'vp-ib vp-back', attrs: { 'aria-label': T('p.back'), title: T('p.back') }, on: { click: back || function () { S.selected = null; setPane('none'); renderList(); } } }, [icon('back', 18)]),
      h('h2', { text: title }),
    ]);
  }

  function renderDetail() {
    var d = $('vp-detail');
    clear(d);
    stopTicker();
    stopQr();
    var k = S.pane.kind;
    var node;
    if (k === 'entry') node = paneEntry(S.pane.id);
    else if (k === 'edit') node = paneEdit();
    else if (k === 'history') node = paneHistory(S.pane.id);
    else if (k === 'vaults') node = paneVaults();
    else if (k === 'vault') node = paneVault(S.pane.id);
    else if (k === 'emergency') node = paneEmergency();
    else if (k === 'transfer') node = paneTransfer();
    else if (k === 'password') node = panePassword();
    else node = h('div', { class: 'vp-placeholder' }, [heroIcon('shield'), h('b', { text: T('p.pick_title') }), h('span', { class: 'vp-muted', text: T('p.pick_text') })]);
    d.appendChild(node);
    var f = d.querySelector('[data-autofocus]');
    if (f) f.focus();
  }

  // ── detail of an entry ───────────────────────────────────

  var ticker = null;
  function stopTicker() { clearInterval(ticker); ticker = null; }
  function startTicker(fn) { stopTicker(); fn(); ticker = setInterval(fn, 1000); }

  function totpRow(label, value) {
    var p = L.parseTotp(value);
    var code = h('span', { class: 'vp-code' });
    var left = h('span', { class: 'vp-hint' });
    var ring = h('span', { class: 'vp-ring' });
    if (!p) return fieldRow(label, h('span', { class: 'vp-hint is-bad', text: T('totp.invalid') }), []);
    var cur = '';
    startTicker(function () {
      var c = L.totpCode(p, Date.now());
      cur = c.code;
      code.textContent = L.prettyCode(c.code);
      left.textContent = T('totp.left', { seconds: c.secondsLeft });
      ring.style.setProperty('--vp-left', String(c.secondsLeft / c.period));
    });
    return fieldRow(label, h('span', { class: 'vp-totp' }, [code, ring, left]), [ibtn('copy', T('p.copy_label', { label: label }), function () { copyText(cur, label); })]);
  }

  function fieldRow(label, valueNode, actions) {
    return h('div', { class: 'vp-frow' }, [h('span', { class: 'vp-flabel', text: label }), h('span', { class: 'vp-fval' }, [valueNode]), h('span', { class: 'vp-facts' }, actions || [])]);
  }

  function secretRow(revealKey, label, value, o) {
    var x = o || {};
    var shown = !!S.reveal[revealKey];
    var val = h('span', { class: 'vp-secret' + (shown ? ' is-shown' : ''), text: shown ? value : (x.card ? L.maskedNumber(value) : L.mask(value)) });
    var toggle = ibtn(shown ? 'eyeOff' : 'eye', shown ? T('p.conceal') : T('p.reveal'), function () {
      S.reveal[revealKey] = !S.reveal[revealKey];
      var now = !!S.reveal[revealKey];
      val.textContent = now ? value : (x.card ? L.maskedNumber(value) : L.mask(value));
      val.className = 'vp-secret' + (now ? ' is-shown' : '');
      clear(toggle);
      toggle.appendChild(icon(now ? 'eyeOff' : 'eye', 16));
      toggle.setAttribute('aria-label', now ? T('p.conceal') : T('p.reveal'));
      toggle.setAttribute('title', now ? T('p.conceal') : T('p.reveal'));
    }, { pressed: shown });
    return fieldRow(label, val, [toggle, ibtn('copy', T('p.copy_label', { label: label }), function () { copyText(value, label); })]);
  }

  function plainRow(label, value, multiline) {
    return fieldRow(label, h('span', { class: multiline ? 'vp-pre' : '', text: value }), [ibtn('copy', T('p.copy_label', { label: label }), function () { copyText(value, label); })]);
  }

  /** The rows of an entry's fields, URLs, apps, custom fields and notes (read view, also in history). */
  function entryRows(data, prefix) {
    var rows = [];
    var fields = data.fields || {};
    var defs = L.FIELDS[data.type] || [];
    var known = new Set();
    defs.forEach(function (f) {
      known.add(f.key);
      var v = fields[f.key];
      if (!v) return;
      var label = T('field.' + f.key);
      if (f.totp) rows.push(prefix ? secretRow(prefix + ':' + f.key, label, v) : totpRow(label, v));
      else if (f.secret) rows.push(secretRow(prefix + ':' + f.key, label, v, { card: f.key === 'number' }));
      else rows.push(plainRow(label, v, f.multiline));
    });
    // fields of another type (the type was changed in an app) stay visible
    Object.keys(fields).forEach(function (k) {
      if (known.has(k) || !fields[k]) return;
      var label = CTX.texts['field.' + k] ? T('field.' + k) : k;
      if (/password|pin|cvc|totp|number/.test(k)) rows.push(secretRow(prefix + ':' + k, label, fields[k]));
      else rows.push(plainRow(label, fields[k]));
    });
    (data.urls || []).forEach(function (u, i) {
      rows.push(fieldRow(i ? '' : T('field.url'), h('span', { class: 'vp-url', text: u, attrs: { title: L.openableUrl(u) || u } }), [ibtn('copy', T('p.copy_label', { label: T('field.url') }), function () { copyText(u, T('field.url')); })]));
    });
    (data.apps || []).forEach(function (a, i) { rows.push(plainRow(i ? '' : T('field.apps'), a)); });
    (data.custom || []).forEach(function (c, i) {
      var label = c.name || T('custom.unnamed');
      rows.push(c.secret ? secretRow(prefix + ':custom:' + i, label, c.value) : plainRow(label, c.value, c.value.indexOf('\n') >= 0));
    });
    if (data.notes) rows.push(fieldRow(T('field.notes'), h('span', { class: 'vp-pre', text: data.notes }), [ibtn('copy', T('p.copy_label', { label: T('field.notes') }), function () { copyText(data.notes, T('field.notes')); })]));
    return rows;
  }

  function wifiQr(data) {
    var text = L.wifiQrText(data);
    var m = text ? L.qrMatrix(text) : null;
    if (!m) return null;
    var holder = h('div', { class: 'vp-qr' });
    var showBtn = btn(T('wifi.show_qr'), function () {
      clear(holder);
      var b = 2;
      var size = m.size + b * 2;
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
      svg.setAttribute('width', '168');
      svg.setAttribute('height', '168');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', T('wifi.qr_label'));
      svg.setAttribute('shape-rendering', 'crispEdges');
      var bg = document.createElementNS(NS, 'rect');
      bg.setAttribute('width', String(size)); bg.setAttribute('height', String(size)); bg.setAttribute('fill', '#ffffff');
      svg.appendChild(bg);
      var d = '';
      for (var y = 0; y < m.size; y++) for (var x = 0; x < m.size; x++) if (m.data[y][x]) d += 'M' + (x + b) + ' ' + (y + b) + 'h1v1h-1z';
      var path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', '#000000');
      svg.appendChild(path);
      holder.appendChild(svg);
      holder.appendChild(h('span', { class: 'vp-hint', text: T('wifi.qr_hint') }));
      showBtn.hidden = true;
    }, { icon: 'grid', small: true });
    return h('div', { class: 'vp-qr-box' }, [holder, showBtn]);
  }

  var PRIMARY = { login: 'password', wifi: 'password', card: 'number', totp: 'totp' };

  function paneEntry(id) {
    var e = S.emergency ? S.emergency.entries.filter(function (x) { return x.id === id; })[0] : entryOf(id);
    if (!e) return h('div', { class: 'vp-placeholder' }, [h('span', { class: 'vp-muted', text: T('err.not_found') })]);
    var d = e.data;
    var v = S.emergency ? null : vaultOf(e.vaultId);
    var writable = !S.emergency && L.canWrite(v);
    var sub = S.emergency ? T('em.read_only_short') : vaultName(e.vaultId) + (v && v.kind === 'shared' ? ' · ' + P('p.shared_with', Math.max(0, v.members.length - 1)) : '');
    var head = h('div', { class: 'vp-ehead' }, [
      h('button', { type: 'button', class: 'vp-ib vp-back', attrs: { 'aria-label': T('p.back'), title: T('p.back') }, on: { click: function () { S.selected = null; setPane('none'); renderList(); } } }, [icon('back', 18)]),
      avatar(d.title, true),
      h('div', { class: 'vp-ehead-tx' }, [h('h2', { text: d.title || T('p.untitled') }), h('span', { class: 'vp-muted', text: T('type.' + d.type) + ' · ' + sub })]),
      writable && !e.trashed ? ibtn('star', d.fav ? T('fav.remove') : T('fav.add'), function () { toggleFav(e); }, { on: !!d.fav, pressed: !!d.fav }) : null,
      writable && !e.trashed ? btn(T('p.edit'), function () { startEdit(e); }, { icon: 'edit', small: true }) : null,
      !writable && !S.emergency ? h('span', { class: 'vp-tag', text: T('p.read_only') }) : null,
    ]);
    var kids = [head];
    if (e.trashed) {
      kids.push(notice('warn', T('trash.info'), writable ? h('div', { class: 'vp-actions vp-actions-left' }, [
        btn(T('trash.restore'), function () { act(itemCall('POST', 'items/' + encodeURIComponent(e.id) + '/restore'), T('trash.restored')); }, { small: true }),
        btn(T('trash.purge'), function () {
          ask(T('trash.purge_confirm', { title: d.title }), T('trash.purge'), { danger: true }).then(function (yes) {
            if (yes) act(itemCall('DELETE', 'items/' + encodeURIComponent(e.id)).then(function () { S.selected = null; setPane('none'); }), T('trash.purged'));
          });
        }, { small: true, danger: true }),
      ]) : null));
    }
    var grid = h('div', { class: 'vp-fields' }, entryRows(d, ''));
    var body = h('div', { class: 'vp-ebody' }, [grid, d.type === 'wifi' ? wifiQr(d) : null]);
    kids.push(body);
    var primaryKey = PRIMARY[d.type];
    var primaryVal = primaryKey ? (d.fields || {})[primaryKey] : '';
    var actions = [];
    if (primaryVal) {
      var pLabel = T('field.' + primaryKey);
      actions.push(btn(T('p.copy_label', { label: pLabel }), function () {
        if (primaryKey === 'totp') {
          var p = L.parseTotp(primaryVal);
          if (p) copyText(L.totpCode(p, Date.now()).code, pLabel); else toast(T('totp.invalid'), 'error');
        } else copyText(primaryVal, pLabel);
      }, { primary: true, icon: 'copy' }));
    }
    if (actions.length) kids.push(h('div', { class: 'vp-actions vp-actions-left' }, actions));
    var meta = fmtWhen(e.updatedAt);
    var metaText = !meta ? vaultName(e.vaultId) : e.device ? T('p.changed', { vault: S.emergency ? '' : vaultName(e.vaultId), when: meta, device: e.device }) : T('p.changed_short', { vault: S.emergency ? '' : vaultName(e.vaultId), when: meta });
    kids.push(h('div', { class: 'vp-meta' }, [
      h('span', { class: 'vp-muted', text: metaText.replace(/^ · /, '') }),
      !S.emergency ? h('button', { type: 'button', class: 'vp-link', text: T('history.link'), on: { click: function () { setPane('history', { id: e.id }); } } }) : null,
      writable && !e.trashed ? h('button', { type: 'button', class: 'vp-link is-danger', text: T('trash.action'), on: { click: function () {
        act(itemCall('POST', 'items/' + encodeURIComponent(e.id) + '/trash').then(function () { S.selected = null; setPane('none'); }), T('trash.moved', { title: d.title }));
      } } }) : null,
    ]));
    return h('div', { class: 'vp-pane' }, kids);
  }

  /** Runs an action, shows its outcome; redraws the app. */
  function act(promise, okText) {
    return promise.then(function (r) {
      if (okText) toast(okText);
      refresh();
      return r;
    }, function (e) {
      toast(errText(e), 'error');
      refresh();
      throw e;
    }).catch(function () { return null; });
  }

  function toggleFav(e) {
    var data = L.normalizeEntry(Object.assign({}, e.data, { fav: !e.data.fav }));
    act(saveEntry(e.id, e.vaultId, data, e.rev), null).then(function () { renderDetail(); });
  }

  // ── edit ─────────────────────────────────────────────────

  function startEdit(e) {
    var draft = L.draftFrom(e);
    setPane('edit', { draft: draft, orig: L.draftFrom(e), baseRev: e.rev, conflict: null });
  }

  function startNew(type) {
    var f = S.filter.vaultId;
    var target = vaultOf(f) && L.canWrite(vaultOf(f)) ? f : null;
    if (!target) {
      var w = S.views.filter(function (x) { return L.canWrite(x.vault); })[0];
      target = w ? w.vault.id : null;
    }
    var draft = L.emptyDraft(type || 'login', target);
    setPane('edit', { draft: draft, orig: L.emptyDraft(type || 'login', target), baseRev: 0, conflict: null });
  }

  // ── 2FA key from a QR code (1.2.0) ───────────────────────
  //
  // A picture — chosen, pasted with Ctrl+V or dropped — → a canvas → its pixels → VaultNoble.qrDecode (jsQR, bundled
  // in ui/vendor/noble.js) → L.qrTotp. All of it stays in this frame: the picture is drawn once, read and dropped
  // (bitmap closed, pixels zeroed, canvas emptied, file input reset). A result that comes after a lock (S.epoch) or
  // after its panel was closed (pane changed, field closed) is dropped. The frame itself gets no camera: Chromium
  // refuses getUserMedia to a sandboxed frame without allow-same-origin (its origin is opaque: "SecurityError: Invalid
  // security origin").
  //
  // 1.3.0 — „Mit Kamera scannen“: GateControl ≥ 1.196.0 (plugin.json ui.scanQr) reads the code in its own camera
  // dialog (window.GC.scanQr) and hands this frame only the text — otpauth:// or otpauth-migration:// (the dialog
  // keeps scanning past other codes). The text goes through the same L.qrTotp / account choice as a picture, and the
  // same rule: an answer that comes after a lock or after the panel was closed is dropped. The button is only there
  // when the host has GC.scanQr.

  var MAX_QR_IMAGE_BYTES = 25 * 1024 * 1024;
  var QR_SIDES = [1280, 2560]; // a picture is read with its longer side at most this (big screenshots: small codes)
  var qrRun = null; // the open panel: { stop() }

  function stopQr() {
    var r = qrRun;
    qrRun = null;
    if (r) r.stop();
  }

  /** A picture (w × hh pixels) → the text of the QR code in it, or null. */
  function qrFromPicture(src, w, hh) {
    var N = window.VaultNoble;
    if (!(w > 0 && hh > 0) || !N || typeof N.qrDecode !== 'function') throw new Error('unreadable');
    var c = document.createElement('canvas');
    try {
      for (var i = 0; i < QR_SIDES.length; i++) {
        var scale = Math.min(1, QR_SIDES[i] / Math.max(w, hh));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(hh * scale));
        c.width = cw;
        c.height = ch;
        var g = c.getContext('2d', { willReadFrequently: true });
        if (!g) throw new Error('unreadable');
        g.drawImage(src, 0, 0, cw, ch);
        var img = g.getImageData(0, 0, cw, ch);
        var code = N.qrDecode(img.data, cw, ch, { inversionAttempts: 'attemptBoth' });
        img.data.fill(0);
        if (code && typeof code.data === 'string' && code.data) return code.data;
        if (scale === 1) break;
      }
      return null;
    } finally {
      c.width = 0;
      c.height = 0;
    }
  }

  /** A picture file → something to draw (ImageBitmap; an <img> from a data: URL where there is no createImageBitmap). */
  function bitmapOf(file) {
    if (typeof window.createImageBitmap === 'function') return window.createImageBitmap(file);
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var img = new Image();
        img.onload = function () { img.onload = img.onerror = null; resolve(img); };
        img.onerror = function () { img.onload = img.onerror = null; reject(new Error('unreadable')); };
        img.src = String(fr.result);
      };
      fr.onerror = function () { reject(new Error('unreadable')); };
      fr.readAsDataURL(file);
    });
  }
  function dropBitmap(b) {
    try { if (b && typeof b.close === 'function') b.close(); else if (b) b.src = ''; } catch (e) { /* gone */ }
  }

  /** GateControl reads QR codes with its own camera dialog (GC.scanQr, GateControl ≥ 1.196.0). */
  function hostScan() { return !!(window.GC && typeof window.GC.scanQr === 'function'); }
  var CAMERA_ERR = { denied: 'qr.camera_denied', no_camera: 'qr.camera_none', insecure: 'qr.camera_insecure', timeout: 'qr.camera_timeout' };
  var CAMERA_QUIET = ['cancelled', 'hidden', 'busy', 'rate_limited', 'no_gesture'];

  function qrErrText(code) {
    if (code === 'hotp') return T('qr.hotp');
    if (code === 'invalid') return T('qr.invalid');
    if (code === 'too_big') return T('qr.too_many');
    return T('qr.none');
  }

  /** The panel under the 2FA field → onResult({ uri, title, account }) once a usable code was read. */
  function qrPanel(onResult) {
    stopQr();
    var epoch = S.epoch;
    var run = { stop: null };
    var busy = false;
    var alive = function () { return qrRun === run && epoch === S.epoch; };
    var status = h('p', { class: 'vp-hint', attrs: { role: 'status', 'aria-live': 'polite' } });
    var choices = h('div', { class: 'vp-qr-pick', hidden: true });
    var file = h('input', { type: 'file', hidden: true, attrs: { accept: 'image/*', 'aria-hidden': 'true', tabindex: '-1' } });

    function say(text, bad) {
      status.textContent = text || '';
      status.className = 'vp-hint' + (bad ? ' is-bad' : '');
    }
    function finish(r) {
      stopQr();
      onResult({ uri: r.uri, title: r.title || null, account: r.account || null });
    }
    function showChoices(r) {
      clear(choices);
      choices.appendChild(h('p', { class: 'vp-hint', text: T('qr.pick_account') }));
      if (r.batchSize > 1) choices.appendChild(h('p', { class: 'vp-hint', text: T('qr.batch', { index: r.batchIndex + 1, count: r.batchSize }) }));
      r.entries.forEach(function (x) {
        var name = [x.issuer, x.account].filter(Boolean).join(' · ') || T('type.totp');
        choices.appendChild(h('button', { type: 'button', class: 'vp-qr-choice', disabled: !x.uri, on: { click: function () { if (alive() && x.uri) finish(x); } } }, [
          h('span', { class: 'vp-qr-choice-n', text: name }),
          x.uri ? null : h('span', { class: 'vp-hint is-bad', text: x.code === 'hotp' ? T('qr.hotp_short') : T('qr.unsupported') }),
        ]));
      });
      choices.hidden = false;
      say('');
    }
    /** The text a QR code held (null: none found). */
    function handle(text) {
      clear(choices);
      choices.hidden = true;
      if (text == null) { say(T('qr.none'), true); return; }
      var r = L.qrTotp(text);
      if (r.kind === 'totp') { finish(r); return; }
      if (r.kind === 'migration') {
        var usable = r.entries.filter(function (x) { return x.uri; });
        if (r.entries.length === 1 && usable.length === 1) { finish(usable[0]); return; }
        showChoices(r);
        return;
      }
      say(qrErrText(r.code), true);
    }
    function readFile(f) {
      if (!f || busy || !alive()) return;
      file.value = '';
      if (f.type && !/^image\//i.test(f.type)) { say(T('qr.unreadable'), true); return; }
      if (f.size > MAX_QR_IMAGE_BYTES) { say(T('qr.too_large'), true); return; }
      busy = true;
      say(T('qr.reading'));
      bitmapOf(f).then(function (bmp) {
        try {
          if (!alive()) return { gone: true };
          return { text: qrFromPicture(bmp, bmp.width || bmp.naturalWidth, bmp.height || bmp.naturalHeight) };
        } finally {
          dropBitmap(bmp);
        }
      }).then(function (res) {
        busy = false;
        if (res.gone || !alive()) return;
        handle(res.text);
      }, function () {
        busy = false;
        if (alive()) say(T('qr.unreadable'), true);
      });
    }
    /** The first picture of a DataTransferItemList (kind 'file') or a FileList. */
    function imageOf(list) {
      for (var i = 0; list && i < list.length; i++) {
        var it = list[i];
        if (!it || !/^image\//i.test(it.type || '')) continue;
        if (it.kind === 'file' && typeof it.getAsFile === 'function') return it.getAsFile();
        if (it.kind === undefined) return it;
      }
      return null;
    }
    function onPaste(e) {
      if (!alive()) return;
      var cd = e.clipboardData;
      var f = cd ? imageOf(cd.items) || imageOf(cd.files) : null;
      if (!f) return; // text goes where it was pasted
      e.preventDefault();
      readFile(f);
    }
    // a file dropped anywhere in the tab while the panel is open (the browser would try to open it instead); dragged
    // text still goes into the field it is dropped on
    function hasFiles(dt) {
      var t = dt && dt.types;
      for (var i = 0; t && i < t.length; i++) if (t[i] === 'Files') return true;
      return false;
    }
    function onDragOver(e) {
      if (!alive() || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
    function onDrop(e) {
      var dt = e.dataTransfer;
      if (!alive() || !hasFiles(dt)) return;
      e.preventDefault();
      var f = imageOf(dt.files) || imageOf(dt.items);
      if (f) readFile(f);
      else say(T('qr.unreadable'), true);
    }

    // „Mit Kamera scannen“ (1.3.0): GateControl's dialog → the text → the same handling as a picture
    run.camera = function () {
      if (busy || !alive() || !hostScan()) return;
      busy = true;
      clear(choices);
      choices.hidden = true;
      say(T('qr.camera_open'));
      var done = function (r) {
        busy = false;
        if (!alive()) return; // locked or closed meanwhile: the text is dropped unread
        if (r && typeof r.text === 'string' && r.text) { handle(r.text); return; }
        var code = r && r.code;
        if (!code || CAMERA_QUIET.indexOf(code) >= 0) { say(''); return; }
        say(T(CAMERA_ERR[code] || 'qr.camera_failed'), true);
      };
      var p;
      try { p = window.GC.scanQr({ hint: T('qr.camera_hint'), accept: ['otpauth://', 'otpauth-migration://'] }); } catch (e) { p = null; }
      Promise.resolve(p).then(done, function () { done(null); });
    };
    run.stop = function () {
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
      file.value = '';
      file.onchange = null;
      clear(choices);
    };
    qrRun = run;
    document.addEventListener('paste', onPaste);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    file.onchange = function () { readFile(file.files && file.files[0]); };

    return h('div', { class: 'vp-gen vp-qr-panel' }, [
      h('div', { class: 'vp-actions vp-actions-left' }, [btn(T('qr.pick'), function () { if (!busy) { file.value = ''; file.click(); } }, { small: true, icon: 'image' })]),
      h('span', { class: 'vp-hint', text: T('qr.paste_hint') }),
      choices,
      status,
      h('span', { class: 'vp-hint', text: T('qr.privacy') }),
      file,
    ]);
  }

  function genPanel(onUse) {
    var opts = { words: false, length: 20, upper: true, digits: true, symbols: true, avoidAmbiguous: false, wordCount: 4 };
    var out = h('input', { type: 'text', class: 'vp-input vp-mono', readOnly: true, attrs: { 'aria-label': T('gen.title'), spellcheck: 'false' } });
    var strength = h('span', { class: 'vp-hint' });
    var lenLabel = h('span', { class: 'vp-label' });
    var range = h('input', { type: 'range', class: 'vp-range' });
    function regen() {
      out.value = L.generatePassword(opts);
      strength.textContent = T('strength.' + L.passwordStrength(out.value)) + ' · ' + T('strength.chars', { chars: Array.from(out.value).length });
      lenLabel.textContent = opts.words ? T('gen.word_count', { n: opts.wordCount }) : T('gen.length', { n: opts.length });
      range.min = opts.words ? 3 : 8;
      range.max = opts.words ? 8 : 64;
      range.value = String(opts.words ? opts.wordCount : opts.length);
    }
    range.addEventListener('input', function () { if (opts.words) opts.wordCount = Number(range.value); else opts.length = Number(range.value); regen(); });
    function check(key, label) {
      var c = h('input', { type: 'checkbox', checked: opts[key], on: { change: function () { opts[key] = c.checked; regen(); } } });
      return h('label', { class: 'vp-check', attrs: { 'data-chars': true } }, [c, h('span', { text: label })]);
    }
    var modeSel = h('select', { class: 'vp-input', attrs: { 'aria-label': T('gen.mode') }, on: { change: function () { opts.words = modeSel.value === 'words'; charOpts.hidden = opts.words; regen(); } } }, [
      h('option', { value: 'random', text: T('gen.random') }), h('option', { value: 'words', text: T('gen.words') }),
    ]);
    var charOpts = h('div', { class: 'vp-gen-opts' }, [check('upper', T('gen.upper')), check('digits', T('gen.digits')), check('symbols', T('gen.symbols')), check('avoidAmbiguous', T('gen.ambiguous'))]);
    regen();
    return h('div', { class: 'vp-gen' }, [
      h('div', { class: 'vp-gen-out' }, [out, ibtn('refresh', T('gen.again'), regen)]),
      strength,
      h('div', { class: 'vp-gen-row' }, [modeSel, h('div', { class: 'vp-gen-len' }, [lenLabel, range])]),
      charOpts,
      h('div', { class: 'vp-actions vp-actions-left' }, [btn(T('gen.use'), function () { onUse(out.value); }, { primary: true, small: true })]),
    ]);
  }

  function paneEdit() {
    var p = S.pane;
    var dr = p.draft;
    var isNew = !dr.id;
    var err = h('p', { class: 'vp-err', attrs: { role: 'alert' } });
    var conflictBox = h('div');
    var writable = S.views.filter(function (x) { return L.canWrite(x.vault); });
    var typeSel = h('select', { class: 'vp-input', on: { change: function () { dr.type = typeSel.value; if (dr.type === 'login' && !dr.urls.length) dr.urls = ['']; renderDetail(); } } },
      L.TYPES.map(function (t) { return h('option', { value: t, text: T('type.' + t), selected: dr.type === t }); }));
    var vaultSel = h('select', { class: 'vp-input', on: { change: function () { dr.vaultId = vaultSel.value; } } },
      writable.map(function (x) { return h('option', { value: x.vault.id, text: vaultName(x.vault.id), selected: dr.vaultId === x.vault.id }); }));
    if (!dr.vaultId && writable[0]) dr.vaultId = writable[0].vault.id;
    var title = h('input', { type: 'text', class: 'vp-input', value: dr.title, attrs: { maxlength: '300', 'data-autofocus': isNew ? true : null }, on: { input: function () { dr.title = title.value; } } });
    var form = [
      h('div', { class: 'vp-grid2' }, [inputRow(T('edit.type'), typeSel), inputRow(T('field.vault'), vaultSel)]),
      inputRow(T('field.title'), title),
    ];
    var inputs = {};
    (L.FIELDS[dr.type] || []).forEach(function (f) {
      var val = dr.fields[f.key] || '';
      var label = f.totp ? T('field.totp_secret') : T('field.' + f.key);
      var input;
      if (f.multiline) {
        input = h('textarea', { class: 'vp-input', rows: 3, value: val, on: { input: function () { dr.fields[f.key] = input.value; } } });
        form.push(inputRow(label, input));
        return;
      }
      input = h('input', { type: f.secret && !f.totp ? 'password' : 'text', class: 'vp-input' + (f.secret ? ' vp-mono' : ''), value: val, attrs: { autocomplete: 'off', spellcheck: 'false', 'aria-label': f.totp ? label : null }, on: { input: function () {
        dr.fields[f.key] = input.value;
        if (f.totp) {
          tHint.textContent = input.value.trim() && !L.parseTotp(input.value) ? T('totp.invalid') : '';
          var lbl = L.totpLabel(input.value);
          if (lbl && !dr.title.trim()) { dr.title = lbl; title.value = lbl; }
        }
      } } });
      var tHint = h('span', { class: 'vp-hint is-bad' });
      inputs[f.key] = input;
      if (f.totp) {
        // 1.2.0: the key from a QR code (picture or screenshot) instead of typing it
        var qrBox = h('div', { hidden: true });
        var closeQr = function () { stopQr(); clear(qrBox); qrBox.hidden = true; };
        var openQr = function () {
          qrBox.appendChild(qrPanel(function (r) {
            closeQr();
            input.value = r.uri;
            dr.fields[f.key] = r.uri;
            tHint.textContent = '';
            if (r.title && !dr.title.trim()) { dr.title = r.title; title.value = r.title; }
            if (dr.type === 'login' && r.account && inputs.username && !String(dr.fields.username || '').trim()) {
              dr.fields.username = r.account;
              inputs.username.value = r.account;
            }
            toast(T('qr.applied'));
          }));
          qrBox.hidden = false;
        };
        var qrBtn = btn(T('qr.from_image'), function () {
          if (!qrBox.hidden) { closeQr(); return; }
          openQr();
        }, { small: true, icon: 'qr' });
        // 1.3.0: GateControl's camera dialog (only when the host has GC.scanQr); the panel shows the outcome
        var camBtn = hostScan() ? btn(T('qr.camera'), function () {
          if (qrBox.hidden) openQr();
          if (qrRun && qrRun.camera) qrRun.camera();
        }, { small: true, icon: 'camera' }) : null;
        form.push(h('div', { class: 'vp-field' }, [h('span', { class: 'vp-label', text: label }), h('span', { class: 'vp-pw vp-totp-in' }, [input, qrBtn, camBtn]), tHint, qrBox]));
      } else if (f.secret) {
        var genBox = h('div', { hidden: true });
        var row = h('span', { class: 'vp-pw' }, [input,
          ibtn('eye', T('p.reveal'), function () { input.type = input.type === 'password' ? 'text' : 'password'; }),
          f.key === 'password' ? ibtn('dice', T('gen.title'), function () {
            genBox.hidden = !genBox.hidden;
            if (!genBox.hidden && !genBox.firstChild) genBox.appendChild(genPanel(function (pw) { input.value = pw; dr.fields[f.key] = pw; input.type = 'text'; genBox.hidden = true; }));
          }) : null,
        ]);
        form.push(h('div', { class: 'vp-field' }, [h('span', { class: 'vp-label', text: label }), row, genBox]));
      } else {
        form.push(h('label', { class: 'vp-field' }, [h('span', { class: 'vp-label', text: label }), input]));
      }
    });
    if (dr.type === 'login' || dr.urls.length) {
      var urlBox = h('div', { class: 'vp-list-edit' });
      var drawUrls = function () {
        clear(urlBox);
        dr.urls.forEach(function (u, i) {
          var inp = h('input', { type: 'text', class: 'vp-input', value: u, attrs: { inputmode: 'url', autocomplete: 'off', spellcheck: 'false', 'aria-label': T('field.url') }, on: { input: function () { dr.urls[i] = inp.value; } } });
          urlBox.appendChild(h('div', { class: 'vp-pw' }, [inp, ibtn('close', T('edit.remove_url'), function () { dr.urls.splice(i, 1); drawUrls(); })]));
        });
        urlBox.appendChild(btn(T('edit.add_url'), function () { dr.urls.push(''); drawUrls(); }, { icon: 'plus', small: true, ghost: true }));
      };
      drawUrls();
      form.push(h('div', { class: 'vp-field' }, [h('span', { class: 'vp-label', text: T('field.urls') }), urlBox]));
    }
    var notes = h('textarea', { class: 'vp-input', rows: dr.type === 'note' ? 8 : 3, value: dr.notes, on: { input: function () { dr.notes = notes.value; } } });
    form.push(inputRow(T('field.notes'), notes));
    var customBox = h('div', { class: 'vp-list-edit' });
    var drawCustom = function () {
      clear(customBox);
      dr.custom.forEach(function (c, i) {
        var n = h('input', { type: 'text', class: 'vp-input', value: c.name, placeholder: T('custom.name'), attrs: { 'aria-label': T('custom.name') }, on: { input: function () { c.name = n.value; } } });
        var val = h('input', { type: c.secret ? 'password' : 'text', class: 'vp-input', value: c.value, placeholder: T('custom.value'), attrs: { 'aria-label': T('custom.value'), autocomplete: 'off', spellcheck: 'false' }, on: { input: function () { c.value = val.value; } } });
        var sec = h('input', { type: 'checkbox', checked: c.secret, on: { change: function () { c.secret = sec.checked; val.type = c.secret ? 'password' : 'text'; } } });
        customBox.appendChild(h('div', { class: 'vp-custom' }, [n, val, h('label', { class: 'vp-check' }, [sec, h('span', { text: T('custom.secret') })]), ibtn('close', T('custom.remove'), function () { dr.custom.splice(i, 1); drawCustom(); })]));
      });
      customBox.appendChild(btn(T('custom.add'), function () { dr.custom.push({ name: '', value: '', secret: false }); drawCustom(); }, { icon: 'plus', small: true, ghost: true }));
    };
    drawCustom();
    form.push(h('div', { class: 'vp-field' }, [h('span', { class: 'vp-label', text: T('custom.title') }), customBox]));
    var fav = h('input', { type: 'checkbox', checked: dr.fav, on: { change: function () { dr.fav = fav.checked; } } });
    form.push(h('label', { class: 'vp-check' }, [fav, h('span', { text: T('fav.label') })]));

    var saveBtn;
    function doSave(baseRev, asCopy) {
      var problem = L.draftError(dr);
      if (problem) { err.textContent = T(problem); return; }
      var data = L.draftToData(dr);
      if (!data) { err.textContent = T('err.invalid'); return; }
      var id = dr.id;
      var base = baseRev;
      if (asCopy) {
        id = null;
        base = 0;
        data.title = (data.title + ' ' + T('edit.conflict_suffix')).trim();
      }
      if (!id) id = VC.newId();
      saveBtn.disabled = true;
      err.textContent = '';
      saveEntry(id, dr.vaultId, data, base).then(function () {
        toast(T('edit.saved'));
        S.selected = id;
        setPane('entry', { id: id });
        refresh();
      }, function (e) {
        saveBtn.disabled = false;
        if (e.code === 'conflict' && e.extra && e.extra.current) {
          p.baseRev = e.extra.current.rev;
          clear(conflictBox);
          conflictBox.appendChild(notice('warn', T('edit.conflict'), h('div', { class: 'vp-actions vp-actions-left' }, [
            btn(T('edit.overwrite'), function () { clear(conflictBox); doSave(p.baseRev, false); }, { small: true }),
            btn(T('edit.save_copy'), function () { clear(conflictBox); doSave(0, true); }, { small: true }),
          ])));
          refresh();
          return;
        }
        err.textContent = errText(e);
      });
    }
    saveBtn = btn(T('p.save'), function () { doSave(p.baseRev, false); }, { primary: true });
    var cancel = function () {
      var leave = function () { if (dr.id) setPane('entry', { id: dr.id }); else { S.selected = null; setPane('none'); } renderList(); };
      if (!L.draftChanged(dr, p.orig)) { leave(); return; }
      ask(T('edit.discard_title'), T('edit.discard'), { danger: true }).then(function (yes) { if (yes) leave(); });
    };
    return h('div', { class: 'vp-pane' }, [
      paneHead(isNew ? T('new.' + dr.type) : T('edit.title'), cancel),
      conflictBox,
      h('div', { class: 'vp-form' }, form),
      err,
      h('div', { class: 'vp-actions' }, [btn(T('p.cancel'), cancel), saveBtn]),
    ]);
  }

  // ── history ──────────────────────────────────────────────

  function paneHistory(id) {
    var e = entryOf(id);
    var box = h('div', { class: 'vp-hist' }, [h('p', { class: 'vp-muted', text: T('p.loading') })]);
    var writable = e && L.canWrite(vaultOf(e.vaultId));
    var epoch = S.epoch;
    history(id).then(function (list) {
      if (epoch !== S.epoch || S.pane.kind !== 'history' || S.pane.id !== id) return;
      clear(box);
      if (!list.length) { box.appendChild(h('p', { class: 'vp-muted', text: T('history.empty') })); return; }
      list.forEach(function (x) {
        var meta = [fmtWhen(x.updatedAt), x.device].filter(Boolean).join(' · ');
        var detail = h('div', { class: 'vp-fields', hidden: true }, entryRows(x.data, 'h' + x.rev));
        var toggle = btn(T('history.show'), function () { detail.hidden = !detail.hidden; toggle.lastChild.textContent = detail.hidden ? T('history.show') : T('history.hide'); }, { small: true, ghost: true });
        box.appendChild(h('div', { class: 'vp-hist-it' }, [
          h('div', { class: 'vp-hist-head' }, [
            h('div', { class: 'vp-hist-tx' }, [h('b', { text: T('history.version', { rev: x.rev }) + ' · ' + (x.data.title || T('p.untitled')) }), h('span', { class: 'vp-muted', text: meta })]),
            toggle,
            writable ? btn(T('history.restore'), function () {
              var cur = entryOf(id);
              if (!cur) return;
              act(saveEntry(id, cur.vaultId, x.data, cur.rev).then(function () { setPane('entry', { id: id }); }), T('history.restored'));
            }, { small: true }) : null,
          ]),
          detail,
        ]));
      });
    }, function (err) {
      clear(box);
      box.appendChild(h('p', { class: 'vp-err', text: errText(err) }));
    });
    return h('div', { class: 'vp-pane' }, [paneHead(T('history.title') + (e ? ' · ' + (e.data.title || '') : ''), function () { setPane('entry', { id: id }); }), box]);
  }

  // ── vaults and sharing ───────────────────────────────────

  function roleSelect(value, onChange, disabled) {
    var s = h('select', { class: 'vp-input vp-input-sm', disabled: disabled, attrs: { 'aria-label': T('share.role') }, on: { change: function () { onChange(s.value); } } },
      L.ROLES.map(function (r) { return h('option', { value: r, text: T('role.' + r), selected: r === value }); }));
    return s;
  }

  function paneVaults() {
    var name = h('input', { type: 'text', class: 'vp-input', placeholder: T('vaults.name_hint'), attrs: { maxlength: '200', 'aria-label': T('vaults.name') } });
    var create = btn(T('p.create'), function () {
      create.disabled = true;
      act(Promise.resolve().then(function () { return createVault(name.value); }).then(function (v) { setPane('vault', { id: v.id }); }), null).then(function () { create.disabled = false; });
    }, { primary: true });
    var mySafety = '';
    try { mySafety = VC.safetyNumber(S.keys.publicKey); } catch (e) { mySafety = ''; }
    return h('div', { class: 'vp-pane' }, [
      paneHead(T('vaults.title')),
      h('div', { class: 'vp-vlist' }, S.views.map(function (x) {
        var v = x.vault;
        var info = [v.kind === 'personal' ? T('vaults.personal') : T('vaults.shared') + ' · ' + P('vaults.members', v.members.length), T('role.' + v.role)];
        if (v.pending) info.push(T('vaults.rekeying'));
        else if (v.needsRekey) info.push(T('vaults.rekey_needed'));
        return h('button', { type: 'button', class: 'vp-vrow', on: { click: function () { setPane('vault', { id: v.id }); } } }, [
          avatar(vaultName(v.id)),
          h('span', { class: 'vp-row-tx' }, [h('span', { class: 'vp-row-t', text: vaultName(v.id) }), h('span', { class: 'vp-row-s', text: info.join(' · ') })]),
        ]);
      })),
      section(T('vaults.new'), h('div', { class: 'vp-inline' }, [name, create])),
      mySafety ? section(T('safety.mine'), [h('p', { class: 'vp-safety', text: mySafety }), h('p', { class: 'vp-hint', text: T('safety.mine_text') })]) : null,
    ]);
  }

  function paneVault(id) {
    var v = vaultOf(id);
    if (!v) return h('div', { class: 'vp-pane' }, [paneHead(T('vaults.title'), function () { setPane('vaults'); }), h('p', { class: 'vp-muted', text: T('err.not_found') })]);
    var manage = L.canManage(v);
    var myId = me();
    var kids = [paneHead(vaultName(id), function () { setPane('vaults'); })];
    if (v.pending) kids.push(notice('warn', T('vaults.rekeying_text')));
    else if (v.needsRekey) kids.push(notice('info', T('vaults.rekey_needed_text')));
    if (manage) {
      var name = h('input', { type: 'text', class: 'vp-input', value: vaultName(id), attrs: { maxlength: '200', 'aria-label': T('vaults.name') } });
      kids.push(section(T('vaults.rename'), h('div', { class: 'vp-inline' }, [name, btn(T('vaults.rename'), function () {
        act(Promise.resolve().then(function () { return renameVault(id, name.value); }).then(function () { setPane('vault', { id: id }); }), T('vaults.renamed'));
      })])));
    }
    if (v.kind === 'personal') {
      kids.push(h('p', { class: 'vp-muted', text: T('share.personal_hint') }));
      return h('div', { class: 'vp-pane' }, kids);
    }
    var members = h('div', { class: 'vp-members' }, v.members.map(function (m) {
      var self = m.userId === myId;
      return h('div', { class: 'vp-member' }, [
        avatar(m.name),
        h('span', { class: 'vp-row-tx' }, [h('span', { class: 'vp-row-t', text: self ? T('share.you', { name: m.name }) : m.name }), h('span', { class: 'vp-row-s', text: T('roleHint.' + m.role) })]),
        manage && !self ? roleSelect(m.role, function (role) {
          act(api('PUT', 'vaults/' + encodeURIComponent(id) + '/members/' + m.userId, { role: role }).then(function (raw) { applyVault(raw.vault); setPane('vault', { id: id }); }), T('share.role_set'));
        }) : h('span', { class: 'vp-tag', text: T('role.' + m.role) }),
        manage && !self ? ibtn('close', T('share.remove_person', { name: m.name }), function () {
          ask(T('share.remove_confirm', { person: m.name, name: vaultName(id) }) + ' ' + T('share.remove_info'), T('p.remove'), { danger: true }).then(function (yes) {
            if (!yes) return;
            act(api('DELETE', 'vaults/' + encodeURIComponent(id) + '/members/' + m.userId).then(function (raw) {
              if (raw.vault) applyVault(raw.vault); else dropVault(id);
              setPane(vaultOf(id) ? 'vault' : 'vaults', { id: id });
            }), T('share.removed'));
          });
        }) : null,
      ]);
    }));
    kids.push(section(T('share.members', { count: v.members.length }), members));
    if (manage) kids.push(section(T('share.add_person'), addPersonBox(v)));
    kids.push(h('p', { class: 'vp-hint', text: T('share.remove_info') }));
    kids.push(h('div', { class: 'vp-actions vp-actions-left' }, [
      btn(T('share.leave'), function () {
        ask(T('share.leave_confirm', { name: vaultName(id) }), T('share.leave'), { danger: true }).then(function (yes) {
          if (!yes) return;
          act(api('DELETE', 'vaults/' + encodeURIComponent(id) + '/members/' + myId).then(function () { dropVault(id); setPane('vaults'); }), T('share.left'));
        });
      }, { danger: true, small: true }),
      manage ? btn(T('share.delete_vault'), function () {
        ask(T('share.delete_confirm', { name: vaultName(id) }), T('share.delete_vault'), { danger: true }).then(function (yes) {
          if (!yes) return;
          act(api('DELETE', 'vaults/' + encodeURIComponent(id)).then(function () { dropVault(id); setPane('vaults'); }), T('share.deleted'));
        });
      }, { danger: true, small: true }) : null,
    ]));
    return h('div', { class: 'vp-pane' }, kids);
  }

  /** Person picker → their safety number to compare → role → add. Also used for emergency access (opts.emergency). */
  function personPicker(exclude, onPick) {
    var box = h('div', { class: 'vp-picker' }, [h('p', { class: 'vp-muted', text: T('p.loading') })]);
    var epoch = S.epoch;
    (S.people ? Promise.resolve(S.people) : loadPeople()).then(function (people) {
      if (epoch !== S.epoch) return;
      clear(box);
      var list = L.candidates(people, exclude.map(function (id) { return { userId: id }; }));
      if (!list.length) { box.appendChild(h('p', { class: 'vp-muted', text: T('share.no_people') })); return; }
      list.forEach(function (p) {
        box.appendChild(h('button', { type: 'button', class: 'vp-vrow', disabled: !p.publicKey, on: { click: function () { onPick(p); } } }, [
          avatar(p.name),
          h('span', { class: 'vp-row-tx' }, [h('span', { class: 'vp-row-t', text: p.name }), h('span', { class: 'vp-row-s', text: p.publicKey ? T('share.has_vault') : T('share.no_vault') })]),
        ]));
      });
    }, function (e) { clear(box); box.appendChild(h('p', { class: 'vp-err', text: errText(e) })); });
    return box;
  }

  function safetyBlock(p, onReady) {
    var check = h('input', { type: 'checkbox', on: { change: function () { onReady(check.checked); } } });
    return h('div', { class: 'vp-safety-box' }, [
      h('span', { class: 'vp-label', text: T('safety.of', { name: p.name }) }),
      h('p', { class: 'vp-safety', text: p.safety }),
      h('p', { class: 'vp-hint', text: T('safety.text', { name: p.name }) }),
      h('label', { class: 'vp-check' }, [check, h('span', { text: T('safety.compared', { name: p.name }) })]),
    ]);
  }

  function addPersonBox(v) {
    var holder = h('div');
    var showPicker = function () {
      clear(holder);
      holder.appendChild(h('p', { class: 'vp-hint', text: T('share.add_sub') }));
      holder.appendChild(personPicker(v.members.map(function (m) { return m.userId; }), function (p) {
        clear(holder);
        var role = 'write';
        var addBtn = btn(T('share.add'), function () {
          addBtn.disabled = true;
          act(addMember(v.id, p, role).then(function () { S.people = null; setPane('vault', { id: v.id }); }), T('share.added', { name: p.name })).then(function () { addBtn.disabled = false; });
        }, { primary: true, disabled: true });
        holder.appendChild(safetyBlock(p, function (ok) { addBtn.disabled = !ok; }));
        holder.appendChild(h('div', { class: 'vp-grid2' }, [inputRow(T('share.role'), roleSelect(role, function (r) { role = r; hint.textContent = T('roleHint.' + r); })), h('span')]));
        var hint = h('p', { class: 'vp-hint', text: T('roleHint.' + role) });
        holder.appendChild(hint);
        holder.appendChild(h('div', { class: 'vp-actions vp-actions-left' }, [btn(T('p.back'), showPicker, { small: true }), addBtn]));
      }));
    };
    showPicker();
    return holder;
  }

  // ── emergency access ─────────────────────────────────────

  function waitText(hours) { var w = L.waitParts(hours); return P(w.key, w.count); }
  function remainingText(at) { var r = L.remaining(at); return T('em.remaining', { hours: r.hours, minutes: r.minutes }); }

  function emergencyStep(id, step, okText) {
    return act(api('POST', 'emergency/' + id + '/' + step, {}).then(function () { if (S.pane.kind === 'emergency') renderDetail(); }), okText);
  }

  function paneEmergency() {
    var box = h('div', { class: 'vp-em' }, [h('p', { class: 'vp-muted', text: T('p.loading') })]);
    var epoch = S.epoch;
    api('GET', 'emergency').then(function (raw) {
      if (epoch !== S.epoch || S.pane.kind !== 'emergency') return;
      var r = L.parseEmergencyList(raw);
      if (!r) throw codeErr('invalid_answer');
      clear(box);
      // requests to me
      r.granted.filter(function (x) { return x.status === 'requested'; }).forEach(function (x) {
        box.appendChild(notice('warn', T('em.requested', { name: x.grantee.name }), [
          h('span', { class: 'vp-muted', text: ' ' + T('em.requested_text', { name: x.grantee.name, time: remainingText(x.releaseAt) }) }),
          h('div', { class: 'vp-actions vp-actions-left' }, [
            btn(T('em.deny'), function () { emergencyStep(x.id, 'deny', T('em.denied')); }, { small: true }),
            btn(T('em.approve'), function () {
              ask(T('em.approve_confirm', { name: x.grantee.name }), T('em.approve'), { danger: true }).then(function (yes) { if (yes) emergencyStep(x.id, 'approve', T('em.approved')); });
            }, { small: true, danger: true }),
          ]),
        ]));
      });
      // my trusted people
      var mine = h('div', { class: 'vp-members' }, r.granted.length ? r.granted.map(function (x) {
        return h('div', { class: 'vp-member' }, [
          avatar(x.grantee.name),
          h('span', { class: 'vp-row-tx' }, [h('span', { class: 'vp-row-t', text: x.grantee.name }), h('span', { class: 'vp-row-s', text: T('em.wait', { time: waitText(x.waitHours) }) + ' · ' + T('em.status.' + x.status) })]),
          x.status === 'granted' ? btn(T('em.take_back'), function () { emergencyStep(x.id, 'deny', T('em.taken_back')); }, { small: true }) : null,
          ibtn('close', T('em.remove'), function () {
            ask(T('em.remove_confirm', { name: x.grantee.name }), T('em.remove'), { danger: true }).then(function (yes) {
              if (yes) act(api('DELETE', 'emergency/' + x.id).then(function () { renderDetail(); }), T('em.removed'));
            });
          }),
        ]);
      }) : [h('p', { class: 'vp-muted', text: T('em.none') })]);
      box.appendChild(section(T('em.mine'), mine));
      box.appendChild(section(T('em.add'), emergencyAddBox(r.granted.map(function (x) { return x.grantee.id; }))));
      // I am trusted by
      var theirs = h('div', { class: 'vp-members' }, r.received.length ? r.received.map(function (x) {
        var status = x.status === 'requested' ? T('em.waiting_until', { time: remainingText(x.releaseAt), name: x.grantor.name }) : T('em.status.' + x.status);
        return h('div', { class: 'vp-member' }, [
          avatar(x.grantor.name),
          h('span', { class: 'vp-row-tx' }, [h('span', { class: 'vp-row-t', text: x.grantor.name }), h('span', { class: 'vp-row-s', text: T('em.wait', { time: waitText(x.waitHours) }) + ' · ' + status })]),
          x.status === 'ready' ? btn(T('em.request'), function () {
            ask(T('em.request_confirm', { name: x.grantor.name, time: waitText(x.waitHours) }), T('em.request')).then(function (yes) { if (yes) emergencyStep(x.id, 'request', T('em.requested_done')); });
          }, { small: true }) : null,
          x.status === 'granted' ? btn(T('em.open'), function () { openEmergency(x); }, { small: true, primary: true }) : null,
          ibtn('close', T('em.decline'), function () {
            ask(T('em.decline_confirm', { name: x.grantor.name }), T('em.decline'), { danger: true }).then(function (yes) {
              if (yes) act(api('DELETE', 'emergency/' + x.id).then(function () { renderDetail(); }), T('em.declined'));
            });
          }),
        ]);
      }) : [h('p', { class: 'vp-muted', text: T('em.none') })]);
      box.appendChild(section(T('em.for'), theirs));
      box.appendChild(h('p', { class: 'vp-hint', text: T('em.info') }));
    }).catch(function (e) {
      if (epoch !== S.epoch) return;
      clear(box);
      box.appendChild(h('p', { class: 'vp-err', text: errText(e) }));
    });
    return h('div', { class: 'vp-pane' }, [paneHead(T('p.emergency')), box]);
  }

  function emergencyAddBox(exclude) {
    var holder = h('div');
    var showPicker = function () {
      clear(holder);
      holder.appendChild(personPicker(exclude, function (p) {
        clear(holder);
        var hours = 48;
        var addBtn = btn(T('share.add'), function () {
          addBtn.disabled = true;
          var sealed;
          try { sealed = VC.sealForEmergency(S.keys, p.publicKey); } catch (e) { toast(T('err.invalid'), 'error'); return; }
          act(api('POST', 'emergency', { granteeId: p.id, waitHours: hours, sealedKey: sealed }).then(function () { renderDetail(); }), T('em.added', { name: p.name }))
            .then(function () { addBtn.disabled = false; });
        }, { primary: true, disabled: true });
        var waitSel = h('select', { class: 'vp-input', on: { change: function () { hours = Number(waitSel.value); } } },
          L.WAIT_CHOICES.map(function (x) { return h('option', { value: String(x), text: waitText(x), selected: x === hours }); }));
        holder.appendChild(h('b', { text: T('em.add_title', { name: p.name }) }));
        holder.appendChild(safetyBlock(p, function (ok) { addBtn.disabled = !ok; }));
        holder.appendChild(h('div', { class: 'vp-grid2' }, [inputRow(T('em.wait_label'), waitSel), h('span')]));
        holder.appendChild(h('div', { class: 'vp-actions vp-actions-left' }, [btn(T('p.back'), showPicker, { small: true }), addBtn]));
      }));
    };
    showPicker();
    return holder;
  }

  /** A released emergency access: the grantor's vaults and entries, read-only, decrypted in memory until lock. */
  function openEmergency(x) {
    var epoch = S.epoch;
    var mine = S.keys;
    toast(T('p.loading'));
    api('GET', 'emergency/' + x.id + '/access').then(function (raw) {
      var access = L.parseAccess(raw);
      if (!access) throw codeErr('invalid_answer');
      var grantor;
      try { grantor = VC.openEmergency(access, mine); } catch (e) { throw codeErr('decrypt'); }
      var keysByVault = new Map();
      access.vaults.forEach(function (v) {
        var m = new Map();
        try { m.set(v.keyRev, VC.openSealed(v.sealedKey, grantor.publicKey, grantor.secretKey)); } catch (e) { /* skip */ }
        if (v.pending && v.pending.sealedKey) { try { m.set(v.pending.keyRev, VC.openSealed(v.pending.sealedKey, grantor.publicKey, grantor.secretKey)); } catch (e) { /* skip */ } }
        keysByVault.set(v.id, m);
      });
      VC.wipe(grantor);
      var vaults = [];
      access.vaults.forEach(function (v) {
        var k = keysByVault.get(v.id).get(v.keyRev);
        if (!k) return;
        var name = null;
        try { name = VC.decryptName(k, v.id, v.nameEnc); } catch (e) { /* … */ }
        vaults.push({ id: v.id, kind: v.kind, name: name });
      });
      var entries = [];
      var since = 0;
      var limit = 200;
      function page(guard) {
        if (epoch !== S.epoch) throw codeErr('locked');
        if (guard > 500) throw codeErr('failed');
        return api('GET', 'emergency/' + x.id + '/items?since=' + since + '&limit=' + limit).then(function (r2) {
          var pg = L.parseItemsPage(r2);
          if (!pg) throw codeErr('invalid_answer');
          pg.items.forEach(function (it) {
            var k = keysByVault.has(it.vaultId) ? keysByVault.get(it.vaultId).get(it.keyRev) : null;
            if (!k || !it.blob) return;
            var data = null;
            try { data = L.normalizeEntry(VC.decryptItem(k, it)); } catch (e) { data = null; }
            if (data) entries.push({ id: it.id, vaultId: it.vaultId, rev: it.rev, trashed: it.state === 'trash', updatedAt: it.updatedAt, device: it.device, data: data });
          });
          if (!pg.more) return null;
          since = pg.next;
          return page(guard + 1);
        }, function (e) {
          if ((e.code === 'plugin_error' || e.code === 'failed') && limit > 5) { limit = Math.max(5, Math.floor(limit / 4)); return page(guard + 1); }
          throw e;
        });
      }
      return page(0).finally(function () { keysByVault.forEach(function (m) { VC.wipe(m); }); }).then(function () {
        if (epoch !== S.epoch) return;
        entries.sort(function (a, b) { return String(a.data.title).localeCompare(String(b.data.title), 'de', { sensitivity: 'base' }); });
        S.emergency = { id: x.id, grantor: { id: access.grantor.id, name: access.grantor.name }, vaults: vaults, entries: entries };
        S.filter = { vaultId: 'all', query: '' };
        $('vp-q').value = '';
        S.selected = null;
        setPane('none');
        renderList();
        toast(T('em.opened', { name: access.grantor.name }));
      });
    }).catch(function (e) { if (epoch === S.epoch) toast(errText(e), 'error'); });
  }

  function closeEmergencyView() {
    S.emergency = null;
    S.filter = { vaultId: 'all', query: '' };
    $('vp-q').value = '';
    S.selected = null;
    setPane('emergency');
    renderList();
  }

  // ── import / export ──────────────────────────────────────

  function paneTransfer() {
    var imp = h('div');
    var exp = h('div');
    drawImportStart(imp);
    drawExportStart(exp);
    return h('div', { class: 'vp-pane' }, [paneHead(T('p.import_export')), section(T('import.title'), imp), section(T('export.title'), exp)]);
  }

  function drawImportStart(box) {
    clear(box);
    var err = h('p', { class: 'vp-err', attrs: { role: 'alert' } });
    var writable = S.views.filter(function (x) { return L.canWrite(x.vault); });
    box.appendChild(h('p', { class: 'vp-muted', text: T('import.sources') }));
    box.appendChild(notice('info', T('import.info')));
    box.appendChild(h('div', { class: 'vp-actions vp-actions-left' }, [btn(T('import.pick'), function () {
      if (!writable.length) { err.textContent = T('err.read_only'); return; }
      var input = $('vp-file');
      input.value = '';
      input.onchange = function () {
        var file = input.files && input.files[0];
        input.onchange = null;
        if (!file) return;
        if (file.size > MAX_IMPORT_BYTES) { err.textContent = T('import.too_large'); return; }
        err.textContent = T('import.reading');
        var epoch = S.epoch;
        file.text().then(function (text) {
          input.value = '';
          if (epoch !== S.epoch) return;
          var r = L.parseImport(text);
          text = '';
          if (!r.ok) { err.textContent = T(r.code === 'encrypted' ? 'import.encrypted' : 'import.unknown'); return; }
          if (!r.entries.length) { err.textContent = T('import.nothing'); return; }
          drawImportPreview(box, r);
        }, function () { err.textContent = T('import.unknown'); });
      };
      input.click();
    }, { primary: true, icon: 'swap' })]));
    box.appendChild(err);
  }

  function drawImportPreview(box, r) {
    clear(box);
    var writable = S.views.filter(function (x) { return L.canWrite(x.vault); });
    var target = writable[0].vault.id;
    var skipDup = true;
    var counts = L.importCounts(r.entries);
    var flags;
    var info = h('div');
    var go = btn('', function () {}, { primary: true });
    function existingIn(vid) { return S.entries.filter(function (e) { return !e.trashed && e.vaultId === vid; }).map(function (e) { return e.data; }); }
    function update() {
      flags = L.duplicateFlags(r.entries, existingIn(target));
      var dups = flags.filter(Boolean).length;
      var n = skipDup ? r.entries.length - dups : r.entries.length;
      clear(info);
      var chips = [];
      if (counts.logins) chips.push(P('import.logins', counts.logins));
      if (counts.withTotp) chips.push(P('import.totp', counts.withTotp));
      if (counts.notes) chips.push(P('import.notes', counts.notes));
      if (counts.cards) chips.push(P('import.cards', counts.cards));
      info.appendChild(h('p', {}, [h('b', { text: P('import.found', counts.total) + ' · ' + r.source })]));
      info.appendChild(h('div', { class: 'vp-chips' }, chips.map(function (c) { return h('span', { class: 'vp-chip', text: c }); })));
      if (dups) info.appendChild(h('p', { class: 'vp-hint', text: P(skipDup ? 'import.dupes' : 'import.dupes_kept', dups) }));
      var list = h('div', { class: 'vp-preview' });
      r.entries.slice(0, 50).forEach(function (e, i) {
        var sub = L.entrySubtitle(e);
        list.appendChild(h('div', { class: 'vp-prow' + (flags[i] && skipDup ? ' is-dup' : '') }, [
          avatar(e.title),
          h('span', { class: 'vp-row-tx' }, [h('span', { class: 'vp-row-t', text: e.title || T('p.untitled') }), h('span', { class: 'vp-row-s', text: [T('type.' + e.type), sub].filter(Boolean).join(' · ') })]),
          flags[i] ? h('span', { class: 'vp-tag', text: T('import.duplicate') }) : null,
        ]));
      });
      if (r.entries.length > 50) list.appendChild(h('p', { class: 'vp-hint', text: T('import.more', { count: r.entries.length - 50 }) }));
      info.appendChild(list);
      go.lastChild.textContent = P('import.button', n);
      go.disabled = !n;
    }
    var vaultSel = h('select', { class: 'vp-input', on: { change: function () { target = vaultSel.value; update(); } } },
      writable.map(function (x) { return h('option', { value: x.vault.id, text: vaultName(x.vault.id) }); }));
    var dupBox = h('input', { type: 'checkbox', checked: true, on: { change: function () { skipDup = dupBox.checked; update(); } } });
    var status = h('p', { class: 'vp-muted' });
    var bar = progressBar();
    bar.hidden = true;
    clear(go);
    go.appendChild(document.createTextNode(''));
    go.addEventListener('click', function () {
      var list = r.entries.filter(function (e, i) { return !(skipDup && flags[i]); });
      if (!list.length) return;
      go.disabled = true;
      bar.hidden = false;
      status.textContent = T('import.saving');
      saveMany(target, list, function (done, total) { bar.set(done / Math.max(1, total)); }).then(function (res) {
        r.entries = [];
        toast(P('import.done', res.saved) + (res.failed ? ' ' + P('import.failed', res.failed) : ''), res.failed ? 'error' : null);
        S.filter.vaultId = target;
        drawImportStart(box);
        refresh();
      }, function (e) {
        go.disabled = false;
        bar.hidden = true;
        status.textContent = errText(e);
      });
    });
    box.appendChild(h('div', { class: 'vp-grid2' }, [inputRow(T('import.into'), vaultSel), h('span')]));
    box.appendChild(h('label', { class: 'vp-check' }, [dupBox, h('span', { text: T('import.skip_dupes') })]));
    box.appendChild(info);
    box.appendChild(notice('info', T('import.info')));
    box.appendChild(bar);
    box.appendChild(status);
    box.appendChild(h('div', { class: 'vp-actions' }, [btn(T('p.cancel'), function () { r.entries = []; drawImportStart(box); }), go]));
    update();
  }

  function drawExportStart(box) {
    clear(box);
    box.appendChild(notice('warn', T('export.warn_title'), h('span', { class: 'vp-muted', text: ' ' + T('export.warn_text') })));
    box.appendChild(h('div', { class: 'vp-actions vp-actions-left' }, [btn(T('export.start'), function () { drawExportConfirm(box); })]));
  }

  function drawExportConfirm(box) {
    clear(box);
    var scope = 'all';
    var sel = h('select', { class: 'vp-input', on: { change: function () { scope = sel.value; } } },
      [h('option', { value: 'all', text: T('export.all_vaults') })].concat(S.views.map(function (x) { return h('option', { value: x.vault.id, text: vaultName(x.vault.id) }); })));
    var pw = h('input', { type: 'password', class: 'vp-input', attrs: { autocomplete: 'current-password' } });
    var check = h('input', { type: 'checkbox', on: { change: function () { go.disabled = !check.checked; } } });
    var err = h('p', { class: 'vp-err', attrs: { role: 'alert' } });
    var bar = progressBar();
    bar.hidden = true;
    var go = btn(T('export.button'), function () {
      if (!check.checked || !pw.value) { err.textContent = T('export.need_pw'); return; }
      go.disabled = true;
      err.textContent = '';
      bar.hidden = false;
      var epoch = S.epoch;
      var value = pw.value;
      pw.value = '';
      var mine;
      // the master password once more: an unattended unlocked tab does not hand out everything in plain text
      Promise.resolve().then(function () {
        mine = userKeyCopy();
        return VC.unlock(S.account, value, { onProgress: bar.set });
      }).then(function (k) {
        var same = VC.equal(k.userKey, mine.userKey);
        VC.wipe(k, mine);
        value = '';
        if (epoch !== S.epoch || !S.keys) return null; // locked meanwhile: nothing is exported
        if (!same) throw codeErr('wrong_password');
        var list = S.entries.filter(function (e) { return !e.trashed && (scope === 'all' || e.vaultId === scope); })
          .map(function (e) { return { data: e.data, vaultName: vaultName(e.vaultId) }; });
        var csv = L.exportCsv(list);
        list = null;
        return saveFile(csv, 'text/csv', T('export.file_name', { date: today() })).then(function (ok) {
          csv = '';
          if (ok) toast(P('export.done', S.entries.filter(function (e) { return !e.trashed && (scope === 'all' || e.vaultId === scope); }).length));
          drawExportStart(box);
        });
      }).catch(function (e) {
        value = '';
        if (mine) VC.wipe(mine);
        if (epoch !== S.epoch) return;
        go.disabled = false;
        bar.hidden = true;
        err.textContent = e && e.code === 'decrypt' ? T('err.wrong_password') : errText(e);
      });
    }, { primary: true, disabled: true });
    box.appendChild(notice('warn', T('export.warn_title'), h('span', { class: 'vp-muted', text: ' ' + T('export.warn_text') })));
    box.appendChild(h('div', { class: 'vp-grid2' }, [inputRow(T('export.scope'), sel), inputRow(T('export.confirm_pw'), pw)]));
    box.appendChild(h('label', { class: 'vp-check' }, [check, h('span', { text: T('export.understood') })]));
    box.appendChild(bar);
    box.appendChild(err);
    box.appendChild(h('div', { class: 'vp-actions' }, [btn(T('p.cancel'), function () { drawExportStart(box); }), go]));
  }

  // ── master password ──────────────────────────────────────

  function panePassword() {
    var cur = h('input', { type: 'password', class: 'vp-input', attrs: { autocomplete: 'current-password', 'data-autofocus': true } });
    var err = h('p', { class: 'vp-err', attrs: { role: 'alert' } });
    var bar = progressBar();
    bar.hidden = true;
    var go;
    var m = masterFields([T('pw.new'), T('setup.pw_repeat')], function (ok) { go.disabled = !ok; });
    m.node.querySelector('[data-autofocus]').removeAttribute('data-autofocus');
    go = btn(T('p.save'), function () {
      if (!cur.value || !m.ok()) { err.textContent = T('err.invalid'); return; }
      go.disabled = true;
      err.textContent = '';
      bar.hidden = false;
      var current = cur.value;
      var next = m.value();
      var epoch = S.epoch;
      var account = S.account;
      var mine;
      // the user key is copied first: a lock while Argon2id runs zeroes S.keys, never what gets wrapped
      Promise.resolve().then(function () {
        mine = userKeyCopy();
        return VC.unlock(account, current, { onProgress: function (f) { bar.set(f / 2); } });
      }).then(function (k) {
        var same = VC.equal(k.userKey, mine.userKey);
        VC.wipe(k);
        current = '';
        if (epoch !== S.epoch || !S.keys) throw codeErr('locked');
        if (!same) throw codeErr('wrong_password');
        return VC.changePassword(account, mine, next, { onProgress: function (f) { bar.set(0.5 + f / 2); } });
      }).then(function (body) {
        return putAccount(body, epoch);
      }).finally(function () { if (mine) VC.wipe(mine); }).then(function () {
        next = '';
        if (epoch !== S.epoch) return;
        cur.value = '';
        m.clear();
        toast(T('pw.done'));
        setPane('none');
      }, function (e) {
        current = '';
        next = '';
        if (epoch !== S.epoch) return;
        go.disabled = false;
        bar.hidden = true;
        err.textContent = e && e.code === 'decrypt' ? T('err.wrong_password') : errText(e);
      });
    }, { primary: true, disabled: true });
    return h('div', { class: 'vp-pane' }, [
      paneHead(T('p.change_pw')),
      h('p', { class: 'vp-muted', text: T('pw.text') }),
      h('div', { class: 'vp-form' }, [inputRow(T('pw.current'), cur), m.node]),
      bar, err,
      h('div', { class: 'vp-actions' }, [btn(T('p.cancel'), function () { setPane('none'); }), go]),
    ]);
  }

  // ── wiring ───────────────────────────────────────────────

  function newMenu() {
    var back = $('vp-dialog');
    clear(back);
    var close = function () { back.hidden = true; back.onclick = null; clear(back); document.removeEventListener('keydown', onKey, true); };
    var onKey = function (e) { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    back.appendChild(h('div', { class: 'vp-dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': T('p.new') } }, [
      h('h3', { text: T('p.new_what') }),
      h('div', { class: 'vp-types' }, L.TYPES.map(function (t) {
        return h('button', { type: 'button', class: 'vp-type', on: { click: function () { close(); startNew(t); } } }, [avatar(T('type.' + t)), h('span', { text: T('type.' + t) })]);
      })),
      h('div', { class: 'vp-actions' }, [btn(T('p.cancel'), close)]),
    ]));
    back.hidden = false;
    back.onclick = function (e) { if (e.target === back) close(); };
    document.addEventListener('keydown', onKey, true);
    var first = back.querySelector('.vp-type');
    if (first) first.focus();
  }

  function boot() {
    S.phase = 'loading';
    render();
    loadAccount().then(function (a) {
      S.phase = a ? 'locked' : 'intro';
      render();
    }, function (e) {
      if (e.code === 'login_required') { S.phase = 'login'; render(); return; }
      S.failText = errText(e);
      S.phase = 'failed';
      render();
    });
  }

  function init() {
    var ic = $('vp-bar-ic');
    if (ic) ic.appendChild(icon('shield', 16));
    var si = $('vp-search-ic');
    if (si) si.appendChild(icon('search', 16));
    $('vp-lock-now').addEventListener('click', function () { lock('manual'); toast(T('p.locked_now')); });
    $('vp-q').addEventListener('input', function () { S.filter.query = $('vp-q').value; renderList(); });
    $('vp-new').addEventListener('click', newMenu);
    if (CTX.loggedIn === false) { S.phase = 'login'; render(); return; }
    boot();
  }

  init();
}());
