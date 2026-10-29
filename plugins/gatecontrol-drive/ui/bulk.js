/* Drive (gatecontrol-drive) — several files and folders at once in the portal tab (since 1.12.0): window.DriveBulk.
 *
 * Mockup "Drive am Desktop": a checkbox in front of every row (the head: all / some / none), a click on the row chooses
 * it (a click on its name opens it, as before; a double click too), Strg+Klick one more, Umschalt+Klick a range,
 * Strg+A all, Esc none; while something is chosen the green bar above the list (✕, "N ausgewählt · x Dateien, y Ordner",
 * Herunterladen (ZIP), Verschieben nach …, Kopieren nach …, Link teilen, Löschen), the right-click menu of the choice,
 * Strg+X / Strg+C and Strg+V in a folder, Entf, F2; dragging onto a folder (in the list or the menu's tree) moves — with
 * Strg held when dropping it copies ("N Elemente hierher verschieben"); the row of shortcuts below the list.
 * "Ziel wählen" (move | copy, the areas — read-only ones greyed "(nur ansehen)", the folders — a chosen folder greyed
 * "Wird verschoben – nicht in sich selbst", "Neuer Ordner hier", "Zuletzt benutzt"), "Gleiche Namen am Ziel" (one
 * question for all: a new version, keep both, skip; the same content is never stored twice), the jobs as cards above the
 * list (live event 'op': "58 von 128 Dateien · 1,4 von 3,1 GB", "Abbrechen") and the snackbar with "Rückgängig"; new
 * nodes at the target marked "neu hier" for a while. The photos: Strg / Umschalt with a click, "Alle" / "Keine" per month.
 *
 * Everything goes through the server's jobs (ops/…, feature bulk): GateControl has no copy of a media file, so the
 * bytes of a copy come through this tab — GC.mediaBytes (16 MiB at a time) and GC.upload (≤ 100 MB a file); larger files
 * are left for the Windows or Android app (the card says so). The selection lives in memory only (the frame has no
 * storage); "Zuletzt benutzt" lasts while the tab is open.
 *
 * portal.js calls DriveBulk.attach(ui) with its helpers and asks it: reset(), check(n), headCheck(items), bind(el, n),
 * dropTarget(el, folder), bar(main), cards(main), keys(main), navHint(), freshBadge(n), isCut(n), onEvent(data), load(),
 * photoPick(x, ev, list), photoMonth(items), photoActions(ids, done), count().
 */
(function () {
  'use strict';

  var GB_UPLOAD = 100 * 1024 * 1024;   // GC.upload: at most 100 MB a file
  var READ = 16 * 1024 * 1024;         // GC.mediaBytes: at most 16 MiB a call
  var FRESH_MS = 12000;
  var SNACK_MS = 9000;
  var ZIP_FILES = 20;
  var RECENT_MAX = 4;

  function attach(U) {
    var T = U.T;
    var P = U.P;
    var h = U.h;
    var S = U.S;
    var icon = U.icon;
    var btn = U.btn;
    var api = U.api;
    var $ = function (id) { return document.getElementById(id); };

    var st = {
      sel: {},            // node id → node (the choice of the list shown)
      anchor: null,       // the last one clicked (Umschalt+Klick)
      els: {},            // node id → { el, cb } of the list shown
      head: null,         // the tri-state checkbox of the list's head
      barEl: null,        // the green bar
      clip: null,         // Strg+X / Strg+C: { mode: 'cut'|'copy', nodes, from }
      ops: {},            // job id → the job (mine, from GET ops and the event 'op')
      mine: {},           // jobs started in this tab (their snackbar)
      fresh: {},          // node id → until (ms): "neu hier"
      recent: [],         // "Zuletzt benutzt": [{ id, areaId, label, vaultId }]
      drag: null,         // the nodes being dragged
      pumping: {},        // job id → true while this tab brings the bytes of a copy
      over: {},           // job id → true once its end was shown
      bigLeft: {},        // job id → files this tab cannot bring (too large)
      ctx: null,          // the right-click menu shown
    };
    var cardsEl = h('div', { class: 'dp-opcards', attrs: { 'aria-live': 'polite' } });

    // ── the choice ─────────────────────────────────────────

    function ids() { return Object.keys(st.sel).map(Number); }
    function nodes() { return ids().map(function (id) { return st.sel[id]; }); }
    function count() { return ids().length; }
    function visible() { return S.page === 'files' || S.page === 'search'; }

    function reset() {
      st.sel = {};
      st.anchor = null;
      st.els = {};
      st.head = null;
      closeCtx();
    }

    function setSel(n, on) {
      if (on) st.sel[n.id] = n; else delete st.sel[n.id];
      var r = st.els[n.id];
      if (r) {
        r.el.className = r.el.className.replace(/\s*is-sel\b/g, '') + (on ? ' is-sel' : '');
        r.el.setAttribute('aria-selected', String(!!on));
        if (r.cb) r.cb.checked = !!on;
      }
    }
    function only(n) {
      nodes().forEach(function (x) { if (x.id !== n.id) setSel(x, false); });
      setSel(n, true);
      st.anchor = n.id;
      changed();
    }
    function toggle(n) {
      setSel(n, !st.sel[n.id]);
      st.anchor = n.id;
      changed();
    }
    function range(n) {
      var list = S.items;
      var a = -1;
      var b = -1;
      for (var i = 0; i < list.length; i++) { if (list[i].id === st.anchor) a = i; if (list[i].id === n.id) b = i; }
      if (a < 0) { toggle(n); return; }
      var lo = Math.min(a, b);
      var hi = Math.max(a, b);
      for (var j = lo; j <= hi; j++) setSel(list[j], true);
      changed();
    }
    function all(on) {
      S.items.forEach(function (x) { setSel(x, on); });
      if (!on) st.anchor = null;
      changed();
    }

    /** The choice changed: the head's checkbox, the bar. */
    function changed() {
      if (st.head) {
        var n = count();
        var every = n > 0 && n >= S.items.length;
        st.head.checked = every;
        st.head.indeterminate = n > 0 && !every;
        st.head.setAttribute('aria-checked', every ? 'true' : n ? 'mixed' : 'false');
      }
      var m = $('dp-main');
      if (m) m.className = 'dp-main' + (count() ? ' has-sel' : '');
      drawBar();
    }

    /** The checkbox of a row or a tile. */
    function check(n) {
      var cb = h('input', { type: 'checkbox', class: 'dp-cb', checked: !!st.sel[n.id], attrs: { 'aria-label': T('p.b.choose', { name: U.nm(n) }) } });
      cb.addEventListener('click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (ev && ev.shiftKey && st.anchor != null) { range(n); return; }
        setSel(n, !st.sel[n.id]);
        st.anchor = n.id;
        changed();
      });
      return cb;
    }

    /** A click on a name: with Strg / Umschalt it chooses instead of opening. → true when it chose */
    function chooseClick(ev, n) {
      if (!ev || !(ev.ctrlKey || ev.metaKey || ev.shiftKey) || !visible()) return false;
      if (ev.preventDefault) ev.preventDefault();
      if (ev.shiftKey && st.anchor != null) range(n); else toggle(n);
      return true;
    }

    /** The head's checkbox: all, some (mixed) or none. */
    function headCheck(items) {
      var cb = h('input', { type: 'checkbox', class: 'dp-cb', attrs: { 'aria-label': T('p.b.choose_all') } });
      cb.addEventListener('click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        all(count() < items.length);
      });
      st.head = cb;
      setTimeout(changed, 0);
      return cb;
    }

    var inside = function (ev, cls) {
      var t = ev && ev.target;
      while (t && t !== ev.currentTarget && t.className !== undefined) {
        if (typeof t.className === 'string' && cls.some(function (c) { return (' ' + t.className + ' ').indexOf(' ' + c + ' ') >= 0; })) return true;
        t = t.parentNode;
      }
      return false;
    };

    /**
     * A row or a tile of the list: a click on it chooses (Strg one more, Umschalt a range), a double click opens, the right
     * mouse button shows the menu of the choice; it can be dragged — and a folder takes what is dropped on it.
     */
    function bind(el, n) {
      st.els[n.id] = { el: el, cb: el.querySelector('.dp-cb') };
      if (st.sel[n.id]) { st.sel[n.id] = n; setSel(n, true); }
      el.setAttribute('aria-selected', String(!!st.sel[n.id]));
      el.addEventListener('click', function (ev) {
        if (inside(ev, ['dp-open', 'dp-more', 'dp-cb'])) return;
        if (ev.shiftKey && st.anchor != null) range(n);
        else if (ev.ctrlKey || ev.metaKey) toggle(n);
        else only(n);
      });
      // (a double click on the name: its first click opened it already)
      el.addEventListener('dblclick', function (ev) { if (inside(ev, ['dp-open', 'dp-more', 'dp-cb'])) return; U.openNode(n); });
      el.addEventListener('contextmenu', function (ev) {
        if (!visible()) return;
        if (ev.preventDefault) ev.preventDefault();
        if (!st.sel[n.id]) only(n);
        showCtx(ev.clientX || 0, ev.clientY || 0);
      });
      if (S.page === 'files' || S.page === 'search') {
        el.setAttribute('draggable', 'true');
        el.addEventListener('dragstart', function (ev) {
          if (!st.sel[n.id]) only(n);
          st.drag = nodes();
          if (ev.dataTransfer) {
            try { ev.dataTransfer.setData('application/x-gcdrive-nodes', JSON.stringify(ids())); } catch (e) { /* older browsers */ }
            ev.dataTransfer.effectAllowed = 'copyMove';
          }
        });
        el.addEventListener('dragend', function () { st.drag = null; });
      }
      if (n.isDir) dropTarget(el, { id: n.id, areaId: n.areaId, label: U.nm(n), vaultId: n.encrypted ? n.vaultId : null });
    }

    // ── dragging onto a folder ─────────────────────────────

    /** May the dragged nodes go into `f` { id, areaId, vaultId }? */
    function dropOk(f, copy) {
      var list = st.drag;
      if (!list || !list.length) return false;
      var a = U.areaOf(f.areaId);
      if (!a || a.archived || (a.role !== 'write' && a.role !== 'manage')) return false;
      return list.every(function (x) {
        if (x.id === f.id) return false;
        if ((x.encrypted ? x.vaultId : null) !== (f.vaultId || null)) return false;
        if (!copy && x.parentId === f.id) return false;
        return copy || U.canWriteNode(x);
      });
    }

    function dropTarget(el, f) {
      var hint = null;
      var off = function () {
        el.className = el.className.replace(/\s*is-drop\b/g, '');
        if (hint && hint.parentNode) hint.parentNode.removeChild(hint);
        hint = null;
      };
      el.addEventListener('dragover', function (ev) {
        var copy = !!(ev.ctrlKey || ev.metaKey);
        if (!dropOk(f, copy)) return;
        if (ev.preventDefault) ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = copy ? 'copy' : 'move';
        if (!/\bis-drop\b/.test(el.className)) el.className += ' is-drop';
        var text = P(copy ? 'p.b.drop_copy' : 'p.b.drop_move', st.drag.length);
        if (!hint) { hint = h('span', { class: 'dp-drophint', attrs: { role: 'status' } }); el.appendChild(hint); }
        hint.textContent = text;
      });
      el.addEventListener('dragleave', off);
      el.addEventListener('drop', function (ev) {
        var copy = !!(ev.ctrlKey || ev.metaKey);
        var list = st.drag;
        off();
        if (!dropOk(f, copy)) return;
        if (ev.preventDefault) ev.preventDefault();
        if (ev.stopPropagation) ev.stopPropagation();
        st.drag = null;
        run(copy ? 'copy' : 'move', list, { id: f.id, areaId: f.areaId, label: f.label, vaultId: f.vaultId || null });
      });
    }

    // ── what the choice may do ─────────────────────────────

    function summary(list) {
      var files = list.filter(function (x) { return !x.isDir; }).length;
      var dirs = list.length - files;
      var parts = [];
      if (files) parts.push(P('p.b.files', files));
      if (dirs) parts.push(P('p.b.folders', dirs));
      return parts.join(', ');
    }

    /** { ok, why } of an action of the choice. */
    function can(what, list) {
      var vault = list.some(function (x) { return x.encrypted; });
      var writable = list.every(function (x) { return U.canWriteNode(x); });
      var no = function (k) { return { ok: false, why: T(k) }; };
      if (!list.length) return no('p.b.why_none');
      if (what === 'move' || what === 'trash') return writable ? { ok: true } : no('p.b.why_read');
      if (what === 'copy') {
        if (vault && new Set(list.map(function (x) { return x.vaultId || ''; })).size > 1) return no('p.b.why_vaults');
        return { ok: true };
      }
      if (what === 'zip') {
        if (!U.has('zip')) return no('p.b.why_links');
        if (vault) return no('p.b.why_vault');
        var dirs = list.filter(function (x) { return x.isDir; }).length;
        if (dirs && list.length > 1) return no('p.b.why_zip_mixed');
        if (!dirs && list.length > ZIP_FILES) return { ok: false, why: T('p.b.why_zip_many', { max: ZIP_FILES }) };
        if (!dirs && list.every(function (x) { return !x.mediaId; })) return no('p.b.why_empty');
        return { ok: true };
      }
      if (what === 'link') {
        if (vault) return no('p.b.why_vault');
        if (!writable) return no('p.b.why_read');
        if (list.length === 1) return list[0].isDir || list[0].mediaId ? { ok: true } : no('p.b.why_empty');
        if (!U.has('multiLink')) return no('p.b.why_links');
        if (list.some(function (x) { return x.isDir; })) return no('p.b.why_link_mixed');
        if (list.length > ZIP_FILES) return { ok: false, why: T('p.b.why_link_many', { max: ZIP_FILES }) };
        if (list.some(function (x) { return !x.mediaId; })) return no('p.b.why_empty');
        return { ok: true };
      }
      if (what === 'rename') return list.length === 1 && writable ? { ok: true } : no(list.length === 1 ? 'p.b.why_read' : 'p.b.why_one');
      return { ok: true };
    }

    function act(what) {
      var list = nodes();
      if (!can(what, list).ok) return;
      if (what === 'zip') zip(list);
      else if (what === 'move' || what === 'copy') pickTarget(what, list);
      else if (what === 'link') link(list);
      else if (what === 'trash') trash(list);
      else if (what === 'rename') { if (list[0].encrypted && U.V) U.V.rename(list[0]); else U.rename(list[0]); }
      else if (what === 'cut' || what === 'copyclip') clip(what === 'cut' ? 'cut' : 'copy', list);
    }

    // ── the green bar ──────────────────────────────────────

    function bar(main) {
      // what is no longer in the list is no longer chosen
      var here = {};
      S.items.forEach(function (x) { here[x.id] = true; });
      ids().forEach(function (id) { if (!here[id]) delete st.sel[id]; });
      if (st.anchor != null && !here[st.anchor]) st.anchor = null;
      st.barEl = h('div', { class: 'dp-selbar', attrs: { role: 'toolbar', 'aria-label': T('p.b.bar') } });
      main.appendChild(st.barEl);
      drawBar();
    }

    function barBtn(label, ic, what, o) {
      var c = can(what, nodes());
      var b = btn(label, function () { act(what); }, { icon: ic, small: true, danger: !!(o && o.danger), disabled: !c.ok, attrs: { title: c.ok ? null : c.why, 'data-act': what } });
      return b;
    }

    function drawBar() {
      var b = st.barEl;
      if (!b) return;
      while (b.firstChild) b.removeChild(b.firstChild);
      var list = nodes();
      b.hidden = !list.length;
      if (!list.length) return;
      U.add(b, [
        U.ibtn('close', T('p.b.clear'), function () { all(false); }, { cls: 'dp-selbar-x' }),
        h('span', { class: 'dp-selbar-n' }, [h('b', { text: P('p.b.chosen', list.length) }), h('span', { class: 'dp-meta', text: ' · ' + summary(list) })]),
        barBtn(T('p.b.zip'), 'download', 'zip'),
        barBtn(T('p.b.move_to'), 'move', 'move'),
        barBtn(T('p.b.copy_to'), 'copy', 'copy'),
        barBtn(T('p.b.link'), 'link', 'link'),
        barBtn(T('p.b.delete'), 'trash', 'trash', { danger: true }),
      ]);
    }

    /** The row of shortcuts below the list. */
    function keys(main) {
      var k = function (t) { return h('span', { class: 'dp-key', text: t }); };
      main.appendChild(h('div', { class: 'dp-keys', attrs: { 'aria-label': T('p.b.keys') } }, [
        h('span', null, [k(T('p.b.k_ctrl')), '+', k('A'), ' ', T('p.b.k_all')]),
        h('span', null, [k(T('p.b.k_shift')), T('p.b.k_range')]),
        h('span', null, [k(T('p.b.k_ctrl')), T('p.b.k_one')]),
        h('span', null, [k(T('p.b.k_ctrl')), '+', k('X'), ' / ', k('V'), ' ', T('p.b.k_move')]),
        h('span', null, [k(T('p.b.k_ctrl')), '+', k('C'), ' / ', k('V'), ' ', T('p.b.k_copy')]),
        h('span', null, [k(T('p.b.k_del')), ' ', T('p.b.k_trash')]),
        h('span', null, [k('Esc'), ' ', T('p.b.k_none')]),
      ]));
    }

    /** The hint at the bottom of the menu. */
    function navHint() {
      return h('p', { class: 'dp-hint dp-nav-drag' }, [T('p.b.nav_hint_1'), ' ', h('span', { class: 'dp-key', text: T('p.b.k_ctrl') }), ' ', T('p.b.nav_hint_2')]);
    }

    // ── the right-click menu ───────────────────────────────

    function closeCtx() {
      if (st.ctx && st.ctx.parentNode) st.ctx.parentNode.removeChild(st.ctx);
      st.ctx = null;
    }

    function showCtx(x, y) {
      closeCtx();
      var list = nodes();
      var items = [h('div', { class: 'dp-ctx-head', text: P('p.b.ctx_head', list.length) })];
      var mi = function (label, what, kbd, o) {
        var c = what ? can(what === 'cut' || what === 'copyclip' ? (what === 'cut' ? 'move' : 'copy') : what, list) : { ok: true };
        items.push(h('button', { type: 'button', class: 'dp-ctx-i' + (o && o.danger ? ' is-danger' : ''), disabled: !c.ok, attrs: { role: 'menuitem', title: c.ok ? null : c.why, 'data-act': what || null },
          on: { click: function () { closeCtx(); if (o && o.fn) o.fn(); else act(what); } } }, [h('span', { text: label }), kbd ? h('span', { class: 'dp-kbd', text: kbd }) : null]));
      };
      var sep = function () { items.push(h('div', { class: 'dp-ctx-sep', attrs: { role: 'separator' } })); };
      if (list.length === 1) mi(T('p.open'), null, null, { fn: function () { U.openNode(list[0]); } });
      mi(T('p.b.zip_ctx'), 'zip');
      mi(T('p.b.cut'), 'cut', T('p.b.k_ctrl') + '+X');
      mi(T('p.b.copy'), 'copyclip', T('p.b.k_ctrl') + '+C');
      if (st.clip && S.page === 'files') mi(T('p.b.paste'), null, T('p.b.k_ctrl') + '+V', { fn: paste });
      mi(T('p.b.move_to'), 'move');
      mi(T('p.b.copy_to'), 'copy');
      sep();
      mi(T('p.rename'), 'rename', 'F2');
      mi(T('p.b.link'), 'link');
      if (list.length === 1) mi(T('p.b.more_actions'), null, null, { fn: function () { U.actions(list[0]); } });
      sep();
      mi(T('p.b.to_trash'), 'trash', T('p.b.k_del'), { danger: true });
      var menu = h('div', { class: 'dp-ctx', attrs: { role: 'menu', 'aria-label': P('p.b.ctx_head', list.length), style: 'left:' + Math.max(8, x) + 'px;top:' + Math.max(8, y) + 'px' } }, items);
      $('dp-root').appendChild(menu);
      st.ctx = menu;
    }
    document.addEventListener('click', function (ev) { if (st.ctx && !(ev && ev.target && st.ctx.contains && st.ctx.contains(ev.target))) closeCtx(); });
    document.addEventListener('scroll', closeCtx, true);

    // ── the keyboard ───────────────────────────────────────

    function typing(el) {
      if (!el) return false;
      var n = String(el.localName || el.tagName || '').toLowerCase();
      return n === 'input' && el.type !== 'checkbox' || n === 'textarea' || n === 'select' || el.isContentEditable === true;
    }

    document.addEventListener('keydown', function (ev) {
      if (!ev || ev.dpHandled || !visible()) return;
      var dlg = $('dp-dialog');
      if (dlg && !dlg.hidden) return;
      if (typing(ev.target) || typing(document.activeElement)) return;
      var ctrl = !!(ev.ctrlKey || ev.metaKey);
      var key = String(ev.key || '');
      var stop = function () { if (ev.preventDefault) ev.preventDefault(); ev.dpHandled = true; };
      if (key === 'Escape') { if (st.ctx) { closeCtx(); stop(); return; } if (count()) { all(false); stop(); } return; }
      if (ctrl && (key === 'a' || key === 'A')) { if (S.items.length) { all(true); stop(); } return; }
      if (ctrl && (key === 'v' || key === 'V')) { if (st.clip && S.page === 'files') { stop(); paste(); } return; }
      if (!count()) return;
      if (ctrl && (key === 'x' || key === 'X')) { stop(); act('cut'); return; }
      if (ctrl && (key === 'c' || key === 'C')) { stop(); act('copyclip'); return; }
      if (key === 'Delete' || key === 'Del') { stop(); act('trash'); return; }
      if (key === 'F2') { stop(); act('rename'); }
    });

    // ── cut, copy, paste ───────────────────────────────────

    function clip(mode, list) {
      if (!can(mode === 'cut' ? 'move' : 'copy', list).ok) return;
      st.clip = { mode: mode, nodes: list.slice(), from: S.folder ? S.folder.id : null };
      U.toast(P(mode === 'cut' ? 'p.b.cut_done' : 'p.b.copy_done', list.length));
      Object.keys(st.els).forEach(function (id) {
        var r = st.els[id];
        r.el.className = r.el.className.replace(/\s*is-cut\b/g, '') + (mode === 'cut' && st.sel[id] ? ' is-cut' : '');
      });
    }
    function isCut(n) { return !!(st.clip && st.clip.mode === 'cut' && st.clip.nodes.some(function (x) { return x.id === n.id; })); }

    function paste() {
      var c = st.clip;
      if (!c || !S.folder || S.page !== 'files') return;
      var f = S.folder;
      var target = { id: f.id, areaId: f.areaId, label: f.parentId == null ? (U.areaOf(f.areaId) || {}).label : U.nm(f), vaultId: f.encrypted ? f.vaultId : null };
      var a = U.areaOf(f.areaId);
      if (!a || a.archived || (a.role !== 'write' && a.role !== 'manage')) { U.toast(T('p.b.why_target_read'), 'error'); return; }
      run(c.mode === 'cut' ? 'move' : 'copy', c.nodes, target, { after: function () { if (c.mode === 'cut') st.clip = null; } });
    }

    // ── ZIP, link, trash ───────────────────────────────────

    function zip(list) {
      api('POST', 'zip', { ids: list.map(function (x) { return x.id; }) }).then(function (r) {
        var a = h('a', { attrs: { href: r.url, download: r.name, rel: 'noopener' } });
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        U.toast(r.skipped && r.skipped.length ? T('p.b.zip_started_skip', { name: r.name, count: r.skipped.length }) : T('p.b.zip_started', { name: r.name }));
      }, U.fail);
    }

    function link(list) {
      if (list.length === 1) { U.share(list[0]); return; }
      var stl = { mode: 'download', expires: '7d', pin: false };
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var result = h('div');
      var seg = function (opts, key) {
        var box = h('div', { class: key === 'expires' ? 'dp-chips' : 'dp-seg', attrs: { role: 'group' } });
        var draw = function () {
          while (box.firstChild) box.removeChild(box.firstChild);
          opts.forEach(function (o) { box.appendChild(h('button', { type: 'button', text: o[1], attrs: { 'aria-pressed': String(stl[key] === o[0]) }, on: { click: function () { stl[key] = o[0]; draw(); } } })); });
        };
        draw();
        return box;
      };
      var a = new Uint32Array(1);
      window.crypto.getRandomValues(a);
      var pinInput = h('input', { class: 'dp-input dp-pin', type: 'text', value: String(1000 + (a[0] % 9000)), hidden: true, attrs: { inputmode: 'numeric', maxlength: '8', 'aria-label': T('p.pin') } });
      var pinBox = h('input', { type: 'checkbox', on: { change: function (ev) { stl.pin = !!ev.target.checked; pinInput.hidden = !stl.pin; } } });
      var create = function () {
        err.textContent = '';
        var pin = stl.pin ? String(pinInput.value || '').trim() : '';
        if (stl.pin && !/^\d{4,8}$/.test(pin)) { err.textContent = T('err.pin'); return; }
        api('POST', 'links', { nodeIds: list.map(function (x) { return x.id; }), mode: stl.mode, expires: stl.expires, pin: pin || undefined }).then(function (r) {
          U.showLink(result, r.link, pin);
        }, function (e) { err.textContent = linkErr(e); });
      };
      U.dialog(P('p.b.link_title', list.length), [
        h('p', { class: 'dp-dialog-sub', text: list.map(function (x) { return U.nm(x); }).join(', ') }),
        h('div', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.share_what') }), seg([['view', T('p.mode_view')], ['download', T('p.mode_download')]], 'mode')]),
        h('div', { class: 'dp-field' }, [h('span', { class: 'dp-label', text: T('p.share_valid') }), seg([['1d', T('p.days_1')], ['7d', T('p.days_7')], ['30d', T('p.days_30')], ['never', T('p.days_never')]], 'expires')]),
        h('div', { attrs: { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' } }, [h('label', { class: 'dp-check' }, [pinBox, h('span', { text: T('p.pin_ask') })]), pinInput]),
        err,
        h('div', { class: 'dp-actions' }, [btn(T('p.share_create'), create, { primary: true, icon: 'link' })]),
        result,
        h('p', { class: 'dp-hint', text: T('p.b.link_note') }),
      ]);
    }
    function linkErr(e) {
      var r = e && e.extra && e.extra.reason;
      if (r === 'mixed') return T('p.b.why_link_mixed');
      if (r === 'too_many') return T('p.b.why_link_many', { max: ZIP_FILES });
      if (r === 'empty') return T('p.b.why_empty');
      return U.errText(e);
    }

    function trash(list) {
      var days = (S.meSettings && S.meSettings.trashDays) || 30;
      U.confirmDialog(P('p.b.trash_title', list.length), T('p.b.trash_text', { days: days }), T('p.to_trash'), function () {
        return start('trash', list, null, 'version').then(function () { all(false); });
      }, true, [h('p', { class: 'dp-hint', text: list.slice(0, 6).map(function (x) { return U.nm(x); }).join(', ') + (list.length > 6 ? ' …' : '') })]);
    }

    // ── "Ziel wählen" ──────────────────────────────────────

    function pathLabel(areaId, node) {
      var a = U.areaOf(areaId);
      var names = [a ? a.label : ''];
      if (node) {
        (node.crumbs || []).slice(1).forEach(function (c) { names.push(node.encrypted && U.V ? (U.V.cached(c.id) || c.name) : c.name); });
        if (node.parentId != null) names.push(U.nm(node));
      }
      return names.join(' › ');
    }

    function pickTarget(mode, list) {
      var chosen = {};
      list.forEach(function (x) { chosen[x.id] = true; });
      var vault = list[0] && list[0].encrypted ? list[0].vaultId : null;
      var vaultRoot = null;
      if (vault && U.V) { var v = U.V.list().filter(function (x) { return x.id === vault; })[0]; vaultRoot = v ? { id: v.nodeId, areaId: v.areaId, name: v.name } : null; }
      var mayMove = can('move', list).ok;
      var cur = { mode: mayMove ? mode : 'copy', node: null, areaId: null, adding: false };
      var from = S.page === 'files' && S.folder ? S.folder : null;
      var segBox = h('div', { class: 'dp-seg', attrs: { role: 'group', 'aria-label': T('p.b.mode') } });
      var chips = h('div', { class: 'dp-chips dp-b-areas', attrs: { role: 'group', 'aria-label': T('p.area') } });
      var crumbs = h('nav', { class: 'dp-crumbs dp-b-path', attrs: { 'aria-label': T('p.path') } });
      var picker = h('div', { class: 'dp-picker', attrs: { role: 'list' } });
      var newRow = h('div', { class: 'dp-b-new' });
      var recentBox = h('div', { class: 'dp-b-recent' });
      var where = h('p', { class: 'dp-b-where' });
      var err = h('p', { class: 'dp-err', attrs: { role: 'alert' } });
      var go = h('button', { type: 'button', class: 'dp-btn dp-btn-primary dp-b-go', on: { click: function () { finish(); } } });
      var drawSeg = function () {
        while (segBox.firstChild) segBox.removeChild(segBox.firstChild);
        [['move', T('p.b.move')], ['copy', T('p.b.copy_mode')]].forEach(function (o) {
          segBox.appendChild(h('button', { type: 'button', text: o[1], disabled: o[0] === 'move' && !mayMove, attrs: { 'aria-pressed': String(cur.mode === o[0]), title: o[0] === 'move' && !mayMove ? T('p.b.why_read') : null },
            on: { click: function () { cur.mode = o[0]; drawSeg(); draw(); } } }));
        });
      };
      var writable = function (a) { return a && !a.archived && (a.role === 'write' || a.role === 'manage'); };
      var drawChips = function () {
        while (chips.firstChild) chips.removeChild(chips.firstChild);
        if (vault) return;
        S.areas.forEach(function (a) {
          var w = writable(a);
          chips.appendChild(h('button', { type: 'button', text: a.label + (w ? '' : ' ' + T('p.b.view_only')), disabled: !w,
            attrs: { 'aria-pressed': String(cur.areaId === a.id) }, on: { click: function () { open(a.id, a.rootId); } } }));
        });
      };
      var drawRecent = function () {
        while (recentBox.firstChild) recentBox.removeChild(recentBox.firstChild);
        var list2 = st.recent.filter(function (r) { return (r.vaultId || null) === (vault || null) && writable(U.areaOf(r.areaId)) && !chosen[r.id]; });
        if (!list2.length) return;
        recentBox.appendChild(h('span', { class: 'dp-label', text: T('p.b.recent') }));
        recentBox.appendChild(h('div', { class: 'dp-chips' }, list2.map(function (r) {
          return h('button', { type: 'button', text: r.label, on: { click: function () { open(r.areaId, r.id); } } });
        })));
      };
      var blockedHere = function () {
        if (!cur.node) return T('p.b.why_none');
        if (chosen[cur.node.id] || (cur.node.crumbs || []).some(function (c) { return chosen[c.id]; })) return T(cur.mode === 'move' ? 'p.b.into_itself_move' : 'p.b.into_itself_copy');
        if (cur.mode === 'move' && list.every(function (x) { return x.parentId === cur.node.id; })) return T('p.b.why_here');
        return null;
      };
      var draw = function () {
        var no = blockedHere();
        go.textContent = P(cur.mode === 'move' ? 'p.b.go_move' : 'p.b.go_copy', list.length);
        go.disabled = !!no;
        go.setAttribute('title', no || '');
        where.textContent = cur.node ? T('p.b.target_is', { path: pathLabel(cur.areaId, cur.node) }) : '';
        Array.prototype.forEach.call(picker.querySelectorAll('[data-chosen]'), function (b) {
          var s = b.querySelector('.dp-meta');
          if (s) s.textContent = T(cur.mode === 'move' ? 'p.b.into_itself_move' : 'p.b.into_itself_copy');
        });
      };
      var open = function (areaId, folderId) {
        err.textContent = '';
        Promise.all([api('GET', 'nodes/' + folderId), api('GET', 'nodes/' + folderId + '/children', null, { dirs: 1, limit: 1000 })]).then(function (r) {
          var node = r[0].node;
          var items = (r[1].items || []).filter(function (x) { return x.isDir && (vault ? x.encrypted : !x.encrypted); });
          return (node.encrypted && U.V ? U.V.prepare(node, items) : Promise.resolve()).then(function () { return [node, items]; });
        }).then(function (x) {
          var node = x[0];
          cur.node = node;
          cur.areaId = areaId;
          drawChips();
          while (crumbs.firstChild) crumbs.removeChild(crumbs.firstChild);
          var parts = (node.crumbs || []).concat([{ id: node.id, name: node.name }]);
          var top = vaultRoot ? parts.map(function (c) { return c.id; }).indexOf(vaultRoot.id) : 0;
          parts.slice(Math.max(0, top)).forEach(function (c, i, arr) {
            if (i) crumbs.appendChild(h('span', { class: 'dp-sep', text: '›', attrs: { 'aria-hidden': 'true' } }));
            var label = c.id === (U.areaOf(areaId) || {}).rootId ? (U.areaOf(areaId) || {}).label : (node.encrypted && U.V ? (U.V.cached(c.id) || (c.id === node.id ? U.nm(node) : c.name)) : c.name);
            var last = i === arr.length - 1;
            crumbs.appendChild(h('button', { type: 'button', text: label, attrs: { 'aria-current': last ? 'page' : null }, on: { click: last ? null : function () { open(areaId, c.id); } } }));
          });
          while (picker.firstChild) picker.removeChild(picker.firstChild);
          var mayUp = node.parentId != null && !(vaultRoot && node.id === vaultRoot.id);
          if (mayUp) picker.appendChild(h('button', { type: 'button', on: { click: function () { open(areaId, node.parentId); } } }, [icon('up'), h('span', { text: T('p.up') })]));
          x[1].forEach(function (f) {
            var no = !!chosen[f.id];
            picker.appendChild(h('button', { type: 'button', disabled: no, attrs: { role: 'listitem', 'data-chosen': no ? '1' : null }, on: { click: function () { if (!no) open(areaId, f.id); } } },
              [icon('folder'), h('span', { class: 'dp-menu-tx' }, [h('span', { text: U.nm(f) }), no ? h('span', { class: 'dp-meta' }) : null])]));
          });
          if (!x[1].length && !mayUp) picker.appendChild(h('p', { class: 'dp-hint', text: T('p.no_folders'), attrs: { style: 'padding:12px' } }));
          draw();
        }, function (e) { err.textContent = U.errText(e); });
      };
      var drawNew = function () {
        while (newRow.firstChild) newRow.removeChild(newRow.firstChild);
        if (!cur.adding) { newRow.appendChild(btn(T('p.b.new_here'), function () { cur.adding = true; drawNew(); }, { small: true, icon: 'folderPlus', disabled: !!vault })); return; }
        var input = h('input', { class: 'dp-input', type: 'text', value: T('p.new_folder_name'), attrs: { maxlength: '255', 'aria-label': T('p.name') } });
        var make = function () {
          var v = input.value.trim();
          if (!v || !cur.node) return;
          api('POST', 'nodes', { parentId: cur.node.id, name: v }).then(function (r) { cur.adding = false; drawNew(); U.refreshTree([cur.areaId]); open(cur.areaId, r.node.id); }, function (e) { err.textContent = U.errText(e); });
        };
        input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') make(); });
        U.add(newRow, [input, btn(T('p.create'), make, { small: true, primary: true }), btn(T('p.cancel'), function () { cur.adding = false; drawNew(); }, { small: true })]);
        if (input.focus) input.focus();
      };
      var finish = function () {
        if (blockedHere() || !cur.node) return;
        var label = cur.node.parentId == null ? (U.areaOf(cur.areaId) || {}).label : U.nm(cur.node);
        var t = { id: cur.node.id, areaId: cur.areaId, label: label, vaultId: vault || null, path: pathLabel(cur.areaId, cur.node) };
        remember(t);
        U.closeDialog();
        run(cur.mode, list, t);
      };
      var src = from ? (from.parentId == null ? (U.areaOf(from.areaId) || {}).label : U.nm(from)) : T('p.b.several_places');
      U.dialog(T('p.b.target_title'), [segBox, chips, crumbs, picker, newRow, recentBox, err,
        h('div', { class: 'dp-b-foot' }, [where, go])], { sub: P('p.b.target_sub', list.length, { folder: src }), wide: true });
      drawSeg();
      drawNew();
      drawRecent();
      if (vaultRoot) open(vaultRoot.areaId, from && from.encrypted ? from.id : vaultRoot.id);
      else if (from && writable(U.areaOf(from.areaId))) open(from.areaId, from.id);
      else { var w = S.areas.filter(writable)[0]; if (w) open(w.id, w.rootId); }
    }

    function remember(t) {
      st.recent = [t].concat(st.recent.filter(function (r) { return r.id !== t.id; })).slice(0, RECENT_MAX);
    }

    // ── the job: check, the same names, start ──────────────

    /** Move or copy `list` into `target` { id, areaId, label, vaultId }: look first, ask once, then the job. */
    function run(mode, list, target, o) {
      var body = { op: mode, ids: list.map(function (x) { return x.id; }), target: target.id };
      return api('POST', 'ops/check', body).then(function (r) {
        if (r.tooMany) { U.toast(T('p.b.too_many', { max: r.limit }), 'error'); return null; }
        if (r.quota && r.quota.free != null && r.quota.needed > r.quota.free) { U.toast(T('p.b.no_room', { needed: U.fmtSize(r.quota.needed), free: U.fmtSize(r.quota.free) }), 'error'); return null; }
        if (!r.items) { U.toast(blockedText(r.blocked), 'error'); return null; }
        var real = (r.conflicts || []).filter(function (c) { return !c.same; });
        var ask = real.length ? askSame(mode, r, target) : Promise.resolve('version');
        return ask.then(function (choice) {
          if (!choice) return null;
          return start(mode, list, target, choice, r.blocked).then(function (op) { if (o && o.after) o.after(op); return op; });
        });
      }).catch(U.fail);
    }

    function blockedText(list) {
      var b = (list || [])[0];
      return b ? T('p.b.blocked_' + b.reason) : T('err.generic', { code: 'blocked' });
    }

    /** "Gleiche Namen am Ziel": one question for all → 'version' | 'rename' | 'skip', or null (cancelled). */
    function askSame(mode, r, target) {
      return new Promise(function (resolve) {
        var list = r.conflicts || [];
        var real = list.filter(function (c) { return !c.same; });
        var same = list.filter(function (c) { return c.same; });
        var choice = 'version';
        var opts = h('div', { class: 'dp-b-opts', attrs: { role: 'radiogroup', 'aria-label': T('p.b.same_what') } });
        var drawOpts = function () {
          while (opts.firstChild) opts.removeChild(opts.firstChild);
          [['version', T('p.b.same_version'), T('p.b.same_version_hint')], ['rename', T('p.b.same_both'), T('p.b.same_both_hint')],
            ['skip', T('p.b.same_skip'), P('p.b.same_skip_hint', real.length)]].forEach(function (o) {
            opts.appendChild(h('button', { type: 'button', class: 'dp-b-opt', attrs: { role: 'radio', 'aria-checked': String(choice === o[0]) }, on: { click: function () { choice = o[0]; drawOpts(); } } },
              [h('span', { class: 'dp-b-radio', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'dp-menu-tx' }, [h('span', { text: o[1] }), h('span', { class: 'dp-meta', text: o[2] })])]));
          });
        };
        drawOpts();
        var rows = list.slice(0, 50).map(function (c) {
          var there = c.existing.isDir ? T('p.folder') : U.fmtSize(c.existing.size) + ', ' + day(c.existing.mtime);
          var mine = c.same ? T('p.b.same_content') : (c.isDir ? T('p.folder') : U.fmtSize(c.size) + ', ' + U.fmtDate(c.mtime));
          return h('li', { class: 'dp-b-conf' + (c.same ? ' is-same' : '') }, [h('span', { class: 'dp-name', text: c.path || c.name }),
            h('span', { class: 'dp-meta', text: T('p.b.same_line', { there: there, mine: mine }) })]);
        });
        if (r.conflictsMore) rows.push(h('li', { class: 'dp-meta', text: P('p.b.same_more', r.conflictsMore) }));
        var done = false;
        var end = function (v) { if (done) return; done = true; U.closeDialog(); resolve(v); };
        var box = U.dialog(T('p.b.same_title'), [
          h('p', { class: 'dp-b-big', text: P('p.b.same_count', real.length + same.length) }),
          h('p', { class: 'dp-hint', text: T('p.b.same_in', { folder: target.label || '' }) }),
          h('ul', { class: 'dp-b-confs' }, rows),
          h('span', { class: 'dp-label', text: T('p.b.same_what') }),
          opts,
          same.length ? h('div', { class: 'dp-note' }, [icon('info'), h('span', { text: same.length === 1 ? T('p.b.same_note_one', { name: same[0].name }) : T('p.b.same_note') })]) : null,
          r.blocked && r.blocked.length ? h('div', { class: 'dp-note is-warn' }, [icon('info'), h('span', { text: P('p.b.blocked_n', r.blocked.length) + ' ' + blockedText(r.blocked) })]) : null,
          h('div', { class: 'dp-actions' }, [btn(T('p.cancel'), function () { end(null); }), btn(T(mode === 'move' ? 'p.b.move' : 'p.b.copy_mode'), function () { end(choice); }, { primary: true })]),
        ], { wide: true });
        var x = box.querySelector('.dp-ib');
        if (x) x.addEventListener('click', function () { end(null); });
      });
    }
    function day(iso) {
      var d = iso ? new Date(iso) : null;
      return d && !isNaN(d.getTime()) ? d.toLocaleDateString(U.LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
    }

    /** POST ops → the job: its card while it runs, the snackbar when it ends. */
    function start(kind, list, target, onConflict, blocked) {
      var body = { op: kind, ids: list.map(function (x) { return x.id; }) };
      if (target) { body.target = target.id; body.onConflict = onConflict || 'version'; }
      return api('POST', 'ops', body).then(function (r) {
        var op = r.op;
        st.mine[op.id] = { label: target ? target.label : null, count: list.length, target: target };
        took(op);
        return op;
      });
    }

    /** A job's new state (the answer, GET ops, the event 'op'). */
    function took(op) {
      if (!op || !op.id) return;
      var was = st.ops[op.id];
      st.ops[op.id] = op;
      if (op.state === 'running') {
        drawCards();
        if (op.transfer === 'client' && op.transfersLeft > 0) pump(op.id);
        return;
      }
      delete st.ops[op.id];
      drawCards();
      if ((was && was.state !== 'running') || st.over[op.id]) return;
      st.over[op.id] = true;
      ended(op);
    }

    function ended(op) {
      var m = st.mine[op.id];
      delete st.mine[op.id];
      // new nodes at the target: "neu hier" for a while
      var until = Date.now() + FRESH_MS;
      (op.results && op.results.resultIds || []).forEach(function (id) { st.fresh[id] = until; });
      setTimeout(function () { U.reload(); }, 0);
      U.loadStorage();
      U.refreshTree(null);
      if (op.kind === 'undo') {
        var sk = op.results ? op.results.skipped + op.results.failedCount : 0;
        U.toast(sk ? P('p.b.undone_skipped', sk) : T('p.b.undone'));
        return;
      }
      if (!m) return;
      var n = op.items;
      var res = op.results || {};
      var key = op.kind === 'move' ? 'p.b.done_move' : op.kind === 'copy' ? 'p.b.done_copy' : op.kind === 'trash' ? 'p.b.done_trash' : op.kind === 'restore' ? 'p.b.done_restore' : 'p.b.done_purge';
      var text = P(key, n, { target: m.label || op.targetName || '' });
      if (op.state === 'cancelled') text = T('p.b.cancelled');
      if (op.state === 'failed') text = T('p.b.failed', { why: op.error ? (U.errText({ code: op.error })) : '' });
      var extra = [];
      if (res.skipped) extra.push(P('p.b.skipped_n', res.skipped));
      if (res.failedCount) extra.push(P('p.b.failed_n', res.failedCount));
      snack(text + (extra.length ? ' · ' + extra.join(' · ') : ''), op.undoUntil ? function () { undo(op); } : null, op.state === 'failed');
    }

    function undo(op) {
      api('POST', 'ops/' + encodeURIComponent(op.id) + '/undo').then(function (r) { took(r.op); }, U.fail);
    }

    // ── the snackbar ───────────────────────────────────────

    var snackTimer = null;
    function snack(text, onUndo, bad) {
      var el = $('dp-snack');
      if (!el) { U.toast(text, bad ? 'error' : null); return; }
      while (el.firstChild) el.removeChild(el.firstChild);
      el.className = 'dp-snack' + (bad ? ' is-error' : '');
      U.add(el, [h('span', { text: text }), onUndo ? h('button', { type: 'button', class: 'dp-snack-undo', text: T('p.b.undo'), on: { click: function () { el.hidden = true; onUndo(); } } }) : null]);
      el.hidden = false;
      if (snackTimer) clearTimeout(snackTimer);
      snackTimer = setTimeout(function () { el.hidden = true; }, SNACK_MS);
    }

    // ── the cards of running jobs ──────────────────────────

    function cards(main) {
      main.appendChild(cardsEl);
      drawCards();
    }

    function verb(op) {
      var name = op.items === 1 && op.label ? '„' + op.label + '“' : P('p.b.items', op.items);
      var to = op.targetName || (st.mine[op.id] && st.mine[op.id].label) || '';
      var k = { move: 'p.b.run_move', copy: 'p.b.run_copy', trash: 'p.b.run_trash', restore: 'p.b.run_restore', purge: 'p.b.run_purge', undo: 'p.b.run_undo' }[op.kind] || 'p.b.run_move';
      return T(k, { what: name, target: to });
    }

    function drawCards() {
      while (cardsEl.firstChild) cardsEl.removeChild(cardsEl.firstChild);
      var list = Object.keys(st.ops).map(function (k) { return st.ops[k]; }).filter(function (o) { return o.state === 'running'; });
      cardsEl.hidden = !list.length;
      list.forEach(function (op) {
        var pct = op.bytesTotal ? Math.round((op.bytesDone / op.bytesTotal) * 100) : op.total ? Math.round((op.done / op.total) * 100) : 0;
        var client = op.transfer === 'client' && op.transfersLeft > 0;
        var big = st.bigLeft[op.id] || 0;
        cardsEl.appendChild(h('section', { class: 'dp-opcard', attrs: { 'data-op': op.id } }, [
          h('div', { class: 'dp-opcard-top' }, [
            h('div', { class: 'dp-opcard-tx' }, [
              h('b', { text: verb(op) }),
              h('span', { class: 'dp-meta', text: T('p.b.progress', { done: op.done, total: op.total, bytesDone: U.fmtSize(op.bytesDone), bytesTotal: U.fmtSize(op.bytesTotal) }) }),
            ]),
            btn(T('p.cancel'), function () { cancel(op); }, { small: true }),
          ]),
          h('div', { class: 'dp-progress dp-opcard-bar', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) } }, h('span', { attrs: { style: 'width:' + pct + '%' } })),
          h('p', { class: 'dp-hint', text: client ? (big ? P('p.b.wait_app', big) : T('p.b.via_browser')) : T('p.b.on_server') }),
        ]));
      });
    }

    function cancel(op) {
      api('DELETE', 'ops/' + encodeURIComponent(op.id)).then(function (r) { took(r.op); }, U.fail);
    }

    // ── the bytes of a copy through this tab ───────────────

    function canPump() { return !!(window.GC && typeof window.GC.mediaBytes === 'function' && typeof window.GC.upload === 'function'); }

    function readAll(url, size) {
      var parts = [];
      var at = 0;
      var next = function () {
        if (at >= size) return Promise.resolve(parts);
        var end = Math.min(size, at + READ) - 1;
        return window.GC.mediaBytes(url, { start: at, end: end }).then(function (x) { parts.push(x.data); at = end + 1; return next(); });
      };
      return next();
    }

    function pump(id) {
      if (st.pumping[id] || !canPump()) {
        if (!canPump()) { st.bigLeft[id] = (st.ops[id] && st.ops[id].transfersLeft) || 0; drawCards(); }
        return;
      }
      st.pumping[id] = true;
      var loop = function () {
        var op = st.ops[id];
        if (!op || op.state !== 'running') return Promise.resolve();
        return api('POST', 'ops/' + encodeURIComponent(id) + '/transfers', { limit: 3, maxSize: GB_UPLOAD }).then(function (r) {
          st.bigLeft[id] = r.transfers.length ? 0 : r.left;
          if (!r.transfers.length) { drawCards(); return null; }
          return r.transfers.reduce(function (p, x) { return p.then(function () { return one(id, x); }); }, Promise.resolve()).then(loop);
        });
      };
      loop().then(function () { delete st.pumping[id]; }, function (e) { delete st.pumping[id]; U.fail(e); });
    }

    function one(id, x) {
      return readAll(x.url, x.size).then(function (parts) {
        var blob = new Blob(parts, { type: x.mime || 'application/octet-stream' });
        return window.GC.upload(blob, {});
      }).then(function (up) {
        return api('POST', 'ops/' + encodeURIComponent(id) + '/transfers/' + x.id, { mediaId: up.mediaId });
      }, function () {
        return api('POST', 'ops/' + encodeURIComponent(id) + '/transfers/' + x.id, { failed: true, reason: 'transfer' });
      }).then(function (r) { if (r && r.op) took(r.op); }, function (e) { if (e && e.code === 'quota') U.fail(e); });
    }

    // ── live, start ────────────────────────────────────────

    function onEvent(d) { if (d && d.op) took(d.op); }

    function load() {
      return api('GET', 'ops', null, { state: 'running' }).then(function (r) { (r.ops || []).forEach(took); }, function () { /* none */ });
    }

    function freshBadge(n) {
      var until = st.fresh[n.id];
      if (!until) return null;
      if (until < Date.now()) { delete st.fresh[n.id]; return null; }
      return h('span', { class: 'dp-fresh', text: T('p.b.fresh') });
    }

    // ── photos ─────────────────────────────────────────────

    /** A click on a photo with Strg / Umschalt: choosing (starts it). → true when it chose. */
    function photoPick(x, ev, list, ph) {
      if (!ev || !(ev.ctrlKey || ev.metaKey || ev.shiftKey)) return false;
      ph.select = true;
      if (ev.shiftKey && ph.anchor != null) {
        var a = -1;
        var b = -1;
        list.forEach(function (y, i) { if (y.id === ph.anchor) a = i; if (y.id === x.id) b = i; });
        if (a >= 0 && b >= 0) { for (var i = Math.min(a, b); i <= Math.max(a, b); i++) ph.chosen[list[i].id] = true; return true; }
      }
      ph.chosen[x.id] = !ph.chosen[x.id];
      ph.anchor = x.id;
      return true;
    }

    /** "Alle" / "Keine" of a month while choosing. */
    function photoMonth(items, ph, redraw) {
      var on = items.every(function (x) { return ph.chosen[x.id]; });
      return h('button', { type: 'button', class: 'dp-btn dp-btn-sm dp-ph-allm', text: on ? T('p.b.none') : T('p.b.all'), on: { click: function () {
        items.forEach(function (x) { ph.chosen[x.id] = !on; });
        redraw();
      } } });
    }

    /** The choice of photos: ZIP, move, delete (as nodes for the jobs). */
    function photoActions(list, done) {
      var c = function (what) { return can(what, list); };
      var b = function (label, ic, what, fn, o) {
        var x = c(what);
        return btn(label, fn, { small: true, icon: ic, disabled: !x.ok || !list.length, danger: !!(o && o.danger), attrs: { title: x.ok ? null : x.why } });
      };
      return [
        b(T('p.b.zip'), 'download', 'zip', function () { zip(list); }),
        b(T('p.b.move_to'), 'move', 'move', function () { pickTarget('move', list); }),
        b(T('p.b.delete'), 'trash', 'trash', function () { U.confirmDialog(P('p.b.trash_title', list.length), T('p.b.trash_text', { days: (S.meSettings && S.meSettings.trashDays) || 30 }), T('p.to_trash'), function () { return start('trash', list, null).then(done); }, true); }, { danger: true }),
      ];
    }

    return {
      reset: reset, check: check, headCheck: headCheck, bind: bind, chooseClick: chooseClick, dropTarget: dropTarget, bar: bar, cards: cards, keys: keys, navHint: navHint,
      freshBadge: freshBadge, isCut: isCut, onEvent: onEvent, load: load, photoPick: photoPick, photoMonth: photoMonth, photoActions: photoActions,
      count: count, selected: nodes, run: run, paste: paste,
    };
  }

  window.DriveBulk = { attach: attach };
}());
